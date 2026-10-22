import { addDaysYmd, hmInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { CONTACT_FIELDS } from './contacts.js';

/**
 * Pure helpers of the additional workflow triggers: a cron expression reader that works on the wall clock of a time zone,
 * the diff of a contact before/after an update (for "Feld geändert"), and the birthday/anniversary date matching.
 */

// --- cron -----------------------------------------------------------------------------------------

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  source: string;
}

const NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MACROS: Record<string, string> = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };

function field(src: string, lo: number, hi: number, label: string, names = false): { set: Set<number>; any: boolean } {
  const out = new Set<number>();
  const val = (s: string): number => {
    const k = s.toLowerCase();
    const n = names && k in NAMES ? NAMES[k] : /^\d+$/.test(s) ? Number(s) : NaN;
    if (Number.isNaN(n) || n < lo || n > hi + (label === 'Wochentag' ? 1 : 0)) throw new Error(`${label}: „${s}“ ist ungültig (${lo}–${hi})`);
    return label === 'Wochentag' && n === 7 ? 0 : n;
  };
  for (const part of src.split(',')) {
    if (!part) throw new Error(`${label}: leerer Eintrag`);
    const [range, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${label}: Schrittweite „${stepS}“ ist ungültig`);
    let a: number;
    let b: number;
    if (range === '*' || range === '?') [a, b] = [lo, hi];
    else if (range.includes('-')) {
      const [x, y] = range.split('-');
      [a, b] = [val(x), val(y)];
      if (label === 'Wochentag' && y === '7') b = 7;
    } else {
      a = val(range);
      b = stepS === undefined ? a : hi;
    }
    if (a > b && !(label === 'Wochentag' && b === 0)) throw new Error(`${label}: Bereich „${range}“ ist rückwärts`);
    for (let n = a; n <= b; n += step) out.add(label === 'Wochentag' && n === 7 ? 0 : n);
  }
  return { set: out, any: src === '*' || src === '?' };
}

/** Reads `m h dom mon dow` (also lists, ranges, steps, names and @daily-style macros). Throws a German message when it is invalid. */
export function parseCron(expr: string): Cron {
  const src = String(expr ?? '').trim().replace(/\s+/g, ' ');
  const full = MACROS[src.toLowerCase()] ?? src;
  const p = full.split(' ');
  if (p.length !== 5) throw new Error('Zeitplan: fünf Felder erwartet – Minute Stunde Tag Monat Wochentag (z. B. 0 9 * * 1-5)');
  const [mi, h, d, mo, w] = [field(p[0], 0, 59, 'Minute'), field(p[1], 0, 23, 'Stunde'), field(p[2], 1, 31, 'Tag'), field(p[3], 1, 12, 'Monat', true), field(p[4], 0, 6, 'Wochentag', true)];
  return { minute: mi.set, hour: h.set, dom: d.set, month: mo.set, dow: w.set, domAny: d.any, dowAny: w.any, source: full };
}

/** Does the wall-clock minute match? (Day of month and weekday: if both are restricted, either one is enough – as cron does.) */
export function cronMatches(c: Cron, w: { y: number; mo: number; d: number; h: number; mi: number }): boolean {
  if (!c.minute.has(w.mi) || !c.hour.has(w.h) || !c.month.has(w.mo)) return false;
  const dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
  const domOk = c.dom.has(w.d);
  const dowOk = c.dow.has(dow);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** Wall-clock minutes as a running number (UTC arithmetic on the wall clock) – steps by 1 even over a DST gap. */
export const wallMinute = (w: { y: number; mo: number; d: number; h: number; mi: number }) => Math.floor(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) / 60_000);
export const fromWallMinute = (n: number) => {
  const d = new Date(n * 60_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
};

/**
 * The wall-clock minutes in (from, to] at which the cron fires. `from` and `to` are wall-minute numbers. Because the wall clock
 * jumps forward over a DST gap, a job planned inside the gap fires right after it; when the clock goes back, nothing fires twice.
 */
export function cronFires(c: Cron, fromWall: number, toWall: number, max = 1500): number[] {
  const out: number[] = [];
  for (let m = fromWall + 1; m <= toWall && m - fromWall <= max; m++) if (cronMatches(c, fromWallMinute(m))) out.push(m);
  return out;
}

// --- contact diff ---------------------------------------------------------------------------------

export interface FieldChange {
  field: string;
  old: string;
  new: string;
}

const txt = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The fields that really changed between two versions of a contact: standard fields, `dnd` and every `custom.<key>`. */
export function diffContact(before: Record<string, any>, after: Record<string, any>, limit = 40): FieldChange[] {
  const out: FieldChange[] = [];
  for (const f of [...CONTACT_FIELDS, 'dnd'] as string[]) {
    if (!(f in before) && !(f in after)) continue;
    const a = txt(before[f]);
    const b = txt(after[f]);
    if (a !== b && !(f === 'dnd' && Number(a || 0) === Number(b || 0))) out.push({ field: f, old: a, new: b });
  }
  const keys = new Set([...Object.keys(before.custom ?? {}), ...Object.keys(after.custom ?? {})]);
  for (const k of keys) {
    const a = txt(before.custom?.[k]);
    const b = txt(after.custom?.[k]);
    if (a !== b) out.push({ field: `custom.${k}`, old: a, new: b });
  }
  return out.slice(0, limit);
}

/** Does a "Feld geändert" trigger want this change? `field` empty/`*` = any, `from`/`to` compare ignoring case; `from_empty`/`to_empty` for "was empty"/"is empty now". */
export function fieldChangeMatches(config: Record<string, any>, data: Record<string, any>): boolean {
  const f = String(config.field ?? '').trim();
  if (f && f !== '*' && f !== data.field) return false;
  const eq = (a: unknown, b: unknown) => txt(a).trim().toLowerCase() === txt(b).trim().toLowerCase();
  if (config.from !== undefined && String(config.from) !== '' && !eq(config.from, data.old)) return false;
  if (config.to !== undefined && String(config.to) !== '' && !eq(config.to, data.new)) return false;
  if (config.from_empty && txt(data.old).trim() !== '') return false;
  if (config.to_empty && txt(data.new).trim() !== '') return false;
  return true;
}

// --- birthdays and anniversaries ------------------------------------------------------------------

/** How many days back a date trigger (birthday, anniversary, „Datum erreicht“) catches up on a day it missed. */
export const DATE_CATCH_UP_DAYS = 3;

/**
 * The days a date trigger is due on at `at`, oldest first: today once its time (`hh:mm` in `tz`) has come – and the days whose
 * time passed while the scanner did not run (server down, a scan that straddled midnight), at most DATE_CATCH_UP_DAYS back. A
 * missed day counts only when its time lies after the last scan of the workflow (`seen`; none yet = nothing to catch up) and after
 * the workflow's last change (`since`: switched on, edited) – a workflow switched on today, or paused for a week, does not send
 * what fell due before. `late` is the number of days a run comes late.
 */
export function dueDays(at: Date, tz: string, time: string, seen: string | null | undefined, since: string): { day: string; late: number }[] {
  const today = ymdInTz(at, tz);
  const out: { day: string; late: number }[] = [];
  if (seen) {
    for (let late = DATE_CATCH_UP_DAYS; late >= 1; late--) {
      const day = addDaysYmd(today, -late);
      const due = zonedToUtc(day, time, tz).toISOString();
      if (due > seen && due > since && due <= at.toISOString()) out.push({ day, late });
    }
  }
  if (hmInTz(at, tz) >= time) out.push({ day: today, late: 0 });
  return out;
}

/** Month and day of "YYYY-MM-DD" or "DD.MM.YYYY" as "MM-DD", else null. */
export function monthDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export const yearOf = (v: unknown): number | null => {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-/) ?? s.match(/(\d{4})$/);
  return m ? Number(m[1]) : null;
};

/** Is a leap year? */
export const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The "MM-DD" values a date counts as on `ymd`: 29 February also counts on 28 February in years without one. */
export function monthDaysForToday(ymd: string): string[] {
  const [y, m, d] = ymd.split('-');
  const md = `${m}-${d}`;
  return md === '02-28' && !isLeap(Number(y)) ? ['02-28', '02-29'] : [md];
}
