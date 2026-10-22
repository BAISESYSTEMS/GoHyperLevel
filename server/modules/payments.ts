import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { cached } from '../core/cache.js';
import { HttpError, bad, html, notFound, num, str } from '../core/http.js';
import { messagePage, publicPage } from '../core/page.js';
import { escapeHtml, render } from '../core/template.js';
import { centsToMoney, id, now, token } from '../core/util.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';
import type { DocSnapshot } from '../services/einvoice-model.js';
import { girocodeFor, qrSvg } from '../services/giro-code.js';
import {
  actorOf,
  adoptStragglers,
  allocateNumber,
  cleanItems,
  deductionCandidates,
  draftNumber,
  docOf,
  ensureFinal,
  finaliseInvoice,
  invAudit,
  loadInvoice,
  mustInvoice,
  parseInv,
  recordPayment,
  stornoInvoice,
  stripSnapshot,
  type Actor,
  type Inv,
} from '../services/invoice-flow.js';
import {
  INV_TYPES,
  TAX_MODES,
  UNITS,
  calcTotals,
  checkLeitwegId,
  checkVatId,
  cleanSkonto,
  cleanYmd,
  creditClosed,
  actionFor,
  StateError,
  deAmount,
  deYmd,
  deductionYmd,
  daysOverdue,
  docState,
  docTitle,
  DOC_STATE_LABELS,
  isDraftNumber,
  isTaxMode,
  lineNet,
  negateItems,
  openCents,
  paymentTermsText,
  type LineItem,
  type TaxMode,
} from '../services/invoice-model.js';
import { archiveEinvoice, archiveFile, einvoiceOf, invoicePdfOf } from '../services/invoice-render.js';
import { viesCheck } from '../services/vies.js';

export type { LineItem };

/** Net, tax and gross of a list of lines (rounded once per tax rate, as the e-invoice rules expect). */
export function totals(items: LineItem[], mode: TaxMode = 'standard') {
  const t = calcTotals(items, mode);
  return { subtotal_cents: t.subtotal_cents, tax_cents: t.tax_cents, total_cents: t.total_cents };
}

export function invoiceSettings(app: App, locationId: string) {
  const s = app.location(locationId)!.settings.invoices ?? {};
  return {
    prefix: s.prefix ?? 'RE-',
    next: Number(s.next) || 1001,
    tax_rate: s.small_business ? 0 : Number(s.tax_rate ?? 19),
    small_business: !!s.small_business,
    tax_mode: (isTaxMode(s.default_tax_mode) ? s.default_tax_mode : s.small_business ? 'small_business' : 'standard') as TaxMode,
    iban: s.iban ?? '',
    bic: s.bic ?? '',
    bank: s.bank ?? '',
    tax_id: s.tax_id ?? '',
    paypal: s.paypal ?? '',
    payment_terms_days: Number(s.payment_terms_days ?? 14),
    footer: s.footer ?? '',
  };
}

// --- what the API answers ---------------------------------------------------------------------------------------------------------

/** An invoice as the API returns it: no snapshot blob, no draft placeholder number, state, open amount and links. */
export function invoiceOut(app: App, inv: Inv, extra: Record<string, unknown> = {}) {
  const r = stripSnapshot(inv) as Record<string, any>;
  const state = docState(inv);
  const draft = isDraftNumber(inv.number);
  const open = openCents(inv as any);
  return {
    ...r,
    number: draft ? '' : inv.number,
    is_draft: inv.status === 'draft',
    locked: !!inv.finalised_at,
    state,
    state_label: DOC_STATE_LABELS[state],
    doc_title: docTitle(inv as any),
    open_cents: open,
    // calendar days of the sub-account's zone; 0 on the due day and for anything that is not open
    days_overdue: inv.kind === 'invoice' && inv.status === 'sent' && open > 0 ? daysOverdue(inv.due_at, new Date(), app.location(inv.location_id)?.timezone || 'Europe/Berlin') : 0,
    url: `${app.baseUrl()}/i/${inv.public_token}`,
    pdf_url: `${app.baseUrl()}/i/${inv.public_token}/pdf`,
    ...extra,
  };
}

// --- public page --------------------------------------------------------------------------------------------------------------------

function invoiceHtml(app: App, inv: Inv) {
  const loc = app.location(inv.location_id)!;
  const s = invoiceSettings(app, inv.location_id);
  const d: DocSnapshot = docOf(app, inv);
  const money = (v: number) => centsToMoney(v, d.currency);
  const isQuote = inv.kind === 'estimate';
  const credit = inv.kind === 'credit_note';
  const paid = inv.status === 'paid' && inv.kind === 'invoice';
  const cancelled = inv.status === 'void';
  const title = docTitle(inv as any);
  const open = inv.kind === 'invoice' ? openCents(inv as any) : 0;
  const link = inv.payment_link || (s.paypal && open > 0 ? `https://www.paypal.me/${encodeURIComponent(s.paypal)}/${(open / 100).toFixed(2)}${d.currency}` : '');
  // Online payment offered by another module (Stripe Checkout button), when configured.
  const online: string = !paid && !isQuote && !credit && !cancelled && open > 0 ? (app.services.invoicePayHtml?.(inv) ?? '') : '';
  const code = !isQuote && !credit && !cancelled && open > 0 ? girocodeFor({ name: d.seller.name, iban: d.bank.iban, bic: d.bank.bic, amount_cents: open, remittance: `${title} ${d.number}`.trim(), currency: d.currency }) : null;
  const addr = [d.buyer.company || d.buyer.name, d.buyer.company ? d.buyer.name : '', d.buyer.street, [d.buyer.postal_code, d.buyer.city].filter(Boolean).join(' ')].filter(Boolean);
  const supply = d.supply_to ? `${deYmd(d.supply_from)} – ${deYmd(d.supply_to)}` : d.supply_auto ? 'entspricht dem Rechnungsdatum' : deYmd(d.supply_from);
  const sign = credit ? 1 : -1;
  const terms = !isQuote && !credit ? paymentTermsText({ due_ymd: d.due_ymd, skonto: d.skonto, issued_ymd: d.issued_ymd, total_cents: open, currency: d.currency }) : '';
  const body = `<div class="wrap" style="max-width:860px"><div class="card">
  <div class="row" style="align-items:flex-start">
    <div>${loc.logo_url ? `<img src="${escapeHtml(loc.logo_url)}" alt="" style="max-height:60px">` : `<h2>${escapeHtml(loc.name)}</h2>`}
      <p class="muted" style="font-size:13px">${escapeHtml(d.seller.name)}<br>${escapeHtml(d.seller.street)}${d.seller.street ? '<br>' : ''}${escapeHtml([d.seller.postal_code, d.seller.city].filter(Boolean).join(' '))}${d.seller.email ? `<br>${escapeHtml(d.seller.email)}` : ''}${d.seller.vat_id ? `<br>USt-IdNr.: ${escapeHtml(d.seller.vat_id)}` : ''}${d.seller.tax_number ? `<br>Steuernr.: ${escapeHtml(d.seller.tax_number)}` : ''}</p></div>
    <div style="text-align:right"><h1>${escapeHtml(title)}</h1>
      <p>Nr. <strong>${escapeHtml(isDraftNumber(inv.number) ? 'Entwurf' : inv.number)}</strong><br>Datum: ${escapeHtml(deYmd(d.issued_ymd))}${!isQuote ? `<br>Leistungsdatum: ${escapeHtml(supply)}` : ''}${d.due_ymd && !isQuote && !credit ? `<br>Fällig: ${escapeHtml(deYmd(d.due_ymd))}` : ''}${d.ref ? `<br>Bezug: ${escapeHtml(d.ref.number)} vom ${escapeHtml(deYmd(d.ref.issued_ymd))}` : ''}</p>
      ${paid ? '<p class="ok" style="display:inline-block">Bezahlt ✓</p>' : cancelled ? (creditClosed(inv as any) ? '<p class="muted">Gutgeschrieben – nichts mehr offen</p>' : '<p class="error">Storniert</p>') : ''}</div>
  </div>
  <p><strong>${escapeHtml(addr[0] ?? '')}</strong>${addr.slice(1).map((a) => `<br>${escapeHtml(a)}`).join('')}${d.buyer.vat_id ? `<br><span class="muted">USt-IdNr.: ${escapeHtml(d.buyer.vat_id)}</span>` : ''}${d.buyer.leitweg_id ? `<br><span class="muted">Leitweg-ID: ${escapeHtml(d.buyer.leitweg_id)}</span>` : ''}</p>
  ${d.title ? `<h2>${escapeHtml(d.title)}</h2>` : ''}
  <div class="inv-scroll"><table class="inv-items"><thead><tr><th>Position</th><th style="text-align:right">Menge</th><th style="text-align:right">Einzelpreis</th>${d.tax_mode === 'standard' ? '<th style="text-align:right">USt.</th>' : ''}<th style="text-align:right">Gesamt</th></tr></thead><tbody>
  ${d.items.map((it) => `<tr><td>${escapeHtml(it.name)}${it.description ? `<br><span class="muted" style="font-size:13px">${escapeHtml(it.description)}</span>` : ''}</td><td style="text-align:right">${escapeHtml(String(it.qty).replace('.', ','))}${it.unit && UNITS[it.unit] ? ` ${escapeHtml(UNITS[it.unit])}` : ''}</td><td style="text-align:right">${money(it.price_cents)}</td>${d.tax_mode === 'standard' ? `<td style="text-align:right">${escapeHtml(String(it.tax_rate).replace('.', ','))} %</td>` : ''}<td style="text-align:right">${money(lineNet(it))}</td></tr>`).join('')}
  </tbody></table></div>
  <table style="max-width:420px;margin-left:auto;margin-top:12px">
    <tr><td>${d.tax_mode === 'standard' ? 'Netto' : 'Summe (ohne USt.)'}</td><td style="text-align:right">${money(d.totals.subtotal_cents)}</td></tr>
    ${d.tax_mode === 'standard' ? d.totals.groups.filter((g) => g.rate > 0 || g.tax_cents !== 0).map((g) => `<tr><td>USt. ${escapeHtml(String(g.rate).replace('.', ','))} % auf ${escapeHtml(deAmount(g.net_cents))}</td><td style="text-align:right">${money(g.tax_cents)}</td></tr>`).join('') : ''}
    <tr><td><strong>Gesamt</strong></td><td style="text-align:right"><strong>${money(d.totals.total_cents)}</strong></td></tr>
    ${d.deductions.map((x) => `<tr><td>abzgl. ${escapeHtml(INV_TYPES.partial)} ${escapeHtml(x.number)} vom ${escapeHtml(deYmd(deductionYmd(x)))}</td><td style="text-align:right">${money(sign * x.total_cents)}</td></tr>`).join('')}
    ${d.deductions.length ? `<tr><td><strong>${credit ? 'Erstattungsbetrag' : 'Noch zu zahlen'}</strong></td><td style="text-align:right"><strong>${money(d.totals.total_cents + sign * d.deducted_cents)}</strong></td></tr>` : ''}
  </table>
  ${d.tax_mode !== 'standard' && d.tax_note ? `<p style="font-size:13px"><strong>${escapeHtml(d.tax_note)}</strong></p>` : ''}
  ${d.notes ? `<p>${escapeHtml(d.notes).replace(/\n/g, '<br>')}</p>` : ''}
  ${terms ? `<p class="muted" style="font-size:13px">${escapeHtml(terms)}</p>` : ''}
  ${!paid && !isQuote && !credit && !cancelled && (d.bank.iban || link || online) ? `<div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:10px;display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">
    <div style="flex:1 1 300px">
    <strong>Zahlung</strong>
    ${online}
    ${d.bank.iban ? `<p style="margin:6px 0">Überweisung an ${escapeHtml(d.seller.name)}<br>IBAN: ${escapeHtml(d.bank.iban)}${d.bank.bic ? ` · BIC: ${escapeHtml(d.bank.bic)}` : ''}${d.bank.bank ? `<br>${escapeHtml(d.bank.bank)}` : ''}<br>Verwendungszweck: ${escapeHtml(d.number)}${open < inv.total_cents ? `<br>Offener Betrag: ${escapeHtml(money(open))}` : ''}</p>` : ''}
    ${link ? `<p><a class="btn" href="${escapeHtml(link)}" target="_blank" rel="noopener">Jetzt online bezahlen</a></p>` : ''}
    </div>
    ${code ? `<div style="text-align:center" class="giro">${qrSvg(code, 150)}<div class="muted" style="font-size:12px">GiroCode – mit der Banking-App scannen</div></div>` : ''}
  </div>` : ''}
  ${isQuote && inv.status !== 'accepted' && inv.status !== 'void' ? `<p style="margin-top:20px"><button id="accept">Angebot annehmen</button></p>` : ''}
  ${d.seller.footer ? `<p class="muted" style="font-size:12px;margin-top:24px">${escapeHtml(d.seller.footer)}</p>` : ''}
  <p class="noprint" style="margin-top:24px"><a class="btn secondary" href="/i/${escapeHtml(inv.public_token)}/pdf">PDF herunterladen</a> ${!isQuote && inv.finalised_at ? `<a class="btn secondary" href="/i/${escapeHtml(inv.public_token)}/xml">XRechnung (XML)</a> ` : ''}<button class="btn secondary" onclick="print()">Drucken</button></p>
</div></div>
<style>.inv-scroll { overflow-x: auto; } @media (max-width: 560px) { .inv-items td, .inv-items th { padding: 8px 4px; font-size: 13px } }
@media print { .noprint, #accept { display:none } body { background:#fff } .card { border:0; box-shadow:none } }</style>
${isQuote ? `<script>const a=document.getElementById('accept'); if(a) a.onclick=async()=>{ const r=await fetch('/api/public/invoices/${escapeHtml(inv.public_token)}/accept',{method:'POST'}); if(r.ok) location.reload(); };</script>` : ''}`;
  return publicPage({ title: `${title} ${isDraftNumber(inv.number) ? '' : inv.number}`.trim(), body });
}

// --- recurring invoices ----------------------------------------------------------------------------------------------------------------

export interface Recurring {
  interval: 'week' | 'month' | 'quarter' | 'year';
  next_at: string;
  auto_send: boolean;
  active: boolean;
  end_at?: string | null;
  /** The day of the month the subscription started on (1–31): kept after short months, so the 31st does not drift to the 28th. */
  day?: number;
}

const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The next date after `from` in the schedule. Months keep `day` (the subscription's own day of the month, default: the day of
 * `from`) and fall back to the last day of a shorter month – without taking that shorter day into the months after it.
 */
export function advanceDate(from: string, interval: Recurring['interval'], day?: number): string {
  const d = new Date(from);
  if (interval === 'week') return new Date(d.getTime() + 7 * 864e5).toISOString();
  const months = interval === 'year' ? 12 : interval === 'quarter' ? 3 : 1;
  const want = day && day >= 1 && day <= 31 ? day : d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()));
  target.setUTCDate(Math.min(want, lastDayOf(target.getUTCFullYear(), target.getUTCMonth())));
  return target.toISOString();
}

/** `day` as sent (the editor sends the stored schedule back) only when it fits the date; otherwise the date's own day of the month. */
function anchorDay(next: Date, day: unknown): number {
  const own = next.getUTCDate();
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 31) return own;
  return Math.min(n, lastDayOf(next.getUTCFullYear(), next.getUTCMonth())) === own ? n : own;
}

function cleanRecurring(v: any): Recurring | null {
  if (!v) return null;
  if (!['week', 'month', 'quarter', 'year'].includes(v.interval)) throw bad('Intervall: week, month, quarter oder year');
  const next = new Date(v.next_at || Date.now());
  if (Number.isNaN(next.getTime())) throw bad('Ungültiges Startdatum');
  const end = v.end_at ? new Date(v.end_at) : null;
  if (end && Number.isNaN(end.getTime())) throw bad('Ungültiges Enddatum');
  return { interval: v.interval, next_at: next.toISOString(), auto_send: v.auto_send !== false, active: v.active !== false, end_at: end ? end.toISOString() : null, day: anchorDay(next, v.day) };
}

// --- creating ------------------------------------------------------------------------------------------------------------------------------

/** The legal fields of a document from user input (create and patch). Only the fields present are returned. */
export function cleanLegalFields(input: Record<string, any>, current?: { tax_mode?: string; tax_note?: string }): Record<string, any> {
  const out: Record<string, any> = {};
  try {
    if (input.tax_mode !== undefined) {
      if (!isTaxMode(input.tax_mode)) throw new Error('Unbekannte Steuerbehandlung');
      out.tax_mode = input.tax_mode;
      // switching the mode loads its standard text unless a text was sent along
      if (input.tax_note === undefined && input.tax_mode !== current?.tax_mode) out.tax_note = TAX_MODES[input.tax_mode as TaxMode].note;
    }
    if (input.tax_note !== undefined) out.tax_note = str(input.tax_note, 'Hinweistext zur Steuer', { max: 600 });
    if (input.supply_from !== undefined) out.supply_from = cleanYmd(input.supply_from, 'Leistungsdatum') || null;
    if (input.supply_to !== undefined) out.supply_to = cleanYmd(input.supply_to, 'Leistungszeitraum bis') || null;
    if (out.supply_from !== undefined || out.supply_to !== undefined) {
      const from = out.supply_from ?? undefined;
      if (out.supply_to && from && out.supply_to < from) throw new Error('Leistungszeitraum: das Ende liegt vor dem Beginn');
    }
    if (input.buyer_vat_id !== undefined) {
      const raw = String(input.buyer_vat_id ?? '').trim();
      if (!raw) out.buyer_vat_id = '';
      else {
        const c = checkVatId(raw);
        if (!c.valid) throw new Error(`USt-IdNr. des Kunden: ${c.reason}`);
        out.buyer_vat_id = c.normalized;
      }
    }
    if (input.leitweg_id !== undefined) {
      const raw = String(input.leitweg_id ?? '').trim();
      if (raw && !checkLeitwegId(raw).valid) throw new Error(`Leitweg-ID: ${checkLeitwegId(raw).reason}`);
      out.leitweg_id = raw;
    }
    if (input.buyer_ref !== undefined) out.buyer_ref = str(input.buyer_ref, 'Kundenreferenz', { max: 100 });
    if (input.skonto !== undefined || input.skonto_percent !== undefined || input.skonto_days !== undefined) {
      const sk = input.skonto === null ? null : input.skonto && typeof input.skonto === 'object' ? cleanSkonto(input.skonto.percent, input.skonto.days) : cleanSkonto(input.skonto_percent, input.skonto_days);
      out.skonto_percent = sk?.percent ?? null;
      out.skonto_days = sk?.days ?? null;
    }
    if (input.inv_type !== undefined) {
      if (!['standard', 'partial', 'final'].includes(input.inv_type)) throw new Error('Rechnungsart: standard, partial oder final');
      out.inv_type = input.inv_type;
    }
    if (input.deduct_ids !== undefined) {
      if (!Array.isArray(input.deduct_ids)) throw new Error('Abzuziehende Abschlagsrechnungen: Liste von IDs');
      out.deduct_ids = input.deduct_ids.map(String).slice(0, 50);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad((e as Error).message);
  }
  return out;
}

export type CreatedInvoice = Record<string, any> & { id: string; kind: 'invoice' | 'estimate'; number: string; contact_id: string | null; status: string; currency: string; subtotal_cents: number; tax_cents: number; total_cents: number; items: LineItem[] };

/** Creates a draft invoice (no number yet – it is given out when the invoice is finalised) or a quote (numbered at once). */
export function createInvoice(app: App, locationId: string, input: Record<string, any>): CreatedInvoice {
  const db = app.db;
  const s = invoiceSettings(app, locationId);
  const kind = input.kind === 'estimate' ? 'estimate' : 'invoice';
  const mode: TaxMode = isTaxMode(input.tax_mode) ? input.tax_mode : s.tax_mode;
  const items = cleanItems(input.items, s.tax_rate, mode);
  if (input.contact_id && !getContact(app, locationId, input.contact_id)) throw bad('Kontakt nicht gefunden');
  if (kind === 'invoice' && str(input.number, 'Nummer')) throw bad('Rechnungsnummern vergibt HyperLevel beim Festschreiben – fortlaufend und ohne Lücken');
  const legal = cleanLegalFields({ ...input, tax_mode: mode }, { tax_mode: mode, tax_note: '' });
  if (legal.tax_note === undefined) legal.tax_note = mode === 'standard' ? '' : TAX_MODES[mode].note;
  if (legal.inv_type && legal.inv_type !== 'standard' && kind !== 'invoice') throw bad('Abschlags- und Schlussrechnungen gibt es nur bei Rechnungen');
  if ((legal.deduct_ids?.length ?? 0) && legal.inv_type !== 'final') throw bad('Abschlagsrechnungen lassen sich nur in einer Schlussrechnung abziehen');
  const issued = input.issued_at ? new Date(input.issued_at).toISOString() : now();
  const t = totals(items, mode);
  const row: Record<string, any> = {
    id: id(),
    location_id: locationId,
    kind,
    number: draftNumber(),
    contact_id: input.contact_id || null,
    title: str(input.title, 'Titel', { max: 300 }),
    items,
    currency: /^[A-Z]{3}$/.test(input.currency ?? '') ? input.currency : 'EUR',
    ...t,
    status: 'draft',
    notes: str(input.notes, 'Hinweise', { max: 5000 }),
    payment_link: str(input.payment_link, 'Zahlungslink', { max: 1000 }) || null,
    public_token: token(18),
    issued_at: issued,
    due_at: input.due_at ? new Date(input.due_at).toISOString() : new Date(new Date(issued).getTime() + s.payment_terms_days * 864e5).toISOString(),
    recurring: input.recurring ? cleanRecurring(input.recurring) : null,
    parent_id: input.parent_id ?? null,
    created_at: now(),
    updated_at: now(),
    tax_mode: mode,
    calc: 'group',
    issued_auto: input.issued_at ? 0 : 1,
    ...legal,
  };
  if (row.skonto_percent === undefined) {
    row.skonto_percent = null;
    row.skonto_days = null;
  }
  if (Array.isArray(row.deduct_ids) && row.deduct_ids.length) {
    for (const pid of row.deduct_ids) if (!db.get('SELECT 1 AS x FROM invoices WHERE id = ? AND location_id = ? AND kind = \'invoice\'', pid, locationId)) throw bad('Eine abzuziehende Abschlagsrechnung gibt es nicht');
  }
  db.tx(() => {
    if (kind === 'estimate') {
      const manual = str(input.number, 'Nummer');
      if (manual) {
        if (db.get('SELECT id FROM invoices WHERE location_id = ? AND number = ?', locationId, manual)) throw bad('Nummer schon vergeben');
        row.number = manual;
      } else row.number = allocateNumber(app, locationId, 'estimate', issued);
    }
    db.insert('invoices', row);
    invAudit(app, locationId, row.id, 'invoice.created', kind === 'estimate' ? `Angebot ${row.number}` : 'Entwurf angelegt');
  });
  return { ...row, number: row.kind === 'invoice' ? '' : row.number } as CreatedInvoice;
}

// --- sending --------------------------------------------------------------------------------------------------------------------------------

export interface SendOptions {
  subject?: string;
  body?: string;
  channel?: string;
  userId?: string;
  actor?: Actor;
  /** Attach the PDF (default: the sub-account's setting, on). */
  attach_pdf?: boolean;
  /** Attach the XRechnung as XML (default: the sub-account's setting, off) – 'cii' or 'ubl'. */
  attach_xrechnung?: boolean | 'cii' | 'ubl';
  /** The ZUGFeRD PDF instead of the plain PDF (default: the sub-account's setting `attach_zugferd`, off; modules/invoice-zugferd.ts). */
  attach_zugferd?: boolean;
}

/**
 * Documents on their way right now. A double click on "Senden", two colleagues or a workflow step at the same moment: the second
 * send is refused (409) instead of mailing the customer the same invoice or quote again. Once the first one is through, sending
 * again (a deliberate resend) works as before.
 */
const sendingDocs = new Set<string>();

/**
 * Finalises a draft (number, freeze), then e-mails (or texts) the customer the document: with the PDF – and, if wanted, the
 * XRechnung – attached and a link to the online version. Quotes are sent as they are. Returns the invoice as it is now.
 */
export async function sendInvoice(app: App, locationId: string, inv0: { id?: string } | undefined, opts: SendOptions = {}): Promise<Inv> {
  if (!inv0?.id) throw notFound();
  const inv = mustInvoice(app, locationId, inv0.id);
  if (sendingDocs.has(inv.id)) throw new HttpError(409, `${inv.kind === 'estimate' ? 'Das Angebot' : 'Das Dokument'} wird gerade gesendet – bitte einen Moment warten`);
  sendingDocs.add(inv.id);
  try {
    return await sendInvoiceNow(app, locationId, inv, opts);
  } finally {
    sendingDocs.delete(inv.id);
  }
}

async function sendInvoiceNow(app: App, locationId: string, inv0: Inv, opts: SendOptions): Promise<Inv> {
  let inv = inv0;
  if (!inv.contact_id) throw bad('Rechnung hat keinen Kontakt');
  const c = getContact(app, locationId, inv.contact_id);
  if (!c) throw bad('Kontakt nicht gefunden');
  const channel = opts.channel === 'sms' ? 'sms' : 'email';
  if (channel === 'email' && !c.email) throw bad('Kontakt hat keine E-Mail-Adresse');
  if (channel === 'sms' && !c.phone) throw bad('Kontakt hat keine Telefonnummer');
  const loc = app.location(locationId)!;
  const cfg = loc.settings.invoices ?? {};
  const actor = opts.actor ?? (opts.userId ? { id: opts.userId, name: 'Nutzer' } : { id: null, name: 'System' });
  const isQuote = inv.kind === 'estimate';
  if (!isQuote && inv.status === 'void') throw new HttpError(409, 'Das Dokument ist storniert');
  // Number and freeze come first – the mail names the number and carries the PDF.
  if (!isQuote && !inv.finalised_at) inv = (await finaliseChecked(app, locationId, inv.id, { actor, adopt: inv.status !== 'draft' })).invoice;
  const doc = docTitle(inv as any);
  const url = `${app.baseUrl()}/i/${inv.public_token}`;
  // A credit note is stored with negative amounts; the mail says "deine Gutschrift … über 11,90 €", not "über -11,90 €".
  const shown = inv.kind === 'credit_note' ? Math.abs(inv.total_cents) : inv.total_cents;
  const vars = { contact: contactVars(c), location: loc, invoice: { ...stripSnapshot(inv), number: inv.number, url, pdf_url: `${url}/pdf`, doc, total: centsToMoney(shown, inv.currency) } };
  const subject = render(opts.subject || `${doc} {{invoice.number}} von {{location.name}}`, vars);
  const attachNote = channel === 'email' && opts.attach_pdf !== false && cfg.attach_pdf !== false ? '\n(PDF im Anhang)' : '';
  const body = render(opts.body || `Hallo {{contact.first_name|}},\n\nanbei ${isQuote ? 'unser Angebot' : inv.kind === 'credit_note' ? 'deine Gutschrift' : 'deine Rechnung'} {{invoice.number}} über {{invoice.total}}:${attachNote}\n{{invoice.url}}\n\nViele Grüße\n{{location.name}}`, vars);
  const attachments: { filename: string; content: string; contentType: string; encoding?: 'base64' }[] = [];
  if (channel === 'email' && opts.attach_pdf !== false && cfg.attach_pdf !== false) {
    // a module may hand the hybrid e-invoice PDF (ZUGFeRD) instead – it archives that copy itself
    const hybrid: { pdf: Buffer; filename: string } | null = !isQuote && inv.finalised_at ? (app.services.invoiceMailPdf?.(inv, { actor, wanted: opts.attach_zugferd }) ?? null) : null;
    const out = hybrid ?? invoicePdfOf(app, inv);
    attachments.push({ filename: out.filename, content: out.pdf.toString('base64'), contentType: 'application/pdf', encoding: 'base64' });
    if (!hybrid && !isQuote && inv.finalised_at) archiveFile(app, inv, 'pdf', { name: out.filename, mime: 'application/pdf', data: out.pdf }, actor);
  }
  const wantXml = opts.attach_xrechnung ?? (cfg.attach_xrechnung ? (cfg.einvoice_syntax === 'ubl' ? 'ubl' : 'cii') : false);
  if (channel === 'email' && wantXml && !isQuote) {
    try {
      const out = einvoiceOf(app, inv, wantXml === 'ubl' ? 'ubl' : 'cii');
      attachments.push({ filename: out.filename, content: out.xml, contentType: 'application/xml' });
      archiveEinvoice(app, inv, out, actor);
    } catch (e) {
      // asked for explicitly: say why it did not work; only configured as default: send without
      if (opts.attach_xrechnung) throw e;
      invAudit(app, locationId, inv.id, 'einvoice.attach_skipped', (e as Error).message.slice(0, 300), actor);
    }
  }
  const m = await sendToContact(app, locationId, { contactId: c.id, channel, subject, body, source: isQuote ? 'Angebot' : inv.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung', ignoreDnd: true, userId: opts.userId, ...(attachments.length ? { attachments } : {}) });
  if (m.status === 'failed') {
    if (!isQuote) invAudit(app, locationId, inv.id, 'invoice.send_failed', String(m.error).slice(0, 300), actor);
    throw bad(inv.finalised_at && !isQuote ? `Die Rechnung ist festgeschrieben (${inv.number}), aber der Versand ist fehlgeschlagen: ${m.error}` : m.error);
  }
  app.db.run(`UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = ?, updated_at = ? WHERE id = ?`, now(), now(), inv.id);
  invAudit(app, locationId, inv.id, 'invoice.sent', `${channel === 'sms' ? 'SMS' : 'E-Mail'} an ${channel === 'sms' ? c.phone : c.email}${attachments.length ? ` · Anhänge: ${attachments.map((a) => a.filename).join(', ')}` : ''}`, actor);
  return mustInvoice(app, locationId, inv.id);
}

/** Finalising with the optional VIES check of the buyer's VAT ID (a setting). `idempotent`: an already final invoice is returned as it is. */
export async function finaliseChecked(app: App, loc: string, invoiceId: string, o: { actor?: Actor; issued_at?: string; adopt?: boolean; idempotent?: boolean } = {}): Promise<{ invoice: Inv; warnings: string[] }> {
  const inv = mustInvoice(app, loc, invoiceId);
  if (o.idempotent && (inv.finalised_at || inv.kind === 'estimate')) return { invoice: inv, warnings: [] };
  const cfg = app.location(loc)?.settings.invoices ?? {};
  const warnings: string[] = [];
  let vies: DocSnapshot['vies'] = null;
  if (cfg.vies_check && inv.buyer_vat_id && checkVatId(inv.buyer_vat_id).valid) {
    const r = await viesCheck(app, inv.buyer_vat_id);
    if (r.checked) {
      vies = { checked_at: now(), valid: !!r.valid, ...(r.name ? { name: r.name } : {}), ...(r.address ? { address: r.address } : {}) };
      if (!r.valid) {
        const needs = TAX_MODES[isTaxMode(inv.tax_mode) ? inv.tax_mode : 'standard'].needsBuyerVat;
        const msg = `VIES kennt die USt-IdNr. ${inv.buyer_vat_id} nicht als gültig`;
        if (needs) throw new HttpError(409, `${msg} – ohne gültige USt-IdNr. ist ${TAX_MODES[inv.tax_mode as TaxMode].label} nicht zulässig`);
        warnings.push(msg);
      }
    } else warnings.push(`USt-IdNr. nicht über VIES geprüft: ${r.error ?? 'nicht erreichbar'}`);
  }
  const fin = finaliseInvoice(app, loc, invoiceId, { actor: o.actor, issued_at: o.issued_at, adopt: o.adopt ?? (inv.status !== 'draft'), vies, warnings });
  return fin;
}

// --- paying ----------------------------------------------------------------------------------------------------------------------------------------

/**
 * Marks an invoice paid once (idempotent) – records the open amount as a payment – and fires invoice.paid for workflows and webhooks.
 * `paidAt`: when the money arrived (a bank statement line's booking day); default now.
 */
export function markInvoicePaid(app: App, locationId: string, invoiceId: string, via = '', paidAt?: string): boolean {
  const inv = loadInvoice(app, locationId, invoiceId);
  if (!inv || inv.status === 'paid') return false;
  if (inv.kind === 'estimate' || inv.kind === 'credit_note') {
    // quotes carry a legacy "paid" flag, credit notes are settled by a refund: no payment row, no revenue event
    if (inv.kind === 'credit_note') ensureFinal(app, locationId, invoiceId, { actor: { id: null, name: via ? `Automatik (${via})` : 'System' }, adopt: inv.status !== 'draft' });
    const r = app.db.run(`UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ? AND location_id = ? AND status != 'paid'`, now(), now(), invoiceId, locationId);
    return r.changes > 0 && inv.kind === 'estimate' ? emitPaid(app, locationId, invoiceId) : r.changes > 0;
  }
  if (inv.status === 'void') return false;
  const actor: Actor = { id: null, name: via ? `Automatik (${via})` : 'System' };
  const cur = ensureFinal(app, locationId, invoiceId, { actor, adopt: inv.status !== 'draft' });
  if (openCents(cur as any) <= 0) {
    // nothing open (credited / deducted in full): settle without a payment
    const r = app.db.run(`UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ? AND status != 'paid'`, paidAt ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(paidAt) ? `${paidAt}T12:00:00.000Z` : paidAt).toISOString() : now(), now(), invoiceId);
    return r.changes > 0 ? emitPaid(app, locationId, invoiceId, via) : false;
  }
  try {
    recordPayment(app, locationId, invoiceId, { method: via || 'manuell', ...(paidAt ? { paid_at: paidAt } : {}) }, actor, { source: via === 'Bank' ? 'bank' : via ? 'auto' : 'manual', via });
    return true;
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return false;
    throw e;
  }
}

function emitPaid(app: App, locationId: string, invoiceId: string, via = ''): boolean {
  const inv = loadInvoice(app, locationId, invoiceId)!;
  if (inv.contact_id) logActivity(app, locationId, inv.contact_id, 'invoice.paid', `Rechnung ${inv.number} bezahlt (${centsToMoney(inv.total_cents, inv.currency)})${via ? ` – ${via}` : ''}`);
  app.events.emit(locationId, 'invoice.paid', { contactId: inv.contact_id, invoice: stripSnapshot(inv), ...(via ? { via } : {}) });
  return true;
}

/** Issues the next invoice of every subscription that is due (one per run, never a backlog). */
export async function runRecurringInvoices(app: App, at = new Date()) {
  const db = app.db;
  const DUE = `recurring IS NOT NULL AND json_extract(recurring, '$.active') = 1 AND json_extract(recurring, '$.next_at') <= ?`;
  const due = db.all<{ id: string }>(`SELECT id FROM invoices WHERE ${DUE}`, at.toISOString());
  const created: string[] = [];
  for (const { id: parentId } of due) {
    // Read each subscription when its turn comes: sending the invoices before it takes a while, and somebody may have ended,
    // paused or moved it meanwhile – an old copy would issue an invoice anyway and write the subscription back to life.
    const parent = parseJson(db.get(`SELECT * FROM invoices WHERE id = ? AND ${DUE}`, parentId, at.toISOString()), ['items', 'recurring', 'deduct_ids']);
    if (!parent) continue;
    const r: Recurring = parent.recurring;
    let next = r.next_at;
    // Subscriptions saved before `day` existed: the day of the date they are on now.
    const day = r.day ?? new Date(r.next_at).getUTCDate();
    while (next <= at.toISOString()) next = advanceDate(next, r.interval, day);
    const ended = !!r.end_at && next > r.end_at;
    db.run('UPDATE invoices SET recurring = ? WHERE id = ?', JSON.stringify({ ...r, next_at: next, active: !ended, day }), parent.id);
    try {
      const child = createInvoice(app, parent.location_id, {
        kind: 'invoice',
        contact_id: parent.contact_id,
        title: parent.title,
        items: parent.items,
        currency: parent.currency,
        notes: parent.notes,
        payment_link: parent.payment_link,
        parent_id: parent.id,
        tax_mode: parent.tax_mode,
        tax_note: parent.tax_note,
        buyer_vat_id: parent.buyer_vat_id,
        leitweg_id: parent.leitweg_id,
        buyer_ref: parent.buyer_ref,
        skonto_percent: parent.skonto_percent,
        skonto_days: parent.skonto_days,
      });
      created.push(child.id);
      if (r.auto_send && child.contact_id) await sendInvoice(app, parent.location_id, child);
      app.events.emit(parent.location_id, 'invoice.created', { contactId: child.contact_id, invoice: child, recurring: true });
    } catch (e) {
      console.error('[invoices] recurring', parent.id, (e as Error).message);
    }
  }
  return created;
}

// --- module --------------------------------------------------------------------------------------------------------------------------------------

/** Columns the list needs (everything but the big snapshot). */
let listCols = '';
const LIST_COLS = (app: App) => (listCols ||= app.db.all<{ name: string }>('PRAGMA table_info(invoices)').filter((c) => c.name !== 'snapshot').map((c) => `i.${c.name}`).join(', '));

export const paymentsModule: Module = {
  name: 'payments',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE products (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'EUR', tax_rate REAL, recurring TEXT, payment_link TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'invoice', number TEXT NOT NULL, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '[]', currency TEXT NOT NULL DEFAULT 'EUR',
        subtotal_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft', notes TEXT NOT NULL DEFAULT '', payment_link TEXT, public_token TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL, due_at TEXT, sent_at TEXT, paid_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, number)
      );
      `,
    ],
    [
      '002-recurring',
      `
      ALTER TABLE invoices ADD COLUMN recurring TEXT;
      ALTER TABLE invoices ADD COLUMN parent_id TEXT;
      CREATE INDEX invoices_parent ON invoices(parent_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const refresh = (locationId: string, invoiceId: string) => {
      // an invoice another module flipped to "sent" behind the scenes is numbered and frozen before anyone looks at it
      const raw = db.get<{ status: string; finalised_at: string | null; kind: string }>('SELECT status, finalised_at, kind FROM invoices WHERE id = ? AND location_id = ?', invoiceId, locationId);
      if (raw && !raw.finalised_at && raw.kind !== 'estimate' && raw.status !== 'draft') adoptStragglers(app, locationId);
      return loadInvoice(app, locationId, invoiceId);
    };

    router.get('/api/products', 'location', (ctx) => db.all('SELECT * FROM products WHERE location_id = ? ORDER BY name', ctx.locationId));
    router.post('/api/products', 'location', (ctx) => {
      const row = {
        id: id(),
        location_id: ctx.locationId,
        name: str(ctx.body.name, 'Name', { required: true, max: 200 }),
        description: str(ctx.body.description, 'Beschreibung', { max: 5000 }),
        price_cents: Math.round(num(ctx.body.price_cents)),
        currency: /^[A-Z]{3}$/.test(ctx.body.currency ?? '') ? ctx.body.currency : 'EUR',
        tax_rate: ctx.body.tax_rate === undefined || ctx.body.tax_rate === '' ? null : num(ctx.body.tax_rate),
        recurring: ['month', 'year'].includes(ctx.body.recurring) ? ctx.body.recurring : null,
        payment_link: str(ctx.body.payment_link, 'Zahlungslink', { max: 1000 }) || null,
        active: 1,
        created_at: now(),
      };
      db.insert('products', row);
      return row;
    });
    router.patch('/api/products/:id', 'location', (ctx) => {
      const patch: Record<string, any> = {};
      for (const k of ['name', 'description', 'payment_link']) if (ctx.body[k] !== undefined) patch[k] = String(ctx.body[k]);
      if (ctx.body.price_cents !== undefined) patch.price_cents = Math.round(num(ctx.body.price_cents));
      if (ctx.body.tax_rate !== undefined) patch.tax_rate = ctx.body.tax_rate === '' ? null : num(ctx.body.tax_rate);
      if (ctx.body.active !== undefined) patch.active = ctx.body.active ? 1 : 0;
      if (!db.update('products', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return db.get('SELECT * FROM products WHERE id = ?', ctx.params.id);
    });
    router.delete('/api/products/:id', 'location', (ctx) => {
      db.run('DELETE FROM products WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    router.get('/api/invoices', 'location', (ctx) =>
      cached(app, ctx, 10_000, () => {
        const q = ctx.query.get('kind');
        const kind = q === 'estimate' ? 'estimate' : q === 'credit_note' ? 'credit_note' : 'invoice';
        return parseRows(
          db.all(
            `SELECT ${LIST_COLS(app)}, c.first_name, c.last_name, c.email, c.company FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
             WHERE i.location_id = ? AND i.kind = ? ORDER BY i.created_at DESC LIMIT 1000`,
            ctx.locationId,
            kind,
          ),
          ['items', 'recurring', 'deduct_ids'],
        ).map((r) => invoiceOut(app, { ...r, snapshot: null } as Inv));
      }),
    );
    router.get('/api/invoices/:id', 'location', (ctx) => {
      const i = refresh(ctx.locationId, ctx.params.id);
      if (!i) throw notFound();
      const children = db.all('SELECT id, number, status, issued_at, total_cents, currency FROM invoices WHERE parent_id = ? ORDER BY issued_at DESC', i.id);
      const rel = (rows: any[]) => rows.map((r) => ({ ...r, number: isDraftNumber(r.number) ? '' : r.number }));
      const credit_notes = rel(db.all(`SELECT id, number, status, credit_type, issued_at, total_cents, currency FROM invoices WHERE ref_id = ? AND kind = 'credit_note' ORDER BY created_at`, i.id));
      const ref = i.ref_id ? rel(db.all('SELECT id, number, kind, status, issued_at, total_cents, currency FROM invoices WHERE id = ? AND location_id = ?', i.ref_id, ctx.locationId))[0] ?? null : null;
      const converted = i.kind === 'estimate' ? rel(db.all(`SELECT id, number, status, inv_type, total_cents, currency FROM invoices WHERE ref_id = ? AND kind = 'invoice' ORDER BY created_at`, i.id)) : [];
      const payments = db.all('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at', i.id);
      const doc = docOf(app, i);
      return invoiceOut(app, i, {
        children,
        credit_notes,
        ref,
        converted,
        payments,
        deductions: doc.deductions,
        deduction_candidates: i.inv_type === 'final' && !i.finalised_at ? deductionCandidates(app, ctx.locationId, i).map((r: any) => ({ ...r, number: isDraftNumber(r.number) ? '' : r.number })) : [],
        skonto: doc.skonto,
        totals: doc.totals,
        seller: doc.seller,
        archive: db.all('SELECT id, kind, sha256, size, retention_until, created_at FROM invoice_documents WHERE invoice_id = ? ORDER BY created_at', i.id),
      });
    });
    router.post('/api/invoices', 'location', (ctx) => invoiceOut(app, mustInvoice(app, ctx.locationId, createInvoice(app, ctx.locationId, ctx.body ?? {}).id)));
    router.patch('/api/invoices/:id', 'location', async (ctx) => {
      let inv = refresh(ctx.locationId, ctx.params.id);
      if (!inv) throw notFound();
      const actor = actorOf(ctx);
      const body = ctx.body ?? {};
      const locked = !!inv.finalised_at;
      const patch: Record<string, any> = { updated_at: now() };
      const mode: TaxMode = isTaxMode(body.tax_mode) ? body.tax_mode : isTaxMode(inv.tax_mode) ? inv.tax_mode : 'standard';
      const refuse = (field: string) => new HttpError(409, `Festgeschriebene Rechnung ${inv!.number}: „${field}“ lässt sich nicht mehr ändern. Storniere die Rechnung und schreibe eine neue – nur Hinweistext, Fälligkeit, Zahlungslink und Abo lassen sich noch anpassen.`, { locked: true, field });
      const lockedQuote = inv.kind === 'estimate' && (inv.status === 'accepted' || db.get('SELECT 1 AS x FROM invoices WHERE ref_id = ? LIMIT 1', inv.id));
      const frozen = locked || lockedQuote;
      const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

      if (body.items !== undefined) {
        // a credit note is edited like any document (positive quantities) and stored negative
        const given = inv.kind === 'credit_note' && Array.isArray(body.items) ? body.items.map((it: any) => ({ ...it, qty: Math.abs(Number(it?.qty ?? 1)) })) : body.items;
        const clean = cleanItems(given, invoiceSettings(app, ctx.locationId).tax_rate, mode);
        const items = inv.kind === 'credit_note' ? negateItems(clean) : clean;
        if (frozen) {
          if (changed(items, inv.items)) throw refuse('Positionen');
        } else {
          patch.items = items;
          Object.assign(patch, totals(items, mode));
        }
      }
      for (const k of ['title'] as const) if (body[k] !== undefined) {
        if (frozen && String(body[k]) !== String(inv[k] ?? '')) throw refuse('Titel');
        if (!frozen) patch[k] = String(body[k]).slice(0, 300);
      }
      for (const k of ['notes', 'payment_link'] as const) if (body[k] !== undefined) patch[k] = String(body[k]);
      if (body.contact_id !== undefined) {
        const next = body.contact_id || null;
        if (frozen && next !== inv.contact_id) throw refuse('Kunde');
        if (!frozen) {
          if (next && !getContact(app, ctx.locationId, next)) throw bad('Kontakt nicht gefunden');
          patch.contact_id = next;
        }
      }
      if (body.due_at !== undefined && inv.kind !== 'credit_note') patch.due_at = body.due_at ? new Date(body.due_at).toISOString() : null;
      if (body.issued_at !== undefined) {
        const next = body.issued_at ? new Date(body.issued_at).toISOString() : null;
        if (!next || Number.isNaN(new Date(next).getTime())) throw bad('Ungültiges Rechnungsdatum');
        if (frozen && next.slice(0, 10) !== String(inv.issued_at).slice(0, 10)) throw refuse('Rechnungsdatum');
        if (!frozen) {
          patch.issued_at = next;
          patch.issued_auto = 0;
        }
      }
      const legal = cleanLegalFields(body, { tax_mode: inv.tax_mode, tax_note: inv.tax_note });
      const norm = (x: any) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
      const label = (k: string) => (k === 'tax_mode' || k === 'tax_note' ? 'Steuerbehandlung' : k === 'inv_type' || k === 'deduct_ids' ? 'Rechnungsart' : k.startsWith('skonto') ? 'Skonto' : k.startsWith('supply') ? 'Leistungsdatum' : 'Kundenangaben');
      for (const [k, v] of Object.entries(legal)) {
        if (frozen) {
          if (norm(v) !== norm(inv[k])) throw refuse(label(k));
        } else patch[k] = v;
      }
      if (!frozen && legal.tax_mode !== undefined && legal.tax_mode !== 'standard' && body.items === undefined) {
        // the mode carries the legal text and 0 % – bring the saved lines along
        const items = inv.items.map((it) => ({ ...it, tax_rate: 0 }));
        patch.items = items;
        Object.assign(patch, totals(items, legal.tax_mode));
      }
      // a client that sends the whole document back says `standard` and no deductions – that is no request for a partial invoice
      if (!frozen && inv.kind !== 'invoice' && ((legal.inv_type !== undefined && legal.inv_type !== 'standard') || (Array.isArray(legal.deduct_ids) && legal.deduct_ids.length))) throw bad('Abschlags- und Schlussrechnungen gibt es nur bei Rechnungen');
      if (body.recurring !== undefined) {
        if (inv.kind !== 'invoice') throw bad('Nur Rechnungen können wiederkehren');
        if (inv.parent_id) throw bad('Das ist eine erzeugte Rechnung – das Abo steckt in der Vorlage');
        patch.recurring = cleanRecurring(body.recurring);
        if (patch.recurring === null) {
          db.run('UPDATE invoices SET recurring = NULL WHERE id = ?', inv.id);
          delete patch.recurring;
        }
      }
      // what changes on a final invoice goes into the trail
      const trail = locked ? ['notes', 'due_at', 'payment_link'].filter((k) => patch[k] !== undefined && String(patch[k] ?? '') !== String(inv![k] ?? '')) : [];
      db.update('invoices', inv.id, patch);
      for (const k of trail) invAudit(app, ctx.locationId, inv.id, 'invoice.amended', `${k === 'notes' ? 'Hinweistext' : k === 'due_at' ? 'Fälligkeit' : 'Zahlungslink'} geändert: ${String(inv[k] ?? '').slice(0, 80)} → ${String(patch[k] ?? '').slice(0, 80)}`, actor);

      let extra: Record<string, unknown> = {};
      if (body.status !== undefined) {
        inv = mustInvoice(app, ctx.locationId, inv.id);
        let action;
        try {
          action = actionFor(inv as any, String(body.status));
        } catch (e) {
          if (e instanceof StateError) throw new HttpError(e.status, e.message);
          throw e;
        }
        if (action === 'finalise' || action === 'finalise_and_pay') {
          const fin = await finaliseChecked(app, ctx.locationId, inv.id, { actor });
          extra = { warnings: fin.warnings };
          if (action === 'finalise_and_pay') markInvoicePaid(app, ctx.locationId, inv.id, '');
        } else if (action === 'pay') markInvoicePaid(app, ctx.locationId, inv.id, '');
        else if (action === 'storno') {
          const r = stornoInvoice(app, ctx.locationId, inv.id, { reason: str(body.reason, 'Grund', { max: 300 }), actor });
          extra = { storno: invoiceOut(app, r.storno) };
        } else if (action === 'discard') {
          db.run(`UPDATE invoices SET status = 'void', updated_at = ? WHERE id = ? AND status IN ('draft', 'sent') AND finalised_at IS NULL`, now(), inv.id);
          invAudit(app, ctx.locationId, inv.id, inv.kind === 'estimate' ? 'quote.discarded' : 'draft.discarded', '', actor);
        } else if (action === 'accept' || action === 'send') {
          db.run(`UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?`, action === 'accept' ? 'accepted' : 'sent', now(), inv.id);
          if (action === 'accept' && inv.contact_id) logActivity(app, ctx.locationId, inv.contact_id, 'estimate.accepted', `Angebot ${inv.number} angenommen`);
        }
      }
      return invoiceOut(app, mustInvoice(app, ctx.locationId, ctx.params.id), extra);
    });
    router.delete('/api/invoices/:id', 'location', (ctx) => {
      const inv = refresh(ctx.locationId, ctx.params.id);
      if (!inv) throw notFound();
      if (inv.finalised_at) throw new HttpError(409, `Festgeschriebene Rechnungen werden nicht gelöscht (Aufbewahrungspflicht) – storniere ${inv.number} stattdessen`);
      if (inv.status !== 'draft') throw new HttpError(409, 'Nur Entwürfe löschen – sonst stornieren oder verwerfen');
      db.tx(() => {
        db.run('DELETE FROM invoices WHERE id = ?', inv.id);
        invAudit(app, ctx.locationId, inv.id, 'draft.deleted', inv.title || 'ohne Titel', actorOf(ctx));
      });
      return { ok: true };
    });
    router.post('/api/invoices/:id/send', 'location', async (ctx) => {
      const inv = refresh(ctx.locationId, ctx.params.id);
      if (!inv) throw notFound();
      const b = ctx.body ?? {};
      const sent = await sendInvoice(app, ctx.locationId, inv, {
        subject: b.subject,
        body: b.body,
        channel: b.channel,
        userId: ctx.user?.id,
        actor: actorOf(ctx),
        ...(b.attach_pdf === false ? { attach_pdf: false } : {}),
        ...(b.attach_xrechnung ? { attach_xrechnung: b.attach_xrechnung === 'ubl' ? 'ubl' : b.attach_xrechnung === 'cii' ? 'cii' : true } : {}),
        ...(typeof b.attach_zugferd === 'boolean' ? { attach_zugferd: b.attach_zugferd } : {}),
      });
      return invoiceOut(app, sent);
    });

    router.get('/api/subscriptions', 'location', (ctx) =>
      parseRows(
        db.all(
          `SELECT i.id, i.number, i.title, i.total_cents, i.currency, i.recurring, i.contact_id, c.first_name, c.last_name, c.company,
             (SELECT COUNT(*) FROM invoices x WHERE x.parent_id = i.id) AS issued
           FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
           WHERE i.location_id = ? AND i.recurring IS NOT NULL ORDER BY json_extract(i.recurring, '$.next_at')`,
          ctx.locationId,
        ),
        ['recurring'],
      ).map((r: any) => ({ ...r, number: isDraftNumber(r.number) ? '' : r.number })),
    );

    app.onTick(() => runRecurringInvoices(app).then(() => undefined));

    router.get('/i/:token', 'public', (ctx) => {
      const inv = db.get('SELECT * FROM invoices WHERE public_token = ?', ctx.params.token);
      if (!inv || inv.status === 'draft') return html(messagePage('Nicht gefunden', 'Dieses Dokument gibt es nicht.'), 404);
      return html(invoiceHtml(app, parseInv(inv)));
    });
    // The same document as a file: PDF and XRechnung from the public link (the token is the secret, like the page itself).
    const hits = new Map<string, number[]>();
    const throttled = (ip: string) => {
      const t = Date.now();
      const list = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
      list.push(t);
      hits.set(ip, list);
      if (hits.size > 5000) hits.clear();
      return list.length > 40;
    };
    router.get('/i/:token/pdf', 'public', (ctx) => {
      const row = db.get('SELECT * FROM invoices WHERE public_token = ?', ctx.params.token);
      if (!row || row.status === 'draft' || throttled(ctx.ip)) throw notFound();
      const out = invoicePdfOf(app, parseInv(row));
      return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${out.filename}"`, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }, body: out.pdf };
    });
    router.get('/i/:token/xml', 'public', (ctx) => {
      const row = db.get('SELECT * FROM invoices WHERE public_token = ?', ctx.params.token);
      if (!row || row.status === 'draft' || throttled(ctx.ip)) throw notFound();
      const inv = parseInv(row);
      if (inv.kind === 'estimate') throw notFound();
      let out;
      try {
        out = einvoiceOf(app, inv, ctx.query.get('syntax') === 'ubl' ? 'ubl' : 'cii');
      } catch {
        throw notFound();
      }
      return { __raw: true, status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${out.filename}"`, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }, body: out.xml };
    });
    router.post('/api/public/invoices/:token/accept', 'public', (ctx) => {
      const inv = db.get('SELECT * FROM invoices WHERE public_token = ?', ctx.params.token);
      if (!inv || inv.kind !== 'estimate' || inv.status === 'draft') throw notFound();
      if (inv.status !== 'accepted') {
        db.run(`UPDATE invoices SET status = 'accepted', updated_at = ? WHERE id = ?`, now(), inv.id);
        if (inv.contact_id) logActivity(app, inv.location_id, inv.contact_id, 'estimate.accepted', `Angebot ${inv.number} angenommen`);
        app.events.emit(inv.location_id, 'estimate.accepted', { contactId: inv.contact_id, invoice: stripSnapshot(parseInv(db.get('SELECT * FROM invoices WHERE id = ?', inv.id))) });
        invAudit(app, inv.location_id, inv.id, 'quote.accepted', 'online angenommen');
      }
      return { ok: true };
    });
  },
};
