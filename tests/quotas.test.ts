import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPeriod, paceOf, periodRange, periodStart, progress, rank, shiftPeriod } from '../server/services/quotas.js';
import { startTestApp } from './helpers.js';

/**
 * Quotas and the leaderboard: the calendar rules (month, quarter, the sub-account's zone), attainment from won deals per owner and
 * team, who may see whose numbers, copying last period's targets and the two board widgets.
 */

describe('periods', () => {
  it('start of the month or quarter, wrapping the year', () => {
    expect(periodStart('month', '2026-10-17')).toBe('2026-10-01');
    expect(periodStart('quarter', '2026-10-17')).toBe('2026-10-01');
    expect(periodStart('quarter', '2026-08-31')).toBe('2026-07-01');
    expect(periodStart('quarter', '2026-03-31')).toBe('2026-01-01');
    expect(shiftPeriod('month', '2026-12-01', 1)).toBe('2027-01-01');
    expect(shiftPeriod('month', '2026-01-01', -1)).toBe('2025-12-01');
    expect(shiftPeriod('quarter', '2026-10-01', 1)).toBe('2027-01-01');
    expect(shiftPeriod('quarter', '2026-01-01', -2)).toBe('2025-07-01');
  });

  it('is counted in the sub-account’s calendar: a deal won at 23:30 UTC on the 31st is November in Berlin', () => {
    const oct = periodRange('month', '2026-10-01', 'Europe/Berlin');
    expect(oct).toMatchObject({ label: 'Oktober 2026', start: '2026-10-01', end: '2026-11-01', startUtc: '2026-09-30T22:00:00.000Z', endUtc: '2026-10-31T23:00:00.000Z' });
    expect('2026-10-31T23:30:00Z' >= oct.endUtc).toBe(true);
    expect(periodRange('quarter', '2026-10-01', 'Europe/Berlin').label).toBe('Q4 2026');
    expect(currentPeriod('month', new Date('2026-10-31T23:30:00Z'), 'Europe/Berlin').start).toBe('2026-11-01');
    expect(currentPeriod('month', new Date('2026-10-31T23:30:00Z'), 'UTC').start).toBe('2026-10-01');
  });

  it('progress and pace', () => {
    const r = periodRange('month', '2026-11-01', 'Europe/Berlin');
    expect(progress(r, new Date('2026-11-15T23:00:00Z'))).toMatchObject({ elapsed_pct: 50, days_left: 15, days_total: 30 });
    expect(progress(r, new Date('2026-10-01T00:00:00Z')).elapsed_pct).toBe(0);
    expect(progress(r, new Date('2027-01-01T00:00:00Z'))).toMatchObject({ elapsed_pct: 100, days_left: 0 });
    expect(paceOf(null, 50)).toBe('none');
    expect(paceOf(100, 40)).toBe('reached');
    expect(paceOf(120, 50)).toBe('reached');
    expect(paceOf(60, 50)).toBe('ahead'); // 1.2
    expect(paceOf(50, 50)).toBe('on_track');
    expect(paceOf(44, 50)).toBe('on_track'); // 0.88
    expect(paceOf(30, 50)).toBe('behind');
    expect(paceOf(0, 0)).toBe('on_track');
    expect(paceOf(80, 100)).toBe('closed');
  });

  it('competition ranking: equal figures share a place', () => {
    const rows = [{ achieved: 5, attainment_pct: 50 }, { achieved: 9, attainment_pct: 90 }, { achieved: 5, attainment_pct: 80 }, { achieved: 1, attainment_pct: null }];
    expect(rank(rows).map((r) => [r.achieved, r.rank])).toEqual([[9, 1], [5, 2], [5, 2], [1, 4]]);
    // equal figures: the better attainment is listed first
    expect(rank(rows).map((r) => r.attainment_pct).slice(1, 3)).toEqual([80, 50]);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let tz = '';
let pipe: any;
let contactId = '';
let adminId = '';
const people: Record<string, { id: string; call: (m: string, p: string, b?: unknown) => Promise<{ status: number; data: any }> }> = {};

async function member(name: string, permissions: string[] = ['contacts', 'opportunities', 'dashboard']) {
  const email = `${name}@example.com`;
  const r = await t.api.post('/api/users', { email, password: 'passwort-123', name: `${name[0].toUpperCase()}${name.slice(1)} Vertrieb`, locations: [loc], permissions });
  expect(r.status).toBe(200);
  const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email, password: 'passwort-123' }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await t.api.raw(path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, 'x-location-id': loc }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
  };
  return { id: r.data.id as string, call };
}

/** A deal won at `when` (the close time is what counts), owned by `owner`. */
function won(owner: string | null, value: number, when: string, extra: Record<string, unknown> = {}) {
  const idd = `d${Math.random().toString(36).slice(2, 12)}`;
  t.app.db.insert('opportunities', { id: idd, location_id: loc, pipeline_id: pipe.id, stage_id: pipe.stages[1].id, contact_id: contactId, name: `Deal ${idd}`, value, status: 'won', assigned_to: owner, source: '', currency: 'EUR', created_at: when, updated_at: when, stage_changed_at: when, closed_at: when, ...extra });
  return idd;
}
const thisMonth = () => currentPeriod('month', new Date(), tz);
const inside = (day = 3, hh = '10:00:00') => `${thisMonth().start.slice(0, 8)}${String(day).padStart(2, '0')}T${hh}.000Z`;
const lastMonthDay = () => `${shiftPeriod('month', thisMonth().start, -1).slice(0, 8)}15T10:00:00.000Z`;

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  loc = t.api.location;
  adminId = me.user.id;
  tz = t.app.location(loc)?.timezone || 'Europe/Berlin';
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Gewonnen'] })).data;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Kunde', email: 'kunde@example.com' })).data.id;
  for (const n of ['alice', 'bob', 'carol']) people[n] = await member(n);
}, 60_000);
afterAll(() => t.close());

describe('quotas and attainment', () => {
  it('only people who may configure set quotas; targets are checked', async () => {
    const q = (scope: string, subject: string, target: unknown) => ({ scope, subject_id: subject, target });
    expect((await people.alice.call('PUT', '/api/quotas', { quotas: [q('user', people.alice.id, 1000)] })).status).toBe(403);
    expect((await t.api.put('/api/quotas', { quotas: [] })).status).toBe(400);
    expect((await t.api.put('/api/quotas', { quotas: [q('user', 'fremd', 100)] })).status).toBe(400);
    expect((await t.api.put('/api/quotas', { quotas: [q('team', 'gibtsnicht', 100)] })).status).toBe(400);
    expect((await t.api.put('/api/quotas', { quotas: [q('group', people.alice.id, 100)] })).status).toBe(400);
    expect((await t.api.put('/api/quotas', { quotas: [q('user', people.alice.id, -5)] })).status).toBe(400);
    expect((await t.api.put('/api/quotas', { quotas: [q('user', people.alice.id, 100)], start: '1.10.2026' })).status).toBe(400);
  });

  it('attainment per person from the deals they won in the period, in the quota’s currency, with pace and pipeline', async () => {
    const team = (await t.api.post('/api/sales/teams', { name: 'Nord', members: [{ user_id: people.alice.id }, { user_id: people.bob.id }] })).data;
    const set = await t.api.put('/api/quotas', { period: 'month', metric: 'won_value', quotas: [{ scope: 'user', subject_id: people.alice.id, target: 10000 }, { scope: 'user', subject_id: people.bob.id, target: 5000 }, { scope: 'team', subject_id: team.id, target: 20000 }] });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    won(people.alice.id, 6000, inside(2));
    won(people.alice.id, 1500, inside(3));
    won(people.alice.id, 9999, lastMonthDay()); // another month
    won(people.alice.id, 777, inside(4), { currency: 'USD' }); // another currency
    won(people.bob.id, 5200, inside(5));
    won(null, 4000, inside(5)); // nobody's deal counts for nobody
    won(people.carol.id, 300, inside(6)); // no quota: shows up with a figure only
    t.app.db.insert('opportunities', { id: 'open1', location_id: loc, pipeline_id: pipe.id, stage_id: pipe.stages[0].id, contact_id: contactId, name: 'Offen', value: 8000, status: 'open', assigned_to: people.alice.id, source: '', currency: 'EUR', expected_close_date: thisMonth().start.slice(0, 8) + '27', created_at: inside(1), updated_at: inside(1), stage_changed_at: inside(1) });

    const r = (await t.api.get('/api/quotas')).data;
    expect(r.period).toMatchObject({ kind: 'month', start: thisMonth().start, label: thisMonth().label });
    const row = (scope: string, id: string) => r.rows.find((x: any) => x.scope === scope && x.subject_id === id);
    expect(row('user', people.alice.id)).toMatchObject({ target: 10000, won_value: 7500, won_count: 2, achieved: 7500, attainment_pct: 75, gap: 2500, open_value: 8000 });
    expect(row('user', people.alice.id).weighted_pipeline).toBeGreaterThan(0);
    expect(row('user', people.alice.id).weighted_pipeline).toBeLessThanOrEqual(8000);
    expect(row('user', people.bob.id)).toMatchObject({ target: 5000, won_value: 5200, attainment_pct: 104, pace: 'reached', gap: 0 });
    expect(row('user', people.carol.id)).toMatchObject({ target: null, won_value: 300, attainment_pct: null, pace: 'none' });
    // the team adds up its members: 7.500 + 5.200
    expect(row('team', team.id)).toMatchObject({ target: 20000, won_value: 12700, won_count: 3, attainment_pct: 63.5, });
    expect([...row('team', team.id).members].sort()).toEqual([people.alice.id, people.bob.id].sort());
    expect(r.rows.some((x: any) => x.name === 'Ehemalige Person' || x.subject_id === '')).toBe(false);
    expect(r.can_edit).toBe(true);
    expect(r.quotas).toHaveLength(3);
    // the previous month: alice's other deal
    const prev = (await t.api.get(`/api/quotas?start=${r.period.prev}`)).data;
    expect(prev.rows.find((x: any) => x.subject_id === people.alice.id)).toMatchObject({ won_value: 9999, target: null });
    // the count metric and the quarter
    const count = (await t.api.get('/api/quotas?metric=won_count')).data;
    expect(count.rows.find((x: any) => x.subject_id === people.alice.id)).toMatchObject({ achieved: 2, target: null });
    const quarter = (await t.api.get('/api/quotas?period=quarter')).data;
    expect(quarter.period.kind).toBe('quarter');
    expect(quarter.period.label).toMatch(/^Q[1-4] \d{4}$/);
    expect((await t.api.get('/api/quotas?start=2026-13-45')).status).toBe(400);
  });

  it('a target of 0 removes the quota; the last period’s targets can be copied', async () => {
    const next = shiftPeriod('month', thisMonth().start, 1);
    expect((await t.api.post('/api/quotas/copy', { period: 'month', start: next })).data).toMatchObject({ ok: true, copied: 3, skipped: 0 });
    const copied = (await t.api.get(`/api/quotas?start=${next}`)).data;
    expect(copied.quotas.map((q: any) => q.target).sort((a: number, b: number) => a - b)).toEqual([5000, 10000, 20000]);
    // a second copy changes nothing
    expect((await t.api.post('/api/quotas/copy', { period: 'month', start: next })).data).toMatchObject({ copied: 0, skipped: 3 });
    expect((await t.api.post('/api/quotas/copy', { period: 'month', start: shiftPeriod('month', thisMonth().start, 5) })).status).toBe(409);
    expect((await t.api.put('/api/quotas', { start: next, quotas: [{ scope: 'user', subject_id: people.bob.id, target: 0 }] })).status).toBe(200);
    expect((await t.api.get(`/api/quotas?start=${next}`)).data.quotas).toHaveLength(2);
    expect((await people.alice.call('POST', '/api/quotas/copy', { start: next })).status).toBe(403);
  });
});

describe('leaderboard', () => {
  it('ranks people and teams by what they won, with the quota, the previous period and ties sharing a place', async () => {
    won(people.carol.id, 5200, inside(7), {}); // carol: 5.500 now
    won(people.bob.id, 300, inside(8)); // bob: 5.500 as well
    const r = (await t.api.get('/api/leaderboard')).data;
    expect(r).toMatchObject({ scope: 'user', metric: 'won_value', visibility: 'all', currency: 'EUR' });
    expect(r.rows.map((x: any) => [x.name.split(' ')[0], x.rank, x.achieved])).toEqual([['Alice', 1, 7500], ['Bob', 2, 5500], ['Carol', 2, 5500]]);
    expect(r.rows[0]).toMatchObject({ target: 10000, attainment_pct: 75, previous: 9999, me: false });
    const teams = (await t.api.get('/api/leaderboard?scope=team')).data;
    expect(teams.rows).toHaveLength(1);
    expect(teams.rows[0]).toMatchObject({ name: 'Nord', rank: 1, achieved: 13000 });
    const byCount = (await t.api.get('/api/leaderboard?metric=won_count')).data;
    expect(byCount.rows[0]).toMatchObject({ achieved: 2 });
    expect((await t.api.get('/api/leaderboard?start=bald')).status).toBe(400);
  });

  it('who sees whose numbers: everybody, only their own, or nobody (admins always)', async () => {
    const names = (res: { data: any }) => res.data.rows.map((x: any) => x.name.split(' ')[0]);
    expect(names(await people.alice.call('GET', '/api/leaderboard'))).toEqual(['Alice', 'Bob', 'Carol']);
    expect((await t.api.put('/api/quota-settings', { leaderboard: 'own' })).data.leaderboard).toBe('own');
    const own = await people.bob.call('GET', '/api/leaderboard');
    expect(names(own)).toEqual(['Bob']);
    expect(own.data).toMatchObject({ visibility: 'own', total: 3 });
    expect(own.data.rows[0]).toMatchObject({ rank: 2, me: true });
    // his own row and the team he belongs to (Alice and Bob share "Nord"), nobody else's
    expect(names(await people.bob.call('GET', '/api/quotas'))).toEqual(['Bob', 'Nord']);
    expect((await t.api.put('/api/quota-settings', { leaderboard: 'off' })).status).toBe(200);
    expect((await people.alice.call('GET', '/api/leaderboard')).status).toBe(403);
    expect((await people.alice.call('GET', '/api/quotas')).data.rows).toEqual([]);
    expect((await t.api.get('/api/leaderboard')).status).toBe(200);
    expect((await people.alice.call('PUT', '/api/quota-settings', { leaderboard: 'all' })).status).toBe(403);
    expect((await t.api.put('/api/quota-settings', { leaderboard: 'sometimes' })).status).toBe(400);
    // "back to the default": everybody sees all – unless record access limits their deals
    expect((await t.api.put('/api/quota-settings', { leaderboard: null })).data.leaderboard).toBeNull();
    expect(names(await people.alice.call('GET', '/api/leaderboard'))).toHaveLength(3);
    expect((await t.api.put('/api/sales/access', { enabled: true, rules: { default: { levels: { contacts: 'all', companies: 'all', deals: 'own', tasks: 'all', conversations: 'all' } } } })).status).toBe(200);
    try {
      expect(names(await people.alice.call('GET', '/api/leaderboard'))).toEqual(['Alice']);
      expect((await people.alice.call('GET', '/api/quota-settings')).data).toMatchObject({ leaderboard: null, effective: 'own' });
      // an explicit "all" is the admin's decision
      await t.api.put('/api/quota-settings', { leaderboard: 'all' });
      expect(names(await people.alice.call('GET', '/api/leaderboard'))).toHaveLength(3);
    } finally {
      await t.api.put('/api/sales/access', { enabled: false });
      await t.api.put('/api/quota-settings', { leaderboard: null });
    }
    expect((await t.api.put('/api/quota-settings', { currency: 'EURO' })).status).toBe(400);
  });
});

describe('board widgets', () => {
  it('offers "Quote: Zielerreichung" and the leaderboard to boards, with each viewer’s own figures', async () => {
    const catalogue = (await t.api.get('/api/boards/widgets')).data.widgets.map((w: any) => w.type);
    expect(catalogue).toEqual(expect.arrayContaining(['quota_attainment', 'sales_leaderboard']));
    const board = (await t.api.post('/api/boards', { name: 'Vertrieb', scope: 'shared' })).data;
    const patched = await t.api.post(`/api/boards/${board.id}/patch`, {
      ops: [
        { op: 'add', type: 'quota_attainment', config: { who: 'me' } },
        { op: 'add', type: 'quota_attainment', config: { who: 'all', metric: 'won_value' } },
        { op: 'add', type: 'sales_leaderboard', config: { limit: 2 } },
        { op: 'add', type: 'sales_leaderboard', config: { scope: 'team', period: 'quarter' } },
      ],
    });
    expect(patched.status, JSON.stringify(patched.data)).toBe(200);
    const spec = patched.data.board.spec.widgets;
    const view = (data: any, i: number) => data.data.data[spec[i].id].view;

    const admin = await t.api.get(`/api/boards/${board.id}/data`);
    expect(admin.status).toBe(200);
    // the admin has no quota of their own; "alle" adds up the people's targets (10.000 + 5.000) against everything they won
    expect(view(admin, 0)).toMatchObject({ kind: 'message' });
    expect(view(admin, 1)).toMatchObject({ kind: 'numbers', title: expect.stringContaining('Quote') });
    expect(view(admin, 1).items.map((x: any) => x.label)).toEqual(['Erreicht', 'Ziel', 'Erreichung', 'Gewichtete Pipeline']);
    expect(view(admin, 1).items[1].value).toMatch(/15\.000/);
    const lb = view(admin, 2);
    expect(lb).toMatchObject({ kind: 'table', total: 3 });
    expect(lb.rows).toHaveLength(2);
    expect(lb.rows[0]).toMatchObject({ rank: 1, attainment: '75 %' });
    expect(view(admin, 3).rows[0]).toMatchObject({ name: 'Nord' });

    expect(view(admin, 1).items[0].value).toMatch(/18\.500/);
    expect(view(admin, 1).items[2]).toMatchObject({ format: 'percent' });

    // a colleague sees the shared board with her own figures in "Quote: Zielerreichung"
    const alice = await people.alice.call('GET', `/api/boards/${board.id}/data`);
    expect(alice.status, JSON.stringify(alice.data)).toBe(200);
    const mine = alice.data.data[spec[0].id].view;
    expect(mine).toMatchObject({ kind: 'numbers', title: expect.stringContaining('Meine Quote') });
    expect(mine.items[0].value).toMatch(/7\.500/);
    expect(mine.items[2]).toMatchObject({ value: 75, format: 'percent' });
    expect(mine.hint).toMatch(/Tage/);
    // Carol has no quota: a hint instead of numbers
    const carol = await people.carol.call('GET', `/api/boards/${board.id}/data`);
    expect(carol.data.data[spec[0].id].view).toMatchObject({ kind: 'message', text: expect.stringMatching(/Quote/) });
  });
});
