import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { klaviyoConsent, KLAVIYO_REVISION } from '../server/services/umzug-klaviyo.js';
import { FakeKlaviyo, KLAVIYO_KEY } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeKlaviyo();
let imported: any;
const ALL = ['contacts', 'segments', 'templates', 'reference'];

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Klaviyo');
});
afterAll(() => h.t.close());

describe('Klaviyo: consent mapping (pure)', () => {
  it('maps subscribed, unsubscribed, suppressed and never-subscribed profiles', () => {
    const at = '2024-02-01T09:00:00+00:00';
    const mk = (email: any, sms?: any) => ({ subscriptions: { email: { marketing: email }, ...(sms ? { sms: { marketing: sms } } : {}) } });
    expect(klaviyoConsent(mk({ consent: 'SUBSCRIBED', consent_timestamp: at, method: 'Klaviyo Form', double_optin: true }))).toMatchObject({ consent: 'ok', proof: [{ basis: 'confirmed', at: '2024-02-01T09:00:00.000Z' }] });
    expect(klaviyoConsent(mk({ consent: 'SUBSCRIBED', consent_timestamp: at, method: 'API' })).proof).toMatchObject([{ basis: 'legacy' }]);
    expect(klaviyoConsent(mk({ consent: 'SUBSCRIBED', consent_timestamp: at, method: 'Checkout' })).proof).toMatchObject([{ basis: 'confirmed' }]);
    expect(klaviyoConsent(mk({ consent: 'UNSUBSCRIBED', consent_timestamp: at }))).toMatchObject({ consent: 'unsubscribed', proof: [{ basis: 'revoked' }] });
    expect(klaviyoConsent(mk({ consent: 'SUBSCRIBED', suppression: [{ reason: 'SPAM_COMPLAINT', timestamp: at }] }))).toMatchObject({ consent: 'complained', proof: [{ basis: 'revoked', reason: 'Spam-Beschwerde' }] });
    expect(klaviyoConsent(mk({ consent: 'SUBSCRIBED', suppression: [{ reason: 'HARD_BOUNCE', timestamp: at }] })).consent).toBe('bounced');
    expect(klaviyoConsent(mk({ consent: 'SUBSCRIBED', suppression: [{ reason: 'USER_SUPPRESSED', timestamp: at }] })).consent).toBe('blocked');
    expect(klaviyoConsent(mk({ consent: 'NEVER_SUBSCRIBED' }))).toMatchObject({ consent: 'unknown', proof: [{ basis: 'none' }] });
    expect(klaviyoConsent({})).toEqual({ consent: 'unknown', native: undefined, proof: [] });
    const both = klaviyoConsent(mk({ consent: 'UNSUBSCRIBED' }, { consent: 'SUBSCRIBED', consent_timestamp: at, method: 'Klaviyo Form' }));
    expect(both.proof.map((p) => `${p.channel ?? 'email'}:${p.basis}`)).toEqual(['email:revoked', 'sms:confirmed']);
  });
});

describe('Klaviyo: connect', () => {
  it('says what is wrong with a public key, a wrong key and accepts the private one', async () => {
    const a = await h.t.api.put('/api/umzug/connections/klaviyo', { api_key: 'AbC123' });
    expect(a.status).toBe(400);
    expect(a.data.error).toContain('pk_');
    expect((await h.t.api.put('/api/umzug/connections/klaviyo', { api_key: 'pk_wrong' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/klaviyo', { api_key: KLAVIYO_KEY });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'abc123', label: 'Muster GmbH' });
    expect(JSON.stringify(r.data)).not.toContain(KLAVIYO_KEY);
  });
  it('sends the key in the Authorization header with the pinned revision, only to a.klaviyo.com', () => {
    const real = fake.requests.filter((r) => r.headers.authorization === `Klaviyo-API-Key ${KLAVIYO_KEY}`);
    expect(real.length).toBeGreaterThan(0);
    expect(real.every((r) => r.headers.revision === KLAVIYO_REVISION)).toBe(true);
    expect(fake.requests.every((r) => r.url.hostname === 'a.klaviyo.com' && !r.url.search.includes('pk_'))).toBe(true);
  });
});

describe('Klaviyo: preview and dry run', () => {
  it('counts, finds the profile properties in use and maps the standard fields', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'klaviyo', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (key: string) => r.data.counts.find((c: any) => c.key === key)?.total;
    expect(total('profiles')).toBe(6);
    expect(total('lists')).toBe(2);
    expect(total('segments')).toBe(1);
    expect(total('templates')).toBe(3);
    expect(total('flows')).toBe(2);
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toEqual(expect.arrayContaining(['p:lieblingsfarbe', 'p:kundennummer', 'p:letzter_kauf']));
    expect(refs).not.toContain('p:$source');
    expect(r.data.mapping).toMatchObject({ email: 'email', phone_number: 'phone', first_name: 'first_name', last_name: 'last_name', organization: 'company', address1: 'address', zip: 'postal_code', 'p:kundennummer': 'new:number:kundennummer', locale: '' });
  });
  it('never follows a link of a response: pages are asked for with the cursor taken out of links.next', () => {
    const profiles = fake.seen('/api/profiles');
    expect(profiles.some((c) => c.url.searchParams.get('page[cursor]'))).toBe(true);
    expect(profiles.every((c) => c.url.searchParams.get('page[size]') === '100')).toBe(true);
  });
  it('a dry run writes nothing but counts ledger lines', async () => {
    const job = await h.run({ source: 'klaviyo', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
    expect(h.count('wiki_pages')).toBe(0);
    expect(h.lines(job).contacts.created).toBe(6);
    expect(h.lines(job).consent_events.created).toBeGreaterThan(5);
  });
});

describe('Klaviyo: import', () => {
  it('imports profiles with address, company, properties and numbers', async () => {
    imported = await h.run({ source: 'klaviyo', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', address: 'Hauptstr. 1', city: 'Berlin', postal_code: '10115', country: 'Germany', phone: '+4930123456', dnd: 0 });
    expect(JSON.parse(anna.custom)).toMatchObject({ lieblingsfarbe: 'Blau', kundennummer: 1042, position: 'Inhaberin' });
    expect(h.tags('anna@example.com').sort()).toEqual(['Liste: Newsletter', 'Liste: VIP', 'Segment: Aktive Käufer']);
    expect(h.count('contacts')).toBe(6);
    // a profile that only has a phone number
    expect(h.one("SELECT * FROM contacts WHERE location_id = ? AND phone = '+4915112345678'")).toMatchObject({ first_name: 'Frida' });
  });

  it('turns suppression and unsubscribes into do-not-disturb with the reason as a tag', () => {
    expect(h.email('cleo@example.com').dnd).toBe(1);
    expect(h.tags('cleo@example.com')).toContain('Klaviyo: abgemeldet');
    expect(h.email('dora@example.com').dnd).toBe(1);
    expect(h.tags('dora@example.com')).toContain('Klaviyo: Spam-Beschwerde');
    expect(h.email('ben@example.com').dnd).toBe(0);
    expect(h.email('emil@example.com').dnd).toBe(0);
  });

  it('writes confirmed lines with date, method and a source note; legacy for API imports; declined for never-subscribed', () => {
    const anna = h.ledger('anna@example.com');
    expect(anna.map((e) => `${e.channel}:${e.action}:${e.purpose}`)).toEqual(['email:granted:newsletter', 'sms:granted:marketing']);
    expect(anna[0]).toMatchObject({ source_kind: 'import', source_label: 'Umzug aus Klaviyo', created_at: '2024-02-01T09:00:00.000Z' });
    expect(anna[0].note).toContain('Einwilligung beim alten Anbieter dokumentiert');
    expect(anna[0].note).toContain('Klaviyo Form – Footer-Formular');
    expect(anna[0].note).toContain('Double-Opt-in bestätigt');
    expect(anna[0].note).toContain('Stand: 01.02.2024');
    expect(h.ledger('ben@example.com')).toMatchObject([{ channel: 'email', action: 'legacy', purpose: '*' }]);
    expect(h.ledger('ben@example.com')[0].note).toContain('ohne eigenen Nachweis');
    expect(h.ledger('cleo@example.com')).toMatchObject([{ action: 'revoked', created_at: '2024-04-01T09:00:00.000Z' }]);
    expect(h.ledger('dora@example.com')[0]).toMatchObject({ action: 'revoked', created_at: '2024-05-05T09:00:00.000Z' });
    expect(h.ledger('dora@example.com')[0].note).toContain('Spam-Beschwerde');
    expect(h.ledger('emil@example.com')).toMatchObject([{ action: 'declined', purpose: '*' }]);
  });

  it('what the send gate then says: confirmed may get advertising, never-subscribed and withdrawn not', () => {
    const c = h.t.app.services.consent;
    const gate = (e: string, channel = 'email') => {
      const row = h.email(e);
      return c.allowMarketing(h.loc(), { id: row.id, dnd: row.dnd }, channel);
    };
    expect(gate('anna@example.com')).toMatchObject({ allow: true, basis: 'confirmed' });
    expect(gate('ben@example.com')).toMatchObject({ allow: true, basis: 'legacy' });
    expect(gate('cleo@example.com').allow).toBe(false);
    expect(gate('dora@example.com').allow).toBe(false);
    expect(gate('emil@example.com').allow).toBe(false);
    // SMS: only Anna has a confirmed opt-in; Frida's came by API and counts as legacy
    expect(gate('anna@example.com', 'sms')).toMatchObject({ allow: true, basis: 'confirmed' });
    const frida = h.one("SELECT id, dnd FROM contacts WHERE location_id = ? AND phone = '+4915112345678'");
    expect(c.allowMarketing(h.loc(), frida, 'sms')).toMatchObject({ allow: true, basis: 'legacy' });
  });

  it('brings lists and segments as tags (the segment also as a smart list) and says a segment is no longer a rule', () => {
    expect(h.q("SELECT name FROM tags WHERE location_id = ? AND name LIKE 'Liste:%' ORDER BY name").map((t) => t.name)).toEqual(['Liste: Newsletter', 'Liste: VIP']);
    const sl = h.one('SELECT name, filter FROM smart_lists WHERE location_id = ?');
    expect(sl.name).toBe('Aktive Käufer');
    expect(JSON.parse(sl.filter)).toEqual({ tags: ['Segment: Aktive Käufer'] });
    expect(h.tags('emil@example.com')).toContain('Segment: Aktive Käufer');
    expect(imported.warnings.join('\n')).toContain('Segment „Aktive Käufer“ ist in Klaviyo eine Regel');
  });

  it('converts Klaviyo template tags and flags the logic it cannot', () => {
    const t = h.one("SELECT body FROM templates WHERE location_id = ? AND name = 'Newsletter Vorlage'");
    expect(t.body).toContain('{{contact.first_name|}}');
    expect(t.body).toContain('%%unsubscribe_url%%');
    expect(t.body).toContain('{% if person.city %}');
    expect(h.one("SELECT body FROM templates WHERE location_id = ? AND name = 'Schlicht'").body).toContain('{{contact.email}}');
    const w = imported.warnings.join('\n');
    expect(w).toContain('Platzhalter ohne Entsprechung');
    expect(w).toContain('liefert kein HTML');
  });

  it('keeps the flows as a reference page', () => {
    const page = h.one("SELECT body, created_by_name FROM wiki_pages WHERE location_id = ? AND title = 'Flows aus Klaviyo'");
    expect(page.body).toContain('| Willkommens-Serie | live | Zu Liste hinzugefügt | 2 E-Mails, 0 SMS, 1× Warten, 0× Verzweigung | E-Mail → Warten → E-Mail |');
    expect(page.body).toContain('| Warenkorb / Abbruch | draft | Ereignis (Metrik) |');
    expect(page.created_by_name).toBe('Umzug (Klaviyo)');
  });
});

describe('Klaviyo: re-run, undo, limits', () => {
  it('re-running adds nothing twice (contacts, ledger, templates, wiki page)', async () => {
    const before = { c: h.count('contacts'), e: h.count('consent_events'), t: h.count('templates'), p: h.count('wiki_pages'), s: h.count('smart_lists') };
    const again = await h.run({ source: 'klaviyo', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect({ c: h.count('contacts'), e: h.count('consent_events'), t: h.count('templates'), p: h.count('wiki_pages'), s: h.count('smart_lists') }).toEqual(before);
    expect(h.lines(again).contacts.created ?? 0).toBe(0);
  });
  it('undo removes contacts, ledger lines, templates, smart lists and the reference page', async () => {
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
    expect(h.count('templates')).toBe(0);
    expect(h.count('smart_lists')).toBe(0);
    expect(h.count('wiki_pages')).toBe(0);
    expect(h.count('wiki_spaces')).toBe(0);
  });
  it('waits when Klaviyo answers 429 with Retry-After', async () => {
    const f = new FakeKlaviyo();
    f.throttle.set('/api/profiles', 3);
    h.t.app.services.umzugFetch = f.fetch;
    const job = await h.run({ source: 'klaviyo', parts: ['contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(f.seen('/api/profiles').length).toBeGreaterThan(4);
    h.t.app.services.umzugFetch = fake.fetch;
  });
  it('merges into an existing contact without touching its ledger history, and adds a withdrawal to it', async () => {
    h.t.app.services.umzugFetch = fake.fetch;
    await h.fresh('Klaviyo Merge');
    expect((await h.t.api.put('/api/umzug/connections/klaviyo', { api_key: KLAVIYO_KEY })).status).toBe(200);
    // Cleo exists already, with a confirmed history of her own
    const made = await h.t.api.post('/api/contacts', { email: 'cleo@example.com', first_name: 'Cleo', consent: { channels: ['email'], note: 'Formular auf der Webseite' } });
    expect(made.status, JSON.stringify(made.data)).toBeLessThan(300);
    const b = h.ledger('cleo@example.com').length;
    const job = await h.run({ source: 'klaviyo', parts: ['contacts'] });
    expect(job.status).toBe('done');
    const l = h.ledger('cleo@example.com');
    expect(l.length).toBe(b + 1);
    expect(l.find((e) => e.source_label === 'Umzug aus Klaviyo')).toMatchObject({ action: 'revoked' });
    // Anna is new in this location → her full history; Cleo's own line is still there
    expect(h.ledger('anna@example.com').length).toBe(2);
    expect(l.find((e) => e.source_label === 'API')).toMatchObject({ action: 'granted' });
    // undo restores the merged contact and removes only the line the import added
    const undone = await h.undo(job.id);
    expect(undone.status).toBe('undone');
    expect(h.ledger('cleo@example.com').length).toBe(b);
    expect(h.email('cleo@example.com').dnd).toBe(0);
  });
});
