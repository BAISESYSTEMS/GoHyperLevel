import type { App } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { ymdInTz, zonedToUtc, addDaysYmd } from '../core/time.js';

/**
 * Building blocks of the native app's API (/api/mobile/*, modules/mobile.ts):
 * - which sub-accounts a caller may read for an area – decided by running the app's own guards
 *   (member areas, SaaS plan) against a representative route, so the rules live in one place;
 * - `callRoute`: runs a regular API route in-process as the same user (guards, validation,
 *   events, audit log and other write hooks included) – the app's writes reuse the web paths;
 * - day/month boundaries per time zone for the counters.
 */

export interface Loc {
  id: string;
  name: string;
  timezone: string;
}

/** Representative routes per area: probing them with the guards answers "may this user read X here?". */
export const PROBE = {
  dashboard: '/api/dashboard',
  conversations: '/api/conversations',
  calls: '/api/calls',
  contacts: '/api/contacts',
  tasks: '/api/tasks',
  calendars: '/api/appointments',
  opportunities: '/api/opportunities',
  payments: '/api/invoices',
  reviews: '/api/reviews',
  social: '/api/social/posts',
  project: '/api/project',
} as const;
export type Area = keyof typeof PROBE;

/** Sub-accounts the user can open at all: agency admins every one, client logins their own. */
export function visibleLocations(app: App, ctx: Ctx): Loc[] {
  const u = ctx.user!;
  return u.role === 'admin'
    ? app.db.all<Loc>('SELECT id, name, timezone FROM locations ORDER BY name')
    : app.db.all<Loc>('SELECT id, name, timezone FROM locations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name', JSON.stringify(u.locations));
}

/** A copy of the request as if it went to another route (same user, same "via"). */
function subCtx(ctx: Ctx, method: string, url: URL, params: Record<string, string>, body: unknown, locationId: string): Ctx {
  return { ...ctx, method, url, path: url.pathname, params, query: url.searchParams, body: body ?? {}, rawBody: body === undefined ? '' : JSON.stringify(body), rawBuffer: undefined, locationId, skipAfterWrite: false };
}

/** Throws the guards' refusal (403 with the German reason) when the user may not use `area` in this sub-account. */
export function checkArea(app: App, ctx: Ctx, locationId: string, area: Area, method = 'GET') {
  const url = new URL(PROBE[area], 'http://local');
  const sub = subCtx(ctx, method, url, {}, undefined, locationId);
  for (const g of app.guards) g(sub, 'location');
}

export function mayUse(app: App, ctx: Ctx, locationId: string, area: Area): boolean {
  try {
    checkArea(app, ctx, locationId, area);
    return true;
  } catch (e) {
    if (e instanceof HttpError) return false;
    throw e;
  }
}

/**
 * The sub-accounts a list endpoint covers: `?location=all` (default) or one id. One id the user
 * can't open → 403/404; an area the user lacks → the guard's 403. With "all", sub-accounts without
 * the area are skipped – and if that leaves none, the first refusal is returned (strict). With
 * `strict: false` (summary counters) an area the user lacks simply yields no sub-accounts.
 */
export function scope(app: App, ctx: Ctx, area: Area, opts: { strict?: boolean; param?: string } = {}): Loc[] {
  const want = String(ctx.query.get(opts.param ?? 'location') ?? '').trim() || 'all';
  const visible = visibleLocations(app, ctx);
  if (want !== 'all') {
    const loc = visible.find((l) => l.id === want);
    if (!loc) {
      if (!app.db.get('SELECT id FROM locations WHERE id = ?', want)) throw notFound('Sub-Account nicht gefunden');
      throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
    }
    if (opts.strict === false) return mayUse(app, ctx, loc.id, area) ? [loc] : [];
    checkArea(app, ctx, loc.id, area);
    return [loc];
  }
  const ok: Loc[] = [];
  let first: HttpError | undefined;
  for (const l of visible) {
    try {
      checkArea(app, ctx, l.id, area);
      ok.push(l);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      first ??= e;
    }
  }
  if (!ok.length && first && opts.strict !== false) throw first;
  return ok;
}

/** The sub-account of one record, if the user can open it (otherwise "not found", never a hint that it exists). */
export function ownLocation(app: App, ctx: Ctx, table: string, recordId: string, what = 'Nicht gefunden'): Loc {
  const row = app.db.get<{ location_id: string }>(`SELECT location_id FROM ${table} WHERE id = ?`, recordId);
  const loc = row && visibleLocations(app, ctx).find((l) => l.id === row.location_id);
  if (!loc) throw notFound(what);
  return loc;
}

/** A location the request names in its body (`location_id`), checked like an id in the query. */
export function bodyLocation(app: App, ctx: Ctx, value: unknown): Loc {
  const want = String(value ?? '').trim();
  if (!want) throw bad('Sub-Account fehlt (location_id)');
  const loc = visibleLocations(app, ctx).find((l) => l.id === want);
  if (!loc) {
    if (!app.db.get('SELECT id FROM locations WHERE id = ?', want)) throw notFound('Sub-Account nicht gefunden');
    throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
  }
  return loc;
}

/**
 * Runs a regular API route in-process as the calling user: same location check as a request with
 * x-location-id, the guards (member areas, SaaS plan and limits), the handler (validation, events)
 * and – for writes – the afterWrite hooks (audit log with via "app", push, Todoist …).
 */
export async function callRoute<T = any>(app: App, ctx: Ctx, method: string, path: string, opts: { locationId?: string; body?: unknown } = {}): Promise<T> {
  const url = new URL(path, 'http://local');
  const found = app.router.match(method, url.pathname);
  if (!found) throw notFound('Funktion nicht verfügbar');
  const { route } = found;
  const user = ctx.user;
  if (!user) throw new HttpError(401, 'Nicht angemeldet');
  if (route.auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
  let locationId = '';
  if (route.auth === 'location') {
    locationId = opts.locationId ?? '';
    if (!locationId) throw bad('Kein Sub-Account gewählt');
    if (user.role !== 'admin' && !user.locations.includes(locationId)) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
    if (!app.db.get('SELECT id FROM locations WHERE id = ?', locationId)) throw notFound('Sub-Account nicht gefunden');
  }
  const sub = subCtx(ctx, method, url, found.params, opts.body, locationId);
  if (route.auth !== 'public') for (const g of app.guards) g(sub, route.auth);
  const result = await route.handler(sub);
  if (method !== 'GET' && route.auth !== 'public') {
    for (const fn of app.afterWrite) {
      try {
        fn(sub, route, result);
      } catch (e) {
        console.error('[afterWrite]', e);
      }
    }
  }
  return result as T;
}

// --- time ------------------------------------------------------------------------------

export interface Bounds {
  today: string;
  dayStart: string;
  dayEnd: string;
  monthStart: string;
  /** Local date `n` days ago, 00:00 → UTC. */
  daysAgo: (n: number) => string;
}

export function bounds(tz: string, at = new Date()): Bounds {
  const today = ymdInTz(at, tz);
  const start = (ymd: string) => zonedToUtc(ymd, '00:00', tz).toISOString();
  return {
    today,
    dayStart: start(today),
    dayEnd: start(addDaysYmd(today, 1)),
    monthStart: start(`${today.slice(0, 8)}01`),
    daysAgo: (n) => start(addDaysYmd(today, -n)),
  };
}

/** Sub-accounts grouped by time zone, so "today" is each one's own today. */
export function byTz(locs: Loc[]): Map<string, Loc[]> {
  const m = new Map<string, Loc[]>();
  for (const l of locs) {
    const tz = l.timezone || 'Europe/Berlin';
    m.set(tz, [...(m.get(tz) ?? []), l]);
  }
  return m;
}

/** "?, ?, ?" for an IN list. */
export const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/**
 * Tasks due on a local day: date-only due dates (stored as UTC midnight by the web app) count on
 * their date, timed ones within the local day.
 */
export const DATE_ONLY = `(substr(due_at, 11) IN ('T00:00:00.000Z', 'T00:00:00Z'))`;
export const dueOn = (col = 'due_at') => `((${DATE_ONLY.replace(/due_at/g, col)} AND substr(${col}, 1, 10) = ?) OR (NOT ${DATE_ONLY.replace(/due_at/g, col)} AND ${col} >= ? AND ${col} < ?))`;
export const overdue = (col = 'due_at') => `((${DATE_ONLY.replace(/due_at/g, col)} AND substr(${col}, 1, 10) < ?) OR (NOT ${DATE_ONLY.replace(/due_at/g, col)} AND ${col} < ?))`;

/** Plain-text preview of a message body (emails may be HTML). */
export function plain(s: unknown, max = 2000): string {
  return String(s ?? '')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, max);
}

export const contactName = (c: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | undefined | null) =>
  c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unbekannt' : '';

/** A path in the web app that switches to the sub-account first (?loc=). */
export function deepLink(path: string, locationId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}loc=${encodeURIComponent(locationId)}`;
}

export const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? Math.min(max, Math.max(min, n)) : def;
};
