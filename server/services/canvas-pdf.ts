/**
 * Vector PDF from the canvas display list (no library): paths, colours with transparency, clipping,
 * transforms, text in the PDF base fonts (Helvetica/Times/Courier, WinAnsi – no font embedding) and
 * raster images the caller has already turned into JPEG (DCT) or deflated RGB (+ alpha) data.
 * One page per frame/selection; 1 px = 0.75 pt, so an A4 frame becomes an A4 page.
 *
 * Pure code (also used in the browser).
 */

import type { Cmd } from './canvas-path.js';
import type { Prim } from './canvas-render.js';
import { textWidth } from './canvas-text.js';

export type PdfImage =
  | { kind: 'jpeg'; data: Uint8Array; w: number; h: number; gray?: boolean }
  /** zlib-deflated 8-bit RGB rows (no PNG filter bytes) and optional deflated 8-bit alpha. */
  | { kind: 'flate'; rgb: Uint8Array; alpha?: Uint8Array; w: number; h: number };

export interface PdfPage {
  width: number;
  height: number;
  prims: Prim[];
}

const PT = 0.75;
const f = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

function rgb(c: string): { r: number; g: number; b: number; a: number } | null {
  const m = c.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

/** WinAnsi bytes for a string (unknown characters become '?'). */
const WIN: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '‹': 0x8b, '›': 0x9b };
function winAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    let b = WIN[ch] ?? (c >= 32 && c <= 126 ? c : c >= 0xa0 && c <= 0xff ? c : 63);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += '\\';
    if (b < 32) b = 63;
    out += b >= 0x80 ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b);
  }
  return out;
}

const FONT_NAMES = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'];
function fontIndex(font: string, bold?: boolean, italic?: boolean): number {
  const base = font === 'serif' ? 4 : font === 'mono' ? 8 : 0;
  return base + (bold ? 1 : 0) + (italic ? 2 : 0);
}

interface Res {
  alphas: Map<string, string>;
  images: Map<string, string>;
  fonts: Set<number>;
}

function pathOps(cmds: Cmd[]): string {
  let s = '';
  let cx = 0;
  let cy = 0;
  for (const c of cmds) {
    switch (c[0]) {
      case 'M':
        s += `${f(c[1])} ${f(c[2])} m\n`;
        cx = c[1];
        cy = c[2];
        break;
      case 'L':
        s += `${f(c[1])} ${f(c[2])} l\n`;
        cx = c[1];
        cy = c[2];
        break;
      case 'C':
        s += `${f(c[1])} ${f(c[2])} ${f(c[3])} ${f(c[4])} ${f(c[5])} ${f(c[6])} c\n`;
        cx = c[5];
        cy = c[6];
        break;
      case 'Q': {
        // quadratic → cubic
        const x1 = cx + ((c[1] - cx) * 2) / 3;
        const y1 = cy + ((c[2] - cy) * 2) / 3;
        const x2 = c[3] + ((c[1] - c[3]) * 2) / 3;
        const y2 = c[4] + ((c[2] - c[4]) * 2) / 3;
        s += `${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(c[3])} ${f(c[4])} c\n`;
        cx = c[3];
        cy = c[4];
        break;
      }
      case 'Z':
        s += 'h\n';
        break;
    }
  }
  return s;
}

function gs(res: Res, fillA: number, strokeA: number): string {
  if (fillA >= 0.999 && strokeA >= 0.999) return '';
  const key = `${f(fillA)}/${f(strokeA)}`;
  if (!res.alphas.has(key)) res.alphas.set(key, `GS${res.alphas.size + 1}`);
  return `/${res.alphas.get(key)} gs\n`;
}

function primOps(p: Prim, res: Res, opacity: number, images: Map<string, PdfImage>): string {
  switch (p.t) {
    case 'path': {
      if (!p.d.length) return '';
      const fill = p.fill && p.fill !== 'transparent' && p.fill !== 'none' ? rgb(p.fill) : null;
      const stroke = p.stroke && p.stroke !== 'transparent' && p.stroke !== 'none' && (p.sw ?? 1) > 0 ? rgb(p.stroke) : null;
      if (!fill && !stroke) return '';
      const op = opacity * (p.opacity ?? 1);
      let s = 'q\n' + gs(res, op * (fill?.a ?? 1), op * (stroke?.a ?? 1));
      if (fill) s += `${f(fill.r)} ${f(fill.g)} ${f(fill.b)} rg\n`;
      if (stroke) {
        s += `${f(stroke.r)} ${f(stroke.g)} ${f(stroke.b)} RG\n${f(p.sw ?? 1)} w\n`;
        s += `${p.cap === 'round' ? 1 : p.cap === 'square' ? 2 : 0} J ${p.join === 'round' ? 1 : p.join === 'bevel' ? 2 : 0} j\n`;
        if (p.dash) s += `[${p.dash.map(f).join(' ')}] 0 d\n`;
      }
      s += pathOps(p.d);
      s += fill && stroke ? (p.evenodd ? 'B*' : 'B') : fill ? (p.evenodd ? 'f*' : 'f') : 'S';
      return `${s}\nQ\n`;
    }
    case 'text': {
      const c = rgb(p.color);
      if (!c || !p.lines.some((l) => l)) return '';
      const fi = fontIndex(p.font, p.bold, p.italic);
      res.fonts.add(fi);
      const base = (p.lh - p.size) / 2 + p.size * 0.8;
      let s = 'q\n' + gs(res, opacity * (p.opacity ?? 1) * c.a, 1) + `${f(c.r)} ${f(c.g)} ${f(c.b)} rg\nBT\n/F${fi} ${f(p.size)} Tf\n`;
      p.lines.forEach((line, i) => {
        if (!line) return;
        const w = textWidth(line, p.size, p.bold, p.font === 'mono' ? 'mono' : 'sans');
        const x = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
        // the page is flipped (y down) – flip the text back
        s += `1 0 0 -1 ${f(x)} ${f(p.y + base + i * p.lh)} Tm\n(${winAnsi(line)}) Tj\n`;
      });
      return `${s}ET\nQ\n`;
    }
    case 'image': {
      const img = images.get(p.src);
      if (!img) return '';
      if (!res.images.has(p.src)) res.images.set(p.src, `Im${res.images.size + 1}`);
      const name = res.images.get(p.src)!;
      // cover/contain inside the box, clipped to it (rounded corners too)
      const sc = p.fit === 'contain' ? Math.min(p.w / img.w, p.h / img.h) : Math.max(p.w / img.w, p.h / img.h);
      const dw = img.w * sc;
      const dh = img.h * sc;
      const dx = p.x + (p.w - dw) / 2;
      const dy = p.y + (p.h - dh) / 2;
      let s = 'q\n' + gs(res, opacity * (p.opacity ?? 1), 1);
      s += `${f(p.x)} ${f(p.y)} ${f(p.w)} ${f(p.h)} re W n\n`;
      // images are drawn bottom-up in their unit square: flip inside the flipped page
      s += `${f(dw)} 0 0 ${f(-dh)} ${f(dx)} ${f(dy + dh)} cm\n/${name} Do\nQ\n`;
      return s;
    }
    case 'group': {
      let s = 'q\n';
      if (p.m) s += `${p.m.map(f).join(' ')} cm\n`;
      if (p.clip) s += `${pathOps(p.clip)}W n\n`;
      const op = opacity * (p.opacity ?? 1);
      for (const c of p.children) s += primOps(c, res, op, images);
      return `${s}Q\n`;
    }
  }
}

/** A complete PDF document (one page per entry). */
export function buildPdf(pages: PdfPage[], opts: { images?: Map<string, PdfImage>; title?: string } = {}): Uint8Array {
  const images = opts.images ?? new Map<string, PdfImage>();
  const res: Res = { alphas: new Map(), images: new Map(), fonts: new Set() };
  const contents = pages.map((pg) => `${f(PT)} 0 0 ${f(-PT)} 0 ${f(pg.height * PT)} cm\n${pg.prims.map((p) => primOps(p, res, 1, images)).join('')}`);
  // objects: 1 catalog, 2 pages, 3 info, then fonts, gstates, images, page+content pairs
  const objs: (string | Uint8Array[])[] = [];
  const add = (o: string | Uint8Array[]) => (objs.push(o), objs.length);
  add('');
  add('');
  add(`<< /Producer (HyperLevel Canvas) /Title (${winAnsi(opts.title ?? 'Canvas')}) >>`);
  const fontObj = new Map<number, number>();
  for (const fi of res.fonts) fontObj.set(fi, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAMES[fi]} /Encoding /WinAnsiEncoding >>`));
  const gsObj = new Map<string, number>();
  for (const [key, name] of res.alphas) {
    const [fa, sa] = key.split('/');
    gsObj.set(name, add(`<< /Type /ExtGState /ca ${fa} /CA ${sa} >>`));
  }
  const latin = (s: string) => {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  };
  const imgObj = new Map<string, number>();
  for (const [src, name] of res.images) {
    const img = images.get(src)!;
    if (img.kind === 'jpeg') {
      imgObj.set(name, add([latin(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /${img.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`), img.data, latin('\nendstream')]));
    } else {
      let smask = '';
      if (img.alpha) {
        const a = add([latin(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.alpha.length} >>\nstream\n`), img.alpha, latin('\nendstream')]);
        smask = ` /SMask ${a} 0 R`;
      }
      imgObj.set(name, add([latin(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${img.rgb.length} >>\nstream\n`), img.rgb, latin('\nendstream')]));
    }
  }
  const resources = `<< /Font << ${[...fontObj].map(([fi, o]) => `/F${fi} ${o} 0 R`).join(' ')} >> /ExtGState << ${[...gsObj].map(([n, o]) => `/${n} ${o} 0 R`).join(' ')} >> /XObject << ${[...imgObj].map(([n, o]) => `/${n} ${o} 0 R`).join(' ')} >> >>`;
  const pageIds: number[] = [];
  pages.forEach((pg, i) => {
    const body = latin(contents[i]);
    const c = add([latin(`<< /Length ${body.length} >>\nstream\n`), body, latin('\nendstream')]);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pg.width * PT)} ${f(pg.height * PT)}] /Resources ${resources} /Contents ${c} 0 R >>`));
  });
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const parts: Uint8Array[] = [latin('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let size = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(size);
    const chunk = typeof o === 'string' ? [latin(`${i + 1} 0 obj\n${o}\nendobj\n`)] : [latin(`${i + 1} 0 obj\n`), ...o, latin('\nendobj\n')];
    for (const c of chunk) {
      parts.push(c);
      size += c.length;
    }
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  parts.push(latin(xref));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
