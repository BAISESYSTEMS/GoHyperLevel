/** Dates, durations and money of the planner – pure helpers (no React, no browser APIs), unit-tested in tests/pm-web.test.ts.
 * Texts and formats follow the UI language (German texts are message ids of the pm catalog). */
import { getLocale, intlLocale, tr } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';

// --- dates ------------------------------------------------------------------------------------------------

const DATE_ONLY = /T00:00:00(\.000)?Z$/;
/** The calendar day (YYYY-MM-DD) of a stored date: date-only values by their date, timed ones in the sub-account's zone. */
export function dayOf(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  if (DATE_ONLY.test(iso)) return iso.slice(0, 10);
  const d = new Date(iso);
  if (Number.isNaN(+d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const todayIn = (tz: string) => dayOf(new Date().toISOString(), tz)!;
export const timeOf = (iso: string | null | undefined, tz: string): string => (iso && !DATE_ONLY.test(iso) ? new Intl.DateTimeFormat(intlLocale(), { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '');

const DAY_MS = 86_400_000;
export const dayNum = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);
export const ymdOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDay = (ymd: string, n: number) => ymdOf(dayNum(ymd) + n);
export const diffDay = (a: string, b: string) => dayNum(b) - dayNum(a);
/** 0 = Monday … 6 = Sunday */
export const weekdayMon = (ymd: string) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;
export const mondayOf = (ymd: string) => addDay(ymd, -weekdayMon(ymd));
export const isWeekend = (ymd: string) => weekdayMon(ymd) >= 5;
/** ISO week number */
export function isoWeek(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((+d - +first) / DAY_MS - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}

// One formatter per language and shape (the language can change while the app runs).
const formatters = new Map<string, Intl.DateTimeFormat>();
const dFmt = (o: Intl.DateTimeFormatOptions) => {
  const l = intlLocale();
  const k = `${l} ${JSON.stringify(o)}`;
  let f = formatters.get(k);
  if (!f) formatters.set(k, (f = new Intl.DateTimeFormat(l, { timeZone: 'UTC', ...o })));
  return f;
};
const SHORT: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit' };
const WD: Intl.DateTimeFormatOptions = { weekday: 'short', day: '2-digit', month: '2-digit' };
const FULL: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
const MONTH: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
const MON: Intl.DateTimeFormatOptions = { month: 'short' };
const at = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
export const fmtShort = (ymd: string) => dFmt(SHORT).format(at(ymd));
export const fmtWd = (ymd: string) => dFmt(WD).format(at(ymd));
export const fmtFull = (ymd: string) => dFmt(FULL).format(at(ymd));
export const fmtMonth = (ymd: string) => dFmt(MONTH).format(at(ymd));
export const fmtMon = (ymd: string) => dFmt(MON).format(at(ymd));
export const fmtWeekday = (ymd: string) => dFmt({ weekday: 'short' }).format(at(ymd));

/** "Heute", "Morgen", "Gestern" or "Mo, 05.10." */
export function relDay(ymd: string, today: string): string {
  const t = tr('pm');
  const n = diffDay(today, ymd);
  return n === 0 ? t('Heute') : n === 1 ? t('Morgen') : n === -1 ? t('Gestern') : fmtWd(ymd);
}


/** A local date and time in the sub-account's zone as an ISO instant (for start/end of time entries). */
export function zonedIso(ymd: string, hm: string, tz: string): string {
  const guess = Date.parse(`${ymd}T${hm}:00Z`);
  const offsetAt = (t: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - t;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t); // second pass for the hours around a clock change
  return new Date(t).toISOString();
}

// --- durations and money -----------------------------------------------------------------------------------

export function fmtMinutes(min: number | null | undefined): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  const t = tr('pm');
  return h && m ? t('{h} Std. {m} Min.', { h, m }) : h ? t('{h} Std.', { h }) : t('{m} Min.', { m });
}
/** 5400 → "1:30" */
export const fmtHM = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};
export const fmtHMS = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const hoursOf = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
export const fmtHours = (seconds: number) => {
  const t = tr('pm');
  return t('{h} Std.', { h: hoursOf(seconds).toLocaleString(intlLocale()) });
};
/** "1:30", "1,5", "90m", "2h", "45" (minutes) → minutes; null when it is not a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  let m = /^(\d+):(\d{1,2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)\s*(h|std\.?|stunden?|hrs?\.?|hours?)$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d+(?:\.\d+)?)\s*(m|min\.?|minuten?|mins?\.?|minutes?)$/.exec(t);
  if (m) return Math.round(Number(m[1]));
  m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) < 10 && t.includes('.') ? Math.round(Number(m[1]) * 60) : Math.round(Number(m[1]));
  return null;
}
export const eurosToCents = (v: string): number | null => {
  const n = Number(v.replace(',', '.'));
  return v.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
/** For an input field: "12,5" in German (as before), "12.5" in English – eurosToCents reads both. */
export const centsToEuros = (c: number | null | undefined) => (c || c === 0 ? (getLocale() === SOURCE_LOCALE ? String(c / 100).replace('.', ',') : String(c / 100)) : '');
