/**
 * The semantic model of an e-invoice (EN 16931, XRechnung 3.0) and how a frozen invoice document becomes one.
 * The two syntaxes (CII and UBL) are written from this model by einvoice-cii.ts / einvoice-ubl.ts and checked again
 * from the XML by einvoice-validate.ts – so a bug in a writer shows up as a broken rule, not as a broken model.
 */

import { TAX_MODES, categoryOf, checkVatId, countryCode, deAmount, deYmd, deductionYmd, lineNet, type CreditType, type Deduction, type InvType, type LineItem, type Skonto, type TaxCategory, type TaxGroup, type TaxMode, type Totals, unitCode } from './invoice-model.js';

export const XRECHNUNG_CUSTOMIZATION = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';
export const PEPPOL_PROFILE = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

export interface SellerParty {
  name: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  contact_name: string;
  vat_id: string;
  tax_number: string;
  footer?: string;
}

export interface BuyerParty {
  name: string;
  company: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  vat_id: string;
  leitweg_id: string;
  buyer_ref: string;
}

export interface BankInfo {
  iban: string;
  bic: string;
  bank: string;
}

/** Everything that is frozen when an invoice is finalised (plus the two fields that stay editable: notes and due date). */
export interface DocSnapshot {
  v: 1;
  kind: 'invoice' | 'credit_note' | 'estimate';
  inv_type: InvType;
  credit_type: CreditType | '';
  number: string;
  issued_at: string;
  issued_ymd: string;
  due_ymd: string;
  currency: string;
  title: string;
  notes: string;
  tax_mode: TaxMode;
  tax_note: string;
  calc: 'group' | 'line';
  supply_from: string;
  supply_to: string;
  /** No supply date was entered: it equals the invoice date (stated on the document). */
  supply_auto: boolean;
  items: LineItem[];
  totals: Totals;
  deducted_cents: number;
  deductions: Deduction[];
  skonto: Skonto | null;
  ref: { id: string; number: string; issued_ymd: string } | null;
  seller: SellerParty;
  buyer: BuyerParty;
  bank: BankInfo;
  vies?: { checked_at: string; valid: boolean; name?: string; address?: string } | null;
}

// --- the e-invoice model --------------------------------------------------------------------------------------------------------

export interface EParty {
  name: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  contact_name: string;
  vat_id: string;
  tax_number: string;
  /** BT-34 / BT-49: scheme (EM = e-mail, 0204 = Leitweg-ID) and address. */
  endpoint_scheme: string;
  endpoint: string;
}

export interface ELine {
  id: string;
  name: string;
  description: string;
  /** Always positive (a credit note is a document type, not negative amounts). */
  qty: number;
  unit: string;
  price_cents: number;
  net_cents: number;
  category: TaxCategory;
  rate: number;
}

export interface EGroup {
  category: TaxCategory;
  rate: number;
  basis_cents: number;
  tax_cents: number;
  reason: string;
  reason_code: string;
}

export interface EInvoice {
  customization: string;
  profile: string;
  /** UNTDID 1001: 380 invoice, 381 credit note, 326 partial invoice. */
  type_code: '380' | '381' | '326';
  number: string;
  issue_date: string;
  due_date: string;
  currency: string;
  buyer_reference: string;
  /** BT-22 notes. */
  notes: string[];
  payment_terms: string;
  supply_date: string;
  period_start: string;
  period_end: string;
  seller: EParty;
  buyer: EParty;
  payment: { means_code: '58' | '30'; iban: string; bic: string; remittance: string };
  lines: ELine[];
  groups: EGroup[];
  preceding: { number: string; date: string }[];
  totals: { line_cents: number; basis_cents: number; tax_cents: number; grand_cents: number; prepaid_cents: number; due_cents: number };
}

export interface EInvoiceProblem {
  /** The missing or wrong information, in German, for the person who has to fix it. */
  message: string;
}

const clip = (s: string, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The structured text for the Skonto (XRechnung "Skonto in BT-20"), one line per condition. */
export function skontoLines(s: Skonto | null, baseCents: number): string[] {
  if (!s) return [];
  return [`#SKONTO#TAGE=${s.days}#PROZENT=${s.percent.toFixed(2)}#BASISBETRAG=${(Math.abs(baseCents) / 100).toFixed(2)}#`];
}

/**
 * Builds the e-invoice from a frozen document. `problems` lists what XRechnung needs and the document does not have
 * (the generator refuses to write a file that would be rejected on the first check).
 */
export function buildEInvoice(doc: DocSnapshot): { einvoice: EInvoice; problems: EInvoiceProblem[] } {
  const problems: EInvoiceProblem[] = [];
  const need = (ok: unknown, message: string) => {
    if (!ok || (typeof ok === 'string' && !ok.trim())) problems.push({ message });
  };
  const mode = TAX_MODES[doc.tax_mode];
  const credit = doc.kind === 'credit_note';
  const s = doc.seller;
  const b = doc.buyer;

  // Lines: positive price (a negative price becomes a negative quantity); a credit note is a document type, so its amounts are absolute.
  const lines: ELine[] = doc.items.map((it, i) => {
    const raw = lineNet(it);
    let qty = Number(it.qty);
    let price = Math.round(Number(it.price_cents));
    if (price < 0) {
      qty = -qty;
      price = -price;
    }
    if (credit) qty = Math.abs(qty);
    const rate = doc.tax_mode === 'standard' ? Number(it.tax_rate) || 0 : 0;
    return { id: String(i + 1), name: clip(it.name, 200) || `Position ${i + 1}`, description: clip(it.description ?? '', 1000), qty, unit: unitCode(it.unit), price_cents: price, net_cents: credit ? Math.abs(raw) : raw, category: categoryOf(doc.tax_mode, rate), rate };
  });

  const abs = (n: number) => (credit ? Math.abs(n) : n);
  const groups: EGroup[] = doc.totals.groups.map((g: TaxGroup) => ({
    category: g.category,
    rate: g.rate,
    basis_cents: abs(g.net_cents),
    tax_cents: abs(g.tax_cents),
    reason: g.category === 'E' || g.category === 'AE' || g.category === 'K' || g.category === 'G' ? clip(doc.tax_note || mode.note, 300) : '',
    reason_code: g.category === 'AE' || g.category === 'K' || g.category === 'G' ? (mode.vatex ?? '') : '',
  }));

  const line_cents = lines.reduce((n, l) => n + l.net_cents, 0);
  const tax_cents = groups.reduce((n, g) => n + g.tax_cents, 0);
  const basis = line_cents;
  const grand = basis + tax_cents;
  // a Storno of a final invoice carries the deducted partial invoices too (they stay valid): BT-115 is what is refunded
  const prepaid = doc.deducted_cents;
  const due = grand - prepaid;

  const billTo = b.company || b.name;
  need(s.name, 'Absender: Name fehlt (Einstellungen → Sub-Account)');
  need(s.street, 'Absender: Straße fehlt – bitte unter Einstellungen → Rechnungen die Anschrift ergänzen');
  need(s.postal_code, 'Absender: Postleitzahl fehlt (Einstellungen → Rechnungen)');
  need(s.city, 'Absender: Ort fehlt (Einstellungen → Rechnungen)');
  need(s.vat_id || s.tax_number, 'Absender: Steuernummer oder USt-IdNr. fehlt (Einstellungen → Rechnungen)');
  need(s.phone, 'Absender: Telefonnummer des Ansprechpartners fehlt (Pflicht bei XRechnung – Einstellungen → Rechnungen)');
  need(s.email, 'Absender: E-Mail des Ansprechpartners fehlt (Pflicht bei XRechnung – Einstellungen → Rechnungen)');
  need(billTo, 'Kunde: Name fehlt');
  need(b.street, 'Kunde: Straße fehlt');
  need(b.postal_code, 'Kunde: Postleitzahl fehlt');
  need(b.city, 'Kunde: Ort fehlt');
  need(doc.bank.iban, 'IBAN fehlt (Einstellungen → Rechnungen) – XRechnung braucht Zahlungsangaben');
  const endpointScheme = b.email ? 'EM' : b.leitweg_id ? '0204' : '';
  need(endpointScheme, 'Kunde: E-Mail-Adresse fehlt (elektronische Adresse des Empfängers ist Pflicht)');

  const customerRef = b.leitweg_id || b.buyer_ref || doc.number;
  const notes = [doc.tax_note && doc.tax_mode !== 'standard' ? doc.tax_note : '', doc.notes].map((n) => clip(n, 1500)).filter(Boolean);
  if (doc.supply_auto) notes.push('Leistungsdatum entspricht dem Rechnungsdatum.');
  const terms = [
    doc.due_ymd ? `Zahlbar ohne Abzug bis ${deYmd(doc.due_ymd)}.` : '',
    doc.skonto ? `Bei Zahlung bis ${deYmd(shiftYmd(doc.issued_ymd, doc.skonto.days))} ${String(doc.skonto.percent).replace('.', ',')} % Skonto.` : '',
  ].filter(Boolean);
  // A credit note has no due date; BR-CO-25 still wants payment terms for a positive amount – it says what happens to the credit.
  if (credit) terms.push(doc.credit_type === 'storno' ? 'Der Betrag wird erstattet bzw. mit offenen Forderungen verrechnet (Stornorechnung).' : 'Der Gutschriftsbetrag wird erstattet bzw. mit offenen Forderungen verrechnet.');
  const termLines = [...skontoLines(doc.skonto, due), ...terms];

  const preceding: { number: string; date: string }[] = [];
  if (doc.ref) preceding.push({ number: doc.ref.number, date: doc.ref.issued_ymd });
  for (const d of doc.deductions) preceding.push({ number: d.number, date: deductionYmd(d) });

  const einvoice: EInvoice = {
    customization: XRECHNUNG_CUSTOMIZATION,
    profile: PEPPOL_PROFILE,
    type_code: credit ? '381' : doc.inv_type === 'partial' ? '326' : '380',
    number: doc.number,
    issue_date: doc.issued_ymd,
    due_date: doc.due_ymd,
    currency: doc.currency,
    buyer_reference: clip(customerRef, 100),
    notes,
    payment_terms: termLines.join('\n'),
    supply_date: doc.supply_to ? '' : doc.supply_from,
    period_start: doc.supply_to ? doc.supply_from : '',
    period_end: doc.supply_to || '',
    seller: {
      name: clip(s.name, 150),
      street: clip(s.street, 150),
      postal_code: clip(s.postal_code, 20),
      city: clip(s.city, 80),
      country: countryCode(s.country),
      email: clip(s.email, 150),
      phone: clip(s.phone, 40),
      contact_name: clip(s.contact_name || s.name, 100),
      vat_id: checkVatId(s.vat_id).normalized,
      tax_number: clip(s.tax_number, 40),
      endpoint_scheme: 'EM',
      endpoint: clip(s.email, 150),
    },
    buyer: {
      name: clip(billTo, 150),
      street: clip(b.street, 150),
      postal_code: clip(b.postal_code, 20),
      city: clip(b.city, 80),
      country: countryCode(b.country),
      email: clip(b.email, 150),
      phone: clip(b.phone, 40),
      contact_name: b.company ? clip(b.name, 100) : '',
      vat_id: checkVatId(b.vat_id).normalized,
      tax_number: '',
      endpoint_scheme: endpointScheme || 'EM',
      endpoint: b.email ? clip(b.email, 150) : clip(b.leitweg_id, 60),
    },
    payment: { means_code: '58', iban: doc.bank.iban.replace(/\s+/g, '').toUpperCase(), bic: doc.bank.bic.replace(/\s+/g, '').toUpperCase(), remittance: clip(doc.number, 140) },
    lines,
    groups,
    preceding,
    totals: { line_cents, basis_cents: basis, tax_cents, grand_cents: grand, prepaid_cents: prepaid, due_cents: due },
  };
  return { einvoice, problems };
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- shared XML helpers ---------------------------------------------------------------------------------------------------------------

/** XML text: the five entities, and no characters XML 1.0 does not allow. */
export const xmlEsc = (s: unknown): string =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** 1234 → "12.34" (two decimals, dot). */
export const amt = (cents: number): string => (cents / 100).toFixed(2);

export const rate2 = (r: number): string => (Math.round(r * 100) / 100).toFixed(2);

/** Quantity without trailing zeros, at most four decimals. */
export const qtyText = (q: number): string => {
  const t = (Math.round(q * 10000) / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return t === '' ? '0' : t;
};

export const compactYmd = (ymd: string): string => ymd.replace(/-/g, '');

export { deAmount };
