import type { Module } from '../core/app.js';
import type { Handler, Route } from '../core/http.js';
import { cleanLayout, layoutKeys } from '../services/workflow-layout.js';

/**
 * The visual workflow canvas (web/src/workflow-canvas, docs/workflow-actions.md → The canvas) edits the same steps as the list
 * editor; the only thing it stores of its own is `settings.layout` (node offsets and sticky notes). This module keeps that part
 * clean when a workflow is created, saved or put into a draft: known shape, limits, offsets of steps that no longer exist dropped.
 * Plugs in through `app.router.wrappers` – the workflow routes stay untouched.
 */

const ROUTES = new Set(['POST /api/workflows', 'PATCH /api/workflows/:id', 'PUT /api/workflows/:id/draft']);

export const workflowCanvasModule: Module = {
  name: 'workflow-canvas',
  register(app) {
    app.router.wrappers.push((route: Route, next: Handler): Handler => {
      if (!ROUTES.has(`${route.method} ${route.pattern}`)) return next;
      return (ctx) => {
        const settings = ctx.body?.settings;
        if (settings && typeof settings === 'object' && !Array.isArray(settings) && 'layout' in settings) {
          let steps: unknown = ctx.body.steps;
          if (!Array.isArray(steps) && ctx.params.id) {
            const row = app.db.get<{ steps: string }>('SELECT steps FROM workflows WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
            steps = row ? JSON.parse(row.steps || '[]') : undefined;
          }
          ctx.body.settings = { ...settings, layout: cleanLayout(settings.layout, Array.isArray(steps) ? layoutKeys(steps) : undefined) };
        }
        return next(ctx);
      };
    });
  },
};
