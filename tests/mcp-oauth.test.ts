import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { accessFromScope, cleanClientMeta, redirectLabel, redirectUriProblem, s256, verifyPkce } from '../server/services/mcp-oauth.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc1 = '';
let loc2 = '';
const CB = 'https://chatgpt.com/connector_platform_oauth_redirect';

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const verifier = () => randomBytes(32).toString('base64url');
const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

async function register(meta: Record<string, unknown>) {
  const r = await t.api.raw('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta) });
  return { status: r.status, data: (await r.json()) as any };
}
async function authorize(params: Record<string, string>) {
  const r = await t.api.raw(`/oauth/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location') ?? '', text: await r.text() };
}
async function tokenCall(params: Record<string, string>, headers: Record<string, string> = {}) {
  const r = await t.api.raw('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(params) });
  return { status: r.status, data: (await r.json()) as any, headers: r.headers };
}
async function mcp(tok: string, method: string, params?: unknown) {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null, headers: r.headers };
}
const call = async (tok: string, name: string, args: Record<string, unknown> = {}) => (await mcp(tok, 'tools/call', { name, arguments: args })).data.result;

/** authorize → consent (as whoever is signed in) → code. */
async function consent(clientId: string, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  const v = verifier();
  const a = await authorize({ response_type: 'code', client_id: clientId, redirect_uri: CB, code_challenge: challengeOf(v), code_challenge_method: 'S256', state: 'xyz', scope: 'mcp', resource: 'http://localhost/mcp', ...extra });
  expect(a.status).toBe(302);
  const reqId = new URL(a.location, 'http://localhost').searchParams.get('request')!;
  const r = await t.api.post(`/api/mcp-oauth/requests/${reqId}/approve`, body);
  return { r, reqId, verifier: v, code: r.status === 200 ? new URL(r.data.redirect).searchParams.get('code')! : '' };
}
async function connect(clientId: string, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  const c = await consent(clientId, body, extra);
  expect(c.r.status, JSON.stringify(c.r.data)).toBe(200);
  const tok = await tokenCall({ grant_type: 'authorization_code', code: c.code, redirect_uri: CB, client_id: clientId, code_verifier: c.verifier, resource: 'http://localhost/mcp' });
  expect(tok.status, JSON.stringify(tok.data)).toBe(200);
  return tok.data as { access_token: string; refresh_token: string; scope: string; expires_in: number };
}

let publicClient = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc1 = t.api.location;
  loc2 = (await t.api.post('/api/locations', { name: 'Kunde Nord' })).data.id;
  publicClient = (await register({ client_name: 'ChatGPT', redirect_uris: [CB], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })).data.client_id;
});
afterAll(() => t.close());

describe('pure helpers', () => {
  it('checks redirect URIs, PKCE and scopes', () => {
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback')).toBeNull();
    expect(redirectUriProblem('http://127.0.0.1:43123/callback')).toBeNull();
    expect(redirectUriProblem('http://localhost:8080/cb')).toBeNull();
    expect(redirectUriProblem('cursor://anysphere.cursor-retrieval/oauth/callback')).toBeNull();
    expect(redirectUriProblem('http://evil.example.com/cb')).toContain('http nur');
    expect(redirectUriProblem('javascript:alert(1)')).toContain('Schema');
    expect(redirectUriProblem('https://x.example/cb#frag')).toContain('#');
    expect(redirectUriProblem('https://user:pw@x.example/cb')).toContain('Zugangsdaten');
    const v = verifier();
    expect(verifyPkce(v, s256(v))).toBe(true);
    expect(verifyPkce(v, s256(`${v}x`))).toBe(false);
    expect(verifyPkce('kurz', s256('kurz'))).toBe(false);
    expect(accessFromScope('mcp:read')).toBe('read');
    expect(accessFromScope('mcp mcp:read')).toBe('write');
    expect(accessFromScope(undefined)).toBe('write');
    expect(redirectLabel(CB).known).toContain('ChatGPT');
    expect(redirectLabel('http://127.0.0.1:1455/callback').known).toContain('Codex');
    expect(redirectLabel('https://evil.example/cb').known).toBeNull();
    expect(cleanClientMeta({ redirect_uris: [CB], client_name: '<b>Böse</b>\u0007' })).toMatchObject({ ok: true, value: { client_name: 'bBöse/b', token_endpoint_auth_method: 'client_secret_basic' } });
  });
});

describe('discovery', () => {
  it('serves protected resource and authorization server metadata', async () => {
    const prm = await (await t.api.raw('/.well-known/oauth-protected-resource')).json();
    expect(prm).toMatchObject({ resource: 'http://localhost/mcp', authorization_servers: ['http://localhost'], bearer_methods_supported: ['header'] });
    expect(await (await t.api.raw('/.well-known/oauth-protected-resource/mcp')).json()).toEqual(prm);
    const r = await t.api.raw('/.well-known/oauth-authorization-server');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toMatchObject({
      issuer: 'http://localhost',
      authorization_endpoint: 'http://localhost/oauth/authorize',
      token_endpoint: 'http://localhost/oauth/token',
      registration_endpoint: 'http://localhost/oauth/register',
      revocation_endpoint: 'http://localhost/oauth/revoke',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    expect((await t.api.raw('/oauth/token', { method: 'OPTIONS' })).status).toBe(204);
  });

  it('/mcp without a token points to the resource metadata', async () => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer realm="mcp", resource_metadata="http://localhost/.well-known/oauth-protected-resource"');
    const bad = await mcp('pghlo_doesnotexist', 'initialize');
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });
});

describe('dynamic client registration', () => {
  it('validates metadata and issues public or confidential clients', async () => {
    expect((await register({ redirect_uris: ['http://evil.example.com/cb'] })).data.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: ['javascript:alert(1)'] })).data.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [] })).data.error).toBe('invalid_redirect_uri');
    expect((await register({ redirect_uris: [CB], grant_types: ['client_credentials'] })).data.error).toBe('invalid_client_metadata');
    expect((await register({ redirect_uris: [CB], response_types: ['token'] })).data.error).toBe('invalid_client_metadata');
    const pub = await register({ client_name: 'Codex CLI', redirect_uris: ['http://127.0.0.1:1455/callback'], token_endpoint_auth_method: 'none' });
    expect(pub.status).toBe(201);
    expect(pub.data.client_id).toMatch(/^ghc_/);
    expect(pub.data.client_secret).toBeUndefined();
    const conf = await register({ client_name: 'Claude', redirect_uris: [CB] });
    expect(conf.data).toMatchObject({ token_endpoint_auth_method: 'client_secret_basic', client_secret_expires_at: 0 });
    expect(conf.data.client_secret).toMatch(/^ghs_/);
    const row = t.app.db.get('SELECT secret_hash FROM mcp_oauth_clients WHERE id = ?', conf.data.client_id);
    expect(row.secret_hash).not.toContain(conf.data.client_secret);
  });
});

describe('authorization endpoint', () => {
  const base = () => ({ response_type: 'code', client_id: publicClient, redirect_uri: CB, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', state: 's1' });

  it('never redirects for unknown clients or redirect URIs that are not registered exactly', async () => {
    const unknown = await authorize({ ...base(), client_id: 'ghc_nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.location).toBe('');
    expect(unknown.text).toContain('Unbekannte App');
    const other = await authorize({ ...base(), redirect_uri: `${CB}/x` });
    expect(other.status).toBe(400);
    expect(other.location).toBe('');
    expect((await authorize({ ...base(), redirect_uri: `${CB}?a=1` })).status).toBe(400);
  });

  it('sends PKCE, response type and resource errors back with the state', async () => {
    const noPkce = await authorize({ ...base(), code_challenge: '' });
    expect(noPkce.status).toBe(302);
    const u = new URL(noPkce.location);
    expect(`${u.origin}${u.pathname}`).toBe(CB);
    expect(u.searchParams.get('error')).toBe('invalid_request');
    expect(u.searchParams.get('state')).toBe('s1');
    expect(u.searchParams.get('iss')).toBe('http://localhost');
    expect(new URL((await authorize({ ...base(), code_challenge_method: 'plain' })).location).searchParams.get('error_description')).toContain('S256');
    expect(new URL((await authorize({ ...base(), code_challenge: 'zu-kurz' })).location).searchParams.get('error')).toBe('invalid_request');
    expect(new URL((await authorize({ ...base(), response_type: 'token' })).location).searchParams.get('error')).toBe('unsupported_response_type');
    expect(new URL((await authorize({ ...base(), resource: 'https://other.example/mcp' })).location).searchParams.get('error')).toBe('invalid_target');
    const ok = await authorize(base());
    expect(ok.location).toMatch(/^\/app\/oauth-consent\?request=/);
  });
});

describe('full flow', () => {
  it('admin connects one sub-account: PKCE, single-use code, MCP with the scoping of a sub-account key', async () => {
    const c = await consent(publicClient, { target: loc1 });
    expect(c.r.status).toBe(200);
    const back = new URL(c.r.data.redirect);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe('http://localhost');
    // the request is used up
    expect((await t.api.get(`/api/mcp-oauth/requests/${c.reqId}`)).status).toBe(404);

    const ex = { grant_type: 'authorization_code', code: c.code, redirect_uri: CB, client_id: publicClient };
    expect((await tokenCall({ ...ex, code_verifier: verifier() })).data).toMatchObject({ error: 'invalid_grant' });
    expect((await tokenCall({ ...ex })).data.error).toBe('invalid_grant');
    expect((await tokenCall({ ...ex, redirect_uri: `${CB}/x`, code_verifier: c.verifier })).data.error).toBe('invalid_grant');
    expect((await tokenCall({ ...ex, client_id: 'ghc_other', code_verifier: c.verifier })).status).toBe(401);
    const tok = await tokenCall({ ...ex, code_verifier: c.verifier });
    expect(tok.status).toBe(200);
    expect(tok.headers.get('cache-control')).toBe('no-store');
    expect(tok.data).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    expect(tok.data.access_token).toMatch(/^pghlo_/);
    expect(tok.data.refresh_token).toMatch(/^pghlr_/);
    // stored hashed only
    expect(JSON.stringify(t.app.db.all('SELECT * FROM mcp_oauth_tokens'))).not.toContain(tok.data.access_token.slice(6));

    const at = tok.data.access_token;
    expect((await mcp(at, 'initialize', { protocolVersion: '2025-06-18' })).data.result.serverInfo.name).toBe('gohigh');
    const names = (await mcp(at, 'tools/list')).data.result.tools.map((x: any) => x.name);
    expect(names).toContain('ghl_search_contacts');
    expect(names).not.toContain('ghl_create_project');
    expect(names).not.toContain('ghl_audit_log');
    const projects = JSON.parse((await call(at, 'ghl_list_projects')).content[0].text);
    expect(projects.map((p: any) => p.id)).toEqual([loc1]);
    const foreign = await call(at, 'ghl_search_contacts', { location_id: loc2 });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0].text).toContain('403');
    const created = await call(at, 'ghl_upsert_contact', { location_id: loc1, first_name: 'Olga', email: 'olga@example.com' });
    expect(created.isError).toBe(false);
    const audit = (await t.api.get('/api/admin/audit?limit=50')).data;
    expect(audit.some((e: any) => e.action === 'contacts.create' && e.via === 'mcp' && e.location_id === loc1)).toBe(true);
    expect(audit.some((e: any) => e.action === 'mcp_oauth.consent')).toBe(true);
    expect(audit.some((e: any) => e.action === 'mcp_oauth.token')).toBe(true);

    // the REST API does not take the token directly
    expect((await t.api.raw('/api/contacts', { headers: { authorization: `Bearer ${at}` } })).status).toBe(403);

    // the code was single-use: a second exchange fails and ends what was issued from it
    const again = await tokenCall({ ...ex, code_verifier: c.verifier });
    expect(again.data.error).toBe('invalid_grant');
    expect((await mcp(at, 'tools/list')).status).toBe(401);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('expired codes and wrong resources are refused', async () => {
    const c = await consent(publicClient, { target: loc1 });
    t.app.db.run('UPDATE mcp_oauth_codes SET expires_at = ? WHERE code_hash = ?', new Date(Date.now() - 1000).toISOString(), createHash('sha256').update(c.code).digest('hex'));
    expect((await tokenCall({ grant_type: 'authorization_code', code: c.code, redirect_uri: CB, client_id: publicClient, code_verifier: c.verifier })).data.error_description).toContain('abgelaufen');
    const d = await consent(publicClient, { target: loc1 });
    expect((await tokenCall({ grant_type: 'authorization_code', code: d.code, redirect_uri: CB, client_id: publicClient, code_verifier: d.verifier, resource: 'https://other.example/mcp' })).data.error).toBe('invalid_target');
    expect((await tokenCall({ grant_type: 'password', client_id: publicClient })).data.error).toBe('unsupported_grant_type');
  });

  it('admin can grant the agency scope; read-only connections cannot write', async () => {
    const agency = await connect(publicClient, { target: 'agency' });
    const names = (await mcp(agency.access_token, 'tools/list')).data.result.tools.map((x: any) => x.name);
    expect(names).toContain('ghl_create_project');
    const projects = JSON.parse((await call(agency.access_token, 'ghl_list_projects')).content[0].text);
    expect(projects.map((p: any) => p.id).sort()).toEqual([loc1, loc2].sort());
    expect((await call(agency.access_token, 'ghl_search_contacts', { location_id: loc2 })).isError).toBe(false);

    const ro = await connect(publicClient, { target: loc1, access: 'read' });
    expect(ro.scope).toBe('mcp:read');
    expect((await call(ro.access_token, 'ghl_search_contacts', { location_id: loc1 })).isError).toBe(false);
    const w = await call(ro.access_token, 'ghl_upsert_contact', { location_id: loc1, first_name: 'X', email: 'x@example.com' });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toContain('nur lesen');
    // an app asking for mcp:read cannot be widened on the consent screen
    const ro2 = await connect(publicClient, { target: loc1, access: 'write' }, { scope: 'mcp:read' });
    expect(ro2.scope).toBe('mcp:read');
  });

  it('refresh tokens rotate; reuse after rotation revokes the connection; revocation endpoint works', async () => {
    const first = await connect(publicClient, { target: loc1 });
    const r1 = await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: publicClient });
    expect(r1.status).toBe(200);
    expect(r1.data.refresh_token).not.toBe(first.refresh_token);
    expect((await mcp(r1.data.access_token, 'tools/list')).status).toBe(200);
    // a quick retry with the old token is refused but tolerated …
    expect((await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: publicClient })).data.error).toBe('invalid_grant');
    expect((await mcp(r1.data.access_token, 'tools/list')).status).toBe(200);
    // … a later reuse looks like theft and ends the connection
    t.app.db.run('UPDATE mcp_oauth_tokens SET used_at = ? WHERE token_hash = ?', new Date(Date.now() - 60_000).toISOString(), createHash('sha256').update(first.refresh_token).digest('hex'));
    expect((await tokenCall({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: publicClient })).data.error).toBe('invalid_grant');
    expect((await mcp(r1.data.access_token, 'tools/list')).status).toBe(401);
    expect((await tokenCall({ grant_type: 'refresh_token', refresh_token: r1.data.refresh_token, client_id: publicClient })).data.error).toBe('invalid_grant');

    // RFC 7009: revoking the refresh token ends the whole connection
    const second = await connect(publicClient, { target: loc1 });
    const rv = await t.api.raw('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: second.refresh_token, client_id: publicClient }) });
    expect(rv.status).toBe(200);
    expect((await mcp(second.access_token, 'tools/list')).status).toBe(401);
    // unknown tokens: same answer, nothing happens
    expect((await t.api.raw('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: 'pghlr_unknown', client_id: publicClient }) })).status).toBe(200);
    // revoking an access token only ends that token
    const third = await connect(publicClient, { target: loc1 });
    await t.api.raw('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: third.access_token, client_id: publicClient }) });
    expect((await mcp(third.access_token, 'tools/list')).status).toBe(401);
    expect((await tokenCall({ grant_type: 'refresh_token', refresh_token: third.refresh_token, client_id: publicClient })).status).toBe(200);
  });

  it('confidential clients must authenticate (client_secret_basic or _post)', async () => {
    const conf = (await register({ client_name: 'Claude', redirect_uris: [CB] })).data;
    const c = await consent(conf.client_id, { target: loc1 });
    const ex = { grant_type: 'authorization_code', code: c.code, redirect_uri: CB, code_verifier: c.verifier };
    expect((await tokenCall({ ...ex, client_id: conf.client_id })).status).toBe(401);
    expect((await tokenCall({ ...ex, client_id: conf.client_id, client_secret: 'falsch' })).data.error).toBe('invalid_client');
    const basic = Buffer.from(`${conf.client_id}:${conf.client_secret}`).toString('base64');
    const ok = await tokenCall(ex, { authorization: `Basic ${basic}` });
    expect(ok.status).toBe(200);
    const post = await tokenCall({ grant_type: 'refresh_token', refresh_token: ok.data.refresh_token, client_id: conf.client_id, client_secret: conf.client_secret });
    expect(post.status).toBe(200);
  });

  it('connected apps show up on the KI-Werkzeuge page and can be disconnected there', async () => {
    const conn = await connect(publicClient, { target: loc1 });
    const apps = (await t.api.get('/api/ai-tools')).data.apps;
    expect(apps.length).toBeGreaterThan(0);
    expect(apps[0]).toMatchObject({ client_name: 'ChatGPT', redirect_host: 'chatgpt.com', user_name: 'Chef', location_id: loc1 });
    expect((await t.api.get('/api/agency/ai-tools')).data.apps.every((a: any) => a.location_id === null)).toBe(true);
    for (const a of apps) expect((await t.api.del(`/api/ai-tools/apps/${a.id}`)).status).toBe(200);
    expect((await mcp(conn.access_token, 'tools/list')).status).toBe(401);
    expect((await t.api.get('/api/ai-tools')).data.apps).toEqual([]);
  });
});

describe('members (client logins)', () => {
  it('see only their sub-accounts, can never grant agency scope, need the settings area', async () => {
    await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kunde', password: 'geheim1234', role: 'member', locations: [loc2], permissions: ['dashboard', 'settings'] });
    await t.api.post('/api/users', { email: 'mia@example.com', name: 'Mia', password: 'geheim1234', role: 'member', locations: [loc2], permissions: ['contacts'] });
    expect((await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim1234' })).status).toBe(200);
    t.api.setLocation(loc2);
    const v = verifier();
    const a = await authorize({ response_type: 'code', client_id: publicClient, redirect_uri: CB, code_challenge: challengeOf(v), code_challenge_method: 'S256', state: 'p' });
    const reqId = new URL(a.location, 'http://localhost').searchParams.get('request')!;
    const info = (await t.api.get(`/api/mcp-oauth/requests/${reqId}`)).data;
    expect(info).toMatchObject({ can_agency: false, client: { name: 'ChatGPT' }, redirect: { host: 'chatgpt.com' } });
    expect(info.locations).toEqual([{ id: loc2, name: 'Kunde Nord' }]);
    expect((await t.api.post(`/api/mcp-oauth/requests/${reqId}/approve`, { target: 'agency' })).status).toBe(403);
    expect((await t.api.post(`/api/mcp-oauth/requests/${reqId}/approve`, { target: loc1 })).status).toBe(403);
    const ok = await t.api.post(`/api/mcp-oauth/requests/${reqId}/approve`, { target: loc2 });
    expect(ok.status).toBe(200);
    const code = new URL(ok.data.redirect).searchParams.get('code')!;
    const tok = (await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: CB, client_id: publicClient, code_verifier: v })).data;
    const projects = JSON.parse((await call(tok.access_token, 'ghl_list_projects')).content[0].text);
    expect(projects.map((p: any) => p.id)).toEqual([loc2]);
    expect((await mcp(tok.access_token, 'tools/list')).data.result.tools.map((x: any) => x.name)).not.toContain('ghl_create_project');

    // deny sends the user back with access_denied
    const b = await authorize({ response_type: 'code', client_id: publicClient, redirect_uri: CB, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256', state: 'd' });
    const denyId = new URL(b.location, 'http://localhost').searchParams.get('request')!;
    const deny = await t.api.post(`/api/mcp-oauth/requests/${denyId}/deny`, {});
    expect(new URL(deny.data.redirect).searchParams.get('error')).toBe('access_denied');

    // a login without the settings area cannot connect anything
    expect((await t.api.post('/api/auth/login', { email: 'mia@example.com', password: 'geheim1234' })).status).toBe(200);
    const m = await authorize({ response_type: 'code', client_id: publicClient, redirect_uri: CB, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' });
    const mId = new URL(m.location, 'http://localhost').searchParams.get('request')!;
    expect((await t.api.get(`/api/mcp-oauth/requests/${mId}`)).data.locations).toEqual([]);
    expect((await t.api.post(`/api/mcp-oauth/requests/${mId}/approve`, { target: loc2 })).status).toBe(403);

    // when the client login loses the settings area, its connection stops working at once
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    t.api.setLocation(loc1);
    const client = t.app.db.get('SELECT id FROM users WHERE email = ?', 'kunde@example.com');
    expect((await mcp(tok.access_token, 'tools/list')).status).toBe(200);
    t.app.db.run('UPDATE users SET permissions = ? WHERE id = ?', JSON.stringify(['dashboard']), client.id);
    expect((await mcp(tok.access_token, 'tools/list')).status).toBe(401);
    expect((await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: publicClient })).data.error).toBe('invalid_grant');
  });

  it('keys and tokens cannot consent', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'k' })).data.key;
    const a = await authorize({ response_type: 'code', client_id: publicClient, redirect_uri: CB, code_challenge: challengeOf(verifier()), code_challenge_method: 'S256' });
    const reqId = new URL(a.location, 'http://localhost').searchParams.get('request')!;
    const r = await t.api.raw(`/api/mcp-oauth/requests/${reqId}/approve`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'agency' }) });
    expect(r.status).toBe(403);
  });
});
