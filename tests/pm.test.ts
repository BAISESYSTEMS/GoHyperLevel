import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/core/app.js';
import { MODULES } from '../server/modules/index.js';
import { day, setupPm, settle, type Pm } from './pm-helpers.js';

/**
 * The planner: migration of existing tasks, the old task API next to it, projects, statuses, subtasks and their
 * validation, fields, people, bulk edits, comments with mentions, notifications and attachments.
 */

let p: Pm;
let t: Pm['t'];
let A: string;
const api = () => t.api;
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
const statusOf = async (projectId: string, name: string) => (await api().get(`/api/pm/projects/${projectId}/statuses`)).data.find((s: any) => s.name === name);

beforeAll(async () => {
  p = await setupPm();
  t = p.t;
  A = p.A;
});
afterAll(() => t.close());

describe('migration of existing tasks', () => {
  it('puts every task into a default "Allgemein" project per sub-account, with status, done flag and assignee', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pghl-mig-'));
    const cfg = { port: 0, host: '127.0.0.1', dataDir: dir, dbFile: join(dir, 'm.db'), baseUrl: 'http://localhost', webDir: join(dir, 'web'), behindProxy: false, tickMs: 0, secret: 's' };
    try {
      // The database as it was before the planner: everything except the pm modules.
      const before = createApp(cfg, MODULES.slice(0, MODULES.findIndex((m) => m.name === 'pm')));
      const iso = '2026-09-01T10:00:00.000Z';
      const { db } = before.app;
      db.insert('locations', { id: 'locA', name: 'Alt A', created_at: iso });
      db.insert('locations', { id: 'locB', name: 'Alt B', created_at: iso });
      db.insert('locations', { id: 'locC', name: 'Ohne Aufgaben', created_at: iso });
      db.insert('users', { id: 'u1', email: 'u1@example.com', name: 'U Eins', password_hash: 'x', role: 'member', locations: '["locA"]', created_at: iso });
      db.insert('tasks', { id: 't1', location_id: 'locA', title: 'Offen', done: 0, assigned_to: 'u1', due_at: '2026-10-10T00:00:00.000Z', created_at: iso });
      db.insert('tasks', { id: 't2', location_id: 'locA', title: 'Fertig', done: 1, completed_at: iso, created_at: iso });
      db.insert('tasks', { id: 't3', location_id: 'locB', title: 'Andere Firma', done: 0, created_at: iso });
      await before.close();

      const after = createApp(cfg, MODULES);
      const q = after.app.db;
      const projects = q.all('SELECT * FROM pm_projects ORDER BY location_id');
      expect(projects.map((x) => [x.location_id, x.name, x.is_default])).toEqual([['locA', 'Allgemein', 1], ['locB', 'Allgemein', 1], ['locC', 'Allgemein', 1]]);
      const row = (id: string) => q.get(`SELECT t.*, s.name AS status, s.category, p.location_id AS plocation FROM tasks t JOIN pm_statuses s ON s.id = t.status_id JOIN pm_projects p ON p.id = t.project_id WHERE t.id = ?`, id)!;
      expect(row('t1')).toMatchObject({ status: 'Offen', category: 'todo', done: 0, plocation: 'locA', parent_id: null, priority: 0, tags: '[]' });
      expect(row('t2')).toMatchObject({ status: 'Erledigt', category: 'done', done: 1, plocation: 'locA' });
      // other sub-accounts keep their own project
      expect(row('t3').plocation).toBe('locB');
      expect(q.all('SELECT user_id FROM pm_assignees WHERE task_id = ?', 't1').map((x) => x.user_id)).toEqual(['u1']);
      expect(q.all('SELECT name, category FROM pm_statuses WHERE project_id = ? ORDER BY position', row('t1').project_id).map((s) => s.name)).toEqual(['Offen', 'In Arbeit', 'In Prüfung', 'Erledigt']);
      // untouched columns survive
      expect(q.get('SELECT title, due_at, completed_at FROM tasks WHERE id = ?', 't1')).toMatchObject({ title: 'Offen', due_at: '2026-10-10T00:00:00.000Z' });
      await after.close();

      // opening it a second time changes nothing (migrations run once)
      const again = createApp(cfg, MODULES);
      expect(again.app.db.get('SELECT COUNT(*) AS n FROM pm_projects')!.n).toBe(3);
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adopts tasks other code writes later (no project given) into the default project', async () => {
    const before = (await api().get('/api/pm/projects')).data.find((x: any) => x.is_default);
    t.app.db.insert('tasks', { id: 'raw-1', location_id: A, title: 'Direkt eingetragen', done: 0, created_at: new Date().toISOString() });
    t.app.db.insert('tasks', { id: 'raw-2', location_id: A, title: 'Direkt erledigt', done: 1, completed_at: new Date().toISOString(), created_at: new Date().toISOString() });
    const list = (await api().get(`/api/pm/tasks?project_id=${before.id}`)).data.tasks;
    expect(list.find((x: any) => x.id === 'raw-1')).toMatchObject({ project: { name: 'Allgemein' }, status: { name: 'Offen' }, done: false });
    expect(list.find((x: any) => x.id === 'raw-2')).toMatchObject({ status: { name: 'Erledigt' }, done: true });
  });
});

describe('the plain task list keeps working', () => {
  it('creates, completes, reopens, reassigns and deletes through /api/tasks – and the planner follows', async () => {
    const created = (await api().post('/api/tasks', { title: 'Alt-API Aufgabe', due_at: `${day(3)}T00:00:00.000Z` })).data;
    expect(created).toMatchObject({ title: 'Alt-API Aufgabe', done: 0, assigned_to: p.chef });
    let t1 = await get(created.id);
    expect(t1.task).toMatchObject({ project: { name: 'Allgemein' }, status: { name: 'Offen', category: 'todo' }, done: false });
    expect(t1.task.assignees.map((a: any) => a.id)).toEqual([p.chef]);

    await api().patch(`/api/tasks/${created.id}`, { done: true });
    t1 = await get(created.id);
    expect(t1.task).toMatchObject({ done: true, status: { name: 'Erledigt' } });
    expect(t1.task.completed_at).toBeTruthy();
    await api().patch(`/api/tasks/${created.id}`, { done: false });
    expect((await get(created.id)).task).toMatchObject({ done: false, status: { name: 'Offen' } });

    // legacy reassignment replaces the assignee list
    await api().patch(`/api/tasks/${created.id}`, { assigned_to: p.anna.id });
    expect((await get(created.id)).task.assignees.map((a: any) => a.id)).toEqual([p.anna.id]);

    // planner assignment keeps the legacy column at the first person
    await api().patch(`/api/pm/tasks/${created.id}`, { assignees: [p.ben.id, p.anna.id] });
    const legacy = (await api().get('/api/tasks?status=all')).data.find((x: any) => x.id === created.id);
    expect(legacy.assigned_to).toBe(p.ben.id);
    expect((await get(created.id)).task.assignees.map((a: any) => a.id)).toEqual([p.ben.id, p.anna.id]);

    expect((await api().del(`/api/tasks/${created.id}`)).status).toBe(200);
    expect((await api().get(`/api/pm/tasks/${created.id}`)).status).toBe(404);
  });

  it('keeps the old list shape (legacy fields) and completes through events', async () => {
    const got: string[] = [];
    t.app.events.on('task.completed', (e) => void got.push(e.data.task.id));
    const x = await task({ title: 'Per Planner erledigt' });
    await api().patch(`/api/pm/tasks/${x.id}`, { done: true });
    await settle(t);
    expect(got).toContain(x.id);
    const legacy = (await api().get('/api/tasks?status=done')).data.find((r: any) => r.id === x.id);
    expect(legacy).toMatchObject({ title: 'Per Planner erledigt', done: 1 });
    expect(legacy.completed_at).toBeTruthy();
  });
});

describe('projects', () => {
  it('creates projects linked to a contact, company and deal, with the default statuses', async () => {
    const contact = (await api().post('/api/contacts', { first_name: 'Karla', last_name: 'Kunde', email: 'karla@kunde.de' })).data;
    const company = (await api().post('/api/companies', { name: 'Kunde GmbH', domain: 'kunde.de' })).data;
    const pipe = (await api().post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot'] })).data;
    const deal = (await api().post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contact.id, name: 'Website für Kunde', value: 5000 })).data;
    const proj = await project({ name: 'Relaunch', contact_id: contact.id, company_id: company.id, opportunity_id: deal.id, color: '#10b981', hourly_rate_cents: 9500 });
    expect(proj).toMatchObject({ name: 'Relaunch', status: 'active', contact_name: 'Karla Kunde', company_name: 'Kunde GmbH', opportunity_name: 'Website für Kunde', color: '#10b981', hourly_rate_cents: 9500, billable: true, portal_visible: false, is_default: false, progress: 0 });
    const full = (await api().get(`/api/pm/projects/${proj.id}`)).data;
    expect(full.statuses.map((s: any) => [s.name, s.category])).toEqual([['Offen', 'todo'], ['In Arbeit', 'active'], ['In Prüfung', 'active'], ['Erledigt', 'done']]);
    expect((await api().get(`/api/pm/projects?contact_id=${contact.id}`)).data.map((x: any) => x.name)).toEqual(['Relaunch']);
    // links must belong to this sub-account
    expect((await api().post('/api/pm/projects', { name: 'X', contact_id: 'gibts-nicht' })).status).toBe(400);
    expect((await api().post('/api/pm/projects', { name: 'X', company_id: 'gibts-nicht' })).status).toBe(400);
    expect((await api().post('/api/pm/projects', { name: 'X', opportunity_id: 'gibts-nicht' })).status).toBe(400);
    expect((await api().post('/api/pm/projects', { name: '' })).status).toBe(400);
    expect((await api().post('/api/pm/projects', { name: 'Y', start_at: '2026-10-10', due_at: '2026-10-01' })).data.error).toContain('Start');
  });

  it('shows progress and counts, updates, archives and protects "Allgemein"', async () => {
    const proj = await project({ name: 'Zählen' });
    const a = await task({ title: 'Eins', project_id: proj.id, due_at: `${day(-2)}T00:00:00.000Z` });
    await task({ title: 'Zwei', project_id: proj.id, due_at: `${day(5)}T00:00:00.000Z` });
    await api().patch(`/api/pm/tasks/${(await task({ title: 'Drei', project_id: proj.id })).id}`, { status: 'Erledigt' });
    const list = (await api().get('/api/pm/projects')).data;
    const mine = list.find((x: any) => x.id === proj.id);
    expect(mine.stats).toMatchObject({ tasks: 3, done: 1, open: 2, overdue: 1 });
    expect(mine.progress).toBe(33);
    expect(a.status.name).toBe('Offen');

    const patched = (await api().patch(`/api/pm/projects/${proj.id}`, { name: 'Zählen 2', status: 'paused', portal_visible: true, skip_weekends: true })).data;
    expect(patched).toMatchObject({ name: 'Zählen 2', status: 'paused', portal_visible: true, skip_weekends: true });
    expect((await api().patch(`/api/pm/projects/${proj.id}`, { status: 'kaputt' })).status).toBe(400);
    expect((await api().patch(`/api/pm/projects/${proj.id}`, { status: 'archived' })).data.status).toBe('archived');
    expect((await api().get('/api/pm/projects')).data.some((x: any) => x.id === proj.id)).toBe(false);
    expect((await api().get('/api/pm/projects?status=archived')).data.some((x: any) => x.id === proj.id)).toBe(true);
    // an archived project takes no new tasks
    expect((await api().post('/api/pm/tasks', { title: 'Zu spät', project_id: proj.id })).status).toBe(400);

    const def = list.find((x: any) => x.is_default);
    expect((await api().patch(`/api/pm/projects/${def.id}`, { status: 'archived' })).status).toBe(400);
    expect((await api().del(`/api/pm/projects/${def.id}`)).status).toBe(400);
  });

  it('deleting a project moves its tasks to "Allgemein" (statuses mapped) or deletes them', async () => {
    const proj = await project({ name: 'Wird gelöscht' });
    const done = await task({ title: 'Schon fertig', project_id: proj.id, status: 'Erledigt' });
    const open = await task({ title: 'Noch offen', project_id: proj.id, subtasks: ['Teil 1'] });
    expect((await api().del(`/api/pm/projects/${proj.id}`)).status).toBe(200);
    expect((await api().get(`/api/pm/projects/${proj.id}`)).status).toBe(404);
    const moved = (await get(open.id)).task;
    expect(moved.project.name).toBe('Allgemein');
    expect(moved.status.name).toBe('Offen');
    expect((await get(done.id)).task).toMatchObject({ done: true, status: { name: 'Erledigt' } });
    expect((await api().get(`/api/pm/tasks?parent=${open.id}`)).data.tasks[0].project.name).toBe('Allgemein');

    const gone = await project({ name: 'Mit Aufgaben weg' });
    const doomed = await task({ title: 'Verschwindet', project_id: gone.id });
    expect((await api().del(`/api/pm/projects/${gone.id}?tasks=delete`)).status).toBe(200);
    expect((await api().get(`/api/pm/tasks/${doomed.id}`)).status).toBe(404);
  });

  it('duplicates a project with its structure', async () => {
    const proj = await project({ name: 'Vorbild' });
    await api().post(`/api/pm/projects/${proj.id}/sections`, { name: 'Phase 1' });
    const sec = (await api().get(`/api/pm/projects/${proj.id}/sections`)).data[0];
    await task({ title: 'Mutter', project_id: proj.id, section_id: sec.id, priority: 'high', tags: ['x'], estimate_hours: 2, start_at: '2026-10-05', due_at: '2026-10-07', subtasks: [{ title: 'Kind' }] });
    const copy = (await api().post(`/api/pm/projects/${proj.id}/duplicate`, {})).data;
    expect(copy.name).toBe('Vorbild (Kopie)');
    const tasks = (await api().get(`/api/pm/tasks?project_id=${copy.id}`)).data.tasks;
    expect(tasks.map((x: any) => x.title).sort()).toEqual(['Kind', 'Mutter']);
    const mother = tasks.find((x: any) => x.title === 'Mutter');
    expect(mother).toMatchObject({ priority: 3, tags: ['x'], estimate_minutes: 120 });
    expect(tasks.find((x: any) => x.title === 'Kind').parent_id).toBe(mother.id);
    expect((await api().get(`/api/pm/projects/${copy.id}/sections`)).data.map((s: any) => s.name)).toEqual(['Phase 1']);
  });
});

describe('statuses and sections', () => {
  it('adds, renames, reorders and deletes custom statuses; "done" follows the category', async () => {
    const proj = await project({ name: 'Eigene Status' });
    const add = await api().post(`/api/pm/projects/${proj.id}/statuses`, { name: 'Freigabe Kunde', category: 'active', color: '#8b5cf6' });
    expect(add.status).toBe(200);
    let list = (await api().get(`/api/pm/projects/${proj.id}/statuses`)).data;
    // goes in front of "Erledigt"
    expect(list.map((s: any) => s.name)).toEqual(['Offen', 'In Arbeit', 'In Prüfung', 'Freigabe Kunde', 'Erledigt']);
    expect((await api().post(`/api/pm/projects/${proj.id}/statuses`, { name: 'freigabe kunde' })).status).toBe(400);
    expect((await api().post(`/api/pm/projects/${proj.id}/statuses`, { name: 'X', category: 'weird' })).status).toBe(400);

    const x = await task({ title: 'Im Status', project_id: proj.id, status: 'Freigabe Kunde' });
    expect(x.status).toMatchObject({ name: 'Freigabe Kunde', category: 'active' });
    expect(x.done).toBe(false);
    // the status becomes a "done" status: its tasks are done
    await api().patch(`/api/pm/statuses/${add.data.id}`, { category: 'done' });
    expect((await get(x.id)).task).toMatchObject({ done: true });
    await api().patch(`/api/pm/statuses/${add.data.id}`, { category: 'active', name: 'Kundenfreigabe' });
    expect((await get(x.id)).task).toMatchObject({ done: false, status: { name: 'Kundenfreigabe' } });

    // deleting a status with tasks needs somewhere to put them
    expect((await api().del(`/api/pm/statuses/${add.data.id}`)).status).toBe(400);
    const open = await statusOf(proj.id, 'Offen');
    expect((await api().del(`/api/pm/statuses/${add.data.id}?move_to=${open.id}`)).data).toMatchObject({ ok: true, moved: 1 });
    expect((await get(x.id)).task.status.name).toBe('Offen');

    list = (await api().get(`/api/pm/projects/${proj.id}/statuses`)).data;
    const order = [...list].reverse().map((s: any) => s.id);
    const re = await api().put(`/api/pm/projects/${proj.id}/statuses/order`, { ids: order });
    expect(re.data.map((s: any) => s.name)).toEqual(['Erledigt', 'In Prüfung', 'In Arbeit', 'Offen']);
    expect((await api().put(`/api/pm/projects/${proj.id}/statuses/order`, { ids: order.slice(1) })).status).toBe(400);
  });

  it('keeps at least one "to do" and one "done" status', async () => {
    const proj = await project({ name: 'Mindest-Status' });
    const list = (await api().get(`/api/pm/projects/${proj.id}/statuses`)).data;
    const todo = list.find((s: any) => s.category === 'todo');
    const done = list.find((s: any) => s.category === 'done');
    expect((await api().del(`/api/pm/statuses/${todo.id}`)).data.error).toContain('Zu erledigen');
    expect((await api().del(`/api/pm/statuses/${done.id}`)).data.error).toContain('Erledigt');
    expect((await api().patch(`/api/pm/statuses/${done.id}`, { category: 'active' })).status).toBe(400);
  });

  it('manages sections and unassigns their tasks when one is deleted', async () => {
    const proj = await project({ name: 'Abschnitte' });
    const s1 = (await api().post(`/api/pm/projects/${proj.id}/sections`, { name: 'Konzept' })).data;
    const s2 = (await api().post(`/api/pm/projects/${proj.id}/sections`, { name: 'Umsetzung' })).data;
    expect((await api().post(`/api/pm/projects/${proj.id}/sections`, { name: '' })).status).toBe(400);
    const x = await task({ title: 'In Konzept', project_id: proj.id, section_id: s1.id });
    expect(x.section_id).toBe(s1.id);
    const other = await project({ name: 'Anderes' });
    expect((await api().post('/api/pm/tasks', { title: 'Falscher Abschnitt', project_id: other.id, section_id: s1.id })).status).toBe(400);
    expect((await api().put(`/api/pm/projects/${proj.id}/sections/order`, { ids: [s2.id, s1.id] })).data.map((s: any) => s.name)).toEqual(['Umsetzung', 'Konzept']);
    expect((await api().patch(`/api/pm/sections/${s1.id}`, { name: 'Konzeption' })).data.name).toBe('Konzeption');
    await api().del(`/api/pm/sections/${s1.id}`);
    expect((await get(x.id)).task.section_id).toBeNull();
    expect((await api().get(`/api/pm/tasks?project_id=${proj.id}&section_id=none`)).data.total).toBe(1);
  });
});

describe('subtasks and hierarchy', () => {
  it('creates a whole tree in one call and keeps it in the project', async () => {
    const proj = await project({ name: 'Baum' });
    const root = await task({ title: 'Projektplan', project_id: proj.id, subtasks: [{ title: 'Phase 1', subtasks: ['Schritt 1.1', 'Schritt 1.2'] }, 'Phase 2'] });
    const all = (await api().get(`/api/pm/tasks?project_id=${proj.id}`)).data.tasks;
    expect(all).toHaveLength(5);
    const phase1 = all.find((x: any) => x.title === 'Phase 1');
    expect(phase1.parent_id).toBe(root.id);
    expect(all.find((x: any) => x.title === 'Schritt 1.2').parent_id).toBe(phase1.id);
    expect(all.find((x: any) => x.title === 'Projektplan').subtasks).toEqual({ total: 2, done: 0 });
    expect((await api().get(`/api/pm/tasks?project_id=${proj.id}&parent=none`)).data.total).toBe(1);
    expect((await api().get(`/api/pm/tasks?parent=${phase1.id}`)).data.total).toBe(2);
    const detail = await get(root.id);
    expect(detail.subtasks.map((x: any) => x.title)).toEqual(['Phase 1', 'Phase 2']);
    expect((await get(phase1.id)).trail.map((x: any) => x.title)).toEqual(['Projektplan']);
    // a subtask can't live in another project than its parent
    const other = await project({ name: 'Anderes' });
    expect((await api().post('/api/pm/tasks', { title: 'X', parent_id: root.id, project_id: other.id })).data.error).toContain('Projekt der übergeordneten');
    // too many tasks in one call
    const many = Array.from({ length: 301 }, (_, i) => `T${i}`);
    expect((await api().post('/api/pm/tasks', { title: 'Viele', project_id: proj.id, subtasks: many })).status).toBe(400);
    expect((await api().get(`/api/pm/tasks?project_id=${proj.id}`)).data.total).toBe(5);
  });

  it('refuses itself, a descendant and too deep nesting as parent', async () => {
    const proj = await project({ name: 'Hierarchie' });
    const a = await task({ title: 'A', project_id: proj.id });
    const b = await task({ title: 'B', project_id: proj.id, parent_id: a.id });
    const c = await task({ title: 'C', project_id: proj.id, parent_id: b.id });
    const patch = (id: string, parent_id: string | null) => api().patch(`/api/pm/tasks/${id}`, { parent_id });
    expect((await patch(a.id, a.id)).data.error).toContain('eigene Unteraufgabe');
    expect((await patch(a.id, c.id)).data.error).toContain('Zirkelbezug');
    expect((await patch(b.id, c.id)).status).toBe(400);
    expect((await patch(c.id, null)).status).toBe(200);
    expect((await get(c.id)).task.parent_id).toBeNull();
    expect((await patch(c.id, b.id)).status).toBe(200);

    // depth limit: a chain of six, the seventh is refused – on create and on move
    let parent = a.id;
    for (let i = 0; i < 2; i++) parent = (await task({ title: `Tiefe ${i}`, project_id: proj.id, parent_id: parent })).id;
    // chain so far: A > B > C (C moved back under B), plus A > Tiefe 0 > Tiefe 1
    const chain = await task({ title: 'K1', project_id: proj.id });
    let cur = chain.id;
    for (let i = 2; i <= 6; i++) cur = (await task({ title: `K${i}`, project_id: proj.id, parent_id: cur })).id;
    const tooDeep = await api().post('/api/pm/tasks', { title: 'K7', project_id: proj.id, parent_id: cur });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.data.error).toContain('Ebenen');
    // moving a task with its own subtree under the deep chain counts the subtree too
    const lone = await task({ title: 'Mit Kind', project_id: proj.id, subtasks: ['Kind'] });
    const nearBottom = (await api().get(`/api/pm/tasks?project_id=${proj.id}&q=K5`)).data.tasks[0];
    expect((await patch(lone.id, nearBottom.id)).status).toBe(400);
    expect((await patch(lone.id, chain.id)).status).toBe(200);
  });

  it('moves subtasks along with their parent into another project', async () => {
    const one = await project({ name: 'Quelle' });
    const two = await project({ name: 'Ziel' });
    await api().post(`/api/pm/projects/${two.id}/statuses`, { name: 'Review', category: 'active' });
    const parent = await task({ title: 'Eltern', project_id: one.id, status: 'In Arbeit', subtasks: [{ title: 'Kind', status: 'Erledigt' }] });
    const moved = (await api().patch(`/api/pm/tasks/${parent.id}`, { project_id: two.id })).data;
    expect(moved.project.name).toBe('Ziel');
    expect(moved.status.name).toBe('In Arbeit');
    const kid = (await api().get(`/api/pm/tasks?parent=${parent.id}`)).data.tasks[0];
    expect(kid).toMatchObject({ project_id: two.id, done: true });
    expect(kid.status.name).toBe('Erledigt');
    // a subtask moved on its own becomes a top-level task there
    const sub = await task({ title: 'Allein', project_id: one.id, parent_id: (await task({ title: 'Mutter', project_id: one.id })).id });
    const alone = (await api().patch(`/api/pm/tasks/${sub.id}`, { project_id: two.id })).data;
    expect(alone).toMatchObject({ project_id: two.id, parent_id: null });
    // deleting a parent deletes its subtasks
    expect((await api().del(`/api/pm/tasks/${parent.id}`)).data.deleted).toBe(2);
    expect((await api().get(`/api/pm/tasks/${kid.id}`)).status).toBe(404);
  });
});

describe('task fields', () => {
  it('stores priority, tags, estimate, dates, checklists and custom fields with validation', async () => {
    const proj = await project({ name: 'Felder' });
    const field = (await api().post('/api/pm/custom-fields', { label: 'Budget', type: 'number', project_id: proj.id })).data;
    const sel = (await api().post('/api/pm/custom-fields', { label: 'Kanal', type: 'select', options: ['Web', 'Print'], project_id: proj.id })).data;
    expect(field.key).toBe('budget');
    expect((await api().post('/api/pm/custom-fields', { label: 'Budget', type: 'number', project_id: proj.id })).status).toBe(400);
    expect((await api().post('/api/pm/custom-fields', { label: 'Leer', type: 'select', options: [] })).status).toBe(400);
    const x = await task({
      title: 'Alles dran',
      project_id: proj.id,
      priority: 'urgent',
      tags: ['Design', 'design', ' Kunde '],
      estimate_hours: 1.5,
      start_at: '2026-10-05',
      due_at: '2026-10-09',
      checklists: [{ title: 'Vorbereitung', items: [{ text: 'Briefing lesen', done: true }, { text: 'Entwurf' }] }],
      custom: { budget: 1200, kanal: 'Web' },
      internal: true,
    });
    expect(x).toMatchObject({ priority: 4, priority_label: 'Dringend', tags: ['Design', 'Kunde'], estimate_minutes: 90, start_at: '2026-10-05T00:00:00.000Z', due_at: '2026-10-09T00:00:00.000Z', custom: { budget: 1200, kanal: 'Web' }, internal: true });
    expect(x.checklists[0]).toMatchObject({ title: 'Vorbereitung' });
    expect(x.checklists[0].items.map((i: any) => [i.text, i.done])).toEqual([['Briefing lesen', true], ['Entwurf', false]]);
    // checking an item
    const lists = x.checklists;
    lists[0].items[1].done = true;
    expect((await api().patch(`/api/pm/tasks/${x.id}`, { checklists: lists })).data.checklists[0].items[1].done).toBe(true);
    // validation
    const bad = (body: any) => api().patch(`/api/pm/tasks/${x.id}`, body);
    expect((await bad({ custom: { budget: 'viel' } })).status).toBe(400);
    expect((await bad({ custom: { kanal: 'Radio' } })).status).toBe(400);
    expect((await bad({ custom: { gibtsnicht: 1 } })).data.error).toContain('gibt es in diesem Projekt nicht');
    expect((await bad({ priority: 9 })).status).toBe(400);
    expect((await bad({ title: '' })).status).toBe(400);
    expect((await bad({ title: 'x'.repeat(301) })).status).toBe(400);
    expect((await bad({ start_at: '2026-10-20' })).data.error).toContain('Start liegt nach');
    expect((await bad({ due_at: 'irgendwann' })).status).toBe(400);
    expect((await bad({ estimate_minutes: -5 })).status).toBe(400);
    expect((await bad({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status).toBe(400);
    // clearing a value
    expect((await bad({ custom: { budget: null } })).data.custom).toEqual({ kanal: 'Web' });
    // removing the field cleans the values
    await api().del(`/api/pm/custom-fields/${sel.id}`);
    expect((await get(x.id)).task.custom).toEqual({});
  });

  it('makes a milestone a single day and finds tasks by text, tag and priority', async () => {
    const proj = await project({ name: 'Meilensteine' });
    const m = await task({ title: 'Go-live', project_id: proj.id, milestone: true, due_at: '2026-10-30' });
    expect(m).toMatchObject({ milestone: true, start_at: '2026-10-30T00:00:00.000Z', due_at: '2026-10-30T00:00:00.000Z' });
    await task({ title: 'Logo entwerfen', project_id: proj.id, tags: ['Design'], priority: 'high' });
    await task({ title: 'Texte schreiben', project_id: proj.id, tags: ['Inhalt'], description: 'Für die Startseite' });
    const q = async (s: string) => (await api().get(`/api/pm/tasks?project_id=${proj.id}&${s}`)).data.tasks.map((x: any) => x.title);
    expect(await q('q=logo')).toEqual(['Logo entwerfen']);
    expect(await q('q=startseite')).toEqual(['Texte schreiben']);
    expect(await q('tag=design')).toEqual(['Logo entwerfen']);
    expect(await q('priority=high')).toEqual(['Logo entwerfen']);
    expect(await q('has_dates=0')).toHaveLength(2);
    expect(await q('q=100%25')).toEqual([]);
  });
});

describe('people', () => {
  it('assigns several people, adds and removes, and refuses people without access', async () => {
    const proj = await project({ name: 'Team' });
    const x = await task({ title: 'Gemeinsam', project_id: proj.id, assignees: [p.anna.id, p.ben.id] });
    expect(x.assignees.map((a: any) => a.name)).toEqual(['Anna Beispiel', 'Ben Muster']);
    expect(x.assigned_to).toBe(p.anna.id);
    const added = (await api().patch(`/api/pm/tasks/${x.id}`, { add_assignees: [p.chef] })).data;
    expect(added.assignees).toHaveLength(3);
    const removed = (await api().patch(`/api/pm/tasks/${x.id}`, { remove_assignees: [p.anna.id] })).data;
    expect(removed.assignees.map((a: any) => a.id)).toEqual([p.ben.id, p.chef]);
    expect(removed.assigned_to).toBe(p.ben.id);
    expect((await api().patch(`/api/pm/tasks/${x.id}`, { assignees: [] })).data.assigned_to).toBeNull();
    // Nora has no access to the planner area, a member of another sub-account none at all
    expect((await api().patch(`/api/pm/tasks/${x.id}`, { assignees: [p.nora.id] })).status).toBe(400);
    expect((await api().patch(`/api/pm/tasks/${x.id}`, { assignees: ['unbekannt'] })).status).toBe(400);
    const team = (await api().get('/api/pm/team')).data.map((m: any) => m.name);
    expect(team).toEqual(expect.arrayContaining(['Anna Beispiel', 'Ben Muster', 'Chef']));
    expect(team).not.toContain('Nora Kalender');
  });

  it('manages watchers and filters by assignee', async () => {
    const proj = await project({ name: 'Beobachter' });
    const x = await task({ title: 'Beobachtet', project_id: proj.id, assignees: [p.anna.id], watchers: [p.ben.id] });
    expect(x.watchers).toContain(p.ben.id);
    expect((await api().post(`/api/pm/tasks/${x.id}/watch`, { user_id: p.chef })).data.watchers).toContain(p.chef);
    expect((await api().del(`/api/pm/tasks/${x.id}/watch?user_id=${p.chef}`)).data.watchers).not.toContain(p.chef);
    await task({ title: 'Ohne Zuständigen', project_id: proj.id });
    const q = async (s: string) => (await api().get(`/api/pm/tasks?project_id=${proj.id}&${s}`)).data.tasks.map((r: any) => r.title);
    expect(await q(`assignee=${p.anna.id}`)).toEqual(['Beobachtet']);
    expect(await q('assignee=none')).toEqual(['Ohne Zuständigen']);
    expect(await q(`watcher=${p.ben.id}`)).toEqual(['Beobachtet']);
    expect(await q('assignee=me')).toEqual([]);
  });
});

describe('bulk edit', () => {
  it('changes many tasks at once, reports failures and deletes', async () => {
    const proj = await project({ name: 'Bulk' });
    const ids = [(await task({ title: 'B1', project_id: proj.id })).id, (await task({ title: 'B2', project_id: proj.id, tags: ['alt'] })).id, (await task({ title: 'B3', project_id: proj.id })).id];
    const r = await api().post('/api/pm/tasks/bulk', { ids, patch: { status: 'In Arbeit', priority: 'high', add_assignees: [p.anna.id], due_at: '2026-11-01' }, add_tags: ['neu'], remove_tags: ['alt'] });
    expect(r.data).toMatchObject({ updated: 3, failed: [] });
    const rows = (await api().get(`/api/pm/tasks?project_id=${proj.id}`)).data.tasks;
    for (const x of rows) expect(x).toMatchObject({ status: { name: 'In Arbeit' }, priority: 3, due_at: '2026-11-01T00:00:00.000Z' });
    expect(rows.find((x: any) => x.title === 'B2').tags).toEqual(['neu']);
    expect(rows[0].assignees.map((a: any) => a.id)).toEqual([p.anna.id]);
    // one id fails (another sub-account's), the rest goes through
    const mixed = await api().post('/api/pm/tasks/bulk', { ids: [ids[0], 'fremd-1'], patch: { status: 'Erledigt' } });
    expect(mixed.data.updated).toBe(1);
    expect(mixed.data.failed).toEqual([{ id: 'fremd-1', error: 'Aufgabe nicht gefunden' }]);
    expect((await api().post('/api/pm/tasks/bulk', { ids: [], patch: {} })).status).toBe(400);
    expect((await api().post('/api/pm/tasks/bulk', { ids })).data.failed).toHaveLength(3);
    expect((await api().post('/api/pm/tasks/bulk', { ids, action: 'delete' })).data.updated).toBe(3);
    expect((await api().get(`/api/pm/tasks?project_id=${proj.id}`)).data.total).toBe(0);
  });

  it('drag and drop: moves between statuses and places a task between two others', async () => {
    const proj = await project({ name: 'Board' });
    const a = await task({ title: 'A', project_id: proj.id });
    const b = await task({ title: 'B', project_id: proj.id });
    const c = await task({ title: 'C', project_id: proj.id });
    const order = async () => (await api().get(`/api/pm/tasks?project_id=${proj.id}&sort=position`)).data.tasks.map((x: any) => x.title);
    expect(await order()).toEqual(['A', 'B', 'C']);
    await api().post(`/api/pm/tasks/${c.id}/move`, { after_id: a.id, before_id: b.id });
    expect(await order()).toEqual(['A', 'C', 'B']);
    await api().post(`/api/pm/tasks/${c.id}/move`, { before_id: a.id });
    expect(await order()).toEqual(['C', 'A', 'B']);
    const moved = (await api().post(`/api/pm/tasks/${b.id}/move`, { status: 'In Prüfung' })).data;
    expect(moved.status.name).toBe('In Prüfung');
    const done = (await api().post(`/api/pm/tasks/${a.id}/move`, { category: 'done' })).data;
    expect(done).toMatchObject({ done: true, status: { name: 'Erledigt' } });
  });
});

describe('comments, mentions and notifications', () => {
  it('notifies mentioned people, assignees and watchers – never the author', async () => {
    const pushes: any[] = [];
    const realPush = t.app.services.pushNotify;
    t.app.services.pushNotify = async (n: any) => void pushes.push(n);
    const proj = await project({ name: 'Kommentare' });
    const x = await task({ title: 'Besprechen', project_id: proj.id, assignees: [p.ben.id], watchers: [p.chef] });
    const anna = await p.login(p.anna.email);
    const ben = await p.login(p.ben.email);
    const posted = await anna('POST', `/api/pm/tasks/${x.id}/comments`, { body: 'Das passt so. @Ben Muster bitte prüfen, cc @Chef' });
    expect(posted.status).toBe(200);
    expect(posted.data.mentions.map((m: any) => m.name).sort()).toEqual(['Ben Muster', 'Chef']);
    expect(posted.data.author_name).toBe('Anna Beispiel');

    const notes = async (who: any) => (await who('GET', '/api/pm/notifications')).data;
    const forBen = await notes(ben);
    expect(forBen.unread).toBeGreaterThanOrEqual(1);
    expect(forBen.items.find((n: any) => n.kind === 'mention')).toMatchObject({ title: expect.stringContaining('Anna Beispiel hat dich erwähnt'), task_id: x.id, link: `/app/pm/task/${x.id}` });
    expect((await api().get('/api/pm/notifications')).data.items.some((n: any) => n.kind === 'mention' && n.task_id === x.id)).toBe(true);
    // the author gets nothing for her own comment
    expect((await notes(anna)).items.some((n: any) => n.kind === 'mention' || n.kind === 'comment')).toBe(false);
    // mentioned people follow the task from now on
    expect((await get(x.id)).task.watchers).toEqual(expect.arrayContaining([p.ben.id, p.chef]));
    expect(pushes.some((n) => n.kind === 'tasks' && n.userIds[0] === p.ben.id)).toBe(true);

    // a later comment reaches the watchers, not the one who wrote it
    await ben('POST', `/api/pm/tasks/${x.id}/comments`, { body: 'Erledigt, danke!' });
    expect((await api().get('/api/pm/notifications')).data.items.some((n: any) => n.kind === 'comment' && n.body.includes('Erledigt, danke'))).toBe(true);
    expect((await notes(ben)).items.some((n: any) => n.body.includes('Erledigt, danke'))).toBe(false);

    // mark as read
    const unread = (await notes(ben)).items.filter((n: any) => !n.read_at).map((n: any) => n.id);
    expect((await ben('POST', '/api/pm/notifications/read', { ids: unread.slice(0, 1) })).data.updated).toBe(1);
    expect((await ben('POST', '/api/pm/notifications/read', { all: true })).data.ok).toBe(true);
    expect((await notes(ben)).unread).toBe(0);
    // nobody can read someone else's notifications
    expect((await notes(anna)).items.some((n: any) => n.id === unread[0])).toBe(false);
    t.app.services.pushNotify = realPush;
  });

  it('only notifies people who may use the planner, and edits add new mentions only', async () => {
    const proj = await project({ name: 'Erwähnungen' });
    const x = await task({ title: 'Mention-Test', project_id: proj.id });
    const c = (await api().post(`/api/pm/tasks/${x.id}/comments`, { body: 'Hallo @Nora Kalender und @Anna Beispiel' })).data;
    expect(c.mentions.map((m: any) => m.name)).toEqual(['Anna Beispiel']);
    const anna = await p.login(p.anna.email);
    const before = (await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.task_id === x.id && n.kind === 'mention').length;
    expect(before).toBe(1);
    // editing without a new mention does not notify again; adding Ben notifies Ben only
    await api().patch(`/api/pm/comments/${c.id}`, { body: 'Hallo @Anna Beispiel (korrigiert)' });
    expect((await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.task_id === x.id && n.kind === 'mention')).toHaveLength(1);
    await api().patch(`/api/pm/comments/${c.id}`, { body: 'Hallo @Anna Beispiel und @Ben Muster' });
    const ben = await p.login(p.ben.email);
    expect((await ben('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.task_id === x.id && n.kind === 'mention')).toHaveLength(1);
    expect((await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.task_id === x.id && n.kind === 'mention')).toHaveLength(1);
    // only the author (or the leadership) may edit or delete
    expect((await anna('PATCH', `/api/pm/comments/${c.id}`, { body: 'gekapert' })).status).toBe(400);
    expect((await anna('DELETE', `/api/pm/comments/${c.id}`)).status).toBe(400);
    expect((await api().patch(`/api/pm/comments/${c.id}`, { body: 'Hallo @Anna Beispiel und @Ben Muster (Chef)' })).status).toBe(200);
  });

  it('assignments notify the new assignee (not the person who assigned)', async () => {
    const proj = await project({ name: 'Zuweisungen' });
    const x = await task({ title: 'Zugewiesen', project_id: proj.id, assignees: [p.anna.id] });
    const anna = await p.login(p.anna.email);
    const items = (await anna('GET', '/api/pm/notifications')).data.items.filter((n: any) => n.task_id === x.id);
    expect(items.map((n: any) => n.kind)).toEqual(['assigned']);
    expect(items[0].title).toContain('Zugewiesen');
    // assigning yourself does not notify
    const own = await anna('POST', '/api/pm/tasks', { title: 'Selbst', project_id: proj.id, assignees: [p.anna.id] });
    expect((await anna('GET', '/api/pm/notifications')).data.items.some((n: any) => n.task_id === own.data.id)).toBe(false);
  });
});

describe('attachments', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('attaches links and checked files, serves them safely and deletes them', async () => {
    const x = await task({ title: 'Mit Anhang' });
    const link = (await api().post(`/api/pm/tasks/${x.id}/attachments`, { url: 'https://example.com/briefing.pdf', name: 'Briefing' })).data;
    expect(link).toMatchObject({ kind: 'link', name: 'Briefing', url: 'https://example.com/briefing.pdf' });
    expect((await api().post(`/api/pm/tasks/${x.id}/attachments`, { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await api().post(`/api/pm/tasks/${x.id}/attachments`, { url: 'ftp://x/y' })).status).toBe(400);

    const file = await api().post(`/api/pm/tasks/${x.id}/attachments/file`, { name: 'Logo.png', mime: 'image/png', data: PNG });
    expect(file.status, JSON.stringify(file.data)).toBe(200);
    expect(file.data).toMatchObject({ kind: 'file', name: 'Logo.png', mime: 'image/png', url: `/api/pm/attachments/${file.data.id}/file` });
    const dl = await t.api.raw(file.data.url, { headers: { cookie: t.api.cookie, 'x-location-id': A } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(dl.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(Buffer.from(await dl.arrayBuffer()).equals(Buffer.from(PNG, 'base64'))).toBe(true);
    expect((await get(x.id)).attachments.map((a: any) => a.name)).toEqual(['Briefing', 'Logo.png']);

    // disguised or unsupported content is refused
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    expect((await api().post(`/api/pm/tasks/${x.id}/attachments/file`, { name: 'x.png', mime: 'image/png', data: html })).data.error).toContain('passt nicht');
    expect((await api().post(`/api/pm/tasks/${x.id}/attachments/file`, { name: 'x.html', mime: 'text/html', data: html })).status).toBe(400);
    expect((await api().post(`/api/pm/tasks/${x.id}/attachments/file`, { name: 'x.svg', mime: 'image/svg+xml', data: html })).status).toBe(400);
    expect((await api().post(`/api/pm/tasks/${x.id}/attachments/file`, { name: 'leer.png', mime: 'image/png', data: '' })).status).toBe(400);

    // another sub-account can't fetch it
    const other = await t.api.raw(file.data.url, { headers: { cookie: t.api.cookie, 'x-location-id': p.B } });
    expect(other.status).toBe(404);
    expect((await api().del(`/api/pm/attachments/${file.data.id}`)).status).toBe(200);
    expect((await t.api.raw(file.data.url, { headers: { cookie: t.api.cookie, 'x-location-id': A } })).status).toBe(404);
    // deleting the task removes the rest
    expect((await api().del(`/api/pm/tasks/${x.id}`)).status).toBe(200);
  });
});
