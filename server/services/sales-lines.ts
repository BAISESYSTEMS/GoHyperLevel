import { calcTotals, lineNet, roundHalfAway, taxOf, unitCode, type LineItem, type TaxMode, type Totals } from './invoice-model.js';

/**
 * The money rules of sales positions (deal line items and quote items) – pure, in cents, no database:
 * a position is `qty × unit price`, minus a discount (percent or a fixed amount), plus tax at its own rate. The deal's amount is
 * the net sum of its positions; a quote turns the same positions into the lines of a quote, an estimate and an invoice.
 * Every rounding is the invoice module's (half away from zero, tax once per rate), so a quote's total is exactly what the
 * invoice made from it says.
 */

export type DiscountType = 'none' | 'percent' | 'amount';

export interface SalesLine {
  id: string;
  product_id: string | null;
  name: string;
  description: string;
  qty: number;
  /** UN/ECE unit code ('' = piece). */
  unit: string;
  price_cents: number;
  discount_type: DiscountType;
  /** percent: 0–100 (two decimals); amount: cents off the line's net. */
  discount_value: number;
  tax_rate: number;
}

export const MAX_LINES = 100;

export class LineError extends Error {}

const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n/g, '\n').slice(0, max);
const ID = /^[A-Za-z0-9_-]{4,24}$/;

/** A number from user input (a German comma is fine), or `fallback`. */
export const toNumber = (v: unknown, fallback: number): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : fallback;
};

export interface ProductRef {
  id: string;
  name: string;
  description?: string | null;
  price_cents: number;
  tax_rate: number | null;
}

/**
 * Positions from user input. A position that names a product of the catalogue takes whatever it does not give itself from the
 * product (name, text, price, tax). Ids that were given and are valid stay, the rest are minted.
 */
export function cleanLines(input: unknown, o: { defaultTax: number; mint: () => string; product?: (id: string) => ProductRef | undefined; max?: number }): SalesLine[] {
  if (!Array.isArray(input)) throw new LineError('Positionen: Liste erwartet');
  const max = o.max ?? MAX_LINES;
  if (input.length > max) throw new LineError(`Höchstens ${max} Positionen`);
  const seen = new Set<string>();
  return input.map((raw: any, i): SalesLine => {
    const pid = typeof raw?.product_id === 'string' && raw.product_id ? raw.product_id : null;
    const product = pid ? o.product?.(pid) : undefined;
    if (pid && !product) throw new LineError(`Position ${i + 1}: Das Produkt gibt es nicht (mehr)`);
    const name = text(raw?.name, 300).replace(/\n/g, ' ').trim() || product?.name || '';
    if (!name) throw new LineError(`Position ${i + 1}: Name fehlt`);
    const qty = Math.round(toNumber(raw?.qty, 1) * 10000) / 10000;
    if (!(qty > 0) || qty > 1_000_000) throw new LineError(`Position ${i + 1}: Menge muss größer als 0 sein`);
    const price = raw?.price_cents !== undefined && raw.price_cents !== '' && raw.price_cents !== null ? Math.round(toNumber(raw.price_cents, NaN)) : (product?.price_cents ?? 0);
    if (!Number.isFinite(price) || Math.abs(price) > 100_000_000_00) throw new LineError(`Position ${i + 1}: Preis ungültig`);
    const taxIn = raw?.tax_rate !== undefined && raw.tax_rate !== '' && raw.tax_rate !== null ? toNumber(raw.tax_rate, NaN) : (product?.tax_rate ?? o.defaultTax);
    if (!Number.isFinite(taxIn) || taxIn < 0 || taxIn > 100) throw new LineError(`Position ${i + 1}: Steuersatz 0 bis 100 %`);
    const dt: DiscountType = raw?.discount_type === 'percent' || raw?.discount_type === 'amount' ? raw.discount_type : 'none';
    let dv = dt === 'none' ? 0 : toNumber(raw?.discount_value, 0);
    if (dt === 'percent') {
      if (dv < 0 || dv > 100) throw new LineError(`Position ${i + 1}: Rabatt 0 bis 100 %`);
      dv = Math.round(dv * 100) / 100;
    } else if (dt === 'amount') {
      dv = Math.round(dv);
      if (dv < 0) throw new LineError(`Position ${i + 1}: Rabatt darf nicht negativ sein`);
    }
    const line: SalesLine = {
      id: typeof raw?.id === 'string' && ID.test(raw.id) && !seen.has(raw.id) ? raw.id : o.mint(),
      product_id: product ? product.id : null,
      name,
      description: text(raw?.description, 2000).trim() || (raw?.description === undefined ? (product?.description ?? '') : ''),
      qty,
      unit: raw?.unit ? unitCode(raw.unit) : '',
      price_cents: price,
      discount_type: dt,
      discount_value: dv,
      tax_rate: Math.round(taxIn * 100) / 100,
    };
    while (seen.has(line.id)) line.id = o.mint();
    seen.add(line.id);
    return line;
  });
}

export interface LineAmounts {
  /** `qty × price`. */
  list_cents: number;
  /** What the discount takes off (never more than the line is worth; a credit line has no discount). */
  discount_cents: number;
  net_cents: number;
}

export function lineAmounts(l: Pick<SalesLine, 'qty' | 'price_cents' | 'discount_type' | 'discount_value'>): LineAmounts {
  const list = lineNet(l);
  let off = 0;
  if (list > 0) {
    if (l.discount_type === 'percent') off = taxOf(list, Math.min(100, Math.max(0, Number(l.discount_value) || 0)));
    else if (l.discount_type === 'amount') off = Math.round(Number(l.discount_value) || 0);
    off = Math.min(list, Math.max(0, off));
  }
  return { list_cents: list, discount_cents: off, net_cents: list - off };
}

export interface SalesTotals extends Totals {
  list_cents: number;
  discount_cents: number;
}

/** Net, discount, tax and gross of positions (tax per rate on the discounted net, rounded once per rate like an invoice). */
export function salesTotals(lines: Pick<SalesLine, 'qty' | 'price_cents' | 'discount_type' | 'discount_value' | 'tax_rate'>[], mode: TaxMode = 'standard'): SalesTotals {
  let list = 0;
  let discount = 0;
  const netLines = lines.map((l) => {
    const a = lineAmounts(l);
    list += a.list_cents;
    discount += a.discount_cents;
    return { qty: 1, price_cents: a.net_cents, tax_rate: l.tax_rate };
  });
  return { ...calcTotals(netLines, mode), list_cents: list, discount_cents: discount };
}

/**
 * The deal's amount in whole currency units: the net sum of the positions, rounded half away from zero (the deal list works in
 * whole units; the exact cents stay on the positions).
 */
export const dealAmount = (netCents: number): number => roundHalfAway(netCents / 100);

/**
 * The positions as the lines of a document. A discount becomes a line of its own under the position (negative, same tax rate), so
 * the document shows list price and discount and the tax groups stay right.
 */
export function docItems(lines: SalesLine[]): LineItem[] {
  const out: LineItem[] = [];
  for (const l of lines) {
    const item: LineItem = { name: l.name, qty: l.qty, price_cents: l.price_cents, tax_rate: l.tax_rate };
    if (l.description) item.description = l.description;
    if (l.unit) item.unit = l.unit;
    out.push(item);
    const a = lineAmounts(l);
    if (a.discount_cents > 0) {
      const label = l.discount_type === 'percent' ? `${String(l.discount_value).replace('.', ',')} %` : 'Nachlass';
      out.push({ name: `Rabatt ${label} auf ${l.name}`.slice(0, 300), qty: 1, price_cents: -a.discount_cents, tax_rate: l.tax_rate });
    }
  }
  return out;
}

/** The text of a discount for a screen ("10 %" / "50,00 €"). */
export const discountText = (l: Pick<SalesLine, 'discount_type' | 'discount_value'>, fmt: (cents: number) => string): string =>
  l.discount_type === 'percent' ? `${String(l.discount_value).replace('.', ',')} %` : l.discount_type === 'amount' ? fmt(l.discount_value) : '';

// --- deposit ---------------------------------------------------------------------------------------------------------------------

export interface DepositSpec {
  mode: 'none' | 'deposit' | 'full';
  /** percent of the total, or a fixed net amount in cents. */
  type: 'percent' | 'amount';
  value: number;
}
export const NO_DEPOSIT: DepositSpec = { mode: 'none', type: 'percent', value: 30 };

export function cleanDeposit(v: unknown, current: DepositSpec = NO_DEPOSIT): DepositSpec {
  const b = v && typeof v === 'object' ? (v as Record<string, any>) : {};
  const mode = b.mode === 'deposit' || b.mode === 'full' || b.mode === 'none' ? b.mode : current.mode;
  const type = b.type === 'amount' || b.type === 'percent' ? b.type : current.type;
  let value = b.value === undefined ? current.value : toNumber(b.value, NaN);
  if (!Number.isFinite(value)) throw new LineError('Anzahlung: Zahl erwartet');
  if (type === 'percent') {
    value = Math.round(value * 100) / 100;
    if (mode === 'deposit' && (value <= 0 || value >= 100)) throw new LineError('Anzahlung: mehr als 0 und weniger als 100 %');
  } else {
    value = Math.round(value);
    if (mode === 'deposit' && value <= 0) throw new LineError('Anzahlung: Betrag muss größer als 0 sein');
  }
  return { mode, type, value };
}

/**
 * The deposit as lines for a partial invoice: one line per tax rate of the quote, so each rate carries its share of the net
 * (percent: of each rate's net; fixed amount: the net amount split in proportion, the rounding remainder goes to the largest
 * share so the nets add up to exactly the amount asked for). Returns the lines and the totals they make.
 */
export function depositLines(totals: Pick<Totals, 'groups' | 'subtotal_cents'>, spec: Pick<DepositSpec, 'type' | 'value'>, label: string, mode: TaxMode = 'standard'): { items: LineItem[]; totals: Totals } {
  const groups = totals.groups.filter((g) => g.net_cents !== 0);
  if (!groups.length || totals.subtotal_cents <= 0) throw new LineError('Für eine Anzahlung braucht das Angebot einen Betrag');
  let nets: number[];
  if (spec.type === 'percent') nets = groups.map((g) => taxOf(g.net_cents, spec.value));
  else {
    if (spec.value > totals.subtotal_cents) throw new LineError('Die Anzahlung ist höher als der Angebotswert');
    nets = groups.map((g) => Math.floor((g.net_cents * spec.value) / totals.subtotal_cents));
    let rest = spec.value - nets.reduce((n, x) => n + x, 0);
    const order = groups.map((g, i) => i).sort((a, b) => groups[b].net_cents - groups[a].net_cents);
    for (let k = 0; rest > 0 && k < order.length * 4; k++, rest--) nets[order[k % order.length]] += 1;
  }
  const items: LineItem[] = groups
    .map((g, i) => ({ g, net: nets[i] }))
    .filter((x) => x.net > 0)
    .map(({ g, net }) => ({
      name: groups.length > 1 && mode === 'standard' ? `${label} (${String(g.rate).replace('.', ',')} % USt)` : label,
      qty: 1,
      price_cents: net,
      tax_rate: g.rate,
    }));
  return { items, totals: calcTotals(items, mode) };
}
