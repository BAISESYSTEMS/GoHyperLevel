import type { App } from '../core/app.js';
import { addDaysYmd, isValidTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { teamUsers, userFromRow, type TeamUser } from './collab-actor.js';
import { isAwayAt } from './teaminbox-model.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Who is around: each person of a sub-account can pause their share of the work, keep weekly working hours and enter
 * out-of-office periods. Approved absences of the HR module count as well. The Team-Posteingang (assignment) and the
 * Team-Kalender (round robin) both ask here, so "away" means the same everywhere.
 */

export type Windows = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', [string, string][]>>;

export interface Availability {
  user_id: string;
  paused: boolean;
  /** Weekly working hours for assignments; null = always. */
  hours: Windows | null;
  tz: string | null;
  away: { id: string; start_at: string; end_at: string; note: string; source: 'manual' | 'hr' }[];
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Weekly windows from user input; invalid windows are dropped, null/empty means "always". */
export function cleanWindows(v: unknown): Windows | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Windows = {};
  for (const d of DAYS) {
    const list = (v as Record<string, unknown>)[d];
    if (!Array.isArray(list)) continue;
    const ok = list.filter((w): w is [string, string] => Array.isArray(w) && HM.test(String(w[0])) && HM.test(String(w[1])) && String(w[0]) < String(w[1])).slice(0, 6);
    if (ok.length) out[d] = ok.map((w) => [String(w[0]), String(w[1])]);
  }
  return Object.keys(out).length ? out : null;
}

const parse = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** People who can work in this sub-account (with the permission area, e.g. 'conversations' or 'calendars'). */
export function peopleOf(app: App, locationId: string, area = 'conversations'): TeamUser[] {
  if (area) return teamUsers(app, locationId, area);
  // No area: everybody who can open the sub-account at all.
  return app.db
    .all('SELECT id, name, email, role, locations, permissions FROM users ORDER BY name')
    .map(userFromRow)
    .filter((u) => u.role === 'admin' || u.locations.includes(locationId))
    .filter((u) => !hiddenUser(app, u, locationId));
}

/** Approved absences of the HR module as UTC ranges around [from, to] (whole local days in the sub-account's zone). */
function hrAbsences(app: App, locationId: string, userId: string, from: string, to: string): Availability['away'] {
  try {
    const tz = app.location(locationId)?.timezone || 'Europe/Berlin';
    const a = ymdInTz(new Date(Date.parse(from) - 864e5), tz);
    const b = ymdInTz(new Date(Date.parse(to) + 864e5), tz);
    const rows = app.db.all<{ id: string; start_date: string; end_date: string; label: string; type: string; half_start: number; half_end: number }>(
      `SELECT a.id, a.start_date, a.end_date, a.label, a.type, a.half_start, a.half_end FROM hr_absences a JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.location_id = ? AND e.user_id = ? AND a.status = 'approved' AND a.end_date >= ? AND a.start_date <= ?`,
      locationId,
      userId,
      a,
      b,
    );
    return rows.map((r) => ({
      id: `hr:${r.id}`,
      // A half day at the start/end still blocks the whole day here: people on leave are not assigned new work.
      start_at: zonedToUtc(r.start_date, '00:00', tz).toISOString(),
      end_at: zonedToUtc(addDaysYmd(r.end_date, 1), '00:00', tz).toISOString(),
      note: r.label || 'Abwesenheit',
      source: 'hr' as const,
    }));
  } catch {
    return [];
  }
}

/** Availability record of one person in a sub-account (defaults when nothing was saved), with absences from [from, to]. */
export function availabilityOf(app: App, locationId: string, userId: string, from = new Date(Date.now() - 864e5).toISOString(), to = new Date(Date.now() + 90 * 864e5).toISOString()): Availability {
  const row = app.db.get('SELECT * FROM team_availability WHERE location_id = ? AND user_id = ?', locationId, userId);
  const manual = app.db.all<{ id: string; start_at: string; end_at: string; note: string }>('SELECT id, start_at, end_at, note FROM team_away WHERE location_id = ? AND user_id = ? AND end_at > ? AND start_at < ? ORDER BY start_at', locationId, userId, from, to);
  return {
    user_id: userId,
    paused: !!row?.paused,
    hours: cleanWindows(parse(row?.hours, null)),
    tz: row?.tz && isValidTz(row.tz) ? row.tz : null,
    away: [...manual.map((m) => ({ ...m, source: 'manual' as const })), ...hrAbsences(app, locationId, userId, from, to)],
  };
}

/** Is this person unavailable for new work at `at`? `workingHours`: also count the weekly hours (assignments do, bookings use their own). */
export function isAway(app: App, locationId: string, userId: string, at = new Date(), workingHours = true): boolean {
  const av = availabilityOf(app, locationId, userId, new Date(at.getTime() - 864e5).toISOString(), new Date(at.getTime() + 864e5).toISOString());
  return isAwayAt({ paused: av.paused, away: av.away, hours: workingHours ? av.hours : null, tz: av.tz || app.location(locationId)?.timezone || 'Europe/Berlin' }, at);
}

/** The first moment after `at` the out-of-office periods covering it end (for "back on …"), or null. */
export function awayUntil(av: Availability, at = new Date()): string | null {
  const t = at.toISOString();
  let end: string | null = null;
  for (const a of av.away) if (a.start_at <= t && a.end_at > t && (!end || a.end_at > end)) end = a.end_at;
  return end;
}
