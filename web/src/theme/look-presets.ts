import { STYLE_KEYS, type Backdrop, type Border, type HeaderStyle, type Radius, type Shadow, type SideStyle, type Surface, type Typeface } from '../../../server/services/appearance-model';
import { STYLE_DEFAULTS, type StyleInput } from './look';

/**
 * Stil & Fenster, the editor's side: the labels of every choice and the one-click presets. Kept apart from look.ts (the CSS
 * variables every page needs from the first paint), so they travel with the lazy settings page, not in the first download.
 */

// --- labels (German = message ids of the `look` namespace, web/src/i18n/en/look.ts) ---------------------------------

export const SURFACE_LABEL: Record<Surface, [string, string]> = {
  standard: ['Standard', 'Feiner Rahmen, klare Flächen – so kennst du HyperLevel.'],
  flat: ['Flach', 'Ohne Rahmen und Schatten, nur ruhige Flächen.'],
  classic: ['Klassisch', 'Rahmen mit leichtem Schatten, wie ein Desktop-Programm.'],
  soft: ['Weich', 'Große Rundungen und weiche, schwebende Schatten.'],
  glass: ['Glas', 'Halbtransparente Karten, die den Hintergrund durchscheinen lassen.'],
  brutal: ['Kantig', 'Eckig, kräftige Rahmen und harte Schatten.'],
};
export const RADIUS_LABEL: Record<Radius, string> = { auto: 'Wie der Stil', square: 'Eckig', small: 'Leicht', medium: 'Mittel', large: 'Rund', round: 'Sehr rund' };
export const SHADOW_LABEL: Record<Shadow, string> = { auto: 'Wie der Stil', none: 'Keine', subtle: 'Zart', medium: 'Mittel', strong: 'Kräftig' };
export const BORDER_LABEL: Record<Border, string> = { auto: 'Wie der Stil', on: 'Mit Rahmen', off: 'Ohne Rahmen' };
export const TYPEFACE_LABEL: Record<Typeface, string> = { system: 'System', modern: 'Modern', humanist: 'Humanistisch', geometric: 'Geometrisch', rounded: 'Rund & freundlich', serif: 'Serif', mono: 'Monospace' };
export const SIDE_STYLE_LABEL: Record<SideStyle, [string, string]> = {
  solid: ['Fest', 'Durchgehende Leiste in der Farbe des Themes.'],
  floating: ['Schwebend', 'Abgesetzt mit Rundung und Schatten.'],
  blend: ['Nahtlos', 'In der Farbe der Seite, nur durch eine Linie getrennt.'],
};
export const HEADER_LABEL: Record<HeaderStyle, [string, string]> = {
  solid: ['Fest', 'Kopfzeile als eigene Fläche mit Linie.'],
  clear: ['Offen', 'In der Farbe der Seite, ohne Linie.'],
  glass: ['Milchglas', 'Halbtransparent – der Inhalt scheint beim Scrollen durch.'],
  floating: ['Schwebend', 'Als abgerundete Leiste über der Seite.'],
};
export const BACKDROP_LABEL: Record<Backdrop, string> = { plain: 'Einfarbig', gradient: 'Verlauf', aurora: 'Polarlicht', dots: 'Punkte', grid: 'Raster', image: 'Eigenes Bild' };

// --- presets -----------------------------------------------------------------------------------------------------

export interface LookPreset {
  id: string;
  name: string;
  blurb: string;
  style: StyleInput;
}

const preset = (id: string, name: string, blurb: string, s: Partial<StyleInput>): LookPreset => ({ id, name, blurb, style: { ...STYLE_DEFAULTS, ...s } });

/** One click sets every style key (colours, density and font size stay as they are). */
export const LOOK_PRESETS: LookPreset[] = [
  preset('standard', 'Standard', 'Das gewohnte HyperLevel: Rahmen, klare Flächen, Systemschrift.', {}),
  preset('minimal', 'Minimal', 'Flach und nahtlos – nichts lenkt vom Inhalt ab.', { surface: 'flat', typeface: 'modern', side_style: 'blend', header: 'clear' }),
  preset('classic', 'Klassisch', 'Rahmen und zarte Schatten wie ein Desktop-Programm.', { surface: 'classic', typeface: 'humanist' }),
  preset('soft', 'Weich', 'Große Rundungen, schwebende Leisten, sanfter Verlauf.', { surface: 'soft', typeface: 'rounded', side_style: 'floating', header: 'floating', backdrop: 'gradient' }),
  preset('glass', 'Glas', 'Halbtransparente Fenster über Polarlicht, Kopfzeile aus Milchglas.', { surface: 'glass', typeface: 'modern', side_style: 'floating', header: 'glass', backdrop: 'aurora' }),
  preset('editorial', 'Redaktion', 'Serifenschrift auf Punkteraster – ruhig wie ein Magazin.', { surface: 'flat', radius: 'small', border: 'on', typeface: 'serif', side_style: 'blend', header: 'clear', backdrop: 'dots' }),
  preset('brutal', 'Kantig', 'Eckige Fenster, kräftige Rahmen, harte Schatten auf Raster.', { surface: 'brutal', typeface: 'geometric', backdrop: 'grid' }),
];

/** The preset the current choice matches ('' = hand-tuned). */
export const presetOf = (s: StyleInput): string => LOOK_PRESETS.find((p) => STYLE_KEYS.every((k) => p.style[k] === s[k]))?.id ?? '';
