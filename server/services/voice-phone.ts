import { FrameSlicer, Vad, ulawToPcm } from './voice-audio.js';
import { twiml } from './twilio.js';
import type { LiveStt, LiveSttHandlers, PhoneReply, TurnMetrics } from './voice-types.js';
import type { WsLike } from './voice-ws.js';

/**
 * One phone call over a Twilio Media Stream (bidirectional WebSocket, µ-law 8 kHz): the caller's audio goes to
 * live speech recognition, the agent's answers come back as streamed audio of the sub-account's own voice.
 * Pure session logic – no database, no HTTP: everything the call needs arrives through `PhoneCall` (built by
 * modules/voice-phone.ts after the stream is authorised), the socket is a `WsLike`, so a fake socket drives it in tests.
 *
 *   Twilio → us:  connected · start · media · mark · dtmf · stop      us → Twilio:  media · mark · clear
 *
 * The turn loop: caller speaks → STT final (or end-of-speech) → the agent's brain answers → TTS streams audio in
 * 20 ms multiples → a `mark` tells when it was played. Barge-in: our own voice activity detection on the caller's
 * audio (provider independent) or a recognised word while the agent speaks → `clear` empties Twilio's buffer,
 * the TTS request is aborted, the caller's turn is taken. Provider failures never leave the caller in silence:
 * the stream ends and the call carries on with Twilio's own voices (`PhoneCall.degrade`).
 */

/** Timings in milliseconds; tests shorten them. */
export const phoneTiming = {
  /** `start` must arrive (and be authorised) within this time after the socket opened. */
  startMs: 8000,
  /** The agent needs longer than this: say "Einen Moment bitte" once. */
  fillerMs: 3000,
  /** Nobody says anything this long after the agent finished: "Sind Sie noch da?". */
  silenceMs: 12_000,
  /** Extra wait for Twilio's `mark` after the audio should have been played. */
  markExtraMs: 3000,
  /** Caller speech this long (continuous) while the agent talks counts as breaking in. */
  bargeStartMs: 250,
  /** Breaking in within this time after the agent's first audio is ignored (trailing speech of the caller). */
  bargeGraceMs: 300,
  /** No `speechFinal` this long after a final transcript: treat the turn as finished. */
  commitMs: 1200,
  /** Longest wait for a caller who is still talking before the agent starts speaking. */
  quietMs: 2000,
};

export const FILLER = 'Einen Moment bitte.';
const MAX_BUFFERED_FRAMES = 150;

export interface StartInfo {
  streamSid: string;
  callSid: string;
  accountSid: string;
  params: Record<string, string>;
}

/** What the module hands over once the stream is authorised. */
export interface PhoneCall {
  greeting: string;
  /** Hard stop for the whole call. */
  maxMs: number;
  settings: { bargeIn: boolean; filler: boolean; endpointMs: number };
  /** Text → µ-law 8 kHz chunks; aborting the signal cancels the provider request. */
  tts(text: string, signal: AbortSignal): AsyncGenerator<Buffer, void, void>;
  openStt(h: LiveSttHandlers): Promise<LiveStt>;
  turn(speech: string): { reply?: PhoneReply; job?: Promise<PhoneReply> };
  silence(): PhoneReply | null;
  degrade(line: string, reason: string): PhoneReply | null;
  note(type: string, ok: boolean, detail: string): void;
  metrics(m: TurnMetrics): void;
  /** The stream is over. `next` is the TwiML the call continues with (hang-up, transfer, Twilio voice, voicemail); null = the caller hung up. */
  finish(next: string | null, why: string): void;
}

export interface PhoneEnv {
  /** Authorises the stream (signature, token, session) and returns everything the call needs, or null to refuse. */
  begin(start: StartInfo): Promise<PhoneCall | null>;
  now?: () => number;
}

interface Speaking {
  id: number;
  ac: AbortController;
  startedAt: number;
  firstAudioAt: number;
  bytes: number;
  interrupted: boolean;
  wake?: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
const STREAM_SID = /^[A-Za-z0-9_-]{8,64}$/;

export class PhoneSession {
  private phase: 'wait' | 'starting' | 'live' | 'done' = 'wait';
  private streamSid = '';
  private call?: PhoneCall;
  private stt?: LiveStt;
  private early: Buffer[] = [];
  private readonly slicer = new FrameSlicer(160);
  private readonly vad = new Vad({ startMs: phoneTiming.bargeStartMs, endMs: 500 });
  private speaking: Speaking | null = null;
  private utter = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private marks = new Map<string, () => void>();
  private text = '';
  private busy = false;
  private queued = '';
  private turnNo = 0;
  private lastSpeechAt = 0;
  private sttRetries = 0;
  private timers: Partial<Record<'start' | 'max' | 'silence' | 'commit' | 'filler', ReturnType<typeof setTimeout>>> = {};
  private readonly now: () => number;

  constructor(
    private readonly ws: WsLike,
    private readonly env: PhoneEnv,
  ) {
    this.now = env.now ?? Date.now;
    this.timers.start = setTimeout(() => {
      if (this.phase === 'wait' || this.phase === 'starting') this.stop(1008, 'Kein Start-Ereignis');
    }, phoneTiming.startMs);
    this.timers.start.unref?.();
  }

  // --- Twilio → us -------------------------------------------------------------------------------------------------

  onMessage(data: string | Buffer, isBinary = false) {
    if (isBinary || this.phase === 'done') return;
    let m: any;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.event) {
      case 'start':
        return this.onStart(m);
      case 'media': {
        const media = m.media;
        if (!media || typeof media.payload !== 'string' || media.payload.length > 12_000) return;
        if (media.track && media.track !== 'inbound') return;
        const buf = Buffer.from(media.payload, 'base64');
        if (this.phase === 'starting') {
          if (this.early.length < MAX_BUFFERED_FRAMES) this.early.push(buf);
        } else if (this.phase === 'live') this.onAudio(buf);
        return;
      }
      case 'mark': {
        const name = String(m.mark?.name ?? '');
        this.marks.get(name)?.();
        return;
      }
      case 'stop':
        return this.end('caller');
      default:
        return; // connected, dtmf and anything new
    }
  }

  onClose() {
    if (this.phase !== 'done') this.end('caller');
  }

  private onStart(m: any) {
    if (this.phase !== 'wait') return;
    const s = m.start ?? {};
    const streamSid = String(s.streamSid ?? m.streamSid ?? '');
    const callSid = String(s.callSid ?? '');
    if (!STREAM_SID.test(streamSid) || !callSid) return this.stop(1008, 'Ungültiger Start');
    this.phase = 'starting';
    this.streamSid = streamSid;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.customParameters ?? {})) if (typeof v === 'string') params[k] = v;
    this.env
      .begin({ streamSid, callSid, accountSid: String(s.accountSid ?? ''), params })
      .then((call) => {
        if (!call || this.phase !== 'starting') {
          // Authorised, but the socket went away meanwhile: whoever counted this call must hear that it is over.
          call?.finish(null, 'caller');
          return this.stop(1008, 'Nicht erlaubt');
        }
        void this.run(call);
      })
      .catch((e) => {
        console.error('[voice-phone] start', (e as Error).message);
        this.stop(1011, 'Fehler beim Start');
      });
  }

  // --- the call --------------------------------------------------------------------------------------------------

  private async run(call: PhoneCall) {
    clearTimeout(this.timers.start);
    this.call = call;
    this.phase = 'live';
    this.timers.max = setTimeout(() => void this.finish(twiml('<Hangup/>'), 'limit'), call.maxMs + 30_000);
    this.timers.max.unref?.();
    try {
      this.stt = await call.openStt(this.handlers());
    } catch (e) {
      // Without speech recognition there is no own-voice call: Twilio's voices take over, starting with the greeting.
      return void this.degradeNow(call.greeting, `Spracherkennung: ${(e as Error).message}`);
    }
    if (this.phase !== 'live') return this.stt.close();
    for (const f of this.early.splice(0)) this.onAudio(f);
    await this.deliver({ say: call.greeting, then: 'listen', twiml: '', next: '' }, { greeting: true });
  }

  private handlers(): LiveSttHandlers {
    return {
      onPartial: (t) => {
        this.heard();
        if (t.trim().length >= 4) this.bargeIn();
      },
      onFinal: (t, info) => this.onFinal(t, info.speechFinal),
      onSpeechStarted: () => this.heard(),
      onError: (e) => void this.onSttError(e),
    };
  }

  private async onSttError(e: Error) {
    const call = this.call;
    if (!call || this.phase !== 'live') return;
    const retryable = (e as any).retryable === true;
    if (retryable && this.sttRetries < 2) {
      this.sttRetries++;
      call.note('stt_retry', true, `Spracherkennung neu verbunden: ${e.message.slice(0, 160)}`);
      try {
        this.stt?.close();
        this.stt = await call.openStt(this.handlers());
        return;
      } catch {
        /* falls through to the fallback */
      }
    }
    void this.degradeNow('', `Spracherkennung: ${e.message}`);
  }

  private onAudio(ulaw: Buffer) {
    for (const f of this.slicer.push(ulaw)) {
      const ev = this.vad.push(ulawToPcm(f));
      if (this.vad.isSpeech(this.vad.lastDb)) {
        this.lastSpeechAt = this.now();
        this.heard();
      }
      if (ev === 'start') this.bargeIn();
      // The caller went quiet without a recognised answer (noise, a cough): "are you still there" starts counting again.
      else if (ev === 'end' && !this.busy && !this.speaking && !this.text) this.armSilence();
    }
    this.stt?.push(ulaw);
  }

  /** The caller makes a sound: no "are you still there" while they talk. */
  private heard() {
    clearTimeout(this.timers.silence);
  }

  private onFinal(raw: string, speechFinal: boolean) {
    if (this.phase !== 'live') return;
    const t = raw.trim();
    if (!t) return;
    this.heard();
    const call = this.call!;
    // Barge-in off: what the caller says over the agent is not taken as an answer.
    if (this.speaking && !call.settings.bargeIn) return;
    this.bargeIn(true);
    this.text = `${this.text} ${t}`.trim();
    clearTimeout(this.timers.commit);
    if (speechFinal) this.commit();
    else {
      this.timers.commit = setTimeout(() => this.commit(), Math.max(phoneTiming.commitMs, call.settings.endpointMs * 1.5));
      this.timers.commit.unref?.();
    }
  }

  private commit() {
    clearTimeout(this.timers.commit);
    const speech = this.text.trim();
    this.text = '';
    if (!speech || this.phase !== 'live') return;
    if (this.busy) {
      this.queued = `${this.queued} ${speech}`.trim();
      return;
    }
    void this.handleTurn(speech);
  }

  private async handleTurn(speech: string) {
    const call = this.call!;
    this.busy = true;
    const n = ++this.turnNo;
    const tText = this.now();
    // The caller's last sound is the best estimate for "stopped talking".
    const stoppedAt = this.lastSpeechAt && this.lastSpeechAt <= tText ? this.lastSpeechAt : tText;
    const m: TurnMetrics = { n, stt_ms: Math.max(0, tText - stoppedAt), at: new Date(tText).toISOString() };
    let reply: PhoneReply | null | undefined;
    try {
      const r = call.turn(speech);
      reply = r.reply;
      if (!reply && r.job) {
        if (call.settings.filler) {
          this.timers.filler = setTimeout(() => void this.say(FILLER), phoneTiming.fillerMs);
          this.timers.filler.unref?.();
        }
        reply = await r.job;
      }
    } catch (e) {
      call.note('turn_error', false, (e as Error).message.slice(0, 200));
    } finally {
      clearTimeout(this.timers.filler);
    }
    m.llm_ms = Math.max(0, this.now() - tText);
    this.busy = false;
    if (this.phase !== 'live') return;
    if (!reply) return void this.degradeNow('', 'Antwort des Agenten fehlt');
    await this.deliver(reply, { metrics: m, stoppedAt });
    if (this.phase === 'live' && !this.busy && this.queued) {
      const q = this.queued;
      this.queued = '';
      void this.handleTurn(q);
    }
  }

  /** Says the reply and then does what comes next (listen, hang up, transfer, voicemail). */
  private async deliver(reply: PhoneReply, o: { metrics?: TurnMetrics; stoppedAt?: number; greeting?: boolean } = {}) {
    const call = this.call!;
    const t0 = this.now();
    let outcome: 'done' | 'interrupted' | 'error' | 'none' = 'none';
    let error = '';
    if (reply.say.trim()) {
      const r = await this.say(reply.say, (at) => {
        if (o.metrics) {
          o.metrics.tts_ms = Math.max(0, at - t0);
          o.metrics.total_ms = Math.max(0, at - (o.stoppedAt ?? t0));
        }
      });
      outcome = r.outcome;
      error = r.error;
    }
    if (o.metrics) {
      if (outcome === 'interrupted') o.metrics.interrupted = true;
      call.metrics(o.metrics);
    }
    if (this.phase !== 'live') return;
    if (outcome === 'error') {
      call.note('tts_error', false, error.slice(0, 200));
      // The line is spoken by Twilio's voice instead; the call goes on (or ends the way the agent wanted).
      if (reply.then === 'listen') return void this.degradeNow(reply.say, `Sprachausgabe: ${error}`);
      return void this.finish(reply.twiml || reply.next, `${reply.then}-fallback`);
    }
    if (reply.then === 'listen') return this.armSilence();
    return void this.finish(reply.next || reply.twiml, reply.then);
  }

  private armSilence() {
    clearTimeout(this.timers.silence);
    this.timers.silence = setTimeout(() => {
      if (this.phase !== 'live' || this.busy || this.speaking) return;
      const r = this.call!.silence();
      if (r) void this.deliver(r);
    }, phoneTiming.silenceMs);
    this.timers.silence.unref?.();
  }

  // --- us → Twilio ---------------------------------------------------------------------------------------------------

  private send(o: Record<string, unknown>) {
    if (this.ws.open) this.ws.send(JSON.stringify({ ...o, streamSid: this.streamSid }));
  }

  /** Speaks one text; utterances queue up, so a filler and the answer never overlap. */
  private say(text: string, onFirstAudio?: (at: number) => void): Promise<{ outcome: 'done' | 'interrupted' | 'error'; error: string }> {
    const run = () => this.sayNow(text, onFirstAudio);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async sayNow(text: string, onFirstAudio?: (at: number) => void): Promise<{ outcome: 'done' | 'interrupted' | 'error'; error: string }> {
    const call = this.call!;
    if (this.phase !== 'live') return { outcome: 'interrupted', error: '' };
    // A caller who is still talking is not talked over: wait for a pause (briefly).
    for (let waited = 0; call.settings.bargeIn && this.vad.speaking && waited < phoneTiming.quietMs; waited += 100) await sleep(100);
    if (this.phase !== 'live') return { outcome: 'interrupted', error: '' };
    const sp: Speaking = { id: ++this.utter, ac: new AbortController(), startedAt: this.now(), firstAudioAt: 0, bytes: 0, interrupted: false };
    this.speaking = sp;
    clearTimeout(this.timers.silence);
    const out = new FrameSlicer(160);
    const push = (frames: Buffer[]) => {
      if (!frames.length || sp.ac.signal.aborted) return;
      for (let i = 0; i < frames.length; i += 4) {
        const part = Buffer.concat(frames.slice(i, i + 4));
        sp.bytes += part.length;
        this.send({ event: 'media', media: { payload: part.toString('base64') } });
      }
    };
    let error = '';
    try {
      for await (const chunk of call.tts(text, sp.ac.signal)) {
        if (sp.ac.signal.aborted) break;
        if (!sp.firstAudioAt && chunk.length) {
          sp.firstAudioAt = this.now();
          onFirstAudio?.(sp.firstAudioAt);
        }
        push(out.push(chunk));
      }
      if (!sp.ac.signal.aborted) push(out.flush());
    } catch (e) {
      if (!sp.ac.signal.aborted) error = (e as Error).message || 'Fehler';
    }
    if (error) {
      // Whatever was queued at Twilio so far is cut; the caller does not hear half a word and then Twilio's voice.
      this.send({ event: 'clear' });
      this.speaking = null;
      return { outcome: 'error', error };
    }
    if (!sp.interrupted && sp.bytes > 0) {
      const name = `u${sp.id}`;
      this.send({ event: 'mark', mark: { name } });
      // Wait until Twilio has played everything (or the caller breaks in, or the call ends).
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(1500, sp.bytes / 8) + phoneTiming.markExtraMs);
        t.unref?.();
        const wake = () => {
          clearTimeout(t);
          this.marks.delete(name);
          resolve();
        };
        this.marks.set(name, wake);
        sp.wake = wake;
      });
    }
    this.speaking = null;
    return { outcome: sp.interrupted ? 'interrupted' : 'done', error: '' };
  }

  /** The caller breaks in: stop talking at once and take their turn. `confirmed` = a recognised word, not only noise. */
  private bargeIn(confirmed = false) {
    const sp = this.speaking;
    if (!sp || !this.call?.settings.bargeIn || sp.interrupted) return;
    if (!sp.firstAudioAt || this.now() - sp.firstAudioAt < (confirmed ? 0 : phoneTiming.bargeGraceMs)) return;
    sp.interrupted = true;
    sp.ac.abort();
    this.send({ event: 'clear' });
    sp.wake?.();
  }

  // --- the end ---------------------------------------------------------------------------------------------------------

  /** Provider trouble: close the stream so Twilio's own voices carry the call (the brain says what to play). */
  private async degradeNow(line: string, reason: string) {
    const call = this.call;
    if (!call || this.phase === 'done') return;
    const r = call.degrade(line, reason);
    await this.finish(r?.twiml ?? null, 'fallback');
  }

  /** The stream ends on our side and the call continues with `next`. */
  private async finish(next: string | null, why: string) {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.cleanup();
    const call = this.call;
    try {
      call?.finish(next, why);
    } catch (e) {
      console.error('[voice-phone] finish', (e as Error).message);
    }
    this.ws.close(1000, 'fertig');
  }

  /** The caller hung up (or Twilio stopped the stream). */
  private end(why: string) {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.cleanup();
    try {
      this.call?.finish(null, why);
    } catch (e) {
      console.error('[voice-phone] finish', (e as Error).message);
    }
    this.ws.close(1000, 'beendet');
  }

  private stop(code: number, reason: string) {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.cleanup();
    this.ws.close(code, reason);
  }

  private cleanup() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    if (this.speaking) {
      this.speaking.interrupted = true;
      this.speaking.ac.abort();
      this.speaking.wake?.();
    }
    for (const w of [...this.marks.values()]) w();
    try {
      this.stt?.close();
    } catch {
      /* already closed */
    }
  }
}
