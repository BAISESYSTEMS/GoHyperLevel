import type { App } from '../../core/app.js';
import { id, now } from '../../core/util.js';
import { captureError } from '../../modules/feedback-capture.js';
import { RateLimiter } from '../feedback.js';
import { loadPolicy } from './policy.js';
import { NAMES, ROUTES } from './names.js';
import { tell } from './notify.js';

/**
 * Health of a plugin: usage and errors from `plugin_events`, votes of its wish, ratings of the Marktplatz.
 * The kill switch lives here too: a spike of errors (or of calls the manifest does not allow) switches the
 * plugin off for everyone, tells the admins and files the error in „Fehler & Wünsche“ like any other crash.
 */

export type EventKind = 'open' | 'call' | 'error' | 'denied' | 'job' | 'action';
const FAULTS: EventKind[] = ['error', 'denied'];
const newTickets = new RateLimiter(30, 3600_000);

export function recordEvent(app: App, pluginId: string, locationId: string | null, kind: EventKind, detail = '', ms = 0): void {
  try {
    app.db.insert('plugin_events', { id: id(), plugin_id: pluginId, location_id: locationId, kind, detail: detail.slice(0, 300), ms: Math.max(0, Math.round(ms)), created_at: now() });
    if (FAULTS.includes(kind)) maybeKill(app, pluginId);
    else if (ms > 0 && (kind === 'call' || kind === 'job' || kind === 'action')) maybeSlow(app, pluginId);
  } catch (e) {
    console.error('[plugins] event', (e as Error).message);
  }
}

/** Files a plugin error as an automatically captured error (grouped by message, with an occurrence counter). */
export function reportPluginError(app: App, plugin: { id: string; name: string }, locationId: string | null, message: string, stack = ''): void {
  try {
    captureError(app, { source: 'client', message: `[Plugin ${plugin.name}] ${message}`.slice(0, 400), stack: stack.slice(0, 3000), route: `plugin:${plugin.id}`, locationId, user: null }, newTickets);
  } catch (e) {
    console.error('[plugins] capture', (e as Error).message);
  }
}

/** Switches a plugin off for everyone. */
export function killPlugin(app: App, pluginId: string, reason: string): boolean {
  const p = app.db.get<{ id: string; name: string; status: string; owner_user_id: string | null; owner_location_id: string | null }>('SELECT id, name, status, owner_user_id, owner_location_id FROM plugins WHERE id = ?', pluginId);
  if (!p || p.status === 'killed') return false;
  app.db.run(`UPDATE plugins SET status = 'killed', killed_at = ?, killed_reason = ?, updated_at = ? WHERE id = ?`, now(), reason.slice(0, 300), now(), pluginId);
  reportPluginError(app, p, null, `automatisch abgeschaltet: ${reason}`);
  // Auto-disable is only half of it: admins and the author hear about it (app, push, email) and can roll back with one click.
  const admins = app.db.all<{ id: string }>(`SELECT id FROM users WHERE role = 'admin'`).map((r) => r.id);
  void tell(app, { userIds: [...admins, p.owner_user_id], kind: 'alarm', title: `${NAMES.plugin} „${p.name}“ wurde abgeschaltet`, body: `${reason} Mit „Zurückrollen“ läuft wieder die Vorversion.`, path: `/app/${ROUTES.werkstatt}/plugins/${p.id}`, ...(p.owner_location_id ? { locationId: p.owner_location_id } : {}), actions: [{ action: 'rollback', title: 'Zurückrollen' }], email: true }).catch(() => {});
  return true;
}

export function revivePlugin(app: App, pluginId: string): boolean {
  const r = app.db.run(`UPDATE plugins SET status = 'active', killed_at = NULL, killed_reason = '', updated_at = ? WHERE id = ? AND status = 'killed'`, now(), pluginId);
  // A fresh start: the old errors must not trip the switch again straight away.
  if (r.changes) app.db.run(`DELETE FROM plugin_events WHERE plugin_id = ? AND kind IN ('error', 'denied')`, pluginId);
  return r.changes > 0;
}

/** The kill switch: too many faults in the window, and they are a large share of everything the plugin did. */
export function maybeKill(app: App, pluginId: string): boolean {
  const k = loadPolicy(app).kill;
  const since = new Date(Date.now() - k.window_min * 60_000).toISOString();
  const r = app.db.get<{ errors: number; total: number }>(`SELECT COALESCE(SUM(kind IN ('error', 'denied')), 0) AS errors, COUNT(*) AS total FROM plugin_events WHERE plugin_id = ? AND created_at >= ?`, pluginId, since)!;
  if (r.errors >= k.errors && r.errors / Math.max(1, r.total) >= k.ratio) return killPlugin(app, pluginId, `${r.errors} Fehler in ${k.window_min} Minuten (${Math.round((r.errors / r.total) * 100)} % aller Aufrufe)`);
  return false;
}

const lastSlowCheck = new Map<string, number>();
/** Pause between two latency checks of one plugin (tests set it to 0). */
export const slowCheck = { ms: 20_000 };
/** The kill switch for slowness: the average response time over the window is above the policy's limit. */
export function maybeSlow(app: App, pluginId: string): boolean {
  const k = loadPolicy(app).kill;
  if (!k.latency_ms) return false;
  const t = Date.now();
  if (t - (lastSlowCheck.get(pluginId) ?? 0) < slowCheck.ms) return false;
  lastSlowCheck.set(pluginId, t);
  const since = new Date(t - k.window_min * 60_000).toISOString();
  const r = app.db.get<{ n: number; avg: number | null }>(`SELECT COUNT(*) AS n, AVG(ms) AS avg FROM plugin_events WHERE plugin_id = ? AND created_at >= ? AND kind IN ('call', 'job', 'action') AND ms > 0`, pluginId, since)!;
  if (r.n >= k.min_calls && (r.avg ?? 0) >= k.latency_ms) return killPlugin(app, pluginId, `Zu langsam: im Schnitt ${Math.round(r.avg!)} ms in ${k.window_min} Minuten (Grenze ${k.latency_ms} ms, ${r.n} Aufrufe)`);
  return false;
}

export interface Health {
  installs: number;
  usage_7d: number;
  usage_30d: number;
  errors_24h: number;
  errors_7d: number;
  last_error: string;
  last_error_at: string | null;
  votes: number;
  rating: number | null;
  reviews: number;
  killed: boolean;
  /** Average response time over the last 24 hours (ms), 0 without data. */
  avg_ms_24h: number;
  /** Share of faults among all events in the last 24 hours (0–1). */
  error_rate_24h: number;
}

export function healthOf(app: App, pluginId: string): Health {
  const { db } = app;
  const plugin = db.get<{ scope: string; status: string; wish_id: string | null }>('SELECT scope, status, wish_id FROM plugins WHERE id = ?', pluginId);
  const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
  const use = (since: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM plugin_events WHERE plugin_id = ? AND created_at >= ? AND kind IN ('open', 'call', 'job', 'action')`, pluginId, since)!.n;
  const err = (since: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM plugin_events WHERE plugin_id = ? AND created_at >= ? AND kind IN ('error', 'denied')`, pluginId, since)!.n;
  const last = db.get<{ detail: string; created_at: string }>(`SELECT detail, created_at FROM plugin_events WHERE plugin_id = ? AND kind IN ('error', 'denied') ORDER BY created_at DESC LIMIT 1`, pluginId);
  const own = db.get<{ n: number }>('SELECT COUNT(DISTINCT location_id) AS n FROM plugin_installs WHERE plugin_id = ? AND enabled = 1', pluginId)!.n;
  const installs = plugin?.scope === 'agency' ? db.get<{ n: number }>('SELECT COUNT(*) AS n FROM locations')!.n : own;
  let votes = 0;
  if (plugin?.wish_id) votes = Number(db.get<{ votes: number }>('SELECT votes FROM feedback_items WHERE id = ?', plugin.wish_id)?.votes ?? 0);
  let rating: number | null = null;
  let reviews = 0;
  try {
    const r = db.get<{ avg: number | null; n: number }>('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM plugin_reviews WHERE plugin_id = ?', pluginId);
    reviews = r?.n ?? 0;
    rating = r?.avg != null ? Math.round(r.avg * 10) / 10 : null;
  } catch {
    /* no Marktplatz module */
  }
  const day = db.get<{ n: number; avg: number | null }>(`SELECT COUNT(*) AS n, AVG(CASE WHEN ms > 0 AND kind IN ('call', 'job', 'action') THEN ms END) AS avg FROM plugin_events WHERE plugin_id = ? AND created_at >= ?`, pluginId, ago(1))!;
  const errors24 = err(ago(1));
  return { installs, usage_7d: use(ago(7)), usage_30d: use(ago(30)), errors_24h: errors24, errors_7d: err(ago(7)), last_error: last?.detail ?? '', last_error_at: last?.created_at ?? null, votes, rating, reviews, killed: plugin?.status === 'killed', avg_ms_24h: Math.round(day.avg ?? 0), error_rate_24h: day.n ? Math.round((errors24 / day.n) * 1000) / 1000 : 0 };
}

/** Old events go after 35 days (called by the daily tick). */
export function pruneEvents(app: App) {
  app.db.run('DELETE FROM plugin_events WHERE created_at < ?', new Date(Date.now() - 35 * 864e5).toISOString());
  app.db.run('DELETE FROM plugin_runs WHERE created_at < ?', new Date(Date.now() - 35 * 864e5).toISOString());
}
