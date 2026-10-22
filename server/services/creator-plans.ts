import { bad } from '../core/http.js';
import { MIN_AMOUNT_CENTS } from './stripe.js';
import { addPeriod, money } from './creator-kit.js';

/**
 * Payment plans (Ratenzahlung): "N × amount at an interval", optionally with a different first payment. Pure helpers –
 * validation, the schedule, the labels buyers see ("3 × 99,00 € monatlich" next to "297,00 € einmalig") and the date at
 * which Stripe ends the subscription on its own. Amounts are gross (what the buyer pays); the invoice maths happens in
 * the module.
 */

export type PlanInterval = 'week' | 'month';
export type OnDefault = 'pause' | 'revoke' | 'keep';

export interface PlanLike {
  installments: number;
  interval: PlanInterval;
  interval_count: number;
  amount_cents: number;
  first_amount_cents?: number | null;
}

export const MAX_INSTALLMENTS = 60;

export const ON_DEFAULT_LABEL: Record<OnDefault, string> = {
  pause: 'Zugang pausieren (kommt zurück, sobald gezahlt wird)',
  revoke: 'Zugang entziehen',
  keep: 'Zugang behalten (nur benachrichtigen)',
};

/** Validated plan fields from a request body (`cur` fills what the body leaves out, for PATCH). */
export function cleanPlan(b: any, cur?: Partial<PlanLike> & { name?: string; on_default?: string; active?: number | boolean }) {
  const v = { ...(cur ?? {}), ...(b ?? {}) } as Record<string, any>;
  const installments = Math.round(Number(v.installments));
  if (!Number.isFinite(installments) || installments < 2 || installments > MAX_INSTALLMENTS) throw bad(`Raten: 2 bis ${MAX_INSTALLMENTS}`);
  const interval: PlanInterval = v.interval === 'week' ? 'week' : 'month';
  const count = Math.round(Number(v.interval_count ?? 1));
  if (!Number.isFinite(count) || count < 1 || count > (interval === 'week' ? 52 : 12)) throw bad(interval === 'week' ? 'Abstand: 1 bis 52 Wochen' : 'Abstand: 1 bis 12 Monate');
  const amount = Math.round(Number(v.amount_cents));
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT_CENTS) throw bad('Rate: mindestens 0,50 €');
  const rawFirst = v.first_amount_cents;
  let first: number | null = null;
  if (rawFirst !== null && rawFirst !== undefined && rawFirst !== '') {
    first = Math.round(Number(rawFirst));
    if (!Number.isFinite(first) || first < MIN_AMOUNT_CENTS) throw bad('Erste Rate: mindestens 0,50 €');
    if (first === amount) first = null;
  }
  const onDefault = String(v.on_default ?? 'pause');
  if (!['pause', 'revoke', 'keep'].includes(onDefault)) throw bad('Bei Zahlungsausfall: pause, revoke oder keep');
  return { installments, interval, interval_count: count, amount_cents: amount, first_amount_cents: first, on_default: onDefault as OnDefault, name: String(v.name ?? '').trim().slice(0, 120) };
}

export const totalCents = (p: PlanLike) => (p.first_amount_cents ?? p.amount_cents) + (p.installments - 1) * p.amount_cents;

export function intervalLabel(p: Pick<PlanLike, 'interval' | 'interval_count'>): string {
  const n = p.interval_count;
  if (p.interval === 'week') return n === 1 ? 'wöchentlich' : `alle ${n} Wochen`;
  return n === 1 ? 'monatlich' : n === 12 ? 'jährlich' : `alle ${n} Monate`;
}

/** "3 × 99,00 € monatlich" – with a different first payment "150,00 € + 2 × 99,00 € monatlich". */
export function planLabel(p: PlanLike, currency = 'EUR'): string {
  const every = intervalLabel(p);
  if (p.first_amount_cents && p.first_amount_cents !== p.amount_cents) {
    return p.installments === 2 ? `${money(p.first_amount_cents, currency)} + ${money(p.amount_cents, currency)} ${every}` : `${money(p.first_amount_cents, currency)} + ${p.installments - 1} × ${money(p.amount_cents, currency)} ${every}`;
  }
  return `${p.installments} × ${money(p.amount_cents, currency)} ${every}`;
}

/** The buyer's choice as one line each: the plan and the lump sum. */
export const lumpLabel = (gross: number, currency = 'EUR') => `${money(gross, currency)} einmalig`;

export interface Instalment {
  n: number;
  at: Date;
  amount_cents: number;
}

/** When each payment is due, counted from the first one. */
export function scheduleOf(p: PlanLike, start: Date): Instalment[] {
  return Array.from({ length: p.installments }, (_, i) => ({ n: i + 1, at: addPeriod(start, p.interval, i * p.interval_count), amount_cents: i === 0 ? (p.first_amount_cents ?? p.amount_cents) : p.amount_cents }));
}

/**
 * When Stripe ends the subscription by itself (unix seconds): shortly after the last payment is due and well before the one
 * after it – the safety net behind the app's own count (which ends the subscription right after the last payment).
 */
export function cancelAtFor(p: PlanLike, startSec: number): number {
  const start = new Date(startSec * 1000);
  const last = addPeriod(start, p.interval, (p.installments - 1) * p.interval_count);
  const next = addPeriod(start, p.interval, p.installments * p.interval_count);
  const buffer = Math.min(3 * 864e5, (next.getTime() - last.getTime()) / 2);
  return Math.floor((last.getTime() + buffer) / 1000);
}

/** Checkout line for the recurring installment. */
export function recurringOf(p: Pick<PlanLike, 'interval' | 'interval_count'>) {
  return { interval: p.interval, interval_count: p.interval_count };
}
