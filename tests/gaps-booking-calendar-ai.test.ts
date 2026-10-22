import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/** Kalender-KI: set up a calendar by MCP, explain why a time is (not) bookable (modules/calendar-ai.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let calId = '';
let key = '';
const weekdays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['09:00', '17:00']]]));

async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  return { ok: !!j.result && !j.result.isError, data: (() => { try { return JSON.parse(text); } catch { return text; } })(), raw: j };
}

beforeAll(async () => {
  pinClock('2026-11-02T06:00:00Z'); // Monday 07:00 Berlin
  t = await startTestApp();
  await t.setup();
  const k = await t.api.post('/api/api-keys', { name: 'MCP' });
  key = k.data.key ?? k.data.token ?? k.data.secret;
});
afterAll(async () => {
  await t.close();
  unpinClock();
});

describe('calendar AI', () => {
  it('creates a calendar from the agent', async () => {
    expect(key, 'api key').toBeTruthy();
    const r = await rpc('ghl_calendar_create', { location_id: t.api.location, name: 'Erstgespräch', duration: 30, buffer: 15, min_notice: 24, max_days: 30, availability: weekdays });
    expect(r.ok, JSON.stringify(r.raw)).toBe(true);
    expect(r.data).toMatchObject({ name: 'Erstgespräch', duration: 30, interval: 30, buffer: 15, min_notice: 24, max_days: 30 });
    expect(r.data.url).toMatch(/\/book\/erstgespr/);
    expect(r.data.availability.sat ?? []).toEqual([]);
    expect(r.data.availability.mon).toEqual([["09:00", "17:00"]]);
    calId = r.data.id;
    expect((await rpc('ghl_calendar_create', { location_id: t.api.location, name: '' , duration: 30 })).ok).toBe(false);
  });

  it('explains notice, closed days, the grid, other appointments and buffers – and a free time', async () => {
    const ex = (start: string) => t.api.get(`/api/calendar-ai/explain?calendar_id=${calId}&start=${encodeURIComponent(start)}`);
    // Tomorrow 09:00 Berlin is within the 24 h notice.
    const soon = (await ex('2026-11-02T13:00:00Z')).data; // today 14:00 Berlin: within the 24 h notice
    expect(soon.bookable).toBe(false);
    expect(soon.reasons.map((r: any) => r.kind)).toContain('notice');
    expect(soon.next_free.start >= '2026-11-03T06:00:00.000Z').toBe(true);
    // Saturday: outside the hours.
    expect((await ex('2026-11-07T09:00:00Z')).data.reasons.map((r: any) => r.kind)).toContain('hours');
    // Wednesday 09:10: off the 30-minute grid.
    expect((await ex('2026-11-04T08:10:00Z')).data.reasons.map((r: any) => r.kind)).toEqual(['grid']);
    // Free: Wednesday 10:00.
    const free = (await ex('2026-11-04T09:00:00Z')).data;
    expect(free).toMatchObject({ bookable: true, reasons: [] });
    expect(free.free_that_day.length).toBeGreaterThan(5);
    expect(free.start_local).toContain('10:00');
    // An appointment at 10:00 – 10:00 is taken, 10:30 falls into the 15-minute buffer.
    const c = (await t.api.post('/api/contacts', { first_name: 'Bea', email: 'bea@example.com' })).data.id;
    const b = await t.api.post('/api/appointments', { calendar_id: calId, contact_id: c, start_at: '2026-11-04T09:00:00Z', end_at: '2026-11-04T09:30:00Z', title: 'Bea' });
    expect(b.status, JSON.stringify(b.data)).toBe(200);
    const taken = (await ex('2026-11-04T09:00:00Z')).data;
    expect(taken.bookable).toBe(false);
    expect(taken.reasons[0]).toMatchObject({ kind: 'appointment', detail: 'Erstgespräch – Bea' });
    expect((await ex('2026-11-04T09:30:00Z')).data.reasons.map((r: any) => r.kind)).toContain('buffer');
    expect((await ex('kaputt')).status).toBe(400);
    expect((await t.api.get(`/api/calendar-ai/explain?calendar_id=gibtsnicht&start=2026-11-04T09:00:00Z`)).status).toBe(404);
  });

  it('the MCP tool relays and is read-only', async () => {
    const r = await rpc('ghl_calendar_explain_slot', { location_id: t.api.location, calendar_id: calId, start: '2026-11-04T09:00:00Z' });
    expect(r.ok, JSON.stringify(r.raw)).toBe(true);
    expect(r.data.reasons[0].text).toBe('Ein anderer Termin liegt in dieser Zeit');
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_calendar_explain_slot');
    expect(tool.annotations.readOnlyHint).toBe(true);
  });
});
