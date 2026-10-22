import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { startTestApp } from './helpers.js';
import { G_CLIENT, MS_CLIENT } from './oauth-fakes.js';
import { createAuthenticator, createGithub, createIdp, fetchRouter, type Account, type Tamper } from './auth-fakes.js';
import { totp } from '../server/services/totp.js';

/** A browser: own cookie jar, optional Host header (client login domains) and user agent (Android app). */
function browser(base: string, o: { host?: string; ua?: string } = {}) {
  const jar = new Map<string, string>();
  const u0 = new URL(base);
  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any; headers: Record<string, any> }> {
    return new Promise((resolve, reject) => {
      const form = typeof body === 'string';
      const payload = body === undefined ? undefined : form ? (body as string) : JSON.stringify(body);
      const req = request(
        {
          hostname: u0.hostname,
          port: u0.port,
          path,
          method,
          headers: {
            'x-pghl': '1',
            ...(payload !== undefined ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
            ...(o.host ? { host: o.host } : {}),
            ...(o.ua ? { 'user-agent': o.ua } : {}),
            ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
              const [pair] = c.split(';');
              const i = pair.indexOf('=');
              const k = pair.slice(0, i);
              const v = pair.slice(i + 1);
              if (!v || /Max-Age=0/i.test(c)) jar.delete(k);
              else jar.set(k, v);
            }
            const text = Buffer.concat(chunks).toString('utf8');
            let data: any = text;
            if (String(res.headers['content-type'] ?? '').includes('json')) data = JSON.parse(text || 'null');
            resolve({ status: res.statusCode ?? 0, data, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
  return {
    jar,
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b: unknown = {}, h?: Record<string, string>) => call('POST', p, b, h),
    put: (p: string, b: unknown = {}) => call('PUT', p, b),
    patch: (p: string, b: unknown = {}) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Browser = ReturnType<typeof browser>;

/**
 * Turns on 2FA with the previous step's code, so the current one stays unused for the sign-in that follows. Waits out the
 * last seconds of a 30 s step first: on a busy machine the code could otherwise be two steps old when the server checks it.
 */
async function enable2fa(b: Browser, secret: string) {
  const left = 30_000 - (Date.now() % 30_000);
  if (left < 5_000) await new Promise((r) => setTimeout(r, left + 100));
  expect((await b.post('/api/me/2fa/enable', { code: totp(secret, Date.now() - 30_000) })).status).toBe(200);
}

const ISSUER = 'https://idp.test/realms/acme';

async function world() {
  const t = await startTestApp();
  const me = await t.setup();
  const locId = me.locations[0].id;
  const kc = createIdp({ issuer: ISSUER, clientId: 'gohigh', clientSecret: 'kc-secret' });
  const google = createIdp({ issuer: 'https://accounts.google.com', clientId: G_CLIENT.client_id, clientSecret: G_CLIENT.client_secret, endpoints: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' } });
  const ms = createIdp({
    issuer: 'ms',
    issuerFor: (a) => `https://login.microsoftonline.com/${a.tid}/v2.0`,
    clientId: MS_CLIENT.client_id,
    clientSecret: MS_CLIENT.client_secret,
    endpoints: { authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' },
  });
  const appleKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const apple = createIdp({ issuer: 'https://appleid.apple.com', clientId: 'com.example.web', auth: 'apple', appleKey: appleKey.publicKey, endpoints: { authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys' } });
  const gh = createGithub('Iv1.0123456789abcdef', 'gh-secret');
  const router = fetchRouter([kc, google, ms, apple, gh]);
  t.app.services.ssoFetch = router.fetch;
  const mails: { to: string; subject: string; text: string }[] = [];
  t.app.services.authMailer = async (_loc: unknown, mail: any) => (mails.push(mail), { status: 'sent' });
  return { t, locId, kc, google, ms, apple, gh, router, mails, appleKey, browser: (o?: { host?: string; ua?: string }) => browser(t.base, o) };
}
type World = Awaited<ReturnType<typeof world>>;

/** Start → consent at the fake → callback → poll, like a browser would. */
async function sso(b: Browser, provider: string, fake: { authorize: (url: string, a: any, x?: any) => { code: string; state: string; redirect: string } }, account: any, opts: { tamper?: Tamper; extra?: any; next?: string; post?: Record<string, string> } = {}) {
  const start = await b.post('/api/auth/sso/start', { provider, next: opts.next ?? '/app/contacts' });
  if (start.status !== 200) return { start } as any;
  const a = (fake.authorize as any)(start.data.url, account, opts.tamper ?? opts.extra);
  const cbPath = new URL(a.redirect).pathname;
  const callback = opts.post
    ? await b.post(cbPath, new URLSearchParams({ code: a.code, state: a.state, ...opts.post }).toString())
    : await b.get(`${cbPath}?${new URLSearchParams({ code: a.code, state: a.state })}`);
  const poll = await b.post('/api/auth/sso/poll');
  return { start, auth: a, callback, poll, url: new URL(start.data.url) };
}

describe('generic OIDC (Keycloak-like) with JIT, groups and enforced SSO', () => {
  let w: World;
  let providerId = '';
  beforeAll(async () => {
    w = await world();
    const r = await w.t.api.post('/api/agency/sso', {
      name: 'Acme SSO',
      slug: 'acme',
      preset: 'keycloak',
      issuer: ISSUER,
      client_id: 'gohigh',
      client_secret: 'kc-secret',
      config: { jit: true, group_rules: [{ group: 'crm-admins', role: 'admin' }, { group: 'kunde-a', locations: [w.locId], permissions: ['contacts'] }], enforce_domains: ['acme.test'], sync_roles: true },
    });
    expect(r.status).toBe(200);
    providerId = r.data.id;
  });
  afterAll(() => w.t.close());

  it('stores the provider with a sealed secret and tests discovery + keys', async () => {
    const list = await w.t.api.get('/api/agency/sso');
    expect(list.data.providers[0]).toMatchObject({ slug: 'acme', client_secret: '••••••', redirect_uris: ['http://localhost/auth/sso/acme/callback'], enabled: true });
    expect(JSON.stringify(list.data)).not.toContain('kc-secret');
    const test = await w.t.api.post(`/api/agency/sso/${providerId}/test`);
    expect(test.data).toMatchObject({ ok: true, issuer: ISSUER, keys: 2, pkce: true });
    expect((await w.t.api.post('/api/agency/sso', { name: 'X', slug: 'google', issuer: ISSUER, client_id: 'x' })).status).toBe(400);
    expect((await w.t.api.post('/api/agency/sso', { name: 'X', slug: 'x2', issuer: ISSUER, client_id: 'x', config: { enforce_domains: ['acme.test'] } })).data.error).toMatch(/schon/);
    expect((await w.t.api.post('/api/agency/sso', { name: 'G', slug: 'gws', preset: 'google', issuer: 'https://accounts.google.com', client_id: 'x' })).data.error).toMatch(/Domains/);
    const methods = await w.browser().get('/api/auth/methods');
    expect(methods.data.providers).toEqual([{ id: `oidc:${providerId}`, label: 'Acme SSO', icon: 'key' }]);
  });

  it('signs in with PKCE + nonce, creates the account just in time and maps groups', async () => {
    const b = w.browser();
    const r = await sso(b, `oidc:${providerId}`, w.kc, { sub: 'kc-anna', email: 'anna@acme.test', email_verified: true, name: 'Anna Acme', groups: ['kunde-a'] });
    expect(r.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.url.searchParams.get('nonce')).toMatch(/^[\w-]{20,}$/);
    expect(r.url.searchParams.get('redirect_uri')).toBe('http://localhost/auth/sso/acme/callback');
    expect(r.callback.status).toBe(303);
    expect(r.callback.headers.location).toBe('http://localhost/app/');
    expect(r.poll.data).toMatchObject({ done: true, next: '/app/contacts', user: { email: 'anna@acme.test', role: 'member' } });
    // the token endpoint got the PKCE verifier and HTTP basic client auth
    const call = w.kc.state.calls.at(-1)!;
    expect(new URLSearchParams(call.body).get('code_verifier')).toMatch(/^[\w-]{43,}$/);
    expect(call.headers.authorization).toMatch(/^Basic /);
    const me = await b.get('/api/me');
    expect(me.data.user).toMatchObject({ email: 'anna@acme.test', locations: [w.locId], permissions: ['contacts'] });
    // the session remembers how it was made
    const sess = w.t.app.db.get('SELECT auth_method, auth_mfa FROM sessions WHERE user_id = ?', me.data.user.id);
    expect(sess).toMatchObject({ auth_method: `sso:oidc:${providerId}`, auth_mfa: 1 });
    expect(w.t.app.db.get('SELECT password_set FROM users WHERE email = ?', 'anna@acme.test')?.password_set).toBe(0);
  });

  it('syncs roles from groups on the next login and keeps one account per subject', async () => {
    const b = w.browser();
    const r = await sso(b, `oidc:${providerId}`, w.kc, { sub: 'kc-anna', email: 'anna@acme.test', email_verified: true, groups: ['crm-admins'] });
    expect(r.poll.data.user.role).toBe('admin');
    expect(w.t.app.db.all('SELECT id FROM users WHERE email = ?', 'anna@acme.test')).toHaveLength(1);
    expect(w.t.app.db.all('SELECT id FROM auth_identities WHERE subject = ?', 'kc-anna')).toHaveLength(1);
  });

  it('rejects bad signatures, expired tokens, wrong audience and a replayed nonce', async () => {
    const acc: Account = { sub: 'kc-bob', email: 'bob@acme.test', email_verified: true };
    for (const [tamper, msg] of [
      [{ badSignature: true }, /Signatur/],
      [{ expired: true }, /abgelaufen/],
      [{ aud: 'someone-else' }, /aud/],
      [{ iss: 'https://evil.test' }, /iss/],
      [{ nonce: 'from-an-old-login' }, /nonce/],
      [{ noIdToken: true }, /ID-Token/],
    ] as [Tamper, RegExp][]) {
      const b = w.browser();
      const r = await sso(b, `oidc:${providerId}`, w.kc, acc, { tamper });
      expect(r.poll.data.error, JSON.stringify(tamper)).toMatch(msg);
      expect((await b.get('/api/me')).status).toBe(401);
    }
    // ES256-signed tokens are fine too
    const ok = await sso(w.browser(), `oidc:${providerId}`, w.kc, acc, { tamper: { alg: 'ES256' } });
    expect(ok.poll.data.done).toBe(true);
    // the same callback a second time: the flow is gone
    const again = await w.browser().get(`${new URL(ok.auth.redirect).pathname}?code=${ok.auth.code}&state=${ok.auth.state}`);
    expect(again.status).toBe(400);
    expect(again.data).toContain('abgelaufen');
  });

  it('a finished login can only be redeemed by the browser that started it (no login CSRF)', async () => {
    const victim = w.browser();
    const attacker = w.browser();
    const start = await attacker.post('/api/auth/sso/start', { provider: `oidc:${providerId}` });
    const a = w.kc.authorize(start.data.url, { sub: 'kc-mallory', email: 'mallory@acme.test', email_verified: true });
    // the attacker makes the victim's browser open the callback …
    const cb = await victim.get(`/auth/sso/acme/callback?code=${a.code}&state=${a.state}`);
    expect(cb.status).toBe(303);
    // … but the ticket belongs to the attacker's flow cookie
    expect((await victim.post('/api/auth/sso/poll')).data).toEqual({ pending: false });
    expect((await victim.get('/api/me')).status).toBe(401);
    expect((await attacker.post('/api/auth/sso/poll')).data.done).toBe(true);
    expect((await w.browser().post('/api/auth/sso/poll', {}, { 'x-pghl': '' })).status).toBe(403);
  });

  it('enforces SSO for its e-mail domain: no password, no magic link, discovery points to the IdP', async () => {
    await w.t.api.post('/api/users', { email: 'carl@acme.test', name: 'Carl', password: 'geheim123', role: 'member', locations: [w.locId] });
    const b = w.browser();
    const login = await b.post('/api/auth/login', { email: 'carl@acme.test', password: 'geheim123' });
    expect(login.status).toBe(403);
    expect(login.data.error).toMatch(/Acme SSO.*vorgeschrieben/);
    expect((await b.post('/api/auth/discover', { email: 'carl@acme.test' })).data).toEqual({ sso: { id: `oidc:${providerId}`, label: 'Acme SSO' }, password: false });
    expect((await b.post('/api/auth/discover', { email: 'x@other.test' })).data).toEqual({ sso: null, password: true });
    // the existing account is linked automatically on the first SSO login
    const r = await sso(b, `oidc:${providerId}`, w.kc, { sub: 'kc-carl', email: 'carl@acme.test', email_verified: true, groups: ['kunde-a'] });
    expect(r.poll.data.user.email).toBe('carl@acme.test');
    // other domains still use passwords
    expect((await w.browser().post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  });

  it('refuses unverified e-mails, unknown users without JIT and users outside the required groups', async () => {
    let r = await sso(w.browser(), `oidc:${providerId}`, w.kc, { sub: 'kc-u1', email: 'dora@acme.test', email_verified: false });
    expect(r.poll.data.error).toMatch(/nicht bestätigt/);
    await w.t.api.patch(`/api/agency/sso/${providerId}`, { config: { jit: false } });
    r = await sso(w.browser(), `oidc:${providerId}`, w.kc, { sub: 'kc-u2', email: 'eve@acme.test', email_verified: true });
    expect(r.poll.data.error).toMatch(/noch keinen Zugang/);
    await w.t.api.patch(`/api/agency/sso/${providerId}`, { config: { jit: true, require_group: true } });
    r = await sso(w.browser(), `oidc:${providerId}`, w.kc, { sub: 'kc-u3', email: 'fred@acme.test', email_verified: true, groups: ['marketing'] });
    expect(r.poll.data.error).toMatch(/Gruppe/);
    r = await sso(w.browser(), `oidc:${providerId}`, w.kc, { sub: 'kc-u3', email: 'fred@acme.test', email_verified: true, groups: ['kunde-a'] });
    expect(r.poll.data.done).toBe(true);
    await w.t.api.patch(`/api/agency/sso/${providerId}`, { config: { require_group: false } });
  });

  it('a client’s own IdP can never take over agency accounts', async () => {
    const other = (await w.t.api.post('/api/locations', { name: 'Kunde B' })).data;
    const kc2 = createIdp({ issuer: 'https://idp-b.test', clientId: 'b', clientSecret: 'b-secret' });
    const prev = w.t.app.services.ssoFetch;
    const r2 = fetchRouter([kc2]);
    w.t.app.services.ssoFetch = r2.fetch;
    const p = await w.t.api.post('/api/agency/sso', { name: 'Kunde B Login', slug: 'kunde-b', issuer: 'https://idp-b.test', client_id: 'b', client_secret: 'b-secret', location_id: other.id, config: { jit: true, group_rules: [{ group: 'x', locations: [w.locId] }] } });
    expect(p.status).toBe(200);
    expect((await w.t.api.patch(`/api/agency/sso/${p.data.id}`, { config: { default_role: 'admin', group_rules: [{ group: 'x', role: 'admin' }] } })).data.error).toMatch(/Agentur-Admins/);
    // asserting the agency admin's address does not reach that account
    let r = await sso(w.browser(), `oidc:${p.data.id}`, kc2, { sub: 'b-1', email: 'chef@example.com', email_verified: true });
    expect(r.poll.data.error).toMatch(/nicht über/);
    // new people only ever become members of that client
    r = await sso(w.browser(), `oidc:${p.data.id}`, kc2, { sub: 'b-2', email: 'kim@kunde-b.test', email_verified: true, groups: ['x'] });
    expect(r.poll.data.user).toMatchObject({ role: 'member' });
    expect(w.t.app.db.get('SELECT locations FROM users WHERE email = ?', 'kim@kunde-b.test')?.locations).toBe(JSON.stringify([other.id]));
    w.t.app.services.ssoFetch = prev;
  });
});

describe('social login, linking and the Android app', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    expect((await w.t.api.put('/api/agency/oauth', { google: { client_id: G_CLIENT.client_id, client_secret: G_CLIENT.client_secret }, microsoft: { client_id: MS_CLIENT.client_id, client_secret: MS_CLIENT.client_secret, tenant: 'common' } })).status).toBe(200);
    const pem = w.appleKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().trim();
    const r = await w.t.api.put('/api/agency/login', {
      social: { google: { enabled: true }, microsoft: { enabled: true }, github: { enabled: true, client_id: 'Iv1.0123456789abcdef', client_secret: 'gh-secret' }, apple: { enabled: true, client_id: 'com.example.web', team_id: 'TEAM123456', key_id: 'KEY1234567', private_key: pem } },
    });
    expect(r.status).toBe(200);
    expect(r.data.ready).toEqual({ google: true, microsoft: true, github: true, apple: true });
    expect(r.data.social.github.client_secret).toBe('••••••');
    expect(r.data.social.apple.private_key).toBe('••••••');
    expect(r.data.social.google.redirect_uris).toEqual(['http://localhost/auth/sso/google/callback']);
    expect(JSON.stringify(r.data)).not.toContain('gh-secret');
    await w.t.api.post('/api/users', { email: 'mia@gmail.com', name: 'Mia', password: 'geheim123', role: 'member', locations: [w.locId] });
  });
  afterAll(() => w.t.close());

  it('Google: links an existing member by verified e-mail and signs in', async () => {
    const methods = await w.browser().get('/api/auth/methods');
    expect(methods.data.providers.map((p: any) => p.id)).toEqual(['google', 'microsoft', 'github', 'apple']);
    const b = w.browser();
    const r = await sso(b, 'google', w.google, { sub: 'g-mia', email: 'mia@gmail.com', email_verified: true, name: 'Mia G' });
    expect(r.url.searchParams.get('prompt')).toBe('select_account');
    expect(r.url.searchParams.get('scope')).toBe('openid email profile');
    expect(r.poll.data).toMatchObject({ done: true, user: { email: 'mia@gmail.com' } });
    expect((await b.get('/api/me/identities')).data.identities).toMatchObject([{ provider: 'google', label: 'Google', email: 'mia@gmail.com' }]);
  });

  it('Google: unverified e-mail and closed sign-up are refused; an allowed domain gets an account', async () => {
    expect((await sso(w.browser(), 'google', w.google, { sub: 'g-x', email: 'nina@gmail.com', email_verified: false })).poll.data.error).toMatch(/nicht bestätigt/);
    expect((await sso(w.browser(), 'google', w.google, { sub: 'g-y', email: 'olga@firma.test', email_verified: true })).poll.data.error).toMatch(/nicht freigegeben/);
    await w.t.api.put('/api/agency/login', { signup: { mode: 'domains', domains: ['firma.test'], locations: [w.locId], permissions: ['contacts', 'calendars'] } });
    const r = await sso(w.browser(), 'google', w.google, { sub: 'g-y', email: 'olga@firma.test', email_verified: true, name: 'Olga' });
    expect(r.poll.data.user).toMatchObject({ email: 'olga@firma.test', role: 'member' });
    expect(w.t.app.db.get('SELECT locations, permissions, password_set FROM users WHERE email = ?', 'olga@firma.test')).toMatchObject({ locations: JSON.stringify([w.locId]), permissions: JSON.stringify(['contacts', 'calendars']), password_set: 0 });
    await w.t.api.put('/api/agency/login', { signup: { mode: 'closed' } });
  });

  it('an admin account is never linked silently: the password confirms the link', async () => {
    const b = w.browser();
    const r = await sso(b, 'google', w.google, { sub: 'g-chef', email: 'chef@example.com', email_verified: true });
    expect(r.poll.data.link_confirm).toMatchObject({ email: 'chef@example.com', provider: 'Google' });
    const token = r.poll.data.link_confirm.token;
    expect((await b.post('/api/auth/sso/link-confirm', { token, password: 'falsch' })).status).toBe(401);
    const ok = await b.post('/api/auth/sso/link-confirm', { token, password: 'geheim123' });
    expect(ok.data).toMatchObject({ done: true, user: { email: 'chef@example.com' } });
    expect((await b.post('/api/auth/sso/link-confirm', { token, password: 'geheim123' })).status).toBe(410);
    // next time Google signs the admin in directly
    expect((await sso(w.browser(), 'google', w.google, { sub: 'g-chef', email: 'chef@example.com', email_verified: true })).poll.data.done).toBe(true);
  });

  it('Microsoft: work-account e-mails are not trusted for linking (nOAuth), personal accounts are', async () => {
    const tid = '72f988bf-86f1-41af-91ab-2d7cd011db47';
    let r = await sso(w.browser(), 'microsoft', w.ms, { sub: 'ms-1', tid, oid: '00000000-0000-0000-0000-000000000001', email: 'mia@gmail.com' });
    expect(r.poll.data.error).toMatch(/nicht bestätigt/);
    r = await sso(w.browser(), 'microsoft', w.ms, { sub: 'ms-2', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', oid: '00000000-0000-0000-0000-000000000002', email: 'mia@gmail.com' });
    expect(r.poll.data.user.email).toBe('mia@gmail.com');
    r = await sso(w.browser(), 'microsoft', w.ms, { sub: 'ms-3', tid, oid: '00000000-0000-0000-0000-000000000003', email: 'mia@gmail.com', xms_edov: true });
    expect(r.poll.data.user.email).toBe('mia@gmail.com');
  });

  it('GitHub: only a verified primary e-mail counts', async () => {
    let r = await sso(w.browser(), 'github', w.gh, { id: 42, login: 'mia' }, { extra: [{ email: 'mia@gmail.com', primary: true, verified: false }] });
    expect(r.url.searchParams.get('code_challenge')).toBeTruthy();
    expect(r.poll.data.error).toMatch(/keine bestätigte E-Mail/);
    r = await sso(w.browser(), 'github', w.gh, { id: 42, login: 'mia' }, { extra: [{ email: 'mia@gmail.com', primary: true, verified: true }] });
    expect(r.poll.data.user.email).toBe('mia@gmail.com');
  });

  it('Apple: form-post callback, signed client secret, name from the first login', async () => {
    const r = await sso(w.browser(), 'apple', w.apple, { sub: '001.mia', email: 'mia@gmail.com', email_verified: 'true' }, { post: { user: JSON.stringify({ name: { firstName: 'Mia', lastName: 'Apfel' } }) } });
    expect(r.url.searchParams.get('response_mode')).toBe('form_post');
    expect(r.url.searchParams.get('code_challenge')).toBeNull();
    expect(r.callback.status).toBe(303);
    expect(r.poll.data.user.email).toBe('mia@gmail.com');
    expect(w.t.app.db.get(`SELECT name FROM auth_identities WHERE provider = 'apple'`)?.name).toBe('Mia Apfel');
  });

  it('links and unlinks providers under „Mein Konto“, keeping at least one way in', async () => {
    const b = w.browser();
    // Olga came in via Google (no password): she links GitHub from her session
    expect((await sso(b, 'google', w.google, { sub: 'g-y', email: 'olga@firma.test', email_verified: true })).poll.data.done).toBe(true);
    const start = await b.post('/api/me/identities/link', { provider: 'github' });
    expect(start.status).toBe(200);
    const a = w.gh.authorize(start.data.url, { id: 77, login: 'olga-gh' }, [{ email: 'olga-private@example.org', primary: true, verified: true }]);
    const cb = await b.get(`/auth/sso/github/callback?code=${a.code}&state=${a.state}`);
    expect(cb.headers.location).toBe('http://localhost/app/settings/account');
    expect((await b.post('/api/auth/sso/poll')).data).toEqual({ linked: 'GitHub' });
    const ids = (await b.get('/api/me/identities')).data;
    expect(ids.identities.map((i: any) => i.provider)).toEqual(['google', 'github']);
    expect(ids.password_set).toBe(false);
    // the same GitHub account can't be linked to someone else
    const mia = w.browser();
    expect((await mia.post('/api/auth/login', { email: 'mia@gmail.com', password: 'geheim123' })).status).toBe(200);
    const s2 = await mia.post('/api/me/identities/link', { provider: 'github' });
    const a2 = w.gh.authorize(s2.data.url, { id: 77, login: 'olga-gh' }, [{ email: 'olga-private@example.org', primary: true, verified: true }]);
    await mia.get(`/auth/sso/github/callback?code=${a2.code}&state=${a2.state}`);
    expect((await mia.post('/api/auth/sso/poll')).data.error).toMatch(/anderen Login/);
    // unlink: one goes, the last one stays until there is a password
    const [g, gh] = ids.identities;
    expect((await b.del(`/api/me/identities/${g.id}`)).status).toBe(200);
    expect((await b.del(`/api/me/identities/${gh.id}`)).data.error).toMatch(/einzige Anmeldeart/);
    expect((await b.post('/api/me/password/set', { password: 'neues-passwort' })).status).toBe(200);
    expect((await b.post('/api/me/password/set', { password: 'nochmal-neu' })).status).toBe(400);
    expect((await b.del(`/api/me/identities/${gh.id}`)).status).toBe(200);
    expect((await w.browser().post('/api/auth/login', { email: 'olga@firma.test', password: 'neues-passwort' })).status).toBe(200);
  });

  it('Android app: the login runs in a Custom Tab and the WebView picks it up', async () => {
    const webview = w.browser({ ua: 'Mozilla/5.0 (Linux; Android 14) GoHighApp/1.4.0' });
    const start = await webview.post('/api/auth/sso/start', { provider: 'google' });
    expect((await webview.post('/api/auth/sso/poll')).data).toEqual({ pending: true });
    const a = w.google.authorize(start.data.url, { sub: 'g-mia', email: 'mia@gmail.com', email_verified: true });
    // the Custom Tab has no cookies of the WebView
    const tab = w.browser();
    const page = await tab.get(`/auth/sso/google/callback?code=${a.code}&state=${a.state}`);
    expect(page.status).toBe(200);
    expect(page.data).toContain('Zurück zur App');
    expect((await tab.post('/api/auth/sso/poll')).data).toEqual({ pending: false });
    expect((await webview.post('/api/auth/sso/poll')).data).toMatchObject({ done: true });
    expect((await webview.get('/api/me')).data.user.email).toBe('mia@gmail.com');
  });

  it('client login domain: only its providers, callback on the main address, back to the client domain', async () => {
    const kunde = (await w.t.api.post('/api/locations', { name: 'Kunde C' })).data;
    expect((await w.t.api.patch(`/api/agency/locations/${kunde.id}/branding`, { app_domain: 'crm.kunde-c.test' })).status).toBe(200);
    await w.t.api.put('/api/agency/login', { clients: { [kunde.id]: { providers: ['microsoft'], password: false } } });
    const b = w.browser({ host: 'crm.kunde-c.test' });
    const m = await b.get('/api/auth/methods');
    expect(m.data).toMatchObject({ password: false, providers: [{ id: 'microsoft', label: 'Microsoft', icon: 'microsoft' }] });
    expect((await b.post('/api/auth/login', { email: 'mia@gmail.com', password: 'geheim123' })).status).toBe(403);
    expect((await b.post('/api/auth/sso/start', { provider: 'google' })).status).toBe(403);
    const start = await b.post('/api/auth/sso/start', { provider: 'microsoft' });
    const a = w.ms.authorize(start.data.url, { sub: 'ms-2', tid: '9188040d-6c67-4c5b-b112-36a304b66dad', oid: '00000000-0000-0000-0000-000000000002', email: 'mia@gmail.com' });
    expect(a.redirect).toBe('http://localhost/auth/sso/microsoft/callback');
    const cb = await w.browser().get(`/auth/sso/microsoft/callback?code=${a.code}&state=${a.state}`);
    expect(cb.headers.location).toBe('http://crm.kunde-c.test/app/');
    expect((await b.post('/api/auth/sso/poll')).data.done).toBe(true);
    expect((await b.get('/api/me')).status).toBe(200);
  });
});

describe('magic links', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    await w.t.api.put('/api/agency/login', { magic_link: true });
    await w.t.api.post('/api/users', { email: 'mo@example.com', name: 'Mo', password: 'geheim123', role: 'member', locations: [w.locId] });
  });
  afterAll(() => w.t.close());
  const tokenOf = (text: string) => text.match(/\?magic=([\w-]+)/)![1];

  it('sends a single-use link that signs in once', async () => {
    const b = w.browser();
    const r = await b.post('/api/auth/magic-link', { email: 'mo@example.com', next: '/app/tasks' });
    expect(r.data.ok).toBe(true);
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0].text).toContain('http://localhost/app/?magic=');
    const tk = tokenOf(w.mails[0].text);
    expect((await b.post('/api/auth/magic-link/peek', { token: tk })).data).toEqual({ email: 'mo@example.com', invite: false });
    const c = await b.post('/api/auth/magic-link/consume', { token: tk });
    expect(c.data).toMatchObject({ done: true, next: '/app/tasks', user: { email: 'mo@example.com' } });
    expect((await b.get('/api/me')).status).toBe(200);
    expect((await w.browser().post('/api/auth/magic-link/consume', { token: tk })).status).toBe(410);
  });

  it('expires after 15 minutes and never reveals unknown addresses', async () => {
    const before = w.mails.length;
    const unknown = await w.browser().post('/api/auth/magic-link', { email: 'nobody@example.com' });
    const known = await w.browser().post('/api/auth/magic-link', { email: 'mo@example.com' });
    expect(unknown.data).toEqual(known.data);
    expect(w.mails.length).toBe(before + 1);
    const tk = tokenOf(w.mails.at(-1)!.text);
    w.t.app.db.run('UPDATE magic_links SET expires_at = ? WHERE email = ?', new Date(Date.now() - 1000).toISOString(), 'mo@example.com');
    expect((await w.browser().post('/api/auth/magic-link/consume', { token: tk })).status).toBe(410);
  });

  it('is rate limited per address', async () => {
    w.t.app.db.run('DELETE FROM magic_links');
    const before = w.mails.length;
    for (let i = 0; i < 5; i++) expect((await w.browser().post('/api/auth/magic-link', { email: 'mo@example.com' })).status).toBe(200);
    expect(w.mails.length - before).toBe(3);
  });

  it('asks TOTP users for their code after the link', async () => {
    const b = w.browser();
    expect((await b.post('/api/auth/login', { email: 'mo@example.com', password: 'geheim123' })).status).toBe(200);
    const setup = (await b.post('/api/me/2fa/setup')).data;
    await enable2fa(b, setup.secret);
    w.t.app.db.run('DELETE FROM magic_links');
    await w.browser().post('/api/auth/magic-link', { email: 'mo@example.com' });
    const c2 = w.browser();
    const r = await c2.post('/api/auth/magic-link/consume', { token: tokenOf(w.mails.at(-1)!.text) });
    expect(r.data.second_factor).toMatchObject({ methods: ['code'] });
    expect((await c2.get('/api/me')).status).toBe(401);
    expect((await c2.post('/api/auth/second-factor', { token: r.data.second_factor.token, code: '000000' })).status).toBe(401);
    const ok = await c2.post('/api/auth/second-factor', { token: r.data.second_factor.token, code: totp(setup.secret) });
    expect(ok.data.done).toBe(true);
    expect(w.t.app.db.get('SELECT auth_method, auth_mfa FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY created_at DESC LIMIT 1', 'mo@example.com')).toMatchObject({ auth_method: 'magic', auth_mfa: 1 });
  });

  it('invites create the account on first use (sign-up „invite“)', async () => {
    expect((await w.t.api.post('/api/agency/login/invites', { email: 'neu@example.com', locations: [w.locId] })).data.error).toMatch(/geschlossen/);
    await w.t.api.put('/api/agency/login', { signup: { mode: 'invite' } });
    const inv = await w.t.api.post('/api/agency/login/invites', { email: 'neu@example.com', locations: [w.locId], permissions: ['contacts'], send: true });
    expect(inv.data).toMatchObject({ email: 'neu@example.com', mail: 'sent' });
    expect(w.mails.at(-1)!.subject).toMatch(/Einladung/);
    const b = w.browser();
    const r = await b.post('/api/auth/magic-link/consume', { token: tokenOf(w.mails.at(-1)!.text) });
    expect(r.data.user).toMatchObject({ email: 'neu@example.com', role: 'member' });
    expect(w.t.app.db.get('SELECT permissions FROM users WHERE email = ?', 'neu@example.com')?.permissions).toBe(JSON.stringify(['contacts']));
    expect(w.t.app.db.get('SELECT email FROM login_invites WHERE email = ?', 'neu@example.com')).toBeUndefined();
  });
});

describe('passkeys and policies', () => {
  let w: World;
  const rp = { rpId: 'localhost', origin: 'http://localhost' };
  beforeAll(async () => {
    w = await world();
  });
  afterAll(() => w.t.close());

  async function register(b: Browser, auth: ReturnType<typeof createAuthenticator>, name = 'Laptop') {
    const o = await b.post('/api/me/passkeys/options');
    expect(o.status).toBe(200);
    expect(o.data.options).toMatchObject({ rp: { id: 'localhost' }, attestation: 'none', authenticatorSelection: { residentKey: 'required' } });
    return b.post('/api/me/passkeys', { challenge_id: o.data.challenge_id, name, credential: auth.register(o.data.options) });
  }

  it('registers a passkey and signs in with it, without a password', async () => {
    const b = w.browser();
    await b.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    const auth = createAuthenticator(rp);
    const reg = await register(b, auth);
    expect(reg.data).toMatchObject({ name: 'Laptop', rp_id: 'localhost' });
    expect((await b.get('/api/me/passkeys')).data).toMatchObject([{ name: 'Laptop', here: true }]);
    // the same authenticator can't be registered twice
    expect((await register(b, auth)).data.error).toMatch(/schon registriert/);

    const fresh = w.browser();
    const o = await fresh.post('/api/auth/passkey/options');
    expect(o.data.options).toMatchObject({ rpId: 'localhost', allowCredentials: [] });
    const r = await fresh.post('/api/auth/passkey/login', { challenge_id: o.data.challenge_id, credential: auth.assert(o.data.options), next: '/app/contacts' });
    expect(r.data).toMatchObject({ done: true, next: '/app/contacts', user: { email: 'chef@example.com' } });
    expect((await fresh.get('/api/me')).status).toBe(200);
    // challenges are single use
    expect((await w.browser().post('/api/auth/passkey/login', { challenge_id: o.data.challenge_id, credential: auth.assert(o.data.options) })).status).toBe(400);
  });

  it('refuses a cloned authenticator, a foreign origin and unknown credentials', async () => {
    const b = w.browser();
    const auth = createAuthenticator(rp);
    await b.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    await register(b, auth, 'Stick');
    let o = await w.browser().post('/api/auth/passkey/options');
    expect((await w.browser().post('/api/auth/passkey/login', { challenge_id: o.data.challenge_id, credential: auth.assert(o.data.options, { counter: 10 }) })).status).toBe(200);
    o = await w.browser().post('/api/auth/passkey/options');
    expect((await w.browser().post('/api/auth/passkey/login', { challenge_id: o.data.challenge_id, credential: auth.assert(o.data.options, { counter: 3 }) })).data.error).toMatch(/Zähler/);
    o = await w.browser().post('/api/auth/passkey/options');
    expect((await w.browser().post('/api/auth/passkey/login', { challenge_id: o.data.challenge_id, credential: auth.assert(o.data.options, { origin: 'https://evil.test' }) })).data.error).toMatch(/falscher Adresse/);
    o = await w.browser().post('/api/auth/passkey/options');
    expect((await w.browser().post('/api/auth/passkey/login', { challenge_id: o.data.challenge_id, credential: createAuthenticator(rp).assert(o.data.options) })).status).toBe(401);
  });

  it('works as second factor next to the authenticator code', async () => {
    await w.t.api.post('/api/users', { email: 'pia@example.com', name: 'Pia', password: 'geheim123', role: 'member', locations: [w.locId] });
    const b = w.browser();
    await b.post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123' });
    const setup = (await b.post('/api/me/2fa/setup')).data;
    await enable2fa(b, setup.secret);
    const auth = createAuthenticator(rp);
    await register(b, auth, 'Handy');
    const c = w.browser();
    const step = await c.post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123' });
    expect(step.data).toMatchObject({ needs_code: true, methods: ['code', 'passkey'] });
    expect(step.data.passkey.options.allowCredentials).toHaveLength(1);
    const ok = await c.post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123', passkey: { challenge_id: step.data.passkey.challenge_id, credential: auth.assert(step.data.passkey.options) } });
    expect(ok.status).toBe(200);
    expect(ok.data.user.email).toBe('pia@example.com');
    // a passkey of someone else does not count
    const other = createAuthenticator(rp);
    const s2 = await w.browser().post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123' });
    expect((await w.browser().post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123', passkey: { challenge_id: s2.data.passkey.challenge_id, credential: other.assert(s2.data.passkey.options) } })).status).toBe(401);
  });

  it('2FA duty for admins: until set up only the setup screens work', async () => {
    await w.t.api.post('/api/users', { email: 'admin2@example.com', name: 'Zweit', password: 'geheim123', role: 'admin' });
    expect((await w.t.api.put('/api/agency/login', { require_2fa_admins: true, session_days: 2 })).status).toBe(200);
    const b = w.browser();
    const login = await b.post('/api/auth/login', { email: 'admin2@example.com', password: 'geheim123' });
    expect(login.status).toBe(200);
    // session lifetime from the policy
    expect(String(login.headers['set-cookie'])).toContain('Max-Age=172800');
    expect((await b.get('/api/auth/gate')).data).toMatchObject({ require_2fa: true, has_2fa: false });
    expect((await b.get('/api/me')).status).toBe(200);
    expect((await b.get('/api/contacts', { 'x-location-id': w.locId })).status).toBe(403);
    await register(b, createAuthenticator(rp), 'Admin-Key');
    expect((await b.get('/api/auth/gate')).data).toMatchObject({ require_2fa: false, has_2fa: true });
    expect((await b.get('/api/contacts', { 'x-location-id': w.locId })).status).toBe(200);
    // with a passkey, a password login of this admin now needs it as second factor
    const c = await w.browser().post('/api/auth/login', { email: 'admin2@example.com', password: 'geheim123' });
    expect(c.data).toMatchObject({ needs_code: true, methods: ['passkey'] });
    await w.t.api.put('/api/agency/login', { require_2fa_admins: false });
  });

  it('turning methods off is enforced, but never all of them', async () => {
    expect((await w.t.api.put('/api/agency/login', { password: false, passkey: false, magic_link: false })).data.error).toMatch(/Mindestens/);
    expect((await w.t.api.put('/api/agency/login', { password: false })).status).toBe(200);
    expect((await w.browser().post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123' })).data.error).toMatch(/ausgeschaltet/);
    expect((await w.browser().get('/api/auth/methods')).data).toMatchObject({ password: false, passkey: true });
    // break glass: admins may use their password again
    process.env.PGHL_AUTH_BREAK_GLASS = '1';
    try {
      expect((await w.browser().post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
      expect((await w.browser().post('/api/auth/login', { email: 'pia@example.com', password: 'geheim123' })).status).toBe(403);
    } finally {
      delete process.env.PGHL_AUTH_BREAK_GLASS;
    }
    await w.t.api.put('/api/agency/login', { password: true });
    expect((await w.browser().post('/api/auth/passkey/options')).status).toBe(200);
  });
});
