import type { App, Module } from '../core/app.js';
import { HttpError, type Auth, type Ctx } from '../core/http.js';
import { requiredPermission, type Permission } from '../core/permissions.js';
import { normalizeEmail, normalizePhone } from '../core/util.js';
import { disabledAreas, featureMessage, isReadOnly, limitMessage, limitOf, monthKey, readOnlyMessage, type StockKey, type UsageKey } from '../services/saas.js';
import { accountOf, stockCount } from './saas.js';

/**
 * Enforces a sub-account's SaaS plan without touching the feature modules:
 * - one guard (runs after login on every route): areas the plan leaves out → 403, paused or
 *   ended accounts are read-only, creating contacts/funnels/courses/users stops at the limit;
 * - `app.services.usageGate(locationId, 'email'|'sms'|'ai')`, called by the send and AI code
 *   right before the paid call: counts the month's usage and refuses above a "block" limit.
 * Agency admins (and agency keys) are never held back by areas or a pause; limits apply to all.
 */

const limitError = (msg: string) => new HttpError(403, msg);

/** Creation routes and what they create (POST only). */
const CREATES: [RegExp, StockKey][] = [
  [/^\/api\/contacts$/, 'contacts'],
  [/^\/api\/contacts\/import$/, 'contacts'],
  [/^\/api\/funnels$/, 'funnels'],
  [/^\/api\/funnels\/[^/]+\/copy$/, 'funnels'],
  [/^\/api\/courses$/, 'courses'],
];

function checkStock(app: App, locationId: string, k: StockKey, ctx: Ctx) {
  const acc = accountOf(app, locationId);
  const limit = limitOf(acc?.plan, k);
  if (!acc || limit === null) return;
  if (stockCount(app, locationId, k) < limit) return;
  // Saving a contact that already exists (same e-mail/phone) only updates it.
  if (k === 'contacts' && ctx.path === '/api/contacts') {
    const email = normalizeEmail(ctx.body?.email);
    const phone = normalizePhone(ctx.body?.phone);
    if (email && app.db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ?', locationId, email)) return;
    if (phone && app.db.get('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', locationId, phone)) return;
  }
  throw limitError(limitMessage(k, limit, acc.plan.name));
}

/** Member logins are what the "users" limit counts; admins never count. */
function checkUsers(app: App, ctx: Ctx) {
  const b = ctx.body ?? {};
  if (!Array.isArray(b.locations)) return;
  const existing = ctx.method === 'PATCH' ? app.db.get('SELECT * FROM users WHERE id = ?', ctx.path.split('/').pop()) : undefined;
  const role = b.role ?? existing?.role ?? 'member';
  if (role === 'admin') return;
  const before: string[] = existing ? JSON.parse(existing.locations || '[]') : [];
  for (const loc of b.locations.map(String)) {
    if (before.includes(loc)) continue;
    const acc = accountOf(app, loc);
    const limit = limitOf(acc?.plan, 'users');
    if (acc && limit !== null && stockCount(app, loc, 'users') >= limit) throw limitError(limitMessage('users', limit, acc.plan.name));
  }
}

export const saasGateModule: Module = {
  name: 'saas-gate',
  register(app) {
    const { db } = app;

    app.guards.push((ctx: Ctx, auth: Auth) => {
      if (auth === 'admin' && ((ctx.method === 'POST' && ctx.path === '/api/users') || (ctx.method === 'PATCH' && /^\/api\/users\/[^/]+$/.test(ctx.path)))) return checkUsers(app, ctx);
      if (auth !== 'location' || !ctx.locationId) return;
      const acc = accountOf(app, ctx.locationId);
      if (!acc) return;
      const customer = !ctx.user || ctx.user.role !== 'admin';
      if (customer) {
        // Fixing the payment ("Abo & Rechnung") must stay possible while paused.
        if (isReadOnly(acc.sub.status) && ctx.method !== 'GET' && !ctx.path.startsWith('/api/saas/account')) throw new HttpError(403, readOnlyMessage(acc.sub.status));
        const area = requiredPermission(ctx.method, ctx.path);
        if (area && disabledAreas(acc.plan).includes(area)) throw new HttpError(403, featureMessage(area, acc.plan.name));
      }
      if (ctx.method !== 'POST') return;
      for (const [re, k] of CREATES) {
        if (!re.test(ctx.path)) continue;
        const target = k === 'funnels' && ctx.path.endsWith('/copy') && ctx.body?.location_id ? String(ctx.body.location_id) : ctx.locationId;
        checkStock(app, target, k, ctx);
      }
    });

    /** Whether a sub-account's plan leaves an area out (reports check every sub-account they read). */
    app.services.saasAreaBlocked = (locationId: string, area: string): boolean => {
      const acc = accountOf(app, locationId);
      return !!acc && disabledAreas(acc.plan).includes(area as Permission);
    };

    /** Count one e-mail/SMS/AI call for this month; a message string means "don't send". */
    app.services.usageGate = (locationId: string, kind: 'email' | 'sms' | 'ai'): string | undefined => {
      const metric: UsageKey = kind === 'email' ? 'emails' : kind;
      const month = monthKey();
      const acc = accountOf(app, locationId);
      if (acc) {
        if (isReadOnly(acc.sub.status)) return readOnlyMessage(acc.sub.status);
        const limit = limitOf(acc.plan, metric);
        if (limit !== null && acc.plan.overage?.[metric] !== 'bill') {
          const used = Number(db.get<{ count: number }>('SELECT count FROM saas_usage WHERE location_id = ? AND month = ? AND metric = ?', locationId, month, metric)?.count ?? 0);
          if (used >= limit) return limitMessage(metric, limit, acc.plan.name);
        }
      }
      db.run(
        `INSERT INTO saas_usage (location_id, month, metric, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(location_id, month, metric) DO UPDATE SET count = count + 1`,
        locationId, month, metric,
      );
      return undefined;
    };
  },
};
