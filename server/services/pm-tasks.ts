import type { App } from '../core/app.js';
import { bad, notFound, num, str } from '../core/http.js';
import { addDaysYmd, zonedToUtc } from '../core/time.js';
import { id as newId, now } from '../core/util.js';
import {
  PRIORITY_LABELS,
  actorOf,
  cleanCustom,
  cleanPeople,
  cleanPriority,
  cleanTags,
  dayOf,
  ensureDefaultProject,
  failOnTree,
  getProject,
  json,
  logTask,
  normDate,
  notifyUser,
  removeFiles,
  statusesOf,
  statusFor,
  todayIn,
  tzOf,
  withDay,
  type Actor,
  type Person,
  type ProjectRow,
  type StatusCategory,
  type StatusRow,
  team,
} from './pm-core.js';
import { DepError, assertDependency, cascade, cleanDepType, cleanLag, type Calendar, type Dep, type Dates, durationOf, endFromDuration, addDays, diffDays, CALENDAR_DAYS, CALENDAR_WORKDAYS } from './pm-schedule.js';
import { MAX_SUBTASKS_PER_TASK, assertParent, descendants, related, type ParentMap } from './pm-tree.js';
import { RecurrenceError, cleanRecurrence, describeRecurrence, nextOccurrence, type Recurrence } from './pm-recur.js';
import { DATE_ONLY } from './mobile.js';
import { resolve, scopeClause, type Who } from './record-access.js';

/** Tasks of the project planning feature: the existing `tasks` table with subtasks, statuses, dates, tags … */

export interface TaskRow {
  id: string;
  location_id: string;
  contact_id: string | null;
  title: string;
  description: string;
  due_at: string | null;
  done: number;
  assigned_to: string | null;
  created_at: string;
  completed_at: string | null;
  project_id: string | null;
  section_id: string | null;
  parent_id: string | null;
  status_id: string | null;
  priority: number;
  start_at: string | null;
  estimate_minutes: number | null;
  position: number;
  tags: string;
  custom: string;
  checklists: string;
  recurrence: string | null;
  series_id: string | null;
  recurred_at: string | null;
  internal: number;
  milestone: number;
  baseline_start: string | null;
  baseline_end: string | null;
  updated_at: string | null;
  created_by: string | null;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}
export interface Checklist {
  id: string;
  title: string;
  items: ChecklistItem[];
}

export interface TaskOut {
  id: string;
  location_id: string;
  project_id: string | null;
  section_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  contact_id: string | null;
  contact_name: string;
  status_id: string | null;
  status: { id: string; name: string; category: StatusCategory; color: string } | null;
  done: boolean;
  completed_at: string | null;
  priority: number;
  priority_label: string;
  start_at: string | null;
  due_at: string | null;
  estimate_minutes: number | null;
  position: number;
  tags: string[];
  custom: Record<string, any>;
  checklists: Checklist[];
  recurrence: Recurrence | null;
  recurrence_text: string;
  series_id: string | null;
  internal: boolean;
  milestone: boolean;
  baseline_start: string | null;
  baseline_end: string | null;
  assigned_to: string | null;
  assignees: Person[];
  watchers: string[];
  subtasks: { total: number; done: number };
  logged_seconds: number;
  blocked_by: string[];
  blocking: string[];
  blocked: boolean;
  project: { id: string; name: string; color: string; is_default: boolean } | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
}

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 20_000;
const chunks = <T>(list: T[], n = 400): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

export function taskRow(app: App, locationId: string, taskId: string): TaskRow {
  const t = app.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND location_id = ?', String(taskId ?? ''), locationId);
  if (!t) throw notFound('Aufgabe nicht gefunden');
  return t;
}

/** Loads related data for many tasks at once (no query per row). */
export function decorate(app: App, locationId: string, rows: TaskRow[]): TaskOut[] {
  if (!rows.length) return [];
  const { db } = app;
  const ids = rows.map((r) => r.id);
  const byTask = <T extends { task_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(x.task_id, [...(m.get(x.task_id) ?? []), x]);
    return m;
  };
  const each = <T>(sql: (marks: string) => string, list: string[], extra: unknown[] = []): T[] => chunks(list).flatMap((c) => db.all<T>(sql(marks(c.length)), ...(extra as any[]), ...c));
  const projects = new Map(db.all<any>('SELECT id, name, color, is_default FROM pm_projects WHERE location_id = ?', locationId).map((p) => [p.id, p]));
  const statuses = new Map<string, StatusRow>();
  for (const pid of new Set(rows.map((r) => r.project_id).filter(Boolean) as string[])) for (const s of statusesOf(app, pid)) statuses.set(s.id, s);
  const assignees = byTask(each<any>((m) => `SELECT a.task_id, u.id, u.name, u.email FROM pm_assignees a JOIN users u ON u.id = a.user_id WHERE a.task_id IN (${m}) ORDER BY a.created_at, a.rowid`, ids));
  const watchers = byTask(each<any>((m) => `SELECT task_id, user_id FROM pm_watchers WHERE task_id IN (${m})`, ids));
  const subs = new Map(each<any>((m) => `SELECT parent_id AS task_id, COUNT(*) AS n, SUM(done) AS d FROM tasks WHERE parent_id IN (${m}) GROUP BY parent_id`, ids).map((r) => [r.task_id, r]));
  const logged = new Map(each<any>((m) => `SELECT task_id, SUM(CASE WHEN ended_at IS NULL THEN CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) ELSE seconds END) AS s FROM pm_time_entries WHERE task_id IN (${m}) GROUP BY task_id`, ids).map((r) => [r.task_id, Number(r.s ?? 0)]));
  const blockedBy = byTask(each<any>((m) => `SELECT d.task_id, d.depends_on, p.done AS pdone FROM pm_dependencies d JOIN tasks p ON p.id = d.depends_on WHERE d.task_id IN (${m})`, ids));
  const blocking = new Map<string, string[]>();
  for (const r of each<any>((m) => `SELECT depends_on, task_id FROM pm_dependencies WHERE depends_on IN (${m})`, ids)) blocking.set(r.depends_on, [...(blocking.get(r.depends_on) ?? []), r.task_id]);
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean) as string[])];
  const contacts = new Map(each<any>((m) => `SELECT id, first_name, last_name, email FROM contacts WHERE location_id = ? AND id IN (${m})`, contactIds, [locationId]).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '']));
  return rows.map((r) => {
    const st = r.status_id ? statuses.get(r.status_id) : undefined;
    const p = r.project_id ? projects.get(r.project_id) : undefined;
    const rec = json<Recurrence | null>(r.recurrence, null);
    const people = (assignees.get(r.id) ?? []).map((a) => ({ id: a.id as string, name: (a.name || a.email) as string, email: a.email as string }));
    const blockers = blockedBy.get(r.id) ?? [];
    return {
      id: r.id,
      location_id: r.location_id,
      project_id: r.project_id,
      section_id: r.section_id,
      parent_id: r.parent_id,
      title: r.title,
      description: r.description,
      contact_id: r.contact_id,
      contact_name: r.contact_id ? (contacts.get(r.contact_id) ?? '') : '',
      status_id: r.status_id,
      status: st ? { id: st.id, name: st.name, category: st.category, color: st.color } : null,
      done: !!r.done,
      completed_at: r.completed_at,
      priority: r.priority,
      priority_label: PRIORITY_LABELS[r.priority] ?? '',
      start_at: r.start_at,
      due_at: r.due_at,
      estimate_minutes: r.estimate_minutes,
      position: r.position,
      tags: json<string[]>(r.tags, []),
      custom: json<Record<string, any>>(r.custom, {}),
      checklists: json<Checklist[]>(r.checklists, []),
      recurrence: rec,
      recurrence_text: describeRecurrence(rec),
      series_id: r.series_id,
      internal: !!r.internal,
      milestone: !!r.milestone,
      baseline_start: r.baseline_start,
      baseline_end: r.baseline_end,
      assigned_to: r.assigned_to,
      assignees: people,
      watchers: (watchers.get(r.id) ?? []).map((w) => w.user_id as string),
      subtasks: { total: Number(subs.get(r.id)?.n ?? 0), done: Number(subs.get(r.id)?.d ?? 0) },
      logged_seconds: logged.get(r.id) ?? 0,
      blocked_by: blockers.map((b) => b.depends_on as string),
      blocking: blocking.get(r.id) ?? [],
      blocked: blockers.some((b) => !b.pdone) && !r.done,
      project: p ? { id: p.id, name: p.name, color: p.color, is_default: !!p.is_default } : null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      created_by: r.created_by,
    } satisfies TaskOut;
  });
}

export const getTask = (app: App, locationId: string, taskId: string): TaskOut => decorate(app, locationId, [taskRow(app, locationId, taskId)])[0];

// --- listing ------------------------------------------------------------------------------------

export interface TaskFilter {
  /** The person asking: the record-access rules (docs/sales.md) narrow the list to their own / their team's tasks. */
  who?: Who;
  project_id?: string;
  section_id?: string;
  status_id?: string;
  category?: string;
  done?: string;
  assignee?: string;
  watcher?: string;
  priority?: string;
  tag?: string;
  q?: string;
  due?: string;
  from?: string;
  to?: string;
  parent?: string;
  contact_id?: string;
  ids?: string[];
  has_dates?: string;
  internal?: string;
  sort?: string;
  dir?: string;
  limit?: number;
  offset?: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Whole-day window on a date column: date-only values compare by their date, timed ones by instant in the time zone. */
function dueWindow(col: string, fromYmd: string, toYmdExclusive: string, tz: string) {
  const dateOnly = DATE_ONLY.replace(/due_at/g, col);
  return {
    sql: `((${dateOnly} AND substr(${col}, 1, 10) >= ? AND substr(${col}, 1, 10) < ?) OR (NOT ${dateOnly} AND ${col} >= ? AND ${col} < ?))`,
    params: [fromYmd, toYmdExclusive, zonedToUtc(fromYmd, '00:00', tz).toISOString(), zonedToUtc(toYmdExclusive, '00:00', tz).toISOString()],
  };
}

export function listTasks(app: App, locationId: string, f: TaskFilter, viewer: string | null): { tasks: TaskOut[]; total: number } {
  const tz = tzOf(app, locationId);
  const where: string[] = ['t.location_id = ?'];
  const params: any[] = [locationId];
  const join: string[] = [];
  const scope = f.who ? scopeClause(resolve(app, { ...f.who, locationId }), 'tasks', 't') : undefined;
  if (scope) (where.push(scope.sql), params.push(...scope.params));
  if (f.project_id) (where.push('t.project_id = ?'), params.push(f.project_id));
  if (f.section_id) {
    if (f.section_id === 'none') where.push('t.section_id IS NULL');
    else (where.push('t.section_id = ?'), params.push(f.section_id));
  }
  if (f.status_id) (where.push('t.status_id = ?'), params.push(f.status_id));
  if (f.category) {
    join.push('LEFT JOIN pm_statuses cs ON cs.id = t.status_id');
    const cats = f.category.split(',').filter(Boolean);
    where.push(`cs.category IN (${marks(cats.length)})`);
    params.push(...cats);
  }
  if (f.done === '1' || f.done === 'done') where.push('t.done = 1');
  else if (f.done === '0' || f.done === 'open') where.push('t.done = 0');
  if (f.assignee) {
    const list = f.assignee.split(',').filter(Boolean);
    const parts: string[] = [];
    for (const a of list) {
      if (a === 'none') parts.push('NOT EXISTS (SELECT 1 FROM pm_assignees a WHERE a.task_id = t.id)');
      else if (a === 'me') {
        parts.push('EXISTS (SELECT 1 FROM pm_assignees a WHERE a.task_id = t.id AND a.user_id = ?)');
        params.push(viewer ?? '');
      } else {
        parts.push('EXISTS (SELECT 1 FROM pm_assignees a WHERE a.task_id = t.id AND a.user_id = ?)');
        params.push(a);
      }
    }
    if (parts.length) where.push(`(${parts.join(' OR ')})`);
  }
  if (f.watcher) {
    where.push('EXISTS (SELECT 1 FROM pm_watchers w WHERE w.task_id = t.id AND w.user_id = ?)');
    params.push(f.watcher === 'me' ? (viewer ?? '') : f.watcher);
  }
  if (f.priority !== undefined && f.priority !== '') {
    const list = f.priority.split(',').map((p) => cleanPriority(p));
    where.push(`t.priority IN (${marks(list.length)})`);
    params.push(...list);
  }
  if (f.tag) (where.push('EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE lower(j.value) = lower(?))'), params.push(f.tag));
  if (f.q) {
    where.push(`(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')`);
    params.push(`%${likeEscape(f.q)}%`, `%${likeEscape(f.q)}%`);
  }
  if (f.contact_id) (where.push('t.contact_id = ?'), params.push(f.contact_id));
  if (f.ids?.length) (where.push(`t.id IN (${marks(f.ids.length)})`), params.push(...f.ids));
  if (f.parent === 'none') where.push('t.parent_id IS NULL');
  else if (f.parent) (where.push('t.parent_id = ?'), params.push(f.parent));
  if (f.internal === '1') where.push('t.internal = 1');
  else if (f.internal === '0') where.push('t.internal = 0');
  if (f.has_dates === '1') where.push('(t.start_at IS NOT NULL OR t.due_at IS NOT NULL)');
  else if (f.has_dates === '0') where.push('t.start_at IS NULL AND t.due_at IS NULL');
  if (f.due) {
    const today = todayIn(tz);
    if (f.due === 'none') where.push('t.due_at IS NULL');
    else if (f.due === 'overdue') {
      where.push(`t.done = 0 AND t.due_at IS NOT NULL AND ((${DATE_ONLY.replace(/due_at/g, 't.due_at')} AND substr(t.due_at, 1, 10) < ?) OR (NOT ${DATE_ONLY.replace(/due_at/g, 't.due_at')} AND t.due_at < ?))`);
      params.push(today, now());
    } else {
      const span = f.due === 'today' ? 1 : f.due === 'week' ? 7 : f.due === 'month' ? 30 : 0;
      if (!span) throw bad('Fällig: overdue, today, week, month oder none');
      const w = dueWindow('t.due_at', today, addDaysYmd(today, span), tz);
      where.push(`t.due_at IS NOT NULL AND ${w.sql}`);
      params.push(...w.params);
    }
  }
  if (f.from || f.to) {
    // Overlap of [start, due] with the window, widened by a day (time zones); trimmed exactly below.
    const from = f.from ? addDaysYmd(f.from, -1) : '0000-01-01';
    const to = f.to ? addDaysYmd(f.to, 1) : '9999-12-31';
    where.push(`COALESCE(substr(t.start_at, 1, 10), substr(t.due_at, 1, 10)) <= ? AND COALESCE(substr(t.due_at, 1, 10), substr(t.start_at, 1, 10)) >= ?`);
    params.push(to, from);
  }
  const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  const order =
    f.sort === 'due'
      ? `COALESCE(t.due_at, '9999') ${dir}, t.position, t.created_at`
      : f.sort === 'start'
        ? `COALESCE(t.start_at, t.due_at, '9999') ${dir}, t.position`
        : f.sort === 'priority'
          ? `t.priority ${dir === 'ASC' ? 'DESC' : 'ASC'}, COALESCE(t.due_at, '9999'), t.position`
          : f.sort === 'title'
            ? `t.title COLLATE NOCASE ${dir}`
            : f.sort === 'created'
              ? `t.created_at ${dir}`
              : f.sort === 'updated'
                ? `COALESCE(t.updated_at, t.created_at) ${dir}`
                : `t.position ${dir}, t.created_at ${dir}`;
  const limit = Math.min(Math.max(Math.floor(num(f.limit, 500)), 1), 2000);
  const offset = Math.max(Math.floor(num(f.offset, 0)), 0);
  const base = `FROM tasks t ${join.join(' ')} WHERE ${where.join(' AND ')}`;
  const total = Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n ${base}`, ...params)?.n ?? 0);
  let rows = app.db.all<TaskRow>(`SELECT t.* ${base} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  if (f.from || f.to) {
    rows = rows.filter((r) => {
      const s = dayOf(r.start_at ?? r.due_at, tz);
      const e = dayOf(r.due_at ?? r.start_at, tz);
      return !!s && !!e && (!f.to || s <= f.to) && (!f.from || e >= f.from);
    });
  }
  return { tasks: decorate(app, locationId, rows), total };
}

// --- helpers for writes -------------------------------------------------------------------------

/**
 * The part of the task tree around some tasks: each one's ancestors and its whole subtree. All the checks need
 * (cycle, depth, ancestor/descendant) – without reading every task of the sub-account.
 */
export function treeAround(app: App, locationId: string, ids: (string | null | undefined)[]): ParentMap {
  const map: ParentMap = new Map();
  for (const start of ids) {
    if (!start) continue;
    let cur: string | null | undefined = start;
    for (let i = 0; cur && !map.has(cur) && i < 20; i++) {
      const r: { parent_id: string | null } | undefined = app.db.get('SELECT parent_id FROM tasks WHERE id = ? AND location_id = ?', cur, locationId);
      if (!r) break;
      map.set(cur, r.parent_id);
      cur = r.parent_id;
    }
    for (const r of app.db.all<{ id: string; parent_id: string | null }>(
      `WITH RECURSIVE sub(id, parent_id) AS (SELECT id, parent_id FROM tasks WHERE parent_id = ? AND location_id = ? UNION ALL SELECT t.id, t.parent_id FROM tasks t JOIN sub ON t.parent_id = sub.id) SELECT id, parent_id FROM sub LIMIT 5000`,
      start,
      locationId,
    ))
      map.set(r.id, r.parent_id);
  }
  return map;
}

function cleanChecklists(v: unknown): Checklist[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('Checklisten: Liste erwartet');
  if (v.length > 20) throw bad('Höchstens 20 Checklisten je Aufgabe');
  return v.map((c: any) => {
    const items = Array.isArray(c?.items) ? c.items : [];
    if (items.length > 100) throw bad('Höchstens 100 Punkte je Checkliste');
    return {
      id: String(c?.id || newId(8)).slice(0, 40),
      title: str(c?.title, 'Checkliste', { max: 120 }) || 'Checkliste',
      items: items.map((i: any) => ({ id: String(i?.id || newId(8)).slice(0, 40), text: str(i?.text, 'Punkt', { max: 300 }), done: !!i?.done })).filter((i: ChecklistItem) => i.text),
    };
  });
}

function cleanEstimate(b: any): number | null | undefined {
  const v = b.estimate_minutes !== undefined ? b.estimate_minutes : b.estimate_hours !== undefined ? (b.estimate_hours === null || b.estimate_hours === '' ? null : Number(b.estimate_hours) * 60) : undefined;
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw bad('Schätzung: Minuten zwischen 0 und 1.000.000');
  return n;
}

const nextPosition = (app: App, projectId: string, parentId: string | null) =>
  Number(app.db.get<{ m: number | null }>(`SELECT MAX(position) AS m FROM tasks WHERE project_id = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`, projectId, ...(parentId ? [parentId] : []))?.m ?? 0) + 1000;

/** Resolves `status_id`, `status` (name) or `category` of a request against the project's statuses. */
export function resolveStatus(statuses: StatusRow[], b: { status_id?: unknown; status?: unknown; category?: unknown }): StatusRow | undefined {
  if (b.status_id) {
    const s = statuses.find((x) => x.id === String(b.status_id));
    if (!s) throw bad('Status gehört nicht zu diesem Projekt');
    return s;
  }
  if (b.status) {
    const name = String(b.status).trim().toLowerCase();
    const s = statuses.find((x) => x.name.toLowerCase() === name) ?? statuses.find((x) => x.category === name);
    if (!s) throw bad(`Status „${String(b.status)}“ gibt es in diesem Projekt nicht – verfügbar: ${statuses.map((x) => x.name).join(', ')}`);
    return s;
  }
  if (b.category) {
    const s = statusFor(statuses, String(b.category) as StatusCategory);
    if (!s) throw bad('Kein Status in dieser Kategorie');
    return s;
  }
  return undefined;
}

function datesOf(app: App, locationId: string, b: any, cur: { start_at: string | null; due_at: string | null; milestone: number }, milestone: boolean) {
  const tz = tzOf(app, locationId);
  let start = b.start_at !== undefined ? normDate(b.start_at, 'Start') : cur.start_at;
  let due = b.due_at !== undefined ? normDate(b.due_at, 'Fällig') : cur.due_at;
  // A milestone is a single day: its date is the due date.
  if (milestone) {
    if (b.start_at !== undefined && b.due_at === undefined && start) due = start;
    start = due ?? start;
    if (!due) due = start;
  }
  if (start && due && (dayOf(start, tz) as string) > (dayOf(due, tz) as string)) throw bad('Der Start liegt nach dem Fälligkeitsdatum');
  return { start_at: start, due_at: due };
}

/** The rule from a request; a malformed one is a 400 with the reason. */
function ruleFrom(input: unknown): Recurrence | null {
  try {
    return cleanRecurrence(input);
  } catch (e) {
    if (e instanceof RecurrenceError) throw bad(e.message);
    throw e;
  }
}

/** A monthly rule remembers the day it started on, so "31st" does not drift to the 28th after February. */
function anchoredRule(app: App, locationId: string, rule: Recurrence | null, dueAt: string | null): Recurrence | null {
  if (rule?.freq === 'monthly' && !rule.day_of_month && dueAt) {
    const d = dayOf(dueAt, tzOf(app, locationId));
    if (d) return { ...rule, day_of_month: Number(d.slice(8, 10)) };
  }
  return rule;
}

// --- create -------------------------------------------------------------------------------------

export interface CreateOpts {
  /** Depth of automation chains (events emitted by automations carry it so they cannot loop). */
  automationDepth?: number;
  /** Ids of the automations that led here: none of them runs again within the chain. */
  automationChain?: string[];
  /** Do not emit events/notifications (bulk template instantiation does it once itself). */
  quiet?: boolean;
  /** Internal: shared by the creations nested inside one call (subtasks) – counts and collects them. */
  nested?: { n: number; created: string[] };
}

export function createTask(app: App, locationId: string, b: any, actor: Actor, opts: CreateOpts = {}): TaskOut {
  const { db } = app;
  const top = !opts.nested;
  const nested = opts.nested ?? { n: 0, created: [] };
  if (++nested.n > 300) throw bad('Höchstens 300 Aufgaben auf einmal');
  const title = str(b.title, 'Titel', { required: true, max: MAX_TITLE });
  const defaultProject = ensureDefaultProject(app, locationId);
  let parent: TaskRow | undefined;
  if (b.parent_id) {
    parent = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND location_id = ?', String(b.parent_id), locationId);
    if (!parent) throw bad('Übergeordnete Aufgabe nicht gefunden');
    if (b.project_id && b.project_id !== parent.project_id) throw bad('Unteraufgaben bleiben im Projekt der übergeordneten Aufgabe');
    try {
      assertParent(treeAround(app, locationId, [parent.id]), '', parent.id);
    } catch (e) {
      failOnTree(e);
    }
    if (Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?', parent.id)?.n) >= MAX_SUBTASKS_PER_TASK) throw bad(`Höchstens ${MAX_SUBTASKS_PER_TASK} Unteraufgaben je Aufgabe`);
  }
  const project = getProject(app, locationId, parent?.project_id ?? b.project_id ?? defaultProject);
  if (project.status === 'archived') throw bad('Das Projekt ist archiviert');
  const statuses = statusesOf(app, project.id);
  let status = resolveStatus(statuses, b);
  if (!status && (b.done === true || b.done === 1 || b.done === '1')) status = statusFor(statuses, 'done');
  status ??= statusFor(statuses, 'todo') ?? statuses[0];
  let sectionId: string | null = parent?.section_id ?? null;
  if (b.section_id !== undefined) {
    sectionId = b.section_id ? String(b.section_id) : null;
    if (sectionId && !db.get('SELECT 1 AS x FROM pm_sections WHERE id = ? AND project_id = ?', sectionId, project.id)) throw bad('Abschnitt gehört nicht zu diesem Projekt');
  }
  if (b.contact_id && !db.get('SELECT 1 AS x FROM contacts WHERE id = ? AND location_id = ?', String(b.contact_id), locationId)) throw bad('Kontakt nicht gefunden');
  const milestone = !!b.milestone;
  const dates = datesOf(app, locationId, b, { start_at: null, due_at: null, milestone: 0 }, milestone);
  const rule = anchoredRule(app, locationId, ruleFrom(b.recurrence), dates.due_at);
  const assignees = cleanPeople(app, locationId, b.assignees ?? (b.assigned_to ? [b.assigned_to] : []), 'Zuständige');
  const watchers = cleanPeople(app, locationId, b.watchers, 'Beobachter');
  if (actor.id && (actor.via === 'session' || actor.via === 'app') && !watchers.includes(actor.id)) watchers.push(actor.id);
  const done = status.category === 'done';
  const t = now();
  const row = {
    id: newId(),
    location_id: locationId,
    contact_id: b.contact_id ? String(b.contact_id) : null,
    title,
    description: str(b.description, 'Beschreibung', { max: MAX_DESCRIPTION }),
    due_at: dates.due_at,
    start_at: dates.start_at,
    done: done ? 1 : 0,
    assigned_to: assignees[0] ?? null,
    created_at: t,
    completed_at: done ? t : null,
    project_id: project.id,
    section_id: sectionId,
    parent_id: parent?.id ?? null,
    status_id: status.id,
    priority: cleanPriority(b.priority),
    estimate_minutes: cleanEstimate(b) ?? null,
    position: b.position !== undefined && Number.isFinite(Number(b.position)) ? Number(b.position) : nextPosition(app, project.id, parent?.id ?? null),
    tags: JSON.stringify(cleanTags(b.tags)),
    custom: JSON.stringify(cleanCustom(app, locationId, project.id, b.custom)),
    checklists: JSON.stringify(cleanChecklists(b.checklists)),
    recurrence: rule ? JSON.stringify(rule) : null,
    series_id: b.series_id ? String(b.series_id) : null,
    internal: b.internal ? 1 : 0,
    milestone: milestone ? 1 : 0,
    updated_at: t,
    created_by: actor.id,
  };
  const insert = () => {
    db.insert('tasks', row);
    nested.created.push(row.id);
    for (const u of assignees) db.run('INSERT OR IGNORE INTO pm_assignees (task_id, user_id, created_at) VALUES (?, ?, ?)', row.id, u, t);
    for (const u of watchers) db.run('INSERT OR IGNORE INTO pm_watchers (task_id, user_id, created_at) VALUES (?, ?, ?)', row.id, u, t);
    logTask(app, row, actor, 'created', {});
    const subs: any[] = Array.isArray(b.subtasks) ? b.subtasks : [];
    for (const s of subs) createTask(app, locationId, { ...(typeof s === 'string' ? { title: s } : s), parent_id: row.id }, actor, { ...opts, quiet: true, nested });
  };
  // Subtasks are created inside the parent's transaction: all or nothing.
  if (top) db.tx(insert);
  else insert();
  const out = getTask(app, locationId, row.id);
  if (top && !opts.quiet) for (const cid of nested.created) announceCreated(app, cid === row.id ? out : getTask(app, locationId, cid), actor, opts);
  return out;
}

/** Events and notifications for a freshly created task (also used after a nested creation finished). */
export function announceCreated(app: App, t: TaskOut, actor: Actor, opts: { automationDepth?: number; automationChain?: string[] } = {}) {
  const depth = opts.automationDepth ?? 0;
  const chain = opts.automationChain ?? [];
  const assignees = t.assignees.map((a) => a.id);
  app.events.emit(t.location_id, 'task.created', { contactId: t.contact_id ?? undefined, task: t, projectId: t.project_id, automationDepth: depth, automationChain: chain });
  if (assignees.length) {
    app.events.emit(t.location_id, 'task.assigned', { contactId: t.contact_id ?? undefined, task: t, userIds: assignees, automationDepth: depth, automationChain: chain });
    notifyAssigned(app, t, assignees, actor);
  }
}

function notifyAssigned(app: App, t: TaskOut, userIds: string[], actor: Actor) {
  for (const u of userIds) {
    if (u === actor.id) continue;
    notifyUser(app, { locationId: t.location_id, userId: u, kind: 'assigned', title: `Neue Aufgabe für dich: ${t.title}`, body: `${actor.name} hat dir eine Aufgabe zugewiesen${t.due_at ? ` · fällig ${t.due_at.slice(0, 10).split('-').reverse().join('.')}` : ''}`, taskId: t.id, projectId: t.project_id, ref: `assigned:${t.id}:${u}` });
  }
}

// --- update -------------------------------------------------------------------------------------

export interface UpdateOpts {
  automationDepth?: number;
  automationChain?: string[];
  /** Skip the automatic next occurrence of a recurring task (used when the caller handles it). */
  noRecurrence?: boolean;
}

function setAssignees(app: App, locationId: string, taskId: string, next: string[]) {
  const { db } = app;
  const cur = db.all<{ user_id: string }>('SELECT user_id FROM pm_assignees WHERE task_id = ? ORDER BY created_at, rowid', taskId).map((r) => r.user_id);
  for (const u of cur) if (!next.includes(u)) db.run('DELETE FROM pm_assignees WHERE task_id = ? AND user_id = ?', taskId, u);
  for (const u of next) if (!cur.includes(u)) db.run('INSERT OR IGNORE INTO pm_assignees (task_id, user_id, created_at) VALUES (?, ?, ?)', taskId, u, now());
  // The legacy column carries the first assignee (plain task list, mobile app, push, Todoist owner).
  db.run('UPDATE tasks SET assigned_to = ? WHERE id = ?', next[0] ?? null, taskId);
  // The trigger on assigned_to drops the old primary person; the explicit list wins.
  for (const u of next) db.run('INSERT OR IGNORE INTO pm_assignees (task_id, user_id, created_at) VALUES (?, ?, ?)', taskId, u, now());
  return { before: cur, added: next.filter((u) => !cur.includes(u)), removed: cur.filter((u) => !next.includes(u)) };
}

function mapStatusToProject(target: StatusRow[], from: StatusRow | undefined, done: boolean): StatusRow | undefined {
  return (from && target.find((s) => s.name.toLowerCase() === from.name.toLowerCase() && (s.category === 'done') === done)) ?? statusFor(target, done ? 'done' : (from?.category ?? 'todo')) ?? statusFor(target, done ? 'done' : 'todo');
}

/** All of a task's descendants' rows (children, grandchildren …). */
function subtreeIds(app: App, locationId: string, taskId: string): string[] {
  return descendants(treeAround(app, locationId, [taskId]), taskId);
}

export function updateTask(app: App, locationId: string, taskId: string, b: any, actor: Actor, opts: UpdateOpts = {}): TaskOut {
  const { db } = app;
  const cur = taskRow(app, locationId, taskId);
  const before = decorate(app, locationId, [cur])[0];
  const patch: Record<string, any> = {};
  const changes: Record<string, [unknown, unknown]> = {};
  let projectId = cur.project_id!;
  let moved = false;

  // --- project move (subtasks follow; statuses are mapped by name, then category)
  if (b.project_id !== undefined && b.project_id !== cur.project_id) {
    const target = getProject(app, locationId, String(b.project_id));
    if (target.status === 'archived') throw bad('Das Projekt ist archiviert');
    if (cur.parent_id && b.parent_id === undefined) patch.parent_id = null;
    projectId = target.id;
    moved = true;
    patch.project_id = target.id;
    patch.section_id = null;
    changes.project = [before.project?.name ?? null, target.name];
  }
  const project = getProject(app, locationId, projectId);
  const statuses = statusesOf(app, project.id);

  if (b.title !== undefined) {
    const v = str(b.title, 'Titel', { required: true, max: MAX_TITLE });
    if (v !== cur.title) (patch.title = v, (changes.title = [cur.title, v]));
  }
  if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: MAX_DESCRIPTION });
  if (b.contact_id !== undefined) {
    patch.contact_id = b.contact_id ? String(b.contact_id) : null;
    if (patch.contact_id && !db.get('SELECT 1 AS x FROM contacts WHERE id = ? AND location_id = ?', patch.contact_id, locationId)) throw bad('Kontakt nicht gefunden');
  }
  if (b.priority !== undefined) {
    const v = cleanPriority(b.priority);
    if (v !== cur.priority) (patch.priority = v, (changes.priority = [PRIORITY_LABELS[cur.priority], PRIORITY_LABELS[v]]));
  }
  const est = cleanEstimate(b);
  if (est !== undefined) patch.estimate_minutes = est;
  if (b.tags !== undefined) patch.tags = JSON.stringify(cleanTags(b.tags));
  if (b.custom !== undefined) patch.custom = JSON.stringify(cleanCustom(app, locationId, project.id, b.custom, json(cur.custom, {})));
  if (b.checklists !== undefined) patch.checklists = JSON.stringify(cleanChecklists(b.checklists));
  if (b.internal !== undefined) patch.internal = b.internal ? 1 : 0;
  if (b.position !== undefined && Number.isFinite(Number(b.position))) patch.position = Number(b.position);

  // --- dates
  const milestone = b.milestone !== undefined ? !!b.milestone : !!cur.milestone;
  if (b.milestone !== undefined) patch.milestone = milestone ? 1 : 0;
  if (b.start_at !== undefined || b.due_at !== undefined || (b.milestone !== undefined && milestone)) {
    const d = datesOf(app, locationId, b, cur, milestone);
    if (d.start_at !== cur.start_at) (patch.start_at = d.start_at, (changes.start_at = [cur.start_at, d.start_at]));
    if (d.due_at !== cur.due_at) (patch.due_at = d.due_at, (changes.due_at = [cur.due_at, d.due_at]));
  }

  if (b.recurrence !== undefined) {
    const rule = anchoredRule(app, locationId, ruleFrom(b.recurrence), patch.due_at !== undefined ? patch.due_at : cur.due_at);
    patch.recurrence = rule ? JSON.stringify(rule) : null;
    changes.recurrence = [before.recurrence_text, describeRecurrence(rule)];
  }

  // --- hierarchy
  if (b.parent_id !== undefined && (b.parent_id || null) !== cur.parent_id) {
    const pid = b.parent_id ? String(b.parent_id) : null;
    if (pid) {
      const p = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND location_id = ?', pid, locationId);
      if (!p) throw bad('Übergeordnete Aufgabe nicht gefunden');
      if (p.project_id !== projectId) throw bad('Unteraufgaben bleiben im Projekt der übergeordneten Aufgabe');
      try {
        assertParent(treeAround(app, locationId, [cur.id, pid]), cur.id, pid);
      } catch (e) {
        failOnTree(e);
      }
      if (Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ?', pid)?.n) >= MAX_SUBTASKS_PER_TASK) throw bad(`Höchstens ${MAX_SUBTASKS_PER_TASK} Unteraufgaben je Aufgabe`);
      // A task and its own parent/child may not depend on each other.
      const depRows = db.all<{ task_id: string; depends_on: string }>('SELECT task_id, depends_on FROM pm_dependencies WHERE task_id = ? OR depends_on = ?', cur.id, cur.id);
      const pm = treeAround(app, locationId, [cur.id, pid]);
      pm.set(cur.id, pid);
      for (const d of depRows) if (related(pm, d.task_id, d.depends_on)) throw bad('Die Aufgabe hängt von ihrer neuen übergeordneten Aufgabe (oder umgekehrt) ab – erst die Abhängigkeit lösen');
      patch.parent_id = pid;
      if (b.section_id === undefined) patch.section_id = p.section_id;
    } else patch.parent_id = null;
  }
  if (b.section_id !== undefined) {
    const s = b.section_id ? String(b.section_id) : null;
    if (s && !db.get('SELECT 1 AS x FROM pm_sections WHERE id = ? AND project_id = ?', s, projectId)) throw bad('Abschnitt gehört nicht zu diesem Projekt');
    patch.section_id = s;
  }

  // --- status (and "done", which maps onto the first status of that kind)
  let toStatus: StatusRow | undefined;
  const asked = resolveStatus(statuses, b);
  if (asked) toStatus = asked;
  else if (b.done !== undefined) {
    const wantDone = b.done === true || b.done === 1 || b.done === '1' || b.done === 'true';
    const currentStatus = statuses.find((s) => s.id === cur.status_id);
    if (wantDone !== !!cur.done) toStatus = wantDone ? statusFor(statuses, 'done') : (statusFor(statuses, 'todo') ?? statuses[0]);
    else if (moved) toStatus = currentStatus;
  }
  if (moved && !asked) {
    const was = before.status ? ({ ...before.status, location_id: '', project_id: '', position: 0 } as StatusRow) : undefined;
    toStatus = mapStatusToProject(statuses, was, toStatus ? toStatus.category === 'done' : !!cur.done) ?? toStatus;
  }
  let completedNow = false;
  let statusChanged = false;
  if (toStatus && (toStatus.id !== cur.status_id || moved)) {
    statusChanged = !moved && toStatus.id !== cur.status_id;
    patch.status_id = toStatus.id;
    const nowDone = toStatus.category === 'done';
    if (nowDone !== !!cur.done) {
      patch.done = nowDone ? 1 : 0;
      patch.completed_at = nowDone ? now() : null;
      completedNow = nowDone;
    }
    if (statusChanged) changes.status = [before.status?.name ?? null, toStatus.name];
  }

  // --- people
  let assigneeDelta: { added: string[]; removed: string[] } | undefined;
  let nextAssignees: string[] | undefined;
  if (b.assignees !== undefined || b.assigned_to !== undefined || b.add_assignees !== undefined || b.remove_assignees !== undefined) {
    const curList = before.assignees.map((a) => a.id);
    if (b.assignees !== undefined) nextAssignees = cleanPeople(app, locationId, b.assignees, 'Zuständige');
    else if (b.assigned_to !== undefined) nextAssignees = cleanPeople(app, locationId, b.assigned_to ? [b.assigned_to] : [], 'Zuständige');
    else nextAssignees = curList;
    if (b.add_assignees !== undefined) nextAssignees = [...new Set([...nextAssignees, ...cleanPeople(app, locationId, b.add_assignees, 'Zuständige')])];
    if (b.remove_assignees !== undefined) {
      const rm = new Set((Array.isArray(b.remove_assignees) ? b.remove_assignees : []).map(String));
      nextAssignees = nextAssignees.filter((u) => !rm.has(u));
    }
    if (nextAssignees.length > 20) throw bad('Zuständige: höchstens 20 Personen');
  }

  const noChange = !Object.keys(patch).length && !nextAssignees && b.watchers === undefined && b.add_watchers === undefined && b.remove_watchers === undefined;
  if (noChange) return before;
  patch.updated_at = now();

  db.tx(() => {
    db.update('tasks', cur.id, patch, locationId);
    if (nextAssignees) {
      assigneeDelta = setAssignees(app, locationId, cur.id, nextAssignees);
      if (assigneeDelta.added.length || assigneeDelta.removed.length) changes.assignees = [before.assignees.map((a) => a.name).join(', '), team(app, locationId).filter((p) => nextAssignees!.includes(p.id)).map((p) => p.name).join(', ')];
    }
    if (b.watchers !== undefined || b.add_watchers !== undefined || b.remove_watchers !== undefined) {
      let list = b.watchers !== undefined ? cleanPeople(app, locationId, b.watchers, 'Beobachter') : before.watchers;
      if (b.add_watchers !== undefined) list = [...new Set([...list, ...cleanPeople(app, locationId, b.add_watchers, 'Beobachter')])];
      if (b.remove_watchers !== undefined) {
        const rm = new Set((Array.isArray(b.remove_watchers) ? b.remove_watchers : []).map(String));
        list = list.filter((u) => !rm.has(u));
      }
      db.run('DELETE FROM pm_watchers WHERE task_id = ?', cur.id);
      for (const u of list) db.run('INSERT OR IGNORE INTO pm_watchers (task_id, user_id, created_at) VALUES (?, ?, ?)', cur.id, u, now());
    }
    if (moved) {
      // Subtasks go along; links to tasks of other projects no longer make sense.
      const kids = subtreeIds(app, locationId, cur.id);
      for (const kid of kids) {
        const k = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', kid)!;
        const ks = statusesOf(app, k.project_id!).find((s) => s.id === k.status_id);
        const mapped = mapStatusToProject(statuses, ks, !!k.done);
        db.run('UPDATE tasks SET project_id = ?, section_id = NULL, status_id = ?, updated_at = ? WHERE id = ?', projectId, mapped?.id ?? null, now(), kid);
      }
      const group = [cur.id, ...kids];
      db.run(`DELETE FROM pm_dependencies WHERE (task_id IN (${marks(group.length)}) AND depends_on NOT IN (${marks(group.length)})) OR (depends_on IN (${marks(group.length)}) AND task_id NOT IN (${marks(group.length)}))`, ...group, ...group, ...group, ...group);
      db.run(`UPDATE pm_dependencies SET project_id = ? WHERE task_id IN (${marks(group.length)})`, projectId, ...group);
    }
    for (const [k, [from, to]] of Object.entries(changes)) logTask(app, { id: cur.id, location_id: locationId, project_id: projectId }, actor, k === 'status' && completedNow ? 'completed' : k, { from, to });
  });

  const out = getTask(app, locationId, cur.id);
  const depth = opts.automationDepth ?? 0;
  const base = { contactId: out.contact_id ?? undefined, task: out, projectId: out.project_id, automationDepth: depth, automationChain: opts.automationChain ?? [] };
  app.events.emit(locationId, 'task.updated', { ...base, changed: Object.keys(changes) });
  if (statusChanged) app.events.emit(locationId, 'task.status_changed', { ...base, from: before.status, to: out.status });
  if (completedNow) {
    app.events.emit(locationId, 'task.completed', base);
    if (!opts.noRecurrence) spawnNextOccurrence(app, locationId, cur.id, actor, depth, opts.automationChain);
    notifyWatchers(app, out, actor, `${actor.name} hat „${out.title}“ erledigt`, `done:${out.id}`);
  } else if (statusChanged) notifyWatchers(app, out, actor, `${actor.name} hat „${out.title}“ auf „${out.status?.name ?? ''}“ gesetzt`, `status:${out.id}:${out.status_id}`);
  if (assigneeDelta?.added.length) {
    app.events.emit(locationId, 'task.assigned', { ...base, userIds: assigneeDelta.added });
    notifyAssigned(app, out, assigneeDelta.added, actor);
  }
  return out;
}

/** Tell the people who watch a task (never the one who did it) – a status change or completion. */
export function notifyWatchers(app: App, t: TaskOut, actor: Actor, title: string, refBase: string) {
  for (const u of new Set([...t.watchers, ...t.assignees.map((a) => a.id)])) {
    if (u === actor.id) continue;
    notifyUser(app, { locationId: t.location_id, userId: u, kind: 'status', title, taskId: t.id, projectId: t.project_id, ref: `${refBase}:${u}:${now().slice(0, 16)}`, quiet: true });
  }
}

// --- recurrence ---------------------------------------------------------------------------------

/**
 * When a recurring task is done, the next one is created (once): same title, people, tags and checklist (reset),
 * with the dates moved on by the rule. The finished task keeps its history; the rule moves to the new one.
 */
export function spawnNextOccurrence(app: App, locationId: string, taskId: string, actor: Actor, depth = 0, chain: string[] = []): TaskOut | null {
  const { db } = app;
  const t = db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND location_id = ?', taskId, locationId);
  if (!t || !t.recurrence || t.recurred_at || !t.done) return null;
  const rule = json<Recurrence | null>(t.recurrence, null);
  if (!rule) return null;
  const tz = tzOf(app, locationId);
  const today = todayIn(tz);
  const dueDay = dayOf(t.due_at, tz);
  const base = rule.mode === 'completion' || !dueDay ? today : dueDay;
  let next = nextOccurrence(rule, base);
  // "From the due date" never lands in the past: skip occurrences already behind us.
  for (let guard = 0; next && next < today && rule.mode === 'due' && guard < 400; guard++) next = nextOccurrence({ ...rule, done: (rule.done ?? 0) }, next);
  if (!next) {
    db.run('UPDATE tasks SET recurred_at = ? WHERE id = ?', now(), t.id);
    return null;
  }
  const startDay = dayOf(t.start_at, tz);
  const span = startDay && dueDay ? diffDays(startDay, dueDay) : 0;
  const nextStart = t.start_at && startDay ? addDays(next, -span) : null;
  const statuses = statusesOf(app, t.project_id!);
  const assignees = db.all<{ user_id: string }>('SELECT user_id FROM pm_assignees WHERE task_id = ?', t.id).map((r) => r.user_id);
  const watchers = db.all<{ user_id: string }>('SELECT user_id FROM pm_watchers WHERE task_id = ?', t.id).map((r) => r.user_id);
  const checklists = json<Checklist[]>(t.checklists, []).map((c) => ({ ...c, id: newId(8), items: c.items.map((i) => ({ ...i, id: newId(8), done: false })) }));
  const nextRule: Recurrence = { ...rule, done: (rule.done ?? 0) + 1 };
  db.run('UPDATE tasks SET recurred_at = ?, recurrence = NULL WHERE id = ?', now(), t.id);
  const created = createTask(
    app,
    locationId,
    {
      title: t.title,
      description: t.description,
      project_id: t.project_id,
      section_id: t.section_id,
      parent_id: t.parent_id,
      status_id: statusFor(statuses, 'todo')?.id,
      contact_id: t.contact_id,
      priority: t.priority,
      estimate_minutes: t.estimate_minutes,
      tags: json<string[]>(t.tags, []),
      custom: json<Record<string, any>>(t.custom, {}),
      checklists,
      internal: !!t.internal,
      milestone: !!t.milestone,
      due_at: t.due_at ? withDay(t.due_at, next, tz) : null,
      start_at: nextStart && t.start_at ? withDay(t.start_at, nextStart, tz) : null,
      assignees: assignees.filter((u) => isMember(app, locationId, u)),
      watchers: watchers.filter((u) => isMember(app, locationId, u)),
      recurrence: nextRule,
      series_id: t.series_id ?? t.id,
    },
    { id: actor.id, name: actor.name, via: 'recurrence' },
    { automationDepth: depth, automationChain: chain },
  );
  // Subtasks start over as well.
  for (const k of db.all<TaskRow>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY position', t.id)) {
    createTask(app, locationId, { title: k.title, description: k.description, parent_id: created.id, priority: k.priority, estimate_minutes: k.estimate_minutes, tags: json<string[]>(k.tags, []), assignees: db.all<{ user_id: string }>('SELECT user_id FROM pm_assignees WHERE task_id = ?', k.id).map((r) => r.user_id).filter((u) => isMember(app, locationId, u)) }, { id: actor.id, name: actor.name, via: 'recurrence' }, { quiet: true });
  }
  logTask(app, t, actor, 'recurred', { next: created.id });
  app.services.audit?.({ action: 'pm.task.recur', actor: actor.name, locationId, entityId: created.id, summary: `${t.title} (Wiederholung)`, userId: null });
  return created;
}

const isMember = (app: App, locationId: string, userId: string) => team(app, locationId).some((p) => p.id === userId);

// --- dates (Gantt) & dependencies --------------------------------------------------------------

export const calendarOf = (p: Pick<ProjectRow, 'skip_weekends'>): Calendar => (p.skip_weekends ? CALENDAR_WORKDAYS : CALENDAR_DAYS);

/** A task's planned days for scheduling: start/due, a single date counts as one day. */
export function planned(t: Pick<TaskRow, 'start_at' | 'due_at'>, tz: string): Dates | null {
  const s = dayOf(t.start_at ?? t.due_at, tz);
  const e = dayOf(t.due_at ?? t.start_at, tz);
  return s && e ? { start: s, end: e < s ? s : e } : null;
}

export function depsOf(app: App, locationId: string, projectId: string): (Dep & { id: string })[] {
  return app.db
    .all<any>('SELECT id, task_id, depends_on, type, lag FROM pm_dependencies WHERE location_id = ? AND project_id = ?', locationId, projectId)
    .map((d) => ({ id: d.id, task: d.task_id, on: d.depends_on, type: d.type, lag: d.lag }));
}

export function addDependency(app: App, locationId: string, taskId: string, b: any, actor: Actor) {
  const { db } = app;
  const task = taskRow(app, locationId, taskId);
  const on = taskRow(app, locationId, String(b.depends_on ?? b.on ?? ''));
  if (task.project_id !== on.project_id) throw bad('Abhängigkeiten gibt es nur innerhalb eines Projekts');
  try {
    const type = cleanDepType(b.type);
    const lag = cleanLag(b.lag);
    if (related(treeAround(app, locationId, [task.id, on.id]), task.id, on.id)) throw new DepError('ancestor', 'Eine Aufgabe kann nicht von ihrer Unter- oder Oberaufgabe abhängen');
    const existing = depsOf(app, locationId, task.project_id!);
    assertDependency(existing, { task: task.id, on: on.id });
    const row = { id: newId(), location_id: locationId, project_id: task.project_id, task_id: task.id, depends_on: on.id, type, lag, created_at: now() };
    db.insert('pm_dependencies', row);
    logTask(app, task, actor, 'dependency', { on: on.title, type, lag });
    // Same shape as every other task.updated (webhooks and REST hooks hand `task` on as the task, not its id).
    app.events.emit(locationId, 'task.updated', { contactId: task.contact_id ?? undefined, task: getTask(app, locationId, task.id), projectId: task.project_id, changed: ['dependencies'] });
    return row;
  } catch (e) {
    failOnTree(e);
  }
}

export function updateDependency(app: App, locationId: string, depId: string, b: any) {
  const d = app.db.get<any>('SELECT * FROM pm_dependencies WHERE id = ? AND location_id = ?', depId, locationId);
  if (!d) throw notFound('Abhängigkeit nicht gefunden');
  try {
    const patch: Record<string, any> = {};
    if (b.type !== undefined) patch.type = cleanDepType(b.type);
    if (b.lag !== undefined) patch.lag = cleanLag(b.lag);
    app.db.update('pm_dependencies', d.id, patch);
  } catch (e) {
    failOnTree(e);
  }
  return app.db.get<any>('SELECT * FROM pm_dependencies WHERE id = ?', d.id);
}

export interface MoveResult {
  task: TaskOut;
  /** Other tasks that were pushed because they depend on the moved one. */
  shifted: TaskOut[];
  /** Done tasks a link would have moved (they stay). */
  blocked: string[];
}

/**
 * Sets a task's dates from the Gantt (drag, resize) and – with `cascade` – pushes every dependent task so all
 * links hold again. Dates come as `YYYY-MM-DD`; a time of day on the task is kept.
 */
export function moveTaskDates(app: App, locationId: string, taskId: string, b: { start?: string | null; due?: string | null; cascade?: boolean }, actor: Actor): MoveResult {
  const { db } = app;
  const t = taskRow(app, locationId, taskId);
  const project = getProject(app, locationId, t.project_id!);
  const tz = tzOf(app, locationId);
  const cal = calendarOf(project);
  const ymd = (v: unknown, label: string) => {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${label}: Datum als JJJJ-MM-TT`);
    return s;
  };
  const start = b.start === undefined ? (dayOf(t.start_at, tz) ?? null) : ymd(b.start, 'Start');
  const due = b.due === undefined ? (dayOf(t.due_at, tz) ?? null) : ymd(b.due, 'Ende');
  if (start && due && start > due) throw bad('Der Start liegt nach dem Ende');
  const patch = { start_at: start ? withDay(t.start_at, start, tz) : null, due_at: due ? withDay(t.due_at, due, tz) : null, updated_at: now() };
  const shiftedIds: string[] = [];
  let blocked: string[] = [];
  db.tx(() => {
    db.update('tasks', t.id, patch, locationId);
    logTask(app, t, actor, 'dates', { from: [t.start_at, t.due_at], to: [patch.start_at, patch.due_at] });
    if (b.cascade === false) return;
    const rows = db.all<TaskRow>('SELECT * FROM tasks WHERE location_id = ? AND project_id = ?', locationId, project.id);
    const sched = rows.map((r) => ({ r, p: planned(r.id === t.id ? ({ ...r, ...patch } as TaskRow) : r, tz) })).filter((x): x is { r: TaskRow; p: Dates } => !!x.p);
    const result = cascade(sched.map((x) => ({ id: x.r.id, start: x.p.start, end: x.p.end, done: !!x.r.done })), depsOf(app, locationId, project.id), [t.id], cal);
    blocked = result.blocked;
    for (const [id, to] of Object.entries(result.changes)) {
      const r = rows.find((x) => x.id === id)!;
      const sets = { start_at: r.start_at ? withDay(r.start_at, to.start, tz) : null, due_at: withDay(r.due_at ?? r.start_at, to.end, tz), updated_at: now() };
      // A task that had only one date keeps one date.
      if (!r.start_at) sets.due_at = withDay(r.due_at, to.end, tz);
      db.update('tasks', id, sets, locationId);
      logTask(app, r, actor, 'dates', { from: [r.start_at, r.due_at], to: [sets.start_at, sets.due_at], cause: t.title });
      shiftedIds.push(id);
    }
  });
  app.events.emit(locationId, 'task.updated', { contactId: t.contact_id ?? undefined, task: getTask(app, locationId, t.id), projectId: project.id, changed: ['dates'], automationDepth: 0 });
  return { task: getTask(app, locationId, t.id), shifted: shiftedIds.length ? decorate(app, locationId, shiftedIds.map((i) => taskRow(app, locationId, i))) : [], blocked };
}

// --- delete & bulk ------------------------------------------------------------------------------

export function deleteTask(app: App, locationId: string, taskId: string, actor: Actor): { deleted: number } {
  const t = taskRow(app, locationId, taskId);
  const kids = subtreeIds(app, locationId, t.id);
  const files = app.db.all<{ file: string | null }>(`SELECT file FROM pm_attachments WHERE task_id IN (${marks(kids.length + 1)}) AND file IS NOT NULL`, t.id, ...kids);
  app.db.run('DELETE FROM tasks WHERE id = ? AND location_id = ?', t.id, locationId);
  removeFiles(app, files.map((f) => f.file));
  app.events.emit(locationId, 'task.deleted', { contactId: t.contact_id ?? undefined, taskId: t.id, title: t.title, projectId: t.project_id, by: actor.name });
  return { deleted: kids.length + 1 };
}

export interface BulkInput {
  ids?: unknown;
  action?: string;
  patch?: Record<string, any>;
  add_tags?: unknown;
  remove_tags?: unknown;
}

/** Edits many tasks the same way (list view): status, people, priority, dates, tags, project, section; or deletes them. */
export function bulkTasks(app: App, locationId: string, b: BulkInput, actor: Actor): { updated: number; failed: { id: string; error: string }[] } {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean);
  if (!ids.length) throw bad('Keine Aufgaben ausgewählt');
  if (ids.length > 500) throw bad('Höchstens 500 Aufgaben auf einmal');
  let updated = 0;
  const failed: { id: string; error: string }[] = [];
  for (const tid of ids) {
    try {
      if (b.action === 'delete') deleteTask(app, locationId, tid, actor);
      else {
        const patch: Record<string, any> = { ...(b.patch ?? {}) };
        if (b.add_tags !== undefined || b.remove_tags !== undefined) {
          const cur = json<string[]>(taskRow(app, locationId, tid).tags, []);
          const rm = new Set(cleanTags(b.remove_tags).map((x) => x.toLowerCase()));
          patch.tags = cleanTags([...cur.filter((x) => !rm.has(x.toLowerCase())), ...cleanTags(b.add_tags)]);
        }
        if (!Object.keys(patch).length) throw bad('Nichts zu ändern');
        updateTask(app, locationId, tid, patch, actor);
      }
      updated++;
    } catch (e) {
      failed.push({ id: tid, error: (e as Error).message });
    }
  }
  return { updated, failed };
}

/** The task's own new position when it is dropped between two others (board/list drag and drop). */
export function positionBetween(app: App, locationId: string, before: string | null | undefined, after: string | null | undefined): number | undefined {
  const pos = (tid: string | null | undefined) => (tid ? app.db.get<{ position: number }>('SELECT position FROM tasks WHERE id = ? AND location_id = ?', tid, locationId)?.position : undefined);
  const a = pos(after);
  const b = pos(before);
  if (a !== undefined && b !== undefined) return (a + b) / 2;
  if (a !== undefined) return a + 1000;
  if (b !== undefined) return b - 1000;
  return undefined;
}

export { endFromDuration, durationOf };
export { actorOf };
