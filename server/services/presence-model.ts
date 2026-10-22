/**
 * Live-Zusammenarbeit überall (app-wide presence) as data: which page of the app belongs to which permission area,
 * how a page address is checked, what a person may switch on or off, and when cursors are exchanged. Pure code without
 * Node or browser APIs – the server (modules/presence.ts, services/presence-hub.ts) decides with it and the web app
 * (web/src/presence/*) reads the same tables, so they cannot drift apart. Nothing here is ever stored: presence is live
 * state only (docs/collaboration.md).
 */

/** A tab that has not said "I am here" for this long is gone. */
export const PRESENCE_TTL_MS = 45_000;
/** The browser repeats its heartbeat this often (and on every page change). */
export const HEARTBEAT_MS = 15_000;
/** A hidden tab stops its heartbeat after this long (it then drops out after the TTL). */
export const HIDDEN_PAUSE_MS = 60_000;
/** At most one cursor update per tab in this interval is relayed (the browser bundles its samples). */
export const CURSOR_MIN_MS = 50;
/** Cursor samples one update may carry. */
export const CURSOR_MAX_POINTS = 10;
/** "Saved here" is relayed at most this often per tab. */
export const SAVED_MIN_MS = 2_000;
/** Without input for this long a page counts as no longer being edited. */
export const EDIT_IDLE_MS = 20_000;
/** Deepest cursor position below the top of a page (px). */
export const CURSOR_MAX_Y = 100_000;

export type CursorMode = 'boards' | 'all' | 'off';
export const CURSOR_MODES: CursorMode[] = ['boards', 'all', 'off'];

/** One person's choices (stored per login, the same for every sub-account). */
export interface PresencePrefs {
  /** Nobody sees me: no presence, no cursor, no "saved" notice. I still see the others. */
  invisible: boolean;
  /** Avatars of colleagues next to the menu entries ("Team im Menü zeigen"). */
  menu: boolean;
  /** Other people's cursors: only on Canvas and Living Boards (default), on every page, or never. Mine go only where theirs come back. */
  cursors: CursorMode;
}
export const PRESENCE_DEFAULTS: PresencePrefs = { invisible: false, menu: true, cursors: 'boards' };

/** Validates a change of the preferences; unknown keys are ignored, wrong values throw. */
export function cleanPresencePrefs(input: unknown): Partial<PresencePrefs> {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Partial<PresencePrefs> = {};
  for (const k of ['invisible', 'menu'] as const) {
    if (!(k in src)) continue;
    if (typeof src[k] !== 'boolean') throw new Error(`${k} muss wahr oder falsch sein`);
    out[k] = src[k] as boolean;
  }
  if ('cursors' in src) {
    if (!CURSOR_MODES.includes(src.cursors as CursorMode)) throw new Error('cursors muss boards, all oder off sein');
    out.cursors = src.cursors as CursorMode;
  }
  return out;
}

/** Stored preferences (or a damaged row) with the defaults filled in. */
export function presencePrefsOf(stored: unknown): PresencePrefs {
  try {
    return { ...PRESENCE_DEFAULTS, ...cleanPresencePrefs(stored) };
  } catch {
    return { ...PRESENCE_DEFAULTS };
  }
}

/**
 * Pages of the app (first path segment below /app) and their permission area – the same areas as the menu in
 * web/src/main.tsx (tests/presence.test.ts keeps both in step). `*` = everybody signed in, `admin` = agency admins only.
 * A colleague's page is shown to somebody only if they may open that area; unknown pages show as "online".
 *
 * `own`: the page has realtime of its own (inbox conversations, Canvas, Team-Chat, Living Boards) – no global
 * "saved"/"editing too" banners there, the avatars in the top bar stay. `cursor`: `own` = the page draws its own cursors
 * (Canvas), `board` = cursors relative to the page's `[data-presence-surface]` element and on by default (Living Boards).
 */
export interface PresenceRoute {
  area: string;
  own?: true;
  cursor?: 'own' | 'board';
}
export const PRESENCE_ROUTES: Record<string, PresenceRoute> = {
  agency: { area: 'admin' },
  dashboard: { area: 'dashboard' },
  boards: { area: 'dashboard', own: true, cursor: 'board' },
  workspace: { area: 'dashboard' },
  reports: { area: 'dashboard' },
  project: { area: 'dashboard' },
  attribution: { area: 'dashboard' },
  conversations: { area: 'conversations', own: true },
  calls: { area: 'conversations' },
  calendars: { area: 'calendars' },
  contacts: { area: 'contacts' },
  companies: { area: 'contacts' },
  objects: { area: 'contacts' },
  tasks: { area: 'contacts' },
  pm: { area: 'contacts' },
  time: { area: 'contacts' },
  'lead-scoring': { area: 'contacts' },
  properties: { area: 'settings' },
  opportunities: { area: 'opportunities' },
  sales: { area: 'opportunities' },
  canvas: { area: 'canvas', own: true, cursor: 'own' },
  wiki: { area: 'wiki' },
  office: { area: 'office' },
  'team-chat': { area: 'teamchat', own: true },
  tickets: { area: 'helpdesk' },
  'help-center': { area: 'helpdesk' },
  surveys: { area: 'helpdesk' },
  campaigns: { area: 'campaigns' },
  ads: { area: 'campaigns' },
  workflows: { area: 'workflows' },
  social: { area: 'social' },
  'video-studio': { area: 'social' },
  'ki-studio': { area: 'social' },
  'ai-studio': { area: 'funnels' },
  'comment-dm': { area: 'social' },
  webinars: { area: 'funnels' },
  funnels: { area: 'funnels' },
  forms: { area: 'forms' },
  courses: { area: 'courses' },
  quizzes: { area: 'courses' },
  community: { area: 'courses' },
  invoices: { area: 'payments' },
  contracts: { area: 'payments' },
  products: { area: 'payments' },
  'payment-plans': { area: 'payments' },
  dunning: { area: 'payments' },
  sepa: { area: 'payments' },
  shop: { area: 'payments' },
  'gift-cards': { area: 'payments' },
  affiliates: { area: 'payments' },
  calc: { area: 'payments' },
  profit: { area: 'payments' },
  reviews: { area: 'reviews' },
  accounting: { area: 'accounting' },
  inventory: { area: 'inventory' },
  // The menu shows "Personal" to every employee (own record only); a colleague's whereabouts there only to HR staff.
  personal: { area: 'personal' },
  agents: { area: '*' },
  werkstatt: { area: '*' },
  marktplatz: { area: '*' },
  academy: { area: '*' },
  trash: { area: '*' },
  feedback: { area: '*' },
  wishes: { area: '*' },
  apps: { area: 'settings' },
  umzug: { area: 'settings' },
  settings: { area: 'settings' },
};

const PAGE_RE = /^[A-Za-z0-9/_\-.:~]+$/;

/** A page address as the browser reports it (`/contacts/abc`, below /app): query and hash cut off, then strictly checked. */
export function cleanPage(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const page = v.split(/[?#]/)[0];
  if (!page.startsWith('/') || page.length > 200 || !PAGE_RE.test(page) || page.includes('//') || /(^|\/)\.\.?(\/|$)/.test(page)) return null;
  return page;
}

/** First segment of a page (`/contacts/abc` → `contacts`; `/` → ''). */
export const routeOf = (page: string): string => page.split('/')[1] ?? '';
export const routeInfo = (page: string): PresenceRoute | undefined => (Object.prototype.hasOwnProperty.call(PRESENCE_ROUTES, routeOf(page)) ? PRESENCE_ROUTES[routeOf(page)] : undefined);
export const areaOf = (page: string): string | undefined => routeInfo(page)?.area;

/** Does the page run realtime of its own (no global banners)? */
export const ownPresence = (page: string): boolean => !!routeInfo(page)?.own;

/** Where cursors are exchanged: `board` (Living Boards), `page` (every other page), `none` (Canvas draws its own). */
export function cursorKind(page: string): 'board' | 'page' | 'none' {
  const c = routeInfo(page)?.cursor;
  return c === 'own' ? 'none' : c === 'board' ? 'board' : 'page';
}

/** Whether a person with this setting exchanges cursors on the page. */
export function cursorsOn(mode: CursorMode, page: string): boolean {
  const kind = cursorKind(page);
  if (kind === 'none' || mode === 'off') return false;
  return kind === 'board' || mode === 'all';
}

/** May somebody with these rights see that a colleague is on this page? (admins: everything; unknown pages: no) */
export function maySeePage(u: { role: string; permissions: string[] | null }, page: string): boolean {
  const area = areaOf(page);
  if (!area) return false;
  if (u.role === 'admin') return true;
  if (area === 'admin') return false;
  if (area === '*') return true;
  return !u.permissions || u.permissions.includes(area);
}

/** Cursor x: share of the surface's width (0…1). */
export function clampX(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;
}
/** Cursor y: pixels below the top of the surface, scroll included. */
export function clampY(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(CURSOR_MAX_Y, Math.max(0, n)));
}

/** Cursor samples of one update: `pts: [[x, y], …]` or a single `x`/`y`; invalid samples are dropped. */
export function cleanCursor(body: { x?: unknown; y?: unknown; pts?: unknown }): [number, number][] {
  const raw: unknown[] = Array.isArray(body.pts) ? body.pts.slice(0, CURSOR_MAX_POINTS) : body.x !== undefined || body.y !== undefined ? [[body.x, body.y]] : [];
  const out: [number, number][] = [];
  for (const p of raw) {
    if (!Array.isArray(p)) continue;
    const x = clampX(p[0]);
    const y = clampY(p[1]);
    if (x !== null && y !== null) out.push([x, y]);
  }
  return out;
}

export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
