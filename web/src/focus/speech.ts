import { speak, speakableText, stopSpeaking } from '../agent/voice';
import { pickNativeVoice } from '../companion/voice-plan';

/**
 * Voice for Fokus-Modus on top of the HyperLevel Agent's helpers (agent/voice.ts): answers are read with the sub-account's own
 * voice when one is set up (server text to speech), otherwise with the browser's speechSynthesis in the UI language; speaking
 * uses the server's speech to text, otherwise the browser's own recognition where there is one. Everything degrades quietly –
 * no microphone, no voices, blocked autoplay: nothing happens and nothing throws.
 */

type Lang = 'de' | 'en';

const synth = (): SpeechSynthesis | null => (typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined' ? window.speechSynthesis : null);

export function stopReading() {
  readGen++;
  stopSpeaking();
  try {
    synth()?.cancel();
  } catch {
    /* nothing to stop */
  }
}

/** The browser's voices in the language (for the companion's voice choice); empty where there is no speech synthesis. */
export function browserVoices(lang: Lang): { name: string; lang: string }[] {
  try {
    return (synth()?.getVoices() ?? []).filter((v) => v.lang.toLowerCase().startsWith(lang)).map((v) => ({ name: v.name, lang: v.lang }));
  } catch {
    return [];
  }
}

function browserSpeak(text: string, lang: Lang, name?: string, preferNative = false): Promise<void> {
  const s = synth();
  if (!s) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === 'en' ? 'en-US' : 'de-DE';
      const voices = s.getVoices();
      const native = !name && preferNative ? pickNativeVoice(voices, lang) : null;
      const voice = (name && voices.find((v) => v.name === name)) || native || voices.find((v) => v.lang.toLowerCase().startsWith(lang));
      if (voice) u.voice = voice;
      if (native) u.lang = native.lang.replace('_', '-');
      u.onend = () => resolve();
      u.onerror = () => resolve();
      s.speak(u);
    } catch {
      resolve();
    }
  });
}

let readGen = 0;
/** A server voice that just failed (API not enabled, key wrong, provider down) is skipped for a while – no wait before every answer. */
const failed = new Map<string, number>();
const RETRY_MS = 5 * 60_000;

/**
 * Reads the answer aloud and resolves when it has been spoken (or could not be). `tts`: the companion's own server voice (a connection
 * of the sub-account and a voice, e.g. Google "de-DE-Chirp3-HD-Iapetus"). `server`: the sub-account's voice. Otherwise – or when the server
 * cannot speak right now – the browser: the `voice` picked by name, else (`preferNative`) a natural male voice of the language, else any.
 * stopReading() ends any of them (barge-in), also while the server's audio is still on its way.
 */
export async function readAloud(text: string, opts: { server: boolean; lang: Lang; voice?: string; tts?: { connection_id?: string; provider?: string; voice?: string } | null; preferNative?: boolean; queue?: boolean }): Promise<void> {
  // `queue`: one sentence of a longer answer (companion/speak-queue.ts) – it does not stop the sentence before, stopReading() still ends it
  if (!opts.queue) stopReading();
  const gen = opts.queue ? readGen : ++readGen;
  const said = speakableText(text, 600);
  if (!said) return;
  const key = opts.tts ? `${opts.tts.connection_id ?? opts.tts.provider ?? ''}:${opts.tts.voice ?? ''}` : 'account';
  const viaServer = opts.tts ? () => speak(said, opts.tts!) : opts.server && !opts.voice ? () => speak(said) : null;
  if (viaServer && Date.now() - (failed.get(key) ?? 0) > RETRY_MS) {
    try {
      await viaServer();
      failed.delete(key);
      return;
    } catch {
      /* no voice after all (limit, provider down, connection gone): the browser's */
      failed.set(key, Date.now());
    }
    if (gen !== readGen) return; // stopped meanwhile
  }
  await browserSpeak(said, opts.lang, opts.voice, opts.preferNative);
}

export const canReadAloud = (server: boolean) => server || !!synth();

/** Bumped by every stopReading() – a sentence queue started at one generation stops when it changes (barge-in). */
export const readGeneration = () => readGen;

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
const RecognitionCtor = (): (new () => Recognition) | null => (typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition ?? null) : null);
export const canRecognise = () => !!RecognitionCtor();

/** The browser's own speech recognition: `onText` gets the final sentence once; `onEnd` always runs. */
export function recognise(lang: Lang, onText: (text: string) => void, onEnd: () => void): { stop: () => void; cancel: () => void } | null {
  const Ctor = RecognitionCtor();
  if (!Ctor) return null;
  let text = '';
  let cancelled = false;
  const rec = new Ctor();
  rec.lang = lang === 'en' ? 'en-GB' : 'de-DE';
  rec.interimResults = false;
  rec.continuous = false;
  rec.onresult = (e: any) => {
    text = Array.from(e.results as ArrayLike<any>)
      .map((r: any) => r[0]?.transcript ?? '')
      .join(' ')
      .trim();
  };
  rec.onerror = () => undefined;
  rec.onend = () => {
    if (!cancelled && text) onText(text);
    onEnd();
  };
  try {
    rec.start();
  } catch {
    onEnd();
    return null;
  }
  return {
    stop: () => rec.stop(),
    cancel: () => {
      cancelled = true;
      rec.abort();
    },
  };
}
