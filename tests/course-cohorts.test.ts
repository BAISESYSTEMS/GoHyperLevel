import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { berlinDay, startTestApp } from './helpers.js';
import { fakeFfmpeg, fakeMp4, memberGet, memberLogin, memberPost } from './creatordepth-helpers.js';
import { cleanYmd, cohortState, pathPercent, pathSteps, pickCohort } from '../server/services/course-paths.js';
import { retentionCurve } from '../server/modules/course-analytics.js';
import { dripOrigin } from '../server/services/courses.js';

describe('path and cohort rules', () => {
  it('sequences courses and names what blocks', () => {
    const items = [{ course_id: 'a', title: 'A', percent: 100 }, { course_id: 'b', title: 'B', percent: 40 }, { course_id: 'c', title: 'C', percent: 0 }];
    const seq = pathSteps(items, { sequential: true, unlockPercent: 100 });
    expect(seq.map((s) => s.state)).toEqual(['done', 'open', 'locked']);
    expect(seq[2].reason).toBe('Schließe zuerst den Kurs „B“ ab (40 % von 100 %).');
    expect(pathPercent(seq)).toBe(33);
    // 40 % is enough when the rule says 40
    expect(pathSteps(items, { sequential: true, unlockPercent: 40 }).map((s) => s.state)).toEqual(['done', 'open', 'open']);
    // free order
    expect(pathSteps(items, { sequential: false, unlockPercent: 100 }).map((s) => s.state)).toEqual(['done', 'open', 'open']);
    // not enrolled counts as through
    expect(pathSteps([{ course_id: 'a', title: 'A' }, { course_id: 'b', title: 'B', percent: 0 }], { sequential: true, unlockPercent: 100 }).map((s) => s.state)).toEqual(['done', 'open']);
    expect(pathPercent([])).toBe(0);
  });

  it('reads dates, states and picks the cohort for a new member', () => {
    expect(cleanYmd('2026-10-05', 'Start')).toBe('2026-10-05');
    expect(() => cleanYmd('05.10.2026', 'Start')).toThrow(/JJJJ-MM-TT/);
    expect(() => cleanYmd('2026-02-31', 'Start')).toThrow();
    expect(() => cleanYmd('', 'Start')).toThrow(/fehlt/);
    expect(cleanYmd('', 'Ende', false)).toBe('');
    expect(cohortState({ starts_at: '2026-10-10' }, '2026-10-05')).toBe('upcoming');
    expect(cohortState({ starts_at: '2026-10-01', ends_at: '2026-10-04' }, '2026-10-05')).toBe('ended');
    expect(cohortState({ starts_at: '2026-10-01', ends_at: '2026-10-05' }, '2026-10-05')).toBe('running');
    expect(cohortState({ starts_at: '2026-10-01' }, '2026-12-05')).toBe('running');
    const list = [
      { id: 'old', starts_at: '2026-09-01', ends_at: '2026-09-30', capacity: 0, members: 3 },
      { id: 'run', starts_at: '2026-10-01', ends_at: '2026-11-30', capacity: 0, members: 3 },
      { id: 'soon-full', starts_at: '2026-10-10', capacity: 2, members: 2 },
      { id: 'later', starts_at: '2026-11-01', capacity: 5, members: 0 },
    ];
    expect(pickCohort(list, '2026-10-05')).toBe('later');
    expect(pickCohort(list.filter((c) => c.id !== 'later'), '2026-10-05')).toBe('run');
    expect(pickCohort(list.filter((c) => c.id === 'old' || c.id === 'soon-full'), '2026-10-05')).toBeUndefined();
  });

  it('draws the retention curve of a video', () => {
    expect(retentionCurve([])).toEqual([]);
    expect(retentionCurve([1, 1, 0.5, 0.25])).toEqual([100, 100, 75, 75, 75, 50, 50, 50, 50, 50]);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const ff = fakeFfmpeg();
const html = async (path: string, cookie: string) => (await memberGet(t, path, cookie)).text();

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.courseMediaRun = ff.run;
}, 60_000);
afterAll(() => t.close());

async function mkCourse(title: string, shape: { drip: number; titles: string[] }[]) {
  const co = (await t.api.post('/api/courses', { title, empty: true })).data;
  await t.api.patch(`/api/courses/${co.id}`, { status: 'published' });
  const lessons: any[] = [];
  for (const [i, m] of shape.entries()) {
    const mod = (await t.api.post(`/api/courses/${co.id}/modules`, { title: `Modul ${i + 1}`, drip_days: m.drip })).data;
    for (const lt of m.titles) lessons.push((await t.api.post(`/api/courses/${co.id}/lessons`, { module_id: mod.id, title: lt })).data);
  }
  return { ...co, lessons };
}
const lessonPath = (co: any, l: any) => `/portal/${loc}/c/${co.slug}/${l.id}`;

describe('cohorts', () => {
  let co: any;
  let dora = '';
  let emil = '';
  let finn = '';
  let doraC = '';
  let emilC = '';
  let finnC = '';
  let upcoming: any;
  let running: any;

  it('creates cohorts with checks and a link into the community', async () => {
    co = await mkCourse('Cohort-Kurs', [{ drip: 0, titles: ['Start'] }, { drip: 3, titles: ['Woche 1'] }]);
    const bad = (body: any) => t.api.post(`/api/courses/${co.id}/cohorts`, body);
    expect((await bad({ name: 'X', starts_at: '2026-13-40' })).status).toBe(400);
    expect((await bad({ name: 'X' })).status).toBe(400);
    expect((await bad({ starts_at: berlinDay(3) })).status).toBe(400);
    expect((await bad({ name: 'X', starts_at: berlinDay(3), ends_at: berlinDay(1) })).status).toBe(400);
    expect((await bad({ name: 'X', starts_at: berlinDay(3), group_id: 'gibtsnicht' })).status).toBe(400);
    const group = (await t.api.post('/api/community/groups', { name: 'Herbst-Club' })).data;
    expect((await bad({ name: 'X', starts_at: berlinDay(3), group_id: group.id, channel_id: 'fremd' })).status).toBe(400);
    upcoming = (await bad({ name: 'Herbst-Cohort', starts_at: berlinDay(7), group_id: group.id, channel_id: group.channels[0].id })).data;
    running = (await bad({ name: 'Sommer-Cohort', starts_at: berlinDay(-10), ends_at: berlinDay(40), capacity: 2 })).data;
    expect(upcoming).toMatchObject({ state: 'upcoming', members: 0, full: false, capacity: 0 });
    expect(running).toMatchObject({ state: 'running', capacity: 2 });
    const list = (await t.api.get(`/api/courses/${co.id}/cohorts`)).data;
    expect(list.map((c: any) => c.name)).toEqual(['Herbst-Cohort', 'Sommer-Cohort']);
    const upd = await t.api.patch(`/api/courses/${co.id}/cohorts/${upcoming.id}`, { name: 'Herbst 2026' });
    expect(upd.data.name).toBe('Herbst 2026');
    expect((await t.api.patch(`/api/courses/${co.id}/cohorts/${upcoming.id}`, { ends_at: berlinDay(1) })).status).toBe(400);
    expect((await t.api.patch(`/api/courses/${co.id}/cohorts/fremd`, { name: 'x' })).status).toBe(404);
  });

  it('counts the drip from the start of the cohort', async () => {
    const add = async (email: string, cohort: any) => {
      const r = await t.api.post(`/api/courses/${co.id}/cohorts/${cohort.id}/members`, { email, name: email.split('@')[0] });
      expect(r.status).toBe(200);
      return r.data.contact_id as string;
    };
    dora = await add('dora@example.de', upcoming);
    emil = await add('emil@example.de', running);
    finn = (await t.api.post(`/api/courses/${co.id}/enrollments`, { email: 'finn@example.de' })).data.contact_id;
    [doraC, emilC, finnC] = [await memberLogin(t, dora), await memberLogin(t, emil), await memberLogin(t, finn)];
    // Dora: the cohort has not started – even the first lesson waits
    const wait = await html(lessonPath(co, co.lessons[0]), doraC);
    expect(wait).toContain('Noch nicht freigeschaltet');
    expect(wait).toMatch(/steht dir ab dem <strong>\d{2}\.\d{2}\.\d{4}<\/strong>/);
    // Emil joined a cohort that started ten days ago: week 1 (drip 3) is open though he was enrolled just now
    expect(await html(lessonPath(co, co.lessons[1]), emilC)).not.toContain('Noch nicht freigeschaltet');
    // Finn has no cohort: his drip counts from today
    expect(await html(lessonPath(co, co.lessons[0]), finnC)).not.toContain('Noch nicht freigeschaltet');
    expect(await html(lessonPath(co, co.lessons[1]), finnC)).toContain('Noch nicht freigeschaltet');
    // the origin the server uses
    const en = t.app.db.get<any>('SELECT * FROM course_enrollments WHERE contact_id = ? AND course_id = ?', emil, co.id);
    expect(dripOrigin(t.app, en).slice(0, 10) <= berlinDay(-10)).toBe(true);
  });

  it('shows the cohort on the course page with the link to its community channel', async () => {
    const d = await html(`/portal/${loc}/c/${co.slug}`, doraC);
    expect(d).toContain('Dein Cohort: Herbst 2026');
    expect(d).toMatch(/startet am \d{2}\.\d{2}\.\d{4}/);
    expect(d).toMatch(/href="\/portal\/[^"]+\/community\/g\/herbst-club\?ch=allgemein">Zum Cohort-Chat<\/a>/);
    const e = await html(`/portal/${loc}/c/${co.slug}`, emilC);
    expect(e).toContain('Dein Cohort: Sommer-Cohort');
    expect(e).toMatch(/läuft seit \d{2}\.\d{2}\.\d{4}/);
    expect(e).not.toContain('Zum Cohort-Chat');
    expect(await html(`/portal/${loc}/c/${co.slug}`, finnC)).not.toContain('Dein Cohort');
  });

  it('respects the capacity and lists the members', async () => {
    const hanna = await t.api.post(`/api/courses/${co.id}/cohorts/${running.id}/members`, { email: 'hanna@example.de' });
    expect(hanna.status).toBe(200);
    const full = await t.api.post(`/api/courses/${co.id}/cohorts/${running.id}/members`, { email: 'ida@example.de' });
    expect(full.status).toBe(409);
    expect(full.data.error).toMatch(/voll/);
    // the same person again is not "one more"
    expect((await t.api.post(`/api/courses/${co.id}/cohorts/${running.id}/members`, { contact_id: hanna.data.contact_id })).status).toBe(200);
    const members = (await t.api.get(`/api/courses/${co.id}/cohorts/${running.id}/members`)).data;
    expect(members.map((m: any) => m.email).sort()).toEqual(['emil@example.de', 'hanna@example.de']);
    expect((await t.api.get(`/api/courses/${co.id}/cohorts`)).data.find((c: any) => c.id === running.id)).toMatchObject({ members: 2, full: true });
    expect((await t.api.del(`/api/courses/${co.id}/cohorts/${running.id}/members/${hanna.data.contact_id}`)).status).toBe(200);
    expect((await t.api.del(`/api/courses/${co.id}/cohorts/${running.id}/members/${hanna.data.contact_id}`)).status).toBe(404);
  });

  it('puts new members into the next open cohort when the course is set to automatic', async () => {
    const auto = await t.api.post(`/api/courses/${co.id}/enrollments`, { email: 'jana@example.de' });
    await t.app.events.flush();
    expect(t.app.db.get<any>('SELECT cohort_id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', auto.data.contact_id, co.id).cohort_id).toBeNull();
    expect((await t.api.patch(`/api/courses/${co.id}`, { settings: { cohort_mode: 'auto' } })).data.settings.cohort_mode).toBe('auto');
    const joined: string[] = [];
    t.app.events.on('course.cohort_joined', (e) => void joined.push(e.data.cohortId));
    const kim = await t.api.post(`/api/courses/${co.id}/enrollments`, { email: 'kim@example.de' });
    await t.app.events.flush();
    expect(t.app.db.get<any>('SELECT cohort_id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', kim.data.contact_id, co.id).cohort_id).toBe(upcoming.id);
    await t.app.events.flush();
    expect(joined).toContain(upcoming.id);
  });

  it('frees the members when a cohort goes', async () => {
    expect((await t.api.del(`/api/courses/${co.id}/cohorts/${upcoming.id}`)).status).toBe(200);
    expect(t.app.db.all('SELECT 1 FROM course_enrollments WHERE cohort_id = ?', upcoming.id)).toHaveLength(0);
    // Dora's lessons now count from her enrolment date: open
    expect(await html(lessonPath(co, co.lessons[0]), doraC)).not.toContain('Noch nicht freigeschaltet');
    expect((await t.api.del(`/api/courses/${co.id}/cohorts/${upcoming.id}`)).status).toBe(404);
  });
});

describe('course analytics', () => {
  let co: any;
  let video: any;
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  it('counts who opened and finished each lesson, where they stopped and how long they watched', async () => {
    co = await mkCourse('Analyse-Kurs', [{ drip: 0, titles: ['Eins', '=HYPERLINK("http://x")', 'Drei'] }]);
    // a hosted video on lesson two
    const start = (await t.api.post('/api/courses/videos', { name: 'zwei.mp4', size: 100 })).data;
    await t.api.raw(`/api/courses/videos/${start.id}/upload?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': loc }, body: fakeMp4(100) });
    await t.app.services.courseVideoJobs.flush();
    video = start;
    await t.api.patch(`/api/courses/${co.id}/lessons/${co.lessons[1].id}`, { video_id: video.id });
    for (const [key, email] of [['m1', 'm1@example.de'], ['m2', 'm2@example.de'], ['m3', 'm3@example.de'], ['m4', 'm4@example.de']]) {
      ids[key] = (await t.api.post(`/api/courses/${co.id}/enrollments`, { email })).data.contact_id;
      cookies[key] = await memberLogin(t, ids[key]);
    }
    const done = (key: string, l: any) => memberPost(t, `${lessonPath(co, l)}/complete`, { done: '1' }, cookies[key]);
    // m1 finishes everything, m2 the first lesson, m3 only looks at it, m4 never starts
    for (const l of co.lessons) await done('m1', l);
    await done('m2', co.lessons[0]);
    await memberGet(t, lessonPath(co, co.lessons[0]), cookies.m3);
    const a = (await t.api.get(`/api/courses/${co.id}/analytics`)).data;
    expect(a.totals).toMatchObject({ enrolled: 4, started: 3, completed: 1, completion_percent: 25, lessons: 3 });
    expect(a.totals.avg_progress_percent).toBe(Math.round(((3 / 3 + 1 / 3) / 4) * 100));
    const [l1, l2, l3] = a.lessons;
    expect(l1).toMatchObject({ position: 1, viewed: 3, completed: 2, viewed_percent: 75, completion_percent: 50, drop_off_percent: 0 });
    expect(l2).toMatchObject({ viewed: 1, completed: 1, drop_off_percent: 67 });
    expect(l3).toMatchObject({ viewed: 1, completed: 1, drop_off_percent: 0 });
    expect(a.biggest_drop).toEqual({ lesson_id: co.lessons[1].id, title: '=HYPERLINK("http://x")', percent: 67 });
    expect(l2.video).toMatchObject({ hosted: true, viewers: 0 });
    expect(l1.video).toBeNull();
    expect(a.weekly).toHaveLength(12);
    expect(a.weekly.at(-1)).toMatchObject({ enrolled: 4, completed: 1 });
    expect(a.comments).toEqual({ total: 0, unanswered: 0 });
  });

  it('adds the watch time and the retention curve of hosted videos', async () => {
    const e1 = t.app.db.get<any>('SELECT id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', ids.m1, co.id).id;
    const e2 = t.app.db.get<any>('SELECT id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', ids.m2, co.id).id;
    const put = (e: string, furthest: number, watched: number) => t.app.db.run('INSERT INTO course_playback (enrollment_id, lesson_id, position_sec, duration_sec, furthest_sec, watched_sec, speed, updated_at) VALUES (?, ?, 0, 100, ?, ?, 1, ?)', e, co.lessons[1].id, furthest, watched, new Date().toISOString());
    put(e1, 100, 95);
    put(e2, 50, 40);
    const a = (await t.api.get(`/api/courses/${co.id}/analytics`)).data;
    expect(a.lessons[1].video).toEqual({ hosted: true, viewers: 2, avg_watched_percent: 68, avg_furthest_percent: 75, watch_minutes: 2.3, retention: [100, 100, 100, 100, 100, 50, 50, 50, 50, 50] });
    expect(a.totals.watch_hours).toBeCloseTo(0.0, 1);
    expect(a.totals.avg_watch_minutes).toBeCloseTo(0.6, 1);
  });

  it('reports quiz scores, reviews and open questions', async () => {
    const quiz = (await t.api.post('/api/quizzes', { course_id: co.id, lesson_id: co.lessons[2].id, title: 'Abschlusstest', pass_percent: 70, questions: [{ kind: 'single', text: 'Frage?', options: [{ text: 'Ja', correct: true }, { text: 'Nein' }] }] })).data;
    const e1 = t.app.db.get<any>('SELECT id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', ids.m1, co.id).id;
    const e2 = t.app.db.get<any>('SELECT id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', ids.m2, co.id).id;
    const at = new Date().toISOString();
    const attempt = (n: number, e: string, contact: string, percent: number, passed: number, status = 'graded') =>
      t.app.db.run(`INSERT INTO quiz_attempts (id, location_id, quiz_id, enrollment_id, contact_id, attempt_no, status, answers, reviews, score, max_score, percent, passed, comment, submitted_at, reviewed_at, reviewer) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}', 0, 1, ?, ?, '', ?, ?, '')`, `att${n}x`.padEnd(20, '0'), loc, quiz.id, e, contact, n, status, percent, passed, at, at);
    attempt(1, e1, ids.m1, 50, 0);
    attempt(2, e1, ids.m1, 90, 1);
    attempt(3, e2, ids.m2, 60, 0);
    attempt(4, e2, ids.m2, 100, 1, 'pending'); // not graded yet: does not count
    // a published review and an unanswered question
    t.app.db.run(`INSERT INTO course_reviews (id, location_id, course_id, contact_id, author_name, rating, status, created_at, updated_at) VALUES ('rev1', ?, ?, ?, 'M', 4, 'published', ?, ?)`, loc, co.id, ids.m1, at, at);
    t.app.db.run(`INSERT INTO course_reviews (id, location_id, course_id, contact_id, author_name, rating, status, created_at, updated_at) VALUES ('rev2', ?, ?, ?, 'M', 1, 'pending', ?, ?)`, loc, co.id, ids.m2, at, at);
    t.app.db.run(`INSERT INTO course_comments (id, location_id, course_id, lesson_id, contact_id, author_name, body, created_at) VALUES ('com1', ?, ?, ?, ?, 'M', 'Frage', ?)`, loc, co.id, co.lessons[0].id, ids.m1, at);
    const a = (await t.api.get(`/api/courses/${co.id}/analytics`)).data;
    expect(a.quizzes).toEqual([{ quiz_id: quiz.id, lesson_id: co.lessons[2].id, title: 'Abschlusstest', pass_percent: 70, attempts: 3, takers: 2, avg_percent: 67, avg_best_percent: 75, pass_rate: 50 }]);
    expect(a.reviews).toEqual({ count: 1, average: 4, distribution: [0, 0, 0, 1, 0], pending: 1 });
    expect(a.comments).toEqual({ total: 1, unanswered: 1 });
  });

  it('can be narrowed to a cohort and exported', async () => {
    const k = (await t.api.post(`/api/courses/${co.id}/cohorts`, { name: 'Gruppe 1', starts_at: berlinDay(-1) })).data;
    await t.api.post(`/api/courses/${co.id}/cohorts/${k.id}/members`, { contact_id: ids.m1 });
    const a = (await t.api.get(`/api/courses/${co.id}/analytics?cohort=${k.id}`)).data;
    expect(a.cohort_id).toBe(k.id);
    expect(a.totals).toMatchObject({ enrolled: 1, completed: 1, completion_percent: 100 });
    expect(a.lessons[0]).toMatchObject({ viewed: 1, completed: 1 });
    expect((await t.api.get(`/api/courses/${co.id}/analytics?cohort=fremd`)).status).toBe(404);
    const csv = await t.api.raw(`/api/courses/${co.id}/analytics.csv?locationId=${loc}`, { headers: { cookie: t.api.cookie, 'x-pghl': '1' } });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-disposition')).toContain('attachment');
    const text = await csv.text();
    expect(text.split('\n')[0]).toContain('Abbruch gegenüber Vorgänger %');
    expect(text.split('\n').filter(Boolean)).toHaveLength(4);
    // a title that looks like a formula is defused
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect((await t.api.get('/api/courses/fremd/analytics')).status).toBe(404);
  });
});

describe('installable member app', () => {
  it('opens on the member home and offers "Meine Kurse" when courses exist', async () => {
    const m = await (await t.api.raw(`/portal/${loc}/manifest.webmanifest`)).json();
    expect(m.start_url).toBe(`/portal/${loc}/?source=app`);
    expect(m.shortcuts[0]).toMatchObject({ name: 'Meine Kurse', url: `/portal/${loc}/` });
    expect(m.shortcuts.some((s: any) => s.name === 'Nachrichten')).toBe(true);
    expect(m.description).toMatch(/^Kurse und Community von /);
    expect(m.scope).toBe(`/portal/${loc}/`);
    // a sub-account without a published course keeps the plain community app
    const other = (await t.api.post('/api/locations', { name: 'Ohne Kurse' })).data.id;
    const o = await (await t.api.raw(`/portal/${other}/manifest.webmanifest`)).json();
    expect(o.start_url).toBe(`/portal/${other}/community?source=app`);
    expect(o.shortcuts[0].name).toBe('Nachrichten');
  });

  it('puts the app tags and script on the course pages and allows only our own files to run', async () => {
    const co = await mkCourse('App-Kurs', [{ drip: 0, titles: ['Eins'] }]);
    const id = (await t.api.post(`/api/courses/${co.id}/enrollments`, { email: 'app@example.de' })).data.contact_id;
    const cookie = await memberLogin(t, id);
    for (const path of [`/portal/${loc}`, `/portal/${loc}/c/${co.slug}`, lessonPath(co, co.lessons[0])]) {
      const r = await memberGet(t, path, cookie);
      const h = await r.text();
      expect(h, path).toContain(`<link rel="manifest" href="/portal/${loc}/manifest.webmanifest">`);
      expect(h, path).toContain('apple-mobile-web-app-capable');
      expect(h, path).toContain('<script src="/portal-pwa.js" defer></script>');
      const csp = r.headers.get('content-security-policy')!;
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("manifest-src 'self'");
      expect(csp, path).toContain("worker-src 'self'");
      expect(csp, path).toContain("frame-ancestors 'none'");
      expect(csp, path).not.toContain("'unsafe-inline'; script");
    }
    // the login page needs none of it
    const login = await memberGet(t, `/portal/${loc}`, '');
    expect(login.headers.get('content-security-policy')).not.toContain('script-src');
    expect((await t.api.raw('/portal-pwa.js')).status).toBe(200);
  });
});
