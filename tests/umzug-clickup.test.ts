import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickupDocPages, clickupFields, clickupTask, parentsFirst } from '../server/services/umzug-clickup.js';
import { CLICKUP_TOKEN, FakeClickUp } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeClickUp();
let imported: any;
const ALL = ['projects', 'comments', 'docs'];
const creds = { token: CLICKUP_TOKEN };
const tasks = (project: string) => h.q('SELECT t.*, s.name AS status_name FROM tasks t LEFT JOIN pm_statuses s ON s.id = t.status_id WHERE t.location_id = ? AND t.project_id = ? ORDER BY t.position', project);
const project = (name: string) => h.one('SELECT * FROM pm_projects WHERE location_id = ? AND name = ?', name);

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('ClickUp');
  const me = h.raw<{ email: string }>('SELECT email FROM users ORDER BY created_at LIMIT 1')!;
  for (const t of fake.tasks.l1) for (const a of t.assignees) if (a.username === 'Anna Alt') a.email = me.email;
});
afterAll(() => h.t.close());

describe('ClickUp: pure parts', () => {
  it('maps the custom fields that have a counterpart', () => {
    const f = clickupFields(fake.fields);
    expect(f.map((x) => [x.field.label, x.field.type, x.field.key])).toEqual([['Kunde', 'text', 'kunde'], ['Budget', 'number', 'budget'], ['Typ', 'select', 'typ'], ['Frist', 'date', 'frist'], ['Link', 'url', 'link'], ['Geprüft', 'checkbox', 'gepruft']]);
    expect(f[2].field.options).toEqual(['Bug', 'Feature']);
  });
  it('reads a task: dates (date-only vs. with time), priority, estimate, checklists, custom values', () => {
    const t = clickupTask(fake.tasks.l1[1], 'l1', clickupFields(fake.fields));
    expect(t).toMatchObject({ ext: 't:t1', project: 'l:l1', title: 'Kampagne planen', description: '**Ziel**: Reichweite', status: 'in progress', done: false, priority: 3, due_at: '2024-06-30', start_at: '2024-06-16', estimate_minutes: 120, tags: ['marketing', 'q3'], created_at: '2024-03-01T09:00:00.000Z' });
    expect(t.checklists).toEqual([{ title: 'Vorbereitung', items: [{ text: 'Briefing', done: true }, { text: 'Budget', done: false }, { text: 'Budget › Freigabe', done: false }] }]);
    expect(t.custom).toEqual({ kunde: 'Muster GmbH', budget: 1500, typ: 'Feature', frist: '2024-06-30', link: 'https://x.example/brief', gepruft: true });
    expect(clickupTask(fake.tasks.l2[0], 'l2', []).due_at).toBe('2024-07-15T13:30:00.000Z');
    expect(clickupTask(fake.tasks.l1[2], 'l1', []).completed_at).toBe('2023-02-01T09:00:00.000Z');
  });
  it('puts parents before their subtasks, also through several levels', () => {
    const mk = (ext: string, parent?: string) => ({ kind: 'pm_task' as const, ext, project: 'l:1', title: ext, parent });
    const out = parentsFirst([mk('c', 'b'), mk('b', 'a'), mk('x', 'weg'), mk('a')]).map((t) => [t.ext, t.parent]);
    expect(out).toEqual([['x', undefined], ['a', undefined], ['b', 'a'], ['c', 'b']]);
  });
  it('turns a doc with pages into wiki pages', () => {
    expect(clickupDocPages(fake.docs[1], fake.pages.d2).map((d) => [d.ext, d.title, d.parent, d.body])).toEqual([['d:d2', 'Einzelseite', undefined, 'Nur eine Seite']]);
    const many = clickupDocPages(fake.docs[0], fake.pages.d1);
    expect(many.map((d) => [d.ext, d.parent])).toEqual([['d:d1', undefined], ['p:d1:p1', 'd:d1'], ['p:d1:p2', 'p:d1:p1'], ['p:d1:p3', 'd:d1']]);
  });
});

describe('ClickUp: connect and preview', () => {
  it('refuses a wrong token and a foreign workspace id; connects with the right one without returning it', async () => {
    expect((await h.t.api.put('/api/umzug/connections/clickup', { token: 'pk_falsch' })).status).toBe(400);
    expect((await h.t.api.put('/api/umzug/connections/clickup', { ...creds, workspace: '1234' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/clickup', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'u-4711' });
    expect(JSON.stringify(r.data)).not.toContain(CLICKUP_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'api.clickup.com')).toBe(true);
  });
  it('counts lists, tasks and docs', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'clickup', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('lists')).toBe(3);
    expect(total('tasks')).toBe(4);
    expect(total('docs')).toBe(2);
    expect(r.data.warnings.join(' ')).toContain('100 Anfragen pro Minute');
  });
});

describe('ClickUp: import', () => {
  it('a dry run writes nothing and reads only some comments', async () => {
    const job = await h.run({ source: 'clickup', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(project('Marketing › Backlog')).toBeUndefined();
    expect(h.lines(job).projects.created).toBe(3);
    expect(h.lines(job).project_tasks.created).toBe(4);
  });

  it('imports lists as projects with the list\'s statuses and custom fields', async () => {
    imported = await h.run({ source: 'clickup', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const p = project('Marketing › Backlog')!;
    expect(p.description).toContain('Alles Offene');
    expect(p.description).toContain('Space „Marketing“');
    const st = h.q('SELECT name, category, color FROM pm_statuses WHERE location_id = ? AND project_id = ? ORDER BY position', p.id);
    expect(st.map((s: any) => [s.name, s.category])).toEqual([['to do', 'todo'], ['in progress', 'active'], ['review', 'active'], ['complete', 'done'], ['closed', 'done']]);
    expect(h.q('SELECT label, type FROM pm_custom_fields WHERE location_id = ? AND project_id = ? ORDER BY position', p.id).map((f: any) => [f.label, f.type])).toHaveLength(6);
    // lists in folders carry the folder in their name; the third list too has the space (two spaces)
    expect(project('Marketing › Q3 › Kampagnen')).toBeTruthy();
    expect(project('Technik › Releases')).toBeTruthy();
  });

  it('imports tasks (the subtask first in the API) with parent, fields, checklist, estimate and assignee', async () => {
    const p = project('Marketing › Backlog')!;
    const list = tasks(p.id);
    expect(list.map((t: any) => t.title)).toEqual(['Kampagne planen', 'Entwurf schreiben', 'Altlast']);
    const t1 = list[0];
    expect(t1).toMatchObject({ status_name: 'in progress', priority: 3, estimate_minutes: 120, created_at: '2024-03-01T09:00:00.000Z' });
    expect(t1.due_at.slice(0, 10)).toBe('2024-06-30');
    expect(JSON.parse(t1.tags)).toEqual(['marketing', 'q3']);
    expect(JSON.parse(t1.custom)).toEqual({ kunde: 'Muster GmbH', budget: 1500, typ: 'Feature', frist: '2024-06-30', link: 'https://x.example/brief', gepruft: true });
    expect(JSON.parse(t1.checklists)[0].items.map((i: any) => [i.text, i.done])).toEqual([['Briefing', true], ['Budget', false], ['Budget › Freigabe', false]]);
    expect(t1.description).toContain('**Ziel**: Reichweite');
    expect(t1.description).toContain('https://app.clickup.com/t/t1');
    expect(t1.description).toContain('Zuständig dort: Ben Fremd');
    expect(h.t.app.db.all('SELECT user_id FROM pm_assignees WHERE task_id = ?', t1.id)).toHaveLength(1);
    const sub = list[1];
    expect(sub).toMatchObject({ parent_id: t1.id, done: 1, status_name: 'complete' });
    expect(sub.completed_at).toBe('2024-03-05T09:00:00.000Z');
    expect(list[2]).toMatchObject({ status_name: 'closed', done: 1, priority: 1 });
  });

  it('reads all comments (several pages) and writes them oldest first', async () => {
    const t1 = h.one('SELECT id FROM tasks WHERE location_id = ? AND title = ?', 'Kampagne planen');
    const c = h.q('SELECT author_name, body, created_at FROM pm_comments WHERE location_id = ? AND task_id = ? ORDER BY created_at', t1.id);
    expect(c).toHaveLength(27);
    expect(c[0]).toMatchObject({ body: 'Kommentar 1', author_name: 'Ben Fremd', created_at: '2024-03-10T09:00:00.000Z' });
    expect(c[26].body).toBe('Kommentar 27');
    expect(h.lines(imported).project_comments.created).toBe(28);
    expect(fake.seen('/api/v2/task/t1/comment').some((q) => q.url.searchParams.get('start_id'))).toBe(true);
  });

  it('imports docs: one page becomes one wiki page, several become a parent with children', async () => {
    const space = h.one('SELECT id FROM wiki_spaces WHERE location_id = ? AND name = ?', 'ClickUp');
    expect(space).toBeTruthy();
    const root = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Handbuch');
    const start = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Start');
    const sub = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Unterseite');
    expect(start.parent_id).toBe(root.id);
    expect(sub.parent_id).toBe(start.id);
    expect(start.body).toContain('Hallo **Welt**');
    expect(h.one('SELECT body FROM wiki_pages WHERE location_id = ? AND title = ?', 'Einzelseite').body).toBe('Nur eine Seite');
    expect(h.one('SELECT id FROM wiki_pages WHERE location_id = ? AND title = ?', 'Archiv')).toBeUndefined();
    expect(h.lines(imported).docs.created).toBe(5);
  });

  it('a second run creates nothing twice', async () => {
    const again = await h.run({ source: 'clickup', parts: ALL });
    expect(again.status, again.error).toBe('done');
    const l = h.lines(again);
    expect(l.projects).toMatchObject({ created: 0, updated: 3 });
    expect(l.project_tasks).toMatchObject({ created: 0, updated: 4 });
    expect(l.project_comments.created).toBe(0);
    expect(l.docs).toMatchObject({ created: 0, updated: 5 });
    expect(h.q('SELECT id FROM tasks WHERE location_id = ? AND title = ?', 'Altlast')).toHaveLength(1);
    expect(h.count('pm_comments')).toBe(28);
  });

  it('without the comments part no comment is read', async () => {
    const before = fake.seen('/api/v2/task/').length;
    const job = await h.run({ source: 'clickup', parts: ['projects'] }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(fake.seen('/api/v2/task/').length).toBe(before);
  });

  it('waits until X-RateLimit-Reset after a 429, and never logs the token', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    fake.reset = 2;
    const job = await h.run({ source: 'clickup', parts: ['projects'] }, 'dry-run');
    h.t.app.services.umzugSleep = async () => undefined;
    expect(job.status, job.error).toBe('done');
    expect(sleeps.filter((s) => s >= 3000 && s <= 6000).length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(CLICKUP_TOKEN);
  });

  it('a workspace id limits what is read', async () => {
    const r = await h.t.api.put('/api/umzug/connections/clickup', { ...creds, workspace: '9001' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const p = await h.t.api.post('/api/umzug/preview', { source: 'clickup', parts: ['projects'] });
    expect(p.data.counts.find((c: any) => c.key === 'lists').total).toBe(3);
  });
});

describe('ClickUp: undo', () => {
  it('removes projects, tasks (subtasks first), comments and wiki pages', async () => {
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ project_tasks: 4, projects: 3, docs: 5, wiki_spaces: 1 });
    expect(project('Marketing › Backlog')).toBeUndefined();
    expect(h.count('pm_comments')).toBe(0);
    expect(h.count('wiki_pages')).toBe(0);
  });
});
