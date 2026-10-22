import type { App } from '../core/app.js';
import { hiddenUser } from '../core/permissions.js';
import { id, now } from '../core/util.js';

/**
 * One in-app notification for one person outside the planner's own task flow (budget alerts, quote approvals): the bell in the top
 * bar (the planner's `pm_notifications` list, with its own link), a push to their devices and the Android app's feed. Dedupes on
 * `ref`; never notifies someone without access to the sub-account or without the area the link belongs to.
 */
export interface MemberNotice {
  locationId: string;
  userId: string;
  kind: string;
  title: string;
  body?: string;
  /** Where the bell entry leads, inside the app (`/app/...`). */
  link: string;
  projectId?: string | null;
  ref?: string;
  /** Area the person must have (admins always have every area). */
  area?: string;
  /** Push category (push module: tasks, payments …). */
  push?: string;
}

export function mayUseArea(u: { role: string; locations?: string | string[]; permissions?: string | string[] | null } | undefined, locationId: string, area?: string): boolean {
  if (!u) return false;
  if (u.role === 'admin') return true;
  const locs = Array.isArray(u.locations) ? u.locations : JSON.parse(u.locations || '[]');
  if (!locs.includes(locationId)) return false;
  if (!area) return true;
  const perms = Array.isArray(u.permissions) ? u.permissions : u.permissions ? JSON.parse(u.permissions) : null;
  return !perms || perms.includes(area);
}

export function notifyMember(app: App, n: MemberNotice): boolean {
  const u = app.db.get<{ id: string; role: string; locations: string; permissions: string | null }>('SELECT id, role, locations, permissions FROM users WHERE id = ?', n.userId);
  if (!u || hiddenUser(app, u, n.locationId) || !mayUseArea(u, n.locationId, n.area)) return false;
  const row = { id: id(), location_id: n.locationId, user_id: n.userId, kind: n.kind, task_id: null, project_id: n.projectId ?? null, title: n.title.slice(0, 200), body: (n.body ?? '').slice(0, 400), link: n.link.slice(0, 300), ref: n.ref ?? null, read_at: null, created_at: now() };
  try {
    if (n.ref && app.db.get('SELECT 1 AS x FROM pm_notifications WHERE user_id = ? AND ref = ?', n.userId, n.ref)) return false;
    app.db.insert('pm_notifications', row);
  } catch (e) {
    // The planner's list is missing (module not installed): push and app feed still go out.
    console.error('[notify]', (e as Error).message);
  }
  void Promise.resolve(app.services.pushNotify?.({ locationId: n.locationId, userIds: [n.userId], kind: n.push ?? 'tasks', title: row.title, body: row.body, url: row.link, tag: `${n.kind}-${n.ref ?? row.id}` })).catch((e) => console.error('[notify] push', (e as Error).message));
  app.services.mobileFeed?.({ locationId: n.locationId, type: n.kind, area: n.area ?? '', userId: n.userId, title: row.title, body: row.body, link: row.link, ref: n.ref ?? `${n.kind}:${row.id}` });
  return true;
}

/** People of a sub-account who match a test (agency admins and members with access), never hidden operator logins. */
export function membersWhere(app: App, locationId: string, test: (u: { id: string; role: string; permissions: string[] | null }) => boolean): string[] {
  return app.db
    .all<{ id: string; role: string; locations: string; permissions: string | null }>('SELECT id, role, locations, permissions FROM users ORDER BY name')
    .filter((u) => mayUseArea(u, locationId) && !hiddenUser(app, u, locationId))
    .filter((u) => test({ id: u.id, role: u.role, permissions: u.permissions ? JSON.parse(u.permissions) : null }))
    .map((u) => u.id);
}
