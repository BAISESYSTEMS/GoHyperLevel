import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brevoConsent } from '../server/services/umzug-brevo.js';
import { BREVO_KEY, FakeBrevo } from './umzug2-fakes.js';
import { json } from './umzug-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeBrevo();
let imported: any;
const ALL = ['contacts', 'segments', 'templates'];

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Brevo');
});
afterAll(() => h.t.close());

describe('Brevo: consent mapping (pure)', () => {
  it('reads the blocklist, the SMS blocklist and the double opt-in attribute', () => {
    expect(brevoConsent({ email: 'a@b.de', createdAt: '2024-01-05T10:00:00Z', attributes: { 'DOUBLE_OPT-IN': 'Yes' } })).toMatchObject({ consent: 'ok', proof: [{ basis: 'confirmed' }] });
    expect(brevoConsent({ email: 'a@b.de', attributes: { 'DOUBLE_OPT-IN': 1 } }).proof[0].basis).toBe('confirmed');
    expect(brevoConsent({ email: 'a@b.de', attributes: { 'DOUBLE_OPT-IN': 'No' } }).proof[0].basis).toBe('legacy');
    expect(brevoConsent({ email: 'a@b.de', attributes: {} }).proof[0].basis).toBe('legacy');
    expect(brevoConsent({ email: 'a@b.de', emailBlacklisted: true })).toMatchObject({ consent: 'blocked', proof: [{ basis: 'revoked' }] });
    expect(brevoConsent({ email: 'a@b.de', smsBlacklisted: true }).proof.map((p) => `${p.channel ?? 'email'}:${p.basis}`)).toEqual(['email:legacy', 'sms:revoked']);
    expect(brevoConsent({ attributes: { SMS: '+49151' } })).toMatchObject({ consent: 'unknown', proof: [] });
  });
});

describe('Brevo: connect and preview', () => {
  it('refuses a wrong key, connects with the right one and keeps the e-mail out of the account id', async () => {
    expect((await h.t.api.put('/api/umzug/connections/brevo', { api_key: 'xkeysib-nope' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/brevo', { api_key: BREVO_KEY });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.label).toBe('Muster GmbH');
    expect(r.data.account).toMatch(/^acct-[0-9a-f]{12}$/);
    expect(JSON.stringify(r.data)).not.toContain(BREVO_KEY);
    expect(JSON.stringify(r.data)).not.toContain('chef@example.com');
  });
  it('sends the key in the api-key header to api.brevo.com only', () => {
    const real = fake.requests.filter((r) => r.headers['api-key'] === BREVO_KEY);
    expect(real.length).toBeGreaterThan(0);
    expect(fake.requests.every((r) => r.url.hostname === 'api.brevo.com' && !r.url.search.includes('xkeysib'))).toBe(true);
  });
  it('counts, lists the usable attributes (not calculated or transactional ones) and maps the standard ones', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'brevo', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (key: string) => r.data.counts.find((c: any) => c.key === key)?.total;
    expect(total('contacts')).toBe(5);
    expect(total('lists')).toBe(2);
    expect(total('segments')).toBe(1);
    expect(total('templates')).toBe(3);
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toContain('a:ANZAHL_KAEUFE');
    expect(refs).not.toContain('a:GEWICHTET');
    expect(refs).not.toContain('a:ORDER_ID');
    expect(refs).not.toContain('a:OPT_IN_ID');
    expect(r.data.mapping).toMatchObject({ email: 'email', 'a:FIRSTNAME': 'first_name', 'a:LASTNAME': 'last_name', 'a:SMS': 'phone', 'a:COMPANY': 'company', 'a:GEBURTSTAG': 'date_of_birth', 'a:ANZAHL_KAEUFE': 'new:number:ANZAHL_KAEUFE', 'a:GESCHLECHT': 'new:select:GESCHLECHT', 'a:DOUBLE_OPT-IN': '' });
  });
});

describe('Brevo: import', () => {
  it('imports contacts with attributes, category labels and list tags', async () => {
    const dry = await h.run({ source: 'brevo', parts: ALL }, 'dry-run');
    expect(dry.status, dry.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
    imported = await h.run({ source: 'brevo', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', phone: '+4915112345678', date_of_birth: '1985-05-17', dnd: 0 });
    expect(JSON.parse(anna.custom)).toMatchObject({ anzahl_kaeufe: 3, geschlecht: 'Weiblich' });
    expect(h.tags('anna@example.com').sort()).toEqual(['Liste: Kunden', 'Liste: Newsletter', 'Segment: Aktive']);
    expect(h.tags('cleo@example.com').sort()).toEqual(['Abgemeldet von Liste: Kunden', 'Liste: Newsletter']);
    expect(h.count('contacts')).toBe(5);
  });
  it('treats the blocklist as do-not-disturb with a tag', () => {
    expect(h.email('ben@example.com').dnd).toBe(1);
    expect(h.tags('ben@example.com')).toContain('Brevo: gesperrt');
    expect(h.email('cleo@example.com').dnd).toBe(0);
    expect(h.email('dora@example.com').dnd).toBe(0); // only the SMS blocklist
  });
  it('writes ledger lines: confirmed for a double opt-in, legacy for the rest, revoked for blocklists (also SMS only)', () => {
    const anna = h.ledger('anna@example.com');
    expect(anna).toMatchObject([{ channel: 'email', action: 'granted', purpose: 'newsletter', source_label: 'Umzug aus Brevo' }]);
    expect(anna[0].note).toContain('DOUBLE_OPT-IN');
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'revoked' }]);
    expect(h.ledger('ben@example.com')[0].note).toContain('Sperrliste');
    expect(h.ledger('cleo@example.com')).toMatchObject([{ action: 'legacy' }]);
    expect(h.ledger('dora@example.com').map((e) => `${e.channel}:${e.action}`)).toEqual(expect.arrayContaining(['email:legacy', 'sms:revoked']));
    const c = h.t.app.services.consent;
    const gate = (e: string, ch = 'email') => c.allowMarketing(h.loc(), { id: h.email(e).id, dnd: h.email(e).dnd }, ch);
    expect(gate('anna@example.com')).toMatchObject({ allow: true, basis: 'confirmed' });
    expect(gate('cleo@example.com')).toMatchObject({ allow: true, basis: 'legacy' });
    expect(gate('ben@example.com').allow).toBe(false);
    expect(gate('dora@example.com', 'sms').allow).toBe(false);
  });
  it('brings the segment as tag and smart list, templates with converted tags', () => {
    expect(h.one('SELECT name FROM smart_lists WHERE location_id = ?').name).toBe('Aktive');
    const t = h.one("SELECT subject, body FROM templates WHERE location_id = ? AND name = 'Willkommen'");
    expect(t.subject).toBe('Hallo {{contact.first_name|}}');
    expect(t.body).toContain('Hallo {{contact.first_name|}} aus {{ contact.CITY }}');
    expect(t.body).toContain('%%unsubscribe_url%%');
    expect(h.one("SELECT body FROM templates WHERE location_id = ? AND name = 'Schlicht'").body).toContain('{{contact.email}}');
    const w = imported.warnings.join('\n');
    expect(w).toContain('Segment „Aktive“ ist bei Brevo eine Regel');
    expect(w).toContain('keinen HTML-Inhalt');
    expect(w).toContain('{{ contact.CITY }}');
  });
});

describe('Brevo: paging', () => {
  it('pages with limit and offset', () => {
    const calls = fake.seen('/v3/contacts').filter((c) => c.path === '/v3/contacts');
    expect(calls.some((c) => Number(c.url.searchParams.get('offset')) > 0)).toBe(true);
    expect(calls.every((c) => Number(c.url.searchParams.get('limit')) <= 1000)).toBe(true);
  });
});

describe('Brevo: re-run, rate limit, undo', () => {
  it('a re-run changes nothing', async () => {
    const before = { c: h.count('contacts'), e: h.count('consent_events'), t: h.count('templates'), s: h.count('smart_lists') };
    const again = await h.run({ source: 'brevo', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect({ c: h.count('contacts'), e: h.count('consent_events'), t: h.count('templates'), s: h.count('smart_lists') }).toEqual(before);
  });
  it('undo removes everything the import made, ledger included', async () => {
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
    expect(h.count('templates')).toBe(0);
    expect(h.count('smart_lists')).toBe(0);
  });
  it('waits as long as x-sib-ratelimit-reset says when there is no Retry-After', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    let left = 2;
    h.t.app.services.umzugFetch = async (url: any, init: any) => (left-- > 0 ? json(429, { code: 'too_many_requests', message: 'slow down' }, { 'x-sib-ratelimit-reset': '7' }) : fake.fetch(url, init));
    await h.fresh('Brevo 429');
    expect((await h.t.api.put('/api/umzug/connections/brevo', { api_key: BREVO_KEY })).status).toBe(200);
    const job = await h.run({ source: 'brevo', parts: ['contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(sleeps.filter((s) => s === 7000).length).toBe(2);
    h.t.app.services.umzugSleep = async () => undefined;
    h.t.app.services.umzugFetch = fake.fetch;
  });
});
