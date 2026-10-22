import type { Module } from '../core/app.js';
import { bad } from '../core/http.js';

/**
 * Kanban comfort for pipelines (docs/api.md, Pipelines): the order of the pipelines, set by dragging them in
 * *Opportunities → Pipelines sortieren*. Stage colours are part of the stages (modules/pipelines.ts keeps `color`); collapsed
 * stages and column widths are a person's own and stay in their browser.
 */
export const pipelineBoardModule: Module = {
  name: 'pipeline-board',
  register(app) {
    const { db, router } = app;
    router.post('/api/pipelines/order', 'location', (ctx) => {
      const ids = Array.isArray(ctx.body?.ids) ? [...new Set(ctx.body.ids.map(String))].slice(0, 500) : null;
      if (!ids?.length) throw bad('ids: Liste der Pipelines in der neuen Reihenfolge angeben');
      const own = new Set(db.all<{ id: string }>('SELECT id FROM pipelines WHERE location_id = ?', ctx.locationId).map((r) => r.id));
      const unknown = ids.filter((x) => !own.has(x as string));
      if (unknown.length) throw bad('Unbekannte Pipeline');
      db.tx(() => {
        ids.forEach((pid, i) => db.run('UPDATE pipelines SET position = ? WHERE id = ? AND location_id = ?', i, pid as string, ctx.locationId));
        // Pipelines the list left out go after the listed ones, in their old order.
        let n = ids.length;
        for (const r of db.all<{ id: string }>('SELECT id FROM pipelines WHERE location_id = ? ORDER BY position IS NULL, position, created_at', ctx.locationId)) if (!ids.includes(r.id)) db.run('UPDATE pipelines SET position = ? WHERE id = ?', n++, r.id);
      });
      return { ids: db.all<{ id: string }>('SELECT id FROM pipelines WHERE location_id = ? ORDER BY position, created_at', ctx.locationId).map((r) => r.id) };
    });
  },
};
