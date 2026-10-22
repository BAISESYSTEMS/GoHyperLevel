import { tr } from '../../i18n';

/**
 * The page as the editor sees it: a tree of sections → rows → columns → blocks, and the operations on it. Pure functions (no DOM;
 * only the tree labels read the UI language) so drag & drop, insert-where-it-makes-sense and the limits are testable. The server cleans everything again on save
 * (server/services/site-layout.ts) – these functions only keep the tree well-formed while editing.
 */

export type Block = Record<string, any>;
export type Kind = 'section' | 'row' | 'col' | 'block';
/** Where nodes live: the page itself, the rows of a section, the columns of a row, the blocks of a column. */
export type Container = { kind: 'root' } | { kind: 'section'; id: string } | { kind: 'row'; id: string } | { kind: 'col'; id: string };

export const MAX_COLS = 4;
export const uid = () => Math.random().toString(36).slice(2, 10);

export const kindOf = (n: Block): Kind => (n.type === 'section' ? 'section' : !n.type && Array.isArray(n.cols) ? 'row' : !n.type && Array.isArray(n.blocks) ? 'col' : 'block');

const sameContainer = (a: Container, b: Container) => a.kind === b.kind && (a as any).id === (b as any).id;

/** The list a container holds. */
export function childrenOf(tree: Block[], c: Container): Block[] {
  if (c.kind === 'root') return tree;
  const hit = find(tree, c.id);
  if (!hit) return [];
  if (c.kind === 'section') return hit.node.rows ?? [];
  if (c.kind === 'row') return hit.node.cols ?? [];
  return hit.node.blocks ?? [];
}

/** Every node (sections, rows, columns, blocks) in document order, with its parent container. */
export function walk(tree: Block[], fn: (n: Block, parent: Container, index: number) => void, parent: Container = { kind: 'root' }): void {
  tree.forEach((n, i) => {
    fn(n, parent, i);
    if (n.type === 'section') walk(n.rows ?? [], fn, { kind: 'section', id: n.id });
    else if (kindOf(n) === 'row') walk(n.cols ?? [], fn, { kind: 'row', id: n.id });
    else if (kindOf(n) === 'col') walk(n.blocks ?? [], fn, { kind: 'col', id: n.id });
  });
}

export function find(tree: Block[], id: string): { node: Block; parent: Container; index: number } | undefined {
  let hit: { node: Block; parent: Container; index: number } | undefined;
  walk(tree, (n, parent, index) => {
    if (!hit && n.id === id) hit = { node: n, parent, index };
  });
  return hit;
}

const childKey = (n: Block): 'rows' | 'cols' | 'blocks' | undefined => (n.type === 'section' ? 'rows' : kindOf(n) === 'row' ? 'cols' : kindOf(n) === 'col' ? 'blocks' : undefined);

/** Applies `fn` to the list of the container (immutably). */
function withList(tree: Block[], c: Container, fn: (list: Block[]) => Block[]): Block[] {
  if (c.kind === 'root') return fn(tree);
  const go = (list: Block[]): Block[] =>
    list.map((n) => {
      const key = childKey(n);
      if (!key) return n;
      if (n.id === c.id) return { ...n, [key]: fn(n[key] ?? []) };
      return { ...n, [key]: go(n[key] ?? []) };
    });
  return go(tree);
}

/** Changes one node: `patch` is merged in, or `fn` returns the new node. */
export function update(tree: Block[], id: string, patch: Block | ((n: Block) => Block)): Block[] {
  const go = (list: Block[]): Block[] =>
    list.map((n) => {
      if (n.id === id) return typeof patch === 'function' ? patch(n) : { ...n, ...patch };
      const key = childKey(n);
      return key ? { ...n, [key]: go(n[key] ?? []) } : n;
    });
  return go(tree);
}

export function remove(tree: Block[], id: string): { tree: Block[]; node?: Block } {
  const hit = find(tree, id);
  if (!hit) return { tree };
  return { tree: withList(tree, hit.parent, (l) => l.filter((n) => n.id !== id)), node: hit.node };
}

export function insert(tree: Block[], c: Container, index: number, node: Block): Block[] {
  return withList(tree, c, (l) => {
    const at = Math.max(0, Math.min(index, l.length));
    return [...l.slice(0, at), node, ...l.slice(at)];
  });
}

/** May a node of this kind live in this container? (sections on the page, rows in sections, up to four columns in a row …) */
export function canDrop(tree: Block[], kind: Kind, c: Container, movingId?: string): boolean {
  if (kind === 'section') return c.kind === 'root';
  if (kind === 'row') return c.kind === 'section';
  if (kind === 'col') {
    if (c.kind !== 'row') return false;
    const n = childrenOf(tree, c);
    return n.length < MAX_COLS || n.some((x) => x.id === movingId);
  }
  return c.kind === 'root' || c.kind === 'col';
}

/** Is `id` inside the node `ancestorId` (or the node itself)? A node cannot be dropped into itself. */
export function contains(tree: Block[], ancestorId: string, id: string): boolean {
  const a = find(tree, ancestorId);
  if (!a) return false;
  let found = a.node.id === id;
  walk([a.node], (n) => {
    if (n.id === id) found = true;
  });
  return found;
}

/** Moves a node to `index` of a container. Returns the tree unchanged when the move is not allowed. */
export function move(tree: Block[], id: string, c: Container, index: number): Block[] {
  const hit = find(tree, id);
  if (!hit) return tree;
  if (!canDrop(tree, kindOf(hit.node), c, id)) return tree;
  if (c.kind !== 'root' && contains(tree, id, c.id)) return tree;
  let at = index;
  // Taking it out first shifts the later positions of its own list by one.
  if (sameContainer(hit.parent, c) && hit.index < index) at -= 1;
  const out = remove(tree, id);
  const next = insert(out.tree, c, at, out.node!);
  return kindOf(hit.node) === 'col' ? fixSpans(next, c) : next;
}

/** Columns of a row that no longer add up to 12 (after a column was added or removed) share the width evenly. */
export function fixSpans(tree: Block[], row: Container): Block[] {
  if (row.kind !== 'row') return tree;
  return update(tree, row.id, (r) => ({ ...r, cols: evenCols(r.cols ?? []) }));
}
export function evenCols(cols: Block[]): Block[] {
  const n = cols.length || 1;
  const sum = cols.reduce((s, c) => s + (Number(c.span) || 0), 0);
  if (sum === 12) return cols;
  const base = Math.floor(12 / n);
  return cols.map((c, i) => ({ ...c, span: i === n - 1 ? 12 - base * (n - 1) : base }));
}

/** New column count and widths for a row: columns that stay keep their content; the content of removed ones moves into the last column. */
export function resizeCols(row: Block, spans: number[]): Block {
  const old: Block[] = row.cols ?? [];
  const list = spans.slice(0, MAX_COLS);
  if (!list.length) list.push(12);
  const cols: Block[] = list.map((span, i) => (old[i] ? { ...old[i], span } : { id: uid(), span, blocks: [] as Block[] }));
  const extra = old.slice(list.length).flatMap((c) => c.blocks ?? []);
  if (extra.length) cols[cols.length - 1] = { ...cols[cols.length - 1], blocks: [...(cols[cols.length - 1].blocks ?? []), ...extra] };
  return { ...row, cols };
}

export const newCol = (span: number, blocks: Block[] = []): Block => ({ id: uid(), span, blocks });
export const newRow = (spans: number[]): Block => ({ id: uid(), gap: 24, stack: 'phone', cols: spans.map((s) => newCol(s)) });
export const newSection = (spans: number[] = [12]): Block => ({ id: uid(), type: 'section', name: '', width: 'normal', pad_y: 64, pad_x: 20, rows: [newRow(spans)] });
export const newBlock = (type: string, init: Block = {}): Block => ({ id: uid(), type, ...structuredClone(init) });

/** Deep copy with fresh ids everywhere. */
export function clone<T>(n: T): T {
  return JSON.parse(JSON.stringify(n), (k, v) => (k === 'id' && typeof v === 'string' ? uid() : v));
}

export function duplicate(tree: Block[], id: string): { tree: Block[]; id?: string } {
  const hit = find(tree, id);
  if (!hit) return { tree };
  const copy = clone(hit.node);
  return { tree: insert(tree, hit.parent, hit.index + 1, copy), id: copy.id };
}

/** Moves a node one place up or down inside its container. */
export function nudge(tree: Block[], id: string, dir: -1 | 1): Block[] {
  const hit = find(tree, id);
  if (!hit) return tree;
  const to = hit.index + dir;
  const len = childrenOf(tree, hit.parent).length;
  if (to < 0 || to >= len) return tree;
  return move(tree, id, hit.parent, dir > 0 ? to + 1 : to);
}

/** Where a click on "add block" puts it, given the current selection. */
export function insertionPoint(tree: Block[], selId: string | undefined, kind: Kind): { container: Container; index: number } {
  const root = { container: { kind: 'root' } as Container, index: tree.length };
  const sel = selId ? find(tree, selId) : undefined;
  if (kind === 'section') {
    if (!sel) return root;
    // after the section the selection lives in
    let id = sel.node.id;
    let top = sel;
    while (top.parent.kind !== 'root') {
      const up = find(tree, (top.parent as any).id);
      if (!up) break;
      top = up;
      id = up.node.id;
    }
    return { container: { kind: 'root' }, index: (find(tree, id)?.index ?? tree.length - 1) + 1 };
  }
  if (!sel) return root;
  const k = kindOf(sel.node);
  if (k === 'block') return { container: sel.parent, index: sel.index + 1 };
  if (k === 'col') return { container: { kind: 'col', id: sel.node.id }, index: (sel.node.blocks ?? []).length };
  if (k === 'row') {
    const first = (sel.node.cols ?? [])[0];
    return first ? { container: { kind: 'col', id: first.id }, index: (first.blocks ?? []).length } : root;
  }
  // a section: into its first column
  const col = (sel.node.rows ?? [])[0]?.cols?.[0];
  return col ? { container: { kind: 'col', id: col.id }, index: (col.blocks ?? []).length } : root;
}

/** Number of nodes the server counts against its limit (blocks, sections, rows and columns). */
export function countNodes(tree: Block[]): number {
  let n = 0;
  walk(tree, () => n++);
  return n;
}

/** `label` in German – a message id of the sites catalog, shown through t(). */
export const SECTION_PRESETS: { key: string; label: string; spans: number[] }[] = [
  { key: '1', label: '1 Spalte', spans: [12] },
  { key: '2', label: '2 Spalten', spans: [6, 6] },
  { key: '1-2', label: '⅓ + ⅔', spans: [4, 8] },
  { key: '2-1', label: '⅔ + ⅓', spans: [8, 4] },
  { key: '3', label: '3 Spalten', spans: [4, 4, 4] },
  { key: '4', label: '4 Spalten', spans: [3, 3, 3, 3] },
];

/** Short text for a node in the tree. */
export function labelOf(n: Block): string {
  const t = tr('sites');
  const k = kindOf(n);
  if (k === 'section') return n.name || t('Abschnitt');
  if (k === 'row') return t.plural((n.cols ?? []).length, { one: 'Zeile · {n} Spalte', other: 'Zeile · {n} Spalten' });
  if (k === 'col') return t('Spalte · {span}/12', { span: n.span ?? '' });
  return String(n.heading || n.text || n.title || n.quote || n.button_text || n.name || '').replace(/\s+/g, ' ').slice(0, 40);
}

/** Does the tree hold any section? (Pages from before the layout engine are flat lists of blocks.) */
export const hasSections = (tree: Block[]) => tree.some((n) => n.type === 'section');

/** Wraps loose top-level blocks into one section with one column (the "make this page a layout" step). */
export function toLayout(tree: Block[]): Block[] {
  const loose = tree.filter((n) => n.type !== 'section');
  if (!loose.length) return tree;
  const out: Block[] = [];
  for (const n of tree) {
    if (n.type === 'section') out.push(n);
    // no extra space or width limit: the page looks as it did
    else out.push({ ...newSection([12]), pad_y: 0, pad_x: 0, width: 'full', rows: [{ ...newRow([12]), gap: 0, cols: [newCol(12, [n])] }] });
  }
  return out;
}
