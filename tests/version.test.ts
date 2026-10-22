import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { knownDomain } from '../server/modules/tls-ask.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('GET /api/version, first-run setup and the TLS ask endpoint', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp({ baseUrl: 'https://crm.example.com' });
  });
  afterAll(() => t.close());

  it('reports name and version from package.json and whether setup is still open', async () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    const v = await t.api.get('/api/version');
    expect(v.status).toBe(200);
    expect(v.data).toMatchObject({ name: 'HyperLevel', version: pkg.version, demo: null, setup_required: true });
    expect((await t.api.get('/api/auth/status')).data).toEqual({ needsSetup: true });
  });

  it('the setup wizard creates the first admin exactly once', async () => {
    const r = await t.api.post('/api/auth/setup', { email: 'Owner@Example.com', password: 'geheim123', name: 'Owner', locationName: 'Erste Firma' });
    expect(r.status).toBe(200);
    expect(r.data.user.email).toBe('owner@example.com');
    expect((await t.api.get('/api/version')).data.setup_required).toBe(false);
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/setup', { email: 'x@example.com', password: 'geheim123' })).status).toBe(409);
  });

  it('answers Caddy only for domains this install serves', async () => {
    expect((await t.api.get('/api/tls/ask?domain=crm.example.com')).status).toBe(200);
    expect((await t.api.get('/api/tls/ask?domain=evil.example.net')).status).toBe(404);
    expect((await t.api.get('/api/tls/ask?domain=not a domain')).status).toBe(400);
    // A funnel domain (and its www partner) becomes known once it is connected.
    await t.api.post('/api/auth/login', { email: 'owner@example.com', password: 'geheim123' });
    const me = await t.api.get('/api/me');
    t.api.setLocation(me.data.locations[0].id);
    const f = await t.api.post('/api/funnels', { name: 'Shop', kind: 'website' });
    expect((await t.api.get('/api/tls/ask?domain=shop-kunde.de')).status).toBe(404);
    expect((await t.api.patch(`/api/funnels/${f.data.id}`, { domain: 'shop-kunde.de' })).status).toBe(200);
    expect((await t.api.get('/api/tls/ask?domain=shop-kunde.de')).status).toBe(200);
    expect((await t.api.get('/api/tls/ask?domain=www.shop-kunde.de')).status).toBe(200);
    expect((await t.api.get('/api/tls/ask?domain=other.shop-kunde.de')).status).toBe(404);
  });

  it('knownDomain matches own host, domains and www partners only', () => {
    const wanted = [{ domain: 'kunde.de', alias: 'www.kunde.de' }, { domain: 'app.agentur.de' }];
    expect(knownDomain('crm.example.com', 'crm.example.com', wanted)).toBe(true);
    expect(knownDomain('www.kunde.de', 'crm.example.com', wanted)).toBe(true);
    expect(knownDomain('app.agentur.de', 'crm.example.com', wanted)).toBe(true);
    expect(knownDomain('agentur.de', 'crm.example.com', wanted)).toBe(false);
    expect(knownDomain('', 'crm.example.com', wanted)).toBe(false);
  });
});
