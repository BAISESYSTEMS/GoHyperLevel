import type { App } from '../core/app.js';
import { openSecret } from '../core/secrets.js';
import { ymdInTz } from '../core/time.js';
import { bookingDate, entryBySourceKey, getSettings, postEntry, stornoEntry, todayYmd, trail, type AccSettings, type PostingIn } from './acc-ledger.js';
import { codeForRate, type TaxCode } from './acc-vat.js';
import { calcTotals, creditClosed, creditClosedSql, isTaxMode, type Deduction, type TaxMode } from './invoice-model.js';
import { stripeRequest } from './stripe.js';

/**
 * Auto-posting: invoices of the CRM become entries (issue, payment, cancellation), Stripe payments land in the
 * clearing account and Stripe payouts move the money to the bank. Every step is idempotent (a `source_key` per
 * business event), so a tick, a webhook retry or a manual run can never book anything twice.
 */

interface LineItem {
  name: string;
  qty: number;
  price_cents: number;
  tax_rate: number;
}

const REVERSE_CHARGE_TEXT = /reverse.?charge|§\s*13b|steuerschuldnerschaft/i;

/**
 * The postings of an invoice: one per tax rate (the invoice's own rounding), or one for a Kleinunternehmer. The structured
 * tax treatment (`tax_mode`) decides the revenue account and tax code; invoices without it (older rows, direct calls) are
 * recognised from the reverse-charge wording. A final invoice books only what the partial invoices did not (`deductions`),
 * a credit note (negative total) books the opposite direction.
 */
export function invoicePostings(
  inv: { number: string; title?: string; items: LineItem[]; total_cents: number; notes?: string; tax_mode?: string; calc?: string; deductions?: Deduction[] },
  settings: Pick<AccSettings, 'mapping' | 'vat_mode'>,
): { postings: PostingIn[]; warnings: string[] } {
  const m = settings.mapping;
  const warnings: string[] = [];
  const text = `${inv.number}${inv.title ? ` ${inv.title}` : ''}`.trim();
  const mode: TaxMode | undefined = isTaxMode(inv.tax_mode) ? inv.tax_mode : undefined;
  const credit = inv.total_cents < 0;
  const calc = inv.calc === 'group' ? 'group' : 'line';
  // per rate: net and tax of the document (absolute – the direction comes from `credit`), minus what partial invoices already booked
  const groups = new Map<number, { net: number; tax: number }>();
  for (const g of calcTotals(inv.items, mode ?? 'standard', calc).groups) {
    const e = groups.get(g.rate) ?? { net: 0, tax: 0 };
    e.net += Math.abs(g.net_cents);
    e.tax += Math.abs(g.tax_cents);
    groups.set(g.rate, e);
  }
  for (const d of inv.deductions ?? []) {
    for (const g of d.groups) {
      const e = groups.get(g.rate) ?? { net: 0, tax: 0 };
      e.net -= Math.abs(g.net_cents);
      e.tax -= Math.abs(g.tax_cents);
      groups.set(g.rate, e);
    }
  }
  const postings: PostingIn[] = [];
  const push = (revenue: string, net: number, tax: number, code: TaxCode) => {
    if (net === 0 && tax === 0) return;
    // a negative remainder (more booked by partial invoices than the final invoice has) goes the other way
    const back = (net < 0 || (net === 0 && tax < 0)) !== credit;
    const n = Math.abs(net);
    const t = Math.abs(tax);
    postings.push(back ? { debit: revenue, credit: m.receivable, amount_cents: n + t, net_cents: n, tax_cents: t, tax_code: code, text } : { debit: m.receivable, credit: revenue, amount_cents: n + t, net_cents: n, tax_cents: t, tax_code: code, text });
  };
  const small = mode === 'small_business' || (settings.vat_mode === 'small' && (!mode || mode === 'standard'));
  if (small) {
    const net = [...groups.values()].reduce((n, g) => n + g.net, 0);
    if (net !== 0) {
      const back = (net < 0) !== credit;
      const n = Math.abs(net);
      postings.push(back ? { debit: m.revenue_small, credit: m.receivable, amount_cents: n, tax_code: 'kl', text } : { debit: m.receivable, credit: m.revenue_small, amount_cents: n, tax_code: 'kl', text });
    }
    return { postings, warnings };
  }
  const rcText = !mode && REVERSE_CHARGE_TEXT.test(`${inv.title ?? ''} ${inv.notes ?? ''}`);
  for (const [rate, g] of [...groups.entries()].sort((a, b) => b[0] - a[0])) {
    if (g.net === 0 && g.tax === 0) continue;
    if (![0, 7, 19].includes(rate)) throw new Error(`Steuersatz ${rate} % wird nicht unterstützt (19, 7 oder 0)`);
    let code: TaxCode = codeForRate(rate, 'output');
    let revenue = rate === 19 ? m.revenue19 : rate === 7 ? m.revenue7 : m.revenue0;
    if (mode === 'reverse_charge' || (rate === 0 && rcText)) {
      // the customer owes the tax: nothing is reported as domestic revenue
      code = 'ust_rc';
      revenue = m.revenue_rc;
    } else if (mode === 'ig_supply') {
      code = 'ust_ig';
      revenue = m.revenue_ig;
    } else if (mode === 'export') {
      code = 'ust_export';
      revenue = m.revenue0;
    }
    push(revenue, g.net, g.tax, code);
  }
  // what the postings put on the receivable account must be the document total less the partial invoices
  const booked = postings.reduce((n, p) => n + (p.debit === m.receivable ? p.amount_cents : -p.amount_cents), 0);
  const want = (credit ? -1 : 1) * (Math.abs(inv.total_cents) - (inv.deductions ?? []).reduce((n, d) => n + d.total_cents, 0));
  if (booked !== want) warnings.push(`Rechnungssumme ${want} weicht von den Positionen (${booked}) ab`);
  return { postings, warnings };
}

/**
 * The day of an instant in the sub-account's calendar (a plain `YYYY-MM-DD` stays as it is). The UTC date is the day before
 * between 00:00 and 01:00/02:00 in Berlin: an invoice finalised at 00:30 on 1 January was booked into December of the old year.
 */
const day = (app: App, locationId: string, iso: string | null | undefined, fallback = new Date().toISOString()): string => {
  const s = String(iso ?? fallback);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  try {
    return ymdInTz(d, app.location(locationId)?.timezone || 'Europe/Berlin');
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

/** Open amount of an invoice in the ledger: what the receivable account still shows for its number. */
export function invoiceBalance(app: App, locationId: string, number: string, receivable: string): number {
  return (
    app.db.get<{ b: number }>(
      `SELECT COALESCE(SUM(CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END), 0) AS b
       FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.location_id = ? AND e.doc_ref = ? AND l.account = ?`,
      locationId,
      number,
      receivable,
    )?.b ?? 0
  );
}

const partyOf = (app: App, inv: any): string => {
  const c = inv.contact_id ? app.db.get<{ first_name: string; last_name: string; company: string }>('SELECT first_name, last_name, company FROM contacts WHERE id = ? AND location_id = ?', inv.contact_id, inv.location_id) : undefined;
  return (c?.company || [c?.first_name, c?.last_name].filter(Boolean).join(' ')).slice(0, 200);
};

const parsed = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v ?? fallback) as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/**
 * The invoice's issue entry (booked when missing). Null when the document cannot be booked (draft, estimate, a Stornorechnung –
 * that one cancels the original through the Storno of its entry). A partial credit note books the opposite direction on the
 * original's document number, so the receivable of the invoice shrinks by it.
 */
export function ensureIssued(app: App, locationId: string, inv: any, settings: AccSettings) {
  const key = `invoice:${inv.id}:issue`;
  const existing = entryBySourceKey(app, locationId, key);
  if (existing) return existing;
  const credit = inv.kind === 'credit_note';
  // an invoice closed by its credit notes keeps its entry: the booked credit notes are what reverses it
  if (!['invoice', 'credit_note'].includes(inv.kind) || !(['sent', 'paid'].includes(inv.status) || creditClosed(inv))) return null;
  if (credit && inv.credit_type === 'storno') return null;
  const items: LineItem[] = parsed(inv.items, []);
  const snap = parsed<any>(inv.snapshot, null);
  const mode = isTaxMode(inv.tax_mode) ? inv.tax_mode : undefined;
  const vatMode = settings.vat_mode === 'small' || app.location(locationId)?.settings.invoices?.small_business ? 'small' : 'regular';
  const { postings, warnings } = invoicePostings({ number: inv.number, title: inv.title, items, total_cents: inv.total_cents, notes: inv.notes, tax_mode: mode && inv.finalised_at ? mode : undefined, calc: inv.calc, deductions: snap?.deductions }, { ...settings, vat_mode: vatMode });
  if (!postings.length) return null;
  const ref = credit && inv.ref_id ? app.db.get<{ number: string }>('SELECT number FROM invoices WHERE id = ? AND location_id = ?', inv.ref_id, locationId) : undefined;
  // the date printed on the invoice (frozen with it), else its day in the sub-account's zone
  const docDate = typeof snap?.issued_ymd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(snap.issued_ymd) ? snap.issued_ymd : day(app, locationId, inv.issued_at);
  const date = bookingDate(app, locationId, docDate);
  const out = postEntry(app, locationId, {
    date,
    doc_date: docDate,
    due_date: !credit && inv.due_at ? day(app, locationId, inv.due_at) : null,
    text: credit ? `Gutschrift ${inv.number}${ref ? ` zu Rechnung ${ref.number}` : ''}${inv.title ? `: ${inv.title}` : ''}` : `Rechnung ${inv.number}${inv.title ? `: ${inv.title}` : ''}`,
    doc_ref: ref?.number ?? inv.number,
    source: 'invoice',
    source_id: inv.id,
    source_key: key,
    postings,
    party_name: partyOf(app, inv),
    contact_id: inv.contact_id ?? null,
    actor: credit ? 'Automatik (Gutschrift)' : 'Automatik (Rechnung)',
  });
  if (warnings.length) trail(app, locationId, null, 'autopost.warning', out.entry.id, warnings.join('; '));
  return out.entry;
}

/** Books a payment for an invoice: money into the bank (or the Stripe clearing account), the receivable down. */
export function postInvoicePayment(app: App, locationId: string, inv: any, opts: { date?: string; amount_cents?: number; via?: 'bank' | 'stripe'; key?: string; actor?: string } = {}) {
  const settings = getSettings(app, locationId);
  const m = settings.mapping;
  const balance = invoiceBalance(app, locationId, inv.number, m.receivable);
  const amount = Math.min(opts.amount_cents ?? balance, balance);
  if (amount <= 0) return null;
  const docDate = day(app, locationId, opts.date ?? inv.paid_at);
  const via = opts.via ?? 'bank';
  const key = opts.key ?? `invoice:${inv.id}:payment`;
  return postEntry(app, locationId, {
    date: bookingDate(app, locationId, docDate),
    doc_date: docDate,
    text: `Zahlungseingang ${inv.number}${via === 'stripe' ? ' (Stripe)' : ''}`,
    doc_ref: inv.number,
    source: via === 'stripe' ? 'stripe' : 'payment',
    source_id: inv.id,
    source_key: key,
    postings: [{ debit: via === 'stripe' ? m.transit : m.bank, credit: m.receivable, amount_cents: amount, tax_code: 'none', text: `Zahlung ${inv.number}` }],
    party_name: partyOf(app, inv),
    contact_id: inv.contact_id ?? null,
    actor: opts.actor ?? (via === 'stripe' ? 'Automatik (Stripe)' : 'Automatik (Zahlung)'),
  }).entry;
}

const seenErrors = new Set<string>();

/**
 * Books what is missing for the invoices of a sub-account: issue entries for sent/paid invoices and credit notes, payment
 * entries (each recorded payment, or the open balance of invoices paid the old way), a Storno for cancelled ones, the reversal of
 * a payment that was taken back. `invoiceId` limits the run to one invoice (after it changed).
 */
export function syncInvoices(app: App, locationId: string, opts: { invoiceId?: string; limit?: number } = {}) {
  const out = { posted: 0, payments: 0, cancelled: 0, errors: [] as string[] };
  const settings = getSettings(app, locationId);
  if (!settings.enabled || !settings.autopost.invoices) return out;
  const m = settings.mapping;
  const unbookedPayment = `EXISTS (SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id AND p.kind = 'payment' AND p.source != 'bank' AND NOT EXISTS (SELECT 1 FROM acc_entries e WHERE e.location_id = i.location_id AND e.source_key = 'invoice:' || i.id || ':pay:' || p.id))`;
  const pendingReversal = `EXISTS (SELECT 1 FROM invoice_payments r JOIN acc_entries e ON e.location_id = r.location_id AND e.source_key = 'invoice:' || r.invoice_id || ':pay:' || r.reverses_id WHERE r.invoice_id = i.id AND r.kind = 'reversal' AND e.reversed_by IS NULL)`;
  const rows = app.db.all<any>(
    `SELECT i.* FROM invoices i
     WHERE i.location_id = ? AND i.kind IN ('invoice', 'credit_note') AND NOT (i.kind = 'credit_note' AND i.credit_type = 'storno') AND i.status IN ('sent', 'paid', 'void') ${opts.invoiceId ? 'AND i.id = ?' : ''}
       ${settings.autopost.skip_linked ? 'AND NOT EXISTS (SELECT 1 FROM invoice_links l WHERE l.invoice_id = i.id)' : ''}
       AND (
         ((i.status != 'void' OR ${creditClosedSql('i.')}) AND NOT EXISTS (SELECT 1 FROM acc_entries e WHERE e.location_id = i.location_id AND e.source_key = 'invoice:' || i.id || ':issue'))
         OR (i.status = 'paid' AND i.kind = 'invoice' AND NOT EXISTS (SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id) AND (SELECT COALESCE(SUM(CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END), 0) FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.location_id = i.location_id AND e.doc_ref = i.number AND l.account = ?) > 0)
         OR (i.kind = 'invoice' AND (${unbookedPayment} OR ${pendingReversal}))
         OR (i.status = 'void' AND NOT ${creditClosedSql('i.')} AND EXISTS (SELECT 1 FROM acc_entries e WHERE e.location_id = i.location_id AND e.source_key = 'invoice:' || i.id || ':issue' AND e.reversed_by IS NULL))
       )
     ORDER BY i.issued_at LIMIT ?`,
    locationId,
    ...(opts.invoiceId ? [opts.invoiceId] : []),
    m.receivable,
    opts.limit ?? 100,
  );
  for (const inv of rows) {
    try {
      // cancelled by a Stornorechnung (which is not booked itself): its entry is reversed; one closed by credit notes keeps it
      if (inv.status === 'void' && !creditClosed(inv)) {
        const e = entryBySourceKey(app, locationId, `invoice:${inv.id}:issue`);
        if (e && !e.reversed_by) {
          const storno = inv.storno_id ? app.db.get<{ number: string }>('SELECT number FROM invoices WHERE id = ? AND location_id = ?', inv.storno_id, locationId) : undefined;
          stornoEntry(app, locationId, e.id, { reason: storno ? `Stornorechnung ${storno.number}` : 'Rechnung storniert', user: { id: null, name: 'Automatik (Rechnung)' } });
          out.cancelled++;
        }
        continue;
      }
      const had = !!entryBySourceKey(app, locationId, `invoice:${inv.id}:issue`);
      const issued = ensureIssued(app, locationId, inv, settings);
      if (!issued) continue;
      if (!had) out.posted++;
      if (inv.kind !== 'invoice') continue;
      const viaStripe = settings.autopost.stripe && !!app.db.get(`SELECT 1 AS x FROM stripe_checkouts WHERE invoice_id = ? AND status = 'paid'`, inv.id);
      if (settings.autopost.payments) {
        // every recorded payment on its own entry (partial payments); payments the bank import booked itself are skipped
        for (const p of app.db.all<any>(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at, rowid`, inv.id)) {
          const key = `invoice:${inv.id}:pay:${p.id}`;
          if (p.kind === 'payment' && p.source !== 'bank' && !entryBySourceKey(app, locationId, key)) {
            const via = viaStripe || (settings.autopost.stripe && /^stripe/i.test(p.method)) ? 'stripe' : 'bank';
            if (postInvoicePayment(app, locationId, inv, { date: day(app, locationId, p.paid_at), amount_cents: p.amount_cents, via, key })) out.payments++;
          } else if (p.kind === 'reversal') {
            const orig = entryBySourceKey(app, locationId, `invoice:${inv.id}:pay:${p.reverses_id}`);
            if (orig && !orig.reversed_by) stornoEntry(app, locationId, orig.id, { reason: 'Zahlung zurückgenommen', user: { id: null, name: 'Automatik (Zahlung)' } });
          } else if (p.kind === 'skonto') {
            // a Skonto deduction has no bank movement: the difference stays open on the receivable until the advisor clears it (said once)
            const detail = `${inv.number}: Skonto-Abzug von ${(p.amount_cents / 100).toFixed(2)} € nicht gebucht – die Differenz bleibt auf dem Forderungskonto offen (Erlösschmälerung mit dem Steuerberater klären)`;
            if (!app.db.get(`SELECT 1 AS x FROM acc_audit WHERE location_id = ? AND action = 'autopost.warning' AND detail = ?`, locationId, detail)) trail(app, locationId, null, 'autopost.warning', issued.id, detail);
          }
        }
        // invoices paid the old way (no payment rows): the open balance is booked as one payment
        if (inv.status === 'paid' && !app.db.get('SELECT 1 AS x FROM invoice_payments WHERE invoice_id = ?', inv.id) && postInvoicePayment(app, locationId, inv, { via: viaStripe ? 'stripe' : 'bank' })) out.payments++;
      }
    } catch (e) {
      const msg = `${inv.number}: ${(e as Error).message}`;
      out.errors.push(msg);
      if (!seenErrors.has(`${locationId}|${msg}`) && seenErrors.size < 1000) {
        seenErrors.add(`${locationId}|${msg}`);
        console.error('[accounting] autopost', msg);
        try {
          trail(app, locationId, null, 'autopost.error', null, msg);
        } catch {
          /* trail is best effort */
        }
      }
    }
  }
  return out;
}

// --- Stripe -------------------------------------------------------------------------------------------------------------

const ymdFromUnix = (s: unknown) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));

/** `payout.paid`: the bank receives the net amount out of the clearing account; the fees follow once Stripe's balance transactions are read. */
export function bookStripePayout(app: App, locationId: string, payout: any): { handled: string; entry?: string } {
  const settings = getSettings(app, locationId);
  if (!settings.enabled || !settings.autopost.stripe) return { handled: 'ignored' };
  const amount = Number(payout?.amount ?? 0);
  const cur = String(payout?.currency ?? 'eur').toUpperCase();
  if (!payout?.id || !Number.isInteger(amount) || amount <= 0) return { handled: 'ignored' };
  if (cur !== 'EUR') {
    trail(app, locationId, null, 'autopost.error', null, `Stripe-Auszahlung ${payout.id} in ${cur} nicht gebucht (nur EUR)`);
    return { handled: 'ignored' };
  }
  const m = settings.mapping;
  const date = ymdFromUnix(payout.arrival_date ?? payout.created);
  const out = postEntry(app, locationId, {
    date: bookingDate(app, locationId, date),
    doc_date: date,
    text: `Stripe-Auszahlung ${payout.id}`,
    doc_ref: String(payout.id),
    source: 'stripe',
    source_id: String(payout.id),
    source_key: `stripe:payout:${payout.id}`,
    postings: [{ debit: m.bank, credit: m.transit, amount_cents: amount, tax_code: 'none', text: 'Auszahlung von Stripe' }],
    party_name: 'Stripe',
    actor: 'Automatik (Stripe)',
  });
  return { handled: 'payout_booked', entry: out.entry.id };
}

/**
 * Fees of a payout: the sum of `fee` over its balance transactions, booked from the clearing account to the fees account
 * (without VAT – Stripe's invoice for the fees decides; the advisor corrects the tax treatment).
 */
export async function bookStripeFees(app: App, locationId: string, payout: any): Promise<number> {
  const settings = getSettings(app, locationId);
  if (!settings.enabled || !settings.autopost.stripe || !payout?.id) return 0;
  const key = `stripe:payout:${payout.id}:fees`;
  if (entryBySourceKey(app, locationId, key)) return 0;
  const acc = app.db.get<{ secret_key: string }>('SELECT secret_key FROM stripe_accounts WHERE location_id = ?', locationId);
  if (!acc?.secret_key) return 0;
  const secret = openSecret(app, acc.secret_key);
  let fees = 0;
  let after = '';
  for (let page = 0; page < 10; page++) {
    const r: any = await stripeRequest(secret, 'GET', '/v1/balance_transactions', { payout: payout.id, limit: 100, ...(after ? { starting_after: after } : {}) });
    const list: any[] = Array.isArray(r?.data) ? r.data : [];
    for (const t of list) if (t.type !== 'payout') fees += Math.max(0, Number(t.fee ?? 0));
    if (!r?.has_more || !list.length) break;
    after = list[list.length - 1].id;
  }
  if (fees <= 0) return 0;
  const m = settings.mapping;
  const date = ymdFromUnix(payout.arrival_date ?? payout.created);
  postEntry(app, locationId, {
    date: bookingDate(app, locationId, date),
    doc_date: date,
    text: `Stripe-Gebühren zur Auszahlung ${payout.id}`,
    doc_ref: String(payout.id),
    source: 'stripe',
    source_id: String(payout.id),
    source_key: key,
    postings: [{ debit: m.fees, credit: m.transit, amount_cents: fees, tax_code: 'none', text: 'Zahlungsgebühren Stripe' }],
    party_name: 'Stripe',
    actor: 'Automatik (Stripe)',
  });
  return fees;
}

/** A refund pays money back to the customer: the receivable opens again by that amount (cancel or credit the invoice afterwards). */
export function bookStripeRefund(app: App, locationId: string, e: { invoiceId?: string; amount_cents?: number }): { handled: string } {
  const settings = getSettings(app, locationId);
  if (!settings.enabled || !settings.autopost.stripe || !e.invoiceId) return { handled: 'ignored' };
  const inv = app.db.get<any>('SELECT * FROM invoices WHERE id = ? AND location_id = ?', e.invoiceId, locationId);
  if (!inv || !entryBySourceKey(app, locationId, `invoice:${inv.id}:issue`)) return { handled: 'ignored' };
  // payment.refunded carries the refunded total so far: book the part not booked yet.
  const booked = app.db.get<{ s: number }>(`SELECT COALESCE(SUM(json_extract(postings, '$[0].amount_cents')), 0) AS s FROM acc_entries WHERE location_id = ? AND source_key LIKE ?`, locationId, `refund:${inv.id}:%`)?.s ?? 0;
  const amount = Number(e.amount_cents ?? 0) - booked;
  if (amount <= 0) return { handled: 'ignored' };
  const m = settings.mapping;
  const today = todayYmd(app, locationId);
  postEntry(app, locationId, {
    date: bookingDate(app, locationId, today),
    doc_date: today,
    text: `Stripe-Rückzahlung ${inv.number}`,
    doc_ref: inv.number,
    source: 'stripe',
    source_id: inv.id,
    source_key: `refund:${inv.id}:${Number(e.amount_cents)}`,
    postings: [{ debit: m.receivable, credit: m.transit, amount_cents: amount, tax_code: 'none', text: `Rückzahlung ${inv.number}` }],
    party_name: partyOf(app, inv),
    contact_id: inv.contact_id ?? null,
    actor: 'Automatik (Stripe)',
  });
  return { handled: 'refund_booked' };
}

