import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../server/core/csv.js';
import { startTestApp } from './helpers.js';

/** Opportunity list view: filters and sort on GET /api/opportunities, bulk actions with undo, CSV export (modules/deal-list.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let sales: any;
let projects: any;
let me = '';
const deals: Record<string, string> = {};
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  sales = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot', 'Gewonnen'] })).data;
  projects = (await t.api.post('/api/pipelines', { name: 'Projekte', stages: ['Start', 'Läuft'] })).data;
  me = (await t.api.get('/api/location-users')).data[0].id;
  const region = await t.api.post('/api/properties', { object: 'opportunity', label: 'Region', type: 'select', options: ['Nord', 'Süd'] });
  expect(region.status, JSON.stringify(region.data)).toBe(200);
  const mk = async (key: string, body: any, tags: string[] = []) => {
    const c = (await t.api.post('/api/contacts', { first_name: key, last_name: 'Kunde', email: `${key}@example.com`, tags })).data;
    const r = await t.api.post('/api/opportunities', { contact_id: c.id, ...body });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    deals[key] = r.data.id;
  };
  await mk('anna', { pipeline_id: sales.id, name: 'Website', value: 5000 }, ['vip']);
  await mk('ben', { pipeline_id: sales.id, name: 'Logo', value: 800, stage_id: sales.stages[1].id });
  await mk('cara', { pipeline_id: projects.id, name: 'Shop', value: 12000, assigned_to: me }, ['vip', 'shop']);
  await mk('dora', { pipeline_id: projects.id, name: 'Beratung', value: 300 });
  await t.api.put(`/api/opportunities/${deals.anna}/properties`, { properties: { region: 'Nord' } });
  await t.api.put(`/api/opportunities/${deals.cara}/properties`, { properties: { region: 'Süd' } });
});
afterAll(() => t?.close());

const list = async (q: Record<string, string>) => {
  const r = await t.api.get(`/api/opportunities?${new URLSearchParams(q)}`);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return (r.data as any[]).map((o) => o.name);
};
const f = (filters: unknown[]) => JSON.stringify(filters);

describe('filters and sort', () => {
  it('filters on deal fields, contact fields, tags and deal properties across pipelines', async () => {
    expect((await list({ filters: f([{ field: 'value', op: 'gte', value: 800 }]), sort: '-value' }))).toEqual(['Shop', 'Website', 'Logo']);
    expect((await list({ filters: f([{ field: 'pipeline_id', op: 'eq', value: projects.id }]), sort: 'name' }))).toEqual(['Beratung', 'Shop']);
    expect((await list({ filters: f([{ field: 'tags', op: 'contains', value: 'vip' }]), sort: 'name' }))).toEqual(['Shop', 'Website']);
    expect((await list({ filters: f([{ field: 'props.region', op: 'eq', value: 'süd' }]) }))).toEqual(['Shop']);
    expect((await list({ filters: f([{ field: 'props.region', op: 'empty' }]), sort: 'name' }))).toEqual(['Beratung', 'Logo']);
    expect((await list({ filters: f([{ field: 'contact_name', op: 'contains', value: 'ben' }]) }))).toEqual(['Logo']);
    expect((await list({ filters: f([{ field: 'assigned_to', op: 'eq', value: me }]) }))).toEqual(['Shop']);
    expect((await list({ owner: 'none', sort: 'value' }))).toEqual(['Beratung', 'Logo', 'Website']);
    expect((await list({ stage_id: `${sales.stages[1].id},${projects.stages[0].id}`, sort: 'name' }))).toEqual(['Beratung', 'Logo', 'Shop']);
    expect((await list({ tag: 'shop' }))).toEqual(['Shop']);
  });

  it('rows carry the deal properties and the contact tags; the old parameters still work', async () => {
    const rows = (await t.api.get(`/api/opportunities?pipeline_id=${sales.id}&sort=name`)).data as any[];
    expect(rows.map((r) => r.name)).toEqual(['Logo', 'Website']);
    expect(rows[1].props).toEqual({ region: 'Nord' });
    expect(rows[1].contact_tags).toEqual(['vip']);
  });

  it('refuses unknown fields and broken filters in German', async () => {
    const a = await t.api.get(`/api/opportunities?filters=${encodeURIComponent(f([{ field: 'password', op: 'eq', value: 1 }]))}`);
    expect(a.status).toBe(400);
    expect(a.data.error).toMatch(/unbekanntes Feld/);
    expect((await t.api.get('/api/opportunities?filters=%7Bkaputt')).status).toBe(400);
    expect((await t.api.get(`/api/opportunities?filters=${encodeURIComponent(f([{ field: 'props.x;drop', op: 'eq', value: 1 }]))}`)).status).toBe(400);
    // An unknown sort falls back to "last changed".
    expect((await t.api.get('/api/opportunities?sort=-nope')).status).toBe(200);
  });
});

describe('bulk actions', () => {
  it('moves the selected deals to a stage (also into another pipeline) – one undo entry takes it back', async () => {
    const r = await t.api.post('/api/opportunities/bulk', { ids: [deals.anna, deals.ben, deals.dora], action: 'stage', pipeline_id: sales.id, stage_id: sales.stages[2].id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toEqual({ count: 3, skipped: 0 });
    const row = (k: string) => t.app.db.get<{ pipeline_id: string; stage_id: string }>('SELECT pipeline_id, stage_id FROM opportunities WHERE id = ?', deals[k])!;
    expect(row('dora')).toEqual({ pipeline_id: sales.id, stage_id: sales.stages[2].id });
    const undoId = r.headers.get('x-undo-id');
    expect(undoId).toBeTruthy();
    expect(decodeURIComponent(r.headers.get('x-undo-label') ?? '')).toMatch(/3 Deals/);
    expect((await t.api.post(`/api/undo/${undoId}`, {})).status).toBe(200);
    expect(row('dora')).toEqual({ pipeline_id: projects.id, stage_id: projects.stages[0].id });
    expect(row('anna').stage_id).toBe(sales.stages[0].id);
  });

  it('without a pipeline, deals of other pipelines are skipped', async () => {
    const r = await t.api.post('/api/opportunities/bulk', { ids: [deals.anna, deals.cara], action: 'stage', stage_id: sales.stages[1].id });
    expect(r.data).toEqual({ count: 1, skipped: 1 });
  });

  it('sets and clears the owner; refuses people outside the sub-account', async () => {
    expect((await t.api.post('/api/opportunities/bulk', { ids: [deals.anna, deals.ben], action: 'owner', assigned_to: me })).data.count).toBe(2);
    expect(t.app.db.get('SELECT assigned_to FROM opportunities WHERE id = ?', deals.ben)).toEqual({ assigned_to: me });
    expect((await t.api.post('/api/opportunities/bulk', { ids: [deals.ben], action: 'owner', assigned_to: null })).data.count).toBe(1);
    expect(t.app.db.get('SELECT assigned_to FROM opportunities WHERE id = ?', deals.ben)).toEqual({ assigned_to: null });
    expect((await t.api.post('/api/opportunities/bulk', { ids: [deals.ben], action: 'owner', assigned_to: 'fremd' })).status).toBe(400);
    expect((await t.api.post('/api/opportunities/bulk', { ids: [deals.ben], action: 'explode' })).status).toBe(400);
    expect((await t.api.post('/api/opportunities/bulk', { action: 'delete' })).status).toBe(400);
  });

  it('deletes the selected deals and brings them back in one go', async () => {
    const r = await t.api.post('/api/opportunities/bulk', { ids: [deals.anna, deals.dora], action: 'delete' });
    expect(r.data.count).toBe(2);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM opportunities WHERE id IN (?, ?)', deals.anna, deals.dora)).toEqual({ n: 0 });
    expect((await t.api.post(`/api/undo/${r.headers.get('x-undo-id')}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM opportunities WHERE id IN (?, ?)', deals.anna, deals.dora)).toEqual({ n: 2 });
    expect(t.app.db.get('SELECT name, value FROM opportunities WHERE id = ?', deals.anna)).toEqual({ name: 'Website', value: 5000 });
  });

  it("never touches another sub-account's deals", async () => {
    const mine = t.api.location;
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id as string;
    t.api.setLocation(other);
    const p = (await t.api.post('/api/pipelines', { name: 'Fremd' })).data;
    const c = (await t.api.post('/api/contacts', { email: 'fremd@example.com' })).data;
    const foreign = (await t.api.post('/api/opportunities', { pipeline_id: p.id, contact_id: c.id, name: 'Fremder Deal' })).data.id;
    t.api.setLocation(mine);
    expect((await t.api.post('/api/opportunities/bulk', { ids: [foreign], action: 'delete' })).data.count).toBe(0);
    expect((await t.api.post('/api/opportunities/bulk', { ids: [foreign], action: 'owner', assigned_to: me })).data.count).toBe(0);
    expect(t.app.db.get('SELECT assigned_to FROM opportunities WHERE id = ?', foreign)).toEqual({ assigned_to: null });
    const csv = await t.api.get(`/api/opportunities/export.csv?ids=${foreign}`);
    expect(String(csv.data)).not.toContain('Fremder Deal');
  });
});

describe('CSV export', () => {
  it('exports what the list shows, with pipeline, stage, tags and deal properties', async () => {
    const r = await t.api.get(`/api/opportunities/export.csv?sort=-value&filters=${encodeURIComponent(f([{ field: 'tags', op: 'contains', value: 'vip' }]))}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toMatch(/opportunities\.csv/);
    const rows = parseCsv(String(r.data).replace(/^﻿/, ''));
    expect(rows[0]).toEqual(expect.arrayContaining(['Name', 'Kontakt', 'Pipeline', 'Stufe', 'Status', 'Wert', 'Tags', 'Region']));
    const body = rows.slice(1).filter((x) => x.length > 1);
    expect(body.map((x) => x[0])).toEqual(['Shop', 'Website']);
    const shop = body[0];
    expect(shop[rows[0].indexOf('Pipeline')]).toBe('Projekte');
    expect(shop[rows[0].indexOf('Region')]).toBe('Süd');
    expect(shop[rows[0].indexOf('Tags')]).toBe('vip, shop');
    expect(shop[rows[0].indexOf('Status')]).toBe('offen');
  });

  it('exports only the selected deals with ids=', async () => {
    const r = await t.api.get(`/api/opportunities/export.csv?ids=${deals.ben}`);
    const rows = parseCsv(String(r.data).replace(/^﻿/, '')).filter((x) => x.length > 1);
    expect(rows.slice(1).map((x) => x[0])).toEqual(['Logo']);
  });
});
