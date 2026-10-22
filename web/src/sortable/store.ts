import { useSyncExternalStore } from 'react';
import { GRID_RE, mergeTileOrder, mergeVisible, sameOrder, trimTileOrder, type TileOrder, type TileOrderPatch } from '../../../server/services/tile-order';
import { ApiError, api } from '../api';

/**
 * The person's own order of tiles per grid (docs/theming.md#kacheln-sortieren): kept on the server in the appearance
 * preferences (`tile_order`, so it follows the person to every device) and in this browser's storage (so it shows at once
 * and survives being offline). Changes made here are "dirty" until the server confirmed them; a server copy that arrives in
 * the meantime never overwrites them, and they are sent again when the browser is back online.
 */

const LS = 'pghl.tile-order';

let user = '';
let orders: TileOrder = {};
let dirty = new Set<string>();
let lastServer: unknown = null;
/**
 * The copies the look store handed over (look.prefs.tile_order, one object per GET/PATCH /api/appearance answer). Each is
 * taken once: every grid that mounts later hands over the same – by then older – object again, and taking it a second
 * time would undo every order saved since (this store saves through its own PATCH, which the look store never sees).
 */
let seenLook = new WeakSet<object>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** One PATCH at a time, so the server never applies an older order after a newer one. */
let sending = false;
let again = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

const storageKey = () => `${LS}:${user || 'anon'}`;

function readLocal(): { o: TileOrder; d: string[] } {
  try {
    const raw = localStorage.getItem(storageKey());
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { o: {}, d: [] };
    // grid by grid: one that does not fit the rules (or the limits) is skipped, never the whole copy and its unsent changes
    const o = trimTileOrder(parsed.o);
    // (an unsent grid id the server would refuse would take every other unsent change down with it)
    return { o, d: Array.isArray(parsed.d) ? parsed.d.filter((g: unknown): g is string => typeof g === 'string' && GRID_RE.test(g)) : [] };
  } catch {
    return { o: {}, d: [] };
  }
}

function writeLocal() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ v: 1, o: orders, d: [...dirty] }));
  } catch {
    /* storage blocked or full: the order lives on the server and in this tab */
  }
}

/** Which login the orders belong to (each person on a shared browser keeps their own). */
export function bindUser(id: string) {
  if (id === user) return;
  user = id;
  const local = readLocal();
  orders = local.o;
  dirty = new Set(local.d);
  lastServer = null;
  // called while a grid renders: tell the other subscribers afterwards, not during that render
  queueMicrotask(emit);
  if (dirty.size) schedule();
}

/**
 * The look store's copy of the server's orders (look.prefs.tile_order, web/src/theme/store.ts): taken once per answer, see
 * seenLook – a grid mounting later with the same object changes nothing.
 */
export function adoptLook(map: TileOrder | undefined | null) {
  if (!map || typeof map !== 'object' || seenLook.has(map)) return;
  seenLook.add(map);
  adoptServer(map);
}

/** The server's copy (from GET/PATCH /api/appearance): it wins, except for grids changed here and not sent yet. */
export function adoptServer(map: TileOrder | undefined | null) {
  if (!map || map === lastServer) return;
  lastServer = map;
  const next: TileOrder = {};
  for (const [g, list] of Object.entries(map)) if (Array.isArray(list)) next[g] = list;
  for (const g of dirty) {
    if (orders[g]) next[g] = orders[g];
    else delete next[g];
  }
  orders = next;
  writeLocal();
  emit();
}

function schedule(delay = 400) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush(), delay);
}

async function flush() {
  timer = undefined;
  if (!dirty.size || !user) return;
  if (sending) {
    again = true;
    return;
  }
  sending = true;
  const body: TileOrderPatch = {};
  for (const g of dirty) body[g] = orders[g] ?? null;
  try {
    const r = await api.patch<{ prefs?: { tile_order?: TileOrder } }>('/api/appearance', { tile_order: body });
    for (const [g, sent] of Object.entries(body)) {
      const now = orders[g] ?? null;
      if (now === sent || (now && sent && sameOrder(now, sent))) dirty.delete(g);
    }
    writeLocal();
    adoptServer({ ...(r?.prefs?.tile_order ?? {}) });
  } catch (e) {
    // The server refused the change itself (demo, validation): keep it in this browser only, do not try forever.
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
      dirty.clear();
      writeLocal();
    }
    /* otherwise offline or a server hiccup: stays dirty, sent again on "online" or with the next change */
  } finally {
    sending = false;
    if (again) {
      again = false;
      schedule(0);
    }
  }
}

if (typeof window !== 'undefined') window.addEventListener('online', () => dirty.size && schedule(0));

export const getOrder = (grid: string): string[] | undefined => orders[grid];

export function useSavedOrder(grid: string): string[] | undefined {
  return useSyncExternalStore(subscribe, () => orders[grid]);
}

/**
 * Saves how the person arranged the tiles a grid shows (`visible`, all of them in their new order). `natural` is the order
 * the grid would show without a saved one: arranging back to it with nothing else remembered drops the saved order.
 */
export function saveOrder(grid: string, visible: string[], natural: string[]) {
  const prev = orders[grid];
  const merged = mergeVisible(prev, visible);
  if (sameOrder(visible, natural) && merged.length === visible.length) setGrid(grid, null);
  else setGrid(grid, merged);
}

/** Back to the natural order ("Reihenfolge zurücksetzen"). */
export const resetOrder = (grid: string) => setGrid(grid, null);

function setGrid(grid: string, list: string[] | null) {
  // the server's rule (newest last, beyond the limits the grids changed longest ago go), so the browser's copy never
  // grows past what the server – and the next readLocal – accepts
  const next = mergeTileOrder(orders, { [grid]: list });
  for (const g of Object.keys(orders)) if (!(g in next)) dirty.add(g);
  orders = next;
  dirty.add(grid);
  writeLocal();
  emit();
  schedule();
}

/** For tests: forget everything (no storage, no server). */
export function _resetForTests() {
  user = '';
  orders = {};
  dirty = new Set();
  lastServer = null;
  seenLook = new WeakSet();
  sending = false;
  again = false;
  if (timer) clearTimeout(timer);
  timer = undefined;
  emit();
}
