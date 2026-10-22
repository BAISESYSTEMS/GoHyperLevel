import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc, type DayKey } from '../core/time.js';

/**
 * SLA math for the helpdesk: deadlines that only count the sub-account's business hours (in its
 * time zone, without holidays), and the state of a timer. Pure – no database, no clock of its own.
 */

export interface DayHours {
  open: boolean;
  from: string;
  to: string;
}
export type BusinessHours = Record<DayKey, DayHours>;

export interface WorkCalendar {
  hours: BusinessHours;
  tz: string;
  /** Closed days as YYYY-MM-DD in the zone. */
  holidays: string[];
  /** Count every minute (24/7 SLA). */
  always?: boolean;
}

export const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const day = (open: boolean): DayHours => ({ open, from: '09:00', to: '17:00' });
export const defaultHours = (): BusinessHours => ({ mon: day(true), tue: day(true), wed: day(true), thu: day(true), fri: day(true), sat: day(false), sun: day(false) });

const MIN = 60_000;
const hasOpenDay = (c: WorkCalendar) => DAY_KEYS.some((k) => c.hours[k]?.open);

/** Open stretches [start, end) in epoch ms that begin on the given local day (overnight ranges run into the next day). */
export function openIntervals(cal: WorkCalendar, ymd: string): [number, number][] {
  if (cal.holidays.includes(ymd)) return [];
  const h = cal.hours[weekdayKey(ymd)];
  if (!h?.open) return [];
  const next = addDaysYmd(ymd, 1);
  if (h.from === h.to) return [[zonedToUtc(ymd, '00:00', cal.tz).getTime(), zonedToUtc(next, '00:00', cal.tz).getTime()]];
  if (h.from < h.to) return [[zonedToUtc(ymd, h.from, cal.tz).getTime(), zonedToUtc(ymd, h.to, cal.tz).getTime()]];
  return [[zonedToUtc(ymd, h.from, cal.tz).getTime(), zonedToUtc(next, h.to, cal.tz).getTime()]];
}

/** The instant `minutes` working minutes after `start` (outside business hours the clock stands still). */
export function addBusinessMinutes(start: Date, minutes: number, cal: WorkCalendar): Date {
  const ms = Math.max(0, minutes) * MIN;
  if (cal.always || !hasOpenDay(cal) || ms === 0) return new Date(start.getTime() + ms);
  let remaining = ms;
  let t = start.getTime();
  // Start a day early: an overnight stretch from yesterday may still be running.
  let ymd = addDaysYmd(ymdInTz(start, cal.tz), -1);
  for (let i = 0; i < 800; i++) {
    for (const [a, b] of openIntervals(cal, ymd)) {
      if (b <= t) continue;
      const from = Math.max(a, t);
      const avail = b - from;
      if (avail >= remaining) return new Date(from + remaining);
      remaining -= avail;
      t = b;
    }
    ymd = addDaysYmd(ymd, 1);
  }
  return new Date(t + remaining);
}

/** Working minutes between two instants (0 when `to` is not after `from`). */
export function businessMinutesBetween(from: Date, to: Date, cal: WorkCalendar): number {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a) return 0;
  if (cal.always || !hasOpenDay(cal)) return Math.round((b - a) / MIN);
  let total = 0;
  let ymd = addDaysYmd(ymdInTz(from, cal.tz), -1);
  for (let i = 0; i < 3700; i++) {
    if (zonedToUtc(ymd, '00:00', cal.tz).getTime() > b) break;
    for (const [s, e] of openIntervals(cal, ymd)) {
      const overlap = Math.min(b, e) - Math.max(a, s);
      if (overlap > 0) total += overlap;
    }
    ymd = addDaysYmd(ymd, 1);
  }
  return Math.round(total / MIN);
}

export type SlaState = '' | 'ok' | 'warning' | 'breached' | 'met' | 'missed';

/** Where a timer stands: running (ok/warning/breached) or finished (met/missed); '' = no SLA. */
export function slaState(due: string | null | undefined, warn: string | null | undefined, done: string | null | undefined, now = new Date()): SlaState {
  if (!due) return '';
  const d = Date.parse(due);
  if (done) return Date.parse(done) <= d ? 'met' : 'missed';
  const t = now.getTime();
  if (t >= d) return 'breached';
  if (warn && t >= Date.parse(warn)) return 'warning';
  return 'ok';
}

export interface SlaPolicy {
  first_response_min: number;
  resolution_min: number;
  business_hours: boolean;
}

/** Deadlines (and the moments to warn) for a ticket opened at `from`. */
export function slaDeadlines(from: Date, policy: SlaPolicy, cal: WorkCalendar, warnPercent: number) {
  const c = policy.business_hours ? cal : { ...cal, always: true };
  const pct = Math.min(99, Math.max(1, warnPercent)) / 100;
  const at = (min: number) => (min > 0 ? addBusinessMinutes(from, min, c).toISOString() : null);
  return {
    first_response_due_at: at(policy.first_response_min),
    first_response_warn_at: at(Math.round(policy.first_response_min * pct)),
    resolution_due_at: at(policy.resolution_min),
    resolution_warn_at: at(Math.round(policy.resolution_min * pct)),
  };
}

/**
 * After a pause (e.g. "Wartet auf Kunde"), the remaining working time of a deadline starts again
 * from `now`. A deadline that had already passed when the pause began stays where it was.
 */
export function shiftAfterPause(due: string | null, pausedAt: Date, now: Date, cal: WorkCalendar): string | null {
  if (!due) return due;
  const d = new Date(due);
  if (d <= pausedAt) return due;
  return addBusinessMinutes(now, businessMinutesBetween(pausedAt, d, cal), cal).toISOString();
}
