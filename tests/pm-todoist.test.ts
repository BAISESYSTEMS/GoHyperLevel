import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { FakeTodoist } from './todoist-fake.js';

/** The Todoist sync keeps working with tasks that live in planner projects: no external HTTP, a fake Todoist. */

let t: Awaited<ReturnType<typeof startTestApp>>;
const fake = new FakeTodoist();
const sync = async () => {
  const r = await t.api.post('/api/agency/todoist/sync', { full: false });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const pm = async (path: string, body: Record<string, unknown>, method: 'post' | 'patch' = 'post') => {
  const r = await t.api[method](path, body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.todoistFetch = fake.fetch;
  t.app.services.todoistSleep = async () => {};
  t.app.services.todoistPushDelayMs = -1;
  expect((await t.api.patch('/api/agency/todoist', { token: fake.token })).status).toBe(200);
  expect((await t.api.patch('/api/agency/todoist', { layout: 'projects' })).data.layout).toBe('projects');
  await sync(); // creates the Todoist project of the sub-account
});
afterAll(() => t.close());

describe('todoist sync with the planner', () => {
  it('pushes planner tasks, their due date and status changes to Todoist', async () => {
    const proj = await pm('/api/pm/projects', { name: 'Website' });
    const parent = await pm('/api/pm/tasks', { title: 'Seiten bauen', project_id: proj.id, due_at: '2026-10-09', subtasks: ['Startseite'] });
    await sync();
    const item = fake.byContent('Seiten bauen');
    expect(item).toBeTruthy();
    expect(item.due).toMatchObject({ date: '2026-10-09' });
    expect(fake.byContent('Startseite')).toBeTruthy();

    // moving the status to a done status completes it in Todoist …
    await pm(`/api/pm/tasks/${parent.id}/move`, { category: 'done' });
    await sync();
    expect(fake.items.get(item.id).checked).toBe(true);
    // … and back to an open one reopens it
    await pm(`/api/pm/tasks/${parent.id}/move`, { status: 'In Arbeit' });
    await sync();
    expect(fake.items.get(item.id).checked).toBe(false);
    // a rename or a new due date in the planner reaches Todoist too
    await pm(`/api/pm/tasks/${parent.id}`, { title: 'Seiten bauen (v2)', due_at: '2026-10-12' }, 'patch');
    await sync();
    expect(fake.items.get(item.id)).toMatchObject({ content: 'Seiten bauen (v2)', due: expect.objectContaining({ date: '2026-10-12' }) });
  });

  it('brings Todoist tasks into the default project and keeps status and done flag in step', async () => {
    const todoistProject = (await t.api.get('/api/agency/todoist')).data.locations.find((l: any) => l.name === 'Testfirma').project_id;
    const remote = fake.addItem(todoistProject, 'In Todoist angelegt', { due: { date: '2026-10-08', timezone: null, string: '', is_recurring: false } });
    await sync();
    const imported = (await t.api.get('/api/pm/tasks?q=Todoist%20angelegt')).data.tasks.find((x: any) => x.title === 'In Todoist angelegt');
    expect(imported).toBeTruthy();
    expect(imported).toMatchObject({ project: { name: 'Allgemein' }, status: { name: 'Offen' }, done: false });

    fake.edit(remote.id, { checked: true, completed_at: new Date().toISOString() });
    await sync();
    const done = (await t.api.get(`/api/pm/tasks/${imported.id}`)).data;
    expect(done.task).toMatchObject({ done: true, status: { name: 'Erledigt' } });
    expect(Number((await t.api.get('/api/tasks?status=all')).data.find((x: any) => x.id === imported.id).done)).toBe(1);

    fake.edit(remote.id, { checked: false, completed_at: null });
    await sync();
    expect((await t.api.get(`/api/pm/tasks/${imported.id}`)).data.task).toMatchObject({ done: false, status: { name: 'Offen' } });
  });

  it('keeps the plain task list and the planner in sync both ways', async () => {
    const plain = (await t.api.post('/api/tasks', { title: 'Nur Liste', due_at: '2026-10-10T00:00:00.000Z' })).data;
    await sync();
    expect(fake.byContent('Nur Liste')).toBeTruthy();
    // it is a planner task in the default project …
    expect((await t.api.get(`/api/pm/tasks/${plain.id}`)).data).toMatchObject({ task: { title: 'Nur Liste', status: { name: 'Offen' } }, project: { name: 'Allgemein' } });
    // … and finishing it through the planner shows in the plain list, and so in Todoist
    await pm(`/api/pm/tasks/${plain.id}/move`, { category: 'done' });
    expect(Number((await t.api.get('/api/tasks?status=all')).data.find((x: any) => x.id === plain.id).done)).toBe(1);
    await sync();
    expect(fake.byContent('Nur Liste').checked).toBe(true);
    // deleting through the planner removes it in Todoist
    const item = fake.byContent('Nur Liste');
    expect((await t.api.del(`/api/pm/tasks/${plain.id}`)).status).toBe(200);
    await sync();
    expect(fake.items.get(item.id).is_deleted).toBe(true);
  });
});
