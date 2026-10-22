import type { App, Module } from '../core/app.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { parseRows } from '../core/db.js';
import type { ReportField, ReportSource } from '../services/report-engine.js';
import { locationLookup, userLookup } from '../services/report-sources.js';
import { AREAS, WISH_BOARD, cleanArea, publicStatus, stageFromInput, type FeedbackKind } from '../services/feedback.js';
import {
  STAGES_OF_BOARD,
  ensureSupport,
  findItem,
  getItem,
  loadFeedbackSettings,
  markDuplicate,
  markFixed,
  publicReply,
  publicThread,
  roleLabel,
  saveFeedbackSettings,
  setStatus,
  statusOf,
  ticketOf,
  urlOf,
  type FeedbackRow,
} from '../services/feedback-store.js';
import { addTicketEvent, type Actor } from '../services/tickets.js';
import type { Tool } from './mcp.js';

/**
 * Agency side of „Fehler & Wünsche“: which sub-account receives the reports, the triage data for
 * the panel on such tickets (diagnostics, screenshots, occurrences, affected users and
 * sub-accounts, votes), the actions „Als Duplikat von …“ and „Behoben in Version …“, MCP tools so
 * Claude/Codex can triage and fix agentically, and report sources for Berichte.
 */

const actorOf = (ctx: Ctx): Actor => ({ userId: ctx.user?.id ?? null, via: ctx.via === 'mcp' ? 'mcp' : ctx.viaApiKey ? 'api' : 'user' });

function mustItem(app: App, ref: string): FeedbackRow {
  const f = findItem(app, ref);
  if (!f) throw notFound('Meldung nicht gefunden');
  return f;
}

/** Everything the triage panel and ghl_get_bug_report show. */
export function adminDetail(app: App, f: FeedbackRow, ctx: Ctx) {
  const { db } = app;
  const t = ticketOf(app, f);
  const st = statusOf(app, f, t);
  const reporters = db
    .all(
      `SELECT l.user_id, l.role AS link_role, l.location_id, l.created_at, u.name, u.email, u.role, u.permissions, loc.name AS location_name
       FROM feedback_links l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN locations loc ON loc.id = l.location_id WHERE l.feedback_id = ? ORDER BY l.created_at`,
      f.id,
    )
    .map((r) => ({ user_id: r.user_id, name: r.name ?? '(gelöscht)', email: r.email ?? '', role: r.role ? roleLabel({ role: r.role, permissions: r.permissions ? JSON.parse(r.permissions) : null }) : '', link: r.link_role, location_id: r.location_id, location_name: r.location_name ?? '', at: r.created_at }));
  // Affected sub-accounts: from reporters plus the counters of automatic errors (also users who did not opt in).
  const counts = new Map<string, number>();
  for (const r of reporters) if (r.location_id) counts.set(r.location_id, (counts.get(r.location_id) ?? 0) + 1);
  for (const [loc, n] of Object.entries((f.diagnostics as any)?.locations ?? {})) counts.set(loc, Math.max(counts.get(loc) ?? 0, Number(n) || 0));
  const locations = [...counts.entries()].map(([id, n]) => ({ id, name: app.location(id)?.name ?? '(gelöscht)', n })).sort((a, b) => b.n - a.n);
  const dup = f.duplicate_of ? getItem(app, f.duplicate_of) : undefined;
  const duplicates = db.all('SELECT id, title, ticket_id, support_location_id FROM feedback_items WHERE duplicate_of = ? ORDER BY created_at', f.id).map((d) => ({ id: d.id, title: d.title, ticket_id: d.ticket_id, number: db.get('SELECT number FROM tickets WHERE id = ?', d.ticket_id)?.number ?? null }));
  const voters = f.kind === 'wish' ? db.all('SELECT u.name FROM feedback_votes v JOIN users u ON u.id = v.user_id WHERE v.feedback_id = ? ORDER BY v.created_at LIMIT 100', f.id).map((r) => r.name as string) : [];
  const notes = t ? parseRows(db.all(`SELECT e.id, e.type, e.body, e.created_at, u.name AS user_name FROM ticket_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.ticket_id = ? AND e.type = 'note' ORDER BY e.created_at`, t.id), []) : [];
  return {
    id: f.id,
    kind: f.kind,
    title: f.title,
    body: f.body,
    expected: f.expected,
    steps: f.steps,
    severity: f.severity,
    area: f.area,
    platform: f.platform,
    status: st,
    version: f.version,
    public_note: f.public_note,
    hidden: !!f.hidden,
    fingerprint: f.fingerprint,
    occurrences: f.occurrences,
    first_seen_at: f.first_seen_at,
    last_seen_at: f.last_seen_at,
    votes: f.votes,
    voters,
    fixed_at: f.fixed_at,
    created_at: f.created_at,
    updated_at: f.updated_at,
    url: urlOf(f),
    ticket: t ? { id: t.id, number: t.number, location_id: t.location_id, location_name: app.location(t.location_id)?.name ?? '', stage_id: t.stage_id, status_kind: t.status_kind, priority: t.priority, owner_id: t.owner_id, url: `/app/tickets/${t.id}` } : null,
    reporter: f.user_id ? (reporters.find((r) => r.user_id === f.user_id) ?? null) : null,
    reporters,
    locations,
    duplicate_of: dup ? { id: dup.id, title: dup.title, number: ticketOf(app, dup)?.number ?? null, ticket_id: dup.ticket_id } : null,
    duplicates,
    diagnostics: f.diagnostics,
    files: db.all('SELECT id, mime, size, created_at, user_id FROM feedback_files WHERE feedback_id = ? ORDER BY created_at', f.id).map((x) => ({ ...x, url: `/api/feedback/files/${x.id}` })),
    thread: publicThread(app, f, { id: ctx.user!.id, role: 'admin' }),
    notes,
  };
}

/** Triage list (Agentur → Fehler & Wünsche, MCP). */
export function adminList(app: App, q: Record<string, any>) {
  const { db } = app;
  const where = ['f.duplicate_of IS NULL'];
  const params: any[] = [];
  const kinds = String(q.kind ?? 'reports').split(',').map((k) => k.trim()).filter(Boolean);
  const list = kinds.includes('all') ? [] : kinds.includes('reports') ? ['bug', 'question', 'auto'] : kinds.filter((k) => ['bug', 'question', 'wish', 'auto'].includes(k));
  if (list.length) where.push(`f.kind IN (${list.map(() => '?').join(',')})`), params.push(...list);
  const state = String(q.state ?? 'open');
  if (state === 'open') where.push(`t.status_kind IN ('new','open','waiting')`);
  else if (state === 'done') where.push(`t.status_kind IN ('resolved','closed')`);
  const stage = stageFromInput(q.status);
  if (q.status && STAGES_OF_BOARD[String(q.status)]) where.push(`t.stage_id IN (${STAGES_OF_BOARD[String(q.status)].map(() => '?').join(',')})`), params.push(...STAGES_OF_BOARD[String(q.status)]);
  else if (stage) where.push('t.stage_id = ?'), params.push(stage);
  if (q.area) where.push('f.area = ?'), params.push(cleanArea(q.area));
  const text = String(q.q ?? '').trim().slice(0, 100);
  if (text) {
    const n = Number(text.replace(/^#/, ''));
    where.push(`(f.title LIKE ? OR f.body LIKE ?${Number.isInteger(n) && n > 0 ? ' OR t.number = ?' : ''})`);
    params.push(`%${text}%`, `%${text}%`, ...(Number.isInteger(n) && n > 0 ? [n] : []));
  }
  const sort = String(q.sort ?? '');
  const order =
    sort === 'votes' ? 'f.votes DESC, f.created_at DESC'
    : sort === 'occurrences' ? 'f.occurrences DESC, f.last_seen_at DESC'
    : sort === 'new' ? 'f.created_at DESC'
    : sort === 'priority' ? `CASE t.priority WHEN 'dringend' THEN 0 WHEN 'hoch' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, f.created_at DESC`
    : 'COALESCE(f.last_seen_at, f.updated_at) DESC';
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const rows = db.all(
    `SELECT f.*, t.number, t.stage_id, t.status_kind, t.priority, t.location_id AS ticket_location, u.name AS reporter_name, l.name AS origin_name,
       (SELECT COUNT(*) FROM feedback_links x WHERE x.feedback_id = f.id) AS reporters
     FROM feedback_items f JOIN tickets t ON t.id = f.ticket_id LEFT JOIN users u ON u.id = f.user_id LEFT JOIN locations l ON l.id = f.origin_location_id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    number: r.number,
    title: r.title,
    status: publicStatus(r.kind as FeedbackKind, r.stage_id, r.status_kind),
    priority: r.priority,
    severity: r.severity,
    area: r.area,
    platform: r.platform,
    votes: r.votes,
    occurrences: r.occurrences,
    reporters: r.reporters,
    reporter: r.reporter_name ?? '',
    origin: r.origin_name ?? '',
    version: r.version,
    hidden: !!r.hidden,
    last_seen_at: r.last_seen_at,
    created_at: r.created_at,
    ticket_id: r.ticket_id,
    location_id: r.ticket_location,
  }));
}

/** PATCH from the panel or MCP: fields, internal note, public reply, version, status, duplicate. */
async function applyPatch(app: App, f: FeedbackRow, b: any, ctx: Ctx) {
  const { db } = app;
  const actor = actorOf(ctx);
  const set: Record<string, any> = {};
  if (b.title !== undefined) set.title = str(b.title, 'Titel', { required: true, max: 200 });
  if (b.area !== undefined) set.area = cleanArea(b.area);
  if (b.hidden !== undefined) set.hidden = b.hidden ? 1 : 0;
  if (b.public_note !== undefined) set.public_note = str(b.public_note, 'Öffentlicher Hinweis', { max: 2000 });
  if (Object.keys(set).length) db.update('feedback_items', f.id, { ...set, updated_at: new Date().toISOString() });
  const t = ticketOf(app, f);
  if (b.note !== undefined && String(b.note).trim() && t) addTicketEvent(app, t, 'note', { body: str(b.note, 'Notiz', { max: 20_000 }), userId: actor.userId ?? null });
  if (b.reply !== undefined && String(b.reply).trim()) await publicReply(app, getItem(app, f.id)!, b.reply, actor);
  const stage = b.status !== undefined && b.status !== '' ? stageFromInput(b.status) : undefined;
  if (b.status !== undefined && b.status !== '' && !stage) throw bad(`Unbekannter Status – erlaubt: neu, bestaetigt, in_arbeit, behoben, ausgeliefert, abgelehnt (Wünsche: ${WISH_BOARD.map((x) => x[0]).join(', ')})`);
  const version = b.fixed_in ?? b.shipped_in ?? b.version;
  if (version !== undefined && String(version).trim()) {
    await markFixed(app, getItem(app, f.id)!, { version, note: b.changelog ?? undefined, shipped: stage ? stage !== 'behoben' : b.shipped !== false }, actor);
  } else if (stage === 'duplikat') {
    if (!b.duplicate_of) throw bad('duplicate_of fehlt (ID oder Ticketnummer des Originals)');
  } else if (stage) {
    const before = statusOf(app, getItem(app, f.id)!).key;
    if (before !== stage) setStatus(app, getItem(app, f.id)!, stage, actor, { reason: b.reason });
    else if (b.reason !== undefined) db.run('UPDATE feedback_items SET public_note = ? WHERE id = ?', str(b.reason, 'Begründung', { max: 2000 }), f.id);
  }
  if (b.duplicate_of) await markDuplicate(app, getItem(app, f.id)!, mustItem(app, String(b.duplicate_of)), actor);
  return getItem(app, f.id)!;
}

const LOC_NOTE = 'Kein location_id nötig – die Meldungen liegen im Support-Sub-Account der Agentur.';
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const qs = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
};
const brief = (r: any) => ({ id: r.id, number: r.number, kind: r.kind, title: r.title, status: r.status.label, status_key: r.status.key, priority: r.priority, severity: r.severity || undefined, area: r.area || undefined, votes: r.kind === 'wish' ? r.votes : undefined, occurrences: r.kind === 'auto' ? r.occurrences : undefined, reporters: r.reporters, origin: r.origin || undefined, version: r.version || undefined, last_seen_at: r.last_seen_at, ticket_id: r.ticket_id, location_id: r.location_id });

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_bug_reports',
    title: 'Fehlermeldungen auflisten',
    description: `Fehlermeldungen, Fragen und automatisch erfasste Fehler (Browser/Server) aller HyperLevel-Nutzer. kind: reports (Standard: bug+question+auto)|bug|question|auto|all; state: open (Standard)|done|all; status: neu|bestaetigt|in_arbeit|behoben|ausgeliefert|abgelehnt; sort: updated|new|priority|occurrences; q sucht in Titel/Text/#Nummer. ${LOC_NOTE}`,
    inputSchema: obj({ kind: { type: 'string' }, state: { type: 'string' }, status: { type: 'string' }, sort: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    agencyOnly: true,
    run: async (call, a) => (await call.api('GET', `/api/feedback/admin/items${qs({ kind: a.kind ?? 'reports', state: a.state, status: a.status, sort: a.sort, q: a.q, limit: a.limit ?? 50 })}`)).map(brief),
  },
  {
    name: 'ghl_get_bug_report',
    title: 'Fehlermeldung lesen',
    description: 'Eine Meldung mit allem für die Fehlersuche: Beschreibung, erwartet, Schritte, Diagnose (Seite, Version, Browser/Gerät, letzte Client-Fehler, fehlgeschlagene API-Aufrufe, Server-Stack + Request-ID), Häufigkeit, betroffene Nutzer/Sub-Accounts, öffentlicher Verlauf und interne Notizen. report = ID oder Ticketnummer.',
    inputSchema: obj({ report: { type: 'string' } }, ['report']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    agencyOnly: true,
    run: async (call, a) => {
      const d = await call.api('GET', `/api/feedback/admin/items/${encodeURIComponent(a.report)}`);
      return { ...d, files: d.files.map((f: any) => ({ id: f.id, mime: f.mime, size: f.size })) };
    },
  },
  {
    name: 'ghl_update_bug_report',
    title: 'Fehlermeldung bearbeiten',
    description: 'Triage: status (neu|bestaetigt|in_arbeit|behoben|ausgeliefert|abgelehnt; reason = öffentliche Begründung bei abgelehnt), reply = öffentliche Antwort an die Melder (App, Push, E-Mail), fixed_in = „Behoben in Version …“ (benachrichtigt alle verknüpften Melder; changelog = Zeile für „Was ist neu“; ohne status → ausgeliefert), note = interne Notiz, duplicate_of = Original (ID/Nummer).',
    inputSchema: obj({ report: { type: 'string' }, status: { type: 'string' }, reason: { type: 'string' }, reply: { type: 'string' }, fixed_in: { type: 'string' }, changelog: { type: 'string' }, note: { type: 'string' }, duplicate_of: { type: 'string' } }, ['report']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    agencyOnly: true,
    run: async (call, a) => {
      const { report, ...body } = a;
      const d = await call.api('PATCH', `/api/feedback/admin/items/${encodeURIComponent(report)}`, { body });
      return { id: d.id, number: d.ticket?.number, status: d.status.label, version: d.version || undefined, duplicate_of: d.duplicate_of };
    },
  },
  {
    name: 'ghl_list_wishes',
    title: 'Feature-Wünsche (nach Stimmen)',
    description: `Die Wunschliste aller HyperLevel-Nutzer, sortiert nach Stimmen – Grundlage für die Planung. state: open (Standard)|done|all; status: idea|planned|in_progress|done|declined; area: ${AREAS.join(', ')}; q sucht in Titel/Text.`,
    inputSchema: obj({ state: { type: 'string' }, status: { type: 'string' }, area: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    agencyOnly: true,
    run: async (call, a) => (await call.api('GET', `/api/feedback/admin/items${qs({ kind: 'wish', sort: 'votes', state: a.state, status: a.status, area: a.area, q: a.q, limit: a.limit ?? 50 })}`)).map((r: any) => ({ ...brief(r), status: r.status.label, board: r.status.board })),
  },
  {
    name: 'ghl_update_wish',
    title: 'Feature-Wunsch bearbeiten',
    description: 'status: idea|planned|in_progress|done|declined (reason = öffentliche Begründung bei declined), reply = öffentliche Antwort, shipped_in = „Fertig in Version …“ (benachrichtigt Autor und alle Abstimmenden; changelog = Zeile für „Was ist neu“), note = interne Notiz, duplicate_of = Original (Stimmen und Abstimmende ziehen um), hidden = aus der Liste nehmen.',
    inputSchema: obj({ wish: { type: 'string' }, status: { type: 'string' }, reason: { type: 'string' }, reply: { type: 'string' }, shipped_in: { type: 'string' }, changelog: { type: 'string' }, note: { type: 'string' }, duplicate_of: { type: 'string' }, hidden: { type: 'boolean' } }, ['wish']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    agencyOnly: true,
    run: async (call, a) => {
      const { wish, ...body } = a;
      const d = await call.api('PATCH', `/api/feedback/admin/items/${encodeURIComponent(wish)}`, { body });
      return { id: d.id, number: d.ticket?.number, status: d.status.label, board: d.status.board, votes: d.votes, version: d.version || undefined, duplicate_of: d.duplicate_of };
    },
  },
];

// --- report sources (Berichte) -------------------------------------------------------------------------

const date = (key: string, label: string, sql: string): ReportField => ({ key, label, type: 'date', sql });
const STATUS = { neu: 'Neu', bestaetigt: 'Bestätigt', in_arbeit: 'In Arbeit', behoben: 'Behoben', ausgeliefert: 'Ausgeliefert', abgelehnt: 'Abgelehnt', duplikat: 'Duplikat' };
const common: ReportField[] = [
  date('created_at', 'Gemeldet am', 'f.created_at'),
  date('fixed_at', 'Behoben am', 'f.fixed_at'),
  { key: 'status', label: 'Status', type: 'enum', sql: 't.stage_id', options: STATUS },
  { key: 'open', label: 'Offen', type: 'boolean', sql: `(CASE WHEN t.status_kind IN ('new','open','waiting') THEN 1 ELSE 0 END)`, options: { 1: 'Offen', 0: 'Erledigt' } },
  { key: 'priority', label: 'Priorität', type: 'enum', sql: 't.priority', options: { niedrig: 'Niedrig', normal: 'Normal', hoch: 'Hoch', dringend: 'Dringend' } },
  { key: 'platform', label: 'Plattform', type: 'enum', sql: 'f.platform', options: { web: 'Web', android: 'Android', server: 'Server' } },
  { key: 'version', label: 'Behoben in Version', type: 'string', sql: 'f.version', empty: 'Noch keine' },
  { key: 'origin', label: 'Aus Sub-Account', type: 'string', sql: 'f.origin_location_id', lookup: locationLookup, empty: 'Unbekannt' },
  { key: 'reporter', label: 'Gemeldet von', type: 'string', sql: 'f.user_id', lookup: userLookup, empty: 'Automatisch' },
  { key: 'days_to_fix', label: 'Tage bis behoben', type: 'number', sql: '(CASE WHEN f.fixed_at IS NOT NULL THEN julianday(f.fixed_at) - julianday(f.created_at) END)', format: 'days' },
];
const BUGS: ReportSource = {
  key: 'feedback_bugs',
  label: 'Fehlermeldungen',
  description: 'Fehlermeldungen, Fragen und automatisch erfasste Fehler aller Nutzer (Support-Sub-Account)',
  area: 'helpdesk',
  from: 'feedback_items f JOIN tickets t ON t.id = f.ticket_id',
  location: 't.location_id',
  where: `f.kind != 'wish' AND f.duplicate_of IS NULL`,
  dateField: 'created_at',
  requires: ['feedback_items', 'tickets'],
  countLabel: 'Anzahl Meldungen',
  fields: [
    ...common,
    { key: 'kind', label: 'Art', type: 'enum', sql: 'f.kind', options: { bug: 'Fehler', question: 'Frage', auto: 'Automatisch erfasst' } },
    { key: 'severity', label: 'Schweregrad', type: 'enum', sql: 'f.severity', options: { gering: 'Kleinigkeit', mittel: 'Stört', hoch: 'Blockiert', kritisch: 'Kritisch' }, empty: '–' },
    { key: 'occurrences', label: 'Vorkommen', type: 'number', sql: 'f.occurrences', format: 'number' },
    { key: 'reporters', label: 'Betroffene Nutzer', type: 'number', sql: '(SELECT COUNT(*) FROM feedback_links x WHERE x.feedback_id = f.id)', format: 'number' },
  ],
  calcs: [
    { key: 'fix_rate', label: 'Behoben-Quote', sql: `100.0 * SUM(CASE WHEN t.stage_id IN ('behoben','ausgeliefert') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`, format: 'percent' },
    { key: 'avg_days_to_fix', label: 'Ø Tage bis behoben', sql: 'AVG(CASE WHEN f.fixed_at IS NOT NULL THEN julianday(f.fixed_at) - julianday(f.created_at) END)', format: 'days' },
    { key: 'occurrences_sum', label: 'Vorkommen gesamt', sql: 'SUM(f.occurrences)', format: 'number' },
  ],
};
const WISHES: ReportSource = {
  key: 'feedback_wishes',
  label: 'Feature-Wünsche',
  description: 'Die Wunschliste: Stimmen, Bereiche und Umsetzung',
  area: 'helpdesk',
  from: 'feedback_items f JOIN tickets t ON t.id = f.ticket_id',
  location: 't.location_id',
  where: `f.kind = 'wish' AND f.duplicate_of IS NULL`,
  dateField: 'created_at',
  requires: ['feedback_items', 'tickets'],
  countLabel: 'Anzahl Wünsche',
  fields: [
    ...common,
    { key: 'area', label: 'Bereich', type: 'enum', sql: 'f.area', options: Object.fromEntries(AREAS.map((a) => [a, a])) },
    { key: 'votes', label: 'Stimmen', type: 'number', sql: 'f.votes', format: 'number' },
    { key: 'title', label: 'Wunsch', type: 'string', sql: 'f.title', noGroup: true },
  ],
  calcs: [
    { key: 'votes_sum', label: 'Stimmen gesamt', sql: 'SUM(f.votes)', format: 'number' },
    { key: 'done_rate', label: 'Umgesetzt-Quote', sql: `100.0 * SUM(CASE WHEN t.stage_id IN ('behoben','ausgeliefert') THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)`, format: 'percent' },
  ],
};

export const feedbackAdminModule: Module = {
  name: 'feedback-admin',
  register(app) {
    const { db, router } = app;

    // --- agency setting: where reports go --------------------------------------------------------------
    const settingsOut = () => {
      const s = loadFeedbackSettings(app);
      const loc = s.support_location_id ? app.location(s.support_location_id) : undefined;
      const pid = loc ? s.pipelines[loc.id] : '';
      const counts = loc
        ? db.get(
            `SELECT SUM(CASE WHEN f.kind IN ('bug','question') AND t.status_kind IN ('new','open','waiting') THEN 1 ELSE 0 END) AS bugs,
               SUM(CASE WHEN f.kind = 'auto' AND t.status_kind IN ('new','open','waiting') THEN 1 ELSE 0 END) AS auto,
               SUM(CASE WHEN f.kind = 'wish' AND t.status_kind IN ('new','open','waiting') THEN 1 ELSE 0 END) AS wishes
             FROM feedback_items f JOIN tickets t ON t.id = f.ticket_id WHERE f.duplicate_of IS NULL`,
          )
        : null;
      return {
        support_location_id: loc?.id ?? '',
        support_location_name: loc?.name ?? '',
        pipeline_id: pid || '',
        view_id: loc ? (db.get('SELECT id FROM helpdesk_views WHERE location_id = ? AND name = ? AND user_id IS NULL', loc.id, 'Fehler & Wünsche')?.id ?? '') : '',
        capture_server: s.capture_server,
        capture_client: s.capture_client,
        locations: db.all('SELECT id, name FROM locations ORDER BY name'),
        open: { bugs: Number(counts?.bugs ?? 0), auto: Number(counts?.auto ?? 0), wishes: Number(counts?.wishes ?? 0) },
      };
    };
    router.get('/api/feedback/settings', 'admin', settingsOut);
    router.put('/api/feedback/settings', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      const s = loadFeedbackSettings(app);
      if (b.support_location_id !== undefined) {
        const loc = String(b.support_location_id ?? '').trim();
        if (loc && !app.location(loc)) throw bad('Sub-Account nicht gefunden');
        s.support_location_id = loc;
      }
      if (b.capture_server !== undefined) s.capture_server = !!b.capture_server;
      if (b.capture_client !== undefined) s.capture_client = !!b.capture_client;
      saveFeedbackSettings(app, s);
      if (s.support_location_id) ensureSupport(app);
      return settingsOut();
    });
    /** „Jetzt einrichten“: creates "<Marke> Support" (or prepares the chosen sub-account). */
    router.post('/api/feedback/settings/setup', 'admin', () => {
      ensureSupport(app);
      return settingsOut();
    });

    // --- triage --------------------------------------------------------------------------------------------
    router.get('/api/feedback/admin/items', 'admin', (ctx) => adminList(app, Object.fromEntries(ctx.query)));
    router.get('/api/feedback/admin/items/:ref', 'admin', (ctx) => adminDetail(app, mustItem(app, ctx.params.ref), ctx));
    router.get('/api/feedback/admin/by-ticket/:ticketId', 'admin', (ctx) => {
      const f = db.get('SELECT id FROM feedback_items WHERE ticket_id = ?', ctx.params.ticketId);
      return { item: f ? adminDetail(app, getItem(app, f.id)!, ctx) : null };
    });
    router.patch('/api/feedback/admin/items/:ref', 'admin', async (ctx) => adminDetail(app, await applyPatch(app, mustItem(app, ctx.params.ref), ctx.body ?? {}, ctx), ctx));
    router.post('/api/feedback/admin/items/:ref/duplicate', 'admin', async (ctx) => {
      const f = mustItem(app, ctx.params.ref);
      const into = await markDuplicate(app, f, mustItem(app, str(ctx.body?.of, 'Original', { required: true })), actorOf(ctx));
      return adminDetail(app, into, ctx);
    });
    router.post('/api/feedback/admin/items/:ref/fixed', 'admin', async (ctx) => {
      const f = mustItem(app, ctx.params.ref);
      const b = ctx.body ?? {};
      return adminDetail(app, await markFixed(app, f, { version: b.version, note: b.note, shipped: b.shipped !== false }, actorOf(ctx)), ctx);
    });

    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.reportSources = [...(app.services.reportSources ?? []), BUGS, WISHES];
  },
};
