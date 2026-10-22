import { addDaysYmd, zonedToUtc } from '../core/time.js';

/**
 * Vermietung (rentals, docs/booking.md#rentals) – pure rules, tested in tests/rentals.test.ts: the date range of a booking, the
 * free units over that range and the price. A booking always occupies a half-open range of days [from, to):
 * - per **night** (rooms, holiday flats): `from` = check-in day, `to` = check-out day – a check-out and the next check-in on the
 *   same day do not overlap (same-day turnover);
 * - per **day** (e-bikes, tools): `from` = first day, the last day is `to - 1` – the item is out for whole days.
 */

export type Unit = 'day' | 'night';
export const UNITS: Unit[] = ['day', 'night'];
export const YMD = /^\d{4}-\d\d-\d\d$/;
export const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const MAX_QUANTITY = 500;
export const MAX_UNITS = 365;

export interface RentalRules {
  quantity: number;
  unit: Unit;
  price_cents: number;
  deposit_cents: number;
  min_units: number;
  max_units: number;
  checkin_time: string;
  checkout_time: string;
}

/** Times of day a stay starts and ends when none are set. */
export const defaultTimes = (unit: Unit) => (unit === 'night' ? { checkin: '15:00', checkout: '11:00' } : { checkin: '09:00', checkout: '18:00' });

export const validYmd = (s: unknown): s is string => typeof s === 'string' && YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
export const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export interface Range {
  from: string;
  /** Exclusive end day. */
  to: string;
  /** Days or nights charged. */
  units: number;
}

/**
 * The range a request means: `from` plus `to` (night: check-out day; day: last day, inclusive) or `days` (the number of days or
 * nights). Throws a German message.
 */
export function rangeOf(unit: Unit, input: { from?: unknown; to?: unknown; days?: unknown }): Range {
  const from = input.from;
  if (!validYmd(from)) throw new Error(unit === 'night' ? 'Bitte das Anreisedatum angeben (JJJJ-MM-TT)' : 'Bitte den ersten Tag angeben (JJJJ-MM-TT)');
  let units: number;
  if (input.to !== undefined && input.to !== null && input.to !== '') {
    if (!validYmd(input.to)) throw new Error(unit === 'night' ? 'Ungültiges Abreisedatum' : 'Ungültiger letzter Tag');
    units = diffDays(from, input.to) + (unit === 'day' ? 1 : 0);
    if (units < 1) throw new Error(unit === 'night' ? 'Die Abreise muss nach der Anreise liegen' : 'Der letzte Tag darf nicht vor dem ersten liegen');
  } else {
    units = Number(input.days);
    if (!Number.isInteger(units) || units < 1) throw new Error(unit === 'night' ? 'Bitte die Anzahl der Nächte angeben' : 'Bitte die Anzahl der Tage angeben');
  }
  if (units > MAX_UNITS) throw new Error(`Höchstens ${MAX_UNITS} ${unit === 'night' ? 'Nächte' : 'Tage'} am Stück`);
  return { from, to: addDaysYmd(from, units), units };
}

/** Is the length within the item's minimum and maximum? German reason or null. */
export function unitsProblem(r: Pick<RentalRules, 'unit' | 'min_units' | 'max_units'>, units: number): string | null {
  const word = (n: number) => (r.unit === 'night' ? (n === 1 ? 'Nacht' : 'Nächte') : n === 1 ? 'Tag' : 'Tage');
  if (units < r.min_units) return `Mindestens ${r.min_units} ${word(r.min_units)}`;
  if (r.max_units && units > r.max_units) return `Höchstens ${r.max_units} ${word(r.max_units)}`;
  return null;
}

export interface Taken {
  from_date: string;
  to_date: string;
  qty: number;
}

/** Units in use on each day of [from, to). */
export function usedPerDay(taken: Taken[], from: string, to: string): { date: string; used: number }[] {
  const n = Math.max(0, diffDays(from, to));
  const out = Array.from({ length: n }, (_, i) => ({ date: addDaysYmd(from, i), used: 0 }));
  for (const b of taken) {
    const a = Math.max(0, diffDays(from, b.from_date));
    const e = Math.min(n, diffDays(from, b.to_date));
    for (let i = a; i < e; i++) out[i].used += b.qty;
  }
  return out;
}

/** Units free over the whole range (the tightest day counts); never below 0. */
export function freeOver(quantity: number, taken: Taken[], from: string, to: string): number {
  const days = usedPerDay(taken, from, to);
  return Math.max(0, quantity - days.reduce((m, d) => Math.max(m, d.used), 0));
}

/** Free units per day, for the picker. */
export function freePerDay(quantity: number, taken: Taken[], from: string, days: number): { date: string; free: number }[] {
  return usedPerDay(taken, from, addDaysYmd(from, days)).map((d) => ({ date: d.date, free: Math.max(0, quantity - d.used) }));
}

export interface Price {
  units: number;
  qty: number;
  rent_cents: number;
  deposit_cents: number;
  total_cents: number;
}

/** Price per day/night × length × number of items, plus the deposit (Kaution) per item. */
export function priceOf(r: Pick<RentalRules, 'price_cents' | 'deposit_cents'>, units: number, qty: number): Price {
  const rent = r.price_cents * units * qty;
  const deposit = r.deposit_cents * qty;
  return { units, qty, rent_cents: rent, deposit_cents: deposit, total_cents: rent + deposit };
}

/** The instants of a stay in the calendar's zone: check-in time on the first day, check-out time on the day it ends. */
export function stayTimes(r: Pick<RentalRules, 'unit' | 'checkin_time' | 'checkout_time'>, range: Pick<Range, 'from' | 'to'>, tz: string): { start_at: string; end_at: string } {
  const d = defaultTimes(r.unit);
  const last = r.unit === 'night' ? range.to : addDaysYmd(range.to, -1);
  const start = zonedToUtc(range.from, r.checkin_time || d.checkin, tz);
  let end = zonedToUtc(last, r.checkout_time || d.checkout, tz);
  // A day rental returned "before" it was picked up (odd times) still ends after it starts.
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 3600_000);
  return { start_at: start.toISOString(), end_at: end.toISOString() };
}

/** "12.06.2027 – 15.06.2027 · 3 Nächte" */
export function rangeText(unit: Unit, range: Pick<Range, 'from' | 'to' | 'units'>): string {
  const de = (ymd: string) => ymd.split('-').reverse().join('.');
  const last = unit === 'night' ? range.to : addDaysYmd(range.to, -1);
  const word = unit === 'night' ? (range.units === 1 ? 'Nacht' : 'Nächte') : range.units === 1 ? 'Tag' : 'Tage';
  return `${de(range.from)}${last !== range.from ? ` – ${de(last)}` : ''} · ${range.units} ${word}`;
}
