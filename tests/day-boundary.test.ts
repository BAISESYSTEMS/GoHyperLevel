import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { berlinDay, pinClock, startTestApp, unpinClock } from './helpers.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { addDaysYmd, zonedToUtc } from '../server/core/time.js';
import { locationStats } from '../server/services/location-stats.js';
import { bounds } from '../server/services/mobile.js';
import { isOverdue } from '../server/services/pm-core.js';
import { resolveRange } from '../server/services/report-engine.js';
import { dayOf, todayIn } from '../web/src/pages/pm-format';

/**
 * "Today", "this week", due dates and birthdays are the sub-account's (default Europe/Berlin), never the UTC date or the UTC midnight.
 * Everything runs at two fixed instants: 22:30 UTC, when it is already 00:30 on the next day in Berlin (the UTC date is still
 * yesterday – this is what used to break between 22:00 and 24:00 UTC), and 12:00 UTC, when both dates agree.
 */
const INSTANTS = [
  { label: '22:30 UTC = 00:30 the next day in Berlin', at: '2026-06-15T22:30:00Z', today: '2026-06-16', utcDay: '2026-06-15', leadsToday: 1, leadDays: [['2026-06-15', 1], ['2026-06-16', 1]] },
  { label: '12:00 UTC = 14:00 in Berlin', at: '2026-06-15T12:00:00Z', today: '2026-06-15', utcDay: '2026-06-15', leadsToday: 2, leadDays: [['2026-06-15', 2]] },
] as const;
const BERLIN = 'Europe/Berlin';

describe.each(INSTANTS)('at $label', ({ at, today, utcDay, leadsToday, leadDays }) => {
  beforeAll(() => pinClock(at));
  afterAll(unpinClock);

  it('the fixed instant is what the test thinks it is', () => {
    expect(new Date().toISOString().slice(0, 10)).toBe(utcDay);
    expect(berlinDay()).toBe(today);
  });

  it('day bounds, report ranges and due dates use the sub-account zone', () => {
    const b = bounds(BERLIN);
    expect(b.today).toBe(today);
    expect(b.dayStart).toBe(zonedToUtc(today, '00:00', BERLIN).toISOString());
    expect(b.dayEnd).toBe(zonedToUtc(addDaysYmd(today, 1), '00:00', BERLIN).toISOString());
    expect(resolveRange('today', BERLIN, new Date()).current).toMatchObject({ fromYmd: today });
    expect(resolveRange('this_week', BERLIN, new Date()).current.fromYmd).toBe('2026-06-15'); // Monday
    // A date without a time is overdue the day after, a timed due date at its time.
    expect(isOverdue(`${today}T00:00:00.000Z`, BERLIN)).toBe(false);
    expect(isOverdue(`${addDaysYmd(today, -1)}T00:00:00.000Z`, BERLIN)).toBe(true);
    expect(isOverdue(new Date(Date.now() - 60_000).toISOString(), BERLIN)).toBe(true);
    expect(isOverdue(new Date(Date.now() + 60_000).toISOString(), BERLIN)).toBe(false);
    expect(isOverdue(null, BERLIN)).toBe(false);
    // The web client's helpers (task list, planner) agree with the server.
    expect(todayIn(BERLIN)).toBe(today);
    expect(dayOf(new Date().toISOString(), BERLIN)).toBe(today);
    expect(dayOf(`${today}T00:00:00.000Z`, 'America/Los_Angeles')).toBe(today);
  });

  describe('counters: dashboard, mobile summary and tasks, agency overview', () => {
    let t: Awaited<ReturnType<typeof startTestApp>>;
    let berlin = '';
    let la = '';
    let token = '';
    const mobile = async (path: string) => (await t.api.raw(path, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
    const titles = (rows: any[]) => rows.map((x) => x.title).sort();

    beforeAll(async () => {
      t = await startTestApp();
      await t.setup();
      berlin = t.api.location;
      la = (await t.api.post('/api/locations', { name: 'Westfirma', timezone: 'America/Los_Angeles' })).data.id;
      token = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel 9' })).data.token;
      // Two leads: one now, one three hours ago (21:30 the day before in Berlin at 00:30, the same day at 14:00).
      t.api.setLocation(berlin);
      await t.api.post('/api/contacts', { first_name: 'Neu', last_name: 'Jetzt', email: 'jetzt@example.com' });
      const earlier = (await t.api.post('/api/contacts', { first_name: 'Neu', last_name: 'Vorhin', email: 'vorhin@example.com' })).data.id;
      t.app.db.run('UPDATE contacts SET created_at = ? WHERE id = ?', new Date(Date.now() - 3 * 3600_000).toISOString(), earlier);
      const task = (title: string, due_at: string | null) => t.api.post('/api/tasks', { title, due_at });
      await task('Fällig heute', `${today}T00:00:00.000Z`);
      await task('Fällig gestern', `${addDaysYmd(today, -1)}T00:00:00.000Z`);
      await task('Heute früh', zonedToUtc(today, '00:10', BERLIN).toISOString());
      await task('Heute Abend', zonedToUtc(today, '23:30', BERLIN).toISOString());
      await task('Nächste Woche', `${addDaysYmd(today, 8)}T00:00:00.000Z`);
      await task('Ohne Datum', null);
      // Los Angeles is 9 hours behind Berlin: its "today" is the 15th at both instants.
      t.api.setLocation(la);
      await task('LA: heute', `${utcDay}T00:00:00.000Z`);
      await task('LA: gestern', `${addDaysYmd(utcDay, -1)}T00:00:00.000Z`);
      t.api.setLocation(berlin);
    }, 60_000);
    afterAll(() => t.close());

    it('dashboard: leads per local day, "today" and overdue tasks of the sub-account', async () => {
      const d = (await t.api.get('/api/dashboard?days=7')).data;
      expect(d.today).toBe(today);
      expect(d.leadsPerDay.map((x: any) => [x.day, x.n])).toEqual(leadDays);
      expect(d.contacts.new).toBe(2);
      // Overdue: "gestern" (a date) and "heute früh" (a time that has passed) – not "heute" (a date, still today).
      expect(d.tasks).toEqual({ open: 6, overdue: 2 });
      t.api.setLocation(la);
      expect((await t.api.get('/api/dashboard')).data).toMatchObject({ today: utcDay, tasks: { open: 2, overdue: 1 } });
      t.api.setLocation(berlin);
    });

    it('mobile summary: leads, due today and overdue', async () => {
      const s = await mobile(`/api/mobile/summary?location=${berlin}`);
      expect(s).toMatchObject({ leads_today: leadsToday, leads_7d: 2, tasks_due_today: 3, tasks_overdue: 2 });
      expect(s.spark_leads_14d.slice(-2)).toEqual([2 - leadsToday, leadsToday]);
      // Another zone has its own today: only "LA: gestern" is overdue there, "LA: heute" is due today.
      expect(await mobile(`/api/mobile/summary?location=${la}`)).toMatchObject({ tasks_due_today: 1, tasks_overdue: 1 });
      expect(await mobile('/api/mobile/summary')).toMatchObject({ leads_today: leadsToday, tasks_due_today: 4, tasks_overdue: 3 });
    });

    it('mobile task filters: today, overdue, week', async () => {
      const f = (filter: string) => mobile(`/api/mobile/tasks?filter=${filter}&location=${berlin}&limit=100`);
      expect(titles(await f('today'))).toEqual(['Fällig heute', 'Heute Abend', 'Heute früh']);
      expect(titles(await f('overdue'))).toEqual(['Fällig gestern', 'Heute früh']);
      expect(titles(await f('week'))).toEqual(['Fällig gestern', 'Fällig heute', 'Heute Abend', 'Heute früh']);
    });

    it('agency counters: overdue tasks per sub-account in its own zone', async () => {
      const stats = locationStats(t.app);
      expect(stats.get(berlin)).toMatchObject({ open_tasks: 6, overdue_tasks: 2 });
      expect(stats.get(la)).toMatchObject({ open_tasks: 2, overdue_tasks: 1 });
      expect(locationStats(t.app, [berlin, la]).get(la)).toMatchObject({ overdue_tasks: 1 });
      expect(locationStats(t.app, [la]).get(la)).toMatchObject({ overdue_tasks: 1 });
      const overview = (await t.api.get('/api/agency/projects')).data as any[];
      expect(overview.find((p) => p.id === berlin).stats.overdue_tasks).toBe(2);
      expect(overview.find((p) => p.id === la).stats.overdue_tasks).toBe(1);
    });

    it('a whiteboard task "in 0 / 1 days" counts from the sub-account\'s today', async () => {
      const board = (await t.api.post('/api/canvas', { name: 'Aufgaben' })).data;
      await t.api.post(`/api/canvas/${board.id}/elements`, { elements: [{ type: 'sticky', text: 'Kick-off' }] });
      const prev = t.app.services.aiRun;
      t.app.services.aiRun = async () => ({ text: JSON.stringify({ tasks: [{ title: 'Heute noch', description: '', due_in_days: 0 }, { title: 'Morgen', description: '', due_in_days: 1 }] }) }) as any;
      try {
        const r = await t.api.post(`/api/canvas/${board.id}/ai`, { mode: 'tasks' });
        expect(r.status, JSON.stringify(r.data)).toBe(200);
      } finally {
        t.app.services.aiRun = prev;
      }
      const due = (await t.api.get('/api/tasks?status=open')).data.filter((x: any) => ['Heute noch', 'Morgen'].includes(x.title));
      expect(due.map((x: any) => [x.title, x.due_at]).sort()).toEqual([['Heute noch', `${today}T00:00:00.000Z`], ['Morgen', `${addDaysYmd(today, 1)}T00:00:00.000Z`]]);
    });
  });

  describe('ad campaigns: default range and CRM leads', () => {
    let t: Awaited<ReturnType<typeof startTestApp>>;
    beforeAll(async () => {
      t = await startTestApp();
      await t.setup();
    }, 60_000);
    afterAll(() => t.close());

    it('lists the last 30 days up to the sub-account\'s today and joins the lead that just came in', async () => {
      const loc = t.api.location;
      t.app.db.run(`INSERT INTO ads_daily (location_id, platform, campaign_id, campaign_name, date, spend_cents, impressions, clicks, leads, currency, updated_at) VALUES (?, 'meta', 'c-1', 'Yoga Probestunde', ?, 5000, 2000, 80, 4, 'EUR', ?)`, loc, today, new Date().toISOString());
      const form = (await t.api.post('/api/forms', { name: 'Lead' })).data;
      const sent = await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ first_name: 'X', email: 'x@kunde.de', consent: 'ja', _page: 'https://lp.de/?utm_source=facebook&utm_medium=paid_social&utm_campaign=Yoga%20Probestunde' }) });
      expect(sent.status).toBeLessThan(300);
      const list = (await t.api.get('/api/ads/campaigns')).data;
      expect(list).toMatchObject({ from: addDaysYmd(today, -29), to: today });
      const row = list.campaigns.find((x: any) => x.remote_id === 'c-1');
      expect(row.metrics).toMatchObject({ spend_cents: 5000, clicks: 80, platform_leads: 4, crm_leads: 1, cpl_cents: 5000 });
      expect(list.totals).toMatchObject({ spend_cents: 5000, crm_leads: 1 });
      const ins = (await t.api.get('/api/ads/insights')).data;
      expect(ins).toMatchObject({ from: addDaysYmd(today, -29), to: today });
      expect(ins.campaigns.find((x: any) => x.remote_id === 'c-1')).toMatchObject({ spend_cents: 5000, crm_leads: 1 });
      // The report endpoint already used the sub-account's zone and must keep agreeing.
      expect((await t.api.get('/api/ads/report')).data).toMatchObject({ from: addDaysYmd(today, -29), to: today });
    });
  });

  describe('birthday job of the Werkstatt plugin', () => {
    let t: Awaited<ReturnType<typeof startTestApp>>;
    beforeAll(async () => {
      t = await startTestApp();
      await t.setup();
    }, 60_000);
    afterAll(() => t.close());

    it('creates the task on the contact\'s birthday in Berlin, not on the UTC date', async () => {
      const key = 'geburtstags-erinnerungen';
      const installed = await t.api.post(`/api/plugins/examples/${key}/install`, { consent: EXAMPLES[key].manifest.scopes });
      expect(installed.status, JSON.stringify(installed.data)).toBe(200);
      const id = installed.data.id;
      expect((await t.api.post(`/api/plugins/${id}/scope`, { scope: 'location' })).status).toBe(200);
      const born = (last: string, offset: number) => t.api.post('/api/contacts', { first_name: 'Anna', last_name: last, email: `${last.toLowerCase()}@kunde.example`, date_of_birth: `1990-${berlinDay(offset).slice(5)}` });
      const heute = (await born('Heute', 0)).data;
      const morgen = (await born('Morgen', 1)).data;
      const gestern = (await born('Gestern', -1)).data; // the UTC date at 00:30 in Berlin: not today
      const tick = t.app.services.pluginJobsTick as (at?: Date) => Promise<number>;
      expect(await tick(new Date())).toBe(0); // the first tick only schedules
      const next = t.app.db.get<{ next_run_at: string }>('SELECT next_run_at FROM plugin_job_state WHERE plugin_id = ?', id)!.next_run_at;
      expect(await tick(new Date(Date.parse(next) + 1000))).toBe(1);
      const tasks = (await t.api.get('/api/tasks?status=open')).data;
      const of = (c: any) => tasks.filter((x: any) => x.contact_id === c.id);
      expect(of(heute).map((x: any) => x.title)).toEqual([expect.stringContaining('hat heute Geburtstag')]);
      expect(of(morgen).map((x: any) => x.title)).toEqual([expect.stringContaining('hat in 1 Tagen Geburtstag')]);
      expect(of(gestern)).toEqual([]);
      expect(of(heute)[0].due_at).toBe(`${today}T08:00:00.000Z`);
    });
  });
});
