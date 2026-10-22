import { useState } from 'react';
import { tr } from '../i18n';
import { Legend, NoData, Tooltip, axisLabel, barPath, clip, fmt, fmtAxis, textW, ticks, useWidth, type Shaped, type Tip } from './core';

/** Texts of the core catalog (always loaded). */
const tc = tr('core');

const GAP = 2;

/** Columns: one series, several measures side by side, or stacked series (2px surface gap between segments). */
export function ColumnChart({ data, height, stacked }: { data: Shaped; height: number; stacked?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { categories: cats, series, compare, format } = data;
  const legendH = series.length > 1 || compare ? 26 : 0;
  const h = Math.max(120, height - legendH);
  const sums = cats.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
  const vals = stacked ? sums : series.flatMap((s) => s.values).concat(compare ?? []).filter((v): v is number => v !== null);
  if (!cats.length || !vals.length) return <NoData />;
  const negatives = stacked ? [] : (vals as number[]).filter((v) => v < 0);
  const yt = ticks(Math.min(0, ...negatives), Math.max(...(vals as number[]), 0), 4, data.integer);
  const lo = yt[0];
  const hi = yt[yt.length - 1];
  const left = Math.max(...yt.map((t) => textW(fmtAxis(t, format)))) + 10;
  const top = 16;
  const bottom = 24;
  const pw = Math.max(10, width - left - 8);
  const ph = h - top - bottom;
  const band = pw / cats.length;
  const groups = stacked ? 1 : series.length + (compare ? 1 : 0);
  const bw = Math.max(2, Math.min(24, (band * 0.7 - GAP * (groups - 1)) / groups));
  const y = (v: number) => top + ph - ((v - lo) / (hi - lo || 1)) * ph;
  const base = y(0);
  const every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / (Math.min(120, Math.max(...cats.map((c) => textW(axisLabel(c.l))))) + 16)))));
  // Value labels only where they fit: every cap for a few columns, otherwise just the highest and the latest.
  const single = !stacked && series.length === 1 && !compare;
  const capW = single ? Math.max(...series[0].values.map((v) => textW(fmtAxis(v ?? 0, format)))) + 8 : 0;
  const labelAll = single && cats.length <= 8 && band >= capW;
  const peak = single ? series[0].values.reduce<number>((best, v, i, a) => ((v ?? -Infinity) > (a[best] ?? -Infinity) ? i : best), 0) : -1;
  const labelAt = (i: number) => single && (labelAll || i === peak || (i === cats.length - 1 && Math.abs(i - peak) * band >= capW));
  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: left + band * hover + band / 2,
          y: top,
          title: cats[hover].l,
          rows: [
            ...series.map((s) => ({ label: s.label, value: fmt(s.values[hover], format), color: s.color })),
            ...(stacked && series.length > 1 ? [{ label: tc('Summe'), value: fmt(sums[hover], format) }] : []),
            ...(compare ? [{ label: tc('Vorperiode'), value: fmt(compare[hover], format), color: 'var(--viz-muted)' }] : []),
          ],
        };
  return (
    <div ref={ref} className="viz" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label={series.map((s) => s.label).join(', ')} onPointerLeave={() => setHover(null)}>
          {yt.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + pw} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
              <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                {fmtAxis(t, format)}
              </text>
            </g>
          ))}
          {cats.map((c, i) => {
            const cx = left + band * i + band / 2;
            const on = hover === i;
            let stackTop = base;
            const segs = stacked ? series.map((s) => ({ s, v: Math.max(0, s.values[i] ?? 0) })).filter((x) => x.v > 0) : [];
            return (
              <g key={c.k} className={on ? 'viz-on' : undefined} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
                <rect x={left + band * i} y={top} width={band} height={ph} fill="transparent" />
                {stacked
                  ? segs.map(({ s, v }, j) => {
                      const hh = base - y(v);
                      const yy = stackTop - hh;
                      stackTop = yy;
                      const isTop = j === segs.length - 1;
                      // The gap between segments is surface, not a stroke.
                      const gh = Math.max(0.5, hh - (j > 0 ? GAP : 0));
                      return <path key={s.key} d={isTop ? barPath(cx - bw / 2, yy, bw, gh, 'up') : `M${cx - bw / 2},${yy}h${bw}v${gh}h${-bw}Z`} fill={s.color} />;
                    })
                  : [...series.map((s) => ({ v: s.values[i], color: s.color, key: s.key })), ...(compare ? [{ v: compare[i], color: 'var(--viz-muted)', key: '__prev' }] : [])].map((b, j) => {
                      if (b.v === null || b.v === undefined || b.v === 0) return null;
                      const x0 = cx - (groups * bw + (groups - 1) * GAP) / 2 + j * (bw + GAP);
                      const up = b.v > 0;
                      return <path key={b.key} d={barPath(x0, up ? y(b.v) : base, bw, Math.abs(base - y(b.v)), up ? 'up' : 'down')} fill={b.color} />;
                    })}
                {labelAt(i) && series[0].values[i] ? (
                  <text x={cx} y={y(Math.max(0, series[0].values[i]!)) - 5} textAnchor="middle" className="viz-label">
                    {fmtAxis(series[0].values[i]!, format)}
                  </text>
                ) : null}
                {i % every === 0 && (
                  <text x={Math.max(left + 4 + textW(axisLabel(c.l)) / 2, Math.min(width - 4 - textW(axisLabel(c.l)) / 2, cx))} y={h - 6} textAnchor="middle" className="viz-tick">
                    {clip(axisLabel(c.l), Math.max(4, Math.floor((band * every) / 6.5)))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
      <Legend items={[...series.map((s) => ({ label: s.label, color: s.color })), ...(compare ? [{ label: tc('Vorperiode'), color: 'var(--viz-muted)' }] : [])]} />
    </div>
  );
}

/** Horizontal bars for categories with long names (value at the bar tip). */
export function BarList({ data, height }: { data: Shaped; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { categories, series, compare, format } = data;
  const s = series[0];
  if (!categories.length || !s) return <NoData />;
  const overflow = categories.length * 22 > height;
  const avail = overflow ? height - 20 : height;
  const rowH = Math.max(22, Math.min(44, avail / Math.max(1, categories.length)));
  const fits = Math.max(1, Math.floor(avail / rowH));
  const shown = categories.slice(0, fits);
  const vals = shown.map((_, i) => s.values[i] ?? 0);
  const max = Math.max(1e-9, ...vals.map(Math.abs), ...(compare ?? []).slice(0, fits).map((v) => Math.abs(v ?? 0)));
  const labelW = Math.min(width * 0.38, Math.max(...shown.map((c) => textW(c.l, 12))) + 8);
  const valueW = Math.max(...vals.map((v) => textW(fmt(v, format), 11))) + 10;
  const pw = Math.max(10, width - labelW - valueW);
  const bh = Math.min(20, rowH - 8);
  const h = shown.length * rowH;
  const tip: Tip | null =
    hover === null
      ? null
      : { x: labelW + (Math.abs(vals[hover]) / max) * pw, y: hover * rowH, title: shown[hover].l, rows: [{ label: s.label, value: fmt(s.values[hover], format), color: s.color }, ...(compare ? [{ label: tc('Vorperiode'), value: fmt(compare[hover], format), color: 'var(--viz-muted)' }] : [])] };
  return (
    <div ref={ref} className="viz" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label={s.label} onPointerLeave={() => setHover(null)}>
          <line x1={labelW} x2={labelW} y1={0} y2={h} className="viz-base" />
          {shown.map((c, i) => {
            const v = vals[i];
            const w = (Math.abs(v) / max) * pw;
            const yy = i * rowH + (rowH - bh) / 2;
            const prev = compare?.[i];
            return (
              <g key={c.k} className={hover === i ? 'viz-on' : undefined} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
                <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" />
                <text x={labelW - 8} y={i * rowH + rowH / 2} dy="0.32em" textAnchor="end" className="viz-cat">
                  {clip(c.l, Math.floor((labelW - 8) / 6.6))}
                </text>
                {w > 0 && <path d={barPath(labelW, yy, w, prev !== undefined ? bh * 0.62 : bh, 'right')} fill={s.color} />}
                {prev !== undefined && prev !== null && prev !== 0 && <path d={barPath(labelW, yy + bh * 0.62 + GAP, (Math.abs(prev) / max) * pw, bh * 0.38 - GAP, 'right', 2)} fill="var(--viz-muted)" />}
                <text x={labelW + w + 6} y={i * rowH + rowH / 2} dy="0.32em" className="viz-label">
                  {fmt(v, format)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {categories.length > shown.length && <div className="viz-more">{tc('+ {n} weitere (Tabelle)', { n: categories.length - shown.length })}</div>}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}
