import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPm, type Pm } from './pm-helpers.js';
import { client } from './security-fixtures.js';

/** Who may undo what: own changes, admins everything in scope, other sub-accounts nothing; retention, trash purge, GDPR, MCP and the phone API. */

let p: Pm;
let t: Pm['t'];
let admin: ReturnType<typeof client>;
const undoId = (r: { headers: Headers }) => r.headers.get('x-undo-id')!;
const row = (sql: string, ...a: any[]) => t.app.db.get<any>(sql, ...a);

beforeAll(async () => {
  p = await setupPm();
  t = p.t;
  admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': p.A });
});
afterAll(() => t.close());

describe('own changes, admins, areas', () => {
  it('a member undoes their own change; a colleague cannot; an admin can undo anyone’s', async () => {
    const anna = await p.login('anna@example.com');
    const ben = await p.login('ben@example.com');
    const task = (await admin('POST', '/api/tasks', { title: 'Rechnung prüfen' })).data;
    const done = await anna('PATCH', `/api/tasks/${task.id}`, { done: true });
    const id = undoId(done as any);
    expect(id).toBeTruthy();
    // Ben has the area but it is not his change.
    const no = await ben('POST', `/api/undo/${id}`, {});
    expect(no.status).toBe(403);
    expect(no.data.error).toContain('eigenen');
    expect(row('SELECT done FROM tasks WHERE id = ?', task.id).done).toBe(1);
    // Ben's own list does not show Anna's change.
    expect((await ben('GET', '/api/undo')).data.items.some((i: any) => i.id === id)).toBe(false);
    // Anna's list does; "all" for a member still means only theirs.
    expect((await anna('GET', '/api/undo?scope=all')).data.items.some((i: any) => i.id === id)).toBe(true);
    expect((await ben('GET', '/api/undo?scope=all')).data.items.some((i: any) => i.id === id)).toBe(false);
    // The admin sees everyone's with scope=all and can undo it.
    const all = (await admin('GET', '/api/undo?scope=all')).data.items;
    expect(all.find((i: any) => i.id === id)).toMatchObject({ actor: 'Anna Beispiel', mine: false, can_undo: true });
    expect((await admin('POST', `/api/undo/${id}`, {})).status).toBe(200);
    expect(row('SELECT done FROM tasks WHERE id = ?', task.id).done).toBe(0);
  });

  it('keeps to the member’s areas: no entries and no undo for areas they lost', async () => {
    const ben = await p.login('ben@example.com');
    const c = (await admin('POST', '/api/contacts', { first_name: 'Uwe', email: 'uwe@example.com' })).data;
    const prod = (await ben('POST', '/api/products', { name: 'Kurs', price_cents: 5000 })).data;
    const edit = await ben('PATCH', `/api/products/${prod.id}`, { price_cents: 7000 });
    const id = undoId(edit as any);
    expect(id).toBeTruthy();
    // Ben loses the payments area: the entry disappears from his list and cannot be undone.
    t.app.db.run('UPDATE users SET permissions = ? WHERE id = ?', JSON.stringify(['contacts']), p.ben.id);
    const ben2 = await p.login('ben@example.com');
    expect((await ben2('GET', '/api/undo')).data.items.some((i: any) => i.id === id)).toBe(false);
    const r = await ben2('POST', `/api/undo/${id}`, {});
    expect(r.status).toBe(403);
    expect(row('SELECT price_cents FROM products WHERE id = ?', prod.id).price_cents).toBe(7000);
    void c;
  });
});

describe('sub-account isolation', () => {
  it('another sub-account (member, key, even an admin working in it) cannot see, preview, undo or purge an entry', async () => {
    const task = (await admin('POST', '/api/tasks', { title: 'Nur in A' })).data;
    const id = undoId((await admin('PATCH', `/api/tasks/${task.id}`, { done: true })) as any);
    const del = undoId((await admin('DELETE', `/api/tasks/${task.id}`)) as any);
    expect(row('SELECT location_id FROM undo_entries WHERE id = ?', id).location_id).toBe(p.A);

    const cleo = (await t.api.post('/api/users', { email: 'cleo@example.com', name: 'Cleo', password: 'passwort-1', role: 'member', locations: [p.B], permissions: null })).data;
    expect(cleo.id).toBeTruthy();
    const inB = await p.login('cleo@example.com', p.B);
    const adminInB = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': p.B });
    for (const who of [inB, adminInB]) {
      expect((await who('POST', `/api/undo/${id}`, {})).status).toBe(404);
      expect((await who('GET', `/api/undo/${id}/preview`)).status).toBe(404);
      // Emptying the trash is for admins: a member is refused outright, an admin of another sub-account finds nothing.
      expect((await who('DELETE', `/api/undo/${del}`)).status).toBe(who === inB ? 403 : 404);
      const list = JSON.stringify((await who('GET', '/api/undo?scope=all&limit=200')).data) + JSON.stringify((await who('GET', '/api/undo/trash')).data);
      expect(list).not.toContain('Nur in A');
    }
    // A member of A cannot reach B with the header either.
    const anna = await p.login('anna@example.com');
    expect((await anna('GET', '/api/undo', undefined, { 'x-location-id': p.B })).status).toBe(403);
    // A's key for B.
    const keyB = (await adminInB('POST', '/api/api-keys', { name: 'B' })).data.key;
    const kb = client(t.base, { authorization: `Bearer ${keyB}`, 'x-location-id': p.B });
    expect((await kb('POST', `/api/undo/${id}`, {})).status).toBe(404);
    // Nothing happened in A.
    expect(row('SELECT id FROM tasks WHERE id = ?', task.id)).toBeUndefined();
    expect(row('SELECT undone_at FROM undo_entries WHERE id = ?', del).undone_at).toBeNull();
  });
});

describe('retention, trash and the GDPR step', () => {
  it('entries expire after the retention days (setting) and the cleanup job removes them', async () => {
    expect((await admin('GET', '/api/undo/settings')).data).toMatchObject({ retention_days: 30, can_edit: true });
    const mk = async (title: string) => {
      const task = (await admin('POST', '/api/tasks', { title })).data;
      return undoId((await admin('PATCH', `/api/tasks/${task.id}`, { done: true })) as any);
    };
    const old = await mk('Alt');
    const recent = await mk('Neuer');
    const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
    t.app.db.run('UPDATE undo_entries SET at = ? WHERE id = ?', ago(31), old);
    t.app.db.run('UPDATE undo_entries SET at = ? WHERE id = ?', ago(29), recent);
    // Past the retention: not offered, not undoable.
    expect((await admin('GET', '/api/undo?limit=200')).data.items.some((i: any) => i.id === old)).toBe(false);
    expect((await admin('POST', `/api/undo/${old}`, {})).status).toBe(410);
    const removed = t.app.services.undo.cleanup();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(row('SELECT id FROM undo_entries WHERE id = ?', old)).toBeUndefined();
    expect(row('SELECT id FROM undo_entries WHERE id = ?', recent)).toBeTruthy();
    // Shorter retention applies to the sub-account.
    expect((await admin('PUT', '/api/undo/settings', { retention_days: 7 })).data.retention_days).toBe(7);
    expect((await admin('PUT', '/api/undo/settings', { retention_days: 0 })).status).toBe(400);
    t.app.db.run('UPDATE undo_entries SET at = ? WHERE id = ?', ago(10), recent);
    expect(t.app.services.undo.cleanup()).toBeGreaterThanOrEqual(1);
    expect(row('SELECT id FROM undo_entries WHERE id = ?', recent)).toBeUndefined();
    await admin('PUT', '/api/undo/settings', { retention_days: 30 });
    // Members cannot change it.
    const nora = await p.login('nora@example.com');
    expect((await nora('PUT', '/api/undo/settings', { retention_days: 365 })).status).toBe(403);
  });

  it('"endgültig löschen" is for admins and takes the record out of reach', async () => {
    const c = (await admin('POST', '/api/contacts', { first_name: 'Papier', email: 'papier@example.com' })).data;
    const del = undoId((await admin('DELETE', `/api/contacts/${c.id}`)) as any);
    const anna = await p.login('anna@example.com');
    const trash = (await anna('GET', '/api/undo/trash')).data;
    expect(trash.can_purge).toBe(false);
    expect(trash.items.some((i: any) => i.id === del)).toBe(true);
    expect((await anna('DELETE', `/api/undo/${del}`)).status).toBe(403);
    expect((await admin('DELETE', `/api/undo/${del}`)).status).toBe(200);
    expect((await admin('POST', `/api/undo/${del}`, {})).status).toBe(404);
    expect(row('SELECT id FROM contacts WHERE id = ?', c.id)).toBeUndefined();
  });

  it('erasing a contact for GDPR empties the journal of everything about it', async () => {
    const c = (await admin('POST', '/api/contacts', { first_name: 'Vergessen', email: 'vergessen@example.com' })).data;
    await admin('PATCH', `/api/contacts/${c.id}`, { city: 'Köln' });
    await admin('POST', '/api/tasks', { title: 'Zu Vergessen', contact_id: c.id });
    const taskId = row('SELECT id FROM tasks WHERE contact_id = ?', c.id).id;
    await admin('PATCH', `/api/tasks/${taskId}`, { done: true });
    expect(t.app.db.all('SELECT id FROM undo_entries WHERE contact_id = ?', c.id).length).toBeGreaterThanOrEqual(2);
    const r = await admin('POST', `/api/contacts/${c.id}/erase`, { confirm: 'vergessen@example.com' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(t.app.db.all('SELECT id FROM undo_entries WHERE contact_id = ?', c.id)).toHaveLength(0);
    expect(JSON.stringify(t.app.db.all('SELECT snap_before, snap_after FROM undo_entries'))).not.toContain('vergessen@example.com');
  });
});

describe('what Ctrl+Z would do', () => {
  it('offers my newest change, then the undo to repeat – until a new change makes redo pointless', async () => {
    const task = (await admin('POST', '/api/tasks', { title: 'Strg Z' })).data;
    const e1 = undoId((await admin('PATCH', `/api/tasks/${task.id}`, { title: 'Strg Z 1' })) as any);
    const e2 = undoId((await admin('PATCH', `/api/tasks/${task.id}`, { title: 'Strg Z 2' })) as any);
    let last = (await admin('GET', '/api/undo/last')).data;
    expect(last.undo.id).toBe(e2);
    expect(last.redo).toBeNull();
    const u = (await admin('POST', `/api/undo/${e2}`, {})).data;
    last = (await admin('GET', '/api/undo/last')).data;
    expect(last.undo.id).toBe(e1);
    expect(last.redo.id).toBe(u.redo_id);
    // a new change: the redo is gone
    await admin('PATCH', `/api/tasks/${task.id}`, { description: 'neu' });
    expect((await admin('GET', '/api/undo/last')).data.redo).toBeNull();
  });
});

describe('MCP tools and the phone API', () => {
  const rpc = async (key: string, name: string, args: Record<string, unknown>) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    return { error: j.result?.isError ? j.result.content[0].text : undefined, data: j.result?.structuredContent as any };
  };

  it('a key lists its own changes and takes one back – with conflicts reported, not forced', async () => {
    const key = (await admin('POST', '/api/api-keys', { name: 'Claude' })).data.key;
    const api = client(t.base, { authorization: `Bearer ${key}`, 'x-location-id': p.A });
    const task = (await api('POST', '/api/tasks', { title: 'Vom Agenten' })).data;
    const edit = await api('PATCH', `/api/tasks/${task.id}`, { title: 'Vom Agenten – falsch' });
    expect(edit.headers.get('x-undo-id')).toBeTruthy();

    const list = await rpc(key, 'ghl_undo_list', { location_id: p.A });
    expect(list.error).toBeUndefined();
    const entry = list.data.changes.find((c: any) => c.entity_id === task.id);
    expect(entry).toMatchObject({ label: 'Aufgabe „Vom Agenten – falsch“ geändert', actor_kind: 'api_key', can_undo: true });
    expect(entry.changes[0]).toMatchObject({ l: 'Titel', from: 'Vom Agenten', to: 'Vom Agenten – falsch' });
    // The admin's own changes are not this key's.
    const mine = await rpc(key, 'ghl_undo_list', { location_id: p.A, actor: 'me' });
    expect(mine.data.changes.every((c: any) => c.actor_kind === 'api_key')).toBe(true);

    // Someone else edits it meanwhile → the tool reports the conflict.
    await admin('PATCH', `/api/tasks/${task.id}`, { title: 'Manuell korrigiert' });
    const conflict = await rpc(key, 'ghl_undo', { location_id: p.A, entry_id: entry.id });
    expect(conflict.data).toMatchObject({ restored: false, conflict: true });
    expect(conflict.data.diff[0]).toMatchObject({ label: 'Titel', now: 'Manuell korrigiert' });
    expect(row('SELECT title FROM tasks WHERE id = ?', task.id).title).toBe('Manuell korrigiert');
    const forced = await rpc(key, 'ghl_undo', { location_id: p.A, entry_id: entry.id, force: true });
    expect(forced.data).toMatchObject({ restored: true });
    expect(row('SELECT title FROM tasks WHERE id = ?', task.id).title).toBe('Vom Agenten');

    // A key can not undo what a person did.
    const mineByAdmin = undoId((await admin('PATCH', `/api/tasks/${task.id}`, { title: 'Admin' })) as any);
    const refused = await rpc(key, 'ghl_undo', { location_id: p.A, entry_id: mineByAdmin });
    expect(refused.error).toContain('(403)');
  });

  it('an agency key sees changes of every actor (filter by actor kind) and works in any sub-account', async () => {
    const agency = (await admin('POST', '/api/agency/api-keys', { name: 'Agentur' })).data.key;
    const task = (await admin('POST', '/api/tasks', { title: 'Von Hand' })).data;
    await admin('PATCH', `/api/tasks/${task.id}`, { done: true });
    const res = await rpc(agency, 'ghl_undo_list', { location_id: p.A, actor: 'user', limit: 50 });
    expect(res.data.changes.some((c: any) => c.entity_id === task.id && c.actor === 'Chef')).toBe(true);
    const trash = await rpc(agency, 'ghl_undo_list', { location_id: p.A, trash: true });
    expect(Array.isArray(trash.data.changes)).toBe(true);
    const inB = await rpc(agency, 'ghl_undo_list', { location_id: p.B, actor: 'all' });
    expect(JSON.stringify(inB.data)).not.toContain('Von Hand');
  });

  it('the phone gets its recent changes and can undo (token only, own sub-accounts only)', async () => {
    const pair = await admin('POST', '/api/mobile/pair', { device_name: 'Pixel' });
    const tok = pair.data.token;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, data: (await r.json()) as any, headers: r.headers };
    };
    const task = (await admin('POST', '/api/tasks', { title: 'Vom Handy aus' })).data;
    const done = await call('POST', `/api/mobile/tasks/${task.id}/complete`);
    expect(done.status).toBe(200);
    // the app's own write routes answer with the journal headers too (for a snackbar without a second request)
    expect(decodeURIComponent(done.headers.get('x-undo-label')!)).toBe('Aufgabe „Vom Handy aus“ erledigt');
    expect(done.headers.get('x-undo-id')).toBeTruthy();
    const recent = await call('GET', '/api/mobile/undo/recent?limit=5');
    expect(recent.status).toBe(200);
    const item = recent.data.items.find((i: any) => i.entity_id === task.id);
    expect(item).toMatchObject({ label: 'Aufgabe „Vom Handy aus“ erledigt', location_id: p.A, can_undo: true, actor_kind: 'app' });
    const r = await call('POST', `/api/mobile/undo/${item.id}`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(row('SELECT done FROM tasks WHERE id = ?', task.id).done).toBe(0);
    expect((await call('POST', `/api/mobile/undo/${item.id}`, {})).status).toBe(409);
    expect((await call('POST', '/api/mobile/undo/gibtsnicht', {})).status).toBe(404);
  });
});
