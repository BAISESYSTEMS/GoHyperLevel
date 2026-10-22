import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanRule, ruleSql } from '../server/modules/deal-smart-tags.js';
import { applySnapshot, exportSnapshot, validateSnapshot } from '../server/services/snapshots.js';
import { startTestApp } from './helpers.js';

/** Smart Tags on deal cards (modules/deal-smart-tags.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t?.close());

describe('deal smart tags', () => {
  it('validates rules and builds parameterised SQL', () => {
    expect(cleanRule({ kind: 'value_min', value: '5000' })).toEqual({ kind: 'value_min', value: 5000 });
    expect(cleanRule({ kind: 'overdue', value: 3 })).toEqual({ kind: 'overdue' });
    expect(() => cleanRule({ kind: 'stale_days' })).toThrow(/Tage/);
    expect(() => cleanRule({ kind: 'drop table' })).toThrow();
    const q = ruleSql({ kind: 'stale_days', value: 14, pipeline_id: 'p1' }, '2026-10-22', '2026-10-22T10:00:00.000Z');
    expect(q.params).toEqual(['2026-10-08T10:00:00.000Z', 'p1']);
    expect(q.sql).not.toContain('2026');
  });

  it('marks open deals on the board per rule (value, overdue, no close date, no owner, stuck, stale)', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }, { name: 'Angebot' }] })).data;
    const c = (await t.api.post('/api/contacts', { email: 'k@example.com' })).data.id;
    const mk = async (name: string, extra: Record<string, unknown>) => (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c, name, ...extra })).data.id as string;
    const big = await mk('Groß', { value: 20000, expected_close_date: '2099-01-01' });
    const late = await mk('Spät', { value: 100, expected_close_date: '2020-01-01' });
    const old = await mk('Alt', { value: 100, expected_close_date: '2099-01-01' });
    const lost = await mk('Verloren', { value: 50000 });
    await t.api.patch(`/api/opportunities/${lost}`, { status: 'lost', lost_reason: 'Preis' });
    const longAgo = new Date(Date.now() - 40 * 864e5).toISOString();
    t.app.db.run('UPDATE opportunities SET stage_changed_at = ?, created_at = ?, updated_at = ? WHERE id = ?', longAgo, longAgo, longAgo, old);
    t.app.db.run('UPDATE contacts SET last_activity_at = ? WHERE id = ?', longAgo, c);
    const me = t.app.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    t.app.db.run('UPDATE opportunities SET assigned_to = ? WHERE id IN (?, ?)', me, big, late);

    const rule = async (name: string, color: string, r: Record<string, unknown>) => {
      const res = await t.api.post('/api/deal-smart-tags', { name, color, rule: r });
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      return res.data.id as string;
    };
    await rule('Großer Fisch', '#16a34a', { kind: 'value_min', value: 10000 });
    await rule('Überfällig', '#dc2626', { kind: 'overdue' });
    await rule('Ohne Zuständigen', '#f59e0b', { kind: 'no_owner' });
    await rule('Hängt fest', '#6366f1', { kind: 'stage_days', value: 30 });
    await rule('Verrottet', '#78716c', { kind: 'stale_days', value: 14 });
    expect((await t.api.post('/api/deal-smart-tags', { name: 'x', rule: { kind: 'nope' } })).status).toBe(400);
    expect((await t.api.post('/api/deal-smart-tags', { name: 'x', color: 'rot', rule: { kind: 'overdue' } })).status).toBe(400);

    const board = (await t.api.get(`/api/deal-smart-tags/board?pipeline_id=${pipe.id}`)).data;
    const names = (id: string) => (board[id] ?? []).map((x: any) => x.name).sort();
    expect(names(big)).toEqual(['Großer Fisch']);
    expect(names(late)).toEqual(['Überfällig']);
    expect(names(old)).toEqual(['Hängt fest', 'Ohne Zuständigen', 'Verrottet']);
    expect(board[lost]).toBeUndefined();
  });

  it('edits, deletes, travels in snapshots and is readable by agents', async () => {
    const list = (await t.api.get('/api/deal-smart-tags')).data;
    expect(list).toHaveLength(5);
    const first = list[0];
    expect((await t.api.patch(`/api/deal-smart-tags/${first.id}`, { name: 'Wal', rule: { kind: 'value_min', value: 50000 } })).data).toMatchObject({ name: 'Wal', rule: { kind: 'value_min', value: 50000 } });
    expect((await t.api.del(`/api/deal-smart-tags/${list[4].id}`)).status).toBe(200);
    expect((await t.api.del(`/api/deal-smart-tags/${list[4].id}`)).status).toBe(404);
    const data = validateSnapshot(JSON.parse(JSON.stringify(exportSnapshot(t.app, loc))));
    const other = (await t.api.post('/api/locations', { name: 'Kopie' })).data.id;
    applySnapshot(t.app, other, data);
    expect(t.app.db.all<{ name: string }>('SELECT name FROM deal_smart_tags WHERE location_id = ? ORDER BY position', other).map((x) => x.name)).toEqual(['Wal', 'Überfällig', 'Ohne Zuständigen', 'Hängt fest']);
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_deal_smart_tags');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});
