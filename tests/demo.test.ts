import dns from 'node:dns';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { DEMO_PAGE_NOTE, demoBlocks, withDemoNote } from '../server/modules/demo.js';
import { deliverEmail, deliverSms } from '../server/services/messaging.js';
import { safeFetch } from '../server/services/net.js';
import { blockedConnections, installOutboundGuard, isLoopbackHost, outboundGuardActive, uninstallOutboundGuard } from '../server/services/outbound-guard.js';

/** 'EDEMOBLOCKED' when the guard refused the call somewhere down the error chain (clients re-wrap errors). */
const errCode = (e: any): string | undefined => {
  for (let x = e, i = 0; x && i < 5; x = x.cause, i++) if (x.code === 'EDEMOBLOCKED' || String(x.message ?? '').includes('Demo-Modus: Verbindung nach außen gesperrt')) return 'EDEMOBLOCKED';
  return e?.code ?? e?.cause?.code;
};

describe('outbound guard', () => {
  afterAll(() => uninstallOutboundGuard());

  it('knows loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.8.9.1', '::1', '[::1]', '::ffff:127.0.0.1', 'app.localhost']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['example.com', '10.0.0.1', '192.168.1.5', '8.8.8.8', 'localhost.example.com', '2a00:1450::1']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('refuses every non-loopback connection (fetch, raw sockets, http.request) and keeps loopback working', async () => {
    const t = await startTestApp();
    try {
      installOutboundGuard();
      expect(outboundGuardActive()).toBe(true);
      const e1 = await fetch('https://example.com/').catch((e) => e);
      expect(errCode(e1)).toBe('EDEMOBLOCKED');
      const e2 = await new Promise<any>((r) => net.connect(25, 'smtp.example.com').on('error', r).on('connect', () => r(null)));
      expect(errCode(e2)).toBe('EDEMOBLOCKED');
      const e3 = await safeFetch('https://hooks.example.org/x', { method: 'POST', body: '{}' }).catch((e) => e);
      expect(errCode(e3)).toBe('EDEMOBLOCKED');
      const e4 = await new Promise<any>((r) => dns.resolve4('mail.example.net', (err) => r(err)));
      expect(errCode(e4)).toBe('EDEMOBLOCKED');
      // node:dns/promises has its own Resolver class (the e-mail deliverability check uses it).
      const e5 = await new dns.promises.Resolver().resolveTxt('kunde.example.net').catch((e) => e);
      expect(errCode(e5)).toBe('EDEMOBLOCKED');
      expect(blockedConnections().map((b) => b.host)).toEqual(expect.arrayContaining(['example.com', 'smtp.example.com', 'hooks.example.org', 'mail.example.net']));
      // The app's own server and other loopback services still work.
      expect((await t.api.get('/api/version')).status).toBe(200);
    } finally {
      uninstallOutboundGuard();
      await t.close();
    }
    expect(outboundGuardActive()).toBe(false);
  });
});

describe('demo mode write rules', () => {
  it('blocks account takeover, real credentials and integrations – but not normal work', () => {
    const w = (method: string, path: string, body: any = {}) => demoBlocks({ method, path, body });
    expect(w('POST', '/api/me/password')).toBe(true);
    expect(w('POST', '/api/me/2fa/setup')).toBe(true);
    expect(w('POST', '/api/users')).toBe(true);
    expect(w('PATCH', '/api/users/u1')).toBe(true);
    expect(w('DELETE', '/api/locations/l1')).toBe(true);
    expect(w('PUT', '/api/stripe')).toBe(true);
    expect(w('PUT', '/api/settings/meta')).toBe(true);
    expect(w('PUT', '/api/telephony/settings')).toBe(true);
    expect(w('POST', '/api/webhooks')).toBe(true);
    expect(w('POST', '/api/hooks')).toBe(true);
    expect(w('PATCH', '/api/agency/oauth')).toBe(true);
    expect(w('PATCH', '/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.example.com' } } })).toBe(true);
    expect(w('PATCH', '/api/location', { settings: { sms: { provider: 'twilio' } } })).toBe(true);
    // Allowed: reading, normal CRM work, profile edits, the seed itself.
    expect(w('GET', '/api/stripe')).toBe(false);
    expect(w('POST', '/api/contacts')).toBe(false);
    expect(w('POST', '/api/messages')).toBe(false);
    expect(w('PATCH', '/api/location', { name: 'Neuer Name' })).toBe(false);
    expect(demoBlocks({ method: 'PUT', path: '/api/stripe', body: {}, demoSeed: true })).toBe(false);
  });

  it('keeps own domains off – no certificate for a stranger\'s domain – but not the rest of those forms', () => {
    const w = (method: string, path: string, body: any = {}) => demoBlocks({ method, path, body });
    expect(w('PATCH', '/api/funnels/f1', { domain: 'phish.example.org' })).toBe(true);
    expect(w('PATCH', '/api/agency/locations/l1/branding', { app_domain: 'crm.example.org' })).toBe(true);
    expect(w('PUT', '/api/helpdesk/settings', { help_center: { domain: 'help.example.org' } })).toBe(true);
    expect(w('PATCH', '/api/funnels/f1', { name: 'Neue Seite', domain: '' })).toBe(false);
    expect(w('PATCH', '/api/agency/locations/l1/branding', { name: 'Kunde', color: '#ff0000' })).toBe(false);
    expect(w('PUT', '/api/helpdesk/settings', { help_center: { enabled: true } })).toBe(false);
    // A company's website domain is CRM data, not hosting.
    expect(w('POST', '/api/companies', { name: 'Acme', domain: 'acme.example' })).toBe(false);
  });

  it('marks public pages as a demo, once', () => {
    const out = withDemoNote('<html><body class="x"><h1>Hallo</h1></body></html>');
    expect(out).toMatch(/^<html><body class="x"><div role="note" data-pghl-demo[^>]*>Demo-Instanz/);
    expect(withDemoNote(out)).toBe(out);
    expect(withDemoNote('<p>ohne body</p>')).toContain(DEMO_PAGE_NOTE);
  });
});

describe('demo mode (PGHL_DEMO_MODE=1)', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  // Every connection the guard lets through reaches this spy – it must only ever see loopback.
  const passed: string[] = [];
  let realConnect: typeof net.Socket.prototype.connect;

  beforeAll(async () => {
    realConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
      const a = Array.isArray(args[0]) ? args[0] : args;
      const o = a[0];
      passed.push(o && typeof o === 'object' ? String(o.path ?? o.host ?? 'localhost') : typeof o === 'string' && !/^\d+$/.test(o) ? o : String(a[1] ?? 'localhost'));
      return (realConnect as any).apply(this, args);
    } as any;
    t = await startTestApp({ demoMode: true });
    for (let i = 0; i < 600 && !(await t.api.get('/api/version')).data.demo?.last_reset; i++) await new Promise((r) => setTimeout(r, 50));
  }, 45_000);

  afterAll(async () => {
    await t.close();
    uninstallOutboundGuard();
    net.Socket.prototype.connect = realConnect;
  });

  it('seeds fictional data and shows the demo login', async () => {
    const v = (await t.api.get('/api/version')).data;
    expect(v).toMatchObject({ name: 'HyperLevel', demo: { enabled: true, login: { email: 'demo@example.com', password: 'demo1234' }, reset_hour: 3 } });
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    const n = (sql: string) => Number(t.app.db.get(sql)?.n ?? 0);
    // The agency „Nordlicht Digital“ (white-label) and its five clients, each with a believable amount of data.
    expect(t.app.db.all('SELECT name FROM locations ORDER BY name').map((r: any) => r.name)).toEqual(['Elektro Meyer', 'FitWerk Coaching', 'Nordlicht Digital', 'Praxis Sonnenweg', 'Rösterei Hafenbohne', 'Taktwerk Software']);
    expect(n(`SELECT COUNT(*) n FROM locations WHERE json_extract(settings, '$.branding.name') = 'Nordlicht Digital'`)).toBe(5);
    expect(n('SELECT COUNT(*) n FROM contacts')).toBeGreaterThan(150);
    expect(n('SELECT COUNT(*) n FROM opportunities')).toBeGreaterThan(40);
    expect(n('SELECT COUNT(*) n FROM appointments')).toBeGreaterThan(200);
    expect(n('SELECT COUNT(*) n FROM appointment_series')).toBe(6);
    expect(n('SELECT COUNT(*) n FROM invoices')).toBeGreaterThan(60);
    expect(n(`SELECT COUNT(*) n FROM invoices WHERE leitweg_id != ''`)).toBeGreaterThan(0);
    expect(n('SELECT COUNT(*) n FROM tickets')).toBeGreaterThan(10);
    expect(n(`SELECT COUNT(*) n FROM messages WHERE channel = 'whatsapp'`)).toBeGreaterThan(0);
    expect(n('SELECT COUNT(*) n FROM store_orders')).toBeGreaterThan(5);
    expect(n('SELECT COUNT(*) n FROM review_items')).toBeGreaterThan(10);
    expect(n('SELECT COUNT(*) n FROM pm_time_entries')).toBeGreaterThan(0);
    // Coloured tags, and phone numbers only from the test range.
    expect(n(`SELECT COUNT(*) n FROM tags WHERE color != ''`)).toBeGreaterThan(20);
    expect(n(`SELECT COUNT(*) n FROM contacts WHERE phone != '' AND phone NOT LIKE '+49301234%'`)).toBe(0);
    // Fictional addresses only, and nothing was really sent.
    expect(n(`SELECT COUNT(*) n FROM contacts WHERE email != '' AND email NOT LIKE '%@example.com' AND email NOT LIKE '%@example.org' AND email NOT LIKE '%@example.net' AND email NOT LIKE '%.example'`)).toBe(0);
    expect(n(`SELECT COUNT(*) n FROM messages WHERE direction = 'out' AND status NOT IN ('logged', 'failed')`)).toBe(0);
  });

  it('signs in with one click and refuses dangerous writes', async () => {
    expect((await t.api.post('/api/demo/login')).status).toBe(200);
    const me = await t.api.get('/api/me');
    expect(me.data.user.email).toBe('demo@example.com');
    t.api.setLocation(me.data.locations[0].id);
    for (const [method, path, body] of [
      ['post', '/api/me/password', { current: 'demo1234', next: 'gekapert123' }],
      ['post', '/api/users', { email: 'x@example.com', password: 'geheim123' }],
      ['put', '/api/stripe', { secret_key: 'sk_test_x' }],
      ['patch', '/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.example.com', port: 587 } } }],
      ['post', '/api/webhooks', { url: 'https://hooks.example.org/x' }],
    ] as const) {
      const r = await (t.api as any)[method](path, body);
      expect(r.status, path).toBe(403);
      expect(r.data.error).toContain('Demo-Modus');
    }
    // Normal work is allowed – and an e-mail to a contact is only stored.
    const c = await t.api.post('/api/contacts', { first_name: 'Probe', email: 'probe@example.com' });
    expect(c.status).toBe(200);
    const m = await t.api.post('/api/messages', { contact_id: c.data.id, channel: 'email', subject: 'Hallo', body: 'Test' });
    expect(m.status).toBe(200);
    expect(m.data.status).toBe('logged');
  });

  it('opens straight from a link – /demo signs in and lands in the app, only app paths as next', async () => {
    const r = await t.api.raw('/demo', { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/app');
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
    expect(cookie).toMatch(/=.{20,}/);
    const me = await t.api.raw('/api/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe('demo@example.com');
    expect((await t.api.raw('/demo?next=/app/contacts', { redirect: 'manual' })).headers.get('location')).toBe('/app/contacts');
    for (const next of ['https://evil.example/', '//evil.example/app', '/api/me', '/app/../api/me', '/app\\evil', '/apply']) {
      expect((await t.api.raw(`/demo?next=${encodeURIComponent(next)}`, { redirect: 'manual' })).headers.get('location'), next).toBe('/app');
    }
  });

  it('lets nothing leave the server, even with real providers configured behind its back', async () => {
    const loc = t.app.location(t.app.db.get('SELECT id FROM locations LIMIT 1')!.id)!;
    const smtp = { ...loc, settings: { ...loc.settings, email: { provider: 'smtp', host: 'smtp.example.com', port: 587, user: 'u', pass: 'p' } } };
    const twilio = { ...loc, settings: { ...loc.settings, sms: { provider: 'twilio', accountSid: 'AC1', authToken: 't', from: '+4930231250' } } };
    const gateway = { ...loc, settings: { ...loc.settings, sms: { provider: 'http', url: 'https://sms-gateway.example.net/send' } } };
    expect(errCode(await deliverEmail(smtp, { to: 'a@example.com', subject: 'x', html: 'x', text: 'x' }).catch((e) => e))).toBe('EDEMOBLOCKED');
    expect(errCode(await deliverSms(twilio, '+4930231251', 'x').catch((e) => e))).toBe('EDEMOBLOCKED');
    expect(errCode(await deliverSms(gateway, '+4930231251', 'x').catch((e) => e))).toBe('EDEMOBLOCKED');
    // WhatsApp/Meta, Stripe, Postiz, Anthropic … all use fetch.
    for (const url of ['https://graph.facebook.com/v21.0/me', 'https://api.stripe.com/v1/checkout/sessions', 'https://postiz.example.com/public/v1/posts', 'https://api.anthropic.com/v1/messages']) {
      expect(errCode(await fetch(url, { method: 'POST', body: '{}' }).catch((e) => e)), url).toBe('EDEMOBLOCKED');
    }
    const outbox = (await t.api.get('/api/demo/outbox')).data;
    expect(outbox.guard).toBe(true);
    expect(outbox.blocked.map((b: any) => b.host)).toEqual(expect.arrayContaining(['smtp.example.com', 'api.twilio.com', 'sms-gateway.example.net', 'graph.facebook.com', 'api.stripe.com', 'api.anthropic.com']));
    // The spy behind the guard only ever saw loopback connections.
    expect(passed.length).toBeGreaterThan(0);
    expect(passed.filter((h) => !isLoopbackHost(h))).toEqual([]);
  });

  it('keeps sign-ups closed and puts a note and noindex on public pages', async () => {
    // No self-service accounts: the SaaS sign-up is off and its settings are locked, new logins cannot be created.
    expect((await t.api.raw('/signup', { redirect: 'manual' })).status).toBe(404);
    expect((await t.api.put('/api/saas/settings', { signup_enabled: true })).status).toBe(403);
    // A website page of the demo carries the note and stays out of search engines.
    const site = (await t.api.get('/api/funnels')).data.find((f: any) => f.kind === 'website') ?? (await t.api.get('/api/funnels')).data[0];
    const page = await t.api.raw(new URL(site.url).pathname);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await page.text()).toContain(DEMO_PAGE_NOTE);
    // Connecting an own domain is refused.
    const r = await t.api.patch(`/api/funnels/${site.id}`, { domain: 'phish.example.org' });
    expect(r.status).toBe(403);
    expect(t.app.db.get('SELECT domain FROM funnels WHERE id = ?', site.id)?.domain ?? null).toBeNull();
  });

  it('resets everything once a night', async () => {
    const before = (await t.api.post('/api/contacts', { first_name: 'Wird', last_name: 'Gelöscht', email: 'weg@example.com' })).data.id;
    expect(t.app.db.get('SELECT id FROM contacts WHERE id = ?', before)).toBeTruthy();
    // Not yet due today: nothing happens.
    await t.app.tick();
    expect(t.app.db.get('SELECT id FROM contacts WHERE id = ?', before)).toBeTruthy();
    // Pretend the last reset was yesterday and the reset hour has passed.
    const prev = process.env.PGHL_DEMO_RESET_HOUR;
    process.env.PGHL_DEMO_RESET_HOUR = '0';
    try {
      t.app.db.run(`UPDATE demo_state SET value = '2000-01-01' WHERE key = 'last_reset_day'`);
      await t.app.tick();
    } finally {
      if (prev === undefined) delete process.env.PGHL_DEMO_RESET_HOUR;
      else process.env.PGHL_DEMO_RESET_HOUR = prev;
    }
    expect(t.app.db.get('SELECT id FROM contacts WHERE id = ?', before)).toBeUndefined();
    expect(t.app.db.get(`SELECT id FROM users WHERE email = 'demo@example.com'`)).toBeTruthy();
    expect(Number(t.app.db.get('SELECT COUNT(*) n FROM locations')?.n)).toBe(6);
    // The search indexes survive the wipe (their shadow tables are not emptied by hand).
    const fts = t.app.db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%fts5%'`).map((r: any) => String(r.name));
    expect(fts.length).toBeGreaterThan(0);
    for (const v of fts) expect(() => t.app.db.run(`INSERT INTO "${v}"("${v}") VALUES('integrity-check')`)).not.toThrow();
    // The old session is gone with the reset.
    expect((await t.api.get('/api/me')).status).toBe(401);
  });
});

describe('demo mode safety', () => {
  it('never wipes a database with real users that demo mode did not seed', async () => {
    const t = await startTestApp();
    try {
      await t.setup();
      expect(await t.app.services.demo.reset('test')).toBeNull();
      expect(t.app.db.get(`SELECT id FROM users WHERE email = 'chef@example.com'`)).toBeTruthy();
      // Without PGHL_DEMO_MODE nothing is restricted and no demo info is published.
      expect((await t.api.get('/api/version')).data.demo).toBeNull();
      expect((await t.api.post('/api/demo/login')).status).toBe(404);
      expect(outboundGuardActive()).toBe(false);
    } finally {
      await t.close();
    }
  });
});
