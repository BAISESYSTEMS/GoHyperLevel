import type { Module } from '../core/app.js';
import { notFound, text } from '../core/http.js';
import { ratingSummary } from '../services/course-community.js';
import { courseOutline, flatLessons, getCourse } from '../services/courses.js';

/**
 * Course analytics (docs/courses.md): per lesson how many opened it, finished it and where they dropped off (with the retention curve of
 * hosted videos), completion and watch time of the course, quiz scores, reviews, open questions – optionally for one cohort.
 */

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Share of viewers who got at least this far, for 10 %, 20 % … 100 % of the video. */
export function retentionCurve(ratios: number[]): number[] {
  if (!ratios.length) return [];
  return Array.from({ length: 10 }, (_v, i) => Math.round((ratios.filter((r) => r >= (i + 1) / 10 - 1e-9).length / ratios.length) * 100));
}

const monday = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x;
};

export const courseAnalyticsModule: Module = {
  name: 'course-analytics',
  register(app) {
    const { db, router } = app;

    function analytics(locationId: string, courseId: string, cohortId = '') {
      const course = getCourse(app, locationId, courseId);
      if (!course) throw notFound('Kurs nicht gefunden');
      const outline = courseOutline(app, course.id, { publishedOnly: true });
      const lessons = flatLessons(outline);
      const scope = `e.course_id = ? AND e.status = 'active'${cohortId ? ' AND e.cohort_id = ?' : ''}`;
      const args = cohortId ? [course.id, cohortId] : [course.id];
      const enrollments = db.all<any>(`SELECT e.id, e.started_at, e.completed_at, e.enrolled_at FROM course_enrollments e WHERE ${scope}`, ...args);
      const total = lessons.length;
      const lessonIds = new Set(lessons.map((l) => l.id));

      const progress = new Map(
        db
          .all<{ lesson_id: string; viewed: number; completed: number }>(
            `SELECT cp.lesson_id, SUM(CASE WHEN cp.last_viewed_at IS NOT NULL OR cp.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS viewed, SUM(CASE WHEN cp.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
             FROM course_progress cp JOIN course_enrollments e ON e.id = cp.enrollment_id WHERE ${scope} GROUP BY cp.lesson_id`,
            ...args,
          )
          .map((r) => [r.lesson_id, r]),
      );
      const playback = db.all<{ lesson_id: string; duration_sec: number; furthest_sec: number; watched_sec: number }>(
        `SELECT pb.lesson_id, pb.duration_sec, pb.furthest_sec, pb.watched_sec FROM course_playback pb JOIN course_enrollments e ON e.id = pb.enrollment_id WHERE ${scope}`,
        ...args,
      );
      const pbBy = new Map<string, typeof playback>();
      for (const r of playback) pbBy.set(r.lesson_id, [...(pbBy.get(r.lesson_id) ?? []), r]);

      let prevViewed = 0;
      const rows = lessons.map((l, i) => {
        const p = progress.get(l.id);
        const viewed = p?.viewed ?? 0;
        const completed = p?.completed ?? 0;
        const pbs = (pbBy.get(l.id) ?? []).filter((r) => r.duration_sec > 0);
        const video = l.video_id
          ? {
              hosted: true,
              viewers: pbs.length,
              avg_watched_percent: pbs.length ? Math.round((pbs.reduce((n, r) => n + Math.min(r.watched_sec / r.duration_sec, 1), 0) / pbs.length) * 100) : 0,
              avg_furthest_percent: pbs.length ? Math.round((pbs.reduce((n, r) => n + Math.min(r.furthest_sec / r.duration_sec, 1), 0) / pbs.length) * 100) : 0,
              watch_minutes: Math.round((pbs.reduce((n, r) => n + r.watched_sec, 0) / 60) * 10) / 10,
              retention: retentionCurve(pbs.map((r) => Math.min(r.furthest_sec / r.duration_sec, 1))),
            }
          : null;
        const row = {
          id: l.id,
          title: l.title,
          module: l.module.title,
          position: i + 1,
          viewed,
          completed,
          viewed_percent: pct(viewed, enrollments.length),
          completion_percent: pct(completed, enrollments.length),
          /** Share of the people who opened the lesson before this one and did not open this one. */
          drop_off_percent: i > 0 && prevViewed > 0 ? Math.max(0, Math.round((1 - viewed / prevViewed) * 100)) : 0,
          video,
        };
        prevViewed = viewed;
        return row;
      });
      const worst = rows.filter((r) => r.position > 1 && r.drop_off_percent > 0).sort((a, b) => b.drop_off_percent - a.drop_off_percent)[0];

      // Per member: finished lessons of the course.
      const doneBy = new Map(
        db
          .all<{ enrollment_id: string; n: number }>(
            `SELECT cp.enrollment_id, COUNT(*) AS n FROM course_progress cp JOIN course_enrollments e ON e.id = cp.enrollment_id WHERE ${scope} AND cp.completed_at IS NOT NULL GROUP BY cp.enrollment_id`,
            ...args,
          )
          .map((r) => [r.enrollment_id, r.n]),
      );
      const avgProgress = enrollments.length && total ? Math.round(enrollments.reduce((n, e) => n + Math.min((doneBy.get(e.id) ?? 0) / total, 1), 0) / enrollments.length * 100) : 0;
      const watchedSec = playback.reduce((n, r) => n + r.watched_sec, 0);
      const completed = enrollments.filter((e) => e.completed_at).length;

      const quizzes = db.all<any>('SELECT id, lesson_id, title, pass_percent FROM quizzes WHERE course_id = ?', course.id).filter((q) => lessonIds.has(q.lesson_id));
      const quizRows = quizzes.map((q) => {
        const att = db.all<{ contact_id: string; percent: number; passed: number }>(
          `SELECT a.contact_id, a.percent, a.passed FROM quiz_attempts a JOIN course_enrollments e ON e.id = a.enrollment_id WHERE a.quiz_id = ? AND a.status = 'graded' AND ${scope}`,
          q.id,
          ...args,
        );
        const best = new Map<string, { percent: number; passed: number }>();
        for (const a of att) if (!best.has(a.contact_id) || a.percent > best.get(a.contact_id)!.percent) best.set(a.contact_id, { percent: a.percent, passed: a.passed });
        const takers = best.size;
        return {
          quiz_id: q.id,
          lesson_id: q.lesson_id,
          title: q.title || lessons.find((l) => l.id === q.lesson_id)?.title || 'Quiz',
          pass_percent: q.pass_percent,
          attempts: att.length,
          takers,
          avg_percent: att.length ? Math.round(att.reduce((n, a) => n + a.percent, 0) / att.length) : 0,
          avg_best_percent: takers ? Math.round([...best.values()].reduce((n, a) => n + a.percent, 0) / takers) : 0,
          pass_rate: takers ? pct([...best.values()].filter((a) => a.passed).length, takers) : 0,
        };
      });

      const published = db.all<{ rating: number }>(`SELECT rating FROM course_reviews WHERE course_id = ? AND status = 'published'`, course.id).map((r) => r.rating);
      const comments = db.get<{ total: number; open: number }>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN k.staff = 0 AND k.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM course_comments r WHERE r.parent_id = k.id AND r.staff = 1 AND r.status = 'visible') THEN 1 ELSE 0 END) AS open
         FROM course_comments k WHERE k.course_id = ? AND k.status = 'visible'`,
        course.id,
      )!;

      // The last twelve weeks: new members and finishers.
      const start = monday(new Date());
      start.setUTCDate(start.getUTCDate() - 11 * 7);
      const weekly = Array.from({ length: 12 }, (_v, i) => {
        const from = new Date(start);
        from.setUTCDate(from.getUTCDate() + i * 7);
        const to = new Date(from);
        to.setUTCDate(to.getUTCDate() + 7);
        const within = (iso: string | null) => !!iso && iso >= from.toISOString() && iso < to.toISOString();
        return { week: from.toISOString().slice(0, 10), enrolled: enrollments.filter((e) => within(e.enrolled_at)).length, completed: enrollments.filter((e) => within(e.completed_at)).length };
      });

      return {
        course: { id: course.id, title: course.title },
        cohort_id: cohortId || null,
        totals: {
          enrolled: enrollments.length,
          started: enrollments.filter((e) => e.started_at || doneBy.has(e.id)).length,
          completed,
          completion_percent: pct(completed, enrollments.length),
          avg_progress_percent: avgProgress,
          lessons: total,
          watch_hours: round1(watchedSec / 3600),
          avg_watch_minutes: enrollments.length ? round1(watchedSec / 60 / enrollments.length) : 0,
        },
        biggest_drop: worst ? { lesson_id: worst.id, title: worst.title, percent: worst.drop_off_percent } : null,
        lessons: rows,
        quizzes: quizRows,
        reviews: { ...ratingSummary(published), pending: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM course_reviews WHERE course_id = ? AND status = 'pending'`, course.id)!.n },
        comments: { total: comments.total, unanswered: comments.open ?? 0 },
        weekly,
      };
    }

    const cohortArg = (ctx: { query: URLSearchParams; locationId: string }, courseId: string) => {
      const c = ctx.query.get('cohort') ?? '';
      if (c && !db.get('SELECT id FROM course_cohorts WHERE id = ? AND course_id = ? AND location_id = ?', c, courseId, ctx.locationId)) throw notFound('Cohort nicht gefunden');
      return c;
    };
    router.get('/api/courses/:id/analytics', 'location', (ctx) => analytics(ctx.locationId, ctx.params.id, cohortArg(ctx, ctx.params.id)));
    router.get('/api/courses/:id/analytics.csv', 'location', (ctx) => {
      const a = analytics(ctx.locationId, ctx.params.id, cohortArg(ctx, ctx.params.id));
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
      const head = ['Nr', 'Lektion', 'Modul', 'Geöffnet', 'Abgeschlossen', 'Geöffnet %', 'Abgeschlossen %', 'Abbruch gegenüber Vorgänger %', 'Video gesehen % (Ø)', 'Video-Zuschauer'];
      const lines = a.lessons.map((l) => [l.position, q(l.title), q(l.module), l.viewed, l.completed, l.viewed_percent, l.completion_percent, l.drop_off_percent, l.video?.avg_watched_percent ?? '', l.video?.viewers ?? ''].join(';'));
      const r = text(`﻿${head.join(';')}\n${lines.join('\n')}\n`, 'text/csv; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="kurs-analyse.csv"`;
      return r;
    });
  },
};
