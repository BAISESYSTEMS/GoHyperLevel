import type { Module } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { sliceTimer } from '../core/perf.js';
import { actorOf } from '../services/pm-core.js';
import { autoCloseRetainers, closeMonth, createRetainer, deleteRetainer, getRetainer, listRetainers, previewRetainer, retainerOut, updateRetainer } from '../services/pm-retainers.js';
import { viewerOf } from '../services/pm-time.js';

/**
 * Retainers (docs/projects.md#retainers): monthly hour contingents per client or project, closed month by month into invoice drafts
 * (fee + overage) with carry-over. Routes under /api/pm/billing/retainers (area "Rechnungen & Produkte"); setting up and changing a
 * retainer is for the Leitung, closing a month for everyone who may make invoices from time.
 */

const MIGRATION = `
CREATE TABLE pm_retainers (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES pm_projects(id) ON DELETE SET NULL,
  hours_per_month REAL NOT NULL, price_cents INTEGER NOT NULL, overage_rate_cents INTEGER NOT NULL DEFAULT 0,
  rollover TEXT NOT NULL DEFAULT 'none', rollover_max_hours REAL NOT NULL DEFAULT 0,
  start_month TEXT NOT NULL, end_month TEXT, status TEXT NOT NULL DEFAULT 'active', auto_close INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL, notes TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pm_retainers_loc ON pm_retainers(location_id, status);
CREATE INDEX pm_retainers_project ON pm_retainers(project_id);
CREATE TABLE pm_retainer_periods (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  retainer_id TEXT NOT NULL REFERENCES pm_retainers(id) ON DELETE CASCADE, month TEXT NOT NULL,
  included_hours REAL NOT NULL, carry_in_hours REAL NOT NULL, available_hours REAL NOT NULL, used_hours REAL NOT NULL,
  overage_hours REAL NOT NULL, unused_hours REAL NOT NULL, carry_out_hours REAL NOT NULL,
  price_cents INTEGER NOT NULL, overage_rate_cents INTEGER NOT NULL, invoice_id TEXT, entries INTEGER NOT NULL DEFAULT 0,
  closed_by TEXT, closed_at TEXT NOT NULL, UNIQUE (retainer_id, month)
);
CREATE INDEX pm_retainer_periods_loc ON pm_retainer_periods(location_id, invoice_id);
`;

export const pmRetainersModule: Module = {
  name: 'pm-retainers',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { router } = app;
    const leitung = (ctx: Ctx) => {
      if (!viewerOf(ctx).manager) throw new HttpError(403, 'Retainer richtet nur die Leitung ein');
    };

    router.get('/api/pm/billing/retainers', 'location', (ctx) => ({ retainers: listRetainers(app, ctx.locationId, { project_id: ctx.query.get('project_id') ?? undefined, contact_id: ctx.query.get('contact_id') ?? undefined, status: ctx.query.get('status') ?? undefined }) }));
    router.post('/api/pm/billing/retainers', 'location', (ctx) => {
      leitung(ctx);
      const r = createRetainer(app, ctx.locationId, ctx.body ?? {}, actorOf(ctx));
      return retainerOut(app, ctx.locationId, r);
    });
    router.get('/api/pm/billing/retainers/:id', 'location', (ctx) => getRetainer(app, ctx.locationId, ctx.params.id));
    router.patch('/api/pm/billing/retainers/:id', 'location', (ctx) => {
      leitung(ctx);
      return retainerOut(app, ctx.locationId, updateRetainer(app, ctx.locationId, ctx.params.id, ctx.body ?? {}));
    });
    router.delete('/api/pm/billing/retainers/:id', 'location', (ctx) => {
      leitung(ctx);
      return deleteRetainer(app, ctx.locationId, ctx.params.id);
    });
    router.get('/api/pm/billing/retainers/:id/preview', 'location', (ctx) => previewRetainer(app, ctx.locationId, ctx.params.id, ctx.query.get('month') ?? undefined));
    router.post('/api/pm/billing/retainers/:id/close', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const r = closeMonth(app, ctx.locationId, ctx.params.id, { month: b.month ? String(b.month) : undefined, include_unapproved: b.include_unapproved === true }, actorOf(ctx));
      return { ...r, retainer: getRetainer(app, ctx.locationId, ctx.params.id) };
    });

    let last = 0;
    // One retainer at a time with a pause in between, so requests are answered in between (docs/performance.md).
    app.onTick(async () => {
      if (Date.now() - last < 30 * 60_000) return;
      last = Date.now();
      const pause = sliceTimer(40);
      let closed = 0;
      for (const r of app.db.all<{ id: string }>(`SELECT id FROM pm_retainers WHERE status = 'active' AND auto_close = 1 LIMIT 500`)) {
        if (closed >= 20) break;
        closed += autoCloseRetainers(app, 1, new Set([r.id]));
        await pause();
      }
    });
    app.services.pmRetainers = { autoClose: () => autoCloseRetainers(app) };
  },
};
