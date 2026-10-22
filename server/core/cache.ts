import type { App } from './app.js';
import type { Ctx } from './http.js';

/**
 * Read cache for list and aggregate routes. A cached answer is served until something is written to the
 * database (any table: rows changed through this process or committed by another one) or `ttlMs` has
 * passed – so a user never sees older data than before their own write, and time-dependent numbers
 * ("overdue") are at most a few seconds old. PGHL_RESULT_CACHE=0 turns it off (db.memo).
 *
 *   router.get('/api/invoices', 'location', (ctx) => cached(app, ctx, 10_000, () => listInvoices(ctx)));
 *
 * Only for handlers that read and do not write. The key is method + path + query + sub-account + user,
 * so two people never share an answer unless the route is identical for them. The returned value is
 * shared between requests: do not mutate it afterwards.
 */
export function cached<T>(app: App, ctx: Ctx, ttlMs: number, fn: () => T): T {
  const key = `route:${ctx.path}?${ctx.url.search}|${ctx.locationId}|${ctx.user?.id ?? ''}|${ctx.via ?? ''}`;
  return app.db.memo(key, ttlMs, fn);
}
