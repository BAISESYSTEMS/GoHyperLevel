import { authFor, baseOf, ensureOk, jsonCall, multipart } from './genmedia/http.js';
import { registerAdapter } from './genmedia/index.js';
import { MAX_INPUT_BYTES } from './genmedia/media.js';
import { openaiAdapter } from './genmedia/openai.js';
import { ProviderError, type Adapter, type AdapterCtx, type Step, type VoiceEntry } from './genmedia/types.js';

/**
 * Speech providers the KI-Studio adapters did not cover yet – Deepgram (Nova, Aura), Cartesia (Sonic, Ink),
 * AssemblyAI, Azure Speech, Google Cloud Speech and any OpenAI-compatible speech server (Kokoro, Piper,
 * Whisper, Groq, Mistral Voxtral, Azure OpenAI). They are ordinary genmedia adapters, registered with
 * `registerAdapter`, so the KI-Studio, the workflow action "Text in Sprache", the MCP tools and the voice
 * layer (services/voice-engine.ts) all use the same code. Live streaming lives in voice-stream-*.ts.
 *
 * Endpoints follow the providers' public docs (October 2026) and are tested against fakes, not live accounts.
 */

const enc = encodeURIComponent;
const MB60 = 60 * 1024 * 1024;

/** `de-DE` / `de_DE` / `DE` → `de`. */
export const langOf = (l?: string) => String(l ?? '').trim().toLowerCase().split(/[-_]/)[0];
const LOCALES: Record<string, string> = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pt: 'pt-PT', pl: 'pl-PL', tr: 'tr-TR', sv: 'sv-SE', da: 'da-DK', cs: 'cs-CZ', ru: 'ru-RU', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' };
/** `de` → `de-DE`; a full locale stays as it is. */
export const localeOf = (l?: string, fallback = 'de-DE') => (/^[a-z]{2,3}[-_][A-Za-z]{2,4}$/.test(String(l ?? '')) ? String(l).replace('_', '-') : (LOCALES[langOf(l)] ?? fallback));

const audioOf = async (ctx: AdapterCtx) => {
  if (!ctx.input.audio) throw new ProviderError('Bitte eine Audio- oder Videodatei angeben');
  return ctx.bytes(ctx.input.audio, MAX_INPUT_BYTES);
};
const rawParams = (p: Record<string, any> | undefined) => Object.fromEntries(Object.entries(p ?? {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]));
const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

// --- Deepgram ----------------------------------------------------------------------------------------------

const DG_BASE = 'https://api.deepgram.com';
/** Aura voices (the voice is the model). Not a live list – any id from the Deepgram docs works as free text. */
export const DEEPGRAM_VOICES: VoiceEntry[] = [
  ...['viktoria', 'julius', 'elara', 'aurelia', 'lara', 'fabian', 'kara'].map((n) => ({ id: `aura-2-${n}-de`, name: `${n[0].toUpperCase()}${n.slice(1)} (Deutsch)`, lang: 'de' })),
  ...['thalia', 'apollo', 'andromeda', 'helena', 'arcas', 'luna'].map((n) => ({ id: `aura-2-${n}-en`, name: `${n[0].toUpperCase()}${n.slice(1)} (Englisch)`, lang: 'en' })),
];

export const deepgramAdapter: Adapter = {
  id: 'deepgram',
  label: 'Deepgram',
  capabilities: ['audio_tts', 'stt'],
  defaultBase: DG_BASE,
  defaultAuth: 'token',
  models: {
    audio_tts: DEEPGRAM_VOICES.slice(0, 3).map((v) => ({ id: v.id, label: `Aura 2 ${v.name}` })),
    stt: [
      { id: 'nova-3', label: 'Nova 3 (beste Qualität)' },
      { id: 'nova-2', label: 'Nova 2' },
    ],
  },
  voices: async () => DEEPGRAM_VOICES,
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'token');
    const base = baseOf(ctx.conn, DG_BASE);
    if (ctx.capability === 'audio_tts') {
      const text = ctx.input.prompt.slice(0, 2000);
      const pick = [ctx.input.voice, ctx.model].find((x) => x && /^aura/i.test(x)) || 'aura-2-viktoria-de';
      const r = await ctx.fetch(`${base}/v1/speak?model=${enc(pick)}&encoding=mp3`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify({ text }), timeoutMs: 90_000, maxBytes: MB60 });
      ensureOk(r, 'Deepgram');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }], cost: { amount: text.length, unit: 'Zeichen' } };
    }
    if (ctx.capability === 'stt') {
      const f = await audioOf(ctx);
      const q = new URLSearchParams({ model: ctx.model || 'nova-3', smart_format: 'true', punctuate: 'true' });
      if (ctx.input.language) q.set('language', langOf(ctx.input.language));
      else q.set('detect_language', 'true');
      for (const [k, v] of Object.entries(ctx.input.params ?? {})) q.set(k, String(v));
      const r = await ctx.fetch(`${base}/v1/listen?${q}`, { method: 'POST', headers: { ...headers, 'content-type': f.mime, accept: 'application/json' }, body: f.data, timeoutMs: 300_000 });
      ensureOk(r, 'Deepgram');
      const j = r.json();
      const alt = j?.results?.channels?.[0]?.alternatives?.[0];
      if (typeof alt?.transcript !== 'string') throw new ProviderError('Deepgram hat keinen Text geliefert');
      const secs = Number(j?.metadata?.duration);
      return { status: 'done', outputs: [], text: alt.transcript.trim(), cost: Number.isFinite(secs) && secs > 0 ? { amount: Math.round(secs), unit: 'Sekunden Audio' } : undefined };
    }
    throw new ProviderError('Deepgram kann das nicht');
  },
};

// --- Cartesia ---------------------------------------------------------------------------------------------------

const CARTESIA_BASE = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2025-04-16';
const cartesiaHeaders = (ctx: Pick<AdapterCtx, 'conn'>) => ({ 'cartesia-version': CARTESIA_VERSION, ...authFor(ctx.conn, 'header:x-api-key').headers });

export const cartesiaAdapter: Adapter = {
  id: 'cartesia',
  label: 'Cartesia',
  capabilities: ['audio_tts', 'stt'],
  defaultBase: CARTESIA_BASE,
  defaultAuth: 'header:x-api-key',
  models: {
    audio_tts: [
      { id: 'sonic-2', label: 'Sonic 2' },
      { id: 'sonic-turbo', label: 'Sonic Turbo (schnellste)' },
      { id: 'sonic-3', label: 'Sonic 3 (ausdrucksstark, 40+ Sprachen)' },
    ],
    stt: [{ id: 'ink-whisper', label: 'Ink Whisper' }],
  },
  async voices(ctx) {
    const q = ctx.language ? `&language=${enc(langOf(ctx.language))}` : '';
    const r = await jsonCall(ctx.fetch, 'GET', `${baseOf(ctx.conn, CARTESIA_BASE)}/voices?limit=100${q}`, cartesiaHeaders(ctx), undefined, 20_000, 'Cartesia');
    const list: any[] = Array.isArray(r) ? r : (r.data ?? r.voices ?? []);
    return list.map((v) => ({ id: String(v.id), name: String(v.name ?? v.id), lang: v.language || undefined, gender: v.gender || undefined, preview: undefined }));
  },
  async submit(ctx): Promise<Step> {
    const headers = cartesiaHeaders(ctx);
    const base = baseOf(ctx.conn, CARTESIA_BASE);
    if (ctx.capability === 'audio_tts') {
      if (!ctx.input.voice) throw new ProviderError('Bitte eine Stimme wählen (Cartesia braucht eine Stimmen-ID aus der Stimmenliste)');
      const model = ctx.model || 'sonic-2';
      const body = {
        model_id: model,
        transcript: ctx.input.prompt,
        voice: { mode: 'id', id: ctx.input.voice },
        output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
        language: langOf(ctx.input.language) || 'de',
        ...(ctx.input.speed && ctx.input.speed !== 1 && /sonic-3/.test(model) ? { generation_config: { speed: Math.max(0.6, Math.min(1.5, ctx.input.speed)) } } : {}),
        ...(ctx.input.params ?? {}),
      };
      const r = await ctx.fetch(`${base}/tts/bytes`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body), timeoutMs: 90_000, maxBytes: MB60 });
      ensureOk(r, 'Cartesia');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }], cost: { amount: ctx.input.prompt.length, unit: 'Zeichen' } };
    }
    if (ctx.capability === 'stt') {
      const f = await audioOf(ctx);
      const form = multipart({ model: ctx.model || 'ink-whisper', language: langOf(ctx.input.language) || 'de', file: { filename: ctx.input.audio?.name || 'audio', contentType: f.mime, data: f.data }, ...rawParams(ctx.input.params) } as any);
      const r = await ctx.fetch(`${base}/stt`, { method: 'POST', headers: { ...headers, 'content-type': form.contentType }, body: form.body, timeoutMs: 300_000 });
      ensureOk(r, 'Cartesia');
      const j = r.json();
      if (typeof j?.text !== 'string') throw new ProviderError('Cartesia hat keinen Text geliefert');
      return { status: 'done', outputs: [], text: j.text.trim() };
    }
    throw new ProviderError('Cartesia kann das nicht');
  },
};

// --- AssemblyAI ---------------------------------------------------------------------------------------------------

const AAI_BASE = 'https://api.assemblyai.com';

export const assemblyaiAdapter: Adapter = {
  id: 'assemblyai',
  label: 'AssemblyAI',
  capabilities: ['stt'],
  defaultBase: AAI_BASE,
  defaultAuth: 'header:authorization',
  models: { stt: [] },
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'header:authorization');
    const base = baseOf(ctx.conn, AAI_BASE);
    if (ctx.capability !== 'stt') throw new ProviderError('AssemblyAI kann nur transkribieren');
    const f = await audioOf(ctx);
    const up = await ctx.fetch(`${base}/v2/upload`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: f.data, timeoutMs: 300_000 });
    ensureOk(up, 'AssemblyAI');
    const upload = up.json()?.upload_url;
    if (!upload) throw new ProviderError('AssemblyAI hat keine Upload-Adresse geliefert');
    const body: Record<string, any> = { audio_url: upload, punctuate: true, format_text: true };
    if (ctx.input.language) body.language_code = langOf(ctx.input.language);
    else body.language_detection = true;
    if (ctx.model) {
      if (/^universal/i.test(ctx.model)) body.speech_models = [ctx.model];
      else body.speech_model = ctx.model;
    }
    if (ctx.input.prompt) body.word_boost = ctx.input.prompt.split(/[,;\n]+/).map((w) => w.trim()).filter(Boolean).slice(0, 100);
    const t = await jsonCall(ctx.fetch, 'POST', `${base}/v2/transcript`, headers, { ...body, ...(ctx.input.params ?? {}) }, 60_000, 'AssemblyAI');
    if (!t?.id) throw new ProviderError('AssemblyAI hat keine Auftrags-ID geliefert');
    return { status: 'pending', state: { id: String(t.id) }, pollAfterMs: 2500 };
  },
  async poll(ctx, state): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'header:authorization');
    const t = await jsonCall(ctx.fetch, 'GET', `${baseOf(ctx.conn, AAI_BASE)}/v2/transcript/${enc(String(state.id))}`, headers, undefined, 30_000, 'AssemblyAI');
    if (t.status === 'completed') {
      const secs = Number(t.audio_duration);
      return { status: 'done', outputs: [], text: String(t.text ?? '').trim(), cost: Number.isFinite(secs) && secs > 0 ? { amount: Math.round(secs), unit: 'Sekunden Audio' } : undefined };
    }
    if (t.status === 'error') return { status: 'failed', error: `AssemblyAI: ${String(t.error ?? 'Transkription fehlgeschlagen').slice(0, 300)}` };
    return { status: 'pending', state, pollAfterMs: 2500 };
  },
};

// --- Azure Speech ---------------------------------------------------------------------------------------------------

/** Region and endpoints from the address in the connection (portal endpoint, a regional speech host or a custom domain). */
export function azureEndpoints(baseUrl: string): { tts: string; stt: string; voices: string } {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new ProviderError('Azure Speech: Adresse der Ressource fehlt (https://<region>.api.cognitive.microsoft.com)');
  }
  const m = /^([a-z0-9-]+)\.(?:api\.cognitive|tts\.speech|stt\.speech|cognitiveservices)\.(?:microsoft|azure)\.(?:com|us|cn)$/.exec(host);
  if (m) {
    const region = m[1];
    return {
      tts: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      stt: `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`,
      voices: `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    };
  }
  const b = baseUrl.replace(/\/+$/, '');
  return { tts: `${b}/tts/cognitiveservices/v1`, stt: `${b}/speechtotext/transcriptions:transcribe?api-version=2024-11-15`, voices: `${b}/tts/cognitiveservices/voices/list` };
}

/** SSML for one utterance (voice name decides the language). */
export function azureSsml(text: string, voice: string, speed?: number, language?: string): string {
  const lang = /^([a-z]{2,3}-[A-Z]{2})/.exec(voice)?.[1] ?? localeOf(language);
  const rate = speed && speed !== 1 ? ` rate="${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%"` : '';
  const body = xmlEsc(text);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${xmlEsc(voice)}">${rate ? `<prosody${rate}>${body}</prosody>` : body}</voice></speak>`;
}

export const azureSpeechAdapter: Adapter = {
  id: 'azure_speech',
  label: 'Azure Speech',
  capabilities: ['audio_tts', 'stt'],
  defaultBase: '',
  defaultAuth: 'header:ocp-apim-subscription-key',
  models: { audio_tts: [{ id: 'de-DE-KatjaNeural', label: 'Katja (de-DE)' }], stt: [{ id: 'fast-transcription', label: 'Schnelle Transkription' }] },
  async voices(ctx) {
    const ep = azureEndpoints(ctx.conn.baseUrl ?? '');
    const r = await jsonCall(ctx.fetch, 'GET', ep.voices, authFor(ctx.conn, 'header:ocp-apim-subscription-key').headers, undefined, 20_000, 'Azure Speech');
    const want = ctx.language ? langOf(ctx.language) : '';
    return ((Array.isArray(r) ? r : []) as any[])
      .filter((v) => !want || String(v.Locale ?? '').toLowerCase().startsWith(want))
      .map((v) => ({ id: String(v.ShortName), name: `${v.LocalName ?? v.DisplayName ?? v.ShortName} (${v.Locale})`, lang: v.Locale || undefined, gender: v.Gender || undefined }));
  },
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'header:ocp-apim-subscription-key');
    const ep = azureEndpoints(ctx.conn.baseUrl ?? '');
    if (ctx.capability === 'audio_tts') {
      const voice = ctx.input.voice || 'de-DE-KatjaNeural';
      const r = await ctx.fetch(ep.tts, { method: 'POST', headers: { ...headers, 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': 'audio-24khz-48kbitrate-mono-mp3', 'user-agent': 'HyperLevel' }, body: azureSsml(ctx.input.prompt, voice, ctx.input.speed, ctx.input.language), timeoutMs: 90_000, maxBytes: MB60 });
      ensureOk(r, 'Azure Speech');
      return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }], cost: { amount: ctx.input.prompt.length, unit: 'Zeichen' } };
    }
    if (ctx.capability === 'stt') {
      const f = await audioOf(ctx);
      const locales = ctx.input.language ? [localeOf(ctx.input.language)] : ['de-DE', 'en-US'];
      const form = multipart({ audio: { filename: ctx.input.audio?.name || 'audio', contentType: f.mime, data: f.data }, definition: JSON.stringify({ locales, ...(ctx.input.params ?? {}) }) });
      const r = await ctx.fetch(ep.stt, { method: 'POST', headers: { ...headers, 'content-type': form.contentType, accept: 'application/json' }, body: form.body, timeoutMs: 300_000 });
      ensureOk(r, 'Azure Speech');
      const j = r.json();
      const text = Array.isArray(j?.combinedPhrases) ? j.combinedPhrases.map((p: any) => p.text ?? '').join(' ').trim() : '';
      if (!text && !Array.isArray(j?.combinedPhrases)) throw new ProviderError('Azure Speech hat keinen Text geliefert');
      const ms = Number(j?.duration ?? j?.durationMilliseconds);
      return { status: 'done', outputs: [], text, cost: Number.isFinite(ms) && ms > 0 ? { amount: Math.round(ms / 1000), unit: 'Sekunden Audio' } : undefined };
    }
    throw new ProviderError('Azure Speech kann das nicht');
  },
};

// --- Google Cloud Speech -------------------------------------------------------------------------------------------------

const GTTS = 'https://texttospeech.googleapis.com';
const GSTT = 'https://speech.googleapis.com';

/** Cloud STT wants the encoding named for everything but WAV/FLAC (which carry it in the header). */
export function googleAudioConfig(mime: string, language: string, model: string): Record<string, any> {
  const config: Record<string, any> = { languageCode: localeOf(language), enableAutomaticPunctuation: true, model: model || 'latest_long' };
  if (/webm/.test(mime)) Object.assign(config, { encoding: 'WEBM_OPUS', sampleRateHertz: 48000 });
  else if (/ogg/.test(mime)) Object.assign(config, { encoding: 'OGG_OPUS', sampleRateHertz: 48000 });
  else if (/mpeg|mp3/.test(mime)) Object.assign(config, { encoding: 'MP3', sampleRateHertz: 44100 });
  else if (/flac/.test(mime)) config.encoding = 'FLAC';
  else if (/wav/.test(mime)) config.encoding = 'ENCODING_UNSPECIFIED';
  else throw new ProviderError('Google Speech-to-Text versteht WAV, MP3, FLAC, WebM und Ogg – diese Aufnahme hat ein anderes Format');
  return config;
}

export const googleSpeechAdapter: Adapter = {
  id: 'google_speech',
  label: 'Google Cloud Speech',
  capabilities: ['audio_tts', 'stt'],
  defaultBase: GTTS,
  defaultAuth: 'header:x-goog-api-key',
  models: { stt: [{ id: 'latest_long', label: 'Latest long' }, { id: 'latest_short', label: 'Latest short' }] },
  async voices(ctx) {
    const { headers } = authFor(ctx.conn, 'header:x-goog-api-key');
    const q = ctx.language ? `?languageCode=${enc(localeOf(ctx.language))}` : '';
    const r = await jsonCall(ctx.fetch, 'GET', `${GTTS}/v1/voices${q}`, headers, undefined, 20_000, 'Google Speech');
    return ((r.voices ?? []) as any[]).map((v) => ({ id: String(v.name), name: `${v.name}${v.ssmlGender ? ` (${String(v.ssmlGender).toLowerCase()})` : ''}`, lang: (v.languageCodes ?? [])[0], gender: v.ssmlGender ? String(v.ssmlGender).toLowerCase() : undefined }));
  },
  async submit(ctx): Promise<Step> {
    const { headers } = authFor(ctx.conn, 'header:x-goog-api-key');
    if (ctx.capability === 'audio_tts') {
      const voice = ctx.input.voice || 'de-DE-Neural2-F';
      const languageCode = /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0] ?? localeOf(ctx.input.language);
      const body = {
        input: { text: ctx.input.prompt },
        voice: { languageCode, name: voice },
        audioConfig: { audioEncoding: 'MP3', ...(ctx.input.speed && ctx.input.speed !== 1 ? { speakingRate: Math.max(0.25, Math.min(4, ctx.input.speed)) } : {}) },
        ...(ctx.input.params ?? {}),
      };
      const r = await jsonCall(ctx.fetch, 'POST', `${GTTS}/v1/text:synthesize`, headers, body, 90_000, 'Google Speech');
      if (!r.audioContent) throw new ProviderError('Google Speech hat keine Sprachausgabe geliefert');
      return { status: 'done', outputs: [{ data: Buffer.from(r.audioContent, 'base64'), mime: 'audio/mpeg' }], cost: { amount: ctx.input.prompt.length, unit: 'Zeichen' } };
    }
    if (ctx.capability === 'stt') {
      const f = await audioOf(ctx);
      const r = await jsonCall(ctx.fetch, 'POST', `${GSTT}/v1/speech:recognize`, headers, { config: googleAudioConfig(f.mime, ctx.input.language || 'de', ctx.model), audio: { content: f.data.toString('base64') }, ...(ctx.input.params ?? {}) }, 120_000, 'Google Speech');
      const text = ((r.results ?? []) as any[]).map((x) => x.alternatives?.[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim();
      return { status: 'done', outputs: [], text };
    }
    throw new ProviderError('Google Speech kann das nicht');
  },
};

// --- OpenAI-compatible speech servers (Kokoro, Piper, Whisper, Groq, Mistral, LiteLLM, Azure OpenAI) ----------------------------

const AZURE_OPENAI_VERSION = '2025-03-01-preview';
const AZURE_V1 = /\/openai\/v1$/;

/** Azure OpenAI addresses audio per deployment (the model field) unless the new v1 API is used. */
function azureSpeechUrl(ctx: AdapterCtx, path: 'speech' | 'transcriptions'): string {
  const b = baseOf(ctx.conn, '');
  if (AZURE_V1.test(b)) return `${b}/audio/${path}`;
  const dep = ctx.model;
  if (!dep) throw new ProviderError('Azure OpenAI: bitte den Namen des Deployments als Modell eintragen');
  return `${b.replace(/\/openai$/, '')}/openai/deployments/${enc(dep)}/audio/${path}?api-version=${enc(String(ctx.conn.options?.api_version || AZURE_OPENAI_VERSION))}`;
}

export const openaiCompatAdapter: Adapter = {
  id: 'openai_compat',
  label: 'OpenAI-kompatibler Sprachserver',
  capabilities: ['audio_tts', 'stt'],
  defaultBase: '',
  defaultAuth: 'bearer',
  models: { audio_tts: [{ id: 'kokoro', label: 'Kokoro' }, { id: 'tts-1', label: 'tts-1' }], stt: [{ id: 'whisper-1', label: 'Whisper' }] },
  async voices(ctx) {
    // Kokoro-FastAPI and some others list their voices; everything else takes free text.
    try {
      const r = await ctx.fetch(`${baseOf(ctx.conn, '')}/audio/voices`, { method: 'GET', headers: { accept: 'application/json', ...authFor(ctx.conn, 'bearer').headers }, timeoutMs: 8000 });
      if (!r.ok) return [];
      const j = r.json();
      const list: any[] = Array.isArray(j) ? j : (j?.voices ?? j?.data ?? []);
      return list.map((v) => (typeof v === 'string' ? { id: v, name: v } : { id: String(v.id ?? v.name), name: String(v.name ?? v.id) })).filter((v) => v.id);
    } catch {
      return [];
    }
  },
  async submit(ctx): Promise<Step> {
    if (ctx.conn.provider === 'azure') {
      // Azure OpenAI: same bodies, own URLs and the api-key header.
      const { headers } = authFor(ctx.conn, 'header:api-key');
      if (ctx.capability === 'audio_tts') {
        const body = { model: ctx.model, input: ctx.input.prompt.slice(0, 4096), voice: ctx.input.voice || 'alloy', response_format: 'mp3', ...(ctx.input.speed && ctx.input.speed !== 1 ? { speed: ctx.input.speed } : {}), ...(ctx.input.params ?? {}) };
        const r = await ctx.fetch(azureSpeechUrl(ctx, 'speech'), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 120_000, maxBytes: MB60 });
        ensureOk(r, 'Azure OpenAI');
        return { status: 'done', outputs: [{ data: r.body, mime: 'audio/mpeg' }], cost: { amount: ctx.input.prompt.length, unit: 'Zeichen' } };
      }
      const f = await audioOf(ctx);
      const form = multipart({ model: ctx.model, response_format: 'json', language: langOf(ctx.input.language) || undefined, file: { filename: ctx.input.audio?.name || 'audio', contentType: f.mime, data: f.data }, ...rawParams(ctx.input.params) } as any);
      const r = await ctx.fetch(azureSpeechUrl(ctx, 'transcriptions'), { method: 'POST', headers: { ...headers, 'content-type': form.contentType }, body: form.body, timeoutMs: 300_000 });
      ensureOk(r, 'Azure OpenAI');
      const j = r.json();
      return { status: 'done', outputs: [], text: typeof j?.text === 'string' ? j.text : r.text() };
    }
    // Everyone else speaks the OpenAI wire format at the connection's base address.
    const b = baseOf(ctx.conn, '');
    if (!b) throw new ProviderError('Für diese Verbindung fehlt die Adresse des Servers');
    return openaiAdapter.submit({ ...ctx, conn: { ...ctx.conn, baseUrl: b } });
  },
};

/** Registers everything above with the media job engine (KI-Studio, workflows, MCP) – idempotent. */
export function registerVoiceAdapters() {
  registerAdapter(deepgramAdapter);
  registerAdapter(cartesiaAdapter);
  registerAdapter(assemblyaiAdapter);
  registerAdapter(azureSpeechAdapter);
  registerAdapter(googleSpeechAdapter);
  // Providers that only offer speech through the OpenAI wire format; "custom" stays the HTTP template for media.
  registerAdapter(openaiCompatAdapter, ['speech_local', 'groq', 'mistral', 'litellm', 'azure']);
}
