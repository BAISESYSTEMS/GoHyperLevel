import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';
import { sendDm, TEAM } from '../server/services/community-dm.js';

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let loc2 = '';
let g: any;
let admin = '';
let limited = '';
const tokens: Record<string, string> = {};

async function app(method: string, path: string, tok: string, body?: unknown) {
  const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, data: (type.includes('json') ? await r.json() : await r.text()) as any };
}
async function phone(name: string, permissions: string[] | null) {
  const email = `${name}@example.com`;
  const u = await t.api.post('/api/users', { email, name, password: 'geheim-12345', role: 'member', locations: [loc], permissions });
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
  const p = await c('POST', '/api/mobile/pair', { device_name: `${name}-phone`, platform: 'android' });
  expect(p.status, p.text).toBe(200);
  tokens[name] = p.data.token;
  return p.data.token as string;
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  loc2 = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  t.app.services.memberMailer = async () => ({ status: 'sent' });
  t.app.services.communityMailer = async () => ({ status: 'sent' });
  g = (await t.api.post('/api/community/groups', { name: 'Handy-Club' })).data;
  await t.api.put(`/api/community/groups/${g.id}/join/page`, { slug: 'handy-club', enabled: true, approval: true, set_access_join: true });
  admin = (await t.api.post('/api/mobile/pair', { device_name: 'Admin-Handy' })).data.token;
  limited = await phone('kontakte', ['contacts']);
});
afterAll(async () => {
  await t.close();
});

describe('community on the phone', () => {
  it('shows what needs attention and nothing to people without the area', async () => {
    const empty = (await app('GET', '/api/mobile/community', admin)).data;
    expect(empty.totals).toEqual({ pending_requests: 0, open_reports: 0, unread_team_messages: 0 });
    expect(empty.locations.find((l: any) => l.location_id === loc).groups[0]).toMatchObject({ name: 'Handy-Club', members: 0 });
    expect((await app('GET', '/api/mobile/community', limited)).data.locations).toEqual([]);
    expect((await app('GET', `/api/mobile/community?location=${loc}`, limited)).status).toBe(403);
    expect((await app('GET', '/api/mobile/community/requests', limited)).data).toEqual([]);
    expect([401, 403]).toContain((await app('GET', '/api/mobile/community', 'unbekannt')).status);
  });

  it('approves and rejects join requests', async () => {
    const page = await t.api.raw(`/c/handy-club/join`);
    const html = await page.text();
    const tok = html.match(/name="_t" value="([^"]+)"/)![1];
    const join = (email: string, name: string) => t.api.raw('/c/handy-club/join', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _t: tok, name, email, tier: '', consent: '1' }).toString() });
    t.app.services.communityLimits = { join: 10_000 };
    expect((await join('anna@example.de', 'Anna Muster')).status).toBeLessThan(400);
    expect((await join('ben@example.de', 'Ben Beispiel')).status).toBeLessThan(400);
    const list = (await app('GET', '/api/mobile/community/requests', admin)).data;
    expect(list.map((r: any) => r.email).sort()).toEqual(['anna@example.de', 'ben@example.de']);
    expect(list[0]).toMatchObject({ location_id: loc, group_name: 'Handy-Club' });
    expect((await app('GET', '/api/mobile/community', admin)).data.totals.pending_requests).toBe(2);
    const anna = list.find((r: any) => r.email === 'anna@example.de');
    const ben = list.find((r: any) => r.email === 'ben@example.de');
    expect((await app('POST', `/api/mobile/community/requests/${anna.id}`, admin, { action: 'nonsens' })).status).toBe(400);
    expect((await app('POST', `/api/mobile/community/requests/${anna.id}`, limited, { action: 'approve' })).status).toBe(404);
    expect((await app('POST', `/api/mobile/community/requests/${anna.id}`, admin, { action: 'approve' })).data).toEqual({ ok: true });
    expect((await app('POST', `/api/mobile/community/requests/${ben.id}`, admin, { action: 'reject', note: 'Passt leider nicht' })).data).toEqual({ ok: true });
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', anna.id)!.status).toBe('active');
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', ben.id)!.status).toBe('rejected');
    expect((await app('GET', '/api/mobile/community', admin)).data.totals.pending_requests).toBe(0);
    // The relayed writes are in the audit log as coming from the app.
    expect(t.app.db.all<any>(`SELECT action FROM audit_log WHERE via = 'app' AND action LIKE 'community.%'`).length).toBeGreaterThan(0);
  });

  it('settles reports of posts and of messages', async () => {
    const annaId = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'anna@example.de'`)!.id;
    const post = (await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Heikles Thema', body: 'Text', channel_id: g.channels[0].id })).data;
    t.app.db.run(`INSERT INTO community_reports (id, location_id, group_id, kind, target_id, contact_id, reason, status, created_at) VALUES ('rep1', ?, ?, 'post', ?, ?, 'Werbung', 'open', ?)`, loc, g.id, post.id, annaId, new Date().toISOString());
    // A second member in the same group, so a message can be reported.
    const carl = (await t.api.post('/api/contacts', { email: 'carl@example.de', first_name: 'Carl' })).data;
    await t.api.post(`/api/community/groups/${g.id}/memberships`, { contact_id: carl.id });
    const { message } = sendDm(t.app, loc, carl.id, annaId, 'Kauf jetzt bei mir!');
    t.app.db.run(`INSERT INTO community_dm_reports (id, location_id, thread_id, message_id, reporter_id, reason, status, created_at) VALUES ('dmrep1', ?, ?, ?, ?, 'Spam', 'open', ?)`, loc, message.thread_id, message.id, annaId, new Date().toISOString());
    const list = (await app('GET', '/api/mobile/community/reports', admin)).data;
    expect(list.map((r: any) => [r.kind, r.reason]).sort()).toEqual([['dm', 'Spam'], ['post', 'Werbung']]);
    expect(list.find((r: any) => r.kind === 'post').text).toContain('Heikles Thema');
    expect((await app('GET', '/api/mobile/community', admin)).data.totals.open_reports).toBe(2);
    expect((await app('POST', '/api/mobile/community/reports/rep1', admin, { action: 'ban' })).status).toBe(400);
    expect((await app('POST', '/api/mobile/community/reports/rep1', limited, { action: 'hide' })).status).toBe(404);
    expect((await app('POST', '/api/mobile/community/reports/rep1', admin, { action: 'hide' })).data).toEqual({ ok: true });
    expect(t.app.db.get<any>('SELECT status FROM community_posts WHERE id = ?', post.id)!.status).toBe('hidden');
    expect((await app('POST', '/api/mobile/community/reports/dmrep1?kind=dm', admin, { action: 'remove' })).data).toEqual({ ok: true });
    expect(t.app.db.get<any>('SELECT status FROM community_dm_messages WHERE id = ?', message.id)!.status).toBe('removed');
    expect((await app('GET', '/api/mobile/community/reports', admin)).data).toEqual([]);
  });

  it('reads and answers messages from members, and posts as the team', async () => {
    const c = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'carl@example.de'`)!.id;
    sendDm(t.app, loc, c, TEAM, 'Hast du kurz Zeit für eine Frage?');
    const threads = (await app('GET', '/api/mobile/community/messages', admin)).data;
    expect(threads[0]).toMatchObject({ contact_id: c, unread: 1, location_id: loc, last_preview: 'Hast du kurz Zeit für eine Frage?' });
    expect((await app('GET', '/api/mobile/community', admin)).data.totals.unread_team_messages).toBe(1);
    const thread = (await app('GET', `/api/mobile/community/messages/${c}`, admin)).data;
    expect(thread.messages).toEqual([expect.objectContaining({ from_team: false, body: 'Hast du kurz Zeit für eine Frage?' })]);
    expect((await app('GET', '/api/mobile/community', admin)).data.totals.unread_team_messages).toBe(0); // opened = read
    const reply = await app('POST', `/api/mobile/community/messages/${c}`, admin, { body: 'Klar, schieß los.', from_name: 'Sabine' });
    expect(reply.status).toBe(200);
    expect(t.app.db.get<any>(`SELECT sender_name FROM community_dm_messages WHERE body = 'Klar, schieß los.'`)!.sender_name).toBe('Sabine');
    expect((await app('POST', `/api/mobile/community/messages/${c}`, admin, { body: ' ' })).status).toBe(400);
    expect((await app('GET', `/api/mobile/community/messages/${c}`, limited)).status).toBe(404);
    const post = await app('POST', '/api/mobile/community/posts', admin, { group_id: g.id, title: 'Vom Handy', body: 'Hallo Club', pinned: true });
    expect(post.status).toBe(200);
    expect(t.app.db.get<any>('SELECT pinned FROM community_posts WHERE id = ?', post.data.id)!.pinned).toBe(1);
    expect((await app('POST', '/api/mobile/community/posts', admin, { group_id: 'fremd', title: 'x' })).status).toBe(404);
  });

  it('keeps the other sub-account out', async () => {
    const other = (await t.api.post('/api/community/groups', { name: 'Fremder Club' })).data;
    void other;
    t.api.setLocation(loc2);
    const g2 = (await t.api.post('/api/community/groups', { name: 'Zweitfirmen-Club' })).data;
    t.api.setLocation(loc);
    const all = (await app('GET', '/api/mobile/community', admin)).data;
    expect(all.locations.map((l: any) => l.name).sort()).toEqual(expect.arrayContaining(['Testfirma', 'Zweitfirma']));
    const one = (await app('GET', `/api/mobile/community?location=${loc}`, admin)).data;
    expect(JSON.stringify(one)).not.toContain('Zweitfirmen-Club');
    expect(g2.id).toBeTruthy();
    expect((await app('GET', '/api/mobile/community?location=unbekannt', admin)).status).toBe(404);
  });
});
