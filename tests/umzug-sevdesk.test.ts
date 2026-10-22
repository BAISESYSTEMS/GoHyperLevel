import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEVDESK_KINDS, sevdeskContact, sevdeskDocument } from '../server/services/umzug-sevdesk.js';
import { FakeSevdesk, SEVDESK_TOKEN } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeSevdesk();
let imported: any;
const ALL = ['contacts', 'documents'];
const creds = { token: SEVDESK_TOKEN };
const nb = (s: string) => s.replace(/ /g, ' ');
const docs = (email: string) => h.t.app.db.all("SELECT summary, data FROM activities WHERE contact_id = ? AND type = 'document.imported' ORDER BY rowid", h.email(email)?.id ?? '').map((a: any) => ({ summary: nb(a.summary), data: JSON.parse(a.data) }));
const KIND = { inv: SEVDESK_KINDS[0] };

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('sevDesk');
});
afterAll(() => h.t.close());

describe('sevDesk: pure parts', () => {
  it('skips suppliers, makes an organisation a company and a contact', () => {
    expect(sevdeskContact(fake.contacts[1], undefined)).toBeUndefined();
    const x = sevdeskContact(fake.contacts[0], { emails: ['info@muster.example.com'], phones: ['+49 30 1234567'], address: fake.addresses[0] })!;
    expect(x.company).toMatchObject({ ext: 'co:100', name: 'Muster GmbH', address: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115' });
    expect(x.contact).toMatchObject({ ext: 'c:100', org: 'co:100', created_at: '2023-05-01T08:00:00.000Z' });
    expect(x.contact.values).toMatchObject({ last_name: 'Muster GmbH', company: 'Muster GmbH', email: 'info@muster.example.com', customer_number: 'K-100', vat_id: 'DE123456789', note: 'Stammkunde' });
  });
  it('makes a person a contact linked to its organisation; a prospect gets a tag', () => {
    const p = sevdeskContact(fake.contacts[2], { emails: ['anna@muster.example.com'], phones: [] })!;
    expect(p.company).toBeUndefined();
    expect(p.contact).toMatchObject({ ext: 'c:200', org: 'co:100' });
    expect(p.contact.values).toMatchObject({ first_name: 'Anna', last_name: 'Alt' });
    expect(sevdeskContact(fake.contacts[3], undefined)!.contact.tags).toEqual(['Interessent']);
  });
  it('turns a document into a history entry, with the status words of sevDesk – and nothing for drafts', () => {
    const a = sevdeskDocument(KIND.inv as any, fake.invoices[2])!;
    expect(nb(a.summary)).toBe('Rechnung RE-3 · 59,50 € · offen · aus sevDesk');
    expect(a.data).toMatchObject({ number: 'RE-3', date: '2024-02-29', due: '2024-03-14', total: 59.5, open: 59.5, status: 'offen' });
    expect(sevdeskDocument(KIND.inv as any, fake.invoices[1])).toBeUndefined();
    expect(nb(sevdeskDocument(KIND.inv as any, fake.invoices[3])!.summary)).toBe('Stornorechnung RE-4 · 1.190,00 € · teilweise bezahlt · aus sevDesk');
    expect(sevdeskDocument(KIND.inv as any, fake.invoices[0])!.data?.open).toBeNull();
  });
});

describe('sevDesk: connect and preview', () => {
  it('refuses a wrong token; connects with the right one and names the account by its client id, not by the token', async () => {
    expect((await h.t.api.put('/api/umzug/connections/sevdesk', { token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/sevdesk', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'sd-4711' });
    expect(JSON.stringify(r.data)).not.toContain(SEVDESK_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'my.sevdesk.de')).toBe(true);
  });
  it('counts contacts and documents, and says what a document becomes', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'sevdesk', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('contacts')).toBe(6);
    expect(total('invoices')).toBe(5);
    expect(total('credit_notes')).toBe(1);
    expect(total('orders')).toBe(2);
    expect(r.data.warnings.join(' ')).toContain('nicht als Rechnungen in HyperLevel');
    expect(r.data.fields.map((f: any) => f.ref)).toContain('vat_id');
  });
});

describe('sevDesk: import', () => {
  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'sevdesk', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
  });

  it('imports customers and prospects (no suppliers): organisations first, persons linked to them', async () => {
    imported = await h.run({ source: 'sevdesk', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    expect(h.email('anna@muster.example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', phone: '+491701234567' });
    expect(h.email('info@muster.example.com')).toMatchObject({ last_name: 'Muster GmbH', company: 'Muster GmbH', phone: '+49301234567', city: 'Berlin' });
    expect(h.email('ben@example.com')).toBeTruthy();
    expect(h.tags('ben@example.com')).toEqual(['Interessent']);
    // the main address is taken, not the first one
    expect(h.count('contacts')).toBe(3);
    expect(h.q('SELECT name FROM companies WHERE location_id = ?').map((c: any) => c.name)).toEqual(['Muster GmbH']);
    expect(JSON.parse(h.email('info@muster.example.com').custom)).toMatchObject({ kundennummer: 'K-100', ust_idnr: 'DE123456789' });
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'declined', source_label: 'Umzug aus sevDesk' }]);
  });

  it('files the documents in the history of their contact, not as invoices', () => {
    expect(docs('info@muster.example.com').map((d: any) => d.summary)).toEqual([
      'Rechnung RE-1 · 1.190,00 € · bezahlt · aus sevDesk',
      'Gutschrift GU-1 · 100,00 € · offen · aus sevDesk',
      'Angebot AN-1 · 500,00 € · angenommen · aus sevDesk',
      'Lieferschein LI-1 · 0,00 € · versendet · aus sevDesk',
    ]);
    expect(docs('anna@muster.example.com').map((d: any) => d.summary)).toEqual(['Rechnung RE-3 · 59,50 € · offen · aus sevDesk']);
    expect(docs('ben@example.com').map((d: any) => d.summary)).toEqual(['Stornorechnung RE-4 · 1.190,00 € · teilweise bezahlt · aus sevDesk']);
    expect(h.count('invoices')).toBe(0);
    // the draft and the invoice of an unknown contact are not written
    expect(h.lines(imported).activities).toMatchObject({ created: 6, skipped: 1 });
  });

  it('a second run creates nothing twice', async () => {
    const again = await h.run({ source: 'sevdesk', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect(h.lines(again).contacts.created).toBe(0);
    expect(h.lines(again).activities).toMatchObject({ created: 0, updated: 6 });
    expect(h.count('contacts')).toBe(3);
  });

  it('never wrote the token anywhere', () => {
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(SEVDESK_TOKEN);
  });
});

describe('sevDesk: undo', () => {
  it('removes contacts, the company and the history entries', async () => {
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ contacts: 3, activities: 6 });
    expect(h.count('contacts')).toBe(0);
    expect(h.t.app.db.all("SELECT 1 FROM activities WHERE type = 'document.imported'")).toHaveLength(0);
  });
});
