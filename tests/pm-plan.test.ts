import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matches } from '../server/services/pm-automation.js';
import { nextOccurrence } from '../server/services/pm-recur.js';
import { day, setupPm, settle, type Pm } from './pm-helpers.js';

/**
 * Planning: dependencies and the Gantt (cascade, violations, critical path, baseline, auto-schedule), recurring
 * tasks, "Meine Aufgaben", calendar, workload, saved views, templates and automations.
 */

let p: Pm;
let t: Pm['t'];
const api = () => t.api;
const iso = (d: string) => `${d}T00:00:00.000Z`;
const task = async (body: Record<string, any>) => {
  const r = await api().post('/api/pm/tasks', body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const project = async (body: Record<string, any> = {}) => {
  const r = await api().post('/api/pm/projects', { name: `Projekt ${Math.random().toString(36).slice(2, 6)}`, ...body });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const get = async (id: string) => (await api().get(`/api/pm/tasks/${id}`)).data;
const dates = async (id: string) => {
  const x = (await get(id)).task;
  return [x.start_at?.slice(0, 10) ?? null, x.due_at?.slice(0, 10) ?? null];
};
const dep = (id: string, on: string, extra: Record<string, any> = {}) => api().post(`/api/pm/tasks/${id}/dependencies`, { depends_on: on, ...extra });
const gantt = async (id: string) => (await api().get(`/api/pm/projects/${id}/gantt`)).data;

beforeAll(async () => {
  p = await setupPm();
  t = p.t;
});
afterAll(() => t.close());

describe('dependencies', () => {
  it('validates links: no self, duplicates, cycles, other projects or parent/child pairs', async () => {
    const proj = await project({ name: 'Links' });
    const a = await task({ title: 'A', project_id: proj.id });
    const b = await task({ title: 'B', project_id: proj.id });
    const c = await task({ title: 'C', project_id: proj.id });
    const d = await task({ title: 'D', project_id: proj.id });
    expect((await dep(b.id, a.id)).data.blocked_by.map((x: any) => x.title)).toEqual(['A']);
    expect((await dep(c.id, b.id)).status).toBe(200);
    expect((await dep(d.id, c.id)).status).toBe(200);

    expect((await dep(a.id, a.id)).data.error).toContain('sich selbst');
    expect((await dep(b.id, a.id)).data.error).toContain('gibt es schon');
    // cycles of every length
    expect((await dep(a.id, b.id)).data.error).toContain('Zirkelbezug');
    expect((await dep(a.id, c.id)).data.error).toContain('Zirkelbezug');
    expect((await dep(a.id, d.id)).data.error).toContain('Zirkelbezug');
    expect((await dep(b.id, d.id)).status).toBe(400);
    // a diamond is fine
    expect((await dep(d.id, a.id)).status).toBe(200);
    // other project
    const other = await project({ name: 'Anderes' });
    const x = await task({ title: 'X', project_id: other.id });
    expect((await dep(x.id, a.id)).data.error).toContain('innerhalb eines Projekts');
    // parent and child may not depend on each other
    const kid = await task({ title: 'Kind', project_id: proj.id, parent_id: a.id });
    expect((await dep(kid.id, a.id)).data.error).toContain('Unter- oder Oberaufgabe');
    expect((await dep(a.id, kid.id)).status).toBe(400);
    // type and lag
    expect((await dep(kid.id, d.id, { type: 'XX' })).status).toBe(400);
    expect((await dep(kid.id, d.id, { lag: 1.5 })).status).toBe(400);
    expect((await dep(kid.id, d.id, { type: 'ss', lag: 2 })).data.blocked_by[0]).toMatchObject({ type: 'SS', lag: 2 });
    // moving a task under a task it depends on is refused too
    expect((await api().patch(`/api/pm/tasks/${b.id}`, { parent_id: a.id })).status).toBe(400);
  });

  it('flags blocked tasks until the predecessor is done and lets links be changed and removed', async () => {
    const proj = await project({ name: 'Blockiert' });
    const a = await task({ title: 'Vorher', project_id: proj.id });
    const b = await task({ title: 'Nachher', project_id: proj.id });
    await dep(b.id, a.id);
    expect((await get(b.id)).task).toMatchObject({ blocked: true, blocked_by: [a.id] });
    expect((await get(a.id)).task.blocking).toEqual([b.id]);
    await api().patch(`/api/pm/tasks/${a.id}`, { done: true });
    expect((await get(b.id)).task.blocked).toBe(false);
    const link = (await get(b.id)).dependencies.blocked_by[0];
    expect((await api().patch(`/api/pm/dependencies/${link.id}`, { type: 'FF', lag: -1 })).data).toMatchObject({ type: 'FF', lag: -1 });
    expect((await api().patch(`/api/pm/dependencies/${link.id}`, { type: 'nope' })).status).toBe(400);
    expect((await api().del(`/api/pm/dependencies/${link.id}`)).status).toBe(200);
    expect((await get(b.id)).dependencies.blocked_by).toEqual([]);
    expect((await api().del(`/api/pm/dependencies/${link.id}`)).status).toBe(404);
    // deleting a task drops its links
    const c = await task({ title: 'Weg', project_id: proj.id });
    await dep(c.id, a.id);
    await api().del(`/api/pm/tasks/${c.id}`);
    expect((await get(a.id)).dependencies.blocking).toEqual([]);
  });
});

describe('moving dates on the Gantt', () => {
  it('pushes dependent tasks, keeps their length and never pulls them earlier', async () => {
    const proj = await project({ name: 'Kaskade' });
    const A = await task({ title: 'A', project_id: proj.id, start_at: '2026-10-05', due_at: '2026-10-06' });
    const B = await task({ title: 'B', project_id: proj.id, start_at: '2026-10-07', due_at: '2026-10-08' });
    const C = await task({ title: 'C', project_id: proj.id, start_at: '2026-10-09', due_at: '2026-10-09' });
    const free = await task({ title: 'Ohne Link', project_id: proj.id, start_at: '2026-10-07', due_at: '2026-10-07' });
    await dep(B.id, A.id);
    await dep(C.id, B.id);

    const moved = (await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-07', due: '2026-10-08' })).data;
    expect(moved.task.start_at).toBe(iso('2026-10-07'));
    expect(moved.shifted.map((x: any) => x.title).sort()).toEqual(['B', 'C']);
    expect(await dates(B.id)).toEqual(['2026-10-09', '2026-10-10']);
    expect(await dates(C.id)).toEqual(['2026-10-11', '2026-10-11']);
    expect(await dates(free.id)).toEqual(['2026-10-07', '2026-10-07']);

    // earlier: successors stay
    await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-01', due: '2026-10-02' });
    expect(await dates(B.id)).toEqual(['2026-10-09', '2026-10-10']);
    // without cascade only the task itself moves, and the broken link is flagged
    await api().patch(`/api/pm/tasks/${B.id}/dates`, { start: '2026-10-01', due: '2026-10-02', cascade: false });
    expect(await dates(C.id)).toEqual(['2026-10-11', '2026-10-11']);
    expect((await gantt(proj.id)).deps.find((d: any) => d.task === B.id)).toMatchObject({ violated: true });
    await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-05', due: '2026-10-06', cascade: false });
    await api().patch(`/api/pm/tasks/${B.id}/dates`, { start: '2026-10-05', due: '2026-10-06', cascade: false });
    expect((await gantt(proj.id)).deps.find((d: any) => d.task === B.id)).toMatchObject({ violated: true });
    // activity records the cause of an automatic move
    await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-12', due: '2026-10-12' });
    expect((await get(B.id)).activity.find((a: any) => a.kind === 'dates' && a.data.cause === 'A')).toBeTruthy();
    // validation
    expect((await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-09', due: '2026-10-01' })).status).toBe(400);
    expect((await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: 'morgen' })).status).toBe(400);
  });

  it('leaves finished tasks where they are and skips weekends in a working-day project', async () => {
    const proj = await project({ name: 'Arbeitstage', skip_weekends: true });
    const A = await task({ title: 'A', project_id: proj.id, start_at: '2026-10-08', due_at: '2026-10-08' });
    const B = await task({ title: 'B', project_id: proj.id, start_at: '2026-10-09', due_at: '2026-10-09' });
    const C = await task({ title: 'C', project_id: proj.id, start_at: '2026-10-12', due_at: '2026-10-12', done: true });
    await dep(B.id, A.id);
    await dep(C.id, B.id);
    // A moves to Friday: B follows onto Monday (the weekend does not count) – C is done and stays
    const r = (await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-09', due: '2026-10-09' })).data;
    expect(await dates(B.id)).toEqual(['2026-10-12', '2026-10-12']);
    expect(r.blocked).toEqual([C.id]);
    expect(await dates(C.id)).toEqual(['2026-10-12', '2026-10-12']);
  });

  it('keeps the time of day of a timed task and moves single-date tasks as one day', async () => {
    const proj = await project({ name: 'Zeiten' });
    const A = await task({ title: 'Termin', project_id: proj.id, due_at: '2026-10-06T13:30:00.000Z' });
    await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-07', due: '2026-10-08' });
    const x = (await get(A.id)).task;
    expect(x.due_at).toBe('2026-10-08T13:30:00.000Z');
    expect(x.start_at).toBe(iso('2026-10-07'));
  });
});

describe('Gantt data, critical path, baseline and auto-schedule', () => {
  it('lists tasks in section and tree order with dates, float and critical flags', async () => {
    const proj = await project({ name: 'Gantt' });
    const s = (await api().post(`/api/pm/projects/${proj.id}/sections`, { name: 'Phase' })).data;
    const A = await task({ title: 'A', project_id: proj.id, section_id: s.id, start_at: '2026-10-05', due_at: '2026-10-06' });
    const B = await task({ title: 'B', project_id: proj.id, section_id: s.id, start_at: '2026-10-07', due_at: '2026-10-08', subtasks: [{ title: 'B1', start_at: '2026-10-07', due_at: '2026-10-07' }] });
    const C = await task({ title: 'C', project_id: proj.id, start_at: '2026-10-09', due_at: '2026-10-09' });
    const D = await task({ title: 'D (frei)', project_id: proj.id, start_at: '2026-10-05', due_at: '2026-10-05' });
    const E = await task({ title: 'E (ohne Datum)', project_id: proj.id });
    await dep(B.id, A.id);
    await dep(C.id, B.id);
    const g = await gantt(proj.id);
    expect(g.tasks.map((x: any) => `${x.depth}:${x.title}`)).toEqual(['0:A', '0:B', '1:B1', '0:C', '0:D (frei)', '0:E (ohne Datum)']);
    const by = (title: string) => g.tasks.find((x: any) => x.title === title);
    expect(by('A')).toMatchObject({ start: '2026-10-05', end: '2026-10-06', scheduled: true, critical: true, float: 0 });
    expect(by('C').critical).toBe(true);
    expect(by('D (frei)')).toMatchObject({ critical: false, float: 4 });
    expect(by('E (ohne Datum)')).toMatchObject({ scheduled: false, start: null, critical: false });
    expect(by('B').has_children).toBe(true);
    expect(by('B1').parent_id).toBe(B.id);
    expect(g.deps).toEqual(expect.arrayContaining([expect.objectContaining({ task: B.id, on: A.id, type: 'FS', critical: true, violated: false })]));
    expect(g.critical_end).toBe('2026-10-09');
    expect(g.bounds).toEqual({ start: '2026-10-05', end: '2026-10-09' });
    expect(g.sections.map((x: any) => x.name)).toEqual(['Phase']);
    expect(g.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // finished tasks drop out of the critical path
    await api().patch(`/api/pm/tasks/${A.id}`, { done: true });
    expect((await gantt(proj.id)).tasks.find((x: any) => x.title === 'A').critical).toBe(false);
    void E;
  });

  it('shows float when there is slack and marks only tight links', async () => {
    const proj = await project({ name: 'Puffer' });
    const A = await task({ title: 'A', project_id: proj.id, start_at: '2026-10-05', due_at: '2026-10-06' });
    const B = await task({ title: 'B', project_id: proj.id, start_at: '2026-10-12', due_at: '2026-10-12' });
    await dep(B.id, A.id);
    const g = await gantt(proj.id);
    expect(g.tasks.find((x: any) => x.title === 'A')).toMatchObject({ float: 5, critical: false });
    expect(g.tasks.find((x: any) => x.title === 'B')).toMatchObject({ float: 0, critical: true });
    expect(g.deps[0].critical).toBe(false);
  });

  it('records a baseline, shows it next to the new plan and clears it', async () => {
    const proj = await project({ name: 'Baseline' });
    const A = await task({ title: 'A', project_id: proj.id, start_at: '2026-10-05', due_at: '2026-10-06' });
    await task({ title: 'Ohne Datum', project_id: proj.id });
    const set = (await api().post(`/api/pm/projects/${proj.id}/baseline`)).data;
    expect(set).toMatchObject({ ok: true, tasks: 1 });
    await api().patch(`/api/pm/tasks/${A.id}/dates`, { start: '2026-10-12', due: '2026-10-14' });
    const g = await gantt(proj.id);
    expect(g.project.baseline_at).toBeTruthy();
    expect(g.tasks.find((x: any) => x.title === 'A')).toMatchObject({ start: '2026-10-12', baseline: { start: '2026-10-05', end: '2026-10-06' } });
    expect(g.bounds.start).toBe('2026-10-05');
    expect((await api().del(`/api/pm/projects/${proj.id}/baseline`)).status).toBe(200);
    const after = await gantt(proj.id);
    expect(after.project.baseline_at).toBeNull();
    expect(after.tasks.find((x: any) => x.title === 'A').baseline).toBeNull();
  });

  it('applies the dependencies: tasks with predecessors move as early as they may', async () => {
    const proj = await project({ name: 'Auto' });
    const A = await task({ title: 'A', project_id: proj.id, start_at: '2026-10-05', due_at: '2026-10-06' });
    const B = await task({ title: 'B', project_id: proj.id, start_at: '2026-10-19', due_at: '2026-10-20' });
    const C = await task({ title: 'C', project_id: proj.id, start_at: '2026-10-30', due_at: '2026-10-30' });
    await dep(B.id, A.id);
    await dep(C.id, B.id, { lag: 1 });
    const dry = (await api().post(`/api/pm/projects/${proj.id}/auto-schedule`, { dry_run: true })).data;
    expect(dry.changed).toBe(2);
    expect(await dates(B.id)).toEqual(['2026-10-19', '2026-10-20']);
    const done = (await api().post(`/api/pm/projects/${proj.id}/auto-schedule`)).data;
    expect(done.tasks.map((x: any) => [x.title, x.start])).toEqual([['B', '2026-10-07'], ['C', '2026-10-10']]);
    expect(await dates(B.id)).toEqual(['2026-10-07', '2026-10-08']);
    expect(await dates(C.id)).toEqual(['2026-10-10', '2026-10-10']);
    expect((await api().post(`/api/pm/projects/${proj.id}/auto-schedule`)).data.changed).toBe(0);
  });
});

describe('recurring tasks', () => {
  it('creates the next task once when a recurring task is completed', async () => {
    const proj = await project({ name: 'Wiederholung' });
    const due = day(1);
    const first = await task({
      title: 'Wöchentlicher Bericht',
      project_id: proj.id,
      due_at: due,
      assignees: [p.anna.id],
      tags: ['Bericht'],
      priority: 'high',
      checklists: [{ title: 'Punkte', items: [{ text: 'Zahlen holen', done: true }] }],
      subtasks: ['Entwurf'],
      recurrence: { freq: 'weekly', interval: 1 },
    });
    expect(first.recurrence_text).toBe('Wöchentlich');
    await api().patch(`/api/pm/tasks/${first.id}`, { done: true });
    const series = (await api().get(`/api/pm/tasks?project_id=${proj.id}&parent=none`)).data.tasks.filter((x: any) => x.title === 'Wöchentlicher Bericht');
    expect(series).toHaveLength(2);
    const next = series.find((x: any) => x.id !== first.id);
    expect(next.due_at.slice(0, 10)).toBe(nextOccurrence({ freq: 'weekly', interval: 1, mode: 'due', end: { type: 'never' } }, due));
    expect(next).toMatchObject({ done: false, status: { name: 'Offen' }, priority: 3, tags: ['Bericht'], series_id: first.id });
    expect(next.assignees.map((a: any) => a.id)).toEqual([p.anna.id]);
    expect(next.checklists[0].items[0]).toMatchObject({ text: 'Zahlen holen', done: false });
    expect(next.recurrence).toMatchObject({ freq: 'weekly', done: 1 });
    expect((await api().get(`/api/pm/tasks?parent=${next.id}`)).data.tasks.map((x: any) => [x.title, x.done])).toEqual([['Entwurf', false]]);
    // the finished one keeps no rule; reopening and completing again does not repeat it a second time
    expect((await get(first.id)).task.recurrence).toBeNull();
    await api().patch(`/api/pm/tasks/${first.id}`, { done: false });
    await api().patch(`/api/pm/tasks/${first.id}`, { done: true });
    expect((await api().get(`/api/pm/tasks?project_id=${proj.id}&parent=none`)).data.tasks.filter((x: any) => x.title === 'Wöchentlicher Bericht')).toHaveLength(2);
    // the new assignee was told about the new task
    expect((await get(next.id)).activity.some((a: any) => a.kind === 'created')).toBe(true);
    expect((await get(first.id)).activity.some((a: any) => a.kind === 'recurred')).toBe(true);
  });

  it('stops after the configured number of repetitions and counts from completion when asked', async () => {
    const proj = await project({ name: 'Begrenzt' });
    const first = await task({ title: 'Dreimal', project_id: proj.id, due_at: day(1), recurrence: { freq: 'daily', interval: 2, end: { type: 'count', count: 2 } } });
    let current = first.id;
    for (let i = 0; i < 3; i++) {
      await api().patch(`/api/pm/tasks/${current}`, { done: true });
      const open = (await api().get(`/api/pm/tasks?project_id=${proj.id}&done=0`)).data.tasks;
      if (!open.length) break;
      current = open[0].id;
    }
    const all = (await api().get(`/api/pm/tasks?project_id=${proj.id}`)).data.tasks;
    expect(all).toHaveLength(3);
    expect(all.every((x: any) => x.done)).toBe(true);

    const fromDone = await task({ title: 'Ab Erledigung', project_id: proj.id, due_at: day(-5), recurrence: { freq: 'daily', interval: 3, mode: 'completion' } });
    await api().patch(`/api/pm/tasks/${fromDone.id}`, { done: true });
    const next = (await api().get(`/api/pm/tasks?project_id=${proj.id}&done=0`)).data.tasks.find((x: any) => x.title === 'Ab Erledigung');
    expect(next.due_at.slice(0, 10)).toBe(day(3));
  });

  it('keeps a monthly rule on its day, validates the rule and keeps start-to-due spans', async () => {
    const proj = await project({ name: 'Monatlich' });
    const m = await task({ title: 'Monatsabschluss', project_id: proj.id, start_at: '2099-01-29', due_at: '2099-01-31', recurrence: { freq: 'monthly', interval: 1 } });
    expect(m.recurrence.day_of_month).toBe(31);
    await api().patch(`/api/pm/tasks/${m.id}`, { done: true });
    let open = (await api().get(`/api/pm/tasks?project_id=${proj.id}&done=0`)).data.tasks[0];
    expect([open.start_at.slice(0, 10), open.due_at.slice(0, 10)]).toEqual(['2099-02-26', '2099-02-28']);
    await api().patch(`/api/pm/tasks/${open.id}`, { done: true });
    open = (await api().get(`/api/pm/tasks?project_id=${proj.id}&done=0`)).data.tasks[0];
    expect(open.due_at.slice(0, 10)).toBe('2099-03-31');
    expect((await api().patch(`/api/pm/tasks/${open.id}`, { recurrence: { freq: 'hourly' } })).status).toBe(400);
    expect((await api().patch(`/api/pm/tasks/${open.id}`, { recurrence: null })).data.recurrence).toBeNull();
  });
});

describe('my tasks, calendar and workload', () => {
  it('groups "Meine Aufgaben" by due day across projects', async () => {
    const one = await project({ name: 'Projekt Eins' });
    const two = await project({ name: 'Projekt Zwei' });
    const anna = p.anna.id;
    await task({ title: 'Überfällig', project_id: one.id, assignees: [anna], due_at: day(-2) });
    await task({ title: 'Heute', project_id: two.id, assignees: [anna], due_at: day(0) });
    await task({ title: 'Diese Woche', project_id: one.id, assignees: [anna], due_at: day(3) });
    await task({ title: 'Später', project_id: two.id, assignees: [anna], due_at: day(30) });
    await task({ title: 'Ohne Datum', project_id: one.id, assignees: [anna] });
    await task({ title: 'Fertig', project_id: one.id, assignees: [anna], status: 'Erledigt' });
    await task({ title: 'Nicht meine', project_id: one.id, assignees: [p.ben.id], due_at: day(0) });
    const me = await p.login(p.anna.email);
    const r = (await me('GET', '/api/pm/my-tasks')).data;
    const names = (b: string) => r.buckets[b].filter((x: any) => [one.id, two.id].includes(x.project_id)).map((x: any) => x.title);
    expect(names('overdue')).toEqual(['Überfällig']);
    expect(names('today')).toEqual(['Heute']);
    expect(names('week')).toEqual(['Diese Woche']);
    expect(names('later')).toEqual(['Später']);
    expect(names('nodate')).toEqual(['Ohne Datum']);
    expect(r.buckets.today.find((x: any) => x.title === 'Heute').project.name).toBe('Projekt Zwei');
    expect(r.counts.today).toBeGreaterThanOrEqual(1);
    // a key has no person: it must say whose tasks
    const key = (await api().post('/api/api-keys', { name: 'Test' })).data.key;
    const viaKey = await api().get('/api/pm/my-tasks', { authorization: `Bearer ${key}` });
    expect(viaKey.status).toBe(400);
    const named = await api().get(`/api/pm/my-tasks?user_id=${anna}`, { authorization: `Bearer ${key}` });
    expect(named.status).toBe(200);
    expect(named.data.buckets.today.some((x: any) => x.title === 'Heute')).toBe(true);
  });

  it('finds tasks for a calendar window, including multi-day ones', async () => {
    const proj = await project({ name: 'Kalender' });
    await task({ title: 'Mehrtägig', project_id: proj.id, start_at: '2026-11-02', due_at: '2026-11-06' });
    await task({ title: 'Am Tag', project_id: proj.id, due_at: '2026-11-04' });
    await task({ title: 'Davor', project_id: proj.id, due_at: '2026-10-30' });
    await task({ title: 'Danach', project_id: proj.id, start_at: '2026-11-09', due_at: '2026-11-10' });
    await task({ title: 'Ohne Datum', project_id: proj.id });
    const win = async (from: string, to: string) => (await api().get(`/api/pm/tasks?project_id=${proj.id}&from=${from}&to=${to}`)).data.tasks.map((x: any) => x.title).sort();
    expect(await win('2026-11-04', '2026-11-04')).toEqual(['Am Tag', 'Mehrtägig']);
    expect(await win('2026-11-01', '2026-11-08')).toEqual(['Am Tag', 'Mehrtägig']);
    expect(await win('2026-11-06', '2026-11-09')).toEqual(['Danach', 'Mehrtägig']);
    expect(await win('2026-10-01', '2026-10-31')).toEqual(['Davor']);
  });

  it('spreads estimates over the days into a workload per person', async () => {
    const proj = await project({ name: 'Auslastung' });
    const mon = '2030-06-03'; // a Monday
    await task({ title: 'Anna 10h', project_id: proj.id, assignees: [p.anna.id], start_at: mon, due_at: '2030-06-07', estimate_hours: 10 });
    await task({ title: 'Gemeinsam', project_id: proj.id, assignees: [p.anna.id, p.ben.id], start_at: mon, due_at: '2030-06-04', estimate_hours: 8 });
    await task({ title: 'Niemand', project_id: proj.id, due_at: '2030-06-05', estimate_hours: 2 });
    await task({ title: 'Erledigt', project_id: proj.id, assignees: [p.anna.id], due_at: mon, estimate_hours: 50, status: 'Erledigt' });
    const w = (await api().get(`/api/pm/workload?project_id=${proj.id}&from=${mon}&to=2030-06-09`)).data;
    expect(w.days).toHaveLength(7);
    expect(w.weekend_days).toEqual(['2030-06-08', '2030-06-09']);
    const anna = w.people.find((x: any) => x.id === p.anna.id);
    // Monday: 2h from the 10h task + 2h (half of 4h/day) from the shared one
    expect(anna.load[mon]).toBe(120 + 120);
    expect(anna.load['2030-06-05']).toBe(120);
    expect(anna.total_minutes).toBe(600 + 240);
    expect(anna.capacity_minutes).toBe(40 * 60);
    expect(w.people.find((x: any) => x.id === p.ben.id).total_minutes).toBe(240);
    expect(w.unassigned.total_minutes).toBe(120);
    expect(w.capacity_per_day_minutes).toBe(480);
    expect((await api().get('/api/pm/workload?from=2030-06-09&to=2030-06-01')).status).toBe(400);
    expect((await api().get('/api/pm/workload?from=2030-01-01&to=2031-01-01')).status).toBe(400);
  });
});

describe('saved views', () => {
  it('keeps personal views private, lets the leadership share one and limits editing to the owner', async () => {
    const proj = await project({ name: 'Ansichten' });
    const anna = await p.login(p.anna.email);
    const ben = await p.login(p.ben.email);
    const mine = (await anna('POST', '/api/pm/views', { name: 'Meine offenen', kind: 'board', project_id: proj.id, config: { assignee: 'me', done: '0' } })).data;
    expect(mine).toMatchObject({ name: 'Meine offenen', kind: 'board', shared: false, config: { assignee: 'me' } });
    expect((await ben('GET', `/api/pm/views?project_id=${proj.id}`)).data).toEqual([]);
    expect((await anna('GET', `/api/pm/views?project_id=${proj.id}`)).data.map((v: any) => v.name)).toEqual(['Meine offenen']);
    // a member's "shared" is ignored; the admin's is honoured and everyone sees it
    expect((await anna('POST', '/api/pm/views', { name: 'Heimlich geteilt', shared: true, config: {} })).data.shared).toBe(false);
    const shared = (await api().post('/api/pm/views', { name: 'Für alle', kind: 'gantt', project_id: proj.id, shared: true, config: { zoom: 'week' } })).data;
    expect(shared.shared).toBe(true);
    expect((await ben('GET', `/api/pm/views?project_id=${proj.id}`)).data.map((v: any) => v.name)).toEqual(['Für alle']);
    // editing: owner or leadership
    expect((await ben('PATCH', `/api/pm/views/${shared.id}`, { name: 'Gekapert' })).status).toBe(400);
    expect((await ben('DELETE', `/api/pm/views/${mine.id}`)).status).toBe(400);
    expect((await anna('PATCH', `/api/pm/views/${mine.id}`, { name: 'Umbenannt', config: { assignee: 'none' } })).data).toMatchObject({ name: 'Umbenannt', config: { assignee: 'none' } });
    expect((await api().patch(`/api/pm/views/${mine.id}`, { shared: true })).data.shared).toBe(true);
    expect((await anna('DELETE', `/api/pm/views/${mine.id}`)).status).toBe(200);
    // unknown kinds fall back to a list; huge configs and foreign projects are refused
    expect((await anna('POST', '/api/pm/views', { name: 'Komisch', kind: 'pie', config: {} })).data.kind).toBe('list');
    expect((await anna('POST', '/api/pm/views', { name: 'Riesig', config: { x: 'y'.repeat(9000) } })).status).toBe(400);
    expect((await anna('POST', '/api/pm/views', { name: 'Fremd', project_id: 'gibts-nicht', config: {} })).status).toBe(404);
    expect((await anna('POST', '/api/pm/views', { name: '', config: {} })).status).toBe(400);
  });
});

describe('project templates', () => {
  it('lists the two built-in templates and builds a project from "Website-Projekt" with dates, links and statuses', async () => {
    const list = (await api().get('/api/pm/templates')).data;
    expect(list.projects.filter((x: any) => x.builtin).map((x: any) => x.id).sort()).toEqual(['kunden-onboarding', 'website-projekt']);
    const proj = await project({ name: 'Neue Website', template: 'website-projekt', start: '2026-10-05' });
    expect(proj).toMatchObject({ skip_weekends: true, template_key: 'website-projekt' });
    expect(proj.start_at).toBe(iso('2026-10-05'));
    const full = (await api().get(`/api/pm/projects/${proj.id}`)).data;
    expect(full.statuses.map((s: any) => s.name)).toEqual(['Backlog', 'In Arbeit', 'Review', 'Freigabe Kunde', 'Fertig']);
    expect(full.sections.map((s: any) => s.name)).toEqual(['Konzept', 'Design', 'Entwicklung', 'Inhalte', 'Launch']);
    expect(full.fields.map((f: any) => f.key)).toEqual(['seiten']);
    const g = await gantt(proj.id);
    expect(g.tasks).toHaveLength(18);
    const by = (title: string) => g.tasks.find((x: any) => x.title === title);
    expect(by('Anforderungen und Ziele klären')).toMatchObject({ start: '2026-10-05', end: '2026-10-07' });
    expect(by('Konzept-Freigabe durch den Kunden')).toMatchObject({ milestone: true, start: '2026-10-14', end: '2026-10-14' });
    expect(by('Konzept-Freigabe durch den Kunden').status.name).toBe('Freigabe Kunde');
    expect(g.deps).toHaveLength(12);
    // the recipe is consistent: no link is broken and the whole chain is critical
    expect(g.deps.filter((d: any) => d.violated)).toEqual([]);
    expect(by('Go-live').critical).toBe(true);
    expect(g.critical_end).toBe('2026-11-27');
    // subtasks and checklists came along
    expect(g.tasks.filter((x: any) => x.depth === 1)).toHaveLength(6);
    // a subtask without dates of its own takes its parent's
    expect(g.tasks.find((x: any) => x.title === 'Zielgruppe und Wettbewerber')).toMatchObject({ start: '2026-10-05', end: '2026-10-07' });
    const test = (await api().get(`/api/pm/tasks?project_id=${proj.id}&q=Test und Fehler`)).data.tasks[0];
    expect(test.checklists[0].items).toHaveLength(5);
  });

  it('builds "Kunden-Onboarding" with its rule and shifts every date with the start day', async () => {
    const a = await project({ name: 'Onboarding A', template: 'kunden-onboarding', start: '2026-10-05' });
    const b = await project({ name: 'Onboarding B', template: 'kunden-onboarding', start: '2026-11-02' });
    const ga = await gantt(a.id);
    const gb = await gantt(b.id);
    expect(ga.tasks).toHaveLength(17);
    expect(ga.deps.filter((d: any) => d.violated)).toEqual([]);
    const kickoff = (g: any) => g.tasks.find((x: any) => x.title === 'Kick-off durchführen');
    expect(kickoff(ga)).toMatchObject({ milestone: true, start: '2026-10-12' });
    expect(kickoff(gb).start).toBe('2026-11-09');
    expect((await api().get(`/api/pm/automations?project_id=${a.id}`)).data.map((r: any) => r.name)).toEqual(['Nach dem Kick-off: Protokoll-Aufgabe anlegen']);
    expect((await api().post('/api/pm/projects', { name: 'X', template: 'gibt-es-nicht' })).status).toBe(404);
  });

  it('saves a project as a template and builds a new one from it with relative dates', async () => {
    const src = await project({ name: 'Mein Ablauf' });
    await api().post(`/api/pm/projects/${src.id}/statuses`, { name: 'Abnahme', category: 'active' });
    const s = (await api().post(`/api/pm/projects/${src.id}/sections`, { name: 'Start' })).data;
    const a = await task({ title: 'Anfang', project_id: src.id, section_id: s.id, start_at: '2026-10-05', due_at: '2026-10-06', estimate_hours: 3, tags: ['wichtig'], subtasks: ['Unterpunkt'] });
    const b = await task({ title: 'Ende', project_id: src.id, start_at: '2026-10-07', due_at: '2026-10-09', status: 'Abnahme' });
    await dep(b.id, a.id, { lag: 0 });
    const saved = (await api().post(`/api/pm/projects/${src.id}/save-template`, { name: 'Ablauf-Vorlage' })).data;
    expect(saved).toMatchObject({ name: 'Ablauf-Vorlage', tasks: 2 });
    expect((await api().get('/api/pm/templates')).data.projects.find((x: any) => x.id === saved.id)).toMatchObject({ builtin: false, tasks: 2 });
    const copy = await project({ name: 'Aus Vorlage', template: saved.id, start: '2026-12-07' });
    const g = await gantt(copy.id);
    expect(g.tasks.map((x: any) => [x.title, x.start, x.end])).toEqual([['Anfang', '2026-12-07', '2026-12-08'], ['Unterpunkt', null, null], ['Ende', '2026-12-09', '2026-12-11']]);
    expect(g.deps).toHaveLength(1);
    expect(g.tasks.find((x: any) => x.title === 'Ende').status.name).toBe('Abnahme');
    expect(g.statuses.map((x: any) => x.name)).toContain('Abnahme');
    // task templates
    const tt = (await api().post('/api/pm/templates', { name: 'Rückruf', data: { title: 'Kunden zurückrufen', priority: 'high', due_in_days: 1, checklist: [{ title: 'Fragen', items: ['Budget', 'Termin'] }], subtasks: ['Notizen ablegen'] } })).data;
    expect(tt.data).toMatchObject({ title: 'Kunden zurückrufen', due_in_days: 1 });
    expect((await api().get('/api/pm/templates')).data.tasks.map((x: any) => x.name)).toEqual(['Rückruf']);
    expect((await api().post('/api/pm/templates', { name: 'Leer', data: {} })).status).toBe(400);
    expect((await api().del(`/api/pm/templates/${tt.id}`)).status).toBe(200);
    expect((await api().del(`/api/pm/templates/${tt.id}`)).status).toBe(404);
  });
});

describe('automations', () => {
  const rule = async (body: Record<string, any>) => {
    const r = await api().post('/api/pm/automations', body);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };

  it('creates a task from a template when a task is completed, and moves/assigns on a status change', async () => {
    const proj = await project({ name: 'Regeln' });
    const tpl = (await api().post('/api/pm/templates', { name: 'Nachfassen', data: { title: 'Nachfassen: {{title}}', priority: 'high', due_in_days: 2, subtasks: ['Anrufen'] } })).data;
    const r1 = await rule({ name: 'Nach Angebot nachfassen', project_id: proj.id, trigger: 'task.completed', conditions: { title_contains: 'Angebot' }, actions: [{ type: 'create_task', template_id: tpl.id, assignee: 'same' }] });
    const review = (await api().get(`/api/pm/projects/${proj.id}/statuses`)).data.find((s: any) => s.name === 'In Prüfung');
    const r2 = await rule({ name: 'Prüfung an Ben', project_id: proj.id, trigger: 'task.status_changed', conditions: { status_id: review.id }, actions: [{ type: 'assign', mode: 'add', user_id: p.ben.id }, { type: 'set_priority', priority: 4 }, { type: 'add_tag', tag: 'prüfen' }] });

    const offer = await task({ title: 'Angebot erstellen', project_id: proj.id, assignees: [p.anna.id] });
    const other = await task({ title: 'Etwas anderes', project_id: proj.id });
    await api().patch(`/api/pm/tasks/${other.id}`, { done: true });
    await settle(t);
    expect((await api().get(`/api/pm/tasks?project_id=${proj.id}&q=Nachfassen`)).data.total).toBe(0);
    await api().patch(`/api/pm/tasks/${offer.id}`, { done: true });
    await settle(t);
    const made = (await api().get(`/api/pm/tasks?project_id=${proj.id}&q=Nachfassen`)).data.tasks;
    expect(made).toHaveLength(1);
    const top = made[0];
    expect((await api().get(`/api/pm/tasks?parent=${top.id}`)).data.tasks.map((x: any) => x.title)).toEqual(['Anrufen']);
    expect(top).toMatchObject({ title: 'Nachfassen: Angebot erstellen', priority: 3, project_id: proj.id });
    expect(top.due_at.slice(0, 10)).toBe(day(2));
    expect(top.assignees.map((a: any) => a.id)).toEqual([p.anna.id]);
    expect((await api().get(`/api/pm/automations?project_id=${proj.id}`)).data.find((r: any) => r.id === r1.id)).toMatchObject({ runs: 1, last_error: null });
    // recorded in the audit log with the rule's name
    expect(t.app.db.get(`SELECT actor, summary FROM audit_log WHERE action = 'pm.automation.run' AND actor LIKE ? ORDER BY at DESC`, '%Nach Angebot nachfassen%')).toBeTruthy();

    const x = await task({ title: 'Layout', project_id: proj.id });
    await api().post(`/api/pm/tasks/${x.id}/move`, { status_id: review.id });
    await settle(t);
    const after = (await get(x.id)).task;
    expect(after).toMatchObject({ priority: 4, tags: ['prüfen'] });
    expect(after.assignees.map((a: any) => a.id)).toEqual([p.ben.id]);
    expect((await api().get(`/api/pm/automations?project_id=${proj.id}`)).data.find((r: any) => r.id === r2.id).runs).toBe(1);
    // a disabled rule stays quiet
    await api().patch(`/api/pm/automations/${r2.id}`, { enabled: false });
    const y = await task({ title: 'Noch ein Layout', project_id: proj.id });
    await api().post(`/api/pm/tasks/${y.id}/move`, { status_id: review.id });
    await settle(t);
    expect((await get(y.id)).task.assignees).toEqual([]);
  });

  it('cannot loop: a rule never runs twice in one chain and chains stop after three levels', async () => {
    const proj = await project({ name: 'Schleife' });
    const st = (await api().get(`/api/pm/projects/${proj.id}/statuses`)).data;
    const working = st.find((s: any) => s.name === 'In Arbeit');
    const review = st.find((s: any) => s.name === 'In Prüfung');
    const a = await rule({ name: 'Arbeit → Prüfung', project_id: proj.id, trigger: 'task.status_changed', conditions: { status_id: working.id }, actions: [{ type: 'move_status', status_id: review.id }] });
    const b = await rule({ name: 'Prüfung → Arbeit', project_id: proj.id, trigger: 'task.status_changed', conditions: { status_id: review.id }, actions: [{ type: 'move_status', status_id: working.id }] });
    const x = await task({ title: 'Pingpong', project_id: proj.id });
    await api().post(`/api/pm/tasks/${x.id}/move`, { status_id: working.id });
    await settle(t);
    const rules = (await api().get(`/api/pm/automations?project_id=${proj.id}`)).data;
    expect(rules.find((r: any) => r.id === a.id).runs).toBe(1);
    expect(rules.find((r: any) => r.id === b.id).runs).toBe(1);
    expect((await get(x.id)).task.status.name).toBe('In Arbeit');
  });

  it('announces overdue tasks once, fires the overdue rule and notifies the people involved', async () => {
    const proj = await project({ name: 'Überfällig' });
    await rule({ name: 'Überfällig markieren', project_id: proj.id, trigger: 'task.overdue', actions: [{ type: 'add_tag', tag: 'überfällig' }] });
    const x = await task({ title: 'Zu spät', project_id: proj.id, assignees: [p.anna.id], due_at: day(-3) });
    await task({ title: 'Noch Zeit', project_id: proj.id, assignees: [p.anna.id], due_at: day(3) });
    const done = await task({ title: 'Schon erledigt', project_id: proj.id, due_at: day(-3), status: 'Erledigt' });
    expect(t.app.services.pmScan.overdue()).toBeGreaterThanOrEqual(1);
    await settle(t);
    expect((await get(x.id)).task.tags).toEqual(['überfällig']);
    expect((await get(done.id)).task.tags).toEqual([]);
    const anna = await p.login(p.anna.email);
    const items = (await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.kind === 'overdue' && n.task_id === x.id);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Überfällig: Zu spät');
    // the same due date is announced only once
    t.app.services.pmScan.overdue();
    await settle(t);
    expect((await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.kind === 'overdue' && n.task_id === x.id)).toHaveLength(1);
    // a new due date is announced again
    await api().patch(`/api/pm/tasks/${x.id}`, { due_at: day(-1) });
    t.app.services.pmScan.overdue();
    await settle(t);
    expect((await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.kind === 'overdue' && n.task_id === x.id)).toHaveLength(2);
  });

  it('tells assignees and watchers about tasks due today, from 8:00 local time, once per day', async () => {
    const pushes: any[] = [];
    const realPush = t.app.services.pushNotify;
    t.app.services.pushNotify = async (n: any) => void pushes.push(n);
    const proj = await project({ name: 'Heute fällig' });
    const x = await task({ title: 'Heute dran', project_id: proj.id, assignees: [p.anna.id, p.ben.id], due_at: '2030-06-15' });
    expect(t.app.services.pmScan.dueToday(new Date('2030-06-15T04:00:00Z'))).toBe(0); // 06:00 in Berlin
    pushes.length = 0;
    // Anna and Ben are assigned, Chef watches (he created the task)
    expect(t.app.services.pmScan.dueToday(new Date('2030-06-15T09:00:00Z'))).toBe(3);
    const anna = await p.login(p.anna.email);
    expect((await anna('GET', '/api/pm/notifications')).data.items.find((n: any) => n.kind === 'due' && n.task_id === x.id)).toMatchObject({ title: 'Heute fällig: Heute dran' });
    // the first assignee's push comes from the push module; everyone else is pushed here
    expect(pushes.map((n) => n.userIds[0])).toEqual([p.ben.id, p.chef]);
    expect(t.app.services.pmScan.dueToday(new Date('2030-06-15T10:00:00Z'))).toBe(0);
    expect(t.app.services.pmScan.dueToday(new Date('2030-06-16T09:00:00Z'))).toBe(0);
    t.app.services.pushNotify = realPush;
  });

  it('validates rules and scopes them to a project or the whole sub-account', async () => {
    const proj = await project({ name: 'Gültigkeit' });
    const bad = async (body: Record<string, any>) => (await api().post('/api/pm/automations', body)).status;
    expect(await bad({ name: 'x', trigger: 'task.exploded', actions: [{ type: 'add_tag', tag: 'a' }] })).toBe(400);
    expect(await bad({ name: 'x', trigger: 'task.created', actions: [] })).toBe(400);
    expect(await bad({ name: 'x', trigger: 'task.created', actions: [{ type: 'format_disk' }] })).toBe(400);
    expect(await bad({ name: 'x', trigger: 'task.created', actions: [{ type: 'create_task', template_id: 'gibts-nicht' }] })).toBe(400);
    expect(await bad({ name: 'x', trigger: 'task.created', actions: [{ type: 'move_status' }] })).toBe(400);
    expect(await bad({ name: 'x', trigger: 'task.created', actions: [{ type: 'assign', user_id: '' }] })).toBe(400);
    expect(await bad({ name: 'x', trigger: 'task.created', project_id: 'gibts-nicht', actions: [{ type: 'add_tag', tag: 'a' }] })).toBe(404);
    expect(await bad({ name: '', trigger: 'task.created', actions: [{ type: 'add_tag', tag: 'a' }] })).toBe(400);
    const everywhere = await rule({ name: 'Überall', trigger: 'task.created', actions: [{ type: 'add_tag', tag: 'neu' }] });
    const only = await rule({ name: 'Nur hier', project_id: proj.id, trigger: 'task.created', actions: [{ type: 'set_priority', priority: 2 }] });
    const here = await task({ title: 'Hier', project_id: proj.id });
    const elsewhere = await task({ title: 'Woanders' });
    await settle(t);
    expect((await get(here.id)).task).toMatchObject({ tags: ['neu'], priority: 2 });
    expect((await get(elsewhere.id)).task).toMatchObject({ tags: ['neu'], priority: 0 });
    expect((await api().patch(`/api/pm/automations/${only.id}`, { name: 'Umbenannt', trigger: 'task.assigned' })).data).toMatchObject({ name: 'Umbenannt', trigger: 'task.assigned' });
    expect((await api().del(`/api/pm/automations/${everywhere.id}`)).status).toBe(200);
    expect((await api().del(`/api/pm/automations/${everywhere.id}`)).status).toBe(404);
  });

  it('matches conditions: status, category, priority, tag, assignee, title and section', () => {
    const task: any = { priority: 2, tags: ['Eilig'], status_id: 's1', status: { category: 'active' }, assignees: [{ id: 'u1' }], title: 'Angebot für Kunde', section_id: 'sec1' };
    expect(matches({}, task, {})).toBe(true);
    expect(matches({ status_id: 's1' }, task, { to: { id: 's2' } })).toBe(false);
    expect(matches({ status_id: 's2' }, task, { to: { id: 's2' } })).toBe(true);
    expect(matches({ to_category: 'done' }, task, { to: { category: 'done' } })).toBe(true);
    expect(matches({ to_category: 'done' }, task, {})).toBe(false);
    expect(matches({ from_status_id: 'a' }, task, { from: { id: 'b' } })).toBe(false);
    expect(matches({ priority_min: 3 }, task, {})).toBe(false);
    expect(matches({ priority_min: 2 }, task, {})).toBe(true);
    expect(matches({ tag: 'eilig' }, task, {})).toBe(true);
    expect(matches({ tag: 'ruhig' }, task, {})).toBe(false);
    expect(matches({ assignee: 'u2' }, task, {})).toBe(false);
    expect(matches({ assignee: 'u2' }, task, { userIds: ['u2'] })).toBe(true);
    expect(matches({ title_contains: 'angebot' }, task, {})).toBe(true);
    expect(matches({ section_id: 'x' }, task, {})).toBe(false);
  });
});
