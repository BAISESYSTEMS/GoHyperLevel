/**
 * Living Boards: the responsive grid. Pure maths shared by the server (validation, placing new widgets, the same
 * layout for every viewer) and the browser (live drag and resize) – no imports, nothing that touches the app.
 *
 * A board has three layouts per widget, one per breakpoint (the width of the board itself, not of the window):
 *   lg – 12 columns, the layout people arrange
 *   md – 6 columns, derived from lg until someone arranges it on a tablet
 *   sm – 1 column (a stack in reading order), derived until someone reorders it on a phone
 * Every function is deterministic, so the server and every browser end up with the same picture.
 */

export type Bp = 'lg' | 'md' | 'sm';
export const BREAKPOINTS: Bp[] = ['lg', 'md', 'sm'];
export const COLS: Record<Bp, number> = { lg: 12, md: 6, sm: 1 };
/** Width of the board (px) from which a breakpoint applies. */
export const BP_MIN: Record<Bp, number> = { lg: 900, md: 560, sm: 0 };
export const bpFor = (width: number): Bp => (width >= BP_MIN.lg ? 'lg' : width >= BP_MIN.md ? 'md' : 'sm');
/** One grid row in pixels and the gap between cells. */
export const ROW_H = 84;
export const GAP = 14;

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Placed extends Cell {
  id: string;
}
export interface Limits {
  minW: number;
  minH: number;
  maxW: number;
  maxH: number;
}
export const DEFAULT_LIMITS: Limits = { minW: 2, minH: 2, maxW: 12, maxH: 12 };

const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The limits of a widget as they apply at a breakpoint (a 6-column grid cannot hold a 9-wide chart). */
export function limitsAt(lim: Limits, bp: Bp): Limits {
  if (bp === 'lg') return lim;
  if (bp === 'md') return { minW: Math.min(2, lim.minW), minH: lim.minH, maxW: 6, maxH: lim.maxH };
  return { minW: 1, minH: lim.minH, maxW: 1, maxH: lim.maxH };
}

/** A cell inside the grid and inside the widget's limits, on whole numbers. */
export function clampCell(c: Partial<Cell>, bp: Bp, lim: Limits = DEFAULT_LIMITS): Cell {
  const cols = COLS[bp];
  const l = limitsAt(lim, bp);
  const w = clamp(int(c.w, l.minW), l.minW, Math.min(l.maxW, cols));
  const h = clamp(int(c.h, l.minH), l.minH, l.maxH);
  return { x: bp === 'sm' ? 0 : clamp(int(c.x, 0), 0, cols - w), y: Math.max(0, int(c.y, 0)), w: bp === 'sm' ? 1 : w, h };
}

export const hit = (a: Cell, b: Cell) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Lowest row used by the cells. */
export const rowsOf = (cells: Cell[]) => cells.reduce((n, c) => Math.max(n, c.y + c.h), 0);

/**
 * Makes room: `fixedId` stays exactly where it is, every other cell (in reading order) rises as far as it can and
 * is pushed down until nothing overlaps. The result keeps the input order.
 */
export function settle<T extends Placed>(cells: T[], fixedId?: string): T[] {
  const fixed = cells.find((c) => c.id === fixedId);
  const placed: T[] = fixed ? [fixed] : [];
  const rest = cells.filter((c) => c !== fixed).sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  for (const c of rest) {
    const n = { ...c };
    while (n.y > 0 && !placed.some((p) => hit({ ...n, y: n.y - 1 }, p))) n.y--;
    while (placed.some((p) => hit(n, p))) n.y++;
    placed.push(n);
  }
  const byId = new Map(placed.map((p) => [p.id, p]));
  return cells.map((c) => byId.get(c.id)!);
}

/** The first free spot of w × h at or below `fromY` (and at or right of `fromX` in that first row band). */
export function findSpot(cells: Cell[], w: number, h: number, cols: number, from: { x?: number; y?: number } = {}): { x: number; y: number } {
  const startY = Math.max(0, from.y ?? 0);
  const startX = clamp(from.x ?? 0, 0, Math.max(0, cols - w));
  const lowest = rowsOf(cells) + 1;
  for (let y = startY; y <= lowest; y++) {
    for (let x = y === startY ? startX : 0; x + w <= cols; x++) if (!cells.some((c) => hit({ x, y, w, h }, c))) return { x, y };
  }
  return { x: 0, y: lowest };
}

export type Placement = 'top' | 'bottom' | { beside: string } | { below: string } | { above: string } | { x?: number; y?: number };

/**
 * Where a new w × h cell goes. `top` pushes everything down, `bottom` goes under the last row, `beside` takes the
 * free space to the right of another widget (or the line below when it is full), `below` / `above` stack on it.
 * Returns the cell for the new widget; run `settle(…, newId)` on the result to make room.
 */
export function placeNew(cells: Placed[], size: { w: number; h: number }, bp: Bp, at: Placement = 'bottom'): Cell {
  const cols = COLS[bp];
  const w = Math.min(size.w, cols);
  const h = size.h;
  const target = (id: string) => cells.find((c) => c.id === id);
  if (bp === 'sm') {
    if (at === 'top') return { x: 0, y: 0, w: 1, h };
    if (typeof at === 'object' && 'below' in at && target(at.below)) return { x: 0, y: target(at.below)!.y + target(at.below)!.h, w: 1, h };
    if (typeof at === 'object' && 'above' in at && target(at.above)) return { x: 0, y: target(at.above)!.y, w: 1, h };
    return { x: 0, y: rowsOf(cells), w: 1, h };
  }
  if (at === 'top') return { x: 0, y: 0, w, h };
  if (at === 'bottom') return { x: 0, y: rowsOf(cells), w, h };
  if ('x' in at || 'y' in at) {
    const p = at as { x?: number; y?: number };
    return { x: clamp(int(p.x, 0), 0, cols - w), y: Math.max(0, int(p.y, rowsOf(cells))), w, h };
  }
  if ('beside' in at) {
    const t = target(at.beside);
    if (!t) return { x: 0, y: rowsOf(cells), w, h };
    const others = cells.filter((c) => c.id !== t.id);
    const x = t.x + t.w;
    // Free space right of the target in its own rows – otherwise shrink to what fits, otherwise go below it.
    for (let ww = w; ww >= Math.min(w, 3); ww--) if (x + ww <= cols && !others.some((c) => hit({ x, y: t.y, w: ww, h }, c))) return { x, y: t.y, w: ww, h };
    return { x: t.x, y: t.y + t.h, w, h };
  }
  if ('below' in at) {
    const t = target(at.below);
    return t ? { x: t.x, y: t.y + t.h, w, h } : { x: 0, y: rowsOf(cells), w, h };
  }
  if ('above' in at) {
    const t = target(at.above);
    return t ? { x: t.x, y: t.y, w, h } : { x: 0, y: 0, w, h };
  }
  return { x: 0, y: rowsOf(cells), w, h };
}

/** Reading order (top to bottom, left to right). */
export const reading = <T extends Cell & { id?: string }>(cells: T[]): T[] => [...cells].sort((a, b) => a.y - b.y || a.x - b.x || String(a.id ?? '').localeCompare(String(b.id ?? '')));

/** md (6 columns) from the lg layout: half the widths (at least 2), same heights, settled. */
export function deriveMd(lg: Placed[], limits: (id: string) => Limits = () => DEFAULT_LIMITS): Placed[] {
  const cells = lg.map((c) => {
    const w = clamp(Math.round(c.w / 2), 2, 6);
    return { id: c.id, ...clampCell({ x: Math.round(c.x / 2), y: c.y, w, h: c.h }, 'md', limits(c.id)) };
  });
  return settle(cells);
}

/** sm (one column): the widgets stacked in reading order of the lg layout. */
export function deriveSm(lg: Placed[], limits: (id: string) => Limits = () => DEFAULT_LIMITS): Placed[] {
  let y = 0;
  const out = new Map<string, Placed>();
  for (const c of reading(lg)) {
    const h = clampCell({ h: Math.min(c.h, 6) }, 'sm', limits(c.id)).h;
    out.set(c.id, { id: c.id, x: 0, y, w: 1, h });
    y += h;
  }
  return lg.map((c) => out.get(c.id)!);
}

export const derive = (lg: Placed[], bp: 'md' | 'sm', limits?: (id: string) => Limits): Placed[] => (bp === 'md' ? deriveMd(lg, limits) : deriveSm(lg, limits));

/** Moves one widget to a new place in a single-column layout (phone: reorder), then renumbers the rows. */
export function reorderStack<T extends Placed>(cells: T[], id: string, toIndex: number): T[] {
  const order = reading(cells);
  const from = order.findIndex((c) => c.id === id);
  if (from < 0) return cells;
  const [item] = order.splice(from, 1);
  order.splice(clamp(toIndex, 0, order.length), 0, item);
  let y = 0;
  const next = new Map<string, number>();
  for (const c of order) {
    next.set(c.id, y);
    y += c.h;
  }
  return cells.map((c) => ({ ...c, x: 0, w: 1, y: next.get(c.id)! }));
}
