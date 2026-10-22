import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { hmInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { id as newId, now } from '../core/util.js';
import { addDays, isYmd } from './pm-schedule.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Project planning, shared pieces: projects/statuses/sections/custom fields, the people who can be assigned,
 * date handling, activity and notifications. Tasks themselves are in pm-tasks.ts (they live in the existing
 * `tasks` table, extended by the `pm` module's migration).
 */

export const PRIORITY_LABELS = ['Keine', 'Niedrig', 'Normal', 'Hoch', 'Dringend'];
const PRIORITY_NAMES: Record<string, number> = { none: 0, keine: 0, low: 1, niedrig: 1, normal: 2, medium: 2, high: 3, hoch: 3, urgent: 4, dringend: 4 };
export const STATUS_CATEGORIES = ['todo', 'active', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<StatusCategory, string> = { todo: 'Zu erledigen', active: 'In Arbeit', done: 'Erledigt' };
export const PROJECT_STATES = ['active', 'paused', 'done', 'archived'] as const;
export const DEFAULT_STATUSES: { name: string; category: StatusCategory; color: string }[] = [
  { name: 'Offen', category: 'todo', color: '#94a3b8' },
  { name: 'In Arbeit', category: 'active', color: '#3b82f6' },
  { name: 'In Prüfung', category: 'active', color: '#f59e0b' },
  { name: 'Erledigt', category: 'done', color: '#10b981' },
];
export const DEFAULT_PROJECT_NAME = 'Allgemein';
export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'url'] as const;
const COLOR = /^#[0-9a-f]{6}$/i;

export const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export interface Actor {
  id: string | null;
  name: string;
  via?: string;
}
/** Who is acting: the signed-in user, or an API key / the system (no user id). */
export function actorOf(ctx: Pick<Ctx, 'user' | 'via' | 'viaApiKey'>): Actor {
  const real = ctx.user && !String(ctx.user.id).startsWith('key:') ? ctx.user : undefined;
  return { id: real?.id ?? null, name: ctx.user?.name ?? (ctx.viaApiKey ? 'API-Schlüssel' : 'System'), via: ctx.via };
}
export const SYSTEM: Actor = { id: null, name: 'Automation', via: 'automation' };

// --- dates --------------------------------------------------------------------------------------

export const isDateOnly = (iso: string | null | undefined): boolean => !!iso && /T00:00:00(\.000)?Z$/.test(iso);

/** `YYYY-MM-DD` → date-only (UTC midnight, the web app's convention), ISO → normalised instant, empty → null. */
export function normDate(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (!isYmd(s)) throw bad(`${label}: ungültiges Datum`);
    return `${s}T00:00:00.000Z`;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw bad(`${label}: ungültiges Datum`);
  return new Date(t).toISOString();
}

/** The calendar day a stored date falls on: date-only values keep their date, timed ones count in the time zone. */
export function dayOf(iso: string | null | undefined, tz: string): string | null {
  if (!iso) return null;
  return isDateOnly(iso) ? iso.slice(0, 10) : ymdInTz(new Date(iso), tz);
}

/** The same stored date on another day (keeps the time of day of timed values). */
export function withDay(orig: string | null | undefined, ymd: string, tz: string): string {
  if (!orig || isDateOnly(orig)) return `${ymd}T00:00:00.000Z`;
  return zonedToUtc(ymd, hmInTz(new Date(orig), tz), tz).toISOString();
}

export const todayIn = (tz: string, at = new Date()) => ymdInTz(at, tz);
/** Is a stored due date past? A date without a time is overdue the day after (in the zone), a timed one at its time. */
export const isOverdue = (iso: string | null | undefined, tz: string, at = new Date()): boolean => !!iso && (isDateOnly(iso) ? iso.slice(0, 10) < todayIn(tz, at) : Date.parse(iso) < at.getTime());
export const tzOf = (app: App, loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
export { addDays };

export function cleanPriority(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'string' && v.trim().toLowerCase() in PRIORITY_NAMES) return PRIORITY_NAMES[v.trim().toLowerCase()];
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0 || n > 4) throw bad('Priorität: keine, niedrig, normal, hoch oder dringend');
  return n;
}

export function cleanTags(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  const out: string[] = [];
  for (const t of list) {
    const s = String(t ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  if (out.length > 20) throw bad('Höchstens 20 Tags je Aufgabe');
  return out;
}

export const cleanColor = (v: unknown, fallback: string) => (typeof v === 'string' && COLOR.test(v) ? v : fallback);

// --- people -------------------------------------------------------------------------------------

export interface Person {
  id: string;
  name: string;
  email: string;
}

/** Everyone who may work on this sub-account's tasks (agency admins and members with the tasks area). */
export function team(app: App, locationId: string): Person[] {
  return app.db
    .all<{ id: string; name: string; email: string; role: string; locations: string; permissions: string | null }>('SELECT id, name, email, role, locations, permissions FROM users ORDER BY name')
    .filter((u) => u.role === 'admin' || json<string[]>(u.locations, []).includes(locationId))
    .filter((u) => !hiddenUser(app, u, locationId))
    .filter((u) => u.role === 'admin' || !u.permissions || json<string[]>(u.permissions, []).includes('contacts'))
    .map((u) => ({ id: u.id, name: u.name || u.email, email: u.email }));
}
export const isTeamMember = (app: App, locationId: string, userId: string) => team(app, locationId).some((p) => p.id === userId);

/** Keeps only people who can work here; unknown ids are an error (a typo must not silently drop an assignee). */
export function cleanPeople(app: App, locationId: string, v: unknown, label: string, max = 20): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad(`${label}: Liste von Nutzer-IDs erwartet`);
  const known = new Set(team(app, locationId).map((p) => p.id));
  const out: string[] = [];
  for (const raw of v) {
    const u = String(raw ?? '');
    if (!u || out.includes(u)) continue;
    if (!known.has(u)) throw bad(`${label}: Nutzer nicht gefunden oder ohne Zugriff`);
    out.push(u);
  }
  if (out.length > max) throw bad(`${label}: höchstens ${max} Personen`);
  return out;
}

// --- settings -----------------------------------------------------------------------------------

export interface PmSettings {
  /** Weekly capacity per person in hours (workload view). */
  capacity_hours: number;
  /** Time entries need an approved week before they can be billed. */
  approval_required: boolean;
  /** Allow overlapping time entries of one person. */
  allow_overlap: boolean;
  /** Billing rounds every entry up to this many minutes (0 = exact). */
  round_up_minutes: number;
  /** Rate used when neither the project nor the person has one (cents per hour). */
  default_rate_cents: number;
  /** A running timer older than this is stopped by the server (hours). */
  max_timer_hours: number;
  /** Invoice tax rate for time lines (empty = the invoice settings' default). */
  tax_rate: number | null;
}
export const DEFAULT_SETTINGS: PmSettings = { capacity_hours: 40, approval_required: false, allow_overlap: false, round_up_minutes: 0, default_rate_cents: 0, max_timer_hours: 16, tax_rate: null };

export function getSettings(app: App, locationId: string): PmSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM pm_settings WHERE location_id = ?', locationId);
  return { ...DEFAULT_SETTINGS, ...json<Partial<PmSettings>>(row?.data, {}) };
}

export function saveSettings(app: App, locationId: string, body: any): PmSettings {
  const cur = getSettings(app, locationId);
  const next: PmSettings = { ...cur };
  const int = (v: unknown, label: string, min: number, max: number) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label}: Zahl zwischen ${min} und ${max}`);
    return n;
  };
  if (body.capacity_hours !== undefined) next.capacity_hours = int(body.capacity_hours, 'Wochenkapazität', 1, 168);
  if (body.approval_required !== undefined) next.approval_required = !!body.approval_required;
  if (body.allow_overlap !== undefined) next.allow_overlap = !!body.allow_overlap;
  if (body.round_up_minutes !== undefined) {
    const n = int(body.round_up_minutes, 'Aufrunden', 0, 240);
    next.round_up_minutes = n;
  }
  if (body.default_rate_cents !== undefined) next.default_rate_cents = int(body.default_rate_cents, 'Standard-Stundensatz', 0, 10_000_000);
  if (body.max_timer_hours !== undefined) next.max_timer_hours = int(body.max_timer_hours, 'Timer-Höchstdauer', 1, 72);
  if (body.tax_rate !== undefined) next.tax_rate = body.tax_rate === null || body.tax_rate === '' ? null : Math.max(0, Math.min(100, Number(body.tax_rate) || 0));
  app.db.run('INSERT INTO pm_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', locationId, JSON.stringify(next), now());
  return next;
}

// --- projects -----------------------------------------------------------------------------------

export interface StatusRow {
  id: string;
  location_id: string;
  project_id: string;
  name: string;
  category: StatusCategory;
  color: string;
  position: number;
}
export interface ProjectRow {
  id: string;
  location_id: string;
  name: string;
  description: string;
  color: string;
  status: (typeof PROJECT_STATES)[number];
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  owner_id: string | null;
  start_at: string | null;
  due_at: string | null;
  is_default: number;
  portal_visible: number;
  billable: number;
  hourly_rate_cents: number | null;
  skip_weekends: number;
  template_key: string | null;
  baseline_at: string | null;
  position: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function insertStatuses(app: App, locationId: string, projectId: string, list: { name: string; category: StatusCategory; color?: string }[]): StatusRow[] {
  return list.map((s, i) => {
    const row: StatusRow = { id: newId(), location_id: locationId, project_id: projectId, name: s.name, category: s.category, color: s.color ?? '#94a3b8', position: i };
    app.db.insert('pm_statuses', row);
    return row;
  });
}

/**
 * The sub-account's "Allgemein" project (created on first use). Tasks written by the rest of the app – the plain
 * task list, workflows, Todoist, the mobile app – land there; any left without a project are adopted here.
 */
export function ensureDefaultProject(app: App, locationId: string): string {
  const { db } = app;
  let p = db.get<{ id: string }>('SELECT id FROM pm_projects WHERE location_id = ? AND is_default = 1', locationId);
  if (!p) {
    const t = now();
    const row = { id: newId(), location_id: locationId, name: DEFAULT_PROJECT_NAME, description: 'Aufgaben ohne eigenes Projekt', color: '#64748b', status: 'active', is_default: 1, position: -1, created_at: t, updated_at: t };
    db.tx(() => {
      if (db.run(`INSERT OR IGNORE INTO pm_projects (id, location_id, name, description, color, status, is_default, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.location_id, row.name, row.description, row.color, row.status, row.is_default, row.position, row.created_at, row.updated_at).changes) insertStatuses(app, locationId, row.id, DEFAULT_STATUSES);
    });
    p = db.get<{ id: string }>('SELECT id FROM pm_projects WHERE location_id = ? AND is_default = 1', locationId)!;
  }
  if (db.get('SELECT 1 AS x FROM tasks WHERE location_id = ? AND project_id IS NULL LIMIT 1', locationId)) {
    db.run(
      `UPDATE tasks SET project_id = ?, status_id = (SELECT id FROM pm_statuses WHERE project_id = ? AND category = CASE WHEN tasks.done = 1 THEN 'done' ELSE 'todo' END ORDER BY position LIMIT 1)
       WHERE location_id = ? AND project_id IS NULL`,
      p.id,
      p.id,
      locationId,
    );
  }
  return p.id;
}

export function getProject(app: App, locationId: string, projectId: string): ProjectRow {
  const p = app.db.get<ProjectRow>('SELECT * FROM pm_projects WHERE id = ? AND location_id = ?', String(projectId ?? ''), locationId);
  if (!p) throw notFound('Projekt nicht gefunden');
  return p;
}

export const statusesOf = (app: App, projectId: string): StatusRow[] => app.db.all<StatusRow>('SELECT * FROM pm_statuses WHERE project_id = ? ORDER BY position, rowid', projectId);

/** First status of a category (todo → "Offen", done → "Erledigt"). */
export function statusFor(statuses: StatusRow[], category: StatusCategory): StatusRow | undefined {
  return statuses.find((s) => s.category === category);
}

const tableExists = (app: App, name: string) => !!app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

/** Contact, company and deal a project may be linked to (must belong to the sub-account). */
export function cleanLinks(app: App, locationId: string, b: any, cur: Partial<ProjectRow> = {}) {
  const out: { contact_id: string | null; company_id: string | null; opportunity_id: string | null } = { contact_id: cur.contact_id ?? null, company_id: cur.company_id ?? null, opportunity_id: cur.opportunity_id ?? null };
  if (b.contact_id !== undefined) {
    out.contact_id = b.contact_id ? String(b.contact_id) : null;
    if (out.contact_id && !app.db.get('SELECT 1 AS x FROM contacts WHERE id = ? AND location_id = ?', out.contact_id, locationId)) throw bad('Kontakt nicht gefunden');
  }
  if (b.company_id !== undefined) {
    out.company_id = b.company_id ? String(b.company_id) : null;
    if (out.company_id && (!tableExists(app, 'companies') || !app.db.get('SELECT 1 AS x FROM companies WHERE id = ? AND location_id = ?', out.company_id, locationId))) throw bad('Firma nicht gefunden');
  }
  if (b.opportunity_id !== undefined) {
    out.opportunity_id = b.opportunity_id ? String(b.opportunity_id) : null;
    if (out.opportunity_id && !app.db.get('SELECT 1 AS x FROM opportunities WHERE id = ? AND location_id = ?', out.opportunity_id, locationId)) throw bad('Deal nicht gefunden');
  }
  return out;
}

/** The customer a project's time is billed to: its contact, else the deal's contact, else the company's primary contact. */
export function projectContact(app: App, locationId: string, p: Pick<ProjectRow, 'contact_id' | 'company_id' | 'opportunity_id'>): string | null {
  if (p.contact_id) return p.contact_id;
  if (p.opportunity_id) {
    const o = app.db.get<{ contact_id: string }>('SELECT contact_id FROM opportunities WHERE id = ? AND location_id = ?', p.opportunity_id, locationId);
    if (o) return o.contact_id;
  }
  if (p.company_id) {
    const primary = app.services.associations?.list?.(locationId, { type: 'company', id: p.company_id }, { type: 'contact' })?.[0];
    if (primary?.record_id) return primary.record_id as string;
  }
  return null;
}

// --- custom fields ------------------------------------------------------------------------------

export interface FieldRow {
  id: string;
  location_id: string;
  project_id: string | null;
  key: string;
  label: string;
  type: (typeof FIELD_TYPES)[number];
  options: string[];
  position: number;
}

/** Fields that apply to a project: its own plus the ones for every project. */
export function fieldsFor(app: App, locationId: string, projectId: string | null): FieldRow[] {
  return app.db
    .all<any>('SELECT * FROM pm_custom_fields WHERE location_id = ? AND (project_id IS NULL OR project_id = ?) ORDER BY position, label', locationId, projectId ?? '')
    .map((f) => ({ ...f, options: json<string[]>(f.options, []) }));
}

/** Validates custom field values against the field definitions; `null` clears a value. Unknown keys are refused. */
export function cleanCustom(app: App, locationId: string, projectId: string | null, input: unknown, cur: Record<string, any> = {}): Record<string, any> {
  if (input === undefined) return cur;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Eigene Felder: Objekt {schlüssel: wert} erwartet');
  const defs = new Map(fieldsFor(app, locationId, projectId).map((f) => [f.key, f]));
  const out = { ...cur };
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const f = defs.get(k);
    if (!f) throw bad(`Eigenes Feld „${k}“ gibt es in diesem Projekt nicht`);
    if (v === null || v === '') {
      delete out[k];
      continue;
    }
    switch (f.type) {
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw bad(`${f.label}: Zahl erwartet`);
        out[k] = n;
        break;
      }
      case 'date':
        if (!isYmd(String(v))) throw bad(`${f.label}: Datum als JJJJ-MM-TT erwartet`);
        out[k] = String(v);
        break;
      case 'select':
        if (!f.options.includes(String(v))) throw bad(`${f.label}: Wert nicht in der Auswahl`);
        out[k] = String(v);
        break;
      case 'checkbox':
        out[k] = v === true || v === 'true' || v === 1 || v === '1';
        break;
      case 'url':
        if (!/^https?:\/\/[^\s]+$/i.test(String(v))) throw bad(`${f.label}: Link mit https:// erwartet`);
        out[k] = String(v).slice(0, 1000);
        break;
      default:
        out[k] = String(v).slice(0, 500);
    }
  }
  return out;
}

// --- activity & notifications -----------------------------------------------------------------

export function logTask(app: App, t: { id: string; location_id: string; project_id?: string | null }, actor: Actor, kind: string, data: Record<string, any> = {}) {
  app.db.run('INSERT INTO pm_activity (location_id, task_id, project_id, user_id, user_name, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', t.location_id, t.id, t.project_id ?? null, actor.id, actor.name.slice(0, 200), kind, JSON.stringify(data), now());
  // Old history goes: keep the last 300 entries of a task.
  if (kind !== 'created') app.db.run('DELETE FROM pm_activity WHERE task_id = ? AND id <= (SELECT MAX(id) - 300 FROM pm_activity WHERE task_id = ?)', t.id, t.id);
}

export interface NotifyInput {
  locationId: string;
  userId: string;
  kind: 'mention' | 'assigned' | 'due' | 'overdue' | 'comment' | 'status' | 'timer' | 'timesheet' | 'watch';
  title: string;
  body?: string;
  taskId?: string | null;
  projectId?: string | null;
  /** Same ref for the same person = notified once. */
  ref?: string;
  /** Skip the push (the notification list and the app feed still get it). */
  quiet?: boolean;
}

/**
 * One notification for one person: the in-app list, a push to their devices and an entry in the Android app's
 * feed. Dedupes on `ref`; never notifies someone without access to the sub-account.
 */
export function notifyUser(app: App, n: NotifyInput): boolean {
  if (!n.userId || !isTeamMember(app, n.locationId, n.userId)) return false;
  const link = n.taskId ? `/app/pm/task/${n.taskId}` : n.projectId ? `/app/pm/${n.projectId}` : '/app/pm';
  const row = { id: newId(), location_id: n.locationId, user_id: n.userId, kind: n.kind, task_id: n.taskId ?? null, project_id: n.projectId ?? null, title: n.title.slice(0, 200), body: (n.body ?? '').slice(0, 400), link, ref: n.ref ?? null, read_at: null, created_at: now() };
  if (n.ref && app.db.get('SELECT 1 AS x FROM pm_notifications WHERE user_id = ? AND ref = ?', n.userId, n.ref)) return false;
  app.db.insert('pm_notifications', row);
  app.db.run('DELETE FROM pm_notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM pm_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 300)', n.userId, n.userId);
  if (!n.quiet) {
    // The primary assignee's "new task" push comes from the push module itself – mark it so it does not repeat.
    if (n.kind === 'assigned' && n.taskId) app.db.run('INSERT OR IGNORE INTO push_task_seen (task_id, kind, at) VALUES (?, ?, ?)', n.taskId, `assigned:${n.userId}`, now());
    void Promise.resolve(app.services.pushNotify?.({ locationId: n.locationId, userIds: [n.userId], kind: 'tasks', title: row.title, body: row.body, url: link, tag: `pm-${n.taskId ?? n.projectId ?? n.kind}` })).catch((e) => console.error('[pm] push', (e as Error).message));
  }
  app.services.mobileFeed?.({ locationId: n.locationId, type: `pm_${n.kind}`, area: '', userId: n.userId, title: row.title, body: row.body, link, ref: n.ref ?? `pm:${row.id}` });
  return true;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `@Name` mentions in a text plus explicitly listed ids, limited to people who work on this sub-account. */
export function mentionsIn(app: App, locationId: string, text: string, explicit: unknown): string[] {
  const people = team(app, locationId);
  const found = new Set<string>();
  if (Array.isArray(explicit)) for (const u of explicit) if (people.some((p) => p.id === u)) found.add(String(u));
  const lower = text.toLowerCase();
  for (const p of people) {
    const names = [p.name, p.email.split('@')[0]].filter((x) => x && x.length >= 2).map((x) => x.toLowerCase());
    // "@Max Mustermann" – the whole name, followed by anything but a name character.
    if (names.some((nm) => new RegExp(`(^|[^\\w])@${escapeRe(nm)}(?![\\p{L}\\p{N}_])`, 'u').test(lower))) found.add(p.id);
  }
  return [...found];
}

// --- stored files (attachments) --------------------------------------------------------------

export const filesDir = (app: App) => join(app.config.dataDir, 'pm-files');
/** Path of a stored attachment; only the plain file name is ever used. */
export const storedPath = (app: App, stored: string) => join(filesDir(app), stored.replace(/[^\w.-]/g, ''));
export function removeFiles(app: App, files: (string | null | undefined)[]) {
  for (const f of files) {
    if (!f) continue;
    try {
      rmSync(storedPath(app, f), { force: true });
    } catch {
      /* already gone */
    }
  }
}

// --- misc ---------------------------------------------------------------------------------------

export function requireText(v: unknown, label: string, max: number): string {
  const s = str(v, label, { required: true, max });
  if (!s) throw bad(`${label} fehlt`);
  return s;
}

export function failOnTree(e: unknown): never {
  if (e instanceof Error && ['TreeError', 'DepError', 'RecurrenceError'].includes(e.constructor.name)) throw bad(e.message);
  throw e;
}

export { HttpError, parseJson };
