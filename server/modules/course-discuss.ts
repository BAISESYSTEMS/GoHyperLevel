import type { Ctx, RawResult } from '../core/http.js';
import { bad, notFound, redirect } from '../core/http.js';
import type { App, Module } from '../core/app.js';
import { escapeHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { courseSettings, getCourse, portalUrl } from '../services/courses.js';
import { buildThreads, cleanRating, cleanText, COMMENT_MAX, COMMENT_MIN, ratingSummary, replyTarget, stars, type Threaded } from '../services/course-community.js';
import { clip, deDate, limiter } from '../services/creator-kit.js';
import { logActivity } from '../services/contacts.js';
import { notifyTeam, sendToContact } from '../services/messaging.js';
import { registerTriggers } from '../services/wfx-kit.js';
import { PUSH_KINDS } from './push.js';

/**
 * Discussion under every lesson ("Fragen & Diskussion": threaded, a badge for the course team, notifications) and ratings & reviews of a
 * course (stars and text, optionally moderated, a reply from the team). Members write in the portal; the team answers and moderates in
 * Kurse → Diskussion / Bewertungen. Docs: docs/courses.md.
 */

const CSS = `<style>
.dc{margin-top:34px}.dc h2{display:flex;gap:8px;align-items:center}.dc .n{font-size:13px;font-weight:600;color:var(--muted)}
.dc form{margin:0}.dc textarea,.dc input[type=text]{width:100%;padding:12px;border:1px solid var(--line);border-radius:12px;font:inherit;background:var(--panel);color:var(--text)}.dc textarea{min-height:96px;resize:vertical}
.dc textarea:focus-visible,.dc input:focus-visible,.dc summary:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.dc .btn{min-height:48px}.dc .c{border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:0 0 10px;background:var(--panel)}
.dc .r{margin:10px 0 0 16px;padding-left:14px;border-left:3px solid var(--soft)}.dc .h{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:14px}
.dc .h b{font-weight:700}.dc .h time{color:var(--muted)}.dc .badge{background:var(--brand);color:#fff;border-radius:99px;font-size:11px;font-weight:700;padding:2px 9px}
.dc .t{margin:6px 0 0;white-space:pre-wrap;word-break:break-word}.dc details{margin-top:6px}.dc summary{cursor:pointer;min-height:44px;display:inline-flex;align-items:center;color:var(--brand);font-weight:600;font-size:14px}
.dc .x{background:none;border:0;color:var(--muted);font:inherit;font-size:13px;min-height:44px;padding:0 8px;cursor:pointer}.dc .x:hover{color:#dc2626}
.dc .stars{color:#f59e0b;letter-spacing:2px;font-size:18px}.dc .avg{display:flex;gap:12px;align-items:center;margin:0 0 14px}.dc .avg b{font-size:30px}
.dc .rate{display:flex;gap:4px;flex-direction:row-reverse;justify-content:flex-end;margin:0 0 10px}.dc .rate input{position:absolute;opacity:0;width:44px;height:44px}
.dc .rate label{font-size:34px;line-height:1;cursor:pointer;color:var(--line);min-width:44px;min-height:44px;display:grid;place-items:center}.dc .rate input:checked~label,.dc .rate label:hover,.dc .rate label:hover~label{color:#f59e0b}
.dc .rate input:focus-visible+label{outline:3px solid var(--brand);border-radius:8px}.dc .note{background:var(--soft);border-radius:12px;padding:10px 14px;margin:0 0 12px;font-size:14px}
</style>`;

const nameOf = (c: { first_name?: string; last_name?: string; email?: string }) => {
  const first = String(c.first_name ?? '').trim();
  const last = String(c.last_name ?? '').trim();
  return first ? `${first}${last ? ` ${last[0].toUpperCase()}.` : ''}` : 'Mitglied';
};

const REVIEW_STATUS = ['pending', 'published', 'rejected'];

export const courseDiscussModule: Module = {
  name: 'course-discuss',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE course_comments (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
        parent_id TEXT, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, author_name TEXT NOT NULL,
        staff INTEGER NOT NULL DEFAULT 0, user_id TEXT, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'visible',
        created_at TEXT NOT NULL, edited_at TEXT
      );
      CREATE INDEX course_comments_lesson ON course_comments(lesson_id, created_at);
      CREATE INDEX course_comments_course ON course_comments(course_id, created_at);
      CREATE TABLE course_reviews (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL, rating INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', reply TEXT NOT NULL DEFAULT '', replied_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(course_id, contact_id)
      );
      CREATE INDEX course_reviews_course ON course_reviews(course_id, status);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    Object.assign(PUSH_KINDS, { courses: { label: 'Kurse: neue Kommentare und Bewertungen', perm: 'courses' } });
    registerTriggers(app, [
      {
        type: 'course.comment_posted',
        label: 'Kommentar in einer Lektion',
        category: 'content',
        summary: 'Ein Teilnehmer schreibt einen Kommentar oder eine Antwort unter eine Lektion.',
        doc: '{{event.lesson.title}} nennt die Lektion, {{event.course.title}} den Kurs. Antworten des Teams starten nichts.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }],
        sample: { contactId: 'c1', courseId: 'k1', lessonId: 'l1', commentId: 'm1', parentId: null, staff: false, course: { id: 'k1', title: 'Online-Kurs' }, lesson: { id: 'l1', title: 'Einführung' } },
        keywords: 'kurs kommentar frage diskussion lektion',
      },
      {
        type: 'course.review_posted',
        label: 'Kurs bewertet',
        category: 'content',
        summary: 'Ein Teilnehmer bewertet einen Kurs (Sterne und optional Text).',
        doc: '{{event.rating}} sind die Sterne (1–5), {{event.status}} ist pending oder published. Passend für „bei 5 Sternen um eine Google-Bewertung bitten“.',
        fields: [{ key: 'course_id', label: 'Nur für Kurs', type: 'text' }, { key: 'min_rating', label: 'Mindestens Sterne', type: 'number' }],
        sample: { contactId: 'c1', courseId: 'k1', rating: 5, status: 'published', course: { id: 'k1', title: 'Online-Kurs' } },
        keywords: 'kurs bewertung sterne rezension feedback',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'course.comment_posted': (c: any, d: any) => !d.staff && (!c.course_id || c.course_id === d.courseId),
      'course.review_posted': (c: any, d: any) => (!c.course_id || c.course_id === d.courseId) && (!Number(c.min_rating) || d.rating >= Number(c.min_rating)),
    };
    const kit = () => app.services.courseKit;
    const portal = () => app.services.portalKit;
    const commentLimit = limiter(12, 3600_000);
    const reviewLimit = limiter(6, 3600_000);
    const mailedAt = new Map<string, number>();

    const mustCourse = (loc: string, cid: string) => {
      const c = getCourse(app, loc, cid);
      if (!c) throw notFound('Kurs nicht gefunden');
      return c;
    };
    const lessonUrl = (loc: string, course: { slug: string }, lessonId: string) => `${portalUrl(app, loc)}/c/${encodeURIComponent(course.slug)}/${encodeURIComponent(lessonId)}`;

    /** Team gets a push and (at most every 10 minutes per course) an e-mail. */
    const tellTeam = (loc: string, course: any, title: string, text: string, url: string) => {
      void Promise.resolve(app.services.pushNotify?.({ locationId: loc, kind: 'courses', title: title.slice(0, 100), body: text, url: `/app/courses/${course.id}`, tag: `course-${course.id}` })).catch(() => undefined);
      if (Date.now() - (mailedAt.get(course.id) ?? 0) < 10 * 60_000) return;
      mailedAt.set(course.id, Date.now());
      void notifyTeam(app, loc, title, `${text}\n\n${url}`).catch((e) => console.error('[course-discuss] mail', (e as Error).message));
    };
    const tellMember = (loc: string, contactId: string, course: any, lessonId: string, from: string, text: string) => {
      const lesson = db.get<{ title: string }>('SELECT title FROM course_lessons WHERE id = ?', lessonId);
      void sendToContact(app, loc, {
        contactId,
        channel: 'email',
        subject: `Neue Antwort auf deinen Kommentar in „${course.title}“`,
        body: `Hallo,\n\n${from} hat auf deinen Kommentar in der Lektion „${lesson?.title ?? ''}“ geantwortet:\n\n${clip(text, 400)}\n\nZur Diskussion:\n${lessonUrl(loc, course, lessonId)}#diskussion`,
        source: 'Kurse',
        purpose: 'transactional',
      }).catch((e) => console.error('[course-discuss] mail', (e as Error).message));
    };

    // --- comments: the team ------------------------------------------------------------------------------------------------------
    const commentOut = (r: any) => ({ ...r, staff: !!r.staff });
    router.get('/api/courses/:id/comments', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const where = ['k.course_id = ?'];
      const args: (string | number)[] = [c.id];
      const status = ctx.query.get('status');
      if (status === 'visible' || status === 'hidden') (where.push('k.status = ?'), args.push(status));
      const lesson = ctx.query.get('lesson_id');
      if (lesson) (where.push('k.lesson_id = ?'), args.push(lesson));
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 100);
      if (q) (where.push(`(k.body LIKE ? ESCAPE '\\' OR k.author_name LIKE ? ESCAPE '\\')`), args.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`, `%${q.replace(/[%_\\]/g, '\\$&')}%`));
      const rows = db.all<any>(
        `SELECT k.*, l.title AS lesson_title,
           (SELECT COUNT(*) FROM course_comments r WHERE r.parent_id = k.id AND r.staff = 1 AND r.status = 'visible') AS team_replies
         FROM course_comments k JOIN course_lessons l ON l.id = k.lesson_id WHERE ${where.join(' AND ')} ORDER BY k.created_at DESC LIMIT 500`,
        ...args,
      );
      const out = rows.map((r) => ({ ...commentOut(r), needs_reply: !r.staff && !r.parent_id && r.status === 'visible' && !r.team_replies }));
      return ctx.query.get('needs_reply') === '1' ? out.filter((r) => r.needs_reply) : out;
    });
    router.post('/api/courses/:id/comments', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const lesson = db.get<any>('SELECT id, title FROM course_lessons WHERE id = ? AND course_id = ?', String(ctx.body?.lesson_id ?? ''), c.id);
      if (!lesson) throw notFound('Lektion nicht gefunden');
      let parent: string | null = null;
      if (ctx.body?.parent_id) {
        const p = db.get<any>('SELECT * FROM course_comments WHERE id = ? AND lesson_id = ?', String(ctx.body.parent_id), lesson.id);
        if (!p) throw notFound('Kommentar nicht gefunden');
        parent = replyTarget(db.all('SELECT id, parent_id FROM course_comments WHERE lesson_id = ?', lesson.id), p.id);
      }
      const body = cleanText(ctx.body?.body, 'Antwort', { min: COMMENT_MIN, max: COMMENT_MAX });
      const row = { id: id(), location_id: ctx.locationId, course_id: c.id, lesson_id: lesson.id, parent_id: parent, contact_id: null, author_name: ctx.user?.name || 'Kursleitung', staff: 1, user_id: ctx.user?.id ?? null, body, status: 'visible', created_at: now(), edited_at: null };
      db.insert('course_comments', row);
      app.events.emit(ctx.locationId, 'course.comment_posted', { courseId: c.id, lessonId: lesson.id, commentId: row.id, parentId: parent, staff: true });
      // The member who wrote the comment below gets told.
      const target = parent ? db.get<any>('SELECT * FROM course_comments WHERE id = ?', parent) : undefined;
      if (target?.contact_id && !target.staff) tellMember(ctx.locationId, target.contact_id, c, lesson.id, row.author_name, body);
      return commentOut(row);
    });
    router.patch('/api/courses/:id/comments/:cid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const k = db.get<any>('SELECT * FROM course_comments WHERE id = ? AND course_id = ?', ctx.params.cid, c.id);
      if (!k) throw notFound('Kommentar nicht gefunden');
      const patch: Record<string, any> = {};
      if (ctx.body?.status !== undefined) {
        if (!['visible', 'hidden'].includes(ctx.body.status)) throw bad('Unbekannter Status');
        patch.status = ctx.body.status;
      }
      if (ctx.body?.body !== undefined) {
        if (!k.staff) throw bad('Nur eigene Antworten des Teams lassen sich ändern');
        patch.body = cleanText(ctx.body.body, 'Antwort', { min: COMMENT_MIN, max: COMMENT_MAX });
        patch.edited_at = now();
      }
      if (Object.keys(patch).length) db.update('course_comments', k.id, patch);
      return commentOut(db.get('SELECT * FROM course_comments WHERE id = ?', k.id));
    });
    router.delete('/api/courses/:id/comments/:cid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      if (!removeComment(c.id, ctx.params.cid)) throw notFound('Kommentar nicht gefunden');
      return { ok: true };
    });
    /** A comment and everything below it. */
    function removeComment(courseId: string, commentId: string): boolean {
      const rows = db.all<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM course_comments WHERE course_id = ?', courseId);
      if (!rows.some((r) => r.id === commentId)) return false;
      const gone = new Set([commentId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const r of rows) if (r.parent_id && gone.has(r.parent_id) && !gone.has(r.id)) (gone.add(r.id), (grew = true));
      }
      db.tx(() => {
        for (const g of gone) db.run('DELETE FROM course_comments WHERE id = ?', g);
      });
      return true;
    }

    // --- comments: members ----------------------------------------------------------------------------------------------------------
    const seatAndLesson = (ctx: Ctx) => {
      const p = portal()?.resolve(ctx.params.p);
      if (!p) return { error: portal()?.unknownPortal() as RawResult };
      const m = portal().memberOf(ctx, p);
      if (!m) return { error: redirect(p.base, 303) };
      if (!portal().sameOrigin(ctx)) return { error: portal().notFoundPage(p, m) as RawResult };
      const s = kit().seat(p, m.contact.id, ctx.params.course);
      const l = s?.lessons.find((x: any) => x.id === ctx.params.lesson);
      if (!s || !l || !kit().open(s, l)) return { error: portal().notFoundPage(p, m) as RawResult };
      return { p, m, s, l };
    };
    const back = (p: any, s: any, l: any, query = '') => redirect(`${kit().lessonHref(p, s.course, l)}${query}#diskussion`, 303);

    router.post('/portal/:p/c/:course/:lesson/comments', 'public', (ctx) => {
      const got = seatAndLesson(ctx);
      if (got.error) return got.error;
      const { p, m, s, l } = got as any;
      if (!courseSettings(s.course).comments_enabled) return portal().notFoundPage(p, m);
      if (commentLimit(m.contact.id)) return back(p, s, l, '?kommentar=zuviele');
      let body: string;
      try {
        body = cleanText(ctx.body?.body, 'Kommentar', { min: COMMENT_MIN, max: COMMENT_MAX });
      } catch {
        return back(p, s, l, String(ctx.body?.body ?? '').trim().length > COMMENT_MAX ? '?kommentar=zulang' : '?kommentar=leer');
      }
      let parent: string | null = null;
      if (ctx.body?.parent) {
        const par = db.get<any>(`SELECT id FROM course_comments WHERE id = ? AND lesson_id = ? AND status = 'visible'`, String(ctx.body.parent), l.id);
        if (!par) return back(p, s, l);
        parent = replyTarget(db.all('SELECT id, parent_id FROM course_comments WHERE lesson_id = ?', l.id), par.id);
      }
      const row = { id: id(), location_id: p.locationId, course_id: s.course.id, lesson_id: l.id, parent_id: parent, contact_id: m.contact.id, author_name: nameOf(m.contact), staff: 0, user_id: null, body, status: 'visible', created_at: now(), edited_at: null };
      db.insert('course_comments', row);
      logActivity(app, p.locationId, m.contact.id, 'course.comment', `Kommentar in „${l.title}“ (${s.course.title})`);
      app.events.emit(p.locationId, 'course.comment_posted', { contactId: m.contact.id, courseId: s.course.id, lessonId: l.id, commentId: row.id, parentId: parent, staff: false, course: { id: s.course.id, title: s.course.title }, lesson: { id: l.id, title: l.title } });
      tellTeam(p.locationId, s.course, `Neuer Kommentar in „${s.course.title}“`, `${row.author_name} in „${l.title}“:\n${clip(body, 300)}`, `${lessonUrl(p.locationId, s.course, l.id)}#diskussion`);
      const target = parent ? db.get<any>('SELECT * FROM course_comments WHERE id = ?', parent) : undefined;
      if (target?.contact_id && target.contact_id !== m.contact.id) tellMember(p.locationId, target.contact_id, s.course, l.id, row.author_name, body);
      return back(p, s, l, '?kommentar=ok');
    });
    router.post('/portal/:p/c/:course/:lesson/comments/:cid/delete', 'public', (ctx) => {
      const got = seatAndLesson(ctx);
      if (got.error) return got.error;
      const { m, s, l, p } = got as any;
      const k = db.get<any>('SELECT * FROM course_comments WHERE id = ? AND lesson_id = ? AND contact_id = ?', ctx.params.cid, l.id, m.contact.id);
      if (k) removeComment(s.course.id, k.id);
      return back(p, s, l);
    });

    // --- the discussion block under a lesson -----------------------------------------------------------------------------------------
    const flash: Record<string, string> = { ok: 'Danke – dein Kommentar ist da.', zulang: `Der Kommentar ist zu lang (höchstens ${COMMENT_MAX} Zeichen).`, leer: 'Bitte schreibe etwas (mindestens zwei Zeichen).', zuviele: 'Das waren viele Kommentare in kurzer Zeit – bitte in ein paar Minuten wieder.' };
    app.services.lessonExtras = [
      ...((app.services.lessonExtras as unknown[] | undefined) ?? []),
      (p: any, m: any, s: any, l: any, query: URLSearchParams) => {
        if (!courseSettings(s.course).comments_enabled) return undefined;
        const rows = db.all<any>('SELECT * FROM course_comments WHERE lesson_id = ? ORDER BY created_at', l.id);
        const tree = buildThreads(rows);
        const action = `${kit().lessonHref(p, s.course, l)}/comments`;
        const tz = p.loc.timezone;
        const item = (c: Threaded<any>): string => `<div class="c" id="k-${escapeHtml(c.id)}"><div class="h"><b>${escapeHtml(c.author_name)}</b>${c.staff ? '<span class="badge">Kursleitung</span>' : ''}<time datetime="${escapeHtml(c.created_at)}">${escapeHtml(deDate(c.created_at, tz))}</time>${c.contact_id === m.contact.id ? `<form method="post" action="${action}/${escapeHtml(c.id)}/delete" style="margin-left:auto"><button class="x" onclick="return confirm('Kommentar löschen?')">Löschen</button></form>` : ''}</div>
<p class="t">${escapeHtml(c.body)}</p>
<details><summary>Antworten</summary><form method="post" action="${action}"><input type="hidden" name="parent" value="${escapeHtml(c.id)}"><textarea name="body" maxlength="${COMMENT_MAX}" required aria-label="Deine Antwort"></textarea><p><button class="btn ghost">Antwort senden</button></p></form></details>
${c.replies.length ? `<div class="r">${c.replies.map(item).join('')}</div>` : ''}</div>`;
        const msg = flash[query?.get('kommentar') ?? ''];
        return {
          html: `${CSS}<section class="dc" id="diskussion"><h2>Fragen &amp; Diskussion <span class="n">${rows.filter((r) => r.status === 'visible').length}</span></h2>
${msg ? `<div class="note" role="status">${escapeHtml(msg)}</div>` : ''}<form method="post" action="${action}"><textarea name="body" maxlength="${COMMENT_MAX}" required placeholder="Frage oder Gedanke zu dieser Lektion …" aria-label="Neuer Kommentar"></textarea><p><button class="btn">Kommentar senden</button></p></form>
${tree.map(item).join('') || '<p class="muted">Noch keine Kommentare – stell die erste Frage.</p>'}</section>`,
        };
      },
    ];

    // --- reviews: the team -----------------------------------------------------------------------------------------------------------
    router.get('/api/courses/:id/reviews', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const status = ctx.query.get('status');
      const rows = db.all<any>(
        `SELECT r.*, k.email FROM course_reviews r LEFT JOIN contacts k ON k.id = r.contact_id WHERE r.course_id = ? ${REVIEW_STATUS.includes(String(status)) ? 'AND r.status = ?' : ''} ORDER BY r.created_at DESC LIMIT 500`,
        ...(REVIEW_STATUS.includes(String(status)) ? [c.id, status] : [c.id]),
      );
      const published = db.all<{ rating: number }>(`SELECT rating FROM course_reviews WHERE course_id = ? AND status = 'published'`, c.id).map((r) => r.rating);
      return { summary: ratingSummary(published), pending: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM course_reviews WHERE course_id = ? AND status = 'pending'`, c.id)!.n, reviews: rows };
    });
    router.patch('/api/courses/:id/reviews/:rid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      const r = db.get<any>('SELECT * FROM course_reviews WHERE id = ? AND course_id = ?', ctx.params.rid, c.id);
      if (!r) throw notFound('Bewertung nicht gefunden');
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body?.status !== undefined) {
        if (!REVIEW_STATUS.includes(ctx.body.status)) throw bad('Unbekannter Status');
        patch.status = ctx.body.status;
      }
      if (ctx.body?.reply !== undefined) {
        patch.reply = cleanText(ctx.body.reply, 'Antwort', { max: 1000 });
        patch.replied_at = patch.reply ? now() : null;
      }
      db.update('course_reviews', r.id, patch);
      return db.get('SELECT * FROM course_reviews WHERE id = ?', r.id);
    });
    router.delete('/api/courses/:id/reviews/:rid', 'location', (ctx) => {
      const c = mustCourse(ctx.locationId, ctx.params.id);
      if (!db.run('DELETE FROM course_reviews WHERE id = ? AND course_id = ?', ctx.params.rid, c.id).changes) throw notFound('Bewertung nicht gefunden');
      return { ok: true };
    });

    // --- reviews: members -----------------------------------------------------------------------------------------------------------------
    const seatOnly = (ctx: Ctx) => {
      const p = portal()?.resolve(ctx.params.p);
      if (!p) return { error: portal()?.unknownPortal() as RawResult };
      const m = portal().memberOf(ctx, p);
      if (!m) return { error: redirect(p.base, 303) };
      if (!portal().sameOrigin(ctx)) return { error: portal().notFoundPage(p, m) as RawResult };
      const s = kit().seat(p, m.contact.id, ctx.params.course);
      if (!s) return { error: portal().notFoundPage(p, m) as RawResult };
      return { p, m, s };
    };
    router.post('/portal/:p/c/:course/review', 'public', (ctx) => {
      const got = seatOnly(ctx);
      if (got.error) return got.error;
      const { p, m, s } = got as any;
      const st = courseSettings(s.course);
      const here = `${kit().courseHref(p, s.course)}`;
      if (!st.reviews_enabled || s.progress.percent < st.reviews_min_percent) return portal().notFoundPage(p, m);
      if (reviewLimit(m.contact.id)) return redirect(`${here}?bewertung=zuviele#bewertungen`, 303);
      let rating: number;
      let title: string;
      let body: string;
      try {
        rating = cleanRating(ctx.body?.rating);
        title = cleanText(ctx.body?.title, 'Titel', { max: 100 });
        body = cleanText(ctx.body?.body, 'Bewertung', { max: 2000 });
      } catch {
        return redirect(`${here}?bewertung=fehler#bewertungen`, 303);
      }
      const cur = db.get<any>('SELECT * FROM course_reviews WHERE course_id = ? AND contact_id = ?', s.course.id, m.contact.id);
      const status = st.reviews_moderation ? 'pending' : 'published';
      if (cur) db.update('course_reviews', cur.id, { rating, title, body, status, updated_at: now(), author_name: nameOf(m.contact) });
      else db.insert('course_reviews', { id: id(), location_id: p.locationId, course_id: s.course.id, contact_id: m.contact.id, author_name: nameOf(m.contact), rating, title, body, status, reply: '', replied_at: null, created_at: now(), updated_at: now() });
      logActivity(app, p.locationId, m.contact.id, 'course.review', `Kurs „${s.course.title}“ mit ${rating} Sternen bewertet`);
      app.events.emit(p.locationId, 'course.review_posted', { contactId: m.contact.id, courseId: s.course.id, rating, status, course: { id: s.course.id, title: s.course.title } });
      tellTeam(p.locationId, s.course, `Neue Bewertung für „${s.course.title}“`, `${nameOf(m.contact)}: ${rating} von 5 Sternen${title ? ` – ${title}` : ''}${st.reviews_moderation ? '\n(wartet auf Freigabe)' : ''}`, `${app.baseUrl()}/app/courses/${s.course.id}`);
      return redirect(`${here}?bewertung=ok#bewertungen`, 303);
    });
    router.post('/portal/:p/c/:course/review/delete', 'public', (ctx) => {
      const got = seatOnly(ctx);
      if (got.error) return got.error;
      const { p, m, s } = got as any;
      db.run('DELETE FROM course_reviews WHERE course_id = ? AND contact_id = ?', s.course.id, m.contact.id);
      return redirect(`${kit().courseHref(p, s.course)}#bewertungen`, 303);
    });

    const reviewFlash: Record<string, string> = { ok: 'Danke für deine Bewertung!', fehler: 'Bitte vergib 1 bis 5 Sterne.', zuviele: 'Bitte in ein paar Minuten noch einmal versuchen.' };
    app.services.courseExtras = [
      ...((app.services.courseExtras as unknown[] | undefined) ?? []),
      (p: any, m: any, s: any, query: URLSearchParams) => {
        const st = courseSettings(s.course);
        if (!st.reviews_enabled) return undefined;
        const all = db.all<any>(`SELECT * FROM course_reviews WHERE course_id = ? ORDER BY created_at DESC`, s.course.id);
        const published = all.filter((r) => r.status === 'published');
        const sum = ratingSummary(published.map((r) => r.rating));
        const mine = all.find((r) => r.contact_id === m.contact.id);
        const tz = p.loc.timezone;
        const action = `${kit().courseHref(p, s.course)}/review`;
        const can = s.progress.percent >= st.reviews_min_percent;
        const form = can
          ? `<form method="post" action="${action}"><fieldset style="border:0;padding:0;margin:0"><legend class="small muted">${mine ? 'Deine Bewertung ändern' : 'Bewerte diesen Kurs'}</legend>
<div class="rate">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="rt${n}" value="${n}"${mine?.rating === n ? ' checked' : ''} required><label for="rt${n}" title="${n} Sterne" aria-label="${n} Sterne">★</label>`).join('')}</div></fieldset>
<p><input type="text" name="title" maxlength="100" placeholder="Überschrift (optional)" aria-label="Überschrift" value="${escapeHtml(mine?.title ?? '')}"></p>
<p><textarea name="body" maxlength="2000" placeholder="Was hat dir gefallen? Was könnte besser sein? (optional)" aria-label="Deine Bewertung">${escapeHtml(mine?.body ?? '')}</textarea></p>
<p><button class="btn">${mine ? 'Bewertung speichern' : 'Bewertung abschicken'}</button></p></form>${mine ? `<form method="post" action="${action}/delete"><button class="x" onclick="return confirm('Bewertung löschen?')">Meine Bewertung löschen</button></form>` : ''}`
          : `<p class="muted small">Du kannst den Kurs bewerten, sobald du ${st.reviews_min_percent} % geschafft hast.</p>`;
        const status = mine ? `<div class="note">${mine.status === 'published' ? 'Deine Bewertung ist veröffentlicht.' : mine.status === 'pending' ? 'Deine Bewertung wartet auf die Freigabe durch das Team.' : 'Deine Bewertung wurde nicht veröffentlicht.'}</div>` : '';
        const list = published
          .slice(0, 12)
          .map(
            (r) => `<div class="c"><div class="h"><span class="stars" aria-label="${r.rating} von 5 Sternen">${stars(r.rating)}</span><b>${escapeHtml(r.author_name)}</b><time datetime="${escapeHtml(r.created_at)}">${escapeHtml(deDate(r.created_at, tz))}</time></div>${r.title ? `<p class="t"><b>${escapeHtml(r.title)}</b></p>` : ''}${r.body ? `<p class="t">${escapeHtml(r.body)}</p>` : ''}${r.reply ? `<div class="r"><div class="h"><b>Antwort der Kursleitung</b><span class="badge">Kursleitung</span></div><p class="t">${escapeHtml(r.reply)}</p></div>` : ''}</div>`,
          )
          .join('');
        const msg = reviewFlash[query?.get('bewertung') ?? ''];
        return {
          bottom: `${CSS}<section class="dc panel" id="bewertungen" style="margin-top:22px"><h2>Bewertungen</h2>${sum.count ? `<div class="avg"><b>${String(sum.average).replace('.', ',')}</b><span class="stars" aria-hidden="true">${stars(sum.average)}</span><span class="muted">${sum.count} ${sum.count === 1 ? 'Bewertung' : 'Bewertungen'}</span></div>` : '<p class="muted">Noch keine Bewertungen.</p>'}${msg ? `<div class="note" role="status">${escapeHtml(msg)}</div>` : ''}${status}${form}${list ? `<div style="margin-top:16px">${list}</div>` : ''}</section>`,
        };
      },
    ];
    // GDPR: a contact's comments leave with them; where others answered, the thread keeps a neutral stub (the generic eraser then
    // finds no row of theirs). Reviews have a contact link and are deleted with it.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, c: { id: string }) => {
        for (const r of db.all<{ id: string }>('SELECT id FROM course_comments WHERE contact_id = ? AND location_id = ?', c.id, loc)) {
          const answered = db.get('SELECT 1 AS x FROM course_comments WHERE parent_id = ? AND location_id = ?', r.id, loc);
          if (answered) db.run(`UPDATE course_comments SET contact_id = NULL, author_name = 'Gelöscht (DSGVO)', body = '[Kommentar gelöscht]' WHERE id = ?`, r.id);
        }
      },
    ];
  },
};
