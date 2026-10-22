import { recordingMime, transcribe } from '../agent/voice';
import { canRecognise, recognise } from '../focus/speech';
import { MAX_TURN_MS, VAD_DEFAULTS, isEndPhrase, rms, vadInit, vadStep, windowExpired, type ConvPhase, type VadState } from './vad';

/**
 * Gesprächsmodus (1.0.54): after the companion spoke, the microphone stays open for a follow-up window – the person simply keeps
 * talking, no wake word or shortcut. Voice activity on the open microphone (vad.ts, Web Audio level only – nothing leaves the page for
 * it) ends a turn after a short silence; the recording then goes to the sub-account's speech to text (or the browser's own
 * recognition listens instead). While the companion speaks, the same microphone watches for a barge-in with a higher threshold
 * (`echoCancellation` on, so its own voice mostly does not reach it).
 *
 * Privacy: the microphone is only open while a conversation runs – it starts with a spoken question and ends when the window passes
 * in silence, the person says "danke Jarvis" / "stopp" / "das war's", presses Esc or ✕, leaves focus mode or hides the tab. The
 * focus page shows a "Mikro an" pill the whole time.
 */

export interface ConversationHooks {
  onPhase: (p: ConvPhase) => void;
  /** a finished turn (already checked: not an end phrase) */
  onUtterance: (text: string) => void;
  /** the person talked over the companion */
  onBargeIn: () => void;
  onClose: (reason: 'silence' | 'end' | 'user' | 'error' | 'hidden') => void;
  /** the person is talking right now (VAD) – the speaker waits */
  onSpeech?: (speaking: boolean) => void;
}

export interface ConversationOpts {
  lang: () => 'de' | 'en';
  name: () => string;
  /** the sub-account's speech to text (recording → server); else the browser's recognition */
  serverStt: () => boolean;
  windowMs: () => number;
  bargeIn: () => boolean;
  hooks: ConversationHooks;
}

const FRAME_MS = 50;

export class Conversation {
  phase: ConvPhase = 'idle';
  private stream: MediaStream | null = null;
  private ac: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private vad: VadState = vadInit();
  private openedAt = 0;
  private turnStart = 0;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recog: { stop: () => void; cancel: () => void } | null = null;
  private working = false;
  private opening: Promise<boolean> | null = null;

  constructor(private readonly o: ConversationOpts) {}

  get active() {
    return !!this.stream;
  }
  get userSpeaking() {
    return this.vad.speaking && this.phase === 'listening';
  }

  /** Opens the microphone (once per conversation). False when there is no microphone or no way to understand speech. */
  open(): Promise<boolean> {
    if (this.stream) return Promise.resolve(true);
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
      if (!(this.o.serverStt() && typeof MediaRecorder !== 'undefined') && !canRecognise()) return false;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      } catch {
        return false;
      }
      const Ctx: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (Ctx) {
        try {
          this.ac = new Ctx();
          if (this.ac.state === 'suspended') void this.ac.resume().catch(() => undefined);
          this.analyser = this.ac.createAnalyser();
          this.analyser.fftSize = 1024;
          this.ac.createMediaStreamSource(this.stream).connect(this.analyser);
          this.buf = new Float32Array(this.analyser.fftSize);
        } catch {
          this.ac = null;
          this.analyser = null;
        }
      }
      this.timer = setInterval(() => this.frame(), FRAME_MS);
      document.addEventListener('visibilitychange', this.onVisibility);
      return true;
    })().finally(() => (this.opening = null));
    return this.opening;
  }

  private onVisibility = () => {
    if (document.hidden) this.close('hidden');
  };

  private setPhase(p: ConvPhase) {
    if (this.phase === p) return;
    this.phase = p;
    this.o.hooks.onPhase(p);
  }

  /** The companion speaks now: watch for a barge-in. */
  speaking() {
    if (!this.stream) return;
    this.stopCapture(true);
    this.vad = { ...vadInit(), noise: this.vad.noise };
    this.setPhase('speaking');
  }

  /** Waiting for the agent (the microphone stays open, nothing is captured). */
  thinking() {
    if (!this.stream) return;
    this.stopCapture(true);
    this.setPhase('thinking');
  }

  /** Opens the follow-up window: the next thing the person says is the next turn; silence closes the conversation. */
  async listen(): Promise<void> {
    if (!(await this.open())) return this.close('error');
    this.stopCapture(true);
    this.vad = { ...vadInit(), noise: this.vad.noise };
    this.openedAt = Date.now();
    this.turnStart = 0;
    this.working = false;
    this.setPhase('listening');
    if (this.o.serverStt() && typeof MediaRecorder !== 'undefined' && this.stream) {
      const mime = recordingMime();
      try {
        this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
        this.chunks = [];
        this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
        this.recorder.start(250);
      } catch {
        this.recorder = null;
      }
    }
    if (!this.recorder && canRecognise()) {
      this.recog = recognise(
        this.o.lang(),
        (said) => this.deliver(said),
        () => {
          this.recog = null;
          // the turn ended without words: listen again (the window decides); else the window closes it in silence
          if (this.working && this.phase === 'listening') void this.listen();
        },
      );
    }
  }

  private frame() {
    if (!this.stream || this.phase === 'idle' || this.phase === 'thinking') return;
    const t = Date.now();
    let level = 0;
    if (this.analyser && this.buf && this.ac?.state === 'running') {
      this.analyser.getFloatTimeDomainData(this.buf);
      level = rms(this.buf);
    } else if (this.phase === 'listening' && !this.analyser) {
      // no Web Audio: the recogniser alone ends the turn; the window still closes in silence
      if (!this.recog && windowExpired(this.openedAt, t, this.o.windowMs(), false)) this.close('silence');
      return;
    }
    const playback = this.phase === 'speaking';
    if (playback && !this.o.bargeIn()) return;
    const was = this.vad.speaking;
    const r = vadStep(this.vad, level, t, { playback, cfg: VAD_DEFAULTS });
    this.vad = r.state;
    if (was !== this.vad.speaking) this.o.hooks.onSpeech?.(this.vad.speaking);
    if (r.event === 'barge_in') {
      this.o.hooks.onBargeIn();
      return;
    }
    if (this.phase !== 'listening' || this.working) return;
    if (r.event === 'speech_start') this.turnStart = t;
    if (r.event === 'speech_end' || (this.turnStart && t - this.turnStart > MAX_TURN_MS)) return void this.endTurn();
    if (windowExpired(this.openedAt, t, this.o.windowMs(), this.vad.heard)) this.close('silence');
  }

  private async endTurn() {
    if (this.working) return;
    this.working = true;
    if (this.recog) return void this.recog.stop(); // its onText delivers
    const rec = this.recorder;
    this.recorder = null;
    if (!rec) return;
    const blob = await new Promise<Blob | null>((resolve) => {
      rec.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }) : null);
      try {
        rec.stop();
      } catch {
        resolve(null);
      }
    });
    if (!blob || blob.size < 600 || this.phase !== 'listening') return void this.listen();
    this.thinking();
    try {
      const said = (await transcribe(blob)).text.trim();
      if (!said) return void this.listen();
      this.deliver(said);
    } catch {
      this.close('error');
    }
  }

  private deliver(said: string) {
    if (!this.stream) return;
    const text = said.trim();
    if (!text) return void this.listen();
    if (isEndPhrase(text, this.o.name())) return this.close('end');
    this.thinking();
    this.o.hooks.onUtterance(text);
  }

  private stopCapture(cancel: boolean) {
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') {
      if (cancel) rec.ondataavailable = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.recog) {
      if (cancel) this.recog.cancel();
      this.recog = null;
    }
  }

  /** Ends the conversation and releases the microphone. */
  close(reason: Parameters<ConversationHooks['onClose']>[0] = 'user') {
    if (!this.stream && this.phase === 'idle') return;
    this.stopCapture(true);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ac?.close().catch(() => undefined);
    this.ac = null;
    this.analyser = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.setPhase('idle');
    this.o.hooks.onClose(reason);
  }
}
