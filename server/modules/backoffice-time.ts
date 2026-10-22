import type { Module } from '../core/app.js';
import { ymdInTz } from '../core/time.js';

/**
 * Glue between the HR working-time overview (modules/hr.ts) and the time tracking of the project planner (modules/pm-time.ts).
 *
 * HR asks `app.services.workingTimeProvider.hoursByUser(locationId, from, to)` for "who tracked how many hours" and shows them next to
 * the target hours. The planner keeps its entries in `pm_time_entries`; this module answers the question from there, read-only. It only
 * offers the hook when that table exists (the planner is part of this build) and when nobody else has registered one, so a different
 * time-tracking module can take the place by registering first. Without it HR shows target hours and absences only.
 *
 * Counted: finished entries (running timers are not hours yet) that were not rejected on a timesheet, per day of the sub-account's own
 * time zone, from `from` to `to` inclusive (`YYYY-MM-DD`). Only the sums per login leave this module – never notes, tasks or projects.
 */

const DAY = 86_400_000;
const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export const backofficeTimeModule: Module = {
  name: 'backoffice-time',
  migrations: [],
  register(app) {
    const { db } = app;
    if (app.services.workingTimeProvider) return;
    const hasPlanner = !!db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'pm_time_entries'`)?.n;
    if (!hasPlanner) return;
    app.services.workingTimeProvider = {
      hoursByUser(locationId: string, from: string, to: string): Record<string, number> {
        if (!isYmd(from) || !isYmd(to) || to < from) return {};
        const tz = app.location(locationId)?.timezone || 'Europe/Berlin';
        // A day in the sub-account's zone can start the day before / end the day after in UTC: read generously, then cut by local day.
        const rows = db.all<{ user_id: string; started_at: string; seconds: number }>(
          `SELECT user_id, started_at, seconds FROM pm_time_entries WHERE location_id = ? AND ended_at IS NOT NULL AND approval != 'rejected' AND started_at >= ? AND started_at < ?`,
          locationId,
          `${shift(from, -1)}T00:00:00.000Z`,
          `${shift(to, 2)}T00:00:00.000Z`,
        );
        const seconds: Record<string, number> = {};
        for (const r of rows) {
          const day = ymdInTz(new Date(r.started_at), tz);
          if (day >= from && day <= to) seconds[r.user_id] = (seconds[r.user_id] ?? 0) + Math.max(0, r.seconds);
        }
        return Object.fromEntries(Object.entries(seconds).map(([user, s]) => [user, Math.round((s / 3600) * 1000) / 1000]));
      },
    };
  },
};
