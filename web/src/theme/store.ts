import { useSyncExternalStore } from 'react';
import { PREF_DEFAULTS, PREF_KEYS, cleanPrefs, type Locks, type Prefs } from '../../../server/services/appearance-model';
import { api } from '../api';
import { registerIconPack, setIconPack } from '../icons';
import { toastError } from '../ui';
import { currentXr, spatialActive } from '../xr/detect';
import { buildBoth, modeTokens, type LookInput } from './css';

/**
 * The look of this browser: the effective preferences (from the server, cached in localStorage so that
 * web/public/theme-boot.js can paint the right colours before React starts), the locks the agency set,
 * and the function that puts it all on the page (attributes on <html> + one generated <style>).
 *
 *   html[data-theme="light|dark"]   resolved mode (also what styles.css' dark rules key on)
 *   html[data-theme-id], data-dept-mode, data-dept-tint, data-sidebar, data-density, data-font, data-icons
 *   html[data-spatial="1"]          Raum-Modus (headsets, glasses: docs/xr.md) – data-density is "comfortable" while it is on
 *   <style id="pghl-theme">         the theme's CSS variables (css.ts)
 */

export const LOOK_KEY = 'pghl.look';
const LEGACY_KEY = 'pghl.theme';
const SHOW_ALL_KEY = 'pghl.show-all';

interface State {
  prefs: Prefs;
  /** The agency/client defaults (what "zurücksetzen" goes back to). */
  defaults: Partial<Prefs>;
  locks: Locks;
  /** Offer the starter profiles (new account, not answered yet). */
  offerProfiles: boolean;
  /** Offer the Einfach-Modus once to an existing login (banner). */
  offerGoals: boolean;
  loaded: boolean;
  showAll: boolean;
  brandColor: string;
}

const readLocal = (key: string, area: 'local' | 'session' = 'local'): string | null => {
  try {
    return (area === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
};
const writeLocal = (key: string, value: string | null, area: 'local' | 'session' = 'local') => {
  try {
    const s = area === 'local' ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage blocked: the look just is not remembered in this browser */
  }
};

/** Cached preferences of this browser (validated: an old or damaged cache falls back to the defaults). */
function cachedPrefs(): Prefs {
  const out: Prefs = { ...PREF_DEFAULTS };
  const raw = readLocal(LOOK_KEY);
  try {
    const p = raw ? JSON.parse(raw).p : undefined;
    if (p && typeof p === 'object')
      for (const k of PREF_KEYS) {
        // The tile order is never cached here (shared by everyone on this browser): web/src/sortable keeps it per login.
        if (k === 'tile_order') continue;
        // Key by key, so one damaged value does not throw the rest away.
        try {
          const v = cleanPrefs({ [k]: p[k] })[k];
          if (k in p && v !== null && v !== undefined) (out as any)[k] = v;
        } catch {
          /* keep the default */
        }
      }
  } catch {
    /* ignore */
  }
  if (!raw) {
    // Before this version the account page kept "light"/"dark" under this key.
    const legacy = readLocal(LEGACY_KEY);
    if (legacy === 'light' || legacy === 'dark') out.mode = legacy;
  }
  return out;
}

let state: State = { prefs: cachedPrefs(), defaults: {}, locks: {}, offerProfiles: false, offerGoals: false, loaded: false, showAll: readLocal(SHOW_ALL_KEY, 'session') === '1', brandColor: '' };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

const dark = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : false);
export const resolveDark = (mode: Prefs['mode']) => (mode === 'dark' ? true : mode === 'light' ? false : dark());

/** Is the Raum-Modus on? "auto" follows the device (visionOS, Quest, Android XR …), "on" and "off" are the person's word. */
export const spatialOf = (p: Prefs) => spatialActive(p.spatial, currentXr());

const lookOf = (p: Prefs, brandColor: string): LookInput => ({ theme: p.theme, accent: p.accent, palette: p.dept_palette, brandColor, spatial: spatialOf(p) });

function styleEl(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById('pghl-theme') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'pghl-theme';
    document.head.appendChild(el);
  }
  return el;
}

/** Puts a set of preferences on the page and remembers it for the next first paint. */
export function applyLook(p: Prefs, brandColor = state.brandColor, remember = true) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const isDark = resolveDark(p.mode);
  const spatial = spatialOf(p);
  const css = buildBoth(lookOf(p, brandColor));
  root.dataset.theme = isDark ? 'dark' : 'light';
  root.dataset.themeId = p.theme;
  root.dataset.deptMode = p.dept;
  root.dataset.deptTint = p.dept_tint ? '1' : '0';
  root.dataset.sidebar = p.sidebar;
  root.dataset.spatial = spatial ? '1' : '0';
  // The Raum-Modus builds on the roomy density (its tokens in xr/spatial.css make it roomier still).
  root.dataset.density = spatial ? 'comfortable' : p.density;
  root.dataset.font = p.font;
  root.dataset.icons = p.icons;
  const el = styleEl();
  if (el) el.textContent = isDark ? css.dark : css.light;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', modeTokens(p.theme, isDark).side);
  // Without the tile order: this cache is shared by everyone on the browser and outlives a logout; web/src/sortable/store.ts
  // keeps the order per login.
  const { tile_order: _order, ...cached } = p;
  if (remember) writeLocal(LOOK_KEY, JSON.stringify({ v: 1, p: cached, css, spatial, side: { light: modeTokens(p.theme, false).side, dark: modeTokens(p.theme, true).side } }));
  // The styles of the mode are a chunk of their own: nobody who does not wear a headset downloads them.
  if (spatial) void import('../xr/spatial');
  setIconPack(p.icons);
  if (p.icons === 'solid') void import('./packs/solid').then((m) => registerIconPack('solid', m.SOLID));
}

function set(next: Partial<State>, apply = true) {
  const prefs = next.prefs ?? state.prefs;
  const brandColor = next.brandColor ?? state.brandColor;
  state = { ...state, ...next };
  if (apply) applyLook(prefs, brandColor);
  emit();
}

// --- reading -----------------------------------------------------------------------------------------

export const getPrefs = () => state.prefs;
export const getLocks = () => state.locks;
export const usePrefs = (): Prefs => useSyncExternalStore(subscribe, () => state.prefs);
/** True while the Raum-Modus is on (controls that only make sense there – "Verschieben nach …" – render from this). */
export const useSpatial = (): boolean => useSyncExternalStore(subscribe, () => spatialOf(state.prefs));
export const useLook = (): State => useSyncExternalStore(subscribe, () => state);

/** Is a menu entry shown? Hidden ones come back with "Alle Bereiche anzeigen". */
export const isModuleVisible = (route: string, s: Pick<State, 'prefs' | 'showAll'> = state) => s.showAll || !s.prefs.hidden.includes(route);

export function useModules() {
  const s = useLook();
  return { visible: (route: string) => isModuleVisible(route, s), hidden: s.prefs.hidden, showAll: s.showAll };
}

export function setShowAll(on: boolean) {
  writeLocal(SHOW_ALL_KEY, on ? '1' : null, 'session');
  set({ showAll: on }, false);
}

export function setBrandColor(color: string) {
  if (color !== state.brandColor) set({ brandColor: color });
}

// --- server ------------------------------------------------------------------------------------------

interface Answer {
  prefs: Partial<Prefs>;
  /** Everything but the tile order, which the server sends once, in `prefs`. */
  effective: Omit<Prefs, 'tile_order'> & Partial<Pick<Prefs, 'tile_order'>>;
  defaults: Partial<Prefs>;
  locks: Locks;
  offer_profiles: boolean;
  offer_goals?: boolean;
}

function take(r: Answer) {
  // Every answer brings a new tile_order object: web/src/sortable takes each one once as the server's newest copy.
  const prefs: Prefs = { ...PREF_DEFAULTS, ...r.effective, tile_order: r.prefs?.tile_order ?? {} };
  set({ prefs, defaults: r.defaults, locks: r.locks, offerProfiles: r.offer_profiles, offerGoals: !!r.offer_goals, loaded: true });
}

/** After sign-in: the effective look from the server replaces the cached one. */
export async function loadAppearance(): Promise<void> {
  try {
    const r = await api.get<Answer>('/api/appearance');
    take(r);
    // The old account page kept light/dark only in this browser: carry it over once.
    const legacy = readLocal(LEGACY_KEY);
    if (legacy) {
      writeLocal(LEGACY_KEY, null);
      if ((legacy === 'light' || legacy === 'dark') && r.prefs.mode === undefined && !r.locks.theme) void update({ mode: legacy });
    }
  } catch {
    /* offline or not signed in: the cached look stays */
  }
}

/** Login page: the agency's default look for visitors who have no cached one. */
export async function loadPublicAppearance(): Promise<void> {
  if (readLocal(LOOK_KEY)) return;
  try {
    const r = await api.get<{ effective: Prefs }>('/api/appearance/public');
    set({ prefs: { ...PREF_DEFAULTS, ...r.effective } });
  } catch {
    /* defaults */
  }
}

let pending: Record<string, unknown> = {};
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  const body = pending;
  pending = {};
  timer = undefined;
  if (!Object.keys(body).length) return;
  try {
    take(await api.patch<Answer>('/api/appearance', body));
  } catch (e) {
    toastError(e);
    // Back to what the server has.
    void loadAppearance();
  }
}

/**
 * Changes preferences: the page follows at once, the server and the browser cache a moment later.
 * `null` puts a key back to the default (the agency's, if it set one).
 */
export function update(patch: { [K in keyof Prefs]?: Prefs[K] | null }, delay = 0): Promise<void> {
  const next: Prefs = { ...state.prefs };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as keyof Prefs;
    (next as any)[key] = v === null ? (state.defaults[key] ?? PREF_DEFAULTS[key]) : v;
  }
  set({ prefs: next });
  Object.assign(pending, patch);
  if (timer) clearTimeout(timer);
  if (delay > 0) {
    timer = setTimeout(() => void flush(), delay);
    return Promise.resolve();
  }
  return flush();
}

/** Narrow ↔ wide (a no-op when the agency fixed the sidebar for this login). */
export const toggleSidebar = () => (state.locks.sidebar ? Promise.resolve() : update({ sidebar: state.prefs.sidebar === 'rail' ? 'full' : 'rail' }));

// --- system dark mode --------------------------------------------------------------------------------

if (typeof matchMedia === 'function') {
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.prefs.mode === 'system' && applyLook(state.prefs));
  } catch {
    /* old browsers */
  }
}
// Same attributes as the boot script (idempotent), now with the full CSS.
if (typeof document !== 'undefined') applyLook(state.prefs, '', false);
