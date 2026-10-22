import type { Module } from '../core/app.js';
import { bad, clampLimit, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { dedupeKey, matchTxn, parseBankFile, type Candidate, type Match } from '../services/acc-bank.js';
import { decodeCp1252 } from '../services/acc-datev.js';
import { ensureIssued, invoiceBalance, postInvoicePayment } from '../services/acc-autopost.js';
import { bookingDate, chartMap, entryBySourceKey, postEntry, requireEnabled, trail } from '../services/acc-ledger.js';
import { isTaxCode } from '../services/acc-vat.js';
import { actor } from './accounting.js';
import { markInvoicePaid } from './payments.js';
import { recordPayment } from '../services/invoice-flow.js';

/**
 * Bank statements: CSV (German banks) and CAMT.053 files are imported, every line is matched with open invoices (money in)
 * or receipts (money out) – proposals a person confirms – or booked by hand. No FinTS/HBCI, no bank access: files only.
 */

/** Bank files are UTF-8 or (most German banks) Windows-1252. */
export const decodeBytes = (b: Buffer): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return decodeCp1252(b);
  }
};

interface TxnRow {
  id: string;
  location_id: string;
  import_id: string | null;
  booking_date: string;
  value_date: string;
  amount_cents: number;
  currency: string;
  counterparty: string;
  counterparty_iban: string;
  purpose: string;
  end_to_end_id: string;
  bank_ref: string;
  account_iban: string;
  dedupe_key: string;
  status: string;
  match: string;
  entry_id: string | null;
  created_at: string;
}

const txnOut = (r: TxnRow) => {
  let match: Match | null = null;
  try {
    const m = JSON.parse(r.match);
    match = m && m.id ? m : null;
  } catch {
    match = null;
  }
  const { dedupe_key: _d, ...rest } = r;
  return { ...rest, match };
};

export const bankModule: Module = {
  name: 'accounting-bank',
  register(app) {
    const { db, router } = app;

    /** Open invoices and open booked receipts a bank line could pay. */
    const candidates = (loc: string): Candidate[] => {
      // the open amount: what is left after partial payments, credit notes and deducted partial invoices
      const invoices = db.all<{ id: string; number: string; total_cents: number; company: string | null; first_name: string | null; last_name: string | null }>(
        `SELECT i.id, i.number, i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents AS total_cents, c.company, c.first_name, c.last_name FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
         WHERE i.location_id = ? AND i.kind = 'invoice' AND i.status = 'sent' AND i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents > 0 LIMIT 2000`,
        loc,
      );
      const receipts = db.all<{ id: string; invoice_no: string; supplier: string; gross_cents: number | null; net_cents: number | null; reverse_charge: number }>(
        `SELECT id, invoice_no, supplier, gross_cents, net_cents, reverse_charge FROM acc_receipts WHERE location_id = ? AND status = 'booked' AND payment = 'open' AND payment_entry_id IS NULL LIMIT 2000`,
        loc,
      );
      return [
        ...invoices.map<Candidate>((i) => ({ kind: 'invoice', id: i.id, ref: i.number, party: i.company || [i.first_name, i.last_name].filter(Boolean).join(' '), amount_cents: i.total_cents })),
        ...receipts.filter((r) => r.invoice_no).map<Candidate>((r) => ({ kind: 'receipt', id: r.id, ref: r.invoice_no, party: r.supplier, amount_cents: (r.reverse_charge ? r.net_cents : r.gross_cents) ?? 0 })),
      ];
    };

    const setMatch = (txnId: string, m: Match | null) => db.run(`UPDATE acc_bank_txns SET status = ?, match = ? WHERE id = ? AND status IN ('open', 'matched')`, m ? 'matched' : 'open', JSON.stringify(m ?? {}), txnId);

    function rematch(loc: string, ids?: string[]) {
      const cands = candidates(loc);
      const rows = db.all<TxnRow>(`SELECT * FROM acc_bank_txns WHERE location_id = ? AND status IN ('open', 'matched') ${ids?.length ? `AND id IN (${ids.map(() => '?').join(',')})` : ''}`, loc, ...(ids ?? []));
      // One document is proposed for one line only: the best score keeps it.
      const taken = new Map<string, { txn: string; score: number }>();
      const results = rows.map((r) => ({ r, m: matchTxn(r, cands) }));
      for (const { r, m } of results.sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))) {
        if (!m) continue;
        const k = `${m.kind}:${m.id}`;
        if (taken.has(k)) (m.score = 0);
        else taken.set(k, { txn: r.id, score: m.score });
      }
      let matched = 0;
      for (const { r, m } of results) {
        const ok = m && m.score >= 50 ? m : null;
        setMatch(r.id, ok);
        if (ok) matched++;
      }
      return matched;
    }

    // --- import -----------------------------------------------------------------------------------------------------
    router.post('/api/accounting/bank/import', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const b = ctx.body ?? {};
      let text = '';
      if (typeof b.data === 'string') {
        const m = b.data.match(/^data:[\w/+.-]*;base64,(.+)$/s);
        if (!m) throw bad('Erwarte eine data:-URL (Base64)');
        const bytes = Buffer.from(m[1], 'base64');
        if (bytes.length > 8 * 1024 * 1024) throw bad('Datei größer als 8 MB');
        text = decodeBytes(bytes);
      } else if (typeof b.content === 'string') text = b.content;
      else throw bad('Dateiinhalt fehlt (data oder content)');
      if (text.length > 10 * 1024 * 1024) throw bad('Datei zu groß');
      const parsed = parseBankFile(text);
      if (!parsed.txns.length) throw bad(parsed.errors[0] ?? 'Keine Umsätze erkannt');
      if (parsed.txns.length > 20000) throw bad('Höchstens 20 000 Umsätze je Datei');
      const importId = id();
      const a = actor(ctx);
      let added = 0;
      const seen = new Map<string, number>();
      const newIds: string[] = [];
      db.tx(() => {
        db.insert('acc_bank_imports', { id: importId, location_id: ctx.locationId, name: str(b.name, 'Dateiname', { max: 200 }), format: parsed.format, txns: parsed.txns.length, new_txns: 0, created_by: a.id, created_at: now() });
        for (const t of parsed.txns) {
          // Identical lines inside one file are real (two equal payments): they are numbered, a re-import adds nothing.
          const base = dedupeKey(t, 0);
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          const key = n === 0 ? base : dedupeKey(t, n);
          const row = { id: id(), location_id: ctx.locationId, import_id: importId, ...t, dedupe_key: key, status: 'open', match: '{}', created_at: now() };
          const r = db.run(
            `INSERT OR IGNORE INTO acc_bank_txns (id, location_id, import_id, booking_date, value_date, amount_cents, currency, counterparty, counterparty_iban, purpose, end_to_end_id, bank_ref, account_iban, dedupe_key, status, match, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            row.id, row.location_id, row.import_id, row.booking_date, row.value_date, row.amount_cents, row.currency, row.counterparty, row.counterparty_iban, row.purpose, row.end_to_end_id, row.bank_ref, row.account_iban, row.dedupe_key, row.status, row.match, row.created_at,
          );
          if (r.changes) (added++, newIds.push(row.id));
        }
        db.run('UPDATE acc_bank_imports SET new_txns = ? WHERE id = ?', added, importId);
        trail(app, ctx.locationId, a, 'bank.import', null, `${parsed.format.toUpperCase()}: ${added} neue von ${parsed.txns.length} Umsätzen`);
      });
      const matched = added ? rematch(ctx.locationId) : 0;
      return { import_id: importId, format: parsed.format, total: parsed.txns.length, added, duplicates: parsed.txns.length - added, skipped: parsed.skipped, matched, errors: parsed.errors };
    });

    router.get('/api/accounting/bank/txns', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      const status = ctx.query.get('status');
      if (status === 'todo') where.push(`status IN ('open', 'matched')`);
      else if (status) (where.push('status = ?'), params.push(status));
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push('(counterparty LIKE ? OR purpose LIKE ?)'), params.push(`%${q}%`, `%${q}%`));
      const rows = db.all<TxnRow>(`SELECT * FROM acc_bank_txns WHERE ${where.join(' AND ')} ORDER BY booking_date DESC, rowid DESC LIMIT ?`, ...params, clampLimit(ctx.query.get('limit'), 300, 1000));
      const sums = db.get<{ n: number; todo: number }>(`SELECT COUNT(*) AS n, SUM(status IN ('open','matched')) AS todo FROM acc_bank_txns WHERE location_id = ?`, ctx.locationId);
      return { total: sums?.n ?? 0, todo: sums?.todo ?? 0, txns: rows.map(txnOut) };
    });
    router.get('/api/accounting/bank/imports', 'location', (ctx) => db.all('SELECT * FROM acc_bank_imports WHERE location_id = ? ORDER BY created_at DESC LIMIT 50', ctx.locationId));
    router.post('/api/accounting/bank/rematch', 'location', (ctx) => ({ matched: rematch(ctx.locationId) }));

    const getTxn = (loc: string, txnId: string) => {
      const t = db.get<TxnRow>('SELECT * FROM acc_bank_txns WHERE id = ? AND location_id = ?', txnId, loc);
      if (!t) throw notFound('Umsatz nicht gefunden');
      return t;
    };

    // --- confirm a match ---------------------------------------------------------------------------------------------------
    router.post('/api/accounting/bank/txns/:id/confirm', 'location', (ctx) => {
      const settings = requireEnabled(app, ctx.locationId);
      const t = getTxn(ctx.locationId, ctx.params.id);
      if (!['open', 'matched'].includes(t.status)) throw bad('Dieser Umsatz ist schon erledigt');
      let m: { kind: string; id: string } | null = null;
      if (ctx.body?.kind && ctx.body?.id) m = { kind: String(ctx.body.kind), id: String(ctx.body.id) };
      else {
        try {
          const j = JSON.parse(t.match);
          if (j?.id) m = j;
        } catch {
          /* no stored match */
        }
      }
      if (!m) throw bad('Für diesen Umsatz gibt es keinen Vorschlag – bitte einen Beleg wählen oder von Hand buchen');
      const a = actor(ctx);
      const amount = Math.abs(t.amount_cents);
      const date = t.booking_date;
      if (m.kind === 'invoice') {
        if (t.amount_cents <= 0) throw bad('Eine Rechnung wird durch einen Zahlungseingang beglichen');
        const inv = db.get<any>('SELECT * FROM invoices WHERE id = ? AND location_id = ? AND kind = ?', m.id, ctx.locationId, 'invoice');
        if (!inv) throw notFound('Rechnung nicht gefunden');
        if (inv.status === 'void' || inv.status === 'draft') throw bad('Diese Rechnung ist ein Entwurf oder storniert');
        ensureIssued(app, ctx.locationId, inv, settings);
        const balance = invoiceBalance(app, ctx.locationId, inv.number, settings.mapping.receivable);
        // Already booked as paid (mark as paid by hand): the bank line is only linked to that payment.
        const existing = balance <= 0 ? entryBySourceKey(app, ctx.locationId, `invoice:${inv.id}:payment`) : undefined;
        if (balance > 0 && amount > balance) throw bad('Der Betrag ist höher als der offene Rechnungsbetrag – bitte von Hand buchen');
        const entry = existing ?? postInvoicePayment(app, ctx.locationId, inv, { date, amount_cents: amount, via: 'bank', key: `bank:${t.id}`, actor: a.name });
        db.run(`UPDATE acc_bank_txns SET status = 'booked', entry_id = ?, match = ? WHERE id = ?`, entry?.id ?? null, JSON.stringify({ kind: 'invoice', id: inv.id, ref: inv.number }), t.id);
        // Paid in full: the invoice is marked paid (fires invoice.paid for workflows); the ledger already shows the payment.
        // …on the day of the bank booking, not on the day somebody confirmed the line
        if (invoiceBalance(app, ctx.locationId, inv.number, settings.mapping.receivable) <= 0) markInvoicePaid(app, ctx.locationId, inv.id, 'Bank', date);
        else {
          // a part payment: the invoice shows it too (and stays open for the rest)
          try {
            recordPayment(app, ctx.locationId, inv.id, { amount_cents: amount, paid_at: date, method: 'Bank' }, { id: null, name: a.name }, { source: 'bank', via: 'Bank' });
          } catch (e) {
            console.error('[accounting] Teilzahlung', (e as Error).message);
          }
        }
        trail(app, ctx.locationId, a, 'bank.confirm', entry?.id ?? null, `Rechnung ${inv.number}`);
        return { ok: true, entry_id: entry?.id ?? null };
      }
      if (m.kind === 'receipt') {
        if (t.amount_cents >= 0) throw bad('Ein Beleg wird durch eine Zahlung (Ausgang) beglichen');
        const r = db.get<any>(`SELECT * FROM acc_receipts WHERE id = ? AND location_id = ? AND status = 'booked'`, m.id, ctx.locationId);
        if (!r) throw notFound('Beleg nicht gefunden');
        if (r.payment_entry_id) throw bad('Dieser Beleg ist schon bezahlt');
        const due = (r.reverse_charge ? r.net_cents : r.gross_cents) ?? 0;
        if (amount > due) throw bad('Der Betrag ist höher als der Beleg – bitte von Hand buchen');
        const credit = !!r.credit_note;
        const payable = settings.mapping.payable;
        const { entry } = postEntry(app, ctx.locationId, {
          date: bookingDate(app, ctx.locationId, date),
          doc_date: date,
          text: `Zahlung ${r.supplier}${r.invoice_no ? `: ${r.invoice_no}` : ''}`,
          doc_ref: r.invoice_no,
          source: 'payment',
          source_id: r.id,
          source_key: `bank:${t.id}`,
          postings: [credit ? { debit: settings.mapping.bank, credit: payable, amount_cents: amount, tax_code: 'none' } : { debit: payable, credit: settings.mapping.bank, amount_cents: amount, tax_code: 'none' }],
          party_name: r.supplier,
          contact_id: r.contact_id,
          user_id: a.id,
          actor: a.name,
        });
        db.run('UPDATE acc_receipts SET payment_entry_id = ?, bank_txn_id = ?, updated_at = ? WHERE id = ?', entry.id, t.id, now(), r.id);
        db.run(`UPDATE acc_bank_txns SET status = 'booked', entry_id = ?, match = ? WHERE id = ?`, entry.id, JSON.stringify({ kind: 'receipt', id: r.id, ref: r.invoice_no }), t.id);
        return { ok: true, entry_id: entry.id };
      }
      throw bad('Unbekannte Art des Vorschlags');
    });

    // --- book by hand, ignore, reset -----------------------------------------------------------------------------------------
    router.post('/api/accounting/bank/txns/:id/book', 'location', (ctx) => {
      const settings = requireEnabled(app, ctx.locationId);
      const t = getTxn(ctx.locationId, ctx.params.id);
      if (!['open', 'matched'].includes(t.status)) throw bad('Dieser Umsatz ist schon erledigt');
      const b = ctx.body ?? {};
      const chart = chartMap(app, ctx.locationId);
      const account = String(b.account ?? '').trim();
      if (!chart.get(account)?.active) throw bad('Bitte ein Konto wählen');
      const code = b.tax_code && b.tax_code !== 'none' ? String(b.tax_code) : 'none';
      if (!isTaxCode(code)) throw bad('Unbekannter Steuerschlüssel');
      const amount = Math.abs(t.amount_cents);
      const bank = settings.mapping.bank;
      const a = actor(ctx);
      const text = str(b.text, 'Buchungstext', { max: 200 }) || `${t.counterparty || 'Bankumsatz'}: ${t.purpose}`.slice(0, 200);
      const { entry } = postEntry(app, ctx.locationId, {
        date: bookingDate(app, ctx.locationId, t.booking_date),
        doc_date: t.booking_date,
        text,
        doc_ref: str(b.doc_ref, 'Belegnummer', { max: 60 }),
        source: 'bank',
        source_id: t.id,
        source_key: `bank:${t.id}`,
        postings: [t.amount_cents > 0 ? { debit: bank, credit: account, amount_cents: amount, tax_code: code, text } : { debit: account, credit: bank, amount_cents: amount, tax_code: code, text }],
        party_name: t.counterparty,
        user_id: a.id,
        actor: a.name,
      });
      db.run(`UPDATE acc_bank_txns SET status = 'booked', entry_id = ? WHERE id = ?`, entry.id, t.id);
      return { ok: true, entry_id: entry.id, entry };
    });
    router.post('/api/accounting/bank/txns/:id/ignore', 'location', (ctx) => {
      const t = getTxn(ctx.locationId, ctx.params.id);
      if (!['open', 'matched'].includes(t.status)) throw bad('Dieser Umsatz ist schon erledigt');
      db.run(`UPDATE acc_bank_txns SET status = 'ignored', match = '{}' WHERE id = ?`, t.id);
      trail(app, ctx.locationId, actor(ctx), 'bank.ignore', null, `${t.booking_date} ${t.counterparty}`.slice(0, 200));
      return { ok: true };
    });
    router.post('/api/accounting/bank/txns/:id/reset', 'location', (ctx) => {
      const t = getTxn(ctx.locationId, ctx.params.id);
      if (t.status !== 'ignored' && t.status !== 'matched') throw bad('Nur ignorierte oder zugeordnete Umsätze lassen sich zurücksetzen');
      db.run(`UPDATE acc_bank_txns SET status = 'open', match = '{}' WHERE id = ?`, t.id);
      return { ok: true };
    });
    router.get('/api/accounting/bank/candidates', 'location', (ctx) => {
      // For the manual choice in the matching dialog: open invoices (money in) or receipts (money out).
      const incoming = ctx.query.get('direction') !== 'out';
      return candidates(ctx.locationId).filter((c) => (c.kind === 'invoice') === incoming);
    });
  },
};
