import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, type User } from '../core/http.js';
import { PERMISSIONS } from '../core/permissions.js';
import { id, now, normalizeEmail } from '../core/util.js';
import {
  LIMITS,
  PAYING,
  USAGE_KEYS,
  churnRate,
  cleanPlan,
  disabledAreas,
  graceExpired,
  intervalsOf,
  isFree,
  isReadOnly,
  limitOf,
  mapStripeStatus,
  monthKey,
  monthlyValue,
  overageCharge,
  periodEnd,
  priceOf,
  transition,
  unixIso,
  type Interval,
  type LimitKey,
  type Plan,
  type StockKey,
  type SubStatus,
  type Subscription,
  type UsageKey,
} from '../services/saas.js';
import { StripeError, isLiveKey, isSecretKey, isWebhookSecret, keyHint, stripeRequest, verifyStripeSignature } from '../services/stripe.js';
import { getBranding } from './agency.js';
import { openSecret, sealSecret } from './mail-sync.js';
import type { Tool } from './mcp.js';

/**
 * SaaS mode: the agency sells sub-accounts to its own customers (like GHL's SaaS Configurator).
 * The agency's own Stripe account (separate from each sub-account's Stripe) bills plans; plans
 * decide which areas a sub-account sees and how much it may use. This module holds the agency
 * settings, plans (synced to Stripe Products/Prices), each sub-account's subscription with the
 * billing lifecycle (past_due → grace → paused → reactivated), usage rebilling and the
 * dashboard. Enforcement lives in saas-gate.ts, the public signup in saas-signup.ts.
 */

export interface SaasSettings {
  secret_key: string;
  webhook_secret: string;
  key_hint: string;
  account_id: string;
  account_name: string;
  livemode: boolean;
  checked_at: string | null;
  grace_days: number;
  default_snapshot_id: string;
  mail_location_id: string;
  activate_workflows: boolean;
  signup_enabled: boolean;
  signup_title: string;
  signup_text: string;
  terms_url: string;
  /** What one unit costs the agency, in cents (fractions allowed). */
  unit_cost: Record<UsageKey, number>;
  markup_percent: number;
}

const DEFAULTS: SaasSettings = {
  secret_key: '',
  webhook_secret: '',
  key_hint: '',
  account_id: '',
  account_name: '',
  livemode: false,
  checked_at: null,
  grace_days: 7,
  default_snapshot_id: '',
  mail_location_id: '',
  activate_workflows: false,
  signup_enabled: false,
  signup_title: '',
  signup_text: '',
  terms_url: '',
  unit_cost: { emails: 0.1, sms: 8, ai: 3 },
  markup_percent: 30,
};

export function saasSettings(app: App): SaasSettings {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'saas');
  const v = row ? JSON.parse(row.value) : {};
  return { ...DEFAULTS, ...v, unit_cost: { ...DEFAULTS.unit_cost, ...(v.unit_cost ?? {}) } };
}
function saveSettings(app: App, s: SaasSettings) {
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'saas', JSON.stringify(s));
}

export const stripeKeyOf = (app: App) => {
  const s = saasSettings(app);
  return s.secret_key ? openSecret(app, s.secret_key) : '';
};

/** A call against the agency's Stripe account; Stripe errors become readable HTTP errors. */
export async function saasStripe<T = any>(app: App, method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, any>, opts: { idempotencyKey?: string } = {}): Promise<T> {
  const key = stripeKeyOf(app);
  if (!key) throw bad('Agentur-Stripe ist nicht verbunden (Agentur → SaaS → Einstellungen)');
  try {
    return await stripeRequest<T>(key, method, path, params, opts);
  } catch (e) {
    if (e instanceof StripeError) throw new HttpError(e.status === 401 ? 400 : 502, e.message);
    throw e;
  }
}

export function planById(app: App, planId: string | null | undefined): Plan | undefined {
  if (!planId) return undefined;
  return parseJson(app.db.get<Plan>('SELECT * FROM saas_plans WHERE id = ?', planId), ['features', 'limits', 'overage', 'stripe_synced']);
}
export const subscriptionOf = (app: App, locationId: string) => app.db.get<Subscription>('SELECT * FROM saas_subscriptions WHERE location_id = ?', locationId);

/** A sub-account on a plan: its subscription and plan, or undefined (no SaaS rules apply). */
export function accountOf(app: App, locationId: string): { sub: Subscription; plan: Plan } | undefined {
  const sub = subscriptionOf(app, locationId);
  const plan = sub && planById(app, sub.plan_id);
  return sub && plan ? { sub, plan } : undefined;
}

export function logSaasEvent(app: App, locationId: string | null, type: string, detail = '') {
  app.db.insert('saas_events', { id: id(), location_id: locationId, type, detail: detail.slice(0, 500), at: now() });
}

/** How many of a countable thing a sub-account has right now. */
export function stockCount(app: App, locationId: string, k: StockKey): number {
  const sql: Record<StockKey, string> = {
    contacts: 'SELECT COUNT(*) AS n FROM contacts WHERE location_id = ?',
    users: `SELECT COUNT(*) AS n FROM users WHERE role = 'member' AND EXISTS (SELECT 1 FROM json_each(users.locations) WHERE value = ?)`,
    funnels: 'SELECT COUNT(*) AS n FROM funnels WHERE location_id = ?',
    courses: 'SELECT COUNT(*) AS n FROM courses WHERE location_id = ?',
  };
  try {
    return Number(app.db.get<{ n: number }>(sql[k], locationId)?.n ?? 0);
  } catch {
    return 0;
  }
}
export function usageOf(app: App, locationId: string, month = monthKey()): Record<UsageKey, number> {
  const out = { emails: 0, sms: 0, ai: 0 } as Record<UsageKey, number>;
  for (const r of app.db.all('SELECT metric, count FROM saas_usage WHERE location_id = ? AND month = ?', locationId, month)) if (r.metric in out) out[r.metric as UsageKey] = Number(r.count);
  return out;
}

type SubRow = Partial<Subscription> & { location_id: string; plan_id: string };
/** Insert or update a sub-account's subscription row. */
export function upsertSubscription(app: App, row: SubRow): Subscription {
  const cur = subscriptionOf(app, row.location_id);
  const t = now();
  const next: Subscription = {
    interval: 'month',
    status: 'active',
    billing: 'manual',
    stripe_customer: '',
    stripe_subscription: '',
    stripe_item: '',
    current_period_end: null,
    trial_end: null,
    cancel_at_period_end: 0,
    past_due_since: null,
    grace_until: null,
    paused_at: null,
    canceled_at: null,
    email: '',
    created_at: t,
    ...(cur ?? {}),
    ...row,
    updated_at: t,
  } as Subscription;
  const cols = Object.keys(next) as (keyof Subscription)[];
  app.db.run(
    `INSERT INTO saas_subscriptions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(location_id) DO UPDATE SET ${cols.filter((c) => c !== 'location_id' && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ')}`,
    ...cols.map((c) => next[c] as any),
  );
  return subscriptionOf(app, row.location_id)!;
}

/** Fetches a subscription from the agency's Stripe; null when Stripe can't be reached. */
export async function fetchSubscription(app: App, subId: string): Promise<any | null> {
  if (!/^sub_[A-Za-z0-9]+$/.test(subId)) return null;
  try {
    return await saasStripe(app, 'GET', `/v1/subscriptions/${subId}`);
  } catch (e) {
    console.error('[saas] Abo abrufen', (e as Error).message);
    return null;
  }
}

/** Subscription fields from a Stripe subscription object. */
export function fromStripeSub(app: App, sub: any, cur?: Pick<Subscription, 'status' | 'past_due_since' | 'grace_until' | 'paused_at' | 'canceled_at'>) {
  const item = sub?.items?.data?.[0];
  const priceId = String(item?.price?.id ?? '');
  const plan = priceId ? app.db.get('SELECT id FROM saas_plans WHERE stripe_price_month = ? OR stripe_price_year = ?', priceId, priceId) : undefined;
  const base = cur ?? { status: 'active' as SubStatus, past_due_since: null, grace_until: null, paused_at: null, canceled_at: null };
  return {
    ...(plan ? { plan_id: plan.id as string } : {}),
    ...(item?.price?.recurring?.interval === 'year' ? { interval: 'year' as Interval } : item?.price?.recurring?.interval === 'month' ? { interval: 'month' as Interval } : {}),
    ...transition(base, mapStripeStatus(String(sub?.status ?? 'active')), new Date(), saasSettings(app).grace_days),
    billing: 'stripe' as const,
    stripe_customer: String(typeof sub?.customer === 'object' ? sub.customer?.id : (sub?.customer ?? '')),
    stripe_subscription: String(sub?.id ?? ''),
    stripe_item: String(item?.id ?? ''),
    current_period_end: periodEnd(sub),
    trial_end: unixIso(sub?.trial_end),
    cancel_at_period_end: sub?.cancel_at_period_end || sub?.cancel_at ? 1 : 0,
  };
}

const STATUS_LABEL: Record<SubStatus, string> = { trialing: 'Testphase', active: 'aktiv', past_due: 'Zahlung offen', paused: 'pausiert', canceled: 'beendet' };
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }) : '');

/** The banner a sub-account shows for its billing state (or null). */
export function bannerFor(sub: Subscription, plan: Plan): { tone: 'info' | 'warn' | 'error'; text: string; action?: 'portal' | 'undo_cancel' } | null {
  const portal = sub.billing === 'stripe' && !!sub.stripe_customer;
  if (sub.status === 'past_due')
    return { tone: 'warn', text: `Zahlung fehlgeschlagen. Bitte aktualisiere deine Zahlungsmethode${sub.grace_until ? ` bis ${fmtDate(sub.grace_until)}` : ''} – sonst wird dein Konto pausiert.`, action: portal ? 'portal' : undefined };
  // A trial that ran out without payment data: nothing is overdue, a plan has to be chosen.
  if (sub.status === 'paused' && sub.billing === 'manual' && sub.trial_end) return { tone: 'error', text: 'Deine Testphase ist abgelaufen. Alles bleibt lesbar, Änderungen sind gesperrt, bis du einen Tarif wählst (Einstellungen → Abo & Rechnung).' };
  if (sub.status === 'paused') return { tone: 'error', text: 'Dein Konto ist pausiert, weil eine Zahlung offen ist. Alles bleibt lesbar, Änderungen sind gesperrt, bis die Zahlung da ist.', action: portal ? 'portal' : undefined };
  if (sub.status === 'canceled') return { tone: 'error', text: 'Dein Abo ist beendet. Das Konto ist nur noch lesbar.' };
  if (sub.cancel_at_period_end) return { tone: 'info', text: `Dein Abo „${plan.name}“ endet am ${fmtDate(sub.current_period_end) || 'Ende des Zeitraums'}.`, action: portal ? 'undo_cancel' : undefined };
  if (sub.status === 'trialing' && sub.trial_end && new Date(sub.trial_end).getTime() - Date.now() < 7 * 864e5)
    return { tone: 'info', text: sub.billing === 'manual' ? `Deine Testphase endet am ${fmtDate(sub.trial_end)}. Danach ist dein Konto schreibgeschützt – wähle vorher unter Einstellungen → Abo & Rechnung einen Tarif.` : `Deine Testphase endet am ${fmtDate(sub.trial_end)}. Danach läuft „${plan.name}“ automatisch weiter.`, action: portal ? 'portal' : undefined };
  return null;
}

const planOut = (p: Plan) => {
  const { stripe_synced: _s, ...rest } = p as Plan & { stripe_synced?: unknown };
  return { ...rest, intervals: intervalsOf(p), free: isFree(p) };
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_saas_overview',
    title: 'SaaS-Übersicht',
    description: 'SaaS-Modus der Agentur: MRR, Abos nach Status (aktiv, Testphase, Zahlung offen, pausiert, beendet), Churn der letzten 30 Tage, Anzahl je Tarif, anstehende Verlängerungen und alle Kunden-Accounts mit Tarif.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    agencyOnly: true,
    run: (call) => call.api('GET', '/api/saas/overview'),
  },
  {
    name: 'ghl_set_location_plan',
    title: 'Tarif eines Sub-Accounts setzen',
    description:
      'Setzt den SaaS-Tarif eines Sub-Accounts (plan: ID oder Name aus ghl_saas_overview). Ohne Stripe-Abo wird der Tarif manuell vergeben (status optional: active|trialing|past_due|paused|canceled); mit laufendem Stripe-Abo wird das Abo bei Stripe auf den neuen Preis umgestellt. plan leer = Tarif entfernen (nur ohne laufendes Stripe-Abo).',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string' }, plan: { type: 'string' }, interval: { type: 'string', enum: ['month', 'year'] }, status: { type: 'string' } },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    agencyOnly: true,
    run: async (call, a) => {
      if (!a.plan) return call.api('DELETE', `/api/saas/locations/${encodeURIComponent(a.location_id)}`);
      const plans: any[] = await call.api('GET', '/api/saas/plans');
      const want = String(a.plan).toLowerCase();
      const plan = plans.find((p) => p.id === a.plan) ?? plans.find((p) => p.name.toLowerCase() === want);
      if (!plan) throw new HttpError(404, `Tarif „${a.plan}“ nicht gefunden`);
      return call.api('PUT', `/api/saas/locations/${encodeURIComponent(a.location_id)}`, { body: { plan_id: plan.id, ...(a.interval ? { interval: a.interval } : {}), ...(a.status ? { status: a.status } : {}) } });
    },
  },
];

export const saasModule: Module = {
  name: 'saas',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE saas_plans (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL DEFAULT 'EUR',
        price_month_cents INTEGER NOT NULL DEFAULT 0, price_year_cents INTEGER NOT NULL DEFAULT 0, trial_days INTEGER NOT NULL DEFAULT 0,
        features TEXT NOT NULL DEFAULT '[]', limits TEXT NOT NULL DEFAULT '{}', overage TEXT NOT NULL DEFAULT '{}', markup_percent REAL,
        snapshot_id TEXT, public INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
        stripe_product_id TEXT NOT NULL DEFAULT '', stripe_price_month TEXT NOT NULL DEFAULT '', stripe_price_year TEXT NOT NULL DEFAULT '',
        stripe_synced TEXT NOT NULL DEFAULT '{}', sync_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE saas_subscriptions (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES saas_plans(id),
        interval TEXT NOT NULL DEFAULT 'month', status TEXT NOT NULL DEFAULT 'active', billing TEXT NOT NULL DEFAULT 'manual',
        stripe_customer TEXT NOT NULL DEFAULT '', stripe_subscription TEXT NOT NULL DEFAULT '', stripe_item TEXT NOT NULL DEFAULT '',
        current_period_end TEXT, trial_end TEXT, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        past_due_since TEXT, grace_until TEXT, paused_at TEXT, canceled_at TEXT, email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX saas_subscriptions_stripe ON saas_subscriptions(stripe_subscription);
      CREATE TABLE saas_usage (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, month TEXT NOT NULL, metric TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (location_id, month, metric)
      );
      CREATE TABLE saas_usage_reports (
        location_id TEXT NOT NULL, month TEXT NOT NULL, metric TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 0,
        amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', stripe_id TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', reported_at TEXT NOT NULL, PRIMARY KEY (location_id, month, metric)
      );
      CREATE TABLE saas_events (id TEXT PRIMARY KEY, location_id TEXT, type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
      CREATE INDEX saas_events_at ON saas_events(at);
      CREATE TABLE saas_stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TEXT NOT NULL);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const settings = () => saasSettings(app);
    const hookUrl = () => `${app.baseUrl()}/hooks/stripe-agency`;

    // --- agency settings ---------------------------------------------------------------
    const settingsOut = () => {
      const s = settings();
      const { secret_key: _k, webhook_secret: _w, ...rest } = s;
      return {
        ...rest,
        connected: !!s.secret_key,
        key_set: !!s.secret_key,
        webhook_set: !!s.webhook_secret,
        live: s.livemode,
        account: s.account_id ? { id: s.account_id, name: s.account_name } : null,
        webhook_url: hookUrl(),
        signup_url: `${app.baseUrl()}/signup`,
      };
    };
    async function testKey(key: string) {
      try {
        const a = await stripeRequest(key, 'GET', '/v1/account');
        return { id: String(a.id ?? ''), name: String(a.settings?.dashboard?.display_name || a.business_profile?.name || a.email || a.id || ''), country: a.country ?? '', charges_enabled: a.charges_enabled !== false };
      } catch (e) {
        if (e instanceof StripeError) throw new HttpError(e.status === 401 ? 400 : 502, e.message);
        throw e;
      }
    }

    router.get('/api/saas/settings', 'admin', () => settingsOut());
    router.put('/api/saas/settings', 'admin', async (ctx) => {
      const b = ctx.body ?? {};
      const s = settings();
      const key = str(b.secret_key, 'Secret Key', { max: 300 });
      if (key && key !== '••••••') {
        if (!isSecretKey(key)) throw bad('Secret Key: beginnt mit sk_live_, sk_test_ oder rk_… (Stripe → Entwickler → API-Schlüssel)');
        const acc = await testKey(key);
        Object.assign(s, { secret_key: sealSecret(app, key), key_hint: keyHint(key), account_id: acc.id, account_name: acc.name, livemode: isLiveKey(key), checked_at: now() });
      }
      const wh = str(b.webhook_secret, 'Signing Secret', { max: 300 });
      if (wh && wh !== '••••••') {
        if (!isWebhookSecret(wh)) throw bad('Signing Secret: beginnt mit whsec_ (Stripe → Webhooks → Endpunkt → Signing Secret)');
        s.webhook_secret = sealSecret(app, wh);
      }
      if (b.grace_days !== undefined) {
        const g = Number(b.grace_days);
        if (!Number.isInteger(g) || g < 0 || g > 60) throw bad('Kulanzzeit: 0 bis 60 Tage');
        s.grace_days = g;
      }
      if (b.default_snapshot_id !== undefined) {
        if (b.default_snapshot_id && !db.get('SELECT id FROM snapshots WHERE id = ?', String(b.default_snapshot_id))) throw bad('Snapshot nicht gefunden');
        s.default_snapshot_id = String(b.default_snapshot_id || '');
      }
      if (b.mail_location_id !== undefined) {
        if (b.mail_location_id && !app.location(String(b.mail_location_id))) throw bad('Sub-Account für den Mail-Versand nicht gefunden');
        s.mail_location_id = String(b.mail_location_id || '');
      }
      for (const k of ['signup_enabled', 'activate_workflows'] as const) if (b[k] !== undefined) s[k] = !!b[k];
      if (b.signup_title !== undefined) s.signup_title = str(b.signup_title, 'Überschrift', { max: 120 });
      if (b.signup_text !== undefined) s.signup_text = str(b.signup_text, 'Text', { max: 2000 });
      if (b.terms_url !== undefined) {
        const u = str(b.terms_url, 'AGB-Link', { max: 500 });
        if (u && !/^https:\/\/\S+$/i.test(u)) throw bad('AGB-Link: bitte mit https:// angeben');
        s.terms_url = u;
      }
      if (b.unit_cost && typeof b.unit_cost === 'object') {
        for (const k of USAGE_KEYS) {
          if (b.unit_cost[k] === undefined) continue;
          const v = Number(String(b.unit_cost[k]).replace(',', '.'));
          if (!Number.isFinite(v) || v < 0 || v > 10000) throw bad(`Kosten je ${LIMITS[k]}: 0 bis 10.000 Cent`);
          s.unit_cost[k] = v;
        }
      }
      if (b.markup_percent !== undefined) {
        const m = Number(b.markup_percent);
        if (!Number.isFinite(m) || m < 0 || m > 1000) throw bad('Aufschlag: 0 bis 1000 %');
        s.markup_percent = m;
      }
      saveSettings(app, s);
      return settingsOut();
    });
    router.post('/api/saas/settings/test', 'admin', async (ctx) => {
      const typed = str(ctx.body?.secret_key, 'Secret Key', { max: 300 });
      const key = typed && typed !== '••••••' ? typed : stripeKeyOf(app);
      if (!key) throw bad('Noch kein Secret Key gespeichert');
      if (!isSecretKey(key)) throw bad('Secret Key: beginnt mit sk_live_, sk_test_ oder rk_…');
      return { ok: true, live: isLiveKey(key), account: await testKey(key) };
    });
    router.delete('/api/saas/settings/stripe', 'admin', () => {
      const s = settings();
      Object.assign(s, { secret_key: '', webhook_secret: '', key_hint: '', account_id: '', account_name: '', livemode: false, checked_at: null });
      saveSettings(app, s);
      return settingsOut();
    });

    // --- plans ------------------------------------------------------------------------
    /**
     * Creates/updates the plan's Stripe Product and one recurring Price per interval. Stripe
     * prices can't change, so a new amount means a new Price (the old one is archived;
     * running subscriptions keep their price until the plan is changed for them).
     */
    async function syncPlan(planId: string): Promise<Plan> {
      const plan = planById(app, planId)!;
      if (!stripeKeyOf(app)) return plan;
      try {
        const product = { name: plan.name, description: plan.description || undefined, active: !!plan.active, metadata: { saas_plan_id: plan.id } };
        let productId = plan.stripe_product_id;
        if (productId) await saasStripe(app, 'POST', `/v1/products/${encodeURIComponent(productId)}`, product);
        else productId = (await saasStripe(app, 'POST', '/v1/products', product, { idempotencyKey: `saas-product-${plan.id}` })).id;
        const synced: Record<string, any> = (plan as any).stripe_synced ?? {};
        const next: Record<string, string> = { stripe_product_id: productId };
        for (const interval of ['month', 'year'] as Interval[]) {
          const field = interval === 'month' ? 'stripe_price_month' : 'stripe_price_year';
          const want = priceOf(plan, interval);
          let priceId = plan[field];
          const same = synced[interval]?.amount === want && synced[interval]?.currency === plan.currency;
          if (priceId && !same) {
            await saasStripe(app, 'POST', `/v1/prices/${encodeURIComponent(priceId)}`, { active: false });
            priceId = '';
          }
          if (!priceId && want > 0) {
            priceId = (await saasStripe(app, 'POST', '/v1/prices', { product: productId, currency: plan.currency.toLowerCase(), unit_amount: want, recurring: { interval }, nickname: `${plan.name} (${interval === 'month' ? 'monatlich' : 'jährlich'})`, metadata: { saas_plan_id: plan.id, interval } })).id;
          }
          next[field] = priceId;
          synced[interval] = { amount: want, currency: plan.currency };
        }
        db.run(
          'UPDATE saas_plans SET stripe_product_id = ?, stripe_price_month = ?, stripe_price_year = ?, stripe_synced = ?, sync_error = ? WHERE id = ?',
          next.stripe_product_id, next.stripe_price_month, next.stripe_price_year, JSON.stringify(synced), '', plan.id,
        );
      } catch (e) {
        db.run('UPDATE saas_plans SET sync_error = ? WHERE id = ?', (e as Error).message.slice(0, 300), plan.id);
      }
      return planById(app, planId)!;
    }
    app.services.saasSyncPlan = syncPlan;

    /** The Stripe Price for a plan + interval, syncing first if needed. */
    async function priceIdFor(plan: Plan, interval: Interval): Promise<string> {
      let p = plan;
      const field = interval === 'month' ? 'stripe_price_month' : 'stripe_price_year';
      if (!p[field]) p = await syncPlan(plan.id);
      if (!p[field]) throw bad(p.sync_error ? `Stripe: ${p.sync_error}` : `Für „${plan.name}“ gibt es keinen ${interval === 'month' ? 'Monats' : 'Jahres'}preis`);
      return p[field];
    }
    app.services.saasPriceId = priceIdFor;

    const withCounts = (p: Plan) => ({
      ...planOut(p),
      subscribers: Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM saas_subscriptions WHERE plan_id = ? AND status != 'canceled'`, p.id)?.n ?? 0),
    });
    const allPlans = () => db.all<{ id: string }>('SELECT id FROM saas_plans ORDER BY sort, price_month_cents, name').map((r) => planById(app, r.id)!);

    router.get('/api/saas/plans', 'admin', () => allPlans().map(withCounts));
    router.post('/api/saas/plans', 'admin', async (ctx) => {
      let clean;
      try {
        clean = cleanPlan(ctx.body ?? {});
      } catch (e) {
        throw bad((e as Error).message);
      }
      if (clean.snapshot_id && !db.get('SELECT id FROM snapshots WHERE id = ?', clean.snapshot_id)) throw bad('Snapshot nicht gefunden');
      const row = { id: id(), ...clean, created_at: now(), updated_at: now() };
      db.insert('saas_plans', row);
      return withCounts(await syncPlan(row.id));
    });
    router.patch('/api/saas/plans/:id', 'admin', async (ctx) => {
      const cur = planById(app, ctx.params.id);
      if (!cur) throw notFound('Tarif nicht gefunden');
      let clean;
      try {
        clean = cleanPlan(ctx.body ?? {}, cur);
      } catch (e) {
        throw bad((e as Error).message);
      }
      if (clean.snapshot_id && !db.get('SELECT id FROM snapshots WHERE id = ?', clean.snapshot_id)) throw bad('Snapshot nicht gefunden');
      db.update('saas_plans', cur.id, { ...clean, updated_at: now() });
      if (clean.markup_percent === null) db.run('UPDATE saas_plans SET markup_percent = NULL WHERE id = ?', cur.id);
      if (clean.snapshot_id === null) db.run('UPDATE saas_plans SET snapshot_id = NULL WHERE id = ?', cur.id);
      return withCounts(await syncPlan(cur.id));
    });
    router.post('/api/saas/plans/:id/sync', 'admin', async (ctx) => {
      if (!planById(app, ctx.params.id)) throw notFound('Tarif nicht gefunden');
      if (!stripeKeyOf(app)) throw bad('Agentur-Stripe ist nicht verbunden');
      return withCounts(await syncPlan(ctx.params.id));
    });
    router.delete('/api/saas/plans/:id', 'admin', async (ctx) => {
      const p = planById(app, ctx.params.id);
      if (!p) throw notFound('Tarif nicht gefunden');
      if (db.get('SELECT location_id FROM saas_subscriptions WHERE plan_id = ? LIMIT 1', p.id)) throw bad('Der Tarif wird noch verwendet – erst die Sub-Accounts umstellen oder den Tarif nur deaktivieren');
      if (p.stripe_product_id && stripeKeyOf(app)) await saasStripe(app, 'POST', `/v1/products/${encodeURIComponent(p.stripe_product_id)}`, { active: false }).catch(() => undefined);
      db.run('DELETE FROM saas_plans WHERE id = ?', p.id);
      return { ok: true };
    });

    // --- sub-accounts on plans (agency) -------------------------------------------------
    const accountRow = (l: any) => {
      const acc = accountOf(app, l.id);
      return {
        location_id: l.id,
        name: l.name,
        plan: acc ? { id: acc.plan.id, name: acc.plan.name } : null,
        subscription: acc?.sub ?? null,
        mrr_cents: acc && PAYING.includes(acc.sub.status) ? monthlyValue(acc.plan, acc.sub.interval) : 0,
        usage: usageOf(app, l.id),
        limits: acc?.plan.limits ?? {},
      };
    };
    router.get('/api/saas/locations', 'admin', () => db.all('SELECT id, name FROM locations ORDER BY name').map(accountRow));
    router.get('/api/saas/locations/:id', 'admin', (ctx) => {
      const l = db.get('SELECT id, name FROM locations WHERE id = ?', ctx.params.id);
      if (!l) throw notFound('Sub-Account nicht gefunden');
      return { ...accountRow(l), counts: Object.fromEntries((['contacts', 'users', 'funnels', 'courses'] as StockKey[]).map((k) => [k, stockCount(app, l.id, k)])) };
    });

    /** Assign or change a plan: manually (no Stripe) or by switching the running Stripe subscription. */
    router.put('/api/saas/locations/:id', 'admin', async (ctx) => {
      const loc = app.location(ctx.params.id);
      if (!loc) throw notFound('Sub-Account nicht gefunden');
      const plan = planById(app, str(ctx.body?.plan_id, 'Tarif', { required: true }));
      if (!plan) throw bad('Tarif nicht gefunden');
      const cur = subscriptionOf(app, loc.id);
      const interval: Interval = ctx.body?.interval === 'year' ? 'year' : ctx.body?.interval === 'month' ? 'month' : (cur?.interval ?? 'month');
      const status = ctx.body?.status;
      if (status !== undefined && !['trialing', 'active', 'past_due', 'paused', 'canceled'].includes(status)) throw bad('Status unbekannt');
      const stripeLive = cur?.billing === 'stripe' && !!cur.stripe_subscription && cur.status !== 'canceled';
      if (stripeLive) {
        if (status !== undefined && status !== cur!.status) throw bad('Der Status kommt bei Stripe-Abos von Stripe');
        if (plan.id !== cur!.plan_id || interval !== cur!.interval) {
          const price = await priceIdFor(plan, interval);
          let item = cur!.stripe_item;
          if (!item) item = (await saasStripe(app, 'GET', `/v1/subscriptions/${encodeURIComponent(cur!.stripe_subscription)}`))?.items?.data?.[0]?.id ?? '';
          if (!item) throw new HttpError(502, 'Stripe-Abo ohne Position – bitte im Stripe-Dashboard prüfen');
          const sub = await saasStripe(app, 'POST', `/v1/subscriptions/${encodeURIComponent(cur!.stripe_subscription)}`, {
            items: [{ id: item, price }],
            proration_behavior: 'create_prorations',
            metadata: { saas_location_id: loc.id, plan_id: plan.id },
          });
          upsertSubscription(app, { ...fromStripeSub(app, sub, cur), location_id: loc.id, plan_id: plan.id, interval });
          logSaasEvent(app, loc.id, 'plan_changed', `${planById(app, cur!.plan_id)?.name ?? '?'} → ${plan.name} (Stripe)`);
        }
      } else {
        const nextStatus: SubStatus = status ?? (cur && cur.billing === 'manual' && cur.status !== 'canceled' ? cur.status : 'active');
        const life = transition(cur ?? { status: 'active', past_due_since: null, grace_until: null, paused_at: null, canceled_at: null }, nextStatus, new Date(), settings().grace_days);
        upsertSubscription(app, {
          location_id: loc.id,
          plan_id: plan.id,
          interval,
          billing: 'manual',
          stripe_subscription: '',
          stripe_item: '',
          cancel_at_period_end: 0,
          ...life,
        });
        logSaasEvent(app, loc.id, cur ? 'plan_changed' : 'plan_assigned', `${cur ? `${planById(app, cur.plan_id)?.name ?? '?'} → ` : ''}${plan.name} (ohne Stripe${status ? `, ${STATUS_LABEL[nextStatus]}` : ''})`);
        if (cur && cur.status !== nextStatus) logSaasEvent(app, loc.id, nextStatus, `Status von Hand: ${STATUS_LABEL[nextStatus]}`);
      }
      return accountRow(loc);
    });

    /** A Stripe Checkout link the agency sends to an existing customer to start paying for a plan. */
    router.post('/api/saas/locations/:id/checkout', 'admin', async (ctx) => {
      const loc = app.location(ctx.params.id);
      if (!loc) throw notFound('Sub-Account nicht gefunden');
      const plan = planById(app, str(ctx.body?.plan_id, 'Tarif', { required: true }));
      if (!plan) throw bad('Tarif nicht gefunden');
      const cur = subscriptionOf(app, loc.id);
      if (cur?.billing === 'stripe' && cur.stripe_subscription && cur.status !== 'canceled') throw bad('Dieser Sub-Account hat schon ein Stripe-Abo – Tarif einfach ändern');
      const interval: Interval = ctx.body?.interval === 'year' ? 'year' : 'month';
      const price = await priceIdFor(plan, interval);
      const email = normalizeEmail(ctx.body?.email ?? loc.email ?? '');
      const back = `${app.baseUrl()}/app/settings/subscription`;
      const meta = { saas_location_id: loc.id, plan_id: plan.id, interval };
      const session = await saasStripe(app, 'POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        ...(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { customer_email: email } : {}),
        client_reference_id: loc.id,
        success_url: `${back}?abo=ok`,
        cancel_url: back,
        metadata: meta,
        subscription_data: { metadata: meta, ...(plan.trial_days && ctx.body?.trial !== false ? { trial_period_days: plan.trial_days } : {}) },
        allow_promotion_codes: true,
      });
      if (!session?.url) throw new HttpError(502, 'Stripe hat keine Bezahlseite geliefert');
      logSaasEvent(app, loc.id, 'checkout_link', `${plan.name} (${interval === 'year' ? 'jährlich' : 'monatlich'})`);
      return { url: session.url, id: session.id };
    });

    /** Cancel (at period end or right away) or undo a scheduled cancellation. */
    async function cancel(locationId: string, opts: { undo?: boolean; now?: boolean }) {
      const cur = subscriptionOf(app, locationId);
      if (!cur) throw bad('Kein Tarif hinterlegt');
      if (cur.billing === 'stripe' && cur.stripe_subscription) {
        if (cur.status === 'canceled') throw bad('Das Abo ist schon beendet');
        const sub = opts.now
          ? await saasStripe(app, 'DELETE', `/v1/subscriptions/${encodeURIComponent(cur.stripe_subscription)}`)
          : await saasStripe(app, 'POST', `/v1/subscriptions/${encodeURIComponent(cur.stripe_subscription)}`, { cancel_at_period_end: !opts.undo });
        upsertSubscription(app, { ...fromStripeSub(app, sub, cur), location_id: locationId, plan_id: cur.plan_id });
      } else {
        if (!opts.now) throw bad('Ohne Stripe-Abo gibt es kein Laufzeitende – „sofort beenden“ wählen');
        upsertSubscription(app, { location_id: locationId, plan_id: cur.plan_id, ...transition(cur, 'canceled', new Date(), settings().grace_days) });
      }
      logSaasEvent(app, locationId, opts.undo ? 'cancel_undone' : opts.now ? 'canceled' : 'cancel_scheduled', opts.undo ? 'Kündigung zurückgenommen' : opts.now ? 'Abo sofort beendet' : 'Kündigung zum Laufzeitende');
      return subscriptionOf(app, locationId)!;
    }
    router.post('/api/saas/locations/:id/cancel', 'admin', async (ctx) => {
      if (!app.location(ctx.params.id)) throw notFound('Sub-Account nicht gefunden');
      return cancel(ctx.params.id, { undo: !!ctx.body?.undo, now: !!ctx.body?.now });
    });
    router.delete('/api/saas/locations/:id', 'admin', (ctx) => {
      const cur = subscriptionOf(app, ctx.params.id);
      if (!cur) return { ok: true };
      if (cur.billing === 'stripe' && cur.stripe_subscription && cur.status !== 'canceled') throw bad('Erst das Stripe-Abo beenden (sofort oder zum Laufzeitende), dann den Tarif entfernen');
      db.run('DELETE FROM saas_subscriptions WHERE location_id = ?', ctx.params.id);
      logSaasEvent(app, ctx.params.id, 'plan_removed', planById(app, cur.plan_id)?.name ?? '');
      return { ok: true };
    });

    // --- the sub-account's own view ("Abo & Rechnung", banner, hidden navigation) --------
    const isCustomer = (u: User | undefined) => !u || u.role !== 'admin';
    function accountView(locationId: string, user: User | undefined) {
      const acc = accountOf(app, locationId);
      const brand = getBranding(app);
      if (!acc) return { plan: null, blocked: [], banner: null, support_email: brand.support_email };
      const { sub, plan } = acc;
      const counts = Object.fromEntries((['contacts', 'users', 'funnels', 'courses'] as StockKey[]).map((k) => [k, stockCount(app, locationId, k)]));
      const off = disabledAreas(plan);
      return {
        plan: { id: plan.id, name: plan.name, description: plan.description, currency: plan.currency, price_cents: priceOf(plan, sub.interval), interval: sub.interval, features: plan.features, limits: plan.limits, overage: plan.overage },
        status: sub.status,
        status_label: STATUS_LABEL[sub.status],
        billing: sub.billing,
        current_period_end: sub.current_period_end,
        trial_end: sub.trial_end,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        grace_until: sub.grace_until,
        read_only: isReadOnly(sub.status),
        usage: usageOf(app, locationId),
        counts,
        disabled_areas: off.map((k) => ({ key: k, label: PERMISSIONS[k] })),
        // Agency admins are never restricted; customers don't see what their plan leaves out.
        blocked: isCustomer(user) ? off : [],
        banner: bannerFor(sub, plan),
        portal: sub.billing === 'stripe' && !!sub.stripe_customer,
        support_email: brand.support_email,
      };
    }
    router.get('/api/saas/account', 'location', (ctx) => accountView(ctx.locationId, ctx.user));
    router.post('/api/saas/account/portal', 'location', async (ctx) => {
      const sub = subscriptionOf(app, ctx.locationId);
      if (!sub || sub.billing !== 'stripe' || !sub.stripe_customer) throw bad('Für dieses Konto gibt es kein Stripe-Abo – bitte an deine Agentur wenden');
      const r = await saasStripe(app, 'POST', '/v1/billing_portal/sessions', { customer: sub.stripe_customer, return_url: `${app.baseUrl()}/app/settings/subscription` });
      if (!r?.url) throw new HttpError(502, 'Stripe hat keinen Portal-Link geliefert');
      return { url: r.url };
    });
    router.post('/api/saas/account/cancel', 'location', async (ctx) => {
      const sub = subscriptionOf(app, ctx.locationId);
      if (!sub || sub.billing !== 'stripe') throw bad('Bitte wende dich zur Kündigung an deine Agentur');
      await cancel(ctx.locationId, { undo: !!ctx.body?.undo });
      return accountView(ctx.locationId, ctx.user);
    });

    // --- webhook (agency Stripe) --------------------------------------------------------
    async function onCheckout(session: any) {
      if (session?.mode !== 'subscription') return { handled: 'ignored' };
      const md = session.metadata ?? {};
      if (md.saas_signup_id) return (await app.services.saasCompleteSignup?.(session)) ?? { handled: 'ignored' };
      // Cloud mode: the signup of the hosted service (modules/cloud-signup.ts) provisions its own tenant.
      if (md.cloud_signup_id) return (await app.services.cloudCompleteSignup?.(session)) ?? { handled: 'ignored' };
      const loc = md.saas_location_id ? app.location(String(md.saas_location_id)) : undefined;
      const plan = planById(app, md.plan_id);
      if (!loc || !plan) return { handled: 'ignored' };
      const cur = subscriptionOf(app, loc.id);
      const subObj = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
      const subId = String(subObj?.id ?? session.subscription ?? '');
      if (cur && cur.stripe_subscription === subId && cur.status !== 'canceled') return { handled: 'duplicate' };
      const sub = subObj ?? (await fetchSubscription(app, subId));
      const fields = sub ? fromStripeSub(app, sub) : { billing: 'stripe' as const, status: (plan.trial_days ? 'trialing' : 'active') as SubStatus, stripe_subscription: subId, stripe_customer: String(session.customer ?? '') };
      upsertSubscription(app, {
        location_id: loc.id,
        plan_id: plan.id,
        interval: md.interval === 'year' ? 'year' : 'month',
        past_due_since: null,
        grace_until: null,
        paused_at: null,
        canceled_at: null,
        ...fields,
        email: normalizeEmail(session.customer_details?.email || session.customer_email || ''),
      });
      logSaasEvent(app, loc.id, 'subscribed', `${plan.name} per Stripe`);
      return { handled: 'subscribed', locationId: loc.id };
    }

    function syncSubscription(sub: any) {
      let cur = db.get<Subscription>('SELECT * FROM saas_subscriptions WHERE stripe_subscription = ?', String(sub?.id ?? ''));
      if (!cur && sub?.metadata?.saas_location_id) {
        const byLoc = subscriptionOf(app, String(sub.metadata.saas_location_id));
        if (byLoc && (!byLoc.stripe_subscription || byLoc.status === 'canceled')) cur = byLoc;
      }
      if (!cur) return { handled: 'ignored' };
      const fields = fromStripeSub(app, sub, cur);
      if (cur.stripe_subscription && fields.stripe_subscription !== cur.stripe_subscription && cur.status !== 'canceled') return { handled: 'ignored' };
      const next = upsertSubscription(app, { ...fields, location_id: cur.location_id, plan_id: fields.plan_id ?? cur.plan_id });
      if (next.status !== cur.status) logSaasEvent(app, cur.location_id, next.status === 'active' && ['past_due', 'paused'].includes(cur.status) ? 'reactivated' : next.status, `Stripe: ${STATUS_LABEL[cur.status]} → ${STATUS_LABEL[next.status]}`);
      if (next.plan_id !== cur.plan_id) logSaasEvent(app, cur.location_id, 'plan_changed', `${planById(app, cur.plan_id)?.name ?? '?'} → ${planById(app, next.plan_id)?.name ?? '?'} (Stripe)`);
      if (next.cancel_at_period_end !== cur.cancel_at_period_end) logSaasEvent(app, cur.location_id, next.cancel_at_period_end ? 'cancel_scheduled' : 'cancel_undone', next.cancel_at_period_end ? 'Kündigung zum Laufzeitende (Stripe)' : 'Kündigung zurückgenommen (Stripe)');
      return { handled: 'subscription_synced', locationId: cur.location_id, status: next.status };
    }

    function onInvoice(inv: any, paid: boolean) {
      const subId = String(inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? '');
      const cur = subId ? db.get<Subscription>('SELECT * FROM saas_subscriptions WHERE stripe_subscription = ?', subId) : undefined;
      if (!cur) return { handled: 'ignored' };
      if (paid) {
        if (!['past_due', 'paused'].includes(cur.status)) return { handled: 'paid' };
        upsertSubscription(app, { location_id: cur.location_id, plan_id: cur.plan_id, ...transition(cur, 'active', new Date(), settings().grace_days) });
        logSaasEvent(app, cur.location_id, 'reactivated', 'Zahlung eingegangen – Konto wieder aktiv');
        return { handled: 'reactivated', locationId: cur.location_id };
      }
      const next = upsertSubscription(app, { location_id: cur.location_id, plan_id: cur.plan_id, ...transition(cur, 'past_due', new Date(), settings().grace_days) });
      if (cur.status !== next.status) logSaasEvent(app, cur.location_id, 'past_due', `Zahlung fehlgeschlagen – Kulanz bis ${fmtDate(next.grace_until)}`);
      return { handled: 'payment_failed', locationId: cur.location_id, status: next.status };
    }

    async function handleEvent(event: any) {
      const o = event.data?.object ?? {};
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          return onCheckout(o);
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.paused':
        case 'customer.subscription.resumed':
          return syncSubscription(o);
        case 'customer.subscription.deleted':
          return syncSubscription({ ...o, status: 'canceled' });
        case 'invoice.payment_failed':
          return onInvoice(o, false);
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          return onInvoice(o, true);
        default:
          return { handled: 'ignored' };
      }
    }

    router.post('/hooks/stripe-agency', 'public', async (ctx) => {
      const s = settings();
      if (!s.webhook_secret) throw notFound('SaaS-Stripe ist nicht eingerichtet');
      const check = verifyStripeSignature(ctx.rawBody, String(ctx.req.headers['stripe-signature'] ?? ''), openSecret(app, s.webhook_secret));
      if (!check.ok) throw bad(`Ungültige Stripe-Signatur: ${check.reason}`);
      let event: any;
      try {
        event = JSON.parse(ctx.rawBody);
      } catch {
        throw bad('Ungültiges JSON');
      }
      if (typeof event?.id !== 'string' || typeof event?.type !== 'string') throw bad('Kein Stripe-Ereignis');
      if (!db.run('INSERT OR IGNORE INTO saas_stripe_events (id, type, received_at) VALUES (?, ?, ?)', event.id, event.type, now()).changes) return { received: true, duplicate: true };
      try {
        const result = await handleEvent(event);
        // Other modules (cloud mode: lifecycle mails, invoices, conversion numbers) look at every event once it is handled.
        for (const tap of (app.services.saasEventTaps ?? []) as ((event: any, result: any) => void | Promise<void>)[]) {
          try {
            await tap(event, result);
          } catch (err) {
            console.error('[saas] event tap', (err as Error).message);
          }
        }
        return { received: true, ...result };
      } catch (e) {
        // Not marked as seen: Stripe's retry gets another go.
        db.run('DELETE FROM saas_stripe_events WHERE id = ?', event.id);
        throw e;
      }
    });

    // --- usage rebilling ------------------------------------------------------------------
    /**
     * For every finished month: usage above the plan's included amount (where the plan says
     * "bill") becomes a Stripe invoice item on the customer's next subscription invoice, priced
     * at the agency's unit cost plus markup. One report row per location/month/metric; the
     * idempotency key makes a retry after an error safe.
     */
    async function reportUsage(at = new Date()) {
      const out: any[] = [];
      if (!stripeKeyOf(app)) return out;
      const s = settings();
      const month = monthKey(at);
      for (const sub of db.all<Subscription>(`SELECT * FROM saas_subscriptions WHERE billing = 'stripe' AND stripe_customer != ''`)) {
        const plan = planById(app, sub.plan_id);
        if (!plan) continue;
        const rows = db.all(
          `SELECT u.* FROM saas_usage u LEFT JOIN saas_usage_reports r ON r.location_id = u.location_id AND r.month = u.month AND r.metric = u.metric
           WHERE u.location_id = ? AND u.month < ? AND (r.location_id IS NULL OR (r.stripe_id = '' AND r.amount_cents > 0))`,
          sub.location_id, month,
        );
        for (const u of rows) {
          const metric = u.metric as UsageKey;
          if (!USAGE_KEYS.includes(metric)) continue;
          const billable = plan.overage?.[metric] === 'bill' && u.month >= sub.created_at.slice(0, 7);
          const c = billable ? overageCharge(Number(u.count), limitOf(plan, metric), s.unit_cost[metric], plan.markup_percent ?? s.markup_percent) : { qty: 0, unit_cents: 0, amount_cents: 0 };
          let stripeId = '';
          let error = '';
          if (c.amount_cents > 0) {
            try {
              const item = await saasStripe(
                app,
                'POST',
                '/v1/invoiceitems',
                {
                  customer: sub.stripe_customer,
                  ...(sub.stripe_subscription && sub.status !== 'canceled' ? { subscription: sub.stripe_subscription } : {}),
                  currency: plan.currency.toLowerCase(),
                  amount: c.amount_cents,
                  description: `Mehrverbrauch ${LIMITS[metric as LimitKey].replace(' pro Monat', '')} ${u.month}: ${c.qty.toLocaleString('de-DE')} über Inklusiv-Kontingent`,
                  metadata: { saas_location_id: sub.location_id, month: u.month, metric, quantity: String(c.qty) },
                },
                { idempotencyKey: `saas-usage-${sub.location_id}-${u.month}-${metric}` },
              );
              stripeId = String(item?.id ?? '');
            } catch (e) {
              error = (e as Error).message.slice(0, 300);
            }
          }
          db.run(
            `INSERT INTO saas_usage_reports (location_id, month, metric, quantity, amount_cents, currency, stripe_id, error, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(location_id, month, metric) DO UPDATE SET quantity = excluded.quantity, amount_cents = excluded.amount_cents, stripe_id = excluded.stripe_id, error = excluded.error, reported_at = excluded.reported_at`,
            sub.location_id, u.month, metric, c.qty, c.amount_cents, plan.currency, stripeId, error, now(),
          );
          if (c.amount_cents > 0) {
            out.push({ location_id: sub.location_id, month: u.month, metric, quantity: c.qty, amount_cents: c.amount_cents, stripe_id: stripeId, error });
            if (stripeId) logSaasEvent(app, sub.location_id, 'usage_billed', `${c.qty} ${metric} (${u.month}) → ${(c.amount_cents / 100).toFixed(2)} ${plan.currency}`);
          }
        }
      }
      return out;
    }
    app.services.saasReportUsage = reportUsage;
    router.post('/api/saas/usage/report', 'admin', async () => ({ items: await reportUsage() }));
    router.get('/api/saas/usage/reports', 'admin', () => db.all('SELECT r.*, l.name AS location_name FROM saas_usage_reports r LEFT JOIN locations l ON l.id = r.location_id WHERE r.amount_cents > 0 ORDER BY r.month DESC, r.reported_at DESC LIMIT 200'));

    // --- lifecycle: grace period → paused; hourly usage report --------------------------------
    let lastReport = 0;
    app.onTick(async () => {
      const at = new Date();
      for (const sub of db.all<Subscription>(`SELECT * FROM saas_subscriptions WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until <= ?`, at.toISOString())) {
        if (!graceExpired(sub, at)) continue;
        upsertSubscription(app, { location_id: sub.location_id, plan_id: sub.plan_id, ...transition(sub, 'paused', at, settings().grace_days) });
        logSaasEvent(app, sub.location_id, 'paused', 'Kulanzzeit abgelaufen – Konto pausiert (nur lesen)');
      }
      if (Date.now() - lastReport < 3600_000) return;
      lastReport = Date.now();
      await reportUsage(at);
      db.run('DELETE FROM saas_stripe_events WHERE received_at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
    });

    // --- agency dashboard ------------------------------------------------------------------
    router.get('/api/saas/overview', 'admin', () => {
      const subs = db.all<Subscription & { name: string }>('SELECT s.*, l.name FROM saas_subscriptions s JOIN locations l ON l.id = s.location_id');
      const plans = new Map(allPlans().map((p) => [p.id, p]));
      const counts: Record<SubStatus, number> = { trialing: 0, active: 0, past_due: 0, paused: 0, canceled: 0 };
      const byPlan = new Map<string, { id: string; name: string; count: number; mrr_cents: number; trialing: number }>();
      for (const p of plans.values()) byPlan.set(p.id, { id: p.id, name: p.name, count: 0, mrr_cents: 0, trialing: 0 });
      let mrr = 0;
      let currency = '';
      for (const s of subs) {
        counts[s.status] = (counts[s.status] ?? 0) + 1;
        const p = plans.get(s.plan_id);
        if (!p) continue;
        const bp = byPlan.get(p.id)!;
        if (s.status !== 'canceled') bp.count++;
        if (s.status === 'trialing') bp.trialing++;
        if (PAYING.includes(s.status)) {
          const v = monthlyValue(p, s.interval);
          mrr += v;
          bp.mrr_cents += v;
          currency ||= p.currency;
        }
      }
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const lost = Number(db.get<{ n: number }>(`SELECT COUNT(DISTINCT location_id) AS n FROM saas_events WHERE type = 'canceled' AND at >= ?`, since)?.n ?? 0);
      const newAccounts = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM saas_subscriptions WHERE created_at >= ?`, since)?.n ?? 0);
      const horizon = new Date(Date.now() + 30 * 864e5).toISOString();
      const renewals = subs
        .filter((s) => s.current_period_end && s.current_period_end >= now() && s.current_period_end <= horizon && ['active', 'trialing', 'past_due'].includes(s.status))
        .sort((a, b) => a.current_period_end!.localeCompare(b.current_period_end!))
        .slice(0, 25)
        .map((s) => {
          const p = plans.get(s.plan_id);
          return { location_id: s.location_id, name: s.name, plan: p?.name ?? '', date: s.current_period_end, amount_cents: p ? priceOf(p, s.interval) : 0, currency: p?.currency ?? 'EUR', interval: s.interval, status: s.status, ends: !!s.cancel_at_period_end };
        });
      return {
        currency: currency || allPlans()[0]?.currency || 'EUR',
        mrr_cents: mrr,
        arr_cents: mrr * 12,
        counts,
        total: subs.length,
        new_30d: newAccounts,
        churn: { lost_30d: lost, rate_percent: churnRate(lost, counts.active + counts.past_due) },
        plans: [...byPlan.values()],
        renewals,
        accounts: subs
          .map((s) => ({ location_id: s.location_id, name: s.name, plan: plans.get(s.plan_id)?.name ?? '', status: s.status, billing: s.billing, interval: s.interval, current_period_end: s.current_period_end, cancel_at_period_end: !!s.cancel_at_period_end, mrr_cents: PAYING.includes(s.status) && plans.get(s.plan_id) ? monthlyValue(plans.get(s.plan_id)!, s.interval) : 0 }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        events: db.all('SELECT e.*, l.name AS location_name FROM saas_events e LEFT JOIN locations l ON l.id = e.location_id ORDER BY e.at DESC LIMIT 30'),
        stripe_connected: !!settings().secret_key,
      };
    });
  },
};

