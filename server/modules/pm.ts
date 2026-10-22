import { readFileSync } from 'node:fs';
import type { Module } from '../core/app.js';
import { cached } from '../core/cache.js';
import { HttpError, bad, clampLimit, notFound, num, str, ymdParam, type Ctx, type RawResult } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { PM_INIT, PM_TIME } from '../services/pm-schema.js';
import {
  ACTIONS as AUTOMATION_ACTIONS,
  TRIGGERS as AUTOMATION_TRIGGERS,
  createAutomation,
  deleteAutomation,
  deleteTemplate,
  listAutomations,
  listTaskTemplates,
  saveTaskTemplate,
  updateAutomation,
} from '../services/pm-automation.js';
import {
  CATEGORY_LABELS,
  FIELD_TYPES,
  PRIORITY_LABELS,
  actorOf,
  ensureDefaultProject,
  fieldsFor,
  getProject,
  getSettings,
  json,
  saveSettings,
  statusesOf,
  storedPath,
  team,
  tzOf,
  type Actor,
} from '../services/pm-core.js';
import { addComment, addFile, addLink, attachmentFile, deleteAttachment, deleteComment, editComment, listAttachments, listComments, MAX_FILE_BYTES } from '../services/pm-extras.js';
import {
  addField,
  addSection,
  addStatus,
  createProject,
  deleteField,
  deleteProject,
  deleteSection,
  deleteStatus,
  duplicateProject,
  getProjectOut,
  listProjects,
  reorderSections,
  reorderStatuses,
  saveProjectTemplate,
  sectionsOf,
  updateField,
  updateProject,
  updateSection,
  updateStatus,
} from '../services/pm-projects.js';
import { DEP_LABELS, DEP_TYPES } from '../services/pm-schedule.js';
import { BUILTIN_TEMPLATES } from '../services/pm-templates.js';
import {
  addDependency,
  bulkTasks,
  createTask,
  decorate,
  deleteTask,
  getTask,
  listTasks,
  moveTaskDates,
  positionBetween,
  taskRow,
  treeAround,
  updateDependency,
  updateTask,
  type TaskFilter,
  type TaskRow,
} from '../services/pm-tasks.js';
import { MAX_DEPTH } from '../services/pm-tree.js';
import { autoScheduleProject, clearBaseline, ganttOf, myTasks, setBaseline, workloadOf } from '../services/pm-views.js';
import { viewerOf } from '../services/pm-time.js';

/**
 * Project planning (areas "Kontakte & Aufgaben"): projects per sub-account with custom statuses, sections, custom
 * fields; tasks with subtasks, checklists, assignees, watchers, tags, dates, estimates, dependencies, comments,
 * attachments and recurrence – all on the existing `tasks` table. Views: list, board, calendar, Gantt, workload,
 * "Meine Aufgaben", saved views. Time tracking is in pm-time.ts, automations/templates in pm-automation.ts,
 * the customer portal in pm-portal.ts, MCP tools/mobile API in pm-tools.ts / pm-mobile.ts. Contract: docs/projects.md.
 */

const taskFilter = (q: URLSearchParams): TaskFilter => ({
  project_id: q.get('project_id') ?? undefined,
  section_id: q.get('section_id') ?? undefined,
  status_id: q.get('status_id') ?? undefined,
  category: q.get('category') ?? undefined,
  done: q.get('done') ?? undefined,
  assignee: q.get('assignee') ?? undefined,
  watcher: q.get('watcher') ?? undefined,
  priority: q.get('priority') ?? undefined,
  tag: q.get('tag') ?? undefined,
  q: q.get('q') ?? undefined,
  due: q.get('due') ?? undefined,
  from: ymdParam(q.get('from'), 'Von'),
  to: ymdParam(q.get('to'), 'Bis'),
  parent: q.get('parent') ?? undefined,
  contact_id: q.get('contact_id') ?? undefined,
  has_dates: q.get('has_dates') ?? undefined,
  internal: q.get('internal') ?? undefined,
  sort: q.get('sort') ?? undefined,
  dir: q.get('dir') ?? undefined,
  limit: q.get('limit') ? num(q.get('limit')) : undefined,
  offset: q.get('offset') ? num(q.get('offset')) : undefined,
  ids: q.get('ids') ? q.get('ids')!.split(',').filter(Boolean).slice(0, 200) : undefined,
});

export const VIEW_KINDS = ['list', 'board', 'calendar', 'gantt', 'workload'];

export const pmModule: Module = {
  name: 'pm',
  migrations: [
    ['001-init', PM_INIT],
    ['002-time', PM_TIME],
  ],
  register(app) {
    const { db, router } = app;
    const who = (ctx: Ctx): Actor => actorOf(ctx);
    const task = (ctx: Ctx, id = ctx.params.id) => taskRow(app, ctx.locationId, id);

    // The plain task list and every other writer of `tasks` keep working; "Meine Aufgaben" links go to the planner.
    app.services.pm = { getTask: (loc: string, id: string) => getTask(app, loc, id) };

    // The contact's tasks (and their subtasks) go with it – the files attached to them are deleted with it (erase or plain delete).
    app.services.contactFiles = [
      ...(app.services.contactFiles ?? []),
      (_a: unknown, loc: string, cid: string) =>
        db
          .all<{ file: string }>(
            `WITH RECURSIVE sub(id) AS (SELECT id FROM tasks WHERE location_id = ? AND contact_id = ? UNION SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
             SELECT file FROM pm_attachments WHERE location_id = ? AND COALESCE(file, '') != '' AND task_id IN (SELECT id FROM sub)`,
            loc,
            cid,
            loc,
          )
          .map((a) => storedPath(app, a.file)),
    ];

    // Tasks are also a type for associations ("verknüpfen"): open them in the planner and search them by title.
    const assoc = app.services.associations;
    if (assoc) {
      assoc.registerType({
        type: 'task',
        label: 'Aufgabe',
        plural: 'Aufgaben',
        icon: 'tasks',
        table: 'tasks',
        get: (loc: string, rid: string) => {
          const t = db.get('SELECT id, title, due_at, done FROM tasks WHERE id = ? AND location_id = ?', rid, loc);
          return t ? { id: t.id, name: t.title, sub: t.done ? 'erledigt' : t.due_at ? `fällig ${t.due_at.slice(0, 10)}` : 'offen', link: `pm/task/${t.id}` } : undefined;
        },
        search: (loc: string, q: string, limit: number) =>
          db.all('SELECT id, title, done FROM tasks WHERE location_id = ? AND title LIKE ? ORDER BY done, created_at DESC LIMIT ?', loc, `%${q}%`, limit).map((t) => ({ id: t.id, name: t.title, sub: t.done ? 'erledigt' : 'offen' })),
      });
      assoc.registerType({
        type: 'pm_project',
        label: 'Projekt (Planung)',
        plural: 'Projekte (Planung)',
        icon: 'kanban',
        table: 'pm_projects',
        get: (loc: string, rid: string) => {
          const p = db.get('SELECT id, name, status FROM pm_projects WHERE id = ? AND location_id = ?', rid, loc);
          return p ? { id: p.id, name: p.name, sub: p.status, link: `pm/${p.id}` } : undefined;
        },
        search: (loc: string, q: string, limit: number) => db.all('SELECT id, name, status FROM pm_projects WHERE location_id = ? AND name LIKE ? ORDER BY name LIMIT ?', loc, `%${q}%`, limit).map((p) => ({ id: p.id, name: p.name, sub: p.status })),
      });
    }

    // --- meta ---------------------------------------------------------------------------------------
    router.get('/api/pm/meta', 'location', (ctx) => {
      ensureDefaultProject(app, ctx.locationId);
      return {
        team: team(app, ctx.locationId),
        priorities: PRIORITY_LABELS.map((label, value) => ({ value, label })),
        categories: CATEGORY_LABELS,
        dependency_types: DEP_TYPES.map((t) => ({ type: t, label: DEP_LABELS[t] })),
        field_types: FIELD_TYPES,
        views: VIEW_KINDS,
        max_depth: MAX_DEPTH,
        me: viewerOf(ctx),
        settings: getSettings(app, ctx.locationId),
        timezone: tzOf(app, ctx.locationId),
        max_file_bytes: MAX_FILE_BYTES,
        automation: { triggers: AUTOMATION_TRIGGERS, actions: AUTOMATION_ACTIONS },
      };
    });
    router.get('/api/pm/team', 'location', (ctx) => team(app, ctx.locationId));
    router.get('/api/pm/settings', 'location', (ctx) => getSettings(app, ctx.locationId));
    router.put('/api/pm/settings', 'location', (ctx) => {
      if (!viewerOf(ctx).manager) throw bad('Einstellungen ändert nur die Leitung');
      // Rates, rounding and tax end up on invoices: only people with the invoices area may change them.
      const u = ctx.user;
      const money = u && u.role !== 'admin' && u.permissions && !u.permissions.includes('payments');
      if (money && ['default_rate_cents', 'round_up_minutes', 'tax_rate'].some((k) => ctx.body?.[k] !== undefined)) throw new HttpError(403, 'Abrechnungs-Einstellungen ändert nur, wer Zugriff auf „Rechnungen & Produkte“ hat');
      return saveSettings(app, ctx.locationId, ctx.body ?? {});
    });

    // --- projects -----------------------------------------------------------------------------------
    router.get('/api/pm/projects', 'location', (ctx) =>
      cached(app, ctx, 8_000, () => listProjects(app, ctx.locationId, { status: ctx.query.get('status') ?? undefined, contact_id: ctx.query.get('contact_id') ?? undefined, company_id: ctx.query.get('company_id') ?? undefined, q: ctx.query.get('q') ?? undefined })),
    );
    router.post('/api/pm/projects', 'location', (ctx) => createProject(app, ctx.locationId, ctx.body ?? {}, who(ctx)));
    router.get('/api/pm/projects/:id', 'location', (ctx) => {
      const p = getProjectOut(app, ctx.locationId, ctx.params.id);
      return { ...p, statuses: statusesOf(app, p.id), sections: sectionsOf(app, p.id), fields: fieldsFor(app, ctx.locationId, p.id) };
    });
    router.patch('/api/pm/projects/:id', 'location', (ctx) => updateProject(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.delete('/api/pm/projects/:id', 'location', (ctx) => deleteProject(app, ctx.locationId, ctx.params.id, ctx.query.get('tasks') === 'delete' ? 'delete' : 'move', who(ctx)));
    router.post('/api/pm/projects/:id/duplicate', 'location', (ctx) => duplicateProject(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx)));
    router.post('/api/pm/projects/:id/save-template', 'location', (ctx) => saveProjectTemplate(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx)));

    // --- templates (built-in + saved) ---------------------------------------------------------------
    router.get('/api/pm/templates', 'location', (ctx) => ({
      projects: [
        ...BUILTIN_TEMPLATES.map((t) => ({ id: t.key, name: t.name, description: t.description, builtin: true, tasks: t.data.tasks.length, sections: t.data.sections?.length ?? 0 })),
        ...db.all<any>(`SELECT id, name, description, data, created_at FROM pm_templates WHERE location_id = ? AND kind = 'project' ORDER BY name COLLATE NOCASE`, ctx.locationId).map((t) => ({ id: t.id, name: t.name, description: t.description, builtin: false, tasks: json<any>(t.data, {}).tasks?.length ?? 0, sections: json<any>(t.data, {}).sections?.length ?? 0, created_at: t.created_at })),
      ],
      tasks: listTaskTemplates(app, ctx.locationId),
    }));
    router.post('/api/pm/templates', 'location', (ctx) => saveTaskTemplate(app, ctx.locationId, ctx.body ?? {}, who(ctx)));
    router.delete('/api/pm/templates/:id', 'location', (ctx) => deleteTemplate(app, ctx.locationId, ctx.params.id));

    // --- statuses, sections, fields -------------------------------------------------------------------
    router.get('/api/pm/projects/:id/statuses', 'location', (ctx) => statusesOf(app, getProject(app, ctx.locationId, ctx.params.id).id));
    router.post('/api/pm/projects/:id/statuses', 'location', (ctx) => addStatus(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.put('/api/pm/projects/:id/statuses/order', 'location', (ctx) => reorderStatuses(app, ctx.locationId, ctx.params.id, ctx.body?.ids));
    router.patch('/api/pm/statuses/:id', 'location', (ctx) => updateStatus(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.delete('/api/pm/statuses/:id', 'location', (ctx) => deleteStatus(app, ctx.locationId, ctx.params.id, ctx.query.get('move_to') ?? undefined));
    router.get('/api/pm/projects/:id/sections', 'location', (ctx) => sectionsOf(app, getProject(app, ctx.locationId, ctx.params.id).id));
    router.post('/api/pm/projects/:id/sections', 'location', (ctx) => addSection(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.put('/api/pm/projects/:id/sections/order', 'location', (ctx) => reorderSections(app, ctx.locationId, ctx.params.id, ctx.body?.ids));
    router.patch('/api/pm/sections/:id', 'location', (ctx) => updateSection(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.delete('/api/pm/sections/:id', 'location', (ctx) => deleteSection(app, ctx.locationId, ctx.params.id));
    router.get('/api/pm/custom-fields', 'location', (ctx) => fieldsFor(app, ctx.locationId, ctx.query.get('project_id')));
    router.post('/api/pm/custom-fields', 'location', (ctx) => addField(app, ctx.locationId, ctx.body ?? {}));
    router.patch('/api/pm/custom-fields/:id', 'location', (ctx) => updateField(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.delete('/api/pm/custom-fields/:id', 'location', (ctx) => deleteField(app, ctx.locationId, ctx.params.id));

    // --- tasks ----------------------------------------------------------------------------------------
    router.get('/api/pm/tasks', 'location', (ctx) => {
      ensureDefaultProject(app, ctx.locationId);
      const viewer = viewerOf(ctx);
      return cached(app, ctx, 8_000, () => listTasks(app, ctx.locationId, { ...taskFilter(ctx.query), who: ctx }, viewer.id));
    });
    router.post('/api/pm/tasks', 'location', (ctx) => createTask(app, ctx.locationId, ctx.body ?? {}, who(ctx)));
    router.post('/api/pm/tasks/bulk', 'location', (ctx) => bulkTasks(app, ctx.locationId, ctx.body ?? {}, who(ctx)));
    router.get('/api/pm/tasks/:id', 'location', (ctx) => {
      const t = getTask(app, ctx.locationId, ctx.params.id);
      const kids = db.all<TaskRow>('SELECT * FROM tasks WHERE parent_id = ? AND location_id = ? ORDER BY position, created_at', t.id, ctx.locationId);
      const tree = treeAround(app, ctx.locationId, [t.id]);
      const trail: { id: string; title: string }[] = [];
      for (let p = tree.get(t.id); p && trail.length < 8; p = tree.get(p)) {
        const r = db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ?', p);
        trail.unshift({ id: p, title: r?.title ?? '' });
      }
      const project = getProjectOut(app, ctx.locationId, t.project_id!);
      return {
        task: t,
        subtasks: decorate(app, ctx.locationId, kids),
        trail,
        comments: listComments(app, ctx.locationId, t.id),
        attachments: listAttachments(app, ctx.locationId, t.id),
        dependencies: dependencyList(ctx.locationId, t.id),
        activity: db.all<any>('SELECT id, user_id, user_name, kind, data, created_at FROM pm_activity WHERE task_id = ? ORDER BY id DESC LIMIT 100', t.id).map((a) => ({ ...a, data: json(a.data, {}) })),
        project: { id: project.id, name: project.name, color: project.color, skip_weekends: project.skip_weekends, billable: project.billable },
        statuses: statusesOf(app, t.project_id!),
        sections: sectionsOf(app, t.project_id!),
        fields: fieldsFor(app, ctx.locationId, t.project_id),
      };
    });
    router.patch('/api/pm/tasks/:id', 'location', (ctx) => updateTask(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx)));
    router.delete('/api/pm/tasks/:id', 'location', (ctx) => deleteTask(app, ctx.locationId, ctx.params.id, who(ctx)));
    router.patch('/api/pm/tasks/:id/dates', 'location', (ctx) => moveTaskDates(app, ctx.locationId, ctx.params.id, { start: ctx.body?.start, due: ctx.body?.due, cascade: ctx.body?.cascade !== false }, who(ctx)));
    /** Drag and drop: new status / section and place between two tasks. */
    router.post('/api/pm/tasks/:id/move', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const patch: Record<string, any> = {};
      for (const k of ['status_id', 'status', 'category', 'section_id', 'project_id'] as const) if (b[k] !== undefined) patch[k] = b[k];
      const pos = positionBetween(app, ctx.locationId, b.before_id, b.after_id);
      if (pos !== undefined) patch.position = pos;
      return updateTask(app, ctx.locationId, ctx.params.id, patch, who(ctx));
    });
    router.post('/api/pm/tasks/:id/duplicate', 'location', (ctx) => {
      const src = task(ctx);
      const copy = (s: TaskRow, parent: string | null, top: boolean): string => {
        const made = createTask(
          app,
          ctx.locationId,
          {
            title: top ? str(ctx.body?.title, 'Titel', { max: 300 }) || `${s.title} (Kopie)` : s.title,
            description: s.description,
            project_id: s.project_id,
            parent_id: parent ?? s.parent_id ?? undefined,
            section_id: s.section_id,
            contact_id: s.contact_id,
            priority: s.priority,
            estimate_minutes: s.estimate_minutes,
            tags: json<string[]>(s.tags, []),
            custom: json<Record<string, any>>(s.custom, {}),
            checklists: json<any[]>(s.checklists, []).map((c) => ({ title: c.title, items: (c.items ?? []).map((i: any) => ({ text: i.text })) })),
            internal: !!s.internal,
            milestone: !!s.milestone,
            start_at: s.start_at,
            due_at: s.due_at,
            assignees: db.all<{ user_id: string }>('SELECT user_id FROM pm_assignees WHERE task_id = ?', s.id).map((r) => r.user_id),
          },
          who(ctx),
          { quiet: !top },
        );
        if (ctx.body?.with_subtasks !== false) for (const k of db.all<TaskRow>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY position', s.id)) copy(k, made.id, false);
        return made.id;
      };
      return getTask(app, ctx.locationId, copy(src, null, true));
    });
    router.post('/api/pm/tasks/:id/watch', 'location', (ctx) => {
      const t = task(ctx);
      const uid = ctx.body?.user_id ? String(ctx.body.user_id) : who(ctx).id;
      if (!uid) throw bad('Nutzer angeben');
      if (!team(app, ctx.locationId).some((p) => p.id === uid)) throw bad('Nutzer nicht gefunden');
      db.run('INSERT OR IGNORE INTO pm_watchers (task_id, user_id, created_at) VALUES (?, ?, ?)', t.id, uid, now());
      return getTask(app, ctx.locationId, t.id);
    });
    router.delete('/api/pm/tasks/:id/watch', 'location', (ctx) => {
      const t = task(ctx);
      const uid = ctx.query.get('user_id') ?? who(ctx).id;
      if (uid) db.run('DELETE FROM pm_watchers WHERE task_id = ? AND user_id = ?', t.id, uid);
      return getTask(app, ctx.locationId, t.id);
    });

    // --- comments, attachments, dependencies, activity ----------------------------------------------
    router.get('/api/pm/tasks/:id/comments', 'location', (ctx) => listComments(app, ctx.locationId, ctx.params.id));
    router.post('/api/pm/tasks/:id/comments', 'location', (ctx) => addComment(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx)));
    router.patch('/api/pm/comments/:id', 'location', (ctx) => editComment(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx), viewerOf(ctx).manager));
    router.delete('/api/pm/comments/:id', 'location', (ctx) => deleteComment(app, ctx.locationId, ctx.params.id, who(ctx), viewerOf(ctx).manager));
    router.get('/api/pm/tasks/:id/attachments', 'location', (ctx) => listAttachments(app, ctx.locationId, ctx.params.id));
    router.post('/api/pm/tasks/:id/attachments', 'location', (ctx) => addLink(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx)));
    router.post('/api/pm/tasks/:id/attachments/file', 'location', (ctx) => addFile(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx)));
    router.get('/api/pm/attachments/:id/file', 'location', (ctx): RawResult => {
      const f = attachmentFile(app, ctx.locationId, ctx.params.id);
      const image = /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': f.mime,
          'content-disposition': `${image ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.name)}"`,
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, max-age=300',
        },
        body: readFileSync(f.path),
      };
    });
    router.delete('/api/pm/attachments/:id', 'location', (ctx) => deleteAttachment(app, ctx.locationId, ctx.params.id));

    const dependencyList = (loc: string, taskId: string) => {
      const rows = db.all<any>(
        `SELECT d.id, d.type, d.lag, d.task_id, d.depends_on, p.title AS on_title, p.done AS on_done, p.start_at AS on_start, p.due_at AS on_due, s.title AS task_title, s.done AS task_done, s.start_at AS task_start, s.due_at AS task_due
         FROM pm_dependencies d JOIN tasks p ON p.id = d.depends_on JOIN tasks s ON s.id = d.task_id
         WHERE d.location_id = ? AND (d.task_id = ? OR d.depends_on = ?)`,
        loc,
        taskId,
        taskId,
      );
      return {
        blocked_by: rows.filter((r) => r.task_id === taskId).map((r) => ({ id: r.id, task_id: r.depends_on, title: r.on_title, done: !!r.on_done, type: r.type, lag: r.lag, start_at: r.on_start, due_at: r.on_due })),
        blocking: rows.filter((r) => r.depends_on === taskId).map((r) => ({ id: r.id, task_id: r.task_id, title: r.task_title, done: !!r.task_done, type: r.type, lag: r.lag, start_at: r.task_start, due_at: r.task_due })),
      };
    };
    router.get('/api/pm/tasks/:id/dependencies', 'location', (ctx) => dependencyList(ctx.locationId, task(ctx).id));
    router.post('/api/pm/tasks/:id/dependencies', 'location', (ctx) => {
      addDependency(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, who(ctx));
      return dependencyList(ctx.locationId, ctx.params.id);
    });
    router.patch('/api/pm/dependencies/:id', 'location', (ctx) => updateDependency(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.delete('/api/pm/dependencies/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM pm_dependencies WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Abhängigkeit nicht gefunden');
      return { ok: true };
    });
    router.get('/api/pm/tasks/:id/activity', 'location', (ctx) => {
      task(ctx);
      return db.all<any>('SELECT id, user_id, user_name, kind, data, created_at FROM pm_activity WHERE task_id = ? ORDER BY id DESC LIMIT ?', ctx.params.id, clampLimit(ctx.query.get('limit'), 50, 300)).map((a) => ({ ...a, data: json(a.data, {}) }));
    });

    // --- views ----------------------------------------------------------------------------------------
    router.get('/api/pm/projects/:id/gantt', 'location', (ctx) => cached(app, ctx, 8_000, () => ganttOf(app, ctx.locationId, ctx.params.id, ctx)));
    router.post('/api/pm/projects/:id/baseline', 'location', (ctx) => setBaseline(app, ctx.locationId, ctx.params.id));
    router.delete('/api/pm/projects/:id/baseline', 'location', (ctx) => clearBaseline(app, ctx.locationId, ctx.params.id));
    router.post('/api/pm/projects/:id/auto-schedule', 'location', (ctx) => autoScheduleProject(app, ctx.locationId, ctx.params.id, who(ctx), ctx.body?.dry_run === true));
    router.get('/api/pm/workload', 'location', (ctx) => cached(app, ctx, 8_000, () => workloadOf(app, ctx.locationId, { from: ctx.query.get('from') ?? undefined, to: ctx.query.get('to') ?? undefined, project_id: ctx.query.get('project_id') ?? undefined, who: ctx })));
    router.get('/api/pm/my-tasks', 'location', (ctx) => {
      // A key has no person of its own: `user_id` names whose tasks to show (the leadership may ask for anyone).
      const wanted = ctx.query.get('user_id');
      const viewer = viewerOf(ctx);
      const me = wanted && (viewer.manager || wanted === viewer.id) && team(app, ctx.locationId).some((p) => p.id === wanted) ? wanted : who(ctx).id;
      if (!me) throw bad('„Meine Aufgaben“ gibt es nur mit persönlicher Anmeldung (oder user_id angeben)');
      ensureDefaultProject(app, ctx.locationId);
      return myTasks(app, ctx.locationId, me, { include_watching: ctx.query.get('watching') === '1' });
    });

    // saved views: personal or shared with the team
    const viewOut = (v: any) => ({ ...v, shared: !!v.shared, config: json(v.config, {}) });
    router.get('/api/pm/views', 'location', (ctx) => {
      const me = who(ctx).id ?? '';
      const pid = ctx.query.get('project_id');
      return db
        .all<any>(`SELECT * FROM pm_views WHERE location_id = ? AND (shared = 1 OR user_id = ?) AND (project_id IS NULL OR project_id IS ?) ORDER BY position, name COLLATE NOCASE`, ctx.locationId, me, pid)
        .map(viewOut);
    });
    router.post('/api/pm/views', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const kind = VIEW_KINDS.includes(b.kind) ? b.kind : 'list';
      const config = b.config && typeof b.config === 'object' && !Array.isArray(b.config) ? b.config : {};
      if (JSON.stringify(config).length > 8000) throw bad('Ansicht ist zu groß');
      const projectId = b.project_id ? getProject(app, ctx.locationId, String(b.project_id)).id : null;
      const me = who(ctx).id;
      const row = { id: newId(), location_id: ctx.locationId, project_id: projectId, user_id: me, name: str(b.name, 'Name', { required: true, max: 80 }), kind, config, shared: b.shared && viewerOf(ctx).manager ? 1 : 0, position: 0, created_at: now(), updated_at: now() };
      db.insert('pm_views', row);
      return viewOut({ ...row, config: JSON.stringify(config) });
    });
    router.patch('/api/pm/views/:id', 'location', (ctx) => {
      const v = db.get<any>('SELECT * FROM pm_views WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v) throw notFound('Ansicht nicht gefunden');
      const viewer = viewerOf(ctx);
      if (v.user_id !== viewer.id && !viewer.manager) throw bad('Nur eigene Ansichten ändern');
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 80 });
      if (b.config !== undefined && b.config && typeof b.config === 'object' && JSON.stringify(b.config).length <= 8000) patch.config = b.config;
      if (b.shared !== undefined && viewer.manager) patch.shared = b.shared ? 1 : 0;
      db.update('pm_views', v.id, patch);
      return viewOut(db.get('SELECT * FROM pm_views WHERE id = ?', v.id));
    });
    router.delete('/api/pm/views/:id', 'location', (ctx) => {
      const v = db.get<any>('SELECT * FROM pm_views WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v) throw notFound('Ansicht nicht gefunden');
      const viewer = viewerOf(ctx);
      if (v.user_id !== viewer.id && !viewer.manager) throw bad('Nur eigene Ansichten löschen');
      db.run('DELETE FROM pm_views WHERE id = ?', v.id);
      return { ok: true };
    });

    // --- notifications (mentions, assignments, due dates …) --------------------------------------------
    router.get('/api/pm/notifications', 'location', (ctx) => {
      const me = who(ctx).id;
      if (!me) return { unread: 0, items: [] };
      const unreadOnly = ctx.query.get('unread') === '1';
      const items = db.all<any>(`SELECT * FROM pm_notifications WHERE user_id = ? AND location_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`, me, ctx.locationId, clampLimit(ctx.query.get('limit'), 30, 100));
      const unread = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM pm_notifications WHERE user_id = ? AND location_id = ? AND read_at IS NULL', me, ctx.locationId)?.n ?? 0);
      return { unread, items };
    });
    router.post('/api/pm/notifications/read', 'location', (ctx) => {
      const me = who(ctx).id;
      if (!me) return { ok: true, updated: 0 };
      const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String).slice(0, 200) : [];
      const r = ctx.body?.all ? db.run('UPDATE pm_notifications SET read_at = ? WHERE user_id = ? AND location_id = ? AND read_at IS NULL', now(), me, ctx.locationId) : ids.length ? db.run(`UPDATE pm_notifications SET read_at = ? WHERE user_id = ? AND location_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, now(), me, ctx.locationId, ...ids) : { changes: 0 };
      return { ok: true, updated: r.changes };
    });

    // --- automations ------------------------------------------------------------------------------------
    router.get('/api/pm/automations', 'location', (ctx) => listAutomations(app, ctx.locationId, ctx.query.get('project_id') ?? undefined));
    router.post('/api/pm/automations', 'location', (ctx) => createAutomation(app, ctx.locationId, ctx.body ?? {}, who(ctx)));
    router.patch('/api/pm/automations/:id', 'location', (ctx) => updateAutomation(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    router.delete('/api/pm/automations/:id', 'location', (ctx) => deleteAutomation(app, ctx.locationId, ctx.params.id));
  },
};
