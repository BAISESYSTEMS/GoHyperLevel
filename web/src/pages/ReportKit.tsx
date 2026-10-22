import { useEffect, useMemo, useState } from 'react';
import { saveBlob } from '../ios/share';
import { api, currentLocation } from '../api';
import { Input, Select } from '../ui';
import type { IconName } from '../icons';
import type { Format, ReportResult, Viz } from '../charts/core';
import { getLocale, intlLocale, tr, useT } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';

/** Shared pieces of the reports area: source metadata, measure/operator labels, defaults. */

export interface FieldMeta {
  key: string;
  label: string;
  type: 'string' | 'enum' | 'number' | 'date' | 'boolean' | 'tags';
  format?: Format;
  group?: string;
  options?: Record<string, string>;
  lookup: boolean;
  groupable: boolean;
  ops: string[];
}
export interface SourceMeta {
  key: string;
  label: string;
  description: string;
  dateField: string;
  countLabel: string;
  fields: FieldMeta[];
  calcs: { key: string; label: string; format: Format; description: string }[];
}
export interface Meta {
  sources: SourceMeta[];
  ranges: Record<string, string>;
  canAgency: boolean;
  locations: { id: string; name: string }[];
}
export interface Filter {
  field: string;
  op: string;
  value?: unknown;
}
export interface Query {
  source: string;
  measures: string[];
  group_by: string[];
  filters: Filter[];
  date_field?: string;
  range: string | { from: string; to: string };
  compare?: boolean;
  limit?: number;
}
export interface Config {
  title?: string;
  viz: Viz;
  query: Query;
  fixed_range?: boolean;
}

let metaCache: { loc: string; p: Promise<Meta> } | null = null;
/** Report sources of the current sub-account (cached per sub-account), with their labels in the UI language. */
export function useReportMeta() {
  const t = useT('reports');
  const [meta, setMeta] = useState<Meta>();
  const [error, setError] = useState('');
  useEffect(() => {
    const loc = currentLocation();
    if (!metaCache || metaCache.loc !== loc) metaCache = { loc, p: api.get<Meta>('/api/reports/sources') };
    metaCache.p.then(setMeta).catch((e) => {
      metaCache = null;
      setError((e as Error).message);
    });
  }, []);
  const local = useMemo(() => (meta ? localMeta(meta) : undefined), [meta, t]);
  return { meta: local, error };
}

// --- the server's labels in the UI language -------------------------------------------------------
// Sources, fields, options and measures come from the server in German (server/services/report-sources.ts and the modules that
// add sources); their German labels are message ids of the reports catalog. Unknown labels (custom fields, names) stay as they are.

const translated = (o: Record<string, string>) => {
  const t = tr('reports');
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, t(v)]));
};

/** The metadata with every label in the UI language. */
export function localMeta(m: Meta): Meta {
  if (getLocale() === SOURCE_LOCALE) return m;
  const t = tr('reports');
  return {
    ...m,
    ranges: translated(m.ranges),
    sources: m.sources.map((s) => ({
      ...s,
      label: t(s.label),
      description: s.description && t(s.description),
      countLabel: s.countLabel && t(s.countLabel),
      fields: s.fields.map((f) => ({ ...f, label: t(f.label), group: f.group && t(f.group), options: f.options && translated(f.options) })),
      calcs: s.calcs.map((c) => ({ ...c, label: t(c.label), description: c.description && t(c.description) })),
    })),
  };
}

/** A measure label as the server builds it (report-engine measureOf): a plain label or a field label with its aggregation. */
const AGG_PATTERNS: [RegExp, string][] = [
  [/^(.*) \(Summe\)$/, '{label} (Summe)'],
  [/^Ø (.*)$/, 'Ø {label}'],
  [/^(.*) \(Min\.\)$/, '{label} (Min.)'],
  [/^(.*) \(Max\.\)$/, '{label} (Max.)'],
  [/^(.*) \(eindeutig\)$/, '{label} (eindeutig)'],
];
function labelText(l: string): string {
  const t = tr('reports');
  const own = t(l);
  if (own !== l) return own;
  for (const [re, id] of AGG_PATTERNS) {
    const m = re.exec(l);
    if (m) return t(id, { label: t(m[1]) });
  }
  return l;
}

const dayText = (d: string, m: string, y: string) => new Intl.DateTimeFormat(intlLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(+y, +m - 1, +d));
/** "07.09.2026 – 06.10.2026" (the server's range) in the UI language's date format. */
const datesText = (s: string) => s.replace(/\b(\d{2})\.(\d{2})\.(\d{4})\b/g, (_, d, m, y) => dayText(d, m, y));
// i18n-ignore – the German month abbreviations of the server's bucket labels (a pattern, not a text)
const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
/** A value of a group: time buckets (report-engine bucketLabel) in the UI language's format, other German labels translated. */
function valueText(l: string): string {
  const t = tr('reports');
  let m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(l);
  if (m) return dayText(m[1], m[2], m[3]);
  m = /^KW (\d+)\/(\d{4})$/.exec(l);
  if (m) return t('KW {week}/{year}', { week: m[1], year: m[2] });
  m = /^(\S+) (\d{4})$/.exec(l);
  if (m && MONTHS_DE.includes(m[1])) return new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(+m[2], MONTHS_DE.indexOf(m[1]), 1));
  m = /^(\d+) Uhr$/.exec(l);
  if (m) return t('{hour} Uhr', { hour: m[1] });
  return t(l);
}

/** A report result with its labels in the UI language (German stays as the server sent it). */
export function localResult(r: ReportResult): ReportResult {
  if (getLocale() === SOURCE_LOCALE) return r;
  const t = tr('reports');
  return {
    ...r,
    source: { ...r.source, label: t(r.source.label) },
    dims: r.dims.map((d) => ({ ...d, label: labelText(d.label), values: d.values.map((v) => ({ ...v, l: valueText(v.l) })) })),
    measures: r.measures.map((m) => ({ ...m, label: labelText(m.label) })),
    rows: r.rows.map((row) => ({ ...row, l: row.l.map(valueText) })),
    axis: r.axis?.map((a) => ({ ...a, l: valueText(a.l) })),
    range: { label: t(r.range.label), dates: datesText(r.range.dates) },
    previous: r.previous && { label: t(r.previous.label), dates: datesText(r.previous.dates) },
  };
}

// German labels (message ids of the reports catalog), shown through t()
export const VIZ_LIST: [Viz, string, IconName][] = [
  ['kpi', 'Kennzahl', 'vizKpi'],
  ['line', 'Linie', 'vizLine'],
  ['area', 'Fläche', 'vizArea'],
  ['bar', 'Säulen', 'vizBar'],
  ['stacked', 'Gestapelt', 'vizStacked'],
  ['hbar', 'Balken', 'vizHbar'],
  ['pie', 'Kreis', 'vizPie'],
  ['donut', 'Ring', 'vizDonut'],
  ['funnel', 'Trichter', 'vizFunnel'],
  ['heatmap', 'Heatmap', 'vizHeatmap'],
  ['table', 'Tabelle', 'vizTable'],
];

// German labels (message ids of the reports catalog), shown through t()
export const OP_LABELS: Record<string, string> = {
  eq: 'ist',
  neq: 'ist nicht',
  in: 'ist eines von',
  not_in: 'ist keines von',
  contains: 'enthält',
  not_contains: 'enthält nicht',
  starts_with: 'beginnt mit',
  empty: 'ist leer',
  not_empty: 'ist nicht leer',
  gt: 'größer als',
  gte: 'mindestens',
  lt: 'kleiner als',
  lte: 'höchstens',
  between: 'zwischen',
  in_range: 'im Zeitraum',
  before: 'vor dem',
  after: 'nach dem',
  is_true: 'ja',
  is_false: 'nein',
  has: 'hat Tag',
  not_has: 'hat Tag nicht',
};

// German labels (message ids of the reports catalog), shown through t()
export const BUCKETS: [string, string][] = [
  ['day', 'Tag'],
  ['week', 'Woche'],
  ['month', 'Monat'],
  ['quarter', 'Quartal'],
  ['year', 'Jahr'],
  ['weekday', 'Wochentag'],
  ['hour', 'Uhrzeit'],
];

// German labels (message ids of the reports catalog), shown through t()
export const VISIBILITY: [string, string][] = [
  ['private', 'Nur ich'],
  ['team', 'Team dieses Sub-Accounts'],
  ['admins', 'Alle Admins (Agentur)'],
];

/** A measure from a field, labelled like the server does it (German ids of the reports catalog). */
const AGG_LABEL: Record<string, string> = { sum: '{label} (Summe)', avg: 'Ø {label}', min: '{label} (Min.)', max: '{label} (Max.)', count_distinct: '{label} (eindeutig)' };
const aggLabel = (agg: string, label: string) => {
  const t = tr('reports');
  return t(AGG_LABEL[agg], { label });
};

/** Every measure a source offers, grouped for a select. */
export function measureOptions(src: SourceMeta): { group: string; items: [string, string][] }[] {
  const t = tr('reports');
  const nums = src.fields.filter((f) => f.type === 'number');
  return [
    { group: t('Kennzahlen'), items: [['count', src.countLabel] as [string, string], ...src.calcs.map((c) => [`calc:${c.key}`, c.label] as [string, string])] },
    ...(nums.length ? [{ group: t('Zahlenfelder'), items: nums.flatMap((f) => (['sum', 'avg', 'min', 'max'] as const).map((a) => [`${a}:${f.key}`, aggLabel(a, f.label)] as [string, string])) }] : []),
    { group: t('Eindeutig zählen'), items: src.fields.filter((f) => f.lookup).map((f) => [`count_distinct:${f.key}`, aggLabel('count_distinct', f.label)] as [string, string]) },
  ].filter((g) => g.items.length);
}

export function measureLabel(src: SourceMeta | undefined, key: string): string {
  if (!src) return key;
  for (const g of measureOptions(src)) for (const [k, l] of g.items) if (k === key) return l;
  return key;
}

export const fieldOf = (src: SourceMeta | undefined, key: string) => src?.fields.find((f) => f.key === key);

/** A sensible time unit for a range (hours for a day, days for a month …). */
export function autoBucket(range: Query['range']): string {
  if (typeof range === 'object') {
    const days = (new Date(range.to).getTime() - new Date(range.from).getTime()) / 864e5;
    return days <= 1 ? 'hour' : days <= 45 ? 'day' : days <= 120 ? 'week' : 'month';
  }
  if (range === 'today' || range === 'yesterday') return 'hour';
  if (/^(last_7_days|last_30_days|this_week|last_week|this_month|last_month)$/.test(range)) return 'day';
  if (/^(last_90_days|this_quarter|last_quarter)$/.test(range)) return 'week';
  return 'month';
}

/** The most telling non-date group of a source (stage for deals, status/channel/source otherwise). */
function bestDim(src: SourceMeta): string | undefined {
  const pref = ['stage', 'source', 'status', 'channel', 'calendar', 'campaign', 'form', 'product', 'assigned_to', 'user', 'course'];
  const groupable = src.fields.filter((f) => f.groupable && f.type !== 'date' && !f.group);
  return pref.find((p) => groupable.some((f) => f.key === p)) ?? groupable[0]?.key;
}

/** Adjusts the groups when the chart type changes, so the preview shows something useful at once. */
export function applyViz(src: SourceMeta, cfg: Config, viz: Viz): Config {
  const q = { ...cfg.query };
  const date = q.date_field || src.dateField;
  const isDate = (g?: string) => !!g && fieldOf(src, g.split(':')[0])?.type === 'date';
  const dateGroup = `${date}:${autoBucket(q.range)}`;
  switch (viz) {
    case 'kpi':
      q.group_by = [];
      q.compare = true;
      break;
    case 'line':
    case 'area':
      q.group_by = isDate(q.group_by[0]) ? q.group_by : [dateGroup, ...q.group_by.filter((g) => !isDate(g))].slice(0, 2);
      break;
    case 'bar':
      if (!q.group_by.length) q.group_by = [dateGroup];
      break;
    case 'stacked': {
      if (!q.group_by.length) q.group_by = [dateGroup];
      if (q.group_by.length < 2) {
        const second = src.fields.find((f) => f.groupable && f.type !== 'date' && (f.options || f.type === 'boolean') && f.key !== q.group_by[0]) ?? src.fields.find((f) => f.groupable && f.type !== 'date' && f.key !== q.group_by[0] && !f.group);
        if (second) q.group_by = [q.group_by[0], second.key];
      }
      break;
    }
    case 'hbar':
    case 'pie':
    case 'donut':
    case 'funnel': {
      const keep = q.group_by.find((g) => !isDate(g));
      const dim = viz === 'funnel' && fieldOf(src, 'stage') ? 'stage' : keep ?? bestDim(src);
      q.group_by = dim ? [dim] : [dateGroup];
      break;
    }
    case 'heatmap':
      q.group_by = [`${date}:weekday`, `${date}:hour`];
      break;
    default:
      break;
  }
  return { ...cfg, viz, query: q };
}

export function emptyConfig(src: SourceMeta, viz: Viz = 'bar'): Config {
  return applyViz(src, { viz, query: { source: src.key, measures: ['count'], group_by: [], filters: [], date_field: src.dateField, range: 'last_30_days', compare: false } }, viz);
}

/** Range select: presets plus a custom from/to. */
export function RangePicker({ value, onChange, ranges }: { value: Query['range']; onChange: (v: Query['range']) => void; ranges: Record<string, string> }) {
  const t = useT('reports');
  const custom = typeof value === 'object';
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="rpt-range">
      <Select
        aria={t('Zeitraum')}
        value={custom ? 'custom' : value}
        onChange={(v) => onChange(v === 'custom' ? { from: new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10), to: today } : v)}
        options={[...Object.entries(ranges), ['custom', t('Benutzerdefiniert …')]] as [string, string][]}
      />
      {custom && (
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <Input type="date" value={value.from} onChange={(v) => onChange({ ...value, from: v })} aria-label={t('Von')} />
          <Input type="date" value={value.to} onChange={(v) => onChange({ ...value, to: v })} aria-label={t('Bis')} />
        </div>
      )}
    </div>
  );
}

/** Downloads a report as CSV (Excel, semicolon). */
export async function downloadCsv(name: string, query: Query, scope: string) {
  const r = await fetch('/api/reports/export.csv', {
    method: 'POST',
    headers: { 'x-pghl': '1', 'content-type': 'application/json', 'x-location-id': currentLocation() },
    body: JSON.stringify({ name, query, scope }),
  });
  const t = tr('reports');
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? t('Fehler {status}', { status: r.status }));
  // Share sheet in the installed iPhone/iPad app (nowhere to "download" to there), a normal download elsewhere.
  await saveBlob(await r.blob(), `${name.replace(/[^\wäöüÄÖÜß-]+/g, '-') || 'bericht'}.csv`);
}

/** Where a new widget goes: below everything else. */
export function nextSlot(widgets: { y: number; h: number }[]) {
  return widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
}

export const widgetSize = (viz: Viz) => (viz === 'kpi' ? { w: 3, h: 2 } : viz === 'table' ? { w: 6, h: 5 } : { w: 6, h: 4 });
