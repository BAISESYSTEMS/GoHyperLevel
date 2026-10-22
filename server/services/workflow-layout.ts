/**
 * How the visual workflow canvas stores its picture in `settings.layout` (docs/workflow-actions.md → The canvas). Pure and
 * import-free: the server cleans what is saved (modules/workflow-canvas.ts), the web canvas reads and writes it.
 *
 * Node positions are stored as offsets from the automatic layout (`offsets[node] = [dx, dy]`), keyed by step id, `trigger` or
 * `<step id>/<lane>` for the header of a lane – so a hand-arranged canvas stays tidy when a step is inserted above, and a node
 * without an entry sits where the auto-layout puts it. Sticky notes are nodes of their own with absolute positions; the engine
 * never reads any of this.
 */

export const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface CanvasNote {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: NoteColor;
}
export interface WorkflowLayout {
  v: 1;
  offsets?: Record<string, [number, number]>;
  notes?: CanvasNote[];
}

export const LAYOUT_LIMITS = { offsets: 800, notes: 100, text: 2000, coord: 200_000, minW: 140, maxW: 640, minH: 80, maxH: 640 } as const;

const KEY = /^[\w-]{1,64}(\/[\w-]{1,16})?$/;
const num = (v: unknown, lo: number, hi: number, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : fallback;
};

/**
 * A layout as it may be stored, or undefined when there is nothing to keep. `keys` (all node keys of the workflow) drops offsets of
 * steps that are gone.
 */
export function cleanLayout(input: unknown, keys?: Set<string>): WorkflowLayout | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const src = input as Record<string, unknown>;
  const C = LAYOUT_LIMITS.coord;
  const offsets: Record<string, [number, number]> = {};
  if (src.offsets && typeof src.offsets === 'object' && !Array.isArray(src.offsets)) {
    for (const [k, v] of Object.entries(src.offsets as Record<string, unknown>)) {
      if (Object.keys(offsets).length >= LAYOUT_LIMITS.offsets) break;
      if (!KEY.test(k) || (keys && !keys.has(k)) || !Array.isArray(v) || v.length !== 2) continue;
      const pair: [number, number] = [num(v[0], -C, C), num(v[1], -C, C)];
      if (pair[0] || pair[1]) offsets[k] = pair;
    }
  }
  const notes: CanvasNote[] = [];
  const seen = new Set<string>();
  for (const n of Array.isArray(src.notes) ? src.notes.slice(0, LAYOUT_LIMITS.notes) : []) {
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    const id = String(o.id ?? '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    notes.push({
      id,
      x: num(o.x, -C, C),
      y: num(o.y, -C, C),
      w: num(o.w, LAYOUT_LIMITS.minW, LAYOUT_LIMITS.maxW, 220),
      h: num(o.h, LAYOUT_LIMITS.minH, LAYOUT_LIMITS.maxH, 140),
      text: String(o.text ?? '').slice(0, LAYOUT_LIMITS.text),
      color: (NOTE_COLORS as readonly string[]).includes(String(o.color)) ? (o.color as NoteColor) : 'yellow',
    });
  }
  if (!Object.keys(offsets).length && !notes.length) return undefined;
  return { v: 1, ...(Object.keys(offsets).length ? { offsets } : {}), ...(notes.length ? { notes } : {}) };
}

/** Every node key a step tree has: `trigger`, each step id and `<id>/<lane>` for the lanes of containers. */
export function layoutKeys(steps: { id: string; [k: string]: any }[]): Set<string> {
  const out = new Set<string>(['trigger']);
  const visit = (list: unknown) => {
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || typeof s !== 'object') continue;
      out.add(String(s.id));
      for (const k of Object.keys(s)) {
        if (!/^(then|else|each|b\d)$/.test(k) || !Array.isArray(s[k])) continue;
        out.add(`${s.id}/${k}`);
        visit(s[k]);
      }
    }
  };
  visit(steps);
  return out;
}
