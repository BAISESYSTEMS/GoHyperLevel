import { currentLocation } from '../api';

/**
 * Voice in the browser, Android WebView and PWA: recording with MediaRecorder (→ the server's speech to text, see
 * modules/voice.ts), playing spoken replies and cleaning text for speech. Used by the HyperLevel Agent panel
 * (push-to-talk, read aloud) and by Einstellungen → Stimme (microphone test). No dependencies; every function
 * degrades quietly where the browser has no microphone or no MediaRecorder.
 */

export const canRecord = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

/** The recording format this browser can make (Chrome/Firefox: WebM/Opus, Safari: MP4). */
export function recordingMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

/** Why recording failed, in words for people. */
export function micError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Der Browser darf das Mikrofon nicht benutzen – bitte in den Seiteneinstellungen erlauben.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Kein Mikrofon gefunden.';
  if (name === 'NotReadableError') return 'Das Mikrofon wird gerade von einer anderen App benutzt.';
  return (e as Error)?.message || 'Aufnahme nicht möglich.';
}

export interface RecordingHandle {
  /** Stops and returns the recording (null when it was cancelled or empty). */
  stop(): Promise<Blob | null>;
  cancel(): void;
  /** Milliseconds recorded so far. */
  elapsed(): number;
}

/**
 * Starts recording; resolves once the microphone is open. `maxMs` ends the recording by itself (`onLimit`). `silence` (hands-free,
 * Fokus-Modus mit Companion) calls `onSilence` once the person spoke and then paused for `ms`, or after `waitMs` without a word.
 */
export async function startRecording(opts: { maxMs?: number; onLimit?: () => void; silence?: { ms: number; waitMs?: number; onSilence: (heard: boolean) => void } } = {}): Promise<RecordingHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const mime = recordingMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  const started = Date.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopVad = opts.silence ? watchSilence(stream, opts.silence) : () => undefined;
  const release = () => {
    clearTimeout(timer);
    stopVad();
    stream.getTracks().forEach((t) => t.stop());
  };
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob | null>((resolve) => {
    rec.onstop = () => {
      release();
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      resolve(cancelled || blob.size < 600 ? null : blob);
    };
  });
  rec.start(250);
  if (opts.maxMs) {
    timer = setTimeout(() => {
      opts.onLimit?.();
      if (rec.state !== 'inactive') rec.stop();
    }, opts.maxMs);
  }
  return {
    stop: () => {
      if (rec.state !== 'inactive') rec.stop();
      return done;
    },
    cancel: () => {
      cancelled = true;
      if (rec.state !== 'inactive') rec.stop();
      else release();
    },
    elapsed: () => Date.now() - started,
  };
}

/** A small voice activity check on the microphone stream (Web Audio level, no audio leaves the page). Returns the stop function. */
function watchSilence(stream: MediaStream, o: { ms: number; waitMs?: number; onSilence: (heard: boolean) => void }): () => void {
  const Ctx: typeof AudioContext | undefined = typeof window !== 'undefined' ? (window.AudioContext ?? (window as any).webkitAudioContext) : undefined;
  if (!Ctx) return () => undefined;
  let ac: AudioContext;
  try {
    ac = new Ctx();
  } catch {
    return () => undefined;
  }
  // a context the browser keeps suspended (no user activation) reads silence – then there is no check and the person taps to stop
  if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const started = Date.now();
  let heard = false;
  let loudSince = 0;
  let quietSince = Date.now();
  let fired = false;
  const timer = setInterval(() => {
    if (ac.state !== 'running') return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const t = Date.now();
    if (rms > 0.02) {
      if (!loudSince) loudSince = t;
      if (t - loudSince > 180) heard = true;
      quietSince = t;
    } else {
      loudSince = 0;
    }
    if (fired) return;
    if ((heard && t - quietSince > o.ms) || (!heard && t - started > (o.waitMs ?? 7000))) {
      fired = true;
      o.onSilence(heard);
    }
  }, 100);
  return () => {
    clearInterval(timer);
    void ac.close().catch(() => undefined);
  };
}

const headers = (extra: Record<string, string> = {}): Record<string, string> => {
  const loc = currentLocation();
  return { 'x-pghl': '1', ...(loc ? { 'x-location-id': loc } : {}), ...extra };
};

async function readError(r: Response): Promise<string> {
  const data = (r.headers.get('content-type') ?? '').includes('json') ? await r.json().catch(() => null) : null;
  if (r.status === 401) window.dispatchEvent(new Event('pghl:logout'));
  return data?.error || `Fehler ${r.status}`;
}

/** Recording → text with the sub-account's speech recognition. */
export async function transcribe(blob: Blob, opts: { language?: string; vocabulary?: string } = {}): Promise<{ text: string; provider: string; model: string; ms: number }> {
  const q = new URLSearchParams();
  if (opts.language) q.set('language', opts.language);
  if (opts.vocabulary) q.set('vocabulary', opts.vocabulary);
  const r = await fetch(`/api/voice/transcribe${q.size ? `?${q}` : ''}`, { method: 'POST', headers: headers({ 'content-type': blob.type || 'application/octet-stream' }), body: blob, credentials: 'same-origin' });
  if (!r.ok) throw new Error(await readError(r));
  return r.json();
}

let current: { audio: HTMLAudioElement; url: string } | null = null;
const listeners = new Set<(playing: boolean) => void>();
export const onPlaying = (fn: (playing: boolean) => void) => (listeners.add(fn), () => void listeners.delete(fn));
const notify = (p: boolean) => listeners.forEach((fn) => fn(p));

/** Bumped by every stop: a reply still on its way from the server is dropped instead of starting after a barge-in. */
let speakGen = 0;
export function stopSpeaking() {
  speakGen++;
  if (!current) return;
  current.audio.pause();
  URL.revokeObjectURL(current.url);
  current = null;
  notify(false);
}

/**
 * Speaks `text` with the person's voice (server text to speech) and resolves when it has been played (or stopped). `voice` picks a
 * connection of the sub-account (`connection_id`, or the first of a `provider`) and a voice – the companion's own voice.
 */
export async function speak(text: string, voice?: { provider?: string; connection_id?: string; voice?: string }): Promise<void> {
  stopSpeaking();
  const gen = speakGen;
  const r = await fetch('/api/voice/speak', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ text, ...(voice ?? {}) }), credentials: 'same-origin' });
  if (!r.ok) throw new Error(await readError(r));
  const blob = await r.blob();
  if (gen !== speakGen) return; // stopped while the audio was on its way
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  current = { audio, url };
  notify(true);
  await new Promise<void>((resolve) => {
    const end = () => {
      if (current?.audio === audio) {
        URL.revokeObjectURL(url);
        current = null;
        notify(false);
      }
      resolve();
    };
    audio.onended = end;
    audio.onerror = end;
    audio.onpause = end;
    audio.play().catch(end);
  });
}

/** Plays a data: URL (the "Stimme testen" result). */
export function playDataUrl(src: string): Promise<void> {
  stopSpeaking();
  return new Promise((resolve) => {
    const audio = new Audio(src);
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
}

/** What of an answer is worth reading aloud: no code, links or markup, the first few sentences. */
export function speakableText(markdown: string, max = 700): string {
  let s = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_~|>#]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > max / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')} …`;
  }
  return s;
}
