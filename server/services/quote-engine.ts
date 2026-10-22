import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { render } from '../core/template.js';
import { ymdInTz } from '../core/time.js';
import { centsToMoney, id, now, token } from '../core/util.js';
import { createSignedContract, isSignatureImage } from '../modules/contracts.js';
import { createInvoice, invoiceSettings, sendInvoice } from '../modules/payments.js';
import { contactName, contactVars, getContact, logActivity } from './contacts.js';
import { setDealLines } from './deal-lines.js';
import { SYSTEM, allocateNumber, convertEstimate, invAudit, loadInvoice, mustInvoice, stripSnapshot, type Actor } from './invoice-flow.js';
import { isTaxMode, type TaxMode } from './invoice-model.js';
import { notifyTeam, sendToContact } from './messaging.js';
import { OPEN_STATUSES, QUOTE_STATUS_LABEL, DEFAULT_VALID_DAYS, cleanQuoteDoc, isExpired, optionTotals, quoteContractText, quoteDocItems, quoteTotals, resolveSelection, selectedItems, validUntilFrom, type QuoteDoc, type QuoteStatus, type Selection } from './quote-model.js';
import { getOpportunity, updateOpportunity } from './opportunities.js';
import { LineError, NO_DEPOSIT, cleanDeposit, depositLines, type DepositSpec, type SalesTotals } from './sales-lines.js';

/**
 * Quotes at work: building one from a deal, sending it, the customer opening, choosing and signing it on its own page, what follows
 * (a signed record in "Verträge", the accepted estimate with its number, a deposit or full invoice with the Stripe pay button) and
 * the numbers. The pure rules are in quote-model.ts and sales-lines.ts; the pages in quote-page.ts; the routes in modules/quotes.ts.
 */

export interface QuoteRow {
  id: string;
  location_id: string;
  deal_id: string;
  contact_id: string;
  number: string;
  title: string;
  status: QuoteStatus;
  currency: string;
  tax_mode: TaxMode;
  intro: string;
  terms: string;
  valid_until: string | null;
  doc: QuoteDoc;
  payment: DepositSpec;
  deal_on_accept: 'none' | 'won';
  public_token: string;
  revision: number;
  parent_id: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string;
  selection: Selection | null;
  accepted_total_cents: number | null;
  signer_name: string;
  contract_id: string | null;
  estimate_id: string | null;
  invoice_id: string | null;
  invoice_kind: '' | 'partial' | 'standard';
  /** The invoice made from the accepted quote later (after a deposit: the final invoice that deducts it). */
  final_invoice_id: string | null;
  paid_at: string | null;
  note: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const parse = (r: any): QuoteRow | undefined => {
  const q = parseJson(r, ['doc', 'payment', 'selection']) as QuoteRow | undefined;
  if (q) {
    q.payment = cleanDeposit(q.payment && typeof q.payment === 'object' ? q.payment : {}, NO_DEPOSIT);
    q.doc = { items: q.doc?.items ?? [], options: q.doc?.options ?? [] };
  }
  return q;
};

export const getQuote = (app: App, loc: string, qid: string): QuoteRow | undefined => parse(app.db.get('SELECT * FROM deal_quotes WHERE id = ? AND location_id = ?', qid, loc));
export const quoteByToken = (app: App, tok: string): QuoteRow | undefined => parse(app.db.get('SELECT * FROM deal_quotes WHERE public_token = ?', tok));

export const quoteUrl = (app: App, q: Pick<QuoteRow, 'public_token'>) => `${app.baseUrl()}/q/${q.public_token}`;
const tzOf = (app: App, loc: string) => app.location(loc)?.timezone ?? 'Europe/Berlin';
const todayOf = (app: App, loc: string) => ymdInTz(new Date(), tzOf(app, loc));

const asHttp = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LineError) throw bad(e.message);
    throw e;
  }
};

const productOf = (app: App, loc: string) => (pid: string) => app.db.get<any>('SELECT id, name, description, price_cents, tax_rate FROM products WHERE id = ? AND location_id = ?', pid, loc);
const lineOpts = (app: App, loc: string) => ({ defaultTax: invoiceSettings(app, loc).tax_rate, mint: () => id(8), product: productOf(app, loc) });

const cleanYmdOrNull = (v: unknown): string | null => {
  if (v === null || v === '') return null;
  const s = String(v ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw bad('Gültig bis: Datum als JJJJ-MM-TT angeben');
  return s;
};

// --- building ----------------------------------------------------------------------------------------------------------------------

/**
 * A draft quote for a deal. Its positions are the deal's (or one position for the deal's amount), so the quote starts where the
 * deal stands; the person adds options and optional positions on top.
 */
export function createQuote(app: App, loc: string, dealId: string, o: { userId?: string | null; title?: string; valid_days?: number; items?: unknown; options?: unknown } = {}): QuoteRow {
  const deal = getOpportunity(app, loc, dealId) as { id: string; name: string; value: number; currency: string; contact_id: string } | undefined;
  if (!deal) throw notFound('Deal nicht gefunden');
  const settings = invoiceSettings(app, loc);
  let source: unknown = o.items;
  if (source === undefined) {
    const lines = (app.services.dealLines?.get(loc, deal.id) ?? []) as any[];
    source = lines.length ? lines : [{ name: deal.name || 'Leistung', qty: 1, price_cents: Math.round(Number(deal.value) || 0) * 100, tax_rate: settings.tax_rate }];
  }
  const doc = asHttp(() => cleanQuoteDoc({ items: source, options: o.options }, lineOpts(app, loc)));
  const days = Number.isFinite(Number(o.valid_days)) && Number(o.valid_days) >= 0 ? Math.min(365, Math.round(Number(o.valid_days))) : DEFAULT_VALID_DAYS;
  const row = {
    id: id(),
    location_id: loc,
    deal_id: deal.id,
    contact_id: deal.contact_id,
    number: '',
    title: String(o.title ?? '').trim().slice(0, 200) || deal.name || 'Angebot',
    status: 'draft',
    currency: deal.currency || 'EUR',
    tax_mode: settings.tax_mode,
    intro: '',
    terms: '',
    valid_until: validUntilFrom(new Date(), days, tzOf(app, loc)),
    doc,
    payment: NO_DEPOSIT,
    deal_on_accept: 'none',
    public_token: token(24),
    revision: 1,
    note: '',
    created_by: o.userId ?? null,
    created_at: now(),
    updated_at: now(),
  };
  app.db.insert('deal_quotes', row);
  logActivity(app, loc, deal.contact_id, 'quote.created', `Angebot „${row.title}“ für „${deal.name}“ angelegt`, { quote_id: row.id });
  return getQuote(app, loc, row.id)!;
}

/** A change to a draft; after the send only the validity can change (extending it re-opens an expired quote). */
export function updateQuote(app: App, loc: string, q: QuoteRow, b: Record<string, any>): QuoteRow {
  const patch: Record<string, any> = { updated_at: now() };
  const editing = ['title', 'intro', 'terms', 'items', 'options', 'payment', 'tax_mode', 'currency', 'deal_on_accept'].some((k) => b[k] !== undefined);
  if (editing && q.status !== 'draft') throw new HttpError(409, 'Nach dem Versand lässt sich das Angebot nicht mehr ändern – lege eine neue Version an');
  if (b.title !== undefined) patch.title = String(b.title ?? '').trim().slice(0, 200) || q.title;
  if (b.intro !== undefined) patch.intro = String(b.intro ?? '').slice(0, 5000);
  if (b.terms !== undefined) patch.terms = String(b.terms ?? '').slice(0, 10_000);
  if (b.tax_mode !== undefined) {
    if (!isTaxMode(b.tax_mode)) throw bad('Unbekannte Steuerbehandlung');
    patch.tax_mode = b.tax_mode;
  }
  if (b.currency !== undefined) {
    if (!/^[A-Za-z]{3}$/.test(String(b.currency))) throw bad('Währung: dreistelliger Code wie EUR');
    patch.currency = String(b.currency).toUpperCase();
  }
  if (b.deal_on_accept !== undefined) patch.deal_on_accept = b.deal_on_accept === 'won' ? 'won' : 'none';
  if (b.items !== undefined || b.options !== undefined) patch.doc = asHttp(() => cleanQuoteDoc({ items: b.items ?? q.doc.items, options: b.options ?? q.doc.options }, lineOpts(app, loc)));
  if (b.payment !== undefined) patch.payment = asHttp(() => cleanDeposit(b.payment, q.payment));
  if (b.valid_until !== undefined) {
    if (['accepted', 'declined', 'void'].includes(q.status)) throw new HttpError(409, 'Das Angebot ist abgeschlossen');
    patch.valid_until = cleanYmdOrNull(b.valid_until);
    if (q.status === 'expired' && (!patch.valid_until || patch.valid_until >= todayOf(app, loc))) patch.status = 'sent';
  }
  const doc: QuoteDoc = patch.doc ?? q.doc;
  const mode: TaxMode = patch.tax_mode ?? q.tax_mode;
  if (patch.doc || patch.tax_mode || patch.payment) {
    // a deposit of a fixed amount must fit into the cheapest way to take the offer
    const dep: DepositSpec = patch.payment ?? q.payment;
    if (dep.mode === 'deposit') {
      for (const ot of doc.options.length ? optionTotals(doc, mode) : [{ option_id: '', totals: quoteTotals(doc, resolveSelection(doc), mode) }]) {
        if (ot.totals.subtotal_cents <= 0) throw bad('Für eine Anzahlung braucht jede Variante einen Betrag');
        asHttp(() => depositLines(ot.totals, dep, 'Anzahlung', mode));
      }
    }
  }
  app.db.update('deal_quotes', q.id, patch, loc);
  return getQuote(app, loc, q.id)!;
}

/** A new draft with the same content (the next version of a quote that went out). */
export function duplicateQuote(app: App, loc: string, q: QuoteRow, userId: string | null): QuoteRow {
  const copy = {
    ...q,
    id: id(),
    number: '',
    status: 'draft',
    public_token: token(24),
    revision: q.revision + 1,
    parent_id: q.id,
    valid_until: validUntilFrom(new Date(), DEFAULT_VALID_DAYS, tzOf(app, loc)),
    sent_at: null,
    viewed_at: null,
    accepted_at: null,
    declined_at: null,
    decline_reason: '',
    selection: null,
    accepted_total_cents: null,
    signer_name: '',
    contract_id: null,
    estimate_id: null,
    invoice_id: null,
    invoice_kind: '',
    final_invoice_id: null,
    paid_at: null,
    note: '',
    created_by: userId,
    created_at: now(),
    updated_at: now(),
  };
  app.db.insert('deal_quotes', copy);
  logActivity(app, loc, q.contact_id, 'quote.created', `Angebot „${q.title}“: Version ${copy.revision} angelegt`, { quote_id: copy.id });
  return getQuote(app, loc, copy.id)!;
}

// --- what the screens show ---------------------------------------------------------------------------------------------------------

const totalsOut = (t: SalesTotals) => ({ list_cents: t.list_cents, discount_cents: t.discount_cents, net_cents: t.subtotal_cents, tax_cents: t.tax_cents, total_cents: t.total_cents, groups: t.groups });

/** What the customer owes at acceptance for a choice (null when nothing is due then). */
export function dueOnAccept(q: Pick<QuoteRow, 'payment' | 'tax_mode' | 'doc'>, totals: SalesTotals): { kind: 'deposit' | 'full'; label: string; total_cents: number; net_cents: number } | null {
  if (q.payment.mode === 'full') return { kind: 'full', label: 'Gesamtbetrag', total_cents: totals.total_cents, net_cents: totals.subtotal_cents };
  if (q.payment.mode !== 'deposit') return null;
  const label = q.payment.type === 'percent' ? `Anzahlung ${String(q.payment.value).replace('.', ',')} %` : 'Anzahlung';
  const d = depositLines(totals, q.payment, label, q.tax_mode);
  return { kind: 'deposit', label, total_cents: d.totals.total_cents, net_cents: d.totals.subtotal_cents };
}

export function quoteOut(app: App, q: QuoteRow, sel?: Selection | null) {
  const selection = sel ?? q.selection ?? resolveSelection(q.doc);
  const totals = quoteTotals(q.doc, selection, q.tax_mode);
  const deal = app.db.get<{ name: string; status: string; value: number }>('SELECT name, status, value FROM opportunities WHERE id = ?', q.deal_id);
  const contact = getContact(app, q.location_id, q.contact_id);
  const doc = (invoiceId: string | null) => {
    const inv = invoiceId ? loadInvoice(app, q.location_id, invoiceId) : undefined;
    return inv ? { id: inv.id, number: inv.number, kind: inv.kind, status: inv.status, total_cents: inv.total_cents, url: `${app.baseUrl()}/i/${inv.public_token}` } : null;
  };
  const { public_token: _t, ...rest } = q;
  return {
    ...rest,
    url: quoteUrl(app, q),
    status_label: QUOTE_STATUS_LABEL[q.status],
    expired: q.status === 'expired' || (OPEN_STATUSES.includes(q.status) && isExpired(q.valid_until, todayOf(app, q.location_id))),
    deal: deal ? { id: q.deal_id, name: deal.name, status: deal.status, value: deal.value } : null,
    contact: contact ? { id: contact.id, name: contactName(contact), email: contact.email } : null,
    selection,
    totals: totalsOut(totals),
    options: q.doc.options.map((o) => ({ option_id: o.id, totals: totalsOut(optionTotals(q.doc, q.tax_mode).find((x) => x.option_id === o.id)!.totals) })),
    due_on_accept: (() => {
      try {
        return dueOnAccept(q, totals);
      } catch {
        return null;
      }
    })(),
    estimate: doc(q.estimate_id),
    invoice: doc(q.invoice_id),
    final_invoice: doc(q.final_invoice_id),
  };
}

// --- sending -----------------------------------------------------------------------------------------------------------------------------

export interface SendOpts {
  userId?: string;
  actor?: Actor;
  channel?: 'email' | 'sms';
  subject?: string;
  body?: string;
  /** false: mark as sent and hand the link to the person (they share it themselves). */
  deliver?: boolean;
}

/**
 * Quotes on their way right now: a double click on "Senden" (or two colleagues at once) is refused the second time (409) instead
 * of mailing the customer the same quote twice; once the first send is through, sending again works as before.
 */
const sendingQuotes = new Set<string>();

export async function sendQuote(app: App, loc: string, q0: QuoteRow, o: SendOpts = {}): Promise<{ quote: QuoteRow; message?: { status: string; error?: string | null } }> {
  if (sendingQuotes.has(q0.id)) throw new HttpError(409, 'Das Angebot wird gerade gesendet – bitte einen Moment warten');
  sendingQuotes.add(q0.id);
  try {
    return await sendQuoteNow(app, loc, q0, o);
  } finally {
    sendingQuotes.delete(q0.id);
  }
}

async function sendQuoteNow(app: App, loc: string, q0: QuoteRow, o: SendOpts): Promise<{ quote: QuoteRow; message?: { status: string; error?: string | null } }> {
  let q = q0;
  if (['accepted', 'declined', 'void'].includes(q.status)) throw new HttpError(409, 'Das Angebot ist abgeschlossen');
  // Modules may hold a quote back here, for every caller (web, app, key, MCP, workflow) – e.g. the internal approval
  // (modules/quote-approvals.ts). A gate throws an HttpError.
  for (const gate of (app.services.quoteSendGates ?? []) as ((loc: string, q: QuoteRow) => void)[]) gate(loc, q);
  const contact = getContact(app, loc, q.contact_id);
  if (!contact) throw bad('Kontakt nicht gefunden');
  const deliver = o.deliver !== false;
  const channel = o.channel === 'sms' ? 'sms' : 'email';
  if (deliver && channel === 'email' && !contact.email) throw bad('Der Kontakt hat keine E-Mail-Adresse – senden ohne E-Mail und den Link selbst weitergeben');
  if (deliver && channel === 'sms' && !contact.phone) throw bad('Der Kontakt hat keine Telefonnummer');
  const selection = resolveSelection(q.doc);
  if (quoteTotals(q.doc, selection, q.tax_mode).total_cents < 0) throw bad('Der Gesamtbetrag darf nicht negativ sein');
  const patch: Record<string, any> = { updated_at: now() };
  if (!q.number) {
    q = app.db.tx(() => {
      const number = allocateNumber(app, loc, 'estimate', now());
      app.db.run('UPDATE deal_quotes SET number = ?, updated_at = ? WHERE id = ?', number, now(), q.id);
      return getQuote(app, loc, q.id)!;
    });
  }
  if (!q.valid_until || q.status === 'expired') patch.valid_until = q.status === 'expired' && q.valid_until && q.valid_until >= todayOf(app, loc) ? q.valid_until : validUntilFrom(new Date(), DEFAULT_VALID_DAYS, tzOf(app, loc));
  const url = quoteUrl(app, q);
  const location = app.location(loc)!;
  const totals = quoteTotals(q.doc, selection, q.tax_mode);
  let message: { status: string; error?: string | null } | undefined;
  if (deliver) {
    const vars = { contact: contactVars(contact), location, quote: { number: q.number, title: q.title, url, total: centsToMoney(totals.total_cents, q.currency), valid_until: (patch.valid_until ?? q.valid_until ?? '').split('-').reverse().join('.') } };
    const m = await sendToContact(app, loc, {
      contactId: contact.id,
      channel,
      subject: render(String(o.subject ?? '').trim() || 'Ihr Angebot {{quote.number}} von {{location.name}}', vars),
      body: render(String(o.body ?? '').trim() || 'Hallo {{contact.first_name|}},\n\nvielen Dank für Ihr Interesse. Hier ist unser Angebot „{{quote.title}}“ – Sie können es online ansehen, eine Variante wählen und direkt annehmen:\n{{quote.url}}\n\nGültig bis {{quote.valid_until}}.\n\nViele Grüße\n{{location.name}}', vars),
      userId: o.userId,
      source: 'Angebot',
      ignoreDnd: true,
    });
    message = { status: m.status, error: m.error };
    if (m.status === 'failed') throw bad(`Der Versand ist fehlgeschlagen: ${m.error}`);
  }
  const first = !q.sent_at;
  app.db.run(`UPDATE deal_quotes SET status = CASE WHEN status IN ('draft', 'expired') THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, ?), valid_until = COALESCE(?, valid_until), updated_at = ? WHERE id = ?`, now(), patch.valid_until ?? null, now(), q.id);
  // The new version replaces the open ones it came from.
  if (q.parent_id) {
    const old = getQuote(app, loc, q.parent_id);
    if (old && OPEN_STATUSES.includes(old.status)) {
      app.db.run(`UPDATE deal_quotes SET status = 'void', note = ?, updated_at = ? WHERE id = ?`, `Ersetzt durch Version ${q.revision}`, now(), old.id);
    }
  }
  const out = getQuote(app, loc, q.id)!;
  if (first) {
    logActivity(app, loc, q.contact_id, 'quote.sent', `Angebot ${out.number} „${out.title}“ ${deliver ? 'gesendet' : 'freigegeben'} (${centsToMoney(totals.total_cents, out.currency)})`, { quote_id: out.id });
    app.events.emit(loc, 'quote.sent', { contactId: q.contact_id, quote: eventQuote(out) });
  }
  return { quote: out, message };
}

/** What events and workflows get to know about a quote (never the link's token). */
export const eventQuote = (q: QuoteRow) => ({ id: q.id, number: q.number, title: q.title, status: q.status, deal_id: q.deal_id, currency: q.currency, total_cents: q.accepted_total_cents ?? null, valid_until: q.valid_until });

export function markViewed(app: App, q: QuoteRow): void {
  if (q.status !== 'sent') return;
  const r = app.db.run(`UPDATE deal_quotes SET status = 'viewed', viewed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`, now(), now(), q.id);
  if (!r.changes) return;
  logActivity(app, q.location_id, q.contact_id, 'quote.viewed', `Angebot ${q.number} geöffnet`, { quote_id: q.id });
  app.events.emit(q.location_id, 'quote.viewed', { contactId: q.contact_id, quote: eventQuote({ ...q, status: 'viewed' }) });
}

export function voidQuote(app: App, loc: string, q: QuoteRow, reason = ''): QuoteRow {
  if (q.status === 'accepted') throw new HttpError(409, 'Ein angenommenes Angebot bleibt bestehen – es gibt schon eine Unterschrift');
  if (q.status === 'void') return q;
  app.db.run(`UPDATE deal_quotes SET status = 'void', note = ?, updated_at = ? WHERE id = ?`, reason.slice(0, 300), now(), q.id);
  logActivity(app, loc, q.contact_id, 'quote.void', `Angebot ${q.number || q.title} zurückgezogen`, { quote_id: q.id });
  return getQuote(app, loc, q.id)!;
}

// --- the customer answers ----------------------------------------------------------------------------------------------------------------

export function declineQuote(app: App, q: QuoteRow, reason: string): void {
  if (!OPEN_STATUSES.includes(q.status)) throw new HttpError(409, 'Dieses Angebot kann nicht mehr beantwortet werden');
  const r = app.db.run(`UPDATE deal_quotes SET status = 'declined', declined_at = ?, decline_reason = ?, updated_at = ? WHERE id = ? AND status IN ('sent', 'viewed')`, now(), reason.slice(0, 1000), now(), q.id);
  if (!r.changes) throw new HttpError(409, 'Dieses Angebot kann nicht mehr beantwortet werden');
  logActivity(app, q.location_id, q.contact_id, 'quote.declined', `Angebot ${q.number} abgelehnt${reason ? `: ${reason.slice(0, 120)}` : ''}`, { quote_id: q.id });
  void notifyTeam(app, q.location_id, `Angebot abgelehnt: ${q.number}`, `${q.title}\nGrund: ${reason || '–'}`);
  app.events.emit(q.location_id, 'quote.declined', { contactId: q.contact_id, quote: eventQuote({ ...q, status: 'declined' }), reason });
}

export interface AcceptInput {
  option_id?: unknown;
  optional_ids?: unknown;
  name: string;
  signature: string;
  agree: boolean;
  ip: string;
  userAgent: string;
}

export interface AcceptResult {
  quote: QuoteRow;
  /** The invoice the customer pays now (deposit or full) and whether it could be sent; null when nothing is due. */
  invoice: { id: string; number: string; url: string; kind: 'deposit' | 'full'; total_cents: number; sent: boolean } | null;
}

/**
 * The customer signs. In order: check everything again on the server (the page's prices mean nothing), freeze the text as a signed
 * record, make the estimate (numbered, accepted), take the deal over (positions, amount, optionally "won") – and only then make and
 * send the invoice the customer pays now. The signature and the estimate hold even when the invoice cannot be made (the team is told).
 */
export async function acceptQuote(app: App, tok: string, input: AcceptInput): Promise<AcceptResult> {
  const q = quoteByToken(app, tok);
  if (!q || q.status === 'draft') throw notFound();
  const loc = q.location_id;
  if (q.status === 'accepted') throw new HttpError(409, 'Dieses Angebot wurde schon angenommen');
  if (!OPEN_STATUSES.includes(q.status)) throw new HttpError(409, q.status === 'expired' ? 'Dieses Angebot ist abgelaufen' : 'Dieses Angebot kann nicht mehr angenommen werden');
  if (isExpired(q.valid_until, todayOf(app, loc))) {
    app.db.run(`UPDATE deal_quotes SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('sent', 'viewed')`, now(), q.id);
    throw new HttpError(409, 'Dieses Angebot ist abgelaufen');
  }
  const name = input.name.trim().slice(0, 200);
  if (!name) throw bad('Bitte den vollständigen Namen angeben');
  if (!input.agree) throw bad('Bitte der Annahme zustimmen');
  if (!isSignatureImage(input.signature)) throw bad('Bitte unterschreiben');
  const selection = asHttp(() => resolveSelection(q.doc, { option_id: input.option_id, optional_ids: input.optional_ids }, true));
  const items = selectedItems(q.doc, selection);
  const totals = quoteTotals(q.doc, selection, q.tax_mode);
  if (!items.length || totals.total_cents <= 0) throw bad('Das Angebot hat keinen Betrag');
  const contact = getContact(app, loc, q.contact_id);
  const location = app.location(loc)!;
  const due = dueOnAccept(q, totals);
  const text = quoteContractText({
    number: q.number,
    title: q.title,
    currency: q.currency,
    valid_until: q.valid_until,
    intro: q.intro,
    terms: q.terms,
    customer: contactName(contact),
    seller: location.name,
    doc: q.doc,
    selection,
    totals,
    deposit: due ? { label: due.label, total_cents: due.total_cents } : null,
  });

  // 1. signature, estimate and the quote itself in one go
  const done = app.db.tx(() => {
    const claimed = app.db.run(`UPDATE deal_quotes SET status = 'accepted', accepted_at = ?, updated_at = ? WHERE id = ? AND status IN ('sent', 'viewed')`, now(), now(), q.id);
    if (!claimed.changes) throw new HttpError(409, 'Dieses Angebot wurde schon beantwortet');
    const estimate = createInvoice(app, loc, {
      kind: 'estimate',
      number: q.number,
      contact_id: q.contact_id,
      title: q.title,
      items: quoteDocItems(q.doc, selection),
      currency: q.currency,
      tax_mode: q.tax_mode,
      notes: [q.terms.trim(), `Angenommen am ${new Date().toLocaleDateString('de-DE', { timeZone: location.timezone })} von ${name}.`].filter(Boolean).join('\n\n'),
    });
    const contract = createSignedContract(app, { locationId: loc, contactId: q.contact_id, title: `Angebot ${q.number}: ${q.title}`, content: text, signerName: name, signature: input.signature, ip: input.ip, userAgent: input.userAgent });
    app.db.run(`UPDATE invoices SET status = 'accepted', sent_at = COALESCE(sent_at, ?), updated_at = ? WHERE id = ?`, now(), now(), estimate.id);
    invAudit(app, loc, estimate.id, 'quote.accepted', `online angenommen und unterschrieben (${name})`, SYSTEM);
    app.db.run(`UPDATE deal_quotes SET selection = ?, accepted_total_cents = ?, signer_name = ?, contract_id = ?, estimate_id = ?, updated_at = ? WHERE id = ?`, JSON.stringify(selection), totals.total_cents, name, contract.id, estimate.id, now(), q.id);
    return { contract, estimateId: estimate.id };
  });
  let cur = getQuote(app, loc, q.id)!;
  logActivity(app, loc, q.contact_id, 'quote.accepted', `Angebot ${q.number} angenommen und unterschrieben (${centsToMoney(totals.total_cents, q.currency)})`, { quote_id: q.id, contract_id: done.contract.id, estimate_id: done.estimateId });
  const est = loadInvoice(app, loc, done.estimateId);
  if (est) app.events.emit(loc, 'estimate.accepted', { contactId: q.contact_id, invoice: stripSnapshot(est) });
  app.events.emit(loc, 'quote.accepted', { contactId: q.contact_id, quote: eventQuote(cur), total_cents: totals.total_cents });

  // 2. the deal follows the offer: the positions the customer took, their net sum as the amount, and optionally "won"
  try {
    const deal = getOpportunity(app, loc, q.deal_id) as { id: string; contact_id: string; name: string; currency: string; status: string } | undefined;
    if (deal) {
      if (deal.currency === q.currency) setDealLines(app, loc, deal, items);
      if (q.deal_on_accept === 'won' && deal.status === 'open') updateOpportunity(app, loc, deal.id, { status: 'won' });
    }
  } catch (e) {
    console.error('[quotes] deal not updated', (e as Error).message);
  }

  // 3. what the customer pays now
  let result: AcceptResult['invoice'] = null;
  let problem = '';
  if (due) {
    try {
      const actor: Actor = { id: null, name: `Angebot ${q.number}` };
      let inv;
      if (due.kind === 'full') inv = convertEstimate(app, loc, done.estimateId, actor, { inv_type: 'standard' });
      else {
        const dep = depositLines(totals, q.payment, due.label, q.tax_mode);
        inv = createInvoice(app, loc, { kind: 'invoice', inv_type: 'partial', contact_id: q.contact_id, title: `${due.label} zu Angebot ${q.number}`, items: dep.items.map((i) => ({ ...i, name: `${i.name} – Angebot ${q.number}`.slice(0, 300) })), currency: q.currency, tax_mode: q.tax_mode, notes: q.terms.trim() });
        app.db.run('UPDATE invoices SET ref_id = ? WHERE id = ?', done.estimateId, inv.id);
      }
      let sent = false;
      try {
        const out = await sendInvoice(app, loc, { id: inv.id }, { actor, subject: `${due.kind === 'full' ? 'Rechnung' : 'Anzahlungsrechnung'} zu Ihrem Angebot ${q.number}` });
        inv = out;
        sent = true;
      } catch (e) {
        problem = `Die Rechnung zu Angebot ${q.number} liegt als Entwurf bereit, wurde aber nicht gesendet: ${(e as Error).message}`;
      }
      const fresh = mustInvoice(app, loc, inv.id);
      app.db.run('UPDATE deal_quotes SET invoice_id = ?, invoice_kind = ?, updated_at = ? WHERE id = ?', fresh.id, due.kind === 'full' ? 'standard' : 'partial', now(), q.id);
      result = { id: fresh.id, number: fresh.number, url: `${app.baseUrl()}/i/${fresh.public_token}`, kind: due.kind, total_cents: fresh.total_cents, sent };
    } catch (e) {
      problem = `Die Rechnung zu Angebot ${q.number} konnte nicht angelegt werden: ${(e as Error).message}`;
    }
  }
  if (problem) {
    app.db.run('UPDATE deal_quotes SET note = ? WHERE id = ?', problem.slice(0, 300), q.id);
    logActivity(app, loc, q.contact_id, 'quote.problem', problem.slice(0, 200), { quote_id: q.id });
  }
  cur = getQuote(app, loc, q.id)!;
  void notifyTeam(app, loc, `Angebot angenommen: ${q.number}`, `${name} hat „${q.title}“ angenommen und unterschrieben (${centsToMoney(totals.total_cents, q.currency)}).${problem ? `\n\nAchtung: ${problem}` : ''}\n\n${quoteUrl(app, q)}`);
  // A short confirmation with the signed copy; the invoice mail (if any) came separately.
  if (contact?.email && !result?.sent) {
    void sendToContact(app, loc, { contactId: contact.id, channel: 'email', subject: `Danke – Ihr Angebot ${q.number} ist angenommen`, body: `Hallo ${contact.first_name || ''},\n\nvielen Dank für Ihren Auftrag. Ihre unterschriebene Kopie finden Sie hier:\n${done.contract.url}\n\nViele Grüße\n${location.name}`, source: 'Angebot', ignoreDnd: true });
  }
  return { quote: cur, invoice: result };
}

// --- time and payments ----------------------------------------------------------------------------------------------------------------------

/** Quotes whose last day has passed end as "abgelaufen". */
export function expireQuotes(app: App, at = new Date()): number {
  let n = 0;
  for (const row of app.db.all<{ id: string; location_id: string }>(`SELECT id, location_id FROM deal_quotes WHERE status IN ('sent', 'viewed') AND valid_until IS NOT NULL AND valid_until < ?`, ymdInTz(new Date(at.getTime() + 14 * 3_600_000), 'UTC'))) {
    const q = getQuote(app, row.location_id, row.id);
    if (!q || !isExpired(q.valid_until, ymdInTz(at, tzOf(app, q.location_id)))) continue;
    if (!app.db.run(`UPDATE deal_quotes SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('sent', 'viewed')`, now(), q.id).changes) continue;
    n++;
    logActivity(app, q.location_id, q.contact_id, 'quote.expired', `Angebot ${q.number} ist abgelaufen`, { quote_id: q.id });
    app.events.emit(q.location_id, 'quote.expired', { contactId: q.contact_id, quote: eventQuote({ ...q, status: 'expired' }) });
  }
  return n;
}

/** The deposit or invoice of a quote was paid. */
export function invoicePaid(app: App, loc: string, invoiceId: string): void {
  const q = parse(app.db.get('SELECT * FROM deal_quotes WHERE location_id = ? AND invoice_id = ? AND paid_at IS NULL', loc, invoiceId));
  if (!q) return;
  app.db.run('UPDATE deal_quotes SET paid_at = ?, updated_at = ? WHERE id = ?', now(), now(), q.id);
  logActivity(app, loc, q.contact_id, 'quote.paid', `${q.invoice_kind === 'partial' ? 'Anzahlung' : 'Rechnung'} zu Angebot ${q.number} bezahlt`, { quote_id: q.id });
  app.events.emit(loc, 'quote.paid', { contactId: q.contact_id, quote: eventQuote(q) });
}

// --- numbers -------------------------------------------------------------------------------------------------------------------------------------

export function quoteStats(app: App, loc: string, scope?: { sql: string; params: any[] }) {
  const rows = app.db.all<{ status: string; n: number; sum: number }>(
    `SELECT q.status, COUNT(*) AS n, COALESCE(SUM(q.accepted_total_cents), 0) AS sum FROM deal_quotes q JOIN opportunities o ON o.id = q.deal_id WHERE q.location_id = ?${scope ? ` AND ${scope.sql}` : ''} GROUP BY q.status`,
    loc,
    ...(scope?.params ?? []),
  );
  const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const answered = by('accepted') + by('declined') + by('expired');
  return {
    by_status: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    sent: rows.filter((r) => r.status !== 'draft').reduce((n, r) => n + r.n, 0),
    open: by('sent') + by('viewed'),
    accepted: by('accepted'),
    accepted_cents: rows.find((r) => r.status === 'accepted')?.sum ?? 0,
    win_rate: answered ? Math.round((by('accepted') / answered) * 1000) / 10 : 0,
  };
}
