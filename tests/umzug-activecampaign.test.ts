import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { AC_KEY, AC_URL, FakeActiveCampaign } from './umzug-fakes.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const fake = new FakeActiveCampaign();
const run = async (path: string, body: any) => {
  const r = await t.api.post(path, body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await t.app.services.umzug.idle();
  return (await t.api.get(`/api/umzug/jobs/${r.data.id}`)).data;
};
const byEmail = (email: string) => t.app.db.get<any>('SELECT * FROM contacts WHERE location_id = ? AND email = ?', t.api.location, email);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.umzugFetch = fake.fetch;
  t.app.services.umzugSleep = async () => undefined;
  t.app.services.umzugPauseMs = 0;
});
afterAll(() => t.close());

describe('ActiveCampaign import', () => {
  it('refuses foreign hosts and bad keys, accepts the account', async () => {
    expect((await t.api.put('/api/umzug/connections/activecampaign', { url: 'https://evil.example.com', api_key: AC_KEY })).status).toBe(400);
    expect((await t.api.put('/api/umzug/connections/activecampaign', { url: AC_URL, api_key: 'wrong' })).status).toBe(400);
    expect(fake.requests.every((r) => r.url.hostname === 'muster.api-us1.com')).toBe(true);
    const ok = await t.api.put('/api/umzug/connections/activecampaign', { url: AC_URL, api_key: AC_KEY });
    expect(ok.status).toBe(200);
    expect(ok.data.account).toBe('muster');
  });

  it('imports contacts, lists as tags, fields, companies, deals and notes', async () => {
    const job = await run('/api/umzug/jobs', { source: 'activecampaign', parts: ['contacts', 'companies', 'deals', 'notes'] });
    expect(job.status).toBe('done');
    const anna = byEmail('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', dnd: 0 });
    expect(JSON.parse(anna.tags)).toEqual(expect.arrayContaining(['Kunde', 'Liste: Hauptliste', 'Abgemeldet von: Aktionen']));
    expect(JSON.parse(anna.custom)).toMatchObject({ budget: '5000', branche: 'it' });
    expect(byEmail('cleo@example.com').dnd).toBe(1);
    expect(JSON.parse(byEmail('cleo@example.com').tags)).toContain('ActiveCampaign: abgemeldet');
    // company and link
    const co = t.app.db.get<any>('SELECT * FROM companies WHERE location_id = ?', t.api.location);
    expect(co.name).toBe('Muster GmbH');
    expect(t.app.db.get<any>(`SELECT COUNT(*) n FROM associations WHERE location_id = ?`, t.api.location)!.n).toBeGreaterThan(0);
    // pipeline stages in order, deals in euros with status
    const pipe = t.app.db.get<any>(`SELECT p.* FROM pipelines p JOIN umzug_ids i ON i.local_id = p.id AND i.kind = 'pipeline' WHERE p.location_id = ?`, t.api.location);
    expect(JSON.parse(pipe.stages).map((s: any) => s.name)).toEqual(['Neu', 'Angebot', 'Gewonnen']);
    const deals = t.app.db.all<any>('SELECT name, value, status FROM opportunities WHERE location_id = ? ORDER BY name', t.api.location);
    expect(deals).toEqual([
      { name: 'SEO', value: 900, status: 'open' },
      { name: 'Website', value: 4500, status: 'won' },
    ]);
    expect(job.report.find((l: any) => l.key === 'deals_without_contact').skipped).toBe(1);
    // notes on contact and deal
    const notes = t.app.db.all<any>('SELECT body FROM notes WHERE location_id = ? ORDER BY created_at', t.api.location);
    expect(notes.map((n) => n.body)).toEqual(['Erstes Gespräch', 'Deal-Notiz']);
  });

  it('never sends the key anywhere but the validated host, and not in the URL', () => {
    for (const r of fake.requests) {
      expect(r.url.toString()).not.toContain(AC_KEY);
      expect(r.url.protocol).toBe('https:');
    }
  });

  it('falls back to per-contact calls without sideloaded data', async () => {
    fake.noSideload = true;
    fake.requests = [];
    const job = await run('/api/umzug/jobs', { source: 'activecampaign', parts: ['contacts'] });
    expect(job.status).toBe('done');
    expect(fake.seen('/api/3/contacts/10/contactTags').length).toBe(1);
    expect(JSON.parse(byEmail('ben@example.com').tags)).toContain('Newsletter');
    fake.noSideload = false;
  });

  it('automations become labelled drafts: common steps mapped, the rest kept as notes', async () => {
    const job = await run('/api/umzug/jobs', { source: 'activecampaign', parts: ['automations'] });
    expect(job.status).toBe('done');
    const wf = t.app.db.all<any>('SELECT * FROM workflows WHERE location_id = ? ORDER BY name', t.api.location);
    expect(wf).toHaveLength(2);
    expect(wf.every((w) => w.status === 'draft')).toBe(true);
    expect(wf[0].name).toBe('Ohne Details (aus ActiveCampaign, bitte prüfen)');
    expect(wf[1].name).toContain('bitte prüfen');
    const w = wf[1];
    expect(JSON.parse(w.trigger)).toEqual({ type: 'contact.created', config: {} });
    const steps = JSON.parse(w.steps);
    expect(steps[0].type).toBe('add_note');
    expect(steps[0].body).toContain('BITTE PRÜFEN');
    expect(steps.map((s: any) => s.type)).toEqual(['add_note', 'wait', 'send_email', 'add_tag', 'add_note', 'send_sms', 'add_note']);
    expect(steps[2].subject).toBe('Willkommen {{contact.first_name|}}!');
    expect(steps[3].tags).toEqual(['Newsletter']);
    expect(steps[4].body).toContain('Verzweigung');
    expect(steps[6].body).toContain('machine learning');
    expect(job.warnings.join('\n')).toContain('Verzweigung');
  });
});
