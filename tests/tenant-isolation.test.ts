import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Route } from '../server/core/http.js';
import { startTestApp } from './helpers.js';
import { sealWith } from '../server/core/secrets.js';
import { MARK, client, diffSnapshots, foreignIds, foreignNaturalKeys, foreignSnapshot, seedBooksSyncRows, seedCogneeRows, seedCreatorRows, seedLocation, seedMarketingRows, seedTelephonyRows, type Call } from './security-fixtures.js';
import { writeConn } from '../server/services/cognee/connection.js';

/**
 * Tenant isolation harness. Enumerates every registered route (router introspection), and for every
 * `location`/`user` route a member of sub-account A, A's API key and A's member's mobile device token
 * try to read or change sub-account B's records (ids from the fixtures in every path parameter, plus
 * B references in query and body). A response must never contain B's marker, and no row of B (or row
 * pointing at B) may change. Run with SECURITY_HARNESS_VERBOSE=1 to print every request.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let adminId = '';
let member: Call;
let key: Call;
let device: Call;
let keyToken = '';
let agencyKey = '';
let foreign: { id: string; table: string; kind: 'id' | 'key' }[] = [];
const realFetch = globalThis.fetch;

/** Routes that end the principal's own session or need a fresh second factor – nothing cross-tenant to test. */
const SELF = [/^POST \/api\/auth\/logout$/, /^POST \/api\/me\/password$/, /^\w+ \/api\/me\/2fa/, /^\w+ \/api\/me\/sessions/, /^POST \/api\/mobile\/logout$/];

beforeAll(async () => {
  // No outbound network from the app: only our own server answers.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp();
  const me = await t.setup();
  adminId = me.user.id;
  // Wissensgedächtnis: a configured server that is not reachable – the routes get as far as calling out, and fail there.
  t.app.services.cogneeFetch = async () => {
    throw new Error('offline in tests');
  };
  t.app.services.cogneeSleep = async () => undefined;
  writeConn(t.app, { base_url: 'http://cognee:8000', auth_mode: 'password', email: 'gohigh@example.com', secret: 'pw-for-the-fake', hint: '…fake', allow_private: true, allow_open_server: false, locations_may_enable: true, updated_at: new Date().toISOString() });
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: `${MARK} Firma` })).data.id;
  const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1' });
  // Integrations "connected" (their APIs are offline), so routes get past "not set up" to their lookups.
  t.app.db.run(`INSERT INTO agency_settings (key, value) VALUES ('postiz', ?)`, JSON.stringify({ url: 'https://postiz.invalid', api_key: 'k' }));
  await admin('PATCH', '/api/agency/video-studio', { url: 'https://openshorts.invalid', api_key: 'test-key' });
  const a = await seedLocation(admin, A, 'Alpha');
  const b = await seedLocation(admin, B, MARK);
  // The seed covers the important record types; a step that fails would weaken the harness silently.
  expect(b.failed, b.failed.join('\n')).toEqual([]);
  expect(a.failed, a.failed.join('\n')).toEqual([]);
  seedCreatorRows(t.app, A, a.ids, 'Alpha');
  seedCreatorRows(t.app, B, b.ids, MARK);
  seedCogneeRows(t.app, A, a.ids, 'Alpha');
  seedCogneeRows(t.app, B, b.ids, MARK);
  seedMarketingRows(t.app, A, a.ids, 'Alpha');
  seedMarketingRows(t.app, B, b.ids, MARK);
  seedTelephonyRows(t.app, A, a.ids, 'Alpha');
  seedTelephonyRows(t.app, B, b.ids, MARK);
  seedBooksSyncRows(t.app, A, a.ids, 'Alpha');
  seedBooksSyncRows(t.app, B, b.ids, MARK);
  // Umzug: a connection (the key sealed), a finished import with warnings and log, its id map and undo list – connecting needs the
  // vendor, so the rows are written the way the module writes them.
  {
    const at = new Date().toISOString();
    const rid = (n: string) => `${n}${'0'.repeat(20 - n.length)}`;
    t.app.db.run(`INSERT INTO umzug_connections (id, location_id, source, label, account, secret_sealed, hint, meta, created_at, updated_at) VALUES (?, ?, 'mailchimp', ?, ?, ?, '…8a13', '{}', ?, ?)`, rid('umconn'), B, `${MARK} Newsletter`, `us12:${MARK}`, sealWith(t.app.config, JSON.stringify({ api_key: `${MARK}-key-us12` })), at, at);
    t.app.db.run(
      `INSERT INTO umzug_jobs (id, location_id, source, kind, status, origin, connection_id, file_ids, parts, options, mapping, progress, result, log, warnings, created_at, updated_at, finished_at) VALUES (?, ?, 'mailchimp', 'import', 'done', 'api', ?, '[]', '["contacts"]', '{}', '{}', '{}', ?, ?, ?, ?, ?, ?)`,
      rid('umjob'), B, rid('umconn'), JSON.stringify({ report: [{ key: 'contacts', label: `${MARK} Kontakte`, created: 1, updated: 0, skipped: 0, failed: 0 }] }), JSON.stringify([`${MARK} Protokoll`]), JSON.stringify([`${MARK} Warnung`]), at, at, at,
    );
    t.app.db.run(`INSERT INTO umzug_ids (location_id, ns, kind, ext_id, local_id, extra, job_id, updated_at) VALUES (?, ?, 'contact', ?, ?, NULL, ?, ?)`, B, `mailchimp:${MARK}`, `${MARK}-ext`, b.ids.contact, rid('umjob'), at);
    t.app.db.run(`INSERT INTO umzug_items (job_id, kind, local_id, ext_id, created, before) VALUES (?, 'contact', ?, ?, 0, ?)`, rid('umjob'), b.ids.contact, `${MARK}-ext`, JSON.stringify({ email: `${MARK}@example.com` }));
  }
  // Personal records of another user (the admin): a device and push subscription carry the marker too.
  await admin('POST', '/api/mobile/pair', { device_name: `${MARK} Pixel` });

  await t.api.post('/api/users', { email: 'member-a@example.com', password: 'passwort-a1', name: 'Member A', locations: [A] });
  member = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await member('POST', '/api/auth/login', { email: 'member-a@example.com', password: 'passwort-a1' })).status).toBe(200);
  const k = (await member('POST', '/api/api-keys', { name: 'A key' })).data.key;
  keyToken = k;
  agencyKey = (await admin('POST', '/api/agency/api-keys', { name: 'Agentur' })).data.key;
  key = client(t.base, { authorization: `Bearer ${k}`, 'x-location-id': A });
  const tok = (await member('POST', '/api/mobile/pair', { device_name: 'A phone' })).data.token;
  device = client(t.base, { authorization: `Bearer ${tok}`, 'x-location-id': A });
  foreign = foreignIds(t.app, B, adminId);
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
});

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/(ies)$/, 'y')
    .replace(/(es|s)$/, '');

function candidates(route: Route, i: number): string[] {
  const p = route.parts[i].slice(1);
  const hints = [p.replace(/(Id|_id)$/, '')];
  if (/^(id|lid|n)$/.test(p) || hints[0] === p) hints.push(route.parts[i - 1] ?? '');
  const want = hints.map(norm).filter((h) => h.length >= 3 && h !== 'id');
  const matched = foreign.filter((f) => want.some((h) => norm(f.table).includes(h) || h.includes(norm(f.table))));
  if (matched.length) return [...new Set(matched.map((f) => f.id))].slice(0, 25);
  // Unknown parameter: one id (and one key/token/slug) of every table is enough to catch a lookup without a location filter.
  const perTable = new Map<string, string[]>();
  for (const f of foreign) {
    const l = perTable.get(f.table) ?? [];
    if (l.length < 2) l.push(f.id);
    perTable.set(f.table, l);
  }
  return [...perTable.values()].flat();
}

function referenceBody(): Record<string, any> {
  const body: Record<string, any> = { location_id: B, locationId: B, target_location_id: B, name: 'harness', title: 'harness', body: 'harness', email: 'harness@example.com' };
  for (const f of foreign.filter((x) => x.kind === 'id')) {
    const one = norm(f.table);
    for (const k of [`${one}_id`, `${one}Id`]) if (!(k in body)) body[k] = f.id;
  }
  const contacts = foreign.filter((f) => f.table === 'contacts' && f.kind === 'id').map((f) => f.id);
  Object.assign(body, { contact_id: contacts[0], contactId: contacts[0], contact_ids: contacts, contactIds: contacts, ids: foreign.filter((f) => f.kind === 'id').slice(0, 50).map((f) => f.id) });
  return body;
}

/** B's natural keys (url, email, slug…) of the table a route works on – catches lookups by value ("upsert by URL"). */
function naturalBody(route: Route, natural: Map<string, Record<string, string>>): Record<string, any> | undefined {
  const seg = norm(route.parts[1] ?? '');
  const seg2 = norm(route.parts[2] ?? '');
  for (const [table, vals] of natural) {
    const n = norm(table);
    if (seg.length >= 3 && (n.includes(seg) || seg.includes(n) || (seg2.length >= 3 && n.includes(seg2)))) {
      // Names carry the marker and would only echo back; the lookup values are what matters.
      const { name: _n, title: _t, ...keys } = vals;
      if (Object.keys(keys).length) return { ...keys, name: 'harness', title: 'harness' };
    }
  }
  return undefined;
}

async function attack(who: string, call: Call, routes: Route[]) {
  const leaks: string[] = [];
  // Only random ids are needles: keys and slugs ("allgemein", "1") also occur in A's own rows.
  const needles = [B, ...foreign.filter((f) => f.kind === 'id' && f.id.length >= 12).map((f) => f.id)];
  let snap = foreignSnapshot(t.app, needles);
  const body = referenceBody();
  const c = body.contact_id;
  const query = `?contact_id=${c}&contactId=${c}&locationId=${B}&location_id=${B}`;
  const verbose = process.env.SECURITY_HARNESS_VERBOSE === '1';
  for (const route of routes) {
    const sig = `${route.method} ${route.pattern}`;
    if (SELF.some((r) => r.test(sig))) continue;
    const slots = route.parts.map((p, i) => (p.startsWith(':') ? candidates(route, i) : null));
    const n = Math.max(1, ...slots.map((s) => s?.length ?? 0));
    for (let v = 0; v < n; v++) {
      const path = '/' + route.parts.map((p, i) => (slots[i] ? encodeURIComponent(slots[i]![v % slots[i]!.length]) : p)).join('/');
      const r = await call(route.method, path + query, route.method === 'GET' ? undefined : body);
      if (verbose) console.log(who, route.method, path, r.status);
      if (r.text.toUpperCase().includes(MARK)) leaks.push(`${who} READ ${route.method} ${path} → ${r.status} ${r.text.slice(Math.max(0, r.text.toUpperCase().indexOf(MARK) - 80), r.text.toUpperCase().indexOf(MARK) + 40)}`);
    }

    if (route.method !== 'GET') {
      const next = foreignSnapshot(t.app, needles);
      const d = diffSnapshots(snap, next);
      if (d.length) leaks.push(`${who} WRITE ${sig}: ${d.slice(0, 3).join(' | ')}`);
      snap = next;
    }
  }
  return leaks;
}

/**
 * Second pass: bodies with B's natural keys (url, email, slug…) on create/upsert routes. Their values
 * carry B's marker and echo back, so this pass looks for B's row ids in responses and B's rows changing.
 * It runs last because the records it creates in A would look like leaks to the marker check.
 */
async function attackNatural(who: string, call: Call, routes: Route[]) {
  const leaks: string[] = [];
  const ids = foreign.filter((f) => f.kind === 'id' && f.id.length >= 12).map((f) => f.id);
  const needles = [B, ...ids];
  let snap = foreignSnapshot(t.app, needles);
  const natural = foreignNaturalKeys(t.app, B);
  for (const route of routes) {
    if (route.method === 'GET' || route.parts.some((p) => p.startsWith(':'))) continue;
    const nb = naturalBody(route, natural);
    if (!nb) continue;
    const r = await call(route.method, '/' + route.parts.join('/'), nb);
    const hit = ids.find((x) => r.text.includes(x));
    if (hit) leaks.push(`${who} READ(natural) ${route.method} ${route.pattern} → ${r.status} returned B's ${foreign.find((f) => f.id === hit)?.table} ${hit}`);
    const next = foreignSnapshot(t.app, needles);
    const d = diffSnapshots(snap, next);
    if (d.length) leaks.push(`${who} WRITE(natural) ${route.method} ${route.pattern}: ${d.slice(0, 3).join(' | ')}`);
    snap = next;
  }
  return leaks;
}

const routes = () => ((t.app.router as any).routes as Route[]).filter((r) => r.auth === 'location' || r.auth === 'user');

describe('tenant isolation', () => {
  it('lists every route with an auth level', () => {
    const all = (t.app.router as any).routes as Route[];
    expect(all.length).toBeGreaterThan(500);
    for (const r of all) expect(['public', 'user', 'admin', 'location']).toContain(r.auth);
    expect(foreign.length).toBeGreaterThan(60);
  });

  it('a member of A gets 403 on every location route when asking for B', async () => {
    const wrong: string[] = [];
    for (const r of routes().filter((x) => x.auth === 'location')) {
      const path = '/' + r.parts.map((p) => (p.startsWith(':') ? 'x' : p)).join('/');
      const res = await member(r.method, path, r.method === 'GET' ? undefined : {}, { 'x-location-id': B });
      if (res.status !== 403) wrong.push(`${r.method} ${r.pattern} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a member of A gets 403 on every admin route', async () => {
    const wrong: string[] = [];
    for (const r of ((t.app.router as any).routes as Route[]).filter((x) => x.auth === 'admin')) {
      const path = '/' + r.parts.map((p) => (p.startsWith(':') ? 'x' : p)).join('/');
      const res = await member(r.method, path, r.method === 'GET' ? undefined : {});
      if (res.status !== 403) wrong.push(`${r.method} ${r.pattern} → ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("A's member session never reads or changes B's records", { timeout: 600_000 }, async () => {
    const leaks = await attack('member', member, routes());
    expect(leaks).toEqual([]);
  });

  it("A's location API key never reads or changes B's records", { timeout: 600_000 }, async () => {
    const leaks = await attack('key', key, routes().filter((r) => r.auth === 'location'));
    expect(leaks).toEqual([]);
  });

  it("A's member's mobile device token never reads or changes B's records", { timeout: 600_000 }, async () => {
    const leaks = await attack('device', device, routes().filter((r) => r.pattern.startsWith('/api/mobile/')));
    expect(leaks).toEqual([]);
  });

  it("MCP with A's location key never returns or changes B's records", { timeout: 600_000 }, async () => {
    const mcp = client(t.base, { authorization: `Bearer ${keyToken}` });
    let n = 0;
    const rpc = async (method: string, params: any) => (await mcp('POST', '/mcp', { jsonrpc: '2.0', id: ++n, method, params })).data;
    const tools: any[] = (await rpc('tools/list', {})).result.tools;
    expect(tools.length).toBeGreaterThan(20);
    const leaks: string[] = [];
    const needles = [B, ...foreign.filter((f) => f.kind === 'id' && f.id.length >= 12).map((f) => f.id)];
    let snap = foreignSnapshot(t.app, needles);
    const ids = foreign.filter((f) => f.kind === 'id');
    for (const tool of tools) {
      const props: Record<string, any> = tool.inputSchema?.properties ?? {};
      const idProps = Object.keys(props).filter((k) => /(^id$|_id$|Id$)/.test(k));
      const variants = idProps.length ? 12 : 1;
      for (let v = 0; v < variants; v++) {
        const args: Record<string, any> = {};
        for (const [name, sch] of Object.entries(props)) {
          if (/location/.test(name)) args[name] = B;
          else if (/(^id$|_id$|Id$)/.test(name)) {
            const hint = norm(name.replace(/(_id|Id)$/, ''));
            const list = ids.filter((f) => hint.length >= 3 && (norm(f.table).includes(hint) || hint.includes(norm(f.table))));
            const pool = list.length ? list : ids;
            args[name] = pool[(v * 7) % pool.length].id;
          } else if (sch.type === 'array') args[name] = sch.items?.type === 'string' ? [ids[v % ids.length].id] : [];
          else if (sch.enum) args[name] = sch.enum[0];
          else if (sch.type === 'number' || sch.type === 'integer') args[name] = 1;
          else if (sch.type === 'boolean') args[name] = false;
          else if (sch.type === 'object') args[name] = {};
          else args[name] = 'harness';
        }
        const out = JSON.stringify(await rpc('tools/call', { name: tool.name, arguments: args }));
        if (out.toUpperCase().includes(MARK)) leaks.push(`mcp READ ${tool.name} ${JSON.stringify(args).slice(0, 120)} → ${out.slice(Math.max(0, out.toUpperCase().indexOf(MARK) - 80), out.toUpperCase().indexOf(MARK) + 40)}`);
      }
      if (!tool.annotations?.readOnlyHint) {
        const next = foreignSnapshot(t.app, needles);
        const d = diffSnapshots(snap, next);
        if (d.length) leaks.push(`mcp WRITE ${tool.name}: ${d.slice(0, 3).join(' | ')}`);
        snap = next;
      }
    }
    expect(leaks).toEqual([]);
  });

  it('agency keys manage data, not people, keys, sessions or backups', async () => {
    const ak = client(t.base, { authorization: `Bearer ${agencyKey}`, 'x-location-id': A });
    const blocked: [string, string][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/me'],
      ['GET', '/api/agency/api-keys'],
      ['POST', '/api/agency/api-keys'],
      ['GET', '/api/admin/backup'],
      ['GET', '/api/admin/backups'],
      ['POST', '/api/admin/backups'],
      ['POST', '/api/mobile/pair'],
      ['POST', '/api/api-keys'],
      ['POST', '/api/me/2fa/setup'],
      ['GET', '/api/me/sessions'],
      ['POST', '/api/oauth/start'],
    ];
    const wrong: string[] = [];
    for (const [m, path] of blocked) {
      const r = await ak(m, path, m === 'GET' ? undefined : {});
      if (r.status !== 403) wrong.push(`${m} ${path} → ${r.status}`);
    }
    expect(wrong).toEqual([]);
    // …while data routes keep working.
    expect((await ak('GET', '/api/contacts')).status).toBe(200);
  });

  it('a location key cannot use another sub-account even when it names it', async () => {
    const r = await key('GET', '/api/contacts', undefined, { 'x-location-id': B });
    expect(r.status).toBe(200);
    expect(r.text.toUpperCase()).not.toContain(MARK);
    expect((await key('GET', '/api/users')).status).toBe(403);
    expect((await key('GET', '/api/me')).status).toBe(403);
    expect((await key('GET', '/api/locations')).status).toBe(403);
  });

  it('a device token only opens the app API', async () => {
    expect((await device('GET', '/api/contacts')).status).toBe(403);
    expect((await device('GET', '/api/mobile/contacts', undefined, { 'x-location-id': B })).text.toUpperCase()).not.toContain(MARK);
  });

  // Last: the natural-key pass leaves A records with B's values behind.
  it('creating or upserting by url/email/slug never touches or returns B records', { timeout: 300_000 }, async () => {
    const leaks = [...(await attackNatural('member', member, routes())), ...(await attackNatural('key', key, routes().filter((r) => r.auth === 'location')))];
    expect(leaks).toEqual([]);
  });
});
