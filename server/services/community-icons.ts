import { createHash } from 'node:crypto';
import type { Cmd } from './canvas-path.js';
import { decodeImage, encodePng, rasterize, type Bitmap } from './canvas-png.js';
import type { Prim } from './canvas-render.js';

/**
 * App icons of a member area (home-screen icon, favicon): a rounded square in the brand colour with the client's logo – when it is
 * an embedded PNG/JPEG – or the first letter of the name. Drawn on the server without a browser; nothing is fetched from outside.
 */

export type IconKind = '192' | '512' | 'maskable' | 'apple' | 'favicon';
export const ICON_KINDS: Record<IconKind, { size: number; maskable?: boolean; rounded: boolean }> = {
  '192': { size: 192, rounded: true },
  '512': { size: 512, rounded: true },
  maskable: { size: 512, maskable: true, rounded: false },
  apple: { size: 180, rounded: false },
  favicon: { size: 64, rounded: true },
};

const HEX = /^#[0-9a-f]{6}$/i;

function roundedSquare(s: number, r: number): Cmd[] {
  const k = 0.5523 * r;
  return [
    ['M', r, 0],
    ['L', s - r, 0],
    ['C', s - r + k, 0, s, r - k, s, r],
    ['L', s, s - r],
    ['C', s, s - r + k, s - r + k, s, s - r, s],
    ['L', r, s],
    ['C', r - k, s, 0, s - r + k, 0, s - r],
    ['L', 0, r],
    ['C', 0, r - k, r - k, 0, r, 0],
    ['Z'],
  ];
}

/** Light enough for dark text? (WCAG-ish luminance) */
const lightColor = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
};

function logoBitmap(logo: string): Bitmap | null {
  const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(logo);
  if (!m || m[1].length > 2_000_000) return null;
  try {
    return decodeImage(Buffer.from(m[1], 'base64'));
  } catch {
    return null;
  }
}

const cache = new Map<string, Buffer>();

export function iconPng(opts: { name: string; color: string; logo?: string }, kind: IconKind): Buffer {
  const spec = ICON_KINDS[kind];
  const color = HEX.test(opts.color) ? opts.color : '#2563eb';
  const letter = ([...String(opts.name || 'M').trim()][0] ?? 'M').toUpperCase();
  const key = createHash('sha1').update(`${kind}|${color}|${letter}|${opts.logo?.length ?? 0}|${opts.logo?.slice(-40) ?? ''}`).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  const s = spec.size;
  const bmp = opts.logo ? logoBitmap(opts.logo) : null;
  const prims: Prim[] = [];
  const ink = lightColor(color) ? '#111827' : '#ffffff';
  if (bmp) {
    // The logo on white (so transparent logos stay readable), inside the safe zone.
    prims.push({ t: 'path', d: spec.rounded ? roundedSquare(s, s * 0.22) : roundedSquare(s, 0), fill: '#ffffff' });
    const pad = s * (spec.maskable ? 0.24 : 0.16);
    prims.push({ t: 'image', x: pad, y: pad, w: s - pad * 2, h: s - pad * 2, src: 'logo', fit: 'contain' });
  } else {
    prims.push({ t: 'path', d: spec.rounded ? roundedSquare(s, s * 0.22) : roundedSquare(s, 0), fill: color });
    const size = s * (spec.maskable ? 0.42 : 0.6);
    prims.push({ t: 'text', x: s / 2, y: s / 2 - 0.44 * size, lines: [letter], size, font: 'sans', bold: true, anchor: 'middle', color: ink, lh: size });
  }
  const png = encodePng(rasterize(prims, s, s, { images: new Map([['logo', bmp]]) }));
  if (cache.size > 200) cache.clear();
  cache.set(key, png);
  return png;
}
