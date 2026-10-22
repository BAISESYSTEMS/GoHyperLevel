import { COLS, GAP, ROW_H, clampCell, reading, reorderStack, settle, type Bp, type Cell, type Limits, type Placed } from '../../../server/services/boards-layout';
import type { Spec, Widget } from './types';

/**
 * The maths behind dragging, as plain functions (the grid component only moves pixels and calls these): the cells of
 * a breakpoint, a moved or resized cell with the others making room – the same `settle` the server uses, so what the
 * person sees while dragging is what the server saves – and the pixels of a cell.
 */

export { COLS, GAP, ROW_H };

/** The cells of one breakpoint, in widget order. A widget without a cell for it falls back to its desktop one. */
export const cellsOf = (widgets: Widget[], bp: Bp): Placed[] => widgets.map((w) => ({ id: w.id, ...(w.layout[bp] ?? w.layout.lg) }));

export const colWidth = (width: number, bp: Bp) => (width - GAP * (COLS[bp] - 1)) / COLS[bp];
export const cellPx = (c: Cell, colW: number) => ({ left: c.x * (colW + GAP), top: c.y * (ROW_H + GAP), width: c.w * colW + (c.w - 1) * GAP, height: c.h * ROW_H + (c.h - 1) * GAP });
export const heightPx = (rows: number) => Math.max(0, rows * (ROW_H + GAP) - GAP);
/** The height of a card of `h` rows in pixels. */
export const rowsPx = (h: number) => h * ROW_H + (h - 1) * GAP;

/** One widget dropped on the cell (x, y): it stays there, the others make room. */
export function moveTo(cells: Placed[], id: string, x: number, y: number, bp: Bp, limits: Limits): Placed[] {
  const me = cells.find((c) => c.id === id);
  if (!me) return cells;
  const next = clampCell({ x, y, w: me.w, h: me.h }, bp, limits);
  return settle(cells.map((c) => (c.id === id ? { ...c, ...next } : c)), id);
}

/** One widget resized to w × h (inside its limits); the others make room. */
export function resizeTo(cells: Placed[], id: string, w: number, h: number, bp: Bp, limits: Limits): Placed[] {
  const me = cells.find((c) => c.id === id);
  if (!me) return cells;
  const next = clampCell({ x: me.x, y: me.y, w, h }, bp, limits);
  return settle(cells.map((c) => (c.id === id ? { ...c, ...next } : c)), id);
}

/**
 * The layout with one card put at `cur` (moved and/or resized from `origin`) the way the server will save it: the card
 * stays where it was put, the others make room (settle), and finally every card rises as far as it can – so the ghost
 * shows the place the card really lands in, not a floating one.
 */
export function arrange(base: Placed[], id: string, cur: Cell, origin: Cell, bp: Bp, limits: Limits): Placed[] {
  let cells = cur.x !== origin.x || cur.y !== origin.y ? moveTo(base, id, cur.x, cur.y, bp, limits) : base;
  if (cur.w !== origin.w || cur.h !== origin.h) cells = resizeTo(cells, id, cur.w, cur.h, bp, limits);
  return settle(cells);
}

/** The phone: a widget one place up or down in the stack. */
export function stackStep(cells: Placed[], id: string, dir: -1 | 1): Placed[] {
  const order = reading(cells);
  const i = order.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return cells;
  return reorderStack(cells, id, j);
}

/** The same widgets with the given cells written into the breakpoint (and that breakpoint marked as arranged by hand). */
export function withCells(spec: Spec, bp: Bp, cells: Placed[]): Spec {
  const byId = new Map(cells.map((c) => [c.id, c]));
  return {
    ...spec,
    widgets: spec.widgets.map((w) => {
      const c = byId.get(w.id);
      return c ? { ...w, layout: { ...w.layout, [bp]: { x: c.x, y: c.y, w: c.w, h: c.h } } } : w;
    }),
    ...(bp !== 'lg' ? { custom: { ...(spec.custom ?? {}), [bp]: true } } : {}),
  };
}

/** Did anything change between two cell sets? */
export const sameCells = (a: Placed[], b: Placed[]) => a.length === b.length && a.every((c) => b.some((d) => d.id === c.id && d.x === c.x && d.y === c.y && d.w === c.w && d.h === c.h));

/** "Spalte 3, Zeile 2, 4 Spalten breit" for screen readers. */
export const describeCell = (c: Cell, bp: Bp) => (bp === 'sm' ? `Platz ${c.y + 1}` : `Spalte ${c.x + 1}, Zeile ${c.y + 1}, ${c.w} Spalten breit, ${c.h} Zeilen hoch`);
