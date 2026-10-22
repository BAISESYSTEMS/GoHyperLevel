/**
 * Gewinnrechner: condensed views of an engine run – the key figures of a scenario, a side-by-side comparison and the
 * compact answer for agents (MCP) and the app. Pure: the browser imports this file too (compare dialog).
 *
 * The full `RunResult` of a 16 × 12 matrix has thousands of numbers; an agent needs the one it asked for, the
 * focus cell and the assumptions behind them, so it can say what the answer rests on.
 */
import { DISCLAIMER, METRICS, cellOf, columnsOf, currentColumn, econ, eur, fixedCosts, headline, metricValue, minPrice, rounded, unitEcon, type CalcInput, type Detail, type MetricKey, type RunResult } from './calc-engine.js';

export type Period = 'month' | 'year';
export const METRIC_KEYS = METRICS.map((m) => m.key) as MetricKey[];

/** The figures a scenario is judged by (stored with the scenario, shown in lists and the comparison). */
export interface Kpis {
  customers: number;
  /** Price variant of the focus cell ("49 €", "Aktuelle Preise"). */
  price: string;
  arpu_net: number;
  revenue_net_month: number;
  contribution_month: number;
  ebit_month: number;
  tax_month: number;
  net_profit_month: number;
  net_profit_year: number;
  margin_pct: number | null;
  breakeven_customers: number | null;
  breakeven_customers_net: number | null;
  ltv: number;
  cac: number;
  ltv_cac: number | null;
  payback_months: number | null;
  mrr_12: number | null;
  mrr_24: number | null;
  mrr_36: number | null;
  /** Cumulative net profit after 36 months (after the one-time investment); null for a shorter projection. */
  net_profit_36m: number | null;
  /** First month in which the cumulative net profit stays ≥ 0. */
  breakeven_month: number | null;
}

export type KpiUnit = 'eur' | 'pct' | 'count' | 'months' | 'ratio';
export const KPI_ROWS: { key: keyof Kpis; label: string; unit: KpiUnit; /** true: a higher value is better, false: lower is better, null: neutral */ better: boolean | null }[] = [
  { key: 'customers', label: 'Kunden', unit: 'count', better: null },
  { key: 'arpu_net', label: 'Umsatz je Kunde und Monat (netto)', unit: 'eur', better: true },
  { key: 'revenue_net_month', label: 'Umsatz netto pro Monat', unit: 'eur', better: true },
  { key: 'contribution_month', label: 'Nach variablen Kosten pro Monat', unit: 'eur', better: true },
  { key: 'ebit_month', label: 'EBIT pro Monat', unit: 'eur', better: true },
  { key: 'tax_month', label: 'Steuern pro Monat', unit: 'eur', better: null },
  { key: 'net_profit_month', label: 'Nettogewinn pro Monat', unit: 'eur', better: true },
  { key: 'net_profit_year', label: 'Nettogewinn pro Jahr', unit: 'eur', better: true },
  { key: 'margin_pct', label: 'Marge (Nettogewinn vom Umsatz)', unit: 'pct', better: true },
  { key: 'breakeven_customers', label: 'Break-even (Kunden, vor Steuern)', unit: 'count', better: false },
  { key: 'breakeven_customers_net', label: 'Break-even (Kunden, nach Steuern)', unit: 'count', better: false },
  { key: 'ltv', label: 'Kundenwert (LTV)', unit: 'eur', better: true },
  { key: 'cac', label: 'Kosten je Neukunde (CAC)', unit: 'eur', better: false },
  { key: 'ltv_cac', label: 'LTV / CAC', unit: 'ratio', better: true },
  { key: 'payback_months', label: 'Amortisation je Kunde (Monate)', unit: 'months', better: false },
  { key: 'mrr_12', label: 'MRR nach 12 Monaten', unit: 'eur', better: true },
  { key: 'mrr_24', label: 'MRR nach 24 Monaten', unit: 'eur', better: true },
  { key: 'mrr_36', label: 'MRR nach 36 Monaten', unit: 'eur', better: true },
  { key: 'net_profit_36m', label: 'Gewinn kumuliert nach 36 Monaten', unit: 'eur', better: true },
  { key: 'breakeven_month', label: 'Gesamt im Plus ab Monat', unit: 'count', better: false },
];

/** Key figures of one detail (the focus of a run). */
export function kpisOf(d: Detail): Kpis {
  const c = d.cell;
  const u = d.unit;
  const p = d.projection;
  const at = (n: number) => p.horizons.find((h) => h.months === n);
  const last36 = p.months.length >= 36 ? p.months[35].cum_net : null;
  return {
    customers: d.customers,
    price: d.column.label,
    arpu_net: u.arpu_net,
    revenue_net_month: c.m.revenue_net,
    contribution_month: c.m.contribution,
    ebit_month: c.m.ebit,
    tax_month: c.m.tax,
    net_profit_month: c.m.net_profit,
    net_profit_year: c.y.net_profit,
    margin_pct: c.margin,
    breakeven_customers: u.breakeven.customers,
    breakeven_customers_net: u.breakeven.customers_net,
    ltv: u.ltv,
    cac: u.cac,
    ltv_cac: u.ltv_cac,
    payback_months: u.payback_months,
    mrr_12: at(12)?.mrr ?? null,
    mrr_24: at(24)?.mrr ?? null,
    mrr_36: at(36)?.mrr ?? null,
    net_profit_36m: last36,
    breakeven_month: p.breakeven_month,
  };
}

/** "12,50 €" / "7,5 %" / "3,2" / "14 Monate" / "–" for a key figure. */
export function formatKpi(v: number | null | undefined, unit: KpiUnit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const n = (x: number, digits = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits }).format(x);
  switch (unit) {
    case 'eur':
      return `${n(v, Math.abs(v) < 100 ? 2 : 0)} €`;
    case 'pct':
      return `${n(v, 1)} %`;
    case 'ratio':
      return `${n(v, 1)}×`;
    case 'months':
      return `${n(v, 1)} Monate`;
    default:
      return n(v);
  }
}

export interface Comparison {
  disclaimer: string;
  /** One entry per scenario, in the order asked. */
  scenarios: { id: string; name: string; kpis: Kpis }[];
  /** Per figure: the values per scenario, the difference to the first scenario and which one is best. */
  rows: { key: keyof Kpis; label: string; unit: KpiUnit; values: (number | null)[]; deltas: (number | null)[]; best: number | null }[];
}

/** Side-by-side table: every key figure per scenario, the difference to the first one and the best scenario. */
export function compare(items: { id: string; name: string; kpis: Kpis }[]): Comparison {
  const rows = KPI_ROWS.map((r) => {
    const values = items.map((i) => (i.kpis[r.key] as number | null) ?? null);
    const first = values[0];
    const deltas = values.map((v, i) => (i === 0 || v === null || first === null ? null : v - first));
    let best: number | null = null;
    if (r.better !== null) {
      values.forEach((v, i) => {
        if (v === null) return;
        if (best === null || (r.better ? v > (values[best] as number) : v < (values[best] as number))) best = i;
      });
      // all equal: nothing stands out
      if (best !== null && values.every((v) => v === values[best as number])) best = null;
    }
    return { key: r.key, label: r.label, unit: r.unit, values, deltas, best };
  });
  return { disclaimer: DISCLAIMER, scenarios: items, rows };
}

/** What the numbers rest on – an agent should name these when it quotes a result. */
export function assumptions(input: CalcInput) {
  const total = input.pricing.plans.reduce((s, p) => s + Math.max(0, p.mix), 0) || 1;
  const f = input.costs.fixed;
  return {
    price_basis: input.pricing.price_basis === 'gross' ? 'Preise brutto (inkl. USt)' : 'Preise netto (ohne USt)',
    plans: input.pricing.plans.map((p) => ({ name: p.name, share_pct: Math.round((Math.max(0, p.mix) / total) * 1000) / 10, base_price: p.base_price, included_units: p.included_units, unit_price: p.unit_price, cap: p.cap, setup_fee: p.setup_fee })),
    annual_share_pct: input.pricing.annual.share,
    annual_discount_pct: input.pricing.annual.discount,
    addons: input.pricing.addons.map((a) => ({ name: a.name, price: a.price, take_rate_pct: a.take_rate })),
    churn_pct_per_month: input.customers.churn,
    avg_units: input.customers.avg_units,
    unit_mix: input.customers.unit_mix.length ? input.customers.unit_mix : undefined,
    vat: input.vat.kleinunternehmer ? 'Kleinunternehmer (keine USt)' : `${input.vat.rate} % USt`,
    eu_share_pct: input.customers.eu_share,
    legal_form: input.tax.legal_form,
    tax_year: input.tax.legal_form === 'einzelunternehmen' ? input.tax.est.year : undefined,
    gewerbesteuer_hebesatz: input.tax.gewerbesteuer.enabled ? input.tax.gewerbesteuer.hebesatz : 0,
    fixed_costs_per_month: Math.round((f.servers_tools + f.salaries + f.insurance + f.marketing + f.other) * 100) / 100,
    cac: input.costs.cac,
    payment_methods: input.costs.variable.payment.methods.map((m) => `${m.label}: ${m.pct} % + ${eur(m.fixed)}`),
  };
}

const LINE_KEYS = ['revenue_gross', 'vat', 'revenue_net', 'fees', 'referral', 'app_store', 'hosting', 'ai', 'messaging', 'support', 'other', 'variable', 'contribution', 'fixed', 'cac', 'ebit', 'tax', 'vorsorge', 'net_profit'] as const;
const pickLines = (l: Record<string, number>) => Object.fromEntries(LINE_KEYS.map((k) => [k, l[k]]));

/**
 * The compact answer: headline, warnings, the focus cell (month and year lines, taxes, waterfall, unit economics,
 * projection horizons, top levers), ONE metric of the matrix and the assumptions. Rounded to cents.
 */
export function compactRun(input: CalcInput, r: RunResult, opts: { metric?: MetricKey; period?: Period } = {}) {
  const metric = opts.metric && METRIC_KEYS.includes(opts.metric) ? opts.metric : 'net_profit';
  const period: Period = opts.period === 'year' ? 'year' : 'month';
  const f = r.focus;
  const meta = METRICS.find((m) => m.key === metric)!;
  return rounded({
    disclaimer: r.disclaimer,
    headline: headline(input, f),
    warnings: r.warnings,
    focus: {
      customers: f.customers,
      price: f.column.label,
      per_month: pickLines(f.cell.m as any),
      per_year: pickLines(f.cell.y as any),
      margin_pct: f.cell.margin,
      tax_per_year: f.cell.tax,
      waterfall_per_month: f.waterfall.map((s) => ({ label: s.label, value: s.value, kind: s.kind })),
      unit_economics: { ...f.unit },
      min_price_for_ebit_zero: f.min_price,
      projection: { horizons: f.projection.horizons, breakeven_month: f.projection.breakeven_month, ebit_positive_month: f.projection.ebit_positive_month },
      top_levers: f.sensitivity ? f.sensitivity.bars.slice(0, 6).map((b) => ({ lever: b.label, net_profit_year_low: b.low, net_profit_year_high: b.high, swing: b.swing })) : undefined,
    },
    matrix: {
      metric: `${meta.label}${metric === 'margin' ? '' : period === 'year' ? ' pro Jahr' : ' pro Monat'}`,
      metric_key: metric,
      period,
      unit: meta.unit === 'pct' ? '%' : '€',
      customers: r.rows,
      columns: r.columns.map((c) => c.label),
      values: r.matrix.map((row) => row.map((c) => metricValue(c, metric, period))),
    },
    by_column: r.columns.map((c, i) => ({ column: c.label, price: c.price, arpu_net: r.unit[i].arpu_net, contribution_per_customer: r.unit[i].contribution, ltv: r.unit[i].ltv, ltv_cac: r.unit[i].ltv_cac, payback_months: r.unit[i].payback_months, breakeven_customers: r.unit[i].breakeven.customers, breakeven_customers_net: r.unit[i].breakeven.customers_net })),
    assumptions: assumptions(input),
  });
}

// --- targets: "how many customers / which price for X € net profit?" ----------------------------------------------------

/** Smallest number of customers whose net profit per month (after taxes and Vorsorge) reaches `target`; null: never at these prices. */
export function customersForNetProfit(input: CalcInput, target: number): number | null {
  const e = econ(input);
  const net = (n: number) => cellOf(input, n, e).m.net_profit;
  if (net(0) >= target) return 0;
  if (net(1e8) < target) return null;
  let lo = 0;
  let hi = 1e8;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (net(mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Lowest base price of the reference plan (matrix.plan_index) at which `customers` customers earn `target` net per month; null: not within 100 000 €. */
export function priceForNetProfit(input: CalcInput, customers: number, target: number): number | null {
  const plans = input.pricing.plans;
  const ref = Math.min(input.matrix.plan_index, plans.length - 1);
  const at = (p: number) => cellOf({ ...input, pricing: { ...input.pricing, plans: plans.map((pl, i) => (i === ref ? { ...pl, base_price: p } : pl)) } }, customers).m.net_profit;
  if (at(0) >= target) return 0;
  const top = 100_000;
  if (at(top) < target) return null;
  let lo = 0;
  let hi = top;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi * 100) / 100;
}

/**
 * Break-even report: where the business stops losing money – per price variant (matrix column), plus the optional
 * target ("what do I need for 3 000 € net per month?"). Rounded to cents.
 */
export function breakevenReport(input: CalcInput, customers: number, target?: number) {
  const { columns, inputs } = columnsOf(input);
  const cur = currentColumn(input);
  const econCur = econ(input);
  const unit = unitEcon(input, econCur);
  const fx = fixedCosts(input);
  const forColumn = (col: { label: string; price: number }, i: CalcInput) => {
    const e = econ(i);
    const u = unitEcon(i, e);
    return {
      column: col.label,
      price: col.price,
      contribution_per_customer: u.contribution,
      breakeven_customers: u.breakeven.customers,
      breakeven_customers_net: u.breakeven.customers_net,
      revenue_net_at_breakeven: u.breakeven.revenue_net,
      ...(target !== undefined ? { customers_for_target: customersForNetProfit(i, target) } : {}),
    };
  };
  const b = unit.breakeven;
  const text =
    b.customers === null
      ? 'Bei diesen Preisen deckt kein Kunde seine eigenen Kosten – ein Break-even gibt es nicht. Preis erhöhen oder variable Kosten senken.'
      : `Break-even vor Steuern ab ${b.customers} ${b.customers === 1 ? 'Kunde' : 'Kunden'}${b.customers_net !== null && b.customers_net !== b.customers ? `, nach Steuern und Vorsorge ab ${b.customers_net}` : ''} (Umsatz netto ${b.revenue_net === null ? '–' : eur(Math.round(b.revenue_net))} pro Monat bei Fixkosten von ${eur(Math.round(fx.total))}).`;
  return rounded({
    disclaimer: DISCLAIMER,
    headline: `${text} ${DISCLAIMER}.`,
    fixed_costs_per_month: fx.total,
    current: {
      column: cur.label,
      price: cur.price,
      contribution_per_customer: unit.contribution,
      breakeven_customers: b.customers,
      breakeven_customers_net: b.customers_net,
      revenue_net_at_breakeven: b.revenue_net,
      ltv: unit.ltv,
      cac: unit.cac,
      ltv_cac: unit.ltv_cac,
      payback_months: unit.payback_months,
      min_price_for_ebit_zero: { customers, price: minPrice(input, customers) },
      ...(target !== undefined ? { target_net_profit_month: target, customers_for_target: customersForNetProfit(input, target), price_for_target: { customers, price: priceForNetProfit(input, customers, target) } } : {}),
    },
    by_column: columns.map((c, i) => forColumn(c, inputs[i])),
    assumptions: assumptions(input),
  });
}
