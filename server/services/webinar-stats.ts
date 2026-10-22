import type { App } from '../core/app.js';
import { nowOf } from './webinar-register.js';
import { pollCounts } from './webinar-track.js';
import type { Webinar } from './webinar-store.js';

/**
 * Numbers per webinar and session: registrations, show-up rate, average watch time, drop-off curve, clicks on the offer,
 * sales and revenue. Everything is counted from the registrations (one row per person and session), so the totals are
 * exactly the sum of the sessions.
 */

export interface SessionStats {
  /** ISO start; on-demand registrations are one group ("ondemand"). */
  start: string;
  kind: string;
  registrations: number;
  attended: number;
  /** attended / registrations – null while the session has not started. */
  show_up_rate: number | null;
  avg_watch_s: number;
  avg_watch_pct: number;
  cta_clicks: number;
  cta_unique: number;
  purchases: number;
  revenue_cents: number;
  replay_views: number;
  /** Seats: max_per_session, 0 = unlimited. */
  seats: number;
}

export interface WebinarStats {
  totals: Omit<SessionStats, 'start' | 'kind' | 'seats'> & { questions: number; cancelled: number; conversion_rate: number | null };
  sessions: SessionStats[];
  /** Share of attendees in the room at that second of the video (21 points from start to end). */
  dropoff: { at_s: number; viewers: number; share: number }[];
  polls: { id: string; question: string; total: number; options: { label: string; count: number }[] }[];
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export function webinarStats(app: App, w: Webinar, at = nowOf(app)): WebinarStats {
  const nowIso = at.toISOString();
  const rows = app.db.all<Record<string, any>>(
    `SELECT CASE WHEN session_kind = 'ondemand' THEN 'ondemand' ELSE session_start END AS grp, MIN(session_kind) AS kind, MIN(session_start) AS first_start,
       COUNT(*) AS registrations, SUM(attended_at IS NOT NULL) AS attended,
       SUM(CASE WHEN session_start <= ? THEN 1 ELSE 0 END) AS started,
       SUM(CASE WHEN session_start <= ? AND attended_at IS NOT NULL THEN 1 ELSE 0 END) AS started_attended,
       SUM(CASE WHEN attended_at IS NOT NULL THEN watched_s ELSE 0 END) AS watched_total,
       SUM(cta_clicks) AS cta_clicks, SUM(cta_clicked_at IS NOT NULL) AS cta_unique,
       SUM(purchase_count) AS purchases, SUM(purchase_cents) AS revenue_cents, SUM(replay_at IS NOT NULL) AS replay_views
     FROM webinar_registrations WHERE webinar_id = ? AND location_id = ? AND status = 'registered'
     GROUP BY grp ORDER BY MAX(session_start) DESC LIMIT 200`,
    nowIso,
    nowIso,
    w.id,
    w.location_id,
  );
  const dur = Math.max(w.duration_s, 1);
  const sessions: SessionStats[] = rows.map((r) => {
    const attended = num(r.attended);
    const avg = attended ? num(r.watched_total) / attended : 0;
    return {
      start: r.grp,
      kind: String(r.kind),
      registrations: num(r.registrations),
      attended,
      show_up_rate: r.grp === 'ondemand' ? rate(attended, num(r.registrations)) : num(r.started) > 0 ? rate(num(r.started_attended), num(r.started)) : null,
      avg_watch_s: Math.round(avg),
      avg_watch_pct: Math.min(100, Math.round((avg / dur) * 100)),
      cta_clicks: num(r.cta_clicks),
      cta_unique: num(r.cta_unique),
      purchases: num(r.purchases),
      revenue_cents: num(r.revenue_cents),
      replay_views: num(r.replay_views),
      seats: w.schedule.max_per_session,
    };
  });
  const sum = (f: (s: SessionStats) => number) => sessions.reduce((n, s) => n + f(s), 0);
  const registrations = sum((s) => s.registrations);
  const attended = sum((s) => s.attended);
  const startedAll = rows.reduce((n, r) => n + num(r.started), 0);
  const startedAttended = rows.reduce((n, r) => n + num(r.started_attended), 0);
  const watchedAll = rows.reduce((n, r) => n + num(r.watched_total), 0);
  const avgWatch = attended ? watchedAll / attended : 0;
  const questions = num(app.db.get('SELECT COUNT(*) n FROM webinar_questions WHERE webinar_id = ? AND location_id = ?', w.id, w.location_id)?.n);
  const cancelled = num(app.db.get(`SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ? AND location_id = ? AND status = 'cancelled'`, w.id, w.location_id)?.n);
  const purchases = sum((s) => s.purchases);

  // Drop-off: who was in the room at each point of the video (joined before it, was still there after it).
  const spans = app.db.all<{ first_off: number; last_off: number }>(`SELECT first_off, last_off FROM webinar_registrations WHERE webinar_id = ? AND location_id = ? AND attended_at IS NOT NULL AND first_off IS NOT NULL LIMIT 20000`, w.id, w.location_id);
  const POINTS = 20;
  const dropoff = Array.from({ length: POINTS + 1 }, (_, i) => {
    const t = Math.round((w.duration_s * i) / POINTS);
    const viewers = spans.reduce((n, s) => n + (s.first_off <= t + 1 && s.last_off >= t - 1 ? 1 : 0), 0);
    return { at_s: t, viewers, share: spans.length ? Math.round((viewers / spans.length) * 1000) / 1000 : 0 };
  });

  const polls = w.settings.room.polls.map((p) => {
    const { counts } = pollCounts(app, w, p.id);
    return { id: p.id, question: p.question, total: counts.reduce((a, b) => a + b, 0), options: p.options.map((label, i) => ({ label, count: counts[i] ?? 0 })) };
  });

  return {
    totals: {
      registrations,
      attended,
      show_up_rate: rate(startedAttended, startedAll),
      avg_watch_s: Math.round(avgWatch),
      avg_watch_pct: Math.min(100, Math.round((avgWatch / dur) * 100)),
      cta_clicks: sum((s) => s.cta_clicks),
      cta_unique: sum((s) => s.cta_unique),
      purchases,
      revenue_cents: sum((s) => s.revenue_cents),
      replay_views: sum((s) => s.replay_views),
      questions,
      cancelled,
      conversion_rate: rate(purchases, attended),
    },
    sessions,
    dropoff,
    polls,
  };
}
