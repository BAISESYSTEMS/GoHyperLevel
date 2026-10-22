import { describe, expect, it } from 'vitest';
import {
  CALENDAR_DAYS,
  CALENDAR_WORKDAYS,
  DepError,
  addDays,
  assertDependency,
  autoSchedule,
  cascade,
  cleanDepType,
  cleanLag,
  countDays,
  criticalPath,
  diffDays,
  durationOf,
  earliestStart,
  endFromDuration,
  findCycle,
  isWorkday,
  isYmd,
  mondayOf,
  reachable,
  resizeDates,
  rollupDates,
  shiftDates,
  snapDay,
  stepDays,
  topoOrder,
  violations,
  weekdayOf,
  workload,
  type Dep,
  type SchedTask,
} from '../server/services/pm-schedule.js';
import { MAX_DEPTH, TreeError, ancestors, assertParent, depthOf, descendants, flatten, progressOf, related, subtreeHeight, type ParentMap } from '../server/services/pm-tree.js';
import { RecurrenceError, cleanRecurrence, describeRecurrence, nextOccurrence, type Recurrence } from '../server/services/pm-recur.js';

// 2026-10-05 is a Monday.
const MON = '2026-10-05';
const t = (id: string, start: string, end: string, done = false): SchedTask => ({ id, start, end, done });
const dep = (task: string, on: string, type: Dep['type'] = 'FS', lag = 0): Dep => ({ task, on, type, lag });

describe('days and calendars', () => {
  it('validates and does arithmetic on YYYY-MM-DD', () => {
    expect(isYmd('2026-02-29')).toBe(false);
    expect(isYmd('2028-02-29')).toBe(true);
    expect(isYmd('2026-1-1')).toBe(false);
    expect(addDays(MON, 3)).toBe('2026-10-08');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(diffDays(MON, '2026-10-12')).toBe(7);
    expect(weekdayOf(MON)).toBe(1);
    expect(weekdayOf('2026-10-11')).toBe(0);
    expect(mondayOf('2026-10-11')).toBe(MON);
    expect(mondayOf(MON)).toBe(MON);
    expect(isWorkday('2026-10-10')).toBe(false);
  });

  it('steps over weekends only when asked', () => {
    expect(stepDays('2026-10-09', 1)).toBe('2026-10-10');
    expect(stepDays('2026-10-09', 1, CALENDAR_WORKDAYS)).toBe('2026-10-12');
    expect(stepDays('2026-10-12', -1, CALENDAR_WORKDAYS)).toBe('2026-10-09');
    expect(stepDays(MON, 5, CALENDAR_WORKDAYS)).toBe('2026-10-12');
    expect(stepDays(MON, -5, CALENDAR_WORKDAYS)).toBe('2026-09-28');
    // a weekend day snaps to the next working day when not moving
    expect(stepDays('2026-10-10', 0, CALENDAR_WORKDAYS)).toBe('2026-10-12');
    expect(snapDay('2026-10-11', CALENDAR_WORKDAYS)).toBe('2026-10-12');
    expect(snapDay('2026-10-11', CALENDAR_WORKDAYS, -1)).toBe('2026-10-09');
    expect(snapDay('2026-10-11', CALENDAR_DAYS)).toBe('2026-10-11');
  });

  it('counts days and durations (both ends included)', () => {
    expect(countDays(MON, '2026-10-12')).toBe(7);
    expect(countDays(MON, '2026-10-12', CALENDAR_WORKDAYS)).toBe(5);
    expect(countDays('2026-10-12', MON)).toBe(-7);
    expect(countDays('2026-10-09', '2026-10-12', CALENDAR_WORKDAYS)).toBe(1);
    expect(durationOf({ start: MON, end: '2026-10-09' })).toBe(5);
    expect(durationOf({ start: '2026-10-09', end: '2026-10-13' }, CALENDAR_WORKDAYS)).toBe(3);
    expect(durationOf({ start: MON, end: MON })).toBe(1);
    expect(endFromDuration('2026-10-09', 3, CALENDAR_WORKDAYS)).toBe('2026-10-13');
    expect(endFromDuration(MON, 1)).toBe(MON);
  });

  it('moves and resizes a task, never below one day', () => {
    expect(shiftDates({ start: MON, end: '2026-10-07' }, 3)).toEqual({ start: '2026-10-08', end: '2026-10-10' });
    expect(shiftDates({ start: MON, end: '2026-10-07' }, 3, CALENDAR_WORKDAYS)).toEqual({ start: '2026-10-08', end: '2026-10-12' });
    expect(shiftDates({ start: MON, end: '2026-10-07' }, -2)).toEqual({ start: '2026-10-03', end: '2026-10-05' });
    expect(resizeDates({ start: MON, end: '2026-10-07' }, 'end', 2)).toEqual({ start: MON, end: '2026-10-09' });
    expect(resizeDates({ start: MON, end: '2026-10-07' }, 'end', -10)).toEqual({ start: MON, end: MON });
    expect(resizeDates({ start: MON, end: '2026-10-07' }, 'start', 10)).toEqual({ start: '2026-10-07', end: '2026-10-07' });
    expect(resizeDates({ start: MON, end: '2026-10-07' }, 'start', -1)).toEqual({ start: '2026-10-04', end: '2026-10-07' });
  });
});

describe('dependency validation', () => {
  it('refuses itself, duplicates and cycles of any length', () => {
    const code = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(DepError);
        return (e as DepError).code;
      }
      return 'ok';
    };
    const chain = [dep('B', 'A'), dep('C', 'B'), dep('D', 'C')];
    expect(code(() => assertDependency([], { task: 'A', on: 'A' }))).toBe('self');
    expect(code(() => assertDependency(chain, { task: 'B', on: 'A' }))).toBe('duplicate');
    expect(code(() => assertDependency(chain, { task: 'A', on: 'B' }))).toBe('cycle');
    expect(code(() => assertDependency(chain, { task: 'A', on: 'D' }))).toBe('cycle');
    expect(code(() => assertDependency(chain, { task: 'B', on: 'D' }))).toBe('cycle');
    // not a cycle: parallel branches and diamonds
    expect(code(() => assertDependency(chain, { task: 'D', on: 'A' }))).toBe('ok');
    expect(code(() => assertDependency(chain, { task: 'E', on: 'A' }))).toBe('ok');
    expect(code(() => assertDependency([dep('B', 'A'), dep('C', 'A'), dep('D', 'B')], { task: 'D', on: 'C' }))).toBe('ok');
  });

  it('finds cycles and orders tasks predecessors first', () => {
    expect(findCycle([dep('B', 'A'), dep('C', 'B')])).toBeNull();
    const c = findCycle([dep('B', 'A'), dep('C', 'B'), dep('A', 'C')])!;
    expect(c[0]).toBe(c[c.length - 1]);
    expect(new Set(c)).toEqual(new Set(['A', 'B', 'C']));
    expect(topoOrder(['C', 'B', 'A'], [dep('B', 'A'), dep('C', 'B')])).toEqual({ order: ['A', 'B', 'C'], cycle: false });
    expect(topoOrder(['A', 'B'], [dep('B', 'A'), dep('A', 'B')]).cycle).toBe(true);
    expect(reachable([dep('B', 'A'), dep('C', 'B')], 'A', 'C')).toBe(true);
    expect(reachable([dep('B', 'A'), dep('C', 'B')], 'C', 'A')).toBe(false);
  });

  it('cleans type and lag', () => {
    expect(cleanDepType(undefined)).toBe('FS');
    expect(cleanDepType('ss')).toBe('SS');
    expect(() => cleanDepType('XX')).toThrow(DepError);
    expect(cleanLag(undefined)).toBe(0);
    expect(cleanLag(-2)).toBe(-2);
    expect(() => cleanLag(1.5)).toThrow(DepError);
    expect(() => cleanLag(9999)).toThrow(DepError);
  });
});

describe('what a link allows', () => {
  const pred = { start: MON, end: '2026-10-07' };
  it('computes the earliest start for every type', () => {
    expect(earliestStart({ type: 'FS', lag: 0 }, pred, 2)).toBe('2026-10-08');
    expect(earliestStart({ type: 'FS', lag: 2 }, pred, 2)).toBe('2026-10-10');
    expect(earliestStart({ type: 'FS', lag: -1 }, pred, 2)).toBe('2026-10-07');
    expect(earliestStart({ type: 'SS', lag: 0 }, pred, 2)).toBe(MON);
    expect(earliestStart({ type: 'SS', lag: 2 }, pred, 2)).toBe('2026-10-07');
    // finish-to-finish: the successor may not end before the predecessor ends
    expect(earliestStart({ type: 'FF', lag: 0 }, pred, 3)).toBe(MON);
    expect(earliestStart({ type: 'FF', lag: 0 }, pred, 1)).toBe('2026-10-07');
    // start-to-finish: the successor may not end before the predecessor starts
    expect(earliestStart({ type: 'SF', lag: 0 }, pred, 2)).toBe('2026-10-04');
  });
  it('skips weekends with the working-day calendar', () => {
    const fri = { start: '2026-10-08', end: '2026-10-09' };
    expect(earliestStart({ type: 'FS', lag: 0 }, fri, 1, CALENDAR_WORKDAYS)).toBe('2026-10-12');
    expect(earliestStart({ type: 'FS', lag: 1 }, fri, 1, CALENDAR_WORKDAYS)).toBe('2026-10-13');
    expect(earliestStart({ type: 'FS', lag: 0 }, fri, 1, CALENDAR_DAYS)).toBe('2026-10-10');
  });
  it('reports links the plan breaks', () => {
    const v = violations([t('A', MON, '2026-10-06'), t('B', '2026-10-06', '2026-10-08')], [dep('B', 'A')]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ required: '2026-10-07', start: '2026-10-06' });
    expect(violations([t('A', MON, '2026-10-06'), t('B', '2026-10-07', '2026-10-08')], [dep('B', 'A')])).toEqual([]);
  });
});

describe('cascading a moved task', () => {
  const chain = () => [t('A', MON, '2026-10-06'), t('B', '2026-10-07', '2026-10-08'), t('C', '2026-10-09', '2026-10-09')];
  const deps = [dep('B', 'A'), dep('C', 'B')];

  it('pushes the chain just far enough and keeps lengths', () => {
    const tasks = chain();
    tasks[0] = t('A', '2026-10-07', '2026-10-08'); // A moved two days later
    const r = cascade(tasks, deps, ['A']);
    expect(r.changes).toEqual({ B: { start: '2026-10-09', end: '2026-10-10' }, C: { start: '2026-10-11', end: '2026-10-11' } });
    expect(r.blocked).toEqual([]);
  });

  it('does nothing when there is slack, and never pulls tasks earlier', () => {
    const tasks = chain();
    tasks[2] = t('C', '2026-10-20', '2026-10-21');
    expect(cascade(tasks, deps, ['A']).changes).toEqual({});
    tasks[0] = t('A', '2026-10-01', '2026-10-02'); // moved earlier
    expect(cascade(tasks, deps, ['A']).changes).toEqual({});
  });

  it('leaves finished tasks alone and says so', () => {
    const tasks = [t('A', '2026-10-07', '2026-10-08'), t('B', '2026-10-07', '2026-10-08', true), t('C', '2026-10-09', '2026-10-09')];
    const r = cascade(tasks, deps, ['A']);
    expect(r.blocked).toEqual(['B']);
    expect(r.changes.B).toBeUndefined();
  });

  it('follows start-to-start links with lag and skips weekends in the working-day calendar', () => {
    const ss = cascade([t('A', '2026-10-12', '2026-10-13'), t('B', MON, '2026-10-06')], [dep('B', 'A', 'SS', 1)], ['A']);
    expect(ss.changes.B).toEqual({ start: '2026-10-13', end: '2026-10-14' });
    // Friday + finish-to-start lands on Monday
    const fs = cascade([t('A', '2026-10-08', '2026-10-09'), t('B', '2026-10-08', '2026-10-08')], [dep('B', 'A')], ['A'], CALENDAR_WORKDAYS);
    expect(fs.changes.B).toEqual({ start: '2026-10-12', end: '2026-10-12' });
  });

  it('refuses a graph with a cycle', () => {
    expect(() => cascade([t('A', MON, MON), t('B', MON, MON)], [dep('B', 'A'), dep('A', 'B')], ['A'])).toThrow(DepError);
  });

  it('branches: every successor is pushed by its own constraint', () => {
    const tasks = [t('A', '2026-10-12', '2026-10-13'), t('B', MON, '2026-10-06'), t('C', MON, '2026-10-06')];
    const r = cascade(tasks, [dep('B', 'A'), dep('C', 'A', 'FF')], ['A']);
    expect(r.changes.B).toEqual({ start: '2026-10-14', end: '2026-10-15' });
    // finish-to-finish: C (2 days) must end on 10-13 → starts 10-12
    expect(r.changes.C).toEqual({ start: '2026-10-12', end: '2026-10-13' });
  });
});

describe('auto-schedule', () => {
  it('pulls tasks with predecessors as early as their links allow', () => {
    const tasks = [t('A', MON, '2026-10-06'), t('B', '2026-10-12', '2026-10-13'), t('C', '2026-10-30', '2026-10-30'), t('X', '2026-10-20', '2026-10-21')];
    const r = autoSchedule(tasks, [dep('B', 'A'), dep('C', 'B')]);
    expect(r).toEqual({ B: { start: '2026-10-07', end: '2026-10-08' }, C: { start: '2026-10-09', end: '2026-10-09' } });
  });
  it('keeps finished tasks and anchors', () => {
    const r = autoSchedule([t('A', MON, '2026-10-06'), t('B', '2026-10-12', '2026-10-13', true)], [dep('B', 'A')]);
    expect(r).toEqual({});
  });
  it('uses the largest constraint of several predecessors', () => {
    const r = autoSchedule([t('A', MON, '2026-10-06'), t('B', MON, '2026-10-09'), t('C', '2026-10-20', '2026-10-20')], [dep('C', 'A'), dep('C', 'B')]);
    expect(r.C).toEqual({ start: '2026-10-10', end: '2026-10-10' });
  });
});

describe('critical path', () => {
  it('marks a tight chain and ignores tasks without links', () => {
    const tasks = [t('A', MON, '2026-10-06'), t('B', '2026-10-07', '2026-10-08'), t('C', '2026-10-09', '2026-10-09'), t('D', MON, MON)];
    const r = criticalPath(tasks, [dep('B', 'A'), dep('C', 'B')]);
    expect(new Set(r.critical)).toEqual(new Set(['A', 'B', 'C']));
    expect(r.float.D).toBe(4);
    expect(r.float.A).toBe(0);
    expect(r.end).toBe('2026-10-09');
    expect(r.links).toEqual(expect.arrayContaining([{ task: 'B', on: 'A' }, { task: 'C', on: 'B' }]));
  });

  it('gives tasks float when there is slack before the end', () => {
    const tasks = [t('A', MON, '2026-10-06'), t('B', '2026-10-07', '2026-10-08'), t('C', '2026-10-12', '2026-10-12')];
    const r = criticalPath(tasks, [dep('B', 'A'), dep('C', 'B')]);
    expect(r.float.C).toBe(0);
    expect(r.float.B).toBe(3);
    expect(r.float.A).toBe(3);
    expect(r.critical).toEqual(['C']);
    expect(r.links).toEqual([]);
  });

  it('follows the longest of two branches', () => {
    // A → B(3 days) → D and A → C(1 day) → D: B is critical, C has float
    const tasks = [t('A', MON, MON), t('B', '2026-10-06', '2026-10-08'), t('C', '2026-10-06', '2026-10-06'), t('D', '2026-10-09', '2026-10-09')];
    const r = criticalPath(tasks, [dep('B', 'A'), dep('C', 'A'), dep('D', 'B'), dep('D', 'C')]);
    expect(new Set(r.critical)).toEqual(new Set(['A', 'B', 'D']));
    expect(r.float.C).toBe(2);
  });

  it('handles start-to-start links, lags and finished tasks', () => {
    // B starts 2 days after A starts; B is the longer task and ends the project
    const r = criticalPath([t('A', MON, '2026-10-06'), t('B', '2026-10-07', '2026-10-12')], [dep('B', 'A', 'SS', 2)]);
    expect(new Set(r.critical)).toEqual(new Set(['A', 'B']));
    const done = criticalPath([t('A', MON, '2026-10-06', true), t('B', '2026-10-07', '2026-10-08')], [dep('B', 'A')]);
    expect(done.critical).toEqual(['B']);
  });

  it('works with working days and returns nothing for cycles or empty plans', () => {
    // Friday task, then Monday task: no float over the weekend
    const r = criticalPath([t('A', '2026-10-08', '2026-10-09'), t('B', '2026-10-12', '2026-10-13')], [dep('B', 'A')], CALENDAR_WORKDAYS);
    expect(new Set(r.critical)).toEqual(new Set(['A', 'B']));
    expect(criticalPath([t('A', MON, MON), t('B', MON, MON)], [dep('B', 'A'), dep('A', 'B')]).critical).toEqual([]);
    expect(criticalPath([], [])).toEqual({ float: {}, critical: [], links: [], end: null });
  });
});

describe('rollup and workload', () => {
  it('spans a parent over its children', () => {
    expect(rollupDates([])).toBeNull();
    expect(rollupDates([{ start: '2026-10-06', end: '2026-10-08' }, { start: MON, end: '2026-10-07' }])).toEqual({ start: MON, end: '2026-10-08' });
  });

  it('spreads estimates over the working days a task runs', () => {
    const load = workload(
      [
        { id: '1', start: MON, end: '2026-10-09', estimate_minutes: 600, assignees: ['u1'] },
        { id: '2', start: MON, end: '2026-10-06', estimate_minutes: 240, assignees: ['u1', 'u2'] },
        { id: '3', start: null, end: '2026-10-07', estimate_minutes: 90, assignees: [] },
        { id: '4', start: MON, end: MON, estimate_minutes: 500, assignees: ['u1'], done: true },
      ],
      MON,
      '2026-10-11',
    );
    expect(load.u1[MON]).toBe(120 + 60);
    expect(load.u1['2026-10-07']).toBe(120);
    expect(load.u2[MON]).toBe(60);
    expect(load.unassigned['2026-10-07']).toBe(90);
    // weekends carry nothing, finished tasks nothing
    expect(load.u1['2026-10-10']).toBeUndefined();
    expect(Object.values(load.u1).reduce((a, b) => a + b, 0)).toBe(600 + 120);
  });

  it('clips to the window and puts a weekend-only task on the next working day', () => {
    const load = workload([{ id: '1', start: '2026-10-10', end: '2026-10-11', estimate_minutes: 120, assignees: ['u1'] }], MON, '2026-10-16');
    expect(load.u1).toEqual({ '2026-10-12': 120 });
    expect(workload([{ id: '1', start: MON, end: '2026-10-09', estimate_minutes: 500, assignees: ['u1'] }], '2026-10-07', '2026-10-08').u1).toEqual({ '2026-10-07': 100, '2026-10-08': 100 });
  });
});

describe('task hierarchy', () => {
  const tree = (): ParentMap =>
    new Map<string, string | null>([
      ['root', null],
      ['a', 'root'],
      ['b', 'a'],
      ['c', 'b'],
      ['other', null],
    ]);
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(TreeError);
      return (e as TreeError).code;
    }
    return 'ok';
  };

  it('knows ancestors, depth and descendants', () => {
    const m = tree();
    expect(ancestors(m, 'c')).toEqual(['b', 'a', 'root']);
    expect(depthOf(m, 'c')).toBe(4);
    expect(depthOf(m, 'root')).toBe(1);
    expect(new Set(descendants(m, 'a'))).toEqual(new Set(['b', 'c']));
    expect(subtreeHeight(m, 'root')).toBe(3);
    expect(subtreeHeight(m, 'c')).toBe(0);
    expect(related(m, 'root', 'c')).toBe(true);
    expect(related(m, 'a', 'other')).toBe(false);
  });

  it('refuses itself, a descendant (cycle), unknown parents and too deep nesting', () => {
    const m = tree();
    expect(code(() => assertParent(m, 'a', 'a'))).toBe('self');
    expect(code(() => assertParent(m, 'root', 'c'))).toBe('cycle');
    expect(code(() => assertParent(m, 'a', 'b'))).toBe('cycle');
    expect(code(() => assertParent(m, 'a', 'nope'))).toBe('unknown');
    expect(code(() => assertParent(m, 'other', 'c'))).toBe('ok');
    expect(code(() => assertParent(m, 'other', null))).toBe('ok');
    // depth limit counts the moved task's own subtree too
    const deep = new Map<string, string | null>([['t1', null]]);
    for (let i = 2; i <= MAX_DEPTH; i++) deep.set(`t${i}`, `t${i - 1}`);
    deep.set('x', null);
    deep.set('x1', 'x');
    expect(code(() => assertParent(deep, 'x', `t${MAX_DEPTH}`))).toBe('depth');
    expect(code(() => assertParent(deep, 'y', `t${MAX_DEPTH - 1}`))).toBe('ok');
    deep.set('y', null);
    expect(code(() => assertParent(deep, 'x', `t${MAX_DEPTH - 1}`))).toBe('depth');
    expect(code(() => assertParent(deep, 'x', `t${MAX_DEPTH - 2}`))).toBe('ok');
  });

  it('orders a list depth-first and counts progress', () => {
    const items = [
      { id: 'c1', parent_id: 'a', n: 2 },
      { id: 'a', parent_id: null, n: 1 },
      { id: 'c0', parent_id: 'a', n: 1 },
      { id: 'z', parent_id: null, n: 2 },
      { id: 'orphan', parent_id: 'missing', n: 3 },
    ];
    const flat = flatten(items, (x, y) => x.n - y.n);
    expect(flat.map((f) => `${f.depth}:${f.item.id}`)).toEqual(['0:a', '1:c0', '1:c1', '0:z', '0:orphan']);
    expect(flatten(items, (x, y) => x.n - y.n, new Set(['a'])).map((f) => f.item.id)).toEqual(['a', 'z', 'orphan']);
    const m = tree();
    expect(progressOf(m, (id) => id === 'c', 'root')).toEqual({ done: 1, total: 3 });
  });
});

describe('recurrence', () => {
  const rule = (r: Partial<Recurrence>): Recurrence => ({ freq: 'daily', interval: 1, mode: 'due', end: { type: 'never' }, ...r });

  it('validates the rule', () => {
    expect(cleanRecurrence(null)).toBeNull();
    expect(cleanRecurrence({ freq: 'weekly', interval: '2', weekdays: [4, 1, 1] })).toMatchObject({ freq: 'weekly', interval: 2, weekdays: [1, 4], mode: 'due', end: { type: 'never' } });
    expect(cleanRecurrence({ freq: 'monthly', interval: 1, day_of_month: 15, mode: 'completion', end: { type: 'count', count: 3 } })).toMatchObject({ day_of_month: 15, mode: 'completion', end: { type: 'count', count: 3 } });
    expect(() => cleanRecurrence({ freq: 'hourly' })).toThrow(RecurrenceError);
    expect(() => cleanRecurrence({ freq: 'daily', interval: 0 })).toThrow(RecurrenceError);
    expect(() => cleanRecurrence({ freq: 'monthly', interval: 1, day_of_month: 40 })).toThrow(RecurrenceError);
    expect(() => cleanRecurrence({ freq: 'daily', interval: 1, end: { type: 'date', date: 'morgen' } })).toThrow(RecurrenceError);
  });

  it('finds the next day for every frequency', () => {
    expect(nextOccurrence(rule({ interval: 3 }), '2026-10-30')).toBe('2026-11-02');
    expect(nextOccurrence(rule({ freq: 'weekly' }), '2026-10-07')).toBe('2026-10-14');
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [1, 4] }), MON)).toBe('2026-10-08');
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [1, 4] }), '2026-10-08')).toBe('2026-10-12');
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [1, 4], interval: 2 }), '2026-10-08')).toBe('2026-10-19');
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [0] }), '2026-10-04')).toBe('2026-10-11');
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence(rule({ freq: 'monthly', day_of_month: 31 }), '2026-02-28')).toBe('2026-03-31');
    expect(nextOccurrence(rule({ freq: 'monthly', interval: 3 }), '2026-11-15')).toBe('2027-02-15');
    expect(nextOccurrence(rule({ freq: 'yearly' }), '2028-02-29')).toBe('2029-02-28');
    expect(nextOccurrence(rule({ freq: 'yearly', interval: 2 }), '2026-10-04')).toBe('2028-10-04');
  });

  it('stops after a count or an end date', () => {
    expect(nextOccurrence(rule({ end: { type: 'count', count: 2 }, done: 1 }), MON)).toBe('2026-10-06');
    expect(nextOccurrence(rule({ end: { type: 'count', count: 2 }, done: 2 }), MON)).toBeNull();
    expect(nextOccurrence(rule({ end: { type: 'date', date: '2026-10-06' } }), MON)).toBe('2026-10-06');
    expect(nextOccurrence(rule({ end: { type: 'date', date: '2026-10-06' } }), '2026-10-06')).toBeNull();
    expect(nextOccurrence(rule({}), 'kaputt')).toBeNull();
  });

  it('describes the rule in German', () => {
    expect(describeRecurrence(null)).toBe('');
    expect(describeRecurrence(rule({ freq: 'weekly', interval: 2, weekdays: [1, 4] }))).toBe('Alle 2 Wochen (Mo, Do)');
    expect(describeRecurrence(rule({ freq: 'monthly', day_of_month: 1, mode: 'completion', end: { type: 'count', count: 6 } }))).toBe('Monatlich am 1., ab Erledigung, 6×');
    expect(describeRecurrence(rule({ end: { type: 'date', date: '2026-12-31' } }))).toBe('Täglich, bis 31.12.2026');
  });
});
