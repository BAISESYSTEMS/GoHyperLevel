import { readGeneration } from '../focus/speech';

/**
 * Speaking sentence by sentence (1.0.54): the first sentence of the agent's answer is spoken while the agent still writes the rest.
 * Sentences go in as they complete (SentenceSplitter in spoken.ts); they are spoken one after another with the companion's voice.
 * A barge-in (stopReading) ends the queue at once – nothing queued afterwards is spoken. `done` resolves with true when everything
 * was spoken, false when it was stopped.
 */
export class SpeakQueue {
  private items: string[] = [];
  private ended = false;
  private running = false;
  private stopped = false;
  private readonly gen = readGeneration();
  private resolveDone: (v: boolean) => void = () => undefined;
  readonly done: Promise<boolean>;
  /** something was (or is being) spoken */
  started = false;

  constructor(
    private readonly speakOne: (text: string) => Promise<void>,
    private readonly hooks: { onStart?: () => void; onEnd?: (completed: boolean) => void } = {},
  ) {
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get cancelled() {
    return this.stopped || readGeneration() !== this.gen;
  }

  push(text: string) {
    const t = text.trim();
    if (!t || this.ended || this.cancelled) return;
    this.items.push(t);
    void this.pump();
  }

  /** No more sentences will come. */
  end() {
    this.ended = true;
    void this.pump();
  }

  cancel() {
    this.stopped = true;
    this.items = [];
    this.finish(false);
  }

  private settled = false;
  private finish(ok: boolean) {
    if (this.settled) return;
    this.settled = true;
    if (this.started) this.hooks.onEnd?.(ok);
    this.resolveDone(ok);
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length && !this.cancelled) {
        const next = this.items.shift()!;
        if (!this.started) {
          this.started = true;
          this.hooks.onStart?.();
        }
        await this.speakOne(next);
      }
    } finally {
      this.running = false;
    }
    if (this.cancelled) return this.finish(false);
    if (this.ended && !this.items.length) this.finish(true);
  }
}
