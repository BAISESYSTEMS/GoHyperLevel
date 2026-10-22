import type { App } from '../core/app.js';
import { bounds, byTz, marks, overdue, type Loc } from './mobile.js';

/**
 * Per-sub-account counters for the agency screens (project cards, client overview), computed with one
 * grouped query per table instead of one query per sub-account and counter – with 50 sub-accounts the
 * per-account version ran 450+ queries per page view. The tables are covered by the indexes of
 * modules/perf-indexes.ts, so every query reads index entries only.
 */

export interface LocationStats {
  contacts: number;
  new_contacts: number;
  open_opportunities: number;
  open_value: number;
  won_value: number;
  open_tasks: number;
  overdue_tasks: number;
  unread: number;
  drafts: number;
  last_activity: string | null;
}

const empty = (): LocationStats => ({ contacts: 0, new_contacts: 0, open_opportunities: 0, open_value: 0, won_value: 0, open_tasks: 0, overdue_tasks: 0, unread: 0, drafts: 0, last_activity: null });

export type StatPart = 'contacts' | 'deals' | 'tasks' | 'inbox' | 'activity';
const ALL_PARTS: StatPart[] = ['contacts', 'deals', 'tasks', 'inbox', 'activity'];

/**
 * Counters for the given sub-accounts (all when omitted). `since` is the "new contacts" cut-off, `parts`
 * limits the work to the counters a screen shows (the contact count alone reads 100k index entries).
 * Without `ids` the grouped queries scan the whole index once; with a few ids they use index ranges.
 */
export function locationStats(app: App, ids?: string[], since = new Date(Date.now() - 30 * 864e5).toISOString(), parts: StatPart[] = ALL_PARTS): Map<string, LocationStats> {
  const { db } = app;
  const want = new Set(parts);
  const out = new Map<string, LocationStats>();
  const scope = ids ? `AND location_id IN (${ids.map(() => '?').join(', ')})` : '';
  const scopeParams = ids ?? [];
  const get = (loc: string) => {
    let s = out.get(loc);
    if (!s) out.set(loc, (s = empty()));
    return s;
  };
  for (const id of ids ?? []) get(id);
  const now = new Date().toISOString();

  if (want.has('contacts')) {
    for (const r of db.all(`SELECT location_id, COUNT(*) AS n, SUM(created_at >= ?) AS fresh FROM contacts WHERE 1 = 1 ${scope} GROUP BY location_id`, since, ...scopeParams)) {
      const s = get(r.location_id);
      s.contacts = Number(r.n);
      s.new_contacts = Number(r.fresh ?? 0);
    }
  }
  if (want.has('deals')) {
    const sql = `SELECT location_id, status, COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM opportunities WHERE status IN ('open', 'won') ${scope} GROUP BY location_id, status`;
    for (const r of db.all(sql, ...scopeParams)) {
      const s = get(r.location_id);
      if (r.status === 'open') {
        s.open_opportunities = Number(r.n);
        s.open_value = Number(r.v);
      } else s.won_value = Number(r.v);
    }
  }
  if (want.has('tasks')) {
    // "Overdue" depends on the day, and the day on the sub-account's time zone: tasks due on a date (no time) are overdue the
    // day after, timed ones at their time – one grouped query per time zone (usually one in total).
    const locs = db.all<Loc>(`SELECT id, name, timezone FROM locations ${ids ? `WHERE id IN (${marks(ids.length)})` : ''}`, ...scopeParams);
    for (const [tz, group] of byTz(locs)) {
      const sql = `SELECT location_id, COUNT(*) AS n, SUM(due_at IS NOT NULL AND ${overdue()}) AS late FROM tasks WHERE done = 0 AND location_id IN (${marks(group.length)}) GROUP BY location_id`;
      for (const r of db.all(sql, bounds(tz).today, now, ...group.map((l) => l.id))) {
        const s = get(r.location_id);
        s.open_tasks = Number(r.n);
        s.overdue_tasks = Number(r.late ?? 0);
      }
    }
  }
  if (want.has('inbox')) {
    for (const r of db.all(`SELECT location_id, SUM(unread) AS n FROM conversations WHERE unread > 0 ${scope} GROUP BY location_id`, ...scopeParams)) get(r.location_id).unread = Number(r.n);
    for (const r of db.all(`SELECT location_id, COUNT(*) AS n FROM messages WHERE status = 'draft' ${scope} GROUP BY location_id`, ...scopeParams)) get(r.location_id).drafts = Number(r.n);
  }
  if (want.has('activity')) {
    // MAX per sub-account is one index seek each; a grouped MAX would read every activity.
    for (const id of ids ?? db.all('SELECT id FROM locations').map((l) => l.id as string)) get(id).last_activity = db.get('SELECT MAX(created_at) AS at FROM activities WHERE location_id = ?', id)?.at ?? null;
  }
  return out;
}

/** The agency overview's extra counters (appointments, form submissions, funnel views, client logins). */
export function overviewExtras(app: App, since: string) {
  const { db } = app;
  const num = (rows: any[], col: string) => new Map<string, number>(rows.map((r) => [r.location_id as string, Number(r[col] ?? 0)]));
  const now = new Date().toISOString();
  const users = new Map<string, number>();
  for (const u of db.all(`SELECT locations FROM users WHERE role = 'member'`)) {
    try {
      for (const l of JSON.parse(u.locations || '[]') as string[]) users.set(l, (users.get(l) ?? 0) + 1);
    } catch {
      /* broken row: ignore */
    }
  }
  return {
    appointments: num(db.all(`SELECT location_id, COUNT(*) AS n FROM appointments WHERE status = 'confirmed' AND start_at >= ? GROUP BY location_id`, now), 'n'),
    submissions: num(db.all(`SELECT location_id, COUNT(*) AS n FROM form_submissions WHERE created_at >= ? GROUP BY location_id`, since), 'n'),
    views: num(db.all(`SELECT location_id, COALESCE(SUM(views), 0) AS n FROM funnel_pages GROUP BY location_id`), 'n'),
    users,
  };
}
