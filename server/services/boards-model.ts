/**
 * Living Boards: the board model – what a board is made of, how it is cleaned and normalised. Pure (no database,
 * no app); the store, the patch engine, the templates and the routes build on it.
 *
 * A board is `name`, `icon`, `accent` and a `spec`: the widgets with their config and their layout per breakpoint
 * (see boards-layout.ts). Every saved change is a version of this whole state.
 */

import { id as randomId } from '../core/util.js';
import { ACCENTS, BOARD_ICONS, LIMITS, accentName } from './boards-consts.js';
import { BREAKPOINTS, DEFAULT_LIMITS, clampCell, derive, hit, placeNew, reading, settle, type Bp, type Cell, type Limits, type Placed } from './boards-layout.js';

export interface WidgetInst {
  id: string;
  type: string;
  /** Own heading; empty = the widget type's name. */
  title: string;
  config: Record<string, unknown>;
  layout: { lg: Cell; md?: Cell; sm?: Cell };
}
export interface BoardSpec {
  v: 1;
  widgets: WidgetInst[];
  /** A breakpoint somebody arranged by hand: it is no longer derived from lg. */
  custom?: { md?: boolean; sm?: boolean };
}
export interface BoardState {
  name: string;
  icon: string;
  accent: string;
  spec: BoardSpec;
}

/** '' (the theme's own accent), a #rrggbb colour or one of the names above. Anything else is an error for the caller to report. */
export function cleanAccent(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const named = ACCENTS[s] ?? ACCENTS[s.replace('ue', 'ü')];
  return named ?? null;
}
export const cleanIcon = (v: unknown, fallback = 'boards') => (typeof v === 'string' && (BOARD_ICONS as readonly string[]).includes(v) ? v : fallback);

/** A one-line text without control characters, cut to `max`. */
export function cleanLine(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
/** Free text (notes): newlines stay, other control characters go. */
export const cleanText = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);

export const newWidgetId = () => `w${randomId(9)}`;
export const WIDGET_ID = /^w[A-Za-z0-9]{6,20}$/;

export const emptySpec = (): BoardSpec => ({ v: 1, widgets: [] });

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What is stored, back into a spec – tolerant: damaged parts are dropped, nothing throws. */
export function parseSpec(json: unknown): BoardSpec {
  let raw: unknown = json;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch {
      return emptySpec();
    }
  }
  if (!isObj(raw) || !Array.isArray(raw.widgets)) return emptySpec();
  const seen = new Set<string>();
  const widgets: WidgetInst[] = [];
  for (const w of raw.widgets) {
    if (!isObj(w) || typeof w.type !== 'string' || !isObj(w.layout) || !isObj(w.layout.lg)) continue;
    let wid = typeof w.id === 'string' && WIDGET_ID.test(w.id) ? w.id : newWidgetId();
    while (seen.has(wid)) wid = newWidgetId();
    seen.add(wid);
    widgets.push({
      id: wid,
      type: w.type,
      title: cleanLine(w.title, LIMITS.title),
      config: isObj(w.config) ? w.config : {},
      layout: { lg: clampCell(w.layout.lg, 'lg'), ...(isObj(w.layout.md) ? { md: clampCell(w.layout.md, 'md') } : {}), ...(isObj(w.layout.sm) ? { sm: clampCell(w.layout.sm, 'sm') } : {}) },
    });
  }
  const custom = isObj(raw.custom) ? { ...(raw.custom.md === true ? { md: true as const } : {}), ...(raw.custom.sm === true ? { sm: true as const } : {}) } : undefined;
  return { v: 1, widgets: widgets.slice(0, LIMITS.widgets), ...(custom && Object.keys(custom).length ? { custom } : {}) };
}

/** The cells of one breakpoint, with the widget id; a missing cell is derived from lg. */
export function cellsAt(spec: BoardSpec, bp: Bp, limits: (type: string) => Limits = () => DEFAULT_LIMITS): Placed[] {
  const lim = (id: string) => limits(spec.widgets.find((w) => w.id === id)?.type ?? '');
  const lg: Placed[] = spec.widgets.map((w) => ({ id: w.id, ...clampCell(w.layout.lg, 'lg', limits(w.type)) }));
  if (bp === 'lg') return lg;
  const have = spec.widgets.every((w) => w.layout[bp]);
  if (!spec.custom?.[bp] || !have) return derive(lg, bp, lim);
  return spec.widgets.map((w) => ({ id: w.id, ...clampCell(w.layout[bp]!, bp, limits(w.type)) }));
}

/**
 * The spec in its canonical form: unique ids, cells inside the limits, no overlaps, md and sm derived from lg unless
 * they were arranged by hand (then every widget has a cell there, new ones at the bottom). Idempotent.
 */
export function normalizeSpec(input: BoardSpec, limits: (type: string) => Limits = () => DEFAULT_LIMITS): BoardSpec {
  const widgets = input.widgets.slice(0, LIMITS.widgets);
  const lim = (id: string) => limits(widgets.find((w) => w.id === id)?.type ?? '');
  const lg = settle(widgets.map((w) => ({ id: w.id, ...clampCell(w.layout.lg, 'lg', limits(w.type)) })));
  const cells: Record<'md' | 'sm', Placed[]> = { md: [], sm: [] };
  const custom: { md?: true; sm?: true } = {};
  for (const bp of ['md', 'sm'] as const) {
    if (!input.custom?.[bp]) {
      cells[bp] = derive(lg, bp, lim);
      continue;
    }
    custom[bp] = true;
    // Arranged by hand: keep what is there, put widgets without a cell at the bottom.
    const mine: Placed[] = widgets.filter((w) => w.layout[bp]).map((w) => ({ id: w.id, ...clampCell(w.layout[bp]!, bp, limits(w.type)) }));
    for (const w of widgets.filter((x) => !x.layout[bp])) {
      const from = lg.find((l) => l.id === w.id)!;
      const size = { w: bp === 'md' ? Math.min(6, Math.max(2, Math.round(from.w / 2))) : 1, h: from.h };
      mine.push({ id: w.id, ...clampCell(placeNew(mine, size, bp, 'bottom'), bp, limits(w.type)) });
    }
    let settled = settle(mine);
    if (bp === 'sm') {
      // A stack without gaps, in the order the person chose.
      let y = 0;
      settled = reading(settled).map((c) => {
        const n = { ...c, x: 0, w: 1, y };
        y += c.h;
        return n;
      });
    }
    cells[bp] = settled;
  }
  const cellOf = (list: Placed[], id: string): Cell => {
    const { x, y, w, h } = list.find((c) => c.id === id)!;
    return { x, y, w, h };
  };
  return {
    v: 1,
    widgets: widgets.map((w) => ({ ...w, layout: { lg: cellOf(lg, w.id), md: cellOf(cells.md, w.id), sm: cellOf(cells.sm, w.id) } })),
    ...(Object.keys(custom).length ? { custom } : {}),
  };
}

export const widgetById = (spec: BoardSpec, id: string) => spec.widgets.find((w) => w.id === id);

/** True when two cells of one layout overlap (a sanity check for tests and imports). */
export function overlaps(cells: Cell[]): boolean {
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) if (hit(cells[i], cells[j])) return true;
  return false;
}

export const BP_LIST = BREAKPOINTS;
export { ACCENTS, BOARD_ICONS, LIMITS, accentName };
