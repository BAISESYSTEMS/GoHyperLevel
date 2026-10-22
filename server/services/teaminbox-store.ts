import type { App } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { track } from './collab-actor.js';
import { contactName, getContact } from './contacts.js';
import { notifyTeam } from './messaging.js';
import { peopleOf } from './team-people.js';
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  calendarOf,
  isPriority,
  isStatus,
  plainNote,
  resolveMentions,
  withDefaults,
  type InboxPriority,
  type InboxSettings,
  type InboxStatus,
} from './teaminbox-model.js';
import type { ChatHub } from './teamchat-hub.js';

/**
 * Data rules of the Team-Posteingang: the state of a conversation (assignee, status, snooze, priority), the timeline with
 * internal notes, and the side effects of every change (workflow events, notifications, realtime, audit entry for changes
 * that no request made). Routes, bulk actions, workflow steps, MCP tools, the mobile API and the rules engine all go
 * through these functions, so every entry point obeys the same rules.
 */

export interface ConvRow {
  id: string;
  location_id: string;
  contact_id: string;
  unread: number;
  starred: number;
  last_message: string;
  last_message_at: string;
  created_at: string;
  assignee_id: string | null;
  team_id: string | null;
  inbox_status: InboxStatus;
  snoozed_until: string | null;
  snoozed_at: string | null;
  priority: InboxPriority;
  assigned_at: string | null;
  closed_at: string | null;
  last_in_at: string | null;
  last_out_at: string | null;
  last_out_user: string | null;
  out_pending: number;
  awaiting_since: string | null;
  awaiting_kind: '' | 'first' | 'next';
  response_due_at: string | null;
  response_warn_at: string | null;
  sla_state: '' | 'warning' | 'breached';
  first_response_at: string | null;
  sla_dirty: number;
}

/** Who changes something: a person (route), or the system / a rule / a workflow (then the change is logged here). */
export interface Who {
  userId: string | null;
  name: string;
  via: 'user' | 'agent' | 'mcp' | 'api' | 'workflow' | 'rule' | 'system' | 'customer';
  /** The request, when there is one: its audit line is written by the router, not here. */
  ctx?: Ctx;
}

export const whoOf = (ctx: Ctx): Who => {
  const u = ctx.user;
  const via = ctx.via === 'mcp' ? 'mcp' : ctx.viaApiKey ? 'api' : 'user';
  return { userId: u?.id ?? null, name: ctx.viaApiKey ? 'API-Schlüssel' : (u?.name ?? 'System'), via, ctx };
};
export const SYSTEM: Who = { userId: null, name: 'System', via: 'system' };

export const hubOf = (app: App) => app.services.inboxHub as ChatHub | undefined;

export function settingsOf(app: App, locationId: string): InboxSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM inbox_settings WHERE location_id = ?', locationId);
  try {
    return withDefaults(row ? JSON.parse(row.data) : null);
  } catch {
    return withDefaults(null);
  }
}
export function saveSettings(app: App, locationId: string, s: InboxSettings) {
  app.db.run(
    `INSERT INTO inbox_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    locationId,
    JSON.stringify(s),
    now(),
  );
}

export const calendarFor = (app: App, locationId: string, s = settingsOf(app, locationId)) => calendarOf(s, app.location(locationId)?.timezone || 'Europe/Berlin');

export function getConv(app: App, locationId: string, convId: string): ConvRow {
  const row = app.db.get<ConvRow>('SELECT * FROM conversations WHERE id = ? AND location_id = ?', convId, locationId);
  if (!row) throw notFound('Konversation nicht gefunden');
  return row;
}

const userName = (app: App, uid: string | null | undefined) => (uid ? (app.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', uid)?.name ?? 'Unbekannt') : '');

/** Short description of a conversation for events, webhooks and notifications. */
export function brief(app: App, c: ConvRow) {
  const contact = getContact(app, c.location_id, c.contact_id);
  const lastChannel = app.db.get<{ channel: string }>('SELECT channel FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', c.id)?.channel ?? '';
  return {
    id: c.id,
    contact_id: c.contact_id,
    contact_name: contact ? contactName(contact) : '',
    channel: lastChannel,
    status: c.inbox_status,
    priority: c.priority,
    assignee_id: c.assignee_id,
    assignee_name: userName(app, c.assignee_id),
    team_id: c.team_id,
    snoozed_until: c.snoozed_until,
    sla_state: c.sla_state,
    response_due_at: c.response_due_at,
    last_message: c.last_message,
    url: `${app.baseUrl()}/app/conversations/${c.id}`,
  };
}

// --- timeline ---------------------------------------------------------------------------------

export interface TimelineRow {
  id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string;
  type: string;
  user_id: string | null;
  author_name: string;
  body: string;
  mentions: string[];
  data: Record<string, any>;
  created_at: string;
  edited_at: string | null;
}

export function addTimeline(app: App, c: ConvRow, type: string, o: { userId?: string | null; name?: string; body?: string; mentions?: string[]; data?: Record<string, any>; at?: string } = {}): TimelineRow {
  const row = {
    id: id(),
    location_id: c.location_id,
    conversation_id: c.id,
    contact_id: c.contact_id,
    type,
    user_id: o.userId ?? null,
    author_name: (o.name ?? '').slice(0, 200),
    body: String(o.body ?? '').slice(0, 10_000),
    mentions: JSON.stringify(o.mentions ?? []),
    data: JSON.stringify(o.data ?? {}),
    created_at: o.at ?? now(),
  };
  app.db.insert('inbox_timeline', row);
  return { ...row, mentions: o.mentions ?? [], data: o.data ?? {}, edited_at: null };
}

export function timeline(app: App, c: ConvRow, limit = 300): TimelineRow[] {
  return app.db
    .all<any>('SELECT * FROM inbox_timeline WHERE conversation_id = ? AND location_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', c.id, c.location_id, limit)
    .reverse()
    .map((r) => ({ ...r, mentions: safe(r.mentions, []), data: safe(r.data, {}) }));
}
const safe = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
};

// --- realtime / audit / notifications ---------------------------------------------------------

function announce(app: App, c: Pick<ConvRow, 'id' | 'location_id'>, reason: string, extra: Record<string, unknown> = {}) {
  hubOf(app)?.publish('conversation', { id: c.id, reason, ...extra }, (s) => s.locationId === c.location_id);
}
export const announceConversation = announce;

function audit(app: App, who: Who, c: ConvRow, action: string, summary: string) {
  // A request is logged by the router (afterWrite); system, rule and workflow changes are not.
  if (who.ctx) return;
  app.services.audit?.({ action, actor: who.name, userId: who.userId, locationId: c.location_id, entityId: c.id, summary, route: who.via });
}

const url = (c: Pick<ConvRow, 'id'>) => `/app/conversations/${c.id}`;

/** Push and Android-feed notice for people (or, with an empty list, everybody who works on the conversations of the sub-account). */
export function pushToUsers(app: App, userIds: string[], title: string, body: string, c: ConvRow, tag: string, urgency: 'normal' | 'high' = 'normal', everyone = false) {
  if (!userIds.length && !everyone) return;
  track(app, Promise.resolve(app.services.pushNotify?.({ locationId: c.location_id, ...(everyone ? {} : { userIds }), kind: 'inbox', title, body: body.slice(0, 200), url: url(c), tag, urgency })));
  for (const uid of userIds) app.services.mobileFeed?.({ locationId: c.location_id, type: 'message', area: 'conversations', userId: uid, title, body: body.slice(0, 200), link: `${url(c)}`, ref: `${tag}:${uid}` });
}

const contactLabel = (app: App, c: ConvRow) => {
  const contact = getContact(app, c.location_id, c.contact_id);
  return contact ? contactName(contact) : 'Unbekannt';
};

/** The people allowed to be assigned or mentioned in a sub-account (area Konversationen). */
export const agentsOf = (app: App, locationId: string) => peopleOf(app, locationId, 'conversations').map((u) => ({ id: u.id, name: u.name, email: u.email }));

// --- assignment ---------------------------------------------------------------------------------

export interface AssignInput {
  /** User id, or null to unassign. `undefined` leaves it as it is (only the team changes). */
  userId?: string | null;
  teamId?: string | null;
  /** The new assignee is told only when a person other than themselves did it. */
  quiet?: boolean;
  /** The reason shown in the timeline ("Regel: Webchat", "weil Anna abwesend ist"). */
  reason?: string;
}

export function setAssignee(app: App, who: Who, conv: ConvRow, input: AssignInput): ConvRow {
  const loc = conv.location_id;
  const agents = agentsOf(app, loc);
  let userId = input.userId === undefined ? conv.assignee_id : input.userId;
  if (userId && !agents.some((a) => a.id === userId)) throw bad('Diese Person hat keinen Zugriff auf die Konversationen dieses Sub-Accounts');
  let teamId = input.teamId === undefined ? conv.team_id : input.teamId;
  if (teamId && !app.db.get('SELECT 1 FROM helpdesk_teams WHERE id = ? AND location_id = ?', teamId, loc)) throw bad('Unbekanntes Team');
  if (userId === '') userId = null;
  if (teamId === '') teamId = null;
  if (userId === conv.assignee_id && teamId === conv.team_id) return conv;
  const at = now();
  app.db.run('UPDATE conversations SET assignee_id = ?, team_id = ?, assigned_at = ? WHERE id = ?', userId, teamId, userId ? at : null, conv.id);
  const next = getConv(app, loc, conv.id);
  const teamName = teamId ? (app.db.get<{ name: string }>('SELECT name FROM helpdesk_teams WHERE id = ?', teamId)?.name ?? '') : '';
  const what = userId ? `${userName(app, userId)}${teamName ? ` (${teamName})` : ''}` : teamName ? `Team ${teamName}` : 'niemand';
  addTimeline(app, next, 'assigned', {
    userId: who.userId,
    name: who.name,
    body: `${who.name} → ${what}${input.reason ? ` · ${input.reason}` : ''}`,
    data: { from: conv.assignee_id, to: userId, team_id: teamId, via: who.via, reason: input.reason ?? '' },
  });
  audit(app, who, next, 'inbox.assign', `${contactLabel(app, next)} → ${what}`);
  app.events.emit(loc, 'conversation.assigned', { contactId: next.contact_id, conversationId: next.id, assigneeId: userId, previousAssigneeId: conv.assignee_id, teamId, by: who.name, via: who.via, conversation: brief(app, next) });
  announce(app, next, 'assigned');
  const s = settingsOf(app, loc);
  if (userId && userId !== who.userId && userId !== conv.assignee_id && !input.quiet) {
    const label = contactLabel(app, next);
    if (s.notifications.assign_push) pushToUsers(app, [userId], `${who.name} hat dir eine Konversation zugewiesen`, `${label}${next.last_message ? ` – ${next.last_message}` : ''}`, next, `inbox-assign-${next.id}`);
    if (s.notifications.assign_email) {
      const u = agents.find((a) => a.id === userId);
      if (u?.email) track(app, notifyTeam(app, loc, `Konversation zugewiesen: ${label}`, `${who.name} hat dir die Konversation mit ${label} zugewiesen.\n\n${app.baseUrl()}${url(next)}`, u.email).catch(() => undefined));
    }
  }
  return next;
}

// --- status / snooze / priority ----------------------------------------------------------------

export interface StatusInput {
  status?: InboxStatus;
  /** ISO time to hide the conversation until; null clears. With `status`, "closed" clears a snooze. */
  snoozeUntil?: string | null;
  reason?: string;
}

export function setStatus(app: App, who: Who, conv: ConvRow, input: StatusInput): ConvRow {
  const loc = conv.location_id;
  const at = now();
  let status = input.status ?? conv.inbox_status;
  if (!isStatus(status)) throw bad('Unbekannter Status (open, waiting oder closed)');
  let snooze = input.snoozeUntil === undefined ? conv.snoozed_until : input.snoozeUntil;
  if (snooze) {
    const t = Date.parse(snooze);
    if (Number.isNaN(t)) throw bad('Zeitpunkt zum Zurückstellen ungültig');
    if (t <= Date.now()) throw bad('Der Zeitpunkt zum Zurückstellen liegt in der Vergangenheit');
    if (t > Date.now() + 366 * 864e5) throw bad('Höchstens ein Jahr zurückstellen');
    snooze = new Date(t).toISOString();
    if (status === 'closed') snooze = null;
  }
  if (status === 'closed') snooze = null;
  const snoozeChanged = (snooze ?? null) !== (conv.snoozed_until ?? null);
  const statusChanged = status !== conv.inbox_status;
  if (!statusChanged && !snoozeChanged) return conv;
  const patch: Record<string, any> = { inbox_status: status, snoozed_until: snooze ?? null, snoozed_at: snooze && (snoozeChanged || !conv.snoozed_at) ? at : snooze ? conv.snoozed_at : null };
  if (status === 'closed') {
    patch.closed_at = at;
    // Closing without an answer ends the answer timer; a missed deadline stays in the numbers.
    if (conv.awaiting_since) {
      if (conv.response_due_at && at > conv.response_due_at) {
        app.db.run(
          `INSERT INTO inbox_response_log (id, location_id, conversation_id, contact_id, kind, inbound_at, responded_at, responder_id, assignee_id, due_at, breached, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          id(), loc, conv.id, conv.contact_id, conv.awaiting_kind || 'first', conv.awaiting_since, at, who.userId, conv.assignee_id, conv.response_due_at, who.via === 'system' ? 'auto_closed' : 'closed',
        );
      }
      Object.assign(patch, { awaiting_since: null, awaiting_kind: '', response_due_at: null, response_warn_at: null, sla_state: '', sla_dirty: 0 });
    }
  } else if (conv.inbox_status === 'closed') patch.closed_at = null;
  app.db.update('conversations', conv.id, patch);
  const next = getConv(app, loc, conv.id);
  if (statusChanged) {
    addTimeline(app, next, 'status', { userId: who.userId, name: who.name, body: `Status: ${STATUS_LABEL[conv.inbox_status]} → ${STATUS_LABEL[status]}${input.reason ? ` · ${input.reason}` : ''}`, data: { from: conv.inbox_status, to: status, via: who.via, reason: input.reason ?? '' } });
    audit(app, who, next, 'inbox.status', `${contactLabel(app, next)}: ${STATUS_LABEL[status]}`);
  }
  if (snoozeChanged) {
    const until = snooze ? new Date(snooze).toLocaleString('de-DE', { timeZone: app.location(loc)?.timezone || 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    addTimeline(app, next, 'snooze', { userId: who.userId, name: who.name, body: snooze ? `Zurückgestellt bis ${until}` : 'Zurückstellen aufgehoben', data: { until: snooze, via: who.via } });
    audit(app, who, next, 'inbox.snooze', `${contactLabel(app, next)}: ${snooze ? `bis ${until}` : 'aufgehoben'}`);
  }
  app.events.emit(loc, 'conversation.status_changed', { contactId: next.contact_id, conversationId: next.id, status, previous: conv.inbox_status, snoozedUntil: snooze ?? null, by: who.name, via: who.via, reason: input.reason ?? '', conversation: brief(app, next) });
  announce(app, next, 'status');
  return next;
}

export function setPriority(app: App, who: Who, conv: ConvRow, priority: unknown): ConvRow {
  if (!isPriority(priority)) throw bad('Unbekannte Priorität (low, normal, high oder urgent)');
  if (priority === conv.priority) return conv;
  app.db.run('UPDATE conversations SET priority = ? WHERE id = ?', priority, conv.id);
  const next = getConv(app, conv.location_id, conv.id);
  addTimeline(app, next, 'priority', { userId: who.userId, name: who.name, body: `Priorität: ${PRIORITY_LABEL[conv.priority]} → ${PRIORITY_LABEL[priority]}`, data: { from: conv.priority, to: priority, via: who.via } });
  audit(app, who, next, 'inbox.priority', `${contactLabel(app, next)}: ${PRIORITY_LABEL[priority]}`);
  announce(app, next, 'priority');
  return next;
}

// --- internal notes ----------------------------------------------------------------------------

/**
 * Adds an internal note: visible to the team only, never sent to the contact. @mentions notify the person in the app
 * (the Erwähnungen view), by push and on the Android feed – and by e-mail unless the sub-account switched that off.
 */
export function addNote(app: App, who: Who, conv: ConvRow, raw: unknown): { note: TimelineRow; mentioned: string[] } {
  const text = String(raw ?? '').trim();
  if (!text) throw bad('Die Notiz ist leer');
  if (text.length > 10_000) throw bad('Die Notiz ist zu lang (höchstens 10.000 Zeichen)');
  const people = agentsOf(app, conv.location_id);
  const m = resolveMentions(text, people, who.userId);
  const note = addTimeline(app, conv, 'note', { userId: who.userId, name: who.name, body: m.body, mentions: m.ids });
  audit(app, who, conv, 'inbox.note', `${contactLabel(app, conv)}: Interne Notiz`);
  announce(app, conv, 'note');
  if (m.ids.length) {
    const s = settingsOf(app, conv.location_id);
    const label = contactLabel(app, conv);
    const plain = plainNote(m.body).replace(/\s+/g, ' ');
    pushToUsers(app, m.ids, `${who.name} hat dich in einer Notiz erwähnt`, `${label}: ${plain}`, conv, `inbox-mention-${note.id}`, 'high');
    if (s.notifications.mention_email) {
      for (const uid of m.ids) {
        const u = people.find((p) => p.id === uid);
        if (u?.email) track(app, notifyTeam(app, conv.location_id, `Erwähnung in einer internen Notiz: ${label}`, `${who.name} hat dich in einer internen Notiz zur Konversation mit ${label} erwähnt:\n\n${plainNote(m.body)}\n\n${app.baseUrl()}${url(conv)}`, u.email).catch(() => undefined));
      }
    }
  }
  return { note, mentioned: m.ids };
}

/** The person has seen their mentions in this conversation. */
export function markMentionsSeen(app: App, conv: ConvRow, userId: string) {
  app.db.run(
    `INSERT OR IGNORE INTO inbox_mention_seen (note_id, user_id, at)
     SELECT t.id, ?, ? FROM inbox_timeline t WHERE t.conversation_id = ? AND t.type = 'note' AND EXISTS (SELECT 1 FROM json_each(t.mentions) WHERE value = ?)`,
    userId,
    now(),
    conv.id,
    userId,
  );
}

export function deleteNote(app: App, who: Who, conv: ConvRow, noteId: string, canDeleteOthers: boolean) {
  const row = app.db.get<{ id: string; user_id: string | null }>(`SELECT id, user_id FROM inbox_timeline WHERE id = ? AND conversation_id = ? AND type = 'note'`, noteId, conv.id);
  if (!row) throw notFound('Notiz nicht gefunden');
  if (row.user_id !== who.userId && !canDeleteOthers) throw new HttpError(403, 'Nur die Autorin oder der Autor (oder ein Admin) darf die Notiz löschen');
  app.db.run('DELETE FROM inbox_timeline WHERE id = ?', row.id);
  announce(app, conv, 'note');
}

