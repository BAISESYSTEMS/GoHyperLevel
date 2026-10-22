import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXTF_FIELDS, decodeCp1252, parseExtf, postingRow, readZip } from '../server/services/acc-datev.js';
import { DATEV_DOCUMENT_NS, belegGuid, belegKey, beleglinkOf, documentXml } from '../server/services/acc-datev-docs.js';
import type { EntryRow } from '../server/services/acc-ledger.js';
import { invoicePdf } from '../server/services/invoice-pdf.js';
import { zugferdXml } from '../server/services/invoice-zugferd.js';
import { allAt, parseXml, type XNode } from '../server/services/xml-lite.js';
import { makeHybridPdf } from '../server/services/zugferd-pdf.js';
import { doc } from './invoice-fixtures.js';
import { startTestApp } from './helpers.js';

vi.setConfig({ hookTimeout: 60_000 });

const GUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

describe('DATEV document.xml (v06.0) and Beleglink', () => {
  it('derives stable GUIDs per sub-account and document and writes the BEDI link', () => {
    const g = belegGuid('locA', 'doc:123');
    expect(g).toMatch(GUID);
    expect(belegGuid('locA', 'doc:123')).toBe(g);
    expect(belegGuid('locB', 'doc:123')).not.toBe(g);
    expect(belegGuid('locA', 'invoice:123')).not.toBe(g);
    expect(beleglinkOf(g)).toBe(`BEDI "${g}"`);
    expect(belegKey({ document_id: 'd1', source: 'receipt', source_id: 'r1' })).toEqual({ key: 'doc:d1', type: 1 });
    expect(belegKey({ document_id: null, source: 'invoice', source_id: 'i1' })).toEqual({ key: 'invoice:i1', type: 2 });
    expect(belegKey({ document_id: null, source: 'payment', source_id: 'i1' })).toBeNull();
    expect(belegKey({ document_id: null, source: 'manual', source_id: null })).toBeNull();
  });

  it('puts the link into column 20 of the EXTF row, quotes doubled', () => {
    const entry = { doc_date: '2026-10-05', date: '2026-10-05', doc_ref: 'RE-1', text: 'Rechnung', due_date: null, document_id: null, source: 'invoice', source_id: 'i1' } as unknown as EntryRow;
    const p = { debit: '1400', credit: '8400', amount_cents: 11900, tax_code: 'ust19', taxed_side: 'credit', text: '' } as any;
    const chart = new Map([['8400', { number: '8400', auto_tax: 'ust19' } as any]]);
    const row = postingRow(entry, p, { chart, accountLength: 4, beleglink: () => 'BEDI "8DB85C02-4CC3-8F3E-86D7-7F87EEECCF37"' });
    expect(row).toHaveLength(EXTF_FIELDS);
    expect(row[19]).toBe('"BEDI ""8DB85C02-4CC3-8F3E-86D7-7F87EEECCF37"""');
    expect(parseExtf(row.join(';'))[0][19]).toBe('BEDI "8DB85C02-4CC3-8F3E-86D7-7F87EEECCF37"');
    expect(postingRow(entry, p, { chart, accountLength: 4 })[19]).toBe('');
  });

  it('writes the archive with header, documents of type 1/2, processID and File extensions in schema order and limits', () => {
    const xml = documentXml({
      date: new Date('2026-10-05T08:30:00Z'),
      description: 'Belege Oktober',
      consultant: '1001',
      client: '456',
      clientName: 'Muster & Söhne Beratungsgesellschaft mit langem Namen',
      docs: [
        { guid: belegGuid('l', 'a'), type: 1, file: '000001_RE-77.pdf', description: 'Büro & Papier GmbH: RE-77 mit einem sehr langen Text dahinter', keywords: 'Büro; Buchung 1' },
        { guid: belegGuid('l', 'b'), type: 2, file: '000002_RE-1001.pdf', description: 'Rechnung RE-1001' },
        { guid: belegGuid('l', 'c'), file: '000003_X.png' },
      ],
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<archive xmlns="http://xml.datev.de/bedi/tps/document/v06.0"')).toBe(true);
    expect(xml).toContain(`xsi:schemaLocation="${DATEV_DOCUMENT_NS} Document_v060.xsd" version="6.0" generatingSystem="HyperLevel"`);
    const root = parseXml(xml);
    expect(root.name).toBe('archive');
    const header = root.children[0];
    expect(header.children.map((c) => c.name)).toEqual(['date', 'description', 'consultantNumber', 'clientNumber', 'clientName']);
    expect(header.children[0].text).toBe('2026-10-05T08:30:00');
    expect(header.children[4].text).toHaveLength(36);
    const docs = allAt(root, 'content/document');
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => [d.attrs.type, d.attrs.processID])).toEqual([['1', '1'], ['2', '1'], [undefined, '1']]);
    expect(docs[0].children.map((c) => c.name)).toEqual(['description', 'keywords', 'extension']);
    expect(docs[0].children[0].text).toBe('Büro & Papier GmbH: RE-77 mit einem sehr');
    expect(docs[0].children[0].text.length).toBeLessThanOrEqual(40);
    expect(docs[2].children.map((c) => c.name)).toEqual(['extension']);
    expect(xml).toContain('<extension xsi:type="File" name="000001_RE-77.pdf"/>');
    expect(xml).toContain('Büro &amp; Papier');
    // numbers outside the schema ranges are left out; process 2 = archive
    const other = documentXml({ date: new Date(), consultant: '12', client: '123456', process: 2, docs: [{ guid: belegGuid('l', 'a'), file: 'a.pdf' }] });
    expect(other).not.toContain('consultantNumber');
    expect(other).not.toContain('clientNumber');
    expect(other).toContain('processID="2"');
  });
});

// --- the exports of the app --------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const RANGE = 'from=2000-01-01&to=2099-12-31';
const raw = (path: string) => t.api.raw(path, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
const extfRows = async (q = '') => parseExtf(decodeCp1252(Buffer.from(await (await raw(`/api/accounting/datev/export?${RANGE}${q}`)).arrayBuffer()))).slice(2);
const zipOf = async (q = '') => {
  const res = await raw(`/api/accounting/datev/documents?${RANGE}${q}`);
  expect(res.status).toBe(200);
  return readZip(Buffer.from(await res.arrayBuffer()));
};
const docsOf = (files: Map<string, Buffer>): XNode[] => allAt(parseXml(files.get('document.xml')!.toString('utf8')), 'content/document');

let invZ = { id: '', number: '' };
let invP = { id: '', number: '' };

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
  expect((await t.api.put('/api/accounting/settings', { datev: { berater: '1001', mandant: '456' } })).status).toBe(200);
  await t.api.put('/api/invoice-settings', { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', contact_name: 'Erika', contact_phone: '+4930123456', contact_email: 'r@muster.example', iban: 'DE02120300000000202051' });
  const contact = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  // a supplier's ZUGFeRD invoice in the receipts inbox (read exactly from the attached XML), booked
  const supplier = doc({ number: 'LF-2026-77' });
  const { xml } = zugferdXml(supplier, 'en16931');
  const pdf = makeHybridPdf(invoicePdf(supplier), { xml, profile: 'en16931', meta: { title: 'Rechnung LF-2026-77', author: 'Muster Beratung GmbH', subject: 'Rechnung', creator: 'x', producer: 'x', date: '2026-10-05T10:00:00Z' } });
  const up = await t.api.post('/api/accounting/receipts', { name: 'lieferant.pdf', data: `data:application/pdf;base64,${pdf.toString('base64')}` });
  expect(up.status, JSON.stringify(up.data)).toBe(200);
  expect(up.data.receipt.extraction?.method ?? up.data.receipt.method).toBe('zugferd');
  const book = await t.api.post(`/api/accounting/receipts/${up.data.receipt.id}/book`, { account: '4930', payment: 'open' });
  expect(book.status, JSON.stringify(book.data)).toBe(200);
  // two own invoices: one with an archived ZUGFeRD PDF, one never archived (rendered for the export)
  for (const which of ['z', 'p'] as const) {
    const d = (await t.api.post('/api/invoices', { contact_id: contact, items: [{ name: 'Beratung', qty: 1, price_cents: which === 'z' ? 10000 : 20000, tax_rate: 19 }] })).data;
    const f = (await t.api.post(`/api/invoices/${d.id}/finalise`, {})).data;
    if (which === 'z') {
      invZ = { id: d.id, number: f.number };
      expect((await t.api.get(`/api/invoices/${d.id}/zugferd`)).status).toBe(200);
    } else invP = { id: d.id, number: f.number };
  }
  await t.api.post(`/api/invoices/${invP.id}/payments`, { amount_cents: 23800, method: 'Überweisung' });
  expect((await t.api.post('/api/accounting/autopost/run', {})).status).toBe(200);
});
afterAll(async () => t.close());

describe('EXTF ↔ document.xml', () => {
  it('links every EXTF row with a document to the GUID of that document in document.xml, and its file is in the ZIP', async () => {
    const rows = await extfRows();
    const linked = rows.filter((r) => r[19]);
    expect(linked.length).toBeGreaterThanOrEqual(3);
    for (const r of linked) expect(r[19]).toMatch(/^BEDI "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}"$/);
    const files = await zipOf();
    expect([...files.keys()].slice(0, 2)).toEqual(['document.xml', 'index.csv']);
    const docs = docsOf(files);
    const byGuid = new Map(docs.map((d) => [d.attrs.guid, d]));
    for (const r of linked) {
      const guid = /"(.+)"/.exec(r[19])![1];
      const d = byGuid.get(guid);
      expect(d, `GUID ${guid} of ${r[10]} in document.xml`).toBeTruthy();
      const name = /name="([^"]+)"/.exec(files.get('document.xml')!.toString('utf8').split(`guid="${guid}"`)[1])![1];
      expect(files.get(name)?.length, name).toBeGreaterThan(100);
    }
    // receipt: Rechnungseingang (type 1), the supplier's original ZUGFeRD PDF; invoices: Rechnungsausgang (type 2)
    const receiptRow = rows.find((r) => r[10] === 'LF-2026-77')!;
    const invRow = rows.find((r) => r[10] === invZ.number && r[19])!;
    const plainRow = rows.find((r) => r[10] === invP.number && r[19])!;
    const typeOf = (row: string[]) => byGuid.get(/"(.+)"/.exec(row[19])![1])!.attrs.type;
    expect(typeOf(receiptRow)).toBe('1');
    expect(typeOf(invRow)).toBe('2');
    expect(typeOf(plainRow)).toBe('2');
    // payments carry no link (their document is the invoice)
    const payment = rows.find((r) => r[10] === invP.number && r[6] === '1200');
    expect(payment).toBeTruthy();
    expect(payment![19]).toBe('');
    // each document once, all with processID 1, the DATEV numbers in the header
    expect(new Set(docs.map((d) => d.attrs.guid)).size).toBe(docs.length);
    expect(docs.every((d) => d.attrs.processID === '1')).toBe(true);
    const xml = files.get('document.xml')!.toString('utf8');
    expect(xml).toContain('<consultantNumber>1001</consultantNumber>');
    expect(xml).toContain('<clientNumber>456</clientNumber>');
    expect(xml).toContain('<clientName>Testfirma</clientName>');
  });

  it('uses the archived ZUGFeRD PDF of an invoice, renders one that was never archived, and lists GUIDs in the index', async () => {
    const files = await zipOf();
    const xml = files.get('document.xml')!.toString('utf8');
    const rows = await extfRows();
    const guidOf = (number: string) => /"(.+)"/.exec(rows.find((r) => r[10] === number && r[19])![19])![1];
    const fileFor = (guid: string) => /name="([^"]+)"/.exec(xml.split(`guid="${guid}"`)[1])![1];
    const zfile = files.get(fileFor(guidOf(invZ.number)))!;
    const archived = (await t.api.get(`/api/invoices/${invZ.id}/documents`)).data.find((d: any) => d.kind === 'zugferd');
    expect(createHash('sha256').update(zfile).digest('hex')).toBe(archived.sha256);
    expect(zfile.toString('latin1')).toContain('factur-x.xml');
    const pfile = files.get(fileFor(guidOf(invP.number)))!;
    expect(pfile.subarray(0, 5).toString()).toBe('%PDF-');
    const index = files.get('index.csv')!.toString('utf8');
    expect(index).toContain('"Beleglink (GUID)"');
    expect(index).toContain(guidOf(invZ.number));
    expect(index).toContain('neu erzeugt (nicht archiviert)');
    expect(index).toContain('Rechnungseingang');
    expect(index).toContain('Hash stimmt');
  });

  it('options: no index, archive documents, no Beleglink; only the own sub-account', async () => {
    const lean = await zipOf('&index=0&process=archive');
    expect(lean.has('index.csv')).toBe(false);
    expect(docsOf(lean).every((d) => d.attrs.processID === '2')).toBe(true);
    expect((await extfRows('&beleglink=0')).every((r) => r[19] === '')).toBe(true);
    // the GUIDs stay the same between two exports
    expect(docsOf(await zipOf()).map((d) => d.attrs.guid)).toEqual(docsOf(lean).map((d) => d.attrs.guid));
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    const hdr = { cookie: t.api.cookie, 'x-location-id': other, 'x-pghl': '1', 'content-type': 'application/json' };
    expect((await t.api.raw('/api/accounting/setup', { method: 'POST', headers: hdr, body: JSON.stringify({ standard: 'skr03' }) })).status).toBe(200);
    const res = await t.api.raw(`/api/accounting/datev/documents?${RANGE}`, { headers: hdr });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/keine Belege/);
  });
});
