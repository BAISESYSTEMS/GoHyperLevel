import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lexofficeContacts, lexofficeDocument } from '../server/services/umzug-lexoffice.js';
import { FakeLexoffice, LEXOFFICE_KEY } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeLexoffice();
let imported: any;
const ALL = ['contacts', 'documents'];
const creds = { token: LEXOFFICE_KEY };
const docs = (email: string) => h.t.app.db.all("SELECT type, summary, data, created_at FROM activities WHERE contact_id = ? AND type = 'document.imported' ORDER BY rowid", h.email(email)?.id ?? '').map((a: any) => ({ ...a, data: JSON.parse(a.data) }));

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Lexware');
});
afterAll(() => h.t.close());

describe('Lexware Office: pure parts', () => {
  it('makes a company with its main person as contact, more persons as more contacts', () => {
    const x = lexofficeContacts(fake.contacts[0]);
    expect(x.company).toMatchObject({ ext: 'co:' + fake.contacts[0].id, name: 'Muster GmbH', address: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', country: 'DE', phone: '+49 30 7654321' });
    expect(x.contacts.map((c) => c.ext)).toEqual([`c:${fake.contacts[0].id}`, `c:${fake.contacts[0].id}:1`]);
    expect(x.contacts[0].values).toMatchObject({ first_name: 'Anna', last_name: 'Alt', email: 'anna@muster.example.com', company: 'Muster GmbH', customer_number: '10001', tax_number: '12/345/67890', vat_id: 'DE123456789', note: 'Stammkunde' });
    expect(x.contacts[0].org).toBe(x.company!.ext);
    expect(x.contacts[1].values).toMatchObject({ first_name: 'Ben', last_name: 'Bau', email: 'ben@muster.example.com' });
    expect(x.contacts[0].proof).toMatchObject([{ basis: 'none' }]);
  });
  it('makes a contact of a person, and of a company without persons (named like the company, with the company mail)', () => {
    expect(lexofficeContacts(fake.contacts[1]).contacts[0].values).toMatchObject({ first_name: 'Cleo', last_name: 'Neu', email: 'cleo@example.com', phone: '0170 1234567', city: 'München' });
    const o = lexofficeContacts(fake.contacts[2]);
    expect(o.contacts).toHaveLength(1);
    expect(o.contacts[0].values).toMatchObject({ last_name: 'Ohne Person AG', email: 'buero@ohne.example.com', company: 'Ohne Person AG' });
  });
  it('turns a voucher into a history entry – no invoice', () => {
    const a = lexofficeDocument(fake.vouchers[0])!;
    expect(a).toMatchObject({ kind: 'activity', ext: `v:${fake.vouchers[0].id}`, contact: `c:${fake.contacts[0].id}`, type: 'document.imported' });
    expect(a.summary.replace(/\u00a0/g, ' ')).toBe('Rechnung RE0001 · 1.190,00 € · offen · aus Lexware Office');
    expect(a.data).toMatchObject({ number: 'RE0001', date: '2024-02-29', status: 'offen', total: 1190, open: 1190 });
    expect(a.data?.note).toContain('keine Rechnung dieses Systems');
    expect(lexofficeDocument(fake.vouchers[5])).toBeUndefined();
    expect(lexofficeDocument(fake.vouchers[2])!.summary).toContain('Gutschrift GS0001');
  });
});

describe('Lexware Office: connect and preview', () => {
  it('refuses a wrong key; connects with the right one without returning it', async () => {
    expect((await h.t.api.put('/api/umzug/connections/lexoffice', { token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/lexoffice', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'lx-org-lx-1', label: 'Muster GmbH' });
    expect(JSON.stringify(r.data)).not.toContain(LEXOFFICE_KEY);
    expect(fake.requests.every((q) => q.url.hostname === 'api.lexware.io')).toBe(true);
  });
  it('counts customers (not vendors) and documents, and says what a document becomes', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'lexoffice', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('contacts')).toBe(4);
    expect(total('documents')).toBe(6);
    expect(r.data.warnings.join(' ')).toContain('nicht als Rechnungen in HyperLevel');
    expect(r.data.warnings.join(' ')).toContain('Aufbewahrungspflicht');
    expect(r.data.fields.map((f: any) => f.ref)).toContain('customer_number');
    expect(r.data.mapping).toMatchObject({ email: 'email', company: 'company', customer_number: 'new:text:Kundennummer', note: 'note' });
  });
});

describe('Lexware Office: import', () => {
  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'lexoffice', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    expect(h.lines(job).contacts.created).toBe(4);
  });

  it('imports customers: companies with their persons, a person, a company alone – not archived ones or vendors', async () => {
    imported = await h.run({ source: 'lexoffice', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    expect(h.email('anna@muster.example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', phone: '+49301234567', city: 'Berlin' });
    expect(h.email('ben@muster.example.com')).toMatchObject({ first_name: 'Ben', company: 'Muster GmbH' });
    expect(h.email('cleo@example.com')).toMatchObject({ first_name: 'Cleo', city: 'München' });
    expect(h.email('buero@ohne.example.com')).toMatchObject({ last_name: 'Ohne Person AG' });
    expect(h.count('contacts')).toBe(4);
    expect(h.q('SELECT name FROM companies WHERE location_id = ? ORDER BY name').map((c: any) => c.name)).toEqual(['Muster GmbH', 'Ohne Person AG']);
    expect(JSON.parse(h.email('anna@muster.example.com').custom)).toMatchObject({ kundennummer: '10001', steuernummer: '12/345/67890', ust_idnr: 'DE123456789' });
    expect(h.ledger('anna@muster.example.com')).toMatchObject([{ action: 'declined', channel: 'email', source_label: 'Umzug aus Lexware Office (lexoffice)' }]);
  });

  it('files the documents in the history of the contact – as read-only entries, not as invoices', () => {
    expect(h.lines(imported).activities.created).toBe(4);
    const anna = docs('anna@muster.example.com');
    expect(anna.map((a: any) => a.summary.replace(/\u00a0/g, ' '))).toEqual(['Rechnung RE0001 · 1.190,00 € · offen · aus Lexware Office', 'Gutschrift GS0001 · 100,00 € · offen · aus Lexware Office']);
    expect(docs('cleo@example.com').map((a: any) => a.data.number)).toEqual(['RE0002', 'AN0001']);
    // nothing of this became a HyperLevel invoice, no number was given out, nothing frozen
    expect(h.count('invoices')).toBe(0);
    expect(h.q('SELECT * FROM invoice_counters WHERE location_id = ?')).toHaveLength(0);
    // a voucher for a contact that was not imported, and one without contact, are not written
    expect(h.lines(imported).activities.skipped).toBe(1);
  });

  it('a second run creates nothing twice', async () => {
    const again = await h.run({ source: 'lexoffice', parts: ALL });
    expect(again.status, again.error).toBe('done');
    const l = h.lines(again);
    expect(l.contacts.created).toBe(0);
    expect(l.activities).toMatchObject({ created: 0, updated: 4 });
    expect(h.count('contacts')).toBe(4);
    expect(h.t.app.db.all("SELECT 1 FROM activities WHERE type = 'document.imported'")).toHaveLength(4);
  });

  it('waits after a 429 and never logs the key', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    fake.throttle.set('/v1/contacts', 1);
    const job = await h.run({ source: 'lexoffice', parts: ['contacts'] }, 'dry-run');
    h.t.app.services.umzugSleep = async () => undefined;
    expect(job.status, job.error).toBe('done');
    expect(sleeps).toContain(2000);
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(LEXOFFICE_KEY);
  });
});

describe('Lexware Office: undo', () => {
  it('removes contacts, companies and the history entries', async () => {
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ contacts: 4, activities: 4 });
    expect(h.count('contacts')).toBe(0);
    expect(h.t.app.db.all("SELECT 1 FROM activities WHERE type = 'document.imported'")).toHaveLength(0);
  });
});
