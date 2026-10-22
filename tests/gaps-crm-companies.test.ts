import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** Bulk actions on companies (modules/company-bulk.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t?.close());

describe('companies in bulk', () => {
  it('gives several companies one owner, enrolls their contacts and deletes them (undoable per company)', async () => {
    const me = t.app.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    const a = (await t.api.post('/api/companies', { name: 'Alpha GmbH' })).data.id;
    const b = (await t.api.post('/api/companies', { name: 'Beta AG' })).data.id;
    const c1 = (await t.api.post('/api/contacts', { email: 'eins@alpha.example' })).data.id;
    const c2 = (await t.api.post('/api/contacts', { email: 'zwei@beta.example' })).data.id;
    expect((await t.api.post('/api/associations', { from_type: 'contact', from_id: c1, to_type: 'company', to_id: a })).status).toBe(200);
    expect((await t.api.post('/api/associations', { from_type: 'contact', from_id: c2, to_type: 'company', to_id: b })).status).toBe(200);

    const o = await t.api.post('/api/companies/bulk', { action: 'owner', ids: [a, b], owner_id: me });
    expect(o.status, JSON.stringify(o.data)).toBe(200);
    expect(o.data).toEqual({ count: 2, failed: [] });
    expect(t.app.db.all('SELECT owner_id FROM companies WHERE id IN (?, ?)', a, b).map((r: any) => r.owner_id)).toEqual([me, me]);

    const wf = (await t.api.post('/api/workflows', { name: 'Firmen-Kampagne', trigger: { type: 'contact.created' }, steps: [{ id: 's1', type: 'add_tag', tags: ['b2b'] }] })).data;
    expect((await t.api.post('/api/companies/bulk', { action: 'enroll', ids: [a, b], workflow_id: wf.id })).status).toBe(400); // not active yet
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const e = await t.api.post('/api/companies/bulk', { action: 'enroll', ids: [a, b], workflow_id: wf.id });
    expect(e.data).toMatchObject({ count: 2, contacts: 2, enrolled: 2 });
    expect((await t.api.post('/api/companies/bulk', { action: 'enroll', ids: [a] })).status).toBe(400);

    const d = await t.api.post('/api/companies/bulk', { action: 'delete', ids: [a, b] });
    expect(d.data).toEqual({ count: 2, failed: [] });
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM companies WHERE id IN (?, ?)', a, b)!.n).toBe(0);
  });

  it('refuses unknown actions, empty lists and companies of other sub-accounts; offers an MCP tool', async () => {
    expect((await t.api.post('/api/companies/bulk', { action: 'explode', ids: ['x'] })).status).toBe(400);
    expect((await t.api.post('/api/companies/bulk', { action: 'delete', ids: [] })).status).toBe(400);
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id;
    const foreign = (await t.api.post('/api/companies', { name: 'Fremd GmbH' }, { 'x-location-id': other })).data.id;
    expect((await t.api.post('/api/companies/bulk', { action: 'delete', ids: [foreign] })).status).toBe(400);
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_companies_bulk');
    expect(tool.klassFor({ action: 'delete' })).toBe('sensitive');
    expect(tool.klassFor({ action: 'owner' })).toBe('write');
  });
});
