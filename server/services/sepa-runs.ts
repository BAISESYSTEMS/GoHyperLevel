import type { App } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { render } from '../core/template.js';
import { centsToMoney, id, now, sha256 } from '../core/util.js';
import { createInvoice } from '../modules/payments.js';
import { contactVars, getContact, logActivity } from './contacts.js';
import { invAudit, loadInvoice, recordPayment, revertPayment, type Actor } from './invoice-flow.js';
import { deYmd, openCents } from './invoice-model.js';
import { sendToContact } from './messaging.js';
import { creditorOf, endMandate, mandateUsed, settingsOf, todayOf, type MandateRow } from './sepa-mandates.js';
import { RETURN_CODES, SEQ_LABELS, addTargetDays, earliestCollection, effectiveStatus, ibanInfo, isTargetDay, isYmd, maskIban, nextSeq, nextTargetDay, normalizeBic, checkBic, statusAfter, type SeqType } from './sepa-model.js';
import { creditTransferXml, directDebitXml, sepaId, sepaText, type DebitTx } from './sepa-xml.js';

/**
 * Collection runs (pain.008) and transfer batches (pain.001) – docs/sepa.md. Open finalised invoices of contacts with a valid
 * mandate become a draft run (the pre-notification goes out), submitting writes the XML and marks the invoices "Lastschrift
 * eingereicht" in their audit trail; paid and returned collections go through the invoice flow (recordPayment / revertPayment),
 * so payment state, events, dunning and accounting see the same thing as for any other payment.
 */

const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const money = (c: number) => centsToMoney(c, 'EUR');

export interface RunRow {
  id: string;
  location_id: string;
  kind: 'debit' | 'transfer';
  status: 'draft' | 'submitted' | 'closed' | 'cancelled';
  exec_date: string;
  msg_id: string;
  tx_count: number;
  total_cents: number;
  xml: string | null;
  xml_sha256: string;
  source: string;
  note: string;
  created_by: string | null;
  created_at: string;
  submitted_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

export interface ItemRow {
  id: string;
  run_id: string;
  location_id: string;
  invoice_id: string | null;
  receipt_id: string | null;
  mandate_id: string | null;
  contact_id: string | null;
  name: string;
  iban: string;
  bic: string;
  street: string;
  postal_code: string;
  city: string;
  country: string;
  end_to_end: string;
  remittance: string;
  amount_cents: number;
  seq: string;
  scheme: string;
  mandate_ref: string;
  mandate_date: string | null;
  status: 'draft' | 'submitted' | 'paid' | 'returned' | 'dropped';
  notify_status: string;
  notified_at: string | null;
  notify_error: string;
  payment_id: string | null;
  paid_at: string | null;
  returned_at: string | null;
  return_code: string;
  return_note: string;
  fee_cents: number;
  fee_invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

export const ITEM_STATUS: Record<string, string> = { draft: 'Angekündigt', submitted: 'Eingereicht', paid: 'Bezahlt', returned: 'Zurückgegeben', dropped: 'Entfernt' };
export const RUN_STATUS: Record<string, string> = { draft: 'Entwurf', submitted: 'Eingereicht', closed: 'Abgeschlossen', cancelled: 'Verworfen' };

export function mustRun(app: App, loc: string, runId: string): RunRow {
  const r = app.db.get<RunRow>('SELECT * FROM sepa_runs WHERE id = ? AND location_id = ?', runId, loc);
  if (!r) throw notFound('Lauf nicht gefunden');
  return r;
}
export function mustItem(app: App, loc: string, itemId: string): ItemRow {
  const r = app.db.get<ItemRow>('SELECT * FROM sepa_items WHERE id = ? AND location_id = ?', itemId, loc);
  if (!r) throw notFound('Posten nicht gefunden');
  return r;
}
const itemsOf = (app: App, runId: string) => app.db.all<ItemRow>('SELECT * FROM sepa_items WHERE run_id = ? ORDER BY created_at, end_to_end', runId);

const msgIdOf = () => `GH${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}${id(6)}`;

// --- candidates ------------------------------------------------------------------------------------------------------------------

export interface Candidate {
  invoice_id: string;
  number: string;
  title: string;
  contact_id: string;
  contact_name: string;
  has_email: boolean;
  issued_at: string;
  due_at: string | null;
  open_cents: number;
  currency: string;
  mandate_id: string;
  mandate_ref: string;
  mandate_date: string;
  scheme: string;
  kind: string;
  seq: SeqType;
  seq_label: string;
  holder: string;
  iban_masked: string;
  ok: boolean;
  problems: string[];
  mandate: MandateRow;
}

/**
 * Open, finalised EUR invoices of contacts with an active mandate that are not in a run yet (a returned collection may be
 * collected again). One mandate per contact – the newest active one; a one-off mandate takes only the oldest invoice.
 */
export function candidates(app: App, loc: string): Candidate[] {
  const today = todayOf(app, loc);
  const rows = app.db.all<any>(
    `SELECT i.id, i.number, i.title, i.contact_id, i.issued_at, i.due_at, i.currency, i.kind, i.total_cents, i.paid_cents, i.credited_cents, i.deducted_cents,
            c.first_name, c.last_name, c.company, c.email
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
      WHERE i.location_id = ? AND i.kind = 'invoice' AND i.finalised_at IS NOT NULL AND i.status NOT IN ('paid', 'void', 'draft')
        AND EXISTS (SELECT 1 FROM sepa_mandates m WHERE m.location_id = i.location_id AND m.contact_id = i.contact_id AND m.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM sepa_items s WHERE s.invoice_id = i.id AND s.status IN ('draft', 'submitted', 'paid'))
      ORDER BY COALESCE(i.due_at, i.issued_at), i.issued_at LIMIT 1000`,
    loc,
  );
  if (!rows.length) return [];
  const mandates = new Map<string, MandateRow>();
  for (const m of app.db.all<MandateRow>(`SELECT * FROM sepa_mandates WHERE location_id = ? AND status = 'active' ORDER BY signed_at DESC, created_at DESC`, loc)) if (m.contact_id && !mandates.has(m.contact_id)) mandates.set(m.contact_id, m);
  const used = new Set(app.db.all<{ mandate_id: string }>(`SELECT DISTINCT mandate_id FROM sepa_items WHERE location_id = ? AND status IN ('submitted', 'paid') AND mandate_id IS NOT NULL`, loc).map((r) => r.mandate_id));
  const drafted = new Set(app.db.all<{ mandate_id: string }>(`SELECT DISTINCT mandate_id FROM sepa_items WHERE location_id = ? AND status = 'draft' AND mandate_id IS NOT NULL`, loc).map((r) => r.mandate_id));
  const oneOffTaken = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    const m = mandates.get(r.contact_id);
    const open = openCents(r);
    if (!m || open <= 0) continue;
    const problems: string[] = [];
    if (r.currency !== 'EUR') problems.push(`Lastschriften gibt es nur in Euro (Rechnung in ${r.currency})`);
    if (effectiveStatus(m, today) === 'expired') problems.push('Mandat abgelaufen (36 Monate ohne Einzug)');
    if (!m.signed_at) problems.push('Mandat ohne Datum der Unterschrift');
    if (!ibanInfo(m.iban).ok) problems.push('IBAN des Mandats ungültig');
    if (m.kind === 'OOFF') {
      if (used.has(m.id) || drafted.has(m.id) || oneOffTaken.has(m.id)) problems.push('Einmal-Mandat: nur eine Lastschrift möglich');
      else oneOffTaken.add(m.id);
    }
    const seq = nextSeq(m, used.has(m.id));
    out.push({
      invoice_id: r.id,
      number: r.number,
      title: r.title,
      contact_id: r.contact_id,
      contact_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.company || r.email || 'Kontakt',
      has_email: !!r.email,
      issued_at: r.issued_at,
      due_at: r.due_at,
      open_cents: open,
      currency: r.currency,
      mandate_id: m.id,
      mandate_ref: m.reference,
      mandate_date: m.signed_at ?? '',
      scheme: m.scheme,
      kind: m.kind,
      seq,
      seq_label: SEQ_LABELS[seq],
      holder: m.holder,
      iban_masked: maskIban(m.iban),
      ok: !problems.length,
      problems,
      mandate: m,
    });
  }
  return out;
}

export const candidateOut = ({ mandate: _m, ...c }: Candidate) => c;

// --- planning a run -----------------------------------------------------------------------------------------------------------------

export interface Plan {
  date: string;
  earliest: string;
  rows: Candidate[];
  groups: { seq: SeqType; seq_label: string; scheme: string; date: string; count: number; total_cents: number }[];
  count: number;
  total_cents: number;
  errors: string[];
  warnings: string[];
}

export function planRun(app: App, loc: string, body: { invoice_ids?: unknown; collection_date?: unknown }): Plan {
  const s = settingsOf(app, loc);
  const today = todayOf(app, loc);
  const earliest = earliestCollection(today, s.prenotify_days);
  const date = isYmd(body.collection_date) ? body.collection_date : earliest;
  const errors: string[] = [...creditorOf(app, loc, s).problems];
  const warnings: string[] = [];
  if (date < earliest) errors.push(`Fälligkeit frühestens am ${deYmd(earliest)} (${s.prenotify_days} Tage Vorabankündigung, ein Bankarbeitstag Vorlauf)`);
  if (!isTargetDay(date)) errors.push(`Der ${deYmd(date)} ist kein Bankarbeitstag (TARGET2) – nächster: ${deYmd(nextTargetDay(date))}`);
  const ids = Array.isArray(body.invoice_ids) ? [...new Set(body.invoice_ids.map(String))].slice(0, 1000) : [];
  const all = new Map(candidates(app, loc).map((c) => [c.invoice_id, c]));
  const rows: Candidate[] = [];
  for (const iid of ids) {
    const c = all.get(iid);
    if (!c) errors.push(`Rechnung ${loadInvoice(app, loc, iid)?.number || iid} ist nicht einziehbar (kein aktives Mandat, schon in einem Lauf oder nicht offen)`);
    else if (!c.ok) errors.push(`Rechnung ${c.number}: ${c.problems.join(', ')}`);
    else rows.push(c);
  }
  if (!ids.length) errors.push('Bitte mindestens eine Rechnung wählen');
  const noMail = new Set(rows.filter((r) => !r.has_email).map((r) => r.contact_name));
  if (s.prenotify_email && noMail.size) warnings.push(`Ohne E-Mail-Adresse, Vorabankündigung bitte selbst zustellen: ${[...noMail].slice(0, 5).join(', ')}${noMail.size > 5 ? ' …' : ''}`);
  const map = new Map<string, Plan['groups'][number]>();
  for (const r of rows) {
    const k = `${r.scheme}|${r.seq}`;
    const g = map.get(k) ?? { seq: r.seq, seq_label: SEQ_LABELS[r.seq], scheme: r.scheme, date, count: 0, total_cents: 0 };
    g.count++;
    g.total_cents += r.open_cents;
    map.set(k, g);
  }
  return { date, earliest, rows, groups: [...map.values()], count: rows.length, total_cents: rows.reduce((n, r) => n + r.open_cents, 0), errors, warnings };
}

/** Creates the draft run and sends the pre-notifications (one mail per mandate, listing its invoices). */
export async function createRun(app: App, loc: string, body: Record<string, any>, userId: string | null): Promise<RunRow> {
  const plan = planRun(app, loc, body);
  if (plan.errors.length) throw bad(plan.errors.join(' · '));
  const s = settingsOf(app, loc);
  const t = now();
  const run = { id: id(), location_id: loc, kind: 'debit', status: 'draft', exec_date: plan.date, msg_id: msgIdOf(), tx_count: plan.count, total_cents: plan.total_cents, source: 'invoices', note: clip(body.note, 300), created_by: userId, created_at: t, updated_at: t };
  app.db.tx(() => {
    app.db.insert('sepa_runs', run);
    for (const r of plan.rows) {
      const m = r.mandate;
      app.db.insert('sepa_items', {
        id: id(), run_id: run.id, location_id: loc, invoice_id: r.invoice_id, mandate_id: m.id, contact_id: r.contact_id,
        name: m.holder, iban: m.iban, bic: m.bic, street: m.street, postal_code: m.postal_code, city: m.city, country: m.country,
        end_to_end: sepaId(r.number), remittance: sepaText(`Rechnung ${r.number}${r.title ? ` ${r.title}` : ''}`, 140), amount_cents: r.open_cents,
        seq: r.seq, scheme: m.scheme, mandate_ref: m.reference, mandate_date: m.signed_at, status: 'draft', created_at: t, updated_at: t,
      });
    }
  });
  const notify = s.prenotify_email && body.notify !== false;
  if (!notify) app.db.run(`UPDATE sepa_items SET notify_status = 'manual', notified_at = ? WHERE run_id = ?`, t, run.id);
  else await prenotify(app, loc, run.id);
  return mustRun(app, loc, run.id);
}

async function prenotify(app: App, loc: string, runId: string) {
  const s = settingsOf(app, loc);
  const cr = creditorOf(app, loc, s);
  const run = mustRun(app, loc, runId);
  const L = app.location(loc)!;
  const byMandate = new Map<string, ItemRow[]>();
  for (const it of itemsOf(app, runId)) byMandate.set(it.mandate_id ?? it.id, [...(byMandate.get(it.mandate_id ?? it.id) ?? []), it]);
  for (const list of byMandate.values()) {
    const first = list[0];
    const c = first.contact_id ? getContact(app, loc, first.contact_id) : undefined;
    const mark = (status: string, error = '') => app.db.run(`UPDATE sepa_items SET notify_status = ?, notify_error = ?, notified_at = ?, updated_at = ? WHERE id IN (${list.map(() => '?').join(',')})`, status, error, status === 'sent' ? now() : null, now(), ...list.map((i) => i.id));
    if (!c?.email) {
      mark('failed', 'Keine E-Mail-Adresse');
      continue;
    }
    const total = list.reduce((n, i) => n + i.amount_cents, 0);
    const vars = {
      contact: contactVars(c),
      location: { name: L.name },
      due_date: deYmd(run.exec_date),
      total: money(total),
      iban: maskIban(first.iban),
      items: list.map((i) => `- ${i.remittance}: ${money(i.amount_cents)}`).join('\n'),
      mandate_reference: first.mandate_ref,
      creditor_id: cr.creditor_id,
      creditor_name: cr.name,
    };
    try {
      const msg = await sendToContact(app, loc, { contactId: c.id, channel: 'email', subject: render(s.prenotify_subject, vars), body: render(s.prenotify_body, vars), source: 'SEPA-Vorabankündigung', ignoreDnd: true, purpose: 'transactional' });
      if (msg.status === 'failed') mark('failed', clip(msg.error, 200) || 'Versand fehlgeschlagen');
      else mark('sent');
    } catch (e) {
      mark('failed', clip((e as Error).message, 200));
    }
  }
}

/** Sends the pre-notification again for the items of a draft run whose mail failed (e.g. after adding an address). */
export async function renotify(app: App, loc: string, runId: string): Promise<RunRow> {
  const run = mustRun(app, loc, runId);
  if (run.status !== 'draft' || run.kind !== 'debit') throw new HttpError(409, 'Nur bei Läufen, die noch nicht eingereicht sind');
  const s = settingsOf(app, loc);
  const lead = earliestCollection(todayOf(app, loc), s.prenotify_days);
  if (run.exec_date < lead) throw new HttpError(409, `Für eine neue Vorabankündigung ist die Fälligkeit zu nah (frühestens ${deYmd(lead)}) – bitte den Lauf verwerfen und neu anlegen`);
  await prenotify(app, loc, runId);
  return run;
}

// --- submitting -----------------------------------------------------------------------------------------------------------------------

/**
 * Writes the pain.008 file and marks everything as submitted: items, invoices (audit trail "SEPA-Lastschrift eingereicht"),
 * mandates (first/last use, FRST → RCUR, one-off → used, FNAL → ended). Items whose invoice changed since the
 * pre-notification are taken out (the announced amount has to match). Returns the run and the invoices it covers.
 */
export function submitRun(app: App, loc: string, runId: string, actor: Actor): { run: RunRow; dropped: string[]; invoices: string[] } {
  const run = mustRun(app, loc, runId);
  if (run.kind !== 'debit') throw new HttpError(409, 'Überweisungen sind schon fertig – die Datei steht zum Herunterladen bereit');
  if (run.status !== 'draft') throw new HttpError(409, 'Dieser Lauf ist schon eingereicht');
  const s = settingsOf(app, loc);
  const cr = creditorOf(app, loc, s);
  if (cr.problems.length) throw bad(cr.problems.join(' · '));
  const today = todayOf(app, loc);
  const latest = addTargetDays(today, 1);
  if (run.exec_date < latest) throw new HttpError(409, `Die Fälligkeit (${deYmd(run.exec_date)}) ist zu nah: Die Bank braucht die Datei einen Bankarbeitstag vorher. Bitte den Lauf verwerfen und mit neuer Vorabankündigung neu anlegen.`);
  const dropped: string[] = [];
  const keep: ItemRow[] = [];
  for (const it of itemsOf(app, runId).filter((i) => i.status === 'draft')) {
    const inv = it.invoice_id ? loadInvoice(app, loc, it.invoice_id) : undefined;
    const m = it.mandate_id ? app.db.get<MandateRow>('SELECT * FROM sepa_mandates WHERE id = ?', it.mandate_id) : undefined;
    const why = !inv || inv.status === 'void' ? 'Rechnung storniert' : inv.status === 'paid' || openCents(inv) <= 0 ? 'Rechnung schon bezahlt' : openCents(inv) !== it.amount_cents ? 'Offener Betrag hat sich geändert – neu ankündigen' : !m || effectiveStatus(m, today) !== 'active' ? 'Mandat nicht mehr gültig' : '';
    if (why) {
      app.db.run(`UPDATE sepa_items SET status = 'dropped', return_note = ?, updated_at = ? WHERE id = ?`, why, now(), it.id);
      dropped.push(`${inv?.number || it.end_to_end}: ${why}`);
    } else {
      // A second draft for the same mandate: once the first went out, this one is a follow-up.
      if (it.seq === 'FRST' && mandateUsed(app, it.mandate_id!)) it.seq = 'RCUR';
      keep.push(it);
    }
  }
  if (!keep.length) throw bad(`Keine Lastschrift mehr gültig${dropped.length ? `: ${dropped.join(' · ')}` : ''}`);
  const txs: DebitTx[] = keep.map((it) => ({
    endToEndId: it.end_to_end,
    amount_cents: it.amount_cents,
    mandateId: it.mandate_ref,
    mandateDate: it.mandate_date ?? today,
    seq: it.seq as SeqType,
    scheme: it.scheme === 'B2B' ? 'B2B' : 'CORE',
    collectionDate: run.exec_date,
    debtor: { name: it.name, iban: it.iban, bic: it.bic, street: it.street, postal_code: it.postal_code, city: it.city, country: it.country },
    remittance: it.remittance,
  }));
  const file = directDebitXml({ creditor: { name: cr.name, iban: cr.iban, bic: cr.bic, creditorId: cr.creditor_id }, msgId: run.msg_id, txs, batchBooking: s.batch_booking });
  const t = now();
  app.db.tx(() => {
    app.db.run(`UPDATE sepa_runs SET status = 'submitted', xml = ?, xml_sha256 = ?, tx_count = ?, total_cents = ?, submitted_at = ?, updated_at = ? WHERE id = ?`, file.xml, sha256(file.xml), file.count, file.total_cents, t, t, run.id);
    for (const it of keep) {
      app.db.run(`UPDATE sepa_items SET status = 'submitted', seq = ?, updated_at = ? WHERE id = ?`, it.seq, t, it.id);
      const m = app.db.get<MandateRow>('SELECT * FROM sepa_mandates WHERE id = ?', it.mandate_id)!;
      const next = statusAfter(it.seq as SeqType, m.status);
      app.db.run(
        `UPDATE sepa_mandates SET first_used_at = COALESCE(first_used_at, ?), last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < ? THEN ? ELSE last_used_at END, status = ?, final_next = CASE WHEN ? = 'FNAL' THEN 0 ELSE final_next END, updated_at = ? WHERE id = ?`,
        run.exec_date, run.exec_date, run.exec_date, next, it.seq, t, m.id,
      );
      invAudit(app, loc, it.invoice_id, 'sepa.submitted', `SEPA-Lastschrift eingereicht · ${money(it.amount_cents)} · fällig ${deYmd(run.exec_date)} · ${SEQ_LABELS[it.seq as SeqType] ?? it.seq} · Mandat ${it.mandate_ref}`, actor);
    }
  });
  for (const it of keep) if (it.contact_id) logActivity(app, loc, it.contact_id, 'sepa.submitted', `SEPA-Lastschrift über ${money(it.amount_cents)} eingereicht (${it.remittance}, fällig ${deYmd(run.exec_date)})`);
  return { run: mustRun(app, loc, run.id), dropped, invoices: keep.map((i) => i.invoice_id!).filter(Boolean) };
}

/** Closes a run once nothing in it is open any more. */
function maybeClose(app: App, runId: string) {
  const open = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sepa_items WHERE run_id = ? AND status IN ('draft', 'submitted')`, runId)!.n;
  if (!open) app.db.run(`UPDATE sepa_runs SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`, now(), now(), runId);
}

/**
 * Throws a run away: a draft (nothing went to the bank), or a submitted one the bank rejected as a whole – as long as no
 * collection in it is marked paid or returned. Mandates get their sequence state back.
 */
export function cancelRun(app: App, loc: string, runId: string, actor: Actor, reason = ''): { run: RunRow; invoices: string[] } {
  const run = mustRun(app, loc, runId);
  if (run.status === 'cancelled' || run.status === 'closed') throw new HttpError(409, 'Dieser Lauf ist schon abgeschlossen');
  const items = itemsOf(app, runId);
  if (items.some((i) => i.status === 'paid' || i.status === 'returned')) throw new HttpError(409, 'Im Lauf sind schon bezahlte oder zurückgegebene Lastschriften – einzelne Posten bitte als zurückgegeben markieren');
  const submitted = items.filter((i) => i.status === 'submitted');
  const t = now();
  app.db.tx(() => {
    app.db.run(`UPDATE sepa_items SET status = 'dropped', return_note = ?, updated_at = ? WHERE run_id = ? AND status IN ('draft', 'submitted')`, clip(reason, 200) || 'Lauf verworfen', t, runId);
    app.db.run(`UPDATE sepa_runs SET status = 'cancelled', closed_at = ?, note = CASE WHEN ? != '' THEN ? ELSE note END, updated_at = ? WHERE id = ?`, t, clip(reason, 300), clip(reason, 300), t, runId);
    for (const mid of new Set(submitted.map((i) => i.mandate_id).filter(Boolean) as string[])) restoreMandate(app, mid, submitted.filter((i) => i.mandate_id === mid));
    if (run.kind === 'debit') for (const it of submitted) invAudit(app, loc, it.invoice_id, 'sepa.withdrawn', `SEPA-Lastschrift zurückgezogen${reason ? ` · ${clip(reason, 120)}` : ''}`, actor);
  });
  return { run: mustRun(app, loc, runId), invoices: submitted.map((i) => i.invoice_id!).filter(Boolean) };
}

/** First/last use from what is left, and a one-off or final mandate that this run had closed becomes active again. */
function restoreMandate(app: App, mandateId: string, removed: ItemRow[]) {
  const m = app.db.get<MandateRow>('SELECT * FROM sepa_mandates WHERE id = ?', mandateId);
  if (!m) return;
  const span = app.db.get<{ a: string | null; b: string | null }>(`SELECT MIN(r.exec_date) AS a, MAX(r.exec_date) AS b FROM sepa_items s JOIN sepa_runs r ON r.id = s.run_id WHERE s.mandate_id = ? AND s.status IN ('submitted', 'paid', 'returned')`, mandateId);
  const closedHere = (m.status === 'used' && removed.some((i) => i.seq === 'OOFF')) || (m.status === 'final' && removed.some((i) => i.seq === 'FNAL'));
  app.db.run(
    `UPDATE sepa_mandates SET first_used_at = ?, last_used_at = ?, status = ?, final_next = ?, updated_at = ? WHERE id = ?`,
    span?.a ?? null, span?.b ?? null, closedHere ? 'active' : m.status, m.status === 'final' && closedHere ? 1 : m.final_next, now(), mandateId,
  );
}

// --- paid / returned --------------------------------------------------------------------------------------------------------------------

/** The bank booked the collection (or the transfer went out): the invoice gets the payment through the invoice flow. */
export function markPaid(app: App, loc: string, itemId: string, body: { paid_at?: unknown }, actor: Actor): ItemRow {
  const it = mustItem(app, loc, itemId);
  if (it.status !== 'submitted') throw new HttpError(409, it.status === 'paid' ? 'Schon als bezahlt markiert' : 'Nur eingereichte Posten lassen sich als bezahlt markieren');
  const paidAt = body.paid_at ? new Date(String(body.paid_at)) : new Date();
  if (Number.isNaN(paidAt.getTime())) throw bad('Ungültiges Datum');
  let paymentId: string | null = null;
  if (it.invoice_id) {
    const inv = loadInvoice(app, loc, it.invoice_id);
    const open = inv ? openCents(inv) : 0;
    if (inv && inv.status !== 'paid' && inv.status !== 'void' && open > 0) {
      const r = recordPayment(app, loc, inv.id, { amount_cents: Math.min(open, it.amount_cents), paid_at: paidAt.toISOString(), method: 'SEPA-Lastschrift', note: `Mandat ${it.mandate_ref}` }, actor, { source: 'sepa', via: 'SEPA-Lastschrift' });
      paymentId = r.payment_id;
    }
  }
  app.db.run(`UPDATE sepa_items SET status = 'paid', payment_id = ?, paid_at = ?, updated_at = ? WHERE id = ?`, paymentId, paidAt.toISOString(), now(), it.id);
  maybeClose(app, it.run_id);
  return mustItem(app, loc, it.id);
}

/** Every submitted item of a run is paid (the bank statement showed the whole block). */
export function markRunPaid(app: App, loc: string, runId: string, body: { paid_at?: unknown }, actor: Actor): { paid: number; failed: string[] } {
  mustRun(app, loc, runId);
  const failed: string[] = [];
  let paid = 0;
  for (const it of itemsOf(app, runId).filter((i) => i.status === 'submitted')) {
    try {
      markPaid(app, loc, it.id, body, actor);
      paid++;
    } catch (e) {
      failed.push(`${it.end_to_end}: ${(e as Error).message}`);
    }
  }
  return { paid, failed };
}

export interface ReturnInput {
  code?: unknown;
  note?: unknown;
  fee_cents?: unknown;
  fee_invoice?: unknown;
  returned_at?: unknown;
}

/**
 * A return (Rücklastschrift): the payment is taken back through the invoice flow (the invoice is open again), the reason code is
 * kept, the mandate is blocked or ended for codes that make it unusable, and an optional return fee becomes a draft invoice.
 */
export function markReturned(app: App, loc: string, itemId: string, body: ReturnInput, actor: Actor): { item: ItemRow; fee_invoice_id: string | null } {
  const it = mustItem(app, loc, itemId);
  if (!it.invoice_id || !it.mandate_id) throw new HttpError(409, 'Nur Lastschriften können zurückgegeben werden');
  if (it.status !== 'submitted' && it.status !== 'paid') throw new HttpError(409, it.status === 'returned' ? 'Schon als zurückgegeben markiert' : 'Nur eingereichte oder bezahlte Lastschriften können zurückgegeben werden');
  const code = String(body.code ?? '').trim().toUpperCase();
  const def = RETURN_CODES[code];
  if (!def) throw bad('Bitte einen Rückgabegrund (Code) wählen');
  const fee = body.fee_cents === undefined || body.fee_cents === '' || body.fee_cents === null ? 0 : Math.round(Number(body.fee_cents));
  if (!Number.isFinite(fee) || fee < 0 || fee > 10_000) throw bad('Gebühr: 0 bis 100 €');
  const at = body.returned_at ? new Date(String(body.returned_at)) : new Date();
  if (Number.isNaN(at.getTime())) throw bad('Ungültiges Datum');
  const reason = `Rücklastschrift ${code}: ${def.label}`;
  const inv = loadInvoice(app, loc, it.invoice_id);
  // Paid through the bank match (no payment of our own): the newest payment of exactly this amount is the collection.
  const paymentId =
    it.payment_id ??
    (it.status === 'paid' && inv
      ? (app.db.get<{ id: string }>(`SELECT p.id FROM invoice_payments p WHERE p.invoice_id = ? AND p.location_id = ? AND p.kind = 'payment' AND p.amount_cents = ? AND NOT EXISTS (SELECT 1 FROM invoice_payments r WHERE r.reverses_id = p.id) ORDER BY p.created_at DESC LIMIT 1`, inv.id, loc, it.amount_cents)?.id ?? null)
      : null);
  if (paymentId && inv) {
    try {
      revertPayment(app, loc, inv.id, paymentId, actor, reason);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e;
    }
  }
  app.db.run(`UPDATE sepa_items SET status = 'returned', returned_at = ?, return_code = ?, return_note = ?, fee_cents = ?, updated_at = ? WHERE id = ?`, at.toISOString(), code, clip(body.note, 300), fee, now(), it.id);
  invAudit(app, loc, it.invoice_id, 'sepa.returned', `${reason}${fee ? ` · Gebühr ${money(fee)}` : ''}`, actor);
  if (def.mandate) endMandate(app, loc, it.mandate_id, def.mandate === 'revoke' ? 'revoked' : 'suspended', reason);
  let feeInvoice: string | null = null;
  if (fee > 0 && body.fee_invoice && it.contact_id) {
    const draft = createInvoice(app, loc, {
      contact_id: it.contact_id,
      title: 'Rücklastschrift',
      tax_mode: 'tax_free',
      tax_note: 'Nicht steuerbarer Schadensersatz (Erstattung der Bankgebühren für die zurückgegebene Lastschrift).',
      items: [{ name: `Rücklastschriftgebühr zu Rechnung ${inv?.number ?? it.end_to_end}`, description: `${code} – ${def.label}`, qty: 1, price_cents: fee, tax_rate: 0 }],
    });
    feeInvoice = draft.id;
    app.db.run('UPDATE sepa_items SET fee_invoice_id = ? WHERE id = ?', feeInvoice, it.id);
  }
  if (it.contact_id) logActivity(app, loc, it.contact_id, 'sepa.returned', `${reason} – Rechnung ${inv?.number ?? it.end_to_end} ist wieder offen`);
  app.events.emit(loc, 'sepa.returned', { contactId: it.contact_id, invoice: inv ? { id: inv.id, number: inv.number, total_cents: inv.total_cents } : null, code, label: def.label, amount_cents: it.amount_cents, fee_cents: fee, mandate_ref: it.mandate_ref });
  maybeClose(app, it.run_id);
  return { item: mustItem(app, loc, it.id), fee_invoice_id: feeInvoice };
}

/** An invoice paid some other way (bank match, by hand) settles its submitted collection, so the run can close. */
export function settleByInvoice(app: App, loc: string, invoiceId: string) {
  const items = app.db.all<ItemRow>(`SELECT * FROM sepa_items WHERE location_id = ? AND invoice_id = ? AND status = 'submitted'`, loc, invoiceId);
  for (const it of items) {
    app.db.run(`UPDATE sepa_items SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status = 'submitted'`, now(), now(), it.id);
    maybeClose(app, it.run_id);
  }
}

// --- transfers (pain.001) -------------------------------------------------------------------------------------------------------------

export interface Payable {
  receipt_id: string;
  supplier: string;
  invoice_no: string;
  invoice_date: string | null;
  due_date: string | null;
  amount_cents: number;
  iban_masked: string;
  ok: boolean;
  problems: string[];
}

const hasTable = (app: App, name: string) => !!app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/** Booked, unpaid supplier invoices (Belegeingang of the accounting) not yet in a transfer – the payables a batch can pay. */
export function payables(app: App, loc: string): { available: boolean; items: Payable[] } {
  if (!hasTable(app, 'acc_receipts')) return { available: false, items: [] };
  const rows = app.db.all<any>(
    `SELECT r.id, r.supplier, r.invoice_no, r.invoice_date, r.due_date, r.gross_cents, r.net_cents, r.reverse_charge, r.iban, r.currency FROM acc_receipts r
      WHERE r.location_id = ? AND r.status = 'booked' AND r.payment = 'open' AND r.payment_entry_id IS NULL AND r.credit_note = 0
        AND NOT EXISTS (SELECT 1 FROM sepa_items s WHERE s.receipt_id = r.id AND s.status IN ('submitted', 'paid'))
      ORDER BY COALESCE(r.due_date, r.invoice_date), r.created_at LIMIT 500`,
    loc,
  );
  return {
    available: true,
    items: rows.map((r) => {
      const amount = (r.reverse_charge ? r.net_cents : r.gross_cents) ?? 0;
      const problems: string[] = [];
      if (!ibanInfo(r.iban).ok) problems.push(r.iban ? 'IBAN des Lieferanten ungültig' : 'IBAN des Lieferanten fehlt (im Beleg eintragen)');
      if (r.currency !== 'EUR') problems.push(`Beleg in ${r.currency}`);
      if (amount <= 0) problems.push('Betrag fehlt');
      return { receipt_id: r.id, supplier: r.supplier, invoice_no: r.invoice_no, invoice_date: r.invoice_date, due_date: r.due_date, amount_cents: amount, iban_masked: maskIban(r.iban), ok: !problems.length, problems };
    }),
  };
}

interface TransferLineIn {
  name?: unknown;
  iban?: unknown;
  bic?: unknown;
  amount_cents?: unknown;
  reference?: unknown;
}

/** A transfer batch from the own account: selected payables and/or a manual payout list. The XML is ready at once. */
export function createTransfer(app: App, loc: string, body: { execution_date?: unknown; receipt_ids?: unknown; lines?: unknown; note?: unknown }, userId: string | null): RunRow {
  const today = todayOf(app, loc);
  const date = isYmd(body.execution_date) ? body.execution_date : today;
  if (date < today) throw bad('Das Ausführungsdatum liegt in der Vergangenheit');
  const cr = creditorOf(app, loc);
  const own = ibanInfo(cr.iban);
  if (!own.ok) throw bad(cr.iban ? `Eigenes Konto: ${own.reason}` : 'Eigene IBAN fehlt (SEPA → Einstellungen oder Rechnungs-Einstellungen)');
  const rows: Omit<ItemRow, 'id' | 'run_id' | 'location_id' | 'created_at' | 'updated_at' | 'status' | 'notify_status' | 'notified_at' | 'notify_error' | 'payment_id' | 'paid_at' | 'returned_at' | 'return_code' | 'return_note' | 'fee_cents' | 'fee_invoice_id'>[] = [];
  const base = { invoice_id: null, mandate_id: null, contact_id: null, street: '', postal_code: '', city: '', country: '', seq: '', scheme: '', mandate_ref: '', mandate_date: null };
  const ids = Array.isArray(body.receipt_ids) ? [...new Set(body.receipt_ids.map(String))] : [];
  if (ids.length) {
    const open = new Map(payables(app, loc).items.map((p) => [p.receipt_id, p]));
    for (const rid of ids) {
      const p = open.get(rid);
      if (!p) throw bad('Ein gewählter Beleg ist nicht (mehr) offen');
      if (!p.ok) throw bad(`${p.supplier} ${p.invoice_no}: ${p.problems.join(', ')}`);
      const r = app.db.get<any>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', rid, loc);
      rows.push({ ...base, receipt_id: rid, name: clip(r.supplier, 70) || 'Lieferant', iban: ibanInfo(r.iban).iban, bic: '', end_to_end: sepaId(r.invoice_no || `BELEG-${rid.slice(0, 8)}`), remittance: sepaText(`Rechnung ${r.invoice_no}`.trim(), 140), amount_cents: p.amount_cents });
    }
  }
  const lines = Array.isArray(body.lines) ? (body.lines as TransferLineIn[]) : [];
  lines.forEach((l, n) => {
    const at = `Zeile ${n + 1}`;
    const name = clip(l?.name, 70);
    if (!name) throw bad(`${at}: Name des Empfängers fehlt`);
    const i = ibanInfo(l?.iban);
    if (!i.ok) throw bad(`${at}: ${i.reason}`);
    const bic = normalizeBic(l?.bic);
    if (bic && !checkBic(bic)) throw bad(`${at}: BIC ungültig`);
    if (i.bicRequired && !bic) throw bad(`${at}: Für Konten aus ${i.country} ist die BIC Pflicht`);
    const amount = Math.round(Number(l?.amount_cents));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 99_999_999_999) throw bad(`${at}: Betrag muss größer als 0 sein`);
    const ref = clip(l?.reference, 140);
    rows.push({ ...base, receipt_id: null, name, iban: i.iban, bic, end_to_end: sepaId(ref || `ZAHLUNG-${n + 1}`), remittance: sepaText(ref, 140), amount_cents: amount });
  });
  if (!rows.length) throw bad('Bitte mindestens einen Beleg oder eine Zeile angeben');
  if (rows.length > 1000) throw bad('Höchstens 1000 Überweisungen je Datei');
  const msgId = msgIdOf();
  const xml = creditTransferXml({ debtor: { name: cr.name, iban: own.iban, bic: cr.bic }, msgId, executionDate: date, lines: rows.map((r) => ({ endToEndId: r.end_to_end, name: r.name, iban: r.iban, bic: r.bic, amount_cents: r.amount_cents, remittance: r.remittance })) });
  const t = now();
  const run = { id: id(), location_id: loc, kind: 'transfer', status: 'submitted', exec_date: date, msg_id: msgId, tx_count: rows.length, total_cents: rows.reduce((n, r) => n + r.amount_cents, 0), xml, xml_sha256: sha256(xml), source: ids.length && lines.length ? 'mixed' : ids.length ? 'receipts' : 'manual', note: clip(body.note, 300), created_by: userId, created_at: t, submitted_at: t, updated_at: t };
  app.db.tx(() => {
    app.db.insert('sepa_runs', run);
    for (const r of rows) app.db.insert('sepa_items', { id: id(), run_id: run.id, location_id: loc, ...r, status: 'submitted', created_at: t, updated_at: t });
  });
  return mustRun(app, loc, run.id);
}

// --- output -------------------------------------------------------------------------------------------------------------------------------

export function runOut(app: App, run: RunRow, withItems = false) {
  const { xml: _x, ...rest } = run;
  const base = { ...rest, status_label: RUN_STATUS[run.status] ?? run.status, kind_label: run.kind === 'debit' ? 'Lastschrift' : 'Überweisung', has_xml: !!run.xml };
  if (!withItems) return base;
  const items = itemsOf(app, run.id);
  // invoice numbers in one query per 500 items (never one per row)
  const numbers = new Map<string, string>();
  const ids = [...new Set(items.map((i) => i.invoice_id).filter(Boolean) as string[])];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const r of app.db.all<{ id: string; number: string }>(`SELECT id, number FROM invoices WHERE location_id = ? AND id IN (${part.map(() => '?').join(',')})`, run.location_id, ...part)) numbers.set(r.id, r.number);
  }
  return {
    ...base,
    counts: Object.fromEntries(Object.keys(ITEM_STATUS).map((k) => [k, items.filter((i) => i.status === k).length])),
    items: items.map((it) => ({
      id: it.id,
      invoice_id: it.invoice_id,
      invoice_number: it.invoice_id ? numbers.get(it.invoice_id) ?? '' : '',
      receipt_id: it.receipt_id,
      mandate_id: it.mandate_id,
      contact_id: it.contact_id,
      name: it.name,
      iban_masked: maskIban(it.iban),
      end_to_end: it.end_to_end,
      remittance: it.remittance,
      amount_cents: it.amount_cents,
      seq: it.seq,
      seq_label: SEQ_LABELS[it.seq as SeqType] ?? '',
      scheme: it.scheme,
      mandate_ref: it.mandate_ref,
      status: it.status,
      status_label: ITEM_STATUS[it.status] ?? it.status,
      notify_status: it.notify_status,
      notified_at: it.notified_at,
      notify_error: it.notify_error,
      paid_at: it.paid_at,
      returned_at: it.returned_at,
      return_code: it.return_code,
      return_label: RETURN_CODES[it.return_code]?.label ?? '',
      return_note: it.return_note,
      fee_cents: it.fee_cents,
      fee_invoice_id: it.fee_invoice_id,
    })),
  };
}
