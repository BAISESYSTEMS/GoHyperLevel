import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { memberGet, memberLogin, memberPost } from './creatordepth-helpers.js';
import { buildThreads, cleanRating, cleanText, ratingSummary, replyTarget, stars } from '../server/services/course-community.js';

describe('discussion rules', () => {
  const row = (id: string, parent: string | null, at: number, extra: Record<string, unknown> = {}) => ({ id, parent_id: parent, status: 'visible', created_at: new Date(at).toISOString(), ...extra });

  it('builds threads: newest question first, replies read downwards, hidden ones gone with their replies', () => {
    const rows = [row('a', null, 1000), row('b', null, 3000), row('a1', 'a', 2000), row('a2', 'a', 1500), row('a1x', 'a1', 2500), row('h', null, 4000, { status: 'hidden' }), row('h1', 'h', 4500)];
    const t = buildThreads(rows);
    expect(t.map((x) => x.id)).toEqual(['h1', 'b', 'a']);
    const a = t.find((x) => x.id === 'a')!;
    expect(a.replies.map((x) => x.id)).toEqual(['a2', 'a1']);
    expect(a.replies[1].replies.map((x) => x.id)).toEqual(['a1x']);
    expect(a.replies[1].replies[0].depth).toBe(3);
    // with hidden ones shown (moderation)
    expect(buildThreads(rows, { includeHidden: true }).map((x) => x.id)).toEqual(['h', 'b', 'a']);
  });

  it('keeps replies below the depth limit next to their parent, and survives a loop', () => {
    const rows = [row('1', null, 1), row('2', '1', 2), row('3', '2', 3), row('4', '3', 4), row('5', '4', 5)];
    const t = buildThreads(rows, { maxDepth: 3 });
    const r2 = t[0].replies[0];
    expect(r2.id).toBe('2');
    // 3 is the deepest level; 4 and 5 hang next to it
    expect(r2.replies.map((x) => x.id)).toEqual(['3', '4', '5']);
    expect(r2.replies.every((x) => x.replies.length === 0 && x.depth === 3)).toBe(true);
    const loop = [row('x', 'y', 1), row('y', 'x', 2)];
    expect(() => buildThreads(loop)).not.toThrow();
    expect(buildThreads(loop).length).toBeGreaterThan(0);
  });

  it('attaches a reply to the right comment', () => {
    const rows = [{ id: '1', parent_id: null }, { id: '2', parent_id: '1' }, { id: '3', parent_id: '2' }];
    expect(replyTarget(rows, '1')).toBe('1');
    expect(replyTarget(rows, '2')).toBe('2');
    expect(replyTarget(rows, '3')).toBe('2'); // depth 3 is the deepest: a reply to it sits next to it
    expect(replyTarget(rows, 'gibtsnicht')).toBe('gibtsnicht');
  });

  it('cleans member text', () => {
    expect(cleanText('  Hallo\r\n\r\n\r\n\r\nWelt​  ', 'x', { min: 2, max: 50 })).toBe('Hallo\n\nWelt');
    expect(() => cleanText('a', 'Kommentar', { min: 2, max: 50 })).toThrow(/bitte etwas schreiben/);
    expect(() => cleanText('x'.repeat(51), 'Kommentar', { max: 50 })).toThrow(/höchstens 50/);
    expect(cleanText('<b>fett</b>', 'x', { max: 50 })).toBe('<b>fett</b>');
  });

  it('summarises ratings', () => {
    expect(ratingSummary([5, 4, 4, 1, 9, 0, 'x' as any])).toEqual({ count: 4, average: 3.5, distribution: [1, 0, 0, 2, 1] });
    expect(ratingSummary([])).toEqual({ count: 0, average: 0, distribution: [0, 0, 0, 0, 0] });
    expect(cleanRating('4')).toBe(4);
    expect(() => cleanRating(6)).toThrow();
    expect(() => cleanRating(0)).toThrow();
    expect(stars(3.6)).toBe('★★★★☆');
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let course: any;
let l1: any;
let l2: any;
let annaId = '';
let benId = '';
let anna = '';
let ben = '';
const pushes: any[] = [];
const events: { type: string; data: any }[] = [];
const settle = () => t.app.events.flush();
const url = (l: any, rest = '') => `/portal/${loc}/c/${course.slug}/${l.id}${rest}`;
const courseUrl = (rest = '') => `/portal/${loc}/c/${course.slug}${rest}`;
const html = async (path: string, cookie: string) => (await memberGet(t, path, cookie)).text();
const comment = (cookie: string, body: string, parent = '', l = l1, headers: Record<string, string> = {}) => memberPost(t, url(l, '/comments'), { body, ...(parent ? { parent } : {}) }, cookie, headers);
const commentIds = () => t.app.db.all<{ id: string; author_name: string; parent_id: string | null }>('SELECT id, author_name, parent_id FROM course_comments ORDER BY created_at, id');

beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    loc = t.api.location;
    t.app.services.pushNotify = async (i: any) => void pushes.push(i);
    for (const type of ['course.comment_posted', 'course.review_posted']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
    course = (await t.api.post('/api/courses', { title: 'Diskussions-Kurs' })).data;
    await t.api.patch(`/api/courses/${course.id}`, { status: 'published' });
    const mod = (await t.api.get(`/api/courses/${course.id}`)).data.modules[0];
    l1 = (await t.api.get(`/api/courses/${course.id}`)).data.modules[0].lessons[0];
    l2 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Zweite Lektion' })).data;
    const l3 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod.id, title: 'Später', drip_days: 30 })).data;
    void l3;
    annaId = (await t.api.post(`/api/courses/${course.id}/enrollments`, { email: 'anna@example.de', name: 'Anna Muster' })).data.contact_id;
    benId = (await t.api.post(`/api/courses/${course.id}/enrollments`, { email: 'ben@example.de', name: 'Ben Beispiel' })).data.contact_id;
    anna = await memberLogin(t, annaId);
    ben = await memberLogin(t, benId);
}, 60_000);
afterAll(() => t.close());



describe('lesson discussion', () => {
  it('shows an empty discussion with a form', async () => {
    const h = await html(url(l1), anna);
    expect(h).toContain('id="diskussion"');
    expect(h).toContain('Fragen &amp; Diskussion');
    expect(h).toContain('Noch keine Kommentare');
    expect(h).toMatch(/<form method="post" action="[^"]*\/comments">/);
  });

  it('posts a comment (text only – markup is shown as text), tells the team and records it', async () => {
    const r = await comment(anna, 'Wie funktioniert das <b>genau</b>?\n<script>alert(1)</script>');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${url(l1)}?kommentar=ok#diskussion`);
    const h = await html(url(l1), ben);
    expect(h).toContain('Anna M.');
    expect(h).toContain('&lt;b&gt;genau&lt;/b&gt;');
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).not.toContain('Kursleitung</span>');
    await settle();
    expect(events.find((e) => e.type === 'course.comment_posted')?.data).toMatchObject({ contactId: annaId, courseId: course.id, lessonId: l1.id, staff: false });
    expect(pushes.find((p) => p.kind === 'courses')).toMatchObject({ locationId: loc, url: `/app/courses/${course.id}` });
    expect(pushes.find((p) => p.kind === 'courses').title).toContain('Diskussions-Kurs');
    const acts = (await t.api.get(`/api/contacts/${annaId}`)).data.activities;
    expect(JSON.stringify(acts)).toContain('Kommentar in');
  });

  it('threads replies and mails the person who was answered', async () => {
    const parent = commentIds()[0].id;
    expect((await comment(ben, 'Ich frage mich dasselbe, hat jemand eine Idee dazu?', parent)).status).toBe(303);
    const parentOfBen = commentIds()[1];
    expect(parentOfBen.parent_id).toBe(parent);
    const h = await html(url(l1), anna);
    expect(h).toContain('Ben B.');
    expect(h.indexOf('Anna M.')).toBeLessThan(h.indexOf('Ben B.'));
    expect(h).toContain('class="r"');
    await settle();
    await new Promise((r) => setTimeout(r, 60));
    const msgs = (await t.api.get(`/api/contacts/${annaId}/messages`)).data;
    expect(msgs.find((m: any) => m.subject?.includes('Neue Antwort auf deinen Kommentar'))?.body).toContain(`/portal/${loc}/c/${course.slug}/${l1.id}#diskussion`);
    // answering yourself tells nobody
    const before = (await t.api.get(`/api/contacts/${benId}/messages`)).data.length;
    await comment(ben, 'Und noch ein Nachtrag von mir', parentOfBen.id);
    await settle();
    expect((await t.api.get(`/api/contacts/${benId}/messages`)).data.length).toBe(before);
  });

  it('lets the team answer with a badge and a mail, and lists what still needs an answer', async () => {
    const open = (await t.api.get(`/api/courses/${course.id}/comments?needs_reply=1`)).data;
    expect(open.map((c: any) => c.author_name)).toEqual(['Anna M.']);
    const top = open[0];
    expect(top.lesson_title).toBe(l1.title);
    expect((await t.api.post(`/api/courses/${course.id}/comments`, { lesson_id: l1.id, parent_id: top.id, body: '' })).status).toBe(400);
    expect((await t.api.post(`/api/courses/${course.id}/comments`, { lesson_id: 'fremd', body: 'xx' })).status).toBe(404);
    const r = await t.api.post(`/api/courses/${course.id}/comments`, { lesson_id: l1.id, parent_id: top.id, body: 'Schau dir bitte Minute 3 im Video an.' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ staff: true, author_name: 'Chef' });
    expect((await t.api.get(`/api/courses/${course.id}/comments?needs_reply=1`)).data).toEqual([]);
    const h = await html(url(l1), anna);
    expect(h).toContain('<span class="badge">Kursleitung</span>');
    expect(h).toContain('Schau dir bitte Minute 3 im Video an.');
    await settle();
    await new Promise((r) => setTimeout(r, 60));
    const msgs = (await t.api.get(`/api/contacts/${annaId}/messages`)).data.filter((m: any) => m.subject?.includes('Neue Antwort'));
    expect(msgs.length).toBe(2);
    // the team edits its own answer – not a member's comment
    expect((await t.api.patch(`/api/courses/${course.id}/comments/${r.data.id}`, { body: 'Schau dir Minute 4 an.' })).data.body).toBe('Schau dir Minute 4 an.');
    expect((await t.api.patch(`/api/courses/${course.id}/comments/${top.id}`, { body: 'gefälscht' })).status).toBe(400);
    expect((await t.api.get(`/api/courses/${course.id}/comments?q=Minute`)).data).toHaveLength(1);
  });

  it('hides a comment from members (moderation) and shows it again', async () => {
    const [first] = commentIds().filter((c) => !c.parent_id);
    expect((await t.api.patch(`/api/courses/${course.id}/comments/${first.id}`, { status: 'hidden' })).data.status).toBe('hidden');
    expect(await html(url(l1), ben)).not.toContain('Wie funktioniert das');
    expect((await t.api.get(`/api/courses/${course.id}/comments?status=hidden`)).data).toHaveLength(1);
    expect((await t.api.patch(`/api/courses/${course.id}/comments/${first.id}`, { status: 'kaputt' })).status).toBe(400);
    await t.api.patch(`/api/courses/${course.id}/comments/${first.id}`, { status: 'visible' });
    expect(await html(url(l1), ben)).toContain('Wie funktioniert das');
  });

  it('lets members delete their own comments (and what hangs below), nobody else’s', async () => {
    const [first] = commentIds().filter((c) => !c.parent_id);
    await memberPost(t, url(l1, `/comments/${first.id}/delete`), {}, ben);
    expect(commentIds().some((c) => c.id === first.id)).toBe(true);
    await memberPost(t, url(l1, `/comments/${first.id}/delete`), {}, anna);
    expect(commentIds()).toHaveLength(0);
  });

  it('checks input, rate and who may write', async () => {
    const empty = await comment(anna, ' ');
    expect(empty.headers.get('location')).toContain('kommentar=leer');
    const long = await comment(anna, 'x'.repeat(2001));
    expect(long.headers.get('location')).toContain('kommentar=zulang');
    expect(await html(url(l1), anna)).not.toContain('kommentar=leer');
    expect(await (await memberGet(t, `${url(l1)}?kommentar=zulang`, anna)).text()).toContain('zu lang');
    // a lesson that is not open yet, a foreign origin, no login
    const later = t.app.db.get<any>(`SELECT id FROM course_lessons WHERE title = 'Später'`);
    expect((await comment(anna, 'zu früh', '', { id: later.id })).status).toBe(404);
    expect((await comment(anna, 'fremd', '', l1, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(404);
    expect((await comment('', 'anonym')).status).toBe(303);
    expect(commentIds()).toHaveLength(0);
    let limited = 0;
    for (let i = 0; i < 14; i++) if ((await comment(anna, `Kommentar ${i}`)).headers.get('location')?.includes('zuviele')) limited++;
    expect(limited).toBeGreaterThanOrEqual(2);
    t.app.db.run('DELETE FROM course_comments');
  });

  it('is switched off with the course setting', async () => {
    const off = await t.api.patch(`/api/courses/${course.id}`, { settings: { comments_enabled: false } });
    expect(off.data.settings).toMatchObject({ comments_enabled: false, reviews_enabled: true, reviews_moderation: true, reviews_min_percent: 30, cohort_mode: 'off' });
    expect(await html(url(l1), anna)).not.toContain('id="diskussion"');
    expect((await comment(anna, 'trotzdem')).status).toBe(404);
    await t.api.patch(`/api/courses/${course.id}`, { settings: { comments_enabled: true } });
    expect(await html(url(l1), anna)).toContain('id="diskussion"');
  });
});

describe('ratings and reviews', () => {
  const review = (cookie: string, data: Record<string, string>) => memberPost(t, courseUrl('/review'), data, cookie);
  const done = (cookie: string, l: any) => memberPost(t, url(l, '/complete'), { done: '1' }, cookie);

  it('opens the review form only after the set share of the course', async () => {
    let h = await html(courseUrl(), anna);
    expect(h).toContain('id="bewertungen"');
    expect(h).toContain('Noch keine Bewertungen.');
    expect(h).toContain('sobald du 30 % geschafft hast');
    expect((await review(anna, { rating: '5' })).status).toBe(404);
    await done(anna, l1);
    h = await html(courseUrl(), anna);
    expect(h).toContain('Bewerte diesen Kurs');
    expect(h).toContain('name="rating"');
  });

  it('holds a review for the team, then shows it with the team’s answer', async () => {
    expect((await review(anna, { rating: '0' })).headers.get('location')).toContain('bewertung=fehler');
    expect((await review(anna, { rating: '6' })).headers.get('location')).toContain('bewertung=fehler');
    const ok = await review(anna, { rating: '5', title: 'Sehr gut', body: 'Klar erklärt <i>und</i> praktisch.' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toContain('bewertung=ok#bewertungen');
    let h = await html(courseUrl(), anna);
    expect(h).toContain('wartet auf die Freigabe');
    expect(await html(courseUrl(), ben)).not.toContain('Sehr gut');
    await settle();
    expect(events.find((e) => e.type === 'course.review_posted')?.data).toMatchObject({ contactId: annaId, rating: 5, status: 'pending' });
    const list = (await t.api.get(`/api/courses/${course.id}/reviews`)).data;
    expect(list.pending).toBe(1);
    expect(list.summary.count).toBe(0);
    const r = list.reviews[0];
    expect(r).toMatchObject({ rating: 5, status: 'pending', author_name: 'Anna M.', email: 'anna@example.de' });
    expect((await t.api.patch(`/api/courses/${course.id}/reviews/${r.id}`, { status: 'kaputt' })).status).toBe(400);
    const pub = await t.api.patch(`/api/courses/${course.id}/reviews/${r.id}`, { status: 'published', reply: 'Danke dir, Anna!' });
    expect(pub.data).toMatchObject({ status: 'published', reply: 'Danke dir, Anna!' });
    h = await html(courseUrl(), ben);
    expect(h).toContain('Sehr gut');
    expect(h).toContain('Klar erklärt &lt;i&gt;und&lt;/i&gt; praktisch.');
    expect(h).toContain('Antwort der Kursleitung');
    expect(h).toContain('Danke dir, Anna!');
    expect(h).toContain('<b>5</b>');
    expect(h).toContain('1 Bewertung');
    expect((await t.api.get(`/api/courses/${course.id}/reviews`)).data.summary).toMatchObject({ count: 1, average: 5 });
  });

  it('puts a changed review back to moderation – unless moderation is off', async () => {
    await review(anna, { rating: '4', title: 'Doch nur gut' });
    expect((await t.api.get(`/api/courses/${course.id}/reviews?status=pending`)).data.reviews).toHaveLength(1);
    expect(t.app.db.all('SELECT * FROM course_reviews')).toHaveLength(1);
    await t.api.patch(`/api/courses/${course.id}`, { settings: { reviews_moderation: false, reviews_min_percent: 0 } });
    // Ben may review at once and is published at once
    await review(ben, { rating: '3', body: 'Okay.' });
    const mine = t.app.db.get<any>('SELECT status, rating FROM course_reviews WHERE contact_id = ?', benId);
    expect(mine).toEqual({ status: 'published', rating: 3 });
    expect((await t.api.get(`/api/courses/${course.id}/reviews`)).data.summary).toMatchObject({ count: 1, average: 3 });
    // reviews off
    await t.api.patch(`/api/courses/${course.id}`, { settings: { reviews_enabled: false } });
    expect(await html(courseUrl(), ben)).not.toContain('id="bewertungen"');
    expect((await review(ben, { rating: '1' })).status).toBe(404);
    await t.api.patch(`/api/courses/${course.id}`, { settings: { reviews_enabled: true } });
  });

  it('lets members take their review back and the team delete one', async () => {
    await memberPost(t, courseUrl('/review/delete'), {}, ben);
    expect(t.app.db.get('SELECT 1 FROM course_reviews WHERE contact_id = ?', benId)).toBeUndefined();
    const id = t.app.db.get<any>('SELECT id FROM course_reviews').id;
    expect((await t.api.del(`/api/courses/${course.id}/reviews/${id}`)).status).toBe(200);
    expect((await t.api.del(`/api/courses/${course.id}/reviews/${id}`)).status).toBe(404);
  });
});

describe('learning paths', () => {
  let a: any;
  let b: any;
  let c: any;
  let path: any;
  let cara = '';
  let caraId = '';
  const mkCourse = async (title: string, lessons = 2) => {
    const co = (await t.api.post('/api/courses', { title })).data;
    await t.api.patch(`/api/courses/${co.id}`, { status: 'published' });
    const full = (await t.api.get(`/api/courses/${co.id}`)).data;
    const mod = full.modules[0];
    const ls = [full.modules[0].lessons[0]];
    for (let i = 1; i < lessons; i++) ls.push((await t.api.post(`/api/courses/${co.id}/lessons`, { module_id: mod.id, title: `${title} ${i + 1}` })).data);
    return { ...co, lessons: ls };
  };
  const lessonPage = (co: any, l: any, cookie: string) => html(`/portal/${loc}/c/${co.slug}/${l.id}`, cookie);
  const finish = async (co: any, cookie: string) => {
    for (const l of co.lessons) await memberPost(t, `/portal/${loc}/c/${co.slug}/${l.id}/complete`, { done: '1' }, cookie);
  };

  beforeAll(async () => {
    a = await mkCourse('Pfad A');
    b = await mkCourse('Pfad B');
    c = await mkCourse('Pfad C');
  });

  it('builds a path with checks', async () => {
    expect((await t.api.post('/api/courses/paths', { title: 'Mit fremdem Kurs', items: ['gibtsnicht'] })).status).toBe(400);
    expect((await t.api.post('/api/courses/paths', { title: '' })).status).toBe(400);
    expect((await t.api.post('/api/courses/paths', { title: 'Mit Produkt', access: { product_ids: ['gibtsnicht'] } })).status).toBe(400);
    const r = await t.api.post('/api/courses/paths', { title: 'Komplettausbildung', description: 'A, dann B', items: [a.id, b.id] });
    expect(r.status).toBe(200);
    path = r.data;
    expect(path).toMatchObject({ slug: 'komplettausbildung', status: 'draft', sequential: true, unlock_percent: 100, members: 0 });
    expect(path.items.map((i: any) => i.title)).toEqual(['Pfad A', 'Pfad B']);
    expect(path.access.tags).toEqual(['pfad:komplettausbildung']);
    expect((await t.api.get('/api/courses/paths')).data.map((p: any) => p.id)).toContain(path.id);
    expect((await t.api.get(`/api/courses/paths/${path.id}`)).data.items).toHaveLength(2);
    expect((await t.api.post('/api/courses/paths', { title: 'Komplettausbildung' })).data.slug).toBe('komplettausbildung-2');
    await t.api.patch(`/api/courses/paths/${path.id}`, { status: 'published' });
  });

  it('grants every course and locks the next one until the one before is done', async () => {
    const r = await t.api.post(`/api/courses/paths/${path.id}/members`, { email: 'cara@example.de', name: 'Cara' });
    expect(r.status).toBe(200);
    caraId = r.data.contact_id;
    expect(r.data.changed).toBe(true);
    expect((await t.api.post(`/api/courses/paths/${path.id}/members`, { contact_id: caraId })).data.changed).toBe(false);
    const sources = t.app.db.all<any>('SELECT course_id, source, source_ref FROM course_enrollments WHERE contact_id = ?', caraId);
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.source === 'path' && s.source_ref === path.id)).toBe(true);
    cara = await memberLogin(t, caraId);
    // A is open, B says why it is closed
    expect(await lessonPage(a, a.lessons[0], cara)).toContain(`<h1>${a.lessons[0].title}</h1>`);
    const locked = await lessonPage(b, b.lessons[0], cara);
    expect(locked).toContain('Noch nicht freigeschaltet');
    expect(locked).toContain('Schließe zuerst den Kurs „Pfad A“ ab (0 % von 100 %).');
    // the start page shows the path
    const home = await html(`/portal/${loc}`, cara);
    expect(home).toContain('Deine Lernpfade');
    expect(home).toContain('Komplettausbildung');
    expect(home).toContain('0 von 2 Kursen abgeschlossen · der Reihe nach');
    expect(home).toContain('class="s locked"');
    // finishing A opens B
    await finish(a, cara);
    expect(await lessonPage(b, b.lessons[0], cara)).not.toContain('Noch nicht freigeschaltet');
    expect(await html(`/portal/${loc}`, cara)).toContain('1 von 2 Kursen abgeschlossen');
  });

  it('knows who stands where and when somebody finished the path', async () => {
    const seen: string[] = [];
    t.app.events.on('course.path_completed', (e) => void seen.push(e.data.pathId));
    await finish(b, cara);
    await t.app.events.flush();
    expect(seen).toEqual([path.id]);
    const members = (await t.api.get(`/api/courses/paths/${path.id}/members`)).data;
    expect(members[0]).toMatchObject({ contact_id: caraId, percent: 100, email: 'cara@example.de' });
    expect(members[0].completed_at).toBeTruthy();
    expect(members[0].steps.map((s: any) => s.state)).toEqual(['done', 'done']);
    expect((await t.api.get(`/api/courses/paths/${path.id}`)).data.completed).toBe(1);
  });

  it('applies an unlock share, does not lock people who own a course on their own, and a free order locks nothing', async () => {
    const free = (await t.api.post('/api/courses/paths', { title: 'Freier Pfad', items: [a.id, c.id], sequential: false })).data;
    await t.api.patch(`/api/courses/paths/${free.id}`, { status: 'published' });
    const dan = (await t.api.post(`/api/courses/paths/${free.id}/members`, { email: 'dan@example.de' })).data.contact_id;
    const danCookie = await memberLogin(t, dan);
    expect(await lessonPage(c, c.lessons[0], danCookie)).not.toContain('Noch nicht freigeschaltet');
    // 50 %: C opens after one of two lessons of A
    const half = (await t.api.post('/api/courses/paths', { title: 'Halbzeit', items: [a.id, c.id], unlock_percent: 50 })).data;
    await t.api.patch(`/api/courses/paths/${half.id}`, { status: 'published' });
    const eva = (await t.api.post(`/api/courses/paths/${half.id}/members`, { email: 'eva@example.de' })).data.contact_id;
    const evaCookie = await memberLogin(t, eva);
    expect(await lessonPage(c, c.lessons[0], evaCookie)).toContain('Schließe zuerst den Kurs „Pfad A“ ab (0 % von 50 %).');
    await memberPost(t, `/portal/${loc}/c/${a.slug}/${a.lessons[0].id}/complete`, { done: '1' }, evaCookie);
    expect(await lessonPage(c, c.lessons[0], evaCookie)).not.toContain('Noch nicht freigeschaltet');
    // owns C on its own → never sequenced
    const fay = (await t.api.post(`/api/courses/${c.id}/enrollments`, { email: 'fay@example.de' })).data.contact_id;
    await t.api.post(`/api/courses/paths/${half.id}/members`, { contact_id: fay });
    const fayCookie = await memberLogin(t, fay);
    expect(await lessonPage(c, c.lessons[0], fayCookie)).not.toContain('Noch nicht freigeschaltet');
    // taking the path away takes the path's courses, not the own one
    expect((await t.api.del(`/api/courses/paths/${half.id}/members/${fay}`)).status).toBe(200);
    expect(t.app.db.get<any>('SELECT status FROM course_enrollments WHERE contact_id = ? AND course_id = ?', fay, c.id).status).toBe('active');
    expect(t.app.db.get<any>('SELECT status FROM course_enrollments WHERE contact_id = ? AND course_id = ?', fay, a.id).status).toBe('revoked');
    expect((await t.api.del(`/api/courses/paths/${half.id}/members/${fay}`)).status).toBe(404);
  });

  it('grants by tag, by purchase – published paths only – and takes tag access back', async () => {
    const tag = 'pfad:komplettausbildung';
    const gus = (await t.api.post('/api/contacts', { email: 'gus@example.de', tags: [tag] })).data;
    await t.app.events.flush();
    const rows = () => t.app.db.all<any>('SELECT * FROM course_path_members WHERE contact_id = ?', gus.id);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ source: 'tag', source_ref: tag });
    await t.api.post(`/api/contacts/${gus.id}/tags`, { remove: [tag] });
    await t.app.events.flush();
    expect(rows()).toHaveLength(0);
    expect(t.app.db.get<any>('SELECT status FROM course_enrollments WHERE contact_id = ? AND course_id = ?', gus.id, a.id).status).toBe('revoked');
    // a draft path is not handed out automatically
    await t.api.patch(`/api/courses/paths/${path.id}`, { status: 'draft' });
    await t.api.post(`/api/contacts/${gus.id}/tags`, { add: [tag] });
    await t.app.events.flush();
    expect(rows()).toHaveLength(0);
    await t.api.patch(`/api/courses/paths/${path.id}`, { status: 'published' });
    // purchase
    const prod = (await t.api.post('/api/products', { name: 'Ausbildung', price_cents: 49900 })).data;
    expect((await t.api.patch(`/api/courses/paths/${path.id}`, { access: { product_ids: [prod.id] } })).status).toBe(200);
    const hal = (await t.api.post('/api/contacts', { email: 'hal@example.de' })).data;
    t.app.events.emit(loc, 'product.purchased', { contactId: hal.id, productId: prod.id });
    await t.app.events.flush();
    expect(t.app.db.get<any>('SELECT source, source_ref FROM course_path_members WHERE contact_id = ?', hal.id)).toEqual({ source: 'purchase', source_ref: prod.id });
    // a newly added tag picks up contacts that already carry it
    const ida = (await t.api.post('/api/contacts', { email: 'ida@example.de', tags: ['vip-pfad'] })).data;
    await t.app.events.flush();
    const sync = await t.api.patch(`/api/courses/paths/${path.id}`, { access: { tags: [tag, 'vip-pfad'] } });
    expect(sync.data.synced).toBe(1);
    expect(t.app.db.get('SELECT 1 FROM course_path_members WHERE contact_id = ?', ida.id)).toBeTruthy();
  });

  it('gives a course added later to the people who are already on the path, and refuses an empty path', async () => {
    const before = t.app.db.all('SELECT 1 FROM course_enrollments WHERE course_id = ? AND source = ?', c.id, 'path').length;
    await t.api.patch(`/api/courses/paths/${path.id}`, { items: [a.id, b.id, c.id] });
    const after = t.app.db.all('SELECT 1 FROM course_enrollments WHERE course_id = ? AND source = ?', c.id, 'path').length;
    expect(after).toBeGreaterThan(before);
    const empty = (await t.api.post('/api/courses/paths', { title: 'Leer' })).data;
    expect((await t.api.post(`/api/courses/paths/${empty.id}/members`, { email: 'leer@example.de' })).status).toBe(400);
    expect((await t.api.del(`/api/courses/paths/${empty.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/courses/paths/${empty.id}`)).status).toBe(404);
  });
});
