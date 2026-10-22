import { useState } from 'react';
import { tr } from '../i18n';
import { Legend, NoData, Tooltip, axisLabel, fmt, fmtAxis, textW, ticks, useWidth, type Shaped, type Tip } from './core';

/** Texts of the core catalog (always loaded). */
const tc = tr('core');

/** Line or area chart over a category/time axis, with crosshair tooltip and optional previous period. */
export function LineChart({ data, height, area }: { data: Shaped; height: number; area?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const { categories: cats, series, compare, format } = data;
  const all = [...series.flatMap((s) => s.values), ...(compare ?? [])].filter((v): v is number => v !== null);
  const legendH = series.length > 1 || compare ? 26 : 0;
  const h = Math.max(120, height - legendH);
  if (!cats.length || !all.length) return <NoData />;
  const yt = ticks(Math.min(...all), Math.max(...all), 4, data.integer);
  const lo = yt[0];
  const hi = yt[yt.length - 1];
  const left = Math.max(...yt.map((t) => textW(fmtAxis(t, format)))) + 10;
  const right = series.length === 1 ? 14 + textW(fmt(series[0].values[series[0].values.length - 1], format)) / 2 : 14;
  const top = 10;
  const bottom = 24;
  const pw = Math.max(10, width - left - right);
  const ph = h - top - bottom;
  const x = (i: number) => left + (cats.length === 1 ? pw / 2 : (i / (cats.length - 1)) * pw);
  const y = (v: number) => top + ph - ((v - lo) / (hi - lo || 1)) * ph;
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) return void (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaPath = (vals: (number | null)[]) => {
    const pts = vals.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
    if (pts.length < 2) return '';
    return `M${x(pts[0][0])},${y(Math.max(lo, 0))}${pts.map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}L${x(pts[pts.length - 1][0])},${y(Math.max(lo, 0))}Z`;
  };
  const every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / (Math.max(...cats.map((c) => textW(axisLabel(c.l)))) + 18)))));
  const onMove = (e: React.PointerEvent) => {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = cats.length === 1 ? 0 : Math.round(((px - left) / pw) * (cats.length - 1));
    setHover(Math.max(0, Math.min(cats.length - 1, i)));
  };
  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: x(hover),
          y: top,
          title: cats[hover].l,
          rows: [
            ...series.map((s) => ({ label: s.label, value: fmt(s.values[hover], format), color: s.color, line: true })),
            ...(compare ? [{ label: tc('Vorperiode'), value: fmt(compare[hover], format), color: 'var(--viz-muted)', line: true }] : []),
          ],
        };
  const last = series.length === 1 ? series[0].values.map((v, i) => [i, v] as const).filter((p) => p[1] !== null).pop() : undefined;
  return (
    <div ref={ref} className="viz" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label={series.map((s) => s.label).join(', ')} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {yt.map((t) => (
            <g key={t}>
              <line x1={left} x2={left + pw} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} />
              <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                {fmtAxis(t, format)}
              </text>
            </g>
          ))}
          {cats.map((c, i) => {
            if (i % every !== 0) return null;
            const half = textW(axisLabel(c.l)) / 2;
            return (
              <text key={c.k} x={Math.max(half + 2, Math.min(width - half - 2, x(i)))} y={h - 6} textAnchor="middle" className="viz-tick">
                {axisLabel(c.l)}
              </text>
            );
          })}
          {compare && <path d={path(compare)} className="viz-line viz-compare" />}
          {area && series.map((s) => <path key={`a${s.key}`} d={areaPath(s.values)} fill={s.color} opacity={0.1} />)}
          {series.map((s) => (
            <path key={s.key} d={path(s.values)} className="viz-line" stroke={s.color} />
          ))}
          {/* Lone points (a gap on both sides) stay visible as dots. */}
          {series.map((s) =>
            s.values.map((v, i) => (v !== null && (s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null ? <circle key={`${s.key}${i}`} cx={x(i)} cy={y(v)} r={3} fill={s.color} /> : null)),
          )}
          {last && hover === null && (
            <g>
              <circle cx={x(last[0])} cy={y(last[1]!)} r={4} fill={series[0].color} className="viz-dot" />
              <text x={x(last[0])} y={y(last[1]!) - 10} textAnchor="middle" className="viz-label">
                {fmt(last[1], format)}
              </text>
            </g>
          )}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + ph} className="viz-cross" />
              {series.map((s) => (s.values[hover] !== null ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} className="viz-dot" /> : null))}
            </g>
          )}
          <rect x={left} y={top} width={pw} height={ph} fill="transparent" />
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
      <Legend kind="line" items={[...series.map((s) => ({ label: s.label, color: s.color })), ...(compare ? [{ label: tc('Vorperiode'), color: 'var(--viz-muted)' }] : [])]} />
    </div>
  );
}
