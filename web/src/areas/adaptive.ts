import { useSyncExternalStore } from 'react';
import { isSimple, promotedFrom, splitNav } from '../../../server/services/areas-model';
import { api } from '../api';
import { update, useLook } from '../theme/store';

/**
 * The menu of the Einfach-Modus (server/services/areas-model.ts holds the rules): which areas the sidebar shows and which
 * sit under "Mehr". Predictable since 1.0.73: the menu only changes when the person pins or unpins something. Visits are
 * counted per person on the server (modules/nav-usage.ts) and read once per browser session (sessionStorage); an area
 * under "Mehr" that someone uses a lot becomes a *suggestion* ("Oft genutzt – anheften?") at the top of the "Mehr" panel –
 * it never moves into the menu by itself. An open page that is not in the menu shows in one fixed place above "Mehr"
 * instead of being slotted into the list (which made the entries below it jump on every visit).
 */

const SNAP_KEY = 'pghl.nav.usage';
let usage: Record<string, number> | null = readSnap();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
const emit = () => listeners.forEach((f) => f());

function readSnap(): Record<string, number> | null {
  try {
    const raw = sessionStorage.getItem(SNAP_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : null;
  } catch {
    return null;
  }
}

/** Session start (first page load of this browser session after sign-in): read the counts once. */
export async function startNavSession(): Promise<void> {
  if (usage) return;
  try {
    const r = await api.get<{ usage: Record<string, number> }>('/api/nav/usage');
    usage = r.usage ?? {};
    try {
      sessionStorage.setItem(SNAP_KEY, JSON.stringify(usage));
    } catch {
      /* storage blocked: counted again next load */
    }
    emit();
  } catch {
    usage = {};
  }
}

// --- counting visits ----------------------------------------------------------------------------------------------

let pending: Record<string, number> = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let lastRoute = '';

async function flush() {
  timer = undefined;
  const visits = pending;
  pending = {};
  if (!Object.keys(visits).length) return;
  await api.post('/api/nav/usage', { visits }).catch(() => {
    /* offline: these visits are not counted – it is only a hint for the menu */
  });
}

/** One visit of a menu area (the shell calls it when the first part of the address changes). */
export function trackVisit(route: string) {
  if (!route || route === lastRoute) return;
  lastRoute = route;
  pending[route] = (pending[route] ?? 0) + 1;
  timer ??= setTimeout(() => void flush(), 30_000);
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function')
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush());

// --- the split ------------------------------------------------------------------------------------------------------

const useUsage = () => useSyncExternalStore(subscribe, () => usage);

/**
 * The menu areas in the sidebar (`core`) and under "Mehr" (`more`), from the areas the person may use and has not hidden.
 * `promoted` = areas under "Mehr" used often – only suggested in the "Mehr" panel, never added to `core`. `here` = the open
 * page when it is not in the menu (the sidebar shows it in a fixed slot above "Mehr", so the list itself never moves).
 */
export function useNavSplit(order: string[], current: string): { simple: boolean; core: string[]; more: string[]; promoted: string[]; here: string | null } {
  const look = useLook();
  const counts = useUsage();
  const p = look.prefs;
  const simple = isSimple(p.goals);
  const input = { order, goals: p.goals, pinned: p.pinned, unpinned: p.unpinned };
  const promoted = simple && counts ? promotedFrom(counts, input) : [];
  const split = splitNav({ ...input, promoted: [] });
  const here = simple && current && split.more.includes(current) && current !== 'settings' ? current : null;
  return { simple, promoted, here, ...split };
}

/** Pin an area into the menu, or move it under "Mehr" (unpin). */
export function setPinned(route: string, pinned: boolean, prefs: { pinned: string[]; unpinned: string[] }) {
  const pin = new Set(prefs.pinned);
  const unpin = new Set(prefs.unpinned);
  if (pinned) {
    pin.add(route);
    unpin.delete(route);
  } else {
    pin.delete(route);
    unpin.add(route);
  }
  return update({ pinned: [...pin], unpinned: [...unpin] });
}
