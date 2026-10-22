import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findEmbeddedInvoice } from '../server/services/acc-receipts.js';
import { ciiXml } from '../server/services/einvoice-cii.js';
import { buildEInvoice } from '../server/services/einvoice-model.js';
import { validateEInvoice } from '../server/services/einvoice-validate.js';
import { invoicePdf } from '../server/services/invoice-pdf.js';
import { zugferdFilename, zugferdXml } from '../server/services/invoice-zugferd.js';
import { SRGB_NAME, srgbIcc } from '../server/services/srgb-icc.js';
import { FX_NAMESPACE, FX_PROFILES, indexPdf, makeHybridPdf, objectText, pdfText, readEmbeddedFiles, streamData } from '../server/services/zugferd-pdf.js';
import { doc } from './invoice-fixtures.js';
import { startTestApp } from './helpers.js';

vi.setConfig({ hookTimeout: 60_000 });

const META = { title: 'Rechnung RE-2026-0001', author: 'Muster Beratung GmbH', subject: 'Rechnung RE-2026-0001 an Kunde & Söhne GmbH', creator: 'HyperLevel Rechnungen', producer: 'HyperLevel', date: '2026-10-05T10:00:00.000Z' };
const hybrid = (profile: 'en16931' | 'xrechnung' = 'en16931', d = doc()) => {
  const { xml } = zugferdXml(d, profile);
  return { xml, pdf: makeHybridPdf(invoicePdf(d), { xml, profile, meta: META }) };
};
/** The XMP packet of a PDF (catalog → /Metadata). */
const xmpOf = (pdf: Buffer) => {
  const idx = indexPdf(pdf);
  const n = Number(/\/Metadata (\d+) 0 R/.exec(objectText(pdf, idx, idx.root))![1]);
  return streamData(pdf, idx, n).toString('utf8');
};

describe('hybrid PDF (ZUGFeRD 2.3 / Factur-X 1.07)', () => {
  it('embeds the CII as factur-x.xml – byte for byte the CII of the EN 16931 profile – and lists it in /AF', () => {
    const { xml, pdf } = hybrid();
    const files = readEmbeddedFiles(pdf);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('factur-x.xml');
    expect(files[0].data.toString('utf8')).toBe(xml);
    expect(files[0].af).toBe(true);
    // the XML is the generator's CII with the EN 16931 guideline, and it passes the own rule check of that profile
    const { einvoice } = buildEInvoice(doc());
    expect(xml).toBe(ciiXml({ ...einvoice, customization: 'urn:cen.eu:en16931:2017' }));
    expect(validateEInvoice(xml, { profile: 'en16931' }).valid).toBe(true);
    // catalog: /AF array, EmbeddedFiles name tree, metadata and output intent
    const idx = indexPdf(pdf);
    const cat = objectText(pdf, idx, idx.root);
    expect(cat).toMatch(/\/Type \/Catalog/);
    expect(cat).toMatch(/\/AF \[\d+ 0 R\]/);
    expect(cat).toMatch(/\/Names << \/EmbeddedFiles << \/Names \[\(factur-x\.xml\) \d+ 0 R\] >> >>/);
    expect(cat).toMatch(/\/OutputIntents \[\d+ 0 R\]/);
    // file specification and embedded file stream as PDF/A-3 wants them
    expect(files[0].spec).toMatch(/\/Type \/Filespec/);
    expect(files[0].spec).toMatch(/\/F \(factur-x\.xml\) \/UF \(factur-x\.xml\)/);
    expect(files[0].spec).toMatch(/\/AFRelationship \/Alternative/);
    const efNum = Number(/\/EF << \/F (\d+) 0 R/.exec(files[0].spec)![1]);
    const ef = objectText(pdf, idx, efNum);
    expect(ef).toMatch(/\/Type \/EmbeddedFile \/Subtype \/text#2Fxml/);
    expect(ef).toContain(`/Size ${Buffer.byteLength(xml)}`);
    expect(ef).toContain(`/CheckSum <${createHash('md5').update(xml).digest('hex').toUpperCase()}>`);
    expect(ef).toMatch(/\/ModDate \(D:20261005100000\+00'00'\)/);
    // the receipts inbox of another HyperLevel reads it back as well
    expect(findEmbeddedInvoice(pdf)).toBe(xml);
  });

  it('writes XMP with PDF/A-3B, the Factur-X extension schema and the fx values, matching the Info dictionary', () => {
    const { pdf } = hybrid();
    const xmp = xmpOf(pdf);
    expect(xmp.startsWith('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>')).toBe(true);
    expect(xmp).toContain('<pdfaid:part>3</pdfaid:part>');
    expect(xmp).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(xmp).toContain(`<pdfaSchema:namespaceURI>${FX_NAMESPACE}</pdfaSchema:namespaceURI>`);
    expect(xmp).toContain('<pdfaSchema:prefix>fx</pdfaSchema:prefix>');
    for (const p of ['DocumentFileName', 'DocumentType', 'Version', 'ConformanceLevel']) expect(xmp).toContain(`<pdfaProperty:name>${p}</pdfaProperty:name>`);
    expect(xmp).toContain('<fx:DocumentType>INVOICE</fx:DocumentType>');
    expect(xmp).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    expect(xmp).toContain('<fx:Version>1.0</fx:Version>');
    expect(xmp).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Rechnung RE-2026-0001 an Kunde &amp; Söhne GmbH</rdf:li>');
    expect(xmp).toContain('<xmp:CreateDate>2026-10-05T10:00:00+00:00</xmp:CreateDate>');
    // the Info dictionary says the same (PDF/A wants both to agree); non-ASCII as UTF-16BE
    const idx = indexPdf(pdf);
    const info = objectText(pdf, idx, idx.info!);
    expect(info).toContain('/Title (Rechnung RE-2026-0001)');
    expect(info).toContain(`/Subject ${pdfText(META.subject)}`);
    expect(pdfText(META.subject)).toMatch(/^<FEFF[0-9A-F]+>$/);
    expect(Buffer.from(pdfText(META.subject).slice(5, -1), 'hex').swap16().toString('utf16le')).toBe(META.subject);
    expect(info).toContain("/CreationDate (D:20261005100000+00'00')");
    expect(info).toContain('/Producer (HyperLevel)');
  });

  it('is one clean revision: PDF 1.7 header, every xref offset points at its object, document ID, deterministic', () => {
    const { pdf } = hybrid();
    expect(pdf.subarray(0, 9).toString('latin1')).toBe('%PDF-1.7\n');
    expect([...pdf.subarray(10, 14)].every((b) => b > 127)).toBe(true); // binary comment line
    const s = pdf.toString('latin1');
    expect(s.match(/startxref/g)).toHaveLength(1);
    expect(s).toMatch(/\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);
    const idx = indexPdf(pdf);
    for (const [n, r] of idx.objects) expect(s.slice(r.start, r.start + 12)).toMatch(new RegExp(`^${n} 0 obj`));
    expect(idx.objects.size).toBe(idx.size - 1);
    expect(hybrid().pdf.equals(pdf)).toBe(true);
    // the original pages stay untouched
    const plain = invoicePdf(doc()).toString('latin1');
    const page = /\d+ 0 obj\n<< \/Length \d+ >>\nstream\n[\s\S]*?endstream/.exec(plain)![0];
    expect(s).toContain(page);
  });

  it('carries an sRGB ICC profile in the output intent', () => {
    const { pdf } = hybrid();
    const idx = indexPdf(pdf);
    const cat = objectText(pdf, idx, idx.root);
    const intent = objectText(pdf, idx, Number(/\/OutputIntents \[(\d+) 0 R\]/.exec(cat)![1]));
    expect(intent).toContain('/S /GTS_PDFA1');
    expect(intent).toContain(`/OutputConditionIdentifier (${SRGB_NAME})`);
    const iccNum = Number(/\/DestOutputProfile (\d+) 0 R/.exec(intent)![1]);
    expect(objectText(pdf, idx, iccNum)).toContain('/N 3');
    const icc = streamData(pdf, idx, iccNum);
    expect(icc.equals(srgbIcc())).toBe(true);
  });

  it('makes a well-formed ICC v2 display profile (header, tag table inside the file, shared TRC)', () => {
    const icc = srgbIcc();
    expect(icc.readUInt32BE(0)).toBe(icc.length);
    expect(icc.readUInt32BE(8)).toBe(0x02100000);
    expect(icc.subarray(12, 24).toString('latin1')).toBe('mntrRGB XYZ ');
    expect(icc.subarray(36, 40).toString('latin1')).toBe('acsp');
    const n = icc.readUInt32BE(128);
    const tags = new Map<string, [number, number]>();
    for (let i = 0; i < n; i++) {
      const p = 132 + i * 12;
      const off = icc.readUInt32BE(p + 4);
      const size = icc.readUInt32BE(p + 8);
      expect(off % 4).toBe(0);
      expect(off + size).toBeLessThanOrEqual(icc.length);
      tags.set(icc.subarray(p, p + 4).toString('latin1'), [off, size]);
    }
    expect([...tags.keys()].sort()).toEqual(['bTRC', 'bXYZ', 'cprt', 'desc', 'gTRC', 'gXYZ', 'rTRC', 'rXYZ', 'wtpt']);
    expect(tags.get('rTRC')).toEqual(tags.get('bTRC'));
    const [trc] = tags.get('gTRC')!;
    expect(icc.subarray(trc, trc + 4).toString('latin1')).toBe('curv');
    expect(icc.readUInt32BE(trc + 8)).toBe(1024);
    expect(icc.readUInt16BE(trc + 12)).toBe(0);
    expect(icc.readUInt16BE(trc + 12 + 1023 * 2)).toBe(65535);
    const [d] = tags.get('desc')!;
    expect(icc.subarray(d + 12, d + 12 + SRGB_NAME.length).toString('latin1')).toBe(SRGB_NAME);
  });

  it('profile XRECHNUNG attaches the XRechnung CII as xrechnung.xml; credit notes carry type 381', () => {
    const x = hybrid('xrechnung');
    const f = readEmbeddedFiles(x.pdf);
    expect(f.map((e) => e.name)).toEqual(['xrechnung.xml']);
    const { einvoice } = buildEInvoice(doc());
    expect(f[0].data.toString('utf8')).toBe(ciiXml(einvoice));
    expect(xmpOf(x.pdf)).toContain('<fx:ConformanceLevel>XRECHNUNG</fx:ConformanceLevel>');
    expect(xmpOf(x.pdf)).toContain('<fx:DocumentFileName>xrechnung.xml</fx:DocumentFileName>');
    const credit = doc({ kind: 'credit_note', number: 'GS-2026-0001', items: [{ name: 'Nachlass', qty: 1, price_cents: -2000, tax_rate: 19 }], ref: { id: 'r1', number: 'RE-2026-0001', issued_ymd: '2026-10-01' } } as any);
    const c = hybrid('en16931', credit);
    const xml = readEmbeddedFiles(c.pdf)[0].data.toString('utf8');
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xml).toContain('<ram:IssuerAssignedID>RE-2026-0001</ram:IssuerAssignedID>');
    expect(xmpOf(c.pdf)).toContain('<fx:DocumentType>INVOICE</fx:DocumentType>');
    expect(zugferdFilename(credit, 'en16931')).toBe('Gutschrift-Rechnungskorrektur-GS-2026-0001-zugferd.pdf');
    expect(zugferdFilename(doc(), 'xrechnung')).toBe('Rechnung-RE-2026-0001-zugferd-xrechnung.pdf');
    expect(FX_PROFILES.en16931.guideline).toBe('urn:cen.eu:en16931:2017');
  });

  it('refuses PDFs it cannot rewrite safely and documents with missing data', () => {
    const { pdf } = hybrid();
    expect(() => makeHybridPdf(pdf, { xml: '<x/>', profile: 'en16931', meta: META })).toThrow(/schon Anhänge/);
    expect(() => makeHybridPdf(Buffer.from('%PDF-1.5\n1 0 obj\n<<>>\nendobj\nstartxref\n9\n%%EOF'), { xml: '<x/>', profile: 'en16931', meta: META })).toThrow(/Querverweis-Stream/);
    const plain = invoicePdf(doc());
    const twice = Buffer.concat([plain, Buffer.from('trailer\n<< /Size 2 /Root 1 0 R /Prev 9 >>\nstartxref\n' + plain.toString('latin1').lastIndexOf('xref') + '\n%%EOF\n')]);
    expect(() => makeHybridPdf(twice, { xml: '<x/>', profile: 'en16931', meta: META })).toThrow();
    expect(() => zugferdXml(doc({ seller: { ...doc().seller, phone: '' } } as any), 'en16931')).toThrow(/Telefonnummer/);
    // the attachment is compressed: the plain XML text is not in the file
    expect(pdf.toString('latin1')).not.toContain('CrossIndustryInvoice');
  });
});

// --- the app: route, archive, MCP, mail, isolation ------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
const mails: any[] = [];
const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' };
const item = (price = 10000) => ({ name: 'Beratung', qty: 1, price_cents: price, tax_rate: 19 });
const raw = (path: string, headers: Record<string, string> = {}) => t.api.raw(path, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1', ...headers } });
const issued = async (price = 10000) => {
  const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(price)] })).data;
  const r = await t.api.post(`/api/invoices/${d.id}/finalise`, {});
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture' } } });
});
afterAll(async () => t.close());

describe('ZUGFeRD download', () => {
  it('serves the hybrid PDF of a finalised invoice; the attached XML equals the CII it reports, XRECHNUNG equals the XRechnung download', async () => {
    const inv = await issued();
    const res = await raw(`/api/invoices/${inv.id}/zugferd?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="Rechnung-${inv.number}-zugferd.pdf"`);
    const pdf = Buffer.from(await res.arrayBuffer());
    const json = (await t.api.get(`/api/invoices/${inv.id}/zugferd?format=json`)).data;
    expect(json).toMatchObject({ profile: 'en16931', conformance: 'EN 16931', embedded: 'factur-x.xml', filename: `Rechnung-${inv.number}-zugferd.pdf`, size: pdf.length, validation: { valid: true } });
    expect(json.pdf_base64).toBeUndefined();
    expect(readEmbeddedFiles(pdf)[0].data.toString('utf8')).toBe(json.xml);
    expect(json.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    // profile XRECHNUNG: the attachment is exactly the XRechnung (CII) download
    const x = await raw(`/api/invoices/${inv.id}/zugferd?profile=xrechnung`);
    const xr = await (await raw(`/api/invoices/${inv.id}/xrechnung?syntax=cii`)).text();
    const files = readEmbeddedFiles(Buffer.from(await x.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(['xrechnung.xml']);
    expect(files[0].data.toString('utf8')).toBe(xr);
    expect((await t.api.get(`/api/invoices/${inv.id}/zugferd?profile=basic`)).status).toBe(400);
    // archived once (identical bytes), noted in the trail
    const docs = (await t.api.get(`/api/invoices/${inv.id}/documents`)).data;
    expect(docs.filter((d: any) => d.kind === 'zugferd')).toHaveLength(2);
    expect(docs.find((d: any) => d.sha256 === json.sha256)).toBeTruthy();
    const audit = (await t.api.get(`/api/invoices/${inv.id}/audit`)).data.filter((a: any) => a.action === 'zugferd.generated');
    expect(audit).toHaveLength(2);
    expect(audit[0].detail).toContain('EN 16931');
  });

  it('works for credit notes (type 381) and refuses drafts, quotes and incomplete seller data', async () => {
    const inv = await issued(20000);
    const cn = (await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'Nachlass', qty: 1, price_cents: 5000, tax_rate: 19 }], reason: 'Kulanz' })).data;
    expect((await t.api.get(`/api/invoices/${cn.id}/zugferd`)).status).toBe(409);
    expect((await t.api.post(`/api/invoices/${cn.id}/finalise`, {})).status).toBe(200);
    const json = (await t.api.get(`/api/invoices/${cn.id}/zugferd?format=json`)).data;
    expect(json.xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(json.xml).toContain(`<ram:IssuerAssignedID>${inv.number}</ram:IssuerAssignedID>`);
    expect(json.filename).toMatch(/^Gutschrift-Rechnungskorrektur-.+-zugferd\.pdf$/);
    // a Storno of another invoice (one with a credit note cannot be cancelled any more – its rest is credited instead)
    const storno = (await t.api.post(`/api/invoices/${(await issued(20000)).id}/storno`, { reason: 'Irrtum' })).data.storno;
    const st = (await t.api.get(`/api/invoices/${storno.id}/zugferd?format=json`)).data;
    expect(st.xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    const quote = (await t.api.post('/api/invoices', { kind: 'estimate', contact_id: contactId, items: [item()] })).data;
    expect((await t.api.get(`/api/invoices/${quote.id}/zugferd`)).status).toBe(409);
    await t.api.put('/api/invoice-settings', { contact_phone: '' });
    const bare = await issued();
    const r = await t.api.get(`/api/invoices/${bare.id}/zugferd`);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/Telefonnummer/);
    await t.api.put('/api/invoice-settings', { contact_phone: SELLER.contact_phone });
    expect((await t.api.get('/api/invoices/gibtsnicht/zugferd')).status).toBe(404);
  });

  it('is offered as MCP tool ghl_invoice_zugferd', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'ZUGFeRD' })).data.key;
    const rpc = async (method: string, params: any) => (await (await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const tool = (await rpc('tools/list', {})).tools.find((x: any) => x.name === 'ghl_invoice_zugferd');
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    const inv = await issued();
    const r = await rpc('tools/call', { name: 'ghl_invoice_zugferd', arguments: { location_id: loc, invoice_id: inv.id, include_pdf: true } });
    expect(r.isError, r.content?.[0]?.text).toBe(false);
    const out = r.structuredContent ?? JSON.parse(r.content[0].text);
    expect(out).toMatchObject({ profile: 'en16931', embedded: 'factur-x.xml', download: `/api/invoices/${inv.id}/zugferd?profile=en16931&download=1` });
    expect(readEmbeddedFiles(Buffer.from(out.pdf_base64, 'base64'))[0].data.toString('utf8')).toBe(out.xml);
  });

  it('keeps sub-accounts apart: a key of one sub-account cannot fetch another one’s ZUGFeRD', async () => {
    const inv = await issued();
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    t.api.setLocation(other);
    const otherKey = (await t.api.post('/api/api-keys', { name: 'Fremd' })).data.key;
    t.api.setLocation(loc);
    const asOther = await t.api.raw(`/api/invoices/${inv.id}/zugferd`, { headers: { authorization: `Bearer ${otherKey}` } });
    expect(asOther.status).toBe(404);
    const forced = await t.api.raw(`/api/invoices/${inv.id}/zugferd`, { headers: { authorization: `Bearer ${otherKey}`, 'x-location-id': loc } });
    expect([401, 403, 404]).toContain(forced.status);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM invoice_documents WHERE invoice_id = ? AND kind = 'zugferd'`, inv.id).n).toBe(0);
  });
});

describe('ZUGFeRD in the invoice mail', () => {
  it('attaches the hybrid PDF instead of the plain one when the setting says so (default off)', async () => {
    mails.length = 0;
    const plain = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(7000)] })).data;
    const sent = (await t.api.post(`/api/invoices/${plain.id}/send`, {})).data;
    expect(mails[0].attachments.map((a: any) => a.filename)).toEqual([`Rechnung-${sent.number}.pdf`]);
    expect(readEmbeddedFiles(Buffer.from(mails[0].attachments[0].content, 'base64'))).toEqual([]);

    expect((await t.api.put('/api/invoice-settings', { attach_zugferd: true })).data.settings.attach_zugferd).toBe(true);
    mails.length = 0;
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(8000)] })).data;
    const r = await t.api.post(`/api/invoices/${d.id}/send`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(mails[0].attachments).toHaveLength(1);
    const a = mails[0].attachments[0];
    expect(a).toMatchObject({ filename: `Rechnung-${r.data.number}-zugferd.pdf`, contentType: 'application/pdf', encoding: 'base64' });
    const pdf = Buffer.from(a.content, 'base64');
    const xml = readEmbeddedFiles(pdf)[0].data.toString('utf8');
    expect(xml).toContain(`<ram:ID>${r.data.number}</ram:ID>`);
    // archived as what was sent: one ZUGFeRD copy, no extra plain PDF
    const docs = (await t.api.get(`/api/invoices/${d.id}/documents`)).data;
    expect(docs.map((x: any) => x.kind)).toEqual(['zugferd']);
    expect(docs[0].sha256).toBe(createHash('sha256').update(pdf).digest('hex'));

    // the e-invoice cannot be made (no phone number): the default falls back to the plain PDF, an explicit request refuses
    await t.api.put('/api/invoice-settings', { contact_phone: '' });
    mails.length = 0;
    const d2 = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(8000)] })).data;
    const quiet = await t.api.post(`/api/invoices/${d2.id}/send`, {});
    expect(quiet.status).toBe(200);
    expect(mails[0].attachments.map((x: any) => x.filename)).toEqual([`Rechnung-${quiet.data.number}.pdf`]);
    expect((await t.api.get(`/api/invoices/${d2.id}/audit`)).data.map((x: any) => x.action)).toContain('zugferd.attach_skipped');
    const d3 = await issued();
    const loud = await t.api.post(`/api/invoices/${d3.id}/send`, { attach_zugferd: true });
    expect(loud.status).toBe(422);
    await t.api.put('/api/invoice-settings', { contact_phone: SELLER.contact_phone, attach_zugferd: false });
    // a single send can ask for it while the setting is off
    mails.length = 0;
    const d4 = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(8000)] })).data;
    const one = await t.api.post(`/api/invoices/${d4.id}/send`, { attach_zugferd: true });
    expect(mails[0].attachments[0].filename).toBe(`Rechnung-${one.data.number}-zugferd.pdf`);
  });
});
