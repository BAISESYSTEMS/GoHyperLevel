import type { App } from '../core/app.js';
import { bad, notFound, str } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import {
  DEFAULT_STATUSES,
  FIELD_TYPES,
  PROJECT_STATES,
  STATUS_CATEGORIES,
  cleanColor,
  cleanLinks,
  dayOf,
  ensureDefaultProject,
  getProject,
  insertStatuses,
  isTeamMember,
  json,
  normDate,
  removeFiles,
  statusesOf,
  statusFor,
  team,
  todayIn,
  tzOf,
  type Actor,
  type FieldRow,
  type ProjectRow,
  type StatusCategory,
  type StatusRow,
} from './pm-core.js';
import { overdue } from './mobile.js';
import { applyTemplate, builtinTemplate, cleanTemplateData, extractTemplate, type TemplateData } from './pm-templates.js';
import { updateTask } from './pm-tasks.js';

/** Projects (workspaces) of a sub-account, their statuses, sections and custom fields. */

export interface ProjectStats {
  tasks: number;
  done: number;
  open: number;
  overdue: number;
  next_due: string | null;
  logged_seconds: number;
  billable_seconds: number;
}
export interface ProjectOut extends Omit<ProjectRow, 'is_default' | 'portal_visible' | 'billable' | 'skip_weekends'> {
  is_default: boolean;
  portal_visible: boolean;
  billable: boolean;
  skip_weekends: boolean;
  contact_name: string;
  company_name: string;
  opportunity_name: string;
  owner_name: string;
  stats: ProjectStats;
  progress: number;
}

const emptyStats = (): ProjectStats => ({ tasks: 0, done: 0, open: 0, overdue: 0, next_due: null, logged_seconds: 0, billable_seconds: 0 });

export function projectOut(app: App, locationId: string, rows: ProjectRow[]): ProjectOut[] {
  if (!rows.length) return [];
  const { db } = app;
  const tz = tzOf(app, locationId);
  const stats = new Map<string, ProjectStats>(rows.map((r) => [r.id, emptyStats()]));
  for (const r of db.all<any>(
    `SELECT project_id, COUNT(*) AS total, COALESCE(SUM(done), 0) AS done,
       COALESCE(SUM(CASE WHEN done = 0 AND due_at IS NOT NULL AND ${overdue('due_at')} THEN 1 ELSE 0 END), 0) AS late,
       MIN(CASE WHEN done = 0 THEN due_at END) AS next_due
     FROM tasks WHERE location_id = ? AND project_id IS NOT NULL GROUP BY project_id`,
    todayIn(tz),
    now(),
    locationId,
  )) {
    const s = stats.get(r.project_id);
    if (s) Object.assign(s, { tasks: Number(r.total), done: Number(r.done), open: Number(r.total) - Number(r.done), overdue: Number(r.late), next_due: r.next_due });
  }
  for (const r of db.all<any>(
    `SELECT project_id, SUM(CASE WHEN ended_at IS NULL THEN CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) ELSE seconds END) AS s,
       SUM(CASE WHEN billable = 1 THEN CASE WHEN ended_at IS NULL THEN CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER) ELSE seconds END ELSE 0 END) AS b
     FROM pm_time_entries WHERE location_id = ? AND project_id IS NOT NULL GROUP BY project_id`,
    locationId,
  )) {
    const s = stats.get(r.project_id);
    if (s) Object.assign(s, { logged_seconds: Number(r.s ?? 0), billable_seconds: Number(r.b ?? 0) });
  }
  const contacts = new Map(db.all<any>('SELECT id, first_name, last_name, email FROM contacts WHERE location_id = ?', locationId).filter((c) => rows.some((r) => r.contact_id === c.id)).map((c) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email]));
  const companyIds = rows.map((r) => r.company_id).filter(Boolean);
  const companies = new Map(companyIds.length ? db.all<any>(`SELECT id, name FROM companies WHERE location_id = ? AND id IN (${companyIds.map(() => '?').join(',')})`, locationId, ...(companyIds as string[])).map((c) => [c.id, c.name]) : []);
  const dealIds = rows.map((r) => r.opportunity_id).filter(Boolean);
  const deals = new Map(dealIds.length ? db.all<any>(`SELECT id, name FROM opportunities WHERE location_id = ? AND id IN (${dealIds.map(() => '?').join(',')})`, locationId, ...(dealIds as string[])).map((o) => [o.id, o.name]) : []);
  const people = new Map(team(app, locationId).map((p) => [p.id, p.name]));
  return rows.map((r) => {
    const s = stats.get(r.id)!;
    return {
      ...r,
      is_default: !!r.is_default,
      portal_visible: !!r.portal_visible,
      billable: !!r.billable,
      skip_weekends: !!r.skip_weekends,
      contact_name: r.contact_id ? (contacts.get(r.contact_id) ?? '') : '',
      company_name: r.company_id ? (companies.get(r.company_id) ?? '') : '',
      opportunity_name: r.opportunity_id ? (deals.get(r.opportunity_id) ?? '') : '',
      owner_name: r.owner_id ? (people.get(r.owner_id) ?? '') : '',
      stats: s,
      progress: s.tasks ? Math.round((s.done / s.tasks) * 100) : 0,
    };
  });
}

export function listProjects(app: App, locationId: string, f: { status?: string; contact_id?: string; company_id?: string; q?: string } = {}): ProjectOut[] {
  ensureDefaultProject(app, locationId);
  const where = ['location_id = ?'];
  const params: any[] = [locationId];
  if (f.status === 'archived') where.push(`status = 'archived'`);
  else if (f.status && f.status !== 'all') (where.push('status = ?'), params.push(f.status));
  else if (!f.status) where.push(`status != 'archived'`);
  if (f.contact_id) (where.push('contact_id = ?'), params.push(f.contact_id));
  if (f.company_id) (where.push('company_id = ?'), params.push(f.company_id));
  if (f.q) (where.push(`name LIKE ? ESCAPE '\\'`), params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  const rows = app.db.all<ProjectRow>(`SELECT * FROM pm_projects WHERE ${where.join(' AND ')} ORDER BY is_default DESC, position, name COLLATE NOCASE`, ...params);
  return projectOut(app, locationId, rows);
}

export const getProjectOut = (app: App, locationId: string, projectId: string): ProjectOut => projectOut(app, locationId, [getProject(app, locationId, projectId)])[0];

function cleanProject(app: App, locationId: string, b: any, cur?: ProjectRow) {
  const out: Record<string, any> = {};
  if (b.name !== undefined || !cur) out.name = str(b.name, 'Name', { required: true, max: 120 });
  if (b.description !== undefined) out.description = str(b.description, 'Beschreibung', { max: 20_000 });
  if (b.color !== undefined) out.color = cleanColor(b.color, cur?.color ?? '#2563eb');
  if (b.status !== undefined) {
    if (!PROJECT_STATES.includes(b.status)) throw bad('Status: aktiv, pausiert, abgeschlossen oder archiviert');
    if (cur?.is_default && b.status === 'archived') throw bad('Das Projekt „Allgemein“ lässt sich nicht archivieren');
    out.status = b.status;
  }
  Object.assign(out, cleanLinks(app, locationId, b, cur));
  if (b.owner_id !== undefined) {
    out.owner_id = b.owner_id ? String(b.owner_id) : null;
    if (out.owner_id && !isTeamMember(app, locationId, out.owner_id)) throw bad('Verantwortliche Person nicht gefunden');
  }
  if (b.start_at !== undefined) out.start_at = normDate(b.start_at, 'Start');
  if (b.due_at !== undefined) out.due_at = normDate(b.due_at, 'Ende');
  const s = out.start_at !== undefined ? out.start_at : cur?.start_at;
  const e = out.due_at !== undefined ? out.due_at : cur?.due_at;
  if (s && e && s > e) throw bad('Der Start liegt nach dem Ende');
  if (b.portal_visible !== undefined) out.portal_visible = b.portal_visible ? 1 : 0;
  if (b.billable !== undefined) out.billable = b.billable ? 1 : 0;
  if (b.skip_weekends !== undefined) out.skip_weekends = b.skip_weekends ? 1 : 0;
  if (b.hourly_rate_cents !== undefined) {
    if (b.hourly_rate_cents === null || b.hourly_rate_cents === '') out.hourly_rate_cents = null;
    else {
      const n = Math.round(Number(b.hourly_rate_cents));
      if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw bad('Stundensatz: Cent zwischen 0 und 10.000.000');
      out.hourly_rate_cents = n;
    }
  }
  if (b.position !== undefined && Number.isFinite(Number(b.position))) out.position = Number(b.position);
  return out;
}

export interface CreateProjectInput {
  template?: string;
  template_id?: string;
  start?: string;
}

/** The template named in a request: a built-in key or the id of a saved one. */
export function templateOf(app: App, locationId: string, key: string): { data: TemplateData; key: string } {
  const built = builtinTemplate(key);
  if (built) return { data: built.data, key: built.key };
  const row = app.db.get<any>(`SELECT * FROM pm_templates WHERE id = ? AND location_id = ? AND kind = 'project'`, key, locationId);
  if (!row) throw notFound('Vorlage nicht gefunden');
  return { data: cleanTemplateData(json(row.data, {})), key: row.id };
}

export function createProject(app: App, locationId: string, b: any, actor: Actor): ProjectOut {
  const { db } = app;
  ensureDefaultProject(app, locationId);
  const f = cleanProject(app, locationId, b);
  const tpl = b.template || b.template_id ? templateOf(app, locationId, String(b.template ?? b.template_id)) : undefined;
  const t = now();
  const row = {
    id: newId(),
    location_id: locationId,
    description: '',
    color: '#2563eb',
    status: 'active',
    owner_id: actor.id,
    is_default: 0,
    portal_visible: 0,
    billable: tpl?.data.settings?.billable === false ? 0 : 1,
    skip_weekends: tpl?.data.settings?.skip_weekends ? 1 : 0,
    template_key: tpl?.key ?? null,
    position: Number(db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM pm_projects WHERE location_id = ?', locationId)?.m ?? 0) + 1,
    created_by: actor.id,
    created_at: t,
    updated_at: t,
    ...f,
  };
  db.tx(() => {
    db.insert('pm_projects', row);
    insertStatuses(app, locationId, row.id, DEFAULT_STATUSES);
    if (tpl) applyTemplate(app, row as ProjectRow, tpl.data, actor, { start: String(b.start ?? '') || undefined, creator: actor.id, inTx: true });
  });
  return getProjectOut(app, locationId, row.id);
}

export function updateProject(app: App, locationId: string, projectId: string, b: any): ProjectOut {
  const cur = getProject(app, locationId, projectId);
  const patch = cleanProject(app, locationId, b, cur);
  if (!Object.keys(patch).length) return getProjectOut(app, locationId, cur.id);
  app.db.update('pm_projects', cur.id, { ...patch, updated_at: now() }, locationId);
  return getProjectOut(app, locationId, cur.id);
}

/** Deletes a project; its tasks move to "Allgemein" (default) or are deleted with it. */
export function deleteProject(app: App, locationId: string, projectId: string, tasks: 'move' | 'delete', actor: Actor) {
  const { db } = app;
  const p = getProject(app, locationId, projectId);
  if (p.is_default) throw bad('Das Projekt „Allgemein“ lässt sich nicht löschen');
  const home = ensureDefaultProject(app, locationId);
  if (tasks === 'delete') {
    const files = db.all<{ file: string | null }>(`SELECT a.file FROM pm_attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? AND a.file IS NOT NULL`, p.id);
    db.tx(() => {
      db.run('DELETE FROM tasks WHERE project_id = ? AND location_id = ?', p.id, locationId);
      db.run('DELETE FROM pm_projects WHERE id = ?', p.id);
    });
    removeFiles(app, files.map((f) => f.file));
  } else {
    // Top-level tasks first; their subtasks follow them.
    for (const t of db.all<{ id: string }>('SELECT id FROM tasks WHERE project_id = ? AND parent_id IS NULL', p.id)) updateTask(app, locationId, t.id, { project_id: home }, actor, { noRecurrence: true });
    db.run('DELETE FROM pm_projects WHERE id = ?', p.id);
  }
  app.events.emit(locationId, 'pm.project.deleted', { projectId: p.id, name: p.name });
  return { ok: true };
}

export function duplicateProject(app: App, locationId: string, projectId: string, b: any, actor: Actor): ProjectOut {
  const src = getProject(app, locationId, projectId);
  const data = extractTemplate(app, src);
  if (b.with_tasks === false) data.tasks = [];
  const tz = tzOf(app, locationId);
  const copy = createProject(app, locationId, { name: str(b.name, 'Name', { max: 120 }) || `${src.name} (Kopie)`, description: src.description, color: src.color, contact_id: src.contact_id, company_id: src.company_id, opportunity_id: src.opportunity_id, billable: !!src.billable, skip_weekends: !!src.skip_weekends, hourly_rate_cents: src.hourly_rate_cents }, actor);
  applyTemplate(app, getProject(app, locationId, copy.id), data, actor, { start: b.start ? String(b.start) : (dayOf(src.start_at, tz) ?? undefined), creator: actor.id });
  return getProjectOut(app, locationId, copy.id);
}

// --- saved templates ----------------------------------------------------------------------------

export function saveProjectTemplate(app: App, locationId: string, projectId: string, b: any, actor: Actor) {
  const p = getProject(app, locationId, projectId);
  const data = extractTemplate(app, p);
  const row = { id: newId(), location_id: locationId, kind: 'project', name: str(b.name, 'Name', { max: 120 }) || p.name, description: str(b.description, 'Beschreibung', { max: 2000 }) || p.description.slice(0, 500), data, created_by: actor.id, created_at: now() };
  app.db.insert('pm_templates', row);
  return { id: row.id, name: row.name, description: row.description, kind: 'project', tasks: data.tasks.length };
}

// --- statuses -----------------------------------------------------------------------------------

const MAX_STATUSES = 20;

function assertCategories(list: Pick<StatusRow, 'category'>[]) {
  if (!list.some((s) => s.category === 'todo')) throw bad('Ein Projekt braucht mindestens einen Status „Zu erledigen“');
  if (!list.some((s) => s.category === 'done')) throw bad('Ein Projekt braucht mindestens einen Status „Erledigt“');
}

const cleanCategory = (v: unknown): StatusCategory => {
  if (!STATUS_CATEGORIES.includes(v as StatusCategory)) throw bad('Kategorie: todo, active oder done');
  return v as StatusCategory;
};

export function addStatus(app: App, locationId: string, projectId: string, b: any): StatusRow {
  const p = getProject(app, locationId, projectId);
  const list = statusesOf(app, p.id);
  if (list.length >= MAX_STATUSES) throw bad(`Höchstens ${MAX_STATUSES} Status je Projekt`);
  const name = str(b.name, 'Name', { required: true, max: 60 });
  if (list.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw bad('Diesen Status gibt es schon');
  const category = cleanCategory(b.category ?? 'active');
  // New statuses go in front of the first "done" one so "Erledigt" stays last.
  const doneAt = list.findIndex((s) => s.category === 'done');
  const at = b.position !== undefined ? Math.max(0, Math.min(list.length, Math.round(Number(b.position)))) : category === 'done' || doneAt < 0 ? list.length : doneAt;
  const row: StatusRow = { id: newId(), location_id: locationId, project_id: p.id, name, category, color: cleanColor(b.color, '#94a3b8'), position: at };
  app.db.tx(() => {
    list.slice(at).forEach((s, i) => app.db.run('UPDATE pm_statuses SET position = ? WHERE id = ?', at + 1 + i, s.id));
    app.db.insert('pm_statuses', row);
  });
  return row;
}

export function updateStatus(app: App, locationId: string, statusId: string, b: any): StatusRow {
  const s = app.db.get<StatusRow>('SELECT * FROM pm_statuses WHERE id = ? AND location_id = ?', statusId, locationId);
  if (!s) throw notFound('Status nicht gefunden');
  const list = statusesOf(app, s.project_id);
  const patch: Record<string, any> = {};
  if (b.name !== undefined) {
    patch.name = str(b.name, 'Name', { required: true, max: 60 });
    if (list.some((x) => x.id !== s.id && x.name.toLowerCase() === patch.name.toLowerCase())) throw bad('Diesen Status gibt es schon');
  }
  if (b.color !== undefined) patch.color = cleanColor(b.color, s.color);
  if (b.category !== undefined) patch.category = cleanCategory(b.category);
  if (patch.category) assertCategories(list.map((x) => (x.id === s.id ? { category: patch.category as StatusCategory } : x)));
  app.db.tx(() => {
    app.db.update('pm_statuses', s.id, patch);
    // A status that turns "done" (or stops being it) takes its tasks along.
    if (patch.category && (patch.category === 'done') !== (s.category === 'done')) {
      const done = patch.category === 'done';
      app.db.run(`UPDATE tasks SET done = ?, completed_at = ${done ? "COALESCE(completed_at, ?)" : 'NULL'}, updated_at = ? WHERE status_id = ?`, ...(done ? [1, now(), now(), s.id] : [0, now(), s.id]));
    }
  });
  return app.db.get<StatusRow>('SELECT * FROM pm_statuses WHERE id = ?', s.id)!;
}

/** Removes a status; its tasks go to `moveTo` (required when there are any, and it must be in the same project). */
export function deleteStatus(app: App, locationId: string, statusId: string, moveTo?: string) {
  const s = app.db.get<StatusRow>('SELECT * FROM pm_statuses WHERE id = ? AND location_id = ?', statusId, locationId);
  if (!s) throw notFound('Status nicht gefunden');
  const list = statusesOf(app, s.project_id);
  assertCategories(list.filter((x) => x.id !== s.id));
  const used = Number(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE status_id = ?', s.id)?.n);
  let target: StatusRow | undefined;
  if (used) {
    target = list.find((x) => x.id === moveTo && x.id !== s.id);
    if (!target) throw bad(`In diesem Status liegen ${used} Aufgaben – bitte einen anderen Status zum Verschieben wählen`);
  }
  app.db.tx(() => {
    if (target) {
      const done = target.category === 'done';
      app.db.run(`UPDATE tasks SET status_id = ?, done = ?, completed_at = ${done ? 'COALESCE(completed_at, ?)' : 'NULL'}, updated_at = ? WHERE status_id = ?`, ...(done ? [target.id, 1, now(), now(), s.id] : [target.id, 0, now(), s.id]));
    }
    app.db.run('DELETE FROM pm_statuses WHERE id = ?', s.id);
    statusesOf(app, s.project_id).forEach((x, i) => app.db.run('UPDATE pm_statuses SET position = ? WHERE id = ?', i, x.id));
  });
  return { ok: true, moved: used };
}

export function reorderStatuses(app: App, locationId: string, projectId: string, ids: unknown) {
  const p = getProject(app, locationId, projectId);
  const list = statusesOf(app, p.id);
  const order = (Array.isArray(ids) ? ids : []).map(String);
  if (order.length !== list.length || !list.every((s) => order.includes(s.id))) throw bad('Reihenfolge: alle Status genau einmal angeben');
  order.forEach((sid, i) => app.db.run('UPDATE pm_statuses SET position = ? WHERE id = ?', i, sid));
  return statusesOf(app, p.id);
}

// --- sections -----------------------------------------------------------------------------------

export function sectionsOf(app: App, projectId: string) {
  return app.db.all<{ id: string; project_id: string; name: string; position: number }>('SELECT id, project_id, name, position FROM pm_sections WHERE project_id = ? ORDER BY position, rowid', projectId);
}

export function addSection(app: App, locationId: string, projectId: string, b: any) {
  const p = getProject(app, locationId, projectId);
  const list = sectionsOf(app, p.id);
  if (list.length >= 100) throw bad('Höchstens 100 Abschnitte je Projekt');
  const row = { id: newId(), location_id: locationId, project_id: p.id, name: str(b.name, 'Name', { required: true, max: 120 }), position: list.length, created_at: now() };
  app.db.insert('pm_sections', row);
  return { id: row.id, project_id: p.id, name: row.name, position: row.position };
}

export function updateSection(app: App, locationId: string, sectionId: string, b: any) {
  const s = app.db.get<any>('SELECT * FROM pm_sections WHERE id = ? AND location_id = ?', sectionId, locationId);
  if (!s) throw notFound('Abschnitt nicht gefunden');
  const patch: Record<string, any> = {};
  if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 120 });
  if (b.position !== undefined && Number.isFinite(Number(b.position))) patch.position = Math.round(Number(b.position));
  app.db.update('pm_sections', s.id, patch);
  return app.db.get<any>('SELECT id, project_id, name, position FROM pm_sections WHERE id = ?', s.id);
}

export function deleteSection(app: App, locationId: string, sectionId: string) {
  const s = app.db.get<any>('SELECT * FROM pm_sections WHERE id = ? AND location_id = ?', sectionId, locationId);
  if (!s) throw notFound('Abschnitt nicht gefunden');
  app.db.tx(() => {
    app.db.run('UPDATE tasks SET section_id = NULL WHERE section_id = ?', s.id);
    app.db.run('DELETE FROM pm_sections WHERE id = ?', s.id);
    sectionsOf(app, s.project_id).forEach((x, i) => app.db.run('UPDATE pm_sections SET position = ? WHERE id = ?', i, x.id));
  });
  return { ok: true };
}

export function reorderSections(app: App, locationId: string, projectId: string, ids: unknown) {
  const p = getProject(app, locationId, projectId);
  const list = sectionsOf(app, p.id);
  const order = (Array.isArray(ids) ? ids : []).map(String);
  if (order.length !== list.length || !list.every((s) => order.includes(s.id))) throw bad('Reihenfolge: alle Abschnitte genau einmal angeben');
  order.forEach((sid, i) => app.db.run('UPDATE pm_sections SET position = ? WHERE id = ?', i, sid));
  return sectionsOf(app, p.id);
}

// --- custom fields ------------------------------------------------------------------------------

export function addField(app: App, locationId: string, b: any): FieldRow {
  const label = str(b.label, 'Bezeichnung', { required: true, max: 80 });
  const key = (str(b.key, 'Schlüssel', { max: 40 }) || label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).slice(0, 40);
  if (!/^[a-z0-9_]+$/.test(key)) throw bad('Schlüssel nur a-z, 0-9 und _');
  const projectId = b.project_id ? getProject(app, locationId, String(b.project_id)).id : null;
  if (app.db.get('SELECT 1 AS x FROM pm_custom_fields WHERE location_id = ? AND key = ? AND (project_id IS NULL OR project_id IS ?)', locationId, key, projectId)) throw bad('Dieses Feld gibt es schon');
  if (projectId === null && app.db.get('SELECT 1 AS x FROM pm_custom_fields WHERE location_id = ? AND key = ?', locationId, key)) throw bad('Dieses Feld gibt es schon');
  const type = FIELD_TYPES.includes(b.type) ? b.type : 'text';
  const options = type === 'select' ? (Array.isArray(b.options) ? b.options.map((o: unknown) => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 50) : []) : [];
  if (type === 'select' && !options.length) throw bad('Auswahlfeld: mindestens eine Option');
  const row = { id: newId(), location_id: locationId, project_id: projectId, key, label, type, options, position: Number(app.db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM pm_custom_fields WHERE location_id = ?', locationId)?.m ?? 0) + 1, created_at: now() };
  app.db.insert('pm_custom_fields', row);
  return row as FieldRow;
}

export function updateField(app: App, locationId: string, fieldId: string, b: any): FieldRow {
  const f = app.db.get<any>('SELECT * FROM pm_custom_fields WHERE id = ? AND location_id = ?', fieldId, locationId);
  if (!f) throw notFound('Feld nicht gefunden');
  const patch: Record<string, any> = {};
  if (b.label !== undefined) patch.label = str(b.label, 'Bezeichnung', { required: true, max: 80 });
  if (b.options !== undefined && f.type === 'select') {
    patch.options = (Array.isArray(b.options) ? b.options : []).map((o: unknown) => String(o).trim().slice(0, 80)).filter(Boolean).slice(0, 50);
    if (!patch.options.length) throw bad('Auswahlfeld: mindestens eine Option');
  }
  if (b.position !== undefined && Number.isFinite(Number(b.position))) patch.position = Math.round(Number(b.position));
  app.db.update('pm_custom_fields', f.id, patch);
  const out = app.db.get<any>('SELECT * FROM pm_custom_fields WHERE id = ?', f.id);
  return { ...out, options: json(out.options, []) };
}

export function deleteField(app: App, locationId: string, fieldId: string) {
  const f = app.db.get<any>('SELECT * FROM pm_custom_fields WHERE id = ? AND location_id = ?', fieldId, locationId);
  if (!f) throw notFound('Feld nicht gefunden');
  app.db.tx(() => {
    // The values stay in the tasks' JSON but are no longer shown; clean them so a new field with the same key starts empty.
    app.db.run(`UPDATE tasks SET custom = json_remove(custom, ?) WHERE location_id = ? AND json_extract(custom, ?) IS NOT NULL`, `$.${f.key}`, locationId, `$.${f.key}`);
    app.db.run('DELETE FROM pm_custom_fields WHERE id = ?', f.id);
  });
  return { ok: true };
}

export { statusFor };
