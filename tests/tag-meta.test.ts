import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySnapshot, exportSnapshot, validateSnapshot } from '../server/services/snapshots.js';
import { cleanColor } from '../server/services/tag-meta.js';
import { startTestApp } from './helpers.js';

/** Tag colours and categories (modules/tag-meta.ts): API, chips data, undo, snapshots, isolation. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t?.close());

const tagId = async (name: string) => (await t.api.post('/api/tags', { name })).data.id as string;

describe('tag colours and categories', () => {
  it('cleans colours', () => {
    expect(cleanColor('#AABBCC')).toBe('#aabbcc');
    expect(cleanColor('')).toBe('');
    expect(cleanColor(null)).toBe('');
    expect(() => cleanColor('red')).toThrow(/#rrggbb/);
    expect(() => cleanColor('#abc')).toThrow();
  });

  it('creates categories, colours a tag and files it in a category; /api/tags/meta carries both', async () => {
    const vip = await tagId('vip');
    await tagId('newsletter');
    const cat = await t.api.post('/api/tag-categories', { name: 'Status', color: '#22c55e' });
    expect(cat.status).toBe(200);
    expect((await t.api.post('/api/tag-categories', { name: 'Status' })).status).toBe(400);
    expect((await t.api.post('/api/tag-categories', { name: 'Bad', color: 'grün' })).status).toBe(400);
    const p = await t.api.patch(`/api/tags/${vip}`, { color: '#EF4444', category_id: cat.data.id });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data).toMatchObject({ name: 'vip', color: '#ef4444', category_id: cat.data.id });
    expect((await t.api.patch(`/api/tags/${vip}`, { color: 'nope' })).status).toBe(400);
    expect((await t.api.patch(`/api/tags/${vip}`, { category_id: 'unknown' })).status).toBe(400);
    const meta = (await t.api.get('/api/tags/meta')).data;
    expect(meta.categories).toEqual([expect.objectContaining({ name: 'Status', color: '#22c55e', position: 0 })]);
    expect(meta.tags.find((x: any) => x.name === 'vip')).toMatchObject({ color: '#ef4444', category_id: cat.data.id });
    expect(meta.tags.find((x: any) => x.name === 'newsletter')).toMatchObject({ color: '', category_id: null });
    const list = (await t.api.get('/api/tag-categories')).data;
    expect(list[0]).toMatchObject({ name: 'Status', tag_count: 1 });
  });

  it('renames and orders categories', async () => {
    const b = (await t.api.post('/api/tag-categories', { name: 'Interessen' })).data;
    expect(b.position).toBe(1);
    expect((await t.api.patch(`/api/tag-categories/${b.id}`, { name: 'Hobbys', position: 0 })).data).toMatchObject({ name: 'Hobbys', position: 0 });
    expect((await t.api.patch(`/api/tag-categories/${b.id}`, { name: 'Status' })).status).toBe(400);
    expect((await t.api.patch('/api/tag-categories/nope', { name: 'x' })).status).toBe(404);
  });

  it('deleting a category keeps its tags (uncategorised), and the undo files them back', async () => {
    const cat = (await t.api.get('/api/tag-categories')).data.find((c: any) => c.name === 'Status');
    const del = await t.api.del(`/api/tag-categories/${cat.id}`);
    expect(del.status).toBe(200);
    const undoId = del.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    expect(t.app.db.get(`SELECT category_id, color FROM tags WHERE location_id = ? AND name = 'vip'`, loc)).toEqual({ category_id: null, color: '#ef4444' });
    const r = await t.api.post(`/api/undo/${undoId}`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(t.app.db.get(`SELECT name FROM tag_categories WHERE id = ?`, cat.id)).toEqual({ name: 'Status' });
    expect(t.app.db.get(`SELECT category_id FROM tags WHERE location_id = ? AND name = 'vip'`, loc)).toEqual({ category_id: cat.id });
  });

  it("a tag's colour change can be taken back", async () => {
    const vip = t.app.db.get<{ id: string }>(`SELECT id FROM tags WHERE location_id = ? AND name = 'vip'`, loc)!.id;
    const p = await t.api.patch(`/api/tags/${vip}`, { color: '#3b82f6' });
    const undoId = p.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    expect((await t.api.post(`/api/undo/${undoId}`, {})).status).toBe(200);
    expect(t.app.db.get(`SELECT color FROM tags WHERE id = ?`, vip)).toEqual({ color: '#ef4444' });
  });

  it('travels with a snapshot into another sub-account', async () => {
    const data = validateSnapshot(JSON.parse(JSON.stringify(exportSnapshot(t.app, loc))));
    expect(data.tag_meta).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'category', name: 'Status', color: '#22c55e' }), expect.objectContaining({ type: 'tag', name: 'vip', color: '#ef4444', category: 'Status' })]));
    const other = (await t.api.post('/api/locations', { name: 'Kopie' })).data.id as string;
    const res = applySnapshot(t.app, other, data);
    expect(res).toBeTruthy();
    const cat = t.app.db.get<{ id: string; color: string }>(`SELECT id, color FROM tag_categories WHERE location_id = ? AND name = 'Status'`, other)!;
    expect(cat.color).toBe('#22c55e');
    expect(t.app.db.get(`SELECT color, category_id FROM tags WHERE location_id = ? AND name = 'vip'`, other)).toEqual({ color: '#ef4444', category_id: cat.id });
  });

  it("never uses or changes another sub-account's tags and categories", async () => {
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id as string;
    t.api.setLocation(other);
    const foreignCat = (await t.api.post('/api/tag-categories', { name: 'Fremd' })).data.id as string;
    const foreignTag = (await t.api.post('/api/tags', { name: 'fremd' })).data.id as string;
    t.api.setLocation(loc);
    const vip = t.app.db.get<{ id: string }>(`SELECT id FROM tags WHERE location_id = ? AND name = 'vip'`, loc)!.id;
    expect((await t.api.patch(`/api/tags/${vip}`, { category_id: foreignCat })).status).toBe(400);
    expect((await t.api.patch(`/api/tags/${foreignTag}`, { color: '#000000' })).status).toBe(404);
    expect((await t.api.patch(`/api/tag-categories/${foreignCat}`, { name: 'x' })).status).toBe(404);
    expect((await t.api.del(`/api/tag-categories/${foreignCat}`)).status).toBe(404);
    expect((await t.api.get('/api/tags/meta')).data.categories.map((c: any) => c.name)).not.toContain('Fremd');
  });
});
