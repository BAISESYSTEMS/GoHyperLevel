import type { Module } from '../core/app.js';
import { bad, str, type Ctx } from '../core/http.js';
import { dayOf, json, statusesOf, todayIn, tzOf } from '../services/pm-core.js';
import { bodyLocation, callRoute, clampInt, marks, ownLocation, scope } from '../services/mobile.js';

/**
 * Planner on the phone (Android app, /api/mobile/pm/*): "Meine Aufgaben" across sub-accounts, status changes,
 * the timer (start/stop/status) and the notification list. Writes relay onto the regular /api/pm routes, so
 * rights, validation, events and the audit log are the same as in the web app.
 */

export const pmMobileModule: Module = {
  name: 'pm-mobile',
  register(app) {
    const { db, router } = app;
    const relay = (ctx: Ctx) => {
      ctx.skipAfterWrite = true;
    };

    const taskOut = (t: any, names: Map<string, string>) => {
      const st = t.status_id ? db.get<any>('SELECT name, category, color FROM pm_statuses WHERE id = ?', t.status_id) : undefined;
      return {
        id: t.id,
        title: t.title,
        description: t.description || '',
        due_at: t.due_at ?? null,
        start_at: t.start_at ?? null,
        done: !!t.done,
        priority: t.priority,
        status: st?.name ?? null,
        status_category: st?.category ?? null,
        status_color: st?.color ?? null,
        project_id: t.project_id,
        project_name: t.project_name ?? '',
        parent_id: t.parent_id ?? null,
        tags: json<string[]>(t.tags, []),
        estimate_minutes: t.estimate_minutes ?? null,
        location_id: t.location_id,
        location_name: names.get(t.location_id) ?? '',
        link: `/app/pm/task/${t.id}`,
      };
    };

    /** The caller's open planner tasks in every sub-account they may read tasks in. */
    router.get('/api/mobile/pm/tasks', 'user', (ctx) => {
      const locs = scope(app, ctx, 'tasks');
      const names = new Map(locs.map((l) => [l.id, l.name]));
      const filter = ctx.query.get('filter') ?? 'open';
      const limit = clampInt(ctx.query.get('limit'), 30, 1, 100);
      const out: any[] = [];
      for (const l of locs) {
        const today = todayIn(tzOf(app, l.id));
        const rows = db.all<any>(
          `SELECT t.*, p.name AS project_name FROM tasks t JOIN pm_assignees a ON a.task_id = t.id AND a.user_id = ? LEFT JOIN pm_projects p ON p.id = t.project_id
           WHERE t.location_id = ? AND t.done = ${filter === 'done' ? 1 : 0} ORDER BY COALESCE(t.due_at, '9999'), t.position LIMIT ?`,
          ctx.user!.id,
          l.id,
          limit,
        );
        for (const r of rows) {
          const d = dayOf(r.due_at, tzOf(app, l.id));
          if (filter === 'today' && d !== today) continue;
          if (filter === 'overdue' && !(d && d < today)) continue;
          out.push(taskOut(r, names));
        }
      }
      out.sort((a, b) => String(a.due_at ?? '9999').localeCompare(String(b.due_at ?? '9999')));
      return out.slice(0, limit);
    });

    router.get('/api/mobile/pm/tasks/:id', 'user', async (ctx) => {
      const loc = ownLocation(app, ctx, 'tasks', ctx.params.id, 'Aufgabe nicht gefunden');
      const r = await callRoute(app, ctx, 'GET', `/api/pm/tasks/${encodeURIComponent(ctx.params.id)}`, { locationId: loc.id });
      return { task: taskOut({ ...r.task, project_name: r.project.name, tags: JSON.stringify(r.task.tags) }, new Map([[loc.id, loc.name]])), statuses: r.statuses.map((s: any) => ({ id: s.id, name: s.name, category: s.category, color: s.color })), subtasks: r.subtasks.map((s: any) => ({ id: s.id, title: s.title, done: s.done })), comments: r.comments.slice(-20).map((c: any) => ({ id: c.id, by: c.author_name, at: c.created_at, text: c.body })) };
    });

    router.post('/api/mobile/pm/tasks/:id/status', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'tasks', ctx.params.id, 'Aufgabe nicht gefunden');
      const b = ctx.body ?? {};
      if (!b.status_id && !b.status && !b.category) throw bad('Status fehlt');
      const t = await callRoute(app, ctx, 'POST', `/api/pm/tasks/${encodeURIComponent(ctx.params.id)}/move`, { locationId: loc.id, body: { status_id: b.status_id, status: b.status, category: b.category } });
      const st = t.status ?? statusesOf(app, t.project_id).find((s) => s.id === t.status_id);
      return { id: t.id, done: t.done, status: st?.name ?? null };
    });

    router.post('/api/mobile/pm/tasks/:id/comments', 'user', async (ctx) => {
      relay(ctx);
      const loc = ownLocation(app, ctx, 'tasks', ctx.params.id, 'Aufgabe nicht gefunden');
      const body = str(ctx.body?.body, 'Kommentar', { required: true, max: 10_000 });
      const c = await callRoute(app, ctx, 'POST', `/api/pm/tasks/${encodeURIComponent(ctx.params.id)}/comments`, { locationId: loc.id, body: { body } });
      return { id: c.id, at: c.created_at };
    });

    // --- timer ---------------------------------------------------------------------------------------
    router.get('/api/mobile/pm/timer', 'user', (ctx) => {
      const r = db.get<any>('SELECT * FROM pm_time_entries WHERE user_id = ? AND ended_at IS NULL', ctx.user!.id);
      if (!r) return { running: null };
      const loc = app.location(r.location_id);
      const t = r.task_id ? db.get<any>('SELECT title FROM tasks WHERE id = ?', r.task_id) : undefined;
      const proj = r.project_id ? db.get<any>('SELECT name FROM pm_projects WHERE id = ?', r.project_id) : undefined;
      return { running: { id: r.id, location_id: r.location_id, location_name: loc?.name ?? '', task_id: r.task_id, task_title: t?.title ?? r.task_title ?? '', project_name: proj?.name ?? '', note: r.note, started_at: r.started_at, billable: !!r.billable } };
    });
    router.post('/api/mobile/pm/timer/start', 'user', async (ctx) => {
      relay(ctx);
      const b = ctx.body ?? {};
      const loc = bodyLocation(app, ctx, b.location_id);
      const r = await callRoute(app, ctx, 'POST', '/api/pm/timer/start', { locationId: loc.id, body: { task_id: b.task_id, project_id: b.project_id, note: b.note } });
      return { id: r.entry.id, started_at: r.entry.started_at, task_title: r.entry.task_title, project_name: r.entry.project_name, stopped_previous: r.stopped ? { seconds: r.stopped.seconds, task_title: r.stopped.task_title } : null, already_running: !!r.already_running };
    });
    router.post('/api/mobile/pm/timer/stop', 'user', async (ctx) => {
      relay(ctx);
      const r = db.get<any>('SELECT location_id FROM pm_time_entries WHERE user_id = ? AND ended_at IS NULL', ctx.user!.id);
      if (!r) throw bad('Es läuft kein Timer');
      const loc = bodyLocation(app, ctx, r.location_id);
      const out = await callRoute(app, ctx, 'POST', '/api/pm/timer/stop', { locationId: loc.id, body: { note: ctx.body?.note } });
      return { seconds: out.entry?.seconds ?? 0, discarded: !!out.discarded, task_title: out.entry?.task_title ?? '' };
    });

    // --- notifications ---------------------------------------------------------------------------------
    router.get('/api/mobile/pm/notifications', 'user', (ctx) => {
      const locs = scope(app, ctx, 'tasks', { strict: false });
      if (!locs.length) return { unread: 0, items: [] };
      const names = new Map(locs.map((l) => [l.id, l.name]));
      const ids = locs.map((l) => l.id);
      const limit = clampInt(ctx.query.get('limit'), 30, 1, 100);
      const items = db.all<any>(`SELECT * FROM pm_notifications WHERE user_id = ? AND location_id IN (${marks(ids.length)}) ORDER BY created_at DESC LIMIT ?`, ctx.user!.id, ...ids, limit);
      const unread = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pm_notifications WHERE user_id = ? AND read_at IS NULL AND location_id IN (${marks(ids.length)})`, ctx.user!.id, ...ids)?.n ?? 0);
      return { unread, items: items.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, task_id: n.task_id, location_id: n.location_id, location_name: names.get(n.location_id) ?? '', read: !!n.read_at, created_at: n.created_at })) };
    });
    router.post('/api/mobile/pm/notifications/read', 'user', (ctx) => {
      const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String).slice(0, 200) : [];
      const r = ctx.body?.all ? db.run('UPDATE pm_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', new Date().toISOString(), ctx.user!.id) : ids.length ? db.run(`UPDATE pm_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${marks(ids.length)})`, new Date().toISOString(), ctx.user!.id, ...ids) : { changes: 0 };
      return { ok: true, updated: r.changes };
    });
  },
};
