import { createHmac } from 'node:crypto';
import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { centsToMoney, safeEqual } from '../core/util.js';
import { openSecret } from '../core/secrets.js';
import { addTags, removeTags } from './contacts.js';
import { grantAccess, revokeAccess } from './courses.js';
import { StripeError, stripeRequest } from './stripe.js';

/**
 * Small building blocks shared by the Creator & Commerce modules (payment plans, dunning, quizzes and certificates,
 * comment-to-DM, the AI workflow builder): signed links, Stripe calls with the sub-account's key, switching a buyer's
 * access on and off, audit lines for work that happens without a request, and gross/net maths that matches the invoices.
 */

export const money = (cents: number, currency = 'EUR') => centsToMoney(cents, String(currency || 'EUR').toUpperCase());

export const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** Formats an ISO timestamp as a German date in the sub-account's zone. */
export function deDate(iso: string | number | Date | null | undefined, tz = 'Europe/Berlin'): string {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = iso instanceof Date ? iso : new Date(typeof iso === 'number' ? iso : iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

// --- signed links ------------------------------------------------------------------------------------------

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** `payload.exp` is set from `ttlMs`; `kind` keeps the signatures of different links apart. */
export function signToken(app: App, kind: string, payload: Record<string, unknown>, ttlMs: number): string {
  const body = b64(JSON.stringify({ ...payload, k: kind, exp: Date.now() + ttlMs }));
  const sig = createHmac('sha256', `${app.config.secret}:creator:${kind}`).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function openToken<T extends Record<string, any> = Record<string, any>>(app: App, kind: string, token: unknown): T | null {
  const t = String(token ?? '');
  const dot = t.indexOf('.');
  if (dot < 1 || t.length > 2000) return null;
  const body = t.slice(0, dot);
  const sig = createHmac('sha256', `${app.config.secret}:creator:${kind}`).update(body).digest('base64url');
  if (!safeEqual(sig, t.slice(dot + 1))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.k !== kind || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p as T;
  } catch {
    return null;
  }
}

// --- audit -------------------------------------------------------------------------------------------------

/** One line in the audit log for something done by the system (ticks, webhooks) or by a person's request. */
export function auditLog(app: App, ctx: Ctx | undefined, locationId: string, action: string, summary: string, entityId?: string | null, actor?: string) {
  try {
    app.services.audit?.({ ctx, action, summary: summary.slice(0, 480), locationId, entityId: entityId ?? null, actor: actor ?? (ctx ? undefined : 'System') });
  } catch (e) {
    console.error('[creator] audit', (e as Error).message);
  }
}

// --- Stripe ------------------------------------------------------------------------------------------------

/** The sub-account's Stripe secret key ('' when Stripe is not connected). */
export const stripeKeyOf = (app: App, locationId: string): string => app.services.stripeKey?.(locationId) ?? '';

/** A Stripe call with the sub-account's own key; failures become readable 502s. */
export async function stripeCall<T = any>(app: App, locationId: string, method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, any>, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const key = stripeKeyOf(app, locationId);
  if (!key) throw new HttpError(409, 'Stripe ist für diesen Sub-Account nicht verbunden (Einstellungen → Stripe)');
  try {
    return await stripeRequest<T>(key, method, path, params, opts);
  } catch (e) {
    if (e instanceof StripeError) throw new HttpError(e.status === 0 || e.status >= 500 ? 502 : 400, e.message);
    throw e;
  }
}

/** Reads the first of several places where Stripe puts the subscription id of an invoice (API versions differ). */
export const subscriptionOfInvoice = (inv: any): string => String(inv?.parent?.subscription_details?.subscription ?? inv?.subscription_details?.subscription ?? (typeof inv?.subscription === 'string' ? inv.subscription : inv?.subscription?.id) ?? '');

// --- gross / net (same rounding as the invoices) ------------------------------------------------------------

export const grossOfNet = (net: number, tax: number) => net + Math.round((net * tax) / 100);
/** The net amount whose gross is `gross` (or the closest one). */
export function netForGross(gross: number, tax: number): number {
  const n0 = Math.round(gross / (1 + tax / 100));
  for (const d of [0, 1, -1, 2, -2]) if (grossOfNet(n0 + d, tax) === gross) return n0 + d;
  return n0;
}

// --- access ------------------------------------------------------------------------------------------------

/**
 * Turns a buyer's access to a product on or off again: the purchase tag (`kauf:<product>`) and the courses linked to the
 * product. Used for pausing after a default and reactivating after payment. Returns what changed (for the log).
 */
export function setPurchaseAccess(app: App, locationId: string, contactId: string, productId: string, tag: string, on: boolean, why: string): string[] {
  const done: string[] = [];
  if (tag) {
    if (on) addTags(app, locationId, contactId, [tag]);
    else removeTags(app, locationId, contactId, [tag]);
    done.push(`Tag ${tag} ${on ? 'gesetzt' : 'entfernt'}`);
  }
  const courses = app.db.all<{ id: string; title: string }>(
    `SELECT id, title FROM courses WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(courses.access, '$.product_ids') WHERE value = ?)`,
    locationId,
    productId,
  );
  for (const c of courses) {
    try {
      if (on) grantAccess(app, locationId, c.id, contactId, 'purchase', productId);
      else revokeAccess(app, locationId, c.id, contactId, why);
      done.push(`Kurs „${c.title}“ ${on ? 'freigeschaltet' : 'pausiert'}`);
    } catch (e) {
      console.error('[creator] access', (e as Error).message);
    }
  }
  return done;
}

/** The tag a product purchase sets (checkout metadata first, then the product's buy-link setting). */
export function purchaseTag(app: App, locationId: string, productId: string, meta?: Record<string, any>): string {
  if (meta?.tag) return String(meta.tag);
  const p = app.db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ?', productId, locationId);
  if (!p) return '';
  const link = app.services.stripeBuy?.linkOf(productId);
  return app.services.stripeBuy?.tagOf(p, link) ?? '';
}

/** Sealed text from a settings row (never throws: a changed server key just means "not set"). */
export function openText(app: App, sealed: string): string {
  if (!sealed) return '';
  try {
    return openSecret(app, sealed);
  } catch {
    return '';
  }
}

// --- small utilities -----------------------------------------------------------------------------------------

/** Per-key sliding window limiter for public routes. */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = Date.now();
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 20_000) hits.clear();
    return list.length > max;
  };
}

/** Adds calendar months/weeks like Stripe's billing periods (day of month kept where possible). */
export function addPeriod(from: Date, interval: 'week' | 'month', count: number): Date {
  if (interval === 'week') return new Date(from.getTime() + count * 7 * 864e5);
  const day = from.getUTCDate();
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + count, 1, from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target;
}

export const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
