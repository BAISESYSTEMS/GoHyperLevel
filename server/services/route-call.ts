import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';

/**
 * Runs another API route in-process on behalf of the current caller: same login/key, same
 * sub-account, same guards (rights, SaaS plan) and the same audit log as a real request.
 * Used by the REST-hook actions (Zapier/Make/n8n) and the integration catalogue's status probes.
 */
export async function callRoute(app: App, parent: Ctx, method: string, path: string, body: Record<string, any> = {}, opts: { locationId?: string; /** A read-only call (a report run): no audit entry. */ quiet?: boolean } = {}): Promise<any> {
  const url = new URL(path, 'http://local');
  const found = app.router.match(method, url.pathname);
  if (!found) throw new HttpError(404, `Nicht verfügbar: ${method} ${url.pathname}`);
  const auth = found.route.auth;
  const ctx: Ctx = {
    ...parent,
    method,
    url,
    path: url.pathname,
    params: found.params,
    query: url.searchParams,
    body,
    rawBody: method === 'GET' ? '' : JSON.stringify(body),
    locationId: opts.locationId ?? parent.locationId,
  };
  if (auth === 'admin' && ctx.user?.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
  if (auth === 'user' && !ctx.user) throw new HttpError(403, 'Nur mit Anmeldung');
  if (auth === 'location' && !ctx.locationId) throw new HttpError(400, 'Kein Sub-Account gewählt (x-location-id)');
  // Another sub-account than the caller's: same membership check as a request with x-location-id.
  if (auth === 'location' && ctx.locationId !== parent.locationId) {
    const u = ctx.user;
    if (!u || parent.via === 'api_key') throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
    if (u.role !== 'admin' && !u.locations.includes(ctx.locationId)) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
    if (!app.db.get('SELECT id FROM locations WHERE id = ?', ctx.locationId)) throw new HttpError(404, 'Sub-Account nicht gefunden');
  }
  if (auth !== 'public') for (const g of app.guards) g(ctx, auth);
  const result = await found.route.handler(ctx);
  if (method !== 'GET' && auth !== 'public' && !opts.quiet) {
    for (const fn of app.afterWrite) {
      try {
        fn(ctx, found.route, result);
      } catch (e) {
        console.error('[afterWrite]', e);
      }
    }
  }
  return result;
}
