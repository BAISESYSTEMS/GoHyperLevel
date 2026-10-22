import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { fakeOpenAI } from './chatgpt-fakes.js';
import { resetDiscovery, resetJwks } from '../server/services/chatgpt-oauth.js';
import { retry } from '../server/services/agent-llm.js';
import { gateProblem } from '../server/services/werkstatt/models.js';

/**
 * "Mit ChatGPT anmelden": the state machine (start → paste → connected → refresh → expired/disconnected), tokens sealed per user,
 * and the safety rules – a personal subscription is usable only by its owner's own browser session, only for what they switched on,
 * never by other users, API keys, MCP, automatic runs, workflows or background jobs; the agency can switch it off; the audit log
 * never holds a token. All HTTP mocked (app.services.aiSubscriptionsFetch).
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let ai: ReturnType<typeof fakeOpenAI>;
let locA = '';
let annaId = '';
let berndId = '';
const sub = () => t.app.services.aiSubscriptions;
const login = async (email: string) => {
  t.api.clearCookie();
  expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
  t.api.setLocation(locA);
};
/** Start, let "the browser" approve, paste the address back. */
async function connect(email = 'anna@example.com') {
  await login(email);
  const start = await t.api.post('/api/ai-subscriptions/chatgpt/start');
  expect(start.status, JSON.stringify(start.data)).toBe(200);
  const pasted = ai.consent(start.data.authorize_url);
  return { start, pasted, done: await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: pasted }) };
}
const rowOf = (userId: string) => t.app.db.get<any>('SELECT * FROM ai_subscriptions WHERE user_id = ?', userId);
const auditRows = () => t.app.db.all<any>(`SELECT action, summary, user_id, via, actor FROM audit_log WHERE action LIKE 'ai.subscription.%' ORDER BY at`);
const refreshCalls = () => ai.calls.filter((c) => c.form?.grant_type === 'refresh_token').length;
const everything = () => JSON.stringify([t.app.db.all('SELECT * FROM audit_log'), t.app.db.all('SELECT * FROM ai_subscriptions'), t.app.db.all('SELECT * FROM ai_subscription_pending')]);

async function streamChat(cookie: string, body: Record<string, unknown>) {
  const r = await fetch(`${t.base}/api/agent/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, 'x-location-id': locA }, body: JSON.stringify(body) });
  const all: any[] = [];
  if (!(r.headers.get('content-type') ?? '').includes('event-stream')) return { status: r.status, events: all, json: await r.json().catch(() => null) };
  let buf = '';
  for await (const chunk of r.body as any) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) all.push(JSON.parse(line.slice(6)));
    }
  }
  return { status: r.status, events: all, json: null };
}

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  await t.setup();
  locA = t.api.location;
  await t.api.post('/api/users', { email: 'anna@example.com', name: 'Anna', password: 'geheim123', role: 'member', locations: [locA], permissions: ['conversations', 'contacts'] });
  await t.api.post('/api/users', { email: 'bernd@example.com', name: 'Bernd', password: 'geheim123', role: 'member', locations: [locA], permissions: ['conversations', 'contacts'] });
  await t.api.post('/api/contacts', { first_name: 'Lena', email: 'lena@lead.example' });
  annaId = t.app.db.get<any>('SELECT id FROM users WHERE email = ?', 'anna@example.com').id;
  berndId = t.app.db.get<any>('SELECT id FROM users WHERE email = ?', 'bernd@example.com').id;
  // The KI-Assistent with a Claude key: quick texts that are not the person's own action must fall back to it.
  await t.api.put('/api/ai/settings', { api_key: 'sk-ant-api03-TESTKEYNOTREAL0123456789', enabled: true });
});
afterAll(() => t.close());
beforeEach(() => {
  resetDiscovery();
  resetJwks();
  ai = fakeOpenAI();
  t.app.services.aiSubscriptionsFetch = ai.fetch;
  for (const k of ['PGHL_HOSTED', 'PGHL_CHATGPT_SIGNIN_APPROVED', 'PGHL_SUBSCRIPTION_SIGNIN']) delete process.env[k];
  // every test starts without any sign-in (the agency switch is back on, too)
  t.app.db.run('DELETE FROM ai_subscriptions');
  t.app.db.run('DELETE FROM ai_subscription_pending');
  t.app.db.run(`DELETE FROM audit_log WHERE action LIKE 'ai.subscription.%'`);
  t.app.db.run(`DELETE FROM agency_settings WHERE key = 'ai_subscriptions'`);
});

describe('sign-in state machine', () => {
  it('limits sign-in attempts per person and hour', async () => {
    await login('anna@example.com');
    for (let i = 0; i < 12; i++) expect((await t.api.post('/api/ai-subscriptions/chatgpt/start')).status).toBe(200);
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/start')).status).toBe(429);
    // five wrong pastes burn the attempt
    t.app.db.run(`DELETE FROM audit_log WHERE action LIKE 'ai.subscription.%'`);
    await t.api.post('/api/ai-subscriptions/chatgpt/start');
    for (let i = 0; i < 5; i++) expect((await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: 'http://127.0.0.1:1455/auth/callback?code=x&state=wrong' })).status).toBe(400);
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: 'http://127.0.0.1:1455/auth/callback?code=x&state=wrong' })).status).toBe(429);
  });

  it('starts with a registration URL, keeps the PKCE verifier on the server and one host id per installation', async () => {
    await login('anna@example.com');
    const start = await t.api.post('/api/ai-subscriptions/chatgpt/start');
    expect(start.status).toBe(200);
    const u = new URL(start.data.authorize_url);
    expect(u.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(u.searchParams.get('agent_name_hint')).toBe('HyperLevel');
    expect(u.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(start.data.redirect_uri).toBe('http://127.0.0.1:1455/auth/callback');
    const pending = t.app.db.get<any>('SELECT * FROM ai_subscription_pending WHERE user_id = ?', annaId);
    expect(pending.secret).toMatch(/^v[12]:/);
    expect(JSON.stringify(start.data)).not.toContain('verifier');
    // a second start replaces the first attempt and the host id stays
    const host = u.searchParams.get('ext_agent_host_id');
    const again = await t.api.post('/api/ai-subscriptions/chatgpt/start');
    expect(new URL(again.data.authorize_url).searchParams.get('ext_agent_host_id')).toBe(host);
    expect(t.app.db.all('SELECT * FROM ai_subscription_pending WHERE user_id = ?', annaId)).toHaveLength(1);
    // the first attempt's address no longer fits
    const stale = await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: ai.consent(start.data.authorize_url) });
    expect(stale.status).toBe(400);
    expect(stale.data.error).toContain('state');
    expect(rowOf(annaId)?.status ?? 'none').not.toBe('connected');
  });

  it('refuses a foreign address, an empty paste and an expired attempt – and connects with the right one', async () => {
    await login('anna@example.com');
    const start = await t.api.post('/api/ai-subscriptions/chatgpt/start');
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: '' })).status).toBe(400);
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: 'https://evil.example/?code=x&state=y' })).status).toBe(400);
    const denied = await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${new URL(start.data.authorize_url).searchParams.get('state')}` });
    expect(denied.status).toBe(400);
    expect(denied.data.error).toContain('abgelehnt');
    expect(rowOf(annaId)).toBeUndefined();
    t.app.db.run('UPDATE ai_subscription_pending SET expires_at = ?', '2000-01-01T00:00:00.000Z');
    const late = await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: ai.consent(start.data.authorize_url) });
    expect(late.status).toBe(409);
  });

  it('connects: plan, expiry and model shown, tokens sealed, nothing secret in any answer or in the audit log', async () => {
    const { done, pasted } = await connect();
    expect(done.status, JSON.stringify(done.data)).toBe(200);
    expect(done.data.chatgpt).toMatchObject({ connected: true, status: 'connected', plan: 'plus', plan_label: 'ChatGPT Plus', account_email: 'paula@example.com', model: 'gpt-6.1-sol', uses: { agent: true, assistant: true, werkstatt: true }, usage_url: 'https://chatgpt.com/settings/usage' });
    expect(new Date(done.data.chatgpt.access_expires_at).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    expect(new Date(done.data.chatgpt.refresh_valid_until).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    // the exchange used the PKCE verifier of this attempt and the issued client id
    const exchange = ai.calls.find((c) => c.form?.grant_type === 'authorization_code')!;
    expect(exchange.form).toMatchObject({ client_id: 'oaiapp_test1', redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1' });
    // sealed at rest: no plaintext token anywhere in the database
    const row = rowOf(annaId);
    expect(row.creds).toMatch(/^v[12]:/);
    expect(everything()).not.toMatch(/at-secret|rt-secret/);
    expect(everything()).not.toContain(new URL(pasted).searchParams.get('code'));
    // every read of the module hides tokens and the registration id
    for (const path of ['/api/ai-subscriptions', '/api/ai-subscriptions/overview', '/api/ai-subscriptions/chatgpt/models']) {
      const r = await t.api.get(path);
      expect(r.status, path).toBe(200);
      const text = JSON.stringify(r.data);
      expect(text, path).not.toMatch(/at-secret|rt-secret|oaiapp_|v[12]:[A-Za-z0-9+/=]{8}/);
    }
    expect(auditRows().map((a) => a.action)).toEqual(expect.arrayContaining(['ai.subscription.start', 'ai.subscription.connect']));
    const connectRow = auditRows().find((a) => a.action === 'ai.subscription.connect')!;
    expect(connectRow).toMatchObject({ user_id: annaId, via: 'session', summary: 'ChatGPT-Abo verbunden (Plan: ChatGPT Plus)' });
    expect(everything()).not.toMatch(/code-\d|at-secret|rt-secret|id_token|eyJ/);
  });

  it('refreshes before the access token expires and stores the rotated token (a used refresh token is dead at OpenAI)', async () => {
    ai.expiresIn = 60; // inside the two-minute window: every use refreshes
    await connect();
    const before = rowOf(annaId).creds;
    expect(refreshCalls()).toBe(0);
    expect((await t.api.get('/api/ai-subscriptions/chatgpt/models?refresh=1')).status).toBe(200);
    expect(refreshCalls()).toBe(1);
    expect(rowOf(annaId).creds).not.toBe(before);
    expect(rowOf(annaId).last_refreshed_at).toBeTruthy();
    // the second refresh only works with the rotated token
    expect((await t.api.get('/api/ai-subscriptions/chatgpt/models?refresh=1')).status).toBe(200);
    expect(refreshCalls()).toBe(2);
    // a long-lived token is not refreshed again
    ai.expiresIn = 3600;
    await t.api.get('/api/ai-subscriptions/chatgpt/models?refresh=1');
    expect(refreshCalls()).toBe(3);
    expect(new Date(rowOf(annaId).access_expires_at).getTime()).toBeGreaterThan(Date.now() + 3_000_000);
    await t.api.get('/api/ai-subscriptions/chatgpt/models?refresh=1');
    expect(refreshCalls()).toBe(3);
  });

  it('serializes refreshes: requests at the same moment share one refresh (rotation would kill the second)', async () => {
    ai.expiresIn = 60;
    await connect();
    const target = sub().resolveFor({ user: { id: annaId } as any, locationId: locA, usage: 'assistant' })!;
    ai.expiresIn = 3600;
    const f = sub().fetchFor(target);
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => f('https://api.openai.com/v1/models')));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refreshCalls()).toBe(1);
    const bearers = new Set(ai.calls.filter((c) => c.url.endsWith('/v1/models')).slice(-5).map((c) => c.headers.authorization));
    expect(bearers.size).toBe(1);
  });

  it('an unusable refresh token ends the sign-in (status "abgelaufen", audit entry) and a reconnect reuses the registration', async () => {
    ai.expiresIn = 60;
    await connect();
    ai.failRefresh = 'invalid_grant';
    const r = await t.api.get('/api/ai-subscriptions/chatgpt/models?refresh=1');
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('neu an');
    expect(rowOf(annaId)).toMatchObject({ status: 'expired', creds: null });
    expect((await t.api.get('/api/ai-subscriptions')).data.chatgpt).toMatchObject({ connected: false, status: 'expired' });
    expect(auditRows().some((a) => a.action === 'ai.subscription.expired')).toBe(true);
    expect(sub().resolveFor({ user: { id: annaId } as any, locationId: locA, usage: 'assistant' })).toBeNull();
    // sign in again: same client id, no name hint, the account hint
    ai.failRefresh = '';
    ai.expiresIn = 3600;
    const again = await t.api.post('/api/ai-subscriptions/chatgpt/start');
    const q = new URL(again.data.authorize_url).searchParams;
    expect(q.get('client_id')).toBe('oaiapp_test1');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('login_hint')).toBe('paula@example.com');
    const ok = await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: ai.consent(again.data.authorize_url) });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(rowOf(annaId).status).toBe('connected');
  });

  it('keeps the sign-in when OpenAI is only temporarily unreachable', async () => {
    ai.expiresIn = 60;
    await connect();
    ai.failRefresh = 'server';
    const r = await t.api.get('/api/ai-subscriptions/chatgpt/models?refresh=1');
    expect(r.status).toBe(503);
    expect(rowOf(annaId)).toMatchObject({ status: 'connected' });
    expect(rowOf(annaId).creds).toBeTruthy();
  });

  it('keeps the tokens out when the person did not allow plan usage, and asks for consent the next time', async () => {
    ai.grantPlan = false;
    const { done } = await connect();
    expect(done.status).toBe(400);
    expect(done.data.error).toContain('nicht erlaubt');
    expect(rowOf(annaId)).toMatchObject({ status: 'plan_disabled', creds: null });
    expect(ai.revoked.length).toBe(1);
    ai.grantPlan = true;
    const again = await t.api.post('/api/ai-subscriptions/chatgpt/start');
    expect(new URL(again.data.authorize_url).searchParams.get('prompt')).toBe('consent');
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/complete', { callback: ai.consent(again.data.authorize_url) })).status).toBe(200);
  });

  it('disconnects: refresh token revoked at OpenAI, tokens gone, audit entry, registration kept', async () => {
    await connect();
    const refresh = ai.calls.find((c) => c.form?.grant_type === 'authorization_code') && 'rt-secret';
    const del = await t.api.del('/api/ai-subscriptions/chatgpt');
    expect(del.status).toBe(200);
    expect(del.data).toMatchObject({ ok: true, revoked: true });
    expect(ai.revoked).toHaveLength(1);
    expect(ai.revoked[0]).toContain(refresh as string);
    expect(rowOf(annaId)).toMatchObject({ status: 'disconnected', creds: null, model: '', client_id: 'oaiapp_test1' });
    expect(auditRows().find((a) => a.action === 'ai.subscription.disconnect')!.summary).toBe('ChatGPT-Abo getrennt (Widerruf bei OpenAI bestätigt)');
    expect((await t.api.get('/api/ai-subscriptions/chatgpt/models')).status).toBe(409);
    expect((await t.api.del('/api/ai-subscriptions/chatgpt')).status).toBe(200);
    expect(sub().chatModelsFor({ id: annaId } as any, locA)).toEqual([]);
  });
});

describe('personal by construction', () => {
  it('is invisible and unusable for other people – including the agency admin', async () => {
    await connect('anna@example.com');
    await login('bernd@example.com');
    expect((await t.api.get('/api/ai-subscriptions')).data.chatgpt).toBeNull();
    expect((await t.api.get('/api/ai-subscriptions/chatgpt/models')).status).toBe(409);
    expect((await t.api.patch('/api/ai-subscriptions/chatgpt', { model: 'x' })).status).toBe(404);
    expect((await t.api.del('/api/ai-subscriptions/chatgpt')).status).toBe(404);
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/test')).status).toBe(409);
    const boot = (await t.api.get('/api/agent/bootstrap')).data;
    expect(boot.models.some((m: any) => m.id === 'sub:chatgpt')).toBe(false);
    const chat = await streamChat(t.api.cookie, { message: 'Hallo', connection: 'sub:chatgpt' });
    expect(JSON.stringify(chat.events.find((e) => e.type === 'error') ?? chat.json)).toContain('ChatGPT-Abo');
    expect(chat.events.some((e) => e.type === 'text')).toBe(false);
    expect(ai.calls.filter((c) => c.url.endsWith('/v1/responses'))).toHaveLength(0);
    // the same through the service API
    for (const uid of [berndId, t.app.db.get<any>('SELECT id FROM users WHERE email = ?', 'chef@example.com').id]) {
      expect(sub().resolveFor({ user: { id: uid } as any, locationId: locA, usage: 'agent', via: 'session' })).toBeNull();
      expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: uid })).toBeNull();
    }
    // the agency admin sees only a number, never who
    await login('chef@example.com');
    const admin = (await t.api.get('/api/ai-subscriptions/admin')).data;
    expect(admin.connected_users).toBe(1);
    expect(JSON.stringify(admin)).not.toMatch(/anna|paula|@/i);
    // …and Bernd's own sign-in is his own row
    await connect('bernd@example.com');
    expect(rowOf(berndId).id).not.toBe(rowOf(annaId).id);
  });

  it('answers 403 to API keys and agency keys', async () => {
    await connect('anna@example.com');
    const callsBefore = ai.calls.length;
    await login('chef@example.com');
    const locKey = (await t.api.post('/api/api-keys', { name: 'Zapier' })).data.key;
    const agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    for (const key of [locKey, agencyKey]) {
      for (const [m, p] of [['GET', '/api/ai-subscriptions'], ['POST', '/api/ai-subscriptions/chatgpt/start'], ['GET', '/api/ai-subscriptions/chatgpt/models'], ['DELETE', '/api/ai-subscriptions/chatgpt']] as const) {
        const r = await t.api.raw(p, { method: m, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-pghl': '1', 'x-location-id': locA }, body: m === 'POST' ? '{}' : undefined });
        expect([401, 403], `${m} ${p}`).toContain(r.status);
      }
    }
    expect(ai.calls.length).toBe(callsBefore);
  });

  it('is limited to the owner’s own browser chat – not automatic runs, API keys, MCP, app tokens', async () => {
    await connect('anna@example.com');
    const u = { id: annaId } as any;
    const ok = sub().resolveFor({ user: u, locationId: locA, usage: 'agent', via: 'session' });
    expect(ok).toMatchObject({ provider: 'chatgpt_plan', wire: 'responses', model: 'gpt-6.1-sol', label: 'Mein ChatGPT-Abo', apiKey: '', headers: {} });
    expect(JSON.stringify(ok)).not.toMatch(/at-secret|rt-secret/);
    for (const via of [undefined, 'api_key', 'agency_key', 'mcp', 'app']) expect(sub().resolveFor({ user: u, locationId: locA, usage: 'agent', via }), String(via)).toBeNull();
    expect(sub().resolveFor({ user: u, locationId: locA, usage: 'agent', via: 'session', automatic: true })).toBeNull();
    expect(sub().resolveFor({ user: undefined, locationId: locA, usage: 'agent', via: 'session' })).toBeNull();
  });

  it('serves only the person’s own assistant and Werkstatt actions – never anything unattended', async () => {
    await connect('anna@example.com');
    for (const purpose of ['workflow', 'chat_bot', 'email_draft', 'voice_agent', 'video_recycle', 'mobile_capture', 'mcp', 'agent_auto', 'test', 'unknown']) expect(sub().providerFor({ locationId: locA, purpose, userId: annaId }), purpose).toBeNull();
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: null })).toBeNull();
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: 'nobody' })).toBeNull();
    const p: any = sub().providerFor({ locationId: locA, purpose: 'suggest', userId: annaId });
    expect(p).toMatchObject({ provider: 'chatgpt_plan', model: 'gpt-6.1-sol', label: 'Mein ChatGPT-Abo' });
    // the token is never sent anywhere but api.openai.com/v1
    await expect(sub().fetchFor({ connectionId: p.connectionId })('https://evil.example/v1/responses', { method: 'POST' })).rejects.toThrow(/api\.openai\.com/);
    expect(ai.calls.some((c) => c.url.includes('evil.example'))).toBe(false);
  });

  it('applies the Werkstatt model gate to the personal model', async () => {
    await connect('anna@example.com');
    const p = (purpose = 'werkstatt_build') => sub().providerFor({ locationId: locA, purpose, userId: annaId });
    // a top model passes (GPT-6 Sol) …
    expect(p()).toMatchObject({ model: 'gpt-6.1-sol' });
    expect(gateProblem(t.app, locA, 'werkstatt_build', { role: 'member', id: annaId })).toBeNull();
    // … another person without such a connection is still stopped by the gate
    expect(gateProblem(t.app, locA, 'werkstatt_build', { role: 'member', id: berndId })).toContain('Spitzenmodell');
    // an everyday model does not: the call falls back to the sub-account's routing (and its gate)
    await t.api.patch('/api/ai-subscriptions/chatgpt', { model: 'gpt-5.6-luna' });
    expect(p()).toBeNull();
    expect(gateProblem(t.app, locA, 'werkstatt_build', { role: 'member', id: annaId })).toContain('Spitzenmodell');
    // a separate Werkstatt model fixes it for builds, the assistant keeps the everyday one
    await t.api.patch('/api/ai-subscriptions/chatgpt', { werkstatt_model: 'gpt-6.1-sol' });
    expect(p()).toMatchObject({ model: 'gpt-6.1-sol' });
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: annaId })).toMatchObject({ model: 'gpt-5.6-luna' });
    expect(gateProblem(t.app, locA, 'werkstatt_build', { role: 'member', id: annaId })).toBeNull();
  });

  it('follows the switches per use', async () => {
    await connect('anna@example.com');
    const u = { id: annaId } as any;
    expect((await t.api.patch('/api/ai-subscriptions/chatgpt', { uses: { agent: false } })).data.uses).toEqual({ agent: false, assistant: true, werkstatt: true });
    expect(sub().resolveFor({ user: u, locationId: locA, usage: 'agent', via: 'session' })).toBeNull();
    expect(sub().chatModelsFor(u, locA)).toEqual([]);
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: annaId })).not.toBeNull();
    await t.api.patch('/api/ai-subscriptions/chatgpt', { uses: { assistant: false, werkstatt: false } });
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: annaId })).toBeNull();
    expect(sub().providerFor({ locationId: locA, purpose: 'werkstatt_build', userId: annaId })).toBeNull();
    expect((await t.api.patch('/api/ai-subscriptions/chatgpt', { model: 'bad model!' })).status).toBe(400);
  });
});

describe('use in the agent chat and the assistant', () => {
  it('runs the agent loop over the Responses API with the person’s token and logs the usage', async () => {
    await connect('anna@example.com');
    const boot = (await t.api.get('/api/agent/bootstrap')).data;
    expect(boot.models).toContainEqual({ id: 'sub:chatgpt', label: 'Mein ChatGPT-Abo', model: 'gpt-6.1-sol', provider: 'chatgpt_plan', vision: true });
    ai.responses = (body, n) =>
      n === 1
        ? [
            { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ghl_search_contacts', namespace: 'gohigh', arguments: '' } },
            { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'ghl_search_contacts', namespace: 'gohigh', arguments: '{"query":"Lena"}' } },
            { type: 'response.completed', response: { usage: { input_tokens: 400, output_tokens: 20 } } },
          ]
        : [{ type: 'response.output_text.delta', delta: 'Ich habe Lena gefunden.' }, { type: 'response.completed', response: { usage: { input_tokens: 600, output_tokens: 12 } } }];
    const chat = await streamChat(t.api.cookie, { message: 'Finde Lena', connection: 'sub:chatgpt' });
    expect(chat.status).toBe(200);
    expect(chat.events.find((e) => e.type === 'start')?.model).toEqual({ provider: 'chatgpt_plan', model: 'gpt-6.1-sol' });
    expect(chat.events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toContain('Lena gefunden');
    expect(chat.events.find((e) => e.type === 'done')?.status).toBe('done');
    const sent = ai.calls.filter((c) => c.url.endsWith('/v1/responses'));
    expect(sent).toHaveLength(2);
    for (const c of sent) {
      expect(c.headers.authorization).toMatch(/^Bearer at-secret-/);
      expect(c.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true });
      expect(c.body.tools[0]).toMatchObject({ type: 'namespace', name: 'gohigh' });
      expect(c.body.tools[0].tools.some((x: any) => x.name === 'ghl_search_contacts')).toBe(true);
    }
    // the second request replays the call and its result
    expect(sent[1].body.input.filter((i: any) => i.type)).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'ghl_search_contacts', namespace: 'gohigh', arguments: '{"query":"Lena"}' },
      { type: 'function_call_output', call_id: 'call_1', output: expect.stringContaining('Lena') },
    ]);
    const usage = t.app.db.get<any>('SELECT SUM(calls) AS calls, SUM(input_tokens) AS i, SUM(cost_micros) AS cost FROM ai_connection_usage WHERE connection_id = ?', `sub:chatgpt:${rowOf(annaId).id}`);
    expect(usage).toMatchObject({ calls: 2, i: 1000, cost: 0 });
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND purpose = 'agent'`, annaId).n).toBeGreaterThan(0);
    expect((await t.api.get('/api/ai-subscriptions')).data.chatgpt.last30).toMatchObject({ calls: 2, input_tokens: 1000 });
  });

  it('cannot be set as the model of a shared custom agent', async () => {
    await connect('anna@example.com');
    const r = await t.api.post('/api/agents', { name: 'Mein Agent', connection_id: 'sub:chatgpt' });
    expect(r.status).toBe(400);
  });

  it('serves the person’s own assistant action; workflows and other people keep their own provider', async () => {
    await connect('anna@example.com');
    const run = (purpose: string, userId: string | null) => t.app.services.aiRun({ locationId: locA, purpose, user: 'Schreibe Hallo.', userId });
    const r = await run('suggest', annaId);
    expect(r.text).toBe('Hallo Welt');
    expect(ai.calls.filter((c) => c.url.endsWith('/v1/responses'))).toHaveLength(1);
    expect(t.app.db.get<any>(`SELECT user_id, status FROM ai_calls WHERE purpose = 'suggest' ORDER BY created_at DESC LIMIT 1`)).toMatchObject({ user_id: annaId, status: 'ok' });
    // unattended or someone else's: the Claude key of the KI-Assistent is used (a failing fake proves the subscription was not)
    let claudeCalls = 0;
    t.app.services.aiFetch = async () => {
      claudeCalls++;
      return new Response(JSON.stringify({ id: 'm', type: 'message', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'von Claude' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      expect((await run('workflow', annaId)).text).toBe('von Claude');
      expect((await run('suggest', berndId)).text).toBe('von Claude');
      expect((await run('suggest', null)).text).toBe('von Claude');
    } finally {
      delete t.app.services.aiFetch;
    }
    expect(claudeCalls).toBe(3);
    expect(ai.calls.filter((c) => c.url.endsWith('/v1/responses'))).toHaveLength(1);
  });

  it('reports a usage limit in plain German', async () => {
    await connect('anna@example.com');
    ai.responses = () => [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }];
    const chat = await streamChat(t.api.cookie, { message: 'Hallo', connection: 'sub:chatgpt' });
    const err = chat.events.find((e) => e.type === 'error');
    expect(JSON.stringify(err)).toContain('chatgpt.com/settings/usage');
  });
});

describe('admin switch and hosted installations', () => {
  it('lets only admins switch it off; everything stops, the switch is audited, tokens stay sealed', async () => {
    await connect('anna@example.com');
    expect((await t.api.put('/api/ai-subscriptions/admin', { chatgpt: false })).status).toBe(403);
    await login('chef@example.com');
    const off = await t.api.put('/api/ai-subscriptions/admin', { chatgpt: false });
    expect(off.status).toBe(200);
    expect(off.data.features.chatgpt).toMatchObject({ available: false, state: 'off_admin' });
    expect(auditRows().find((a) => a.action === 'ai.subscription.admin')!.summary).toContain('ausgeschaltet');
    await login('anna@example.com');
    const ov = (await t.api.get('/api/ai-subscriptions')).data;
    expect(ov.features.chatgpt).toMatchObject({ available: false, state: 'off_admin' });
    expect((await t.api.post('/api/ai-subscriptions/chatgpt/start')).status).toBe(403);
    expect(sub().resolveFor({ user: { id: annaId } as any, locationId: locA, usage: 'agent', via: 'session' })).toBeNull();
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: annaId })).toBeNull();
    expect(sub().chatModelsFor({ id: annaId } as any, locA)).toEqual([]);
    const denied = await streamChat(t.api.cookie, { message: 'Hallo', connection: 'sub:chatgpt' });
    expect(JSON.stringify(denied.events.find((e) => e.type === 'error') ?? denied.json)).toContain('ChatGPT-Abo');
    expect(ai.calls.filter((c) => c.url.endsWith('/v1/responses'))).toHaveLength(0);
    // switched on again: the saved sign-in works without logging in again
    await login('chef@example.com');
    await t.api.put('/api/ai-subscriptions/admin', { chatgpt: true });
    expect(sub().providerFor({ locationId: locA, purpose: 'suggest', userId: annaId })).not.toBeNull();
  });

  it('is off on an installation run as a hosted service until the operator has OpenAI’s approval', async () => {
    process.env.PGHL_HOSTED = '1';
    expect(sub().availability()).toMatchObject({ available: false, state: 'hosted' });
    await login('anna@example.com');
    const start = await t.api.post('/api/ai-subscriptions/chatgpt/start');
    expect(start.status).toBe(403);
    expect(start.data.error).toContain('OpenAI');
    process.env.PGHL_CHATGPT_SIGNIN_APPROVED = '1';
    expect(sub().availability()).toMatchObject({ available: true, state: 'on' });
    process.env.PGHL_SUBSCRIPTION_SIGNIN = 'off';
    expect(sub().availability()).toMatchObject({ available: false, state: 'off_env' });
  });
});

describe('MCP tool ghl_ai_providers', () => {
  it('lists providers (EU filter), connections and the sign-in status – without secrets', async () => {
    await connect('anna@example.com');
    await login('chef@example.com');
    await t.api.post('/api/ai-connections', { provider: 'scaleway', api_key: 'scw-secret-key-0123456789' });
    const agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${agencyKey}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_ai_providers', arguments: { location_id: locA, ...args } } }) });
      const res = (await r.json()).result;
      return { raw: res.content[0].text as string, data: res.isError ? null : JSON.parse(res.content[0].text) };
    };
    const eu = await call({ filter: 'eu' });
    expect(eu.data.providers.map((p: any) => p.id).sort()).toEqual(['ionos', 'mistral_eu', 'ovh', 'scaleway', 'stackit']);
    expect(eu.data.providers.find((p: any) => p.id === 'ionos')).toMatchObject({ base_url: 'https://openai.inference.de-txl.ionos.com/v1', eu_hosting: { region: 'Deutschland' } });
    expect(eu.data.connections).toContainEqual(expect.objectContaining({ provider: 'scaleway', key_set: true }));
    expect(eu.data.subscription_sign_in.chatgpt).toMatchObject({ available: true });
    expect(eu.data.subscription_sign_in.claude).toMatchObject({ available: false, oauth: false, paths: ['bridge', 'api_key'] });
    expect((await call({ filter: 'cheap', search: 'novita' })).data.providers.map((p: any) => p.id)).toEqual(['novita']);
    // no secrets, no personal data
    const all = (await call({})).raw;
    expect(all).not.toMatch(/scw-secret|at-secret|rt-secret|paula|oaiapp_/);
  });
});
