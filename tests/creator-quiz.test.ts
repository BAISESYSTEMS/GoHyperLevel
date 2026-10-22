import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { cleanQuestions, completeLesson, gradeAttempt, normAnswer, type Question } from '../server/services/creator-quiz.js';
import { cleanCertConfig, certificatePdf, DEFAULT_CERT, fillBody } from '../server/services/certificate-pdf.js';
import { sha256 } from '../server/core/util.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const events: { type: string; data: any }[] = [];
const loc = () => t.api.location;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDFDATA = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%abgabe\n').toString('base64');

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  for (const type of ['quiz.passed', 'quiz.failed', 'assignment.submitted', 'assignment.reviewed', 'certificate.issued', 'lesson.completed', 'course.completed']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  await t.close();
});

const ev = (type: string) => events.filter((e) => e.type === type);
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const post = (path: string, data: Record<string, string>, cookie: string, headers: Record<string, string> = {}) =>
  t.api.raw(path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers }, body: form(data) });
const get = (path: string, cookie = '') => t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
/** A member session of the portal without going through the mail link. */
function login(contactId: string): string {
  const raw = `sess${Math.random().toString(36).slice(2)}${Date.now()}`;
  t.app.db.insert('member_sessions', { token_hash: sha256(raw), location_id: loc(), contact_id: contactId, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(), last_seen_at: new Date().toISOString() });
  return `pm_${loc()}=${raw}`;
}
const mailsTo = (email: string) => t.app.db.all<any>(`SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = ? AND m.direction = 'out' ORDER BY m.created_at, m.rowid`, email);
const settle = () => t.app.events.flush();

describe('questions and grading', () => {
  const qs = cleanQuestions([
    { kind: 'single', text: 'Hauptstadt von Deutschland?', options: [{ text: 'Berlin', correct: true }, { text: 'Bonn' }, { text: 'Köln' }] },
    { kind: 'multiple', text: 'Welche sind Primzahlen?', options: [{ text: '2', correct: true }, { text: '3', correct: true }, { text: '4' }], points: 2 },
    { kind: 'truefalse', text: 'Die Erde ist rund.', correct_value: true },
    { kind: 'short', text: 'Wie heißt unser Mond?', accepted: ['Mond', 'der Mond'] },
    { kind: 'short', text: 'Erkläre in einem Satz …', review: 'manual', accepted: [] },
  ]);
  const id = (i: number) => qs[i].id;
  const right = { [id(0)]: qs[0].options[0].id, [id(1)]: [qs[1].options[0].id, qs[1].options[1].id], [id(2)]: 'true', [id(3)]: ' „Der Mond“! ', [id(4)]: 'Weil …' };

  it('validates questions', () => {
    expect(() => cleanQuestions([])).toThrow('Mindestens eine Frage');
    expect(() => cleanQuestions([{ kind: 'single', text: '' }])).toThrow('Text fehlt');
    expect(() => cleanQuestions([{ kind: 'single', text: 'x', options: [{ text: 'a', correct: true }] }])).toThrow('zwei Antworten');
    expect(() => cleanQuestions([{ kind: 'single', text: 'x', options: [{ text: 'a' }, { text: 'b' }] }])).toThrow('richtige Antwort');
    expect(() => cleanQuestions([{ kind: 'single', text: 'x', options: [{ text: 'a', correct: true }, { text: 'b', correct: true }] }])).toThrow('genau eine');
    expect(qs[2].options.map((o) => [o.id, o.correct])).toEqual([['true', true], ['false', false]]);
    expect(qs[3]).toMatchObject({ review: 'auto', accepted: ['Mond', 'der Mond'] });
    // a short question without accepted answers can only be reviewed by hand
    expect(cleanQuestions([{ kind: 'short', text: 'Frei?' }])[0].review).toBe('manual');
    expect(new Set(qs.map((q) => q.id)).size).toBe(5);
  });

  it('normalises answers', () => {
    expect(normAnswer('  „Der   Mond“! ')).toBe('der mond');
    expect(normAnswer(undefined)).toBe('');
  });

  it('grades every kind and keeps manual answers pending', () => {
    const r = gradeAttempt(qs, right);
    expect(r.pending).toBe(true);
    expect(r.graded.map((g) => g.correct)).toEqual([true, true, true, true, null]);
    expect(r).toMatchObject({ score: 1 + 2 + 1 + 1, max: 1 + 2 + 1 + 1 + 1, percent: 83 });
    // the reviewer decides the last one
    const done = gradeAttempt(qs, right, { [id(4)]: { correct: true } });
    expect(done).toMatchObject({ pending: false, score: 6, max: 6, percent: 100 });
    // multiple choice is all-or-nothing
    expect(gradeAttempt(qs, { ...right, [id(1)]: [qs[1].options[0].id] }).graded[1].correct).toBe(false);
    expect(gradeAttempt(qs, { ...right, [id(1)]: [qs[1].options[0].id, qs[1].options[2].id] }).graded[1].correct).toBe(false);
    // unknown option ids are wrong, a blank manual answer is wrong (never waits for a reviewer)
    expect(gradeAttempt(qs, { ...right, [id(0)]: 'nope' }).graded[0].correct).toBe(false);
    expect(gradeAttempt(qs, { ...right, [id(4)]: '' }).graded[4]).toMatchObject({ correct: false, pending: false });
    expect(gradeAttempt(qs, {}).percent).toBe(0);
  });
});

describe('certificate config and PDF', () => {
  it('cleans the template settings', () => {
    expect(cleanCertConfig({ color: 'rot', accent: '#112233', orientation: 'portrait', number_prefix: 'ab c!', title: '' }, DEFAULT_CERT)).toMatchObject({ color: DEFAULT_CERT.color, accent: '#112233', orientation: 'portrait', number_prefix: 'abc', title: 'Zertifikat' });
    expect(fillBody('{{name}} hat {{course}} am {{date}} mit {{score}} bestanden', { course: 'Kurs', name: 'Eva', date: '01.01.2026', score: 90 })).toBe('Eva hat Kurs am 01.01.2026 mit 90 % bestanden');
  });

  it('builds a valid PDF with logo and signature, landscape and portrait', () => {
    const png = Buffer.from(PNG.split(',')[1], 'base64');
    const o = { cfg: { ...DEFAULT_CERT, issuer: 'Muster GmbH', signer_name: 'Erika Muster', signer_title: 'Geschäftsführerin', footer: 'Muster GmbH · Musterweg 1' }, name: 'Jürgen Müller-Lüdenscheid', course: 'Social Media Kickstart „Pro“', date: '04.10.2026', number: 'ZERT-2026-0001', verifyUrl: 'https://example.com/zertifikat/abc', score: 92, logo: png, signature: png };
    const land = certificatePdf(o);
    const text = land.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 842.25 595.5]');
    expect(text).toContain('ZERTIFIKAT');
    expect(text).toContain('Social Media Kickstart');
    expect(text).toContain('ZERT-2026-0001');
    expect(text).toContain('/Subtype /Image');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const portrait = certificatePdf({ ...o, cfg: { ...o.cfg, orientation: 'portrait' }, logo: null, signature: null });
    expect(portrait.toString('latin1')).toContain('/MediaBox [0 0 595.5 842.25]');
    expect(portrait.toString('latin1')).not.toContain('/Subtype /Image');
    // a very long name still fits (the font shrinks) and unknown characters do not break the file
    expect(certificatePdf({ ...o, name: 'A'.repeat(120) + ' 漢字' }).length).toBeGreaterThan(1000);
  });
});

describe('a course with a quiz, an assignment and a certificate', () => {
  let course: any;
  let l1: any;
  let lq: any;
  let la: any;
  let l4: any;
  let quiz: any;
  let anna: any;
  let ben: any;
  let cookie = '';
  let bcookie = '';
  let q: Question[];
  const base = () => `/portal/${loc()}/c/${course.slug}`;

  it('builds the course and the quiz, with validation', async () => {
    course = (await t.api.post('/api/courses', { title: 'Zertifikatskurs' })).data;
    const full = (await t.api.get(`/api/courses/${course.id}`)).data;
    l1 = full.modules[0].lessons[0];
    const modId = full.modules[0].id;
    lq = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: modId, title: 'Abschlusstest' })).data;
    la = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: modId, title: 'Praxisaufgabe' })).data;
    l4 = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: modId, title: 'Zusatz' })).data;
    await t.api.patch(`/api/courses/${course.id}`, { status: 'published' });

    const body = {
      course_id: course.id,
      lesson_id: lq.id,
      title: 'Wissenstest',
      pass_percent: 70,
      max_attempts: 2,
      gate: true,
      show_answers: 'after_pass',
      questions: [
        { kind: 'single', text: 'Wie viel ist 2 + 2?', options: [{ text: '3' }, { text: '4', correct: true }, { text: '5' }] },
        { kind: 'multiple', text: 'Welche sind Farben?', options: [{ text: 'Rot', correct: true }, { text: 'Blau', correct: true }, { text: 'Laut' }] },
        { kind: 'truefalse', text: 'Wasser ist nass.', correct_value: true },
        { kind: 'short', text: 'Hauptstadt von Frankreich?', accepted: ['Paris'], explanation: 'Paris liegt an der Seine.' },
      ],
    };
    expect((await t.api.post('/api/quizzes', { ...body, course_id: 'fremd' })).status).toBe(404);
    expect((await t.api.post('/api/quizzes', { ...body, lesson_id: 'fremd' })).status).toBe(404);
    expect((await t.api.post('/api/quizzes', { ...body, pass_percent: 0 })).status).toBe(400);
    expect((await t.api.post('/api/quizzes', { ...body, max_attempts: 99 })).status).toBe(400);
    expect((await t.api.post('/api/quizzes', { ...body, show_answers: 'sometimes' })).status).toBe(400);
    expect((await t.api.post('/api/quizzes', { ...body, questions: [] })).status).toBe(400);
    const r = await t.api.post('/api/quizzes', body);
    expect(r.status).toBe(200);
    quiz = r.data;
    expect(quiz).toMatchObject({ title: 'Wissenstest', gate: true, question_count: 4, lesson_title: 'Abschlusstest', course_title: 'Zertifikatskurs', stats: { attempts: 0, pending: 0 } });
    q = quiz.questions;
    expect((await t.api.post('/api/quizzes', body)).data.error).toContain('schon ein Quiz');
    // the list hides the solutions
    const list = (await t.api.get(`/api/quizzes?course_id=${course.id}`)).data;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('"correct"');
    expect((await t.api.put(`/api/quizzes/${quiz.id}`, { pass_percent: 75 })).data.pass_percent).toBe(75);
    await t.api.put(`/api/quizzes/${quiz.id}`, { pass_percent: 70 });
  });

  it('keeps the lessons after a gated quiz closed and takes the "done" button away', async () => {
    anna = (await t.api.post('/api/contacts', { email: 'anna@lern.de', first_name: 'Anna', last_name: 'Lernt' })).data;
    ben = (await t.api.post('/api/contacts', { email: 'ben@lern.de', first_name: 'Ben', last_name: 'Lernt' })).data;
    for (const c of [anna, ben]) expect((await t.api.post(`/api/courses/${course.id}/enrollments`, { contact_id: c.id })).status).toBe(200);
    cookie = login(anna.id);
    bcookie = login(ben.id);
    const page = await (await get(`${base()}/${lq.id}`, cookie)).text();
    expect(page).toContain('Wissenstest');
    expect(page).toContain('4 Fragen · bestanden ab 70 %');
    expect(page).toContain('name="q_' + q[0].id + '"');
    expect(page).toContain(`name="q_${q[1].id}_${q[1].options[0].id}"`);
    expect(page).toContain(`name="q_${q[3].id}" maxlength`);
    expect(page).not.toContain('Als erledigt markieren');
    expect(page).not.toContain('"correct"');
    // the lesson of the assignment comes after the quiz: closed until it is passed
    const locked = await (await get(`${base()}/${la.id}`, cookie)).text();
    expect(locked).toContain('Noch nicht freigeschaltet');
    expect(locked).toContain('Schließe zuerst „Abschlusstest“ ab');
    expect(await (await get(base(), cookie)).text()).toContain('gesperrt');
    // the lesson before it is open, and cannot be used to tick off the quiz by hand
    expect((await post(`${base()}/${lq.id}/complete`, { done: '1' }, cookie)).status).toBe(303);
    expect(t.app.db.get('SELECT 1 FROM course_progress WHERE lesson_id = ? AND completed_at IS NOT NULL', lq.id)).toBeUndefined();
    expect((await post(`${base()}/${la.id}/complete`, { done: '1' }, cookie)).status).toBe(404);
  });

  it('records a failed attempt, shows the result without the solutions and lets her try again', async () => {
    const wrong = { [`q_${q[0].id}`]: q[0].options[0].id, [`q_${q[1].id}_${q[1].options[0].id}`]: '1', [`q_${q[2].id}`]: 'false', [`q_${q[3].id}`]: 'Rom' };
    const r = await post(`${base()}/${lq.id}/quiz`, wrong, cookie);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toContain('#quiz');
    await settle();
    expect(ev('quiz.failed')).toHaveLength(1);
    expect(ev('quiz.failed')[0].data).toMatchObject({ contactId: anna.id, percent: 0, attempt: 1, attempts_left: 1, quiz: { title: 'Wissenstest' } });
    const page = await (await get(`${base()}/${lq.id}`, cookie)).text();
    expect(page).toContain('Noch nicht bestanden – 0 %');
    expect(page).toContain('✗ falsch');
    expect(page).not.toContain('Richtig: 4'); // solutions only after passing
    expect(page).not.toContain('Paris liegt an der Seine');
    expect(page).toContain('noch 1');
    expect(page).toContain('Du kannst es noch einmal versuchen');
    expect(await (await get(`${base()}/${la.id}`, cookie)).text()).toContain('Noch nicht freigeschaltet');
  });

  it('passes on the second attempt: the lesson is done, the next one opens, the solutions show', async () => {
    const good = { [`q_${q[0].id}`]: q[0].options[1].id, [`q_${q[1].id}_${q[1].options[0].id}`]: '1', [`q_${q[1].id}_${q[1].options[1].id}`]: '1', [`q_${q[2].id}`]: 'true', [`q_${q[3].id}`]: ' paris ' };
    await post(`${base()}/${lq.id}/quiz`, good, cookie);
    await settle();
    expect(ev('quiz.passed')).toHaveLength(1);
    expect(ev('quiz.passed')[0].data).toMatchObject({ contactId: anna.id, percent: 100, attempt: 2, courseId: course.id });
    expect(ev('lesson.completed').some((e) => e.data.lessonId === lq.id)).toBe(true);
    const page = await (await get(`${base()}/${lq.id}`, cookie)).text();
    expect(page).toContain('Bestanden – 100 %');
    expect(page).toContain('Dieses Quiz ist abgeschlossen');
    expect(page).toContain('✓ richtig');
    expect(page).not.toContain('Antworten abgeben');
    expect(await (await get(`${base()}/${la.id}`, cookie)).text()).not.toContain('Noch nicht freigeschaltet');
    // done is done: another attempt is refused
    await post(`${base()}/${lq.id}/quiz`, good, cookie);
    expect(t.app.db.all('SELECT 1 FROM quiz_attempts WHERE contact_id = ?', anna.id)).toHaveLength(2);
    const stats = (await t.api.get(`/api/quizzes/${quiz.id}`)).data.stats;
    expect(stats).toMatchObject({ attempts: 2, people: 1, passed: 1 });
    const attempts = (await t.api.get(`/api/quizzes/${quiz.id}/attempts`)).data;
    expect(attempts.map((a: any) => [a.attempt_no, a.percent, a.passed])).toEqual([[2, 100, true], [1, 0, false]]);
  });

  it('stops at the attempt limit, and the team can reset it', async () => {
    const bad = { [`q_${q[0].id}`]: q[0].options[0].id };
    await post(`${base()}/${lq.id}/quiz`, bad, bcookie);
    await post(`${base()}/${lq.id}/quiz`, bad, bcookie);
    const third = await post(`${base()}/${lq.id}/quiz`, bad, bcookie);
    expect(third.status).toBe(400);
    expect(await third.text()).toContain('Alle Versuche sind verbraucht');
    expect(t.app.db.all('SELECT 1 FROM quiz_attempts WHERE contact_id = ?', ben.id)).toHaveLength(2);
    expect(await (await get(`${base()}/${lq.id}`, bcookie)).text()).toContain('Alle Versuche sind verbraucht');
    expect((await t.api.post(`/api/quizzes/${quiz.id}/reset`, { contact_id: ben.id })).data.removed).toBe(2);
    expect(await (await get(`${base()}/${lq.id}`, bcookie)).text()).toContain('Antworten abgeben');
    expect((await t.api.post(`/api/quizzes/${quiz.id}/reset`, { contact_id: 'nope' })).status).toBe(404);
  });

  it('refuses strangers, foreign origins and people without access', async () => {
    const stranger = (await t.api.post('/api/contacts', { email: 'fremd@lern.de', first_name: 'Fred' })).data;
    const sc = login(stranger.id);
    expect((await post(`${base()}/${lq.id}/quiz`, {}, sc)).status).toBe(404); // no seat in the course
    expect((await post(`${base()}/${lq.id}/quiz`, {}, '')).status).toBe(303); // not logged in: back to the login
    const evil = await post(`${base()}/${lq.id}/quiz`, { [`q_${q[0].id}`]: q[0].options[1].id }, bcookie, { origin: 'https://evil.example' });
    expect(evil.status).toBe(404);
    expect(t.app.db.all('SELECT 1 FROM quiz_attempts WHERE contact_id = ?', ben.id)).toHaveLength(0);
  });

  it('sends short answers to the review queue and finishes the attempt after the review', async () => {
    const manual = (await t.api.post(`/api/courses/${course.id}/lessons`, { module_id: (await t.api.get(`/api/courses/${course.id}`)).data.modules[0].id, title: 'Freitext-Test' })).data;
    const mq = (
      await t.api.post('/api/quizzes', {
        course_id: course.id,
        lesson_id: manual.id,
        pass_percent: 50,
        gate: false,
        questions: [
          { kind: 'short', text: 'Erkläre den Unterschied.', review: 'manual' },
          { kind: 'truefalse', text: 'Stimmt das?', correct_value: false },
        ],
      })
    ).data;
    const cm = login(ben.id);
    // the earlier lessons (quiz, assignment) are gate steps: Ben has not passed them – use a free seat for the review test
    t.app.db.run(`UPDATE quizzes SET gate = 0 WHERE id = ?`, quiz.id);
    t.app.db.run(`UPDATE assignments SET gate = 0 WHERE course_id = ?`, course.id);
    const a = mq.questions;
    await post(`${base()}/${manual.id}/quiz`, { [`q_${a[0].id}`]: 'Die erste ist kleiner …', [`q_${a[1].id}`]: 'false' }, cm);
    await settle();
    expect(ev('quiz.passed').filter((e) => e.data.quizId === mq.id)).toHaveLength(0);
    expect(await (await get(`${base()}/${manual.id}`, cm)).text()).toContain('prüft die Kursleitung');
    const queue = (await t.api.get('/api/quizzes/reviews')).data;
    expect(queue.counts.quiz_attempts).toBe(1);
    expect(queue.quiz_attempts[0]).toMatchObject({ quiz_id: mq.id, contact: { name: 'Ben Lernt' } });
    expect(queue.quiz_attempts[0].questions).toEqual([expect.objectContaining({ id: a[0].id, answer: 'Die erste ist kleiner …' })]);
    const attemptId = queue.quiz_attempts[0].id;
    // an incomplete review is refused, then the real one
    expect((await t.api.post(`/api/quizzes/attempts/${attemptId}/review`, { answers: {} })).status).toBe(400);
    const done = await t.api.post(`/api/quizzes/attempts/${attemptId}/review`, { answers: { [a[0].id]: { correct: true, comment: 'Gut erklärt' } }, comment: 'Weiter so!' });
    expect(done.data).toMatchObject({ status: 'graded', percent: 100, passed: true });
    await settle();
    expect(ev('quiz.passed').filter((e) => e.data.quizId === mq.id)).toHaveLength(1);
    expect(t.app.db.get('SELECT 1 FROM course_progress WHERE lesson_id = ? AND completed_at IS NOT NULL', manual.id)).toBeTruthy();
    expect((await t.api.post(`/api/quizzes/attempts/${attemptId}/review`, { answers: {} })).status).toBe(400); // already graded
    const mail = mailsTo('ben@lern.de').at(-1)!;
    expect(mail.subject).toContain('ausgewertet');
    expect(mail.body).toContain('bestanden');
    expect(mail.body).toContain('Weiter so!');
    expect((await t.api.get('/api/quizzes/reviews')).data.counts.quiz_attempts).toBe(0);
    t.app.db.run(`UPDATE quizzes SET gate = 1 WHERE id = ?`, quiz.id);
  });

  it('takes assignments: text and file, review with feedback, revision, pass', async () => {
    const a = (await t.api.post('/api/assignments', { course_id: course.id, lesson_id: la.id, title: 'Praxisaufgabe', instructions: 'Lade dein **Konzept** hoch.', kind: 'both', gate: false })).data;
    expect(a).toMatchObject({ kind: 'both', pass_required: true, lesson_title: 'Praxisaufgabe', stats: { submissions: 0 } });
    expect((await t.api.post('/api/assignments', { course_id: course.id, lesson_id: la.id })).data.error).toContain('schon eine Aufgabe');
    expect((await t.api.post('/api/assignments', { course_id: course.id, lesson_id: lq.id })).data.error).toContain('schon ein Quiz');
    expect((await t.api.post('/api/assignments', { course_id: course.id, lesson_id: l4.id, kind: 'pdf' })).status).toBe(400);
    const lesson = await (await get(`${base()}/${la.id}`, cookie)).text();
    expect(lesson).toContain('Praxisaufgabe');
    expect(lesson).toContain('Aufgabe bearbeiten und abgeben');
    expect(lesson).not.toContain('Als erledigt markieren');
    // the hand-in page loads one script of ours, and allows exactly that
    const pageRes = await get(`${base()}/${la.id}/aufgabe`, cookie);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain('<script src="/portal-assignments.js" defer>');
    expect(pageHtml).toContain('type="file"');
    expect(pageRes.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await t.api.raw('/portal-assignments.js')).status).toBe(200);

    // nothing to hand in
    expect((await post(`${base()}/${la.id}/aufgabe`, { text: '' }, cookie)).headers.get('location')).toContain('fehler=leer');
    // a file that is not what it says (HTML in a PDF envelope), a type that is not allowed
    const evil = 'data:application/pdf;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    expect((await post(`${base()}/${la.id}/aufgabe`, { text: 'x', data: evil, file_name: 'a.pdf' }, cookie)).headers.get('location')).toContain('fehler=datei');
    const exe = 'data:application/x-msdownload;base64,' + Buffer.from('MZ').toString('base64');
    expect((await post(`${base()}/${la.id}/aufgabe`, { text: 'x', data: exe, file_name: 'a.exe' }, cookie)).headers.get('location')).toContain('fehler=datei');
    expect(t.app.db.all('SELECT 1 FROM assignment_submissions')).toHaveLength(0);

    const ok = await post(`${base()}/${la.id}/aufgabe`, { text: 'Hier mein erster Entwurf.', data: PNG, file_name: 'entwurf.png' }, cookie);
    expect(ok.headers.get('location')).toContain('#aufgabe');
    await settle();
    expect(ev('assignment.submitted')).toHaveLength(1);
    expect(await (await get(`${base()}/${la.id}`, cookie)).text()).toContain('Abgegeben – wird geprüft');
    // while it waits, no second hand-in
    expect((await get(`${base()}/${la.id}/aufgabe`, cookie)).headers.get('location')).toContain('#aufgabe');
    const queue = (await t.api.get('/api/quizzes/reviews')).data;
    expect(queue.assignment_submissions).toHaveLength(1);
    expect(queue.assignment_submissions[0]).toMatchObject({ assignment_title: 'Praxisaufgabe', file_name: 'entwurf.png', contact: { name: 'Anna Lernt' } });
    const sid = queue.assignment_submissions[0].id;

    // the team sees the file, the learner too, other learners and strangers do not
    const file = await t.api.raw(`/api/assignments/submissions/${sid}/file`, { headers: { cookie: t.api.cookie, 'x-location-id': loc() } });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect((await get(`${base()}/${la.id}/aufgabe/datei/${sid}`, cookie)).status).toBe(200);
    expect((await get(`${base()}/${la.id}/aufgabe/datei/${sid}`, bcookie)).status).toBe(404);
    expect((await get(`${base()}/${la.id}/aufgabe/datei/${sid}`)).status).toBe(303); // not logged in

    // revision, then a second hand-in, then pass
    expect((await t.api.post(`/api/assignments/submissions/${sid}/review`, { status: 'maybe' })).status).toBe(400);
    const rev = await t.api.post(`/api/assignments/submissions/${sid}/review`, { status: 'revision', feedback: 'Bitte die Zahlen belegen.' });
    expect(rev.data.status).toBe('revision');
    expect((await t.api.post(`/api/assignments/submissions/${sid}/review`, { status: 'passed' })).status).toBe(400);
    expect(mailsTo('anna@lern.de').at(-1)!.body).toContain('Bitte die Zahlen belegen.');
    expect(await (await get(`${base()}/${la.id}`, cookie)).text()).toContain('Bitte überarbeiten');
    await post(`${base()}/${la.id}/aufgabe`, { text: 'Jetzt mit Zahlen.', data: PDFDATA, file_name: 'konzept.pdf' }, cookie);
    const sid2 = (await t.api.get(`/api/assignments/${a.id}/submissions`)).data.find((s: any) => s.attempt_no === 2).id;
    expect((await t.api.get(`/api/assignments/${a.id}/submissions`)).data[0]).toMatchObject({ has_file: true, contact: { name: 'Anna Lernt' } });
    expect(JSON.stringify((await t.api.get(`/api/assignments/${a.id}/submissions`)).data)).not.toContain('file_path":"');
    await t.api.post(`/api/assignments/submissions/${sid2}/review`, { status: 'passed', feedback: 'Super!' });
    await settle();
    expect(ev('assignment.reviewed').map((e) => e.data.status)).toEqual(['revision', 'passed']);
    expect(t.app.db.get('SELECT 1 FROM course_progress WHERE lesson_id = ? AND completed_at IS NOT NULL', la.id)).toBeTruthy();
    expect(await (await get(`${base()}/${la.id}`, cookie)).text()).toContain('Diese Aufgabe ist abgeschlossen');
    expect((await t.api.get(`/api/assignments/${a.id}`)).data.stats).toMatchObject({ submissions: 2, passed: 1, waiting: 0 });
    // she can not hand in again
    expect((await post(`${base()}/${la.id}/aufgabe`, { text: 'noch eins' }, cookie)).status).toBe(303);
    expect(t.app.db.all('SELECT 1 FROM assignment_submissions WHERE contact_id = ?', anna.id)).toHaveLength(2);
  });

  it('issues the certificate when the course is completed, and verifies it publicly', async () => {
    const tpl = (await t.api.post('/api/certificates/templates', { name: 'Standard', course_id: course.id, issue_on: 'completion', config: { title: 'Zertifikat', subtitle: 'Hiermit wird bestätigt, dass', body: 'den Kurs {{course}} am {{date}} erfolgreich abgeschlossen hat.', issuer: 'Muster Akademie', signer_name: 'Erika Muster', signer_title: 'Leitung' } })).data;
    expect(tpl).toMatchObject({ enabled: true, issue_on: 'completion', course_title: 'Zertifikatskurs', issued: 0 });
    expect(tpl.config.issuer).toBe('Muster Akademie');
    expect((await t.api.post('/api/certificates/templates', { issue_on: 'quiz' })).status).toBe(400); // quiz missing
    expect((await t.api.post('/api/certificates/templates', { config: { logo_upload_id: 'nope' } })).status).toBe(400);
    expect((await t.api.post('/api/certificates/templates', { course_id: 'fremd' })).status).toBe(404);
    // finish what is left of the course (the quiz and the assignment are already done)
    const enrollment = t.app.db.get<any>('SELECT id FROM course_enrollments WHERE contact_id = ? AND course_id = ?', anna.id, course.id)!;
    for (const l of t.app.db.all<any>('SELECT id FROM course_lessons WHERE course_id = ?', course.id)) completeLesson(t.app, enrollment.id, l.id);
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    const certs = (await t.api.get(`/api/certificates?course_id=${course.id}`)).data;
    expect(certs).toHaveLength(1);
    const c = certs[0];
    expect(c).toMatchObject({ contact_id: anna.id, recipient_name: 'Anna Lernt', course_title: 'Zertifikatskurs', source: 'completion', revoked: false });
    expect(c.number).toMatch(/^ZERT-\d{4}-0001$/);
    expect(c.id).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(ev('certificate.issued')).toHaveLength(1);
    expect(ev('certificate.issued')[0].data).toMatchObject({ contactId: anna.id, course: { title: 'Zertifikatskurs' }, certificate: { number: c.number, url: `http://localhost/zertifikat/${c.id}` }, source: 'completion' });
    expect(mailsTo('anna@lern.de').at(-1)!.body).toContain(`/zertifikat/${c.id}/pdf`);

    // the public page
    const page = await get(`/zertifikat/${c.id}`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Echtes Zertifikat');
    expect(html).toContain('Anna Lernt');
    expect(html).toContain('Muster Akademie');
    expect(html).toContain(c.number);
    expect(html).toContain('noindex');
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    const pdf = await get(`/zertifikat/${c.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1')).toContain('Anna Lernt');
    expect(bytes.toString('latin1')).toContain('Zertifikatskurs');
    expect(bytes.toString('latin1')).toContain(c.number);
    // unknown or malformed ids
    expect((await get('/zertifikat/doesnotexistdoesnotex')).status).toBe(404);
    expect((await get('/zertifikat/short')).status).toBe(404);
    expect((await get('/zertifikat/..%2F..%2Fetc')).status).toBe(404);
    expect((await get(`/zertifikat/${'a'.repeat(22)}/pdf`)).status).toBe(404);

    // shown in the member area
    expect(await (await get(`/portal/${loc()}`, cookie)).text()).toContain('Meine Zertifikate');
    expect(await (await get(`/portal/${loc()}`, bcookie)).text()).not.toContain('Meine Zertifikate');

    // a second issue returns the same certificate
    const again = await t.api.post('/api/certificates/issue', { course_id: course.id, contact_id: anna.id });
    expect(again.data).toMatchObject({ id: c.id, created: false });
    // revoking turns the page invalid and the PDF off
    expect((await t.api.post(`/api/certificates/${c.id}/revoke`, { reason: 'Betrug' })).data.revoked).toBe(true);
    expect(await (await get(`/zertifikat/${c.id}`)).text()).toContain('widerrufen');
    expect((await get(`/zertifikat/${c.id}/pdf`)).status).toBe(404);
    expect((await t.api.post(`/api/certificates/${c.id}/revoke`)).status).toBe(400);
    // …and a new one can be issued
    const fresh = await t.api.post('/api/certificates/issue', { course_id: course.id, contact_id: anna.id });
    expect(fresh.data.created).toBe(true);
    expect(fresh.data.number).toMatch(/0002$/);
  });

  it('issues by hand without a template, by quiz, and from a workflow action; previews without saving', async () => {
    const eva = (await t.api.post('/api/contacts', { email: 'eva@lern.de', first_name: 'Eva' })).data;
    const emptyCourse = (await t.api.post('/api/courses', { title: 'Ohne Vorlage' })).data;
    const r = await t.api.post('/api/certificates/issue', { course_id: emptyCourse.id, email: 'neu@lern.de', name: 'Nina Neu' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ recipient_name: 'Nina Neu', course_title: 'Ohne Vorlage', source: 'manual', created: true });
    expect((await t.api.post('/api/certificates/issue', { course_id: emptyCourse.id, email: 'kaputt' })).status).toBe(400);
    expect((await t.api.post('/api/certificates/issue', { course_id: 'nope', contact_id: eva.id })).status).toBe(404);

    // a template bound to a quiz
    const tq = (await t.api.post('/api/certificates/templates', { name: 'Test-Zertifikat', course_id: course.id, issue_on: 'quiz', quiz_id: quiz.id })).data;
    expect(tq.quiz_id).toBe(quiz.id);
    t.app.db.run(`UPDATE certificate_templates SET enabled = 0 WHERE issue_on = 'completion'`);
    t.app.db.run('DELETE FROM certificates WHERE contact_id = ?', anna.id);
    t.app.db.run('DELETE FROM quiz_attempts WHERE contact_id = ?', anna.id);
    t.app.db.run('UPDATE quizzes SET max_attempts = 0 WHERE id = ?', quiz.id);
    const good = { [`q_${q[0].id}`]: q[0].options[1].id, [`q_${q[1].id}_${q[1].options[0].id}`]: '1', [`q_${q[1].id}_${q[1].options[1].id}`]: '1', [`q_${q[2].id}`]: 'true', [`q_${q[3].id}`]: 'Paris' };
    await post(`${base()}/${lq.id}/quiz`, good, cookie);
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    const byQuiz = (await t.api.get(`/api/certificates?contact_id=${anna.id}`)).data;
    expect(byQuiz).toHaveLength(1);
    expect(byQuiz[0]).toMatchObject({ source: 'quiz', score_percent: 100 });

    // the workflow action
    const act = t.app.services.workflowActions.certificate_issue;
    const res = await act({ location_id: loc(), contact_id: eva.id, workflow_id: 'w' }, { course_id: emptyCourse.id }, { event: {} });
    expect(res.result).toContain('ausgestellt');
    expect(res.vars.certificate_url).toMatch(/\/zertifikat\/[A-Za-z0-9]{22}$/);
    expect(res.vars.certificate_pdf_url).toMatch(/\/pdf$/);
    expect((await act({ location_id: loc(), contact_id: eva.id, workflow_id: 'w' }, { course_id: emptyCourse.id }, { event: {} })).result).toContain('gab es schon');
    await expect(act({ location_id: loc(), contact_id: eva.id, workflow_id: 'w' }, { course_id: '' }, { event: {} })).rejects.toThrow('Kurs');

    // the preview is a PDF with sample data and saves nothing
    const before = t.app.db.all('SELECT 1 FROM certificates').length;
    const pv = (await t.api.post('/api/certificates/templates/preview', { config: { title: 'Urkunde', color: '#7c3aed', orientation: 'portrait' }, course: 'Mein Kurs' })).data;
    const pdf = Buffer.from(pv.pdf_base64, 'base64');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('URKUNDE');
    expect(pdf.toString('latin1')).toContain('Mein Kurs');
    expect(t.app.db.all('SELECT 1 FROM certificates')).toHaveLength(before);

    // logo and signature from the uploads
    const up = (await t.api.post('/api/uploads', { name: 'logo.png', data: PNG })).data;
    const withLogo = (await t.api.post('/api/certificates/templates/preview', { config: { logo_upload_id: up.id, signature_upload_id: up.id } })).data;
    expect(Buffer.from(withLogo.pdf_base64, 'base64').toString('latin1')).toContain('/Subtype /Image');
    // somebody else's upload id is dropped, not read
    expect((await t.api.post('/api/certificates/templates', { config: { logo_upload_id: up.id } })).status).toBe(200);
  });

  it('is in the workflow catalogue and in the permission map', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    expect(cat.actions.map((a: any) => a.type)).toContain('certificate_issue');
    expect(cat.triggers.map((x: any) => x.type)).toEqual(expect.arrayContaining(['quiz.passed', 'quiz.failed', 'assignment.submitted', 'assignment.reviewed', 'certificate.issued']));
    const { requiredPermission } = await import('../server/core/permissions.js');
    for (const p of ['/api/quizzes', '/api/assignments/submissions/x/review', '/api/certificates/issue']) expect(requiredPermission('POST', p)).toBe('courses');
  });
});

describe('isolation', () => {
  it('never shows quizzes, assignments or certificates of another sub-account', async () => {
    const own = loc();
    const other = (await t.api.post('/api/locations', { name: 'Andere Akademie' })).data.id;
    t.api.setLocation(other);
    for (const path of ['/api/quizzes', '/api/assignments', '/api/certificates', '/api/certificates/templates']) expect((await t.api.get(path)).data, path).toEqual([]);
    expect((await t.api.get('/api/quizzes/reviews')).data.counts).toEqual({ quiz_attempts: 0, assignment_submissions: 0 });
    const quiz = t.app.db.get<any>('SELECT id, course_id, lesson_id FROM quizzes LIMIT 1')!;
    const a = t.app.db.get<any>('SELECT id FROM assignments LIMIT 1')!;
    const cert = t.app.db.get<any>('SELECT id, contact_id FROM certificates LIMIT 1')!;
    const tpl = t.app.db.get<any>('SELECT id FROM certificate_templates LIMIT 1')!;
    for (const [m, path] of [['GET', `/api/quizzes/${quiz.id}`], ['PUT', `/api/quizzes/${quiz.id}`], ['DELETE', `/api/quizzes/${quiz.id}`], ['GET', `/api/quizzes/${quiz.id}/attempts`], ['GET', `/api/assignments/${a.id}`], ['GET', `/api/assignments/${a.id}/submissions`], ['GET', `/api/certificates/${cert.id}/pdf`], ['POST', `/api/certificates/${cert.id}/revoke`], ['PATCH', `/api/certificates/templates/${tpl.id}`]] as const) {
      const r = m === 'GET' ? await t.api.get(path) : m === 'DELETE' ? await t.api.del(path) : m === 'PUT' ? await t.api.put(path, {}) : m === 'PATCH' ? await t.api.patch(path, {}) : await t.api.post(path, {});
      expect(r.status, `${m} ${path}`).toBe(404);
    }
    expect((await t.api.post('/api/quizzes', { course_id: quiz.course_id, lesson_id: quiz.lesson_id, questions: [{ kind: 'truefalse', text: 'x', correct_value: true }] })).status).toBe(404);
    expect((await t.api.post('/api/certificates/issue', { course_id: quiz.course_id, contact_id: cert.contact_id })).status).toBe(404);
    t.api.setLocation(own);
  });
});
