import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { now } from '../core/util.js';
import { dayOf, getProject, getSettings, logTask, statusesOf, team, todayIn, tzOf, withDay, type Actor } from './pm-core.js';
import { sectionsOf } from './pm-projects.js';
import { addDays, autoSchedule, criticalPath, diffDays, isWorkday, mondayOf, violations, workload, type Dates } from './pm-schedule.js';
import { calendarOf, decorate, depsOf, listTasks, planned, type TaskOut, type TaskRow } from './pm-tasks.js';
import { resolve, scopeClause, type Who } from './record-access.js';
import { flatten } from './pm-tree.js';

/** Data for the views: Gantt (with critical path and baseline), workload, "Meine Aufgaben". */

export interface GanttTask {
  id: string;
  parent_id: string | null;
  section_id: string | null;
  depth: number;
  title: string;
  start: string | null;
  end: string | null;
  scheduled: boolean;
  done: boolean;
  milestone: boolean;
  priority: number;
  status: TaskOut['status'];
  assignees: { id: string; name: string }[];
  progress: number;
  estimate_minutes: number | null;
  blocked: boolean;
  baseline: Dates | null;
  float: number | null;
  critical: boolean;
  has_children: boolean;
}
export interface GanttDep {
  id: string;
  task: string;
  on: string;
  type: string;
  lag: number;
  critical: boolean;
  violated: boolean;
}

export function ganttOf(app: App, locationId: string, projectId: string, who?: Who) {
  const project = getProject(app, locationId, projectId);
  const tz = tzOf(app, locationId);
  const cal = calendarOf(project);
  // Record-access rules (docs/sales.md): a person with a limited view of tasks sees their own / their team's tasks of the project.
  const scope = who ? scopeClause(resolve(app, { ...who, locationId }), 'tasks', 'tasks') : undefined;
  const rows = app.db.all<TaskRow>(`SELECT * FROM tasks WHERE location_id = ? AND project_id = ?${scope ? ` AND ${scope.sql}` : ''} ORDER BY position, created_at LIMIT 3000`, locationId, project.id, ...(scope?.params ?? []));
  const tasks = decorate(app, locationId, rows);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sections = sectionsOf(app, project.id);
  const sectionOrder = new Map(sections.map((s, i) => [s.id, i]));
  const shown = new Set(rows.map((r) => r.id));
  const deps = depsOf(app, locationId, project.id).filter((d) => !scope || (shown.has(d.task) && shown.has(d.on)));
  const plan = new Map(rows.map((r) => [r.id, planned(r, tz)]));
  const sched = rows.filter((r) => plan.get(r.id)).map((r) => ({ id: r.id, start: plan.get(r.id)!.start, end: plan.get(r.id)!.end, done: !!r.done }));
  const crit = criticalPath(sched, deps, cal);
  const critical = new Set(crit.critical);
  const viol = new Set(violations(sched, deps, cal).map((v) => v.dep.task + '>' + v.dep.on));
  const critLinks = new Set(crit.links.map((l) => `${l.task}>${l.on}`));
  const hasKids = new Set(rows.map((r) => r.parent_id).filter(Boolean) as string[]);
  // Sections first (in their order, "no section" last), each with its tasks and subtasks in hierarchy order.
  const flat = flatten(
    tasks,
    (a, b) => (sectionOrder.get(a.section_id ?? '') ?? 999) - (sectionOrder.get(b.section_id ?? '') ?? 999) || a.position - b.position || a.created_at.localeCompare(b.created_at),
  );
  const out: GanttTask[] = flat.map(({ item: t, depth }) => {
    const p = plan.get(t.id) ?? null;
    const base = t.baseline_start && t.baseline_end ? { start: t.baseline_start.slice(0, 10), end: t.baseline_end.slice(0, 10) } : null;
    const kids = tasks.filter((k) => k.parent_id === t.id);
    const progress = t.done ? 100 : kids.length ? Math.round((kids.filter((k) => k.done).length / kids.length) * 100) : 0;
    return {
      id: t.id,
      parent_id: t.parent_id && byId.has(t.parent_id) ? t.parent_id : null,
      section_id: t.section_id,
      depth,
      title: t.title,
      start: p?.start ?? null,
      end: p?.end ?? null,
      scheduled: !!p,
      done: t.done,
      milestone: t.milestone,
      priority: t.priority,
      status: t.status,
      assignees: t.assignees.map((a) => ({ id: a.id, name: a.name })),
      progress,
      estimate_minutes: t.estimate_minutes,
      blocked: t.blocked,
      baseline: base,
      float: p ? (crit.float[t.id] ?? null) : null,
      critical: critical.has(t.id),
      has_children: hasKids.has(t.id),
    };
  });
  const days = [...out.flatMap((t) => [t.start, t.end, t.baseline?.start, t.baseline?.end]), project.start_at ? dayOf(project.start_at, tz) : null, project.due_at ? dayOf(project.due_at, tz) : null].filter(Boolean) as string[];
  const ganttDeps: GanttDep[] = deps.map((d) => ({ id: d.id, task: d.task, on: d.on, type: d.type, lag: d.lag, critical: critLinks.has(`${d.task}>${d.on}`), violated: viol.has(`${d.task}>${d.on}`) }));
  return {
    project: { id: project.id, name: project.name, color: project.color, skip_weekends: !!project.skip_weekends, baseline_at: project.baseline_at, start: dayOf(project.start_at, tz), end: dayOf(project.due_at, tz) },
    today: todayIn(tz),
    tasks: out,
    deps: ganttDeps,
    sections,
    statuses: statusesOf(app, project.id),
    bounds: days.length ? { start: days.reduce((m, d) => (d < m ? d : m)), end: days.reduce((m, d) => (d > m ? d : m)) } : null,
    critical_end: crit.end,
  };
}

/** Sets the baseline (planned dates as they are today) so later changes show as a thin bar below. */
export function setBaseline(app: App, locationId: string, projectId: string) {
  const project = getProject(app, locationId, projectId);
  const tz = tzOf(app, locationId);
  let n = 0;
  app.db.tx(() => {
    for (const r of app.db.all<TaskRow>('SELECT * FROM tasks WHERE project_id = ?', project.id)) {
      const p = planned(r, tz);
      app.db.run('UPDATE tasks SET baseline_start = ?, baseline_end = ? WHERE id = ?', p ? `${p.start}T00:00:00.000Z` : null, p ? `${p.end}T00:00:00.000Z` : null, r.id);
      if (p) n++;
    }
    app.db.run('UPDATE pm_projects SET baseline_at = ?, updated_at = ? WHERE id = ?', now(), now(), project.id);
  });
  return { ok: true, tasks: n, baseline_at: now() };
}

export function clearBaseline(app: App, locationId: string, projectId: string) {
  const project = getProject(app, locationId, projectId);
  app.db.tx(() => {
    app.db.run('UPDATE tasks SET baseline_start = NULL, baseline_end = NULL WHERE project_id = ?', project.id);
    app.db.run('UPDATE pm_projects SET baseline_at = NULL, updated_at = ? WHERE id = ?', now(), project.id);
  });
  return { ok: true };
}

/** "Abhängigkeiten anwenden": every task with predecessors starts as early as its links allow. */
export function autoScheduleProject(app: App, locationId: string, projectId: string, actor: Actor, dryRun = false) {
  const project = getProject(app, locationId, projectId);
  const tz = tzOf(app, locationId);
  const cal = calendarOf(project);
  const rows = app.db.all<TaskRow>('SELECT * FROM tasks WHERE location_id = ? AND project_id = ?', locationId, project.id);
  const sched = rows.map((r) => ({ r, p: planned(r, tz) })).filter((x): x is { r: TaskRow; p: Dates } => !!x.p);
  let changes: Record<string, Dates>;
  try {
    changes = autoSchedule(sched.map((x) => ({ id: x.r.id, start: x.p.start, end: x.p.end, done: !!x.r.done })), depsOf(app, locationId, project.id), cal);
  } catch (e) {
    throw bad((e as Error).message);
  }
  if (!dryRun) {
    app.db.tx(() => {
      for (const [id, to] of Object.entries(changes)) {
        const r = rows.find((x) => x.id === id)!;
        const sets = { start_at: r.start_at ? withDay(r.start_at, to.start, tz) : null, due_at: withDay(r.due_at ?? r.start_at, to.end, tz), updated_at: now() };
        app.db.update('tasks', id, sets, locationId);
        logTask(app, r, actor, 'dates', { from: [r.start_at, r.due_at], to: [sets.start_at, sets.due_at], cause: 'Automatisch geplant' });
      }
    });
  }
  return { changed: Object.keys(changes).length, tasks: Object.entries(changes).map(([id, to]) => ({ id, title: rows.find((r) => r.id === id)!.title, ...to })) };
}

// --- workload -----------------------------------------------------------------------------------

export function workloadOf(app: App, locationId: string, f: { from?: string; to?: string; project_id?: string; who?: Who }) {
  const tz = tzOf(app, locationId);
  const today = todayIn(tz);
  const from = f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : mondayOf(today);
  const to = f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : addDays(from, 27);
  if (to < from) throw bad('Zeitraum: Ende vor Anfang');
  if (diffDays(from, to) > 120) throw bad('Zeitraum: höchstens 120 Tage');
  const settings = getSettings(app, locationId);
  const params: any[] = [locationId];
  let projectSql = '';
  const scope = f.who ? scopeClause(resolve(app, { ...f.who, locationId }), 'tasks', 't') : undefined;
  if (scope) (projectSql = ` AND ${scope.sql}`, params.push(...scope.params));
  if (f.project_id) {
    getProject(app, locationId, f.project_id);
    projectSql += ' AND t.project_id = ?';
    params.push(f.project_id);
  }
  const rows = app.db.all<TaskRow>(`SELECT t.* FROM tasks t WHERE t.location_id = ? AND t.done = 0 AND t.estimate_minutes > 0 AND (t.start_at IS NOT NULL OR t.due_at IS NOT NULL)${projectSql} LIMIT 3000`, ...params);
  const assignees = new Map<string, string[]>();
  for (const r of app.db.all<{ task_id: string; user_id: string }>(`SELECT a.task_id, a.user_id FROM pm_assignees a JOIN tasks t ON t.id = a.task_id WHERE t.location_id = ? AND t.done = 0`, locationId)) assignees.set(r.task_id, [...(assignees.get(r.task_id) ?? []), r.user_id]);
  const load = workload(
    rows.map((r) => ({ id: r.id, start: dayOf(r.start_at, tz), end: dayOf(r.due_at, tz), estimate_minutes: r.estimate_minutes, assignees: assignees.get(r.id) ?? [], done: !!r.done })),
    from,
    to,
  );
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const perDay = Math.round((settings.capacity_hours * 60) / 5);
  const logged = new Map<string, Record<string, number>>();
  const entries = app.db.all<any>(
    `SELECT user_id, started_at, CASE WHEN ended_at IS NULL THEN CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) ELSE seconds END AS s FROM pm_time_entries WHERE location_id = ? AND started_at >= ? AND started_at < ?`,
    locationId,
    `${addDays(from, -1)}T00:00:00.000Z`,
    `${addDays(to, 2)}T00:00:00.000Z`,
  );
  for (const e of entries) {
    const d = dayOf(e.started_at, tz)!;
    if (d < from || d > to) continue;
    const row = (logged.get(e.user_id) ?? {}) as Record<string, number>;
    row[d] = (row[d] ?? 0) + Math.round(Number(e.s) / 60);
    logged.set(e.user_id, row);
  }
  const people = team(app, locationId);
  const build = (id: string, name: string) => {
    const l = load[id] ?? {};
    const total = Object.values(l).reduce((a, b) => a + b, 0);
    const workdays = days.filter((d) => isWorkday(d)).length;
    return { id, name, load: l, logged: logged.get(id) ?? {}, total_minutes: Math.round(total), capacity_minutes: perDay * workdays, tasks: rows.filter((r) => (assignees.get(r.id) ?? []).includes(id)).length };
  };
  const rowsOut = people.map((p) => build(p.id, p.name));
  const un = build('unassigned', 'Nicht zugewiesen');
  un.tasks = rows.filter((r) => !(assignees.get(r.id)?.length)).length;
  un.capacity_minutes = 0;
  return { from, to, days, today, capacity_per_day_minutes: perDay, weekend_days: days.filter((d) => !isWorkday(d)), people: rowsOut, unassigned: un };
}

// --- my tasks -----------------------------------------------------------------------------------

export type Bucket = 'overdue' | 'today' | 'week' | 'later' | 'nodate';

/** The viewer's open tasks across all projects, in buckets by due day. */
export function myTasks(app: App, locationId: string, userId: string, f: { include_watching?: boolean } = {}) {
  const tz = tzOf(app, locationId);
  const today = todayIn(tz);
  const weekEnd = addDays(today, 6);
  const { tasks } = listTasks(app, locationId, { assignee: 'me', done: 'open', sort: 'due', limit: 1000 }, userId);
  const buckets: Record<Bucket, TaskOut[]> = { overdue: [], today: [], week: [], later: [], nodate: [] };
  for (const t of tasks) {
    const d = dayOf(t.due_at, tz);
    const b: Bucket = !d ? 'nodate' : d < today ? 'overdue' : d === today ? 'today' : d <= weekEnd ? 'week' : 'later';
    buckets[b].push(t);
  }
  const watching = f.include_watching ? listTasks(app, locationId, { watcher: 'me', done: 'open', sort: 'due', limit: 200 }, userId).tasks.filter((t) => !tasks.some((m) => m.id === t.id)) : [];
  return { today, buckets, counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])) as Record<Bucket, number>, total: tasks.length, watching };
}
