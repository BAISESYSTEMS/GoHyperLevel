import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';

// Setting up a test app and logging in a few users takes long when the machine is busy.
vi.setConfig({ hookTimeout: 60_000 });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let loc2 = '';
const tokens: Record<string, string> = {};

/** A request with only the device token (no cookie, no CSRF header). */
async function app(method: string, path: string, tok: string, body?: unknown) {
  const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, data: (type.includes('json') ? await r.json() : await r.text()) as any };
}

/** Creates a member (all sub-accounts given), signs them in and pairs a phone. */
async function phone(name: string, permissions: string[] | null, locations = [loc]) {
  const email = `${name}@example.com`;
  const u = await t.api.post('/api/users', { email, name, password: 'geheim-12345', role: 'member', locations, permissions });
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
  const p = await c('POST', '/api/mobile/pair', { device_name: `${name}-phone`, platform: 'android', app_version: '1.0.0' });
  expect(p.status, p.text).toBe(200);
  tokens[name] = p.data.token;
  return { id: u.data.id as string, tok: p.data.token as string };
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  loc2 = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
});
afterAll(() => t.close());

describe('receipts from the phone', () => {
  it('lets the bookkeeper photograph a receipt and see the inbox, and keeps everybody else out', async () => {
    const acc = await phone('buchhalter', ['accounting']);
    const sales = await phone('vertrieb', ['contacts']);
    const up = await app('POST', '/api/mobile/receipts', acc.tok, { location_id: loc, data: PNG, note: 'Tankstelle' });
    expect(up.status, JSON.stringify(up.data)).toBe(200);
    expect(up.data.location_name).toBe('Testfirma');
    expect(t.app.db.get<any>(`SELECT source FROM acc_receipts WHERE location_id = ? ORDER BY created_at DESC LIMIT 1`, loc)!.source).toBe('mobile');
    const list = await app('GET', '/api/mobile/receipts?location=' + loc, acc.tok);
    expect(list.status).toBe(200);
    expect(list.data.counts.inbox).toBeGreaterThanOrEqual(1);
    expect(list.data.receipts[0]).toMatchObject({ status: 'inbox', location_name: 'Testfirma' });
    // The same photo twice is recognised by its hash (no second archive entry).
    const again = await app('POST', '/api/mobile/receipts', acc.tok, { location_id: loc, data: PNG });
    expect(again.status).toBe(200);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM acc_documents WHERE location_id = ?', loc)!.n).toBe(1);

    expect((await app('POST', '/api/mobile/receipts', acc.tok, { location_id: loc, data: 'kein bild' })).status).toBe(400);
    expect((await app('POST', '/api/mobile/receipts', acc.tok, { data: PNG })).status).toBe(400);
    expect((await app('POST', '/api/mobile/receipts', acc.tok, { location_id: loc2, data: PNG })).status).toBe(403);
    expect((await app('GET', '/api/mobile/receipts?status=zu', acc.tok)).status).toBe(400);
    for (const [m, p, b] of [['GET', '/api/mobile/receipts', undefined], ['POST', '/api/mobile/receipts', { location_id: loc, data: PNG }]] as const) {
      const r = await app(m, p, sales.tok, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.data.error).toMatch(/Buchhaltung/);
    }
  });
});

describe('absences on the phone', () => {
  let anna: { id: string; tok: string };
  let boss: { id: string; tok: string };
  let empId = '';

  beforeAll(async () => {
    anna = await phone('anna', []);
    boss = await phone('chefin', []);
    const e = await t.api.post('/api/hr/employees', { first_name: 'Anna', last_name: 'App', user_id: anna.id, manager_user_id: boss.id, start_date: '2020-01-01' });
    expect(e.status, JSON.stringify(e.data)).toBe(200);
    empId = e.data.id;
    expect((await t.api.post('/api/hr/employees', { first_name: 'Chefin', last_name: 'Boss', user_id: boss.id, start_date: '2020-01-01' })).status).toBe(200);
  });

  it('shows the own record with balance, requests vacation, withdraws it and notes sick leave', async () => {
    const me = await app('GET', '/api/mobile/absences', anna.tok);
    expect(me.status, JSON.stringify(me.data)).toBe(200);
    expect(me.data).toHaveLength(1);
    expect(me.data[0]).toMatchObject({ location_id: loc, location_name: 'Testfirma', employee: { name: 'Anna App', vacation_days: 30 }, is_manager: false, absences: [] });
    expect(me.data[0].balance).toMatchObject({ entitlement: 30 });
    const req = await app('POST', '/api/mobile/absences', anna.tok, { location_id: loc, type: 'vacation', start_date: '2030-05-13', end_date: '2030-05-17' });
    expect(req.status, JSON.stringify(req.data)).toBe(200);
    expect(req.data).toMatchObject({ status: 'requested', days: 5, employee_id: empId, location_name: 'Testfirma' });
    expect((await app('POST', `/api/mobile/absences/${req.data.id}/cancel`, anna.tok, {})).data.status).toBe('cancelled');
    const sick = await app('POST', '/api/mobile/absences', anna.tok, { location_id: loc, type: 'sick', start_date: '2030-01-14', reason: 'Grippe' });
    expect(sick.data).toMatchObject({ status: 'approved', reason: '' });
    const list = await app('GET', `/api/mobile/absences?location=${loc}&year=2030`, anna.tok);
    expect(list.data[0].absences.map((a: any) => a.type).sort()).toEqual(['sick', 'vacation']);
    // The rules are the web app's: too long, overlapping, not an employee.
    expect((await app('POST', '/api/mobile/absences', anna.tok, { location_id: loc, type: 'vacation', start_date: '2030-02-04', end_date: '2030-06-28' })).data.error).toMatch(/Nicht genug Urlaub/);
    expect((await app('POST', '/api/mobile/absences', anna.tok, { location_id: loc, type: 'sick', start_date: '2030-01-14' })).data.error).toMatch(/schon eine Abwesenheit/);
    expect((await app('POST', '/api/mobile/absences', anna.tok, { type: 'vacation', start_date: '2030-02-04' })).status).toBe(400);
    expect((await app('POST', '/api/mobile/absences', anna.tok, { location_id: loc2, type: 'vacation', start_date: '2030-02-04' })).status).toBe(403);
    const stranger = await phone('extern', ['contacts']);
    expect((await app('GET', '/api/mobile/absences', stranger.tok)).data).toEqual([]);
    expect((await app('POST', '/api/mobile/absences', stranger.tok, { location_id: loc, type: 'vacation', start_date: '2030-02-04' })).status).toBe(404);
    expect((await app('POST', `/api/mobile/absences/${req.data.id}/cancel`, stranger.tok, {})).status).toBe(404);
  });

  it('lets the manager approve from the phone, and the employee sees the result', async () => {
    const req = await app('POST', '/api/mobile/absences', anna.tok, { location_id: loc, type: 'vacation', start_date: '2030-07-01', end_date: '2030-07-03' });
    expect(req.status).toBe(200);
    expect((await app('GET', '/api/mobile/absences/approvals', anna.tok)).data).toEqual([]);
    const pending = await app('GET', '/api/mobile/absences/approvals', boss.tok);
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0]).toMatchObject({ id: req.data.id, employee_name: 'Anna App', location_name: 'Testfirma', days: 3 });
    expect((await app('POST', `/api/mobile/absences/${req.data.id}/decide`, anna.tok, { decision: 'approved' })).status).toBe(404);
    expect((await app('POST', `/api/mobile/absences/${req.data.id}/decide`, boss.tok, { decision: 'vielleicht' })).status).toBe(400);
    const ok = await app('POST', `/api/mobile/absences/${req.data.id}/decide`, boss.tok, { decision: 'approved', note: 'Gute Erholung' });
    expect(ok.data).toMatchObject({ status: 'approved', decision_note: 'Gute Erholung' });
    expect((await app('GET', '/api/mobile/absences/approvals', boss.tok)).data).toEqual([]);
    const me = await app('GET', `/api/mobile/absences?location=${loc}&year=2030`, anna.tok);
    expect(me.data[0].balance).toMatchObject({ taken: 3 });
    // The boss sees the team calendar with the approved vacation – and not the sick leave as such.
    const cal = await app('GET', '/api/mobile/absences/calendar?location=' + loc + '&from=2030-01-01&to=2030-07-31', boss.tok);
    expect(cal.status).toBe(200);
    const items = cal.data[0].items;
    expect(items.find((i: any) => i.start_date === '2030-07-01')).toMatchObject({ type: 'vacation', name: 'Anna App' });
    expect(items.find((i: any) => i.start_date === '2030-01-14')).toMatchObject({ type: 'away' });
    // The audit log records the relayed writes as coming from the app.
    const log = t.app.db.all<any>(`SELECT via, action FROM audit_log WHERE via = 'app'`);
    expect(log.length).toBeGreaterThan(0);
  });

  it('keeps HR data away from the app token', async () => {
    for (const path of ['/api/hr/employees', `/api/hr/employees/${empId}/sensitive`, '/api/hr/absences']) expect((await app('GET', path, anna.tok)).status, path).toBe(403);
    // Not even an admin's phone is a browser session: the sensitive block stays closed.
    const admin = await t.api.post('/api/mobile/pair', { device_name: 'Admin-Handy' });
    expect(admin.status).toBe(200);
    expect((await app('GET', `/api/hr/employees/${empId}/sensitive`, admin.data.token)).status).toBe(403);
  });
});

describe('low stock on the phone', () => {
  it('lists what is below the minimum for people with the area and refuses the others', async () => {
    const lager = await phone('lager', ['inventory']);
    const sales = await phone('verkauf', ['payments']);
    expect((await t.api.post('/api/inventory/articles', { sku: 'MOB-1', name: 'Mobil-Artikel', min_stock: 5, initial_qty: 2, unit: 'Stk' })).status).toBe(200);
    expect((await t.api.post('/api/inventory/articles', { sku: 'MOB-2', name: 'Genug da', min_stock: 1, initial_qty: 9 })).status).toBe(200);
    const low = await app('GET', '/api/mobile/stock/low', lager.tok);
    expect(low.status, JSON.stringify(low.data)).toBe(200);
    expect(low.data.map((a: any) => a.sku)).toEqual(['MOB-1']);
    expect(low.data[0]).toMatchObject({ location_name: 'Testfirma' });
    const denied = await app('GET', '/api/mobile/stock/low', sales.tok);
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/Lager/);
    expect((await app('GET', '/api/mobile/stock/low?location=' + loc2, lager.tok)).status).toBe(403);
    expect((await app('GET', '/api/mobile/stock/low?location=gibtsnicht', lager.tok)).status).toBe(404);
  });
});
