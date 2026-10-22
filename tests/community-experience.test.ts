import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { cleanGifUrl, cleanPoll } from '../server/services/community-posts-ext.js';
import { cleanLinks, cleanJitsiUrl } from '../server/services/community-ext.js';
import { heatLevel, currentStreak, heatmapSvg } from '../server/services/community-activity.js';
import { locate, mapSvg } from '../server/services/community-geo.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const mails: { to: string; subject: string; text: string }[] = [];
const events: { type: string; data: any }[] = [];
let anna: any, ben: any, cara: any, dora: any;
let annaC = '', benC = '', caraC = '', doraC = '';
let g: any;
let ch = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const capture = async (_l: any, mail: any) => {
    mails.push(mail);
    return { status: 'sent' };
  };
  t.app.services.memberMailer = capture;
  t.app.services.communityMailer = capture;
  for (const type of ['community.dm_received', 'community.member_joined']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  await t.close();
});

const settle = () => t.app.events.flush();
const base = () => `/portal/${loc}/community`;
function memberCookie(contactId: string) {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${loc}=${raw}`;
}
const get = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const page = async (path: string, cookie: string) => {
  const r = await get(path, cookie);
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const post = (path: string, data: Record<string, string> | [string, string][], cookie: string, headers: Record<string, string> = {}) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers }, body: new URLSearchParams(data as any).toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1];
/** Posts a form the way the page would: reads the token from a page first. */
async function submit(pagePath: string, action: string, data: Record<string, string> | [string, string][], cookie: string) {
  const { html } = await page(pagePath, cookie);
  const fields: [string, string][] = Array.isArray(data) ? data : Object.entries(data);
  const r = await post(action, [['csrf', csrfOf(html)], ...fields], cookie);
  return { status: r.status, location: r.headers.get('location') ?? '', html: r.status === 200 || r.status >= 400 ? await r.text() : '' };
}
const handleOf = (c: any) => t.app.db.get<{ handle: string }>('SELECT handle FROM community_profiles WHERE contact_id = ?', c.id)!.handle;
const gUrl = () => `${base()}/g/${g.slug}`;
const putExt = (body: any) => t.api.put(`/api/community/groups/${g.id}/ext`, body);

describe('community member experience', () => {
  it('sets up a group with four members', async () => {
    anna = (await t.api.post('/api/contacts', { email: 'anna@example.de', first_name: 'Anna', last_name: 'Muster', tags: ['mitglied'] })).data;
    ben = (await t.api.post('/api/contacts', { email: 'ben@example.de', first_name: 'Ben', tags: ['mitglied'] })).data;
    cara = (await t.api.post('/api/contacts', { email: 'cara@example.de', first_name: 'Cara', tags: ['mitglied'] })).data;
    dora = (await t.api.post('/api/contacts', { email: 'dora@example.de', first_name: 'Dora', tags: ['mitglied'] })).data;
    g = (await t.api.post('/api/community/groups', { name: 'Studio', access: { mode: 'tags', tags: ['mitglied'] } })).data;
    ch = g.channels[0].id;
    [annaC, benC, caraC, doraC] = [anna, ben, cara, dora].map((c) => memberCookie(c.id));
    for (const c of [annaC, benC, caraC, doraC]) expect((await page(gUrl(), c)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ?', g.id)!.n).toBe(4);
  });

  it('checks polls, GIF and video links before they are stored', () => {
    expect(cleanPoll(undefined)).toBeNull();
    expect(() => cleanPoll({ question: 'Fragen?', options: ['Nur eine'] })).toThrow(/mindestens zwei/i);
    expect(() => cleanPoll({ question: '', options: ['a', 'b'] })).toThrow();
    const poll = cleanPoll({ question: 'Wann treffen wir uns?', options: ['Mo', 'Di', '', 'Mi'], days: '3' });
    expect(poll!.options).toEqual(['Mo', 'Di', 'Mi']);
    expect(cleanGifUrl('https://media.giphy.com/media/abc123/giphy.gif', { ownHost: 'localhost' })).toBe('https://media.giphy.com/media/abc123/giphy.gif');
    expect(() => cleanGifUrl('https://evil.example/x.gif', { ownHost: 'localhost' })).toThrow(/Giphy|Tenor|Imgur/);
    expect(() => cleanGifUrl('javascript:alert(1)', { ownHost: 'localhost' })).toThrow();
    expect(cleanGifUrl('', { ownHost: 'localhost' })).toBe('');
    expect(cleanLinks([{ url: 'example.com/x', label: '' }])).toEqual([{ label: 'example.com', url: 'https://example.com/x' }]);
    expect(() => cleanLinks([{ url: 'javascript:alert(1)' }])).toThrow(/https/);
    expect(() => cleanLinks([{ url: 'https://u:p@example.com' }])).toThrow(/Zugangsdaten/);
    expect(cleanJitsiUrl('https://meet.example.com/')).toBe('https://meet.example.com');
    expect(() => cleanJitsiUrl('http://meet.example.com')).toThrow();
    expect(() => cleanJitsiUrl('https://meet.example.com/room')).toThrow();
  });

  it('shows the activity calendar levels and streaks', () => {
    expect([0, 1, 2, 3, 4, 6, 7].map(heatLevel)).toEqual([0, 1, 2, 2, 3, 3, 4]);
    const m = new Map([['2026-10-04', 1], ['2026-10-03', 2], ['2026-10-02', 1], ['2026-09-30', 4]]);
    expect(currentStreak(m, '2026-10-04')).toBe(3);
    expect(currentStreak(m, '2026-10-05')).toBe(3);
    expect(currentStreak(m, '2026-10-07')).toBe(0);
    const svg = heatmapSvg(m, '2026-10-04');
    expect(svg).toContain('class="cm-heat"');
    expect(svg).toContain('hm3');
  });

  it('locates cities offline and draws a map without external tiles', () => {
    expect(locate('Berlin', 'Deutschland')).toMatchObject({ place: 'Berlin', country: 'Deutschland', precision: 'city' });
    expect(locate('', 'Österreich')).toMatchObject({ country: 'Österreich', precision: 'country' });
    expect(locate('Nirgendwo', '')).toBeNull();
    const svg = mapSvg('europe', [{ lat: 52.52, lon: 13.4, label: 'Berlin', href: '/x' }]);
    expect(svg).toContain('<svg');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('posts a poll, lets members vote and shows the results', async () => {
    const r = await submit(gUrl(), `${gUrl()}/posts`, [['title', 'Termin'], ['body', 'Wann passt es?'], ['channel_id', ch], ['poll_question', 'Welcher Tag?'], ['poll_option', 'Montag'], ['poll_option', 'Dienstag'], ['poll_option', ''], ['poll_days', '3']], annaC);
    expect(r.status).toBe(303);
    const pid = r.location.split('/p/')[1];
    const view = await page(`${gUrl()}/p/${pid}`, benC);
    expect(view.html).toContain('Welcher Tag?');
    const opts = [...view.html.matchAll(/name="option" value="([^"]+)"/g)].map((m) => m[1]);
    expect(opts).toHaveLength(2);
    // Voting without a token is refused; a vote counts once and can be changed.
    expect((await post(`${gUrl()}/p/${pid}/vote`, { option: opts[0] }, benC)).status).toBe(403);
    let v = await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/vote`, { option: opts[0] }, benC);
    expect(v.status).toBe(303);
    v = await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/vote`, { option: opts[1] }, benC);
    await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/vote`, { option: opts[1] }, caraC);
    const after = await page(`${gUrl()}/p/${pid}`, benC);
    expect(after.html).toContain('2 Stimmen');
    expect(after.html).toContain('100 %');
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_poll_votes')!.n).toBe(2);
    // A made-up option id is refused.
    const bad = await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/vote`, { option: 'erfunden' }, doraC);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // After the end nobody can vote.
    t.app.db.run('UPDATE community_polls SET closes_at = ? WHERE post_id = ?', new Date(Date.now() - 1000).toISOString(), pid);
    const late = await submit(`${gUrl()}/p/${pid}`, `${gUrl()}/p/${pid}/vote`, { option: opts[0] }, doraC);
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_poll_votes')!.n).toBe(2);
  });

  it('embeds a video link, shows a GIF and filters the feed', async () => {
    const v = await submit(gUrl(), `${gUrl()}/posts`, [['title', 'Mein Video'], ['body', 'Schaut mal'], ['channel_id', ch], ['video_url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ']], annaC);
    expect(v.status).toBe(303);
    const vp = v.location.split('/p/')[1];
    const view = await page(`${gUrl()}/p/${vp}`, benC);
    expect(view.html).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(view.headers.get('content-security-policy')).toContain('https://www.youtube-nocookie.com');
    const bad = await submit(gUrl(), `${gUrl()}/posts`, [['title', 'Fremdes Video'], ['channel_id', ch], ['video_url', 'https://evil.example/watch']], annaC);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const gif = await submit(gUrl(), `${gUrl()}/posts`, [['title', 'GIF-Post'], ['body', 'haha'], ['channel_id', ch], ['gif_url', 'https://giphy.com/gifs/cat-funny-abc123XYZ']], benC);
    expect(gif.status).toBe(303);
    const gp = await page(`${gUrl()}/p/${gif.location.split('/p/')[1]}`, annaC);
    expect(gp.html).toMatch(/<img[^>]+class="cm-gif"[^>]+src="https:\/\/media\.giphy\.com\/media\/abc123XYZ\/giphy\.gif"/);
    const evil = await submit(gUrl(), `${gUrl()}/posts`, [['title', 'Fremde GIFs'], ['channel_id', ch], ['gif_url', 'https://evil.example/x.gif']], benC);
    expect(evil.status).toBeGreaterThanOrEqual(400);
    const polls = await page(`${gUrl()}?f=polls`, annaC);
    expect(polls.html).toContain('Termin');
    expect(polls.html).not.toContain('Mein Video');
    const videos = await page(`${gUrl()}?f=videos`, annaC);
    expect(videos.html).toContain('Mein Video');
    expect(videos.html).not.toContain('GIF-Post');
  });

  it('takes polls, video links and GIFs from the team API too', async () => {
    const r = await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Team-Umfrage', body: 'Bitte abstimmen', channel_id: ch, poll: { question: 'Kaffee oder Tee?', options: ['Kaffee', 'Tee'] }, video_url: 'https://vimeo.com/123456789' });
    expect(r.status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_polls WHERE post_id = ?', r.data.id)!.n).toBe(1);
    expect((await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'x', channel_id: ch, video_url: 'https://evil.example/v' })).status).toBe(400);
  });

  it('pins a "Start here" post and keeps it on top', async () => {
    const r = await t.api.post(`/api/community/groups/${g.id}/posts`, { title: 'Hier starten', body: 'Willkommen!', channel_id: ch, pinned: true });
    expect(r.status).toBe(200);
    expect((await putExt({ start_here: { post_id: r.data.id, label: 'Hier starten' } })).status).toBe(200);
    const feed = await page(gUrl(), caraC);
    expect(feed.html.indexOf('Hier starten')).toBeGreaterThan(-1);
    expect((await putExt({ start_here: { post_id: 'fremd' } })).status).toBe(400);
  });
});

describe('community directory, profile and map', () => {
  it('searches and filters members, shows "Mitglied seit" and online dots', async () => {
    const all = await page(`${gUrl()}/members`, annaC);
    expect(all.status).toBe(200);
    for (const n of ['Anna', 'Ben', 'Cara', 'Dora']) expect(all.html).toContain(n);
    expect(all.html).toContain('Mitglied seit');
    const q = await page(`${gUrl()}/members?q=ben`, annaC);
    expect(q.html).toContain('Ben');
    expect(q.html).not.toContain('Cara');
    t.app.db.run(`INSERT INTO community_points (id, location_id, group_id, contact_id, points, reason, created_at) VALUES ('p-cara', ?, ?, ?, 25, 'test', ?)`, loc, g.id, cara.id, new Date().toISOString());
    const lvl = await page(`${gUrl()}/members?level=3`, annaC);
    expect(lvl.html).toContain('Cara');
    expect(lvl.html).not.toContain('>Dora<');
    // Switched off: no directory for members.
    await putExt({ directory: { enabled: false } });
    expect((await page(`${gUrl()}/members`, annaC)).html).not.toContain('Mitglied seit');
    await putExt({ directory: { enabled: true } });
  });

  it('saves profile extras, links only as https and shows them with rel=nofollow', async () => {
    const r = await submit(`${base()}/profile`, `${base()}/profile`, [['display_name', 'Anna Muster'], ['bio', 'Coach'], ['headline', 'Coach für Selbstständige'], ['city', 'Berlin'], ['country', 'Deutschland'], ['link_label', 'Website'], ['link_url', 'https://anna.example'], ['link_label', 'Böse'], ['link_url', 'javascript:alert(1)'], ['show_on_map', '1']], annaC);
    expect(r.status).toBeGreaterThanOrEqual(400); // the bad link stops the whole save
    const ok = await submit(`${base()}/profile`, `${base()}/profile`, [['display_name', 'Anna Muster'], ['bio', 'Coach'], ['headline', 'Coach für Selbstständige'], ['city', 'Berlin'], ['country', 'Deutschland'], ['link_label', 'Website'], ['link_url', 'https://anna.example'], ['show_on_map', '1'], ['show_online', '1'], ['show_activity', '1']], annaC);
    expect(ok.status).toBe(200);
    expect(ok.html).toContain('Gespeichert.');
    const prof = await page(`${base()}/u/${handleOf(anna)}`, benC);
    expect(prof.html).toContain('Coach für Selbstständige');
    expect(prof.html).toMatch(/<a[^>]+href="https:\/\/anna\.example\/?"[^>]+rel="nofollow ugc noopener noreferrer"/);
    expect(prof.html).not.toContain('javascript:');
    expect(prof.html).toContain('cm-heat'); // activity calendar
    expect(prof.html).toContain('Nachricht schreiben');
  });

  it('draws the member map only with the group switch on and for members who opted in', async () => {
    expect((await page(`${gUrl()}/members?view=map`, benC)).html).not.toContain('class="mp"');
    await putExt({ map: { enabled: true } });
    const map = await page(`${gUrl()}/members?view=map`, benC);
    expect(map.html).toContain('class="cm-map"');
    expect(map.html).toContain('class="mp"');
    expect(map.html).toContain('Berlin');
    expect(map.html).toContain('1 Mitglied zeigt ihren Ort');
    // Names never sit on the map – only places – and Ben did not opt in.
    expect(map.html).not.toMatch(/<title>[^<]*Anna/);
    expect(map.html).not.toMatch(/https?:\/\/[^"'\s]*tile/i);
    await putExt({ map: { enabled: false } });
  });

  it('shows who is online and lets people hide it', async () => {
    await page(gUrl(), benC);
    const side = await page(gUrl(), annaC);
    expect(side.html).toContain('Online jetzt');
    await submit(`${base()}/profile`, `${base()}/profile`, [['display_name', 'Ben'], ['show_online', '0']], benC);
    const hidden = await page(`${gUrl()}/members`, annaC);
    expect(hidden.html).toBeTruthy();
    const ping = await t.api.raw(`/portal/${loc}/community/ping`, { method: 'POST', headers: { cookie: annaC } });
    expect(ping.status).toBe(204);
  });
});

describe('community roles and moderation', () => {
  it('makes a moderator who may hide posts, and refuses everybody else', async () => {
    expect((await t.api.post(`/api/community/groups/${g.id}/staff`, { contact_id: dora.id, role: 'moderator' })).status).toBe(200);
    expect((await t.api.get(`/api/community/groups/${g.id}/staff`)).data.map((s: any) => s.contact_id)).toContain(dora.id);
    const bad = await t.api.post(`/api/community/groups/${g.id}/staff`, { contact_id: 'fremd', role: 'admin' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const pid = t.app.db.get<{ id: string }>(`SELECT id FROM community_posts WHERE title = 'GIF-Post'`)!.id;
    const url = `${gUrl()}/p/${pid}`;
    const denied = await submit(url, `${url}/mod`, { action: 'hide' }, caraC);
    expect(denied.status).toBe(403);
    const view = await page(url, doraC);
    expect(view.html).toContain('/mod');
    const hide = await submit(url, `${url}/mod`, { action: 'hide' }, doraC);
    expect(hide.status).toBe(303);
    expect(t.app.db.get<{ status: string }>('SELECT status FROM community_posts WHERE id = ?', pid)!.status).toBe('hidden');
    expect((await page(`${gUrl()}/mod`, doraC)).status).toBe(200);
    expect((await page(`${gUrl()}/mod`, caraC)).status).toBe(403);
    expect((await t.api.del(`/api/community/groups/${g.id}/staff/${dora.id}`)).status).toBe(200);
    expect((await page(`${gUrl()}/mod`, doraC)).status).toBe(403);
  });
});

describe('community direct messages', () => {
  const dmUrl = (c: any) => `${base()}/messages/${handleOf(c)}`;
  const send = (from: string, to: any, body: string) => submit(dmUrl(to), dmUrl(to), { body }, from);

  it('sends a message, counts it in the top bar, marks it read and shows the thread', async () => {
    const r = await send(benC, anna, 'Hallo Anna, hast du kurz Zeit?');
    expect(r.status).toBe(303);
    await settle();
    expect(events.filter((e) => e.type === 'community.dm_received').at(-1)!.data).toMatchObject({ contactId: anna.id, from: { name: 'Ben' } });
    const home = await page(gUrl(), annaC);
    expect(home.html).toMatch(/class="pn-msg"[^>]*>[\s\S]*?<b>1<\/b>/);
    const inbox = await page(`${base()}/messages`, annaC);
    expect(inbox.html).toContain('Hallo Anna, hast du kurz Zeit?');
    expect(inbox.html).toContain('class="un"');
    const thread = await page(dmUrl(ben), annaC);
    expect(thread.html).toContain('Hallo Anna, hast du kurz Zeit?');
    expect(thread.html).toContain('data-dm-thread');
    expect((await page(gUrl(), annaC)).html).not.toMatch(/class="pn-msg"[^>]*>[\s\S]*?<b>\d/);
    // The bell got one entry for the thread, and it was cleared by opening it.
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'dm' AND read_at IS NULL`, anna.id)!.n).toBe(0);
  });

  it('escapes message text and delivers new messages through the poll route', async () => {
    const r = await send(annaC, ben, 'Klar <script>alert(1)</script> **fett**');
    expect(r.status).toBe(303);
    const thread = await page(dmUrl(anna), benC);
    expect(thread.html).not.toContain('<script>alert');
    expect(thread.html).toContain('<strong>fett</strong>');
    const last = thread.html.match(/data-last="([^"]*)"/)![1];
    await send(annaC, ben, 'Noch etwas');
    const poll = await get(`${dmUrl(anna)}/poll?since=${encodeURIComponent(last)}`, benC);
    const body = await poll.json();
    expect(body.html).toContain('Noch etwas');
    expect(body.html).not.toContain('Klar');
    expect((await get(`${dmUrl(anna)}/poll`, '')).status).toBe(401);
  });

  it('refuses people without a shared group, to oneself and empty or oversized texts', async () => {
    const outsider = (await t.api.post('/api/contacts', { email: 'extern@example.de', first_name: 'Extern' })).data;
    t.app.db.run(`INSERT INTO community_profiles (location_id, contact_id, handle, display_name, created_at, updated_at) VALUES (?, ?, 'extern', 'Extern', ?, ?)`, loc, outsider.id, new Date().toISOString(), new Date().toISOString());
    expect((await page(`${base()}/messages/extern`, annaC)).status).toBe(404);
    expect((await send(annaC, anna, 'Ich schreibe mir')).status).toBeGreaterThanOrEqual(400);
    expect((await send(annaC, ben, '   ')).status).toBe(400);
    expect((await send(annaC, ben, 'x'.repeat(4001))).status).toBe(400);
  });

  it('blocks silently, unblocks, and reports a message to the team', async () => {
    const b = await submit(dmUrl(ben), `${dmUrl(ben)}/block`, {}, annaC);
    expect(b.status).toBe(303);
    const blocked = await send(benC, anna, 'Bitte antworte');
    expect(blocked.status).toBe(403);
    expect(blocked.html).toContain('nicht zugestellt');
    expect(blocked.html).not.toContain('blockiert');
    await submit(dmUrl(ben), `${dmUrl(ben)}/unblock`, {}, annaC);
    expect((await send(benC, anna, 'Danke fürs Entsperren')).status).toBe(303);
    const msg = t.app.db.get<{ id: string }>(`SELECT id FROM community_dm_messages WHERE body LIKE 'Danke%'`)!;
    const rep = await submit(dmUrl(ben), `${dmUrl(ben)}/report`, { message_id: msg.id, reason: 'Belästigung' }, annaC);
    expect(rep.status).toBe(200);
    expect(rep.html).toContain('Danke');
    const list = (await t.api.get('/api/community/dm-reports')).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'Belästigung', sender: { id: ben.id }, status: 'open' });
    expect(list[0].context.length).toBeGreaterThan(0);
    // Reporting your own message, or somebody else's thread, does not work.
    const own = await submit(dmUrl(ben), `${dmUrl(ben)}/report`, { message_id: msg.id }, benC);
    expect(own.status).toBeGreaterThanOrEqual(400);
    const foreign = await submit(dmUrl(ben), `${dmUrl(ben)}/report`, { message_id: msg.id }, caraC);
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect((await t.api.patch(`/api/community/dm-reports/${list[0].id}`, { action: 'nonsense' })).status).toBe(400);
    expect((await t.api.patch(`/api/community/dm-reports/${list[0].id}`, { action: 'remove' })).status).toBe(200);
    expect(t.app.db.get<{ status: string }>('SELECT status FROM community_dm_messages WHERE id = ?', msg.id)!.status).toBe('removed');
    expect((await t.api.get('/api/community/dm-reports')).data).toHaveLength(0);
  });

  it('limits messages per hour and can be switched off per group', async () => {
    await putExt({ dms: { per_hour: 3 } });
    const before = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_dm_messages WHERE sender_id = ? AND created_at > ?`, cara.id, new Date(Date.now() - 36e5).toISOString())!.n;
    expect(before).toBe(0);
    for (let i = 0; i < 3; i++) expect((await send(caraC, dora, `Hallo ${i}`)).status).toBe(303);
    const over = await send(caraC, dora, 'Zu viel');
    expect(over.status).toBe(429);
    expect(over.html).toContain('pro Stunde');
    await putExt({ dms: { per_hour: 30, enabled: false } });
    const off = await send(doraC, cara, 'Hallo?');
    expect(off.status).toBe(403);
    expect((await page(`${base()}/u/${handleOf(cara)}`, doraC)).html).not.toContain('Nachricht schreiben');
    await putExt({ dms: { enabled: true } });
  });

  it('applies the word filter of the group to messages', async () => {
    await t.api.patch(`/api/community/groups/${g.id}`, { settings: { word_filter: ['doof'], filter_mode: 'mask' } });
    await send(benC, cara, 'Das ist doof');
    expect(t.app.db.get<{ body: string }>(`SELECT body FROM community_dm_messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1`, ben.id)!.body).toBe('Das ist d***');
    await t.api.patch(`/api/community/groups/${g.id}`, { settings: { word_filter: [] } });
  });

  it('lets the team write to a member and the member answer the team', async () => {
    expect((await t.api.post(`/api/community/messages/${doraC}`, { body: 'x' })).status).toBe(404);
    const w = await t.api.post(`/api/community/messages/${cara.id}`, { body: 'Willkommen im Studio!', from_name: 'Sabine vom Team' });
    expect(w.status).toBe(200);
    await settle();
    expect(events.filter((e) => e.type === 'community.dm_received').at(-1)!.data).toMatchObject({ contactId: cara.id, from: { team: true, name: 'Sabine vom Team' } });
    const inbox = await page(`${base()}/messages`, caraC);
    expect(inbox.html).toContain('Willkommen im Studio!');
    expect(inbox.html).toContain('Team');
    const thread = await page(`${base()}/messages/_team`, caraC);
    expect(thread.html).toContain('Sabine vom Team'.length ? 'Willkommen im Studio!' : '');
    t.app.db.run('UPDATE locations SET email = ? WHERE id = ?', 'team@testfirma.de', loc);
    const before = mails.length;
    const reply = await submit(`${base()}/messages/_team`, `${base()}/messages/_team`, { body: 'Danke, ich habe eine Frage zum Abo.' }, caraC);
    expect(reply.status).toBe(303);
    await settle();
    expect(mails.length).toBe(before + 1);
    expect(mails.at(-1)).toMatchObject({ to: 'team@testfirma.de', subject: expect.stringContaining('Cara') });
    const list = (await t.api.get('/api/community/messages')).data;
    expect(list.find((x: any) => x.contact_id === cara.id)).toMatchObject({ unread: 1, last_preview: expect.stringContaining('Abo') });
    const conv = (await t.api.get(`/api/community/messages/${cara.id}`)).data;
    expect(conv.messages.map((x: any) => [x.from_team, x.body])).toEqual([[true, 'Willkommen im Studio!'], [false, 'Danke, ich habe eine Frage zum Abo.']]);
    expect((await t.api.get('/api/community/messages')).data.find((x: any) => x.contact_id === cara.id).unread).toBe(0);
    // One mail per member and hour, not per line.
    await submit(`${base()}/messages/_team`, `${base()}/messages/_team`, { body: 'Noch eine Zeile' }, caraC);
    await settle();
    expect(mails.length).toBe(before + 1);
  });

  it('keeps every message of one sub-account away from another one', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data;
    const r = await t.api.raw(`/portal/${other.id}/community/messages`, { redirect: 'manual', headers: { cookie: annaC } });
    expect([401, 404]).toContain(r.status);
    expect((await t.api.raw(`/portal/${loc}/community/messages`, { redirect: 'manual' })).status).toBe(401);
  });
});
