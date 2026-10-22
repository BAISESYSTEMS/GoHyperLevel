import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CogneeClient, CogneeError, LocationClient, clearTokens, multipart } from '../server/services/cognee/client.js';
import { askableTypes, activeTypes, cleanBaseUrl, datasetName, defaultSettings, ownedDataset, parseDatasetName, readSettings, TYPES, type CogneeType } from '../server/services/cognee/model.js';
import { ibanValid, phoneLike, redact } from '../server/services/cognee/redact.js';
import { documentText } from '../server/services/cognee/sources.js';
import { snippetOf } from '../server/services/cognee/recall.js';
import { backoffMs } from '../server/services/cognee/sync.js';
import { fakeCognee, type FakeCognee } from './cognee-fakes.js';

const BASE = 'http://cognee.test:8000';

describe('dataset names and the opt-in defaults', () => {
  it('names a dataset gh_<location>_<type>, and only that', () => {
    expect(datasetName('abcDEF123456', 'wiki')).toBe('gh_abcDEF123456_wiki');
    expect(parseDatasetName('gh_abcDEF123456_notes')).toEqual({ locationId: 'abcDEF123456', type: 'notes' });
    for (const bad of ['gh_abc_wiki', 'gh_abcDEF123456_other', 'x_abcDEF123456_wiki', 'gh_abcDEF123456_wiki_extra', 'gh_abc DEF123456_wiki']) expect(parseDatasetName(bad)).toBeNull();
    // Ids that could make two names collide are refused.
    for (const bad of ['', 'a_b_c_d_e_f', 'abc_def_ghi', '../etc/passwd', 'ab']) expect(() => datasetName(bad, 'wiki')).toThrow();
    expect(() => datasetName('abcDEF123456', 'nope' as CogneeType)).toThrow();
    // Different sub-accounts and types never share a name.
    const names = new Set(['locAAAAAA1', 'locBBBBBB2'].flatMap((l) => TYPES.map((t) => datasetName(l, t))));
    expect(names.size).toBe(2 * TYPES.length);
  });

  it('is off by default, shares only the wiki once on, and redacts personal data by default', () => {
    const d = defaultSettings();
    expect(d.enabled).toBe(false);
    expect(activeTypes(d)).toEqual([]);
    expect(activeTypes({ ...d, enabled: true })).toEqual(['wiki']);
    for (const t of ['notes', 'tickets', 'conversations', 'contacts'] as const) expect(d.redact[t]).toBe(true);
    expect(d.redact.wiki).toBe(false);
    // Stored values override the defaults; anything missing or broken falls back to them.
    const r = readSettings({ enabled: 1, types: '{"notes":true,"wiki":false}', redact: '{"conversations":false}', members_ask: 0 });
    expect(r).toMatchObject({ enabled: true, members_ask: false });
    expect(activeTypes(r)).toEqual(['notes']);
    expect(r.redact.conversations).toBe(false);
    expect(readSettings({ enabled: 1, types: 'not json' }).types.wiki).toBe(true);
  });

  it('lets a member ask only about the types their areas allow', () => {
    const s = { ...defaultSettings(), enabled: true, types: { ...defaultSettings().types, notes: true, tickets: true, memory: true } };
    expect(askableTypes(s, null)).toEqual(['wiki', 'notes', 'tickets', 'memory']);
    expect(askableTypes(s, ['wiki'])).toEqual(['wiki', 'memory']);
    expect(askableTypes(s, ['contacts', 'helpdesk'])).toEqual(['notes', 'tickets', 'memory']);
    expect(askableTypes(s, [])).toEqual(['memory']);
    expect(askableTypes({ ...s, enabled: false }, null)).toEqual([]);
  });

  it('cleans the server address', () => {
    expect(cleanBaseUrl('https://cognee.example.com/')).toBe('https://cognee.example.com');
    expect(cleanBaseUrl('http://cognee:8000')).toBe('http://cognee:8000');
    expect(cleanBaseUrl('http://192.168.1.20:8000/prefix/')).toBe('http://192.168.1.20:8000/prefix');
    expect(() => cleanBaseUrl('')).toThrow(/fehlt/);
    expect(() => cleanBaseUrl('ftp://x.example.com')).toThrow();
    expect(() => cleanBaseUrl('http://cognee.example.com')).toThrow(/https/);
    expect(() => cleanBaseUrl('https://user:pw@cognee.example.com')).toThrow(/Zugangsdaten/);
    expect(() => cleanBaseUrl('https://cognee.example.com/?x=1')).toThrow();
  });
});

describe('PII redaction', () => {
  it('replaces e-mail addresses, phone numbers and IBANs and counts them', () => {
    const r = redact('Max schreibt an max.mustermann@example.com, Tel. +49 170 1234567 oder 0170/1234567, Konto DE89 3704 0044 0532 0130 00.');
    expect(r.text).toBe('Max schreibt an [E-Mail], Tel. [Telefon] oder [Telefon], Konto [IBAN].');
    expect(r.counts).toEqual({ email: 1, phone: 2, iban: 1 });
  });

  it('keeps dates, amounts, invoice numbers and ordinary numbers', () => {
    const text = 'Rechnung RE-2026-0001 vom 05.10.2026 über 1.234,50 EUR, 12 Stück, Termin 10:30, Version 3.1.4, Jahr 2026.';
    expect(redact(text)).toEqual({ text, counts: { email: 0, phone: 0, iban: 0 } });
    expect(phoneLike('05.10.2026')).toBe(false);
    expect(phoneLike('+43 1 2345678')).toBe(true);
    expect(phoneLike('(0221) 123456')).toBe(true);
    expect(phoneLike('12345')).toBe(false);
  });

  it('only treats a valid IBAN as an IBAN', () => {
    expect(ibanValid('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(ibanValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanValid('DE00 3704 0044 0532 0130 00')).toBe(false);
    expect(redact('Nummer DE00 3704 0044 0532 0130 00').counts.iban).toBe(0);
  });

  it('does nothing to text without personal data', () => {
    expect(redact('Das Wiki erklärt den Onboarding-Call.').text).toBe('Das Wiki erklärt den Onboarding-Call.');
  });
});

describe('what is sent', () => {
  it('starts with a header line, so a text can never be read as a path or address, and names the record', () => {
    const t = documentText('wiki', 'page', 'abc123', { title: 'x', body: '/etc/passwd\nhttps://evil.example/' });
    expect(t.startsWith('HyperLevel · Wiki & Dokumente · page:abc123\n\n')).toBe(true);
    expect(t).not.toMatch(/^(\/|file:|https?:)/);
  });

  it('cuts a passage to a short single paragraph without the header and the descriptive lead', () => {
    expect(snippetOf('HyperLevel · Wiki & Dokumente · page:1\n\nErste Zeile\n\nzweite   Zeile', 100)).toBe('Erste Zeile zweite Zeile');
    expect(snippetOf('HyperLevel · Wiki & Dokumente · page:1\n\nWiki-Seite: Preise\nBereich: Team\n\nDas Paket kostet 49 Euro.', 100)).toBe('Das Paket kostet 49 Euro.');
    // Nothing but label lines (a contact): kept.
    expect(snippetOf('HyperLevel · Kontakte · contact:1\n\nKontakt: Erika\nFirma: Muster GmbH', 100)).toBe('Kontakt: Erika Firma: Muster GmbH');
    // documents synced before the rename still carry the old header
    expect(snippetOf('GoHigh · Wiki & Dokumente · page:1\n\nAlter Kopf', 100)).toBe('Alter Kopf');
    expect(snippetOf('x'.repeat(50), 10)).toHaveLength(10);
  });

  it('backs off 1, 2, 4 … 60 minutes', () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 3_600_000, 3_600_000]);
  });
});

describe('Cognee client', () => {
  let fake: FakeCognee;
  let sleeps: number[];
  let clock: number;
  const make = (over: Partial<ConstructorParameters<typeof CogneeClient>[0]> = {}) =>
    new CogneeClient({ baseUrl: BASE, allowPrivate: true, mode: 'password', email: 'gohigh@example.com', secret: 'pw-gohigh', fetch: fake.fetch as any, sleep: async (ms) => void sleeps.push(ms), now: () => clock, minGapMs: 0, ...over });

  beforeEach(() => {
    clearTokens();
    sleeps = [];
    clock = Date.now();
    fake = fakeCognee({ now: () => clock });
  });

  it('logs in once (form login → bearer) and reuses the token', async () => {
    const c = make();
    expect((await c.me()).email).toBe('gohigh@example.com');
    await c.listDatasets();
    expect(fake.logins()).toBe(1);
    const login = fake.calls.find((x) => x.path === '/api/v1/auth/login')!;
    expect(login.body).toBeUndefined(); // the password is never recorded
    expect(fake.calls.filter((x) => x.user === 'gohigh@example.com' && x.path !== '/api/v1/auth/login').length).toBe(2);
  });

  it('logs in again when the token has expired (JWT exp) and when the server refuses it (401)', async () => {
    const c = make();
    await c.me();
    clock += 3_600_000; // past the token's exp minus the margin
    await c.me();
    expect(fake.logins()).toBe(2);
    fake.expireTokens(); // the server forgot its tokens: one 401, one new login, call repeated
    await c.listDatasets();
    expect(fake.logins()).toBe(3);
    expect(fake.calls.filter((x) => x.status === 401).length).toBe(1);
  });

  it('says so when the login is wrong', async () => {
    const c = make({ secret: 'wrong' });
    await expect(c.me()).rejects.toThrow('E-Mail oder Passwort bei Cognee stimmen nicht.');
  });

  it('works with an API key (X-Api-Key, no login) and refuses a wrong one', async () => {
    const c = make({ mode: 'api_key', email: '', secret: 'key-gohigh' });
    expect((await c.me()).email).toBe('gohigh@example.com');
    expect(fake.logins()).toBe(0);
    await expect(make({ mode: 'api_key', email: '', secret: 'nope' }).me()).rejects.toThrow(/Zugangsdaten/);
  });

  it('retries 503 and network errors, waits out a 429 Retry-After, and gives up with a retryable error', async () => {
    const c = make();
    fake.failNext(/GET \/api\/v1\/datasets$/, 503, { detail: 'busy' }, 2);
    expect(await c.listDatasets()).toEqual([]);
    expect(sleeps).toEqual([400, 800]);
    sleeps.length = 0;
    fake.failNext(/GET \/api\/v1\/datasets$/, 429, { detail: 'slow down' }, 1, { 'retry-after': '3' });
    await c.listDatasets();
    expect(sleeps).toEqual([3000]);
    // A Retry-After beyond what a request may wait for is handed to the scheduler.
    fake.failNext(/GET \/api\/v1\/datasets$/, 429, { detail: 'slow down' }, 5, { 'retry-after': '120' });
    const e = (await c.listDatasets().catch((x) => x)) as CogneeError;
    expect(e).toBeInstanceOf(CogneeError);
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(120_000);
    fake.setOffline(true);
    const off = (await make().health().catch((x) => x)) as CogneeError;
    expect(off.retryable).toBe(true);
    expect(off.message).toMatch(/nicht erreichbar/);
  });

  it('reads health and tells an open server from one that asks for a login', async () => {
    expect(await make().health()).toMatchObject({ ok: true, version: '1.6.2' });
    expect((await make().probeOpen()).state).toBe('closed');
    const open = fakeCognee({ accessControl: false });
    expect((await make({ fetch: open.fetch as any }).probeOpen()).state).toBe('open');
  });

  it('sends the text as multipart form fields FastAPI understands', async () => {
    const lc = new LocationClient('locAAAAAA1', make());
    const ds = (await lc.dataset('wiki', true))!;
    const dataId = await lc.add(ds, 'HyperLevel · Wiki\n\nHallo Welt äöü', 'wiki:page:p1');
    const add = fake.calls.find((x) => x.path === '/api/v1/add')!;
    expect(Object.fromEntries(add.body)).toMatchObject({ raw_data: 'HyperLevel · Wiki\n\nHallo Welt äöü', datasetId: ds.id, labels: '["wiki"]', external_metadata: '[{"gh_ref":"wiki:page:p1"}]', run_in_background: 'false' });
    expect(fake.items('gh_locAAAAAA1_wiki')[0].id).toBe(dataId);
    expect(multipart([['a', 'x']]).contentType).toMatch(/^multipart\/form-data; boundary=/);
  });

  it('creates the dataset by its name and finds it again; deletes one item or the dataset', async () => {
    const lc = new LocationClient('locAAAAAA1', make());
    expect(await lc.dataset('notes', false)).toBeNull();
    const ds = (await lc.dataset('notes', true))!;
    expect(ds.name).toBe('gh_locAAAAAA1_notes');
    expect((await new LocationClient('locAAAAAA1', make()).dataset('notes'))!.id).toBe(ds.id);
    const id = await lc.add(ds, 'HyperLevel · Notizen\n\nx', 'notes:note:n1');
    expect(await lc.count(ds)).toBe(1);
    await lc.deleteData(ds, id);
    expect(await lc.count(ds)).toBe(0);
    await lc.deleteData(ds, id); // already gone: fine
    await lc.deleteDataset(ds);
    expect(fake.dataset('gh_locAAAAAA1_notes')).toBeUndefined();
  });

  it('refuses a dataset of another sub-account before any request is made', async () => {
    const a = new LocationClient('locAAAAAA1', make());
    const b = new LocationClient('locBBBBBB2', make());
    const dsB = (await b.dataset('wiki', true))!;
    await b.add(dsB, 'HyperLevel · Wiki\n\ngeheim B', 'wiki:page:b1');
    fake.reset();
    for (const call of [() => a.add(dsB, 'x', 'r'), () => a.cognify(dsB), () => a.status(dsB), () => a.deleteData(dsB, 'f47ac10b-58cc-4372-a567-0e02b2c3d479'), () => a.deleteDataset(dsB), () => a.count(dsB), () => a.search([dsB], 'geheim', 'CHUNKS', 5)]) {
      await expect(call()).rejects.toThrow(/gehört nicht zu diesem Sub-Account/);
    }
    // Forged objects: a made-up name, a wrong type, an id that is no UUID.
    const forged = { ...dsB, locationId: 'locAAAAAA1' };
    await expect(a.deleteDataset(forged)).rejects.toThrow(/gehört nicht/);
    await expect(a.deleteDataset({ ...ownedDataset('locAAAAAA1', 'wiki', dsB.id), type: 'notes' })).rejects.toThrow(/gehört nicht/);
    expect(() => ownedDataset('locAAAAAA1', 'wiki', 'not-a-uuid')).toThrow();
    expect(fake.calls).toEqual([]);
    expect(fake.items('gh_locBBBBBB2_wiki')).toHaveLength(1);
  });

  it('confirms a stored dataset id only when the server carries the sub-account name for it', async () => {
    const a = new LocationClient('locAAAAAA1', make());
    const b = new LocationClient('locBBBBBB2', make());
    const dsA = (await a.dataset('wiki', true))!;
    const dsB = (await b.dataset('wiki', true))!;
    expect((await a.confirm('wiki', dsA.id))?.id).toBe(dsA.id);
    expect(await a.confirm('wiki', dsB.id)).toBeNull();
    expect(await a.confirm('notes', dsA.id)).toBeNull();
  });

  it('keeps data apart with two logins (a Cognee user per sub-account): the other login cannot even list it', async () => {
    fake = fakeCognee({ users: { 'a@example.com': 'pa', 'b@example.com': 'pb' } });
    const a = new LocationClient('locAAAAAA1', make({ email: 'a@example.com', secret: 'pa', fetch: fake.fetch as any }));
    const b = new LocationClient('locBBBBBB2', make({ email: 'b@example.com', secret: 'pb', fetch: fake.fetch as any }));
    const dsA = (await a.dataset('wiki', true))!;
    await a.add(dsA, 'HyperLevel · Wiki\n\nnur für A', 'wiki:page:a1');
    expect(await b.dataset('wiki', false)).toBeNull();
    expect(await b.confirm('wiki', dsA.id)).toBeNull();
  });
});

describe('Cognee client over real HTTP (safeFetch)', () => {
  let server: ReturnType<typeof createServer>;
  let fake: FakeCognee;
  let url = '';

  beforeEach(async () => {
    clearTokens();
    fake = fakeCognee();
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = await fake.fetch(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('logs in, creates a dataset, adds umlauts and searches – with the internal network allowed', async () => {
    const lc = new LocationClient('locAAAAAA1', new CogneeClient({ baseUrl: url, allowPrivate: true, mode: 'password', email: 'gohigh@example.com', secret: 'pw-gohigh', minGapMs: 0 }));
    const ds = (await lc.dataset('wiki', true))!;
    await lc.add(ds, 'HyperLevel · Wiki\n\nGrüße aus München: Onboarding-Call', 'wiki:page:p1');
    const raw = await lc.search([ds], 'Onboarding', 'CHUNKS', 5);
    expect(raw[0].search_result[0].text).toContain('Grüße aus München');
  });

  it('refuses an internal address unless the agency allowed the internal network', async () => {
    const c = new CogneeClient({ baseUrl: url, allowPrivate: false, mode: 'password', email: 'gohigh@example.com', secret: 'pw-gohigh', minGapMs: 0, retries: 0 });
    const e = (await c.health().catch((x) => x)) as CogneeError;
    expect(e.message).toMatch(/Internes Netz erlauben/);
  });
});
