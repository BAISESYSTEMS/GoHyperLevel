import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { MAX_MODEL_INFOS, forgetPrices, livePrice, parseModelInfo, rememberPrices, type ModelInfoKind } from '../server/services/ai-model-info.js';
import { PRESETS, chatEndpoint, checkBaseUrl, connectionHeaders, modelsUrl, presetById, presetOut, textPrice, parseModelList } from '../server/services/ai-presets.js';
import { REFERRAL_DEFAULTS, REFERRAL_PROVIDERS } from '../server/modules/referrals.js';

/**
 * The provider catalogue (BYOK): every preset's shape, the live model-list parsing per provider (fixtures are trimmed copies of the
 * providers' real answers from October 2026 – tests/fixtures/ai-models), the EU-hosting flags with their sources, prices per
 * million tokens, OpenRouter's attribution headers. No network.
 */

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/ai-models/${name}.json`, import.meta.url), 'utf8'));
afterEach(() => forgetPrices());

const NEW = ['requesty', 'vercel', 'cloudflare', 'nebius', 'novita', 'hyperbolic', 'sambanova', 'featherless', 'venice', 'moonshot', 'zai', 'qwen', 'minimax', 'cohere', 'ai21', 'kie_llm', 'ionos', 'stackit', 'ovh', 'scaleway', 'mistral_eu'];
const EU = { ionos: 'Deutschland', stackit: 'EU', ovh: 'Frankreich', scaleway: 'EU', mistral_eu: 'EU' };

describe('preset shapes', () => {
  it('has every requested provider with an https address, a key hint, a verified date and documentation', () => {
    for (const id of NEW) {
      const p = presetById(id);
      expect(p, id).toBeTruthy();
      expect(p!.group, id).toBe('text');
      expect(p!.capabilities, id).toContain('text');
      expect(p!.keyRequired, id).toBe(true);
      expect(p!.auth, id).toMatch(/^(bearer)$/);
      expect(p!.docs, id).toMatch(/^https:\/\//);
      expect(p!.keyUrl, id).toMatch(/^https:\/\//);
      expect(p!.verified, id).toBe('2026-10');
      expect(p!.price.input, id).toBeGreaterThan(0);
      if (!p!.customUrl) expect(p!.baseUrl, id).toMatch(/^https:\/\/[a-z0-9.-]+\//);
      expect(PRESETS.filter((x) => x.id === id), `${id} once`).toHaveLength(1);
    }
    // the older ones that the task asked to keep prominent
    for (const id of ['openrouter', 'mistral']) expect(presetById(id)!.verified).toBe('2026-10');
  });

  it('uses the base URLs checked against each provider’s documentation', () => {
    const urls = Object.fromEntries(NEW.map((id) => [id, presetById(id)!.baseUrl]));
    expect(urls).toEqual({
      requesty: 'https://router.requesty.ai/v1',
      vercel: 'https://ai-gateway.vercel.sh/v1',
      cloudflare: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
      nebius: 'https://api.tokenfactory.nebius.com/v1',
      novita: 'https://api.novita.ai/openai/v1',
      hyperbolic: 'https://api.hyperbolic.xyz/v1',
      sambanova: 'https://api.sambanova.ai/v1',
      featherless: 'https://api.featherless.ai/v1',
      venice: 'https://api.venice.ai/api/v1',
      moonshot: 'https://api.moonshot.ai/v1',
      zai: 'https://api.z.ai/api/paas/v4',
      qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      minimax: 'https://api.minimax.io/v1',
      cohere: 'https://api.cohere.ai/compatibility/v1',
      ai21: 'https://api.ai21.com/studio/v1',
      kie_llm: 'https://api.kie.ai/anthropic',
      ionos: 'https://openai.inference.de-txl.ionos.com/v1',
      stackit: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1',
      ovh: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
      scaleway: 'https://api.scaleway.ai/v1',
      mistral_eu: 'https://api.eu.mistral.ai/v1',
    });
    expect(presetById('mistral')!.baseUrl).toBe('https://api.mistral.ai/v1');
  });

  it('marks exactly the EU-hosting providers, each with the page that says so', () => {
    const marked = PRESETS.filter((p) => p.eu).map((p) => [p.id, p.eu!.region]);
    expect(Object.fromEntries(marked)).toEqual(EU);
    for (const p of PRESETS.filter((x) => x.eu)) {
      expect(p.eu!.source, p.id).toMatch(/^https:\/\//);
      expect(p.eu!.note, p.id).toBeTruthy();
      expect(presetOut(p).eu).toMatchObject({ region: (EU as any)[p.id] });
    }
    // providers outside the EU or without a statement are not marked
    for (const id of ['openai', 'anthropic', 'moonshot', 'zai', 'qwen', 'minimax', 'venice', 'novita', 'cloudflare', 'mistral']) expect(presetOut(presetById(id)!).eu, id).toBeNull();
    // the Mistral EU endpoint is the same account as Mistral (partner link and key page)
    expect(presetOut(presetById('mistral_eu')!).referral).toBe('mistral');
    expect(presetOut(presetById('kie_llm')!).referral).toBe('kie');
  });

  it('puts kie.ai on the Anthropic wire (it offers Claude models at /anthropic) next to the media preset', () => {
    const k = presetById('kie_llm')!;
    expect(k.wire).toBe('anthropic');
    expect(presetById('kie')!.wire).toBe('http');
    const ep = chatEndpoint({ provider: 'kie_llm', baseUrl: k.baseUrl, model: 'claude-sonnet-5-5', headers: connectionHeaders({ provider: 'kie_llm', authStyle: 'bearer', apiKey: 'k' }), options: {}, wire: 'anthropic' });
    expect(ep.url).toBe('https://api.kie.ai/anthropic/v1/messages');
    expect(ep.headers.authorization).toBe('Bearer k');
    expect(modelsUrl({ provider: 'kie_llm', baseUrl: k.baseUrl })).toBe('https://api.kie.ai/anthropic/v1/models?limit=100');
  });

  it('builds chat and model-list URLs per provider', () => {
    const chat = (id: string) => chatEndpoint({ provider: id, baseUrl: presetById(id)!.baseUrl, model: 'm', headers: {}, options: {}, wire: 'openai' }).url;
    expect(chat('ionos')).toBe('https://openai.inference.de-txl.ionos.com/v1/chat/completions');
    expect(chat('scaleway')).toBe('https://api.scaleway.ai/v1/chat/completions');
    expect(chat('novita')).toBe('https://api.novita.ai/openai/v1/chat/completions');
    expect(chat('zai')).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(modelsUrl({ provider: 'ovh', baseUrl: presetById('ovh')!.baseUrl })).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models');
    expect(modelsUrl({ provider: 'moonshot', baseUrl: presetById('moonshot')!.baseUrl })).toBe('https://api.moonshot.ai/v1/models');
    // providers without a model list say so (Z.ai, Qwen, MiniMax, Cohere, AI21, Cloudflare)
    for (const id of ['zai', 'qwen', 'minimax', 'cohere', 'ai21', 'cloudflare']) expect(modelsUrl({ provider: id, baseUrl: presetById(id)!.baseUrl }), id).toBeNull();
  });

  it('keeps address placeholders (Cloudflare account id, Alibaba workspace) from being saved', () => {
    expect(presetById('cloudflare')!.customUrl).toBe(true);
    expect(presetById('qwen')!.customUrl).toBe(true);
    // the preset's own address is a template, so it must be edited – checkBaseUrl alone would accept the braces
    expect(checkBaseUrl('https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1', false)).toBeNull();
    expect(checkBaseUrl('http://api.example.com/v1', false)).toContain('https');
  });

  it('is in the partner-link catalogue, with the plain sign-up link and no maintainer link yet', () => {
    const ids = new Set(REFERRAL_PROVIDERS.map((p) => p.id));
    for (const id of NEW.filter((x) => !['cloudflare', 'kie_llm', 'mistral_eu'].includes(x))) {
      expect(ids.has(id), id).toBe(true);
      expect(REFERRAL_DEFAULTS[id], id).toBe('');
    }
    expect(ids.has('cloudflare') && ids.has('kie') && ids.has('mistral')).toBe(true);
    for (const p of REFERRAL_PROVIDERS.filter((x) => NEW.includes(x.id))) expect(p.signup, p.id).toMatch(/^https:\/\//);
  });

  it('marks the cheap, fast and gateway providers for the gallery filters', () => {
    const ids = (tag: string) => PRESETS.filter((p) => presetOut(p).tags.includes(tag)).map((p) => p.id);
    expect(ids('gateway')).toEqual(expect.arrayContaining(['openrouter', 'requesty', 'vercel', 'cloudflare']));
    expect(ids('fast')).toContain('sambanova');
    expect(ids('cheap')).toEqual(expect.arrayContaining(['novita', 'featherless', 'moonshot']));
    expect(ids('local')).toEqual(expect.arrayContaining(['ollama', 'lmstudio']));
  });

  it('skipped Lambda: its Inference API is winding down', () => {
    expect(presetById('lambda')).toBeUndefined();
  });
});

describe('OpenRouter attribution and pricing display', () => {
  const headers = (provider: string, app = { baseUrl: 'https://crm.example.com', name: 'HyperLevel' }) => chatEndpoint({ provider, baseUrl: presetById(provider)!.baseUrl, model: 'm', headers: {}, options: {}, wire: 'openai' }, app).headers;
  it('sends HTTP-Referer and the app title (current and legacy spelling)', () => {
    expect(headers('openrouter')).toMatchObject({ 'http-referer': 'https://crm.example.com', 'x-title': 'HyperLevel', 'x-openrouter-title': 'HyperLevel' });
    expect(headers('requesty')).toMatchObject({ 'http-referer': 'https://crm.example.com', 'x-title': 'HyperLevel' });
    expect(headers('requesty')).not.toHaveProperty('x-openrouter-title');
    expect(headers('groq')).not.toHaveProperty('http-referer');
    // a person's own header wins
    const own = chatEndpoint({ provider: 'openrouter', baseUrl: presetById('openrouter')!.baseUrl, model: 'm', headers: { 'http-referer': 'https://mine.example' }, options: {}, wire: 'openai' }, { baseUrl: 'https://crm.example.com', name: 'HyperLevel' });
    expect(own.headers['http-referer']).toBe('https://mine.example');
  });
});

describe('live model lists (fixtures are real answers)', () => {
  const parse = (kind: ModelInfoKind, name = kind) => parseModelInfo(kind, fixture(name));
  const byId = (list: ReturnType<typeof parse>) => Object.fromEntries(list.map((m) => [m.id, m]));

  it('OpenRouter: price per token → per million, free models, vision and tools, no image generators', () => {
    const m = byId(parse('openrouter'));
    expect(Object.keys(m).sort()).toEqual(['inclusionai/ling-3.1-flash', 'unbiased/pareto-26.10-preview']);
    expect(m['unbiased/pareto-26.10-preview']).toMatchObject({ name: 'Pareto 26.10 Preview', context: 1048576, in: 0.8, out: 3.2, vision: true, tools: true });
    expect(m['inclusionai/ling-3.1-flash']).toMatchObject({ in: 0, out: 0, free: true });
  });

  it('Vercel AI Gateway: only language models, input/output prices', () => {
    const m = byId(parse('vercel'));
    expect(Object.keys(m).sort()).toEqual(['alibaba/qwen-3-14b', 'alibaba/qwen3-235b-a22b-thinking']);
    expect(m['alibaba/qwen-3-14b']).toMatchObject({ name: 'Qwen3-14B', context: 40960, in: 0.12, out: 0.24 });
    expect(m['alibaba/qwen3-235b-a22b-thinking']).toMatchObject({ in: 0.4, out: 4, vision: true });
  });

  it('Requesty: price per token, vision and tool flags', () => {
    const m = byId(parse('requesty'));
    expect(m['deepseek/deepseek-v4.1-flash']).toMatchObject({ vision: expect.any(Boolean), tools: true, in: expect.any(Number) });
    expect(m['scaleway/glm-5.2']).toMatchObject({ in: 2.09, out: 6.38, context: 256000, vision: false, tools: true });
  });

  it('Novita: prices come from price_per_m_decimal (dollars per million tokens)', () => {
    const m = byId(parse('novita'));
    expect(m['zai-org/glm-5.3-flash']).toMatchObject({ in: 0.15, out: 0.5 });
    expect(m['zai-org/glm-5.3-flash'].context).toBeGreaterThan(1000);
  });

  it('Venice: prices in dollars per million, capabilities from model_spec', () => {
    const m = byId(parse('venice'));
    expect(m['gemini-3-6-flash']).toMatchObject({ in: 0.9375, out: 4.6875, context: 1000000, vision: true, tools: true });
    expect(m['z-ai-glm-5-3'].in).toBeGreaterThan(0);
  });

  it('SambaNova: price per token', () => {
    const m = byId(parse('sambanova'));
    expect(m['DeepSeek-V3.1']).toMatchObject({ in: 3, out: 4.5, context: 131072 });
    expect(m['gpt-oss-120b']).toMatchObject({ in: 0.22, out: 0.59 });
  });

  it('OVHcloud: embeddings, speech and image models are left out', () => {
    const m = parse('ovh');
    expect(m.map((x) => x.id).sort()).toEqual(['Qwen2.5-VL-72B-Instruct', 'gpt-oss-120b']);
    expect(byId(m)['gpt-oss-120b']).toMatchObject({ in: 0.09, out: 0.47 });
    expect(byId(m)['Qwen2.5-VL-72B-Instruct'].vision).toBe(true);
  });

  it('Featherless: gated models are left out, prices per token', () => {
    const m = parse('featherless');
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ id: 'recursal/EagleX_1-7T', in: 0.1, out: 0.2, context: 16384 });
    expect(m.some((x) => x.id === 'meta-llama/Llama-3.3-70B-Instruct')).toBe(false);
  });

  it('plain OpenAI-style lists give ids only; broken entries are skipped; the list is capped', () => {
    expect(parseModelInfo(undefined, { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }, null, { nope: 1 }, { id: 'x'.repeat(300) }] })).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(parseModelInfo('openrouter', { data: 'kaputt' })).toEqual([]);
    expect(parseModelInfo('openrouter', null)).toEqual([]);
    expect(parseModelInfo('openrouter', { data: [{ id: 'm', pricing: { prompt: 'abc', completion: null } }] })).toEqual([{ id: 'm', vision: false, tools: false }]);
    const many = { data: Array.from({ length: 3000 }, (_, i) => ({ id: `m${String(i).padStart(4, '0')}` })) };
    expect(parseModelInfo(undefined, many)).toHaveLength(3000); // capping happens when the list is sent (modules/ai-connections.ts)
    expect(MAX_MODEL_INFOS).toBeLessThan(3000);
    expect(parseModelList({ data: [{ id: 'models/x' }, { id: 'x' }] })).toEqual(['x']);
  });

  it('uses the provider’s own price for the cost estimate until the connection sets one', () => {
    rememberPrices('novita', parse('novita'));
    expect(livePrice('novita', 'zai-org/glm-5.3-flash')).toEqual({ in: 0.15, out: 0.5 });
    expect(textPrice({ provider: 'novita', model: 'zai-org/glm-5.3-flash' })).toMatchObject({ input: 0.15, output: 0.5 });
    // a model the list did not price, or an own price on the connection, wins over the preset estimate
    expect(textPrice({ provider: 'novita', model: 'unknown/model' })).toMatchObject({ input: presetById('novita')!.price.input });
    expect(textPrice({ provider: 'novita', model: 'zai-org/glm-5.3-flash', options: { price_in: 9, price_out: 10 } })).toMatchObject({ input: 9, output: 10 });
  });
});

describe('model list and connection test through the registry API', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const seen: string[] = [];
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    t.app.services.aiConnectionsFetch = async (url: string) => {
      seen.push(url);
      if (url === 'https://openrouter.ai/api/v1/models') return new Response(JSON.stringify(fixture('openrouter')), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === 'https://api.z.ai/api/paas/v4/chat/completions') return new Response(JSON.stringify({ model: 'glm-5.3', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://api.z.ai/')) return new Response('Not found', { status: 404 });
      return new Response(JSON.stringify({ error: { message: 'unexpected' } }), { status: 500 });
    };
  });
  afterAll(() => t.close());

  it('returns prices per million tokens, flags and a search over the list', async () => {
    const c = (await t.api.post('/api/ai-connections', { provider: 'openrouter', api_key: 'sk-or-v1-testtesttest0123' })).data;
    const all = (await t.api.get(`/api/ai-connections/${c.id}/models`)).data;
    expect(all).toMatchObject({ live: true, total: 2 });
    expect(all.models.sort()).toEqual(['inclusionai/ling-3.1-flash', 'unbiased/pareto-26.10-preview']);
    expect(all.details.find((d: any) => d.id === 'unbiased/pareto-26.10-preview')).toMatchObject({ in: 0.8, out: 3.2, context: 1048576, vision: true, tools: true });
    const hit = (await t.api.get(`/api/ai-connections/${c.id}/models?q=pareto`)).data;
    expect(hit.models).toEqual(['unbiased/pareto-26.10-preview']);
    expect(hit.total).toBe(2);
    // second call comes from the cache
    expect((await t.api.get(`/api/ai-connections/${c.id}/models`)).data.cached).toBe(true);
    expect(seen.filter((u) => u.endsWith('/models'))).toHaveLength(1);
  });

  it('refuses an address that still has its {placeholder}', async () => {
    const r = await t.api.post('/api/ai-connections', { provider: 'cloudflare', api_key: 'cf-token-abcdefghij', models: { text: '@cf/openai/gpt-oss-120b' } });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Platzhalter');
    const ok = await t.api.post('/api/ai-connections', { provider: 'cloudflare', api_key: 'cf-token-abcdefghij', base_url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef/ai/v1', models: { text: '@cf/openai/gpt-oss-120b' } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
  });

  it('does not call a provider without a model list "broken": the connection test falls through to the chat check', async () => {
    const c = (await t.api.post('/api/ai-connections', { provider: 'zai', api_key: 'zai-key-abcdefghij0123', models: { text: 'glm-5.3' } })).data;
    const r = await t.api.post('/api/ai-connections/test', { id: c.id });
    // no model list URL for Z.ai, so a text connection is checked with a tiny chat request
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.ok).toBe(true);
    expect(seen.some((u) => u === 'https://api.z.ai/api/paas/v4/chat/completions')).toBe(true);
  });
});
