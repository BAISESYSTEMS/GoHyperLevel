/**
 * Canvas renderer: scene JSON → display list (paths, text runs, images, groups) → SVG. The same
 * display list feeds the PDF writer and the server's PNG rasterizer, and the editor shows each element
 * through `elementSvg`, so what people see is what gets exported.
 *
 * Safety: every string that reaches the SVG is escaped; images are limited to files of the media
 * library (or data: URIs of raster images the browser inlines for downloads); icons are static data.
 * Nothing a user typed is ever emitted as markup.
 *
 * Pure code (also used in the browser).
 */

import { CARD_LABELS, DEFAULT_INK, type Box, type CanvasElement, type CardKind, type ChartData, type FontKey, type Head, elementBox, sortByZ, unionBox } from './canvas-model.js';
import { type Cmd, type Mat, type Pt, cmdsToD, ellipseCmds, flatten, mul, parsePathD, pointAlong, polyCmds, rectCmds, rotateAround, scale, sliceCmds, smoothCmds, translate } from './canvas-path.js';
import { hachure, rng, roughEllipse, roughEllipsePoints, roughFillShape, roughPolygon, roughPolyline, type Rand } from './canvas-rough.js';
import { FONT_STACK, fitFontSize, layoutText, textWidth } from './canvas-text.js';
import { CANVAS_ICONS } from './canvas-icons.js';

// --- display list -------------------------------------------------------------------------------

export type Prim =
  | { t: 'path'; d: Cmd[]; fill?: string; stroke?: string; sw?: number; dash?: number[]; cap?: 'round' | 'butt' | 'square'; join?: 'round' | 'miter' | 'bevel'; opacity?: number; evenodd?: boolean }
  | { t: 'text'; x: number; y: number; lines: string[]; size: number; font: FontKey; bold?: boolean; italic?: boolean; anchor: 'start' | 'middle' | 'end'; color: string; lh: number; opacity?: number }
  | { t: 'image'; x: number; y: number; w: number; h: number; src: string; fit: 'cover' | 'contain'; opacity?: number; radius?: number }
  | { t: 'group'; m?: Mat; clip?: Cmd[]; opacity?: number; children: Prim[]; id?: string };

/** Live data of a CRM card (resolved by the server with the viewer's rights). */
export interface CardData {
  ok: boolean;
  error?: string;
  title?: string;
  subtitle?: string;
  badge?: { text: string; tone: 'green' | 'red' | 'blue' | 'yellow' | 'gray' | 'purple' };
  fields?: [string, string][];
  /** App path that opens the record. */
  url?: string;
  updatedAt?: string;
  chart?: ChartData;
  stages?: { name: string; count: number; value: string; deals: { name: string; value: string }[] }[];
  total?: string;
}

export const cardKey = (kind: string, cardId: string) => `${kind}:${cardId}`;

export interface RenderCtx {
  byId: Map<string, CanvasElement>;
  cards?: Record<string, CardData>;
  /** Public share links: CRM cards never show live data. */
  publicView?: boolean;
  /** Maps a media-library path to the href used in the output (absolute URL, data: URI …). */
  imageHref?: (src: string) => string | undefined;
  /** Element whose text is being edited in the browser (its text is left out). */
  editing?: string;
  /** Background behind arrow labels. */
  labelBg?: string;
}

const PALETTE = ['#4263eb', '#f76707', '#37b24d', '#ae3ec9', '#1098ad', '#f59f00', '#e64980', '#868e96'];
export const CARD_COLORS: Record<CardKind, string> = {
  contact: '#1971c2',
  company: '#0c8599',
  deal: '#2f9e44',
  task: '#f08c00',
  ticket: '#e03131',
  appointment: '#9c36b5',
  project: '#4263eb',
  report: '#5f3dc4',
  pipeline: '#2b8a3e',
};
export const CARD_ICONS: Record<CardKind, string> = {
  contact: 'user',
  company: 'building-2',
  deal: 'briefcase',
  task: 'square-check-big',
  ticket: 'ticket',
  appointment: 'calendar-days',
  project: 'folder-kanban',
  report: 'chart-pie',
  pipeline: 'kanban',
};
const TONES: Record<string, [string, string]> = {
  green: ['#2b8a3e', '#ebfbee'],
  red: ['#c92a2a', '#fff5f5'],
  blue: ['#1864ab', '#e7f5ff'],
  yellow: ['#e67700', '#fff9db'],
  gray: ['#495057', '#f1f3f5'],
  purple: ['#6741d9', '#f3f0ff'],
};

const visible = (c: string | undefined) => !!c && c !== 'transparent';

function dashFor(el: CanvasElement, sw: number): number[] | undefined {
  if (el.strokeStyle === 'dashed') return [sw * 4 + 4, sw * 2 + 6];
  if (el.strokeStyle === 'dotted') return [0.1, sw * 2 + 4];
  return undefined;
}

function text(x: number, y: number, lines: string[], size: number, color: string, o: { font?: FontKey; bold?: boolean; italic?: boolean; anchor?: 'start' | 'middle' | 'end'; lh?: number } = {}): Prim {
  return { t: 'text', x, y, lines, size, font: o.font ?? 'sans', bold: o.bold, italic: o.italic, anchor: o.anchor ?? 'start', color, lh: o.lh ?? size * 1.25 };
}

/** Text block inside a box (alignment, wrapping, optional auto-fit). */
function textInBox(s: string, box: Box, el: Pick<CanvasElement, 'fontSize' | 'font' | 'bold' | 'italic' | 'align' | 'valign' | 'color'>, o: { fit?: boolean; defaultAlign?: 'left' | 'center' | 'right'; defaultV?: 'top' | 'middle' | 'bottom'; color?: string; maxLines?: number } = {}): Prim | null {
  if (!s) return null;
  const font = el.font ?? 'sans';
  let size = el.fontSize ?? 20;
  if (o.fit) size = fitFontSize(s, size, Math.max(4, box.w), Math.max(4, box.h), { bold: el.bold, font, min: 8 });
  const lay = layoutText(s, size, { maxWidth: Math.max(4, box.w), bold: el.bold, font, maxLines: o.maxLines });
  const align = el.align ?? o.defaultAlign ?? 'left';
  const v = el.valign ?? o.defaultV ?? 'top';
  const x = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w : box.x;
  const y = v === 'middle' ? box.y + (box.h - lay.height) / 2 : v === 'bottom' ? box.y + box.h - lay.height : box.y;
  return text(x, y, lay.lines, size, o.color ?? el.color ?? DEFAULT_INK, { font, bold: el.bold, italic: el.italic, anchor: align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start', lh: lay.lineHeight });
}

// --- shapes ---------------------------------------------------------------------------------------

function shapeOutline(el: CanvasElement): { cmds: Cmd[]; poly: Pt[] } {
  const { x, y, w, h } = el;
  if (el.type === 'ellipse') {
    const poly: Pt[] = [];
    for (let i = 0; i < 32; i++) poly.push([x + w / 2 + (w / 2) * Math.cos((i / 32) * Math.PI * 2), y + h / 2 + (h / 2) * Math.sin((i / 32) * Math.PI * 2)]);
    return { cmds: ellipseCmds(x + w / 2, y + h / 2, w / 2, h / 2), poly };
  }
  if (el.type === 'diamond') {
    const poly: Pt[] = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    return { cmds: polyCmds(poly, true), poly };
  }
  const r = el.radius ?? 0;
  const poly: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  return { cmds: rectCmds(x, y, w, h, r), poly };
}

function shapePrims(el: CanvasElement, ctx: RenderCtx): Prim[] {
  const out: Prim[] = [];
  const sw = el.strokeWidth ?? 2;
  const stroke = el.stroke ?? DEFAULT_INK;
  const { cmds, poly } = shapeOutline(el);
  if (el.sketch) {
    const r = rng(el.seed ?? 1);
    if (visible(el.fill)) {
      const style = el.fillStyle ?? 'hachure';
      if (style === 'solid') {
        const pts = el.type === 'ellipse' ? roughEllipsePoints(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, r) : poly;
        out.push({ t: 'path', d: roughFillShape(pts, r), fill: el.fill });
      } else {
        const gap = Math.max(5, sw * 4);
        const d = hachure(poly, r, gap, -41);
        if (style === 'cross') d.push(...hachure(poly, r, gap, 49));
        out.push({ t: 'path', d, stroke: el.fill, sw: Math.max(1, sw * 0.6), cap: 'round' });
      }
    }
    if (sw > 0 && visible(stroke)) {
      const d = el.type === 'ellipse' ? roughEllipse(el.x + el.w / 2, el.y + el.h / 2, el.w / 2, el.h / 2, r) : roughPolygon(poly, r);
      out.push({ t: 'path', d, stroke, sw, cap: 'round', join: 'round', dash: dashFor(el, sw) });
    }
  } else {
    out.push({ t: 'path', d: cmds, fill: visible(el.fill) ? el.fill : undefined, stroke: sw > 0 && visible(stroke) ? stroke : undefined, sw, dash: dashFor(el, sw), cap: el.strokeStyle === 'dotted' ? 'round' : undefined, join: 'round' });
  }
  if (el.text && ctx.editing !== el.id) {
    const inset = el.type === 'ellipse' ? { x: el.w * 0.15, y: el.h * 0.15 } : el.type === 'diamond' ? { x: el.w * 0.25, y: el.h * 0.25 } : { x: 10, y: 8 };
    const t = textInBox(el.text, { x: el.x + inset.x, y: el.y + inset.y, w: el.w - inset.x * 2, h: el.h - inset.y * 2 }, { ...el, color: el.color ?? stroke }, { defaultAlign: 'center', defaultV: 'middle', fit: true });
    if (t) out.push(t);
  }
  return out;
}

// --- lines & arrows ---------------------------------------------------------------------------------

type Side = 'left' | 'right' | 'top' | 'bottom';
const NORMAL: Record<Side, Pt> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

function boxOf(t: CanvasElement): Box {
  return { x: t.x, y: t.y, w: t.w, h: t.h };
}

/** Where a ray from the target's centre towards `toward` leaves its outline (plus a small gap). */
function edgePoint(t: CanvasElement, toward: Pt, gap: number): { p: Pt; side: Side } {
  const b = boxOf(t);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  let dx = toward[0] - cx;
  const dy = toward[1] - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dx = 1;
  const hw = Math.max(b.w / 2, 0.5);
  const hh = Math.max(b.h / 2, 0.5);
  let k: number;
  if (t.type === 'ellipse') k = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (t.type === 'diamond') k = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else k = Math.min(Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  const p: Pt = [cx + dx * k + (dx / len) * gap, cy + dy * k + (dy / len) * gap];
  const side: Side = Math.abs(dx) / hw > Math.abs(dy) / hh ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
  return { p, side };
}

function sideFromAnchor(a: [number, number]): Side {
  const d = [a[0], 1 - a[0], a[1], 1 - a[1]];
  const i = d.indexOf(Math.min(...d));
  return (['left', 'right', 'top', 'bottom'] as Side[])[i];
}

/** Elbow side of a target towards a point (dominant direction). */
function facingSide(t: Box, toward: Pt): Side {
  const dx = toward[0] - (t.x + t.w / 2);
  const dy = toward[1] - (t.y + t.h / 2);
  return Math.abs(dx) * Math.max(t.h, 1) > Math.abs(dy) * Math.max(t.w, 1) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'bottom' : 'top';
}

/** Sides for an elbow between two boxes: along the axis with the larger gap, so connectors stay consistent. */
function elbowSides(a: Box, b: Box): [Side, Side] {
  const hGap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const vGap = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (vGap > hGap) return b.y + b.h / 2 >= a.y + a.h / 2 ? ['bottom', 'top'] : ['top', 'bottom'];
  return b.x + b.w / 2 >= a.x + a.w / 2 ? ['right', 'left'] : ['left', 'right'];
}

function sideMid(b: Box, s: Side, gap: number): Pt {
  switch (s) {
    case 'left':
      return [b.x - gap, b.y + b.h / 2];
    case 'right':
      return [b.x + b.w + gap, b.y + b.h / 2];
    case 'top':
      return [b.x + b.w / 2, b.y - gap];
    case 'bottom':
      return [b.x + b.w / 2, b.y + b.h + gap];
  }
}

export interface LineGeometry {
  /** Path in board coordinates. */
  cmds: Cmd[];
  /** Flattened polyline (hit tests, label position, heads). */
  pts: Pt[];
  start: Pt;
  end: Pt;
  startAngle: number;
  endAngle: number;
}

const live = (ctx: { byId: Map<string, CanvasElement> }, id: string | undefined) => {
  const t = id ? ctx.byId.get(id) : undefined;
  return t && !t.hidden && t.type !== 'line' && t.type !== 'arrow' ? t : undefined;
};

/** Geometry of a line/arrow with its bindings resolved against the current scene. */
export function lineGeometry(el: CanvasElement, ctx: { byId: Map<string, CanvasElement> }): LineGeometry {
  const raw = (el.points?.length ? el.points : [[0, 0], [el.w, el.h]]).map((p): Pt => [el.x + p[0], el.y + p[1]]);
  if (raw.length === 1) raw.push([raw[0][0] + 1, raw[0][1]]);
  const sT = live(ctx, el.start?.id);
  const eT = live(ctx, el.end?.id);
  const gap = 4 + (el.strokeWidth ?? 2) / 2;
  const route = el.route ?? 'straight';
  const waypoints = route === 'elbow' ? [] : raw.slice(1, -1);
  const center = (t: CanvasElement): Pt => [t.x + t.w / 2, t.y + t.h / 2];
  let S = raw[0];
  let E = raw[raw.length - 1];
  let sSide: Side | undefined;
  let eSide: Side | undefined;
  const sTowards = (): Pt => waypoints[0] ?? (eT ? (el.end?.anchor ? [eT.x + el.end.anchor[0] * eT.w, eT.y + el.end.anchor[1] * eT.h] : center(eT)) : E);
  const eTowards = (): Pt => waypoints[waypoints.length - 1] ?? (sT ? (el.start?.anchor ? [sT.x + el.start.anchor[0] * sT.w, sT.y + el.start.anchor[1] * sT.h] : center(sT)) : S);
  if (route === 'elbow') {
    const both = sT && eT && !el.start?.anchor && !el.end?.anchor ? elbowSides(boxOf(sT), boxOf(eT)) : null;
    if (both && sT && eT) {
      [sSide, eSide] = both;
      S = sideMid(boxOf(sT), sSide, gap);
      E = sideMid(boxOf(eT), eSide, gap);
    }
    if (sT && !both) {
      sSide = el.start?.anchor ? sideFromAnchor(el.start.anchor) : facingSide(boxOf(sT), sTowards());
      S = el.start?.anchor ? [sT.x + el.start.anchor[0] * sT.w + NORMAL[sSide][0] * gap, sT.y + el.start.anchor[1] * sT.h + NORMAL[sSide][1] * gap] : sideMid(boxOf(sT), sSide, gap);
    }
    if (eT && !both) {
      eSide = el.end?.anchor ? sideFromAnchor(el.end.anchor) : facingSide(boxOf(eT), eTowards());
      E = el.end?.anchor ? [eT.x + el.end.anchor[0] * eT.w + NORMAL[eSide][0] * gap, eT.y + el.end.anchor[1] * eT.h + NORMAL[eSide][1] * gap] : sideMid(boxOf(eT), eSide, gap);
    }
  } else {
    if (sT) {
      if (el.start?.anchor) S = [sT.x + el.start.anchor[0] * sT.w, sT.y + el.start.anchor[1] * sT.h];
      else ({ p: S, side: sSide } = edgePoint(sT, sTowards(), gap));
    }
    if (eT) {
      if (el.end?.anchor) E = [eT.x + el.end.anchor[0] * eT.w, eT.y + el.end.anchor[1] * eT.h];
      else ({ p: E, side: eSide } = edgePoint(eT, eTowards(), gap));
    }
  }
  let cmds: Cmd[];
  let pts: Pt[];
  if (route === 'elbow') {
    const sS = sSide ?? (Math.abs(E[0] - S[0]) >= Math.abs(E[1] - S[1]) ? (E[0] >= S[0] ? 'right' : 'left') : E[1] >= S[1] ? 'bottom' : 'top');
    const eS = eSide ?? (sS === 'right' || sS === 'left' ? (E[0] >= S[0] ? 'left' : 'right') : E[1] >= S[1] ? 'top' : 'bottom');
    pts = elbowPoints(S, sS, E, eS);
    cmds = roundedPolyline(pts, 10);
  } else if (route === 'curved') {
    const all = [S, ...waypoints, E];
    if (all.length === 2) {
      const len = Math.hypot(E[0] - S[0], E[1] - S[1]);
      const k = len / 2.6;
      const sN = sSide ? NORMAL[sSide] : ([(E[0] - S[0]) / (len || 1), 0] as Pt);
      const eN = eSide ? NORMAL[eSide] : ([-(E[0] - S[0]) / (len || 1), 0] as Pt);
      const c1: Pt = sSide ? [S[0] + sN[0] * k, S[1] + sN[1] * k] : [S[0] + (E[0] - S[0]) / 3, S[1] + (E[1] - S[1]) / 3 - len * 0.12];
      const c2: Pt = eSide ? [E[0] + eN[0] * k, E[1] + eN[1] * k] : [S[0] + ((E[0] - S[0]) * 2) / 3, S[1] + ((E[1] - S[1]) * 2) / 3 - len * 0.12];
      cmds = [['M', S[0], S[1]], ['C', c1[0], c1[1], c2[0], c2[1], E[0], E[1]]];
    } else cmds = smoothCmds(all);
    pts = flatten(cmds, 1)[0]?.pts ?? [S, E];
  } else {
    pts = [S, ...waypoints, E];
    cmds = polyCmds(pts);
  }
  const n = pts.length;
  return {
    cmds,
    pts,
    start: S,
    end: E,
    startAngle: Math.atan2(pts[0][1] - pts[Math.min(1, n - 1)][1], pts[0][0] - pts[Math.min(1, n - 1)][0]),
    endAngle: Math.atan2(pts[n - 1][1] - pts[Math.max(0, n - 2)][1], pts[n - 1][0] - pts[Math.max(0, n - 2)][0]),
  };
}

function elbowPoints(S: Pt, sS: Side, E: Pt, eS: Side): Pt[] {
  const off = 18;
  const s1: Pt = [S[0] + NORMAL[sS][0] * off, S[1] + NORMAL[sS][1] * off];
  const e1: Pt = [E[0] + NORMAL[eS][0] * off, E[1] + NORMAL[eS][1] * off];
  const sH = sS === 'left' || sS === 'right';
  const eH = eS === 'left' || eS === 'right';
  let mid: Pt[];
  if (sH && eH) {
    const mx = (s1[0] + e1[0]) / 2;
    const ok = (sS === 'right' ? mx >= s1[0] : mx <= s1[0]) && (eS === 'left' ? mx <= e1[0] : mx >= e1[0]);
    if (ok) mid = [[mx, s1[1]], [mx, e1[1]]];
    else {
      const my = (s1[1] + e1[1]) / 2;
      mid = [[s1[0], my], [e1[0], my]];
    }
  } else if (!sH && !eH) {
    const my = (s1[1] + e1[1]) / 2;
    const ok = (sS === 'bottom' ? my >= s1[1] : my <= s1[1]) && (eS === 'top' ? my <= e1[1] : my >= e1[1]);
    if (ok) mid = [[s1[0], my], [e1[0], my]];
    else {
      const mx = (s1[0] + e1[0]) / 2;
      mid = [[mx, s1[1]], [mx, e1[1]]];
    }
  } else if (sH) mid = [[e1[0], s1[1]]];
  else mid = [[s1[0], e1[1]]];
  const pts = [S, s1, ...mid, e1, E];
  // drop duplicates and collinear points
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      if ((Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - p[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - p[1]) < 0.01)) out.pop();
    }
    out.push(p);
  }
  return out;
}

function roundedPolyline(pts: Pt[], radius: number): Cmd[] {
  if (pts.length < 3) return polyCmds(pts);
  const out: Cmd[] = [['M', pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py);
    const l2 = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    out.push(['L', x - ((x - px) / (l1 || 1)) * r, y - ((y - py) / (l1 || 1)) * r]);
    out.push(['Q', x, y, x + ((nx - x) / (l2 || 1)) * r, y + ((ny - y) / (l2 || 1)) * r]);
  }
  const last = pts[pts.length - 1];
  out.push(['L', last[0], last[1]]);
  return out;
}

function headPrims(head: Head | undefined, tip: Pt, angle: number, sw: number, stroke: string, r: Rand | null): Prim[] {
  if (!head || head === 'none') return [];
  const size = Math.min(30, Math.max(10, sw * 4 + 6));
  const at = (a: number, len: number): Pt => [tip[0] - len * Math.cos(angle + a), tip[1] - len * Math.sin(angle + a)];
  switch (head) {
    case 'arrow': {
      const a = at(0.48, size);
      const b = at(-0.48, size);
      const d: Cmd[] = r ? [...roughPolyline([a, tip], r), ...roughPolyline([tip, b], r)] : [['M', a[0], a[1]], ['L', tip[0], tip[1]], ['L', b[0], b[1]]];
      return [{ t: 'path', d, stroke, sw, cap: 'round', join: 'round' }];
    }
    case 'triangle': {
      const a = at(0.42, size);
      const b = at(-0.42, size);
      return [{ t: 'path', d: polyCmds([tip, a, b], true), fill: stroke, stroke, sw: Math.max(1, sw / 2), join: 'round' }];
    }
    case 'diamond': {
      const a = at(0.5, size * 0.6);
      const c = at(0, size * 1.1);
      const b = at(-0.5, size * 0.6);
      return [{ t: 'path', d: polyCmds([tip, a, c, b], true), fill: stroke, stroke, sw: Math.max(1, sw / 2), join: 'round' }];
    }
    case 'dot': {
      const rr = Math.max(3, size * 0.3);
      const c = at(0, rr);
      return [{ t: 'path', d: ellipseCmds(c[0], c[1], rr, rr), fill: stroke }];
    }
    case 'bar': {
      const a: Pt = [tip[0] + Math.cos(angle + Math.PI / 2) * size * 0.5, tip[1] + Math.sin(angle + Math.PI / 2) * size * 0.5];
      const b: Pt = [tip[0] - Math.cos(angle + Math.PI / 2) * size * 0.5, tip[1] - Math.sin(angle + Math.PI / 2) * size * 0.5];
      return [{ t: 'path', d: [['M', a[0], a[1]], ['L', b[0], b[1]]], stroke, sw, cap: 'round' }];
    }
  }
  return [];
}

function linePrims(el: CanvasElement, ctx: RenderCtx): Prim[] {
  const g = lineGeometry(el, ctx);
  const sw = el.strokeWidth ?? 2;
  const stroke = el.stroke ?? DEFAULT_INK;
  const r = el.sketch ? rng(el.seed ?? 1) : null;
  const out: Prim[] = [];
  let d: Cmd[];
  if (!r) d = g.cmds;
  else if (el.route === 'curved') {
    // two passes of the same curve with wobbly control points
    const j = () => (r() - 0.5) * 4;
    d = [];
    for (let pass = 0; pass < 2; pass++)
      for (const c of g.cmds) d.push(c[0] === 'C' ? ['C', c[1] + j(), c[2] + j(), c[3] + j(), c[4] + j(), c[5] + j() * 0.4, c[6] + j() * 0.4] : c[0] === 'M' ? ['M', c[1] + j() * 0.4, c[2] + j() * 0.4] : c);
  } else d = roughPolyline(g.pts, r, { roughness: 0.8 });
  out.push({ t: 'path', d, stroke, sw, dash: dashFor(el, sw), cap: 'round', join: 'round' });
  out.push(...headPrims(el.startHead, g.start, g.startAngle, sw, stroke, r));
  out.push(...headPrims(el.type === 'arrow' ? (el.endHead ?? 'arrow') : el.endHead, g.end, g.endAngle, sw, stroke, r));
  if (el.text && ctx.editing !== el.id) {
    const size = el.fontSize ?? 16;
    const lay = layoutText(el.text, size, { maxWidth: 240, font: el.font, bold: el.bold });
    const { p } = pointAlong(g.pts, 0.5);
    const pad = 4;
    const bg = ctx.labelBg ?? '#ffffff';
    out.push({ t: 'path', d: rectCmds(p[0] - lay.width / 2 - pad, p[1] - lay.height / 2 - pad / 2, lay.width + pad * 2, lay.height + pad, 4), fill: bg });
    out.push(text(p[0], p[1] - lay.height / 2, lay.lines, size, el.color ?? stroke, { font: el.font, bold: el.bold, italic: el.italic, anchor: 'middle', lh: lay.lineHeight }));
  }
  return out;
}

// --- freehand --------------------------------------------------------------------------------------

/** Outline of a pen stroke: width follows pressure, smoothed, tapered ends, round caps. */
export function freehandCmds(points: number[][], size: number, ox = 0, oy = 0): Cmd[] {
  if (!points.length) return [];
  if (points.length === 1 || (points.length === 2 && Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) < 0.5)) {
    const r = size * 0.6;
    return ellipseCmds(ox + points[0][0], oy + points[0][1], r, r);
  }
  // streamline: each point eases towards the input
  const pts: { x: number; y: number; p: number }[] = [];
  let px = points[0][0];
  let py = points[0][1];
  for (const q of points) {
    px += (q[0] - px) * 0.6;
    py += (q[1] - py) * 0.6;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(px - last.x, py - last.y) < 0.6) continue;
    pts.push({ x: px, y: py, p: q[2] ?? 0.5 });
  }
  const lastIn = points[points.length - 1];
  pts.push({ x: lastIn[0], y: lastIn[1], p: lastIn[2] ?? 0.5 });
  if (pts.length < 2) return ellipseCmds(ox + pts[0].x, oy + pts[0].y, size * 0.6, size * 0.6);
  // running length for the tapers
  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = dist[dist.length - 1];
  const taper = Math.min(total * 0.25, size * 4);
  const left: Pt[] = [];
  const right: Pt[] = [];
  let pr = pts[0].p;
  for (let i = 0; i < pts.length; i++) {
    pr += (pts[i].p - pr) * 0.35;
    let w = (size / 2) * (0.45 + pr * 1.1);
    if (taper > 0) {
      const t = Math.min(dist[i] / taper, (total - dist[i]) / taper, 1);
      w *= 0.35 + 0.65 * Math.sin((Math.max(0, t) * Math.PI) / 2);
    }
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    left.push([ox + pts[i].x - dy * w, oy + pts[i].y + dx * w]);
    right.push([ox + pts[i].x + dy * w, oy + pts[i].y - dx * w]);
  }
  const capPts = (c: { x: number; y: number }, from: Pt, to: Pt): Pt[] => {
    const cx = ox + c.x;
    const cy = oy + c.y;
    const a0 = Math.atan2(from[1] - cy, from[0] - cx);
    let a1 = Math.atan2(to[1] - cy, to[0] - cx);
    if (a1 > a0) a1 -= Math.PI * 2;
    const rr = Math.hypot(from[0] - cx, from[1] - cy);
    const out: Pt[] = [];
    for (let k = 1; k < 6; k++) {
      const a = a0 + ((a1 - a0) * k) / 6;
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
    return out;
  };
  const endCap = capPts(pts[pts.length - 1], left[left.length - 1], right[right.length - 1]);
  const startCap = capPts(pts[0], right[0], left[0]);
  const ring = [...left, ...endCap, ...right.reverse(), ...startCap];
  // quadratic curves through midpoints = smooth outline
  const out: Cmd[] = [];
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const m0 = mid(ring[0], ring[1]);
  out.push(['M', m0[0], m0[1]]);
  for (let i = 1; i < ring.length; i++) {
    const m = mid(ring[i], ring[(i + 1) % ring.length]);
    out.push(['Q', ring[i][0], ring[i][1], m[0], m[1]]);
  }
  out.push(['Z']);
  return out;
}

// --- icons -----------------------------------------------------------------------------------------

/** Icon shapes (24×24 grid) as path commands. */
export function iconCmds(name: string): Cmd[] | null {
  const icon = CANVAS_ICONS[name];
  if (!icon) return null;
  const out: Cmd[] = [];
  for (const [tag, a] of icon[2]) {
    const n = (k: string) => Number(a[k] ?? 0);
    switch (tag) {
      case 'path':
        out.push(...parsePathD(String(a.d ?? '')));
        break;
      case 'circle':
        out.push(...ellipseCmds(n('cx'), n('cy'), n('r'), n('r')));
        break;
      case 'ellipse':
        out.push(...ellipseCmds(n('cx'), n('cy'), n('rx'), n('ry')));
        break;
      case 'rect':
        out.push(...rectCmds(n('x'), n('y'), n('width'), n('height'), n('rx')));
        break;
      case 'line':
        out.push(['M', n('x1'), n('y1')], ['L', n('x2'), n('y2')]);
        break;
      case 'polyline':
      case 'polygon': {
        const nums = String(a.points ?? '').trim().split(/[\s,]+/).map(Number);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        out.push(...polyCmds(pts, tag === 'polygon'));
        break;
      }
    }
  }
  return out;
}

const iconCache = new Map<string, Cmd[] | null>();
function cachedIcon(name: string) {
  if (!iconCache.has(name)) iconCache.set(name, iconCmds(name));
  return iconCache.get(name)!;
}

/** An icon drawn into a box (keeps aspect ratio). */
export function iconPrim(name: string, x: number, y: number, size: number, color: string, sw = 2): Prim {
  const cmds = cachedIcon(name);
  const k = size / 24;
  if (!cmds) return { t: 'path', d: rectCmds(x + size * 0.15, y + size * 0.15, size * 0.7, size * 0.7, size * 0.12), stroke: color, sw: sw * k, join: 'round' };
  return { t: 'group', m: mul(translate(x, y), scale(k)), children: [{ t: 'path', d: cmds, stroke: color, sw, cap: 'round', join: 'round' }] };
}

// --- tables & charts ---------------------------------------------------------------------------------

function tablePrims(el: CanvasElement): Prim[] {
  const rows = el.cells?.length ? el.cells : [['']];
  const nCols = Math.max(1, ...rows.map((r) => r.length));
  const rh = el.h / rows.length;
  const cw = el.w / nCols;
  const stroke = el.stroke ?? '#adb5bd';
  const size = el.fontSize ?? 14;
  const out: Prim[] = [{ t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 0), fill: visible(el.fill) ? el.fill : undefined }];
  if (el.header) out.push({ t: 'path', d: rectCmds(el.x, el.y, el.w, rh, 0), fill: '#f1f3f5' });
  const grid: Cmd[] = [];
  for (let r = 1; r < rows.length; r++) grid.push(['M', el.x, el.y + r * rh], ['L', el.x + el.w, el.y + r * rh]);
  for (let c = 1; c < nCols; c++) grid.push(['M', el.x + c * cw, el.y], ['L', el.x + c * cw, el.y + el.h]);
  out.push({ t: 'path', d: grid, stroke, sw: 1 });
  out.push({ t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 0), stroke, sw: el.strokeWidth ?? 1 });
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const t = textInBox(cell, { x: el.x + c * cw + 8, y: el.y + r * rh + 4, w: cw - 16, h: rh - 8 }, { fontSize: size, font: el.font, bold: (el.header && r === 0) || el.bold, color: el.color, align: el.align }, { defaultV: 'middle', maxLines: Math.max(1, Math.floor((rh - 8) / (size * 1.25))) });
      if (t) out.push(t);
    }),
  );
  return out;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
};
const fmtNum = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Tsd.` : v.toLocaleString('de-DE', { maximumFractionDigits: 2 }));

/** A simple chart into a box (bars, lines, areas, pie, donut). */
export function chartPrims(chart: ChartData, b: Box, color = DEFAULT_INK): Prim[] {
  const out: Prim[] = [];
  const muted = '#868e96';
  let top = b.y + 8;
  if (chart.title) {
    out.push(text(b.x + 12, b.y + 10, [chart.title], 15, color, { bold: true }));
    top += 26;
  }
  const series = chart.series.length ? chart.series : [{ name: '', values: [] }];
  const labels = chart.labels;
  if (chart.kind === 'pie' || chart.kind === 'donut') {
    const vals = (series[0].values ?? []).map((v) => Math.max(0, v));
    const sum = vals.reduce((s, v) => s + v, 0) || 1;
    const legendW = Math.min(170, b.w * 0.42);
    const r = Math.max(10, Math.min((b.w - legendW - 30) / 2, (b.y + b.h - top - 12) / 2));
    const cx = b.x + 14 + r;
    const cy = top + (b.y + b.h - top) / 2;
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const da = (v / sum) * Math.PI * 2;
      if (da > 0) out.push({ t: 'path', d: sliceCmds(cx, cy, r, a, a + da, chart.kind === 'donut' ? r * 0.58 : 0), fill: series[0].color && vals.length === 1 ? series[0].color : PALETTE[i % PALETTE.length], stroke: '#ffffff', sw: 1.5 });
      a += da;
    });
    if (chart.kind === 'donut') out.push(text(cx, cy - 9, [fmtNum(vals.reduce((s, v) => s + v, 0))], 15, color, { bold: true, anchor: 'middle' }));
    const lx = cx + r + 18;
    const n = Math.min(vals.length, Math.floor((b.y + b.h - top) / 20));
    const ly = cy - (n * 20) / 2;
    for (let i = 0; i < n; i++) {
      out.push({ t: 'path', d: rectCmds(lx, ly + i * 20 + 3, 10, 10, 2), fill: PALETTE[i % PALETTE.length] });
      const label = `${labels[i] ?? ''} · ${Math.round((vals[i] / sum) * 100)} %`;
      out.push(text(lx + 16, ly + i * 20, [ellipsize(label, b.x + b.w - lx - 22, 12)], 12, color));
    }
    return out;
  }
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const left = b.x + 12 + Math.max(24, textWidth(fmtNum(max), 11) + 6);
  const bottom = b.y + b.h - 24;
  const right = b.x + b.w - 12;
  const legend = series.length > 1;
  const plotTop = top + (legend ? 18 : 4);
  const ph = Math.max(10, bottom - plotTop);
  const pw = Math.max(10, right - left);
  const grid: Cmd[] = [];
  for (let i = 0; i <= 4; i++) {
    const y = bottom - (ph * i) / 4;
    grid.push(['M', left, y], ['L', right, y]);
    out.push(text(left - 6, y - 7, [fmtNum((max * i) / 4)], 11, muted, { anchor: 'end' }));
  }
  out.push({ t: 'path', d: grid, stroke: '#e9ecef', sw: 1 });
  if (legend) {
    let lx = left;
    series.forEach((s, i) => {
      out.push({ t: 'path', d: rectCmds(lx, top + 3, 10, 10, 2), fill: s.color ?? PALETTE[i % PALETTE.length] });
      out.push(text(lx + 14, top, [s.name], 12, color));
      lx += 26 + textWidth(s.name, 12);
    });
  }
  const n = Math.max(labels.length, ...series.map((s) => s.values.length), 1);
  const step = pw / n;
  const labelEvery = Math.max(1, Math.ceil((n * 46) / pw));
  for (let i = 0; i < n; i += labelEvery) out.push(text(left + step * i + step / 2, bottom + 6, [ellipsize(labels[i] ?? '', step * labelEvery - 4, 11)], 11, muted, { anchor: 'middle' }));
  if (chart.kind === 'bar') {
    const group = step * 0.72;
    const bw = group / series.length;
    series.forEach((s, si) =>
      s.values.forEach((v, i) => {
        const h = (Math.max(0, v) / max) * ph;
        if (h > 0) out.push({ t: 'path', d: rectCmds(left + step * i + (step - group) / 2 + bw * si, bottom - h, Math.max(1, bw - 2), h, Math.min(4, bw / 3)), fill: s.color ?? PALETTE[si % PALETTE.length] });
      }),
    );
  } else {
    series.forEach((s, si) => {
      const pts: Pt[] = s.values.map((v, i) => [left + step * i + step / 2, bottom - (Math.max(0, v) / max) * ph]);
      if (!pts.length) return;
      const c = s.color ?? PALETTE[si % PALETTE.length];
      if (chart.kind === 'area') out.push({ t: 'path', d: polyCmds([[pts[0][0], bottom], ...pts, [pts[pts.length - 1][0], bottom]], true), fill: c, opacity: 0.18 });
      out.push({ t: 'path', d: polyCmds(pts), stroke: c, sw: 2.5, join: 'round', cap: 'round' });
      for (const p of pts) out.push({ t: 'path', d: ellipseCmds(p[0], p[1], 3, 3), fill: c });
    });
  }
  out.push({ t: 'path', d: [['M', left, bottom], ['L', right, bottom]], stroke: '#adb5bd', sw: 1 });
  return out;
}

function ellipsize(s: string, max: number, size: number, bold = false): string {
  if (textWidth(s, size, bold) <= max) return s;
  let t = s;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > max) t = t.slice(0, -1);
  return `${t}…`;
}

function chartElementPrims(el: CanvasElement): Prim[] {
  const out: Prim[] = [{ t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 10), fill: visible(el.fill) ? el.fill : undefined, stroke: visible(el.stroke) ? el.stroke : undefined, sw: el.strokeWidth ?? 1 }];
  if (el.chart) out.push(...chartPrims(el.chart, { x: el.x, y: el.y, w: el.w, h: el.h }, el.color ?? DEFAULT_INK));
  return out;
}

// --- CRM cards ----------------------------------------------------------------------------------------

function cardPrims(el: CanvasElement, ctx: RenderCtx): Prim[] {
  const kind = el.card!.kind;
  const accent = CARD_COLORS[kind];
  const data = ctx.publicView ? undefined : ctx.cards?.[cardKey(kind, el.card!.id)];
  const { x, y, w, h } = el;
  const ink = '#212529';
  const muted = '#868e96';
  const out: Prim[] = [
    { t: 'path', d: rectCmds(x, y + 3, w, h, 12), fill: '#000000', opacity: 0.06 },
    { t: 'path', d: rectCmds(x, y, w, h, 12), fill: '#ffffff', stroke: '#dee2e6', sw: 1 },
    { t: 'group', clip: rectCmds(x, y, w, h, 12), children: [{ t: 'path', d: rectCmds(x, y, w, 4, 0), fill: accent }] },
    iconPrim(CARD_ICONS[kind], x + 14, y + 16, 16, accent, 2.2),
    text(x + 36, y + 17, [CARD_LABELS[kind].toUpperCase()], 11, accent, { bold: true }),
  ];
  const pad = 14;
  if (!data || !data.ok) {
    const msg = ctx.publicView ? 'Live-Daten nur im CRM sichtbar' : data?.error ?? 'Lädt Live-Daten …';
    out.push(text(x + pad, y + 46, [ellipsize(el.name || CARD_LABELS[kind], w - pad * 2, 16, true)], 16, ink, { bold: true }));
    out.push(text(x + pad, y + 70, layoutText(msg, 13, { maxWidth: w - pad * 2, maxLines: 3 }).lines, 13, muted));
    return out;
  }
  if (data.badge) {
    const [fg, bg] = TONES[data.badge.tone] ?? TONES.gray;
    const label = ellipsize(data.badge.text, w * 0.42, 11, true);
    const bw = textWidth(label, 11, true) + 14;
    out.push({ t: 'path', d: rectCmds(x + w - pad - bw, y + 13, bw, 20, 10), fill: bg });
    out.push(text(x + w - pad - bw / 2, y + 16, [label], 11, fg, { bold: true, anchor: 'middle' }));
  }
  let cy = y + 42;
  if (kind === 'pipeline' && data.stages) {
    out.push(text(x + pad, cy, [ellipsize(data.title ?? '', w - pad * 2 - 140, 17, true)], 17, ink, { bold: true }));
    if (data.total) out.push(text(x + w - pad, cy + 1, [data.total], 13, muted, { anchor: 'end' }));
    cy += 32;
    const stages = data.stages.slice(0, 8);
    const gap = 10;
    const cw = (w - pad * 2 - gap * (stages.length - 1)) / Math.max(1, stages.length);
    const colH = y + h - pad - cy;
    stages.forEach((s, i) => {
      const cx = x + pad + i * (cw + gap);
      out.push({ t: 'path', d: rectCmds(cx, cy, cw, colH, 8), fill: '#f8f9fa', stroke: '#e9ecef', sw: 1 });
      out.push(text(cx + 8, cy + 8, [ellipsize(s.name, cw - 40, 12, true)], 12, ink, { bold: true }));
      out.push(text(cx + cw - 8, cy + 8, [String(s.count)], 12, muted, { anchor: 'end' }));
      out.push(text(cx + 8, cy + 26, [ellipsize(s.value, cw - 16, 11)], 11, muted));
      const maxDeals = Math.max(0, Math.floor((colH - 50) / 46));
      s.deals.slice(0, maxDeals).forEach((d, k) => {
        const dy = cy + 46 + k * 46;
        out.push({ t: 'path', d: rectCmds(cx + 6, dy, cw - 12, 40, 6), fill: '#ffffff', stroke: '#dee2e6', sw: 1 });
        out.push(text(cx + 12, dy + 5, [ellipsize(d.name, cw - 24, 12, true)], 12, ink, { bold: true }));
        out.push(text(cx + 12, dy + 22, [ellipsize(d.value, cw - 24, 11)], 11, muted));
      });
      if (s.deals.length > maxDeals && maxDeals >= 0) out.push(text(cx + 8, cy + colH - 18, [`+ ${s.deals.length - maxDeals} weitere`], 11, muted));
    });
    return out;
  }
  out.push(text(x + pad, cy, layoutText(data.title ?? '', 16, { maxWidth: w - pad * 2, bold: true, maxLines: 1 }).lines, 16, ink, { bold: true }));
  cy += 22;
  if (data.subtitle) {
    out.push(text(x + pad, cy, [ellipsize(data.subtitle, w - pad * 2, 13)], 13, muted));
    cy += 22;
  }
  if (kind === 'report' && data.chart) {
    out.push(...chartPrims(data.chart, { x: x + 4, y: cy - 4, w: w - 8, h: y + h - cy - 20 }, ink));
  } else {
    const rows = (data.fields ?? []).slice(0, Math.max(0, Math.floor((y + h - cy - 26) / 19)));
    for (const [label, value] of rows) {
      out.push(text(x + pad, cy, [ellipsize(label, w * 0.36, 12)], 12, muted));
      out.push(text(x + pad + w * 0.38, cy, [ellipsize(value, w * 0.62 - pad * 2, 12, true)], 12, ink, { bold: true }));
      cy += 19;
    }
  }
  out.push({ t: 'path', d: ellipseCmds(x + pad + 3, y + h - 15, 3, 3), fill: '#2f9e44' });
  out.push(text(x + pad + 11, y + h - 22, ['Live'], 11, muted));
  if (data.url) out.push(text(x + w - pad, y + h - 22, ['Öffnen ›'], 11, accent, { anchor: 'end', bold: true }));
  return out;
}

// --- per element -----------------------------------------------------------------------------------------

function framePrims(el: CanvasElement, withLabel: boolean): Prim[] {
  const out: Prim[] = [{ t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 0), fill: visible(el.fill) ? el.fill : undefined, stroke: '#ced4da', sw: 1 }];
  if (withLabel) out.push(text(el.x, el.y - 20, [ellipsize(el.name ?? 'Rahmen', Math.max(60, el.w), 14)], 14, '#868e96'));
  return out;
}

function stickyPrims(el: CanvasElement, ctx: RenderCtx): Prim[] {
  const fill = visible(el.fill) ? el.fill! : '#fff3a3';
  const out: Prim[] = [
    { t: 'path', d: rectCmds(el.x + 1, el.y + 5, el.w - 2, el.h, el.radius ?? 4), fill: '#000000', opacity: 0.08 },
    { t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 4), fill },
  ];
  if (el.text && ctx.editing !== el.id) {
    const t = textInBox(el.text, { x: el.x + 16, y: el.y + 14, w: el.w - 32, h: el.h - 28 }, el, { fit: true, defaultAlign: 'center', defaultV: 'middle' });
    if (t) out.push(t);
  }
  return out;
}

function imagePrims(el: CanvasElement, ctx: RenderCtx): Prim[] {
  const href = el.src ? (ctx.imageHref ? ctx.imageHref(el.src) : el.src) : undefined;
  if (!href) return [{ t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 0), fill: '#f1f3f5', stroke: '#ced4da', sw: 1 }, iconPrim('image', el.x + el.w / 2 - 16, el.y + el.h / 2 - 16, 32, '#adb5bd')];
  const out: Prim[] = [{ t: 'image', x: el.x, y: el.y, w: el.w, h: el.h, src: href, fit: el.fit ?? 'cover', radius: el.radius }];
  if ((el.strokeWidth ?? 0) > 0 && visible(el.stroke)) out.push({ t: 'path', d: rectCmds(el.x, el.y, el.w, el.h, el.radius ?? 0), stroke: el.stroke, sw: el.strokeWidth });
  return out;
}

/** Display list of one element in board coordinates (rotation and opacity applied). */
export function elementPrims(el: CanvasElement, ctx: RenderCtx, o: { frameLabel?: boolean } = {}): Prim[] {
  let body: Prim[];
  switch (el.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
      body = shapePrims(el, ctx);
      break;
    case 'line':
    case 'arrow':
      body = linePrims(el, ctx);
      break;
    case 'draw':
      body = [{ t: 'path', d: freehandCmds(el.points ?? [], el.strokeWidth ?? 3, el.x, el.y), fill: el.stroke ?? DEFAULT_INK }];
      break;
    case 'text': {
      const t = ctx.editing === el.id ? null : textInBox(el.text ?? '', { x: el.x, y: el.y, w: el.w, h: el.h }, el, { defaultAlign: 'left' });
      body = t ? [t] : [];
      break;
    }
    case 'sticky':
      body = stickyPrims(el, ctx);
      break;
    case 'frame':
      body = framePrims(el, o.frameLabel !== false);
      break;
    case 'image':
      body = imagePrims(el, ctx);
      break;
    case 'icon':
      body = [iconPrim(el.icon ?? 'star', el.x + (el.w - Math.min(el.w, el.h)) / 2, el.y + (el.h - Math.min(el.w, el.h)) / 2, Math.min(el.w, el.h), el.stroke ?? DEFAULT_INK, el.strokeWidth ?? 2)];
      break;
    case 'table':
      body = tablePrims(el);
      break;
    case 'chart':
      body = chartElementPrims(el);
      break;
    case 'card':
      body = el.card ? cardPrims(el, ctx) : [];
      break;
    default:
      body = [];
  }
  const angle = el.type === 'line' || el.type === 'arrow' ? 0 : el.angle ?? 0;
  const op = el.opacity ?? 1;
  if (!angle && op >= 1) return body;
  return [{ t: 'group', m: angle ? rotateAround(angle, el.x + el.w / 2, el.y + el.h / 2) : undefined, opacity: op < 1 ? op : undefined, children: body }];
}

// --- scene ------------------------------------------------------------------------------------------------

export interface RenderNode {
  el: CanvasElement;
  children?: CanvasElement[];
}

/** Paint order: frames carry their children (clipped), everything else by z. */
export function renderTree(elements: CanvasElement[]): RenderNode[] {
  const shown = elements.filter((e) => !e.hidden);
  const frames = new Map(shown.filter((e) => e.type === 'frame').map((f) => [f.id, [] as CanvasElement[]]));
  const top: CanvasElement[] = [];
  for (const e of sortByZ(shown)) {
    if (e.type !== 'frame' && e.frameId && frames.has(e.frameId)) frames.get(e.frameId)!.push(e);
    else top.push(e);
  }
  return top.map((el) => (el.type === 'frame' ? { el, children: frames.get(el.id) } : { el }));
}

export interface SceneRenderOptions {
  cards?: Record<string, CardData>;
  publicView?: boolean;
  imageHref?: (src: string) => string | undefined;
  /** Only these elements (frames bring their children). */
  ids?: string[];
  /** Only this frame, cut to its size. */
  frameId?: string;
  padding?: number;
  /** Page colour; undefined = transparent. */
  background?: string;
  theme?: 'light' | 'dark';
  /** Thumbnail: scale so the longer side is at most this many px. */
  maxSize?: number;
  /** Prefix of clip-path ids (several SVGs inline on one page need different ones). */
  idPrefix?: string;
}

/** The scene (or a part of it) as a display list in output coordinates, plus its size. */
export function sceneDisplayList(elements: CanvasElement[], o: SceneRenderOptions = {}): { prims: Prim[]; width: number; height: number; box: Box } {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const ctx: RenderCtx = { byId, cards: o.cards, publicView: o.publicView, imageHref: o.imageHref, labelBg: o.background ?? '#ffffff' };
  let tree = renderTree(elements);
  let box: Box | null;
  let frameClip = false;
  if (o.frameId) {
    const node = tree.find((n) => n.el.id === o.frameId && n.el.type === 'frame');
    tree = node ? [node] : [];
    box = node ? { x: node.el.x, y: node.el.y, w: node.el.w, h: node.el.h } : null;
    frameClip = true;
  } else if (o.ids?.length) {
    const want = new Set(o.ids);
    tree = tree
      .map((n): RenderNode | null => (want.has(n.el.id) ? n : n.children ? { el: n.el, children: n.children.filter((c) => want.has(c.id)) } : null))
      .filter((n): n is RenderNode => !!n && (want.has(n.el.id) || !!n.children?.length));
    box = unionBox(tree.flatMap((n) => (want.has(n.el.id) ? [nodeBox(n.el, ctx)] : (n.children ?? []).map((c) => nodeBox(c, ctx)))));
  } else {
    box = unionBox(tree.map((n) => nodeBox(n.el, ctx)));
  }
  const pad = frameClip ? 0 : (o.padding ?? 24);
  const b: Box = box ? { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 } : { x: 0, y: 0, w: 400, h: 300 };
  const want = o.ids?.length ? new Set(o.ids) : null;
  const content: Prim[] = [];
  for (const n of tree) {
    const selfShown = !want || want.has(n.el.id);
    if (n.el.type === 'frame') {
      if (selfShown) content.push(...elementPrims(n.el, ctx, { frameLabel: !frameClip }));
      const kids = (n.children ?? []).flatMap((c) => elementPrims(c, ctx));
      if (kids.length) content.push({ t: 'group', clip: rectCmds(n.el.x, n.el.y, n.el.w, n.el.h, n.el.radius ?? 0), children: kids });
    } else content.push(...elementPrims(n.el, ctx));
  }
  let k = 1;
  if (o.maxSize && Math.max(b.w, b.h) > o.maxSize) k = o.maxSize / Math.max(b.w, b.h);
  const width = Math.max(1, Math.round(b.w * k));
  const height = Math.max(1, Math.round(b.h * k));
  const prims: Prim[] = [];
  if (o.background && visible(o.background)) prims.push({ t: 'path', d: rectCmds(0, 0, width, height), fill: o.background });
  prims.push({ t: 'group', m: mul(scale(k), translate(-b.x, -b.y)), children: content });
  return { prims: o.theme === 'dark' ? darken(prims) : prims, width, height, box: b };
}

/** Box of an element for export bounds: frames include their label, arrows their resolved path. */
function nodeBox(el: CanvasElement, ctx: RenderCtx): Box {
  if (el.type === 'line' || el.type === 'arrow') {
    const g = lineGeometry(el, ctx);
    const xs = g.pts.map((p) => p[0]);
    const ys = g.pts.map((p) => p[1]);
    const m = (el.strokeWidth ?? 2) * 3 + 8;
    return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + m * 2, h: Math.max(...ys) - Math.min(...ys) + m * 2 };
  }
  const b = elementBox(el);
  if (el.type === 'frame') return { x: b.x, y: b.y - 24, w: b.w, h: b.h + 24 };
  if (el.type === 'sticky' || el.type === 'card') return { x: b.x, y: b.y, w: b.w, h: b.h + 6 };
  return b;
}

// --- colours for dark exports ---------------------------------------------------------------------------------

/** The editor's dark mode (CSS invert(93%) hue-rotate(180deg)) applied to one colour. */
export function darkColor(c: string): string {
  const m = c.match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return c;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const inv = (v: number) => 0.93 - 0.86 * v;
  const [ir, ig, ib] = [inv(r), inv(g), inv(b)];
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  const out = `#${clamp(-0.574 * ir + 1.43 * ig + 0.144 * ib)}${clamp(0.426 * ir + 0.43 * ig + 0.144 * ib)}${clamp(0.426 * ir + 1.43 * ig - 0.856 * ib)}`;
  return h.length === 8 ? out + h.slice(6, 8) : out;
}

function darken(prims: Prim[]): Prim[] {
  return prims.map((p): Prim => {
    switch (p.t) {
      case 'path':
        return { ...p, fill: p.fill ? darkColor(p.fill) : p.fill, stroke: p.stroke ? darkColor(p.stroke) : p.stroke };
      case 'text':
        return { ...p, color: darkColor(p.color) };
      case 'group':
        return { ...p, children: darken(p.children) };
      default:
        return p;
    }
  });
}

// --- SVG ----------------------------------------------------------------------------------------------------

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const n2 = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
const COLOR_OK = /^(#[0-9a-fA-F]{3,8}|transparent|none)$/;
const col = (c: string | undefined) => (c && COLOR_OK.test(c) ? c : 'none');
/** Raster images only: media-library files (relative or absolute) or inlined data: URIs. */
const HREF_OK = /^(\/uploads\/[A-Za-z0-9]{8,40}\.(png|jpe?g|gif|webp)|https?:\/\/[A-Za-z0-9.:[\]-]+\/uploads\/[A-Za-z0-9]{8,40}\.(png|jpe?g|gif|webp)|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/;
export const safeHref = (h: string) => HREF_OK.test(h);

interface SvgState {
  defs: string[];
  n: number;
  prefix: string;
}

function primSvg(p: Prim, st: SvgState): string {
  switch (p.t) {
    case 'path': {
      if (!p.d.length) return '';
      const a = [`d="${cmdsToD(p.d)}"`, `fill="${col(p.fill)}"`];
      if (p.stroke && p.sw !== 0) {
        a.push(`stroke="${col(p.stroke)}"`, `stroke-width="${n2(p.sw ?? 1)}"`);
        if (p.cap) a.push(`stroke-linecap="${p.cap}"`);
        if (p.join) a.push(`stroke-linejoin="${p.join}"`);
        if (p.dash) a.push(`stroke-dasharray="${p.dash.map(n2).join(' ')}"`);
      }
      if (p.evenodd) a.push('fill-rule="evenodd"');
      if (p.opacity !== undefined && p.opacity < 1) a.push(`opacity="${n2(p.opacity)}"`);
      return `<path ${a.join(' ')}/>`;
    }
    case 'text': {
      if (!p.lines.some((l) => l.length)) return '';
      const base = (p.lh - p.size) / 2 + p.size * 0.8;
      const attrs = [`x="${n2(p.x)}"`, `y="${n2(p.y + base)}"`, `font-family="${esc(FONT_STACK[p.font] ?? FONT_STACK.sans)}"`, `font-size="${n2(p.size)}"`, `fill="${col(p.color)}"`];
      if (p.bold) attrs.push('font-weight="700"');
      if (p.italic) attrs.push('font-style="italic"');
      if (p.anchor !== 'start') attrs.push(`text-anchor="${p.anchor}"`);
      if (p.opacity !== undefined && p.opacity < 1) attrs.push(`opacity="${n2(p.opacity)}"`);
      const spans = p.lines.map((l, i) => `<tspan x="${n2(p.x)}" ${i ? `dy="${n2(p.lh)}"` : ''}>${esc(l || ' ')}</tspan>`).join('');
      return `<text ${attrs.join(' ')} xml:space="preserve">${spans}</text>`;
    }
    case 'image': {
      if (!safeHref(p.src)) return '';
      let clip = '';
      if (p.radius) {
        const cid = `${st.prefix}c${st.n++}`;
        st.defs.push(`<clipPath id="${cid}"><path d="${cmdsToD(rectCmds(p.x, p.y, p.w, p.h, p.radius))}"/></clipPath>`);
        clip = ` clip-path="url(#${cid})"`;
      }
      return `<image href="${esc(p.src)}" x="${n2(p.x)}" y="${n2(p.y)}" width="${n2(p.w)}" height="${n2(p.h)}" preserveAspectRatio="${p.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'}"${clip}${p.opacity !== undefined && p.opacity < 1 ? ` opacity="${n2(p.opacity)}"` : ''}/>`;
    }
    case 'group': {
      const inner = p.children.map((c) => primSvg(c, st)).join('');
      if (!inner) return '';
      const a: string[] = [];
      if (p.m) a.push(`transform="matrix(${p.m.map(n2).join(' ')})"`);
      if (p.opacity !== undefined && p.opacity < 1) a.push(`opacity="${n2(p.opacity)}"`);
      if (p.clip) {
        const cid = `${st.prefix}c${st.n++}`;
        st.defs.push(`<clipPath id="${cid}"><path d="${cmdsToD(p.clip)}"/></clipPath>`);
        a.push(`clip-path="url(#${cid})"`);
      }
      return `<g${a.length ? ` ${a.join(' ')}` : ''}>${inner}</g>`;
    }
  }
}

/** Markup for a list of primitives (clip paths inlined as <defs>). `prefix` keeps clip ids unique on a page. */
export function primsToSvg(prims: Prim[], prefix = 'cv'): string {
  const st: SvgState = { defs: [], n: 0, prefix: prefix.replace(/[^A-Za-z0-9_-]/g, '') || 'cv' };
  const body = prims.map((p) => primSvg(p, st)).join('');
  return (st.defs.length ? `<defs>${st.defs.join('')}</defs>` : '') + body;
}

/** One element as SVG markup in board coordinates (the editor injects this per element; `dark` = dark-mode colours). */
export function elementSvg(el: CanvasElement, ctx: RenderCtx, o: { frameLabel?: boolean; dark?: boolean } = {}): string {
  const prims = elementPrims(el, ctx, o);
  return primsToSvg(o.dark ? darken(prims) : prims, `e${el.id}`);
}

/** Dark-mode colours for a display list (images stay as they are). */
export const darkPrims = (prims: Prim[]) => darken(prims);

/** A standalone SVG document of the scene. */
export function renderSvg(elements: CanvasElement[], o: SceneRenderOptions & { title?: string } = {}): { svg: string; width: number; height: number } {
  const { prims, width, height } = sceneDisplayList(elements, o);
  const title = o.title ? `<title>${esc(o.title)}</title>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${title}${primsToSvg(prims, o.idPrefix)}</svg>`;
  return { svg, width, height };
}
