import { bad } from '../core/http.js';

/**
 * Looks for forms: presets (colours and fonts), the settings an owner can change (fonts from the system – no web font is loaded, so no
 * visitor's address goes to a font server –, colours, background picture, corners, alignment), the CSS they become and a contrast check.
 */

export const FONTS: Record<string, { label: string; stack: string }> = {
  system: { label: 'Systemschrift', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  serif: { label: 'Serif (Buch)', stack: 'Georgia, "Times New Roman", "Noto Serif", serif' },
  rounded: { label: 'Rund', stack: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Nunito", system-ui, sans-serif' },
  humanist: { label: 'Humanistisch', stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", sans-serif' },
  mono: { label: 'Schreibmaschine', stack: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace' },
};

export interface Theme {
  preset: string;
  font: keyof typeof FONTS | string;
  /** Buttons, selection, progress. */
  color: string;
  /** Page behind the form. */
  background: string;
  /** The card (classic) or the screen (one question at a time) – usually the same as the page. */
  card: string;
  text: string;
  /** Text on buttons (empty = black or white, whichever reads better). */
  button_text: string;
  bg_image: string;
  /** Darkening of the picture, 0–80 %. */
  bg_overlay: number;
  radius: number;
  align: 'left' | 'center';
}

export const PRESETS: Record<string, { label: string; theme: Omit<Theme, 'preset'> }> = {
  standard: { label: 'Standard', theme: { font: 'system', color: '#2563eb', background: '#f9fafb', card: '#ffffff', text: '#111827', button_text: '', bg_image: '', bg_overlay: 0, radius: 12, align: 'left' } },
  dunkel: { label: 'Dunkel', theme: { font: 'system', color: '#60a5fa', background: '#0b1020', card: '#111a2e', text: '#e5e7eb', button_text: '#0b1020', bg_image: '', bg_overlay: 0, radius: 12, align: 'left' } },
  minimal: { label: 'Minimal', theme: { font: 'serif', color: '#111827', background: '#ffffff', card: '#ffffff', text: '#111827', button_text: '#ffffff', bg_image: '', bg_overlay: 0, radius: 2, align: 'left' } },
  warm: { label: 'Warm', theme: { font: 'rounded', color: '#c2410c', background: '#fff7ed', card: '#fffbf5', text: '#431407', button_text: '#ffffff', bg_image: '', bg_overlay: 0, radius: 18, align: 'left' } },
  ozean: { label: 'Ozean', theme: { font: 'humanist', color: '#0e7490', background: '#ecfeff', card: '#ffffff', text: '#083344', button_text: '#ffffff', bg_image: '', bg_overlay: 0, radius: 14, align: 'center' } },
  wald: { label: 'Wald', theme: { font: 'humanist', color: '#166534', background: '#f0fdf4', card: '#ffffff', text: '#052e16', button_text: '#ffffff', bg_image: '', bg_overlay: 0, radius: 10, align: 'left' } },
  pastell: { label: 'Pastell', theme: { font: 'rounded', color: '#7c3aed', background: '#faf5ff', card: '#ffffff', text: '#3b0764', button_text: '#ffffff', bg_image: '', bg_overlay: 0, radius: 22, align: 'center' } },
  elegant: { label: 'Elegant', theme: { font: 'serif', color: '#d4af37', background: '#14110f', card: '#1c1815', text: '#f5efe6', button_text: '#14110f', bg_image: '', bg_overlay: 0, radius: 4, align: 'center' } },
  kontrast: { label: 'Hoher Kontrast', theme: { font: 'system', color: '#ffdd00', background: '#000000', card: '#000000', text: '#ffffff', button_text: '#000000', bg_image: '', bg_overlay: 0, radius: 6, align: 'left' } },
  knallig: { label: 'Knallig', theme: { font: 'rounded', color: '#e11d48', background: '#fef9c3', card: '#ffffff', text: '#1f2937', button_text: '#ffffff', bg_image: '', bg_overlay: 0, radius: 24, align: 'center' } },
};

const HEX = /^#[0-9a-f]{6}$/i;
const hexOf = (v: unknown, fallback: string, what: string) => {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  if (!HEX.test(s)) throw bad(`${what}: Farbe als #rrggbb`);
  return s.toLowerCase();
};

/** The theme from the editor (a preset and/or single changes) → a complete theme. Without a preset the standard one is the base. */
export function cleanTheme(input: any, base?: Partial<Theme>): Theme {
  const presetKey = input?.preset !== undefined ? String(input.preset) : base?.preset ?? 'standard';
  if (!PRESETS[presetKey]) throw bad('Unbekannte Vorlage für das Aussehen');
  // A different preset starts from that preset; the same one keeps what was changed on top of it.
  const switched = input?.preset !== undefined && input.preset !== base?.preset;
  const start: Omit<Theme, 'preset'> = { ...PRESETS[presetKey].theme, ...(switched ? {} : stripPreset(base ?? {})) };
  const v: Record<string, any> = { ...start, ...(input ?? {}) };
  const font = String(v.font ?? 'system');
  if (!FONTS[font]) throw bad('Unbekannte Schriftart');
  const image = String(v.bg_image ?? '').trim();
  if (image && !/^(https:\/\/|\/)[^\s"'<>()\\]{1,500}$/i.test(image)) throw bad('Hintergrundbild: bitte eine https://-Adresse');
  const overlay = Math.round(Number(v.bg_overlay));
  const radius = Math.round(Number(v.radius));
  return {
    preset: presetKey,
    font,
    color: hexOf(v.color, '#2563eb', 'Farbe'),
    background: hexOf(v.background, '#f9fafb', 'Hintergrund'),
    card: hexOf(v.card, '#ffffff', 'Karte'),
    text: hexOf(v.text, '#111827', 'Text'),
    button_text: v.button_text ? hexOf(v.button_text, '', 'Button-Text') : '',
    bg_image: image,
    bg_overlay: Number.isFinite(overlay) ? Math.min(Math.max(overlay, 0), 80) : 0,
    radius: Number.isFinite(radius) ? Math.min(Math.max(radius, 0), 28) : 12,
    align: v.align === 'center' ? 'center' : 'left',
  };
}
const stripPreset = (t: Partial<Theme>) => {
  const { preset: _p, ...rest } = t;
  void _p;
  return rest as Omit<Theme, 'preset'>;
};

/** The theme a form uses (settings.theme or the old single `color` setting on the standard look). */
export function themeOf(settings: { theme?: any; color?: string } | undefined): Theme {
  try {
    const t = settings?.theme ? cleanTheme(settings.theme) : cleanTheme({});
    return !settings?.theme && /^#[0-9a-f]{6}$/i.test(settings?.color ?? '') ? { ...t, color: settings!.color!.toLowerCase() } : t;
  } catch {
    return cleanTheme({});
  }
}

// --- colour maths ------------------------------------------------------------------------------------------------------------------------

const chan = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
}
/** WCAG contrast ratio of two colours, 1–21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}
/** Black or white – whichever reads better on this colour. */
export const readableOn = (bg: string) => (contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff');

/** Combinations that are hard to read (below WCAG AA 4.5 : 1), as sentences for the editor. */
export function contrastWarnings(t: Theme): string[] {
  const out: string[] = [];
  const onCard = contrast(t.text, t.card);
  if (onCard < 4.5) out.push(`Text auf Karte: Kontrast ${onCard} : 1 – mindestens 4,5 : 1 ist gut lesbar.`);
  const onPage = contrast(t.text, t.background);
  if (!t.bg_image && onPage < 4.5) out.push(`Text auf Hintergrund: Kontrast ${onPage} : 1 – mindestens 4,5 : 1 ist gut lesbar.`);
  const btn = contrast(t.button_text || readableOn(t.color), t.color);
  if (btn < 4.5) out.push(`Button: Kontrast ${btn} : 1 – mindestens 4,5 : 1 ist gut lesbar.`);
  const accent = contrast(t.color, t.card);
  if (accent < 3) out.push(`Akzentfarbe auf Karte: Kontrast ${accent} : 1 – mindestens 3 : 1 für Markierungen.`);
  return out;
}

/** CSS variables for one form (scoped to its root element, so a form inside a funnel page cannot change the page). */
export function themeVars(t: Theme): string {
  const btnText = t.button_text || readableOn(t.color);
  const muted = contrast(t.text, t.card) >= 7 ? `color-mix(in srgb, ${t.text} 62%, ${t.card})` : `color-mix(in srgb, ${t.text} 75%, ${t.card})`;
  return [
    `--pf-font:${FONTS[t.font]?.stack ?? FONTS.system.stack}`,
    `--pf-color:${t.color}`,
    `--pf-btn-text:${btnText}`,
    `--pf-bg:${t.background}`,
    `--pf-card:${t.card}`,
    `--pf-text:${t.text}`,
    `--pf-muted:${muted}`,
    `--pf-line:color-mix(in srgb, ${t.text} 18%, ${t.card})`,
    `--pf-soft:color-mix(in srgb, ${t.color} 14%, ${t.card})`,
    `--pf-radius:${t.radius}px`,
    `--pf-align:${t.align}`,
    `--pf-overlay:${t.bg_overlay / 100}`,
  ].join(';');
}
