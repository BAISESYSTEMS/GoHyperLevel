import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { googleSpeechAdapter } from '../server/services/voice-adapters.js';
import { greetingName, rulesSay } from '../server/services/briefing.js';
import { DEFAULT_TTS_PROVIDER, DEFAULT_TTS_VOICE, cleanPrefs, defaultPrefs, resolveTtsVoice, withPrefDefaults } from '../server/services/companion-prefs.js';
import { companionConnection, pickNativeVoice, resolveVoice, speechPlan, type VoiceInfo } from '../web/src/companion/voice-plan.js';

/**
 * The companion's voice (1.0.53): Jarvis speaks with Google Cloud Text-to-Speech "en-GB-Neural2-B" through the sub-account's own
 * "Google Cloud Speech" connection – POST /api/voice/speak with provider/connection and voice, validated against the sub-account's
 * connections; the browser's British voice as the fallback. And a briefing for an API key greets without a name. Providers are faked.
 */

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 2)]);
type Seen = { url: string; method: string; headers: Record<string, string>; body: any };
const seen: Seen[] = [];
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
  seen.push({ url, method: init.method ?? 'GET', headers, body });
  if (url.startsWith('https://texttospeech.googleapis.com/v1/text:synthesize')) return json({ audioContent: MP3.toString('base64') });
  if (url.startsWith('https://texttospeech.googleapis.com/v1/voices')) return json({ voices: [{ name: 'en-GB-Neural2-B', ssmlGender: 'MALE', languageCodes: ['en-GB'] }] });
  if (url.endsWith('/audio/speech')) return new Response(new Uint8Array(MP3), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  return json({ error: `no route ${url}` }, 404);
};
const google = () => seen.filter((c) => c.url.includes('texttospeech.googleapis.com/v1/text:synthesize'));
const openai = () => seen.filter((c) => c.url.endsWith('/audio/speech'));

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let googleA = '';
let openaiA = '';
let googleB = '';
const speak = (body: Record<string, unknown>) => t.api.post('/api/voice/speak?format=json', { text: 'Guten Abend, alles ruhig.', ...body });

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.genmediaFetch = fakeProvider;
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Firma B' })).data.id;
  openaiA = (await t.api.post('/api/ai-connections', { provider: 'openai', api_key: 'sk-test-voice-key-1234567890', capabilities: ['audio_tts'], models: { audio_tts: 'gpt-4o-mini-tts' } })).data.id;
  googleA = (await t.api.post('/api/ai-connections', { provider: 'google_speech', api_key: 'AIza-test-google-key-1234567890', capabilities: ['audio_tts'] })).data.id;
  t.api.setLocation(B);
  googleB = (await t.api.post('/api/ai-connections', { provider: 'google_speech', api_key: 'AIza-test-google-key-B-1234567890', capabilities: ['audio_tts'] })).data.id;
  t.api.setLocation(A);
  // the sub-account's own voice is OpenAI "onyx"
  expect((await t.api.put('/api/voice/settings', { tts: { connection_id: openaiA, voice: 'onyx' } })).status).toBe(200);
}, 60_000);
afterAll(() => t.close());
beforeEach(() => {
  seen.length = 0;
  t.api.setLocation(A);
});

describe('POST /api/voice/speak with the companion’s voice', () => {
  it('speaks with the first Google connection and en-GB-Neural2-B – the language code comes from the voice name', async () => {
    const r = await speak({ provider: 'google_speech', voice: 'en-GB-Neural2-B' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.audio).toMatch(/^data:audio\/mpeg;base64,/);
    expect(google()).toHaveLength(1);
    expect(google()[0].body.voice).toEqual({ languageCode: 'en-GB', name: 'en-GB-Neural2-B' });
    expect(google()[0].headers['x-goog-api-key']).toBe('AIza-test-google-key-1234567890');
    expect(openai()).toHaveLength(0);
    // a picked connection works the same way
    expect((await speak({ connection_id: googleA, voice: 'en-GB-Neural2-B' })).status).toBe(200);
    expect(google()[1].body.voice.languageCode).toBe('en-GB');
  });

  it('"auto" speaks with the native Jarvis voice of the language – no accent', async () => {
    expect((await speak({ provider: 'google_speech', voice: 'auto', lang: 'de' })).status).toBe(200);
    expect(google()[0].body.voice).toEqual({ languageCode: 'de-DE', name: 'de-DE-Chirp3-HD-Iapetus' });
    expect((await speak({ provider: 'google_speech', voice: 'auto', lang: 'en' })).status).toBe(200);
    expect(google()[1].body.voice).toEqual({ languageCode: 'en-US', name: 'en-US-Chirp3-HD-Iapetus' });
  });

  it('never uses the sub-account’s voice of another provider for Google (OpenAI "onyx" is not a Google voice)', async () => {
    expect((await speak({ provider: 'google_speech' })).status).toBe(200);
    expect(google()[0].body.voice.name).not.toBe('onyx');
    expect(google()[0].body.voice.name).toMatch(/^[a-z]{2}-[A-Z]{2}-/);
  });

  it('keeps the old behaviour without provider/connection: the sub-account’s voice', async () => {
    expect((await speak({})).status).toBe(200);
    expect(openai()).toHaveLength(1);
    expect(openai()[0].body).toMatchObject({ voice: 'onyx' });
    expect(google()).toHaveLength(0);
  });

  it('refuses another sub-account’s connection, unknown ids and malformed input – without calling any provider', async () => {
    expect((await speak({ connection_id: googleB, voice: 'en-GB-Neural2-B' })).status).toBe(404);
    expect((await speak({ connection_id: 'gibtesnicht' })).status).toBe(404);
    expect((await speak({ connection_id: '../../etc' })).status).toBe(400);
    expect((await speak({ connection_id: 'https://evil.example.com/tts' })).status).toBe(400);
    expect((await speak({ provider: 'Google Speech!' })).status).toBe(400);
    expect((await speak({ provider: 'google_speech', voice: '<script>' })).status).toBe(400);
    expect((await speak({ provider: 'google_speech', voice: 'x'.repeat(121) })).status).toBe(400);
    expect((await speak({ connection_id: openaiA, provider: 'google_speech' })).status).toBe(400);
    // a provider without a connection here: 409 with what to do (the browser then speaks)
    const none = await speak({ provider: 'elevenlabs' });
    expect(none.status).toBe(409);
    expect(none.data.error).toMatch(/KI-Anbieter/);
    expect(seen).toHaveLength(0);
    // the other sub-account uses its own Google connection
    t.api.setLocation(B);
    expect((await speak({ provider: 'google_speech', voice: 'en-GB-Neural2-B' })).status).toBe(200);
    expect(google()[0].headers['x-goog-api-key']).toBe('AIza-test-google-key-B-1234567890');
  });

  it('counts the usage like every spoken reply', async () => {
    const calls = () => t.app.db.get<{ n: number }>("SELECT COALESCE(SUM(calls), 0) AS n FROM voice_usage WHERE location_id = ? AND kind = 'tts'", A)!.n;
    const before = calls();
    await speak({ provider: 'google_speech', voice: 'en-GB-Neural2-B' });
    expect(calls()).toBe(before + 1);
  });

  it('tells the browser which connections can speak (for the companion’s picker, no settings right needed)', async () => {
    const r = (await t.api.get('/api/voice/prefs')).data;
    expect(r.connections).toEqual(expect.arrayContaining([{ id: googleA, label: expect.any(String), provider: 'google_speech', usable: true }]));
    expect(r.connections.map((c: any) => c.id)).not.toContain(googleB);
    expect(JSON.stringify(r)).not.toContain('AIza');
  });
});

describe('Google adapter: language code from the voice name', () => {
  it('en-GB-Neural2-B → en-GB even when the sub-account speaks German; a voice without locale falls back to the language', async () => {
    const calls: any[] = [];
    const ctx = (voice: string | undefined, language?: string): any => ({
      conn: { provider: 'google_speech', apiKey: 'k', baseUrl: '', headers: {} },
      capability: 'audio_tts',
      model: '',
      input: { prompt: 'Hallo', voice, language },
      fetch: async (_url: string, init: any) => {
        calls.push(JSON.parse(init.body));
        return json({ audioContent: MP3.toString('base64') });
      },
    });
    await googleSpeechAdapter.submit(ctx('en-GB-Neural2-B', 'de'));
    await googleSpeechAdapter.submit(ctx('cmn-CN-Wavenet-A', 'de'));
    await googleSpeechAdapter.submit(ctx(undefined, 'de'));
    expect(calls.map((c) => c.voice)).toEqual([
      { languageCode: 'en-GB', name: 'en-GB-Neural2-B' },
      { languageCode: 'cmn-CN', name: 'cmn-CN-Wavenet-A' },
      { languageCode: 'de-DE', name: 'de-DE-Neural2-F' },
    ]);
  });
});

describe('companion voice preference', () => {
  it('defaults to Google with a native voice per language and validates a patch', () => {
    expect(defaultPrefs()).toMatchObject({ tts_provider: 'google_speech', tts_connection_id: '', tts_voice: 'auto' });
    expect(DEFAULT_TTS_PROVIDER).toBe('google_speech');
    expect(DEFAULT_TTS_VOICE).toBe('auto');
    expect(resolveTtsVoice('auto', 'de')).toBe('de-DE-Chirp3-HD-Iapetus');
    expect(resolveTtsVoice('auto', 'en')).toBe('en-US-Chirp3-HD-Iapetus');
    // the 1.0.53 default (British, read German with an accent) is read as automatic; a voice picked on purpose stays
    expect(resolveTtsVoice('en-GB-Neural2-B', 'de')).toBe('de-DE-Chirp3-HD-Iapetus');
    expect(resolveTtsVoice('de-DE-Neural2-F', 'de')).toBe('de-DE-Neural2-F');
    expect(withPrefDefaults({ tts_voice: 'en-GB-Neural2-B' }).tts_voice).toBe('auto');
    const cur = defaultPrefs();
    expect(cleanPrefs({ tts_provider: 'browser' }, cur)).toMatchObject({ tts_provider: 'browser', tts_connection_id: '' });
    expect(cleanPrefs({ tts_provider: 'openai', tts_voice: 'onyx' }, cur)).toMatchObject({ tts_provider: 'openai', tts_voice: 'onyx' });
    expect(cleanPrefs({ tts_provider: '' }, cur).tts_provider).toBe('google_speech');
    expect(() => cleanPrefs({ tts_provider: 'nope_provider' }, cur)).toThrow(/Anbieter/);
    expect(() => cleanPrefs({ tts_provider: 'openai' as any, tts_connection_id: 'a b' }, cur)).toThrow(/Verbindung/);
    expect(() => cleanPrefs({ tts_voice: '<x>' }, cur)).toThrow(/Stimme/);
    expect(withPrefDefaults({ tts_provider: 'evil', tts_voice: '<x>', tts_connection_id: '../x' })).toMatchObject({ tts_provider: 'google_speech', tts_voice: 'auto', tts_connection_id: '' });
  });

  it('is saved per person; a connection must be this sub-account’s and decides the provider', async () => {
    const get = (await t.api.get('/api/companion/prefs')).data;
    expect(get.prefs).toMatchObject({ tts_provider: 'google_speech', tts_voice: 'auto' });
    expect((await t.api.put('/api/companion/prefs', { tts_connection_id: googleB })).status).toBe(404);
    const put = await t.api.put('/api/companion/prefs', { tts_provider: 'google_speech', tts_connection_id: openaiA, tts_voice: 'nova' });
    expect(put.status).toBe(200);
    expect(put.data.prefs).toMatchObject({ tts_provider: 'openai', tts_connection_id: openaiA, tts_voice: 'nova' });
    expect((await t.api.put('/api/companion/prefs', { tts_provider: 'browser' })).data.prefs).toMatchObject({ tts_provider: 'browser', tts_connection_id: '' });
    expect((await t.api.put('/api/companion/prefs', { tts_provider: 'google_speech', tts_voice: 'auto' })).data.prefs).toMatchObject({ tts_provider: 'google_speech', tts_connection_id: '' });
    // a picked connection that is removed later never blocks another change
    const temp = (await t.api.post('/api/ai-connections', { provider: 'google_speech', label: 'Temp', api_key: 'AIza-test-google-key-temp-123456', capabilities: ['audio_tts'] })).data.id;
    expect((await t.api.put('/api/companion/prefs', { tts_connection_id: temp })).data.prefs.tts_connection_id).toBe(temp);
    expect((await t.api.del(`/api/ai-connections/${temp}`)).status).toBe(200);
    const after = await t.api.put('/api/companion/prefs', { name: 'Jarvis' });
    expect(after.status).toBe(200);
    expect(after.data.prefs).toMatchObject({ tts_provider: 'google_speech', tts_connection_id: '' });
  });
});

describe('browser side: who speaks (pure)', () => {
  const prefs = { tts_provider: 'google_speech', tts_connection_id: '', tts_voice: 'auto', browser_voice: '' };
  const withGoogle: VoiceInfo = { stt: true, tts: true, connections: [{ id: 'oa', label: 'OpenAI', provider: 'openai' }, { id: 'g1', label: 'Google', provider: 'google_speech' }, { id: 'g2', label: 'Google 2', provider: 'google_speech' }] };
  const without: VoiceInfo = { stt: true, tts: true, connections: [{ id: 'oa', label: 'OpenAI', provider: 'openai' }] };

  it('uses the Google connection with the native voice of the app language when there is one', () => {
    expect(speechPlan(prefs, withGoogle)).toEqual({ tts: { connection_id: 'g1', voice: 'de-DE-Chirp3-HD-Iapetus', lang: 'de' }, server: false, voice: undefined, preferNative: true });
    expect(speechPlan(prefs, withGoogle, 'en').tts).toEqual({ connection_id: 'g1', voice: 'en-US-Chirp3-HD-Iapetus', lang: 'en' });
    expect(speechPlan({ ...prefs, tts_voice: 'en-GB-Neural2-B' }, withGoogle).tts?.voice).toBe('de-DE-Chirp3-HD-Iapetus');
    expect(speechPlan({ ...prefs, tts_voice: 'de-DE-Wavenet-B' }, withGoogle).tts?.voice).toBe('de-DE-Wavenet-B');
    expect(resolveVoice('auto', 'en')).toBe('en-US-Chirp3-HD-Iapetus');
    expect(companionConnection({ ...prefs, tts_connection_id: 'g2' }, withGoogle.connections)?.id).toBe('g2');
    // a picked connection that is gone or of another provider: the provider's first one
    expect(companionConnection({ ...prefs, tts_connection_id: 'oa' }, withGoogle.connections)?.id).toBe('g1');
    expect(companionConnection(prefs, [{ id: 'g1', label: '', provider: 'google_speech', usable: false }])).toBeNull();
  });

  it('falls back to the browser – a natural male voice of the language for the default, the picked browser voice otherwise', () => {
    expect(speechPlan(prefs, without)).toEqual({ tts: null, server: false, voice: undefined, preferNative: true });
    expect(speechPlan({ ...prefs, browser_voice: 'Anna' }, without)).toMatchObject({ tts: null, voice: 'Anna', preferNative: false });
    expect(speechPlan({ ...prefs, tts_provider: 'browser' }, withGoogle)).toMatchObject({ tts: null, server: false, preferNative: false });
    expect(speechPlan({ ...prefs, tts_provider: 'account' }, withGoogle)).toMatchObject({ tts: null, server: true, preferNative: false });
    expect(speechPlan({ ...prefs, tts_voice: 'de-DE-Neural2-F' }, without).preferNative).toBe(false);
    const voices = [
      { name: 'Google Deutsch', lang: 'de-DE' },
      { name: 'Microsoft Katja Online (Natural) - German (Germany)', lang: 'de-DE' },
      { name: 'Microsoft Conrad Online (Natural) - German (Germany)', lang: 'de-DE' },
      { name: 'Microsoft Jonas Online (Natural) - German (Austria)', lang: 'de-AT' },
      { name: 'Google UK English Male', lang: 'en-GB' },
      { name: 'Microsoft Andrew Online (Natural) - English (United States)', lang: 'en-US' },
      { name: 'Samantha', lang: 'en-US' },
    ];
    expect(pickNativeVoice(voices, 'de')?.name).toMatch(/Conrad/);
    expect(pickNativeVoice(voices, 'en')?.name).toMatch(/Andrew/);
    expect(pickNativeVoice([{ name: 'Anna', lang: 'de_DE' }, { name: 'Samantha', lang: 'en-US' }], 'de')?.name).toBe('Anna');
    expect(pickNativeVoice([{ name: 'Markus', lang: 'de-DE' }, { name: 'Anna', lang: 'de-DE' }], 'de')?.name).toBe('Markus');
    expect(pickNativeVoice([{ name: 'Samantha', lang: 'en-US' }], 'de')).toBeNull();
  });
});

describe('briefing greeting without a person', () => {
  it('greets an API key (and anyone without a real name) without a name', () => {
    expect(greetingName({ id: 'u1', name: 'API: Make.com' })).toBe('');
    expect(greetingName({ id: 'u1', name: 'API:' })).toBe('');
    expect(greetingName({ id: 'key:abc', name: 'Irgendwas' })).toBe('');
    expect(greetingName({ id: 'u1', name: 'Clara Schmidt' }, true)).toBe('');
    expect(greetingName({ id: 'u1', name: 'KI-App' })).toBe('');
    expect(greetingName({ id: 'u1', name: 'chef@example.com' })).toBe('');
    expect(greetingName({ id: 'u1', name: '' })).toBe('');
    expect(greetingName(undefined)).toBe('');
    expect(greetingName({ id: 'u1', name: 'Clara Schmidt' })).toBe('Clara');
    expect(rulesSay([], [], { lang: 'de', hm: '19:30', name: greetingName({ id: 'x', name: 'API: Zapier' }) })).toMatch(/^Guten Abend\. /);
  });

  it('ghl_briefing over MCP with a sub-account key and with an agency key: "Guten Abend." / "Hallo." without "API:"', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Zapier' })).data.key;
    const agency = (await t.api.post('/api/agency/api-keys', { name: 'Agentur-Bot' })).data.key;
    let id = 0;
    for (const k of [key, agency]) {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'ghl_briefing', arguments: { location_id: A } } }) });
      const j: any = await r.json();
      const text = j.result?.content?.[0]?.text ?? '';
      expect(j.result?.isError, text).toBeFalsy();
      const say = JSON.parse(text).say as string;
      expect(say).not.toMatch(/API|Agentur-Bot|Zapier/);
      expect(say).toMatch(/^(Guten Morgen|Hallo|Guten Abend|Good morning|Hello|Good evening)\. /);
    }
  });
});
