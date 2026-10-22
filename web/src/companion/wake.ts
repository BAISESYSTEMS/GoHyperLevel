/**
 * The wake word of the companion ("Hey Jarvis") with the browser's own speech recognition – there is no keyword engine of our own.
 * It only runs while the person switched it on for this device and the tab is visible (CompanionLayer pauses it otherwise), and
 * the audio goes nowhere but to the browser's recognizer: in Chrome and Edge that recognizer is an online service of the browser's
 * maker (Google, Microsoft), in Safari Apple's. HyperLevel only gets text, and only what follows the wake phrase becomes a question.
 * Nothing is recorded or stored. Where the browser has no recognition (Firefox, most Android WebViews) the option is not offered.
 */

/** Lower case, umlauts and accents folded, punctuation dropped. */
export const foldWord = (s: string) =>
  s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

const GREETINGS = new Set(['hey', 'hei', 'hej', 'he', 'hi', 'hallo', 'hello', 'ok', 'okay', 'oke', 'hay', 'heya']);

/** Edit distance (small strings only). */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** A name word as recognisers write it: "Jarvis", "Javis", "Charvis" – short names must match exactly. */
const nameLike = (heard: string, want: string) => {
  if (!heard) return false;
  if (want.length <= 4) return heard === want;
  return distance(heard, want) <= (want.length >= 6 ? 2 : 1);
};

/**
 * Finds the wake phrase in what was heard. A greeting in the phrase ("Hey") accepts the usual variants (hey, hallo, ok …); the
 * name allows a letter or two of misrecognition. Returns what was said after the phrase (the command, may be empty), or null.
 */
export function findWake(heard: string, phrase: string): { rest: string } | null {
  const want = phrase.split(/\s+/).map(foldWord).filter(Boolean);
  if (!want.length) return null;
  const words = heard.split(/\s+/).filter(Boolean);
  const folded = words.map(foldWord);
  for (let i = 0; i + want.length <= folded.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) {
      const w = want[k];
      const h = folded[i + k];
      ok = GREETINGS.has(w) ? GREETINGS.has(h) : nameLike(h, w);
    }
    if (ok)
      return {
        rest: words
          .slice(i + want.length)
          .join(' ')
          .replace(/^[\s,.:;!?–-]+/, '')
          .trim(),
      };
  }
  return null;
}

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

export type WakeState = 'on' | 'paused' | 'off' | 'error';
export interface WakeOptions {
  lang: () => string;
  phrase: () => string;
  /** the wake phrase was heard (barge-in: stop speaking, show "Ich höre zu") */
  onWake: () => void;
  onPartial: (text: string) => void;
  onCommand: (text: string) => void;
  /** heard the phrase, then nothing */
  onTimeout: () => void;
  onState: (s: WakeState, error?: string) => void;
}

/** Pause after the last word before the command counts as complete; how long to wait for a command after the phrase. */
export const COMMAND_GAP_MS = 1200;
export const COMMAND_WAIT_MS = 6500;

export class WakeListener {
  private rec: Recognition | null = null;
  private running = false;
  private paused = false;
  private mode: 'wake' | 'command' = 'wake';
  private wakeAt = 0;
  private lastChange = 0;
  private rest = '';
  private final = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private quickEnds = 0;

  constructor(private o: WakeOptions) {}

  static supported() {
    return typeof window !== 'undefined' && !!((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.quickEnds = 0;
    this.open();
  }
  stop() {
    const was = this.running;
    this.running = false;
    this.close();
    // after an error the listener already said why – "off" would hide it
    if (was) this.o.onState('off');
  }
  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.close();
    this.o.onState('paused');
  }
  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.quickEnds = 0;
    this.open();
  }
  get listening() {
    return this.running && !this.paused;
  }

  private open() {
    const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!Ctor) return this.fail('Dieser Browser hat keine eigene Spracherkennung.');
    const rec: Recognition = new Ctor();
    rec.lang = this.o.lang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => this.heard(e);
    rec.onerror = (e) => {
      const err = String(e?.error ?? '');
      if (err === 'not-allowed' || err === 'service-not-allowed') this.fail('Der Browser darf das Mikrofon nicht benutzen – bitte in den Seiteneinstellungen erlauben.');
      else if (err === 'audio-capture') this.fail('Kein Mikrofon gefunden.');
      // no-speech, aborted, network: onend restarts (with a growing pause after quick failures)
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      if (!this.running || this.paused) return;
      this.quickEnds = Date.now() - this.startedAt < 2000 ? this.quickEnds + 1 : 0;
      if (this.quickEnds > 6) return this.fail('Die Spracherkennung des Browsers startet nicht mehr – bitte das Weckwort aus- und wieder einschalten.');
      this.restartTimer = setTimeout(() => this.running && !this.paused && this.open(), Math.min(30_000, 250 * 2 ** this.quickEnds));
    };
    this.rec = rec;
    this.mode = 'wake';
    this.rest = '';
    try {
      this.startedAt = Date.now();
      rec.start();
      this.o.onState('on');
    } catch {
      this.rec = null;
      this.restartTimer = setTimeout(() => this.running && !this.paused && this.open(), 1000);
    }
  }

  private close() {
    clearTimeout(this.restartTimer);
    clearInterval(this.timer);
    this.timer = undefined;
    const rec = this.rec;
    this.rec = null;
    try {
      rec?.abort();
    } catch {
      /* already ended */
    }
    this.mode = 'wake';
  }

  private fail(msg: string) {
    this.running = false;
    this.close();
    this.o.onState('error', msg);
  }

  private heard(e: any) {
    const results = Array.from(e.results as ArrayLike<any>);
    const text = results.map((r: any) => r[0]?.transcript ?? '').join(' ');
    const m = findWake(text, this.o.phrase());
    if (!m) return;
    const last = results[results.length - 1];
    this.final = !!last?.isFinal;
    if (this.mode === 'wake') {
      this.mode = 'command';
      this.wakeAt = Date.now();
      this.lastChange = Date.now();
      this.rest = '';
      this.o.onWake();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.check(), 200);
    }
    if (m.rest !== this.rest) {
      this.rest = m.rest;
      this.lastChange = Date.now();
      this.o.onPartial(m.rest);
    }
  }

  private check() {
    if (this.mode !== 'command') return;
    const t = Date.now();
    const quiet = t - this.lastChange;
    if (this.rest && ((this.final && quiet > COMMAND_GAP_MS) || quiet > COMMAND_GAP_MS * 2.5 || t - this.wakeAt > 20_000)) return this.done(this.rest);
    if (!this.rest && t - this.wakeAt > COMMAND_WAIT_MS) {
      this.reset();
      this.o.onTimeout();
    }
  }

  private done(text: string) {
    this.reset();
    this.o.onCommand(text);
  }

  /** Back to listening for the phrase with a fresh session (the old results are forgotten). */
  private reset() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.mode = 'wake';
    this.rest = '';
    try {
      this.rec?.abort();
    } catch {
      /* ended */
    }
  }
}
