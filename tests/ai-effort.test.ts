import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';
import { fakeModel, sse } from './agent-fakes.js';
import { DEFAULT_EFFORT, capOfPurpose, effortFields, effortKind, isEffortRejection, maxEffort, planEffort } from '../server/services/ai-effort.js';
import { chatWithTools, effortPlanOf } from '../server/services/agent-llm.js';

/**
 * Denkstufe: which level a model takes, what each wire format receives, the settings (agency default, per
 * capability, per sub-account), how aiRun and the agent pick them up, and what happens when a provider refuses.
 */

describe('what a model can take (pure)', () => {
  const m = (model: string, provider = 'openrouter', wire: string = 'openai') => maxEffort({ provider, model, wire });
  it('knows the top models and their ceiling, also behind a vendor prefix', () => {
    expect(m('gpt-6-sol', 'openai')).toBe('xhigh');
    expect(m('openai/gpt-6-sol')).toBe('xhigh');
    expect(m('astra-1')).toBe('xhigh');
    expect(m('vendor/astra-pro')).toBe('xhigh');
    expect(m('anthropic/claude-opus-5.5')).toBe('xhigh');
    expect(m('claude-opus-5-5', 'anthropic', 'anthropic')).toBe('xhigh');
    expect(m('claude-fable-5-5', 'anthropic', 'anthropic')).toBe('xhigh');
    expect(m('claude-opus-5-6', 'anthropic', 'anthropic')).toBe('xhigh');
    expect(m('claude-opus-5-1', 'anthropic', 'anthropic')).toBe('high');
    expect(m('claude-sonnet-5-5', 'anthropic', 'anthropic')).toBe('high');
    expect(m('claude-haiku-4-5', 'anthropic', 'anthropic')).toBeNull();
    expect(m('gpt-5-mini', 'openai')).toBe('high');
    expect(m('gpt-5.1')).toBe('xhigh');
    expect(m('gpt-5-chat-latest', 'openai')).toBeNull();
    expect(m('gpt-4.1-mini', 'openai')).toBeNull();
    expect(m('o3-mini', 'openai')).toBe('high');
    expect(m('gemini-2.5-pro', 'gemini')).toBe('high');
    expect(m('llama-3.3-70b-versatile', 'groq')).toBeNull();
  });

  it('lowers a level to the highest the model takes and says so in plain German', () => {
    const sonnet = { provider: 'anthropic', wire: 'anthropic', model: 'claude-sonnet-5-5' };
    expect(planEffort(sonnet, 'xhigh')).toEqual({ requested: 'xhigh', applied: 'high', sent: true, note: 'xhigh → high, vom Modell nicht unterstützt' });
    expect(planEffort(sonnet, 'medium')).toMatchObject({ applied: 'medium', note: '' });
    expect(planEffort({ provider: 'openai', model: 'gpt-6-sol' }, 'xhigh')).toMatchObject({ applied: 'xhigh', note: '' });
    // a model without a Denkstufe gets nothing sent in everyday calls
    expect(planEffort({ provider: 'groq', model: 'llama-3.3-70b-versatile' }, 'xhigh')).toMatchObject({ applied: null, sent: false });
    expect(planEffort({ provider: 'anthropic', model: 'claude-haiku-4-5' }, 'xhigh').sent).toBe(false);
  });

  it('the Werkstatt never goes below high – and always sends the level, even for a model we do not know', () => {
    const opus = { provider: 'anthropic', wire: 'anthropic', model: 'claude-opus-5-5' };
    expect(planEffort(opus, 'low', { strict: true })).toMatchObject({ requested: 'high', applied: 'high', sent: true });
    expect(planEffort(opus, 'low', { strict: true }).note).toContain('low → high');
    const unknown = planEffort({ provider: 'custom', model: 'my-own-model' }, 'xhigh', { strict: true });
    expect(unknown).toMatchObject({ applied: 'high', sent: true });
    expect(unknown.note).toContain('xhigh → high');
  });

  it('maps the level onto each provider\'s parameter', () => {
    const plan = (e: any) => ({ requested: e, applied: e, sent: true, note: '' });
    expect(effortFields('anthropic', plan('xhigh'))).toEqual({ output_config: { effort: 'xhigh' } });
    expect(effortFields('responses', plan('high'))).toEqual({ reasoning: { effort: 'high' } });
    expect(effortFields('openrouter', plan('medium'))).toEqual({ reasoning: { effort: 'medium' } });
    expect(effortFields('chat', plan('low'))).toEqual({ reasoning_effort: 'low' });
    expect(effortFields('chat', { requested: 'high', applied: null, sent: false, note: '' })).toEqual({});
    expect(effortKind({ provider: 'openrouter', model: 'x' }, 'chat')).toBe('openrouter');
    expect(effortKind({ provider: 'gemini', model: 'x' }, 'chat')).toBe('chat');
    expect(effortKind({ provider: 'openai', model: 'x' }, 'responses')).toBe('responses');
    expect(effortKind({ provider: 'anthropic', model: 'x' }, 'messages')).toBe('anthropic');
  });

  it('knows which purposes belong to which capability and which are strict', () => {
    expect(capOfPurpose('werkstatt_build')).toBe('werkstatt');
    expect(capOfPurpose('werkstatt_plan')).toBe('werkstatt');
    // A running plugin's own AI call is everyday text, not a Werkstatt build.
    expect(capOfPurpose('plugin')).toBe('text');
    expect(capOfPurpose('werkstatt_review')).toBe('review');
    expect(capOfPurpose('werkstatt_review2')).toBe('review');
    expect(capOfPurpose('summary')).toBe('summary');
    expect(capOfPurpose('voice_agent')).toBe('voice');
    expect(capOfPurpose('suggest')).toBe('text');
    expect(DEFAULT_EFFORT).toBe('xhigh');
    expect(isEffortRejection(400, 'Unknown parameter: reasoning_effort')).toBe(true);
    expect(isEffortRejection(400, 'max_tokens is too large')).toBe(false);
    expect(isEffortRejection(500, 'reasoning failed')).toBe(false);
  });
});

describe('a provider that refuses the level (adapters)', () => {
  const target = { provider: 'openai', wire: 'openai' as const, baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol', headers: { authorization: 'Bearer k' }, options: {} };
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi' }] }];
  const ok = () => new Response(JSON.stringify({ id: 'c', model: 'gpt-6-sol', choices: [{ index: 0, message: { role: 'assistant', content: 'Hallo' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const refuse = () => new Response(JSON.stringify({ error: { message: "Unsupported value: 'xhigh' for reasoning_effort" } }), { status: 400, headers: { 'content-type': 'application/json' } });

  it('an everyday call is repeated once without a level and reports it', async () => {
    const bodies: any[] = [];
    const r = await chatWithTools({ connection: target, system: 'S', messages, tools: [] }, (async (_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? refuse() : ok();
    }) as any);
    expect(bodies[0].reasoning_effort).toBe('xhigh');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(r.text).toBe('Hallo');
    expect(r.effort).toMatchObject({ sent: false });
    expect(r.effort!.note).toContain('abgelehnt');
  });

  it('the Werkstatt gets a clear error instead of thinking less quietly', async () => {
    let calls = 0;
    const p = chatWithTools({ connection: target, system: 'S', messages, tools: [], effort: 'xhigh', strictEffort: true }, (async () => (++calls, refuse())) as any);
    await expect(p).rejects.toThrow(/nimmt die Denkstufe „xhigh“ nicht an/);
    expect(calls).toBe(1);
    expect(effortPlanOf({ connection: target, strictEffort: true, effort: 'low' }).applied).toBe('high');
  });
});

// --- settings, aiRun and the agent --------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let admin: ReturnType<typeof client>;
let member: ReturnType<typeof client>;
const sent: any[] = [];
const model = fakeModel();

const ask = (loc: string, purpose: string, extra: Record<string, unknown> = {}) => t.app.services.aiRun({ locationId: loc, purpose, user: 'Hallo', maxTokens: 50, ...extra });

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  admin = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await admin('POST', '/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  expect((await admin('POST', '/api/users', { email: 'lena@example.com', name: 'Lena', password: 'passwort-1x', role: 'member', locations: [B], permissions: null })).status).toBe(200);
  member = client(t.base, { 'x-pghl': '1', 'x-location-id': B });
  expect((await member('POST', '/api/auth/login', { email: 'lena@example.com', password: 'passwort-1x' })).status).toBe(200);
  // One OpenRouter connection with an Opus 5.5 behind it, text routing for everybody; the assistant on in both.
  const c = await admin('POST', '/api/ai-connections', { scope: 'agency', provider: 'openrouter', label: 'OpenRouter', api_key: 'sk-or-v1-testkey-abcdef123456', models: { text: 'anthropic/claude-opus-5.5' } });
  expect(c.status, c.text).toBe(200);
  expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'text', connection_id: c.data.id })).status).toBe(200);
  expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'agent', connection_id: c.data.id })).status).toBe(200);
  for (const loc of [A, B]) expect((await admin('PUT', '/api/ai/settings', { enabled: true }, { 'x-location-id': loc })).status).toBe(200);
  t.app.services.aiConnectionsFetch = (async (_url: string, init: any = {}) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Response(JSON.stringify({ id: 'x', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Antwort' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}, 60_000);
afterAll(() => t.close());

describe('the settings', () => {
  it('default is xhigh for everything, nothing is overridden', async () => {
    const r = await admin('GET', '/api/ai-effort');
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ default: 'xhigh', builtin_default: 'xhigh', strict_min: 'high', agency: { default: null }, own: { default: null } });
    expect(r.data.caps.map((c: any) => c.id)).toEqual(['agent', 'werkstatt', 'review', 'text', 'summary', 'voice']);
    expect(r.data.caps.every((c: any) => c.effective === 'xhigh' && c.own === null && c.agency === null)).toBe(true);
    expect(r.data.caps.filter((c: any) => c.strict).map((c: any) => c.id)).toEqual(['werkstatt', 'review']);
    expect(r.data.note).toContain('Tokens');
  });

  it('the agency sets a default and overrides per capability; the Werkstatt stays at high at least', async () => {
    const r = await admin('PUT', '/api/ai-effort', { scope: 'agency', default: 'medium', caps: { voice: 'low', werkstatt: 'low', agent: 'xhigh' } });
    expect(r.status, r.text).toBe(200);
    const by = Object.fromEntries(r.data.caps.map((c: any) => [c.id, c]));
    expect(r.data.default).toBe('medium');
    expect(by.text).toMatchObject({ effective: 'medium', source: 'agency', agency: null });
    expect(by.voice).toMatchObject({ effective: 'low', agency: 'low' });
    expect(by.agent).toMatchObject({ effective: 'xhigh' });
    expect(by.werkstatt).toMatchObject({ effective: 'high', agency: 'low', strict: true });
    expect(by.review.effective).toBe('high');
  });

  it('a sub-account can set its own; members cannot touch the agency setting; bad input is refused', async () => {
    expect((await member('PUT', '/api/ai-effort', { scope: 'agency', default: 'low' })).status).toBe(403);
    expect((await admin('PUT', '/api/ai-effort', { default: 'turbo' })).status).toBe(400);
    expect((await admin('PUT', '/api/ai-effort', { caps: { gibts: 'low' } })).status).toBe(400);
    expect((await admin('PUT', '/api/ai-effort', { caps: ['low'] })).status).toBe(400);
    const own = await member('PUT', '/api/ai-effort', { default: 'high', caps: { summary: 'low' } });
    expect(own.status, own.text).toBe(200);
    const by = Object.fromEntries(own.data.caps.map((c: any) => [c.id, c]));
    expect(by.summary).toMatchObject({ effective: 'low', source: 'location', own: 'low' });
    expect(by.text).toMatchObject({ effective: 'high', source: 'location' });
    // the other sub-account is unaffected
    const mine = (await admin('GET', '/api/ai-effort')).data;
    expect(mine.caps.find((c: any) => c.id === 'text').effective).toBe('medium');
    expect(mine.own.default).toBeNull();
    // clearing goes back to the agency's value
    const cleared = await member('PUT', '/api/ai-effort', { default: '', caps: { summary: '' } });
    expect(cleared.data.caps.find((c: any) => c.id === 'summary')).toMatchObject({ effective: 'medium', source: 'agency' });
  });
});

describe('aiRun and the agent use the setting', () => {
  it('a quick text is sent with the sub-account\'s level (OpenRouter: reasoning.effort)', async () => {
    sent.length = 0;
    const r = await ask(A, 'suggest');
    expect(sent[0].reasoning).toEqual({ effort: 'medium' });
    expect(sent[0].model).toBe('anthropic/claude-opus-5.5');
    expect(r.effort).toMatchObject({ requested: 'medium', applied: 'medium' });
    await ask(A, 'voice_agent');
    expect(sent[1].reasoning).toEqual({ effort: 'low' });
  });

  it('an explicit level in the call wins for everyday purposes, not for the Werkstatt', async () => {
    sent.length = 0;
    await ask(A, 'suggest', { effort: 'xhigh' });
    expect(sent[0].reasoning).toEqual({ effort: 'xhigh' });
    const w = await ask(A, 'werkstatt_plan', { effort: 'low' });
    expect(sent[1].reasoning).toEqual({ effort: 'high' });
    expect(w.effort!.requested).toBe('high');
  });

  it('the agent chat uses the level of its capability', async () => {
    model.reset();
    // the agency routed the agent to the OpenRouter connection above; the fake model answers in Chat Completions
    model.reply(sse(`data: ${JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hallo' } }] })}\n\ndata: ${JSON.stringify({ id: 'c1', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
    const r = await admin('POST', '/api/agent/chat', { message: 'Hallo' });
    expect(r.status).toBe(200);
    expect(model.calls[0].body.reasoning).toEqual({ effort: 'xhigh' });
  });
});
