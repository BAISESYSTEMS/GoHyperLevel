import type { App } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { centsToMoney, id as newId, now } from '../core/util.js';
import { createInvoice } from '../modules/payments.js';
import { invoiceLabel } from './invoice-model.js';
import {
  dayOf,
  ensureDefaultProject,
  getProject,
  getSettings,
  isTeamMember,
  logTask,
  normDate,
  notifyUser,
  projectContact,
  team,
  todayIn,
  tzOf,
  withDay,
  type Actor,
  type ProjectRow,
} from './pm-core.js';
import { addDays, mondayOf } from './pm-schedule.js';
import { taskRow } from './pm-tasks.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Time tracking: one running timer per person (across sub-accounts, enforced by a unique index), manual entries
 * with overlap checks, weekly timesheets with optional approval, rates, reports and "In Rechnung stellen"
 * (billable entries → an invoice draft of the invoices module).
 */

export const MAX_ENTRY_SECONDS = 24 * 3600;
const MIN_MANUAL_SECONDS = 60;
export const APPROVALS = ['open', 'submitted', 'approved', 'rejected'] as const;

export interface TimeRow {
  id: string;
  location_id: string;
  user_id: string;
  task_id: string | null;
  task_title: string;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  seconds: number;
  has_clock: number;
  note: string;
  billable: number;
  rate_cents: number | null;
  source: string;
  approval: (typeof APPROVALS)[number];
  invoice_id: string | null;
  billed_rate_cents: number | null;
  billed_seconds: number | null;
  billed_at: string | null;
  auto_stopped: number;
  created_at: string;
  updated_at: string;
}

export interface TimeOut extends Omit<TimeRow, 'has_clock' | 'billable' | 'auto_stopped'> {
  has_clock: boolean;
  billable: boolean;
  auto_stopped: boolean;
  running: boolean;
  user_name: string;
  project_name: string;
  project_color: string;
  day: string;
  invoice_number: string | null;
}

/** The person doing the work: the signed-in user, or – with a key – the person named in `user_id`. */
export function timeUser(app: App, locationId: string, actor: Actor, userId: unknown, manager: boolean): string {
  const wanted = userId ? String(userId) : actor.id;
  if (!wanted) throw bad('Für diese Verbindung bitte user_id angeben (wessen Zeit?)');
  if (wanted !== actor.id && !manager) throw bad('Zeit für andere Personen darf nur die Leitung erfassen oder stoppen');
  if (!isTeamMember(app, locationId, wanted)) throw bad('Nutzer nicht gefunden oder ohne Zugriff');
  return wanted;
}

const liveSeconds = (r: Pick<TimeRow, 'started_at' | 'ended_at' | 'seconds'>, at = Date.now()) => (r.ended_at ? r.seconds : Math.max(0, Math.floor((at - Date.parse(r.started_at)) / 1000)));

export function timeOut(app: App, locationId: string, rows: TimeRow[]): TimeOut[] {
  if (!rows.length) return [];
  const tz = tzOf(app, locationId);
  const people = new Map(team(app, locationId).map((p) => [p.id, p.name]));
  const projects = new Map(app.db.all<any>('SELECT id, name, color FROM pm_projects WHERE location_id = ?', locationId).map((p) => [p.id, p]));
  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id).filter(Boolean) as string[])];
  const numbers = new Map(invoiceIds.length ? app.db.all<any>(`SELECT id, number FROM invoices WHERE location_id = ? AND id IN (${invoiceIds.map(() => '?').join(',')})`, locationId, ...invoiceIds).map((i) => [i.id, invoiceLabel(i.number)]) : []);
  const t = Date.now();
  return rows.map((r) => ({
    ...r,
    seconds: liveSeconds(r, t),
    has_clock: !!r.has_clock,
    billable: !!r.billable,
    auto_stopped: !!r.auto_stopped,
    running: !r.ended_at,
    user_name: people.get(r.user_id) ?? '',
    project_name: r.project_id ? (projects.get(r.project_id)?.name ?? '') : '',
    project_color: r.project_id ? (projects.get(r.project_id)?.color ?? '#64748b') : '#64748b',
    day: dayOf(r.started_at, tz) ?? r.started_at.slice(0, 10),
    invoice_number: r.invoice_id ? (numbers.get(r.invoice_id) ?? null) : null,
  }));
}

const entryRow = (app: App, locationId: string, id: string): TimeRow => {
  const r = app.db.get<TimeRow>('SELECT * FROM pm_time_entries WHERE id = ? AND location_id = ?', String(id ?? ''), locationId);
  if (!r) throw notFound('Zeiteintrag nicht gefunden');
  return r;
};

// --- who may do what ------------------------------------------------------------------------------

export interface Viewer {
  id: string | null;
  /** Agency admin or someone with the settings area: sees everyone's time, approves, edits other people's entries. */
  manager: boolean;
}
export function viewerOf(ctx: { user?: { id: string; role: string; permissions: string[] | null } }): Viewer {
  const u = ctx.user;
  return { id: u && !String(u.id).startsWith('key:') ? u.id : null, manager: !u || u.role === 'admin' || !u.permissions || u.permissions.includes('settings') };
}

// --- overlaps ---------------------------------------------------------------------------------------

/** Clock entries (and the running timer, up to now) of a person that intersect [from, to). */
export function overlapping(app: App, userId: string, from: Date, to: Date, exceptId?: string): TimeRow[] {
  const rows = app.db.all<TimeRow>(`SELECT * FROM pm_time_entries WHERE user_id = ? AND has_clock = 1 AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)${exceptId ? ' AND id != ?' : ''}`, userId, to.toISOString(), from.toISOString(), ...(exceptId ? [exceptId] : []));
  // A running timer occupies the time from its start until now, not forever.
  return rows.filter((r) => r.ended_at || Date.now() > from.getTime());
}

function assertFree(app: App, locationId: string, userId: string, from: Date, to: Date, exceptId?: string) {
  if (getSettings(app, locationId).allow_overlap) return;
  const clash = overlapping(app, userId, from, to, exceptId)[0];
  if (!clash) return;
  const tz = tzOf(app, clash.location_id);
  const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  throw bad(`Überschneidung mit einem anderen Zeiteintrag (${hm(clash.started_at)}–${clash.ended_at ? hm(clash.ended_at) : 'läuft'}${clash.task_title ? `, ${clash.task_title}` : ''})`);
}

// --- locked weeks -------------------------------------------------------------------------------------

export function weekStatus(app: App, locationId: string, userId: string, week: string): { status: string; note: string; decided_by: string | null; decided_at: string | null; submitted_at: string | null } {
  const r = app.db.get<any>('SELECT * FROM pm_timesheets WHERE location_id = ? AND user_id = ? AND week = ?', locationId, userId, week);
  return { status: r?.status ?? 'open', note: r?.note ?? '', decided_by: r?.decided_by ?? null, decided_at: r?.decided_at ?? null, submitted_at: r?.submitted_at ?? null };
}

function assertEditableWeek(app: App, locationId: string, userId: string, startedAt: string, manager: boolean) {
  const week = mondayOf(dayOf(startedAt, tzOf(app, locationId)) ?? startedAt.slice(0, 10));
  const s = weekStatus(app, locationId, userId, week).status;
  if ((s === 'approved' || s === 'submitted') && !manager) throw bad(s === 'approved' ? 'Diese Woche ist freigegeben – Änderungen nur durch die Leitung' : 'Diese Woche ist abgegeben – bitte zuerst zurückholen');
}

// --- timer ----------------------------------------------------------------------------------------------

export function runningEntry(app: App, userId: string): TimeRow | undefined {
  return app.db.get<TimeRow>('SELECT * FROM pm_time_entries WHERE user_id = ? AND ended_at IS NULL', userId);
}

interface Target {
  taskId: string | null;
  taskTitle: string;
  projectId: string;
  project: ProjectRow;
}

function targetOf(app: App, locationId: string, b: any): Target {
  let taskId: string | null = null;
  let taskTitle = '';
  let projectId: string | null = b.project_id ? String(b.project_id) : null;
  if (b.task_id) {
    const t = taskRow(app, locationId, String(b.task_id));
    taskId = t.id;
    taskTitle = t.title;
    if (projectId && projectId !== t.project_id) throw bad('Die Aufgabe gehört nicht zu diesem Projekt');
    projectId = t.project_id;
  }
  const project = getProject(app, locationId, projectId ?? ensureDefaultProject(app, locationId));
  if (project.status === 'archived') throw bad('Das Projekt ist archiviert');
  return { taskId, taskTitle, projectId: project.id, project };
}

export interface StartResult {
  entry: TimeOut;
  /** The timer that was running and has been stopped to start this one. */
  stopped?: TimeOut;
  already_running?: boolean;
}

/** Starts the person's timer; one that is already running is stopped first (same moment), so there is never more than one. */
export function startTimer(app: App, locationId: string, userId: string, b: any, actor: Actor): StartResult {
  const { db } = app;
  const target = targetOf(app, locationId, b);
  const running = runningEntry(app, userId);
  if (running && running.location_id === locationId && running.task_id === target.taskId && running.project_id === target.projectId) return { entry: timeOut(app, locationId, [running])[0], already_running: true };
  const at = new Date();
  if (!running) assertFree(app, locationId, userId, at, new Date(at.getTime() + 1000));
  let stopped: TimeRow | undefined;
  const row: TimeRow = {
    id: newId(),
    location_id: locationId,
    user_id: userId,
    task_id: target.taskId,
    task_title: target.taskTitle,
    project_id: target.projectId,
    started_at: at.toISOString(),
    ended_at: null,
    seconds: 0,
    has_clock: 1,
    note: str(b.note, 'Notiz', { max: 500 }),
    billable: b.billable !== undefined ? (b.billable ? 1 : 0) : target.project.billable ? 1 : 0,
    rate_cents: null,
    source: actor.via === 'mcp' || actor.via === 'api_key' || actor.via === 'agency_key' ? 'api' : 'timer',
    approval: 'open',
    invoice_id: null,
    billed_rate_cents: null,
    billed_seconds: null,
    billed_at: null,
    auto_stopped: 0,
    created_at: at.toISOString(),
    updated_at: at.toISOString(),
  };
  db.tx(() => {
    if (running) stopped = closeEntry(app, running, at);
    db.insert('pm_time_entries', row);
  });
  const out = timeOut(app, locationId, [row])[0];
  app.events.emit(locationId, 'timer.started', { entry: out });
  return { entry: out, stopped: stopped ? timeOut(app, stopped.location_id, [stopped])[0] : undefined };
}

/** Writes the end of a running entry (never longer than a day); an entry of under a second is dropped. */
function closeEntry(app: App, r: TimeRow, end: Date, extra: Partial<TimeRow> = {}): TimeRow | undefined {
  const seconds = Math.min(MAX_ENTRY_SECONDS, Math.max(0, Math.floor((end.getTime() - Date.parse(r.started_at)) / 1000)));
  if (seconds < 1) {
    app.db.run('DELETE FROM pm_time_entries WHERE id = ?', r.id);
    return undefined;
  }
  const endedAt = new Date(Date.parse(r.started_at) + seconds * 1000).toISOString();
  app.db.update('pm_time_entries', r.id, { ended_at: endedAt, seconds, updated_at: now(), ...extra });
  return app.db.get<TimeRow>('SELECT * FROM pm_time_entries WHERE id = ?', r.id);
}

export interface StopResult {
  entry: TimeOut | null;
  discarded?: boolean;
}

/** Stops the person's running timer (wherever it runs). `at` lets someone who forgot it set the real end. */
export function stopTimer(app: App, userId: string, b: any = {}): StopResult {
  const running = runningEntry(app, userId);
  if (!running) throw new HttpError(409, 'Es läuft kein Timer');
  return finishTimer(app, running, b);
}

function finishTimer(app: App, running: TimeRow, b: any): StopResult {
  let end = new Date();
  if (b.at) {
    const iso = normDate(b.at, 'Ende');
    const t = Date.parse(iso!);
    if (t < Date.parse(running.started_at)) throw bad('Das Ende liegt vor dem Start');
    if (t > Date.now() + 60_000) throw bad('Das Ende liegt in der Zukunft');
    end = new Date(Math.min(t, Date.now()));
  } else if (end.getTime() - Date.parse(running.started_at) > MAX_ENTRY_SECONDS * 1000) {
    throw bad('Der Timer läuft seit über 24 Stunden – bitte das tatsächliche Ende angeben');
  }
  const note = b.note !== undefined ? str(b.note, 'Notiz', { max: 500 }) : undefined;
  const done = closeEntry(app, running, end, note !== undefined ? { note } : {});
  if (!done) return { entry: null, discarded: true };
  const out = timeOut(app, done.location_id, [done])[0];
  app.events.emit(done.location_id, 'timer.stopped', { entry: out });
  app.events.emit(done.location_id, 'time.logged', { entry: out });
  if (done.task_id) app.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), done.task_id);
  return { entry: out };
}

// --- manual entries ---------------------------------------------------------------------------------

function secondsOf(b: any): number | undefined {
  const raw = b.seconds !== undefined ? Number(b.seconds) : b.minutes !== undefined ? Number(b.minutes) * 60 : b.hours !== undefined ? Number(b.hours) * 3600 : undefined;
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw)) throw bad('Dauer: Zahl erwartet');
  return Math.round(raw);
}

export function addEntry(app: App, locationId: string, userId: string, b: any, actor: Actor, viewer: Viewer): TimeOut {
  const { db } = app;
  const target = targetOf(app, locationId, b);
  const tz = tzOf(app, locationId);
  let seconds = secondsOf(b);
  let startedAt: string;
  let endedAt: string;
  let clock = 1;
  if (b.start_at) {
    const s = Date.parse(normDate(b.start_at, 'Start')!);
    let e: number;
    if (b.end_at) e = Date.parse(normDate(b.end_at, 'Ende')!);
    else if (seconds !== undefined) e = s + seconds * 1000;
    else throw bad('Ende oder Dauer angeben');
    if (e <= s) throw bad('Das Ende liegt vor dem Start');
    seconds = Math.round((e - s) / 1000);
    startedAt = new Date(s).toISOString();
    endedAt = new Date(e).toISOString();
    if (s > Date.now() + 5 * 60_000) throw bad('Der Start liegt in der Zukunft');
    if (e > Date.now() + 5 * 60_000) throw bad('Das Ende liegt in der Zukunft');
  } else {
    // Only a duration on a day: no clock times, so it cannot overlap anything.
    if (seconds === undefined) throw bad('Dauer (Minuten oder Stunden) oder Start und Ende angeben');
    const day = b.date ? String(b.date).slice(0, 10) : todayIn(tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('Datum als JJJJ-MM-TT');
    if (day > todayIn(tz)) throw bad('Zeit lässt sich nicht für die Zukunft eintragen');
    startedAt = withDay(null, day, tz);
    endedAt = startedAt;
    clock = 0;
  }
  if (seconds! < MIN_MANUAL_SECONDS) throw bad('Mindestens eine Minute');
  if (seconds! > MAX_ENTRY_SECONDS) throw bad('Ein Eintrag darf höchstens 24 Stunden lang sein');
  if (userId !== viewer.id && !viewer.manager) throw bad('Zeit für andere Personen einzutragen darf nur die Leitung');
  assertEditableWeek(app, locationId, userId, startedAt, viewer.manager);
  if (clock) assertFree(app, locationId, userId, new Date(startedAt), new Date(endedAt));
  const row: TimeRow = {
    id: newId(),
    location_id: locationId,
    user_id: userId,
    task_id: target.taskId,
    task_title: target.taskTitle,
    project_id: target.projectId,
    started_at: startedAt,
    ended_at: endedAt,
    seconds: seconds!,
    has_clock: clock,
    note: str(b.note, 'Notiz', { max: 500 }),
    billable: b.billable !== undefined ? (b.billable ? 1 : 0) : target.project.billable ? 1 : 0,
    rate_cents: cleanRate(b.rate_cents),
    source: actor.via === 'mcp' || actor.via === 'api_key' || actor.via === 'agency_key' ? 'api' : 'manual',
    approval: 'open',
    invoice_id: null,
    billed_rate_cents: null,
    billed_seconds: null,
    billed_at: null,
    auto_stopped: 0,
    created_at: now(),
    updated_at: now(),
  };
  db.insert('pm_time_entries', row);
  if (row.task_id) db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), row.task_id);
  const out = timeOut(app, locationId, [row])[0];
  app.events.emit(locationId, 'time.logged', { entry: out });
  return out;
}

function cleanRate(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw bad('Stundensatz: Cent zwischen 0 und 10.000.000');
  return n;
}

export function updateEntry(app: App, locationId: string, entryId: string, b: any, viewer: Viewer): TimeOut {
  const r = entryRow(app, locationId, entryId);
  if (r.user_id !== viewer.id && !viewer.manager) throw bad('Nur eigene Zeiteinträge bearbeiten');
  if (r.invoice_id) throw bad('Dieser Eintrag ist schon abgerechnet');
  if (!r.ended_at) throw bad('Der Timer läuft noch – erst stoppen');
  assertEditableWeek(app, locationId, r.user_id, r.started_at, viewer.manager);
  const patch: Record<string, any> = {};
  if (b.note !== undefined) patch.note = str(b.note, 'Notiz', { max: 500 });
  if (b.billable !== undefined) patch.billable = b.billable ? 1 : 0;
  if (b.rate_cents !== undefined) {
    if (!viewer.manager) throw bad('Stundensätze ändert nur die Leitung');
    patch.rate_cents = cleanRate(b.rate_cents);
  }
  if (b.task_id !== undefined || b.project_id !== undefined) {
    const t = targetOf(app, locationId, { task_id: b.task_id, project_id: b.project_id ?? (b.task_id ? undefined : r.project_id) });
    Object.assign(patch, { task_id: t.taskId, task_title: t.taskTitle, project_id: t.projectId });
  }
  const tz = tzOf(app, locationId);
  let startedAt = r.started_at;
  let endedAt = r.ended_at;
  let seconds = r.seconds;
  if (r.has_clock && (b.start_at !== undefined || b.end_at !== undefined || secondsOf(b) !== undefined)) {
    const s = b.start_at !== undefined ? Date.parse(normDate(b.start_at, 'Start')!) : Date.parse(r.started_at);
    const sec = secondsOf(b);
    const e = b.end_at !== undefined ? Date.parse(normDate(b.end_at, 'Ende')!) : sec !== undefined ? s + sec * 1000 : Date.parse(r.ended_at);
    if (e <= s) throw bad('Das Ende liegt vor dem Start');
    if (e > Date.now() + 5 * 60_000) throw bad('Das Ende liegt in der Zukunft');
    seconds = Math.round((e - s) / 1000);
    if (seconds < MIN_MANUAL_SECONDS) throw bad('Mindestens eine Minute');
    if (seconds > MAX_ENTRY_SECONDS) throw bad('Ein Eintrag darf höchstens 24 Stunden lang sein');
    assertFree(app, locationId, r.user_id, new Date(s), new Date(e), r.id);
    startedAt = new Date(s).toISOString();
    endedAt = new Date(e).toISOString();
    Object.assign(patch, { started_at: startedAt, ended_at: endedAt, seconds });
  } else if (!r.has_clock && (secondsOf(b) !== undefined || b.date !== undefined)) {
    const sec = secondsOf(b) ?? r.seconds;
    if (sec < MIN_MANUAL_SECONDS || sec > MAX_ENTRY_SECONDS) throw bad('Dauer zwischen einer Minute und 24 Stunden');
    patch.seconds = sec;
    if (b.date !== undefined) {
      const day = String(b.date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw bad('Datum als JJJJ-MM-TT');
      if (day > todayIn(tz)) throw bad('Zeit lässt sich nicht für die Zukunft eintragen');
      patch.started_at = withDay(null, day, tz);
      patch.ended_at = patch.started_at;
      assertEditableWeek(app, locationId, r.user_id, patch.started_at, viewer.manager);
    }
  }
  if (!Object.keys(patch).length) return timeOut(app, locationId, [r])[0];
  app.db.update('pm_time_entries', r.id, { ...patch, updated_at: now() }, locationId);
  return timeOut(app, locationId, [entryRow(app, locationId, r.id)])[0];
}

export function deleteEntry(app: App, locationId: string, entryId: string, viewer: Viewer) {
  const r = entryRow(app, locationId, entryId);
  if (r.user_id !== viewer.id && !viewer.manager) throw bad('Nur eigene Zeiteinträge löschen');
  if (r.invoice_id) throw bad('Dieser Eintrag ist schon abgerechnet');
  if (r.ended_at) assertEditableWeek(app, locationId, r.user_id, r.started_at, viewer.manager);
  app.db.run('DELETE FROM pm_time_entries WHERE id = ?', r.id);
  return { ok: true };
}

// --- listing & timesheets -----------------------------------------------------------------------------

export interface TimeFilter {
  user_id?: string;
  project_id?: string;
  task_id?: string;
  from?: string;
  to?: string;
  billable?: string;
  billed?: string;
  approval?: string;
  limit?: number;
}

export function listEntries(app: App, locationId: string, f: TimeFilter, viewer: Viewer): TimeOut[] {
  const tz = tzOf(app, locationId);
  const where = ['location_id = ?'];
  const params: any[] = [locationId];
  // Members see their own time; the leadership sees everybody's.
  const user = viewer.manager ? f.user_id : (viewer.id ?? '-');
  if (user && user !== 'all') (where.push('user_id = ?'), params.push(user === 'me' ? (viewer.id ?? '-') : user));
  if (f.project_id) (where.push('project_id = ?'), params.push(f.project_id));
  if (f.task_id) (where.push('task_id = ?'), params.push(f.task_id));
  if (f.from) (where.push('started_at >= ?'), params.push(`${addDays(f.from, -1)}T00:00:00.000Z`));
  if (f.to) (where.push('started_at < ?'), params.push(`${addDays(f.to, 2)}T00:00:00.000Z`));
  if (f.billable === '1' || f.billable === '0') (where.push('billable = ?'), params.push(Number(f.billable)));
  if (f.billed === '1') where.push('invoice_id IS NOT NULL');
  else if (f.billed === '0') where.push('invoice_id IS NULL');
  if (f.approval) (where.push('approval = ?'), params.push(f.approval));
  const rows = app.db.all<TimeRow>(`SELECT * FROM pm_time_entries WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`, ...params, Math.min(Math.max(Math.floor(Number(f.limit) || 500), 1), 5000));
  return timeOut(app, locationId, rows.filter((r) => {
    const d = dayOf(r.started_at, tz)!;
    return (!f.from || d >= f.from) && (!f.to || d <= f.to);
  }));
}

/** One week of one person: rows per task/project, seconds per day, totals and the approval state. */
export function timesheetOf(app: App, locationId: string, userId: string, anyDay: string) {
  const tz = tzOf(app, locationId);
  const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(anyDay) ? anyDay : todayIn(tz));
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const entries = listEntries(app, locationId, { user_id: userId, from: days[0], to: days[6], limit: 5000 }, { id: userId, manager: true });
  const rows = new Map<string, { key: string; task_id: string | null; project_id: string | null; title: string; project_name: string; days: Record<string, number>; billable_days: Record<string, number>; total: number }>();
  for (const e of entries) {
    const key = e.task_id ?? `p:${e.project_id ?? ''}`;
    const row = rows.get(key) ?? { key, task_id: e.task_id, project_id: e.project_id, title: e.task_title || e.project_name || 'Ohne Aufgabe', project_name: e.project_name, days: {}, billable_days: {}, total: 0 };
    row.days[e.day] = (row.days[e.day] ?? 0) + e.seconds;
    if (e.billable) row.billable_days[e.day] = (row.billable_days[e.day] ?? 0) + e.seconds;
    row.total += e.seconds;
    rows.set(key, row);
  }
  const totals: Record<string, number> = {};
  for (const e of entries) totals[e.day] = (totals[e.day] ?? 0) + e.seconds;
  const status = weekStatus(app, locationId, userId, week);
  return {
    week,
    days,
    user_id: userId,
    rows: [...rows.values()].sort((a, b) => b.total - a.total),
    totals,
    total: entries.reduce((s, e) => s + e.seconds, 0),
    billable_total: entries.filter((e) => e.billable).reduce((s, e) => s + e.seconds, 0),
    entries,
    ...status,
    locked: status.status === 'approved' || status.status === 'submitted',
    approval_required: getSettings(app, locationId).approval_required,
  };
}

export function submitWeek(app: App, locationId: string, userId: string, anyDay: string, actor: Actor) {
  const tz = tzOf(app, locationId);
  const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(anyDay) ? anyDay : todayIn(tz));
  const cur = weekStatus(app, locationId, userId, week).status;
  if (cur === 'approved') throw bad('Diese Woche ist schon freigegeben');
  if (runningEntry(app, userId)) {
    const r = runningEntry(app, userId)!;
    const d = dayOf(r.started_at, tz)!;
    if (d >= week && d <= addDays(week, 6)) throw bad('Es läuft noch ein Timer – bitte zuerst stoppen');
  }
  const entries = listEntries(app, locationId, { user_id: userId, from: week, to: addDays(week, 6), limit: 5000 }, { id: userId, manager: true });
  if (!entries.length) throw bad('In dieser Woche ist keine Zeit eingetragen');
  app.db.tx(() => {
    app.db.run(`UPDATE pm_time_entries SET approval = 'submitted', updated_at = ? WHERE id IN (${entries.map(() => '?').join(',')})`, now(), ...entries.map((e) => e.id));
    app.db.run(`INSERT INTO pm_timesheets (location_id, user_id, week, status, submitted_at, note) VALUES (?, ?, ?, 'submitted', ?, '') ON CONFLICT(location_id, user_id, week) DO UPDATE SET status = 'submitted', submitted_at = excluded.submitted_at, decided_by = NULL, decided_at = NULL, note = ''`, locationId, userId, week, now());
  });
  const who = team(app, locationId).find((p) => p.id === userId)?.name ?? actor.name;
  for (const m of managersOf(app, locationId)) if (m !== userId) notifyUser(app, { locationId, userId: m, kind: 'timesheet', title: `Zeiten zur Freigabe: ${who}`, body: `Woche ab ${week.split('-').reverse().join('.')}`, ref: `timesheet:${userId}:${week}:${now().slice(0, 16)}` });
  app.events.emit(locationId, 'timesheet.submitted', { userId, week });
  return timesheetOf(app, locationId, userId, week);
}

/** People who approve time: agency admins and members with the settings area. */
function managersOf(app: App, locationId: string): string[] {
  return app.db
    .all<any>('SELECT id, role, locations, permissions FROM users')
    .filter((u) => u.role === 'admin' || (JSON.parse(u.locations || '[]').includes(locationId) && (!u.permissions || JSON.parse(u.permissions).includes('settings'))))
    .filter((u) => !hiddenUser(app, u, locationId))
    .map((u) => u.id as string);
}

export function decideWeek(app: App, locationId: string, userId: string, anyDay: string, decision: string, note: string, actor: Actor, viewer: Viewer) {
  if (!viewer.manager) throw bad('Zeiten freigeben darf nur die Leitung');
  if (!['approve', 'reject', 'reopen'].includes(decision)) throw bad('Entscheidung: approve, reject oder reopen');
  const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(anyDay) ? anyDay : todayIn(tzOf(app, locationId)));
  const cur = weekStatus(app, locationId, userId, week);
  if (cur.status === 'open' && decision !== 'reopen') throw bad('Diese Woche wurde noch nicht abgegeben');
  const next = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'open';
  const inWeek = listEntries(app, locationId, { user_id: userId, from: week, to: addDays(week, 6), limit: 5000 }, { id: userId, manager: true }).filter((e) => !e.running);
  app.db.tx(() => {
    if (inWeek.length) app.db.run(`UPDATE pm_time_entries SET approval = ?, updated_at = ? WHERE id IN (${inWeek.map(() => '?').join(',')})`, next === 'open' ? 'open' : next, now(), ...inWeek.map((e) => e.id));
    app.db.run(`INSERT INTO pm_timesheets (location_id, user_id, week, status, decided_by, decided_at, note) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(location_id, user_id, week) DO UPDATE SET status = excluded.status, decided_by = excluded.decided_by, decided_at = excluded.decided_at, note = excluded.note`, locationId, userId, week, next, actor.id, now(), str(note, 'Hinweis', { max: 500 }));
  });
  if (next !== 'open') notifyUser(app, { locationId, userId, kind: 'timesheet', title: next === 'approved' ? 'Deine Zeiten wurden freigegeben' : 'Deine Zeiten wurden abgelehnt', body: `Woche ab ${week.split('-').reverse().join('.')}${note ? ` – ${note}` : ''}`, ref: `timesheet-decision:${userId}:${week}:${next}:${now().slice(0, 16)}` });
  app.events.emit(locationId, 'timesheet.decided', { userId, week, status: next });
  return timesheetOf(app, locationId, userId, week);
}

/** Weeks waiting for a decision (for the leadership's inbox). */
export function pendingWeeks(app: App, locationId: string) {
  const people = new Map(team(app, locationId).map((p) => [p.id, p.name]));
  return app.db.all<any>(`SELECT user_id, week, submitted_at FROM pm_timesheets WHERE location_id = ? AND status = 'submitted' ORDER BY submitted_at`, locationId).map((r) => ({ ...r, user_name: people.get(r.user_id) ?? '' }));
}

// --- rates ----------------------------------------------------------------------------------------------

/** Cents per hour: the entry's own rate, the person on the project, the project, the person, the sub-account default. */
export function rateFor(app: App, locationId: string, userId: string, projectId: string | null, entryRate?: number | null): number {
  if (entryRate !== null && entryRate !== undefined) return entryRate;
  const { db } = app;
  if (projectId) {
    const a = db.get<{ rate_cents: number }>('SELECT rate_cents FROM pm_rates WHERE location_id = ? AND project_id = ? AND user_id = ?', locationId, projectId, userId);
    if (a) return a.rate_cents;
    const p = db.get<{ hourly_rate_cents: number | null }>('SELECT hourly_rate_cents FROM pm_projects WHERE id = ? AND location_id = ?', projectId, locationId);
    if (p?.hourly_rate_cents !== null && p?.hourly_rate_cents !== undefined) return p.hourly_rate_cents;
  }
  const u = db.get<{ rate_cents: number }>('SELECT rate_cents FROM pm_rates WHERE location_id = ? AND project_id IS NULL AND user_id = ?', locationId, userId);
  if (u) return u.rate_cents;
  return getSettings(app, locationId).default_rate_cents;
}

export function listRates(app: App, locationId: string) {
  const people = new Map(team(app, locationId).map((p) => [p.id, p.name]));
  const projects = new Map(app.db.all<any>('SELECT id, name FROM pm_projects WHERE location_id = ?', locationId).map((p) => [p.id, p.name]));
  return app.db.all<any>('SELECT * FROM pm_rates WHERE location_id = ? ORDER BY created_at', locationId).map((r) => ({ ...r, user_name: r.user_id ? (people.get(r.user_id) ?? '') : '', project_name: r.project_id ? (projects.get(r.project_id) ?? '') : '' }));
}

/** Sets (or, with rate_cents null, removes) the rate of a person on a project, or of a person for all projects. */
export function setRate(app: App, locationId: string, b: any) {
  const projectId = b.project_id ? getProject(app, locationId, String(b.project_id)).id : null;
  const userId = b.user_id ? String(b.user_id) : null;
  if (!userId) throw bad('Person angeben (der Satz des Projekts steht im Projekt selbst)');
  if (!isTeamMember(app, locationId, userId)) throw bad('Nutzer nicht gefunden oder ohne Zugriff');
  const where = 'location_id = ? AND project_id IS ? AND user_id = ?';
  if (b.rate_cents === null || b.rate_cents === '') {
    app.db.run(`DELETE FROM pm_rates WHERE ${where}`, locationId, projectId, userId);
    return { ok: true, removed: true };
  }
  const rate = cleanRate(b.rate_cents);
  if (rate === null) throw bad('Stundensatz fehlt');
  const cur = app.db.get<{ id: string }>(`SELECT id FROM pm_rates WHERE ${where}`, locationId, projectId, userId);
  if (cur) app.db.run('UPDATE pm_rates SET rate_cents = ?, updated_at = ? WHERE id = ?', rate, now(), cur.id);
  else app.db.insert('pm_rates', { id: newId(), location_id: locationId, project_id: projectId, user_id: userId, rate_cents: rate, created_at: now(), updated_at: now() });
  return { ok: true, rate_cents: rate };
}

// --- reports ----------------------------------------------------------------------------------------------

export const REPORT_GROUPS = ['project', 'user', 'client', 'task', 'day', 'week'] as const;

/** Hours by project, person, client (the project's customer), task, day or week. */
export function reportOf(app: App, locationId: string, f: TimeFilter & { group?: string }, viewer: Viewer) {
  const group = (REPORT_GROUPS as readonly string[]).includes(f.group ?? '') ? f.group! : 'project';
  const entries = listEntries(app, locationId, { ...f, limit: 20000 }, viewer);
  const projects = new Map(app.db.all<ProjectRow>('SELECT * FROM pm_projects WHERE location_id = ?', locationId).map((p) => [p.id, p]));
  const contactNames = new Map<string, string>();
  const clientOf = (projectId: string | null): { key: string; label: string } => {
    const p = projectId ? projects.get(projectId) : undefined;
    const cid = p ? projectContact(app, locationId, p) : null;
    if (cid) {
      if (!contactNames.has(cid)) {
        const c = app.db.get<any>('SELECT first_name, last_name, email, company FROM contacts WHERE id = ? AND location_id = ?', cid, locationId);
        contactNames.set(cid, c ? ([c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '') : '');
      }
      return { key: `c:${cid}`, label: contactNames.get(cid) || 'Kunde' };
    }
    if (p?.company_id) {
      const name = app.db.get<any>('SELECT name FROM companies WHERE id = ? AND location_id = ?', p.company_id, locationId)?.name;
      if (name) return { key: `co:${p.company_id}`, label: name };
    }
    return { key: '-', label: 'Ohne Kunde' };
  };
  const rows = new Map<string, { key: string; label: string; seconds: number; billable_seconds: number; entries: number; color?: string }>();
  for (const e of entries) {
    let key: string;
    let label: string;
    let color: string | undefined;
    switch (group) {
      case 'user':
        [key, label] = [e.user_id, e.user_name || 'Unbekannt'];
        break;
      case 'client': {
        const c = clientOf(e.project_id);
        [key, label] = [c.key, c.label];
        break;
      }
      case 'task':
        [key, label] = [e.task_id ?? `p:${e.project_id}`, e.task_title || e.project_name || 'Ohne Aufgabe'];
        break;
      case 'day':
        [key, label] = [e.day, e.day];
        break;
      case 'week':
        key = label = mondayOf(e.day);
        break;
      default:
        [key, label, color] = [e.project_id ?? '-', e.project_name || 'Ohne Projekt', e.project_color];
    }
    const r = rows.get(key) ?? { key, label, seconds: 0, billable_seconds: 0, entries: 0, color };
    r.seconds += e.seconds;
    if (e.billable) r.billable_seconds += e.seconds;
    r.entries++;
    rows.set(key, r);
  }
  const list = [...rows.values()].sort((a, b) => (group === 'day' || group === 'week' ? a.key.localeCompare(b.key) : b.seconds - a.seconds));
  return { group, rows: list, total_seconds: entries.reduce((s, e) => s + e.seconds, 0), billable_seconds: entries.filter((e) => e.billable).reduce((s, e) => s + e.seconds, 0), entries: entries.length };
}

// --- billing ------------------------------------------------------------------------------------------------

/** Seconds that go on the invoice for an entry: rounded up to the sub-account's step. */
export const billedSeconds = (seconds: number, stepMinutes: number): number => (stepMinutes > 0 ? Math.ceil(seconds / (stepMinutes * 60)) * stepMinutes * 60 : seconds);
const hours2 = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;

export interface BillingInput {
  project_id?: string;
  contact_id?: string;
  entry_ids?: string[];
  from?: string;
  to?: string;
  group_by?: string;
  title?: string;
  notes?: string;
  tax_rate?: number;
  /** Also take entries that are not approved yet (only matters when approval is required). */
  include_unapproved?: boolean;
  user_id?: string;
}

/** Billable, finished, not yet invoiced entries that match the request. */
export function billableEntries(app: App, locationId: string, f: BillingInput): TimeRow[] {
  const settings = getSettings(app, locationId);
  const where = ['location_id = ?', 'billable = 1', 'invoice_id IS NULL', 'ended_at IS NOT NULL'];
  const params: any[] = [locationId];
  if (f.project_id) (where.push('project_id = ?'), params.push(f.project_id));
  if (f.user_id) (where.push('user_id = ?'), params.push(f.user_id));
  if (settings.approval_required && !f.include_unapproved) where.push(`approval = 'approved'`);
  if (f.entry_ids?.length) (where.push(`id IN (${f.entry_ids.map(() => '?').join(',')})`), params.push(...f.entry_ids));
  let rows = app.db.all<TimeRow>(`SELECT * FROM pm_time_entries WHERE ${where.join(' AND ')} ORDER BY started_at LIMIT 5000`, ...params);
  const tz = tzOf(app, locationId);
  rows = rows.filter((r) => {
    const d = dayOf(r.started_at, tz)!;
    return (!f.from || d >= f.from) && (!f.to || d <= f.to);
  });
  return rows;
}

export function unbilledSummary(app: App, locationId: string, f: BillingInput) {
  const settings = getSettings(app, locationId);
  const rows = billableEntries(app, locationId, f);
  const projects = new Map(app.db.all<ProjectRow>('SELECT * FROM pm_projects WHERE location_id = ?', locationId).map((p) => [p.id, p]));
  const byProject = new Map<string, { project_id: string; name: string; entries: number; seconds: number; billed_seconds: number; amount_cents: number; contact_id: string | null; no_rate: boolean }>();
  for (const r of rows) {
    const key = r.project_id ?? '-';
    const p = r.project_id ? projects.get(r.project_id) : undefined;
    const rate = rateFor(app, locationId, r.user_id, r.project_id, r.rate_cents);
    const bs = billedSeconds(r.seconds, settings.round_up_minutes);
    const row = byProject.get(key) ?? { project_id: key, name: p?.name ?? 'Ohne Projekt', entries: 0, seconds: 0, billed_seconds: 0, amount_cents: 0, contact_id: p ? projectContact(app, locationId, p) : null, no_rate: false };
    row.entries++;
    row.seconds += r.seconds;
    row.billed_seconds += bs;
    row.amount_cents += Math.round((bs / 3600) * rate);
    if (!rate) row.no_rate = true;
    byProject.set(key, row);
  }
  const list = [...byProject.values()];
  return { projects: list, entries: rows.length, seconds: list.reduce((s, p) => s + p.seconds, 0), amount_cents: list.reduce((s, p) => s + p.amount_cents, 0), approval_required: settings.approval_required };
}

export interface InvoiceResult {
  invoice: { id: string; number: string; total_cents: number; currency: string; status: string; contact_id: string | null };
  entries: number;
  seconds: number;
  hours: number;
  amount_cents: number;
}

/**
 * "In Rechnung stellen": turns the matching billable entries into an invoice draft (invoices module) and marks them as
 * billed with the rate and rounded time that went on it. Lines are grouped by task, person, project or one per entry –
 * and always by rate, so a line has one price.
 */
export function invoiceFromTime(app: App, locationId: string, b: BillingInput, actor: Actor): InvoiceResult {
  const settings = getSettings(app, locationId);
  const project = b.project_id ? getProject(app, locationId, String(b.project_id)) : undefined;
  if (!project && !b.entry_ids?.length) throw bad('Projekt oder Zeiteinträge angeben');
  const rows = billableEntries(app, locationId, { ...b, project_id: project?.id });
  if (!rows.length) throw bad(settings.approval_required && !b.include_unapproved ? 'Keine freigegebenen, abrechenbaren Zeiten gefunden' : 'Keine abrechenbaren Zeiten gefunden');
  if (rows.length > 2000) throw bad('Zu viele Einträge – bitte den Zeitraum einschränken');
  const projects = new Map(app.db.all<ProjectRow>('SELECT * FROM pm_projects WHERE location_id = ?', locationId).map((p) => [p.id, p]));
  // One customer per invoice: a request for several projects with different customers is refused.
  const customers = new Set(rows.map((r) => (r.project_id && projects.get(r.project_id) ? projectContact(app, locationId, projects.get(r.project_id)!) : null) ?? ''));
  let contactId: string | null = b.contact_id ? String(b.contact_id) : null;
  if (contactId && !app.db.get('SELECT 1 AS x FROM contacts WHERE id = ? AND location_id = ?', contactId, locationId)) throw bad('Kontakt nicht gefunden');
  if (!contactId) {
    if (customers.size > 1) throw bad('Die Einträge gehören zu verschiedenen Kunden – bitte pro Projekt abrechnen');
    contactId = [...customers][0] || null;
  }
  const tz = tzOf(app, locationId);
  const people = new Map(team(app, locationId).map((p) => [p.id, p.name]));
  const group = ['task', 'user', 'project', 'entry'].includes(b.group_by ?? '') ? b.group_by! : 'task';
  const lines = new Map<string, { name: string; description: string; seconds: number; rate: number; ids: string[]; days: Set<string> }>();
  const stamp = (d: string) => d.split('-').reverse().join('.');
  const prepared = rows.map((r) => {
    const rate = rateFor(app, locationId, r.user_id, r.project_id, r.rate_cents);
    return { r, rate, bs: billedSeconds(r.seconds, settings.round_up_minutes), day: dayOf(r.started_at, tz)! };
  });
  for (const { r, rate, bs, day } of prepared) {
    const p = r.project_id ? projects.get(r.project_id) : undefined;
    let key: string;
    let name: string;
    switch (group) {
      case 'user':
        key = r.user_id;
        name = `${p && !project ? `${p.name} – ` : ''}${people.get(r.user_id) ?? 'Mitarbeiter'}`;
        break;
      case 'project':
        key = r.project_id ?? '-';
        name = p?.name ?? 'Leistungen';
        break;
      case 'entry':
        key = r.id;
        name = `${stamp(day)} – ${r.task_title || p?.name || 'Leistung'}${r.note ? `: ${r.note}` : ''}`;
        break;
      default:
        key = r.task_id ?? `p:${r.project_id}`;
        name = r.task_title || p?.name || 'Leistung';
    }
    const k = `${key}|${rate}`;
    const l = lines.get(k) ?? { name, description: '', seconds: 0, rate, ids: [], days: new Set<string>() };
    l.seconds += bs;
    l.ids.push(r.id);
    l.days.add(day);
    lines.set(k, l);
  }
  const items = [...lines.values()].map((l) => {
    const days = [...l.days].sort();
    return {
      name: l.name.slice(0, 300),
      description: `${days.length > 1 ? `${stamp(days[0])} – ${stamp(days[days.length - 1])}` : stamp(days[0])} · ${hours2(l.seconds).toLocaleString('de-DE')} Std. à ${centsToMoney(l.rate, 'EUR')}`,
      // four decimals (what an invoice line takes): 20 minutes are 0,3333 h – rounded to 0,33 h every such line lost 18 seconds of pay
      qty: Math.round((l.seconds / 3600) * 10000) / 10000,
      price_cents: l.rate,
      unit: 'HUR',
      ...(settings.tax_rate !== null || b.tax_rate !== undefined ? { tax_rate: Number(b.tax_rate ?? settings.tax_rate) } : {}),
    };
  });
  if (!items.some((i) => i.price_cents > 0)) throw bad('Es ist kein Stundensatz hinterlegt (Projekt, Person oder Standard) – bitte zuerst einen Satz festlegen');
  const range = [b.from, b.to].filter(Boolean).map((d) => stamp(String(d)));
  const title = str(b.title, 'Titel', { max: 300 }) || `${project?.name ?? 'Leistungen'}${range.length ? ` (${range.join(' – ')})` : ''}`;
  const invoice = createInvoice(app, locationId, { contact_id: contactId, title, items, notes: str(b.notes, 'Hinweise', { max: 5000 }), currency: 'EUR' });
  const t = now();
  try {
    app.db.tx(() => {
      for (const { r, rate, bs } of prepared) app.db.run('UPDATE pm_time_entries SET invoice_id = ?, billed_rate_cents = ?, billed_seconds = ?, billed_at = ?, updated_at = ? WHERE id = ? AND invoice_id IS NULL', invoice.id, rate, bs, t, t, r.id);
    });
  } catch (e) {
    app.db.run('DELETE FROM invoices WHERE id = ?', invoice.id);
    throw e;
  }
  for (const tid of new Set(rows.map((r) => r.task_id).filter(Boolean) as string[])) {
    const task = app.db.get<any>('SELECT id, location_id, project_id FROM tasks WHERE id = ?', tid);
    if (task) logTask(app, task, actor, 'billed', { invoice: invoice.number });
  }
  const seconds = prepared.reduce((s, x) => s + x.bs, 0);
  return { invoice: { id: invoice.id, number: invoice.number, total_cents: invoice.total_cents, currency: invoice.currency, status: invoice.status, contact_id: invoice.contact_id }, entries: rows.length, seconds, hours: hours2(seconds), amount_cents: invoice.subtotal_cents };
}

// --- background -------------------------------------------------------------------------------------------

/** Timers left running (forgotten overnight) are stopped after the sub-account's limit; the person is told. */
export function autoStopTimers(app: App, at = new Date()): number {
  let n = 0;
  for (const r of app.db.all<TimeRow>('SELECT * FROM pm_time_entries WHERE ended_at IS NULL')) {
    const limit = getSettings(app, r.location_id).max_timer_hours * 3600;
    if ((at.getTime() - Date.parse(r.started_at)) / 1000 < limit) continue;
    const end = new Date(Date.parse(r.started_at) + limit * 1000);
    const done = closeEntry(app, r, end, { auto_stopped: 1 });
    n++;
    if (done) app.services.audit?.({ action: 'pm.time.auto_stop', actor: 'System', locationId: r.location_id, entityId: r.id, summary: `Timer nach ${Math.round(limit / 3600)} Stunden gestoppt`, userId: r.user_id });
    if (done) notifyUser(app, { locationId: r.location_id, userId: r.user_id, kind: 'timer', title: 'Dein Timer wurde automatisch gestoppt', body: `${r.task_title || 'Zeiterfassung'} lief länger als ${Math.round(limit / 3600)} Stunden – bitte die Zeit prüfen.`, taskId: r.task_id, projectId: r.project_id, ref: `timer-auto:${r.id}` });
  }
  return n;
}

export function myTimerState(app: App, userId: string, locationId: string | null) {
  const r = runningEntry(app, userId);
  if (!r) return null;
  const mine = locationId === r.location_id;
  const out = timeOut(app, r.location_id, [r])[0];
  const loc = app.location(r.location_id);
  // From another sub-account the person may no longer have access: show only that a timer runs.
  const mayAccess = isTeamMember(app, r.location_id, userId);
  return { ...(mayAccess ? out : { ...out, task_title: '', note: '', project_name: '' }), location_id: r.location_id, location_name: loc?.name ?? '', other_location: !mine };
}
