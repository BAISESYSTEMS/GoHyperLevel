/**
 * Pure maths of job costing (no imports, no database): budget thresholds, the retainer month (contingent, carry-over,
 * overage), margins and the burn-down series. The database side is in pm-costing.ts and pm-retainers.ts; the web app
 * shows the same numbers the server computes.
 */

export const ROLLOVERS = ['none', 'capped', 'unlimited'] as const;
export type Rollover = (typeof ROLLOVERS)[number];
export const ROLLOVER_LABEL: Record<Rollover, string> = { none: 'Verfallen', capped: 'Übertrag bis zu N Stunden', unlimited: 'Unbegrenzter Übertrag' };

export const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
export const round1 = (n: number): number => Math.round((Number(n) || 0) * 10) / 10;

// --- months ---------------------------------------------------------------------------------------------------------------------

export const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);

/** `2026-10` + n months. */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** First and last day of a month (`YYYY-MM-DD`). */
export function monthDays(ym: string): [string, string] {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ''} ${ym.slice(0, 4)}`.trim();

// --- budgets --------------------------------------------------------------------------------------------------------------------

export const DEFAULT_THRESHOLDS = [80, 100];

/** Alert thresholds in percent: whole numbers 1–500, sorted, at most five; empty input → 80 % and 100 %. */
export function cleanThresholds(v: unknown): number[] {
  if (v === undefined || v === null || v === '') return [...DEFAULT_THRESHOLDS];
  const list = Array.isArray(v) ? v : String(v).split(/[,;\s]+/);
  const out = [...new Set(list.map((x) => Math.round(Number(x))).filter((n) => Number.isFinite(n) && n >= 1 && n <= 500))].sort((a, b) => a - b);
  if (out.length > 5) throw new Error('Höchstens fünf Schwellen');
  return out.length ? out : [...DEFAULT_THRESHOLDS];
}

/** Used share of a budget in percent (one decimal), null without a budget. */
export const percentOf = (used: number, budget: number | null | undefined): number | null => (budget && budget > 0 ? round1((used / budget) * 100) : null);

/**
 * Which thresholds fire now and which are armed again. A threshold fires once when the use reaches it; it is armed again only when
 * the use falls back below it (more budget, entries removed), so it can fire a second time when it is reached again.
 */
export function thresholdChanges(percent: number | null, thresholds: number[], fired: number[]): { fire: number[]; reset: number[] } {
  if (percent === null) return { fire: [], reset: fired.slice() };
  return { fire: thresholds.filter((t) => percent >= t && !fired.includes(t)), reset: fired.filter((t) => percent < t || !thresholds.includes(t)) };
}

/** Traffic light of a budget: over the highest threshold (or 100 %) = over, over the lowest = warn. */
export function budgetState(percents: (number | null)[], thresholds: number[]): 'none' | 'ok' | 'warn' | 'over' {
  const ps = percents.filter((p): p is number => p !== null);
  if (!ps.length) return 'none';
  const top = Math.max(...ps);
  if (top >= Math.max(100, ...thresholds)) return 'over';
  if (top >= Math.min(...thresholds, 100)) return 'warn';
  return 'ok';
}

// --- retainers ------------------------------------------------------------------------------------------------------------------

export interface PeriodInput {
  /** Contingent of the month. */
  included_hours: number;
  /** Carried over from the month before. */
  carry_in_hours: number;
  used_hours: number;
  rollover: Rollover;
  /** For `capped`: the most that may be carried into the next month. */
  rollover_max_hours: number;
}

export interface PeriodResult {
  included_hours: number;
  carry_in_hours: number;
  available_hours: number;
  used_hours: number;
  overage_hours: number;
  unused_hours: number;
  carry_out_hours: number;
}

/**
 * One retainer month: the contingent plus what was carried over is available; what was used beyond it is overage, what is left
 * either lapses (`none`), is carried over up to a cap (`capped`) or completely (`unlimited`).
 */
export function retainerPeriod(i: PeriodInput): PeriodResult {
  const included = round2(Math.max(0, i.included_hours));
  const carryIn = round2(Math.max(0, i.carry_in_hours));
  const used = round2(Math.max(0, i.used_hours));
  const available = round2(included + carryIn);
  const overage = round2(Math.max(0, used - available));
  const unused = round2(Math.max(0, available - used));
  const carryOut = i.rollover === 'unlimited' ? unused : i.rollover === 'capped' ? round2(Math.min(unused, Math.max(0, i.rollover_max_hours))) : 0;
  return { included_hours: included, carry_in_hours: carryIn, available_hours: available, used_hours: used, overage_hours: overage, unused_hours: unused, carry_out_hours: carryOut };
}

export interface RetainerLine {
  name: string;
  description: string;
  qty: number;
  price_cents: number;
  unit?: string;
}

const hoursText = (h: number) => `${round2(h).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Std.`;

/** The lines of a month's invoice: the retainer fee and – if hours went over and there is a rate – the overage. */
export function retainerLines(r: { name: string; price_cents: number; overage_rate_cents: number }, p: PeriodResult, ym: string): RetainerLine[] {
  const label = monthLabel(ym);
  const parts = [`Kontingent ${hoursText(p.included_hours)}`];
  if (p.carry_in_hours > 0) parts.push(`Übertrag ${hoursText(p.carry_in_hours)}`);
  parts.push(`genutzt ${hoursText(p.used_hours)}`);
  if (p.carry_out_hours > 0) parts.push(`Übertrag in den Folgemonat ${hoursText(p.carry_out_hours)}`);
  const lines: RetainerLine[] = [{ name: `Retainer „${r.name}“ – ${label}`.slice(0, 300), description: parts.join(' · '), qty: 1, price_cents: Math.max(0, Math.round(r.price_cents)) }];
  if (p.overage_hours > 0 && r.overage_rate_cents > 0) {
    lines.push({ name: `Mehrstunden ${label}`.slice(0, 300), description: `${hoursText(p.overage_hours)} über dem Kontingent`, qty: round2(p.overage_hours), price_cents: Math.round(r.overage_rate_cents), unit: 'HUR' });
  }
  return lines;
}

// --- margins ----------------------------------------------------------------------------------------------------------------------

/** Margin in cents and percent of the revenue (null without revenue). */
export function margin(revenueCents: number, costCents: number): { margin_cents: number; margin_percent: number | null } {
  const m = Math.round(revenueCents - costCents);
  return { margin_cents: m, margin_percent: revenueCents > 0 ? round1((m / revenueCents) * 100) : null };
}

/** Cost of logged time: hours × internal cost rate. */
export const timeCost = (seconds: number, costCentsPerHour: number): number => Math.round((Math.max(0, seconds) / 3600) * Math.max(0, costCentsPerHour));

// --- burn-down --------------------------------------------------------------------------------------------------------------------

const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);

export interface BurnPoint {
  day: string;
  used: number;
  remaining: number;
}

/**
 * Remaining budget over time: one point per day (per week beyond 120 days) from `from` to `to`, with the cumulative use up to that
 * day. `ideal` is the straight line from the full budget at `from` to zero at the due day (if there is one).
 */
export function burndown(budget: number, usage: { day: string; value: number }[], from: string, to: string, due?: string | null): { step: 'day' | 'week'; points: BurnPoint[]; ideal: { day: string; remaining: number }[] } {
  const start = parse(from);
  const end = Math.max(start, parse(to));
  const step = (end - start) / DAY > 120 ? 'week' : 'day';
  const inc = step === 'week' ? 7 * DAY : DAY;
  const sorted = usage.filter((u) => u.day <= ymd(end)).sort((a, b) => a.day.localeCompare(b.day));
  const points: BurnPoint[] = [];
  let used = 0;
  let i = 0;
  // everything before the start counts from the first point on
  for (let t = start; ; t += inc) {
    const last = t >= end;
    const day = ymd(Math.min(t, end));
    while (i < sorted.length && sorted[i].day <= day) used += sorted[i++].value;
    points.push({ day, used: round2(used), remaining: round2(budget - used) });
    if (last) break;
  }
  const ideal: { day: string; remaining: number }[] = [];
  if (due && parse(due) > start) ideal.push({ day: from, remaining: round2(budget) }, { day: due, remaining: 0 });
  return { step, points, ideal };
}
