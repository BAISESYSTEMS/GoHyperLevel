/**
 * Recurring tasks, pure: validation of the rule, the next date after a given day, and a German description.
 * Dates are `YYYY-MM-DD` strings; the callers keep a task's time of day (if any) themselves.
 */

export const FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Freq = (typeof FREQS)[number];

export interface Recurrence {
  freq: Freq;
  /** Every n days / weeks / months / years. */
  interval: number;
  /** weekly: 0 = Sunday … 6 = Saturday (default: the weekday of the due date). */
  weekdays?: number[];
  /** monthly: day of the month (31 = last day when the month is shorter). Default: the due date's day. */
  day_of_month?: number;
  /** `due`: counted from the due date (fixed rhythm); `completion`: counted from the day the task was done. */
  mode: 'due' | 'completion';
  /** Stop after n repetitions or on a date. */
  end: { type: 'never' } | { type: 'count'; count: number } | { type: 'date'; date: string };
  /** How many times the rule has fired already. */
  done?: number;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const num = (s: string) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS);
const ymd = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dim = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const weekday = (s: string) => new Date(num(s) * DAY_MS).getUTCDay();

export class RecurrenceError extends Error {}

/** Validates and normalises a rule from the API; null/empty clears it. */
export function cleanRecurrence(input: unknown): Recurrence | null {
  if (input === null || input === undefined || input === '' || input === false) return null;
  if (typeof input !== 'object') throw new RecurrenceError('Wiederholung: ungültige Angabe');
  const b = input as Record<string, any>;
  if (!FREQS.includes(b.freq)) throw new RecurrenceError('Wiederholung: täglich, wöchentlich, monatlich oder jährlich wählen');
  const interval = Math.round(Number(b.interval ?? 1));
  if (!Number.isFinite(interval) || interval < 1 || interval > 365) throw new RecurrenceError('Wiederholung: Abstand zwischen 1 und 365');
  const out: Recurrence = { freq: b.freq, interval, mode: b.mode === 'completion' ? 'completion' : 'due', end: { type: 'never' } };
  if (b.freq === 'weekly' && Array.isArray(b.weekdays) && b.weekdays.length) {
    const days = [...new Set(b.weekdays.map((x: unknown) => Math.round(Number(x))))].filter((x) => x >= 0 && x <= 6).sort((x, y) => x - y);
    if (!days.length) throw new RecurrenceError('Wiederholung: Wochentage ungültig');
    out.weekdays = days as number[];
  }
  if (b.freq === 'monthly' && b.day_of_month !== undefined && b.day_of_month !== null && b.day_of_month !== '') {
    const d = Math.round(Number(b.day_of_month));
    if (!Number.isFinite(d) || d < 1 || d > 31) throw new RecurrenceError('Wiederholung: Tag im Monat zwischen 1 und 31');
    out.day_of_month = d;
  }
  const end = b.end;
  if (end && typeof end === 'object') {
    if (end.type === 'count') {
      const c = Math.round(Number(end.count));
      if (!Number.isFinite(c) || c < 1 || c > 1000) throw new RecurrenceError('Wiederholung: Anzahl zwischen 1 und 1000');
      out.end = { type: 'count', count: c };
    } else if (end.type === 'date') {
      if (!YMD.test(String(end.date))) throw new RecurrenceError('Wiederholung: Enddatum ungültig');
      out.end = { type: 'date', date: String(end.date) };
    }
  }
  if (b.done !== undefined) out.done = Math.max(0, Math.round(Number(b.done)) || 0);
  return out;
}

/**
 * The next date after `from` (the due date or the completion day, see `mode`), or null when the rule has ended.
 * `fired` = repetitions so far (the rule's own counter by default).
 */
export function nextOccurrence(rule: Recurrence, from: string): string | null {
  if (!YMD.test(from)) return null;
  const fired = rule.done ?? 0;
  if (rule.end.type === 'count' && fired >= rule.end.count) return null;
  let next: string;
  const [y, m, d] = [+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)];
  switch (rule.freq) {
    case 'daily':
      next = ymd(num(from) + rule.interval);
      break;
    case 'weekly': {
      const days = rule.weekdays?.length ? rule.weekdays : [weekday(from)];
      // Same week first (later weekdays), then the following weeks every `interval` weeks.
      const mondayOffset = (weekday(from) + 6) % 7;
      const weekStart = num(from) - mondayOffset;
      const order = [...days].map((w) => (w + 6) % 7).sort((a, b) => a - b);
      const later = order.find((o) => o > mondayOffset);
      next = later !== undefined ? ymd(weekStart + later) : ymd(weekStart + 7 * rule.interval + order[0]);
      break;
    }
    case 'monthly': {
      const total = y * 12 + m + rule.interval;
      const ny = Math.floor(total / 12);
      const nm = total % 12;
      const want = rule.day_of_month ?? d;
      next = ymd(Date.UTC(ny, nm, Math.min(want, dim(ny, nm))) / DAY_MS);
      break;
    }
    case 'yearly': {
      const ny = y + rule.interval;
      next = ymd(Date.UTC(ny, m, Math.min(d, dim(ny, m))) / DAY_MS);
      break;
    }
  }
  if (rule.end.type === 'date' && next > rule.end.date) return null;
  return next;
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/** "Alle 2 Wochen (Mo, Do)" – for the task card. */
export function describeRecurrence(rule: Recurrence | null | undefined): string {
  if (!rule) return '';
  const n = rule.interval;
  let s: string;
  switch (rule.freq) {
    case 'daily':
      s = n === 1 ? 'Täglich' : `Alle ${n} Tage`;
      break;
    case 'weekly':
      s = n === 1 ? 'Wöchentlich' : `Alle ${n} Wochen`;
      if (rule.weekdays?.length) s += ` (${rule.weekdays.map((w) => WEEKDAYS[w]).join(', ')})`;
      break;
    case 'monthly':
      s = n === 1 ? 'Monatlich' : `Alle ${n} Monate`;
      if (rule.day_of_month) s += ` am ${rule.day_of_month}.`;
      break;
    case 'yearly':
      s = n === 1 ? 'Jährlich' : `Alle ${n} Jahre`;
      break;
  }
  if (rule.mode === 'completion') s += ', ab Erledigung';
  if (rule.end.type === 'count') s += `, ${rule.end.count}×`;
  if (rule.end.type === 'date') s += `, bis ${rule.end.date.split('-').reverse().join('.')}`;
  return s;
}
