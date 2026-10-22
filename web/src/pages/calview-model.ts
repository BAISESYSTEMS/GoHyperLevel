/**
 * Calendar view, pure (no imports, tested in tests/calview-model.test.ts): wall-clock maths in the sub-account's time zone –
 * independent of the browser's zone and safe across DST changes –, the days of a view, the column layout of overlapping
 * appointments and snapping for drag & drop. Days are `YYYY-MM-DD`, times of day are minutes since local midnight.
 */

export type View = 'day' | 'week' | 'month' | 'team' | 'agenda';
export const VIEWS: View[] = ['day', 'week', 'month', 'team', 'agenda'];

const fmts = new Map<string, Intl.DateTimeFormat>();
const fmt = (tz: string) => {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmts.set(tz, f);
  }
  return f;
};

/** The wall clock of an instant in `tz`: its day and the minutes since that day's midnight. */
export function wall(at: string | number | Date, tz: string): { ymd: string; min: number } {
  const d = at instanceof Date ? at : new Date(at);
  const parts = fmt(tz).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offset(ms: number, tz: string): number {
  const parts = fmt(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The instant (ISO) at which the wall clock in `tz` shows `ymd` plus `min` minutes (the same rule as server/core/time.ts). */
export function zoned(ymd: string, min: number, tz: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, min);
  let off = offset(guess, tz);
  let t = guess - off * 60000;
  const off2 = offset(t, tz);
  if (off2 !== off) {
    off = off2;
    t = guess - off * 60000;
  }
  return new Date(t).toISOString();
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const diffDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
/** 0 = Monday … 6 = Sunday. */
export const weekdayOf = (ymd: string) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;
export const mondayOf = (ymd: string) => addDays(ymd, -weekdayOf(ymd));
export const todayIn = (tz: string, at = Date.now()) => wall(at, tz).ymd;

/** The days a view shows around `anchor`: one day (day, team), Monday to Sunday (week), six weeks (month), two weeks (agenda). */
export function daysOf(view: View, anchor: string): string[] {
  if (view === 'day' || view === 'team') return [anchor];
  if (view === 'week') return Array.from({ length: 7 }, (_, i) => addDays(mondayOf(anchor), i));
  if (view === 'agenda') return Array.from({ length: 14 }, (_, i) => addDays(anchor, i));
  const first = mondayOf(`${anchor.slice(0, 7)}-01`);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/** The instants a view loads: from the first day's midnight to the midnight after the last day (sub-account zone). */
export function rangeOf(view: View, anchor: string, tz: string): { days: string[]; from: string; to: string } {
  const days = daysOf(view, anchor);
  return { days, from: zoned(days[0], 0, tz), to: zoned(addDays(days[days.length - 1], 1), 0, tz) };
}

/** The anchor one step back or forward. */
export function shift(view: View, anchor: string, dir: -1 | 1): string {
  if (view === 'day' || view === 'team') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'agenda') return addDays(anchor, 14 * dir);
  const [y, m] = anchor.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
}

/** The part of [start, end) that falls on `ymd`, as minutes of that day (0–1440), or null. */
export function onDay(start: string, end: string, ymd: string, tz: string): { from: number; to: number } | null {
  const s = Date.parse(start);
  const e = Date.parse(end);
  const dayStart = Date.parse(zoned(ymd, 0, tz));
  const dayEnd = Date.parse(zoned(addDays(ymd, 1), 0, tz));
  if (e <= dayStart || s >= dayEnd) return null;
  const from = s <= dayStart ? 0 : wall(s, tz).min;
  const to = e >= dayEnd ? 1440 : wall(e, tz).min;
  return to > from ? { from, to } : { from, to: Math.min(1440, from + 15) };
}

/** An appointment across several days (a rental, a trip): drawn in the all-day row of the day and week views, not as a full-height block. */
export function multiDay(start: string, end: string, tz: string): boolean {
  return wall(start, tz).ymd !== wall(Date.parse(end) - 1, tz).ymd;
}

export const snap = (min: number, step = 15) => Math.round(min / step) * step;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface Placed {
  col: number;
  cols: number;
}

/** Side by side columns for overlapping items of one day (clusters of overlaps share the width). */
export function layout(items: { id: string; from: number; to: number }[]): Map<string, Placed> {
  const sorted = [...items].sort((a, b) => a.from - b.from || b.to - a.to || a.id.localeCompare(b.id));
  const out = new Map<string, Placed>();
  let cluster: { id: string; col: number }[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const c of cluster) out.set(c.id, { col: c.col, cols: ends.length });
    cluster = [];
    ends = [];
  };
  for (const it of sorted) {
    if (it.from >= clusterEnd) close();
    let col = ends.findIndex((e) => e <= it.from);
    if (col < 0) col = ends.length;
    ends[col] = it.to;
    cluster.push({ id: it.id, col });
    clusterEnd = Math.max(clusterEnd, it.to);
  }
  close();
  return out;
}

/** "HH:MM" of minutes of the day. */
export const hm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** Minutes of the day of "HH:MM" (NaN when it is not one). */
export const minOf = (s: string) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : NaN);

/** The hours a time grid shows: at least 07–20, wider when something of the days lies outside. */
export function hourRange(spans: { from: number; to: number }[]): { start: number; end: number } {
  let start = 7;
  let end = 20;
  for (const s of spans) {
    start = Math.min(start, Math.floor(s.from / 60));
    end = Math.max(end, Math.ceil(s.to / 60));
  }
  return { start: clamp(start, 0, 23), end: clamp(end, start + 1, 24) };
}

// --- the data of GET /api/calendar-view (server/services/calview.ts) ------------------------------------------------------------------

export interface Interval {
  start_at: string;
  end_at: string;
}
export interface Cal {
  id: string;
  name: string;
  color: string;
  timezone: string;
  duration: number;
  interval: number;
  buffer: number;
  active: boolean;
  members: string[];
}
export interface Appt extends Interval {
  id: string;
  calendar_id: string;
  contact_id: string | null;
  title: string;
  status: 'confirmed' | 'showed' | 'noshow' | 'cancelled' | 'blocked' | string;
  notes: string;
  source: string;
  series_id: string | null;
  recurrence: string | null;
  series_exception: boolean;
  people: string[];
  contact_name: string;
  email: string;
  phone: string;
  meeting_url: string;
  payment_status: string | null;
}
export interface ViewData {
  timezone: string;
  from: string;
  to: string;
  days: { first: string; last: string };
  now: string;
  calendars: Cal[];
  users: { id: string; name: string }[];
  appointments: Appt[];
  buffers: (Interval & { appointment_id: string; calendar_id: string; side: 'before' | 'after' })[];
  hours: Record<string, Interval[]>;
  busy: (Interval & { calendar_id?: string; user_id?: string })[];
  absences: (Interval & { user_id: string; note: string; source: string })[];
}
export interface TaskItem {
  id: string;
  title: string;
  due_at: string | null;
  done: boolean | number;
  assigned_to?: string | null;
  assignees?: string[];
  contact_id?: string | null;
  project_id?: string | null;
}
export interface Issue extends Interval {
  kind: 'appointment' | 'blocked' | 'buffer' | 'person' | 'busy' | 'hours' | 'limit' | 'absence';
  label: string;
  id?: string;
}

/** A task's due moment: a date-only due date is an all-day item, a timestamp a point in the day. */
export function taskDue(t: Pick<TaskItem, 'due_at'>, tz: string): { ymd: string; min: number | null } | null {
  if (!t.due_at) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.due_at)) return { ymd: t.due_at, min: null };
  const ms = Date.parse(t.due_at);
  if (Number.isNaN(ms)) return null;
  return wall(ms, tz);
}
