import { describe, expect, it } from 'vitest';
import { ADAPTERS, adapterFor, supports } from '../server/services/genmedia/index.js';
import type { AdapterCtx, AiConnection, Capability, GenInput, GmRequest, GmResponse } from '../server/services/genmedia/types.js';
import { PRESETS, presetById } from '../server/services/ai-presets.js';
import {
  DEEPGRAM_VOICES,
  assemblyaiAdapter,
  azureEndpoints,
  azureSpeechAdapter,
  azureSsml,
  cartesiaAdapter,
  deepgramAdapter,
  googleAudioConfig,
  googleSpeechAdapter,
  langOf,
  localeOf,
  openaiCompatAdapter,
  registerVoiceAdapters,
} from '../server/services/voice-adapters.js';

/** The speech providers of the voice layer against fake HTTP: URLs, headers, bodies, results and errors. */

registerVoiceAdapters();

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 2)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(40, 1)]);
const res = (status: number, body: unknown, headers: Record<string, string> = {}): GmResponse => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': Buffer.isBuffer(body) ? 'audio/mpeg' : 'application/json', ...headers },
    body: buf,
    text: () => buf.toString('utf8'),
    json: () => {
      try {
        return JSON.parse(buf.toString('utf8'));
      } catch {
        return null;
      }
    },
  };
};

interface Seen {
  url: string;
  init: GmRequest;
  json?: any;
}
function rig(answer: (url: string, init: GmRequest) => GmResponse | undefined) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: GmRequest = {}) => {
    let json: any;
    if (typeof init.body === 'string') {
      try {
        json = JSON.parse(init.body);
      } catch {
        /* not json */
      }
    }
    seen.push({ url, init, json });
    return answer(url, init) ?? res(404, { error: 'unbekannt' });
  };
  const ctx = (conn: Partial<AiConnection>, capability: Capability, input: Partial<GenInput>, model = ''): AdapterCtx => ({
    conn: { connectionId: 'c1', provider: 'x', apiKey: 'key-123', ...conn },
    model,
    capability,
    input: { prompt: '', ...input },
    callbackUrl: null,
    fetch,
    bytes: async () => ({ data: Buffer.from('RIFFxxxxWAVEdata'), mime: 'audio/wav' }),
  });
  return { seen, ctx, fetch };
}
const header = (s: Seen, name: string) => Object.entries(s.init.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

describe('registration', () => {
  it('adds the speech adapters (and aliases) to the media engine and the presets match them', () => {
    for (const id of ['deepgram', 'cartesia', 'assemblyai', 'azure_speech', 'google_speech', 'openai_compat']) expect(ADAPTERS[id], id).toBeTruthy();
    expect(adapterFor('speech_local').id).toBe('openai_compat');
    expect(adapterFor('groq').id).toBe('openai_compat');
    expect(adapterFor('deepgram').id).toBe('deepgram');
    // every voice preset can be served by its adapter for each capability it announces
    for (const p of PRESETS.filter((x) => x.group === 'voice' || x.id === 'speech_local' || x.id === 'elevenlabs')) {
      for (const cap of p.capabilities.filter((c): c is 'audio_tts' | 'stt' => c === 'audio_tts' || c === 'stt')) expect(supports(adapterFor(p.id), cap), `${p.id} ${cap}`).toBe(true);
    }
    // live-capable providers are flagged so the UI can say "Live"
    expect(presetById('deepgram')?.realtime).toEqual({ stt: true, audio_tts: true });
    expect(presetById('assemblyai')?.realtime).toEqual({ stt: true });
    expect(presetById('elevenlabs')?.realtime?.audio_tts).toBe(true);
    expect(presetById('openai')?.realtime?.audio_tts).toBe(true);
    expect(presetById('google_speech')?.group).toBe('voice');
    expect(presetById('speech_local')?.local).toBe(true);
  });

  it('turns locales and languages the way providers want them', () => {
    expect(langOf('de-DE')).toBe('de');
    expect(langOf('DE')).toBe('de');
    expect(langOf('')).toBe('');
    expect(localeOf('de')).toBe('de-DE');
    expect(localeOf('en')).toBe('en-US');
    expect(localeOf('pt_BR')).toBe('pt-BR');
    expect(localeOf('xx', 'fr-FR')).toBe('fr-FR');
  });
});

describe('Deepgram', () => {
  it('speaks with Aura (the voice is the model) and bills characters', async () => {
    const r = rig(() => res(200, MP3));
    const step = await deepgramAdapter.submit(r.ctx({ provider: 'deepgram', authStyle: 'token' }, 'audio_tts', { prompt: 'Guten Tag', voice: 'aura-2-julius-de' }, 'nova-3'));
    expect(r.seen[0].url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-julius-de&encoding=mp3');
    expect(header(r.seen[0], 'authorization')).toBe('Token key-123');
    expect(r.seen[0].json).toEqual({ text: 'Guten Tag' });
    expect(step).toMatchObject({ status: 'done', cost: { amount: 9, unit: 'Zeichen' } });
    expect((step as any).outputs[0].data).toEqual(MP3);
    // a model that is no Aura voice is ignored
    await deepgramAdapter.submit(r.ctx({ provider: 'deepgram', baseUrl: 'https://api.eu.deepgram.com' }, 'audio_tts', { prompt: 'x' }, 'nova-3'));
    expect(r.seen[1].url).toBe('https://api.eu.deepgram.com/v1/speak?model=aura-2-viktoria-de&encoding=mp3');
  });

  it('transcribes with Nova, language or detection, and reads the transcript and duration', async () => {
    const r = rig(() => res(200, { metadata: { duration: 12.4 }, results: { channels: [{ alternatives: [{ transcript: ' Hallo Welt ' }] }] } }));
    const step = await deepgramAdapter.submit(r.ctx({ provider: 'deepgram' }, 'stt', { audio: { url: 'x' }, language: 'de-DE' }));
    const q = new URL(r.seen[0].url).searchParams;
    expect(r.seen[0].url).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?/);
    expect(q.get('model')).toBe('nova-3');
    expect(q.get('language')).toBe('de');
    expect(q.get('smart_format')).toBe('true');
    expect(header(r.seen[0], 'content-type')).toBe('audio/wav');
    expect(step).toMatchObject({ status: 'done', text: 'Hallo Welt', cost: { amount: 12, unit: 'Sekunden Audio' } });
    await deepgramAdapter.submit(r.ctx({ provider: 'deepgram' }, 'stt', { audio: { url: 'x' } }, 'nova-2'));
    const q2 = new URL(r.seen[1].url).searchParams;
    expect(q2.get('detect_language')).toBe('true');
    expect(q2.get('model')).toBe('nova-2');
  });

  it('explains errors and empty answers; lists the Aura voices with their language', async () => {
    await expect(deepgramAdapter.submit(rig(() => res(401, { err_msg: 'INVALID_AUTH' })).ctx({ provider: 'deepgram' }, 'audio_tts', { prompt: 'x' }))).rejects.toThrow(/HTTP 401.*Schlüssel prüfen/);
    await expect(deepgramAdapter.submit(rig(() => res(200, { results: {} })).ctx({ provider: 'deepgram' }, 'stt', { audio: { url: 'x' } }))).rejects.toThrow('keinen Text');
    await expect(deepgramAdapter.submit(rig(() => res(200, {})).ctx({ provider: 'deepgram' }, 'stt', {}))).rejects.toThrow('Audio');
    await expect(deepgramAdapter.submit(rig(() => res(200, {})).ctx({ provider: 'deepgram' }, 'image', { prompt: 'x' }))).rejects.toThrow('kann das nicht');
    const voices = await deepgramAdapter.voices!({ conn: { connectionId: 'c', provider: 'deepgram', apiKey: 'k' }, fetch: rig(() => undefined).fetch });
    expect(voices).toBe(DEEPGRAM_VOICES);
    expect(voices.filter((v) => v.lang === 'de').length).toBeGreaterThanOrEqual(5);
    expect(voices.every((v) => /^aura-2-[a-z]+-(de|en)$/.test(v.id))).toBe(true);
  });
});

describe('Cartesia', () => {
  it('speaks with a voice id (required), model, language and – for Sonic 3 – speed', async () => {
    const r = rig(() => res(200, MP3));
    const conn = { provider: 'cartesia', authStyle: 'header:x-api-key' };
    await expect(cartesiaAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo' }))).rejects.toThrow('Stimme');
    const step = await cartesiaAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', voice: 'v-123', language: 'de-DE', speed: 1.2 }, 'sonic-3'));
    expect(r.seen[0].url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(header(r.seen[0], 'x-api-key')).toBe('key-123');
    expect(header(r.seen[0], 'cartesia-version')).toBe('2025-04-16');
    expect(r.seen[0].json).toMatchObject({ model_id: 'sonic-3', transcript: 'Hallo', voice: { mode: 'id', id: 'v-123' }, language: 'de', generation_config: { speed: 1.2 }, output_format: { container: 'mp3' } });
    expect(step).toMatchObject({ status: 'done' });
    await cartesiaAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', voice: 'v', speed: 1.5 }, 'sonic-2'));
    expect(r.seen[1].json.generation_config).toBeUndefined();
  });

  it('transcribes with Ink and lists voices by language', async () => {
    const r = rig((url) => (url.includes('/stt') ? res(200, { text: ' Guten Tag ' }) : res(200, { data: [{ id: 'v1', name: 'Anna', language: 'de', gender: 'feminine' }, { id: 'v2', name: 'Bob' }] })));
    const conn = { provider: 'cartesia' };
    const step = await cartesiaAdapter.submit(r.ctx(conn, 'stt', { audio: { url: 'x' }, language: 'de' }));
    expect(r.seen[0].url).toBe('https://api.cartesia.ai/stt');
    expect(header(r.seen[0], 'content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(String(r.seen[0].init.body)).toContain('ink-whisper');
    expect(step).toMatchObject({ status: 'done', text: 'Guten Tag' });
    const voices = await cartesiaAdapter.voices!({ conn: { connectionId: 'c', provider: 'cartesia', apiKey: 'k' }, fetch: r.fetch, language: 'de-DE' });
    expect(r.seen[1].url).toBe('https://api.cartesia.ai/voices?limit=100&language=de');
    expect(voices).toEqual([
      { id: 'v1', name: 'Anna', lang: 'de', gender: 'feminine', preview: undefined },
      { id: 'v2', name: 'Bob', lang: undefined, gender: undefined, preview: undefined },
    ]);
  });
});

describe('AssemblyAI', () => {
  it('uploads, submits the job and polls it until the text is there', async () => {
    const r = rig((url, init) => {
      if (url.endsWith('/v2/upload')) return res(200, { upload_url: 'https://cdn.assemblyai.com/upload/abc' });
      if (url.endsWith('/v2/transcript') && init.method === 'POST') return res(200, { id: 'tr-1', status: 'queued' });
      if (url.endsWith('/v2/transcript/tr-1')) return res(200, { status: 'completed', text: ' Fertig. ', audio_duration: 30.2 });
      return undefined;
    });
    const ctx = r.ctx({ provider: 'assemblyai', authStyle: 'header:authorization' }, 'stt', { audio: { url: 'x' }, language: 'de', prompt: 'Müller, Schmidt; Praxis Dr. Sonne' }, 'universal');
    const first = await assemblyaiAdapter.submit(ctx);
    expect(header(r.seen[0], 'authorization')).toBe('key-123');
    expect(header(r.seen[0], 'content-type')).toBe('application/octet-stream');
    expect(r.seen[1].json).toMatchObject({ audio_url: 'https://cdn.assemblyai.com/upload/abc', language_code: 'de', speech_models: ['universal'], word_boost: ['Müller', 'Schmidt', 'Praxis Dr. Sonne'] });
    expect(first).toMatchObject({ status: 'pending', state: { id: 'tr-1' } });
    const done = await assemblyaiAdapter.poll!(ctx, (first as any).state);
    expect(done).toMatchObject({ status: 'done', text: 'Fertig.', cost: { amount: 30, unit: 'Sekunden Audio' } });
  });

  it('keeps polling while processing, reports job errors and detects the language when none is set', async () => {
    const processing = rig(() => res(200, { status: 'processing' }));
    expect(await assemblyaiAdapter.poll!(processing.ctx({ provider: 'assemblyai' }, 'stt', {}), { id: 'x' })).toMatchObject({ status: 'pending' });
    const failed = rig(() => res(200, { status: 'error', error: 'Audio zu kurz' }));
    expect(await assemblyaiAdapter.poll!(failed.ctx({ provider: 'assemblyai' }, 'stt', {}), { id: 'x' })).toEqual({ status: 'failed', error: 'AssemblyAI: Audio zu kurz' });
    const r = rig((url) => (url.endsWith('/v2/upload') ? res(200, { upload_url: 'u' }) : res(200, { id: 'a' })));
    await assemblyaiAdapter.submit(r.ctx({ provider: 'assemblyai' }, 'stt', { audio: { url: 'x' } }));
    expect(r.seen[1].json.language_detection).toBe(true);
    expect(r.seen[1].json.language_code).toBeUndefined();
    await expect(assemblyaiAdapter.submit(r.ctx({ provider: 'assemblyai' }, 'audio_tts', { prompt: 'x' }))).rejects.toThrow('nur transkribieren');
  });
});

describe('Azure Speech', () => {
  it('finds region and endpoints from every kind of address', () => {
    expect(azureEndpoints('https://germanywestcentral.api.cognitive.microsoft.com')).toEqual({
      tts: 'https://germanywestcentral.tts.speech.microsoft.com/cognitiveservices/v1',
      stt: 'https://germanywestcentral.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15',
      voices: 'https://germanywestcentral.tts.speech.microsoft.com/cognitiveservices/voices/list',
    });
    expect(azureEndpoints('https://westeurope.tts.speech.microsoft.com/').tts).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
    // a custom domain keeps its own host
    expect(azureEndpoints('https://sprache.example.com/').tts).toBe('https://sprache.example.com/tts/cognitiveservices/v1');
    expect(() => azureEndpoints('')).toThrow('Adresse der Ressource');
  });

  it('writes escaped SSML with language from the voice name and the speed as prosody', () => {
    expect(azureSsml('Müller & Söhne <GmbH>', 'de-DE-KatjaNeural')).toBe('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="de-DE"><voice name="de-DE-KatjaNeural">Müller &amp; Söhne &lt;GmbH&gt;</voice></speak>');
    expect(azureSsml('Hi', 'en-GB-RyanNeural', 1.25)).toContain('<prosody rate="+25%">Hi</prosody>');
    expect(azureSsml('Hi', 'en-GB-RyanNeural', 0.8)).toContain('rate="-20%"');
    expect(azureSsml('Hi', 'x"><evil/>')).not.toContain('<evil/>');
    expect(azureSsml('Hallo', 'custom-voice', undefined, 'de')).toContain('xml:lang="de-DE"');
  });

  it('speaks and transcribes with the subscription key header, and lists voices of a language', async () => {
    const r = rig((url) => {
      if (url.includes('voices/list')) return res(200, [{ ShortName: 'de-DE-KatjaNeural', LocalName: 'Katja', Locale: 'de-DE', Gender: 'Female' }, { ShortName: 'en-US-JennyNeural', DisplayName: 'Jenny', Locale: 'en-US', Gender: 'Female' }]);
      if (url.includes('tts.speech')) return res(200, MP3);
      return res(200, { combinedPhrases: [{ text: 'Guten Tag' }, { text: 'zusammen' }], duration: 4200 });
    });
    const conn = { provider: 'azure_speech', baseUrl: 'https://germanywestcentral.api.cognitive.microsoft.com', authStyle: 'header:ocp-apim-subscription-key' };
    const tts = await azureSpeechAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', voice: 'de-DE-ConradNeural', speed: 1.1 }));
    expect(r.seen[0].url).toBe('https://germanywestcentral.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(header(r.seen[0], 'ocp-apim-subscription-key')).toBe('key-123');
    expect(header(r.seen[0], 'content-type')).toBe('application/ssml+xml');
    expect(header(r.seen[0], 'x-microsoft-outputformat')).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(String(r.seen[0].init.body)).toContain('<voice name="de-DE-ConradNeural">');
    expect(tts).toMatchObject({ status: 'done' });
    const stt = await azureSpeechAdapter.submit(r.ctx(conn, 'stt', { audio: { url: 'x' }, language: 'de' }));
    expect(r.seen[1].url).toContain('speechtotext/transcriptions:transcribe');
    expect(String(r.seen[1].init.body)).toContain('"locales":["de-DE"]');
    expect(stt).toMatchObject({ status: 'done', text: 'Guten Tag zusammen', cost: { amount: 4, unit: 'Sekunden Audio' } });
    const voices = await azureSpeechAdapter.voices!({ conn: { connectionId: 'c', provider: 'azure_speech', apiKey: 'k', baseUrl: conn.baseUrl, authStyle: conn.authStyle }, fetch: r.fetch, language: 'de' });
    expect(voices).toEqual([{ id: 'de-DE-KatjaNeural', name: 'Katja (de-DE)', lang: 'de-DE', gender: 'Female' }]);
  });
});

describe('Google Cloud Speech', () => {
  it('picks the encoding from the recording and refuses what it cannot read', () => {
    expect(googleAudioConfig('audio/webm', 'de', '')).toMatchObject({ encoding: 'WEBM_OPUS', sampleRateHertz: 48000, languageCode: 'de-DE', model: 'latest_long' });
    expect(googleAudioConfig('audio/ogg', 'en', 'latest_short')).toMatchObject({ encoding: 'OGG_OPUS', languageCode: 'en-US', model: 'latest_short' });
    expect(googleAudioConfig('audio/mpeg', 'de', '').encoding).toBe('MP3');
    expect(googleAudioConfig('audio/flac', 'de', '').encoding).toBe('FLAC');
    expect(googleAudioConfig('audio/wav', 'de', '').encoding).toBe('ENCODING_UNSPECIFIED');
    expect(() => googleAudioConfig('audio/mp4', 'de', '')).toThrow('WAV, MP3, FLAC, WebM und Ogg');
  });

  it('speaks with the voice\'s language and speaking rate, and transcribes', async () => {
    const r = rig((url) => {
      if (url.includes('text:synthesize')) return res(200, { audioContent: MP3.toString('base64') });
      if (url.includes('speech:recognize')) return res(200, { results: [{ alternatives: [{ transcript: 'Hallo' }] }, { alternatives: [{ transcript: 'Welt' }] }] });
      return res(200, { voices: [{ name: 'de-DE-Neural2-F', languageCodes: ['de-DE'], ssmlGender: 'FEMALE' }] });
    });
    const conn = { provider: 'google_speech', authStyle: 'header:x-goog-api-key' };
    const tts = await googleSpeechAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', voice: 'de-DE-Neural2-B', speed: 1.3 }));
    expect(r.seen[0].url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect(header(r.seen[0], 'x-goog-api-key')).toBe('key-123');
    expect(r.seen[0].json).toMatchObject({ input: { text: 'Hallo' }, voice: { languageCode: 'de-DE', name: 'de-DE-Neural2-B' }, audioConfig: { audioEncoding: 'MP3', speakingRate: 1.3 } });
    expect((tts as any).outputs[0].data).toEqual(MP3);
    const stt = await googleSpeechAdapter.submit(r.ctx(conn, 'stt', { audio: { url: 'x', mime: 'audio/wav' }, language: 'de' }));
    expect(r.seen[1].url).toBe('https://speech.googleapis.com/v1/speech:recognize');
    expect(r.seen[1].json.config).toMatchObject({ languageCode: 'de-DE' });
    expect(stt).toMatchObject({ text: 'Hallo Welt' });
    const voices = await googleSpeechAdapter.voices!({ conn: { connectionId: 'c', provider: 'google_speech', apiKey: 'k', authStyle: conn.authStyle }, fetch: r.fetch, language: 'de' });
    expect(r.seen[2].url).toBe('https://texttospeech.googleapis.com/v1/voices?languageCode=de-DE');
    expect(voices[0]).toMatchObject({ id: 'de-DE-Neural2-F', lang: 'de-DE', gender: 'female' });
    await expect(googleSpeechAdapter.submit(rig(() => res(200, {})).ctx(conn, 'audio_tts', { prompt: 'x' }))).rejects.toThrow('keine Sprachausgabe');
  });
});

describe('OpenAI-compatible speech servers (Kokoro, Piper, Whisper, Groq, Azure OpenAI)', () => {
  it('uses the OpenAI wire format at the connection\'s own address – no key needed for a local server', async () => {
    const r = rig((url) => (url.endsWith('/audio/speech') ? res(200, MP3) : res(200, { text: 'lokal erkannt' })));
    const conn = { provider: 'speech_local', baseUrl: 'http://localhost:8880/v1', apiKey: '' };
    const tts = await openaiCompatAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', voice: 'af_bella', speed: 1.1 }, 'kokoro'));
    expect(r.seen[0].url).toBe('http://localhost:8880/v1/audio/speech');
    expect(r.seen[0].json).toMatchObject({ model: 'kokoro', input: 'Hallo', voice: 'af_bella', speed: 1.1 });
    expect(header(r.seen[0], 'authorization')).toBeUndefined();
    expect(tts).toMatchObject({ status: 'done' });
    const stt = await openaiCompatAdapter.submit(r.ctx(conn, 'stt', { audio: { url: 'x' }, language: 'de' }, 'whisper-1'));
    expect(r.seen[1].url).toBe('http://localhost:8880/v1/audio/transcriptions');
    expect(stt).toMatchObject({ text: 'lokal erkannt' });
    await expect(openaiCompatAdapter.submit(r.ctx({ provider: 'speech_local', baseUrl: '' }, 'audio_tts', { prompt: 'x' }))).rejects.toThrow('Adresse');
  });

  it('lists the voices of servers that have a voice endpoint (Kokoro) and returns none otherwise', async () => {
    const withList = rig(() => res(200, { voices: ['af_bella', 'bm_george'] }));
    expect(await openaiCompatAdapter.voices!({ conn: { connectionId: 'c', provider: 'speech_local', apiKey: '', baseUrl: 'http://localhost:8880/v1' }, fetch: withList.fetch })).toEqual([
      { id: 'af_bella', name: 'af_bella' },
      { id: 'bm_george', name: 'bm_george' },
    ]);
    expect(withList.seen[0].url).toBe('http://localhost:8880/v1/audio/voices');
    const none = rig(() => res(404, {}));
    expect(await openaiCompatAdapter.voices!({ conn: { connectionId: 'c', provider: 'speech_local', apiKey: '', baseUrl: 'http://localhost:8880/v1' }, fetch: none.fetch })).toEqual([]);
  });

  it('addresses Azure OpenAI by deployment with the api-key header (or the v1 API without a deployment)', async () => {
    const r = rig((url) => (url.includes('/audio/speech') ? res(200, MP3) : res(200, { text: 'azure erkannt' })));
    const conn = { provider: 'azure', baseUrl: 'https://mein-azure.openai.azure.com', authStyle: 'header:api-key', options: { api_version: '2025-03-01-preview' } };
    await openaiCompatAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', voice: 'nova' }, 'tts-deploy'));
    expect(r.seen[0].url).toBe('https://mein-azure.openai.azure.com/openai/deployments/tts-deploy/audio/speech?api-version=2025-03-01-preview');
    expect(header(r.seen[0], 'api-key')).toBe('key-123');
    expect(header(r.seen[0], 'authorization')).toBeUndefined();
    const stt = await openaiCompatAdapter.submit(r.ctx(conn, 'stt', { audio: { url: 'x' } }, 'whisper-deploy'));
    expect(r.seen[1].url).toContain('/openai/deployments/whisper-deploy/audio/transcriptions?api-version=');
    expect(stt).toMatchObject({ text: 'azure erkannt' });
    await expect(openaiCompatAdapter.submit(r.ctx(conn, 'audio_tts', { prompt: 'x' }, ''))).rejects.toThrow('Deployments');
    await openaiCompatAdapter.submit(r.ctx({ ...conn, baseUrl: 'https://mein-azure.openai.azure.com/openai/v1' }, 'audio_tts', { prompt: 'x' }, 'gpt-4o-mini-tts'));
    expect(r.seen[2].url).toBe('https://mein-azure.openai.azure.com/openai/v1/audio/speech');
  });
});

describe('OpenAI and ElevenLabs additions', () => {
  it('gives gpt-4o-mini-tts an instruction and other models a speed factor', async () => {
    const r = rig(() => res(200, MP3));
    const conn = { provider: 'openai', baseUrl: 'https://api.openai.com/v1' };
    await ADAPTERS.openai.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', instructions: 'Freundlich und ruhig', speed: 1.4 }, 'gpt-4o-mini-tts'));
    expect(r.seen[0].json).toMatchObject({ model: 'gpt-4o-mini-tts', instructions: 'Freundlich und ruhig' });
    expect(r.seen[0].json.speed).toBeUndefined();
    await ADAPTERS.openai.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hallo', instructions: 'ignoriert', speed: 9 }, 'tts-1'));
    expect(r.seen[1].json).toMatchObject({ model: 'tts-1', speed: 4 });
    expect(r.seen[1].json.instructions).toBeUndefined();
  });

  it('sends the ElevenLabs speed as voice setting within the allowed range and lists language and gender', async () => {
    const r = rig((url) => (url.includes('/v2/voices') ? res(200, { voices: [{ voice_id: 'abc', name: 'Rachel', category: 'premade', preview_url: 'https://x/p.mp3', labels: { language: 'en', gender: 'female' } }] }) : res(200, MP3)));
    const conn = { provider: 'elevenlabs', authStyle: 'header:xi-api-key' };
    await ADAPTERS.elevenlabs.submit(r.ctx(conn, 'audio_tts', { prompt: 'Hi', voice: 'abc', speed: 3 }));
    expect(r.seen[0].json.voice_settings).toEqual({ speed: 1.2 });
    const voices = await ADAPTERS.elevenlabs.voices!({ conn: { connectionId: 'c', provider: 'elevenlabs', apiKey: 'k', authStyle: conn.authStyle }, fetch: r.fetch });
    expect(voices).toEqual([{ id: 'abc', name: 'Rachel', preview: 'https://x/p.mp3', lang: 'en', gender: 'female' }]);
  });
});
