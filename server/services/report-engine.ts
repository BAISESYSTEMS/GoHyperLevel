import type { DatabaseSync } from 'node:sqlite';
import type { Db, Param } from '../core/db.js';
import { addDaysYmd, localDayStart, tzOffsetMinutes, ymdInTz, zonedToUtc } from '../core/time.js';
import { csvSafe } from '../core/csv.js';

/**
 * Report engine: turns a declarative report query (source, measures, group-by, filters, date range)
 * into ONE parameterised SQL statement over a registered report source. Sources are plain objects
 * (see report-sources.ts and app.services.reportSources); their SQL snippets are trusted code, every
 * user value travels as a bound parameter, every query is scoped to the caller's sub-accounts, has a
 * row limit and a time limit (checked per scanned row by the rpt_tick() SQL function).
 */

export type FieldType = 'string' | 'enum' | 'number' | 'date' | 'boolean' | 'tags';
export type Format = 'number' | 'money' | 'percent' | 'days' | 'minutes';
export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct';
export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'weekday' | 'hour';
export type Lookup = (db: Db, keys: string[]) => Map<string, { label: string; order?: number }>;

export interface ReportField {
  key: string;
  label: string;
  type: FieldType;
  /** Trusted SQL expression over the source's aliases (never built from user input). */
  sql: string;
  format?: Format;
  /** enum/boolean: value → label (booleans use '1'/'0'). */
  options?: Record<string, string>;
  /** id → label (and natural order, e.g. pipeline stages). */
  lookup?: Lookup;
  /** Label for NULL/'' values. */
  empty?: string;
  /** Key of the source join this field needs. */
  join?: string;
  /** Heading in the field picker ("Kontakt"). */
  group?: string;
  /** Free text that makes no sense as a group (still filterable). */
  noGroup?: boolean;
  /** Sub-accounts this field exists in (e.g. a custom property); omitted = everywhere. Others never see it. */
  locations?: string[];
}

export interface ReportCalc {
  key: string;
  label: string;
  /** Trusted aggregate SQL expression. */
  sql: string;
  format?: Format;
  join?: string;
  description?: string;
}

export interface ReportJoin {
  sql: string;
  /** Tables that must exist (module installed), else the join and its fields are hidden. */
  requires?: string[];
}

export interface ReportSource {
  key: string;
  label: string;
  description?: string;
  /** Permission area (server/core/permissions.ts) a member needs; also checked against SaaS plans. */
  area: string;
  /** FROM clause incl. alias, e.g. `opportunities o`. */
  from: string;
  /** SQL expression of the row's sub-account id, e.g. `o.location_id`. */
  location: string;
  /** Fixed condition (e.g. no drafts). */
  where?: string;
  /** Default date field for the report's date range. */
  dateField: string;
  countLabel?: string;
  /** Count expression (default COUNT(*)). */
  count?: string;
  fields: ReportField[];
  calcs?: ReportCalc[];
  joins?: Record<string, ReportJoin>;
  requires?: string[];
  /** Sub-accounts this source exists in (e.g. a custom object); omitted = everywhere. Others never see it. */
  locations?: string[];
}

/**
 * The sources as one caller may see them: sources and fields that belong to other sub-accounts
 * (custom objects and properties carry `locations`) are left out, so their names never leak.
 */
export function scopeSources(list: ReportSource[], visible: string[] | 'all'): ReportSource[] {
  if (visible === 'all') return list;
  const mine = (l?: string[]) => !l || l.some((x) => visible.includes(x));
  return list.filter((s) => mine(s.locations)).map((s) => (s.fields.some((f) => f.locations) ? { ...s, fields: s.fields.filter((f) => mine(f.locations)) } : s));
}

export interface ReportFilter {
  field: string;
  op: string;
  value?: unknown;
}
export interface GroupBy {
  field: string;
  bucket?: Bucket;
}
export type RangeSpec = string | { from: string; to: string };

export interface ReportQuery {
  source: string;
  measures: string[];
  groupBy: GroupBy[];
  filters: ReportFilter[];
  dateField: string;
  range: RangeSpec;
  compare: boolean;
  sort?: { by: string; dir: 'asc' | 'desc' };
  limit?: number;
}

export interface RunContext {
  db: Db;
  sources: ReportSource[];
  /** Sub-accounts the rows may come from (already checked against the caller's rights). */
  locations: string[];
  tz: string;
  now?: Date;
  timeoutMs?: number;
  maxRows?: number;
  /** Narrows a source's rows to what the caller may see (record-access rules, docs/sales.md): a SQL condition over the source's aliases. */
  rowScope?: (src: ReportSource) => { sql: string; params: Param[] } | undefined;
}

export interface ResultRow {
  /** Group keys (raw) and their display labels. */
  k: (string | null)[];
  l: string[];
  /** Measure values in query order; p = same measures in the previous period. */
  v: (number | null)[];
  p?: (number | null)[];
}

export interface ReportResult {
  source: { key: string; label: string };
  /** `values`: the group's distinct keys/labels in display order. */
  dims: { field: string; label: string; type: FieldType; bucket?: Bucket; values: { k: string | null; l: string }[] }[];
  measures: { key: string; label: string; format: Format }[];
  rows: ResultRow[];
  totals: { v: (number | null)[]; p?: (number | null)[] };
  /** Time axis (every bucket of the range) when the first group is a date. */
  axis?: { k: string; l: string }[];
  range: RangeInfo;
  previous: RangeInfo | null;
  truncated: boolean;
  ms: number;
}

export class ReportError extends Error {}

export const MAX_MEASURES = 6;
export const MAX_GROUPS = 2;
export const MAX_FILTERS = 20;
const BUCKETS: Bucket[] = ['day', 'week', 'month', 'quarter', 'year', 'weekday', 'hour'];
const AGGS: Agg[] = ['count', 'sum', 'avg', 'min', 'max', 'count_distinct'];

/** Operators per field type (the UI offers the same lists). */
export const OPS: Record<FieldType, string[]> = {
  string: ['eq', 'neq', 'in', 'not_in', 'contains', 'not_contains', 'starts_with', 'empty', 'not_empty'],
  enum: ['eq', 'neq', 'in', 'not_in', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'],
  date: ['in_range', 'before', 'after', 'empty', 'not_empty'],
  boolean: ['is_true', 'is_false'],
  tags: ['has', 'not_has', 'empty', 'not_empty'],
};

// --- date ranges --------------------------------------------------------------------------------

export const RANGE_PRESETS: Record<string, string> = {
  today: 'Heute',
  yesterday: 'Gestern',
  this_week: 'Diese Woche',
  last_week: 'Letzte Woche',
  last_7_days: 'Letzte 7 Tage',
  last_30_days: 'Letzte 30 Tage',
  last_90_days: 'Letzte 90 Tage',
  last_365_days: 'Letzte 365 Tage',
  this_month: 'Dieser Monat',
  last_month: 'Letzter Monat',
  this_quarter: 'Dieses Quartal',
  last_quarter: 'Letztes Quartal',
  this_year: 'Dieses Jahr',
  last_year: 'Letztes Jahr',
  last_12_months: 'Letzte 12 Monate',
  all: 'Gesamter Zeitraum',
};

export interface RangeInfo {
  /** UTC instants (ISO); null = unbounded. `to` is exclusive. */
  from: string | null;
  to: string | null;
  /** Local calendar days, `toYmd` exclusive. */
  fromYmd: string | null;
  toYmd: string | null;
  label: string;
  dates: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const ymdParts = (ymd: string) => ymd.split('-').map(Number) as [number, number, number];
const fmtYmd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addMonthsYmd = (ymd: string, n: number) => {
  const [y, m, d] = ymdParts(ymd);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmtYmd(y, m + n, Math.min(d, last));
};
const daysBetween = (a: string, b: string) => Math.round((Date.UTC(...toUtcArgs(b)) - Date.UTC(...toUtcArgs(a))) / 864e5);
function toUtcArgs(ymd: string): [number, number, number] {
  const [y, m, d] = ymdParts(ymd);
  return [y, m - 1, d];
}
const isoDow = (ymd: string) => ((new Date(Date.UTC(...toUtcArgs(ymd))).getUTCDay() + 6) % 7) + 1;
const deDate = (ymd: string) => {
  const [y, m, d] = ymdParts(ymd);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
};

function info(fromYmd: string | null, toYmd: string | null, tz: string, label: string): RangeInfo {
  const dates = fromYmd && toYmd ? (daysBetween(fromYmd, toYmd) <= 1 ? deDate(fromYmd) : `${deDate(fromYmd)} – ${deDate(addDaysYmd(toYmd, -1))}`) : 'alle Daten';
  return {
    from: fromYmd ? zonedToUtc(fromYmd, '00:00', tz).toISOString() : null,
    to: toYmd ? zonedToUtc(toYmd, '00:00', tz).toISOString() : null,
    fromYmd,
    toYmd,
    label,
    dates,
  };
}

/** Resolves a preset ("last_30_days", "this_month" …) or {from, to} (inclusive days) in the zone, plus the period before it. */
export function resolveRange(spec: RangeSpec | undefined, tz: string, now = new Date()): { current: RangeInfo; previous: RangeInfo | null } {
  const today = ymdInTz(now, tz);
  const tomorrow = addDaysYmd(today, 1);
  const shift = (from: string, to: string, prevFrom: string, prevTo: string, label: string) => ({
    current: info(from, to, tz, label),
    previous: info(prevFrom, prevTo, tz, 'Vorperiode'),
  });
  if (spec && typeof spec === 'object') {
    const from = String(spec.from ?? '');
    const to = String(spec.to ?? '');
    if (!YMD.test(from) || !YMD.test(to) || from > to) throw new ReportError('Zeitraum: von/bis als JJJJ-MM-TT');
    const end = addDaysYmd(to, 1);
    const len = daysBetween(from, end);
    if (len > 366 * 20) throw new ReportError('Zeitraum ist zu lang');
    return shift(from, end, addDaysYmd(from, -len), from, `${deDate(from)} – ${deDate(to)}`);
  }
  const key = spec || 'last_30_days';
  const label = RANGE_PRESETS[key];
  if (!label) throw new ReportError(`Unbekannter Zeitraum: ${key}`);
  const [y, m] = ymdParts(today);
  const monthStart = fmtYmd(y, m, 1);
  const qStart = fmtYmd(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  const yearStart = fmtYmd(y, 1, 1);
  const weekStart = addDaysYmd(today, 1 - isoDow(today));
  const lastN = (n: number) => shift(addDaysYmd(today, 1 - n), tomorrow, addDaysYmd(today, 1 - 2 * n), addDaysYmd(today, 1 - n), label);
  /** Period-to-date against the same number of days of the previous period (never past its end). */
  const toDate = (start: string, prevStart: string) => {
    const len = daysBetween(start, tomorrow);
    const prevEnd = addDaysYmd(prevStart, len);
    return shift(start, tomorrow, prevStart, prevEnd < start ? prevEnd : start, label);
  };
  switch (key) {
    case 'today':
      return shift(today, tomorrow, addDaysYmd(today, -1), today, label);
    case 'yesterday':
      return shift(addDaysYmd(today, -1), today, addDaysYmd(today, -2), addDaysYmd(today, -1), label);
    case 'last_7_days':
      return lastN(7);
    case 'last_30_days':
      return lastN(30);
    case 'last_90_days':
      return lastN(90);
    case 'last_365_days':
      return lastN(365);
    case 'this_week':
      return toDate(weekStart, addDaysYmd(weekStart, -7));
    case 'last_week':
      return shift(addDaysYmd(weekStart, -7), weekStart, addDaysYmd(weekStart, -14), addDaysYmd(weekStart, -7), label);
    case 'this_month':
      return toDate(monthStart, addMonthsYmd(monthStart, -1));
    case 'last_month':
      return shift(addMonthsYmd(monthStart, -1), monthStart, addMonthsYmd(monthStart, -2), addMonthsYmd(monthStart, -1), label);
    case 'this_quarter':
      return toDate(qStart, addMonthsYmd(qStart, -3));
    case 'last_quarter':
      return shift(addMonthsYmd(qStart, -3), qStart, addMonthsYmd(qStart, -6), addMonthsYmd(qStart, -3), label);
    case 'this_year':
      return toDate(yearStart, addMonthsYmd(yearStart, -12));
    case 'last_year':
      return shift(addMonthsYmd(yearStart, -12), yearStart, addMonthsYmd(yearStart, -24), addMonthsYmd(yearStart, -12), label);
    case 'last_12_months': {
      const start = addMonthsYmd(monthStart, -11);
      return shift(start, tomorrow, addMonthsYmd(start, -12), addMonthsYmd(tomorrow, -12), label);
    }
    default:
      return { current: info(null, null, tz, label), previous: null };
  }
}

// --- buckets ------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Bucket key of a local wall-clock moment. Keys sort chronologically. */
export function bucketKey(y: number, m: number, d: number, h: number, unit: Bucket): string {
  const ymd = fmtYmd(y, m, d);
  switch (unit) {
    case 'day':
      return ymd;
    case 'week':
      return addDaysYmd(ymd, 1 - isoDow(ymd));
    case 'month':
      return ymd.slice(0, 7);
    case 'quarter':
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'year':
      return String(y);
    case 'weekday':
      return String(isoDow(ymd));
    case 'hour':
      return String(h).padStart(2, '0');
  }
}

/** ISO week number of a Monday (or any day). */
export function isoWeek(ymd: string): { week: number; year: number } {
  const [y, m, d] = ymdParts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return { week: Math.ceil(((t.getTime() - yearStart) / 864e5 + 1) / 7), year: t.getUTCFullYear() };
}

export function bucketLabel(key: string, unit: Bucket): string {
  switch (unit) {
    case 'day':
      return deDate(key);
    case 'week': {
      const w = isoWeek(key);
      return `KW ${w.week}/${w.year}`;
    }
    case 'month':
      return `${MONTHS[Number(key.slice(5, 7)) - 1] ?? key} ${key.slice(0, 4)}`;
    case 'quarter':
      return `${key.slice(5)} ${key.slice(0, 4)}`;
    case 'year':
      return key;
    case 'weekday':
      return WEEKDAYS[Number(key) - 1] ?? key;
    case 'hour':
      return `${Number(key)} Uhr`;
  }
}

/** First local day of a bucket key (for filling gaps between keys). */
function keyStartYmd(key: string, unit: Bucket): string {
  if (unit === 'month') return `${key}-01`;
  if (unit === 'quarter') return fmtYmd(Number(key.slice(0, 4)), (Number(key.slice(6)) - 1) * 3 + 1, 1);
  if (unit === 'year') return `${key}-01-01`;
  return key;
}

/** Every bucket key from fromYmd (incl.) to toYmd (excl.), at most `max`. */
export function bucketsBetween(fromYmd: string, toYmd: string, unit: Bucket, max = 1000): string[] {
  if (unit === 'weekday') return ['1', '2', '3', '4', '5', '6', '7'];
  if (unit === 'hour') return Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const out: string[] = [];
  let day = fromYmd;
  for (let i = 0; day < toYmd && i < 366 * 30; i++) {
    const [y, m, d] = ymdParts(day);
    const k = bucketKey(y, m, d, 0, unit);
    if (out[out.length - 1] !== k) {
      out.push(k);
      if (out.length >= max) break;
    }
    // Jump to the next bucket instead of walking every day of a month/quarter/year.
    day = unit === 'day' || unit === 'week' ? addDaysYmd(day, unit === 'week' ? 8 - isoDow(day) : 1) : addMonthsYmd(keyStartYmd(k, unit), unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12);
  }
  return out;
}

// --- SQL functions ------------------------------------------------------------------------------

let deadline = Infinity;
let ticks = 0;
/** Midnight (UTC instant) of today in the zone of the report being run: `rpt_day_start()` in a source's SQL ("overdue" = due before today). */
let dayStart = '';
const offsets = new Map<string, number>();
const prepared = new WeakSet<DatabaseSync>();

/** Local wall clock of an ISO timestamp in `tz` (date-only values are taken as local days). */
export function localParts(ts: string, tz: string): [number, number, number, number] | null {
  if (YMD.test(ts)) {
    const [y, m, d] = ymdParts(ts);
    return [y, m, d, 0];
  }
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return null;
  const k = `${tz}|${Math.floor(t / 900_000)}`;
  let off = offsets.get(k);
  if (off === undefined) {
    if (offsets.size > 100_000) offsets.clear();
    off = tzOffsetMinutes(new Date(t), tz);
    offsets.set(k, off);
  }
  const l = new Date(t + off * 60_000);
  return [l.getUTCFullYear(), l.getUTCMonth() + 1, l.getUTCDate(), l.getUTCHours()];
}

/** Registers rpt_bucket(ts, unit, tz) and rpt_tick() on the connection (once). */
export function prepareDb(db: Db): void {
  if (prepared.has(db.raw)) return;
  prepared.add(db.raw);
  db.raw.function('rpt_bucket', { deterministic: true }, (ts: any, unit: any, tz: any) => {
    if (ts === null || ts === undefined || ts === '') return null;
    const p = localParts(String(ts), String(tz));
    return p ? bucketKey(p[0], p[1], p[2], p[3], unit as Bucket) : null;
  });
  db.raw.function('rpt_day_start', { deterministic: false }, () => dayStart || new Date().toISOString());
  db.raw.function('rpt_tick', { deterministic: false }, () => {
    if (++ticks % 512 === 0 && Date.now() > deadline) throw new Error('RPT_TIMEOUT');
    return 1;
  });
}

function guarded<T>(timeoutMs: number, fn: () => T, today = ''): T {
  deadline = Date.now() + timeoutMs;
  dayStart = today;
  try {
    return fn();
  } catch (e) {
    if (String((e as Error).message).includes('RPT_TIMEOUT')) throw new ReportError('Der Bericht dauert zu lange – bitte Zeitraum oder Filter einschränken.');
    throw e;
  } finally {
    deadline = Infinity;
    dayStart = '';
  }
}

// --- query normalisation ------------------------------------------------------------------------

/** Tables present in the database (sources/joins that need missing modules are hidden). */
const tableCache = new WeakMap<DatabaseSync, Set<string>>();
export function hasTables(db: Db, names: string[] | undefined): boolean {
  if (!names?.length) return true;
  let set = tableCache.get(db.raw);
  if (!set) {
    set = new Set(db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name));
    tableCache.set(db.raw, set);
  }
  return names.every((n) => set!.has(n));
}

/** The fields of a source that can be used right now (joins with missing tables dropped). */
export function usableFields(db: Db, src: ReportSource): ReportField[] {
  return src.fields.filter((f) => !f.join || (src.joins?.[f.join] && hasTables(db, src.joins[f.join].requires)));
}

export function findSource(sources: ReportSource[], key: string): ReportSource {
  const s = sources.find((x) => x.key === key);
  if (!s) throw new ReportError(`Unbekannte Datenquelle: ${key}`);
  return s;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

/** Validates and completes a query from the API/MCP (strings like "sum:value" or "created_at:month" accepted). */
export function normalizeQuery(input: any, sources: ReportSource[], db: Db): ReportQuery {
  if (!input || typeof input !== 'object') throw new ReportError('Bericht fehlt');
  const src = findSource(sources, String(input.source ?? ''));
  const fields = new Map(usableFields(db, src).map((f) => [f.key, f]));
  const measures = asList(input.measures).map(String).filter(Boolean);
  if (!measures.length) measures.push('count');
  if (measures.length > MAX_MEASURES) throw new ReportError(`Höchstens ${MAX_MEASURES} Kennzahlen`);
  for (const m of measures) measureOf(src, fields, m);
  const groupBy = asList(input.group_by ?? input.groupBy).map((g: any): GroupBy => {
    if (typeof g === 'string') {
      const [field, bucket] = g.split(':');
      return { field, bucket: bucket as Bucket | undefined };
    }
    return { field: String(g?.field ?? ''), bucket: g?.bucket };
  });
  if (groupBy.length > MAX_GROUPS) throw new ReportError(`Höchstens ${MAX_GROUPS} Gruppierungen`);
  for (const g of groupBy) {
    const f = fields.get(g.field);
    if (!f || f.noGroup || f.type === 'tags' || f.type === 'number') throw new ReportError(`Nach „${f?.label ?? g.field}“ kann nicht gruppiert werden`);
    if (f.type === 'date') {
      g.bucket = g.bucket || 'month';
      if (!BUCKETS.includes(g.bucket)) throw new ReportError(`Unbekannte Zeiteinheit: ${g.bucket}`);
    } else delete g.bucket;
  }
  const filters = asList(input.filters).map((f: any): ReportFilter => ({ field: String(f?.field ?? ''), op: String(f?.op ?? ''), value: f?.value }));
  if (filters.length > MAX_FILTERS) throw new ReportError(`Höchstens ${MAX_FILTERS} Filter`);
  for (const f of filters) {
    const def = fields.get(f.field);
    if (!def) throw new ReportError(`Unbekanntes Feld: ${f.field}`);
    if (!OPS[def.type].includes(f.op)) throw new ReportError(`Operator „${f.op}“ passt nicht zu „${def.label}“`);
  }
  const dateField = String(input.date_field ?? input.dateField ?? src.dateField);
  if (fields.get(dateField)?.type !== 'date') throw new ReportError(`„${dateField}“ ist kein Datumsfeld`);
  const range: RangeSpec = input.range && typeof input.range === 'object' ? { from: String(input.range.from ?? ''), to: String(input.range.to ?? '') } : String(input.range || 'last_30_days');
  let sort: ReportQuery['sort'];
  if (input.sort && typeof input.sort === 'object' && /^(d[01]|m[0-5])$/.test(String(input.sort.by))) sort = { by: String(input.sort.by), dir: input.sort.dir === 'asc' ? 'asc' : 'desc' };
  const limit = input.limit !== undefined && input.limit !== null && input.limit !== '' ? Math.max(1, Math.min(1000, Math.floor(Number(input.limit) || 0))) : undefined;
  return { source: src.key, measures, groupBy, filters, dateField, range, compare: !!input.compare, sort, limit };
}

interface MeasureDef {
  key: string;
  label: string;
  sql: string;
  format: Format;
  join?: string;
}

function measureOf(src: ReportSource, fields: Map<string, ReportField>, key: string): MeasureDef {
  if (key === 'count') return { key, label: src.countLabel ?? 'Anzahl', sql: src.count ?? 'COUNT(*)', format: 'number' };
  const [kind, name] = key.split(':');
  if (kind === 'calc') {
    const c = src.calcs?.find((x) => x.key === name);
    if (!c || (c.join && !src.joins?.[c.join])) throw new ReportError(`Unbekannte Kennzahl: ${key}`);
    return { key, label: c.label, sql: c.sql, format: c.format ?? 'number', join: c.join };
  }
  const f = fields.get(name ?? '');
  if (!f || !AGGS.includes(kind as Agg)) throw new ReportError(`Unbekannte Kennzahl: ${key}`);
  if (kind === 'count_distinct') return { key, label: `${f.label} (eindeutig)`, sql: `COUNT(DISTINCT ${f.sql})`, format: 'number', join: f.join };
  if (f.type !== 'number') throw new ReportError(`„${f.label}“ ist keine Zahl`);
  const fn = { sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[kind as 'sum' | 'avg' | 'min' | 'max'];
  if (!fn) throw new ReportError(`Unbekannte Kennzahl: ${key}`);
  const label = { sum: `${f.label} (Summe)`, avg: `Ø ${f.label}`, min: `${f.label} (Min.)`, max: `${f.label} (Max.)` }[kind as 'sum'];
  return { key, label, sql: kind === 'sum' ? `COALESCE(SUM(${f.sql}), 0)` : `${fn}(${f.sql})`, format: f.format ?? 'number', join: f.join };
}

/** Human-readable label of a measure key (UI/email). */
export function measureLabel(src: ReportSource, key: string, db: Db): string {
  try {
    return measureOf(src, new Map(usableFields(db, src).map((f) => [f.key, f])), key).label;
  } catch {
    return key;
  }
}

// --- SQL building -------------------------------------------------------------------------------

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const NUM = (v: unknown, label: string) => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new ReportError(`Filter „${label}“: Zahl erwartet`);
  return n;
};

function filterSql(f: ReportField, flt: ReportFilter, params: Param[], tz: string, now: Date): string {
  const s = f.sql;
  const v = flt.value;
  const one = () => {
    if (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v))) throw new ReportError(`Filter „${f.label}“: Wert fehlt`);
    return f.type === 'number' ? NUM(v, f.label) : String(Array.isArray(v) ? v[0] ?? '' : v).slice(0, 500);
  };
  const list = () => {
    const xs = asList(v).slice(0, 200).map((x) => (f.type === 'number' ? NUM(x, f.label) : String(x).slice(0, 500)));
    if (!xs.length) throw new ReportError(`Filter „${f.label}“: mindestens ein Wert`);
    params.push(...xs);
    return xs.map(() => '?').join(', ');
  };
  switch (flt.op) {
    case 'eq':
      params.push(one());
      return `${s} = ?`;
    case 'neq':
      params.push(one());
      return `(${s} IS NULL OR ${s} != ?)`;
    case 'in':
      return `${s} IN (${list()})`;
    case 'not_in':
      return `(${s} IS NULL OR ${s} NOT IN (${list()}))`;
    case 'contains':
      params.push(`%${likeEscape(String(one()))}%`);
      return `${s} LIKE ? ESCAPE '\\'`;
    case 'not_contains':
      params.push(`%${likeEscape(String(one()))}%`);
      return `(${s} IS NULL OR ${s} NOT LIKE ? ESCAPE '\\')`;
    case 'starts_with':
      params.push(`${likeEscape(String(one()))}%`);
      return `${s} LIKE ? ESCAPE '\\'`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      params.push(one());
      return `${s} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[flt.op]} ?`;
    case 'between': {
      const [a, b] = asList(v);
      params.push(NUM(a, f.label), NUM(b, f.label));
      return `${s} BETWEEN ? AND ?`;
    }
    case 'empty':
      return f.type === 'tags' ? `(${s} IS NULL OR ${s} = '[]' OR ${s} = '')` : f.type === 'number' || f.type === 'date' ? `${s} IS NULL` : `(${s} IS NULL OR ${s} = '')`;
    case 'not_empty':
      return f.type === 'tags' ? `(${s} IS NOT NULL AND ${s} NOT IN ('[]', ''))` : f.type === 'number' || f.type === 'date' ? `${s} IS NOT NULL` : `(${s} IS NOT NULL AND ${s} != '')`;
    case 'is_true':
      return `COALESCE(${s}, 0) != 0`;
    case 'is_false':
      return `COALESCE(${s}, 0) = 0`;
    case 'has':
      params.push(one());
      return `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${s}) THEN ${s} ELSE '[]' END) WHERE value = ?)`;
    case 'not_has':
      params.push(one());
      return `NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${s}) THEN ${s} ELSE '[]' END) WHERE value = ?)`;
    case 'in_range': {
      const r = resolveRange(v && typeof v === 'object' && !Array.isArray(v) ? (v as { from: string; to: string }) : String(v ?? ''), tz, now).current;
      const parts: string[] = [];
      if (r.from) {
        params.push(r.from);
        parts.push(`${s} >= ?`);
      }
      if (r.to) {
        params.push(r.to);
        parts.push(`${s} < ?`);
      }
      return parts.length ? parts.join(' AND ') : `${s} IS NOT NULL`;
    }
    case 'before':
    case 'after': {
      const day = String(one());
      if (!YMD.test(day)) throw new ReportError(`Filter „${f.label}“: Datum als JJJJ-MM-TT`);
      params.push(zonedToUtc(flt.op === 'before' ? day : addDaysYmd(day, 1), '00:00', tz).toISOString());
      return flt.op === 'before' ? `${s} < ?` : `${s} >= ?`;
    }
  }
  throw new ReportError(`Unbekannter Operator: ${flt.op}`);
}

interface Plan {
  src: ReportSource;
  fields: Map<string, ReportField>;
  dims: { f: ReportField; bucket?: Bucket }[];
  measures: MeasureDef[];
}

function plan(rc: RunContext, q: ReportQuery): Plan {
  const src = findSource(rc.sources, q.source);
  const fields = new Map(usableFields(rc.db, src).map((f) => [f.key, f]));
  return {
    src,
    fields,
    dims: q.groupBy.map((g) => ({ f: fields.get(g.field)!, bucket: g.bucket })),
    measures: q.measures.map((m) => measureOf(src, fields, m)),
  };
}

/** Builds the statement for one period. Exported for tests (the SQL text never contains user values). */
export function buildSql(rc: RunContext, q: ReportQuery, range: RangeInfo, opts: { grouped: boolean; limit?: number }): { sql: string; params: Param[] } {
  const p = plan(rc, q);
  const now = rc.now ?? new Date();
  const joins = new Set<string>();
  const need = (j?: string) => j && joins.add(j);
  const selectParams: Param[] = [];
  const whereParams: Param[] = [];
  const dims = opts.grouped ? p.dims : [];
  const select = dims.map((d, i) => {
    need(d.f.join);
    if (d.f.type === 'date') {
      selectParams.push(rc.tz);
      return `rpt_bucket(${d.f.sql}, '${d.bucket}', ?) AS d${i}`;
    }
    return `${d.f.sql} AS d${i}`;
  });
  p.measures.forEach((m, i) => {
    need(m.join);
    select.push(`${m.sql} AS m${i}`);
  });
  const where: string[] = [];
  if (!rc.locations.length) where.push('0');
  else {
    where.push(`${p.src.location} IN (${rc.locations.map(() => '?').join(', ')})`);
    whereParams.push(...rc.locations);
  }
  if (p.src.where) where.push(`(${p.src.where})`);
  const scoped = rc.rowScope?.(p.src);
  if (scoped) {
    where.push(`(${scoped.sql})`);
    whereParams.push(...scoped.params);
  }
  const df = p.fields.get(q.dateField)!;
  need(df.join);
  if (range.from) {
    where.push(`${df.sql} >= ?`);
    whereParams.push(range.from);
  }
  if (range.to) {
    where.push(`${df.sql} < ?`);
    whereParams.push(range.to);
  }
  for (const flt of q.filters) {
    const f = p.fields.get(flt.field)!;
    need(f.join);
    where.push(`(${filterSql(f, flt, whereParams, rc.tz, now)})`);
  }
  where.push('rpt_tick() = 1');
  const joinSql = [...joins].map((j) => p.src.joins?.[j]?.sql ?? '').join(' ');
  let sql = `SELECT ${select.join(', ')} FROM ${p.src.from} ${joinSql} WHERE ${where.join(' AND ')}`;
  const params = [...selectParams, ...whereParams];
  if (dims.length) {
    sql += ` GROUP BY ${dims.map((_, i) => `d${i}`).join(', ')}`;
    const byDate = dims[0].f.type === 'date';
    sql += byDate ? ` ORDER BY d0${dims.length > 1 ? ', m0 DESC' : ''}` : ` ORDER BY m0 DESC`;
    if (opts.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
  }
  return { sql, params };
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function dimLabels(rc: RunContext, d: { f: ReportField; bucket?: Bucket }, keys: (string | null)[]): Map<string, { label: string; order?: number }> {
  const out = new Map<string, { label: string; order?: number }>();
  const present = [...new Set(keys.filter((k): k is string => k !== null && k !== ''))];
  if (d.f.type === 'date') for (const k of present) out.set(k, { label: bucketLabel(k, d.bucket!) });
  else if (d.f.lookup && present.length) for (const [k, v] of d.f.lookup(rc.db, present)) out.set(k, v);
  else if (d.f.options) {
    const opts = Object.keys(d.f.options);
    for (const k of present) out.set(k, { label: d.f.options[k] ?? k, order: opts.includes(k) ? opts.indexOf(k) : opts.length });
  } else if (d.f.type === 'boolean') for (const k of present) out.set(k, { label: Number(k) ? 'Ja' : 'Nein', order: Number(k) ? 0 : 1 });
  return out;
}

const keyOf = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'number' && Number.isInteger(v) ? String(v) : String(v));

/** Runs the query (and its previous period when `compare` is on). */
export function runReport(rc: RunContext, input: any): ReportResult {
  const started = Date.now();
  prepareDb(rc.db);
  const q = normalizeQuery(input, rc.sources, rc.db);
  const p = plan(rc, q);
  const now = rc.now ?? new Date();
  const { current, previous: prevRange } = resolveRange(q.range, rc.tz, now);
  const previous = q.compare ? prevRange : null;
  const maxRows = Math.min(q.limit ?? rc.maxRows ?? 500, rc.maxRows ?? 1000);
  const grouped = p.dims.length > 0;
  const run = (range: RangeInfo, g: boolean, limit?: number) => {
    const { sql, params } = buildSql(rc, q, range, { grouped: g, limit });
    return guarded(rc.timeoutMs ?? 8000, () => rc.db.all(sql, ...params), localDayStart(rc.tz, now));
  };

  const totalsRow = run(current, false)[0] ?? {};
  const totals: ReportResult['totals'] = { v: p.measures.map((_, i) => numOrNull(totalsRow[`m${i}`])) };
  let prevTotals: Record<string, any> | undefined;
  if (previous) {
    prevTotals = run(previous, false)[0] ?? {};
    totals.p = p.measures.map((_, i) => numOrNull(prevTotals![`m${i}`]));
  }

  let rows: ResultRow[] = [];
  let truncated = false;
  let axis: { k: string; l: string }[] | undefined;
  let dimValues: { k: string | null; l: string }[][] = [];
  if (grouped) {
    const raw = run(current, true, maxRows + 1);
    truncated = raw.length > maxRows;
    rows = raw.slice(0, maxRows).map((r) => ({ k: p.dims.map((_, i) => keyOf(r[`d${i}`])), l: [], v: p.measures.map((_, i) => numOrNull(r[`m${i}`])) }));
    const d0 = p.dims[0];
    // Every time bucket of the range, so lines don't skip empty days (single group: as zero rows).
    if (d0.f.type === 'date' && !truncated) {
      let keys: string[] = [];
      if (current.fromYmd && current.toYmd) keys = bucketsBetween(current.fromYmd, current.toYmd, d0.bucket!);
      else {
        const present = rows.map((r) => r.k[0]).filter((k): k is string => !!k).sort();
        if (present.length && d0.bucket !== 'weekday' && d0.bucket !== 'hour') keys = bucketsBetween(keyStartYmd(present[0], d0.bucket!), addDaysYmd(keyStartYmd(present[present.length - 1], d0.bucket!), 1), d0.bucket!);
        else if (present.length) keys = bucketsBetween('2000-01-01', '2000-01-02', d0.bucket!);
      }
      axis = keys.map((k) => ({ k, l: bucketLabel(k, d0.bucket!) }));
      if (p.dims.length === 1 && keys.length) {
        const have = new Set(rows.map((r) => r.k[0]));
        const zero = p.measures.map((m) => (m.key === 'count' || m.sql.startsWith('COALESCE(SUM') ? 0 : null));
        for (const k of keys) if (!have.has(k)) rows.push({ k: [k], l: [], v: [...zero] });
      }
    }
    // Labels and natural order (stages, enum order, time).
    const labelMaps = p.dims.map((d, i) => dimLabels(rc, d, rows.map((r) => r.k[i])));
    for (const r of rows) {
      r.l = p.dims.map((d, i) => {
        const k = r.k[i];
        if (k === null || k === '') return d.f.empty ?? '(leer)';
        return labelMaps[i].get(k)?.label ?? k;
      });
    }
    const orderOf = (i: number, r: ResultRow) => labelMaps[i].get(r.k[i] ?? '')?.order;
    const natural = (i: number) => p.dims[i].f.type === 'date' || rows.some((r) => orderOf(i, r) !== undefined);
    const cmpDim = (i: number) => (a: ResultRow, b: ResultRow) => {
      if (p.dims[i].f.type === 'date') return String(a.k[i] ?? '').localeCompare(String(b.k[i] ?? ''));
      const oa = orderOf(i, a) ?? 1e9;
      const ob = orderOf(i, b) ?? 1e9;
      return oa - ob || a.l[i].localeCompare(b.l[i], 'de');
    };
    if (q.sort) {
      const dir = q.sort.dir === 'asc' ? 1 : -1;
      const idx = Number(q.sort.by.slice(1));
      rows.sort(q.sort.by[0] === 'd' ? (a, b) => dir * cmpDim(Math.min(idx, p.dims.length - 1))(a, b) : (a, b) => dir * ((a.v[idx] ?? -Infinity) - (b.v[idx] ?? -Infinity)));
    } else {
      // Groups stay together: by natural order (time, stages, enums) or by their total, then the second group.
      const totalOf = new Map<string, number>();
      for (const r of rows) totalOf.set(r.k[0] ?? '', (totalOf.get(r.k[0] ?? '') ?? 0) + (r.v[0] ?? 0));
      const first = natural(0) ? cmpDim(0) : (a: ResultRow, b: ResultRow) => totalOf.get(b.k[0] ?? '')! - totalOf.get(a.k[0] ?? '')! || a.l[0].localeCompare(b.l[0], 'de');
      const second = p.dims.length < 2 ? () => 0 : natural(1) ? cmpDim(1) : (a: ResultRow, b: ResultRow) => (b.v[0] ?? 0) - (a.v[0] ?? 0) || a.l[1].localeCompare(b.l[1], 'de');
      rows.sort((a, b) => first(a, b) || second(a, b));
    }

    // Distinct values of each group in display order (series order and colours on the client).
    dimValues = p.dims.map((_, i) => {
      const seen = new Map<string, { k: string | null; l: string; total: number; row: ResultRow }>();
      for (const r of rows) {
        const sig = String(r.k[i]);
        const cur = seen.get(sig);
        if (cur) cur.total += r.v[0] ?? 0;
        else seen.set(sig, { k: r.k[i], l: r.l[i], total: r.v[0] ?? 0, row: r });
      }
      const list = [...seen.values()];
      if (natural(i)) list.sort((a, b) => cmpDim(i)(a.row, b.row));
      else list.sort((a, b) => b.total - a.total || a.l.localeCompare(b.l, 'de'));
      return list.map(({ k, l }) => ({ k, l }));
    });

    if (previous) {
      const prevRaw = run(previous, true, maxRows + 1);
      const pRows = prevRaw.map((r) => ({ k: p.dims.map((_, i) => keyOf(r[`d${i}`])), v: p.measures.map((_, i) => numOrNull(r[`m${i}`])) }));
      if (d0.f.type === 'date' && previous.fromYmd && previous.toYmd && current.fromYmd && current.toYmd && d0.bucket !== 'weekday' && d0.bucket !== 'hour') {
        // Time series: bucket n of this period against bucket n of the previous one.
        const curKeys = bucketsBetween(current.fromYmd, current.toYmd, d0.bucket!);
        const prevKeys = bucketsBetween(previous.fromYmd, previous.toYmd, d0.bucket!);
        const map = new Map(curKeys.map((k, i) => [k, prevKeys[i]]));
        for (const r of rows) {
          const pk = map.get(r.k[0] ?? '');
          const hit = pk ? pRows.find((x) => x.k[0] === pk && (p.dims.length < 2 || x.k[1] === r.k[1])) : undefined;
          r.p = hit ? hit.v : p.measures.map(() => (pk ? 0 : null));
        }
      } else {
        const sig = (k: (string | null)[]) => JSON.stringify(k);
        const idx = new Map(pRows.map((x) => [sig(x.k), x.v]));
        for (const r of rows) r.p = idx.get(sig(r.k)) ?? p.measures.map(() => 0);
      }
    }
  } else {
    rows = [{ k: [], l: [], v: totals.v, ...(totals.p ? { p: totals.p } : {}) }];
  }

  return {
    source: { key: p.src.key, label: p.src.label },
    dims: p.dims.map((d, i) => ({ field: d.f.key, label: d.f.label, type: d.f.type, ...(d.bucket ? { bucket: d.bucket } : {}), values: dimValues[i] ?? [] })),
    measures: p.measures.map((m) => ({ key: m.key, label: m.label, format: m.format })),
    rows,
    totals,
    ...(axis ? { axis } : {}),
    range: current,
    previous,
    truncated,
    ms: Date.now() - started,
  };
}

/** Distinct values of a field for the filter picker (scoped like reports). */
export function fieldValues(rc: RunContext, sourceKey: string, fieldKey: string, limit = 200): { value: string; label: string }[] {
  prepareDb(rc.db);
  const src = findSource(rc.sources, sourceKey);
  const f = usableFields(rc.db, src).find((x) => x.key === fieldKey);
  if (!f) throw new ReportError(`Unbekanntes Feld: ${fieldKey}`);
  if (f.options) return Object.entries(f.options).map(([value, label]) => ({ value, label }));
  if (f.type === 'boolean') return [{ value: '1', label: 'Ja' }, { value: '0', label: 'Nein' }];
  if (f.type !== 'string' && f.type !== 'enum' && f.type !== 'tags') return [];
  if (!rc.locations.length) return [];
  const loc = `${src.location} IN (${rc.locations.map(() => '?').join(', ')})`;
  const join = f.join ? src.joins?.[f.join]?.sql ?? '' : '';
  const base = f.type === 'tags' ? `SELECT DISTINCT tg.value AS v FROM ${src.from} ${join}, json_each(CASE WHEN json_valid(${f.sql}) THEN ${f.sql} ELSE '[]' END) tg` : `SELECT DISTINCT ${f.sql} AS v FROM ${src.from} ${join}`;
  const scoped = rc.rowScope?.(src);
  const sql = `${base} WHERE ${loc}${src.where ? ` AND (${src.where})` : ''}${scoped ? ` AND (${scoped.sql})` : ''} AND rpt_tick() = 1 AND v IS NOT NULL AND v != '' LIMIT ?`;
  const keys = guarded(rc.timeoutMs ?? 8000, () => rc.db.all(sql, ...rc.locations, ...(scoped?.params ?? []), limit), localDayStart(rc.tz, rc.now ?? new Date())).map((r) => String(r.v));
  const labels = f.lookup ? f.lookup(rc.db, keys) : new Map();
  return keys.map((value) => ({ value, label: labels.get(value)?.label ?? value })).sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

// --- output -------------------------------------------------------------------------------------

const nf = (digits: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** de-DE display of a measure value. */
export function formatValue(v: number | null | undefined, format: Format): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  switch (format) {
    case 'money':
      return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
    case 'percent':
      return `${nf(1).format(v)} %`;
    case 'days':
      return `${nf(1).format(v)} Tage`;
    case 'minutes':
      return `${nf(1).format(v)} Min.`;
    default:
      return nf(Number.isInteger(v) ? 0 : 2).format(v);
  }
}

/** Change against the previous period in percent (null when there is nothing to compare). */
export function deltaPercent(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** Measures where a rise is bad news (shown red with ▲); the client has the same list. */
export const lowerIsBetter = (key: string) => /no_show|cancel|overdue|missed|lost|velocity|days_|open_amount|unread/.test(key);

const csvCell = (raw: string) => {
  const v = csvSafe(raw);
  return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};
const csvNum = (v: number | null) => (v === null || v === undefined ? '' : String(Math.round(v * 100) / 100).replace('.', ','));

/** CSV for Excel (semicolon, decimal comma, BOM). */
export function toCsv(r: ReportResult): string {
  const head = [...r.dims.map((d) => d.label), ...r.measures.map((m) => m.label), ...(r.previous ? r.measures.map((m) => `${m.label} (Vorperiode)`) : [])];
  const lines = [head.map(csvCell).join(';')];
  const rows = r.dims.length ? r.rows : [{ k: [], l: [], v: r.totals.v, p: r.totals.p }];
  for (const row of rows) lines.push([...row.l.map(csvCell), ...row.v.map(csvNum), ...(r.previous ? (row.p ?? []).map(csvNum) : [])].join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}
