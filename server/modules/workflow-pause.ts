import type { Module } from '../core/app.js';

/**
 * Pause single workflow steps (docs/workflow-actions.md → Pause a step): a step with `disabled: true` stays in the flow but the
 * engine skips it – with a line in the run log ("Übersprungen – Schritt ist pausiert") – and goes on with the next step. A paused
 * container (Wenn/Sonst, Split-Test, Schleife) skips its lanes as well. Test runs show the skipped steps the same way.
 * Plugs in through `app.services.workflowStepCleaners` (keeps the flag a plain boolean) and `workflowStepSkips` (the engine's rule list).
 */

export const PAUSED_RESULT = 'Übersprungen – Schritt ist pausiert';

export const workflowPauseModule: Module = {
  name: 'workflow-pause',
  register(app) {
    const cleaners = app.services.workflowStepCleaners ?? {};
    app.services.workflowStepCleaners = {
      ...cleaners,
      '*': (step: any) => {
        cleaners['*']?.(step);
        if (step.disabled === true || step.disabled === 'true') step.disabled = true;
        else delete step.disabled;
      },
    };
    app.services.workflowStepSkips = [...(app.services.workflowStepSkips ?? []), (step: { disabled?: unknown }) => (step.disabled === true ? PAUSED_RESULT : undefined)];
  },
};
