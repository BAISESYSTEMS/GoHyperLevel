/**
 * Own order of tiles and cards ("Kacheln per Drag & Drop sortieren", docs/theming.md#kacheln-sortieren) as pure data code:
 * what the person's preference `tile_order` may hold, how a saved order is laid over the tiles a grid shows right now, and
 * how a new order is merged into the saved one. No Node or browser APIs – the server (appearance-model.ts → PATCH
 * /api/appearance) and the web app (web/src/sortable/*) share it, so both check the same rules.
 *
 *   tile_order = { [gridId]: string[] }   e.g. { "dashboard.stats": ["won", "contacts", "pipeline"] }
 *
 * A grid id names one arrangement (a page's row of key figures, the agency's project cards …); the keys are the tiles' own
 * stable keys (React keys: an id, a widget name, or "#3" for the fourth tile of a fixed row).
 */

/**
 * How many grids one person may keep an order for (well above the ~90 grids the app has, so arranging every one of them
 * never pushes another out), how many tiles one order may hold, and how big all orders of one person may be together
 * (characters of JSON, ~128 KB – it travels with every GET/PATCH /api/appearance and sits in the browser's storage).
 */
export const MAX_GRIDS = 200;
export const MAX_KEYS = 200;
export const MAX_CHARS = 128 * 1024;

/** Grid ids are chosen in code: "dashboard.stats", "agency.projects", "tickets.workload". */
export const GRID_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
/** Tile keys: ids, names and "#n" positions – letters (any script), digits, space and a few joiners, at most 120 characters. */
export const KEY_RE = /^[\p{L}\p{N}\p{M} _#:./@+=~!&(),'-]{1,120}$/u;

export type TileOrder = Record<string, string[]>;
/** A change as sent to PATCH /api/appearance: a grid's new order, or null = back to the natural order. */
export type TileOrderPatch = Record<string, string[] | null>;

/** A key that fits KEY_RE: kept as it is, otherwise replaced by a short stable hash (the same text always gives the same key). */
export function safeKey(key: string): string {
  if (KEY_RE.test(key)) return key;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h${(h >>> 0).toString(36)}`;
}

/**
 * Checks `tile_order` as sent or stored. `null` for a grid means "delete this grid's order" and is kept for the caller.
 * Throws an Error with a German message for anything else that does not fit (wrong types, unknown characters, too much).
 */
export function cleanTileOrder(input: unknown): TileOrderPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Kachel-Reihenfolge als Objekt { Raster: [Schlüssel …] }');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_GRIDS) throw new Error(`Höchstens ${MAX_GRIDS} Kachel-Reihenfolgen`);
  const out: TileOrderPatch = {};
  for (const [grid, list] of entries) {
    if (!GRID_RE.test(grid)) throw new Error('Ungültige Raster-ID für die Kachel-Reihenfolge');
    if (list === null) {
      out[grid] = null;
      continue;
    }
    if (!Array.isArray(list)) throw new Error('Kachel-Reihenfolge als Liste von Schlüsseln');
    if (list.length > MAX_KEYS) throw new Error(`Höchstens ${MAX_KEYS} Kacheln je Reihenfolge`);
    const seen = new Set<string>();
    for (const k of list) {
      if (typeof k !== 'string' || !KEY_RE.test(k)) throw new Error('Ungültiger Kachel-Schlüssel');
      seen.add(k);
    }
    out[grid] = [...seen];
  }
  if (JSON.stringify(out).length > MAX_CHARS) throw new Error('Kachel-Reihenfolgen zu groß');
  return out;
}

/**
 * A stored copy (the server's user_prefs, the browser's storage) made to fit the rules without throwing: grids and keys that
 * do not fit are skipped one by one, never the whole set, and beyond the limits the grids changed longest ago go first – so an
 * older or damaged copy, or one written under other limits, keeps everything it still can.
 */
export function trimTileOrder(input: unknown): TileOrder {
  const out: TileOrder = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [grid, list] of Object.entries(input as Record<string, unknown>)) {
    if (!GRID_RE.test(grid) || !Array.isArray(list)) continue;
    const keys = [...new Set(list.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)))].slice(0, MAX_KEYS);
    if (keys.length) out[grid] = keys;
  }
  return fitGrids(out);
}

/** Drops the oldest grids (first in insertion order) until at most MAX_GRIDS remain and all of them fit into MAX_CHARS. */
function fitGrids(out: TileOrder): TileOrder {
  const grids = Object.keys(out);
  const over = Math.max(0, grids.length - MAX_GRIDS);
  for (const g of grids.slice(0, over)) delete out[g];
  let size = JSON.stringify(out).length;
  for (const g of grids.slice(over)) {
    if (size <= MAX_CHARS) break;
    // "grid":[…] plus the comma between entries
    size -= JSON.stringify(g).length + JSON.stringify(out[g]).length + 2;
    delete out[g];
  }
  return out;
}

/**
 * Applies a change to the stored orders: a list replaces that grid's order (and makes it the most recent one), null deletes
 * it, grids the change does not name stay. Beyond MAX_GRIDS or MAX_CHARS the grids changed longest ago go first. The server
 * (PATCH /api/appearance) and the browser's store apply the same rule, so both drop the same grids.
 */
export function mergeTileOrder(stored: TileOrder | undefined, patch: TileOrderPatch): TileOrder {
  const out: TileOrder = { ...(stored ?? {}) };
  for (const [grid, list] of Object.entries(patch)) {
    delete out[grid];
    if (list) out[grid] = list;
  }
  return fitGrids(out);
}

/**
 * The order a grid shows: the saved keys that still exist, in the saved order, then the tiles the saved order does not know
 * yet (new ones) at the end in their natural order. Keys of tiles that are gone are simply skipped.
 */
export function applyOrder(saved: readonly string[] | undefined | null, keys: readonly string[]): string[] {
  if (!saved?.length) return [...keys];
  const present = new Set(keys);
  const out: string[] = [];
  const used = new Set<string>();
  for (const k of saved) {
    if (present.has(k) && !used.has(k)) {
      out.push(k);
      used.add(k);
    }
  }
  for (const k of keys) if (!used.has(k)) out.push(k);
  return out;
}

/** Moves the entry at `from` to `to` (both clamped); a new array, the input stays as it is. */
export function moveKey<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}

/** Same keys in the same order. */
export const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * The order to save after the person arranged the tiles a grid shows right now (`visible`): tiles the grid does not show at
 * the moment – hidden by a filter, behind "Mehr anzeigen", or only shown in Einfach-Modus – keep their place right behind the
 * tile that stood before them, so arranging a filtered view does not throw the rest of the order away.
 *
 * At most MAX_KEYS: the tiles on screen always stay; beyond the limit the hidden tiles ranked last go first (records that
 * were deleted, tiles of earlier Fokus answers or of other sub-accounts pile up here). One of them that shows up again just
 * appears at the end – about where it was ranked anyway.
 */
export function mergeVisible(saved: readonly string[] | undefined | null, visible: readonly string[]): string[] {
  const out = [...new Set(visible)];
  const shown = new Set(out);
  if (saved?.length) {
    const inOut = new Set(out);
    for (let i = 0; i < saved.length; i++) {
      const k = saved[i];
      if (inOut.has(k)) continue;
      // behind the nearest earlier key of the saved order that is already placed, or first when there is none
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const p = out.indexOf(saved[j]);
        if (p >= 0) {
          at = p + 1;
          break;
        }
      }
      out.splice(at, 0, k);
      inOut.add(k);
    }
  }
  let extra = out.length - MAX_KEYS;
  if (extra <= 0) return out;
  const drop = new Set<number>();
  for (let i = out.length - 1; i >= 0 && extra > 0; i--)
    if (!shown.has(out[i])) {
      drop.add(i);
      extra--;
    }
  // a grid that shows more than MAX_KEYS tiles itself keeps the first ones
  return out.filter((_, i) => !drop.has(i)).slice(0, MAX_KEYS);
}

/**
 * A React key (as React.Children.toArray hands it out) → the tile's key: an explicit key stays as written ("won",
 * "plugin:widget"), an implicit one becomes its position ("#3", "#1/#0" in a nested list).
 */
export function tileKey(raw: string | number | bigint | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const segs = String(raw).split(':');
  const one = (s: string) => {
    const explicit = /^\.?\$/.test(s);
    const body = s.replace(/^\.?\$?/, '');
    return explicit ? body.replace(/=[02]/g, (m) => (m === '=0' ? '=' : ':')) : `#${body}`;
  };
  const last = segs[segs.length - 1];
  return /^\.?\$/.test(last) ? one(last) : segs.map(one).join('/');
}
