import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMonths } from '../server/modules/deal-forecast.js';
import { requiredPermission } from '../server/core/permissions.js';
import { startTestApp } from './helpers.js';

/** Forecast tab: weighted forecast by close month and risk cards (modules/deal-forecast.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t?.close());

const ymd = (offsetDays: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(Date.now() + offsetDays * 864e5));

describe('deal forecast', () => {
  it('adds months across years and maps the route to opportunities', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', 0)).toBe('2026-01');
    expect(requiredPermission('GET', '/api/deal-forecast')).toBe('opportunities');
  });

  it('sums open deals per close month, weighted by stage probability, with risk cards', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu', probability: 10 }, { name: 'Angebot', probability: 50 }] })).data;
    const c = (await t.api.post('/api/contacts', { email: 'f@example.com' })).data.id;
    const mk = async (name: string, value: number, stage: number, close?: string) => (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, stage_id: pipe.stages[stage].id, contact_id: c, name, value, ...(close ? { expected_close_date: close } : {}) })).data.id as string;
    const thisMonth = ymd(0).slice(0, 7);
    const in40 = ymd(40);
    await mk('Bald', 1000, 1, ymd(0));
    await mk('Später', 2000, 0, in40);
    const late = await mk('Überfällig', 500, 1, ymd(-10));
    await mk('Offen ohne Datum', 300, 0);
    const lost = await mk('Verloren', 9999, 1, ymd(0));
    await t.api.patch(`/api/opportunities/${lost}`, { status: 'lost', lost_reason: 'Preis' });
    const r = await t.api.get(`/api/deal-forecast?pipeline_id=${pipe.id}&months=3`);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.open).toEqual({ count: 4, value: 3800, weighted: 500 + 200 + 250 + 30 });
    expect(r.data.months).toHaveLength(3);
    const cur = r.data.months.find((m: any) => m.month === thisMonth);
    expect(cur).toEqual({ month: thisMonth, count: 2, value: 1500, weighted: 750 });
    const next = r.data.months.find((m: any) => m.month === in40.slice(0, 7));
    expect(next).toMatchObject({ count: 1, value: 2000, weighted: 200 });
    expect(r.data.risks.no_close_date).toMatchObject({ count: 1, value: 300 });
    expect(r.data.risks.overdue).toMatchObject({ count: 1, value: 500, deals: [expect.objectContaining({ id: late })] });
    expect(r.data.risks.no_owner.count).toBe(4);
    expect(r.data.risks.stale.count).toBe(0);
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_deal_forecast');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});
