import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FakeTodoist } from './todoist-fake.js';

/** Tasks in the journal: the project planner, recurring tasks and the Todoist sync (no loop, undo reopens and syncs). */

let t: Awaited<ReturnType<typeof startTestApp>>;
const fake = new FakeTodoist();
const undoId = (r: { headers: Headers }) => r.headers.get('x-undo-id')!;
const label = (r: { headers: Headers }) => decodeURIComponent(r.headers.get('x-undo-label') ?? '');
const sync = async () => {
  const r = await t.api.post('/api/agency/todoist/sync', { full: false });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};
const entries = () => t.app.db.all<{ id: string; label: string; kind: string }>('SELECT id, label, kind FROM undo_entries ORDER BY seq');

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.todoistFetch = fake.fetch;
  t.app.services.todoistSleep = async () => {};
  t.app.services.todoistPushDelayMs = -1;
  expect((await t.api.patch('/api/agency/todoist', { token: fake.token })).status).toBe(200);
  expect((await t.api.patch('/api/agency/todoist', { layout: 'projects' })).data.layout).toBe('projects');
  await sync();
});
afterAll(() => t.close());

describe('planner tasks', () => {
  it('completing a planner task and undoing it reopens it (status and done flag together)', async () => {
    const proj = (await t.api.post('/api/pm/projects', { name: 'Relaunch' })).data;
    const task = (await t.api.post('/api/pm/tasks', { title: 'Texte prüfen', project_id: proj.id })).data;
    const open = t.app.db.get<any>('SELECT status_id, done FROM tasks WHERE id = ?', task.id)!;
    const done = await t.api.post(`/api/pm/tasks/${task.id}/move`, { category: 'done' });
    expect(done.status).toBe(200);
    expect(t.app.db.get('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(1);
    expect(label(done as any)).toMatch(/^Aufgabe „Texte prüfen“ /);
    const r = await t.api.post(`/api/undo/${undoId(done as any)}`, {});
    expect(r.status).toBe(200);
    const back = t.app.db.get<any>('SELECT status_id, done, completed_at FROM tasks WHERE id = ?', task.id)!;
    expect(back.done).toBe(0);
    expect(back.status_id).toBe(open.status_id);
    expect(back.completed_at).toBeNull();
  });

  it('brings back assignees with an edit and a deleted task with its subtasks and comments', async () => {
    const proj = (await t.api.post('/api/pm/projects', { name: 'Kampagne' })).data;
    const me = (await t.api.get('/api/me')).data.user.id;
    const parent = (await t.api.post('/api/pm/tasks', { title: 'Hauptaufgabe', project_id: proj.id, subtasks: ['Teil A', 'Teil B'] })).data;
    await t.api.post(`/api/pm/tasks/${parent.id}/comments`, { body: 'Kommentar dazu' });
    const prio = t.app.db.get<any>('SELECT priority FROM tasks WHERE id = ?', parent.id)!.priority;
    const edit = await t.api.patch(`/api/pm/tasks/${parent.id}`, { assignees: [me], priority: 3 });
    expect(t.app.db.all('SELECT user_id FROM pm_assignees WHERE task_id = ?', parent.id)).toHaveLength(1);
    expect((await t.api.post(`/api/undo/${undoId(edit as any)}`, {})).status).toBe(200);
    expect(t.app.db.all('SELECT user_id FROM pm_assignees WHERE task_id = ?', parent.id)).toHaveLength(0);
    expect(t.app.db.get('SELECT priority FROM tasks WHERE id = ?', parent.id)!.priority).toBe(prio);

    const subIds = t.app.db.all<{ id: string }>('SELECT id FROM tasks WHERE parent_id = ?', parent.id).map((x) => x.id);
    expect(subIds).toHaveLength(2);
    const del = await t.api.del(`/api/pm/tasks/${parent.id}`);
    expect(t.app.db.get('SELECT id FROM tasks WHERE id = ?', subIds[0])).toBeUndefined();
    expect((await t.api.post(`/api/undo/${undoId(del as any)}`, {})).status).toBe(200);
    expect(t.app.db.all<{ id: string }>('SELECT id FROM tasks WHERE parent_id = ?', parent.id).map((x) => x.id).sort()).toEqual([...subIds].sort());
    expect(t.app.db.all('SELECT id FROM pm_comments WHERE task_id = ?', parent.id)).toHaveLength(1);
  });

  it('undoing the completion of a recurring task takes the spawned next occurrence back', async () => {
    const proj = (await t.api.post('/api/pm/projects', { name: 'Routine' })).data;
    const task = (await t.api.post('/api/pm/tasks', { title: 'Wöchentlicher Bericht', project_id: proj.id, due_at: '2026-10-09', recurrence: { freq: 'weekly', interval: 1 } })).data;
    const done = await t.api.post(`/api/pm/tasks/${task.id}/move`, { category: 'done' });
    await t.app.events.flush();
    const spawned = t.app.db.all<{ id: string }>('SELECT id FROM tasks WHERE series_id = ? AND id != ?', task.id, task.id);
    expect(spawned).toHaveLength(1);
    expect((await t.api.post(`/api/undo/${undoId(done as any)}`, {})).status).toBe(200);
    expect(t.app.db.get('SELECT id FROM tasks WHERE id = ?', spawned[0].id)).toBeUndefined();
    const back = t.app.db.get<any>('SELECT done, recurrence, recurred_at FROM tasks WHERE id = ?', task.id)!;
    expect(back.done).toBe(0);
    expect(back.recurred_at).toBeNull();
    expect(back.recurrence).toBeTruthy();
  });
});

describe('todoist', () => {
  it('undo reopens the task in Todoist, and the sync never writes journal entries itself', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Mit Todoist' })).data;
    await sync();
    const item = fake.byContent('Mit Todoist');
    expect(item).toBeTruthy();
    const done = await t.api.patch(`/api/tasks/${task.id}`, { done: true });
    await sync();
    expect(fake.items.get(item.id).checked).toBe(true);
    const before = entries().length;
    // Pulling from Todoist and pushing back must not create entries (nothing here is a user action).
    await sync();
    await sync();
    expect(entries().length).toBe(before);

    expect((await t.api.post(`/api/undo/${undoId(done as any)}`, {})).status).toBe(200);
    await t.app.events.flush();
    await sync();
    expect(fake.items.get(item.id).checked).toBe(false);
    expect(t.app.db.get('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(0);
    // Exactly the undo itself was added: no loop of entries after more syncs.
    const after = entries().length;
    await sync();
    await sync();
    expect(entries().length).toBe(after);
    expect(entries().length).toBe(before + 1);
  });

  it('a task completed in Todoist (pulled) is not journaled', async () => {
    const task = (await t.api.post('/api/tasks', { title: 'Drüben erledigt' })).data;
    await sync();
    const item = fake.byContent('Drüben erledigt');
    const before = entries().length;
    fake.edit(item.id, { checked: true, completed_at: new Date().toISOString() });
    await sync();
    expect(t.app.db.get('SELECT done FROM tasks WHERE id = ?', task.id)!.done).toBe(1);
    expect(entries().length).toBe(before);
  });
});
