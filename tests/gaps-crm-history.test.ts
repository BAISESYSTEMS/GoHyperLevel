import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './security-fixtures.js';
import { startTestApp } from './helpers.js';

/** Detailed activity history: field changes of contacts and deals with old/new value and actor (modules/field-history.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
});
afterAll(() => t?.close());

const settle = () => new Promise((r) => setTimeout(r, 60));
const timeline = (cid: string) => t.app.db.all<{ type: string; summary: string }>(`SELECT type, summary FROM activities WHERE contact_id = ? AND type IN ('field.changed', 'deal.field_changed') ORDER BY created_at`, cid);

describe('field history', () => {
  let c = '';
  it('logs a person\'s contact edit with old → new and their name; sensitive fields without values in the timeline', async () => {
    await t.api.post('/api/custom-fields', { key: 'budget', label: 'Budget' });
    c = (await t.api.post('/api/contacts', { email: 'alt@example.com', first_name: 'Erika', city: 'Berlin' })).data.id;
    await t.api.patch(`/api/contacts/${c}`, { city: 'Hamburg', first_name: 'Erika', email: 'neu@example.com', custom: { budget: '5000' } });
    await settle();
    const tl = timeline(c).map((x) => x.summary);
    expect(tl).toContain('Ort geändert · Chef');
    expect(tl).toContain('E-Mail geändert · Chef');
    expect(tl).toContain('Budget geändert · Chef');
    expect(tl.join(' ')).not.toContain('neu@example.com');
    const h = (await t.api.get(`/api/contacts/${c}/field-history`)).data;
    expect(h).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'city', label: 'Ort', old: 'Berlin', new: 'Hamburg', actor_kind: 'user', actor_name: 'Chef' }), expect.objectContaining({ field: 'custom.budget', label: 'Budget', old: '', new: '5000' })]));
    expect(h.some((x: any) => x.field === 'first_name')).toBe(false);
  });

  it('names a workflow as the actor and shows non-sensitive values in the timeline', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Quelle setzen', trigger: { type: 'contact.tag_added', config: { tag: 'messe' } }, steps: [{ id: 's1', type: 'update_field', field: 'source', value: 'Messe 2026' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.post(`/api/contacts/${c}/tags`, { add: ['messe'] });
    await settle();
    await settle();
    const row = (await t.api.get(`/api/contacts/${c}/field-history`)).data.find((x: any) => x.field === 'source');
    expect(row).toMatchObject({ actor_kind: 'workflow', actor_name: 'Workflow „Quelle setzen“', new: 'Messe 2026' });
    expect(timeline(c).map((x) => x.summary).some((x) => x.startsWith('Quelle: ') && x.endsWith('→ Messe 2026 · Workflow „Quelle setzen“'))).toBe(true);
  });

  it('logs deal field changes (stage by name, value without amount in the timeline)', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }, { name: 'Angebot' }] })).data;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c, name: 'Küche', value: 1000 })).data;
    const r = await t.api.patch(`/api/opportunities/${deal.id}`, { stage_id: pipe.stages[1].id, value: 2500, expected_close_date: '2026-12-01' });
    expect(r.status).toBe(200);
    const tl = timeline(c).map((x) => x.summary);
    expect(tl).toContain('Deal „Küche“ – Stufe: Neu → Angebot · Chef');
    expect(tl).toContain('Deal „Küche“ – Wert geändert · Chef');
    expect(tl).toContain('Deal „Küche“ – Erwarteter Abschluss: – → 2026-12-01 · Chef');
    const h = (await t.api.get(`/api/contacts/${c}/field-history`)).data;
    expect(h.find((x: any) => x.field === 'value')).toMatchObject({ opportunity_id: deal.id, old: '1000', new: '2500' });
  });

  it('masks values a restricted person may not see, and hides other people\'s contacts', async () => {
    const u = await t.api.post('/api/users', { email: 'mia@example.com', password: 'passwort-123', name: 'Mia', locations: [loc], permissions: ['contacts'] });
    const mia = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    expect((await mia('POST', '/api/auth/login', { email: 'mia@example.com', password: 'passwort-123' })).status).toBe(200);
    expect((await t.api.put('/api/sales/access', { enabled: true, rules: { default: { levels: {}, hidden: { contacts: ['email'], deals: ['value'] } } } })).status).toBe(200);
    const h = (await mia('GET', `/api/contacts/${c}/field-history`)).data;
    expect(h.find((x: any) => x.field === 'email')).toMatchObject({ old: '', new: '', hidden: true });
    expect(h.find((x: any) => x.field === 'value')).toMatchObject({ old: '', new: '', hidden: true });
    expect(h.find((x: any) => x.field === 'city')).toMatchObject({ old: 'Berlin', new: 'Hamburg' });
    t.app.db.run('UPDATE contacts SET assigned_to = (SELECT id FROM users WHERE email = ?) WHERE id = ?', 'chef@example.com', c);
    await t.api.put('/api/sales/access', { enabled: true, rules: { default: { levels: { contacts: 'own' } }, users: { [u.data.id]: null } } });
    const hidden = await mia('GET', `/api/contacts/${c}/field-history`);
    expect(hidden.status === 404 || (Array.isArray(hidden.data) && hidden.data.length === 0)).toBe(true);
    await t.api.put('/api/sales/access', { enabled: false });
  });

  it('is readable through a read-only MCP tool', async () => {
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_field_history');
    expect(tool.annotations.readOnlyHint).toBe(true);
    let path = '';
    await tool.run({ agency: false, api: async (_m: string, p: string) => ((path = p), []) }, { contact_id: 'c1', limit: 5 });
    expect(path).toBe('/api/contacts/c1/field-history?limit=5');
  });
});
