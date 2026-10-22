import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { cleanAccess, computeProgress, isUnlocked, unlockAt } from '../server/services/courses.js';
import { triggerMatches } from '../server/services/workflow-engine.js';
import { requiredPermission } from '../server/core/permissions.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const mails: { to: string; subject: string; text: string }[] = [];
const events: { type: string; data: any }[] = [];
const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%test\n').toString('base64');

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.memberMailer = async (_loc: any, mail: any) => {
    mails.push(mail);
    return { status: 'sent' };
  };
  for (const type of ['course.enrolled', 'course.started', 'lesson.completed', 'course.completed', 'course.access_revoked']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  await t.close();
});

const settle = () => t.app.events.flush();
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const portalPost = (path: string, data: Record<string, string>, cookie = '') =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: form(data) });
const portalGet = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const linkFrom = (text: string) => new URL(text.match(/https?:\/\/\S+\/auth\?token=\S+/)![0]);

describe('course logic', () => {
  it('computes drip dates and progress', () => {
    expect(unlockAt('2026-10-01T10:00:00.000Z', 0, 0).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(unlockAt('2026-10-01T10:00:00.000Z', 2, 7).toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(unlockAt('2026-10-01T10:00:00.000Z', 5, 1).toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(isUnlocked('2026-10-01T10:00:00.000Z', 0, 3, new Date('2026-10-03T10:00:00Z'))).toBe(false);
    expect(isUnlocked('2026-10-01T10:00:00.000Z', 0, 3, new Date('2026-10-04T10:00:00Z'))).toBe(true);
    expect(computeProgress(['a', 'b', 'c'], ['a', 'x'])).toEqual({ done: 1, total: 3, percent: 33 });
    expect(computeProgress(['a', 'b'], ['a', 'b'])).toEqual({ done: 2, total: 2, percent: 100 });
    expect(computeProgress([], ['a'])).toEqual({ done: 0, total: 0, percent: 0 });
    expect(cleanAccess({ tags: [' kurs:a ', 'kurs:a', ''], product_ids: 'x' })).toMatchObject({ tags: ['kurs:a'], product_ids: [], revoke_on_tag_removal: true, welcome_email: false });
  });

  it('maps routes and triggers', () => {
    expect(requiredPermission('GET', '/api/courses')).toBeUndefined();
    expect(requiredPermission('GET', '/api/courses/abc')).toBe('courses');
    expect(requiredPermission('POST', '/api/courses')).toBe('courses');
    expect(triggerMatches({ type: 'lesson.completed', config: { course_id: 'c1' } }, { type: 'lesson.completed', locationId: 'l', at: '', data: { courseId: 'c1' } })).toBe(true);
    expect(triggerMatches({ type: 'lesson.completed', config: { course_id: 'c1' } }, { type: 'lesson.completed', locationId: 'l', at: '', data: { courseId: 'c2' } })).toBe(false);
    expect(triggerMatches({ type: 'course.completed', config: {} }, { type: 'course.completed', locationId: 'l', at: '', data: { courseId: 'c2' } })).toBe(true);
  });
});

describe('courses', () => {
  let course: any;
  let mod1: any;
  let l1: any;
  let l2: any;
  let l3: any;
  let anna: any;
  let cookie = '';

  it('builds a course with modules and lessons', async () => {
    const r = await t.api.post('/api/courses', { title: 'Social Media Kickstart', description: 'In 4 Wochen zu mehr Reichweite.' });
    expect(r.status).toBe(200);
    course = r.data;
    expect(course).toMatchObject({ slug: 'social-media-kickstart', status: 'draft', modules: 1, lessons: 1, members: 0 });
    expect(course.access.tags).toEqual(['kurs:social-media-kickstart']);
    expect((await t.api.post('/api/courses', { title: 'Social Media Kickstart' })).data.slug).toBe('social-media-kickstart-2');

    const full = (await t.api.get(`/api/courses/${course.id}`)).data;
    mod1 = full.modules[0];
    l1 = mod1.lessons[0];
    expect(l1.title).toBe('Willkommen');
    const mod2 = (await t.api.post(`/api/courses/${course.id}/modules`, { title: 'Woche 2', drip_days: 7 })).data;
    l2 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod1.id, title: 'Dein Profil', video_url: 'https://youtu.be/dQw4w9WgXcQ', duration_min: 12 })).data;
    l3 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod2.id, title: 'Content-Plan', body: '## Plan\n\n- Montag: Reel' })).data;
    expect((await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: mod1.id, title: 'x', video_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: 'fremd', title: 'x' })).status).toBe(404);

    // Downloads must be uploads of this sub-account.
    const up = (await t.api.post('/api/uploads', { name: 'Checkliste.pdf', data: PDF })).data;
    expect((await t.api.patch(`/api/courses/${course.id}/lessons/${l2.id}`, { downloads: [{ upload_id: 'gibtsnicht' }] })).status).toBe(400);
    const withFile = (await t.api.patch(`/api/courses/${course.id}/lessons/${l2.id}`, { downloads: [{ upload_id: up.id }] })).data;
    expect(withFile.downloads).toEqual([{ upload_id: up.id, name: 'Checkliste.pdf' }]);

    // Reorder: "Dein Profil" first.
    const re = (await t.api.post(`/api/courses/${course.id}/reorder`, { modules: [{ id: mod1.id, lessons: [l2.id, l1.id] }, { id: mod2.id, lessons: [l3.id] }] })).data;
    expect(re.modules[0].lessons.map((l: any) => l.title)).toEqual(['Dein Profil', 'Willkommen']);
    expect((await t.api.post(`/api/courses/${course.id}/reorder`, { modules: [{ id: 'fremd', lessons: [] }] })).status).toBe(400);

    const prev = await t.api.post(`/api/courses/${course.id}/lessons/${l3.id}/preview`, { title: 'Content-Plan (neu)' });
    expect(prev.data).toContain('Content-Plan (neu)');
    expect(prev.data).toContain('<h2>Plan</h2>');
  });

  it('grants access manually, by API and lets you revoke it', async () => {
    const r = await t.api.post(`/api/courses/${course.id}/enrollments`, { email: 'Anna@Example.de', name: 'Anna Muster' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'active', source: 'manual', changed: 'created' });
    anna = (await t.api.get('/api/contacts?q=anna')).data.contacts[0];
    expect(anna.email).toBe('anna@example.de');
    await settle();
    expect(events.find((e) => e.type === 'course.enrolled')?.data).toMatchObject({ contactId: anna.id, courseId: course.id, source: 'manual' });
    expect((await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: anna.id })).data.changed).toBeNull();

    const mine = (await t.api.get(`/api/contacts/${anna.id}/courses`)).data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ course_title: 'Social Media Kickstart', status: 'active', progress: { done: 0, total: 3, percent: 0 } });

    expect((await t.api.del(`/api/courses/${course.id}/enrollments/${anna.id}`)).status).toBe(200);
    expect((await t.api.get(`/api/contacts/${anna.id}/courses`)).data[0].status).toBe('revoked');
    expect((await t.api.del(`/api/courses/${course.id}/enrollments/${anna.id}`)).status).toBe(404);
    expect((await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: anna.id })).data.changed).toBe('reactivated');
    expect((await t.api.post(`/api/courses/${course.id}/enrollments`, { email: 'kaputt' })).status).toBe(400);
  });

  it('grants and takes access by tag', async () => {
    const ben = (await t.api.post('/api/contacts', { email: 'ben@example.de', first_name: 'Ben' })).data;
    await t.api.post(`/api/contacts/${ben.id}/tags`, { add: ['kurs:social-media-kickstart'] });
    await settle();
    let list = (await t.api.get(`/api/courses/${course.id}/enrollments`)).data;
    expect(list.find((e: any) => e.contact_id === ben.id)).toMatchObject({ status: 'active', source: 'tag', source_ref: 'kurs:social-media-kickstart' });
    await t.api.post(`/api/contacts/${ben.id}/tags`, { remove: ['kurs:social-media-kickstart'] });
    await settle();
    list = (await t.api.get(`/api/courses/${course.id}/enrollments`)).data;
    expect(list.find((e: any) => e.contact_id === ben.id).status).toBe('revoked');
    // Manual access is not touched by tag removal.
    await t.api.post(`/api/contacts/${anna.id}/tags`, { add: ['kurs:social-media-kickstart'] });
    await settle();
    await t.api.post(`/api/contacts/${anna.id}/tags`, { remove: ['kurs:social-media-kickstart'] });
    await settle();
    expect((await t.api.get(`/api/contacts/${anna.id}/courses`)).data[0].status).toBe('active');

    // A new access tag picks up contacts that already have it.
    const cara = (await t.api.post('/api/contacts', { email: 'cara@example.de', tags: ['kauf:kickstart'] })).data;
    await settle();
    const p = (await t.api.patch(`/api/courses/${course.id}`, { access: { tags: ['kurs:social-media-kickstart', 'kauf:kickstart'] } })).data;
    expect(p.synced).toBe(1);
    await settle();
    expect((await t.api.get(`/api/contacts/${cara.id}/courses`)).data[0]).toMatchObject({ status: 'active', source: 'tag' });
  });

  it('grants access on product purchase and from workflows', async () => {
    const prod = (await t.api.post('/api/products', { name: 'Kickstart-Kurs', price_cents: 19900 })).data;
    expect((await t.api.patch(`/api/courses/${course.id}`, { access: { product_ids: ['fremd'] } })).status).toBe(400);
    await t.api.patch(`/api/courses/${course.id}`, { access: { product_ids: [prod.id] } });
    const dora = (await t.api.post('/api/contacts', { email: 'dora@example.de' })).data;
    t.app.events.emit(t.api.location, 'product.purchased', { contactId: dora.id, productId: prod.id });
    await settle();
    expect((await t.api.get(`/api/contacts/${dora.id}/courses`)).data[0]).toMatchObject({ status: 'active', source: 'purchase', source_ref: prod.id });

    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.steps).toEqual(expect.arrayContaining(['course_grant', 'course_revoke']));
    expect(meta.triggers).toEqual(expect.arrayContaining(['course.enrolled', 'course.started', 'lesson.completed', 'course.completed']));
    const wf = (await t.api.post('/api/workflows', { name: 'VIP bekommt Kurs', trigger: { type: 'contact.tag_added', config: { tag: 'vip' } }, steps: [{ type: 'course_grant', course_id: course.id }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const emil = (await t.api.post('/api/contacts', { email: 'emil@example.de', tags: ['vip'] })).data;
    await settle();
    const e = (await t.api.get(`/api/contacts/${emil.id}/courses`)).data[0];
    expect(e).toMatchObject({ status: 'active', source: 'workflow', source_ref: wf.id });
    const runs = (await t.api.get(`/api/workflows/${wf.id}/runs`)).data.runs;
    expect(runs[0].log[0].result).toContain('Zugang zu „Social Media Kickstart“ gegeben');
  });

  it('sends the welcome email when switched on', async () => {
    await t.api.patch(`/api/courses/${course.id}`, { access: { welcome_email: true } });
    const fritz = (await t.api.post('/api/contacts', { email: 'fritz@example.de', first_name: 'Fritz', dnd: true })).data;
    await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: fritz.id });
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    const msgs = (await t.api.get(`/api/contacts/${fritz.id}/messages`)).data;
    expect(msgs[0].subject).toBe('Dein Zugang zu „Social Media Kickstart“');
    expect(msgs[0].body).toContain(`http://localhost/portal/${t.api.location}`);
    expect(msgs[0].status).toBe('logged');
    await t.api.patch(`/api/courses/${course.id}`, { access: { welcome_email: false } });
  });

  it('accepts the login form from real browsers (Origin: null + Sec-Fetch-Site) and refuses foreign origins', async () => {
    const loc = t.api.location;
    const post = (headers: Record<string, string>) =>
      t.api.raw(`/portal/${loc}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form({ email: 'fremd@example.de' }) });
    expect((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await post({ origin: 'null' })).status).toBe(403);
    expect((await post({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('logs members in with a single-use email link', async () => {
    const loc = t.api.location;
    // Unknown address: same answer, no mail.
    let r = await portalPost(`/portal/${loc}/login`, { email: 'fremd@example.de' });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Schau in dein Postfach');
    expect(mails).toHaveLength(0);
    expect((await portalPost(`/portal/${loc}/login`, { email: 'kein-at' })).status).toBe(400);

    r = await portalPost(`/portal/${loc}/login`, { email: 'ANNA@example.de' });
    expect(await r.text()).toContain('Schau in dein Postfach');
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('anna@example.de');
    const link = linkFrom(mails[0].text);
    expect(link.pathname).toBe(`/portal/${loc}/auth`);
    const tokenValue = link.searchParams.get('token')!;

    // Opening the link only shows a button (mail scanners can't burn it).
    const show = await portalGet(link.pathname + link.search);
    expect(await show.text()).toContain('Jetzt anmelden');
    const ok = await portalPost(`/portal/${loc}/auth`, { token: tokenValue });
    expect(ok.status).toBe(303);
    const set = ok.headers.get('set-cookie')!;
    expect(set).toMatch(new RegExp(`^pm_${loc}=`));
    expect(set).toContain('HttpOnly');
    cookie = set.split(';')[0];

    // Single use.
    const again = await portalPost(`/portal/${loc}/auth`, { token: tokenValue });
    expect(again.status).toBe(400);
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(await (await portalGet(link.pathname + link.search)).text()).toContain('abgelaufen');

    // Expired after 30 minutes.
    await portalPost(`/portal/${loc}/login`, { email: 'anna@example.de' });
    const second = linkFrom(mails[1].text).searchParams.get('token')!;
    const row = t.app.db.get('SELECT * FROM member_login_tokens WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1')!;
    expect(Date.parse(row.expires_at) - Date.parse(row.created_at)).toBe(30 * 60_000);
    t.app.db.run('UPDATE member_login_tokens SET expires_at = ? WHERE token_hash = ?', new Date(Date.now() - 1000).toISOString(), row.token_hash);
    expect((await portalPost(`/portal/${loc}/auth`, { token: second })).status).toBe(400);

    // At most three links per address and 15 minutes.
    await portalPost(`/portal/${loc}/login`, { email: 'anna@example.de' });
    await portalPost(`/portal/${loc}/login`, { email: 'anna@example.de' });
    expect(mails).toHaveLength(3);

    // Member sessions are no admin sessions.
    expect((await t.api.raw('/api/me', { headers: { cookie } })).status).toBe(401);
    expect(await (await portalGet(`/portal/${loc}`, t.api.cookie)).text()).toContain('Login-Link senden');
  });

  it('shows only published courses and plays lessons with drip and progress', async () => {
    const loc = t.api.location;
    let home = await (await portalGet(`/portal/${loc}`, cookie)).text();
    expect(home).toContain('Noch kein Kurs freigeschaltet');
    await t.api.patch(`/api/courses/${course.id}`, { status: 'published', cover_image: 'https://img.example/cover.jpg' });
    home = await (await portalGet(`/portal/${loc}`, cookie)).text();
    expect(home).toContain('Social Media Kickstart');
    expect(home).toContain('0 von 3 Lektionen');
    expect(home).toContain('Hallo, Anna');

    const coursePath = `/portal/${loc}/c/${course.slug}`;
    const page = await (await portalGet(coursePath, cookie)).text();
    expect(page).toContain('Kurs starten');
    expect(page).toContain(`${coursePath}/${l2.id}`);
    expect(page).toMatch(/ab \d{2}\.\d{2}\.\d{4}/); // Woche 2 is still locked

    // Lesson 1 (first in order after reorder): video, download, marks the course as started.
    const lesson = await (await portalGet(`${coursePath}/${l2.id}`, cookie)).text();
    expect(lesson).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(lesson).toContain('Checkliste.pdf');
    expect(lesson).toContain('Als erledigt markieren');
    await portalGet(`${coursePath}/${l2.id}`, cookie);
    await settle();
    expect(events.filter((e) => e.type === 'course.started')).toHaveLength(1);

    // Protected download.
    const fileLink = lesson.match(/href="(\/portal\/[^"]+\/files\/[^"]+)"/)![1];
    const file = await portalGet(fileLink, cookie);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect((await portalGet(fileLink)).status).toBe(401);

    // Locked lesson (drip 7 days).
    const locked = await portalGet(`${coursePath}/${l3.id}`, cookie);
    expect(await locked.text()).toContain('Noch nicht freigeschaltet');
    expect((await portalPost(`${coursePath}/${l3.id}/complete`, { done: '1' }, cookie)).status).toBe(404);

    // Complete → next open lesson; resume points there.
    const done = await portalPost(`${coursePath}/${l2.id}/complete`, { done: '1' }, cookie);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${coursePath}/${l1.id}`);
    await settle();
    const lc = events.filter((e) => e.type === 'lesson.completed');
    expect(lc).toHaveLength(1);
    expect(lc[0].data).toMatchObject({ contactId: anna.id, courseId: course.id, lessonId: l2.id, progress: { done: 1, total: 3, percent: 33 } });
    await portalPost(`${coursePath}/${l2.id}/complete`, { done: '1' }, cookie);
    await settle();
    expect(events.filter((e) => e.type === 'lesson.completed')).toHaveLength(1);
    const enr = t.app.db.get('SELECT * FROM course_enrollments WHERE course_id = ? AND contact_id = ?', course.id, anna.id)!;
    expect(enr.last_lesson_id).toBe(l2.id);
    expect((await (await portalGet(coursePath, cookie)).text())).toContain('Weiter lernen');
    // The dashboard card resumes at the next unfinished lesson.
    expect(await (await portalGet(`/portal/${loc}`, cookie)).text()).toContain(`href="${coursePath}/${l1.id}"`);

    // Drip passes: move enrollment back 8 days, finish everything → course completed once.
    t.app.db.run('UPDATE course_enrollments SET enrolled_at = ? WHERE id = ?', new Date(Date.now() - 8 * 864e5).toISOString(), enr.id);
    await portalPost(`${coursePath}/${l1.id}/complete`, { done: '1' }, cookie);
    const last = await portalPost(`${coursePath}/${l3.id}/complete`, { done: '1' }, cookie);
    expect(last.headers.get('location')).toBe(`${coursePath}?done=1`);
    await settle();
    expect(events.filter((e) => e.type === 'course.completed')).toHaveLength(1);
    expect(await (await portalGet(`${coursePath}?done=1`, cookie)).text()).toContain('Glückwunsch');
    // Undo and redo doesn't fire "completed" twice.
    await portalPost(`${coursePath}/${l3.id}/complete`, { done: '0' }, cookie);
    await portalPost(`${coursePath}/${l3.id}/complete`, { done: '1' }, cookie);
    await settle();
    expect(events.filter((e) => e.type === 'course.completed')).toHaveLength(1);

    const mine = (await t.api.get(`/api/contacts/${anna.id}/courses`)).data[0];
    expect(mine.progress).toEqual({ done: 3, total: 3, percent: 100 });
    expect(mine.completed_at).toBeTruthy();
    const stats = (await t.api.get('/api/courses')).data.find((c: any) => c.id === course.id);
    expect(stats.completed).toBe(1);

    // Unpublished lessons don't count and can't be opened.
    await t.api.patch(`/api/courses/${course.id}/lessons/${l1.id}`, { published: false });
    expect((await portalGet(`${coursePath}/${l1.id}`, cookie)).status).toBe(404);
    expect((await t.api.get(`/api/contacts/${anna.id}/courses`)).data[0].progress.total).toBe(2);
  });

  it('hides revoked courses, uses its own address and logs out', async () => {
    const loc = t.api.location;
    const portal = (await t.api.patch('/api/courses/portal', { slug: 'Akademie', settings: { title: 'Meine Akademie', color: '#7c3aed', welcome: 'Schön, dass du da bist!' } })).data;
    expect(portal.url).toBe('http://localhost/portal/akademie');
    expect((await t.api.patch('/api/courses/portal', { settings: { color: 'lila' } })).status).toBe(400);
    const page = await (await portalGet('/portal/akademie', cookie)).text();
    expect(page).toContain('Meine Akademie');
    expect(page).toContain('--brand:#7c3aed');
    expect(page).toContain('Schön, dass du da bist!');
    expect((await portalGet('/portal/gibts-nicht')).status).toBe(404);

    await t.api.del(`/api/courses/${course.id}/enrollments/${anna.id}`);
    expect((await portalGet(`/portal/akademie/c/${course.slug}`, cookie)).status).toBe(404);
    await settle();
    expect(events.some((e) => e.type === 'course.access_revoked' && e.data.contactId === anna.id)).toBe(true);

    const out = await portalPost('/portal/akademie/logout', {}, cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await (await portalGet('/portal/akademie', cookie)).text()).toContain('Login-Link senden');
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM member_sessions WHERE location_id = ?', loc)!.n).toBe(0);
  });

  it('sends a login link from the admin and offers MCP tools', async () => {
    await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: anna.id });
    const before = mails.length;
    t.app.db.run('DELETE FROM member_login_tokens');
    const r = (await t.api.post(`/api/courses/${course.id}/enrollments/${anna.id}/login-link`)).data;
    expect(r.status).toBe('sent');
    expect(mails.length).toBe(before + 1);
    expect(linkFrom(mails[mails.length - 1].text).pathname).toBe('/portal/akademie/auth');

    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const res = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return JSON.parse((await res.json()).result.content[0].text);
    };
    const list = await call('ghl_list_courses', { location_id: t.api.location });
    expect(list.find((c: any) => c.id === course.id).url).toBe(`http://localhost/portal/akademie/c/${course.slug}`);
    const g = await call('ghl_grant_course_access', { location_id: t.api.location, course_id: course.id, email: 'gustav@example.de' });
    expect(g).toMatchObject({ status: 'active', source: 'api', changed: 'created' });
  });

  it('removes everything with the course', async () => {
    expect((await t.api.del(`/api/courses/${course.id}`)).status).toBe(200);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM course_enrollments WHERE course_id = ?', course.id)!.n).toBe(0);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM course_lessons WHERE course_id = ?', course.id)!.n).toBe(0);
    expect((await t.api.get(`/api/courses/${course.id}`)).status).toBe(404);
  });
});
