import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GOBD_SQL } from '../server/modules/invoicing.js';
import { paymentsModule } from '../server/modules/payments.js';
import { backfillSnapshots } from '../server/services/invoice-flow.js';
import { FROZEN_COLUMNS } from '../server/services/invoice-model.js';
import { validateEInvoice } from '../server/services/einvoice-validate.js';
import { startTestApp } from './helpers.js';

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
const mails: any[] = [];

const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB', footer: 'Geschäftsführerin Erika Muster · Amtsgericht Berlin HRB 1' };
const item = (price = 10000, over: Record<string, unknown> = {}) => ({ name: 'Beratung', qty: 1, price_cents: price, tax_rate: 19, ...over });
const issued = async (items: any[] = [item()], extra: Record<string, unknown> = {}) => {
  const d = (await t.api.post('/api/invoices', { contact_id: contactId, items, ...extra })).data;
  const r = await t.api.post(`/api/invoices/${d.id}/finalise`, {});
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const raw = (path: string) => t.api.raw(path, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
  // a mail provider that keeps what it is given
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture' } } });
});
afterAll(async () => t.close());

describe('PDF', () => {
  it('serves the invoice as a PDF: a draft with a watermark, a final invoice with the number and the GiroCode', async () => {
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(25000)], title: 'Relaunch' })).data;
    const draft = Buffer.from(await (await raw(`/api/invoices/${d.id}/pdf`)).arrayBuffer());
    expect(draft.subarray(0, 8).toString()).toBe('%PDF-1.4');
    expect(draft.toString('latin1')).toContain('ENTWURF');
    expect((await t.api.post(`/api/invoices/${d.id}/finalise`)).status).toBe(200);
    const res = await raw(`/api/invoices/${d.id}/pdf?download=1`);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Rechnung-RE-\d+\.pdf"$/);
    const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
    expect(pdf).toContain('Rechnung RE-');
    expect(pdf).toContain('GiroCode');
    expect(pdf).toContain('297,50');
    expect(pdf).toContain('Amtsgericht Berlin HRB 1');
  });

  it('is available on the customer link – not for drafts', async () => {
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item()] })).data;
    expect((await t.api.raw(`/i/${d.public_token}/pdf`)).status).toBe(404);
    expect((await t.api.raw(`/i/${d.public_token}/xml`)).status).toBe(404);
    await t.api.post(`/api/invoices/${d.id}/finalise`);
    const r = await t.api.raw(`/i/${d.public_token}/pdf`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    const x = await t.api.raw(`/i/${d.public_token}/xml?syntax=ubl`);
    expect(x.status).toBe(200);
    expect(await x.text()).toContain('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    // the page links both, shows the GiroCode
    const page = await (await t.api.raw(`/i/${d.public_token}`)).text();
    expect(page).toContain(`/i/${d.public_token}/pdf`);
    expect(page).toContain('GiroCode');
    expect(page).toContain('<svg');
    expect((await t.api.raw('/i/doesnotexist/pdf')).status).toBe(404);
  });
});

describe('mail with the PDF (and the XRechnung)', () => {
  it('attaches the PDF to the invoice mail, archives it, and the mail names the number', async () => {
    mails.length = 0;
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(8000)], title: 'Beratung' })).data;
    const r = await t.api.post(`/api/invoices/${d.id}/send`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'sent', locked: true });
    expect(r.data.sent_at).toBeTruthy();
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.subject).toBe(`Rechnung ${r.data.number} von Testfirma`);
    expect(m.text).toContain(r.data.number);
    expect(m.attachments).toHaveLength(1);
    const a = m.attachments[0];
    expect(a).toMatchObject({ filename: `Rechnung-${r.data.number}.pdf`, contentType: 'application/pdf', encoding: 'base64' });
    const bytes = Buffer.from(a.content, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    // what was sent is in the archive, with its SHA-256
    const docs = (await t.api.get(`/api/invoices/${d.id}/documents`)).data;
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'pdf', sha256: sha(bytes) });
    expect((await t.api.get(`/api/invoices/${d.id}/audit`)).data.map((x: any) => x.action)).toEqual(expect.arrayContaining(['invoice.finalised', 'invoice.sent']));
    const dl = await raw(`/api/invoices/${d.id}/documents/${docs[0].id}/download`);
    expect(sha(Buffer.from(await dl.arrayBuffer()))).toBe(docs[0].sha256);
  });

  it('attaches the XRechnung on request, or by default when the setting says so; without PDF if asked', async () => {
    mails.length = 0;
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(9000)] })).data;
    const r = await t.api.post(`/api/invoices/${d.id}/send`, { attach_xrechnung: 'ubl', attach_pdf: false });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(mails[0].attachments.map((a: any) => [a.filename, a.contentType])).toEqual([[`Rechnung-${r.data.number}-xrechnung-ubl.xml`, 'application/xml']]);
    expect(validateEInvoice(mails[0].attachments[0].content).valid).toBe(true);
    // default by setting: the next invoice carries PDF and XML
    await t.api.put('/api/invoice-settings', { attach_xrechnung: true });
    mails.length = 0;
    const d2 = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(9000)] })).data;
    await t.api.post(`/api/invoices/${d2.id}/send`, {});
    expect(mails[0].attachments.map((a: any) => a.contentType).sort()).toEqual(['application/pdf', 'application/xml']);
    // XRechnung impossible (the seller has no phone number): a configured default sends without it, an explicit request refuses
    await t.api.put('/api/invoice-settings', { contact_phone: '' });
    mails.length = 0;
    const d3 = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(9000)] })).data;
    const quiet = await t.api.post(`/api/invoices/${d3.id}/send`, {});
    expect(quiet.status).toBe(200);
    expect(mails[0].attachments.map((a: any) => a.contentType)).toEqual(['application/pdf']);
    const d4 = await issued();
    const loud = await t.api.post(`/api/invoices/${d4.id}/send`, { attach_xrechnung: true });
    expect(loud.status).toBe(422);
    expect(loud.data.error).toMatch(/Telefonnummer/);
    await t.api.put('/api/invoice-settings', { contact_phone: SELLER.contact_phone, attach_xrechnung: false });
  });

  it('a failed send leaves a finalised invoice that can be sent again', async () => {
    t.app.services.emailTransports.capture = async () => {
      throw new Error('SMTP down');
    };
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(1000)] })).data;
    const r = await t.api.post(`/api/invoices/${d.id}/send`, {});
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/festgeschrieben.*Versand ist fehlgeschlagen/);
    const after = (await t.api.get(`/api/invoices/${d.id}`)).data;
    expect(after).toMatchObject({ locked: true, sent_at: null });
    expect((await t.api.get(`/api/invoices/${d.id}/audit`)).data.map((x: any) => x.action)).toContain('invoice.send_failed');
    t.app.services.emailTransports.capture = async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: 'x' });
    expect((await t.api.post(`/api/invoices/${d.id}/send`, {})).status).toBe(200);
  });

  it('refuses early when the customer has no e-mail address – before a number is used', async () => {
    const bare = (await t.api.post('/api/contacts', { first_name: 'Ohne', last_name: 'Mail' })).data.id;
    const d = (await t.api.post('/api/invoices', { contact_id: bare, items: [item()] })).data;
    const r = await t.api.post(`/api/invoices/${d.id}/send`, {});
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/E-Mail-Adresse/);
    expect((await t.api.get(`/api/invoices/${d.id}`)).data).toMatchObject({ locked: false, number: '' });
  });
});

describe('XRechnung download and archive', () => {
  it('generates CII and UBL from the finalised invoice, checks them, and archives each once with SHA-256 and the retention period', async () => {
    const inv = await issued([item(100000), item(3490, { name: 'Fachbuch', tax_rate: 7 })], { title: 'Projekt' });
    const cii = await raw(`/api/invoices/${inv.id}/xrechnung?download=1`);
    expect(cii.status).toBe(200);
    expect(cii.headers.get('content-type')).toContain('application/xml');
    expect(cii.headers.get('content-disposition')).toBe(`attachment; filename="Rechnung-${inv.number}-xrechnung-cii.xml"`);
    const xml = await cii.text();
    expect(xml).toContain(`<ram:ID>${inv.number}</ram:ID>`);
    expect(xml).toContain('<ram:GrandTotalAmount>1227.34</ram:GrandTotalAmount>');
    const v = validateEInvoice(xml);
    expect(v.valid, JSON.stringify(v.errors)).toBe(true);
    const ubl = await (await raw(`/api/invoices/${inv.id}/xrechnung?syntax=ubl`)).text();
    expect(validateEInvoice(ubl).valid).toBe(true);
    // the same file again: nothing new in the archive
    await raw(`/api/invoices/${inv.id}/xrechnung`);
    const docs = (await t.api.get(`/api/invoices/${inv.id}/documents`)).data;
    expect(docs.map((d: any) => d.kind).sort()).toEqual(['xrechnung-cii', 'xrechnung-ubl']);
    const cd = docs.find((d: any) => d.kind === 'xrechnung-cii');
    expect(cd.sha256).toBe(sha(xml));
    expect(cd.retention_until).toBe(`${new Date().getFullYear() + 8}-12-31`);
    expect(cd.name).toBe(`Rechnung-${inv.number}-xrechnung-cii.xml`);
    // immutable: neither the link nor the archive row can be changed or removed
    expect(() => t.app.db.run('UPDATE invoice_documents SET sha256 = ? WHERE id = ?', 'x', cd.id)).toThrow(/unveränderlich/);
    expect(() => t.app.db.run('DELETE FROM invoice_documents WHERE id = ?', cd.id)).toThrow(/unveränderlich/);
    const docId = t.app.db.get<any>('SELECT document_id FROM invoice_documents WHERE id = ?', cd.id)!.document_id;
    expect(() => t.app.db.run('UPDATE acc_documents SET sha256 = ? WHERE id = ?', 'x', docId)).toThrow();
    expect(() => t.app.db.run('DELETE FROM acc_documents WHERE id = ?', docId)).toThrow();
    // and it is in the audit trail
    expect((await t.api.get(`/api/invoices/${inv.id}/audit`)).data.filter((a: any) => a.action === 'einvoice.generated')).toHaveLength(2);
  });

  it('check report: what would be rejected, in German – the file is refused (422) while something is missing', async () => {
    const inv = await issued();
    await t.api.put('/api/invoice-settings', { contact_phone: '', iban: '' });
    // the finalised invoice keeps the seller data of the day it was finalised (they are part of the snapshot)
    expect((await t.api.get(`/api/invoices/${inv.id}/einvoice/check`)).data).toMatchObject({ final: true, ready: true, problems: [], syntax: 'cii' });
    expect((await t.api.get(`/api/invoices/${inv.id}/xrechnung`)).status).toBe(200);
    // an invoice finalised now has the gaps
    const bad = await issued();
    const rep2 = (await t.api.get(`/api/invoices/${bad.id}/einvoice/check`)).data;
    expect(rep2.ready).toBe(false);
    expect(rep2.problems.join(' ')).toMatch(/Telefonnummer/);
    expect(rep2.problems.join(' ')).toMatch(/IBAN/);
    const refused = await t.api.get(`/api/invoices/${bad.id}/xrechnung`);
    expect(refused.status).toBe(422);
    expect(refused.data.problems.length).toBeGreaterThan(1);
    await t.api.put('/api/invoice-settings', { contact_phone: SELLER.contact_phone, iban: SELLER.iban });
    // a draft has no e-invoice yet, a quote never has one
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item()] })).data;
    expect((await t.api.get(`/api/invoices/${d.id}/xrechnung`)).status).toBe(409);
    expect((await t.api.get(`/api/invoices/${d.id}/einvoice/check`)).data).toMatchObject({ final: false, ready: false });
    const est = (await t.api.post('/api/invoices', { kind: 'estimate', contact_id: contactId, items: [item()] })).data;
    expect((await t.api.get(`/api/invoices/${est.id}/xrechnung`)).status).toBe(409);
  });

  it('reverse charge, § 19, credit note and final invoice come out as valid XRechnung from the real flow', async () => {
    // reverse charge to France
    const fr = (await t.api.post('/api/contacts', { email: 'rc@fr.example', company: 'Société SAS', first_name: 'Luc', address: '1 Rue de Paris', postal_code: '75001', city: 'Paris', country: 'Frankreich' })).data.id;
    const rc = (await t.api.post('/api/invoices', { contact_id: fr, items: [{ name: 'Software', qty: 10, price_cents: 9000, tax_rate: 0 }], tax_mode: 'reverse_charge', buyer_vat_id: 'FR12345678901', supply_from: '2026-09-01', supply_to: '2026-09-30' })).data;
    expect((await t.api.post(`/api/invoices/${rc.id}/finalise`)).status).toBe(200);
    const rcx = await (await raw(`/api/invoices/${rc.id}/xrechnung`)).text();
    expect(rcx).toContain('VATEX-EU-AE');
    expect(rcx).toContain('<ram:CountryID>FR</ram:CountryID>');
    expect(validateEInvoice(rcx).valid).toBe(true);
    // a credit note (Storno) of an invoice: type 381, absolute amounts
    const inv = await issued([item(50000)]);
    const storno = (await t.api.post(`/api/invoices/${inv.id}/storno`, { reason: 'Test' })).data.storno;
    const sx = await (await raw(`/api/invoices/${storno.id}/xrechnung?syntax=ubl`)).text();
    expect(sx).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(sx).toContain(`<cbc:ID>${inv.number}</cbc:ID>`);
    expect(validateEInvoice(sx).valid).toBe(true);
    // a final invoice with a partial invoice deducted
    const a1 = await issued([item(20000, { name: 'Abschlag' })], { inv_type: 'partial' });
    const f = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(100000)], inv_type: 'final', deduct_ids: [a1.id] })).data;
    expect((await t.api.post(`/api/invoices/${f.id}/finalise`)).status).toBe(200);
    const fx = await (await raw(`/api/invoices/${f.id}/xrechnung`)).text();
    expect(fx).toContain('<ram:TotalPrepaidAmount>238.00</ram:TotalPrepaidAmount>');
    expect(validateEInvoice(fx).valid).toBe(true);
    const ax = await (await raw(`/api/invoices/${a1.id}/xrechnung`)).text();
    expect(ax).toContain('<ram:TypeCode>326</ram:TypeCode>');
  });
});

describe('migration of existing invoices', () => {
  it('finalises sent, paid and cancelled invoices with their numbers, gives drafts a placeholder and continues the numbers', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE locations (id TEXT PRIMARY KEY, settings TEXT NOT NULL DEFAULT '{}'); CREATE TABLE contacts (id TEXT PRIMARY KEY)`);
    for (const [, sql] of paymentsModule.migrations!) db.exec(sql);
    db.prepare(`INSERT INTO locations (id, settings) VALUES (?, ?)`).run('L1', JSON.stringify({ invoices: { prefix: 'RE-', small_business: false } }));
    db.prepare(`INSERT INTO locations (id, settings) VALUES (?, ?)`).run('L2', JSON.stringify({ invoices: { prefix: 'R', small_business: true } }));
    db.prepare(`INSERT INTO locations (id, settings) VALUES (?, ?)`).run('L3', JSON.stringify({}));
    const ins = db.prepare(`INSERT INTO invoices (id, location_id, kind, number, title, items, total_cents, tax_cents, status, notes, public_token, issued_at, sent_at, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const at = '2025-04-01T10:00:00.000Z';
    const row = (id: string, l: string, kind: string, number: string, status: string, total = 11900, tax = 1900, title = '', notes = '') => ins.run(id, l, kind, number, title, total, tax, status, notes, `tok-${id}`, at, status === 'draft' ? null : at, status === 'paid' ? at : null, at, at);
    row('a', 'L1', 'invoice', 'RE-1001', 'paid');
    row('b', 'L1', 'invoice', 'RE-1002', 'sent');
    row('c', 'L1', 'invoice', 'RE-1007', 'void');
    row('d', 'L1', 'invoice', 'RE-1008', 'draft'); // numbers handed to drafts are released
    row('e', 'L1', 'estimate', 'AN-1001', 'sent');
    row('f', 'L1', 'invoice', 'EXT-5', 'sent'); // does not follow the range
    row('g', 'L2', 'invoice', 'R20', 'sent', 10000, 0);
    row('h', 'L1', 'invoice', 'RE-1003', 'sent', 10000, 0, 'Beratung', 'Reverse Charge nach § 13b UStG');
    row('i', 'L3', 'invoice', 'RE-1001', 'draft');
    db.exec(GOBD_SQL);
    const q = (s: string, ...p: any[]) => db.prepare(s).get(...p) as any;
    for (const id of ['a', 'b', 'c', 'f', 'g', 'h']) expect(q('SELECT finalised_at FROM invoices WHERE id = ?', id).finalised_at, id).toBe(at);
    expect(q(`SELECT finalised_at FROM invoices WHERE id = 'd'`).finalised_at).toBeNull();
    expect(q(`SELECT finalised_at FROM invoices WHERE id = 'e'`).finalised_at).toBeNull(); // quotes are not finalised
    expect(q(`SELECT number FROM invoices WHERE id = 'a'`).number).toBe('RE-1001'); // numbers stay
    expect(q(`SELECT number FROM invoices WHERE id = 'e'`).number).toBe('AN-1001');
    expect(q(`SELECT number FROM invoices WHERE id = 'd'`).number).toBe('Entwurf-d');
    expect(q(`SELECT number FROM invoices WHERE id = 'i'`).number).toBe('Entwurf-i');
    // the counter continues after the highest number actually issued (the draft's RE-1008 is released), and only for locations with issued invoices
    expect(q(`SELECT last FROM invoice_counters WHERE location_id = 'L1' AND range = 'invoice'`).last).toBe(1007);
    expect(q(`SELECT last FROM invoice_counters WHERE location_id = 'L2' AND range = 'invoice'`).last).toBe(20);
    expect(q(`SELECT COUNT(*) AS n FROM invoice_counters WHERE location_id = 'L3'`).n).toBe(0);
    // paid ones are paid in full; tax treatment recognised
    expect(q(`SELECT paid_cents FROM invoices WHERE id = 'a'`).paid_cents).toBe(11900);
    expect(q(`SELECT paid_cents FROM invoices WHERE id = 'b'`).paid_cents).toBe(0);
    expect(q(`SELECT tax_mode, tax_note FROM invoices WHERE id = 'g'`)).toMatchObject({ tax_mode: 'small_business' });
    expect(q(`SELECT tax_mode FROM invoices WHERE id = 'h'`).tax_mode).toBe('reverse_charge');
    expect(q(`SELECT tax_mode FROM invoices WHERE id = 'a'`).tax_mode).toBe('standard');
    // they keep the old rounding; drafts and quotes the new
    expect(q(`SELECT calc FROM invoices WHERE id = 'a'`).calc).toBe('line');
    expect(q(`SELECT calc FROM invoices WHERE id = 'd'`).calc).toBe('group');
    // from now on they are frozen
    expect(() => db.exec(`UPDATE invoices SET total_cents = 1 WHERE id = 'b'`)).toThrow(/Festgeschrieben/);
    expect(() => db.exec(`DELETE FROM invoices WHERE id = 'a'`)).toThrow(/gelöscht/);
    db.exec(`UPDATE invoices SET notes = 'ok' WHERE id = 'b'`);
    db.exec(`UPDATE invoices SET total_cents = 1 WHERE id = 'd'`); // drafts stay editable
    // every frozen column is guarded
    for (const col of FROZEN_COLUMNS) if (col !== 'snapshot' && col !== 'doc_hash') expect(db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'invoices_frozen'`).get()!.sql, col).toContain(`NEW.${col} IS NOT OLD.${col}`);
    db.close();
  });

  it('gives the migrated invoices their snapshot and SHA-256 (idempotent) – and the check passes', async () => {
    const inv = await issued([item(4200)]);
    // as an old invoice is after the SQL migration: finalised, no snapshot yet
    t.app.db.raw.exec('DROP TRIGGER invoices_frozen_snapshot');
    t.app.db.run('UPDATE invoices SET snapshot = NULL, doc_hash = NULL WHERE id = ?', inv.id);
    t.app.db.raw.exec(`CREATE TRIGGER invoices_frozen_snapshot BEFORE UPDATE OF snapshot, doc_hash ON invoices WHEN OLD.finalised_at IS NOT NULL AND OLD.doc_hash IS NOT NULL AND (NEW.snapshot IS NOT OLD.snapshot OR NEW.doc_hash IS NOT OLD.doc_hash) BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnung: Momentaufnahme und Prüfsumme sind unveränderlich'); END;`);
    expect(backfillSnapshots(t.app)).toBeGreaterThanOrEqual(1);
    expect(backfillSnapshots(t.app)).toBe(0);
    const after = t.app.db.get<any>('SELECT doc_hash FROM invoices WHERE id = ?', inv.id)!;
    expect(after.doc_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await t.api.get(`/api/invoices/${inv.id}/verify`)).data.ok).toBe(true);
    expect((await t.api.get(`/api/invoices/${inv.id}/audit`)).data.map((a: any) => a.action)).toContain('invoice.migrated');
  });
});

describe('recurring invoices', () => {
  it('the generated invoice carries the legal fields of the template and is finalised when it is sent', async () => {
    const { runRecurringInvoices } = await import('../server/modules/payments.js');
    mails.length = 0;
    const tpl = (await t.api.post('/api/invoices', { contact_id: contactId, title: 'Wartung', items: [item(4900)], tax_mode: 'standard', buyer_ref: 'BESTELLUNG-77', skonto: { percent: 2, days: 10 } })).data;
    await t.api.patch(`/api/invoices/${tpl.id}`, { recurring: { interval: 'month', next_at: new Date(Date.now() - 864e5).toISOString(), auto_send: true } });
    const made = await runRecurringInvoices(t.app);
    expect(made).toHaveLength(1);
    const child = (await t.api.get(`/api/invoices/${made[0]}`)).data;
    expect(child).toMatchObject({ status: 'sent', locked: true, buyer_ref: 'BESTELLUNG-77', skonto_percent: 2, parent_id: tpl.id });
    expect(child.number).toMatch(/^RE-\d+$/);
    expect(mails.at(-1).attachments[0].contentType).toBe('application/pdf');
    // the template itself stays a draft (no number)
    expect((await t.api.get(`/api/invoices/${tpl.id}`)).data).toMatchObject({ number: '', status: 'draft' });
  });
});
