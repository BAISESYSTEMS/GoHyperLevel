import { authFor, baseOf } from './genmedia/http.js';
import { FrameSlicer, Vad, ulawToPcm, wavFromPcm } from './voice-audio.js';
import { langOf } from './voice-adapters.js';
import { VoiceError, type LiveStt, type LiveSttHandlers, type LiveSttOpts, type SttOpener, type StreamCtx } from './voice-types.js';
import type { WsClientLike } from './voice-ws.js';

/**
 * Live speech to text for phone calls: audio arrives as µ-law 8 kHz (20 ms frames) and text leaves as
 * `partial` / `final` events. Deepgram and AssemblyAI stream over a WebSocket. Every other provider
 * (OpenAI Whisper / gpt-4o-transcribe, ElevenLabs Scribe, Gemini, Azure, Google, local Whisper …) is
 * wrapped in `BatchLiveStt`: a voice activity detector cuts the call into utterances and each one is
 * transcribed with the provider's normal file API – a little slower, but it works with every provider.
 */

const OPEN = 1;

const wsBase = (base: string) => base.replace(/\/+$/, '').replace(/^http/i, 'ws');

/** Sends frames as soon as the socket is open; frames before that are kept (up to ~5 s). */
class Outbox {
  private pending: (string | Buffer)[] = [];
  private bytes = 0;
  constructor(private readonly sock: WsClientLike) {}
  send(data: string | Buffer) {
    if (this.sock.readyState === OPEN) return this.sock.send(data);
    if (this.bytes > 40_000) return;
    this.pending.push(data);
    this.bytes += typeof data === 'string' ? data.length : data.length;
  }
  flush() {
    for (const d of this.pending.splice(0)) this.sock.send(d);
    this.bytes = 0;
  }
}

// --- Deepgram (WebSocket, µ-law natively) -------------------------------------------------------------------------------

export const deepgramOpen: SttOpener = (ctx, o, h) => {
  const base = wsBase(baseOf(ctx.conn, 'https://api.deepgram.com'));
  const q = new URLSearchParams({
    model: o.model || 'nova-3',
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    vad_events: 'true',
    endpointing: String(Math.max(100, Math.min(2000, Math.round(o.endpointMs / 2)))),
    utterance_end_ms: String(Math.max(1000, o.endpointMs)),
  });
  if (o.language) q.set('language', langOf(o.language));
  // Browsers cannot set headers on a WebSocket; Deepgram accepts the key as sub-protocol "token, <key>" – so do we.
  const sock = ctx.ws(`${base}/v1/listen?${q}`, ['token', ctx.conn.apiKey]);
  sock.binaryType = 'arraybuffer';
  const out = new Outbox(sock);
  let text = '';
  let closed = false;
  let lastSent = Date.now();
  const keepAlive = setInterval(() => {
    if (sock.readyState === OPEN && Date.now() - lastSent > 4000) sock.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 3000);
  keepAlive.unref?.();
  const emit = (speechFinal: boolean) => {
    const t = text.trim();
    text = '';
    if (t) h.onFinal(t, { speechFinal });
  };
  const end = () => {
    clearInterval(keepAlive);
    closed = true;
  };
  sock.onopen = () => out.flush();
  sock.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    if (m.type === 'Results') {
      const t = String(m.channel?.alternatives?.[0]?.transcript ?? '').trim();
      if (m.is_final) {
        if (t) text = `${text} ${t}`.trim();
        if (m.speech_final) emit(true);
        else if (t) h.onPartial?.(text);
      } else if (t) h.onPartial?.(`${text} ${t}`.trim());
    } else if (m.type === 'UtteranceEnd') emit(true);
    else if (m.type === 'SpeechStarted') h.onSpeechStarted?.();
    else if (m.type === 'Error' || m.err_code) h.onError(new VoiceError(`Deepgram: ${String(m.description ?? m.err_msg ?? m.message ?? 'Fehler').slice(0, 200)}`, false, 0, 'deepgram'));
  };
  sock.onerror = () => {
    if (!closed) h.onError(new VoiceError('Deepgram: WebSocket-Fehler', true, 0, 'deepgram'));
  };
  sock.onclose = (ev) => {
    const wasOpen = !closed;
    end();
    if (wasOpen && ev?.code !== 1000) h.onError(new VoiceError(`Deepgram: Verbindung beendet (${ev?.code ?? '?'}${ev?.reason ? `: ${String(ev.reason).slice(0, 100)}` : ''})`, true, 0, 'deepgram'));
    h.onClose?.();
  };
  return {
    push(ulaw) {
      lastSent = Date.now();
      out.send(ulaw);
    },
    finalize() {
      out.send(JSON.stringify({ type: 'Finalize' }));
    },
    close() {
      if (closed) return;
      try {
        if (sock.readyState === OPEN) sock.send(JSON.stringify({ type: 'CloseStream' }));
        sock.close(1000);
      } catch {
        /* already closed */
      }
      end();
    },
  };
};

// --- AssemblyAI streaming v3 --------------------------------------------------------------------------------------------

export const assemblyaiOpen: SttOpener = async (ctx, o, h) => {
  const eu = /\.eu\./.test(ctx.conn.baseUrl ?? '');
  const host = eu ? 'streaming.eu.assemblyai.com' : 'streaming.assemblyai.com';
  const { headers } = authFor(ctx.conn, 'header:authorization');
  // The key never goes into a URL: a short-lived token does.
  const tr = await ctx.fetch(`https://${host}/v3/token?expires_in_seconds=300`, { method: 'GET', headers });
  const tj: any = await tr.json().catch(() => null);
  if (!tr.ok || !tj?.token) throw new VoiceError(`AssemblyAI: Echtzeit-Token nicht erhalten (HTTP ${tr.status})`, tr.status === 429 || tr.status >= 500, tr.status, 'assemblyai');
  const q = new URLSearchParams({ sample_rate: '8000', encoding: 'pcm_mulaw', format_turns: 'false', token: tj.token });
  if (langOf(o.language) !== 'en') q.set('speech_model', 'universal-streaming-multilingual');
  if (o.endpointMs) q.set('min_end_of_turn_silence_when_confident', String(Math.max(160, Math.min(2000, o.endpointMs))));
  const sock = ctx.ws(`wss://${host}/v3/ws?${q}`);
  sock.binaryType = 'arraybuffer';
  const out = new Outbox(sock);
  const slicer = new FrameSlicer(800); // the API wants 50–1000 ms per message
  let closed = false;
  sock.onopen = () => out.flush();
  sock.onmessage = (ev) => {
    let m: any;
    try {
      m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    if (m.type === 'Turn') {
      const t = String(m.transcript ?? '').trim();
      if (m.end_of_turn) {
        if (t) h.onFinal(t, { speechFinal: true });
      } else if (t) h.onPartial?.(t);
    } else if (m.error) h.onError(new VoiceError(`AssemblyAI: ${String(m.error).slice(0, 200)}`, false, 0, 'assemblyai'));
  };
  sock.onerror = () => {
    if (!closed) h.onError(new VoiceError('AssemblyAI: WebSocket-Fehler', true, 0, 'assemblyai'));
  };
  sock.onclose = (ev) => {
    const wasOpen = !closed;
    closed = true;
    if (wasOpen && ev?.code && ev.code !== 1000) h.onError(new VoiceError(`AssemblyAI: Verbindung beendet (${ev.code}${ev.reason ? `: ${String(ev.reason).slice(0, 100)}` : ''})`, true, 0, 'assemblyai'));
    h.onClose?.();
  };
  return {
    push(ulaw) {
      for (const f of slicer.push(ulaw)) out.send(f);
    },
    finalize() {
      out.send(JSON.stringify({ type: 'ForceEndpoint' }));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (sock.readyState === OPEN) sock.send(JSON.stringify({ type: 'Terminate' }));
        sock.close(1000);
      } catch {
        /* already closed */
      }
    },
  };
};

// --- any provider: voice activity detection + file transcription ----------------------------------------------------------

export interface BatchOpts {
  endpointMs: number;
  /** Longest single utterance; longer speech is cut here and transcribed in pieces. */
  maxUtteranceMs?: number;
  /** Audio kept from before the speech start so the first syllable is not lost. */
  preRollMs?: number;
  /** Shorter bursts (coughs, clicks) are dropped. */
  minSpeechMs?: number;
}

export class BatchLiveStt implements LiveStt {
  private readonly slicer = new FrameSlicer(160);
  private readonly vad: Vad;
  private readonly preRoll: Int16Array[] = [];
  private frames: Int16Array[] = [];
  private active = false;
  private speechFrames = 0;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly o: Required<BatchOpts>;
  constructor(
    /** WAV (PCM16, 8 kHz) → text; may throw. */
    private readonly transcribe: (wav: Buffer) => Promise<string>,
    private readonly h: LiveSttHandlers,
    o: BatchOpts,
  ) {
    this.o = { maxUtteranceMs: 30_000, preRollMs: 300, minSpeechMs: 200, ...o };
    this.vad = new Vad({ endMs: o.endpointMs, startMs: 60 });
  }

  push(ulaw: Buffer) {
    if (this.closed) return;
    for (const f of this.slicer.push(ulaw)) {
      const pcm = ulawToPcm(f);
      const ev = this.vad.push(pcm);
      if (ev === 'start') {
        this.active = true;
        this.frames = [...this.preRoll.splice(0)];
        this.speechFrames = 0;
        this.h.onSpeechStarted?.();
      }
      if (this.active) {
        this.frames.push(pcm);
        if (this.vad.isSpeech(this.vad.lastDb)) this.speechFrames++;
        if (ev === 'end') this.flush(true);
        else if (this.frames.length * 20 >= this.o.maxUtteranceMs) this.flush(false);
      } else {
        this.preRoll.push(pcm);
        while (this.preRoll.length * 20 > this.o.preRollMs) this.preRoll.shift();
      }
    }
  }

  /** Transcribe what has been heard so far, now. */
  finalize() {
    if (this.active) this.flush(true);
  }

  close() {
    this.closed = true;
    this.active = false;
    this.frames = [];
    this.h.onClose?.();
  }

  private flush(speechFinal: boolean) {
    const frames = this.frames;
    const speech = this.speechFrames;
    this.frames = [];
    this.speechFrames = 0;
    if (speechFinal) {
      this.active = false;
      this.vad.reset();
    }
    if (speech * 20 < this.o.minSpeechMs) return;
    // Keep ~200 ms of the trailing silence, drop the rest.
    const trim = Math.max(0, Math.floor((this.o.endpointMs - 200) / 20));
    const used = speechFinal ? frames.slice(0, Math.max(1, frames.length - trim)) : frames;
    const pcm = new Int16Array(used.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of used) {
      pcm.set(f, at);
      at += f.length;
    }
    // Utterances are transcribed one after the other so the answers keep their order.
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      try {
        const wav = wavFromPcm(pcm, 8000);
        const text = (await this.transcribe(wav)).trim();
        if (text && !this.closed) this.h.onFinal(text, { speechFinal });
      } catch (e) {
        if (!this.closed) this.h.onError(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

/** Live openers per provider id. */
export const STT_OPENERS: Record<string, SttOpener> = {
  deepgram: deepgramOpen,
  assemblyai: assemblyaiOpen,
};

export type { LiveSttOpts, StreamCtx };
