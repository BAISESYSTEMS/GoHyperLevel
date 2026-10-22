import { type Box, type CanvasElement, elementBox, unionBox } from '../../../server/services/canvas-model';
import { lineGeometry } from '../../../server/services/canvas-render';
import { distToPolyline, pointInPolygon, type Pt } from '../../../server/services/canvas-path';

/** Editor geometry: view transform, hit tests, selection boxes, resize maths and smart guides. */

export interface View {
  tx: number;
  ty: number;
  z: number;
}

export const toWorld = (v: View, sx: number, sy: number): Pt => [(sx - v.tx) / v.z, (sy - v.ty) / v.z];
export const toScreen = (v: View, wx: number, wy: number): Pt => [wx * v.z + v.tx, wy * v.z + v.ty];

const isLine = (e: CanvasElement) => e.type === 'line' || e.type === 'arrow';

/** Box of an element as the editor sees it (lines: their resolved path). */
export function boxOf(e: CanvasElement, byId: Map<string, CanvasElement>): Box {
  if (isLine(e)) {
    const g = lineGeometry(e, { byId });
    const xs = g.pts.map((p) => p[0]);
    const ys = g.pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return elementBox(e);
}

export function selectionBox(els: CanvasElement[], byId: Map<string, CanvasElement>): Box | null {
  return unionBox(els.map((e) => boxOf(e, byId)));
}

/** Point in the element's own (unrotated) frame. */
export function localPoint(e: CanvasElement, x: number, y: number): Pt {
  const a = (-(e.angle ?? 0) * Math.PI) / 180;
  if (!a) return [x, y];
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h / 2;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Is (x, y) on the element? `tol` in board units. Frames only answer on their name tag and border. */
export function hits(e: CanvasElement, x: number, y: number, tol: number, byId: Map<string, CanvasElement>): boolean {
  if (e.hidden) return false;
  if (isLine(e)) {
    const g = lineGeometry(e, { byId });
    return distToPolyline(x, y, g.pts) <= Math.max(tol, (e.strokeWidth ?? 2) / 2 + tol / 2);
  }
  if (e.type === 'draw') {
    const pts = (e.points ?? []).map((p): Pt => [e.x + p[0], e.y + p[1]]);
    return distToPolyline(x, y, pts) <= (e.strokeWidth ?? 3) / 2 + tol;
  }
  const [lx, ly] = localPoint(e, x, y);
  if (e.type === 'frame') {
    const label = lx >= e.x && lx <= e.x + Math.max(80, Math.min(e.w, 260)) && ly >= e.y - 24 && ly <= e.y;
    const inside = lx >= e.x - tol && lx <= e.x + e.w + tol && ly >= e.y - tol && ly <= e.y + e.h + tol;
    const border = inside && (lx <= e.x + tol || lx >= e.x + e.w - tol || ly <= e.y + tol || ly >= e.y + e.h - tol);
    return label || border;
  }
  if (e.type === 'ellipse') {
    const rx = e.w / 2 + tol;
    const ry = e.h / 2 + tol;
    return ((lx - e.x - e.w / 2) / rx) ** 2 + ((ly - e.y - e.h / 2) / ry) ** 2 <= 1;
  }
  if (e.type === 'diamond') {
    const hw = e.w / 2 + tol;
    const hh = e.h / 2 + tol;
    return Math.abs(lx - e.x - e.w / 2) / hw + Math.abs(ly - e.y - e.h / 2) / hh <= 1;
  }
  return lx >= e.x - tol && lx <= e.x + e.w + tol && ly >= e.y - tol && ly <= e.y + e.h + tol;
}

/** Top-most element under a point (paint order: last = top; frame children above their frame). */
export function hitTest(ordered: CanvasElement[], x: number, y: number, tol: number, byId: Map<string, CanvasElement>): CanvasElement | null {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (e.type === 'frame') continue;
    if (hits(e, x, y, tol, byId)) return e;
  }
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (e.type === 'frame' && hits(e, x, y, tol, byId)) return e;
  }
  return null;
}

/** Shapes an arrow end can stick to (not lines, not the arrow itself). */
export function bindTarget(ordered: CanvasElement[], x: number, y: number, tol: number, byId: Map<string, CanvasElement>, except?: string): CanvasElement | null {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (e.id === except || isLine(e) || e.type === 'draw' || e.hidden) continue;
    if (e.type === 'frame') {
      const inside = x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h;
      if (inside && !ordered.some((o) => o.frameId === e.id && hits(o, x, y, tol, byId))) continue;
    }
    if (hits(e, x, y, tol, byId) || (e.type === 'frame' && x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h)) return e;
  }
  return null;
}

/** Elements fully inside a rectangle. */
export function inRect(ordered: CanvasElement[], r: Box, byId: Map<string, CanvasElement>): CanvasElement[] {
  return ordered.filter((e) => {
    if (e.hidden) return false;
    const b = boxOf(e, byId);
    return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
  });
}

/** Elements whose centre lies inside a lasso polygon. */
export function inLasso(ordered: CanvasElement[], poly: Pt[], byId: Map<string, CanvasElement>): CanvasElement[] {
  if (poly.length < 3) return [];
  return ordered.filter((e) => {
    if (e.hidden) return false;
    const b = boxOf(e, byId);
    return pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, poly);
  });
}

// --- resize ----------------------------------------------------------------------------------------

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePos(b: Box, h: Handle): Pt {
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2;
  const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2;
  return [x, y];
}

/** New box when dragging a handle to (x, y) in the box's frame (Shift keeps the ratio, Alt resizes from the centre). */
export function resizeBox(b: Box, h: Handle, x: number, y: number, keepRatio: boolean, fromCenter: boolean): Box {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dirX = h.includes('w') ? -1 : h.includes('e') ? 1 : 0;
  const dirY = h.includes('n') ? -1 : h.includes('s') ? 1 : 0;
  const ax = fromCenter || !dirX ? cx : dirX === 1 ? b.x : b.x + b.w;
  const ay = fromCenter || !dirY ? cy : dirY === 1 ? b.y : b.y + b.h;
  const k = fromCenter ? 2 : 1;
  let w = dirX ? (x - ax) * dirX * k : b.w;
  let hh = dirY ? (y - ay) * dirY * k : b.h;
  if (keepRatio && b.w > 0 && b.h > 0) {
    if (dirX && dirY) {
      const s = Math.max(Math.abs(w) / b.w, Math.abs(hh) / b.h);
      w = Math.sign(w || 1) * s * b.w;
      hh = Math.sign(hh || 1) * s * b.h;
    } else if (dirX) hh = (Math.abs(w) / b.w) * b.h;
    else if (dirY) w = (Math.abs(hh) / b.h) * b.w;
  }
  const span = (anchor: number, size: number, dir: number): [number, number] => (fromCenter || !dir ? [anchor - size / 2, anchor + size / 2] : dir === 1 ? [anchor, anchor + size] : [anchor - size, anchor]);
  const [x1, x2] = span(ax, w, dirX);
  const [y1, y2] = span(ay, hh, dirY);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/** Scales an element from box `a` to box `b` (positions, sizes, points). */
export function scaleElement(e: CanvasElement, a: Box, b: Box): Partial<CanvasElement> {
  const sx = a.w ? b.w / a.w : 1;
  const sy = a.h ? b.h / a.h : 1;
  const x = b.x + (e.x - a.x) * sx;
  const y = b.y + (e.y - a.y) * sy;
  const out: Partial<CanvasElement> = { x: round(x), y: round(y), w: round(Math.max(1, e.w * sx)), h: round(Math.max(1, e.h * sy)) };
  if (e.points) out.points = e.points.map((p) => (p.length > 2 ? [round(p[0] * sx), round(p[1] * sy), p[2]] : [round(p[0] * sx), round(p[1] * sy)]));
  if (e.type === 'line' || e.type === 'arrow') {
    out.w = round(e.w * sx);
    out.h = round(e.h * sy);
  }
  return out;
}

export const round = (n: number) => Math.round(n * 100) / 100;

// --- smart guides ----------------------------------------------------------------------------------------

export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Snaps a moving box to the edges/centres of other boxes (within `tol`); returns the offset and guide lines. */
export function snapBox(b: Box, others: Box[], tol: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [b.x, b.x + b.w / 2, b.x + b.w];
  const ys = [b.y, b.y + b.h / 2, b.y + b.h];
  let bestX: { d: number; at: number; o: Box } | null = null;
  let bestY: { d: number; at: number; o: Box } | null = null;
  for (const o of others) {
    for (const ox of [o.x, o.x + o.w / 2, o.x + o.w])
      for (const x of xs) {
        const d = ox - x;
        if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: ox, o };
      }
    for (const oy of [o.y, o.y + o.h / 2, o.y + o.h])
      for (const y of ys) {
        const d = oy - y;
        if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: oy, o };
      }
  }
  const guides: Guide[] = [];
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  if (bestX) {
    const all = others.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - bestX!.at) < 0.5));
    const top = Math.min(b.y + dy, ...all.map((o) => o.y));
    const bottom = Math.max(b.y + dy + b.h, ...all.map((o) => o.y + o.h));
    guides.push({ x1: bestX.at, y1: top, x2: bestX.at, y2: bottom });
  }
  if (bestY) {
    const all = others.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - bestY!.at) < 0.5));
    const left = Math.min(b.x + dx, ...all.map((o) => o.x));
    const right = Math.max(b.x + dx + b.w, ...all.map((o) => o.x + o.w));
    guides.push({ x1: left, y1: bestY.at, x2: right, y2: bestY.at });
  }
  return { dx, dy, guides };
}

/** The frame (top-most, not in `except`) whose area contains a point. */
export function frameAt(ordered: CanvasElement[], x: number, y: number, except: Set<string>): CanvasElement | null {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const f = ordered[i];
    if (f.type !== 'frame' || f.hidden || except.has(f.id)) continue;
    if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) return f;
  }
  return null;
}
