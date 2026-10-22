/**
 * Gewinnrechner engine: "What do I earn at which price and how many customers, after all costs, fees and taxes?"
 *
 * Pure functions on a plain JSON input (calc-spec.ts: defaults, JSON Schema, validation). No database, no I/O, no
 * dependencies on the rest of the app – the same file runs on the server (REST, MCP, scenarios) and in the browser
 * (instant recalculation), and can be packaged as a plugin for the Werkstatt/Marktplatz later.
 *
 * Model in one paragraph: a *cell* is one steady-state month with N active customers at one price variant. Customers
 * are spread over plans (Staffeln, Agentur-Stufen, Standort-Modell …) by a mix; each plan has a flat price, included
 * units, a step price and a cap, applied to a distribution of units per customer. Revenue is net; USt is added per
 * customer segment (Inland, EU B2B reverse charge, EU B2C one-stop-shop) – payment fees fall on the *gross* charge.
 * Costs: variable per customer/user/unit, fixed per month, CAC for the customers that replace the churn. Taxes are
 * computed on the yearly profit (12 × the month) by legal form (calc-tax.ts). Estimates, not tax advice.
 */
import { estGrundtarif, taxCorp, taxEinzel, type CorpTaxParams, type PersonalTaxParams, type TaxBreakdown } from './calc-tax.js';
import { CalcInputError, DISCLAIMER, defaultInput, expandTaxYear, inputSchema, mergeInput, normalizeInput, specMarkdown, specRows, type CalcInput, type CalcPlan } from './calc-spec.js';

export { CalcInputError, DISCLAIMER, defaultInput, inputSchema, mergeInput, normalizeInput, specMarkdown, specRows };
export type { CalcInput, CalcPlan, TaxBreakdown };
export { estGrundtarif };

// --- small helpers --------------------------------------------------------------------------------------------------

const pos = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** 49 → "49 €", 12.5 → "12,50 €" */
export const eur = (v: number) => `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v)} €`;

/** Weights from percentages: scaled to 1; all zero → equal weights. */
function weights(shares: number[]): number[] {
  const s = sum(shares.map(pos));
  if (s <= 0) return shares.map(() => (shares.length ? 1 / shares.length : 0));
  return shares.map((x) => pos(x) / s);
}

// --- unit economics per customer ------------------------------------------------------------------------------------

/** Average monthly values of one active customer (blended over plans, units and VAT segments) and of one new customer. */
export interface Econ {
  revenue_net: number;
  vat: number;
  revenue_gross: number;
  fees: number;
  referral: number;
  app_store: number;
  hosting: number;
  ai: number;
  messaging: number;
  support: number;
  other: number;
  variable: number;
  contribution: number;
  /** One-time per new customer. */
  setup_net: number;
  setup_vat: number;
  setup_fees: number;
  /** Blended averages for display. */
  units: number;
  users: number;
  list_price: number;
}

interface UnitPoint {
  units: number;
  share: number;
}
function unitPoints(input: CalcInput, plan: CalcPlan): UnitPoint[] {
  if (plan.avg_units > 0) return [{ units: plan.avg_units, share: 1 }];
  const mix = input.customers.unit_mix.filter((u) => u.share > 0);
  if (!mix.length) return [{ units: input.customers.avg_units, share: 1 }];
  const w = weights(mix.map((m) => m.share));
  return mix.map((m, i) => ({ units: m.units, share: w[i] }));
}

/** List price per month (as entered, before the net/gross conversion) of a plan for a number of units. */
export function planPrice(plan: CalcPlan, units: number): number {
  const p = plan.base_price + Math.max(0, units - plan.included_units) * plan.unit_price;
  return plan.cap > 0 ? Math.min(plan.cap, p) : p;
}

function vatSegments(input: CalcInput): { w: number; rate: number }[] {
  const eu = Math.min(1, pos(input.customers.eu_share) / 100);
  const b2b = Math.min(1, pos(input.customers.b2b_share) / 100);
  if (input.vat.kleinunternehmer) return [{ w: 1, rate: 0 }];
  return [
    { w: 1 - eu, rate: input.vat.rate / 100 },
    // Reverse charge: the customer accounts for the VAT, we charge none.
    { w: eu * b2b, rate: 0 },
    // One-stop-shop: VAT of the customer's country.
    { w: eu * (1 - b2b), rate: input.vat.eu_b2c_rate / 100 },
  ].filter((s) => s.w > 0);
}

/** Fee of the payment provider for one charge of `gross` euros, blended over the payment methods. */
function chargeFee(input: CalcInput, gross: number): number {
  if (gross <= 0) return 0;
  const ms = input.costs.variable.payment.methods;
  if (!ms.length) return 0;
  const w = weights(ms.map((m) => m.share));
  return sum(ms.map((m, i) => w[i] * (m.cap > 0 ? Math.min(m.cap, (m.pct / 100) * gross + m.fixed) : (m.pct / 100) * gross + m.fixed)));
}

const ZERO_ECON: Econ = { revenue_net: 0, vat: 0, revenue_gross: 0, fees: 0, referral: 0, app_store: 0, hosting: 0, ai: 0, messaging: 0, support: 0, other: 0, variable: 0, contribution: 0, setup_net: 0, setup_vat: 0, setup_fees: 0, units: 0, users: 0, list_price: 0 };

/** Costs that carry input VAT are grossed up for Kleinunternehmer (no Vorsteuer deduction). */
const inputVatFactor = (input: CalcInput) => (input.vat.kleinunternehmer ? 1 + input.vat.input_rate / 100 : 1);

export function econ(input: CalcInput): Econ {
  const out: Econ = { ...ZERO_ECON };
  const klein = input.vat.kleinunternehmer;
  const vr = input.vat.rate / 100;
  const toNet = (v: number) => (input.pricing.price_basis === 'gross' && !klein ? v / (1 + vr) : v);
  const a = pos(input.pricing.annual.share) / 100;
  const d = pos(input.pricing.annual.discount) / 100;
  const store = pos(input.costs.variable.app_store.share) / 100;
  const v = input.costs.variable;
  const iv = inputVatFactor(input);
  const planW = weights(input.pricing.plans.map((p) => p.mix));
  const segs = vatSegments(input);
  input.pricing.plans.forEach((plan, pi) => {
    for (const pt of unitPoints(input, plan)) {
      const list = toNet(planPrice(plan, pt.units));
      const addons = sum(input.pricing.addons.map((x) => toNet(x.price) * (pos(x.take_rate) / 100) * (x.per_unit ? pt.units : 1)));
      const rec0 = list + addons;
      const setup = toNet(plan.setup_fee);
      for (const seg of segs) {
        const w = planW[pi] * pt.share * seg.w;
        if (w <= 0) continue;
        const rev = rec0 * (1 - a * d);
        const gm = rec0 * (1 + seg.rate);
        // Monthly payers are charged every month, annual payers once a year for twelve discounted months.
        const fee = ((1 - a) * chargeFee(input, gm) + a * (chargeFee(input, 12 * gm * (1 - d)) / 12)) * (1 - store);
        const hosting = (v.hosting.per_customer + v.hosting.per_user * plan.users + v.hosting.per_unit * pt.units) * iv;
        const ai = (v.ai.per_customer + v.ai.per_user * plan.users + v.ai.per_unit * pt.units) * iv;
        const messaging = (v.messaging.per_customer + v.messaging.per_user * plan.users + v.messaging.per_unit * pt.units) * iv;
        const support = (v.support.minutes_per_customer / 60) * v.support.hourly_rate;
        const other = (v.other.per_customer + plan.extra_cost) * iv + (v.other.pct_of_revenue / 100) * rev;
        const referral = rev * (v.referral.commission_pct / 100) * (pos(v.referral.share) / 100);
        const app = rev * (v.app_store.fee_pct / 100) * store;
        out.revenue_net += w * rev;
        out.vat += w * rev * seg.rate;
        out.fees += w * fee;
        out.referral += w * referral;
        out.app_store += w * app;
        out.hosting += w * hosting;
        out.ai += w * ai;
        out.messaging += w * messaging;
        out.support += w * support;
        out.other += w * other;
        out.setup_net += w * setup;
        out.setup_vat += w * setup * seg.rate;
        out.setup_fees += w * (setup > 0 ? chargeFee(input, setup * (1 + seg.rate)) * (1 - store) : 0);
        out.units += w * pt.units;
        out.users += w * plan.users;
        out.list_price += w * list;
      }
    }
  });
  out.revenue_gross = out.revenue_net + out.vat;
  out.variable = out.fees + out.referral + out.app_store + out.hosting + out.ai + out.messaging + out.support + out.other;
  out.contribution = out.revenue_net - out.variable;
  return out;
}

// --- cells -----------------------------------------------------------------------------------------------------------

/** Monthly (or yearly) lines of the profit and loss account; costs are positive numbers. */
export interface Lines {
  revenue_gross: number;
  vat: number;
  revenue_net: number;
  fees: number;
  referral: number;
  app_store: number;
  hosting: number;
  ai: number;
  messaging: number;
  support: number;
  other: number;
  variable: number;
  contribution: number;
  fixed_servers_tools: number;
  fixed_salaries: number;
  fixed_insurance: number;
  fixed_marketing: number;
  fixed_other: number;
  fixed: number;
  cac: number;
  ebit: number;
  tax: number;
  vorsorge: number;
  net_profit: number;
}

export interface Cell {
  customers: number;
  /** Customers that replace the churn in this steady-state month. */
  new_customers: number;
  m: Lines;
  y: Lines;
  /** Yearly tax detail. */
  tax: TaxBreakdown;
  /** Net profit in percent of the net revenue (null without revenue). */
  margin: number | null;
  ebit_margin: number | null;
  contribution_margin: number | null;
}

const ZERO_TAX: TaxBreakdown = { zve: 0, est: 0, soli: 0, church: 0, gewst: 0, s35: 0, kst: 0, dividend_tax: 0, total: 0, rate_pct: 0 };

/** Monthly fixed costs by line (net, grossed up for Kleinunternehmer where input VAT applies). */
export function fixedCosts(input: CalcInput) {
  const f = input.costs.fixed;
  const iv = inputVatFactor(input);
  const servers_tools = f.servers_tools * iv;
  const salaries = f.salaries;
  const insurance = f.insurance;
  const marketing = f.marketing * iv;
  const other = f.other * iv;
  return { servers_tools, salaries, insurance, marketing, other, total: servers_tools + salaries + insurance + marketing + other };
}
/** CAC per new customer (marketing spend: carries input VAT). */
export const cacCost = (input: CalcInput) => input.costs.cac * inputVatFactor(input);

/** Taxes on a yearly profit for the chosen legal form. */
export function taxOf(input: CalcInput, ebitYear: number): TaxBreakdown {
  const t = input.tax;
  if (t.legal_form === 'keine' || !(ebitYear > 0)) return { ...ZERO_TAX };
  const gew = { enabled: t.gewerbesteuer.enabled, hebesatz: t.gewerbesteuer.hebesatz, messzahl: t.gewerbesteuer.messzahl, freibetrag: t.gewerbesteuer.freibetrag, hinzurechnung: t.gewerbesteuer.hinzurechnung, s35_factor: t.gewerbesteuer.s35_factor };
  if (t.legal_form === 'kapitalgesellschaft') {
    const p: CorpTaxParams = { kst_rate: t.kst.rate, soli_rate: t.kst.soli_rate, gewst: gew, distribution_pct: t.kst.distribution_pct, dividend_rate: t.kst.dividend_rate };
    return taxCorp(ebitYear, p);
  }
  const p: PersonalTaxParams = { est: t.est, soli: t.soli, church_enabled: t.church.enabled, church_rate: t.church.rate, joint: t.joint, other_income: t.other_income, deductions: t.deductions, gewst: gew, vorsorge: t.vorsorge_monat * 12 };
  return taxEinzel(ebitYear, p);
}

const vorsorgeMonth = (input: CalcInput) => (input.tax.legal_form === 'einzelunternehmen' ? input.tax.vorsorge_monat : 0);

const ratio = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);

/** One steady-state month with `customers` active customers. */
export function cellOf(input: CalcInput, customers: number, e: Econ = econ(input)): Cell {
  const n = pos(customers);
  const newC = n * (pos(input.customers.churn) / 100);
  const fx = fixedCosts(input);
  const cac = newC * cacCost(input);
  const revenue_net = n * e.revenue_net + newC * e.setup_net;
  const vat = n * e.vat + newC * e.setup_vat;
  const fees = n * e.fees + newC * e.setup_fees;
  const variable = fees + n * (e.referral + e.app_store + e.hosting + e.ai + e.messaging + e.support + e.other);
  const contribution = revenue_net - variable;
  const ebit = contribution - fx.total - cac;
  const tax = taxOf(input, ebit * 12);
  const vorsorge = vorsorgeMonth(input);
  const m: Lines = {
    revenue_gross: revenue_net + vat,
    vat,
    revenue_net,
    fees,
    referral: n * e.referral,
    app_store: n * e.app_store,
    hosting: n * e.hosting,
    ai: n * e.ai,
    messaging: n * e.messaging,
    support: n * e.support,
    other: n * e.other,
    variable,
    contribution,
    fixed_servers_tools: fx.servers_tools,
    fixed_salaries: fx.salaries,
    fixed_insurance: fx.insurance,
    fixed_marketing: fx.marketing,
    fixed_other: fx.other,
    fixed: fx.total,
    cac,
    ebit,
    tax: tax.total / 12,
    vorsorge,
    net_profit: ebit - tax.total / 12 - vorsorge,
  };
  const y = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v * 12])) as unknown as Lines;
  return { customers: n, new_customers: newC, m, y, tax, margin: ratio(m.net_profit, revenue_net), ebit_margin: ratio(ebit, revenue_net), contribution_margin: ratio(contribution, revenue_net) };
}

// --- columns (price variants) ---------------------------------------------------------------------------------------

export interface Column {
  key: string;
  label: string;
  /** Base price per month of the reference plan in this column. */
  price: number;
  factor?: number;
  plan?: number;
}

function scalePlan(p: CalcPlan, f: number): CalcPlan {
  return { ...p, base_price: p.base_price * f, unit_price: p.unit_price * f, cap: p.cap * f, setup_fee: p.setup_fee * f };
}

/** The columns of the matrix and the input each one calculates with. `current` is the input as configured. */
export function columnsOf(input: CalcInput): { columns: Column[]; inputs: CalcInput[] } {
  const m = input.matrix;
  const plans = input.pricing.plans;
  const ref = Math.min(m.plan_index, plans.length - 1);
  const withPlans = (pl: CalcPlan[], addonFactor = 1): CalcInput => ({ ...input, pricing: { ...input.pricing, plans: pl, addons: addonFactor === 1 ? input.pricing.addons : input.pricing.addons.map((a) => ({ ...a, price: a.price * addonFactor })) } });
  if (m.columns === 'plan') {
    const columns = plans.map((p, i): Column => ({ key: `plan-${i}`, label: p.name || `Tarif ${i + 1}`, price: p.base_price, plan: i }));
    return { columns, inputs: plans.map((p) => withPlans([{ ...p, mix: 100 }])) };
  }
  if (m.columns === 'factor') {
    const r = plans[ref];
    // Besides the percentage, show what it means for the reference plan: base price, else step price, else setup fee.
    const hint = (f: number) => (r.base_price > 0 ? eur(r.base_price * f) : r.unit_price > 0 ? `${eur(r.unit_price * f)}/Einheit` : r.setup_fee > 0 ? `${eur(r.setup_fee * f)} einmalig` : '');
    const columns = m.factors.map((f, i): Column => {
      const pct = `${Math.round(f * 1000) / 10}`.replace('.', ',');
      const label = plans.length === 1 && hint(f) ? `${pct} % (${hint(f)})` : f === 1 ? '100 % (aktuell)' : `${pct} %`;
      return { key: `factor-${i}`, label, price: r.base_price * f, factor: f };
    });
    return { columns, inputs: m.factors.map((f) => withPlans(plans.map((p) => scalePlan(p, f)), f)) };
  }
  const columns = m.prices.map((p, i): Column => ({ key: `price-${i}`, label: eur(p), price: p }));
  return { columns, inputs: m.prices.map((p) => withPlans(plans.map((pl, i) => (i === ref ? { ...pl, base_price: p } : pl)))) };
}

/** The input as configured (the column "Aktuell"). */
export function currentColumn(input: CalcInput): Column {
  const ref = Math.min(input.matrix.plan_index, input.pricing.plans.length - 1);
  const plans = input.pricing.plans;
  const single = plans.length === 1;
  return { key: 'current', label: single ? eur(plans[ref].base_price) : 'Aktuelle Preise', price: plans[ref].base_price };
}

// --- unit economics, break-even ---------------------------------------------------------------------------------------

export interface Breakeven {
  /** Smallest number of customers with EBIT ≥ 0 (null: never at these prices). */
  customers: number | null;
  /** Smallest number of customers with net profit ≥ 0 after taxes and Vorsorge. */
  customers_net: number | null;
  /** Net revenue per month at the EBIT break-even. */
  revenue_net: number | null;
}

export interface UnitEcon {
  /** Recurring net revenue per customer and month. */
  arpu_net: number;
  /** Net revenue per customer in a steady-state month including the setup fees of the customers that replace the churn. */
  revenue_per_customer: number;
  arpu_gross: number;
  /** Contribution per customer and month after all variable costs and fees. */
  contribution: number;
  contribution_margin: number | null;
  setup_net: number;
  lifetime_months: number;
  ltv: number;
  cac: number;
  ltv_cac: number | null;
  /** Months until a new customer has paid back the CAC (null: never). */
  payback_months: number | null;
  units: number;
  users: number;
  breakeven: Breakeven;
}

const ebitAt = (input: CalcInput, e: Econ, n: number) => cellOf(input, n, e).m.ebit;

export function breakeven(input: CalcInput, e: Econ = econ(input)): Breakeven {
  // EBIT is linear in the customers (everything per customer, fixed costs constant): EBIT(N) = a·N − F.
  const f = -ebitAt(input, e, 0);
  const a = (ebitAt(input, e, 1000) - ebitAt(input, e, 0)) / 1000;
  let customers: number | null = null;
  if (f <= 0) customers = 0;
  else if (a > 1e-9) customers = Math.ceil(f / a - 1e-9);
  // After taxes and Vorsorge: net profit grows with the customers, find the first N by bisection.
  const net = (n: number) => cellOf(input, n, e).m.net_profit;
  let customersNet: number | null = null;
  if (net(0) >= 0) customersNet = 0;
  else if (net(1e8) >= 0) {
    let lo = 0;
    let hi = 1e8;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (net(mid) >= 0) hi = mid;
      else lo = mid;
    }
    customersNet = hi;
  }
  const rev = customers === null ? null : cellOf(input, customers, e).m.revenue_net;
  return { customers, customers_net: customersNet, revenue_net: rev };
}

export function unitEcon(input: CalcInput, e: Econ = econ(input)): UnitEcon {
  const contribution = e.contribution;
  const churn = pos(input.customers.churn) / 100;
  const cap = input.customers.max_lifetime_months;
  const lifetime = churn > 0 ? Math.min(1 / churn, cap) : cap;
  const setupNet = e.setup_net - e.setup_fees;
  const ltv = contribution * lifetime + setupNet;
  const cac = cacCost(input);
  return {
    arpu_net: e.revenue_net,
    revenue_per_customer: e.revenue_net + churn * e.setup_net,
    arpu_gross: e.revenue_gross,
    contribution,
    contribution_margin: ratio(contribution, e.revenue_net),
    setup_net: e.setup_net,
    lifetime_months: lifetime,
    ltv,
    cac,
    ltv_cac: cac > 0 ? ltv / cac : null,
    payback_months: cac <= 0 ? 0 : contribution > 0 ? Math.max(0, (cac - setupNet) / contribution) : null,
    units: e.units,
    users: e.users,
    breakeven: breakeven(input, e),
  };
}

/** Lowest base price of the reference plan at which `customers` customers reach EBIT ≥ 0 (null: not within 100 000 € per month). */
export function minPrice(input: CalcInput, customers: number): number | null {
  const ref = Math.min(input.matrix.plan_index, input.pricing.plans.length - 1);
  const at = (p: number) => {
    const v: CalcInput = { ...input, pricing: { ...input.pricing, plans: input.pricing.plans.map((pl, i) => (i === ref ? { ...pl, base_price: p } : pl)) } };
    return cellOf(v, customers).m.ebit;
  };
  if (at(0) >= 0) return 0;
  let hi = 100_000;
  if (at(hi) < 0) return null;
  let lo = 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi * 100) / 100;
}

// --- projection ------------------------------------------------------------------------------------------------------

export interface Month {
  t: number;
  customers: number;
  new_customers: number;
  revenue_net: number;
  /** Recurring net revenue of the month (without setup fees). */
  mrr: number;
  ebit: number;
  tax: number;
  net_profit: number;
  cum_net: number;
}
export interface Horizon {
  months: number;
  customers: number;
  mrr: number;
  arr: number;
  revenue_net: number;
  ebit: number;
  tax: number;
  net_profit: number;
}
export interface Projection {
  months: Month[];
  horizons: Horizon[];
  /** First month in which the cumulative net profit (after the one-time investment) is ≥ 0. */
  breakeven_month: number | null;
  /** First month with EBIT ≥ 0. */
  ebit_positive_month: number | null;
}

/** Churn-adjusted development: customers(t) = customers(t−1)·(1 − churn) + new(t); billed on the customers at the end of the month. */
export function projection(input: CalcInput, e: Econ = econ(input)): Projection {
  const g = input.customers.growth;
  const H = Math.max(1, Math.min(120, g.months));
  const churn = pos(input.customers.churn) / 100;
  const fx = fixedCosts(input);
  const cac = cacCost(input);
  const vorsorge = vorsorgeMonth(input);
  const rows: { t: number; customers: number; newC: number; rev: number; mrr: number; ebit: number }[] = [];
  let c = pos(g.start);
  for (let t = 1; t <= H; t++) {
    const newC = pos(g.monthly_new) * Math.pow(1 + g.monthly_new_growth / 100, t - 1);
    c = c * (1 - churn) + newC;
    const rev = c * e.revenue_net + newC * e.setup_net;
    const variable = c * e.variable + newC * e.setup_fees;
    const ebit = rev - variable - fx.total - newC * cac - (t === 1 ? input.costs.fixed.one_time : 0);
    rows.push({ t, customers: c, newC, rev, mrr: c * e.revenue_net, ebit });
  }
  // Taxes per fiscal year of 12 months (the last one annualised) spread evenly over its months.
  const taxes: number[] = [];
  for (let start = 0; start < H; start += 12) {
    const slice = rows.slice(start, start + 12);
    const total = sum(slice.map((r) => r.ebit));
    const tax = (taxOf(input, (total * 12) / slice.length).total * slice.length) / 12;
    for (let i = 0; i < slice.length; i++) taxes.push(tax / slice.length);
  }
  let cum = 0;
  let ebitPositive: number | null = null;
  const months = rows.map((r, i): Month => {
    const net = r.ebit - taxes[i] - vorsorge;
    cum += net;
    if (ebitPositive === null && r.ebit >= 0) ebitPositive = r.t;
    return { t: r.t, customers: r.customers, new_customers: r.newC, revenue_net: r.rev, mrr: r.mrr, ebit: r.ebit, tax: taxes[i], net_profit: net, cum_net: cum };
  });
  // Break-even: the month after which the cumulative net profit (incl. the one-time investment) stays ≥ 0.
  let lastNegative = -1;
  months.forEach((m, i) => m.cum_net < 0 && (lastNegative = i));
  const breakevenMonth = lastNegative === months.length - 1 ? null : lastNegative + 2;
  const horizons = [12, 24, 36]
    .filter((h) => h <= H)
    .map((h): Horizon => {
      const part = months.slice(0, h);
      const last = part[part.length - 1];
      return { months: h, customers: last.customers, mrr: last.mrr, arr: last.mrr * 12, revenue_net: sum(part.map((x) => x.revenue_net)), ebit: sum(part.map((x) => x.ebit)), tax: sum(part.map((x) => x.tax)), net_profit: sum(part.map((x) => x.net_profit)) };
    });
  return { months, horizons, breakeven_month: breakevenMonth, ebit_positive_month: ebitPositive };
}

// --- waterfall ---------------------------------------------------------------------------------------------------------

export interface Step {
  key: string;
  label: string;
  /** Signed amount: costs are negative; totals/subtotals are the running total. */
  value: number;
  kind: 'total' | 'delta' | 'subtotal';
}

/** Revenue → USt → fees → variable → fixed → taxes → net, as steps for a waterfall chart (per month or year). */
export function waterfall(cell: Cell, period: 'month' | 'year' = 'month'): Step[] {
  const l = period === 'year' ? cell.y : cell.m;
  const k = period === 'year' ? 1 : 1 / 12;
  const t = cell.tax;
  const steps: Step[] = [];
  const total = (key: string, label: string, value: number) => steps.push({ key, label, value, kind: 'total' });
  const sub = (key: string, label: string, value: number) => steps.push({ key, label, value, kind: 'subtotal' });
  const cost = (key: string, label: string, value: number) => {
    if (Math.abs(value) > 1e-9) steps.push({ key, label, value: -value, kind: 'delta' });
  };
  total('revenue_gross', 'Kundenzahlungen (brutto)', l.revenue_gross);
  cost('vat', 'Umsatzsteuer', l.vat);
  sub('revenue_net', 'Netto-Umsatz', l.revenue_net);
  cost('fees', 'Zahlungsgebühren', l.fees);
  cost('referral', 'Partner-Provision', l.referral);
  cost('app_store', 'App-Store-Gebühr', l.app_store);
  cost('hosting', 'Hosting', l.hosting);
  cost('ai', 'KI-Token', l.ai);
  cost('messaging', 'E-Mail/SMS', l.messaging);
  cost('support', 'Support & Betreuung', l.support);
  cost('other', 'Sonstige variable Kosten', l.other);
  sub('contribution', 'Nach variablen Kosten', l.contribution);
  cost('fixed_servers_tools', 'Server & Tools', l.fixed_servers_tools);
  cost('fixed_salaries', 'Gehälter', l.fixed_salaries);
  cost('fixed_insurance', 'Versicherungen', l.fixed_insurance);
  cost('fixed_marketing', 'Marketing', l.fixed_marketing);
  cost('fixed_other', 'Sonstige Fixkosten', l.fixed_other);
  cost('cac', 'Kundengewinnung (CAC)', l.cac);
  sub('ebit', 'EBIT (vor Steuern)', l.ebit);
  cost('tax_est', 'Einkommensteuer', t.est * k);
  cost('tax_soli', 'Solidaritätszuschlag', t.soli * k);
  cost('tax_church', 'Kirchensteuer', t.church * k);
  cost('tax_kst', 'Körperschaftsteuer', t.kst * k);
  cost('tax_gewst', 'Gewerbesteuer', t.gewst * k);
  cost('tax_dividend', 'Steuer auf Ausschüttung', t.dividend_tax * k);
  cost('vorsorge', 'Vorsorge (Kranken-/Rentenversicherung)', l.vorsorge);
  sub('net_profit', 'Nettogewinn', l.net_profit);
  return steps;
}

// --- sensitivity (tornado) ---------------------------------------------------------------------------------------------

export interface TornadoBar {
  key: string;
  label: string;
  /** Net profit per year with the input decreased / increased by `pct`. */
  low: number;
  high: number;
  swing: number;
}
export interface Tornado {
  pct: number;
  base: number;
  bars: TornadoBar[];
}

const eachLine = (c: { per_customer: number; per_user: number; per_unit: number }, f: number) => {
  c.per_customer *= f;
  c.per_user *= f;
  c.per_unit *= f;
};

const LEVERS: { key: string; label: string; apply: (i: CalcInput, f: number) => void }[] = [
  {
    key: 'price',
    label: 'Preise',
    apply: (i, f) => {
      i.pricing.plans.forEach((p) => Object.assign(p, scalePlan(p, f)));
      i.pricing.addons.forEach((a) => (a.price *= f));
    },
  },
  { key: 'churn', label: 'Kündigungsquote', apply: (i, f) => (i.customers.churn = Math.min(100, i.customers.churn * f)) },
  {
    key: 'units',
    label: 'Einheiten je Kunde',
    apply: (i, f) => {
      i.customers.avg_units *= f;
      i.customers.unit_mix.forEach((u) => (u.units *= f));
      i.pricing.plans.forEach((p) => (p.avg_units *= f));
    },
  },
  { key: 'addons', label: 'Add-on-Buchungen', apply: (i, f) => i.pricing.addons.forEach((a) => (a.take_rate = Math.min(100, a.take_rate * f))) },
  {
    key: 'payment',
    label: 'Zahlungsgebühren',
    apply: (i, f) =>
      i.costs.variable.payment.methods.forEach((m) => {
        m.pct *= f;
        m.fixed *= f;
        m.cap *= f;
      }),
  },
  { key: 'hosting', label: 'Hosting', apply: (i, f) => eachLine(i.costs.variable.hosting, f) },
  { key: 'ai', label: 'KI-Token', apply: (i, f) => eachLine(i.costs.variable.ai, f) },
  { key: 'messaging', label: 'E-Mail/SMS', apply: (i, f) => eachLine(i.costs.variable.messaging, f) },
  { key: 'support', label: 'Support-Aufwand', apply: (i, f) => (i.costs.variable.support.minutes_per_customer *= f) },
  { key: 'referral', label: 'Partner-Provision', apply: (i, f) => (i.costs.variable.referral.commission_pct = Math.min(100, i.costs.variable.referral.commission_pct * f)) },
  { key: 'cac', label: 'Kosten je Neukunde (CAC)', apply: (i, f) => (i.costs.cac *= f) },
  {
    key: 'fixed',
    label: 'Fixkosten',
    apply: (i, f) => {
      const fx = i.costs.fixed;
      fx.servers_tools *= f;
      fx.salaries *= f;
      fx.insurance *= f;
      fx.marketing *= f;
      fx.other *= f;
    },
  },
];

/** Which input moves the yearly net profit most? Every lever is varied by ±pct (plus the customer count) for the given cell. */
export function sensitivity(input: CalcInput, customers: number, pct = input.matrix.sensitivity_pct): Tornado {
  const p = Math.min(90, Math.max(1, pct)) / 100;
  const net = (i: CalcInput, n: number) => cellOf(i, n).y.net_profit;
  const base = net(input, customers);
  const bars: TornadoBar[] = [{ key: 'customers', label: 'Kundenzahl', low: net(input, customers * (1 - p)), high: net(input, customers * (1 + p)), swing: 0 }];
  for (const lever of LEVERS) {
    const at = (f: number) => {
      const i = clone(input);
      lever.apply(i, f);
      return net(i, customers);
    };
    bars.push({ key: lever.key, label: lever.label, low: at(1 - p), high: at(1 + p), swing: 0 });
  }
  for (const b of bars) b.swing = Math.abs(b.high - b.low);
  return { pct: p * 100, base, bars: bars.filter((b) => b.swing > 0.005).sort((a, b) => b.swing - a.swing) };
}

// --- run ---------------------------------------------------------------------------------------------------------------

export interface Detail {
  customers: number;
  column: Column;
  cell: Cell;
  unit: UnitEcon;
  waterfall: Step[];
  projection: Projection;
  sensitivity?: Tornado;
  min_price: number | null;
}

export interface RunResult {
  version: 1;
  disclaimer: string;
  warnings: string[];
  rows: number[];
  columns: Column[];
  /** matrix[row][column] */
  matrix: Cell[][];
  /** Unit economics and break-even per column. */
  unit: UnitEcon[];
  /** The cell asked for: `customers.count` at the configured prices (or the chosen one). */
  focus: Detail;
}

export interface RunOptions {
  /** Customers of the focus cell (default `customers.count`). */
  customers?: number;
  /** Column of the matrix whose prices the focus cell uses; default (or -1) = the prices as configured. */
  column?: number;
  /** Add the tornado analysis to the focus. */
  sensitivity?: boolean;
}

function warningsOf(input: CalcInput, focus: Cell): string[] {
  const w: string[] = [];
  const mix = sum(input.pricing.plans.map((p) => p.mix));
  if (Math.abs(mix - 100) > 0.5) w.push(`Der Kunden-Mix der Tarife ergibt ${Math.round(mix * 10) / 10} % – er wird auf 100 % hochgerechnet.`);
  const um = sum(input.customers.unit_mix.map((u) => u.share));
  if (input.customers.unit_mix.length && Math.abs(um - 100) > 0.5) w.push(`Die Verteilung der Einheiten ergibt ${Math.round(um * 10) / 10} % – sie wird auf 100 % hochgerechnet.`);
  const pm = sum(input.costs.variable.payment.methods.map((m) => m.share));
  if (input.costs.variable.payment.methods.length && Math.abs(pm - 100) > 0.5) w.push(`Die Zahlungsarten ergeben ${Math.round(pm * 10) / 10} % – sie werden auf 100 % hochgerechnet.`);
  if (input.vat.kleinunternehmer) {
    if (focus.y.revenue_net > 100_000) w.push('Kleinunternehmer: über 100.000 € Jahresumsatz endet die Kleinunternehmerregelung sofort (§ 19 UStG).');
    else if (focus.y.revenue_net > 25_000) w.push('Kleinunternehmer: über 25.000 € Jahresumsatz entfällt die Kleinunternehmerregelung im Folgejahr (§ 19 UStG).');
  }
  if (input.tax.legal_form === 'kapitalgesellschaft' && input.costs.fixed.salaries === 0) w.push('GmbH/UG: ein Geschäftsführer-Gehalt fehlt in den Fixkosten (Gehälter) – es mindert den Gewinn und wird privat versteuert.');
  if (input.tax.legal_form === 'einzelunternehmen' && input.tax.vorsorge_monat === 0 && focus.y.ebit > 20_000) w.push('Einzelunternehmen: ohne Kranken-/Rentenversicherung (Vorsorge) ist der Nettogewinn zu hoch eingeschätzt.');
  return w;
}

/** Everything for one cell: unit economics, waterfall, projection and optionally the tornado. */
export function detailOf(input: CalcInput, customers: number, column: number | -1 = -1, withSensitivity = false): Detail {
  const { columns, inputs } = columnsOf(input);
  const idx = column >= 0 && column < columns.length ? column : -1;
  const vi = idx === -1 ? input : inputs[idx];
  const e = econ(vi);
  const cell = cellOf(vi, customers, e);
  return {
    customers: pos(customers),
    column: idx === -1 ? currentColumn(input) : columns[idx],
    cell,
    unit: unitEcon(vi, e),
    waterfall: waterfall(cell),
    projection: projection(vi, e),
    ...(withSensitivity ? { sensitivity: sensitivity(vi, customers, input.matrix.sensitivity_pct) } : {}),
    min_price: minPrice(vi, customers),
  };
}

/** The whole answer: matrix (customers × price variants), unit economics and break-even per column, and the focus cell. */
export function run(raw: CalcInput, opts: RunOptions = {}): RunResult {
  const input = raw;
  const { columns, inputs } = columnsOf(input);
  const econs = inputs.map((i) => econ(i));
  const rows = input.matrix.customers;
  const matrix = rows.map((n) => econs.map((e, ci) => cellOf(inputs[ci], n, e)));
  const unit = econs.map((e, ci) => unitEcon(inputs[ci], e));
  const focus = detailOf(input, opts.customers ?? input.customers.count, opts.column ?? -1, !!opts.sensitivity);
  return { version: 1, disclaimer: DISCLAIMER, warnings: warningsOf(input, focus.cell), rows, columns, matrix, unit, focus };
}

/** Validates a (partial) input over defaults or `base` (e.g. a preset) – the entry point for API, MCP and the UI. */
export function resolveInput(partial: unknown, base?: CalcInput): CalcInput {
  const b = base ?? defaultInput();
  return normalizeInput(mergeInput(b, expandTaxYear(partial ?? {})));
}

// --- text and tables --------------------------------------------------------------------------------------------------

const de = (v: number, digits = 0) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
export const money = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${de(v, digits)} €`);

export type MetricKey = 'revenue_gross' | 'revenue_net' | 'contribution' | 'ebit' | 'net_profit' | 'margin';
export const METRICS: { key: MetricKey; label: string; unit: 'eur' | 'pct' }[] = [
  { key: 'revenue_gross', label: 'Umsatz brutto', unit: 'eur' },
  { key: 'revenue_net', label: 'Umsatz netto', unit: 'eur' },
  { key: 'contribution', label: 'Nach variablen Kosten', unit: 'eur' },
  { key: 'ebit', label: 'EBIT (nach Fixkosten)', unit: 'eur' },
  { key: 'net_profit', label: 'Nettogewinn (nach Steuern)', unit: 'eur' },
  { key: 'margin', label: 'Marge (Nettogewinn in % vom Umsatz)', unit: 'pct' },
];

/** One matrix value; `null` for a margin without revenue. */
export function metricValue(cell: Cell, metric: MetricKey, period: 'month' | 'year'): number | null {
  if (metric === 'margin') return cell.margin;
  return (period === 'year' ? cell.y : cell.m)[metric];
}

/** One sentence answer, e.g. "Bei 300 Kunden zu 49 €: …". */
export function headline(input: CalcInput, d: Detail): string {
  const c = d.cell;
  const price = input.pricing.plans.length === 1 && d.column.price > 0 ? ` zu ${eur(d.column.price)}` : '';
  const be = d.unit.breakeven.customers;
  return `Bei ${de(d.customers)} Kunden${price}: Umsatz netto ${money(c.m.revenue_net)}/Monat (${money(c.y.revenue_net)}/Jahr), nach variablen Kosten ${money(c.m.contribution)}, EBIT ${money(c.m.ebit)}/Monat, Nettogewinn ${money(c.m.net_profit)}/Monat (${money(c.y.net_profit)}/Jahr${c.margin === null ? '' : `, Marge ${de(c.margin, 1)} %`}). Break-even ${be === null ? 'nie bei diesen Preisen' : `ab ${de(be)} ${be === 1 ? 'Kunde' : 'Kunden'}`}. ${DISCLAIMER}.`;
}

/** The matrix as a flat table for CSV export: one row per customers × price variant, values per month and year. */
export function exportRows(r: RunResult): (string | number)[][] {
  const head = ['Kunden', 'Preis', 'Umsatz brutto/Monat', 'USt/Monat', 'Umsatz netto/Monat', 'Variable Kosten/Monat', 'Nach variablen Kosten/Monat', 'Fixkosten/Monat', 'Kundengewinnung/Monat', 'EBIT/Monat', 'Steuern/Monat', 'Vorsorge/Monat', 'Nettogewinn/Monat', 'Umsatz netto/Jahr', 'EBIT/Jahr', 'Steuern/Jahr', 'Nettogewinn/Jahr', 'Marge %'];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const rows: (string | number)[][] = [head];
  r.rows.forEach((n, ri) =>
    r.columns.forEach((col, ci) => {
      const c = r.matrix[ri][ci];
      rows.push([n, col.label, r2(c.m.revenue_gross), r2(c.m.vat), r2(c.m.revenue_net), r2(c.m.variable), r2(c.m.contribution), r2(c.m.fixed), r2(c.m.cac), r2(c.m.ebit), r2(c.m.tax), r2(c.m.vorsorge), r2(c.m.net_profit), r2(c.y.revenue_net), r2(c.y.ebit), r2(c.y.tax), r2(c.y.net_profit), c.margin === null ? '' : r2(c.margin)]);
    }),
  );
  rows.push([], [DISCLAIMER]);
  return rows;
}

/** CSV for German spreadsheets: semicolons, decimal comma, text that looks like a formula gets an apostrophe. */
export function csvDe(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(?:[.,]\d+)?$/.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`;
}

/** Rounds every number in a result to cents (API output). */
export function rounded<T>(v: T, digits = 2): T {
  const f = 10 ** digits;
  const walk = (x: any): any => (typeof x === 'number' ? (Number.isFinite(x) ? Math.round(x * f) / f : null) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
  return walk(v);
}
