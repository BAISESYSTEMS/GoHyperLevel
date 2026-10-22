import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { BYE, expireSession, loginAgain, openSse } from './sse-fixtures.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';

/** Living Boards over the real app: access, patch, versions, undo/redo/restore, widget data with the viewer's rights, realtime. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let member: Call; // only "Dashboard": no contacts, no deals
let colleague: Call; // dashboard + contacts + opportunities + calendars + conversations + helpdesk
const H = () => ({ 'x-location-id': loc });
const api = (c: Call, method: string, path: string, body?: unknown) => c(method, path, body, H());
const admin = (method: string, path: string, body?: unknown) => (method === 'GET' ? t.api.get(path) : method === 'POST' ? t.api.post(path, body) : method === 'PATCH' ? t.api.patch(path, body) : method === 'PUT' ? t.api.put(path, body) : t.api.del(path));
let pipeline: any;
let contactId = '';

const login = async (email: string) => {
  const c = client(t.base, { 'x-pghl': '1' });
  expect((await c('POST', '/api/auth/login', { email, password: 'passwort-12345' })).status).toBe(200);
  return c;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  await t.api.post('/api/users', { email: 'dashboard@example.com', name: 'Dana Dashboard', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['dashboard'] });
  await t.api.post('/api/users', { email: 'kollege@example.com', name: 'Karl Kollege', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['dashboard', 'contacts', 'opportunities', 'calendars', 'conversations', 'helpdesk'] });
  member = await login('dashboard@example.com');
  colleague = await login('kollege@example.com');
  // some CRM data to show
  const c = await t.api.post('/api/contacts', { email: 'anna@example.com', first_name: 'Anna', last_name: 'Berger', tags: ['kunde'] });
  contactId = c.data.id ?? c.data.contact?.id;
  pipeline = (await t.api.post('/api/pipelines', { name: 'Verkauf', stages: [{ name: 'Lead' }, { name: 'Angebot' }] })).data;
  await t.api.post('/api/opportunities', { pipeline_id: pipeline.id, contact_id: contactId, name: 'Großer Auftrag', value: 12000 });
  await t.api.post('/api/opportunities', { pipeline_id: pipeline.id, contact_id: contactId, name: 'Kleiner Auftrag', value: 800 });
  await t.api.post('/api/tasks', { title: 'Angebot nachfassen', contact_id: contactId, due_at: new Date().toISOString() });
}, 60_000);
afterAll(() => t.close());

const widget = (b: any, type: string) => b.spec.widgets.find((w: any) => w.type === type);

describe('boards: catalogue and creation', () => {
  it('lists the widget catalogue with config fields', async () => {
    const r = await t.api.get('/api/boards/widgets');
    expect(r.status).toBe(200);
    // Modules add widgets of their own (source ≠ core, e.g. the funnel overview); the built-in ones are fixed.
    expect(r.data.widgets.filter((w: any) => w.source === 'core').map((w: any) => w.type).sort()).toEqual(['actions', 'agenda', 'calc', 'chart', 'embed', 'inbox', 'kpi', 'list', 'notes', 'pipeline', 'plugin', 'tasks', 'wiki']);
    const list = r.data.widgets.find((w: any) => w.type === 'list');
    expect(list.fields.find((f: any) => f.key === 'entity').options.map((o: any) => o[0])).toContain('deals');
    expect(list.size).toMatchObject({ w: 6, h: 4 });
    expect(r.data.categories.length).toBeGreaterThan(3);
  });

  it('creates empty, from a starter and as a copy; each starts at version 1', async () => {
    const empty = await t.api.post('/api/boards', { name: 'Leer' });
    expect(empty.status).toBe(200);
    expect(empty.data).toMatchObject({ name: 'Leer', scope: 'personal', version: 1, widgets: 0, access: 'owner', mine: true, can_undo: false, can_redo: false });
    const starter = await t.api.post('/api/boards', { template: 'solo-cockpit' });
    expect(starter.data.name).toBe('Solo-Cockpit');
    expect(starter.data.widgets).toBe(10);
    expect(starter.data.template_key).toBe('solo-cockpit');
    const copy = await t.api.post('/api/boards', { name: 'Kopie', copy_of: starter.data.id });
    expect(copy.data.widgets).toBe(10);
    expect(copy.data.spec.widgets[0].id).not.toBe(starter.data.spec.widgets[0].id);
    // every starter board builds without errors
    for (const key of ['vertrieb', 'agentur', 'service', 'projekte']) {
      const r = await t.api.post('/api/boards', { template: key });
      expect(r.status, key).toBe(200);
      expect(r.data.widgets, key).toBeGreaterThanOrEqual(8);
    }
    expect((await t.api.post('/api/boards', { template: 'gibt-es-nicht' })).status).toBe(404);
  });
});

describe('boards: access, personal and shared', () => {
  let personal: any;
  let shared: any;
  beforeAll(async () => {
    personal = (await t.api.post('/api/boards', { name: 'Nur für mich' })).data;
    shared = (await t.api.post('/api/boards', { name: 'Fürs Team', scope: 'shared' })).data;
  });

  it('personal boards are private, shared ones visible to the team (read-only by default)', async () => {
    expect((await api(member, 'GET', `/api/boards/${personal.id}`)).status).toBe(404);
    const list = (await api(member, 'GET', '/api/boards')).data.boards.map((b: any) => b.name);
    expect(list).toContain('Fürs Team');
    expect(list).not.toContain('Nur für mich');
    const seen = await api(member, 'GET', `/api/boards/${shared.id}`);
    expect(seen.data.access).toBe('view');
    const w = await api(member, 'POST', `/api/boards/${shared.id}/patch`, { ops: [{ op: 'add', type: 'notes' }] });
    expect(w.status).toBe(403);
    expect(w.data.error).toMatch(/nur lesbar/);
    expect((await api(member, 'PATCH', `/api/boards/${shared.id}`, { name: 'Gekapert' })).status).toBe(403);
    expect((await api(member, 'DELETE', `/api/boards/${shared.id}`)).status).toBe(403);
    // opening a personal board of somebody else never confirms it exists
    expect((await api(member, 'GET', `/api/boards/${personal.id}/data`)).status).toBe(404);
  });

  it('the owner can let the team edit; only the owner changes who may', async () => {
    expect((await t.api.patch(`/api/boards/${shared.id}`, { team_access: 'edit' })).data.team_access).toBe('edit');
    const w = await api(member, 'POST', `/api/boards/${shared.id}/patch`, { ops: [{ op: 'add', type: 'notes', config: { text: 'Vom Team' } }] });
    expect(w.status, JSON.stringify(w.data)).toBe(200);
    expect(w.data.board.access).toBe('edit');
    // the member may edit but not change the sharing or delete
    expect((await api(member, 'PATCH', `/api/boards/${shared.id}`, { team_access: 'view' })).status).toBe(403);
    expect((await api(member, 'DELETE', `/api/boards/${shared.id}`)).status).toBe(403);
    // making it personal hides it again
    await t.api.patch(`/api/boards/${shared.id}`, { scope: 'personal' });
    expect((await api(member, 'GET', `/api/boards/${shared.id}`)).status).toBe(404);
    await t.api.patch(`/api/boards/${shared.id}`, { scope: 'shared' });
  });

  it('admins can open anybody’s board by link, lists show the own and shared ones (all=1 shows everybody’s)', async () => {
    const mine = (await api(member, 'POST', '/api/boards', { name: 'Danas Board' })).data;
    expect((await t.api.get(`/api/boards/${mine.id}`)).status).toBe(200);
    expect((await t.api.get('/api/boards')).data.boards.map((b: any) => b.name)).not.toContain('Danas Board');
    expect((await t.api.get('/api/boards?all=1')).data.boards.map((b: any) => b.name)).toContain('Danas Board');
    // all=1 is for admins only
    expect((await api(member, 'GET', '/api/boards?all=1')).data.boards.map((b: any) => b.name)).not.toContain('Nur für mich');
  });

  it('is isolated per sub-account', async () => {
    expect((await t.api.get(`/api/boards/${shared.id}`, { 'x-location-id': other })).status).toBe(404);
    expect((await t.api.get('/api/boards', { 'x-location-id': other })).data.boards).toEqual([]);
    expect((await t.api.post(`/api/boards/${shared.id}/patch`, { ops: [{ op: 'add', type: 'notes' }] }, { 'x-location-id': other })).status).toBe(404);
  });
});

describe('boards: patch, versions, undo, redo, restore', () => {
  let b: any;
  beforeAll(async () => {
    b = (await t.api.post('/api/boards', { name: 'Versionen' })).data;
  });

  it('applies a patch as a version, with a readable summary and the new layout', async () => {
    const r = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'add', type: 'kpi', ref: 'a', config: { preset: 'new_contacts' } }, { op: 'add', type: 'chart', placement: 'beside:a' }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ ok: true, version: 2, risk: 'normal' });
    expect(r.data.summary).toContain('Neu: „Kennzahl“');
    expect(r.data.created).toHaveLength(2);
    expect(r.data.board).toMatchObject({ version: 2, widgets: 2, can_undo: true, can_redo: false });
    b = r.data.board;
  });

  it('refuses a bad patch with the reasons and changes nothing', async () => {
    const r = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'add', type: 'hologramm' }] });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Unbekanntes Widget/);
    expect((await t.api.get(`/api/boards/${b.id}`)).data.version).toBe(2);
    expect((await t.api.post(`/api/boards/${b.id}/patch`, { ops: [] })).status).toBe(400);
  });

  it('checks without saving (dry run) and says what it would do', async () => {
    const r = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'add', type: 'embed', config: { url: 'https://docs.google.com/document/d/1' } }], dry_run: true });
    expect(r.data).toMatchObject({ ok: true, risk: 'high', version: 2 });
    expect(r.data.changes[0].text).toContain('Neu: „Einbettung“');
    const bad = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'remove', id: 'wNichtDa123' }], dry_run: true });
    expect(bad.data.ok).toBe(false);
    expect(bad.data.errors[0]).toMatch(/gibt es nicht/);
    expect((await t.api.get(`/api/boards/${b.id}`)).data.version).toBe(2);
  });

  it('does not save a patch that changes nothing', async () => {
    const w = widget(b, 'kpi');
    const r = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'rename', name: 'Versionen' }, { op: 'move', id: w.id, x: w.layout.lg.x, y: w.layout.lg.y }] });
    expect(r.data).toMatchObject({ ok: true, unchanged: true, version: 2 });
  });

  it('arranging the tablet by hand stops deriving it from the desktop; "reset" brings the derived layout back as a version', async () => {
    const own = (await t.api.post('/api/boards', { name: 'Tablet', template: 'solo-cockpit' })).data;
    const w = own.spec.widgets[0];
    expect(own.spec.custom).toBeUndefined();
    const moved = await t.api.post(`/api/boards/${own.id}/patch`, { ops: [{ op: 'move', id: w.id, placement: 'bottom', bp: 'md' }] });
    expect(moved.data.board.spec.custom).toEqual({ md: true });
    const bad = await t.api.post(`/api/boards/${own.id}/reset-layout`, { bp: 'lg' });
    expect(bad.status).toBe(400);
    const reset = await t.api.post(`/api/boards/${own.id}/reset-layout`, { bp: 'md' });
    expect(reset.status).toBe(200);
    expect(reset.data.spec.custom).toBeUndefined();
    expect(reset.data.version).toBe(moved.data.version + 1);
    expect((await t.api.get(`/api/boards/${own.id}/versions`)).data.versions[0].summary).toBe('Anordnung für Tablet zurückgesetzt');
    // nothing to reset: no new version
    expect((await t.api.post(`/api/boards/${own.id}/reset-layout`, { bp: 'md' })).data.version).toBe(reset.data.version);
    // undo goes back to the hand-made arrangement
    expect((await t.api.post(`/api/boards/${own.id}/undo`, {})).data.spec.custom).toEqual({ md: true });
  });

  it('lets every card rise as far as it can: dropping into free space rests above, moving past a neighbour swaps', async () => {
    const own = (await t.api.post('/api/boards', { name: 'Schwerkraft' })).data;
    const made = (await t.api.post(`/api/boards/${own.id}/patch`, { ops: [{ op: 'add', type: 'notes', ref: 'a', x: 0, y: 0, w: 4, h: 3 }, { op: 'add', type: 'actions', ref: 'b', x: 0, y: 3, w: 4, h: 3 }] })).data;
    const [a, b] = made.created.map((c: any) => c.id);
    const cellOf = (board: any, id: string) => board.spec.widgets.find((w: any) => w.id === id).layout.lg;
    // dropped on top of its neighbour, or just a bit lower: the card rises back, nothing changes
    for (const y of [1, 3, 4]) {
      const down = await t.api.post(`/api/boards/${own.id}/patch`, { ops: [{ op: 'move', id: a, x: 0, y }] });
      expect(cellOf(down.data.board, a), `y=${y}`).toMatchObject({ y: 0 });
      expect(down.data.unchanged, `y=${y}`).toBe(true);
    }
    // far enough down for the neighbour to rise past it: they swap
    const swap = await t.api.post(`/api/boards/${own.id}/patch`, { ops: [{ op: 'move', id: a, x: 0, y: 5 }] });
    expect(cellOf(swap.data.board, a)).toMatchObject({ y: 3 });
    expect(cellOf(swap.data.board, b)).toMatchObject({ y: 0 });
  });

  it('detects a change made in between (expected_version)', async () => {
    const r = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'rename', name: 'Neu' }], expected_version: 1 });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/Version 2/);
  });

  it('undo, redo and restore walk the history; a new change clears redo', async () => {
    const v3 = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'rename', name: 'Dritte' }, { op: 'theme', accent: 'rot' }] });
    expect(v3.data.version).toBe(3);
    expect(v3.data.board).toMatchObject({ name: 'Dritte', accent: '#dc2626' });
    const undo = await t.api.post(`/api/boards/${b.id}/undo`, {});
    expect(undo.data).toMatchObject({ name: 'Versionen', accent: '', version: 2, can_undo: true, can_redo: true });
    const redo = await t.api.post(`/api/boards/${b.id}/redo`, {});
    expect(redo.data).toMatchObject({ name: 'Dritte', version: 3, can_redo: false });
    await t.api.post(`/api/boards/${b.id}/undo`, {});
    await t.api.post(`/api/boards/${b.id}/undo`, {});
    // at the start there is nothing left to undo
    expect(((await t.api.post(`/api/boards/${b.id}/undo`, {})) as any).status).toBe(409);
    // a new change after undo drops the redo path but keeps the old versions in the list
    const v4 = await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'rename', name: 'Anders' }] });
    expect(v4.data.version).toBe(4);
    expect(((await t.api.post(`/api/boards/${b.id}/redo`, {})) as any).status).toBe(409);
    const list = (await t.api.get(`/api/boards/${b.id}/versions`)).data;
    expect(list.versions.map((v: any) => v.n)).toEqual([4, 3, 2, 1]);
    expect(list.versions[0]).toMatchObject({ current: true, kind: 'edit', actor: 'Chef' });
    // restore version 3 as a new version 5 – and that can itself be undone
    const restored = await t.api.post(`/api/boards/${b.id}/versions/3/restore`, {});
    expect(restored.data).toMatchObject({ name: 'Dritte', version: 5 });
    expect((await t.api.get(`/api/boards/${b.id}/versions`)).data.versions[0]).toMatchObject({ n: 5, kind: 'restore', summary: 'Version 3 wiederhergestellt' });
    expect((await t.api.post(`/api/boards/${b.id}/undo`, {})).data.name).toBe('Anders');
    const one = await t.api.get(`/api/boards/${b.id}/versions/2`);
    expect(one.data.state.spec.widgets).toHaveLength(2);
    expect((await t.api.get(`/api/boards/${b.id}/versions/99`)).status).toBe(404);
  });

  it('writes to the audit log', async () => {
    const log = (await t.api.get('/api/audit?limit=100')).data as any[];
    expect(log.some((a) => a.action === 'boards.patch' && a.summary.includes('Versionen'))).toBe(true);
    expect(log.some((a) => a.action === 'boards.undo')).toBe(true);
    expect(log.some((a) => a.action === 'boards.restore')).toBe(true);
    expect(log.some((a) => a.action === 'boards.create')).toBe(true);
  });
});

describe('boards: widget data with the viewer’s rights', () => {
  let board: any;
  beforeAll(async () => {
    board = (
      await t.api.post('/api/boards', {
        name: 'Daten',
        scope: 'shared',
        template: undefined,
      })
    ).data;
    const ops = [
      { op: 'add', type: 'notes', ref: 'n', config: { text: '**Hallo** Team' }, title: 'Gruß' },
      { op: 'add', type: 'kpi', config: { preset: 'open_pipeline_value' } },
      { op: 'add', type: 'list', config: { entity: 'deals', status: 'open', min_value: 5000 }, title: 'Große Deals' },
      { op: 'add', type: 'list', config: { entity: 'contacts', tag: 'kunde' } },
      { op: 'add', type: 'pipeline', config: { pipeline_id: pipeline.id } },
      { op: 'add', type: 'tasks', config: { due: 'any', mine: false } },
      { op: 'add', type: 'agenda', config: {} },
      { op: 'add', type: 'inbox', config: {} },
      { op: 'add', type: 'embed', config: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
      { op: 'add', type: 'actions', config: { actions: [{ label: 'Aufgabe', kind: 'task' }, { label: 'Kalender', kind: 'page', page: 'calendars' }] } },
      { op: 'add', type: 'plugin', config: { ref: 'gibt:es-nicht' } },
    ];
    const r = await t.api.post(`/api/boards/${board.id}/patch`, { ops });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    board = r.data.board;
  });
  const byType = (d: any, type: string, nth = 0) => {
    const ids = board.spec.widgets.filter((w: any) => w.type === type).map((w: any) => w.id);
    return d.data.data[ids[nth]].view;
  };

  it('shows everything to somebody who may see everything', async () => {
    const r = await t.api.get(`/api/boards/${board.id}/data`);
    expect(r.status).toBe(200);
    expect(byType(r, 'notes')).toMatchObject({ kind: 'markdown', text: '**Hallo** Team' });
    const kpi = byType(r, 'kpi');
    expect(kpi).toMatchObject({ kind: 'report', viz: 'kpi', title: 'Offener Pipeline-Wert' });
    expect(kpi.result.rows[0].v[0]).toBe(12800);
    const deals = byType(r, 'list', 0);
    expect(deals).toMatchObject({ kind: 'list', total: 1 });
    expect(deals.rows[0]).toMatchObject({ title: 'Großer Auftrag', meta: expect.stringContaining('12.000') });
    expect(byType(r, 'list', 1).rows[0].title).toBe('Anna Berger');
    const kanban = byType(r, 'pipeline');
    expect(kanban.kind).toBe('kanban');
    expect(kanban.columns.map((c: any) => [c.title, c.count])).toEqual([['Lead', 2], ['Angebot', 0]]);
    expect(kanban.columns[0].cards[0].title).toBe('Großer Auftrag');
    expect(byType(r, 'tasks').rows[0]).toMatchObject({ title: 'Angebot nachfassen', check: { done: false } });
    expect(byType(r, 'agenda').kind).toBe('agenda');
    expect(byType(r, 'inbox').kind).toBe('list');
    expect(byType(r, 'embed')).toMatchObject({ kind: 'embed', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
    const actions = byType(r, 'actions');
    expect(actions.actions.map((a: any) => [a.label, a.enabled])).toEqual([['Aufgabe', true], ['Kalender', true]]);
    expect(byType(r, 'plugin')).toMatchObject({ kind: 'message', tone: 'yellow' });
  });

  it('a person with only the Dashboard right sees locked widgets instead of data – and no values leak', async () => {
    const r = await api(member, 'GET', `/api/boards/${board.id}/data`);
    expect(r.status).toBe(200);
    expect(byType(r, 'notes').kind).toBe('markdown');
    for (const [type, nth] of [['list', 0], ['list', 1], ['pipeline', 0], ['tasks', 0], ['agenda', 0], ['inbox', 0]] as const) {
      const v = byType(r, type, nth);
      expect(v.kind, `${type} ${nth}`).toBe('locked');
      expect(v.reason).toMatch(/Kein Zugriff|fehlt/);
    }
    // a report over deals needs the area of the source too
    expect(byType(r, 'kpi').kind).toBe('locked');
    expect(JSON.stringify(r.data)).not.toContain('Großer Auftrag');
    expect(JSON.stringify(r.data)).not.toContain('Anna');
    // buttons for areas the person lacks come back disabled with the reason
    const actions = byType(r, 'actions');
    expect(actions.actions.map((a: any) => a.enabled)).toEqual([false, false]);
    expect(actions.actions[0].why).toMatch(/Recht/);
  });

  it('a colleague with the rights of the data sees it – with their own view of "mine"', async () => {
    const r = await api(colleague, 'GET', `/api/boards/${board.id}/data`);
    expect(byType(r, 'list', 0).rows[0].title).toBe('Großer Auftrag');
    expect(byType(r, 'kpi').result.rows[0].v[0]).toBe(12800);
  });

  it('data of single widgets can be refreshed (ids) and is for the board’s own sub-account only', async () => {
    const id = board.spec.widgets[0].id;
    const r = await t.api.get(`/api/boards/${board.id}/data?ids=${id}`);
    expect(Object.keys(r.data.data)).toEqual([id]);
    expect((await t.api.get(`/api/boards/${board.id}/data`, { 'x-location-id': other })).status).toBe(404);
  });

  it('shows an embed only while its address is allowed – the agency list decides', async () => {
    const custom = await t.api.put('/api/boards/embed-hosts', { hosts: ['berichte.example.org'] });
    expect(custom.data.custom).toEqual(['berichte.example.org']);
    const add = await t.api.post(`/api/boards/${board.id}/patch`, { ops: [{ op: 'add', type: 'embed', config: { url: 'https://berichte.example.org/dash' } }] });
    expect(add.status, JSON.stringify(add.data)).toBe(200);
    board = add.data.board;
    const emb = board.spec.widgets.filter((w: any) => w.type === 'embed')[1];
    expect(byType(await t.api.get(`/api/boards/${board.id}/data`), 'embed', 1)).toMatchObject({ kind: 'embed', url: 'https://berichte.example.org/dash' });
    // removing the host takes effect at once, even for a widget that was saved while it was allowed
    await t.api.put('/api/boards/embed-hosts', { hosts: [] });
    const gone = byType(await t.api.get(`/api/boards/${board.id}/data`), 'embed', 1);
    expect(gone).toMatchObject({ kind: 'locked' });
    expect(gone.reason).toMatch(/nicht freigegeben/);
    // members cannot change the list
    expect((await api(member, 'PUT', '/api/boards/embed-hosts', { hosts: ['x.example.org'] })).status).toBe(403);
    expect((await t.api.put('/api/boards/embed-hosts', { hosts: ['kein host'] })).status).toBe(400);
    void emb;
  });

  it('shows a plugin’s dashboard widget as a sandboxed frame – only while the plugin is installed', async () => {
    const ex = EXAMPLES['deal-ampel'];
    const inst = await t.api.post('/api/plugins/examples/deal-ampel/install', { consent: ex.manifest.scopes });
    expect(inst.status, JSON.stringify(inst.data)).toBe(200);
    const choices = (await t.api.get('/api/boards/options/plugin_widgets')).data.options;
    expect(choices).toEqual([expect.objectContaining({ value: 'deal-ampel:ampel' })]);
    const mine = (await t.api.post('/api/boards', { name: 'Plugin', scope: 'shared' })).data;
    const added = await t.api.post(`/api/boards/${mine.id}/patch`, { ops: [{ op: 'add', type: 'plugin', config: { ref: 'deal-ampel:ampel' } }] });
    expect(added.status, JSON.stringify(added.data)).toBe(200);
    const view = Object.values((await t.api.get(`/api/boards/${mine.id}/data`)).data.data as Record<string, any>)[0].view;
    expect(view).toMatchObject({ kind: 'frame', entry: 'widget:ampel', plugin_id: inst.data.id });
    // switched off: a message with the way to the Marktplatz, never an error
    await t.api.post(`/api/plugins/${inst.data.id}/toggle`, { enabled: false });
    const off = Object.values((await t.api.get(`/api/boards/${mine.id}/data`)).data.data as Record<string, any>)[0].view;
    expect(off).toMatchObject({ kind: 'message', tone: 'yellow', action: { url: '/app/marktplatz' } });
  });

  it('answers the options of the settings panel from the viewer’s own data', async () => {
    expect((await t.api.get('/api/boards/options/pipelines')).data.options.map((o: any) => o.label)).toContain('Verkauf');
    expect((await t.api.get(`/api/boards/options/stages?pipeline_id=${pipeline.id}`)).data.options.map((o: any) => o.label)).toEqual(['Lead', 'Angebot']);
    expect((await t.api.get('/api/boards/options/nope')).status).toBe(404);
    // somebody without the area gets the guard's refusal, not the list
    expect((await api(member, 'GET', '/api/boards/options/projects')).status).toBe(403);
  });
});

describe('boards: start page and preferences', () => {
  it('sets, reads and clears the start page; it follows the board’s fate', async () => {
    const b = (await t.api.post('/api/boards', { name: 'Start' })).data;
    expect((await t.api.get('/api/boards/home')).data.home).toBeNull();
    const set = await t.api.put('/api/boards/home', { board_id: b.id });
    expect(set.data.home).toMatchObject({ board_id: b.id, location_id: loc, name: 'Start' });
    expect((await t.api.get(`/api/boards/${b.id}`)).data.home).toBe(true);
    expect((await t.api.get('/api/boards')).data.boards.find((x: any) => x.id === b.id).home).toBe(true);
    // somebody else's personal board cannot be a start page
    expect((await api(member, 'PUT', '/api/boards/home', { board_id: b.id })).status).toBe(404);
    expect((await t.api.put('/api/boards/home', { board_id: null })).data.home).toBeNull();
    await t.api.put('/api/boards/home', { board_id: b.id });
    await t.api.del(`/api/boards/${b.id}`);
    expect((await t.api.get('/api/boards/home')).data.home).toBeNull();
  });

  it('keeps the auto-apply preference per person', async () => {
    expect((await t.api.get('/api/boards/prefs')).data.auto_apply).toBe('layout');
    expect((await t.api.put('/api/boards/prefs', { auto_apply: 'off' })).data.auto_apply).toBe('off');
    expect((await api(member, 'GET', '/api/boards/prefs')).data.auto_apply).toBe('layout');
    expect((await t.api.put('/api/boards/prefs', { auto_apply: 'alles' })).status).toBe(400);
    await t.api.put('/api/boards/prefs', { auto_apply: 'layout' });
  });
});

describe('boards: realtime', () => {
  /** Reads server-sent events from a stream until `until` says enough. */
  async function listen(path: string, until: (events: { event: string; data: any }[]) => boolean, trigger: () => Promise<unknown>, headers: Record<string, string> = {}) {
    const ctl = new AbortController();
    const r = await fetch(t.base + path, { headers: { 'x-pghl': '1', 'x-location-id': loc, ...headers }, signal: ctl.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader();
    const events: { event: string; data: any }[] = [];
    let buf = '';
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
        if (until(events)) return;
      }
    })().catch(() => undefined);
    await new Promise((res) => setTimeout(res, 80));
    await trigger();
    await Promise.race([pump, new Promise((res) => setTimeout(res, 3000))]);
    ctl.abort();
    return events;
  }

  it('everybody looking sees a change at once – with the whole new state', async () => {
    const b = (await t.api.post('/api/boards', { name: 'Live', scope: 'shared', team_access: 'edit' })).data;
    // the colleague has the board open, the admin changes it
    const cookie = colleague.cookie();
    const events = await listen(`/api/boards/${b.id}/stream?clientId=tab-colleague-1`, (e) => e.some((x) => x.event === 'board'), () => t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'add', type: 'notes', config: { text: 'Live!' }, title: 'Neu' }], client_id: 'tab-admin' }), { cookie });
    expect(events[0].event).toBe('hello');
    expect(events[0].data.viewers.map((v: any) => v.name)).toContain('Karl Kollege');
    const change = events.find((e) => e.event === 'board')!;
    expect(change.data).toMatchObject({ board_id: b.id, version: 2, kind: 'edit', actor: 'Chef', client_id: 'tab-admin', can_undo: true });
    expect(change.data.state.spec.widgets[0]).toMatchObject({ type: 'notes', title: 'Neu' });
    // undo is live too
    const ev2 = await listen(`/api/boards/${b.id}/stream?clientId=tab-colleague-2`, (e) => e.some((x) => x.event === 'board'), () => t.api.post(`/api/boards/${b.id}/undo`, {}), { cookie });
    expect(ev2.find((e) => e.event === 'board')!.data).toMatchObject({ kind: 'undo', version: 1 });
  });

  it('refuses a stream for a board the person cannot see, and tells viewers when it is deleted', async () => {
    const mine = (await t.api.post('/api/boards', { name: 'Privat' })).data;
    const r = await fetch(`${t.base}/api/boards/${mine.id}/stream?clientId=tab-x-1234`, { headers: { 'x-pghl': '1', 'x-location-id': loc, cookie: member.cookie() } });
    expect(r.status).toBe(404);
    const noClient = await fetch(`${t.base}/api/boards/${mine.id}/stream`, { headers: { 'x-pghl': '1', 'x-location-id': loc, cookie: t.api.cookie } });
    expect(noClient.status).toBe(400);
    const shared = (await t.api.post('/api/boards', { name: 'Wird gelöscht', scope: 'shared' })).data;
    const events = await listen(`/api/boards/${shared.id}/stream?clientId=tab-watcher-1`, (e) => e.some((x) => x.event === 'deleted'), () => t.api.del(`/api/boards/${shared.id}`), { cookie: colleague.cookie() });
    expect(events.some((e) => e.event === 'deleted')).toBe(true);
  });

  it('a stream ends with the login it was opened with: signed out, other devices signed out, a new password, run out', async () => {
    const hub = t.app.services.boardsHub;
    const b = (await t.api.post('/api/boards', { name: 'Live mit Anmeldung', scope: 'shared', team_access: 'edit' })).data;
    const again = () => loginAgain(t.base, loc, 'kollege@example.com', 'passwort-12345');
    const open = async (c: { cookie: () => string }, clientId: string) => {
      const s = await openSse(`${t.base}/api/boards/${b.id}/stream?clientId=${clientId}&locationId=${loc}`, { cookie: c.cookie() });
      expect(await s.until(/event: hello/)).toBe(true);
      return s;
    };
    const own = await open(colleague, 'tab-karl-own');
    // signed out in another tab of the same browser: the stream ends at once, with `bye` (the browser does not reconnect)
    const second = await again();
    const s1 = await open(second, 'tab-karl-1');
    expect((await second('POST', '/api/auth/logout')).status).toBe(200);
    expect(await s1.until(BYE)).toBe(true);
    expect(await s1.ends()).toBe(true);
    // "sign out the other devices": their streams end, the own one stays
    const third = await again();
    const s2 = await open(third, 'tab-karl-2');
    expect((await colleague('POST', '/api/me/sessions/revoke-others')).status).toBe(200);
    expect(await s2.until(BYE)).toBe(true);
    // a new password signs the other devices out – and ends their streams
    const fourth = await again();
    const s3 = await open(fourth, 'tab-karl-3');
    expect((await colleague('POST', '/api/me/password', { current: 'passwort-12345', next: 'passwort-12345' })).status).toBe(200);
    expect(await s3.until(BYE)).toBe(true);
    // a session that ran out: the next check ends its stream
    const fifth = await again();
    const s4 = await open(fifth, 'tab-karl-4');
    expireSession(t.app.db, fifth.cookie());
    hub.sweep();
    expect(await s4.until(BYE)).toBe(true);
    // the untouched login still sees the changes; the ended streams get nothing more
    expect(await own.quiet(/event: bye/)).toBe(true);
    await t.api.post(`/api/boards/${b.id}/patch`, { ops: [{ op: 'add', type: 'notes', config: { text: 'Danach' }, title: 'Nach dem Abmelden' }], client_id: 'tab-admin' });
    expect(await own.until(/event: board\ndata: .*Nach dem Abmelden/)).toBe(true);
    for (const s of [s1, s2, s3, s4]) expect(s.text()).not.toContain('Nach dem Abmelden');
    for (const s of [own, s1, s2, s3, s4]) await s.close();
  });

  it("a person's 9th tab makes the oldest one wait with `bye` instead of a reconnect ping-pong", async () => {
    const b = (await t.api.post('/api/boards', { name: 'Viele Tabs', scope: 'shared', team_access: 'edit' })).data;
    const tabs = [];
    for (let i = 0; i < 9; i++) {
      const s = await openSse(`${t.base}/api/boards/${b.id}/stream?clientId=tab-karl-many-${i}&locationId=${loc}`, { cookie: colleague.cookie() });
      expect(await s.until(/event: hello/)).toBe(true);
      tabs.push(s);
    }
    expect(await tabs[0].until(/event: bye\ndata: \{"reason":"tabs"\}/)).toBe(true);
    expect(await tabs[0].ends()).toBe(true);
    for (const s of tabs.slice(1)) expect(s.text()).not.toContain('event: bye');
    for (const s of tabs) await s.close();
  });
});
