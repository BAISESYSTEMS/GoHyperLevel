import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromTodoistDue, normalizeDue, retryDelayMs, toTodoistDue, verifyTodoistHmac } from '../server/services/todoist.js';
import { stripFooter, withFooter } from '../server/services/todoist-sync.js';
import { startTestApp } from './helpers.js';
import { FakeTodoist } from './todoist-fake.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const fake = new FakeTodoist();
const sleeps: number[] = [];
let me: any;
let otherLoc: string;
const sync = async (full = false) => {
  const r = await t.api.post('/api/agency/todoist/sync', { full });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const task = async (id: string) => (await t.api.get('/api/tasks?status=all')).data.find((x: any) => x.id === id);

beforeAll(async () => {
  t = await startTestApp();
  me = await t.setup();
  t.app.services.todoistFetch = fake.fetch;
  t.app.services.todoistSleep = async (ms: number) => void sleeps.push(ms);
  t.app.services.todoistPushDelayMs = -1; // no background runs unless a test turns them on
  otherLoc = (await t.api.post('/api/locations', { name: 'Privat' })).data.id;
});
afterAll(async () => {
  await t.close();
});

describe('todoist helpers', () => {
  it('maps due dates both ways', () => {
    expect(toTodoistDue('2026-10-05T00:00:00.000Z', 'Europe/Berlin')).toEqual({ date: '2026-10-05' });
    expect(toTodoistDue('2026-10-05', 'Europe/Berlin')).toEqual({ date: '2026-10-05' });
    expect(toTodoistDue('2026-10-05T08:30:12.345Z', 'Europe/Berlin')).toEqual({ date: '2026-10-05T08:30:12Z', timezone: 'Europe/Berlin' });
    expect(toTodoistDue(null, 'Europe/Berlin')).toBeNull();
    expect(fromTodoistDue({ date: '2026-10-05' }, 'Europe/Berlin')).toBe('2026-10-05T00:00:00.000Z');
    expect(fromTodoistDue({ date: '2026-10-05T08:30:00.000000Z', timezone: 'Europe/Berlin' }, 'UTC')).toBe('2026-10-05T08:30:00.000Z');
    // floating times are wall-clock times in the user's zone (Berlin in October: UTC+2)
    expect(fromTodoistDue({ date: '2026-10-05T10:00:00.000000' }, 'Europe/Berlin')).toBe('2026-10-05T08:00:00.000Z');
    expect(fromTodoistDue(null, 'Europe/Berlin')).toBeNull();
    expect(normalizeDue('kaputt')).toBeNull();
  });

  it('adds and strips the link back to HyperLevel', () => {
    const d = withFooter('Angebot schicken', 'https://gh.example.com/app/contacts/c1');
    expect(d).toBe('Angebot schicken\n\n↗ HyperLevel: https://gh.example.com/app/contacts/c1');
    expect(stripFooter(d)).toBe('Angebot schicken');
    expect(stripFooter(withFooter('', 'https://x/app/tasks'))).toBe('');
    // Footers written under the former product name are still recognised.
    expect(stripFooter('Angebot schicken\n\n↗ GoHighPaul: https://gh.example.com/app/tasks')).toBe('Angebot schicken');
    expect(stripFooter('Angebot schicken\n\n↗ GoHigh: https://gh.example.com/app/tasks')).toBe('Angebot schicken');
  });

  it('verifies webhook signatures and reads retry hints', () => {
    const body = '{"event_name":"item:added"}';
    const sig = createHmac('sha256', 'client-secret').update(body).digest('base64');
    expect(verifyTodoistHmac(body, 'client-secret', sig)).toBe(true);
    expect(verifyTodoistHmac(body + ' ', 'client-secret', sig)).toBe(false);
    expect(verifyTodoistHmac(body, 'other', sig)).toBe(false);
    expect(verifyTodoistHmac(body, 'client-secret', undefined)).toBe(false);
    expect(retryDelayMs({ status: 429, headers: { 'retry-after': '7' }, text: '' }, 0)).toBe(7000);
    expect(retryDelayMs({ status: 429, headers: {}, text: '{"error_extra":{"retry_after":4}}' }, 0)).toBe(4000);
    expect(retryDelayMs({ status: 429, headers: {}, text: '' }, 2)).toBe(4000);
  });
});

describe('todoist sync – one project per sub-account', () => {
  it('tests the token on save and never returns it', async () => {
    const wrong = await t.api.patch('/api/agency/todoist', { token: 'falsch' });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toContain('lehnt den Token ab');
    expect((await t.api.get('/api/agency/todoist')).data.token_set).toBe(false);
    expect((await t.api.patch('/api/agency/todoist', { enabled: true })).status).toBe(400);

    const r = await t.api.patch('/api/agency/todoist', { token: fake.token });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ token_set: true, token_hint: '…1234', enabled: true, direction: 'both', account: { name: 'Paul', email: 'inhaber@example.com' } });
    expect(JSON.stringify(r.data)).not.toContain(fake.token);
    expect(JSON.stringify(t.app.db.all("SELECT value FROM agency_settings WHERE key = 'todoist'"))).not.toContain(fake.token);
    // members and location keys can't see it
    expect((await t.api.get('/api/agency/todoist', { authorization: 'Bearer pghl_nope' })).status).toBe(403);
  });

  it('auto-creates projects under the parent once and skips "don\'t sync" sub-accounts', async () => {
    expect((await t.api.patch('/api/agency/todoist', { layout: 'projects' })).data.layout).toBe('projects');
    await t.api.put(`/api/agency/todoist/mapping/${otherLoc}`, { mode: 'off' });
    const v = await sync();
    const parent = [...fake.projects.values()].find((p) => p.name === 'HyperLevel');
    const child = [...fake.projects.values()].find((p) => p.name === 'Testfirma');
    expect(parent?.parent_id).toBeNull();
    expect(child?.parent_id).toBe(parent.id);
    expect([...fake.projects.values()].some((p) => p.name === 'Privat')).toBe(false);
    expect(v.locations.find((l: any) => l.name === 'Testfirma')).toMatchObject({ mode: 'auto', project_id: child.id });
    expect(v.locations.find((l: any) => l.name === 'Privat')).toMatchObject({ mode: 'off' });
    await sync();
    expect([...fake.projects.values()].filter((p) => p.name === 'Testfirma').length).toBe(1);
  });

  it('pushes new, changed, completed, reopened and deleted tasks', async () => {
    const contact = (await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@x.de' })).data;
    const created = (await t.api.post('/api/tasks', { title: 'Angebot schicken', description: 'mit Rabatt', due_at: '2026-10-06T00:00:00.000Z', contact_id: contact.id })).data;
    const timed = (await t.api.post('/api/tasks', { title: 'Anrufen', due_at: '2026-10-06T13:30:00.000Z' })).data;
    t.api.setLocation(otherLoc);
    await t.api.post('/api/tasks', { title: 'Privat – bleibt hier' });
    t.api.setLocation(me.locations[0].id);

    const v = await sync();
    expect(v.state.counts.created).toBe(2);
    const item = fake.byContent('Angebot schicken');
    expect(item.description).toBe(`mit Rabatt\n\n↗ HyperLevel: http://localhost/app/contacts/${contact.id}`);
    expect(item.due).toMatchObject({ date: '2026-10-06' });
    expect(item.labels).toEqual(['ghp']);
    expect(fake.byContent('Anrufen').due).toMatchObject({ date: '2026-10-06T13:30:00Z', timezone: 'Europe/Berlin' });
    expect(fake.byContent('Anrufen').description).toBe('↗ HyperLevel: http://localhost/app/tasks');
    expect(fake.byContent('Privat – bleibt hier')).toBeUndefined();

    // nothing changed → nothing sent
    const before = fake.commands().length;
    await sync();
    expect(fake.commands().length).toBe(before);

    await t.api.patch(`/api/tasks/${created.id}`, { title: 'Angebot schicken (neu)', due_at: null });
    await sync();
    expect(fake.items.get(item.id)).toMatchObject({ content: 'Angebot schicken (neu)', due: null });

    await t.api.patch(`/api/tasks/${created.id}`, { done: true });
    await sync();
    expect(fake.items.get(item.id).checked).toBe(true);
    expect(fake.commands().at(-1).type).toBe('item_close');

    await t.api.patch(`/api/tasks/${created.id}`, { done: false });
    await sync();
    expect(fake.items.get(item.id).checked).toBe(false);
    expect(fake.commands().at(-1).type).toBe('item_uncomplete');

    const timedItem = fake.byContent('Anrufen');
    await t.api.del(`/api/tasks/${timed.id}`);
    await sync();
    expect(fake.items.get(timedItem.id).is_deleted).toBe(true);
    expect(t.app.db.get('SELECT * FROM todoist_links WHERE task_id = ?', timed.id)).toBeUndefined();
  });

  it('reads incrementally with the sync token and imports, updates, completes tasks from Todoist', async () => {
    const project = (await t.api.get('/api/agency/todoist')).data.locations.find((l: any) => l.name === 'Testfirma').project_id;
    const remote = fake.addItem(project, 'In Todoist angelegt', { description: 'von unterwegs', due: { date: '2026-10-09T09:00:00.000000', timezone: null } });
    fake.addItem(project, 'Schon erledigt', { checked: true });
    const inbox = fake.addProject('Inbox');
    fake.addItem(inbox.id, 'Nicht zugeordnet');
    fake.requests.length = 0;
    const v = await sync();
    const read = fake.requests.find((r) => r.form?.has('sync_token'))!;
    expect(read.form!.get('sync_token')).toMatch(/^v\d+$/);
    expect(v.state.counts.imported).toBe(1);

    const tasks = (await t.api.get('/api/tasks?status=all')).data;
    const imported = tasks.find((x: any) => x.title === 'In Todoist angelegt');
    expect(imported).toMatchObject({ description: 'von unterwegs', contact_id: null, assigned_to: me.user.id, done: 0, due_at: '2026-10-09T07:00:00.000Z' });
    expect(tasks.some((x: any) => x.title === 'Schon erledigt' || x.title === 'Nicht zugeordnet')).toBe(false);

    fake.edit(remote.id, { content: 'In Todoist umbenannt', description: 'neu\n\n↗ HyperLevel: http://localhost/app/tasks' });
    await sync();
    expect(await task(imported.id)).toMatchObject({ title: 'In Todoist umbenannt', description: 'neu' });
    // our own write echoes back without a ping-pong
    const sent = fake.commands().length;
    await sync();
    expect(fake.commands().length).toBe(sent);

    fake.edit(remote.id, { checked: true, completed_at: '2026-10-04T12:00:00.000000Z' });
    await sync();
    expect(await task(imported.id)).toMatchObject({ done: 1, completed_at: '2026-10-04T12:00:00.000Z' });
    fake.edit(remote.id, { checked: false, completed_at: null });
    await sync();
    expect((await task(imported.id)).done).toBe(0);
  });

  it('only marks a task done when it is deleted in Todoist', async () => {
    const created = (await t.api.post('/api/tasks', { title: 'Wird drüben gelöscht' })).data;
    await sync();
    const item = fake.byContent('Wird drüben gelöscht');
    fake.edit(item.id, { is_deleted: true });
    await sync();
    expect(await task(created.id)).toMatchObject({ done: 1, title: 'Wird drüben gelöscht' });
    expect(t.app.db.get('SELECT status FROM todoist_links WHERE task_id = ?', created.id).status).toBe('remote_deleted');
    const log = (await t.api.get('/api/agency/todoist')).data.log;
    expect(log[0].message).toContain('in Todoist gelöscht');
    // reopening it here does not bring it back to Todoist
    await t.api.patch(`/api/tasks/${created.id}`, { done: false });
    const n = fake.commands().length;
    await sync();
    expect(fake.commands().length).toBe(n);
  });

  it('resolves conflicts by the later change and logs them', async () => {
    const a = (await t.api.post('/api/tasks', { title: 'Konflikt A' })).data;
    const b = (await t.api.post('/api/tasks', { title: 'Konflikt B' })).data;
    await sync();
    const ia = fake.byContent('Konflikt A');
    const ib = fake.byContent('Konflikt B');
    // A: Todoist changed an hour ago, HyperLevel just now → HyperLevel wins
    fake.edit(ia.id, { content: 'A aus Todoist', updated_at_override: new Date(Date.now() - 3600_000).toISOString() });
    await t.api.patch(`/api/tasks/${a.id}`, { title: 'A aus HyperLevel' });
    // B: HyperLevel changed, then Todoist a minute later → Todoist wins
    await t.api.patch(`/api/tasks/${b.id}`, { title: 'B aus HyperLevel' });
    fake.edit(ib.id, { content: 'B aus Todoist', updated_at_override: new Date(Date.now() + 60_000).toISOString() });

    const v = await sync();
    expect(v.state.counts.conflicts).toBe(2);
    expect((await task(a.id)).title).toBe('A aus HyperLevel');
    expect(fake.items.get(ia.id).content).toBe('A aus HyperLevel');
    expect((await task(b.id)).title).toBe('B aus Todoist');
    expect(fake.items.get(ib.id).content).toBe('B aus Todoist');
    const conflicts = v.log.filter((l: any) => l.level === 'conflict').map((l: any) => l.message);
    expect(conflicts.some((m: string) => m.includes('HyperLevel ist neuer'))).toBe(true);
    expect(conflicts.some((m: string) => m.includes('Todoist ist neuer'))).toBe(true);
  });

  it('backs off on 429 and retries', async () => {
    await t.api.post('/api/tasks', { title: 'Trotz Limit' });
    sleeps.length = 0;
    fake.fail429 = 2;
    await sync();
    expect(sleeps).toEqual([2000, 3000]);
    expect(fake.byContent('Trotz Limit')).toBeTruthy();
    // gives up after a few tries and records the error
    fake.fail429 = 10;
    const r = await t.api.post('/api/agency/todoist/sync', {});
    expect(r.status).toBe(502);
    expect(r.data.error).toContain('429');
    expect((await t.api.get('/api/agency/todoist')).data.state.last_error).toContain('429');
    fake.fail429 = 0;
    expect((await sync()).state.last_error).toBe('');
  });

  it('never duplicates a task when the answer to a create gets lost', async () => {
    await t.api.post('/api/tasks', { title: 'Antwort verloren' });
    fake.loseNextResponse = true;
    const r = await t.api.post('/api/agency/todoist/sync', {});
    expect(r.status).toBe(502);
    expect(r.data.error).toContain('nicht erreichbar');
    expect(t.app.db.get(`SELECT status FROM todoist_links l JOIN tasks t ON t.id = l.task_id WHERE t.title = 'Antwort verloren'`).status).toBe('pending');
    await sync();
    expect([...fake.items.values()].filter((i) => i.content === 'Antwort verloren').length).toBe(1);
    expect((await t.api.get('/api/tasks')).data.filter((x: any) => x.title === 'Antwort verloren').length).toBe(1);
    expect(t.app.db.get(`SELECT status, todoist_id FROM todoist_links l JOIN tasks t ON t.id = l.task_id WHERE t.title = 'Antwort verloren'`)).toMatchObject({ status: 'active', todoist_id: fake.byContent('Antwort verloren').id });
  });

  it('maps a sub-account to an existing project and imports from it', async () => {
    const existing = fake.addProject('Meine Privatsachen');
    fake.addItem(existing.id, 'Steuer machen');
    await sync(); // not mapped yet: ignored, and later incremental reads won't list it again
    const list = (await t.api.get('/api/agency/todoist/projects')).data;
    expect(list.some((p: any) => p.id === existing.id && p.name === 'Meine Privatsachen')).toBe(true);
    await t.api.put(`/api/agency/todoist/mapping/${otherLoc}`, { mode: 'existing', project_id: existing.id, project_name: existing.name });
    fake.requests.length = 0;
    await sync();
    expect(fake.requests.find((r) => r.form?.has('sync_token'))!.form!.get('sync_token')).toBe('*');
    expect(fake.byContent('Privat – bleibt hier')?.project_id).toBe(existing.id);
    t.api.setLocation(otherLoc);
    expect((await t.api.get('/api/tasks')).data.some((x: any) => x.title === 'Steuer machen')).toBe(true);
    t.api.setLocation(me.locations[0].id);
  });

  it('push-only direction ignores changes made in Todoist', async () => {
    await t.api.patch('/api/agency/todoist', { direction: 'push' });
    const project = (await t.api.get('/api/agency/todoist')).data.locations.find((l: any) => l.name === 'Testfirma').project_id;
    fake.addItem(project, 'Nur drüben');
    fake.requests.length = 0;
    await sync();
    expect(fake.requests.some((r) => r.form?.has('sync_token'))).toBe(false);
    expect((await t.api.get('/api/tasks')).data.some((x: any) => x.title === 'Nur drüben')).toBe(false);
    await t.api.patch('/api/agency/todoist', { direction: 'both' });
  });

  it('pushes soon after a change without waiting for the next poll', async () => {
    t.app.services.todoistPushDelayMs = 10;
    await t.api.post('/api/tasks', { title: 'Sofort rüber' });
    for (let i = 0; i < 50 && !fake.byContent('Sofort rüber'); i++) await new Promise((r) => setTimeout(r, 20));
    t.app.services.todoistPushDelayMs = -1;
    expect(fake.byContent('Sofort rüber')).toBeTruthy();
    // a task created without a request (workflow, AI) is found by the tick scan
    t.app.db.insert('tasks', { id: 'wf-task-1', location_id: me.locations[0].id, title: 'Vom Workflow', description: '', due_at: null, done: 0, created_at: new Date().toISOString() });
    await t.app.tick();
    expect(fake.byContent('Vom Workflow')).toBeTruthy();
  });

  it('accepts signed webhooks only', async () => {
    expect((await t.api.raw('/hooks/todoist', { method: 'POST', body: '{}' })).status).toBe(404);
    await t.api.patch('/api/agency/todoist', { webhook_secret: 'client-secret' });
    const body = JSON.stringify({ event_name: 'item:updated', user_id: '4711', event_data: { id: 'x' } });
    const sig = createHmac('sha256', 'client-secret').update(body).digest('base64');
    const bad = await t.api.raw('/hooks/todoist', { method: 'POST', headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': 'AAAA' }, body });
    expect(bad.status).toBe(401);
    const ok = await t.api.raw('/hooks/todoist', { method: 'POST', headers: { 'content-type': 'application/json', 'x-todoist-hmac-sha256': sig }, body });
    expect(ok.status).toBe(200);
    expect(JSON.stringify((await t.api.get('/api/agency/todoist')).data)).not.toContain('client-secret');
  });

  it('exposes status and a sync trigger over MCP', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const res = (await r.json()).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
    const st = await call('ghl_todoist_sync_status', {});
    expect(st).toMatchObject({ enabled: true, connected: true, direction: 'both', account: { name: 'Paul' } });
    expect(st.totals.linked).toBeGreaterThan(3);
    expect(JSON.stringify(st)).not.toContain(fake.token);
    const run = await call('ghl_todoist_sync', { full: true });
    expect(run.last_error).toBe('');
  });

  it('a full read closes tasks that vanished in Todoist meanwhile and stops before mass deletions', async () => {
    const lost = (await t.api.post('/api/tasks', { title: 'Verpasst' })).data;
    const recent = (await t.api.post('/api/tasks', { title: 'Gerade erst abgeglichen' })).data;
    await sync();
    // changed without showing up in an incremental read
    fake.byContent('Verpasst').checked = true;
    fake.byContent('Gerade erst abgeglichen').checked = true;
    t.app.db.run('UPDATE todoist_links SET synced_at = ? WHERE task_id = ?', new Date(Date.now() - 3600_000).toISOString(), lost.id);
    await sync(true);
    expect((await task(lost.id)).done).toBe(1);
    // synced moments before the snapshot: the snapshot may lag behind, so it is left alone
    expect((await task(recent.id)).done).toBe(0);

    const many = [];
    for (let i = 0; i < 30; i++) many.push((await t.api.post('/api/tasks', { title: `Massen ${i}` })).data.id);
    await sync();
    const linkedBefore = Number(t.app.db.get(`SELECT COUNT(*) AS n FROM todoist_links WHERE status = 'active'`).n);
    t.app.db.run(`DELETE FROM tasks WHERE title LIKE 'Massen %' OR (location_id = ? AND title NOT LIKE 'Massen %')`, me.locations[0].id);
    const v = await sync();
    expect(v.log[0].message).toContain('Sicherheitsstopp');
    expect([...fake.items.values()].filter((i) => i.content.startsWith('Massen') && !i.is_deleted).length).toBe(30);
    expect(linkedBefore).toBeGreaterThan(30);
  });
});

describe('todoist sync – one project with a section per sub-account', () => {
  let t2: Awaited<ReturnType<typeof startTestApp>>;
  const fake2 = new FakeTodoist();
  let locA: string;
  let locB: string;
  let locC: string;
  const sync2 = async (full = false) => {
    const r = await t2.api.post('/api/agency/todoist/sync', { full });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data;
  };
  const inLoc = async <T,>(loc: string, fn: () => Promise<T>) => {
    const prev = t2.api.location;
    t2.api.setLocation(loc);
    try {
      return await fn();
    } finally {
      t2.api.setLocation(prev);
    }
  };
  const tasksOf = (loc: string) => inLoc(loc, async () => (await t2.api.get('/api/tasks?status=all')).data as any[]);

  beforeAll(async () => {
    t2 = await startTestApp();
    const me2 = await t2.setup();
    locA = me2.locations[0].id; // Testfirma
    t2.app.services.todoistFetch = fake2.fetch;
    t2.app.services.todoistSleep = async () => {};
    t2.app.services.todoistPushDelayMs = -1;
    locB = (await t2.api.post('/api/locations', { name: 'Privat' })).data.id;
    locC = (await t2.api.post('/api/locations', { name: 'Agentur intern' })).data.id;
  });
  afterAll(async () => {
    await t2.close();
  });

  it('does not switch syncing on when the first token would create one project per sub-account', async () => {
    expect((await t2.api.get('/api/agency/todoist')).data.layout).toBe('sections'); // default for new setups
    const r = await t2.api.patch('/api/agency/todoist', { layout: 'projects', token: fake2.token });
    expect(r.data).toMatchObject({ token_set: true, enabled: false, layout: 'projects' });
    expect(fake2.requests.map((x) => x.path)).toEqual(['/user']);
    expect((await t2.api.post('/api/agency/todoist/sync', {})).status).toBe(400);
    const s = await t2.api.patch('/api/agency/todoist', { layout: 'sections', enabled: true });
    expect(s.data).toMatchObject({ layout: 'sections', enabled: true, home: { id: null, name: 'HyperLevel', picked: false } });
  });

  it('creates one project with a section per sub-account and sends tasks into the sections', async () => {
    await t2.api.put(`/api/agency/todoist/mapping/${locC}`, { mode: 'off' });
    await t2.api.post('/api/tasks', { title: 'Website-Relaunch' });
    await inLoc(locB, () => t2.api.post('/api/tasks', { title: 'Steuer abgeben' }));
    await inLoc(locC, () => t2.api.post('/api/tasks', { title: 'Intern bleibt hier' }));
    const v = await sync2();
    expect([...fake2.projects.values()].map((p) => p.name)).toEqual(['HyperLevel']);
    const home = fake2.projectByName('HyperLevel');
    expect(home.parent_id).toBeNull();
    const secA = fake2.sectionByName('Testfirma');
    const secB = fake2.sectionByName('Privat');
    expect([secA.project_id, secB.project_id]).toEqual([home.id, home.id]);
    expect(fake2.sectionByName('Agentur intern')).toBeUndefined();
    expect(fake2.byContent('Website-Relaunch')).toMatchObject({ project_id: home.id, section_id: secA.id, labels: ['ghp'] });
    expect(fake2.byContent('Steuer abgeben')).toMatchObject({ project_id: home.id, section_id: secB.id });
    expect(fake2.byContent('Intern bleibt hier')).toBeUndefined();
    expect(v.home).toMatchObject({ id: home.id, name: 'HyperLevel' });
    expect(v.locations.find((l: any) => l.id === locA)).toMatchObject({ mode: 'auto', section_id: secA.id, section_name: 'Testfirma', ready: true });
    expect(v.log.some((l: any) => l.message.includes('2 Abschnitte in „HyperLevel“ angelegt'))).toBe(true);

    await sync2();
    expect(fake2.projects.size).toBe(1);
    expect(fake2.sections.size).toBe(2);

    // renaming a sub-account renames its section
    await inLoc(locB, () => t2.api.patch('/api/location', { name: 'Privat & Familie' }));
    await sync2();
    expect(fake2.sections.get(secB.id).name).toBe('Privat & Familie');
    expect(fake2.sections.size).toBe(2);

    // a new project name renames the project instead of creating a second one
    await t2.api.patch('/api/agency/todoist', { parent_name: 'GHP Aufgaben' });
    await sync2();
    expect([...fake2.projects.values()].map((p) => p.name)).toEqual(['GHP Aufgaben']);
    await t2.api.patch('/api/agency/todoist', { parent_name: 'HyperLevel' });
    await sync2();
    expect(fake2.projectByName('HyperLevel')?.id).toBe(home.id);
    expect(fake2.byContent('Website-Relaunch').section_id).toBe(secA.id);
  });

  it('imports tasks from mapped sections only and completes them both ways', async () => {
    const home = fake2.projectByName('HyperLevel');
    const secA = fake2.sectionByName('Testfirma');
    const inSection = fake2.addItem(home.id, 'Im Abschnitt angelegt', { section_id: secA.id });
    fake2.addItem(home.id, 'Ohne Abschnitt');
    const other = fake2.addSection(home.id, 'Sonstiges');
    fake2.addItem(home.id, 'Fremder Abschnitt', { section_id: other.id });
    await sync2();
    const a = await tasksOf(locA);
    const imported = a.find((x) => x.title === 'Im Abschnitt angelegt');
    expect(imported).toMatchObject({ contact_id: null, done: 0 });
    const everywhere = [...a, ...(await tasksOf(locB)), ...(await tasksOf(locC))].map((x) => x.title);
    expect(everywhere).not.toContain('Ohne Abschnitt');
    expect(everywhere).not.toContain('Fremder Abschnitt');

    // optional: tasks without a section go to a chosen sub-account (incl. the ones already there)
    await t2.api.patch('/api/agency/todoist', { unsectioned_location_id: locB });
    await sync2();
    expect((await tasksOf(locB)).some((x) => x.title === 'Ohne Abschnitt')).toBe(true);
    expect((await tasksOf(locB)).some((x) => x.title === 'Fremder Abschnitt')).toBe(false);

    // complete in Todoist → done here; reopen here → reopened there
    fake2.edit(inSection.id, { checked: true, completed_at: '2026-10-04T12:00:00.000000Z' });
    await sync2();
    expect((await tasksOf(locA)).find((x) => x.id === imported.id).done).toBe(1);
    await t2.api.patch(`/api/tasks/${imported.id}`, { done: false });
    await sync2();
    expect(fake2.items.get(inSection.id).checked).toBe(false);
    await t2.api.patch(`/api/tasks/${imported.id}`, { done: true });
    await sync2();
    expect(fake2.items.get(inSection.id).checked).toBe(true);
  });

  it('maps a sub-account to an existing section', async () => {
    const home = fake2.projectByName('HyperLevel');
    const bestand = fake2.addSection(home.id, 'Bestand');
    fake2.addItem(home.id, 'Alte Aufgabe', { section_id: bestand.id });
    await sync2(); // not mapped yet
    const list = (await t2.api.get('/api/agency/todoist/sections')).data;
    expect(list.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Testfirma', 'Privat & Familie', 'Bestand']));
    await t2.api.put(`/api/agency/todoist/mapping/${locC}`, { mode: 'existing', section_id: bestand.id, section_name: 'Bestand' });
    await sync2();
    const c = await tasksOf(locC);
    expect(c.some((x) => x.title === 'Alte Aufgabe')).toBe(true);
    expect(fake2.byContent('Intern bleibt hier')).toMatchObject({ section_id: bestand.id });
  });

  it('stops at a Todoist plan limit with a clear message instead of retrying', async () => {
    // a new sub-account needs a section, but the project already has the maximum
    const locD = (await t2.api.post('/api/locations', { name: 'Neukunde' })).data.id;
    await inLoc(locD, () => t2.api.post('/api/tasks', { title: 'Erstgespräch' }));
    fake2.maxSections = [...fake2.sections.values()].filter((x) => !x.is_deleted).length;
    const v = await sync2();
    expect(v.state.limit_error).toContain('Todoist-Limit erreicht');
    expect(v.state.limit_error).toContain('Abschnitt „Neukunde“');
    expect(v.state.limit_error).toContain('Ein Projekt mit Abschnitten');
    expect(v.state.last_error).toBe('');
    expect(fake2.byContent('Erstgespräch')).toBeUndefined();
    const logged = () => t2.app.db.all(`SELECT * FROM todoist_log WHERE message LIKE 'Todoist-Limit%'`).length;
    expect(logged()).toBe(1);

    // background runs do not hammer Todoist with the same request
    const before = fake2.commands().filter((c: any) => c.type === 'section_add').length;
    await t2.app.tick();
    expect(fake2.commands().filter((c: any) => c.type === 'section_add').length).toBe(before);
    expect(logged()).toBe(1);

    // one project per sub-account on a free plan: the project limit is reported the same way
    fake2.maxProjects = fake2.projects.size + 1;
    const p = await t2.api.patch('/api/agency/todoist', { layout: 'projects' });
    expect(p.data.state.limit_error).toBe(''); // a settings change allows a new try
    const pv = await sync2();
    expect(pv.state.limit_error).toMatch(/Projekt „.+“ konnte nicht angelegt werden/);
    expect(pv.log.filter((l: any) => l.level === 'error' && /Invalid temporary id/.test(l.message))).toEqual([]);
    expect(fake2.projects.size).toBe(2); // one went through, the rest hit the limit

    // more room (e.g. after an upgrade) → "Jetzt abgleichen" goes through
    fake2.maxProjects = 1000;
    fake2.maxSections = 1000;
    await t2.api.patch('/api/agency/todoist', { layout: 'sections' });
    const ok = await sync2();
    expect(ok.state.limit_error).toBe('');
    expect(fake2.byContent('Erstgespräch')).toMatchObject({ section_id: fake2.sectionByName('Neukunde').id });
  });

  it('switches syncing off when the project is deleted in Todoist and leaves the tasks alone', async () => {
    const home = fake2.projectByName('HyperLevel');
    const open = (await tasksOf(locA)).filter((x) => !x.done);
    expect(open.length).toBeGreaterThan(0);
    home.is_deleted = true;
    fake2.touch('project', home);
    for (const it of fake2.items.values()) if (it.project_id === home.id) fake2.edit(it.id, { is_deleted: true });
    const v = await sync2();
    expect(v.enabled).toBe(false);
    expect(v.log.some((l: any) => l.message.includes('„HyperLevel“ gibt es nicht mehr'))).toBe(true);
    expect((await tasksOf(locA)).filter((x) => !x.done).length).toBe(open.length);
    expect(v.locations.every((l: any) => !l.section_id)).toBe(true);
    expect((await t2.api.post('/api/agency/todoist/sync', {})).status).toBe(400);
  });

  it('uses an existing project picked by id and adopts sections named like the sub-accounts', async () => {
    const mine = fake2.addProject('Mein Business');
    const sec = fake2.addSection(mine.id, 'Testfirma');
    fake2.addItem(mine.id, 'Schon in Todoist', { section_id: sec.id });
    const before = fake2.projects.size;
    const r = await t2.api.patch('/api/agency/todoist', { home_project_id: mine.id, home_project_name: 'Mein Business', enabled: true });
    expect(r.data.home).toEqual({ id: mine.id, name: 'Mein Business', picked: true });
    await sync2();
    expect(fake2.projects.size).toBe(before); // nothing new
    const inMine = [...fake2.sections.values()].filter((x) => x.project_id === mine.id && !x.is_deleted).map((x) => x.name);
    expect(inMine.filter((n) => n === 'Testfirma').length).toBe(1);
    expect(inMine).toEqual(expect.arrayContaining(['Testfirma', 'Privat & Familie', 'Neukunde']));
    expect((await tasksOf(locA)).some((x) => x.title === 'Schon in Todoist')).toBe(true);
    expect(fake2.byContent('Website-Relaunch')).toBeTruthy();
  });
});
