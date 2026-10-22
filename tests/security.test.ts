import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/core/app.js';
import { isSealed, openIfSealed, openWith, sealWith } from '../server/core/secrets.js';
import { syncCalendar } from '../server/modules/calendar-sync.js';
import { MODULES } from '../server/modules/index.js';
import { rotateDataKey } from '../server/services/key-rotation.js';
import { deliverSms, oneLine } from '../server/services/messaging.js';
import { isPrivateIp, safeFetch } from '../server/services/net.js';
import { callRoute } from '../server/services/route-call.js';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

/** Regression tests for the findings of docs/security-review-2026-10.md (one block per finding). */

describe('secrets at rest', () => {
  const cfg = { secret: 's1' };
  const key = 'a'.repeat(64);
  it('seals with the legacy key (v1) and with a data key (v2 + key id), opens with previous keys', () => {
    const v1 = sealWith(cfg, 'pw');
    expect(v1).toMatch(/^v1:/);
    expect(openWith(cfg, v1)).toBe('pw');
    const withKey = { secret: 's1', dataKey: key };
    const v2 = sealWith(withKey, 'pw2');
    expect(v2).toMatch(/^v2:[0-9a-f]{8}:/);
    expect(openWith(withKey, v2)).toBe('pw2');
    // v1 values stay readable after a data key was introduced; v2 after the key moved to "previous".
    expect(openWith(withKey, v1)).toBe('pw');
    expect(openWith({ secret: 's1', dataKey: 'b'.repeat(64), previousDataKeys: [key] }, v2)).toBe('pw2');
    expect(() => openWith(cfg, v2)).toThrow();
    // Tampering is detected (GCM tag).
    const parts = v1.split(':');
    parts[3] = Buffer.from('other').toString('base64');
    expect(() => openWith(cfg, parts.join(':'))).toThrow();
    expect(openIfSealed({ config: cfg }, 'legacy-plain')).toBe('legacy-plain');
    expect(isSealed(v2)).toBe(true);
    expect(isSealed('v1:nope')).toBe(false);
  });

  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => t.close());

  it('stores SMTP/SMS credentials of a sub-account sealed, masks them in responses and opens them for sending', async () => {
    const r = await t.api.patch('/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.example.com', user: 'u', pass: 'SMTP-PLAIN-PW' }, sms: { provider: 'twilio', accountSid: 'AC1', authToken: 'TWILIO-PLAIN-TOKEN' } } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toMatch(/SMTP-PLAIN-PW|TWILIO-PLAIN-TOKEN/);
    const raw = t.app.db.get('SELECT settings FROM locations WHERE id = ?', t.api.location)!.settings;
    expect(raw).not.toMatch(/SMTP-PLAIN-PW|TWILIO-PLAIN-TOKEN/);
    expect(JSON.parse(raw).email.pass).toMatch(/^v1:/);
    expect(t.app.location(t.api.location)!.settings.email.pass).toBe('SMTP-PLAIN-PW');
    // A save with the masked value keeps the secret; other writers (invoice counter, inbound key) keep it sealed.
    await t.api.patch('/api/location', { settings: { email: { pass: '••••••', host: 'smtp2.example.com' } } });
    await t.api.post('/api/invoices', { items: [{ name: 'x', qty: 1, price_cents: 100 }] });
    await t.api.get('/api/settings/inbound');
    const after = t.app.db.get('SELECT settings FROM locations WHERE id = ?', t.api.location)!.settings;
    expect(after).not.toMatch(/SMTP-PLAIN-PW|TWILIO-PLAIN-TOKEN/);
    expect(JSON.parse(after).inbound_key).toMatch(/^v1:/);
    expect(t.app.location(t.api.location)!.settings.email).toMatchObject({ pass: 'SMTP-PLAIN-PW', host: 'smtp2.example.com' });
    // The inbound key is not readable through the sub-account profile (members without the settings area).
    expect(JSON.stringify((await t.api.get('/api/location')).data)).not.toContain(t.app.location(t.api.location)!.settings.inbound_key);
  });

  it('seals plain-text credentials an older version left in the settings on first read', () => {
    const loc = t.api.location;
    const s = JSON.parse(t.app.db.get('SELECT settings FROM locations WHERE id = ?', loc)!.settings);
    s.sms.authToken = 'OLD-PLAIN';
    t.app.db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(s), loc);
    expect(t.app.location(loc)!.settings.sms.authToken).toBe('OLD-PLAIN');
    expect(t.app.db.get('SELECT settings FROM locations WHERE id = ?', loc)!.settings).not.toContain('OLD-PLAIN');
  });

  it('keeps 2FA secrets sealed', async () => {
    const setup = (await t.api.post('/api/me/2fa/setup')).data;
    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    const row = t.app.db.get('SELECT totp_secret FROM users WHERE email = ?', 'chef@example.com')!;
    expect(row.totp_secret).toMatch(/^v1:/);
    expect(openIfSealed(t.app, row.totp_secret)).toBe(setup.secret);
  });

  it('keeps webhook signing secrets sealed and signs with HMAC-SHA256 as well', async () => {
    const wh = (await t.api.post('/api/webhooks', { url: 'https://example.com/in' })).data;
    expect(wh.secret).toHaveLength(24);
    expect(t.app.db.get('SELECT secret FROM webhooks WHERE id = ?', wh.id)!.secret).toMatch(/^v1:/);
    expect((await t.api.get('/api/webhooks')).data.find((h: any) => h.id === wh.id).secret).toBe(wh.secret);
    const calls: any[] = [];
    t.app.services.restHookFetch = async (url: string, init: any) => {
      calls.push({ url, ...init });
      return { status: 200, ok: true, headers: {}, text: async () => 'ok' };
    };
    const hook = (await t.api.post('/api/hooks', { target_url: 'https://hooks.example.com/x', event: 'contact.created' })).data;
    expect(t.app.db.get('SELECT secret FROM rest_hooks WHERE id = ?', hook.id)!.secret).toMatch(/^v1:/);
    await t.api.post('/api/contacts', { email: 'hmac@example.com' });
    await t.app.events.flush();
    const c = calls.find((x) => x.url === 'https://hooks.example.com/x');
    expect(c.headers['x-pghl-signature-256']).toBe(`sha256=${createHmac('sha256', hook.secret).update(c.body).digest('hex')}`);
  });
});

describe('key rotation (npm run rotate-secret)', () => {
  it('re-seals every stored secret with a new data key; the old key stays as fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-rot-'));
    const base = { port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'x.db'), baseUrl: 'http://localhost', webDir: dir, behindProxy: false, tickMs: 0, secret: 'rot-secret' };
    const one = createApp(base, MODULES);
    const db = one.app.db;
    db.insert('users', { id: 'u1', email: 'a@b.de', name: 'A', password_hash: 'x', role: 'admin', locations: '[]', created_at: new Date().toISOString(), totp_secret: sealWith(base, 'TOTPSECRET') });
    const loc = (await import('../server/modules/core.js')).createLocation(db, 'Rot');
    db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify({ email: { provider: 'smtp', pass: sealWith(base, 'SMTP') } }), loc.id);
    db.run(`INSERT INTO agency_settings (key, value) VALUES ('blob', ?)`, JSON.stringify({ nested: { key_sealed: sealWith(base, 'NESTED') } }));
    await one.close();

    const dry = rotateDataKey({ dataDir: dir, dbFile: base.dbFile, secret: base.secret, dryRun: true });
    // Ours plus whatever modules sealed on start (e.g. the web-push key).
    expect(dry.values).toBeGreaterThanOrEqual(3);
    expect(dry.tables).toEqual(expect.arrayContaining(['users', 'locations', 'agency_settings']));
    const r = rotateDataKey({ dataDir: dir, dbFile: base.dbFile, secret: base.secret });
    expect(r).toMatchObject({ values: dry.values, failed: [], wroteKeyFile: true });
    expect(readFileSync(join(dir, 'data.key'), 'utf8').trim()).toBe(r.newKey);

    const two = createApp({ ...base, dataKey: r.newKey }, MODULES);
    const totp = two.app.db.get('SELECT totp_secret FROM users WHERE id = ?', 'u1')!.totp_secret;
    expect(totp).toMatch(new RegExp(`^v2:${r.kid}:`));
    expect(openWith(two.app.config, totp)).toBe('TOTPSECRET');
    expect(two.app.location(loc.id)!.settings.email.pass).toBe('SMTP');
    const blob = JSON.parse(two.app.db.get(`SELECT value FROM agency_settings WHERE key = 'blob'`)!.value);
    expect(openWith(two.app.config, blob.nested.key_sealed)).toBe('NESTED');
    await two.close();

    // A second rotation keeps the first key in data.key.previous.
    const r2 = rotateDataKey({ dataDir: dir, dbFile: base.dbFile, secret: base.secret, dataKey: r.newKey });
    expect(r2.failed).toEqual([]);
    expect(readFileSync(join(dir, 'data.key.previous'), 'utf8')).toContain(r.newKey);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('SSRF guard', () => {
  it('treats every spelling of internal addresses as private', () => {
    for (const ip of ['::ffff:7f00:1', '[::ffff:7f00:1]', '0:0:0:0:0:ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2002:7f00:1::', 'fec0::1', '::', '0.0.0.0', '224.0.0.1', '198.18.0.1'])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '2a00:1450:4001::1', '::ffff:8.8.8.8']) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('refuses IPv4-mapped IPv6 literals pointing at the server itself', async () => {
    await expect(safeFetch('http://[::ffff:7f00:1]:1/')).rejects.toThrow(/intern/);
    await expect(safeFetch('http://2130706433/')).rejects.toThrow(/intern/);
  });

  it('does not forward credentials when a redirect leaves the origin', async () => {
    const { createServer } = await import('node:http');
    const seen: Record<string, any> = {};
    const target = createServer((req, res) => {
      seen.auth = req.headers.authorization;
      res.end('ok');
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const tPort = (target.address() as any).port;
    const hop = createServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${tPort}/` }).end());
    await new Promise<void>((r) => hop.listen(0, '127.0.0.1', () => r()));
    process.env.PGHL_ALLOW_PRIVATE_FETCH = '1';
    try {
      const r = await safeFetch(`http://127.0.0.1:${(hop.address() as any).port}/`, { headers: { authorization: 'Bearer secret' } });
      expect(r.status).toBe(200);
      expect(seen.auth).toBeUndefined();
    } finally {
      delete process.env.PGHL_ALLOW_PRIVATE_FETCH;
      hop.close();
      target.close();
    }
  });

  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => t.close());

  it('iCal import URLs go through the guard (the old host-name blocklist missed mapped IPv6 and DNS names)', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'iCal' })).data;
    t.app.db.run(`UPDATE calendars SET settings = json_set(settings, '$.ical_import', json(?)) WHERE id = ?`, JSON.stringify(['https://[::ffff:7f00:1]/x.ics']), cal.id);
    const status = await syncCalendar(t.app, cal.id);
    expect(status.ok).toBe(false);
    expect(status.message).toMatch(/intern/);
  });

  it('an HTTP SMS gateway cannot point at internal addresses', async () => {
    const loc = { id: 'x', name: 'x', timezone: 'UTC', settings: { sms: { provider: 'http', url: 'http://169.254.169.254/latest/meta-data/' } } };
    await expect(deliverSms(loc, '+491', 'hi')).rejects.toThrow(/intern/);
  });
});

describe('email headers', () => {
  it('never carry line breaks', () => {
    expect(oneLine('Hallo\r\nBcc: victim@example.com')).toBe('Hallo Bcc: victim@example.com');
    expect(oneLine(undefined)).toBe('');
  });
});

describe('cross-tenant fixes', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let other = '';
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    other = (await t.api.post('/api/locations', { name: 'Andere' })).data.id;
  });
  afterAll(async () => t.close());

  it('a document link filed under another project is not moved by a member or key', async () => {
    const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
    const doc = (await admin('POST', '/api/docs', { url: 'https://example.com/private-doc', title: 'Geheim' }, { 'x-location-id': other })).data.doc;
    await t.api.post('/api/users', { email: 'm@example.com', password: 'passwort-1', locations: [t.api.location] });
    const member = client(t.base, { 'x-pghl': '1', 'x-location-id': t.api.location });
    await member('POST', '/api/auth/login', { email: 'm@example.com', password: 'passwort-1' });
    const r = await member('POST', '/api/docs', { url: 'https://example.com/private-doc', title: 'Meins' });
    expect(r.status).toBe(409);
    expect(t.app.db.get('SELECT location_id, title FROM docs WHERE id = ?', doc.id)).toMatchObject({ location_id: other, title: 'Geheim' });
  });

  it('snapshots never carry a calendar feed token or private iCal URLs into another sub-account', async () => {
    const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
    const cal = (await t.api.post('/api/calendars', { name: 'Privat' })).data;
    const feed = (await t.api.get(`/api/calendars/${cal.id}/feed`)).data.url as string;
    const tok = feed.split('/cal/')[1].replace('.ics', '');
    t.app.db.run(`UPDATE calendars SET settings = json_set(settings, '$.ical_import', json(?)) WHERE id = ?`, JSON.stringify(['https://calendar.google.com/calendar/ical/private-abc/basic.ics']), cal.id);
    const snap = (await admin('POST', '/api/snapshots', { location_id: t.api.location, name: 'Vorlage' })).data;
    const raw = JSON.stringify((await admin('GET', `/api/snapshots/${snap.id}/download`)).data);
    expect(raw).not.toContain(tok);
    expect(raw).not.toContain('private-abc');
    expect((await admin('POST', `/api/snapshots/${snap.id}/apply`, { location_id: other })).status).toBe(200);
    const copy = t.app.db.get(`SELECT settings FROM calendars WHERE location_id = ? AND name = 'Privat'`, other)!;
    expect(copy.settings).not.toContain(tok);
    // A token an old snapshot already copied: the feed serves nothing, and the owner gets a new one.
    t.app.db.run(`UPDATE calendars SET settings = json_set(settings, '$.feed_token', ?) WHERE location_id = ? AND name = 'Privat'`, tok, other);
    expect((await t.api.raw(`/cal/${tok}.ics`)).status).toBe(404);
    const renewed = (await t.api.get(`/api/calendars/${cal.id}/feed`)).data.url as string;
    expect(renewed).not.toContain(tok);
    expect((await t.api.raw(new URL(renewed).pathname)).status).toBe(200);
  });

  it("PATCH of another sub-account's custom field is 404 and returns nothing", async () => {
    const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
    const f = (await admin('POST', '/api/custom-fields', { label: 'Fremd' }, { 'x-location-id': other })).data;
    const r = await t.api.patch(`/api/custom-fields/${f.id}`, { label: 'x' });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.data)).not.toContain('Fremd');
  });

  it('callRoute refuses to switch into a sub-account the caller does not belong to', async () => {
    const ctx: any = { user: { id: 'm', role: 'member', locations: [t.api.location], permissions: null }, locationId: t.api.location, via: 'session', req: { headers: {} }, cookies: {} };
    await expect(callRoute(t.app, ctx, 'GET', '/api/contacts', {}, { locationId: other })).rejects.toThrow(/Kein Zugriff/);
    await expect(callRoute(t.app, { ...ctx, user: undefined, via: 'api_key' }, 'GET', '/api/contacts', {}, { locationId: other })).rejects.toThrow(/Kein Zugriff/);
    expect(Array.isArray((await callRoute(t.app, ctx, 'GET', '/api/contacts')).contacts ?? [])).toBe(true);
  });
});

describe('authentication', () => {
  it('hashes passwords with scrypt N=2^15 r=8 p=3, still verifies old hashes and upgrades them at login', async () => {
    const { hashPassword, needsRehash, verifyPassword, verifyPasswordAsync } = await import('../server/core/util.js');
    const h = hashPassword('geheim123');
    expect(h).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(verifyPassword('geheim123', h)).toBe(true);
    expect(await verifyPasswordAsync('falsch', h)).toBe(false);
    expect(await verifyPasswordAsync('egal', undefined)).toBe(false);
    // Old format: scrypt$salt$hash with Node's defaults.
    const { scryptSync } = await import('node:crypto');
    const salt = Buffer.from('0123456789abcdef');
    const legacy = `scrypt$${salt.toString('base64')}$${scryptSync('alt-passwort', salt, 64).toString('base64')}`;
    expect(verifyPassword('alt-passwort', legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(h)).toBe(false);
    // Absurd parameters in a tampered row are refused instead of burning memory.
    expect(verifyPassword('x', `scrypt$1073741824$8$1$${salt.toString('base64')}$AAAA`)).toBe(false);

    const t = await startTestApp();
    await t.setup();
    t.app.db.run('UPDATE users SET password_hash = ? WHERE email = ?', legacy, 'chef@example.com');
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'alt-passwort' })).status).toBe(200);
    expect(t.app.db.get('SELECT password_hash FROM users WHERE email = ?', 'chef@example.com')!.password_hash).toMatch(/^scrypt\$32768\$/);
    await t.close();
  });

  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => t.close());

  it('a session id brought to the login never survives it (fixation)', async () => {
    const planted = t.api.cookie.split('=')[1];
    const r = await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    expect(r.status).toBe(200);
    expect(t.app.db.get('SELECT 1 AS x FROM sessions WHERE token_hash = ?', (await import('../server/core/util.js')).sha256(decodeURIComponent(planted)))).toBeUndefined();
    expect(t.api.cookie.split('=')[1]).not.toBe(planted);
  });

  it('a password set by the admin signs that person out everywhere', async () => {
    const u = (await t.api.post('/api/users', { email: 'team@example.com', password: 'passwort-1', locations: [t.api.location] })).data;
    const member = client(t.base, { 'x-pghl': '1' });
    await member('POST', '/api/auth/login', { email: 'team@example.com', password: 'passwort-1' });
    expect((await member('GET', '/api/me')).status).toBe(200);
    expect((await t.api.patch(`/api/users/${u.id}`, { password: 'neues-passwort-2' })).status).toBe(200);
    expect((await member('GET', '/api/me')).status).toBe(401);
    const audit = t.app.db.all(`SELECT action FROM audit_log WHERE action LIKE 'login%'`).map((r) => r.action);
    expect(audit).toContain('login');
  });

  it('guessing the current password with a stolen session is throttled', async () => {
    const s = client(t.base, { 'x-pghl': '1' });
    await t.api.post('/api/users', { email: 'pw@example.com', password: 'passwort-1', locations: [] });
    await s('POST', '/api/auth/login', { email: 'pw@example.com', password: 'passwort-1' });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await s('POST', '/api/me/password', { current: `falsch-${i}`, next: 'egal-egal-1' })).status);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await s('POST', '/api/me/password', { current: 'passwort-1', next: 'egal-egal-1' })).status).toBe(429);
  });

  it('wrong 2FA codes from many addresses lock the account (not only the IP)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-2fa-'));
    const inst = createApp({ port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'x.db'), baseUrl: 'http://localhost', webDir: dir, behindProxy: true, tickMs: 0, secret: 's' }, MODULES);
    const server = await inst.listen();
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const admin = client(base, { 'x-pghl': '1' });
    await admin('POST', '/api/auth/setup', { email: 'two@example.com', password: 'geheim123' });
    const setup = (await admin('POST', '/api/me/2fa/setup', {})).data;
    const { totp } = await import('../server/services/totp.js');
    expect((await admin('POST', '/api/me/2fa/enable', { code: totp(setup.secret) })).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const c = client(base, { 'x-forwarded-for': `203.0.113.${i + 1}` });
      statuses.push((await c('POST', '/api/auth/login', { email: 'two@example.com', password: 'geheim123', code: String(100000 + i) })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Even the right code waits now.
    const c = client(base, { 'x-forwarded-for': '198.51.100.7' });
    expect((await c('POST', '/api/auth/login', { email: 'two@example.com', password: 'geheim123', code: totp(setup.secret) })).status).toBe(429);
    expect(inst.app.db.all(`SELECT action FROM audit_log WHERE action = 'login.2fa_failed'`).length).toBe(10);
    await inst.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('transport, headers and request limits', () => {
  const mk = async (over: Record<string, any> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-h-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(dir, 'web'), { recursive: true });
    writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>app</title>');
    mkdirSync(join(dir, 'web-secret'), { recursive: true });
    writeFileSync(join(dir, 'web-secret', 'x.txt'), 'top secret');
    const inst = createApp({ port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'x.db'), baseUrl: 'https://crm.example.com', webDir: join(dir, 'web'), behindProxy: true, tickMs: 0, secret: 's', ...over }, MODULES);
    const server = await inst.listen();
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    return { inst, base, close: async () => (await inst.close(), rmSync(dir, { recursive: true, force: true })) };
  };

  it('sends HSTS behind HTTPS, nosniff, referrer and permissions policy; the app shell gets CSP, XFO and COOP', async () => {
    const h = await mk();
    const r = await fetch(`${h.base}/healthz`);
    expect(r.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(r.headers.get('permissions-policy')).toMatch(/camera=\(\)/);
    const shell = await fetch(`${h.base}/app/contacts`);
    expect(shell.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(shell.headers.get('content-security-policy')).toMatch(/script-src 'self';/);
    expect(shell.headers.get('x-frame-options')).toBe('DENY');
    expect(shell.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    // A sibling folder that only shares the web folder's name prefix is not reachable.
    expect((await fetch(`${h.base}/..%2fweb-secret%2fx.txt`)).status).toBe(403);
    expect((await fetch(`${h.base}/%E0%A4%A`)).status).toBe(400);
    await h.close();
  });

  it('public pages without their own policy get a baseline CSP', async () => {
    const t = await startTestApp();
    await t.setup();
    const form = (await t.api.post('/api/forms', { name: 'Kontakt' })).data;
    const page = await t.api.raw(`/f/${form.id}`);
    expect(page.headers.get('content-security-policy')).toMatch(/object-src 'none'/);
    // Pages with their own policy keep it (funnels: sandbox).
    const f = (await t.api.post('/api/funnels', { name: 'Seite', template: 'leadmagnet' })).data;
    const fp = await t.api.raw(`/p/${f.slug}`);
    expect(fp.headers.get('content-security-policy')).toMatch(/^sandbox/);
    await t.close();
  });

  it('caps bodies: 1 MB public, 12 MB behind a login, nothing read without one', async () => {
    const t = await startTestApp();
    await t.setup();
    const big = (n: number) => JSON.stringify({ x: 'a'.repeat(n) });
    const pub = await t.api.raw('/api/public/chat/x/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big(1.2 * 1024 * 1024) });
    expect(pub.status).toBe(413);
    const form = (await t.api.post('/api/forms', { name: 'Upload' })).data;
    const sub = await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big(2 * 1024 * 1024) });
    expect(sub.status).not.toBe(413);
    const authed = await t.api.raw('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': t.api.location }, body: big(11 * 1024 * 1024) });
    expect(authed.status).not.toBe(413);
    const tooBig = await t.api.raw('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': t.api.location }, body: big(13 * 1024 * 1024) });
    expect(tooBig.status).toBe(413);
    const anon = await t.api.raw('/api/contacts', { method: 'POST', headers: { 'content-type': 'application/json', 'x-location-id': t.api.location }, body: big(5 * 1024 * 1024) });
    expect(anon.status).toBe(401);
    await t.close();
  });

  it('limits public writes per address and trusts only the X-Forwarded-For entry our proxy added', async () => {
    const h = await mk({ baseUrl: 'http://localhost' });
    const post = (xff: string) => fetch(`${h.base}/api/public/reviews/nope`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: '{}' });
    const codes: number[] = [];
    // A made-up left-most entry changes nothing: the right-most (added by the proxy) is the address.
    for (let i = 0; i < 121; i++) codes.push((await post(`10.0.${i}.1, 198.51.100.9`)).status);
    expect(codes.slice(0, 120).includes(429)).toBe(false);
    expect(codes[120]).toBe(429);
    expect((await post('198.51.100.10')).status).not.toBe(429);
    await h.close();
  });

  it('clamps page sizes (LIMIT -1 would mean "everything" in SQLite)', async () => {
    const { clampLimit } = await import('../server/core/http.js');
    expect(clampLimit('-1', 50, 500)).toBe(1);
    expect(clampLimit('99999', 50, 500)).toBe(500);
    expect(clampLimit(undefined, 50, 500)).toBe(50);
    expect(clampLimit('2.7', 50, 500)).toBe(2);
  });
});

describe('uploads, exports and redirects', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(async () => t.close());

  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  it('stores uploads under an extension from the checked type, never the client name', async () => {
    const up = (await t.api.post('/api/uploads', { name: 'evil.html', data: PNG })).data;
    expect(up.file).toMatch(/\.png$/);
    const r = await t.api.raw(`/uploads/${up.file}`);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect((await t.api.post('/api/uploads', { name: 'x.png', data: `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}` })).status).toBe(400);
  });

  it('form uploads must match their type', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Datei', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email', required: true }, { id: 'f', type: 'file', label: 'Bild', name: 'bild' }] })).data;
    const submit = (bild: any) => t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'f@example.com', bild }) });
    expect((await submit({ name: 'a.png', data: `data:image/png;base64,${Buffer.from('<html><script>x</script>').toString('base64')}` })).status).toBe(400);
    expect((await submit({ name: 'a.txt', data: `data:text/plain;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` })).status).toBe(400);
    expect((await submit({ name: 'a.png', data: PNG })).status).toBe(200);
  });

  it('CSV exports neutralise spreadsheet formulas', async () => {
    const { csvSafe } = await import('../server/core/csv.js');
    expect(csvSafe('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(csvSafe('-12,5')).toBe('-12,5');
    expect(csvSafe('@SUM(A1)')).toBe(`'@SUM(A1)`);
    await t.api.post('/api/contacts', { email: 'csv@example.com', first_name: '=HYPERLINK("https://evil.example","klick")' });
    const csv = await (await t.api.raw('/api/contacts/export.csv', { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } })).text();
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""klick"")"`);
  });

  it('the consent redirect stays on the site even with control characters', async () => {
    for (const r of ['/%09/evil.example', '//evil.example', '/\\evil.example', 'https://evil.example']) {
      const res = await t.api.raw(`/a/consent?v=1&r=${encodeURIComponent(decodeURIComponent(r))}`, { redirect: 'manual' });
      expect(res.headers.get('location'), r).toBe('/');
    }
  });
});

describe('denial of service', () => {
  it('markdown links/images are linear on hostile input (member posts are rendered on every view)', async () => {
    const { renderMarkdown, stripMarkdown } = await import('../server/services/markdown.js');
    const { stripMarkdownImages } = await import('../server/services/community.js');
    for (const evil of ['[a]('.repeat(20000), '![a]('.repeat(20000)]) {
      const t0 = Date.now();
      renderMarkdown(evil, { embeds: true });
      stripMarkdown(evil);
      stripMarkdownImages(evil);
      expect(Date.now() - t0).toBeLessThan(150);
    }
    // One level of parentheses in a URL still works (and javascript: stays blocked).
    expect(renderMarkdown('[Wiki](https://de.wikipedia.org/wiki/Bonn_(Stadt))')).toContain('href="https://de.wikipedia.org/wiki/Bonn_(Stadt)"');
    expect(renderMarkdown('[x](javascript:alert(1))')).toContain('href="#"');
  });

  it('MCP takes large bodies only with a valid key', async () => {
    const t = await startTestApp();
    await t.setup();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(2 * 1024 * 1024) });
    expect((await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pghl_wrong' }, body })).status).toBe(413);
    const key = (await t.api.post('/api/api-keys', { name: 'mcp' })).data.key;
    expect((await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body })).status).toBe(200);
    await t.close();
  });
});

describe('constant-time secret comparison', () => {
  it('safeEqual compares tokens without early exit and never accepts empty values', async () => {
    const { safeEqual } = await import('../server/core/util.js');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(null, undefined)).toBe(false);
  });

  it('inbound SMS/mail and workflow webhooks refuse wrong keys', async () => {
    const t = await startTestApp();
    await t.setup();
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const sms = new URL(urls.sms);
    const good = await t.api.raw(`${sms.pathname}${sms.search}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491701111111', body: 'Hallo' }) });
    expect(good.status).toBe(200);
    const bad = await t.api.raw(`${sms.pathname}?key=${'x'.repeat(24)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '+491701111111', body: 'Hallo' }) });
    expect(bad.status).toBe(401);
    await t.close();
  });
});
