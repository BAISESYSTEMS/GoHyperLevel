import type { Module } from '../core/app.js';
import type { Handler, Route } from '../core/http.js';
import { notFound } from '../core/http.js';
import { BUILTIN_ACTION_META } from '../services/wfx-catalog.js';
import { issueText, validateSteps, type RuleMeta, type StepLike } from '../services/workflow-validate.js';

/**
 * Validation of workflow steps when they are saved (docs/workflow-actions.md → Validation): the answers of
 * `GET /api/workflows/:id` and `PATCH /api/workflows/:id` carry `issues` (required settings that are missing, jump targets that
 * are gone) – for the editors, which show them on the steps, and for API and MCP callers. Saving is never refused: a draft may be
 * unfinished. `POST /api/workflows/:id/validate` checks unsaved steps (`{steps}`) or the stored ones. The rules are the pure
 * services/workflow-validate.ts, shared with the web editor. Plugs in through `app.router.wrappers`.
 */

export const workflowValidateModule: Module = {
  name: 'workflow-validate',
  register(app) {
    const metaOf = (type: string): RuleMeta | undefined => app.services.workflowActionMeta?.[type] ?? BUILTIN_ACTION_META[type];
    const issuesOf = (steps: unknown) => validateSteps(Array.isArray(steps) ? (steps as StepLike[]) : [], metaOf).map((i) => ({ ...i, message: issueText(i) }));

    app.router.wrappers.push((route: Route, next: Handler): Handler => {
      if (route.pattern !== '/api/workflows/:id' || (route.method !== 'GET' && route.method !== 'PATCH')) return next;
      return async (ctx) => {
        const res: any = await next(ctx);
        return res && typeof res === 'object' && Array.isArray(res.steps) ? { ...res, issues: issuesOf(res.steps) } : res;
      };
    });

    app.router.post('/api/workflows/:id/validate', 'location', (ctx) => {
      const w = app.db.get<{ steps: string }>('SELECT steps FROM workflows WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!w) throw notFound();
      const issues = issuesOf(Array.isArray(ctx.body?.steps) ? ctx.body.steps : JSON.parse(w.steps || '[]'));
      return { ok: !issues.length, issues };
    });
  },
};
