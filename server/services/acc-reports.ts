import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { GROUP_LABELS, GROUP_ORDER, type AccKind } from './acc-chart.js';
import { chartMap, getSettings, monthRange, type AccountRow, type Posting } from './acc-ledger.js';
import { TAX_CODES, type TaxCode } from './acc-vat.js';

/**
 * Reports of the light accounting – overviews to prepare the tax advisor's work, not tax returns.
 * - Summen- und Saldenliste and BWA come straight from the double-entry lines (accrual).
 * - EÜR counts income and expenses when the money moved (Zufluss/Abfluss, § 11 EStG): bookings against
 *   receivables/payables count when their payments are booked, in proportion to the amount paid.
 * - The USt-Voranmeldung overview follows the Soll- or Ist-Versteuerung of the settings.
 */

const LIQUID: AccKind[] = ['bank', 'cash', 'transit'];
const CREDIT_DOC: AccKind[] = ['receivable', 'payable'];

/** `fallbackYear`: the year when no period is given – callers pass the sub-account's local year (`todayYmd`), the UTC year is only the last resort. */
export const cleanRange = (from: unknown, to: unknown, fallbackYear = new Date().getUTCFullYear()): { from: string; to: string } => {
  const f = String(from ?? '') || `${fallbackYear}-01-01`;
  const t = String(to ?? '') || `${fallbackYear}-12-31`;
  for (const d of [f, t]) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('Zeitraum: Datum als JJJJ-MM-TT angeben');
  if (f > t) throw bad('Der Zeitraum beginnt nach seinem Ende');
  return { from: f, to: t };
};

/** First day of the fiscal year that contains `date`. */
export function fiscalYearStart(date: string, startMonth: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const sm = Math.min(12, Math.max(1, startMonth || 1));
  return `${m >= sm ? y : y - 1}-${String(sm).padStart(2, '0')}-01`;
}

// --- Summen- und Saldenliste ---------------------------------------------------------------

export interface SusaRow {
  account: string;
  name: string;
  type: string;
  opening_cents: number;
  debit_cents: number;
  credit_cents: number;
  closing_cents: number;
}

/** Signed balance, debit positive. */
export function susa(app: App, locationId: string, from: string, to: string) {
  const settings = getSettings(app, locationId);
  const chart = chartMap(app, locationId);
  const fy = fiscalYearStart(from, settings.fy_start_month);
  const rows = app.db.all<{ account: string; opening_all: number; opening_fy: number; debit: number; credit: number }>(
    `SELECT l.account,
       COALESCE(SUM(CASE WHEN e.date < ? THEN (CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END) END), 0) AS opening_all,
       COALESCE(SUM(CASE WHEN e.date >= ? AND e.date < ? THEN (CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END) END), 0) AS opening_fy,
       COALESCE(SUM(CASE WHEN e.date >= ? AND e.date <= ? AND l.side = 'S' THEN l.cents END), 0) AS debit,
       COALESCE(SUM(CASE WHEN e.date >= ? AND e.date <= ? AND l.side = 'H' THEN l.cents END), 0) AS credit
     FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
     WHERE l.location_id = ? AND e.date <= ? GROUP BY l.account`,
    from, fy, from, from, to, from, to, locationId, to,
  );
  const list: SusaRow[] = rows
    .map((r) => {
      const acc = chart.get(r.account);
      // Balance sheet accounts carry their balance forward; revenue and expense accounts start the fiscal year at zero.
      const pl = acc?.type === 'income' || acc?.type === 'expense';
      const opening = pl ? r.opening_fy : r.opening_all;
      return { account: r.account, name: acc?.name ?? '(Konto gelöscht)', type: acc?.type ?? '', opening_cents: opening, debit_cents: r.debit, credit_cents: r.credit, closing_cents: opening + r.debit - r.credit };
    })
    .filter((r) => r.opening_cents || r.debit_cents || r.credit_cents)
    .sort((a, b) => a.account.localeCompare(b.account));
  const totals = list.reduce((t, r) => ({ debit_cents: t.debit_cents + r.debit_cents, credit_cents: t.credit_cents + r.credit_cents, opening_cents: t.opening_cents + r.opening_cents, closing_cents: t.closing_cents + r.closing_cents }), { debit_cents: 0, credit_cents: 0, opening_cents: 0, closing_cents: 0 });
  return { from, to, rows: list, totals };
}

// --- BWA ----------------------------------------------------------------------------------

export interface BwaGroup {
  group: string;
  label: string;
  type: 'income' | 'expense';
  cents: number;
  accounts: { account: string; name: string; cents: number }[];
  months?: number[];
}

/** Simple BWA: income and expense accounts by group, with the Rohertrag and the Betriebsergebnis. Positive = income resp. cost. */
export function bwa(app: App, locationId: string, from: string, to: string, opts: { months?: boolean } = {}) {
  const chart = chartMap(app, locationId);
  const rows = app.db.all<{ account: string; month: string; net: number }>(
    `SELECT l.account, substr(e.date, 1, 7) AS month, SUM(CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END) AS net
     FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
     WHERE l.location_id = ? AND e.date >= ? AND e.date <= ? GROUP BY l.account, substr(e.date, 1, 7)`,
    locationId, from, to,
  );
  const months = monthRange(from.slice(0, 7), to.slice(0, 7));
  const groups = new Map<string, BwaGroup>();
  for (const r of rows) {
    const acc = chart.get(r.account);
    if (!acc || (acc.type !== 'income' && acc.type !== 'expense')) continue;
    const grp = acc.grp || (acc.type === 'income' ? 'other_income' : 'other_costs');
    const sign = acc.type === 'income' ? -1 : 1; // debit-positive → income/cost positive
    const cents = sign * r.net;
    let g = groups.get(grp);
    if (!g) groups.set(grp, (g = { group: grp, label: GROUP_LABELS[grp] ?? grp, type: acc.type, cents: 0, accounts: [], ...(opts.months ? { months: months.map(() => 0) } : {}) }));
    g.cents += cents;
    let a = g.accounts.find((x) => x.account === r.account);
    if (!a) g.accounts.push((a = { account: r.account, name: acc.name, cents: 0 }));
    a.cents += cents;
    if (g.months) g.months[Math.max(0, months.indexOf(r.month))] += cents;
  }
  const ordered = [...groups.values()].sort((a, b) => (GROUP_ORDER.indexOf(a.group) + 100) % 100 - (GROUP_ORDER.indexOf(b.group) + 100) % 100);
  for (const g of ordered) g.accounts.sort((a, b) => a.account.localeCompare(b.account));
  const sum = (pred: (g: BwaGroup) => boolean, i?: number) => ordered.filter(pred).reduce((n, g) => n + (i === undefined ? g.cents : (g.months?.[i] ?? 0)), 0);
  const calc = (i?: number) => {
    const revenue = sum((g) => g.group === 'revenue', i);
    const cogs = sum((g) => g.group === 'cogs', i);
    const income = sum((g) => g.type === 'income', i);
    const expenses = sum((g) => g.type === 'expense', i);
    return {
      revenue_cents: revenue,
      gross_profit_cents: revenue - cogs,
      operating_income_cents: income - sum((g) => g.group === 'interest_income', i),
      operating_costs_cents: expenses - sum((g) => g.group === 'interest_costs', i),
      result_cents: income - expenses,
    };
  };
  return { from, to, months: opts.months ? months : undefined, groups: ordered, totals: calc(), by_month: opts.months ? months.map((_, i) => calc(i)) : undefined };
}

// --- recognition (EÜR, USt-VA) -------------------------------------------------------------

interface Rec {
  date: string;
  entry_id: string;
  number: string;
  account: string;
  group: string;
  /** 'asset' = purchase of an asset: its tax counts, its net is an investment (no cost until depreciated). */
  type: 'income' | 'expense' | 'asset';
  code: TaxCode;
  net: number;
  tax: number;
}
interface Flow {
  date: string;
  cents: number;
}
export interface Recognized {
  recs: Rec[];
  /** Payments to the tax office (positive) and refunds from it (negative) – bank side. */
  vat_paid: Flow[];
  withdrawals: Flow[];
  deposits: Flow[];
}

/**
 * Income and expenses of all entries up to `to`, dated by `basis`:
 * - accrual: the date of the entry;
 * - cash: the date the money moved. A booking against a receivable/payable counts when payments for the same
 *   document (account + document number) are booked, in proportion to what has been paid.
 */
export function recognize(app: App, locationId: string, to: string, basis: 'accrual' | 'cash'): Recognized {
  const chart = chartMap(app, locationId);
  const out: Recognized = { recs: [], vat_paid: [], withdrawals: [], deposits: [] };
  const entries = app.db.all<{ id: string; number: string; date: string; doc_ref: string; postings: string }>(
    'SELECT id, number, date, doc_ref, postings FROM acc_entries WHERE location_id = ? AND date <= ? ORDER BY date, seq',
    locationId,
    to,
  );
  const docs = new Map<string, { items: Map<string, Rec>; gross: number; events: { date: string; cents: number }[] }>();
  const doc = (key: string) => {
    let d = docs.get(key);
    if (!d) docs.set(key, (d = { items: new Map(), gross: 0, events: [] }));
    return d;
  };
  for (const e of entries) {
    let postings: Posting[] = [];
    try {
      postings = JSON.parse(e.postings);
    } catch {
      continue;
    }
    for (const p of postings) {
      const D = chart.get(p.debit);
      const C = chart.get(p.credit);
      if (!D || !C) continue;
      const taxed = p.taxed_side === 'debit' ? D : C;
      const counter = p.taxed_side === 'debit' ? C : D;
      const counterSide = p.taxed_side === 'debit' ? 'credit' : 'debit';
      const plainAsset = taxed.type === 'asset' && !taxed.kind;
      if (taxed.type === 'income' || taxed.type === 'expense' || plainAsset) {
        const sign = taxed.type === 'income' ? (p.taxed_side === 'credit' ? 1 : -1) : p.taxed_side === 'debit' ? 1 : -1;
        const tmpl: Rec = { date: e.date, entry_id: e.id, number: e.number, account: taxed.number, group: taxed.grp, type: plainAsset ? 'asset' : (taxed.type as 'income' | 'expense'), code: p.tax_code, net: sign * p.net_cents, tax: sign * p.tax_cents };
        if (basis === 'cash' && CREDIT_DOC.includes(counter.kind)) {
          const d = doc(`${counter.number}|${e.doc_ref}`);
          const k = `${tmpl.account}|${tmpl.code}`;
          const cur = d.items.get(k);
          if (cur) (cur.net += tmpl.net, (cur.tax += tmpl.tax));
          else d.items.set(k, tmpl);
          // The receivable/payable grows when it is on the debit (receivable) resp. credit (payable) side.
          const grows = counter.kind === 'receivable' ? counterSide === 'debit' : counterSide === 'credit';
          d.gross += (grows ? 1 : -1) * p.amount_cents;
        } else out.recs.push(tmpl);
        continue;
      }
      // Postings without revenue/expense: payments, tax payments, private moves, investments.
      const liquid = (a: AccountRow) => LIQUID.includes(a.kind);
      if (liquid(D) && CREDIT_DOC.includes(C.kind)) {
        // Bank debited, receivable credited = the customer paid (settles). A payable credited against the bank is a refund (negative).
        doc(`${C.number}|${e.doc_ref}`).events.push({ date: e.date, cents: (C.kind === 'receivable' ? 1 : -1) * p.amount_cents });
      } else if (liquid(C) && CREDIT_DOC.includes(D.kind)) {
        // Payable debited, bank credited = we paid (settles). A receivable debited against the bank is a refund to the customer (negative).
        doc(`${D.number}|${e.doc_ref}`).events.push({ date: e.date, cents: (D.kind === 'payable' ? 1 : -1) * p.amount_cents });
      } else if (D.kind === 'vat_pay' && liquid(C)) out.vat_paid.push({ date: e.date, cents: p.amount_cents });
      else if (C.kind === 'vat_pay' && liquid(D)) out.vat_paid.push({ date: e.date, cents: -p.amount_cents });
      else if (D.kind === 'private' && liquid(C)) out.withdrawals.push({ date: e.date, cents: p.amount_cents });
      else if (C.kind === 'private' && liquid(D)) out.deposits.push({ date: e.date, cents: p.amount_cents });
    }
  }
  if (basis === 'cash') {
    for (const d of docs.values()) {
      if (!d.items.size || d.gross <= 0) continue;
      // A payment counts for the payable/receivable it settles: debit side of a receivable event reduces it, so
      // an event is positive when it settles (the callers push positive cents for both directions of a settlement).
      const events = [...d.events].sort((a, b) => a.date.localeCompare(b.date));
      let paid = 0;
      let before = 0;
      for (const ev of events) {
        paid += ev.cents;
        const frac = Math.min(1, Math.max(0, paid / d.gross));
        for (const t of d.items.values()) {
          const cumNet = Math.round(t.net * frac);
          const cumTax = Math.round(t.tax * frac);
          const prevNet = Math.round(t.net * before);
          const prevTax = Math.round(t.tax * before);
          if (cumNet !== prevNet || cumTax !== prevTax) out.recs.push({ ...t, date: ev.date, net: cumNet - prevNet, tax: cumTax - prevTax });
        }
        before = frac;
      }
    }
  }
  return out;
}

const inRange = (date: string, from: string, to: string) => date >= from && date <= to;
const sumFlows = (f: Flow[], from: string, to: string) => f.filter((x) => inRange(x.date, from, to)).reduce((n, x) => n + x.cents, 0);

// --- EÜR ---------------------------------------------------------------------------------------

export interface EuerGroup {
  group: string;
  label: string;
  net_cents: number;
  accounts: { account: string; name: string; net_cents: number }[];
}

/** Einnahmen-Überschuss-Rechnung overview: income and expenses by group when paid, VAT shown separately. */
export function euer(app: App, locationId: string, from: string, to: string) {
  const settings = getSettings(app, locationId);
  const chart = chartMap(app, locationId);
  const r = recognize(app, locationId, to, 'cash');
  const build = (type: 'income' | 'expense') => {
    const map = new Map<string, EuerGroup>();
    let vat = 0;
    for (const x of r.recs) {
      if (!inRange(x.date, from, to)) continue;
      // The tax on an asset purchase is input tax like any other; its net is an investment, not a cost.
      if (x.type === 'asset') {
        if (type === 'expense' && TAX_CODES[x.code].kind !== 'rc_in') vat += x.tax;
        continue;
      }
      if (x.type !== type) continue;
      const grp = x.group || (type === 'income' ? 'other_income' : 'other_costs');
      let g = map.get(grp);
      if (!g) map.set(grp, (g = { group: grp, label: GROUP_LABELS[grp] ?? grp, net_cents: 0, accounts: [] }));
      g.net_cents += x.net;
      let a = g.accounts.find((y) => y.account === x.account);
      if (!a) g.accounts.push((a = { account: x.account, name: chart.get(x.account)?.name ?? x.account, net_cents: 0 }));
      a.net_cents += x.net;
      // Reverse-charge tax is both owed and deductible – it nets to zero and stays out of the EÜR.
      if (TAX_CODES[x.code].kind !== 'rc_in') vat += x.tax;
    }
    const groups = [...map.values()].filter((g) => g.net_cents || g.accounts.some((a) => a.net_cents)).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    for (const g of groups) g.accounts.sort((a, b) => a.account.localeCompare(b.account));
    return { groups, net_cents: groups.reduce((n, g) => n + g.net_cents, 0), vat_cents: vat };
  };
  const income = build('income');
  const expenses = build('expense');
  const vatPaid = sumFlows(r.vat_paid, from, to);
  const regular = settings.vat_mode === 'regular';
  // Regelbesteuerer: collected VAT is income, deductible input VAT and payments to the tax office are expenses.
  const vatIncome = regular ? income.vat_cents + Math.max(0, -vatPaid) : 0;
  const vatExpense = regular ? expenses.vat_cents + Math.max(0, vatPaid) : 0;
  return {
    basis: 'cash' as const,
    method: 'Zufluss-/Abflussprinzip (§ 11 EStG)',
    from,
    to,
    vat_mode: settings.vat_mode,
    income: { ...income, vat_collected_cents: regular ? income.vat_cents : 0, vat_refunded_cents: regular ? Math.max(0, -vatPaid) : 0, total_cents: income.net_cents + vatIncome },
    expenses: { ...expenses, vat_paid_cents: regular ? expenses.vat_cents : 0, vat_to_tax_office_cents: regular ? Math.max(0, vatPaid) : 0, total_cents: expenses.net_cents + vatExpense },
    profit_cents: income.net_cents + vatIncome - (expenses.net_cents + vatExpense),
    profit_net_cents: income.net_cents - expenses.net_cents,
    private_withdrawals_cents: sumFlows(r.withdrawals, from, to),
    private_deposits_cents: sumFlows(r.deposits, from, to),
    investments_cents: r.recs.filter((x) => x.type === 'asset' && inRange(x.date, from, to)).reduce((n, x) => n + x.net, 0),
  };
}

// --- USt-Voranmeldung -------------------------------------------------------------------------------

export interface VatLine {
  kz: string;
  label: string;
  base_cents?: number;
  tax_cents?: number;
}

/** "2026-03" → March 2026, "2026-Q1" → first quarter, "2026" → the year (YYYY-MM-DD bounds). */
export function vatPeriod(period: string): { from: string; to: string; label: string } {
  let m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (m) {
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${last}`, label: `${m[2]}/${m[1]}` };
  }
  m = /^(\d{4})-Q([1-4])$/.exec(period);
  if (m) {
    const first = (Number(m[2]) - 1) * 3 + 1;
    const lastMonth = first + 2;
    const last = new Date(Date.UTC(Number(m[1]), lastMonth, 0)).getUTCDate();
    return { from: `${m[1]}-${String(first).padStart(2, '0')}-01`, to: `${m[1]}-${String(lastMonth).padStart(2, '0')}-${last}`, label: `${m[2]}. Quartal ${m[1]}` };
  }
  m = /^(\d{4})$/.exec(period);
  if (m) return { from: `${m[1]}-01-01`, to: `${m[1]}-12-31`, label: m[1] };
  throw bad('Zeitraum als JJJJ-MM, JJJJ-Q1 … JJJJ-Q4 oder JJJJ angeben');
}

/**
 * Overview of the Kennzahlen of the Umsatzsteuer-Voranmeldung (81/86 revenue, 41/43/21 tax-free, 46/47 and 67 reverse
 * charge, 66 input tax, 83 balance). Preparation only – the advisor files the return; nothing is sent to ELSTER.
 */
export function ustva(app: App, locationId: string, period: string) {
  const settings = getSettings(app, locationId);
  const { from, to, label } = vatPeriod(period);
  const accrual = recognize(app, locationId, to, 'accrual').recs.filter((x) => inRange(x.date, from, to));
  // Ist-Versteuerung: the tax on revenue is due when the money arrives; input tax is deductible with the invoice.
  const out = settings.vat_method === 'ist' ? recognize(app, locationId, to, 'cash').recs.filter((x) => inRange(x.date, from, to)) : accrual;
  const sumBy = (recs: Rec[], codes: TaxCode[], f: 'net' | 'tax') => recs.filter((x) => codes.includes(x.code)).reduce((n, x) => n + x[f], 0);
  const base19 = sumBy(out, ['ust19'], 'net');
  const tax19 = sumBy(out, ['ust19'], 'tax');
  const base7 = sumBy(out, ['ust7'], 'net');
  const tax7 = sumBy(out, ['ust7'], 'tax');
  const ig = sumBy(accrual, ['ust_ig'], 'net');
  const exp = sumBy(accrual, ['ust_export'], 'net');
  const rcOut = sumBy(accrual, ['ust_rc'], 'net');
  const rcBase = sumBy(accrual, ['rc19'], 'net');
  const rcTax = sumBy(accrual, ['rc19'], 'tax');
  const input = sumBy(accrual, ['vst19', 'vst7'], 'tax');
  const free = sumBy(out, ['ust0'], 'net');
  const small = sumBy(out, ['kl'], 'net');
  const outputTax = tax19 + tax7 + rcTax;
  const inputTax = input + rcTax;
  const lines: VatLine[] = [
    { kz: '81', label: 'Lieferungen und sonstige Leistungen zu 19 %', base_cents: base19, tax_cents: tax19 },
    { kz: '86', label: 'Lieferungen und sonstige Leistungen zu 7 %', base_cents: base7, tax_cents: tax7 },
    { kz: '41', label: 'Innergemeinschaftliche Lieferungen (steuerfrei)', base_cents: ig },
    { kz: '43', label: 'Ausfuhrlieferungen und weitere steuerfreie Umsätze mit Vorsteuerabzug', base_cents: exp },
    { kz: '21', label: 'Nicht steuerbare sonstige Leistungen an Unternehmer in der EU (Reverse Charge)', base_cents: rcOut },
    { kz: '46/47', label: 'Leistungen im Ausland ansässiger Unternehmer (§ 13b UStG, 19 %)', base_cents: rcBase, tax_cents: rcTax },
    { kz: '66', label: 'Vorsteuerbeträge aus Rechnungen anderer Unternehmer', tax_cents: input },
    { kz: '67', label: 'Vorsteuer aus Leistungen nach § 13b UStG', tax_cents: rcTax },
  ];
  return {
    period,
    label,
    from,
    to,
    method: settings.vat_method === 'ist' ? 'Ist-Versteuerung (nach vereinnahmten Entgelten)' : 'Soll-Versteuerung (nach vereinbarten Entgelten)',
    small_business: settings.vat_mode === 'small',
    lines,
    tax_free_cents: free,
    small_business_revenue_cents: small,
    output_tax_cents: outputTax,
    input_tax_cents: inputTax,
    // Kennzahl 83: Umsatzsteuer minus Vorsteuer; positive = Zahllast, negative = Erstattung.
    balance_cents: outputTax - inputTax,
    kz83_cents: outputTax - inputTax,
    note: 'Übersicht zur Vorbereitung für den Steuerberater – keine Übermittlung an ELSTER, keine Steuerberatung.',
  };
}

// --- open items -----------------------------------------------------------------------------------

export interface OpenItem {
  account: string;
  doc_ref: string;
  party: string;
  date: string;
  due_date: string | null;
  open_cents: number;
  overdue_days: number;
}

/** Offene Posten of the receivable or payable accounts, grouped by document number (Belegfeld 1 in DATEV). */
export function openItems(app: App, locationId: string, type: 'receivable' | 'payable', asof: string) {
  const rows = app.db.all<{ account: string; doc_ref: string; bal: number; date: string; party: string | null; due: string | null }>(
    `SELECT l.account, e.doc_ref, SUM(CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END) AS bal, MIN(e.doc_date) AS date,
            MAX(NULLIF(e.party_name, '')) AS party, MIN(e.due_date) AS due
     FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id JOIN acc_accounts a ON a.location_id = l.location_id AND a.number = l.account
     WHERE l.location_id = ? AND a.kind = ? AND e.date <= ? GROUP BY l.account, e.doc_ref HAVING bal != 0 ORDER BY date, e.doc_ref`,
    locationId, type, asof,
  );
  const day = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 864e5);
  const items: OpenItem[] = rows.map((r) => {
    const open = type === 'receivable' ? r.bal : -r.bal;
    const due = r.due ?? r.date;
    return { account: r.account, doc_ref: r.doc_ref, party: r.party ?? '', date: r.date, due_date: r.due, open_cents: open, overdue_days: Math.max(0, day(asof) - day(due)) };
  });
  const bucket = (lo: number, hi: number) => items.filter((i) => i.overdue_days >= lo && i.overdue_days <= hi).reduce((n, i) => n + i.open_cents, 0);
  return {
    type,
    asof,
    items,
    total_cents: items.reduce((n, i) => n + i.open_cents, 0),
    aging: { current_cents: items.filter((i) => i.overdue_days === 0).reduce((n, i) => n + i.open_cents, 0), d1_30_cents: bucket(1, 30), d31_60_cents: bucket(31, 60), d61_plus_cents: bucket(61, 99999) },
  };
}

// --- summary --------------------------------------------------------------------------------------------

export function summary(app: App, locationId: string, from: string, to: string) {
  const b = bwa(app, locationId, from, to);
  const entries = app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM acc_entries WHERE location_id = ? AND date >= ? AND date <= ?', locationId, from, to)?.n ?? 0;
  const byAccount = b.groups.flatMap((g) => g.accounts.map((a) => ({ account: a.account, name: a.name, type: g.type, cents: a.cents })));
  return {
    from,
    to,
    entries,
    revenue_cents: b.totals.revenue_cents,
    income_cents: b.groups.filter((g) => g.type === 'income').reduce((n, g) => n + g.cents, 0),
    expenses_cents: b.groups.filter((g) => g.type === 'expense').reduce((n, g) => n + g.cents, 0),
    result_cents: b.totals.result_cents,
    top_expenses: byAccount.filter((a) => a.type === 'expense').sort((x, y) => y.cents - x.cents).slice(0, 5),
    open_receivables_cents: openItems(app, locationId, 'receivable', to).total_cents,
    open_payables_cents: openItems(app, locationId, 'payable', to).total_cents,
  };
}
