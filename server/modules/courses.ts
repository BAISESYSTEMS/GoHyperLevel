import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, num, str } from '../core/http.js';
import { id, normalizeEmail, now, slugify } from '../core/util.js';
import { getContact, upsertContact } from '../services/contacts.js';
import {
  DEFAULT_WELCOME_BODY,
  DEFAULT_WELCOME_SUBJECT,
  cleanAccess,
  cleanCourseSettings,
  courseSettings,
  contactEnrollments,
  courseOutline,
  enrollmentProgress,
  flatLessons,
  getCourse,
  grantAccess,
  portalUrl,
  revokeAccess,
} from '../services/courses.js';
import { cleanChapters, cleanCompletePercent } from '../services/course-media.js';
import { readyVideo } from '../services/course-video.js';
import type { Tool } from './mcp.js';

/**
 * Kurse & Mitgliederbereich (admin side): courses → modules → lessons, access per contact
 * (manually, by tag, by product purchase or the workflow action „Kurszugang geben“) and the
 * portal settings. The member-facing pages live in portal.ts.
 */

const COURSE_STATUS = ['draft', 'published'];
const HEX = /^#[0-9a-f]{6}$/i;

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_courses',
    title: 'Kurse auflisten',
    description: 'Kurse eines Projekts mit Status, Lektionen und Teilnehmerzahl sowie die Adresse des Mitgliederbereichs.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/courses', { location: a.location_id }),
  },
  {
    name: 'ghl_grant_course_access',
    title: 'Kurszugang geben',
    description: 'Schaltet einen Kurs für einen Kontakt frei (contact_id oder email; unbekannte E-Mails werden als Kontakt angelegt). Mit revoke=true wird der Zugang entzogen.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string' }, course_id: { type: 'string' }, contact_id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, revoke: { type: 'boolean' } },
      required: ['location_id', 'course_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.revoke) return call.api('DELETE', `/api/courses/${encodeURIComponent(a.course_id)}/enrollments/${encodeURIComponent(a.contact_id ?? '')}`, { location: a.location_id });
      return call.api('POST', `/api/courses/${encodeURIComponent(a.course_id)}/enrollments`, { location: a.location_id, body: { contact_id: a.contact_id, email: a.email, name: a.name } });
    },
  },
];

function cleanDownloads(app: App, locationId: string, input: unknown) {
  if (!Array.isArray(input)) throw bad('Downloads: Liste erwartet');
  return input.slice(0, 30).map((d: any) => {
    const u = app.db.get('SELECT id, name FROM uploads WHERE id = ? AND location_id = ?', String(d?.upload_id ?? ''), locationId);
    if (!u) throw bad('Download-Datei nicht gefunden');
    return { upload_id: u.id, name: str(d?.name, 'Dateiname', { max: 200 }) || u.name };
  });
}

function cleanVideo(v: unknown): string {
  const s = str(v, 'Video-URL', { max: 1000 });
  if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw bad('Video-URL muss mit https:// beginnen');
  return s;
}

/** A hosted video of this sub-account (finished upload) or none. */
function cleanVideoId(app: App, locationId: string, v: unknown): string | null {
  const s = str(v, 'Video', { max: 60 });
  if (!s) return null;
  if (!readyVideo(app, locationId, s)) throw bad('Video nicht gefunden oder noch nicht fertig hochgeladen');
  return s;
}

function cleanImage(v: unknown, field = 'Bild'): string {
  const s = str(v, field, { max: 1000 });
  if (s && !/^(https?:\/\/|\/)[^\s]*$/i.test(s)) throw bad(`${field}: bitte eine https://-Adresse`);
  return s;
}

export const coursesModule: Module = {
  name: 'courses',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE courses (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        title TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', cover_image TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft', position INTEGER NOT NULL DEFAULT 0,
        access TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, slug)
      );
      CREATE TABLE course_modules (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, drip_days INTEGER NOT NULL DEFAULT 0,
        published INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE course_lessons (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
        title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, video_url TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '', downloads TEXT NOT NULL DEFAULT '[]', duration_min INTEGER NOT NULL DEFAULT 0,
        drip_days INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX course_lessons_course ON course_lessons(course_id, position);
      CREATE TABLE course_enrollments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'manual', source_ref TEXT NOT NULL DEFAULT '',
        enrolled_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, last_lesson_id TEXT, last_seen_at TEXT, revoked_at TEXT,
        created_at TEXT NOT NULL, UNIQUE(course_id, contact_id)
      );
      CREATE INDEX course_enrollments_contact ON course_enrollments(contact_id);
      CREATE TABLE course_progress (
        enrollment_id TEXT NOT NULL REFERENCES course_enrollments(id) ON DELETE CASCADE,
        lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
        completed_at TEXT, last_viewed_at TEXT, PRIMARY KEY (enrollment_id, lesson_id)
      );
      CREATE TABLE course_portals (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        slug TEXT UNIQUE, settings TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
    [
      // Creator depth: a hosted video per lesson (modules/course-video.ts), chapters, "complete at X % watched", cohort membership.
      '002-depth',
      `
      ALTER TABLE course_lessons ADD COLUMN video_id TEXT;
      ALTER TABLE course_lessons ADD COLUMN chapters TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE course_lessons ADD COLUMN complete_percent INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX course_lessons_video ON course_lessons(video_id) WHERE video_id IS NOT NULL;
      ALTER TABLE course_enrollments ADD COLUMN cohort_id TEXT;
      CREATE INDEX course_enrollments_cohort ON course_enrollments(cohort_id) WHERE cohort_id IS NOT NULL;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const uniqueSlug = (loc: string, base: string, except = '') => {
      const root = slugify(base) || 'kurs';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM courses WHERE location_id = ? AND slug = ? AND id != ?', loc, slug, except); i++) slug = `${root}-${i}`;
      return slug;
    };
    const mustCourse = (loc: string, cid: string) => {
      const c = getCourse(app, loc, cid);
      if (!c) throw notFound('Kurs nicht gefunden');
      return c;
    };
    const touch = (cid: string) => db.run('UPDATE courses SET updated_at = ? WHERE id = ?', now(), cid);
    const stats = (cid: string) =>
      db.get(
        `SELECT (SELECT COUNT(*) FROM course_modules WHERE course_id = ?) AS modules,
                (SELECT COUNT(*) FROM course_lessons WHERE course_id = ?) AS lessons,
                (SELECT COALESCE(SUM(duration_min), 0) FROM course_lessons WHERE course_id = ? AND published = 1) AS minutes,
                (SELECT COUNT(*) FROM course_enrollments WHERE course_id = ? AND status = 'active') AS members,
                (SELECT COUNT(*) FROM course_enrollments WHERE course_id = ? AND status = 'active' AND completed_at IS NOT NULL) AS completed`,
        cid, cid, cid, cid, cid,
      );
    const courseOut = (c: any) => ({ ...c, settings: courseSettings(c), ...stats(c.id), url: `${portalUrl(app, c.location_id)}/c/${encodeURIComponent(c.slug)}` });

    // --- portal settings (before /api/courses/:id) -------------------------------------
    const portalOf = (loc: string) => {
      const row = parseJson(db.get('SELECT * FROM course_portals WHERE location_id = ?', loc), ['settings']);
      const l = app.location(loc)!;
      const brand = l.settings?.branding ?? {};
      return {
        slug: row?.slug ?? '',
        settings: { title: '', welcome: '', color: '', logo_url: '', support_email: '', ...(row?.settings ?? {}) },
        defaults: { title: `${brand.name || l.name} – Mitgliederbereich`, color: brand.color || '#2563eb', logo_url: brand.logo_url || l.logo_url || '', support_email: brand.support_email || l.email || '' },
        url: portalUrl(app, loc),
      };
    };
    router.get('/api/courses/portal', 'location', (ctx) => portalOf(ctx.locationId));
    router.patch('/api/courses/portal', 'location', (ctx) => {
      const cur = portalOf(ctx.locationId);
      const b = ctx.body ?? {};
      let slug: string | null = cur.slug || null;
      if (b.slug !== undefined) {
        slug = b.slug ? slugify(String(b.slug)) : null;
        if (slug && db.get('SELECT location_id FROM course_portals WHERE slug = ? AND location_id != ?', slug, ctx.locationId)) throw bad('Diese Adresse ist schon vergeben');
        if (slug && db.get('SELECT id FROM locations WHERE id = ? AND id != ?', slug, ctx.locationId)) throw bad('Diese Adresse ist schon vergeben');
      }
      const s = { ...cur.settings };
      const p = b.settings ?? {};
      if (p.title !== undefined) s.title = str(p.title, 'Titel', { max: 120 });
      if (p.welcome !== undefined) s.welcome = str(p.welcome, 'Begrüßung', { max: 2000 });
      if (p.support_email !== undefined) s.support_email = str(p.support_email, 'Support-E-Mail', { max: 200 });
      if (p.logo_url !== undefined) s.logo_url = cleanImage(p.logo_url, 'Logo');
      if (p.color !== undefined) {
        if (p.color && !HEX.test(p.color)) throw bad('Farbe als #rrggbb');
        s.color = p.color || '';
      }
      db.run(
        'INSERT INTO course_portals (location_id, slug, settings, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET slug = excluded.slug, settings = excluded.settings, updated_at = excluded.updated_at',
        ctx.locationId,
        slug,
        JSON.stringify(s),
        now(),
      );
      return portalOf(ctx.locationId);
    });

    // --- courses -------------------------------------------------------------------------
    router.get('/api/courses', 'location', (ctx) =>
      db
        .all('SELECT * FROM courses WHERE location_id = ? ORDER BY position, created_at', ctx.locationId)
        .map((c) => courseOut(parseJson(c, ['access', 'settings']))),
    );
    router.post('/api/courses', 'location', (ctx) => {
      const title = str(ctx.body.title, 'Titel', { required: true, max: 160 });
      const slug = uniqueSlug(ctx.locationId, ctx.body.slug || title);
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM courses WHERE location_id = ?', ctx.locationId)!.n;
      const c = {
        id: id(),
        location_id: ctx.locationId,
        title,
        slug,
        description: str(ctx.body.description, 'Beschreibung', { max: 5000 }),
        cover_image: cleanImage(ctx.body.cover_image, 'Titelbild'),
        status: 'draft',
        position: pos,
        access: cleanAccess({ tags: [`kurs:${slug}`] }),
        settings: {},
        created_at: now(),
        updated_at: now(),
      };
      db.tx(() => {
        db.insert('courses', c);
        // A starting point instead of an empty page.
        if (ctx.body.empty !== true) {
          const m = { id: id(), location_id: ctx.locationId, course_id: c.id, title: 'Modul 1', position: 0, created_at: now(), updated_at: now() };
          db.insert('course_modules', m);
          db.insert('course_lessons', { id: id(), location_id: ctx.locationId, course_id: c.id, module_id: m.id, title: 'Willkommen', position: 0, body: 'Schön, dass du dabei bist! In diesem Kurs lernst du …', created_at: now(), updated_at: now() });
        }
      });
      return courseOut(getCourse(app, ctx.locationId, c.id));
    });
    router.get('/api/courses/:id', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      return { ...courseOut(c), modules: courseOutline(app, c.id), defaults: { welcome_subject: DEFAULT_WELCOME_SUBJECT, welcome_body: DEFAULT_WELCOME_BODY } };
    });
    router.patch('/api/courses/:id', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: 160 });
      if (b.slug !== undefined) patch.slug = uniqueSlug(ctx.locationId, String(b.slug || c.title), c.id);
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 5000 });
      if (b.cover_image !== undefined) patch.cover_image = cleanImage(b.cover_image, 'Titelbild');
      if (b.position !== undefined) patch.position = num(b.position);
      if (b.status !== undefined) {
        if (!COURSE_STATUS.includes(b.status)) throw bad('Unbekannter Status');
        patch.status = b.status;
      }
      if (b.settings !== undefined) patch.settings = cleanCourseSettings(b.settings, courseSettings(c));
      let added: string[] = [];
      if (b.access !== undefined) {
        patch.access = cleanAccess(b.access, c.access);
        added = patch.access.tags.filter((t: string) => !(c.access?.tags ?? []).includes(t));
        for (const pid of patch.access.product_ids) if (!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, ctx.locationId)) throw bad('Produkt nicht gefunden');
      }
      db.update('courses', c.id, patch);
      // Contacts that already carry a newly added access tag get access right away.
      let synced = 0;
      for (const tag of added) {
        const ids = db.all<{ id: string }>(`SELECT id FROM contacts WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)`, ctx.locationId, tag);
        for (const r of ids) if (grantAccess(app, ctx.locationId, c.id, r.id, 'tag', tag).changed) synced++;
      }
      return { ...courseOut(getCourse(app, ctx.locationId, c.id)), synced };
    });
    router.delete('/api/courses/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM courses WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Kurs nicht gefunden');
      return { ok: true };
    });

    // --- modules & lessons -----------------------------------------------------------------
    const mustModule = (cid: string, mid: string) => {
      const m = db.get('SELECT * FROM course_modules WHERE id = ? AND course_id = ?', mid, cid);
      if (!m) throw notFound('Modul nicht gefunden');
      return m;
    };
    const mustLesson = (cid: string, lid: string) => {
      const l = parseJson(db.get('SELECT * FROM course_lessons WHERE id = ? AND course_id = ?', lid, cid), ['downloads', 'chapters']);
      if (!l) throw notFound('Lektion nicht gefunden');
      return l;
    };
    const days = (v: unknown) => Math.min(Math.max(Math.round(num(v)), 0), 3650);

    router.post('/api/courses/:id/modules', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM course_modules WHERE course_id = ?', c.id)!.n;
      const m = { id: id(), location_id: ctx.locationId, course_id: c.id, title: str(ctx.body.title, 'Titel', { max: 160 }) || `Modul ${pos + 1}`, position: pos, drip_days: days(ctx.body.drip_days), published: ctx.body.published === false ? 0 : 1, created_at: now(), updated_at: now() };
      db.insert('course_modules', m);
      touch(c.id);
      return { ...m, lessons: [] };
    });
    router.patch('/api/courses/:id/modules/:mid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const m = mustModule(c.id, ctx.params.mid);
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.title !== undefined) patch.title = str(ctx.body.title, 'Titel', { required: true, max: 160 });
      if (ctx.body.drip_days !== undefined) patch.drip_days = days(ctx.body.drip_days);
      if (ctx.body.published !== undefined) patch.published = ctx.body.published ? 1 : 0;
      db.update('course_modules', m.id, patch);
      touch(c.id);
      return db.get('SELECT * FROM course_modules WHERE id = ?', m.id);
    });
    router.delete('/api/courses/:id/modules/:mid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      db.run('DELETE FROM course_modules WHERE id = ? AND course_id = ?', ctx.params.mid, c.id);
      touch(c.id);
      return { ok: true };
    });

    router.post('/api/courses/:id/lessons', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const m = mustModule(c.id, String(ctx.body.module_id ?? ''));
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM course_lessons WHERE module_id = ?', m.id)!.n;
      const l = {
        id: id(),
        location_id: ctx.locationId,
        course_id: c.id,
        module_id: m.id,
        title: str(ctx.body.title, 'Titel', { max: 160 }) || `Lektion ${pos + 1}`,
        position: pos,
        video_url: cleanVideo(ctx.body.video_url),
        video_id: cleanVideoId(app, ctx.locationId, ctx.body.video_id),
        chapters: cleanChapters(ctx.body.chapters),
        complete_percent: cleanCompletePercent(ctx.body.complete_percent),
        body: str(ctx.body.body, 'Text', { max: 100_000 }),
        downloads: ctx.body.downloads ? cleanDownloads(app, ctx.locationId, ctx.body.downloads) : [],
        duration_min: days(ctx.body.duration_min),
        drip_days: days(ctx.body.drip_days),
        published: ctx.body.published === false ? 0 : 1,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('course_lessons', l);
      touch(c.id);
      return l;
    });
    router.patch('/api/courses/:id/lessons/:lid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const l = mustLesson(c.id, ctx.params.lid);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: 160 });
      if (b.video_url !== undefined) patch.video_url = cleanVideo(b.video_url);
      if (b.video_id !== undefined) patch.video_id = cleanVideoId(app, ctx.locationId, b.video_id);
      if (b.chapters !== undefined) patch.chapters = cleanChapters(b.chapters);
      if (b.complete_percent !== undefined) patch.complete_percent = cleanCompletePercent(b.complete_percent);
      if (b.body !== undefined) patch.body = str(b.body, 'Text', { max: 100_000 });
      if (b.downloads !== undefined) patch.downloads = cleanDownloads(app, ctx.locationId, b.downloads);
      if (b.duration_min !== undefined) patch.duration_min = days(b.duration_min);
      if (b.drip_days !== undefined) patch.drip_days = days(b.drip_days);
      if (b.published !== undefined) patch.published = b.published ? 1 : 0;
      if (b.module_id !== undefined && b.module_id !== l.module_id) patch.module_id = mustModule(c.id, String(b.module_id)).id;
      db.update('course_lessons', l.id, patch);
      touch(c.id);
      return mustLesson(c.id, l.id);
    });
    router.delete('/api/courses/:id/lessons/:lid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      db.run('DELETE FROM course_lessons WHERE id = ? AND course_id = ?', ctx.params.lid, c.id);
      touch(c.id);
      return { ok: true };
    });
    /** New order of modules and lessons (lessons may move between modules): {modules: [{id, lessons: [id…]}]}. */
    router.post('/api/courses/:id/reorder', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const list = Array.isArray(ctx.body.modules) ? ctx.body.modules : [];
      const own = new Set(db.all<{ id: string }>('SELECT id FROM course_modules WHERE course_id = ?', c.id).map((r) => r.id));
      const ownLessons = new Set(db.all<{ id: string }>('SELECT id FROM course_lessons WHERE course_id = ?', c.id).map((r) => r.id));
      db.tx(() => {
        list.forEach((m: any, mi: number) => {
          if (!own.has(String(m?.id))) throw bad('Modul gehört nicht zu diesem Kurs');
          db.run('UPDATE course_modules SET position = ? WHERE id = ?', mi, m.id);
          (Array.isArray(m.lessons) ? m.lessons : []).forEach((lid: string, li: number) => {
            if (!ownLessons.has(String(lid))) throw bad('Lektion gehört nicht zu diesem Kurs');
            db.run('UPDATE course_lessons SET position = ?, module_id = ? WHERE id = ?', li, m.id, lid);
          });
        });
      });
      touch(c.id);
      return { modules: courseOutline(app, c.id) };
    });
    /** Chapters of an unsaved draft: text from the editor is read like on save; what does not parse falls back to the saved ones. */
    const draftChapters = (input: unknown, fallback: unknown) => {
      try {
        return cleanChapters(input);
      } catch {
        return fallback;
      }
    };
    /** The lesson as members will see it (unsaved changes included). */
    router.post('/api/courses/:id/lessons/:lid/preview', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const l = mustLesson(c.id, ctx.params.lid);
      const b = ctx.body ?? {};
      const draft = { ...l, title: b.title ?? l.title, video_url: b.video_url ?? l.video_url, video_id: b.video_id === undefined ? l.video_id : b.video_id || null, chapters: b.chapters === undefined ? l.chapters : draftChapters(b.chapters, l.chapters), body: b.body ?? l.body, downloads: Array.isArray(b.downloads) ? b.downloads : l.downloads, duration_min: b.duration_min ?? l.duration_min };
      const render = app.services.renderLessonPreview;
      if (!render) throw new HttpError(501, 'Vorschau nicht verfügbar');
      return html(render(ctx.locationId, c, draft));
    });

    // --- members ---------------------------------------------------------------------------
    router.get('/api/courses/:id/enrollments', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const outline = courseOutline(app, c.id, { publishedOnly: true });
      const total = flatLessons(outline).length;
      return db
        .all(
          `SELECT e.*, k.first_name, k.last_name, k.email, k.phone FROM course_enrollments e JOIN contacts k ON k.id = e.contact_id
           WHERE e.course_id = ? ORDER BY e.status, e.enrolled_at DESC LIMIT 2000`,
          c.id,
        )
        .map((e) => ({ ...e, progress: total ? enrollmentProgress(app, e, outline) : { done: 0, total: 0, percent: 0 } }));
    });
    router.post('/api/courses/:id/enrollments', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      let contactId = str(ctx.body.contact_id, 'Kontakt');
      if (contactId && !getContact(app, ctx.locationId, contactId)) throw notFound('Kontakt nicht gefunden');
      if (!contactId) {
        const email = normalizeEmail(ctx.body.email);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Kontakt oder gültige E-Mail angeben');
        contactId = upsertContact(app, ctx.locationId, { email, name: str(ctx.body.name, 'Name', { max: 120 }) }, { source: 'Kurse' }).contact.id;
      }
      const source = ctx.viaApiKey ? 'api' : 'manual';
      const r = grantAccess(app, ctx.locationId, c.id, contactId, source, ctx.user?.name ?? '');
      return { ...r.enrollment, changed: r.changed };
    });
    router.delete('/api/courses/:id/enrollments/:contactId', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      if (!revokeAccess(app, ctx.locationId, c.id, ctx.params.contactId, ctx.user?.name ? `von ${ctx.user.name}` : '')) throw notFound('Kein aktiver Zugang');
      return { ok: true };
    });
    router.post('/api/courses/:id/enrollments/:contactId/login-link', 'location', async (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const e = db.get(`SELECT * FROM course_enrollments WHERE course_id = ? AND contact_id = ? AND status = 'active'`, c.id, ctx.params.contactId);
      if (!e) throw notFound('Kein aktiver Zugang');
      const send = app.services.sendMemberLoginLink;
      if (!send) throw new HttpError(501, 'Mitgliederbereich nicht verfügbar');
      const r = await send(ctx.locationId, ctx.params.contactId);
      // Without a mail provider nothing leaves the server; admins get the link to test with.
      return { status: r.status, link: r.status === 'logged' && ctx.user?.role === 'admin' ? r.link : undefined };
    });

    router.get('/api/contacts/:id/courses', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.id)) throw notFound('Kontakt nicht gefunden');
      return contactEnrollments(app, ctx.locationId, ctx.params.id);
    });

    // --- automatic access ----------------------------------------------------------------
    const coursesWithTag = (loc: string, tag: string) =>
      db.all(`SELECT id FROM courses WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(courses.access, '$.tags') WHERE value = ?)`, loc, tag);
    app.events.on('contact.tag_added', (e) => {
      const { contactId, tag } = e.data;
      if (!contactId || !tag) return;
      for (const c of coursesWithTag(e.locationId, String(tag))) grantAccess(app, e.locationId, c.id, contactId, 'tag', String(tag));
    });
    app.events.on('contact.tag_removed', (e) => {
      const { contactId, tag } = e.data;
      if (!contactId || !tag) return;
      const contact = getContact(app, e.locationId, contactId);
      if (!contact) return;
      for (const row of coursesWithTag(e.locationId, String(tag))) {
        const c = getCourse(app, e.locationId, row.id)!;
        const en = db.get(`SELECT * FROM course_enrollments WHERE course_id = ? AND contact_id = ? AND status = 'active'`, c.id, contactId);
        if (!en || en.source !== 'tag' || c.access?.revoke_on_tag_removal === false) continue;
        // Still holding another access tag of this course? Then access stays.
        if ((c.access?.tags ?? []).some((t: string) => contact.tags.includes(t))) continue;
        revokeAccess(app, e.locationId, c.id, contactId, `Tag „${tag}“ entfernt`);
      }
    });
    // Product purchases (payments) grant the courses linked to that product.
    app.events.on('product.purchased', (e) => {
      const { contactId, productId } = e.data;
      if (!contactId || !productId) return;
      const list = db.all(`SELECT id FROM courses WHERE location_id = ? AND EXISTS (SELECT 1 FROM json_each(courses.access, '$.product_ids') WHERE value = ?)`, e.locationId, String(productId));
      for (const c of list) grantAccess(app, e.locationId, c.id, contactId, 'purchase', String(productId));
    });

    // Workflow actions „Kurszugang geben“ / „Kurszugang entziehen“.
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      course_grant: async (run: any, step: any) => {
        const c = getCourse(app, run.location_id, String(step.course_id ?? ''));
        if (!c) throw new Error('Kurs nicht gefunden');
        const r = grantAccess(app, run.location_id, c.id, run.contact_id, 'workflow', run.workflow_id);
        return r.changed ? `Zugang zu „${c.title}“ gegeben` : 'hatte schon Zugang';
      },
      course_revoke: async (run: any, step: any) => {
        const c = getCourse(app, run.location_id, String(step.course_id ?? ''));
        if (!c) throw new Error('Kurs nicht gefunden');
        return revokeAccess(app, run.location_id, c.id, run.contact_id, 'Workflow') ? `Zugang zu „${c.title}“ entzogen` : 'hatte keinen Zugang';
      },
    };
  },
};
