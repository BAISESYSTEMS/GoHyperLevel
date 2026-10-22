import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { PREF_DEFAULTS, cleanPrefs, effectivePrefs, lockedKeys } from '../server/services/appearance-model.js';
import { XR_LIMITS, cleanBoardLayout, cleanCanvasLayout, cleanPose, cleanWorkspace, defaultWorkspace, evenSizes, isWorkspaceRoute, normalizeSizes, wrapAngle } from '../server/services/xr-model.js';

/** The XR layouts: the pure model (validation, widths) and the routes (isolation, permissions, per-person storage). */

describe('xr model: poses and layouts', () => {
  it('clamps a pose to the room, wraps the angle and refuses non-numbers', () => {
    expect(cleanPose({ x: 1.23456789, y: -0.5, z: -2, yaw: 0.5, scale: 1.5 })).toEqual({ x: 1.2346, y: -0.5, z: -2, yaw: 0.5, scale: 1.5 });
    expect(cleanPose({ x: 999, y: -999, z: 5 })).toMatchObject({ x: XR_LIMITS.reach, y: -XR_LIMITS.reach, scale: 1, yaw: 0 });
    expect(cleanPose({ x: 0, y: 0, z: 0, scale: 100 }).scale).toBe(XR_LIMITS.scale.max);
    expect(cleanPose({ x: 0, y: 0, z: 0, scale: 0 }).scale).toBe(XR_LIMITS.scale.min);
    expect(cleanPose({ x: '1.5', y: 0, z: 0 }).x).toBe(1.5);
    for (const bad of [null, [], 'x', { x: 'a', y: 0, z: 0 }, { x: 0, y: NaN, z: 0 }, { x: 0, y: 0 }, { x: 0, y: 0, z: Infinity }]) expect(() => cleanPose(bad), JSON.stringify(bad)).toThrow();
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 6);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI / 2, 6);
    expect(wrapAngle(0.3)).toBe(0.3);
  });

  it('keeps only the panels of widgets that are on the board and bounds radius and count', () => {
    const l = cleanBoardLayout({ panels: { w1: { x: 1, y: 0, z: -2 }, gone: { x: 0, y: 0, z: -1 }, '../x': { x: 0, y: 0, z: 0 } }, radius: 99, hud: { x: 0, y: -0.6, z: -1.2 } }, ['w1', 'w2']);
    expect(Object.keys(l.panels)).toEqual(['w1']);
    expect(l.radius).toBe(XR_LIMITS.radius.max);
    expect(l.hud).toMatchObject({ y: -0.6 });
    expect(cleanBoardLayout({ panels: {} }, []).radius).toBe(2.2);
    expect(() => cleanBoardLayout('x', [])).toThrow();
    const many = Object.fromEntries(Array.from({ length: XR_LIMITS.panels * 4 + 1 }, (_, i) => [`w${i}`, { x: 0, y: 0, z: 0 }]));
    expect(() => cleanBoardLayout({ panels: many }, Object.keys(many))).toThrow(/Zu viele/);
  });

  it('cleans a canvas plane with a curve between 0 and 1', () => {
    expect(cleanCanvasLayout({ plane: { x: 0, y: 0, z: -2.5, scale: 2, curve: 3 } }).plane).toMatchObject({ z: -2.5, scale: 2, curve: 1 });
    expect(cleanCanvasLayout({ plane: { x: 0, y: 0, z: -2 } }).plane.curve).toBe(0);
    expect(() => cleanCanvasLayout({})).toThrow();
  });
});

describe('xr model: Arbeitsfläche widths and routes', () => {
  it('accepts page routes and refuses anything that could leave the app', () => {
    for (const ok of ['conversations', 'contacts/abc123', 'boards/xyz', 'agent', 'settings/appearance', 'pm/projects/p1/tasks']) expect(isWorkspaceRoute(ok), ok).toBe(true);
    for (const bad of ['', '/contacts', 'https://evil.example', '//evil.example', 'contacts/../x', 'contacts/./x', 'contacts/%2e%2e', 'contacts/a%2fb', 'contacts/%zz', 'contacts?x=1', 'Contacts', 'a b', 'javascript:alert(1)', 'a/b/c/d/e/f', 'x'.repeat(300), 42, null]) expect(isWorkspaceRoute(bad), String(bad)).toBe(false);
  });

  it('turns weights into shares that add up to 1 and never starve a panel', () => {
    expect(evenSizes(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
    const n = normalizeSizes([1, 1, 2]);
    expect(n.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(n[2]).toBeCloseTo(0.5, 3);
    // one panel dragged almost shut keeps its minimum, the others give way
    const s = normalizeSizes([0.01, 0.5, 0.49]);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(XR_LIMITS.minShare - 1e-3);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(normalizeSizes([0, 0, 0])).toEqual(evenSizes(3));
    expect(normalizeSizes([NaN, -3])).toEqual(evenSizes(2));
    expect(normalizeSizes([])).toEqual([]);
    expect(normalizeSizes([5])).toEqual([1]);
  });

  it('validates a workspace and offers Inbox | Kontakt | Board | Agent by default', () => {
    const w = cleanWorkspace({ panels: [{ route: 'conversations', size: 2 }, { route: 'contacts', size: 1 }], sync: false });
    expect(w.panels.map((p) => p.route)).toEqual(['conversations', 'contacts']);
    expect(w.panels[0].size).toBeCloseTo(2 / 3, 2);
    expect(w.sync).toBe(false);
    expect(cleanWorkspace({ panels: [{ route: 'tasks' }] }).sync).toBe(true);
    expect(() => cleanWorkspace({ panels: [] })).toThrow();
    expect(() => cleanWorkspace({ panels: Array.from({ length: 5 }, () => ({ route: 'tasks' })) })).toThrow(/Höchstens 4/);
    expect(() => cleanWorkspace({ panels: [{ route: '../etc' }] })).toThrow(/ungültige Seite/);
    expect(defaultWorkspace().panels.map((p) => p.route)).toEqual(['conversations', 'contacts', 'boards', 'agent']);
    expect(defaultWorkspace(2).panels.map((p) => p.route)).toEqual(['conversations', 'contacts']);
    expect(defaultWorkspace(99).panels).toHaveLength(4);
    expect(defaultWorkspace(0).panels).toHaveLength(1);
  });
});

describe('Raum-Modus preference', () => {
  it('is auto by default, takes on/off, refuses anything else and is never locked by an agency', () => {
    expect(PREF_DEFAULTS.spatial).toBe('auto');
    expect(cleanPrefs({ spatial: 'on' })).toEqual({ spatial: 'on' });
    expect(cleanPrefs({ spatial: 'off' })).toEqual({ spatial: 'off' });
    expect(cleanPrefs({ spatial: null })).toEqual({ spatial: null });
    for (const bad of ['yes', true, 1, '']) expect(() => cleanPrefs({ spatial: bad }), String(bad)).toThrow(/Raum-Modus/);
    // even a fully locked client login keeps its own choice
    const locks = { theme: true, accent: true, dept: true, sidebar: true, icons: true, density: true, modules: true };
    expect(lockedKeys(['spatial'], locks)).toEqual([]);
    expect(effectivePrefs({}, { spatial: 'on' }, locks, false).spatial).toBe('on');
  });
});

describe('xr layouts over the real app', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let loc = '';
  let other = '';
  let member: Call; // dashboard + canvas
  let outsider: Call; // member of the other sub-account only
  let noDash: Call; // contacts only: no Dashboard, no Canvas
  let shared: any;
  let personal: any;
  let wid: string[] = [];
  let canvasId = '';
  const H = () => ({ 'x-location-id': loc });
  const login = async (email: string) => {
    const c = client(t.base, { 'x-pghl': '1' });
    expect((await c('POST', '/api/auth/login', { email, password: 'passwort-12345' })).status).toBe(200);
    return c;
  };
  const pose = (x: number) => ({ x, y: 0.1, z: -2, yaw: 0, scale: 1 });

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
    for (const [email, name, locations, permissions] of [
      ['mia@example.com', 'Mia', [loc], ['dashboard', 'canvas']],
      ['otto@example.com', 'Otto', [other], ['dashboard', 'canvas']],
      ['nina@example.com', 'Nina', [loc], ['contacts']],
    ] as const)
      await t.api.post('/api/users', { email, name, password: 'passwort-12345', role: 'member', locations, permissions });
    member = await login('mia@example.com');
    outsider = await login('otto@example.com');
    noDash = await login('nina@example.com');
    shared = (await t.api.post('/api/boards', { name: 'Team-Board', scope: 'shared', team_access: 'view' })).data;
    await t.api.post(`/api/boards/${shared.id}/patch`, { ops: [{ op: 'add', type: 'notes', config: { text: 'a' } }, { op: 'add', type: 'kpi' }] });
    wid = (await t.api.get(`/api/boards/${shared.id}`)).data.spec.widgets.map((w: any) => w.id);
    personal = (await t.api.post('/api/boards', { name: 'Nur Chef', scope: 'personal' })).data;
    canvasId = (await t.api.post('/api/canvas', { name: 'Whiteboard' })).data.id;
  }, 60_000);
  afterAll(() => t.close());

  it('stores a board layout per person: the viewer of a view-only board arranges their own view, nobody sees it', async () => {
    const layout = { panels: { [wid[0]]: pose(-1), [wid[1]]: pose(1), nope: pose(5) }, radius: 2.6, hud: { x: 0, y: -0.7, z: -1.2, yaw: 0, scale: 1 } };
    // Mia may only look at the board (team access: view) – the layout is hers, it changes nothing on the board
    const put = await member('PUT', `/api/boards/${shared.id}/xr-layout`, { layout }, H());
    expect(put.status).toBe(200);
    expect(Object.keys(put.data.layout.panels).sort()).toEqual([...wid].sort());
    expect(put.data.layout.radius).toBe(2.6);
    const mine = await member('GET', `/api/boards/${shared.id}/xr-layout`, undefined, H());
    expect(mine.data.layout.panels[wid[0]].x).toBe(-1);
    // the owner has none until they save one; both are independent
    expect((await t.api.get(`/api/boards/${shared.id}/xr-layout`)).data.layout).toBeNull();
    await t.api.put(`/api/boards/${shared.id}/xr-layout`, { layout: { panels: { [wid[0]]: pose(3) } } });
    expect((await member('GET', `/api/boards/${shared.id}/xr-layout`, undefined, H())).data.layout.panels[wid[0]].x).toBe(-1);
    expect((await t.api.get(`/api/boards/${shared.id}/xr-layout`)).data.layout.panels[wid[0]].x).toBe(3);
    // and the board itself is untouched (version 2: created, then the two widgets in one patch)
    expect((await t.api.get(`/api/boards/${shared.id}`)).data.version).toBe(2);
  });

  it('refuses everybody who may not see the board – with the same 404 as the board itself', async () => {
    const body = { layout: { panels: {} } };
    // another sub-account, even with the right area
    expect((await outsider('GET', `/api/boards/${shared.id}/xr-layout`, undefined, { 'x-location-id': other })).status).toBe(404);
    expect((await outsider('PUT', `/api/boards/${shared.id}/xr-layout`, body, { 'x-location-id': other })).status).toBe(404);
    expect((await outsider('DELETE', `/api/boards/${shared.id}/xr-layout`, undefined, { 'x-location-id': other })).status).toBe(404);
    // a personal board of somebody else does not exist for a colleague
    expect((await member('GET', `/api/boards/${personal.id}/xr-layout`, undefined, H())).status).toBe(404);
    expect((await member('PUT', `/api/boards/${personal.id}/xr-layout`, body, H())).status).toBe(404);
    expect((await t.api.get(`/api/boards/${personal.id}/xr-layout`)).status).toBe(200);
    // a login without the Dashboard area is stopped by the area rule of /api/boards
    expect((await noDash('GET', `/api/boards/${shared.id}/xr-layout`, undefined, H())).status).toBe(403);
    expect((await noDash('PUT', `/api/boards/${shared.id}/xr-layout`, body, H())).status).toBe(403);
    expect((await t.api.get('/api/boards/doesnotexist/xr-layout')).status).toBe(404);
  });

  it('validates the body and resets with DELETE', async () => {
    expect((await t.api.put(`/api/boards/${shared.id}/xr-layout`, { layout: 'x' })).status).toBe(400);
    expect((await t.api.put(`/api/boards/${shared.id}/xr-layout`, {})).status).toBe(400);
    expect((await t.api.put(`/api/boards/${shared.id}/xr-layout`, { layout: { panels: { [wid[0]]: { x: 'links', y: 0, z: 0 } } } })).status).toBe(400);
    expect((await t.api.del(`/api/boards/${shared.id}/xr-layout`)).data).toEqual({ ok: true });
    expect((await t.api.get(`/api/boards/${shared.id}/xr-layout`)).data.layout).toBeNull();
    // the other person's layout is still there
    expect((await member('GET', `/api/boards/${shared.id}/xr-layout`, undefined, H())).data.layout).not.toBeNull();
  });

  it('drops entries of widgets that were removed from the board since', async () => {
    await t.api.put(`/api/boards/${shared.id}/xr-layout`, { layout: { panels: { [wid[0]]: pose(1), [wid[1]]: pose(2) } } });
    await t.api.post(`/api/boards/${shared.id}/patch`, { ops: [{ op: 'remove', id: wid[1] }] });
    const g = await t.api.get(`/api/boards/${shared.id}/xr-layout`);
    expect(Object.keys(g.data.layout.panels)).toEqual([wid[0]]);
  });

  it('stores a canvas plane per person, behind the Canvas area and the board access', async () => {
    const layout = { plane: { x: 0, y: 0.2, z: -2.4, yaw: 0, scale: 1.6, curve: 0.4 } };
    expect((await t.api.put(`/api/canvas/${canvasId}/xr-layout`, { layout })).data.layout.plane).toMatchObject({ scale: 1.6, curve: 0.4 });
    expect((await t.api.get(`/api/canvas/${canvasId}/xr-layout`)).data.layout.plane.z).toBe(-2.4);
    // Mia has team access (edit) and the area; her plane is her own
    expect((await member('GET', `/api/canvas/${canvasId}/xr-layout`, undefined, H())).data.layout).toBeNull();
    expect((await member('PUT', `/api/canvas/${canvasId}/xr-layout`, { layout: { plane: { x: 0, y: 0, z: -3 } } }, H())).status).toBe(200);
    expect((await t.api.get(`/api/canvas/${canvasId}/xr-layout`)).data.layout.plane.z).toBe(-2.4);
    // foreign sub-account and a login without the Canvas area
    expect((await outsider('GET', `/api/canvas/${canvasId}/xr-layout`, undefined, { 'x-location-id': other })).status).toBe(404);
    expect((await noDash('GET', `/api/canvas/${canvasId}/xr-layout`, undefined, H())).status).toBe(403);
    expect((await t.api.put(`/api/canvas/${canvasId}/xr-layout`, { layout: { plane: { x: 0 } } })).status).toBe(400);
    expect((await t.api.del(`/api/canvas/${canvasId}/xr-layout`)).status).toBe(200);
    expect((await t.api.get(`/api/canvas/${canvasId}/xr-layout`)).data.layout).toBeNull();
  });

  it('keeps the Arbeitsfläche per person, across sub-accounts, and refuses nonsense', async () => {
    const empty = await member('GET', '/api/xr/workspace', undefined, H());
    expect(empty.data.layout).toBeNull();
    expect(empty.data.default.panels.map((p: any) => p.route)).toEqual(['conversations', 'contacts', 'boards', 'agent']);
    const layout = { panels: [{ route: 'conversations', size: 3 }, { route: 'contacts', size: 1 }, { route: 'boards/' + shared.id, size: 2 }], sync: true };
    const put = await member('PUT', '/api/xr/workspace', { layout }, H());
    expect(put.status).toBe(200);
    expect(put.data.layout.panels).toHaveLength(3);
    expect(put.data.layout.panels.reduce((n: number, p: any) => n + p.size, 0)).toBeCloseTo(1, 2);
    // follows the person into the other sub-account, nobody else sees it
    expect((await member('GET', '/api/xr/workspace', undefined, { 'x-location-id': loc })).data.layout.panels[0].route).toBe('conversations');
    expect((await t.api.get('/api/xr/workspace')).data.layout).toBeNull();
    expect((await outsider('GET', '/api/xr/workspace', undefined, { 'x-location-id': other })).data.layout).toBeNull();
    // bad input
    for (const bad of [{ panels: [] }, { panels: [{ route: 'https://evil.example' }] }, { panels: Array.from({ length: 5 }, () => ({ route: 'tasks' })) }, 'x'])
      expect((await member('PUT', '/api/xr/workspace', { layout: bad }, H())).status, JSON.stringify(bad)).toBe(400);
    expect((await member('DELETE', '/api/xr/workspace', undefined, H())).status).toBe(200);
    expect((await member('GET', '/api/xr/workspace', undefined, H())).data.layout).toBeNull();
  });

  it('is for people: a key (location or agency) has no layout of its own', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Layout-Key' })).data.key;
    const k = client(t.base, { authorization: `Bearer ${key}`, 'x-location-id': loc });
    expect((await k('GET', `/api/boards/${shared.id}/xr-layout`)).status).toBe(403);
    expect((await k('PUT', `/api/boards/${shared.id}/xr-layout`, { layout: { panels: {} } })).status).toBe(403);
    expect((await k('GET', `/api/canvas/${canvasId}/xr-layout`)).status).toBe(403);
    expect([401, 403]).toContain((await k('GET', '/api/xr/workspace')).status);
    // no session at all
    const anon = client(t.base, {});
    expect([401, 403]).toContain((await anon('GET', '/api/xr/workspace')).status);
  });

  it('removes a person\'s layouts with the account and keeps the table small', async () => {
    const before = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM xr_layouts')!.n;
    expect(before).toBeGreaterThan(0);
    const mia = t.app.db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'mia@example.com'`)!.id;
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM xr_layouts WHERE user_id = ?', mia)!.n).toBeGreaterThan(0);
    const del = await t.api.del(`/api/users/${mia}`);
    expect(del.status).toBe(200);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM xr_layouts WHERE user_id = ?', mia)!.n).toBe(0);
  });
});
