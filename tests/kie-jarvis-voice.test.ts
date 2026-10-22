import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { presetById } from '../server/services/ai-presets.js';
import { JARVIS_PROVIDER_VOICES, resolveTtsVoice, ttsProviderOk } from '../server/services/companion-prefs.js';
import { KIE_JARVIS_VOICE, KIE_TTS_DEFAULT, KIE_VOICES, kieAdapter, kieVoice } from '../server/services/genmedia/kie.js';
import type { AdapterCtx, AiConnection } from '../server/services/genmedia/types.js';
import { JARVIS_PROVIDER_VOICES as WEB_VOICES, resolveVoice, speechPlan } from '../web/src/companion/voice-plan.js';

/**
 * Jarvis speaks through kie.ai (1.0.58): ElevenLabs Turbo 2.5 on kie's Market API with the voice "Brian", told the language of
 * the app, polled quickly; selectable as the companion's provider; "auto" resolves per provider. kie is faked.
 */

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 2)]);
const BRIAN = 'nPczCjzI2devNBz1zQrb';

describe('kie.ai speech adapter', () => {
  const conn = { connectionId: 'c-kie', provider: 'kie', baseUrl: 'https://api.kie.ai', apiKey: 'kie-key', authStyle: 'bearer' } as unknown as AiConnection;
  function rig() {
    const calls: { url: string; body: any }[] = [];
    const fetch = async (url: string, init: any = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      const j = url.includes('/recordInfo') ? { code: 200, data: { taskId: 't1', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/a.mp3'] }) } } : { code: 200, data: { taskId: 't1' } };
      const buf = Buffer.from(JSON.stringify(j));
      return { status: 200, ok: true, headers: { 'content-type': 'application/json' }, body: buf, text: () => buf.toString(), json: () => j };
    };
    const ctx = (input: Record<string, any>, model = ''): AdapterCtx => ({ conn, capability: 'audio_tts', model, input: { prompt: 'Guten Abend.', ...input }, fetch } as unknown as AdapterCtx);
    return { calls, ctx };
  }

  it('creates a Turbo 2.5 task with Brian, the language and a clamped speed, and asks again within a second', async () => {
    const r = rig();
    const step = await kieAdapter.submit(r.ctx({ voice: 'auto', language: 'de-DE', speed: 1.5 }));
    expect(r.calls[0].url).toBe('https://api.kie.ai/api/v1/jobs/createTask');
    expect(r.calls[0].body).toEqual({ model: KIE_TTS_DEFAULT, input: { text: 'Guten Abend.', voice: BRIAN, speed: 1.2, language_code: 'de' } });
    expect(step).toMatchObject({ status: 'pending', pollAfterMs: 800 });
    const done = await kieAdapter.poll!(r.ctx({}), (step as any).state);
    expect(done).toMatchObject({ status: 'done', outputs: [{ url: 'https://tempfile.aiquickdraw.com/a.mp3' }] });
  });

  it('keeps kie voice ids, replaces voices of other providers, and sends no language to Multilingual v2 (kie rejects it there)', async () => {
    const r = rig();
    await kieAdapter.submit(r.ctx({ voice: 'MJ0RnG71ty4LH3dvNfSd', language: 'en' }, 'elevenlabs/text-to-speech-multilingual-v2'));
    expect(r.calls[0].body).toEqual({ model: 'elevenlabs/text-to-speech-multilingual-v2', input: { text: 'Guten Abend.', voice: 'MJ0RnG71ty4LH3dvNfSd' } });
    expect(kieVoice('de-DE-Chirp3-HD-Iapetus')).toBe(BRIAN);
    expect(kieVoice('auto')).toBe(BRIAN);
    expect(kieVoice('')).toBe(BRIAN);
    expect(kieVoice('Abcdefghij0123456789')).toBe('Abcdefghij0123456789');
  });

  it('lists kie’s voices (Brian first) and offers speech in the preset, so it can be picked for Jarvis', async () => {
    expect((await kieAdapter.voices!({} as any))[0]).toMatchObject({ id: BRIAN, name: expect.stringMatching(/^Brian/) });
    expect(KIE_VOICES.length).toBeGreaterThan(60);
    expect(new Set(KIE_VOICES.map((v) => v.id)).size).toBe(KIE_VOICES.length);
    expect(presetById('kie')?.capabilities).toContain('audio_tts');
    expect(presetById('kie')?.models.audio_tts?.[0]).toBe(KIE_TTS_DEFAULT);
    expect(ttsProviderOk('kie')).toBe(true);
  });
});

describe('"auto" per provider', () => {
  it('is Google’s native voice, kie’s Brian, and the provider’s own default elsewhere – the same on server and web', () => {
    expect(resolveTtsVoice('auto', 'de')).toBe('de-DE-Chirp3-HD-Iapetus');
    expect(resolveTtsVoice('auto', 'de', 'kie')).toBe(BRIAN);
    expect(resolveTtsVoice('auto', 'en', 'kie')).toBe(BRIAN);
    expect(resolveTtsVoice('en-GB-Neural2-B', 'de', 'kie')).toBe(BRIAN);
    expect(resolveTtsVoice('auto', 'de', 'openai')).toBe('');
    expect(resolveTtsVoice('onyx', 'de', 'openai')).toBe('onyx');
    expect(WEB_VOICES).toEqual(JARVIS_PROVIDER_VOICES);
    expect(JARVIS_PROVIDER_VOICES.kie.de).toBe(KIE_JARVIS_VOICE);
    expect(resolveVoice('auto', 'de', 'kie')).toBe(BRIAN);
    expect(resolveVoice('auto', 'en', 'openai')).toBe('');
  });

  it('sends Brian and the language for a kie connection', () => {
    const info = { stt: true, tts: true, connections: [{ id: 'k1', label: 'kie', provider: 'kie' }] };
    const prefs = { tts_provider: 'kie', tts_connection_id: '', tts_voice: 'auto', browser_voice: '' };
    expect(speechPlan(prefs, info, 'en').tts).toEqual({ connection_id: 'k1', voice: BRIAN, lang: 'en' });
    expect(speechPlan({ ...prefs, tts_voice: 'MJ0RnG71ty4LH3dvNfSd' }, info).tts).toEqual({ connection_id: 'k1', voice: 'MJ0RnG71ty4LH3dvNfSd', lang: 'de' });
  });
});

describe('POST /api/voice/speak through kie.ai', () => {
  const seen: { url: string; body: any; headers: Record<string, string> }[] = [];
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  const fake = async (url: string, init: any = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    seen.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, headers });
    if (url === 'https://api.kie.ai/api/v1/jobs/createTask') return json({ code: 200, msg: 'success', data: { taskId: 'task_elevenlabs_1' } });
    if (url.startsWith('https://api.kie.ai/api/v1/jobs/recordInfo')) return json({ code: 200, data: { taskId: 'task_elevenlabs_1', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.aiquickdraw.com/s/brian.mp3'] }) } });
    if (url === 'https://tempfile.aiquickdraw.com/s/brian.mp3') return new Response(new Uint8Array(MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    return json({ code: 404, msg: `no route ${url}` });
  };
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let kie = '';
  beforeAll(async () => {
    t = await startTestApp();
    t.app.services.genmediaFetch = fake;
    await t.setup();
    // a kie connection created now offers speech by default (preset), with Turbo 2.5 as its model
    kie = (await t.api.post('/api/ai-connections', { provider: 'kie', api_key: 'kie-test-key-1234567890' })).data.id;
  }, 60_000);
  afterAll(() => t.close());
  beforeEach(() => {
    seen.length = 0;
  });

  it('speaks Jarvis’s answer with Brian in German, polls kie and returns the audio', async () => {
    const r = await t.api.post('/api/voice/speak?format=json', { text: 'Guten Abend, alles ruhig.', provider: 'kie', voice: 'auto', lang: 'de' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.audio).toMatch(/^data:audio\/mpeg;base64,/);
    const create = seen.find((c) => c.url.endsWith('/createTask'))!;
    expect(create.headers.authorization).toBe('Bearer kie-test-key-1234567890');
    expect(create.body).toMatchObject({ model: KIE_TTS_DEFAULT, input: { text: 'Guten Abend, alles ruhig.', voice: BRIAN, language_code: 'de' } });
    expect(seen.some((c) => c.url.includes('/recordInfo?taskId=task_elevenlabs_1'))).toBe(true);
  });

  it('tells kie English when the app speaks English, and works with the picked connection', async () => {
    expect((await t.api.post('/api/voice/speak?format=json', { text: 'Good evening.', connection_id: kie, voice: 'auto', lang: 'en' })).status).toBe(200);
    expect(seen.find((c) => c.url.endsWith('/createTask'))!.body.input).toMatchObject({ voice: BRIAN, language_code: 'en' });
  });

  it('shows the kie connection among the voices Jarvis can use, with kie’s voice list', async () => {
    const prefs = await t.api.get('/api/voice/prefs');
    expect(prefs.data.connections).toEqual(expect.arrayContaining([expect.objectContaining({ id: kie, provider: 'kie', usable: true })]));
    const voices = await t.api.get(`/api/voice/voices?connection_id=${kie}`);
    expect(voices.status, JSON.stringify(voices.data)).toBe(200);
    expect(voices.data.voices[0]).toMatchObject({ id: BRIAN });
  });
});
