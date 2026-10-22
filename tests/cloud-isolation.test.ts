import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Route } from '../server/core/http.js';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, asCall, browser, cloudKit, createStripe } from './cloud-fakes.js';
import { MARK, client, crossTenantAttack, foreignIds, foreignSnapshot, seedCreatorRows, seedLocation, seedTelephonyRows, tableColumns, type Call } from './security-fixtures.js';

/**
 * Cloud customers never see each other or the operator's own data. Three customers of the hosted service (Solo, Team and an
 * Agentur with two client accounts) and the operator, each with data in their sub-account: every route is attacked with the
 * ids of the others' records; the operator needs a customer's consent; and a deleted customer leaves no row behind.
 */

const stripe = createStripe();
const mails: { to: string; subject: string; text: string; html: string }[] = [];
let t: Awaited<ReturnType<typeof startTestApp>>;
const kit = cloudKit(() => t, stripe, mails);
const realFetch = globalThis.fetch;

let operator: Call;
let opLoc = '';
let opUserId = '';
let A: Awaited<ReturnType<typeof kit.createCustomer>>; // Solo, tag Alpha
let B: Awaited<ReturnType<typeof kit.createCustomer>>; // Team, tag MARK
let C: Awaited<ReturnType<typeof kit.createCustomer>>; // Agentur
let k1 = '';
let k2 = ''; // client of C, tag MARK
let clientLogin: ReturnType<typeof browser>; // restricted to k1
let callA: Call;
let ids: Record<string, Record<string, string>> = {};

const routes = () => ((t.app.router as any).routes as Route[]).filter((r) => r.auth === 'location' || r.auth === 'user');
const count = (loc: string) => {
  const out: Record<string, number> = {};
  for (const [tbl, cols] of tableColumns(t.app)) if (cols.includes('location_id') && !tbl.startsWith('cloud_') && tbl !== 'audit_log') out[tbl] = Number(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${tbl}" WHERE location_id = ?`, loc)?.n ?? 0);
  return out;
};

beforeAll(async () => {
  stripe.install();
  // No outbound network except our own server and the fake Stripe.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp({ cloudMode: true });
  const me = await t.setup();
  opUserId = me.user.id;
  opLoc = t.api.location;
  t.app.services.cloudMailer = async (_l: any, m: any) => (mails.push(m), { status: 'logged' });
  t.app.services.cloudFormMinMs = 0;
  expect((await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  operator = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
  A = await kit.createCustomer({ plan: 'solo', company: 'Alpha Solo', email: 'a@alpha.de' });
  t.app.services.cloud.resetLimits();
  B = await kit.createCustomer({ plan: 'team', company: `${MARK} Team`, email: 'b@leakmark.de' });
  t.app.services.cloud.resetLimits();
  C = await kit.createCustomer({ plan: 'agency', company: 'Gamma Agentur', email: 'c@gamma.de' });
  k1 = (await C.b.api('POST', '/api/cloud/clients', { name: 'Gamma Kunde 1' })).data.id;
  k2 = (await C.b.api('POST', '/api/cloud/clients', { name: `${MARK} Gamma Kunde 2` })).data.id;
  // A login that only sees client 1.
  expect((await C.b.api('POST', '/api/cloud/team', { email: 'k1@gamma-kunde.de', name: 'K1', locations: [k1] })).status).toBe(200);
  clientLogin = browser(t.base);
  await clientLogin.form(kit.path(/(https?:\/\/\S+\/invite\/\S+)/.exec(kit.lastMail('k1@gamma-kunde.de', /eingeladen/)!.text)![1]), { password: 'kunden-passwort1', password2: 'kunden-passwort1' });
  callA = asCall(A.b);
  // Everybody has data: the operator, A, B and the clients of C.
  // The sub-accounts that get attacked are filled completely; the attackers' own are small (the run time is mostly row scans).
  for (const [call, loc, tag] of [[callA, A.loc, 'Alpha'], [asCall(C.b), k1, 'Gamma']] as const) {
    for (const n of [1, 2]) expect((await call('POST', '/api/contacts', { email: `${tag.toLowerCase()}${n}@example.com`, first_name: `${tag}${n}` }, { 'x-location-id': loc, 'x-pghl': '1' })).status).toBe(200);
    expect((await call('POST', '/api/tasks', { title: `${tag} Aufgabe` }, { 'x-location-id': loc, 'x-pghl': '1' })).status).toBe(200);
  }
  const seeds = [
    ['op', operator, opLoc, `${MARK}OP`],
    ['B', asCall(B.b), B.loc, MARK],
    ['k2', asCall(C.b), k2, `${MARK}K`],
  ] as const;
  for (const [key, call, loc, tag] of seeds) {
    const r = await seedLocation(call, loc, tag);
    expect(r.failed, `${key}: ${r.failed.join('\n')}`).toEqual([]);
    ids[key] = r.ids;
    seedCreatorRows(t.app, loc, r.ids, tag);
    seedTelephonyRows(t.app, loc, r.ids, tag);
  }
}, 600_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  stripe.uninstall();
  await t?.close();
});

describe('cloud customers are isolated', () => {
  it('lists only the own sub-accounts and team', async () => {
    expect((await A.b.api('GET', '/api/me')).data.locations.map((l: any) => l.id)).toEqual([A.loc]);
    expect((await B.b.api('GET', '/api/me')).data.locations.map((l: any) => l.id)).toEqual([B.loc]);
    expect((await C.b.api('GET', '/api/me')).data.locations.map((l: any) => l.id).sort()).toEqual([C.loc, k1, k2].sort());
    expect((await clientLogin.api('GET', '/api/me')).data.locations.map((l: any) => l.id)).toEqual([k1]);
    expect((await A.b.api('GET', '/api/cloud/team')).data.members.map((m: any) => m.email)).toEqual(['a@alpha.de']);
    expect((await A.b.api('GET', '/api/cloud/me')).data.tenant.id).toBe(A.tenantId);
    for (const who of [A, B, C]) expect(JSON.stringify((await who.b.api('GET', '/api/cloud/me')).data)).not.toMatch(/operator|chef@example\.com/i);
  });

  it('returns 403 on every location route for another customer\'s sub-account, and for the operator\'s', async () => {
    const wrong: string[] = [];
    for (const target of [B.loc, opLoc, k2]) {
      for (const r of routes().filter((x) => x.auth === 'location')) {
        const path = '/' + r.parts.map((p) => (p.startsWith(':') ? 'x' : p)).join('/');
        const res = await callA(r.method, path, r.method === 'GET' ? undefined : {}, { 'x-location-id': target });
        if (res.status !== 403) wrong.push(`${r.method} ${r.pattern} → ${res.status} (${target})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('returns 403 on every admin route for customers (the operator\'s tools are not theirs)', async () => {
    const wrong: string[] = [];
    for (const who of [callA, asCall(B.b), asCall(clientLogin)]) {
      for (const r of ((t.app.router as any).routes as Route[]).filter((x) => x.auth === 'admin')) {
        const path = '/' + r.parts.map((p) => (p.startsWith(':') ? 'x' : p)).join('/');
        const res = await who(r.method, path, r.method === 'GET' ? undefined : {});
        if (res.status !== 403) wrong.push(`${r.method} ${r.pattern} → ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("customer A's session never reads or changes the records of B, the operator or the agency's clients", { timeout: 900_000 }, async () => {
    const leaks = await crossTenantAttack({ app: t.app, who: 'A→B', call: callA, target: B.loc, targetOwnerId: B.userId, routes: routes(), also: [{ target: opLoc, ownerId: opUserId }, { target: k2, ownerId: C.userId }], variants: 3 });
    expect(leaks).toEqual([]);
  });

  it("a client's login never reads or changes the agency's other client", { timeout: 900_000 }, async () => {
    expect(await crossTenantAttack({ app: t.app, who: 'k1→k2', call: asCall(clientLogin), target: k2, targetOwnerId: C.userId, routes: routes(), variants: 3 })).toEqual([]);
  });

  it("customer A's API key stays inside A", async () => {
    const key = (await callA('POST', '/api/api-keys', { name: 'K' }, A.h)).data.key;
    const kc = client(t.base, { authorization: `Bearer ${key}`, 'x-location-id': B.loc });
    expect((await kc('GET', '/api/contacts')).text.toUpperCase()).not.toContain(MARK);
    const own = client(t.base, { authorization: `Bearer ${key}`, 'x-location-id': A.loc });
    expect((await own('GET', '/api/contacts')).status).toBe(200);
    expect((await own('GET', '/api/cloud/me')).status).toBe(403);
    expect((await own('GET', '/api/users')).status).toBe(403);
  });

  it('keeps the cloud routes tenant-scoped: ids of other tenants find nothing', async () => {
    const bTeam = (await B.b.api('GET', '/api/cloud/team')).data.members[0].id;
    expect((await callA('PATCH', `/api/cloud/team/${bTeam}`, { name: 'Hacked' })).status).toBe(404);
    expect((await callA('DELETE', `/api/cloud/team/${bTeam}`)).status).toBe(404);
    expect((await callA('POST', `/api/cloud/team/${bTeam}/invite`, {})).status).toBe(404);
    expect((await callA('PUT', '/api/cloud/domain', { location_id: B.loc, domain: 'evil.example.org' })).status).toBe(403);
    expect((await asCall(C.b)('PUT', '/api/cloud/domain', { location_id: B.loc, domain: 'evil.example.org' })).status).toBe(404);
    expect((await asCall(C.b)('DELETE', `/api/cloud/clients/${B.loc}`, { confirm: `${MARK} Team` })).status).toBe(404);
    expect((await callA('POST', '/api/cloud/subscribe/confirm', { session_id: B.sid })).data.tenant ?? 'ok').toBeDefined();
    expect(t.app.db.get('SELECT name FROM users WHERE id = ?', bTeam).name).not.toBe('Hacked');
    // Nobody can pay, cancel or delete somebody else's account through a body parameter.
    for (const path of ['/api/cloud/cancel', '/api/cloud/plan', '/api/cloud/delete', '/api/cloud/support']) {
      const r = await callA('POST', path, { tenant_id: B.tenantId, location_id: B.loc, plan: 'team', confirm: `${MARK} Team`, hours: 24 });
      expect(r.text.toUpperCase()).not.toContain(MARK);
    }
    expect(t.app.db.get('SELECT support_until, deletion_at FROM cloud_tenants WHERE id = ?', B.tenantId)).toEqual({ support_until: null, deletion_at: null });
    expect(t.app.db.get('SELECT cancel_at_period_end FROM saas_subscriptions WHERE location_id = ?', B.loc).cancel_at_period_end).toBe(0);
  });

  it('keeps the operator out of customer accounts without consent (REST, agency key, lists)', async () => {
    for (const target of [A.loc, B.loc, k2]) {
      const r = await t.api.get('/api/contacts', { 'x-location-id': target });
      expect(r.status, target).toBe(403);
      expect(JSON.stringify(r.data).toUpperCase()).not.toContain(MARK);
    }
    const ak = client(t.base, { authorization: `Bearer ${(await operator('POST', '/api/agency/api-keys', { name: 'Agentur' })).data.key}`, 'x-location-id': B.loc });
    expect((await ak('GET', '/api/contacts')).status).toBe(403);
    expect((await ak('GET', '/api/campaigns')).status).toBe(403);
    expect((await t.api.get('/api/agency/contacts')).status).toBe(403);
    expect((await t.api.get(`/api/agency/opportunities?location_id=${B.loc}`)).status).toBe(403);
    // The operator's own sub-account is theirs.
    expect((await t.api.get('/api/contacts', { 'x-location-id': opLoc })).status).toBe(200);
    expect((await t.api.get(`/api/agency/contacts?location_id=${opLoc}`)).status).toBe(200);
  });
});

describe('a deleted customer leaves nothing behind', () => {
  it('removes every row, file and login of B and touches nobody else', async () => {
    const files = await t.api.raw(`/api/cloud/export`, { headers: { cookie: `pghl_session=${B.b.cookie('pghl_session')}` } });
    expect(files.status).toBe(200);
    const before = { A: count(A.loc), op: count(opLoc), k1: count(k1) };
    const foreign = foreignIds(t.app, B.loc, B.userId);
    expect(foreign.length).toBeGreaterThan(60);
    const needles = [B.loc, B.userId, ...foreign.filter((f) => f.kind === 'id' && f.id.length >= 12).map((f) => f.id)];
    expect([...foreignSnapshot(t.app, needles)].some(([, rows]) => rows.size > 0)).toBe(true);
    const del = await t.api.post(`/api/cloud/console/tenants/${B.tenantId}/delete`, { confirm: `${MARK} Team` });
    expect(del.status, JSON.stringify(del.data)).toBe(200);
    expect(del.data.rows).toBeGreaterThan(100);
    // No table (except the tombstone and the log of the cloud module) still mentions B's sub-account, user or any of its records.
    const left: string[] = [];
    for (const [tbl, rows] of foreignSnapshot(t.app, needles)) if (rows.size && !tbl.startsWith('cloud_')) left.push(`${tbl}: ${[...rows][0].slice(0, 160)}`);
    expect(left).toEqual([]);
    expect(t.app.db.all('SELECT id FROM audit_log WHERE location_id = ?', B.loc)).toEqual([]);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM audit_log'))).not.toMatch(/leakmark\.de|LEAKMARKB Team/i);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM cloud_tenants WHERE id = ?', B.tenantId))).not.toMatch(/leakmark/i);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM cloud_events'))).not.toMatch(/leakmark/i);
    expect(t.app.db.all(`SELECT * FROM cloud_signups WHERE email = 'b@leakmark.de'`)).toEqual([]);
    expect((await B.b.api('GET', '/api/me')).status).toBe(401);
    expect(stripe.store.subs.get(B.sub.id).status).toBe('canceled');
    // The others did not lose a row.
    expect({ A: count(A.loc), op: count(opLoc), k1: count(k1) }).toEqual(before);
    expect((await callA('GET', '/api/contacts', undefined, A.h)).status).toBe(200);
    // Deleting a client of the Agentur removes just that client (and its data) – the other client and the agency stay.
    const beforeC = { agency: count(C.loc), k1: count(k1) };
    expect((await asCall(C.b)('DELETE', `/api/cloud/clients/${k2}`, { confirm: `${MARK} Gamma Kunde 2` })).status).toBe(200);
    expect(t.app.db.get('SELECT 1 AS x FROM contacts WHERE location_id = ?', k2)).toBeUndefined();
    expect({ agency: count(C.loc), k1: count(k1) }).toEqual(beforeC);
    expect((await clientLogin.api('GET', '/api/contacts', undefined, { 'x-location-id': k1 })).status).toBe(200);
  }, 300_000);
});
