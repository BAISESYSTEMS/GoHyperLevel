/**
 * Voice activity detection and turn logic for the companion's conversation mode (Gesprächsmodus, 1.0.54) – pure, no browser APIs,
 * shared by companion/conversation.ts and tests/companion-live.test.ts. The microphone level (RMS of a Web Audio frame, 0–1) goes in
 * every ~50 ms; out come the moments that matter: the person started talking, stopped (a short silence ends the turn), or talked
 * over the companion (barge-in). An adaptive noise floor keeps a fan or street noise from counting as speech; while the companion
 * speaks, the threshold is higher and the speech must last longer, so its own voice leaking past the browser's echo cancellation
 * does not interrupt it.
 */

export interface VadConfig {
  /** RMS a frame needs to count as speech (quiet room, no playback) */
  threshold: number;
  /** the same while the companion speaks (echo safety) */
  playbackThreshold: number;
  /** speech this long starts a turn */
  minSpeechMs: number;
  /** speech this long over the companion's voice interrupts it */
  bargeInMs: number;
  /** this much silence after speech ends the turn */
  silenceMs: number;
  /** speech must be this many times louder than the measured noise floor */
  noiseFactor: number;
}

export const VAD_DEFAULTS: VadConfig = { threshold: 0.018, playbackThreshold: 0.06, minSpeechMs: 150, bargeInMs: 250, silenceMs: 800, noiseFactor: 3 };

export interface VadState {
  speaking: boolean;
  /** heard speech at all since the window opened */
  heard: boolean;
  /** when the current loud / quiet stretch began (null = none) */
  loudSince: number | null;
  quietSince: number | null;
  /** slowly adapting noise floor (RMS) */
  noise: number;
}

export type VadEvent = 'speech_start' | 'speech_end' | 'barge_in' | null;

export const vadInit = (): VadState => ({ speaking: false, heard: false, loudSince: null, quietSince: null, noise: 0.004 });

/** RMS of a frame of samples (−1…1). */
export function rms(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/** The level a frame must reach now. Pure. */
export function vadThreshold(s: Pick<VadState, 'noise'>, playback: boolean, cfg: VadConfig = VAD_DEFAULTS): number {
  return playback ? Math.max(cfg.playbackThreshold, s.noise * cfg.noiseFactor * 1.5) : Math.max(cfg.threshold, s.noise * cfg.noiseFactor);
}

/** One frame: the next state and what happened. `playback` = the companion is speaking right now. Pure. */
export function vadStep(s: VadState, level: number, t: number, o: { playback: boolean; cfg?: VadConfig }): { state: VadState; event: VadEvent } {
  const cfg = o.cfg ?? VAD_DEFAULTS;
  const thr = vadThreshold(s, o.playback, cfg);
  const n: VadState = { ...s };
  let event: VadEvent = null;
  if (level > thr) {
    if (n.loudSince === null) n.loudSince = t;
    n.quietSince = null;
    const need = o.playback ? cfg.bargeInMs : cfg.minSpeechMs;
    if (!n.speaking && t - n.loudSince >= need) {
      n.speaking = true;
      n.heard = true;
      event = o.playback ? 'barge_in' : 'speech_start';
    }
  } else {
    n.loudSince = null;
    // the floor only learns from quiet frames, and never climbs above a level that would swallow normal speech
    if (!n.speaking) n.noise = Math.min(0.03, n.noise * 0.95 + level * 0.05);
    if (n.speaking) {
      if (n.quietSince === null) n.quietSince = t;
      if (t - n.quietSince >= cfg.silenceMs) {
        n.speaking = false;
        n.quietSince = null;
        event = 'speech_end';
      }
    }
  }
  return { state: n, event };
}

/** The follow-up window closes silently when nobody said anything in it. Pure. */
export const windowExpired = (openedAt: number, t: number, windowMs: number, heard: boolean) => !heard && windowMs >= 0 && t - openedAt >= windowMs;

/** A turn that goes on and on is cut here (then sent like any other). */
export const MAX_TURN_MS = 30_000;

/** "Danke Jarvis", "stopp", "das war's", "thanks, that's all" … – the person ends the conversation. Pure. */
export function isEndPhrase(text: string, name = 'Jarvis'): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[.!?,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(new RegExp(`^(${n.toLowerCase()}|hey ${n.toLowerCase()}) `), '')
    .replace(new RegExp(` ${n.toLowerCase()}$`), '');
  return /^(danke( schön| dir| sehr)?|vielen dank|stopp?|halt|das war'?s( schon| für jetzt)?|das wär'?s|das reicht|tschüss|ciao|ende|fertig|gute nacht|thanks?( you)?( that'?s (all|it))?|that'?s (all|it)|bye|goodbye|stop|cheers)$/.test(t);
}

export type ConvPhase = 'idle' | 'listening' | 'thinking' | 'speaking';
