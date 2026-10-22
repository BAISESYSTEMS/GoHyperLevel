import type { DeptPalette } from '../../../server/services/appearance-model';
import { contrast, ensureContrast, fromOklch, toOklch } from './color';

/**
 * Department colours ("Bereichsfarben"): every area of the menu has its own hue, so a page is recognised at a
 * glance. Three palettes, each computed for the current theme and mode:
 *   Harmonisch – hues spread around the accent, one tone (looks like one family with the theme)
 *   Regenbogen – evenly spread, vivid
 *   Gedeckt    – the same spread, low chroma (calm)
 * The intensity (aus / dezent / klar / vibrant) is pure CSS (theme.css) on top of these variables.
 */

export const DEPTS = [
  { id: 'crm', label: 'Dashboard & CRM', hue: 262 },
  { id: 'inbox', label: 'Konversationen', hue: 215 },
  { id: 'calendar', label: 'Kalender', hue: 178 },
  { id: 'revenue', label: 'Umsatz', hue: 148 },
  { id: 'backoffice', label: 'Back-Office', hue: 124 },
  { id: 'automation', label: 'Automationen', hue: 100 },
  { id: 'marketing', label: 'Marketing', hue: 55 },
  { id: 'service', label: 'Service', hue: 25 },
  { id: 'pages', label: 'Seiten & Funnels', hue: 350 },
  { id: 'ai', label: 'KI', hue: 320 },
  { id: 'agency', label: 'Agentur', hue: 292 },
  { id: 'system', label: 'Einstellungen & Hilfe', hue: 262, neutral: true },
] as const;
export type DeptId = (typeof DEPTS)[number]['id'];

/** Menu route → department. Routes not listed here (or unknown to the menu) get no department colour. */
export const DEPT_OF_ROUTE: Record<string, DeptId> = {
  agency: 'agency',
  dashboard: 'crm',
  boards: 'crm',
  workspace: 'crm',
  reports: 'crm',
  project: 'crm',
  conversations: 'inbox',
  calls: 'inbox',
  calendars: 'calendar',
  contacts: 'crm',
  companies: 'crm',
  objects: 'crm',
  properties: 'crm',
  opportunities: 'crm',
  sales: 'crm',
  tasks: 'crm',
  pm: 'crm',
  time: 'crm',
  canvas: 'pages',
  wiki: 'pages',
  office: 'pages',
  'team-chat': 'inbox',
  tickets: 'service',
  'help-center': 'service',
  surveys: 'service',
  feedback: 'service',
  wishes: 'service',
  campaigns: 'marketing',
  ads: 'marketing',
  social: 'marketing',
  attribution: 'marketing',
  webinars: 'marketing',
  'comment-dm': 'marketing',
  'lead-scoring': 'marketing',
  workflows: 'automation',
  apps: 'automation',
  umzug: 'system',
  'video-studio': 'ai',
  'ki-studio': 'ai',
  'ai-studio': 'ai',
  agents: 'ai',
  werkstatt: 'ai',
  marktplatz: 'ai',
  funnels: 'pages',
  forms: 'pages',
  courses: 'pages',
  community: 'pages',
  quizzes: 'pages',
  invoices: 'revenue',
  contracts: 'revenue',
  products: 'revenue',
  'payment-plans': 'revenue',
  dunning: 'revenue',
  sepa: 'revenue',
  shop: 'revenue',
  'gift-cards': 'revenue',
  affiliates: 'revenue',
  calc: 'revenue',
  profit: 'revenue',
  reviews: 'revenue',
  accounting: 'backoffice',
  inventory: 'backoffice',
  personal: 'backoffice',
  academy: 'system',
  trash: 'system',
  settings: 'system',
};

/** Hue offsets from the accent for the "harmonic" palette: close relatives first, then the opposite side. */
const HARMONIC: Record<string, number> = { crm: 0, inbox: 30, calendar: -30, marketing: 60, pages: -60, ai: 90, agency: -90, revenue: 150, backoffice: 120, automation: -150, service: 180 };

export interface DeptColors {
  /** Gradient start / flat fill. Chosen so that `ink` reads on both ends. */
  base: string;
  /** Gradient end. */
  base2: string;
  /** Text or icon colour on the sidebar (≥ 3.5:1 against it). */
  side: string;
  /** Text colour on the page surface (≥ 4.5:1). */
  text: string;
  /** Text on the filled colour (black or white, ≥ 4.5:1 on both gradient ends). */
  ink: string;
}

/**
 * Picks the ink for a two-colour gradient and shifts both ends until it reads (≥ 4.5:1). White ink is preferred
 * (the gradient is darkened a little if needed); colours that would have to turn muddy for it (yellow, green,
 * orange, anything bright) get black ink instead.
 */
function fitInk(a: string, b: string): { a: string; b: string; ink: string } {
  const worst = (ink: string, x: string, y: string) => Math.min(contrast(ink, x), contrast(ink, y));
  const shift = (hex: string, d: number) => {
    const o = toOklch(hex);
    return fromOklch({ ...o, l: o.l + d });
  };
  for (let n = 0; n <= 9; n++) {
    const x = shift(a, -0.012 * n);
    const y = shift(b, -0.012 * n);
    if (worst('#ffffff', x, y) >= 4.6) return { a: x, b: y, ink: '#ffffff' };
  }
  let [x, y] = [a, b];
  for (let i = 0; i < 40 && worst('#000000', x, y) < 4.6; i++) [x, y] = [shift(x, 0.012), shift(y, 0.012)];
  return { a: x, b: y, ink: '#000000' };
}

/** The colours of every department for a palette, theme surfaces and mode. */
export function deptColors(palette: DeptPalette, dark: boolean, accent: string, surfaces: { side: string; panel: string; bg: string }): Record<DeptId, DeptColors> {
  const accentHue = toOklch(accent).h;
  const out = {} as Record<DeptId, DeptColors>;
  for (const d of DEPTS) {
    const neutral = 'neutral' in d && d.neutral;
    const hue = palette === 'harmonic' && !neutral ? (accentHue + (HARMONIC[d.id] ?? 0) + 360) % 360 : d.hue;
    const chroma = neutral ? 0.025 : palette === 'rainbow' ? 0.17 : palette === 'harmonic' ? 0.125 : 0.07;
    // Yellows, oranges and greens look muddy (olive, brown) at the lightness that suits blue: lighter there, with black ink.
    const warm = !dark && !neutral && hue >= 40 && hue <= 175;
    const l = (dark ? 0.72 : 0.6) + (warm ? 0.09 : 0);
    const first = fromOklch({ l, c: chroma, h: hue });
    // The gradient partner drifts to a neighbouring hue and a touch darker.
    const second = fromOklch({ l: l - 0.05, c: chroma, h: (hue + (neutral ? 0 : palette === 'muted' ? 22 : 34)) % 360 });
    const fit = fitInk(first, second);
    out[d.id] = {
      base: fit.a,
      base2: fit.b,
      side: ensureContrast(first, surfaces.side, 3.5),
      text: ensureContrast(first, [surfaces.panel, surfaces.bg], 4.5),
      ink: fit.ink,
    };
  }
  return out;
}
