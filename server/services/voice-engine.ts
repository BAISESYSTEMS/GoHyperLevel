import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { adapterCtx, registry } from './genmedia/engine.js';
import { checkUrl, gmFetch, sleep } from './genmedia/http.js';
import { adapterFor, supports } from './genmedia/index.js';
import { sniff } from './genmedia/media.js';
import { ProviderError, type AiConnection, type GenInput, type Step } from './genmedia/types.js';
import { presetById } from './ai-presets.js';
import { registerVoiceAdapters } from './voice-adapters.js';
import { parseWav, wavToUlaw8k } from './voice-audio.js';
import { withVoiceDefaults, type VoiceSettings } from './voice-settings.js';
import { BatchLiveStt, STT_OPENERS } from './voice-stream-stt.js';
import { TTS_STREAMERS } from './voice-stream-tts.js';
import { VoiceError, type FetchFn, type LiveStt, type LiveSttHandlers, type LiveSttOpts, type StreamCtx, type TtsStreamer, type VoiceCap, type VoiceInfo } from './voice-types.js';
import { defaultWsClient, type WsClientFactory } from './voice-ws.js';

/**
 * The voice layer's engine: text to speech and speech to text with the sub-account's own provider keys (the
 * BYOK registry, `app.services.aiConnections`). One-shot calls go through the KI-Studio adapters (the same
 * code the studio, the workflow action and the MCP tools use), live calls (phone streams) through the
 * streamers/openers of voice-stream-*.ts. Keys are looked up again on every call – revoking a connection
 * stops its calls at once. Test hooks: `app.services.voiceFetch` (streaming fetch), `app.services.voiceWs`
 * (WebSocket factory), `app.services.genmediaFetch` (one-shot provider HTTP).
 */

/** Longest text spoken in one call (providers refuse more; the phone speaks sentence by sentence anyway). */
export const MAX_TTS_CHARS = 4000;
/** Largest recording that is transcribed (a few minutes of speech are about 1 MB). */
export const MAX_STT_BYTES = 15 * 1024 * 1024;

const NO_TTS = 'Für die Sprachausgabe fehlt ein Anbieter: unter Einstellungen → KI-Anbieter eine Verbindung mit „Sprachausgabe“ anlegen (z. B. OpenAI, ElevenLabs, Deepgram, Cartesia, Azure, Google oder ein lokaler Sprachserver).';
const NO_STT = 'Für die Spracherkennung fehlt ein Anbieter: unter Einstellungen → KI-Anbieter eine Verbindung mit „Transkription“ anlegen (z. B. OpenAI, Deepgram, ElevenLabs, AssemblyAI, Groq oder ein lokaler Whisper-Server).';

let registered = false;
/** Registers the speech adapters with the media engine once (idempotent; the voice module calls it on start). */
export function ensureVoiceAdapters() {
  if (registered) return;
  registered = true;
  registerVoiceAdapters();
}

/** A failure the browser/MCP caller should see as "bad gateway" with a readable message. */
export const asHttp = (e: unknown): HttpError => {
  if (e instanceof HttpError) return e;
  if (e instanceof VoiceError || e instanceof ProviderError) return new HttpError(502, e.message);
  return new HttpError(500, (e as Error)?.message || 'Fehler');
};

// --- settings (table of modules/voice.ts) ------------------------------------------------------------------------

export function loadVoiceSettings(app: App, locationId: string): VoiceSettings {
  try {
    const row = app.db.get<{ data: string }>('SELECT data FROM voice_settings WHERE location_id = ?', locationId);
    return withVoiceDefaults(row ? JSON.parse(row.data) : null);
  } catch {
    return withVoiceDefaults(null);
  }
}

// --- connections -----------------------------------------------------------------------------------------------

/** The sub-account's connection for speech (routing "Sprachausgabe" / "Transkription", or the one asked for). */
export async function voiceConnection(app: App, locationId: string, cap: VoiceCap, connectionId?: string | null): Promise<AiConnection> {
  ensureVoiceAdapters();
  const reg = registry(app);
  const none = cap === 'audio_tts' ? NO_TTS : NO_STT;
  if (!reg) throw new HttpError(409, none);
  const conn = (await reg.resolve(locationId, cap, connectionId || undefined)) as AiConnection | null;
  if (!conn) throw new HttpError(409, connectionId ? 'Diese KI-Verbindung gibt es nicht (mehr) oder sie kann das nicht – bitte unter Einstellungen → KI-Anbieter prüfen' : none);
  // Local speech servers (Kokoro, Whisper …) need no key; every hosted provider does.
  const preset = presetById(conn.provider);
  if (!conn.apiKey && (preset ? preset.keyRequired : conn.provider !== 'custom_http')) throw new HttpError(409, 'Für diese KI-Verbindung ist kein Schlüssel hinterlegt');
  return conn;
}

/** The connection for `cap`, or null when there is none (or it has no key) – for places that cannot await, like TwiML builders. */
export function peekConnection(app: App, locationId: string, cap: VoiceCap, connectionId?: string | null): AiConnection | null {
  ensureVoiceAdapters();
  try {
    const c = registry(app)?.resolve(locationId, cap, connectionId || undefined) as AiConnection | null | undefined;
    if (!c) return null;
    const preset = presetById(c.provider);
    return c.apiKey || (preset ? !preset.keyRequired : c.provider === 'custom_http') ? c : null;
  } catch {
    return null;
  }
}

/** Whether a usable connection for `cap` exists. */
export const hasVoiceConnection = (app: App, locationId: string, cap: VoiceCap, connectionId?: string | null) => !!peekConnection(app, locationId, cap, connectionId);

// --- one-shot calls (KI-Studio adapters) ---------------------------------------------------------------------------

async function runAdapter(app: App, locationId: string, conn: AiConnection, cap: VoiceCap, model: string, input: GenInput, bytes?: { data: Buffer; mime: string }): Promise<Extract<Step, { status: 'done' }>> {
  const adapter = adapterFor(conn.provider);
  if (!supports(adapter, cap) || (adapter.id === 'custom_http' && cap === 'stt')) {
    throw new VoiceError(`${conn.label || adapter.label} kann ${cap === 'audio_tts' ? 'keine Sprachausgabe' : 'keine Transkription'}${adapter.id === 'custom_http' ? ' (eigene HTTP-Anbieter nur für Sprachausgabe)' : ''}`, false, 0, conn.provider);
  }
  const base = adapterCtx(app, { model, capability: cap, input, location_id: locationId }, conn, null);
  const ctx = bytes ? { ...base, bytes: async () => bytes } : base;
  let step = await adapter.submit(ctx);
  // Providers that work asynchronously (Replicate, AssemblyAI) are polled for up to ~2 minutes.
  for (let i = 0; step.status === 'pending' && i < 60 && adapter.poll; i++) {
    await sleep(Math.max(250, Math.min(5000, step.pollAfterMs ?? 2000)));
    step = await adapter.poll(ctx, step.state);
  }
  if (step.status === 'failed') throw new VoiceError(step.error, false, 0, conn.provider);
  if (step.status === 'pending') throw new VoiceError(`${conn.label || adapter.label}: Antwort kommt zu spät`, true, 0, conn.provider);
  return step;
}

export interface SpeakIn {
  locationId: string;
  text: string;
  connectionId?: string | null;
  model?: string;
  voice?: string;
  language?: string;
  speed?: number;
  instructions?: string;
  /** Extra provider fields (merged last, like "Erweiterte Parameter" in the studio). */
  params?: Record<string, unknown>;
  /**
   * false: the caller picked a connection other than the sub-account's voice – its saved voice, model and style belong to another
   * provider and are not used (the provider's own defaults apply). Default true.
   */
  inherit?: boolean;
}
export interface SpeakOut {
  data: Buffer;
  mime: string;
  provider: string;
  connection_id: string;
  model: string;
  voice: string;
  chars: number;
  ms: number;
}

const clean = (t: string) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** The voice settings of the sub-account under the explicit values of the caller. */
export function ttsDefaults(app: App, locationId: string, o: Pick<SpeakIn, 'connectionId' | 'model' | 'voice' | 'language' | 'speed' | 'instructions' | 'inherit'> = {}) {
  const s = loadVoiceSettings(app, locationId).tts;
  const own = o.inherit !== false;
  return {
    connectionId: o.connectionId || s.connection_id || null,
    model: o.model || (own ? s.model : ''),
    voice: o.voice || (own ? s.voice : ''),
    language: o.language || s.language || 'de',
    speed: o.speed ?? s.speed,
    instructions: o.instructions ?? (own ? s.instructions : ''),
  };
}

/** Text → audio file bytes (mp3 or whatever the provider answers; the type is decided from the bytes). */
export async function synthesize(app: App, o: SpeakIn): Promise<SpeakOut> {
  const text = clean(o.text);
  if (!text) throw new HttpError(400, 'Text fehlt');
  if (text.length > MAX_TTS_CHARS) throw new HttpError(400, `Text ist zu lang (höchstens ${MAX_TTS_CHARS} Zeichen)`);
  const d = ttsDefaults(app, o.locationId, o);
  const conn = await voiceConnection(app, o.locationId, 'audio_tts', d.connectionId);
  const model = d.model || conn.model || '';
  const started = Date.now();
  const step = await runAdapter(app, o.locationId, conn, 'audio_tts', model, { prompt: text, voice: d.voice || undefined, language: d.language, speed: d.speed, instructions: d.instructions || undefined, params: o.params as Record<string, any> | undefined }, undefined);
  const out = step.outputs[0];
  if (!out) throw new VoiceError(`${conn.label || conn.provider} hat keine Sprachausgabe geliefert`, false, 0, conn.provider);
  let data: Buffer;
  let hint = out.mime ?? '';
  if ('data' in out) data = out.data;
  else {
    const r = await gmFetch(app, out.url, { maxBytes: 60 * 1024 * 1024, timeoutMs: 120_000, ...(conn.options?.allow_private ? { allowPrivate: true } : {}) });
    if (!r.ok) throw new VoiceError(`Download der Sprachausgabe fehlgeschlagen (HTTP ${r.status})`, r.status >= 500, r.status, conn.provider);
    data = r.body;
    hint ||= r.headers['content-type'] ?? '';
  }
  const mime = sniff(data, hint || 'audio/mpeg');
  if (!mime.startsWith('audio/') && mime !== 'video/mp4') throw new VoiceError('Der Anbieter hat keine Audiodatei geliefert', false, 0, conn.provider);
  const ms = Date.now() - started;
  bumpUsage(app, o.locationId, 'tts', text.length, ms);
  return { data, mime: mime === 'video/mp4' ? 'audio/mp4' : mime, provider: conn.provider, connection_id: conn.connectionId, model, voice: d.voice, chars: text.length, ms };
}

export interface ListenIn {
  locationId: string;
  audio: Buffer;
  /** File name or MIME type hint of the upload (the type itself is decided from the bytes). */
  hint?: string;
  connectionId?: string | null;
  model?: string;
  language?: string;
  /** Names and terms the recognizer should know (customer names, products). */
  vocabulary?: string;
  params?: Record<string, unknown>;
}
export interface ListenOut {
  text: string;
  provider: string;
  connection_id: string;
  model: string;
  bytes: number;
  ms: number;
}

/** Recording → text. */
export async function transcribe(app: App, o: ListenIn): Promise<ListenOut> {
  if (!o.audio?.length) throw new HttpError(400, 'Aufnahme fehlt');
  if (o.audio.length > MAX_STT_BYTES) throw new HttpError(413, `Aufnahme ist zu groß (höchstens ${Math.round(MAX_STT_BYTES / 1024 / 1024)} MB)`);
  // The type comes from the bytes, never from the upload's header; WebM/MP4 count as audio here.
  const mime = sniff(o.audio, 'audio/');
  if (!mime.startsWith('audio/')) throw new HttpError(400, 'Das ist keine Audioaufnahme (erlaubt: WebM, Ogg, MP3, WAV, M4A, FLAC)');
  const s = loadVoiceSettings(app, o.locationId).stt;
  const conn = await voiceConnection(app, o.locationId, 'stt', o.connectionId || s.connection_id || null);
  const model = o.model || s.model || conn.model || '';
  const language = o.language || s.language || 'de';
  const fileMime = mime;
  const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/flac': 'flac', 'audio/aac': 'aac' }[fileMime] ?? 'bin';
  const started = Date.now();
  const step = await runAdapter(
    app,
    o.locationId,
    conn,
    'stt',
    model,
    { prompt: clean(o.vocabulary ?? '').slice(0, 500), language, audio: { url: 'memory://aufnahme', mime: fileMime, name: `aufnahme.${ext}` }, params: o.params as Record<string, any> | undefined },
    { data: o.audio, mime: fileMime },
  );
  if (typeof step.text !== 'string') throw new VoiceError(`${conn.label || conn.provider} hat keinen Text geliefert`, false, 0, conn.provider);
  const ms = Date.now() - started;
  bumpUsage(app, o.locationId, 'stt', o.audio.length, ms);
  return { text: step.text.replace(/\s+/g, ' ').trim(), provider: conn.provider, connection_id: conn.connectionId, model, bytes: o.audio.length, ms };
}

// --- voices ---------------------------------------------------------------------------------------------------

const voiceCache = new Map<string, { at: number; list: VoiceInfo[] }>();
const VOICE_CACHE_MS = 10 * 60_000;

/** Voices the provider offers (live list or built-in); free text is always allowed on top. */
export async function listVoices(app: App, locationId: string, o: { connectionId?: string | null; language?: string; refresh?: boolean } = {}): Promise<{ voices: VoiceInfo[]; connection: { id: string; provider: string; label: string } }> {
  const d = ttsDefaults(app, locationId, { connectionId: o.connectionId });
  const conn = await voiceConnection(app, locationId, 'audio_tts', d.connectionId);
  const meta = { id: conn.connectionId, provider: conn.provider, label: conn.label || conn.provider };
  const adapter = adapterFor(conn.provider);
  if (!adapter.voices) return { voices: [], connection: meta };
  const key = `${locationId}:${conn.connectionId}:${o.language ?? ''}`;
  const hit = voiceCache.get(key);
  if (hit && !o.refresh && Date.now() - hit.at < VOICE_CACHE_MS) return { voices: hit.list, connection: meta };
  const base = adapterCtx(app, { model: '', capability: 'audio_tts', input: { prompt: '' }, location_id: locationId }, conn, null);
  let list: VoiceInfo[];
  try {
    list = await adapter.voices({ conn, fetch: base.fetch, language: o.language });
  } catch (e) {
    throw asHttp(e instanceof ProviderError ? e : new VoiceError((e as Error).message));
  }
  // The same voice list is not shared between sub-accounts (keys differ): the cache key has the connection id.
  voiceCache.set(key, { at: Date.now(), list });
  if (voiceCache.size > 200) voiceCache.delete(voiceCache.keys().next().value as string);
  return { voices: list, connection: meta };
}

// --- usage (voice_usage table of modules/voice.ts) ---------------------------------------------------------------------

export type UsageKind = 'tts' | 'stt' | 'phone';

/** Counts what a call used per day: characters spoken, bytes/seconds heard, phone seconds. Never throws. */
export function bumpUsage(app: App, locationId: string, kind: UsageKind, units: number, ms = 0) {
  try {
    app.db.run(
      `INSERT INTO voice_usage (location_id, day, kind, calls, units, ms) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(location_id, day, kind) DO UPDATE SET calls = calls + 1, units = units + excluded.units, ms = ms + excluded.ms`,
      locationId,
      new Date().toISOString().slice(0, 10),
      kind,
      Math.max(0, Math.round(units)),
      Math.max(0, Math.round(ms)),
    );
  } catch {
    /* the voice module (and its table) is not loaded */
  }
}

// --- live calls (phone streams) ---------------------------------------------------------------------------------------

/** Response-based fetch for streaming bodies: the test hook, the registry's guarded fetch, or plain fetch. */
export function voiceFetch(app: App, conn: AiConnection): FetchFn {
  const hook = app.services.voiceFetch as FetchFn | undefined;
  if (hook) return hook;
  const reg = registry(app) as any;
  if (typeof reg?.fetchFor === 'function') return reg.fetchFor(conn) as FetchFn;
  return (u, i) => fetch(u, i);
}

/** WebSocket client for a connection: refuses internal addresses unless the agency allowed them for this connection. */
export function voiceWs(app: App, conn: AiConnection): WsClientFactory {
  const make = (app.services.voiceWs as WsClientFactory | undefined) ?? defaultWsClient;
  return (url, protocols) => {
    checkUrl(url.replace(/^ws/i, 'http'), !!conn.options?.allow_private);
    return make(url, protocols);
  };
}

export const streamCtx = (app: App, conn: AiConnection): StreamCtx => ({ conn, fetch: voiceFetch(app, conn), ws: voiceWs(app, conn) });

/** Providers whose one-shot call can answer in WAV (decoded here to µ-law 8 kHz when no native streamer exists). */
const WAV_PROVIDERS = new Set(['gemini', 'azure', 'groq', 'mistral', 'litellm', 'openai_compat']);

/** How a connection can feed a live call: its own streamer, WAV that is converted here, or not at all (use recorded turns). */
export function ttsStreamMode(conn: Pick<AiConnection, 'provider'>): 'native' | 'wav' | null {
  if (TTS_STREAMERS[conn.provider]) return 'native';
  return WAV_PROVIDERS.has(conn.provider) ? 'wav' : null;
}
export const sttStreamMode = (conn: Pick<AiConnection, 'provider'>): 'live' | 'batch' => (STT_OPENERS[conn.provider] ? 'live' : 'batch');

export interface LiveTts {
  mode: 'native' | 'wav';
  /** µ-law 8 kHz chunks of the spoken text; aborting `signal` cancels the request (barge-in). */
  stream(text: string, signal: AbortSignal): AsyncGenerator<Buffer, void, void>;
}

/** The text-to-speech side of a live call for a connection (null: this provider cannot stream). */
export function liveTts(app: App, locationId: string, conn: AiConnection, o: { model?: string; voice?: string; language?: string; speed?: number; instructions?: string; ws?: boolean }): LiveTts | null {
  const mode = ttsStreamMode(conn);
  if (!mode) return null;
  const d = ttsDefaults(app, locationId, { connectionId: conn.connectionId, model: o.model, voice: o.voice, language: o.language, speed: o.speed, instructions: o.instructions });
  const model = d.model || conn.model || '';
  const make = (text: string, signal: AbortSignal) => ({ text, voice: d.voice, language: d.language, model, speed: d.speed, instructions: d.instructions || undefined, signal, ws: o.ws });
  const native: TtsStreamer | undefined = TTS_STREAMERS[conn.provider];
  if (native) {
    const ctx = streamCtx(app, conn);
    return {
      mode: 'native',
      async *stream(text, signal) {
        bumpUsage(app, locationId, 'tts', text.length, 0);
        yield* native(ctx, make(text, signal));
      },
    };
  }
  return {
    mode: 'wav',
    async *stream(text, signal) {
      if (signal.aborted) return;
      const out = await synthesizeWav(app, locationId, conn, make(text, signal));
      if (signal.aborted) return;
      yield out;
    },
  };
}

async function synthesizeWav(app: App, locationId: string, conn: AiConnection, req: { text: string; voice: string; language: string; model: string; speed?: number; instructions?: string }): Promise<Buffer> {
  const step = await runAdapter(app, locationId, conn, 'audio_tts', req.model, { prompt: req.text, voice: req.voice || undefined, language: req.language, speed: req.speed, instructions: req.instructions, params: { response_format: 'wav' } });
  const out = step.outputs[0];
  const data = out && 'data' in out ? out.data : null;
  if (!data || !parseWav(data)) throw new VoiceError(`${conn.label || conn.provider} liefert die Sprachausgabe nicht als WAV – für Telefonate bitte „Aufnahme-Runden“ wählen`, false, 0, conn.provider);
  bumpUsage(app, locationId, 'tts', req.text.length, 0);
  return wavToUlaw8k(data);
}

/** Opens live speech recognition for a call: the provider's own streaming API or utterance-wise transcription. */
export async function openLiveStt(app: App, locationId: string, conn: AiConnection, o: LiveSttOpts & { vocabulary?: string }, h: LiveSttHandlers): Promise<LiveStt> {
  const opener = STT_OPENERS[conn.provider];
  if (opener) return opener(streamCtx(app, conn), o, h);
  return new BatchLiveStt(
    async (wav) => (await transcribe(app, { locationId, audio: wav, hint: 'audio/wav', connectionId: conn.connectionId, model: o.model, language: o.language, vocabulary: o.vocabulary })).text,
    h,
    { endpointMs: o.endpointMs },
  );
}


// --- how a phone call is carried ----------------------------------------------------------------------------------

export interface PhonePlan {
  /** What the sub-account chose. */
  engine: 'twilio' | 'own';
  /** What is used for the next call: Twilio's voices, a live stream or recorded turns. */
  transport: 'twilio' | 'stream' | 'turns';
  tts?: { id: string; provider: string; label: string; stream: 'native' | 'wav' | null };
  stt?: { id: string; provider: string; label: string; live: boolean };
  /** Why "own" cannot be used right now (the call then falls back to Twilio's voices). */
  problems: string[];
}

/** Whether Twilio can reach this server over wss/https (hosted instances; not localhost or a LAN address). */
export function publicHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    const h = u.hostname;
    return u.protocol === 'https:' && h.includes('.') && !/^(localhost|.*\.(local|internal|localhost|lan|home))$/i.test(h) && !/^\d+\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

/** The connections and transport the next phone call of a sub-account uses (pure reading, no network). */
export function phonePlan(app: App, locationId: string): PhonePlan {
  const vs = loadVoiceSettings(app, locationId);
  if (vs.phone.engine !== 'own') return { engine: 'twilio', transport: 'twilio', problems: [] };
  const problems: string[] = [];
  const tts = peekConnection(app, locationId, 'audio_tts', vs.phone.tts_connection_id || vs.tts.connection_id || null);
  const stt = peekConnection(app, locationId, 'stt', vs.phone.stt_connection_id || vs.stt.connection_id || null);
  if (!tts) problems.push('Für die Telefon-Stimme fehlt ein Anbieter mit Sprachausgabe (Einstellungen → KI-Anbieter).');
  if (!stt) problems.push('Für die Spracherkennung am Telefon fehlt ein Anbieter mit Transkription (Einstellungen → KI-Anbieter).');
  const stream = tts ? ttsStreamMode(tts) : null;
  const pub = publicHttps(app.baseUrl());
  let transport: 'stream' | 'turns' = vs.phone.transport === 'turns' ? 'turns' : vs.phone.transport === 'stream' ? 'stream' : stream && pub ? 'stream' : 'turns';
  if (transport === 'stream' && tts && !stream) {
    problems.push(`${tts.label || tts.provider} kann nicht live streamen – es werden Aufnahme-Runden benutzt.`);
    transport = 'turns';
  }
  if (!pub && !problems.length && vs.phone.transport !== 'auto') problems.push('Twilio erreicht den Server nur über eine öffentliche https-Adresse (Einstellungen → Agentur → Basis-Adresse).');
  return {
    engine: 'own',
    transport: problems.some((p) => /fehlt ein Anbieter/.test(p)) ? 'twilio' : transport,
    ...(tts ? { tts: { id: tts.connectionId, provider: tts.provider, label: tts.label || tts.provider, stream } } : {}),
    ...(stt ? { stt: { id: stt.connectionId, provider: stt.provider, label: stt.label || stt.provider, live: sttStreamMode(stt) === 'live' } } : {}),
    problems,
  };
}
