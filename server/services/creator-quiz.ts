import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { id, now } from '../core/util.js';
import { logActivity } from './contacts.js';
import { completedLessonIds, computeProgress, courseOutline, flatLessons, getCourse } from './courses.js';

/**
 * Quizzes in courses: question types, validation, grading and "pass" – pure functions – plus the one place where a lesson
 * is completed on behalf of a learner (quiz passed, assignment accepted), with the same events the member portal emits
 * (lesson.completed, course.completed).
 */

export type QuestionKind = 'single' | 'multiple' | 'truefalse' | 'short';
export const KINDS: QuestionKind[] = ['single', 'multiple', 'truefalse', 'short'];
export const MAX_QUESTIONS = 60;

export interface Option {
  id: string;
  text: string;
  correct: boolean;
}

export interface Question {
  id: string;
  kind: QuestionKind;
  text: string;
  options: Option[];
  /** Short text: answers that count as right (compared in normalised form). */
  accepted: string[];
  /** Short text: `manual` always goes to the instructor's review queue. */
  review: 'auto' | 'manual';
  points: number;
  explanation: string;
}

const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

export function cleanQuestions(input: unknown): Question[] {
  if (!Array.isArray(input) || !input.length) throw bad('Mindestens eine Frage');
  if (input.length > MAX_QUESTIONS) throw bad(`Höchstens ${MAX_QUESTIONS} Fragen`);
  const seen = new Set<string>();
  return input.map((raw: any, i) => {
    const kind = KINDS.includes(raw?.kind) ? (raw.kind as QuestionKind) : 'single';
    const text = clip(raw?.text, 1000);
    if (!text) throw bad(`Frage ${i + 1}: Text fehlt`);
    let qid = /^[A-Za-z0-9]{4,24}$/.test(String(raw?.id ?? '')) ? String(raw.id) : id(8);
    while (seen.has(qid)) qid = id(8);
    seen.add(qid);
    const points = Math.min(100, Math.max(1, Math.round(Number(raw?.points) || 1)));
    const base = { id: qid, kind, text, points, explanation: clip(raw?.explanation, 1000), accepted: [] as string[], review: 'auto' as 'auto' | 'manual', options: [] as Option[] };
    if (kind === 'truefalse') {
      const value = raw?.correct_value ?? raw?.options?.find?.((o: any) => o?.id === 'true')?.correct;
      return { ...base, options: [{ id: 'true', text: 'Wahr', correct: value === true || value === 'true' }, { id: 'false', text: 'Falsch', correct: !(value === true || value === 'true') }] };
    }
    if (kind === 'short') {
      const accepted = [...new Set((Array.isArray(raw?.accepted) ? raw.accepted : String(raw?.accepted ?? '').split('\n')).map((a: unknown) => clip(a, 200)).filter(Boolean))].slice(0, 20) as string[];
      const review = raw?.review === 'manual' || !accepted.length ? 'manual' : 'auto';
      return { ...base, accepted, review };
    }
    const list: Option[] = (Array.isArray(raw?.options) ? raw.options : []).slice(0, 10).map((o: any, k: number) => ({ id: /^[A-Za-z0-9]{1,24}$/.test(String(o?.id ?? '')) ? String(o.id) : `o${k + 1}`, text: clip(o?.text, 300), correct: !!o?.correct })).filter((o: Option) => o.text);
    if (list.length < 2) throw bad(`Frage ${i + 1}: mindestens zwei Antworten`);
    if (new Set(list.map((o) => o.id)).size !== list.length) list.forEach((o, k) => (o.id = `o${k + 1}`));
    const right = list.filter((o) => o.correct).length;
    if (!right) throw bad(`Frage ${i + 1}: mindestens eine richtige Antwort markieren`);
    if (kind === 'single' && right !== 1) throw bad(`Frage ${i + 1}: bei „eine Antwort“ genau eine richtige markieren (sonst „mehrere“ wählen)`);
    return { ...base, options: list };
  });
}

/** Lowercase, collapsed spaces, no surrounding quotes or closing punctuation: "  Der Mond! " equals "der mond". */
export const normAnswer = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[„“”"'‚‘’«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/g, '')
    .trim();

export type Answers = Record<string, string | string[]>;

export interface Graded {
  id: string;
  /** null while waiting for a person's review. */
  correct: boolean | null;
  pending: boolean;
  points: number;
}

export function gradeQuestion(q: Question, value: unknown, review?: { correct: boolean }): Graded {
  const base = { id: q.id, points: q.points };
  if (q.kind === 'short') {
    const text = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    if (review) return { ...base, correct: review.correct, pending: false };
    if (q.review === 'manual') return { ...base, correct: null, pending: true };
    return { ...base, correct: q.accepted.map(normAnswer).includes(normAnswer(text)), pending: false };
  }
  const picked = new Set((Array.isArray(value) ? value : value === undefined || value === '' ? [] : [value]).map(String));
  const right = new Set(q.options.filter((o) => o.correct).map((o) => o.id));
  const valid = [...picked].every((p) => q.options.some((o) => o.id === p));
  const ok = valid && picked.size === right.size && [...picked].every((p) => right.has(p));
  return { ...base, correct: ok, pending: false };
}

export interface Result {
  graded: Graded[];
  score: number;
  max: number;
  percent: number;
  pending: boolean;
}

/** An empty manual answer counts as wrong (not pending), so a blank form never waits for a reviewer. */
export function gradeAttempt(qs: Question[], answers: Answers, reviews: Record<string, { correct: boolean }> = {}): Result {
  const graded = qs.map((q) => {
    const g = gradeQuestion(q, answers[q.id], reviews[q.id]);
    if (q.kind === 'short' && q.review === 'manual' && !reviews[q.id] && !normAnswer(Array.isArray(answers[q.id]) ? (answers[q.id] as string[])[0] : answers[q.id])) return { ...g, correct: false, pending: false };
    return g;
  });
  const max = qs.reduce((n, q) => n + q.points, 0);
  const score = graded.reduce((n, g) => n + (g.correct ? g.points : 0), 0);
  const pending = graded.some((g) => g.pending);
  return { graded, score, max, percent: max ? Math.round((score / max) * 100) : 0, pending };
}

export const isPassed = (percent: number, passPercent: number) => percent >= passPercent;

// --- completing a lesson for a learner -------------------------------------------------------------------------

/**
 * Marks a lesson done for an enrollment (once) and announces it like the portal does: `lesson.completed`, and
 * `course.completed` when it was the last one. Returns what changed.
 */
export function completeLesson(app: App, enrollmentId: string, lessonId: string): { lesson: boolean; course: boolean } {
  const e = app.db.get<any>('SELECT * FROM course_enrollments WHERE id = ?', enrollmentId);
  if (!e || e.status !== 'active') return { lesson: false, course: false };
  const course = getCourse(app, e.location_id, e.course_id);
  const lesson = app.db.get<any>('SELECT id, title FROM course_lessons WHERE id = ? AND course_id = ?', lessonId, e.course_id);
  if (!course || !lesson) return { lesson: false, course: false };
  const changed = app.db.run(
    'INSERT INTO course_progress (enrollment_id, lesson_id, completed_at, last_viewed_at) VALUES (?, ?, ?, ?) ON CONFLICT(enrollment_id, lesson_id) DO UPDATE SET completed_at = excluded.completed_at WHERE completed_at IS NULL',
    e.id,
    lesson.id,
    now(),
    now(),
  ).changes;
  if (!changed) return { lesson: false, course: false };
  if (!e.started_at && app.db.run('UPDATE course_enrollments SET started_at = ? WHERE id = ? AND started_at IS NULL', now(), e.id).changes) {
    logActivity(app, e.location_id, e.contact_id, 'course.started', `Kurs „${course.title}“ begonnen`);
    app.events.emit(e.location_id, 'course.started', { contactId: e.contact_id, courseId: course.id, course: { id: course.id, title: course.title } });
  }
  const lessons = flatLessons(courseOutline(app, course.id, { publishedOnly: true }));
  const progress = computeProgress(lessons.map((l) => l.id), completedLessonIds(app, e.id));
  const ref = { id: course.id, title: course.title };
  logActivity(app, e.location_id, e.contact_id, 'lesson.completed', `Lektion „${lesson.title}“ abgeschlossen (${course.title}, ${progress.percent} %)`);
  app.events.emit(e.location_id, 'lesson.completed', { contactId: e.contact_id, courseId: ref.id, lessonId: lesson.id, course: ref, lesson: { id: lesson.id, title: lesson.title }, progress });
  let courseDone = false;
  if (progress.total && progress.done >= progress.total && app.db.run('UPDATE course_enrollments SET completed_at = ? WHERE id = ? AND completed_at IS NULL', now(), e.id).changes) {
    courseDone = true;
    logActivity(app, e.location_id, e.contact_id, 'course.completed', `Kurs „${course.title}“ abgeschlossen`);
    app.events.emit(e.location_id, 'course.completed', { contactId: e.contact_id, courseId: ref.id, course: ref });
  }
  return { lesson: true, course: courseDone };
}
