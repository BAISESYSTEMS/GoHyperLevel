import { addDaysYmd, ymdInTz } from '../core/time.js';

/**
 * Warm-up plan for a new sending domain: how many marketing e-mails per day a sender may send while mailbox providers
 * get to know it. The cap rises every day until the plan is through, after which there is no cap any more. Pure
 * calculations (the sending loop asks `warmupRoom` in modules/mk-deliverability.ts, the campaign loop honours it).
 */

export type WarmupPlan = 'conservative' | 'standard' | 'fast';
export const WARMUP_PLANS: WarmupPlan[] = ['conservative', 'standard', 'fast'];

export const PLAN_INFO: Record<WarmupPlan, { label: string; text: string; start: number; growth: number }> = {
  conservative: { label: 'Behutsam (ca. 6 Wochen)', text: 'Für neue Domains ohne Versandhistorie oder wenn die Liste alt ist. Beginnt mit 20 Mails am Tag.', start: 20, growth: 1.2 },
  standard: { label: 'Standard (ca. 4 Wochen)', text: 'Der übliche Weg: beginnt mit 50 Mails am Tag und steigert täglich um etwa ein Drittel.', start: 50, growth: 1.3 },
  fast: { label: 'Zügig (ca. 2,5 Wochen)', text: 'Nur für eine saubere, aktive Liste: beginnt mit 100 Mails am Tag und steigt schnell.', start: 100, growth: 1.45 },
};

/** From this daily volume on, the sender counts as warmed up and nothing is capped any more. */
export const WARMUP_TARGET = 50_000;
/** The longest a plan can take (a safety net against a growth factor of 1). */
const MAX_DAYS = 90;

export const isWarmupPlan = (v: unknown): v is WarmupPlan => typeof v === 'string' && (WARMUP_PLANS as string[]).includes(v);

/** Round to numbers people recognise: 20, 25, 30 … 100, 110 … 1 000, 1 050 … */
export function niceRound(n: number): number {
  if (n < 100) return Math.max(5, Math.round(n / 5) * 5);
  if (n < 1000) return Math.round(n / 10) * 10;
  if (n < 10_000) return Math.round(n / 50) * 50;
  return Math.round(n / 500) * 500;
}

/** The cap of day `day` (1 = first day) in e-mails; null when the plan is through (no cap any more). */
export function dailyCap(plan: WarmupPlan, day: number): number | null {
  const p = PLAN_INFO[plan] ?? PLAN_INFO.standard;
  const d = Math.max(1, Math.floor(day));
  if (d > MAX_DAYS) return null;
  const cap = niceRound(p.start * p.growth ** (d - 1));
  return cap >= WARMUP_TARGET ? null : cap;
}

/** Number of the day (1 = the day it started) in the sub-account's time zone. */
export function warmupDay(startedAt: string, at: Date, tz: string): number {
  const a = ymdInTz(new Date(startedAt), tz).split('-').map(Number);
  const b = ymdInTz(at, tz).split('-').map(Number);
  const days = Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 864e5);
  return Math.max(1, days + 1);
}

export interface WarmupState {
  plan: WarmupPlan;
  active: boolean;
  paused: boolean;
  done: boolean;
  day: number;
  /** Today's cap (null = none: paused, or through). */
  cap: number | null;
  sent_today: number;
  remaining: number | null;
  /** The cap was cut in half because the numbers got worse (bounces, complaints). */
  reduced: boolean;
  total_days: number;
  /** The coming days with their caps. */
  upcoming: { day: number; date: string; cap: number | null }[];
}

/** Where the plan stands today. `trouble` halves the cap (the reputation report says critical). */
export function warmupState(o: { plan: WarmupPlan; startedAt: string; paused?: boolean; trouble?: boolean; sentToday: number; at: Date; tz: string }): WarmupState {
  const day = warmupDay(o.startedAt, o.at, o.tz);
  const base = dailyCap(o.plan, day);
  const done = base === null;
  const reduced = !!o.trouble && !done;
  const cap = done || o.paused ? null : reduced ? Math.max(10, Math.round((base as number) / 2)) : base;
  const total = totalDays(o.plan);
  const today = ymdInTz(o.at, o.tz);
  const upcoming = [];
  for (let i = 1; i <= 7 && day + i <= total + 1; i++) upcoming.push({ day: day + i, date: addDaysYmd(today, i), cap: dailyCap(o.plan, day + i) });
  return {
    plan: o.plan,
    active: !done && !o.paused,
    paused: !!o.paused,
    done,
    day,
    cap,
    sent_today: o.sentToday,
    remaining: cap === null ? null : Math.max(0, cap - o.sentToday),
    reduced,
    total_days: total,
    upcoming,
  };
}

/** How many days a plan lasts until the sender is warmed up. */
export function totalDays(plan: WarmupPlan): number {
  for (let d = 1; d <= MAX_DAYS; d++) if (dailyCap(plan, d) === null) return d - 1;
  return MAX_DAYS;
}

/** The whole schedule of a plan (for the table in the dashboard). */
export function schedule(plan: WarmupPlan): { day: number; cap: number }[] {
  const out: { day: number; cap: number }[] = [];
  for (let d = 1; d <= MAX_DAYS; d++) {
    const cap = dailyCap(plan, d);
    if (cap === null) break;
    out.push({ day: d, cap });
  }
  return out;
}
