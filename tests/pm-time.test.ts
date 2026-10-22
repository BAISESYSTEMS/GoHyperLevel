import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billedSeconds } from '../server/services/pm-time.js';
import { mondayOf } from '../server/services/pm-schedule.js';
import { day, setupPm, settle, type Pm } from './pm-helpers.js';
import type { Call } from './security-fixtures.js';

/**
 * Time tracking: one running timer per person, manual entries and overlaps, timesheets with approval, reports,
 * rates and "In Rechnung stellen" (an invoice draft from billable entries).
 */

let p: Pm;
let t: Pm['t'];
let anna: Call;
let ben: Call;
const api = () => t.api;
const task = async (body: Record<string, any>) => (await api().post('/api/pm/tasks', body)).data;
const project = async (body: Record<string, any> = {}) => {
  const r = await api().post('/api/pm/projects', { name: `Projekt ${Math.random().toString(36).slice(2, 6)}`, ...body });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const running = () => t.app.db.all('SELECT * FROM pm_time_entries WHERE ended_at IS NULL');
const hours = (s: number) => Math.round((s / 3600) * 100) / 100;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

beforeAll(async () => {
  p = await setupPm();
  t = p.t;
  anna = await p.login(p.anna.email);
  ben = await p.login(p.ben.email);
});
// Every test starts with a clean time sheet: entries of earlier tests would overlap new ones.
beforeEach(() => {
  t.app.db.run('DELETE FROM pm_time_entries');
  t.app.db.run('DELETE FROM pm_timesheets');
});
afterAll(() => t.close());

describe('timer', () => {
  it('runs one timer per person: starting another stops the first, the same one is a no-op', async () => {
    const proj = await project({ name: 'Timer' });
    const a = await task({ title: 'Aufgabe A', project_id: proj.id });
    const b = await task({ title: 'Aufgabe B', project_id: proj.id });
    const start = await anna('POST', '/api/pm/timer/start', { task_id: a.id, note: 'los' });
    expect(start.status, start.text).toBe(200);
    expect(start.data.entry).toMatchObject({ running: true, task_title: 'Aufgabe A', project_name: 'Timer', note: 'los', user_name: 'Anna Beispiel', billable: true });
    const state = (await anna('GET', '/api/pm/timer')).data;
    expect(state.running).toMatchObject({ task_id: a.id, other_location: false, location_id: p.A });

    // the same task again: nothing changes
    const again = await anna('POST', '/api/pm/timer/start', { task_id: a.id });
    expect(again.data).toMatchObject({ already_running: true });
    expect(again.data.entry.id).toBe(start.data.entry.id);

    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(90), start.data.entry.id);
    const next = await anna('POST', '/api/pm/timer/start', { task_id: b.id });
    expect(next.data.stopped).toMatchObject({ task_title: 'Aufgabe A', running: false });
    expect(next.data.stopped.seconds).toBeGreaterThanOrEqual(90 * 60 - 2);
    expect(next.data.stopped.seconds).toBeLessThan(90 * 60 + 10);
    expect(running().filter((r) => r.user_id === p.anna.id)).toHaveLength(1);
    expect((await anna('GET', '/api/pm/timer')).data.running.task_id).toBe(b.id);

    // other people's timers are their own
    await ben('POST', '/api/pm/timer/start', { task_id: a.id });
    expect(running()).toHaveLength(2);
    // the database itself refuses a second running timer for one person
    expect(() => t.app.db.run(`INSERT INTO pm_time_entries (id, location_id, user_id, started_at, created_at, updated_at) VALUES ('dup', ?, ?, ?, ?, ?)`, p.A, p.anna.id, ago(1), ago(1), ago(1))).toThrow(/UNIQUE/);
  });

  it('stops the timer with its duration, can be given a real end, and refuses nonsense', async () => {
    const x = await task({ title: 'Stoppen' });
    expect((await anna('POST', '/api/pm/timer/stop', {})).status).toBe(409);
    const start = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(120), start.id);
    // end before the start / in the future
    expect((await anna('POST', '/api/pm/timer/stop', { at: ago(130) })).data.error).toContain('vor dem Start');
    expect((await anna('POST', '/api/pm/timer/stop', { at: new Date(Date.now() + 3_600_000).toISOString() })).data.error).toContain('Zukunft');
    // someone who forgot the timer sets the real end: one hour after the start
    const at = new Date(Date.parse(ago(120)) + 3_600_000).toISOString();
    const stopped = (await anna('POST', '/api/pm/timer/stop', { at, note: 'Mittagspause vergessen' })).data;
    expect(stopped.entry).toMatchObject({ running: false, seconds: 3600, note: 'Mittagspause vergessen' });
    expect((await anna('GET', '/api/pm/timer')).data.running).toBeNull();
    expect((await anna('POST', '/api/pm/timer/stop', {})).status).toBe(409);
  });

  it('drops an entry of zero length and refuses to stop a timer that ran over a day without an end', async () => {
    const x = await task({ title: 'Kurz' });
    const e = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    const dropped = (await anna('POST', '/api/pm/timer/stop', { at: e.started_at })).data;
    expect(dropped).toMatchObject({ entry: null, discarded: true });
    expect(t.app.db.get('SELECT 1 AS x FROM pm_time_entries WHERE id = ?', e.id)).toBeUndefined();

    const long = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(26 * 60), long.id);
    expect((await anna('POST', '/api/pm/timer/stop', {})).data.error).toContain('über 24 Stunden');
    expect((await anna('POST', '/api/pm/timer/stop', { at: ago(25 * 60) })).data.entry.seconds).toBe(3600);
  });

  it('stops forgotten timers after the limit and tells the person', async () => {
    const x = await task({ title: 'Vergessen' });
    const e = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(10 * 60), e.id);
    expect(t.app.services.pmTime.autoStopTimers()).toBe(0); // 10 hours: within the 16-hour limit
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(17 * 60), e.id);
    expect(t.app.services.pmTime.autoStopTimers()).toBe(1);
    const row = t.app.db.get('SELECT * FROM pm_time_entries WHERE id = ?', e.id)!;
    expect(row).toMatchObject({ auto_stopped: 1, seconds: 16 * 3600 });
    expect(row.ended_at).toBeTruthy();
    const note = (await anna('GET', '/api/pm/notifications')).data.items.find((n: any) => n.kind === 'timer');
    expect(note.title).toContain('automatisch gestoppt');
    expect(t.app.db.get(`SELECT 1 AS x FROM audit_log WHERE action = 'pm.time.auto_stop' AND entity_id = ?`, e.id)).toBeTruthy();
    // a limit set by the leadership applies
    await api().put('/api/pm/settings', { max_timer_hours: 2 });
    const e2 = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(3 * 60), e2.id);
    expect(t.app.services.pmTime.autoStopTimers()).toBe(1);
    expect(t.app.db.get('SELECT seconds FROM pm_time_entries WHERE id = ?', e2.id)!.seconds).toBe(2 * 3600);
    await api().put('/api/pm/settings', { max_timer_hours: 16 });
  });

  it('one timer across sub-accounts, and only the leadership starts or stops other people\'s timers', async () => {
    const x = await task({ title: 'In A' });
    t.api.setLocation(p.B);
    const y = (await api().post('/api/pm/tasks', { title: 'In B' })).data;
    t.api.setLocation(p.A);
    const first = (await api().post('/api/pm/timer/start', { task_id: x.id })).data.entry;
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(30), first.id);
    t.api.setLocation(p.B);
    try {
      // asking from B shows the timer that runs in A (with its details, Chef may open both)
      expect((await api().get('/api/pm/timer')).data.running).toMatchObject({ location_id: p.A, other_location: true, task_title: 'In A' });
      const started = (await api().post('/api/pm/timer/start', { task_id: y.id })).data;
      expect(started.stopped).toMatchObject({ task_title: 'In A', location_id: p.A });
      expect(started.stopped.seconds).toBeGreaterThanOrEqual(30 * 60 - 2);
      expect(running()).toHaveLength(1);
      expect(running()[0].location_id).toBe(p.B);
      // a task of another sub-account is not found
      expect((await api().post('/api/pm/timer/start', { task_id: x.id })).status).toBe(404);
    } finally {
      t.api.setLocation(p.A);
    }
    // Anna cannot stop Ben's timer (or start one for him); the leadership can
    await ben('POST', '/api/pm/timer/start', { task_id: x.id });
    expect((await anna('POST', '/api/pm/timer/stop', { user_id: p.ben.id })).status).toBe(400);
    expect((await anna('POST', '/api/pm/timer/start', { task_id: x.id, user_id: p.ben.id })).status).toBe(400);
    expect(running().some((r) => r.user_id === p.ben.id)).toBe(true);
    const stopped = await api().post('/api/pm/timer/stop', { user_id: p.ben.id, at: new Date().toISOString() });
    expect(stopped.status).toBe(200);
  });

  it('refuses a timer on an archived project and starts on a project without a task', async () => {
    const proj = await project({ name: 'Nur Projekt' });
    const e = (await anna('POST', '/api/pm/timer/start', { project_id: proj.id })).data.entry;
    expect(e).toMatchObject({ task_id: null, project_name: 'Nur Projekt' });
    await api().patch(`/api/pm/projects/${proj.id}`, { status: 'archived' });
    expect((await anna('POST', '/api/pm/timer/start', { project_id: proj.id })).status).toBe(400);
    // a task and a different project do not fit together
    const other = await project({ name: 'Anderes' });
    const x = await task({ title: 'X', project_id: other.id });
    expect((await anna('POST', '/api/pm/timer/start', { task_id: x.id, project_id: proj.id })).status).toBe(400);
  });
});

describe('manual entries and overlaps', () => {
  const yesterday = day(-1);
  const at = (hm: string, d = yesterday) => `${d}T${hm}:00.000Z`;

  it('logs durations on a day and shows them in the list', async () => {
    const proj = await project({ name: 'Manuell' });
    const x = await task({ title: 'Dauer', project_id: proj.id });
    const r = await anna('POST', '/api/pm/time', { task_id: x.id, minutes: 90, date: yesterday, note: 'Konzept' });
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ seconds: 5400, has_clock: false, day: yesterday, task_title: 'Dauer', project_name: 'Manuell', billable: true, source: 'manual', approval: 'open', note: 'Konzept' });
    const byHours = (await anna('POST', '/api/pm/time', { task_id: x.id, hours: 0.5, date: yesterday })).data;
    expect(byHours.seconds).toBe(1800);
    const list = (await anna('GET', `/api/pm/time?task_id=${x.id}`)).data.entries;
    expect(list).toHaveLength(2);
    expect((await get(x.id)).task.logged_seconds).toBe(7200);
    // the project and its Gantt/list totals
    expect((await api().get('/api/pm/projects')).data.find((q: any) => q.id === proj.id).stats).toMatchObject({ logged_seconds: 7200, billable_seconds: 7200 });
    // non-billable by project default
    const nb = await project({ name: 'Intern', billable: false });
    expect((await anna('POST', '/api/pm/time', { project_id: nb.id, minutes: 30 })).data.billable).toBe(false);
  });

  const get = async (id: string) => (await api().get(`/api/pm/tasks/${id}`)).data;

  it('refuses entries that overlap another of the same person, but not adjacent ones or other people', async () => {
    const x = await task({ title: 'Überschneidung' });
    const log = (who: Call, from: string, to: string, extra: Record<string, any> = {}) => who('POST', '/api/pm/time', { task_id: x.id, start_at: at(from), end_at: at(to), ...extra });
    expect((await log(anna, '08:00', '09:30')).status).toBe(200);
    const clash = await log(anna, '09:00', '10:00');
    expect(clash.status).toBe(400);
    expect(clash.data.error).toContain('Überschneidung');
    expect((await log(anna, '07:30', '11:00')).status).toBe(400); // covers it
    expect((await log(anna, '08:30', '09:00')).status).toBe(400); // inside it
    expect((await log(anna, '07:00', '08:01')).status).toBe(400); // one minute in
    expect((await log(anna, '09:30', '10:00')).status).toBe(200); // adjacent
    expect((await log(anna, '07:00', '08:00')).status).toBe(200); // adjacent before
    expect((await log(ben, '08:00', '09:30')).status).toBe(200); // someone else
    // durations without clock times never overlap
    expect((await anna('POST', '/api/pm/time', { task_id: x.id, minutes: 60, date: yesterday })).status).toBe(200);
    // the same slot is fine when the leadership allows overlaps
    await api().put('/api/pm/settings', { allow_overlap: true });
    expect((await log(anna, '08:00', '09:30')).status).toBe(200);
    await api().put('/api/pm/settings', { allow_overlap: false });
  });

  it('counts the running timer as busy time, and refuses to start while a clock entry covers now', async () => {
    const x = await task({ title: 'Läuft' });
    const e = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', ago(30), e.id);
    const log = (from: number, to: number) => anna('POST', '/api/pm/time', { task_id: x.id, start_at: ago(from), end_at: ago(to) });
    expect((await log(60, 10)).data.error).toContain('Überschneidung');
    expect((await log(90, 35)).status).toBe(200);
    t.app.db.run('DELETE FROM pm_time_entries WHERE user_id = ?', p.anna.id);
    // a clock entry that reaches into the next minutes blocks starting a timer
    const soon = await anna('POST', '/api/pm/time', { task_id: x.id, start_at: ago(10), end_at: new Date(Date.now() + 3 * 60_000).toISOString() });
    expect(soon.status).toBe(200);
    expect((await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.error).toContain('Überschneidung');
  });

  it('validates length, order and future dates', async () => {
    const x = await task({ title: 'Prüfen' });
    const bad = async (body: Record<string, any>) => (await anna('POST', '/api/pm/time', { task_id: x.id, ...body })).data.error as string;
    expect(await bad({ seconds: 30, date: yesterday })).toContain('Mindestens eine Minute');
    expect(await bad({ hours: 25, date: yesterday })).toContain('24 Stunden');
    expect(await bad({ minutes: 30, date: day(2) })).toContain('Zukunft');
    expect(await bad({ start_at: at('10:00'), end_at: at('09:00') })).toContain('vor dem Start');
    expect(await bad({ start_at: new Date(Date.now() + 3_600_000).toISOString(), minutes: 30 })).toContain('Zukunft');
    expect(await bad({ date: yesterday })).toContain('Dauer');
    expect(await bad({ minutes: 30, date: 'gestern' })).toContain('JJJJ-MM-TT');
    expect(await bad({ start_at: at('10:00') })).toContain('Ende oder Dauer');
    expect(await bad({ task_id: 'fremd', minutes: 30 })).toContain('nicht gefunden');
  });

  it('edits and deletes only your own entries (the leadership any), and not billed or running ones', async () => {
    const x = await task({ title: 'Ändern' });
    const mine = (await anna('POST', '/api/pm/time', { task_id: x.id, start_at: at('08:00', day(-3)), end_at: at('09:00', day(-3)) })).data;
    const other = (await anna('POST', '/api/pm/time', { task_id: x.id, start_at: at('11:00', day(-3)), end_at: at('12:00', day(-3)) })).data;
    expect((await anna('PATCH', `/api/pm/time/${mine.id}`, { note: 'neu', billable: false })).data).toMatchObject({ note: 'neu', billable: false });
    // moving it must respect the other entry – but not collide with itself
    expect((await anna('PATCH', `/api/pm/time/${mine.id}`, { start_at: at('08:30', day(-3)), end_at: at('11:30', day(-3)) })).data.error).toContain('Überschneidung');
    expect((await anna('PATCH', `/api/pm/time/${mine.id}`, { start_at: at('07:00', day(-3)), end_at: at('10:00', day(-3)) })).data.seconds).toBe(3 * 3600);
    expect((await ben('PATCH', `/api/pm/time/${mine.id}`, { note: 'fremd' })).status).toBe(400);
    expect((await ben('DELETE', `/api/pm/time/${mine.id}`)).status).toBe(400);
    expect((await anna('PATCH', `/api/pm/time/${mine.id}`, { rate_cents: 99999 })).data.error).toContain('Leitung');
    expect((await api().patch(`/api/pm/time/${mine.id}`, { rate_cents: 12345 })).data.rate_cents).toBe(12345);
    expect((await anna('DELETE', `/api/pm/time/${mine.id}`)).status).toBe(200);
    expect((await api().del(`/api/pm/time/${other.id}`)).status).toBe(200);
    expect((await api().patch('/api/pm/time/gibts-nicht', { note: 'x' })).status).toBe(404);
    // running timers are stopped first
    const e = (await anna('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    expect((await anna('PATCH', `/api/pm/time/${e.id}`, { note: 'x' })).data.error).toContain('läuft noch');
  });
});

describe('timesheets and approval', () => {
  const week = mondayOf(day(-14));
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${week}T00:00:00Z`) + i * 864e5).toISOString().slice(0, 10));

  it('collects a week per task and day, locks it on submit and unlocks on reject', async () => {
    const proj = await project({ name: 'Wochenzettel' });
    const a = await task({ title: 'Task A', project_id: proj.id });
    const b = await task({ title: 'Task B', project_id: proj.id });
    await anna('POST', '/api/pm/time', { task_id: a.id, minutes: 120, date: days[0] });
    await anna('POST', '/api/pm/time', { task_id: a.id, minutes: 60, date: days[1] });
    await anna('POST', '/api/pm/time', { task_id: b.id, minutes: 30, date: days[1], billable: false });
    await anna('POST', '/api/pm/time', { project_id: proj.id, minutes: 15, date: days[2] });
    const sheet = (await anna('GET', `/api/pm/timesheet?week=${days[3]}`)).data;
    expect(sheet).toMatchObject({ week, status: 'open', locked: false, total: 225 * 60, billable_total: 195 * 60 });
    expect(sheet.days).toEqual(days);
    expect(sheet.totals).toEqual({ [days[0]]: 7200, [days[1]]: 5400, [days[2]]: 900 });
    expect(sheet.rows.map((r: any) => [r.title, r.total])).toEqual([['Task A', 10800], ['Task B', 1800], ['Wochenzettel', 900]]);
    expect(sheet.rows[0].days).toEqual({ [days[0]]: 7200, [days[1]]: 3600 });

    // someone else's sheet: only the leadership
    expect((await ben('GET', `/api/pm/timesheet?week=${week}&user_id=${p.anna.id}`)).status).toBe(400);
    expect((await api().get(`/api/pm/timesheet?week=${week}&user_id=${p.anna.id}`)).data.total).toBe(225 * 60);

    const sub = await anna('POST', '/api/pm/timesheet/submit', { week: days[4] });
    expect(sub.data).toMatchObject({ status: 'submitted', locked: true });
    expect(sub.data.entries.every((e: any) => e.approval === 'submitted')).toBe(true);
    // submitted weeks can't be changed by the person
    expect((await anna('POST', '/api/pm/time', { task_id: a.id, minutes: 30, date: days[3] })).data.error).toContain('abgegeben');
    expect((await anna('PATCH', `/api/pm/time/${sheet.entries[0].id}`, { note: 'x' })).data.error).toContain('abgegeben');
    expect((await anna('DELETE', `/api/pm/time/${sheet.entries[0].id}`)).status).toBe(400);
    // the leadership was asked, and sees it in the inbox
    expect((await api().get('/api/pm/notifications')).data.items.some((n: any) => n.kind === 'timesheet' && n.title.includes('Anna Beispiel'))).toBe(true);
    expect((await api().get('/api/pm/timesheet/pending')).data).toEqual([expect.objectContaining({ user_id: p.anna.id, week, user_name: 'Anna Beispiel' })]);
    expect((await anna('GET', '/api/pm/timesheet/pending')).data).toEqual([]);

    // only the leadership decides
    expect((await anna('POST', '/api/pm/timesheet/decide', { user_id: p.anna.id, week, decision: 'approve' })).status).toBe(400);
    const rejected = (await api().post('/api/pm/timesheet/decide', { user_id: p.anna.id, week, decision: 'reject', note: 'Task B war nicht abrechenbar?' })).data;
    expect(rejected).toMatchObject({ status: 'rejected', locked: false, note: 'Task B war nicht abrechenbar?' });
    expect((await anna('GET', '/api/pm/notifications')).data.items.find((n: any) => n.kind === 'timesheet' && n.title.includes('abgelehnt')).body).toContain('Task B');
    // rejected: editable again, then submitted and approved
    expect((await anna('POST', '/api/pm/time', { task_id: a.id, minutes: 30, date: days[3] })).status).toBe(200);
    await anna('POST', '/api/pm/timesheet/submit', { week });
    const approved = (await api().post('/api/pm/timesheet/decide', { user_id: p.anna.id, week, decision: 'approve' })).data;
    expect(approved).toMatchObject({ status: 'approved', locked: true });
    expect(approved.entries.every((e: any) => e.approval === 'approved')).toBe(true);
    expect((await anna('GET', '/api/pm/notifications')).data.items.some((n: any) => n.title.includes('freigegeben'))).toBe(true);
    expect((await anna('POST', '/api/pm/timesheet/submit', { week })).data.error).toContain('schon freigegeben');
    expect((await anna('POST', '/api/pm/time', { task_id: a.id, minutes: 5, date: days[3] })).data.error).toContain('freigegeben');
    // the leadership can still correct it, or reopen the week
    expect((await api().patch(`/api/pm/time/${sheet.entries[0].id}`, { note: 'korrigiert' })).status).toBe(200);
    expect((await api().post('/api/pm/timesheet/decide', { user_id: p.anna.id, week, decision: 'reopen' })).data.status).toBe('open');
    expect((await anna('POST', '/api/pm/time', { task_id: a.id, minutes: 5, date: days[3] })).status).toBe(200);
    expect((await api().post('/api/pm/timesheet/decide', { user_id: p.anna.id, week: days[0], decision: 'maybe' })).status).toBe(400);
  });

  it('cannot submit an empty week or one with a running timer', async () => {
    expect((await ben('POST', '/api/pm/timesheet/submit', { week })).data.error).toContain('keine Zeit');
    const x = await task({ title: 'Läuft in der Woche' });
    const e = (await ben('POST', '/api/pm/timer/start', { task_id: x.id })).data.entry;
    const thisWeek = mondayOf(day(0));
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE id = ?', `${day(0)}T00:00:00.000Z`, e.id);
    expect((await ben('POST', '/api/pm/timesheet/submit', { week: thisWeek })).data.error).toContain('Timer');
  });
});

describe('reports and export', () => {
  it('groups hours by project, person, client, task, day and week – members see only their own', async () => {
    const contact = (await api().post('/api/contacts', { first_name: 'Rita', last_name: 'Report', email: 'rita@report.de' })).data;
    const company = (await api().post('/api/companies', { name: 'Report GmbH', domain: 'andere-firma.de' })).data;
    const p1 = await project({ name: 'Report Eins', contact_id: contact.id });
    const p2 = await project({ name: 'Report Zwei', company_id: company.id });
    const p3 = await project({ name: 'Report Drei' });
    const t1 = await task({ title: 'Report-Aufgabe', project_id: p1.id });
    const d1 = day(-60);
    const d2 = day(-59);
    await anna('POST', '/api/pm/time', { task_id: t1.id, minutes: 120, date: d1 });
    await ben('POST', '/api/pm/time', { task_id: t1.id, minutes: 60, date: d2 });
    await anna('POST', '/api/pm/time', { project_id: p2.id, minutes: 30, date: d2, billable: false });
    await ben('POST', '/api/pm/time', { project_id: p3.id, minutes: 45, date: d2 });
    const rep = async (group: string, who: Call | null = null) => ((who ? await who('GET', `/api/pm/time/report?group=${group}&from=${d1}&to=${d2}`) : await api().get(`/api/pm/time/report?group=${group}&from=${d1}&to=${d2}`)).data);
    const rows = (r: any) => Object.fromEntries(r.rows.map((x: any) => [x.label, x.seconds / 60]));
    const byProject = await rep('project');
    expect(rows(byProject)).toEqual({ 'Report Eins': 180, 'Report Zwei': 30, 'Report Drei': 45 });
    expect(byProject).toMatchObject({ total_seconds: 255 * 60, billable_seconds: 225 * 60, entries: 4 });
    expect(rows(await rep('user'))).toEqual({ 'Anna Beispiel': 150, 'Ben Muster': 105 });
    expect(rows(await rep('client'))).toEqual({ 'Rita Report': 180, 'Report GmbH': 30, 'Ohne Kunde': 45 });
    expect(rows(await rep('task'))).toEqual({ 'Report-Aufgabe': 180, 'Report Zwei': 30, 'Report Drei': 45 });
    expect((await rep('day')).rows.map((r: any) => [r.key, r.seconds / 60])).toEqual([[d1, 120], [d2, 135]]);
    expect((await rep('week')).rows.reduce((s: number, r: any) => s + r.seconds, 0)).toBe(255 * 60);
    expect((await rep('project')).rows.find((r: any) => r.label === 'Report Zwei').billable_seconds).toBe(0);
    // members only see their own time
    expect(rows(await rep('user', anna))).toEqual({ 'Anna Beispiel': 150 });
    expect((await rep('project', ben)).total_seconds).toBe(105 * 60);
    // filters
    expect((await api().get(`/api/pm/time/report?group=user&project_id=${p1.id}&from=${d1}&to=${d2}`)).data.total_seconds).toBe(180 * 60);
    expect((await api().get(`/api/pm/time/report?group=project&billable=0&from=${d1}&to=${d2}`)).data.total_seconds).toBe(30 * 60);
    expect((await api().get(`/api/pm/time/report?group=nonsense&from=${d1}&to=${d2}`)).data.group).toBe('project');
  });

  it('is also a report source in the report builder', async () => {
    const own = await project({ name: 'Report Eins' });
    await anna('POST', '/api/pm/time', { project_id: own.id, minutes: 150, date: day(-1) });
    await ben('POST', '/api/pm/time', { project_id: own.id, minutes: 60, date: day(-1), billable: false });
    const r = await api().post('/api/reports/run', { query: { source: 'time_entries', measures: ['calc:hours_total', 'calc:hours_billable'], group_by: ['project'], range: 'all' } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(JSON.stringify(r.data)).toContain('Report Eins');
    expect(r.data.totals.v).toEqual([3.5, 2.5]);
    const sources = (await api().get('/api/reports/sources')).data.sources.map((s: any) => s.key);
    expect(sources).toEqual(expect.arrayContaining(['time_entries', 'pm_projects']));
  });

  it('exports a CSV that cannot run formulas', async () => {
    const x = await task({ title: '=HYPERLINK("http://böse.example")', project_id: (await project({ name: 'CSV' })).id });
    await api().post('/api/pm/time', { task_id: x.id, minutes: 90, date: day(-1), note: '+SUMME(A1)' });
    const csv = await t.api.raw(`/api/pm/time/export.csv?from=${day(-1)}&to=${day(-1)}`, { headers: { cookie: t.api.cookie, 'x-location-id': p.A } });
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('Datum,Person,Projekt,Aufgabe,Notiz,Stunden');
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("'+SUMME(A1)");
    expect(text).toContain('1,50');
    // exports are in the audit log
    expect(t.app.db.get(`SELECT 1 AS x FROM audit_log WHERE action LIKE 'export:%' AND route LIKE '%time/export.csv'`)).toBeTruthy();
  });
});

describe('rates and billing', () => {
  it('rounds billed time up to the configured step', () => {
    expect(billedSeconds(50 * 60, 15)).toBe(3600);
    expect(billedSeconds(60 * 60, 15)).toBe(3600);
    expect(billedSeconds(61 * 60, 15)).toBe(75 * 60);
    expect(billedSeconds(61, 0)).toBe(61);
  });

  it('resolves the rate: entry, person on project, project, person, sub-account default', async () => {
    const proj = await project({ name: 'Sätze', hourly_rate_cents: 9000 });
    const rate = (who: any, body: Record<string, any>) => who('PUT', '/api/pm/billing/rates', body);
    // only the leadership sets rates; members without the payments area don't even see them
    expect((await rate(anna, { user_id: p.anna.id, rate_cents: 1 })).status).toBe(403);
    expect((await anna('GET', '/api/pm/billing/rates')).status).toBe(403);
    expect((await rate(ben, { user_id: p.ben.id, rate_cents: 1 })).data.error).toContain('Leitung');
    expect((await api().put('/api/pm/billing/rates', { user_id: p.anna.id, project_id: proj.id, rate_cents: 12000 })).data.rate_cents).toBe(12000);
    expect((await api().put('/api/pm/billing/rates', { user_id: p.ben.id, rate_cents: 7000 })).status).toBe(200);
    expect((await api().put('/api/pm/billing/rates', { user_id: p.ben.id, rate_cents: -1 })).status).toBe(400);
    expect((await api().put('/api/pm/billing/rates', { user_id: 'nobody', rate_cents: 100 })).status).toBe(400);
    expect((await api().put('/api/pm/billing/rates', { rate_cents: 100 })).status).toBe(400);
    await api().put('/api/pm/settings', { default_rate_cents: 5000 });
    const x = await task({ title: 'Satz-Aufgabe', project_id: proj.id });
    const other = await project({ name: 'Ohne Projektsatz' });
    await anna('POST', '/api/pm/time', { task_id: x.id, minutes: 60, date: day(-2) }); // person on project: 120 €
    await ben('POST', '/api/pm/time', { task_id: x.id, minutes: 60, date: day(-2) }); // project: 90 €
    await ben('POST', '/api/pm/time', { project_id: other.id, minutes: 60, date: day(-2) }); // person default: 70 €
    await anna('POST', '/api/pm/time', { project_id: other.id, minutes: 60, date: day(-2) }); // sub-account default: 50 €
    const entry = (await api().post('/api/pm/time', { project_id: other.id, minutes: 60, date: day(-2), rate_cents: 20000, user_id: p.anna.id })).data; // the entry's own rate: 200 €
    expect(entry.rate_cents).toBe(20000);
    const unbilled = (await api().get('/api/pm/billing/unbilled')).data;
    const by = (name: string) => unbilled.projects.find((q: any) => q.name === name);
    expect(by('Sätze').amount_cents).toBe(12000 + 9000);
    expect(by('Ohne Projektsatz').amount_cents).toBe(7000 + 5000 + 20000);
    expect((await api().get('/api/pm/billing/rates')).data.rates.map((r: any) => [r.user_name, r.project_name || null, r.rate_cents])).toEqual([['Anna Beispiel', 'Sätze', 12000], ['Ben Muster', null, 7000]]);
    // removing a rate falls back to the next level
    await api().put('/api/pm/billing/rates', { user_id: p.anna.id, project_id: proj.id, rate_cents: null });
    expect((await api().get('/api/pm/billing/unbilled')).data.projects.find((q: any) => q.name === 'Sätze').amount_cents).toBe(9000 + 9000);
  });

  it('turns billable entries into an invoice draft with rates, rounded hours and locks the entries', async () => {
    await api().put('/api/pm/settings', { round_up_minutes: 15, default_rate_cents: 5000 });
    const contact = (await api().post('/api/contacts', { first_name: 'Karla', last_name: 'Kundin', email: 'karla@kundin.de' })).data;
    const proj = await project({ name: 'Abrechnung', contact_id: contact.id, hourly_rate_cents: 9000 });
    const other = await project({ name: 'Anderes Projekt' });
    await api().put('/api/pm/billing/rates', { user_id: p.anna.id, project_id: proj.id, rate_cents: 12000 });
    const x = await task({ title: 'Konzept', project_id: proj.id });
    const z = await task({ title: 'Texte', project_id: proj.id });
    const d = day(-4);
    const a1 = (await anna('POST', '/api/pm/time', { task_id: x.id, minutes: 90, date: d })).data;
    const b1 = (await ben('POST', '/api/pm/time', { task_id: x.id, minutes: 50, date: d })).data;
    const nb = (await ben('POST', '/api/pm/time', { task_id: x.id, minutes: 60, date: d, billable: false })).data;
    await ben('POST', '/api/pm/time', { project_id: other.id, minutes: 30, date: d });
    const c1 = (await api().post('/api/pm/time', { task_id: z.id, minutes: 10, date: d })).data;

    const summary = (await ben('GET', `/api/pm/billing/unbilled?project_id=${proj.id}`)).data;
    expect(summary).toMatchObject({ entries: 3, seconds: 150 * 60 });
    expect(summary.projects[0]).toMatchObject({ name: 'Abrechnung', billed_seconds: 165 * 60, amount_cents: 18000 + 9000 + 2250, contact_id: contact.id });

    // members without the payments area can't bill
    expect((await anna('POST', '/api/pm/billing/invoice', { project_id: proj.id })).status).toBe(403);
    const r = await ben('POST', '/api/pm/billing/invoice', { project_id: proj.id, title: 'Leistungen Oktober' });
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ entries: 3, hours: 2.75, amount_cents: 29250 });
    expect(r.data.invoice).toMatchObject({ status: 'draft', contact_id: contact.id });
    const inv = (await api().get(`/api/invoices/${r.data.invoice.id}`)).data;
    expect(inv).toMatchObject({ title: 'Leistungen Oktober', status: 'draft', contact_id: contact.id, subtotal_cents: 29250 });
    expect(inv.total_cents).toBe(inv.subtotal_cents + inv.tax_cents);
    expect(inv.items.map((i: any) => [i.name, i.qty, i.price_cents]).sort()).toEqual([['Konzept', 1, 9000], ['Konzept', 1.5, 12000], ['Texte', 0.25, 9000]].sort());
    expect(inv.items[0].description).toContain('Std. à');
    expect((await api().get('/api/invoices')).data.some((i: any) => i.id === inv.id)).toBe(true);

    // entries are billed: no second invoice, no edits
    const row = t.app.db.get('SELECT * FROM pm_time_entries WHERE id = ?', a1.id)!;
    expect(row).toMatchObject({ invoice_id: inv.id, billed_rate_cents: 12000, billed_seconds: 5400 });
    expect(t.app.db.get('SELECT billed_seconds FROM pm_time_entries WHERE id = ?', b1.id)!.billed_seconds).toBe(3600);
    expect((await api().post('/api/pm/billing/invoice', { project_id: proj.id })).data.error).toContain('Keine abrechenbaren');
    expect((await anna('PATCH', `/api/pm/time/${a1.id}`, { note: 'x' })).data.error).toContain('abgerechnet');
    expect((await api().del(`/api/pm/time/${a1.id}`)).data.error).toContain('abgerechnet');
    expect((await api().get(`/api/pm/time?billed=1&project_id=${proj.id}`)).data.entries.map((e: any) => e.invoice_number)).toEqual(['Entwurf', 'Entwurf', 'Entwurf']);
    expect(t.app.db.get('SELECT invoice_id FROM pm_time_entries WHERE id = ?', nb.id)!.invoice_id).toBeNull();
    expect(t.app.db.get('SELECT invoice_id FROM pm_time_entries WHERE id = ?', c1.id)!.invoice_id).toBe(inv.id);

    // deleting the draft frees the time again; so does cancelling an invoice
    expect((await api().del(`/api/invoices/${inv.id}`)).status).toBe(200);
    expect((await api().get(`/api/pm/billing/unbilled?project_id=${proj.id}`)).data.entries).toBe(3);
    const second = (await api().post('/api/pm/billing/invoice', { project_id: proj.id, group_by: 'user' })).data;
    const items = (await api().get(`/api/invoices/${second.invoice.id}`)).data.items;
    expect(items.map((i: any) => [i.name, i.qty])).toEqual(expect.arrayContaining([['Anna Beispiel', 1.5], ['Ben Muster', 1], ['Chef', 0.25]]));
    await api().patch(`/api/invoices/${second.invoice.id}`, { status: 'void' });
    expect((await api().get(`/api/pm/billing/unbilled?project_id=${proj.id}`)).data.entries).toBe(3);
    await api().put('/api/pm/settings', { round_up_minutes: 0 });
  });

  it('groups by entry, honours the date range and an explicit tax rate, and needs a rate', async () => {
    const proj = await project({ name: 'Zeitraum', hourly_rate_cents: 8000 });
    const x = await task({ title: 'Eintragsweise', project_id: proj.id });
    await anna('POST', '/api/pm/time', { task_id: x.id, minutes: 60, date: day(-10), note: 'alt' });
    await anna('POST', '/api/pm/time', { task_id: x.id, minutes: 30, date: day(-3), note: 'neu' });
    const r = (await api().post('/api/pm/billing/invoice', { project_id: proj.id, group_by: 'entry', from: day(-5), tax_rate: 0 })).data;
    expect(r).toMatchObject({ entries: 1, hours: 0.5, amount_cents: 4000 });
    const inv = (await api().get(`/api/invoices/${r.invoice.id}`)).data;
    expect(inv.items[0].name).toContain('Eintragsweise: neu');
    expect(inv).toMatchObject({ tax_cents: 0, total_cents: 4000 });
    // the older one on its own, with a title from the range
    const old = (await api().post('/api/pm/billing/invoice', { project_id: proj.id, to: day(-5) })).data;
    expect(old.hours).toBe(1);
    // nothing without a rate
    const free = await project({ name: 'Ohne Satz' });
    await api().put('/api/pm/settings', { default_rate_cents: 0 });
    await anna('POST', '/api/pm/time', { project_id: free.id, minutes: 60, date: day(-1) });
    expect((await api().post('/api/pm/billing/invoice', { project_id: free.id })).data.error).toContain('Stundensatz');
    await api().put('/api/pm/billing/rates', { user_id: p.anna.id, rate_cents: 6000 });
    expect((await api().post('/api/pm/billing/invoice', { project_id: free.id })).data.amount_cents).toBe(6000);
    // input checks
    expect((await api().post('/api/pm/billing/invoice', {})).data.error).toContain('Projekt');
    expect((await api().post('/api/pm/billing/invoice', { project_id: 'fremd' })).status).toBe(404);
    expect((await api().post('/api/pm/billing/invoice', { project_id: free.id, contact_id: 'fremd' })).status).toBe(400);
  });

  it('bills approved time only when approval is required, and refuses mixed customers', async () => {
    await api().put('/api/pm/settings', { approval_required: true, default_rate_cents: 5000 });
    const proj = await project({ name: 'Freigabe nötig' });
    const x = await task({ title: 'Freigabe-Aufgabe', project_id: proj.id });
    const week = mondayOf(day(-21));
    const d = new Date(Date.parse(`${week}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
    await ben('POST', '/api/pm/time', { task_id: x.id, minutes: 60, date: d });
    expect((await api().post('/api/pm/billing/invoice', { project_id: proj.id })).data.error).toContain('freigegebenen');
    expect((await api().get(`/api/pm/billing/unbilled?project_id=${proj.id}`)).data).toMatchObject({ entries: 0, approval_required: true });
    expect((await api().get(`/api/pm/billing/unbilled?project_id=${proj.id}&include_unapproved=1`)).data.entries).toBe(1);
    await ben('POST', '/api/pm/timesheet/submit', { week });
    await api().post('/api/pm/timesheet/decide', { user_id: p.ben.id, week, decision: 'approve' });
    expect((await api().post('/api/pm/billing/invoice', { project_id: proj.id })).data).toMatchObject({ entries: 1, hours: 1 });

    // entries of projects with different customers do not fit on one invoice
    await api().put('/api/pm/settings', { approval_required: false });
    const c1 = (await api().post('/api/contacts', { first_name: 'Eins', email: 'eins@kunde.de' })).data;
    const c2 = (await api().post('/api/contacts', { first_name: 'Zwei', email: 'zwei@kunde.de' })).data;
    const pa = await project({ name: 'Kunde Eins', contact_id: c1.id });
    const pb = await project({ name: 'Kunde Zwei', contact_id: c2.id });
    const e1 = (await anna('POST', '/api/pm/time', { project_id: pa.id, minutes: 30, date: day(-1) })).data;
    const e2 = (await anna('POST', '/api/pm/time', { project_id: pb.id, minutes: 30, date: day(-1) })).data;
    expect((await api().post('/api/pm/billing/invoice', { entry_ids: [e1.id, e2.id] })).data.error).toContain('verschiedenen Kunden');
    expect((await api().post('/api/pm/billing/invoice', { entry_ids: [e1.id], contact_id: c2.id })).data.invoice.contact_id).toBe(c2.id);
    await settle(t);
  });
});
