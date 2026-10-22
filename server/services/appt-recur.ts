/**
 * Recurring appointments, pure (no imports beyond the task rule it shares): the rule – an RRULE subset like the recurring
 * tasks: daily, weekly on given days, every N weeks, monthly –, its RRULE text and the dates of a series. Dates are
 * `YYYY-MM-DD` in the series' time zone; the caller keeps the time of day, so 10:00 stays 10:00 across a DST change.
 */
import { RecurrenceError, cleanRecurrence, describeRecurrence, nextOccurrence, type Recurrence } from './pm-recur.js';

export { RecurrenceError, describeRecurrence };
export type ApptRule = Recurrence;

const FREQ_TEXT = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' } as const;
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
/** Most repetitions of one rule step (every 365 days, every 52 weeks, every 24 months). */
const MAX_INTERVAL = { daily: 365, weekly: 52, monthly: 24 } as const;

const dayNum = (s: string) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS);
const weekdayOf = (s: string) => new Date(dayNum(s) * DAY_MS).getUTCDay();
const daysInMonth = (s: string) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)).getUTCDate();

/** `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=10` → the parts of a rule; anything outside the subset is refused. */
export function parseRrule(text: string): Record<string, unknown> {
  const s = String(text ?? '')
    .trim()
    .replace(/^RRULE:/i, '');
  if (!s || s.length > 200) throw new RecurrenceError('Wiederholung: RRULE ungültig');
  const parts: Record<string, string> = {};
  for (const p of s.split(';').filter(Boolean)) {
    const [k, v, extra] = p.split('=');
    if (!k || v === undefined || extra !== undefined || !v) throw new RecurrenceError('Wiederholung: RRULE ungültig');
    parts[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  for (const k of Object.keys(parts))
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST'].includes(k))
      throw new RecurrenceError(`Wiederholung: ${k} wird nicht unterstützt (nur täglich, wöchentlich an Tagen, alle N Wochen, monatlich)`);
  const freq = Object.entries(FREQ_TEXT).find(([, v]) => v === parts.FREQ)?.[0];
  if (!freq) throw new RecurrenceError('Wiederholung: FREQ=DAILY, WEEKLY oder MONTHLY');
  const out: Record<string, unknown> = { freq, interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1 };
  if (parts.BYDAY) {
    if (freq !== 'weekly') throw new RecurrenceError('Wiederholung: BYDAY nur bei FREQ=WEEKLY');
    const days = parts.BYDAY.split(',').map((d) => DAY_CODES.indexOf(d));
    if (days.some((d) => d < 0)) throw new RecurrenceError('Wiederholung: BYDAY ungültig (MO, TU, WE, TH, FR, SA, SU)');
    out.weekdays = days;
  }
  if (parts.BYMONTHDAY) {
    if (freq !== 'monthly' || !/^\d{1,2}$/.test(parts.BYMONTHDAY)) throw new RecurrenceError('Wiederholung: BYMONTHDAY nur als ein Tag bei FREQ=MONTHLY');
    out.day_of_month = Number(parts.BYMONTHDAY);
  }
  if (parts.COUNT && parts.UNTIL) throw new RecurrenceError('Wiederholung: COUNT oder UNTIL, nicht beides');
  if (parts.COUNT) out.end = { type: 'count', count: Number(parts.COUNT) };
  if (parts.UNTIL) {
    const m = parts.UNTIL.match(/^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/);
    if (!m) throw new RecurrenceError('Wiederholung: UNTIL ungültig');
    out.end = { type: 'date', date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  return out;
}

/**
 * Validates a rule from the API: an RRULE text, `{rrule}` or `{freq, interval, weekdays, day_of_month, end}`. Null/empty
 * means "no repetition". Only daily, weekly and monthly; the rhythm is always counted from the dates (never from completion).
 */
export function cleanApptRecurrence(input: unknown): ApptRule | null {
  if (input === null || input === undefined || input === '' || input === false) return null;
  let raw: unknown = input;
  if (typeof raw === 'string') raw = parseRrule(raw);
  else if (typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as any).rrule === 'string') raw = parseRrule((raw as any).rrule);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RecurrenceError('Wiederholung: ungültige Angabe');
  const b = raw as Record<string, any>;
  if (!['daily', 'weekly', 'monthly'].includes(b.freq)) throw new RecurrenceError('Wiederholung: täglich, wöchentlich oder monatlich wählen');
  const interval = Math.round(Number(b.interval ?? 1));
  if (!Number.isFinite(interval) || interval < 1 || interval > MAX_INTERVAL[b.freq as keyof typeof MAX_INTERVAL])
    throw new RecurrenceError(`Wiederholung: Abstand zwischen 1 und ${MAX_INTERVAL[b.freq as keyof typeof MAX_INTERVAL]}`);
  const r = cleanRecurrence({ freq: b.freq, interval, weekdays: b.weekdays, day_of_month: b.day_of_month, end: b.end, mode: 'due' })!;
  delete r.done;
  if (r.end.type === 'count' && r.end.count > 500) throw new RecurrenceError('Wiederholung: höchstens 500 Termine');
  return r;
}

/** The rule as RRULE text (RFC 5545 subset; UNTIL as a date). */
export function toRrule(r: ApptRule): string {
  const out = [`FREQ=${FREQ_TEXT[r.freq as keyof typeof FREQ_TEXT] ?? 'DAILY'}`];
  if (r.interval > 1) out.push(`INTERVAL=${r.interval}`);
  if (r.freq === 'weekly' && r.weekdays?.length) out.push(`BYDAY=${r.weekdays.map((d) => DAY_CODES[d]).join(',')}`);
  if (r.freq === 'monthly' && r.day_of_month) out.push(`BYMONTHDAY=${r.day_of_month}`);
  if (r.end.type === 'count') out.push(`COUNT=${r.end.count}`);
  if (r.end.type === 'date') out.push(`UNTIL=${r.end.date.replace(/-/g, '')}`);
  return out.join(';');
}

/**
 * The rule pinned to its first day: weekly without days repeats on the first day's weekday, monthly without a day on the first
 * day's date (a series that starts on the 31st stays on the last day of shorter months instead of drifting to the 28th).
 */
export function anchorRule(r: ApptRule, first: string): ApptRule {
  if (!YMD.test(first)) throw new RecurrenceError('Wiederholung: erster Tag ungültig');
  const out: ApptRule = { ...r, end: { ...r.end } as ApptRule['end'] };
  if (r.freq === 'weekly' && !r.weekdays?.length) out.weekdays = [weekdayOf(first)];
  if (r.freq === 'monthly' && !r.day_of_month) out.day_of_month = Number(first.slice(8, 10));
  return out;
}

/** Does `day` itself fit the rule (weekday / day of month)? */
function fits(r: ApptRule, day: string): boolean {
  if (r.freq === 'weekly') return !r.weekdays?.length || r.weekdays.includes(weekdayOf(day));
  if (r.freq === 'monthly') {
    if (!r.day_of_month) return true;
    const d = Number(day.slice(8, 10));
    return d === r.day_of_month || (r.day_of_month > daysInMonth(day) && d === daysInMonth(day));
  }
  return true;
}

/**
 * The dates of a series from its first day on, in order, up to `to` (inclusive) and at most `max`. The first day counts when it
 * fits the rule; otherwise the series starts on the next day that does. COUNT counts every date from the start, UNTIL is inclusive.
 */
export function seriesDates(rule: ApptRule, first: string, to: string, max = 400): string[] {
  if (!YMD.test(first) || !YMD.test(to)) return [];
  const r = anchorRule(rule, first);
  const step: Recurrence = { ...r, done: 0, end: { type: 'never' } };
  const out: string[] = [];
  let d: string | null = fits(r, first) ? first : nextOccurrence(step, first);
  while (d && d <= to && out.length < max) {
    if (r.end.type === 'count' && out.length >= r.end.count) break;
    if (r.end.type === 'date' && d > r.end.date) break;
    out.push(d);
    const next: string | null = nextOccurrence(step, d);
    if (!next || next <= d) break;
    d = next;
  }
  return out;
}

/** Has the rule run out at or before `day` (no date after it)? */
export function endsBy(rule: ApptRule, first: string, day: string): boolean {
  const after = seriesDates(rule, first, '9999-12-31', 2000).find((d) => d > day);
  return !after;
}

/** The rule cut so its last date is before `day` (for "this and following"): an end date the day before. */
export function cutBefore(rule: ApptRule, day: string): ApptRule {
  const prev = new Date((dayNum(day) - 1) * DAY_MS).toISOString().slice(0, 10);
  if (rule.end.type === 'date' && rule.end.date < prev) return rule;
  return { ...rule, end: { type: 'date', date: prev } };
}

/** COUNT after a split: the dates the old part used are taken off, so the whole series still has the number asked for. */
export function remainingCount(rule: ApptRule, first: string, splitDay: string): ApptRule {
  if (rule.end.type !== 'count') return rule;
  const used = seriesDates(rule, first, new Date((dayNum(splitDay) - 1) * DAY_MS).toISOString().slice(0, 10), 2000).length;
  return { ...rule, end: { type: 'count', count: Math.max(1, rule.end.count - used) } };
}
