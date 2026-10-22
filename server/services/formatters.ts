import { addDaysYmd, hmInTz, isValidTz, tzOffsetMinutes, weekdayKey, ymdInTz, zonedToUtc, type DayKey } from '../core/time.js';
import { normalizePhone } from '../core/util.js';

/**
 * Pure formatting helpers behind the workflow steps "Text formatieren", "Zahl formatieren",
 * "Datum/Zeit" and the functions of the expression language (services/expr.ts): text (case, replace,
 * split, extract …), numbers (round, German/English number formats, currency) and dates (calendar-aware
 * add/subtract in the sub-account's time zone, business days, formats, zone conversion).
 * No I/O, no globals: everything gets its input as arguments, so it is easy to test.
 */

export class FormatError extends Error {}

// --- text -----------------------------------------------------------------------------------------

export const MAX_TEXT = 100_000;

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);
export const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * A regular expression from user input, refused when it could run for very long (nested quantifiers such as
 * `(a+)+`, back references, look-behind) or is huge. The text it runs on is cut to 10 000 characters by the callers.
 */
export function safeRegex(pattern: string, flags = ''): RegExp {
  if (pattern.length > 200) throw new FormatError('Regulärer Ausdruck zu lang (max. 200 Zeichen)');
  if (!/^[gimsuy]*$/.test(flags)) throw new FormatError('Ungültige Optionen für den regulären Ausdruck');
  if (/\\[1-9]|\(\?<[=!]|\(\?<\w+>.*\\k</.test(pattern)) throw new FormatError('Rückverweise und Look-behind sind nicht erlaubt');
  // A group that is repeated and itself contains a repeated part: (a+)+ (a*)* (a|aa)+ (.*a){3,}
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(pattern) || /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(pattern)) {
    throw new FormatError('Dieser reguläre Ausdruck könnte sehr lange laufen (verschachtelte Wiederholungen) und ist nicht erlaubt');
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new FormatError('Ungültiger regulärer Ausdruck');
  }
}

const REGEX_INPUT_MAX = 10_000;
export const regexInput = (s: string) => (s.length > REGEX_INPUT_MAX ? s.slice(0, REGEX_INPUT_MAX) : s);

export function slugify(s: string): string {
  return (
    str(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100)
  );
}

export function titleCase(s: string): string {
  return str(s)
    .toLowerCase()
    .replace(/(^|[\s\-'’(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
}

export function stripHtml(s: string): string {
  return str(s)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type TextOp =
  | 'upper' | 'lower' | 'capitalize' | 'title' | 'trim' | 'collapse_spaces' | 'replace' | 'regex_replace' | 'split' | 'extract' | 'extract_email' | 'extract_phone' | 'extract_number' | 'extract_url'
  | 'substring' | 'left' | 'right' | 'length' | 'truncate' | 'pad_left' | 'pad_right' | 'slug' | 'url_encode' | 'url_decode' | 'prepend' | 'append' | 'default' | 'phone' | 'first_word' | 'last_word'
  | 'initials' | 'reverse' | 'strip_html' | 'remove_diacritics' | 'repeat' | 'line_count' | 'word_count';

export const TEXT_OPS: Record<TextOp, string> = {
  upper: 'GROSSBUCHSTABEN',
  lower: 'kleinbuchstaben',
  capitalize: 'Ersten Buchstaben groß',
  title: 'Jedes Wort Groß',
  trim: 'Leerzeichen am Rand entfernen',
  collapse_spaces: 'Mehrfache Leerzeichen zu einem',
  replace: 'Text ersetzen',
  regex_replace: 'Ersetzen mit regulärem Ausdruck',
  split: 'Teilen (an Trennzeichen)',
  extract: 'Extrahieren (regulärer Ausdruck)',
  extract_email: 'Erste E-Mail-Adresse extrahieren',
  extract_phone: 'Erste Telefonnummer extrahieren',
  extract_number: 'Erste Zahl extrahieren',
  extract_url: 'Erste URL extrahieren',
  substring: 'Teilstück (ab Position, Länge)',
  left: 'Die ersten n Zeichen',
  right: 'Die letzten n Zeichen',
  length: 'Länge (Zeichen)',
  truncate: 'Kürzen mit „…“',
  pad_left: 'Links auffüllen',
  pad_right: 'Rechts auffüllen',
  slug: 'URL-Kürzel (slug)',
  url_encode: 'URL-kodieren',
  url_decode: 'URL-dekodieren',
  prepend: 'Text davor setzen',
  append: 'Text anhängen',
  default: 'Ersatzwert, wenn leer',
  phone: 'Telefonnummer vereinheitlichen (+49 …)',
  first_word: 'Erstes Wort',
  last_word: 'Letztes Wort',
  initials: 'Initialen',
  reverse: 'Umkehren',
  strip_html: 'HTML entfernen',
  remove_diacritics: 'Akzente entfernen (é → e)',
  repeat: 'Wiederholen',
  line_count: 'Zeilen zählen',
  word_count: 'Wörter zählen',
};

/** One text operation. `a`/`b` are the operation's arguments (e.g. search and replacement). Returns a string, or an array for `split`. */
export function textOp(op: TextOp | string, input: unknown, a?: unknown, b?: unknown): string | string[] | number {
  const s = clip(str(input));
  const A = str(a);
  switch (op) {
    case 'upper':
      return s.toUpperCase();
    case 'lower':
      return s.toLowerCase();
    case 'capitalize':
      return s.charAt(0).toUpperCase() + s.slice(1);
    case 'title':
      return titleCase(s);
    case 'trim':
      return s.trim();
    case 'collapse_spaces':
      return s.replace(/\s+/g, ' ').trim();
    case 'replace':
      return A ? clip(s.split(A).join(str(b))) : s;
    case 'regex_replace': {
      return clip(regexInput(s).replace(safeRegex(A, 'g'), str(b)));
    }
    case 'split': {
      const parts = A ? s.split(A) : s.split('');
      const n = Number(b);
      return Number.isFinite(n) && b !== undefined && b !== '' ? str(parts[n < 0 ? parts.length + n : n]) : parts.slice(0, 1000);
    }
    case 'extract': {
      const m = regexInput(s).match(safeRegex(A));
      if (!m) return '';
      const g = b === undefined || b === '' ? (m.length > 1 ? 1 : 0) : Number(b);
      return str(m[g] ?? '');
    }
    case 'extract_email':
      return s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? '';
    case 'extract_phone':
      return s.match(/\+?\d[\d\s().\/-]{6,}\d/)?.[0].trim() ?? '';
    case 'extract_number': {
      const m = regexInput(s).match(/-?\d[\d.,]*/);
      return m ? m[0].replace(/[.,]+$/, '') : '';
    }
    case 'extract_url':
      return s.match(/https?:\/\/[^\s<>"')]+/)?.[0] ?? '';
    case 'substring': {
      const start = Math.max(0, Math.floor(Number(a) || 0));
      const len = b === undefined || b === '' ? undefined : Math.max(0, Math.floor(Number(b) || 0));
      return len === undefined ? s.slice(start) : s.slice(start, start + len);
    }
    case 'left':
      return s.slice(0, Math.max(0, Math.floor(Number(a) || 0)));
    case 'right': {
      const n = Math.max(0, Math.floor(Number(a) || 0));
      return n ? s.slice(-n) : '';
    }
    case 'length':
      return [...s].length;
    case 'truncate': {
      const n = Math.max(1, Math.floor(Number(a) || 100));
      return [...s].length > n ? `${[...s].slice(0, n).join('').trimEnd()}${b === undefined ? '…' : str(b)}` : s;
    }
    case 'pad_left':
    case 'pad_right': {
      const n = Math.min(1000, Math.max(0, Math.floor(Number(a) || 0)));
      const fill = str(b) || ' ';
      return op === 'pad_left' ? s.padStart(n, fill) : s.padEnd(n, fill);
    }
    case 'slug':
      return slugify(s);
    case 'url_encode':
      return encodeURIComponent(s);
    case 'url_decode':
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    case 'prepend':
      return clip(A + s);
    case 'append':
      return clip(s + A);
    case 'default':
      return s.trim() === '' ? A : s;
    case 'phone':
      return normalizePhone(s, A || '+49');
    case 'first_word':
      return s.trim().split(/\s+/)[0] ?? '';
    case 'last_word': {
      const w = s.trim().split(/\s+/);
      return w[w.length - 1] ?? '';
    }
    case 'initials':
      return s
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase())
        .join('');
    case 'reverse':
      return [...s].reverse().join('');
    case 'strip_html':
      return stripHtml(s);
    case 'remove_diacritics':
      return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    case 'repeat': {
      const n = Math.max(0, Math.floor(Number(a) || 0));
      if (s.length * n > MAX_TEXT) throw new FormatError('Ergebnis wäre zu lang (höchstens 100 000 Zeichen)');
      return s.repeat(n);
    }
    case 'line_count':
      return s ? s.split(/\r?\n/).length : 0;
    case 'word_count':
      return s.trim() ? s.trim().split(/\s+/).length : 0;
    default:
      throw new FormatError(`Unbekannte Text-Aktion: ${op}`);
  }
}

// --- numbers --------------------------------------------------------------------------------------

/** Reads "1.234,56", "1,234.56", "12,5", "1 234", "€ 12.50", "-3" … as a number; NaN when there is none. */
export function parseNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  let s = str(v).trim().replace(/\s| |'/g, '');
  if (!s) return NaN;
  const neg = /^-|^\(.*\)$|-$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    normalized = dec === '.' ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(s) && (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    normalized = /^\d{1,3}(\.\d{3}){2,}$/.test(s) ? s.replace(/\./g, '') : s;
  } else normalized = s;
  const n = Number(normalized);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

export type NumberOp = 'round' | 'floor' | 'ceil' | 'abs' | 'format' | 'currency' | 'percent' | 'to_number' | 'pad' | 'clamp' | 'sign' | 'ordinal_de' | 'words_count' | 'fixed';

export const NUMBER_OPS: Record<NumberOp, string> = {
  round: 'Runden',
  floor: 'Abrunden',
  ceil: 'Aufrunden',
  abs: 'Betrag (ohne Vorzeichen)',
  format: 'Zahl formatieren (1.234,56)',
  currency: 'Als Währung formatieren (1.234,56 €)',
  percent: 'Als Prozent formatieren',
  to_number: 'Text in Zahl umwandeln (1.234,56 → 1234.56)',
  pad: 'Mit führenden Nullen auffüllen',
  clamp: 'Auf Bereich begrenzen (min/max)',
  sign: 'Vorzeichen (−1, 0, 1)',
  ordinal_de: 'Ordnungszahl (3.)',
  words_count: 'Ziffern zählen',
  fixed: 'Feste Nachkommastellen (Punkt)',
};

export interface NumberOpts {
  digits?: number;
  locale?: string;
  currency?: string;
  min?: number;
  max?: number;
  width?: number;
  /** For `round`: "half_even" (banker's rounding) instead of half away from zero. */
  mode?: 'half_up' | 'half_even';
}

export function roundTo(n: number, digits = 0, mode: 'half_up' | 'half_even' = 'half_up'): number {
  const d = Math.min(12, Math.max(0, Math.floor(digits)));
  // Shifting through the exponent avoids 1.005 * 100 = 100.49999999999999.
  const shifted = Number(`${Math.abs(n)}e${d}`);
  let r = Math.round(shifted);
  if (mode === 'half_even' && Math.abs(shifted - Math.trunc(shifted) - 0.5) < 1e-9) r = Math.trunc(shifted) % 2 === 0 ? Math.trunc(shifted) : Math.trunc(shifted) + 1;
  const out = Number(`${r}e-${d}`);
  return n < 0 ? -out : out;
}

/** Number format like Intl but with a fixed set of locales, so the output is the same on every machine. */
export function formatNumber(n: number, digits: number | undefined, locale = 'de-DE', opts: { min?: number } = {}): string {
  const loc = ['de-DE', 'en-US', 'en-GB', 'fr-FR', 'de-CH', 'de-AT'].includes(locale) ? locale : 'de-DE';
  const max = digits === undefined ? 20 : Math.min(20, Math.max(0, Math.floor(digits)));
  const min = digits === undefined ? (opts.min ?? 0) : max;
  return new Intl.NumberFormat(loc, { minimumFractionDigits: min, maximumFractionDigits: max }).format(n);
}

export function numberOp(op: NumberOp | string, input: unknown, o: NumberOpts = {}): string | number {
  const n = parseNumber(input);
  if (Number.isNaN(n)) throw new FormatError(str(input).trim() ? `„${str(input).slice(0, 40)}“ ist keine Zahl` : 'Keine Zahl angegeben');
  switch (op) {
    case 'round':
      return roundTo(n, o.digits ?? 0, o.mode);
    case 'floor': {
      const d = o.digits ?? 0;
      return Math.floor(Number(`${n}e${d}`)) / 10 ** d;
    }
    case 'ceil': {
      const d = o.digits ?? 0;
      return Math.ceil(Number(`${n}e${d}`)) / 10 ** d;
    }
    case 'abs':
      return Math.abs(n);
    case 'format':
      return formatNumber(roundTo(n, o.digits ?? 2), o.digits ?? 2, o.locale ?? 'de-DE');
    case 'currency': {
      const cur = /^[A-Za-z]{3}$/.test(o.currency ?? '') ? o.currency!.toUpperCase() : 'EUR';
      const loc = ['de-DE', 'en-US', 'en-GB', 'fr-FR', 'de-CH', 'de-AT'].includes(o.locale ?? '') ? o.locale! : 'de-DE';
      return new Intl.NumberFormat(loc, { style: 'currency', currency: cur }).format(roundTo(n, 2));
    }
    case 'percent':
      // 0.256 → 25,6 %; the input is a fraction unless `digits` is given with values already in percent (> 1)
      return `${formatNumber(roundTo(n * 100, o.digits ?? 1), o.digits ?? 1, o.locale ?? 'de-DE')} %`;
    case 'to_number':
      return n;
    case 'pad':
      return String(Math.trunc(n)).padStart(Math.min(20, Math.max(1, Math.floor(o.width ?? 3))), '0');
    case 'clamp':
      return Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, n));
    case 'sign':
      return Math.sign(n);
    case 'ordinal_de':
      return `${Math.trunc(n)}.`;
    case 'words_count':
      return String(Math.abs(Math.trunc(n))).length;
    case 'fixed':
      return roundTo(n, o.digits ?? 2).toFixed(Math.min(12, Math.max(0, o.digits ?? 2)));
    default:
      throw new FormatError(`Unbekannte Zahl-Aktion: ${op}`);
  }
}

// --- dates ----------------------------------------------------------------------------------------

export const DEFAULT_TZ = 'Europe/Berlin';
export const tzOrDefault = (tz?: string) => (tz && isValidTz(tz) ? tz : DEFAULT_TZ);

export type DateUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years' | 'business_days';
export const DATE_UNITS: Record<DateUnit, string> = { minutes: 'Minuten', hours: 'Stunden', days: 'Tage', weeks: 'Wochen', months: 'Monate', years: 'Jahre', business_days: 'Werktage (Mo–Fr)' };

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** The wall clock of an instant in a zone. */
export function wallClock(at: Date, tz: string): Wall {
  const ymd = ymdInTz(at, tz);
  const [y, mo, d] = ymd.split('-').map(Number);
  const hm = hmInTz(at, tz).split(':').map(Number);
  const s = Math.floor(at.getTime() / 1000) % 60;
  return { y, mo, d, h: hm[0] % 24, mi: hm[1], s: ((s % 60) + 60) % 60 };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const ymdOf = (w: { y: number; mo: number; d: number }) => `${String(w.y).padStart(4, '0')}-${pad2(w.mo)}-${pad2(w.d)}`;

/** The instant at which the zone's wall clock shows `w` (a time that does not exist because of DST moves forward). */
export function fromWall(w: Wall, tz: string): Date {
  const t = zonedToUtc(ymdOf(w), `${pad2(w.h)}:${pad2(w.mi)}`, tz);
  return new Date(t.getTime() + w.s * 1000);
}

const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/**
 * Reads a date from what people and APIs write: ISO timestamps, YYYY-MM-DD, DD.MM.YYYY (optionally with
 * HH:mm), epoch seconds/milliseconds, "now"/"today". Without an explicit offset the zone's wall clock is meant.
 */
export function parseDate(input: unknown, tz: string = DEFAULT_TZ, from: Date = new Date()): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number' && Number.isFinite(input)) return new Date(input > 1e11 ? input : input * 1000);
  const s = str(input).trim();
  if (!s) return null;
  if (/^now$/i.test(s)) return new Date(from);
  if (/^today$/i.test(s)) return zonedToUtc(ymdInTz(from, tz), '00:00', tz);
  if (/^\d{9,13}$/.test(s)) return new Date(s.length > 11 ? Number(s) : Number(s) * 1000);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (m) {
    const [, y, mo, d, h, mi, sec, off] = m;
    if (off) {
      const iso = `${y}-${pad2(+mo)}-${pad2(+d)}T${pad2(+h)}:${mi}:${pad2(+(sec ?? 0))}${/^z$/i.test(off) ? 'Z' : off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off}`;
      const t = new Date(iso);
      return Number.isNaN(t.getTime()) ? null : t;
    }
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > daysInMonth(+y, +mo)) return null;
    return fromWall({ y: +y, mo: +mo, d: +d, h: h ? +h : 0, mi: mi ? +mi : 0, s: sec ? +sec : 0 }, tz);
  }
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h, mi, sec] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > daysInMonth(+y, +mo)) return null;
    return fromWall({ y: +y, mo: +mo, d: +d, h: h ? +h : 0, mi: mi ? +mi : 0, s: sec ? +sec : 0 }, tz);
  }
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : t;
}

export function isBusinessDay(ymd: string, holidays: ReadonlySet<string> = new Set()): boolean {
  const k = weekdayKey(ymd);
  return k !== 'sat' && k !== 'sun' && !holidays.has(ymd);
}

export function addBusinessDays(ymd: string, n: number, holidays: ReadonlySet<string> = new Set()): string {
  let cur = ymd;
  const step = n < 0 ? -1 : 1;
  let left = Math.min(5000, Math.abs(Math.trunc(n)));
  while (left > 0) {
    cur = addDaysYmd(cur, step);
    if (isBusinessDay(cur, holidays)) left--;
  }
  return cur;
}

/**
 * Adds `amount` of `unit` to an instant. Days, weeks, months, years and business days move the zone's wall
 * clock (so "+1 day" at 12:00 stays 12:00 across a daylight-saving change, even though it is 23 or 25 hours);
 * minutes and hours are elapsed time. Months clamp the day (31 Jan + 1 month = 28/29 Feb).
 */
export function addToDate(at: Date, amount: number, unit: DateUnit | string, tz: string = DEFAULT_TZ, holidays: ReadonlySet<string> = new Set()): Date {
  const n = Math.trunc(Number(amount) || 0);
  if (Math.abs(n) > 100_000) throw new FormatError('Betrag zu groß');
  if (unit === 'minutes') return new Date(at.getTime() + n * 60_000);
  if (unit === 'hours') return new Date(at.getTime() + n * 3_600_000);
  const w = wallClock(at, tz);
  if (unit === 'days' || unit === 'weeks') {
    const ymd = addDaysYmd(ymdOf(w), unit === 'weeks' ? n * 7 : n);
    const [y, mo, d] = ymd.split('-').map(Number);
    return fromWall({ ...w, y, mo, d }, tz);
  }
  if (unit === 'business_days') {
    const ymd = addBusinessDays(ymdOf(w), n, holidays);
    const [y, mo, d] = ymd.split('-').map(Number);
    return fromWall({ ...w, y, mo, d }, tz);
  }
  if (unit === 'months' || unit === 'years') {
    const total = w.y * 12 + (w.mo - 1) + (unit === 'years' ? n * 12 : n);
    const y = Math.floor(total / 12);
    const mo = (total % 12) + 1;
    return fromWall({ ...w, y, mo, d: Math.min(w.d, daysInMonth(y, mo)) }, tz);
  }
  throw new FormatError(`Unbekannte Einheit: ${unit}`);
}

export type DateBoundary = 'day' | 'week' | 'month' | 'year' | 'hour';

export function startOf(at: Date, unit: DateBoundary | string, tz: string = DEFAULT_TZ): Date {
  const w = wallClock(at, tz);
  if (unit === 'hour') return fromWall({ ...w, mi: 0, s: 0 }, tz);
  if (unit === 'day') return fromWall({ ...w, h: 0, mi: 0, s: 0 }, tz);
  if (unit === 'week') {
    const order: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const back = order.indexOf(weekdayKey(ymdOf(w)));
    const [y, mo, d] = addDaysYmd(ymdOf(w), -back).split('-').map(Number);
    return fromWall({ y, mo, d, h: 0, mi: 0, s: 0 }, tz);
  }
  if (unit === 'month') return fromWall({ ...w, d: 1, h: 0, mi: 0, s: 0 }, tz);
  if (unit === 'year') return fromWall({ y: w.y, mo: 1, d: 1, h: 0, mi: 0, s: 0 }, tz);
  throw new FormatError(`Unbekannte Einheit: ${unit}`);
}

export function endOf(at: Date, unit: DateBoundary | string, tz: string = DEFAULT_TZ): Date {
  const start = startOf(at, unit, tz);
  const next = unit === 'hour' ? new Date(start.getTime() + 3_600_000) : addToDate(start, 1, unit === 'day' ? 'days' : unit === 'week' ? 'weeks' : unit === 'month' ? 'months' : 'years', tz);
  return new Date(next.getTime() - 1000);
}

export type DiffUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years' | 'business_days';

/** Whole units from `a` to `b` (negative when b is earlier). Days are calendar days of the zone, not 24-hour blocks. */
export function diffDates(a: Date, b: Date, unit: DiffUnit | string, tz: string = DEFAULT_TZ): number {
  if (unit === 'minutes') return Math.trunc((b.getTime() - a.getTime()) / 60_000);
  if (unit === 'hours') return Math.trunc((b.getTime() - a.getTime()) / 3_600_000);
  const wa = wallClock(a, tz);
  const wb = wallClock(b, tz);
  const dayNo = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d) / 864e5;
  if (unit === 'days' || unit === 'weeks' || unit === 'business_days') {
    let days = dayNo(wb) - dayNo(wa);
    // a partial last day does not count (Mon 18:00 → Tue 09:00 is 0 whole days)
    const tA = wa.h * 3600 + wa.mi * 60 + wa.s;
    const tB = wb.h * 3600 + wb.mi * 60 + wb.s;
    if (days > 0 && tB < tA) days -= 1;
    else if (days < 0 && tB > tA) days += 1;
    if (unit === 'days') return days;
    if (unit === 'weeks') return Math.trunc(days / 7);
    let count = 0;
    let cur = ymdOf(wa);
    const step = days < 0 ? -1 : 1;
    for (let i = 0; i < Math.min(Math.abs(days), 20000); i++) {
      cur = addDaysYmd(cur, step);
      if (isBusinessDay(cur)) count += step;
    }
    return count;
  }
  if (unit === 'months' || unit === 'years') {
    let months = (wb.y - wa.y) * 12 + (wb.mo - wa.mo);
    const rest = (w: Wall) => ((w.d * 24 + w.h) * 60 + w.mi) * 60 + w.s;
    if (months > 0 && rest(wb) < rest(wa)) months -= 1;
    else if (months < 0 && rest(wb) > rest(wa)) months += 1;
    return unit === 'years' ? Math.trunc(months / 12) : months;
  }
  throw new FormatError(`Unbekannte Einheit: ${unit}`);
}

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** ISO weekday 1 (Mon) … 7 (Sun). */
export const isoWeekday = (ymd: string) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekdayKey(ymd)) || 7;

/**
 * Formats an instant in a zone. Patterns: YYYY YY MM M DD D HH H mm ss, MMMM (month name), MMM, dddd (weekday name),
 * ddd, Z (+02:00), plus the shortcuts "iso" (UTC), "date" (31.12.2026), "datetime" (31.12.2026 14:30), "time" (14:30),
 * "long" (Donnerstag, 31. Dezember 2026) and "unix". `lang` is de or en for names. Text in [brackets] is kept as it is.
 */
export function formatDate(at: Date, pattern: string, tz: string = DEFAULT_TZ, lang: 'de' | 'en' = 'de'): string {
  const p = pattern || 'datetime';
  if (p === 'iso') return at.toISOString();
  if (p === 'unix') return String(Math.floor(at.getTime() / 1000));
  if (p === 'iso_local') return formatDate(at, 'YYYY-MM-DD[T]HH:mm:ssZ', tz, lang);
  const w = wallClock(at, tz);
  const ymd = ymdOf(w);
  const names = lang === 'en' ? { m: MONTHS_EN, d: DAYS_EN } : { m: MONTHS_DE, d: DAYS_DE };
  const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekdayKey(ymd));
  const preset: Record<string, string> = { date: 'DD.MM.YYYY', datetime: 'DD.MM.YYYY HH:mm', time: 'HH:mm', long: lang === 'en' ? 'dddd, MMMM D, YYYY' : 'dddd, D. MMMM YYYY' };
  const off = tzOffsetMinutes(at, tz);
  const offStr = `${off < 0 ? '-' : '+'}${pad2(Math.floor(Math.abs(off) / 60))}:${pad2(Math.abs(off) % 60)}`;
  const tokens: Record<string, string> = {
    YYYY: String(w.y).padStart(4, '0'),
    YY: String(w.y).slice(-2),
    MMMM: names.m[w.mo - 1],
    MMM: names.m[w.mo - 1].slice(0, 3),
    MM: pad2(w.mo),
    M: String(w.mo),
    DD: pad2(w.d),
    D: String(w.d),
    dddd: names.d[dow],
    ddd: names.d[dow].slice(0, 2),
    HH: pad2(w.h),
    H: String(w.h),
    hh: pad2(w.h % 12 || 12),
    mm: pad2(w.mi),
    ss: pad2(w.s),
    Z: offStr,
  };
  return (preset[p] ?? p).replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|mm|ss|Z/g, (m, lit?: string) => (lit !== undefined ? lit : tokens[m]));
}

export type DateOp = 'add' | 'subtract' | 'format' | 'convert_tz' | 'start_of' | 'end_of' | 'diff' | 'weekday' | 'is_business_day' | 'next_business_day' | 'age' | 'iso' | 'unix' | 'set_time';

export const DATE_OPS: Record<DateOp, string> = {
  add: 'Zeit addieren',
  subtract: 'Zeit abziehen',
  format: 'Formatieren',
  convert_tz: 'In andere Zeitzone umrechnen',
  start_of: 'Anfang von Tag/Woche/Monat/Jahr',
  end_of: 'Ende von Tag/Woche/Monat/Jahr',
  diff: 'Differenz zu einem anderen Datum',
  weekday: 'Wochentag',
  is_business_day: 'Ist Werktag? (ja/nein)',
  next_business_day: 'Nächster Werktag',
  age: 'Alter in Jahren',
  iso: 'Als ISO-Zeitstempel (UTC)',
  unix: 'Als Unix-Sekunden',
  set_time: 'Uhrzeit setzen (HH:mm)',
};

export interface DateOpts {
  amount?: number;
  unit?: string;
  pattern?: string;
  tz?: string;
  to_tz?: string;
  other?: unknown;
  lang?: 'de' | 'en';
  time?: string;
  holidays?: string[];
  from?: Date;
}

/** One date operation; returns a string (formatted) or a number (differences). Dates come out as ISO (UTC) unless the operation formats. */
export function dateOp(op: DateOp | string, input: unknown, o: DateOpts = {}): string | number {
  const tz = tzOrDefault(o.tz);
  const holidays = new Set((o.holidays ?? []).map(String));
  const at = parseDate(input === undefined || input === '' ? 'now' : input, tz, o.from);
  if (!at) throw new FormatError(`„${str(input).slice(0, 40)}“ ist kein Datum`);
  const iso = (d: Date) => d.toISOString();
  switch (op) {
    case 'add':
      return iso(addToDate(at, Number(o.amount) || 0, o.unit ?? 'days', tz, holidays));
    case 'subtract':
      return iso(addToDate(at, -(Number(o.amount) || 0), o.unit ?? 'days', tz, holidays));
    case 'format':
      return formatDate(at, o.pattern || 'datetime', tz, o.lang);
    case 'convert_tz':
      return formatDate(at, o.pattern || 'iso_local', tzOrDefault(o.to_tz), o.lang);
    case 'start_of':
      return iso(startOf(at, o.unit ?? 'day', tz));
    case 'end_of':
      return iso(endOf(at, o.unit ?? 'day', tz));
    case 'diff': {
      const other = parseDate(o.other === undefined || o.other === '' ? 'now' : o.other, tz, o.from);
      if (!other) throw new FormatError('Vergleichsdatum ist ungültig');
      return diffDates(at, other, o.unit ?? 'days', tz);
    }
    case 'weekday':
      return o.pattern === 'number' ? isoWeekday(ymdInTz(at, tz)) : formatDate(at, 'dddd', tz, o.lang);
    case 'is_business_day':
      return isBusinessDay(ymdInTz(at, tz), holidays) ? 'ja' : 'nein';
    case 'next_business_day': {
      const [y, mo, d] = addBusinessDays(ymdInTz(at, tz), 1, holidays).split('-').map(Number);
      return iso(fromWall({ ...wallClock(at, tz), y, mo, d }, tz));
    }
    case 'age':
      return diffDates(at, parseDate(o.other ?? 'now', tz, o.from) ?? new Date(), 'years', tz);
    case 'iso':
      return iso(at);
    case 'unix':
      return Math.floor(at.getTime() / 1000);
    case 'set_time': {
      const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(o.time ?? '');
      if (!m) throw new FormatError('Uhrzeit als HH:mm angeben');
      return iso(fromWall({ ...wallClock(at, tz), h: +m[1], mi: +m[2], s: 0 }, tz));
    }
    default:
      throw new FormatError(`Unbekannte Datums-Aktion: ${op}`);
  }
}

// --- time windows (business hours) ---------------------------------------------------------------

const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (hm: string) => {
  const m = HM_RE.exec(hm);
  return m ? +m[1] * 60 + +m[2] : null;
};

export interface Window {
  days?: string[];
  from?: string;
  to?: string;
  holidays?: string[];
}

/**
 * When the next allowed moment starts: now if `at` lies inside the window (allowed weekday and from ≤ time < to in
 * the zone), otherwise the next window start. Windows may not wrap past midnight (use two windows or 00:00–24:00).
 * Returns null when the window can never be reached (no allowed day within eight weeks).
 */
export function nextInWindow(at: Date, w: Window, tz: string = DEFAULT_TZ): Date | null {
  const days = w.days?.length ? w.days : ['mon', 'tue', 'wed', 'thu', 'fri'];
  const from = toMin(w.from ?? '09:00') ?? 540;
  const to = w.to === '24:00' ? 1440 : (toMin(w.to ?? '17:00') ?? 1020);
  if (to <= from) throw new FormatError('Das Zeitfenster muss „von“ vor „bis“ liegen');
  const holidays = new Set((w.holidays ?? []).map(String));
  const today = ymdInTz(at, tz);
  const wall = wallClock(at, tz);
  const nowMin = wall.h * 60 + wall.mi;
  for (let i = 0; i < 8 * 7; i++) {
    const ymd = addDaysYmd(today, i);
    if (!days.includes(weekdayKey(ymd)) || holidays.has(ymd)) continue;
    if (i === 0) {
      if (nowMin >= from && nowMin < to) return at;
      if (nowMin >= to) continue;
    }
    return zonedToUtc(ymd, `${pad2(Math.floor(from / 60))}:${pad2(from % 60)}`, tz);
  }
  return null;
}
