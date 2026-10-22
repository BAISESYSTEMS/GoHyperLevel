import { PERMISSIONS, type Permission } from '../core/permissions.js';

/**
 * SaaS mode (agency resells sub-accounts): plan shape, limits, usage months, the billing
 * lifecycle (Stripe status → our status, grace period, pause) and the money maths for
 * usage rebilling and MRR. Pure functions – the modules saas.ts / saas-gate.ts / saas-signup.ts
 * do the I/O.
 */

/** Countable things a plan can limit. Stock = how many exist now; usage = how many per month. */
export const LIMITS = {
  contacts: 'Kontakte',
  users: 'Nutzer',
  funnels: 'Funnels & Websites',
  courses: 'Kurse',
  emails: 'E-Mails pro Monat',
  sms: 'SMS pro Monat',
  ai: 'KI-Aufrufe pro Monat',
} as const;
export type LimitKey = keyof typeof LIMITS;
export const USAGE_KEYS = ['emails', 'sms', 'ai'] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];
export const STOCK_KEYS = ['contacts', 'users', 'funnels', 'courses'] as const;
export type StockKey = (typeof STOCK_KEYS)[number];

/** Short unit names for messages ("500 E-Mails", "3 Nutzer"). */
const UNIT: Record<LimitKey, string> = { contacts: 'Kontakte', users: 'Nutzer', funnels: 'Funnels/Websites', courses: 'Kurse', emails: 'E-Mails', sms: 'SMS', ai: 'KI-Aufrufe' };

/** Areas that are always on: the customer must always reach "Abo & Rechnung". */
export const ALWAYS_ON: Permission[] = ['settings'];

export type Interval = 'month' | 'year';
export type Overage = 'block' | 'bill';
export type SubStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'canceled';

export interface Plan {
  id: string;
  name: string;
  description: string;
  currency: string;
  price_month_cents: number;
  price_year_cents: number;
  trial_days: number;
  /** Areas (permission keys) the plan includes. */
  features: Permission[];
  /** null / missing = unlimited. */
  limits: Partial<Record<LimitKey, number | null>>;
  /** What happens above the included monthly amount: block (default) or bill to Stripe. */
  overage: Partial<Record<UsageKey, Overage>>;
  /** Markup on the agency's unit cost for rebilled usage; null = agency default. */
  markup_percent: number | null;
  snapshot_id: string | null;
  public: number;
  active: number;
  sort: number;
  stripe_product_id: string;
  stripe_price_month: string;
  stripe_price_year: string;
  sync_error: string;
}

export interface Subscription {
  location_id: string;
  plan_id: string;
  interval: Interval;
  status: SubStatus;
  billing: 'stripe' | 'manual';
  stripe_customer: string;
  stripe_subscription: string;
  stripe_item: string;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: number;
  past_due_since: string | null;
  grace_until: string | null;
  paused_at: string | null;
  canceled_at: string | null;
  email: string;
  created_at: string;
  updated_at: string;
}

// --- plan input -------------------------------------------------------------------

const money = (v: unknown, field: string): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Math.round(Number(String(v).replace(',', '.')) * 100);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_00) throw new Error(`${field}: bitte einen Betrag zwischen 0 und 100.000 angeben`);
  return n;
};
const count = (v: unknown, field: string): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100_000_000) throw new Error(`${field}: bitte eine ganze Zahl ab 0 (leer = unbegrenzt)`);
  return n;
};

/**
 * Validates a plan from the browser. Prices arrive in euros (`price_month: "49"`) or cents
 * (`price_month_cents`); limits as numbers or empty for unlimited. Throws German messages.
 */
export function cleanPlan(b: any, cur?: Partial<Plan>): Omit<Plan, 'id' | 'stripe_product_id' | 'stripe_price_month' | 'stripe_price_year' | 'sync_error'> {
  const name = String(b.name ?? cur?.name ?? '').trim();
  if (!name) throw new Error('Name des Tarifs fehlt');
  if (name.length > 80) throw new Error('Name ist zu lang');
  const pick = (k: 'month' | 'year') => {
    if (b[`price_${k}_cents`] !== undefined) {
      const n = Number(b[`price_${k}_cents`]);
      if (!Number.isInteger(n) || n < 0 || n > 100_000_00) throw new Error('Preis ungültig');
      return n;
    }
    if (b[`price_${k}`] !== undefined) return money(b[`price_${k}`], k === 'month' ? 'Preis pro Monat' : 'Preis pro Jahr');
    return cur?.[`price_${k}_cents`] ?? 0;
  };
  const trial = b.trial_days !== undefined ? Number(b.trial_days || 0) : (cur?.trial_days ?? 0);
  if (!Number.isInteger(trial) || trial < 0 || trial > 365) throw new Error('Testphase: 0 bis 365 Tage');
  let features: Permission[] = cur?.features ?? (Object.keys(PERMISSIONS) as Permission[]);
  if (b.features !== undefined) {
    if (!Array.isArray(b.features)) throw new Error('Bereiche als Liste');
    features = b.features.map(String).filter((p: string): p is Permission => p in PERMISSIONS);
  }
  for (const p of ALWAYS_ON) if (!features.includes(p)) features.push(p);
  const limits: Plan['limits'] = { ...(cur?.limits ?? {}) };
  if (b.limits !== undefined) {
    if (!b.limits || typeof b.limits !== 'object') throw new Error('Limits als Objekt');
    for (const k of Object.keys(LIMITS) as LimitKey[]) if (k in b.limits) limits[k] = count(b.limits[k], LIMITS[k]);
  }
  const overage: Plan['overage'] = { ...(cur?.overage ?? {}) };
  if (b.overage !== undefined) {
    for (const k of USAGE_KEYS) if (b.overage?.[k] !== undefined) overage[k] = b.overage[k] === 'bill' ? 'bill' : 'block';
  }
  let markup = cur?.markup_percent ?? null;
  if (b.markup_percent !== undefined) {
    markup = b.markup_percent === null || b.markup_percent === '' ? null : Number(b.markup_percent);
    if (markup !== null && (!Number.isFinite(markup) || markup < 0 || markup > 1000)) throw new Error('Aufschlag: 0 bis 1000 %');
  }
  const currency = String(b.currency ?? cur?.currency ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Währung als ISO-Code, z. B. EUR');
  const price_month_cents = pick('month');
  const price_year_cents = pick('year');
  return {
    name,
    description: String(b.description ?? cur?.description ?? '').trim().slice(0, 500),
    currency,
    price_month_cents,
    price_year_cents,
    trial_days: trial,
    features,
    limits,
    overage,
    markup_percent: markup,
    snapshot_id: b.snapshot_id !== undefined ? (b.snapshot_id ? String(b.snapshot_id) : null) : (cur?.snapshot_id ?? null),
    public: b.public !== undefined ? (b.public ? 1 : 0) : (cur?.public ?? 1),
    active: b.active !== undefined ? (b.active ? 1 : 0) : (cur?.active ?? 1),
    sort: b.sort !== undefined ? Number(b.sort) || 0 : (cur?.sort ?? 0),
  };
}

/** Prices a customer can actually choose: a 0 price only counts when the other one is 0 too (free plan). */
export function intervalsOf(p: Pick<Plan, 'price_month_cents' | 'price_year_cents'>): Interval[] {
  if (!p.price_month_cents && !p.price_year_cents) return ['month'];
  return (['month', 'year'] as Interval[]).filter((i) => (i === 'month' ? p.price_month_cents : p.price_year_cents) > 0);
}
export const isFree = (p: Pick<Plan, 'price_month_cents' | 'price_year_cents'>) => !p.price_month_cents && !p.price_year_cents;
export const priceOf = (p: Pick<Plan, 'price_month_cents' | 'price_year_cents'>, i: Interval) => (i === 'year' ? p.price_year_cents : p.price_month_cents);

// --- months ------------------------------------------------------------------------

/** Usage is counted per calendar month (UTC), key "YYYY-MM". */
export const monthKey = (d: Date = new Date()) => d.toISOString().slice(0, 7);
export function prevMonth(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// --- limits ------------------------------------------------------------------------

export const limitOf = (plan: Pick<Plan, 'limits'> | undefined, k: LimitKey): number | null => {
  const v = plan?.limits?.[k];
  return v === undefined || v === null ? null : Number(v);
};

const fmt = (n: number) => n.toLocaleString('de-DE');

/** "Limit erreicht" with what is included and where to upgrade. */
export function limitMessage(k: LimitKey, limit: number, planName: string): string {
  const what = USAGE_KEYS.includes(k as UsageKey) ? `${fmt(limit)} ${UNIT[k]} pro Monat` : `${fmt(limit)} ${UNIT[k]}`;
  return `Limit erreicht: Dein Tarif „${planName}“ enthält ${what}. Für mehr bitte auf einen größeren Tarif wechseln (Einstellungen → Abo & Rechnung).`;
}
export function featureMessage(area: Permission, planName: string): string {
  return `„${PERMISSIONS[area]}“ ist in deinem Tarif „${planName}“ nicht enthalten. Für diesen Bereich bitte auf einen größeren Tarif wechseln (Einstellungen → Abo & Rechnung).`;
}
export function readOnlyMessage(status: SubStatus): string {
  return status === 'canceled'
    ? 'Dein Abo ist beendet – das Konto ist nur noch lesbar. Für ein neues Abo melde dich bitte bei deiner Agentur.'
    : 'Dein Konto ist pausiert, weil eine Zahlung offen ist – alles ist lesbar, Änderungen sind gesperrt. Bitte unter Einstellungen → Abo & Rechnung die Zahlung erledigen.';
}

/** Read-only states: everything visible, nothing changeable (for customer logins and keys). */
export const isReadOnly = (s: SubStatus | undefined) => s === 'paused' || s === 'canceled';

/** Areas the plan switches off (never the always-on ones). */
export function disabledAreas(plan: Pick<Plan, 'features'> | undefined): Permission[] {
  if (!plan) return [];
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => !ALWAYS_ON.includes(p) && !plan.features.includes(p));
}

// --- lifecycle -----------------------------------------------------------------------

/** Stripe's subscription status in our words. */
export function mapStripeStatus(s: string): SubStatus {
  switch (s) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'incomplete':
      return 'past_due';
    case 'unpaid':
    case 'paused':
      return 'paused';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'active';
  }
}

type LifecycleFields = Pick<Subscription, 'status' | 'past_due_since' | 'grace_until' | 'paused_at' | 'canceled_at'>;

/**
 * Applies a new status from Stripe (or a payment event) to the stored one:
 * - past_due starts the grace period once (repeated failures don't extend it),
 * - a past_due from Stripe never un-pauses an account we already paused after the grace period,
 * - active/trialing clears everything (reactivated on payment),
 * - canceled is final until a new subscription.
 */
export function transition(cur: LifecycleFields, next: SubStatus, at: Date, graceDays: number): LifecycleFields {
  const iso = at.toISOString();
  if (next === 'active' || next === 'trialing') return { status: next, past_due_since: null, grace_until: null, paused_at: null, canceled_at: null };
  if (next === 'canceled') return { ...cur, status: 'canceled', canceled_at: cur.canceled_at ?? iso };
  if (next === 'paused') return { ...cur, status: 'paused', paused_at: cur.paused_at ?? iso, past_due_since: cur.past_due_since ?? iso };
  // past_due
  if (cur.status === 'paused') return cur;
  const since = cur.status === 'past_due' && cur.past_due_since ? cur.past_due_since : iso;
  const grace = cur.status === 'past_due' && cur.grace_until ? cur.grace_until : new Date(at.getTime() + graceDays * 864e5).toISOString();
  return { status: 'past_due', past_due_since: since, grace_until: grace, paused_at: null, canceled_at: null };
}

/** Grace period over → paused (read-only). */
export const graceExpired = (s: Pick<Subscription, 'status' | 'grace_until'>, at: Date) => s.status === 'past_due' && !!s.grace_until && s.grace_until <= at.toISOString();

// --- money ----------------------------------------------------------------------------

/**
 * Usage above the included amount, priced at the agency's unit cost plus markup.
 * unitCostCents may be fractional (e.g. 0.1 ct per e-mail); the total is rounded to cents.
 */
export function overageCharge(used: number, included: number | null, unitCostCents: number, markupPercent: number) {
  const qty = included === null ? 0 : Math.max(0, used - included);
  const unit = Math.max(0, unitCostCents) * (1 + Math.max(0, markupPercent) / 100);
  return { qty, unit_cents: Math.round(unit * 10000) / 10000, amount_cents: Math.round(qty * unit) };
}

/** Monthly recurring value of one subscription (yearly plans count a twelfth). */
export function monthlyValue(p: Pick<Plan, 'price_month_cents' | 'price_year_cents'>, interval: Interval): number {
  return interval === 'year' ? Math.round(p.price_year_cents / 12) : p.price_month_cents;
}

/** Statuses that bring in money right now (MRR). */
export const PAYING: SubStatus[] = ['active', 'past_due'];

/** Churn over a window: lost / (still paying + lost), in percent with one decimal. */
export function churnRate(lost: number, paying: number): number {
  const base = lost + paying;
  return base ? Math.round((lost / base) * 1000) / 10 : 0;
}

/** Period end from a Stripe subscription (newer API versions keep it on the item). */
export function periodEnd(sub: any): string | null {
  const t = Number(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? 0);
  return t > 0 ? new Date(t * 1000).toISOString() : null;
}
export const unixIso = (t: unknown) => (Number(t) > 0 ? new Date(Number(t) * 1000).toISOString() : null);
