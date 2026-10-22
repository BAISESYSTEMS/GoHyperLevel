import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound, str, type User } from '../core/http.js';
import { escapeHtml, textToHtml } from '../core/template.js';
import { id, now, uniq } from '../core/util.js';
import { getBranding } from '../modules/agency.js';
import { createLocation } from '../modules/core.js';
import { upsertContact } from './contacts.js';
import { deliverEmail } from './messaging.js';
import {
  CATEGORY_OF,
  EXT,
  FEEDBACK_CATEGORIES,
  PIPELINE_NAME,
  STAGE_IDS,
  feedbackStages,
  parseScreenshot,
  publicStatus,
  severityPriority,
  statusKey,
  subjectOf,
  type Diagnostics,
  type FeedbackKind,
  type StatusKey,
} from './feedback.js';
import { addTicketEvent, createTicket, getTicketRow, loadHelpdeskSettings, saveHelpdeskSettings, ticketPipelines, updateTicket, type Actor } from './tickets.js';

/**
 * Data layer of „Fehler & Wünsche“: every report, wish and automatically captured error is a
 * ticket in the agency's support sub-account (pipeline „Fehler & Wünsche“) plus one row in
 * feedback_items with what the helpdesk has no column for (kind, diagnostics, votes, version,
 * occurrences). Reporters are linked by user id and get a contact (by login email) in the support
 * sub-account – they never get access to the sub-account itself.
 */

// --- agency settings ---------------------------------------------------------------------------

export interface FeedbackSettings {
  /** Sub-account whose tickets receive the reports ('' = create "<Marke> Support" on first use). */
  support_location_id: string;
  /** Pipeline id per support sub-account. */
  pipelines: Record<string, string>;
  /** Record unexpected server errors (5xx) as grouped tickets. */
  capture_server: boolean;
  /** Accept automatically sent browser/app errors (each user still opts in). */
  capture_client: boolean;
}

const DEFAULTS: FeedbackSettings = { support_location_id: '', pipelines: {}, capture_server: true, capture_client: true };

export function loadFeedbackSettings(app: App): FeedbackSettings {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'feedback');
  let v: any = {};
  try {
    v = row ? JSON.parse(row.value) : {};
  } catch {
    v = {};
  }
  return { ...DEFAULTS, ...v, pipelines: { ...(v.pipelines ?? {}) } };
}

export function saveFeedbackSettings(app: App, s: FeedbackSettings) {
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'feedback', JSON.stringify(s));
}

/** The pipeline „Fehler & Wünsche“ in a sub-account (created once), plus categories and a shared saved view. */
export function ensurePipeline(app: App, locationId: string): string {
  const { db } = app;
  const s = loadFeedbackSettings(app);
  let pid = s.pipelines[locationId];
  if (!pid || !db.get('SELECT id FROM ticket_pipelines WHERE id = ? AND location_id = ?', pid, locationId)) {
    pid = db.get('SELECT id FROM ticket_pipelines WHERE location_id = ? AND name = ?', locationId, PIPELINE_NAME)?.id;
    if (!pid) {
      // The default "Support" pipeline stays first; ours comes after it.
      ticketPipelines(app, locationId);
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM ticket_pipelines WHERE location_id = ?', locationId)!.n;
      pid = id();
      db.insert('ticket_pipelines', { id: pid, location_id: locationId, name: PIPELINE_NAME, stages: feedbackStages(), position: pos, created_at: now(), updated_at: now() });
    }
    saveFeedbackSettings(app, { ...loadFeedbackSettings(app), pipelines: { ...loadFeedbackSettings(app).pipelines, [locationId]: pid } });
  }
  const hs = loadHelpdeskSettings(app, locationId);
  const missing = FEEDBACK_CATEGORIES.filter((c) => !hs.categories.includes(c));
  if (missing.length) saveHelpdeskSettings(app, locationId, { ...hs, categories: [...hs.categories, ...missing] });
  for (const [name, filters] of [
    [PIPELINE_NAME, { pipeline_id: pid, state: 'open' }],
    ['Automatisch erfasste Fehler', { pipeline_id: pid, tag: 'auto-fehler', state: 'open' }],
  ] as const) {
    if (!db.get('SELECT 1 FROM helpdesk_views WHERE location_id = ? AND name = ? AND user_id IS NULL', locationId, name))
      db.insert('helpdesk_views', { id: id(), location_id: locationId, user_id: null, name, filters, created_at: now() });
  }
  return pid;
}

/** The support sub-account (created as "<Marke> Support" on first use) and its pipeline. */
export function ensureSupport(app: App): { locationId: string; pipelineId: string; created: boolean } {
  const s = loadFeedbackSettings(app);
  let loc = s.support_location_id && app.location(s.support_location_id) ? s.support_location_id : '';
  let created = false;
  if (!loc) {
    const brand = getBranding(app).name || 'HyperLevel';
    const row = createLocation(app.db, `${brand} Support`, 'Europe/Berlin');
    loc = row.id;
    created = true;
    // A fresh support desk: no satisfaction survey after every fixed bug.
    const hs = loadHelpdeskSettings(app, loc);
    saveHelpdeskSettings(app, loc, { ...hs, csat: { ...hs.csat, enabled: false } });
    saveFeedbackSettings(app, { ...loadFeedbackSettings(app), support_location_id: loc });
  }
  return { locationId: loc, pipelineId: ensurePipeline(app, loc), created };
}

/** Version of the server and the built web app (asset hash), for diagnostics. */
let versionCache: { version: string; web_build: string } | undefined;
export function serverVersion(app: App) {
  if (versionCache) return versionCache;
  let version = process.env.PGHL_VERSION ?? '';
  try {
    if (!version) version = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version ?? '';
  } catch {
    /* no package.json next to the server */
  }
  if (process.env.PGHL_BUILD) version = `${version}+${process.env.PGHL_BUILD}`;
  let webBuild = '';
  try {
    webBuild = readFileSync(join(app.config.webDir, 'index.html'), 'utf8').match(/\/assets\/index-([\w-]+)\.js/)?.[1] ?? '';
  } catch {
    /* not built */
  }
  versionCache = { version: version || 'dev', web_build: webBuild };
  return versionCache;
}

// --- items -------------------------------------------------------------------------------------------

export interface FeedbackRow {
  id: string;
  kind: FeedbackKind;
  ticket_id: string;
  support_location_id: string;
  user_id: string | null;
  origin_location_id: string | null;
  title: string;
  body: string;
  expected: string;
  steps: string;
  severity: string;
  area: string;
  platform: string;
  diagnostics: Diagnostics & { samples?: any[] };
  fingerprint: string | null;
  occurrences: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  votes: number;
  version: string;
  public_note: string;
  fixed_at: string | null;
  duplicate_of: string | null;
  hidden: number;
  created_at: string;
  updated_at: string;
  [k: string]: any;
}

export const getItem = (app: App, itemId: string): FeedbackRow | undefined => parseJson(app.db.get('SELECT * FROM feedback_items WHERE id = ?', itemId), ['diagnostics']) as any;
export const itemByTicket = (app: App, ticketId: string): FeedbackRow | undefined => parseJson(app.db.get('SELECT * FROM feedback_items WHERE ticket_id = ?', ticketId), ['diagnostics']) as any;
export const ticketOf = (app: App, f: FeedbackRow) => getTicketRow(app, f.support_location_id, f.ticket_id);

/** An item by id, ticket id or ticket number ("#42", in the current support sub-account). */
export function findItem(app: App, ref: string): FeedbackRow | undefined {
  const raw = String(ref ?? '').trim();
  if (!raw) return undefined;
  const n = raw.replace(/^#/, '');
  if (/^\d{1,9}$/.test(n)) {
    const loc = loadFeedbackSettings(app).support_location_id;
    const t = app.db.get('SELECT f.id FROM feedback_items f JOIN tickets t ON t.id = f.ticket_id WHERE t.number = ? AND (t.location_id = ? OR ? = \'\') ORDER BY f.created_at DESC', Number(n), loc, loc);
    if (t) return getItem(app, t.id);
  }
  return getItem(app, raw) ?? itemByTicket(app, raw);
}

/** Follows "Duplikat von …" to the item that is worked on. */
export function canonical(app: App, f: FeedbackRow): FeedbackRow {
  let cur = f;
  for (let i = 0; i < 10 && cur.duplicate_of; i++) {
    const next = getItem(app, cur.duplicate_of);
    if (!next) break;
    cur = next;
  }
  return cur;
}

const splitName = (name: string) => {
  const parts = String(name ?? '').trim().split(/\s+/);
  return { first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') };
};

/** The reporter as contact of the support sub-account (by login email), without workflows firing. */
export function reporterContact(app: App, locationId: string, user: { email: string; name: string }): string | null {
  if (!user.email) return null;
  return upsertContact(app, locationId, { email: user.email, ...splitName(user.name) }, { source: 'GoHigh-App', tags: ['GoHigh-Nutzer'], quiet: true }).contact.id;
}

const ROLE_LABEL = (u: Pick<User, 'role' | 'permissions'>) => (u.role === 'admin' ? 'Agentur-Admin' : u.permissions ? 'Kunden-Login (eingeschränkt)' : 'Kunden-Login');
export const roleLabel = ROLE_LABEL;

export interface NewItem {
  kind: FeedbackKind;
  user?: User | null;
  originLocationId?: string | null;
  title?: unknown;
  body?: unknown;
  expected?: unknown;
  steps?: unknown;
  severity?: string;
  area?: string;
  platform?: string;
  diagnostics?: Diagnostics;
  screenshot?: unknown;
  /** Auto capture: grouping key and priority. */
  fingerprint?: string;
  priority?: string;
  tags?: string[];
}

export function saveFile(app: App, feedbackId: string, userId: string | null, dataUrl: unknown) {
  const { mime, buf } = parseScreenshot(dataUrl);
  const dir = join(app.config.dataDir, 'feedback');
  mkdirSync(dir, { recursive: true });
  const fileId = id();
  const file = `${id(20)}.${EXT[mime]}`;
  writeFileSync(join(dir, file), buf);
  app.db.insert('feedback_files', { id: fileId, feedback_id: feedbackId, user_id: userId, mime, size: buf.length, file, created_at: now() });
  return { id: fileId, mime, size: buf.length };
}

export function readFile(app: App, fileRow: any): Buffer | null {
  const path = join(app.config.dataDir, 'feedback', String(fileRow.file).replace(/[^\w.-]/g, ''));
  return existsSync(path) ? readFileSync(path) : null;
}

const SEVERITY_TEXT: Record<string, string> = { gering: 'Kleinigkeit', mittel: 'Stört bei der Arbeit', hoch: 'Blockiert mich', kritisch: 'Kritisch' };

/** Creates the ticket in the support sub-account and the feedback row. */
export function createItem(app: App, input: NewItem): FeedbackRow {
  const { db } = app;
  const support = ensureSupport(app);
  const loc = support.locationId;
  const user = input.user ?? null;
  const kind = input.kind;
  const body = str(input.body, kind === 'wish' ? 'Beschreibung' : 'Was ist passiert?', { max: 20_000 });
  const expected = str(input.expected, 'Was hast du erwartet?', { max: 10_000 });
  const steps = str(input.steps, 'Schritte', { max: 10_000 });
  let title = str(input.title, 'Titel', { max: 200 });
  if (!title) title = subjectOf(body);
  if (!title) throw bad(kind === 'wish' ? 'Titel fehlt' : 'Bitte beschreibe kurz, was passiert ist');
  const origin = input.originLocationId ? app.location(input.originLocationId) : undefined;
  const severity = kind === 'bug' ? input.severity || 'mittel' : '';
  const diag = input.diagnostics ?? {};
  const contactId = user && kind !== 'auto' ? reporterContact(app, loc, user) : null;

  const lines: string[] = [];
  if (kind === 'auto') lines.push(body);
  else {
    lines.push(body || title);
    if (expected) lines.push('', 'Erwartet:', expected);
    if (steps) lines.push('', 'Schritte:', steps);
    lines.push('', '—');
    if (user) lines.push(`Gemeldet von ${user.name || user.email} (${ROLE_LABEL(user)})${origin ? ` · Sub-Account „${origin.name}“` : ''}`);
    const where = [diag.route || diag.url ? `Seite: ${diag.route || diag.url}` : '', severity ? `Schweregrad: ${SEVERITY_TEXT[severity] ?? severity}` : '', input.area && kind === 'wish' ? `Bereich: ${input.area}` : '', input.platform === 'android' ? 'aus der Android-App' : ''].filter(Boolean);
    if (where.length) lines.push(where.join(' · '));
  }
  const tags = uniq([...(input.tags ?? []), kind === 'bug' ? 'fehlermeldung' : kind === 'wish' ? 'wunsch' : kind === 'question' ? 'frage' : 'auto-fehler', ...(input.platform === 'android' ? ['android'] : [])]);
  const ticket = createTicket(
    app,
    loc,
    {
      subject: title,
      description: lines.join('\n'),
      contact_id: contactId,
      priority: input.priority ?? (kind === 'bug' ? severityPriority(severity) : kind === 'wish' ? 'niedrig' : 'normal'),
      category: CATEGORY_OF[kind],
      tags,
      pipeline_id: support.pipelineId,
      stage_id: 'neu',
      source: 'App',
      channel: contactId ? 'email' : '',
    },
    { userId: user?.id ?? null, via: user ? 'user' : 'system' },
  );
  // Wishes have no deadline for being built – only the first answer keeps its SLA.
  if (kind === 'wish') db.run('UPDATE tickets SET resolution_due_at = NULL, resolution_warn_at = NULL WHERE id = ?', ticket.id);
  const at = now();
  const row: Record<string, any> = {
    id: id(),
    kind,
    ticket_id: ticket.id,
    support_location_id: loc,
    user_id: user?.id ?? null,
    origin_location_id: origin?.id ?? null,
    title,
    body,
    expected,
    steps,
    severity,
    area: kind === 'wish' ? (input.area ?? 'Sonstiges') : '',
    platform: input.platform ?? 'web',
    diagnostics: diag,
    fingerprint: input.fingerprint ?? null,
    occurrences: 1,
    first_seen_at: at,
    last_seen_at: at,
    votes: 0,
    version: '',
    public_note: '',
    hidden: 0,
    created_at: at,
    updated_at: at,
  };
  db.insert('feedback_items', row);
  if (user) link(app, row.id, user.id, origin?.id ?? null, kind === 'auto' ? 'affected' : 'reporter');
  if (kind === 'wish' && user) vote(app, row.id, user.id, true);
  if (input.screenshot) saveFile(app, row.id, user?.id ?? null, input.screenshot);
  return getItem(app, row.id)!;
}

export function link(app: App, feedbackId: string, userId: string, locationId: string | null, role: 'reporter' | 'affected') {
  app.db.run(
    `INSERT INTO feedback_links (feedback_id, user_id, location_id, role, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(feedback_id, user_id) DO UPDATE SET role = CASE WHEN feedback_links.role = 'reporter' THEN 'reporter' ELSE excluded.role END`,
    feedbackId,
    userId,
    locationId,
    role,
    now(),
  );
}

export function vote(app: App, feedbackId: string, userId: string, on: boolean) {
  if (on) app.db.run('INSERT OR IGNORE INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)', feedbackId, userId, now());
  else app.db.run('DELETE FROM feedback_votes WHERE feedback_id = ? AND user_id = ?', feedbackId, userId);
  recount(app, feedbackId);
}
const recount = (app: App, feedbackId: string) => app.db.run('UPDATE feedback_items SET votes = (SELECT COUNT(*) FROM feedback_votes WHERE feedback_id = ?) WHERE id = ?', feedbackId, feedbackId);

export const isLinked = (app: App, feedbackId: string, userId: string) => !!app.db.get('SELECT 1 FROM feedback_links WHERE feedback_id = ? AND user_id = ?', feedbackId, userId);

/** Status of an item as the reporter sees it. */
export function statusOf(app: App, f: FeedbackRow, t = ticketOf(app, f)) {
  if (!t) return { key: 'abgelehnt' as StatusKey, board: f.kind === 'wish' ? 'declined' : '', label: 'Entfernt', tone: 'gray', done: true };
  return publicStatus(f.kind, t.stage_id, t.status_kind);
}

// --- public thread -----------------------------------------------------------------------------------

const stripHtml = (s: string) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

/**
 * What a reporter (or, for wishes, everyone) may read: the team's replies, comments, status changes
 * and „Behoben in Version …“ – never internal notes, assignments or SLA events.
 */
export function publicThread(app: App, f: FeedbackRow, viewer: { id: string; role: string }) {
  const admin = viewer.role === 'admin';
  const rows = app.db.all(
    `SELECT e.*, u.name AS user_name, u.role AS user_role FROM ticket_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.ticket_id = ? AND e.type IN ('reply', 'customer_reply', 'status', 'released') ORDER BY e.created_at, e.rowid`,
    f.ticket_id,
  );
  return rows.map((e) => {
    const d = parseJson(e, ['data']).data ?? {};
    if (e.type === 'status') {
      const to = publicStatus(f.kind, d.to, d.kind);
      return { id: e.id, type: 'status', label: to.label, status: to.key, at: e.created_at };
    }
    if (e.type === 'released') return { id: e.id, type: 'status', label: e.body, status: 'behoben', at: e.created_at };
    if (e.type === 'reply') return { id: e.id, type: 'team', body: stripHtml(e.body), author: admin ? (e.user_name ?? 'Team') : 'Team', at: e.created_at };
    const uid = d.user_id ?? null;
    const mine = !!uid && uid === viewer.id;
    const authorRole = uid ? app.db.get('SELECT role, name FROM users WHERE id = ?', uid) : null;
    const author = mine ? 'Du' : admin ? (d.user_name ?? authorRole?.name ?? 'Melder') : authorRole?.role === 'admin' ? 'Team' : f.kind === 'wish' ? 'Nutzer' : 'Melder';
    return { id: e.id, type: authorRole?.role === 'admin' && !mine && f.kind === 'wish' ? 'team' : 'user', body: e.body, author, mine, at: e.created_at };
  });
}

/** A comment (wish) or more information (report) from a user – lands on the ticket timeline. */
export function addUserMessage(app: App, f: FeedbackRow, user: User, body: unknown, screenshot?: unknown) {
  const text = str(body, 'Nachricht', { required: !screenshot, max: 10_000 }) || '(Screenshot)';
  const t = ticketOf(app, f);
  if (!t) throw notFound('Diese Meldung gibt es nicht mehr');
  let fileNote = '';
  if (screenshot) {
    saveFile(app, f.id, user.id, screenshot);
    fileNote = '\n\n[Screenshot angehängt]';
  }
  const ev = addTicketEvent(app, t, 'customer_reply', { body: `${text}${fileNote}`, data: { user_id: user.id, user_name: user.name, channel: 'app', via: 'feedback' } });
  app.db.run('UPDATE tickets SET last_customer_at = ?, updated_at = ? WHERE id = ?', now(), now(), t.id);
  app.db.run('UPDATE feedback_items SET updated_at = ? WHERE id = ?', now(), f.id);
  if (t.owner_id && t.owner_id !== user.id) void Promise.resolve(app.services.pushNotify?.({ userIds: [t.owner_id], kind: 'feedback', title: `Neue Info zu Ticket #${t.number}`, body: text.slice(0, 160), url: `/app/tickets/${t.id}`, tag: `ticket-${t.id}` })).catch(() => {});
  return ev;
}

// --- notifications -------------------------------------------------------------------------------------

export interface Notice {
  title: string;
  body?: string;
  /** Path in the web app. */
  url: string;
  kind: string;
  /** Send an email too (status changes, replies that did not already go out by email). */
  email?: boolean;
  /** Users who already got this by email (the ticket's contact after an email reply). */
  skipEmail?: string[];
}

/** Who hears about an item: reporters (bugs, questions), opted-in affected users (auto), author + voters (wishes). */
export function audienceOf(app: App, f: FeedbackRow, opts: { autoFixed?: boolean; wishAll?: boolean } = {}): string[] {
  const { db } = app;
  if (f.kind === 'wish') {
    const ids = db.all('SELECT user_id FROM feedback_links WHERE feedback_id = ? AND role = ?', f.id, 'reporter').map((r) => r.user_id as string);
    if (opts.wishAll !== false) ids.push(...db.all('SELECT user_id FROM feedback_votes WHERE feedback_id = ?', f.id).map((r) => r.user_id as string));
    return uniq(ids);
  }
  if (f.kind === 'auto') return opts.autoFixed ? db.all(`SELECT user_id FROM feedback_links WHERE feedback_id = ?`, f.id).map((r) => r.user_id as string).filter((u) => autoCaptureOn(app, u)) : [];
  return db.all('SELECT user_id FROM feedback_links WHERE feedback_id = ?', f.id).map((r) => r.user_id as string);
}

export function prefsOf(app: App, userId: string) {
  return app.db.get('SELECT * FROM feedback_prefs WHERE user_id = ?', userId) ?? null;
}
/** Automatic error reports: per user, on by default for agency admins. */
export function autoCaptureOn(app: App, userId: string): boolean {
  const p = prefsOf(app, userId);
  if (p && p.auto_capture !== null && p.auto_capture !== undefined) return !!p.auto_capture;
  return app.db.get('SELECT role FROM users WHERE id = ?', userId)?.role === 'admin';
}

/** In-app notification + push + mobile feed (+ email) for these users. */
export async function notifyUsers(app: App, f: FeedbackRow, userIds: string[], n: Notice) {
  const { db } = app;
  const users = uniq(userIds).map((u) => db.get('SELECT id, name, email, role, locations FROM users WHERE id = ?', u)).filter(Boolean) as any[];
  if (!users.length) return 0;
  const at = now();
  for (const u of users) {
    const nid = id();
    db.insert('feedback_notifications', { id: nid, user_id: u.id, feedback_id: f.id, kind: n.kind, title: n.title.slice(0, 200), body: String(n.body ?? '').slice(0, 500), url: n.url, read_at: null, created_at: at });
    db.run(`DELETE FROM feedback_notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM feedback_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200)`, u.id, u.id);
    // Android: the feed is per sub-account – use the one the report came from (or the user's first).
    const loc = db.get('SELECT location_id FROM feedback_links WHERE feedback_id = ? AND user_id = ?', f.id, u.id)?.location_id || (u.role === 'admin' ? db.get('SELECT id FROM locations ORDER BY created_at LIMIT 1')?.id : JSON.parse(u.locations || '[]')[0]);
    if (loc && app.location(loc)) app.services.mobileFeed?.({ locationId: loc, type: 'feedback', area: '', userId: u.id, title: n.title, body: n.body ?? '', link: n.url, ref: `feedback:${nid}` });
  }
  await Promise.resolve(app.services.pushNotify?.({ userIds: users.map((u) => u.id), kind: 'feedback', title: n.title, body: n.body ?? '', url: n.url, tag: `feedback-${f.id}` })).catch((e: Error) => console.error('[feedback] push', e.message));
  if (n.email) {
    const loc = app.location(f.support_location_id);
    const brand = getBranding(app).name || 'HyperLevel';
    const send = app.services.feedbackMailer ?? deliverEmail;
    for (const u of users) {
      if (!u.email || n.skipEmail?.includes(u.id)) continue;
      const p = prefsOf(app, u.id);
      if (p && p.email === 0) continue;
      const text = `Hallo ${String(u.name || '').split(' ')[0] || ''},\n\n${n.title}${n.body ? `\n\n${n.body}` : ''}\n\nAlle Details: ${app.baseUrl()}${n.url}\n\nViele Grüße\n${brand}`;
      try {
        if (loc) await send(loc, { to: u.email, subject: n.title, text, html: textToHtml(text).replace(escapeHtml(`${app.baseUrl()}${n.url}`), `<a href="${escapeHtml(`${app.baseUrl()}${n.url}`)}">${escapeHtml(`${app.baseUrl()}${n.url}`)}</a>`) });
      } catch (e) {
        console.error('[feedback] mail', (e as Error).message);
      }
    }
  }
  return users.length;
}

export const urlOf = (f: FeedbackRow) => (f.kind === 'wish' ? `/app/wishes/${f.id}` : `/app/feedback/${f.id}`);
export const numberOf = (app: App, f: FeedbackRow) => ticketOf(app, f)?.number ?? 0;

/** Notice text for a status change. */
export function statusNotice(app: App, f: FeedbackRow, key: StatusKey): Notice {
  const st = publicStatus(f.kind, key, null);
  const nr = numberOf(app, f);
  const version = f.version && (key === 'behoben' || key === 'ausgeliefert') ? f.version : '';
  if (f.kind === 'wish') {
    const title = key === 'ausgeliefert' || key === 'behoben' ? `Wunsch umgesetzt: „${f.title}“${version ? ` (Version ${version})` : ''}` : `Wunsch „${f.title}“: ${st.label}`;
    return { kind: 'status', title, body: key === 'abgelehnt' && f.public_note ? `Begründung: ${f.public_note}` : version && f.public_note ? f.public_note : '', url: urlOf(f), email: true };
  }
  const title = version ? `Meldung #${nr}: Behoben in Version ${version}` : `Meldung #${nr}: ${st.label}`;
  const body = [f.kind === 'auto' ? 'Ein Fehler, der bei dir aufgetreten ist, wurde behoben.' : `„${f.title}“`, key === 'abgelehnt' && f.public_note ? `Begründung: ${f.public_note}` : version && f.public_note ? f.public_note : ''].filter(Boolean).join('\n');
  return { kind: 'status', title, body, url: urlOf(f), email: true };
}

/** Called for every ticket status change (helpdesk event): tells the right people. */
export async function onStatusChanged(app: App, ticketId: string, stageId: string, kind: string, skipUser?: string) {
  const f = itemByTicket(app, ticketId);
  if (!f || f.duplicate_of) return;
  const key = statusKey(stageId, kind);
  const done = key === 'behoben' || key === 'ausgeliefert';
  app.db.run('UPDATE feedback_items SET updated_at = ?, fixed_at = CASE WHEN ? THEN COALESCE(fixed_at, ?) ELSE fixed_at END WHERE id = ?', now(), done ? 1 : 0, now(), f.id);
  const fresh = getItem(app, f.id)!;
  const users = audienceOf(app, fresh, { autoFixed: done }).filter((u) => u !== skipUser);
  if (users.length) await notifyUsers(app, fresh, users, statusNotice(app, fresh, key));
}

// --- triage actions ------------------------------------------------------------------------------------

const stageNow = (app: App, f: FeedbackRow) => {
  const t = ticketOf(app, f);
  return t ? statusKey(t.stage_id, t.status_kind) : undefined;
};

/** Moves the ticket to one of our stages (other pipelines: by kind). Notifications follow from the status event. */
export function setStatus(app: App, f: FeedbackRow, key: StatusKey, actor: Actor, opts: { reason?: string; note?: string } = {}) {
  const t = ticketOf(app, f);
  if (!t) throw notFound('Ticket nicht gefunden');
  if (key === 'duplikat') throw bad('„Duplikat“ bitte über „Als Duplikat von …“ setzen');
  if (opts.reason !== undefined) app.db.run('UPDATE feedback_items SET public_note = ?, updated_at = ? WHERE id = ?', str(opts.reason, 'Begründung', { max: 2000 }), now(), f.id);
  const pipe = app.db.get('SELECT stages FROM ticket_pipelines WHERE id = ?', t.pipeline_id);
  const stages: any[] = pipe ? JSON.parse(pipe.stages) : [];
  const target = stages.find((s) => s.id === key)?.id ?? stages.find((s) => s.kind === feedbackStages().find((x) => x.id === key)!.kind)?.id;
  if (!target) throw bad('Diese Stufe gibt es in der Pipeline des Tickets nicht');
  return updateTicket(app, f.support_location_id, t.id, { status: target, ...(opts.note ? { note: opts.note } : {}) }, actor);
}

/** A public answer from the team (visible to the reporter / on the wish) + notification incl. email. */
export async function publicReply(app: App, f: FeedbackRow, body: unknown, actor: Actor) {
  const text = str(body, 'Antwort', { required: true, max: 20_000 });
  const t = ticketOf(app, f);
  if (!t) throw notFound('Ticket nicht gefunden');
  addTicketEvent(app, t, 'reply', { body: text, userId: actor.userId ?? null, data: { channel: 'app', status: 'sent', via: actor.via ?? 'user' } });
  app.db.run('UPDATE tickets SET last_agent_at = ?, first_response_at = COALESCE(first_response_at, ?), updated_at = ? WHERE id = ?', now(), now(), now(), t.id);
  // Neu → Bestätigt after the first answer, like the helpdesk does.
  if (t.status_kind === 'new' && t.pipeline_id === loadFeedbackSettings(app).pipelines[f.support_location_id]) updateTicket(app, f.support_location_id, t.id, { status: 'bestaetigt' }, actor);
  await notifyReply(app, f, text, []);
}

export async function notifyReply(app: App, f: FeedbackRow, text: string, alreadyMailed: string[]) {
  const users = audienceOf(app, f, { wishAll: false });
  if (!users.length) return 0;
  const nr = numberOf(app, f);
  const title = f.kind === 'wish' ? `Antwort zu deinem Wunsch „${f.title}“` : `Antwort auf deine Meldung #${nr}`;
  return notifyUsers(app, f, users, { kind: 'reply', title, body: stripHtml(text).slice(0, 300), url: urlOf(f), email: true, skipEmail: alreadyMailed });
}

/** „Behoben in Version …“: version (+ public changelog line), stage Behoben/Ausgeliefert, everyone linked hears about it. */
export async function markFixed(app: App, f: FeedbackRow, input: { version: unknown; note?: unknown; shipped?: boolean }, actor: Actor) {
  const version = str(input.version, 'Version', { required: true, max: 40 });
  const note = input.note === undefined ? undefined : str(input.note, 'Text für „Was ist neu“', { max: 500 });
  const t = ticketOf(app, f);
  if (!t) throw notFound('Ticket nicht gefunden');
  app.db.run('UPDATE feedback_items SET version = ?, public_note = COALESCE(?, public_note), fixed_at = ?, updated_at = ? WHERE id = ?', version, note ?? null, now(), now(), f.id);
  const key: StatusKey = input.shipped === false ? 'behoben' : 'ausgeliefert';
  addTicketEvent(app, t, 'released', { body: `${f.kind === 'wish' ? 'Umgesetzt' : 'Behoben'} in Version ${version}`, userId: actor.userId ?? null, data: { version, via: actor.via ?? 'user' } });
  const before = stageNow(app, f);
  if (before === key) {
    const fresh = getItem(app, f.id)!;
    const users = audienceOf(app, fresh, { autoFixed: true });
    if (users.length) await notifyUsers(app, fresh, users, statusNotice(app, fresh, key));
  } else setStatus(app, getItem(app, f.id)!, key, actor);
  return getItem(app, f.id)!;
}

/** „Als Duplikat von …“: reporters, votes and occurrences move to the target; the duplicate closes. */
export async function markDuplicate(app: App, f: FeedbackRow, target: FeedbackRow, actor: Actor) {
  const { db } = app;
  const into = canonical(app, target);
  if (into.id === f.id) throw bad('Ein Eintrag kann kein Duplikat von sich selbst sein');
  if (f.duplicate_of) throw bad('Schon als Duplikat markiert');
  const src = ticketOf(app, f);
  const dst = ticketOf(app, into);
  if (!src || !dst) throw notFound('Ticket nicht gefunden');
  const moved = audienceOf(app, f, { autoFixed: true, wishAll: true });
  db.tx(() => {
    db.run('UPDATE feedback_items SET duplicate_of = ?, updated_at = ? WHERE id = ?', into.id, now(), f.id);
    db.run(`INSERT OR IGNORE INTO feedback_links (feedback_id, user_id, location_id, role, created_at) SELECT ?, user_id, location_id, role, ? FROM feedback_links WHERE feedback_id = ?`, into.id, now(), f.id);
    if (into.kind === 'wish' || f.kind === 'wish') {
      db.run('INSERT OR IGNORE INTO feedback_votes (feedback_id, user_id, created_at) SELECT ?, user_id, created_at FROM feedback_votes WHERE feedback_id = ?', into.id, f.id);
      if (f.user_id) db.run('INSERT OR IGNORE INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)', into.id, f.user_id, now());
      db.run('DELETE FROM feedback_votes WHERE feedback_id = ?', f.id);
      recount(app, f.id);
      recount(app, into.id);
    }
    db.run(
      `UPDATE feedback_items SET occurrences = occurrences + ?, first_seen_at = MIN(COALESCE(first_seen_at, ?), ?), last_seen_at = MAX(COALESCE(last_seen_at, ?), ?), updated_at = ? WHERE id = ?`,
      f.kind === 'auto' && into.kind === 'auto' ? f.occurrences : 0,
      f.first_seen_at ?? now(), f.first_seen_at ?? now(), f.last_seen_at ?? now(), f.last_seen_at ?? now(), now(), into.id,
    );
  });
  addTicketEvent(app, dst, 'note', { body: `Ticket #${src.number} „${f.title}“ als Duplikat hierher zusammengeführt.`, userId: actor.userId ?? null, data: { duplicate: f.id } });
  const pipe = db.get('SELECT stages FROM ticket_pipelines WHERE id = ?', src.pipeline_id);
  const dupStage = (pipe ? JSON.parse(pipe.stages) : []).find((s: any) => s.id === 'duplikat')?.id ?? 'closed';
  updateTicket(app, f.support_location_id, src.id, { status: dupStage, note: `Duplikat von Ticket #${dst.number} „${into.title}“` }, actor);
  if (moved.length) {
    const what = f.kind === 'wish' ? 'Dein Wunsch' : 'Deine Meldung';
    await notifyUsers(app, getItem(app, into.id)!, moved, { kind: 'duplicate', title: `${what} #${src.number} wurde mit #${dst.number} zusammengeführt`, body: `Weiter geht es bei „${into.title}“ – du wirst dort informiert.`, url: urlOf(into), email: false });
  }
  return getItem(app, into.id)!;
}

/** Ticket stage keys a wish board column covers (filters). */
export const STAGES_OF_BOARD: Record<string, string[]> = { idea: ['neu'], planned: ['bestaetigt'], in_progress: ['in_arbeit'], done: ['behoben', 'ausgeliefert'], declined: ['abgelehnt'] };
export { STAGE_IDS };
