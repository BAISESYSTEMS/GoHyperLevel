import { useState } from 'react';
import { NoData, OTHER, Tooltip, clip, color, delta, fmt, lowerIsBetter, percentText, textW, useWidth, type Format, type ReportResult, type Tip } from './core';
import { intlLocale, tr } from '../i18n';

/** Texts of the core catalog (always loaded). */
const tc = tr('core');

/** Pie or donut: at most 6 slices + "Andere", 2px surface gap, legend with share. */
export function PieChart({ r, height, donut }: { r: ReportResult; height: number; donut?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const format = r.measures[0].format;
  const rows = (r.dims[0]?.values ?? []).map((v) => ({ label: v.l, v: r.rows.filter((x) => x.k[0] === v.k).reduce((a, x) => a + Math.max(0, x.v[0] ?? 0), 0) })).filter((x) => x.v > 0);
  if (!rows.length) return <NoData />;
  const sorted = [...rows].sort((a, b) => b.v - a.v);
  const slices: { label: string; v: number; other?: boolean }[] = sorted.length > 7 ? [...sorted.slice(0, 6), { label: tc(OTHER), v: sorted.slice(6).reduce((a, x) => a + x.v, 0), other: true }] : sorted;
  const total = slices.reduce((a, x) => a + x.v, 0);
  const side = width >= 380;
  const size = Math.max(80, Math.min(height - 8, side ? width * 0.45 : height - 30 - Math.ceil(slices.length / 2) * 20));
  const R = size / 2;
  const inner = donut ? R * 0.62 : 0;
  let a0 = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const a1 = a0 + (s.v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number, rr: number) => `${R + rr * Math.cos(a)},${R + rr * Math.sin(a)}`;
    // A single slice is a full ring/disc (an arc from a point to itself draws nothing).
    const d =
      slices.length === 1
        ? `M${R},0A${R},${R} 0 1 1 ${R - 0.01},0Z${donut ? `M${R},${R - inner}A${inner},${inner} 0 1 0 ${R + 0.01},${R - inner}Z` : ''}`
        : donut
          ? `M${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`
          : `M${R},${R}L${p(a0, R)}A${R},${R} 0 ${large} 1 ${p(a1, R)}Z`;
    const mid = (a0 + a1) / 2;
    a0 = a1;
    return { d, s, i, mid, fill: s.other ? color(-1) : color(i) };
  });
  const tip: Tip | null = hover === null ? null : { x: R + R * 0.6 * Math.cos(arcs[hover].mid), y: R + R * 0.6 * Math.sin(arcs[hover].mid), title: slices[hover].label, rows: [{ label: r.measures[0].label, value: `${fmt(slices[hover].v, format)} · ${fmt((slices[hover].v / total) * 100, 'percent')}`, color: arcs[hover].fill }] };
  return (
    <div ref={ref} className={`viz viz-pie${side ? ' side' : ''}`} style={{ height }}>
      {width > 0 && (
        <svg width={size} height={size} role="img" aria-label={r.measures[0].label} onPointerLeave={() => setHover(null)} style={{ flex: 'none' }}>
          {arcs.map((a) => (
            <path key={a.i} d={a.d} fill={a.fill} className={`viz-slice${hover === a.i ? ' on' : ''}`} fillRule="evenodd" onPointerEnter={() => setHover(a.i)} onFocus={() => setHover(a.i)} tabIndex={0} />
          ))}
          {donut && (
            <>
              <text x={R} y={R - 6} textAnchor="middle" className="viz-center">
                {fmt(total, format)}
              </text>
              <text x={R} y={R + 12} textAnchor="middle" className="viz-tick">
                {tc('Gesamt')}
              </text>
            </>
          )}
        </svg>
      )}
      <div className="viz-pie-legend">
        {arcs.map((a) => (
          <div key={a.i} className={hover === a.i ? 'on' : undefined} onPointerEnter={() => setHover(a.i)} onPointerLeave={() => setHover(null)}>
            <span className="key-box" style={{ background: a.fill }} />
            <span className="lbl">{a.s.label}</span>
            <b>{fmt(a.s.v, format)}</b>
            <span className="muted">{fmt((a.s.v / total) * 100, 'percent')}</span>
          </div>
        ))}
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/** Funnel: stages in order, bar width ∝ value, conversion from the step before. */
export function Funnel({ r, height }: { r: ReportResult; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const format = r.measures[0].format;
  const steps = (r.dims[0]?.values ?? []).map((v) => ({ label: v.l, v: r.rows.filter((x) => x.k[0] === v.k).reduce((a, x) => a + (x.v[0] ?? 0), 0) }));
  if (!steps.length) return <NoData />;
  const max = Math.max(1e-9, ...steps.map((s) => s.v));
  const rowH = Math.max(28, Math.min(58, height / steps.length));
  const labelW = Math.min(width * 0.3, Math.max(...steps.map((s) => textW(s.label, 12))) + 12);
  const valueW = Math.max(...steps.map((s) => textW(`${fmt(s.v, format)} · 100 %`, 11))) + 12;
  const pw = Math.max(20, width - labelW - valueW);
  return (
    <div ref={ref} className="viz" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={steps.length * rowH} role="img" aria-label={tc('Trichter {label}', { label: r.measures[0].label })}>
          {steps.map((s, i) => {
            const w = Math.max(2, (s.v / max) * pw);
            const conv = i > 0 && steps[i - 1].v ? (s.v / steps[i - 1].v) * 100 : null;
            const y = i * rowH;
            return (
              <g key={i}>
                <title>{`${s.label}: ${fmt(s.v, format)}${conv !== null ? tc(' ({pct} der vorigen Phase)', { pct: fmt(conv, 'percent') }) : ''}`}</title>
                <text x={labelW - 10} y={y + rowH / 2} dy="0.32em" textAnchor="end" className="viz-cat">
                  {clip(s.label, Math.floor((labelW - 10) / 6.6))}
                </text>
                <rect x={labelW + (pw - w) / 2} y={y + (rowH - Math.min(28, rowH - 8)) / 2} width={w} height={Math.min(28, rowH - 8)} rx={4} fill={color(0)} />
                <text x={labelW + pw + 8} y={y + rowH / 2} dy="0.32em" className="viz-label">
                  {fmt(s.v, format)}
                  {conv !== null && <tspan className="viz-tick"> · {fmt(conv, 'percent')}</tspan>}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/** Heatmap (e.g. weekday × hour) with a 7-step blue scale and a legend. */
export function Heatmap({ r, height }: { r: ReportResult; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const format = r.measures[0].format;
  if (r.dims.length < 2) return <NoData>{tc('Für eine Heatmap zwei Gruppierungen wählen (z. B. Wochentag und Stunde).')}</NoData>;
  const rowsK = r.axis && r.dims[0].type === 'date' ? r.axis : r.dims[0].values.map((v) => ({ k: String(v.k), l: v.l }));
  const cols = r.dims[1].bucket === 'hour' ? Array.from({ length: 24 }, (_, i) => ({ k: String(i).padStart(2, '0'), l: String(i) })) : r.dims[1].values.map((v) => ({ k: String(v.k), l: v.l }));
  const val = new Map(r.rows.map((x) => [`${x.k[0]}|${x.k[1]}`, x.v[0] ?? 0]));
  const all = [...val.values()];
  if (!all.length) return <NoData />;
  const max = Math.max(...all, 1e-9);
  const step = (v: number) => (v <= 0 ? 0 : Math.min(6, Math.ceil((v / max) * 6)));
  const left = Math.max(...rowsK.map((x) => textW(x.l, 11))) + 10;
  const legendH = 26;
  const cw = Math.max(6, (width - left) / Math.max(1, cols.length));
  const ch = Math.max(10, Math.min(30, (height - 20 - legendH) / Math.max(1, rowsK.length)));
  const labelEvery = Math.max(1, Math.ceil(28 / cw));
  const tip: Tip | null = hover === null ? null : { x: left + hover.j * cw, y: hover.i * ch, title: `${rowsK[hover.i].l} · ${r.dims[1].bucket === 'hour' ? `${cols[hover.j].l} Uhr` : cols[hover.j].l}`, rows: [{ label: r.measures[0].label, value: fmt(val.get(`${rowsK[hover.i].k}|${cols[hover.j].k}`) ?? 0, format) }] };
  return (
    <div ref={ref} className="viz" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={rowsK.length * ch + 20} role="img" aria-label={tc('Heatmap {label}', { label: r.measures[0].label })} onPointerLeave={() => setHover(null)}>
          {rowsK.map((row, i) => (
            <g key={row.k}>
              <text x={left - 8} y={i * ch + ch / 2} dy="0.32em" textAnchor="end" className="viz-tick">
                {row.l}
              </text>
              {cols.map((c, j) => {
                const v = val.get(`${row.k}|${c.k}`) ?? 0;
                return <rect key={c.k} x={left + j * cw + 1} y={i * ch + 1} width={cw - 2} height={ch - 2} rx={2} className={`hm-${step(v)}${hover?.i === i && hover?.j === j ? ' on' : ''}`} onPointerEnter={() => setHover({ i, j })} />;
              })}
            </g>
          ))}
          {cols.map((c, j) =>
            j % labelEvery === 0 ? (
              <text key={c.k} x={left + j * cw + cw / 2} y={rowsK.length * ch + 14} textAnchor="middle" className="viz-tick">
                {c.l}
              </text>
            ) : null,
          )}
        </svg>
      )}
      <div className="viz-scale">
        <span>0</span>
        {[1, 2, 3, 4, 5, 6].map((s) => (
          <i key={s} className={`hm-${s}`} />
        ))}
        <span>{fmt(max, format)}</span>
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

/** Stat tile: value, change against the previous period (arrow + text, never colour alone). */
export function Kpi({ r }: { r: ReportResult }) {
  const m = r.measures[0];
  const cur = r.totals.v[0];
  const prev = r.totals.p?.[0];
  let change: { text: string; up: boolean } | null = null;
  if (r.totals.p && cur !== null && cur !== undefined && prev !== null && prev !== undefined) {
    // The arrow carries the direction, the number stays unsigned (▼ 20,5 %, not ▼ -20,5 %).
    if (m.format === 'percent') change = { text: tc('{n} Pkt.', { n: Math.abs(cur - prev).toLocaleString(intlLocale(), { maximumFractionDigits: 1 }) }), up: cur >= prev };
    else {
      const d = delta(cur, prev);
      if (d !== null) change = { text: percentText(Math.abs(d).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })), up: d >= 0 };
    }
  }
  const good = change ? change.up !== lowerIsBetter(m.key) : true;
  return (
    <div className="viz-kpi">
      <div className="viz-kpi-value">{fmt(cur, m.format as Format)}</div>
      {r.totals.p && (
        <div className="viz-kpi-delta">
          {change && (
            <span className={good ? 'good' : 'bad'}>
              {change.up ? '▲' : '▼'} {change.text}
            </span>
          )}{' '}
          <span className="muted">{tc('Vorperiode: {value}', { value: fmt(prev ?? null, m.format) })}</span>
        </div>
      )}
      {r.measures.length > 1 && (
        <div className="viz-kpi-more">
          {r.measures.slice(1, 4).map((x, i) => (
            <span key={x.key}>
              {x.label}: <b>{fmt(r.totals.v[i + 1], x.format)}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
