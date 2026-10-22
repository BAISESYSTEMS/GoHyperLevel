import { authFor, baseOf } from './genmedia/http.js';
import { azureEndpoints, azureSsml, localeOf, langOf } from './voice-adapters.js';
import { PcmAligner, Resampler, pcmToUlaw, wavToUlaw8k } from './voice-audio.js';
import { VoiceError, type StreamCtx, type StreamTtsReq, type TtsStreamer } from './voice-types.js';

/**
 * Streaming text to speech for live calls: every streamer returns µ-law audio at 8 kHz (what Twilio
 * Media Streams plays) as soon as the first bytes arrive. Providers that can answer in µ-law
 * (ElevenLabs `ulaw_8000`, Cartesia `pcm_mulaw`, Deepgram `mulaw`, Azure `raw-8khz-8bit-mono-mulaw`,
 * Google `MULAW`) are asked for it directly; OpenAI and compatible servers deliver 24 kHz PCM that is
 * resampled here. Aborting the signal cancels the HTTP request or closes the socket (barge-in).
 */

const retryable = (status: number) => status === 429 || status >= 500;

/** Chunks of a response body. */
export async function* chunks(res: Response): AsyncGenerator<Buffer, void, void> {
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer());
    if (all.length) yield all;
    return;
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

async function ok(res: Response, what: string, provider: string): Promise<Response> {
  if (res.ok) return res;
  let msg = '';
  try {
    const t = (await res.text()).slice(0, 400);
    try {
      const j = JSON.parse(t);
      msg = String(j?.detail?.message ?? j?.detail ?? j?.error?.message ?? j?.error ?? j?.message ?? t);
    } catch {
      msg = t;
    }
  } catch {
    /* no body */
  }
  const hint = res.status === 401 || res.status === 403 ? ' – Schlüssel prüfen' : res.status === 402 ? ' – Guthaben aufladen' : res.status === 429 ? ' – Limit erreicht' : '';
  throw new VoiceError(`${what}: ${msg.replace(/\s+/g, ' ').slice(0, 200) || `Fehler ${res.status}`} (HTTP ${res.status})${hint}`, retryable(res.status), res.status, provider);
}

const post = (ctx: StreamCtx, url: string, headers: Record<string, string>, body: string, signal?: AbortSignal) => ctx.fetch(url, { method: 'POST', headers, body, signal });

/** A queue that is also an async iterable – bridges socket callbacks into `for await`. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private error: Error | null = null;
  private done = false;
  push(v: T) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  fail(e: Error) {
    if (this.done) return;
    this.error = e;
    this.end();
  }
  end() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.items.length) return { value: this.items.shift() as T, done: false };
        if (this.error) throw this.error;
        if (this.done) return { value: undefined as never, done: true };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve)).then((r) => {
          if (r.done && this.error) throw this.error;
          return r;
        });
      },
    };
  }
}

// --- OpenAI and OpenAI-compatible servers (PCM 24 kHz → µ-law 8 kHz) ------------------------------------------------

export const PCM_RATE = 24000;

function openaiBase(ctx: StreamCtx): string {
  const b = baseOf(ctx.conn, 'https://api.openai.com/v1');
  return /api\.openai\.com$/.test(b) ? `${b}/v1` : b;
}

export const openaiStream: TtsStreamer = async function* (ctx, req) {
  const { headers } = authFor(ctx.conn, 'bearer');
  const model = req.model || 'gpt-4o-mini-tts';
  const body: Record<string, any> = {
    model,
    input: req.text.slice(0, 4096),
    voice: req.voice || 'alloy',
    response_format: 'pcm',
    ...(/gpt-4o-mini-tts/.test(model) ? (req.instructions ? { instructions: req.instructions } : {}) : req.speed && req.speed !== 1 ? { speed: Math.max(0.25, Math.min(4, req.speed)) } : {}),
  };
  const res = await ok(await post(ctx, `${openaiBase(ctx)}/audio/speech`, { ...headers, 'content-type': 'application/json' }, JSON.stringify(body), req.signal), 'OpenAI', 'openai');
  const align = new PcmAligner();
  const rs = new Resampler(PCM_RATE, 8000);
  for await (const c of chunks(res)) {
    const out = rs.push(align.push(c));
    if (out.length) yield pcmToUlaw(out);
  }
  const tail = rs.flush();
  if (tail.length) yield pcmToUlaw(tail);
};

// --- ElevenLabs (µ-law natively, HTTP chunked or WebSocket) -----------------------------------------------------------

const EL_BASE = 'https://api.elevenlabs.io';
const elVoice = (v: string) => (v || 'JBFqnCBsd6RMkjVDRZzb').replace(/[^\w-]/g, '');

export const elevenlabsStream: TtsStreamer = async function* (ctx, req) {
  if (req.ws) return yield* elevenlabsSocket(ctx, req);
  const { headers } = authFor(ctx.conn, 'header:xi-api-key');
  const body = {
    text: req.text,
    model_id: req.model || 'eleven_flash_v2_5',
    ...(req.language ? { language_code: langOf(req.language) } : {}),
    ...(req.speed && req.speed !== 1 ? { voice_settings: { speed: Math.max(0.7, Math.min(1.2, req.speed)) } } : {}),
  };
  const res = await ok(await post(ctx, `${baseOf(ctx.conn, EL_BASE)}/v1/text-to-speech/${elVoice(req.voice)}/stream?output_format=ulaw_8000`, { ...headers, 'content-type': 'application/json', accept: 'audio/basic' }, JSON.stringify(body), req.signal), 'ElevenLabs', 'elevenlabs');
  yield* chunks(res);
};

/** WebSocket `stream-input`: text goes in, base64 µ-law comes back as soon as the model has it. */
async function* elevenlabsSocket(ctx: StreamCtx, req: StreamTtsReq): AsyncGenerator<Buffer, void, void> {
  const base = baseOf(ctx.conn, EL_BASE).replace(/^http/, 'ws');
  const q = new URLSearchParams({ model_id: req.model || 'eleven_flash_v2_5', output_format: 'ulaw_8000', auto_mode: 'true', inactivity_timeout: '20' });
  if (req.language) q.set('language_code', langOf(req.language));
  const sock = ctx.ws(`${base}/v1/text-to-speech/${elVoice(req.voice)}/stream-input?${q}`);
  const queue = new AsyncQueue<Buffer>();
  let finished = false;
  const stop = () => {
    try {
      sock.close(1000);
    } catch {
      /* already closed */
    }
  };
  req.signal?.addEventListener('abort', () => {
    finished = true;
    queue.end();
    stop();
  });
  sock.onopen = () => {
    sock.send(JSON.stringify({ text: ' ', xi_api_key: ctx.conn.apiKey, ...(req.speed && req.speed !== 1 ? { voice_settings: { speed: Math.max(0.7, Math.min(1.2, req.speed)) } } : {}) }));
    sock.send(JSON.stringify({ text: `${req.text.trim()} `, flush: true }));
    sock.send(JSON.stringify({ text: '' }));
  };
  sock.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.error || m.message_type === 'error') {
      finished = true;
      queue.fail(new VoiceError(`ElevenLabs: ${String(m.message ?? m.error ?? 'Fehler').slice(0, 200)}`, false, 0, 'elevenlabs'));
      stop();
      return;
    }
    if (m.audio) queue.push(Buffer.from(m.audio, 'base64'));
    if (m.isFinal) {
      finished = true;
      queue.end();
      stop();
    }
  };
  sock.onerror = () => {
    if (!finished) queue.fail(new VoiceError('ElevenLabs: WebSocket-Fehler', true, 0, 'elevenlabs'));
  };
  sock.onclose = (ev) => {
    if (finished) return queue.end();
    finished = true;
    if (ev?.code && ev.code !== 1000) queue.fail(new VoiceError(`ElevenLabs: Verbindung beendet (${ev.code}${ev.reason ? `: ${String(ev.reason).slice(0, 100)}` : ''})`, true, 0, 'elevenlabs'));
    else queue.end();
  };
  yield* queue;
}

// --- Cartesia ---------------------------------------------------------------------------------------------------------

export const cartesiaStream: TtsStreamer = async function* (ctx, req) {
  if (!req.voice) throw new VoiceError('Cartesia braucht eine Stimmen-ID – bitte unter „Stimme“ eine wählen', false, 0, 'cartesia');
  const headers = { 'cartesia-version': '2025-04-16', ...authFor(ctx.conn, 'header:x-api-key').headers };
  const model = req.model || 'sonic-2';
  const body = {
    model_id: model,
    transcript: req.text,
    voice: { mode: 'id', id: req.voice },
    output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    language: langOf(req.language) || 'de',
    ...(req.speed && req.speed !== 1 && /sonic-3/.test(model) ? { generation_config: { speed: Math.max(0.6, Math.min(1.5, req.speed)) } } : {}),
  };
  const res = await ok(await post(ctx, `${baseOf(ctx.conn, 'https://api.cartesia.ai')}/tts/bytes`, { ...headers, 'content-type': 'application/json' }, JSON.stringify(body), req.signal), 'Cartesia', 'cartesia');
  yield* chunks(res);
};

// --- Deepgram Aura ----------------------------------------------------------------------------------------------------

export const deepgramStream: TtsStreamer = async function* (ctx, req) {
  const { headers } = authFor(ctx.conn, 'token');
  const model = [req.voice, req.model].find((x) => x && /^aura/i.test(x)) || 'aura-2-viktoria-de';
  const url = `${baseOf(ctx.conn, 'https://api.deepgram.com')}/v1/speak?model=${encodeURIComponent(model)}&encoding=mulaw&sample_rate=8000&container=none`;
  const res = await ok(await post(ctx, url, { ...headers, 'content-type': 'application/json' }, JSON.stringify({ text: req.text.slice(0, 2000) }), req.signal), 'Deepgram', 'deepgram');
  yield* chunks(res);
};

// --- Azure Speech -------------------------------------------------------------------------------------------------------

export const azureStream: TtsStreamer = async function* (ctx, req) {
  const { headers } = authFor(ctx.conn, 'header:ocp-apim-subscription-key');
  const ep = azureEndpoints(ctx.conn.baseUrl ?? '');
  const voice = req.voice || 'de-DE-KatjaNeural';
  const res = await ok(
    await post(ctx, ep.tts, { ...headers, 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': 'raw-8khz-8bit-mono-mulaw', 'user-agent': 'HyperLevel' }, azureSsml(req.text, voice, req.speed, req.language), req.signal),
    'Azure Speech',
    'azure_speech',
  );
  yield* chunks(res);
};

// --- Google Cloud TTS (one JSON answer with a µ-law WAV) --------------------------------------------------------------------

export const googleStream: TtsStreamer = async function* (ctx, req) {
  const { headers } = authFor(ctx.conn, 'header:x-goog-api-key');
  const voice = req.voice || 'de-DE-Neural2-F';
  const body = {
    input: { text: req.text },
    voice: { languageCode: /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0] ?? localeOf(req.language), name: voice },
    audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000, ...(req.speed && req.speed !== 1 ? { speakingRate: Math.max(0.25, Math.min(4, req.speed)) } : {}) },
  };
  const res = await ok(await post(ctx, 'https://texttospeech.googleapis.com/v1/text:synthesize', { ...headers, 'content-type': 'application/json' }, JSON.stringify(body), req.signal), 'Google Speech', 'google_speech');
  const j: any = await res.json().catch(() => null);
  if (!j?.audioContent) throw new VoiceError('Google Speech hat keine Sprachausgabe geliefert', false, 0, 'google_speech');
  yield wavToUlaw8k(Buffer.from(j.audioContent, 'base64'));
};

/** Streamer per provider id; ids that speak the same protocol share one. */
export const TTS_STREAMERS: Record<string, TtsStreamer> = {
  openai: openaiStream,
  speech_local: openaiStream,
  elevenlabs: elevenlabsStream,
  cartesia: cartesiaStream,
  deepgram: deepgramStream,
  azure_speech: azureStream,
  google_speech: googleStream,
};
