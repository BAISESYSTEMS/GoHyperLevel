import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FakeKajabi, FakeKeap, FakeKit, FakePipedrive, FakeTeachable, KEAP_KEY, KIT_KEY, KJ_ID, KJ_PASS, PD_KEY, TE_KEY } from './umzug-fakes.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const loc = () => t.api.location;
const q = <T = any>(sql: string, ...p: any[]) => t.app.db.all<T>(sql, loc(), ...p);
const one = <T = any>(sql: string, ...p: any[]) => t.app.db.get<T>(sql, loc(), ...p);
const email = (e: string) => one('SELECT * FROM contacts WHERE location_id = ? AND email = ?', e);
const run = async (body: any) => {
  const r = await t.api.post('/api/umzug/jobs', body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await t.app.services.umzug.idle();
  return (await t.api.get(`/api/umzug/jobs/${r.data.id}`)).data;
};
const freshLocation = async (name: string) => {
  const r = await t.api.post('/api/locations', { name });
  t.api.setLocation(r.data.id);
};
const lines = (job: any) => Object.fromEntries(job.report.map((l: any) => [l.key, l]));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.umzugSleep = async () => undefined;
  t.app.services.umzugPauseMs = 0;
});
afterAll(() => t.close());

describe('Kit (ConvertKit)', () => {
  const fake = new FakeKit();
  beforeAll(async () => {
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Kit');
  });
  it('rejects a wrong key and connects with the right one', async () => {
    expect((await t.api.put('/api/umzug/connections/kit', { api_key: 'nope' })).status).toBe(400);
    expect((await t.api.put('/api/umzug/connections/kit', { api_key: KIT_KEY })).status).toBe(200);
  });
  it('imports subscribers with state, custom fields and tags; forms, sequences and broadcasts as drafts and templates', async () => {
    const job = await run({ source: 'kit', parts: ['contacts', 'forms', 'automations', 'templates'] });
    expect(job.status).toBe('done');
    expect(email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', dnd: 0 });
    expect(JSON.parse(email('anna@example.com').tags)).toEqual(expect.arrayContaining(['Käufer', 'Webinar']));
    expect(JSON.parse(email('ben@example.com').tags).sort()).toEqual(['Kit (ConvertKit): abgemeldet', 'Webinar']);
    expect(email('ben@example.com').dnd).toBe(1);
    expect(JSON.parse(email('cleo@example.com').tags)).toContain('Kit (ConvertKit): unzustellbar');
    expect(JSON.parse(email('dora@example.com').tags)).toContain('Kit (ConvertKit): Spam-Beschwerde');
    const forms = q('SELECT name FROM forms WHERE location_id = ? ORDER BY name');
    expect(forms.map((f) => f.name)).toEqual(['Landing: Webinar (aus Kit (ConvertKit), bitte prüfen)', 'Newsletter-Anmeldung (aus Kit (ConvertKit), bitte prüfen)']);
    const wf = one('SELECT * FROM workflows WHERE location_id = ?');
    expect(wf.status).toBe('draft');
    expect(wf.name).toBe('Sequenz: Willkommen (aus Kit (ConvertKit), bitte prüfen)');
    expect(JSON.parse(wf.steps).some((s: any) => /stellt die API nicht bereit|nicht geliefert/.test(s.body ?? ''))).toBe(true);
    const tpl = one('SELECT * FROM templates WHERE location_id = ?');
    expect(tpl.subject).toBe('Neuigkeiten');
    expect(tpl.body).toContain('{{contact.first_name|}}');
    expect(tpl.body).toContain('%%unsubscribe_url%%');
  });
  it('pages through cursors', async () => {
    const calls = fake.seen('/v4/subscribers');
    expect(calls.length).toBeGreaterThan(0);
    expect(fake.requests.filter((r) => r.headers['x-kit-api-key'] !== 'nope').every((r) => r.headers['x-kit-api-key'] === KIT_KEY)).toBe(true);
  });
});

describe('Kajabi', () => {
  const fake = new FakeKajabi();
  beforeAll(async () => {
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Kajabi');
  });
  it('exchanges client credentials for a token and refuses wrong ones', async () => {
    expect((await t.api.put('/api/umzug/connections/kajabi', { client_id: KJ_ID, client_secret: 'wrong' })).status).toBe(400);
    expect((await t.api.put('/api/umzug/connections/kajabi', { client_id: KJ_ID, client_secret: KJ_PASS })).status).toBe(200);
  });
  it('imports contacts with tags and state, offers as products, products as course shells and purchases as access', async () => {
    const job = await run({ source: 'kajabi', parts: ['contacts', 'products', 'courses', 'students'] });
    expect(job.status).toBe('done');
    expect(email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', city: 'Berlin', postal_code: '10115', dnd: 0 });
    expect(JSON.parse(email('anna@example.com').tags)).toEqual(['Kunde']);
    expect(email('ben@example.com').dnd).toBe(1);
    expect(q('SELECT name, price_cents, recurring FROM products WHERE location_id = ? ORDER BY name')).toEqual([
      { name: 'Kurs Abo', price_cents: 4900, recurring: 'month' },
      { name: 'Kurs einmalig', price_cents: 29700, recurring: null },
    ]);
    const courses = q('SELECT title, status, description FROM courses WHERE location_id = ?');
    expect(courses).toEqual([{ title: 'Mein Kurs', status: 'draft', description: 'Alles drin' }]);
    // the podcast is not a course; the purchase that was deactivated gives no access
    expect(q('SELECT COUNT(*) n FROM course_enrollments WHERE location_id = ?')[0].n).toBe(1);
    expect(job.warnings.join('\n')).toContain('Lektionen');
    expect(job.warnings.join('\n')).toContain('Podcast');
  });
  it('asks for a token once per connection and reuses it for every call', () => {
    expect(fake.tokenCalls).toBeLessThanOrEqual(4);
    expect(fake.requests.filter((r) => r.path !== '/v1/oauth/token').length).toBeGreaterThan(8);
  });
});

describe('Teachable', () => {
  const fake = new FakeTeachable();
  beforeAll(async () => {
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Teachable');
  });
  it('connects with the apiKey header', async () => {
    expect((await t.api.put('/api/umzug/connections/teachable', { api_key: 'wrong' })).status).toBe(400);
    const r = await t.api.put('/api/umzug/connections/teachable', { api_key: TE_KEY, school: 'https://fotoschule.teachable.com/' });
    expect(r.status).toBe(200);
    expect(r.data.account).toBe('fotoschule.teachable.com');
  });
  it('imports students, courses with sections and lessons, plans and enrolments with progress', async () => {
    const job = await run({ source: 'teachable', parts: ['contacts', 'courses', 'products', 'students'] });
    expect(job.status).toBe('done');
    expect(q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n).toBe(3);
    expect(email('cleo@example.com').first_name).toBe('Cleo');
    const course = one('SELECT * FROM courses WHERE location_id = ?');
    expect(course).toMatchObject({ title: 'Fotografie Grundlagen', status: 'draft', cover_image: 'https://cdn.example.com/f.png' });
    const mods = q('SELECT id, title FROM course_modules WHERE course_id = ? ORDER BY position', ...[]) as any[];
    void mods;
    const modules = t.app.db.all<any>('SELECT id, title FROM course_modules WHERE course_id = ? ORDER BY position', course.id);
    expect(modules.map((m) => m.title)).toEqual(['Start', 'Praxis']);
    const lessons = t.app.db.all<any>('SELECT title, video_url, body, published FROM course_lessons WHERE course_id = ? ORDER BY module_id, position', course.id);
    const welcome = lessons.find((l) => l.title === 'Willkommen');
    expect(welcome.video_url).toBe('https://videos.example.com/intro.mp4');
    expect(welcome.body).toContain('## Hallo');
    expect(welcome.body).toContain('**geht**');
    expect(lessons.find((l) => l.title === 'Material').body).toContain('[Checkliste](https://files.example.com/check.pdf)');
    expect(lessons.find((l) => l.title === 'Material').body).toContain('Quiz');
    expect(lessons.find((l) => l.title === 'Entwurf').published).toBe(0);
    expect(lessons.find((l) => l.title === 'Blende').body).toContain('Link bitte ergänzen');
    // plans
    expect(q('SELECT name, price_cents, recurring FROM products WHERE location_id = ? ORDER BY name')).toEqual([
      { name: 'Einmalzahlung', price_cents: 19900, recurring: null },
      { name: 'Monatlich', price_cents: 2900, recurring: 'month' },
      { name: 'Raten', price_cents: 6900, recurring: null },
    ]);
    // enrolments: finished course = all lessons done, 50 % = the first half
    const anna = one('SELECT e.id FROM course_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.location_id = ? AND c.email = ?', 'anna@example.com');
    const ben = one('SELECT e.id FROM course_enrollments e JOIN contacts c ON c.id = e.contact_id WHERE e.location_id = ? AND c.email = ?', 'ben@example.com');
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM course_progress WHERE enrollment_id = ?', anna.id)!.n).toBe(4);
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM course_progress WHERE enrollment_id = ?', ben.id)!.n).toBe(2);
    expect(job.warnings.join('\n')).toContain('Näherung');
    // imported access starts no events and sends no welcome mail
    expect(q(`SELECT COUNT(*) n FROM messages WHERE location_id = ?`)[0].n).toBe(0);
  });
});

describe('Keap', () => {
  const fake = new FakeKeap();
  beforeAll(async () => {
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Keap');
  });
  it('connects with a service account key', async () => {
    expect((await t.api.put('/api/umzug/connections/keap', { api_key: 'wrong' })).status).toBe(400);
    expect((await t.api.put('/api/umzug/connections/keap', { api_key: KEAP_KEY })).status).toBe(200);
  });
  it('imports contacts, tags, companies, opportunities, notes, tasks and products', async () => {
    const job = await run({ source: 'keap', parts: ['contacts', 'companies', 'deals', 'notes', 'tasks', 'products'] });
    expect(job.status).toBe('done');
    expect(email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', phone: '+4930111', address: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', website: 'https://muster.de', date_of_birth: '1980-05-17', company: 'Muster GmbH', dnd: 0 });
    expect(JSON.parse(email('anna@example.com').custom)).toMatchObject({ budget: 1500, interesse: 'SEO' });
    expect(JSON.parse(email('anna@example.com').tags)).toEqual(expect.arrayContaining(['Kunde', 'Messe']));
    expect(email('ben@example.com').dnd).toBe(1);
    // a contact without e-mail but with a phone number is kept
    expect(one('SELECT * FROM contacts WHERE location_id = ? AND phone = ?', '+491715551234')).toMatchObject({ first_name: 'Cleo', dnd: 1 });
    expect(one('SELECT name FROM companies WHERE location_id = ?').name).toBe('Muster GmbH');
    const pipe = one(`SELECT p.* FROM pipelines p JOIN umzug_ids i ON i.local_id = p.id AND i.kind = 'pipeline' WHERE p.location_id = ?`);
    expect(JSON.parse(pipe.stages).map((s: any) => [s.name, s.probability])).toEqual([['Neu', 10], ['Angebot', 50], ['Gewonnen', 100]]);
    expect(q('SELECT name, value, status FROM opportunities WHERE location_id = ? ORDER BY name')).toEqual([
      { name: 'Beratung', value: 900, status: 'open' },
      { name: 'Website', value: 4500, status: 'won' },
    ]);
    expect(q('SELECT body FROM notes WHERE location_id = ?').map((n) => n.body)).toEqual(['Telefonat\nInteresse an SEO']);
    expect(q('SELECT title, done FROM tasks WHERE location_id = ? ORDER BY title')).toEqual([
      { title: 'Call: Angebot schicken', done: 0 },
      { title: 'Other: Rechnung prüfen', done: 1 },
    ]);
    expect(q('SELECT name, price_cents, recurring FROM products WHERE location_id = ? ORDER BY name')).toEqual([
      { name: 'Beratung 1h', price_cents: 14900, recurring: null },
      { name: 'Wartung', price_cents: 4950, recurring: 'month' },
    ]);
  });
  it('does not follow the next links of responses', () => {
    expect(fake.requests.every((r) => r.url.hostname === 'api.infusionsoft.com')).toBe(true);
  });
});

describe('Pipedrive', () => {
  const fake = new FakePipedrive();
  beforeAll(async () => {
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Pipedrive');
  });
  it('connects with the token in a header, never in the URL', async () => {
    expect((await t.api.put('/api/umzug/connections/pipedrive', { api_token: 'wrong' })).status).toBe(400);
    const r = await t.api.put('/api/umzug/connections/pipedrive', { api_token: PD_KEY, company: 'muster' });
    expect(r.status).toBe(200);
    expect(r.data.account).toBe('muster');
    expect((await t.api.put('/api/umzug/connections/pipedrive', { api_token: PD_KEY, company: 'x.evil.com/' })).status).toBe(400);
  });
  it('imports persons with custom fields, organisations, pipelines, deals, activities and notes', async () => {
    const preview = await t.api.post('/api/umzug/preview', { source: 'pipedrive' });
    expect(preview.data.mapping['f:8f3c1a9d0e5b7c2a4d6f8e1b3a5c7d9e0f2a4b6c']).toBe('new:number:Budget');
    expect(preview.data.mapping.label).toBe('tag');
    const job = await run({ source: 'pipedrive', parts: ['contacts', 'companies', 'deals', 'tasks', 'notes'] });
    expect(job.status).toBe('done');
    const anna = email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', phone: '+49 30 111'.replace(/ /g, '').replace('+4930', '+4930'), company: 'Muster GmbH', dnd: 0 });
    expect(JSON.parse(anna.tags)).toEqual(['Kunde']);
    expect(JSON.parse(anna.custom)).toMatchObject({ budget: 2500, interesse: 'SEO' });
    expect(email('ben@example.com').dnd).toBe(1);
    // "no_consent" is the default of a CRM contact: no DND
    expect(one('SELECT * FROM contacts WHERE location_id = ? AND first_name = ?', 'Nur')).toMatchObject({ dnd: 0 });
    expect(one('SELECT name FROM companies WHERE location_id = ?').name).toBe('Muster GmbH');
    const pipe = one(`SELECT p.* FROM pipelines p JOIN umzug_ids i ON i.local_id = p.id AND i.kind = 'pipeline' WHERE p.location_id = ?`);
    expect(JSON.parse(pipe.stages).map((s: any) => [s.name, s.probability])).toEqual([['Neu', 20], ['Angebot', 60]]);
    // a deal whose person was not imported creates that person from the deal's data
    expect(q('SELECT name, status, value FROM opportunities WHERE location_id = ? ORDER BY name')).toEqual([
      { name: 'Neu-Deal', status: 'open', value: 100 },
      { name: 'Website', status: 'won', value: 4500 },
    ]);
    expect(email('fremd@example.com')).toBeTruthy();
    expect(q('SELECT title, done, due_at, contact_id FROM tasks WHERE location_id = ? ORDER BY title').map((x) => [x.title, x.done, !!x.contact_id])).toEqual([
      ['Call: Rückruf', 0, true],
      ['Meeting: Kick-off', 1, true],
    ]);
    expect(q('SELECT body FROM notes WHERE location_id = ?').map((n) => n.body)).toEqual(['Gespräch gut']);
  });
  it('sends the token only as a header', () => {
    for (const r of fake.requests.filter((x) => x.headers['x-api-token'] !== 'wrong')) {
      expect(r.url.searchParams.has('api_token')).toBe(false);
      expect(r.headers['x-api-token']).toBe(PD_KEY);
    }
  });
});

describe('rate limits and errors', () => {
  it('waits out 429 with Retry-After and goes on', async () => {
    const fake = new FakeKit();
    fake.throttle.set('/v4/subscribers', 2);
    t.app.services.umzugFetch = fake.fetch;
    const waits: number[] = [];
    t.app.services.umzugSleep = async (ms: number) => void waits.push(ms);
    await freshLocation('Limit');
    await t.api.put('/api/umzug/connections/kit', { api_key: KIT_KEY });
    const job = await run({ source: 'kit', parts: ['contacts'] });
    expect(job.status).toBe('done');
    expect(waits.filter((w) => w === 2000).length).toBe(2);
    expect(q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n).toBe(4);
    t.app.services.umzugSleep = async () => undefined;
  });
  it('a failing vendor pauses the job at its resume point and "Fortsetzen" continues', async () => {
    const fake = new FakeKit();
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Resume');
    await t.api.put('/api/umzug/connections/kit', { api_key: KIT_KEY });
    fake.fail.set('/v4/tags/12/subscribers', 502);
    const job = await run({ source: 'kit', parts: ['contacts'] });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Kit antwortet mit Fehler 502');
    expect(q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n).toBe(4);
    fake.fail.clear();
    const r = await t.api.post(`/api/umzug/jobs/${job.id}/resume`, {});
    expect(r.status).toBe(200);
    await t.app.services.umzug.idle();
    const done = (await t.api.get(`/api/umzug/jobs/${job.id}`)).data;
    expect(done.status).toBe('done');
    expect(q('SELECT COUNT(*) n FROM contacts WHERE location_id = ?')[0].n).toBe(4);
    expect(JSON.parse(email('ben@example.com').tags)).toContain('Webinar');
  });
  it('wrong credentials stop the job as failed (not paused)', async () => {
    const fake = new FakeKit();
    t.app.services.umzugFetch = fake.fetch;
    await freshLocation('Auth');
    await t.api.put('/api/umzug/connections/kit', { api_key: KIT_KEY });
    // The key is revoked while the job runs: it stops as failed (resumable), it is not mistaken for a pause.
    fake.fail.set('/v4/subscribers', 401);
    const job = await run({ source: 'kit', parts: ['contacts'], mapping: { email_address: 'email', first_name: 'first_name' } });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('Zugangsdaten ungültig');
    // … and a new job is refused up front while the key is wrong
    const again = await t.api.post('/api/umzug/jobs', { source: 'kit', parts: ['contacts'] });
    expect(again.status).toBe(400);
  });
});
