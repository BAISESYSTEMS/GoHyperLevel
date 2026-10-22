import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeManyChat, MANYCHAT_KEY } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeManyChat();
let imported: any;

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('ManyChat');
});
afterAll(() => h.t.close());

const upload = async (name: string, body: string) => {
  const r = await h.t.api.raw(`/api/umzug/files?source=manychat&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { cookie: h.t.api.cookie, 'x-pghl': '1', 'x-location-id': h.loc(), 'content-type': 'application/octet-stream' }, body: Buffer.from(body) });
  const j: any = await r.json();
  expect(r.status, JSON.stringify(j)).toBe(200);
  return j;
};

describe('ManyChat: connect and preview', () => {
  it('refuses a wrong token and connects (account = the page)', async () => {
    expect((await h.t.api.put('/api/umzug/connections/manychat', { api_token: '1234:wrong' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/manychat', { api_token: MANYCHAT_KEY });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'page-1234567890123', label: 'Muster Coaching' });
    expect(JSON.stringify(r.data)).not.toContain(MANYCHAT_KEY);
    expect(fake.requests.every((q) => q.url.hostname === 'api.manychat.com' && !q.url.search.includes('9f3a7c'))).toBe(true);
  });
  it('says plainly that the API has no contact list', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'manychat' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const row = (key: string) => r.data.counts.find((c: any) => c.key === key);
    expect(row('tags').total).toBe(3);
    expect(row('flows').total).toBe(2);
    expect(row('fields').total).toBe(2);
    expect(row('subscribers')).toMatchObject({ total: null });
    expect(row('subscribers').error).toContain('Export-Datei');
    expect(r.data.warnings.join(' ')).toContain('nicht über die Schnittstelle auflisten');
  });
});

describe('ManyChat: tags and the reference list (API)', () => {
  it('creates the tags and writes flows, tags and fields as a wiki page – without bot field values', async () => {
    imported = await h.run({ source: 'manychat', parts: ['contacts', 'reference'] });
    expect(imported.status, imported.error).toBe('done');
    expect(h.q('SELECT name FROM tags WHERE location_id = ? ORDER BY name').map((t) => t.name)).toEqual(['Kunde', 'Lead', 'Webinar | Mai']);
    const page = h.one("SELECT body FROM wiki_pages WHERE location_id = ? AND title = 'ManyChat-Konto: Flows, Tags und Felder'");
    expect(page.body).toContain('| Quiz Auswertung | Funnel A | content20240102120000_222222 |');
    expect(page.body).toContain('| Willkommen | – |');
    expect(page.body).toContain('- Webinar / Mai');
    expect(page.body).toContain('| Budget | Zahl |');
    expect(page.body).toContain('- stripe_key (Text)');
    expect(page.body).not.toContain('sk_live_GEHEIM_4711');
    expect(page.body).not.toContain('2025-01-01');
    expect(imported.warnings.join(' ')).toContain('2 Flows');
  });
  it('undo removes tags and page', async () => {
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('tags')).toBe(0);
    expect(h.count('wiki_pages')).toBe(0);
  });
});

describe('ManyChat: contacts from the export file', () => {
  it('takes tags, custom fields and the opt-in columns into the contact and the ledger', async () => {
    await h.fresh('ManyChat Datei');
    const csv = 'ManyChat ID,First Name,Last Name,Email,Phone,Opt-in E-Mail,Opt-in Telefon,Subscribed,Tags,Lieblingsfarbe\n1001,Anna,Alt,anna@example.com,+4915112345678,yes,yes,2024-01-05 10:00:00,"Lead,Kunde",Blau\n1002,Ben,Bau,ben@example.com,,no,,2024-02-05 10:00:00,Lead,\n1003,Cleo,,cleo@example.com,,,,2024-03-05 10:00:00,,';
    const up = await upload('export.csv', csv);
    expect(up.kind).toBe('contacts');
    const job = await h.run({ source: 'manychat', file_ids: [up.id], parts: ['contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(h.email('anna@example.com')).toMatchObject({ first_name: 'Anna', last_name: 'Alt', phone: '+4915112345678' });
    expect(h.tags('anna@example.com').sort()).toEqual(['Kunde', 'Lead']);
    expect(JSON.parse(h.email('anna@example.com').custom)).toMatchObject({ lieblingsfarbe: 'Blau' });
    expect(h.ledger('anna@example.com').map((e) => `${e.channel}:${e.action}`)).toEqual(['email:granted', 'sms:granted']);
    expect(h.ledger('anna@example.com')[0].note).toContain('Opt-in-Spalte');
    expect(h.ledger('ben@example.com')).toMatchObject([{ channel: 'email', action: 'declined' }]);
    expect(h.ledger('cleo@example.com')).toMatchObject([{ channel: 'email', action: 'legacy' }]);
    const gate = (e: string) => h.t.app.services.consent.allowMarketing(h.loc(), { id: h.email(e).id, dnd: h.email(e).dnd }, 'email');
    expect(gate('anna@example.com')).toMatchObject({ allow: true, basis: 'confirmed' });
    expect(gate('ben@example.com').allow).toBe(false);
  });
});
