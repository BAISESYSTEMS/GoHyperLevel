import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { fakeModel, json } from './agent-fakes.js';
import { retry } from '../server/services/agent-llm.js';
import { authHeaders, connectionHeaders, PRESETS, parseModelList } from '../server/services/ai-presets.js';
import { extractJson } from '../server/services/ai-compat.js';

const net = fakeModel();
let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
const login = async (email: string) => {
  t.api.clearCookie();
  expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
};
const reg = () => t.app.services.aiConnections;

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiConnectionsFetch = net.fetch;
  await t.setup();
  locA = t.api.location;
  locB = (await t.api.post('/api/locations', { name: 'Firma B' })).data.id;
  await t.api.post('/api/users', { email: 'settings@example.com', name: 'Sabine', password: 'geheim123', role: 'member', locations: [locA], permissions: ['settings', 'conversations', 'contacts'] });
  await t.api.post('/api/users', { email: 'b@example.com', name: 'Bernd', password: 'geheim123', role: 'member', locations: [locB], permissions: ['settings'] });
});
afterAll(() => t.close());
beforeEach(() => net.reset());

describe('presets and headers (pure)', () => {
  it('has the text and media presets with base URLs, auth styles and key hints', () => {
    const ids = PRESETS.map((p) => p.id);
    for (const id of ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'together', 'fireworks', 'deepseek', 'mistral', 'xai', 'perplexity', 'cerebras', 'huggingface', 'azure', 'ollama', 'lmstudio', 'litellm', 'custom', 'fal', 'kie', 'replicate', 'stability', 'elevenlabs', 'runway', 'luma', 'custom_http']) expect(ids).toContain(id);
    for (const p of PRESETS) {
      expect(p.capabilities.length, p.id).toBeGreaterThan(0);
      if (!p.customUrl) expect(p.baseUrl, p.id).toMatch(/^https:\/\//);
      if (p.wire === 'http') expect(p.capabilities, p.id).not.toContain('text');
    }
  });

  it('builds the right auth headers per style', () => {
    expect(authHeaders('bearer', 'k1')).toEqual({ authorization: 'Bearer k1' });
    expect(authHeaders('x-api-key', 'k2')).toEqual({ 'x-api-key': 'k2' });
    expect(authHeaders('key', 'k3')).toEqual({ authorization: 'Key k3' });
    expect(authHeaders('header', 'k4', 'xi-api-key')).toEqual({ 'xi-api-key': 'k4' });
    expect(authHeaders('none', 'k5')).toEqual({});
    expect(authHeaders('header', 'k6', 'Host')).toEqual({});
    // preset defaults: fal "Key", ElevenLabs xi-api-key, Anthropic version header, Runway version header, Azure api-key
    expect(connectionHeaders({ provider: 'fal', authStyle: 'key', apiKey: 'f' })).toEqual({ authorization: 'Key f' });
    expect(connectionHeaders({ provider: 'elevenlabs', authStyle: 'header', apiKey: 'e' })).toEqual({ 'xi-api-key': 'e' });
    expect(connectionHeaders({ provider: 'anthropic', authStyle: 'x-api-key', apiKey: 'a' })).toMatchObject({ 'x-api-key': 'a', 'anthropic-version': '2023-06-01' });
    expect(connectionHeaders({ provider: 'runway', authStyle: 'bearer', apiKey: 'r' })).toMatchObject({ authorization: 'Bearer r', 'x-runway-version': expect.any(String) });
    expect(connectionHeaders({ provider: 'azure', authStyle: 'header', apiKey: 'z' })).toEqual({ 'api-key': 'z' });
    // extra headers can't override auth
    expect(connectionHeaders({ provider: 'custom', authStyle: 'bearer', apiKey: 'good', extraHeaders: { Authorization: 'Bearer evil', 'X-Org': 'o1', Cookie: 'c' } })).toEqual({ authorization: 'Bearer good', 'x-org': 'o1' });
    expect(parseModelList({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'a' }, { id: 'a' }] })).toEqual(['a', 'gemini-2.5-flash']);
    expect(extractJson('Hier:\n```json\n{"summary":"x","next_step":"y"}\n```')).toBe('{"summary":"x","next_step":"y"}');
  });
});

describe('registry API', () => {
  it('CRUD with scoping: agency vs sub-account, members, other sub-accounts', async () => {
    const agency = (await t.api.post('/api/ai-connections', { scope: 'agency', provider: 'openrouter', label: 'OpenRouter Agentur', api_key: 'sk-or-v1-agencykey123456', models: { text: 'openai/gpt-5-mini' } })).data;
    expect(agency).toMatchObject({ scope: 'agency', provider: 'openrouter', key_set: true, key_hint: '…3456', capabilities: ['text', 'vision', 'image'] });
    const local = (await t.api.post('/api/ai-connections', { provider: 'fal', api_key: 'fal-key-local-abcdef', models: { image: 'fal-ai/flux/schnell' } })).data;
    expect(local).toMatchObject({ scope: 'location', location_id: locA, auth_style: 'key' });
    // validation
    expect((await t.api.post('/api/ai-connections', { provider: 'openai' })).status).toBe(400);
    expect((await t.api.post('/api/ai-connections', { provider: 'nope', api_key: 'x' })).status).toBe(400);
    expect((await t.api.post('/api/ai-connections', { provider: 'fal', api_key: 'k', capabilities: ['text'] })).status).toBe(400);
    expect((await t.api.post('/api/ai-connections', { provider: 'ollama', base_url: 'http://localhost:11434/v1', models: { text: 'llama3.1' } })).status).toBe(400);
    const ollama = await t.api.post('/api/ai-connections', { provider: 'ollama', base_url: 'http://localhost:11434/v1', models: { text: 'llama3.1:8b' }, options: { allow_private: true } });
    expect(ollama.status).toBe(200);

    await login('settings@example.com');
    const seen = (await t.api.get('/api/ai-connections')).data.connections;
    expect(seen.map((c: any) => c.id)).toEqual(expect.arrayContaining([agency.id, local.id]));
    const ag = seen.find((c: any) => c.id === agency.id);
    expect(ag).toMatchObject({ editable: false, key_hint: '••••' });
    expect((await t.api.post('/api/ai-connections', { scope: 'agency', provider: 'groq', api_key: 'gsk_x' })).status).toBe(403);
    expect((await t.api.patch(`/api/ai-connections/${agency.id}`, { label: 'x' })).status).toBe(403);
    expect((await t.api.post('/api/ai-connections', { provider: 'custom', base_url: 'http://10.0.0.5/v1', models: { text: 'm' }, options: { allow_private: true } })).status).toBe(403);
    const mine = (await t.api.post('/api/ai-connections', { provider: 'deepseek', api_key: 'sk-deepseek-123456', models: { text: 'deepseek-chat' } })).data;
    expect(mine.editable).toBe(true);
    expect((await t.api.patch(`/api/ai-connections/${mine.id}`, { enabled: false })).data.enabled).toBe(false);

    await login('b@example.com');
    t.api.setLocation(locB);
    const other = (await t.api.get('/api/ai-connections')).data.connections.map((c: any) => c.id);
    expect(other).toContain(agency.id);
    expect(other).not.toContain(local.id);
    expect(other).not.toContain(mine.id);
    expect((await t.api.del(`/api/ai-connections/${local.id}`)).status).toBe(404);
    await login('chef@example.com');
    t.api.setLocation(locA);
    expect((await t.api.del(`/api/ai-connections/${mine.id}`)).status).toBe(200);
  });

  it('never sends keys or extra header values to the browser', async () => {
    const secret = 'sk-proj-SUPERSECRET-abcdefghijklmnop';
    const c = (await t.api.post('/api/ai-connections', { provider: 'custom', label: 'Proxy', base_url: 'https://llm.example.com/v1', api_key: secret, extra_headers: { 'X-Tenant': 'tenant-secret-42' }, models: { text: 'm1' } })).data;
    const all = JSON.stringify((await t.api.get('/api/ai-connections')).data);
    expect(all).not.toContain('SUPERSECRET');
    expect(all).not.toContain('tenant-secret-42');
    expect(all).toContain('X-Tenant');
    const row = t.app.db.get('SELECT api_key, extra_headers FROM ai_connections WHERE id = ?', c.id);
    expect(row.api_key).not.toContain('SUPERSECRET');
    expect(row.extra_headers).not.toContain('tenant-secret-42');
    // server-side resolve has them
    const r = reg().resolve(locA, 'text', c.id);
    expect(r).toMatchObject({ apiKey: secret, headers: { authorization: `Bearer ${secret}`, 'x-tenant': 'tenant-secret-42' }, model: 'm1', wire: 'openai' });
    // an empty value on edit keeps the stored header
    await t.api.patch(`/api/ai-connections/${c.id}`, { extra_headers: { 'X-Tenant': '' } });
    expect(reg().resolve(locA, 'text', c.id).headers['x-tenant']).toBe('tenant-secret-42');
    await t.api.del(`/api/ai-connections/${c.id}`);
  });

  it('hands media modules the agreed shape: auth style with header name, webhook secret, HTTP template', async () => {
    const el = (await t.api.post('/api/ai-connections', { provider: 'elevenlabs', api_key: 'sk_eleven_123', models: { audio_tts: 'eleven_multilingual_v2' } })).data;
    expect(reg().resolve(locA, 'audio_tts', el.id)).toMatchObject({ provider: 'elevenlabs', authStyle: 'header:xi-api-key', headers: { 'xi-api-key': 'sk_eleven_123' }, baseUrl: 'https://api.elevenlabs.io', wire: 'http' });
    expect(reg().resolve(locA, 'image')).toMatchObject({ provider: 'fal', authStyle: 'key', headers: { authorization: 'Key fal-key-local-abcdef' } });

    // kie.ai: the callback signing secret is sealed, write-only and handed to resolve() only
    const kie = (await t.api.post('/api/ai-connections', { provider: 'kie', api_key: 'kie-key-1', webhook_secret: 'kie-hmac-SECRET-123', models: { video: 'veo3_fast' } })).data;
    expect(kie).toMatchObject({ webhook_secret_set: true });
    expect(JSON.stringify((await t.api.get('/api/ai-connections')).data)).not.toContain('kie-hmac-SECRET');
    expect(t.app.db.get('SELECT webhook_secret FROM ai_connections WHERE id = ?', kie.id).webhook_secret).not.toContain('kie-hmac-SECRET');
    expect(reg().resolve(locA, 'video', kie.id)).toMatchObject({ authStyle: 'bearer', webhookSecret: 'kie-hmac-SECRET-123' });
    await t.api.patch(`/api/ai-connections/${kie.id}`, { webhook_secret: '' });
    expect(reg().resolve(locA, 'video', kie.id).webhookSecret).toBe('kie-hmac-SECRET-123');
    await t.api.patch(`/api/ai-connections/${kie.id}`, { webhook_secret: null });
    expect(reg().resolve(locA, 'video', kie.id).webhookSecret).toBeUndefined();
    expect((await t.api.post('/api/ai-connections', { provider: 'groq', api_key: 'gsk_1', webhook_secret: 'x' })).status).toBe(400);

    // custom HTTP: key as URL parameter and a request template in options
    const template = { url: 'https://media.example.com/v1/generate', method: 'POST', body: '{"prompt": "{{prompt}}"}', result_path: 'images[0].url' };
    const http = (await t.api.post('/api/ai-connections', { provider: 'custom_http', base_url: 'https://media.example.com', api_key: 'qkey-1', auth_style: 'query', auth_header: 'key', capabilities: ['image'], models: { image: 'my-model' }, options: { template } })).data;
    expect(http.options.template).toEqual(template);
    const r = reg().resolve(locA, 'image', http.id);
    expect(r).toMatchObject({ provider: 'custom_http', authStyle: 'query:key', model: 'my-model', options: { template } });
    expect(Object.values(r.headers)).not.toContain('qkey-1');
    expect((await t.api.post('/api/ai-connections', { provider: 'openai', api_key: 'sk-1', auth_style: 'query', auth_header: 'key' })).status).toBe(400);
    expect((await t.api.post('/api/ai-connections', { provider: 'fal', api_key: 'f', options: { template } })).status).toBe(400);
    expect((await t.api.post('/api/ai-connections', { provider: 'custom_http', base_url: 'https://media.example.com', capabilities: ['image'], options: { template: { body: 'x' } } })).status).toBe(400);
    // list(): id, provider, label, capabilities and the default model for the capability asked for
    expect(reg().list(locA, 'video')).toEqual(expect.arrayContaining([expect.objectContaining({ id: kie.id, provider: 'kie', model: 'veo3_fast', capabilities: expect.arrayContaining(['video']) })]));
    for (const id of [el.id, kie.id, http.id]) await t.api.del(`/api/ai-connections/${id}`);
  });

  it('resolves: explicit → sub-account routing → own connection → agency routing → agency → KI-Assistent key', async () => {
    t.api.setLocation(locB);
    const ag1 = (await t.api.post('/api/ai-connections', { scope: 'agency', provider: 'groq', api_key: 'gsk_agencyone', models: { text: 'llama-3.3-70b-versatile' } })).data;
    const ag2 = (await t.api.post('/api/ai-connections', { scope: 'agency', provider: 'mistral', api_key: 'mistral-two', models: { text: 'mistral-small-latest' } })).data;
    // nothing local: first agency text connection (the OpenRouter one from the first test)
    expect(reg().resolve(locB, 'agent').provider).toBe('openrouter');
    await t.api.put('/api/ai-connections/routing', { scope: 'agency', usage: 'agent', connection_id: ag2.id, model: 'mistral-large-latest' });
    expect(reg().resolve(locB, 'agent')).toMatchObject({ connectionId: ag2.id, model: 'mistral-large-latest' });
    // a connection of the sub-account beats the agency's routing
    const own = (await t.api.post('/api/ai-connections', { provider: 'together', api_key: 'together-key', models: { text: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' } })).data;
    expect(reg().resolve(locB, 'agent').connectionId).toBe(own.id);
    // … and the sub-account's routing beats its other connections
    await t.api.put('/api/ai-connections/routing', { usage: 'agent', connection_id: ag1.id });
    expect(reg().resolve(locB, 'agent').connectionId).toBe(ag1.id);
    // explicit id wins; capability is checked
    expect(reg().resolve(locB, 'agent', ag2.id).connectionId).toBe(ag2.id);
    expect(reg().resolve(locB, 'image', ag2.id)).toBeNull();
    // routing needs the capability
    expect((await t.api.put('/api/ai-connections/routing', { usage: 'image', connection_id: ag1.id })).status).toBe(400);
    // media capability: no connection → null
    expect(reg().resolve(locB, 'video')).toBeNull();
    const effective = (await t.api.get('/api/ai-connections')).data.routing.effective;
    expect(effective.agent.connection_id).toBe(ag1.id);
    // the KI-Assistent's own key is an implicit, read-only connection
    t.api.setLocation(locA);
    for (const c of (await t.api.get('/api/ai-connections')).data.connections.filter((x: any) => x.editable)) await t.api.del(`/api/ai-connections/${c.id}`);
    await t.api.put('/api/ai/settings', { api_key: 'sk-ant-api03-implicit-abcdefghijklmnopqrstuv' });
    const list = (await t.api.get('/api/ai-connections')).data.connections;
    expect(list.find((c: any) => c.id === 'implicit:ai-anthropic')).toMatchObject({ implicit: true, editable: false, provider: 'anthropic' });
    expect(reg().list(locA, 'image').map((c: any) => c.id)).not.toContain('implicit:ai-anthropic');
  });

  it('lists models live with a cache, falls back to suggestions, and always accepts a typed model', async () => {
    const c = (await t.api.post('/api/ai-connections', { provider: 'openrouter', api_key: 'sk-or-v1-models', models: { text: 'my-org/fine-tuned:v2@latest' } })).data;
    expect(c.models.text).toBe('my-org/fine-tuned:v2@latest');
    net.reply(json({ data: [{ id: 'openai/gpt-5-mini' }, { id: 'anthropic/claude-sonnet-4.5' }] }));
    const first = (await t.api.get(`/api/ai-connections/${c.id}/models`)).data;
    expect(first).toMatchObject({ live: true, cached: false, free_text: true, models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini'] });
    expect(net.calls[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/models' });
    expect(net.calls[0].headers.authorization).toBe('Bearer sk-or-v1-models');
    const second = (await t.api.get(`/api/ai-connections/${c.id}/models`)).data;
    expect(second.cached).toBe(true);
    expect(net.calls).toHaveLength(1);
    net.reply(json({ error: { message: 'down' } }, 500), json({ error: { message: 'down' } }, 500));
    const failed = (await t.api.get(`/api/ai-connections/${c.id}/models?refresh=1`)).data;
    expect(failed).toMatchObject({ live: false });
    expect(failed.models.length).toBeGreaterThan(0);
    // providers without a list: suggestions
    const fal = (await t.api.post('/api/ai-connections', { provider: 'fal', api_key: 'fal-1' })).data;
    expect((await t.api.get(`/api/ai-connections/${fal.id}/models`)).data).toMatchObject({ live: false, models: expect.arrayContaining(['fal-ai/flux/schnell']) });
  });

  it('"Verbindung testen" checks the model list and whether tool calls work', async () => {
    const c = (await t.api.post('/api/ai-connections', { provider: 'groq', api_key: 'gsk_test_conn', models: { text: 'llama-3.3-70b-versatile' } })).data;
    net.reply(json({ data: [{ id: 'llama-3.3-70b-versatile' }] }), json({ id: 'x', model: 'llama-3.3-70b-versatile', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'ping', arguments: '{"ok":true}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    const r = (await t.api.post('/api/ai-connections/test', { id: c.id, deep: true })).data;
    expect(r).toMatchObject({ ok: true, model_found: true, tools: true, message: 'Verbindung funktioniert.' });
    net.reply(json({ error: { message: 'invalid api key' } }, 401));
    const bad = await t.api.post('/api/ai-connections/test', { id: c.id });
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain('Schlüssel ist ungültig');
    expect((await t.api.get('/api/ai-connections')).data.connections.find((x: any) => x.id === c.id).status).toBe('error');
  });

  it('routes the KI-Assistent’s quick texts (aiRun) through an OpenAI-compatible preset', async () => {
    t.api.setLocation(locA);
    const contact = (await t.api.post('/api/contacts', { first_name: 'Ute', email: 'ute@example.com' })).data;
    const c = (await t.api.post('/api/ai-connections', { provider: 'together', api_key: 'together-aiRun', models: { text: 'Qwen/Qwen2.5-72B-Instruct-Turbo' } })).data;
    await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: c.id });
    expect((await t.api.put('/api/ai/settings', { enabled: true })).status).toBe(200);
    const provider = (await t.api.get('/api/ai/provider')).data;
    expect(provider.routed).toMatchObject({ label: 'Together AI', model: 'Qwen/Qwen2.5-72B-Instruct-Turbo' });
    net.reply(json({ id: 'r', model: 'Qwen/Qwen2.5-72B-Instruct-Turbo', choices: [{ index: 0, message: { role: 'assistant', content: 'Hallo Ute, gern!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 12 } }));
    const s = await t.api.post('/api/ai/suggest', { contact_id: contact.id, channel: 'email' });
    expect(s.status).toBe(200);
    expect(s.data.text).toBe('Hallo Ute, gern!');
    expect(net.calls[0].url).toBe('https://api.together.xyz/v1/chat/completions');
    expect(net.calls[0].headers.authorization).toBe('Bearer together-aiRun');
    expect(net.calls[0].body.messages[0].role).toBe('system');
    const usage = (await t.api.get('/api/ai/usage')).data;
    expect(usage.recent[0]).toMatchObject({ purpose: 'suggest', status: 'ok' });
    expect((await t.api.get('/api/ai-connections')).data.usage[c.id]).toMatchObject({ calls: 1 });
    // summaries: JSON mode + the object is cut out of a fenced reply
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const u = new URL(urls.email);
    await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'ute@example.com', subject: 'Frage', text: 'Wann habt ihr offen?' }) });
    await t.app.events.flush();
    const conv = (await t.api.get('/api/conversations?q=ute@example.com')).data[0];
    net.reset();
    net.reply(json({ id: 'r2', model: 'q', choices: [{ index: 0, message: { role: 'assistant', content: '```json\n{"summary":"Ute fragt nach Öffnungszeiten.","next_step":"Zeiten schicken"}\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    const sum = await t.api.post('/api/ai/summarize', { conversation_id: conv.id });
    expect(sum.data).toMatchObject({ summary: 'Ute fragt nach Öffnungszeiten.', next_step: 'Zeiten schicken' });
    expect(net.calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(net.calls[0].body.messages[0].content).toContain('JSON-Schema');
    // without routing the KI-Assistent keeps its own provider
    await t.api.put('/api/ai-connections/routing', { usage: 'text', connection_id: '' });
    expect((await t.api.get('/api/ai/provider')).data.routed).toBeNull();
  });
});
