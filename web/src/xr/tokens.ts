import { alpha, contrast, ensureContrast, hexToRgb, mix, rgbToHex, type AccentSet } from '../theme/color';
import type { ModeTokens } from '../theme/themes';

/**
 * The Raum-Modus colours as theme tokens (docs/xr.md). For one theme and mode this derives the translucent "glass"
 * surfaces, the soft glow of gaze and focus, the hover tint and the visible edge – and checks them against the
 * accessibility floor on the way, so a theme author needs to know nothing about it:
 *
 *   --sp-glass / --sp-glass-strong   panel colour with an alpha; text, muted text and links stay ≥ 4.5:1 (7:1 in a theme
 *                                    that already has it) on it even over the WORST backdrop – pure black or pure white –
 *                                    because translucent surfaces show whatever is behind them
 *   --sp-glass-solid                 the opaque panel (prefers-contrast: more, no blur support)
 *   --sp-edge                        a border that is ≥ 3:1 against the panel (WCAG 1.4.11, controls stay findable)
 *   --sp-glow / --sp-glow-strong     the soft ring around a hovered (gazed-at) or focused control
 *   --sp-hover                       background tint of a hovered control; the text on it stays ≥ 4.5:1
 *   --sp-shadow                      the shadow that lifts glass off the page
 *
 * Only added when the Raum-Modus is on (css.ts), so the other modes cost nothing.
 */

export const GLASS_BACKDROPS = ['#000000', '#ffffff'] as const;

/** The panel colour with `a` opacity over a backdrop, as the browser composites it (plain sRGB blending). */
export function over(backdrop: string, panel: string, a: number): string {
  const b = hexToRgb(backdrop);
  const f = hexToRgb(panel);
  return rgbToHex([0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)) as [number, number, number]);
}

/** The contrast the text on glass must reach: the theme's own level (the Kontrast theme has 7:1) but at least AA. */
export const glassTarget = (k: Pick<ModeTokens, 'text' | 'panel'>) => (contrast(k.text, k.panel) >= 7 ? 7 : 4.5);

/** The lowest panel opacity (0.8 … 1) at which every text colour reads on glass over black and over white. */
export function glassAlpha(k: Pick<ModeTokens, 'text' | 'muted' | 'panel'>, linkText: string): number {
  const min = glassTarget(k);
  for (let a = 0.8; a < 1; a += 0.02) {
    const ok = GLASS_BACKDROPS.every((b) => {
      const c = over(b, k.panel, a);
      return contrast(k.text, c) >= min && contrast(k.muted, c) >= Math.min(min, 4.5) && contrast(linkText, c) >= 4.5;
    });
    if (ok) return Math.round(a * 100) / 100;
  }
  return 1;
}

export function spatialVars(k: ModeTokens, a: AccentSet, dark: boolean): Record<string, string> {
  const glass = glassAlpha(k, a.text);
  // The hover tint: as much accent as the text allows (never below 4.5:1 for the body text on it).
  let hover = k.panel;
  for (const t of [0.2, 0.16, 0.12, 0.08, 0.05]) {
    const cand = mix(k.panel, a.brand, t);
    if (contrast(k.text, cand) >= 4.5 && contrast(a.text, cand) >= 4.5) {
      hover = cand;
      break;
    }
  }
  return {
    '--sp-glass': alpha(k.panel, glass),
    '--sp-glass-strong': alpha(k.panel, Math.min(1, Math.round((glass + 0.08) * 100) / 100)),
    '--sp-glass-solid': k.panel,
    '--sp-edge': ensureContrast(mix(k.line, k.text, 0.45), k.panel, 3),
    '--sp-glow': alpha(a.ring, 0.42),
    '--sp-glow-strong': alpha(a.ring, 0.72),
    '--sp-hover': hover,
    '--sp-shadow': dark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(15, 23, 42, 0.18)',
  };
}
