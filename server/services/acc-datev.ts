import { crc32 } from 'node:zlib';
import type { AccountRow, EntryRow, Posting } from './acc-ledger.js';
import { TAX_CODES } from './acc-vat.js';

/**
 * DATEV export of the light accounting: the "Buchungsstapel" in DATEV's EXTF format.
 *
 * Format chosen (documented in docs/backoffice.md):
 * - EXTF, version 700, data category 21 ("Buchungsstapel"), format version 13, all 125 columns of that version;
 * - Windows-1252 (DATEV's "ANSI"), semicolon separated, CR LF line ends, text in double quotes ("" inside),
 *   amounts with a decimal comma and no thousands separator, Belegdatum as TTMM, no byte-order mark;
 * - one row per posting (Buchungssatz): Konto = the counter account (bank, receivable, payable), Gegenkonto = the
 *   revenue/expense account, Umsatz = gross amount, BU-Schlüssel for accounts without a tax automatic.
 *   DATEV splits the tax itself (Automatikkonto or BU-Schlüssel), so no separate VAT rows are exported.
 * - Documents go as a ZIP with DATEV's document.xml (acc-datev-docs.ts); `beleglink` fills the Beleglink column (BEDI "GUID")
 *   of rows whose entry has a document, with the same GUID the document.xml gives that document.
 * Preparation for the tax advisor: please test an import with your advisor first. Not DATEV-certified.
 */

export const EXTF_HEADINGS = [
  'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum',
  'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext', 'Postensperre', 'Diverse Adressnummer', 'Geschäftspartnerbank', 'Sachverhalt', 'Zinssperre', 'Beleglink',
  ...Array.from({ length: 8 }, (_, i) => [`Beleginfo - Art ${i + 1}`, `Beleginfo - Inhalt ${i + 1}`]).flat(),
  'KOST1 - Kostenstelle', 'KOST2 - Kostenstelle', 'Kost-Menge', 'EU-Land u. UStID', 'EU-Steuersatz', 'Abw. Versteuerungsart', 'Sachverhalt L+L', 'Funktionsergänzung L+L',
  'BU 49 Hauptfunktionstyp', 'BU 49 Hauptfunktionsnummer', 'BU 49 Funktionsergänzung',
  ...Array.from({ length: 20 }, (_, i) => [`Zusatzinformation - Art ${i + 1}`, `Zusatzinformation - Inhalt ${i + 1}`]).flat(),
  'Stück', 'Gewicht', 'Zahlweise', 'Forderungsart', 'Veranlagungsjahr', 'Zugeordnete Fälligkeit', 'Skontotyp', 'Auftragsnummer', 'Buchungstyp', 'USt-Schlüssel (Anzahlungen)',
  'EU-Mitgliedstaat (Anzahlungen)', 'Sachverhalt L+L (Anzahlungen)', 'EU-Steuersatz (Anzahlungen)', 'Erlöskonto (Anzahlungen)', 'Herkunft-Kz', 'Leerfeld', 'KOST-Datum', 'SEPA-Mandatsreferenz',
  'Skontosperre', 'Gesellschaftername', 'Beteiligtennummer', 'Identifikationsnummer', 'Zeichnernummer', 'Postensperre bis', 'Bezeichnung SoBil-Sachverhalt', 'Kennzeichen SoBil-Buchung',
  'Festschreibung', 'Leistungsdatum', 'Datum Zuord. Steuerperiode', 'Fälligkeit', 'Generalumkehr (GU)', 'Steuersatz', 'Land', 'Abrechnungsreferenz', 'BVV-Position',
  'EU-Land u. UStID (Ursprung)', 'EU-Steuersatz (Ursprung)', 'Abw. Skontokonto',
];
export const EXTF_FIELDS = 125;
export const EXTF_HEADER_FIELDS = 31;

// Column positions (1-based) the export fills.
const COL = { umsatz: 1, sh: 2, wkz: 3, konto: 7, gegen: 8, bu: 9, belegdatum: 10, beleg1: 11, text: 14, beleglink: 20, festschreibung: 114, faelligkeit: 117 } as const;

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** Text field: control characters out, quotes doubled, cut to `max`. */
export const textField = (s: unknown, max: number) => q(String(s ?? '').replace(/[\r\n\t\u0000-\u001f]+/g, ' ').trim().slice(0, max));
export const amountField = (cents: number) => `${Math.floor(Math.abs(cents) / 100)},${String(Math.abs(cents) % 100).padStart(2, '0')}`;

/** DATEV's Belegfeld 1 allows letters, digits and $ & % * + - / only. */
export const belegfeld = (s: string) => s.replace(/\s+/g, '-').replace(/[^A-Za-z0-9$&%*+\-/]/g, '').slice(0, 36);

const ddmm = (ymd: string) => `${ymd.slice(8, 10)}${ymd.slice(5, 7)}`;
const ddmmyyyy = (ymd: string) => `${ymd.slice(8, 10)}${ymd.slice(5, 7)}${ymd.slice(0, 4)}`;
const compact = (ymd: string) => ymd.replace(/-/g, '');

export function accountField(n: string, length: number): string {
  const digits = n.replace(/\D/g, '');
  return length > digits.length ? digits.padEnd(length, '0') : digits;
}

export interface ExtfOptions {
  entries: EntryRow[];
  chart: Map<string, AccountRow>;
  standard: 'skr03' | 'skr04';
  berater: string;
  mandant: string;
  accountLength: number;
  /** First day of the fiscal year. */
  fyStart: string;
  from: string;
  to: string;
  name: string;
  now?: Date;
  /** The Beleglink of an entry (e.g. `BEDI "<GUID>"`), null when it has no linked document. */
  beleglink?: (entry: EntryRow) => string | null;
}

/** The DATEV rows of one posting (125 fields, already formatted). */
export function postingRow(entry: EntryRow, p: Posting, opts: Pick<ExtfOptions, 'chart' | 'accountLength' | 'beleglink'>): string[] {
  const f: string[] = Array(EXTF_FIELDS).fill('');
  const def = TAX_CODES[p.tax_code];
  const taxedAcc = opts.chart.get(p.taxed_side === 'debit' ? p.debit : p.credit);
  // The tax relates to the revenue/expense account; Konto is the other side (bank, receivable, payable) with its own S/H.
  // Postings without a tax code keep the natural order (debit first); with one, Konto is the account the tax does not sit on.
  const kontoIsDebit = p.tax_code === 'none' ? true : p.taxed_side === 'credit';
  const konto = kontoIsDebit ? p.debit : p.credit;
  const gegen = kontoIsDebit ? p.credit : p.debit;
  // Tax code as BU-Schlüssel unless the account books the tax by itself (Automatikkonto).
  const bu = taxedAcc?.auto_tax === p.tax_code ? '' : def.datev;
  const year = (s: string) => s.slice(0, 4);
  // TTMM carries no year: when the document date lies in another year than the booking date, the booking date counts.
  const beleg = year(entry.doc_date) === year(entry.date) ? entry.doc_date : entry.date;
  f[COL.umsatz - 1] = amountField(p.amount_cents);
  f[COL.sh - 1] = q(kontoIsDebit ? 'S' : 'H');
  f[COL.wkz - 1] = q('EUR');
  f[COL.konto - 1] = accountField(konto, opts.accountLength);
  f[COL.gegen - 1] = accountField(gegen, opts.accountLength);
  f[COL.bu - 1] = bu ? q(bu) : '';
  f[COL.belegdatum - 1] = ddmm(beleg);
  f[COL.beleg1 - 1] = entry.doc_ref ? q(belegfeld(entry.doc_ref)) : '';
  f[COL.text - 1] = textField(p.text || entry.text, 60);
  const link = opts.beleglink?.(entry);
  if (link) f[COL.beleglink - 1] = textField(link, 210);
  f[COL.festschreibung - 1] = '0';
  if (entry.due_date) f[COL.faelligkeit - 1] = ddmmyyyy(entry.due_date);
  return f;
}

export function headerRow(o: ExtfOptions): string {
  const t = o.now ?? new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const created = `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}${p(t.getUTCMilliseconds(), 3)}`;
  const f: string[] = Array(EXTF_HEADER_FIELDS).fill('');
  f[0] = q('EXTF');
  f[1] = '700';
  f[2] = '21';
  f[3] = q('Buchungsstapel');
  f[4] = '13';
  f[5] = created;
  f[7] = q('GH');
  f[8] = textField('HyperLevel', 25);
  f[10] = o.berater;
  f[11] = o.mandant;
  f[12] = compact(o.fyStart);
  f[13] = String(o.accountLength);
  f[14] = compact(o.from);
  f[15] = compact(o.to);
  f[16] = textField(o.name || `Export ${compact(o.from)}-${compact(o.to)}`, 30);
  f[18] = '1';
  f[20] = '0';
  f[21] = q('EUR');
  f[26] = q(o.standard === 'skr04' ? '04' : '03');
  return f.join(';');
}

/** The complete EXTF text (header, column headings, one row per posting), CR LF separated. */
export function buildExtf(o: ExtfOptions): { text: string; rows: number } {
  const rows: string[] = [];
  for (const e of o.entries) for (const p of e.postings) rows.push(postingRow(e, p, o).join(';'));
  return { text: [headerRow(o), EXTF_HEADINGS.join(';'), ...rows].join('\r\n') + '\r\n', rows: rows.length };
}

// --- Windows-1252 -------------------------------------------------------------------------------------

const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Text → Windows-1252 bytes; characters the code page lacks become "?". */
export function encodeCp1252(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (CP1252_HIGH[c] !== undefined) out.push(CP1252_HIGH[c]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

const CP1252_REVERSE = new Map(Object.entries(CP1252_HIGH).map(([cp, byte]) => [byte, Number(cp)]));
// 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined in Windows-1252; they decode like Latin-1 control characters.
/** Windows-1252 bytes → text (Node's TextDecoder treats this label as Latin-1, so the 0x80–0x9F block is mapped here). */
export const decodeCp1252 = (b: Buffer): string => Array.from(b, (x) => String.fromCodePoint(x >= 0x80 && x <= 0x9f ? (CP1252_REVERSE.get(x) ?? x) : x)).join('');

/** Splits an EXTF file into rows of fields (quotes honoured) – used by the tests and for a sanity check before download. */
export function parseExtf(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r\n/)) {
    if (!line) continue;
    const fields: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') (cur += '"', i++);
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ';') (fields.push(cur), (cur = ''));
      else cur += ch;
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

// --- ZIP (stored, no compression) ----------------------------------------------------------------------------

/** A ZIP archive with the files stored uncompressed (documents are PDFs and photos anyway). Names are UTF-8. */
export function buildZip(files: { name: string; data: Buffer; date?: Date }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const d = f.date ?? new Date();
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    const date = (Math.max(0, d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

/** Lists the entries of a ZIP built above (for tests): name → data. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    out.set(name, buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size));
    p += 30 + nameLen + extraLen + size;
  }
  return out;
}
