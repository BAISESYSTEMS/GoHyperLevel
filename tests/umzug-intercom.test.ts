import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { intercomBase, intercomConsent } from '../server/services/umzug-intercom.js';
import { FakeIntercom, IC_TOKEN } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeIntercom();
let imported: any;
const ALL = ['contacts', 'companies', 'conversations', 'articles'];
const creds = { access_token: IC_TOKEN, region: 'eu' };

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Intercom');
});
afterAll(() => h.t.close());

describe('Intercom: pure parts', () => {
  it('knows the three regional hosts and nothing else', () => {
    expect(intercomBase('')).toBe('https://api.intercom.io');
    expect(intercomBase('EU')).toBe('https://api.eu.intercom.io');
    expect(intercomBase('au')).toBe('https://api.au.intercom.io');
    expect(() => intercomBase('evil.example.com')).toThrow(/Region/);
  });
  it('maps the e-mail flags', () => {
    expect(intercomConsent({ email: 'a@b.de', role: 'user' })).toMatchObject({ consent: 'ok', proof: [{ basis: 'legacy', method: 'Nutzer in Intercom' }] });
    expect(intercomConsent({ email: 'a@b.de', role: 'lead' }).proof[0].method).toBe('Lead in Intercom');
    expect(intercomConsent({ email: 'a@b.de', unsubscribed_from_emails: true })).toMatchObject({ consent: 'unsubscribed', proof: [{ basis: 'revoked' }] });
    expect(intercomConsent({ email: 'a@b.de', has_hard_bounced: true }).consent).toBe('bounced');
    expect(intercomConsent({ email: 'a@b.de', marked_email_as_spam: true, unsubscribed_from_emails: true }).consent).toBe('complained');
    expect(intercomConsent({ name: 'Ohne Mail' })).toEqual({ consent: 'unknown', proof: [] });
  });
});

describe('Intercom: connect and preview', () => {
  it('refuses a wrong region and token, connects with the EU host', async () => {
    expect((await h.t.api.put('/api/umzug/connections/intercom', { ...creds, region: 'evil.example.com' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/intercom', { ...creds, access_token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/intercom', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'app-abc123', label: 'Muster App' });
    expect(JSON.stringify(r.data)).not.toContain(IC_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'api.eu.intercom.io' && !q.url.search.includes('dG9r'))).toBe(true);
    expect(fake.requests.every((q) => q.headers['intercom-version'] === '2.11')).toBe(true);
  });
  it('counts and lists the custom attributes in use', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'intercom', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('contacts')).toBe(5);
    expect(total('tags')).toBe(2);
    expect(total('companies')).toBe(1);
    expect(total('conversations')).toBe(3);
    expect(total('articles')).toBe(2);
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toEqual(expect.arrayContaining(['ca:plan', 'ca:mrr', 'ca:beta']));
    expect(refs).not.toContain('ca:alt');
    expect(r.data.mapping).toMatchObject({ email: 'email', first_name: 'first_name', phone: 'phone', org_name: 'company', 'ca:plan': 'new:text:Tarif', 'ca:mrr': 'new:number:MRR', 'ca:beta': 'new:checkbox:Beta', external_id: '' });
  });
});

describe('Intercom: import', () => {
  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'intercom', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('messages')).toBe(0);
    expect(h.count('kb_articles')).toBe(0);
  });
  it('imports contacts with attributes, tags, role and company', async () => {
    imported = await h.run({ source: 'intercom', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', city: 'Berlin', country: 'Germany', company: 'Muster GmbH', dnd: 0 });
    expect(JSON.parse(anna.custom)).toMatchObject({ tarif: 'Pro', mrr: 49 });
    expect(h.tags('anna@example.com').sort()).toEqual(['Beta-Tester', 'Kunde']);
    expect(h.tags('cleo@example.com')).toEqual(expect.arrayContaining(['Intercom: Lead', 'Intercom: unzustellbar']));
    expect(h.email('ben@example.com').dnd).toBe(1);
    expect(h.email('dora@example.com').dnd).toBe(1);
    expect(h.tags('dora@example.com')).toContain('Intercom: Spam-Beschwerde');
    expect(h.one("SELECT 1 x FROM companies WHERE location_id = ? AND name = 'Muster GmbH'")).toBeTruthy();
    expect(h.ledger('anna@example.com')).toMatchObject([{ action: 'legacy', source_label: 'Umzug aus Intercom' }]);
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'revoked' }]);
  });
  it('stores conversations as history in the contact\'s thread – received/sent, original time, nothing unread', () => {
    const anna = h.email('anna@example.com');
    const thread = h.one('SELECT * FROM conversations WHERE location_id = ? AND contact_id = ?', anna.id);
    expect(thread.unread).toBe(0);
    const msgs = h.t.app.db.all<any>('SELECT direction, channel, status, subject, body, source, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at', thread.id);
    expect(msgs.map((m) => `${m.direction}:${m.status}`)).toEqual(['in:received', 'out:sent', 'in:received']);
    expect(msgs[0]).toMatchObject({ channel: 'chat', body: 'Hallo, ich habe eine Frage', source: 'Import: Intercom', created_at: '2024-03-01T10:46:40.000Z' });
    expect(msgs[1].body).toBe('Agnes Agent: Gerne – was möchtest du wissen?');
    expect(thread.last_message).toBe('Danke, das hilft.');
    const ben = h.t.app.db.all<any>('SELECT channel, subject, body, direction FROM messages WHERE contact_id = ? ORDER BY created_at', h.email('ben@example.com').id);
    expect(ben[0]).toMatchObject({ channel: 'email', subject: 'Rechnung', body: 'Wo ist die Rechnung?', direction: 'in' });
    expect(ben[1]).toMatchObject({ direction: 'out', body: 'Fin: Die kommt heute per Post.' });
    // the unknown writer becomes a contact
    expect(h.email('neu@example.com')).toBeTruthy();
    expect(h.count('messages')).toBe(6);
  });
  it('turns internal notes into notes on the contact – not into messages', () => {
    const n = h.q("SELECT body FROM notes WHERE location_id = ? AND contact_id = ?", h.email('anna@example.com').id);
    expect(n.map((x) => x.body)).toEqual(['Intercom-Notiz (Agnes Agent): Rabatt prüfen']);
    expect(h.t.app.db.get("SELECT 1 FROM messages WHERE body LIKE '%Rabatt%'")).toBeUndefined();
  });
  it('imports articles as drafts in nested categories', () => {
    expect(h.q('SELECT name FROM kb_categories WHERE location_id = ? ORDER BY name').map((c) => c.name)).toEqual(['Start', 'Start › Konto']);
    const a = h.one("SELECT a.status, a.body, c.name AS cat FROM kb_articles a LEFT JOIN kb_categories c ON c.id = a.category_id WHERE a.location_id = ? AND a.title = 'Konto anlegen'");
    expect(a).toMatchObject({ status: 'draft', cat: 'Start › Konto' });
    expect(a.body).toContain('## Los');
    expect(imported.warnings.join('\n')).toContain('Bilder oder Anhänge liegen noch bei Intercom');
  });
});

describe('Intercom: re-run, undo, limits', () => {
  it('a re-run adds no message or note twice', async () => {
    const before = { m: h.count('messages'), n: h.count('notes'), c: h.count('contacts'), a: h.count('kb_articles') };
    const again = await h.run({ source: 'intercom', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect({ m: h.count('messages'), n: h.count('notes'), c: h.count('contacts'), a: h.count('kb_articles') }).toEqual(before);
  });
  it('undo removes messages, threads, notes, contacts and drafts', async () => {
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('messages')).toBe(0);
    expect(h.count('conversations')).toBe(0);
    expect(h.count('notes')).toBe(0);
    expect(h.count('contacts')).toBe(0);
    expect(h.count('kb_articles')).toBe(0);
    expect(h.count('kb_categories')).toBe(0);
  });
  it('waits until the time X-RateLimit-Reset names when Intercom answers 429', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    let left = 1;
    h.t.app.services.umzugFetch = async (url: any, init: any) => (String(url).includes('/contacts') && left-- > 0 ? new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 9) } }) : fake.fetch(url, init));
    await h.fresh('Intercom 429');
    expect((await h.t.api.put('/api/umzug/connections/intercom', creds)).status).toBe(200);
    const job = await h.run({ source: 'intercom', parts: ['contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(sleeps.some((s) => s >= 8000 && s <= 10_000)).toBe(true);
    h.t.app.services.umzugSleep = async () => undefined;
    h.t.app.services.umzugFetch = fake.fetch;
  });
});
