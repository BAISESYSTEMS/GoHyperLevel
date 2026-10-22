import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { Cmd } from './canvas-path.js';
import { rasterize, type Bitmap } from './canvas-png.js';
import type { Prim } from './canvas-render.js';
import { DEFAULT_NAME, SPLASH_BG, type Scheme } from './pwa-devices.js';

/**
 * The installable app on iPhone, iPad and foldables, as pure logic (docs/ios-web-app.md):
 * - the device table (CSS size × pixel ratio) behind the iOS launch images (`apple-touch-startup-image`),
 * - the <head> lines (home-screen meta, touch icons, launch images) – the build injects them into index.html,
 * - the web app manifest (name, colour and icons of the agency's white label),
 * - the pictures themselves: touch icons and launch images drawn on the server, without a browser or a native library,
 *   in the colour and with the logo (or first letter) of the white label.
 * Routes and the badge count: modules/pwa-ios.ts.
 */

export { DEFAULT_NAME, SCHEMES, SPLASH_BG, IOS_DEVICES, IOS_HEAD_MARKER, SPLASH_SIZES, TOUCH_SIZES, iosHead, parseSplashFile, splashFile, splashMedia, splashSpecs } from './pwa-devices.js';
export type { IosDevice, Orientation, Scheme, SplashSpec } from './pwa-devices.js';

export const DEFAULT_COLOR = '#2563eb';
/** Colours that mean "not customised": the stock icons are used. */
const STOCK_COLORS = new Set(['', DEFAULT_COLOR, '#1d4ed8']);
const HEX = /^#[0-9a-f]{6}$/i;

// --- white label ---------------------------------------------------------------------------------------------------------------

export interface PwaBrand {
  name: string;
  color: string;
  /** Address of the logo or mark to draw into the icons ('' = none: first letter of the name). */
  logo: string;
  /** Anything but the stock look: icons are drawn per request instead of the shipped files. */
  custom: boolean;
}

interface BrandingLike {
  name?: string;
  color?: string;
  mark_url?: string;
  logo_url?: string;
  favicon_url?: string;
}

export function pwaBrand(b: BrandingLike): PwaBrand {
  const name = String(b.name ?? '').trim().slice(0, 45) || DEFAULT_NAME;
  const color = HEX.test(b.color ?? '') ? (b.color as string).toLowerCase() : DEFAULT_COLOR;
  const logo = String(b.mark_url || b.favicon_url || b.logo_url || '').trim();
  return { name, color, logo, custom: !!logo || name !== DEFAULT_NAME || !STOCK_COLORS.has(color) };
}

/** Changes whenever the white label's look changes: appended to icon addresses in the manifest so devices fetch the new ones. */
export const brandKey = (b: PwaBrand, logoStamp = '') => createHash('sha1').update(`${b.name}|${b.color}|${b.logo}|${logoStamp}`).digest('hex').slice(0, 10);

export const shortName = (name: string) => (name.length <= 12 ? name : name.split(/\s+/)[0].slice(0, 12));

export const ICONS = {
  'icon-120': { size: 120, shape: 'square' },
  'icon-152': { size: 152, shape: 'square' },
  'icon-167': { size: 167, shape: 'square' },
  'icon-180': { size: 180, shape: 'square' },
  'icon-192': { size: 192, shape: 'round' },
  'icon-512': { size: 512, shape: 'round' },
  'icon-1024': { size: 1024, shape: 'square' },
  'maskable-512': { size: 512, shape: 'maskable' },
} as const;
export type IconKind = keyof typeof ICONS;
export const isIconKind = (s: string): s is IconKind => Object.prototype.hasOwnProperty.call(ICONS, s);

const STOCK_ICONS = [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icon-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
  { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
];

export function manifestIcons(brand: PwaBrand, key = '') {
  if (!brand.custom) return STOCK_ICONS;
  const v = key ? `?v=${key}` : '';
  return [
    { src: `/pwa/icon/icon-192.png${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/pwa/icon/icon-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `/pwa/icon/icon-1024.png${v}`, sizes: '1024x1024', type: 'image/png', purpose: 'any' },
    { src: `/pwa/icon/maskable-512.png${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
}

/** The web app manifest: standalone window (iOS needs it for push), one scope, the white label's name, colour and icons. */
export function appManifest(brand: PwaBrand, key = '') {
  const icon = (src: string) => [{ src, sizes: '192x192', type: 'image/png' }];
  const shortcutIcon = brand.custom ? `/pwa/icon/icon-192.png${key ? `?v=${key}` : ''}` : '/icon-192.png';
  return {
    id: '/app',
    name: brand.name,
    short_name: shortName(brand.name),
    description: 'CRM, Konversationen, Kalender, Aufgaben und Rechnungen',
    lang: 'de',
    dir: 'ltr',
    start_url: '/app',
    scope: '/app',
    display: 'standalone',
    // Headsets and glasses: a window of its own, never the browser's bars; one window only (docs/xr.md).
    display_override: ['standalone', 'minimal-ui'],
    // Any orientation: iPad and iPhone Duo rotate and unfold, the layout follows the width.
    orientation: 'any',
    categories: ['business', 'productivity'],
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    prefer_related_applications: false,
    // Page background of the light theme (the launch images use the same, so launch → app does not flash).
    background_color: '#f4f6fa',
    theme_color: brand.color,
    icons: manifestIcons(brand, key),
    shortcuts: [
      { name: 'Konversationen', url: '/app/conversations', icons: icon(shortcutIcon) },
      { name: 'Kontakte', url: '/app/contacts', icons: icon(shortcutIcon) },
      { name: 'Aufgaben', url: '/app/tasks', icons: icon(shortcutIcon) },
      { name: 'Arbeitsfläche', url: '/app/workspace', icons: icon(shortcutIcon) },
    ],
  };
}

// --- drawing ----------------------------------------------------------------------------------------------------------------------

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

const lightColor = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
};

/** What an icon is drawn from: the white label's logo, or – for the stock look – the shipped 1024 px icon. */
export interface IconSources {
  logo?: Bitmap | null;
  stock?: Bitmap | null;
}

const letterOf = (name: string) => ([...name.trim()][0] ?? DEFAULT_NAME[0]).toUpperCase();

/** One icon as RGBA pixels. `square`: full-bleed (iOS and headsets round it themselves), `round`: rounded corners, `maskable`: art inside the safe zone. */
export function iconBitmap(brand: PwaBrand, kind: IconKind, src: IconSources = {}): Bitmap {
  const { size: s, shape } = ICONS[kind];
  const prims: Prim[] = [];
  const images = new Map<string, Bitmap | null>();
  if (!brand.custom && src.stock) {
    images.set('stock', src.stock);
    if (shape === 'maskable') {
      prims.push({ t: 'path', d: roundedSquare(s, 0), fill: '#1d4ed8' });
      const pad = s * 0.1;
      prims.push({ t: 'image', x: pad, y: pad, w: s - pad * 2, h: s - pad * 2, src: 'stock', fit: 'contain' });
    } else prims.push({ t: 'image', x: 0, y: 0, w: s, h: s, src: 'stock', fit: 'cover', radius: shape === 'round' ? s * 0.22 : 0 });
  } else if (brand.logo && src.logo) {
    images.set('logo', src.logo);
    // The logo on white (so transparent logos stay readable), inside the safe zone.
    prims.push({ t: 'path', d: roundedSquare(s, shape === 'round' ? s * 0.22 : 0), fill: '#ffffff' });
    const pad = s * (shape === 'maskable' ? 0.24 : 0.16);
    prims.push({ t: 'image', x: pad, y: pad, w: s - pad * 2, h: s - pad * 2, src: 'logo', fit: 'contain' });
  } else {
    prims.push({ t: 'path', d: roundedSquare(s, shape === 'round' ? s * 0.22 : 0), fill: brand.color });
    const size = s * (shape === 'maskable' ? 0.42 : 0.6);
    prims.push({ t: 'text', x: s / 2, y: s / 2 - 0.44 * size, lines: [letterOf(brand.name)], size, font: 'sans', bold: true, anchor: 'middle', color: lightColor(brand.color) ? '#111827' : '#ffffff', lh: size });
  }
  return rasterize(prims, s, s, { images });
}

// --- PNG (flat colour + one picture in the middle: written directly, a launch image has millions of equal pixels) ---------------------

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** An opaque RGB PNG: background colour with `overlay` (RGBA, blended over the background) at x/y. */
export function flatPng(w: number, h: number, bg: [number, number, number], overlay?: { x: number; y: number; bmp: Bitmap }): Buffer {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  const row = Buffer.alloc(stride);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = bg[0];
    row[2 + x * 3] = bg[1];
    row[3 + x * 3] = bg[2];
  }
  for (let y = 0; y < h; y++) row.copy(raw, y * stride);
  if (overlay) {
    const { x: ox, y: oy, bmp } = overlay;
    for (let y = 0; y < bmp.h; y++) {
      const py = oy + y;
      if (py < 0 || py >= h) continue;
      for (let x = 0; x < bmp.w; x++) {
        const px = ox + x;
        if (px < 0 || px >= w) continue;
        const i = (y * bmp.w + x) * 4;
        const a = bmp.data[i + 3] / 255;
        if (a === 0) continue;
        const o = py * stride + 1 + px * 3;
        for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bmp.data[i + c] * a + raw[o + c] * (1 - a));
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 4 })), chunk('IEND', new Uint8Array(0))]);
}

/** An icon as an opaque PNG (the touch icons must not be transparent: iOS would paint black corners). */
export function iconPng(brand: PwaBrand, kind: IconKind, src: IconSources = {}): Buffer {
  const bmp = iconBitmap(brand, kind, src);
  // 'round' icons keep their transparent corners (Android, Windows, browsers); everything else is opaque.
  if (ICONS[kind].shape === 'round') return encodeRgba(bmp);
  return flatPng(bmp.w, bmp.h, [255, 255, 255], { x: 0, y: 0, bmp });
}

function encodeRgba(bmp: Bitmap): Buffer {
  const { w, h, data } = bmp;
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * stride + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

/** A launch image: the page background with the app icon and its name in the middle. */
export function splashPng(brand: PwaBrand, px: number, py: number, scheme: Scheme, src: IconSources = {}): Buffer {
  const icon = Math.round(Math.min(px, py) * 0.24);
  // The icon on its own canvas, rounded like a home-screen icon, with the name underneath.
  const named = brand.name.length <= 28;
  const label = Math.round(icon * 0.2);
  const gap = Math.round(icon * 0.14);
  const h = icon + (named ? gap + label * 1.4 : 0);
  const prims: Prim[] = [];
  const images = new Map<string, Bitmap | null>();
  const r = icon * 0.225;
  if (!brand.custom && src.stock) {
    images.set('stock', src.stock);
    prims.push({ t: 'image', x: 0, y: 0, w: icon, h: icon, src: 'stock', fit: 'cover', radius: r });
  } else if (brand.logo && src.logo) {
    images.set('logo', src.logo);
    prims.push({ t: 'path', d: roundedSquare(icon, r), fill: '#ffffff' });
    const pad = icon * 0.16;
    prims.push({ t: 'image', x: pad, y: pad, w: icon - pad * 2, h: icon - pad * 2, src: 'logo', fit: 'contain' });
  } else {
    prims.push({ t: 'path', d: roundedSquare(icon, r), fill: brand.color });
    const size = icon * 0.6;
    prims.push({ t: 'text', x: icon / 2, y: icon / 2 - 0.44 * size, lines: [letterOf(brand.name)], size, font: 'sans', bold: true, anchor: 'middle', color: lightColor(brand.color) ? '#111827' : '#ffffff', lh: size });
  }
  const width = Math.max(icon, named ? Math.min(Math.round(px * 0.9), Math.round(label * 0.62 * [...brand.name].length) + 8) : icon);
  const dx = Math.round((width - icon) / 2);
  const shifted: Prim[] = [{ t: 'group', m: [1, 0, 0, 1, dx, 0], children: prims }];
  if (named) shifted.push({ t: 'text', x: width / 2, y: icon + gap, lines: [brand.name], size: label, font: 'sans', bold: true, anchor: 'middle', color: scheme === 'dark' ? '#e5e7eb' : '#111827', lh: label });
  const bmp = rasterize(shifted, width, Math.round(h), { images });
  return flatPng(px, py, SPLASH_BG[scheme], { x: Math.round((px - bmp.w) / 2), y: Math.round((py - bmp.h) / 2 - py * 0.03), bmp });
}

// --- badge ------------------------------------------------------------------------------------------------------------------------

/** The number on the app icon: what a person has not looked at yet. Never negative, capped (iOS shows "99+" itself, we stay sane). */
export const badgeTotal = (c: { unread?: number; tasks?: number }) => Math.max(0, Math.min(999, Math.round(Number(c.unread) || 0) + Math.round(Number(c.tasks) || 0)));
