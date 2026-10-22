import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { BOT_SCHEMA, SUMMARY_SCHEMA } from '../server/services/ai-context.js';
import { VOICE_SCHEMA } from '../server/services/voice-ai.js';
import { buildBody, costMicros, priceOf, readUsage, retry, strictCompatible } from '../server/services/openai.js';

/** A fake OpenAI Responses API: records every request, answers with whatever `respond` returns. */
type Reply = { status: number; json: any };
const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
let respond: (body: any, url: string) => Reply = () => out('Hallo!');
function out(text: string, usage: Record<string, any> = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 300 }, model = 'gpt-5-mini-2025-08-07'): Reply {
  return { status: 200, json: { id: 'resp_1', object: 'response', status: 'completed', model, output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage } };
}
const fake = (async (url: string, init: any = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body });
  const r = respond(body, String(url));
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;
const claudeCalls: any[] = [];
const fakeClaude = (async (url: string, init: any = {}) => {
  claudeCalls.push({ url, body: init.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Von Claude' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const OKEY = 'sk-proj-testkey-abcdefghijklmnopqrstuvwxyz0123';
const AKEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
let t: Awaited<ReturnType<typeof startTestApp>>;
let contactId = '';
let convId = '';

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.openaiFetch = fake;
  t.app.services.aiFetch = fakeClaude;
  await t.setup();
  contactId = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Beispiel', email: 'anna@kunde.example' })).data.id;
  const urls = (await t.api.get('/api/settings/inbound')).data;
  const u = new URL(urls.email);
  await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Anna <anna@kunde.example>', subject: 'Website', text: 'Was kostet eine Website?' }) });
  await t.app.events.flush();
  convId = (await t.api.get('/api/conversations?q=anna@kunde.example')).data[0].id;
});
afterAll(() => t.close());
beforeEach(() => {
  calls.length = 0;
  claudeCalls.length = 0;
  respond = () => out('Hallo!');
});

describe('OpenAI client (pure)', () => {
  it('builds Responses API bodies with instructions, the Denkstufe and strict JSON', () => {
    const b = buildBody({ apiKey: 'x', model: 'gpt-5-mini', system: [{ text: 'Du bist ein Assistent.' }, { text: 'Wissen', cache: true }], messages: [{ role: 'user', content: 'Hallo' }], maxTokens: 500, schema: SUMMARY_SCHEMA });
    expect(b).toMatchObject({ model: 'gpt-5-mini', instructions: 'Du bist ein Assistent.\n\nWissen', input: [{ role: 'user', content: 'Hallo' }], max_output_tokens: 500, store: false, reasoning: { effort: 'high' } });
    expect(buildBody({ apiKey: 'x', model: 'gpt-6-sol', system: [], messages: [], maxTokens: 1 }).reasoning).toEqual({ effort: 'xhigh' });
    expect(buildBody({ apiKey: 'x', model: 'gpt-5-mini', system: [], messages: [], maxTokens: 1, effort: 'low' }).reasoning).toEqual({ effort: 'low' });
    expect(b.text).toEqual({ format: { type: 'json_schema', name: 'antwort', schema: SUMMARY_SCHEMA, strict: true } });
    expect(buildBody({ apiKey: 'x', model: 'gpt-4.1-mini', system: [], messages: [], maxTokens: 1 }).reasoning).toBeUndefined();
    for (const s of [BOT_SCHEMA, SUMMARY_SCHEMA, VOICE_SCHEMA]) expect(strictCompatible(s)).toBe(true);
    // an open schema still gets JSON mode, just not strict
    expect(strictCompatible({ type: 'object', properties: { a: { type: 'string' } } })).toBe(false);
    expect((buildBody({ apiKey: 'x', model: 'gpt-5', system: [], messages: [], maxTokens: 1, schema: { type: 'object', properties: { a: { type: 'string', minLength: 2 } }, required: ['a'], additionalProperties: false } }).text as any).format.strict).toBe(false);
  });

  it('prices cached input and unknown models carefully', () => {
    const u = readUsage({ input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 300 });
    expect(u).toEqual({ input_tokens: 200, output_tokens: 300, cache_read_tokens: 1000, cache_write_tokens: 0 });
    expect(costMicros('gpt-5-mini', u)).toBe(200 * 0.25 + 1000 * 0.025 + 300 * 2);
    expect(priceOf('gpt-5-mini-2025-08-07')).toEqual(priceOf('gpt-5-mini'));
    expect(priceOf('gpt-9-ultra').output).toBe(10);
  });
});

describe('provider settings', () => {
  it('defaults to Anthropic; the OpenAI key is validated, sealed and never shown again', async () => {
    const s = (await t.api.get('/api/ai/provider')).data;
    expect(s).toMatchObject({ provider: '', effective: 'anthropic', agency_default: 'anthropic', openai: { key_set: false, effective_model: 'gpt-5-mini' } });
    expect(s.openai.models.map((m: any) => m.id)).toContain('gpt-5-mini');
    expect((await t.api.put('/api/ai/provider', { provider: 'mistral' })).status).toBe(400);
    expect((await t.api.put('/api/ai/provider', { openai_key: 'abc' })).data.error).toContain('sk-');
    expect((await t.api.put('/api/ai/provider', { openai_model: 'gpt 5; drop' })).status).toBe(400);
    const r = await t.api.put('/api/ai/provider', { provider: 'openai', openai_key: OKEY, openai_model: 'gpt-5.1' });
    expect(r.data).toMatchObject({ provider: 'openai', effective: 'openai', openai: { key_set: true, key_hint: '…0123', key_source: 'account', model: 'gpt-5.1', effective_model: 'gpt-5.1' } });
    expect(JSON.stringify(r.data)).not.toContain(OKEY);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM ai_provider_settings'))).not.toContain(OKEY);
    // free text models are fine; back to the default
    expect((await t.api.put('/api/ai/provider', { openai_model: 'ft:gpt-4.1-mini:acme::abc123' })).data.openai.effective_model).toBe('ft:gpt-4.1-mini:acme::abc123');
    expect((await t.api.put('/api/ai/provider', { openai_model: '' })).data.openai.effective_model).toBe('gpt-5-mini');
  });

  it('switches the assistant on with only an OpenAI key and tests the key without spending tokens', async () => {
    const on = await t.api.put('/api/ai/settings', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.data.provider).toMatchObject({ id: 'openai', model: 'gpt-5-mini' });
    expect((await t.api.get('/api/ai/status')).data.enabled).toBe(true);
    respond = (_b, url) => (url.endsWith('/v1/models/gpt-5-mini') ? { status: 200, json: { id: 'gpt-5-mini', object: 'model' } } : { status: 404, json: {} });
    const ok = await t.api.post('/api/ai/provider/test', {});
    expect(ok.data).toEqual({ ok: true, model: 'gpt-5-mini' });
    expect(calls[0]).toMatchObject({ method: 'GET', headers: { authorization: `Bearer ${OKEY}` } });
    respond = () => ({ status: 401, json: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } } });
    const bad = await t.api.post('/api/ai/provider/test', { openai_key: 'sk-wrongwrongwrongwrongwrong' });
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain('OpenAI-API-Schlüssel ist ungültig');
  });
});

describe('aiRun with OpenAI', () => {
  it('reply suggestions go to the Responses API with the knowledge as instructions and are logged with OpenAI prices', async () => {
    await t.api.put('/api/ai/settings', { facts: 'Webdesign-Agentur in Leipzig.' });
    respond = () => out('Hallo Anna, ab 990 €.');
    const r = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ text: 'Hallo Anna, ab 990 €.', model: 'gpt-5-mini-2025-08-07' });
    expect(calls).toHaveLength(1);
    expect(claudeCalls).toHaveLength(0);
    const req = calls[0];
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.authorization).toBe(`Bearer ${OKEY}`);
    expect(req.body).toMatchObject({ model: 'gpt-5-mini', store: false, reasoning: { effort: 'high' }, max_output_tokens: 4000 });
    expect(req.body.instructions).toContain('Webdesign-Agentur in Leipzig.');
    expect(req.body.input[0].content).toContain('Was kostet eine Website?');
    const sug = (await t.api.get('/api/ai/usage')).data.recent.find((x: any) => x.purpose === 'suggest');
    expect(sug).toMatchObject({ model: 'gpt-5-mini-2025-08-07', status: 'ok', input_tokens: 200, cache_read_tokens: 1000, output_tokens: 300 });
    expect(sug.cost_usd).toBeCloseTo(0.000675, 8);
  });

  it('JSON outputs use Structured Outputs: summaries, chat bot schema, direct aiRun callers', async () => {
    respond = (b) => {
      expect(b.text.format).toMatchObject({ type: 'json_schema', strict: true });
      return out(JSON.stringify({ summary: 'Anna fragt nach dem Preis einer Website.', next_step: 'Angebot schicken.' }));
    };
    const s = await t.api.post('/api/ai/summarize', { conversation_id: convId });
    expect(s.data).toMatchObject({ summary: expect.stringContaining('Preis'), next_step: 'Angebot schicken.' });

    respond = (b) => out(JSON.stringify({ kind: 'task', title: 'Anna anrufen', echo: b.text.format.schema.required }));
    const r = await t.app.services.aiRun({ locationId: t.api.location, purpose: 'mobile_capture', user: 'Morgen Anna anrufen', schema: { type: 'object', properties: { kind: { type: 'string' }, title: { type: 'string' }, echo: { type: 'array', items: { type: 'string' } } }, required: ['kind', 'title', 'echo'], additionalProperties: false } });
    expect(JSON.parse(r.text)).toMatchObject({ kind: 'task', title: 'Anna anrufen' });
    expect(calls.at(-1)!.body.instructions).toBeTruthy();
  });

  it('the workflow action "KI-Text" runs on OpenAI too', async () => {
    respond = () => out('Liebe Frau Klein');
    const wf = (await t.api.post('/api/workflows', { name: 'KI', trigger: { type: 'contact.tag_added', config: { tag: 'ki' } }, steps: [{ type: 'ai_text', prompt: 'Anrede für {{contact.first_name}}', target: 'field', field: 'custom.anrede' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = (await t.api.post('/api/contacts', { first_name: 'Karla', last_name: 'Klein', email: 'karla@test.example', tags: ['ki'] })).data;
    await t.app.events.flush();
    expect(calls.at(-1)!.body.input[0].content).toContain('Anrede für Karla');
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.custom.anrede).toBe('Liebe Frau Klein');
  });

  it('errors are German, logged with their usage, and the monthly limit still applies', async () => {
    respond = () => ({ status: 429, json: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } });
    const q = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(q.data.error).toContain('Guthaben');
    respond = () => ({ status: 200, json: { status: 'completed', model: 'gpt-5-mini', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Nein.' }] }], usage: { input_tokens: 100, output_tokens: 10 } } });
    const ref = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(ref.status).toBe(422);
    const recent = (await t.api.get('/api/ai/usage')).data.recent;
    expect(recent[0]).toMatchObject({ status: 'error', model: 'gpt-5-mini', input_tokens: 100, output_tokens: 10 });
    expect(recent[0].cost_usd).toBeGreaterThan(0);
    respond = () => ({ status: 500, json: {} });
    expect((await t.api.post('/api/ai/suggest', { conversation_id: convId })).status).toBe(503);
    expect(calls.filter((c) => c.url.endsWith('/responses')).length).toBeGreaterThanOrEqual(4); // one retry on 5xx

    await t.api.put('/api/ai/settings', { monthly_limit_usd: 0.01 });
    t.app.db.run(`UPDATE ai_calls SET cost_micros = 50000 WHERE location_id = ? AND status = 'ok'`, t.api.location);
    calls.length = 0;
    const over = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(over.status).toBe(409);
    expect(calls).toHaveLength(0);
    expect((await t.api.get('/api/ai/usage')).data.recent[0]).toMatchObject({ status: 'blocked', model: 'gpt-5-mini' });
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 100 });
  });
});

describe('provider switch and agency default', () => {
  it('a sub-account can go back to Claude; the agency default and its key apply where nothing is set', async () => {
    await t.api.put('/api/ai/settings', { api_key: AKEY });
    await t.api.put('/api/ai/provider', { provider: 'anthropic' });
    const r = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(r.data.text).toBe('Von Claude');
    expect(claudeCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);

    // agency default OpenAI with an agency key; the sub-account follows once it has no own choice/key
    await t.api.put('/api/ai/provider', { provider: '', openai_key: null });
    expect((await t.api.put('/api/agency/ai-provider', { provider: 'openai', openai_key: 'abc' })).status).toBe(400);
    const ag = await t.api.put('/api/agency/ai-provider', { provider: 'openai', openai_key: 'sk-agency-abcdefghijklmnopqrstuvwxyz', openai_model: 'gpt-5-nano' });
    expect(ag.data).toMatchObject({ provider: 'openai', openai: { key_set: true, key_hint: '…wxyz', model: 'gpt-5-nano' } });
    expect(JSON.stringify(ag.data)).not.toContain('sk-agency');
    const s = (await t.api.get('/api/ai/provider')).data;
    expect(s).toMatchObject({ provider: '', effective: 'openai', source: 'agency', agency_default: 'openai', openai: { key_set: false, key_source: 'agency', effective_model: 'gpt-5-nano' } });
    await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer sk-agency-abcdefghijklmnopqrstuvwxyz');
    expect(calls.at(-1)!.body.model).toBe('gpt-5-nano');

    // without any OpenAI key the assistant says so (and env PGHL_OPENAI_API_KEY is the last fallback)
    await t.api.put('/api/agency/ai-provider', { openai_key: null });
    const none = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(none.status).toBe(409);
    expect(none.data.error).toContain('OpenAI-API-Schlüssel');
    expect(t.app.services.aiReady(t.api.location)).toContain('OpenAI');
    process.env.PGHL_OPENAI_API_KEY = 'sk-env-abcdefghijklmnopqrstuvwxyz0';
    try {
      expect((await t.api.get('/api/ai/provider')).data.openai.key_source).toBe('server');
      expect((await t.api.post('/api/ai/suggest', { conversation_id: convId })).status).toBe(200);
      expect(calls.at(-1)!.headers.authorization).toBe('Bearer sk-env-abcdefghijklmnopqrstuvwxyz0');
    } finally {
      delete process.env.PGHL_OPENAI_API_KEY;
    }
    await t.api.put('/api/agency/ai-provider', { provider: 'anthropic' });
    expect((await t.api.get('/api/ai/provider')).data.effective).toBe('anthropic');
  });

  it('only admins change the agency default', async () => {
    await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kunde', password: 'geheim1234', role: 'member', locations: [t.api.location], permissions: ['settings'] });
    await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim1234' });
    expect((await t.api.get('/api/agency/ai-provider')).status).toBe(403);
    expect((await t.api.put('/api/agency/ai-provider', { provider: 'openai' })).status).toBe(403);
    expect((await t.api.get('/api/ai/provider')).status).toBe(200);
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
  });
});
