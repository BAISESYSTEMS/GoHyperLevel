import { addDays, q3 } from './bo-common.js';

/**
 * Leave maths for the HR basics: public holidays per Bundesland, working days of an absence (weekdays of the employee,
 * holidays, half days), vacation entitlement (pro rata for part years, § 5 BUrlG) and the balance with carry-over.
 * Pure functions – no database, so the rules are easy to test.
 */

export const STATES: Record<string, string> = {
  BW: 'Baden-Württemberg',
  BY: 'Bayern',
  BE: 'Berlin',
  BB: 'Brandenburg',
  HB: 'Bremen',
  HH: 'Hamburg',
  HE: 'Hessen',
  MV: 'Mecklenburg-Vorpommern',
  NI: 'Niedersachsen',
  NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz',
  SL: 'Saarland',
  SN: 'Sachsen',
  ST: 'Sachsen-Anhalt',
  SH: 'Schleswig-Holstein',
  TH: 'Thüringen',
};
export const isState = (v: unknown): v is string => typeof v === 'string' && v in STATES;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const plus = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);

/** Easter Sunday (anonymous Gregorian algorithm). */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(utc(year, month, day));
}

export interface Holiday {
  date: string;
  name: string;
  /** Empty = everywhere in Germany. */
  states: string[];
}

const ALL: string[] = [];

/** Statutory public holidays of a year with the states that have them (only holidays valid statewide). */
export function holidayRules(year: number): Holiday[] {
  const e = utc(...(easter(year).split('-').map(Number) as [number, number, number]));
  const off = (n: number) => ymd(plus(e, n));
  const list: Holiday[] = [
    { date: `${year}-01-01`, name: 'Neujahr', states: ALL },
    { date: `${year}-01-06`, name: 'Heilige Drei Könige', states: ['BW', 'BY', 'ST'] },
    { date: off(-2), name: 'Karfreitag', states: ALL },
    { date: off(0), name: 'Ostersonntag', states: ['BB'] },
    { date: off(1), name: 'Ostermontag', states: ALL },
    { date: `${year}-05-01`, name: 'Tag der Arbeit', states: ALL },
    { date: off(39), name: 'Christi Himmelfahrt', states: ALL },
    { date: off(49), name: 'Pfingstsonntag', states: ['BB'] },
    { date: off(50), name: 'Pfingstmontag', states: ALL },
    { date: off(60), name: 'Fronleichnam', states: ['BW', 'BY', 'HE', 'NW', 'RP', 'SL'] },
    { date: `${year}-08-15`, name: 'Mariä Himmelfahrt', states: ['SL'] },
    { date: `${year}-10-03`, name: 'Tag der Deutschen Einheit', states: ALL },
    { date: `${year}-10-31`, name: 'Reformationstag', states: year === 2017 ? ALL : ['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'] },
    { date: `${year}-11-01`, name: 'Allerheiligen', states: ['BW', 'BY', 'NW', 'RP', 'SL'] },
    { date: `${year}-12-25`, name: '1. Weihnachtstag', states: ALL },
    { date: `${year}-12-26`, name: '2. Weihnachtstag', states: ALL },
  ];
  if (year >= 2019) list.push({ date: `${year}-03-08`, name: 'Internationaler Frauentag', states: year >= 2023 ? ['BE', 'MV'] : ['BE'] });
  if (year >= 2019) list.push({ date: `${year}-09-20`, name: 'Weltkindertag', states: ['TH'] });
  // Buß- und Bettag: the Wednesday before 23 November (Sachsen).
  const nov23 = utc(year, 11, 23);
  const back = ((nov23.getUTCDay() + 7 - 3) % 7) || 7;
  list.push({ date: ymd(plus(nov23, -back)), name: 'Buß- und Bettag', states: ['SN'] });
  // One-off holidays in Berlin: 75th and 80th anniversary of the liberation.
  if (year === 2020 || year === 2025) list.push({ date: `${year}-05-08`, name: 'Tag der Befreiung', states: ['BE'] });
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

export function holidays(year: number, state: string): Holiday[] {
  return holidayRules(year).filter((h) => !h.states.length || h.states.includes(state));
}

/** Holidays of a state between two dates, as date → name. */
export function holidayMap(from: string, to: string, state: string): Map<string, string> {
  const out = new Map<string, string>();
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) for (const h of holidays(y, state)) if (h.date >= from && h.date <= to) out.set(h.date, h.name);
  return out;
}

// --- working days ----------------------------------------------------------------------------------------------------

/** ISO weekday of a date: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

export interface Absence {
  start_date: string;
  end_date: string;
  half_start?: boolean | number;
  half_end?: boolean | number;
}

export interface WorkProfile {
  /** ISO weekdays the person works (default Monday–Friday). */
  work_days: number[];
  state: string;
}

export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];

/**
 * The days an absence uses up: one entry per working day (1, or 0.5 for a half day at the start or end).
 * Weekends/non-working days and public holidays of the state are skipped.
 */
export function absenceDays(a: Absence, p: WorkProfile): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  if (a.end_date < a.start_date) return out;
  const hol = holidayMap(a.start_date, a.end_date, p.state);
  const days = new Set(p.work_days.length ? p.work_days : DEFAULT_WORK_DAYS);
  for (let d = a.start_date, n = 0; d <= a.end_date && n < 800; d = addDays(d, 1), n++) {
    if (!days.has(isoWeekday(d)) || hol.has(d)) continue;
    let v = 1;
    // A half day at the start or end; a single day with either flag is a half day (not a quarter).
    if ((d === a.start_date && a.half_start) || (d === a.end_date && a.half_end)) v = 0.5;
    out.push({ date: d, value: v });
  }
  return out;
}

export const sumDays = (list: { value: number }[]) => q3(list.reduce((n, x) => n + x.value, 0));

// --- vacation entitlement and balance ---------------------------------------------------------------------------------

/**
 * Entitlement in a calendar year. Whole year employed: the full annual days. Part year (start or end inside it): 1/12 per
 * full month of employment; a fraction of at least half a day is rounded up to a whole day, a smaller one stays (§ 5 BUrlG).
 */
export function entitlement(annualDays: number, year: number, startDate?: string | null, endDate?: string | null): number {
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const start = startDate && startDate > yStart ? startDate : yStart;
  const end = endDate && endDate < yEnd ? endDate : yEnd;
  if (end < start) return 0;
  if (start === yStart && end === yEnd) return q3(annualDays);
  let months = 0;
  for (let m = 1; m <= 12; m++) {
    const first = `${year}-${String(m).padStart(2, '0')}-01`;
    const last = ymd(utc(year, m + 1, 0));
    if (start <= first && end >= last) months++;
  }
  const x = (annualDays * months) / 12;
  const frac = x - Math.floor(x);
  return q3(frac >= 0.5 ? Math.ceil(x) : x);
}

export interface Balance {
  year: number;
  entitlement: number;
  carryover: number;
  carryover_expires: string | null;
  carryover_used: number;
  carryover_forfeited: number;
  adjustment: number;
  taken: number;
  pending: number;
  sick: number;
  other: number;
  remaining: number;
  /** Remaining minus what is already requested. */
  available: number;
}

export interface BalanceInput {
  annualDays: number;
  startDate?: string | null;
  endDate?: string | null;
  carryover: number;
  adjustment: number;
  /** MM-DD (default 03-31): carry-over days not used until then are gone. */
  carryoverExpiry: string | null;
  profile: WorkProfile;
  absences: (Absence & { type: string; status: string })[];
  year: number;
  /** Day the balance is looked at (default today): decides whether carry-over has expired. */
  asOf?: string;
}

/**
 * Vacation balance of one year: entitlement + carry-over (usable until its expiry; days taken until then use it first) +
 * adjustments − approved vacation. Requested vacation is shown as `pending` and reduces what is `available`.
 */
export function balance(i: BalanceInput): Balance {
  const yStart = `${i.year}-01-01`;
  const yEnd = `${i.year}-12-31`;
  const asOf = i.asOf ?? new Date().toISOString().slice(0, 10);
  const expires = i.carryoverExpiry && i.carryover > 0 ? `${i.year}-${i.carryoverExpiry}` : null;
  const within = (a: Absence) => ({ ...a, start_date: a.start_date < yStart ? yStart : a.start_date, end_date: a.end_date > yEnd ? yEnd : a.end_date, half_start: a.start_date < yStart ? false : a.half_start, half_end: a.end_date > yEnd ? false : a.half_end });
  const daysOf = (type: string, status: string) =>
    i.absences
      .filter((a) => a.type === type && a.status === status && a.end_date >= yStart && a.start_date <= yEnd)
      .flatMap((a) => absenceDays(within(a), i.profile));
  const vac = daysOf('vacation', 'approved');
  const taken = sumDays(vac);
  const takenBeforeExpiry = expires ? sumDays(vac.filter((d) => d.date <= expires)) : 0;
  const carryUsed = expires ? Math.min(i.carryover, takenBeforeExpiry) : 0;
  // Unused carry-over is forfeited once its date has passed.
  const forfeited = expires && asOf > expires ? q3(i.carryover - carryUsed) : 0;
  const ent = entitlement(i.annualDays, i.year, i.startDate, i.endDate);
  const total = q3(ent + i.carryover - forfeited + i.adjustment);
  const pending = sumDays(daysOf('vacation', 'requested'));
  const remaining = q3(total - taken);
  return {
    year: i.year,
    entitlement: ent,
    carryover: q3(i.carryover),
    carryover_expires: expires,
    carryover_used: q3(carryUsed),
    carryover_forfeited: forfeited,
    adjustment: q3(i.adjustment),
    taken,
    pending,
    sick: sumDays(daysOf('sick', 'approved')),
    other: sumDays(daysOf('other', 'approved')),
    remaining,
    available: q3(remaining - pending),
  };
}

/** Whether two absences share a day. */
export const overlaps = (a: Absence, b: Absence) => a.start_date <= b.end_date && b.start_date <= a.end_date;
