import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** Tags in bulk (modules/tag-bulk.ts): usage, rename, merge, delete, colour/category, undo, MCP tools, isolation. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t?.close());

const tagId = (name: string) => t.app.db.get<{ id: string }>('SELECT id FROM tags WHERE location_id = ? AND name = ?', loc, name)?.id as string;
const tagsOf = (contactId: string) => JSON.parse(t.app.db.get<{ tags: string }>('SELECT tags FROM contacts WHERE id = ?', contactId)!.tags) as string[];
const contact = async (email: string, tags: string[]) => (await t.api.post('/api/contacts', { email, first_name: email.split('@')[0], tags })).data.id as string;

describe('tags in bulk', () => {
  let a = '';
  let b = '';
  let c = '';
  it('lists usage: contacts, workflows and smart lists that name a tag', async () => {
    a = await contact('anna@example.com', ['vip', 'kunde']);
    b = await contact('ben@example.com', ['interessent', 'messe-2026']);
    c = await contact('cem@example.com', ['Interessent', 'kunde']);
    await t.api.post('/api/tags', { name: 'alt-unbenutzt' });
    await t.api.post('/api/workflows', { name: 'VIP-Willkommen', trigger: { type: 'contact.tag_added', config: { tag: 'vip' } }, steps: [] });
    await t.api.post('/api/smart-lists', { name: 'Messe', filter: { tags: ['messe-2026'] } });
    const r = await t.api.get('/api/tags/usage');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.data.tags.map((x: any) => [x.name, x]));
    expect(by.vip).toMatchObject({ contacts: 1, unused: false });
    expect(by.vip.workflows).toEqual([expect.objectContaining({ name: 'VIP-Willkommen' })]);
    expect(by['messe-2026'].smart_lists).toEqual([expect.objectContaining({ name: 'Messe' })]);
    expect(by.kunde.contacts).toBe(2);
    expect(by['alt-unbenutzt']).toMatchObject({ contacts: 0, unused: true, workflows: [], smart_lists: [] });
  });

  it('renames a tag on every contact without firing tag workflows, refuses an existing name, and the undo takes it back', async () => {
    const id = tagId('messe-2026');
    expect((await t.api.post('/api/tags/bulk', { action: 'rename', ids: [id], name: 'kunde' })).status).toBe(400);
    const r = await t.api.post('/api/tags/bulk', { action: 'rename', ids: [id], name: 'Messe 2026' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ count: 1, contacts: 1 });
    expect(r.data.references.smart_lists).toEqual([expect.objectContaining({ name: 'Messe' })]);
    expect(tagsOf(b)).toEqual(['interessent', 'Messe 2026']);
    expect(t.app.db.get('SELECT name FROM tags WHERE id = ?', id)).toEqual({ name: 'Messe 2026' });
    // No "tag added" activity: nothing happened to the person.
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND summary LIKE '%Messe 2026%'`, b)).toEqual({ n: 0 });
    const undoId = r.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    expect((await t.api.post(`/api/undo/${undoId}`, {})).status).toBe(200);
    expect(tagsOf(b)).toEqual(['interessent', 'messe-2026']);
    expect(t.app.db.get('SELECT name FROM tags WHERE id = ?', id)).toEqual({ name: 'messe-2026' });
  });

  it('merges several tags into one (no duplicates on a contact) and the undo restores both sides', async () => {
    const into = tagId('interessent');
    const src = tagId('Interessent');
    await t.api.post(`/api/contacts/${c}/tags`, { add: ['interessent'] });
    const before = tagsOf(c);
    const r = await t.api.post('/api/tags/bulk', { action: 'merge', ids: [src, into], into });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ count: 1, into });
    expect(tagsOf(c).filter((x) => x === 'interessent')).toHaveLength(1);
    expect(tagsOf(c)).not.toContain('Interessent');
    expect(tagId('Interessent')).toBeUndefined();
    expect((await t.api.post('/api/tags/bulk', { action: 'merge', ids: [into], into })).status).toBe(400);
    expect((await t.api.post(`/api/undo/${r.headers.get('x-undo-id')}`, {})).status).toBe(200);
    expect(tagsOf(c)).toEqual(before);
    expect(tagId('Interessent')).toBe(src);
  });

  it('colours and files several tags at once, and deletes several (gone from every contact)', async () => {
    const ids = [tagId('vip'), tagId('kunde')];
    const col = await t.api.post('/api/tags/bulk', { action: 'color', ids, color: '#22C55E' });
    expect(col.data.tags.map((x: any) => x.color)).toEqual(['#22c55e', '#22c55e']);
    expect((await t.api.post('/api/tags/bulk', { action: 'color', ids, color: 'grün' })).status).toBe(400);
    const cat = (await t.api.post('/api/tag-categories', { name: 'Status' })).data;
    const filed = await t.api.post('/api/tags/bulk', { action: 'category', ids, category_id: cat.id });
    expect(filed.data.tags.every((x: any) => x.category_id === cat.id)).toBe(true);
    expect((await t.api.post('/api/tags/bulk', { action: 'category', ids, category_id: 'nope' })).status).toBe(400);

    const del = await t.api.post('/api/tags/bulk', { action: 'delete', ids: [tagId('kunde'), tagId('alt-unbenutzt')] });
    expect(del.data).toMatchObject({ count: 2, contacts: 2 });
    expect(tagsOf(a)).toEqual(['vip']);
    expect(tagsOf(c)).not.toContain('kunde');
    expect((await t.api.post(`/api/undo/${del.headers.get('x-undo-id')}`, {})).status).toBe(200);
    expect(tagsOf(a)).toEqual(['vip', 'kunde']);
    expect(tagId('alt-unbenutzt')).toBeTruthy();
  });

  it('validates the request and keeps sub-accounts apart', async () => {
    expect((await t.api.post('/api/tags/bulk', { action: 'explode', ids: [tagId('vip')] })).status).toBe(400);
    expect((await t.api.post('/api/tags/bulk', { action: 'delete', ids: [] })).status).toBe(400);
    expect((await t.api.post('/api/tags/bulk', { action: 'rename', ids: [tagId('vip'), tagId('kunde')], name: 'x' })).status).toBe(400);
    const other = (await t.api.post('/api/locations', { name: 'Zweiter Kunde' })).data.id;
    const foreign = await t.api.post('/api/tags', { name: 'fremd' }, { 'x-location-id': other });
    expect(foreign.status).toBe(200);
    expect((await t.api.post('/api/tags/bulk', { action: 'delete', ids: [foreign.data.id] })).status).toBe(400);
  });

  it('offers MCP tools for agents (usage read-only, bulk edits as write / sensitive)', async () => {
    const tools = t.app.services.mcpTools as any[];
    const usage = tools.find((x) => x.name === 'ghl_tags_usage');
    const bulk = tools.find((x) => x.name === 'ghl_tags_bulk');
    expect(usage.annotations.readOnlyHint).toBe(true);
    expect(bulk.klassFor({ action: 'delete' })).toBe('sensitive');
    expect(bulk.klassFor({ action: 'color' })).toBe('write');
    const calls: any[] = [];
    const call = { agency: false, locationId: loc, api: async (method: string, path: string, opts?: any) => (calls.push([method, path, opts?.body]), { tags: [{ name: 'x', unused: true }, { name: 'y', unused: false }] }) };
    expect(await usage.run(call, { unused_only: true })).toEqual({ tags: [{ name: 'x', unused: true }] });
    await bulk.run(call, { action: 'color', ids: ['t1'], color: '#000000' });
    expect(calls[1]).toEqual(['POST', '/api/tags/bulk', expect.objectContaining({ action: 'color', ids: ['t1'], color: '#000000' })]);
  });
});
