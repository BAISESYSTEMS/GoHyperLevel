import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { BOARD_TOOLS } from '../server/modules/boards-tools.js';
import { classify, routeProblem } from '../server/services/agent-safety.js';
import { groupOf } from '../server/services/agent-tools.js';

/** MCP tools and the phone's read-only endpoints of Living Boards, with keys, sub-accounts and member areas. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let keyA = '';
let keyB = '';
let agencyKey = '';
let agencyRead = '';
let limited: Call;
let shared: any;
let personal: any;

let rpcId = 0;
const mcp = async (name: string, args: any, key = keyA) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!j.result?.isError, text, data, error: j.error };
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  keyA = (await t.api.post('/api/api-keys', { name: 'Schlüssel A' })).data.key;
  keyB = (await t.api.post('/api/api-keys', {}, { 'x-location-id': other })).data.key;
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Agentur' })).data.key;
  agencyRead = (await t.api.post('/api/agency/api-keys', { name: 'Nur lesen', scope: 'read' })).data.key;
  await t.api.post('/api/users', { email: 'nur-kontakte@example.com', name: 'Nora Nur-Kontakte', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['contacts'] });
  limited = client(t.base, { 'x-pghl': '1' });
  await limited('POST', '/api/auth/login', { email: 'nur-kontakte@example.com', password: 'passwort-12345' });
  shared = (await t.api.post('/api/boards', { name: 'Team-Board', scope: 'shared', team_access: 'edit', template: 'vertrieb' })).data;
  personal = (await t.api.post('/api/boards', { name: 'Mein Board' })).data;
  await t.api.post('/api/boards', { name: 'Fremd', scope: 'shared' }, { 'x-location-id': other });
}, 60_000);
afterAll(() => t.close());

describe('MCP tools', () => {
  it('are offered with their schemas, classes and group', () => {
    expect(BOARD_TOOLS.map((x) => x.name)).toEqual(['ghl_board_list', 'ghl_board_get', 'ghl_board_apply_patch', 'ghl_board_widgets', 'ghl_board_create']);
    const tool = (name: string) => BOARD_TOOLS.find((x) => x.name === name)!;
    for (const n of ['ghl_board_list', 'ghl_board_get', 'ghl_board_widgets']) expect(classify(tool(n)), n).toBe('read');
    for (const n of ['ghl_board_apply_patch', 'ghl_board_create']) expect(classify(tool(n)), n).toBe('write');
    const patch = tool('ghl_board_apply_patch');
    expect(patch.klassFor!({ ops: [{ op: 'resize', id: 'x', dw: 1 }] })).toBe('write');
    expect(patch.klassFor!({ dry_run: true, ops: [{ op: 'add', type: 'embed' }] })).toBe('read');
    // buttons and embedded addresses always ask, even for an autonomous agent
    expect(patch.klassFor!({ ops: [{ op: 'add', type: 'embed' }] })).toBe('sensitive');
    expect(patch.klassFor!({ ops: [{ op: 'add', type: 'actions' }] })).toBe('sensitive');
    // the check is a read route, the change is not
    expect(routeProblem('POST', '/api/boards/x/preview', 'read')).toBeNull();
    expect(routeProblem('POST', '/api/boards/x/patch', 'read')).toMatch(/nur lesen/);
    expect(routeProblem('POST', '/api/boards/x/patch', 'write')).toBeNull();
    for (const x of BOARD_TOOLS) expect(groupOf(x.name)).toBe('Boards');
  });

  it('list and get show what the key may see – shared boards for a sub-account key', async () => {
    const list = await mcp('ghl_board_list', { location_id: loc });
    expect(list.data.boards.map((b: any) => b.name)).toEqual(['Team-Board']);
    expect(list.data.boards[0]).toMatchObject({ id: shared.id, scope: 'shared', widgets: 9, link: `/app/boards/${shared.id}` });
    const board = await mcp('ghl_board_get', { location_id: loc, board_id: shared.id });
    expect(board.data).toMatchObject({ name: 'Team-Board', version: 1, can_edit: true });
    expect(board.data.widgets[0]).toMatchObject({ type: 'kpi', layout: { lg: { x: 0, y: 0, w: 3, h: 2 } } });
    expect(board.data.widgets[0].data).toBeUndefined();
    const withData = await mcp('ghl_board_get', { location_id: loc, board_id: shared.id, with_data: true });
    expect(withData.data.widgets[0].data.kind).toBe('report');
    // a personal board of a person is not visible to a sub-account key
    expect((await mcp('ghl_board_get', { location_id: loc, board_id: personal.id })).isError).toBe(true);
    // an agency key acts as an admin: it sees every board of the sub-account it names
    const all = await mcp('ghl_board_get', { location_id: loc, board_id: personal.id }, agencyKey);
    expect(all.data.name).toBe('Mein Board');
  });

  it('offers the widget catalogue with fields', async () => {
    const r = await mcp('ghl_board_widgets', { location_id: loc });
    // 13 built-in widgets plus the ones modules register (funnel overview, quota attainment, sales leaderboard).
    const modWidgets = ['funnel_overview', 'quota_attainment', 'sales_leaderboard'];
    expect(r.data.widgets.filter((w: any) => !modWidgets.includes(w.type))).toHaveLength(13);
    expect(r.data.widgets.map((w: any) => w.type)).toEqual(expect.arrayContaining(modWidgets));
    const list = r.data.widgets.find((w: any) => w.type === 'list');
    expect(list.fields.find((f: any) => f.key === 'min_value')).toMatchObject({ label: 'Mindestwert (€)', only_if: 'entity in deals' });
    expect(list.fields.find((f: any) => f.key === 'entity').options).toContain('deals=Deals');
    expect(r.data.widgets.find((w: any) => w.type === 'embed').risk).toBe('high');
  });

  it('applies a patch as a version, checks first on request, and refuses stale or invalid ones with reasons', async () => {
    const dry = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, dry_run: true, ops: [{ op: 'add', type: 'notes', config: { text: 'Hallo' }, placement: 'top' }] });
    expect(dry.data).toMatchObject({ ok: true, saved: false, risk: 'normal' });
    expect((await t.api.get(`/api/boards/${shared.id}`)).data.version).toBe(1);
    const r = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, expected_version: 1, summary: 'Notiz vom Agenten', ops: [{ op: 'add', type: 'notes', config: { text: 'Hallo' }, placement: 'top' }, { op: 'theme', accent: 'grün' }] });
    expect(r.data).toMatchObject({ ok: true, saved: true, version: 2, board: { version: 2, widgets: 10 } });
    const v = (await t.api.get(`/api/boards/${shared.id}/versions`)).data.versions[0];
    expect(v).toMatchObject({ n: 2, kind: 'api', summary: 'Notiz vom Agenten', actor: 'API: Schlüssel A' });
    const stale = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, expected_version: 1, ops: [{ op: 'rename', name: 'Zu spät' }] });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/Version 2/);
    const bad = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, ops: [{ op: 'add', type: 'hologramm' }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Unbekanntes Widget/);
    // the audit log names the key
    const log = (await t.api.get('/api/audit?limit=50')).data as any[];
    expect(log.some((a) => a.action === 'boards.patch' && a.actor === 'API: Schlüssel A' && a.via === 'mcp')).toBe(true);
  });

  it('never lets an agent or key add an embedded address or buttons without the person’s confirmation', async () => {
    const ops = [{ op: 'add', type: 'embed', config: { url: 'https://docs.google.com/document/d/1' } }];
    const refused = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, ops });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/confirm_external/);
    const before = (await t.api.get(`/api/boards/${shared.id}`)).data.version;
    expect(before).toBe(2);
    // the preview is fine without it
    expect((await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, ops, dry_run: true })).data.risk).toBe('high');
    const ok = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, ops, confirm_external: true });
    expect(ok.data).toMatchObject({ ok: true, saved: true, risk: 'high', version: 3 });
    // the same holds for plain REST with a key
    const rest = await t.api.raw(`/api/boards/${shared.id}/patch`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` }, body: JSON.stringify({ ops: [{ op: 'add', type: 'actions', config: { actions: [{ label: 'Neu', kind: 'task' }] } }] }) });
    expect(rest.status).toBe(409);
  });

  it('creates boards from a template; a key can only create shared ones', async () => {
    const r = await mcp('ghl_board_create', { location_id: loc, name: 'Aus dem Agenten', template: 'service', scope: 'shared' });
    expect(r.data).toMatchObject({ name: 'Aus dem Agenten', scope: 'shared', widgets: 9 });
    const personalByKey = await mcp('ghl_board_create', { location_id: loc, name: 'Persönlich', scope: 'personal' });
    expect(personalByKey.isError).toBe(true);
    expect(personalByKey.text).toMatch(/geteilte/);
  });

  it('keeps sub-accounts apart and respects read-only keys', async () => {
    // key A names the other sub-account: it is refused
    expect((await mcp('ghl_board_list', { location_id: other })).isError).toBe(true);
    // key B only sees its own sub-account's board; key A's board is "not found" there
    const theirs = await mcp('ghl_board_list', { location_id: other }, keyB);
    expect(theirs.data.boards.map((b: any) => b.name)).toEqual(['Fremd']);
    expect((await mcp('ghl_board_get', { location_id: other, board_id: shared.id }, keyB)).isError).toBe(true);
    expect((await mcp('ghl_board_apply_patch', { location_id: other, board_id: shared.id, ops: [{ op: 'rename', name: 'Gekapert' }] }, keyB)).isError).toBe(true);
    expect((await t.api.get(`/api/boards/${shared.id}`)).data.name).toBe('Team-Board');
    // a read-only agency key reads, but cannot change
    expect((await mcp('ghl_board_list', { location_id: loc }, agencyRead)).data.boards.length).toBeGreaterThan(1);
    const w = await mcp('ghl_board_apply_patch', { location_id: loc, board_id: shared.id, ops: [{ op: 'rename', name: 'Nein' }] }, agencyRead);
    expect(w.isError).toBe(true);
    expect((await t.api.get(`/api/boards/${shared.id}`)).data.name).toBe('Team-Board');
  });
});

describe('the native app', () => {
  let token = '';
  let appLimited = '';
  const app = (method: string, path: string, body?: unknown, tok = token) =>
    t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));

  beforeAll(async () => {
    token = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel', platform: 'android', app_version: '1.0' })).data.token;
    appLimited = (await limited('POST', '/api/mobile/pair', { device_name: 'Handy Nora' })).data.token;
  });

  it('lists the boards of the sub-accounts, one board in phone order, and its data', async () => {
    const list = await app('GET', '/api/mobile/boards');
    expect(list.status).toBe(200);
    const mine = list.data.boards.filter((b: any) => b.location_id === loc).map((b: any) => b.name);
    expect(mine).toEqual(expect.arrayContaining(['Team-Board', 'Mein Board']));
    expect(list.data.boards.find((b: any) => b.name === 'Team-Board')).toMatchObject({ location_id: loc, scope: 'shared', access: 'owner', home: false });
    const one = await app('GET', `/api/mobile/boards/${shared.id}?location=${loc}`);
    expect(one.status).toBe(200);
    expect(one.data.widgets[0].layout.sm).toMatchObject({ x: 0, w: 1 });
    const ys = one.data.widgets.map((w: any) => w.layout.sm.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    const data = await app('GET', `/api/mobile/boards/${shared.id}/data?location=${loc}`);
    expect(data.status).toBe(200);
    expect(Object.keys(data.data.data)).toHaveLength(one.data.widgets.length);
    const one2 = await app('GET', `/api/mobile/boards/${shared.id}/data?location=${loc}&ids=${one.data.widgets[0].id}`);
    expect(Object.keys(one2.data.data)).toEqual([one.data.widgets[0].id]);
  });

  it('keeps the sub-account and the member rights: no foreign boards, no access without the Dashboard area', async () => {
    const theirs = t.app.db.get<any>('SELECT id FROM boards WHERE location_id = ?', other)!.id;
    expect((await app('GET', `/api/mobile/boards/${theirs}?location=${loc}`)).status).toBe(404);
    expect((await app('GET', `/api/mobile/boards/${theirs}/data?location=${loc}`)).status).toBe(404);
    expect((await app('GET', `/api/mobile/boards/${shared.id}?location=${other}`)).status).toBe(404);
    expect((await app('GET', `/api/mobile/boards/${shared.id}`)).status).toBe(400);
    expect((await app('GET', `/api/mobile/boards/${shared.id}?location=${loc}`, undefined, appLimited)).status).toBe(403);
    expect((await app('GET', '/api/mobile/boards', undefined, appLimited)).data.boards).toEqual([]);
    expect((await t.api.raw('/api/mobile/boards')).status).toBe(401);
    // a person's personal board stays theirs on the phone, too
    const dana = (await t.api.post('/api/users', { email: 'dana@example.com', name: 'Dana', password: 'passwort-12345', role: 'member', locations: [loc], permissions: ['dashboard'] })).data;
    void dana;
    const c = client(t.base, { 'x-pghl': '1' });
    await c('POST', '/api/auth/login', { email: 'dana@example.com', password: 'passwort-12345' });
    const danaTok = (await c('POST', '/api/mobile/pair', { device_name: 'Handy Dana' })).data.token;
    const seen = (await app('GET', '/api/mobile/boards', undefined, danaTok)).data.boards.map((b: any) => b.name);
    expect(seen).toContain('Team-Board');
    expect(seen).not.toContain('Mein Board');
    expect((await app('GET', `/api/mobile/boards/${personal.id}?location=${loc}`, undefined, danaTok)).status).toBe(404);
  });
});
