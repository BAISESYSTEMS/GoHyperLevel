import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';
import { absenceDays, balance, easter, entitlement, holidays, isState, overlaps, STATES } from '../server/services/hr-leave.js';

// Setting up a test app and logging in a few users takes long when the machine is busy.
vi.setConfig({ hookTimeout: 60_000 });

// --- the pure rules ---------------------------------------------------------------------------------------------------------------

describe('public holidays', () => {
  it('computes Easter Sunday', () => {
    expect(easter(2024)).toBe('2024-03-31');
    expect(easter(2025)).toBe('2025-04-20');
    expect(easter(2026)).toBe('2026-04-05');
    expect(easter(2027)).toBe('2027-03-28');
    expect(easter(2030)).toBe('2030-04-21');
  });

  it('has the movable holidays relative to Easter', () => {
    const be = Object.fromEntries(holidays(2025, 'BE').map((h) => [h.name, h.date]));
    expect(be['Karfreitag']).toBe('2025-04-18');
    expect(be['Ostermontag']).toBe('2025-04-21');
    expect(be['Christi Himmelfahrt']).toBe('2025-05-29');
    expect(be['Pfingstmontag']).toBe('2025-06-09');
    expect(holidays(2025, 'BY').find((h) => h.name === 'Fronleichnam')?.date).toBe('2025-06-19');
  });

  it('differs per Bundesland', () => {
    const names = (y: number, s: string) => holidays(y, s).map((h) => h.name);
    expect(holidays(2025, 'BE')).toHaveLength(11); // incl. Frauentag and the one-off 8 May 2025
    expect(holidays(2025, 'BY')).toHaveLength(12);
    expect(holidays(2025, 'NW')).toHaveLength(11);
    expect(holidays(2025, 'HH')).toHaveLength(10);
    expect(names(2025, 'BE')).toContain('Internationaler Frauentag');
    expect(names(2025, 'BE')).toContain('Tag der Befreiung');
    expect(names(2026, 'BE')).not.toContain('Tag der Befreiung');
    expect(names(2025, 'BY')).toEqual(expect.arrayContaining(['Heilige Drei Könige', 'Fronleichnam', 'Allerheiligen']));
    expect(names(2025, 'BY')).not.toContain('Internationaler Frauentag');
    expect(names(2025, 'NI')).toContain('Reformationstag');
    expect(names(2025, 'BW')).not.toContain('Reformationstag');
    expect(names(2025, 'TH')).toContain('Weltkindertag');
    // Every state has the nationwide ones.
    for (const s of Object.keys(STATES)) expect(names(2025, s)).toEqual(expect.arrayContaining(['Neujahr', 'Karfreitag', 'Ostermontag', 'Tag der Arbeit', 'Christi Himmelfahrt', 'Pfingstmontag', 'Tag der Deutschen Einheit', '1. Weihnachtstag', '2. Weihnachtstag']));
    expect(isState('BE')).toBe(true);
    expect(isState('XX')).toBe(false);
  });

  it('finds the Buß- und Bettag (Wednesday before 23 November, Sachsen only)', () => {
    expect(holidays(2025, 'SN').find((h) => h.name === 'Buß- und Bettag')?.date).toBe('2025-11-19');
    expect(holidays(2026, 'SN').find((h) => h.name === 'Buß- und Bettag')?.date).toBe('2026-11-18');
    expect(holidays(2025, 'BE').some((h) => h.name === 'Buß- und Bettag')).toBe(false);
  });
});

describe('working days of an absence', () => {
  const be = { work_days: [1, 2, 3, 4, 5], state: 'BE' };
  const days = (s: string, e: string, p = be, extra: any = {}) => absenceDays({ start_date: s, end_date: e, ...extra }, p);

  it('skips weekends and public holidays of the state but not Christmas Eve or New Year\'s Eve', () => {
    // Mon 22 Dec 2025 – Fri 2 Jan 2026: 24, 29, 30, 31 and the 22nd, 23rd and 2 Jan count; 25, 26 and 1 Jan do not.
    const list = days('2025-12-22', '2026-01-02');
    expect(list.map((d) => d.date)).toEqual(['2025-12-22', '2025-12-23', '2025-12-24', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-02']);
    expect(days('2025-12-27', '2025-12-28')).toEqual([]);
  });

  it('counts the same week differently where the holiday exists only in one state', () => {
    // Frauentag (Berlin, 8 March) is a Friday in 2030.
    expect(days('2030-03-04', '2030-03-08')).toHaveLength(4);
    expect(days('2030-03-04', '2030-03-08', { work_days: [1, 2, 3, 4, 5], state: 'BY' })).toHaveLength(5);
  });

  it('handles half days at the start or end and part-time weekdays', () => {
    expect(days('2030-05-13', '2030-05-15', be, { half_end: true }).map((d) => d.value)).toEqual([1, 1, 0.5]);
    expect(days('2030-05-13', '2030-05-15', be, { half_start: true }).map((d) => d.value)).toEqual([0.5, 1, 1]);
    // One day with a half flag is a half day, not a quarter.
    expect(days('2030-05-13', '2030-05-13', be, { half_start: true, half_end: true }).map((d) => d.value)).toEqual([0.5]);
    // Part-time: Monday, Wednesday, Friday.
    expect(days('2030-05-13', '2030-05-17', { work_days: [1, 3, 5], state: 'BE' }).map((d) => d.date)).toEqual(['2030-05-13', '2030-05-15', '2030-05-17']);
    // A half day on a holiday or weekend is nothing.
    expect(days('2025-12-25', '2025-12-25', be, { half_start: true })).toEqual([]);
    expect(days('2030-05-17', '2030-05-13')).toEqual([]);
  });

  it('detects overlapping ranges', () => {
    expect(overlaps({ start_date: '2030-05-13', end_date: '2030-05-17' }, { start_date: '2030-05-17', end_date: '2030-05-20' })).toBe(true);
    expect(overlaps({ start_date: '2030-05-13', end_date: '2030-05-17' }, { start_date: '2030-05-18', end_date: '2030-05-20' })).toBe(false);
  });
});

describe('vacation entitlement (pro rata, § 5 BUrlG)', () => {
  it('gives the whole year its full days', () => {
    expect(entitlement(30, 2025)).toBe(30);
    expect(entitlement(30, 2025, '2024-06-01')).toBe(30);
    expect(entitlement(30, 2025, '2025-01-01', '2025-12-31')).toBe(30);
  });

  it('counts full months of employment and rounds a fraction of at least half a day up', () => {
    expect(entitlement(30, 2025, '2025-04-01')).toBe(23); // 9/12 of 30 = 22.5 → 23
    expect(entitlement(25, 2025, '2025-06-01')).toBe(15); // 7/12 of 25 = 14.58 → 15
    expect(entitlement(30, 2025, '2025-10-01')).toBe(8); // 3/12 of 30 = 7.5 → 8
    expect(entitlement(24, 2025, '2025-08-01')).toBe(10); // 5/12 of 24 = 10
    expect(entitlement(28, 2025, '2025-09-01')).toBe(9.333); // 4/12 of 28 = 9.33: below half a day, stays
    expect(entitlement(30, 2025, '2025-04-15')).toBe(20); // a started month does not count: May–Dec = 8/12
  });

  it('shortens the entitlement in the year of leaving', () => {
    expect(entitlement(30, 2025, '2020-01-01', '2025-06-30')).toBe(15);
    expect(entitlement(30, 2025, '2020-01-01', '2025-06-29')).toBe(13); // five full months = 12.5 → 13
  });

  it('is nothing before the start or after the end', () => {
    expect(entitlement(30, 2024, '2025-04-01')).toBe(0);
    expect(entitlement(30, 2026, '2020-01-01', '2025-06-30')).toBe(0);
  });
});

describe('vacation balance', () => {
  const be = { work_days: [1, 2, 3, 4, 5], state: 'BE' };
  const abs = (type: string, status: string, start: string, end: string) => ({ type, status, start_date: start, end_date: end });
  const base = { annualDays: 30, carryover: 0, adjustment: 0, carryoverExpiry: '03-31', profile: be, year: 2030, asOf: '2030-02-01' };

  it('subtracts approved vacation, shows requested as pending and ignores sick leave and other absences', () => {
    const b = balance({ ...base, absences: [abs('vacation', 'approved', '2030-05-13', '2030-05-17'), abs('vacation', 'requested', '2030-07-01', '2030-07-05'), abs('sick', 'approved', '2030-06-03', '2030-06-04'), abs('other', 'approved', '2030-06-05', '2030-06-05'), abs('vacation', 'rejected', '2030-08-05', '2030-08-09'), abs('vacation', 'cancelled', '2030-08-12', '2030-08-16')] });
    expect(b).toMatchObject({ entitlement: 30, taken: 5, pending: 5, sick: 2, other: 1, remaining: 25, available: 20 });
  });

  it('counts half days and holidays inside a vacation correctly', () => {
    // 2030-06-10 (Pfingstmontag) to 06-14: four working days, the last one half.
    const b = balance({ ...base, absences: [{ ...abs('vacation', 'approved', '2030-06-10', '2030-06-14'), half_end: true }] });
    expect(b.taken).toBe(3.5);
    expect(b.remaining).toBe(26.5);
  });

  it('splits a vacation over the year end between both years', () => {
    const list = [abs('vacation', 'approved', '2030-12-23', '2031-01-03')];
    // 2030: 23, 24, 27, 30, 31 (25 and 26 are holidays); 2031: 2 and 3 Jan (1 Jan is a holiday).
    expect(balance({ ...base, absences: list }).taken).toBe(5);
    expect(balance({ ...base, year: 2031, absences: list, asOf: '2031-01-01' }).taken).toBe(2);
  });

  it('uses carry-over first until it expires and forfeits what is left', () => {
    const march = [abs('vacation', 'approved', '2030-03-04', '2030-03-06')]; // 3 days before 31 March (BE: 8 March is not touched)
    const early = balance({ ...base, carryover: 8, absences: march, asOf: '2030-03-15' });
    expect(early).toMatchObject({ carryover: 8, carryover_used: 3, carryover_forfeited: 0, entitlement: 30, taken: 3, remaining: 35, carryover_expires: '2030-03-31' });
    const late = balance({ ...base, carryover: 8, absences: march, asOf: '2030-04-15' });
    expect(late).toMatchObject({ carryover_used: 3, carryover_forfeited: 5, remaining: 30 });
    // Everything used in time: nothing is lost.
    const used = balance({ ...base, carryover: 3, absences: march, asOf: '2030-12-31' });
    expect(used).toMatchObject({ carryover_forfeited: 0, remaining: 30 });
    // No expiry configured: carry-over stays.
    expect(balance({ ...base, carryover: 8, carryoverExpiry: null, absences: [], asOf: '2030-12-31' }).remaining).toBe(38);
  });

  it('adds manual corrections and uses the pro-rata entitlement of a new hire', () => {
    expect(balance({ ...base, adjustment: -2, startDate: '2030-04-01', absences: [] }).remaining).toBe(21); // 23 - 2
    expect(balance({ ...base, adjustment: 1.5, absences: [] }).remaining).toBe(31.5);
  });
});

// --- the module -------------------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: { type: string; data: any }[] = [];
const flush = () => t.app.events.flush();

const mkUser = async (email: string, permissions: string[] | null, role: 'member' | 'admin' = 'member') => {
  const r = await t.api.post('/api/users', { email, name: email.split('@')[0], password: 'geheim-12345', role, locations: [loc], permissions });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
  return { id: r.data.id as string, call: c };
};
const emp = async (b: any) => {
  const r = await t.api.post('/api/hr/employees', b);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  for (const type of ['absence.requested', 'absence.approved', 'absence.rejected']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(() => t.close());

describe('employees', () => {
  it('creates employees with defaults, numbers them and validates the contract data', async () => {
    const a = await emp({ first_name: 'Anna', last_name: 'Beispiel', email: 'anna.b@example.com', position: 'Designerin', start_date: '2024-02-01' });
    expect(a).toMatchObject({ number: 'P-001', name: 'Anna Beispiel', vacation_days: 30, weekly_hours: 40, state: 'BE', status: 'active', work_days: [1, 2, 3, 4, 5], employment_type: 'full' });
    const b = await emp({ last_name: 'Zweitmann', employment_type: 'part', weekly_hours: 20, work_days: [1, 3, 5], vacation_days: 15, state: 'BY' });
    expect(b).toMatchObject({ number: 'P-002', weekly_hours: 20, work_days: [1, 3, 5], state: 'BY' });
    expect((await t.api.post('/api/hr/employees', { first_name: 'Ohne' })).status).toBe(400);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', start_date: '2024-13-01' })).data.error).toMatch(/JJJJ-MM-TT/);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', start_date: '2024-05-01', end_date: '2024-04-01' })).data.error).toMatch(/Austritt/);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', weekly_hours: 120 })).status).toBe(400);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', work_days: [0, 9] })).status).toBe(400);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', employment_type: 'pirat' })).status).toBe(400);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', state: 'ZZ' })).status).toBe(400);
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', email: 'kein-mail' })).status).toBe(400);
    const list = (await t.api.get('/api/hr/employees')).data;
    expect(list.map((x: any) => x.number)).toEqual(['P-001', 'P-002']);
    expect(list[0].vacation).toMatchObject({ entitlement: 30 });
    expect((await t.api.patch(`/api/hr/employees/${b.id}`, { position: 'Teilzeit-Kraft', status: 'inactive' })).data).toMatchObject({ position: 'Teilzeit-Kraft', status: 'inactive' });
    expect((await t.api.get('/api/hr/employees')).data).toHaveLength(1);
    expect((await t.api.get('/api/hr/employees?status=all')).data).toHaveLength(2);
    expect((await t.api.get('/api/hr/employees?status=inactive&q=Zweit')).data).toHaveLength(1);
  });

  it('links a login only once and only if it belongs to the sub-account', async () => {
    const u = await mkUser('verknuepft@example.com', []);
    const c = await emp({ first_name: 'Vera', last_name: 'Verknüpft', user_id: u.id });
    expect(c.user_id).toBe(u.id);
    expect((await t.api.post('/api/hr/employees', { last_name: 'Doppelt', user_id: u.id })).data.error).toMatch(/anderen Mitarbeiter/);
    expect((await t.api.post('/api/hr/employees', { last_name: 'Fremd', user_id: 'gibtsnicht' })).status).toBe(400);
    expect((await t.api.post('/api/hr/employees', { last_name: 'Kontakt', contact_id: 'gibtsnicht' })).status).toBe(400);
  });
});

describe('absences: request, approval, balance', () => {
  let anna: any;
  let annaUser: { id: string; call: ReturnType<typeof client> };
  let boss: { id: string; call: ReturnType<typeof client> };
  let contactId = '';

  beforeAll(async () => {
    const c = (await t.api.post('/api/contacts', { email: 'abwesend@example.com', first_name: 'Abi', last_name: 'Wesend' })).data;
    contactId = c.id ?? c.contact?.id;
    annaUser = await mkUser('abi@example.com', []);
    boss = await mkUser('chefin@example.com', []);
    anna = await emp({ first_name: 'Abi', last_name: 'Wesend', email: 'abwesend@example.com', user_id: annaUser.id, manager_user_id: boss.id, start_date: '2020-01-01' });
  });

  it('lets an employee request vacation for themselves and nobody else; HR decides', async () => {
    const me = (await annaUser.call('GET', '/api/me/hr')).data;
    expect(me).toMatchObject({ is_hr: false, can_sensitive: false, is_manager: false });
    expect(me.employee).toMatchObject({ name: 'Abi Wesend', vacation_days: 30 });
    expect(me.employee.notes).toBeUndefined();
    expect(me.employee.has_sensitive).toBeUndefined();
    expect(me.balance).toMatchObject({ entitlement: 30 });

    const req = await annaUser.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-05-13', end_date: '2030-05-17', reason: 'Wandern', employee_id: 'egal', approved: true, status: 'approved' });
    expect(req.status, req.text).toBe(200);
    expect(req.data).toMatchObject({ status: 'requested', days: 5, employee_id: anna.id, reason: 'Wandern' });
    await flush();
    expect(events.filter((e) => e.type === 'absence.requested').pop()?.data).toMatchObject({ employeeId: anna.id, contactId, type: 'vacation', days: 5, start_date: '2030-05-13' });

    // The employee has no HR area: cannot decide, cannot even open the HR routes.
    expect((await annaUser.call('POST', `/api/hr/absences/${req.data.id}/approve`, {})).status).toBe(403);
    expect((await annaUser.call('GET', '/api/hr/absences')).status).toBe(403);
    expect((await annaUser.call('POST', `/api/me/hr/absences/${req.data.id}/decide`, { decision: 'approved' })).status).toBe(404);

    const before = (await t.api.get(`/api/hr/employees/${anna.id}/balance?year=2030`)).data.balance;
    expect(before).toMatchObject({ taken: 0, pending: 5, available: 25 });
    const ok = await t.api.post(`/api/hr/absences/${req.data.id}/approve`, { note: 'Viel Spaß' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data).toMatchObject({ status: 'approved', decision_note: 'Viel Spaß' });
    await flush();
    expect(events.filter((e) => e.type === 'absence.approved').pop()?.data).toMatchObject({ employeeId: anna.id, contactId, days: 5 });
    expect((await t.api.get(`/api/hr/employees/${anna.id}/balance?year=2030`)).data.balance).toMatchObject({ taken: 5, pending: 0, remaining: 25, available: 25 });
    expect((await t.api.post(`/api/hr/absences/${req.data.id}/approve`, {})).data.error).toMatch(/schon entschieden/);
    expect((await t.api.post(`/api/hr/absences/${req.data.id}/reject`, {})).status).toBe(400);
  });

  it('refuses vacation beyond the balance, overlaps, empty ranges and requests outside the employment', async () => {
    const r = (b: any) => annaUser.call('POST', '/api/me/hr/absences', b);
    // 30 days a year, 5 taken: 26 more do not fit.
    const tooMuch = await r({ type: 'vacation', start_date: '2030-06-03', end_date: '2030-07-12' });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.data.error).toMatch(/Nicht genug Urlaub 2030: 25 Tage frei/);
    expect((await r({ type: 'vacation', start_date: '2030-05-15', end_date: '2030-05-20' })).data.error).toMatch(/schon eine Abwesenheit/);
    expect((await r({ type: 'vacation', start_date: '2030-05-18', end_date: '2030-05-19' })).data.error).toMatch(/kein Arbeitstag/);
    expect((await r({ type: 'vacation', start_date: '2025-12-25', end_date: '2025-12-26' })).status).toBe(400);
    expect((await r({ type: 'vacation', start_date: '2030-05-20', end_date: '2030-05-17' })).data.error).toMatch(/Ende liegt vor/);
    expect((await r({ type: 'vacation', start_date: '2030-5-20' })).status).toBe(400);
    expect((await r({ type: 'urlaub', start_date: '2030-05-20' })).status).toBe(400);
    expect((await r({ type: 'vacation', start_date: '2030-05-20', end_date: '2032-05-20' })).data.error).toMatch(/ein Jahr/);
    // The past is HR's business; before the start of employment nobody can book.
    expect((await r({ type: 'vacation', start_date: '2020-02-03', end_date: '2020-02-04' })).data.error).toMatch(/Vergangenheit/);
    expect((await t.api.post('/api/hr/absences', { employee_id: anna.id, type: 'vacation', start_date: '2019-12-02', end_date: '2019-12-03' })).data.error).toMatch(/vor dem Eintritt/);
    // Two half days on the same day fit, a third thing does not.
    expect((await r({ type: 'vacation', start_date: '2030-05-20', half_start: true })).status).toBe(200);
    expect((await t.api.post('/api/hr/absences', { employee_id: anna.id, type: 'other', label: 'Arzttermin', start_date: '2030-05-20', half_start: true })).status).toBe(200);
    expect((await t.api.post('/api/hr/absences', { employee_id: anna.id, type: 'other', label: 'Noch was', start_date: '2030-05-20', half_start: true })).data.error).toMatch(/schon eine Abwesenheit/);
    // HR may exceed the balance on purpose.
    const forced = await t.api.post('/api/hr/absences', { employee_id: anna.id, type: 'vacation', start_date: '2030-09-02', end_date: '2030-10-25', force: true });
    expect(forced.status, JSON.stringify(forced.data)).toBe(200);
    expect((await t.api.get(`/api/hr/employees/${anna.id}/balance?year=2030`)).data.balance.available).toBeLessThan(0);
    expect((await t.api.post(`/api/hr/absences/${forced.data.id}/cancel`, {})).status).toBe(200);
    expect((await t.api.post('/api/hr/absences', { employee_id: anna.id, type: 'vacation', start_date: '2030-09-02', end_date: '2030-10-25' })).data.error).toMatch(/Nicht genug Urlaub/);
  });

  it('lets an employee withdraw a request, but not a vacation that has begun; HR can', async () => {
    const own = await annaUser.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-11-04', end_date: '2030-11-05' });
    expect(own.status).toBe(200);
    expect((await annaUser.call('POST', `/api/me/hr/absences/${own.data.id}/cancel`, {})).data.status).toBe('cancelled');
    expect((await annaUser.call('POST', `/api/me/hr/absences/${own.data.id}/cancel`, {})).status).toBe(400);
    const past = await t.api.post('/api/hr/absences', { employee_id: anna.id, type: 'vacation', start_date: '2020-02-03', end_date: '2020-02-04', approved: true });
    expect(past.status, JSON.stringify(past.data)).toBe(200);
    expect(past.data.status).toBe('approved');
    expect((await annaUser.call('POST', `/api/me/hr/absences/${past.data.id}/cancel`, {})).data.error).toMatch(/begonnene/);
    expect((await t.api.post(`/api/hr/absences/${past.data.id}/cancel`, {})).data.status).toBe('cancelled');
    // Somebody else's absence is not even visible through the self-service door.
    const other = await emp({ first_name: 'Fremd', last_name: 'Kollege' });
    const theirs = await t.api.post('/api/hr/absences', { employee_id: other.id, type: 'vacation', start_date: '2030-02-04', end_date: '2030-02-05' });
    expect((await annaUser.call('POST', `/api/me/hr/absences/${theirs.data.id}/cancel`, {})).status).toBe(404);
    expect((await annaUser.call('GET', '/api/me/hr/absences')).data.some((a: any) => a.id === theirs.data.id)).toBe(false);
  });

  it('notes sick leave without a reason, approves it at once and hides it from colleagues', async () => {
    const sick = await annaUser.call('POST', '/api/me/hr/absences', { type: 'sick', start_date: '2030-01-14', end_date: '2030-01-16', reason: 'Grippe mit Fieber', certificate: true });
    expect(sick.status, sick.text).toBe(200);
    expect(sick.data).toMatchObject({ status: 'approved', days: 3, reason: '', certificate: true });
    await flush();
    expect(events.filter((e) => e.type === 'absence.approved').pop()?.data).toMatchObject({ type: 'sick', employeeId: anna.id });
    // Not stored anywhere.
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM hr_absences WHERE reason LIKE '%Grippe%'`)!.n).toBe(0);
    // A colleague sees "abwesend", HR sees the type.
    const colleague = await mkUser('kollege@example.com', []);
    await emp({ first_name: 'Karl', last_name: 'Kollege', user_id: colleague.id });
    const cal = (await colleague.call('GET', '/api/me/hr/calendar?from=2030-01-01&to=2030-01-31')).data;
    const seen = cal.items.find((i: any) => i.employee_id === anna.id && i.start_date === '2030-01-14');
    expect(seen).toMatchObject({ type: 'away', name: 'Abi Wesend' });
    expect(seen.days).toBeUndefined();
    expect(JSON.stringify(cal)).not.toMatch(/sick|Grippe/);
    const hrCal = (await t.api.get('/api/hr/calendar?from=2030-01-01&to=2030-01-31')).data;
    expect(hrCal.items.find((i: any) => i.start_date === '2030-01-14')).toMatchObject({ type: 'sick', days: 3 });
    // Colleagues do not see unapproved requests; the requester sees their own.
    const pending = await annaUser.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-02-11', end_date: '2030-02-12' });
    expect(((await colleague.call('GET', '/api/me/hr/calendar?from=2030-02-01&to=2030-02-28')).data.items as any[]).some((i) => i.start_date === '2030-02-11')).toBe(false);
    expect(((await annaUser.call('GET', '/api/me/hr/calendar?from=2030-02-01&to=2030-02-28')).data.items as any[]).some((i) => i.start_date === '2030-02-11' && i.status === 'requested')).toBe(true);
    await t.api.post(`/api/hr/absences/${pending.data.id}/cancel`, {});
    // Someone who is no employee sees no names at all.
    const stranger = await mkUser('extern@example.com', ['contacts']);
    expect((await stranger.call('GET', '/api/me/hr/calendar?from=2030-01-01&to=2030-01-31')).data.items).toEqual([]);
    expect((await stranger.call('GET', '/api/me/hr')).data).toMatchObject({ employee: null, balance: null });
    expect((await stranger.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-03-11' })).status).toBe(404);
  });

  it('lets the manager approve requests of their reports – but never their own', async () => {
    const req = await annaUser.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-07-01', end_date: '2030-07-02' });
    expect(req.status).toBe(200);
    const list = (await boss.call('GET', '/api/me/hr/approvals')).data;
    expect(list.find((x: any) => x.id === req.data.id)).toMatchObject({ employee_name: 'Abi Wesend', status: 'requested', balance: { entitlement: 30 } });
    expect(list.every((x: any) => x.employee_id === anna.id && x.status === 'requested')).toBe(true);
    expect((await boss.call('GET', '/api/me/hr')).data.is_manager).toBe(true);
    expect((await annaUser.call('GET', '/api/me/hr/approvals')).data).toEqual([]);
    expect((await annaUser.call('POST', `/api/me/hr/absences/${req.data.id}/decide`, { decision: 'approved' })).status).toBe(404);
    expect((await boss.call('POST', `/api/me/hr/absences/${req.data.id}/decide`, { decision: 'maybe' })).status).toBe(400);
    const rejected = await boss.call('POST', `/api/me/hr/absences/${req.data.id}/decide`, { decision: 'rejected', note: 'Projektende' });
    expect(rejected.data).toMatchObject({ status: 'rejected', decision_note: 'Projektende' });
    await flush();
    expect(events.filter((e) => e.type === 'absence.rejected').pop()?.data).toMatchObject({ employeeId: anna.id, contactId });
    // The boss is an employee as well; with HR rights they still may not approve themselves.
    const hrBoss = await mkUser('hr-chef@example.com', ['personal']);
    const mine = await emp({ first_name: 'Hanna', last_name: 'Personal', user_id: hrBoss.id });
    const own = await hrBoss.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-08-05', end_date: '2030-08-06' });
    expect(own.status, own.text).toBe(200);
    const self = await hrBoss.call('POST', `/api/hr/absences/${own.data.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.data.error).toMatch(/nicht selbst/);
    // …another HR person (here the agency admin) can.
    expect((await t.api.post(`/api/hr/absences/${own.data.id}/approve`, {})).status).toBe(200);
    // And HR cannot file a pre-approved absence for themselves.
    const pre = await hrBoss.call('POST', '/api/hr/absences', { employee_id: mine.id, type: 'vacation', start_date: '2030-09-02', approved: true });
    expect(pre.status).toBe(200);
    expect(pre.data.status).toBe('requested');
  });

  it('shows the pro-rata entitlement of a new hire and carry-over with its expiry through the API', async () => {
    const newbie = await emp({ first_name: 'Neu', last_name: 'Eintritt', start_date: '2030-04-01', vacation_days: 30 });
    const bal = (await t.api.get(`/api/hr/employees/${newbie.id}/balance?year=2030`)).data;
    expect(bal.balance).toMatchObject({ entitlement: 23 });
    expect(bal.suggested_carryover).toBeNull();
    // Next year: everything unused is suggested, capped by the setting.
    const next = (await t.api.get(`/api/hr/employees/${newbie.id}/balance?year=2031`)).data;
    expect(next.suggested_carryover).toBe(23);
    expect((await t.api.put('/api/hr/settings', { carryover_max_days: 10 })).data.carryover_max_days).toBe(10);
    expect((await t.api.get(`/api/hr/employees/${newbie.id}/balance?year=2031`)).data.suggested_carryover).toBe(10);
    const set = await t.api.put(`/api/hr/employees/${newbie.id}/leave-years/2031`, { carryover_days: 10, adjustment_days: -1, note: 'Übertrag aus 2030' });
    expect(set.data.balance).toMatchObject({ entitlement: 30, carryover: 10, adjustment: -1, carryover_expires: '2031-03-31', remaining: 39 });
    expect((await t.api.put(`/api/hr/employees/${newbie.id}/leave-years/2031`, { carryover_days: -3 })).status).toBe(400);
    expect((await t.api.put(`/api/hr/employees/${newbie.id}/leave-years/1999`, { carryover_days: 1 })).status).toBe(400);
    // An absence before the start date is refused.
    expect((await t.api.post('/api/hr/absences', { employee_id: newbie.id, type: 'vacation', start_date: '2030-03-25', end_date: '2030-03-26' })).data.error).toMatch(/vor dem Eintritt/);
    // Setting the limit back for the following tests.
    await t.api.put('/api/hr/settings', { carryover_max_days: null });
  });

  it('starts a workflow when an absence is approved', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Urlaub bestätigt', trigger: { type: 'absence.approved', config: {} }, steps: [{ type: 'add_tag', tags: ['urlaub-ok'] }] })).data;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const req = await annaUser.call('POST', '/api/me/hr/absences', { type: 'vacation', start_date: '2030-12-02', end_date: '2030-12-03' });
    await t.api.post(`/api/hr/absences/${req.data.id}/approve`, {});
    await flush();
    await flush();
    const c = (await t.api.get(`/api/contacts/${contactId}`)).data;
    expect((c.tags ?? c.contact?.tags) as string[]).toContain('urlaub-ok');
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.triggers).toEqual(expect.arrayContaining(['absence.requested', 'absence.approved', 'absence.rejected']));
  });

  it('changes an absence (dates, type) and re-checks it; lists with filters', async () => {
    const e = await emp({ first_name: 'Ändere', last_name: 'Mich' });
    const a = (await t.api.post('/api/hr/absences', { employee_id: e.id, type: 'vacation', start_date: '2030-03-11', end_date: '2030-03-12' })).data;
    expect(a.days).toBe(2);
    expect((await t.api.patch(`/api/hr/absences/${a.id}`, { end_date: '2030-03-13' })).data).toMatchObject({ days: 3, status: 'requested' });
    expect((await t.api.patch(`/api/hr/absences/${a.id}`, { type: 'sick' })).data).toMatchObject({ type: 'sick', reason: '' });
    expect((await t.api.patch(`/api/hr/absences/${a.id}`, { end_date: '2030-03-01' })).status).toBe(400);
    const list = (await t.api.get(`/api/hr/absences?employee_id=${e.id}&from=2030-03-01&to=2030-03-31`)).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ employee_name: 'Ändere Mich', can_decide: true });
    expect((await t.api.get('/api/hr/absences?status=requested&type=vacation')).data.every((x: any) => x.status === 'requested' && x.type === 'vacation')).toBe(true);
    await t.api.post(`/api/hr/absences/${a.id}/cancel`, {});
    expect((await t.api.patch(`/api/hr/absences/${a.id}`, { end_date: '2030-03-14' })).status).toBe(400);
  });
});

describe('holidays and working-time overview', () => {
  it('serves the holidays of a Bundesland, the team calendar with them and the settings', async () => {
    const h = (await t.api.get('/api/hr/holidays?year=2030&state=BY')).data;
    expect(h.state).toBe('BY');
    expect(h.holidays.map((x: any) => x.date)).toContain('2030-01-06');
    expect((await t.api.get('/api/hr/holidays?year=2030&state=XX')).status).toBe(400);
    expect((await t.api.put('/api/hr/settings', { default_state: 'NW' })).data.default_state).toBe('NW');
    const cal = (await t.api.get('/api/hr/calendar?from=2030-06-01&to=2030-06-30')).data;
    expect(cal.state).toBe('NW');
    expect(cal.holidays.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Pfingstmontag', 'Fronleichnam']));
    expect((await t.api.put('/api/hr/settings', { default_state: 'BE' })).data.default_state).toBe('BE');
    expect((await t.api.put('/api/hr/settings', { default_state: 'Berlin' })).status).toBe(400);
    expect((await t.api.put('/api/hr/settings', { carryover_expiry: '13-45' })).status).toBe(400);
    expect((await t.api.put('/api/hr/settings', { default_vacation_days: 99 })).status).toBe(400);
    expect((await t.api.get('/api/hr/calendar?from=2030-06-30&to=2030-06-01')).status).toBe(400);
    expect((await t.api.get('/api/hr/calendar?from=2030-01-01&to=2035-01-01')).status).toBe(400);
  });

  it('gives time tracking the target hours and absences, and shows tracked hours when a provider is connected', async () => {
    const u = await mkUser('zeit@example.com', []);
    const e = await emp({ first_name: 'Zeit', last_name: 'Erfasser', user_id: u.id, weekly_hours: 40, start_date: '2020-01-01' });
    const week = '?from=2030-06-03&to=2030-06-07';
    const overview = async () => ((await t.api.get(`/api/hr/working-time${week}`)).data.employees as any[]).find((x) => x.employee_id === e.id);
    // The project planner (backoffice-time.ts) connects itself; take it away to see the overview without any time tracking.
    const planner = t.app.services.workingTimeProvider;
    delete t.app.services.workingTimeProvider;
    expect((await t.api.get(`/api/hr/working-time${week}`)).data.tracking_connected).toBe(false);
    expect(await overview()).toMatchObject({ target_hours: 40, tracked_hours: null, balance_hours: null, vacation_days: 0 });
    const v = (await t.api.post('/api/hr/absences', { employee_id: e.id, type: 'vacation', start_date: '2030-06-04', end_date: '2030-06-05', approved: true })).data;
    expect(v.status).toBe('approved');
    expect(await overview()).toMatchObject({ target_hours: 24, vacation_days: 2 });
    // The week of Pfingstmontag has one holiday less to work.
    const pent = ((await t.api.get('/api/hr/working-time?from=2030-06-10&to=2030-06-14')).data.employees as any[]).find((x) => x.employee_id === e.id);
    expect(pent).toMatchObject({ target_hours: 32, holidays: 1 });
    // Hooks for the time-tracking module.
    const abs = t.app.services.absences;
    expect(abs.forUser(loc, u.id, '2030-06-03', '2030-06-07')).toEqual([
      { date: '2030-06-04', type: 'vacation', value: 1 },
      { date: '2030-06-05', type: 'vacation', value: 1 },
    ]);
    expect(abs.forUser(loc, u.id, '2030-06-10', '2030-06-10')).toEqual([{ date: '2030-06-10', type: 'holiday', value: 1, name: 'Pfingstmontag' }]);
    expect(abs.targetHours(loc, u.id, '2030-06-03', '2030-06-07')).toBe(24);
    expect(abs.targetHours(loc, 'niemand', '2030-06-03', '2030-06-07')).toBeNull();
    // A part-time person: 20 hours over Monday, Wednesday, Friday.
    const part = await emp({ first_name: 'Teil', last_name: 'Zeit', weekly_hours: 20, work_days: [1, 3, 5], start_date: '2020-01-01' });
    const po = ((await t.api.get(`/api/hr/working-time${week}`)).data.employees as any[]).find((x) => x.employee_id === part.id);
    expect(po.target_hours).toBe(20);
    // A connected provider fills the tracked hours.
    t.app.services.workingTimeProvider = { hoursByUser: (l: string) => (l === loc ? { [u.id]: 20 } : {}) };
    try {
      const r = (await t.api.get(`/api/hr/working-time${week}`)).data;
      expect(r.tracking_connected).toBe(true);
      expect(r.employees.find((x: any) => x.employee_id === e.id)).toMatchObject({ target_hours: 24, tracked_hours: 20, balance_hours: -4 });
      expect(r.employees.find((x: any) => x.employee_id === part.id).tracked_hours).toBeNull();
    } finally {
      if (planner) t.app.services.workingTimeProvider = planner;
      else delete t.app.services.workingTimeProvider;
    }
    expect((await t.api.get('/api/hr/working-time?from=2030-01-01&to=2036-01-01')).status).toBe(400);
  });

  it('takes the tracked hours from the project planner: per local day, finished and not rejected entries only, never across sub-accounts', async () => {
    const provider = t.app.services.workingTimeProvider;
    expect(provider?.hoursByUser).toBeTypeOf('function');
    const u = await mkUser('plan-zeit@example.com', ['contacts']);
    const e = await emp({ first_name: 'Plan', last_name: 'Zeiterfasser', user_id: u.id, weekly_hours: 40, start_date: '2020-01-01' });
    const add = async (body: Record<string, unknown>) => {
      const r = await t.api.post('/api/pm/time', { user_id: u.id, ...body });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      return r.data;
    };
    await add({ minutes: 90, date: '2026-09-14', note: 'Montag' });
    const rejected = await add({ minutes: 120, date: '2026-09-15', note: 'abgelehnt' });
    await add({ minutes: 150, date: '2026-09-16', billable: false });
    await add({ minutes: 60, date: '2026-09-21', note: 'nächste Woche' });
    t.app.db.run(`UPDATE pm_time_entries SET approval = 'rejected' WHERE id = ?`, rejected.id);
    const week = '?from=2026-09-14&to=2026-09-18';
    const r = (await t.api.get(`/api/hr/working-time${week}`)).data;
    expect(r.tracking_connected).toBe(true);
    expect(r.employees.find((x: any) => x.employee_id === e.id)).toMatchObject({ target_hours: 40, tracked_hours: 4, balance_hours: -36 });
    // One day is enough (a day-only entry sits at local midnight, which is the evening before in UTC).
    expect(provider.hoursByUser(loc, '2026-09-14', '2026-09-14')).toEqual({ [u.id]: 1.5 });
    expect(provider.hoursByUser(loc, '2026-09-13', '2026-09-13')).toEqual({});
    expect(provider.hoursByUser(loc, '2026-09-14', '2026-09-27')).toEqual({ [u.id]: 5 });
    // A running timer is not tracked time yet.
    t.app.db.run(`UPDATE pm_time_entries SET ended_at = NULL WHERE user_id = ? AND started_at LIKE '2026-09-20%'`, u.id);
    expect(provider.hoursByUser(loc, '2026-09-14', '2026-09-27')).toEqual({ [u.id]: 5 });
    // Another sub-account never sees these hours; bad ranges answer with nothing.
    expect(provider.hoursByUser('anderes-projekt', '2026-09-14', '2026-09-27')).toEqual({});
    expect(provider.hoursByUser(loc, '2026-09-18', '2026-09-14')).toEqual({});
    expect(provider.hoursByUser(loc, 'gestern', '2026-09-14')).toEqual({});
  });
});

describe('onboarding and offboarding checklists', () => {
  it('seeds standard templates once, starts a checklist with due dates and completes it', async () => {
    const tpl = (await t.api.get('/api/hr/checklist-templates')).data;
    expect(tpl.templates.map((x: any) => x.kind).sort()).toEqual(['offboarding', 'onboarding']);
    expect((await t.api.get('/api/hr/checklist-templates')).data.templates).toHaveLength(2);
    const onboarding = tpl.templates.find((x: any) => x.kind === 'onboarding');
    expect(onboarding.items.length).toBeGreaterThanOrEqual(6);

    const u = await mkUser('neustart@example.com', []);
    const e = await emp({ first_name: 'Neu', last_name: 'Start', user_id: u.id, start_date: '2030-09-02' });
    const cl = await t.api.post('/api/hr/checklists', { employee_id: e.id, template_id: onboarding.id });
    expect(cl.status, JSON.stringify(cl.data)).toBe(200);
    expect(cl.data).toMatchObject({ kind: 'onboarding', status: 'open' });
    const first = cl.data.items[0];
    expect(first.due).toBe('2030-08-26'); // 7 days before the start date
    expect(cl.data.items.every((i: any) => !i.done)).toBe(true);

    // The employee ticks only their own points.
    const mine = cl.data.items.find((i: any) => i.assignee === 'employee');
    const hrItem = cl.data.items.find((i: any) => i.assignee === 'hr');
    const own = (await u.call('GET', '/api/me/hr/checklists')).data;
    expect(own).toHaveLength(1);
    expect((await u.call('POST', `/api/me/hr/checklists/${cl.data.id}/items/${hrItem.id}`, { done: true })).status).toBe(403);
    const ticked = await u.call('POST', `/api/me/hr/checklists/${cl.data.id}/items/${mine.id}`, { done: true });
    expect(ticked.status).toBe(200);
    expect(ticked.data.items.find((i: any) => i.id === mine.id)).toMatchObject({ done: true, done_by: 'neustart' });
    for (const it of cl.data.items) await t.api.post(`/api/hr/checklists/${cl.data.id}/items/${it.id}`, { done: true });
    const done = (await t.api.get(`/api/hr/checklists?employee_id=${e.id}`)).data[0];
    expect(done.status).toBe('done');
    expect(done.completed_at).toBeTruthy();
    expect((await t.api.post(`/api/hr/checklists/${cl.data.id}/items/${first.id}`, { done: false })).data.status).toBe('open');
    expect((await t.api.post(`/api/hr/checklists/${cl.data.id}/items/nope`, { done: true })).status).toBe(404);

    // Offboarding counts from the end date.
    const off = tpl.templates.find((x: any) => x.kind === 'offboarding');
    const leaver = await emp({ first_name: 'Geh', last_name: 'Weg', start_date: '2020-01-01', end_date: '2030-12-31' });
    const ocl = await t.api.post('/api/hr/checklists', { employee_id: leaver.id, template_id: off.id });
    expect(ocl.data.items[0].due).toBe('2030-12-01'); // 30 days before the end
    expect(ocl.data.items.find((i: any) => i.title.startsWith('Arbeitszeugnis')).due).toBe('2031-01-14');
    expect((await t.api.post('/api/hr/checklists', { employee_id: leaver.id, template_id: 'gibtsnicht' })).status).toBe(400);
  });

  it('edits templates and validates them', async () => {
    const mk = await t.api.post('/api/hr/checklist-templates', { kind: 'onboarding', name: 'Werkstudent', items: [{ title: 'Schlüssel', assignee: 'it', due_days: 0 }, { title: 'Vertrag', assignee: 'chef', due_days: -3 }] });
    expect(mk.status, JSON.stringify(mk.data)).toBe(200);
    expect(mk.data.items[1].assignee).toBe('hr'); // unknown assignee falls back
    expect((await t.api.post('/api/hr/checklist-templates', { kind: 'sonstiges', name: 'x', items: [{ title: 'a' }] })).status).toBe(400);
    expect((await t.api.post('/api/hr/checklist-templates', { kind: 'onboarding', name: 'x', items: [] })).status).toBe(400);
    expect((await t.api.post('/api/hr/checklist-templates', { kind: 'onboarding', name: 'x', items: [{ title: '' }] })).status).toBe(400);
    expect((await t.api.patch(`/api/hr/checklist-templates/${mk.data.id}`, { name: 'Werkstudent/in' })).data.name).toBe('Werkstudent/in');
    expect((await t.api.del(`/api/hr/checklist-templates/${mk.data.id}`)).status).toBe(200);
    expect((await t.api.del(`/api/hr/checklist-templates/${mk.data.id}`)).status).toBe(404);
    // Deleting the standard ones does not bring them back.
    const all = (await t.api.get('/api/hr/checklist-templates')).data.templates;
    for (const x of all) await t.api.del(`/api/hr/checklist-templates/${x.id}`);
    expect((await t.api.get('/api/hr/checklist-templates')).data.templates).toEqual([]);
  });
});

describe('sensitive fields, documents and access control', () => {
  let emp1: any;
  let hrOnly: { id: string; call: ReturnType<typeof client> };
  let hrTrusted: { id: string; call: ReturnType<typeof client> };
  let staff: { id: string; call: ReturnType<typeof client> };
  const SALARY = 4_875_00;
  const IBAN = 'DE89370400440532013000';

  beforeAll(async () => {
    hrOnly = await mkUser('hr-ohne-gehalt@example.com', ['personal']);
    hrTrusted = await mkUser('hr-mit-gehalt@example.com', ['personal']);
    staff = await mkUser('mitarbeiter@example.com', []);
    emp1 = await emp({ first_name: 'Gerda', last_name: 'Gehalt', email: 'gerda@example.com', user_id: staff.id, notes: 'Interne Notiz: Gehaltsgespräch im Herbst' });
  });

  it('seals salary and bank data, gives them to admins only at first and logs every read', async () => {
    const put = await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { salary_cents: SALARY, salary_period: 'month', iban: 'DE89 3704 0044 0532 0130 00', tax_id: '12345678901', social_security_no: '12 010190 M 123', tax_class: 'III', birth_date: '1990-01-01' });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect(put.data.fields).toEqual(expect.arrayContaining(['salary_cents', 'iban', 'tax_id', 'birth_date']));
    const got = (await t.api.get(`/api/hr/employees/${emp1.id}/sensitive`)).data;
    expect(got).toMatchObject({ salary_cents: SALARY, salary_period: 'month', iban: IBAN, tax_id: '12345678901', birth_date: '1990-01-01' });
    // Sealed in the database: neither the salary nor the IBAN is readable there.
    const raw = t.app.db.get<any>('SELECT sensitive FROM hr_employees WHERE id = ?', emp1.id)!.sensitive as string;
    expect(raw).toMatch(/^v[12]:/);
    expect(raw).not.toContain(String(SALARY));
    expect(raw).not.toContain(IBAN);
    // Single fields can be changed or removed without touching the rest.
    expect((await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { salary_cents: SALARY + 100_00, tax_class: '' })).status).toBe(200);
    const again = (await t.api.get(`/api/hr/employees/${emp1.id}/sensitive`)).data;
    expect(again.salary_cents).toBe(SALARY + 100_00);
    expect(again.tax_class).toBeUndefined();
    expect(again.iban).toBe(IBAN);
    // Validation.
    expect((await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { iban: 'DE00' })).data.error).toMatch(/IBAN/);
    expect((await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { tax_id: '123' })).data.error).toMatch(/11 Ziffern/);
    expect((await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { salary_cents: -5 })).status).toBe(400);
    expect((await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { salary_period: 'woche' })).status).toBe(400);
    expect((await t.api.put(`/api/hr/employees/${emp1.id}/sensitive`, { birth_date: '31.12.1990' })).status).toBe(400);
    // The audit trail has who looked, never the values.
    const log = t.app.db.all<any>(`SELECT * FROM audit_log WHERE action LIKE 'hr.sensitive%'`);
    expect(log.some((l) => l.action === 'hr.sensitive.read' && l.entity_id === emp1.id)).toBe(true);
    expect(log.some((l) => l.action === 'hr.sensitive.update')).toBe(true);
    expect(JSON.stringify(log)).not.toContain(String(SALARY));
    expect(JSON.stringify(log)).not.toContain(IBAN);
  });

  it('never leaks the sensitive block through lists, details, self-service, the calendar or the audit log', async () => {
    const dumps = [
      JSON.stringify((await t.api.get('/api/hr/employees')).data),
      JSON.stringify((await t.api.get(`/api/hr/employees/${emp1.id}`)).data),
      JSON.stringify((await staff.call('GET', '/api/me/hr')).data),
      JSON.stringify((await hrOnly.call('GET', `/api/hr/employees/${emp1.id}`)).data),
      JSON.stringify((await t.api.get('/api/hr/calendar')).data),
      JSON.stringify((await t.api.get('/api/hr/working-time')).data),
      JSON.stringify((await t.api.get('/api/hr/status')).data),
    ];
    for (const d of dumps) {
      expect(d).not.toContain(IBAN);
      expect(d).not.toContain('12345678901');
      expect(d).not.toContain(String(SALARY));
      expect(d).not.toContain('salary');
    }
    expect((await t.api.get(`/api/hr/employees/${emp1.id}`)).data.has_sensitive).toBe(true);
    // The employee's own view has contract data but not the internal notes.
    const own = (await staff.call('GET', '/api/me/hr')).data.employee;
    expect(own.name).toBe('Gerda Gehalt');
    expect(JSON.stringify(own)).not.toContain('Interne Notiz');
  });

  it('keeps the sensitive block from HR staff that are not listed, from API keys and from everybody else', async () => {
    // HR staff with the area but not on the list: employee data yes, sensitive block no.
    expect((await hrOnly.call('GET', '/api/hr/employees')).status).toBe(200);
    expect((await hrOnly.call('GET', `/api/hr/employees/${emp1.id}`)).status).toBe(200);
    const denied = await hrOnly.call('GET', `/api/hr/employees/${emp1.id}/sensitive`);
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/Sensible Daten/);
    expect((await hrOnly.call('PUT', `/api/hr/employees/${emp1.id}/sensitive`, { salary_cents: 1 })).status).toBe(403);
    expect((await hrOnly.call('POST', '/api/hr/employees', { last_name: 'Mit Gehalt', sensitive: { salary_cents: 1 } })).status).toBe(403);
    expect((await hrOnly.call('PUT', '/api/hr/settings', { sensitive_user_ids: [hrOnly.id] })).status).toBe(403);
    expect((await hrOnly.call('DELETE', `/api/hr/employees/${emp1.id}`)).status).toBe(403);
    expect((await hrOnly.call('GET', '/api/hr/settings')).data.sensitive_user_ids).toEqual([]);
    // The employee, a plain member and "all areas" members stay out of the HR routes altogether.
    for (const who of [staff, await mkUser('alles@example.com', null), await mkUser('vertrieb2@example.com', ['contacts', 'payments'])]) {
      for (const path of ['/api/hr/employees', `/api/hr/employees/${emp1.id}`, `/api/hr/employees/${emp1.id}/sensitive`, '/api/hr/absences', '/api/hr/calendar', '/api/hr/working-time', '/api/hr/settings', '/api/hr/checklists']) {
        const r = await who.call('GET', path);
        expect(r.status, path).toBe(403);
        expect(r.data.error, path).toMatch(/Personal/);
      }
      expect((await who.call('PATCH', `/api/hr/employees/${emp1.id}`, { position: 'Chef' })).status).toBe(403);
      expect((await who.call('POST', '/api/hr/absences', { employee_id: emp1.id, type: 'vacation', start_date: '2030-02-04' })).status).toBe(403);
    }
    // A sub-account API key (and with it MCP) is no person and never sees the sensitive block.
    const key = (await t.api.post('/api/api-keys', { name: 'Integration' })).data.key;
    const viaKey = (method: string, path: string, body?: unknown) => t.api.raw(path, { method, headers: { authorization: `Bearer ${key}`, 'x-location-id': loc, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await viaKey('GET', '/api/hr/employees')).status).toBe(200);
    expect((await viaKey('GET', `/api/hr/employees/${emp1.id}/sensitive`)).status).toBe(403);
    expect((await viaKey('PUT', `/api/hr/employees/${emp1.id}/sensitive`, { salary_cents: 1 })).status).toBe(403);
  });

  it('lets an admin allow selected HR people for the sensitive block – and only logins of this sub-account', async () => {
    expect((await t.api.put('/api/hr/settings', { sensitive_user_ids: ['unbekannt'] })).status).toBe(400);
    const ok = await t.api.put('/api/hr/settings', { sensitive_user_ids: [hrTrusted.id] });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.sensitive_user_ids).toEqual([hrTrusted.id]);
    const trusted = await hrTrusted.call('GET', `/api/hr/employees/${emp1.id}/sensitive`);
    expect(trusted.status, trusted.text).toBe(200);
    expect(trusted.data.salary_cents).toBe(SALARY + 100_00);
    expect((await hrTrusted.call('GET', '/api/hr/access')).data).toMatchObject({ hr: true, sensitive: true });
    expect((await hrOnly.call('GET', '/api/hr/access')).data).toMatchObject({ hr: true, sensitive: false });
    expect((await hrOnly.call('GET', `/api/hr/employees/${emp1.id}/sensitive`)).status).toBe(403);
    // Being on the list without the area opens nothing.
    expect((await t.api.put('/api/hr/settings', { sensitive_user_ids: [hrTrusted.id, staff.id] })).status).toBe(200);
    expect((await staff.call('GET', `/api/hr/employees/${emp1.id}/sensitive`)).status).toBe(403);
    expect((await staff.call('GET', '/api/me/hr')).data.can_sensitive).toBe(false);
    // The trusted person may hand the right on; the others still cannot.
    expect((await hrTrusted.call('PUT', '/api/hr/settings', { sensitive_user_ids: [hrTrusted.id, hrOnly.id] })).status).toBe(200);
    expect((await hrOnly.call('GET', `/api/hr/employees/${emp1.id}/sensitive`)).status).toBe(200);
    await t.api.put('/api/hr/settings', { sensitive_user_ids: [hrTrusted.id] });
    expect((await hrOnly.call('GET', `/api/hr/employees/${emp1.id}/sensitive`)).status).toBe(403);
  });

  it('archives documents with a hash and shows each person only what they may see', async () => {
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');
    const up = async (b: any, who: any = t.api) => (typeof who === 'function' ? who('POST', `/api/hr/employees/${emp1.id}/documents`, b) : who.post(`/api/hr/employees/${emp1.id}/documents`, b));
    const contract = await up({ name: 'Arbeitsvertrag.pdf', data: pdf, category: 'vertrag', visibility: 'sensitive' });
    expect(contract.status, JSON.stringify(contract.data)).toBe(200);
    expect(contract.data).toMatchObject({ category: 'vertrag', visibility: 'sensitive', mime: 'application/pdf' });
    expect(contract.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    const letter = (await up({ name: 'Bescheinigung.pdf', data: pdf, category: 'bescheinigung', visibility: 'employee' })).data;
    const internal = (await up({ name: 'Notiz.pdf', data: pdf })).data;
    expect(internal.visibility).toBe('hr');

    // Untrusted HR: sensitive documents are hidden and cannot be opened, uploaded or deleted.
    const listOnly = (await hrOnly.call('GET', `/api/hr/employees/${emp1.id}/documents`)).data;
    expect(listOnly.map((d: any) => d.id).sort()).toEqual([letter.id, internal.id].sort());
    expect((await hrOnly.call('GET', `/api/hr/documents/${contract.data.id}`)).status).toBe(403);
    expect((await hrOnly.call('DELETE', `/api/hr/documents/${contract.data.id}`)).status).toBe(403);
    expect((await up({ name: 'Gehalt.pdf', data: pdf, visibility: 'sensitive' }, hrOnly.call)).status).toBe(403);
    const listTrusted = (await hrTrusted.call('GET', `/api/hr/employees/${emp1.id}/documents`)).data;
    expect(listTrusted).toHaveLength(3);
    const file = await t.api.raw(`/api/hr/documents/${contract.data.id}`, { headers: { cookie: t.api.cookie, 'x-location-id': loc } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await file.arrayBuffer()).toString().startsWith('%PDF')).toBe(true);

    // The employee sees only what was shared with them – nothing of the others' records.
    const own = (await staff.call('GET', '/api/me/hr/documents')).data;
    expect(own.map((d: any) => d.id)).toEqual([letter.id]);
    expect((await staff.call('GET', `/api/me/hr/documents/${letter.id}`)).status).toBe(200);
    expect((await staff.call('GET', `/api/me/hr/documents/${internal.id}`)).status).toBe(404);
    expect((await staff.call('GET', `/api/me/hr/documents/${contract.data.id}`)).status).toBe(404);
    const colleague = await mkUser('fremder-mitarbeiter@example.com', []);
    await emp({ first_name: 'Frank', last_name: 'Fremd', user_id: colleague.id });
    expect((await colleague.call('GET', `/api/me/hr/documents/${letter.id}`)).status).toBe(404);
    expect((await colleague.call('GET', '/api/me/hr/documents')).data).toEqual([]);

    // Uploads are checked.
    expect((await up({ name: 'x.pdf', data: 'kein data url' })).status).toBe(400);
    expect((await up({ name: 'fake.pdf', data: 'data:application/pdf;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64') })).data.error).toMatch(/passt nicht/);
    expect((await up({ name: 'x.exe', data: 'data:application/x-msdownload;base64,TVo=' })).data.error).toMatch(/Nur PDF/);
    expect((await up({ name: 'leer.pdf', data: 'data:application/pdf;base64,' })).status).toBe(400);
    expect((await t.api.del(`/api/hr/documents/${internal.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/hr/documents/${internal.id}`)).status).toBe(404);
  });

  it('deletes an employee only when left, by the trusted people, with the files gone', async () => {
    const e = await emp({ first_name: 'Weg', last_name: 'Damit' });
    const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
    const d = (await t.api.post(`/api/hr/employees/${e.id}/documents`, { name: 'a.pdf', data: pdf })).data;
    expect((await t.api.del(`/api/hr/employees/${e.id}`)).data.error).toMatch(/ausgeschieden/);
    await t.api.patch(`/api/hr/employees/${e.id}`, { status: 'inactive' });
    expect((await hrTrusted.call('DELETE', `/api/hr/employees/${e.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/hr/employees/${e.id}`)).status).toBe(404);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM hr_documents WHERE id = ?', d.id)!.n).toBe(0);
  });

  it('keeps sub-accounts apart', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
    const h = { 'x-location-id': other };
    expect((await t.api.get('/api/hr/employees', h)).data).toEqual([]);
    expect((await t.api.get(`/api/hr/employees/${emp1.id}`, h)).status).toBe(404);
    expect((await t.api.get(`/api/hr/employees/${emp1.id}/sensitive`, h)).status).toBe(404);
    expect((await t.api.get(`/api/hr/employees/${emp1.id}/balance`, h)).status).toBe(404);
    expect((await t.api.post('/api/hr/absences', { employee_id: emp1.id, type: 'vacation', start_date: '2030-02-04' }, h)).status).toBe(404);
    expect((await t.api.post('/api/hr/checklists', { employee_id: emp1.id, template_id: 'x' }, h)).status).toBe(404);
    const abs = t.app.db.get<any>('SELECT id FROM hr_absences LIMIT 1')!;
    expect((await t.api.post(`/api/hr/absences/${abs.id}/approve`, {}, h)).status).toBe(404);
    expect((await t.api.get('/api/hr/absences', h)).data).toEqual([]);
    expect((await t.api.get('/api/hr/checklist-templates', h)).data.templates).toHaveLength(2); // its own, freshly seeded
    expect((await t.api.post('/api/hr/employees', { last_name: 'Fremd', user_id: hrTrusted.id }, h)).status).toBe(400);
    // Another sub-account's contact or manager cannot be linked.
    const foreign = (await t.api.post('/api/contacts', { email: 'fremd-hr@example.com', first_name: 'F' }, h)).data;
    expect((await t.api.post('/api/hr/employees', { last_name: 'X', contact_id: foreign.id ?? foreign.contact?.id })).status).toBe(400);
    t.app.db.run('DELETE FROM locations WHERE id = ?', other);
  });

  it('only unlinks the contact when it is erased (employees are HR data, not CRM data)', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'mitarbeiter-kontakt@example.com', first_name: 'Mia' })).data;
    const cid = c.id ?? c.contact?.id;
    const e = await emp({ first_name: 'Mia', last_name: 'Kontakt', contact_id: cid });
    expect((await t.api.post(`/api/contacts/${cid}/erase`, { confirm: 'mitarbeiter-kontakt@example.com' })).status).toBe(200);
    const after = (await t.api.get(`/api/hr/employees/${e.id}`)).data;
    expect(after.contact_id).toBeNull();
    expect(after.name).toBe('Mia Kontakt');
  });
});

describe('MCP tool', () => {
  it('files an absence request through the agent tool, by employee or e-mail, and checks the rules', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Claude HR' })).data.key;
    const rpc = async (name: string, args: any = {}) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const j: any = await r.json();
      const text = j.result?.content?.[0]?.text;
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      return { data, text, isError: j.result?.isError };
    };
    const list = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = ((await list.json()) as any).result.tools.map((x: any) => x.name);
    expect(names).toContain('ghl_create_absence_request');
    const e = await emp({ first_name: 'Mara', last_name: 'Mcp', email: 'mara.mcp@example.com', start_date: '2020-01-01' });
    const byEmail = await rpc('ghl_create_absence_request', { email: 'MARA.MCP@example.com', type: 'vacation', start_date: '2030-05-13', end_date: '2030-05-15' });
    expect(byEmail.isError, byEmail.text).toBeFalsy();
    expect(byEmail.data).toMatchObject({ employee_id: e.id, status: 'requested', days: 3 });
    const byId = await rpc('ghl_create_absence_request', { employee_id: e.id, type: 'other', label: 'Umzug', start_date: '2030-06-03' });
    expect(byId.data).toMatchObject({ type: 'other', label: 'Umzug', status: 'requested', days: 1 });
    // The agent cannot approve, force or skip the checks.
    expect((await rpc('ghl_create_absence_request', { employee_id: e.id, type: 'vacation', start_date: '2030-05-14', end_date: '2030-05-16' })).isError).toBe(true);
    expect((await rpc('ghl_create_absence_request', { email: 'niemand@example.com', type: 'vacation', start_date: '2030-05-14' })).text).toMatch(/Kein Mitarbeiter/);
    expect((await rpc('ghl_create_absence_request', { employee_id: e.id, type: 'sick', start_date: '2030-06-11', reason: 'Diagnose' })).data).toMatchObject({ status: 'approved', reason: '' });
    // Without an employee and without a login behind the key there is nobody to file it for.
    expect((await rpc('ghl_create_absence_request', { type: 'vacation', start_date: '2030-05-14' })).isError).toBe(true);
  });
});
