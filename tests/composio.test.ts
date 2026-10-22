import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry as aiRetry } from '../server/services/anthropic.js';
import { cleanAllow, guessContact, isAllowed, normalizeEvent, retry, signLinkState, signWebhook, verifyLinkState, verifyWebhook } from '../server/services/composio.js';
import { coerceArgs, renderArgs, schemaPaths, schemaSummary } from '../server/services/composio-schema.js';
import { mapResult } from '../server/modules/composio-automation.js';
import { slimPayload } from '../server/modules/composio-triggers.js';

/**
 * Composio over mocked HTTP: no request ever leaves the process. The fake below answers the
 * Composio v3.1 endpoints HyperLevel uses and records every call (method, path, query, body, key).
 */

type Req = { method: string; path: string; query: URLSearchParams; body: any; key: string };
const SLACK_TOOL = {
  slug: 'SLACK_SEND_MESSAGE',
  name: 'Send message',
  description: 'Posts a message to a channel',
  toolkit: { slug: 'slack', name: 'Slack', logo: 'https://logos.composio.dev/api/slack' },
  input_parameters: { type: 'object', properties: { channel: { type: 'string', description: 'Channel name' }, text: { type: 'string' }, unfurl: { type: 'boolean' }, priority: { type: 'integer', enum: [1, 2, 3] } }, required: ['channel', 'text'] },
  output_parameters: {},
  tags: [],
  no_auth: false,
};
const SLACK_LIST = { ...SLACK_TOOL, slug: 'SLACK_LIST_CHANNELS', name: 'List channels', description: 'Lists channels', input_parameters: { type: 'object', properties: {} } };

function fakeComposio() {
  const reqs: Req[] = [];
  const s = {
    authConfigs: [] as any[],
    accounts: new Map<string, any>(),
    triggers: new Map<string, any>(),
    subs: [] as any[],
    executed: [] as { slug: string; body: any }[],
    fail503: 0,
    execResult: (slug: string, _body: any): any => ({ successful: true, data: { ok: true, ts: '1712.0001', channel: 'C1', tool: slug }, error: null, log_id: 'log_1' }),
    activateOnLink: true,
    omitLinkId: false,
    lastLinkId: '',
    n: 0,
  };
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const err = (status: number, message: string) => json({ error: { message, code: status, slug: 'err', status } }, status);
  const toolkit = (slug: string, name: string, extra: any = {}) => ({ slug, name, meta: { logo: `https://logos.composio.dev/api/${slug}`, description: `${name} app`, categories: [{ id: 'crm', name: 'CRM' }], tools_count: 40, triggers_count: 3 }, auth_schemes: ['OAUTH2'], composio_managed_auth_schemes: ['OAUTH2'], no_auth: false, ...extra });
  const TOOLKITS = [toolkit('slack', 'Slack'), toolkit('shopify', 'Shopify'), toolkit('notion', 'Notion'), toolkit('hackernews', 'Hacker News', { no_auth: true, composio_managed_auth_schemes: [] })];
  const fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.host !== 'backend.composio.dev') throw new Error(`unexpected request to ${url.href}`);
    const method = String(init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const key = String(init.headers?.['x-api-key'] ?? '');
    const path = url.pathname.replace('/api/v3.1', '');
    reqs.push({ method, path, query: url.searchParams, body, key });
    if (!key) return err(401, 'missing key');
    if (key === 'ak_wrong_key_1234') return err(401, 'Invalid API key');
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/toolkits') {
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const items = TOOLKITS.filter((t) => !q || t.slug.includes(q) || t.name.toLowerCase().includes(q));
      return json({ items, total_items: items.length, total_pages: 1, current_page: 1 });
    }
    if (method === 'GET' && path === '/toolkits/categories') return json({ items: [{ id: 'crm', name: 'CRM' }, { id: 'communication', name: 'Communication' }] });
    if (method === 'GET' && (m = path.match(/^\/toolkits\/([\w-]+)$/))) {
      const t = TOOLKITS.find((x) => x.slug === m![1]);
      return t ? json(t) : err(404, 'Toolkit not found');
    }
    if (method === 'GET' && path === '/auth_configs') {
      const tk = url.searchParams.get('toolkit_slug');
      const items = s.authConfigs.filter((a) => !tk || a.toolkit.slug === tk);
      return json({ items, total_items: items.length });
    }
    if (method === 'POST' && path === '/auth_configs') {
      const a = { id: `ac_${++s.n}`, toolkit: { slug: body.toolkit.slug }, is_composio_managed: true, status: 'ENABLED', auth_scheme: 'OAUTH2' };
      s.authConfigs.push(a);
      return json({ toolkit: { slug: body.toolkit.slug }, auth_config: { id: a.id, auth_scheme: 'OAUTH2', is_composio_managed: true } }, 201);
    }
    if (method === 'POST' && path === '/connected_accounts/link') {
      const ac = s.authConfigs.find((a) => a.id === body.auth_config_id);
      if (!ac) return err(404, 'Auth config not found');
      const id = `ca_${++s.n}`;
      s.accounts.set(id, { id, toolkit: { slug: ac.toolkit.slug }, status: s.activateOnLink ? 'ACTIVE' : 'INITIATED', status_reason: '', user_id: body.user_id, callback: body.callback_url });
      s.lastLinkId = id;
      return json({ link_token: 'lt', redirect_url: `https://connect.composio.dev/link/${id}`, expires_at: new Date(Date.now() + 6e5).toISOString(), connected_account_id: s.omitLinkId ? undefined : id }, 201);
    }
    if (method === 'GET' && path === '/connected_accounts') {
      const uid = url.searchParams.get('user_ids');
      return json({ items: [...s.accounts.values()].filter((a) => !uid || a.user_id === uid), total_items: s.accounts.size });
    }
    if ((m = path.match(/^\/connected_accounts\/(ca_\w+)$/))) {
      const a = s.accounts.get(m[1]);
      if (!a) return err(404, 'Connected account not found');
      if (method === 'DELETE') {
        s.accounts.delete(m[1]);
        return json({ success: true });
      }
      return json(a);
    }
    if (method === 'GET' && path === '/tools') {
      const slugs = url.searchParams.get('tool_slugs');
      const tk = url.searchParams.get('toolkit_slug');
      let items = [SLACK_TOOL, SLACK_LIST];
      if (slugs) items = items.filter((t) => slugs.split(',').includes(t.slug));
      if (tk) items = items.filter((t) => t.toolkit.slug === tk);
      return json({ items, total_items: items.length });
    }
    if (method === 'GET' && (m = path.match(/^\/tools\/(\w+)$/))) {
      const t = [SLACK_TOOL, SLACK_LIST].find((x) => x.slug === m![1]);
      return t ? json(t) : err(404, 'Tool not found');
    }
    if (method === 'POST' && (m = path.match(/^\/tools\/execute\/(\w+)$/))) {
      if (s.fail503 > 0) {
        s.fail503--;
        return err(503, 'upstream down');
      }
      s.executed.push({ slug: m[1], body });
      return json(s.execResult(m[1], body));
    }
    if (method === 'GET' && path === '/triggers_types') {
      return json({ items: [{ slug: 'SHOPIFY_NEW_ORDER', name: 'New order', description: 'A new order', instructions: '', type: 'webhook', toolkit: { slug: 'shopify', name: 'shopify', logo: '' }, config: { type: 'object', properties: { min_total: { type: 'number' } } }, payload: { type: 'object', properties: { email: { type: 'string' }, customer: { type: 'object', properties: { email: { type: 'string' }, first_name: { type: 'string' } } } } }, version: '1' }] });
    }
    if (method === 'GET' && (m = path.match(/^\/triggers_types\/(\w+)$/))) {
      return m[1] === 'SHOPIFY_NEW_ORDER'
        ? json({ slug: 'SHOPIFY_NEW_ORDER', name: 'New order', description: '', instructions: '', type: 'webhook', toolkit: { slug: 'shopify', name: 'shopify', logo: '' }, config: { type: 'object', properties: { min_total: { type: 'number' } } }, payload: {}, version: '1' })
        : err(404, 'Trigger type not found');
    }
    if (method === 'POST' && (m = path.match(/^\/trigger_instances\/(\w+)\/upsert$/))) {
      const id = `ti_${++s.n}`;
      s.triggers.set(id, { id, slug: m[1], ...body, status: 'enabled' });
      return json({ trigger_id: id });
    }
    if ((m = path.match(/^\/trigger_instances\/manage\/(ti_\w+)$/))) {
      const tr = s.triggers.get(m[1]);
      if (!tr) return err(404, 'Trigger not found');
      if (method === 'DELETE') {
        s.triggers.delete(m[1]);
        return json({ trigger_id: m[1] });
      }
      tr.status = body.status === 'enable' ? 'enabled' : 'disabled';
      return json({ status: 'success' });
    }
    if (method === 'GET' && path === '/webhook_subscriptions') return json({ items: s.subs, total_items: s.subs.length });
    if (method === 'POST' && path === '/webhook_subscriptions') {
      const sub = { id: `ws_${++s.n}`, webhook_url: body.webhook_url, enabled_events: body.enabled_events, version: body.version, secret: 'whsec_test_secret_123', created_at: '', updated_at: '' };
      s.subs.push(sub);
      return json(sub, 201);
    }
    if (method === 'PATCH' && (m = path.match(/^\/webhook_subscriptions\/(\w+)$/))) {
      const sub = s.subs.find((x) => x.id === m![1]);
      Object.assign(sub, body);
      return json(sub);
    }
    return err(404, `fake: ${method} ${path}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, reqs, s };
}

const AGENCY_KEY = 'ak_agency_test_key_0001';
const LOC_KEY = 'ak_location_key_0002';
let t: Awaited<ReturnType<typeof startTestApp>>;
let fake: ReturnType<typeof fakeComposio>;
const flush = () => t.app.events.flush();

/** Runs the hosted-link flow end to end and returns the connection. */
async function connect(toolkit: string) {
  const r = await t.api.post('/api/composio/connections', { toolkit });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const link = fake.reqs.filter((q) => q.path === '/connected_accounts/link').at(-1)!;
  const ca = r.data.url.split('/').pop();
  const cb = new URL(link.body.callback_url);
  const back = await t.api.get(`${cb.pathname}${cb.search}&status=success&connected_account_id=${ca}`);
  return { start: r, link, ca, back };
}

/** Delivers a signed webhook like Composio does. */
async function deliver(scope: string, payload: unknown, opts: { id?: string; ts?: number; secret?: string; signature?: string } = {}) {
  const raw = JSON.stringify(payload);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.signature ?? signWebhook(opts.secret ?? 'whsec_test_secret_123', id, ts, raw);
  const r = await t.api.raw(`/hooks/composio/${scope}`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig, 'x-composio-webhook-version': 'V3' }, body: raw });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function mcp(key: string, name: string, args: Record<string, unknown>) {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
}

beforeAll(async () => {
  retry.ms = 1;
  aiRetry.ms = 1;
  t = await startTestApp();
  fake = fakeComposio();
  t.app.services.composioFetch = fake.fetch;
  await t.setup();
});
afterAll(() => t.close());
beforeEach(() => {
  fake.reqs.length = 0;
});

describe('composio helpers (pure)', () => {
  it('verifies webhook signatures with replay window', () => {
    const raw = '{"a":1}';
    const sig = signWebhook('sec', 'msg_1', '1700000000', raw);
    expect(sig).toMatch(/^v1,/);
    expect(verifyWebhook('sec', { id: 'msg_1', timestamp: '1700000000', signature: sig }, raw, { nowSec: 1700000100 })).toBe(true);
    expect(verifyWebhook('sec', { id: 'msg_1', timestamp: '1700000000', signature: `v1,abc ${sig}` }, raw, { nowSec: 1700000100 })).toBe(true);
    expect(verifyWebhook('other', { id: 'msg_1', timestamp: '1700000000', signature: sig }, raw, { nowSec: 1700000100 })).toBe(false);
    expect(verifyWebhook('sec', { id: 'msg_2', timestamp: '1700000000', signature: sig }, raw, { nowSec: 1700000100 })).toBe(false);
    expect(verifyWebhook('sec', { id: 'msg_1', timestamp: '1700000000', signature: sig }, '{"a":2}', { nowSec: 1700000100 })).toBe(false);
    expect(verifyWebhook('sec', { id: 'msg_1', timestamp: '1700000000', signature: sig }, raw, { nowSec: 1700001000 })).toBe(false);
    expect(verifyWebhook('sec', { id: 'msg_1', timestamp: '1700000000', signature: '' }, raw, { nowSec: 1700000100 })).toBe(false);
  });

  it('normalizes V1, V2 and V3 payloads', () => {
    const v3 = normalizeEvent({ id: 'evt_1', type: 'composio.trigger.message', metadata: { trigger_id: 'ti_1', trigger_slug: 'GITHUB_ISSUE', connected_account_id: 'ca_1', user_id: 'gohigh:x' }, data: { title: 'Bug' } })!;
    expect(v3).toMatchObject({ triggerId: 'ti_1', triggerSlug: 'GITHUB_ISSUE', connectedAccountId: 'ca_1', userId: 'gohigh:x', data: { title: 'Bug' } });
    const v2 = normalizeEvent({ type: 'github_issue', data: { connection_nano_id: 'ca_2', trigger_nano_id: 'ti_2', user_id: 'u', title: 'x' } })!;
    expect(v2).toMatchObject({ triggerId: 'ti_2', connectedAccountId: 'ca_2', triggerSlug: 'GITHUB_ISSUE', data: { title: 'x' } });
    expect(v2.data).not.toHaveProperty('trigger_nano_id');
    expect(normalizeEvent({ trigger_name: 'X', trigger_id: 'ti_3', connection_id: 'ca_3', payload: { a: 1 } })).toMatchObject({ triggerId: 'ti_3', data: { a: 1 } });
    expect(normalizeEvent({ type: 'composio.connected_account.expired', data: { id: 'ca_9' } })).toMatchObject({ connectedAccountId: 'ca_9' });
    expect(normalizeEvent({ foo: 1 })).toBeNull();
  });

  it('finds the contact in app payloads', () => {
    expect(guessContact({ id: 1, email: 'k@shop.de', customer: { first_name: 'Kim', last_name: 'Ko', email: 'k@shop.de', phone: '+49 170 1234567' } })).toMatchObject({ email: 'k@shop.de', first_name: 'Kim', last_name: 'Ko', phone: '+49 170 1234567' });
    expect(guessContact({ form_response: { answers: [{ type: 'text', text: 'hi' }, { type: 'email', email: 'typeform@example.com' }] } })).toMatchObject({ email: 'typeform@example.com' });
    expect(guessContact({ payload: { name: 'Lea Maria Berg', email: 'lea@example.com' } })).toMatchObject({ first_name: 'Lea', last_name: 'Maria Berg' });
    expect(guessContact({ billing_details: { email: 'pay@example.com', name: 'Max M' }, receipt_email: 'pay@example.com' }).email).toBe('pay@example.com');
    expect(guessContact({ issue: { title: 'Bug', user: { login: 'octo' } } })).toEqual({});
  });

  it('coerces arguments to the schema and renders merge fields', () => {
    const schema = SLACK_TOOL.input_parameters as any;
    const rendered = renderArgs({ channel: '#{{contact.city}}', text: 'Hi {{contact.first_name|du}}', unfurl: 'ja', priority: '2' }, { contact: { city: 'leipzig', first_name: '' } });
    expect(rendered).toEqual({ channel: '#leipzig', text: 'Hi du', unfurl: 'ja', priority: '2' });
    expect(coerceArgs(schema, rendered)).toEqual({ args: { channel: '#leipzig', text: 'Hi du', unfurl: true, priority: 2 }, errors: [] });
    expect(coerceArgs(schema, { channel: '', priority: 7 }).errors).toEqual(['channel: Pflichtfeld fehlt', 'text: Pflichtfeld fehlt', 'priority: erlaubt sind 1, 2, 3']);
    expect(coerceArgs({ type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' } }, meta: { type: 'object' } } }, { ids: '1, 2,3', meta: '{"a":1}' }).args).toEqual({ ids: [1, 2, 3], meta: { a: 1 } });
    expect(coerceArgs({ type: 'object', properties: { n: { type: ['number', 'null'] } }, additionalProperties: false }, { n: 'x', extra: 1 })).toEqual({ args: {}, errors: ['n: Zahl erwartet'] });
    expect(schemaSummary(schema)).toContain('- channel (string, Pflicht): Channel name');
    expect(schemaPaths({ type: 'object', properties: { email: { type: 'string' }, customer: { type: 'object', properties: { first_name: { type: 'string' } } } } }).map((p) => p.path)).toEqual(['email', 'customer.first_name']);
  });

  it('allow-list entries, link state and result mapping', () => {
    expect(cleanAllow(['slack_send_message', 'Notion:*', 'slack_send_message'])).toEqual(['SLACK_SEND_MESSAGE', 'notion:*']);
    expect(() => cleanAllow(['../x'])).toThrow();
    expect(isAllowed(['notion:*'], 'NOTION_CREATE_PAGE', 'notion')).toBe(true);
    expect(isAllowed(['SLACK_SEND_MESSAGE'], 'slack_send_message', 'slack')).toBe(true);
    expect(isAllowed(['SLACK_SEND_MESSAGE'], 'SLACK_LIST_CHANNELS', 'slack')).toBe(false);
    const st = signLinkState('s', { n: 'n1', l: 'loc', u: 'u1', s: 'hash', e: Date.now() + 1000 });
    expect(verifyLinkState('s', st, 'hash').n).toBe('n1');
    expect(() => verifyLinkState('s', st, 'other')).toThrow(/anderen Anmeldung/);
    expect(() => verifyLinkState('x', st, 'hash')).toThrow(/state passt nicht/);
    expect(() => verifyLinkState('s', signLinkState('s', { n: 'n', l: 'l', u: 'u', s: 'hash', e: 1 }), 'hash')).toThrow(/zu lange/);
    expect(mapResult({ id: 7, order: { total: '9.90' } }, [{ from: 'id', to: 'custom.shop_id' }, { from: 'order.total', to: 'website' }, { from: 'nope', to: 'city' }, { from: 'id', to: 'source' }])).toEqual({ fields: { website: '9.90' }, custom: { shop_id: '7' }, skipped: ['nope', 'source'] });
    expect(slimPayload({ a: 'x'.repeat(60_000), b: 1 })).toEqual({ truncated: true, a: 'x'.repeat(2000), b: 1 });
  });
});

describe('composio: keys and catalogue', () => {
  it('needs a key, keeps it sealed and lets a sub-account use its own', async () => {
    expect((await t.api.get('/api/composio')).data).toMatchObject({ configured: false, user_id: `gohigh:${t.api.location}` });
    expect((await t.api.get('/api/composio/toolkits')).status).toBe(409);
    expect((await t.api.put('/api/agency/composio', { api_key: 'kurz' })).status).toBe(400);
    const a = await t.api.put('/api/agency/composio', { api_key: AGENCY_KEY });
    expect(a.data).toMatchObject({ key_set: true, key_hint: '…0001', source: 'agency', webhook_url: 'http://localhost/hooks/composio/agency' });
    const row = t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'composio'`)!;
    expect(row.value).not.toContain(AGENCY_KEY);
    expect(JSON.stringify((await t.api.get('/api/agency/composio')).data)).not.toContain(AGENCY_KEY);

    let test = await t.api.post('/api/composio/test');
    expect(test.data).toMatchObject({ ok: true, source: 'agency', auth_configs: 0, webhook: { exists: false, ours: false } });
    expect(fake.reqs.every((r) => r.key === AGENCY_KEY)).toBe(true);

    expect((await t.api.put('/api/composio/settings', { api_key: LOC_KEY })).data).toMatchObject({ configured: true, source: 'location', override: true, key_hint: '…0002' });
    fake.reqs.length = 0;
    test = await t.api.post('/api/composio/test');
    expect(test.data.source).toBe('location');
    expect(fake.reqs[0].key).toBe(LOC_KEY);
    expect((await t.api.put('/api/composio/settings', { api_key: null })).data).toMatchObject({ source: 'agency', override: false });

    await t.api.put('/api/composio/settings', { api_key: 'ak_wrong_key_1234' });
    const bad = await t.api.post('/api/composio/test');
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain('ungültig');
    await t.api.put('/api/composio/settings', { api_key: null });
  });

  it('browses the catalogue with logos, marks connected apps and caches', async () => {
    const r = await t.api.get('/api/composio/toolkits?search=sho');
    expect(r.status).toBe(200);
    expect(r.data.items).toEqual([expect.objectContaining({ slug: 'shopify', name: 'Shopify', logo: 'https://logos.composio.dev/api/shopify', categories: ['CRM'], tools_count: 40, managed_auth: true, connection: null })]);
    expect(fake.reqs[0]).toMatchObject({ method: 'GET', path: '/toolkits' });
    expect(fake.reqs[0].query.get('sort_by')).toBe('usage');
    await t.api.get('/api/composio/toolkits?search=sho');
    expect(fake.reqs.filter((q) => q.path === '/toolkits')).toHaveLength(1);
    expect((await t.api.get('/api/composio/categories')).data).toEqual([{ id: 'crm', name: 'CRM' }, { id: 'communication', name: 'Communication' }]);
    const cat = await t.api.get('/api/integrations/catalog');
    const keys = cat.data.items.map((i: any) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['composio', 'connector_slack', 'connector_discord', 'connector_notion', 'connector_google_sheets']));
    expect(cat.data.items.find((i: any) => i.key === 'composio')).toMatchObject({ status: 'info', setup: { location: 'apps/composio' } });
  });
});

describe('composio: connecting apps (hosted link flow)', () => {
  it('creates a managed auth config, links the sub-account user and verifies the callback', async () => {
    const { start, link, ca, back } = await connect('slack');
    expect(start.data.url).toBe(`https://connect.composio.dev/link/${ca}`);
    expect(fake.reqs.find((q) => q.method === 'POST' && q.path === '/auth_configs')!.body).toEqual({ toolkit: { slug: 'slack' }, auth_config: { type: 'use_composio_managed_auth' } });
    expect(link.body).toMatchObject({ user_id: `gohigh:${t.api.location}` });
    expect(link.body.callback_url).toMatch(/^http:\/\/localhost\/composio\/callback\?state=/);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/app/apps/composio?composio=ok&app=slack');
    const conns = (await t.api.get('/api/composio/connections')).data;
    expect(conns).toEqual([expect.objectContaining({ toolkit: 'slack', toolkit_name: 'Slack', status: 'active', connected_account_id: ca, scope: 'agency' })]);
    // the next app reuses no auth config of another toolkit, a second slack link reuses its config
    fake.reqs.length = 0;
    await t.api.post('/api/composio/connections', { toolkit: 'slack' });
    expect(fake.reqs.some((q) => q.method === 'POST' && q.path === '/auth_configs')).toBe(false);
    t.app.db.run(`DELETE FROM composio_connections WHERE status = 'pending'`);
    const cat = await t.api.get('/api/integrations/catalog');
    expect(cat.data.items.find((i: any) => i.key === 'composio')).toMatchObject({ status: 'ok', detail: '1 App: Slack' });
  });

  it('refuses tampered, reused or foreign callbacks', async () => {
    const r = await t.api.post('/api/composio/connections', { toolkit: 'notion' });
    const link = fake.reqs.filter((q) => q.path === '/connected_accounts/link').at(-1)!;
    const cb = new URL(link.body.callback_url);
    const ca = r.data.url.split('/').pop();
    // another account id than the one this attempt created
    const wrong = await t.api.get(`${cb.pathname}${cb.search}&status=success&connected_account_id=ca_999`);
    expect(wrong.headers.get('location')).toContain('composio=error');
    expect(t.app.db.get('SELECT status FROM composio_connections WHERE connected_account_id = ?', ca)!.status).toBe('failed');
    // state is single-use
    const again = await t.api.get(`${cb.pathname}${cb.search}&status=success&connected_account_id=${ca}`);
    expect(decodeURIComponent(again.headers.get('location')!)).toContain('abgelaufen');
    // tampered state
    const bad = await t.api.get(`/composio/callback?state=${cb.searchParams.get('state')!.slice(0, -3)}abc&status=success`);
    expect(bad.status).toBe(400);
    // no session
    const anon = await t.api.raw(`${cb.pathname}${cb.search}&status=success`, { redirect: 'manual' });
    expect(anon.status).toBe(401);
    // cancelled at the app
    await t.api.post('/api/composio/connections', { toolkit: 'notion' });
    const l2 = new URL(fake.reqs.filter((q) => q.path === '/connected_accounts/link').at(-1)!.body.callback_url);
    const cancelled = await t.api.get(`${l2.pathname}${l2.search}&status=failed`);
    expect(decodeURIComponent(cancelled.headers.get('location')!)).toContain('abgebrochen');
    // only in the browser
    const key = (await t.api.post('/api/api-keys', { name: 'x' })).data.key;
    const viaKey = await t.api.raw('/api/composio/connections', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ toolkit: 'notion' }) });
    expect(viaKey.status).toBe(403);
    t.app.db.run(`DELETE FROM composio_connections WHERE toolkit = 'notion'`);
  });

  it('without an id from the link call, only an account of this sub-account is accepted', async () => {
    fake.s.omitLinkId = true;
    fake.s.accounts.set('ca_foreign', { id: 'ca_foreign', toolkit: { slug: 'notion' }, status: 'ACTIVE', status_reason: '', user_id: 'gohigh:other' });
    await t.api.post('/api/composio/connections', { toolkit: 'notion' });
    let cb = new URL(fake.reqs.filter((q) => q.path === '/connected_accounts/link').at(-1)!.body.callback_url);
    const foreign = await t.api.get(`${cb.pathname}${cb.search}&status=success&connected_account_id=ca_foreign`);
    expect(new URL(foreign.headers.get('location')!, 'http://x').searchParams.get('msg')).toContain('kennt dieses Konto');
    await t.api.post('/api/composio/connections', { toolkit: 'notion' });
    cb = new URL(fake.reqs.filter((q) => q.path === '/connected_accounts/link').at(-1)!.body.callback_url);
    const own = await t.api.get(`${cb.pathname}${cb.search}&status=success&connected_account_id=${fake.s.lastLinkId}`);
    expect(own.headers.get('location')).toBe('/app/apps/composio?composio=ok&app=notion');
    fake.s.omitLinkId = false;
    t.app.db.run(`DELETE FROM composio_connections WHERE toolkit = 'notion'`);
  });

  it('refreshes statuses and disconnects at Composio', async () => {
    const { ca } = await connect('shopify');
    fake.s.accounts.get(ca).status = 'EXPIRED';
    let list = (await t.api.get('/api/composio/connections?refresh=1')).data;
    expect(list.find((c: any) => c.toolkit === 'shopify').status).toBe('expired');
    fake.s.accounts.get(ca).status = 'ACTIVE';
    list = (await t.api.get('/api/composio/connections?refresh=1')).data;
    expect(list.find((c: any) => c.toolkit === 'shopify').status).toBe('active');
    // a disconnect removes it at Composio too
    const tmp = await connect('notion');
    const row = list.length ? (await t.api.get('/api/composio/connections')).data.find((c: any) => c.connected_account_id === tmp.ca) : null;
    expect((await t.api.del(`/api/composio/connections/${row.id}`)).status).toBe(200);
    expect(fake.s.accounts.has(tmp.ca)).toBe(false);
    expect(fake.reqs.some((q) => q.method === 'DELETE' && q.path === `/connected_accounts/${tmp.ca}`)).toBe(true);
  });
});

describe('composio: running actions', () => {
  let contactId: string;
  beforeAll(async () => {
    contactId = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@example.com', city: 'leipzig' })).data.id;
  });

  it('executes with merge fields, schema coercion and the sub-account user', async () => {
    const r = await t.api.post('/api/composio/execute', { tool: 'SLACK_SEND_MESSAGE', contact_id: contactId, arguments: { channel: '#{{contact.city}}', text: 'Neuer Lead: {{contact.first_name}}', unfurl: 'nein', priority: '3' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ successful: true, tool: 'SLACK_SEND_MESSAGE', data: { ts: '1712.0001' } });
    const ex = fake.s.executed.at(-1)!;
    const slack = t.app.db.get(`SELECT connected_account_id FROM composio_connections WHERE toolkit = 'slack' AND status = 'active'`)!;
    expect(ex.body).toEqual({ user_id: `gohigh:${t.api.location}`, connected_account_id: slack.connected_account_id, arguments: { channel: '#leipzig', text: 'Neuer Lead: Anna', unfurl: false, priority: 3 } });
    const calls = (await t.api.get('/api/composio/calls')).data;
    expect(calls[0]).toMatchObject({ tool: 'SLACK_SEND_MESSAGE', source: 'ui', ok: true });
  });

  it('reports schema errors, unknown tools, missing connections and retries outages', async () => {
    const miss = await t.api.post('/api/composio/execute', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x' } });
    expect(miss.status).toBe(400);
    expect(miss.data.error).toContain('text: Pflichtfeld fehlt');
    expect((await t.api.post('/api/composio/execute', { tool: 'NOPE_TOOL', arguments: {} })).data.error).toContain('Unbekannte Aktion');
    fake.s.fail503 = 2;
    const ok = await t.api.post('/api/composio/execute', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'y' } });
    expect(ok.status).toBe(200);
    expect(fake.reqs.filter((q) => q.path === '/tools/execute/SLACK_SEND_MESSAGE')).toHaveLength(3);
    fake.s.fail503 = 5;
    const down = await t.api.post('/api/composio/execute', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'y' } });
    expect(down.status).toBe(503);
    fake.s.fail503 = 0;
    // the app said no: passed through, not thrown
    fake.s.execResult = () => ({ successful: false, data: {}, error: 'channel_not_found', log_id: 'l2' });
    const no = await t.api.post('/api/composio/execute', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'y' } });
    expect(no.data).toMatchObject({ successful: false, error: 'channel_not_found' });
    fake.s.execResult = (slug) => ({ successful: true, data: { ok: true, ts: '1712.0001', channel: 'C1', tool: slug }, error: null, log_id: 'log_1' });
    // without connection
    t.app.db.run(`UPDATE composio_connections SET status = 'expired' WHERE toolkit = 'slack'`);
    const off = await t.api.post('/api/composio/execute', { tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'y' } });
    expect(off.status).toBe(409);
    expect(off.data.error).toContain('nicht verbunden');
    t.app.db.run(`UPDATE composio_connections SET status = 'active' WHERE toolkit = 'slack'`);
  });

  it('workflow action: result in the run log, mapped into the contact and usable by later steps', async () => {
    await t.api.post('/api/custom-fields', { label: 'Slack-Nachricht', key: 'slack_ts', type: 'text' });
    const wf = await t.api.post('/api/workflows', {
      name: 'Lead nach Slack',
      trigger: { type: 'manual', config: {} },
      steps: [
        { type: 'composio_action', toolkit: 'slack', tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#leads', text: 'Neu: {{contact.name}} ({{contact.email}})' }, map: [{ from: 'ts', to: 'custom.slack_ts' }, { from: 'channel', to: 'company' }] },
        { type: 'add_note', body: 'Slack-Kanal {{event.app_result.channel}}' },
        { type: 'composio_action', tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#leads' } },
      ],
    });
    expect(wf.status, JSON.stringify(wf.data)).toBe(200);
    await t.api.patch(`/api/workflows/${wf.data.id}`, { status: 'active' });
    expect((await t.api.post(`/api/workflows/${wf.data.id}/enroll`, { contact_ids: [contactId] })).data.enrolled).toBe(1);
    expect(fake.s.executed.at(-1)!.body.arguments).toEqual({ channel: '#leads', text: 'Neu: Anna (anna@example.com)' });
    const runs = (await t.api.get(`/api/workflows/${wf.data.id}/runs`)).data.runs;
    const log = runs[0].log;
    expect(log[0].result).toMatch(/^SLACK_SEND_MESSAGE: OK · übernommen: company, custom\.slack_ts/);
    expect(log[2].error).toContain('text: Pflichtfeld fehlt');
    const c = (await t.api.get(`/api/contacts/${contactId}`)).data;
    expect(c.custom.slack_ts).toBe('1712.0001');
    expect(c.company).toBe('C1');
    const notes = t.app.db.all('SELECT body FROM notes WHERE contact_id = ?', contactId).map((n) => n.body);
    expect(notes).toContain('Slack-Kanal C1');
    const run = t.app.db.get('SELECT event FROM workflow_runs WHERE workflow_id = ?', wf.data.id)!;
    expect(JSON.parse(run.event).app_result.ts).toBe('1712.0001');
  });
});

describe('composio: app events (trigger → contact → workflow)', () => {
  let triggerId: string;
  let composioTriggerId: string;
  let wfId: string;
  const loc = () => t.api.location;
  const event = (data: unknown, extra: Record<string, unknown> = {}) => ({ id: 'evt', type: 'composio.trigger.message', timestamp: new Date().toISOString(), metadata: { trigger_id: composioTriggerId, trigger_slug: 'SHOPIFY_NEW_ORDER', connected_account_id: 'ca_x', user_id: `gohigh:${loc()}`, ...extra }, data });

  it('subscribes: webhook subscription, trigger instance and config validation', async () => {
    expect((await t.api.post('/api/composio/triggers', { toolkit: 'shopify', trigger_slug: 'SHOPIFY_NEW_ORDER', config: { min_total: 'viel' } })).data.error).toContain('min_total: Zahl erwartet');
    expect((await t.api.post('/api/composio/triggers', { toolkit: 'notion', trigger_slug: 'NOTION_X' })).status).toBe(409);
    const types = (await t.api.get('/api/composio/triggers/types?toolkit=shopify')).data;
    expect(types[0]).toMatchObject({ slug: 'SHOPIFY_NEW_ORDER', payload_paths: [{ path: 'email' }, { path: 'customer.email' }, { path: 'customer.first_name' }].map((p) => expect.objectContaining(p)) });
    const r = await t.api.post('/api/composio/triggers', { toolkit: 'shopify', trigger_slug: 'shopify_new_order', config: { min_total: '10' }, tags: ['shop-kunde'] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    triggerId = r.data.id;
    const sub = fake.reqs.find((q) => q.method === 'POST' && q.path === '/webhook_subscriptions')!;
    expect(sub.body).toEqual({ webhook_url: 'http://localhost/hooks/composio/agency', enabled_events: ['composio.trigger.message', 'composio.connected_account.expired'], version: 'V3' });
    const up = fake.reqs.find((q) => q.path === '/trigger_instances/SHOPIFY_NEW_ORDER/upsert')!;
    const shop = t.app.db.get(`SELECT connected_account_id FROM composio_connections WHERE toolkit = 'shopify' AND status = 'active'`)!;
    expect(up.body).toEqual({ user_id: `gohigh:${loc()}`, connected_account_id: shop.connected_account_id, trigger_config: { min_total: 10 } });
    composioTriggerId = r.data.id && [...fake.s.triggers.keys()].at(-1)!;
    const stored = t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'composio'`)!.value;
    expect(stored).not.toContain('whsec_test_secret_123');

    const wf = await t.api.post('/api/workflows', { name: 'Shop-Bestellung', trigger: { type: 'composio.event', config: { subscription_id: triggerId } }, steps: [{ type: 'add_tag', tags: ['bestellt'] }, { type: 'add_note', body: 'Bestellung über {{event.total_price}} € ({{event.app}})' }] });
    expect(wf.status, JSON.stringify(wf.data)).toBe(200);
    wfId = wf.data.id;
    await t.api.patch(`/api/workflows/${wfId}`, { status: 'active' });
  });

  it('verifies the signature, creates the contact and starts the workflow with {{event.*}}', async () => {
    const r = await deliver('agency', event({ total_price: '49.90', email: 'kim@shop.de', customer: { first_name: 'Kim', last_name: 'Ko', email: 'kim@shop.de' } }), { id: 'msg_order_1' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.contactId).toBeTruthy();
    await flush();
    const c = (await t.api.get(`/api/contacts/${r.data.contactId}`)).data;
    expect(c).toMatchObject({ first_name: 'Kim', last_name: 'Ko', email: 'kim@shop.de', source: 'App: Shopify' });
    expect(c.tags).toEqual(expect.arrayContaining(['shop-kunde', 'bestellt']));
    expect(t.app.db.all('SELECT body FROM notes WHERE contact_id = ?', c.id).map((n) => n.body)).toContain('Bestellung über 49.90 € (shopify)');
    const runEvent = JSON.parse(t.app.db.get('SELECT event FROM workflow_runs WHERE workflow_id = ?', wfId)!.event);
    expect(runEvent).toMatchObject({ subscriptionId: triggerId, app: 'shopify', trigger: 'SHOPIFY_NEW_ORDER', total_price: '49.90' });
    // the same delivery again (Composio retries): processed once
    const dup = await deliver('agency', event({ email: 'kim@shop.de' }), { id: 'msg_order_1' });
    expect(dup.data).toEqual({ ok: true, duplicate: true });
    const ev = (await t.api.get(`/api/composio/triggers/${triggerId}/events`)).data;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ status: 'ok', contact_id: c.id });
    expect((await t.api.get('/api/composio/triggers')).data.items[0]).toMatchObject({ events: 1, status: 'active' });
  });

  it('refuses bad signatures and stale timestamps, ignores foreign or unknown triggers', async () => {
    expect((await deliver('agency', event({ email: 'x@y.de' }), { signature: 'v1,Zm9v' })).status).toBe(401);
    expect((await deliver('agency', event({ email: 'x@y.de' }), { secret: 'falsch' })).status).toBe(401);
    expect((await deliver('agency', event({ email: 'x@y.de' }), { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await deliver(loc(), event({ email: 'x@y.de' }))).status).toBe(404);
    expect((await deliver('agency', event({ email: 'x@y.de' }, { trigger_id: 'ti_unknown' }))).data).toEqual({ ok: true, ignored: true });
    expect((await deliver('agency', event({ email: 'x@y.de' }, { user_id: 'gohigh:fremd' }))).data).toEqual({ ok: true, ignored: true });
    const none = await deliver('agency', event({ order: 7 }));
    expect(none.data).toEqual({ ok: true, contactId: null });
    const ev = (await t.api.get(`/api/composio/triggers/${triggerId}/events`)).data;
    expect(ev[0]).toMatchObject({ status: 'no_contact' });
    expect(t.app.db.get(`SELECT COUNT(*) n FROM contacts WHERE email = 'x@y.de'`)!.n).toBe(0);
  });

  it('field mapping, preview, pause and the expiry lifecycle event', async () => {
    const custom = await t.api.patch(`/api/composio/triggers/${triggerId}`, { mapping: [{ from: 'buyer.mail', to: 'email' }, { from: 'buyer.nick', to: 'first_name' }] });
    expect(custom.data.mapping).toHaveLength(2);
    const pv = await t.api.post(`/api/composio/triggers/${triggerId}/preview`, { payload: { buyer: { mail: 'm@x.de', nick: 'Mo' } } });
    expect(pv.data).toMatchObject({ ok: true, contact: { email: 'm@x.de', first_name: 'Mo' } });
    expect(pv.data.paths.map((p: any) => p.path)).toEqual(['buyer.mail', 'buyer.nick']);
    const r = await deliver('agency', event({ buyer: { mail: 'm@x.de', nick: 'Mo' } }));
    expect(r.data.contactId).toBeTruthy();
    await t.api.patch(`/api/composio/triggers/${triggerId}`, { status: 'paused' });
    expect(fake.s.triggers.get(composioTriggerId).status).toBe('disabled');
    expect((await deliver('agency', event({ buyer: { mail: 'p@x.de' } }))).data).toEqual({ ok: true, ignored: true });
    await t.api.patch(`/api/composio/triggers/${triggerId}`, { status: 'active' });

    const shop = t.app.db.get(`SELECT connected_account_id FROM composio_connections WHERE toolkit = 'shopify' AND status = 'active'`)!;
    await deliver('agency', { id: 'evt_exp', type: 'composio.connected_account.expired', metadata: {}, data: { id: shop.connected_account_id, toolkit: { slug: 'shopify' }, status: 'EXPIRED', status_reason: 'refresh token revoked' } });
    expect(t.app.db.get('SELECT status, status_reason FROM composio_connections WHERE connected_account_id = ?', shop.connected_account_id)).toEqual({ status: 'expired', status_reason: 'refresh token revoked' });
    t.app.db.run(`UPDATE composio_connections SET status = 'active' WHERE connected_account_id = ?`, shop.connected_account_id);
  });

  it('a rotated secret is fetched again, delete removes the trigger at Composio', async () => {
    fake.s.subs[0].secret = 'whsec_rotated_456';
    t.app.db.run(`UPDATE agency_settings SET value = json_set(value, '$.webhook.refreshed_at', '2000-01-01T00:00:00.000Z') WHERE key = 'composio'`);
    const r = await deliver('agency', event({ email: 'rot@x.de' }), { secret: 'whsec_rotated_456' });
    expect(r.status).toBe(200);
    expect((await t.api.del(`/api/composio/triggers/${triggerId}`)).status).toBe(200);
    expect(fake.s.triggers.has(composioTriggerId)).toBe(false);
  });
});

describe('composio: allow-list for MCP and AI', () => {
  let apiKey: string;
  beforeAll(async () => {
    apiKey = (await t.api.post('/api/api-keys', { name: 'MCP' })).data.key;
  });

  it('MCP ghl_app_action only searches and runs allow-listed actions', async () => {
    await t.api.put('/api/composio/allow', { allow: [] });
    const list = await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'search', query: 'send' });
    expect(list.structuredContent.tools).toEqual([]);
    const denied = await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'execute', tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'hi' } });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('nicht freigegeben');
    const viaRest = await t.api.raw('/api/composio/execute', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'hi' } }) });
    expect(viaRest.status).toBe(403);
    expect((await t.api.put('/api/composio/allow', { allow: ['bad entry!'] })).status).toBe(400);

    expect((await t.api.put('/api/composio/allow', { allow: ['SLACK_SEND_MESSAGE'] })).data.allow).toEqual(['SLACK_SEND_MESSAGE']);
    const found = await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'search', query: '' });
    expect(found.structuredContent.tools.map((x: any) => x.slug)).toEqual(['SLACK_SEND_MESSAGE']);
    expect(found.structuredContent.tools[0].input_parameters.required).toEqual(['channel', 'text']);
    const before = fake.s.executed.length;
    const ok = await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'execute', tool: 'SLACK_SEND_MESSAGE', arguments: { channel: '#x', text: 'hi' } });
    expect(ok.isError, ok.content[0].text).toBe(false);
    expect(ok.structuredContent).toMatchObject({ successful: true, tool: 'SLACK_SEND_MESSAGE' });
    expect(fake.s.executed.length).toBe(before + 1);
    const other = await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'execute', tool: 'SLACK_LIST_CHANNELS', arguments: {} });
    expect(other.isError).toBe(true);
    const apps = await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'connections' });
    expect(apps.structuredContent.apps.map((a: any) => a.toolkit)).toEqual(expect.arrayContaining(['slack', 'shopify']));
    const calls = (await t.api.get('/api/composio/calls')).data;
    expect(calls[0]).toMatchObject({ source: 'mcp', tool: 'SLACK_SEND_MESSAGE' });
    // whole apps: slack:* allows every slack action
    await t.api.put('/api/composio/allow', { allow: ['slack:*'] });
    expect((await mcp(apiKey, 'ghl_app_action', { location_id: t.api.location, mode: 'execute', tool: 'SLACK_LIST_CHANNELS', arguments: {} })).isError).toBe(false);
  });

  it('the AI agent uses allow-listed actions through aiRun and cannot leave the list', async () => {
    const aiCalls: any[] = [];
    const steps = [
      { action: 'execute', query: '', toolkit: '', tool: 'SHOPIFY_DELETE_EVERYTHING', arguments_json: '{}', answer: '' },
      { action: 'search', query: 'nachricht', toolkit: 'slack', tool: '', arguments_json: '', answer: '' },
      { action: 'execute', query: '', toolkit: '', tool: 'SLACK_SEND_MESSAGE', arguments_json: '{"channel":"#vertrieb","text":"Anna hat angefragt"}', answer: '' },
      { action: 'answer', query: '', toolkit: '', tool: '', arguments_json: '', answer: 'Nachricht in #vertrieb gesendet.' },
    ];
    t.app.services.aiFetch = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      aiCalls.push(body);
      const step = steps[aiCalls.length - 1];
      return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(step) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await t.api.put('/api/ai/settings', { api_key: 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123', enabled: true });
    await t.api.put('/api/composio/allow', { allow: ['slack:*'] });
    const before = fake.s.executed.length;
    const r = await t.api.post('/api/composio/ai', { prompt: 'Sag dem Vertrieb in Slack, dass Anna angefragt hat.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.answer).toBe('Nachricht in #vertrieb gesendet.');
    expect(r.data.steps.map((s: any) => s.action)).toEqual(['execute', 'search', 'execute', 'answer']);
    expect(r.data.steps[0]).toMatchObject({ ok: false });
    expect(fake.s.executed.length).toBe(before + 1);
    expect(fake.s.executed.at(-1)!.body.arguments).toEqual({ channel: '#vertrieb', text: 'Anna hat angefragt' });
    expect(aiCalls[0].output_config.format.schema.required).toContain('arguments_json');
    expect(aiCalls[0].messages[0].content).toContain('slack');
    expect(aiCalls[2].messages[0].content).toContain('SLACK_SEND_MESSAGE');
    const usage = t.app.db.all(`SELECT purpose FROM ai_calls WHERE purpose = 'app_agent'`);
    expect(usage).toHaveLength(4);
    // nothing allowed → clear message
    await t.api.put('/api/composio/allow', { allow: [] });
    expect((await t.api.post('/api/composio/ai', { prompt: 'x' })).data.error).toContain('freigegeben');
  });
});
