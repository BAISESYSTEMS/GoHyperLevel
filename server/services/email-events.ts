import type { App } from '../core/app.js';
import { id } from '../core/util.js';
import { logActivity } from './contacts.js';
import { BURST_WINDOW_MS, REASON_LABEL, classifyHit, ipPrefix, uaClass, uaHash, type EventKind, type Reason, type Verdict } from './email-classify.js';

/**
 * Records every pixel load and link click of a tracked mail as a row in `email_events` with its verdict (human /
 * proxy / scanner) and the reason. Only *human* events reach the counters the reports use (`messages.opened_at`,
 * `open_count`, `clicked_at`, `click_count`, `tracked_links.clicks`), the activity log and the `email.opened` /
 * `email.clicked` workflow triggers; machine events only raise `machine_open_count` / `machine_click_count`.
 *
 * Clicks are held for HOLD_MS before they count: a scanner clicks every link of a mail within a moment, and when the
 * second link arrives the first (still waiting) click is re-judged as a scanner click – so no trigger has fired for it.
 * Opens count at once (nothing to re-judge). Storage is minimal on purpose: the network of the address (IPv4 /24,
 * IPv6 /48), a device class and a short one-way hash of the User-Agent – never the address or the raw header.
 */

const MAX_EVENTS_PER_MESSAGE = 300;
/** A pending click becomes final after the burst window plus a margin. */
export const HOLD_MS = BURST_WINDOW_MS + 500;
const RETENTION_DAYS = 400;

export interface Hit {
  kind: EventKind;
  messageId: string;
  /** Clicks: the tracked link. */
  linkId?: string;
  method: string;
  /** The request headers (lower-case names, as Node gives them) and the client address. */
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}

interface EventRow {
  id: string;
  location_id: string;
  message_id: string;
  contact_id: string | null;
  link_id: string | null;
  kind: EventKind;
  at: string;
  classification: Verdict;
}

const header = (h: Hit['headers'], name: string) => {
  const v = h[name];
  return String(Array.isArray(v) ? v[0] : v ?? '');
};

/** Browsers announce prefetching with one of these headers. */
const prefetching = (h: Hit['headers']) => ['purpose', 'sec-purpose', 'x-purpose', 'x-moz'].some((n) => /prefetch|preview/i.test(header(h, n)));

/**
 * Classifies and stores one hit. Returns the verdict, or undefined when the mail is unknown (the pixel and the link
 * still answer – nothing is recorded). Never throws for the caller's sake: the route wraps it anyway.
 */
export function recordHit(app: App, hit: Hit): { verdict: Verdict; reason: Reason } | undefined {
  const { db } = app;
  const m = db.get<{ id: string; location_id: string; contact_id: string | null; created_at: string }>('SELECT id, location_id, contact_id, created_at FROM messages WHERE id = ?', hit.messageId);
  if (!m) return undefined;
  // A leaked pixel address must not fill the table: after this many events a mail records nothing more.
  if (Number(db.get('SELECT COUNT(*) AS n FROM email_events WHERE message_id = ?', m.id)?.n ?? 0) >= MAX_EVENTS_PER_MESSAGE) return undefined;
  const atMs = Date.now();
  const ua = header(hit.headers, 'user-agent');
  const otherLinks =
    hit.kind === 'click' && hit.linkId
      ? Number(db.get(`SELECT COUNT(DISTINCT link_id) AS n FROM email_events WHERE message_id = ? AND kind = 'click' AND link_id != ? AND at >= ?`, m.id, hit.linkId, new Date(atMs - BURST_WINDOW_MS).toISOString())?.n ?? 0)
      : 0;
  const v = classifyHit({
    kind: hit.kind,
    method: hit.method,
    userAgent: ua,
    ip: hit.ip,
    hasAcceptLanguage: !!header(hit.headers, 'accept-language'),
    prefetch: prefetching(hit.headers),
    sentAtMs: Date.parse(m.created_at),
    atMs,
    otherLinksInBurst: otherLinks,
  });
  const row: EventRow = { id: id(), location_id: m.location_id, message_id: m.id, contact_id: m.contact_id, link_id: hit.linkId ?? null, kind: hit.kind, at: new Date(atMs).toISOString(), classification: v.verdict };
  db.insert('email_events', { ...row, method: hit.method.toUpperCase().slice(0, 8), ua_class: uaClass(ua), ua_hash: uaHash(ua), ip_prefix: ipPrefix(hit.ip), reason: v.reason, applied: 0 });
  if (v.verdict !== 'human') {
    applyMachine(app, row);
    // The earlier click(s) of this burst were judged alone and are still waiting: they were the scanner too.
    if (v.reason === 'link-burst') rejudgePending(app, m.id, atMs);
  } else if (hit.kind === 'open') applyHuman(app, row);
  else scheduleCommit(app);
  return v;
}

/** Counts a machine event (never touches opened_at / clicked_at, the activity log or any trigger). */
function applyMachine(app: App, e: EventRow) {
  const { db } = app;
  if (!db.run('UPDATE email_events SET applied = 1 WHERE id = ? AND applied = 0', e.id).changes) return;
  if (e.kind === 'open') db.run('UPDATE messages SET machine_open_count = machine_open_count + 1 WHERE id = ?', e.message_id);
  else {
    db.run('UPDATE messages SET machine_click_count = machine_click_count + 1 WHERE id = ?', e.message_id);
    if (e.link_id) db.run('UPDATE tracked_links SET machine_clicks = machine_clicks + 1 WHERE id = ?', e.link_id);
  }
}

/** Pending human clicks of this mail inside the burst window become scanner clicks. */
function rejudgePending(app: App, messageId: string, atMs: number) {
  const { db } = app;
  const pending = db.all<EventRow>(`SELECT * FROM email_events WHERE message_id = ? AND kind = 'click' AND applied = 0 AND classification = 'human' AND at >= ?`, messageId, new Date(atMs - BURST_WINDOW_MS).toISOString());
  for (const e of pending) {
    db.run(`UPDATE email_events SET classification = 'scanner', reason = 'link-burst' WHERE id = ? AND applied = 0`, e.id);
    applyMachine(app, { ...e, classification: 'scanner' });
  }
}

/** A person's open or click: counters, activity log, workflow trigger. Idempotent (claims the row first). */
function applyHuman(app: App, e: EventRow) {
  const { db } = app;
  if (!db.run(`UPDATE email_events SET applied = 1 WHERE id = ? AND applied = 0 AND classification = 'human'`, e.id).changes) return;
  const msg = db.get<{ opened_at: string | null; clicked_at: string | null }>('SELECT opened_at, clicked_at FROM messages WHERE id = ?', e.message_id);
  if (!msg) return;
  if (e.kind === 'open') {
    db.run('UPDATE messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', e.at, e.message_id);
    if (!msg.opened_at && e.contact_id) {
      logActivity(app, e.location_id, e.contact_id, 'email.opened', 'E-Mail geöffnet');
      app.events.emit(e.location_id, 'email.opened', { contactId: e.contact_id, messageId: e.message_id });
    }
    return;
  }
  const link = e.link_id ? db.get<{ url: string }>('SELECT url FROM tracked_links WHERE id = ?', e.link_id) : undefined;
  if (e.link_id) db.run('UPDATE tracked_links SET clicks = clicks + 1 WHERE id = ?', e.link_id);
  // A click also proves the open (images are often blocked).
  db.run('UPDATE messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?), opened_at = COALESCE(opened_at, ?) WHERE id = ?', e.at, e.at, e.message_id);
  if (e.contact_id && link) {
    logActivity(app, e.location_id, e.contact_id, 'email.clicked', `Link geklickt: ${link.url.slice(0, 120)}`);
    app.events.emit(e.location_id, 'email.clicked', { contactId: e.contact_id, messageId: e.message_id, url: link.url, first: !msg.clicked_at });
  }
}

/** Applies the human clicks whose hold is over (all of them with `force`, for tests and shutdown). Returns how many. */
export function commitClicks(app: App, force = false): number {
  const { db } = app;
  const due = db.all<EventRow>(`SELECT * FROM email_events WHERE applied = 0 AND classification = 'human' AND kind = 'click' AND at <= ? ORDER BY at LIMIT 500`, new Date(force ? Date.now() + 1000 : Date.now() - HOLD_MS).toISOString());
  for (const e of due) applyHuman(app, e);
  return due.length;
}

const timers = new WeakMap<App, NodeJS.Timeout>();
/** One timer per app: when the hold of the oldest waiting click is over, commit; then again for the next. The tick is the backstop (restart). */
function scheduleCommit(app: App, delayMs = HOLD_MS + 100) {
  if (timers.has(app)) return;
  const t = setTimeout(() => {
    timers.delete(app);
    try {
      commitClicks(app);
      const next = app.db.get<{ at: string | null }>(`SELECT MIN(at) AS at FROM email_events WHERE applied = 0 AND classification = 'human' AND kind = 'click'`)?.at;
      if (next) scheduleCommit(app, Math.max(100, Date.parse(next) + HOLD_MS + 100 - Date.now()));
    } catch {
      /* the app is shutting down; the next tick (or start) commits what is left */
    }
  }, delayMs);
  t.unref();
  timers.set(app, t);
}

/** Old events go (the counters on the message stay): 13 months of history is plenty to see what a scanner did. */
export function pruneEvents(app: App): number {
  const { db } = app;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 864e5).toISOString();
  let n = db.run('DELETE FROM email_events WHERE at < ?', cutoff).changes;
  // Links of mails that were never sent (a send that failed after the mail was prepared). Only the last few days are looked at:
  // every link passes this window about 48 times, and checking all old links every hour read the whole table for nothing.
  n += db.run('DELETE FROM tracked_links WHERE created_at < ? AND created_at >= ? AND message_id NOT IN (SELECT id FROM messages)', new Date(Date.now() - 864e5).toISOString(), new Date(Date.now() - 4 * 864e5).toISOString()).changes;
  return n;
}

/** Machine hits of some mails by reason, for "+N maschinell" and its tooltip. */
export function machineBreakdown(app: App, where: string, ...args: (string | number | null)[]): { reason: string; label: string; verdict: Verdict; count: number }[] {
  const rows = app.db.all<{ reason: Reason; classification: Verdict; n: number }>(
    `SELECT e.reason, e.classification, COUNT(*) AS n FROM email_events e WHERE e.classification != 'human' AND ${where} GROUP BY e.reason, e.classification ORDER BY n DESC`,
    ...args,
  );
  return rows.map((r) => ({ reason: r.reason, label: REASON_LABEL[r.reason] ?? r.reason, verdict: r.classification, count: Number(r.n) }));
}
