/**
 * Colour maths for the theme system: WCAG contrast, OKLCH (perceptual lightness/chroma/hue) and the
 * accent derivation (hover, soft tint, readable text, focus ring). Pure functions, no DOM – the same code
 * runs in the browser and in the contrast tests.
 */

export type Rgb = [number, number, number];
export interface Oklch {
  l: number;
  c: number;
  h: number;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
export const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 … 21). */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const isDark = (hex: string) => luminance(hex) < 0.18;

// --- OKLab / OKLCH (Björn Ottosson) ----------------------------------------------------------------------

function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Linear sRGB of an OKLab colour (may be outside 0…1 = outside the gamut). */
function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const inGamut = ([r, g, b]: Rgb) => r >= -0.0005 && r <= 1.0005 && g >= -0.0005 && g <= 1.0005 && b >= -0.0005 && b <= 1.0005;

export function toOklch(hex: string): Oklch {
  const [L, a, b] = toOklab(hex);
  const c = Math.hypot(a, b);
  return { l: L, c, h: c < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** OKLCH → #rrggbb. A colour outside the sRGB gamut keeps its lightness and hue and loses chroma until it fits. */
export function fromOklch({ l, c, h }: Oklch): string {
  const L = clamp(l);
  const rad = (h * Math.PI) / 180;
  let lo = 0;
  let hi = c;
  let rgb = oklabToLinear(L, c * Math.cos(rad), c * Math.sin(rad));
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      rgb = oklabToLinear(L, mid * Math.cos(rad), mid * Math.sin(rad));
      if (inGamut(rgb)) lo = mid;
      else hi = mid;
    }
    rgb = oklabToLinear(L, lo * Math.cos(rad), lo * Math.sin(rad));
  }
  return rgbToHex(rgb.map((v) => fromLinear(clamp(v))) as Rgb);
}

/** Mixes two colours in OKLab: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const x = toOklab(a);
  const y = toOklab(b);
  const rgb = oklabToLinear(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
  return rgbToHex(rgb.map((v) => fromLinear(clamp(v))) as Rgb);
}

/** `#rrggbb` as `rgba(…)` with an alpha. */
export const alpha = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** Black or white, whichever reads better on the colour (always at least 4.5:1). */
export function onColor(bg: string): '#000000' | '#ffffff' {
  return contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
}

const minContrast = (fg: string, bgs: string[]) => Math.min(...bgs.map((b) => contrast(fg, b)));

/**
 * Moves a colour's lightness (hue and chroma stay as far as the gamut allows) until it has at least `min`
 * contrast against every background. Dark backgrounds pull it lighter, light ones darker.
 */
export function ensureContrast(fg: string, bg: string | string[], min: number): string {
  const bgs = Array.isArray(bg) ? bg : [bg];
  if (minContrast(fg, bgs) >= min) return fg;
  const o = toOklch(fg);
  const avg = bgs.reduce((s, b) => s + luminance(b), 0) / bgs.length;
  const dir = avg > 0.4 ? -1 : 1;
  let best = fg;
  for (let i = 1; i <= 80; i++) {
    const cand = fromOklch({ ...o, l: o.l + dir * i * 0.0125 });
    if (minContrast(cand, bgs) >= min) return cand;
    best = cand;
  }
  // Mixed backgrounds (one light, one dark) cannot all be satisfied by one lightness: fall back to the best neutral.
  const neutral = [onColor(bgs[0]), best].sort((x, y) => minContrast(y, bgs) - minContrast(x, bgs))[0];
  return neutral;
}

// --- accent -----------------------------------------------------------------------------------------------

export interface AccentSet {
  /** The accent itself: button fill, selected states. */
  brand: string;
  /** Hover state of a filled accent. */
  hover: string;
  /** Text on the accent (black or white, ≥ 4.5:1). */
  on: string;
  /** Soft tint of the accent on the surface (selected rows, tags). */
  soft: string;
  /** Accent as text/links: readable (≥ 4.5:1) on the surface, the page and the soft tint. */
  text: string;
  /** Focus ring: visible (≥ 3:1) on the surface and the page. */
  ring: string;
  /** Background of selected text. */
  select: string;
}

/** Everything the UI derives from one accent colour, for the surfaces of the current theme and mode. */
export function deriveAccent(accent: string, surfaces: { panel: string; bg: string; text: string }, dark: boolean): AccentSet {
  const brand = accent.toLowerCase();
  const on = onColor(brand);
  const o = toOklch(brand);
  let hover = brand;
  for (const step of [0.06, 0.045, 0.03, 0.015]) {
    const cand = fromOklch({ ...o, l: o.l + (on === '#ffffff' ? -step : step) });
    if (contrast(on, cand) >= 4.5) {
      hover = cand;
      break;
    }
  }
  const soft = mix(surfaces.panel, brand, dark ? 0.22 : 0.1);
  const text = ensureContrast(brand, [surfaces.panel, surfaces.bg, soft], 4.5);
  const ring = ensureContrast(brand, [surfaces.panel, surfaces.bg], 3);
  const select = mix(surfaces.panel, brand, dark ? 0.4 : 0.24);
  return { brand, hover, on, soft, text, ring, select: contrast(surfaces.text, select) >= 4.5 ? select : mix(surfaces.panel, brand, dark ? 0.28 : 0.16) };
}
