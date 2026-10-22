import { useMemo, useState } from 'react';
import { ColumnChart, BarList } from './BarChart';
import { LineChart } from './LineChart';
import { Funnel, Heatmap, Kpi, PieChart } from './Shapes';
import { NoData, delta, fmt, lowerIsBetter, percentText, shape, type ReportResult, type Viz } from './core';
import { intlLocale, tr } from '../i18n';

/** Texts of the core catalog (always loaded). */
const tc = tr('core');

/** Sortable table of a result (also the accessible twin of every chart). */
export function DataTable({ r, maxRows = 500, height }: { r: ReportResult; maxRows?: number; height?: number }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const nd = r.dims.length;
  const cmp = !!r.previous;
  const rows = useMemo(() => {
    const list = nd ? [...r.rows] : [{ k: [], l: [], v: r.totals.v, p: r.totals.p }];
    if (sort) {
      list.sort((a, b) => {
        if (sort.col < nd) return sort.dir * a.l[sort.col].localeCompare(b.l[sort.col], 'de', { numeric: true });
        const i = sort.col - nd;
        return sort.dir * ((a.v[i] ?? -Infinity) - (b.v[i] ?? -Infinity));
      });
    }
    return list.slice(0, maxRows);
  }, [r, sort, nd, maxRows]);
  if (!rows.length) return <NoData />;
  const head = [...r.dims.map((d) => d.label), ...r.measures.map((m) => m.label)];
  const click = (col: number) => setSort((s) => (s?.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: col < nd ? 1 : -1 }));
  return (
    <div className="viz-table-wrap" style={height ? { maxHeight: height } : undefined}>
      <table className="t viz-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={i >= nd ? 'num' : undefined} aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                <button type="button" onClick={() => click(i)}>
                  {h}
                  {sort?.col === i ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
            ))}
            {cmp && <th className="num">{r.measures.length > 1 ? tc('{label} (Vorperiode)', { label: r.measures[0].label }) : tc('Vorperiode')}</th>}
            {cmp && <th className="num">Δ</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const d = cmp ? delta(row.v[0], row.p?.[0]) : null;
            const good = d === null ? null : d >= 0 !== lowerIsBetter(r.measures[0].key);
            return (
              <tr key={i}>
                {row.l.map((l, j) => (
                  <td key={j}>{l}</td>
                ))}
                {row.v.map((v, j) => (
                  <td key={`v${j}`} className="num">
                    {fmt(v, r.measures[j].format)}
                  </td>
                ))}
                {cmp && <td className="num muted">{fmt(row.p?.[0] ?? null, r.measures[0].format)}</td>}
                {cmp && <td className={`num ${good === null ? 'muted' : good ? 'good' : 'bad'}`}>{d === null ? '–' : `${d >= 0 ? '▲' : '▼'} ${percentText(Math.abs(d).toLocaleString(intlLocale(), { maximumFractionDigits: 1 }))}`}</td>}
              </tr>
            );
          })}
        </tbody>
        {nd > 0 && (
          <tfoot>
            <tr>
              <td colSpan={nd}>{tc('Gesamt')}</td>
              {r.totals.v.map((v, j) => (
                <td key={j} className="num">
                  {fmt(v, r.measures[j].format)}
                </td>
              ))}
              {cmp && <td className="num muted">{fmt(r.totals.p?.[0] ?? null, r.measures[0].format)}</td>}
              {cmp && <td />}
            </tr>
          </tfoot>
        )}
      </table>
      {(r.truncated || r.rows.length > rows.length) && <p className="muted small">{tc('Nur die ersten {n} Zeilen – Filter oder „Top N“ nutzen.', { n: rows.length })}</p>}
    </div>
  );
}

/** Why a chart type does not fit the chosen groups (shown instead of a broken chart). */
export function vizHint(viz: Viz, r: ReportResult): string {
  const n = r.dims.length;
  const t = tr('core');
  if ((viz === 'line' || viz === 'area') && n === 0) return t('Für Linien eine Gruppierung wählen, am besten ein Datum (z. B. „Erstellt am · Woche“).');
  if ((viz === 'bar' || viz === 'hbar' || viz === 'pie' || viz === 'donut' || viz === 'funnel') && n === 0) return t('Für dieses Diagramm eine Gruppierung wählen.');
  if (viz === 'stacked' && n < 2) return t('Für gestapelte Säulen zwei Gruppierungen wählen (z. B. Nutzer und Status).');
  if (viz === 'hbar' && n > 1) return t('Balken zeigen eine Gruppierung – für zwei bitte „Gestapelt“ oder „Säulen“ wählen.');
  if (viz === 'heatmap' && n < 2) return t('Für eine Heatmap zwei Gruppierungen wählen (z. B. Wochentag und Stunde).');
  return '';
}

/** Draws a result as the chosen visualisation; `table` flips any chart to its table. */
export function ReportView({ r, viz, height, table }: { r: ReportResult; viz: Viz; height: number; table?: boolean }) {
  const shaped = useMemo(() => shape(r), [r]);
  if (table || viz === 'table') return <DataTable r={r} height={height} />;
  if (viz === 'kpi' || (r.dims.length === 0 && viz !== 'heatmap')) {
    const hint = viz !== 'kpi' ? vizHint(viz, r) : '';
    return (
      <>
        <Kpi r={r} />
        {hint && <p className="muted small viz-hint">{hint}</p>}
      </>
    );
  }
  const hint = vizHint(viz, r);
  if (hint) return <NoData>{hint}</NoData>;
  switch (viz) {
    case 'line':
    case 'area':
      return <LineChart data={shaped} height={height} area={viz === 'area'} />;
    case 'bar':
      return <ColumnChart data={shaped} height={height} />;
    case 'stacked':
      return <ColumnChart data={shaped} height={height} stacked />;
    case 'hbar':
      return <BarList data={shaped} height={height} />;
    case 'pie':
    case 'donut':
      return <PieChart r={r} height={height} donut={viz === 'donut'} />;
    case 'funnel':
      return <Funnel r={r} height={height} />;
    case 'heatmap':
      return <Heatmap r={r} height={height} />;
  }
  return <DataTable r={r} />;
}

export { fmt };
