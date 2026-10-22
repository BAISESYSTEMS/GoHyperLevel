import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { runWorkflow, results } from './wfx-helpers.js';

/**
 * Deals like in HubSpot: expected close date, currency, a required reason when a deal is lost (reasons per pipeline),
 * the report source and the MCP tools that carry the new fields.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let contactId = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot'] })).data;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Dora', email: 'dora@example.com' })).data.id;
});
afterAll(() => t.close());

const deal = async (extra: Record<string, unknown> = {}) => {
  const r = await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, name: 'Paket', value: 1000, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

describe('expected close date and currency', () => {
  it('stores both, defaults to euro and rejects nonsense', async () => {
    const plain = await deal();
    expect(plain).toMatchObject({ currency: 'EUR', expected_close_date: null, lost_reason: '' });
    const o = await deal({ expected_close_date: '2026-12-24', currency: 'chf' });
    expect(o).toMatchObject({ expected_close_date: '2026-12-24', currency: 'CHF' });
    expect((await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, expected_close_date: '24.12.2026' })).status).toBe(400);
    expect((await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, expected_close_date: '2026-02-31' })).status).toBe(400);
    const wrong = await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, currency: 'EURO' });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toMatch(/Währung/);
  });

  it('can be changed and cleared again', async () => {
    const o = await deal({ expected_close_date: '2026-11-01' });
    const r = await t.api.patch(`/api/opportunities/${o.id}`, { expected_close_date: '2027-01-15', currency: 'USD' });
    expect(r.data).toMatchObject({ expected_close_date: '2027-01-15', currency: 'USD' });
    const cleared = await t.api.patch(`/api/opportunities/${o.id}`, { expected_close_date: '' });
    expect(cleared.data.expected_close_date).toBeNull();
    expect((await t.api.get(`/api/opportunities?pipeline_id=${pipe.id}`)).data.find((x: any) => x.id === o.id)).toMatchObject({ currency: 'USD', expected_close_date: null });
  });
});

describe('loss reason', () => {
  it('is required when a deal is moved to lost, kept while it stays lost and cleared when it is reopened', async () => {
    const o = await deal();
    const refused = await t.api.patch(`/api/opportunities/${o.id}`, { status: 'lost' });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/Verlustgrund/);
    expect((await t.api.patch(`/api/opportunities/${o.id}`, { status: 'lost', lost_reason: '   ' })).status).toBe(400);
    expect((await t.api.get(`/api/opportunities?pipeline_id=${pipe.id}`)).data.find((x: any) => x.id === o.id).status).toBe('open');

    const lost = await t.api.patch(`/api/opportunities/${o.id}`, { status: 'lost', lost_reason: 'Preis zu hoch' });
    expect(lost.data).toMatchObject({ status: 'lost', lost_reason: 'Preis zu hoch' });
    // other edits of a lost deal do not ask again
    expect((await t.api.patch(`/api/opportunities/${o.id}`, { name: 'Paket Plus' })).data).toMatchObject({ lost_reason: 'Preis zu hoch', name: 'Paket Plus' });
    // the reason itself cannot be emptied while the deal is lost
    expect((await t.api.patch(`/api/opportunities/${o.id}`, { lost_reason: '' })).status).toBe(400);

    const reopened = await t.api.patch(`/api/opportunities/${o.id}`, { status: 'open' });
    expect(reopened.data).toMatchObject({ status: 'open', lost_reason: '' });
    const won = await deal();
    expect((await t.api.patch(`/api/opportunities/${won.id}`, { status: 'won', lost_reason: 'ignoriert' })).data.lost_reason).toBe('');
  });

  it('a deal created as lost needs a reason, too', async () => {
    expect((await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, status: 'lost' })).status).toBe(400);
    const o = await deal({ status: 'lost', lost_reason: 'Kein Budget' });
    expect(o).toMatchObject({ status: 'lost', lost_reason: 'Kein Budget' });
  });

  it('deals that were lost before reasons existed stay editable', async () => {
    const o = await deal();
    t.app.db.run(`UPDATE opportunities SET status = 'lost' WHERE id = ?`, o.id);
    const r = await t.api.patch(`/api/opportunities/${o.id}`, { value: 1500 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'lost', value: 1500, lost_reason: '' });
  });

  it('keeps the reason on the deal and logs the status change', async () => {
    const o = await deal();
    await t.api.patch(`/api/opportunities/${o.id}`, { status: 'lost', lost_reason: 'Mitbewerber gewählt' });
    await t.app.events.flush();
    const log = t.app.db.all<any>(`SELECT summary FROM activities WHERE contact_id = ? AND type = 'opportunity.status_changed' ORDER BY created_at DESC`, contactId);
    expect(log[0].summary).toContain('Grund: Mitbewerber gewählt');
    expect(t.app.db.get<any>('SELECT lost_reason FROM opportunities WHERE id = ?', o.id)!.lost_reason).toBe('Mitbewerber gewählt');
  });
});

describe('reasons per pipeline', () => {
  it('offers the default list until the pipeline brings its own', async () => {
    const list = (await t.api.get('/api/pipelines')).data.find((p: any) => p.id === pipe.id);
    expect(list.lost_reasons).toBeNull();
    expect(list.lost_reason_options).toContain('Preis zu hoch');
    expect(list.lost_reason_options.length).toBeGreaterThanOrEqual(5);
  });

  it('saves a trimmed list without duplicates, and an empty list resets to the defaults', async () => {
    const r = await t.api.patch(`/api/pipelines/${pipe.id}`, { lost_reasons: ['  Zu teuer ', 'zu teuer', 'Kein Interesse', ''] });
    expect(r.data.lost_reasons).toEqual(['Zu teuer', 'Kein Interesse']);
    expect(r.data.lost_reason_options).toEqual(['Zu teuer', 'Kein Interesse']);
    const text = await t.api.patch(`/api/pipelines/${pipe.id}`, { lost_reasons: 'Eins\nZwei' });
    expect(text.data.lost_reasons).toEqual(['Eins', 'Zwei']);
    expect((await t.api.patch(`/api/pipelines/${pipe.id}`, { lost_reasons: Array.from({ length: 21 }, (_, i) => `Grund ${i}`) })).status).toBe(400);
    const reset = await t.api.patch(`/api/pipelines/${pipe.id}`, { lost_reasons: [] });
    expect(reset.data.lost_reasons).toBeNull();
    expect(reset.data.lost_reason_options).toContain('Kein Budget');
  });

  it('can be set when the pipeline is created', async () => {
    const p = (await t.api.post('/api/pipelines', { name: 'Eigene Gründe', stages: ['Neu'], lost_reasons: ['Nur ein Grund'] })).data;
    expect((await t.api.get('/api/pipelines')).data.find((x: any) => x.id === p.id).lost_reason_options).toEqual(['Nur ein Grund']);
  });
});

describe('reports', () => {
  const run = async (query: Record<string, unknown>) => {
    const r = await t.api.post('/api/reports/run', { query: { source: 'opportunities', range: 'all', ...query } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };

  it('groups lost deals by reason and open deals by month of the expected close', async () => {
    const p = (await t.api.post('/api/pipelines', { name: 'Berichte', stages: ['Neu'] })).data;
    const mk = async (extra: Record<string, unknown>) => (await t.api.post('/api/opportunities', { pipeline_id: p.id, contact_id: contactId, ...extra })).data;
    const a = await mk({ name: 'A', value: 100 });
    await t.api.patch(`/api/opportunities/${a.id}`, { status: 'lost', lost_reason: 'Berichtsgrund A' });
    const b = await mk({ name: 'B', value: 300 });
    await t.api.patch(`/api/opportunities/${b.id}`, { status: 'lost', lost_reason: 'Berichtsgrund A' });
    const c = await mk({ name: 'C', value: 50 });
    await t.api.patch(`/api/opportunities/${c.id}`, { status: 'lost', lost_reason: 'Berichtsgrund C' });
    await mk({ name: 'D', value: 1000, expected_close_date: '2031-03-31' });
    await mk({ name: 'E', value: 2000, expected_close_date: '2031-04-01' });
    await mk({ name: 'F', value: 4000, expected_close_date: '2031-04-30', currency: 'USD' });

    const rowsOf = (r: any) => Object.fromEntries(r.rows.map((x: any) => [x.l.join('|'), x.v]));
    const reasons = await run({ measures: ['count', 'calc:lost_value'], group_by: ['lost_reason'], filters: [{ field: 'status', op: 'eq', value: 'lost' }, { field: 'pipeline', op: 'eq', value: p.id }] });
    expect(rowsOf(reasons)).toEqual({ 'Berichtsgrund A': [2, 400], 'Berichtsgrund C': [1, 50] });

    // Open deals by month of the expected close: March 1000, April 2000 + 4000 (currencies are not converted)
    const forecast = await run({ measures: ['sum:value'], group_by: ['expected_close_date:month'], filters: [{ field: 'status', op: 'eq', value: 'open' }, { field: 'pipeline', op: 'eq', value: p.id }], date_field: 'expected_close_date' });
    expect(Object.fromEntries(forecast.rows.map((x: any) => [x.k[0], x.v[0]]))).toEqual({ '2031-03': 1000, '2031-04': 6000 });
    // the first of the month belongs to that month in every time zone, and the last day of March does not slip into April
    const byCurrency = await run({ measures: ['sum:value'], group_by: ['currency'], filters: [{ field: 'pipeline', op: 'eq', value: p.id }, { field: 'status', op: 'eq', value: 'open' }] });
    expect(rowsOf(byCurrency)).toEqual({ EUR: [3000], USD: [4000] });
  });

  it('flags open deals past their expected close date', async () => {
    const p = (await t.api.post('/api/pipelines', { name: 'Überfällig', stages: ['Neu'] })).data;
    await t.api.post('/api/opportunities', { pipeline_id: p.id, contact_id: contactId, name: 'Alt', expected_close_date: '2020-01-01' });
    await t.api.post('/api/opportunities', { pipeline_id: p.id, contact_id: contactId, name: 'Neu', expected_close_date: '2099-01-01' });
    const r = await run({ measures: ['count'], filters: [{ field: 'pipeline', op: 'eq', value: p.id }, { field: 'close_overdue', op: 'is_true' }] });
    expect(r.totals.v).toEqual([1]);
    const total = await run({ measures: ['count'], filters: [{ field: 'pipeline', op: 'eq', value: p.id }] });
    expect(total.totals.v).toEqual([2]);
  });
});

describe('workflows, MCP and the other entry points', () => {
  it('a workflow that marks a deal as lost gives its own reason, or says it was an automation', async () => {
    const p = (await t.api.post('/api/pipelines', { name: 'Workflow', stages: ['Neu'] })).data;
    const r = await runWorkflow(t, [{ type: 'create_opportunity', pipeline_id: p.id, stage_id: p.stages[0].id, name: 'WF', value: '500', currency: 'usd', expected_close_in_days: '14' }, { type: 'set_opportunity_status', pipeline_id: p.id, status: 'lost', lost_reason: 'Kein Bedarf für {{contact.first_name}}' }]);
    const row = t.app.db.get<any>('SELECT * FROM opportunities WHERE contact_id = ?', r.contact.id)!;
    expect(row).toMatchObject({ status: 'lost', lost_reason: 'Kein Bedarf für Erika', currency: 'USD' });
    expect(row.expected_close_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(results(r.log)[1]).toBe('lost');
    const auto = await runWorkflow(t, [{ type: 'create_opportunity', pipeline_id: p.id, stage_id: p.stages[0].id, name: 'WF2' }, { type: 'set_opportunity_status', pipeline_id: p.id, status: 'lost' }]);
    expect(t.app.db.get<any>('SELECT lost_reason FROM opportunities WHERE contact_id = ?', auto.contact.id)!.lost_reason).toBe('Per Automation');
  });

  it('the newer deal step takes reason, currency and expected close from variables', async () => {
    const p = (await t.api.post('/api/pipelines', { name: 'Workflow 2', stages: ['Neu'] })).data;
    const r = await runWorkflow(t, [
      { type: 'set_variable', rows: [{ name: 'grund', value: 'Zeitpunkt passt nicht' }, { name: 'datum', value: '2030-05-05' }] },
      { type: 'update_opportunity', source: 'current', pipeline_id: p.id, if_missing: 'create', stage_id: p.stages[0].id, currency: 'GBP', expected_close_date: '{{var.datum}}' },
      { type: 'update_opportunity', source: 'current', pipeline_id: p.id, status: 'lost', lost_reason: '{{var.grund}}' },
    ]);
    expect(r.run.status).toBe('completed');
    expect(t.app.db.get<any>('SELECT * FROM opportunities WHERE contact_id = ?', r.contact.id)).toMatchObject({ currency: 'GBP', expected_close_date: '2030-05-05', status: 'lost', lost_reason: 'Zeitpunkt passt nicht' });
  });

  it('MCP tools list, create and update with the new fields', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'mcp' })).data.key;
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { location_id: loc, ...args } } }) });
      const j: any = await r.json();
      return { error: !!j.result?.isError, text: String(j.result?.content?.[0]?.text ?? ''), json: (() => { try { return JSON.parse(j.result?.content?.[0]?.text ?? ''); } catch { return undefined; } })() };
    };
    const tools = await (await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json() as any;
    const upd = tools.result.tools.find((x: any) => x.name === 'ghl_update_opportunity');
    expect(Object.keys(upd.inputSchema.properties)).toEqual(expect.arrayContaining(['lost_reason', 'currency', 'expected_close_date']));
    expect(Object.keys(tools.result.tools.find((x: any) => x.name === 'ghl_create_opportunity').inputSchema.properties)).toEqual(expect.arrayContaining(['currency', 'expected_close_date']));

    const created = await rpc('ghl_create_opportunity', { pipeline_id: pipe.id, name: 'MCP-Deal', value: 700, contact_id: contactId, currency: 'CHF', expected_close_date: '2027-02-02' });
    expect(created.error, created.text).toBe(false);
    expect(created.json).toMatchObject({ currency: 'CHF', expected_close_date: '2027-02-02' });
    const refused = await rpc('ghl_update_opportunity', { opportunity_id: created.json.id, status: 'lost' });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/Verlustgrund/);
    const lost = await rpc('ghl_update_opportunity', { opportunity_id: created.json.id, status: 'lost', lost_reason: 'Per MCP verloren' });
    expect(lost.error, lost.text).toBe(false);
    const list = await rpc('ghl_list_opportunities', { status: 'lost' });
    expect(list.json.find((o: any) => o.id === created.json.id)).toMatchObject({ lost_reason: 'Per MCP verloren', currency: 'CHF', expected_close_date: '2027-02-02' });
  });

  it('REST hooks and the mobile API carry the fields', async () => {
    const o = await deal({ currency: 'USD', expected_close_date: '2027-05-05' });
    const mobile = await t.api.post('/api/mobile/pair', { device_name: 'Test' });
    expect(mobile.status).toBe(200);
    const m = (path: string, body: unknown) => t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mobile.data.token}`, 'x-location-id': loc }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
    const lost = await m(`/api/mobile/deals/${o.id}/status`, { status: 'lost', lost_reason: 'App-Grund' });
    expect(lost.status, JSON.stringify(lost.data)).toBe(200);
    expect(lost.data).toMatchObject({ status: 'lost', lost_reason: 'App-Grund', currency: 'USD', expected_close_date: '2027-05-05' });
    // older app builds send no reason: the deal then says it was closed from the app
    const o2 = await deal();
    const old = await m(`/api/mobile/deals/${o2.id}/status`, { status: 'lost' });
    expect(old.status).toBe(200);
    expect(old.data.lost_reason).toBe('Per App');
  });
});
