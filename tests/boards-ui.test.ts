import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { limitsAt, type Cell, type Placed } from '../server/services/boards-layout.js';
import { emptySpec, cellsAt, type BoardState } from '../server/services/boards-model.js';
import { applyPatch } from '../server/services/boards-patch.js';
import { WidgetRegistry } from '../server/services/boards-widgets.js';
import { registerCoreWidgets } from '../server/services/boards-widgets-core.js';
import { arrange, cellPx, cellsOf, colWidth, describeCell, heightPx, moveTo, resizeTo, rowsPx, stackStep, withCells } from '../web/src/boards/layout';
import { cellsOfSpec } from '../web/src/boards/Mini';
import { ICONS } from '../web/src/icons';
import { SOLID } from '../web/src/theme/packs/solid';
import { ACCENTS, BOARD_ICONS } from '../server/services/boards-consts.js';
import type { Spec } from '../web/src/boards/types';

/** The browser side of Living Boards: the pure helpers behind dragging, and that what the browser predicts is what the server saves. */

const reg = new WidgetRegistry();
const env = { app: { services: {}, baseUrl: () => 'http://x' } as any, locationId: 'L1' };
let n = 0;
const newId = () => `w${String(++n).padStart(8, '0')}`;
const start = (): BoardState => ({ name: 'B', icon: 'boards', accent: '', spec: emptySpec() });
const server = (state: BoardState, ops: unknown) => {
  const r = applyPatch(state, ops, { reg, env, newId });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.state;
};
const lim = (type: string) => limitsAt(reg.limits(type), 'lg');
const ids = (s: BoardState) => s.spec.widgets.map((w) => w.id);
const lg = (s: BoardState): Placed[] => cellsAt(s.spec, 'lg', (t) => reg.limits(t));

beforeAll(() => registerCoreWidgets(reg));

describe('pixels of the grid', () => {
  it('converts cells to pixels and back to rows', () => {
    const colW = colWidth(1200, 'lg');
    expect(colW).toBeCloseTo((1200 - 14 * 11) / 12, 5);
    const px = cellPx({ x: 3, y: 2, w: 4, h: 3 }, colW);
    expect(px.left).toBeCloseTo(3 * (colW + 14), 5);
    expect(px.top).toBe(2 * 98);
    expect(px.width).toBeCloseTo(4 * colW + 3 * 14, 5);
    expect(px.height).toBe(3 * 84 + 2 * 14);
    expect(heightPx(4)).toBe(4 * 98 - 14);
    expect(rowsPx(2)).toBe(2 * 84 + 14);
    expect(colWidth(400, 'sm')).toBe(400);
  });

  it('describes a cell for screen readers in German', () => {
    expect(describeCell({ x: 2, y: 1, w: 4, h: 3 }, 'lg')).toBe('Spalte 3, Zeile 2, 4 Spalten breit, 3 Zeilen hoch');
    expect(describeCell({ x: 0, y: 4, w: 1, h: 2 }, 'sm')).toBe('Platz 5');
  });
});

describe('moving and resizing in the browser', () => {
  const c = (id: string, x: number, y: number, w: number, h: number): Placed => ({ id, x, y, w, h });
  const limits = { minW: 2, minH: 2, maxW: 12, maxH: 12 };

  it('keeps the moved card where it is put and lets the others make room', () => {
    const cells = [c('a', 0, 0, 6, 2), c('b', 6, 0, 6, 2), c('c', 0, 2, 6, 2)];
    const r = moveTo(cells, 'a', 6, 0, 'lg', limits);
    expect(r.find((x) => x.id === 'a')).toMatchObject({ x: 6, y: 0 });
    expect(r.find((x) => x.id === 'b')!.y).toBeGreaterThanOrEqual(2);
  });

  it('keeps cells inside the grid and the limits', () => {
    const cells = [c('a', 0, 0, 4, 2)];
    expect(moveTo(cells, 'a', 40, -5, 'lg', limits)[0]).toMatchObject({ x: 8, y: 0 });
    expect(resizeTo(cells, 'a', 99, 0, 'lg', limits)[0]).toMatchObject({ w: 12, h: 2 });
    expect(resizeTo(cells, 'a', 1, 1, 'lg', limits)[0]).toMatchObject({ w: 2, h: 2 });
  });

  it('moves one place up or down in the phone stack', () => {
    const cells = [c('a', 0, 0, 1, 2), c('b', 0, 2, 1, 3), c('c', 0, 5, 1, 2)];
    const down = stackStep(cells, 'a', 1);
    expect(down.find((x) => x.id === 'a')!.y).toBe(3);
    expect(down.find((x) => x.id === 'b')!.y).toBe(0);
    expect(stackStep(cells, 'a', -1)).toBe(cells);
    expect(stackStep(cells, 'c', 1)).toBe(cells);
  });

  it('writes cells into one breakpoint and marks it as arranged by hand', () => {
    const spec: Spec = { v: 1, widgets: [{ id: 'a', type: 'notes', title: '', config: {}, layout: { lg: { x: 0, y: 0, w: 4, h: 3 } } }] };
    const next = withCells(spec, 'md', [c('a', 1, 2, 3, 3)]);
    expect(next.widgets[0].layout.md).toEqual({ x: 1, y: 2, w: 3, h: 3 });
    expect(next.custom).toEqual({ md: true });
    expect(withCells(spec, 'lg', [c('a', 2, 0, 4, 3)]).custom).toBeUndefined();
    expect(cellsOf(next.widgets, 'md')[0]).toMatchObject({ id: 'a', x: 1, y: 2 });
    // a widget without a cell for this size falls back to its desktop cell
    expect(cellsOf(spec.widgets, 'sm')[0]).toMatchObject({ x: 0, y: 0, w: 4 });
    expect(cellsOfSpec(next.widgets)[0]).toMatchObject({ type: 'notes', x: 0, w: 4 });
  });
});

describe('what the browser predicts is what the server saves', () => {
  /** A fixed, slightly irregular board of the same kind people build. */
  const board = (): BoardState => {
    let s = start();
    const add = (type: string, x: number, y: number, w: number, h: number) => (s = server(s, [{ op: 'add', type, x, y, w, h }]));
    add('kpi', 0, 0, 3, 2);
    add('kpi', 3, 0, 3, 2);
    add('notes', 6, 0, 6, 3);
    add('list', 0, 2, 6, 4);
    add('pipeline', 0, 6, 12, 5);
    add('agenda', 6, 3, 6, 3);
    return s;
  };

  it('arrange() equals a patch with the same move and resize, for many drops', () => {
    const s = board();
    const base = lg(s);
    const widgets = s.spec.widgets;
    let compared = 0;
    for (const w of widgets) {
      const origin = base.find((c) => c.id === w.id) as Cell & { id: string };
      for (const [x, y] of [[0, 0], [3, 1], [6, 2], [9, 4], [0, 7], [4, 12], [11, 3], [2, 6]]) {
        const cur: Cell = { x, y, w: origin.w, h: origin.h };
        const predicted = arrange(base, w.id, cur, origin, 'lg', lim(w.type));
        const saved = lg(server(s, [{ op: 'move', id: w.id, x, y }]));
        expect(predicted.map((c) => [c.id, c.x, c.y, c.w, c.h]), `${w.type} → ${x},${y}`).toEqual(saved.map((c) => [c.id, c.x, c.y, c.w, c.h]));
        compared++;
      }
      for (const [dw, dh] of [[1, 0], [3, 2], [-2, -1], [0, 4]]) {
        const cur: Cell = { x: origin.x, y: origin.y, w: origin.w + dw, h: origin.h + dh };
        const predicted = arrange(base, w.id, cur, origin, 'lg', lim(w.type));
        const saved = lg(server(s, [{ op: 'resize', id: w.id, w: cur.w, h: cur.h }]));
        expect(predicted.map((c) => [c.id, c.x, c.y, c.w, c.h]), `${w.type} resize ${dw},${dh}`).toEqual(saved.map((c) => [c.id, c.x, c.y, c.w, c.h]));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(60);
    expect(ids(s)).toHaveLength(6);
  });

  it('a keyboard drop (move, then resize) is predicted as well, and what is committed reproduces it', () => {
    const s = board();
    const base = lg(s);
    const w = s.spec.widgets[3];
    const origin = base.find((c) => c.id === w.id)!;
    const cur: Cell = { x: 2, y: 9, w: origin.w + 2, h: origin.h - 1 };
    const predicted = arrange(base, w.id, cur, origin, 'lg', lim(w.type));
    const target = predicted.find((c) => c.id === w.id)!;
    // the browser commits the *resting* place, not the cursor
    const ops = [
      ...(target.x !== origin.x || target.y !== origin.y ? [{ op: 'move', id: w.id, x: target.x, y: target.y }] : []),
      ...(target.w !== origin.w || target.h !== origin.h ? [{ op: 'resize', id: w.id, w: target.w, h: target.h }] : []),
    ];
    const saved = lg(server(s, ops));
    expect(saved.map((c) => [c.id, c.x, c.y, c.w, c.h])).toEqual(predicted.map((c) => [c.id, c.x, c.y, c.w, c.h]));
  });
});

describe('the browser knows what the server offers', () => {
  it('has an icon for every board symbol and every widget type', () => {
    for (const i of BOARD_ICONS) expect(Object.keys(ICONS), `Board-Symbol ${i}`).toContain(i);
    for (const w of reg.list()) expect(Object.keys(ICONS), `Widget ${w.type}: Symbol ${w.icon}`).toContain(w.icon);
    // the menu entry has a glyph in the solid pack, too
    expect(SOLID.boards).toBeTruthy();
  });

  it('accent names are valid colours', () => {
    for (const [name, hex] of Object.entries(ACCENTS)) expect(hex, name).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('web/src/boards/boards.css', () => {
  const css = readFileSync(new URL('../web/src/boards/boards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('has balanced braces (an unclosed @media block silently scopes every later rule)', () => {
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('defines every animation it uses and switches motion off for prefers-reduced-motion', () => {
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]).filter((a) => a !== 'none'));
    for (const a of used) expect(defined, `@keyframes ${a}`).toContain(a);
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(reduced).toMatch(/\.bd-cell[^{]*\{[^}]*transition: none/);
    expect(reduced).toMatch(/animation: none/);
  });
});
