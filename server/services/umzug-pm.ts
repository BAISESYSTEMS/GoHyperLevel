import type { App } from '../core/app.js';
import { id, now } from '../core/util.js';
import type { RPmTask, RProject, RProjectField } from './umzug-core.js';
import type { ExtraEnv, Host, UndoHelpers } from './umzug-extra.js';
import { addField, addSection, addStatus, createProject } from './pm-projects.js';
import { cleanCustom, insertStatuses, statusesOf, team, type Actor, type StatusCategory } from './pm-core.js';
import { createTask } from './pm-tasks.js';
import { clip } from './umzug-text.js';

/**
 * Projects and tasks of the switch-over importers (monday.com boards, ClickUp lists, Notion databases): a project with the statuses,
 * sections and custom fields of the old board, and its tasks through the planner's own createTask (quiet: no events, no
 * notifications, so an import never starts an automation or pings the team). Re-runs are idempotent through the id map; a task a
 * person has changed since the import stays as they left it (the stamp of the last write is kept in the id map).
 */

const RANK: Record<StatusCategory, number> = { todo: 0, active: 1, done: 2 };
const CATEGORY_OK = (c: unknown): c is StatusCategory => c === 'todo' || c === 'active' || c === 'done';
const MAX_STATUSES = 20;

export class PmWriter {
  private readonly app: App;
  private readonly db: App['db'];
  private readonly loc: string;
  private hasPm: boolean | undefined;
  private people: { id: string; email: string }[] | undefined;
  private readonly actor: Actor;
  private readonly missingProject = new Set<string>();

  constructor(
    private env: ExtraEnv,
    private host: Host,
  ) {
    this.app = env.app;
    this.db = env.app.db;
    this.loc = env.locationId;
    this.actor = { id: null, name: `Umzug (${env.label})`, via: 'import' };
  }

  private available(): boolean {
    if (this.hasPm === undefined) this.hasPm = !!this.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pm_projects'");
    return this.hasPm;
  }

  /** Team members by lower-case e-mail (the old tool's people are matched to them; everybody else is noted in the description). */
  private match(email?: string): string | undefined {
    if (!email) return undefined;
    this.people ??= team(this.app, this.loc).map((p) => ({ id: p.id, email: p.email.toLowerCase() }));
    return this.people.find((p) => p.email === email.trim().toLowerCase())?.id;
  }

  // --- projects ---------------------------------------------------------------------------------------------------

  /** The statuses of the old board in a usable order (todo, then active, then done); a project needs a todo and a done status. */
  private statuses(rec: RProject): { name: string; category: StatusCategory; color?: string }[] {
    const seen = new Set<string>();
    const list: { name: string; category: StatusCategory; color?: string }[] = [];
    for (const s of rec.statuses ?? []) {
      const name = clip(s.name, 60).trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      list.push({ name, category: CATEGORY_OK(s.category) ? s.category : 'active', color: s.color && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : undefined });
    }
    if (!list.some((s) => s.category === 'todo')) list.unshift({ name: seen.has('offen') ? 'Zu erledigen' : 'Offen', category: 'todo', color: '#94a3b8' });
    if (!list.some((s) => s.category === 'done')) list.push({ name: seen.has('erledigt') ? 'Abgeschlossen' : 'Erledigt', category: 'done', color: '#10b981' });
    const sorted = list.map((s, i) => ({ s, i })).sort((a, b) => RANK[a.s.category] - RANK[b.s.category] || a.i - b.i).map((x) => x.s);
    if (sorted.length > MAX_STATUSES) {
      this.env.warn(`Projekt „${clip(rec.name, 60)}“: mehr als ${MAX_STATUSES} Status – die übrigen sind zusammengelegt`);
      // Keep every todo and done status, trim the active ones.
      const must = sorted.filter((s) => s.category !== 'active');
      const room = Math.max(0, MAX_STATUSES - must.length);
      const keep = new Set([...must, ...sorted.filter((s) => s.category === 'active').slice(0, room)]);
      return sorted.filter((s) => keep.has(s));
    }
    return sorted;
  }

  project(rec: RProject) {
    const known = this.host.getId('project', rec.ext);
    if (this.env.dry) {
      this.host.stat('projects', known ? 'updated' : 'created');
      if (rec.fields?.length) this.host.stat('project_fields', 'created', known ? 0 : rec.fields.length);
      this.host.virtual.add(`project:${rec.ext}`);
      return;
    }
    if (!this.available()) {
      this.host.stat('projects', 'skipped');
      return void this.env.warn(`Projekt „${clip(rec.name, 60)}“ nicht angelegt: die Projektverwaltung ist in dieser Installation nicht verfügbar`);
    }
    const existing = known ? this.db.get<{ id: string }>('SELECT id FROM pm_projects WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    let pid: string;
    if (existing) {
      pid = existing.id;
      // A re-run adds what is new (a status, a group, a field) and leaves everything else as people made it.
      const have = new Set(statusesOf(this.app, pid).map((s) => s.name.toLowerCase()));
      for (const s of this.statuses(rec).filter((x) => !have.has(x.name.toLowerCase()))) {
        try {
          addStatus(this.app, this.loc, pid, s);
        } catch {
          /* the project is full or has that status under another spelling */
        }
      }
      this.host.stat('projects', 'updated');
    } else {
      const p = createProject(this.app, this.loc, { name: clip(rec.name, 120) || 'Projekt', description: clip(rec.description, 20_000), color: rec.color && /^#[0-9a-f]{6}$/i.test(rec.color) ? rec.color : undefined, billable: false }, this.actor);
      pid = p.id;
      // The board's own statuses replace the default ones (a new project has no tasks yet).
      this.db.run('DELETE FROM pm_statuses WHERE project_id = ?', pid);
      insertStatuses(this.app, this.loc, pid, this.statuses(rec));
      this.host.setId('project', rec.ext, pid);
      this.host.item('pm_project', pid, rec.ext, true);
      this.host.stat('projects', 'created');
    }
    for (const s of rec.sections ?? []) {
      const sext = `${rec.ext}:${s.ext}`;
      const sk = this.host.getId('pm_section', sext);
      if (sk && this.db.get('SELECT 1 FROM pm_sections WHERE id = ? AND project_id = ?', sk.local, pid)) continue;
      const name = clip(s.name, 120).trim() || 'Gruppe';
      const same = this.db.get<{ id: string }>('SELECT id FROM pm_sections WHERE project_id = ? AND lower(name) = lower(?)', pid, name);
      if (same) {
        this.host.setId('pm_section', sext, same.id);
        continue;
      }
      try {
        const sec = addSection(this.app, this.loc, pid, { name });
        this.host.setId('pm_section', sext, sec.id);
      } catch (e) {
        this.env.warn(`Gruppe „${name.slice(0, 40)}“ in „${clip(rec.name, 40)}“ nicht angelegt: ${(e as Error).message}`);
      }
    }
    const haveKeys = new Set(this.db.all<{ key: string }>('SELECT key FROM pm_custom_fields WHERE location_id = ? AND project_id = ?', this.loc, pid).map((f) => f.key));
    for (const f of (rec.fields ?? []).slice(0, 30)) this.field(pid, f, haveKeys);
  }

  private field(pid: string, f: RProjectField, have: Set<string>) {
    if (have.has(f.key)) return;
    try {
      addField(this.app, this.loc, { project_id: pid, key: f.key, label: clip(f.label, 80), type: f.type, options: f.options ?? [] });
      have.add(f.key);
      this.host.stat('project_fields', 'created');
    } catch (e) {
      this.host.stat('project_fields', 'failed');
      this.env.warn(`Feld „${clip(f.label, 40)}“ nicht angelegt: ${(e as Error).message}`);
    }
  }

  // --- tasks --------------------------------------------------------------------------------------------------------

  task(rec: RPmTask) {
    const known = this.host.getId('pm_task', rec.ext);
    if (this.env.dry) {
      this.host.stat('project_tasks', known ? 'updated' : 'created');
      if (rec.comments?.length) this.host.stat('project_comments', known ? 'updated' : 'created', rec.comments.length);
      return void this.host.virtual.add(`pm_task:${rec.ext}`);
    }
    const proj = this.host.getId('project', rec.project);
    if (!proj || proj.local.startsWith('dry:') || !this.db.get('SELECT 1 FROM pm_projects WHERE id = ? AND location_id = ?', proj.local, this.loc)) {
      this.host.stat('project_tasks', 'skipped');
      if (!this.missingProject.has(rec.project)) {
        this.missingProject.add(rec.project);
        this.env.warn(`Aufgaben übersprungen: das Projekt „${clip(rec.project, 40)}“ ist nicht angelegt`);
      }
      return;
    }
    const project = proj.local;
    const parent = rec.parent ? this.host.getId('pm_task', rec.parent) : undefined;
    if (rec.parent && (!parent || parent.local.startsWith('dry:'))) {
      this.host.stat('project_tasks', 'skipped');
      return void this.env.warn(`Unteraufgabe „${clip(rec.title, 40)}“ übersprungen: die übergeordnete Aufgabe fehlt`);
    }
    const statuses = statusesOf(this.app, project);
    const named = rec.status ? statuses.find((s) => s.name.toLowerCase() === rec.status!.trim().toLowerCase()) : undefined;
    const status = named ?? (rec.done ? statuses.find((s) => s.category === 'done') : undefined);
    const section = rec.section ? this.host.getId('pm_section', `${rec.project}:${rec.section}`) : undefined;
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const a of rec.assignees ?? []) {
      const u = this.match(a.email);
      if (u) {
        if (!matched.includes(u)) matched.push(u);
      } else if (a.name || a.email) unmatched.push(a.name || a.email!);
    }
    const description = this.describe(rec, unmatched);
    const dates = this.dates(rec);
    const custom = this.custom(project, rec);
    const body = {
      project_id: project,
      title: clip(rec.title, 300).trim() || 'Aufgabe',
      description,
      ...(status ? { status_id: status.id } : {}),
      ...(rec.done && !status ? { done: true } : {}),
      section_id: section && !section.local.startsWith('dry:') ? section.local : undefined,
      parent_id: parent?.local,
      priority: rec.priority && rec.priority >= 0 && rec.priority <= 4 ? Math.round(rec.priority) : 0,
      start_at: dates.start,
      due_at: dates.due,
      estimate_minutes: rec.estimate_minutes && rec.estimate_minutes > 0 ? Math.min(1_000_000, Math.round(rec.estimate_minutes)) : undefined,
      tags: (rec.tags ?? []).map((t) => clip(t, 40)).filter(Boolean).slice(0, 20),
      checklists: (rec.checklists ?? []).slice(0, 20).map((c) => ({ title: clip(c.title, 120), items: c.items.slice(0, 100).map((i) => ({ text: clip(i.text, 300), done: !!i.done })) })),
      assignees: matched,
      custom,
    };
    const have = known ? this.db.get<{ id: string; updated_at: string | null }>('SELECT id, updated_at FROM tasks WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    if (have) {
      // A task somebody has touched since the import is theirs now.
      if (known!.extra && have.updated_at !== known!.extra) {
        this.host.stat('project_tasks', 'skipped');
        return;
      }
      this.refresh(have.id, rec, body, status?.id);
      this.host.stat('project_tasks', 'updated');
      this.comments(have.id, rec);
      return;
    }
    const t = createTask(this.app, this.loc, { ...body, section_id: body.section_id }, this.actor, { quiet: true });
    this.stamp(t.id, rec);
    this.host.setId('pm_task', rec.ext, t.id, this.db.get<{ updated_at: string }>('SELECT updated_at FROM tasks WHERE id = ?', t.id)?.updated_at ?? null);
    this.host.item('pm_task', t.id, rec.ext, true);
    this.host.stat('project_tasks', 'created');
    this.comments(t.id, rec);
  }

  /** The original dates of creation and completion (createTask stamps "now"). */
  private stamp(taskId: string, rec: RPmTask) {
    const patch: Record<string, unknown> = {};
    const created = rec.created_at && !Number.isNaN(Date.parse(rec.created_at)) ? new Date(rec.created_at).toISOString() : undefined;
    if (created) patch.created_at = created;
    const row = this.db.get<{ done: number }>('SELECT done FROM tasks WHERE id = ?', taskId);
    if (row?.done) {
      const at = rec.completed_at && !Number.isNaN(Date.parse(rec.completed_at)) ? new Date(rec.completed_at).toISOString() : (created ?? undefined);
      if (at) patch.completed_at = at;
    }
    patch.updated_at = now();
    this.db.update('tasks', taskId, patch, this.loc);
  }

  private refresh(taskId: string, rec: RPmTask, body: any, statusId?: string) {
    const patch: Record<string, unknown> = { title: body.title, description: body.description, priority: body.priority, start_at: null, due_at: null, tags: JSON.stringify(body.tags), updated_at: now() };
    if (body.start_at) patch.start_at = this.iso(body.start_at);
    if (body.due_at) patch.due_at = this.iso(body.due_at);
    if (statusId) {
      patch.status_id = statusId;
      const cat = this.db.get<{ category: string }>('SELECT category FROM pm_statuses WHERE id = ?', statusId)?.category;
      patch.done = cat === 'done' ? 1 : 0;
      if (cat !== 'done') patch.completed_at = null;
      else if (rec.completed_at) patch.completed_at = rec.completed_at;
    }
    if (body.custom && Object.keys(body.custom).length) patch.custom = JSON.stringify(body.custom);
    this.db.update('tasks', taskId, patch, this.loc);
    this.host.setId('pm_task', rec.ext, taskId, this.db.get<{ updated_at: string }>('SELECT updated_at FROM tasks WHERE id = ?', taskId)?.updated_at ?? null);
  }

  private iso(v: string): string | null {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  /** Start must not lie after the due date (the planner refuses that); both are kept as the old tool gave them. */
  private dates(rec: RPmTask): { start?: string; due?: string } {
    const norm = (v?: string) => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : (this.iso(v) ?? undefined)) : undefined);
    const start = norm(rec.start_at);
    const due = norm(rec.due_at);
    if (start && due && start.slice(0, 10) > due.slice(0, 10)) return { due };
    return { start, due };
  }

  private describe(rec: RPmTask, unmatched: string[]): string {
    const foot = [`Aus ${this.env.label} übernommen`, rec.url ? rec.url : '', unmatched.length ? `Zuständig dort: ${unmatched.slice(0, 5).join(', ')}` : ''].filter(Boolean).join(' · ');
    const text = clip(rec.description, 9000).trim();
    return clip(text ? `${text}\n\n${foot}` : foot, 10_000);
  }

  /** Values for the project's custom fields; a value the field cannot hold is left out (never the whole task). */
  private custom(project: string, rec: RPmTask): Record<string, unknown> | undefined {
    if (!rec.custom) return undefined;
    let out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec.custom)) {
      if (v === undefined || v === null || v === '') continue;
      try {
        out = cleanCustom(this.app, this.loc, project, { [k]: v }, out);
      } catch {
        /* a value the field cannot take (a choice that is not in the list …) */
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  private comments(taskId: string, rec: RPmTask) {
    for (const c of rec.comments ?? []) {
      const ext = `${rec.ext}:${c.ext}`;
      const body = clip(c.body, 10_000).trim();
      if (!body) continue;
      if (this.host.getId('pm_comment', ext) && this.db.get('SELECT 1 FROM pm_comments WHERE id = ?', this.host.getId('pm_comment', ext)!.local)) {
        this.host.stat('project_comments', 'updated');
        continue;
      }
      const at = c.at && !Number.isNaN(Date.parse(c.at)) ? new Date(c.at).toISOString() : now();
      const cid = id();
      this.db.insert('pm_comments', { id: cid, location_id: this.loc, task_id: taskId, user_id: null, author_name: clip(c.author || this.env.label, 200), body, mentions: '[]', via: 'import', created_at: at, edited_at: null });
      this.host.setId('pm_comment', ext, cid);
      this.host.stat('project_comments', 'created');
    }
  }
}

// --- undo ---------------------------------------------------------------------------------------------------------

type Item = { kind: string; local_id: string; ext_id: string; created: number };

/** Takes back the tasks and projects an import created, unless people have worked in them since. */
export function undoPm(app: App, loc: string, items: Item[], h: UndoHelpers) {
  const db = app.db;
  const made = new Set(items.filter((i) => i.kind === 'pm_task' && i.created).map((i) => i.local_id));
  if (made.size) {
    const row = (tid: string) => db.get<{ id: string; parent_id: string | null }>('SELECT id, parent_id FROM tasks WHERE id = ? AND location_id = ?', tid, loc);
    const touched = (tid: string): boolean => {
      try {
        return !!(db.get('SELECT 1 FROM pm_time_entries WHERE task_id = ? LIMIT 1', tid) || db.get('SELECT 1 FROM pm_comments WHERE task_id = ? AND user_id IS NOT NULL LIMIT 1', tid) || db.get('SELECT 1 FROM pm_attachments WHERE task_id = ? LIMIT 1', tid) || db.get('SELECT 1 FROM pm_dependencies WHERE task_id = ? OR depends_on = ? LIMIT 1', tid, tid));
      } catch {
        return false;
      }
    };
    const keep = new Set<string>();
    const alive = [...made].filter((t) => row(t));
    for (const tid of alive) {
      // Somebody's own subtask under an imported one would go with it – so the imported one stays.
      const stranger = db.all<{ id: string }>('SELECT id FROM tasks WHERE parent_id = ?', tid).some((c) => !made.has(c.id));
      if (touched(tid) || stranger) keep.add(tid);
    }
    // A task that stays keeps its parents (a subtask cannot live without one).
    for (const tid of [...keep]) for (let cur = row(tid)?.parent_id, n = 0; cur && n < 50; cur = row(cur)?.parent_id, n++) if (made.has(cur)) keep.add(cur);
    let left = alive.filter((t) => !keep.has(t));
    // Leaves first, so every deleted task is counted once (a parent would take its subtasks along).
    while (left.length) {
      const leaves = left.filter((t) => !db.get('SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1', t));
      if (!leaves.length) break;
      for (const t of leaves) if (db.run('DELETE FROM tasks WHERE id = ? AND location_id = ?', t, loc).changes) (h.del('project_tasks'), h.gone.push(t));
      left = left.filter((t) => !leaves.includes(t));
    }
    if (keep.size) {
      h.keep('project_tasks', keep.size);
      h.notes.push('Aufgaben bleiben, weil seit dem Umzug daran gearbeitet wurde (Zeit, Kommentare, Anhänge, Abhängigkeiten oder eigene Unteraufgaben).');
    }
  }
  for (const it of items.filter((i) => i.kind === 'pm_project' && i.created)) {
    if (db.get('SELECT 1 FROM tasks WHERE project_id = ? LIMIT 1', it.local_id)) {
      h.keep('projects');
      h.notes.push('Ein Projekt bleibt, weil darin noch Aufgaben liegen, die nicht aus dem Umzug stammen.');
      continue;
    }
    // Sections, statuses and fields go with it.
    if (db.run('DELETE FROM pm_projects WHERE id = ? AND location_id = ? AND is_default = 0', it.local_id, loc).changes) (h.del('projects'), h.gone.push(it.local_id));
  }
}
