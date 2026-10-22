import type { WsClientFactory, WsClientLike } from './voice-ws.js';

/**
 * Gemini Live API adapter (docs/living-boards.md#echtzeit-stimme) – the protocol framing of Google's bidirectional streaming endpoint
 * `BidiGenerateContent` over a WebSocket, kept small so the companion's realtime proxy (modules/companion-live.ts) and the tests share it:
 *
 *   client → server  {setup:{model, generationConfig:{responseModalities:["AUDIO"], speechConfig}, systemInstruction, tools,
 *                     inputAudioTranscription:{}, outputAudioTranscription:{}}}          once, first
 *                    {realtimeInput:{audio:{data:<base64 PCM16>, mimeType:"audio/pcm;rate=16000"}}}   microphone chunks
 *                    {realtimeInput:{audioStreamEnd:true}}                                 the microphone paused
 *                    {clientContent:{turns:[{role:"user", parts:[{text}]}], turnComplete:true}}   a typed turn
 *                    {toolResponse:{functionResponses:[{id, name, response}]}}             answers to tool calls
 *   server → client  {setupComplete:{}} · {serverContent:{modelTurn:{parts:[{inlineData:{mimeType:"audio/pcm;rate=24000", data}}]},
 *                     inputTranscription:{text}, outputTranscription:{text}, interrupted, turnComplete}} · {toolCall:{functionCalls:[…]}} ·
 *                    {toolCallCancellation:{ids}} · {goAway:{timeLeft}} · {usageMetadata:{…}}
 *
 * Server messages may come as text or binary frames (JSON either way). The API key goes in the URL's `key` parameter – only ever
 * from the server, never to the browser. No real call in tests: tests/companion-live.test.ts runs a fake Live server on localhost.
 */

export const LIVE_HOST = 'wss://generativelanguage.googleapis.com';
export const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
/** Half-cascade Live model with native tool use; the connection's own model is used when it names a Live model. */
export const DEFAULT_LIVE_MODEL = 'gemini-live-2.5-flash-preview';
/** A deep, calm prebuilt voice for "Jarvis". */
export const DEFAULT_LIVE_VOICE = 'Charon';
export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;

export const liveUrl = (apiKey: string, base = LIVE_HOST) => `${base.replace(/\/$/, '')}${LIVE_PATH}?key=${encodeURIComponent(apiKey)}`;
/** Only Live-capable models (name contains "live" or "native-audio"); anything else falls back to the default. */
export const liveModel = (m?: string | null) => (m && /^[A-Za-z0-9._-]{3,80}$/.test(m.replace(/^models\//, '')) && /live|native-audio/i.test(m) ? m.replace(/^models\//, '') : DEFAULT_LIVE_MODEL);

export interface FunctionDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function setupMessage(o: { model: string; voice?: string; language?: string; system: string; tools?: FunctionDecl[] }): Record<string, unknown> {
  return {
    setup: {
      model: `models/${liveModel(o.model)}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice || DEFAULT_LIVE_VOICE } }, ...(o.language ? { languageCode: o.language } : {}) },
      },
      systemInstruction: { parts: [{ text: o.system }] },
      ...(o.tools?.length ? { tools: [{ functionDeclarations: o.tools }] } : {}),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export const audioMessage = (pcm: Uint8Array, rate = INPUT_RATE) => JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'), mimeType: `audio/pcm;rate=${rate}` } } });
export const audioEndMessage = () => JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
export const textMessage = (text: string) => JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
export const toolResponseMessage = (responses: { id: string; name: string; response: Record<string, unknown> }[]) => JSON.stringify({ toolResponse: { functionResponses: responses } });

export type LiveEvent =
  | { type: 'ready' }
  | { type: 'audio'; pcm: Buffer; rate: number }
  | { type: 'input_transcript'; text: string }
  | { type: 'output_transcript'; text: string }
  | { type: 'text'; text: string }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'tool_call'; calls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { type: 'tool_cancel'; ids: string[] }
  | { type: 'go_away'; timeLeft: string }
  | { type: 'error'; message: string };

const asText = (raw: unknown): string => {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw ?? '');
};

/** One server frame → the events in it (in protocol order). Unknown parts are ignored; broken JSON is an error event. Pure. */
export function parseServerMessage(raw: unknown): LiveEvent[] {
  let m: any;
  try {
    m = JSON.parse(asText(raw));
  } catch {
    return [{ type: 'error', message: 'Ungültige Nachricht vom Live-Dienst' }];
  }
  const out: LiveEvent[] = [];
  if (m?.setupComplete) out.push({ type: 'ready' });
  const sc = m?.serverContent;
  if (sc) {
    if (sc.inputTranscription?.text) out.push({ type: 'input_transcript', text: String(sc.inputTranscription.text) });
    for (const p of sc.modelTurn?.parts ?? []) {
      const d = p?.inlineData;
      if (d?.data && /^audio\/pcm/i.test(String(d.mimeType ?? 'audio/pcm'))) {
        const rate = Number(/rate=(\d+)/.exec(String(d.mimeType))?.[1]) || OUTPUT_RATE;
        out.push({ type: 'audio', pcm: Buffer.from(String(d.data), 'base64'), rate });
      } else if (typeof p?.text === 'string' && p.text) out.push({ type: 'text', text: p.text });
    }
    if (sc.outputTranscription?.text) out.push({ type: 'output_transcript', text: String(sc.outputTranscription.text) });
    if (sc.interrupted) out.push({ type: 'interrupted' });
    if (sc.turnComplete) out.push({ type: 'turn_complete' });
  }
  if (Array.isArray(m?.toolCall?.functionCalls)) {
    out.push({ type: 'tool_call', calls: m.toolCall.functionCalls.filter((c: any) => c && typeof c.name === 'string').map((c: any) => ({ id: String(c.id ?? ''), name: String(c.name), args: c.args && typeof c.args === 'object' ? c.args : {} })) });
  }
  if (Array.isArray(m?.toolCallCancellation?.ids)) out.push({ type: 'tool_cancel', ids: m.toolCallCancellation.ids.map(String) });
  if (m?.goAway) out.push({ type: 'go_away', timeLeft: String(m.goAway.timeLeft ?? '') });
  if (m?.error) out.push({ type: 'error', message: String(m.error.message ?? m.error) });
  return out;
}

/**
 * One Live session upstream: opens the socket, sends the setup and resolves once the service answered `setupComplete` (rejects on a
 * close, an error or after `timeoutMs`). Then `onEvent` gets every parsed event.
 */
export class GeminiLiveSession {
  private ws: WsClientLike | null = null;
  private closed = false;
  constructor(
    private readonly o: { url: string; ws: WsClientFactory; setup: Record<string, unknown>; onEvent: (e: LiveEvent) => void; onClose?: (code: number, reason: string) => void; timeoutMs?: number },
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (ready) return;
        reject(new Error('Der Live-Dienst hat nicht rechtzeitig geantwortet'));
        this.close();
      }, this.o.timeoutMs ?? 8000);
      let ws: WsClientLike;
      try {
        ws = this.o.ws(this.o.url);
      } catch (e) {
        clearTimeout(timer);
        return reject(e instanceof Error ? e : new Error(String(e)));
      }
      this.ws = ws;
      try {
        ws.binaryType = 'arraybuffer';
      } catch {
        /* fakes may not have it */
      }
      ws.onopen = () => ws.send(JSON.stringify(this.o.setup));
      ws.onmessage = (ev) => {
        for (const e of parseServerMessage(ev.data)) {
          if (e.type === 'ready' && !ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
          this.o.onEvent(e);
        }
      };
      ws.onerror = () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new Error('Live-Dienst nicht erreichbar'));
        }
      };
      ws.onclose = (ev) => {
        const wasOpen = !this.closed;
        this.closed = true;
        if (!ready) {
          clearTimeout(timer);
          reject(new Error(`Live-Dienst hat die Verbindung beendet${ev?.reason ? `: ${String(ev.reason).slice(0, 120)}` : ''}`));
        }
        if (wasOpen) this.o.onClose?.(Number(ev?.code ?? 1006), String(ev?.reason ?? ''));
      };
    });
  }

  get open_(): boolean {
    return !this.closed && !!this.ws && this.ws.readyState === 1;
  }
  private send(s: string) {
    if (this.open_) this.ws!.send(s);
  }
  sendAudio(pcm: Uint8Array) {
    this.send(audioMessage(pcm));
  }
  endAudio() {
    this.send(audioEndMessage());
  }
  sendText(text: string) {
    this.send(textMessage(text));
  }
  sendToolResponse(responses: { id: string; name: string; response: Record<string, unknown> }[]) {
    this.send(toolResponseMessage(responses));
  }
  close() {
    if (this.closed && !this.ws) return;
    this.closed = true;
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* already gone */
    }
  }
}
