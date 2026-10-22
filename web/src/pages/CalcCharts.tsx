import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Month, Projection, Step, Tornado } from '../../../server/services/calc-engine';
import { money } from '../../../server/services/calc-engine';

/**
 * Hand-made SVG charts of the Gewinnrechner (no chart library): waterfall, tornado and the projection lines.
 * They measure their container and lay out in real pixels, so text stays readable on a phone; colours are the
 * theme's tokens (--viz-*, --red), so light, dark and every theme work. Every chart has a text alternative.
 */

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(260, Math.round(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Shortens a label to what fits `px` pixels at 12 px type (the full text stays in the tooltip). */
const fit = (s: string, px: number, bold = false) => {
  const n = Math.max(6, Math.floor((px - 10) / (bold ? 8.2 : 7.1)));
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/** "−1.234 €" with a real minus sign. */
const eur = (v: number) => money(v).replace(/^-/, '−');

/** Short axis label: 1.200 · 12 Tsd. · 1,2 Mio. */
export function axisLabel(v: number): string {
  const a = Math.abs(v);
  const f = (x: number, d: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: d }).format(x).replace(/^-/, '−');
  if (a >= 1e6) return `${f(v / 1e6, 1)} Mio.`;
  if (a >= 1e4) return `${f(v / 1e3, 0)} Tsd.`;
  return f(v, a < 10 && !Number.isInteger(v) ? 1 : 0);
}

/** Round tick values covering [min, max] (min/max may be negative). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [0, 1];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function Figure({ title, caption, children, tour }: { title: string; caption?: string; children: ReactNode; tour?: string }) {
  return (
    <figure className="calc-fig" data-tour={tour}>
      <figcaption>
        <strong>{title}</strong>
        {caption && <span className="muted small"> {caption}</span>}
      </figcaption>
      {children}
    </figure>
  );
}

// --- waterfall ---------------------------------------------------------------------------------------------------------------

/** From payments to net profit: one row per step, bars float on the running total. */
export function Waterfall({ steps, title, caption }: { steps: Step[]; title: string; caption?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const narrow = w < 520;
  const labelW = narrow ? Math.min(150, Math.round(w * 0.42)) : 224;
  const valueW = narrow ? 70 : 92;
  const rowH = 26;
  const H = steps.length * rowH + 8;
  let run = 0;
  const rows = steps.map((s) => {
    let a: number;
    let b: number;
    if (s.kind === 'delta') {
      a = run;
      b = run + s.value;
    } else {
      a = 0;
      b = s.value;
    }
    run = b;
    return { s, a, b };
  });
  const lo = Math.min(0, ...rows.flatMap((r) => [r.a, r.b]));
  const hi = Math.max(0, ...rows.flatMap((r) => [r.a, r.b]));
  const span = hi - lo || 1;
  const x0 = labelW;
  const x1 = w - valueW;
  const x = (v: number) => x0 + ((v - lo) / span) * (x1 - x0);
  const alt = steps.map((s) => `${s.label}: ${eur(s.value)}`).join('; ');
  return (
    <Figure title={title} caption={caption} tour="calc-waterfall">
      <div ref={ref} className="calc-chart">
        <svg width={w} height={H} role="img" aria-label={`${title}. ${alt}`}>
          <title>{title}</title>
          <line x1={x(0)} x2={x(0)} y1={2} y2={H - 4} stroke="var(--viz-axis)" strokeWidth={1} />
          {rows.map(({ s, a, b }, i) => {
            const y = i * rowH + 4;
            const left = Math.min(x(a), x(b));
            const bw = Math.max(2, Math.abs(x(b) - x(a)));
            const fill = s.kind === 'delta' ? 'var(--viz-2)' : s.kind === 'total' ? 'var(--viz-1)' : s.value >= 0 ? 'var(--viz-3)' : 'var(--red)';
            const strong = s.kind !== 'delta';
            return (
              <g key={s.key}>
                {i > 0 && <line x1={x(rows[i - 1].b)} x2={x(a)} y1={y - 2} y2={y + 2} stroke="var(--viz-muted)" strokeWidth={1} />}
                <text x={labelW - 8} y={y + 14} textAnchor="end" fontSize={12} fontWeight={strong ? 600 : 400} fill="var(--text)">
                  {fit(s.label, labelW, strong)}
                  <title>{s.label}</title>
                </text>
                <rect x={left} y={y + 3} width={bw} height={16} rx={3} fill={fill} opacity={strong ? 1 : 0.9}>
                  <title>{`${s.label}: ${eur(s.value)}`}</title>
                </rect>
                <text x={w - 4} y={y + 14} textAnchor="end" fontSize={12} fontWeight={strong ? 700 : 400} fill="var(--text)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {eur(s.value)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </Figure>
  );
}

// --- tornado ---------------------------------------------------------------------------------------------------------------

/** Which input moves the yearly net profit most: every bar spans the profit with the input −x % and +x %. */
export function TornadoChart({ t, title, caption }: { t: Tornado; title: string; caption?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const narrow = w < 520;
  const labelW = narrow ? Math.min(130, Math.round(w * 0.36)) : 196;
  const pad = narrow ? 48 : 70;
  const rowH = 28;
  const bars = t.bars.slice(0, 10);
  const H = bars.length * rowH + 30;
  const spans = bars.map((b) => ({ b, lo: Math.min(b.low, b.high), hi: Math.max(b.low, b.high), lowIsMinus: b.low <= b.high }));
  const lo = Math.min(t.base, ...spans.map((s) => s.lo));
  const hi = Math.max(t.base, ...spans.map((s) => s.hi));
  const span = hi - lo || 1;
  const x0 = labelW + pad;
  const x1 = w - pad;
  const x = (v: number) => x0 + ((v - lo) / span) * (x1 - x0);
  const alt = bars.map((b) => `${b.label}: ${eur(Math.min(b.low, b.high))} bis ${eur(Math.max(b.low, b.high))}`).join('; ');
  if (!bars.length) return <p className="muted small">Keine Hebel mit Wirkung – es gibt nichts zu vergleichen.</p>;
  return (
    <Figure title={title} caption={caption} tour="calc-tornado">
      <div ref={ref} className="calc-chart">
        <svg width={w} height={H} role="img" aria-label={`${title}. Basis ${eur(t.base)} pro Jahr. ${alt}`}>
          <title>{title}</title>
          <text x={x(t.base)} y={11} textAnchor="middle" fontSize={11} fill="var(--viz-ink2)">
            Basis {eur(t.base)}
          </text>
          <line x1={x(t.base)} x2={x(t.base)} y1={16} y2={H - 2} stroke="var(--viz-axis)" strokeWidth={1.5} />
          {spans.map(({ b, lo: l, hi: h, lowIsMinus }, i) => {
            const y = i * rowH + 22;
            return (
              <g key={b.key}>
                <text x={labelW - 6} y={y + 14} textAnchor="end" fontSize={12} fill="var(--text)">
                  {fit(b.label, labelW)}
                  <title>{b.label}</title>
                </text>
                <rect x={x(l)} y={y + 2} width={Math.max(1, x(t.base) - x(l))} height={18} fill="var(--red)" opacity={0.9} rx={2}>
                  <title>{`${b.label} ${lowIsMinus ? '−' : '+'}${Math.round(t.pct)} %: Nettogewinn ${eur(l)} pro Jahr`}</title>
                </rect>
                <rect x={x(t.base)} y={y + 2} width={Math.max(1, x(h) - x(t.base))} height={18} fill="var(--viz-3)" rx={2}>
                  <title>{`${b.label} ${lowIsMinus ? '+' : '−'}${Math.round(t.pct)} %: Nettogewinn ${eur(h)} pro Jahr`}</title>
                </rect>
                <text x={x(l) - 4} y={y + 15} textAnchor="end" fontSize={11} fill="var(--viz-ink2)">
                  {axisLabel(l)}
                </text>
                <text x={x(h) + 4} y={y + 15} textAnchor="start" fontSize={11} fill="var(--viz-ink2)">
                  {axisLabel(h)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Legend items={[['var(--red)', 'schlechter als die Basis'], ['var(--viz-3)', 'besser als die Basis']]} />
    </Figure>
  );
}

export function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="calc-legend">
      {items.map(([c, l]) => (
        <span key={l}>
          <i style={{ background: c }} aria-hidden />
          {l}
        </span>
      ))}
    </div>
  );
}

// --- lines ---------------------------------------------------------------------------------------------------------------------

interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

function LineChart({ title, caption, series, months, marker, readout, tour }: { title: string; caption?: string; series: LineSeries[]; months: number[]; marker?: { x: number; label: string } | null; readout: (i: number) => string; tour?: string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 210;
  const m = { l: 64, r: 14, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const n = months.length;
  const px = (i: number) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * (w - m.l - m.r));
  const py = (v: number) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);
  const step = n > 30 ? 6 : n > 14 ? 3 : 2;
  const xt = months.map((t, i) => [t, i] as const).filter(([t]) => t === 1 || t % step === 0);
  const at = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left - m.l) / Math.max(1, r.width - m.l - m.r);
    setHover(Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))));
  };
  const alt = `${title}. ${series.map((s) => `${s.label}: Monat 1 ${eur(s.values[0])}, Monat ${n} ${eur(s.values[n - 1])}`).join('; ')}`;
  return (
    <Figure title={title} caption={caption} tour={tour}>
      <div className="calc-readout" aria-live="polite">
        {readout(hover ?? n - 1)}
      </div>
      <div ref={ref} className="calc-chart">
        <svg width={w} height={H} role="img" aria-label={alt} onPointerMove={at} onPointerDown={at} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }}>
          <title>{title}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={w - m.r} y1={py(t)} y2={py(t)} stroke={t === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={t === 0 ? 1.5 : 1} />
              <text x={m.l - 8} y={py(t) + 4} textAnchor="end" fontSize={11} fill="var(--viz-ink2)">
                {axisLabel(t)}
              </text>
            </g>
          ))}
          {xt.map(([t, i]) => (
            <text key={t} x={px(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="var(--viz-ink2)">
              {t}
            </text>
          ))}
          {marker && marker.x >= 1 && marker.x <= n && (
            <g>
              <line x1={px(marker.x - 1)} x2={px(marker.x - 1)} y1={m.t} y2={H - m.b} stroke="var(--viz-muted)" strokeDasharray="4 3" />
              <text x={px(marker.x - 1) + (marker.x > n * 0.7 ? -4 : 4)} y={m.t + 10} textAnchor={marker.x > n * 0.7 ? 'end' : 'start'} fontSize={11} fill="var(--viz-ink2)">
                {marker.label}
              </text>
            </g>
          )}
          {series.map((s) => (
            <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')} />
          ))}
          {hover !== null && (
            <g>
              <line x1={px(hover)} x2={px(hover)} y1={m.t} y2={H - m.b} stroke="var(--viz-muted)" />
              {series.map((s) => (
                <circle key={s.key} cx={px(hover)} cy={py(s.values[hover])} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={1.5} />
              ))}
            </g>
          )}
        </svg>
      </div>
      <Legend items={series.map((s) => [s.color, s.label])} />
    </Figure>
  );
}

const de = (v: number, d = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: d }).format(v);

/** MRR and monthly net profit, and the cumulative result with the break-even month. */
export function ProjectionCharts({ p }: { p: Projection }) {
  const ms: Month[] = p.months;
  if (!ms.length) return null;
  const t = ms.map((x) => x.t);
  return (
    <>
      <LineChart
        title="Monatlicher Umsatz und Gewinn"
        caption="Prognose nach Monaten"
        tour="calc-projection"
        months={t}
        series={[
          { key: 'mrr', label: 'Wiederkehrender Umsatz (MRR)', color: 'var(--viz-1)', values: ms.map((x) => x.mrr) },
          { key: 'net', label: 'Nettogewinn im Monat', color: 'var(--viz-3)', values: ms.map((x) => x.net_profit) },
        ]}
        readout={(i) => `Monat ${ms[i].t}: ${de(ms[i].customers)} Kunden · MRR ${eur(ms[i].mrr)} · Nettogewinn ${eur(ms[i].net_profit)}`}
      />
      <LineChart
        title="Gewinn kumuliert"
        caption="inklusive einmaliger Investition"
        months={t}
        marker={p.breakeven_month ? { x: p.breakeven_month, label: `im Plus ab Monat ${p.breakeven_month}` } : null}
        series={[{ key: 'cum', label: 'Gewinn seit Start', color: 'var(--viz-2)', values: ms.map((x) => x.cum_net) }]}
        readout={(i) => `Monat ${ms[i].t}: seit Start ${eur(ms[i].cum_net)} · EBIT im Monat ${eur(ms[i].ebit)}`}
      />
    </>
  );
}
