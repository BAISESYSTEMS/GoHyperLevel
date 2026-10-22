import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { HQ_TEMPLATE, type BuiltinTemplate, type TemplateExtras } from '../services/hq-template.js';
import { packWidgets } from '../services/report-templates.js';
import { callRoute } from '../services/route-call.js';
import { applySnapshot, snapshotSummary, validateSnapshot } from '../services/snapshots.js';

/**
 * Built-in templates („Vorlagen von HyperLevel“): ready-made snapshots that ship with the app and load into a sub-account in
 * one click – the first one is „Software- & SaaS-Firma (HQ)“ (services/hq-template.ts, docs/company-playbook.md).
 *
 * The snapshot part goes through applySnapshot (one transaction, new ids, workflows as drafts unless asked otherwise); the
 * extras snapshots do not carry (helpdesk settings, help-center skeleton, dashboard, recurring routines) go through the
 * normal API routes with the caller's rights via callRoute, so the same checks apply as for a click in the app. An extra
 * that fails (an area outside the sub-account's plan, say) is reported as a warning and does not undo the rest.
 *
 * Other modules add templates to `app.services.builtinTemplates` (a list of BuiltinTemplate).
 */

const templatesOf = (app: App): BuiltinTemplate[] => app.services.builtinTemplates ?? [];

const extrasSummary = (x: TemplateExtras) => ({
  kb_categories: x.kb?.length ?? 0,
  kb_articles: (x.kb ?? []).reduce((s, c) => s + c.articles.length, 0),
  dashboards: x.dashboards?.length ?? 0,
  routines: x.routines?.tasks.length ?? 0,
  helpdesk: !!x.helpdesk,
});

/** Resolves `pipeline:<name>` filter values to the id of the newest pipeline with that name in the sub-account. */
function resolvePipelines(app: App, locationId: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => resolvePipelines(app, locationId, v));
  if (typeof value === 'string' && value.startsWith('pipeline:')) {
    const row = app.db.get<{ id: string }>('SELECT id FROM pipelines WHERE location_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1', locationId, value.slice(9));
    return row?.id ?? '';
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePipelines(app, locationId, v)]));
}

const ymdIn = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

/** The extras, one after the other; each failure becomes a warning. */
async function applyExtras(app: App, ctx: Ctx, locationId: string, x: TemplateExtras) {
  const call = (method: string, path: string, body: Record<string, any> = {}) => callRoute(app, ctx, method, path, body, { locationId });
  const created = { kb_categories: 0, kb_articles: 0, dashboards: [] as string[], routines: 0, helpdesk: false, project_id: '' };
  const warnings: string[] = [];
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      warnings.push(`${label}: ${(e as Error).message}`);
    }
  };
  if (x.helpdesk)
    await attempt('Service-Einstellungen', async () => {
      await call('PUT', '/api/helpdesk/settings', x.helpdesk!);
      created.helpdesk = true;
    });
  for (const cat of x.kb ?? [])
    await attempt(`Wissensdatenbank „${cat.name}“`, async () => {
      const c = await call('POST', '/api/kb/categories', { name: cat.name, description: cat.description });
      created.kb_categories++;
      for (const a of cat.articles) {
        await call('POST', '/api/kb/articles', { ...a, category_id: c.id, status: 'draft' });
        created.kb_articles++;
      }
    });
  for (const d of x.dashboards ?? [])
    await attempt(`Dashboard „${d.name}“`, async () => {
      const pos = packWidgets(d.widgets);
      const widgets = d.widgets.map((w, i) => ({ id: id(10), title: w.title, w: w.w, h: w.h, ...pos[i], config: resolvePipelines(app, locationId, w.config) }));
      const row = await call('POST', '/api/reports/dashboards', { name: d.name, widgets, settings: { range: d.range, scope: 'location', refresh: 0 } });
      created.dashboards.push(row.id);
    });
  const r = x.routines;
  if (r)
    await attempt(`Projekt „${r.project}“`, async () => {
      const p = await call('POST', '/api/pm/projects', { name: r.project, description: r.description });
      created.project_id = p.id;
      for (const t of r.tasks) {
        await call('POST', '/api/pm/tasks', { project_id: p.id, title: t.title, description: t.description, due_at: ymdIn(t.due_in_days), recurrence: t.recurrence });
        created.routines++;
      }
    });
  return { created, warnings };
}

export const hqTemplateModule: Module = {
  name: 'hq-template',
  migrations: [
    [
      '001-init',
      `CREATE TABLE template_applications (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        template_id TEXT NOT NULL, applied_by TEXT, summary TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX template_applications_loc ON template_applications(location_id, template_id);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.builtinTemplates = [...templatesOf(app), HQ_TEMPLATE];

    const applied = (locationId: string, templateId: string) => db.get<{ created_at: string }>('SELECT created_at FROM template_applications WHERE location_id = ? AND template_id = ? ORDER BY created_at DESC LIMIT 1', locationId, templateId)?.created_at ?? null;
    const find = (tid: string) => {
      const t = templatesOf(app).find((x) => x.id === tid);
      if (!t) throw notFound('Vorlage nicht gefunden');
      return t;
    };

    router.get('/api/snapshot-templates', 'admin', (ctx) => {
      const loc = ctx.query.get('location_id') || ctx.locationId;
      return templatesOf(app).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        summary: { ...snapshotSummary(validateSnapshot(structuredClone(t.snapshot))), ...extrasSummary(t.extras) },
        pipelines: t.snapshot.pipelines.map((p) => ({ name: p.name, stages: p.stages.map((s) => s.name) })),
        forms: t.snapshot.forms.map((f) => f.name),
        workflows: t.snapshot.workflows.map((w) => w.name),
        applied_at: loc ? applied(loc, t.id) : null,
      }));
    });

    /** One click: the template into a sub-account (default: the current one). Twice only with `again: true`. */
    router.post('/api/snapshot-templates/:id/apply', 'admin', async (ctx) => {
      const t = find(ctx.params.id);
      const locId = str(ctx.body?.location_id, 'Sub-Account') || ctx.locationId;
      if (!locId || !app.location(locId)) throw notFound('Sub-Account nicht gefunden');
      if (applied(locId, t.id) && ctx.body?.again !== true) throw new HttpError(409, 'Diese Vorlage ist in diesem Sub-Account schon geladen');
      const data = validateSnapshot(structuredClone(t.snapshot));
      // A fresh sub-account only has the empty default pipeline: the template brings its own.
      const opps = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM opportunities WHERE location_id = ?', locId)!.n;
      const pipes = db.all<{ id: string }>('SELECT id FROM pipelines WHERE location_id = ?', locId);
      if (data.pipelines.length && !opps && pipes.length === 1) db.run('DELETE FROM pipelines WHERE id = ?', pipes[0].id);
      let created;
      try {
        created = applySnapshot(app, locId, data, { activateWorkflows: ctx.body?.activate_workflows === true });
      } catch (e) {
        throw bad((e as Error).message);
      }
      const extras = await applyExtras(app, ctx, locId, t.extras);
      const summary = {
        pipelines: data.pipelines.length,
        custom_fields: data.custom_fields.length,
        tags: data.tags.length,
        forms: created.forms.length,
        workflows: created.workflows.length,
        templates: data.templates.length,
        products: data.products.length,
        community_groups: (created.community_groups as unknown[] | undefined)?.length ?? 0,
        ...extras.created,
      };
      db.insert('template_applications', { id: id(), location_id: locId, template_id: t.id, applied_by: ctx.user?.id ?? null, summary, created_at: now() });
      return { location_id: locId, template: t.id, created: summary, warnings: extras.warnings };
    });
  },
};
