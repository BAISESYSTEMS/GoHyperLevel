import type { Module } from '../core/app.js';
import { bad, clampLimit, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { cleanQuestions, completeLesson, gradeAttempt, isPassed, type Answers, type Question } from '../services/creator-quiz.js';
import { auditLog, clip, json } from '../services/creator-kit.js';
import { getCourse, portalUrl } from '../services/courses.js';
import { sendToContact } from '../services/messaging.js';
import { registerTriggers } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Quizzes as a lesson type: single/multiple choice, true/false and short text (auto-graded against accepted answers or sent to
 * the instructor's review queue), pass mark, attempt limit, and an optional gate that keeps the next lessons closed until the
 * quiz is passed. Passing completes the lesson (and the course, when it was the last one). The learner's side lives in
 * quiz-portal.ts, assignments in quiz-assignments.ts, certificates in quiz-certificates.ts. Docs: docs/quizzes-certificates.md.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

const QUESTION_SCHEMA = {
  type: 'array',
  description: 'Fragen: {kind: single|multiple|truefalse|short, text, options: [{text, correct}] (single/multiple), correct_value: true|false (truefalse), accepted: ["richtige Antwort", …] und review: auto|manual (short), points, explanation}',
  items: { type: 'object' },
};

const TOOLS: Tool[] = [
  {
    name: 'ghl_quiz_list',
    title: 'Quizze eines Kurses',
    description: 'Quizze (und mit with_attempts=true die letzten Versuche) eines Sub-Accounts, optional nur eines Kurses: Lektion, Bestehensgrenze, Versuche, Anzahl Fragen und offene Prüfungen.',
    inputSchema: obj({ ...LOC, course_id: { type: 'string' }, quiz_id: { type: 'string' }, with_attempts: { type: 'boolean' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.quiz_id) {
        const quiz = await call.api('GET', `/api/quizzes/${encodeURIComponent(a.quiz_id)}`, { location: a.location_id });
        return a.with_attempts ? { quiz, attempts: await call.api('GET', `/api/quizzes/${encodeURIComponent(a.quiz_id)}/attempts`, { location: a.location_id }) } : { quiz };
      }
      return call.api('GET', `/api/quizzes${a.course_id ? `?course_id=${encodeURIComponent(a.course_id)}` : ''}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_quiz_save',
    title: 'Quiz anlegen oder ändern',
    description:
      'Legt ein Quiz an einer Lektion an (course_id + lesson_id; die Lektion mit ghl_… Kurs-Werkzeugen oder in der Oberfläche anlegen) oder ändert es (quiz_id). Alle Fragen werden ersetzt. pass_percent (Standard 70), max_attempts (0 = unbegrenzt), gate (nächste Lektionen erst nach Bestehen), show_answers after_pass|always|never, shuffle.',
    inputSchema: obj(
      {
        ...LOC,
        quiz_id: { type: 'string' },
        course_id: { type: 'string' },
        lesson_id: { type: 'string' },
        title: { type: 'string' },
        intro: { type: 'string' },
        pass_percent: { type: 'integer', minimum: 1, maximum: 100 },
        max_attempts: { type: 'integer', minimum: 0, maximum: 50 },
        gate: { type: 'boolean' },
        shuffle: { type: 'boolean' },
        show_answers: { type: 'string', enum: ['after_pass', 'always', 'never'] },
        questions: QUESTION_SCHEMA,
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => {
      const { location_id, quiz_id, ...body } = a;
      return quiz_id ? call.api('PUT', `/api/quizzes/${encodeURIComponent(quiz_id)}`, { body, location: location_id }) : call.api('POST', '/api/quizzes', { body, location: location_id });
    },
  },
  {
    name: 'ghl_quiz_reviews',
    title: 'Offene Prüfungen',
    description: 'Wartende Kurzantworten aus Quizzen und abgegebene Aufgaben, die die Kursleitung noch prüfen muss.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/quizzes/reviews', { location: a.location_id }),
  },
  {
    name: 'ghl_quiz_review',
    title: 'Quiz-Versuch oder Aufgabe prüfen',
    description:
      'Bewertet einen wartenden Quiz-Versuch (attempt_id, answers: {frage_id: {correct: true|false, comment}}) oder eine abgegebene Aufgabe (submission_id, status passed|failed|revision, feedback). Die Person bekommt eine E-Mail mit dem Ergebnis; ein bestandenes Quiz bzw. eine bestandene Aufgabe schließt die Lektion ab.',
    inputSchema: obj({ ...LOC, attempt_id: { type: 'string' }, answers: { type: 'object' }, comment: { type: 'string' }, submission_id: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'revision'] }, feedback: { type: 'string' } }, ['location_id']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => {
      if (a.submission_id) return call.api('POST', `/api/assignments/submissions/${encodeURIComponent(a.submission_id)}/review`, { body: { status: a.status, feedback: a.feedback }, location: a.location_id });
      if (!a.attempt_id) throw new Error('attempt_id oder submission_id angeben');
      return call.api('POST', `/api/quizzes/attempts/${encodeURIComponent(a.attempt_id)}/review`, { body: { answers: a.answers, comment: a.comment }, location: a.location_id });
    },
  },
];

export interface QuizRow {
  id: string;
  location_id: string;
  course_id: string;
  lesson_id: string;
  title: string;
  intro: string;
  pass_percent: number;
  max_attempts: number;
  gate: number;
  shuffle: number;
  show_answers: 'after_pass' | 'always' | 'never';
  questions: Question[];
}

export interface AttemptRow {
  id: string;
  location_id: string;
  quiz_id: string;
  enrollment_id: string;
  contact_id: string;
  attempt_no: number;
  status: 'graded' | 'pending';
  answers: Answers;
  reviews: Record<string, { correct: boolean; comment?: string }>;
  score: number;
  max_score: number;
  percent: number;
  passed: number;
  comment: string;
  submitted_at: string;
  reviewed_at: string | null;
  reviewer: string;
}

export const quizModule: Module = {
  name: 'quiz',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE quizzes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '', intro TEXT NOT NULL DEFAULT '', pass_percent INTEGER NOT NULL DEFAULT 70, max_attempts INTEGER NOT NULL DEFAULT 0,
        gate INTEGER NOT NULL DEFAULT 1, shuffle INTEGER NOT NULL DEFAULT 0, show_answers TEXT NOT NULL DEFAULT 'after_pass', questions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(lesson_id)
      );
      CREATE INDEX quizzes_course ON quizzes(course_id);
      CREATE INDEX quizzes_loc ON quizzes(location_id);
      CREATE TABLE quiz_attempts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE, enrollment_id TEXT NOT NULL REFERENCES course_enrollments(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, attempt_no INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'graded',
        answers TEXT NOT NULL DEFAULT '{}', reviews TEXT NOT NULL DEFAULT '{}', score INTEGER NOT NULL DEFAULT 0, max_score INTEGER NOT NULL DEFAULT 0,
        percent INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, comment TEXT NOT NULL DEFAULT '',
        submitted_at TEXT NOT NULL, reviewed_at TEXT, reviewer TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX quiz_attempts_quiz ON quiz_attempts(quiz_id, contact_id);
      CREATE INDEX quiz_attempts_loc ON quiz_attempts(location_id, status);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const quizOf = (loc: string, qid: string): QuizRow | undefined => {
      const r = db.get<any>('SELECT * FROM quizzes WHERE id = ? AND location_id = ?', qid, loc);
      return r ? { ...r, questions: json<Question[]>(r.questions, []) } : undefined;
    };
    const attemptOut = (a: any): AttemptRow => ({ ...a, answers: json(a.answers, {}), reviews: json(a.reviews, {}) });
    const mustQuiz = (ctx: Ctx) => {
      const q = quizOf(ctx.locationId, ctx.params.id);
      if (!q) throw notFound('Quiz nicht gefunden');
      return q;
    };

    registerTriggers(app, [
      {
        type: 'quiz.passed',
        label: 'Quiz bestanden',
        category: 'content',
        summary: 'Eine Person besteht ein Quiz (auch nach der Prüfung einer Kurzantwort).',
        doc: '{{event.percent}} ist das Ergebnis, {{event.quiz.title}} das Quiz, {{event.attempt}} die Nummer des Versuchs. Mit dem Filter nur für ein Quiz oder einen Kurs.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }, { key: 'quiz_id', label: 'Nur für Quiz (ID)', type: 'text' }],
        sample: { quizId: 'q1', courseId: 'k1', quiz: { id: 'q1', title: 'Abschlusstest' }, course: { id: 'k1', title: 'Online-Kurs' }, percent: 90, attempt: 1 },
        keywords: 'quiz test prüfung bestanden kurs lernen',
      },
      {
        type: 'quiz.failed',
        label: 'Quiz nicht bestanden',
        category: 'content',
        summary: 'Ein Versuch liegt unter der Bestehensgrenze.',
        doc: '{{event.percent}} Ergebnis, {{event.attempts_left}} verbleibende Versuche (leer = unbegrenzt). Gut für eine Mail mit Lerntipps.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }, { key: 'quiz_id', label: 'Nur für Quiz (ID)', type: 'text' }],
        sample: { quizId: 'q1', courseId: 'k1', quiz: { id: 'q1', title: 'Abschlusstest' }, course: { id: 'k1', title: 'Online-Kurs' }, percent: 40, attempt: 1, attempts_left: 2 },
        keywords: 'quiz test durchgefallen nicht bestanden',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'quiz.passed': (c: any, d: any) => (!c.course_id || c.course_id === d.courseId) && (!c.quiz_id || c.quiz_id === d.quizId),
      'quiz.failed': (c: any, d: any) => (!c.course_id || c.course_id === d.courseId) && (!c.quiz_id || c.quiz_id === d.quizId),
    };

    // --- admin API ---------------------------------------------------------------------------------------------
    const quizOut = (q: QuizRow, withAnswers = true) => {
      const stats = db.get<any>(`SELECT COUNT(*) AS attempts, COUNT(DISTINCT contact_id) AS people, SUM(passed = 1) AS passed, SUM(status = 'pending') AS pending FROM quiz_attempts WHERE quiz_id = ?`, q.id)!;
      const lesson = db.get<any>('SELECT title FROM course_lessons WHERE id = ?', q.lesson_id);
      const course = db.get<any>('SELECT title FROM courses WHERE id = ?', q.course_id);
      return {
        ...q,
        gate: !!q.gate,
        shuffle: !!q.shuffle,
        lesson_title: lesson?.title ?? '',
        course_title: course?.title ?? '',
        questions: withAnswers ? q.questions : q.questions.map((x) => ({ id: x.id, kind: x.kind, text: x.text, points: x.points })),
        question_count: q.questions.length,
        stats: { attempts: Number(stats.attempts) || 0, people: Number(stats.people) || 0, passed: Number(stats.passed) || 0, pending: Number(stats.pending) || 0 },
      };
    };
    const settingsFrom = (b: any, cur?: QuizRow) => {
      const pass = b.pass_percent === undefined ? (cur?.pass_percent ?? 70) : Math.round(Number(b.pass_percent));
      if (!Number.isFinite(pass) || pass < 1 || pass > 100) throw bad('Bestehensgrenze: 1 bis 100 Prozent');
      const attempts = b.max_attempts === undefined ? (cur?.max_attempts ?? 0) : Math.round(Number(b.max_attempts));
      if (!Number.isFinite(attempts) || attempts < 0 || attempts > 50) throw bad('Versuche: 0 (unbegrenzt) bis 50');
      const show = b.show_answers ?? cur?.show_answers ?? 'after_pass';
      if (!['after_pass', 'always', 'never'].includes(show)) throw bad('Lösungen anzeigen: after_pass, always oder never');
      return { pass_percent: pass, max_attempts: attempts, gate: b.gate === undefined ? (cur?.gate ?? 1) : b.gate ? 1 : 0, shuffle: b.shuffle === undefined ? (cur?.shuffle ?? 0) : b.shuffle ? 1 : 0, show_answers: show };
    };

    router.get('/api/quizzes/reviews', 'location', (ctx) => {
      const attempts = db.all<any>(
        `SELECT a.id, a.quiz_id, a.contact_id, a.attempt_no, a.submitted_at, a.percent, q.title AS quiz_title, q.questions, a.answers, c.first_name, c.last_name, c.email, co.title AS course_title
         FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id JOIN courses co ON co.id = q.course_id LEFT JOIN contacts c ON c.id = a.contact_id
         WHERE a.location_id = ? AND a.status = 'pending' ORDER BY a.submitted_at LIMIT 200`,
        ctx.locationId,
      );
      const submissions = app.services.assignmentReviews?.(ctx.locationId) ?? [];
      return {
        quiz_attempts: attempts.map((a) => {
          const qs = json<Question[]>(a.questions, []);
          const answers = json<Answers>(a.answers, {});
          return {
            id: a.id,
            quiz_id: a.quiz_id,
            quiz_title: a.quiz_title,
            course_title: a.course_title,
            attempt_no: a.attempt_no,
            submitted_at: a.submitted_at,
            contact: { id: a.contact_id, name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '' },
            // only the questions that wait for a person, with the answer and what counts as right
            questions: qs.filter((q) => q.kind === 'short' && q.review === 'manual').map((q) => ({ id: q.id, text: q.text, answer: String(answers[q.id] ?? ''), accepted: q.accepted, explanation: q.explanation, points: q.points })),
          };
        }),
        assignment_submissions: submissions,
        counts: { quiz_attempts: attempts.length, assignment_submissions: submissions.length },
      };
    });

    router.get('/api/quizzes', 'location', (ctx) => {
      const cid = ctx.query.get('course_id');
      const rows = db.all<any>(`SELECT * FROM quizzes WHERE location_id = ? ${cid ? 'AND course_id = ?' : ''} ORDER BY created_at DESC`, ctx.locationId, ...(cid ? [cid] : []));
      return rows.map((r) => quizOut({ ...r, questions: json(r.questions, []) }, false));
    });
    router.post('/api/quizzes', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const course = getCourse(app, ctx.locationId, String(b.course_id ?? ''));
      if (!course) throw notFound('Kurs nicht gefunden');
      const lesson = db.get<any>('SELECT * FROM course_lessons WHERE id = ? AND course_id = ? AND location_id = ?', String(b.lesson_id ?? ''), course.id, ctx.locationId);
      if (!lesson) throw notFound('Lektion nicht gefunden');
      if (db.get('SELECT 1 FROM quizzes WHERE lesson_id = ?', lesson.id)) throw bad('Diese Lektion hat schon ein Quiz');
      if (db.get('SELECT 1 FROM assignments WHERE lesson_id = ?', lesson.id)) throw bad('Diese Lektion hat schon eine Aufgabe – ein Quiz bitte an einer anderen Lektion anlegen');
      const row = { id: id(), location_id: ctx.locationId, course_id: course.id, lesson_id: lesson.id, title: str(b.title, 'Titel', { max: 160 }) || lesson.title, intro: str(b.intro, 'Einleitung', { max: 3000 }), ...settingsFrom(b), questions: cleanQuestions(b.questions), created_at: now(), updated_at: now() };
      db.insert('quizzes', row);
      return quizOut(quizOf(ctx.locationId, row.id)!);
    });
    router.get('/api/quizzes/:id/attempts', 'location', (ctx) => {
      const q = mustQuiz(ctx);
      return db
        .all<any>(`SELECT a.*, c.first_name, c.last_name, c.email FROM quiz_attempts a LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.quiz_id = ? ORDER BY a.submitted_at DESC LIMIT ?`, q.id, clampLimit(ctx.query.get('limit'), 100, 500))
        .map((a) => ({ ...attemptOut(a), passed: !!a.passed, contact: { id: a.contact_id, name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '' }, first_name: undefined, last_name: undefined, email: undefined }));
    });
    router.post('/api/quizzes/:id/reset', 'location', (ctx) => {
      const q = mustQuiz(ctx);
      const contactId = clip(ctx.body?.contact_id, 40);
      if (!contactId || !getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      const n = db.run('DELETE FROM quiz_attempts WHERE quiz_id = ? AND contact_id = ?', q.id, contactId).changes;
      auditLog(app, ctx, ctx.locationId, 'quiz.reset', `Versuche zurückgesetzt (${q.title}, ${n})`, q.id);
      return { ok: true, removed: n };
    });
    router.post('/api/quizzes/attempts/:id/review', 'location', async (ctx) => {
      const a = db.get<any>('SELECT * FROM quiz_attempts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!a) throw notFound('Versuch nicht gefunden');
      if (a.status !== 'pending') throw bad('Dieser Versuch ist schon bewertet');
      const q = quizOf(ctx.locationId, a.quiz_id)!;
      const given = ctx.body?.answers && typeof ctx.body.answers === 'object' ? ctx.body.answers : {};
      const reviews: Record<string, { correct: boolean; comment?: string }> = {};
      for (const question of q.questions.filter((x) => x.kind === 'short' && x.review === 'manual')) {
        const g = given[question.id];
        if (g === undefined || typeof g.correct !== 'boolean') throw bad(`Bitte „${question.text.slice(0, 60)}“ als richtig oder falsch bewerten`);
        reviews[question.id] = { correct: g.correct, ...(g.comment ? { comment: clip(g.comment, 500) } : {}) };
      }
      return kit.finishReview(a.id, reviews, ctx.user?.name ?? 'API', clip(ctx.body?.comment, 1000), ctx);
    });
    router.get('/api/quizzes/:id', 'location', (ctx) => quizOut(mustQuiz(ctx)));
    router.put('/api/quizzes/:id', 'location', (ctx) => {
      const q = mustQuiz(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { ...settingsFrom(b, q), updated_at: now() };
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: 160 });
      if (b.intro !== undefined) patch.intro = str(b.intro, 'Einleitung', { max: 3000 });
      if (b.questions !== undefined) patch.questions = cleanQuestions(b.questions);
      db.update('quizzes', q.id, patch, ctx.locationId);
      return quizOut(quizOf(ctx.locationId, q.id)!);
    });
    router.delete('/api/quizzes/:id', 'location', (ctx) => {
      const q = mustQuiz(ctx);
      db.run('DELETE FROM quizzes WHERE id = ?', q.id);
      return { ok: true };
    });

    // --- taking a quiz: used by the member portal (quiz-portal.ts) -----------------------------------------------------
    const attemptsOf = (quizId: string, contactId: string): AttemptRow[] =>
      db.all<any>('SELECT * FROM quiz_attempts WHERE quiz_id = ? AND contact_id = ? ORDER BY attempt_no', quizId, contactId).map(attemptOut);

    /** Where a person stands: attempts used, left, passed, waiting for review. */
    function standing(quiz: QuizRow, contactId: string) {
      const list = attemptsOf(quiz.id, contactId);
      const passed = list.some((a) => a.passed);
      const pending = list.some((a) => a.status === 'pending');
      const left = quiz.max_attempts ? Math.max(0, quiz.max_attempts - list.length) : null;
      return { attempts: list, passed, pending, left, canTry: !passed && !pending && (left === null || left > 0), last: list.at(-1) };
    }

    function announce(quiz: QuizRow, a: AttemptRow, contactId: string) {
      const course = getCourse(app, quiz.location_id, quiz.course_id);
      const data = {
        contactId,
        quizId: quiz.id,
        courseId: quiz.course_id,
        lessonId: quiz.lesson_id,
        quiz: { id: quiz.id, title: quiz.title },
        course: { id: quiz.course_id, title: course?.title ?? '' },
        percent: a.percent,
        attempt: a.attempt_no,
        attempts_left: quiz.max_attempts ? Math.max(0, quiz.max_attempts - a.attempt_no) : null,
      };
      if (a.passed) {
        completeLesson(app, a.enrollment_id, quiz.lesson_id);
        logActivity(app, quiz.location_id, contactId, 'quiz.passed', `Quiz „${quiz.title}“ bestanden (${a.percent} %, Versuch ${a.attempt_no})`);
        app.events.emit(quiz.location_id, 'quiz.passed', data);
      } else {
        logActivity(app, quiz.location_id, contactId, 'quiz.failed', `Quiz „${quiz.title}“ nicht bestanden (${a.percent} %, Versuch ${a.attempt_no})`);
        app.events.emit(quiz.location_id, 'quiz.failed', data);
      }
    }

    /** Grades and stores one attempt. Throws German messages for "no more tries", "waiting for review", "already passed". */
    function submit(quiz: QuizRow, enrollmentId: string, contactId: string, answers: Answers): { attempt: AttemptRow; result: ReturnType<typeof gradeAttempt> } {
      const st = standing(quiz, contactId);
      if (st.passed) throw bad('Du hast dieses Quiz schon bestanden.');
      if (st.pending) throw bad('Dein letzter Versuch wird noch von der Kursleitung geprüft.');
      if (!st.canTry) throw bad('Alle Versuche sind verbraucht. Bitte melde dich bei der Kursleitung.');
      const result = gradeAttempt(quiz.questions, answers);
      const passed = !result.pending && isPassed(result.percent, quiz.pass_percent);
      const row = {
        id: id(), location_id: quiz.location_id, quiz_id: quiz.id, enrollment_id: enrollmentId, contact_id: contactId, attempt_no: st.attempts.length + 1,
        status: result.pending ? 'pending' : 'graded', answers, reviews: {}, score: result.score, max_score: result.max, percent: result.percent, passed: passed ? 1 : 0, comment: '', submitted_at: now(), reviewed_at: null, reviewer: '',
      };
      db.insert('quiz_attempts', row);
      const attempt = attemptOut(db.get('SELECT * FROM quiz_attempts WHERE id = ?', row.id));
      if (!result.pending) announce(quiz, attempt, contactId);
      else {
        logActivity(app, quiz.location_id, contactId, 'quiz.submitted', `Quiz „${quiz.title}“ abgegeben – wartet auf Prüfung`);
        void Promise.resolve(app.services.pushNotify?.({ locationId: quiz.location_id, kind: 'courses', title: 'Quiz wartet auf Prüfung', body: quiz.title, url: '/app/quizzes/reviews', tag: `quiz-${row.id}` })).catch(() => undefined);
      }
      return { attempt, result };
    }

    /** The instructor decided about the short answers: final score, pass or fail, message to the learner. */
    async function finishReview(attemptId: string, reviews: Record<string, { correct: boolean; comment?: string }>, by: string, comment: string, ctx?: Ctx) {
      const a = attemptOut(db.get<any>('SELECT * FROM quiz_attempts WHERE id = ?', attemptId));
      const quiz = quizOf(a.location_id, a.quiz_id)!;
      const result = gradeAttempt(quiz.questions, a.answers, reviews);
      const passed = isPassed(result.percent, quiz.pass_percent);
      db.run(`UPDATE quiz_attempts SET status = 'graded', reviews = ?, score = ?, max_score = ?, percent = ?, passed = ?, comment = ?, reviewed_at = ?, reviewer = ? WHERE id = ?`, JSON.stringify(reviews), result.score, result.max, result.percent, passed ? 1 : 0, comment, now(), by, a.id);
      const done = attemptOut(db.get('SELECT * FROM quiz_attempts WHERE id = ?', a.id));
      announce(quiz, done, a.contact_id);
      auditLog(app, ctx, a.location_id, 'quiz.review', `Quiz-Versuch bewertet (${quiz.title}: ${result.percent} %, ${passed ? 'bestanden' : 'nicht bestanden'})`, a.id, ctx ? undefined : by);
      const course = getCourse(app, a.location_id, quiz.course_id);
      const slug = course?.slug ?? '';
      void sendToContact(app, a.location_id, {
        contactId: a.contact_id,
        channel: 'email',
        subject: `Dein Quiz „${quiz.title}“ wurde ausgewertet`,
        body: `Hallo ${getContact(app, a.location_id, a.contact_id)?.first_name || ''},\n\ndeine Antworten zu „${quiz.title}“ wurden geprüft: ${result.percent} % – ${passed ? 'bestanden, glückwunsch!' : `leider noch nicht bestanden (nötig: ${quiz.pass_percent} %).`}${comment ? `\n\nAnmerkung der Kursleitung:\n${comment}` : ''}\n\nZur Lektion: ${portalUrl(app, a.location_id)}/c/${encodeURIComponent(slug)}/${encodeURIComponent(quiz.lesson_id)}\n\n${app.location(a.location_id)?.name ?? ''}`,
        source: 'Kurse',
        ignoreDnd: true,
      }).catch(() => undefined);
      return { ...done, passed, percent: result.percent };
    }

    // Lessons after a gated quiz stay closed until it is passed; a quiz lesson cannot be ticked off by hand.
    const gatedLessons = (courseId: string) => db.all<{ lesson_id: string }>('SELECT lesson_id FROM quizzes WHERE course_id = ? AND gate = 1', courseId).map((r) => r.lesson_id);
    app.services.lessonGates = [
      ...(app.services.lessonGates ?? []),
      (s: any, l: { id?: string }) => {
        if (!l.id || !s?.lessons) return undefined;
        const idx = s.lessons.findIndex((x: any) => x.id === l.id);
        if (idx < 0) return undefined;
        const gated = new Set([...gatedLessons(s.course.id), ...((app.services.assignmentGates?.(s.course.id) as string[] | undefined) ?? [])]);
        for (let i = 0; i < idx; i++) {
          const e = s.lessons[i];
          if (gated.has(e.id) && !s.done.has(e.id)) return `Schließe zuerst „${e.title}“ ab, dann geht es hier weiter.`;
        }
        return undefined;
      },
    ];
    app.services.lessonCompleteBlock = [...(app.services.lessonCompleteBlock ?? []), (_s: any, l: { id: string }) => !!db.get('SELECT 1 FROM quizzes WHERE lesson_id = ?', l.id)];

    const kit = { quizOf, standing, submit, finishReview, attemptsOf, announce };
    app.services.quizKit = kit;
  },
};
