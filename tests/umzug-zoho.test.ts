import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zohoRegion } from '../server/services/umzug-zoho.js';
import { FakeZoho, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_CODE, ZOHO_REFRESH } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeZoho();
/** The account of the import tests: a fresh fake (its one-time code is unused). */
const importer = new FakeZoho();
let imported: any;
const ALL = ['companies', 'contacts', 'deals', 'tasks', 'notes'];
const creds = { data_center: 'eu', client_id: ZOHO_CLIENT_ID, client_secret: ZOHO_CLIENT_SECRET, code: ZOHO_CODE };

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Zoho');
});
afterAll(() => h.t.close());

describe('Zoho CRM: region', () => {
  it('knows the eight regions and nothing else', () => {
    expect(zohoRegion('')).toBe('com');
    expect(zohoRegion('EU')).toBe('eu');
    expect(zohoRegion('zoho.eu')).toBe('eu');
    expect(zohoRegion('https://accounts.zoho.com.au')).toBe('com.au');
    expect(() => zohoRegion('evil.example.com')).toThrow(/Region/);
    // only an allowed region name ever reaches a host name
    expect(zohoRegion('eu/../x')).toBe('eu');
    expect(() => zohoRegion('eu.evil.example.com')).toThrow();
  });
});

describe('Zoho CRM: connect', () => {
  it('refuses a wrong secret, exchanges the one-time code for a refresh token and keeps only that (sealed)', async () => {
    expect((await h.t.api.put('/api/umzug/connections/zoho', { ...creds, client_secret: 'falsch' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/zoho', { ...creds, data_center: 'evil.example.com' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/zoho', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'org-20012345678', label: 'Muster GmbH' });
    expect(JSON.stringify(r.data)).not.toContain(ZOHO_REFRESH);
    expect(fake.codeUsed).toBe(1);
    // what is stored: the refresh token, not the code
    const sealed = h.t.app.db.get<any>('SELECT secret_sealed FROM umzug_connections WHERE source = ?', 'zoho').secret_sealed as string;
    expect(sealed).not.toContain('refresh');
    const { openSecret } = await import('../server/core/secrets.js');
    const kept = JSON.parse(openSecret(h.t.app, sealed));
    expect(kept).toMatchObject({ refresh_token: ZOHO_REFRESH, client_id: ZOHO_CLIENT_ID, data_center: 'eu' });
    expect(kept.code).toBeUndefined();
    expect(fake.requests.every((q) => ['accounts.zoho.eu', 'www.zohoapis.eu'].includes(q.url.hostname))).toBe(true);
  });
  it('a second code (already used) is refused', async () => {
    await h.fresh('Zoho zweiter Versuch');
    const r = await h.t.api.put('/api/umzug/connections/zoho', creds);
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Code');
  });
});

describe('Zoho CRM: preview and import', () => {
  it('counts, lists the account\'s own fields (not lookups) and asks for named fields only', async () => {
    await h.fresh('Zoho Import');
    h.t.app.services.umzugFetch = importer.fetch;
    expect((await h.t.api.put('/api/umzug/connections/zoho', creds)).status).toBe(200);
    const r = await h.t.api.post('/api/umzug/preview', { source: 'zoho', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect([total('accounts'), total('contacts'), total('leads'), total('deals'), total('tasks'), total('notes')]).toEqual([2, 3, 2, 3, 2, 3]);
    const refs = r.data.fields.map((x: any) => x.ref);
    expect(refs).toEqual(expect.arrayContaining(['f:Kundennummer', 'f:Interesse']));
    expect(refs).not.toContain('f:Konto_Ref');
    expect(r.data.mapping).toMatchObject({ 'f:Email': 'email', 'f:First_Name': 'first_name', 'f:Phone': 'phone', 'f:Mailing_City': 'city', org_name: 'company', 'f:Date_of_Birth': 'date_of_birth', 'f:Kundennummer': 'new:text:Kundennummer', 'f:Interesse': 'new:select:Interesse' });
  });
  it('imports accounts, contacts and leads (converted skipped), pipelines with their stages, deals, tasks and notes', async () => {
    const dry = await h.run({ source: 'zoho', parts: ALL }, 'dry-run');
    expect(dry.status, dry.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    imported = await h.run({ source: 'zoho', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', city: 'Berlin', postal_code: '10115', date_of_birth: '1985-05-05', source: 'Web', dnd: 0 });
    expect(JSON.parse(anna.custom)).toMatchObject({ kundennummer: 'K-1', interesse: 'SEO' });
    expect(h.email('konrad@example.com')).toBeUndefined();
    expect(h.count('contacts')).toBe(4);
    expect(h.email('lea@example.com')).toMatchObject({ company: 'Lead GmbH', city: 'Köln', postal_code: '50667' });
    expect(h.tags('lea@example.com').sort()).toEqual(['Lead-Status: Contacted', 'Zoho: Lead']);
    expect(h.count('companies')).toBe(2);
  });
  it('turns Zoho pipelines into pipelines with their stages in order; won/lost from the stage kind', () => {
    const std = h.one("SELECT stages FROM pipelines WHERE location_id = ? AND name = 'Standard'");
    expect(JSON.parse(std.stages).map((s: any) => s.name)).toEqual(['Qualification', 'Negotiation/Review', 'Closed Won', 'Closed Lost']);
    const abos = h.one("SELECT stages FROM pipelines WHERE location_id = ? AND name = 'Abos'");
    expect(JSON.parse(abos.stages).map((s: any) => s.name)).toEqual(['Demo']); // only deals mention it
    const deals = h.q('SELECT name, value, status, contact_id FROM opportunities WHERE location_id = ? ORDER BY name');
    expect(deals).toEqual([
      { name: 'Abo-Upsell', value: 900, status: 'open', contact_id: h.email('anna@example.com').id },
      { name: 'Gewonnen', value: 12000, status: 'won', contact_id: h.email('cleo@example.com').id },
      { name: 'Website', value: 4500, status: 'open', contact_id: h.email('anna@example.com').id },
    ]);
  });
  it('imports tasks and notes (account notes stay at Zoho)', () => {
    expect(h.q('SELECT title, done FROM tasks WHERE location_id = ? ORDER BY title')).toEqual([{ title: 'Angebot nachfassen', done: 0 }, { title: 'Erledigt', done: 1 }]);
    const notes = h.q('SELECT body, contact_id FROM notes WHERE location_id = ? ORDER BY body');
    expect(notes.map((n) => n.body)).toEqual(['Erstgespräch\n\nSehr interessiert', 'Rabatt möglich']);
    expect(imported.report.find((l: any) => l.key === 'notes')).toMatchObject({ created: 2 });
  });
  it('records no advertising consent', () => {
    expect(h.email('ben@example.com').dnd).toBe(1);
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'revoked' }]);
    expect(h.ledger('anna@example.com')).toMatchObject([{ action: 'declined', source_label: 'Umzug aus Zoho CRM' }]);
  });
  it('a re-run changes nothing; undo removes it all', async () => {
    const before = { c: h.count('contacts'), o: h.count('opportunities'), n: h.count('notes'), e: h.count('consent_events') };
    const again = await h.run({ source: 'zoho', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect({ c: h.count('contacts'), o: h.count('opportunities'), n: h.count('notes'), e: h.count('consent_events') }).toEqual(before);
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('opportunities')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
  });
});

