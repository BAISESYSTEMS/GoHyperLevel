import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { getLocale, intlLocale, tr } from '../i18n';
import { SOURCE_LOCALE } from '../i18n/registry';

/** Texts of the core catalog (always loaded). */
const tc = tr('core');

/** Shapes of the report API (server/services/report-engine.ts). */
export type Format = 'number' | 'money' | 'percent' | 'days' | 'minutes';
export interface Dim {
  field: string;
  label: string;
  type: string;
  bucket?: string;
  values: { k: string | null; l: string }[];
}
export interface Row {
  k: (string | null)[];
  l: string[];
  v: (number | null)[];
  p?: (number | null)[];
}
export interface ReportResult {
  source: { key: string; label: string };
  dims: Dim[];
  measures: { key: string; label: string; format: Format }[];
  rows: Row[];
  totals: { v: (number | null)[]; p?: (number | null)[] };
  axis?: { k: string; l: string }[];
  range: { label: string; dates: string };
  previous: { label: string; dates: string } | null;
  truncated: boolean;
  ms: number;
}
export type Viz = 'kpi' | 'line' | 'area' | 'bar' | 'hbar' | 'stacked' | 'pie' | 'donut' | 'table' | 'funnel' | 'heatmap';

// --- numbers (in the UI language; units are message ids of the core catalog) -------------------------

const nf = (max: number) => new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: max });
/** "12,5 %" in German (as before), "12.5%" in English. */
export const percentText = (n: string) => (getLocale() === SOURCE_LOCALE ? `${n} %` : `${n}%`);

export function fmt(v: number | null | undefined, format: Format): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  switch (format) {
    case 'money':
      return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
    case 'percent':
      return percentText(nf(1).format(v));
    case 'days':
      return tr('core').plural(v, { other: '{n} Tage' }, { n: nf(1).format(v) });
    case 'minutes':
      return tc('{n} Min.', { n: nf(1).format(v) });
    default:
      return nf(Number.isInteger(v) ? 0 : 2).format(v);
  }
}

/** Short axis label: 1.200 · 12 Tsd. · 1,2 Mio. (+ € / %). */
export function fmtAxis(v: number, format: Format): string {
  const a = Math.abs(v);
  const t = tr('core');
  const n = a >= 1e6 ? t('{n} Mio.', { n: nf(1).format(v / 1e6) }) : a >= 1e4 ? t('{n} Tsd.', { n: nf(0).format(v / 1e3) }) : nf(a < 10 && !Number.isInteger(v) ? 1 : 0).format(v);
  return format === 'money' ? t('{n} €', { n }) : format === 'percent' ? percentText(n) : n;
}

export function delta(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** Measures where a rise is bad news (red ▲). */
export const lowerIsBetter = (key: string) => /no_show|cancel|overdue|missed|lost|velocity|days_|open_amount|unread/.test(key);

/** Nice round ticks from 0 (or a negative minimum) to max. */
export function ticks(min: number, max: number, count = 4, integer = false): number[] {
  const lo = Math.min(0, min);
  // `integer`: counts of things – whole-number ticks, and an axis of at least `count` so a single 1 does not fill the chart.
  const hi = integer ? Math.max(Math.ceil(max), lo + count) : max <= lo ? lo + 1 : max;
  const raw = (hi - lo) / count;
  const mag = integer ? Math.max(1, 10 ** Math.floor(Math.log10(raw))) : 10 ** Math.floor(Math.log10(raw));
  const step = (integer ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.999; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out.length > 1 ? out : [lo, hi];
}

// --- colour ---------------------------------------------------------------------------------------

/** Categorical slots in fixed order (validated light/dark palette, see styles.css --viz-*). */
export const SLOTS = 8;
export const color = (i: number) => (i < 0 ? 'var(--viz-other)' : `var(--viz-${(i % SLOTS) + 1})`);
/** The label of the rest of the series/slices (a message id of the core catalog). */
export const OTHER = 'Andere';

// --- series ---------------------------------------------------------------------------------------

export interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}
export interface Shaped {
  categories: { k: string; l: string }[];
  series: Series[];
  compare?: (number | null)[];
  format: Format;
  /** Measure keys shown (one axis = one format). */
  measures: number[];
  /** Counts of things: the axis uses whole numbers only. */
  integer?: boolean;
}

/**
 * Turns a result into categories × series: two groups → the second group becomes the series (top 7 +
 * "Andere"), one group → each measure with the first measure's format is a series.
 */
export function shape(r: ReportResult, maxSeries = 7): Shaped {
  const format = r.measures[0]?.format ?? 'number';
  const d0 = r.dims[0];
  const cats = r.axis && d0?.type === 'date' ? r.axis : (d0?.values ?? []).map((v) => ({ k: String(v.k), l: v.l }));
  const idx = new Map(cats.map((c, i) => [c.k, i]));
  if (r.dims.length >= 2) {
    const all = r.dims[1].values;
    const keep = all.length > maxSeries + 1 ? all.slice(0, maxSeries) : all;
    const kept = new Set(keep.map((v) => String(v.k)));
    const series: Series[] = keep.map((v, i) => ({ key: String(v.k), label: v.l, color: color(i), values: cats.map(() => 0) }));
    const other: Series = { key: '__other', label: tc(OTHER), color: color(-1), values: cats.map(() => 0) };
    for (const row of r.rows) {
      const ci = idx.get(String(row.k[0]));
      if (ci === undefined) continue;
      const s = kept.has(String(row.k[1])) ? series.find((x) => x.key === String(row.k[1]))! : other;
      s.values[ci] = (s.values[ci] ?? 0) + (row.v[0] ?? 0);
    }
    if (all.length > keep.length) series.push(other);
    return { categories: cats, series, format, measures: [0] };
  }
  const ms = r.measures.map((m, i) => ({ m, i })).filter((x) => x.m.format === format).slice(0, maxSeries);
  const byKey = new Map(r.rows.map((row) => [String(row.k[0]), row]));
  const series = ms.map(({ m, i }, n) => ({ key: m.key, label: m.label, color: color(n), values: cats.map((c) => byKey.get(c.k)?.v[i] ?? null) }));
  const compare = r.previous ? cats.map((c) => byKey.get(c.k)?.p?.[0] ?? null) : undefined;
  return { categories: cats, series, compare, format, measures: ms.map((x) => x.i) };
}

// --- hooks & pieces -------------------------------------------------------------------------------

/** Width of an element (charts draw in real pixels so text stays crisp). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Height of an element (dashboard widgets give their charts exactly the space that is left). */
export function useHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setH(el.clientHeight);
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h];
}

/** Axis text for a category: days without the year (the tooltip keeps the full date). */
export const axisLabel = (l: string) => (/^\d{2}\.\d{2}\.\d{4}$/.test(l) ? l.slice(0, 6) : /^\d{2}\/\d{2}\/\d{4}$/.test(l) ? l.slice(0, 5) : l);

export interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string; color?: string; line?: boolean }[];
}

/** Hover card: value first (strong), label second, a short line key in the series colour. */
export function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(160);
  useEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  }, [tip]);
  if (!tip) return null;
  const left = Math.max(0, Math.min(tip.x + 12, width - w - 4));
  return (
    <div ref={ref} className="viz-tip" style={{ left, top: Math.max(0, tip.y - 10) }} role="status">
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="viz-tip-row">
          {r.color && <span className={r.line ? 'key-line' : 'key-box'} style={{ background: r.color }} />}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items, kind = 'box' }: { items: { label: string; color: string; value?: string }[]; kind?: 'box' | 'line' }) {
  if (items.length < 2) return null;
  return (
    <div className="viz-legend">
      {items.map((it, i) => (
        <span key={i}>
          <span className={kind === 'line' ? 'key-line' : 'key-box'} style={{ background: it.color }} />
          {it.label}
          {it.value && <b>{it.value}</b>}
        </span>
      ))}
    </div>
  );
}

export function NoData({ children }: { children?: ReactNode }) {
  return <div className="viz-empty">{children ?? tc('Keine Daten im Zeitraum.')}</div>;
}

/** Shortens a label to about `max` characters. */
export const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);

/** Path of a bar with a 4px rounded data end and a square base. `dir`: up, right. */
export function barPath(x: number, y: number, w: number, h: number, dir: 'up' | 'right' | 'down' | 'left', r = 4): string {
  if (w <= 0 || h <= 0) return '';
  const rr = Math.min(r, dir === 'up' || dir === 'down' ? w / 2 : h / 2, dir === 'up' || dir === 'down' ? h : w);
  switch (dir) {
    case 'up':
      return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
    case 'down':
      return `M${x},${y}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w - rr}Q${x + w},${y + h} ${x + w},${y + h - rr}V${y}Z`;
    case 'right':
      return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
    case 'left':
      return `M${x + w},${y}H${x + rr}Q${x},${y} ${x},${y + rr}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w}Z`;
  }
}

/** Approximate text width in px for 11–12px system UI text. */
export const textW = (s: string, size = 11) => s.length * size * 0.56;
