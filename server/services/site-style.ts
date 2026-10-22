/**
 * Site builder: design tokens and the small CSS toolkit of generated pages (pure, no imports).
 *
 * - Design tokens (brand colours, type scale, radius, shadows, font stacks) are validated here and turned into CSS custom
 *   properties; blocks refer to a colour either as a hex value or as `token:<name>` – so changing the brand colour in one place
 *   changes every page of the site.
 * - Fonts are system font stacks only (no Google Fonts: nothing is loaded from third parties, no consent needed).
 * - `Rules` collects the per-element CSS a page needs (responsive overrides keyed by class) and prints it with the desktop,
 *   tablet (≤ 1024 px) and phone (≤ 640 px) media queries; `minify` keeps the inline <style> small.
 * - Contrast helpers (WCAG 2.x relative luminance) are shared with the accessibility check.
 */

export const BP_TABLET = 1024;
export const BP_PHONE = 640;

export type Breakpoint = 'desktop' | 'tablet' | 'phone';

export const COLOR_TOKENS = ['brand', 'accent', 'text', 'muted', 'bg', 'surface', 'line', 'success', 'danger'] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export const SHADOWS = ['none', 'sm', 'md', 'lg'] as const;

/** Modern system font stacks – nothing to download. */
export const FONT_STACKS: Record<string, { label: string; css: string }> = {
  system: { label: 'System (Standard)', css: `system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif` },
  modern: { label: 'Modern (neutral)', css: `Inter,Roboto,"Helvetica Neue","Arial Nova","Nimbus Sans",Arial,sans-serif` },
  humanist: { label: 'Humanistisch', css: `Seravek,"Gill Sans Nova",Ubuntu,Calibri,"DejaVu Sans",source-sans-pro,sans-serif` },
  geometric: { label: 'Geometrisch', css: `Avenir,Montserrat,Corbel,"URW Gothic",source-sans-pro,sans-serif` },
  rounded: { label: 'Rund & freundlich', css: `ui-rounded,"Hiragino Maru Gothic ProN",Quicksand,Comfortaa,Manjari,"Arial Rounded MT","Arial Rounded MT Bold",Calibri,source-sans-pro,sans-serif` },
  classic: { label: 'Klassisch (Serif)', css: `"Iowan Old Style","Palatino Linotype","URW Palladio L",P052,serif` },
  serif: { label: 'Serif (Georgia)', css: `Charter,"Bitstream Charter","Sitka Text",Cambria,serif` },
  slab: { label: 'Slab-Serif', css: `Rockwell,"Rockwell Nova","Roboto Slab","DejaVu Serif","Sitka Small",serif` },
  mono: { label: 'Monospace', css: `ui-monospace,"Cascadia Code","Source Code Pro",Menlo,Consolas,"DejaVu Sans Mono",monospace` },
};

export interface Tokens {
  colors: Record<ColorToken, string>;
  fonts: { body: string; heading: string };
  scale: { base: number; ratio: number };
  radius: { sm: number; md: number; lg: number };
  shadow: { sm: SHADOW; md: SHADOW; lg: SHADOW };
  space: number;
}
type SHADOW = string;

export const DEFAULT_TOKENS: Tokens = {
  colors: { brand: '#2563eb', accent: '#f59e0b', text: '#111827', muted: '#5b6472', bg: '#ffffff', surface: '#f3f4f6', line: '#e5e7eb', success: '#047857', danger: '#b91c1c' },
  fonts: { body: 'system', heading: 'system' },
  scale: { base: 17, ratio: 1.25 },
  radius: { sm: 6, md: 12, lg: 20 },
  shadow: { sm: '0 1px 2px rgba(17,24,39,.08)', md: '0 6px 18px rgba(17,24,39,.10)', lg: '0 18px 44px rgba(17,24,39,.16)' },
  space: 8,
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** A hex colour, or `token:<name>`; anything else is dropped. */
export const isColor = (v: unknown): v is string => typeof v === 'string' && (HEX.test(v) || /^token:[a-z]+$/.test(v) && COLOR_TOKENS.includes(v.slice(6) as ColorToken));

const clampNum = (v: unknown, min: number, max: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/** `0 6px 18px rgba(…)`: only characters a box-shadow needs (no `;`, `{`, `}`, `<`, `url(` …). */
export function cleanShadow(v: unknown, d: string): string {
  const s = String(v ?? '').trim();
  if (s === 'none') return 'none';
  if (!s || s.length > 120 || !/^[0-9a-z#(),.\s%-]+$/i.test(s) || /url\s*\(|expression|import/i.test(s)) return d;
  return s;
}

/** Fills gaps with the defaults and clamps everything: what the browser may send is never trusted. */
export function cleanTokens(input: unknown, base: Tokens = DEFAULT_TOKENS): Tokens {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const colors = { ...base.colors };
  for (const k of COLOR_TOKENS) if (typeof i.colors?.[k] === 'string' && HEX.test(i.colors[k]) && i.colors[k].length <= 7) colors[k] = i.colors[k].toLowerCase();
  const font = (v: unknown, d: string) => (typeof v === 'string' && Object.hasOwn(FONT_STACKS, v) ? v : d);
  return {
    colors,
    fonts: { body: font(i.fonts?.body, base.fonts.body), heading: font(i.fonts?.heading, base.fonts.heading) },
    scale: { base: Math.round(clampNum(i.scale?.base, 14, 22, base.scale.base)), ratio: Math.round(clampNum(i.scale?.ratio, 1.1, 1.6, base.scale.ratio) * 1000) / 1000 },
    radius: { sm: Math.round(clampNum(i.radius?.sm, 0, 32, base.radius.sm)), md: Math.round(clampNum(i.radius?.md, 0, 48, base.radius.md)), lg: Math.round(clampNum(i.radius?.lg, 0, 64, base.radius.lg)) },
    shadow: { sm: cleanShadow(i.shadow?.sm, base.shadow.sm), md: cleanShadow(i.shadow?.md, base.shadow.md), lg: cleanShadow(i.shadow?.lg, base.shadow.lg) },
    space: Math.round(clampNum(i.space, 4, 12, base.space)),
  };
}

/** Tokens of a site: the stored ones, with the older single brand colour / font setting as fallback. */
export function tokensOf(settings: Record<string, any> | undefined): Tokens {
  const s = settings ?? {};
  const legacy: Record<string, any> = {};
  if (typeof s.color === 'string' && HEX.test(s.color) && !s.tokens?.colors?.brand) legacy.colors = { brand: s.color };
  const merged = { ...legacy, ...(s.tokens ?? {}), colors: { ...(legacy.colors ?? {}), ...(s.tokens?.colors ?? {}) } };
  return cleanTokens(merged);
}

// --- colour maths -------------------------------------------------------------------------------------------

export function parseHex(v: string): [number, number, number] | null {
  let h = String(v ?? '').trim();
  if (!HEX.test(h)) return null;
  h = h.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export const toHex = (rgb: number[]) => `#${rgb.map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')).join('')}`;
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio, 1 … 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/** Mixes `a` towards `b` (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}
/** The darkest/lightest shade of `fg` (towards black or white) that reaches `min` against `bg`; the nearest passing hex. */
export function fixContrast(fg: string, bg: string, min = 4.5): string {
  if (!parseHex(fg) || !parseHex(bg)) return fg;
  if (contrast(fg, bg) >= min) return fg;
  const target = luminance(bg) > 0.4 ? '#000000' : '#ffffff';
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}
/** White or near-black text, whichever reads better on `bg`. */
export const readableOn = (bg: string) => (contrast('#ffffff', bg) >= contrast('#111827', bg) ? '#ffffff' : '#111827');

/** A colour value of a block as CSS: hex stays, `token:x` becomes `var(--c-x)`, anything else is dropped. */
export function colorCss(v: unknown, fallback = ''): string {
  if (!isColor(v)) return fallback;
  return v.startsWith('token:') ? `var(--c-${v.slice(6)})` : v;
}
/** The concrete hex a colour value stands for (tokens resolved through `t`); '' when unknown. */
export function colorHex(v: unknown, t: Tokens): string {
  if (!isColor(v)) return '';
  if (v.startsWith('token:')) return t.colors[v.slice(6) as ColorToken] ?? '';
  return parseHex(v) ? (v.length <= 7 ? v.toLowerCase() : v.slice(0, 7).toLowerCase()) : '';
}

// --- tokens → CSS ---------------------------------------------------------------------------------------------

const em = (n: number) => `${Math.round(n * 1000) / 1000}em`;

/** The `:root` block (and the phone type scale) for a site's tokens. */
export function tokensCss(t: Tokens): string {
  const c = t.colors;
  const steps = (ratio: number) => [-1, 0, 1, 2, 3, 4, 5, 6].map((i) => `--fs-${i < 0 ? 's' : i}:${em(ratio ** i)}`).join(';');
  const phoneRatio = 1 + (t.scale.ratio - 1) * 0.62;
  const vars = [
    ...COLOR_TOKENS.map((k) => `--c-${k}:${c[k]}`),
    `--brand:${c.brand}`,
    `--text:${c.text}`,
    `--muted:${c.muted}`,
    `--line:${c.line}`,
    `--bg:${c.bg}`,
    `--c-brand-soft:${mix(c.brand, '#ffffff', 0.9)}`,
    `--c-brand-dark:${mix(c.brand, '#000000', 0.22)}`,
    `--c-on-brand:${readableOn(c.brand)}`,
    `--c-on-accent:${readableOn(c.accent)}`,
    `--r-sm:${t.radius.sm}px`,
    `--r-md:${t.radius.md}px`,
    `--r-lg:${t.radius.lg}px`,
    `--sh-sm:${t.shadow.sm}`,
    `--sh-md:${t.shadow.md}`,
    `--sh-lg:${t.shadow.lg}`,
    `--sp:${t.space}px`,
    `--ff-body:${FONT_STACKS[t.fonts.body].css}`,
    `--ff-head:${FONT_STACKS[t.fonts.heading].css}`,
    steps(t.scale.ratio),
  ];
  return `:root{${vars.join(';')}}@media (max-width:${BP_PHONE}px){:root{${steps(phoneRatio)}}}html{font-size:${t.scale.base}px}`;
}

// --- per-element rules ---------------------------------------------------------------------------------------------

/** A short, class-safe name for an element id. */
export const cid = (id: unknown) => `x${String(id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}`;

/** CSS a page needs per element, printed with the right media queries (desktop first, tablet ≤ 1024, phone ≤ 640). */
export class Rules {
  private d: string[] = [];
  private t: string[] = [];
  private p: string[] = [];
  private seen = new Set<string>();
  add(bp: Breakpoint, rule: string) {
    (bp === 'desktop' ? this.d : bp === 'tablet' ? this.t : this.p).push(rule);
  }
  /** Adds a rule once (utility classes). */
  once(key: string, bp: Breakpoint, rule: string) {
    if (this.seen.has(`${bp}:${key}`)) return;
    this.seen.add(`${bp}:${key}`);
    this.add(bp, rule);
  }
  get size() {
    return this.d.length + this.t.length + this.p.length;
  }
  css(): string {
    return `${this.d.join('')}${this.t.length ? `@media (max-width:${BP_TABLET}px){${this.t.join('')}}` : ''}${this.p.length ? `@media (max-width:${BP_PHONE}px){${this.p.join('')}}` : ''}`;
  }
}

/** Collapses whitespace and comments in a stylesheet we generate ourselves (never applied to owner code). */
export function minify(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{};,>]) ?/g, '$1')
    .replace(/([{;]) ?([\w-]+) ?: ?/g, '$1$2:')
    .replace(/:\s+/g, ':')
    .replace(/;}/g, '}')
    .trim();
}

export const HIDE_CSS = `@media (min-width:${BP_TABLET + 1}px){.hd-d{display:none!important}}@media (min-width:${BP_PHONE + 1}px) and (max-width:${BP_TABLET}px){.hd-t{display:none!important}}@media (max-width:${BP_PHONE}px){.hd-p{display:none!important}}`;

/** `hd-d hd-t hd-p` classes for the breakpoints an element is hidden on. */
export function hideClasses(h: unknown): string {
  const o = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
  return [o.desktop && 'hd-d', o.tablet && 'hd-t', o.phone && 'hd-p'].filter(Boolean).join(' ');
}
