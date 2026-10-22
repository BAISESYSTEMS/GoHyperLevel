/**
 * Auto-layout for the canvas (no library):
 * - `flow`   – layered graph layout (Sugiyama style: break cycles, longest-path layers, barycentre
 *              ordering sweeps, neighbour-centred placement without overlaps), left → right or top → down
 * - `tree`   – tidy tree (children side by side, parent centred), down or right
 * - `mindmap`– root in the middle, branches balanced to the left and right
 * - `radial` – root in the centre, every level on a ring, wedges by subtree size
 * - `grid`   – rows and columns
 * plus `buildGraph`, which turns nodes/edges (from Mermaid, the AI or an agent) into canvas elements.
 *
 * Pure code (also used in the browser).
 */

import { type CanvasElement, DEFAULT_INK, type Box } from './canvas-model.js';
import { layoutText, textWidth } from './canvas-text.js';

export type LayoutKind = 'flow' | 'tree' | 'mindmap' | 'radial' | 'grid';
export type Direction = 'right' | 'down' | 'left' | 'up';

export interface LNode {
  id: string;
  w: number;
  h: number;
}
export interface LEdge {
  from: string;
  to: string;
}
export interface LayoutOptions {
  kind: LayoutKind;
  direction?: Direction;
  /** Gap between neighbours in a layer / siblings. */
  gap?: number;
  /** Gap between layers / levels. */
  levelGap?: number;
  /** Grid: columns (default ≈ √n). */
  columns?: number;
  /** Root for tree/mindmap/radial (default: the node with most descendants without incoming edges). */
  root?: string;
}

export type Positions = Record<string, { x: number; y: number }>;

/** Top-left positions for every node (the layout's origin is 0,0 at its top-left). */
export function layoutGraph(nodes: LNode[], edges: LEdge[], o: LayoutOptions): Positions {
  const ids = new Set(nodes.map((n) => n.id));
  const es = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  let pos: Positions;
  switch (o.kind) {
    case 'grid':
      pos = gridLayout(nodes, o);
      break;
    case 'tree':
      pos = treeLayout(nodes, es, o);
      break;
    case 'mindmap':
      pos = mindmapLayout(nodes, es, o);
      break;
    case 'radial':
      pos = radialLayout(nodes, es, o);
      break;
    default:
      pos = flowLayout(nodes, es, o);
  }
  return normalise(nodes, pos);
}

function normalise(nodes: LNode[], pos: Positions): Positions {
  let minX = Infinity;
  let minY = Infinity;
  for (const n of nodes) {
    const p = pos[n.id];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minX)) return pos;
  const out: Positions = {};
  for (const n of nodes) if (pos[n.id]) out[n.id] = { x: Math.round(pos[n.id].x - minX), y: Math.round(pos[n.id].y - minY) };
  return out;
}

// --- grid ---------------------------------------------------------------------------------------

function gridLayout(nodes: LNode[], o: LayoutOptions): Positions {
  const gap = o.gap ?? 40;
  const cols = Math.max(1, o.columns ?? Math.ceil(Math.sqrt(nodes.length)));
  const cw = Math.max(0, ...nodes.map((n) => n.w));
  const rows: LNode[][] = [];
  nodes.forEach((n, i) => (rows[Math.floor(i / cols)] ??= []).push(n));
  const pos: Positions = {};
  let y = 0;
  for (const row of rows) {
    const rh = Math.max(...row.map((n) => n.h));
    row.forEach((n, c) => (pos[n.id] = { x: c * (cw + gap) + (cw - n.w) / 2, y: y + (rh - n.h) / 2 }));
    y += rh + gap;
  }
  return pos;
}

// --- shared graph helpers -------------------------------------------------------------------------

function adjacency(nodes: LNode[], edges: LEdge[]) {
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const inc = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    out.get(e.from)!.push(e.to);
    inc.get(e.to)!.push(e.from);
  }
  return { out, inc };
}

/** A spanning forest (BFS from roots); returns children per node and the roots in order. */
function forest(nodes: LNode[], edges: LEdge[], rootHint?: string): { children: Map<string, string[]>; roots: string[] } {
  const { out, inc } = adjacency(nodes, edges);
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const seen = new Set<string>();
  const sizeOf = (id: string) => {
    // reachable count – picks the "biggest" root first
    const s = new Set([id]);
    const q = [id];
    while (q.length) for (const c of out.get(q.shift()!) ?? []) if (!s.has(c)) (s.add(c), q.push(c));
    return s.size;
  };
  let candidates = nodes.filter((n) => !(inc.get(n.id) ?? []).length).map((n) => n.id);
  if (rootHint && children.has(rootHint)) candidates = [rootHint, ...candidates.filter((c) => c !== rootHint)];
  else candidates.sort((a, b) => sizeOf(b) - sizeOf(a));
  const roots: string[] = [];
  const grow = (r: string) => {
    roots.push(r);
    seen.add(r);
    const q = [r];
    while (q.length) {
      const cur = q.shift()!;
      for (const c of out.get(cur) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        children.get(cur)!.push(c);
        q.push(c);
      }
    }
  };
  for (const r of candidates) if (!seen.has(r)) grow(r);
  // cycles without a source: start anywhere
  for (const n of nodes) if (!seen.has(n.id)) grow(n.id);
  return { children, roots };
}

// --- tidy tree ---------------------------------------------------------------------------------------

function treeLayout(nodes: LNode[], edges: LEdge[], o: LayoutOptions): Positions {
  const dir = o.direction ?? 'down';
  const horizontal = dir === 'right' || dir === 'left';
  const gap = o.gap ?? 36;
  const levelGap = o.levelGap ?? (horizontal ? 90 : 70);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { children, roots } = forest(nodes, edges, o.root);
  // breadth along the sibling axis, depth along the level axis
  const breadth = (id: string) => (horizontal ? byId.get(id)!.h : byId.get(id)!.w);
  const depthSize = (id: string) => (horizontal ? byId.get(id)!.w : byId.get(id)!.h);
  const span = new Map<string, number>();
  const measure = (id: string): number => {
    const kids = children.get(id)!;
    const own = breadth(id);
    const total = kids.length ? kids.reduce((s, k) => s + measure(k), 0) + gap * (kids.length - 1) : 0;
    const v = Math.max(own, total);
    span.set(id, v);
    return v;
  };
  // level offsets: the deepest node of each level decides the next level's start
  const levelOf = new Map<string, number>();
  const levelSize: number[] = [];
  const walkLevels = (id: string, l: number) => {
    levelOf.set(id, l);
    levelSize[l] = Math.max(levelSize[l] ?? 0, depthSize(id));
    for (const k of children.get(id)!) walkLevels(k, l + 1);
  };
  for (const r of roots) walkLevels(r, 0);
  const levelStart: number[] = [];
  let acc = 0;
  for (let l = 0; l < levelSize.length; l++) {
    levelStart[l] = acc;
    acc += levelSize[l] + levelGap;
  }
  const pos: Positions = {};
  const place = (id: string, from: number) => {
    const s = span.get(id)!;
    const b = breadth(id);
    const along = from + (s - b) / 2;
    const l = levelOf.get(id)!;
    const depth = levelStart[l] + (levelSize[l] - depthSize(id)) / 2;
    pos[id] = horizontal ? { x: depth, y: along } : { x: along, y: depth };
    const kids = children.get(id)!;
    const total = kids.reduce((t, k) => t + span.get(k)!, 0) + gap * Math.max(0, kids.length - 1);
    let cur = from + (s - total) / 2;
    for (const k of kids) {
      place(k, cur);
      cur += span.get(k)! + gap;
    }
  };
  let start = 0;
  for (const r of roots) {
    measure(r);
    place(r, start);
    start += span.get(r)! + gap * 2;
  }
  if (dir === 'left' || dir === 'up') {
    const max = Math.max(...nodes.map((n) => (horizontal ? pos[n.id].x + n.w : pos[n.id].y + n.h)));
    for (const n of nodes) {
      if (horizontal) pos[n.id].x = max - pos[n.id].x - n.w;
      else pos[n.id].y = max - pos[n.id].y - n.h;
    }
  }
  return pos;
}

// --- mind map (balanced left/right) --------------------------------------------------------------------

function mindmapLayout(nodes: LNode[], edges: LEdge[], o: LayoutOptions): Positions {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { children, roots } = forest(nodes, edges, o.root);
  const root = roots[0];
  if (!root) return {};
  const leaves = (id: string): number => {
    const k = children.get(id)!;
    return k.length ? k.reduce((s, c) => s + leaves(c), 0) : 1;
  };
  const kids = children.get(root)!;
  // split the first level into two halves of similar weight (right side first)
  const total = kids.reduce((s, k) => s + leaves(k), 0);
  const right: string[] = [];
  const left: string[] = [];
  let acc = 0;
  for (const k of kids) {
    if (acc < total / 2 || !right.length) right.push(k);
    else left.push(k);
    acc += leaves(k);
  }
  const side = (list: string[], dir: 'right' | 'left'): Positions => {
    if (!list.length) return {};
    const sub = new Set<string>();
    const walk = (id: string) => {
      sub.add(id);
      for (const c of children.get(id)!) walk(c);
    };
    list.forEach(walk);
    const sn = [byId.get(root)!, ...[...sub].map((s) => byId.get(s)!)];
    const se: LEdge[] = [...list.map((k) => ({ from: root, to: k })), ...[...sub].flatMap((s) => children.get(s)!.map((c) => ({ from: s, to: c })))];
    return treeLayout(sn, se, { kind: 'tree', direction: dir, gap: o.gap ?? 22, levelGap: o.levelGap ?? 70, root });
  };
  const R = side(right, 'right');
  const L = side(left, 'left');
  const rn = byId.get(root)!;
  const pos: Positions = {};
  // align both halves on the root's centre
  const center = (p: Positions) => (p[root] ? { x: p[root].x + rn.w / 2, y: p[root].y + rn.h / 2 } : { x: 0, y: 0 });
  const cr = center(R);
  const cl = center(L);
  for (const [id, p] of Object.entries(R)) pos[id] = { x: p.x - cr.x, y: p.y - cr.y };
  for (const [id, p] of Object.entries(L)) if (id !== root) pos[id] = { x: p.x - cl.x, y: p.y - cl.y };
  pos[root] = { x: -rn.w / 2, y: -rn.h / 2 };
  // nodes not reachable from the root: below
  let y = Math.max(0, ...Object.entries(pos).map(([id, p]) => p.y + byId.get(id)!.h)) + 80;
  let x = -rn.w / 2;
  for (const n of nodes)
    if (!pos[n.id]) {
      pos[n.id] = { x, y };
      x += n.w + 30;
      if (x > 1200) {
        x = -rn.w / 2;
        y += n.h + 30;
      }
    }
  return pos;
}

// --- radial ------------------------------------------------------------------------------------------------

function radialLayout(nodes: LNode[], edges: LEdge[], o: LayoutOptions): Positions {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { children, roots } = forest(nodes, edges, o.root);
  const root = roots[0];
  if (!root) return {};
  const leaves = new Map<string, number>();
  const count = (id: string): number => {
    const k = children.get(id)!;
    const v = k.length ? k.reduce((s, c) => s + count(c), 0) : 1;
    leaves.set(id, v);
    return v;
  };
  count(root);
  const maxDim = Math.max(...nodes.map((n) => Math.max(n.w, n.h)));
  const step = (o.levelGap ?? 70) + maxDim;
  const pos: Positions = {};
  const r0 = byId.get(root)!;
  pos[root] = { x: -r0.w / 2, y: -r0.h / 2 };
  // the ring of a level must be long enough for its nodes
  const depthCount: number[] = [];
  const walk = (id: string, d: number) => {
    depthCount[d] = (depthCount[d] ?? 0) + 1;
    for (const c of children.get(id)!) walk(c, d + 1);
  };
  walk(root, 0);
  const radius = (d: number) => Math.max(d * step, ((depthCount[d] ?? 1) * (maxDim + (o.gap ?? 30))) / (2 * Math.PI));
  const place = (id: string, a0: number, a1: number, d: number) => {
    const kids = children.get(id)!;
    const total = kids.reduce((s, k) => s + leaves.get(k)!, 0) || 1;
    let a = a0;
    for (const k of kids) {
      const da = ((a1 - a0) * leaves.get(k)!) / total;
      const mid = a + da / 2;
      const n = byId.get(k)!;
      const r = radius(d + 1);
      pos[k] = { x: r * Math.cos(mid) - n.w / 2, y: r * Math.sin(mid) - n.h / 2 };
      place(k, a, a + da, d + 1);
      a += da;
    }
  };
  place(root, -Math.PI / 2, (Math.PI * 3) / 2, 0);
  let x = 0;
  let y = Math.max(...Object.entries(pos).map(([id, p]) => p.y + byId.get(id)!.h)) + 80;
  for (const n of nodes)
    if (!pos[n.id]) {
      pos[n.id] = { x, y };
      x += n.w + 30;
      if (x > 1200) {
        x = 0;
        y += n.h + 30;
      }
    }
  return pos;
}

// --- layered flow (Sugiyama-style) ----------------------------------------------------------------------------

function flowLayout(nodes: LNode[], edges: LEdge[], o: LayoutOptions): Positions {
  const dir = o.direction ?? 'right';
  const horizontal = dir === 'right' || dir === 'left';
  const gap = o.gap ?? 40;
  const levelGap = o.levelGap ?? 80;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = nodes.map((n) => n.id);
  // 1) break cycles: DFS, edges back to the stack are reversed
  const out = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)!.push(e.to);
  const state = new Map<string, number>();
  const dag: LEdge[] = [];
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) dag.push({ from: v, to: u });
      else {
        dag.push({ from: u, to: v });
        if (!state.get(v)) dfs(v);
      }
    }
    state.set(u, 2);
  };
  const incCount = new Map<string, number>(order.map((id) => [id, 0]));
  for (const e of edges) incCount.set(e.to, (incCount.get(e.to) ?? 0) + 1);
  for (const id of [...order.filter((i) => !incCount.get(i)), ...order]) if (!state.get(id)) dfs(id);
  // 2) layers by longest path from the sources
  const preds = new Map<string, string[]>(order.map((id) => [id, []]));
  const succs = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const e of dag) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }
  const layer = new Map<string, number>();
  const visit = (id: string, guard = 0): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (guard > order.length) return 0;
    const l = preds.get(id)!.length ? Math.max(...preds.get(id)!.map((p) => visit(p, guard + 1) + 1)) : 0;
    layer.set(id, l);
    return l;
  };
  order.forEach((id) => visit(id));
  // long edges get virtual nodes so ordering sees them
  const vSize = 10;
  const layers: string[][] = [];
  const isVirtual = new Set<string>();
  const vPreds = new Map<string, string[]>();
  const vSuccs = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    (vSuccs.get(a) ?? vSuccs.set(a, []).get(a)!).push(b);
    (vPreds.get(b) ?? vPreds.set(b, []).get(b)!).push(a);
  };
  for (const id of order) (layers[layer.get(id)!] ??= []).push(id);
  let vid = 0;
  for (const e of dag) {
    const la = layer.get(e.from)!;
    const lb = layer.get(e.to)!;
    let prev = e.from;
    for (let l = la + 1; l < lb; l++) {
      const v = `__v${vid++}`;
      isVirtual.add(v);
      (layers[l] ??= []).push(v);
      layer.set(v, l);
      link(prev, v);
      prev = v;
    }
    link(prev, e.to);
  }
  for (let l = 0; l < layers.length; l++) layers[l] ??= [];
  // 3) ordering: barycentre sweeps
  const idx = new Map<string, number>();
  const reindex = () => layers.forEach((L) => L.forEach((id, i) => idx.set(id, i)));
  reindex();
  const bary = (id: string, nb: string[] | undefined, fallback: number) => (nb?.length ? nb.reduce((s, p) => s + idx.get(p)!, 0) / nb.length : fallback);
  for (let pass = 0; pass < 8; pass++) {
    const down = pass % 2 === 0;
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
    for (const l of range) {
      const L = layers[l];
      const keyed = L.map((id, i) => ({ id, k: bary(id, down ? vPreds.get(id) : vSuccs.get(id), i) }));
      keyed.sort((a, b) => a.k - b.k);
      layers[l] = keyed.map((x) => x.id);
      reindex();
    }
  }
  // 4) coordinates: along = position inside the layer, depth = layer
  const along = (id: string) => (isVirtual.has(id) ? vSize : horizontal ? byId.get(id)!.h : byId.get(id)!.w);
  const depthOf = (id: string) => (isVirtual.has(id) ? vSize : horizontal ? byId.get(id)!.w : byId.get(id)!.h);
  const coord = new Map<string, number>(); // centre along the layer
  for (const L of layers) {
    let cur = 0;
    for (const id of L) {
      coord.set(id, cur + along(id) / 2);
      cur += along(id) + gap;
    }
    const shift = cur / 2;
    for (const id of L) coord.set(id, coord.get(id)! - shift);
  }
  const resolve = (L: string[]) => {
    // keep order, push apart overlapping neighbours symmetrically
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < L.length; i++) {
        const a = L[i - 1];
        const b = L[i];
        const min = (along(a) + along(b)) / 2 + gap;
        const d = coord.get(b)! - coord.get(a)!;
        if (d < min) {
          const push = (min - d) / 2;
          coord.set(a, coord.get(a)! - push);
          coord.set(b, coord.get(b)! + push);
        }
      }
    }
    for (let i = 1; i < L.length; i++) {
      const a = L[i - 1];
      const b = L[i];
      const min = (along(a) + along(b)) / 2 + gap;
      if (coord.get(b)! - coord.get(a)! < min) coord.set(b, coord.get(a)! + min);
    }
  };
  for (let it = 0; it < 6; it++) {
    const down = it % 2 === 0;
    const range = down ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse();
    for (const l of range) {
      const L = layers[l];
      for (const id of L) {
        const nb = [...(down ? vPreds.get(id) ?? [] : vSuccs.get(id) ?? []), ...(it > 2 ? (down ? vSuccs.get(id) ?? [] : vPreds.get(id) ?? []) : [])];
        if (nb.length) coord.set(id, nb.reduce((s, p) => s + coord.get(p)!, 0) / nb.length);
      }
      resolve(L);
    }
  }
  const layerDepth = layers.map((L) => Math.max(0, ...L.map(depthOf)));
  const start: number[] = [];
  let acc = 0;
  layerDepth.forEach((d, l) => {
    start[l] = acc;
    acc += d + levelGap;
  });
  const pos: Positions = {};
  for (const id of order) {
    const l = layer.get(id)!;
    const depth = start[l] + (layerDepth[l] - depthOf(id)) / 2;
    const a = coord.get(id)! - along(id) / 2;
    pos[id] = horizontal ? { x: depth, y: a } : { x: a, y: depth };
  }
  if (dir === 'left' || dir === 'up') {
    const max = Math.max(...nodes.map((n) => (horizontal ? pos[n.id].x + n.w : pos[n.id].y + n.h)));
    for (const n of nodes) {
      if (horizontal) pos[n.id].x = max - pos[n.id].x - n.w;
      else pos[n.id].y = max - pos[n.id].y - n.h;
    }
  }
  return pos;
}

// --- graph → canvas elements ------------------------------------------------------------------------------------

export type NodeShape = 'rect' | 'round' | 'ellipse' | 'diamond' | 'sticky' | 'text' | 'pill';

export interface GraphNode {
  id: string;
  label: string;
  shape?: NodeShape;
  fill?: string;
  stroke?: string;
  color?: string;
  /** Group/subgraph id (becomes a frame). */
  group?: string;
  icon?: string;
  level?: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  thick?: boolean;
  head?: 'arrow' | 'none' | 'dot' | 'bar' | 'triangle';
  tail?: 'arrow' | 'none' | 'dot' | 'bar' | 'triangle';
}
export interface GraphSpec {
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups?: { id: string; title: string }[];
  layout?: LayoutKind;
  direction?: Direction;
  /** Visual style: flowchart (shapes + elbow arrows), mindmap (coloured branches, curves), org (cards). */
  style?: 'flowchart' | 'mindmap' | 'plain';
  sketch?: boolean;
}

const BRANCH = ['#4263eb', '#f76707', '#2f9e44', '#ae3ec9', '#1098ad', '#e64980', '#f59f00', '#5c7cfa'];
const SOFT: Record<string, string> = { '#4263eb': '#dbe4ff', '#f76707': '#ffe8cc', '#2f9e44': '#d3f9d8', '#ae3ec9': '#f3d9fa', '#1098ad': '#c5f6fa', '#e64980': '#ffdeeb', '#f59f00': '#fff3bf', '#5c7cfa': '#e5dbff' };

/** Size of a node for its label. */
export function nodeSize(label: string, shape: NodeShape = 'rect', fontSize = 16, bold = false): { w: number; h: number } {
  const maxW = shape === 'sticky' ? 200 : 240;
  const one = textWidth(label.split('\n').reduce((a, b) => (a.length > b.length ? a : b), ''), fontSize, bold);
  const innerW = Math.min(maxW, Math.max(80, one + 8));
  const lay = layoutText(label, fontSize, { maxWidth: innerW, bold });
  let w = innerW + 32;
  let h = Math.max(52, lay.height + 26);
  if (shape === 'diamond') {
    w = w * 1.45;
    h = Math.max(h * 1.55, 90);
  } else if (shape === 'ellipse') {
    w = w * 1.2;
    h = Math.max(h * 1.2, 60);
  } else if (shape === 'sticky') {
    w = 200;
    h = Math.max(140, lay.height + 50);
  } else if (shape === 'text') {
    w = innerW + 8;
    h = lay.height + 8;
  } else if (shape === 'pill') h = Math.max(44, lay.height + 18);
  return { w: Math.round(w), h: Math.round(h) };
}

/**
 * Builds canvas elements from a graph: positioned shapes, bound arrows, frames for groups.
 * `newId` creates element ids; `origin` is the top-left of the result on the board.
 */
export function buildGraph(spec: GraphSpec, newId: () => string, origin: { x: number; y: number } = { x: 0, y: 0 }): { elements: CanvasElement[]; ids: Record<string, string>; box: Box } {
  const style = spec.style ?? 'flowchart';
  const kind = spec.layout ?? (style === 'mindmap' ? 'mindmap' : 'flow');
  const nodes = spec.nodes.slice(0, 400);
  const ids: Record<string, string> = {};
  for (const n of nodes) ids[n.id] = newId();
  // levels (mind map colours): BFS from the first node
  const level = new Map<string, number>();
  const branchOf = new Map<string, number>();
  if (style === 'mindmap' && nodes.length) {
    const kids = new Map<string, string[]>();
    for (const e of spec.edges) (kids.get(e.from) ?? kids.set(e.from, []).get(e.from)!).push(e.to);
    const root = nodes[0].id;
    level.set(root, 0);
    const q = [root];
    while (q.length) {
      const cur = q.shift()!;
      (kids.get(cur) ?? []).forEach((c, i) => {
        if (level.has(c)) return;
        level.set(c, level.get(cur)! + 1);
        branchOf.set(c, level.get(cur) === 0 ? i : branchOf.get(cur)!);
        q.push(c);
      });
    }
  }
  const shapeOf = (n: GraphNode): NodeShape => n.shape ?? (style === 'mindmap' ? (level.get(n.id) ? (level.get(n.id)! > 1 ? 'text' : 'pill') : 'ellipse') : 'rect');
  const fontOf = (n: GraphNode) => (style === 'mindmap' ? (level.get(n.id) === 0 ? 22 : level.get(n.id) === 1 ? 18 : 16) : 16);
  const sized = nodes.map((n) => {
    const shape = shapeOf(n);
    const lvl = level.get(n.id) ?? 1;
    const s = nodeSize(n.label, shape, fontOf(n), style === 'mindmap' && lvl <= 1);
    return { n, shape, ...s };
  });
  const lnodes: LNode[] = sized.map((s) => ({ id: s.n.id, w: s.w, h: s.h }));
  const ledges: LEdge[] = spec.edges.map((e) => ({ from: e.from, to: e.to }));
  const pos = layoutGraph(lnodes, ledges, { kind, direction: spec.direction ?? (kind === 'tree' ? 'down' : 'right'), gap: style === 'mindmap' ? 18 : undefined });

  const elements: CanvasElement[] = [];
  let z = 1;
  for (const s of sized) {
    const p = pos[s.n.id] ?? { x: 0, y: 0 };
    const lvl = level.get(s.n.id) ?? 0;
    const branch = BRANCH[(branchOf.get(s.n.id) ?? 0) % BRANCH.length];
    const base: CanvasElement = { id: ids[s.n.id], type: 'rect', x: origin.x + p.x, y: origin.y + p.y, w: s.w, h: s.h, z: z++, text: s.n.label, fontSize: fontOf(s.n), strokeWidth: 2, sketch: spec.sketch || undefined };
    let el: CanvasElement;
    if (style === 'mindmap') {
      if (lvl === 0) el = { ...base, type: 'ellipse', fill: '#4263eb', stroke: '#364fc7', color: '#ffffff', bold: true };
      else if (lvl === 1) el = { ...base, type: 'rect', radius: s.h / 2, fill: SOFT[branch] ?? '#e7f5ff', stroke: branch, color: '#1e1e1e', bold: true };
      else el = { ...base, type: 'rect', radius: 8, fill: 'transparent', stroke: 'transparent', strokeWidth: 0, color: '#1e1e1e', align: 'left' };
    } else {
      switch (s.shape) {
        case 'diamond':
          el = { ...base, type: 'diamond', fill: '#fff9db', stroke: '#f08c00' };
          break;
        case 'ellipse':
          el = { ...base, type: 'ellipse', fill: '#ebfbee', stroke: '#2f9e44' };
          break;
        case 'sticky':
          el = { ...base, type: 'sticky', fill: '#fff3a3', strokeWidth: undefined, fontSize: 18 };
          break;
        case 'text':
          el = { ...base, type: 'text', strokeWidth: undefined, color: DEFAULT_INK };
          break;
        case 'round':
        case 'pill':
          el = { ...base, type: 'rect', radius: s.shape === 'pill' ? s.h / 2 : 16, fill: '#e7f5ff', stroke: '#1971c2' };
          break;
        default:
          el = { ...base, type: 'rect', radius: 8, fill: '#e7f5ff', stroke: '#1971c2' };
      }
    }
    if (s.n.fill) el.fill = s.n.fill;
    if (s.n.stroke) el.stroke = s.n.stroke;
    if (s.n.color) el.color = s.n.color;
    elements.push(el);
  }
  const byNode = new Map(elements.map((e) => [e.id, e]));
  if (style === 'mindmap' && nodes.length) {
    // branches on the left read towards the centre
    const root = byNode.get(ids[nodes[0].id])!;
    for (const n of nodes) {
      const el = byNode.get(ids[n.id])!;
      if ((level.get(n.id) ?? 0) > 1 && el.x + el.w / 2 < root.x + root.w / 2) el.align = 'right';
    }
  }
  const dir = spec.direction ?? (kind === 'tree' ? 'down' : 'right');
  for (const e of spec.edges.slice(0, 800)) {
    const a = ids[e.from];
    const b = ids[e.to];
    if (!a || !b) continue;
    const A = byNode.get(a)!;
    const B = byNode.get(b)!;
    const branch = BRANCH[(branchOf.get(e.to) ?? 0) % BRANCH.length];
    const mind = style === 'mindmap';
    // trees connect bottom → top (or right → left); edges going backwards in a flow curve around
    const treeAnchors: Pick<CanvasElement, 'start' | 'end'> | null =
      kind === 'tree' ? (dir === 'right' ? { start: { id: a, anchor: [1, 0.5] }, end: { id: b, anchor: [0, 0.5] } } : dir === 'left' ? { start: { id: a, anchor: [0, 0.5] }, end: { id: b, anchor: [1, 0.5] } } : dir === 'up' ? { start: { id: a, anchor: [0.5, 0] }, end: { id: b, anchor: [0.5, 1] } } : { start: { id: a, anchor: [0.5, 1] }, end: { id: b, anchor: [0.5, 0] } }) : null;
    const backwards = kind === 'flow' && (dir === 'right' ? B.x + B.w <= A.x : dir === 'left' ? B.x >= A.x + A.w : dir === 'up' ? B.y >= A.y + A.h : B.y + B.h <= A.y);
    elements.push({
      id: newId(),
      type: 'arrow',
      x: A.x + A.w / 2,
      y: A.y + A.h / 2,
      w: 0,
      h: 0,
      z: 0,
      points: [[0, 0], [B.x + B.w / 2 - (A.x + A.w / 2), B.y + B.h / 2 - (A.y + A.h / 2)]],
      start: treeAnchors?.start ?? { id: a },
      end: treeAnchors?.end ?? { id: b },
      stroke: mind ? branch : '#495057',
      strokeWidth: mind ? 2.5 : e.thick ? 3.5 : 2,
      strokeStyle: e.dashed ? 'dashed' : undefined,
      route: mind || kind === 'radial' || backwards ? 'curved' : kind === 'flow' || kind === 'tree' ? 'elbow' : 'straight',
      endHead: mind ? 'none' : (e.head ?? 'arrow'),
      startHead: e.tail && e.tail !== 'none' ? e.tail : undefined,
      text: e.label || undefined,
      fontSize: 14,
      sketch: spec.sketch || undefined,
    });
  }
  // frames around groups (subgraphs)
  const groups = spec.groups ?? [];
  for (const g of groups) {
    const members = sized.filter((s) => s.n.group === g.id).map((s) => byNode.get(ids[s.n.id])!);
    if (!members.length) continue;
    const x1 = Math.min(...members.map((m) => m.x)) - 30;
    const y1 = Math.min(...members.map((m) => m.y)) - 30;
    const x2 = Math.max(...members.map((m) => m.x + m.w)) + 30;
    const y2 = Math.max(...members.map((m) => m.y + m.h)) + 30;
    const fid = newId();
    elements.push({ id: fid, type: 'frame', x: x1, y: y1, w: x2 - x1, h: y2 - y1, z: -100, name: g.title || g.id, fill: '#f8f9fa' });
    for (const m of members) m.frameId = fid;
  }
  // arrows below shapes, frames at the bottom
  elements.forEach((el, i) => {
    if (el.type === 'arrow') el.z = -1 + i / 10000;
  });
  const xs = elements.filter((e) => e.type !== 'arrow');
  const box = xs.length
    ? { x: Math.min(...xs.map((e) => e.x)), y: Math.min(...xs.map((e) => e.y)), w: Math.max(...xs.map((e) => e.x + e.w)) - Math.min(...xs.map((e) => e.x)), h: Math.max(...xs.map((e) => e.y + e.h)) - Math.min(...xs.map((e) => e.y)) }
    : { x: origin.x, y: origin.y, w: 0, h: 0 };
  return { elements, ids, box };
}

/** Graph of existing elements: shapes as nodes, bound arrows as edges (for "Layout aufräumen"). */
export function graphOfElements(els: CanvasElement[]): { nodes: LNode[]; edges: LEdge[]; arrows: CanvasElement[] } {
  const nodes = els.filter((e) => e.type !== 'arrow' && e.type !== 'line' && e.type !== 'frame' && !e.locked).map((e) => ({ id: e.id, w: e.w, h: e.h }));
  const ids = new Set(nodes.map((n) => n.id));
  const arrows = els.filter((e) => (e.type === 'arrow' || e.type === 'line') && e.start && e.end && ids.has(e.start.id) && ids.has(e.end.id));
  return { nodes, edges: arrows.map((a) => ({ from: a.start!.id, to: a.end!.id })), arrows };
}
