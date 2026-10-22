import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { requiredPermission } from '../server/core/permissions.js';
import { MAX_STT_BYTES } from '../server/services/voice-engine.js';
import { cleanUserPrefs, cleanVoiceSettings, defaultVoiceSettings, withUserDefaults, withVoiceDefaults } from '../server/services/voice-settings.js';

/** The voice layer over HTTP: settings, voices, "Stimme testen", push-to-talk, prefs, MCP tools, the native app – with fake providers. */

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 2)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 5)]);
const KEY = 'sk-test-voice-key-1234567890';

type Seen = { url: string; method: string; headers: Record<string, string>; body: any; raw: any };
const seen: Seen[] = [];
let fail: { url: RegExp; status: number; body: unknown } | null = null;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fakeProvider = async (url: string, init: any = {}) => {
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
  seen.push({ url, method: init.method ?? 'GET', headers, body, raw: init.body });
  if (fail && fail.url.test(url)) return json(fail.body, fail.status);
  if (url.endsWith('/audio/speech')) return new Response(new Uint8Array(MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (url.endsWith('/audio/transcriptions')) return json({ text: ' Guten Tag, ich möchte einen Termin. ' });
  if (url.includes('api.elevenlabs.io/v2/voices')) return json({ voices: [{ voice_id: 'v-de', name: 'Anna', category: 'premade', labels: { language: 'de', gender: 'female' } }, { voice_id: 'v-en', name: 'Bob', category: 'premade', labels: { language: 'en' } }] });
  if (url.includes('api.elevenlabs.io/v1/text-to-speech')) return new Response(new Uint8Array(MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (url === 'https://files.example.com/voicemail.webm') return new Response(new Uint8Array(WEBM), { status: 200, headers: { 'content-type': 'audio/webm' } });
  return json({ error: `no route ${url}` }, 404);
};
const last = (part: string) => [...seen].reverse().find((c) => c.url.includes(part));
const count = (part: string) => seen.filter((c) => c.url.includes(part)).length;

let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
let locC = '';
const login = async (email: string, loc = locA) => {
  t.api.clearCookie();
  expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
  t.api.setLocation(loc);
};
const admin = () => login('chef@example.com');
const upload = (buf: Buffer, type = 'audio/webm', path = '/api/voice/transcribe') =>
  t.api.raw(path, { method: 'POST', headers: { 'content-type': type, 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': t.api.location }, body: buf });
const dataUrl = (buf: Buffer, type = 'audio/webm') => `data:${type};base64,${buf.toString('base64')}`;
let openaiId = '';
let elevenId = '';

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.genmediaFetch = fakeProvider;
  await t.setup();
  locA = t.api.location;
  locB = (await t.api.post('/api/locations', { name: 'Firma B' })).data.id;
  // Firma C has no speech provider at all.
  locC = (await t.api.post('/api/locations', { name: 'Firma C' })).data.id;
  await t.api.post('/api/users', { email: 'c@example.com', name: 'Carla', password: 'geheim123', role: 'member', locations: [locC], permissions: ['settings', 'conversations'] });
  await t.api.post('/api/users', { email: 'settings@example.com', name: 'Sabine', password: 'geheim123', role: 'member', locations: [locA], permissions: ['settings', 'conversations'] });
  await t.api.post('/api/users', { email: 'plain@example.com', name: 'Paul', password: 'geheim123', role: 'member', locations: [locA], permissions: ['contacts'] });
  await t.api.post('/api/users', { email: 'b@example.com', name: 'Bernd', password: 'geheim123', role: 'member', locations: [locB], permissions: ['settings'] });
  openaiId = (await t.api.post('/api/ai-connections', { provider: 'openai', api_key: KEY, capabilities: ['audio_tts', 'stt'], models: { audio_tts: 'gpt-4o-mini-tts', stt: 'gpt-4o-transcribe' } })).data.id;
  elevenId = (await t.api.post('/api/ai-connections', { provider: 'elevenlabs', api_key: 'el-key-1234567890', capabilities: ['audio_tts'] })).data.id;
}, 60_000);
afterAll(() => t.close());
beforeEach(async () => {
  seen.length = 0;
  fail = null;
  await admin();
});

describe('settings (pure)', () => {
  it('has safe defaults and drops what does not belong', () => {
    const d = defaultVoiceSettings();
    expect(d.phone).toMatchObject({ engine: 'twilio', transport: 'auto', barge_in: true, filler: true, endpoint_ms: 700 });
    expect(d.tts).toMatchObject({ language: 'de', speed: 1 });
    expect(withVoiceDefaults(null)).toEqual(d);
    expect(withVoiceDefaults({ phone: { engine: 'hack', transport: 'x', barge_in: 'ja', extra: 1 }, tts: 5, evil: true, voicemail_transcribe: 'true' })).toEqual(d);
    expect(withVoiceDefaults({ phone: { engine: 'own' }, voicemail_transcribe: true }).phone.engine).toBe('own');
  });

  it('validates a patch field by field', () => {
    const cur = defaultVoiceSettings();
    const ok = cleanVoiceSettings({ tts: { voice: 'Anna Müller (de)', speed: 1.256, language: 'de-DE', instructions: 'ruhig' }, phone: { engine: 'own', transport: 'turns', endpoint_ms: 900, barge_in: false, tts_ws: 'true' }, agent: { read_aloud: true }, call_summary: true }, cur);
    expect(ok.tts).toMatchObject({ voice: 'Anna Müller (de)', speed: 1.26, language: 'de-DE' });
    expect(ok.phone).toMatchObject({ engine: 'own', transport: 'turns', endpoint_ms: 900, barge_in: false, tts_ws: true });
    expect(ok.agent.read_aloud).toBe(true);
    expect(ok.call_summary).toBe(true);
    expect(cur.tts.speed).toBe(1); // the input is not changed
    for (const bad of [{ tts: { speed: 3 } }, { tts: { speed: 0.1 } }, { tts: { language: 'deutsch' } }, { tts: { voice: '<script>' } }, { tts: { model: 'a b' } }, { phone: { engine: 'x' } }, { phone: { transport: 'x' } }, { phone: { endpoint_ms: 100 } }, { phone: { endpoint_ms: 9000 } }, { tts: { instructions: 'x'.repeat(501) } }]) {
      expect(() => cleanVoiceSettings(bad, cur), JSON.stringify(bad)).toThrow();
    }
  });

  it('cleans personal preferences', () => {
    const p = cleanUserPrefs({ read_aloud: true, auto_send: null, voice: 'nova' }, withUserDefaults(null));
    expect(p).toEqual({ read_aloud: true, auto_send: null, voice: 'nova', connection_id: '' });
    expect(cleanUserPrefs({ read_aloud: null }, p).read_aloud).toBeNull();
    expect(() => cleanUserPrefs({ voice: '<x>' }, p)).toThrow();
    expect(withUserDefaults({ read_aloud: 'ja', voice: 5 })).toEqual(withUserDefaults(null));
  });

  it('puts setup behind the settings area and leaves push-to-talk and spoken replies open', () => {
    for (const p of ['/api/voice/settings', '/api/voice/voices', '/api/voice/test', '/api/voice/latency']) expect(requiredPermission('GET', p), p).toBe('settings');
    for (const p of ['/api/voice/transcribe', '/api/voice/speak', '/api/voice/prefs', '/api/voice/transcribe-url']) expect(requiredPermission('POST', p), p).toBeUndefined();
  });
});

describe('settings API', () => {
  it('shows the defaults, the connections that can speak and listen and what the next call uses', async () => {
    const r = (await t.api.get('/api/voice/settings')).data;
    expect(r.settings).toEqual(defaultVoiceSettings());
    expect(r.connections.tts.map((c: any) => c.id)).toEqual(expect.arrayContaining([openaiId, elevenId]));
    expect(r.connections.stt.map((c: any) => c.id)).toEqual([openaiId]);
    expect(r.connections.tts.find((c: any) => c.id === elevenId)).toMatchObject({ provider: 'elevenlabs', live: true, stream: 'native', key_set: true });
    expect(r.connections.stt[0]).toMatchObject({ provider: 'openai', live: false, stream: 'batch' });
    expect(r.routed.tts).toMatchObject({ provider: 'openai' });
    expect(r.routed.stt).toMatchObject({ provider: 'openai' });
    expect(r.phone.plan).toMatchObject({ engine: 'twilio', transport: 'twilio', problems: [] });
    expect(r.phone.twilio_ready).toBe(false);
    expect(r.usage).toMatchObject({ tts_calls: 0, stt_calls: 0 });
    expect(r.limits).toMatchObject({ max_tts_chars: 4000, max_stt_mb: 15 });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('saves a patch, keeps the rest and plans the phone transport from it', async () => {
    const put = await t.api.put('/api/voice/settings', { tts: { connection_id: elevenId, voice: 'v-de', speed: 1.1 }, phone: { engine: 'own', transport: 'stream' }, voicemail_transcribe: true });
    expect(put.status).toBe(200);
    expect(put.data.settings).toMatchObject({ tts: { connection_id: elevenId, voice: 'v-de', speed: 1.1, language: 'de' }, phone: { engine: 'own', transport: 'stream', barge_in: true }, voicemail_transcribe: true });
    expect(put.data.phone.plan).toMatchObject({ engine: 'own', transport: 'stream', tts: { provider: 'elevenlabs', stream: 'native' }, stt: { provider: 'openai', live: false } });
    // not public https in tests: the plan warns, the call still tries
    expect(put.data.phone.plan.problems.join(' ')).toMatch(/https/);
    expect((await t.api.put('/api/voice/settings', { agent: { read_aloud: true } })).data.settings).toMatchObject({ tts: { voice: 'v-de' }, agent: { read_aloud: true } });
    // an explicit phone transport that the provider cannot do is replaced
    const turns = (await t.api.put('/api/voice/settings', { tts: { connection_id: openaiId }, phone: { engine: 'own', transport: 'auto' } })).data;
    expect(turns.phone.plan).toMatchObject({ engine: 'own', transport: 'turns', tts: { provider: 'openai', stream: 'native' } });
    await t.api.put('/api/voice/settings', { tts: { connection_id: '' }, phone: { engine: 'twilio' }, agent: { read_aloud: false }, voicemail_transcribe: false });
  });

  it('refuses invalid values and connections that are not usable here', async () => {
    for (const body of [{ tts: { speed: 9 } }, { phone: { engine: 'x' } }, { tts: { language: '??' } }]) expect((await t.api.put('/api/voice/settings', body)).status).toBe(400);
    expect((await t.api.put('/api/voice/settings', { tts: { connection_id: 'aic_gibtesnicht' } })).status).toBe(400);
    // a connection that cannot transcribe is no speech recognizer; one of another sub-account is unknown
    expect((await t.api.put('/api/voice/settings', { stt: { connection_id: elevenId } })).status).toBe(400);
    await login('b@example.com', locB);
    const bConn = (await t.api.post('/api/ai-connections', { provider: 'openai', api_key: 'sk-b-key-0987654321', capabilities: ['audio_tts', 'stt'] })).data.id;
    await admin();
    const r = await t.api.put('/api/voice/settings', { tts: { connection_id: bConn } });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/gibt es nicht/);
    expect((await t.api.get('/api/voice/settings')).data.settings.tts.connection_id).toBe('');
  });

  it('keeps sub-accounts apart and limits setup to people with the settings area', async () => {
    await t.api.put('/api/voice/settings', { tts: { voice: 'nur-in-a' } });
    await login('b@example.com', locB);
    expect((await t.api.get('/api/voice/settings')).data.settings.tts.voice).toBe('');
    expect((await t.api.get('/api/voice/settings')).data.connections.tts.map((c: any) => c.id)).not.toContain(openaiId);
    await login('settings@example.com');
    expect((await t.api.get('/api/voice/settings')).status).toBe(200);
    expect((await t.api.put('/api/voice/settings', { tts: { voice: 'sabine' } })).status).toBe(200);
    await login('plain@example.com');
    for (const [m, p] of [['get', '/api/voice/settings'], ['get', '/api/voice/voices'], ['get', '/api/voice/latency'], ['put', '/api/voice/settings'], ['post', '/api/voice/test']] as const) {
      const r = m === 'get' ? await t.api.get(p) : m === 'put' ? await t.api.put(p, {}) : await t.api.post(p, {});
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    expect((await t.api.get('/api/voice/prefs')).status).toBe(200);
    await admin();
    await t.api.put('/api/voice/settings', { tts: { voice: '' } });
  });

  it('writes every change to the audit log', async () => {
    await t.api.put('/api/voice/settings', { tts: { speed: 1.05 } });
    const row = t.app.db.get<any>(`SELECT * FROM audit_log WHERE action = 'voice.settings.update' AND location_id = ? ORDER BY at DESC LIMIT 1`, locA);
    expect(row).toBeTruthy();
    await t.api.put('/api/voice/settings', { tts: { speed: 1 } });
  });
});

describe('voices', () => {
  it('lists the built-in voices of OpenAI and the live list of ElevenLabs by language, cached for a while', async () => {
    const oai = (await t.api.get('/api/voice/voices')).data;
    expect(oai.connection).toMatchObject({ id: openaiId, provider: 'openai' });
    expect(oai.voices.map((v: any) => v.id)).toEqual(expect.arrayContaining(['alloy', 'nova']));
    expect(oai.free_text).toBe(true);
    const el = (await t.api.get(`/api/voice/voices?connection_id=${elevenId}&language=de`)).data;
    expect(el.voices).toEqual([expect.objectContaining({ id: 'v-de', name: 'Anna', lang: 'de', gender: 'female' }), expect.objectContaining({ id: 'v-en' })]);
    const before = count('/v2/voices');
    await t.api.get(`/api/voice/voices?connection_id=${elevenId}&language=de`);
    expect(count('/v2/voices')).toBe(before);
    await t.api.get(`/api/voice/voices?connection_id=${elevenId}&language=de&refresh=1`);
    expect(count('/v2/voices')).toBe(before + 1);
  });

  it('refuses another sub-account\'s connection, explains provider errors', async () => {
    expect((await t.api.get('/api/voice/voices?connection_id=aic_fremd')).status).toBe(404);
    fail = { url: /v2\/voices/, status: 401, body: { detail: { message: 'invalid api key' } } };
    const r = await t.api.get(`/api/voice/voices?connection_id=${elevenId}&language=fr`);
    expect(r.status).toBe(502);
    expect(r.data.error).toMatch(/401/);
  });
});

describe('"Stimme testen"', () => {
  it('speaks the text with the saved voice, model and speed and returns playable audio – without leaking the key', async () => {
    await t.api.put('/api/voice/settings', { tts: { voice: 'nova', speed: 1.2, instructions: 'freundlich', language: 'de' } });
    const r = await t.api.post('/api/voice/test', { text: 'Hallo Welt' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova', chars: 10, mime: 'audio/mpeg', bytes: MP3.length });
    expect(r.data.audio).toBe(`data:audio/mpeg;base64,${MP3.toString('base64')}`);
    const call = last('/audio/speech')!;
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Hallo Welt', voice: 'nova', instructions: 'freundlich' });
    expect(JSON.stringify(r.data)).not.toContain(KEY);
    // explicit values win; another connection can be tried
    const el = await t.api.post('/api/voice/test', { text: 'Hi', connection_id: elevenId, voice: 'v-de' });
    expect(el.data).toMatchObject({ provider: 'elevenlabs', voice: 'v-de' });
    expect(last('text-to-speech/v-de')).toBeTruthy();
    // the default sentence
    expect((await t.api.post('/api/voice/test', {})).data.chars).toBeGreaterThan(20);
    await t.api.put('/api/voice/settings', { tts: { voice: '', speed: 1, instructions: '' } });
  });

  it('refuses long texts and strangers\' connections, and passes provider errors on readably', async () => {
    expect((await t.api.post('/api/voice/test', { text: 'x'.repeat(301) })).status).toBe(400);
    expect((await t.api.post('/api/voice/test', { text: 'Hi', connection_id: 'aic_fremd' })).status).toBe(404);
    fail = { url: /audio\/speech/, status: 402, body: { error: { message: 'insufficient_quota' } } };
    const r = await t.api.post('/api/voice/test', { text: 'Hi' });
    expect(r.status).toBe(502);
    expect(r.data.error).toMatch(/insufficient_quota.*402.*aufladen/);
  });

  it('says what to do when no provider can speak, and limits how often one person may try', async () => {
    await login('c@example.com', locC);
    const none = await t.api.post('/api/voice/test', { text: 'Hi' });
    expect(none.status).toBe(409);
    expect(none.data.error).toMatch(/Sprachausgabe fehlt ein Anbieter.*KI-Anbieter/);
    await admin();
    let limited = 0;
    for (let i = 0; i < 20; i++) if ((await t.api.post('/api/voice/test', { text: 'Hi' })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe('push-to-talk: speech to text', () => {
  it('transcribes a raw recording (the type comes from the bytes) and passes language and terms on', async () => {
    const r = await upload(WEBM, 'audio/webm;codecs=opus');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ text: 'Guten Tag, ich möchte einen Termin.', provider: 'openai', model: 'gpt-4o-transcribe' });
    const call = last('/audio/transcriptions')!;
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    const form = Buffer.from(call.raw).toString('latin1');
    expect(form).toContain('name="model"\r\n\r\ngpt-4o-transcribe');
    expect(form).toContain('name="language"\r\n\r\nde');
    expect(form).toContain('filename="aufnahme.webm"');
    expect(form).toContain('Content-Type: audio/webm');
    const q = await upload(WEBM, 'application/octet-stream', '/api/voice/transcribe?language=en&vocabulary=Dr.%20Sonne');
    expect(q.status).toBe(200);
    expect(Buffer.from(last('/audio/transcriptions')!.raw).toString('latin1')).toContain('name="language"\r\n\r\nen');
  });

  it('also takes JSON with a data URL (native app, API) and counts the usage', async () => {
    const before = (await t.api.get('/api/voice/settings')).data.usage.stt_calls;
    const r = await t.api.post('/api/voice/transcribe', { data: dataUrl(WEBM) });
    expect(r.status).toBe(200);
    expect(r.data.text).toContain('Termin');
    expect((await t.api.get('/api/voice/settings')).data.usage.stt_calls).toBe(before + 1);
    expect((await t.api.post('/api/voice/transcribe', { data: 'kein data url' })).status).toBe(400);
    expect((await t.api.post('/api/voice/transcribe', {})).status).toBe(400);
  });

  it('refuses what is not audio, empty uploads and recordings above the limit', async () => {
    const html = await upload(Buffer.from('<html><script>alert(1)</script></html>'), 'audio/webm');
    expect(html.status).toBe(400);
    expect((await html.json()).error).toMatch(/keine Audioaufnahme/);
    const png = await upload(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]), 'audio/webm');
    expect(png.status).toBe(400);
    expect((await upload(Buffer.alloc(0))).status).toBe(400);
    const big = await upload(Buffer.concat([WEBM, Buffer.alloc(MAX_STT_BYTES)]));
    expect(big.status).toBe(413);
    expect(count('/audio/transcriptions')).toBe(0);
    const bigJson = await t.api.post('/api/voice/transcribe', { data: `data:audio/webm;base64,${'A'.repeat(Math.ceil(MAX_STT_BYTES * 1.5))}` });
    expect(bigJson.status).toBe(413);
  });

  it('answers clearly without a speech recognizer, with a bad key or a provider error – and keeps people with other areas able to use it', async () => {
    await login('c@example.com', locC);
    const none = await upload(WEBM);
    expect(none.status).toBe(409);
    expect((await none.json()).error).toMatch(/Spracherkennung fehlt ein Anbieter/);
    await login('plain@example.com');
    fail = { url: /audio\/transcriptions/, status: 401, body: { error: { message: 'Incorrect API key provided' } } };
    const r = await upload(WEBM);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/Incorrect API key.*Schlüssel prüfen/);
    fail = null;
    expect((await upload(WEBM)).status).toBe(200);
  });

  it('transcribes a file by address (https only, size-limited) or from the media library', async () => {
    const r = await t.api.post('/api/voice/transcribe-url', { url: 'https://files.example.com/voicemail.webm', language: 'de' });
    expect(r.status).toBe(200);
    expect(r.data.text).toContain('Termin');
    expect((await t.api.post('/api/voice/transcribe-url', { url: 'http://files.example.com/a.webm' })).status).toBe(400);
    expect((await t.api.post('/api/voice/transcribe-url', { url: 'https://127.0.0.1/a.webm' })).status).toBeGreaterThanOrEqual(400);
    expect((await t.api.post('/api/voice/transcribe-url', {})).status).toBe(400);
    expect((await t.api.post('/api/voice/transcribe-url', { upload_id: 'gibtesnicht' })).status).toBe(404);
  });
});

describe('spoken replies of the agent', () => {
  it('returns the audio file itself (or JSON with a data URL) with the person\'s own voice', async () => {
    await t.api.put('/api/voice/prefs', { voice: 'onyx' });
    const raw = await t.api.raw('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': locA }, body: JSON.stringify({ text: 'Ihr Termin ist eingetragen.' }) });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('audio/mpeg');
    expect(raw.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(MP3);
    expect(last('/audio/speech')!.body).toMatchObject({ voice: 'onyx', input: 'Ihr Termin ist eingetragen.' });
    const j = await t.api.post('/api/voice/speak?format=json', { text: 'Hallo' });
    expect(j.data).toMatchObject({ mime: 'audio/mpeg', audio: expect.stringMatching(/^data:audio\/mpeg;base64,/) });
    expect((await t.api.post('/api/voice/speak', { text: '' })).status).toBe(400);
    expect((await t.api.post('/api/voice/speak', { text: 'x'.repeat(4001) })).status).toBe(400);
    await t.api.put('/api/voice/prefs', { voice: '' });
  });
});

describe('personal preferences', () => {
  it('are per person and sub-account and fall back to the sub-account\'s defaults', async () => {
    await t.api.put('/api/voice/settings', { agent: { read_aloud: true, auto_send: false } });
    const def = (await t.api.get('/api/voice/prefs')).data;
    expect(def.prefs).toEqual({ read_aloud: null, auto_send: null, voice: '', connection_id: '' });
    expect(def.effective).toEqual({ read_aloud: true, auto_send: false });
    expect(def.ready).toEqual({ stt: true, tts: true });
    const mine = (await t.api.put('/api/voice/prefs', { read_aloud: false, auto_send: true, voice: 'nova', connection_id: elevenId })).data;
    expect(mine.prefs).toEqual({ read_aloud: false, auto_send: true, voice: 'nova', connection_id: elevenId });
    expect(mine.effective).toEqual({ read_aloud: false, auto_send: true });
    await login('settings@example.com');
    expect((await t.api.get('/api/voice/prefs')).data.prefs.voice).toBe('');
    await admin();
    expect((await t.api.put('/api/voice/prefs', { read_aloud: null })).data.effective.read_aloud).toBe(true);
    expect((await t.api.put('/api/voice/prefs', { connection_id: 'aic_fremd' })).status).toBe(400);
    expect((await t.api.put('/api/voice/prefs', { voice: '<x>' })).status).toBe(400);
    await t.api.put('/api/voice/prefs', { auto_send: null, voice: '', connection_id: '' });
    await t.api.put('/api/voice/settings', { agent: { read_aloud: false, auto_send: false } });
  });

  it('cannot be saved with an API key (there is no person)', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'voice' })).data.key as string;
    const r = await t.api.raw('/api/voice/prefs', { method: 'PUT', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-location-id': locA }, body: '{"voice":"x"}' });
    expect(r.status).toBe(403);
    const g = await t.api.raw('/api/voice/prefs', { headers: { authorization: `Bearer ${key}`, 'x-location-id': locA } });
    expect(g.status).toBe(200);
  });
});

describe('MCP tools', () => {
  let key = '';
  const rpc = async (method: string, params: any, token = key) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()) as any;
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await rpc('tools/call', { name, arguments: { location_id: locA, ...args } });
    const text = r.result?.content?.[0]?.text ?? '';
    return { error: !!r.result?.isError || !!r.error, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  beforeAll(async () => {
    await admin();
    key = (await t.api.post('/api/api-keys', { name: 'mcp-voice' })).data.key;
  });

  it('lists the voice tools with schemas and hints', async () => {
    const tools: any[] = (await rpc('tools/list', {})).result.tools;
    const names = tools.map((x) => x.name);
    for (const n of ['ghl_voice_get_settings', 'ghl_voice_update_settings', 'ghl_voice_list_voices', 'ghl_voice_test_voice', 'ghl_voice_transcribe', 'ghl_voice_phone_latency']) expect(names).toContain(n);
    expect(tools.find((x) => x.name === 'ghl_voice_get_settings').annotations.readOnlyHint).toBe(true);
    expect(tools.find((x) => x.name === 'ghl_voice_update_settings').annotations.readOnlyHint).toBe(false);
    expect(tools.find((x) => x.name === 'ghl_voice_transcribe').annotations.openWorldHint).toBe(true);
  });

  it('reads and changes the settings, lists voices, tests a voice without returning audio and transcribes by address', async () => {
    const get = await call('ghl_voice_get_settings', {});
    expect(get.data.settings.tts.language).toBe('de');
    const upd = await call('ghl_voice_update_settings', { settings: { tts: { speed: 1.15 }, call_summary: true } });
    expect(upd.data.settings).toMatchObject({ tts: { speed: 1.15 }, call_summary: true });
    expect((await call('ghl_voice_update_settings', { settings: { tts: { speed: 7 } } })).error).toBe(true);
    const voices = await call('ghl_voice_list_voices', { language: 'de' });
    expect(voices.data.voices.length).toBeGreaterThan(5);
    const test = await call('ghl_voice_test_voice', { text: 'Hallo' });
    expect(test.data).toMatchObject({ ok: true, provider: 'openai', chars: 5 });
    expect(test.text).not.toContain('base64');
    const tr = await call('ghl_voice_transcribe', { url: 'https://files.example.com/voicemail.webm' });
    expect(tr.data.text).toContain('Termin');
    expect((await call('ghl_voice_transcribe', {})).error).toBe(true);
    const lat = await call('ghl_voice_phone_latency', {});
    expect(lat.data.summary).toMatchObject({ turns: expect.any(Number) });
    await t.api.put('/api/voice/settings', { tts: { speed: 1 }, call_summary: false });
  });

  it('never reaches into another sub-account', async () => {
    const r = await call('ghl_voice_get_settings', { location_id: locB });
    expect(r.error).toBe(true);
  });
});

describe('native app', () => {
  it('transcribes and speaks for the paired device in the chosen sub-account only', async () => {
    await login('settings@example.com');
    const pair = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel' })).data;
    const call = async (path: string, body: unknown) => {
      const r = await t.api.raw(path, { method: 'POST', headers: { authorization: `Bearer ${pair.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, data: (await r.json()) as any };
    };
    const tr = await call('/api/mobile/voice/transcribe', { location_id: locA, data: dataUrl(WEBM) });
    expect(tr.status).toBe(200);
    expect(tr.data.text).toContain('Termin');
    const sp = await call('/api/mobile/voice/speak', { location_id: locA, text: 'Hallo aus der App' });
    expect(sp.status).toBe(200);
    expect(sp.data.audio).toMatch(/^data:audio\/mpeg;base64,/);
    expect((await call('/api/mobile/voice/transcribe', { location_id: locB, data: dataUrl(WEBM) })).status).toBeGreaterThanOrEqual(403);
    expect((await call('/api/mobile/voice/transcribe', { data: dataUrl(WEBM) })).status).toBe(400);
    const nothing = await t.api.raw('/api/mobile/voice/transcribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(nothing.status).toBe(401);
  });
});

describe('latency of phone calls', () => {
  it('summarizes the recorded turns of the sub-account only', async () => {
    const log = t.app.services.voiceTurnLog as (loc: string, sid: string, transport: string, m: any) => void;
    const at = new Date().toISOString();
    for (const total of [800, 900, 1000, 1100, 3000]) log(locA, 'CA1', 'stream', { n: 1, stt_ms: 100, llm_ms: 400, tts_ms: 300, total_ms: total, at });
    log(locA, 'CA1', 'stream', { n: 2, interrupted: true, at });
    log(locB, 'CA2', 'stream', { n: 1, total_ms: 99_999, at });
    const r = (await t.api.get('/api/voice/latency')).data;
    expect(r.summary).toMatchObject({ turns: 6, interrupted: 1, total_p50: 1000, total_p95: 3000, stt_avg: 100, llm_avg: 400, tts_avg: 300 });
    expect(r.turns).toHaveLength(6);
    expect(JSON.stringify(r)).not.toContain('99999');
    expect((await t.api.get('/api/voice/settings')).data.latency.turns).toBe(6);
    expect((await t.api.get('/api/voice/latency?limit=2')).data.turns).toHaveLength(2);
  });
});
