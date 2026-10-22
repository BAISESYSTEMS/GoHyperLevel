import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str } from '../core/http.js';
import { ymdInTz } from '../core/time.js';
import { centsToMoney, id, now, token } from '../core/util.js';
import { contactName, getContact, logActivity } from './contacts.js';
import type { BankInfo, BuyerParty, DocSnapshot, SellerParty } from './einvoice-model.js';
import { composeSnapshot, snapshotHash } from './invoice-doc.js';
import {
  calcTotals,
  checkCompliance,
  checkVatId,
  cleanYmd,
  formatNumber,
  isDraftNumber,
  isTaxMode,
  negateItems,
  openCents,
  creditClosed,
  parseAddress,
  rangeCfg,
  rangePeriod,
  skontoCents,
  skontoDeadline,
  unitCode,
  DRAFT_PREFIX,
  type CreditType,
  type Deduction,
  type InvType,
  type LineItem,
  type RangeKey,
  type TaxMode,
  ymd,
} from './invoice-model.js';

/**
 * The database side of invoicing: reading an invoice in its parsed form, the parties of a document, gap-free numbers,
 * finalising (GoBD: number, freeze, snapshot and SHA-256 in one transaction), Storno and credit notes, quotes → invoices,
 * partial payments, the audit trail and the integrity check. HTTP stays in modules/invoicing.ts and modules/payments.ts.
 */

export interface Actor {
  id?: string | null;
  name: string;
}
export const SYSTEM: Actor = { id: null, name: 'System' };
export const actorOf = (ctx: { user?: { id: string; name: string } | undefined; via?: string }): Actor => (ctx.user ? { id: ctx.user.id, name: ctx.user.name } : { id: null, name: ctx.via === 'agency_key' || ctx.via === 'api_key' ? 'API-Schlüssel' : 'System' });

export type Inv = Record<string, any> & {
  id: string;
  location_id: string;
  kind: 'invoice' | 'estimate' | 'credit_note';
  number: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  credit_type: string;
  inv_type: string;
  items: LineItem[];
  deduct_ids: string[];
  snapshot: DocSnapshot | null;
};

export const tzOf = (app: App, loc: string) => app.location(loc)?.timezone ?? 'Europe/Berlin';
export const billingSettings = (app: App, loc: string): Record<string, any> => app.location(loc)?.settings.invoices ?? {};

export function parseInv(row: any): Inv {
  const r = parseJson(row, ['items', 'recurring', 'deduct_ids', 'snapshot']) as any;
  if (!Array.isArray(r.items)) r.items = [];
  if (!Array.isArray(r.deduct_ids)) r.deduct_ids = [];
  if (typeof r.snapshot === 'string' || !r.snapshot) r.snapshot = null;
  return r;
}

export function loadInvoice(app: App, loc: string, invoiceId: string): Inv | undefined {
  const row = app.db.get('SELECT * FROM invoices WHERE id = ? AND location_id = ?', invoiceId, loc);
  return row ? parseInv(row) : undefined;
}

export const mustInvoice = (app: App, loc: string, invoiceId: string): Inv => {
  const inv = loadInvoice(app, loc, invoiceId);
  if (!inv) throw notFound();
  return inv;
};

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// --- audit trail ----------------------------------------------------------------------------------------------------------

/** Append-only trail of everything that happens to an invoice (the database refuses changes and deletions). */
export function invAudit(app: App, loc: string, invoiceId: string | null, action: string, detail = '', actor: Actor = SYSTEM) {
  app.db.run('INSERT INTO invoice_audit (id, location_id, invoice_id, at, actor, user_id, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id(), loc, invoiceId, now(), clip(actor.name, 200) || 'System', actor.id ?? null, action.slice(0, 80), String(detail).slice(0, 600));
}

// --- parties of a document ---------------------------------------------------------------------------------------------

/** The sender and its bank data from the sub-account and the invoice settings (old and new setting names both work). */
export function sellerOf(app: App, loc: string): { seller: SellerParty; bank: BankInfo } {
  const L = app.location(loc)!;
  const s = L.settings.invoices ?? {};
  const a = parseAddress(String(L.address ?? ''));
  const legacy = String(s.tax_id ?? '').trim();
  const legacyIsVat = checkVatId(legacy).valid;
  return {
    seller: {
      name: clip(L.name, 150),
      street: clip(s.street || a.street, 150),
      postal_code: clip(s.postal_code || a.postal_code, 20),
      city: clip(s.city || a.city, 80),
      country: clip(s.country, 40) || 'DE',
      email: clip(s.contact_email || L.email, 150),
      phone: clip(s.contact_phone || L.phone, 40),
      contact_name: clip(s.contact_name, 100),
      vat_id: checkVatId(s.vat_id || (legacyIsVat ? legacy : '')).normalized,
      tax_number: clip(s.tax_number || (legacy && !legacyIsVat ? legacy : ''), 40),
      footer: clip(s.footer, 400),
    },
    bank: { iban: String(s.iban ?? '').replace(/\s+/g, '').toUpperCase(), bic: String(s.bic ?? '').replace(/\s+/g, '').toUpperCase(), bank: clip(s.bank, 100) },
  };
}

export function buyerOf(app: App, loc: string, inv: Inv): BuyerParty {
  const c = inv.contact_id ? getContact(app, loc, inv.contact_id) : undefined;
  const person = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '';
  return {
    name: clip(person || c?.company || (c ? contactName(c) : ''), 150),
    company: clip(c?.company, 150),
    street: clip(c?.address, 150),
    postal_code: clip(c?.postal_code, 20),
    city: clip(c?.city, 80),
    country: clip(c?.country, 40),
    email: clip(c?.email, 150),
    phone: clip(c?.phone, 40),
    vat_id: checkVatId(inv.buyer_vat_id).normalized || clip(inv.buyer_vat_id, 20),
    leitweg_id: clip(inv.leitweg_id, 60),
    buyer_ref: clip(inv.buyer_ref, 100),
  };
}

function refOf(app: App, loc: string, refId: string | null | undefined) {
  if (!refId) return null;
  return app.db.get<{ id: string; number: string; issued_at: string }>('SELECT id, number, issued_at FROM invoices WHERE id = ? AND location_id = ?', refId, loc) ?? null;
}

/** The deductions of a final invoice, read from the partial invoices (which must be finalised, not cancelled, same customer and currency, and not deducted elsewhere). */
export function loadDeductions(app: App, loc: string, inv: Inv): Deduction[] {
  if (inv.inv_type !== 'final' || !inv.deduct_ids.length) return [];
  const out: Deduction[] = [];
  for (const pid of inv.deduct_ids) {
    const p = loadInvoice(app, loc, pid);
    if (!p || p.kind !== 'invoice' || p.inv_type !== 'partial' || !p.finalised_at || p.status === 'void') throw bad(`Die Abschlagsrechnung${p ? ` ${p.number}` : ''} kann nicht abgezogen werden – sie muss festgeschrieben, nicht storniert und eine Abschlagsrechnung sein`);
    if (p.currency !== inv.currency) throw bad(`Abschlagsrechnung ${p.number}: andere Währung`);
    if (inv.contact_id && p.contact_id && p.contact_id !== inv.contact_id) throw bad(`Abschlagsrechnung ${p.number} gehört zu einem anderen Kunden`);
    const taken = app.db.get<{ number: string }>(`SELECT f.number FROM invoices f, json_each(f.deduct_ids) j WHERE f.location_id = ? AND f.id != ? AND f.inv_type = 'final' AND f.finalised_at IS NOT NULL AND f.status != 'void' AND j.value = ?`, loc, inv.id, pid);
    if (taken) throw bad(`Abschlagsrechnung ${p.number} ist schon in der Schlussrechnung ${taken.number} abgezogen`);
    const t = p.snapshot?.totals ?? calcTotals(p.items, p.tax_mode as TaxMode, p.calc === 'group' ? 'group' : 'line');
    out.push({ id: p.id, number: p.number, issued_at: p.issued_at, issued_ymd: p.snapshot?.issued_ymd || ymd(p.issued_at, tzOf(app, loc)), net_cents: t.subtotal_cents, tax_cents: t.tax_cents, total_cents: t.total_cents, groups: t.groups });
  }
  return out;
}

/** Candidates for deduction: finalised, open partial invoices of the same customer that no final invoice used yet. */
export function deductionCandidates(app: App, loc: string, inv: Inv) {
  if (!inv.contact_id) return [];
  return app.db.all<any>(
    `SELECT p.id, p.number, p.issued_at, p.total_cents, p.currency, p.status FROM invoices p
     WHERE p.location_id = ? AND p.contact_id = ? AND p.kind = 'invoice' AND p.inv_type = 'partial' AND p.finalised_at IS NOT NULL AND p.status != 'void' AND p.currency = ?
       AND NOT EXISTS (SELECT 1 FROM invoices f, json_each(f.deduct_ids) j WHERE f.id != ? AND f.inv_type = 'final' AND f.finalised_at IS NOT NULL AND f.status != 'void' AND j.value = p.id)
     ORDER BY p.issued_at`,
    loc,
    inv.contact_id,
    inv.currency,
    inv.id,
  );
}

/** The document of an invoice as it reads now: the frozen snapshot (plus the two editable fields) for finalised ones, a live composition for drafts and quotes. */
export function docOf(app: App, inv: Inv): DocSnapshot {
  const tz = tzOf(app, inv.location_id);
  if (inv.snapshot && inv.finalised_at) return { ...inv.snapshot, notes: inv.notes ?? '', due_ymd: inv.due_at ? ymd(inv.due_at, tz) : '' };
  return composeLive(app, inv.location_id, inv);
}

export function composeLive(app: App, loc: string, inv: Inv, over: { number?: string; issued_at?: string; deductions?: Deduction[]; vies?: DocSnapshot['vies']; calc?: 'group' | 'line' } = {}): DocSnapshot {
  const { seller, bank } = sellerOf(app, loc);
  const skonto = inv.skonto_percent && inv.skonto_days ? { percent: Number(inv.skonto_percent), days: Number(inv.skonto_days) } : null;
  const deductions = over.deductions ?? (inv.inv_type === 'final' && !inv.finalised_at ? safeDeductions(app, loc, inv) : []);
  return composeSnapshot({
    kind: inv.kind,
    inv_type: (inv.inv_type as InvType) || 'standard',
    credit_type: (inv.credit_type as CreditType | '') || '',
    number: over.number ?? (isDraftNumber(inv.number) ? '' : inv.number),
    issued_at: over.issued_at ?? inv.issued_at,
    due_at: inv.due_at,
    tz: tzOf(app, loc),
    currency: inv.currency,
    title: inv.title,
    notes: inv.notes,
    tax_mode: isTaxMode(inv.tax_mode) ? inv.tax_mode : 'standard',
    tax_note: inv.tax_note,
    calc: over.calc ?? (inv.calc === 'line' ? 'line' : 'group'),
    supply_from: inv.supply_from ?? '',
    supply_to: inv.supply_to ?? '',
    items: inv.items,
    deductions,
    skonto,
    ref: refOf(app, loc, inv.ref_id),
    seller,
    buyer: buyerOf(app, loc, inv),
    bank,
    vies: over.vies,
  });
}

function safeDeductions(app: App, loc: string, inv: Inv): Deduction[] {
  try {
    return loadDeductions(app, loc, inv);
  } catch {
    return [];
  }
}

// --- line items -------------------------------------------------------------------------------------------------------------

/** Cleans the lines of a document. Tax modes other than the regular one force 0 % (the mode carries the legal text). */
export function cleanItems(input: unknown, defaultTax: number, mode: TaxMode = 'standard'): LineItem[] {
  if (!Array.isArray(input) || !input.length) throw bad('Mindestens eine Position');
  return input.slice(0, 200).map((it: any) => {
    // A negative quantity ("Rabatt, −1 × 10 €") is a deduction: the sign moves to the price (it used to become 0 and the
    // discount vanished from the total without a word). Credit notes are entered positive and negated by their own code.
    const q = Math.round(num(it?.qty, 1) * 10000) / 10000;
    const p = Math.round(num(it?.price_cents, 0));
    const item: LineItem = {
      name: str(it?.name, 'Position', { required: true, max: 300 }),
      description: str(it?.description, 'Beschreibung', { max: 2000 }),
      qty: Math.abs(q),
      price_cents: q < 0 ? -p : p,
      tax_rate: mode === 'standard' ? Math.max(0, num(it?.tax_rate, defaultTax)) : 0,
    };
    if (it?.unit !== undefined && it.unit !== '' && unitCode(it.unit) !== 'C62') item.unit = unitCode(it.unit);
    else if (it?.unit === 'C62') item.unit = 'C62';
    return item;
  });
}

// --- numbers -------------------------------------------------------------------------------------------------------------------

export const draftNumber = () => `${DRAFT_PREFIX}${token(6).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 8)}`;

/**
 * The next number of a range, gap-free: one atomic counter row per (sub-account, range, year). Call inside the transaction that
 * stores the number on the invoice – a rollback then rolls the counter back too, so no number is ever consumed without a document.
 * A number that already exists (imported documents) is skipped; that is the only way a number is left out.
 */
export function allocateNumber(app: App, loc: string, range: RangeKey, issuedAt: string): string {
  const cfg = rangeCfg(billingSettings(app, loc), range);
  const year = ymdInTz(new Date(issuedAt), tzOf(app, loc)).slice(0, 4);
  const period = rangePeriod(cfg, year);
  for (let i = 0; i < 1000; i++) {
    const row = app.db.get<{ last: number }>(
      `INSERT INTO invoice_counters (location_id, range, period, last) VALUES (?, ?, ?, ?)
       ON CONFLICT(location_id, range, period) DO UPDATE SET last = last + 1 RETURNING last`,
      loc,
      range,
      period,
      cfg.start,
    );
    const number = formatNumber(cfg, row!.last, year);
    if (!app.db.get('SELECT 1 AS x FROM invoices WHERE location_id = ? AND number = ?', loc, number)) return number;
  }
  throw new HttpError(409, 'Keine freie Nummer gefunden – bitte den Nummernkreis prüfen (Einstellungen → Rechnungen)');
}

export const rangeOf = (inv: Pick<Inv, 'kind' | 'credit_type'>): RangeKey => (inv.kind === 'estimate' ? 'estimate' : inv.kind === 'credit_note' ? (inv.credit_type === 'storno' ? 'storno' : 'credit') : 'invoice');

/** Where each range stands: the settings, the last number given out and the next one. */
export function rangeStatus(app: App, loc: string, range: RangeKey) {
  const cfg = rangeCfg(billingSettings(app, loc), range);
  const year = ymdInTz(new Date(), tzOf(app, loc)).slice(0, 4);
  const period = rangePeriod(cfg, year);
  const row = app.db.get<{ last: number }>('SELECT last FROM invoice_counters WHERE location_id = ? AND range = ? AND period = ?', loc, range, period);
  const next = row ? row.last + 1 : cfg.start;
  return { ...cfg, period, last: row?.last ?? null, next, example: formatNumber(cfg, next, year) };
}

// --- finalising ------------------------------------------------------------------------------------------------------------------

export interface FinaliseOptions {
  actor?: Actor;
  /** Explicit invoice date (ISO); default: today for drafts whose date was never chosen, else the date of the draft. */
  issued_at?: string;
  vies?: DocSnapshot['vies'];
  /** An invoice another module already flipped to "sent" with raw SQL: keep its date and old rounding, only add number and freeze. */
  adopt?: boolean;
  warnings?: string[];
}

const partyInfo = (p: { name: string; company?: string; street: string; postal_code: string; city: string; country: string; email: string; phone: string; vat_id: string; tax_number?: string }) => ({
  name: p.company || p.name,
  address: p.street,
  postal_code: p.postal_code,
  city: p.city,
  country: p.country,
  email: p.email,
  phone: p.phone,
  vat_id: p.vat_id,
  tax_number: p.tax_number,
});

/**
 * GoBD finalising: gap-free number, frozen content, snapshot and SHA-256 – all in one transaction, so a failure leaves a
 * draft untouched and no number consumed. Afterwards the database refuses changes to everything but note and due date.
 */
export function finaliseInvoice(app: App, loc: string, invoiceId: string, o: FinaliseOptions = {}): { invoice: Inv; warnings: string[] } {
  const actor = o.actor ?? SYSTEM;
  const warnings: string[] = [...(o.warnings ?? [])];
  const fin = app.db.tx(() => {
    const inv = mustInvoice(app, loc, invoiceId);
    if (inv.kind === 'estimate') throw bad('Angebote werden nicht festgeschrieben – wandle sie in eine Rechnung um');
    if (inv.finalised_at) throw new HttpError(409, 'Die Rechnung ist schon festgeschrieben');
    if (inv.status === 'void' && !(o.adopt && !isDraftNumber(inv.number))) throw new HttpError(409, 'Ein verworfener Entwurf lässt sich nicht festschreiben');
    const cfg = billingSettings(app, loc);
    const tz = tzOf(app, loc);
    const mode: TaxMode = isTaxMode(inv.tax_mode) ? inv.tax_mode : 'standard';
    const terms = Math.max(0, Number(cfg.payment_terms_days ?? 14));
    const issued_at = o.issued_at ? new Date(o.issued_at).toISOString() : inv.issued_auto && !o.adopt ? now() : inv.issued_at;
    if (Number.isNaN(new Date(issued_at).getTime())) throw bad('Ungültiges Rechnungsdatum');
    let due_at: string | null = inv.due_at;
    if (inv.kind === 'credit_note') due_at = null;
    else if (inv.issued_auto && !o.adopt && inv.due_at === new Date(new Date(inv.issued_at).getTime() + terms * 864e5).toISOString()) due_at = new Date(new Date(issued_at).getTime() + terms * 864e5).toISOString();

    // lines: modes without tax carry 0 %
    const items = mode === 'standard' ? inv.items : inv.items.map((it) => ({ ...it, tax_rate: 0 }));
    const calc: 'group' | 'line' = o.adopt ? 'line' : inv.calc === 'line' ? 'line' : 'group';
    const totals = calcTotals(items, mode, calc);

    // deductions (final invoice) or the ones of the cancelled final invoice (Storno)
    let deductions: Deduction[] = [];
    if (inv.inv_type === 'final') deductions = loadDeductions(app, loc, inv);
    else if (inv.kind === 'credit_note' && inv.credit_type === 'storno') deductions = refDeductions(app, loc, inv.ref_id);
    const deducted = deductions.reduce((n, d) => n + d.total_cents, 0);
    if (inv.inv_type === 'final' && deducted > totals.total_cents) throw bad('Die abgezogenen Abschlagsrechnungen sind höher als die Schlussrechnung');

    // credit notes may not credit more than the invoice
    if (inv.kind === 'credit_note' && inv.ref_id) {
      const orig = loadInvoice(app, loc, inv.ref_id);
      if (!orig || !orig.finalised_at) throw new HttpError(409, 'Die Gutschrift gehört zu einer Rechnung, die nicht (mehr) festgeschrieben ist');
      if (inv.credit_type === 'credit') {
        if (orig.status === 'void') throw new HttpError(409, creditClosed(orig) ? 'Die Rechnung ist schon vollständig gutgeschrieben – es ist nichts mehr offen' : 'Die Rechnung ist storniert – eine Gutschrift dazu ist nicht mehr möglich');
        if ((orig.credited_cents ?? 0) + Math.abs(totals.total_cents) > orig.total_cents) throw new HttpError(409, `Die Gutschriften würden die Rechnung ${orig.number} übersteigen (Rechnung ${centsToMoney(orig.total_cents, orig.currency)}, schon gutgeschrieben ${centsToMoney(orig.credited_cents ?? 0, orig.currency)})`);
      }
    }

    const number = !isDraftNumber(inv.number) && o.adopt ? inv.number : allocateNumber(app, loc, rangeOf(inv), issued_at);
    const supply_from = cleanYmd(inv.supply_from, 'Leistungsdatum') || ymdInTz(new Date(issued_at), tz);
    const supply_to = cleanYmd(inv.supply_to, 'Leistungszeitraum bis');

    const live = { ...inv, items, number, issued_at, due_at, tax_mode: mode, calc };
    const doc = composeLive(app, loc, live, { number, issued_at, deductions, vies: o.vies, calc });
    // compliance (legal content): errors always block, warnings only in strict mode
    const check = checkCompliance({
      kind: inv.kind,
      tax_mode: mode,
      tax_note: inv.tax_note,
      items,
      total_cents: totals.total_cents,
      seller: partyInfo(doc.seller),
      buyer: { ...partyInfo(doc.buyer), leitweg_id: doc.buyer.leitweg_id },
      inv_type: inv.inv_type,
      deductions,
      supply_from: inv.supply_from ?? '',
      supply_to: inv.supply_to ?? '',
    });
    if (!o.adopt) {
      const strict = !!cfg.finalise_strict;
      const blocking = strict ? [...check.errors, ...check.warnings] : check.errors;
      if (blocking.length) throw new HttpError(400, `Die Rechnung kann noch nicht festgeschrieben werden: ${blocking.join(' · ')}`, { errors: blocking, warnings: strict ? [] : check.warnings });
    }
    warnings.push(...check.warnings);
    const snapshot: DocSnapshot = { ...doc, number, issued_at, issued_ymd: ymdInTz(new Date(issued_at), tz), supply_from, supply_to, vies: o.vies ?? null };
    const hash = snapshotHash(snapshot);
    const at = now();
    const r = app.db.run(
      `UPDATE invoices SET number = ?, issued_at = ?, due_at = ?, items = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?, status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
         finalised_at = ?, finalised_by = ?, snapshot = ?, doc_hash = ?, supply_from = ?, supply_to = ?, deducted_cents = ?, calc = ?, issued_auto = 0, updated_at = ?
       WHERE id = ? AND location_id = ? AND finalised_at IS NULL`,
      number,
      issued_at,
      due_at,
      JSON.stringify(items),
      totals.subtotal_cents,
      totals.tax_cents,
      totals.total_cents,
      at,
      actor.name,
      JSON.stringify(snapshot),
      hash,
      supply_from,
      supply_to || null,
      deducted,
      calc,
      at,
      invoiceId,
      loc,
    );
    if (!r.changes) throw new HttpError(409, 'Die Rechnung wurde gerade anderweitig festgeschrieben');
    let closed: Inv | undefined;
    if (inv.kind === 'credit_note' && inv.ref_id && inv.credit_type === 'credit') {
      app.db.run('UPDATE invoices SET credited_cents = credited_cents + ?, updated_at = ? WHERE id = ?', Math.abs(totals.total_cents), at, inv.ref_id);
      // Credited in full with nothing paid: the invoice is closed like a cancelled one (no payment, no dunning, no Storno on top) –
      // the credit notes stand next to it. One paid in part keeps its status (see docs/invoicing.md, open questions).
      const shut = app.db.run(
        `UPDATE invoices SET status = 'void', cancelled_at = ?, updated_at = ? WHERE id = ? AND location_id = ? AND kind = 'invoice' AND status = 'sent' AND finalised_at IS NOT NULL
           AND paid_cents = 0 AND total_cents - deducted_cents - credited_cents <= 0`,
        at,
        at,
        inv.ref_id,
        loc,
      );
      if (shut.changes) {
        closed = mustInvoice(app, loc, inv.ref_id);
        invAudit(app, loc, inv.ref_id, 'invoice.credited', `Vollständig gutgeschrieben (${number}) – geschlossen`, actor);
      }
    }
    invAudit(app, loc, invoiceId, o.adopt ? 'invoice.adopted' : 'invoice.finalised', `${number} · ${centsToMoney(totals.total_cents, inv.currency)} · SHA-256 ${hash.slice(0, 16)}…`, actor);
    return { invoice: mustInvoice(app, loc, invoiceId), warnings, closed };
  });
  if (fin.closed?.contact_id) logActivity(app, loc, fin.closed.contact_id, 'invoice.credited', `Rechnung ${fin.closed.number} vollständig gutgeschrieben – geschlossen`);
  const inv = fin.invoice;
  if (inv.contact_id) logActivity(app, loc, inv.contact_id, 'invoice.finalised', `${inv.kind === 'credit_note' ? (inv.credit_type === 'storno' ? 'Stornorechnung' : 'Gutschrift') : 'Rechnung'} ${inv.number} festgeschrieben (${centsToMoney(inv.total_cents, inv.currency)})`);
  app.events.emit(loc, 'invoice.finalised', { contactId: inv.contact_id, invoice: stripSnapshot(inv) });
  return { invoice: fin.invoice, warnings: fin.warnings };
}

function refDeductions(app: App, loc: string, refId: string | null): Deduction[] {
  const orig = refId ? loadInvoice(app, loc, refId) : undefined;
  return orig?.snapshot?.deductions ?? [];
}

export const stripSnapshot = <T extends Record<string, any>>(inv: T): Omit<T, 'snapshot'> => {
  const { snapshot: _s, ...rest } = inv;
  return rest;
};

/** What finalising would say right now (the legal content check, the next number) – without doing anything. */
export function precheck(app: App, loc: string, invoiceId: string) {
  const inv = mustInvoice(app, loc, invoiceId);
  const strict = !!billingSettings(app, loc).finalise_strict;
  if (inv.finalised_at || inv.kind === 'estimate') return { final: !!inv.finalised_at, errors: [] as string[], warnings: [] as string[], strict, next_number: null as string | null };
  const mode: TaxMode = isTaxMode(inv.tax_mode) ? inv.tax_mode : 'standard';
  const items = mode === 'standard' ? inv.items : inv.items.map((it) => ({ ...it, tax_rate: 0 }));
  const totals = calcTotals(items, mode);
  const errors: string[] = [];
  let deductions: Deduction[] = [];
  try {
    deductions = inv.inv_type === 'final' ? loadDeductions(app, loc, inv) : inv.kind === 'credit_note' && inv.credit_type === 'storno' ? refDeductions(app, loc, inv.ref_id) : [];
  } catch (e) {
    errors.push((e as Error).message);
  }
  const doc = composeLive(app, loc, { ...inv, items }, { deductions });
  const check = checkCompliance({ kind: inv.kind, tax_mode: mode, tax_note: inv.tax_note, items, total_cents: totals.total_cents, seller: partyInfo(doc.seller), buyer: { ...partyInfo(doc.buyer), leitweg_id: doc.buyer.leitweg_id }, inv_type: inv.inv_type, deductions, supply_from: inv.supply_from ?? '', supply_to: inv.supply_to ?? '' });
  return { final: false, errors: [...errors, ...check.errors], warnings: check.warnings, strict, next_number: rangeStatus(app, loc, rangeOf(inv)).example };
}

/** Finalises the invoice when it is still a draft (or was flipped to "sent" behind the scenes); does nothing when it is final. */
export function ensureFinal(app: App, loc: string, invoiceId: string, o: FinaliseOptions = {}): Inv {
  const inv = mustInvoice(app, loc, invoiceId);
  if (inv.kind === 'estimate' || inv.finalised_at || inv.status === 'void') return inv;
  return finaliseInvoice(app, loc, invoiceId, { ...o, adopt: o.adopt ?? inv.status !== 'draft' }).invoice;
}

// --- Storno and credit notes --------------------------------------------------------------------------------------------------------

function insertCreditNote(app: App, loc: string, orig: Inv, o: { type: 'storno' | 'credit'; items: LineItem[]; title: string; notes: string }): Inv {
  const t = now();
  const row = {
    id: id(),
    location_id: loc,
    kind: 'credit_note',
    number: draftNumber(),
    contact_id: orig.contact_id,
    title: o.title,
    items: o.items,
    currency: orig.currency,
    ...(() => {
      const c = calcTotals(o.items, orig.tax_mode as TaxMode, o.type === 'storno' && orig.calc === 'line' ? 'line' : 'group');
      return { subtotal_cents: c.subtotal_cents, tax_cents: c.tax_cents, total_cents: c.total_cents };
    })(),
    status: 'draft',
    notes: o.notes,
    payment_link: null,
    public_token: token(18),
    issued_at: t,
    due_at: null,
    created_at: t,
    updated_at: t,
    tax_mode: orig.tax_mode,
    tax_note: orig.tax_note,
    supply_from: o.type === 'storno' ? orig.supply_from : null,
    supply_to: o.type === 'storno' ? orig.supply_to : null,
    buyer_vat_id: orig.buyer_vat_id,
    leitweg_id: orig.leitweg_id,
    buyer_ref: orig.buyer_ref,
    inv_type: 'standard',
    credit_type: o.type,
    ref_id: orig.id,
    deduct_ids: o.type === 'storno' ? orig.deduct_ids : [],
    calc: o.type === 'storno' && orig.calc === 'line' ? 'line' : 'group',
    issued_auto: 1,
  };
  app.db.insert('invoices', row);
  return mustInvoice(app, loc, row.id);
}

/**
 * Cancels a finalised invoice by a Stornorechnung: a new finalised document with the negative amounts and a reference; the original
 * becomes "storniert". A Stornorechnung reverses the whole invoice (§ 14 UStG practice), so it is refused once credit notes
 * (Gutschriften) were finalised for it: together with them it would credit more than the invoice was for. The rest is credited by
 * a credit note instead ("Restbetrag gutschreiben", createCreditNote with `remainder`).
 */
export function stornoInvoice(app: App, loc: string, invoiceId: string, o: { reason?: string; actor?: Actor } = {}): { storno: Inv; original: Inv; warnings: string[] } {
  const actor = o.actor ?? SYSTEM;
  const reason = clip(o.reason, 300);
  const res = app.db.tx(() => {
    let orig = mustInvoice(app, loc, invoiceId);
    if (orig.kind === 'credit_note') throw new HttpError(409, 'Stornorechnungen und Gutschriften lassen sich nicht stornieren – schreibe bei Bedarf eine neue Rechnung');
    if (orig.kind === 'estimate') throw new HttpError(409, 'Angebote werden verworfen, nicht storniert');
    if (orig.status === 'void') throw new HttpError(409, creditClosed(orig) ? 'Die Rechnung ist schon vollständig gutgeschrieben – es ist nichts mehr offen' : 'Die Rechnung ist schon storniert');
    if (orig.status === 'draft') throw new HttpError(409, 'Entwürfe werden gelöscht, nicht storniert');
    const credited = Number(orig.credited_cents ?? 0);
    if (credited > 0) {
      const money = (c: number) => centsToMoney(c, orig.currency);
      const left = remainderLeft(orig);
      throw new HttpError(
        409,
        `Zu ${orig.number} gibt es schon Gutschriften über ${money(credited)}. Eine Stornorechnung hebt immer die ganze Rechnung auf und würde zusammen mit ihnen mehr erstatten, als die Rechnung wert ist. ${left > 0 ? `Schreibe stattdessen den Rest per Gutschrift gut: „Restbetrag gutschreiben“ (${money(left)}).` : 'Es ist nichts mehr gutzuschreiben.'}`,
        { credited_cents: credited, remainder_cents: Math.max(0, left) },
      );
    }
    if (!orig.finalised_at) orig = ensureFinal(app, loc, orig.id, { actor, adopt: true });
    const cn = insertCreditNote(app, loc, orig, { type: 'storno', items: negateItems(orig.items), title: `Storno zu ${orig.number}${orig.title ? ` – ${orig.title}` : ''}`.slice(0, 300), notes: reason ? `Grund der Stornierung: ${reason}` : '' });
    const fin = finaliseInvoice(app, loc, cn.id, { actor });
    const t = now();
    app.db.run(`UPDATE invoices SET status = 'void', cancelled_at = ?, storno_id = ?, updated_at = ? WHERE id = ? AND status != 'void'`, t, fin.invoice.id, t, orig.id);
    invAudit(app, loc, orig.id, 'invoice.cancelled', `Stornorechnung ${fin.invoice.number}${reason ? ` · Grund: ${reason}` : ''}`, actor);
    return { storno: fin.invoice, original: mustInvoice(app, loc, orig.id), warnings: fin.warnings };
  });
  if (res.original.contact_id) logActivity(app, loc, res.original.contact_id, 'invoice.cancelled', `Rechnung ${res.original.number} storniert (Stornorechnung ${res.storno.number})`);
  app.events.emit(loc, 'invoice.cancelled', { contactId: res.original.contact_id, invoice: stripSnapshot(res.original), storno: stripSnapshot(res.storno) });
  return res;
}

/**
 * What a credit note for the rest may still credit: the invoice minus the credit notes so far – for a final invoice also minus
 * the partial invoices it deducts, which stay valid (as with its Stornorechnung, which refunds only what the final invoice asked for).
 */
const remainderLeft = (inv: Inv): number => inv.total_cents - (inv.inv_type === 'final' ? Number(inv.deducted_cents ?? 0) : 0) - Number(inv.credited_cents ?? 0);

/**
 * "Restbetrag gutschreiben": the lines of a credit note for what is not credited yet – what is left per tax rate of the invoice's
 * lines (minus the credit notes so far and, for a final invoice, the partial invoices it deducts), one line per rate. VAT is
 * rounded per rate, so the nets are moved by a cent where that makes the gross exactly what is left; where no net does (about one
 * case in ten with one rate) it stops a cent short and says so – never a cent above, which the credit limit would refuse anyway.
 */
function remainderCredit(app: App, loc: string, orig: Inv, mode: TaxMode): { items: LineItem[]; left: number; total: number } {
  const left = remainderLeft(orig);
  if (left <= 0) throw new HttpError(409, 'Für diese Rechnung ist nichts mehr gutzuschreiben');
  const net = new Map<number, number>();
  const add = (rate: number, cents: number) => {
    const r = mode === 'standard' ? Number(rate) || 0 : 0;
    net.set(r, (net.get(r) ?? 0) + cents);
  };
  for (const g of calcTotals(orig.items, mode, orig.calc === 'line' ? 'line' : 'group').groups) add(g.rate, g.net_cents);
  if (orig.inv_type === 'final') for (const d of orig.snapshot?.deductions ?? loadDeductions(app, loc, orig)) for (const g of d.groups ?? []) add(g.rate, -g.net_cents);
  // finalised credit notes of the invoice (stored negative, so their nets subtract)
  for (const row of app.db.all<{ items: string; calc: string }>(`SELECT items, calc FROM invoices WHERE location_id = ? AND ref_id = ? AND kind = 'credit_note' AND credit_type = 'credit' AND finalised_at IS NOT NULL`, loc, orig.id))
    for (const g of calcTotals(JSON.parse(row.items || '[]'), mode, row.calc === 'line' ? 'line' : 'group').groups) add(g.rate, g.net_cents);
  const rates = [...net.entries()].filter(([, n]) => n !== 0).sort((a, b) => b[0] - a[0]);
  if (!rates.length || rates.some(([, n]) => n < 0)) throw new HttpError(409, 'Die bisherigen Gutschriften verteilen sich anders auf die Steuersätze als die Rechnung – bitte den Rest von Hand gutschreiben');
  const items: LineItem[] = rates.map(([rate, n]) => ({
    name: `Restbetrag zu ${orig.number}`,
    description: rates.length > 1 ? `Anteil mit ${String(rate).replace('.', ',')} % USt.` : '',
    qty: 1,
    price_cents: n,
    tax_rate: rate,
    unit: 'LS',
  }));
  const totalOf = () => calcTotals(items, mode).total_cents;
  for (let i = 0; i < 20 && totalOf() > left; i++) items.reduce((a, b) => (b.price_cents > a.price_cents ? b : a)).price_cents -= 1;
  for (let i = 0; i < 20; i++) {
    const current = totalOf();
    if (current >= left) break;
    let best = -1;
    let bestTotal = current;
    items.forEach((it, k) => {
      it.price_cents += 1;
      const t = totalOf();
      it.price_cents -= 1;
      if (t <= left && t > bestTotal) {
        best = k;
        bestTotal = t;
      }
    });
    if (best < 0) break;
    items[best].price_cents += 1;
  }
  return { items: items.filter((it) => it.price_cents > 0), left, total: totalOf() };
}

/**
 * A partial credit note (Rechnungskorrektur / Gutschrift) as a draft: the lines are given positive and stored negative.
 * `remainder: true` makes the lines itself – the credit note for everything not credited yet ("Restbetrag gutschreiben", the way
 * to cancel what is left of an invoice that already has credit notes; a Stornorechnung is refused then). Its `warnings` say when
 * VAT rounding leaves a cent.
 */
export function createCreditNote(app: App, loc: string, invoiceId: string, input: { items?: unknown; reason?: unknown; copy?: unknown; remainder?: unknown }, actor: Actor = SYSTEM): Inv {
  const orig = mustInvoice(app, loc, invoiceId);
  if (orig.kind !== 'invoice') throw new HttpError(409, 'Eine Gutschrift gibt es nur zu Rechnungen');
  if (!orig.finalised_at) throw new HttpError(409, 'Die Rechnung ist noch ein Entwurf – ändere sie einfach direkt');
  if (orig.status === 'void') throw new HttpError(409, creditClosed(orig) ? 'Die Rechnung ist schon vollständig gutgeschrieben – es ist nichts mehr offen' : 'Die Rechnung ist storniert – eine Gutschrift dazu ist nicht mehr möglich');
  const mode: TaxMode = isTaxMode(orig.tax_mode) ? orig.tax_mode : 'standard';
  const warnings: string[] = [];
  const rest = input.remainder === true || input.remainder === 'true' || input.remainder === 1;
  let items: LineItem[];
  if (rest) {
    const r = remainderCredit(app, loc, orig, mode);
    items = r.items;
    if (r.total < r.left) warnings.push(`Wegen der Rundung der Umsatzsteuer schreibt die Gutschrift ${centsToMoney(r.total, orig.currency)} gut – ${centsToMoney(r.left - r.total, orig.currency)} bleiben offen (bitte von Hand ausgleichen)`);
  } else {
    const source = input.items !== undefined ? input.items : input.copy ? orig.items : undefined;
    if (!Array.isArray(source) || !source.length) throw bad('Bitte die gutzuschreibenden Positionen angeben');
    items = cleanItems(source, orig.items[0]?.tax_rate ?? 19, mode).map((it, i) => {
      if (it.qty <= 0) throw bad(`Position ${i + 1}: die Menge muss größer als 0 sein`);
      if (it.price_cents < 0) throw bad(`Position ${i + 1}: der Preis darf nicht negativ sein (die Gutschrift macht daraus den Abzug)`);
      return it;
    });
  }
  const total = calcTotals(items, mode).total_cents;
  if ((orig.credited_cents ?? 0) + total > orig.total_cents) throw new HttpError(409, `Die Gutschriften würden die Rechnung übersteigen (Rechnung ${centsToMoney(orig.total_cents, orig.currency)}, schon gutgeschrieben ${centsToMoney(orig.credited_cents ?? 0, orig.currency)})`);
  const reason = clip(input.reason, 300);
  const cn = app.db.tx(() => {
    const row = insertCreditNote(app, loc, orig, { type: 'credit', items: negateItems(items), title: `Gutschrift zu ${orig.number}${orig.title ? ` – ${orig.title}` : ''}`.slice(0, 300), notes: reason ? `Grund: ${reason}` : '' });
    invAudit(app, loc, orig.id, 'credit_note.created', `Entwurf einer Gutschrift über ${centsToMoney(Math.abs(row.total_cents), orig.currency)}${rest ? ' (Restbetrag)' : ''}`, actor);
    return row;
  });
  return warnings.length ? Object.assign(cn, { warnings }) : cn;
}

// --- quote → invoice -------------------------------------------------------------------------------------------------------------

/** Turns a quote into a draft invoice that keeps the reference (`ref_id`) – the quote itself stays as it is. */
export function convertEstimate(app: App, loc: string, estimateId: string, actor: Actor = SYSTEM, opts: { inv_type?: InvType } = {}): Inv {
  const est = mustInvoice(app, loc, estimateId);
  if (est.kind !== 'estimate') throw new HttpError(409, 'Nur Angebote lassen sich in eine Rechnung umwandeln');
  if (est.status === 'void') throw new HttpError(409, 'Das Angebot ist verworfen');
  if (est.status === 'draft') throw new HttpError(409, 'Das Angebot ist noch ein Entwurf – erst senden oder als angenommen markieren');
  const cfg = billingSettings(app, loc);
  const t = now();
  const terms = Math.max(0, Number(cfg.payment_terms_days ?? 14));
  const mode: TaxMode = isTaxMode(est.tax_mode) ? est.tax_mode : 'standard';
  const totals = calcTotals(est.items, mode);
  const row = {
    id: id(),
    location_id: loc,
    kind: 'invoice',
    number: draftNumber(),
    contact_id: est.contact_id,
    title: est.title,
    items: est.items,
    currency: est.currency,
    subtotal_cents: totals.subtotal_cents,
    tax_cents: totals.tax_cents,
    total_cents: totals.total_cents,
    status: 'draft',
    notes: est.notes,
    payment_link: est.payment_link,
    public_token: token(18),
    issued_at: t,
    due_at: new Date(Date.now() + terms * 864e5).toISOString(),
    created_at: t,
    updated_at: t,
    tax_mode: mode,
    tax_note: est.tax_note,
    buyer_vat_id: est.buyer_vat_id,
    leitweg_id: est.leitweg_id,
    buyer_ref: est.buyer_ref,
    skonto_percent: est.skonto_percent,
    skonto_days: est.skonto_days,
    inv_type: opts.inv_type ?? 'standard',
    ref_id: est.id,
    calc: 'group',
    issued_auto: 1,
  };
  app.db.tx(() => {
    app.db.insert('invoices', row);
    invAudit(app, loc, row.id, 'invoice.created_from_quote', `aus Angebot ${est.number}`, actor);
    invAudit(app, loc, est.id, 'quote.converted', `Rechnungsentwurf erzeugt`, actor);
  });
  return mustInvoice(app, loc, row.id);
}

// --- payments ------------------------------------------------------------------------------------------------------------------------

export interface PaymentInput {
  amount_cents?: unknown;
  paid_at?: unknown;
  method?: unknown;
  note?: unknown;
  /** The customer deducted Skonto: the rest up to the open amount is closed as Skonto (needs a Skonto on the invoice and a payment inside its period). */
  skonto?: unknown;
}

/** Records a (partial) payment on a finalised invoice; the invoice becomes paid when nothing is open any more. */
export function recordPayment(app: App, loc: string, invoiceId: string, input: PaymentInput, actor: Actor = SYSTEM, opts: { source?: string; via?: string } = {}): { invoice: Inv; payment_id: string; paid: boolean } {
  const source = opts.source ?? 'manual';
  const res = app.db.tx(() => {
    const inv0 = mustInvoice(app, loc, invoiceId);
    if (inv0.kind !== 'invoice') throw new HttpError(409, 'Zahlungen gibt es nur bei Rechnungen');
    if (inv0.status === 'void') throw new HttpError(409, creditClosed(inv0) ? 'Die Rechnung ist schon vollständig gutgeschrieben – es ist nichts mehr offen' : 'Die Rechnung ist storniert');
    const inv = inv0.finalised_at ? inv0 : ensureFinal(app, loc, inv0.id, { actor, adopt: inv0.status !== 'draft' });
    if (inv.status === 'paid') throw new HttpError(409, 'Die Rechnung ist schon bezahlt');
    const open = openCents(inv);
    // a plain date (bank import, API) means that day wherever the sub-account is: noon UTC, not midnight UTC (the evening before in America)
    const paidAtRaw = input.paid_at ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(input.paid_at)) ? `${input.paid_at}T12:00:00.000Z` : String(input.paid_at)) : new Date();
    if (Number.isNaN(paidAtRaw.getTime())) throw bad('Ungültiges Zahlungsdatum');
    const paid_at = paidAtRaw.toISOString();
    let amount = input.amount_cents === undefined || input.amount_cents === '' || input.amount_cents === null ? open : Math.round(Number(input.amount_cents));
    if (!Number.isInteger(amount) || amount <= 0) throw bad('Der Betrag muss größer als 0 sein');
    let skonto = 0;
    if (input.skonto) {
      if (!inv.skonto_percent || !inv.skonto_days) throw bad('Diese Rechnung hat kein Skonto');
      const base = inv.total_cents - (inv.deducted_cents ?? 0);
      const allowed = skontoCents(base, Number(inv.skonto_percent));
      const until = skontoDeadline(ymd(inv.issued_at, tzOf(app, loc)), Number(inv.skonto_days));
      if (ymd(paid_at, tzOf(app, loc)) > until) throw bad(`Die Skonto-Frist ist am ${until.split('-').reverse().join('.')} abgelaufen`);
      skonto = Math.max(0, open - amount);
      if (skonto > allowed) throw bad('Der Abzug ist höher als das vereinbarte Skonto');
      if (skonto === 0) throw bad('Es wurde nichts abgezogen – ohne Skonto einfach den vollen Betrag erfassen');
    } else if (amount > open) throw bad(`Der Betrag übersteigt den offenen Betrag (${centsToMoney(open, inv.currency)})`);
    const method = clip(input.method, 60);
    const note = clip(input.note, 300);
    const pid = id();
    app.db.insert('invoice_payments', { id: pid, location_id: loc, invoice_id: inv.id, amount_cents: amount, paid_at, method, note, kind: 'payment', reverses_id: null, source, created_by: actor.id ?? null, created_at: now() });
    if (skonto) app.db.insert('invoice_payments', { id: id(), location_id: loc, invoice_id: inv.id, amount_cents: skonto, paid_at, method: 'Skonto', note: `${inv.skonto_percent} % Skonto`, kind: 'skonto', reverses_id: null, source, created_by: actor.id ?? null, created_at: now() });
    const settled = amount + skonto;
    const left = open - settled;
    const t = now();
    app.db.run(`UPDATE invoices SET paid_cents = paid_cents + ?, updated_at = ?${left <= 0 ? `, status = 'paid', paid_at = COALESCE(paid_at, ?)` : ''} WHERE id = ?`, ...(left <= 0 ? [settled, t, paid_at, inv.id] : [settled, t, inv.id]));
    invAudit(app, loc, inv.id, left <= 0 ? 'payment.completed' : 'payment.recorded', `${centsToMoney(amount, inv.currency)}${skonto ? ` + Skonto ${centsToMoney(skonto, inv.currency)}` : ''}${method ? ` · ${method}` : ''}${left > 0 ? ` · noch offen ${centsToMoney(left, inv.currency)}` : ''}`, actor);
    return { invoice: mustInvoice(app, loc, inv.id), payment_id: pid, paid: left <= 0 };
  });
  const inv = res.invoice;
  if (res.paid) {
    if (inv.contact_id) logActivity(app, loc, inv.contact_id, 'invoice.paid', `Rechnung ${inv.number} bezahlt (${centsToMoney(inv.total_cents, inv.currency)})${opts.via ? ` – ${opts.via}` : ''}`);
    app.events.emit(loc, 'invoice.paid', { contactId: inv.contact_id, invoice: stripSnapshot(inv), ...(opts.via ? { via: opts.via } : {}) });
  } else {
    if (inv.contact_id) logActivity(app, loc, inv.contact_id, 'invoice.partially_paid', `Teilzahlung auf Rechnung ${inv.number}`);
    app.events.emit(loc, 'invoice.partially_paid', { contactId: inv.contact_id, invoice: stripSnapshot(inv), open_cents: openCents(inv) });
  }
  return res;
}

/** Takes a payment back (wrong amount, chargeback): a reversal row, the invoice is open again. The original row stays. */
export function revertPayment(app: App, loc: string, invoiceId: string, paymentId: string, actor: Actor = SYSTEM, reason = ''): Inv {
  return app.db.tx(() => {
    const inv = mustInvoice(app, loc, invoiceId);
    const p = app.db.get<any>(`SELECT * FROM invoice_payments WHERE id = ? AND invoice_id = ? AND location_id = ?`, paymentId, invoiceId, loc);
    if (!p || p.kind === 'reversal') throw notFound('Zahlung nicht gefunden');
    if (app.db.get('SELECT 1 AS x FROM invoice_payments WHERE reverses_id = ?', paymentId)) throw new HttpError(409, 'Diese Zahlung wurde schon zurückgenommen');
    if (inv.status === 'void') throw new HttpError(409, 'Die Rechnung ist storniert');
    const t = now();
    // a Skonto row belongs to its payment: both go back together
    const rows = p.kind === 'payment' ? app.db.all<any>(`SELECT * FROM invoice_payments WHERE invoice_id = ? AND kind = 'skonto' AND paid_at = ? AND reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM invoice_payments r WHERE r.reverses_id = invoice_payments.id)`, invoiceId, p.paid_at) : [];
    let back = 0;
    for (const x of [p, ...rows]) {
      app.db.insert('invoice_payments', { id: id(), location_id: loc, invoice_id: invoiceId, amount_cents: -x.amount_cents, paid_at: t, method: x.method, note: clip(reason, 300) || 'Zahlung zurückgenommen', kind: 'reversal', reverses_id: x.id, source: 'manual', created_by: actor.id ?? null, created_at: t });
      back += x.amount_cents;
    }
    app.db.run(`UPDATE invoices SET paid_cents = MAX(0, paid_cents - ?), status = CASE WHEN status = 'paid' THEN 'sent' ELSE status END, paid_at = NULL, updated_at = ? WHERE id = ?`, back, t, invoiceId);
    invAudit(app, loc, invoiceId, 'payment.reverted', `${centsToMoney(back, inv.currency)}${reason ? ` · ${clip(reason, 120)}` : ''}`, actor);
    return mustInvoice(app, loc, invoiceId);
  });
}

// --- integrity ---------------------------------------------------------------------------------------------------------------------------

export interface VerifyReport {
  ok: boolean;
  final: boolean;
  hash: string | null;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** Recomputes the SHA-256 of the frozen snapshot and compares the columns the database holds with it. */
export function verifyInvoice(app: App, loc: string, invoiceId: string): VerifyReport {
  const inv = mustInvoice(app, loc, invoiceId);
  if (!inv.finalised_at) return { ok: true, final: false, hash: null, checks: [{ name: 'Entwurf', ok: true, detail: 'Noch nicht festgeschrieben – es gibt nichts zu prüfen' }] };
  const s = inv.snapshot;
  const checks: VerifyReport['checks'] = [];
  const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  if (!s || !inv.doc_hash) {
    add('Momentaufnahme vorhanden', false, 'Die Rechnung wurde festgeschrieben, aber ihre Momentaufnahme fehlt');
    return { ok: false, final: true, hash: inv.doc_hash ?? null, checks };
  }
  const hash = snapshotHash(s);
  add('SHA-256 der Momentaufnahme', hash === inv.doc_hash, hash === inv.doc_hash ? hash : 'Die Prüfsumme stimmt nicht mit der gespeicherten überein');
  add('Nummer', s.number === inv.number, s.number === inv.number ? inv.number : `Momentaufnahme ${s.number}, Rechnung ${inv.number}`);
  add('Positionen', JSON.stringify(s.items) === JSON.stringify(inv.items));
  add('Beträge', s.totals.total_cents === inv.total_cents && s.totals.tax_cents === inv.tax_cents && s.totals.subtotal_cents === inv.subtotal_cents, `${centsToMoney(inv.total_cents, inv.currency)}`);
  add('Rechnungsdatum', s.issued_at === inv.issued_at);
  add('Währung', s.currency === inv.currency);
  add('Steuerbehandlung', s.tax_mode === inv.tax_mode && s.tax_note === inv.tax_note);
  return { ok: checks.every((c) => c.ok), final: true, hash: inv.doc_hash, checks };
}

// --- migration helpers --------------------------------------------------------------------------------------------------------------------

/** Gives the invoices that were finalised by the update (and still have no snapshot) their snapshot and SHA-256. Idempotent. */
export function backfillSnapshots(app: App, limit = 2000): number {
  const rows = app.db.all<{ id: string; location_id: string }>(`SELECT id, location_id FROM invoices WHERE finalised_at IS NOT NULL AND doc_hash IS NULL LIMIT ?`, limit);
  let n = 0;
  for (const r of rows) {
    try {
      app.db.tx(() => {
        const inv = mustInvoice(app, r.location_id, r.id);
        const mode: TaxMode = isTaxMode(inv.tax_mode) ? inv.tax_mode : 'standard';
        const doc = composeLive(app, r.location_id, inv, { calc: inv.calc === 'group' ? 'group' : 'line', deductions: inv.snapshot?.deductions ?? [] });
        const snapshot: DocSnapshot = { ...doc, tax_mode: mode, vies: null };
        const hash = snapshotHash(snapshot);
        app.db.run('UPDATE invoices SET snapshot = ?, doc_hash = ? WHERE id = ? AND doc_hash IS NULL', JSON.stringify(snapshot), hash, r.id);
        invAudit(app, r.location_id, r.id, 'invoice.migrated', `Festgeschrieben beim Update auf die neue Rechnungsstellung · SHA-256 ${hash.slice(0, 16)}…`);
        n++;
      });
    } catch (e) {
      console.error('[invoices] snapshot', r.id, (e as Error).message);
    }
  }
  return n;
}

/**
 * Invoices that could not be adopted (a broken line item, a missing customer…) and when we tried: the batch always starts with the
 * oldest, so 50 of them used to block every invoice behind them and log 50 errors every 30 seconds. They are left alone for an hour.
 */
const adoptFailed = new Map<string, number>();
const ADOPT_RETRY_MS = 3600_000;

/** Invoices another module flipped to "sent"/"paid" with raw SQL (no number, not frozen) are adopted: numbered, frozen, hashed. */
export function adoptStragglers(app: App, loc?: string, limit = 50): number {
  const nowMs = Date.now();
  for (const [id, at] of adoptFailed) if (nowMs - at > ADOPT_RETRY_MS) adoptFailed.delete(id);
  const rows = app.db.all<{ id: string; location_id: string }>(
    // Written exactly like the partial index invoices_unadopted (modules/invoicing.ts) – `status NOT IN ('draft')` read the whole table every 30 s.
    `SELECT id, location_id FROM invoices WHERE finalised_at IS NULL AND kind != 'estimate' AND status != 'draft' ${loc ? 'AND location_id = ?' : ''} ORDER BY issued_at LIMIT ?`,
    ...(loc ? [loc] : []),
    limit + adoptFailed.size,
  );
  let n = 0;
  for (const r of rows) {
    if (adoptFailed.has(r.id)) continue;
    try {
      const inv = mustInvoice(app, r.location_id, r.id);
      // a draft that was voided never got a number: nothing to adopt (and nothing to look at again soon)
      if (inv.status === 'void' && isDraftNumber(inv.number)) {
        adoptFailed.set(r.id, nowMs);
        continue;
      }
      finaliseInvoice(app, r.location_id, r.id, { adopt: true });
      n++;
    } catch (e) {
      adoptFailed.set(r.id, nowMs);
      console.error('[invoices] adopt', r.id, (e as Error).message);
    }
  }
  return n;
}

