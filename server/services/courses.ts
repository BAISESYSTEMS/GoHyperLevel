import type { App } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { render } from '../core/template.js';
import { zonedToUtc } from '../core/time.js';
import { id, now } from '../core/util.js';
import { contactVars, getContact, logActivity } from './contacts.js';
import { sendToContact } from './messaging.js';

/**
 * Courses & membership area: shared logic for the admin module (courses.ts), the member portal
 * (portal.ts), workflows and tests. Access is an enrollment row per course and contact; progress is
 * one row per lesson the member opened or finished.
 */

const DAY = 864e5;

export interface CourseAccess {
  /** Contacts with any of these tags get access; e.g. `kurs:<slug>` or `kauf:<product>`. */
  tags: string[];
  /** Products whose purchase (event product.purchased) grants access. */
  product_ids: string[];
  /** Removing the last access tag takes access away again (only for access that came from a tag). */
  revoke_on_tag_removal: boolean;
  welcome_email: boolean;
  welcome_subject: string;
  welcome_body: string;
}

export const DEFAULT_WELCOME_SUBJECT = 'Dein Zugang zu „{{course.title}}“';
export const DEFAULT_WELCOME_BODY =
  'Hallo {{contact.first_name|du}},\n\ndein Zugang zum Kurs „{{course.title}}“ ist freigeschaltet.\n\nHier geht es zum Mitgliederbereich – einfach mit dieser E-Mail-Adresse anmelden, du bekommst dann einen Login-Link:\n{{portal_url}}\n\nViel Erfolg!\n{{location.name}}';

export function cleanAccess(input: any, cur: Partial<CourseAccess> = {}): CourseAccess {
  const v = { ...cur, ...(input ?? {}) };
  const list = (x: unknown) => (Array.isArray(x) ? [...new Set(x.map((t) => String(t).trim()).filter(Boolean))].slice(0, 50) : []);
  return {
    tags: list(v.tags),
    product_ids: list(v.product_ids),
    revoke_on_tag_removal: v.revoke_on_tag_removal !== false,
    welcome_email: !!v.welcome_email,
    welcome_subject: String(v.welcome_subject ?? '').slice(0, 300),
    welcome_body: String(v.welcome_body ?? '').slice(0, 10000),
  };
}

export interface CourseSettings {
  /** Lesson discussion ("Fragen & Diskussion") on or off. */
  comments_enabled: boolean;
  reviews_enabled: boolean;
  /** Reviews wait for the team before members see them. */
  reviews_moderation: boolean;
  /** Share of the course a member must have finished before they may review it. */
  reviews_min_percent: number;
  /** "auto": a new member is put into the next open cohort. */
  cohort_mode: 'off' | 'auto';
}

export const DEFAULT_COURSE_SETTINGS: CourseSettings = { comments_enabled: true, reviews_enabled: true, reviews_moderation: true, reviews_min_percent: 30, cohort_mode: 'off' };

export function cleanCourseSettings(input: any, cur: Partial<CourseSettings> = {}): CourseSettings {
  const v: any = { ...DEFAULT_COURSE_SETTINGS, ...cur, ...(input ?? {}) };
  const pct = Math.round(Number(v.reviews_min_percent));
  return {
    comments_enabled: v.comments_enabled !== false,
    reviews_enabled: v.reviews_enabled !== false,
    reviews_moderation: v.reviews_moderation !== false,
    reviews_min_percent: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 30,
    cohort_mode: v.cohort_mode === 'auto' ? 'auto' : 'off',
  };
}

export const courseSettings = (course: { settings?: any }): CourseSettings => cleanCourseSettings(course?.settings);

export function getCourse(app: App, locationId: string, courseId: string) {
  return parseJson(app.db.get('SELECT * FROM courses WHERE id = ? AND location_id = ?', courseId, locationId), ['access', 'settings']);
}

export interface OutlineLesson {
  id: string;
  module_id: string;
  title: string;
  position: number;
  video_url: string;
  body: string;
  downloads: { upload_id: string; name: string }[];
  duration_min: number;
  drip_days: number;
  published: number;
  /** Hosted video (course-video.ts), chapters [{t, title}] and "complete at X % watched" (0 = off). */
  video_id?: string | null;
  chapters?: { t: number; title: string }[];
  complete_percent?: number;
  [k: string]: any;
}
export interface OutlineModule {
  id: string;
  title: string;
  position: number;
  drip_days: number;
  published: number;
  lessons: OutlineLesson[];
  [k: string]: any;
}

/** Modules with their lessons in order. Members only see published ones. */
export function courseOutline(app: App, courseId: string, opts: { publishedOnly?: boolean } = {}): OutlineModule[] {
  const pub = opts.publishedOnly ? ' AND published = 1' : '';
  const modules = app.db.all<OutlineModule>(`SELECT * FROM course_modules WHERE course_id = ?${pub} ORDER BY position, created_at`, courseId);
  const lessons = parseRows(app.db.all<OutlineLesson>(`SELECT * FROM course_lessons WHERE course_id = ?${pub} ORDER BY position, created_at`, courseId), ['downloads', 'chapters']);
  return modules.map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) }));
}

/** Lessons in reading order (across modules). */
export const flatLessons = (outline: OutlineModule[]) => outline.flatMap((m) => m.lessons.map((l) => ({ ...l, module: m })));

/** Drip: a lesson opens N days after enrollment (the larger of the module's and the lesson's delay). */
export function unlockAt(enrolledAt: string, moduleDrip: number, lessonDrip: number): Date {
  const days = Math.max(0, Number(moduleDrip) || 0, Number(lessonDrip) || 0);
  return new Date(new Date(enrolledAt).getTime() + days * DAY);
}

export function isUnlocked(enrolledAt: string, moduleDrip: number, lessonDrip: number, at = new Date()): boolean {
  return unlockAt(enrolledAt, moduleDrip, lessonDrip).getTime() <= at.getTime();
}

/**
 * The instant a member's drip counts from: the start of their cohort (midnight in the sub-account's zone) when the enrollment
 * belongs to one – everybody in a cohort follows the same calendar, a late joiner finds the earlier lessons open – else the day
 * they were enrolled.
 */
export function dripOrigin(app: App, enrollment: { enrolled_at: string; cohort_id?: string | null; location_id?: string }): string {
  if (!enrollment.cohort_id) return enrollment.enrolled_at;
  const c = app.db.get<{ starts_at: string; location_id: string }>('SELECT starts_at, location_id FROM course_cohorts WHERE id = ?', enrollment.cohort_id);
  if (!c?.starts_at) return enrollment.enrolled_at;
  const tz = app.location(c.location_id)?.timezone || 'Europe/Berlin';
  try {
    return zonedToUtc(c.starts_at, '00:00', tz).toISOString();
  } catch {
    return `${c.starts_at}T00:00:00.000Z`;
  }
}

/** Share of finished lessons (only lessons that still exist and are published count). */
export function computeProgress(lessonIds: string[], completed: Iterable<string>): { done: number; total: number; percent: number } {
  const set = new Set(completed);
  const total = lessonIds.length;
  const done = lessonIds.filter((l) => set.has(l)).length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function completedLessonIds(app: App, enrollmentId: string): Set<string> {
  return new Set(app.db.all<{ lesson_id: string }>('SELECT lesson_id FROM course_progress WHERE enrollment_id = ? AND completed_at IS NOT NULL', enrollmentId).map((r) => r.lesson_id));
}

export function enrollmentProgress(app: App, enrollment: Record<string, any>, outline = courseOutline(app, enrollment.course_id, { publishedOnly: true })) {
  return computeProgress(flatLessons(outline).map((l) => l.id), completedLessonIds(app, enrollment.id));
}

export function getEnrollment(app: App, courseId: string, contactId: string) {
  return app.db.get('SELECT * FROM course_enrollments WHERE course_id = ? AND contact_id = ?', courseId, contactId);
}

/** The member portal's address for a sub-account (its own slug when set). */
export function portalUrl(app: App, locationId: string): string {
  const slug = app.db.get<{ slug: string | null }>('SELECT slug FROM course_portals WHERE location_id = ?', locationId)?.slug;
  return `${app.baseUrl()}/portal/${encodeURIComponent(slug || locationId)}`;
}

const SOURCE_LABEL: Record<string, string> = { manual: 'manuell', tag: 'Tag', workflow: 'Workflow', purchase: 'Kauf', api: 'API', community: 'Community-Level' };

/**
 * Gives a contact access to a course. Re-granting revoked access restores it with the old progress.
 * Emits course.enrolled (trigger „Kurszugang erhalten“) and optionally sends the welcome email.
 */
export function grantAccess(app: App, locationId: string, courseId: string, contactId: string, source = 'manual', ref = '') {
  const course = getCourse(app, locationId, courseId);
  if (!course) throw new Error('Kurs nicht gefunden');
  const contact = getContact(app, locationId, contactId);
  if (!contact) throw new Error('Kontakt nicht gefunden');
  const cur = getEnrollment(app, courseId, contactId);
  let changed: 'created' | 'reactivated' | null = null;
  if (!cur) {
    app.db.insert('course_enrollments', { id: id(), location_id: locationId, course_id: courseId, contact_id: contactId, status: 'active', source, source_ref: ref, enrolled_at: now(), created_at: now() });
    changed = 'created';
  } else if (cur.status !== 'active') {
    app.db.run(`UPDATE course_enrollments SET status = 'active', source = ?, source_ref = ?, revoked_at = NULL WHERE id = ?`, source, ref, cur.id);
    changed = 'reactivated';
  }
  const enrollment = getEnrollment(app, courseId, contactId)!;
  if (changed) {
    logActivity(app, locationId, contactId, 'course.enrolled', `Kurszugang „${course.title}“ ${changed === 'created' ? 'erhalten' : 'wieder freigeschaltet'} (${SOURCE_LABEL[source] ?? source})`);
    app.events.emit(locationId, 'course.enrolled', { contactId, courseId, course: { id: course.id, title: course.title, slug: course.slug }, source });
    if (course.access?.welcome_email) void sendWelcome(app, locationId, course, contactId);
  }
  return { enrollment, changed };
}

export function revokeAccess(app: App, locationId: string, courseId: string, contactId: string, why = ''): boolean {
  const cur = getEnrollment(app, courseId, contactId);
  if (!cur || cur.status !== 'active' || cur.location_id !== locationId) return false;
  app.db.run(`UPDATE course_enrollments SET status = 'revoked', revoked_at = ? WHERE id = ?`, now(), cur.id);
  const course = getCourse(app, locationId, courseId);
  logActivity(app, locationId, contactId, 'course.revoked', `Kurszugang „${course?.title ?? ''}“ entzogen${why ? ` (${why})` : ''}`);
  app.events.emit(locationId, 'course.access_revoked', { contactId, courseId, course: course ? { id: course.id, title: course.title } : undefined });
  return true;
}

async function sendWelcome(app: App, locationId: string, course: any, contactId: string) {
  const contact = getContact(app, locationId, contactId);
  if (!contact?.email) return;
  const vars = { contact: contactVars(contact), course: { id: course.id, title: course.title, slug: course.slug }, location: app.location(locationId), portal_url: portalUrl(app, locationId) };
  try {
    await sendToContact(app, locationId, {
      contactId,
      channel: 'email',
      subject: render(course.access.welcome_subject || DEFAULT_WELCOME_SUBJECT, vars),
      body: render(course.access.welcome_body || DEFAULT_WELCOME_BODY, vars),
      source: 'Kurse',
      // Access details are transactional: sent even with „Nicht stören“.
      ignoreDnd: true,
    });
  } catch (e) {
    console.error('[courses] welcome mail', e);
  }
}

/** A contact's courses with progress (contact page, MCP). */
export function contactEnrollments(app: App, locationId: string, contactId: string) {
  const rows = app.db.all(
    `SELECT e.*, c.title AS course_title, c.slug AS course_slug, c.status AS course_status, c.cover_image
     FROM course_enrollments e JOIN courses c ON c.id = e.course_id
     WHERE e.location_id = ? AND e.contact_id = ? ORDER BY e.enrolled_at DESC`,
    locationId,
    contactId,
  );
  return rows.map((e) => ({ ...e, progress: enrollmentProgress(app, e) }));
}
