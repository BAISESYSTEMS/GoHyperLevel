import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers';
import { REFERRAL_DEFAULTS, REFERRAL_PROVIDERS, cleanConfig, parseEnvLinks, patchConfig, referralProvider, resolveLink, safeHttpsUrl } from '../server/modules/referrals';

const kie = referralProvider('kie')!;
const monid = referralProvider('monid')!;

describe('referral links: pure logic', () => {
  it('has a clean catalogue: unique ids, https sign-up links, defaults only for known ids', () => {
    const ids = REFERRAL_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of REFERRAL_PROVIDERS) {
      expect(p.id).toMatch(/^[a-z0-9_]{2,40}$/);
      if (p.signup) expect(safeHttpsUrl(p.signup), p.id).toBe(new URL(p.signup).href);
    }
    for (const id of Object.keys(REFERRAL_DEFAULTS)) expect(ids, id).toContain(id);
    // ids the parallel branches (BYOK presets, gen-media providers) render
    for (const id of ['kie', 'fal', 'replicate', 'stability', 'runway', 'luma', 'elevenlabs', 'groq', 'together', 'fireworks', 'perplexity', 'cerebras', 'huggingface', 'ollama', 'monid', 'telegram', 'discord', 'slack', 'aws_ses']) expect(ids).toContain(id);
    expect(monid.signup).toBeNull();
    expect(referralProvider('ollama')!.signup).toBeNull();
    expect(referralProvider('__proto__')).toBeUndefined();
    expect(referralProvider('toString')).toBeUndefined();
  });

  it('resolves agency override → env → defaults → plain sign-up URL', () => {
    const defaults = { kie: 'https://kie.ai/?ref=maintainer' };
    const env = { kie: 'https://kie.ai/?ref=env' };
    const agency = { enabled: true, links: { kie: 'https://kie.ai/?ref=agency' } };
    expect(resolveLink(kie, { agency, env, defaults })).toEqual({ url: 'https://kie.ai/?ref=agency', is_referral: true, source: 'agency' });
    expect(resolveLink(kie, { agency: { enabled: true, links: {} }, env, defaults })).toEqual({ url: 'https://kie.ai/?ref=env', is_referral: true, source: 'env' });
    expect(resolveLink(kie, { env: {}, defaults })).toEqual({ url: 'https://kie.ai/?ref=maintainer', is_referral: true, source: 'default' });
    expect(resolveLink(kie, { defaults: {} })).toEqual({ url: 'https://kie.ai/', is_referral: false, source: 'signup' });
    // the shipped defaults are empty → plain link
    expect(resolveLink(kie)).toEqual({ url: 'https://kie.ai/', is_referral: false, source: 'signup' });
    // "" in an override = plain sign-up link, even when env/defaults have one
    expect(resolveLink(kie, { agency: { enabled: true, links: { kie: '' } }, env, defaults })).toEqual({ url: 'https://kie.ai/', is_referral: false, source: 'signup' });
    expect(resolveLink(kie, { env: { kie: '' }, defaults })).toMatchObject({ is_referral: false, source: 'signup' });
    // an override equal to the sign-up page is no partner link
    expect(resolveLink(kie, { agency: { enabled: true, links: { kie: 'https://kie.ai/' } } })).toMatchObject({ is_referral: false, source: 'agency' });
    // providers without a sign-up page only link when someone configured one
    expect(resolveLink(monid, { defaults: {} })).toEqual({ url: null, is_referral: false, source: null });
    expect(resolveLink(monid, { defaults: { monid: 'https://monid.example/?via=x' } })).toMatchObject({ url: 'https://monid.example/?via=x', is_referral: true });
  });

  it('switches every partner link off (env or agency toggle)', () => {
    const o = { agency: { enabled: true, links: { kie: 'https://kie.ai/?ref=agency' } }, env: { kie: 'https://kie.ai/?ref=env' }, defaults: { kie: 'https://kie.ai/?ref=d', monid: 'https://monid.example/?r=1' } };
    expect(resolveLink(kie, { ...o, disabled: true })).toEqual({ url: 'https://kie.ai/', is_referral: false, source: 'signup' });
    expect(resolveLink(kie, { ...o, agency: { ...o.agency, enabled: false } })).toEqual({ url: 'https://kie.ai/', is_referral: false, source: 'signup' });
    expect(resolveLink(monid, { ...o, disabled: true })).toEqual({ url: null, is_referral: false, source: null });
  });

  it('accepts only https URLs', () => {
    expect(safeHttpsUrl('https://kie.ai/?ref=abc')).toBe('https://kie.ai/?ref=abc');
    expect(safeHttpsUrl('  https://Fal.ai/x  ')).toBe('https://fal.ai/x');
    for (const bad of ['http://kie.ai/', 'javascript:alert(1)', 'data:text/html,hi', '//kie.ai', 'kie.ai', 'ftp://kie.ai', 'https://user:pw@kie.ai/', 'https://127.0.0.1/', 'https://localhost/', 'https://kie.ai:8443/', 'https://kie .ai/', 'https://kie.ai/"><script>', '', 42, null, `https://kie.ai/${'a'.repeat(2100)}`])
      expect(safeHttpsUrl(bad), String(bad)).toBeNull();
    // invalid entries fall through to the next layer
    expect(resolveLink(kie, { agency: { enabled: true, links: { kie: 'http://evil.example/' } }, env: { kie: 'javascript:x' }, defaults: {} })).toMatchObject({ url: 'https://kie.ai/', source: 'signup' });
  });

  it('parses PGHL_REFERRALS and the stored settings defensively', () => {
    expect(parseEnvLinks(undefined)).toEqual({ links: {}, invalid: false });
    expect(parseEnvLinks('nope')).toEqual({ links: {}, invalid: true });
    expect(parseEnvLinks('[1]')).toEqual({ links: {}, invalid: true });
    expect(parseEnvLinks(JSON.stringify({ kie: 'https://kie.ai/?r=1', fal: '', evil: 'https://x.example/', openai: 'http://insecure.example/', replicate: 5 }))).toEqual({ links: { kie: 'https://kie.ai/?r=1', fal: '' }, invalid: false });
    expect(cleanConfig(null)).toEqual({ enabled: true, links: {} });
    expect(cleanConfig({ enabled: false, links: { kie: 'https://kie.ai/?r=2', x: 'https://a.example/', fal: 'http://a.example/' } })).toEqual({ enabled: false, links: { kie: 'https://kie.ai/?r=2' } });
    const prev = { enabled: true, links: { kie: 'https://kie.ai/?r=1' } };
    expect(patchConfig(prev, { enabled: false })).toEqual({ enabled: false, links: prev.links });
    expect(patchConfig(prev, { links: { fal: '', kie: null } })).toEqual({ enabled: true, links: { fal: '' } });
    expect(() => patchConfig(prev, { links: { kie: 'http://kie.ai/' } })).toThrow(/https/);
    expect(() => patchConfig(prev, { links: { nope: 'https://kie.ai/' } })).toThrow(/Unbekannter Anbieter/);
    expect(() => patchConfig(prev, { enabled: 'yes' })).toThrow();
    expect(() => patchConfig(prev, { links: ['https://kie.ai/'] })).toThrow();
  });
});

describe('referral links: API, redirect, MCP', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());
  afterEach(() => {
    delete process.env.PGHL_REFERRALS;
    delete process.env.PGHL_REFERRALS_DISABLED;
  });

  const go = (path: string) => t.api.raw(path, { redirect: 'manual' });

  it('lists plain sign-up links by default and redirects through /go/ with a click count', async () => {
    const r = await t.api.get('/api/referrals');
    expect(r.status).toBe(200);
    expect(r.data.kie).toEqual({ name: 'kie.ai', url: '/go/kie', is_referral: false });
    expect(r.data.telegram.url).toBe('/go/telegram');
    expect(r.data.monid).toBeUndefined(); // no sign-up URL known, no link configured
    expect(r.data.ollama).toBeUndefined();

    const res = await go('/go/kie');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://kie.ai/');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await go('/go/kie');
    const admin = await t.api.get('/api/agency/referrals');
    const row = admin.data.providers.find((p: any) => p.id === 'kie');
    expect(row).toMatchObject({ clicks: 2, partner_clicks: 0, source: 'signup', go: '/go/kie', override: null, default_url: null });
    expect(row.last_click_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(admin.data.total_clicks).toBe(2);
  });

  it('refuses unknown ids and never redirects to a URL from the request', async () => {
    for (const p of ['/go/nope', '/go/__proto__', '/go/constructor', '/go/monid', '/go/ollama']) {
      const res = await go(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get('location'), p).toBeNull();
    }
    for (const p of ['/go/kie?url=https://evil.example/', '/go/kie?next=//evil.example', '/go/kie?redirect=javascript:alert(1)']) {
      const res = await go(p);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://kie.ai/');
    }
    expect((await go('/go/https%3A%2F%2Fevil.example')).status).toBe(404);
    expect((await go('/go/kie/extra')).status).not.toBe(302);
  });

  it('applies env links, agency overrides and both off switches', async () => {
    process.env.PGHL_REFERRALS = JSON.stringify({ kie: 'https://kie.ai/?ref=env', fal: 'http://insecure.example/' });
    let r = await t.api.get('/api/referrals');
    expect(r.data.kie).toEqual({ name: 'kie.ai', url: '/go/kie', is_referral: true, sponsor: 'operator' });
    expect(r.data.fal.is_referral).toBe(false);
    let res = await go('/go/kie');
    expect(res.headers.get('location')).toBe('https://kie.ai/?ref=env');

    const put = await t.api.put('/api/agency/referrals', { links: { kie: 'https://kie.ai/?ref=agency', fal: '', monid: 'https://monid.example/?via=agency' } });
    expect(put.status).toBe(200);
    expect(put.data.providers.find((p: any) => p.id === 'kie')).toMatchObject({ override: 'https://kie.ai/?ref=agency', env_url: 'https://kie.ai/?ref=env', source: 'agency', is_referral: true });
    res = await go('/go/kie');
    expect(res.headers.get('location')).toBe('https://kie.ai/?ref=agency');
    expect((await go('/go/monid')).headers.get('location')).toBe('https://monid.example/?via=agency');
    r = await t.api.get('/api/referrals');
    expect(r.data.monid).toEqual({ name: 'Monid', url: '/go/monid', is_referral: true, sponsor: 'operator' });
    const kieRow = (await t.api.get('/api/agency/referrals')).data.providers.find((p: any) => p.id === 'kie');
    expect(kieRow.partner_clicks).toBeGreaterThanOrEqual(2);

    // invalid input is refused and nothing changes
    expect((await t.api.put('/api/agency/referrals', { links: { kie: 'http://kie.ai/' } })).status).toBe(400);
    expect((await t.api.put('/api/agency/referrals', { links: { kie: 'javascript:alert(1)' } })).status).toBe(400);
    expect((await t.api.put('/api/agency/referrals', { links: { evil: 'https://evil.example/' } })).status).toBe(400);
    expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/?ref=agency');

    // agency toggle off → plain links only
    let off = await t.api.put('/api/agency/referrals', { enabled: false });
    expect(off.data.enabled).toBe(false);
    expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/');
    expect((await t.api.get('/api/referrals')).data.monid).toBeUndefined();
    await t.api.put('/api/agency/referrals', { enabled: true });
    expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/?ref=agency');

    // env kill switch beats everything
    process.env.PGHL_REFERRALS_DISABLED = '1';
    off = await t.api.get('/api/agency/referrals');
    expect(off.data.disabled_by_env).toBe(true);
    expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/');
    expect(Object.values((await t.api.get('/api/referrals')).data).every((x: any) => !x.is_referral)).toBe(true);
    delete process.env.PGHL_REFERRALS_DISABLED;

    // overrides removed again → env, then plain
    await t.api.put('/api/agency/referrals', { links: {} });
    expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/?ref=env');
    delete process.env.PGHL_REFERRALS;
    expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/');

    const cleared = await t.api.del('/api/agency/referrals/clicks');
    expect(cleared.data.total_clicks).toBe(0);
  });

  it('marks maintainer defaults as HyperLevel partner links and lets the agency replace them', async () => {
    t.app.services.referralDefaults = { kie: 'https://kie.ai/?ref=maintainer', openai: 'http://not-https.example/' };
    try {
      const r = await t.api.get('/api/referrals');
      expect(r.data.kie).toEqual({ name: 'kie.ai', url: '/go/kie', is_referral: true, sponsor: 'gohigh' });
      expect(r.data.openai.is_referral).toBe(false); // non-https default is ignored
      expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/?ref=maintainer');
      const row = (await t.api.get('/api/agency/referrals')).data.providers.find((p: any) => p.id === 'kie');
      expect(row).toMatchObject({ default_url: 'https://kie.ai/?ref=maintainer', source: 'default', is_referral: true });
      // per-provider toggle off = "" → plain link
      await t.api.put('/api/agency/referrals', { links: { kie: '' } });
      expect((await go('/go/kie')).headers.get('location')).toBe('https://kie.ai/');
      expect((await t.api.get('/api/referrals')).data.kie).toEqual({ name: 'kie.ai', url: '/go/kie', is_referral: false });
    } finally {
      delete t.app.services.referralDefaults;
      await t.api.put('/api/agency/referrals', { links: {} });
    }
  });

  it('lets members read the links but not change them', async () => {
    await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kunde', password: 'geheim1234', role: 'member', locations: [t.api.location], permissions: ['contacts'] });
    await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim1234' });
    try {
      const r = await t.api.get('/api/referrals');
      expect(r.status).toBe(200);
      expect(r.data.stripe.url).toBe('/go/stripe');
      expect((await t.api.get('/api/agency/referrals')).status).toBe(403);
      expect((await t.api.put('/api/agency/referrals', { enabled: false })).status).toBe(403);
      expect((await t.api.del('/api/agency/referrals/clicks')).status).toBe(403);
    } finally {
      await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    }
    t.api.clearCookie();
    expect((await t.api.get('/api/referrals')).status).toBe(401);
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
  });

  it('gives the agent the /go/ link over MCP (also with a sub-account key)', async () => {
    const agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const locKey = (await t.api.post('/api/api-keys', { name: 'Codex' })).data.key;
    const call = async (key: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_provider_signup_link', arguments: args } }) });
      const res = (await r.json()).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
    const list = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${locKey}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await list.json()).result.tools.map((x: any) => x.name)).toContain('ghl_provider_signup_link');

    expect(await call(agencyKey, { provider: 'kie' })).toMatchObject({ provider: 'kie', name: 'kie.ai', url: 'http://localhost/go/kie', is_referral: false, label: 'Anmelde-Link' });
    expect(await call(locKey, { provider: 'ElevenLabs' })).toMatchObject({ provider: 'elevenlabs', url: 'http://localhost/go/elevenlabs' });
    expect(await call(locKey, { provider: 'kie.ai' })).toMatchObject({ provider: 'kie' });
    await t.api.put('/api/agency/referrals', { links: { fal: 'https://fal.ai/?ref=agency' } });
    expect(await call(agencyKey, { provider: 'fal' })).toMatchObject({ is_referral: true, sponsor: 'operator', label: 'Partner-Link', note: expect.stringContaining('Betreibers') });
    expect((await call(agencyKey, { provider: 'nope' })).error).toMatch(/Unbekannter Anbieter/);
    expect((await call(agencyKey, { provider: 'monid' })).error).toMatch(/kein Anmelde-Link/);
    await t.api.put('/api/agency/referrals', { links: {} });
  });
});
