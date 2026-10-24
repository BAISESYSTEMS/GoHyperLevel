import type { BuyerParty, DocSnapshot } from './einvoice-model.js';
import type { TaxGroup, TaxMode } from './invoice-model.js';

/**
 * Live sync of finalised invoices to Lexware Office (formerly lexoffice) and sevDesk – the pure part: providers and their mapping
 * options, the payloads (contact, voucher / invoice / credit note), what the tools say about payments, retry timing and a rate
 * limiter. HTTP lives in books-sync-http.ts, the database side in modules/books-sync.ts. Docs: docs/integrations.md#lexware-office-and-sevdesk-live-sync.
 *
 * HyperLevel stays the issuer: its number, its frozen snapshot and its PDF are what the tool receives.
 *  - Lexware Office: a sales voucher (Beleg, `salesinvoice` / `salescreditnote`) with one item per tax rate, the HyperLevel number as
 *    voucher number and the HyperLevel PDF attached – Lexware books it, nothing is issued twice.
 *  - sevDesk: an invoice (Invoice/Factory/saveInvoice) with the HyperLevel number and the lines, marked as sent without sending it;
 *    a Storno cancels the linked sevDesk invoice, a partial credit note becomes a sevDesk credit note.
 */

export type Provider = 'lexware' | 'sevdesk';
export const PROVIDERS: Provider[] = ['lexware', 'sevdesk'];
export const PROVIDER_LABEL: Record<Provider, string> = { lexware: 'Lexware Office', sevdesk: 'sevDesk' };
export const isProvider = (v: unknown): v is Provider => v === 'lexware' || v === 'sevdesk';

/** Requests per second the tools allow: Lexware Office documents 2/s per key, sevDesk names no limit (we stay at 4/s). */
export const INTERVAL_MS: Record<Provider, number> = { lexware: 520, sevdesk: 250 };

/** Lexware Office posting category "Einnahmen" (revenue) – the one their documentation uses for sales vouchers. */
export const LEX_REVENUE_CATEGORY = '8f8664a8-fd86-11e1-a21f-0800200c9a66';

export interface SyncOptions {
  /** auto: cached link → customer number → e-mail → create; collective: Lexware "Sammelkunde" / no contact link. */
  contact_match: 'auto' | 'collective';
  /** Custom field of the contact that holds the customer number in the tool (the Umzug importer fills `customer_number`). */
  customer_number_field: string;
  push_credit_notes: boolean;
  pull_payments: boolean;
  /** Lexware: attach HyperLevel's PDF to the voucher. */
  attach_pdf: boolean;
  /** Lexware: posting category of the voucher items. */
  category_id: string;
  /** sevDesk: mark the invoice as sent (status "offen") without sending anything. */
  mark_sent: boolean;
  /** sevDesk: contact person (SevUser id) – filled in by "Verbindung testen" when empty. */
  sev_user_id: string;
  /** sevDesk: unit of the positions (1 = Stück). */
  unity_id: string;
}

export const DEFAULT_OPTIONS: SyncOptions = {
  contact_match: 'auto',
  customer_number_field: 'customer_number',
  push_credit_notes: true,
  pull_payments: true,
  attach_pdf: true,
  category_id: LEX_REVENUE_CATEGORY,
  mark_sent: true,
  sev_user_id: '',
  unity_id: '1',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mapping options from a request, on top of the stored ones; throws a German message for bad values. */
export function cleanOptions(input: Record<string, unknown> | undefined, cur: Partial<SyncOptions> = {}): SyncOptions {
  const o: SyncOptions = { ...DEFAULT_OPTIONS, ...cur };
  const b = input ?? {};
  if (b.contact_match !== undefined) {
    if (b.contact_match !== 'auto' && b.contact_match !== 'collective') throw new Error('Kontakt-Abgleich: auto oder collective');
    o.contact_match = b.contact_match;
  }
  if (b.customer_number_field !== undefined) {
    const k = String(b.customer_number_field ?? '').trim();
    if (k && !/^[A-Za-z0-9_]{1,60}$/.test(k)) throw new Error('Feld für die Kundennummer: Schlüssel eines eigenen Feldes (Buchstaben, Ziffern, _)');
    o.customer_number_field = k;
  }
  for (const k of ['push_credit_notes', 'pull_payments', 'attach_pdf', 'mark_sent'] as const) if (b[k] !== undefined) o[k] = !!b[k];
  if (b.category_id !== undefined) {
    const c = String(b.category_id ?? '').trim() || LEX_REVENUE_CATEGORY;
    if (!UUID.test(c)) throw new Error('Buchungskategorie: eine ID wie 8f8664a8-fd86-11e1-a21f-0800200c9a66');
    o.category_id = c.toLowerCase();
  }
  for (const k of ['sev_user_id', 'unity_id'] as const) {
    if (b[k] === undefined) continue;
    const v = String(b[k] ?? '').trim();
    if (v && !/^\d{1,12}$/.test(v)) throw new Error(k === 'sev_user_id' ? 'sevDesk-Benutzer: nur Ziffern' : 'Einheit: nur Ziffern');
    o[k] = v || (k === 'unity_id' ? '1' : '');
  }
  return o;
}

// --- retry timing ---------------------------------------------------------------------------------------------------

/** Waits after the n-th failed attempt (1-based): 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h – then the job is given up. */
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const backoffMs = (attempt: number): number | null => (attempt >= MAX_ATTEMPTS ? null : BACKOFF_MS[Math.max(0, attempt - 1)]);

/**
 * Spaces calls per key: every caller reserves the next free slot, so parallel jobs of one account still go out one per
 * interval (Lexware Office: two a second). `now`/`sleep` are injectable for tests.
 */
export class RateLimiter {
  private next = new Map<string, number>();
  constructor(private o: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {}
  async wait(key: string, intervalMs: number): Promise<number> {
    const t = this.o.now?.() ?? Date.now();
    const at = Math.max(t, this.next.get(key) ?? 0);
    this.next.set(key, at + intervalMs);
    if (this.next.size > 5000) this.next.delete(this.next.keys().next().value!);
    const wait = at - t;
    if (wait > 0) await (this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
    return wait;
  }
}

// --- amounts and dates ---------------------------------------------------------------------------------------------------

/** Cents → amount with two decimals as a number (what both APIs expect). */
export const amount = (cents: number): number => Math.round(cents) / 100;
/** yyyy-mm-dd → dd.mm.yyyy (sevDesk dates). */
export const deDate = (ymd: string): string => (/^\d{4}-\d\d-\d\d/.test(ymd) ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}` : '');

/** ISO 3166 alpha-2 from a free-text country (DE, Deutschland, Germany, Österreich …); '' when unknown. */
export function isoCountry(v: unknown): string {
  const s = String(v ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const k = s.toLowerCase();
  const map: Record<string, string> = { deutschland: 'DE', germany: 'DE', österreich: 'AT', oesterreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH', niederlande: 'NL', netherlands: 'NL', frankreich: 'FR', france: 'FR', italien: 'IT', italy: 'IT', spanien: 'ES', spain: 'ES', belgien: 'BE', belgium: 'BE', luxemburg: 'LU', polen: 'PL', poland: 'PL', dänemark: 'DK', denmark: 'DK' };
  return map[k] ?? '';
}

/**
 * The tax groups that are revenue of this document: a final invoice (Schlussrechnung) without the partial invoices it deducts
 * (they were booked on their own), every amount positive (a credit note's type carries the sign).
 */
export function bookedGroups(doc: Pick<DocSnapshot, 'totals' | 'deductions'>): TaxGroup[] {
  const map = new Map<string, TaxGroup>();
  for (const g of doc.totals.groups) map.set(`${g.category}|${g.rate}`, { ...g });
  for (const d of doc.deductions ?? [])
    for (const g of d.groups ?? []) {
      const k = `${g.category}|${g.rate}`;
      const cur = map.get(k) ?? { category: g.category, rate: g.rate, net_cents: 0, tax_cents: 0 };
      cur.net_cents -= g.net_cents;
      cur.tax_cents -= g.tax_cents;
      map.set(k, cur);
    }
  return [...map.values()]
    .map((g) => ({ ...g, net_cents: Math.abs(g.net_cents), tax_cents: Math.abs(g.tax_cents) }))
    .filter((g) => g.net_cents !== 0 || g.tax_cents !== 0);
}

/** Gross amount the tool books for this document (positive). */
export const bookedTotalCents = (doc: Pick<DocSnapshot, 'totals' | 'deductions'>): number => bookedGroups(doc).reduce((n, g) => n + g.net_cents + g.tax_cents, 0);

// --- contacts ---------------------------------------------------------------------------------------------------------------

export interface ContactInput {
  first_name?: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  customer_number?: string;
}

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Lexware Office contact (role customer): a company with its contact person, or a person. */
export function lexContact(c: ContactInput, buyer: BuyerParty): Record<string, any> {
  const country = isoCountry(buyer.country);
  const out: Record<string, any> = { version: 0, roles: { customer: {} } };
  const company = clip(c.company || buyer.company, 150);
  const first = clip(c.first_name, 80);
  const last = clip(c.last_name, 80) || (!company ? clip(buyer.name, 80) || 'Unbekannt' : '');
  if (company) out.company = { name: company, ...(buyer.vat_id ? { vatRegistrationId: buyer.vat_id } : {}), ...(last ? { contactPersons: [{ ...(first ? { firstName: first } : {}), lastName: last, ...(c.email ? { emailAddress: clip(c.email, 150) } : {}), primary: true }] } : {}) };
  else out.person = { ...(first ? { firstName: first } : {}), lastName: last };
  if (buyer.street || buyer.city) out.addresses = { billing: [{ street: clip(buyer.street, 150), zip: clip(buyer.postal_code, 20), city: clip(buyer.city, 80), countryCode: country || 'DE' }] };
  if (c.email) out.emailAddresses = { business: [clip(c.email, 150)] };
  if (c.phone) out.phoneNumbers = { business: [clip(c.phone, 40)] };
  return out;
}

/** sevDesk contact (category 3 = Kunde): an organisation or a person; e-mail goes in afterwards as a communication way. */
export function sevContact(c: ContactInput, buyer: BuyerParty): Record<string, any> {
  const company = clip(c.company || buyer.company, 150);
  const base: Record<string, any> = { category: { id: 3, objectName: 'Category' }, ...(c.customer_number ? { customerNumber: clip(c.customer_number, 60) } : {}) };
  if (company) return { ...base, name: company, ...(buyer.vat_id ? { vatNumber: buyer.vat_id } : {}) };
  return { ...base, surename: clip(c.first_name, 80), familyname: clip(c.last_name, 80) || clip(buyer.name, 80) || 'Unbekannt' };
}

// --- Lexware Office voucher ----------------------------------------------------------------------------------------------

export interface LexVoucherInput {
  contactId?: string;
  categoryId: string;
  remark?: string;
}

/** A sales voucher with one item per tax rate (what Lexware books), dates in yyyy-mm-dd, the HyperLevel number as voucher number. */
export function lexVoucher(doc: DocSnapshot, o: LexVoucherInput): Record<string, any> {
  const groups = bookedGroups(doc);
  const credit = doc.kind === 'credit_note';
  return {
    type: credit ? 'salescreditnote' : 'salesinvoice',
    voucherNumber: doc.number,
    voucherDate: doc.issued_ymd,
    ...(doc.supply_from ? { shippingDate: doc.supply_from } : {}),
    ...(!credit && doc.due_ymd ? { dueDate: doc.due_ymd } : {}),
    totalGrossAmount: amount(groups.reduce((n, g) => n + g.net_cents + g.tax_cents, 0)),
    totalTaxAmount: amount(groups.reduce((n, g) => n + g.tax_cents, 0)),
    taxType: 'net',
    ...(o.contactId ? { contactId: o.contactId, useCollectiveContact: false } : { useCollectiveContact: true }),
    remark: clip(o.remark ?? `Aus HyperLevel übertragen: ${doc.title || doc.number}`, 250),
    voucherItems: groups.map((g) => ({ amount: amount(g.net_cents), taxAmount: amount(g.tax_cents), taxRatePercent: g.rate, categoryId: o.categoryId })),
  };
}

/** Remote paid amount (cents) from GET /v1/payments/{id}: the booked gross minus what is still open. */
export function lexPaid(p: any, bookedCents: number): { paidCents: number; paidAt: string | null; settled: boolean } {
  const open = Math.round(Math.abs(Number(p?.openAmount ?? NaN)) * 100);
  if (!Number.isFinite(open)) return { paidCents: 0, paidAt: null, settled: false };
  const settled = p?.paymentStatus === 'balanced' || p?.voucherStatus === 'paid' || open === 0;
  const items: any[] = Array.isArray(p?.paymentItems) ? p.paymentItems : [];
  const last = items.map((i) => String(i?.postingDate ?? '')).filter(Boolean).sort().pop();
  return { paidCents: Math.max(0, bookedCents - open), paidAt: (p?.paidDate as string) || last || null, settled };
}

// --- sevDesk invoice / credit note ----------------------------------------------------------------------------------------

/** sevDesk tax rules (bookkeeping version 2.0) for revenue. */
export const SEV_TAX_RULE: Record<TaxMode, number> = { standard: 1, export: 2, ig_supply: 3, tax_free: 4, reverse_charge: 5, small_business: 11 };
/** The older field (bookkeeping version 1.0), sent as well so both kinds of accounts understand the invoice. */
export const SEV_TAX_TYPE: Record<TaxMode, string> = { standard: 'default', export: 'noteu', ig_supply: 'eu', tax_free: 'default', reverse_charge: 'eu', small_business: 'ss' };

export interface SevDocInput {
  contactId: string;
  sevUserId: string;
  unityId: string;
}

const sevAddress = (b: BuyerParty) => [b.company || b.name, b.company && b.name !== b.company ? b.name : '', b.street, [b.postal_code, b.city].filter(Boolean).join(' '), b.country].filter((x) => x && String(x).trim()).join('\n');

/** Positions: the document's lines (positive quantities for credit notes) plus one negative line per deducted partial invoice. */
function sevPositions(doc: DocSnapshot, unityId: string, kind: 'InvoicePos' | 'CreditNotePos') {
  const credit = doc.kind === 'credit_note';
  const pos: Record<string, any>[] = doc.items.map((it, i) => {
    const qty = credit ? Math.abs(Number(it.qty)) : Number(it.qty);
    const rate = doc.tax_mode === 'standard' ? Number(it.tax_rate) || 0 : 0;
    return { objectName: kind, mapAll: true, quantity: qty, price: amount(it.price_cents), priceNet: amount(it.price_cents), name: clip(it.name, 250) || `Position ${i + 1}`, ...(it.description ? { text: String(it.description).slice(0, 1000) } : {}), unity: { id: Number(unityId) || 1, objectName: 'Unity' }, taxRate: rate, positionNumber: i };
  });
  for (const d of doc.deductions ?? [])
    for (const g of d.groups ?? [])
      pos.push({ objectName: kind, mapAll: true, quantity: 1, price: -amount(g.net_cents), priceNet: -amount(g.net_cents), name: clip(`Abzüglich Abschlagsrechnung ${d.number}`, 250), unity: { id: Number(unityId) || 1, objectName: 'Unity' }, taxRate: g.rate, positionNumber: pos.length });
  return pos;
}

/** Body of POST /Invoice/Factory/saveInvoice: a draft (status 100) with HyperLevel's number; "sendBy" marks it sent afterwards. */
export function sevInvoice(doc: DocSnapshot, o: SevDocInput): Record<string, any> {
  const days = doc.due_ymd && doc.issued_ymd ? Math.max(0, Math.round((Date.parse(`${doc.due_ymd}T00:00:00Z`) - Date.parse(`${doc.issued_ymd}T00:00:00Z`)) / 864e5)) : 14;
  const country = isoCountry(doc.buyer.country);
  return {
    invoice: {
      objectName: 'Invoice',
      mapAll: true,
      invoiceNumber: doc.number,
      contact: { id: Number(o.contactId) || o.contactId, objectName: 'Contact' },
      contactPerson: { id: Number(o.sevUserId) || o.sevUserId, objectName: 'SevUser' },
      invoiceDate: deDate(doc.issued_ymd),
      deliveryDate: deDate(doc.supply_from || doc.issued_ymd),
      ...(doc.supply_to ? { deliveryDateUntil: deDate(doc.supply_to) } : {}),
      header: clip(`${doc.inv_type === 'partial' ? 'Abschlagsrechnung' : doc.inv_type === 'final' ? 'Schlussrechnung' : 'Rechnung'} ${doc.number}`, 250),
      ...(doc.title ? { headText: clip(doc.title, 1000) } : {}),
      footText: clip([doc.tax_note, doc.notes].filter(Boolean).join('\n'), 2000),
      timeToPay: days,
      discount: 0,
      address: sevAddress(doc.buyer),
      ...(country === 'DE' ? { addressCountry: { id: 1, objectName: 'StaticCountry' } } : {}),
      status: 100,
      invoiceType: doc.inv_type === 'partial' ? 'TR' : doc.inv_type === 'final' ? 'ER' : 'RE',
      currency: doc.currency || 'EUR',
      showNet: true,
      taxRule: { id: String(SEV_TAX_RULE[doc.tax_mode] ?? 1), objectName: 'TaxRule' },
      taxType: SEV_TAX_TYPE[doc.tax_mode] ?? 'default',
      taxText: doc.tax_mode === 'standard' ? 'Umsatzsteuer' : clip(doc.tax_note || 'Ohne Umsatzsteuer', 200),
      taxRate: 0,
    },
    invoicePosSave: sevPositions(doc, o.unityId, 'InvoicePos'),
    invoicePosDelete: null,
    takeDefaultAddress: false,
  };
}

/** Body of POST /CreditNote/Factory/saveCreditNote for a partial credit note (Rechnungskorrektur / Gutschrift). */
export function sevCreditNote(doc: DocSnapshot, o: SevDocInput): Record<string, any> {
  return {
    creditNote: {
      objectName: 'CreditNote',
      mapAll: true,
      creditNoteNumber: doc.number,
      contact: { id: Number(o.contactId) || o.contactId, objectName: 'Contact' },
      contactPerson: { id: Number(o.sevUserId) || o.sevUserId, objectName: 'SevUser' },
      creditNoteDate: deDate(doc.issued_ymd),
      deliveryDate: deDate(doc.supply_from || doc.issued_ymd),
      header: clip(`Gutschrift ${doc.number}${doc.ref?.number ? ` zu ${doc.ref.number}` : ''}`, 250),
      ...(doc.notes ? { headText: clip(doc.notes, 1000) } : {}),
      address: sevAddress(doc.buyer),
      status: 100,
      bookingCategory: 'UNDERACHIEVEMENT',
      currency: doc.currency || 'EUR',
      showNet: true,
      taxRule: { id: String(SEV_TAX_RULE[doc.tax_mode] ?? 1), objectName: 'TaxRule' },
      taxType: SEV_TAX_TYPE[doc.tax_mode] ?? 'default',
      taxText: doc.tax_mode === 'standard' ? 'Umsatzsteuer' : clip(doc.tax_note || 'Ohne Umsatzsteuer', 200),
      taxRate: 0,
    },
    creditNotePosSave: sevPositions(doc, o.unityId, 'CreditNotePos'),
    creditNotePosDelete: null,
  };
}

/** Remote paid amount (cents) from GET /Invoice/{id}: status 1000 = bezahlt, 750 = teilweise bezahlt. */
export function sevPaid(inv: any, bookedCents: number): { paidCents: number; paidAt: string | null; settled: boolean } {
  const status = String(inv?.status ?? '');
  const settled = status === '1000';
  const paid = Math.round(Math.abs(Number(inv?.paidAmount ?? 0)) * 100);
  return { paidCents: settled ? Math.max(paid, bookedCents) : Number.isFinite(paid) ? paid : 0, paidAt: inv?.payDate ? String(inv.payDate) : null, settled };
}
