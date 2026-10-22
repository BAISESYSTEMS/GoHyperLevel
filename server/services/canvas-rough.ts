/**
 * "Handgezeichnet": a small hand-drawn renderer for the canvas (no library). Lines become two slightly
 * bowed, jittered strokes, ellipses a wobbly double loop, fills hatching lines clipped to the shape.
 * Randomness comes from a seeded generator per element, so a shape looks the same on every render,
 * every client and in every export.
 *
 * Pure code (also used in the browser).
 */

import { type Cmd, type Pt, pointInPolygon } from './canvas-path.js';

export type Rand = () => number;

/** mulberry32 – tiny, fast, good enough for jitter. */
export function rng(seed: number): Rand {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RoughOpts {
  roughness?: number;
  bowing?: number;
  /** Draw each line once instead of twice (hatching). */
  single?: boolean;
}

/** One or two hand-drawn strokes from (x1,y1) to (x2,y2). */
export function roughLine(x1: number, y1: number, x2: number, y2: number, r: Rand, o: RoughOpts = {}): Cmd[] {
  const rough = o.roughness ?? 1;
  const bowing = o.bowing ?? 1;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 0.5) return [['M', x1, y1], ['L', x2, y2]];
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  const jitterMax = Math.min(len * 0.04, 2.4) * rough;
  const out: Cmd[] = [];
  const passes = o.single ? 1 : 2;
  for (let pass = 0; pass < passes; pass++) {
    const j = (m = 1) => (r() - 0.5) * 2 * jitterMax * m * (pass ? 0.7 : 1);
    const bow = (r() - 0.5) * len * 0.012 * bowing * rough * 2;
    const t1 = 0.3 + r() * 0.15;
    const t2 = 0.65 + r() * 0.15;
    out.push(['M', x1 + j(), y1 + j()]);
    out.push([
      'C',
      x1 + (x2 - x1) * t1 + nx * bow + j(0.6),
      y1 + (y2 - y1) * t1 + ny * bow + j(0.6),
      x1 + (x2 - x1) * t2 + nx * bow + j(0.6),
      y1 + (y2 - y1) * t2 + ny * bow + j(0.6),
      x2 + j(),
      y2 + j(),
    ]);
  }
  return out;
}

/** Closed polygon drawn edge by edge. */
export function roughPolygon(pts: Pt[], r: Rand, o: RoughOpts = {}): Cmd[] {
  const out: Cmd[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(...roughLine(a[0], a[1], b[0], b[1], r, o));
  }
  return out;
}

/** Open polyline drawn segment by segment. */
export function roughPolyline(pts: Pt[], r: Rand, o: RoughOpts = {}): Cmd[] {
  const out: Cmd[] = [];
  for (let i = 1; i < pts.length; i++) out.push(...roughLine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r, o));
  return out;
}

/** Points of a wobbly ellipse (used for its outline and its fill). */
export function roughEllipsePoints(cx: number, cy: number, rx: number, ry: number, r: Rand, rough = 1, overlap = 0): Pt[] {
  const perimeter = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
  const n = Math.max(8, Math.min(28, Math.round(perimeter / 40)));
  const start = r() * Math.PI * 2;
  const step = (Math.PI * 2) / n;
  const pts: Pt[] = [];
  const extra = overlap ? Math.ceil(overlap / step) : 0;
  for (let i = 0; i <= n + extra; i++) {
    const a = start + i * step;
    const k = 1 + (r() - 0.5) * 0.045 * rough;
    pts.push([cx + rx * k * Math.cos(a), cy + ry * k * Math.sin(a)]);
  }
  return pts;
}

function catmull(pts: Pt[]): Cmd[] {
  const out: Cmd[] = [['M', pts[0][0], pts[0][1]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    out.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]]);
  }
  return out;
}

export function roughEllipse(cx: number, cy: number, rx: number, ry: number, r: Rand, o: RoughOpts = {}): Cmd[] {
  const rough = o.roughness ?? 1;
  const out = catmull(roughEllipsePoints(cx, cy, rx, ry, r, rough, 0.35));
  if (!o.single) out.push(...catmull(roughEllipsePoints(cx, cy, rx * (1 + (r() - 0.5) * 0.02), ry, r, rough, 0.2)));
  return out;
}

/** A closed, slightly irregular fill area from polygon points. */
export function roughFillShape(pts: Pt[], r: Rand, rough = 1): Cmd[] {
  if (pts.length < 3) return [];
  const out: Cmd[] = [];
  const j = () => (r() - 0.5) * 2 * rough;
  pts.forEach((p, i) => out.push([i ? 'L' : 'M', p[0] + j(), p[1] + j()]));
  out.push(['Z']);
  return out;
}

/** Hatching lines (angle in degrees) clipped to a polygon, each drawn by hand. */
export function hachure(poly: Pt[], r: Rand, gap: number, angle = -41, o: RoughOpts = {}): Cmd[] {
  if (poly.length < 3) return [];
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // rotate the polygon so the hatch lines become horizontal scanlines
  const rot = poly.map(([x, y]): Pt => [x * cos + y * sin, -x * sin + y * cos]);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of rot) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const out: Cmd[] = [];
  const g = Math.max(3, gap);
  let lines = 0;
  for (let y = minY + g / 2; y < maxY && lines < 400; y += g, lines++) {
    const xs: number[] = [];
    for (let i = 0, k = rot.length - 1; i < rot.length; k = i++) {
      const [x1, y1] = rot[k];
      const [x2, y2] = rot[i];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const inset = Math.min(1.5, (xs[i + 1] - xs[i]) / 4);
      const sx = xs[i] + inset;
      const ex = xs[i + 1] - inset;
      if (ex - sx < 1) continue;
      // back to board coordinates
      const p1: Pt = [sx * cos - y * sin, sx * sin + y * cos];
      const p2: Pt = [ex * cos - y * sin, ex * sin + y * cos];
      out.push(...roughLine(p1[0], p1[1], p2[0], p2[1], r, { roughness: (o.roughness ?? 1) * 0.6, bowing: 0.5, single: true }));
    }
  }
  return out;
}

/** True when the polygon contains the point (re-exported for hit tests of sketch fills). */
export const insidePolygon = pointInPolygon;
