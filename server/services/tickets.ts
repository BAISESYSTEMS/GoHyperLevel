import type { App } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, num, str } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now, uniq } from '../core/util.js';
import { contactName, contactVars, getContact, logActivity } from './contacts.js';
import { htmlToText } from './email-render.js';
import { getOrCreateConversation, sendToContact } from './messaging.js';
import {
  OPEN_KINDS,
  PRIORITIES,
  cleanSource,
  defaultStages,
  emailMatchesRule,
  findStage,
  isPriority,
  mapPriority,
  mapStage,
  nextRoundRobin,
  parseTicketTag,
  raisePriority,
  replySubject,
  validTz,
  withHelpdeskDefaults,
  type HelpdeskSettings,
  type Priority,
  type Stage,
} from './helpdesk.js';
import { shiftAfterPause, slaDeadlines, slaState, type WorkCalendar } from './helpdesk-sla.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Ticket data layer shared by the helpdesk modules (tickets, SLA, portal, CSAT, health score):
 * settings, pipelines, creating/changing tickets with timeline + workflow events, replies through
 * the normal messaging path, and threading inbound messages into tickets.
 */

export interface Actor {
  userId?: string | null;
  /** Who/what acted, for the timeline: user, api, workflow, portal, email, system. */
  via?: string;
}

// --- settings & state ----------------------------------------------------------------------

export function loadHelpdeskSettings(app: App, locationId: string): HelpdeskSettings {
  const row = app.db.get('SELECT data FROM helpdesk_settings WHERE location_id = ?', locationId);
  let data: any = null;
  try {
    data = row ? JSON.parse(row.data) : null;
  } catch {
    data = null;
  }
  return withHelpdeskDefaults(data);
}

export function saveHelpdeskSettings(app: App, locationId: string, s: HelpdeskSettings) {
  app.db.run(
    `INSERT INTO helpdesk_settings (location_id, data, state, updated_at) VALUES (?, ?, '{}', ?)
     ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    locationId,
    JSON.stringify(s),
    now(),
  );
}

/** Internal per-location state (webhook key, mail cursor) – never part of the settings form. */
export function helpdeskState(app: App, locationId: string): Record<string, any> {
  const row = app.db.get('SELECT state FROM helpdesk_settings WHERE location_id = ?', locationId);
  try {
    return row ? JSON.parse(row.state || '{}') : {};
  } catch {
    return {};
  }
}
export function setHelpdeskState(app: App, locationId: string, patch: Record<string, any>) {
  const next = JSON.stringify({ ...helpdeskState(app, locationId), ...patch });
  app.db.run(
    `INSERT INTO helpdesk_settings (location_id, data, state, updated_at) VALUES (?, '{}', ?, ?)
     ON CONFLICT(location_id) DO UPDATE SET state = excluded.state`,
    locationId,
    next,
    now(),
  );
}

export function workCalendar(app: App, locationId: string, s = loadHelpdeskSettings(app, locationId)): WorkCalendar {
  return { hours: s.business_hours, tz: validTz(app.location(locationId)?.timezone || 'Europe/Berlin'), holidays: s.holidays };
}

// --- people & pipelines -------------------------------------------------------------------

/** Logins that may work in this sub-account (admins and members with access). */
export function agentsOf(app: App, locationId: string): { id: string; name: string; email: string }[] {
  return app.db
    .all('SELECT id, name, email, role, locations FROM users ORDER BY name')
    .filter((u) => u.role === 'admin' || JSON.parse(u.locations || '[]').includes(locationId))
    .filter((u) => !hiddenUser(app, u, locationId))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));
}

export function ticketPipelines(app: App, locationId: string): { id: string; name: string; stages: Stage[]; position: number }[] {
  let rows = parseRows(app.db.all('SELECT * FROM ticket_pipelines WHERE location_id = ? ORDER BY position, created_at', locationId), ['stages']);
  if (!rows.length) {
    app.db.insert('ticket_pipelines', { id: id(), location_id: locationId, name: 'Support', stages: defaultStages(), position: 0, created_at: now(), updated_at: now() });
    rows = parseRows(app.db.all('SELECT * FROM ticket_pipelines WHERE location_id = ? ORDER BY position, created_at', locationId), ['stages']);
  }
  return rows as any;
}

export function pipelineOf(app: App, locationId: string, pipelineId?: string | null) {
  const all = ticketPipelines(app, locationId);
  if (!pipelineId) return all[0];
  const p = all.find((x) => x.id === pipelineId);
  if (!p) throw bad('Unbekannte Ticket-Pipeline');
  return p;
}

const firstOfKind = (stages: Stage[], ...kinds: string[]) => {
  for (const k of kinds) {
    const s = stages.find((x) => x.kind === k);
    if (s) return s;
  }
  return stages[0];
};

// --- reading -----------------------------------------------------------------------------------

export function getTicketRow(app: App, locationId: string, ticketId: string): any {
  return parseJson(app.db.get('SELECT * FROM tickets WHERE id = ? AND location_id = ?', ticketId, locationId), ['tags']);
}

/** Small summary for workflow events and webhooks. */
export function ticketBrief(app: App, t: any) {
  const p = ticketPipelines(app, t.location_id).find((x) => x.id === t.pipeline_id);
  const stage = p?.stages.find((s) => s.id === t.stage_id);
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: stage?.name ?? t.stage_id,
    status_kind: t.status_kind,
    stage_id: t.stage_id,
    pipeline_id: t.pipeline_id,
    priority: t.priority,
    category: t.category,
    source: t.source,
    owner_id: t.owner_id,
    team_id: t.team_id,
    url: `${app.baseUrl()}/app/tickets/${t.id}`,
  };
}

/** SLA timers of a ticket as states (ok/warning/breached/met/missed/paused). */
export function ticketSla(t: any, at = new Date()) {
  const first = slaState(t.first_response_due_at, t.first_response_warn_at, t.first_response_at, at);
  const done = t.resolved_at ?? t.closed_at;
  let resolution = slaState(t.resolution_due_at, t.resolution_warn_at, done, at);
  // Waiting for the customer: the clock stands still (unless it had run out before).
  if (t.sla_paused_at && !done && t.resolution_due_at && Date.parse(t.resolution_due_at) > Date.parse(t.sla_paused_at)) resolution = 'paused' as any;
  // A ticket that needs no first answer any more (solved without reply) doesn't count as breached.
  const firstOut = first === 'breached' || first === 'warning' ? (done ? 'missed' : first) : first;
  return { first: firstOut, resolution };
}

export function ticketOut(app: App, t: any) {
  if (!t) return t;
  const p = ticketPipelines(app, t.location_id).find((x) => x.id === t.pipeline_id);
  const stage = p?.stages.find((s) => s.id === t.stage_id);
  return { ...t, tags: Array.isArray(t.tags) ? t.tags : JSON.parse(t.tags || '[]'), status: stage?.name ?? t.stage_id, stage: stage ?? null, pipeline_name: p?.name ?? '', sla: ticketSla(t) };
}

const OPEN_SQL = `t.status_kind IN ('new','open','waiting') AND t.merged_into IS NULL`;
/** SQL (on alias t) for a breached / about-to-breach running SLA timer. */
export const SLA_BREACHED_SQL = `((t.first_response_at IS NULL AND t.first_response_due_at <= @now) OR (t.resolution_due_at <= @now AND (t.sla_paused_at IS NULL OR t.resolution_due_at <= t.sla_paused_at)))`;
export const SLA_WARNING_SQL = `((t.first_response_at IS NULL AND t.first_response_warn_at <= @now) OR (t.resolution_warn_at <= @now AND t.sla_paused_at IS NULL))`;
const withNow = (sql: string, params: any[], at: string) => {
  const parts = sql.split('@now');
  for (let i = 1; i < parts.length; i++) params.push(at);
  return parts.join('?');
};

/** Ticket list with the filters of the list view, API and MCP. */
export function listTickets(app: App, locationId: string, f: Record<string, any>, userId?: string) {
  const where = ['t.location_id = ?'];
  const params: any[] = [locationId];
  const at = now();
  const get = (k: string) => String(f[k] ?? '').trim();
  const state = get('state') || (get('stage_id') ? 'all' : 'open');
  if (state === 'open') where.push(OPEN_SQL);
  else if (state === 'resolved') where.push(`t.status_kind = 'resolved'`);
  else if (state === 'closed') where.push(`t.status_kind = 'closed'`);
  else if (state === 'done') where.push(`t.status_kind IN ('resolved','closed')`);
  if (state !== 'all' && state !== 'open') where.push('t.merged_into IS NULL');
  const inList = (col: string, v: string) => {
    const vals = v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
    if (!vals.length) return;
    where.push(`${col} IN (${vals.map(() => '?').join(',')})`);
    params.push(...vals);
  };
  if (get('pipeline_id')) (where.push('t.pipeline_id = ?'), params.push(get('pipeline_id')));
  if (get('stage_id')) inList('t.stage_id', get('stage_id'));
  if (get('priority')) inList('t.priority', get('priority'));
  if (get('category')) (where.push('t.category = ?'), params.push(get('category')));
  if (get('source')) (where.push('t.source = ?'), params.push(get('source')));
  if (get('contact_id')) (where.push('t.contact_id = ?'), params.push(get('contact_id')));
  const owner = get('owner') || get('owner_id');
  if (owner === 'me' && userId) (where.push('t.owner_id = ?'), params.push(userId));
  else if (owner === 'none') where.push('t.owner_id IS NULL');
  else if (owner && owner !== 'me') (where.push('t.owner_id = ?'), params.push(owner));
  const team = get('team_id');
  if (team === 'none') where.push('t.team_id IS NULL');
  else if (team) (where.push('t.team_id = ?'), params.push(team));
  if (get('tag')) (where.push('EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)'), params.push(get('tag')));
  const sla = get('sla');
  if (sla === 'breached') where.push(`${OPEN_SQL} AND ${withNow(SLA_BREACHED_SQL, params, at)}`);
  else if (sla === 'warning') where.push(`${OPEN_SQL} AND NOT ${withNow(SLA_BREACHED_SQL, params, at)} AND ${withNow(SLA_WARNING_SQL, params, at)}`);
  else if (sla === 'at_risk') where.push(`${OPEN_SQL} AND (${withNow(SLA_BREACHED_SQL, params, at)} OR ${withNow(SLA_WARNING_SQL, params, at)})`);
  const q = get('q');
  if (q) {
    const n = Number(q.replace(/^#/, ''));
    where.push(`(t.subject LIKE ? OR t.description LIKE ? OR (c.first_name || ' ' || c.last_name || ' ' || c.email || ' ' || c.company) LIKE ?${Number.isInteger(n) && n > 0 ? ' OR t.number = ?' : ''})`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, ...(Number.isInteger(n) && n > 0 ? [n] : []));
  }
  const sort = get('sort');
  const order =
    sort === 'created' ? 't.created_at DESC'
    : sort === 'priority' ? `CASE t.priority WHEN 'dringend' THEN 0 WHEN 'hoch' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.updated_at DESC`
    : sort === 'due' ? `COALESCE(CASE WHEN t.first_response_at IS NULL THEN t.first_response_due_at END, t.resolution_due_at, '9999') ASC`
    : sort === 'number' ? 't.number DESC'
    : 't.updated_at DESC';
  const limit = Math.min(Math.max(1, num(f.limit, 200)), 1000);
  const offset = Math.max(0, num(f.offset, 0));
  const from = `FROM tickets t LEFT JOIN contacts c ON c.id = t.contact_id WHERE ${where.join(' AND ')}`;
  const total = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...params)!.n;
  const rows = app.db.all(
    `SELECT t.*, c.first_name, c.last_name, c.email AS contact_email, c.phone AS contact_phone, c.company AS contact_company,
       (SELECT name FROM users u WHERE u.id = t.owner_id) AS owner_name,
       (SELECT name FROM helpdesk_teams h WHERE h.id = t.team_id) AS team_name
     ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { total, tickets: rows.map((r) => ({ ...ticketOut(app, parseJson(r, ['tags'])), contact_name: r.contact_id ? contactName(r as any) : '' })) };
}

// --- timeline ------------------------------------------------------------------------------------

export function addTicketEvent(app: App, t: { id?: string; location_id?: string; [k: string]: any }, type: string, o: { body?: string; userId?: string | null; messageId?: string | null; data?: Record<string, any>; at?: string } = {}) {
  const row = { id: id(), location_id: t.location_id, ticket_id: t.id, type, body: String(o.body ?? '').slice(0, 100_000), user_id: o.userId ?? null, message_id: o.messageId ?? null, data: o.data ?? {}, created_at: o.at ?? now() };
  app.db.insert('ticket_events', row);
  return row;
}

export function ticketTimeline(app: App, ticketId: string) {
  return parseRows(
    app.db.all(
      `SELECT e.*, u.name AS user_name, m.channel, m.status AS message_status, m.error AS message_error, m.subject AS message_subject
       FROM ticket_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN messages m ON m.id = e.message_id
       WHERE e.ticket_id = ? ORDER BY e.created_at, e.rowid`,
      ticketId,
    ),
    ['data'],
  );
}

// --- assignment --------------------------------------------------------------------------------

/** Next member of a round-robin team (remembers who was last). */
export function roundRobinOwner(app: App, locationId: string, teamId: string): string | null {
  const team = app.db.get('SELECT * FROM helpdesk_teams WHERE id = ? AND location_id = ?', teamId, locationId);
  if (!team || !team.round_robin) return null;
  const allowed = new Set(agentsOf(app, locationId).map((a) => a.id));
  const members = (JSON.parse(team.members || '[]') as string[]).filter((m) => allowed.has(m));
  const next = nextRoundRobin(members, team.last_user_id);
  if (next) app.db.run('UPDATE helpdesk_teams SET last_user_id = ? WHERE id = ?', next, team.id);
  return next;
}

/** Owner and team for a new ticket: given owner, else category rule, else round robin in the team. */
export function autoAssign(app: App, locationId: string, s: HelpdeskSettings, input: { category: string; team_id: string | null; owner_id: string | null }) {
  if (input.owner_id) return { owner_id: input.owner_id, team_id: input.team_id };
  const mode = s.assignment.mode;
  if (mode === 'manual') return { owner_id: null, team_id: input.team_id };
  let team = input.team_id || '';
  let owner: string | null = null;
  if (mode === 'category' && input.category) {
    const rule = s.assignment.rules.find((r) => r.category.toLowerCase() === input.category.toLowerCase());
    if (rule) {
      team = team || rule.team_id;
      owner = rule.user_id || null;
    }
  }
  team = team || s.assignment.default_team_id;
  if (team && !app.db.get('SELECT id FROM helpdesk_teams WHERE id = ? AND location_id = ?', team, locationId)) team = '';
  if (!owner && team) owner = roundRobinOwner(app, locationId, team);
  return { owner_id: owner, team_id: team || null };
}

function checkOwner(app: App, locationId: string, v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!agentsOf(app, locationId).some((a) => a.id === s)) throw bad('Mitarbeiter hat keinen Zugriff auf diesen Sub-Account');
  return s;
}
function checkTeam(app: App, locationId: string, v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!app.db.get('SELECT id FROM helpdesk_teams WHERE id = ? AND location_id = ?', s, locationId)) throw bad('Unbekanntes Team');
  return s;
}
function cleanTags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return uniq(arr.map((x) => String(x ?? '').trim().slice(0, 40)).filter(Boolean)).slice(0, 30);
}
function cleanDue(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw bad('Fälligkeitsdatum ungültig');
  return new Date(t).toISOString();
}

function notifyOwner(app: App, locationId: string, ownerId: string, t: any, title: string) {
  void Promise.resolve(app.services.pushNotify?.({ userIds: [ownerId], kind: 'tasks', title, body: `#${t.number} ${t.subject}`, url: `/app/tickets/${t.id}`, tag: `ticket-${t.id}` })).catch(() => {});
}

// --- create & update --------------------------------------------------------------------------

export interface TicketInput {
  subject?: unknown;
  description?: unknown;
  contact_id?: unknown;
  company_id?: unknown;
  priority?: unknown;
  category?: unknown;
  tags?: unknown;
  owner_id?: unknown;
  team_id?: unknown;
  pipeline_id?: unknown;
  stage_id?: unknown;
  status?: unknown;
  source?: unknown;
  channel?: unknown;
  due_at?: unknown;
  conversation_id?: unknown;
  call_id?: unknown;
  form_submission_id?: unknown;
}

const CHANNEL_OF_SOURCE: Record<string, string> = { 'E-Mail': 'email', SMS: 'sms', Chat: 'chat', WhatsApp: 'whatsapp', Telefon: 'sms' };

export function createTicket(app: App, locationId: string, input: TicketInput, actor: Actor = {}, opts: { messageId?: string; messageAt?: string } = {}) {
  const { db } = app;
  const s = loadHelpdeskSettings(app, locationId);
  const description = str(input.description, 'Beschreibung', { max: 50_000 });
  let subject = str(input.subject, 'Betreff', { max: 300 });
  if (!subject) subject = description.split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '';
  if (!subject) throw bad('Betreff fehlt');
  const contactId = str(input.contact_id, 'Kontakt', { max: 40 }) || null;
  const contact = contactId ? getContact(app, locationId, contactId) : undefined;
  if (contactId && !contact) throw notFound('Kontakt nicht gefunden');
  const pipe = pipelineOf(app, locationId, str(input.pipeline_id, 'Pipeline', { max: 40 }) || null);
  const stage = findStage(pipe.stages, input.stage_id ?? input.status) ?? firstOfKind(pipe.stages, 'new', 'open');
  const priority: Priority = input.priority === undefined || input.priority === '' ? 'normal' : isPriority(input.priority) ? input.priority : (() => { throw bad('Unbekannte Priorität'); })();
  const category = str(input.category, 'Kategorie', { max: 60 });
  const source = cleanSource(input.source);
  const assigned = autoAssign(app, locationId, s, { category, team_id: checkTeam(app, locationId, input.team_id), owner_id: checkOwner(app, locationId, input.owner_id) });
  let conversationId = str(input.conversation_id, 'Konversation', { max: 40 }) || null;
  if (conversationId) {
    const conv = db.get('SELECT contact_id FROM conversations WHERE id = ? AND location_id = ?', conversationId, locationId);
    if (!conv) throw notFound('Konversation nicht gefunden');
    if (contactId && conv.contact_id !== contactId) throw bad('Konversation gehört zu einem anderen Kontakt');
  } else if (contact) conversationId = db.get('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', locationId, contact.id)?.id ?? null;
  const channelIn = str(input.channel, 'Kanal', { max: 20 });
  const channel = channelIn || CHANNEL_OF_SOURCE[source] || (contact?.email ? 'email' : contact?.phone ? 'sms' : '');
  const created = now();
  const number = db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE location_id = ?', locationId)!.n;
  const sla = s.sla.enabled ? slaDeadlines(new Date(created), s.sla.policies[priority], workCalendar(app, locationId, s), s.sla.warn_percent) : {};
  const row: Record<string, any> = {
    id: id(),
    location_id: locationId,
    number,
    subject,
    description,
    pipeline_id: pipe.id,
    stage_id: stage.id,
    status_kind: stage.kind,
    priority,
    category,
    tags: cleanTags(input.tags),
    owner_id: assigned.owner_id,
    team_id: assigned.team_id,
    contact_id: contact?.id ?? null,
    company_id: str(input.company_id, 'Firma', { max: 40 }) || null,
    conversation_id: conversationId,
    source,
    channel,
    due_at: cleanDue(input.due_at),
    call_id: str(input.call_id, 'Anruf', { max: 40 }) || null,
    form_submission_id: str(input.form_submission_id, 'Formular', { max: 40 }) || null,
    ...sla,
    resolved_at: stage.kind === 'resolved' || stage.kind === 'closed' ? created : null,
    closed_at: stage.kind === 'closed' ? created : null,
    sla_paused_at: stage.pause_sla ? created : null,
    created_by: actor.userId ?? null,
    last_customer_at: opts.messageId ? created : null,
    created_at: created,
    updated_at: created,
  };
  db.insert('tickets', row);
  addTicketEvent(app, row as any, 'created', { body: description, userId: actor.userId ?? null, data: { source, via: actor.via ?? 'user', stage: stage.name, priority } });
  if (opts.messageId) addTicketEvent(app, row as any, 'customer_reply', { messageId: opts.messageId, body: description, data: { origin: true } });
  if (contact) logActivity(app, locationId, contact.id, 'ticket.created', `Ticket #${number} „${subject}“ angelegt`, { ticketId: row.id });
  const t = getTicketRow(app, locationId, row.id);
  const brief = ticketBrief(app, t);
  app.events.emit(locationId, 'ticket.created', { contactId: t.contact_id, ticketId: t.id, ticket: brief });
  if (t.owner_id || t.team_id) {
    addTicketEvent(app, t, 'assigned', { data: { owner_id: t.owner_id, team_id: t.team_id, auto: !input.owner_id } });
    app.events.emit(locationId, 'ticket.assigned', { contactId: t.contact_id, ticketId: t.id, ticket: brief, ownerId: t.owner_id, teamId: t.team_id, previousOwnerId: null });
    if (t.owner_id && t.owner_id !== actor.userId) notifyOwner(app, locationId, t.owner_id, t, 'Neues Ticket für dich');
  }
  return t;
}

export interface TicketPatch extends TicketInput {
  note?: unknown;
}

/** Changes a ticket; status, priority and assignment changes land on the timeline and fire workflow events. */
export function updateTicket(app: App, locationId: string, ticketId: string, patch: TicketPatch, actor: Actor = {}) {
  const { db } = app;
  const t = getTicketRow(app, locationId, ticketId);
  if (!t) throw notFound('Ticket nicht gefunden');
  const s = loadHelpdeskSettings(app, locationId);
  const cal = workCalendar(app, locationId, s);
  const upd: Record<string, any> = {};
  const events: [string, string, Record<string, any>][] = [];
  const emits: [string, Record<string, any>][] = [];
  const at = now();

  if (patch.subject !== undefined) upd.subject = str(patch.subject, 'Betreff', { required: true, max: 300 });
  if (patch.description !== undefined) upd.description = str(patch.description, 'Beschreibung', { max: 50_000 });
  if (patch.category !== undefined) {
    const c = str(patch.category, 'Kategorie', { max: 60 });
    if (c !== t.category) (upd.category = c), events.push(['field', `Kategorie: ${c || '–'}`, { field: 'category', from: t.category, to: c }]);
  }
  if (patch.tags !== undefined) upd.tags = cleanTags(patch.tags);
  if (patch.due_at !== undefined) upd.due_at = cleanDue(patch.due_at);
  if (patch.company_id !== undefined) upd.company_id = str(patch.company_id, 'Firma', { max: 40 }) || null;
  if (patch.source !== undefined) upd.source = cleanSource(patch.source);
  if (patch.channel !== undefined) upd.channel = str(patch.channel, 'Kanal', { max: 20 });
  if (patch.contact_id !== undefined) {
    const cid = str(patch.contact_id, 'Kontakt', { max: 40 }) || null;
    if (cid && !getContact(app, locationId, cid)) throw notFound('Kontakt nicht gefunden');
    upd.contact_id = cid;
  }

  // Pipeline and stage.
  let pipe = pipelineOf(app, locationId, t.pipeline_id);
  const pipelineChanged = patch.pipeline_id !== undefined && patch.pipeline_id !== '' && patch.pipeline_id !== t.pipeline_id;
  const oldStage = pipe.stages.find((x) => x.id === t.stage_id) ?? { id: t.stage_id, name: t.stage_id, kind: t.status_kind };
  if (pipelineChanged) {
    pipe = pipelineOf(app, locationId, String(patch.pipeline_id));
    upd.pipeline_id = pipe.id;
  }
  const wantStage = patch.stage_id ?? patch.status;
  let st: Stage | undefined;
  if (wantStage !== undefined && wantStage !== '') {
    st = findStage(pipe.stages, wantStage);
    if (!st) throw bad('Unbekannter Status');
  } else if (pipelineChanged) st = firstOfKind(pipe.stages, oldStage.kind as string, 'open');
  if (st) {
    if (st.id !== t.stage_id || pipelineChanged) {
      upd.stage_id = st.id;
      upd.status_kind = st.kind;
      if (st.kind === 'resolved') upd.resolved_at = t.resolved_at ?? at;
      if (st.kind === 'closed') (upd.closed_at = t.closed_at ?? at), (upd.resolved_at = t.resolved_at ?? at);
      if (OPEN_KINDS.includes(st.kind)) {
        upd.resolved_at = null;
        upd.closed_at = null;
        // Reopened: the resolution clock starts fresh (a solved ticket isn't late in hindsight).
        if (!OPEN_KINDS.includes(t.status_kind) && s.sla.enabled && t.resolution_due_at) {
          const d = slaDeadlines(new Date(at), s.sla.policies[t.priority as Priority] ?? s.sla.policies.normal, cal, s.sla.warn_percent);
          Object.assign(upd, { resolution_due_at: d.resolution_due_at, resolution_warn_at: d.resolution_warn_at, sla_resolution_state: '' });
        }
      }
      // "Wartet auf Kunde": the resolution clock stops and later resumes with the time that was left.
      const pausedAt = t.sla_paused_at;
      const nowPaused = !!st.pause_sla && OPEN_KINDS.includes(st.kind);
      if (nowPaused && !pausedAt) upd.sla_paused_at = at;
      if (!nowPaused && pausedAt) {
        upd.sla_paused_at = null;
        const policyCal = s.sla.policies[t.priority as Priority]?.business_hours === false ? { ...cal, always: true } : cal;
        upd.resolution_due_at = shiftAfterPause(t.resolution_due_at, new Date(pausedAt), new Date(at), policyCal);
        upd.resolution_warn_at = shiftAfterPause(t.resolution_warn_at, new Date(pausedAt), new Date(at), policyCal);
      }
      events.push(['status', `${oldStage.name} → ${st.name}`, { from: oldStage.id, to: st.id, kind: st.kind }]);
      emits.push(['ticket.status_changed', { from: oldStage.id, fromName: oldStage.name, to: st.id, stageId: st.id, status: st.name, kind: st.kind, previousKind: oldStage.kind }]);
    }
  }

  // Priority: SLA deadlines follow the new policy (timers that already finished stay as they are).
  if (patch.priority !== undefined && patch.priority !== '') {
    const p = patch.priority === 'raise' ? raisePriority(t.priority) : patch.priority;
    if (!isPriority(p)) throw bad('Unbekannte Priorität');
    if (p !== t.priority) {
      upd.priority = p;
      if (s.sla.enabled) {
        const d = slaDeadlines(new Date(t.created_at), s.sla.policies[p], cal, s.sla.warn_percent);
        if (!t.first_response_at) Object.assign(upd, { first_response_due_at: d.first_response_due_at, first_response_warn_at: d.first_response_warn_at, sla_first_state: '' });
        if (!t.resolved_at && !t.closed_at) Object.assign(upd, { resolution_due_at: d.resolution_due_at, resolution_warn_at: d.resolution_warn_at, sla_resolution_state: '' });
      }
      events.push(['priority', `Priorität: ${t.priority} → ${p}`, { from: t.priority, to: p }]);
    }
  }

  // Owner and team.
  if (patch.owner_id !== undefined || patch.team_id !== undefined) {
    const team = patch.team_id !== undefined ? checkTeam(app, locationId, patch.team_id) : t.team_id;
    let owner = t.owner_id;
    if (patch.owner_id !== undefined) owner = patch.owner_id === 'round_robin' ? (team ? roundRobinOwner(app, locationId, team) : null) : checkOwner(app, locationId, patch.owner_id);
    if (owner !== t.owner_id || team !== t.team_id) {
      upd.owner_id = owner;
      upd.team_id = team;
      events.push(['assigned', '', { owner_id: owner, team_id: team, from_owner: t.owner_id, from_team: t.team_id }]);
      emits.push(['ticket.assigned', { ownerId: owner, teamId: team, previousOwnerId: t.owner_id }]);
    }
  }

  if (!Object.keys(upd).length && patch.note === undefined) return getTicketRow(app, locationId, t.id);
  upd.updated_at = at;
  db.update('tickets', t.id, upd, locationId);
  for (const [type, body, data] of events) addTicketEvent(app, t, type, { body, userId: actor.userId ?? null, data: { ...data, via: actor.via ?? 'user' } });
  if (patch.note !== undefined && String(patch.note).trim()) addTicketEvent(app, t, 'note', { body: str(patch.note, 'Notiz', { max: 20_000 }), userId: actor.userId ?? null });
  const next = getTicketRow(app, locationId, t.id);
  const brief = ticketBrief(app, next);
  for (const [type, data] of emits) app.events.emit(locationId, type, { contactId: next.contact_id, ticketId: next.id, ticket: brief, ...data });
  if (upd.owner_id && upd.owner_id !== t.owner_id && upd.owner_id !== actor.userId) notifyOwner(app, locationId, upd.owner_id, next, 'Ticket an dich zugewiesen');
  if (next.contact_id && upd.status_kind && upd.status_kind !== t.status_kind && (upd.status_kind === 'resolved' || upd.status_kind === 'closed')) {
    logActivity(app, locationId, next.contact_id, 'ticket.resolved', `Ticket #${next.number} ${upd.status_kind === 'closed' ? 'geschlossen' : 'gelöst'}`, { ticketId: next.id });
  }
  return next;
}

// --- replies -------------------------------------------------------------------------------------

/** Merge fields for canned responses and auto-replies. */
export function ticketVars(app: App, t: any, userId?: string | null, extra: Record<string, any> = {}) {
  const contact = t.contact_id ? getContact(app, t.location_id, t.contact_id) : undefined;
  const agent = userId ? app.db.get('SELECT name, email FROM users WHERE id = ?', userId) : undefined;
  const loc = app.location(t.location_id);
  const brief = ticketBrief(app, t);
  return { contact: contactVars(contact), ticket: { ...brief, description: t.description }, agent: agent ?? {}, location: loc, ...extra };
}

export const renderTicketText = (app: App, t: any, tpl: string, userId?: string | null, extra: Record<string, any> = {}) => render(tpl, ticketVars(app, t, userId, extra));

/**
 * Sends a reply to the ticket's contact through the normal messaging path (email/SMS/chat, or a
 * channel another module adds such as WhatsApp) and records it on the ticket.
 */
export async function replyToTicket(app: App, locationId: string, ticketId: string, input: { body: unknown; channel?: unknown; subject?: unknown; isHtml?: boolean; status?: unknown }, actor: Actor = {}) {
  const t = getTicketRow(app, locationId, ticketId);
  if (!t) throw notFound('Ticket nicht gefunden');
  if (!t.contact_id) throw bad('Das Ticket hat keinen Kontakt – bitte erst einen Kontakt zuordnen');
  const contact = getContact(app, locationId, t.contact_id);
  if (!contact) throw bad('Kontakt nicht gefunden');
  const body = str(input.body, 'Antwort', { required: true, max: 100_000 });
  const channel = str(input.channel, 'Kanal', { max: 20 }) || t.channel || (contact.email ? 'email' : contact.phone ? 'sms' : 'email');
  let msg: any;
  if (channel === 'email' || channel === 'sms' || channel === 'chat') {
    msg = await sendToContact(app, locationId, {
      contactId: contact.id,
      channel,
      subject: channel === 'email' ? str(input.subject, 'Betreff', { max: 300 }) || replySubject(t.subject, t.number) : undefined,
      body,
      isHtml: !!input.isHtml,
      userId: actor.userId ?? undefined,
      source: `Ticket #${t.number}`,
      ignoreDnd: true,
    });
  } else {
    const ext = app.services.messageChannels?.[channel];
    if (!ext) throw bad(`Kanal „${channel}“ ist nicht verfügbar`);
    msg = await ext({ locationId, body: { contact_id: contact.id, body }, user: actor.userId ? { id: actor.userId } : undefined, method: 'POST', query: new URLSearchParams() });
  }
  const failed = msg?.status === 'failed';
  addTicketEvent(app, t, 'reply', { body, userId: actor.userId ?? null, messageId: msg?.id ?? null, data: { channel, status: msg?.status, error: msg?.error || undefined } });
  const upd: Record<string, any> = { updated_at: now(), channel };
  if (!failed) {
    upd.last_agent_at = now();
    if (!t.first_response_at) upd.first_response_at = now();
  }
  if (!t.conversation_id) upd.conversation_id = msg?.conversation_id ?? getOrCreateConversation(app, locationId, contact.id);
  app.db.update('tickets', t.id, upd, locationId);
  // Status after replying: given explicitly, or "Neu" moves to the first open stage.
  const pipe = pipelineOf(app, locationId, t.pipeline_id);
  const target = input.status !== undefined && input.status !== '' ? input.status : t.status_kind === 'new' && !failed ? pipe.stages.find((x) => x.kind === 'open')?.id : undefined;
  if (target) updateTicket(app, locationId, t.id, { status: target }, actor);
  return { message: msg, ticket: getTicketRow(app, locationId, t.id) };
}

/** A customer's message (email, chat, WhatsApp, portal) joins the ticket; waiting/solved tickets go back to open. */
export function addCustomerMessage(app: App, t: any, m: { body: string; subject?: string; messageId?: string | null; channel?: string; via?: string }) {
  const text = /<[a-z][\s\S]*>/i.test(m.body) ? htmlToText(m.body) : m.body;
  addTicketEvent(app, t, 'customer_reply', { body: text.slice(0, 50_000), messageId: m.messageId ?? null, data: { channel: m.channel, subject: m.subject, via: m.via } });
  app.db.update('tickets', t.id, { last_customer_at: now(), updated_at: now() }, t.location_id);
  if (t.status_kind === 'waiting' || t.status_kind === 'resolved') {
    const pipe = pipelineOf(app, t.location_id, t.pipeline_id);
    const open = pipe.stages.find((x) => x.kind === 'open') ?? pipe.stages.find((x) => x.kind === 'new');
    if (open) updateTicket(app, t.location_id, t.id, { status: open.id }, { via: 'system' });
  }
  return getTicketRow(app, t.location_id, t.id);
}

/**
 * Inbound message → ticket: a "[Ticket #n]" in the subject or the contact's open ticket gets the
 * message; otherwise an email that matches the email-to-ticket rule opens a new ticket.
 * Synchronous on purpose (no double tickets when the event and the mail scan see the same message).
 */
export function routeInbound(app: App, locationId: string, msg: any, extra: { to?: string[]; forceTicket?: boolean } = {}): { ticket: any; created: boolean } | null {
  const { db } = app;
  if (!msg || msg.direction !== 'in' || !msg.contact_id || msg.status === 'draft') return null;
  if (db.get('SELECT 1 FROM ticket_events WHERE message_id = ? LIMIT 1', msg.id)) return null;
  const n = parseTicketTag(msg.subject);
  let t: any = n ? getTicketRow(app, locationId, db.get('SELECT id FROM tickets WHERE location_id = ? AND number = ? AND contact_id = ?', locationId, n, msg.contact_id)?.id ?? '') : undefined;
  if (t?.merged_into) t = getTicketRow(app, locationId, t.merged_into);
  if (t && t.status_kind === 'closed') t = undefined;
  if (!t) {
    const open = db.get(`SELECT id FROM tickets WHERE location_id = ? AND contact_id = ? AND status_kind IN ('new','open','waiting') AND merged_into IS NULL ORDER BY updated_at DESC LIMIT 1`, locationId, msg.contact_id);
    if (open) t = getTicketRow(app, locationId, open.id);
  }
  if (t) return { ticket: addCustomerMessage(app, t, { body: String(msg.body ?? ''), subject: msg.subject, messageId: msg.id, channel: msg.channel, via: 'inbound' }), created: false };
  if (msg.channel !== 'email') return null;
  const s = loadHelpdeskSettings(app, locationId);
  const contact = getContact(app, locationId, msg.contact_id);
  if (!contact) return null;
  if (!extra.forceTicket && !emailMatchesRule(s.email_to_ticket, { to: extra.to, from: contact.email, subject: String(msg.subject ?? ''), body: String(msg.body ?? '') })) return null;
  const body = String(msg.body ?? '');
  const text = (/<[a-z][\s\S]*>/i.test(body) ? htmlToText(body) : body).trim().slice(0, 50_000);
  const ticket = createTicket(
    app,
    locationId,
    { subject: String(msg.subject ?? '').replace(/^\s*(re|aw|fwd?|wg):\s*/i, '').slice(0, 300) || undefined, description: text || '(leere E-Mail)', contact_id: contact.id, conversation_id: msg.conversation_id, source: 'E-Mail', channel: 'email', priority: s.email_to_ticket.priority, category: s.email_to_ticket.category },
    { via: 'email' },
    { messageId: msg.id },
  );
  void sendAutoReply(app, locationId, ticket.id, s);
  return { ticket, created: true };
}

/** Optional confirmation mail ("Wir haben deine Anfrage erhalten") for tickets from email, form or portal. */
export async function sendAutoReply(app: App, locationId: string, ticketId: string, s = loadHelpdeskSettings(app, locationId)) {
  if (!s.auto_reply.enabled) return null;
  const t = getTicketRow(app, locationId, ticketId);
  const contact = t?.contact_id ? getContact(app, locationId, t.contact_id) : undefined;
  if (!t || !contact?.email) return null;
  const msg = await sendToContact(app, locationId, {
    contactId: contact.id,
    channel: 'email',
    subject: renderTicketText(app, t, s.auto_reply.subject),
    body: renderTicketText(app, t, s.auto_reply.body),
    source: `Ticket #${t.number}`,
    ignoreDnd: true,
  });
  addTicketEvent(app, t, 'auto_reply', { body: renderTicketText(app, t, s.auto_reply.body), messageId: msg.id, data: { channel: 'email', status: msg.status } });
  return msg;
}

/** Merges duplicates into `targetId`: timeline, tags and the contact move over, the others close. */
export function mergeTickets(app: App, locationId: string, targetId: string, sourceIds: string[], actor: Actor = {}) {
  const { db } = app;
  const target = getTicketRow(app, locationId, targetId);
  if (!target) throw notFound('Ticket nicht gefunden');
  const sources = uniq(sourceIds.map(String)).filter((x) => x !== targetId).map((x) => getTicketRow(app, locationId, x));
  if (!sources.length || sources.some((x) => !x)) throw bad('Tickets zum Zusammenführen fehlen');
  let tags: string[] = target.tags ?? [];
  db.tx(() => {
    for (const src of sources) {
      db.run('UPDATE ticket_events SET ticket_id = ? WHERE ticket_id = ?', target.id, src.id);
      tags = uniq([...tags, ...(src.tags ?? [])]);
      addTicketEvent(app, target, 'merged', { body: `Ticket #${src.number} „${src.subject}“ zusammengeführt${src.description ? `\n\n${src.description}` : ''}`, userId: actor.userId ?? null, data: { from: src.id, number: src.number } });
      const pipe = pipelineOf(app, locationId, src.pipeline_id);
      const closed = firstOfKind(pipe.stages, 'closed', 'resolved');
      db.update('tickets', src.id, { merged_into: target.id, stage_id: closed.id, status_kind: closed.kind, closed_at: now(), resolved_at: src.resolved_at ?? now(), updated_at: now() }, locationId);
      addTicketEvent(app, src, 'merged', { body: `Zusammengeführt in Ticket #${target.number}`, userId: actor.userId ?? null, data: { into: target.id } });
    }
    db.update('tickets', target.id, { tags, contact_id: target.contact_id ?? sources.find((x) => x.contact_id)?.contact_id ?? null, updated_at: now() }, locationId);
  });
  return getTicketRow(app, locationId, target.id);
}

export const ALL_PRIORITIES = PRIORITIES;

export interface TicketImport {
  external_source: string;
  external_id: string;
  existing_id?: string;
  subject?: string;
  content?: string;
  pipeline?: string;
  stage?: string;
  priority?: string;
  contact_id?: string | null;
  assigned_to?: string | null;
  created_at?: string;
}

/**
 * Imports one ticket from another system (app.services.ticketsImport – HubSpot import): idempotent
 * by (source, id), pipeline/stage/priority mapped to ours, no SLA timers and no workflow events.
 */
export function importTicket(app: App, locationId: string, input: TicketImport): { id: string; created: boolean } {
  const { db } = app;
  const source = String(input.external_source ?? '').trim().slice(0, 40) || 'import';
  const extId = String(input.external_id ?? '').trim().slice(0, 120);
  if (!extId) throw bad('external_id fehlt');
  const pipes = ticketPipelines(app, locationId);
  const wanted = String(input.pipeline ?? '').trim().toLowerCase();
  const pipe = (wanted && pipes.find((p) => p.name.toLowerCase() === wanted)) || pipes[0];
  const stage = mapStage(pipe.stages, input.stage);
  const contact = input.contact_id ? getContact(app, locationId, String(input.contact_id)) : undefined;
  const owner = input.assigned_to && agentsOf(app, locationId).some((a) => a.id === input.assigned_to) ? String(input.assigned_to) : null;
  const createdAt = input.created_at && !Number.isNaN(Date.parse(input.created_at)) ? new Date(input.created_at).toISOString() : now();
  const done = stage.kind === 'resolved' || stage.kind === 'closed';
  const fields = {
    subject: String(input.subject ?? '').trim().slice(0, 300) || 'Ticket',
    description: String(input.content ?? '').slice(0, 50_000),
    pipeline_id: pipe.id,
    stage_id: stage.id,
    status_kind: stage.kind,
    priority: mapPriority(input.priority),
    owner_id: owner,
    contact_id: contact?.id ?? null,
  };
  const existing =
    (input.existing_id && db.get('SELECT * FROM tickets WHERE id = ? AND location_id = ?', String(input.existing_id), locationId)) ||
    db.get('SELECT * FROM tickets WHERE location_id = ? AND external_source = ? AND external_id = ?', locationId, source, extId);
  if (existing) {
    db.update(
      'tickets',
      existing.id,
      { ...fields, external_source: source, external_id: extId, resolved_at: done ? (existing.resolved_at ?? now()) : null, closed_at: stage.kind === 'closed' ? (existing.closed_at ?? now()) : null, updated_at: now() },
      locationId,
    );
    return { id: existing.id, created: false };
  }
  const number = db.get<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets WHERE location_id = ?', locationId)!.n;
  const row = {
    id: id(),
    location_id: locationId,
    number,
    ...fields,
    category: '',
    tags: [],
    source: 'Import',
    channel: contact?.email ? 'email' : contact?.phone ? 'sms' : '',
    conversation_id: contact ? (db.get('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', locationId, contact.id)?.id ?? null) : null,
    external_source: source,
    external_id: extId,
    resolved_at: done ? createdAt : null,
    closed_at: stage.kind === 'closed' ? createdAt : null,
    created_at: createdAt,
    updated_at: now(),
  };
  db.insert('tickets', row);
  addTicketEvent(app, row, 'created', { body: row.description, at: createdAt, data: { source: 'Import', via: 'import', external_source: source, external_id: extId } });
  return { id: row.id, created: true };
}
