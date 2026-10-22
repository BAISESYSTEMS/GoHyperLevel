import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { requiredPermission } from '../server/core/permissions.js';
import { triggerMatches } from '../server/services/workflow-engine.js';
import { applyWordFilter, cleanGroupSettings, decodeImage, levelFor, mentionHandles, nextLevel, relTime, stripMarkdownImages } from '../server/services/community.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: { type: string; data: any }[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
  for (const type of ['community.post_created', 'community.member_joined', 'community.level_reached', 'course.enrolled']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  await t.close();
});

const settle = () => t.app.events.flush();
/** A member session like the one the email login creates. */
function memberCookie(contactId: string, location = loc) {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), location, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${location}=${raw}`;
}
const get = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const page = async (path: string, cookie: string) => {
  const r = await get(path, cookie);
  return { status: r.status, html: await r.text() };
};
const post = (path: string, data: Record<string, string> | [string, string][], cookie: string, headers: Record<string, string> = {}) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers }, body: new URLSearchParams(data as any).toString() });
const csrfOf = (html: string) => html.match(/name="csrf" value="([^"]+)"/)![1];
/** Posts a form the way the page would: reads the token from the page first. */
async function submit(pagePath: string, action: string, data: Record<string, string> | [string, string][], cookie: string) {
  const { html } = await page(pagePath, cookie);
  const fields: [string, string][] = Array.isArray(data) ? data : Object.entries(data);
  return post(action, [['csrf', csrfOf(html)], ...fields], cookie);
}

describe('community rules', () => {
  it('computes levels, filters words and finds mentions', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(4)).toBe(1);
    expect(levelFor(5)).toBe(2);
    expect(levelFor(70)).toBe(4);
    expect(nextLevel(3)).toEqual({ level: 2, name: 'Level 2', missing: 2 });
    expect(nextLevel(40000)).toBeNull();
    expect(applyWordFilter('So ein Mist, echt mist!', ['mist'])).toEqual({ text: 'So ein M***, echt m***!', hits: 2, blocked: false });
    expect(applyWordFilter('Mistgabel bleibt', ['mist']).hits).toBe(0);
    expect(applyWordFilter('Scheißtag heute', ['scheiß*']).text).toBe('S******** heute');
    expect(applyWordFilter('Spam hier', ['spam'], 'block')).toMatchObject({ blocked: true, text: 'Spam hier' });
    expect(mentionHandles('Hallo @anna-muster und @ben, mail an x@y.de, Link https://x.de/@nope')).toEqual(['anna-muster', 'ben']);
    expect(stripMarkdownImages('Schau ![pixel](https://evil.example/p.png)')).toBe('Schau [pixel](https://evil.example/p.png)');
    expect(relTime(new Date(Date.now() - 3 * 36e5).toISOString())).toBe('vor 3 Std.');
    expect(() => cleanGroupSettings({ levels: [{ points: 0 }, { points: 10 }, { points: 5 }] })).toThrow(/Level 3/);
    expect(cleanGroupSettings({ posts_per_hour: -4, points: { like: 3 } })).toMatchObject({ posts_per_hour: 0, points: { post: 2, comment: 1, like: 3 } });
  });

  it('accepts only real images within the size limit', () => {
    expect(decodeImage(PNG).mime).toBe('image/png');
    expect(() => decodeImage('data:image/svg+xml;base64,' + Buffer.from('<svg onload="x"/>').toString('base64'))).toThrow(/PNG, JPG/);
    expect(() => decodeImage('data:image/png;base64,' + Buffer.from('<html>nope</html>').toString('base64'))).toThrow(/passt nicht/);
    expect(() => decodeImage('data:image/jpeg;base64,' + Buffer.alloc(4 * 1024 * 1024, 0xff).toString('base64'))).toThrow(/größer als 3 MB/);
  });

  it('maps routes and filters triggers', () => {
    expect(requiredPermission('GET', '/api/community/groups')).toBe('courses');
    expect(requiredPermission('POST', '/api/community/groups/x/posts')).toBe('courses');
    const ev = (type: string, data: any) => ({ type, locationId: 'l', at: '', data });
    expect(triggerMatches({ type: 'community.post_created', config: { group_id: 'g1' } }, ev('community.post_created', { groupId: 'g1' }))).toBe(true);
    expect(triggerMatches({ type: 'community.post_created', config: { group_id: 'g1' } }, ev('community.post_created', { groupId: 'g2' }))).toBe(false);
    expect(triggerMatches({ type: 'community.level_reached', config: { level: '3' } }, ev('community.level_reached', { groupId: 'g', level: 3 }))).toBe(true);
    expect(triggerMatches({ type: 'community.level_reached', config: { level: '3' } }, ev('community.level_reached', { groupId: 'g', level: 2 }))).toBe(false);
  });
});

describe('community', () => {
  let courseA: any, courseB: any;
  let gAll: any, gCourse: any, gTag: any;
  let anna: any, ben: any, cara: any, dora: any;
  let annaC = '', benC = '', caraC = '', doraC = '';
  let annaPost = '';
  const base = () => `/portal/${loc}/community`;

  it('sets up groups with channels, access rules and settings', async () => {
    courseA = (await t.api.post('/api/courses', { title: 'Kurs A' })).data;
    courseB = (await t.api.post('/api/courses', { title: 'Kurs B' })).data;
    anna = (await t.api.post('/api/contacts', { email: 'anna@example.de', first_name: 'Anna', last_name: 'Muster' })).data;
    ben = (await t.api.post('/api/contacts', { email: 'ben@example.de', first_name: 'Ben', tags: ['community'] })).data;
    cara = (await t.api.post('/api/contacts', { email: 'cara@example.de', first_name: 'Cara' })).data;
    dora = (await t.api.post('/api/contacts', { email: 'dora@example.de', first_name: 'Dora' })).data;
    await t.api.post(`/api/courses/${courseA.id}/enrollments`, { contact_id: anna.id });
    await t.api.post(`/api/courses/${courseB.id}/enrollments`, { contact_id: dora.id });

    const r = await t.api.post('/api/community/groups', { name: 'Mastermind', description: 'Für **alle** Mitglieder' });
    expect(r.status).toBe(200);
    gAll = r.data;
    expect(gAll).toMatchObject({ slug: 'mastermind', access: { mode: 'all' }, status: 'active' });
    expect(gAll.channels.map((c: any) => c.name)).toEqual(['Allgemein', 'Vorstellungsrunde', 'Ankündigungen']);
    expect(gAll.channels[2].admin_only).toBe(1);
    expect(gAll.url).toBe(`http://localhost/portal/${loc}/community/g/mastermind`);

    expect((await t.api.post('/api/community/groups', { name: 'X', access: { mode: 'courses', course_ids: ['fremd'] } })).status).toBe(400);
    gCourse = (await t.api.post('/api/community/groups', { name: 'Kurs-A-Gruppe', access: { mode: 'courses', course_ids: [courseA.id] } })).data;
    gTag = (await t.api.post('/api/community/groups', { name: 'Tag-Gruppe', access: { mode: 'tags', tags: ['community'] }, channels: [{ name: 'Talk' }] })).data;
    expect(gTag.channels).toHaveLength(1);

    expect((await t.api.patch(`/api/community/groups/${gAll.id}`, { settings: { levels: [{ points: 0 }, { points: 9 }, { points: 3 }] } })).status).toBe(400);
    expect((await t.api.patch(`/api/community/groups/${gAll.id}`, { settings: { level_unlocks: [{ level: 2, course_id: 'fremd' }] } })).status).toBe(400);

    // Channels: add, rename, reorder, delete with moving posts.
    const ch = (await t.api.post(`/api/community/groups/${gAll.id}/channels`, { name: 'Erfolge', emoji: '🏆', category: 'Austausch' })).data;
    expect(ch).toMatchObject({ slug: 'erfolge', position: 3 });
    const re = (await t.api.post(`/api/community/groups/${gAll.id}/channels/reorder`, { ids: [ch.id, ...gAll.channels.map((c: any) => c.id)] })).data;
    expect(re[0].name).toBe('Erfolge');
    expect((await t.api.post(`/api/community/groups/${gAll.id}/channels/reorder`, { ids: ['fremd'] })).status).toBe(400);
    expect((await t.api.del(`/api/community/groups/${gTag.id}/channels/${gTag.channels[0].id}`)).status).toBe(400);

    annaC = memberCookie(anna.id);
    benC = memberCookie(ben.id);
    caraC = memberCookie(cara.id);
    doraC = memberCookie(dora.id);
  });

  it('shows each member only the groups they have access to', async () => {
    const names = async (cookie: string) => {
      const r = await page(`/portal/${loc}`, cookie);
      return ['Mastermind', 'Kurs-A-Gruppe', 'Tag-Gruppe'].filter((n) => r.html.includes(`>${n}<`));
    };
    expect(await names(annaC)).toEqual(['Mastermind', 'Kurs-A-Gruppe']);
    expect(await names(benC)).toEqual(['Mastermind', 'Tag-Gruppe']);
    expect(await names(doraC)).toEqual(['Mastermind']);
    expect(await names(caraC)).toEqual([]);

    expect((await page(`${base()}/g/tag-gruppe`, annaC)).status).toBe(404);
    expect((await page(`${base()}/g/kurs-a-gruppe`, benC)).status).toBe(404);
    expect((await page(`${base()}/g/mastermind`, caraC)).status).toBe(404);
    expect((await page(`${base()}/g/mastermind`, '')).status).toBe(401);
    const home = await page(`${base()}/g/mastermind`, annaC);
    expect(home.status).toBe(200);
    expect(home.html).toContain('Schreib etwas');
    expect(home.html).toContain('<strong>alle</strong>'); // group description as Markdown
    expect(home.html).toContain('/portal-community.js');
    await settle();
    expect(events.filter((e) => e.type === 'community.member_joined').map((e) => e.data.contactId)).toEqual([anna.id]);

    // Revoked course access → the course group is gone (and "all" groups need some portal access).
    await t.api.del(`/api/courses/${courseB.id}/enrollments/${dora.id}`);
    expect((await page(`${base()}/g/mastermind`, doraC)).status).toBe(404);
    await t.api.post(`/api/courses/${courseB.id}/enrollments`, { contact_id: dora.id });

    // Archived groups disappear.
    await t.api.patch(`/api/community/groups/${gTag.id}`, { status: 'archived' });
    expect((await page(`${base()}/g/tag-gruppe`, benC)).status).toBe(404);
    await t.api.patch(`/api/community/groups/${gTag.id}`, { status: 'active' });

    // Another sub-account's portal knows nothing about these groups.
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data;
    expect((await page(`/portal/${other.id}/community/g/mastermind`, memberCookie(anna.id, other.id))).status).toBe(401);
  });

  it('lets community-only members (by tag) log in with the email link', async () => {
    const before = mails.length;
    await t.api.raw(`/portal/${loc}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=ben%40example.de' });
    expect(mails.length).toBe(before + 1);
    await t.api.raw(`/portal/${loc}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=cara%40example.de' });
    expect(mails.length).toBe(before + 1);
  });

  it('protects every form with a session token and the same-origin check', async () => {
    const action = `${base()}/g/mastermind/posts`;
    const ch = gAll.channels[0].id;
    expect((await post(action, { title: 'Ohne Token', channel_id: ch }, annaC)).status).toBe(403);
    const { html } = await page(`${base()}/g/mastermind`, annaC);
    expect((await post(action, { csrf: csrfOf(html), title: 'Fremde Seite', channel_id: ch }, annaC, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(action, { csrf: csrfOf(html), title: 'Fremde Sitzung', channel_id: ch }, benC)).status).toBe(403);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_posts')!.n).toBe(0);
  });

  it('posts with Markdown and images, everything escaped', async () => {
    const r = await submit(
      `${base()}/g/mastermind`,
      `${base()}/g/mastermind/posts`,
      [
        ['title', 'Hallo <script>alert(1)</script>'],
        ['body', 'Ich bin **neu** hier <img src=x onerror=alert(1)> ![pixel](https://evil.example/p.png)'],
        ['channel_id', gAll.channels[1].id],
        ['image', PNG],
      ],
      annaC,
    );
    expect(r.status).toBe(303);
    annaPost = r.headers.get('location')!.split('/p/')[1];
    const view = await page(`${base()}/g/mastermind/p/${annaPost}`, annaC);
    expect(view.html).toContain('Hallo &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(view.html).not.toContain('<script>alert');
    expect(view.html).not.toContain('<img src=x');
    expect(view.html).toContain('<strong>neu</strong>');
    expect(view.html).not.toContain('src="https://evil.example/p.png"');
    expect(view.html).toContain('href="https://evil.example/p.png"');
    const img = view.html.match(/src="(\/portal\/[^"]+\/community\/files\/[^"]+)"/)![1];
    const file = await get(img, benC);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect((await get(img, caraC)).status).toBe(404);
    expect((await get(img)).status).toBe(401);
    const csp = (await get(`${base()}/g/mastermind/p/${annaPost}`, annaC)).headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");

    // Disguised files are refused with a readable message.
    const bad = await submit(`${base()}/g/mastermind`, `${base()}/g/mastermind/posts`, [['title', 'Fake'], ['channel_id', gAll.channels[1].id], ['image', 'data:image/png;base64,' + Buffer.from('<html>').toString('base64')]], annaC);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Dateiinhalt passt nicht zum Bildtyp');
    // Team-only channel.
    const team = await submit(`${base()}/g/mastermind`, `${base()}/g/mastermind/posts`, { title: 'Ich will', channel_id: gAll.channels[2].id }, annaC);
    expect(team.status).toBe(403);
    await settle();
    expect(events.filter((e) => e.type === 'community.post_created')).toHaveLength(1);
    expect(events.find((e) => e.type === 'community.post_created')!.data).toMatchObject({ contactId: anna.id, groupId: gAll.id, postId: annaPost });
  });

  it('comments in threads of one level, likes, follows and notifies', async () => {
    const annaHandle = t.app.db.get('SELECT handle FROM community_profiles WHERE contact_id = ?', anna.id)!.handle;
    expect(annaHandle).toBe('anna-muster');
    const postPath = `${base()}/g/mastermind/p/${annaPost}`;
    let r = await submit(postPath, `${postPath}/comments`, { body: 'Willkommen! Frag @anna-muster ruhig alles.' }, benC);
    expect(r.status).toBe(303);
    const c1 = r.headers.get('location')!.split('#c-')[1];
    // Reply, then a reply to the reply: both end up under the first comment.
    r = await submit(postPath, `${postPath}/comments`, { body: 'Danke dir!', parent_id: c1 }, annaC);
    const c2 = r.headers.get('location')!.split('#c-')[1];
    await submit(postPath, `${postPath}/comments`, { body: 'Gern!', parent_id: c2 }, benC);
    const rows = t.app.db.all('SELECT * FROM community_comments WHERE post_id = ? ORDER BY created_at', annaPost);
    expect(rows.map((x) => x.parent_id)).toEqual([null, c1, c1]);
    expect(t.app.db.get('SELECT comment_count FROM community_posts WHERE id = ?', annaPost)!.comment_count).toBe(3);
    expect((await submit(postPath, `${postPath}/comments`, { body: '   ' }, benC)).status).toBe(400);

    const notes = t.app.db.all('SELECT kind, contact_id FROM community_notifications ORDER BY created_at');
    // Ben mentioned Anna (mention, not also "comment"); Anna's reply → Ben (reply); Ben's 2nd reply → Anna (reply).
    expect(notes).toEqual([
      { kind: 'mention', contact_id: anna.id },
      { kind: 'reply', contact_id: ben.id },
      { kind: 'reply', contact_id: anna.id },
    ]);

    // Likes: not on your own post; a like gives the author points; unlike takes them back.
    expect((await submit(postPath, `${postPath}/like`, {}, annaC)).status).toBe(400);
    r = await submit(postPath, `${postPath}/like`, { back: `${base()}/g/mastermind#post-${annaPost}` }, benC);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${base()}/g/mastermind#post-${annaPost}`);
    expect(t.app.db.get('SELECT like_count FROM community_posts WHERE id = ?', annaPost)!.like_count).toBe(1);
    const pts = () => t.app.db.get('SELECT COALESCE(SUM(points),0) AS n FROM community_points WHERE contact_id = ? AND group_id = ?', anna.id, gAll.id)!.n;
    expect(pts()).toBe(2 + 1 + 1); // post + comment + like
    await submit(postPath, `${postPath}/like`, { back: 'https://evil.example/' }, benC);
    expect(pts()).toBe(3);
    await submit(postPath, `${postPath}/like`, {}, benC);
    expect((await submit(postPath, `${base()}/g/mastermind/c/${c1}/like`, {}, annaC)).status).toBe(303);
    expect(t.app.db.get('SELECT like_count FROM community_comments WHERE id = ?', c1)!.like_count).toBe(1);

    // Dora follows the post and hears about new comments.
    await submit(postPath, `${postPath}/follow`, {}, doraC);
    await submit(postPath, `${postPath}/comments`, { body: 'Noch ein Gedanke' }, benC);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'comment'`, dora.id)!.n).toBe(1);

    // Bell in the top bar, list, open = read.
    const home = await page(`/portal/${loc}`, annaC);
    expect(home.html).toMatch(/Benachrichtigungen \(\d+ neu\)/);
    const list = await page(`${base()}/notifications`, annaC);
    expect(list.html).toContain('hat dich in einem Kommentar');
    const link = list.html.match(/href="(\/portal\/[^"]+\/community\/notifications\/[^"]+)"/)![1];
    const open = await get(link, annaC);
    expect(open.status).toBe(302);
    expect(open.headers.get('location')).toContain(`/p/${annaPost}#c-`);
    const read = await submit(`${base()}/notifications`, `${base()}/notifications/read`, {}, annaC);
    expect(read.status).toBe(303);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND read_at IS NULL', anna.id)!.n).toBe(0);
  });

  it('marks unread posts until they are opened', async () => {
    const r = await submit(`${base()}/g/mastermind`, `${base()}/g/mastermind/posts`, { title: 'Bens Frage', body: 'Wer hat Tipps?', channel_id: gAll.channels[0].id }, benC);
    const benPost = r.headers.get('location')!.split('/p/')[1];
    let feed = await page(`${base()}/g/mastermind`, annaC);
    const card = feed.html.split(`id="post-${benPost}"`)[1].split('</article>')[0];
    expect(card).toContain('cm-tag new');
    expect(feed.html).toMatch(/Alle Beiträge<span class="cm-n">\d+<\/span>/);
    await get(`${base()}/g/mastermind/p/${benPost}`, annaC);
    feed = await page(`${base()}/g/mastermind`, annaC);
    expect(feed.html.split(`id="post-${benPost}"`)[1].split('</article>')[0]).not.toContain('cm-tag new');
  });

  it('applies the word filter and rate limits', async () => {
    await t.api.patch(`/api/community/groups/${gTag.id}`, { settings: { word_filter: ['mist'], posts_per_hour: 2, comments_per_hour: 1 } });
    const g = `${base()}/g/tag-gruppe`;
    const ch = gTag.channels[0].id;
    let r = await submit(g, `${g}/posts`, { title: 'So ein Mist', body: 'Echt MIST heute', channel_id: ch }, benC);
    expect(r.status).toBe(303);
    const pid = r.headers.get('location')!.split('/p/')[1];
    expect(t.app.db.get('SELECT title, body FROM community_posts WHERE id = ?', pid)).toEqual({ title: 'So ein M***', body: 'Echt M*** heute' });
    await submit(g, `${g}/posts`, { title: 'Zweiter', channel_id: ch }, benC);
    r = await submit(g, `${g}/posts`, { title: 'Dritter', channel_id: ch }, benC);
    expect(r.status).toBe(429);
    expect(await r.text()).toContain('höchstens 2 Beiträge pro Stunde');
    await submit(`${g}/p/${pid}`, `${g}/p/${pid}/comments`, { body: 'eins' }, benC);
    expect((await submit(`${g}/p/${pid}`, `${g}/p/${pid}/comments`, { body: 'zwei' }, benC)).status).toBe(429);

    await t.api.patch(`/api/community/groups/${gTag.id}`, { settings: { filter_mode: 'block', posts_per_hour: 0 } });
    r = await submit(g, `${g}/posts`, { title: 'Mist', channel_id: ch }, benC);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('nicht erlaubt');
  });

  it('moderates: reports hide content, the team decides, bans keep members out', async () => {
    await t.api.patch(`/api/community/groups/${gAll.id}`, { settings: { auto_hide_reports: 2 } });
    const postPath = `${base()}/g/mastermind/p/${annaPost}`;
    expect((await submit(postPath, `${postPath}/report`, { reason: 'Spam' }, annaC)).status).toBe(400); // own post
    let r = await submit(postPath, `${postPath}/report`, { reason: 'Spam <b>' }, benC);
    expect(r.headers.get('location')).toContain('gemeldet=1');
    await submit(postPath, `${postPath}/report`, { reason: 'nochmal' }, benC); // counts once
    expect(t.app.db.get('SELECT status FROM community_posts WHERE id = ?', annaPost)!.status).toBe('visible');
    r = await submit(postPath, `${postPath}/report`, {}, doraC);
    expect(t.app.db.get('SELECT status FROM community_posts WHERE id = ?', annaPost)!.status).toBe('hidden');
    expect((await page(postPath, benC)).status).toBe(404);

    const reports = (await t.api.get('/api/community/reports')).data;
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ kind: 'post', target_id: annaPost, group_name: 'Mastermind' });
    expect(reports.find((x: any) => x.contact_id === ben.id).reason).toBe('Spam <b>');
    expect((await t.api.patch(`/api/community/reports/${reports[0].id}`, { action: 'dismiss' })).status).toBe(200);
    expect(t.app.db.get('SELECT status FROM community_posts WHERE id = ?', annaPost)!.status).toBe('visible');
    expect((await t.api.get('/api/community/reports')).data).toHaveLength(0);

    // Team: pin, hide, comment, delete a comment.
    expect((await t.api.patch(`/api/community/posts/${annaPost}`, { pinned: true })).data.pinned).toBe(1);
    const full = (await t.api.get(`/api/community/posts/${annaPost}`)).data;
    expect(full.comments.length).toBe(4);
    expect(full.images[0]).toMatch(/^\/api\/community\/files\//);
    expect((await t.api.raw(full.images[0], { headers: { cookie: t.api.cookie, 'x-location-id': loc } })).status).toBe(200);
    const reply = (await t.api.post(`/api/community/posts/${annaPost}/comments`, { body: 'Vom Team: willkommen!' })).data;
    expect(reply).toMatchObject({ contact_id: null, author_name: 'Chef' });
    expect((await page(postPath, benC)).html).toMatch(/Chef<\/strong><span class="cm-tag">Team<\/span>/);
    await t.api.patch(`/api/community/comments/${reply.id}`, { status: 'hidden' });
    expect((await page(postPath, benC)).html).not.toContain('Vom Team');
    await t.api.del(`/api/community/comments/${reply.id}`);

    // Ban with hidden content.
    const benPosts = () => t.app.db.get(`SELECT COUNT(*) AS n FROM community_posts WHERE contact_id = ? AND group_id = ? AND status = 'visible'`, ben.id, gAll.id)!.n;
    expect(benPosts()).toBe(1);
    await t.api.post(`/api/community/groups/${gAll.id}/members/${ben.id}/ban`, { reason: 'Spam', hide_content: true });
    expect(benPosts()).toBe(0);
    const banned = await page(`${base()}/g/mastermind`, benC);
    expect(banned.status).toBe(403);
    expect(banned.html).toContain('ausgeschlossen');
    const members = (await t.api.get(`/api/community/groups/${gAll.id}/members`)).data;
    expect(members.find((m: any) => m.contact_id === ben.id)).toMatchObject({ ban_reason: 'Spam' });
    await t.api.del(`/api/community/groups/${gAll.id}/members/${ben.id}/ban`);
    expect((await page(`${base()}/g/mastermind`, benC)).status).toBe(200);
  });

  it('awards points, raises levels, unlocks courses and fills the leaderboard', async () => {
    await t.api.patch(`/api/community/groups/${gCourse.id}`, {
      settings: { points: { post: 10, comment: 5, like: 3 }, levels: [{ name: 'Neu', points: 0 }, { name: 'Aktiv', points: 10 }, { name: 'Profi', points: 15 }], level_unlocks: [{ level: 3, course_id: courseB.id }] },
    });
    const wf = (await t.api.post('/api/workflows', { name: 'Level-Glückwunsch', trigger: { type: 'community.level_reached', config: { group_id: gCourse.id, level: '3' } }, steps: [{ type: 'add_tag', tags: ['profi'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const g = `${base()}/g/kurs-a-gruppe`;
    const ch = gCourse.channels[0].id;
    let r = await submit(g, `${g}/posts`, { title: 'Erster Beitrag', channel_id: ch }, annaC);
    const pid = r.headers.get('location')!.split('/p/')[1];
    await settle();
    expect(events.filter((e) => e.type === 'community.level_reached' && e.data.groupId === gCourse.id).map((e) => e.data.level)).toEqual([2]);
    r = await submit(`${g}/p/${pid}`, `${g}/p/${pid}/comments`, { body: 'Nachtrag' }, annaC);
    await settle();
    expect(events.filter((e) => e.type === 'community.level_reached' && e.data.groupId === gCourse.id).map((e) => e.data)).toEqual([
      expect.objectContaining({ level: 2, level_name: 'Aktiv', contactId: anna.id }),
      expect.objectContaining({ level: 3, level_name: 'Profi', contactId: anna.id }),
    ]);
    expect((await t.api.get(`/api/contacts/${anna.id}/courses`)).data.find((e: any) => e.course_id === courseB.id)).toMatchObject({ status: 'active', source: 'community', source_ref: gCourse.id });
    expect((await t.api.get(`/api/contacts/${anna.id}`)).data.tags).toContain('profi');
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE contact_id = ? AND kind = 'level'`, anna.id)!.n).toBe(2);

    const lb = (await t.api.get(`/api/community/groups/${gAll.id}/leaderboard?period=week`)).data;
    expect(lb.map((x: any) => x.contact_id)).toEqual(expect.arrayContaining([anna.id, ben.id]));
    expect(lb[0].rank).toBe(1);
    expect(lb[0].points).toBeGreaterThanOrEqual(lb[1].points);
    expect(lb.find((x: any) => x.contact_id === anna.id)).toMatchObject({ points: 4, display_name: 'Anna Muster', handle: 'anna-muster' });
    expect((await t.api.get(`/api/community/groups/${gAll.id}/leaderboard?period=year`)).status).toBe(400);
    // Old points drop out of the 7-day board but stay all-time.
    t.app.db.run('UPDATE community_points SET created_at = ? WHERE contact_id = ? AND group_id = ?', new Date(Date.now() - 10 * 864e5).toISOString(), ben.id, gAll.id);
    expect((await t.api.get(`/api/community/groups/${gAll.id}/leaderboard?period=week`)).data.find((x: any) => x.contact_id === ben.id)).toBeUndefined();
    expect((await t.api.get(`/api/community/groups/${gAll.id}/leaderboard?period=all`)).data.find((x: any) => x.contact_id === ben.id)).toBeTruthy();
    const board = await page(`${g}/leaderboard?period=all`, annaC);
    expect(board.html).toContain('Profi');
    expect(board.html).toContain('🥇');
    expect(board.html).toContain('🔓 Kurs B');

    // Deleting a post takes its points away.
    const before = t.app.db.get('SELECT SUM(points) AS n FROM community_points WHERE contact_id = ? AND group_id = ?', anna.id, gCourse.id)!.n;
    expect((await submit(`${g}/p/${pid}`, `${g}/p/${pid}/delete`, {}, annaC)).status).toBe(303);
    expect(t.app.db.get('SELECT COALESCE(SUM(points),0) AS n FROM community_points WHERE contact_id = ? AND group_id = ?', anna.id, gCourse.id)!.n).toBe(before - 15);
  });

  it('runs a group calendar', async () => {
    const start = new Date(Date.now() + 2 * 864e5).toISOString();
    expect((await t.api.post(`/api/community/groups/${gAll.id}/events`, { title: 'Q&A', starts_at: start, link: 'http://zoom.example' })).status).toBe(400);
    expect((await t.api.post(`/api/community/groups/${gAll.id}/events`, { title: 'Q&A', starts_at: start, ends_at: new Date(Date.now() + 864e5).toISOString() })).status).toBe(400);
    const e = (await t.api.post(`/api/community/groups/${gAll.id}/events`, { title: 'Live-Q&A <b>', starts_at: start, link: 'https://meet.jit.si/mastermind', description: 'Bring Fragen mit', notify: true })).data;
    expect(Date.parse(e.ends_at) - Date.parse(e.starts_at)).toBe(36e5);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE kind = 'event' AND group_id = ?`, gAll.id)!.n).toBeGreaterThan(0);
    const cal = await page(`${base()}/g/mastermind/events`, annaC);
    expect(cal.html).toContain('Live-Q&amp;A &lt;b&gt;');
    expect(cal.html).toContain('href="https://meet.jit.si/mastermind"');
    const ics = await get(`${base()}/g/mastermind/events/${e.id}/ics`, annaC);
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    expect(await ics.text()).toContain('SUMMARY:Live-Q&A <b>');
    expect((await page(`${base()}/g/mastermind`, annaC)).html).toContain('Nächste Termine');
    expect((await t.api.patch(`/api/community/events/${e.id}`, { title: 'Live-Q&A' })).data.title).toBe('Live-Q&A');
  });

  it('edits profiles with avatar and shows them to fellow members only', async () => {
    let r = await submit(`${base()}/profile`, `${base()}/profile`, { display_name: '<b>Hacker</b>', bio: '' }, annaC);
    expect(r.status).toBe(400);
    r = await submit(`${base()}/profile`, `${base()}/profile`, [['display_name', 'Anna M.'], ['bio', 'Coach aus Köln'], ['digest', '0'], ['avatar', PNG]], annaC);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Gespeichert');
    const pr = t.app.db.get('SELECT * FROM community_profiles WHERE contact_id = ?', anna.id)!;
    expect(pr).toMatchObject({ display_name: 'Anna M.', handle: 'anna-muster', digest: 0 });
    expect(pr.avatar_file_id).toBeTruthy();
    const view = await page(`${base()}/u/anna-muster`, benC);
    expect(view.html).toContain('Coach aus Köln');
    expect(view.html).not.toContain('anna@example.de');
    expect((await get(`${base()}/files/${pr.avatar_file_id}`, benC)).status).toBe(200);
    // Cara shares no group with Anna.
    expect((await page(`${base()}/u/anna-muster`, caraC)).status).toBe(404);
  });

  it('mails a daily digest of unread notifications', async () => {
    const digest = t.app.services.communityDigest as (at?: Date) => Promise<number>;
    t.app.db.run('UPDATE community_notifications SET read_at = NULL, emailed_at = NULL');
    mails.length = 0;
    const early = new Date();
    early.setUTCHours(3, 0, 0, 0); // 05:00 in Berlin – before 07:00
    expect(await digest(early)).toBe(0);
    const later = new Date(early.getTime() + 6 * 36e5);
    const n = await digest(later);
    expect(n).toBeGreaterThan(0);
    expect(mails.some((m) => m.to === 'anna@example.de')).toBe(false); // switched off in her profile
    const benMail = mails.find((m) => m.to === 'ben@example.de')!;
    expect(benMail.subject).toMatch(/Neuigkeit/);
    expect(benMail.text).toContain(`/portal/${loc}/community/notifications/`);
    // Once a day.
    t.app.db.run('UPDATE community_notifications SET emailed_at = NULL');
    expect(await digest(new Date(later.getTime() + 36e5))).toBe(0);
    await t.api.put('/api/community/settings', { digest_enabled: false });
    expect(await digest(new Date(later.getTime() + 864e5))).toBe(0);
    expect((await t.api.get('/api/community/settings')).data).toMatchObject({ digest_enabled: false, digest_hour: 7 });
  });

  it('offers MCP tools to list and write posts as the team', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const res = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return JSON.parse((await res.json()).result.content[0].text);
    };
    const created = await call('ghl_create_community_post', { location_id: loc, group_id: gAll.id, title: 'Neue Lektion online', body: 'Schaut rein, @anna-muster!', pinned: true, notify: true });
    expect(created).toMatchObject({ title: 'Neue Lektion online', by_team: true, pinned: 1, contact_id: null });
    const list = await call('ghl_list_community_posts', { location_id: loc, group_id: gAll.id, limit: 5 });
    expect(list[0]).toMatchObject({ id: created.id, group_name: 'Mastermind' });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM community_notifications WHERE post_id = ? AND kind IN ('announcement','mention')`, created.id)!.n).toBeGreaterThanOrEqual(3);
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.triggers).toEqual(expect.arrayContaining(['community.post_created', 'community.member_joined', 'community.level_reached']));
  });

  it('deletes a group with everything in it', async () => {
    expect((await t.api.del(`/api/community/groups/${gTag.id}`)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_posts WHERE group_id = ?', gTag.id)!.n).toBe(0);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM community_channels WHERE group_id = ?', gTag.id)!.n).toBe(0);
    expect((await t.api.get(`/api/community/groups/${gTag.id}`)).status).toBe(404);
  });
});
