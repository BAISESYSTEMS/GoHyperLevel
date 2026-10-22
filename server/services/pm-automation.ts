import type { App } from '../core/app.js';
import { bad, notFound, str } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { SYSTEM, dayOf, getProject, json, notifyUser, statusesOf, team, todayIn, tzOf, type Actor } from './pm-core.js';
import { createTask, decorate, getTask, updateTask, resolveStatus, type TaskOut, type TaskRow } from './pm-tasks.js';

/**
 * Automations of a project (or of all projects): "when a task's status changes / is completed / created /
 * assigned / becomes overdue, then create a task from a template, move the status, assign someone …".
 * Rules live in `pm_automations`; the module feeds them the task events. A chain of rules is limited to three
 * levels and no rule runs twice in one chain, so rules can never loop.
 */

export const TRIGGERS: Record<string, string> = {
  'task.status_changed': 'Status geändert',
  'task.completed': 'Aufgabe erledigt',
  'task.overdue': 'Aufgabe überfällig',
  'task.created': 'Aufgabe angelegt',
  'task.assigned': 'Aufgabe zugewiesen',
};
export const ACTIONS: Record<string, string> = {
  create_task: 'Aufgabe anlegen (aus Vorlage)',
  move_status: 'Status setzen',
  assign: 'Zuweisen',
  set_priority: 'Priorität setzen',
  add_tag: 'Tag hinzufügen',
  notify: 'Benachrichtigen',
};
export const MAX_DEPTH = 3;

export interface AutomationRow {
  id: string;
  location_id: string;
  project_id: string | null;
  name: string;
  enabled: number;
  trigger: string;
  conditions: Record<string, any>;
  actions: Record<string, any>[];
  runs: number;
  last_run_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const outRow = (r: any): AutomationRow => ({ ...r, enabled: !!r.enabled, conditions: json(r.conditions, {}), actions: json(r.actions, []) });

// --- task templates (for "Aufgabe aus Vorlage") ----------------------------------------------------------

export interface TaskTemplateData {
  title: string;
  description?: string;
  priority?: number | string;
  tags?: string[];
  estimate_minutes?: number;
  due_in_days?: number;
  checklist?: { title: string; items: string[] }[];
  subtasks?: (string | { title: string; due_in_days?: number })[];
  assignee?: string;
}

export function cleanTaskTemplate(b: any): TaskTemplateData {
  const title = str(b?.title, 'Titel', { required: true, max: 300 });
  const out: TaskTemplateData = { title };
  if (b.description) out.description = str(b.description, 'Beschreibung', { max: 20_000 });
  if (b.priority !== undefined) out.priority = b.priority;
  if (Array.isArray(b.tags)) out.tags = b.tags.map((t: unknown) => String(t).slice(0, 40)).slice(0, 20);
  if (b.estimate_minutes !== undefined && Number.isFinite(Number(b.estimate_minutes))) out.estimate_minutes = Math.max(0, Math.round(Number(b.estimate_minutes)));
  if (b.due_in_days !== undefined && b.due_in_days !== '' && Number.isFinite(Number(b.due_in_days))) out.due_in_days = Math.max(0, Math.min(3650, Math.round(Number(b.due_in_days))));
  if (Array.isArray(b.checklist)) out.checklist = b.checklist.slice(0, 20).map((c: any) => ({ title: String(c?.title ?? 'Checkliste').slice(0, 120), items: (Array.isArray(c?.items) ? c.items : []).map((i: unknown) => String(i).slice(0, 300)).slice(0, 100) }));
  if (Array.isArray(b.subtasks)) out.subtasks = b.subtasks.slice(0, 50).map((s: any) => (typeof s === 'string' ? s.slice(0, 300) : { title: String(s?.title ?? '').slice(0, 300), due_in_days: Number.isFinite(Number(s?.due_in_days)) ? Math.max(0, Math.round(Number(s.due_in_days))) : undefined })).filter((s: any) => (typeof s === 'string' ? s : s.title));
  if (b.assignee) out.assignee = String(b.assignee).slice(0, 40);
  return out;
}

export function listTaskTemplates(app: App, locationId: string) {
  return app.db.all<any>(`SELECT id, name, description, data, created_at FROM pm_templates WHERE location_id = ? AND kind = 'task' ORDER BY name COLLATE NOCASE`, locationId).map((t) => ({ ...t, data: json<TaskTemplateData>(t.data, { title: t.name }) }));
}

export function saveTaskTemplate(app: App, locationId: string, b: any, actor: Actor) {
  const data = cleanTaskTemplate(b.data ?? b);
  const row = { id: newId(), location_id: locationId, kind: 'task', name: str(b.name, 'Name', { max: 120 }) || data.title, description: str(b.description, 'Beschreibung', { max: 2000 }), data, created_by: actor.id, created_at: now() };
  app.db.insert('pm_templates', row);
  return { id: row.id, name: row.name, description: row.description, data, created_at: row.created_at };
}

export function deleteTemplate(app: App, locationId: string, templateId: string) {
  if (!app.db.run('DELETE FROM pm_templates WHERE id = ? AND location_id = ?', templateId, locationId).changes) throw notFound('Vorlage nicht gefunden');
  return { ok: true };
}

/** A task body from a task template, due dates counted from today. */
export function taskFromTemplate(app: App, locationId: string, t: TaskTemplateData, tz: string, base: Record<string, any> = {}) {
  const due = (days: number) => {
    const d = new Date(`${todayIn(tz)}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
  };
  return {
    ...base,
    title: t.title,
    description: t.description,
    priority: t.priority,
    tags: t.tags,
    estimate_minutes: t.estimate_minutes,
    due_at: t.due_in_days !== undefined ? due(t.due_in_days) : undefined,
    checklists: (t.checklist ?? []).map((c) => ({ title: c.title, items: c.items.map((text) => ({ text })) })),
    subtasks: (t.subtasks ?? []).map((s) => (typeof s === 'string' ? { title: s } : { title: s.title, due_at: s.due_in_days !== undefined ? due(s.due_in_days) : undefined })),
  };
}

// --- rules --------------------------------------------------------------------------------------------------

const cleanConditions = (b: any): Record<string, any> => {
  const c: Record<string, any> = {};
  if (!b || typeof b !== 'object') return c;
  for (const k of ['status_id', 'from_status_id', 'to_category', 'tag', 'assignee', 'title_contains', 'section_id'] as const) if (b[k]) c[k] = String(b[k]).slice(0, 120);
  if (b.priority_min !== undefined && b.priority_min !== '' && Number.isFinite(Number(b.priority_min))) c.priority_min = Math.max(0, Math.min(4, Math.round(Number(b.priority_min))));
  return c;
};

function cleanActions(app: App, locationId: string, input: unknown): Record<string, any>[] {
  if (!Array.isArray(input) || !input.length) throw bad('Mindestens eine Aktion');
  if (input.length > 10) throw bad('Höchstens 10 Aktionen je Regel');
  return input.map((a: any, i) => {
    const type = String(a?.type ?? '');
    if (!(type in ACTIONS)) throw bad(`Aktion ${i + 1}: unbekannter Typ`);
    const out: Record<string, any> = { type };
    switch (type) {
      case 'create_task':
        if (a.template_id) {
          if (!app.db.get(`SELECT 1 AS x FROM pm_templates WHERE id = ? AND location_id = ? AND kind = 'task'`, String(a.template_id), locationId)) throw bad(`Aktion ${i + 1}: Aufgabenvorlage nicht gefunden`);
          out.template_id = String(a.template_id);
        } else {
          Object.assign(out, cleanTaskTemplate(a));
        }
        if (a.project_id) out.project_id = getProject(app, locationId, String(a.project_id)).id;
        if (a.due_in_days !== undefined && a.due_in_days !== '') out.due_in_days = Math.max(0, Math.min(3650, Math.round(Number(a.due_in_days)) || 0));
        if (a.assignee) out.assignee = String(a.assignee);
        break;
      case 'move_status':
        for (const k of ['status_id', 'status', 'category'] as const) if (a[k]) out[k] = String(a[k]);
        if (!out.status_id && !out.status && !out.category) throw bad(`Aktion ${i + 1}: Status wählen`);
        break;
      case 'assign':
        out.mode = a.mode === 'set' ? 'set' : 'add';
        out.user_id = String(a.user_id ?? '');
        if (!out.user_id) throw bad(`Aktion ${i + 1}: Person wählen`);
        break;
      case 'set_priority':
        out.priority = Number(a.priority);
        if (!Number.isFinite(out.priority) || out.priority < 0 || out.priority > 4) throw bad(`Aktion ${i + 1}: Priorität 0–4`);
        break;
      case 'add_tag':
        out.tag = str(a.tag, 'Tag', { required: true, max: 40 });
        break;
      case 'notify':
        out.who = String(a.who ?? 'assignees');
        out.message = str(a.message, 'Text', { max: 300 });
        break;
    }
    return out;
  });
}

function cleanRule(app: App, locationId: string, b: any, cur?: AutomationRow) {
  const out: Record<string, any> = {};
  if (b.name !== undefined || !cur) out.name = str(b.name, 'Name', { required: true, max: 120 });
  if (b.trigger !== undefined || !cur) {
    if (!(String(b.trigger) in TRIGGERS)) throw bad('Auslöser: Status geändert, erledigt, überfällig, angelegt oder zugewiesen');
    out.trigger = String(b.trigger);
  }
  if (b.project_id !== undefined) out.project_id = b.project_id ? getProject(app, locationId, String(b.project_id)).id : null;
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.conditions !== undefined) out.conditions = cleanConditions(b.conditions);
  if (b.actions !== undefined || !cur) out.actions = cleanActions(app, locationId, b.actions);
  return out;
}

export function listAutomations(app: App, locationId: string, projectId?: string): AutomationRow[] {
  return app.db.all<any>(`SELECT * FROM pm_automations WHERE location_id = ? ${projectId ? 'AND (project_id = ? OR project_id IS NULL)' : ''} ORDER BY created_at`, locationId, ...(projectId ? [projectId] : [])).map(outRow);
}

export function createAutomation(app: App, locationId: string, b: any, actor: Actor): AutomationRow {
  const f = cleanRule(app, locationId, b);
  const row = { id: newId(), location_id: locationId, project_id: null, enabled: 1, conditions: {}, runs: 0, created_by: actor.id, created_at: now(), updated_at: now(), ...f };
  app.db.insert('pm_automations', row);
  return outRow(app.db.get('SELECT * FROM pm_automations WHERE id = ?', row.id));
}

export function updateAutomation(app: App, locationId: string, id: string, b: any): AutomationRow {
  const cur = app.db.get<any>('SELECT * FROM pm_automations WHERE id = ? AND location_id = ?', id, locationId);
  if (!cur) throw notFound('Automation nicht gefunden');
  const f = cleanRule(app, locationId, b, outRow(cur));
  if (Object.keys(f).length) app.db.update('pm_automations', cur.id, { ...f, updated_at: now() });
  return outRow(app.db.get('SELECT * FROM pm_automations WHERE id = ?', cur.id));
}

export function deleteAutomation(app: App, locationId: string, id: string) {
  if (!app.db.run('DELETE FROM pm_automations WHERE id = ? AND location_id = ?', id, locationId).changes) throw notFound('Automation nicht gefunden');
  return { ok: true };
}

/** Does a task event satisfy the rule's conditions? */
export function matches(cond: Record<string, any>, task: TaskOut, ev: { to?: { id?: string; category?: string } | null; from?: { id?: string } | null; userIds?: string[] }): boolean {
  if (cond.status_id && cond.status_id !== (ev.to?.id ?? task.status_id)) return false;
  if (cond.to_category && cond.to_category !== (ev.to?.category ?? task.status?.category)) return false;
  if (cond.from_status_id && cond.from_status_id !== ev.from?.id) return false;
  if (cond.priority_min !== undefined && task.priority < cond.priority_min) return false;
  if (cond.tag && !task.tags.some((t) => t.toLowerCase() === String(cond.tag).toLowerCase())) return false;
  if (cond.assignee && !(ev.userIds ?? task.assignees.map((a) => a.id)).includes(cond.assignee)) return false;
  if (cond.title_contains && !task.title.toLowerCase().includes(String(cond.title_contains).toLowerCase())) return false;
  if (cond.section_id && cond.section_id !== task.section_id) return false;
  return true;
}

function runActions(app: App, locationId: string, rule: AutomationRow, task: TaskOut, depth: number, chain: string[]) {
  const actor: Actor = { ...SYSTEM, name: `Automation: ${rule.name}` };
  const opts = { automationDepth: depth + 1, automationChain: [...chain, rule.id] };
  const tz = tzOf(app, locationId);
  let current = task;
  for (const a of rule.actions) {
    switch (a.type) {
      case 'create_task': {
        let data: TaskTemplateData = { title: String(a.title ?? 'Aufgabe'), description: a.description, priority: a.priority, tags: a.tags, estimate_minutes: a.estimate_minutes, due_in_days: a.due_in_days, checklist: a.checklist, subtasks: a.subtasks };
        if (a.template_id) {
          const row = app.db.get<any>(`SELECT data FROM pm_templates WHERE id = ? AND location_id = ? AND kind = 'task'`, a.template_id, locationId);
          if (!row) throw new Error('Aufgabenvorlage nicht mehr vorhanden');
          data = { ...json<TaskTemplateData>(row.data, { title: 'Aufgabe' }), ...(a.due_in_days !== undefined ? { due_in_days: a.due_in_days } : {}) };
        }
        // "{{title}}" in the text refers to the task that triggered the rule.
        const fill = (s?: string) => (s ? s.replace(/\{\{\s*title\s*\}\}/g, task.title) : s);
        const body = taskFromTemplate(app, locationId, { ...data, title: fill(data.title)!, description: fill(data.description) }, tz, { project_id: a.project_id ?? task.project_id, contact_id: task.contact_id ?? undefined });
        const who = a.assignee ?? data.assignee;
        const assignees = who === 'same' ? task.assignees.map((p) => p.id) : who && who !== 'none' ? [who === 'creator' ? task.created_by : who].filter(Boolean) : undefined;
        createTask(app, locationId, { ...body, assignees: assignees?.filter((u) => team(app, locationId).some((p) => p.id === u)) }, actor, opts);
        break;
      }
      case 'move_status': {
        const statuses = statusesOf(app, current.project_id!);
        const target = resolveStatus(statuses, a);
        if (target && target.id !== current.status_id) current = updateTask(app, locationId, current.id, { status_id: target.id }, actor, opts);
        break;
      }
      case 'assign': {
        const u = a.user_id === 'creator' ? current.created_by : a.user_id;
        if (!u || !team(app, locationId).some((p) => p.id === u)) throw new Error('Person nicht gefunden');
        current = updateTask(app, locationId, current.id, a.mode === 'set' ? { assignees: [u] } : { add_assignees: [u] }, actor, opts);
        break;
      }
      case 'set_priority':
        current = updateTask(app, locationId, current.id, { priority: a.priority }, actor, opts);
        break;
      case 'add_tag':
        current = updateTask(app, locationId, current.id, { tags: [...current.tags, a.tag] }, actor, opts);
        break;
      case 'notify': {
        const ids = a.who === 'watchers' ? current.watchers : a.who === 'assignees' ? current.assignees.map((p) => p.id) : [a.who];
        for (const u of ids) notifyUser(app, { locationId, userId: u, kind: 'status', title: a.message || `Automation „${rule.name}“: ${current.title}`, body: current.title, taskId: current.id, projectId: current.project_id, ref: `auto:${rule.id}:${current.id}:${u}:${now().slice(0, 16)}` });
        break;
      }
    }
  }
}

/** Runs every enabled rule for the event that matches; returns how many fired. */
export function runAutomations(app: App, locationId: string, trigger: string, data: Record<string, any>): number {
  const depth = Number(data.automationDepth ?? 0);
  if (depth >= MAX_DEPTH) return 0;
  const chain: string[] = Array.isArray(data.automationChain) ? data.automationChain : [];
  const taskId: string | undefined = data.task?.id;
  if (!taskId) return 0;
  const exists = app.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ? AND location_id = ?', taskId, locationId);
  if (!exists) return 0;
  const task = decorate(app, locationId, [exists])[0];
  const rules = app.db.all<any>(`SELECT * FROM pm_automations WHERE location_id = ? AND trigger = ? AND enabled = 1 AND (project_id IS NULL OR project_id = ?) ORDER BY created_at`, locationId, trigger, task.project_id).map(outRow);
  let fired = 0;
  for (const rule of rules) {
    if (chain.includes(rule.id) || !matches(rule.conditions, task, { to: data.to, from: data.from, userIds: data.userIds })) continue;
    let error: string | null = null;
    try {
      runActions(app, locationId, rule, getTask(app, locationId, taskId), depth, chain);
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    fired++;
    app.db.run('UPDATE pm_automations SET runs = runs + 1, last_run_at = ?, last_error = ? WHERE id = ?', now(), error, rule.id);
    app.services.audit?.({ action: 'pm.automation.run', actor: `Automation: ${rule.name}`, locationId, entityId: taskId, summary: `${TRIGGERS[trigger]} → ${task.title}${error ? ` (Fehler: ${error})` : ''}`, userId: null });
  }
  return fired;
}

// --- scans (run from the scheduler) -------------------------------------------------------------------

/** Overdue tasks: announced once per due date (event for rules/workflows, notification for the people involved). */
export function scanOverdue(app: App, at = new Date()): number {
  const { db } = app;
  let n = 0;
  const locs = new Map<string, string>();
  const rows = db.all<TaskRow>(`SELECT * FROM tasks WHERE done = 0 AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at LIMIT 2000`, new Date(at.getTime() + 36 * 3600_000).toISOString());
  for (const r of rows) {
    const tz = locs.get(r.location_id) ?? (locs.set(r.location_id, tzOf(app, r.location_id)), locs.get(r.location_id)!);
    const day = dayOf(r.due_at, tz)!;
    const overdue = /T00:00:00(\.000)?Z$/.test(r.due_at!) ? day < todayIn(tz, at) : Date.parse(r.due_at!) < at.getTime();
    if (!overdue) continue;
    const key = `overdue:${r.id}:${r.due_at}`;
    if (db.run('INSERT OR IGNORE INTO pm_seen (key, at) VALUES (?, ?)', key, now()).changes === 0) continue;
    n++;
    const t = decorate(app, r.location_id, [r])[0];
    app.events.emit(r.location_id, 'task.overdue', { contactId: t.contact_id ?? undefined, task: t, projectId: t.project_id, automationDepth: 0, automationChain: [] });
    for (const u of new Set([...t.assignees.map((a) => a.id), ...t.watchers])) {
      notifyUser(app, { locationId: r.location_id, userId: u, kind: 'overdue', title: `Überfällig: ${t.title}`, body: `Fällig war ${day.split('-').reverse().join('.')}`, taskId: t.id, projectId: t.project_id, ref: `overdue:${t.id}:${t.due_at}:${u}`, });
    }
  }
  db.run('DELETE FROM pm_seen WHERE at < ?', new Date(at.getTime() - 90 * 864e5).toISOString());
  return n;
}

/** "Heute fällig" in the notification list (and a push for everyone but the first assignee, whom the push module covers). */
export function scanDueToday(app: App, at = new Date()): number {
  const { db } = app;
  let n = 0;
  for (const loc of db.all<{ id: string; timezone: string }>('SELECT id, timezone FROM locations')) {
    const tz = loc.timezone || 'Europe/Berlin';
    const hm = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    if (hm < '08:00') continue;
    const today = todayIn(tz, at);
    const rows = db.all<TaskRow>(`SELECT * FROM tasks WHERE location_id = ? AND done = 0 AND due_at IS NOT NULL AND due_at BETWEEN ? AND ? LIMIT 1000`, loc.id, new Date(at.getTime() - 2 * 864e5).toISOString(), new Date(at.getTime() + 2 * 864e5).toISOString());
    for (const r of rows.filter((x) => dayOf(x.due_at, tz) === today)) {
      const t = decorate(app, loc.id, [r])[0];
      for (const u of new Set([...t.assignees.map((a) => a.id), ...t.watchers])) {
        if (notifyUser(app, { locationId: loc.id, userId: u, kind: 'due', title: `Heute fällig: ${t.title}`, body: t.project?.name ?? '', taskId: t.id, projectId: t.project_id, ref: `due:${t.id}:${today}:${u}`, quiet: u === t.assigned_to })) n++;
      }
    }
  }
  return n;
}
