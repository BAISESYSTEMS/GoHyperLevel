import {
  BACKDROP_IMAGE_RE,
  PREF_DEFAULTS,
  STYLE_KEYS,
  type Backdrop,
  type Border,
  type Prefs,
  type Radius,
  type Shadow,
  type StyleKey,
  type Surface,
  type Typeface,
} from '../../../server/services/appearance-model';
import { contrast, hexToRgb, luminance, rgbToHex } from './color';

/**
 * Stil & Fenster: the shape side of the look – cards and windows, corners, shadows, borders, typeface, sidebar, top bar
 * and the app background. Colours stay with the theme (themes.ts); everything here is CSS variables that look.css uses,
 * so every page follows without knowing about it. The variables go into the generated theme style sheet (css.ts), which
 * the boot script caches, so the first paint already has the right shapes.
 *
 *   --r-card --r-ctl --r-btn --r-pop   corner radii of cards, inputs, buttons and dialogs
 *   --sh-card --sh-pop --sh-side       shadows of cards, dialogs and the floating sidebar / top bar
 *   --bd-w --bd-c                      border width and colour of cards
 *   --surface                          card background (translucent for glass)
 *   --font-ui                          the typeface
 *   --backdrop --backdrop-size         the app background behind the pages
 *   --tint-a                           how much colour the gradients mix into the page (backdropTint, set by css.ts)
 *   --img-veil --backdrop-blend        an own picture: blended under a veil so text stays readable (imageVeil, css.ts)
 *
 * The structural parts (floating sidebar, glass top bar, brutal buttons) key on html[data-surface|data-side-style|
 * data-header|data-backdrop] in look.css.
 */

/** The style keys, plus the own background picture (kept apart: presets neither set nor compare it). */
export type StyleInput = Pick<Prefs, StyleKey> & { backdrop_image?: string };
export const STYLE_DEFAULTS: StyleInput = Object.fromEntries(STYLE_KEYS.map((k) => [k, PREF_DEFAULTS[k]])) as StyleInput;
export const styleOf = (p: Partial<Prefs>): StyleInput => ({ ...(Object.fromEntries(STYLE_KEYS.map((k) => [k, p[k] ?? PREF_DEFAULTS[k]])) as StyleInput), backdrop_image: p.backdrop_image ?? '' });

type Fixed<T> = Exclude<T, 'auto'>;

/** What each surface style suggests for the fine-tuning set to "auto". */
export const SURFACE_DEFAULTS: Record<Surface, { radius: Fixed<Radius>; shadow: Fixed<Shadow>; border: Fixed<Border> }> = {
  standard: { radius: 'medium', shadow: 'none', border: 'on' },
  flat: { radius: 'small', shadow: 'none', border: 'off' },
  classic: { radius: 'small', shadow: 'subtle', border: 'on' },
  soft: { radius: 'large', shadow: 'medium', border: 'off' },
  glass: { radius: 'large', shadow: 'medium', border: 'on' },
  brutal: { radius: 'square', shadow: 'medium', border: 'on' },
};

/** The values that apply: "auto" resolved through the surface style. */
export function resolveStyle(s: StyleInput): { radius: Fixed<Radius>; shadow: Fixed<Shadow>; border: Fixed<Border> } {
  const d = SURFACE_DEFAULTS[s.surface] ?? SURFACE_DEFAULTS.standard;
  return { radius: s.radius === 'auto' ? d.radius : s.radius, shadow: s.shadow === 'auto' ? d.shadow : s.shadow, border: s.border === 'auto' ? d.border : s.border };
}

/** [card, input, button, dialog] in px; 999 = pill. */
const RADIUS_PX: Record<Fixed<Radius>, [number, number, number, number]> = {
  square: [0, 0, 0, 0],
  small: [6, 5, 5, 8],
  medium: [12, 8, 8, 14],
  large: [18, 11, 11, 22],
  round: [26, 14, 999, 28],
};

const SHADOW_CSS: Record<Fixed<Shadow>, { light: string; dark: string }> = {
  none: { light: 'none', dark: 'none' },
  subtle: { light: '0 1px 2px rgba(15,23,42,.06),0 1px 3px rgba(15,23,42,.08)', dark: '0 1px 2px rgba(0,0,0,.4),0 1px 4px rgba(0,0,0,.3)' },
  medium: { light: '0 10px 30px -12px rgba(15,23,42,.2),0 2px 6px rgba(15,23,42,.06)', dark: '0 12px 32px -12px rgba(0,0,0,.65),0 2px 6px rgba(0,0,0,.35)' },
  strong: { light: '0 22px 50px -16px rgba(15,23,42,.32),0 6px 14px rgba(15,23,42,.1)', dark: '0 24px 54px -16px rgba(0,0,0,.8),0 6px 14px rgba(0,0,0,.45)' },
};
/** Brutal: hard offset shadows in the text colour instead of soft ones. */
const BRUTAL_SHADOW: Record<Fixed<Shadow>, string> = { none: 'none', subtle: '2px 2px 0 var(--text)', medium: '4px 4px 0 var(--text)', strong: '7px 7px 0 var(--text)' };

/** Font stacks of fonts the systems bring along (Windows, macOS, Linux, Android) – no download, no consent. */
export const TYPEFACE_STACKS: Record<Typeface, string> = {
  system: `system-ui,-apple-system,'Segoe UI',Roboto,sans-serif`,
  // i18n-ignore: font names ("Helvetica Neue" is no German text)
  modern: `Inter,'Segoe UI Variable Text','Segoe UI',Roboto,'Helvetica Neue','Arial Nova',Arial,sans-serif`,
  humanist: `Seravek,'Gill Sans Nova',Ubuntu,Calibri,'DejaVu Sans',source-sans-pro,sans-serif`,
  geometric: `Avenir,'Avenir Next',Montserrat,Corbel,'URW Gothic',source-sans-pro,sans-serif`,
  rounded: `ui-rounded,'SF Pro Rounded','Hiragino Maru Gothic ProN',Quicksand,Comfortaa,Manjari,'Arial Rounded MT','Arial Rounded MT Bold',Calibri,source-sans-pro,sans-serif`,
  serif: `Charter,'Bitstream Charter','Sitka Text',Cambria,Georgia,serif`,
  mono: `ui-monospace,'Cascadia Code','SF Mono','Source Code Pro',Menlo,Consolas,'DejaVu Sans Mono',monospace`,
};

/**
 * App backgrounds. The gradients mix the accent (and two department colours) into the page colour at --tint-a at most –
 * backdropTint() picks the largest share up to 12 % that keeps text and muted text ≥ 4.5:1 on the strongest spot, for
 * any theme and accent (tests/look.test.ts). Patterns use the text colour at a few percent.
 */
const BACKDROP_CSS: Record<Backdrop, { image: string; size: string }> = {
  plain: { image: 'none', size: 'auto' },
  // the own picture: built in styleVars (it needs the path); without one it is plain
  image: { image: 'none', size: 'auto' },
  gradient: {
    image: 'radial-gradient(120% 90% at 0% 0%,color-mix(in srgb,var(--brand) var(--tint-a),transparent),transparent 62%),radial-gradient(90% 80% at 100% 100%,color-mix(in srgb,var(--brand) calc(var(--tint-a) * .66),transparent),transparent 65%)',
    size: 'auto',
  },
  aurora: {
    image:
      'radial-gradient(60% 55% at 12% 8%,color-mix(in srgb,var(--brand) var(--tint-a),transparent),transparent 70%),radial-gradient(55% 50% at 88% 18%,color-mix(in srgb,var(--d-ai,var(--brand)) calc(var(--tint-a) * .85),transparent),transparent 70%),radial-gradient(70% 60% at 70% 100%,color-mix(in srgb,var(--d-inbox,var(--brand)) calc(var(--tint-a) * .75),transparent),transparent 72%)',
    size: 'auto',
  },
  dots: { image: 'radial-gradient(color-mix(in srgb,var(--text) 15%,transparent) 1px,transparent 1.6px)', size: '18px 18px' },
  grid: {
    image: 'linear-gradient(color-mix(in srgb,var(--text) 6%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--text) 6%,transparent) 1px,transparent 1px)',
    size: '28px 28px',
  },
};
/** The strongest accent share of a background. */
export const BACKDROP_MAX_TINT = 0.12;

/** `color-mix(in srgb, fg a, transparent)` over a background: plain alpha compositing in sRGB. */
export const over = (bg: string, fg: string, a: number): string => {
  const b = hexToRgb(bg);
  const f = hexToRgb(fg);
  return rgbToHex([0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)) as [number, number, number]);
};

/**
 * The veil over an own picture. Any photo can be black or white somewhere, so plain transparency would have to fade it to a
 * few percent. Instead the veil is blended: on a light page with "screen" (the picture can only get lighter than the veil),
 * on a dark page with "multiply" (only darker). The veil is the page colour moved as far towards the picture as text and
 * muted text allow (≥ 4.5:1 against the veil, the worst spot) – the picture keeps its shapes in that band of brightness.
 */
export function imageVeil(k: { bg: string; text: string; muted: string }): { veil: string; blend: 'screen' | 'multiply' } {
  const lightPage = luminance(k.text) < luminance(k.bg);
  const towards = lightPage ? '#000000' : '#ffffff';
  let pct = 60;
  while (pct > 0 && !(contrast(k.muted, over(k.bg, towards, pct / 100)) >= 4.5 && contrast(k.text, over(k.bg, towards, pct / 100)) >= 4.5)) pct--;
  return { veil: over(k.bg, towards, pct / 100), blend: lightPage ? 'screen' : 'multiply' };
}

/** The largest share (≤ BACKDROP_MAX_TINT, in whole percent) of the given colours over the page that keeps text and muted text ≥ 4.5:1. */
export function backdropTint(k: { bg: string; text: string; muted: string }, colors: string[]): number {
  let pct = Math.round(BACKDROP_MAX_TINT * 100);
  const ok = (a: number) => colors.every((c) => contrast(k.muted, over(k.bg, c, a)) >= 4.5 && contrast(k.text, over(k.bg, c, a)) >= 4.5);
  while (pct > 0 && !ok(pct / 100)) pct--;
  return pct / 100;
}
/** How opaque glass cards are (the backdrop shines through the rest). */
export const GLASS_ALPHA = 0.76;

/** Every CSS variable of the style in one mode. */
export function styleVars(s: StyleInput, dark: boolean): Record<string, string> {
  const r = resolveStyle(s);
  const [card, ctl, btn, pop] = RADIUS_PX[r.radius];
  const brutal = s.surface === 'brutal';
  const glass = s.surface === 'glass';
  const shadow = brutal ? BRUTAL_SHADOW[r.shadow] : glass && r.shadow !== 'none' ? `${SHADOW_CSS[r.shadow][dark ? 'dark' : 'light']},inset 0 1px 0 ${dark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.7)'}` : SHADOW_CSS[r.shadow][dark ? 'dark' : 'light'];
  const picture = s.backdrop === 'image' && !!s.backdrop_image && BACKDROP_IMAGE_RE.test(s.backdrop_image);
  const bd = picture ? { image: `linear-gradient(var(--img-veil),var(--img-veil)),url("${s.backdrop_image}")`, size: 'cover' } : (BACKDROP_CSS[s.backdrop] ?? BACKDROP_CSS.plain);
  return {
    '--r-card': `${card}px`,
    '--r-ctl': `${ctl}px`,
    '--r-btn': `${btn}px`,
    '--r-pop': `${pop}px`,
    '--radius': `${Math.min(ctl + 2, 14)}px`,
    '--sh-card': shadow,
    '--sh-pop': brutal ? '8px 8px 0 var(--text)' : dark ? '0 24px 64px rgba(0,0,0,.6)' : '0 20px 60px rgba(0,0,0,.3)',
    '--sh-side': brutal ? '4px 4px 0 var(--text)' : SHADOW_CSS.medium[dark ? 'dark' : 'light'],
    '--bd-w': r.border === 'off' ? '0px' : brutal ? '2px' : '1px',
    '--bd-c': brutal ? 'var(--text)' : glass ? `color-mix(in srgb,var(--line) ${dark ? 70 : 55}%,transparent)` : 'var(--line)',
    '--surface': glass ? `color-mix(in srgb,var(--panel) ${Math.round(GLASS_ALPHA * 100)}%,transparent)` : 'var(--panel)',
    '--font-ui': TYPEFACE_STACKS[s.typeface] ?? TYPEFACE_STACKS.system,
    '--backdrop': bd.image,
    '--backdrop-size': bd.size,
    '--backdrop-blend': picture ? 'var(--img-blend),normal' : 'normal',
  };
}

/** The <html> attributes look.css keys on. */
export const styleAttrs = (s: StyleInput): Record<string, string> => ({ surface: s.surface, sideStyle: s.side_style, header: s.header, backdrop: s.backdrop });

// The labels and presets of the editor (Darstellung → Stil & Fenster) live in look-presets.ts – only the lazy settings need them.
