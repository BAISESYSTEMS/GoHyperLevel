import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { App } from '../core/app.js';
import type { Cmd } from './canvas-path.js';
import { buildPdf, type PdfImage, type PdfPage } from './canvas-pdf.js';
import { decodePng, jpegSize } from './canvas-png.js';
import type { Prim } from './canvas-render.js';
import { textWidth } from './canvas-text.js';
import { parseHtml, renderMarkdown, type HNode } from './wiki-markdown.js';
import type { PageRow } from './wiki-store.js';

/**
 * PDF export of wiki pages without a library: the page is rendered to its (sanitised) HTML, parsed back into
 * a small tree and laid out on A4 pages with the PDF base fonts (Helvetica, Courier; Western European
 * characters only – anything else prints as "?"). Headings, paragraphs with bold/italic/code/links, lists,
 * checklists, quotes, callouts, code blocks, tables and images (PNG/JPEG of the media library) are supported.
 * Pure layout code: it reads nothing but the pages and the upload folder.
 */

const W = 794;
const H = 1123;
const ML = 64;
const MR = 64;
const MT = 64;
const MB = 78;
const CW = W - ML - MR;

const INK = '#0f172a';
const MUTED = '#64748b';
const LINK = '#1d4ed8';

type Style = { bold?: boolean; italic?: boolean; mono?: boolean; link?: boolean; mark?: boolean; strike?: boolean; color?: string };
type Tok = { w: string; style: Style; space: boolean; width: number } | { br: true } | { img: HNode };

const clean = (s: string) => s.replace(/→/g, '->').replace(/←/g, '<-').replace(/⇒/g, '=>').replace(/[✓✔]/g, '+').replace(/[​-‏⁠﻿]/g, '').replace(/ /g, ' ');
const fontOf = (s: Style): 'sans' | 'mono' => (s.mono ? 'mono' : 'sans');

interface Deco {
  kind: 'bar' | 'box';
  x: number;
  w: number;
  fill: string;
  bar?: string;
  y0: number;
  page: number;
}

class Layout {
  pages: { prims: Prim[]; behind: Prim[] }[] = [];
  y = MT;
  decos: Deco[] = [];
  constructor() {
    this.newPage(false);
  }
  get page() {
    return this.pages[this.pages.length - 1];
  }
  rect(into: Prim[], x: number, y: number, w: number, h: number, o: { fill?: string; stroke?: string; sw?: number }) {
    const d: Cmd[] = [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
    into.push({ t: 'path', d, ...(o.fill ? { fill: o.fill } : {}), ...(o.stroke ? { stroke: o.stroke, sw: o.sw ?? 1 } : {}) });
  }
  private closeDeco(d: Deco, y1: number, page = this.pages.length - 1) {
    const p = this.pages[page];
    if (!p || y1 <= d.y0) return;
    this.rect(p.behind, d.x, d.y0, d.w, y1 - d.y0, { fill: d.fill });
    if (d.bar) this.rect(p.behind, d.x, d.y0, 3, y1 - d.y0, { fill: d.bar });
  }
  newPage(carry = true) {
    if (carry) for (const d of this.decos) this.closeDeco(d, H - MB + 4);
    this.pages.push({ prims: [], behind: [] });
    this.y = MT;
    for (const d of this.decos) {
      d.y0 = MT - 4;
      d.page = this.pages.length - 1;
    }
  }
  ensure(h: number) {
    if (this.y + h > H - MB) this.newPage();
  }
  begin(d: Omit<Deco, 'y0' | 'page'>): Deco {
    const full = { ...d, y0: this.y - 4, page: this.pages.length - 1 };
    this.decos.push(full);
    return full;
  }
  end(d: Deco) {
    this.closeDeco(d, this.y + 2);
    this.decos = this.decos.filter((x) => x !== d);
  }
  text(x: number, y: number, line: string, size: number, s: Style, lh: number) {
    this.page.prims.push({ t: 'text', x, y, lines: [clean(line)], size, font: fontOf(s), bold: s.bold, italic: s.italic, anchor: 'start', color: s.color ?? INK, lh });
  }
}

// --- inline ------------------------------------------------------------------------------------------

function tokens(nodes: HNode[], style: Style, out: Tok[] = []): Tok[] {
  for (const n of nodes) {
    if (n.tag === '#text') {
      const t = clean(n.text ?? '').replace(/\s+/g, ' ');
      const parts = t.split(/( )/);
      let pendingSpace = false;
      for (const p of parts) {
        if (p === ' ') pendingSpace = true;
        else if (p) {
          out.push({ w: p, style, space: pendingSpace, width: 0 });
          pendingSpace = false;
        }
      }
      if (pendingSpace && out.length) {
        // trailing space belongs to the next word
        out.push({ w: '', style, space: true, width: 0 });
      }
      continue;
    }
    switch (n.tag) {
      case 'br':
        out.push({ br: true });
        break;
      case 'img':
        out.push({ img: n });
        break;
      case 'input':
        break;
      case 'strong':
        tokens(n.children, { ...style, bold: true }, out);
        break;
      case 'em':
        tokens(n.children, { ...style, italic: true }, out);
        break;
      case 'del':
        tokens(n.children, { ...style, strike: true }, out);
        break;
      case 'mark':
        tokens(n.children, { ...style, mark: true }, out);
        break;
      case 'code':
        tokens(n.children, { ...style, mono: true }, out);
        break;
      case 'a':
        tokens(n.children, { ...style, link: true, color: LINK }, out);
        break;
      case 'span':
        tokens(n.children, /wk-(mention|chip|pagelink)/.test(n.attrs.class ?? '') ? { ...style, color: LINK } : style, out);
        break;
      default:
        tokens(n.children, style, out);
    }
  }
  return out;
}

interface Seg {
  text: string;
  style: Style;
  x: number;
  w: number;
}
interface Line {
  segs: Seg[];
  w: number;
  img?: HNode;
}

function wrap(toks: Tok[], width: number, size: number): Line[] {
  const lines: Line[] = [];
  let cur: Line = { segs: [], w: 0 };
  const push = () => {
    lines.push(cur);
    cur = { segs: [], w: 0 };
  };
  const widthOf = (t: string, s: Style) => textWidth(t, size, !!s.bold, fontOf(s));
  const spaceW = (s: Style) => widthOf(' ', s);
  for (const t of toks) {
    if ('br' in t) {
      push();
      continue;
    }
    if ('img' in t) {
      if (cur.segs.length) push();
      lines.push({ segs: [], w: 0, img: t.img });
      continue;
    }
    if (!t.w) continue;
    let word = t.w;
    const sp = t.space && cur.segs.length ? spaceW(t.style) : 0;
    let ww = widthOf(word, t.style);
    if (cur.w + sp + ww > width && cur.segs.length) {
      push();
      cur.segs = [];
    }
    const lead = cur.segs.length ? sp : 0;
    // a word longer than the line is cut
    while (ww > width && word.length > 1) {
      let k = word.length - 1;
      while (k > 1 && widthOf(word.slice(0, k), t.style) > width - cur.w) k--;
      cur.segs.push({ text: word.slice(0, k), style: t.style, x: cur.w, w: widthOf(word.slice(0, k), t.style) });
      cur.w += widthOf(word.slice(0, k), t.style);
      push();
      word = word.slice(k);
      ww = widthOf(word, t.style);
    }
    cur.segs.push({ text: (lead ? ' ' : '') + word, style: t.style, x: cur.w, w: lead + ww });
    cur.w += lead + ww;
  }
  if (cur.segs.length || !lines.length) lines.push(cur);
  return lines;
}

// --- document --------------------------------------------------------------------------------------------

export function buildWikiPdf(app: App, pages: PageRow[], opts: { space: string; baseUrl: string; author: string; publicView?: boolean }): Uint8Array {
  const uploadDir = join(app.config.dataDir, 'uploads');
  const cache = new Map<string, PdfImage | null>();
  const imageOf = (src: string): PdfImage | undefined => {
    const m = /^\/uploads\/([A-Za-z0-9]{8,40}\.(?:png|jpe?g))$/.exec(src);
    if (!m) return undefined;
    if (!cache.has(src)) {
      let img: PdfImage | null = null;
      try {
        const file = join(uploadDir, m[1]);
        if (existsSync(file)) img = toPdfImage(readFileSync(file));
      } catch {
        img = null;
      }
      cache.set(src, img);
    }
    return cache.get(src) ?? undefined;
  };
  const L = new Layout();
  const day = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { timeZone: app.location(pages[0]?.location_id ?? '')?.timezone || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

  const emitLines = (lines: Line[], x: number, size: number, lh: number) => {
    for (const ln of lines) {
      if (ln.img) {
        block([ln.img], x, CW - (x - ML));
        continue;
      }
      L.ensure(lh);
      for (const s of ln.segs) {
        const sx = x + s.x;
        if (s.style.mark) L.rect(L.page.behind, sx, L.y + (lh - size) / 2 - 1, s.w, size + 3, { fill: '#fde68a' });
        else if (s.style.mono) L.rect(L.page.behind, sx, L.y + (lh - size) / 2 - 1, s.w, size + 3, { fill: '#eef2f7' });
        L.text(sx, L.y, s.text, size, s.style, lh);
        if (s.style.link) L.page.prims.push({ t: 'path', d: [['M', sx, L.y + lh - 4], ['L', sx + s.w, L.y + lh - 4]], stroke: LINK, sw: 0.7 });
        if (s.style.strike) L.page.prims.push({ t: 'path', d: [['M', sx, L.y + lh / 2], ['L', sx + s.w, L.y + lh / 2]], stroke: INK, sw: 0.8 });
      }
      L.y += lh;
    }
  };
  const paragraph = (nodes: HNode[], x: number, width: number, size = 12.5, style: Style = {}, gap = 7) => {
    const lines = wrap(tokens(nodes, style), width, size);
    emitLines(lines, x, size, size * 1.5);
    L.y += gap;
  };
  const textOf = (n: HNode): string => (n.tag === '#text' ? (n.text ?? '') : n.children.map(textOf).join(''));
  const isInline = (n: HNode) => ['#text', 'strong', 'em', 'del', 'mark', 'code', 'a', 'span', 'br', 'img', 'input'].includes(n.tag);

  const drawImage = (n: HNode, x: number, width: number) => {
    const src = n.attrs.src ?? '';
    const img = imageOf(src);
    if (!img) {
      paragraph([{ tag: '#text', attrs: {}, children: [], text: `[Bild: ${n.attrs.alt || src.split('/').pop() || 'extern'}]` }], x, width, 11, { italic: true, color: MUTED });
      return;
    }
    let w = Math.min(width, img.w * 0.75 > 0 ? Math.max(120, img.w) : width);
    let h = (w * img.h) / img.w;
    if (h > 520) {
      h = 520;
      w = (h * img.w) / img.h;
    }
    L.ensure(h + 8);
    L.page.prims.push({ t: 'image', x, y: L.y, w, h, src, fit: 'contain' });
    L.y += h + 10;
  };

  const list = (n: HNode, x: number, width: number, depth: number) => {
    const ordered = n.tag === 'ol';
    let num = Number(n.attrs.start) || 1;
    for (const li of n.children.filter((c) => c.tag === 'li')) {
      const task = /wk-task/.test(li.attrs.class ?? '');
      const checked = /wk-done/.test(li.attrs.class ?? '');
      const inl = li.children.filter((c) => isInline(c) || (c.tag === 'span' && task));
      const rest = li.children.filter((c) => !isInline(c) && !(c.tag === 'span' && task));
      const size = 12.5;
      const lh = size * 1.5;
      L.ensure(lh + 2);
      const markY = L.y;
      if (task) {
        const bx = x + 2;
        const by = markY + (lh - 11) / 2;
        L.rect(L.page.prims, bx, by, 11, 11, { stroke: '#475569', sw: 1 });
        if (checked) L.page.prims.push({ t: 'path', d: [['M', bx + 2, by + 6], ['L', bx + 4.5, by + 8.5], ['L', bx + 9, by + 2.5]], stroke: '#16a34a', sw: 1.6 });
      } else L.text(x + 4, markY, ordered ? `${num}.` : '•', size, { color: MUTED }, lh);
      paragraphAt(inl, x + 24, width - 24, size, checked ? { color: MUTED, strike: false } : {}, 3);
      for (const r of rest) {
        if (r.tag === 'ul' || r.tag === 'ol') list(r, x + 24, width - 24, depth + 1);
        else block([r], x + 24, width - 24);
      }
      num++;
    }
    L.y += 4;
  };
  const paragraphAt = (nodes: HNode[], x: number, width: number, size: number, style: Style, gap: number) => paragraph(nodes, x, width, size, style, gap);

  const callout = (n: HNode, x: number, width: number) => {
    const kind = n.attrs['data-kind'] ?? 'info';
    const colors: Record<string, [string, string]> = { info: ['#eff6ff', '#2563eb'], note: ['#f1f5f9', '#64748b'], tip: ['#f5f3ff', '#8b5cf6'], warning: ['#fffbeb', '#f59e0b'], danger: ['#fef2f2', '#dc2626'], success: ['#f0fdf4', '#16a34a'] };
    const [bg, bar] = colors[kind] ?? colors.info;
    L.ensure(50);
    const d = L.begin({ kind: 'box', x, w: width, fill: bg, bar });
    L.y += 6;
    const title = n.children.find((c) => /wk-callout-title/.test(c.attrs.class ?? ''));
    const body = n.children.find((c) => /wk-callout-body/.test(c.attrs.class ?? ''));
    if (title) paragraph(title.children, x + 14, width - 24, 12.5, { bold: true }, 2);
    if (body) block(body.children, x + 14, width - 24);
    L.end(d);
    L.y += 8;
  };

  const code = (n: HNode, x: number, width: number) => {
    const raw = textOf(n).replace(/\t/g, '    ').replace(/\n$/, '');
    const size = 10.5;
    const lh = 15;
    const max = Math.max(8, Math.floor((width - 20) / textWidth('M', size, false, 'mono')));
    const out: string[] = [];
    for (const l of raw.split('\n')) {
      if (!l) out.push('');
      for (let k = 0; k < l.length; k += max) out.push(l.slice(k, k + max));
    }
    L.ensure(lh * Math.min(out.length, 3) + 16);
    const d = L.begin({ kind: 'box', x, w: width, fill: '#f1f5f9' });
    L.y += 6;
    for (const l of out.slice(0, 600)) {
      L.ensure(lh);
      if (l) L.text(x + 10, L.y, l, size, { mono: true }, lh);
      L.y += lh;
    }
    L.y += 2;
    L.end(d);
    L.y += 8;
  };

  const table = (n: HNode, x: number, width: number) => {
    const t = n.children.find((c) => c.tag === 'table');
    if (!t) return;
    const rows: { cells: HNode[]; head: boolean }[] = [];
    for (const sec of t.children) for (const tr of sec.children.filter((c) => c.tag === 'tr')) rows.push({ cells: tr.children.filter((c) => c.tag === 'th' || c.tag === 'td'), head: sec.tag === 'thead' });
    const cols = Math.max(1, ...rows.map((r) => r.cells.length));
    const size = 11;
    // column widths follow the longest word/text, within limits
    const want = Array.from({ length: cols }, (_x, k) => Math.max(50, Math.min(width, ...[Math.max(...rows.map((r) => textWidth(textOf(r.cells[k] ?? { tag: '#text', attrs: {}, children: [], text: '' }), size, r.head, 'sans') + 22, 0))])));
    const total = want.reduce((a, b) => a + b, 0);
    const scale = total > width ? width / total : 1;
    const cw = want.map((w) => w * scale);
    const widths = total < width ? want.map((w) => (w / total) * width) : cw;
    for (const r of rows.slice(0, 500)) {
      const cellLines = r.cells.map((c, k) => wrap(tokens(c.children, r.head ? { bold: true } : {}), widths[k] - 14, size));
      const rh = Math.max(...cellLines.map((ls) => ls.length), 1) * size * 1.45 + 10;
      L.ensure(Math.min(rh, H - MT - MB));
      let cx = x;
      const y0 = L.y;
      r.cells.forEach((c, k) => {
        L.rect(L.page.behind, cx, y0, widths[k], rh, { fill: r.head ? '#eef2ff' : '#ffffff' });
        L.rect(L.page.prims, cx, y0, widths[k], rh, { stroke: '#cbd5e1', sw: 0.8 });
        let ly = y0 + 5;
        for (const ln of cellLines[k]) {
          const al = /wk-al-r/.test(c.attrs.class ?? '') ? widths[k] - 14 - ln.w : /wk-al-c/.test(c.attrs.class ?? '') ? (widths[k] - 14 - ln.w) / 2 : 0;
          for (const s of ln.segs) L.text(cx + 7 + al + s.x, ly, s.text, size, s.style, size * 1.45);
          ly += size * 1.45;
        }
        cx += widths[k];
      });
      L.y = y0 + rh;
    }
    L.y += 10;
  };

  function block(nodes: HNode[], x: number, width: number) {
    let run: HNode[] = [];
    const flush = () => {
      if (run.some((r) => r.tag !== '#text' || (r.text ?? '').trim())) paragraph(run, x, width);
      run = [];
    };
    for (const n of nodes) {
      if (isInline(n)) {
        if (n.tag === 'img') {
          flush();
          drawImage(n, x, width);
        } else run.push(n);
        continue;
      }
      flush();
      const cls = n.attrs.class ?? '';
      switch (n.tag) {
        case 'p':
          paragraph(n.children, x, width);
          break;
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = Number(n.tag[1]);
          const size = [28, 21, 17.5, 15, 13.5, 12.5][level - 1];
          L.y += level <= 3 ? 10 : 6;
          L.ensure(size * 1.4 + 70);
          paragraph(n.children, x, width, size, { bold: true }, 5);
          break;
        }
        case 'ul':
        case 'ol':
          list(n, x, width, 0);
          break;
        case 'blockquote': {
          L.ensure(40);
          const d = L.begin({ kind: 'bar', x, w: width, fill: '#f1f5f9', bar: '#94a3b8' });
          L.y += 4;
          block(n.children, x + 14, width - 20);
          L.end(d);
          L.y += 6;
          break;
        }
        case 'hr':
          L.ensure(20);
          L.page.prims.push({ t: 'path', d: [['M', x, L.y + 8], ['L', x + width, L.y + 8]], stroke: '#cbd5e1', sw: 1 });
          L.y += 20;
          break;
        case 'pre':
          code(n, x, width);
          break;
        case 'div':
          if (/wk-callout\b/.test(cls)) callout(n, x, width);
          else if (/wk-table-wrap/.test(cls)) table(n, x, width);
          else if (/wk-card/.test(cls)) {
            L.ensure(34);
            const d = L.begin({ kind: 'box', x, w: width, fill: '#eef2ff', bar: '#6366f1' });
            L.y += 6;
            paragraph([{ tag: '#text', attrs: {}, children: [], text: `Datensatz: ${textOf(n).trim()}` }], x + 12, width - 20, 12, { color: LINK }, 4);
            L.end(d);
            L.y += 6;
          } else block(n.children, x, width);
          break;
        default:
          block(n.children, x, width);
      }
    }
    flush();
  }

  pages.slice(0, 200).forEach((p, i) => {
    if (i > 0) L.newPage();
    const titleLines = wrap(tokens([{ tag: '#text', attrs: {}, children: [], text: p.title }], { bold: true }), CW, 26);
    emitLines(titleLines, ML, 26, 33);
    L.y += 2;
    paragraph([{ tag: '#text', attrs: {}, children: [], text: [opts.space, `Aktualisiert am ${day(p.updated_at)}`, p.updated_by_name].filter(Boolean).join(' · ') }], ML, CW, 10.5, { color: MUTED }, 6);
    L.page.prims.push({ t: 'path', d: [['M', ML, L.y], ['L', ML + CW, L.y]], stroke: '#e2e8f0', sw: 1 });
    L.y += 14;
    // the PDF is a copy: no live data, no links into the app
    block(parseHtml(renderMarkdown(p.body, { publicView: true, baseLevel: 2 }).html), ML, CW);
  });

  const total = L.pages.length;
  const out: PdfPage[] = L.pages.slice(0, 400).map((pg, i) => {
    const footer: Prim = { t: 'text', x: W / 2, y: H - 46, lines: [clean(`${pages[0]?.title ?? ''}  ·  Seite ${i + 1} von ${total}`)], size: 9, font: 'sans', anchor: 'middle', color: MUTED, lh: 12 };
    return { width: W, height: H, prims: [...pg.behind, ...pg.prims, footer] };
  });
  const images = new Map<string, PdfImage>();
  for (const [src, img] of cache) if (img) images.set(src, img);
  return buildPdf(out, { images, title: pages[0]?.title ?? 'Wiki' });
}

/** PNG or JPEG bytes → what the PDF writer can embed (null for other formats). */
function toPdfImage(buf: Buffer): PdfImage | null {
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
