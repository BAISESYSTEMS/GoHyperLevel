/**
 * Canvas scene model – shared by the server (storage, MCP, export) and the browser editor.
 *
 * A board is a flat list of elements with stable ids. Everything an agent needs is plain JSON:
 * position/size in board units (1 unit = 1 CSS pixel at 100 % zoom), a type, style fields and a few
 * type-specific fields (points for lines, cells for tables, a record reference for CRM cards …).
 *
 * Pure code without Node imports: the browser imports this file too.
 */

import { layoutText, textWidth } from './canvas-text.js';

export const ELEMENT_TYPES = ['rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'text', 'sticky', 'frame', 'image', 'icon', 'table', 'chart', 'card'] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const CARD_KINDS = ['contact', 'company', 'deal', 'task', 'ticket', 'appointment', 'project', 'report', 'pipeline'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const CARD_LABELS: Record<CardKind, string> = {
  contact: 'Kontakt',
  company: 'Firma',
  deal: 'Deal',
  task: 'Aufgabe',
  ticket: 'Ticket',
  appointment: 'Termin',
  project: 'Projekt',
  report: 'Bericht',
  pipeline: 'Pipeline',
};

export type Head = 'none' | 'arrow' | 'triangle' | 'dot' | 'bar' | 'diamond';
export type Route = 'straight' | 'elbow' | 'curved';
export type FontKey = 'sans' | 'serif' | 'mono' | 'hand';
export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type FillStyle = 'solid' | 'hachure' | 'cross';
export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'donut';

/** One end of a line/arrow stuck to another element; `anchor` (0..1, 0..1) pins a spot, otherwise the edge facing the other end. */
export interface Binding {
  id: string;
  anchor?: [number, number];
}

export interface ChartData {
  kind: ChartKind;
  title?: string;
  labels: string[];
  series: { name: string; values: number[]; color?: string }[];
}

export interface CardRef {
  kind: CardKind;
  id: string;
}

export interface CanvasElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation in degrees around the centre. */
  angle?: number;
  /** Stacking order (higher = in front). */
  z?: number;
  /** Server-assigned, increases with every accepted change. */
  version?: number;
  /** Sketch style randomness (stable per element). */
  seed?: number;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  fillStyle?: FillStyle;
  opacity?: number;
  /** Hand-drawn look ("Handgezeichnet"). */
  sketch?: boolean;
  radius?: number;
  // text (own text for text/sticky, label for shapes, arrows, frames use `name`)
  text?: string;
  fontSize?: number;
  font?: FontKey;
  bold?: boolean;
  italic?: boolean;
  align?: Align;
  valign?: VAlign;
  color?: string;
  // structure
  groupIds?: string[];
  frameId?: string | null;
  locked?: boolean;
  hidden?: boolean;
  name?: string;
  /** https:// link or an app path (/app/…) opened from the element. */
  link?: string;
  /** Small free metadata (e.g. the workflow step an element stands for). */
  meta?: Record<string, string | number | boolean>;
  // line / arrow / draw
  points?: number[][];
  start?: Binding | null;
  end?: Binding | null;
  route?: Route;
  startHead?: Head;
  endHead?: Head;
  // frame
  preset?: string;
  // image
  src?: string;
  fit?: 'cover' | 'contain';
  // icon
  icon?: string;
  // table
  cells?: string[][];
  header?: boolean;
  // chart
  chart?: ChartData;
  // CRM card
  card?: CardRef;
}

export interface Scene {
  elements: CanvasElement[];
}

// --- presets & palette --------------------------------------------------------------------

/** Frame / artboard presets (design mode). */
export const FRAME_PRESETS: { key: string; label: string; w: number; h: number; group: string }[] = [
  { key: 'desktop', label: 'Desktop 1440', w: 1440, h: 1024, group: 'Web' },
  { key: 'tablet', label: 'Tablet 834', w: 834, h: 1194, group: 'Web' },
  { key: 'mobile', label: 'Mobile 390', w: 390, h: 844, group: 'Web' },
  { key: 'social-square', label: 'Social 1080×1080', w: 1080, h: 1080, group: 'Social' },
  { key: 'social-portrait', label: 'Social 1080×1350', w: 1080, h: 1350, group: 'Social' },
  { key: 'social-landscape', label: 'Social 1200×675', w: 1200, h: 675, group: 'Social' },
  { key: 'story', label: 'Story 1080×1920', w: 1080, h: 1920, group: 'Social' },
  { key: 'a4', label: 'A4 (Hochformat)', w: 794, h: 1123, group: 'Druck' },
  { key: 'a4-landscape', label: 'A4 (Querformat)', w: 1123, h: 794, group: 'Druck' },
  { key: 'slide', label: 'Folie 16:9', w: 1920, h: 1080, group: 'Präsentation' },
];

export const STICKY_COLORS: Record<string, string> = {
  gelb: '#fff3a3',
  orange: '#ffd8a8',
  rosa: '#ffc9de',
  lila: '#e5dbff',
  blau: '#c5e4ff',
  gruen: '#c3f0c8',
  grau: '#e9ecef',
};

/** Stroke colours offered in the editor (first = default ink). */
export const STROKE_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#0c8599', '#868e96', '#ffffff'];
/** Fill colours offered in the editor (first = none). */
export const FILL_COLORS = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#eebefa', '#99e9f2', '#e9ecef', '#ffffff', '#1e1e1e'];

export const DEFAULT_INK = '#1e1e1e';

// --- limits --------------------------------------------------------------------------------

export const LIMITS = {
  elements: 5000,
  textChars: 10_000,
  points: 4000,
  tableCells: 400,
  chartValues: 200,
  opsPerRequest: 1000,
  coord: 1_000_000,
  size: 100_000,
};

// --- cleaning ------------------------------------------------------------------------------

export class SceneError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);

const COLOR_RE = /^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/;
export const cleanColor = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (COLOR_RE.test(s)) return s.toLowerCase();
  const sticky = STICKY_COLORS[s.toLowerCase()];
  return sticky;
};

const num = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
};

/** Text without control characters (newlines and tabs stay), at most `max` characters. */
export function cleanText(v: unknown, max: number = LIMITS.textChars): string {
  if (v === undefined || v === null) return '';
  // eslint-disable-next-line no-control-regex
  return String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, '').slice(0, max);
}

const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);

/** Image sources: only files from the media library (`/uploads/<file>`); absolute links to it are made relative. */
export function cleanSrc(v: unknown, base = ''): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (base && s.startsWith(base.replace(/\/$/, '') + '/uploads/')) s = s.slice(base.replace(/\/$/, '').length);
  const m = s.match(/^(?:https?:\/\/[^/]+)?(\/uploads\/[A-Za-z0-9]{8,40}\.(?:png|jpg|jpeg|gif|webp))$/);
  if (!m) return undefined;
  if (/^https?:/.test(s) && !base) return undefined;
  return m[1];
}

/** Links: https:// (or http:// for local installs) and app paths. */
export function cleanLink(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, 1000);
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^\/app\/[^\s"'<>]*$/.test(s)) return s;
  return undefined;
}

function cleanBinding(v: unknown): Binding | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const b = v as any;
  if (!isId(b.id)) return undefined;
  const out: Binding = { id: b.id };
  if (Array.isArray(b.anchor) && b.anchor.length === 2) {
    const ax = num(b.anchor[0], 0, 1);
    const ay = num(b.anchor[1], 0, 1);
    if (ax !== undefined && ay !== undefined) out.anchor = [ax, ay];
  }
  return out;
}

function cleanPoints(v: unknown, withPressure: boolean): number[][] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[][] = [];
  for (const p of v.slice(0, LIMITS.points)) {
    if (!Array.isArray(p)) continue;
    const x = num(p[0], -LIMITS.size, LIMITS.size);
    const y = num(p[1], -LIMITS.size, LIMITS.size);
    if (x === undefined || y === undefined) continue;
    if (withPressure) out.push([x, y, num(p[2], 0, 1) ?? 0.5]);
    else out.push([x, y]);
  }
  return out;
}

function cleanChart(v: unknown): ChartData | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const c = v as any;
  const labels = Array.isArray(c.labels) ? c.labels.slice(0, LIMITS.chartValues).map((l: unknown) => cleanText(l, 80)) : [];
  const series = (Array.isArray(c.series) ? c.series : [])
    .slice(0, 8)
    .map((s: any) => ({
      name: cleanText(s?.name, 80),
      values: (Array.isArray(s?.values) ? s.values : []).slice(0, LIMITS.chartValues).map((x: unknown) => num(x, -1e12, 1e12) ?? 0),
      ...(cleanColor(s?.color) ? { color: cleanColor(s?.color) } : {}),
    }));
  return { kind: oneOf(c.kind, ['bar', 'line', 'area', 'pie', 'donut'] as const) ?? 'bar', ...(c.title ? { title: cleanText(c.title, 120) } : {}), labels, series };
}

function cleanCells(v: unknown): string[][] | undefined {
  if (!Array.isArray(v)) return undefined;
  const rows = v.slice(0, 40).map((r) => (Array.isArray(r) ? r.slice(0, 20).map((c) => cleanText(c, 500)) : []));
  let n = 0;
  return rows.map((r) => r.filter(() => ++n <= LIMITS.tableCells));
}

function cleanMeta(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v).slice(0, 20)) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) continue;
    if (typeof val === 'string') out[k] = cleanText(val, 300);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}

/**
 * Applies a set of (untrusted) properties onto an element: every field is validated and clamped,
 * unknown fields are dropped, `null` removes an optional field. Throws SceneError for unusable input.
 */
export function applyProps(target: CanvasElement, props: Record<string, any>, opts: { base?: string } = {}): CanvasElement {
  const el: CanvasElement = { ...target };
  const set = <K extends keyof CanvasElement>(k: K, v: CanvasElement[K] | undefined) => {
    if (v === undefined) delete el[k];
    else el[k] = v;
  };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(props, k);
  for (const k of ['x', 'y'] as const) if (has(k)) {
    const v = num(props[k], -LIMITS.coord, LIMITS.coord);
    if (v !== undefined) el[k] = v;
  }
  for (const k of ['w', 'h'] as const) if (has(k)) {
    const v = num(props[k], 0, LIMITS.size);
    if (v !== undefined) el[k] = v;
  }
  if (has('angle')) set('angle', props.angle === null ? undefined : (((num(props.angle, -36000, 36000) ?? 0) % 360) + 360) % 360 || undefined);
  if (has('z')) {
    const z = num(props.z, -1e9, 1e9);
    if (z !== undefined) el.z = z;
  }
  if (has('seed')) set('seed', num(props.seed, 0, 2 ** 31) ?? el.seed);
  for (const k of ['stroke', 'fill', 'color'] as const) if (has(k)) set(k, props[k] === null ? undefined : (cleanColor(props[k]) ?? el[k]));
  if (has('strokeWidth')) set('strokeWidth', props.strokeWidth === null ? undefined : num(props.strokeWidth, 0, 40));
  if (has('strokeStyle')) set('strokeStyle', oneOf(props.strokeStyle, ['solid', 'dashed', 'dotted'] as const));
  if (has('fillStyle')) set('fillStyle', oneOf(props.fillStyle, ['solid', 'hachure', 'cross'] as const));
  if (has('opacity')) set('opacity', props.opacity === null ? undefined : num(props.opacity, 0, 1));
  if (has('sketch')) set('sketch', props.sketch ? true : undefined);
  if (has('radius')) set('radius', props.radius === null ? undefined : num(props.radius, 0, 10_000));
  if (has('text')) set('text', props.text === null ? undefined : cleanText(props.text));
  if (has('fontSize')) set('fontSize', props.fontSize === null ? undefined : num(props.fontSize, 4, 800));
  if (has('font')) set('font', oneOf(props.font, ['sans', 'serif', 'mono', 'hand'] as const));
  for (const k of ['bold', 'italic', 'locked', 'hidden', 'header'] as const) if (has(k)) set(k, props[k] ? true : undefined);
  if (has('align')) set('align', oneOf(props.align, ['left', 'center', 'right'] as const));
  if (has('valign')) set('valign', oneOf(props.valign, ['top', 'middle', 'bottom'] as const));
  if (has('groupIds')) set('groupIds', Array.isArray(props.groupIds) ? props.groupIds.filter(isId).slice(0, 10) : undefined);
  if (has('frameId')) set('frameId', isId(props.frameId) ? props.frameId : undefined);
  if (has('name')) set('name', props.name === null ? undefined : cleanText(props.name, 200) || undefined);
  if (has('link')) set('link', props.link === null ? undefined : cleanLink(props.link));
  if (has('meta')) set('meta', props.meta === null ? undefined : cleanMeta(props.meta));
  if (has('points')) set('points', cleanPoints(props.points, el.type === 'draw'));
  if (has('start')) set('start', cleanBinding(props.start) ?? undefined);
  if (has('end')) set('end', cleanBinding(props.end) ?? undefined);
  if (has('route')) set('route', oneOf(props.route, ['straight', 'elbow', 'curved'] as const));
  if (has('startHead')) set('startHead', oneOf(props.startHead, ['none', 'arrow', 'triangle', 'dot', 'bar', 'diamond'] as const));
  if (has('endHead')) set('endHead', oneOf(props.endHead, ['none', 'arrow', 'triangle', 'dot', 'bar', 'diamond'] as const));
  if (has('preset')) set('preset', FRAME_PRESETS.some((p) => p.key === props.preset) ? props.preset : undefined);
  if (has('src')) set('src', cleanSrc(props.src, opts.base));
  if (has('fit')) set('fit', oneOf(props.fit, ['cover', 'contain'] as const));
  if (has('icon')) set('icon', typeof props.icon === 'string' && /^[a-z0-9-]{1,40}$/.test(props.icon) ? props.icon : undefined);
  if (has('cells')) set('cells', cleanCells(props.cells));
  if (has('chart')) set('chart', cleanChart(props.chart));
  if (has('card')) {
    const c = props.card;
    set('card', c && typeof c === 'object' && oneOf(c.kind, CARD_KINDS) && (isId(c.id) || (c.kind === 'project' && !c.id)) ? { kind: c.kind, id: isId(c.id) ? c.id : 'current' } : undefined);
  }
  return el;
}

/** Defaults per type when an element is created without them. */
export function defaultsFor(type: ElementType): Partial<CanvasElement> {
  switch (type) {
    case 'rect':
      return { w: 160, h: 90, stroke: DEFAULT_INK, fill: 'transparent', strokeWidth: 2, radius: 8 };
    case 'ellipse':
      return { w: 140, h: 90, stroke: DEFAULT_INK, fill: 'transparent', strokeWidth: 2 };
    case 'diamond':
      return { w: 150, h: 100, stroke: DEFAULT_INK, fill: 'transparent', strokeWidth: 2 };
    case 'line':
      return { w: 160, h: 0, stroke: DEFAULT_INK, strokeWidth: 2, points: [[0, 0], [160, 0]] };
    case 'arrow':
      return { w: 160, h: 0, stroke: DEFAULT_INK, strokeWidth: 2, points: [[0, 0], [160, 0]], endHead: 'arrow', route: 'straight' };
    case 'draw':
      return { w: 0, h: 0, stroke: DEFAULT_INK, strokeWidth: 3, points: [] };
    case 'text':
      return { w: 240, h: 30, fontSize: 20, color: DEFAULT_INK, text: '' };
    case 'sticky':
      return { w: 200, h: 200, fill: STICKY_COLORS.gelb, fontSize: 20, color: DEFAULT_INK, text: '' };
    case 'frame':
      return { w: 800, h: 600, fill: '#ffffff', name: 'Rahmen' };
    case 'image':
      return { w: 320, h: 240, fit: 'cover' };
    case 'icon':
      return { w: 48, h: 48, stroke: DEFAULT_INK, strokeWidth: 2, icon: 'star' };
    case 'table':
      return { w: 480, h: 160, stroke: '#adb5bd', fill: '#ffffff', fontSize: 14, color: DEFAULT_INK, header: true, cells: [['Spalte 1', 'Spalte 2', 'Spalte 3'], ['', '', ''], ['', '', '']] };
    case 'chart':
      return { w: 420, h: 260, fill: '#ffffff', stroke: '#dee2e6', color: DEFAULT_INK, chart: { kind: 'bar', labels: ['A', 'B', 'C'], series: [{ name: 'Werte', values: [3, 5, 2] }] } };
    case 'card':
      return { w: 300, h: 168 };
  }
}

export const CARD_SIZE: Record<CardKind, [number, number]> = {
  contact: [300, 168],
  company: [300, 168],
  deal: [300, 168],
  task: [300, 150],
  ticket: [300, 168],
  appointment: [300, 150],
  project: [320, 190],
  report: [420, 280],
  pipeline: [880, 420],
};

/**
 * A complete, valid element from untrusted input (create). `newId` supplies an id when none (or an
 * invalid one) is given; `seed` gives the sketch randomness.
 */
export function createElement(input: Record<string, any>, newId: () => string, opts: { base?: string; seed?: () => number } = {}): CanvasElement {
  const type = oneOf(input?.type, ELEMENT_TYPES);
  if (!type) throw new SceneError(`Unbekannter Elementtyp: ${String(input?.type ?? '').slice(0, 30) || '(leer)'}`);
  const defaults = defaultsFor(type);
  const base: CanvasElement = { id: isId(input.id) ? input.id : newId(), type, x: 0, y: 0, w: 0, h: 0, ...defaults } as CanvasElement;
  if (type === 'card' && input.card?.kind && CARD_SIZE[input.card.kind as CardKind]) {
    const [w, h] = CARD_SIZE[input.card.kind as CardKind];
    base.w = w;
    base.h = h;
  }
  const { id: _id, type: _type, version: _v, ...rest } = input;
  const el = applyProps(base, rest, opts);
  if (el.seed === undefined) el.seed = opts.seed ? opts.seed() : Math.floor(Math.random() * 2 ** 31);
  if (type === 'line' || type === 'arrow' || type === 'draw') fitToPoints(el);
  if (type === 'text') autoSizeText(el, rest.w === undefined);
  if (type === 'card' && !el.card) throw new SceneError('CRM-Karte: card {kind, id} fehlt');
  if (type === 'image' && !el.src) throw new SceneError('Bild: src muss eine Datei aus der Mediathek sein (/uploads/…)');
  return el;
}

/** Applies an update (validated like `applyProps`) and keeps derived sizes right (text height, line boxes). */
export function updateElement(el: CanvasElement, props: Record<string, any>, opts: { base?: string } = {}): CanvasElement {
  const { id: _id, type: _type, version: _v, ...rest } = props ?? {};
  const next = applyProps(el, rest, opts);
  if ((next.type === 'line' || next.type === 'arrow' || next.type === 'draw') && 'points' in rest) fitToPoints(next);
  if (next.type === 'text' && !('h' in rest) && ['text', 'fontSize', 'font', 'bold', 'w'].some((k) => k in rest)) autoSizeText(next, false);
  return next;
}

/**
 * Text elements: the height follows the text (wrapped at the width); `fitWidth` sizes the width to the
 * longest line first (up to 640 px) – for new text without an explicit width.
 */
export function autoSizeText(el: CanvasElement, fitWidth = false): CanvasElement {
  if (el.type !== 'text') return el;
  const size = el.fontSize ?? 20;
  if (fitWidth) {
    const longest = Math.max(0, ...(el.text ?? '').split('\n').map((l) => textWidth(l, size, el.bold, el.font)));
    el.w = Math.round(Math.min(640, Math.max(size, longest + 4)));
  }
  el.h = Math.round(Math.max(size * 1.25, layoutText(el.text ?? '', size, { maxWidth: el.w, bold: el.bold, font: el.font }).height));
  return el;
}

/** Lines, arrows and pen strokes keep x/y/w/h as the box around their points (points stay relative to x/y). */
export function fitToPoints(el: CanvasElement): CanvasElement {
  const pts = el.points ?? [];
  if (!pts.length) return el;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]);
    maxY = Math.max(maxY, p[1]);
  }
  if (minX !== 0 || minY !== 0) {
    el.points = pts.map((p) => (p.length > 2 ? [p[0] - minX, p[1] - minY, p[2]] : [p[0] - minX, p[1] - minY]));
    el.x = Math.round((el.x + minX) * 100) / 100;
    el.y = Math.round((el.y + minY) * 100) / 100;
  }
  el.w = Math.round((maxX - minX) * 100) / 100;
  el.h = Math.round((maxY - minY) * 100) / 100;
  return el;
}

// --- geometry helpers (shared) -------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Axis-aligned box of an element (rotation included). */
export function elementBox(el: CanvasElement): Box {
  const a = ((el.angle ?? 0) * Math.PI) / 180;
  if (!a || el.type === 'line' || el.type === 'arrow') return { x: el.x, y: el.y, w: el.w, h: el.h };
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const cos = Math.abs(Math.cos(a));
  const sin = Math.abs(Math.sin(a));
  const w = el.w * cos + el.h * sin;
  const h = el.w * sin + el.h * cos;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export const boxesOverlap = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/** Elements in paint order: by z, ties by id (stable on every client). */
export function sortByZ<T extends { z?: number; id: string }>(els: T[]): T[] {
  return [...els].sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- text outline (agents) -----------------------------------------------------------------

const TYPE_LABELS: Record<ElementType, string> = {
  rect: 'Rechteck',
  ellipse: 'Ellipse',
  diamond: 'Raute',
  line: 'Linie',
  arrow: 'Pfeil',
  draw: 'Zeichnung',
  text: 'Text',
  sticky: 'Notiz',
  frame: 'Rahmen',
  image: 'Bild',
  icon: 'Icon',
  table: 'Tabelle',
  chart: 'Diagramm',
  card: 'CRM-Karte',
};
export const typeLabel = (t: ElementType) => TYPE_LABELS[t] ?? t;

const short = (s: string | undefined, n = 80) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A readable outline of the board for language models: frames with their contents, connections, cards. */
export function sceneOutline(elements: CanvasElement[], name = 'Board'): string {
  const els = sortByZ(elements.filter((e) => !e.hidden));
  const byId = new Map(els.map((e) => [e.id, e]));
  const label = (e: CanvasElement | undefined) => {
    if (!e) return '?';
    const t = e.type === 'frame' ? e.name : e.type === 'card' ? `${CARD_LABELS[e.card!.kind]} ${e.card!.id}` : e.type === 'table' ? (e.cells?.[0] ?? []).join(' | ') : e.type === 'chart' ? (e.chart?.title ?? e.chart?.kind) : e.type === 'icon' ? e.icon : e.text;
    return `${typeLabel(e.type)} "${short(t, 60)}" [${e.id}]`;
  };
  const lines: string[] = [`# ${name} – ${els.length} Elemente`];
  const line = (e: CanvasElement, indent: string) => {
    if (e.type === 'arrow' || e.type === 'line') {
      const from = e.start ? label(byId.get(e.start.id)) : `(${Math.round(e.x)},${Math.round(e.y)})`;
      const to = e.end ? label(byId.get(e.end.id)) : `(${Math.round(e.x + e.w)},${Math.round(e.y + e.h)})`;
      lines.push(`${indent}- ${typeLabel(e.type)} [${e.id}]: ${from} → ${to}${e.text ? ` „${short(e.text, 40)}“` : ''}`);
      return;
    }
    lines.push(`${indent}- ${label(e)} @ ${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.w)}×${Math.round(e.h)}${e.locked ? ' (gesperrt)' : ''}`);
  };
  const frames = els.filter((e) => e.type === 'frame');
  const inFrame = new Set<string>();
  for (const f of frames) {
    lines.push(`## Rahmen "${short(f.name, 60)}" [${f.id}] ${Math.round(f.w)}×${Math.round(f.h)}${f.preset ? ` (${f.preset})` : ''}`);
    for (const e of els) if (e.frameId === f.id && e.type !== 'frame') {
      inFrame.add(e.id);
      line(e, '  ');
    }
  }
  const rest = els.filter((e) => e.type !== 'frame' && !inFrame.has(e.id));
  if (rest.length) {
    if (frames.length) lines.push('## Ohne Rahmen');
    for (const e of rest.slice(0, 2000)) line(e, '');
    if (rest.length > 2000) lines.push(`… und ${rest.length - 2000} weitere`);
  }
  return lines.join('\n');
}
