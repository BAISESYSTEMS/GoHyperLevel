import { useSyncExternalStore } from 'react';
import { isSimple, promotedFrom, splitNav } from '../../../server/services/areas-model';
import { api } from '../api';
import { update, useLook } from '../theme/store';

/**
 * The adaptive menu of the Einfach-Modus (server/services/areas-model.ts holds the rules): which areas the sidebar shows
 * and which sit under "Mehr". Visits are counted per person on the server (modules/nav-usage.ts). The counts are read
 * once per browser session and kept in sessionStorage, so an area someone uses a lot moves into the menu at the next
 * session start – never while they work.
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

/** The menu areas in the sidebar (`core`) and under "Mehr" (`more`), from the areas the person may use and has not hidden. */
export function useNavSplit(order: string[], current: string): { simple: boolean; core: string[]; more: string[]; promoted: string[] } {
  const look = useLook();
  const counts = useUsage();
  const p = look.prefs;
  const simple = isSimple(p.goals);
  const input = { order, goals: p.goals, pinned: p.pinned, unpinned: p.unpinned };
  const promoted = simple && counts ? promotedFrom(counts, input) : [];
  return { simple, promoted, ...splitNav({ ...input, promoted, current }) };
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
