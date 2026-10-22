import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { docPath } from '../modules/accounting-receipts.js';
import { buildZip } from './acc-datev.js';
import { getSettings, type EntryRow } from './acc-ledger.js';
import { moneyDe, semicolonCsv } from './bo-common.js';
import { loadInvoice } from './invoice-flow.js';
import { invoicePdfOf } from './invoice-render.js';

/**
 * The documents for DATEV: a ZIP for "Belegtransfer" / DATEV Unternehmen online with DATEV's document.xml (schema
 * Document v06.0, namespace http://xml.datev.de/bedi/tps/document/v06.0) and the files it names, plus our index.csv.
 * - Every booked document gets a GUID; the EXTF Buchungsstapel puts the same GUID into the Beleglink column (BEDI "GUID"),
 *   so DATEV can link booking and document. The GUID is derived from the sub-account and the document, so both exports agree
 *   whenever and in whichever order they are made.
 * - Receipts (Belegeingang) are documents of type 1 (Rechnungseingang); invoices and credit notes booked from the invoicing
 *   are type 2 (Rechnungsausgang) with the first archived PDF of the invoice (the one that was sent, ZUGFeRD or plain) or,
 *   when none was archived yet, a freshly rendered one. processID 1 (buchungsrelevant) or 2 (archive only).
 * Not validated against DATEV's XSD here and not DATEV-certified – test the import with your advisor first.
 */

export const DATEV_DOCUMENT_NS = 'http://xml.datev.de/bedi/tps/document/v06.0';
/** DATEV accepts at most this many documents in one archive. */
export const DATEV_MAX_DOCUMENTS = 4999;

/** The GUID of a document in DATEV (8-4-4-4-12 hex, upper case), stable for the same sub-account and key. */
export function belegGuid(locationId: string, key: string): string {
  const h = createHash('sha256').update(`datev-beleg\n${locationId}\n${key}`).digest('hex').toUpperCase().split('');
  h[12] = '8'; // RFC 9562 version 8 (custom) …
  h[16] = '89AB'[parseInt(h[16], 16) & 3]; // … and its variant
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** The Beleglink field of the EXTF format for a document in DATEV's document store. */
export const beleglinkOf = (guid: string) => `BEDI "${guid}"`;

type EntryLike = Pick<EntryRow, 'document_id' | 'source' | 'source_id'>;

/** Which document an entry links to: its archived receipt, or the invoice it was booked from. 1 = Rechnungseingang, 2 = Rechnungsausgang. */
export function belegKey(e: EntryLike): { key: string; type?: 1 | 2 } | null {
  if (e.document_id) return { key: `doc:${e.document_id}`, type: e.source === 'receipt' ? 1 : e.source === 'invoice' ? 2 : undefined };
  if (e.source === 'invoice' && e.source_id) return { key: `invoice:${e.source_id}`, type: 2 };
  return null;
}

/** The Beleglink for the EXTF rows: only for entries whose document exists in this sub-account (the documents ZIP carries it). */
export function datevBeleglinks(app: App, locationId: string): (e: EntryLike) => string | null {
  const seen = new Map<string, boolean>();
  return (e) => {
    const b = belegKey(e);
    if (!b) return null;
    let ok = seen.get(b.key);
    if (ok === undefined) {
      ok = e.document_id
        ? !!app.db.get('SELECT 1 AS x FROM acc_documents WHERE id = ? AND location_id = ?', e.document_id, locationId)
        : !!app.db.get(`SELECT 1 AS x FROM invoices WHERE id = ? AND location_id = ? AND kind IN ('invoice', 'credit_note')`, e.source_id, locationId);
      seen.set(b.key, ok);
    }
    return ok ? beleglinkOf(belegGuid(locationId, b.key)) : null;
  };
}

export interface DatevDoc {
  guid: string;
  type?: 1 | 2;
  file: string;
  description?: string;
  keywords?: string;
}

const xmlEsc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string | undefined, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** document.xml (v06.0): header with the DATEV numbers when they fit the schema, one document per file. */
export function documentXml(o: { docs: DatevDoc[]; date: Date; description?: string; consultant?: string; client?: string; clientName?: string; process?: 1 | 2 }): string {
  const consultant = /^\d{4,7}$/.test(o.consultant ?? '') && Number(o.consultant) >= 1000 ? String(Number(o.consultant)) : '';
  const client = /^\d{1,5}$/.test(o.client ?? '') ? String(Number(o.client)) : '';
  const header = [
    `    <date>${o.date.toISOString().slice(0, 19)}</date>`,
    clip(o.description, 255) ? `    <description>${xmlEsc(clip(o.description, 255))}</description>` : '',
    consultant ? `    <consultantNumber>${consultant}</consultantNumber>` : '',
    client ? `    <clientNumber>${client}</clientNumber>` : '',
    clip(o.clientName, 36) ? `    <clientName>${xmlEsc(clip(o.clientName, 36))}</clientName>` : '',
  ].filter(Boolean);
  const docs = o.docs.map((d) => {
    const desc = clip(d.description, 40);
    const kw = clip(d.keywords, 255);
    return [
      `    <document guid="${d.guid}"${d.type ? ` type="${d.type}"` : ''} processID="${o.process ?? 1}">`,
      desc ? `      <description>${xmlEsc(desc)}</description>` : '',
      kw ? `      <keywords>${xmlEsc(kw)}</keywords>` : '',
      `      <extension xsi:type="File" name="${xmlEsc(d.file)}"/>`,
      '    </document>',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<archive xmlns="${DATEV_DOCUMENT_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${DATEV_DOCUMENT_NS} Document_v060.xsd" version="6.0" generatingSystem="HyperLevel">
  <header>
${header.join('\n')}
  </header>
  <content>
${docs.join('\n')}
  </content>
</archive>
`;
}

interface Row {
  seq: number;
  number: string;
  date: string;
  doc_date: string;
  doc_ref: string;
  text: string;
  party_name: string;
  postings: string;
  source: string;
  source_id: string | null;
  document_id: string | null;
}

interface Found {
  data: Buffer | null;
  name: string;
  sha256: string;
  check: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function archived(app: App, d: { id: string; mime: string; name: string; sha256: string }): Found {
  const path = docPath(app, { id: d.id, mime: d.mime });
  const data = existsSync(path) ? readFileSync(path) : null;
  return { data, name: d.name, sha256: d.sha256, check: !data ? 'fehlt' : sha(data) === d.sha256 ? 'Hash stimmt' : 'HASH ABWEICHEND' };
}

function fileFor(app: App, loc: string, x: Row): Found {
  if (x.document_id) {
    const d = app.db.get<any>('SELECT id, name, mime, sha256 FROM acc_documents WHERE id = ? AND location_id = ?', x.document_id, loc);
    return d ? archived(app, d) : { data: null, name: '', sha256: '', check: 'fehlt' };
  }
  // an invoice: its first archived PDF (what was sent), otherwise rendered now
  const a = app.db.get<any>(
    `SELECT a.id, a.name, a.mime, a.sha256 FROM invoice_documents d JOIN acc_documents a ON a.id = d.document_id AND a.location_id = d.location_id
     WHERE d.invoice_id = ? AND d.location_id = ? AND d.kind IN ('pdf', 'zugferd') ORDER BY d.created_at, d.rowid LIMIT 1`,
    x.source_id,
    loc,
  );
  if (a) {
    const f = archived(app, a);
    if (f.data) return f;
  }
  const inv = x.source_id ? loadInvoice(app, loc, x.source_id) : undefined;
  if (!inv) return { data: null, name: '', sha256: '', check: 'fehlt' };
  const out = invoicePdfOf(app, inv);
  return { data: out.pdf, name: out.filename, sha256: sha(out.pdf), check: 'neu erzeugt (nicht archiviert)' };
}

/**
 * The ZIP of a period: document.xml, index.csv (unless `index` is false – DATEV's Belegtransfer only needs document.xml and
 * the files) and one file per document. Throws when the period has no documents.
 */
export function datevDocumentsArchive(app: App, loc: string, from: string, to: string, o: { index?: boolean; process?: 1 | 2; now?: Date } = {}): { zip: Buffer; documents: number; missing: number } {
  const rows = app.db.all<Row>(
    `SELECT seq, number, date, doc_date, doc_ref, text, party_name, postings, source, source_id, document_id FROM acc_entries
     WHERE location_id = ? AND date >= ? AND date <= ? AND (document_id IS NOT NULL OR (source = 'invoice' AND source_id IS NOT NULL)) ORDER BY seq`,
    loc,
    from,
    to,
  );
  const files: { name: string; data: Buffer }[] = [];
  const docs: DatevDoc[] = [];
  const index: (string | number)[][] = [['Buchungsnummer', 'Buchungsdatum', 'Belegdatum', 'Belegnummer', 'Partner', 'Betrag', 'Datei', 'SHA-256', 'Prüfung', 'Art', 'Beleglink (GUID)']];
  const byKey = new Map<string, { file: string; guid: string; f: Found }>();
  const used = new Set<string>(['document.xml', 'index.csv']);
  let missing = 0;
  for (const x of rows) {
    const b = belegKey(x);
    if (!b) continue;
    let d = byKey.get(b.key);
    if (!d) {
      const f = fileFor(app, loc, x);
      const guid = belegGuid(loc, b.key);
      let file = '';
      if (f.data) {
        const ext = (/\.[A-Za-z0-9]{2,5}$/.exec(f.name) ?? [''])[0].toLowerCase();
        // receipts by their document number, invoices by their own file name (a credit note's doc_ref is the invoice's number)
        const label = x.source === 'invoice' ? f.name.replace(/\.[A-Za-z0-9]{2,5}$/, '') : x.doc_ref || 'beleg';
        const stem = `${String(x.seq).padStart(6, '0')}_${label.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}`;
        file = `${stem}${ext}`;
        for (let i = 2; used.has(file); i++) file = `${stem}_${i}${ext}`;
        used.add(file);
        files.push({ name: file, data: f.data });
        docs.push({ guid, type: b.type, file, description: x.text || x.doc_ref || x.number, keywords: [x.party_name, `Buchung ${x.number}`, x.doc_date].filter(Boolean).join('; ') });
      } else missing++;
      d = { file, guid, f };
      byKey.set(b.key, d);
    }
    let gross = 0;
    try {
      gross = (JSON.parse(x.postings) as { amount_cents: number }[]).reduce((n, p) => n + p.amount_cents, 0);
    } catch {
      /* no amount */
    }
    index.push([x.number, x.date, x.doc_date, x.doc_ref, x.party_name, moneyDe(gross), d.file || '(Datei fehlt)', d.f.sha256, d.f.check, b.type === 1 ? 'Rechnungseingang' : b.type === 2 ? 'Rechnungsausgang' : '', d.file ? d.guid : '']);
  }
  if (index.length === 1) throw bad('Im Zeitraum gibt es keine Belege zu Buchungen');
  if (docs.length > DATEV_MAX_DOCUMENTS) throw bad(`DATEV nimmt höchstens ${DATEV_MAX_DOCUMENTS} Belege je Archiv – bitte einen kürzeren Zeitraum wählen`);
  const s = getSettings(app, loc);
  const out: { name: string; data: Buffer }[] = [];
  if (docs.length) {
    const xml = documentXml({ docs, date: o.now ?? new Date(), description: `Belege ${from} bis ${to}`, consultant: s.datev.berater, client: s.datev.mandant, clientName: app.location(loc)?.name, process: o.process });
    out.push({ name: 'document.xml', data: Buffer.from(xml, 'utf8') });
  }
  if (o.index !== false) out.push({ name: 'index.csv', data: Buffer.from(semicolonCsv(index), 'utf8') });
  return { zip: buildZip([...out, ...files]), documents: docs.length, missing };
}
