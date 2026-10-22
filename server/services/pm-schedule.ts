/**
 * Project planning math, pure and without imports (the Gantt view in the browser uses it too):
 *
 * - day arithmetic on `YYYY-MM-DD` strings, optionally skipping weekends ("Arbeitstage");
 * - dependencies (finish-to-start, start-to-start, finish-to-finish, start-to-finish, each with a lag in days),
 *   cycle detection and the earliest start a dependency allows;
 * - cascading a moved task through its successors, ASAP auto-scheduling, violated links;
 * - critical path (forward/backward pass over the planned dates, total float);
 * - workload (estimates spread over the days a task runs).
 *
 * A task occupies the days `start … end` inclusive. A finish-to-start link with lag 0 therefore lets the
 * successor begin on the day after the predecessor's last day.
 */

export type DepType = 'FS' | 'SS' | 'FF' | 'SF';
export const DEP_TYPES: DepType[] = ['FS', 'SS', 'FF', 'SF'];
export const DEP_LABELS: Record<DepType, string> = {
  FS: 'Ende → Start',
  SS: 'Start → Start',
  FF: 'Ende → Ende',
  SF: 'Start → Ende',
};
export const MAX_LAG_DAYS = 365;

export interface Calendar {
  /** Saturdays and Sundays do not count when moving and measuring. */
  skipWeekends: boolean;
}
export const CALENDAR_DAYS: Calendar = { skipWeekends: false };
export const CALENDAR_WORKDAYS: Calendar = { skipWeekends: true };

export interface SchedTask {
  id: string;
  start: string;
  end: string;
  done?: boolean;
}
export interface Dep {
  /** The dependent task (successor). */
  task: string;
  /** The task it waits for (predecessor). */
  on: string;
  type: DepType;
  /** Days between the two events; negative = overlap. */
  lag: number;
}
export type Dates = { start: string; end: string };

// --- days -----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = YMD.exec(s);
  if (!m) return false;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === s;
}

/** Whole days since 1970-01-01. */
export const dayNumber = (ymd: string): number => {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`Ungültiges Datum: ${ymd}`);
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
};
export const ymdOf = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number): string => ymdOf(dayNumber(ymd) + n);
/** `b - a` in calendar days. */
export const diffDays = (a: string, b: string): number => dayNumber(b) - dayNumber(a);
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (ymd: string): number => (((dayNumber(ymd) + 4) % 7) + 7) % 7;
export const isWorkday = (ymd: string): boolean => {
  const w = weekdayOf(ymd);
  return w !== 0 && w !== 6;
};
export const mondayOf = (ymd: string): string => addDays(ymd, -((weekdayOf(ymd) + 6) % 7));

/** The same day, or the next/previous working day when it falls on a weekend. */
export function snapDay(ymd: string, cal: Calendar, dir: 1 | -1 = 1): string {
  if (!cal.skipWeekends) return ymd;
  let d = ymd;
  while (!isWorkday(d)) d = addDays(d, dir);
  return d;
}

/** Moves `n` days (working days with `skipWeekends`); n may be negative, 0 only snaps to a working day. */
export function stepDays(ymd: string, n: number, cal: Calendar = CALENDAR_DAYS): string {
  if (!cal.skipWeekends) return addDays(ymd, n);
  let d = snapDay(ymd, cal, n < 0 ? -1 : 1);
  const dir = n < 0 ? -1 : 1;
  for (let i = Math.abs(n); i > 0; i--) {
    d = addDays(d, dir);
    while (!isWorkday(d)) d = addDays(d, dir);
  }
  return d;
}

/** Days from `a` to `b` (negative when b < a); with `skipWeekends` only working days are counted. */
export function countDays(a: string, b: string, cal: Calendar = CALENDAR_DAYS): number {
  if (!cal.skipWeekends) return diffDays(a, b);
  if (a === b) return 0;
  if (b < a) return -countDays(b, a, cal);
  let n = 0;
  for (let d = snapDay(a, cal); d < b; ) {
    d = addDays(d, 1);
    if (isWorkday(d)) n++;
  }
  return n;
}

/** Length of a task in days, both ends included (at least 1). */
export const durationOf = (t: Dates, cal: Calendar = CALENDAR_DAYS): number => Math.max(1, countDays(t.start, t.end, cal) + 1);
export const endFromDuration = (start: string, duration: number, cal: Calendar = CALENDAR_DAYS): string => stepDays(start, Math.max(1, Math.floor(duration)) - 1, cal);

/** Shifts a task by `delta` days (working days when skipping weekends), keeping its length. */
export function shiftDates(t: Dates, delta: number, cal: Calendar = CALENDAR_DAYS): Dates {
  const dur = durationOf(t, cal);
  const start = stepDays(t.start, delta, cal);
  return { start, end: endFromDuration(start, dur, cal) };
}

/** Moves one edge of a task (drag a handle); the task keeps at least one day. */
export function resizeDates(t: Dates, edge: 'start' | 'end', delta: number, cal: Calendar = CALENDAR_DAYS): Dates {
  if (edge === 'start') {
    const start = stepDays(t.start, delta, cal);
    return { start: start > t.end ? t.end : start, end: t.end };
  }
  const end = stepDays(t.end, delta, cal);
  return { start: t.start, end: end < t.start ? t.start : end };
}

// --- dependencies ---------------------------------------------------------------------------

export class DepError extends Error {
  constructor(
    public code: 'self' | 'duplicate' | 'cycle' | 'type' | 'lag' | 'ancestor',
    message: string,
  ) {
    super(message);
  }
}

export const cleanDepType = (v: unknown): DepType => {
  const t = String(v ?? 'FS').toUpperCase();
  if (!DEP_TYPES.includes(t as DepType)) throw new DepError('type', 'Unbekannter Abhängigkeitstyp (FS, SS, FF oder SF)');
  return t as DepType;
};
export const cleanLag = (v: unknown): number => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_LAG_DAYS || Math.round(n) !== n) throw new DepError('lag', `Versatz: ganze Tage zwischen -${MAX_LAG_DAYS} und ${MAX_LAG_DAYS}`);
  return n;
};

/** Successor lists: predecessor → [successor, …]. */
function successors(deps: Dep[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of deps) m.set(d.on, [...(m.get(d.on) ?? []), d.task]);
  return m;
}
function predecessors(deps: Dep[]): Map<string, Dep[]> {
  const m = new Map<string, Dep[]>();
  for (const d of deps) m.set(d.task, [...(m.get(d.task) ?? []), d]);
  return m;
}

/** Is `to` reachable from `from` by following predecessor → successor links? */
export function reachable(deps: Dep[], from: string, to: string): boolean {
  const next = successors(deps);
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    for (const n of next.get(cur) ?? []) if (!seen.has(n)) (seen.add(n), stack.push(n));
  }
  return false;
}

/**
 * Checks a new link `task` waits for `on` against the existing ones: not on itself, not twice and – above
 * all – no cycle (A waits for B waits for A, however long the chain). Throws a DepError.
 */
export function assertDependency(existing: Dep[], add: { task: string; on: string }): void {
  if (add.task === add.on) throw new DepError('self', 'Eine Aufgabe kann nicht von sich selbst abhängen');
  if (existing.some((d) => d.task === add.task && d.on === add.on)) throw new DepError('duplicate', 'Diese Abhängigkeit gibt es schon');
  // The new edge on → task closes a cycle exactly when `task` already leads to `on`.
  if (reachable(existing, add.task, add.on)) throw new DepError('cycle', 'Zirkelbezug: die Aufgaben würden voneinander abhängen');
}

/** A cycle in the graph as a list of ids (first = last), or null. */
export function findCycle(deps: Dep[]): string[] | null {
  const next = successors(deps);
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    path.push(n);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) return [...path.slice(path.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    path.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of new Set(deps.flatMap((d) => [d.on, d.task]))) if (!state.has(n)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/** Predecessors before successors; `cycle` is set (and the order partial) when the graph has a cycle. */
export function topoOrder(ids: string[], deps: Dep[]): { order: string[]; cycle: boolean } {
  const known = new Set(ids);
  const inDeg = new Map<string, number>(ids.map((i) => [i, 0]));
  const next = new Map<string, string[]>();
  for (const d of deps) {
    if (!known.has(d.on) || !known.has(d.task)) continue;
    inDeg.set(d.task, (inDeg.get(d.task) ?? 0) + 1);
    next.set(d.on, [...(next.get(d.on) ?? []), d.task]);
  }
  const queue = ids.filter((i) => !inDeg.get(i));
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    order.push(n);
    for (const m of next.get(n) ?? []) {
      inDeg.set(m, inDeg.get(m)! - 1);
      if (!inDeg.get(m)) queue.push(m);
    }
  }
  return { order, cycle: order.length < ids.length };
}

/** The earliest day the successor may start for one link, given where the predecessor is planned. */
export function earliestStart(dep: Pick<Dep, 'type' | 'lag'>, pred: Dates, succDuration: number, cal: Calendar = CALENDAR_DAYS): string {
  const back = (d: string) => stepDays(d, -(Math.max(1, succDuration) - 1), cal);
  switch (dep.type) {
    case 'FS':
      return stepDays(pred.end, 1 + dep.lag, cal);
    case 'SS':
      return stepDays(pred.start, dep.lag, cal);
    case 'FF':
      return back(stepDays(pred.end, dep.lag, cal));
    case 'SF':
      return back(stepDays(pred.start, dep.lag, cal));
  }
}

/** The latest day the predecessor may finish so the successor (planned at `succLate`) is not pushed. */
function latestFinish(dep: Pick<Dep, 'type' | 'lag'>, succLate: Dates, predDuration: number, cal: Calendar): string {
  const fwd = (d: string) => stepDays(d, Math.max(1, predDuration) - 1, cal);
  switch (dep.type) {
    case 'FS':
      return stepDays(succLate.start, -(1 + dep.lag), cal);
    case 'SS':
      return fwd(stepDays(succLate.start, -dep.lag, cal));
    case 'FF':
      return stepDays(succLate.end, -dep.lag, cal);
    case 'SF':
      return fwd(stepDays(succLate.end, -dep.lag, cal));
  }
}

const datesMap = (tasks: SchedTask[]) => new Map(tasks.map((t) => [t.id, { start: t.start, end: t.end }]));

/** Links whose constraint is broken by the current plan (successor starts too early). */
export function violations(tasks: SchedTask[], deps: Dep[], cal: Calendar = CALENDAR_DAYS): { dep: Dep; required: string; start: string }[] {
  const at = datesMap(tasks);
  const out: { dep: Dep; required: string; start: string }[] = [];
  for (const dep of deps) {
    const p = at.get(dep.on);
    const s = at.get(dep.task);
    if (!p || !s) continue;
    const required = earliestStart(dep, p, durationOf(s, cal), cal);
    if (s.start < required) out.push({ dep, required, start: s.start });
  }
  return out;
}

export interface CascadeResult {
  /** Dates of every task that had to move (not the ones passed as `moved`). */
  changes: Record<string, Dates>;
  /** Tasks that could not move because they are done. */
  blocked: string[];
}

/**
 * After a task was moved, pushes everything that depends on it (directly or through a chain) just far enough
 * that every link holds again, keeping each task's length. Tasks are never pulled earlier; finished tasks stay
 * where they are (and are reported in `blocked` when a link would have moved them).
 */
export function cascade(tasks: SchedTask[], deps: Dep[], moved: string[], cal: Calendar = CALENDAR_DAYS): CascadeResult {
  const at = datesMap(tasks);
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const { order, cycle } = topoOrder([...at.keys()], deps);
  if (cycle) throw new DepError('cycle', 'Zirkelbezug in den Abhängigkeiten');
  const preds = predecessors(deps);
  const affected = new Set<string>();
  const next = successors(deps);
  const stack = [...moved];
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of next.get(n) ?? []) if (!affected.has(m)) (affected.add(m), stack.push(m));
  }
  const changes: Record<string, Dates> = {};
  const blocked: string[] = [];
  for (const id of order) {
    if (!affected.has(id) || moved.includes(id)) continue;
    const cur = at.get(id)!;
    const dur = durationOf(cur, cal);
    let need = cur.start;
    for (const d of preds.get(id) ?? []) {
      const p = at.get(d.on);
      if (!p) continue;
      const e = earliestStart(d, p, dur, cal);
      if (e > need) need = e;
    }
    if (need <= cur.start) continue;
    if (done.has(id)) {
      blocked.push(id);
      continue;
    }
    const to = { start: need, end: endFromDuration(need, dur, cal) };
    at.set(id, to);
    changes[id] = to;
  }
  return { changes, blocked };
}

/**
 * ASAP schedule: every task that has predecessors starts as early as its links allow (pulled earlier or pushed
 * later). Tasks without predecessors and finished tasks keep their dates and anchor the plan.
 */
export function autoSchedule(tasks: SchedTask[], deps: Dep[], cal: Calendar = CALENDAR_DAYS): Record<string, Dates> {
  const at = datesMap(tasks);
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const { order, cycle } = topoOrder([...at.keys()], deps);
  if (cycle) throw new DepError('cycle', 'Zirkelbezug in den Abhängigkeiten');
  const preds = predecessors(deps);
  const changes: Record<string, Dates> = {};
  for (const id of order) {
    const list = (preds.get(id) ?? []).filter((d) => at.has(d.on));
    if (!list.length || done.has(id)) continue;
    const cur = at.get(id)!;
    const dur = durationOf(cur, cal);
    let need: string | undefined;
    for (const d of list) {
      const e = earliestStart(d, at.get(d.on)!, dur, cal);
      if (!need || e > need) need = e;
    }
    if (!need || need === cur.start) continue;
    const to = { start: need, end: endFromDuration(need, dur, cal) };
    at.set(id, to);
    changes[id] = to;
  }
  return changes;
}

export interface CriticalInfo {
  /** Working/calendar days the task can slip without delaying the project end. */
  float: Record<string, number>;
  /** Tasks on the critical path: no float, part of a dependency chain, not done. */
  critical: string[];
  /** Links between two critical tasks that hold with no slack – drawn highlighted. */
  links: { task: string; on: string }[];
  /** The planned end of the whole project (latest end of any task). */
  end: string | null;
}

/**
 * Critical path method on the planned dates: the project ends when the last task ends; walking backwards
 * through the links gives each task its latest dates, and the difference to the plan is its float.
 */
export function criticalPath(tasks: SchedTask[], deps: Dep[], cal: Calendar = CALENDAR_DAYS): CriticalInfo {
  const at = datesMap(tasks);
  const done = new Set(tasks.filter((t) => t.done).map((t) => t.id));
  const valid = deps.filter((d) => at.has(d.task) && at.has(d.on));
  const { order, cycle } = topoOrder([...at.keys()], valid);
  const out: CriticalInfo = { float: {}, critical: [], links: [], end: null };
  if (!at.size || cycle) return out;
  const finish = [...at.values()].reduce((m, d) => (d.end > m ? d.end : m), '');
  out.end = finish;
  const next = new Map<string, Dep[]>();
  for (const d of valid) next.set(d.on, [...(next.get(d.on) ?? []), d]);
  const late = new Map<string, Dates>();
  for (const id of [...order].reverse()) {
    const cur = at.get(id)!;
    const dur = durationOf(cur, cal);
    let lf = finish;
    for (const d of next.get(id) ?? []) {
      const s = late.get(d.task)!;
      const f = latestFinish(d, s, dur, cal);
      if (f < lf) lf = f;
    }
    late.set(id, { start: stepDays(lf, -(dur - 1), cal), end: lf });
  }
  const linked = new Set(valid.flatMap((d) => [d.task, d.on]));
  for (const [id, cur] of at) {
    const f = countDays(cur.start, late.get(id)!.start, cal);
    out.float[id] = f;
    if (f <= 0 && linked.has(id) && !done.has(id)) out.critical.push(id);
  }
  const crit = new Set(out.critical);
  for (const d of valid) {
    if (!crit.has(d.task) || !crit.has(d.on)) continue;
    const p = at.get(d.on)!;
    const s = at.get(d.task)!;
    if (earliestStart(d, p, durationOf(s, cal), cal) === s.start) out.links.push({ task: d.task, on: d.on });
  }
  return out;
}

// --- hierarchy-aware helpers -------------------------------------------------------------------

/** Planned dates of a parent that has none of its own: from its first start to its last end. */
export function rollupDates(children: Dates[]): Dates | null {
  if (!children.length) return null;
  return { start: children.reduce((m, c) => (c.start < m ? c.start : m), children[0].start), end: children.reduce((m, c) => (c.end > m ? c.end : m), children[0].end) };
}

// --- workload -----------------------------------------------------------------------------------

export interface LoadTask {
  id: string;
  start: string | null;
  end: string | null;
  estimate_minutes: number | null;
  assignees: string[];
  done?: boolean;
}

/**
 * Minutes per person and day: each open task spreads its estimate evenly over the working days it runs
 * (a task with one date lands on that day; several assignees share it equally). Days outside [from, to] are
 * left out. `unassigned` collects tasks nobody owns.
 */
export function workload(tasks: LoadTask[], from: string, to: string, opts: { skipWeekends?: boolean } = {}): Record<string, Record<string, number>> {
  const cal: Calendar = { skipWeekends: opts.skipWeekends !== false };
  const out: Record<string, Record<string, number>> = {};
  for (const t of tasks) {
    if (t.done || !t.estimate_minutes || t.estimate_minutes <= 0) continue;
    const s = t.start ?? t.end;
    const e = t.end ?? t.start;
    if (!s || !e) continue;
    const days: string[] = [];
    for (let d = s; d <= e && days.length < 800; d = addDays(d, 1)) if (!cal.skipWeekends || isWorkday(d)) days.push(d);
    // A task that sits on a weekend only: put it on the closest working day.
    if (!days.length) days.push(snapDay(s, cal));
    const people = t.assignees.length ? t.assignees : ['unassigned'];
    const perDay = t.estimate_minutes / days.length / people.length;
    for (const d of days) {
      if (d < from || d > to) continue;
      for (const p of people) {
        const row = (out[p] ??= {});
        row[d] = Math.round(((row[d] ?? 0) + perDay) * 100) / 100;
      }
    }
  }
  return out;
}
