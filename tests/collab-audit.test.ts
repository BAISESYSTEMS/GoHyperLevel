import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';

/**
 * Every write of the Wiki and the Team-Chat lands in the audit log – and the log never carries what people wrote:
 * no page text, no message text. Autosaves and chat posts are throttled to one line per person, page/channel and
 * ten minutes (the version history and the messages themselves are the record).
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let admin: Call;
let maria: Call;
let mariaId = '';

const rows = (route: string, entity?: string) =>
  t.app.db.all<{ action: string; entity_id: string | null; summary: string; user_id: string | null; location_id: string | null }>(`SELECT action, entity_id, summary, user_id, location_id FROM audit_log WHERE route = ? ${entity ? 'AND entity_id = ?' : ''} ORDER BY at`, route, ...(entity ? [entity] : []));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': loc });
  const u = await t.api.post('/api/users', { email: 'maria@example.com', name: 'Maria Muster', password: 'geheim-12345', role: 'member', locations: [loc], permissions: ['wiki', 'teamchat', 'contacts'] });
  mariaId = u.data.id;
  maria = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await maria('POST', '/api/auth/login', { email: 'maria@example.com', password: 'geheim-12345' })).status).toBe(200);
  (t.app.services as any).chatRate = { max: 100_000 };
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('audit log: wiki', () => {
  it('records every structural write with person, sub-account and page, and never the text', async () => {
    const SECRET = 'GEHEIMER-SEITENTEXT-4711';
    const space = (await admin('POST', '/api/wiki/spaces', { name: 'Audit-Wiki' })).data;
    expect(rows('POST /api/wiki/spaces', space.id)).toHaveLength(1);

    const page = (await admin('POST', '/api/wiki/pages', { space_id: space.id, title: 'Audit-Seite', body: SECRET })).data;
    const created = rows('POST /api/wiki/pages', undefined).find((r) => r.summary === 'Audit-Seite');
    expect(created).toMatchObject({ location_id: loc });
    expect(created?.user_id).toBeTruthy();

    // autosaves: a title change is logged, ten further saves of the same person within ten minutes are not
    let cur = page;
    cur = (await admin('PATCH', `/api/wiki/pages/${page.id}`, { title: 'Audit-Seite neu', base_version: cur.version })).data;
    for (let i = 0; i < 10; i++) cur = (await admin('PATCH', `/api/wiki/pages/${page.id}`, { body: `${SECRET} ${i}`, base_version: cur.version })).data;
    const edits = rows('PATCH /api/wiki/pages/:id', page.id);
    expect(edits.map((e) => e.action)).toEqual(['wiki.edit']);
    // another person's first edit is logged on its own
    await maria('PATCH', `/api/wiki/pages/${page.id}`, { body: `${SECRET} von Maria`, base_version: cur.version });
    expect(rows('PATCH /api/wiki/pages/:id', page.id)).toHaveLength(2);
    expect(rows('PATCH /api/wiki/pages/:id', page.id).at(-1)?.user_id).toBe(mariaId);
    // … while the history keeps who wrote what: one version per author's run of saves
    const versions = (await admin('GET', `/api/wiki/pages/${page.id}/versions`)).data;
    expect(versions).toHaveLength(2);
    expect(versions[0].author_name).toBe('Maria Muster');

    const copy = (await admin('POST', `/api/wiki/pages/${page.id}/duplicate`, {})).data;
    expect(rows('POST /api/wiki/pages/:id/duplicate', page.id)).toHaveLength(1);
    expect((await admin('POST', `/api/wiki/pages/${copy.id}/move`, { space_id: space.id, parent_id: page.id })).status).toBe(200);
    expect(rows('POST /api/wiki/pages/:id/move', copy.id)).toHaveLength(1);
    expect((await admin('POST', `/api/wiki/pages/${page.id}/comments`, { body: 'Ein Kommentar' })).status).toBe(200);
    expect(rows('POST /api/wiki/pages/:id/comments', page.id)).toHaveLength(1);

    const share = (await admin('POST', `/api/wiki/pages/${page.id}/shares`, { label: 'Kunde' })).data;
    expect(rows('POST /api/wiki/pages/:id/shares', page.id)).toHaveLength(1);
    expect((await admin('DELETE', `/api/wiki/pages/${page.id}/shares/${share.id}`)).status).toBe(200);
    expect(rows('DELETE /api/wiki/pages/:id/shares/:sid', page.id)).toHaveLength(1);

    expect((await admin('DELETE', `/api/wiki/pages/${copy.id}`)).status).toBe(200);
    expect(rows('DELETE /api/wiki/pages/:id', copy.id)).toHaveLength(1);
    expect((await admin('POST', `/api/wiki/pages/${copy.id}/restore`, {})).status).toBe(200);
    expect(rows('POST /api/wiki/pages/:id/restore', copy.id)).toHaveLength(1);
    expect((await admin('POST', '/api/wiki/import', { space_id: space.id, markdown: `# Importiert\n\n${SECRET}` })).status).toBe(200);
    expect(rows('POST /api/wiki/import')).toHaveLength(1);
    expect((await admin('POST', '/api/wiki/upsert', { space_id: space.id, title: 'Per Upsert', body: SECRET })).status).toBe(200);
    expect(rows('POST /api/wiki/upsert')).toHaveLength(1);

    // exports are reads that leave the system: logged too
    expect((await admin('GET', `/api/wiki/pages/${page.id}/export?format=md`)).status).toBe(200);
    expect(t.app.db.get(`SELECT 1 AS x FROM audit_log WHERE route = 'GET /api/wiki/pages/:id/export' AND entity_id = ?`, page.id)).toBeTruthy();

    // nothing in the log carries page text
    const all = t.app.db.all<{ summary: string; action: string; route: string }>('SELECT summary, action, route FROM audit_log');
    expect(all.some((r) => `${r.summary} ${r.action} ${r.route}`.includes('GEHEIMER'))).toBe(false);
    // reading and searching write nothing
    const before = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n;
    await admin('GET', `/api/wiki/pages/${page.id}`);
    await admin('GET', '/api/wiki/search?q=audit');
    await admin('POST', '/api/wiki/render', { body: '# Vorschau' });
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n).toBe(before);
  });
});

describe('audit log: team chat', () => {
  it('logs channel changes, edits, deletions and one line per sender and channel for posts – without message text', async () => {
    const SECRET = 'GEHEIME-NACHRICHT-0815';
    const ch = (await maria('POST', '/api/team-chat/channels', { name: 'audit-kanal', kind: 'public' })).data;
    expect(rows('POST /api/team-chat/channels', ch.id)).toHaveLength(1);

    const posted: any[] = [];
    for (let i = 0; i < 4; i++) posted.push((await maria('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: `${SECRET} ${i}` })).data);
    expect(rows('POST /api/team-chat/channels/:id/messages', ch.id)).toHaveLength(1);
    expect(rows('POST /api/team-chat/channels/:id/messages', ch.id)[0]).toMatchObject({ action: 'chat.post', user_id: mariaId, location_id: loc });
    // the admin writing into the same channel is a new line (another sender)
    await admin('POST', `/api/team-chat/channels/${ch.id}/messages`, { body: 'Hallo' });
    expect(rows('POST /api/team-chat/channels/:id/messages', ch.id)).toHaveLength(2);

    expect((await maria('PATCH', `/api/team-chat/messages/${posted[0].id}`, { body: `${SECRET} bearbeitet` })).status).toBe(200);
    expect(rows('PATCH /api/team-chat/messages/:id', posted[0].id)[0].action).toBe('chat.edit');
    expect((await maria('POST', `/api/team-chat/messages/${posted[1].id}/pin`, {})).status).toBe(200);
    expect(rows('POST /api/team-chat/messages/:id/pin', posted[1].id)[0].action).toBe('chat.pin');
    expect((await maria('DELETE', `/api/team-chat/messages/${posted[2].id}`)).status).toBe(200);
    expect(rows('DELETE /api/team-chat/messages/:id', posted[2].id)[0].action).toBe('chat.delete');
    expect((await maria('PATCH', `/api/team-chat/channels/${ch.id}`, { topic: 'Neues Thema' })).status).toBe(200);
    expect(rows('PATCH /api/team-chat/channels/:id', ch.id)[0].action).toBe('chat.channel.update');
    expect((await admin('PUT', '/api/team-chat/settings', { retention_days: 90 })).status).toBe(200);
    expect(rows('PUT /api/team-chat/settings')).toHaveLength(1);

    // reactions, typing, presence and read marks are too chatty to log
    const before = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n;
    await maria('POST', `/api/team-chat/messages/${posted[3].id}/reactions`, { emoji: '👍' });
    await maria('POST', `/api/team-chat/channels/${ch.id}/typing`, {});
    await maria('POST', `/api/team-chat/channels/${ch.id}/read`, {});
    await maria('GET', `/api/team-chat/channels/${ch.id}/messages`);
    await maria('GET', '/api/team-chat/search?q=geheime');
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n).toBe(before);

    // a direct message names the people, never the text
    const dm = (await maria('POST', '/api/team-chat/dms', { user_id: (await admin('GET', '/api/me')).data.user.id })).data;
    await maria('POST', `/api/team-chat/channels/${dm.id}/messages`, { body: `${SECRET} privat` });
    expect(rows('POST /api/team-chat/channels/:id/messages', dm.id)).toHaveLength(1);
    const all = t.app.db.all<{ summary: string; action: string; route: string }>('SELECT summary, action, route FROM audit_log');
    expect(all.some((r) => `${r.summary} ${r.action} ${r.route}`.includes('GEHEIME'))).toBe(false);
  });
});
