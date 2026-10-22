import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocksMd, notionLayout, notionObject, notionProject, notionRecord, notionTask, pageOrder, propValue, richMd } from '../server/services/umzug-notion.js';
import { FakeNotion, NOTION_TOKEN } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeNotion();
let imported: any;
const ALL = ['projects', 'objects', 'docs', 'comments'];
const creds = { token: NOTION_TOKEN };
const project = (name: string) => h.one('SELECT * FROM pm_projects WHERE location_id = ? AND name = ?', name);
const objectType = (plural: string) => h.one('SELECT * FROM object_types WHERE location_id = ? AND plural = ?', plural);
const records = (key: string) => h.q('SELECT r.* FROM object_records r JOIN object_types t ON t.id = r.type_id WHERE r.location_id = ? AND t.key = ? ORDER BY r.created_at', key).map((r: any) => ({ ...r, properties: JSON.parse(r.properties) }));

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Notion');
  const me = h.raw<{ email: string }>('SELECT email FROM users ORDER BY created_at LIMIT 1')!;
  for (const row of fake.rows.db1) for (const p of Object.values(row.properties) as any[]) if (p.type === 'people') for (const u of p.people) if (u.name === 'Anna Alt') u.person.email = me.email;
});
afterAll(() => h.t.close());

describe('Notion: pure parts', () => {
  it('classifies databases: a status property makes a project', () => {
    const L = notionLayout(fake.databases[0]);
    expect(L).toMatchObject({ titleProp: 'Name', statusProp: 'Status', dueProp: 'Fällig', startProp: 'Start', priorityProp: 'Priorität', tagProp: 'Tags', peopleProps: ['Zuständig'] });
    expect([...L.fields.values()].map((f) => [f.label, f.type])).toEqual([['Aufwand', 'number'], ['Notiz', 'text'], ['Art', 'select']]);
    expect(L.skipped.join(' ')).toContain('Datei (files)');
    expect(notionProject(fake.databases[0], L).statuses).toEqual([{ name: 'Nicht begonnen', category: 'todo' }, { name: 'In Arbeit', category: 'active' }, { name: 'Fertig', category: 'done' }]);
  });
  it('turns a row into a task: status category, dates (range), priority, tags, people, custom values', () => {
    const L = notionLayout(fake.databases[0]);
    const users = new Map([['u1', 'Anna Alt']]);
    const t = notionTask(fake.rows.db1[0], fake.databases[0], L, users, 'Beschreibung');
    expect(t).toMatchObject({ ext: 'pg:r1', project: 'db:db1', title: 'Website bauen', description: 'Beschreibung', status: 'In Arbeit', done: false, priority: 3, start_at: '2024-06-01', due_at: '2024-06-30', tags: ['a', 'b'], created_at: '2024-02-01T09:00:00.000Z' });
    expect(t.custom).toEqual({ aufwand: 5, notiz: 'Kurznotiz', art: 'Intern' });
    expect(t.assignees?.map((a) => a.name)).toEqual(['Anna Alt', 'Ben Fremd']);
    const done = notionTask(fake.rows.db1[1], fake.databases[0], L, users);
    expect(done).toMatchObject({ done: true, start_at: '2024-05-01', due_at: '2024-05-10', status: 'Fertig' });
    expect(done.custom).toEqual({ aufwand: 0 });
    expect(notionTask(fake.rows.db1[2], fake.databases[0], L, users).status).toBeUndefined();
  });
  it('turns a database into an object type and its rows into records (relations are left for the link step)', () => {
    const o = notionObject(fake.databases[1]);
    expect(o.rec.properties.map((p) => [p.label, p.type])).toEqual([['Name', 'text'], ['E-Mail', 'email'], ['Telefon', 'phone'], ['Branche', 'select'], ['Umsatz', 'number'], ['Seit', 'date'], ['Aktiv', 'checkbox'], ['Website', 'url'], ['Tags', 'multiselect'], ['Notizen', 'textarea'], ['Betreuer', 'text'], ['Formel', 'text']]);
    expect(o.rec.properties[0].primary).toBe(true);
    expect(o.relations).toEqual([{ prop: 'Projekte', target: 'db3' }]);
    const r = notionRecord(fake.rows.db2[0], fake.databases[1], new Map());
    expect(r.values).toMatchObject({ Name: 'Muster GmbH', 'E-Mail': 'info@muster.example.com', Branche: 'IT', Umsatz: 12000.5, Seit: '2020-03-01', Aktiv: true, Tags: ['vip', 'neu'], Betreuer: 'Anna Alt', Formel: 'berechnet' });
    expect(r.values.Projekte).toBeUndefined();
  });
  it('reads rich text and properties', () => {
    expect(richMd([...[{ plain_text: 'a ', annotations: {} }], { plain_text: 'b', annotations: { bold: true, italic: true } }, { plain_text: ' c', href: 'https://x.de', annotations: { code: true } }])).toBe('a ***b*** [`c`](https://x.de)'.replace('[`c`]', ' [`c`]').replace('  ', ' '));
    expect(propValue({ type: 'unique_id', unique_id: { prefix: 'AUF', number: 7 } })).toBe('AUF-7');
    expect(propValue({ type: 'formula', formula: { type: 'number', number: 3 } })).toBe(3);
    expect(propValue({ type: 'date', date: { start: '2024-01-01T10:00:00Z' } })).toBe('2024-01-01T10:00:00Z');
  });
  it('orders pages parents first; a parent that is not shared makes the page a root', () => {
    const order = pageOrder(fake.pages.filter((p) => p.parent.type !== 'database_id')).map((o) => [o.page.id, o.parent]);
    expect(order).toEqual([['pgA', undefined], ['pgB', 'pgA'], ['pgC', undefined]]);
  });
  it('writes blocks as Markdown', async () => {
    const env = { children: async (id: string) => fake.blocks[id] ?? [], warn: () => undefined, budget: { calls: 50 }, images: { n: 0 } };
    const md = await blocksMd(fake.blocks.r1, env);
    expect(md).toContain('## Ziel');
    expect(md).toContain('Eine **neue** Seite, siehe [Doku](https://muster.example.com/doku)');
    expect(md).toContain('- Erstens\n  - Unterpunkt\n- Zweitens\n- [x] Abnahme');
    expect(md).toContain('```bash\nnpm run build\n```');
    expect(md).toContain('| Name | Rolle |');
    expect(md).toContain('| Anna | Chefin |');
    expect(md).not.toContain('Unterseite');
    expect(env.images.n).toBe(1);
  });
});

describe('Notion: connect and preview', () => {
  it('refuses a wrong token, connects with the right one without returning it', async () => {
    expect((await h.t.api.put('/api/umzug/connections/notion', { token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/notion', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.label).toBe('Muster Workspace');
    expect(JSON.stringify(r.data)).not.toContain(NOTION_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'api.notion.com')).toBe(true);
  });
  it('counts databases of both kinds, rows and pages', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'notion', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('databases')).toBe(1);
    expect(total('rows')).toBe(3);
    expect(total('object_databases')).toBe(2);
    expect(total('object_rows')).toBe(5);
    expect(total('pages')).toBe(3);
  });
  it('tells how to share when Notion shows nothing', async () => {
    const saved = fake.databases;
    fake.databases = [];
    const r = await h.t.api.post('/api/umzug/preview', { source: 'notion', parts: ['projects'] });
    fake.databases = saved;
    expect(r.data.warnings.join(' ')).toContain('Verbindungen');
  });
});

describe('Notion: import', () => {
  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'notion', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(project('Aufgaben')).toBeUndefined();
    expect(objectType('Kunden')).toBeUndefined();
    expect(h.count('wiki_pages')).toBe(0);
    expect(h.lines(job).project_tasks.created).toBe(3);
    expect(h.lines(job).object_records.created).toBe(5);
  });

  it('imports the database with a status as a project, its rows as tasks with the page content as description', async () => {
    imported = await h.run({ source: 'notion', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const p = project('Aufgaben')!;
    expect(h.q('SELECT name, category FROM pm_statuses WHERE location_id = ? AND project_id = ? ORDER BY position', p.id).map((s: any) => [s.name, s.category])).toEqual([['Nicht begonnen', 'todo'], ['In Arbeit', 'active'], ['Fertig', 'done']]);
    const list = h.q('SELECT t.*, s.name AS status_name FROM tasks t LEFT JOIN pm_statuses s ON s.id = t.status_id WHERE t.location_id = ? AND t.project_id = ? ORDER BY t.created_at', p.id);
    expect(list.map((t: any) => [t.title, t.status_name, t.done])).toEqual([['Website bauen', 'In Arbeit', 0], ['Texte schreiben', 'Fertig', 1], ['Backlog-Idee', 'Nicht begonnen', 0]]);
    const t1 = list[0];
    expect(t1.description).toContain('## Ziel');
    expect(t1.description).toContain('- Erstens\n  - Unterpunkt');
    expect(t1.description).toContain('Zuständig dort: Ben Fremd');
    expect(t1.due_at.slice(0, 10)).toBe('2024-06-30');
    expect(t1.priority).toBe(3);
    expect(JSON.parse(t1.tags)).toEqual(['a', 'b']);
    expect(h.t.app.db.all('SELECT user_id FROM pm_assignees WHERE task_id = ?', t1.id)).toHaveLength(1);
    expect(imported.warnings.join(' ')).toContain('liegen bei Notion');
  });

  it('imports comments of the tasks', () => {
    const t1 = h.one('SELECT id FROM tasks WHERE location_id = ? AND title = ?', 'Website bauen');
    expect(h.q('SELECT author_name, body FROM pm_comments WHERE location_id = ? AND task_id = ? ORDER BY created_at', t1.id).map((c: any) => [c.author_name, c.body])).toEqual([['Anna Alt', 'Sieht gut aus'], ['Ben Fremd', 'Danke']]);
  });

  it('imports the other databases as custom objects with typed properties and records', () => {
    const t = objectType('Kunden')!;
    expect(t).toMatchObject({ singular: 'Kunden', primary_property: 'name' });
    const defs = h.q('SELECT key, label, type, options FROM object_properties WHERE location_id = ? AND object_key = ? ORDER BY position', t.key);
    expect(defs.map((d: any) => [d.key, d.type])).toEqual([['name', 'text'], ['e_mail', 'email'], ['telefon', 'phone'], ['branche', 'select'], ['umsatz', 'number'], ['seit', 'date'], ['aktiv', 'checkbox'], ['website', 'url'], ['tags', 'multiselect'], ['notizen', 'textarea'], ['betreuer', 'text'], ['formel', 'text'], ['inhalt', 'textarea']]);
    expect(defs.find((d: any) => d.key === 'name').label).toBe('Name');
    const recs = records(t.key);
    expect(recs).toHaveLength(3);
    expect(recs[0].properties).toMatchObject({ name: 'Muster GmbH', e_mail: 'info@muster.example.com', telefon: '+49301234567', branche: 'IT', umsatz: 12000.5, seit: '2020-03-01', aktiv: true, website: 'https://muster.example.com', tags: ['vip', 'neu'], betreuer: 'Anna Alt', formel: 'berechnet' });
    expect(recs[0].created_at).toBe('2024-02-01T09:00:00.000Z');
    expect(recs[0].display).toBe('Muster GmbH');
    expect(recs[2].properties.notizen).toBe('Ohne Namen');
    expect(objectType('Projekte')).toBeTruthy();
  });

  it('turns relations into links between records, once, and ignores relations to databases that are not imported', () => {
    const kunden = objectType('Kunden')!.key;
    const projekte = objectType('Projekte')!.key;
    const k1 = records(kunden)[0];
    const links = h.t.app.services.associations.list(h.loc(), { type: kunden, id: k1.id }, { type: projekte });
    expect(links.map((l: any) => l.name).sort()).toEqual(['Kampagne', 'Relaunch']);
    expect(h.count('associations')).toBe(3);
    expect(h.lines(imported).object_links).toMatchObject({ created: 3, updated: 3 });
  });

  it('imports pages as a wiki tree', () => {
    const space = h.one('SELECT id FROM wiki_spaces WHERE location_id = ? AND name = ?', 'Notion');
    const a = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Handbuch');
    const b = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Onboarding');
    const c = h.one('SELECT * FROM wiki_pages WHERE location_id = ? AND title = ?', 'Ideen');
    expect([a.space_id, b.space_id]).toEqual([space.id, space.id]);
    expect(b.parent_id).toBe(a.id);
    expect(c.parent_id).toBeNull();
    expect(a.body).toContain('Willkommen im Team');
    expect(a.body).toContain('1. Erst\n2. Dann');
    expect(a.icon).toBe('📘');
    expect(b.body).toContain('> 💡 Wichtig!');
    expect(h.lines(imported).docs.created).toBe(3);
  });

  it('a second run creates nothing twice', async () => {
    const again = await h.run({ source: 'notion', parts: ALL });
    expect(again.status, again.error).toBe('done');
    const l = h.lines(again);
    expect(l.projects).toMatchObject({ created: 0, updated: 1 });
    expect(l.project_tasks).toMatchObject({ created: 0, updated: 3 });
    expect(l.object_types).toMatchObject({ created: 0, updated: 2 });
    expect(l.object_records).toMatchObject({ created: 0, updated: 5 });
    expect(l.object_links).toMatchObject({ created: 0, updated: 6 });
    expect(l.docs).toMatchObject({ created: 0, updated: 3 });
    expect(h.count('associations')).toBe(3);
    expect(h.count('object_records')).toBe(5);
  });

  it('a record somebody has changed since stays as they left it', async () => {
    const kunden = objectType('Kunden')!.key;
    const k1 = records(kunden)[0];
    h.t.app.services.customObjects.update(h.loc(), kunden, k1.id, { properties: { umsatz: 1 } }, { quiet: true });
    h.t.app.db.update('object_records', k1.id, { updated_at: new Date(Date.now() + 5000).toISOString() });
    const again = await h.run({ source: 'notion', parts: ['objects'] });
    expect(h.lines(again).object_records.skipped).toBe(1);
    expect(records(kunden)[0].properties.umsatz).toBe(1);
  });

  it('skips a database with several data sources and goes on', async () => {
    fake.multiSource.add('db3');
    const job = await h.run({ source: 'notion', parts: ['objects'] }, 'dry-run');
    fake.multiSource.delete('db3');
    expect(job.status, job.error).toBe('done');
    expect(job.warnings.join(' ')).toContain('Datenbank „Projekte“ nicht gelesen');
    expect(h.lines(job).object_records).toMatchObject({ created: 0, updated: 3 });
  });

  it('without the comment right the comments are just not there', async () => {
    fake.commentsDenied = true;
    const job = await h.run({ source: 'notion', parts: ['projects', 'comments'] }, 'dry-run');
    fake.commentsDenied = false;
    expect(job.status, job.error).toBe('done');
  });

  it('waits after a 429 and never logs the token', async () => {
    const sleeps: number[] = [];
    h.t.app.services.umzugSleep = async (ms: number) => void sleeps.push(ms);
    fake.throttle.set('/v1/search', 2);
    const job = await h.run({ source: 'notion', parts: ['docs'] }, 'dry-run');
    h.t.app.services.umzugSleep = async () => undefined;
    expect(job.status, job.error).toBe('done');
    expect(sleeps.filter((s) => s === 2000)).toHaveLength(2);
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(NOTION_TOKEN);
  });
});

describe('Notion: undo', () => {
  it('removes projects, tasks, objects, records (with their links) and the wiki tree', async () => {
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ project_tasks: 3, projects: 1, object_types: 2, docs: 3, wiki_spaces: 1 });
    expect(job.undo.deleted.object_records).toBe(5);
    expect(project('Aufgaben')).toBeUndefined();
    expect(objectType('Kunden')).toBeUndefined();
    expect(h.count('object_records')).toBe(0);
    expect(h.count('associations')).toBe(0);
    expect(h.count('wiki_pages')).toBe(0);
    expect(h.count('object_properties')).toBe(0);
  });
});
