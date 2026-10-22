import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FF } from './site-fixtures.js';
import { cleanBlocks } from '../server/services/site-layout.js';
import { siteBlocks } from '../server/services/site-blocks.js';
import { BLOCKS, BLOCK_TYPES, GROUPS, coerce, imageKeys } from '../web/src/pages/site/blocks.js';
import { LADDER, MAX_W, plan, srcsetOf } from '../web/src/pages/site/image-prep.js';
import { contrast } from '../web/src/pages/site/contrast.js';
import {
  MAX_COLS,
  canDrop,
  childrenOf,
  clone,
  contains,
  countNodes,
  duplicate,
  find,
  fixSpans,
  hasSections,
  insert,
  insertionPoint,
  kindOf,
  move,
  newBlock,
  newCol,
  newRow,
  newSection,
  nudge,
  remove,
  resizeCols,
  toLayout,
  update,
  walk,
  type Block,
} from '../web/src/pages/site/model.js';

/** The editor's tree operations (drag & drop, insert, columns) and the agreement between its catalog and the server's blocks. */

const sample = (): Block[] => {
  const a = newSection([6, 6]);
  const b = newSection([12]);
  a.rows[0].cols[0].blocks = [newBlock('heading', { text: 'Eins' }), newBlock('text', { text: 'Zwei' })];
  a.rows[0].cols[1].blocks = [newBlock('image', { src: '/uploads/x.png' })];
  b.rows[0].cols[0].blocks = [newBlock('button', { text: 'Los' })];
  return [a, b];
};
const ids = (tree: Block[]) => {
  const out: string[] = [];
  walk(tree, (n) => out.push(n.id));
  return out;
};

describe('tree model', () => {
  it('tells sections, rows, columns and blocks apart', () => {
    const [a] = sample();
    expect(kindOf(a)).toBe('section');
    expect(kindOf(a.rows[0])).toBe('row');
    expect(kindOf(a.rows[0].cols[0])).toBe('col');
    expect(kindOf(a.rows[0].cols[0].blocks[0])).toBe('block');
    expect(a.rows[0].cols.map((c: Block) => c.span)).toEqual([6, 6]);
  });

  it('finds, updates and removes nodes at any depth without touching the rest', () => {
    const t = sample();
    const h = t[0].rows[0].cols[0].blocks[1];
    expect(find(t, h.id)!.parent).toEqual({ kind: 'col', id: t[0].rows[0].cols[0].id });
    const u = update(t, h.id, { text: 'Neu' });
    expect(find(u, h.id)!.node.text).toBe('Neu');
    expect(t[0].rows[0].cols[0].blocks[1].text).toBe('Zwei'); // immutable
    const r = remove(t, h.id);
    expect(r.node!.id).toBe(h.id);
    expect(countNodes(r.tree)).toBe(countNodes(t) - 1);
    expect(remove(t, 'gibtsnicht').tree).toBe(t);
  });

  it('moves a block between columns and within one (positions account for the removal)', () => {
    const t = sample();
    const [h, x] = t[0].rows[0].cols[0].blocks;
    const col2 = t[0].rows[0].cols[1];
    const m = move(t, h.id, { kind: 'col', id: col2.id }, 1);
    expect(childrenOf(m, { kind: 'col', id: col2.id }).map((n) => n.id)).toEqual([col2.blocks[0].id, h.id]);
    // within a column: dropping "after the second" puts the first one last
    const w = move(t, h.id, { kind: 'col', id: t[0].rows[0].cols[0].id }, 2);
    expect(childrenOf(w, { kind: 'col', id: t[0].rows[0].cols[0].id }).map((n) => n.id)).toEqual([x.id, h.id]);
    // onto the page itself
    const root = move(t, h.id, { kind: 'root' }, 0);
    expect(root[0].id).toBe(h.id);
    expect(ids(root).sort()).toEqual(ids(t).sort());
  });

  it('keeps layout rules: sections only on the page, rows in sections, at most four columns, nothing into itself', () => {
    const t = sample();
    const s = t[0];
    const row = s.rows[0];
    expect(canDrop(t, 'section', { kind: 'root' })).toBe(true);
    expect(canDrop(t, 'section', { kind: 'col', id: row.cols[0].id })).toBe(false);
    expect(canDrop(t, 'row', { kind: 'section', id: t[1].id })).toBe(true);
    expect(canDrop(t, 'row', { kind: 'root' })).toBe(false);
    expect(canDrop(t, 'block', { kind: 'section', id: s.id })).toBe(false);
    expect(canDrop(t, 'block', { kind: 'row', id: row.id })).toBe(false);
    // a row moves to another section
    const m = move(t, row.id, { kind: 'section', id: t[1].id }, 0);
    expect(find(m, row.id)!.parent).toEqual({ kind: 'section', id: t[1].id });
    // a section cannot enter its own column; a block cannot become a section's child
    expect(move(t, s.id, { kind: 'col', id: row.cols[0].id }, 0)).toBe(t);
    expect(move(t, row.cols[0].blocks[0].id, { kind: 'row', id: row.id }, 0)).toBe(t);
    expect(contains(t, s.id, row.cols[0].blocks[0].id)).toBe(true);
    expect(contains(t, row.cols[0].blocks[0].id, s.id)).toBe(false);
    // five columns do not fit
    const four = update(t, row.id, (r) => ({ ...r, cols: [...r.cols, newCol(3), newCol(3)] }));
    expect(find(four, row.id)!.node.cols).toHaveLength(MAX_COLS);
    expect(canDrop(four, 'col', { kind: 'row', id: row.id })).toBe(false);
    expect(canDrop(four, 'col', { kind: 'row', id: row.id }, row.cols[0].id)).toBe(true);
  });

  it('nudges up and down and duplicates with fresh ids', () => {
    const t = sample();
    const col = t[0].rows[0].cols[0];
    const n = nudge(t, col.blocks[0].id, 1);
    expect(childrenOf(n, { kind: 'col', id: col.id }).map((b) => b.id)).toEqual([col.blocks[1].id, col.blocks[0].id]);
    expect(nudge(t, col.blocks[0].id, -1)).toBe(t);
    const d = duplicate(t, t[0].id);
    expect(d.tree).toHaveLength(3);
    expect(d.tree[1].id).toBe(d.id);
    expect(new Set(ids(d.tree)).size).toBe(ids(d.tree).length);
    expect(JSON.stringify(d.tree[1], (k, v) => (k === 'id' ? undefined : v))).toBe(JSON.stringify(t[0], (k, v) => (k === 'id' ? undefined : v)));
    expect(JSON.stringify(clone(t[0])).includes(t[0].id)).toBe(false);
  });

  it('puts "add" where the selection suggests', () => {
    const t = sample();
    const col = t[0].rows[0].cols[0];
    expect(insertionPoint(t, undefined, 'block')).toEqual({ container: { kind: 'root' }, index: 2 });
    expect(insertionPoint(t, col.blocks[0].id, 'block')).toEqual({ container: { kind: 'col', id: col.id }, index: 1 });
    expect(insertionPoint(t, col.id, 'block')).toEqual({ container: { kind: 'col', id: col.id }, index: 2 });
    expect(insertionPoint(t, t[1].id, 'block')).toEqual({ container: { kind: 'col', id: t[1].rows[0].cols[0].id }, index: 1 });
    // a new section goes after the section the selection lives in
    expect(insertionPoint(t, col.blocks[1].id, 'section')).toEqual({ container: { kind: 'root' }, index: 1 });
    expect(insertionPoint(t, undefined, 'section').index).toBe(2);
  });

  it('changes the column count without losing content, and shares the width evenly', () => {
    const t = sample();
    const row = t[0].rows[0];
    const one = resizeCols(row, [12]);
    expect(one.cols).toHaveLength(1);
    expect(one.cols[0].blocks.map((b: Block) => b.type)).toEqual(['heading', 'text', 'image']); // the removed column's blocks moved over
    const three = resizeCols(row, [4, 4, 4]);
    expect(three.cols.map((c: Block) => c.span)).toEqual([4, 4, 4]);
    expect(three.cols[0].id).toBe(row.cols[0].id);
    expect(three.cols[2].blocks).toEqual([]);
    expect(resizeCols(row, [1, 1, 1, 1, 1, 1]).cols).toHaveLength(MAX_COLS);
    const odd = update(t, row.id, (r) => ({ ...r, cols: [...r.cols, newCol(4)] }));
    expect(find(fixSpans(odd, { kind: 'row', id: row.id }), row.id)!.node.cols.map((c: Block) => c.span)).toEqual([4, 4, 4]);
  });

  it('turns a flat page into sections without changing how it looks', () => {
    const flat = [newBlock('hero', BLOCKS.hero.init), newBlock('text', { text: 'a' })];
    expect(hasSections(flat)).toBe(false);
    const l = toLayout(flat);
    expect(hasSections(l)).toBe(true);
    expect(l).toHaveLength(2);
    expect(l.every((s) => s.pad_y === 0 && s.pad_x === 0 && s.width === 'full')).toBe(true);
    expect(l[0].rows[0].cols[0].blocks[0].type).toBe('hero');
    expect(toLayout(l)).toEqual(l);
  });

  it('builds trees the server keeps as they are', () => {
    const t = sample();
    const cleaned = cleanBlocks(JSON.parse(JSON.stringify(t)));
    expect(ids(cleaned as Block[])).toEqual(ids(t));
    expect(countNodes(cleaned as Block[])).toBe(countNodes(t));
    // moves done by the editor survive cleaning
    const m = move(t, t[0].rows[0].cols[0].blocks[0].id, { kind: 'col', id: t[1].rows[0].cols[0].id }, 0);
    expect(ids(cleanBlocks(JSON.parse(JSON.stringify(m))) as Block[])).toEqual(ids(m));
    // and a row built by the editor
    const row = newRow([3, 3, 3, 3]);
    expect((cleanBlocks([{ ...newSection(), rows: [row] }])[0] as Block).rows[0].cols.map((c: Block) => c.span)).toEqual([3, 3, 3, 3]);
  });
});

describe('block catalog', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
  });
  afterAll(() => t.close());

  it('has a renderer on the server for every block the editor offers', () => {
    const registry = siteBlocks(t.app);
    for (const type of BLOCK_TYPES) expect(registry.has(type), `Block „${type}“ fehlt auf dem Server`).toBe(true);
    for (const type of BLOCK_TYPES) expect(GROUPS, type).toContain(BLOCKS[type].group);
  });

  it('saves and previews every block with the values a new one starts with', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Katalog', kind: 'website', template: 'blank' })).data;
    const blocks = BLOCK_TYPES.filter((x) => x !== 'component').map((type) => newBlock(type, BLOCKS[type].init));
    const saved = await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [newSection([12])].map((s) => ({ ...s, rows: [{ ...s.rows[0], cols: [{ ...s.rows[0].cols[0], blocks }] }] })) });
    expect(saved.status).toBe(200);
    expect(countNodes(saved.data.blocks)).toBe(3 + blocks.length);
    const html = await (await t.api.raw(`/p/${f.slug}`, { headers: FF })).text();
    expect(html).toContain('Große Überschrift');
    expect(html).toContain('Deine Vorteile');
    const prev = await t.api.post(`/api/funnel-pages/${f.pages[0].id}/preview`, { blocks: saved.data.blocks });
    expect(prev.status).toBe(200);
  });

  it('knows which fields hold numbers and where a picture keeps its size', () => {
    expect(coerce('level', '2')).toBe(2);
    expect(coerce('heading_level', '3')).toBe(3);
    expect(coerce('layout', 'grid')).toBe('grid');
    expect(coerce('columns', '')).toBe('');
    expect(imageKeys('image')).toEqual({ w: 'image_w', h: 'image_h', srcset: 'image_srcset' });
    expect(imageKeys('src')).toEqual({ w: 'w', h: 'h', srcset: 'srcset' });
    // the keys the editor writes are the ones the server reads
    for (const [type, spec] of Object.entries(BLOCKS)) for (const f of spec.fields.filter((x) => x[1] === 'image')) expect(['hero', 'image'], type).toContain(type);
  });
});

describe('picture preparation and contrast', () => {
  it('plans the widths: a ladder below the original, the original capped', () => {
    expect(plan(4000, 3000)).toEqual({ w: MAX_W, h: 1920, widths: LADDER });
    expect(plan(1600, 900)).toEqual({ w: 1600, h: 900, widths: [640, 1280] });
    expect(plan(700, 700).widths).toEqual([640].filter((x) => x < 660));
    expect(plan(300, 200)).toEqual({ w: 300, h: 200, widths: [] });
  });

  it('writes srcset smallest first and nothing for a single size', () => {
    expect(srcsetOf([{ url: '/u/b.webp', w: 1280 }, { url: '/u/a.webp', w: 640 }])).toBe('/u/a.webp 640w, /u/b.webp 1280w');
    expect(srcsetOf([{ url: '/u/a.webp', w: 640 }])).toBe('');
  });

  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.5);
    expect(contrast('#595959', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('nonsense', '#fff')).toBe(21);
    expect(insert([], { kind: 'root' }, 5, newBlock('text'))).toHaveLength(1);
  });
});
