/**
 * Small pure helpers for how the companion speaks (1.0.54), shared by the browser and tests/companion-live.test.ts:
 *  - SentenceSplitter: the agent's streamed text → whole sentences as soon as they are complete, so the first sentence is spoken
 *    while the agent still writes the rest (abbreviations like "z. B." or "Nr. 5" do not end a sentence);
 *  - fillers: a short, varied "Moment, ich schau nach …" while a longer task starts (never the same twice in a row);
 *  - done lines for background tasks ("Erledigt: …").
 */

type Lang = 'de' | 'en';

const ABBREV = /(?:\b(?:z|u|d|o|s|v|i|bzw|ca|nr|dr|prof|inkl|ggf|evtl|usw|etc|mio|mrd|tel|str|vgl|bspw|mr|mrs|ms|vs|approx|no|e\.g|i\.e)|\b[A-Za-zÄÖÜäöü])\.$/i;

export class SentenceSplitter {
  private buf = '';
  constructor(private readonly minLen = 12) {}

  /** Adds streamed text; returns the sentences that are complete now. */
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      const s = this.next();
      if (s === null) break;
      out.push(s);
    }
    return out;
  }

  /** The rest at the end of the stream. */
  flush(): string {
    const s = this.buf.trim();
    this.buf = '';
    return s;
  }

  private next(): string | null {
    // a paragraph break always ends a sentence
    const para = this.buf.indexOf('\n\n');
    const re = /[.!?…:](["“”»)]*)(\s+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + 1 + m[1].length;
      if (para >= 0 && para < end) break;
      const head = this.buf.slice(0, end).trim();
      // "z. B.", "Nr.", a single letter: not the end; a colon only ends a long lead-in
      if (this.buf[m.index] === '.' && ABBREV.test(this.buf.slice(0, m.index + 1))) continue;
      if (this.buf[m.index] === ':' && head.length < 40) continue;
      if (/\d$/.test(this.buf.slice(0, m.index)) && this.buf[m.index] === '.' && /^\s*\d/.test(this.buf.slice(end))) continue;
      if (head.length < this.minLen) continue;
      this.buf = this.buf.slice(end + m[2].length);
      return head;
    }
    if (para >= 0) {
      const head = this.buf.slice(0, para).trim();
      this.buf = this.buf.slice(para + 2);
      return head || this.next();
    }
    return null;
  }
}

const FILLERS: Record<Lang, string[]> = {
  de: ['Moment, ich schau nach …', 'Einen Augenblick, ich kümmere mich darum.', 'Alles klar, ich bin dran.', 'Gib mir einen Moment …', 'Mach ich – kurz Geduld.', 'Ich seh mir das gleich an.'],
  en: ['One moment, let me check …', 'Right away – give me a second.', 'On it.', 'Let me look into that …', 'Certainly, just a moment.', 'I’m on it – one moment.'],
};
let lastFiller = -1;

/** A filler for a task that takes a moment – varied, never the same as the previous one. `pick` makes it testable. Pure apart from the last index. */
export function filler(lang: Lang, pick: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const list = FILLERS[lang] ?? FILLERS.de;
  let i = pick(list.length) % list.length;
  if (i === lastFiller) i = (i + 1) % list.length;
  lastFiller = i;
  return list[i];
}

/** "Erledigt: Rechnung an Anna" / "Das hat nicht geklappt: …" / "Ich brauche deine Bestätigung: …". Pure. */
export function taskLine(status: 'done' | 'failed' | 'confirm' | 'stopped', label: string, lang: Lang, detail = ''): string {
  const L = (de: string, en: string) => (lang === 'en' ? en : de);
  const what = label.length > 80 ? `${label.slice(0, 79)}…` : label;
  if (status === 'done') return L(`Erledigt: ${what}.`, `Done: ${what}.`) + (detail ? ` ${detail}` : '');
  if (status === 'confirm') return L(`Für „${what}“ brauche ich deine Bestätigung – bitte tippe auf „Ausführen“.`, `“${what}” needs your confirmation – please tap “Run”.`);
  if (status === 'stopped') return L(`Angehalten: ${what}.`, `Stopped: ${what}.`);
  return L(`Das hat nicht geklappt: ${what}.`, `That did not work: ${what}.`) + (detail ? ` ${detail}` : '');
}
