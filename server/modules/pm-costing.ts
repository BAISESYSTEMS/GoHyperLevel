import type { Module } from '../core/app.js';
import { toCsv } from '../core/csv.js';
import { sliceTimer } from '../core/perf.js';
import { HttpError, type Ctx, type RawResult } from '../core/http.js';
import { actorOf } from '../services/pm-core.js';
import {
  addCost,
  budgetStatus,
  burndownOf,
  checkAllBudgets,
  checkBudget,
  deleteBudget,
  deleteCost,
  linkableReceipts,
  listBudgets,
  listCostRates,
  listCosts,
  profitCsv,
  profitability,
  saveBudget,
  saveCostSettings,
  setCostRate,
  updateCost,
} from '../services/pm-costing.js';
import { retainerFacts } from '../services/pm-retainers.js';
import { viewerOf } from '../services/pm-time.js';
import { registerTriggers } from '../services/wfx-kit.js';

/**
 * Job costing (docs/projects.md#job-costing-and-retainers): project budgets with alert thresholds (notification, audit line and the
 * workflow trigger `project.budget_threshold`), internal cost rates per person, external costs per project (optionally a receipt of
 * the bookkeeping) and the profitability report with CSV export and burn-down. Everything sits under /api/pm/billing (area
 * "Rechnungen & Produkte"); cost rates, margins and budget changes are for the Leitung.
 */

const MIGRATION = `
CREATE TABLE pm_cost_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  default_cost_cents INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE pm_cost_rates (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, cost_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (location_id, user_id)
);
CREATE TABLE pm_costs (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  day TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL,
  receipt_id TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pm_costs_project ON pm_costs(location_id, project_id, day);
CREATE UNIQUE INDEX pm_costs_receipt ON pm_costs(location_id, receipt_id) WHERE receipt_id IS NOT NULL;
CREATE TABLE pm_budgets (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL UNIQUE REFERENCES pm_projects(id) ON DELETE CASCADE,
  hours REAL, amount_cents INTEGER, include_costs INTEGER NOT NULL DEFAULT 1,
  thresholds TEXT NOT NULL DEFAULT '[80,100]', notify TEXT NOT NULL DEFAULT '[]', fired TEXT NOT NULL DEFAULT '{}',
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pm_budgets_loc ON pm_budgets(location_id);
`;

/** Agency admins, keys and people without restrictions have every area; a member needs it listed. */
const hasArea = (ctx: Ctx, area: string) => !ctx.user || ctx.user.role === 'admin' || !ctx.user.permissions || ctx.user.permissions.includes(area as never);

export const pmCostingModule: Module = {
  name: 'pm-costing',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { router } = app;
    const leitung = (ctx: Ctx, what: string) => {
      if (!viewerOf(ctx).manager) throw new HttpError(403, `${what} nur die Leitung`);
    };
    const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

    // --- cost rates -----------------------------------------------------------------------------------------------------------------
    router.get('/api/pm/billing/cost-rates', 'location', (ctx) => {
      leitung(ctx, 'Kostensätze sieht');
      return listCostRates(app, ctx.locationId);
    });
    router.put('/api/pm/billing/cost-rates', 'location', (ctx) => {
      leitung(ctx, 'Kostensätze ändert');
      const b = ctx.body ?? {};
      if (b.default_cost_cents !== undefined) saveCostSettings(app, ctx.locationId, b);
      if (b.user_id !== undefined) setCostRate(app, ctx.locationId, b);
      return listCostRates(app, ctx.locationId);
    });

    // --- external costs ---------------------------------------------------------------------------------------------------------------
    router.get('/api/pm/billing/costs', 'location', (ctx) => ({ costs: listCosts(app, ctx.locationId, { project_id: ctx.query.get('project_id') ?? undefined, from: ymd(ctx.query.get('from')), to: ymd(ctx.query.get('to')), limit: Number(ctx.query.get('limit')) || undefined }) }));
    router.post('/api/pm/billing/costs', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if (b.receipt_id && !hasArea(ctx, 'accounting')) throw new HttpError(403, 'Belege verknüpfen nur Personen mit Zugriff auf die Buchhaltung');
      const row = addCost(app, ctx.locationId, b, actorOf(ctx));
      checkBudget(app, ctx.locationId, row.project_id);
      return row;
    });
    router.patch('/api/pm/billing/costs/:id', 'location', (ctx) => {
      const row = updateCost(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, viewerOf(ctx));
      checkBudget(app, ctx.locationId, row.project_id);
      return row;
    });
    router.delete('/api/pm/billing/costs/:id', 'location', (ctx) => {
      const r = deleteCost(app, ctx.locationId, ctx.params.id, viewerOf(ctx));
      checkBudget(app, ctx.locationId, r.project_id);
      return { ok: true };
    });
    router.get('/api/pm/billing/receipts', 'location', (ctx) => {
      if (!hasArea(ctx, 'accounting')) throw new HttpError(403, 'Belege sehen nur Personen mit Zugriff auf die Buchhaltung');
      return { receipts: linkableReceipts(app, ctx.locationId, ctx.query.get('q') ?? '') };
    });

    // --- budgets ------------------------------------------------------------------------------------------------------------------------
    router.get('/api/pm/billing/budgets', 'location', (ctx) => ({ budgets: listBudgets(app, ctx.locationId) }));
    router.get('/api/pm/billing/budgets/:projectId', 'location', (ctx) => budgetStatus(app, ctx.locationId, ctx.params.projectId));
    router.put('/api/pm/billing/budgets/:projectId', 'location', (ctx) => {
      leitung(ctx, 'Budgets ändert');
      return saveBudget(app, ctx.locationId, ctx.params.projectId, ctx.body ?? {}, actorOf(ctx));
    });
    router.delete('/api/pm/billing/budgets/:projectId', 'location', (ctx) => {
      leitung(ctx, 'Budgets entfernt');
      return deleteBudget(app, ctx.locationId, ctx.params.projectId);
    });
    router.get('/api/pm/billing/burndown/:projectId', 'location', (ctx) => burndownOf(app, ctx.locationId, ctx.params.projectId));

    // --- profitability ------------------------------------------------------------------------------------------------------------------
    const filter = (ctx: Ctx) => ({ group: ctx.query.get('group') ?? undefined, from: ymd(ctx.query.get('from')), to: ymd(ctx.query.get('to')), project_id: ctx.query.get('project_id') || undefined });
    router.get('/api/pm/billing/profitability', 'location', (ctx) => {
      leitung(ctx, 'Die Rentabilität sieht');
      return profitability(app, ctx.locationId, filter(ctx), retainerFacts(app, ctx.locationId));
    });
    router.get('/api/pm/billing/profitability/export.csv', 'location', (ctx): RawResult => {
      leitung(ctx, 'Die Rentabilität sieht');
      const report = profitability(app, ctx.locationId, filter(ctx), retainerFacts(app, ctx.locationId));
      return { __raw: true, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="rentabilitaet-${report.group === 'client' ? 'kunden' : 'projekte'}.csv"` }, body: '﻿' + toCsv(profitCsv(report)) };
    });

    // --- thresholds ---------------------------------------------------------------------------------------------------------------------
    app.events.on('time.logged', (e) => {
      const pid = e.data?.entry?.project_id;
      if (pid) checkBudget(app, e.locationId, pid);
    });
    let last = 0;
    // In slices of ~40 ms, so requests are answered in between (docs/performance.md).
    app.onTick(async () => {
      if (Date.now() - last < 10 * 60_000) return;
      last = Date.now();
      const pause = sliceTimer(40);
      for (const r of app.db.all<{ location_id: string; project_id: string }>('SELECT location_id, project_id FROM pm_budgets LIMIT 5000')) {
        checkBudget(app, r.location_id, r.project_id);
        await pause();
      }
    });
    app.services.pmCosting = { checkBudget: (loc: string, pid: string) => checkBudget(app, loc, pid), checkAll: () => checkAllBudgets(app) };

    registerTriggers(app, [
      {
        type: 'project.budget_threshold',
        label: 'Projekt-Budget: Schwelle erreicht',
        category: 'sales',
        summary: 'Ein Projekt hat eine Budget-Schwelle erreicht (z. B. 80 % oder 100 % der Stunden oder des Geld-Budgets).',
        doc: '{{event.project.name}}, {{event.kind}} (hours oder amount), {{event.threshold}} (Schwelle in %), {{event.percent}}, {{event.used}} und {{event.budget}} (Stunden bzw. Cent). Startet für den Kunden des Projekts – Projekte ohne Kunde starten keinen Workflow.',
        fields: [
          { key: 'project_id', label: 'Nur für Projekt (ID)', type: 'text' },
          { key: 'kind', label: 'Budget', type: 'select', options: [['', 'Stunden oder Geld'], ['hours', 'Stunden'], ['amount', 'Geld']] },
          { key: 'threshold', label: 'Nur bei Schwelle (%)', type: 'number', placeholder: 'z. B. 100' },
        ],
        sample: { contactId: 'c1', projectId: 'p1', project: { id: 'p1', name: 'Website-Relaunch' }, kind: 'hours', threshold: 80, percent: 82.5, used: 33, budget: 40, unit: 'hours' },
        keywords: 'budget projekt stunden kontingent schwelle überschritten warnung kosten',
      },
    ]);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'project.budget_threshold': (c: any, d: any) => (!c.project_id || c.project_id === d.projectId) && (!c.kind || c.kind === d.kind) && (c.threshold === undefined || c.threshold === '' || c.threshold === null || Number(c.threshold) === Number(d.threshold)),
    };
  },
};
