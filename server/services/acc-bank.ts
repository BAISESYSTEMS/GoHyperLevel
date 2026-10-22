import { createHash } from 'node:crypto';
import { parseCsv } from '../core/csv.js';
import { allAt, at, deepAll, parseXml, textAt, type XNode } from './xml-lite.js';

/**
 * Bank statements for the light accounting: CSV exports of German banks and CAMT.053 (ISO 20022 XML) are parsed
 * into transactions and matched with open invoices and receipts. No FinTS/HBCI, no bank access of any kind.
 */

export interface BankTxn {
  booking_date: string;
  value_date: string;
  /** Signed: money in positive, money out negative. */
  amount_cents: number;
  currency: string;
  counterparty: string;
  counterparty_iban: string;
  purpose: string;
  end_to_end_id: string;
  bank_ref: string;
  account_iban: string;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

/** "1.234,56", "-1,234.56", "12,5", "+3.00 EUR" → cents (NaN when it is no amount). */
export function parseAmount(raw: string): number {
  let s = String(raw ?? '').replace(/[^\d,.\-+]/g, '');
  if (!/\d/.test(s)) return NaN;
  let neg = false;
  if (s.startsWith('-')) neg = true;
  if (s.endsWith('-')) neg = true;
  s = s.replace(/[+-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // The later one is the decimal separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '') : s.replace(/,/g, '');
  else if (lastDot >= 0 && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
  const v = Number(s);
  if (!Number.isFinite(v)) return NaN;
  const cents = Math.round(v * 100);
  return neg ? -cents : cents;
}

/** "31.12.2025", "31.12.25", "2025-12-31", "31/12/2025", "20251231" → YYYY-MM-DD ('' when it is no date). */
export function parseBankDate(raw: string): string {
  const s = String(raw ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})/.exec(s);
    if (!m) return '';
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : '';
}

const HEAD: Record<string, string[]> = {
  date: ['buchungstag', 'buchungsdatum', 'buchung', 'datum', 'date', 'bookingdate', 'bookingdatetime', 'buchungsdatumuhrzeit'],
  value: ['valuta', 'valutadatum', 'wertstellung', 'valuedate', 'wertstellungsdatum'],
  amount: ['betrag', 'betrageur', 'umsatz', 'amount', 'amounteur', 'betragineur', 'umsatzeur'],
  debit: ['soll', 'belastung', 'ausgang', 'debit'],
  credit: ['haben', 'gutschrift', 'eingang', 'credit'],
  counterparty: ['beguenstigterzahlungspflichtiger', 'auftraggeberempfaenger', 'empfaengerauftraggeber', 'nameauftraggeberempfaenger', 'nameempfaenger', 'name', 'zahlungspflichtiger', 'beguenstigter', 'payee', 'auftraggeber', 'empfaenger', 'kontoinhaber', 'namezahlungsbeteiligter', 'zahlungsbeteiligter'],
  iban: ['kontonummeriban', 'iban', 'ibanzahlungsbeteiligter', 'ibankontonummer', 'ibanempfaenger', 'ibanauftraggeber', 'accountnumber', 'kontonummer'],
  purpose: ['verwendungszweck', 'zahlungsreferenz', 'paymentreference', 'purpose', 'beschreibung', 'description', 'mitteilung', 'buchungstext', 'text'],
  e2e: ['endtoendreferenz', 'kundenreferenz', 'endtoendid'],
  currency: ['waehrung', 'currency', 'whrg'],
  account: ['auftragskonto', 'konto'],
};

export interface CsvParse {
  txns: BankTxn[];
  skipped: number;
  columns: Record<string, string>;
  errors: string[];
}

/** Parses a bank CSV (header row anywhere in the first 40 lines; ; or , separated; German or English column names). */
export function parseBankCsv(text: string): CsvParse {
  const rows = parseCsv(text);
  const errors: string[] = [];
  let headerAt = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 40) && headerAt < 0; i++) {
    const idx = new Map<string, number>();
    rows[i].forEach((cell, n) => {
      const f = fold(cell);
      if (f && !idx.has(f)) idx.set(f, n);
    });
    // For each field the first of its names (in the order of HEAD) that the header has: "Verwendungszweck" beats "Buchungstext".
    const found: Record<string, number> = {};
    for (const [k, names] of Object.entries(HEAD)) {
      const hit = names.find((n) => idx.has(n));
      if (hit) found[k] = idx.get(hit)!;
    }
    // "Buchung" alone is also a status column in some exports; a header needs a date and an amount (or debit/credit).
    if (found.date !== undefined && (found.amount !== undefined || (found.debit !== undefined && found.credit !== undefined))) {
      headerAt = i;
      cols = found;
    }
  }
  if (headerAt < 0) return { txns: [], skipped: rows.length, columns: {}, errors: ['Keine Kopfzeile mit Datum und Betrag gefunden – bitte CSV-Export der Bank (Umsätze) wählen.'] };
  const get = (r: string[], k: string) => (cols[k] === undefined ? '' : String(r[cols[k]] ?? '').trim());
  const txns: BankTxn[] = [];
  let skipped = 0;
  for (const r of rows.slice(headerAt + 1)) {
    const date = parseBankDate(get(r, 'date'));
    let cents = cols.amount !== undefined ? parseAmount(get(r, 'amount')) : NaN;
    if (Number.isNaN(cents) && cols.debit !== undefined) {
      const d = parseAmount(get(r, 'debit'));
      const c = parseAmount(get(r, 'credit'));
      if (!Number.isNaN(d) || !Number.isNaN(c)) cents = (Number.isNaN(c) ? 0 : c) - Math.abs(Number.isNaN(d) ? 0 : d);
    }
    if (!date || Number.isNaN(cents) || cents === 0) {
      skipped++;
      continue;
    }
    const purpose = get(r, 'purpose');
    txns.push({
      booking_date: date,
      value_date: parseBankDate(get(r, 'value')) || date,
      amount_cents: cents,
      currency: (get(r, 'currency') || 'EUR').toUpperCase().slice(0, 3),
      counterparty: get(r, 'counterparty').slice(0, 200),
      counterparty_iban: get(r, 'iban').replace(/\s+/g, '').toUpperCase().slice(0, 34),
      purpose: purpose.replace(/\s+/g, ' ').slice(0, 500),
      end_to_end_id: get(r, 'e2e').slice(0, 64),
      bank_ref: '',
      account_iban: get(r, 'account').replace(/\s+/g, '').toUpperCase().slice(0, 34),
    });
  }
  if (!txns.length && !errors.length) errors.push('Keine Umsätze in der Datei gefunden.');
  return { txns, skipped, columns: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, String(rows[headerAt][v])])), errors };
}

/** Parses a CAMT.053 (or .052/.054) XML statement. */
export function parseCamt(xml: string): { txns: BankTxn[]; errors: string[] } {
  let root: XNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    return { txns: [], errors: [`Die Datei ist kein gültiges XML (${(e as Error).message}).`] };
  }
  const stmts = [...deepAll(root, 'Stmt'), ...deepAll(root, 'Rpt'), ...deepAll(root, 'Ntfctn')];
  if (!stmts.length) return { txns: [], errors: ['Kein CAMT-Kontoauszug erkannt (erwartet: Document/BkToCstmrStmt/Stmt).'] };
  const txns: BankTxn[] = [];
  const day = (n: XNode | undefined) => parseBankDate(textAt(n, 'Dt') || textAt(n, 'DtTm'));
  for (const st of stmts) {
    const iban = textAt(st, 'Acct/Id/IBAN') || textAt(st, 'Acct/Id/Othr/Id');
    for (const ntry of allAt(st, 'Ntry')) {
      const sign = (textAt(ntry, 'CdtDbtInd') === 'DBIT' ? -1 : 1) * (textAt(ntry, 'RvslInd') === 'true' ? -1 : 1);
      const entryAmt = parseAmount(textAt(ntry, 'Amt'));
      const cur = at(ntry, 'Amt')?.attrs.Ccy || 'EUR';
      const booking = day(at(ntry, 'BookgDt')) || day(at(ntry, 'ValDt'));
      const value = day(at(ntry, 'ValDt')) || booking;
      const details = allAt(ntry, 'NtryDtls/TxDtls');
      const bankRef = textAt(ntry, 'AcctSvcrRef') || textAt(ntry, 'NtryRef');
      const info = textAt(ntry, 'AddtlNtryInf');
      // A batch entry with several transactions that carry their own amounts is split.
      const split = details.length > 1 && details.every((d) => textAt(d, 'AmtDtls/TxAmt/Amt') || textAt(d, 'Amt'));
      const parts = split ? details : [details[0]];
      for (const d of parts) {
        const incoming = sign > 0;
        const amt = split ? parseAmount(textAt(d, 'AmtDtls/TxAmt/Amt') || textAt(d, 'Amt')) : entryAmt;
        if (Number.isNaN(amt) || !amt || !booking) continue;
        const ustrd = d ? allAt(d, 'RmtInf/Ustrd').map((x) => x.text.trim()).filter(Boolean).join(' ') : '';
        const party = d ? (incoming ? textAt(d, 'RltdPties/Dbtr/Nm') || textAt(d, 'RltdPties/Dbtr/Pty/Nm') : textAt(d, 'RltdPties/Cdtr/Nm') || textAt(d, 'RltdPties/Cdtr/Pty/Nm')) : '';
        const partyIban = d ? (incoming ? textAt(d, 'RltdPties/DbtrAcct/Id/IBAN') : textAt(d, 'RltdPties/CdtrAcct/Id/IBAN')) : '';
        txns.push({
          booking_date: booking,
          value_date: value,
          amount_cents: sign * Math.abs(amt),
          currency: cur.toUpperCase().slice(0, 3),
          counterparty: party.slice(0, 200),
          counterparty_iban: partyIban.replace(/\s+/g, '').toUpperCase(),
          purpose: (ustrd || info).replace(/\s+/g, ' ').slice(0, 500),
          end_to_end_id: (d ? textAt(d, 'Refs/EndToEndId') : '').replace(/^NOTPROVIDED$/i, '').slice(0, 64),
          bank_ref: bankRef.slice(0, 64),
          account_iban: iban.replace(/\s+/g, '').toUpperCase(),
        });
      }
    }
  }
  if (!txns.length) return { txns, errors: ['Keine Umsätze in der Datei gefunden.'] };
  return { txns, errors: [] };
}

/** Sniffs the format: XML with Ntry elements = CAMT, anything else = CSV. */
export function parseBankFile(text: string): { format: 'camt' | 'csv'; txns: BankTxn[]; errors: string[]; skipped: number } {
  const t = text.replace(/^﻿/, '');
  if (/^\s*<\?xml|^\s*<Document[\s>]/.test(t) && /<(\w+:)?Ntry>/.test(t)) {
    const r = parseCamt(t);
    return { format: 'camt', txns: r.txns, errors: r.errors, skipped: 0 };
  }
  const r = parseBankCsv(t);
  return { format: 'csv', txns: r.txns, errors: r.errors, skipped: r.skipped };
}

/** A stable key per transaction (the same statement imported twice adds nothing); `n` numbers identical lines within one file. */
export function dedupeKey(t: BankTxn, n = 0): string {
  const base = t.end_to_end_id && t.bank_ref ? [t.account_iban, t.bank_ref, t.end_to_end_id, t.amount_cents] : [t.account_iban, t.booking_date, t.amount_cents, t.counterparty, t.purpose];
  return createHash('sha256').update(JSON.stringify([...base, n])).digest('hex').slice(0, 40);
}

// --- matching -----------------------------------------------------------------------------------------------

export interface Candidate {
  kind: 'invoice' | 'receipt';
  id: string;
  /** Invoice number resp. the supplier's invoice number. */
  ref: string;
  party: string;
  /** Open gross amount in cents (positive). */
  amount_cents: number;
}

export interface Match {
  kind: 'invoice' | 'receipt';
  id: string;
  ref: string;
  party: string;
  score: number;
  reasons: string[];
  partial: boolean;
}

const norm = (s: string) => fold(s);
const words = (s: string) => s.toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length >= 4 && !['gmbh', 'rechnung', 'invoice', 'zahlung', 'ihre', 'unsere'].includes(w));

/**
 * Finds the open invoice (money in) or receipt (money out) a transaction pays: the document number in the purpose is
 * the strongest sign (+60), the exact amount adds +35, a shared word of the name +15. 50 and more is offered as a proposal.
 */
export function matchTxn(t: Pick<BankTxn, 'amount_cents' | 'purpose' | 'counterparty'>, candidates: Candidate[]): Match | null {
  const incoming = t.amount_cents > 0;
  const amount = Math.abs(t.amount_cents);
  const purposeN = norm(t.purpose);
  let best: Match | null = null;
  for (const c of candidates) {
    if ((c.kind === 'invoice') !== incoming) continue;
    let score = 0;
    const reasons: string[] = [];
    const refN = norm(c.ref);
    if (refN.length >= 4 && purposeN.includes(refN)) {
      // Pure digits must not be part of a longer number.
      const digits = /^\d+$/.test(c.ref) ? new RegExp(`(?<!\\d)${c.ref}(?!\\d)`).test(t.purpose) : true;
      if (digits) (score += 60, reasons.push(`Belegnummer ${c.ref} im Verwendungszweck`));
    }
    if (c.amount_cents === amount) (score += 35, reasons.push('Betrag stimmt'));
    const hay = `${t.counterparty} ${t.purpose}`.toLowerCase();
    if (c.party && words(c.party).some((w) => hay.includes(w))) (score += 15, reasons.push('Name passt'));
    // Document number alone (60), or exact amount and name together (50), is worth proposing.
    if (score < 50) continue;
    const m: Match = { kind: c.kind, id: c.id, ref: c.ref, party: c.party, score, reasons, partial: c.amount_cents !== amount };
    if (!best || m.score > best.score) best = m;
  }
  return best;
}

