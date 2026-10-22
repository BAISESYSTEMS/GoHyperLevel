import { useState, type ReactNode } from 'react';
import { METRICS, headline, metricValue, money, waterfall, type CalcInput, type MetricKey, type RunResult } from '../../../server/services/calc-engine';
import { Stat, Tabs } from '../ui';
import { ProjectionCharts, TornadoChart, Waterfall } from './CalcCharts';
import { SortableGrid } from '../sortable/Sortable';

/**
 * The results side of the Gewinnrechner: the answer in one sentence with the key figures, the heatmap matrix
 * (customers × price variants, one metric at a time) and the detail of the selected cell – waterfall, levers,
 * projection, unit economics and taxes.
 */

export type Period = 'month' | 'year';
export interface Focus {
  /** Matrix cell (row/column index) or null = the prices as entered at `customers.count`. */
  cell: { row: number; col: number } | null;
}

const de = (v: number, d = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: d }).format(v);
const eur = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : money(v, d).replace(/^-/, '−'));
const pctS = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${de(v, 1)} %`);
const neg = (v: number | null | undefined) => (typeof v === 'number' && v < 0 ? ' neg' : '');

// --- headline and key figures --------------------------------------------------------------------------------------------------

export function Headline({ input, res }: { input: CalcInput; res: RunResult }) {
  const f = res.focus;
  const c = f.cell;
  const u = f.unit;
  const mrr = f.customers * u.arpu_net;
  const be = u.breakeven;
  return (
    <section className="calc-head card" data-tour="calc-headline">
      <p className="calc-answer">{headline(input, f)}</p>
      {res.warnings.map((w) => (
        <p className="calc-callout" key={w} role="note">
          {w}
        </p>
      ))}
      <SortableGrid id="calc-results.stats" className="stats calc-stats">
        <Stat label="Umsatz netto pro Monat" value={eur(c.m.revenue_net)} sub={`brutto ${eur(c.m.revenue_gross)}`} />
        <Stat label="Nach variablen Kosten" value={<span className={neg(c.m.contribution)}>{eur(c.m.contribution)}</span>} sub={`${pctS(c.contribution_margin)} vom Umsatz`} />
        <Stat label="EBIT pro Monat" value={<span className={neg(c.m.ebit)}>{eur(c.m.ebit)}</span>} sub={`nach Fixkosten ${eur(c.m.fixed)}`} />
        <Stat label="Nettogewinn pro Monat" value={<span className={neg(c.m.net_profit)}>{eur(c.m.net_profit)}</span>} sub={`${eur(c.y.net_profit)} im Jahr · Marge ${pctS(c.margin)}`} tour="calc-net" />
        <Stat label="Break-even" value={be.customers === null ? 'nie' : be.customers === 0 ? 'sofort' : `ab ${de(be.customers)} Kunden`} sub={be.customers_net !== null && be.customers_net !== be.customers ? `nach Steuern ab ${de(be.customers_net)}` : be.customers === null ? 'bei diesen Preisen' : 'vor Steuern'} />
        <Stat label="MRR / ARR" value={eur(mrr)} sub={`ARR ${eur(mrr * 12)}`} />
        <Stat label="Kundenwert / Kosten" value={u.ltv_cac === null ? '–' : `${de(u.ltv_cac, 1)}×`} sub={`LTV ${eur(u.ltv)} · CAC ${eur(u.cac)}`} />
        <Stat label="Amortisation je Kunde" value={u.payback_months === null ? 'nie' : `${de(u.payback_months, 1)} Monate`} sub={`Ø Laufzeit ${de(u.lifetime_months, 1)} Monate`} />
      </SortableGrid>
    </section>
  );
}

// --- heatmap -------------------------------------------------------------------------------------------------------------------

function heat(v: number | null, max: number, diverging: boolean): string | undefined {
  if (v === null || !Number.isFinite(v) || max <= 0) return undefined;
  const t = Math.min(1, Math.abs(v) / max);
  if (!diverging) return `color-mix(in srgb, var(--brand) ${Math.round(t * 42)}%, var(--panel))`;
  return `color-mix(in srgb, var(${v >= 0 ? '--green' : '--red'}) ${Math.round(t * 46)}%, var(--panel))`;
}

export function Matrix({ res, metric, setMetric, period, setPeriod, focus, setFocus }: { res: RunResult; metric: MetricKey; setMetric: (m: MetricKey) => void; period: Period; setPeriod: (p: Period) => void; focus: Focus; setFocus: (f: Focus) => void }) {
  const meta = METRICS.find((m) => m.key === metric)!;
  const values = res.matrix.map((row) => row.map((c) => metricValue(c, metric, period)));
  const flat = values.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  const max = Math.max(0, ...flat.map((v) => Math.abs(v)));
  const diverging = metric !== 'revenue_gross' && metric !== 'revenue_net';
  const show = (v: number | null) => (v === null ? '–' : meta.unit === 'pct' ? `${de(v, 1)} %` : eur(v));
  const unit = meta.unit === 'pct' ? '' : period === 'year' ? ' pro Jahr' : ' pro Monat';
  const sel = focus.cell;
  return (
    <section className="card calc-matrix" data-tour="calc-matrix">
      <div className="calc-matrix-head">
        <div>
          <h3>Was bleibt übrig? <span className="muted small">Kunden × Preis</span></h3>
          <p className="muted small">Klick auf ein Feld zeigt unten die Rechnung dazu.</p>
        </div>
        <div className="calc-matrix-tools">
          <label className="calc-f compact" data-tour="calc-metric">
            <span>Kennzahl</span>
            <span className="calc-in">
              <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)} aria-label="Kennzahl der Tabelle">
                {METRICS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          {meta.unit !== 'pct' && (
            <div className="seg" role="group" aria-label="Zeitraum">
              <button type="button" className={period === 'month' ? 'on' : ''} onClick={() => setPeriod('month')} aria-pressed={period === 'month'}>
                Monat
              </button>
              <button type="button" className={period === 'year' ? 'on' : ''} onClick={() => setPeriod('year')} aria-pressed={period === 'year'}>
                Jahr
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="table-wrap calc-table-wrap">
        <table className="calc-heat">
          <caption className="sr-only">
            {meta.label}
            {unit} je Kundenzahl (Zeilen) und Preisvariante (Spalten)
          </caption>
          <thead>
            <tr>
              <th scope="col">Kunden</th>
              {res.columns.map((c) => (
                <th scope="col" key={c.key}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {res.rows.map((n, ri) => (
              <tr key={n}>
                <th scope="row">{de(n)}</th>
                {values[ri].map((v, ci) => {
                  const on = sel?.row === ri && sel?.col === ci;
                  return (
                    <td key={ci} style={{ background: heat(v, max, diverging) }} className={on ? 'sel' : ''}>
                      <button type="button" className="calc-cell" aria-pressed={on} aria-label={`${de(n)} Kunden zu ${res.columns[ci].label}: ${meta.label}${unit} ${show(v)}`} onClick={() => setFocus({ cell: on ? null : { row: ri, col: ci } })}>
                        {show(v)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Break-even</th>
              {res.unit.map((u, i) => (
                <td key={i}>{u.breakeven.customers === null ? 'nie' : `ab ${de(u.breakeven.customers)}`}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">LTV / CAC</th>
              {res.unit.map((u, i) => (
                <td key={i}>{u.ltv_cac === null ? '–' : `${de(u.ltv_cac, 1)}×`}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="muted small calc-foot">
        {meta.label}
        {unit} · {de(res.rows.length)} Kundenzahlen × {de(res.columns.length)} Preisvarianten
      </p>
    </section>
  );
}

// --- detail ---------------------------------------------------------------------------------------------------------------------

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap calc-mini">
      <table className="t">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={i ? 'num' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={j ? 'num' : 'strong'}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const TAX_TEXT: Record<string, string> = {
  einzelunternehmen: 'Einzelunternehmen: Einkommensteuer nach § 32a EStG (Grundtarif oder Splitting) auf Gewinn plus weitere Einkünfte, abzüglich Vorsorge und Abzügen; dazu Soli und optional Kirchensteuer. Die Gewerbesteuer wird nach § 35 EStG zum Teil auf die Einkommensteuer angerechnet.',
  kapitalgesellschaft: 'GmbH/UG: Körperschaftsteuer plus Soli auf den Gewinn und Gewerbesteuer ohne Freibetrag. Bei einer Ausschüttung kommt die Abgeltungsteuer beim Inhaber dazu.',
  keine: 'Ohne Steuern gerechnet: der Nettogewinn ist hier das Ergebnis vor Steuern.',
};

export function Detail({ input, res, period, focusLabel, onReset, isCell }: { input: CalcInput; res: RunResult; period: Period; focusLabel: string; onReset: () => void; isCell: boolean }) {
  const [tab, setTab] = useState('waterfall');
  const f = res.focus;
  const u = f.unit;
  const t = f.cell.tax;
  const steps = waterfall(f.cell, period);
  const per = period === 'year' ? 'pro Jahr' : 'pro Monat';
  return (
    <section className="card calc-detail" data-tour="calc-detail">
      <div className="calc-detail-head">
        <h3>{focusLabel}</h3>
        {isCell && (
          <button type="button" className="btn secondary small" onClick={onReset}>
            Zurück zu meiner Rechnung
          </button>
        )}
      </div>
      <Tabs
        tabs={[
          ['waterfall', 'Wasserfall'],
          ['levers', 'Hebel'],
          ['projection', 'Prognose'],
          ['unit', 'Pro Kunde'],
          ['tax', 'Steuern'],
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'waterfall' && <Waterfall steps={steps} title={`Von der Zahlung zum Nettogewinn ${per}`} caption={`${de(f.customers)} Kunden · ${f.column.label}`} />}
      {tab === 'levers' && f.sensitivity && <TornadoChart t={f.sensitivity} title={`Was den Nettogewinn pro Jahr am meisten bewegt (± ${de(f.sensitivity.pct)} %)`} caption="Jeder Balken: dieser Wert um den Prozentsatz kleiner und größer, alles andere bleibt." />}
      {tab === 'projection' && (
        <>
          <ProjectionCharts p={f.projection} />
          <Table
            head={['Nach', 'Kunden', 'MRR', 'ARR', 'Umsatz netto', 'EBIT', 'Steuern', 'Nettogewinn']}
            rows={f.projection.horizons.map((h) => [`${h.months} Monaten`, de(h.customers), eur(h.mrr), eur(h.arr), eur(h.revenue_net), eur(h.ebit), eur(h.tax), eur(h.net_profit)])}
          />
          <p className="muted small calc-foot">
            Summen der ersten 12, 24 und 36 Monate (MRR und Kunden: Stand am Ende). Kunden wachsen mit {de(input.customers.growth.monthly_new)} Neukunden pro Monat{input.customers.growth.monthly_new_growth ? ` (${input.customers.growth.monthly_new_growth > 0 ? '+' : ''}${de(input.customers.growth.monthly_new_growth, 1)} % je Monat)` : ''} abzüglich {de(input.customers.churn, 1)} % Kündigungen.{' '}
            {f.projection.breakeven_month ? `Insgesamt im Plus ab Monat ${f.projection.breakeven_month}.` : 'Innerhalb der Prognose wird das Geschäft insgesamt nicht ins Plus kommen.'}
          </p>
        </>
      )}
      {tab === 'unit' && (
        <>
          <SortableGrid id="calc-results.stats-2" className="stats calc-stats">
            <Stat label="Umsatz je Kunde und Monat" value={eur(u.arpu_net, 2)} sub={`brutto ${eur(u.arpu_gross, 2)}`} />
            <Stat label="Bleibt je Kunde und Monat" value={<span className={neg(u.contribution)}>{eur(u.contribution, 2)}</span>} sub="nach Gebühren und variablen Kosten" />
            <Stat label="Ø Laufzeit" value={`${de(u.lifetime_months, 1)} Monate`} sub={`Kündigungen ${de(input.customers.churn, 1)} % je Monat`} />
            <Stat label="Kundenwert (LTV)" value={eur(u.ltv)} sub={`Kosten je Neukunde ${eur(u.cac)}`} />
            <Stat label="LTV / CAC" value={u.ltv_cac === null ? '–' : `${de(u.ltv_cac, 1)}×`} sub={u.ltv_cac === null ? 'ohne Kundengewinnungskosten' : u.ltv_cac >= 3 ? 'gesund (ab 3×)' : 'unter 3× – knapp'} />
            <Stat label="Amortisation" value={u.payback_months === null ? 'nie' : `${de(u.payback_months, 1)} Monate`} sub="bis ein Neukunde seine Kosten eingespielt hat" />
            <Stat label="Ø Einheiten / Nutzer" value={`${de(u.units, 1)} / ${de(u.users, 1)}`} sub="je Kunde, über alle Tarife" />
            <Stat label="Mindestpreis" value={f.min_price === null ? '–' : eur(f.min_price, 2)} sub={`Grundpreis für EBIT 0 bei ${de(f.customers)} Kunden`} />
          </SortableGrid>
          <Table
            head={['Preisvariante', 'Umsatz/Kunde', 'Bleibt/Kunde', 'LTV/CAC', 'Amortisation', 'Break-even']}
            rows={res.columns.map((c, i) => [c.label, eur(res.unit[i].arpu_net, 2), eur(res.unit[i].contribution, 2), res.unit[i].ltv_cac === null ? '–' : `${de(res.unit[i].ltv_cac!, 1)}×`, res.unit[i].payback_months === null ? 'nie' : `${de(res.unit[i].payback_months!, 1)} Mon.`, res.unit[i].breakeven.customers === null ? 'nie' : `ab ${de(res.unit[i].breakeven.customers!)}`])}
          />
        </>
      )}
      {tab === 'tax' && (
        <>
          <p className="calc-disclaimer-s">Schätzung, keine Steuerberatung.</p>
          <p className="small">{TAX_TEXT[input.tax.legal_form]}</p>
          <Table
            head={['Jahr (hochgerechnet aus einem Monat)', 'Betrag']}
            rows={[
              ['EBIT (Gewinn vor Steuern)', eur(f.cell.y.ebit)],
              ...(input.tax.legal_form === 'einzelunternehmen' ? [['Zu versteuerndes Einkommen (mit weiteren Einkünften)', eur(t.zve)], ['Einkommensteuer auf den Gewinn', eur(t.est)], ...(t.s35 > 0 ? [['darin: Anrechnung der Gewerbesteuer (§ 35 EStG)', `− ${eur(t.s35)}`]] : []), ['Solidaritätszuschlag', eur(t.soli)], ['Kirchensteuer', eur(t.church)]] : []),
              ...(input.tax.legal_form === 'kapitalgesellschaft' ? [['Körperschaftsteuer', eur(t.kst)], ['Solidaritätszuschlag', eur(t.soli)], ['Steuer auf Ausschüttung', eur(t.dividend_tax)]] : []),
              ...(input.tax.legal_form !== 'keine' ? [['Gewerbesteuer', eur(t.gewst)]] : []),
              ['Steuern gesamt', eur(t.total)],
              ['Vorsorge (Kranken-/Rentenversicherung)', eur(f.cell.y.vorsorge)],
              ['Nettogewinn', eur(f.cell.y.net_profit)],
            ]}
          />
          <p className="muted small calc-foot">
            Durchschnittliche Steuerlast {pctS(t.rate_pct)} vom Gewinn.
            {input.tax.legal_form === 'einzelunternehmen' ? ` Tarif ${input.tax.est.year}, Gewerbesteuer-Hebesatz ${de(input.tax.gewerbesteuer.hebesatz)} %.` : ''} Die Tarifwerte stehen im Eingabefeld „Steuern“ und lassen sich ändern; maßgeblich ist immer der Bescheid.
          </p>
        </>
      )}
    </section>
  );
}
