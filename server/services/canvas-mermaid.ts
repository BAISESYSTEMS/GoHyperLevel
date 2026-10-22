/**
 * A useful subset of Mermaid for the canvas (own parser, no library):
 * - `flowchart`/`graph` (TD/TB/LR/RL/BT): node shapes [] () ([]) (()) {} {{}} >] [()] [//], chained
 *   edges with --> --- -.-> ==> --o --x <-->, labels (-->|Ja| and -- Ja -->), `A & B --> C`,
 *   subgraphs (→ frames), `style X fill:#…` and `%%` comments
 * - `mindmap`: indentation tree, root((…)), shapes [] () (()) {{}} ))((, ::icon() ignored
 * - `sequenceDiagram`: participant/actor (… as …), messages ->> -->> -> --> -x -) with text,
 *   notes; loop/alt/opt/par blocks become labelled bands
 *
 * Parsing gives a GraphSpec (laid out by canvas-layout) or a sequence description.
 *
 * Pure code (also used in the browser).
 */

import { type CanvasElement } from './canvas-model.js';
import { type Direction, type GraphEdge, type GraphNode, type GraphSpec, type NodeShape, buildGraph } from './canvas-layout.js';
import { layoutText, textWidth } from './canvas-text.js';

export class MermaidError extends Error {}

export type MermaidResult =
  | { kind: 'flowchart' | 'mindmap'; graph: GraphSpec }
  | { kind: 'sequence'; participants: { id: string; label: string; actor?: boolean }[]; items: SeqItem[] };

export type SeqItem =
  | { t: 'msg'; from: string; to: string; text: string; dashed: boolean; head: 'arrow' | 'open' | 'cross' }
  | { t: 'note'; over: string[]; side: 'left' | 'right' | 'over'; text: string }
  | { t: 'block'; label: string; start: boolean };

const clean = (s: string) =>
  s
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\\n/g, '\n')
    .trim()
    .slice(0, 300);

/** Detects the diagram type and parses it. */
export function parseMermaid(src: string): MermaidResult {
  const text = String(src ?? '').replace(/^\s*```(?:mermaid)?\s*\n?/i, '').replace(/```\s*$/, '');
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim() && !l.trim().startsWith('%%'));
  if (firstIdx < 0) throw new MermaidError('Mermaid: leerer Text');
  const head = lines[firstIdx].trim();
  const rest = lines.slice(firstIdx + 1);
  if (/^(flowchart|graph)\b/i.test(head)) return { kind: 'flowchart', graph: parseFlowchart(head, rest) };
  if (/^mindmap\b/i.test(head)) return { kind: 'mindmap', graph: parseMindmap(rest) };
  if (/^sequenceDiagram\b/i.test(head)) return parseSequence(rest);
  throw new MermaidError(`Mermaid: „${head.slice(0, 40)}“ wird nicht unterstützt – nur flowchart/graph, mindmap und sequenceDiagram`);
}

// --- flowchart -----------------------------------------------------------------------------------

const DIRS: Record<string, Direction> = { TD: 'down', TB: 'down', LR: 'right', RL: 'left', BT: 'up' };

/** Node shapes: opening bracket sequence → [closing, shape]. Longest first. */
const SHAPES: [string, string, NodeShape][] = [
  ['(((', ')))', 'ellipse'],
  ['([', '])', 'pill'],
  ['[(', ')]', 'rect'],
  ['[[', ']]', 'rect'],
  ['((', '))', 'ellipse'],
  ['{{', '}}', 'diamond'],
  ['[/', '/]', 'rect'],
  ['[\\', '\\]', 'rect'],
  ['[/', '\\]', 'rect'],
  ['[\\', '/]', 'rect'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
  ['>', ']', 'rect'],
];

function parseNodeRef(s: string, nodes: Map<string, GraphNode>, order: string[], group?: string): { ids: string[]; rest: string } | null {
  // A & B & C(Label)
  const ids: string[] = [];
  let cur = s;
  for (;;) {
    const m = cur.match(/^\s*([A-Za-z0-9_À-ɏ.-]+)/);
    if (!m) return ids.length ? { ids, rest: cur } : null;
    const id = m[1];
    cur = cur.slice(m[0].length);
    let label: string | undefined;
    let shape: NodeShape | undefined;
    for (const [open, close, sh] of SHAPES) {
      if (!cur.startsWith(open)) continue;
      const end = cur.indexOf(close, open.length);
      if (end < 0) continue;
      label = clean(cur.slice(open.length, end));
      shape = sh;
      cur = cur.slice(end + close.length);
      break;
    }
    // ::: class shorthand
    cur = cur.replace(/^:::[A-Za-z0-9_-]+/, '');
    const existing = nodes.get(id);
    if (!existing) {
      nodes.set(id, { id, label: label ?? id, shape: shape ?? 'rect', group });
      order.push(id);
    } else {
      if (label !== undefined) existing.label = label;
      if (shape) existing.shape = shape;
      if (group && !existing.group) existing.group = group;
    }
    ids.push(id);
    const amp = cur.match(/^\s*&\s*/);
    if (!amp) return { ids, rest: cur };
    cur = cur.slice(amp[0].length);
  }
}

/** An edge operator at the start of `s` (with optional label). */
function parseEdge(s: string): { edge: Omit<GraphEdge, 'from' | 'to'>; rest: string } | null {
  const t = s.replace(/^\s+/, '');
  // "-- label -->" / "== label ==>" / "-. label .->"
  let m = t.match(/^(<?)(--|==|-\.)\s*([^-=.>|][^>]*?)\s*(-->|==>|\.->|---|===|-\.-)([ox>]?)/);
  if (m && !/^[-=.]/.test(m[3])) {
    const op = m[2] + m[4];
    return { edge: edgeStyle(op, m[1] === '<', m[5], clean(m[3])), rest: t.slice(m[0].length) };
  }
  m = t.match(/^(<|o|x)?(-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-|~~~|--(?=[ox]\s))([ox]?)/);
  if (!m) return null;
  let rest = t.slice(m[0].length);
  let label: string | undefined;
  const lm = rest.match(/^\s*\|([^|]*)\|/);
  if (lm) {
    label = clean(lm[1]);
    rest = rest.slice(lm[0].length);
  }
  return { edge: edgeStyle(m[2], m[1] === '<', m[3], label, m[1]), rest };
}

function edgeStyle(op: string, both: boolean, endMark: string, label?: string, startMark?: string): Omit<GraphEdge, 'from' | 'to'> {
  const dashed = op.includes('.');
  const thick = op.startsWith('=');
  const arrow = op.endsWith('>');
  const head = endMark === 'o' ? 'dot' : endMark === 'x' ? 'bar' : arrow ? 'arrow' : 'none';
  const tail = both ? 'arrow' : startMark === 'o' ? 'dot' : startMark === 'x' ? 'bar' : undefined;
  return { dashed, thick, head, ...(tail ? { tail } : {}), ...(label ? { label } : {}) };
}

function parseFlowchart(head: string, lines: string[]): GraphSpec {
  const dir = DIRS[(head.split(/\s+/)[1] ?? 'TD').toUpperCase()] ?? 'down';
  const nodes = new Map<string, GraphNode>();
  const order: string[] = [];
  const edges: GraphEdge[] = [];
  const groups: { id: string; title: string }[] = [];
  const stack: string[] = [];
  for (const raw of lines) {
    // statements may be separated by ';'
    for (let line of raw.split(';')) {
      line = line.replace(/%%.*$/, '').trim();
      if (!line) continue;
      if (/^(classDef|class|click|linkStyle|direction)\b/.test(line)) continue;
      const sm = line.match(/^subgraph\s+(.+)$/);
      if (sm) {
        const spec = sm[1].trim();
        const m = spec.match(/^([A-Za-z0-9_-]+)\s*\[(.+)\]$/);
        const gid = m ? m[1] : `g${groups.length + 1}`;
        groups.push({ id: gid, title: clean(m ? m[2] : spec) });
        stack.push(gid);
        continue;
      }
      if (line === 'end') {
        stack.pop();
        continue;
      }
      const st = line.match(/^style\s+([A-Za-z0-9_-]+)\s+(.+)$/);
      if (st) {
        const n = nodes.get(st[1]);
        if (n) {
          const fill = st[2].match(/fill:\s*(#[0-9a-fA-F]{3,6})/);
          const stroke = st[2].match(/stroke:\s*(#[0-9a-fA-F]{3,6})/);
          const color = st[2].match(/color:\s*(#[0-9a-fA-F]{3,6})/);
          if (fill) n.fill = fill[1];
          if (stroke) n.stroke = stroke[1];
          if (color) n.color = color[1];
        }
        continue;
      }
      const group = stack[stack.length - 1];
      let left = parseNodeRef(line, nodes, order, group);
      if (!left) continue;
      let rest = left.rest;
      for (let guard = 0; guard < 50; guard++) {
        const e = parseEdge(rest);
        if (!e) break;
        const right = parseNodeRef(e.rest, nodes, order, group);
        if (!right) break;
        for (const a of left.ids) for (const b of right.ids) edges.push({ from: a, to: b, ...e.edge });
        left = right;
        rest = right.rest;
      }
    }
  }
  if (!order.length) throw new MermaidError('Mermaid: keine Knoten gefunden');
  return { nodes: order.map((id) => nodes.get(id)!), edges, groups, layout: 'flow', direction: dir, style: 'flowchart' };
}

// --- mindmap ---------------------------------------------------------------------------------------------

function parseMindmap(lines: string[]): GraphSpec {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const stack: { indent: number; id: string }[] = [];
  let n = 0;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('%%')) continue;
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, '    ').length;
    let t = raw.trim();
    if (/^::icon\(/.test(t) || /^:::/.test(t)) continue;
    t = t.replace(/::icon\([^)]*\)/g, '').trim();
    // shapes (root((…)), [..], (..), {{..}}, ))..(() only carry the label – the mind map style draws by level
    const m = t.match(/^([A-Za-z0-9_-]*)\s*(\(\(|\)\)|\(|\[|\{\{)(.*?)(\)\)|\(\(|\)|\]|\}\})$/);
    const label = m ? m[3] : t;
    const id = `m${++n}`;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    nodes.push({ id, label: clean(label) || '…' });
    if (parent) edges.push({ from: parent.id, to: id });
    stack.push({ indent, id });
    if (nodes.length >= 300) break;
  }
  if (!nodes.length) throw new MermaidError('Mermaid: Mindmap ohne Einträge');
  return { nodes, edges, layout: 'mindmap', style: 'mindmap' };
}

// --- sequence ----------------------------------------------------------------------------------------------

function parseSequence(lines: string[]): MermaidResult {
  const participants: { id: string; label: string; actor?: boolean }[] = [];
  const items: SeqItem[] = [];
  const ensure = (id: string) => {
    if (!participants.some((p) => p.id === id)) participants.push({ id, label: id });
  };
  for (const raw of lines) {
    const line = raw.replace(/%%.*$/, '').trim();
    if (!line || /^(autonumber|activate|deactivate|title)\b/.test(line)) continue;
    let m = line.match(/^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/);
    if (m) {
      const existing = participants.find((p) => p.id === m![2]);
      if (existing) existing.label = clean(m[3] ?? existing.label);
      else participants.push({ id: m[2], label: clean(m[3] ?? m[2]), actor: m[1] === 'actor' || undefined });
      continue;
    }
    m = line.match(/^Note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i);
    if (m) {
      const over = m[2].split(',').map((s) => s.trim()).filter(Boolean);
      over.forEach(ensure);
      items.push({ t: 'note', over, side: m[1].toLowerCase().startsWith('left') ? 'left' : m[1].toLowerCase().startsWith('right') ? 'right' : 'over', text: clean(m[3]) });
      continue;
    }
    m = line.match(/^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/);
    if (m) {
      items.push({ t: 'block', label: clean(`${m[1]} ${m[2]}`), start: true });
      continue;
    }
    m = line.match(/^(else|and)\b\s*(.*)$/);
    if (m) {
      items.push({ t: 'block', label: clean(`${m[1]} ${m[2]}`), start: true });
      continue;
    }
    if (line === 'end') {
      items.push({ t: 'block', label: '', start: false });
      continue;
    }
    m = line.match(/^([^-\s>]+?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)([^:\s]+?)\s*:\s*(.*)$/);
    if (m) {
      ensure(m[1]);
      ensure(m[4]);
      const op = m[2];
      items.push({ t: 'msg', from: m[1], to: m[4], text: clean(m[5]), dashed: op.startsWith('--'), head: op.endsWith('x') ? 'cross' : op.endsWith(')') || !op.includes('>>') ? 'open' : 'arrow' });
    }
    if (items.length > 400) break;
  }
  if (!participants.length) throw new MermaidError('Mermaid: Sequenzdiagramm ohne Teilnehmer');
  return { kind: 'sequence', participants: participants.slice(0, 20), items };
}

/** Elements of a sequence diagram: participant boxes, lifelines, messages top to bottom. */
export function buildSequence(seq: Extract<MermaidResult, { kind: 'sequence' }>, newId: () => string, origin = { x: 0, y: 0 }, sketch = false): CanvasElement[] {
  const out: CanvasElement[] = [];
  const colW = Math.max(200, ...seq.participants.map((p) => textWidth(p.label, 16, true) + 60));
  const xOf = new Map<string, number>();
  seq.participants.forEach((p, i) => xOf.set(p.id, origin.x + i * colW + colW / 2));
  const boxW = colW - 50;
  const top = origin.y;
  let y = top + 100;
  const rows: { y: number; item: SeqItem }[] = [];
  for (const item of seq.items) {
    if (item.t === 'msg') {
      const lines = layoutText(item.text, 14, { maxWidth: Math.max(120, Math.abs((xOf.get(item.to)! - xOf.get(item.from)!)) - 20) }).lines.length;
      rows.push({ y: y + lines * 18, item });
      y += 40 + lines * 18;
    } else if (item.t === 'note') {
      rows.push({ y, item });
      y += 70;
    } else {
      rows.push({ y, item });
      y += item.start ? 34 : 16;
    }
  }
  const bottom = y + 20;
  let z = 1;
  for (const p of seq.participants) {
    const cx = xOf.get(p.id)!;
    const boxId = newId();
    out.push({ id: boxId, type: 'rect', x: cx - boxW / 2, y: top, w: boxW, h: 56, z: z++, radius: 10, fill: p.actor ? '#fff4e6' : '#e7f5ff', stroke: p.actor ? '#f08c00' : '#1971c2', strokeWidth: 2, text: p.label, fontSize: 16, bold: true, sketch: sketch || undefined });
    out.push({ id: newId(), type: 'line', x: cx, y: top + 56, w: 0, h: bottom - top - 56, z: 0, points: [[0, 0], [0, bottom - top - 56]], stroke: '#adb5bd', strokeWidth: 1.5, strokeStyle: 'dashed' });
  }
  const openBlocks: { y: number; label: string }[] = [];
  for (const { y: ry, item } of rows) {
    if (item.t === 'msg') {
      const x1 = xOf.get(item.from)!;
      const x2 = xOf.get(item.to)!;
      if (item.from === item.to) {
        out.push({ id: newId(), type: 'arrow', x: x1, y: ry - 14, w: 50, h: 28, z: z++, points: [[0, 0], [50, 0], [50, 28], [0, 28]], stroke: '#343a40', strokeWidth: 2, strokeStyle: item.dashed ? 'dashed' : undefined, endHead: item.head === 'cross' ? 'bar' : 'arrow', text: item.text || undefined, fontSize: 14, sketch: sketch || undefined });
      } else {
        out.push({ id: newId(), type: 'arrow', x: Math.min(x1, x2), y: ry, w: Math.abs(x2 - x1), h: 0, z: z++, points: x2 >= x1 ? [[0, 0], [x2 - x1, 0]] : [[x1 - x2, 0], [0, 0]], stroke: '#343a40', strokeWidth: 2, strokeStyle: item.dashed ? 'dashed' : undefined, endHead: item.head === 'cross' ? 'bar' : item.head === 'open' ? 'arrow' : 'triangle', sketch: sketch || undefined });
        if (item.text) {
          const lay = layoutText(item.text, 14, { maxWidth: Math.max(120, Math.abs(x2 - x1) - 20) });
          out.push({ id: newId(), type: 'text', x: Math.min(x1, x2) + 10, y: ry - lay.height - 4, w: Math.max(120, Math.abs(x2 - x1) - 20), h: lay.height, z: z++, text: item.text, fontSize: 14, align: 'center', color: '#343a40' });
        }
      }
    } else if (item.t === 'note') {
      const xs = item.over.map((o) => xOf.get(o)!).filter((v) => v !== undefined);
      const cx = item.side === 'over' ? (Math.min(...xs) + Math.max(...xs)) / 2 : item.side === 'left' ? xs[0] - colW / 2 : xs[0] + colW / 2;
      const w = item.side === 'over' && xs.length > 1 ? Math.max(...xs) - Math.min(...xs) + 120 : 170;
      out.push({ id: newId(), type: 'sticky', x: cx - w / 2, y: ry, w, h: 54, z: z++, fill: '#fff3a3', text: item.text, fontSize: 14 });
    } else if (item.start) {
      openBlocks.push({ y: ry, label: item.label });
    } else {
      const b = openBlocks.pop();
      if (!b) continue;
      const x1 = origin.x + 10;
      const x2 = origin.x + seq.participants.length * colW - 10;
      out.push({ id: newId(), type: 'rect', x: x1, y: b.y, w: x2 - x1, h: ry - b.y + 8, z: -50, fill: 'transparent', stroke: '#868e96', strokeWidth: 1.5, strokeStyle: 'dashed', radius: 6 });
      out.push({ id: newId(), type: 'text', x: x1 + 8, y: b.y + 4, w: 300, h: 20, z: z++, text: b.label, fontSize: 13, bold: true, color: '#495057' });
    }
  }
  return out;
}

/** Mermaid → canvas elements at `origin`. */
export function mermaidToElements(src: string, newId: () => string, origin = { x: 0, y: 0 }, opts: { sketch?: boolean } = {}): { kind: MermaidResult['kind']; elements: CanvasElement[] } {
  const r = parseMermaid(src);
  if (r.kind === 'sequence') return { kind: r.kind, elements: buildSequence(r, newId, origin, opts.sketch) };
  return { kind: r.kind, elements: buildGraph({ ...r.graph, sketch: opts.sketch }, newId, origin).elements };
}

