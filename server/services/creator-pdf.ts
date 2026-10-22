import { deflateSync } from 'node:zlib';
import type { Cmd } from './canvas-path.js';
import { buildPdf, type PdfImage, type PdfPage } from './canvas-pdf.js';
import { decodePng, jpegSize } from './canvas-png.js';
import type { Prim } from './canvas-render.js';
import { layoutText, textWidth } from './canvas-text.js';

/**
 * A tiny page builder on top of the canvas PDF writer (no library): rectangles, lines, text in the PDF base fonts
 * (Western European characters) and JPEG/PNG images. Used for the certificates and the dunning letters. A4 is 794 × 1123,
 * landscape 1123 × 794 (pixels at 96 dpi; the writer turns them into points).
 */

export const A4 = { w: 794, h: 1123 };

export class Page {
  prims: Prim[] = [];
  constructor(
    public width = A4.w,
    public height = A4.h,
  ) {}

  rect(x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; sw?: number } = {}) {
    const d: Cmd[] = [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
    this.prims.push({ t: 'path', d, ...(o.fill ? { fill: o.fill } : {}), ...(o.stroke ? { stroke: o.stroke, sw: o.sw ?? 1 } : {}) });
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { stroke?: string; sw?: number } = {}) {
    this.prims.push({ t: 'path', d: [['M', x1, y1], ['L', x2, y2]], stroke: o.stroke ?? '#cbd5e1', sw: o.sw ?? 1 });
  }

  /** One line; `y` is the top of the line box. */
  text(x: number, y: number, s: string, size: number, o: { bold?: boolean; italic?: boolean; color?: string; anchor?: 'start' | 'middle' | 'end'; font?: 'sans' | 'serif' | 'mono' } = {}) {
    if (!s) return;
    this.prims.push({ t: 'text', x, y, lines: [s], size, font: o.font ?? 'sans', bold: o.bold, italic: o.italic, anchor: o.anchor ?? 'start', color: o.color ?? '#0f172a', lh: size * 1.25 });
  }

  /** A wrapped paragraph; returns its height. */
  para(x: number, y: number, s: string, width: number, size: number, o: { bold?: boolean; color?: string; font?: 'sans' | 'serif' | 'mono'; gap?: number; anchor?: 'start' | 'middle' | 'end'; maxLines?: number } = {}): number {
    const lay = layoutText(s, size, { maxWidth: width, bold: o.bold, font: o.font ?? 'sans', lineHeight: 1.4, maxLines: o.maxLines });
    lay.lines.forEach((line, i) => {
      if (!line) return;
      const x0 = o.anchor === 'middle' ? x + width / 2 : o.anchor === 'end' ? x + width : x;
      this.prims.push({ t: 'text', x: x0, y: y + i * lay.lineHeight, lines: [line], size, font: o.font ?? 'sans', bold: o.bold, anchor: o.anchor ?? 'start', color: o.color ?? '#0f172a', lh: lay.lineHeight });
    });
    return lay.height + (o.gap ?? 0);
  }

  image(x: number, y: number, w: number, h: number, src: string, fit: 'cover' | 'contain' = 'contain') {
    this.prims.push({ t: 'image', x, y, w, h, src, fit });
  }
}

export const textW = textWidth;

/** The image as the PDF writer takes it: JPEG as it is, PNG decoded to deflated RGB (+ alpha). Null for anything else. */
export function pdfImageOf(buf: Buffer): PdfImage | null {
  const size = jpegSize(buf);
  if (size) return { kind: 'jpeg', data: buf, w: size.w, h: size.h, gray: size.gray };
  const bmp = buf[0] === 0x89 ? decodePng(buf) : null;
  if (!bmp) return null;
  const rgb = Buffer.alloc(bmp.w * bmp.h * 3);
  const alpha = Buffer.alloc(bmp.w * bmp.h);
  let hasAlpha = false;
  for (let i = 0, j = 0; i < bmp.data.length; i += 4, j++) {
    rgb[j * 3] = bmp.data[i];
    rgb[j * 3 + 1] = bmp.data[i + 1];
    rgb[j * 3 + 2] = bmp.data[i + 2];
    alpha[j] = bmp.data[i + 3];
    if (bmp.data[i + 3] < 255) hasAlpha = true;
  }
  return { kind: 'flate', rgb: deflateSync(rgb), alpha: hasAlpha ? deflateSync(alpha) : undefined, w: bmp.w, h: bmp.h };
}

export function pdfOf(pages: Page[], o: { images?: Map<string, PdfImage>; title?: string } = {}): Buffer {
  const list: PdfPage[] = pages.map((p) => ({ width: p.width, height: p.height, prims: p.prims }));
  return Buffer.from(buildPdf(list, { images: o.images, title: o.title ?? 'Dokument' }));
}

/** An emoji with its modifiers (variation selector, skin tone, joined sequences, flags) and one space on either side. */
const EMOJI = / ?(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}])(?:[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]|\p{Extended_Pictographic})* ?/gu;

/**
 * Text safe for the base fonts: the writer prints anything outside Western European characters as "?". Emoji and pictographs
 * (a 🎉 in a company or product name) are dropped instead of becoming a stray "?" on an invoice; ©, ® and ™ stay.
 */
export const latin = (s: string) =>
  String(s ?? '')
    .replace(/→/g, '->')
    .replace(/[✓✔]/g, '+')
    .replace(EMOJI, (m) => {
      const core = m.trim();
      if ((core.codePointAt(0) ?? 0) < 0x2190) return m;
      return m.startsWith(' ') && m.endsWith(' ') && m.length > core.length + 1 ? ' ' : '';
    })
    .replace(/[​-‏⁠﻿]/g, '');

/**
 * One line that has to stay inside `max` (a column, the address window): the size shrinks down to `min`, and only a text that is
 * still too long is cut with "…". Returns the text and the size to draw it with.
 */
export function fitLine(s: string, size: number, max: number, o: { bold?: boolean; min?: number } = {}): { text: string; size: number } {
  const min = Math.min(size, o.min ?? 8);
  let sz = size;
  while (sz > min && textW(s, sz, o.bold) > max) sz = Math.max(min, sz - 0.5);
  if (textW(s, sz, o.bold) <= max) return { text: s, size: sz };
  let cut = s;
  while (cut && textW(`${cut}…`, sz, o.bold) > max) cut = cut.slice(0, -1);
  return { text: `${cut.trimEnd()}…`, size: sz };
}

/** The size (between `size` and `min`) at which `s` fits into `max` on one line, or 0 when it does not fit even at `min`. */
export function sizeToFit(s: string, size: number, max: number, o: { bold?: boolean; min?: number } = {}): number {
  const f = fitLine(s, size, max, o);
  return f.text === s ? f.size : 0;
}
