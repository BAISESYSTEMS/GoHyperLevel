import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { startTestApp } from './helpers.js';
import { checkUrl, pathGet } from '../server/services/genmedia/http.js';
import { renderJson } from '../server/services/genmedia/custom-http.js';
import { falMessage, resetFalJwks } from '../server/services/genmedia/fal.js';
import { replicateSignature, resetReplicateSecrets } from '../server/services/genmedia/replicate.js';
import { kieRecord } from '../server/services/genmedia/kie.js';
import { pcmToWav, sniff } from '../server/services/genmedia/media.js';
import { setPostizFetch } from '../server/services/postiz.js';

/** Media generation (KI-Studio): every adapter against a fake provider, storage, scoping, hooks. */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 2)]);

type Call = { url: string; method: string; headers: Record<string, string>; body: any; raw: any };
const calls: Call[] = [];
let routes: ((u: URL, c: Call) => Response | undefined | Promise<Response | undefined>)[] = [];
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const file = (b: Buffer, type: string) => new Response(new Uint8Array(b), { status: 200, headers: { 'content-type': type } });
const fake = async (url: string, init: any) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  let body: any = init.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      /* text */
    }
  }
  const c: Call = { url, method: init.method ?? 'GET', headers, body, raw: init.body };
  calls.push(c);
  for (const r of routes) {
    const res = await r(new URL(url), c);
    if (res) return res;
  }
  return json({ error: `no route ${c.method} ${url}` }, 404);
};
const last = (part: string) => [...calls].reverse().find((c) => c.url.includes(part));

const CONNS: Record<string, any> = {
  'c-fal': { connectionId: 'c-fal', provider: 'fal', baseUrl: 'https://queue.fal.run', apiKey: 'fal-key', authStyle: 'key', caps: ['image', 'video', 'audio_tts', 'audio_music', 'stt'] },
  'c-kie': { connectionId: 'c-kie', provider: 'kie', baseUrl: 'https://api.kie.ai', apiKey: 'kie-key', authStyle: 'bearer', caps: ['image', 'video', 'audio_music'] },
  'c-rep': { connectionId: 'c-rep', provider: 'replicate', apiKey: 'r8-key', caps: ['image', 'video'] },
  'c-oai': { connectionId: 'c-oai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', caps: ['image', 'audio_tts', 'stt'] },
  'c-gem': { connectionId: 'c-gem', provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'AIza-test', caps: ['image', 'video', 'audio_tts'] },
  'c-http': { connectionId: 'c-http', provider: 'custom_http', baseUrl: 'https://api.custom.test', apiKey: 'cust-key', authStyle: 'header:x-api-key', caps: ['image', 'video', 'audio_tts', 'audio_music', 'stt'] },
};
let allowed = new Set<string>();
const registry = {
  resolve: (loc: string, cap: string, connId?: string) => {
    if (!allowed.has(loc)) return null;
    const c = connId ? CONNS[connId] : Object.values(CONNS).find((x) => x.caps.includes(cap));
    if (!c || !c.caps.includes(cap)) return null;
    const { caps: _caps, ...rest } = c;
    return { ...rest };
  },
  list: (loc: string) => (allowed.has(loc) ? Object.values(CONNS).map((c) => ({ id: c.connectionId, provider: c.provider, label: c.provider, capabilities: c.caps })) : []),
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
const svc = () => t.app.services.genmedia;
/** Runs the background work and polls a job until it settles (or n rounds). */
async function settle(jobId: string, rounds = 6) {
  await svc().idle();
  for (let i = 0; i < rounds; i++) {
    const j = t.app.db.get('SELECT status FROM genmedia_jobs WHERE id = ?', jobId);
    if (['succeeded', 'failed', 'canceled'].includes(j.status)) break;
    t.app.db.run('UPDATE genmedia_jobs SET next_run_at = ? WHERE id = ?', new Date(0).toISOString(), jobId);
    await svc().process(jobId);
    await svc().idle();
  }
  return (await t.api.get(`/api/genmedia/jobs/${jobId}`)).data;
}
const create = (body: any) => t.api.post('/api/genmedia/jobs', body);

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.genmediaFetch = fake;
  await t.setup();
  locA = t.api.location;
  locB = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  routes = [];
  allowed = new Set([locA]);
  t.app.services.aiConnections = registry;
  t.app.config.baseUrl = 'http://localhost';
});

describe('BYOK registry', () => {
  it('says what to do when no provider is connected', async () => {
    delete t.app.services.aiConnections;
    const meta = (await t.api.get('/api/genmedia/meta')).data;
    expect(meta).toMatchObject({ available: false, message: 'Bitte zuerst unter Einstellungen → KI-Anbieter (BYOK) einen Anbieter verbinden' });
    expect(meta.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(['fal', 'kie', 'replicate', 'openai', 'gemini', 'stability', 'elevenlabs', 'runway', 'luma', 'custom_http']));
    const r = await create({ capability: 'image', prompt: 'Ein Hund' });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('Bitte zuerst unter Einstellungen → KI-Anbieter (BYOK) einen Anbieter verbinden');
    // registry present, but nothing connected for this sub-account
    t.app.services.aiConnections = registry;
    allowed = new Set();
    expect((await create({ capability: 'image', prompt: 'x' })).data.error).toContain('KI-Anbieter (BYOK)');
    expect((await t.api.get('/api/genmedia/connections?capability=video')).data).toMatchObject({ available: true, connections: [] });
  });

  it('lists connections per capability and validates input', async () => {
    const c = (await t.api.get('/api/genmedia/connections?capability=stt')).data.connections.map((x: any) => x.id);
    expect(c).toEqual(['c-fal', 'c-oai', 'c-http']);
    expect((await create({ capability: 'nope', prompt: 'x' })).status).toBe(400);
    expect((await create({ capability: 'image' })).data.error).toBe('Prompt fehlt');
    expect((await create({ capability: 'image', prompt: 'x', aspect_ratio: '5:7' })).status).toBe(400);
    expect((await create({ capability: 'image', prompt: 'x', params: '{kaputt' })).data.error).toContain('JSON');
    expect((await create({ capability: 'image', prompt: 'x', params: [1] })).status).toBe(400);
    expect((await create({ capability: 'image', prompt: 'x', model: 'a b' })).status).toBe(400);
    expect((await create({ capability: 'image', prompt: 'x', connection_id: 'c-kie', kie_task: { endpoint: 'https://evil.test/x' } })).status).toBe(400);
    expect((await create({ capability: 'stt', connection_id: 'c-oai' })).data.error).toContain('Audio');
    expect((await create({ capability: 'image', prompt: 'x', image_url: 'http://10.0.0.5/a.png' })).data.error).toContain('https');
  });
});

describe('fal.ai', () => {
  const falRoutes = (resultUrl = 'https://v3.fal.media/files/out.png') => [
    (u: URL, c: Call) => (u.host === 'queue.fal.run' && c.method === 'POST' && u.pathname === '/fal-ai/flux/dev' ? json({ request_id: 'req-1', status_url: 'https://queue.fal.run/fal-ai/flux/requests/req-1/status', response_url: 'https://queue.fal.run/fal-ai/flux/requests/req-1' }) : undefined),
    (u: URL) => (u.pathname === '/fal-ai/flux/requests/req-1/status' ? json({ status: 'COMPLETED', metrics: { inference_time: 3.4 } }) : undefined),
    (u: URL) => (u.pathname === '/fal-ai/flux/requests/req-1' ? json({ images: [{ url: resultUrl, content_type: 'image/png' }], seed: 7 }) : undefined),
    (u: URL) => (u.host === 'v3.fal.media' ? file(PNG, 'image/png') : undefined),
  ];

  it('runs the queue flow: submit, status, result, download', async () => {
    routes = falRoutes();
    const r = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'Ein roter Fuchs', aspect_ratio: '16:9', seed: 42, params: { num_inference_steps: 12 } });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'queued', provider: 'fal', model: 'fal-ai/flux/dev', capability: 'image' });
    await svc().idle();
    const submit = last('/fal-ai/flux/dev')!;
    expect(submit.headers.authorization).toBe('Key fal-key');
    expect(submit.url).not.toContain('fal_webhook'); // http://localhost is not reachable for fal
    expect(submit.body).toEqual({ prompt: 'Ein roter Fuchs', seed: 42, image_size: 'landscape_16_9', num_inference_steps: 12 });
    expect(t.app.db.get('SELECT status FROM genmedia_jobs WHERE id = ?', r.data.id).status).toBe('running');
    const done = await settle(r.data.id);
    expect(done.status).toBe('succeeded');
    expect(done.results).toHaveLength(1);
    expect(done.results[0]).toMatchObject({ mime: 'image/png', kind: 'image', size: PNG.length });
    expect(done.cost_text).toBe('3,4 s Rechenzeit');
    expect(JSON.stringify(done)).not.toContain('fal-key');
    // The stored file is served (with ranges, for video seeking).
    const path = new URL(done.results[0].url).pathname;
    const f = await t.api.raw(path);
    expect(f.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await f.arrayBuffer()).equals(PNG)).toBe(true);
    const part = await t.api.raw(path, { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).toString('latin1')).toBe('\x89PNG');
    expect((await t.api.raw('/genmedia/f/AAAAAAAAAAAAAAAAAAAAAAAA.png')).status).toBe(404);
  });

  it('accepts a signed webhook and refuses forged ones', async () => {
    t.app.config.baseUrl = 'https://gh.example.com';
    resetFalJwks();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as any;
    routes = [...falRoutes(), (u: URL) => (u.host === 'rest.fal.ai' ? json({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: jwk.x }] }) : undefined)];
    const r = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'Webhook-Test' });
    await svc().idle();
    const hook = new URL(last('/fal-ai/flux/dev')!.url).searchParams.get('fal_webhook')!;
    expect(hook).toMatch(/^https:\/\/gh\.example\.com\/hooks\/genmedia\/[\w-]{30,}$/);
    const path = new URL(hook).pathname;
    const body = JSON.stringify({ request_id: 'req-1', gateway_request_id: 'req-1', status: 'OK', payload: { images: [{ url: 'https://v3.fal.media/files/hook.png' }] } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(null, falMessage('req-1', 'user-1', ts, body), privateKey).toString('hex');
    const headers = { 'content-type': 'application/json', 'x-fal-webhook-request-id': 'req-1', 'x-fal-webhook-user-id': 'user-1', 'x-fal-webhook-timestamp': ts };
    // forged signature → 401, nothing changes
    const bad = await t.api.raw(path, { method: 'POST', headers: { ...headers, 'x-fal-webhook-signature': 'ab'.repeat(64) }, body });
    expect(bad.status).toBe(401);
    expect((await t.api.raw('/hooks/genmedia/unknown-token-unknown-token', { method: 'POST', headers, body })).status).toBe(404);
    calls.length = 0;
    const ok = await t.api.raw(path, { method: 'POST', headers: { ...headers, 'x-fal-webhook-signature': sig }, body });
    expect(ok.status).toBe(200);
    await svc().idle();
    const j = (await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).data;
    expect(j.status).toBe('succeeded');
    // the signed payload was used – no status poll needed
    expect(calls.some((c) => c.url.includes('/status'))).toBe(false);
    expect(calls.some((c) => c.url === 'https://v3.fal.media/files/hook.png')).toBe(true);
  });

  it('turns an unsigned callback into an immediate poll', async () => {
    t.app.config.baseUrl = 'https://gh.example.com';
    routes = falRoutes();
    const r = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'ohne Signatur' });
    await svc().idle();
    const path = new URL(new URL(last('/fal-ai/flux/dev')!.url).searchParams.get('fal_webhook')!).pathname;
    // A forged payload without signature is ignored – we ask fal ourselves.
    await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request_id: 'req-1', status: 'OK', payload: { images: [{ url: 'https://evil.test/x.png' }] } }) });
    await svc().idle();
    const j = (await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).data;
    expect(j.status).toBe('succeeded');
    expect(calls.some((c) => c.url.includes('evil.test'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/status'))).toBe(true);
  });
});

describe('kie.ai', () => {
  it('creates a market task, takes the callback and polls the record', async () => {
    t.app.config.baseUrl = 'https://gh.example.com';
    let state = 'generating';
    routes = [
      (u: URL, c: Call) => (u.pathname === '/api/v1/jobs/createTask' && c.method === 'POST' ? json({ code: 200, msg: 'success', data: { taskId: 'task-9' } }) : undefined),
      (u: URL) =>
        u.pathname === '/api/v1/jobs/recordInfo'
          ? json({ code: 200, msg: 'success', data: { taskId: 'task-9', state, resultJson: state === 'success' ? JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/v/out.mp4'] }) : '', creditsConsumed: state === 'success' ? 60 : undefined } })
          : undefined,
      (u: URL) => (u.host === 'tempfile.aiquickdraw.com' ? file(MP4, 'video/mp4') : undefined),
    ];
    const r = await create({ capability: 'video', connection_id: 'c-kie', model: 'veo-3-1', prompt: 'Drohnenflug über Berge', aspect_ratio: '16:9', duration: 8 });
    await svc().idle();
    const sub = last('/api/v1/jobs/createTask')!;
    expect(sub.headers.authorization).toBe('Bearer kie-key');
    expect(sub.body).toMatchObject({ model: 'veo-3-1', input: { prompt: 'Drohnenflug über Berge', aspect_ratio: '16:9', duration: 8 } });
    const cb = new URL(sub.body.callBackUrl);
    expect(cb.origin).toBe('https://gh.example.com');
    // callback while still generating: we poll, the job keeps running
    await t.api.raw(cb.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 200, data: { taskId: 'task-9' } }) });
    await svc().idle();
    expect(last('/api/v1/jobs/recordInfo')!.url).toContain('taskId=task-9');
    expect((await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).data.status).toBe('running');
    state = 'success';
    await t.api.raw(cb.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 200, data: { taskId: 'task-9' } }) });
    await svc().idle();
    const j = (await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).data;
    expect(j).toMatchObject({ status: 'succeeded', cost: { amount: 60, unit: 'Credits' } });
    expect(j.results[0].mime).toBe('video/mp4');
  });

  it('maps popular models to their own endpoints and runs a generic kie task', async () => {
    routes = [
      (u: URL) => (u.pathname === '/api/v1/veo/generate' ? json({ code: 200, data: { taskId: 'veo-1' } }) : undefined),
      (u: URL) => (u.pathname === '/api/v1/veo/record-info' ? json({ code: 200, data: { taskId: 'veo-1', successFlag: 1, response: { resultUrls: ['https://cdn.kie.test/a.mp4'] } } }) : undefined),
      (u: URL) => (u.pathname === '/api/v1/flux/kontext/generate' ? json({ code: 200, data: { taskId: 'fk-1' } }) : undefined),
      (u: URL) => (u.pathname === '/api/v1/flux/kontext/record-info' ? json({ code: 200, data: { successFlag: 1, response: { resultImageUrl: 'https://cdn.kie.test/b.png' } } }) : undefined),
      (u: URL) => (u.pathname === '/api/v1/jobs/createTask' ? json({ code: 402, msg: 'Credits insufficient' }) : undefined),
      (u: URL) => (u.pathname.endsWith('.mp4') ? file(MP4, 'video/mp4') : u.pathname.endsWith('.png') ? file(PNG, 'image/png') : undefined),
    ];
    const veo = await create({ capability: 'video', connection_id: 'c-kie', model: 'veo3_fast', prompt: 'Katze', aspect_ratio: '9:16' });
    expect((await settle(veo.data.id)).status).toBe('succeeded');
    expect(last('/api/v1/veo/generate')!.body).toMatchObject({ prompt: 'Katze', model: 'veo3_fast', aspectRatio: '9:16' });
    const task = await create({ capability: 'image', connection_id: 'c-kie', prompt: 'egal', kie_task: { endpoint: '/api/v1/flux/kontext/generate', body: { prompt: 'Logo', model: 'flux-kontext-max' } } });
    const tj = await settle(task.data.id);
    expect(tj.status).toBe('succeeded');
    expect(last('/api/v1/flux/kontext/generate')!.body).toMatchObject({ prompt: 'Logo', model: 'flux-kontext-max' });
    expect(last('/api/v1/flux/kontext/record-info')!.url).toContain('taskId=fk-1');
    // kie's own error codes come through in German context
    const broke = await create({ capability: 'image', connection_id: 'c-kie', model: 'google/nano-banana', prompt: 'x' });
    const bj = await settle(broke.data.id);
    expect(bj.status).toBe('failed');
    expect(bj.error).toContain('Guthaben aufladen');
  });

  it('reads the record shapes of the different kie APIs', () => {
    const ctx: any = { capability: 'audio_music' };
    expect(kieRecord(ctx, { status: 'SUCCESS', response: { sunoData: [{ audioUrl: 'https://x.test/1.mp3' }, { audio_url: 'https://x.test/2.mp3' }] } })).toMatchObject({ status: 'done', outputs: [{ url: 'https://x.test/1.mp3' }, { url: 'https://x.test/2.mp3' }] });
    expect(kieRecord({ capability: 'video' } as any, { state: 'success', videoInfo: { videoUrl: 'https://x.test/v.mp4' } })).toMatchObject({ status: 'done' });
    expect(kieRecord(ctx, { status: 'GENERATE_AUDIO_FAILED', errorMessage: 'nope' })).toMatchObject({ status: 'failed' });
    expect(kieRecord(ctx, { successFlag: 0 }).status).toBe('pending');
    expect(kieRecord({ capability: 'image' } as any, { successFlag: 1, resultInfoJson: { resultUrls: [{ resultUrl: 'https://x.test/mj.png' }] } })).toMatchObject({ status: 'done', outputs: [{ url: 'https://x.test/mj.png' }] });
  });
});

describe('Replicate', () => {
  it('polls a prediction and downloads with the token only from its own hosts', async () => {
    let status = 'starting';
    routes = [
      (u: URL, c: Call) => (u.pathname === '/v1/models/black-forest-labs/flux-schnell/predictions' && c.method === 'POST' ? json({ id: 'p1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } }, 201) : undefined),
      (u: URL) => (u.pathname === '/v1/predictions/p1' ? json({ id: 'p1', status, output: status === 'succeeded' ? ['https://replicate.delivery/xezq/out.webp'] : null, metrics: { predict_time: 1.25 } }) : undefined),
      (u: URL) => (u.host === 'replicate.delivery' ? file(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]), 'image/webp') : undefined),
    ];
    const r = await create({ capability: 'image', connection_id: 'c-rep', model: 'black-forest-labs/flux-schnell', prompt: 'Leuchtturm', aspect_ratio: '1:1' });
    await svc().idle();
    expect(last('/predictions')!.body).toEqual({ input: { prompt: 'Leuchtturm', aspect_ratio: '1:1' } });
    let j = await settle(r.data.id, 1);
    expect(j.status).toBe('running');
    status = 'succeeded';
    j = await settle(r.data.id);
    expect(j).toMatchObject({ status: 'succeeded', cost: { note: '1,3 s Rechenzeit (GPU)' } });
    expect(j.results[0].mime).toBe('image/webp');
    expect(last('replicate.delivery')!.headers.authorization).toBe('Bearer r8-key');
    // versioned models go to /v1/predictions with "version"
    routes.unshift((u: URL, c: Call) => (u.pathname === '/v1/predictions' && c.method === 'POST' ? json({ id: 'p1', status: 'starting' }) : undefined));
    await create({ capability: 'image', connection_id: 'c-rep', model: 'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b', prompt: 'x' });
    await svc().idle();
    expect(last('/v1/predictions')!.body.version).toContain('stability-ai/sdxl:');
  });

  it('verifies signed webhooks', async () => {
    t.app.config.baseUrl = 'https://gh.example.com';
    resetReplicateSecrets();
    const secret = `whsec_${Buffer.from('replicate-secret-bytes').toString('base64')}`;
    routes = [
      (u: URL, c: Call) => (u.pathname.endsWith('/predictions') && c.method === 'POST' ? json({ id: 'p2', status: 'starting' }) : undefined),
      (u: URL) => (u.pathname === '/v1/webhooks/default/secret' ? json({ key: secret }) : undefined),
      (u: URL) => (u.host === 'replicate.delivery' ? file(PNG, 'image/png') : undefined),
    ];
    const r = await create({ capability: 'image', connection_id: 'c-rep', model: 'google/nano-banana', prompt: 'Signiert' });
    await svc().idle();
    const hook = new URL(last('/predictions')!.body.webhook).pathname;
    const body = JSON.stringify({ id: 'p2', status: 'succeeded', output: 'https://replicate.delivery/a.png' });
    const ts = String(Math.floor(Date.now() / 1000));
    const good = replicateSignature(secret, 'msg_1', ts, body);
    expect((await t.api.raw(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': 'v1,AAAA' }, body })).status).toBe(401);
    expect((await t.api.raw(hook, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${good}` }, body })).status).toBe(200);
    await svc().idle();
    expect((await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).data.status).toBe('succeeded');
  });
});

describe('OpenAI', () => {
  it('generates images, speech and transcripts', async () => {
    routes = [
      (u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }], usage: { total_tokens: 1200 } }) : undefined),
      (u: URL) => (u.pathname === '/v1/audio/speech' ? file(MP3, 'audio/mpeg') : undefined),
      (u: URL) => (u.pathname === '/v1/audio/transcriptions' ? json({ text: 'Hallo Welt' }) : undefined),
    ];
    const img = await create({ capability: 'image', connection_id: 'c-oai', model: 'gpt-image-1', prompt: 'Logo', aspect_ratio: '9:16' });
    const ij = await settle(img.data.id);
    expect(ij).toMatchObject({ status: 'succeeded', cost: { amount: 1200, unit: 'Tokens' } });
    expect(last('/images/generations')!.body).toMatchObject({ model: 'gpt-image-1', prompt: 'Logo', size: '1024x1536', n: 1 });
    expect(last('/images/generations')!.headers.authorization).toBe('Bearer sk-test');

    const tts = await create({ capability: 'audio_tts', connection_id: 'c-oai', prompt: 'Willkommen bei uns!', voice: 'nova' });
    const tj = await settle(tts.data.id);
    expect(tj.status).toBe('succeeded');
    expect(tj.results[0].mime).toBe('audio/mpeg');
    expect(last('/audio/speech')!.body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Willkommen bei uns!', voice: 'nova', response_format: 'mp3' });

    // upload the recording (raw bytes), then transcribe it
    const up = await t.api.raw('/api/genmedia/inputs?name=memo.mp3', { method: 'POST', headers: { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': locA, 'content-type': 'audio/mpeg' }, body: MP3 });
    expect(up.status).toBe(200);
    const inp = await up.json();
    expect(inp).toMatchObject({ mime: 'audio/mpeg', name: 'memo.mp3' });
    const stt = await create({ capability: 'stt', connection_id: 'c-oai', model: 'whisper-1', audio_file: inp.file, language: 'de' });
    const sj = await settle(stt.data.id);
    expect(sj).toMatchObject({ status: 'succeeded', text: 'Hallo Welt' });
    const mp = last('/audio/transcriptions')!;
    expect(mp.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const raw = Buffer.from(mp.raw).toString('latin1');
    expect(raw).toContain('name="model"\r\n\r\nwhisper-1');
    expect(raw).toContain('filename="memo.mp3"');
    // an HTML file is not accepted as input
    const evil = await t.api.raw('/api/genmedia/inputs?name=x.mp3', { method: 'POST', headers: { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': locA }, body: '<html><script>1</script></html>' });
    expect(evil.status).toBe(400);
  });
});

describe('Gemini', () => {
  it('runs Veo as a long-running operation and downloads with the key', async () => {
    let done = false;
    routes = [
      (u: URL) => (u.pathname === '/v1beta/models/veo-3.1-generate-preview:predictLongRunning' ? json({ name: 'models/veo-3.1-generate-preview/operations/op123' }) : undefined),
      (u: URL) => (u.pathname === '/v1beta/models/veo-3.1-generate-preview/operations/op123' ? json(done ? { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media' } }] } } } : { name: 'x', done: false }) : undefined),
      (u: URL) => (u.pathname === '/v1beta/files/abc:download' ? file(MP4, 'video/mp4') : undefined),
    ];
    const r = await create({ capability: 'video', connection_id: 'c-gem', model: 'veo-3.1-generate-preview', prompt: 'Ein Bäcker knetet Teig', aspect_ratio: '9:16', negative_prompt: 'Text', duration: 8 });
    await svc().idle();
    const sub = last(':predictLongRunning')!;
    expect(sub.headers['x-goog-api-key']).toBe('AIza-test');
    expect(sub.body).toEqual({ instances: [{ prompt: 'Ein Bäcker knetet Teig' }], parameters: { aspectRatio: '9:16', negativePrompt: 'Text', durationSeconds: 8 } });
    expect((await settle(r.data.id, 1)).status).toBe('running');
    done = true;
    const j = await settle(r.data.id);
    expect(j.status).toBe('succeeded');
    expect(last('files/abc:download')!.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('wraps raw PCM speech into WAV', async () => {
    const pcm = Buffer.alloc(480, 3);
    routes = [(u: URL) => (u.pathname.endsWith(':generateContent') ? json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] }) : undefined)];
    const r = await create({ capability: 'audio_tts', connection_id: 'c-gem', model: 'gemini-2.5-flash-preview-tts', prompt: 'Guten Tag', voice: 'Puck' });
    const j = await settle(r.data.id);
    expect(j.status).toBe('succeeded');
    expect(j.results[0].mime).toBe('audio/wav');
    expect(last(':generateContent')!.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck');
    expect(sniff(pcmToWav(pcm))).toBe('audio/wav');
  });
});

describe('custom HTTP template', () => {
  it('renders the template, polls and takes the result path', async () => {
    const bad = await t.api.post('/api/genmedia/templates', { name: 'X', capability: 'image', config: { url: 'ftp://x', result_path: 'a' } });
    expect(bad.status).toBe(400);
    expect((await t.api.post('/api/genmedia/templates', { name: 'X', capability: 'image', config: { url: '/v1/gen', body: '{"a": {{prompt}', result_path: 'a' } })).status).toBe(400);
    const tpl = await t.api.post('/api/genmedia/templates', {
      name: 'Mein Bilddienst',
      capability: 'image',
      config: {
        url: '/v1/generate',
        method: 'POST',
        headers: { 'X-Client': 'gohigh' },
        body: '{"input": {"prompt": "{{prompt}}", "seed": "{{seed}}", "style": "{{params.style}}"}, "note": "Prompt: {{prompt}}"}',
        poll: { url: 'https://api.custom.test/v1/tasks/{{response.id}}', done_path: 'status', done_values: 'done, finished', fail_path: 'status', fail_values: ['failed'], error_path: 'error', interval_s: 2 },
        result_path: 'result.files[*].url',
      },
    });
    expect(tpl.status).toBe(200);
    let st = 'running';
    routes = [
      (u: URL, c: Call) => (u.host === 'api.custom.test' && u.pathname === '/v1/generate' && c.method === 'POST' ? json({ id: 'job-77' }) : undefined),
      (u: URL) => (u.pathname === '/v1/tasks/job-77' ? json({ status: st, result: { files: [{ url: 'https://files.custom.test/1.png' }] } }) : undefined),
      (u: URL) => (u.host === 'files.custom.test' ? file(PNG, 'image/png') : undefined),
    ];
    const r = await create({ capability: 'image', connection_id: 'c-http', prompt: 'Sag "Hallo"', seed: 5, params: { style: 'comic' }, template_id: tpl.data.id });
    await svc().idle();
    const sub = last('/v1/generate')!;
    expect(sub.headers['x-api-key']).toBe('cust-key');
    expect(sub.headers['x-client']).toBe('gohigh');
    expect(sub.body).toEqual({ input: { prompt: 'Sag "Hallo"', seed: 5, style: 'comic' }, note: 'Prompt: Sag "Hallo"' });
    expect((await settle(r.data.id, 1)).status).toBe('running');
    st = 'Finished';
    const j = await settle(r.data.id);
    expect(j.status).toBe('succeeded');
    expect(j.results[0].mime).toBe('image/png');
  });

  it('has a small JSON path and a type-keeping JSON renderer', () => {
    expect(pathGet({ a: [{ u: 1 }, { u: 2 }] }, 'a[*].u')).toEqual([1, 2]);
    expect(pathGet({ data: { url: 'x' } }, '$.data.url')).toEqual(['x']);
    expect(renderJson('{"n": {{seed}}, "s": "{{seed}}", "t": "a {{prompt}}", "p": "{{params}}"}', { seed: 3, prompt: 'x"y', params: { k: 1 } })).toEqual({ n: 3, s: 3, t: 'a x"y', p: { k: 1 } });
    expect(renderJson('{"x": "{{missing}}"}', {})).toEqual({ x: null });
    expect(() => renderJson('{"k": "{{api_key}}"}', {})).toThrow(/api_key/);
  });
});

describe('storage, library and SSRF guard', () => {
  it('copies results into the media library once', async () => {
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const r = await create({ capability: 'image', connection_id: 'c-oai', prompt: 'Bibliothek' });
    const j = await settle(r.data.id);
    const lib = await t.api.post(`/api/genmedia/jobs/${j.id}/library`, {});
    expect(lib.status).toBe(200);
    const up = lib.data.uploads[0];
    expect(up.url).toMatch(/^http:\/\/localhost\/uploads\//);
    const again = await t.api.post(`/api/genmedia/jobs/${j.id}/library`, { index: 0 });
    expect(again.data.uploads[0].id).toBe(up.id);
    const list = (await t.api.get('/api/uploads')).data;
    expect(list.filter((u: any) => u.id === up.id)).toHaveLength(1);
    const served = await t.api.raw(new URL(up.url).pathname);
    expect(served.headers.get('content-type')).toBe('image/png');
    // deleting the job keeps the library copy
    expect((await t.api.del(`/api/genmedia/jobs/${j.id}`)).status).toBe(200);
    expect((await t.api.raw(new URL(up.url).pathname)).status).toBe(200);
    expect((await t.api.raw(new URL(j.results[0].url).pathname)).status).toBe(404);
  });

  it('rejects results that are not media files', async () => {
    routes = [
      (u: URL) => (u.pathname === '/fal-ai/flux/dev' ? json({ request_id: 'req-h', status_url: 'https://queue.fal.run/fal-ai/flux/requests/req-h/status', response_url: 'https://queue.fal.run/fal-ai/flux/requests/req-h' }) : undefined),
      (u: URL) => (u.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : undefined),
      (u: URL) => (u.pathname === '/fal-ai/flux/requests/req-h' ? json({ images: [{ url: 'https://v3.fal.media/files/fake.png' }] }) : undefined),
      (u: URL) => (u.host === 'v3.fal.media' ? new Response('<svg onload=alert(1)>', { headers: { 'content-type': 'image/png' } }) : undefined),
    ];
    const r = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'x' });
    const j = await settle(r.data.id);
    expect(j.status).toBe('failed');
    expect(j.error).toBe('Ergebnis hat ein unerwartetes Format');
  });

  it('blocks result URLs in private networks, allows provider CDNs', async () => {
    for (const bad of ['http://127.0.0.1/x.png', 'http://169.254.169.254/latest/meta-data', 'http://localhost:8080/a.png', 'http://[::1]/a.png', 'http://10.1.2.3/a.png', 'http://metadata.google.internal/x', 'file:///etc/passwd', 'https://user:pw@v3.fal.media/x.png']) {
      expect(() => checkUrl(bad), bad).toThrow();
    }
    for (const ok of ['https://v3.fal.media/files/a.png', 'https://replicate.delivery/x/y.webp', 'https://tempfile.aiquickdraw.com/v/a.mp4', 'https://generativelanguage.googleapis.com/v1beta/files/a:download']) expect(() => checkUrl(ok)).not.toThrow();
    routes = [
      (u: URL) => (u.pathname === '/fal-ai/flux/dev' ? json({ request_id: 'req-s', status_url: 'https://queue.fal.run/fal-ai/flux/requests/req-s/status', response_url: 'https://queue.fal.run/fal-ai/flux/requests/req-s' }) : undefined),
      (u: URL) => (u.pathname.endsWith('/status') ? json({ status: 'COMPLETED' }) : undefined),
      (u: URL) => (u.pathname === '/fal-ai/flux/requests/req-s' ? json({ images: [{ url: 'http://169.254.169.254/latest/meta-data/iam.png' }] }) : undefined),
    ];
    const r = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'ssrf' });
    const j = await settle(r.data.id);
    expect(j.status).toBe('failed');
    expect(j.error).toContain('internen Netz');
    expect(calls.some((c) => c.url.includes('169.254'))).toBe(false);
  });

  it('retries transient poll errors and times out', async () => {
    let fails = 1;
    routes = [
      (u: URL) => (u.pathname === '/fal-ai/flux/dev' ? json({ request_id: 'req-r', status_url: 'https://queue.fal.run/fal-ai/flux/requests/req-r/status', response_url: 'https://queue.fal.run/fal-ai/flux/requests/req-r' }) : undefined),
      (u: URL) => (u.pathname.endsWith('/status') ? (fails-- > 0 ? json({ detail: 'busy' }, 503) : json({ status: 'IN_PROGRESS' })) : undefined),
    ];
    const r = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'retry' });
    const j = await settle(r.data.id, 1);
    expect(j.status).toBe('running');
    expect(t.app.db.get('SELECT attempts FROM genmedia_jobs WHERE id = ?', r.data.id).attempts).toBe(1);
    t.app.db.run('UPDATE genmedia_jobs SET timeout_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.data.id);
    const late = await settle(r.data.id, 1);
    expect(late).toMatchObject({ status: 'failed' });
    expect(late.error).toContain('Zeitüberschreitung');
  });

  it('re-runs, makes variations and cancels', async () => {
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const r = await create({ capability: 'image', connection_id: 'c-oai', prompt: 'Original', seed: 11 });
    await settle(r.data.id);
    const again = await t.api.post(`/api/genmedia/jobs/${r.data.id}/rerun`, {});
    expect(again.data).toMatchObject({ parent_id: r.data.id, input: { seed: 11, prompt: 'Original' } });
    const vari = await t.api.post(`/api/genmedia/jobs/${r.data.id}/rerun`, { variation: true });
    expect(vari.data.input.seed).not.toBe(11);
    await svc().idle();
    routes = [(u: URL) => (u.pathname === '/fal-ai/flux/dev' ? json({ request_id: 'req-c' }) : undefined), (u: URL) => (u.pathname.includes('/cancel') ? json({ status: 'CANCELLATION_REQUESTED' }, 202) : undefined)];
    const run = await create({ capability: 'image', connection_id: 'c-fal', model: 'fal-ai/flux/dev', prompt: 'abbrechen' });
    await svc().idle();
    expect((await t.api.del(`/api/genmedia/jobs/${run.data.id}`)).status).toBe(400);
    const c = await t.api.post(`/api/genmedia/jobs/${run.data.id}/cancel`, {});
    expect(c.data.status).toBe('canceled');
    expect(last('/cancel')!.url).toBe('https://queue.fal.run/fal-ai/flux/requests/req-c/cancel');
  });
});

describe('scoping', () => {
  it('keeps jobs, files and templates inside their sub-account', async () => {
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const r = await create({ capability: 'image', connection_id: 'c-oai', prompt: 'Nur für A' });
    await settle(r.data.id);
    // B has no connection: same message as without any provider
    t.api.setLocation(locB);
    expect((await create({ capability: 'image', prompt: 'x' })).data.error).toContain('KI-Anbieter (BYOK)');
    expect((await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).status).toBe(404);
    expect((await t.api.post(`/api/genmedia/jobs/${r.data.id}/library`, {})).status).toBe(404);
    expect((await t.api.get('/api/genmedia/jobs')).data.find((j: any) => j.id === r.data.id)).toBeUndefined();
    t.api.setLocation(locA);
    // a client login of B can't read A, and needs a content area at all
    await t.api.post('/api/users', { email: 'b@kunde.de', name: 'B', password: 'geheim1234', role: 'member', locations: [locB], permissions: ['social'] });
    await t.api.post('/api/users', { email: 'nur-kontakte@kunde.de', name: 'C', password: 'geheim1234', role: 'member', locations: [locA], permissions: ['contacts'] });
    const admin = t.api.cookie;
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'b@kunde.de', password: 'geheim1234' });
    expect((await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).status).toBe(403);
    t.api.setLocation(locB);
    expect((await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).status).toBe(404);
    expect((await t.api.get('/api/genmedia/meta')).status).toBe(200);
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'nur-kontakte@kunde.de', password: 'geheim1234' });
    t.api.setLocation(locA);
    expect((await t.api.get('/api/genmedia/meta')).status).toBe(403);
    expect((await t.api.get(`/api/genmedia/jobs/${r.data.id}`)).status).toBe(403);
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    expect(t.api.cookie).not.toBe('');
    void admin;
  });
});

describe('workflow actions', () => {
  it('generates an image into a custom field and a note on the contact', async () => {
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const c = (await t.api.post('/api/contacts', { first_name: 'Mia', email: 'mia@example.com' })).data;
    const act = t.app.services.workflowActions;
    expect(Object.keys(act)).toEqual(expect.arrayContaining(['genmedia_image', 'genmedia_video', 'genmedia_tts']));
    const out = await act.genmedia_image({ location_id: locA, contact_id: c.id }, { prompt: 'Porträt für {{contact.first_name}}', connection_id: 'c-oai', target: 'field', field: 'custom.ki_bild' }, { contact: { first_name: 'Mia' } });
    expect(out).toContain('eigenes Feld');
    const job = t.app.db.get(`SELECT id, input FROM genmedia_jobs WHERE source = 'workflow' ORDER BY created_at DESC LIMIT 1`);
    expect(JSON.parse(job.input).prompt).toBe('Porträt für Mia');
    const j = await settle(job.id);
    expect(j.status).toBe('succeeded');
    const custom = JSON.parse(t.app.db.get('SELECT custom FROM contacts WHERE id = ?', c.id).custom);
    expect(custom.ki_bild).toMatch(/^http:\/\/localhost\/uploads\//);
    expect(j.target_result).toContain('custom.ki_bild');
    // TTS as note ("attachment")
    routes = [(u: URL) => (u.pathname === '/v1/audio/speech' ? file(MP3, 'audio/mpeg') : undefined)];
    await act.genmedia_tts({ location_id: locA, contact_id: c.id }, { text: 'Hallo {{contact.first_name}}', connection_id: 'c-oai', voice: 'nova', target: 'note' }, { contact: { first_name: 'Mia' } });
    const tj = t.app.db.get(`SELECT id FROM genmedia_jobs WHERE capability = 'audio_tts' AND source = 'workflow' ORDER BY created_at DESC LIMIT 1`);
    await settle(tj.id);
    const note = t.app.db.get('SELECT body FROM notes WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1', c.id);
    expect(note.body).toContain('Text in Sprache');
    expect(note.body).toContain('/uploads/');
    // no connection → the action fails with the BYOK message (shown in the run log)
    allowed = new Set();
    await expect(act.genmedia_video({ location_id: locA, contact_id: c.id }, { prompt: 'x' }, {})).rejects.toThrow(/KI-Anbieter/);
  });
});

describe('MCP tools and the app API', () => {
  it('generates an image through MCP and reads the job', async () => {
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const key = (await t.api.post('/api/api-keys', { name: 'Agent' })).data.key;
    const rpc = async (body: any) => (await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }) })).json();
    const list = await rpc({ method: 'tools/list' });
    const names = list.result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_generate_image', 'ghl_generate_video', 'ghl_generate_audio', 'ghl_transcribe', 'ghl_get_media_job']));
    const res = await rpc({ method: 'tools/call', params: { name: 'ghl_generate_image', arguments: { prompt: 'Ein Logo mit Berg', connection_id: 'c-oai', wait_seconds: 10 } } });
    expect(res.result.isError).toBe(false);
    const out = res.result.structuredContent;
    expect(out).toMatchObject({ status: 'succeeded', capability: 'image', provider: 'openai' });
    expect(out.url).toMatch(/\/uploads\//);
    const got = await rpc({ method: 'tools/call', params: { name: 'ghl_get_media_job', arguments: { job_id: out.job_id } } });
    expect(got.result.structuredContent.status).toBe('succeeded');
    // a key of sub-account A can't reach B
    const other = await rpc({ method: 'tools/call', params: { name: 'ghl_generate_image', arguments: { location_id: locB, prompt: 'x' } } });
    expect(other.result.isError).toBe(true);
  });

  it('starts and reads jobs with the app token (ghm_…)', async () => {
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const tok = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel', platform: 'android' })).data.token;
    const h = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
    const r = await t.api.raw('/api/mobile/genmedia', { method: 'POST', headers: h, body: JSON.stringify({ location_id: locA, capability: 'image', prompt: 'Vom Handy', connection_id: 'c-oai' }) });
    expect(r.status).toBe(200);
    const job = await r.json();
    expect(job.source).toBe('mobile');
    await svc().idle();
    const g = await (await t.api.raw(`/api/mobile/genmedia/${job.id}`, { headers: h })).json();
    expect(g.status).toBe('succeeded');
    expect((await t.api.raw('/api/mobile/genmedia/does-not-exist', { headers: h })).status).toBe(404);
    expect((await t.api.raw('/api/mobile/genmedia', { method: 'POST', headers: h, body: JSON.stringify({ capability: 'image', prompt: 'x' }) })).status).toBe(400);
    // the app token works only under /api/mobile
    expect((await t.api.raw(`/api/genmedia/jobs/${job.id}`, { headers: { ...h, 'x-location-id': locA } })).status).toBe(403);
  });
});

describe('social planner hand-off', () => {
  it('turns a generated image into a draft post', async () => {
    const sent: any[] = [];
    setPostizFetch((async (input: any, init: any = {}) => {
      const path = new URL(String(input)).pathname.replace('/api/public/v1', '');
      const j = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/is-connected') return j({ connected: true });
      if (path === '/integrations') return j([{ id: 'int-x', name: 'Firma X', identifier: 'x', picture: '', disabled: false }]);
      if (path === '/upload-from-url') {
        sent.push({ upload: JSON.parse(init.body).url });
        return j({ id: 'm1', path: 'https://postiz.test/m1.png' });
      }
      if (path === '/posts' && init.method === 'POST') {
        const b = JSON.parse(init.body);
        sent.push(b);
        return j(b.posts.map((p: any, i: number) => ({ postId: `p${i}`, integration: p.integration.id })));
      }
      return j({ posts: [] });
    }) as unknown as typeof fetch);
    expect((await t.api.patch('/api/agency/social', { url: 'https://postiz.test', api_key: 'k' })).status).toBe(200);
    await t.api.put('/api/agency/social/channels/int-x', { location_id: locA });
    routes = [(u: URL) => (u.pathname === '/v1/images/generations' ? json({ data: [{ b64_json: PNG.toString('base64') }] }) : undefined)];
    const r = await create({ capability: 'image', connection_id: 'c-oai', prompt: 'Sommerangebot' });
    await settle(r.data.id);
    const p = await t.api.post(`/api/genmedia/jobs/${r.data.id}/social`, { integration_ids: ['int-x'], content: 'Neu bei uns!' });
    expect(p.status).toBe(200);
    expect(p.data).toMatchObject({ type: 'draft', content: 'Neu bei uns!' });
    expect(sent.find((x) => x.upload).upload).toMatch(/^http:\/\/localhost\/uploads\//);
    expect(sent.find((x) => x.posts).type).toBe('draft');
    // audio can't be posted
    routes = [(u: URL) => (u.pathname === '/v1/audio/speech' ? file(MP3, 'audio/mpeg') : undefined)];
    const a = await create({ capability: 'audio_tts', connection_id: 'c-oai', prompt: 'Hallo' });
    await settle(a.data.id);
    expect((await t.api.post(`/api/genmedia/jobs/${a.data.id}/social`, { integration_ids: ['int-x'], content: 'x' })).status).toBe(400);
  });
});

describe('media checks', () => {
  it('decides file types from the bytes', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(MP4)).toBe('video/mp4');
    expect(sniff(MP4, 'audio/mp4')).toBe('audio/mp4');
    expect(sniff(MP3)).toBe('audio/mpeg');
    expect(sniff(Buffer.from('<!doctype html><html>'))).toBe('');
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('');
    expect(createHmac('sha256', 'k').update('a').digest('hex')).toHaveLength(64);
  });
});
