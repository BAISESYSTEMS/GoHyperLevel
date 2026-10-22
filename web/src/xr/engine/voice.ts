import { canRecord, micError, startRecording, transcribe, type RecordingHandle } from '../../agent/voice';
import { api } from '../../api';

/**
 * Push-to-talk inside XR: the same recording and speech recognition as the board's prompt bar (the sub-account's own speech to
 * text) behind one button of the control panel. Hold it and speak, let go – or tap once to start and once to stop (the same as
 * the prompt bar). The words go to the board exactly like typed ones; nothing spoken ever confirms a change by itself.
 *
 * The browser asks for the microphone once, and a headset shows that question only on the page – so the viewer asks for it BEFORE
 * the session starts (`warmUpMicrophone`).
 */

export type MicState = 'idle' | 'recording' | 'working' | 'off';

/** Does this browser record, and has the sub-account a speech recognition set up? */
export async function micAvailable(): Promise<boolean> {
  if (!canRecord()) return false;
  try {
    const vp = await api.get<{ ready?: { stt?: boolean } }>('/api/voice/prefs');
    return !!vp.ready?.stt;
  } catch {
    return false;
  }
}

/** Asks for the microphone now (on the page) so that the headset does not have to later; the tracks are stopped at once. */
export async function warmUpMicrophone(): Promise<string | null> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return null;
  } catch (e) {
    return micError(e);
  }
}

export class PushToTalk {
  state: MicState = 'idle';
  private rec: RecordingHandle | null = null;
  private starting = false;
  private downAt = 0;
  private stopOnUp = false;

  constructor(
    /** Called with every change of state (the control panel redraws). */
    private onState: (s: MicState, note?: string) => void,
    /** Called with the words when the recognition has them. */
    private onWords: (text: string) => void | Promise<unknown>,
    private onError: (message: string) => void,
    private now: () => number = () => Date.now(),
  ) {}

  private set(s: MicState, note?: string) {
    this.state = s;
    this.onState(s, note);
  }

  /** The button went down. */
  async down() {
    if (this.state === 'off' || this.state === 'working' || this.starting) return;
    this.downAt = this.now();
    this.stopOnUp = this.state === 'recording';
    if (this.state === 'idle') await this.start();
  }

  /** The button came up: a long hold ends the recording, a tap leaves it running (the next tap ends it). */
  async up() {
    if (this.state === 'recording' && (this.stopOnUp || this.now() - this.downAt > 500)) await this.finish();
  }

  private async start() {
    this.starting = true;
    try {
      this.rec = await startRecording({ maxMs: 60_000, onLimit: () => void this.finish() });
      this.set('recording');
    } catch (e) {
      this.onError(micError(e));
    } finally {
      this.starting = false;
    }
  }

  async finish() {
    const h = this.rec;
    if (!h) return;
    this.rec = null;
    this.set('working');
    try {
      const blob = await h.stop();
      if (!blob) return this.set('idle');
      const said = (await transcribe(blob)).text.trim();
      if (!said) {
        this.onError('Ich habe nichts verstanden – bitte noch einmal sprechen.');
        return this.set('idle');
      }
      this.set('idle');
      await this.onWords(said);
    } catch (e) {
      this.onError((e as Error).message);
      this.set('idle');
    }
  }

  cancel() {
    this.rec?.cancel();
    this.rec = null;
    if (this.state !== 'off') this.set('idle');
  }
}
