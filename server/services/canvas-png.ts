/**
 * Server-side PNG export of the canvas without a browser or native library: an anti-aliased
 * scanline rasterizer (non-zero/even-odd fill, strokes with round joins, dashes, clipping, opacity),
 * text in the built-in stroke font (canvas-font.ts), media-library images (PNG and baseline JPEG
 * decoders below) and a PNG encoder. Used for MCP exports and the mobile API; the editor exports
 * PNGs with the browser's own renderer.
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { type Cmd, type Mat, type Pt, IDENTITY, apply, flatten, invert, mul, transformCmds } from './canvas-path.js';
import type { Prim } from './canvas-render.js';
import { charWidth, textWidth } from './canvas-text.js';
import { glyph } from './canvas-font.js';

export interface Bitmap {
  w: number;
  h: number;
  /** RGBA, 8 bit, straight alpha. */
  data: Uint8Array;
}

// --- colour --------------------------------------------------------------------------------------------

function parseColor(c: string | undefined): [number, number, number, number] | null {
  if (!c || c === 'transparent' || c === 'none') return null;
  const m = c.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
}

// --- rasterizer ----------------------------------------------------------------------------------------

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dir: number;
}

interface Clip {
  x0: number;
  y0: number;
  w: number;
  h: number;
  data: Float32Array;
}

const SUB = 4;

class Raster {
  readonly data: Float32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    // premultiplied RGBA in 0..1
    this.data = new Float32Array(w * h * 4);
  }

  /** Coverage of a set of polygons (device space) as rows; calls `blend(x, y, coverage)`. */
  private coverage(polys: Pt[][], evenodd: boolean, blend: (x: number, y: number, a: number) => void) {
    const edges: Edge[] = [];
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        if (!Number.isFinite(a[0]) || !Number.isFinite(a[1]) || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) continue;
        minX = Math.min(minX, a[0]);
        maxX = Math.max(maxX, a[0]);
        if (a[1] === b[1]) continue;
        const e = a[1] < b[1] ? { x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: 1 } : { x0: b[0], y0: b[1], x1: a[0], y1: a[1], dir: -1 };
        edges.push(e);
        minY = Math.min(minY, e.y0);
        maxY = Math.max(maxY, e.y1);
      }
    }
    if (!edges.length) return;
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const xa = Math.max(0, Math.floor(minX));
    const xb = Math.min(this.w - 1, Math.ceil(maxX));
    if (y1 < y0 || xb < xa) return;
    edges.sort((p, q) => p.y0 - q.y0);
    const row = new Float32Array(this.w + 2);
    let next = 0;
    let active: Edge[] = [];
    const xs: { x: number; d: number }[] = [];
    for (let y = y0; y <= y1; y++) {
      row.fill(0, xa, xb + 2);
      let any = false;
      for (let s = 0; s < SUB; s++) {
        const sy = y + (s + 0.5) / SUB;
        while (next < edges.length && edges[next].y0 <= sy) active.push(edges[next++]);
        active = active.filter((e) => e.y1 > sy);
        xs.length = 0;
        for (const e of active) if (e.y0 <= sy) xs.push({ x: e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), d: e.dir });
        if (xs.length < 2) continue;
        xs.sort((p, q) => p.x - q.x);
        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += evenodd ? 1 : xs[i].d;
          const inside = evenodd ? wind % 2 !== 0 : wind !== 0;
          if (!inside) continue;
          const l = Math.max(xa, xs[i].x);
          const r = Math.min(xb + 1, xs[i + 1].x);
          if (r <= l) continue;
          any = true;
          const li = Math.floor(l);
          const ri = Math.floor(r);
          const k = 1 / SUB;
          if (li === ri) row[li] += (r - l) * k;
          else {
            row[li] += (li + 1 - l) * k;
            for (let x = li + 1; x < ri; x++) row[x] += k;
            if (ri <= xb) row[ri] += (r - ri) * k;
          }
        }
      }
      if (!any) continue;
      for (let x = xa; x <= xb; x++) if (row[x] > 0.002) blend(x, y, Math.min(1, row[x]));
    }
  }

  fill(polys: Pt[][], color: [number, number, number, number], alpha: number, clip: Clip | null, evenodd = false) {
    const a0 = color[3] * alpha;
    if (a0 <= 0) return;
    const r = color[0] / 255;
    const g = color[1] / 255;
    const b = color[2] / 255;
    const d = this.data;
    this.coverage(polys, evenodd, (x, y, cov) => {
      let a = cov * a0;
      if (clip) a *= clipAt(clip, x, y);
      if (a <= 0) return;
      const i = (y * this.w + x) * 4;
      const inv = 1 - a;
      d[i] = r * a + d[i] * inv;
      d[i + 1] = g * a + d[i + 1] * inv;
      d[i + 2] = b * a + d[i + 2] * inv;
      d[i + 3] = a + d[i + 3] * inv;
    });
  }

  /** A coverage mask of polygons (clipping), intersected with an outer clip. */
  mask(polys: Pt[][], outer: Clip | null): Clip {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of polys)
      for (const [x, y] of p) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    const x0 = Math.max(0, Math.floor(Number.isFinite(minX) ? minX : 0));
    const y0 = Math.max(0, Math.floor(Number.isFinite(minY) ? minY : 0));
    const w = Math.max(0, Math.min(this.w, Math.ceil(Number.isFinite(maxX) ? maxX : 0) + 1) - x0);
    const h = Math.max(0, Math.min(this.h, Math.ceil(Number.isFinite(maxY) ? maxY : 0) + 1) - y0);
    const m: Clip = { x0, y0, w, h, data: new Float32Array(w * h) };
    this.coverage(polys, false, (x, y, cov) => {
      if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return;
      m.data[(y - y0) * w + (x - x0)] = cov * (outer ? clipAt(outer, x, y) : 1);
    });
    return m;
  }

  drawImage(img: Bitmap, m: Mat, box: { x: number; y: number; w: number; h: number }, fit: 'cover' | 'contain', alpha: number, clip: Clip | null) {
    const sc = fit === 'contain' ? Math.min(box.w / img.w, box.h / img.h) : Math.max(box.w / img.w, box.h / img.h);
    const dw = img.w * sc;
    const dh = img.h * sc;
    const dx = box.x + (box.w - dw) / 2;
    const dy = box.y + (box.h - dh) / 2;
    // image space → device: m · translate(dx,dy) · scale(sc)
    const toDev = mul(m, [sc, 0, 0, sc, dx, dy]);
    const inv = invert(toDev);
    const corners = [apply(m, box.x, box.y), apply(m, box.x + box.w, box.y), apply(m, box.x, box.y + box.h), apply(m, box.x + box.w, box.y + box.h)];
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const x1 = Math.min(this.w - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const y1 = Math.min(this.h - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    const boxInv = invert(m);
    const d = this.data;
    const src = img.data;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const [bx, by] = apply(boxInv, x + 0.5, y + 0.5);
        if (bx < box.x || by < box.y || bx > box.x + box.w || by > box.y + box.h) continue;
        const [u, v] = apply(inv, x + 0.5, y + 0.5);
        if (u < 0 || v < 0 || u >= img.w || v >= img.h) continue;
        // bilinear
        const fx = Math.max(0, u - 0.5);
        const fy = Math.max(0, v - 0.5);
        const ix = Math.min(img.w - 1, Math.floor(fx));
        const iy = Math.min(img.h - 1, Math.floor(fy));
        const tx = fx - ix;
        const ty = fy - iy;
        const ix2 = Math.min(img.w - 1, ix + 1);
        const iy2 = Math.min(img.h - 1, iy + 1);
        const px = (xx: number, yy: number, c: number) => src[(yy * img.w + xx) * 4 + c];
        const s = (c: number) => (px(ix, iy, c) * (1 - tx) + px(ix2, iy, c) * tx) * (1 - ty) + (px(ix, iy2, c) * (1 - tx) + px(ix2, iy2, c) * tx) * ty;
        let a = (s(3) / 255) * alpha;
        if (clip) a *= clipAt(clip, x, y);
        if (a <= 0) continue;
        const i = (y * this.w + x) * 4;
        const ia = 1 - a;
        d[i] = (s(0) / 255) * a + d[i] * ia;
        d[i + 1] = (s(1) / 255) * a + d[i + 1] * ia;
        d[i + 2] = (s(2) / 255) * a + d[i + 2] * ia;
        d[i + 3] = a + d[i + 3] * ia;
      }
  }

  toRgba(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a <= 0) continue;
      out[i] = Math.round(Math.min(1, d[i] / a) * 255);
      out[i + 1] = Math.round(Math.min(1, d[i + 1] / a) * 255);
      out[i + 2] = Math.round(Math.min(1, d[i + 2] / a) * 255);
      out[i + 3] = Math.round(Math.min(1, a) * 255);
    }
    return out;
  }
}

function clipAt(c: Clip, x: number, y: number): number {
  if (x < c.x0 || y < c.y0 || x >= c.x0 + c.w || y >= c.y0 + c.h) return 0;
  return c.data[(y - c.y0) * c.w + (x - c.x0)];
}

// --- strokes → polygons ----------------------------------------------------------------------------------

function oriented(poly: Pt[]): Pt[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area < 0 ? poly.slice().reverse() : poly;
}

function circle(cx: number, cy: number, r: number): Pt[] {
  const n = Math.max(8, Math.min(32, Math.ceil(r * 2.5)));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)]);
  return out;
}

function dashLines(pts: Pt[], dash: number[] | undefined): Pt[][] {
  if (!dash || dash.length < 2 || dash.every((d) => d <= 0)) return [pts];
  const out: Pt[][] = [];
  let di = 0;
  let left = dash[0];
  let on = true;
  let cur: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    let seg = Math.hypot(bx - ax, by - ay);
    while (seg > 0) {
      const step = Math.min(left, seg);
      const t = step / seg;
      const nx = ax + (bx - ax) * t;
      const ny = ay + (by - ay) * t;
      if (on) cur.push([nx, ny]);
      seg -= step;
      left -= step;
      ax = nx;
      ay = ny;
      if (left <= 1e-6) {
        if (on && cur.length) out.push(cur);
        on = !on;
        di = (di + 1) % dash.length;
        left = Math.max(0.01, dash[di]);
        cur = on ? [[ax, ay]] : [];
      }
    }
  }
  if (on && cur.length > 1) out.push(cur);
  return out.map((l) => (l.length === 1 ? [l[0], [l[0][0] + 0.01, l[0][1]]] : l));
}

function strokePolys(lines: { pts: Pt[]; closed: boolean }[], hw: number, cap: string | undefined, dash: number[] | undefined): Pt[][] {
  const out: Pt[][] = [];
  const round = cap === 'round';
  for (const line of lines) {
    const base = line.closed ? [...line.pts, line.pts[0]] : line.pts;
    for (const pts of dashLines(base, dash)) {
      for (let i = 1; i < pts.length; i++) {
        let [ax, ay] = pts[i - 1];
        let [bx, by] = pts[i];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        if (cap === 'square') {
          if (i === 1) {
            ax -= ux * hw;
            ay -= uy * hw;
          }
          if (i === pts.length - 1) {
            bx += ux * hw;
            by += uy * hw;
          }
        }
        const nx = -uy * hw;
        const ny = ux * hw;
        out.push(oriented([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]));
      }
      // round joins everywhere; round caps at the ends
      for (let i = 0; i < pts.length; i++) {
        const end = i === 0 || i === pts.length - 1;
        if (end && !round && !line.closed) continue;
        if (hw > 0.35) out.push(oriented(circle(pts[i][0], pts[i][1], hw)));
      }
    }
  }
  return out;
}

const scaleOf = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

// --- text in the stroke font -------------------------------------------------------------------------------

function textStrokes(p: Extract<Prim, { t: 'text' }>): { pts: Pt[]; closed: boolean }[] {
  const out: { pts: Pt[]; closed: boolean }[] = [];
  const k = (p.size * 0.72) / 10;
  const font = p.font === 'mono' ? 'mono' : 'sans';
  p.lines.forEach((line, li) => {
    const base = p.y + (p.lh - p.size) / 2 + p.size * 0.8 + li * p.lh;
    const w = textWidth(line, p.size, p.bold, font);
    let x = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
    for (const ch of line) {
      const adv = (charWidth(ch, p.bold, font) / 1000) * p.size;
      if (ch !== ' ') {
        const g = glyph(ch);
        if (g) {
          const gw = (g.maxX - g.minX) * k;
          const ox = x + (adv - gw) / 2 - g.minX * k;
          for (const s of g.strokes) out.push({ pts: s.map(([gx, gy]): Pt => [ox + gx * k + (p.italic ? gy * k * 0.2 : 0), base - gy * k]), closed: false });
        } else {
          const bx = x + adv * 0.15;
          const bw = adv * 0.7;
          out.push({ pts: [[bx, base], [bx + bw, base], [bx + bw, base - 10 * k], [bx, base - 10 * k]], closed: true });
        }
      }
      x += adv;
    }
  });
  return out;
}

// --- display list → bitmap ---------------------------------------------------------------------------------

export interface PngOptions {
  background?: string;
  /** Decoded images by href (null = could not be read → placeholder). */
  images?: Map<string, Bitmap | null>;
}

export const MAX_PIXELS = 24_000_000;

export function rasterize(prims: Prim[], width: number, height: number, o: PngOptions = {}): Bitmap {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w * h > MAX_PIXELS) throw new Error('Bild zu groß – bitte kleineren Bereich oder Maßstab wählen');
  const r = new Raster(w, h);
  const bg = parseColor(o.background);
  if (bg) r.fill([[[0, 0], [w, 0], [w, h], [0, h]]], bg, 1, null);
  const draw = (p: Prim, m: Mat, alpha: number, clip: Clip | null) => {
    switch (p.t) {
      case 'path': {
        if (!p.d.length) return;
        const op = alpha * (p.opacity ?? 1);
        const dev = transformCmds(p.d, m);
        const fill = parseColor(p.fill);
        if (fill) r.fill(flatten(dev, 0.25).map((l) => l.pts), fill, op, clip, p.evenodd);
        const stroke = parseColor(p.stroke);
        const sw = (p.sw ?? 1) * scaleOf(m);
        if (stroke && sw > 0) {
          const dash = p.dash?.map((v) => v * scaleOf(m));
          r.fill(strokePolys(flatten(dev, 0.25), Math.max(0.35, sw / 2), p.cap, dash), stroke, op * (sw < 0.7 ? sw / 0.7 : 1), clip);
        }
        return;
      }
      case 'text': {
        const c = parseColor(p.color);
        if (!c) return;
        const lines = textStrokes(p).map((l) => ({ pts: l.pts.map(([x, y]) => apply(m, x, y)), closed: l.closed }));
        const sw = p.size * (p.bold ? 0.105 : 0.072) * scaleOf(m);
        r.fill(strokePolys(lines, Math.max(0.4, sw / 2), 'round', undefined), c, alpha * (p.opacity ?? 1), clip);
        return;
      }
      case 'image': {
        const img = o.images?.get(p.src);
        let c = clip;
        if (p.radius) c = r.mask(flatten(transformCmds(roundRect(p.x, p.y, p.w, p.h, p.radius), m), 0.25).map((l) => l.pts), clip);
        if (img) r.drawImage(img, m, p, p.fit, alpha * (p.opacity ?? 1), c);
        else r.fill(flatten(transformCmds(roundRect(p.x, p.y, p.w, p.h, p.radius ?? 0), m), 0.25).map((l) => l.pts), [233, 236, 239, 1], alpha, c);
        return;
      }
      case 'group': {
        const mm = p.m ? mul(m, p.m) : m;
        let c = clip;
        if (p.clip) c = r.mask(flatten(transformCmds(p.clip, mm), 0.25).map((l) => l.pts), clip);
        const op = alpha * (p.opacity ?? 1);
        for (const ch of p.children) draw(ch, mm, op, c);
        return;
      }
    }
  };
  for (const p of prims) draw(p, IDENTITY, 1, null);
  return { w, h, data: r.toRgba() };
}

function roundRect(x: number, y: number, w: number, h: number, rr: number): Cmd[] {
  const r = Math.max(0, Math.min(rr, w / 2, h / 2));
  const k = 0.5523 * r;
  if (!r) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  return [
    ['M', x + r, y],
    ['L', x + w - r, y],
    ['C', x + w - r + k, y, x + w, y + r - k, x + w, y + r],
    ['L', x + w, y + h - r],
    ['C', x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h],
    ['L', x + r, y + h],
    ['C', x + r - k, y + h, x, y + h - r + k, x, y + h - r],
    ['L', x, y + r],
    ['C', x, y + r - k, x + r - k, y, x + r, y],
    ['Z'],
  ];
}

// --- PNG encode ----------------------------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(bmp: Bitmap): Buffer {
  const { w, h, data } = bmp;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    // filter 1 (Sub) compresses flat areas well
    const o = y * (w * 4 + 1);
    raw[o] = 1;
    for (let x = 0; x < w * 4; x++) {
      const v = data[y * w * 4 + x];
      const left = x >= 4 ? data[y * w * 4 + x - 4] : 0;
      raw[o + 1 + x] = (v - left) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

// --- PNG decode ----------------------------------------------------------------------------------------------

/** Decodes a non-interlaced PNG (all colour types, 1–16 bit) to RGBA8; null for anything else. */
export function decodePng(buf: Uint8Array, maxPixels = 16_000_000): Bitmap | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 8;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const t = b.toString('latin1', pos + 4, pos + 8);
    const d = b.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (t === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      depth = d[8];
      type = d[9];
      interlace = d[12];
    } else if (t === 'PLTE') palette = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
  }
  if (!w || !h || w * h > maxPixels || interlace) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type as 0 | 2 | 3 | 4 | 6];
  if (!channels) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const stride = Math.ceil((w * channels * depth) / 8);
  if (raw.length < (stride + 1) * h) return null;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[x] = v & 0xff;
    }
    const sample = (i: number): number => {
      if (depth === 8) return cur[i];
      if (depth === 16) return cur[i * 2];
      const per = 8 / depth;
      const byte = cur[Math.floor(i / per)];
      const shift = 8 - depth * ((i % per) + 1);
      return (byte >> shift) & ((1 << depth) - 1);
    };
    const scale = depth < 8 && type !== 3 ? 255 / ((1 << depth) - 1) : 1;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (type === 3) {
        const idx = sample(x);
        out[o] = palette?.[idx * 3] ?? 0;
        out[o + 1] = palette?.[idx * 3 + 1] ?? 0;
        out[o + 2] = palette?.[idx * 3 + 2] ?? 0;
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (type === 0 || type === 4) {
        const g = Math.round(sample(x * channels) * scale);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = type === 4 ? sample(x * channels + 1) : 255;
      } else {
        out[o] = sample(x * channels);
        out[o + 1] = sample(x * channels + 1);
        out[o + 2] = sample(x * channels + 2);
        out[o + 3] = type === 6 ? sample(x * channels + 3) : 255;
      }
    }
    cur.copy(prev);
  }
  return { w, h, data: out };
}

// --- JPEG decode (baseline) -----------------------------------------------------------------------------------

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const COS = (() => {
  const t = new Float32Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return t;
})();

interface Huff {
  /** code length → (code → value) */
  maps: Map<number, number>[];
}

/** Decodes a baseline (sequential, Huffman) JPEG to RGBA8; null for progressive or broken files. */
export function decodeJpeg(buf: Uint8Array, maxPixels = 16_000_000): Bitmap | null {
  try {
    return jpeg(buf, maxPixels);
  } catch {
    return null;
  }
}

function jpeg(b: Uint8Array, maxPixels: number): Bitmap | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const qt: Int32Array[] = [];
  const dc: Huff[] = [];
  const ac: Huff[] = [];
  let frame: { w: number; h: number; comps: { id: number; hs: number; vs: number; tq: number; td?: number; ta?: number; pred: number; blocks?: Float32Array; bw?: number; bh?: number }[] } | null = null;
  let restart = 0;
  let pos = 2;
  const u16 = (p: number) => (b[p] << 8) | b[p + 1];
  for (;;) {
    while (pos < b.length && b[pos] !== 0xff) pos++;
    while (pos < b.length && b[pos] === 0xff) pos++;
    if (pos >= b.length) return null;
    const marker = b[pos++];
    if (marker === 0xd9) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const len = u16(pos);
    const seg = pos + 2;
    const end = pos + len;
    if (marker === 0xdb) {
      let p = seg;
      while (p < end) {
        const pq = b[p] >> 4;
        const tq = b[p] & 15;
        p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          t[ZIGZAG[i]] = pq ? u16(p + i * 2) : b[p + i];
        }
        p += pq ? 128 : 64;
        qt[tq] = t;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      const h = u16(seg + 1);
      const w = u16(seg + 3);
      const n = b[seg + 5];
      if (!w || !h || w * h > maxPixels) return null;
      const comps = [];
      for (let i = 0; i < n; i++) comps.push({ id: b[seg + 6 + i * 3], hs: b[seg + 7 + i * 3] >> 4, vs: b[seg + 7 + i * 3] & 15, tq: b[seg + 8 + i * 3], pred: 0 });
      frame = { w, h, comps };
    } else if (marker === 0xc2 || marker === 0xc3 || (marker >= 0xc5 && marker <= 0xcf && marker !== 0xc8 && marker !== 0xcc)) {
      return null; // progressive / lossless / arithmetic
    } else if (marker === 0xc4) {
      let p = seg;
      while (p < end) {
        const tc = b[p] >> 4;
        const th = b[p] & 15;
        const counts = b.subarray(p + 1, p + 17);
        let vp = p + 17;
        const maps: Map<number, number>[] = [];
        let code = 0;
        for (let l = 0; l < 16; l++) {
          const m = new Map<number, number>();
          for (let i = 0; i < counts[l]; i++) m.set(code++, b[vp++]);
          maps.push(m);
          code <<= 1;
        }
        (tc ? ac : dc)[th] = { maps };
        p = vp;
      }
    } else if (marker === 0xdd) {
      restart = u16(seg);
    } else if (marker === 0xda) {
      if (!frame) return null;
      const ns = b[seg];
      for (let i = 0; i < ns; i++) {
        const c = frame.comps.find((x) => x.id === b[seg + 1 + i * 2]);
        if (c) {
          c.td = b[seg + 2 + i * 2] >> 4;
          c.ta = b[seg + 2 + i * 2] & 15;
        }
      }
      return decodeScan(b, end, frame, qt, dc, ac, restart);
    }
    pos = end;
  }
}

function decodeScan(b: Uint8Array, start: number, frame: NonNullable<any>, qt: Int32Array[], dcT: Huff[], acT: Huff[], restart: number): Bitmap {
  const comps = frame.comps as { id: number; hs: number; vs: number; tq: number; td: number; ta: number; pred: number; data?: Uint8Array; bw?: number; bh?: number }[];
  const hmax = Math.max(...comps.map((c) => c.hs));
  const vmax = Math.max(...comps.map((c) => c.vs));
  const mcuW = 8 * hmax;
  const mcuH = 8 * vmax;
  const mcusX = Math.ceil(frame.w / mcuW);
  const mcusY = Math.ceil(frame.h / mcuH);
  for (const c of comps) {
    c.bw = mcusX * c.hs * 8;
    c.bh = mcusY * c.vs * 8;
    c.data = new Uint8Array(c.bw * c.bh);
  }
  let pos = start;
  let bits = 0;
  let nbits = 0;
  const bit = (): number => {
    if (nbits === 0) {
      if (pos >= b.length) return 0;
      let v = b[pos++];
      if (v === 0xff) {
        const nx = b[pos];
        if (nx === 0) pos++;
        else if (nx >= 0xd0 && nx <= 0xd7) v = 0; // marker inside data: pad with zeros
      }
      bits = v;
      nbits = 8;
    }
    nbits--;
    return (bits >> nbits) & 1;
  };
  const receive = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bit();
    return v;
  };
  const extend = (v: number, n: number) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decode = (t: Huff) => {
    let code = 0;
    for (let l = 0; l < 16; l++) {
      code = (code << 1) | bit();
      const v = t.maps[l].get(code);
      if (v !== undefined) return v;
    }
    throw new Error('bad huffman');
  };
  const blk = new Float32Array(64);
  const tmp = new Float32Array(64);
  const decodeBlock = (c: (typeof comps)[number], bx: number, by: number) => {
    blk.fill(0);
    const q = qt[c.tq];
    const t = decode(dcT[c.td]);
    const diff = t ? extend(receive(t), t) : 0;
    c.pred += diff;
    blk[0] = c.pred * q[0];
    for (let k = 1; k < 64; ) {
      const rs = decode(acT[c.ta]);
      const r = rs >> 4;
      const s = rs & 15;
      if (!s) {
        if (r === 15) {
          k += 16;
          continue;
        }
        break;
      }
      k += r;
      if (k > 63) break;
      blk[ZIGZAG[k]] = extend(receive(s), s) * q[ZIGZAG[k]];
      k++;
    }
    // separable IDCT
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        let s = 0;
        for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * blk[y * 8 + u];
        tmp[y * 8 + x] = s / 2;
      }
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        let s = 0;
        for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x];
        const val = Math.round(s / 2 + 128);
        c.data![(by + y) * c.bw! + bx + x] = val < 0 ? 0 : val > 255 ? 255 : val;
      }
  };
  let mcu = 0;
  const total = mcusX * mcusY;
  while (mcu < total) {
    if (restart && mcu > 0 && mcu % restart === 0) {
      // align to the RST marker and reset predictions
      nbits = 0;
      while (pos < b.length - 1 && !(b[pos] === 0xff && b[pos + 1] >= 0xd0 && b[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const c of comps) c.pred = 0;
    }
    const mx = mcu % mcusX;
    const my = Math.floor(mcu / mcusX);
    for (const c of comps)
      for (let v = 0; v < c.vs; v++) for (let h = 0; h < c.hs; h++) decodeBlock(c, (mx * c.hs + h) * 8, (my * c.vs + v) * 8);
    mcu++;
  }
  const out = new Uint8Array(frame.w * frame.h * 4);
  for (let y = 0; y < frame.h; y++)
    for (let x = 0; x < frame.w; x++) {
      const s = (c: (typeof comps)[number]) => c.data![Math.floor((y * c.vs) / vmax) * c.bw! + Math.floor((x * c.hs) / hmax)];
      const o = (y * frame.w + x) * 4;
      if (comps.length >= 3) {
        const Y = s(comps[0]);
        const cb = s(comps[1]) - 128;
        const cr = s(comps[2]) - 128;
        out[o] = Math.max(0, Math.min(255, Math.round(Y + 1.402 * cr)));
        out[o + 1] = Math.max(0, Math.min(255, Math.round(Y - 0.344136 * cb - 0.714136 * cr)));
        out[o + 2] = Math.max(0, Math.min(255, Math.round(Y + 1.772 * cb)));
      } else out[o] = out[o + 1] = out[o + 2] = s(comps[0]);
      out[o + 3] = 255;
    }
  return { w: frame.w, h: frame.h, data: out };
}

/** Width/height of a JPEG (for PDF embedding) without decoding it. */
export function jpegSize(b: Uint8Array): { w: number; h: number; gray: boolean } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1];
    const len = (b[pos + 2] << 8) | b[pos + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (b[pos + 5] << 8) | b[pos + 6], w: (b[pos + 7] << 8) | b[pos + 8], gray: b[pos + 9] === 1 };
    }
    pos += 2 + len;
  }
  return null;
}

/** Decodes a media-library image by its bytes (PNG or JPEG). */
export function decodeImage(buf: Uint8Array): Bitmap | null {
  if (buf[0] === 0x89) return decodePng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJpeg(buf);
  return null;
}
