/**
 * Text measuring for the canvas without a browser: Helvetica/Arial advance widths (1/1000 em), so the
 * server (SVG/PDF/PNG export) and the editor wrap lines at the same places. The SVG font stack starts
 * with Helvetica/Arial, the PDF uses the built-in Helvetica – the numbers fit both.
 *
 * Pure code without imports (also used in the browser).
 */

import type { FontKey } from './canvas-model.js';

// Helvetica advance widths for ASCII 32..126 (AFM).
const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667,
  556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722,
  500, 500, 500, 334, 260, 334, 584,
];
const ASCII_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722,
  611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778,
  556, 556, 500, 389, 280, 389, 584,
];
const EXTRA: Record<string, number> = {
  'ä': 556, 'ö': 556, 'ü': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ß': 611, 'é': 556, 'è': 556, 'à': 556, 'ç': 500, '€': 556, '–': 556, '—': 1000, '„': 333, '“': 333, '”': 333, '‚': 222, '‘': 222, '’': 222, '…': 1000, '•': 350, '·': 278, '°': 400, '§': 556, '→': 1000, '←': 1000, '›': 333, '‹': 333, '↗': 800, '↑': 600, '↓': 600, '✓': 800, '×': 584,
};

/** Width factor of the other font stacks relative to Helvetica (their fallbacks vary – a safe average). */
const FONT_FACTOR: Record<FontKey, number> = { sans: 1, serif: 0.93, mono: 1, hand: 1.12 };

export const FONT_STACK: Record<FontKey, string> = {
  sans: 'Helvetica, Arial, sans-serif',
  serif: "Georgia, 'Times New Roman', serif",
  mono: 'ui-monospace, Menlo, Consolas, monospace',
  hand: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', 'Chalkboard SE', cursive",
};

export function charWidth(ch: string, bold = false, font: FontKey = 'sans'): number {
  if (font === 'mono') return 600;
  const c = ch.charCodeAt(0);
  let w: number;
  if (c >= 32 && c <= 126) w = (bold ? ASCII_BOLD : ASCII)[c - 32];
  else if (EXTRA[ch] !== undefined) w = EXTRA[ch];
  else if (c >= 0x1f000) w = 1000; // emoji
  else if (c >= 0x2e80) w = 1000; // CJK
  else w = 556;
  return w * FONT_FACTOR[font];
}

/** Width of a single line in px. */
export function textWidth(s: string, size: number, bold = false, font: FontKey = 'sans'): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch, bold, font);
  return (w / 1000) * size;
}

export interface TextLayout {
  lines: string[];
  widths: number[];
  width: number;
  height: number;
  lineHeight: number;
}

export const LINE_HEIGHT = 1.25;

/** Wraps text into lines no wider than `maxWidth` (words first, long words by character). */
export function layoutText(text: string, size: number, opts: { maxWidth?: number; bold?: boolean; font?: FontKey; lineHeight?: number; maxLines?: number } = {}): TextLayout {
  const font = opts.font ?? 'sans';
  const bold = !!opts.bold;
  const max = opts.maxWidth && opts.maxWidth > 0 ? opts.maxWidth : Infinity;
  const lh = size * (opts.lineHeight ?? LINE_HEIGHT);
  const lines: string[] = [];
  const space = textWidth(' ', size, bold, font);
  for (const para of String(text ?? '').split('\n')) {
    if (max === Infinity) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let cur = '';
    let curW = 0;
    const flush = () => {
      lines.push(cur.replace(/\s+$/, ''));
      cur = '';
      curW = 0;
    };
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        if (cur) {
          cur += ' ';
          curW += space;
        }
        continue;
      }
      const ww = textWidth(word, size, bold, font);
      if (curW + ww <= max || !cur.trim()) {
        if (ww > max) {
          // a word longer than the line: break by characters
          for (const ch of word) {
            const cw = textWidth(ch, size, bold, font);
            if (curW + cw > max && cur.trim()) flush();
            cur += ch;
            curW += cw;
          }
        } else {
          cur += word;
          curW += ww;
        }
      } else {
        flush();
        cur = word;
        curW = ww;
        if (ww > max) {
          cur = '';
          curW = 0;
          for (const ch of word) {
            const cw = textWidth(ch, size, bold, font);
            if (curW + cw > max && cur) flush();
            cur += ch;
            curW += cw;
          }
        }
      }
    }
    flush();
  }
  let out = lines;
  if (opts.maxLines && out.length > opts.maxLines) {
    out = out.slice(0, opts.maxLines);
    const last = out[out.length - 1];
    let cut = last;
    while (cut && textWidth(`${cut}…`, size, bold, font) > max) cut = cut.slice(0, -1);
    out[out.length - 1] = `${cut.replace(/\s+$/, '')}…`;
  }
  const widths = out.map((l) => textWidth(l, size, bold, font));
  return { lines: out, widths, width: widths.length ? Math.max(...widths) : 0, height: out.length * lh, lineHeight: lh };
}

/** The largest font size (≤ `size`, ≥ `min`) at which the text fits into w×h. */
export function fitFontSize(text: string, size: number, w: number, h: number, opts: { bold?: boolean; font?: FontKey; min?: number } = {}): number {
  const min = opts.min ?? 8;
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  let s = size;
  while (s > min) {
    const l = layoutText(text, s, { maxWidth: w, bold: opts.bold, font: opts.font });
    // shrink before a word has to be broken in the middle
    const longest = Math.max(0, ...words.map((wd) => textWidth(wd, s, opts.bold, opts.font)));
    if (l.height <= h && l.width <= w + 0.5 && longest <= w + 0.5) return s;
    s = Math.max(min, Math.floor(s * 0.9));
    if (s === min) break;
  }
  return min;
}
