import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { token, sha256 } from '../server/core/util.js';
import { day, setupPm, settle, type Pm } from './pm-helpers.js';
import { client, type Call } from './security-fixtures.js';

/**
 * The planner next to the rest of the app: customer portal, rights and sub-account isolation, MCP tools and
 * the mobile API.
 */

let p: Pm;
let t: Pm['t'];
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

beforeAll(async () => {
  p = await setupPm();
  t = p.t;
});
afterAll(() => t.close());

describe('customer portal', () => {
  const memberCookie = (contactId: string) => {
    const raw = token(32);
    t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), p.A, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
    return `pm_${p.A}=${raw}`;
  };
  const get = async (path: string, cookie = '') => {
    const r = await t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    return { status: r.status, html: await r.text() };
  };

  it('shows shared projects read-only to the linked customer – boards, milestones, progress, nothing internal', async () => {
    const hanna = (await api().post('/api/contacts', { first_name: 'Hanna', last_name: 'Hell', email: 'hanna@kunde.de' })).data.id;
    const otto = (await api().post('/api/contacts', { first_name: 'Otto', last_name: 'Ohne', email: 'otto@kunde.de' })).data.id;
    const company = (await api().post('/api/companies', { name: 'Hell AG', domain: 'hell-ag.de' })).data.id;
    await api().post('/api/associations', { from_type: 'contact', from_id: hanna, to_type: 'company', to_id: company });

    const shared = await project({ name: 'Website Hell', contact_id: hanna, portal_visible: true, description: 'Euer neuer Auftritt', due_at: '2026-12-01' });
    await task({ title: 'Design fertig', project_id: shared.id, status: 'Erledigt', due_at: '2026-10-20' });
    await task({ title: 'Texte <script>alert(1)</script>', project_id: shared.id, status: 'In Arbeit', due_at: day(-3), assignees: [p.anna.id] });
    await task({ title: 'Go-live', project_id: shared.id, milestone: true, due_at: '2026-11-30' });
    await task({ title: 'Interner Aufschlag kalkulieren', project_id: shared.id, internal: true });
    const parent = await task({ title: 'Seitenstruktur', project_id: shared.id, subtasks: ['Startseite', { title: 'Interne Unteraufgabe', internal: true }] });
    await api().post(`/api/pm/tasks/${parent.id}/comments`, { body: 'GEHEIMER KOMMENTAR' });
    await api().post('/api/pm/time', { task_id: parent.id, minutes: 600, date: day(-1), note: 'GEHEIME ZEIT' });
    await api().put('/api/pm/billing/rates', { user_id: p.anna.id, project_id: shared.id, rate_cents: 987654 });

    const viaCompany = await project({ name: 'Marke Hell AG', company_id: company, portal_visible: true });
    await project({ name: 'Nicht geteilt', contact_id: hanna });
    await project({ name: 'Für Otto', contact_id: otto, portal_visible: true });
    const archived = await project({ name: 'Altes Projekt', contact_id: hanna, portal_visible: true });
    await api().patch(`/api/pm/projects/${archived.id}`, { status: 'archived' });

    const cookie = memberCookie(hanna);
    const list = await get(`/portal/${p.A}/projects`, cookie);
    expect(list.status).toBe(200);
    expect(list.html).toContain('Meine Projekte');
    expect(list.html).toContain('Website Hell');
    expect(list.html).toContain('Marke Hell AG');
    for (const hidden of ['Nicht geteilt', 'Für Otto', 'Altes Projekt', 'Allgemein']) expect(list.html).not.toContain(hidden);
    expect(list.html).toContain('1 von 5 Aufgaben erledigt');

    const board = await get(`/portal/${p.A}/projects/${shared.id}`, cookie);
    expect(board.status).toBe(200);
    expect(board.html).toContain('Design fertig');
    expect(board.html).toContain('◆ Go-live');
    expect(board.html).toContain('Meilensteine');
    expect(board.html).toContain('Euer neuer Auftritt');
    expect(board.html).toContain('0/1 Unteraufgaben');
    expect(board.html).toContain('In Arbeit');
    expect(board.html).toContain('Anna'); // first name of an assignee
    // the title is escaped, nothing internal shows
    expect(board.html).toContain('Texte &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(board.html).not.toContain('<script>alert(1)');
    for (const secret of ['Interner Aufschlag', 'Interne Unteraufgabe', 'GEHEIM', '987654', '9876,54', 'Beobachter', 'estimate']) expect(board.html).not.toContain(secret);
    // an overdue date is marked
    expect(board.html).toContain('pj-late');
    expect((await get(`/portal/${p.A}/projects/${viaCompany.id}`, cookie)).status).toBe(200);

    // someone else's, unshared, archived and unknown projects are not found
    const other = (await api().get('/api/pm/projects?status=all')).data;
    for (const name of ['Nicht geteilt', 'Für Otto', 'Altes Projekt', 'Allgemein']) expect((await get(`/portal/${p.A}/projects/${other.find((x: any) => x.name === name).id}`, cookie)).status).toBe(404);
    expect((await get(`/portal/${p.A}/projects/unbekannt`, cookie)).status).toBe(404);
    // Otto sees his own only
    const ottos = await get(`/portal/${p.A}/projects`, memberCookie(otto));
    expect(ottos.html).toContain('Für Otto');
    expect(ottos.html).not.toContain('Website Hell');
    expect((await get(`/portal/${p.A}/projects/${shared.id}`, memberCookie(otto))).status).toBe(404);
    // logged out: back to the login, which remembers the page
    const anon = await get(`/portal/${p.A}/projects`);
    expect(anon.status).toBe(401);
    expect(anon.html).toContain(`name="next" value="/portal/${p.A}/projects"`);
    // the start page links to it, and a customer with nothing shared has no link
    const home = await get(`/portal/${p.A}`, cookie);
    expect(home.html).toContain('Meine Projekte');
    expect(home.html).toContain('Projekte ansehen');
    const nobody = (await api().post('/api/contacts', { first_name: 'Nina', email: 'nina@kunde.de' })).data.id;
    expect((await get(`/portal/${p.A}`, memberCookie(nobody))).html).not.toContain('Projekte ansehen');
    // switching sharing off hides it at once; a customer with a shared project may log in
    expect(t.app.services.portalMemberCheck.some((fn: any) => fn(p.A, hanna))).toBe(true);
    await api().patch(`/api/pm/projects/${shared.id}`, { portal_visible: false });
    expect((await get(`/portal/${p.A}/projects/${shared.id}`, cookie)).status).toBe(404);
    expect((await get(`/portal/${p.A}/projects`, cookie)).html).not.toContain('Website Hell');
  });
});

describe('rights and sub-account isolation', () => {
  it('keeps the planner to people with the tasks area and money to people with the payments area', async () => {
    const nora = await p.login(p.nora.email);
    const anna = await p.login(p.anna.email);
    for (const path of ['/api/pm/projects', '/api/pm/tasks', '/api/pm/time', '/api/pm/meta', '/api/pm/timer', '/api/pm/notifications', '/api/pm/workload']) expect((await nora('GET', path)).status, path).toBe(403);
    expect((await nora('POST', '/api/pm/tasks', { title: 'Nein' })).status).toBe(403);
    expect((await nora('POST', '/api/pm/timer/start', { project_id: 'x' })).status).toBe(403);
    expect((await anna('GET', '/api/pm/projects')).status).toBe(200);
    for (const [method, path] of [['GET', '/api/pm/billing/unbilled'], ['GET', '/api/pm/billing/rates'], ['PUT', '/api/pm/billing/rates'], ['POST', '/api/pm/billing/invoice'], ['GET', '/api/pm/billing/entries']] as const) expect((await anna(method, path, method === 'GET' ? undefined : {})).status, path).toBe(403);
    // the leadership-only settings
    expect((await anna('PUT', '/api/pm/settings', { approval_required: true })).data.error).toContain('Leitung');
    expect((await anna('GET', '/api/pm/settings')).data.approval_required).toBe(false);
    // billing parameters need the invoices area as well: a member with "Einstellungen" but without it is refused
    const sven = (await t.api.post('/api/users', { email: 'sven@example.com', name: 'Sven Leitung', password: 'passwort-1', role: 'member', locations: [p.A], permissions: ['contacts', 'settings'] })).data;
    expect(sven.id).toBeTruthy();
    const svenApi = await p.login('sven@example.com');
    expect((await svenApi('PUT', '/api/pm/settings', { capacity_hours: 36 })).status).toBe(200);
    expect((await svenApi('PUT', '/api/pm/settings', { default_rate_cents: 12000 })).status).toBe(403);
    expect((await svenApi('PUT', '/api/pm/settings', { round_up_minutes: 15 })).status).toBe(403);
    expect((await api().put('/api/pm/settings', { capacity_hours: 40 })).status).toBe(200);
    // not signed in at all
    expect((await t.api.raw('/api/pm/projects')).status).toBe(401);
    // a member of A cannot work in B
    const inB = await anna('GET', '/api/pm/projects', undefined, { 'x-location-id': p.B });
    expect(inB.status).toBe(403);
  });

  it('never reads or changes another sub-account\'s projects, tasks, time, rules, views or templates', async () => {
    const MARK = 'FREMDMARKE';
    // B's data (written as the admin in B)
    t.api.setLocation(p.B);
    const bContact = (await api().post('/api/contacts', { first_name: MARK, email: 'fremd@b.de' })).data.id;
    const bProject = (await api().post('/api/pm/projects', { name: `${MARK} Projekt`, contact_id: bContact, portal_visible: true })).data;
    const bTask = (await api().post('/api/pm/tasks', { title: `${MARK} Aufgabe`, project_id: bProject.id, subtasks: ['Kind'], due_at: day(1), assignees: [p.chef] })).data;
    const bOther = (await api().post('/api/pm/tasks', { title: `${MARK} Zwei`, project_id: bProject.id })).data;
    const bComment = (await api().post(`/api/pm/tasks/${bTask.id}/comments`, { body: `${MARK} Kommentar` })).data;
    const bAttach = (await api().post(`/api/pm/tasks/${bTask.id}/attachments`, { url: 'https://example.com/fremd', name: MARK })).data;
    const bTime = (await api().post('/api/pm/time', { task_id: bTask.id, minutes: 60, date: day(-1), note: MARK })).data;
    const bStatus = (await api().get(`/api/pm/projects/${bProject.id}/statuses`)).data[0];
    const bSection = (await api().post(`/api/pm/projects/${bProject.id}/sections`, { name: `${MARK} Abschnitt` })).data;
    const bField = (await api().post('/api/pm/custom-fields', { label: `${MARK} Feld`, type: 'text' })).data;
    const bRule = (await api().post('/api/pm/automations', { name: `${MARK} Regel`, trigger: 'task.created', actions: [{ type: 'add_tag', tag: 'x' }] })).data;
    const bView = (await api().post('/api/pm/views', { name: `${MARK} Ansicht`, shared: true, config: {} })).data;
    const bTemplate = (await api().post(`/api/pm/projects/${bProject.id}/save-template`, { name: `${MARK} Vorlage` })).data;
    const bDep = (await api().post(`/api/pm/tasks/${bOther.id}/dependencies`, { depends_on: bTask.id })).data;
    expect(bDep.blocked_by).toHaveLength(1);
    const bDepId = bDep.blocked_by[0].id;
    t.api.setLocation(p.A);

    const aProject = await project({ name: 'A Projekt' });
    const aTask = await task({ title: 'A Aufgabe', project_id: aProject.id });
    // everything B owns, serialised: nothing an attempt from A does may change it
    const byLocation = ['pm_projects', 'tasks', 'pm_time_entries', 'pm_automations', 'pm_views', 'pm_templates', 'pm_statuses', 'pm_sections', 'pm_custom_fields', 'pm_dependencies', 'pm_comments', 'pm_attachments'];
    const snapshot = () =>
      JSON.stringify([
        ...byLocation.map((tbl) => t.app.db.all(`SELECT * FROM ${tbl} WHERE location_id = ? ORDER BY id`, p.B)),
        t.app.db.all('SELECT a.* FROM pm_assignees a JOIN tasks x ON x.id = a.task_id WHERE x.location_id = ? ORDER BY a.task_id, a.user_id', p.B),
      ]);
    const before = snapshot();

    // every route that takes an id answers "not found" and changes nothing
    const attempts: [string, string, any?][] = [
      ['GET', `/api/pm/projects/${bProject.id}`],
      ['PATCH', `/api/pm/projects/${bProject.id}`, { name: 'gekapert' }],
      ['DELETE', `/api/pm/projects/${bProject.id}`],
      ['POST', `/api/pm/projects/${bProject.id}/duplicate`, {}],
      ['POST', `/api/pm/projects/${bProject.id}/save-template`, {}],
      ['GET', `/api/pm/projects/${bProject.id}/gantt`],
      ['POST', `/api/pm/projects/${bProject.id}/baseline`, {}],
      ['POST', `/api/pm/projects/${bProject.id}/auto-schedule`, {}],
      ['POST', `/api/pm/projects/${bProject.id}/statuses`, { name: 'Neu' }],
      ['POST', `/api/pm/projects/${bProject.id}/sections`, { name: 'Neu' }],
      ['GET', `/api/pm/tasks/${bTask.id}`],
      ['PATCH', `/api/pm/tasks/${bTask.id}`, { title: 'gekapert' }],
      ['DELETE', `/api/pm/tasks/${bTask.id}`],
      ['PATCH', `/api/pm/tasks/${bTask.id}/dates`, { start: '2030-01-01', due: '2030-01-02' }],
      ['POST', `/api/pm/tasks/${bTask.id}/move`, { status: 'Erledigt' }],
      ['POST', `/api/pm/tasks/${bTask.id}/duplicate`, {}],
      ['POST', `/api/pm/tasks/${bTask.id}/watch`, {}],
      ['GET', `/api/pm/tasks/${bTask.id}/comments`],
      ['POST', `/api/pm/tasks/${bTask.id}/comments`, { body: 'hallo' }],
      ['GET', `/api/pm/tasks/${bTask.id}/attachments`],
      ['POST', `/api/pm/tasks/${bTask.id}/attachments`, { url: 'https://example.com/x' }],
      ['GET', `/api/pm/tasks/${bTask.id}/activity`],
      ['GET', `/api/pm/tasks/${bTask.id}/dependencies`],
      ['POST', `/api/pm/tasks/${aTask.id}/dependencies`, { depends_on: bTask.id }],
      ['POST', `/api/pm/tasks/${bTask.id}/dependencies`, { depends_on: aTask.id }],
      ['PATCH', `/api/pm/comments/${bComment.id}`, { body: 'gekapert' }],
      ['DELETE', `/api/pm/comments/${bComment.id}`],
      ['GET', `/api/pm/attachments/${bAttach.id}/file`],
      ['DELETE', `/api/pm/attachments/${bAttach.id}`],
      ['PATCH', `/api/pm/dependencies/${bDepId}`, { type: 'SS' }],
      ['DELETE', `/api/pm/dependencies/${bDepId}`],
      ['PATCH', `/api/pm/statuses/${bStatus.id}`, { name: 'gekapert' }],
      ['DELETE', `/api/pm/statuses/${bStatus.id}`],
      ['PATCH', `/api/pm/sections/${bSection.id}`, { name: 'gekapert' }],
      ['DELETE', `/api/pm/sections/${bSection.id}`],
      ['PATCH', `/api/pm/custom-fields/${bField.id}`, { label: 'gekapert' }],
      ['DELETE', `/api/pm/custom-fields/${bField.id}`],
      ['PATCH', `/api/pm/automations/${bRule.id}`, { enabled: false }],
      ['DELETE', `/api/pm/automations/${bRule.id}`],
      ['PATCH', `/api/pm/views/${bView.id}`, { name: 'gekapert' }],
      ['DELETE', `/api/pm/views/${bView.id}`],
      ['DELETE', `/api/pm/templates/${bTemplate.id}`],
      ['PATCH', `/api/pm/time/${bTime.id}`, { note: 'gekapert' }],
      ['DELETE', `/api/pm/time/${bTime.id}`],
      ['POST', '/api/pm/projects', { name: 'Aus fremder Vorlage', template: bTemplate.id }],
      ['POST', '/api/pm/projects', { name: 'Fremder Kunde', contact_id: bContact }],
      ['POST', '/api/pm/tasks', { title: 'In fremdem Projekt', project_id: bProject.id }],
      ['POST', '/api/pm/tasks', { title: 'Unter fremder Aufgabe', parent_id: bTask.id }],
      ['POST', '/api/pm/tasks', { title: 'Mit fremdem Kontakt', contact_id: bContact }],
      ['PATCH', `/api/pm/tasks/${aTask.id}`, { project_id: bProject.id }],
      ['PATCH', `/api/pm/tasks/${aTask.id}`, { parent_id: bTask.id }],
      ['PATCH', `/api/pm/tasks/${aTask.id}`, { section_id: bSection.id }],
      ['PATCH', `/api/pm/tasks/${aTask.id}`, { status_id: bStatus.id }],
      ['POST', '/api/pm/time', { task_id: bTask.id, minutes: 30, date: day(-1) }],
      ['POST', '/api/pm/timer/start', { task_id: bTask.id }],
      ['POST', '/api/pm/timer/start', { project_id: bProject.id }],
      ['POST', '/api/pm/billing/invoice', { entry_ids: [bTime.id] }],
      ['POST', '/api/pm/billing/invoice', { project_id: bProject.id }],
      ['PUT', '/api/pm/billing/rates', { project_id: bProject.id, user_id: p.chef, rate_cents: 1 }],
      ['POST', '/api/pm/automations', { name: 'x', trigger: 'task.created', project_id: bProject.id, actions: [{ type: 'add_tag', tag: 'a' }] }],
      ['POST', '/api/pm/custom-fields', { label: 'x', project_id: bProject.id }],
      ['POST', '/api/pm/views', { name: 'x', project_id: bProject.id, config: {} }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await api()[method === 'GET' ? 'get' : method === 'POST' ? 'post' : method === 'PATCH' ? 'patch' : method === 'PUT' ? 'put' : 'del'](path, ...(method === 'GET' || method === 'DELETE' ? [] : [body ?? {}]) as [any]);
      expect([400, 404], `${method} ${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`).toContain(r.status);
      expect(JSON.stringify(r.data)).not.toContain(MARK);
    }
    expect(snapshot()).toBe(before);

    // lists never contain B's rows – with the marker anywhere in the answer
    for (const path of ['/api/pm/projects?status=all', '/api/pm/tasks', '/api/pm/my-tasks', '/api/pm/workload', '/api/pm/time', '/api/pm/time/report?group=project', '/api/pm/notifications', '/api/pm/views', '/api/pm/automations', '/api/pm/templates', '/api/pm/custom-fields', '/api/pm/billing/unbilled', '/api/pm/team', '/api/pm/meta', `/api/pm/tasks?ids=${bTask.id}`, `/api/pm/tasks?project_id=${bProject.id}`, `/api/pm/tasks?contact_id=${bContact}`, `/api/pm/projects?contact_id=${bContact}`, `/api/pm/time?project_id=${bProject.id}`]) {
      const r = await api().get(path);
      expect(r.status, path).toBeLessThan(500);
      expect(JSON.stringify(r.data), path).not.toContain(MARK);
      expect(JSON.stringify(r.data), path).not.toContain(bTask.id);
    }
    // a location key sees only its own sub-account
    const key = (await api().post('/api/api-keys', { name: 'Isolation' })).data.key;
    const k: Call = client(t.base, { authorization: `Bearer ${key}`, 'x-location-id': p.A });
    expect((await k('GET', '/api/pm/projects')).status).toBe(200);
    expect((await k('GET', `/api/pm/tasks/${bTask.id}`)).status).toBe(404);
    expect((await k('GET', '/api/pm/projects', undefined, { 'x-location-id': p.B })).data).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: `${MARK} Projekt` })]));
    // B's own view of its data is intact
    t.api.setLocation(p.B);
    expect((await api().get(`/api/pm/tasks/${bTask.id}`)).data.task.title).toBe(`${MARK} Aufgabe`);
    expect((await api().get(`/api/pm/projects/${bProject.id}`)).data.name).toBe(`${MARK} Projekt`);
    t.api.setLocation(p.A);
  });

  it('keeps a person\'s notifications and views private', async () => {
    const anna = await p.login(p.anna.email);
    const ben = await p.login(p.ben.email);
    const x = await task({ title: 'Privat?', assignees: [p.anna.id] });
    expect((await anna('GET', '/api/pm/notifications')).data.items.some((n: any) => n.task_id === x.id)).toBe(true);
    expect((await ben('GET', '/api/pm/notifications')).data.items.some((n: any) => n.task_id === x.id)).toBe(false);
    const n = (await anna('GET', '/api/pm/notifications')).data.items[0];
    expect((await ben('POST', '/api/pm/notifications/read', { ids: [n.id] })).data.updated).toBe(0);
    expect((await anna('GET', '/api/pm/notifications?unread=1')).data.items.some((i: any) => i.id === n.id)).toBe(true);
  });
});

describe('MCP tools', () => {
  let agency: string;
  let locKey: string;
  const rpc = async (key: string, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await r.json()).result;
  };
  const ok = async (name: string, args: Record<string, unknown>, key = agency) => {
    const r = await rpc(key, name, args);
    expect(r.isError, `${name}: ${r.content?.[0]?.text}`).toBe(false);
    return r.structuredContent ?? JSON.parse(r.content[0].text);
  };

  beforeAll(async () => {
    agency = (await api().post('/api/agency/api-keys', { name: 'Planer-Agentur' })).data.key;
    locKey = (await api().post('/api/api-keys', { name: 'Planer-Sub-Account' })).data.key;
  });

  it('lists the planner tools', async () => {
    const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agency}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = (await r.json()).result.tools.map((x: any) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['ghl_pm_team', 'ghl_pm_list_projects', 'ghl_pm_get_project', 'ghl_pm_create_project', 'ghl_pm_list_tasks', 'ghl_pm_get_task', 'ghl_pm_create_task', 'ghl_pm_update_task', 'ghl_pm_move_task', 'ghl_pm_comment', 'ghl_pm_add_dependency', 'ghl_pm_gantt', 'ghl_pm_log_time', 'ghl_pm_timer', 'ghl_pm_timesheet_summary', 'ghl_pm_invoice_time', 'ghl_pm_my_tasks']));
  });

  it('plans a project: create with subtasks, assign by name, move status, comment, depend, schedule', async () => {
    const proj = await ok('ghl_pm_create_project', { location_id: p.A, name: 'Von der KI geplant', description: 'Plan' });
    expect(proj.name).toBe('Von der KI geplant');
    const root = await ok('ghl_pm_create_task', {
      location_id: p.A,
      project_id: proj.id,
      title: 'Kampagne starten',
      assignees: ['Anna Beispiel'],
      due_at: day(10),
      start_at: day(2),
      priority: 'high',
      estimate_hours: 6,
      tags: ['Marketing'],
      subtasks: [{ title: 'Texte', assignees: ['ben@example.com'], subtasks: ['Entwurf', 'Korrektur'] }, 'Bilder', { title: 'Freigabe', due_at: day(9) }],
    });
    expect(root).toMatchObject({ title: 'Kampagne starten', priority: 'Hoch', assignees: ['Anna Beispiel'], estimate_hours: 6, subtasks: '0/3', project: 'Von der KI geplant' });
    const list = await ok('ghl_pm_list_tasks', { location_id: p.A, project_id: proj.id });
    expect(list.total).toBe(6);
    const byTitle = (title: string) => list.tasks.find((x: any) => x.title === title);
    expect(byTitle('Texte')).toMatchObject({ parent_id: root.id, assignees: ['Ben Muster'] });
    expect(byTitle('Entwurf').parent_id).toBe(byTitle('Texte').id);
    expect((await ok('ghl_pm_list_tasks', { location_id: p.A, project_id: proj.id, top_level: true })).total).toBe(1);

    const moved = await ok('ghl_pm_move_task', { location_id: p.A, task_id: byTitle('Entwurf').id, status: 'In Arbeit' });
    expect(moved.status).toBe('In Arbeit');
    const done = await ok('ghl_pm_move_task', { location_id: p.A, task_id: byTitle('Entwurf').id, category: 'done' });
    expect(done).toMatchObject({ done: true, status: 'Erledigt' });
    expect((await ok('ghl_pm_list_tasks', { location_id: p.A, project_id: proj.id, status: 'Erledigt', done: 'all' })).total).toBe(1);
    expect((await ok('ghl_pm_list_tasks', { location_id: p.A, project_id: proj.id, assignee: 'Ben Muster' })).tasks.map((x: any) => x.title)).toEqual(['Texte']);
    const bad = await rpc(agency, 'ghl_pm_move_task', { location_id: p.A, task_id: byTitle('Bilder').id, status: 'Gibt es nicht' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('verfügbar');

    const upd = await ok('ghl_pm_update_task', { location_id: p.A, task_id: byTitle('Bilder').id, add_assignees: ['Anna Beispiel'], due_at: day(5), tags: ['Grafik'] });
    expect(upd.assignees).toEqual(['Anna Beispiel']);
    const dep = await ok('ghl_pm_add_dependency', { location_id: p.A, task_id: byTitle('Freigabe').id, depends_on: byTitle('Bilder').id, adjust_dates: false });
    expect(dep.waits_for[0]).toMatchObject({ task: 'Bilder', type: 'FS' });
    const cycle = await rpc(agency, 'ghl_pm_add_dependency', { location_id: p.A, task_id: byTitle('Bilder').id, depends_on: byTitle('Freigabe').id });
    expect(cycle.isError).toBe(true);
    expect(cycle.content[0].text).toContain('Zirkelbezug');
    const gantt = await ok('ghl_pm_gantt', { location_id: p.A, project_id: proj.id });
    expect(gantt.dependencies).toEqual([expect.objectContaining({ task: 'Freigabe', waits_for: 'Bilder', type: 'FS' })]);

    const comment = await ok('ghl_pm_comment', { location_id: p.A, task_id: root.id, body: 'Bitte prüfen @Ben Muster', mentions: ['Anna Beispiel'] });
    expect(comment.mentioned.sort()).toEqual(['Anna Beispiel', 'Ben Muster']);
    const full = await ok('ghl_pm_get_task', { location_id: p.A, task_id: root.id });
    expect(full.comments.map((c: any) => c.text)).toEqual(['Bitte prüfen @Ben Muster']);
    expect(full.subtasks.map((x: any) => x.title)).toEqual(['Texte', 'Bilder', 'Freigabe']);
    expect(full.project_statuses).toEqual(['Offen', 'In Arbeit', 'In Prüfung', 'Erledigt']);

    const projects = await ok('ghl_pm_list_projects', { location_id: p.A });
    expect(projects.find((x: any) => x.name === 'Von der KI geplant')).toMatchObject({ tasks: 6, open: 5, progress_percent: 17 });
    const fromTemplate = await ok('ghl_pm_create_project', { location_id: p.A, name: 'Onboarding per MCP', template: 'kunden-onboarding', start: '2026-10-05', hourly_rate_euro: 95 });
    expect(fromTemplate.hourly_rate_cents).toBe(9500);
    expect((await ok('ghl_pm_list_tasks', { location_id: p.A, project_id: fromTemplate.id })).total).toBe(17);
    const team = await ok('ghl_pm_team', { location_id: p.A });
    expect(team.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Anna Beispiel', 'Ben Muster']));
    const unknown = await rpc(agency, 'ghl_pm_create_task', { location_id: p.A, title: 'X', assignees: ['Niemand Bekanntes'] });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('nicht gefunden');
    const mine = await ok('ghl_pm_my_tasks', { location_id: p.A, user_id: 'anna@example.com' });
    expect(Object.values(mine).flat().length).toBeGreaterThan(0);
  });

  it('logs time, runs the timer, summarises timesheets and bills – with a person named, as a key has none', async () => {
    const proj = await ok('ghl_pm_create_project', { location_id: p.A, name: 'MCP Zeit', hourly_rate_euro: 100 });
    const x = await ok('ghl_pm_create_task', { location_id: p.A, project_id: proj.id, title: 'Beratung' });
    const needsUser = await rpc(locKey, 'ghl_pm_log_time', { location_id: p.A, task_id: x.id, minutes: 30 });
    expect(needsUser.isError).toBe(true);
    expect(needsUser.content[0].text).toContain('user_id');
    const d = day(-8);
    const logged = await ok('ghl_pm_log_time', { location_id: p.A, task_id: x.id, minutes: 90, date: d, user_id: 'Anna Beispiel', note: 'Workshop' }, locKey);
    expect(logged).toMatchObject({ hours: 1.5, day: d, task: 'Beratung', billable: true });
    await ok('ghl_pm_log_time', { location_id: p.A, project_id: proj.id, hours: 1, date: d, user_id: 'ben@example.com', billable: false });
    const overlap = await ok('ghl_pm_log_time', { location_id: p.A, task_id: x.id, start_at: `${day(-9)}T08:00:00Z`, end_at: `${day(-9)}T09:00:00Z`, user_id: 'Anna Beispiel' });
    expect(overlap.hours).toBe(1);
    const clash = await rpc(locKey, 'ghl_pm_log_time', { location_id: p.A, task_id: x.id, start_at: `${day(-9)}T08:30:00Z`, end_at: `${day(-9)}T09:30:00Z`, user_id: 'Anna Beispiel' });
    expect(clash.isError).toBe(true);
    expect(clash.content[0].text).toContain('Überschneidung');

    const timer = await ok('ghl_pm_timer', { location_id: p.A, action: 'start', task_id: x.id, user_id: 'Anna Beispiel' }, locKey);
    expect(timer.running.task).toBe('Beratung');
    expect((await ok('ghl_pm_timer', { location_id: p.A, action: 'status', user_id: 'Anna Beispiel' }, locKey)).running.task_title).toBe('Beratung');
    const stopped = await ok('ghl_pm_timer', { location_id: p.A, action: 'stop', user_id: 'Anna Beispiel' }, locKey);
    expect(stopped).toHaveProperty('discarded');
    t.app.db.run('DELETE FROM pm_time_entries WHERE ended_at IS NULL');

    const summary = await ok('ghl_pm_timesheet_summary', { location_id: p.A, from: day(-10), to: day(-7), group: 'user', project_id: proj.id });
    expect(summary).toMatchObject({ group: 'user', total_hours: 3.5, billable_hours: 2.5 });
    expect(summary.rows.map((r: any) => [r.name, r.hours])).toEqual(expect.arrayContaining([['Anna Beispiel', 2.5], ['Ben Muster', 1]]));
    const week = await ok('ghl_pm_timesheet_summary', { location_id: p.A, week: d, user_id: 'Anna Beispiel' });
    expect(week.total_hours).toBeGreaterThanOrEqual(1.5);
    expect(week.rows[0]).toMatchObject({ task: 'Beratung' });

    const invoice = await ok('ghl_pm_invoice_time', { location_id: p.A, project_id: proj.id, title: 'Beratung Oktober' });
    expect(invoice).toMatchObject({ entries: 2, hours: 2.5, net_euro: 250 });
    expect(invoice.invoice_number ?? '').toBe(''); // a draft has no number yet
    expect((await api().get(`/api/invoices/${invoice.invoice_id}`)).data.status).toBe('draft');
    const again = await rpc(agency, 'ghl_pm_invoice_time', { location_id: p.A, project_id: proj.id });
    expect(again.isError).toBe(true);
  });

  it('keeps a sub-account key inside its sub-account and respects member rights in the relay', async () => {
    const own = await ok('ghl_pm_list_projects', { location_id: p.A }, locKey);
    expect(own.length).toBeGreaterThan(0);
    const cross = await rpc(locKey, 'ghl_pm_list_projects', { location_id: p.B });
    expect(cross.isError).toBe(true);
    expect(cross.content[0].text).toContain('gilt nur für einen Sub-Account');
    // writes are in the audit log with the way they came in
    expect(t.app.db.get(`SELECT via FROM audit_log WHERE action = 'pm.tasks.create' AND via = 'mcp' LIMIT 1`)).toBeTruthy();
    await settle(t);
  });
});

describe('mobile API', () => {
  let tokenA: string;
  let tokenB: string;
  const app = async (method: string, path: string, tok: string, body?: unknown) => {
    const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (r.headers.get('content-type') ?? '').includes('json') ? ((await r.json()) as any) : await r.text() };
  };

  beforeAll(async () => {
    const anna = await p.login(p.anna.email);
    tokenA = (await anna('POST', '/api/mobile/pair', { device_name: 'Annas Handy' })).data.token;
    const nora = await p.login(p.nora.email);
    tokenB = (await nora('POST', '/api/mobile/pair', { device_name: 'Noras Handy' })).data.token;
  });

  it('lists my planner tasks, completes them, runs the timer and shows notifications', async () => {
    const proj = await project({ name: 'Unterwegs' });
    const mine = await task({ title: 'Kunden anrufen', project_id: proj.id, assignees: [p.anna.id], due_at: day(0), priority: 'high' });
    await task({ title: 'Nicht meine', project_id: proj.id, assignees: [p.ben.id] });
    const list = await app('GET', '/api/mobile/pm/tasks', tokenA);
    expect(list.status).toBe(200);
    const row = list.data.find((x: any) => x.id === mine.id);
    expect(row).toMatchObject({ title: 'Kunden anrufen', project_name: 'Unterwegs', status: 'Offen', status_category: 'todo', priority: 3, location_id: p.A, location_name: 'Testfirma' });
    expect(list.data.some((x: any) => x.title === 'Nicht meine')).toBe(false);
    expect((await app('GET', '/api/mobile/pm/tasks?filter=today', tokenA)).data.some((x: any) => x.id === mine.id)).toBe(true);
    expect((await app('GET', '/api/mobile/pm/tasks?filter=overdue', tokenA)).data.some((x: any) => x.id === mine.id)).toBe(false);
    const detail = await app('GET', `/api/mobile/pm/tasks/${mine.id}`, tokenA);
    expect(detail.data.statuses.map((s: any) => s.name)).toEqual(['Offen', 'In Arbeit', 'In Prüfung', 'Erledigt']);

    const comment = await app('POST', `/api/mobile/pm/tasks/${mine.id}/comments`, tokenA, { body: 'Habe ihn erreicht' });
    expect(comment.status).toBe(200);
    expect((await app('GET', `/api/mobile/pm/tasks/${mine.id}`, tokenA)).data.comments[0].text).toBe('Habe ihn erreicht');

    // timer
    expect((await app('GET', '/api/mobile/pm/timer', tokenA)).data.running).toBeNull();
    const started = await app('POST', '/api/mobile/pm/timer/start', tokenA, { location_id: p.A, task_id: mine.id });
    expect(started.status, JSON.stringify(started.data)).toBe(200);
    expect(started.data).toMatchObject({ task_title: 'Kunden anrufen', already_running: false });
    expect((await app('GET', '/api/mobile/pm/timer', tokenA)).data.running).toMatchObject({ task_id: mine.id, location_name: 'Testfirma' });
    t.app.db.run('UPDATE pm_time_entries SET started_at = ? WHERE ended_at IS NULL', new Date(Date.now() - 20 * 60_000).toISOString());
    const stopped = await app('POST', '/api/mobile/pm/timer/stop', tokenA, {});
    expect(stopped.data.seconds).toBeGreaterThanOrEqual(20 * 60 - 2);
    expect((await app('POST', '/api/mobile/pm/timer/stop', tokenA, {})).status).toBe(400);

    // status
    const done = await app('POST', `/api/mobile/pm/tasks/${mine.id}/status`, tokenA, { category: 'done' });
    expect(done.data).toMatchObject({ done: true, status: 'Erledigt' });
    expect((await app('GET', '/api/mobile/pm/tasks', tokenA)).data.some((x: any) => x.id === mine.id)).toBe(false);
    expect((await app('GET', '/api/mobile/pm/tasks?filter=done', tokenA)).data.some((x: any) => x.id === mine.id)).toBe(true);
    expect((await app('POST', `/api/mobile/pm/tasks/${mine.id}/status`, tokenA, {})).status).toBe(400);
    // the audit log records it as coming from the app
    expect(t.app.db.get(`SELECT 1 AS x FROM audit_log WHERE via = 'app' AND action = 'pm.tasks.move.create'`)).toBeTruthy();

    // notifications
    await task({ title: 'Neu für Anna', project_id: proj.id, assignees: [p.anna.id] });
    const notes = await app('GET', '/api/mobile/pm/notifications', tokenA);
    expect(notes.data.unread).toBeGreaterThan(0);
    expect(notes.data.items.find((n: any) => n.title.includes('Neu für Anna'))).toMatchObject({ kind: 'assigned', location_name: 'Testfirma', read: false });
    expect((await app('POST', '/api/mobile/pm/notifications/read', tokenA, { all: true })).data.ok).toBe(true);
    expect((await app('GET', '/api/mobile/pm/notifications', tokenA)).data.unread).toBe(0);
  });

  it('applies the member\'s rights and sub-account', async () => {
    const x = await task({ title: 'Nur für das Team' });
    // Nora has no tasks area: no list, no detail, no changes (the relay enforces the area)
    expect((await app('GET', '/api/mobile/pm/tasks', tokenB)).status).toBe(403);
    expect((await app('GET', `/api/mobile/pm/tasks/${x.id}`, tokenB)).status).toBe(403);
    expect((await app('POST', `/api/mobile/pm/tasks/${x.id}/status`, tokenB, { category: 'done' })).status).toBe(403);
    expect((await app('POST', '/api/mobile/pm/timer/start', tokenB, { location_id: p.A, task_id: x.id })).status).toBe(403);
    expect((await app('GET', '/api/mobile/pm/notifications', tokenB)).data).toEqual({ unread: 0, items: [] });
    // other sub-account's task for Anna
    t.api.setLocation(p.B);
    const foreign = (await api().post('/api/pm/tasks', { title: 'Fremd', assignees: [p.chef] })).data;
    t.api.setLocation(p.A);
    expect((await app('GET', `/api/mobile/pm/tasks/${foreign.id}`, tokenA)).status).toBe(404);
    expect((await app('POST', `/api/mobile/pm/tasks/${foreign.id}/status`, tokenA, { category: 'done' })).status).toBe(404);
    expect((await app('POST', '/api/mobile/pm/timer/start', tokenA, { location_id: p.B, task_id: foreign.id })).status).toBe(403);
    expect((await app('GET', '/api/mobile/pm/tasks', 'ghm_falsch')).status).toBe(401);
  });
});
