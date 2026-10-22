import { type Box, type CanvasElement, autoSizeText, createElement, sortByZ } from '../../../server/services/canvas-model';
import { boxOf, selectionBox } from './geometry';
import { type BoardStore, newId } from './store';

/**
 * Editor commands that work on the selection: grouping, z-order, align/distribute, duplicate,
 * clipboard (copy/paste between boards and apps), locking. All go through the store (undo + sync).
 */

export const CLIP_MARK = 'gohigh-canvas/v1';

/** Expands a selection: groups are selected as a whole, frames bring their contents. */
export function expandSelection(store: BoardStore, ids: Iterable<string>, opts: { frames?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    const e = store.els.get(id);
    if (!e) continue;
    out.add(id);
    if (opts.frames !== false && e.type === 'frame') for (const c of store.els.values()) if (c.frameId === id) out.add(c.id);
  }
  return out;
}

/** The outermost group of an element (or the element alone). */
export function groupMembers(store: BoardStore, el: CanvasElement): string[] {
  const g = el.groupIds?.[el.groupIds.length - 1];
  if (!g) return [el.id];
  return [...store.els.values()].filter((e) => e.groupIds?.includes(g)).map((e) => e.id);
}

export function group(store: BoardStore, ids: string[]) {
  if (ids.length < 2) return;
  const gid = newId();
  store.update(Object.fromEntries(ids.map((id) => [id, { groupIds: [...(store.els.get(id)?.groupIds ?? []), gid] }])));
}

export function ungroup(store: BoardStore, ids: string[]) {
  const patches: Record<string, Partial<CanvasElement>> = {};
  for (const id of ids) {
    const e = store.els.get(id);
    if (e?.groupIds?.length) patches[id] = { groupIds: e.groupIds.length > 1 ? e.groupIds.slice(0, -1) : (undefined as any) };
  }
  store.update(patches);
}

/** Bring to front / send to back / one step. */
export function reorder(store: BoardStore, ids: string[], how: 'front' | 'back' | 'up' | 'down') {
  const sel = new Set(ids);
  const all = sortByZ([...store.els.values()]);
  const zs = all.map((e) => e.z ?? 0);
  const top = zs.length ? Math.max(...zs) : 0;
  const bottom = zs.length ? Math.min(...zs) : 0;
  const mine = all.filter((e) => sel.has(e.id));
  const patches: Record<string, Partial<CanvasElement>> = {};
  if (how === 'front') mine.forEach((e, i) => (patches[e.id] = { z: top + 1 + i }));
  else if (how === 'back') mine.forEach((e, i) => (patches[e.id] = { z: bottom - mine.length + i }));
  else {
    const rest = all.filter((e) => !sel.has(e.id));
    for (const e of mine) {
      const z = e.z ?? 0;
      const neighbour = how === 'up' ? rest.find((r) => (r.z ?? 0) > z) : [...rest].reverse().find((r) => (r.z ?? 0) < z);
      if (!neighbour) continue;
      const nz = neighbour.z ?? 0;
      const beyond = how === 'up' ? rest.find((r) => (r.z ?? 0) > nz) : [...rest].reverse().find((r) => (r.z ?? 0) < nz);
      patches[e.id] = { z: beyond ? (nz + (beyond.z ?? 0)) / 2 : nz + (how === 'up' ? 1 : -1) };
    }
  }
  store.update(patches);
}

export type AlignHow = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export function align(store: BoardStore, ids: string[], how: AlignHow) {
  const els = ids.map((id) => store.els.get(id)!).filter(Boolean);
  const box = selectionBox(els, store.els);
  if (!box || els.length < 2) return;
  const patches: Record<string, Partial<CanvasElement>> = {};
  for (const e of els) {
    const b = boxOf(e, store.els);
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = box.x - b.x;
    if (how === 'right') dx = box.x + box.w - (b.x + b.w);
    if (how === 'hcenter') dx = box.x + box.w / 2 - (b.x + b.w / 2);
    if (how === 'top') dy = box.y - b.y;
    if (how === 'bottom') dy = box.y + box.h - (b.y + b.h);
    if (how === 'vcenter') dy = box.y + box.h / 2 - (b.y + b.h / 2);
    if (dx || dy) patches[e.id] = { x: e.x + dx, y: e.y + dy };
  }
  store.update(patches);
}

export function distribute(store: BoardStore, ids: string[], axis: 'h' | 'v') {
  const els = ids.map((id) => store.els.get(id)!).filter(Boolean);
  if (els.length < 3) return;
  const boxes = els.map((e) => ({ e, b: boxOf(e, store.els) }));
  boxes.sort((p, q) => (axis === 'h' ? p.b.x - q.b.x : p.b.y - q.b.y));
  const first = boxes[0].b;
  const last = boxes[boxes.length - 1].b;
  const total = boxes.reduce((s, x) => s + (axis === 'h' ? x.b.w : x.b.h), 0);
  const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
  const gap = (span - total) / (boxes.length - 1);
  let cur = axis === 'h' ? first.x : first.y;
  const patches: Record<string, Partial<CanvasElement>> = {};
  for (const { e, b } of boxes) {
    const d = cur - (axis === 'h' ? b.x : b.y);
    if (Math.abs(d) > 0.01) patches[e.id] = axis === 'h' ? { x: e.x + d } : { y: e.y + d };
    cur += (axis === 'h' ? b.w : b.h) + gap;
  }
  store.update(patches);
}

/**
 * Copies of elements with new ids (bindings, frames and groups re-pointed to the copies), moved by
 * dx/dy. Bindings to elements outside the set are dropped.
 */
export function cloneElements(els: CanvasElement[], dx: number, dy: number): CanvasElement[] {
  const ids = new Map(els.map((e) => [e.id, newId()]));
  const groups = new Map<string, string>();
  const mapGroup = (g: string) => groups.get(g) ?? (groups.set(g, newId()), groups.get(g)!);
  return els.map((e) => {
    const c: CanvasElement = { ...e, id: ids.get(e.id)!, x: e.x + dx, y: e.y + dy, version: undefined, seed: Math.floor(Math.random() * 2 ** 31) };
    if (e.frameId) c.frameId = ids.get(e.frameId) ?? (dx || dy ? undefined : e.frameId);
    if (e.groupIds) c.groupIds = e.groupIds.map(mapGroup);
    if (e.start) c.start = ids.has(e.start.id) ? { ...e.start, id: ids.get(e.start.id)! } : null;
    if (e.end) c.end = ids.has(e.end.id) ? { ...e.end, id: ids.get(e.end.id)! } : null;
    if (!c.start) delete c.start;
    if (!c.end) delete c.end;
    return c;
  });
}

/** Selected elements plus what belongs to them (frame contents, arrows between selected shapes). */
export function withDependents(store: BoardStore, ids: Iterable<string>): CanvasElement[] {
  const set = expandSelection(store, ids);
  for (const e of store.els.values()) if ((e.type === 'arrow' || e.type === 'line') && e.start && e.end && set.has(e.start.id) && set.has(e.end.id)) set.add(e.id);
  return sortByZ([...set].map((id) => store.els.get(id)!).filter(Boolean));
}

export function duplicate(store: BoardStore, ids: string[]): string[] {
  const copies = cloneElements(withDependents(store, ids), 24, 24);
  const top = store.ordered.length ? (store.ordered[store.ordered.length - 1].z ?? 0) : 0;
  copies.forEach((c, i) => (c.z = top + 1 + i));
  store.add(copies);
  return copies.filter((c) => !c.frameId || !copies.some((x) => x.id === c.frameId)).map((c) => c.id);
}

export function serialize(els: CanvasElement[]): string {
  return JSON.stringify({ type: CLIP_MARK, elements: els.map(({ version: _v, ...e }) => e) });
}

/** Elements from clipboard text (our own JSON), checked like on the server; null if it is not ours. */
export function parseClipboard(text: string): CanvasElement[] | null {
  if (!text.includes(CLIP_MARK)) return null;
  try {
    const d = JSON.parse(text);
    if (d?.type !== CLIP_MARK || !Array.isArray(d.elements)) return null;
    const out: CanvasElement[] = [];
    for (const raw of d.elements.slice(0, 2000)) {
      try {
        out.push(createElement(raw, newId));
      } catch {
        /* skip broken ones */
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Places pasted elements around a point (keeping their arrangement). */
export function pasteAt(store: BoardStore, els: CanvasElement[], at: { x: number; y: number } | null): string[] {
  if (!els.length) return [];
  const b = selectionBox(els, new Map(els.map((e) => [e.id, e]))) as Box;
  const dx = at ? at.x - (b.x + b.w / 2) : 24;
  const dy = at ? at.y - (b.y + b.h / 2) : 24;
  const copies = cloneElements(els, Math.round(dx), Math.round(dy));
  const top = store.ordered.length ? (store.ordered[store.ordered.length - 1].z ?? 0) : 0;
  copies.forEach((c, i) => (c.z = top + 1 + i));
  store.add(copies);
  return copies.filter((c) => !c.frameId).map((c) => c.id);
}

/** Text element sized to its text (new text, edited text). */
export function sizedText(el: CanvasElement, fitWidth = false): CanvasElement {
  return autoSizeText({ ...el }, fitWidth);
}
