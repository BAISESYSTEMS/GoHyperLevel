import type { AiConnection } from './genmedia/types.js';
import type { WsClientFactory } from './voice-ws.js';

/** Shared types of the voice layer (text to speech and speech to text on top of the BYOK registry). */

export type VoiceCap = 'audio_tts' | 'stt';

/** A failure of a speech provider – callers (phone agent, panel, workflows) decide whether to fall back. */
export class VoiceError extends Error {
  constructor(
    message: string,
    public retryable = false,
    public status = 0,
    public provider = '',
  ) {
    super(message);
  }
}

/** Response-based fetch (streaming bodies): the registry's guarded fetch, a test hook or the global one. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface StreamCtx {
  conn: AiConnection;
  fetch: FetchFn;
  ws: WsClientFactory;
}

/** What a streaming TTS call needs. Streamers yield µ-law, 8 kHz, mono – exactly what Twilio plays. */
export interface StreamTtsReq {
  text: string;
  voice: string;
  language: string;
  model: string;
  speed?: number;
  instructions?: string;
  signal?: AbortSignal;
  /** ElevenLabs: use the WebSocket (`stream-input`) instead of chunked HTTP. */
  ws?: boolean;
}
export type TtsStreamer = (ctx: StreamCtx, req: StreamTtsReq) => AsyncGenerator<Buffer, void, void>;

export interface LiveSttHandlers {
  onPartial?(text: string): void;
  /** A finished piece of the caller's speech; `speechFinal` = the caller stopped talking. */
  onFinal(text: string, info: { speechFinal: boolean }): void;
  onSpeechStarted?(): void;
  onError(e: Error): void;
  onClose?(): void;
}
/** One open transcription session fed with µ-law 8 kHz audio. */
export interface LiveStt {
  push(ulaw: Buffer): void;
  /** Flush what has been heard so far (the caller seems finished / the call ends). */
  finalize(): void;
  close(): void;
}
export interface LiveSttOpts {
  language: string;
  model: string;
  endpointMs: number;
}
export type SttOpener = (ctx: StreamCtx, o: LiveSttOpts, h: LiveSttHandlers) => Promise<LiveStt> | LiveStt;

export interface VoiceInfo {
  id: string;
  name: string;
  lang?: string;
  gender?: string;
  preview?: string;
}

/** Latency of one caller turn on the phone (milliseconds; missing = not measured). */
export interface TurnMetrics {
  n: number;
  /** Caller stopped talking → STT delivered the text. */
  stt_ms?: number;
  /** Text → the agent's answer (LLM and tools). */
  llm_ms?: number;
  /** Answer → first audio sent to the caller. */
  tts_ms?: number;
  /** Caller stopped talking → first audio (what the caller feels). */
  total_ms?: number;
  interrupted?: boolean;
  at: string;
}

/**
 * What the phone agent does next, independent of how it is delivered: spoken by Twilio (`twiml` – <Say> and
 * <Gather>), as audio of the sub-account's own voice over a Media Stream or as a recorded turn. The agent's
 * brain (modules/voice-ai.ts) produces it, the transports render it.
 */
export interface PhoneReply {
  /** What to say (already speakable); empty = nothing. */
  say: string;
  then: 'listen' | 'hangup' | 'transfer' | 'voicemail';
  /** The classic rendering with Twilio's own voice (say + listen, hang-up, transfer, voicemail). */
  twiml: string;
  /** TwiML that continues the call once `say` has been delivered some other way (empty for "listen"). */
  next: string;
}

/** The agent's brain as the transports see it (app.services.voiceBrain, filled by modules/voice-ai.ts). */
export interface VoiceBrain {
  /** An open agent session for this call, with what the transport needs to start. */
  open(locationId: string, callSid: string): { greeting: string; maxMs: number; voice: string } | null;
  /** The caller said something: the next reply (never throws; failures become a voicemail reply). */
  turn(locationId: string, callSid: string, speech: string): { reply?: PhoneReply; job?: Promise<PhoneReply> };
  /** The caller said nothing for a while. */
  silence(locationId: string, callSid: string): PhoneReply | null;
  /** The own voice failed: carry on with Twilio's voice (`line` is what was meant to be said). */
  degrade(locationId: string, callSid: string, line: string, reason: string): PhoneReply | null;
  /** Journal entry on the session (shown with the call). */
  note(locationId: string, callSid: string, type: string, ok: boolean, detail: string): void;
}
