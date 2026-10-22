import { api } from '../api';
import { downsample, floatToPcm16, pcm16ToFloat, pcmBytes } from './pcm';

/**
 * Echtzeit-Stimme (1.0.54): a pluggable realtime engine – audio in, audio out, both at once, the model's own turn-taking and barge-in.
 * The Gemini Live implementation talks to our server only (POST /api/companion/live/session → a one-time ticket → WebSocket
 * /ws/companion-live), which holds the sub-account's Gemini key and relays to Google; the key never reaches the browser. The model's
 * tool calls ("hyperlevel_agent") come back here and run through the same HyperLevel Agent path as everything in focus mode – with its
 * rights and its confirmation card; the engine only reports back what happened (a write waits for the click, never for a "ja").
 * When the server cannot reach Gemini or there is no key, `onFallback` says why and the classic voice takes over.
 */

export type RealtimeState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'idle';

export interface RealtimeHooks {
  onState: (s: RealtimeState) => void;
  onTranscript: (who: 'user' | 'model', text: string) => void;
  /** the model hands a request to the HyperLevel Agent; resolve with what to tell it */
  onTool: (request: string) => Promise<{ result: string; confirm: boolean }>;
  /** the person said goodbye / the session ended normally */
  onEnd: () => void;
  /** could not start or broke: use the classic voice (the message is for people) */
  onFallback: (message: string) => void;
}

export interface RealtimeEngine {
  readonly kind: string;
  start(): Promise<void>;
  stop(): void;
  sendText(text: string): void;
  readonly running: boolean;
}

const IN_RATE = 16000;
const OUT_RATE = 24000;

export class GeminiLiveEngine implements RealtimeEngine {
  readonly kind = 'gemini_live';
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private playAt = 0;
  private alive = false;
  private ending = false;

  constructor(private readonly h: RealtimeHooks) {}

  get running() {
    return this.alive;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.alive = true;
    this.ending = false;
    this.h.onState('connecting');
    let session: { path: string };
    try {
      session = await api.post<{ path: string }>('/api/companion/live/session', {});
    } catch (e) {
      return this.fail((e as Error).message);
    }
    const Ctx: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices?.getUserMedia || typeof WebSocket === 'undefined') return this.fail('Dieser Browser kann keine Echtzeit-Stimme.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      return this.fail('Der Browser darf das Mikrofon nicht benutzen.');
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${session.path}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onJson(ev.data) : this.play(new Uint8Array(ev.data as ArrayBuffer)));
    ws.onclose = () => {
      if (this.alive && !this.ending) this.fail('Die Echtzeit-Verbindung ist abgebrochen.');
      else this.cleanup();
    };
    ws.onerror = () => undefined;
    // the microphone → 16 kHz PCM16 frames (browsers that ignore the requested rate are downsampled)
    try {
      this.inCtx = new Ctx({ sampleRate: IN_RATE });
    } catch {
      this.inCtx = new Ctx();
    }
    this.outCtx = (() => {
      try {
        return new Ctx({ sampleRate: OUT_RATE });
      } catch {
        return new Ctx();
      }
    })();
    const src = this.inCtx.createMediaStreamSource(this.stream);
    this.proc = this.inCtx.createScriptProcessor(2048, 1, 1);
    const rate = this.inCtx.sampleRate;
    this.proc.onaudioprocess = (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const f = e.inputBuffer.getChannelData(0);
      this.ws.send(pcmBytes(floatToPcm16(rate === IN_RATE ? f : downsample(f, rate, IN_RATE))));
    };
    src.connect(this.proc);
    // a ScriptProcessor only runs when connected to the output; a muted gain keeps the microphone off the speakers
    const mute = this.inCtx.createGain();
    mute.gain.value = 0;
    this.proc.connect(mute).connect(this.inCtx.destination);
  }

  private onJson(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === 'ready') this.h.onState('listening');
    else if (m.type === 'transcript') {
      this.h.onTranscript(m.who === 'user' ? 'user' : 'model', String(m.text ?? ''));
      if (m.who === 'user') this.h.onState('thinking');
    } else if (m.type === 'interrupted') this.flush();
    else if (m.type === 'turn_complete') this.h.onState('listening');
    else if (m.type === 'tool') {
      this.h.onState('thinking');
      void this.h
        .onTool(String(m.request ?? ''))
        .then((r) => this.ws?.send(JSON.stringify({ type: 'tool_result', id: m.id, result: r.result, confirm: r.confirm })))
        .catch((e) => this.ws?.send(JSON.stringify({ type: 'tool_result', id: m.id, result: `Fehler: ${(e as Error).message}`, confirm: false })));
    } else if (m.type === 'end') {
      this.ending = true;
      // let the goodbye finish playing
      setTimeout(() => this.stop(), Math.max(300, (this.playAt - (this.outCtx?.currentTime ?? 0)) * 1000));
    } else if (m.type === 'error') {
      if (m.fallback) this.fail(String(m.message ?? ''));
    }
  }

  private play(bytes: Uint8Array) {
    const ctx = this.outCtx;
    if (!ctx || !bytes.byteLength) return;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const f = pcm16ToFloat(bytes);
    const buf = ctx.createBuffer(1, f.length, OUT_RATE);
    buf.getChannelData(0).set(f);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.playAt);
    node.start(at);
    this.playAt = at + buf.duration;
    this.sources.add(node);
    this.h.onState('speaking');
    node.onended = () => {
      this.sources.delete(node);
      if (!this.sources.size && this.alive) this.h.onState('listening');
    };
  }

  /** The person talked over it (the service said so): stop what is still queued. */
  private flush() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.playAt = 0;
    if (this.alive) this.h.onState('listening');
  }

  sendText(text: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'text', text }));
  }

  private fail(message: string) {
    const was = this.alive;
    this.cleanup();
    if (was) this.h.onFallback(message);
  }

  stop() {
    if (!this.alive) return;
    this.ending = true;
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'bye' }));
    } catch {
      /* gone */
    }
    this.cleanup();
    this.h.onEnd();
  }

  private cleanup() {
    this.alive = false;
    this.flush();
    this.proc?.disconnect();
    this.proc = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.inCtx?.close().catch(() => undefined);
    void this.outCtx?.close().catch(() => undefined);
    this.inCtx = null;
    this.outCtx = null;
    try {
      this.ws?.close();
    } catch {
      /* gone */
    }
    this.ws = null;
    this.h.onState('idle');
  }
}

/** The engine for a preference (only "gemini_live" is realtime; "classic" has none). */
export const realtimeEngine = (kind: string, hooks: RealtimeHooks): RealtimeEngine | null => (kind === 'gemini_live' ? new GeminiLiveEngine(hooks) : null);
