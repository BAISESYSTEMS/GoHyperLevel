import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySnapshot, exportSnapshot, validateSnapshot } from '../server/services/snapshots.js';
import { requiredPermission } from '../server/core/permissions.js';
import { startTestApp } from './helpers.js';

/** Workflow folders and bulk actions (modules/workflow-folders.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t?.close());

const wf = async (name: string, steps: unknown[] = [{ id: 's1', type: 'add_tag', tags: ['x'] }]) => (await t.api.post('/api/workflows', { name, trigger: { type: 'contact.created' }, steps })).data.id as string;
const row = (id: string) => t.app.db.get<{ status: string; folder_id: string | null }>('SELECT status, folder_id FROM workflows WHERE id = ?', id);

describe('workflow folders and bulk actions', () => {
  const f: Record<string, string> = {};
  const w: Record<string, string> = {};
  it('creates nested folders, refuses cycles, and maps the routes to the workflows area', async () => {
    expect(requiredPermission('GET', '/api/workflow-folders')).toBeUndefined();
    expect(requiredPermission('POST', '/api/workflow-folders')).toBe('workflows');
    expect(requiredPermission('POST', '/api/workflows/bulk')).toBe('workflows');
    f.sales = (await t.api.post('/api/workflow-folders', { name: 'Vertrieb' })).data.id;
    f.leads = (await t.api.post('/api/workflow-folders', { name: 'Leads', parent_id: f.sales })).data.id;
    expect((await t.api.patch(`/api/workflow-folders/${f.sales}`, { parent_id: f.leads })).status).toBe(400);
    expect((await t.api.post('/api/workflow-folders', { name: '' })).status).toBe(400);
    expect((await t.api.post('/api/workflow-folders', { name: 'X', parent_id: 'nope' })).status).toBe(400);
    expect((await t.api.patch(`/api/workflow-folders/${f.leads}`, { name: 'Neue Leads' })).data.name).toBe('Neue Leads');
  });

  it('moves several workflows into a folder and lists the count; GET /api/workflows carries folder_id', async () => {
    w.a = await wf('Begrüßung');
    w.b = await wf('Nachfassen');
    w.c = await wf('Kaputt', [{ id: 's1', type: 'send_email', subject: '', body: '' }]);
    const r = await t.api.post('/api/workflows/bulk', { action: 'move', ids: [w.a, w.b], folder_id: f.leads });
    expect(r.data).toEqual({ count: 2, failed: [] });
    expect((await t.api.get('/api/workflow-folders')).data.find((x: any) => x.id === f.leads).workflows).toBe(2);
    const list = (await t.api.get('/api/workflows')).data;
    expect(list.find((x: any) => x.id === w.a).folder_id).toBe(f.leads);
    expect((await t.api.post('/api/workflows/bulk', { action: 'move', ids: [w.a], folder_id: 'nope' })).status).toBe(400);
    expect((await t.api.post('/api/workflows/bulk', { action: 'move', ids: [w.a], folder_id: null })).data.count).toBe(1);
    expect(row(w.a)!.folder_id).toBeNull();
  });

  it('activates and pauses through the normal route: the check stops a broken workflow, the others go on', async () => {
    const r = await t.api.post('/api/workflows/bulk', { action: 'activate', ids: [w.a, w.b, w.c] });
    expect(r.status).toBe(200);
    expect(row(w.a)!.status).toBe('active');
    expect(row(w.b)!.status).toBe('active');
    const broken = row(w.c)!.status;
    if (broken !== 'active') expect(r.data.failed).toEqual([expect.objectContaining({ id: w.c, name: 'Kaputt' })]);
    expect(r.data.count).toBe(broken === 'active' ? 3 : 2);
    const p = await t.api.post('/api/workflows/bulk', { action: 'pause', ids: [w.a, w.b] });
    expect(p.data.count).toBe(2);
    expect([row(w.a)!.status, row(w.b)!.status]).toEqual(['paused', 'paused']);
  });

  it('deleting a folder keeps its workflows and sub-folders (they move up)', async () => {
    await t.api.post('/api/workflows/bulk', { action: 'move', ids: [w.b], folder_id: f.leads });
    const sub = (await t.api.post('/api/workflow-folders', { name: 'Archiv', parent_id: f.leads })).data.id;
    expect((await t.api.del(`/api/workflow-folders/${f.leads}`)).status).toBe(200);
    expect(row(w.b)!.folder_id).toBe(f.sales);
    expect(t.app.db.get('SELECT parent_id FROM workflow_folders WHERE id = ?', sub)).toEqual({ parent_id: f.sales });
  });

  it('travels with a snapshot (folders by path, workflows by name)', async () => {
    const data = validateSnapshot(JSON.parse(JSON.stringify(exportSnapshot(t.app, loc))));
    expect((data as any).workflow_folders).toEqual(expect.arrayContaining([{ type: 'folder', path: ['Vertrieb'] }, { type: 'workflow', name: 'Nachfassen', path: ['Vertrieb'] }]));
    const other = (await t.api.post('/api/locations', { name: 'Kopie' })).data.id;
    applySnapshot(t.app, other, data);
    const folder = t.app.db.get<{ id: string }>(`SELECT id FROM workflow_folders WHERE location_id = ? AND name = 'Vertrieb'`, other);
    expect(folder).toBeTruthy();
    expect(t.app.db.get(`SELECT folder_id FROM workflows WHERE location_id = ? AND name = 'Nachfassen'`, other)).toEqual({ folder_id: folder!.id });
  });

  it('deletes several (undoable one by one) and refuses foreign or unknown ids', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id;
    const foreign = (await t.api.post('/api/workflows', { name: 'Fremd', trigger: { type: 'contact.created' }, steps: [] }, { 'x-location-id': other })).data.id;
    expect((await t.api.post('/api/workflows/bulk', { action: 'delete', ids: [foreign] })).status).toBe(400);
    expect((await t.api.post('/api/workflows/bulk', { action: 'explode', ids: [w.a] })).status).toBe(400);
    const r = await t.api.post('/api/workflows/bulk', { action: 'delete', ids: [w.a, w.b] });
    expect(r.data).toEqual({ count: 2, failed: [] });
    expect(row(w.a)).toBeUndefined();
    const undo = (await t.api.get('/api/undo')).data;
    const entries = (undo.items ?? []).filter((e: any) => /Begrüßung|Nachfassen/.test(JSON.stringify(e)));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('has MCP tools (folders read-only, bulk write; delete/activate sensitive) and folder_name creates the folder', async () => {
    const tools = t.app.services.mcpTools as any[];
    expect(tools.find((x) => x.name === 'ghl_workflow_folders').annotations.readOnlyHint).toBe(true);
    const bulk = tools.find((x) => x.name === 'ghl_workflow_bulk');
    expect(bulk.klassFor({ action: 'delete' })).toBe('sensitive');
    expect(bulk.klassFor({ action: 'move' })).toBe('write');
    const calls: any[] = [];
    const api = async (m: string, p: string, o: any) => {
      calls.push([m, p, o?.body]);
      if (m === 'GET') return [{ id: 'f1', name: 'Vertrieb' }];
      return { id: 'new' };
    };
    await bulk.run({ agency: false, api }, { action: 'move', ids: ['w1'], folder_name: 'vertrieb' });
    expect(calls.at(-1)).toEqual(['POST', '/api/workflows/bulk', { action: 'move', ids: ['w1'], folder_id: 'f1' }]);
    await bulk.run({ agency: false, api }, { action: 'move', ids: ['w1'], folder_name: 'Neu' });
    expect(calls.some((c) => c[1] === '/api/workflow-folders' && c[0] === 'POST')).toBe(true);
  });
});
