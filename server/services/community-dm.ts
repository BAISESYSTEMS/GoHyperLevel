import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from './contacts.js';
import { applyWordFilter, groupSettings } from './community.js';
import { notify } from './community-actions.js';
import { extOf } from './community-ext.js';
import { notifyStaff } from './community-tiers.js';

/**
 * Direct messages between members (and from the team). Rules live here: who may write to whom (they must share a group in which
 * messages are on), blocking, limits per hour and per day, the word filter of the shared groups, notifications and the event for
 * workflows. A message from the team goes through the pseudo member `TEAM` ("Team").
 */

export const TEAM = '_team';
export const TEXT_MAX = 4000;

export interface Thread {
  id: string;
  location_id: string;
  contact_a: string;
  contact_b: string;
  created_at: string;
  last_message_at: string;
  last_preview: string;
}

export interface Message {
  id: string;
  thread_id: string;
  location_id: string;
  sender_id: string;
  sender_name: string;
  body: string;
  status: 'visible' | 'removed';
  created_at: string;
}

export const pairOf = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/** Groups two members both belong to (not banned) – the places a conversation may happen in. */
export function sharedGroups(app: App, locationId: string, x: string, y: string): any[] {
  return app.db
    .all<any>(
      `SELECT g.* FROM community_groups g
       JOIN community_members a ON a.group_id = g.id AND a.contact_id = ? AND a.banned_at IS NULL
       JOIN community_members b ON b.group_id = g.id AND b.contact_id = ? AND b.banned_at IS NULL
       WHERE g.location_id = ? AND g.status = 'active' ORDER BY g.position, g.created_at`,
      x,
      y,
      locationId,
    )
    .map((g) => parseJson(g, ['access', 'settings']));
}

/** Groups in which this member may use messages at all. */
export function dmGroups(app: App, locationId: string, contactId: string): any[] {
  return app.db
    .all<any>(`SELECT g.* FROM community_groups g JOIN community_members m ON m.group_id = g.id AND m.contact_id = ? AND m.banned_at IS NULL WHERE g.location_id = ? AND g.status = 'active'`, contactId, locationId)
    .map((g) => parseJson(g, ['access', 'settings']))
    .filter((g) => extOf(app, g.id).dms.enabled);
}

export function isBlocked(app: App, locationId: string, blocker: string, blocked: string): boolean {
  return !!app.db.get('SELECT 1 FROM community_blocks WHERE location_id = ? AND blocker_id = ? AND blocked_id = ?', locationId, blocker, blocked);
}

export function setBlocked(app: App, locationId: string, blocker: string, blocked: string, on: boolean) {
  if (on) app.db.run('INSERT OR IGNORE INTO community_blocks (location_id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)', locationId, blocker, blocked, now());
  else app.db.run('DELETE FROM community_blocks WHERE location_id = ? AND blocker_id = ? AND blocked_id = ?', locationId, blocker, blocked);
}

/** Why `from` may not write to `to` – or undefined when it is fine. */
export function whyNot(app: App, locationId: string, from: string, to: string): string | undefined {
  if (from === to) return 'Du kannst dir nicht selbst schreiben.';
  if (from === TEAM) return getContact(app, locationId, to) ? undefined : 'Dieses Mitglied gibt es nicht.';
  if (to === TEAM) return dmGroups(app, locationId, from).length ? undefined : 'Nachrichten sind in deinen Gruppen ausgeschaltet.';
  if (!getContact(app, locationId, to)) return 'Dieses Mitglied gibt es nicht.';
  const groups = sharedGroups(app, locationId, from, to).filter((g) => extOf(app, g.id).dms.enabled);
  if (!groups.length) return 'Nachrichten sind hier nicht möglich – ihr habt keine Gruppe gemeinsam, in der sie eingeschaltet sind.';
  if (isBlocked(app, locationId, to, from)) return 'Die Nachricht kann nicht zugestellt werden.';
  if (isBlocked(app, locationId, from, to)) return 'Du hast dieses Mitglied blockiert. Hebe die Blockierung auf, um zu schreiben.';
  return undefined;
}

export function threadOf(app: App, locationId: string, x: string, y: string): Thread | undefined {
  const [a, b] = pairOf(x, y);
  return app.db.get<Thread>('SELECT * FROM community_dm_threads WHERE location_id = ? AND contact_a = ? AND contact_b = ?', locationId, a, b);
}

function ensureThread(app: App, locationId: string, x: string, y: string): Thread {
  const cur = threadOf(app, locationId, x, y);
  if (cur) return cur;
  const [a, b] = pairOf(x, y);
  const row = { id: id(), location_id: locationId, contact_a: a, contact_b: b, created_at: now(), last_message_at: now(), last_preview: '' };
  app.db.insert('community_dm_threads', row);
  return row;
}

const previewOf = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);

function cleanBody(body: unknown): string {
  const s = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s) throw bad('Bitte eine Nachricht schreiben.');
  if (s.length > TEXT_MAX) throw bad(`Die Nachricht ist zu lang (höchstens ${TEXT_MAX} Zeichen).`);
  return s;
}

/** Limits: messages per hour, new conversations per day (the strictest shared group counts). */
function checkLimits(app: App, locationId: string, from: string, to: string, groups: any[]) {
  const perHour = Math.min(...groups.map((g) => extOf(app, g.id).dms.per_hour));
  const newPerDay = Math.min(...groups.map((g) => extOf(app, g.id).dms.new_per_day));
  const hour = app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_dm_messages WHERE location_id = ? AND sender_id = ? AND created_at > ?', locationId, from, new Date(Date.now() - 36e5).toISOString())!.n;
  if (hour >= perHour) throw new HttpError(429, `Du kannst höchstens ${perHour} Nachrichten pro Stunde schreiben – bitte später noch einmal.`);
  if (!threadOf(app, locationId, from, to)) {
    const day = app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_dm_threads t WHERE t.location_id = ? AND t.created_at > ? AND EXISTS (SELECT 1 FROM community_dm_messages m WHERE m.thread_id = t.id AND m.sender_id = ?)', locationId, new Date(Date.now() - 864e5).toISOString(), from)!.n;
    if (day >= newPerDay) throw new HttpError(429, `Du kannst höchstens ${newPerDay} neue Gespräche pro Tag beginnen.`);
  }
}

export interface Sent {
  message: Message;
  thread: Thread;
}

/** A member writes to a member (or to the team). */
export function sendDm(app: App, locationId: string, from: string, to: string, body: unknown, opts: { fromName?: string; skipLimits?: boolean; via?: string } = {}): Sent {
  const why = whyNot(app, locationId, from, to);
  if (why) throw new HttpError(403, why);
  let text = cleanBody(body);
  const groups = from === TEAM ? [] : to === TEAM ? dmGroups(app, locationId, from) : sharedGroups(app, locationId, from, to).filter((g) => extOf(app, g.id).dms.enabled);
  if (groups.length && !opts.skipLimits) checkLimits(app, locationId, from, to, groups);
  // The strictest word filter of the shared groups: a "block" refuses, a "mask" replaces.
  if (from !== TEAM) {
    for (const g of groups) {
      const s = groupSettings(g);
      const r = applyWordFilter(text, s.word_filter, s.filter_mode);
      if (r.blocked) throw bad('Deine Nachricht enthält Wörter, die hier nicht erlaubt sind.');
      text = r.text;
    }
  }
  const fromName = opts.fromName ?? (from === TEAM ? 'Team' : nameOf(app, locationId, from));
  const thread = ensureThread(app, locationId, from, to);
  const lastOwn = from !== TEAM && to === TEAM ? app.db.get<{ created_at: string }>('SELECT created_at FROM community_dm_messages WHERE thread_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1', thread.id, from)?.created_at : undefined;
  const msg: Message = { id: id(), thread_id: thread.id, location_id: locationId, sender_id: from, sender_name: fromName, body: text, status: 'visible', created_at: now() };
  app.db.tx(() => {
    app.db.insert('community_dm_messages', msg);
    app.db.run('UPDATE community_dm_threads SET last_message_at = ?, last_preview = ? WHERE id = ?', msg.created_at, previewOf(text), thread.id);
    // The sender has read everything up to here.
    markRead(app, thread.id, from, msg.created_at);
  });
  const next = { ...thread, last_message_at: msg.created_at, last_preview: previewOf(text) };
  if (to !== TEAM) {
    const g = groups[0] ?? dmGroups(app, locationId, to)[0];
    // One bell entry per thread until it has been read.
    if (g && !app.db.get(`SELECT 1 FROM community_notifications WHERE contact_id = ? AND kind = 'dm' AND post_id = ? AND read_at IS NULL`, to, thread.id)) {
      notify(app, g, [to], { kind: 'dm', postId: thread.id, actor: fromName, text: `${fromName}: ${previewOf(text).slice(0, 80)}` });
    }
    app.events.emit(locationId, 'community.dm_received', { contactId: to, from: { id: from === TEAM ? '' : from, name: fromName, team: from === TEAM }, message: { id: msg.id, text: previewOf(text) }, threadId: thread.id, ...(opts.via ? { viaWorkflow: opts.via } : {}) });
    if (from !== TEAM) logActivity(app, locationId, from, 'community.dm_sent', `Nachricht an ${nameOf(app, locationId, to)} geschrieben`);
  } else {
    // A member writes to the team: a workflow trigger and a line in the member's timeline; the team answers in the CRM.
    app.events.emit(locationId, 'community.dm_received', { contactId: from, from: { id: from, name: fromName, team: false }, toTeam: true, message: { id: msg.id, text: previewOf(text) }, threadId: thread.id });
    logActivity(app, locationId, from, 'community.dm_to_team', `Nachricht an das Community-Team: ${previewOf(text).slice(0, 80)}`);
    // The team gets one mail per member and hour, not one per line.
    if (!lastOwn || Date.parse(lastOwn) < Date.now() - 36e5) void notifyStaff(app, locationId, `Community: Nachricht von ${fromName}`, `${fromName} hat dem Team geschrieben:\n\n${text}\n\nAntworten kannst du im CRM am Kontakt (Community → Nachrichten).`);
  }
  return { message: msg, thread: next };
}

export function nameOf(app: App, locationId: string, contactId: string): string {
  if (contactId === TEAM) return 'Team';
  const pr = app.db.get<{ display_name: string }>('SELECT display_name FROM community_profiles WHERE location_id = ? AND contact_id = ?', locationId, contactId);
  if (pr?.display_name) return pr.display_name;
  const c = getContact(app, locationId, contactId);
  return [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Mitglied';
}

export function markRead(app: App, threadId: string, contactId: string, at = now()) {
  app.db.run(
    'INSERT INTO community_dm_reads (thread_id, contact_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(thread_id, contact_id) DO UPDATE SET last_read_at = MAX(community_dm_reads.last_read_at, excluded.last_read_at)',
    threadId,
    contactId,
    at,
  );
  app.db.run(`UPDATE community_notifications SET read_at = COALESCE(read_at, ?) WHERE contact_id = ? AND kind = 'dm' AND post_id = ?`, at, contactId, threadId);
}

/** Threads of a member with the other side, the preview and the unread count, newest first. */
export function inbox(app: App, locationId: string, contactId: string) {
  const rows = app.db.all<any>(
    `SELECT t.*, (SELECT COUNT(*) FROM community_dm_messages m WHERE m.thread_id = t.id AND m.sender_id != ? AND m.status = 'visible' AND m.created_at > COALESCE((SELECT last_read_at FROM community_dm_reads r WHERE r.thread_id = t.id AND r.contact_id = ?), '')) AS unread
     FROM community_dm_threads t WHERE t.location_id = ? AND (t.contact_a = ? OR t.contact_b = ?) AND EXISTS (SELECT 1 FROM community_dm_messages x WHERE x.thread_id = t.id AND x.status = 'visible') ORDER BY t.last_message_at DESC LIMIT 200`,
    contactId,
    contactId,
    locationId,
    contactId,
    contactId,
  );
  return rows.map((t) => ({ ...t, other: t.contact_a === contactId ? t.contact_b : t.contact_a }));
}

export function unreadCount(app: App, locationId: string, contactId: string): number {
  return app.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM community_dm_messages m JOIN community_dm_threads t ON t.id = m.thread_id
     WHERE t.location_id = ? AND (t.contact_a = ? OR t.contact_b = ?) AND m.sender_id != ? AND m.status = 'visible'
       AND m.created_at > COALESCE((SELECT last_read_at FROM community_dm_reads r WHERE r.thread_id = t.id AND r.contact_id = ?), '')`,
    locationId,
    contactId,
    contactId,
    contactId,
    contactId,
  )!.n;
}

export function messagesOf(app: App, threadId: string, since = '', limit = 200): Message[] {
  return app.db.all<Message>(`SELECT * FROM community_dm_messages WHERE thread_id = ? AND status = 'visible' AND created_at > ? ORDER BY created_at, rowid LIMIT ?`, threadId, since, limit);
}

// --- reports ------------------------------------------------------------------------------------------------------------------

export function reportMessage(app: App, locationId: string, reporter: string, messageId: string, reason: unknown) {
  const m = app.db.get<Message>('SELECT m.* FROM community_dm_messages m JOIN community_dm_threads t ON t.id = m.thread_id WHERE m.id = ? AND m.location_id = ? AND (t.contact_a = ? OR t.contact_b = ?)', messageId, locationId, reporter, reporter);
  if (!m) throw new HttpError(404, 'Nachricht nicht gefunden');
  if (m.sender_id === reporter) throw bad('Eigene Nachrichten kann man nicht melden.');
  const r = app.db.run(
    'INSERT OR IGNORE INTO community_dm_reports (id, location_id, thread_id, message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id(),
    locationId,
    m.thread_id,
    m.id,
    reporter,
    String(reason ?? '').trim().slice(0, 500),
    now(),
  );
  if (r.changes) logActivity(app, locationId, reporter, 'community.dm_reported', 'Eine Nachricht an das Team gemeldet');
  return { created: r.changes > 0 };
}
