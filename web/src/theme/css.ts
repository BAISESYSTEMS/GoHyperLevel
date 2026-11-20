import type { DeptPalette, ThemeId } from '../../../server/services/appearance-model';
import { alpha, deriveAccent, ensureContrast, isHex, mix } from './color';
import { DEPTS, deptColors } from './depts';
import { THEMES, themeById, type ModeTokens } from './themes';
import { spatialVars } from '../xr/tokens';
import { STYLE_DEFAULTS, backdropTint, imageVeil, styleVars, type StyleInput } from './look';

/**
 * Turns a theme, an accent and a department palette into CSS custom properties. The generated
 * `<style id="pghl-theme">` only sets variables (theme.css and styles.css use them), so applying a theme is
 * instant and no component knows about themes. The browser caches both modes' CSS (localStorage) for the
 * boot script (web/public/theme-boot.js), so the first paint already has the right colours.
 */

export interface LookInput {
  theme: ThemeId;
  /** '' = the theme's own accent. */
  accent: string;
  palette: DeptPalette;
  /** The agency's brand colour (white-label); replaces the accent of the standard theme only. */
  brandColor?: string;
  /** Raum-Modus on: adds the glass, glow and edge tokens (web/src/xr/tokens.ts). */
  spatial?: boolean;
  /** Stil & Fenster (look.ts): radii, shadows, borders, typeface, background; a "nahtlos" sidebar takes the page colours. */
  style?: StyleInput;
}

/** The sidebar's colours: the theme's own, or the page's for the "nahtlos" sidebar (text on bg is ≥ 4.5:1 in every theme). */
export function sideTokens(look: Pick<LookInput, 'theme' | 'style'>, dark: boolean): { side: string; sideText: string } {
  const k = modeTokens(look.theme, dark);
  return look.style?.side_style === 'blend' ? { side: k.bg, sideText: k.text } : { side: k.side, sideText: k.sideText };
}

/** The accent that applies: the person's pick, else the agency's colour on the standard theme, else the theme's own. */
export function resolveAccent(look: LookInput, dark: boolean): string {
  if (isHex(look.accent)) return look.accent.toLowerCase();
  const t = themeById(look.theme);
  if (look.theme === 'gohigh' && isHex(look.brandColor) && look.brandColor.toLowerCase() !== THEMES.gohigh.light.accent) return look.brandColor.toLowerCase();
  return (dark ? t.dark : t.light).accent;
}

export function modeTokens(theme: ThemeId, dark: boolean): ModeTokens {
  const t = themeById(theme);
  return dark ? t.dark : t.light;
}

/** Status colours (ok / error / warning) as text: the starting points, made readable on each theme below. */
const STATUS = { light: { green: '#047857', red: '#dc2626', yellow: '#b45309' }, dark: { green: '#10b981', red: '#f87171', yellow: '#f59e0b' } };

/** Every CSS variable of a look in one mode. */
export function buildVars(look: LookInput, dark: boolean): Record<string, string> {
  const k = modeTokens(look.theme, dark);
  const accent = resolveAccent(look, dark);
  const a = deriveAccent(accent, { panel: k.panel, bg: k.bg, text: k.text }, dark);
  const { side, sideText } = sideTokens(look, dark);
  const v: Record<string, string> = {
    '--bg': k.bg,
    '--panel': k.panel,
    '--text': k.text,
    '--muted': k.muted,
    '--line': k.line,
    '--side': side,
    '--side-text': sideText,
    '--side-muted': ensureContrast(mix(side, sideText, 0.62), side, 4.5),
    '--side-icon': ensureContrast(mix(side, sideText, 0.72), side, 3.2),
    '--side-hover': mix(side, sideText, 0.1),
    '--side-active': mix(side, sideText, 0.17),
    '--side-line': mix(side, sideText, 0.15),
    '--side-control': mix(side, sideText, 0.08),
    '--side-control-line': mix(side, sideText, 0.2),
    '--brand': a.brand,
    '--brand-hover': a.hover,
    '--on-brand': a.on,
    '--brand-soft': a.soft,
    '--brand-text': a.text,
    '--brand-ring': a.ring,
    '--brand-select': a.select,
    // ≥ 4.5:1 on cards and on the page in every theme (due dates, "+20" points, warnings); filled badges and buttons with
    // white text use the fixed --green-fill / --red-fill / --yellow-fill (styles.css) instead.
    '--green': ensureContrast(STATUS[dark ? 'dark' : 'light'].green, [k.panel, k.bg], 4.5),
    '--red': ensureContrast(STATUS[dark ? 'dark' : 'light'].red, [k.panel, k.bg], 4.5),
    '--yellow': ensureContrast(STATUS[dark ? 'dark' : 'light'].yellow, [k.panel, k.bg], 4.5),
    '--scroll': dark ? 'rgba(148, 163, 184, .22)' : 'rgba(100, 116, 139, .35)',
    '--scroll-hover': dark ? 'rgba(148, 163, 184, .45)' : 'rgba(100, 116, 139, .6)',
    '--side-scroll': alpha(sideText, 0.2),
    '--side-scroll-hover': alpha(sideText, 0.4),
    'color-scheme': dark ? 'dark' : 'light',
  };
  Object.assign(v, styleVars(look.style ?? STYLE_DEFAULTS, dark));
  if (look.spatial) Object.assign(v, spatialVars(k, a, dark));
  const colors = deptColors(look.palette, dark, accent, { side, panel: k.panel, bg: k.bg });
  for (const d of DEPTS) {
    const c = colors[d.id];
    v[`--d-${d.id}`] = c.base;
    v[`--d-${d.id}-2`] = c.base2;
    v[`--d-${d.id}-side`] = c.side;
    v[`--d-${d.id}-text`] = c.text;
    v[`--d-${d.id}-ink`] = c.ink;
  }
  // How much colour the background gradients may carry (look.ts): readable muted text on the strongest spot.
  v['--tint-a'] = `${Math.round(backdropTint(k, [a.brand, colors.ai?.base ?? a.brand, colors.inbox?.base ?? a.brand]) * 100)}%`;
  // An own background picture is blended under this veil (look.ts imageVeil): readable whatever the photo holds.
  // (always set: the picture tile on the Darstellung page shows it before it is chosen)
  const iv = imageVeil(k);
  v['--img-veil'] = iv.veil;
  v['--img-blend'] = iv.blend;
  return v;
}

/** The style sheet text for one mode (screen only: print keeps its own light tokens). */
export function buildCss(look: LookInput, dark: boolean): string {
  const body = Object.entries(buildVars(look, dark))
    .map(([k, val]) => `${k}:${val}`)
    .join(';');
  return `@media screen{:root[data-theme-id][data-theme='${dark ? 'dark' : 'light'}']{${body}}}`;
}

/** Both modes, for the boot cache. */
export const buildBoth = (look: LookInput) => ({ light: buildCss(look, false), dark: buildCss(look, true) });
