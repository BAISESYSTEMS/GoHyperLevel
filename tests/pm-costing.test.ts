import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMonths, burndown, cleanThresholds, margin, retainerLines, retainerPeriod, thresholdChanges } from '../server/services/pm-costing-model.js';
import { day, setupPm, settle, type Pm } from './pm-helpers.js';
import type { Call } from './security-fixtures.js';

/**
 * Job costing & retainers: budget thresholds that fire once each (notification, audit, workflow trigger), the retainer month
 * (contingent, carry-over, overage → invoice draft lines), the profitability report (revenue invoiced + unbilled, cost, margin, CSV),
 * who may see and change what, and that another sub-account's records stay out of reach.
 */

describe('pure maths', () => {
  it('retainer month: carry-over none / capped / unlimited and overage', () => {
    const base = { included_hours: 10, carry_in_hours: 0, used_hours: 6, rollover_max_hours: 3 };
    expect(retainerPeriod({ ...base, rollover: 'none' })).toMatchObject({ available_hours: 10, unused_hours: 4, carry_out_hours: 0, overage_hours: 0 });
    expect(retainerPeriod({ ...base, rollover: 'capped' })).toMatchObject({ unused_hours: 4, carry_out_hours: 3 });
    expect(retainerPeriod({ ...base, rollover: 'unlimited' })).toMatchObject({ carry_out_hours: 4 });
    const over = retainerPeriod({ included_hours: 10, carry_in_hours: 2.5, used_hours: 14.25, rollover: 'unlimited', rollover_max_hours: 0 });
    expect(over).toMatchObject({ available_hours: 12.5, overage_hours: 1.75, unused_hours: 0, carry_out_hours: 0 });
    const lines = retainerLines({ name: 'Wartung', price_cents: 150000, overage_rate_cents: 9000 }, over, '2026-09');
    expect(lines).toEqual([
      expect.objectContaining({ name: 'Retainer „Wartung“ – September 2026', qty: 1, price_cents: 150000 }),
      expect.objectContaining({ name: 'Mehrstunden September 2026', qty: 1.75, price_cents: 9000, unit: 'HUR' }),
    ]);
    expect(lines[0].description).toContain('Übertrag 2,5 Std.');
    // no overage rate: no overage line
    expect(retainerLines({ name: 'X', price_cents: 1, overage_rate_cents: 0 }, over, '2026-09')).toHaveLength(1);
  });

  it('thresholds fire once and re-arm only below them; margins; burn-down', () => {
    expect(cleanThresholds(undefined)).toEqual([80, 100]);
    expect(cleanThresholds('100, 50,50')).toEqual([50, 100]);
    expect(thresholdChanges(85, [80, 100], [])).toEqual({ fire: [80], reset: [] });
    expect(thresholdChanges(95, [80, 100], [80])).toEqual({ fire: [], reset: [] });
    expect(thresholdChanges(120, [80, 100], [])).toEqual({ fire: [80, 100], reset: [] });
    expect(thresholdChanges(50, [80, 100], [80, 100])).toEqual({ fire: [], reset: [80, 100] });
    expect(margin(50000, 25000)).toEqual({ margin_cents: 25000, margin_percent: 50 });
    expect(margin(0, 100)).toEqual({ margin_cents: -100, margin_percent: null });
    const b = burndown(10, [{ day: '2026-01-02', value: 3 }, { day: '2026-01-04', value: 2 }], '2026-01-01', '2026-01-05', '2026-01-11');
    expect(b.points.map((p) => p.remaining)).toEqual([10, 7, 7, 5, 5]);
    expect(b.ideal).toEqual([{ day: '2026-01-01', remaining: 10 }, { day: '2026-01-11', remaining: 0 }]);
    expect(addMonths('2026-01', -2)).toBe('2025-11');
  });
});

let p: Pm;
let t: Pm['t'];
let ben: Call;
let anna: Call;
let contactId = '';
const api = () => t.api;
const project = async (body: Record<string, any> = {}) => {
  const r = await api().post('/api/pm/projects', { name: `Projekt ${Math.random().toString(36).slice(2, 6)}`, ...body });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const log = async (projectId: string, minutes: number, date = day(0), as?: Call) => {
  const body = { project_id: projectId, minutes, date };
  const r = as ? await as('POST', '/api/pm/time', body) : await api().post('/api/pm/time', body);
  expect(r.status, JSON.stringify((r as any).data)).toBe(200);
  return (r as any).data;
};
const events: any[] = [];

beforeAll(async () => {
  p = await setupPm();
  t = p.t;
  ben = await p.login(p.ben.email);
  anna = await p.login(p.anna.email);
  contactId = (await api().post('/api/contacts', { email: 'kunde@example.com', first_name: 'Karla', last_name: 'Kunde' })).data.id;
  t.app.events.on('project.budget_threshold', (e) => void events.push(e.data));
}, 60_000);
beforeEach(() => {
  events.length = 0;
});
afterAll(() => t.close());

describe('project budgets', () => {
  it('fires each threshold once – notification, audit line, workflow – and re-arms after the use drops', async () => {
    const proj = await project({ name: 'Budget-Projekt', contact_id: contactId });
    const wf = (await api().post('/api/workflows', { name: 'Budget voll', trigger: { type: 'project.budget_threshold', config: { threshold: 100 } }, steps: [{ type: 'add_tag', tags: ['budget-voll'] }] })).data;
    expect((await api().patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const put = await api().put(`/api/pm/billing/budgets/${proj.id}`, { hours: 10, thresholds: [80, 100] });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect(put.data).toMatchObject({ budget: { hours: 10, thresholds: [80, 100] }, state: 'ok' });

    await log(proj.id, 420);
    await settle(t);
    expect(events).toHaveLength(0);
    const first = await log(proj.id, 90); // 8.5 h = 85 %
    await settle(t);
    expect(events.map((e) => [e.kind, e.threshold])).toEqual([['hours', 80]]);
    expect(events[0]).toMatchObject({ contactId, projectId: proj.id, percent: 85, used: 8.5, budget: 10 });
    const notes = t.app.db.all<any>(`SELECT * FROM pm_notifications WHERE kind = 'budget' AND project_id = ?`, proj.id);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatchObject({ link: `/app/pm/${proj.id}` });
    expect(notes[0].title).toContain('85 % der Stunden');
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pm.budget.threshold' AND entity_id = ?`, proj.id).n).toBe(1);

    await log(proj.id, 30); // 90 %: nothing new
    await settle(t);
    expect(events).toHaveLength(1);
    expect(t.app.services.pmCosting.checkAll()).toBe(0);
    await log(proj.id, 60); // 100 %
    await settle(t);
    expect(events.map((e) => e.threshold)).toEqual([80, 100]);
    expect(t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', contactId).tags).toContain('budget-voll');
    await log(proj.id, 60); // 110 %: both fired already
    await settle(t);
    expect(events).toHaveLength(2);
    const st = (await api().get(`/api/pm/billing/budgets/${proj.id}`)).data;
    expect(st).toMatchObject({ used: { hours: 11 }, percent: { hours: 110 }, remaining: { hours: -1 }, state: 'over', fired: { hours: [80, 100] } });

    // more budget re-arms both thresholds; reaching them again fires again
    await api().put(`/api/pm/billing/budgets/${proj.id}`, { hours: 20 });
    expect((await api().get(`/api/pm/billing/budgets/${proj.id}`)).data.fired).toEqual({ hours: [] });
    expect(events).toHaveLength(2);
    await api().del(`/api/pm/time/${first.id}`);
    await api().put(`/api/pm/billing/budgets/${proj.id}`, { hours: 12 }); // 9.5 / 12 = 79 %
    await log(proj.id, 30); // 10 / 12 = 83 %
    await settle(t);
    expect(events.map((e) => e.threshold)).toEqual([80, 100, 80]);
  });

  it('money budget counts billable value plus external costs; burn-down', async () => {
    const proj = await project({ name: 'Geld-Projekt', hourly_rate_cents: 10000, start_at: day(-3), due_at: day(10) });
    await api().put(`/api/pm/billing/budgets/${proj.id}`, { amount_cents: 100000, thresholds: [50] });
    await log(proj.id, 240, day(-1)); // 400 €
    await settle(t);
    expect(events).toHaveLength(0);
    const cost = await api().post('/api/pm/billing/costs', { project_id: proj.id, description: 'Stockfotos', amount_cents: 15000, day: day(0) });
    expect(cost.status, JSON.stringify(cost.data)).toBe(200);
    await settle(t);
    expect(events.map((e) => [e.kind, e.threshold, e.used])).toEqual([['amount', 50, 55000]]);
    const st = (await api().get(`/api/pm/billing/budgets/${proj.id}`)).data;
    expect(st).toMatchObject({ used: { amount_cents: 55000, time_fees_cents: 40000, external_cost_cents: 15000 }, percent: { amount: 55 } });
    const bd = (await api().get(`/api/pm/billing/burndown/${proj.id}`)).data;
    expect(bd.amount.points.at(-1)).toMatchObject({ day: day(0), remaining: 450 });
    expect(bd.amount.ideal).toEqual([{ day: day(-3), remaining: 1000 }, { day: day(10), remaining: 0 }]);
    expect(bd.hours).toBeNull();
  });
});

describe('retainers', () => {
  it('closes months in order: fee, carry-over up to the cap, overage line – entries billed, a cancelled invoice re-opens the month', async () => {
    const M0 = day(0).slice(0, 7);
    const M1 = addMonths(M0, -1);
    const M2 = addMonths(M0, -2);
    const proj = await project({ name: 'Retainer-Projekt', contact_id: contactId });
    const ret = await api().post('/api/pm/billing/retainers', { name: 'Wartung', project_id: proj.id, hours_per_month: 10, price_cents: 100000, overage_rate_cents: 9000, rollover: 'capped', rollover_max_hours: 5, start_month: M2 });
    expect(ret.status, JSON.stringify(ret.data)).toBe(200);
    expect(ret.data).toMatchObject({ contact_id: contactId, next_month: M2, next_due: true });
    await log(proj.id, 360, `${M2}-10`); // 6 h → 4 unused, 4 carried (cap 5)
    await log(proj.id, 600, `${M1}-03`);
    await log(proj.id, 300, `${M1}-20`); // 15 h of 14 available → 1 h overage
    await log(proj.id, 60, day(0)); // running month: stays open

    expect((await api().post(`/api/pm/billing/retainers/${ret.data.id}/close`, { month: M1 })).status).toBe(409); // out of order
    const pre = (await api().get(`/api/pm/billing/retainers/${ret.data.id}/preview`)).data;
    expect(pre).toMatchObject({ month: M2, used_hours: 6, unused_hours: 4, carry_out_hours: 4, overage_hours: 0 });
    const c1 = await api().post(`/api/pm/billing/retainers/${ret.data.id}/close`, {});
    expect(c1.status, JSON.stringify(c1.data)).toBe(200);
    expect(c1.data.period).toMatchObject({ month: M2, carry_out_hours: 4, entries: 1 });
    const c2 = await api().post(`/api/pm/billing/retainers/${ret.data.id}/close`, {});
    expect(c2.status, JSON.stringify(c2.data)).toBe(200);
    expect(c2.data.period).toMatchObject({ month: M1, carry_in_hours: 4, available_hours: 14, used_hours: 15, overage_hours: 1, carry_out_hours: 0, entries: 2 });
    const inv = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', c2.data.invoice.id);
    expect(inv).toMatchObject({ status: 'draft', contact_id: contactId, subtotal_cents: 109000 });
    const items = JSON.parse(inv.items);
    expect(items.map((i: any) => [i.qty, i.price_cents])).toEqual([[1, 100000], [1, 9000]]);
    expect(items[0].name).toContain('Retainer „Wartung“');
    expect(items[1]).toMatchObject({ unit: 'HUR' });
    const billed = t.app.db.all<any>('SELECT invoice_id FROM pm_time_entries WHERE project_id = ? ORDER BY started_at', proj.id).map((e) => e.invoice_id);
    expect(billed).toEqual([c1.data.invoice.id, c2.data.invoice.id, c2.data.invoice.id, null]);
    // the running month cannot be closed; the time is not billable by the hour twice
    expect((await api().post(`/api/pm/billing/retainers/${ret.data.id}/close`, {})).status).toBe(409);
    expect((await api().get(`/api/pm/billing/unbilled?project_id=${proj.id}`)).data.entries).toBe(1);

    // cancelling the invoice frees the entries and re-opens the month
    expect((await api().patch(`/api/invoices/${c2.data.invoice.id}`, { status: 'void' })).status).toBe(200);
    const again = (await api().get(`/api/pm/billing/retainers/${ret.data.id}`)).data;
    expect(again).toMatchObject({ next_month: M1, next_due: true });
    expect(again.periods[0]).toMatchObject({ month: M1, void: true });
    const c3 = await api().post(`/api/pm/billing/retainers/${ret.data.id}/close`, {});
    expect(c3.status, JSON.stringify(c3.data)).toBe(200);
    expect(c3.data.period).toMatchObject({ month: M1, overage_hours: 1 });
    expect((await api().del(`/api/pm/billing/retainers/${ret.data.id}`)).status).toBe(409);
  });

  it('holds back unapproved time when approval is required, closes automatically when asked', async () => {
    const M1 = addMonths(day(0).slice(0, 7), -1);
    const proj = await project({ name: 'Auto-Retainer', contact_id: contactId });
    await log(proj.id, 120, `${M1}-05`);
    expect((await api().put('/api/pm/settings', { approval_required: true })).status).toBe(200);
    const ret = (await api().post('/api/pm/billing/retainers', { name: 'Auto', project_id: proj.id, hours_per_month: 5, price_cents: 50000, start_month: M1, auto_close: true })).data;
    const r = await api().post(`/api/pm/billing/retainers/${ret.id}/close`, {});
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('nicht freigegeben');
    expect(t.app.services.pmRetainers.autoClose()).toBe(0);
    await api().put('/api/pm/settings', { approval_required: false });
    expect(t.app.services.pmRetainers.autoClose()).toBe(1);
    expect(t.app.db.get<any>('SELECT used_hours FROM pm_retainer_periods WHERE retainer_id = ?', ret.id).used_hours).toBe(2);
  });
});

describe('profitability', () => {
  it('revenue (invoiced + unbilled), cost (cost rates + external), margin per project and client, CSV', async () => {
    const proj = await project({ name: 'Marge-Projekt', contact_id: contactId, hourly_rate_cents: 10000 });
    expect((await api().put('/api/pm/billing/cost-rates', { user_id: p.anna.id, cost_cents: 4000 })).status).toBe(200);
    await log(proj.id, 180, day(-2), anna); // 3 h × 100 € → invoiced below
    await log(proj.id, 120, day(-1), anna); // 2 h unbilled
    const invoice = await api().post('/api/pm/billing/invoice', { project_id: proj.id, to: day(-2) });
    expect(invoice.status, JSON.stringify(invoice.data)).toBe(200);
    await api().post('/api/pm/billing/costs', { project_id: proj.id, description: 'Druck', amount_cents: 5000, day: day(-1) });

    const r = await api().get(`/api/pm/billing/profitability?project_id=${proj.id}`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.rows).toHaveLength(1);
    expect(r.data.rows[0]).toMatchObject({ label: 'Marge-Projekt', hours: 5, revenue_invoiced_cents: 30000, revenue_unbilled_cents: 20000, revenue_cents: 50000, time_cost_cents: 20000, external_cost_cents: 5000, cost_cents: 25000, margin_cents: 25000, margin_percent: 50, missing_cost_rate: false });

    const all = (await api().get('/api/pm/billing/profitability?group=client')).data;
    const client = all.rows.find((x: any) => x.key === `c:${contactId}`);
    expect(client.label).toBe('Karla Kunde');
    expect(client.revenue_cents).toBeGreaterThanOrEqual(50000);
    // the retainer fees of the closed months count for the client (net)
    expect(client.revenue_invoiced_cents).toBeGreaterThanOrEqual(30000 + 100000 + 109000);

    const csv = await api().raw(`/api/pm/billing/profitability/export.csv?project_id=${proj.id}`, { headers: { cookie: api().cookie, 'x-location-id': p.A } });
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('Marge-Projekt,"5,00","5,00","300,00","200,00","500,00","200,00","50,00","250,00","250,00","50,00"');
    expect(text.split('\r\n')[0]).toContain('Marge (%)');
  });
});

describe('permissions and isolation', () => {
  it('area payments for everything, Leitung for budgets, cost rates, retainers and margins', async () => {
    const proj = await project({ name: 'Rechte-Projekt' });
    // Anna: tasks only – no billing at all
    expect((await anna('GET', `/api/pm/billing/budgets/${proj.id}`)).status).toBe(403);
    expect((await anna('GET', '/api/pm/billing/costs')).status).toBe(403);
    // Ben: payments, not Leitung
    expect((await ben('GET', `/api/pm/billing/budgets/${proj.id}`)).status).toBe(200);
    expect((await ben('PUT', `/api/pm/billing/budgets/${proj.id}`, { hours: 5 })).status).toBe(403);
    expect((await ben('GET', '/api/pm/billing/profitability')).status).toBe(403);
    expect((await ben('GET', '/api/pm/billing/cost-rates')).status).toBe(403);
    expect((await ben('PUT', '/api/pm/billing/cost-rates', { user_id: p.ben.id, cost_cents: 1 })).status).toBe(403);
    expect((await ben('POST', '/api/pm/billing/retainers', { name: 'X', project_id: proj.id, hours_per_month: 1, price_cents: 1 })).status).toBe(403);
    const own = await ben('POST', '/api/pm/billing/costs', { project_id: proj.id, description: 'Taxi', amount_cents: 2300 });
    expect(own.status, own.text).toBe(200);
    expect((await ben('PATCH', `/api/pm/billing/costs/${own.data.id}`, { amount_cents: 2400 })).status).toBe(200);
    const chefs = (await api().post('/api/pm/billing/costs', { project_id: proj.id, description: 'Leitung', amount_cents: 100 })).data;
    expect((await ben('DELETE', `/api/pm/billing/costs/${chefs.id}`)).status).toBe(400);
    // receipts of the bookkeeping need the accounting area
    expect((await ben('GET', '/api/pm/billing/receipts')).status).toBe(403);
    expect((await ben('POST', '/api/pm/billing/costs', { project_id: proj.id, receipt_id: 'x', description: 'Beleg' })).status).toBe(403);
  });

  it('links a receipt of the bookkeeping once, at its net amount', async () => {
    const proj = await project({ name: 'Beleg-Projekt' });
    const at = new Date().toISOString();
    t.app.db.run(`INSERT INTO acc_receipts (id, location_id, status, supplier, invoice_no, invoice_date, net_cents, gross_cents, created_at, updated_at) VALUES ('rcpt1', ?, 'review', 'Druckerei Muster', 'R-77', ?, 12000, 14280, ?, ?)`, p.A, day(-4), at, at);
    const list = (await api().get('/api/pm/billing/receipts?q=Druck')).data.receipts;
    expect(list.map((r: any) => r.id)).toContain('rcpt1');
    const c = await api().post('/api/pm/billing/costs', { project_id: proj.id, receipt_id: 'rcpt1' });
    expect(c.status, JSON.stringify(c.data)).toBe(200);
    expect(c.data).toMatchObject({ amount_cents: 12000, description: 'Druckerei Muster R-77', day: day(-4), receipt_id: 'rcpt1' });
    expect((await api().post('/api/pm/billing/costs', { project_id: proj.id, receipt_id: 'rcpt1' })).status).toBe(400);
    expect((await api().get('/api/pm/billing/receipts?q=Druck')).data.receipts).toEqual([]);
  });

  it('another sub-account’s projects, costs and retainers are not found', async () => {
    t.api.setLocation(p.B);
    const foreign = await project({ name: 'Fremdes Projekt' });
    const cost = (await api().post('/api/pm/billing/costs', { project_id: foreign.id, description: 'Fremd', amount_cents: 1 })).data;
    t.api.setLocation(p.A);
    expect((await api().put(`/api/pm/billing/budgets/${foreign.id}`, { hours: 1 })).status).toBe(404);
    expect((await api().get(`/api/pm/billing/burndown/${foreign.id}`)).status).toBe(404);
    expect((await api().post('/api/pm/billing/costs', { project_id: foreign.id, description: 'x', amount_cents: 1 })).status).toBe(404);
    expect((await api().patch(`/api/pm/billing/costs/${cost.id}`, { amount_cents: 5 })).status).toBe(404);
    expect((await api().post('/api/pm/billing/retainers', { name: 'X', project_id: foreign.id, hours_per_month: 1, price_cents: 1 })).status).toBe(404);
    expect((await api().get('/api/pm/billing/costs')).data.costs.some((c: any) => c.id === cost.id)).toBe(false);
  });
});
