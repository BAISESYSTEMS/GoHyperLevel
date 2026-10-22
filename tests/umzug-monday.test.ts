import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksMd, deltaMd, mondayLayout, mondayPriority } from '../server/services/umzug-monday.js';
import { FakeMonday, MONDAY_TOKEN } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeMonday();
let imported: any;
const ALL = ['projects', 'comments', 'docs'];
const creds = { token: MONDAY_TOKEN };
const tasks = (project: string) => h.q('SELECT t.*, s.name AS status_name, s.category FROM tasks t LEFT JOIN pm_statuses s ON s.id = t.status_id WHERE t.location_id = ? AND t.project_id = ? ORDER BY t.position, t.created_at', project);
const project = (name: string) => h.one('SELECT * FROM pm_projects WHERE location_id = ? AND name = ?', name);

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('monday');
  // The team member Anna of the board exists in HyperLevel too (matched by e-mail).
  const me = h.raw<{ email: string }>('SELECT email FROM users ORDER BY created_at LIMIT 1')!;
  fake.users[0].email = me.email;
});
afterAll(() => h.t.close());

describe('monday.com: pure parts', () => {
  it('turns a board\'s columns into statuses, priority, dates and custom fields', () => {
    const L = mondayLayout(fake.boards[0]);
    expect(L.statusCol).toBe('status');
    expect(L.priorityCol).toBe('prio');
    expect(L.labels.map((l) => [l.name, l.category])).toEqual([['Working on it', 'active'], ['Done', 'done'], ['Stuck', 'active'], ['Bald', 'todo']]);
    expect(L.dueCol).toBe('due');
    expect(L.timelineCol).toBe('zeit');
    expect(L.descCol).toBe('desc');
    expect(L.people).toEqual(['person']);
    expect([...L.fields.values()].map((f) => [f.label, f.type])).toEqual([['Kunde', 'text'], ['Budget', 'number'], ['Briefing', 'url'], ['Freigegeben', 'checkbox'], ['Art', 'select']]);
    expect(L.skipped.join(' ')).toContain('Dateien');
    expect(L.skipped.join(' ')).toContain('Zeiterfassung');
  });
  it('reads priority words in two languages', () => {
    expect([mondayPriority('Critical'), mondayPriority('Hoch'), mondayPriority('Medium'), mondayPriority('niedrig'), mondayPriority('Bald')]).toEqual([4, 3, 2, 1, undefined]);
  });
  it('writes a doc as Markdown', () => {
    expect(deltaMd([{ insert: 'a ' }, { insert: 'b', attributes: { bold: true } }, { insert: ' ' }, { insert: 'c', attributes: { link: 'https://x.de' } }])).toBe('a **b** [c](https://x.de)');
    const md = blocksMd(fake.blocks['5001']);
    expect(md).toContain('# Willkommen');
    expect(md).toContain('Das ist **wichtig** – siehe [Doku](https://muster.example.com/doku)');
    expect(md).toContain('- Erstens\n- Zweitens');
    expect(md).toContain('- [x] Erledigt');
    expect(md).toContain('| Name | Rolle |');
    expect(md).toContain('| Anna | Chefin |');
    expect(md).not.toContain('Chefin\n\nChefin');
    expect(md).toContain('![Bild bei monday.com](https://files.monday.com/x/logo.png)');
  });
});

describe('monday.com: connect and preview', () => {
  it('refuses a wrong token and connects with the right one (the token is never returned)', async () => {
    expect((await h.t.api.put('/api/umzug/connections/monday', { token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/monday', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'acc-555' });
    expect(JSON.stringify(r.data)).not.toContain(MONDAY_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'api.monday.com')).toBe(true);
  });
  it('counts boards (not sub-item boards or doc boards), items and docs', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'monday', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('boards')).toBe(2);
    expect(total('items')).toBe(4);
    expect(total('docs')).toBe(2);
    expect(r.data.fields).toEqual([]);
  });
});

describe('monday.com: import', () => {
  it('a dry run counts and writes nothing', async () => {
    const job = await h.run({ source: 'monday', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(project('Website-Relaunch')).toBeUndefined();
    expect(h.count('wiki_pages')).toBe(0);
    expect(h.lines(job).projects.created).toBe(2);
    expect(h.lines(job).project_tasks.created).toBe(6);
  });

  it('imports boards as projects with the statuses, groups and fields of the board', async () => {
    imported = await h.run({ source: 'monday', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const p = project('Website-Relaunch')!;
    expect(p).toMatchObject({ description: 'Neue Firmenseite', billable: 0 });
    const st = h.q('SELECT name, category, color FROM pm_statuses WHERE location_id = ? AND project_id = ? ORDER BY position', p.id);
    expect(st.map((s: any) => [s.name, s.category])).toEqual([['Bald', 'todo'], ['Working on it', 'active'], ['Stuck', 'active'], ['Done', 'done']]);
    expect(st.find((s: any) => s.name === 'Working on it').color).toBe('#fdab3d');
    expect(h.q('SELECT name FROM pm_sections WHERE location_id = ? AND project_id = ? ORDER BY position', p.id).map((s: any) => s.name)).toEqual(['Planung', 'Umsetzung']);
    expect(h.q('SELECT label, type FROM pm_custom_fields WHERE location_id = ? AND project_id = ? ORDER BY position', p.id).map((f: any) => [f.label, f.type])).toEqual([['Kunde', 'text'], ['Budget', 'number'], ['Briefing', 'url'], ['Freigegeben', 'checkbox'], ['Art', 'select']]);
    expect(project('Content-Kalender')).toBeTruthy();
    // the sub-item board and the doc board are not projects
    expect(project('Subitems of Website-Relaunch')).toBeUndefined();
    expect(project('Wissen')).toBeUndefined();
  });

  it('imports items as tasks with status, priority, dates, assignee, fields and the original creation time', async () => {
    const p = project('Website-Relaunch')!;
    const list = tasks(p.id);
    expect(list.map((t: any) => t.title).sort()).toEqual(['Farben', 'Launch planen', 'Moodboard', 'Startseite gestalten', 'Texte schreiben']);
    const start = list.find((t: any) => t.title === 'Startseite gestalten');
    expect(start).toMatchObject({ status_name: 'Working on it', priority: 3, done: 0, created_at: '2024-02-01T09:00:00.000Z' });
    expect(start.due_at.slice(0, 10)).toBe('2024-06-30');
    expect(start.start_at.slice(0, 10)).toBe('2024-06-01');
    expect(start.description).toContain('Entwurf und Abstimmung mit dem Kunden');
    expect(start.description).toContain('Aus monday.com übernommen');
    expect(start.description).toContain('https://muster.monday.com/boards/1001/pulses/9001');
    // Anna is a team member (matched by e-mail), Ben is not: noted in the text
    const who = h.t.app.db.all('SELECT a.user_id FROM pm_assignees a WHERE a.task_id = ?', start.id);
    expect(who).toHaveLength(1);
    expect(start.description).toContain('Zuständig dort: Ben Fremd');
    expect(JSON.parse(start.custom)).toEqual({ kunde: 'Muster GmbH', budget: 1200, briefing: 'https://muster.example.com/briefing', freigegeben: true, art: 'Kunde' });
    expect(start.section_id).toBe(h.raw('SELECT id FROM pm_sections WHERE project_id = ? AND name = ?', p.id, 'Planung').id);
    const done = list.find((t: any) => t.title === 'Texte schreiben');
    expect(done).toMatchObject({ status_name: 'Done', done: 1, priority: 4 });
    expect(done.completed_at).toBe('2024-02-03T09:00:00.000Z');
    expect(JSON.parse(done.custom)).toEqual({ budget: 800.5 });
    // no status → the first "todo" status; a start after the end is dropped, the end stays
    const launch = list.find((t: any) => t.title === 'Launch planen');
    expect(launch).toMatchObject({ status_name: 'Bald', done: 0 });
    expect(launch.due_at.slice(0, 10)).toBe('2024-07-01');
    expect(launch.start_at).toBeNull();
  });

  it('imports sub-items as subtasks and updates (with replies) as comments, without notifying anyone', async () => {
    const p = project('Website-Relaunch')!;
    const list = tasks(p.id);
    const parent = list.find((t: any) => t.title === 'Startseite gestalten');
    const subs = list.filter((t: any) => t.parent_id === parent.id).sort((a: any, b: any) => a.title.localeCompare(b.title));
    expect(subs.map((t: any) => [t.title, t.done])).toEqual([['Farben', 0], ['Moodboard', 1]]);
    expect(subs.find((t: any) => t.title === 'Moodboard').due_at.slice(0, 10)).toBe('2024-06-05');
    const comments = h.q('SELECT author_name, body, via, user_id FROM pm_comments WHERE location_id = ? AND task_id = ? ORDER BY created_at', parent.id);
    expect(comments.map((c: any) => [c.author_name, c.body])).toEqual([['Anna Alt', 'Erster Entwurf ist da'], ['Ben Fremd', 'Sieht gut aus']]);
    expect(comments[0]).toMatchObject({ via: 'import', user_id: null });
    expect(h.count('pm_notifications')).toBe(0);
    expect(h.lines(imported).project_comments.created).toBe(2);
    expect(h.lines(imported).project_tasks.created).toBe(6);
  });

  it('imports docs as wiki pages in a space of their own', async () => {
    const space = h.one('SELECT * FROM wiki_spaces WHERE location_id = ? AND name = ?', 'monday.com');
    expect(space).toBeTruthy();
    const page = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Handbuch');
    expect(page.space_id).toBe(space.id);
    expect(page.body).toContain('# Willkommen');
    expect(page.body).toContain('| Anna | Chefin |');
    expect(page.updated_by_name).toBe('Umzug (monday.com)');
    expect(h.lines(imported).docs.created).toBe(2);
    expect(imported.warnings.join(' ')).toContain('Bilder bleiben bei monday.com');
  });

  it('warns about columns without a counterpart', () => {
    expect(imported.warnings.join(' ')).toContain('Spalten ohne Gegenstück');
  });

  it('a second run changes nothing and creates nothing twice', async () => {
    const again = await h.run({ source: 'monday', parts: ALL });
    expect(again.status, again.error).toBe('done');
    const l = h.lines(again);
    expect(l.projects).toMatchObject({ created: 0, updated: 2 });
    expect(l.project_tasks).toMatchObject({ created: 0, updated: 6 });
    expect(l.project_comments).toMatchObject({ created: 0, updated: 2 });
    expect(l.docs).toMatchObject({ created: 0, updated: 2 });
    expect(h.q('SELECT id FROM pm_projects WHERE location_id = ? AND name = ?', 'Website-Relaunch')).toHaveLength(1);
    expect(h.q('SELECT id FROM tasks WHERE location_id = ? AND title = ?', 'Moodboard')).toHaveLength(1);
    expect(h.count('pm_comments')).toBe(2);
  });

  it('a task somebody has changed since stays as they left it', async () => {
    const t = h.one('SELECT id FROM tasks WHERE location_id = ? AND title = ?', 'Texte schreiben');
    h.t.app.db.update('tasks', t.id, { title: 'Texte schreiben (angepasst)', updated_at: new Date(Date.now() + 5000).toISOString() });
    const again = await h.run({ source: 'monday', parts: ['projects'] });
    expect(h.lines(again).project_tasks.skipped).toBe(1);
    expect(h.raw('SELECT title FROM tasks WHERE id = ?', t.id).title).toBe('Texte schreiben (angepasst)');
    h.t.app.db.update('tasks', t.id, { title: 'Texte schreiben' });
  });

  it('waits when monday answers with a complexity error, and stops with a clear message at the daily limit', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    fake.soft = 2;
    const job = await h.run({ source: 'monday', parts: ['projects'] }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(sleeps.filter((s) => s === 3000)).toHaveLength(2);
    h.t.app.services.umzugSleep = async () => undefined;
    fake.daily = true;
    const failed = await h.run({ source: 'monday', parts: ['projects'] }, 'dry-run');
    fake.daily = false;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Tageslimit');
  });

  it('never wrote the token anywhere', () => {
    const dump = JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'));
    expect(dump).not.toContain(MONDAY_TOKEN);
  });
});

describe('monday.com: undo', () => {
  it('keeps a task people worked on (and its project), removes everything else', async () => {
    const t = h.one('SELECT id, project_id FROM tasks WHERE location_id = ? AND title = ?', 'Texte schreiben');
    const uid = h.raw<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    h.t.app.db.insert('pm_comments', { id: 'own-comment', location_id: h.loc(), task_id: t.id, user_id: uid, author_name: 'Chef', body: 'Eigener Kommentar', mentions: '[]', via: 'session', created_at: new Date().toISOString(), edited_at: null });
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ project_tasks: 5, projects: 1, docs: 2, wiki_spaces: 1 });
    expect(job.undo.kept).toMatchObject({ project_tasks: 1 });
    expect(project('Content-Kalender')).toBeUndefined();
    expect(project('Website-Relaunch')).toBeTruthy();
    expect(h.q('SELECT title FROM tasks WHERE location_id = ? AND project_id = ?', t.project_id).map((x: any) => x.title)).toEqual(['Texte schreiben']);
    expect(h.count('wiki_pages')).toBe(0);
    expect(job.undo.notes.join(' ')).toContain('Aufgaben bleiben');
  });

  it('after removing the last task a new run creates everything again, and it can be undone too', async () => {
    const t = h.one('SELECT id FROM tasks WHERE location_id = ? AND title = ?', 'Texte schreiben');
    h.t.app.db.run('DELETE FROM pm_comments WHERE id = ?', 'own-comment');
    h.t.app.db.run('DELETE FROM tasks WHERE id = ?', t.id);
    const again = await h.run({ source: 'monday', parts: ALL });
    expect(again.status, again.error).toBe('done');
    expect(h.lines(again).project_tasks.created).toBe(6);
    expect(project('Content-Kalender')).toBeTruthy();
    const undone = await h.undo(again.id);
    expect(undone.undo.deleted).toMatchObject({ project_tasks: 6, projects: 1 });
    expect(project('Content-Kalender')).toBeUndefined();
    // the project the first import made (and could not remove) is not tracked by this job: it stays, empty
    expect(h.q('SELECT id FROM tasks WHERE location_id = ? AND project_id = ?', project('Website-Relaunch')!.id)).toHaveLength(0);
  });
});
