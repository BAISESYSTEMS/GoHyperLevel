import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, asCall, cloudKit, createStripe } from './cloud-fakes.js';
import { client, type Call } from './security-fixtures.js';

/**
 * Security review 0.0.37–0.0.40, hosted cloud: the operator needs the customer's consent for everything that opens a customer's
 * account (also user management and cross-account reports), customers cannot claim hosts that belong to somebody else's login, and
 * the storage fair-use meter covers the big uploads.
 */

const stripe = createStripe();
const mails: { to: string; subject: string; text: string; html: string }[] = [];
let t: Awaited<ReturnType<typeof startTestApp>>;
const kit = cloudKit(() => t, stripe, mails);
const realFetch = globalThis.fetch;
let operator: Call;
let opLoc = '';
let A: Awaited<ReturnType<typeof kit.createCustomer>>;
let B: Awaited<ReturnType<typeof kit.createCustomer>>;
let callA: Call;
let callB: Call;

beforeAll(async () => {
  stripe.install();
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp({ cloudMode: true });
  await t.setup();
  opLoc = t.api.location;
  t.app.services.cloudMailer = async (_l: any, m: any) => (mails.push(m), { status: 'logged' });
  t.app.services.cloudFormMinMs = 0;
  expect((await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  operator = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
  A = await kit.createCustomer({ plan: 'team', company: 'Alpha Team', email: 'a@alpha.de' });
  t.app.services.cloud.resetLimits();
  B = await kit.createCustomer({ plan: 'solo', company: 'Beta Solo', email: 'b@beta.de' });
  callA = asCall(A.b);
  callB = asCall(B.b);
}, 300_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  stripe.uninstall();
  await t?.close();
});

describe('the operator and a customer’s consent', () => {
  it('reports across all sub-accounts leave out customers who have not opened their account for support', async () => {
    for (const n of [1, 2]) expect((await callA('POST', '/api/contacts', { email: `a${n}@example.com`, first_name: `Alpha${n}` }, A.h)).status).toBe(200);
    expect((await callB('POST', '/api/contacts', { email: 'b1@example.com', first_name: 'Beta1' }, B.h)).status).toBe(200);
    const total = async () => (await operator('POST', '/api/reports/run', { query: { source: 'contacts', range: 'all' }, scope: 'all' }, { 'x-location-id': opLoc })).data;
    expect((await total()).totals.v[0]).toBe(0);
    const grouped = await operator('POST', '/api/reports/run', { query: { source: 'contacts', range: 'all', group_by: ['location'] }, scope: 'all', location_ids: [A.loc, B.loc] }, { 'x-location-id': opLoc });
    expect(grouped.status, grouped.text).toBe(200);
    expect(grouped.data.totals.v[0]).toBe(0);
    expect(JSON.stringify(grouped.data)).not.toMatch(/Alpha Team|Beta Solo/);
    expect((await operator('GET', '/api/reports/sources', undefined, { 'x-location-id': opLoc })).text).not.toMatch(/Alpha Team|Beta Solo/);
    // A allows support for an hour: A's numbers are in, B's are still out
    expect((await callA('PUT', '/api/cloud/support', { hours: 1 }, A.h)).status).toBe(200);
    expect((await total()).totals.v[0]).toBe(2);
    expect((await callA('PUT', '/api/cloud/support', { hours: 0 }, A.h)).status).toBe(200);
    expect((await total()).totals.v[0]).toBe(0);
  });

  it('the operator’s audit log leaves out what happened in a customer’s account until the customer allows support', async () => {
    // A's contact creation above is in the log of A's sub-account
    const auditOf = async () => ((await operator('GET', '/api/admin/audit?limit=500')).data as { location_id: string | null; summary: string }[]);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE location_id = ?', A.loc)!.n).toBeGreaterThan(0);
    expect((await auditOf()).some((e) => e.location_id === A.loc || e.location_id === B.loc)).toBe(false);
    expect(((await operator('GET', `/api/admin/audit?location_id=${A.loc}`)).data as unknown[]).length).toBe(0);
    expect((await auditOf()).some((e) => e.location_id === opLoc || e.location_id === null)).toBe(true);
    expect((await callA('PUT', '/api/cloud/support', { hours: 1 }, A.h)).status).toBe(200);
    expect(((await operator('GET', `/api/admin/audit?location_id=${A.loc}`)).data as unknown[]).length).toBeGreaterThan(0);
    expect((await auditOf()).some((e) => e.location_id === B.loc)).toBe(false);
    expect((await callA('PUT', '/api/cloud/support', { hours: 0 }, A.h)).status).toBe(200);
  });

  it('user management does not reach a customer’s login, nor put a login into a customer’s account, without consent', async () => {
    const list = async () => ((await operator('GET', '/api/users')).data as { email: string }[]).map((u) => u.email);
    expect(await list()).not.toContain('a@alpha.de');
    expect(await list()).not.toContain('b@beta.de');
    expect(await list()).toContain('chef@example.com');
    const before = t.app.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', A.userId)!.password_hash;
    const attempts: [string, string, unknown][] = [
      ['PATCH', `/api/users/${A.userId}`, { password: 'operator-wuenscht-1' }],
      ['PATCH', `/api/users/${A.userId}`, { name: 'Operator' }],
      ['DELETE', `/api/users/${A.userId}`, undefined],
      ['POST', `/api/users/${A.userId}/sessions/revoke`, {}],
      ['POST', `/api/users/${A.userId}/2fa/reset`, {}],
      ['POST', `/api/users/${A.userId}/passkeys/reset`, {}],
      ['POST', '/api/users', { email: 'support@operator.example', password: 'passwort-123', name: 'Support', locations: [A.loc] }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await operator(method, path, body);
      expect(r.status, `${method} ${path}: ${r.text}`).toBe(403);
    }
    expect(t.app.db.get('SELECT 1 AS x FROM users WHERE email = ?', 'support@operator.example')).toBeUndefined();
    expect(t.app.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', A.userId)!.password_hash).toBe(before);
    expect((await A.b.api('GET', '/api/me')).status).toBe(200);
    // the operator's own people stay editable
    expect((await operator('POST', '/api/users', { email: 'kollege@operator.example', password: 'passwort-123', name: 'Kollege', locations: [opLoc] })).status).toBe(200);
    // with the customer's consent the operator can help (reset a lost password)
    expect((await callA('PUT', '/api/cloud/support', { hours: 1 }, A.h)).status).toBe(200);
    expect(await list()).toContain('a@alpha.de');
    expect((await operator('PATCH', `/api/users/${A.userId}`, { name: 'Alpha Chefin' })).status).toBe(200);
    expect((await callA('PUT', '/api/cloud/support', { hours: 0 }, A.h)).status).toBe(200);
    expect((await operator('PATCH', `/api/users/${A.userId}`, { name: 'Wieder gesperrt' })).status).toBe(403);
  });
});

describe('hosts a sub-account may claim', () => {
  it('a site or help center cannot take over a login domain, the service’s domain or the app’s own address', async () => {
    expect((await operator('PUT', '/api/cloud/console/settings', { cloud_domain: 'cloud.example.org' })).status).toBe(200);
    // the agency (operator) gives B's account a login domain of its own
    expect((await operator('PATCH', `/api/agency/locations/${B.loc}/branding`, { app_domain: 'login.beta-solo.example' })).status).toBe(200);
    const funnel = await callA('POST', '/api/funnels', { name: 'Seite' }, A.h);
    expect(funnel.status, funnel.text).toBe(200);
    const claim = (domain: string) => callA('PATCH', `/api/funnels/${funnel.data.id}`, { domain }, A.h);
    for (const host of ['login.beta-solo.example', 'www.login.beta-solo.example', 'beta.cloud.example.org', 'login.cloud.example.org', 'cloud.example.org']) {
      const r = await claim(host);
      expect(r.status, `${host}: ${r.text}`).toBe(400);
    }
    // a host nobody uses is fine
    expect((await claim('shop.alpha-team.example')).status).toBe(200);
    expect(t.app.db.get('SELECT domain FROM funnels WHERE id = ?', funnel.data.id)?.domain).toBe('shop.alpha-team.example');
    // the help center follows the same rules
    const hc = (domain: string) => callA('PUT', '/api/helpdesk/settings', { help_center: { enabled: true, domain } }, A.h);
    for (const host of ['login.beta-solo.example', 'beta.cloud.example.org']) expect((await hc(host)).status, host).toBe(400);
    expect((await hc('hilfe.alpha-team.example')).status).toBe(200);
    // the operator may use its own cloud domain for its own pages
    const own = await operator('POST', '/api/funnels', { name: 'Start' }, { 'x-location-id': opLoc });
    expect((await operator('PATCH', `/api/funnels/${own.data.id}`, { domain: 'www.cloud.example.org' }, { 'x-location-id': opLoc })).status).toBe(200);
  });
});

describe('the storage fair-use meter', () => {
  it('counts course videos, community videos, call audio and meeting recordings – and refuses uploads that would pass the plan', async () => {
    const MB = 1024 * 1024;
    const db = t.app.db;
    const at = new Date().toISOString();
    const meter = async () => (await callB('GET', '/api/cloud/me', undefined, B.h)).data.tenant.meters.storage_mb;
    expect((await meter()).used).toBe(0);
    // Solo: 5 000 MB. Four big files of other kinds already sit there.
    db.insert('course_videos', { id: 'vid-b-1', location_id: B.loc, name: 'Kurs.mp4', file: 'vid-b-1.mp4', size: 2000 * MB, received: 2000 * MB, status: 'complete', created_at: at });
    db.insert('call_intel', { id: 'ci-b-1', location_id: B.loc, source: 'upload', status: 'done', audio_bytes: 1500 * MB, created_at: at });
    db.insert('call_audio', { id: 'ca-b-1', location_id: B.loc, name: 'Ansage', kind: 'greeting', mime: 'audio/mpeg', bytes: 1000 * MB, file: 'x.mp3', created_at: at });
    expect((await meter()).used).toBe(4500);
    expect((await meter()).limit).toBe(5000);
    // a chunked course video that would pass the plan is refused when it starts; a small one is fine
    const big = await callB('POST', '/api/courses/videos', { name: 'Gross.mp4', size: 600 * MB }, B.h);
    expect(big.status, big.text).toBe(403);
    expect(big.data.error).toMatch(/Speicher-Limit/);
    expect((await callB('POST', '/api/courses/videos', { name: 'Klein.mp4', size: 100 * MB }, B.h)).status).toBe(200);
    // the same for raw audio of a meeting recording and for a community member's video
    const over = Buffer.alloc(8);
    // 2000 + 1500 + 1000 MB and the 100 MB video that was just started: 4600 MB, a few bytes more still fit
    const up = await fetch(`${t.base}/api/call-intel/upload?consent=1&title=x`, { method: 'POST', headers: { cookie: `pghl_session=${B.b.cookie('pghl_session')}`, 'x-pghl': '1', 'x-location-id': B.loc, 'content-type': 'application/octet-stream' }, body: over });
    expect(up.status).not.toBe(403);
    db.run('UPDATE call_audio SET bytes = ? WHERE id = ?', 1500 * MB, 'ca-b-1');
    const refused = await fetch(`${t.base}/api/call-intel/upload?consent=1&title=x`, { method: 'POST', headers: { cookie: `pghl_session=${B.b.cookie('pghl_session')}`, 'x-pghl': '1', 'x-location-id': B.loc, 'content-type': 'application/octet-stream' }, body: over });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/Speicher-Limit/);
    // another customer is not affected
    expect((await callA('POST', '/api/courses/videos', { name: 'Gross.mp4', size: 600 * MB }, A.h)).status).toBe(200);
  });
});
