import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TUNING, salesforceBase } from '../server/services/umzug-salesforce.js';
import { FakeSalesforce, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_ORG, SF_TOKEN } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeSalesforce();
let imported: any;
const ALL = ['companies', 'contacts', 'deals', 'tasks'];
const creds = { instance_url: SF_ORG, client_id: SF_CLIENT_ID, client_secret: SF_CLIENT_SECRET };

beforeAll(async () => {
  TUNING.block = 2; // so every list needs several blocks
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Salesforce');
});
afterAll(() => {
  TUNING.block = 500;
  return h.t.close();
});

describe('Salesforce: the org address', () => {
  it('accepts Salesforce hosts only and turns a Lightning address into the My Domain one', () => {
    expect(salesforceBase('https://muster.my.salesforce.com/lightning/page/home')).toBe('https://muster.my.salesforce.com');
    expect(salesforceBase('muster.lightning.force.com')).toBe('https://muster.my.salesforce.com');
    expect(salesforceBase('https://muster--dev.sandbox.my.salesforce.com')).toBe('https://muster--dev.sandbox.my.salesforce.com');
    expect(() => salesforceBase('https://evil.example.com')).toThrow(/ungültig/);
    expect(() => salesforceBase('https://muster.my.salesforce.com.evil.example.com')).toThrow(/ungültig/);
    expect(() => salesforceBase('https://169.254.169.254')).toThrow();
    expect(() => salesforceBase('')).toThrow();
  });
});

describe('Salesforce: connect and preview', () => {
  it('asks for credentials, refuses a foreign host and wrong secrets, connects with the client-credentials flow', async () => {
    expect((await h.t.api.put('/api/umzug/connections/salesforce', { instance_url: SF_ORG })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/salesforce', { ...creds, instance_url: 'https://evil.example.com' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/salesforce', { ...creds, client_secret: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/salesforce', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.account).toBe('muster');
    expect(r.data.label).toContain('14.876');
    expect(JSON.stringify(r.data)).not.toContain(SF_CLIENT_SECRET);
    expect(fake.requests.every((q) => q.url.hostname === 'muster.my.salesforce.com')).toBe(true);
  });
  it('counts and lists the org\'s own fields', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'salesforce', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('accounts')).toBe(2);
    expect(total('contacts')).toBe(3);
    expect(total('leads')).toBe(1);
    expect(total('stages')).toBe(4);
    expect(total('opportunities')).toBe(3);
    expect(total('tasks')).toBe(2);
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toEqual(expect.arrayContaining(['f:Kundennummer__c', 'f:Interesse__c']));
    expect(r.data.mapping).toMatchObject({ 'f:Email': 'email', 'f:FirstName': 'first_name', 'f:Phone': 'phone', 'f:MailingCity': 'city', org_name: 'company', 'f:Birthdate': 'date_of_birth', 'f:LeadSource': 'source', 'f:Kundennummer__c': 'new:text:Kundennummer', 'f:Interesse__c': 'new:select:Interesse' });
    expect(r.data.warnings.join(' ')).toContain('Tageslimit');
  });
});

describe('Salesforce: import', () => {
  it('imports accounts, contacts and leads (converted leads skipped) by Id blocks', async () => {
    const dry = await h.run({ source: 'salesforce', parts: ALL }, 'dry-run');
    expect(dry.status, dry.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    imported = await h.run({ source: 'salesforce', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    expect(fake.seen('/services/data/v62.0/query').some((c) => /Id > '/.test(String(c.url.searchParams.get('q'))))).toBe(true);
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', phone: '+49301234567', city: 'Berlin', postal_code: '10115', date_of_birth: '1985-05-05', source: 'Web', dnd: 0 });
    expect(JSON.parse(anna.custom)).toMatchObject({ kundennummer: 'K-1', interesse: 'SEO' });
    expect(h.email('konrad@example.com')).toBeUndefined();
    expect(h.count('contacts')).toBe(4);
    const lea = h.email('lea@example.com');
    expect(lea).toMatchObject({ company: 'Lead GmbH', city: 'Köln', website: 'https://lead.example.com' });
    expect(h.tags('lea@example.com').sort()).toEqual(['Lead-Status: Open - Not Contacted', 'Salesforce: Lead']);
    expect(h.tags('cleo@example.com')).toContain('Salesforce: Nicht anrufen');
    expect(h.count('companies')).toBe(2); // the accounts only – a lead's company stays the text in its "Firma" field
  });

  it('records no advertising consent: opt-out → do not disturb, everybody else "declined"', () => {
    expect(h.email('ben@example.com').dnd).toBe(1);
    expect(h.tags('ben@example.com')).toContain('Salesforce: abgemeldet');
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'revoked' }]);
    expect(h.ledger('anna@example.com')).toMatchObject([{ action: 'declined', source_label: 'Umzug aus Salesforce' }]);
    expect(h.ledger('anna@example.com')[0].note).toContain('nur ein Opt-out');
    const row = h.email('anna@example.com');
    expect(h.t.app.services.consent.allowMarketing(h.loc(), { id: row.id, dnd: row.dnd }, 'email').allow).toBe(false);
    expect(row.dnd).toBe(0);
  });

  it('imports opportunities as deals in a pipeline with the org\'s stages (and the retired one)', () => {
    const pipe = h.one("SELECT * FROM pipelines WHERE location_id = ? AND name = 'Salesforce'");
    expect(pipe.name).toBe('Salesforce');
    const stages = JSON.parse(pipe.stages);
    expect(stages.map((s: any) => s.name)).toEqual(['Prospecting', 'Negotiation', 'Closed Won', 'Closed Lost', 'Alte Phase']);
    expect(stages[1].probability).toBe(60);
    const deals = h.q('SELECT name, value, status, stage_id, contact_id FROM opportunities WHERE location_id = ? ORDER BY name');
    expect(deals.map((d) => d.name)).toEqual(['Gewonnener Deal', 'Website']);
    const website = deals.find((d) => d.name === 'Website')!;
    expect(website).toMatchObject({ value: 4500, status: 'open', contact_id: h.email('anna@example.com').id });
    expect(stages.find((s: any) => s.id === website.stage_id).name).toBe('Negotiation');
    const won = deals.find((d) => d.name === 'Gewonnener Deal')!;
    expect(won).toMatchObject({ value: 12000, status: 'won', contact_id: h.email('anna@example.com').id }); // no role: the account's oldest contact
    expect(h.lines(imported).deals_without_contact.skipped).toBe(1);
  });

  it('imports tasks for contacts, leads and deals', () => {
    const tasks = h.q('SELECT title, done, contact_id FROM tasks WHERE location_id = ? ORDER BY title');
    expect(tasks).toEqual([
      { title: 'Call: Angebot nachfassen', done: 0, contact_id: h.email('anna@example.com').id },
      { title: 'Email: Lead qualifiziert', done: 1, contact_id: h.email('lea@example.com').id },
    ]);
  });
});

describe('Salesforce: re-run, limits, undo', () => {
  it('a re-run creates nothing twice', async () => {
    const before = { c: h.count('contacts'), o: h.count('opportunities'), t: h.count('tasks'), e: h.count('consent_events') };
    const again = await h.run({ source: 'salesforce', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect({ c: h.count('contacts'), o: h.count('opportunities'), t: h.count('tasks'), e: h.count('consent_events') }).toEqual(before);
  });
  it('uses the client-credentials token once per run (not per call)', () => {
    expect(fake.tokenCalls).toBeLessThan(10);
  });
  it('undo removes it all', async () => {
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('companies')).toBe(0);
    expect(h.count('opportunities')).toBe(0);
    expect(h.one("SELECT 1 x FROM pipelines WHERE location_id = ? AND name = 'Salesforce'")).toBeUndefined();
    expect(h.count('tasks')).toBe(0);
  });
  it('a daily API limit stops the job so it can be resumed tomorrow – it is no missing right', async () => {
    const f = new FakeSalesforce();
    f.limitAfter = 2;
    h.t.app.services.umzugFetch = f.fetch;
    await h.fresh('Salesforce Limit');
    expect((await h.t.api.put('/api/umzug/connections/salesforce', creds)).status).toBe(200);
    const job = await h.run({ source: 'salesforce', parts: ['contacts'], mapping: { 'f:Email': 'email' } });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Tageslimit');
    f.limitAfter = 0;
    const resumed = await h.t.api.post(`/api/umzug/jobs/${job.id}/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.data)).toBe(200);
    expect((await h.wait(job.id)).status).toBe('done');
  });
  it('works with an access token alone', async () => {
    const f = new FakeSalesforce();
    h.t.app.services.umzugFetch = f.fetch;
    await h.fresh('Salesforce Token');
    const r = await h.t.api.put('/api/umzug/connections/salesforce', { instance_url: SF_ORG, access_token: SF_TOKEN });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const job = await h.run({ source: 'salesforce', parts: ['companies'] });
    expect(job.status, job.error).toBe('done');
    expect(f.tokenCalls).toBe(0);
    expect(h.count('companies')).toBe(2);
  });
});
