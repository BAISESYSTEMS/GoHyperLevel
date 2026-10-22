import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asDay, klicktippConsent, klicktippContact } from '../server/services/umzug-klicktipp.js';
import { FakeKlickTipp, KT_PASS, KT_USER } from './umzug2-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeKlickTipp();
let imported: any;

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('KlickTipp');
});
afterAll(() => h.t.close());

describe('KlickTipp: parsing (pure)', () => {
  it('reads status, bounce and the opt-in time', () => {
    expect(klicktippConsent({ status: 'Subscribed', optin: 1706778000 })).toMatchObject({ consent: 'ok', proof: [{ basis: 'confirmed', at: '2024-02-01T09:00:00.000Z' }] });
    expect(klicktippConsent({ status: 'Subscribed' }).proof[0].basis).toBe('legacy');
    expect(klicktippConsent({ status: 'Pending' })).toMatchObject({ consent: 'pending', proof: [] });
    expect(klicktippConsent({ status: 'Unsubscribed', unsubscribed: 1719000000 })).toMatchObject({ consent: 'unsubscribed', proof: [{ basis: 'revoked', at: '2024-06-21T20:00:00.000Z' }] });
    expect(klicktippConsent({ status: 'Subscribed', bounce: 'Hard Bounce' }).consent).toBe('bounced');
    expect(klicktippConsent({ status: 'Subscribed', bounce: 'Soft Bounce' }).consent).toBe('ok');
    expect(klicktippConsent({ status: 'Abgemeldet' }).consent).toBe('unsubscribed');
    expect(klicktippConsent({}).consent).toBe('ok');
  });
  it('takes tags as ids, as {id: name} or as objects, and recognises dates by value and name', () => {
    const names = new Map([['11', 'Käufer'], ['12', 'Webinar']]);
    expect(klicktippContact({ id: 1, email: 'a@b.de', tags: [11, 12] }, names).tags).toEqual(['Käufer', 'Webinar']);
    expect(klicktippContact({ id: 1, email: 'a@b.de', tags: { '11': 'Käufer' } }, names).tags).toEqual(['Käufer']);
    expect(klicktippContact({ id: 1, email: 'a@b.de', tags: [{ id: 12, name: 'Webinar' }] }, names).tags).toEqual(['Webinar']);
    expect(asDay('fieldBirthday', 484099200)).toBe('1985-05-05');
    expect(asDay('field103 Kunde seit', 1699920000)).toBe('2023-11-14');
    expect(asDay('field102 Kundennummer', 1700000000)).toBe(1700000000);
    expect(asDay('field102 Kundennummer', 1042)).toBe(1042);
    expect(klicktippContact({ id: 1, email: 'a@b.de', field103: 1699920000 }, names, new Map([['field103', 'Kunde seit']])).values['f:field103']).toBe('2023-11-14');
  });
});

describe('KlickTipp: connect', () => {
  it('refuses wrong credentials and keeps a password with spaces as typed', async () => {
    const bad = await h.t.api.put('/api/umzug/connections/klicktipp', { username: KT_USER, password: 'falsch' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('ungültig');
    const r = await h.t.api.put('/api/umzug/connections/klicktipp', { username: KT_USER, password: KT_PASS });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.account).toMatch(/^acct-[0-9a-f]{12}$/);
    expect(r.data.hint).toBe('');
    expect(JSON.stringify(r.data)).not.toContain(KT_PASS);
    expect(JSON.stringify(r.data)).not.toContain(KT_USER);
  });
  it('logs in once per run and sends the session cookie – never the password – on every other call', () => {
    const logins = fake.seen('/account/login');
    expect(logins.length).toBeGreaterThanOrEqual(2);
    const rest = fake.requests.filter((r) => r.path !== '/account/login');
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((r) => !JSON.stringify(r.body ?? {}).includes('geheim') && !r.url.search.includes('geheim'))).toBe(true);
    expect(fake.requests.every((r) => r.url.hostname === 'api.klicktipp.com')).toBe(true);
  });
  it('the sealed credentials never come back from the API', async () => {
    const all = await h.t.api.get('/api/umzug');
    expect(JSON.stringify(all.data)).not.toContain(KT_PASS);
    const row = h.t.app.db.get<any>('SELECT secret_sealed, hint FROM umzug_connections WHERE source = ?', 'klicktipp');
    expect(row.secret_sealed).not.toContain('geheim');
    expect(row.hint).toBe('');
  });
});

describe('KlickTipp: preview', () => {
  it('counts the active contacts and lists standard and own fields', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'klicktipp' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.counts.find((c: any) => c.key === 'subscribers').total).toBe(4);
    expect(r.data.counts.find((c: any) => c.key === 'tags').total).toBe(2);
    const refs = r.data.fields.map((f: any) => f.ref);
    expect(refs).toEqual(expect.arrayContaining(['f:fieldFirstName', 'f:fieldMobilePhone', 'f:field101', 'f:field103', 'sms']));
    expect(r.data.mapping).toMatchObject({ email: 'email', 'f:fieldFirstName': 'first_name', 'f:fieldLastName': 'last_name', 'f:fieldCompanyName': 'company', 'f:fieldStreet1': 'address', 'f:fieldZip': 'postal_code', 'f:fieldMobilePhone': 'phone', 'f:fieldBirthday': 'date_of_birth', 'f:field101': 'new:text:Lieblingsfarbe', 'f:field103': 'new:date:Kunde seit' });
    expect(r.data.warnings.join(' ')).toContain('abgemeldet');
  });
});

describe('KlickTipp: import', () => {
  it('imports contacts in bulk batches with standard and own fields (dates recognised, decimals left alone)', async () => {
    const job = await h.run({ source: 'klicktipp', parts: ['contacts'] }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('contacts')).toBe(0);
    imported = await h.run({ source: 'klicktipp', parts: ['contacts'] });
    expect(imported.status, imported.error).toBe('done');
    expect(fake.seen('/subscriber/bulk').length).toBeGreaterThan(0);
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', company: 'Muster GmbH', address: 'Hauptstr. 1', postal_code: '10115', city: 'Berlin', phone: '+491511234567', date_of_birth: '1985-05-05', dnd: 0 });
    expect(JSON.parse(anna.custom)).toMatchObject({ lieblingsfarbe: 'Blau', kundennummer: '1042', kunde_seit: '2023-11-14', preis_dezimal: '1999' });
    expect(h.count('contacts')).toBe(4);
  });
  it('gives the tags: the tag list and who carries which tag', () => {
    expect(h.tags('anna@example.com').sort()).toEqual(['Käufer', 'Webinar']);
    expect(h.tags('ben@example.com')).toEqual(['Webinar']);
    expect(h.q('SELECT name FROM tags WHERE location_id = ? ORDER BY name').map((t) => t.name)).toEqual(expect.arrayContaining(['Käufer', 'Webinar']));
  });
  it('maps status to do-not-disturb and the ledger: confirmed with the opt-in time, legacy, pending = nothing', () => {
    expect(h.email('cleo@example.com').dnd).toBe(1);
    expect(h.tags('cleo@example.com')).toContain('KlickTipp: unbestätigt');
    expect(h.ledger('cleo@example.com')).toEqual([]);
    expect(h.email('dora@example.com').dnd).toBe(1);
    expect(h.tags('dora@example.com')).toContain('KlickTipp: unzustellbar');
    expect(h.ledger('dora@example.com')).toMatchObject([{ action: 'revoked' }]);
    const anna = h.ledger('anna@example.com');
    expect(anna).toMatchObject([{ channel: 'email', action: 'granted', purpose: 'newsletter', created_at: '2024-02-01T09:00:00.000Z', source_label: 'Umzug aus KlickTipp' }]);
    expect(anna[0].note).toContain('Opt-in im KlickTipp-Anmeldeprozess bestätigt');
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'legacy' }]);
    const gate = (e: string) => h.t.app.services.consent.allowMarketing(h.loc(), { id: h.email(e).id, dnd: h.email(e).dnd }, 'email');
    expect(gate('anna@example.com')).toMatchObject({ allow: true, basis: 'confirmed' });
    expect(gate('cleo@example.com').allow).toBe(false);
  });
  it('a re-run changes nothing; undo removes it all', async () => {
    const before = { c: h.count('contacts'), e: h.count('consent_events') };
    const again = await h.run({ source: 'klicktipp', parts: ['contacts'] });
    expect(again.status, again.error).toBe('done');
    expect({ c: h.count('contacts'), e: h.count('consent_events') }).toEqual(before);
    const done = await h.undo(imported.id);
    expect(done.status).toBe('undone');
    expect(h.count('contacts')).toBe(0);
    expect(h.count('consent_events')).toBe(0);
  });
  it('reads one subscriber at a time when the account has no bulk call', async () => {
    const f = new FakeKlickTipp();
    f.noBulk = true;
    h.t.app.services.umzugFetch = f.fetch;
    await h.fresh('KlickTipp ohne Bulk');
    expect((await h.t.api.put('/api/umzug/connections/klicktipp', { username: KT_USER, password: KT_PASS })).status).toBe(200);
    const job = await h.run({ source: 'klicktipp', parts: ['contacts'] });
    expect(job.status, job.error).toBe('done');
    expect(h.count('contacts')).toBe(4);
    expect(f.seen('/subscriber/').filter((r) => /^\/subscriber\/\d+$/.test(r.path)).length).toBe(4);
    h.t.app.services.umzugFetch = fake.fetch;
  });
});
