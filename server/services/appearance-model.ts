/**
 * The look of the app as data: what a person (or the agency, as a default) can choose, how it is
 * validated and which choices an agency may lock. Pure code without Node or browser APIs – the server
 * (modules/appearance.ts) and the web app (web/src/theme/*) share it, so the lists cannot drift apart.
 *
 * The colours themselves live in the web app (web/src/theme/themes.ts, typed `Record<ThemeId, …>` so that
 * a theme missing from THEME_IDS – or the other way round – does not compile).
 */

export const THEME_IDS = [
  'gohigh',
  'nordlicht',
  'graphit',
  'sand',
  'wald',
  'ozean',
  'aubergine',
  'mitternacht',
  'papier',
  'solar',
  'fjord',
  'vampir',
  'mokka',
  'rose',
  'neonnacht',
  'kontrast',
  'pastell',
  'business',
  'terrakotta',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const MODES = ['light', 'dark', 'system'] as const;
export type Mode = (typeof MODES)[number];

/** Department colours: off, subtle (dot / stripe), clear (tinted), vibrant (gradients). */
export const DEPT_LEVELS = ['off', 'subtle', 'clear', 'vibrant'] as const;
export type DeptLevel = (typeof DEPT_LEVELS)[number];
export const DEPT_PALETTES = ['harmonic', 'rainbow', 'muted'] as const;
export type DeptPalette = (typeof DEPT_PALETTES)[number];

export const SIDEBAR_MODES = ['full', 'rail'] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

export const ICON_PACKS = ['line', 'fine', 'bold', 'square', 'duotone', 'solid'] as const;
export type IconPackId = (typeof ICON_PACKS)[number];

export const DENSITIES = ['compact', 'normal', 'comfortable'] as const;
export type Density = (typeof DENSITIES)[number];
export const FONT_SIZES = ['small', 'normal', 'large'] as const;
export type FontSize = (typeof FONT_SIZES)[number];

/** Raum-Modus (spatial UI for headsets and glasses, docs/xr.md): automatic on XR devices, always on, or off. */
export const SPATIAL_MODES = ['auto', 'on', 'off'] as const;
export type SpatialMode = (typeof SPATIAL_MODES)[number];

import { NAMES } from './werkstatt/names.js';
import { GOAL_IDS, PRO_KEYS } from './areas-model.js';
import type { TileOrder } from './tile-order.js';

// --- modules (what a person may hide) -------------------------------------------------------------------

/** Menu entries that can be hidden, by section. "Dashboard", "Einstellungen" and "Agentur" always stay. */
export const MODULE_SECTIONS: { id: string; label: string; modules: [route: string, label: string][] }[] = [
  {
    id: 'start',
    label: 'Start & CRM',
    modules: [
      ['boards', 'Boards'],
      ['workspace', 'Arbeitsfläche'],
      ['reports', 'Berichte'],
      ['project', 'Projekt'],
      ['conversations', 'Konversationen'],
      ['calls', 'Anrufe'],
      ['calendars', 'Kalender'],
      ['contacts', 'Kontakte'],
      ['companies', 'Firmen'],
      ['objects', 'Objekte'],
      ['opportunities', 'Opportunities'],
      ['sales', 'Vertrieb'],
      ['tasks', 'Aufgaben'],
      ['pm', 'Projektplanung'],
      ['time', 'Zeiterfassung'],
      ['canvas', 'Canvas'],
      ['wiki', 'Wiki'],
      ['office', 'Office'],
      ['team-chat', 'Team-Chat'],
    ],
  },
  {
    id: 'service',
    label: 'Service',
    modules: [
      ['tickets', 'Tickets'],
      ['help-center', 'Wissensdatenbank'],
      ['surveys', 'Umfragen'],
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    modules: [
      ['campaigns', 'Kampagnen'],
      ['workflows', 'Automationen'],
      ['social', 'Social Planner'],
      ['video-studio', 'Video-Studio'],
      ['ki-studio', 'KI-Studio'],
      ['ai-studio', 'AI Studio'],
      ['attribution', 'Attribution'],
      ['ads', 'Anzeigen'],
      ['lead-scoring', 'Lead-Scoring'],
      ['webinars', 'Webinare'],
      ['comment-dm', 'Kommentar-zu-DM'],
    ],
  },
  {
    id: 'pages',
    label: 'Seiten',
    modules: [
      ['funnels', 'Funnels & Websites'],
      ['forms', 'Formulare & Umfragen'],
      ['courses', 'Kurse'],
      ['quizzes', 'Quiz & Zertifikate'],
      ['community', 'Community'],
    ],
  },
  {
    id: 'revenue',
    label: 'Umsatz',
    modules: [
      ['invoices', 'Rechnungen & Angebote'],
      ['contracts', 'Verträge'],
      ['products', 'Produkte'],
      ['payment-plans', 'Ratenzahlung'],
      ['dunning', 'Mahnwesen'],
      ['sepa', 'SEPA-Lastschrift'],
      ['shop', 'Online-Shop'],
      ['gift-cards', 'Gutscheine'],
      ['affiliates', 'Affiliates'],
      ['calc', 'Gewinnrechner'],
      ['profit', 'Rentabilität'],
      ['reviews', 'Bewertungen'],
    ],
  },
  {
    id: 'backoffice',
    label: 'Back-Office',
    modules: [
      ['accounting', 'Buchhaltung'],
      ['inventory', 'Lager & Einkauf'],
      ['personal', 'Personal'],
    ],
  },
  {
    id: 'tools',
    label: 'Werkzeuge',
    modules: [
      ['agents', 'KI-Agenten'],
      ['werkstatt', NAMES.werkstatt],
      ['marktplatz', NAMES.marktplatz],
      ['apps', 'Apps'],
      ['umzug', 'Umzug'],
      ['academy', 'Akademie'],
    ],
  },
];

export const MODULE_IDS: string[] = MODULE_SECTIONS.flatMap((s) => s.modules.map(([id]) => id));
/** The menu entries that cannot be hidden: the landing page, the settings (the way back), the agency and the Papierkorb (deleted things must stay findable). */
export const ALWAYS_VISIBLE = ['dashboard', 'settings', 'agency', 'trash'];

export interface Profile {
  id: string;
  label: string;
  text: string;
  /** The hideable modules that stay visible; everything else of MODULE_IDS is hidden. */
  visible: string[];
}

/** Starter profiles: one click picks what a kind of business usually works with. */
export const PROFILES: Profile[] = [
  {
    id: 'agency',
    label: 'Agentur',
    text: 'Kunden betreuen: Posteingang, Pipeline, Kampagnen, Seiten, Berichte und Rechnungen.',
    visible: ['boards', 'workspace', 'reports', 'project', 'conversations', 'calls', 'calendars', 'contacts', 'companies', 'opportunities', 'sales', 'tasks', 'pm', 'time', 'canvas', 'wiki', 'team-chat', 'campaigns', 'ads', 'workflows', 'social', 'video-studio', 'ki-studio', 'ai-studio', 'attribution', 'webinars', 'comment-dm', 'funnels', 'forms', 'invoices', 'contracts', 'products', 'dunning', 'calc', 'profit', 'reviews', 'accounting', 'agents', 'werkstatt', 'marktplatz', 'apps', 'academy'],
  },
  {
    id: 'coach',
    label: 'Coach & Kurse',
    text: 'Wissen verkaufen: Kurse, Community, Termine, Funnels, E-Mail und Zahlungen.',
    visible: ['boards', 'workspace', 'reports', 'conversations', 'calendars', 'contacts', 'opportunities', 'sales', 'tasks', 'surveys', 'campaigns', 'ads', 'workflows', 'social', 'ki-studio', 'ai-studio', 'webinars', 'comment-dm', 'funnels', 'forms', 'courses', 'quizzes', 'community', 'invoices', 'products', 'payment-plans', 'dunning', 'calc', 'reviews', 'accounting', 'agents', 'apps', 'academy'],
  },
  {
    id: 'local',
    label: 'Lokales Business / Handwerk',
    text: 'Anfragen, Termine, Angebote und Rechnungen, dazu Bewertungen und eine einfache Website.',
    visible: ['boards', 'workspace', 'conversations', 'calls', 'calendars', 'contacts', 'companies', 'opportunities', 'sales', 'tasks', 'pm', 'time', 'campaigns', 'ads', 'workflows', 'social', 'funnels', 'forms', 'invoices', 'contracts', 'products', 'dunning', 'calc', 'profit', 'reviews', 'accounting', 'inventory', 'personal', 'apps', 'academy'],
  },
  {
    id: 'ecommerce',
    label: 'E-Commerce',
    text: 'Käufer gewinnen und halten: Funnels, Produkte, Affiliates, Attribution, Support und Bewertungen.',
    visible: ['boards', 'workspace', 'reports', 'conversations', 'contacts', 'opportunities', 'sales', 'tasks', 'tickets', 'help-center', 'surveys', 'campaigns', 'ads', 'workflows', 'social', 'ki-studio', 'ai-studio', 'attribution', 'webinars', 'comment-dm', 'funnels', 'forms', 'invoices', 'products', 'payment-plans', 'dunning', 'affiliates', 'reviews', 'accounting', 'inventory', 'agents', 'apps', 'academy'],
  },
  {
    id: 'sales',
    label: 'Vertriebsteam',
    text: 'Pipeline, Anrufe, Firmen und Objekte, Lead-Scoring, Verträge und Auswertungen.',
    visible: ['boards', 'workspace', 'reports', 'conversations', 'calls', 'calendars', 'contacts', 'companies', 'objects', 'opportunities', 'sales', 'tasks', 'team-chat', 'campaigns', 'workflows', 'attribution', 'lead-scoring', 'invoices', 'contracts', 'products', 'dunning', 'agents', 'apps', 'academy'],
  },
  { id: 'all', label: 'Alles', text: 'Nichts ausblenden – alle Bereiche bleiben im Menü.', visible: [...MODULE_IDS] },
];
export const PROFILE_IDS = PROFILES.map((p) => p.id);

/** The modules a profile hides (the list stored as `hidden`). */
export const hiddenForProfile = (id: string): string[] => {
  const p = PROFILES.find((x) => x.id === id);
  return p ? MODULE_IDS.filter((m) => !p.visible.includes(m)) : [];
};

// --- preferences ----------------------------------------------------------------------------------------

export interface Prefs {
  theme: ThemeId;
  mode: Mode;
  /** '' = the theme's own accent, otherwise #rrggbb. */
  accent: string;
  dept: DeptLevel;
  dept_palette: DeptPalette;
  /** Page header and buttons take the department's colour on its pages. */
  dept_tint: boolean;
  sidebar: SidebarMode;
  icons: IconPackId;
  density: Density;
  font: FontSize;
  /** Raum-Modus: 'auto' = on when an XR device is detected (visionOS, Quest, Android XR), 'on' / 'off' = the person's choice. */
  spatial: SpatialMode;
  /** Hidden menu entries (route ids from MODULE_IDS). A view preference, not a permission. */
  hidden: string[];
  /** The starter profile the list came from ('' = hand-picked). */
  profile: string;
  /** The profile choice was offered (and answered or skipped) once. */
  asked: boolean;
  /** Einfach-Modus (areas-model.ts): the goals of "Was willst du tun?" – [] = not chosen (classic full menu), ['all'] = everything. */
  goals: string[];
  /** The goal setup (or the banner offering it to existing logins) was answered or dismissed once. */
  goal_asked: boolean;
  /** Areas the person pinned into the menu / moved under "Mehr" themselves. */
  pinned: string[];
  unpinned: string[];
  /** Profi-Funktionen the person switched on (PRO_KEYS); outside simple mode all of them show. */
  pro: string[];
  /** Own order of tiles and cards per grid (tile-order.ts) – PATCH merges it grid by grid, `{grid: null}` resets one. */
  tile_order: TileOrder;
}

export const PREF_DEFAULTS: Prefs = {
  theme: 'gohigh',
  mode: 'system',
  accent: '',
  dept: 'subtle',
  dept_palette: 'harmonic',
  dept_tint: false,
  sidebar: 'full',
  icons: 'line',
  density: 'normal',
  font: 'normal',
  spatial: 'auto',
  hidden: [],
  profile: '',
  asked: false,
  goals: [],
  goal_asked: false,
  pinned: [],
  unpinned: [],
  pro: [],
  tile_order: {},
};
export const PREF_KEYS = Object.keys(PREF_DEFAULTS) as (keyof Prefs)[];

/** What an agency can fix for its clients' logins (admins are never locked). */
export const LOCK_KEYS = ['theme', 'accent', 'dept', 'sidebar', 'icons', 'density', 'modules'] as const;
export type LockKey = (typeof LOCK_KEYS)[number];
export type Locks = Partial<Record<LockKey, boolean>>;
export const LOCK_LABELS: Record<LockKey, string> = {
  theme: 'Theme und Hell/Dunkel',
  accent: 'Akzentfarbe',
  dept: 'Bereichsfarben',
  sidebar: 'Seitenleiste (voll/schmal)',
  icons: 'Icon-Pack',
  density: 'Dichte und Schriftgröße',
  modules: 'Sichtbare Bereiche',
};
export const LOCK_OF: Record<keyof Prefs, LockKey | null> = {
  theme: 'theme',
  mode: 'theme',
  accent: 'accent',
  dept: 'dept',
  dept_palette: 'dept',
  dept_tint: 'dept',
  sidebar: 'sidebar',
  icons: 'icons',
  density: 'density',
  font: 'density',
  // A property of the device a person wears, not of the agency's brand: never locked.
  spatial: null,
  hidden: 'modules',
  profile: 'modules',
  asked: null,
  goals: 'modules',
  goal_asked: null,
  pinned: null,
  unpinned: null,
  pro: 'modules',
  // how a person arranges their own tiles – nothing an agency fixes
  tile_order: null,
};

const oneOf = <T extends string>(list: readonly T[], v: unknown, label: string): T => {
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T;
  throw new Error(`Ungültiger Wert für ${label}`);
};

/** Colours as #rrggbb (lower case); '' stays '' (= the theme's own). */
export function cleanAccent(v: unknown): string {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  throw new Error('Akzentfarbe als #rrggbb');
}

/**
 * Checks a (partial) set of preferences. Unknown keys are dropped; `null` means "back to the default"
 * and is kept as null so the caller can delete the key. Throws an Error with a German message.
 */
export function cleanPrefs(input: unknown): Partial<{ [K in keyof Prefs]: Prefs[K] | null }> {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of PREF_KEYS) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null) {
      out[key] = null;
      continue;
    }
    switch (key) {
      case 'theme':
        out.theme = oneOf(THEME_IDS, v, 'Theme');
        break;
      case 'mode':
        out.mode = oneOf(MODES, v, 'Modus');
        break;
      case 'accent':
        out.accent = cleanAccent(v);
        break;
      case 'dept':
        out.dept = oneOf(DEPT_LEVELS, v, 'Bereichsfarben');
        break;
      case 'dept_palette':
        out.dept_palette = oneOf(DEPT_PALETTES, v, 'Bereichs-Palette');
        break;
      case 'sidebar':
        out.sidebar = oneOf(SIDEBAR_MODES, v, 'Seitenleiste');
        break;
      case 'icons':
        out.icons = oneOf(ICON_PACKS, v, 'Icon-Pack');
        break;
      case 'density':
        out.density = oneOf(DENSITIES, v, 'Dichte');
        break;
      case 'font':
        out.font = oneOf(FONT_SIZES, v, 'Schriftgröße');
        break;
      case 'spatial':
        out.spatial = oneOf(SPATIAL_MODES, v, 'Raum-Modus');
        break;
      case 'dept_tint':
      case 'asked':
      case 'goal_asked':
        if (typeof v !== 'boolean') throw new Error(`Ungültiger Wert für ${key}`);
        out[key] = v;
        break;
      case 'hidden': {
        if (!Array.isArray(v)) throw new Error('Ausgeblendete Bereiche als Liste');
        // Unknown ids (a menu entry that no longer exists) are dropped, not an error.
        out.hidden = [...new Set(v.map(String).filter((id) => MODULE_IDS.includes(id)))];
        break;
      }
      case 'profile':
        out.profile = v === '' ? '' : oneOf(PROFILE_IDS, v, 'Profil');
        break;
      case 'goals':
      case 'pinned':
      case 'unpinned':
      case 'pro': {
        if (!Array.isArray(v)) throw new Error(`Ungültiger Wert für ${key}`);
        const known: readonly string[] = key === 'goals' ? GOAL_IDS : key === 'pro' ? PRO_KEYS : [...MODULE_IDS, ...ALWAYS_VISIBLE];
        // Unknown ids (an area or feature that no longer exists) are dropped, not an error – like `hidden`.
        out[key] = [...new Set(v.map(String).filter((id) => known.includes(id)))];
        break;
      }
      case 'tile_order':
        // Only the shape here: the grids and keys are checked by the server (cleanTileOrder in services/tile-order.ts, called
        // by modules/appearance.ts) – the browser's look cache does not need it, and its first download stays small.
        if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`Ungültiger Wert für ${key}`);
        out.tile_order = v as TileOrder;
        break;
    }
  }
  return out as Partial<{ [K in keyof Prefs]: Prefs[K] | null }>;
}

/** Keys of a partial set that belong to a locked group. */
export const lockedKeys = (keys: string[], locks: Locks): string[] => keys.filter((k) => { const l = LOCK_OF[k as keyof Prefs]; return !!l && !!locks[l]; });

export function cleanLocks(input: unknown): Locks {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: Locks = {};
  for (const k of LOCK_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  return out;
}

/**
 * What a person sees: the built-in defaults, overlaid by the agency's (or client's) defaults and – for the
 * groups that are not locked – by the person's own choices. Admins are never locked.
 */
export function effectivePrefs(defaults: Partial<Prefs>, own: Partial<Prefs>, locks: Locks, admin: boolean): Prefs {
  const out: Prefs = { ...PREF_DEFAULTS, ...defaults };
  for (const key of PREF_KEYS) {
    if (!(key in own) || own[key] === undefined) continue;
    const lock = LOCK_OF[key];
    if (!admin && lock && locks[lock]) continue;
    (out as any)[key] = own[key];
  }
  return out;
}
