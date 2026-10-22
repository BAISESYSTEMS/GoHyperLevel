import { THEME_IDS, type ThemeId } from '../../../server/services/appearance-model';

/**
 * The theme gallery. A theme is data: eight colours per mode (light and dark), nothing else. Everything
 * else – hover states, soft tints, the sidebar's muted tones, readable text on the accent, the department
 * colours – is derived from these in css.ts, so a new theme is one entry here (docs/theming.md).
 *
 * Rules for a theme (tests/theme.test.ts checks them for every entry, both modes):
 *   text on bg and panel ≥ 4.5:1 · muted on bg and panel ≥ 4.5:1 · sidebar text on sidebar ≥ 4.5:1 ·
 *   the default accent ≥ 3:1 on the panel.
 * Names are our own; the palettes are inspired by well-known colour families, not copies of them.
 */

export interface ModeTokens {
  /** Page background. */
  bg: string;
  /** Cards, top bar, inputs. */
  panel: string;
  text: string;
  muted: string;
  /** Hairlines and borders. */
  line: string;
  /** Sidebar background and its text. A light value gives a light sidebar. */
  side: string;
  sideText: string;
  /** The theme's own accent (a person can pick another). */
  accent: string;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  blurb: string;
  light: ModeTokens;
  dark: ModeTokens;
}

const m = (bg: string, panel: string, text: string, muted: string, line: string, side: string, sideText: string, accent: string): ModeTokens => ({ bg, panel, text, muted, line, side, sideText, accent });

export const THEMES: Record<ThemeId, ThemeDef> = {
  gohigh: {
    id: 'gohigh',
    name: 'HyperLevel Standard',
    blurb: 'Klar, blau, dunkle Seitenleiste – so kennst du HyperLevel.',
    light: m('#f4f6fa', '#ffffff', '#111827', '#5d6677', '#e5e7eb', '#0f172a', '#cbd5e1', '#2563eb'),
    dark: m('#0b1020', '#121a2e', '#e5e7eb', '#94a3b8', '#233049', '#070b16', '#cbd5e1', '#2563eb'),
  },
  nordlicht: {
    id: 'nordlicht',
    name: 'Nordlicht',
    blurb: 'Kühles Blaugrau, ruhig und sachlich.',
    light: m('#eef2f6', '#ffffff', '#1b2733', '#54647a', '#d6dee8', '#243447', '#d4dee9', '#3b6ea8'),
    dark: m('#10161d', '#19222c', '#e3e9f0', '#9aabbd', '#2a3846', '#0c1218', '#c9d4e0', '#4f8bd0'),
  },
  graphit: {
    id: 'graphit',
    name: 'Graphit',
    blurb: 'Neutrales Grau ohne Farbstich – der Inhalt steht im Vordergrund.',
    light: m('#f2f2f3', '#ffffff', '#1c1c1e', '#5c5d62', '#dcdcde', '#2b2b2e', '#d6d6d8', '#3f3f46'),
    dark: m('#131314', '#1c1c1e', '#ececee', '#a0a0a6', '#2e2e32', '#0e0e0f', '#cfcfd3', '#d4d4d8'),
  },
  sand: {
    id: 'sand',
    name: 'Sand',
    blurb: 'Warmes Hell mit Leinen-Ton, angenehm für lange Tage.',
    light: m('#f6f1e9', '#fffdf9', '#2b2620', '#6a5f51', '#e5dccd', '#3a3128', '#e6dccb', '#9a5f12'),
    dark: m('#1d1914', '#27221b', '#efe7d8', '#b3a690', '#3a3329', '#15120e', '#dccfb8', '#d99a3a'),
  },
  wald: {
    id: 'wald',
    name: 'Wald',
    blurb: 'Tiefes Grün, natürlich und konzentriert.',
    light: m('#eef3ee', '#fcfefc', '#14231a', '#4d6455', '#d3e0d5', '#14352a', '#cfe3d6', '#1f7a4d'),
    dark: m('#0d1612', '#14211b', '#e0efe5', '#96b3a2', '#223a2d', '#09110d', '#bcd5c4', '#3fae78'),
  },
  ozean: {
    id: 'ozean',
    name: 'Ozean',
    blurb: 'Petrol und Türkis, frisch und weit.',
    light: m('#eef6f8', '#ffffff', '#12262d', '#4a6570', '#d3e4ea', '#0f3d4c', '#cde6ee', '#0e7c92'),
    dark: m('#0a1a1f', '#112830', '#dff0f5', '#8fb3bf', '#1f3d47', '#07131a', '#b9d9e3', '#22b8d1'),
  },
  aubergine: {
    id: 'aubergine',
    name: 'Aubergine',
    blurb: 'Dunkles Violett mit warmem Akzent.',
    light: m('#f4f0f6', '#fffdff', '#261a2e', '#65577a', '#e2d8e8', '#3b1f4a', '#e3d4ec', '#7a3fa0'),
    dark: m('#170f1c', '#21162a', '#efe4f5', '#b09ac0', '#38274a', '#110a15', '#d6c3e3', '#b27ad6'),
  },
  mitternacht: {
    id: 'mitternacht',
    name: 'Mitternacht',
    blurb: 'Echtes Schwarz für OLED-Bildschirme; hell wird es ein klares Silber.',
    light: m('#eceef3', '#ffffff', '#0b0d14', '#525869', '#d4d8e2', '#0b0d14', '#d0d4e0', '#3355d6'),
    dark: m('#000000', '#0b0b0d', '#f2f2f5', '#9d9da8', '#202026', '#000000', '#c8c8d0', '#5b8def'),
  },
  papier: {
    id: 'papier',
    name: 'Papier',
    blurb: 'Hoher Kontrast wie Tinte auf Papier, mit heller Seitenleiste.',
    light: m('#fbf8f1', '#fffefb', '#141414', '#474747', '#cfc8b8', '#efe9da', '#1a1a1a', '#0b3d91'),
    dark: m('#141311', '#1c1a17', '#f3efe4', '#bdb6a4', '#3a362e', '#0f0e0c', '#e6e0d0', '#8fb4ff'),
  },
  solar: {
    id: 'solar',
    name: 'Solar',
    blurb: 'Gedämpftes Creme und Blaugrün, augenschonend wie ein altes Lieblings-Theme.',
    light: m('#fdf6e3', '#fffbee', '#0a3a47', '#52676d', '#eadfc4', '#073642', '#dfe3d8', '#1c6fa8'),
    dark: m('#002b36', '#073642', '#eee8d5', '#a2b0b0', '#12505f', '#00212b', '#bccaca', '#2aa198'),
  },
  fjord: {
    id: 'fjord',
    name: 'Fjord',
    blurb: 'Arktische Blautöne, kühl und aufgeräumt.',
    light: m('#eceff4', '#ffffff', '#2e3440', '#576175', '#d8dee9', '#3b4252', '#e5e9f0', '#4a6b94'),
    dark: m('#2e3440', '#3b4252', '#eceff4', '#b2bccd', '#4c566a', '#242933', '#d8dee9', '#88c0d0'),
  },
  vampir: {
    id: 'vampir',
    name: 'Vampir',
    blurb: 'Dunkel mit Violett und Rosa – hell als zartes Dämmerlicht.',
    light: m('#f5f2fa', '#ffffff', '#282a36', '#5a5d75', '#ded9ec', '#282a36', '#e6e6f0', '#7c4dcc'),
    dark: m('#1e1f29', '#282a36', '#f8f8f2', '#b0b6d2', '#3d4156', '#191a21', '#d9dbe8', '#bd93f9'),
  },
  mokka: {
    id: 'mokka',
    name: 'Mokka',
    blurb: 'Pastellig und weich: Latte bei Tag, Mokka bei Nacht.',
    light: m('#eff1f5', '#fcfcfe', '#4c4f69', '#5f637b', '#ccd0da', '#e3e6ee', '#4c4f69', '#8839ef'),
    dark: m('#1e1e2e', '#2a2b3c', '#cdd6f4', '#a6adc8', '#45475a', '#181825', '#cdd6f4', '#cba6f7'),
  },
  rose: {
    id: 'rose',
    name: 'Rosé',
    blurb: 'Gedecktes Rosa mit dunkler Beere, freundlich und modern.',
    light: m('#fbf1f2', '#fffcfc', '#2e1a1f', '#6f5159', '#efd9dc', '#4a2230', '#f3dce1', '#b92b55'),
    dark: m('#1a1013', '#26181c', '#f5e4e8', '#c0a0a8', '#402a30', '#12090c', '#e6c9d0', '#f0709a'),
  },
  neonnacht: {
    id: 'neonnacht',
    name: 'Neonnacht',
    blurb: 'Blau-violette Stadtnacht; tagsüber ein kühles Tagblau.',
    light: m('#e9ecf5', '#f9faff', '#343b58', '#575d7a', '#d0d5e8', '#343b58', '#d5d9ee', '#3d59c4'),
    dark: m('#1a1b26', '#24283b', '#c0caf5', '#9aa5ce', '#3b4261', '#16161e', '#a9b1d6', '#7aa2f7'),
  },
  kontrast: {
    id: 'kontrast',
    name: 'Kontrast',
    blurb: 'Maximale Lesbarkeit (WCAG AAA): reines Schwarz und Weiß, kräftige Linien.',
    light: m('#ffffff', '#ffffff', '#000000', '#383838', '#5c5c5c', '#000000', '#ffffff', '#0033cc'),
    dark: m('#000000', '#0a0a0a', '#ffffff', '#d0d0d0', '#8c8c8c', '#000000', '#ffffff', '#ffd60a'),
  },
  pastell: {
    id: 'pastell',
    name: 'Pastell',
    blurb: 'Zarte Flieder- und Mintschleier; nachts ein gedämpftes Dunkelviolett.',
    light: m('#f6f4fb', '#ffffff', '#2f2d3d', '#64617a', '#e7e3f3', '#e9e4f7', '#3a3752', '#6a5acd'),
    dark: m('#1c1b26', '#262434', '#ece9f7', '#b1acc9', '#3a3750', '#15141d', '#d3cfe6', '#a99cf0'),
  },
  business: {
    id: 'business',
    name: 'Business Blau',
    blurb: 'Seriöses Marineblau für Agentur und Kundentermine.',
    light: m('#f3f5f8', '#ffffff', '#14202e', '#526074', '#dbe1ea', '#12294a', '#d3deee', '#1d4ed8'),
    dark: m('#0c1424', '#131d33', '#e6ecf6', '#93a3bd', '#22304d', '#08101e', '#c3d0e4', '#3b6fe0'),
  },
  terrakotta: {
    id: 'terrakotta',
    name: 'Terrakotta',
    blurb: 'Warmer Ton, Lehm und Kupfer – einladend und handfest.',
    light: m('#f8f0ea', '#fffcfa', '#2c1d16', '#74594c', '#ecdcd0', '#4a2418', '#f0dccf', '#b5471f'),
    dark: m('#1a120e', '#261a15', '#f3e6dd', '#c3a595', '#43302a', '#130d0a', '#e5cfc2', '#e07a4f'),
  },
};

export const THEME_LIST: ThemeDef[] = THEME_IDS.map((id) => THEMES[id]);
export const themeById = (id: string): ThemeDef => THEMES[id as ThemeId] ?? THEMES.gohigh;
