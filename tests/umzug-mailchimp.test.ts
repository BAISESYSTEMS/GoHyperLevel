import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FakeMailchimp, MC_KEY } from './umzug-fakes.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const fake = new FakeMailchimp();

const wait = async () => {
  await t.app.services.umzug.idle();
};
const contacts = () => t.app.db.all<any>('SELECT * FROM contacts WHERE location_id = ? ORDER BY email', t.api.location);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.umzugFetch = fake.fetch;
  t.app.services.umzugSleep = async () => undefined;
  t.app.services.umzugPauseMs = 0;
});
afterAll(() => t.close());

describe('Mailchimp import', () => {
  it('connects, seals the key and never returns it', async () => {
    const bad = await t.api.put('/api/umzug/connections/mailchimp', { api_key: 'nope-us12' });
    expect(bad.status).toBe(400);
    const r = await t.api.put('/api/umzug/connections/mailchimp', { api_key: MC_KEY });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ connected: true, label: 'Muster Newsletter', hint: '…8a13' });
    expect(JSON.stringify(r.data)).not.toContain(MC_KEY);
    const row = t.app.db.get<any>('SELECT * FROM umzug_connections WHERE location_id = ?', t.api.location);
    expect(row.secret_sealed).toMatch(/^v[12]:/);
    expect(row.secret_sealed).not.toContain(MC_KEY);
    const all = JSON.stringify((await t.api.get('/api/umzug')).data);
    expect(all).not.toContain(MC_KEY);
    expect(all).not.toContain(row.secret_sealed);
  });

  it('previews counts, fields and an automatic mapping', async () => {
    const r = await t.api.post('/api/umzug/preview', { source: 'mailchimp', parts: ['contacts', 'segments', 'templates', 'campaigns'] });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.data.counts.map((c: any) => [c.key, c.total]));
    expect(by).toMatchObject({ lists: 2, members: 6, segments: 3, templates: 2, campaigns: 2 });
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toEqual(expect.arrayContaining(['member:email', 'merge:FNAME', 'merge:LNAME', 'merge:ADDRESS.city', 'merge:PHONE', 'merge:FARBE']));
    expect(r.data.mapping['member:email']).toBe('email');
    expect(r.data.mapping['merge:FNAME']).toBe('first_name');
    expect(r.data.mapping['merge:ADDRESS.zip']).toBe('postal_code');
    expect(r.data.mapping['merge:FARBE']).toBe('new:select:Lieblingsfarbe');
  });

  it('dry run counts but writes nothing', async () => {
    const r = await t.api.post('/api/umzug/dry-run', { source: 'mailchimp', parts: ['contacts', 'segments', 'templates'] });
    expect(r.status).toBe(200);
    await wait();
    const job = (await t.api.get(`/api/umzug/jobs/${r.data.id}`)).data;
    expect(job.status).toBe('done');
    expect(job.kind).toBe('dry_run');
    const lines = Object.fromEntries(job.report.map((l: any) => [l.key, l]));
    expect(lines.contacts.created).toBe(5);
    expect(lines.templates.created).toBe(2);
    expect(contacts()).toHaveLength(0);
    expect(t.app.db.get('SELECT COUNT(*) n FROM umzug_ids')!.n).toBe(0);
  });

  let importJob = '';
  it('imports contacts with tags, status, merge fields, segments and templates', async () => {
    const r = await t.api.post('/api/umzug/jobs', { source: 'mailchimp', parts: ['contacts', 'segments', 'templates'] });
    expect(r.status).toBe(200);
    importJob = r.data.id;
    await wait();
    const job = (await t.api.get(`/api/umzug/jobs/${importJob}`)).data;
    expect(job.status).toBe('done');
    const list = contacts();
    expect(list.map((c) => c.email)).toEqual(['anna@example.com', 'ben@example.com', 'cleo@example.com', 'dirk@example.com', 'emil@example.com']);
    const anna = list[0];
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', phone: '+49301234567', company: 'Muster GmbH', address: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', country: 'DE', dnd: 0 });
    const tags = JSON.parse(anna.tags);
    expect(tags).toEqual(expect.arrayContaining(['Liste: Newsletter', 'Liste: Kunden', 'Kunde', 'VIP']));
    expect(JSON.parse(anna.custom)).toMatchObject({ lieblingsfarbe: 'Blau' });
    // unsubscribed and cleaned → do not disturb, with a tag that says why
    const cleo = list[2];
    expect(cleo.dnd).toBe(1);
    expect(JSON.parse(cleo.tags)).toContain('Mailchimp: abgemeldet');
    const dirk = list[3];
    expect(dirk.dnd).toBe(1);
    expect(JSON.parse(dirk.tags)).toContain('Mailchimp: unzustellbar');
    expect(t.app.db.get<any>(`SELECT COUNT(*) n FROM activities WHERE type = 'umzug.consent'`)!.n).toBe(2);
    // segments: static → tag + smart list; saved → frozen list with a warning
    expect(JSON.parse(list[1].tags)).toContain('Segment: Messe 2023');
    const sl = t.app.db.all<any>('SELECT name, filter FROM smart_lists WHERE location_id = ? ORDER BY name', t.api.location);
    expect(sl.map((s) => s.name)).toEqual(['Aktive Kunden (Newsletter)', 'Messe 2023 (Newsletter)']);
    expect(JSON.parse(sl[1].filter)).toEqual({ tags: ['Segment: Messe 2023'] });
    expect(job.warnings.join('\n')).toContain('Aktive Kunden');
    // templates: merge tags converted, script removed
    const tpl = t.app.db.all<any>('SELECT * FROM templates WHERE location_id = ? ORDER BY name', t.api.location);
    expect(tpl.map((x) => x.name)).toEqual(['Angebot', 'Willkommen']);
    expect(tpl[1].body).toContain('Hallo {{contact.first_name|}}!');
    expect(tpl[1].body).toContain('%%unsubscribe_url%%');
    expect(tpl[1].body).not.toContain('<script');
    expect(job.warnings.join('\n')).toContain('*|WEIRD_TAG|*');
    // custom field created on the fly
    expect(t.app.db.get<any>(`SELECT type FROM custom_fields WHERE location_id = ? AND key = 'lieblingsfarbe'`, t.api.location)?.type).toBe('select');
  });

  it('a second run updates instead of duplicating', async () => {
    const before = contacts().length;
    const r = await t.api.post('/api/umzug/jobs', { source: 'mailchimp', parts: ['contacts', 'segments', 'templates'] });
    await wait();
    const job = (await t.api.get(`/api/umzug/jobs/${r.data.id}`)).data;
    expect(job.status).toBe('done');
    expect(contacts()).toHaveLength(before);
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM templates WHERE location_id = ?', t.api.location)!.n).toBe(2);
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM smart_lists WHERE location_id = ?', t.api.location)!.n).toBe(2);
    const lines = Object.fromEntries(job.report.map((l: any) => [l.key, l]));
    expect(lines.contacts.created).toBe(0);
    expect(lines.contacts.updated).toBe(6);
  });

  it('undo deletes what the first batch created', async () => {
    const r = await t.api.post(`/api/umzug/jobs/${importJob}/undo`, {});
    expect(r.status).toBe(200);
    await wait();
    const job = (await t.api.get(`/api/umzug/jobs/${importJob}`)).data;
    expect(job.status).toBe('undone');
    expect(job.undo.deleted.contacts).toBe(5);
    expect(contacts()).toHaveLength(0);
    expect(t.app.db.get<any>('SELECT COUNT(*) n FROM templates WHERE location_id = ?', t.api.location)!.n).toBe(0);
    expect(t.app.db.get<any>(`SELECT COUNT(*) n FROM custom_fields WHERE key = 'lieblingsfarbe'`)!.n).toBe(0);
  });
});
