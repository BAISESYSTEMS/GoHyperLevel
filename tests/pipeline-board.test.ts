import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySnapshot, exportSnapshot } from '../server/services/snapshots.js';
import { startTestApp } from './helpers.js';

/** Kanban comfort (modules/pipeline-board.ts + stage colours in modules/pipelines.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t?.close());

const names = async () => (await t.api.get('/api/pipelines')).data.map((p: any) => p.name);

describe('pipeline board', () => {
  it('keeps a colour per stage and drops colours that are not #rrggbb', async () => {
    const p = await t.api.post('/api/pipelines', { name: 'Farben', stages: [{ name: 'Neu', color: '#22C55E' }, { name: 'Angebot', color: 'rot' }, { name: 'Gewonnen', probability: 90, color: '#3b82f6' }] });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data.stages.map((s: any) => s.color)).toEqual(['#22c55e', undefined, '#3b82f6']);
    expect(p.data.stages[2].probability).toBe(90);
    // Editing keeps the colours (and the ids) the editor sends back.
    const stages = p.data.stages.map((s: any, i: number) => (i === 1 ? { ...s, color: '#f59e0b' } : s));
    const e = await t.api.patch(`/api/pipelines/${p.data.id}`, { stages });
    expect(e.data.stages.map((s: any) => s.color)).toEqual(['#22c55e', '#f59e0b', '#3b82f6']);
    expect(e.data.stages.map((s: any) => s.id)).toEqual(p.data.stages.map((s: any) => s.id));
  });

  it('the stage colours travel with a snapshot', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Kopie' })).data.id as string;
    applySnapshot(t.app, other, JSON.parse(JSON.stringify(exportSnapshot(t.app, t.api.location))));
    const row = t.app.db.get<{ stages: string }>(`SELECT stages FROM pipelines WHERE location_id = ? AND name = 'Farben'`, other)!;
    expect(JSON.parse(row.stages).map((s: any) => s.color)).toEqual(['#22c55e', '#f59e0b', '#3b82f6']);
  });

  it('sorts the pipelines; left-out ones follow in their old order', async () => {
    await t.api.post('/api/pipelines', { name: 'Zweite' });
    await t.api.post('/api/pipelines', { name: 'Dritte' });
    const list = (await t.api.get('/api/pipelines')).data as any[];
    const id = (n: string) => list.find((p) => p.name === n).id;
    const r = await t.api.post('/api/pipelines/order', { ids: [id('Dritte'), id('Farben')] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const now = await names();
    expect(now.slice(0, 2)).toEqual(['Dritte', 'Farben']);
    expect(now.length).toBe(list.length);
    expect(now.indexOf('Zweite')).toBeGreaterThan(1);
    expect(r.data.ids).toEqual((await t.api.get('/api/pipelines')).data.map((p: any) => p.id));
  });

  it('refuses empty, unknown and foreign pipelines', async () => {
    expect((await t.api.post('/api/pipelines/order', {})).status).toBe(400);
    expect((await t.api.post('/api/pipelines/order', { ids: ['nope'] })).status).toBe(400);
    const mine = t.api.location;
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id as string;
    t.api.setLocation(other);
    const foreign = (await t.api.post('/api/pipelines', { name: 'Fremde Pipeline' })).data.id as string;
    t.api.setLocation(mine);
    const before = await names();
    expect((await t.api.post('/api/pipelines/order', { ids: [foreign] })).status).toBe(400);
    expect(await names()).toEqual(before);
    expect(t.app.db.get<{ position: number | null }>('SELECT position FROM pipelines WHERE id = ?', foreign)!.position).toBeNull();
  });
});
