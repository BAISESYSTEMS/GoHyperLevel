import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { bad, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { contentMatches, extFor } from '../core/files.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import { auditLog, clip } from '../services/creator-kit.js';
import { completeLesson } from '../services/creator-quiz.js';
import { getCourse, portalUrl } from '../services/courses.js';
import { sendToContact } from '../services/messaging.js';
import { registerTriggers } from '../services/wfx-kit.js';

/**
 * Assignments in courses: a lesson asks for a text and/or a file, the learner hands it in from the member area, the
 * instructor reviews it in a queue (passed / failed / please revise, with feedback). Passing completes the lesson; an
 * optional gate keeps the next lessons closed until then. Files are private (own folder, served only to the learner and to
 * team members of the sub-account). The learner's pages live in quiz-portal.ts. Docs: docs/quizzes-certificates.md.
 */

const FILE_MAX = 5 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'application/zip', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'];

export interface AssignmentRow {
  id: string;
  location_id: string;
  course_id: string;
  lesson_id: string;
  title: string;
  instructions: string;
  kind: 'text' | 'file' | 'both';
  pass_required: number;
  gate: number;
}

export interface SubmissionRow {
  id: string;
  location_id: string;
  assignment_id: string;
  enrollment_id: string;
  contact_id: string;
  attempt_no: number;
  text: string;
  file_name: string;
  file_mime: string;
  file_path: string;
  status: 'submitted' | 'passed' | 'failed' | 'revision';
  feedback: string;
  reviewer: string;
  submitted_at: string;
  reviewed_at: string | null;
}

export const quizAssignmentsModule: Module = {
  name: 'quiz-assignments',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE assignments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'both',
        pass_required INTEGER NOT NULL DEFAULT 1, gate INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(lesson_id)
      );
      CREATE INDEX assignments_course ON assignments(course_id);
      CREATE TABLE assignment_submissions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, enrollment_id TEXT NOT NULL REFERENCES course_enrollments(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, attempt_no INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '', file_mime TEXT NOT NULL DEFAULT '', file_path TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'submitted',
        feedback TEXT NOT NULL DEFAULT '', reviewer TEXT NOT NULL DEFAULT '', submitted_at TEXT NOT NULL, reviewed_at TEXT
      );
      CREATE INDEX assignment_submissions_a ON assignment_submissions(assignment_id, contact_id);
      CREATE INDEX assignment_submissions_loc ON assignment_submissions(location_id, status);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'assignment-files');
    // The submissions go with the contact (foreign key) – their uploaded files are deleted with it (erase or plain delete).
    app.services.contactFiles = [
      ...(app.services.contactFiles ?? []),
      (_a: unknown, loc: string, cid: string) =>
        db.all<{ file_path: string }>(`SELECT file_path FROM assignment_submissions WHERE location_id = ? AND contact_id = ? AND file_path != ''`, loc, cid).map((s) => join(dir, s.file_path.replace(/[^\w.-]/g, ''))),
    ];
    // Files arrive base64 in a form post: 5 MB become about 7 MB.
    app.services.bodyLimits = [...(app.services.bodyLimits ?? []), { match: (m: string, p: string) => m === 'POST' && /^\/portal\/[^/]+\/c\/[^/]+\/[^/]+\/aufgabe$/.test(p), bytes: 9 * 1024 * 1024 }];

    const assignmentOf = (loc: string, aid: string) => db.get<AssignmentRow>('SELECT * FROM assignments WHERE id = ? AND location_id = ?', aid, loc);
    const mustAssignment = (ctx: Ctx) => {
      const a = assignmentOf(ctx.locationId, ctx.params.id);
      if (!a) throw notFound('Aufgabe nicht gefunden');
      return a;
    };
    const out = (a: AssignmentRow) => {
      const stats = db.get<any>(`SELECT COUNT(*) AS submissions, SUM(status = 'submitted') AS waiting, SUM(status = 'passed') AS passed FROM assignment_submissions WHERE assignment_id = ?`, a.id)!;
      return {
        ...a,
        pass_required: !!a.pass_required,
        gate: !!a.gate,
        lesson_title: db.get<any>('SELECT title FROM course_lessons WHERE id = ?', a.lesson_id)?.title ?? '',
        course_title: db.get<any>('SELECT title FROM courses WHERE id = ?', a.course_id)?.title ?? '',
        stats: { submissions: Number(stats.submissions) || 0, waiting: Number(stats.waiting) || 0, passed: Number(stats.passed) || 0 },
      };
    };
    const fields = (b: any, cur?: AssignmentRow) => {
      const kind = b.kind ?? cur?.kind ?? 'both';
      if (!['text', 'file', 'both'].includes(kind)) throw bad('Abgabe: text, file oder both');
      return { kind, pass_required: b.pass_required === undefined ? (cur?.pass_required ?? 1) : b.pass_required ? 1 : 0, gate: b.gate === undefined ? (cur?.gate ?? 1) : b.gate ? 1 : 0 };
    };

    registerTriggers(app, [
      {
        type: 'assignment.submitted',
        label: 'Aufgabe abgegeben',
        category: 'content',
        summary: 'Jemand gibt eine Kurs-Aufgabe ab.',
        doc: '{{event.assignment.title}} nennt die Aufgabe, {{event.attempt}} die Nummer der Abgabe. Passend für eine Benachrichtigung an die Kursleitung oder eine Aufgabe im Team.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }],
        sample: { assignmentId: 'a1', courseId: 'k1', assignment: { id: 'a1', title: 'Konzept abgeben' }, course: { id: 'k1', title: 'Online-Kurs' }, attempt: 1 },
        keywords: 'aufgabe abgabe kurs einreichen hausaufgabe',
      },
      {
        type: 'assignment.reviewed',
        label: 'Aufgabe geprüft',
        category: 'content',
        summary: 'Die Kursleitung hat eine Abgabe bewertet (bestanden, nicht bestanden, bitte überarbeiten).',
        doc: '{{event.status}} ist passed, failed oder revision; {{event.feedback}} die Rückmeldung.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }, { key: 'status', label: 'Nur Ergebnis', type: 'select', options: [['passed', 'bestanden'], ['failed', 'nicht bestanden'], ['revision', 'überarbeiten']] }],
        sample: { assignmentId: 'a1', courseId: 'k1', assignment: { id: 'a1', title: 'Konzept abgeben' }, course: { id: 'k1', title: 'Online-Kurs' }, status: 'passed', feedback: 'Sehr gut!' },
        keywords: 'aufgabe geprüft feedback bestanden überarbeiten',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'assignment.submitted': (c: any, d: any) => !c.course_id || c.course_id === d.courseId,
      'assignment.reviewed': (c: any, d: any) => (!c.course_id || c.course_id === d.courseId) && (!c.status || c.status === d.status),
    };

    // --- admin API ---------------------------------------------------------------------------------------------
    router.get('/api/assignments', 'location', (ctx) => {
      const cid = ctx.query.get('course_id');
      return db.all<AssignmentRow>(`SELECT * FROM assignments WHERE location_id = ? ${cid ? 'AND course_id = ?' : ''} ORDER BY created_at DESC`, ctx.locationId, ...(cid ? [cid] : [])).map(out);
    });
    router.post('/api/assignments', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const course = getCourse(app, ctx.locationId, String(b.course_id ?? ''));
      if (!course) throw notFound('Kurs nicht gefunden');
      const lesson = db.get<any>('SELECT * FROM course_lessons WHERE id = ? AND course_id = ? AND location_id = ?', String(b.lesson_id ?? ''), course.id, ctx.locationId);
      if (!lesson) throw notFound('Lektion nicht gefunden');
      if (db.get('SELECT 1 FROM assignments WHERE lesson_id = ?', lesson.id)) throw bad('Diese Lektion hat schon eine Aufgabe');
      if (db.get('SELECT 1 FROM quizzes WHERE lesson_id = ?', lesson.id)) throw bad('Diese Lektion hat schon ein Quiz – eine Aufgabe bitte an einer anderen Lektion anlegen');
      const row = { id: id(), location_id: ctx.locationId, course_id: course.id, lesson_id: lesson.id, title: str(b.title, 'Titel', { max: 160 }) || lesson.title, instructions: str(b.instructions, 'Anleitung', { max: 10_000 }), ...fields(b), created_at: now(), updated_at: now() };
      db.insert('assignments', row);
      return out(assignmentOf(ctx.locationId, row.id)!);
    });
    router.post('/api/assignments/submissions/:id/review', 'location', async (ctx) => {
      const s = db.get<SubmissionRow>('SELECT * FROM assignment_submissions WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!s) throw notFound('Abgabe nicht gefunden');
      const status = String(ctx.body?.status ?? '');
      if (!['passed', 'failed', 'revision'].includes(status)) throw bad('Ergebnis: passed, failed oder revision');
      if (s.status !== 'submitted') throw bad('Diese Abgabe ist schon bewertet');
      return review(s, status as 'passed' | 'failed' | 'revision', str(ctx.body?.feedback, 'Rückmeldung', { max: 5000 }), ctx.user?.name ?? 'API', ctx);
    });
    router.get('/api/assignments/submissions/:id/file', 'location', (ctx): RawResult => {
      const s = db.get<SubmissionRow>('SELECT * FROM assignment_submissions WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!s?.file_path) throw notFound('Keine Datei');
      return fileResult(s);
    });
    router.get('/api/assignments/:id/submissions', 'location', (ctx) => {
      const a = mustAssignment(ctx);
      return db
        .all<any>(`SELECT s.*, c.first_name, c.last_name, c.email FROM assignment_submissions s LEFT JOIN contacts c ON c.id = s.contact_id WHERE s.assignment_id = ? ORDER BY s.submitted_at DESC LIMIT 300`, a.id)
        .map((s) => ({ ...s, file_path: undefined, has_file: !!s.file_path, contact: { id: s.contact_id, name: [s.first_name, s.last_name].filter(Boolean).join(' ') || s.email || '' }, first_name: undefined, last_name: undefined, email: undefined }));
    });
    router.get('/api/assignments/:id', 'location', (ctx) => out(mustAssignment(ctx)));
    router.put('/api/assignments/:id', 'location', (ctx) => {
      const a = mustAssignment(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { ...fields(b, a), updated_at: now() };
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: 160 });
      if (b.instructions !== undefined) patch.instructions = str(b.instructions, 'Anleitung', { max: 10_000 });
      db.update('assignments', a.id, patch, ctx.locationId);
      return out(assignmentOf(ctx.locationId, a.id)!);
    });
    router.delete('/api/assignments/:id', 'location', (ctx) => {
      const a = mustAssignment(ctx);
      db.run('DELETE FROM assignments WHERE id = ?', a.id);
      return { ok: true };
    });

    // --- files ---------------------------------------------------------------------------------------------------
    function fileResult(s: SubmissionRow): RawResult {
      const path = join(dir, s.file_path);
      if (!/^[A-Za-z0-9]{10,40}\.[a-z0-9]{2,5}$/.test(s.file_path) || !existsSync(path)) throw notFound('Datei nicht mehr vorhanden');
      const name = (s.file_name || 'abgabe').replace(/[^\w.\- ()äöüÄÖÜß]/g, '_');
      return { __raw: true, status: 200, headers: { 'content-type': s.file_mime, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }, body: readFileSync(path) };
    }

    /** A data: URL from the browser → a checked file on disk. */
    function storeFile(data: unknown, name: unknown): { file: string; mime: string; name: string } {
      const m = String(data ?? '').match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw bad('Datei konnte nicht gelesen werden');
      const mime = m[1];
      if (!FILE_TYPES.includes(mime)) throw bad('Erlaubt: PDF, PNG, JPG, ZIP, Word, Excel, PowerPoint, Text');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > FILE_MAX) throw bad('Die Datei ist größer als 5 MB');
      if (!buf.length || !contentMatches(mime, buf)) throw bad('Der Dateiinhalt passt nicht zum Dateityp');
      mkdirSync(dir, { recursive: true });
      const file = `${id(20)}${extFor(mime)}`;
      writeFileSync(join(dir, file), buf);
      return { file, mime, name: clip(name, 120).replace(/[\r\n]/g, ' ') || `abgabe${extFor(mime)}` };
    }

    // --- handing in and reviewing ---------------------------------------------------------------------------------------
    const submissionsOf = (assignmentId: string, contactId: string) => db.all<SubmissionRow>('SELECT * FROM assignment_submissions WHERE assignment_id = ? AND contact_id = ? ORDER BY attempt_no', assignmentId, contactId);
    function standing(a: AssignmentRow, contactId: string) {
      const list = submissionsOf(a.id, contactId);
      const last = list.at(-1);
      const passed = list.some((s) => s.status === 'passed');
      return { list, last, passed, waiting: last?.status === 'submitted', canSubmit: !passed && last?.status !== 'submitted' };
    }

    function submit(a: AssignmentRow, enrollmentId: string, contactId: string, input: { text: string; data?: unknown; fileName?: unknown }): SubmissionRow {
      const st = standing(a, contactId);
      if (st.passed) throw bad('Diese Aufgabe ist schon bestanden.');
      if (st.waiting) throw bad('Deine Abgabe wird noch geprüft.');
      const text = String(input.text ?? '').trim().slice(0, 20_000);
      const hasFile = !!String(input.data ?? '');
      if (a.kind === 'text' && !text) throw bad('Bitte einen Text eingeben.');
      if (a.kind === 'file' && !hasFile) throw bad('Bitte eine Datei auswählen.');
      if (a.kind === 'both' && !text && !hasFile) throw bad('Bitte einen Text eingeben oder eine Datei auswählen.');
      const f = hasFile && a.kind !== 'text' ? storeFile(input.data, input.fileName) : undefined;
      const row = { id: id(), location_id: a.location_id, assignment_id: a.id, enrollment_id: enrollmentId, contact_id: contactId, attempt_no: st.list.length + 1, text: a.kind === 'file' ? '' : text, file_name: f?.name ?? '', file_mime: f?.mime ?? '', file_path: f?.file ?? '', status: 'submitted', feedback: '', reviewer: '', submitted_at: now(), reviewed_at: null };
      db.insert('assignment_submissions', row);
      const course = getCourse(app, a.location_id, a.course_id);
      logActivity(app, a.location_id, contactId, 'assignment.submitted', `Aufgabe „${a.title}“ abgegeben (${course?.title ?? ''}, Abgabe ${row.attempt_no})`);
      app.events.emit(a.location_id, 'assignment.submitted', { contactId, assignmentId: a.id, courseId: a.course_id, assignment: { id: a.id, title: a.title }, course: { id: a.course_id, title: course?.title ?? '' }, attempt: row.attempt_no, submissionId: row.id });
      void Promise.resolve(app.services.pushNotify?.({ locationId: a.location_id, kind: 'courses', title: 'Aufgabe wartet auf Prüfung', body: a.title, url: '/app/quizzes/reviews', tag: `assignment-${row.id}` })).catch(() => undefined);
      return row as SubmissionRow;
    }

    async function review(s: SubmissionRow, status: 'passed' | 'failed' | 'revision', feedback: string, by: string, ctx?: Ctx) {
      const a = assignmentOf(s.location_id, s.assignment_id)!;
      db.run('UPDATE assignment_submissions SET status = ?, feedback = ?, reviewer = ?, reviewed_at = ? WHERE id = ?', status, feedback, by, now(), s.id);
      const course = getCourse(app, a.location_id, a.course_id);
      if (status === 'passed') completeLesson(app, s.enrollment_id, a.lesson_id);
      logActivity(app, a.location_id, s.contact_id, 'assignment.reviewed', `Aufgabe „${a.title}“: ${status === 'passed' ? 'bestanden' : status === 'failed' ? 'nicht bestanden' : 'bitte überarbeiten'}`);
      app.events.emit(a.location_id, 'assignment.reviewed', { contactId: s.contact_id, assignmentId: a.id, courseId: a.course_id, assignment: { id: a.id, title: a.title }, course: { id: a.course_id, title: course?.title ?? '' }, status, feedback, attempt: s.attempt_no, submissionId: s.id });
      auditLog(app, ctx, a.location_id, 'assignment.review', `Aufgabe „${a.title}“ bewertet: ${status}`, s.id, ctx ? undefined : by);
      void sendToContact(app, a.location_id, {
        contactId: s.contact_id,
        channel: 'email',
        subject: `Rückmeldung zu deiner Aufgabe „${a.title}“`,
        body: `Hallo ${getContact(app, a.location_id, s.contact_id)?.first_name || ''},\n\ndeine Abgabe zu „${a.title}“ wurde geprüft: ${status === 'passed' ? 'bestanden – glückwunsch!' : status === 'failed' ? 'leider nicht bestanden.' : 'bitte überarbeite sie noch einmal.'}${feedback ? `\n\nRückmeldung:\n${feedback}` : ''}\n\nZur Lektion: ${portalUrl(app, a.location_id)}/c/${encodeURIComponent(course?.slug ?? '')}/${encodeURIComponent(a.lesson_id)}\n\n${app.location(a.location_id)?.name ?? ''}`,
        source: 'Kurse',
        ignoreDnd: true,
      }).catch(() => undefined);
      return db.get('SELECT * FROM assignment_submissions WHERE id = ?', s.id);
    }

    app.services.assignmentReviews = (loc: string) =>
      db
        .all<any>(
          `SELECT s.id, s.attempt_no, s.text, s.file_name, s.submitted_at, s.contact_id, a.id AS assignment_id, a.title, co.title AS course_title, c.first_name, c.last_name, c.email
           FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id JOIN courses co ON co.id = a.course_id LEFT JOIN contacts c ON c.id = s.contact_id
           WHERE s.location_id = ? AND s.status = 'submitted' ORDER BY s.submitted_at LIMIT 200`,
          loc,
        )
        .map((s) => ({ id: s.id, assignment_id: s.assignment_id, assignment_title: s.title, course_title: s.course_title, attempt_no: s.attempt_no, text: String(s.text).slice(0, 2000), file_name: s.file_name, submitted_at: s.submitted_at, contact: { id: s.contact_id, name: [s.first_name, s.last_name].filter(Boolean).join(' ') || s.email || '' } }));
    app.services.assignmentGates = (courseId: string) => db.all<{ lesson_id: string }>('SELECT lesson_id FROM assignments WHERE course_id = ? AND gate = 1', courseId).map((r) => r.lesson_id);
    app.services.lessonCompleteBlock = [...(app.services.lessonCompleteBlock ?? []), (_s: any, l: { id: string }) => !!db.get('SELECT 1 FROM assignments WHERE lesson_id = ? AND pass_required = 1', l.id)];

    app.services.assignmentKit = { assignmentOf, standing, submit, review, fileResult };
  },
};
