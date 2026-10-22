/**
 * The pure rules of invoicing (no database, no HTTP): line maths with the rounding the EN 16931 rules expect, tax modes
 * with their mandatory note texts, number ranges, the state machine, VAT-ID / Leitweg-ID / IBAN checks, Skonto,
 * the compliance check before an invoice is finalised, and the canonical form of a frozen document (for its SHA-256).
 *
 * Money is always whole cents. Documents of the kind `credit_note` (Stornorechnung, Gutschrift) carry negative
 * quantities, so every total of such a document is negative; the e-invoice formats get the absolute values (type 381).
 */

import { createHash } from 'node:crypto';
import { daysBetweenYmd, localDayStart, ymdInTz } from '../core/time.js';

// --- lines and totals ---------------------------------------------------------------------------------------------------

export interface LineItem {
  name: string;
  description?: string;
  qty: number;
  price_cents: number;
  tax_rate: number;
  /** UN/ECE Recommendation 20 unit code (C62 = Stück, HUR = Stunde …). */
  unit?: string;
}

/** Unit codes offered in the editor: UN/ECE code → label on the document. */
export const UNITS: Record<string, string> = { C62: 'Stk.', HUR: 'Std.', DAY: 'Tag', WEE: 'Woche', MON: 'Monat', KGM: 'kg', MTR: 'm', MTK: 'm²', KMT: 'km', LTR: 'l', SET: 'Set', LS: 'pauschal' };
export const unitCode = (u: unknown): string => (typeof u === 'string' && Object.hasOwn(UNITS, u) ? u : 'C62');

/** Half away from zero – symmetric, so a credit note of an invoice is its exact negative. */
export const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

/** `qty × price` in cents (qty up to four decimals), rounded half away from zero, with integer maths. */
export function lineNet(it: Pick<LineItem, 'qty' | 'price_cents'>): number {
  const q = Math.round(Number(it.qty) * 10000);
  const prod = q * Math.round(Number(it.price_cents));
  return Math.sign(prod) * Math.floor((Math.abs(prod) + 5000) / 10000);
}

/** `net × rate %` in cents, rounded half away from zero (rate up to two decimals). */
export function taxOf(netCents: number, ratePercent: number): number {
  const bp = Math.round(Number(ratePercent) * 100);
  return Math.sign(netCents) * Math.floor((Math.abs(netCents) * bp + 5000) / 10000);
}

export type TaxMode = 'standard' | 'small_business' | 'reverse_charge' | 'ig_supply' | 'export' | 'tax_free';
/** EN 16931 VAT category codes used here: S standard, Z zero, E exempt, AE reverse charge, K intra-community, G export. */
export type TaxCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G';

export interface TaxModeDef {
  label: string;
  /** The text that has to stand on the invoice (editable, but never empty). */
  note: string;
  category: TaxCategory | null;
  /** EN 16931 exemption reason code (BT-121, VATEX list). */
  vatex?: string;
  needsBuyerVat?: boolean;
  needsSellerVat?: boolean;
}

export const TAX_MODES: Record<TaxMode, TaxModeDef> = {
  standard: { label: 'Regelbesteuerung (19 % / 7 %)', note: '', category: null },
  small_business: { label: 'Kleinunternehmer (§ 19 UStG)', note: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', category: 'E' },
  reverse_charge: {
    label: 'Reverse Charge (Steuerschuldner ist der Empfänger)',
    note: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge) gemäß § 13b UStG bzw. Art. 196 MwStSystRL.',
    category: 'AE',
    vatex: 'VATEX-EU-AE',
    needsBuyerVat: true,
    needsSellerVat: true,
  },
  ig_supply: {
    label: 'Innergemeinschaftliche Lieferung (steuerfrei)',
    note: 'Steuerfreie innergemeinschaftliche Lieferung gemäß § 4 Nr. 1b i. V. m. § 6a UStG.',
    category: 'K',
    vatex: 'VATEX-EU-IC',
    needsBuyerVat: true,
    needsSellerVat: true,
  },
  export: { label: 'Ausfuhrlieferung in ein Drittland (steuerfrei)', note: 'Steuerfreie Ausfuhrlieferung gemäß § 4 Nr. 1a i. V. m. § 6 UStG.', category: 'G', vatex: 'VATEX-EU-G' },
  tax_free: { label: 'Sonstige Steuerbefreiung (§ 4 UStG)', note: 'Steuerfreie Leistung gemäß § 4 Nr. … UStG.', category: 'E' },
};
export const isTaxMode = (v: unknown): v is TaxMode => typeof v === 'string' && Object.hasOwn(TAX_MODES, v);

export function categoryOf(mode: TaxMode, rate: number): TaxCategory {
  const c = TAX_MODES[mode].category;
  if (c) return c;
  return rate > 0 ? 'S' : 'Z';
}

export interface TaxGroup {
  category: TaxCategory;
  rate: number;
  net_cents: number;
  tax_cents: number;
}

export interface Totals {
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  groups: TaxGroup[];
}

/**
 * Net, tax and gross of a document. `calc: 'group'` rounds the tax once per tax group (what EN 16931 BR-CO-17 expects),
 * `'line'` per line – the way documents were calculated before invoicing was reworked (kept for those documents).
 */
export function calcTotals(items: Pick<LineItem, 'qty' | 'price_cents' | 'tax_rate'>[], mode: TaxMode = 'standard', calc: 'group' | 'line' = 'group'): Totals {
  const map = new Map<string, TaxGroup>();
  for (const it of items) {
    const net = lineNet(it);
    const rate = mode === 'standard' ? Number(it.tax_rate) || 0 : 0;
    const category = categoryOf(mode, rate);
    const key = `${category}|${rate}`;
    const g = map.get(key) ?? { category, rate, net_cents: 0, tax_cents: 0 };
    g.net_cents += net;
    if (calc === 'line') g.tax_cents += taxOf(net, rate);
    map.set(key, g);
  }
  const groups = [...map.values()].sort((a, b) => b.rate - a.rate || a.category.localeCompare(b.category));
  if (calc === 'group') for (const g of groups) g.tax_cents = taxOf(g.net_cents, g.rate);
  const subtotal = groups.reduce((n, g) => n + g.net_cents, 0);
  const tax = groups.reduce((n, g) => n + g.tax_cents, 0);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax, groups };
}

/** Same document with every quantity negated (Stornorechnung): the exact opposite of the original. */
export const negateItems = (items: LineItem[]): LineItem[] => items.map((it) => ({ ...it, qty: -it.qty }));

// --- deductions (Abschlags- / Schlussrechnung) ----------------------------------------------------------------------------------

export interface Deduction {
  id: string;
  number: string;
  issued_at: string;
  /** The date printed on the partial invoice (its own zone); older documents only have `issued_at`. */
  issued_ymd?: string;
  net_cents: number;
  tax_cents: number;
  total_cents: number;
  groups: TaxGroup[];
}

/** The date of a deducted partial invoice as printed on it – not the UTC date of `issued_at` (the day before after midnight in Berlin). */
export const deductionYmd = (d: Pick<Deduction, 'issued_at' | 'issued_ymd'>): string => (d.issued_ymd && /^\d{4}-\d{2}-\d{2}$/.test(d.issued_ymd) ? d.issued_ymd : String(d.issued_at ?? '').slice(0, 10));

export const deductedTotal = (d: Deduction[] | undefined): number => (d ?? []).reduce((n, x) => n + x.total_cents, 0);

/**
 * SQL for what a paid document brought in: a final invoice without the partial invoices it deducts (those were paid and counted
 * on their own – summing `total_cents` counted them twice), a credit note's refund (negative; a Storno of a final invoice only
 * returns what was left after the partial invoices), nothing for a quote (its "paid" flag has no accounting meaning).
 * `t` is the table alias with its dot (`'i.'`) or ''.
 */
export const paidRevenueSql = (t = ''): string => `CASE ${t}kind WHEN 'invoice' THEN ${t}total_cents - ${t}deducted_cents WHEN 'credit_note' THEN ${t}total_cents + ${t}deducted_cents ELSE 0 END`;

/** What an invoice still asks the customer to pay: gross − earlier partial invoices − payments − credit notes (never below 0). */
export function openCents(inv: { total_cents: number; deducted_cents?: number | null; paid_cents?: number | null; credited_cents?: number | null; kind?: string }): number {
  if (inv.kind === 'credit_note') return 0;
  return Math.max(0, inv.total_cents - (inv.deducted_cents ?? 0) - (inv.paid_cents ?? 0) - (inv.credited_cents ?? 0));
}

/**
 * Calendar days an invoice is overdue at `at` in the sub-account's zone `tz`: 0 on the due day itself (whatever the hour – the
 * printed "zahlbar bis" is that day), 1 from midnight after it. Counting 24-hour blocks made an invoice due yesterday at 23:00
 * "0 days" overdue at 08:00 today. Dunning levels and interest, reports, the lists and the workflow trigger all count this way.
 */
export function daysOverdue(dueAt: string | Date | null | undefined, at: Date = new Date(), tz = 'Europe/Berlin'): number {
  if (!dueAt) return 0;
  const d = calendarDaysBetween(dueAt, at, tz);
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/**
 * Calendar days from `from` to `to` in the zone `tz`: midnight to midnight, whatever the hours (23:00 on the 1st to 08:00 on the 4th
 * is 3 days, not 2). Negative when `to` is earlier, NaN for an invalid date. Days overdue and the gap between dunning notices count so.
 */
export function calendarDaysBetween(from: string | Date, to: Date = new Date(), tz = 'Europe/Berlin'): number {
  const a = new Date(from);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(to.getTime())) return NaN;
  return daysBetweenYmd(ymdInTz(a, tz), ymdInTz(to, tz));
}

/** The instant before which a due date lies when the invoice is at least `days` (≥ 1) calendar days overdue at `at`: `due_at < overdueBefore(…)`. */
export const overdueBefore = (tz: string, at: Date = new Date(), days = 1): string => localDayStart(tz, at, 1 - Math.max(1, Math.floor(days)));

// --- number ranges --------------------------------------------------------------------------------------------------------

export type RangeKey = 'invoice' | 'credit' | 'storno' | 'estimate';
export const RANGE_KEYS: RangeKey[] = ['invoice', 'credit', 'storno', 'estimate'];
export const RANGE_LABELS: Record<RangeKey, string> = { invoice: 'Rechnungen', credit: 'Gutschriften / Rechnungskorrekturen', storno: 'Stornorechnungen', estimate: 'Angebote' };

export interface RangeCfg {
  prefix: string;
  /** Put the year between prefix and number (RE-2026-0001). */
  with_year: boolean;
  /** Start again at `start` every year (needs with_year, otherwise numbers would repeat). */
  year_reset: boolean;
  /** Zero-padded width of the running number (0 = none). */
  digits: number;
  /** First number of the range (and of every year when it restarts). */
  start: number;
}

export const RANGE_DEFAULTS: Record<RangeKey, RangeCfg> = {
  invoice: { prefix: 'RE-', with_year: false, year_reset: false, digits: 0, start: 1001 },
  credit: { prefix: 'GS-', with_year: false, year_reset: false, digits: 0, start: 1001 },
  storno: { prefix: 'ST-', with_year: false, year_reset: false, digits: 0, start: 1001 },
  estimate: { prefix: 'AN-', with_year: false, year_reset: false, digits: 0, start: 1001 },
};

const PREFIX_RE = /^[A-Za-z0-9_./-]{0,14}$/;

/** Cleans one range from user input; throws German messages. */
export function cleanRange(input: any, base: RangeCfg): RangeCfg {
  const out: RangeCfg = { ...base };
  if (input?.prefix !== undefined) {
    const p = String(input.prefix).trim();
    if (!PREFIX_RE.test(p)) throw new Error('Präfix: höchstens 14 Zeichen aus Buchstaben, Ziffern und - _ . /');
    out.prefix = p;
  }
  if (input?.with_year !== undefined) out.with_year = !!input.with_year;
  if (input?.year_reset !== undefined) out.year_reset = !!input.year_reset;
  if (input?.digits !== undefined) {
    const n = Number(input.digits);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw new Error('Stellen: eine ganze Zahl von 0 bis 10');
    out.digits = n;
  }
  if (input?.start !== undefined) {
    const n = Number(input.start);
    if (!Number.isInteger(n) || n < 0 || n > 999_999_999) throw new Error('Startnummer: eine ganze Zahl von 0 bis 999 999 999');
    out.start = n;
  }
  if (out.year_reset && !out.with_year) throw new Error('„Jedes Jahr neu beginnen“ geht nur mit Jahreszahl in der Nummer – sonst würden Nummern doppelt vergeben');
  return out;
}

/**
 * The effective configuration of a range: defaults, the old settings (`prefix`, `next`, `next_estimate`) and the
 * ranges saved by the number-range page, in that order.
 */
export function rangeCfg(settings: Record<string, any> | undefined, key: RangeKey): RangeCfg {
  const s = settings ?? {};
  let cfg: RangeCfg = { ...RANGE_DEFAULTS[key] };
  if (key === 'invoice') {
    if (typeof s.prefix === 'string') cfg.prefix = s.prefix;
    if (Number(s.next) > 0) cfg.start = Math.floor(Number(s.next));
  } else if (key === 'estimate' && Number(s.next_estimate) > 0) cfg.start = Math.floor(Number(s.next_estimate));
  const saved = s.ranges?.[key];
  if (saved && typeof saved === 'object') {
    try {
      cfg = cleanRange(saved, cfg);
    } catch {
      /* a broken saved range falls back to the defaults above */
    }
  }
  return cfg;
}

/** The counter period: the year when the range restarts every year, else one endless counter. */
export const rangePeriod = (cfg: RangeCfg, year: string): string => (cfg.year_reset ? year : '');

export function formatNumber(cfg: RangeCfg, seq: number, year: string): string {
  const n = cfg.digits > 0 ? String(seq).padStart(cfg.digits, '0') : String(seq);
  return `${cfg.prefix}${cfg.with_year ? `${year}-` : ''}${n}`;
}

/** What a draft carries in the `number` column (unique per row, never shown as a number). */
export const DRAFT_PREFIX = 'Entwurf-';
export const isDraftNumber = (n: unknown): boolean => typeof n === 'string' && n.startsWith(DRAFT_PREFIX);

/** How other screens name a document that has no number yet. */
export const invoiceLabel = (n: unknown): string => (isDraftNumber(n) ? 'Entwurf' : String(n ?? ''));

// --- state machine ------------------------------------------------------------------------------------------------------------

/** The stored status. `sent` means "finalised and open" (also while partly paid); `void` is "cancelled" (or a discarded draft). */
export type Status = 'draft' | 'sent' | 'paid' | 'void' | 'accepted';

/** What a person sees: the stored status refined by payments and by whether the document was ever finalised. */
export type DocState = 'draft' | 'open' | 'partially_paid' | 'paid' | 'cancelled' | 'credited' | 'discarded' | 'accepted';

export const DOC_STATE_LABELS: Record<DocState, string> = {
  draft: 'Entwurf',
  open: 'Festgeschrieben, offen',
  partially_paid: 'Teilweise bezahlt',
  paid: 'Bezahlt',
  cancelled: 'Storniert',
  credited: 'Gutgeschrieben',
  discarded: 'Verworfen',
  accepted: 'Angenommen',
};

export interface StateInput {
  kind: string;
  status: string;
  finalised_at?: string | null;
  total_cents: number;
  deducted_cents?: number | null;
  paid_cents?: number | null;
  credited_cents?: number | null;
  storno_id?: string | null;
}

/**
 * An invoice closed by its credit notes: credited in full with nothing paid. Stored like a cancelled one (`void`, `cancelled_at`)
 * – no payment, no dunning, no further credit note or Storno – but without a Stornorechnung: the Gutschriften stand next to it
 * and are what the books reverse (services/acc-autopost.ts keeps the invoice's own entry).
 */
export const creditClosed = (inv: Pick<StateInput, 'status' | 'finalised_at' | 'credited_cents' | 'storno_id'>): boolean =>
  inv.status === 'void' && !!inv.finalised_at && !inv.storno_id && Number(inv.credited_cents ?? 0) > 0;
/** The same in SQL; `t` is the table alias with its dot (`'i.'`) or ''. */
export const creditClosedSql = (t = ''): string => `(${t}status = 'void' AND ${t}finalised_at IS NOT NULL AND ${t}storno_id IS NULL AND ${t}credited_cents > 0)`;

export function docState(inv: StateInput): DocState {
  if (inv.status === 'draft') return 'draft';
  if (inv.status === 'accepted') return 'accepted';
  if (inv.status === 'void') return creditClosed(inv) ? 'credited' : inv.finalised_at ? 'cancelled' : 'discarded';
  if (inv.status === 'paid') return 'paid';
  if (inv.kind === 'invoice' && (inv.paid_cents ?? 0) > 0 && openCents(inv) > 0) return 'partially_paid';
  return 'open';
}

export type Action = 'finalise' | 'finalise_and_pay' | 'pay' | 'storno' | 'discard' | 'accept' | 'send' | 'none';

export class StateError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}

/**
 * What a status change asked for (`PATCH { status }`) means for this document – or why it is refused (409).
 * Invoices: draft → open (finalise) → partly paid → paid; cancelled only by a Storno document; nothing goes back to draft.
 * Quotes (estimates) are no tax documents: draft → sent → accepted/void.
 */
export function actionFor(inv: StateInput, to: string): Action {
  const from = inv.status;
  if (!['draft', 'sent', 'paid', 'void', 'accepted'].includes(to)) throw new StateError('Unbekannter Status', 400);
  if (from === to) return 'none';
  if (inv.kind === 'estimate') {
    if (from === 'void') throw new StateError('Ein verworfenes Angebot lässt sich nicht wieder öffnen');
    if (to === 'draft' && from !== 'draft') throw new StateError('Ein versendetes Angebot geht nicht zurück in den Entwurf');
    if (to === 'void') return 'discard';
    if (to === 'accepted') return 'accept';
    if (to === 'sent') return 'send';
    return 'none'; // paid: legacy flag on quotes, no accounting meaning
  }
  const finalised = !!inv.finalised_at || from === 'paid';
  if (from === 'void') throw new StateError(finalised ? 'Eine stornierte Rechnung bleibt unverändert – für Korrekturen eine neue Rechnung schreiben' : 'Ein verworfener Entwurf lässt sich nicht wieder öffnen');
  if (to === 'draft') throw new StateError('Eine festgeschriebene Rechnung kann nicht zurück in den Entwurf – storniere sie und schreibe eine neue');
  if (to === 'accepted') throw new StateError('„Angenommen“ gibt es nur bei Angeboten');
  if (to === 'void') return finalised ? 'storno' : 'discard';
  if (to === 'sent') {
    if (from === 'draft') return 'finalise';
    throw new StateError('Eine bezahlte Rechnung wird nicht wieder „offen“ – eine Zahlung lässt sich in der Rechnung zurücknehmen');
  }
  // to === 'paid'
  return from === 'draft' ? 'finalise_and_pay' : 'pay';
}

// --- document fields --------------------------------------------------------------------------------------------------------------

export type InvType = 'standard' | 'partial' | 'final';
export const INV_TYPES: Record<InvType, string> = { standard: 'Rechnung', partial: 'Abschlagsrechnung', final: 'Schlussrechnung' };
export type CreditType = 'storno' | 'credit';
export const CREDIT_TYPES: Record<CreditType, string> = { storno: 'Stornorechnung', credit: 'Rechnungskorrektur / Gutschrift' };

/** The title of a document, as printed. */
export function docTitle(inv: { kind: string; inv_type?: string | null; credit_type?: string | null }): string {
  if (inv.kind === 'estimate') return 'Angebot';
  if (inv.kind === 'credit_note') return inv.credit_type === 'storno' ? 'Stornorechnung' : 'Gutschrift / Rechnungskorrektur';
  return INV_TYPES[(inv.inv_type as InvType) ?? 'standard'] ?? 'Rechnung';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function cleanYmd(v: unknown, label: string): string {
  const s = String(v ?? '').trim().slice(0, 10);
  if (!s) return '';
  if (!DATE_RE.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new Error(`${label}: bitte als Datum (JJJJ-MM-TT) angeben`);
  return s;
}

// --- VAT ID, Leitweg-ID, IBAN ---------------------------------------------------------------------------------------------------------

const VAT_PATTERNS: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  EL: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(\d{7}[A-Z]{1,2}|\d[A-Z+*]\d{5}[A-Z])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{10}01$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  XI: /^XI(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/,
};

export const normalizeVatId = (raw: unknown): string => String(raw ?? '').replace(/[\s.\-–]/g, '').toUpperCase();

/** Checksum of a German USt-IdNr. (ISO 7064 Mod 11,10) – the same one the BZSt describes. */
export function germanVatChecksumOk(digits9: string): boolean {
  if (!/^\d{9}$/.test(digits9)) return false;
  let product = 10;
  for (let i = 0; i < 8; i++) {
    let sum = (Number(digits9[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === Number(digits9[8]);
}

export interface VatIdCheck {
  valid: boolean;
  normalized: string;
  country: string;
  /** Why not (German), when invalid. */
  reason?: string;
}

/** Format check of an EU VAT ID (country prefix, length, characters; the German checksum too). No lookup – see VIES in the module. */
export function checkVatId(raw: unknown): VatIdCheck {
  const n = normalizeVatId(raw);
  if (!n) return { valid: false, normalized: '', country: '', reason: 'Keine USt-IdNr. angegeben' };
  const cc = n.slice(0, 2);
  const re = VAT_PATTERNS[cc];
  if (!re) return { valid: false, normalized: n, country: cc, reason: `Länderkennung „${cc}“ ist keine EU-USt-IdNr. (z. B. DE, AT, FR, NL)` };
  if (!re.test(n)) return { valid: false, normalized: n, country: cc, reason: `Das Format passt nicht zu einer USt-IdNr. aus ${cc}` };
  if (cc === 'DE' && !germanVatChecksumOk(n.slice(2))) return { valid: false, normalized: n, country: cc, reason: 'Die Prüfziffer der deutschen USt-IdNr. stimmt nicht' };
  return { valid: true, normalized: n, country: cc === 'EL' ? 'GR' : cc };
}

/** Converts letters to numbers (A = 10 … Z = 35) for the mod-97 checks of IBAN and Leitweg-ID. */
function mod97(s: string): number {
  let r = 0;
  for (const ch of s) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

export const normalizeIban = (raw: unknown): string => String(raw ?? '').replace(/\s+/g, '').toUpperCase();

export function checkIban(raw: unknown): boolean {
  const n = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(n)) return false;
  return mod97(n.slice(4) + n.slice(0, 4)) === 1;
}

export const checkBic = (raw: unknown): boolean => /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(String(raw ?? '').replace(/\s+/g, '').toUpperCase());

/**
 * Leitweg-ID of public buyers (B2G): Grobadressierung[-Feinadressierung]-Prüfziffer. `valid` is the format;
 * `checksum` says whether the two check digits fit (ISO 7064 mod 97-10 over Grob- and Feinadressierung).
 */
export function checkLeitwegId(raw: unknown): { valid: boolean; checksum: boolean; reason?: string } {
  const s = String(raw ?? '').trim();
  const m = /^(\d{2,12})(?:-([A-Za-z0-9]{1,30}))?-(\d{2})$/.exec(s);
  if (!m) return { valid: false, checksum: false, reason: 'Format: Grobadressierung (2–12 Ziffern), optional -Feinadressierung, -Prüfziffer (z. B. 04011000-1234512345-35)' };
  const expected = 98 - mod97((m[1] + (m[2] ?? '')).toUpperCase());
  if (expected !== Number(m[3])) return { valid: true, checksum: false, reason: `Die Prüfziffer passt nicht (erwartet ${String(expected).padStart(2, '0')})` };
  return { valid: true, checksum: true };
}

// --- Skonto and payment terms -------------------------------------------------------------------------------------------------------

export interface Skonto {
  percent: number;
  days: number;
}

export function cleanSkonto(percent: unknown, days: unknown): Skonto | null {
  if ((percent === undefined || percent === null || percent === '') && (days === undefined || days === null || days === '')) return null;
  const p = Number(String(percent).replace(',', '.'));
  const d = Number(days);
  if (!Number.isFinite(p) || p <= 0 || p > 30) throw new Error('Skonto: Prozentsatz zwischen 0,01 und 30');
  if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('Skonto: Frist in ganzen Tagen (1 bis 365)');
  return { percent: Math.round(p * 100) / 100, days: d };
}

export const skontoCents = (baseCents: number, percent: number): number => taxOf(baseCents, percent);

/** The Skonto line of an invoice: what to pay by when. */
export function skontoDeadline(issuedYmd: string, days: number): string {
  const d = new Date(`${issuedYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- compliance before finalising ----------------------------------------------------------------------------------------------------------

export interface PartyInfo {
  name: string;
  address?: string;
  postal_code?: string;
  city?: string;
  country?: string;
  email?: string;
  phone?: string;
  vat_id?: string;
  tax_number?: string;
}

export interface ComplianceInput {
  kind: string;
  tax_mode: TaxMode;
  tax_note: string;
  items: LineItem[];
  total_cents: number;
  seller: PartyInfo;
  buyer: PartyInfo & { leitweg_id?: string };
  inv_type?: string;
  deductions?: Deduction[];
  supply_from?: string;
  supply_to?: string;
}

export interface Compliance {
  /** Always block finalising. */
  errors: string[];
  /** Block only when the sub-account turned on the strict check. */
  warnings: string[];
}

/** Kleinbetragsrechnung limit of § 33 UStDV: below it name and address of the recipient are optional. */
const SMALL_AMOUNT_CENTS = 25000;

export function checkCompliance(i: ComplianceInput): Compliance {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mode = TAX_MODES[i.tax_mode];
  if (!i.items.length) errors.push('Mindestens eine Position');
  if (i.items.some((it) => !String(it.name ?? '').trim())) errors.push('Jede Position braucht eine Bezeichnung');
  if (i.tax_mode !== 'standard' && i.items.some((it) => Number(it.tax_rate) !== 0)) errors.push(`Bei „${mode.label}“ dürfen die Positionen keine Umsatzsteuer enthalten (0 %)`);
  if (i.tax_mode !== 'standard') {
    const note = String(i.tax_note ?? '').trim();
    if (note.length < 10) errors.push(`Bei „${mode.label}“ ist der Hinweistext Pflicht (z. B. „${mode.note}“)`);
    else if (note.includes('…')) errors.push('Der Hinweistext enthält noch den Platzhalter „…“ – bitte die Vorschrift (z. B. Nr. 21b) eintragen');
  }
  if (mode.needsSellerVat && !checkVatId(i.seller.vat_id).valid) errors.push(`Bei „${mode.label}“ muss deine USt-IdNr. in den Rechnungs-Einstellungen stehen`);
  if (mode.needsBuyerVat) {
    if (!String(i.buyer.vat_id ?? '').trim()) errors.push(`Bei „${mode.label}“ ist die USt-IdNr. des Kunden Pflicht`);
  }
  if (String(i.buyer.vat_id ?? '').trim()) {
    const c = checkVatId(i.buyer.vat_id);
    if (!c.valid) errors.push(`USt-IdNr. des Kunden: ${c.reason}`);
    else if ((i.tax_mode === 'reverse_charge' || i.tax_mode === 'ig_supply') && c.country === 'DE' && i.seller.vat_id && checkVatId(i.seller.vat_id).country === 'DE') warnings.push('Beide USt-IdNr. sind deutsch – Reverse Charge / innergemeinschaftliche Lieferung passt nur bei Kunden in einem anderen Land');
  }
  if (String(i.buyer.leitweg_id ?? '').trim()) {
    const l = checkLeitwegId(i.buyer.leitweg_id);
    if (!l.valid) errors.push(`Leitweg-ID: ${l.reason}`);
    else if (!l.checksum) warnings.push(`Leitweg-ID: ${l.reason} – bitte beim Auftraggeber nachfragen`);
  }
  if (i.supply_from && i.supply_to && i.supply_to < i.supply_from) errors.push('Leistungszeitraum: das Ende liegt vor dem Beginn');
  if (i.inv_type === 'final' && !(i.deductions ?? []).length) warnings.push('Schlussrechnung ohne abgezogene Abschlagsrechnungen');
  // Mandatory content of § 14 (4) UStG – name and address of both sides, tax number or USt-IdNr. of the seller.
  if (!String(i.seller.name ?? '').trim()) warnings.push('Absender: Name fehlt (Einstellungen → Sub-Account)');
  if (!String(i.seller.address ?? '').trim() || !String(i.seller.city ?? '').trim() || !String(i.seller.postal_code ?? '').trim()) warnings.push('Absender: vollständige Anschrift (Straße, PLZ, Ort) fehlt');
  if (!String(i.seller.vat_id ?? '').trim() && !String(i.seller.tax_number ?? '').trim()) warnings.push('Absender: Steuernummer oder USt-IdNr. fehlt (Pflichtangabe nach § 14 UStG)');
  const smallAmount = Math.abs(i.total_cents) <= SMALL_AMOUNT_CENTS;
  if (!smallAmount || i.kind === 'credit_note') {
    if (!String(i.buyer.name ?? '').trim()) warnings.push('Empfänger: Name fehlt');
    else if (!String(i.buyer.address ?? '').trim() || !String(i.buyer.city ?? '').trim()) warnings.push('Empfänger: Anschrift (Straße, PLZ, Ort) fehlt – ab 250 € Pflicht');
  }
  return { errors, warnings };
}

// --- canonical form + hash ------------------------------------------------------------------------------------------------------------

/** JSON with sorted keys and no whitespace – the same value always gives the same bytes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Columns that cannot change once an invoice is finalised (the database trigger refuses them too). */
export const FROZEN_COLUMNS = [
  'location_id',
  'kind',
  'number',
  'title',
  'items',
  'currency',
  'subtotal_cents',
  'tax_cents',
  'total_cents',
  'issued_at',
  'tax_mode',
  'tax_note',
  'supply_from',
  'supply_to',
  'buyer_vat_id',
  'leitweg_id',
  'buyer_ref',
  'skonto_percent',
  'skonto_days',
  'inv_type',
  'credit_type',
  'ref_id',
  'deduct_ids',
  'deducted_cents',
  'calc',
  'finalised_at',
  'snapshot',
  'doc_hash',
] as const;

// --- small helpers shared by document renderers ------------------------------------------------------------------------------------------

const COUNTRIES: Record<string, string> = {
  deutschland: 'DE', germany: 'DE', österreich: 'AT', oesterreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH', frankreich: 'FR', france: 'FR', italien: 'IT', italy: 'IT', spanien: 'ES', spain: 'ES',
  niederlande: 'NL', netherlands: 'NL', belgien: 'BE', belgium: 'BE', luxemburg: 'LU', luxembourg: 'LU', polen: 'PL', poland: 'PL', tschechien: 'CZ', dänemark: 'DK', denmark: 'DK', schweden: 'SE', sweden: 'SE',
  finnland: 'FI', irland: 'IE', ireland: 'IE', portugal: 'PT', ungarn: 'HU', rumänien: 'RO', bulgarien: 'BG', kroatien: 'HR', slowenien: 'SI', slowakei: 'SK', griechenland: 'GR', estland: 'EE', lettland: 'LV', litauen: 'LT',
  malta: 'MT', zypern: 'CY', 'vereinigtes königreich': 'GB', 'united kingdom': 'GB', uk: 'GB', usa: 'US', 'vereinigte staaten': 'US', 'united states': 'US', norwegen: 'NO', liechtenstein: 'LI',
};

/** ISO 3166-1 alpha-2 code of a country as typed by a person (name or code); empty input means Germany. */
export function countryCode(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return 'DE';
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRIES[s.toLowerCase()] ?? 'DE';
}

/** Splits a free-text address ("Musterstr. 1\n12345 Berlin") into street, postal code and city. */
export function parseAddress(text: string): { street: string; postal_code: string; city: string } {
  const lines = String(text ?? '').split(/\r?\n|,\s*(?=\d{4,5}\s)/).map((l) => l.trim()).filter(Boolean);
  let postal = '';
  let city = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:[A-Z]{1,2}-)?(\d{4,5})\s+(.+)$/.exec(lines[i]);
    if (m) {
      postal = m[1];
      city = m[2];
      lines.splice(i, 1);
      break;
    }
  }
  return { street: lines.join(', '), postal_code: postal, city };
}

export const ymd = (iso: string, tz = 'UTC'): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

/** 2026-10-05 → 05.10.2026 */
export const deYmd = (s: string | null | undefined): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

/** 1234.5 → "1.234,50" (no currency sign). */
export const deAmount = (cents: number): string => new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((cents || 0) / 100);

/** The line the customer reads about payment: due date, Skonto. */
export function paymentTermsText(i: { due_ymd?: string; skonto?: Skonto | null; issued_ymd: string; total_cents: number; currency?: string }): string {
  const parts: string[] = [];
  if (i.due_ymd) parts.push(`Zahlbar ohne Abzug bis ${deYmd(i.due_ymd)}.`);
  if (i.skonto) {
    const s = skontoCents(i.total_cents, i.skonto.percent);
    parts.push(`Bei Zahlung bis ${deYmd(skontoDeadline(i.issued_ymd, i.skonto.days))} (${i.skonto.days} Tage) ${String(i.skonto.percent).replace('.', ',')} % Skonto (${deAmount(s)} ${i.currency ?? 'EUR'}).`);
  }
  return parts.join(' ');
}
