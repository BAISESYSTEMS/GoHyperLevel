import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers';
import { cleanHeaders, cleanNangoAllow, cleanProxyPath, cleanQuery, endUserFor, isNangoAllowed, nangoErrorFor, signWebhook, verifyWebhook } from '../server/services/nango';
import { renderBody } from '../server/modules/nango';
import { collectAgentTools } from '../server/services/agent-tool-sources';

/** A fake Nango API (Cloud) behind app.services.nangoFetch: integrations, providers, sessions, connections, proxy. */
function fakeNango() {
  const calls: { method: string; url: URL; headers: Record<string, string>; body: any }[] = [];
  const connections: any[] = [];
  const res = (status: number, data: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) => ({ status, ok: status >= 200 && status < 300, headers, text: async () => (typeof data === 'string' ? data : JSON.stringify(data)) });
  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method ?? 'GET', url: u, headers: init.headers ?? {}, body });
    if (init.headers?.authorization !== 'Bearer nango-secret-1234567890') return res(401, { error: { code: 'unknown_account', message: 'Authentication failed' } });
    const p = u.pathname;
    if (p === '/integrations') {
      if (u.search) return res(400, { error: { code: 'invalid_query_params' } });
      return res(200, { data: [{ unique_key: 'github', display_name: 'GitHub', provider: 'github', logo: 'https://app.nango.dev/images/template-logos/github.svg' }, { unique_key: 'zendesk', display_name: 'Zendesk', provider: 'zendesk', logo: '' }, { unique_key: 'odd key', display_name: 'Odd', provider: 'x' }] });
    }
    if (p === '/providers/github') return res(200, { data: { name: 'github', auth_mode: 'OAUTH2', display_name: 'GitHub' } });
    if (p === '/providers/zendesk') return res(200, { data: { name: 'zendesk', auth_mode: 'OAUTH2', connection_config: { subdomain: { type: 'string', title: 'Subdomain' } } } });
    if (p === '/connect/sessions' && init.method === 'POST') return res(201, { data: { token: 'nango_connect_session_abc', connect_link: 'https://connect.nango.dev/?session_token=nango_connect_session_abc', expires_at: new Date(Date.now() + 1800_000).toISOString() } });
    if (p === '/connections' && (init.method ?? 'GET') === 'GET') {
      const uid = u.searchParams.get('endUserId');
      // Like an old server that ignores the filter: HyperLevel must check the end user itself.
      return res(200, { connections: connections.map((c) => ({ ...c, tags: { end_user_id: c.end_user } })) .filter(() => !!uid) });
    }
    const del = p.match(/^\/connections\/(.+)$/);
    if (del && init.method === 'DELETE') {
      const i = connections.findIndex((c) => c.connection_id === decodeURIComponent(del[1]) && c.provider_config_key === u.searchParams.get('provider_config_key'));
      if (i < 0) return res(404, { error: { code: 'unknown_connection' } });
      connections.splice(i, 1);
      return res(200, { success: true });
    }
    if (p.startsWith('/proxy/')) {
      const cid = init.headers['connection-id'];
      const conn = connections.find((c) => c.connection_id === cid && c.provider_config_key === init.headers['provider-config-key']);
      if (!conn) return res(404, { error: { code: 'unknown_connection', message: 'No connection' } });
      if (p === '/proxy/user') return res(200, { login: 'octocat', id: 1, email: 'octo@example.com', accept: init.headers['nango-proxy-accept'] ?? null, query: Object.fromEntries(u.searchParams) });
      if (p === '/proxy/repos/acme/app/issues') return res(201, { number: 7, title: body?.title, body: body?.body });
      if (p === '/proxy/huge') return res(200, 'x'.repeat(10));
      return res(404, { message: 'Not Found' });
    }
    return res(404, { error: { code: 'not_found' } });
  };
  return { calls, connections, fetch, last: (path: string) => [...calls].reverse().find((c) => c.url.pathname === path) };
}

describe('Nango: pure helpers', () => {
  it('validates proxy input and the allow-list', () => {
    expect(cleanProxyPath('/repos/acme/app/issues')).toBe('/repos/acme/app/issues');
    expect(cleanProxyPath('/v4/spreadsheets/x/values/A1:B2:append')).toBe('/v4/spreadsheets/x/values/A1:B2:append');
    for (const bad of ['', 'user', '/a/../b', '//evil.example/x', '/a b', '/x?y=1', '/x#y', 'https://api.github.com/user', '/%2e%2e/x']) expect(() => cleanProxyPath(bad), bad).toThrow();
    expect(cleanQuery('a=1&b=zwei')).toEqual({ a: '1', b: 'zwei' });
    expect(cleanQuery({ per_page: 5, filter: { x: 1 } })).toEqual({ per_page: '5', filter: '{"x":1}' });
    expect(() => cleanHeaders({ Authorization: 'Bearer x' })).toThrow(/nicht erlaubt/);
    expect(() => cleanHeaders({ 'Connection-Id': 'other' })).toThrow();
    expect(() => cleanHeaders({ Accept: 'a\r\nX: y' })).toThrow();
    expect(cleanHeaders({ Accept: 'application/vnd.github+json' })).toEqual({ Accept: 'application/vnd.github+json' });
    const allow = cleanNangoAllow([{ integration: 'github', methods: ['get'], path: '/user*' }, { integration: 'hubspot' }]);
    expect(allow).toEqual([{ integration: 'github', methods: ['GET'], path: '/user*' }, { integration: 'hubspot', methods: ['*'], path: '' }]);
    expect(isNangoAllowed(allow, 'github', 'GET', '/user')).toBe(true);
    expect(isNangoAllowed(allow, 'github', 'GET', '/user/repos')).toBe(true);
    expect(isNangoAllowed(allow, 'github', 'POST', '/user')).toBe(false);
    expect(isNangoAllowed(allow, 'github', 'GET', '/repos')).toBe(false);
    expect(isNangoAllowed(allow, 'hubspot', 'DELETE', '/crm/v3/objects/contacts/1')).toBe(true);
    expect(isNangoAllowed(allow, 'slack', 'GET', '/x')).toBe(false);
    expect(() => cleanNangoAllow([{ integration: 'github', methods: ['TRACE'] }])).toThrow();
    expect(() => cleanNangoAllow([{ integration: 'a:b' }])).toThrow();
    expect(endUserFor('loc1')).toBe('gohigh:loc1');
  });

  it('verifies webhook signatures (X-Nango-Hmac-Sha256) and maps errors to German messages', () => {
    const body = '{"type":"auth"}';
    const sig = signWebhook(body, 'whkey');
    expect(verifyWebhook(body, sig, ['whkey'])).toBe(true);
    expect(verifyWebhook(body, sig.toUpperCase(), ['other', 'whkey'])).toBe(true);
    expect(verifyWebhook(`${body} `, sig, ['whkey'])).toBe(false);
    expect(verifyWebhook(body, 'abc', ['whkey'])).toBe(false);
    expect(verifyWebhook(body, sig, [])).toBe(false);
    expect(nangoErrorFor(401, {}).message).toMatch(/Secret-Key ist ungültig/);
    expect(nangoErrorFor(400, { error: { code: 'invalid_body', errors: [{ path: ['allowed_integrations', 0], message: 'Integration does not exist' }] } }).message).toMatch(/allowed_integrations.0: Integration does not exist/);
    expect(nangoErrorFor(424, {}).status).toBe(409);
  });

  it('renders merge fields into JSON bodies without breaking them', () => {
    expect(renderBody('{"title":"Neuer Lead {{contact.name}}","n":1}', { contact: { name: 'Max "M"' } })).toEqual({ title: 'Neuer Lead Max "M"', n: 1 });
    expect(renderBody('{"amount": {{event.total}}}', { event: { total: 42 } })).toEqual({ amount: 42 });
    expect(() => renderBody('kein json', {})).toThrow(/JSON/);
    expect(renderBody('', {})).toBeUndefined();
  });
});

// --- end to end -------------------------------------------------------------------------------------------

const nango = fakeNango();
let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
let keyA = '';
let keyB = '';

const asKey = (key: string, method: string, path: string, body?: unknown) =>
  t.api.raw(path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.nangoFetch = nango.fetch;
  await t.setup();
  locA = t.api.location;
  locB = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  keyA = (await t.api.post('/api/api-keys', { name: 'A' })).data.key;
  t.api.setLocation(locB);
  keyB = (await t.api.post('/api/api-keys', { name: 'B' })).data.key;
  t.api.setLocation(locA);
});
afterAll(() => t.close());
beforeEach(() => t.api.setLocation(locA));

describe('Nango: agency setup', () => {
  it('stores the base URL and a sealed secret key, never returns it and tests the connection', async () => {
    expect((await t.api.get('/api/nango')).data.configured).toBe(false);
    expect((await t.api.get('/api/nango/integrations')).status).toBe(409);
    expect((await t.api.put('/api/agency/nango', { base_url: 'https://api.nango.dev', secret_key: 'short' })).status).toBe(400);
    expect((await t.api.put('/api/agency/nango', { base_url: 'ftp://x', secret_key: 'nango-secret-1234567890' })).status).toBe(400);
    const r = await t.api.put('/api/agency/nango', { base_url: 'https://api.nango.dev/', secret_key: 'nango-secret-1234567890', webhook_key: 'whsign-123456' });
    expect(r.data).toMatchObject({ configured: true, base_url: 'https://api.nango.dev', key_hint: '…7890', webhook_key_set: true, cloud: true, webhook_url: 'http://localhost/hooks/nango' });
    expect(JSON.stringify(r.data)).not.toContain('nango-secret-1234567890');
    const stored = JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'nango'`).value);
    expect(stored.secret_key).toMatch(/^v[12]:/);
    expect(stored.webhook_key).toMatch(/^v[12]:/);
    const test = await t.api.post('/api/agency/nango/test');
    expect(test.data).toMatchObject({ ok: true, integrations: 3 });
    expect(nango.last('/integrations')!.headers.authorization).toBe('Bearer nango-secret-1234567890');
    // a wrong key gives a clear message
    await t.api.put('/api/agency/nango', { secret_key: 'nango-wrong-12345678901' });
    expect((await t.api.post('/api/agency/nango/test')).data.error).toMatch(/Secret-Key ist ungültig/);
    await t.api.put('/api/agency/nango', { secret_key: 'nango-secret-1234567890' });
  });

  it('shows the integrations configured in Nango in the sub-account catalogue', async () => {
    const list = (await t.api.get('/api/nango/integrations')).data;
    expect(list.map((i: any) => i.key)).toEqual(['github', 'zendesk', 'odd key']);
    expect(list[0]).toMatchObject({ name: 'GitHub', supported: true, connection: null, logo: expect.stringMatching(/^https:/) });
    expect(list[2].supported).toBe(false);
    const cat = (await t.api.get('/api/integrations/catalog')).data.items.find((i: any) => i.key === 'nango');
    expect(cat).toMatchObject({ status: 'info', setup: { location: 'apps/nango' } });
  });
});

describe('Nango: connect, sync, proxy', () => {
  it('connects with a redirect: OAuth apps straight to the provider, others through the Connect UI', async () => {
    const r = await t.api.post('/api/nango/connect', { integration: 'github' });
    expect(r.status).toBe(200);
    expect(r.data.mode).toBe('oauth');
    expect(r.data.url).toBe('https://api.nango.dev/oauth/connect/github?connect_session_token=nango_connect_session_abc');
    expect(nango.last('/connect/sessions')!.body).toEqual({ end_user: { id: `gohigh:${locA}`, display_name: 'Testfirma' }, organization: { id: 'gohigh', display_name: 'HyperLevel' }, allowed_integrations: ['github'] });
    const z = await t.api.post('/api/nango/connect', { integration: 'zendesk' });
    expect(z.data).toMatchObject({ mode: 'connect_ui', url: 'https://connect.nango.dev/?session_token=nango_connect_session_abc' });
    expect((await t.api.post('/api/nango/connect', { integration: 'slack' })).status).toBe(400);
    // only signed in in the browser
    expect((await asKey(keyA, 'POST', '/api/nango/connect', { integration: 'github' })).status).toBe(403);
    expect((await t.api.get('/api/nango')).data.pending.map((p: any) => p.integration).sort()).toEqual(['github', 'zendesk']);
  });

  it('syncs only connections of this sub-account’s end user', async () => {
    nango.connections.push(
      { connection_id: 'conn-a', provider_config_key: 'github', provider: 'github', created: '2026-10-01', end_user: `gohigh:${locA}`, errors: [] },
      { connection_id: 'conn-b', provider_config_key: 'github', provider: 'github', created: '2026-10-01', end_user: `gohigh:${locB}`, errors: [] },
      { connection_id: 'conn-x', provider_config_key: 'github', provider: 'github', created: '2026-10-01', end_user: 'someone-else', errors: [] },
    );
    const attempt = (await t.api.get('/api/nango')).data.pending.find((p: any) => p.integration === 'github');
    const st = await t.api.get(`/api/nango/attempts/${attempt.id}`);
    expect(st.data.status).toBe('done');
    const conns = (await t.api.get('/api/nango/connections')).data;
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ integration: 'github', status: 'active' });
    expect(nango.last('/connections')!.url.searchParams.get('endUserId')).toBe(`gohigh:${locA}`);
    t.api.setLocation(locB);
    expect((await t.api.get('/api/nango/connections?refresh=1')).data.map((c: any) => c.integration)).toEqual(['github']);
    expect(t.app.db.get('SELECT connection_id FROM nango_connections WHERE location_id = ?', locB).connection_id).toBe('conn-b');
  });

  it('proxies requests with the sub-account’s own connection, merge fields and a call log', async () => {
    const r = await t.api.post('/api/nango/request', { integration: 'github', method: 'GET', path: '/user', query: { per_page: 5 }, headers: { Accept: 'application/vnd.github+json' } });
    expect(r.data).toMatchObject({ status: 200, ok: true, data: { login: 'octocat', accept: 'application/vnd.github+json', query: { per_page: '5' } } });
    const call = nango.last('/proxy/user')!;
    expect(call.headers['connection-id']).toBe('conn-a');
    expect(call.headers['provider-config-key']).toBe('github');
    expect(call.headers.authorization).toBe('Bearer nango-secret-1234567890');
    expect((await t.api.post('/api/nango/request', { integration: 'github', path: '/a/../b' })).status).toBe(400);
    expect((await t.api.post('/api/nango/request', { integration: 'github', path: '/user', headers: { Authorization: 'x' } })).status).toBe(400);
    expect((await t.api.post('/api/nango/request', { integration: 'zendesk', path: '/x' })).data.error).toMatch(/nicht verbunden/);
    const calls = (await t.api.get('/api/nango/calls')).data;
    expect(calls[0]).toMatchObject({ integration: 'github', method: 'GET', path: '/user', status: 200, ok: true, source: 'ui' });
  });

  it('API keys and MCP stay within the allow-list and their own sub-account', async () => {
    expect((await asKey(keyA, 'POST', '/api/nango/request', { integration: 'github', path: '/user' })).status).toBe(403);
    // the key can't widen its own allow-list
    expect((await asKey(keyA, 'PUT', '/api/nango/allow', { allow: [{ integration: 'github' }] })).status).toBe(403);
    await t.api.put('/api/nango/allow', { allow: [{ integration: 'github', methods: ['GET'], path: '/user*' }] });
    expect((await asKey(keyA, 'POST', '/api/nango/request', { integration: 'github', path: '/user' })).data).toMatchObject({ ok: true });
    expect((await asKey(keyA, 'POST', '/api/nango/request', { integration: 'github', method: 'POST', path: '/user' })).status).toBe(403);
    expect((await asKey(keyA, 'POST', '/api/nango/request', { integration: 'github', path: '/repos/acme/app/issues' })).status).toBe(403);
    // B's key reaches B's connection only – never A's
    expect((await asKey(keyB, 'POST', '/api/nango/request', { integration: 'github', path: '/user' })).status).toBe(403);
    const aConn = (await t.api.get('/api/nango/connections')).data[0];
    expect((await asKey(keyB, 'DELETE', `/api/nango/connections/${aConn.id}`)).status).toBe(404);
    // MCP tool ghl_nango_request relays onto the same route
    const mcp = (msg: unknown) => t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${keyA}`, 'content-type': 'application/json' }, body: JSON.stringify(msg) }).then((r) => r.json());
    const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_nango_request', arguments: { location_id: locA, mode: 'integrations' } } });
    expect(JSON.parse(list.result.content[0].text)).toMatchObject({ integrations: [{ integration: 'github' }], allowed: [{ integration: 'github', methods: ['GET'] }] });
    const ok = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_nango_request', arguments: { location_id: locA, mode: 'request', integration: 'github', method: 'GET', path: '/user' } } });
    expect(ok.result.isError).toBe(false);
    const denied = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_nango_request', arguments: { location_id: locA, mode: 'request', integration: 'github', method: 'DELETE', path: '/user' } } });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toMatch(/nicht freigegeben/);
    const foreign = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghl_nango_request', arguments: { location_id: locB, mode: 'integrations' } } });
    expect(foreign.result.isError).toBe(true);
  });

  it('agent tool: only allow-listed integrations, read-only when every rule is GET-only', async () => {
    const tools = await collectAgentTools(t.app, { locationId: locA });
    const nt = tools.find((x) => x.name === 'nango_request')!;
    expect(nt.annotations).toEqual({ readOnlyHint: true });
    expect((nt.input_schema as any).properties.integration.enum).toEqual(['github']);
    const r = await nt.run({ integration: 'github', method: 'GET', path: '/user' });
    expect(JSON.parse(r.content)).toMatchObject({ untrusted: true, source: 'nango:github' });
    expect((await nt.run({ integration: 'github', method: 'POST', path: '/user' })).is_error).toBe(true);
    expect((await collectAgentTools(t.app, { locationId: locB })).some((x) => x.name === 'nango_request')).toBe(false);
  });

  it('workflow action „API-Aufruf über Nango“ with merge fields and result mapping', async () => {
    await t.api.post('/api/custom-fields', { key: 'issue_no', label: 'Issue', type: 'text' });
    const c = (await t.api.post('/api/contacts', { first_name: 'Erika', email: 'erika@example.com' })).data;
    const run = { id: 'run_n', location_id: locA, contact_id: c.id, event: {} as any };
    const step = { integration: 'github', method: 'POST', path: '/repos/{{event.repo}}/issues', body: '{"title":"Lead {{contact.first_name}}","body":"Mail: {{contact.email}}"}', map: [{ from: 'number', to: 'custom.issue_no' }] };
    const msg = await t.app.services.workflowActions.nango_request(run, step, { contact: { first_name: 'Erika', email: 'erika@example.com' }, event: { repo: 'acme/app' } });
    expect(msg).toMatch(/github: POST \/repos\/acme\/app\/issues → 201 · übernommen: custom.issue_no/);
    expect(nango.last('/proxy/repos/acme/app/issues')!.body).toEqual({ title: 'Lead Erika', body: 'Mail: erika@example.com' });
    expect(run.event.nango_result).toMatchObject({ status: 201, data: { number: 7 } });
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.custom.issue_no).toBe('7');
    await expect(t.app.services.workflowActions.nango_request(run, { integration: 'github', path: '/missing' }, {})).rejects.toThrow(/HTTP 404/);
  });

  it('webhooks: signed auth events create, flag and delete connections of the right sub-account', async () => {
    const send = (payload: unknown, key = 'whsign-123456') => {
      const raw = JSON.stringify(payload);
      return t.api.raw('/hooks/nango', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nango-hmac-sha256': signWebhook(raw, key) }, body: raw });
    };
    const base = { from: 'nango', type: 'auth', authMode: 'OAUTH2', providerConfigKey: 'zendesk', provider: 'zendesk', environment: 'PROD' };
    expect((await send({ ...base, operation: 'creation', success: true, connectionId: 'conn-z', tags: { end_user_id: `gohigh:${locA}` } }, 'wrong')).status).toBe(401);
    expect((await send({ ...base, operation: 'creation', success: true, connectionId: 'conn-z', tags: { end_user_id: `gohigh:${locA}` } })).status).toBe(200);
    expect((await t.api.get('/api/nango/connections')).data.map((c: any) => c.integration).sort()).toEqual(['github', 'zendesk']);
    // the secret key also verifies (older environments sign with it)
    expect((await send({ ...base, operation: 'refresh', success: false, connectionId: 'conn-z', endUser: { endUserId: `gohigh:${locA}`, tags: {} }, error: { type: 'refresh_token_external_error', description: 'invalid_grant' } }, 'nango-secret-1234567890')).status).toBe(200);
    expect((await t.api.get('/api/nango/connections')).data.find((c: any) => c.integration === 'zendesk')).toMatchObject({ status: 'error', status_reason: 'invalid_grant' });
    // unknown end users are ignored
    expect((await (await send({ ...base, operation: 'creation', success: true, connectionId: 'conn-q', tags: { end_user_id: 'gohigh:nope' } })).json())).toMatchObject({ ignored: true });
    await send({ ...base, operation: 'deletion', success: true, connectionId: 'conn-z', tags: { end_user_id: `gohigh:${locA}` } });
    expect((await t.api.get('/api/nango/connections')).data.map((c: any) => c.integration)).toEqual(['github']);
  });

  it('disconnect deletes the connection at Nango too', async () => {
    const conn = (await t.api.get('/api/nango/connections')).data[0];
    expect((await t.api.del(`/api/nango/connections/${conn.id}`)).status).toBe(200);
    expect(nango.connections.some((c) => c.connection_id === 'conn-a')).toBe(false);
    expect((await t.api.get('/api/nango/connections')).data).toEqual([]);
  });
});
