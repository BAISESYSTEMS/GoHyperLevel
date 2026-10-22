import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** Bulk owner for contacts (modules/contact-bulk-owner.ts) and custom field clean-up (modules/field-cleanup.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let me = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  me = t.app.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
});
afterAll(() => t?.close());

const ownerOf = (id: string) => t.app.db.get<{ assigned_to: string | null }>('SELECT assigned_to FROM contacts WHERE id = ?', id)!.assigned_to;

describe('bulk owner for contacts', () => {
  const ids: string[] = [];
  it('hands many contacts to one person in one undoable step and fires "owner changed" per contact', async () => {
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) ids.push((await t.api.post('/api/contacts', { email: e })).data.id);
    t.app.db.run('UPDATE contacts SET assigned_to = ? WHERE id = ?', me, ids[2]);
    const r = await t.api.post('/api/contacts/bulk-owner', { ids, assigned_to: me });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toEqual({ count: 2, skipped: 0 });
    expect(ids.map(ownerOf)).toEqual([me, me, me]);
    const undoId = r.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    const u = await t.api.post(`/api/undo/${undoId}`, {});
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    expect(ids.map(ownerOf)).toEqual([null, null, me]);

    const wf = (await t.api.post('/api/workflows', { name: 'Neuer Zuständiger', trigger: { type: 'contact.owner_changed' }, steps: [{ id: 's1', type: 'add_tag', tags: ['übergeben'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect((await t.api.post('/api/contacts/bulk-owner', { ids, assigned_to: me })).data.count).toBe(2);
    await new Promise((res) => setTimeout(res, 60));
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?', wf.id)!.n).toBe(2);
    expect(JSON.parse(t.app.db.get<{ tags: string }>('SELECT tags FROM contacts WHERE id = ?', ids[0])!.tags)).toEqual(['übergeben']);
  });

  it('removes the owner, refuses unknown people and empty lists, ignores contacts of other sub-accounts', async () => {
    const r = await t.api.post('/api/contacts/bulk-owner', { ids, assigned_to: null });
    expect(r.data.count).toBe(3);
    expect(ids.map(ownerOf)).toEqual([null, null, null]);
    expect((await t.api.post('/api/contacts/bulk-owner', { ids, assigned_to: 'nobody' })).status).toBe(400);
    expect((await t.api.post('/api/contacts/bulk-owner', { ids: [] })).status).toBe(400);
    const other = (await t.api.post('/api/locations', { name: 'Zweiter Kunde' })).data.id;
    const foreign = (await t.api.post('/api/contacts', { email: 'x@example.com' }, { 'x-location-id': other })).data.id;
    const r2 = await t.api.post('/api/contacts/bulk-owner', { ids: [foreign, ids[0]], assigned_to: me });
    expect(r2.data).toEqual({ count: 1, skipped: 1 });
    expect(ownerOf(foreign)).toBeNull();
  });

  it('is an MCP tool for agents', async () => {
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_contacts_assign_owner');
    expect(tool.annotations.readOnlyHint).toBe(false);
    let seen: any;
    await tool.run({ agency: false, api: async (m: string, p: string, o: any) => ((seen = [m, p, o.body]), {}) }, { contact_ids: ['c1'], user_id: '' });
    expect(seen).toEqual(['POST', '/api/contacts/bulk-owner', { ids: ['c1'], assigned_to: null }]);
  });
});

describe('custom field clean-up', () => {
  const f: Record<string, string> = {};
  it('counts values, forms and workflows per field and marks unused ones', async () => {
    for (const [key, label] of [['budget', 'Budget'], ['branche', 'Branche'], ['alt', 'Altes Feld'], ['leer', 'Leeres Feld'], ['budget2', 'Budget 2']]) f[key] = (await t.api.post('/api/custom-fields', { key, label })).data.id;
    await t.api.post('/api/contacts', { email: 'v@example.com', custom: { budget: '5000', leer: '' } });
    await t.api.post('/api/contacts', { email: 'w@example.com', custom: { budget: '200' } });
    await t.api.post('/api/forms', { name: 'Anfrage', fields: [{ id: 'f1', type: 'text', label: 'Branche', name: 'custom.branche' }] });
    await t.api.post('/api/workflows', { name: 'Budget-Check', trigger: { type: 'contact.created' }, steps: [{ id: 's1', type: 'send_email', subject: 'Budget {{contact.custom.budget}}', body: 'x' }] });
    const r = await t.api.get('/api/custom-fields/usage');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.data.fields.map((x: any) => [x.key, x]));
    expect(by.budget).toMatchObject({ contacts: 2, unused: false });
    expect(by.budget.workflows).toEqual([expect.objectContaining({ name: 'Budget-Check' })]);
    expect(by.branche).toMatchObject({ contacts: 0, unused: false, forms: [expect.objectContaining({ name: 'Anfrage' })] });
    expect(by.alt).toMatchObject({ contacts: 0, forms: [], workflows: [], unused: true });
    expect(by.leer).toMatchObject({ contacts: 0, unused: true });
    // "custom.budget" in the workflow must not count for "budget2".
    expect(by.budget2).toMatchObject({ unused: true, workflows: [] });
  });

  it('deletes several at once, keeps used ones unless forced, and the undo brings them back', async () => {
    const r = await t.api.post('/api/custom-fields/bulk-delete', { ids: [f.alt, f.leer, f.budget] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.count).toBe(2);
    expect(r.data.skipped).toEqual([expect.objectContaining({ id: f.budget, contacts: 2, workflows: 1 })]);
    expect(t.app.db.all('SELECT key FROM custom_fields WHERE location_id = ? ORDER BY key', loc).map((x: any) => x.key)).toEqual(['branche', 'budget', 'budget2']);
    expect((await t.api.post(`/api/undo/${r.headers.get('x-undo-id')}`, {})).status).toBe(200);
    expect(t.app.db.all('SELECT key FROM custom_fields WHERE location_id = ? ORDER BY key', loc).map((x: any) => x.key)).toEqual(['alt', 'branche', 'budget', 'budget2', 'leer']);
    const forced = await t.api.post('/api/custom-fields/bulk-delete', { ids: [f.budget], force: true });
    expect(forced.data.count).toBe(1);
    // The values stay on the contacts.
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts WHERE location_id = ? AND json_extract(custom, '$.budget') IS NOT NULL`, loc)!.n).toBe(2);
    expect((await t.api.post('/api/custom-fields/bulk-delete', { ids: ['nope'] })).status).toBe(400);
    expect((await t.api.post('/api/custom-fields/bulk-delete', { ids: [] })).status).toBe(400);
  });

  it('offers MCP tools (usage read-only, delete write; forced delete sensitive)', async () => {
    const tools = t.app.services.mcpTools as any[];
    expect(tools.find((x) => x.name === 'ghl_custom_fields_usage').annotations.readOnlyHint).toBe(true);
    const del = tools.find((x) => x.name === 'ghl_custom_fields_delete');
    expect(del.klassFor({ force: true })).toBe('sensitive');
    expect(del.klassFor({})).toBe('write');
  });
});
