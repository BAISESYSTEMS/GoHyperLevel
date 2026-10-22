import { laneKeys, ROOT_KEY, type Slot, type Step } from './model';

/**
 * Auto-layout of the canvas (pure): trigger on top, steps downwards, the lanes of a container side by side under their header
 * cards, joined again below; END pills where the flow stops. Hand-made positions are offsets from this layout
 * (`settings.layout.offsets`, server/services/workflow-layout.ts): moving a container moves everything inside it, and a node
 * without an offset sits where the layout puts it.
 */

export const SIZE = { nodeW: 272, nodeH: 76, branchW: 172, branchH: 40, gapY: 64, laneGap: 44, endW: 64, endH: 28 } as const;

export interface LaneInfo {
  key: string;
  label: string;
  tone?: 'yes' | 'no';
}
export type NodeKind = 'trigger' | 'add-trigger' | 'step' | 'branch' | 'end';
export interface LNode {
  key: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  step?: Step;
  lane?: LaneInfo & { parent: string };
  /** The offset keys that move this node (its containers, its lane, itself). */
  chain: string[];
}
export interface LEdge {
  key: string;
  d: string;
  slot?: Slot;
  mid: [number, number];
  tone?: 'yes' | 'no';
  loop?: boolean;
}
export interface LInsert {
  key: string;
  x: number;
  y: number;
  slot: Slot;
}
export interface Layout {
  nodes: LNode[];
  edges: LEdge[];
  inserts: LInsert[];
  joins: { key: string; x: number; y: number }[];
  bounds: { x: number; y: number; w: number; h: number };
}

type Anchor = { node: string; side: 'top' | 'bottom' | 'right' } | { point: string };
interface Link {
  from: Anchor;
  to: Anchor;
  slot?: Slot;
  tone?: 'yes' | 'no';
  loop?: number;
}

export const slotKey = (s: Slot) => `${s.parent ?? 'root'}/${s.key}/${s.index}`;
const anchorKey = (a: Anchor) => ('node' in a ? `${a.node}.${a.side}` : a.point);

/**
 * `lanesOf` names the lanes of a container (WorkflowTools' branchesOf: Ja/Nein, the split-test paths, the loop body).
 * `trigger: false` draws the dashed "add trigger" placeholder instead of the trigger.
 */
export function layoutFlow(steps: Step[], lanesOf: (s: Step) => LaneInfo[], offsets: Record<string, [number, number]> = {}, opts: { trigger?: boolean } = {}): Layout {
  const { nodeW, nodeH, branchW, branchH, gapY, laneGap, endW, endH } = SIZE;
  const nodes: LNode[] = [];
  const links: Link[] = [];
  const points = new Map<string, { x: number; y: number; chain: string[] }>();
  const widths = new Map<Step, number>();
  const lanes = (s: Step) => {
    const have = new Set(laneKeys(s));
    return lanesOf(s).filter((l) => have.has(l.key));
  };

  const widthOfList = (list: Step[]): number => Math.max(nodeW, ...list.map(widthOfStep));
  function widthOfStep(s: Step): number {
    const known = widths.get(s);
    if (known !== undefined) return known;
    const ls = lanes(s);
    const w = ls.length ? Math.max(nodeW, ls.reduce((n, l) => n + Math.max(branchW, widthOfList(s[l.key] ?? [])), 0) + laneGap * (ls.length - 1)) : nodeW;
    widths.set(s, w);
    return w;
  }
  const chainOf = (a: Anchor): string[] => ('node' in a ? nodes.find((n) => n.key === a.node)?.chain ?? [] : points.get(a.point)?.chain ?? []);
  const endPill = (key: string, cx: number, y: number, chain: string[]) => nodes.push({ key, kind: 'end', x: cx - endW / 2, y, w: endW, h: endH, chain });

  /** Places a list centred on cx from y; links `entry` to its first step. Returns where the flow leaves it. */
  function placeList(list: Step[], cx: number, y: number, parent: string | null, key: string, chain: string[], entry: Anchor): { exit: Anchor; bottom: number; ended: boolean } {
    let prev = entry;
    let cur = y;
    list.forEach((s, i) => {
      const own = [...chain, s.id];
      nodes.push({ key: s.id, kind: 'step', x: cx - nodeW / 2, y: cur, w: nodeW, h: nodeH, step: s, chain: own });
      links.push({ from: prev, to: { node: s.id, side: 'top' }, slot: { parent, key, index: i } });
      cur += nodeH;
      const ls = lanes(s);
      if (ls.length) {
        cur += gapY;
        const ws = ls.map((l) => Math.max(branchW, widthOfList(s[l.key] ?? [])));
        const total = ws.reduce((a, b) => a + b, 0) + laneGap * (ls.length - 1);
        let lx = cx - total / 2;
        const top = cur;
        const tails: { exit: Anchor; index: number; lane: string; ended: boolean }[] = [];
        let bottom = top + branchH;
        ls.forEach((l, j) => {
          const lcx = lx + ws[j] / 2;
          lx += ws[j] + laneGap;
          const hk = `${s.id}/${l.key}`;
          const hc = [...own, hk];
          nodes.push({ key: hk, kind: 'branch', x: lcx - branchW / 2, y: top, w: branchW, h: branchH, lane: { ...l, parent: s.id }, chain: hc });
          links.push({ from: { node: s.id, side: 'bottom' }, to: { node: hk, side: 'top' }, tone: l.tone });
          const lane: Step[] = s[l.key] ?? [];
          const r = placeList(lane, lcx, top + branchH + gapY, s.id, l.key, hc, { node: hk, side: 'bottom' });
          bottom = Math.max(bottom, r.bottom);
          tails.push({ exit: r.exit, index: lane.length, lane: l.key, ended: r.ended });
        });
        const jk = `${s.id}:join`;
        const jy = bottom + gapY;
        points.set(jk, { x: cx, y: jy, chain: own });
        for (const tail of tails) if (!tail.ended) links.push({ from: tail.exit, to: { point: jk }, slot: { parent: s.id, key: tail.lane, index: tail.index } });
        if (s.type === 'loop') links.push({ from: { point: jk }, to: { node: s.id, side: 'right' }, loop: total / 2 + 36 });
        prev = { point: jk };
        cur = jy;
      } else prev = { node: s.id, side: 'bottom' };
      cur += gapY;
    });
    const last = list[list.length - 1];
    const ended = !!last && last.type === 'end' && last.disabled !== true;
    let bottom = cur - gapY;
    if (ended) {
      const k = `${last.id}:end`;
      endPill(k, cx, bottom + gapY * 0.6, chainOf(prev));
      links.push({ from: prev, to: { node: k, side: 'top' } });
      bottom += gapY * 0.6 + endH;
    }
    return { exit: prev, bottom, ended };
  }

  nodes.push({ key: 'trigger', kind: opts.trigger === false ? 'add-trigger' : 'trigger', x: -nodeW / 2, y: 0, w: nodeW, h: nodeH, chain: ['trigger'] });
  const root = placeList(steps, 0, nodeH + gapY, null, ROOT_KEY, [], { node: 'trigger', side: 'bottom' });
  if (!root.ended) {
    endPill('end', 0, root.bottom + gapY, chainOf(root.exit));
    links.push({ from: root.exit, to: { node: 'end', side: 'top' }, slot: { parent: null, key: ROOT_KEY, index: steps.length } });
  }

  // Hand-made offsets: each node moves by the offsets of its containers, its lane and itself.
  const shift = (chain: string[]) => chain.reduce<[number, number]>((acc, k) => (offsets[k] ? [acc[0] + offsets[k][0], acc[1] + offsets[k][1]] : acc), [0, 0]);
  for (const n of nodes) {
    const [dx, dy] = shift(n.chain);
    n.x += dx;
    n.y += dy;
  }
  for (const p of points.values()) {
    const [dx, dy] = shift(p.chain);
    p.x += dx;
    p.y += dy;
  }

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const at = (a: Anchor): [number, number] => {
    if ('point' in a) {
      const p = points.get(a.point)!;
      return [p.x, p.y];
    }
    const n = byKey.get(a.node)!;
    return a.side === 'top' ? [n.x + n.w / 2, n.y] : a.side === 'bottom' ? [n.x + n.w / 2, n.y + n.h] : [n.x + n.w, n.y + n.h / 2];
  };
  const r = (v: number) => Math.round(v * 10) / 10;
  const edges: LEdge[] = links.map((l) => {
    const [x1, y1] = at(l.from);
    const [x2, y2] = at(l.to);
    const key = `${anchorKey(l.from)}>${anchorKey(l.to)}`;
    if (l.loop) {
      // around the right side of the loop's block, back up to the loop step
      const rx = Math.max(x1, x2) + l.loop;
      return { key, d: `M${r(x1)} ${r(y1)} C${r(rx)} ${r(y1)} ${r(rx)} ${r(y2)} ${r(x2)} ${r(y2)}`, mid: [r((x1 + x2 + 6 * rx) / 8), r((y1 + y2) / 2)], loop: true };
    }
    const k = Math.max(24, Math.abs(y2 - y1) / 2);
    return { key, d: `M${r(x1)} ${r(y1)} C${r(x1)} ${r(y1 + k)} ${r(x2)} ${r(y2 - k)} ${r(x2)} ${r(y2)}`, mid: [r((x1 + x2) / 2), r((y1 + y2) / 2)], ...(l.slot ? { slot: l.slot } : {}), ...(l.tone ? { tone: l.tone } : {}) };
  });
  const inserts: LInsert[] = edges.filter((e) => e.slot).map((e) => ({ key: slotKey(e.slot!), x: e.mid[0], y: e.mid[1], slot: e.slot! }));
  const joins = [...points.entries()].map(([key, p]) => ({ key, x: p.x, y: p.y }));

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + n.w);
    y1 = Math.max(y1, n.y + n.h);
  }
  return { nodes, edges, inserts, joins, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/** The nearest node from `from` in an arrow direction (keyboard navigation on the canvas). */
export function nearestNode(nodes: LNode[], from: LNode, dir: 'up' | 'down' | 'left' | 'right'): LNode | undefined {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: LNode | undefined;
  let score = Infinity;
  for (const n of nodes) {
    if (n === from || n.kind === 'end') continue;
    const dx = n.x + n.w / 2 - cx;
    const dy = n.y + n.h / 2 - cy;
    const main = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const side = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (main <= 1 || side > main * 2.5 + 40) continue;
    const s = main + side * 2;
    if (s < score) {
      score = s;
      best = n;
    }
  }
  return best;
}
