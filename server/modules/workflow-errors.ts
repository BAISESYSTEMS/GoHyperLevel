import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { notFound } from '../core/http.js';
import { notifyTeam } from '../services/messaging.js';
import { STEP_FAILED_EVENT, retryRun, type StepFailure } from '../services/workflow-errors.js';
import { PUSH_KINDS } from './push.js';
import { processRun, startWorkflow } from '../services/workflow-engine.js';

/**
 * Workflow error handling (services/workflow-errors.ts): the listener behind a failed step – bell (push) and e-mail to the team with the
 * failing step, and "Bei Fehler: anderen Workflow starten" – and the routes to repeat a stopped run from the failed step.
 * Outgoing webhooks and REST hooks also receive the event `workflow.step_failed`. Docs: docs/workflow-actions.md → Fehlerbehandlung.
 */

/** Notifications per workflow and hour; a workflow failing for hundreds of contacts must not flood the inbox. */
const HOURLY_NOTICES = 10;

export const workflowErrorsModule: Module = {
  name: 'workflow-errors',
  register(app) {
    const { db, router } = app;
    Object.assign(PUSH_KINDS, { workflows: { label: 'Workflow-Fehler: ein Schritt ist fehlgeschlagen', perm: 'workflows' } });
    // Steps may carry "Fehler ignorieren und weiter" (continue_on_error): kept as a plain boolean, dropped otherwise.
    const cleaners = app.services.workflowStepCleaners ?? {};
    app.services.workflowStepCleaners = {
      ...cleaners,
      '*': (step: any) => {
        cleaners['*']?.(step);
        if (step.continue_on_error === true || step.continue_on_error === 'true') step.continue_on_error = true;
        else delete step.continue_on_error;
      },
    };
    const notices = new Map<string, number[]>();
    const allowed = (workflowId: string) => {
      const t = Date.now();
      const list = (notices.get(workflowId) ?? []).filter((x) => t - x < 3600_000);
      if (list.length >= HOURLY_NOTICES) {
        notices.set(workflowId, list);
        return false;
      }
      notices.set(workflowId, [...list, t]);
      return true;
    };

    app.events.on(STEP_FAILED_EVENT, async (e) => {
      const f: StepFailure | undefined = e.data.failure;
      if (!f) return;
      const wf = parseJson(db.get<any>('SELECT * FROM workflows WHERE id = ? AND location_id = ?', f.workflowId, e.locationId), ['steps', 'trigger', 'settings']);
      if (!wf) return;
      const s = wf.settings ?? {};
      const contact = e.data.contactId ? db.get<any>('SELECT first_name, last_name, email FROM contacts WHERE id = ? AND location_id = ?', e.data.contactId, e.locationId) : undefined;
      const who = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || '' : '';

      // Bell and e-mail: one notice with everything needed to find the problem.
      if ((s.error_bell || s.error_email) && allowed(wf.id)) {
        const title = `Workflow-Fehler: „${wf.name}“`;
        const lines = [`Schritt: ${f.step}`, `Fehler: ${f.message}`, who ? `Kontakt: ${who}${contact?.email && who !== contact.email ? ` (${contact.email})` : ''}` : '', f.stopped ? 'Der Ablauf wurde angehalten – er lässt sich im Verlauf ab diesem Schritt wiederholen.' : 'Der Ablauf läuft mit dem nächsten Schritt weiter.'].filter(Boolean);
        if (s.error_bell) await Promise.resolve(app.services.pushNotify?.({ locationId: e.locationId, kind: 'workflows', title, body: `${f.step}: ${f.message}`, url: `/app/workflows/${wf.id}`, tag: `wf-error-${wf.id}` })).catch(() => undefined);
        if (s.error_email) await notifyTeam(app, e.locationId, title, `${lines.join('\n')}\n\nZum Workflow: ${app.baseUrl()}/app/workflows/${wf.id}`).catch(() => undefined);
      }

      // Another workflow for the same contact. A run that is itself an error handler never starts one (no chains, no loops).
      const target = String(s.on_error_workflow_id ?? '');
      if (target && target !== wf.id && !e.data.errorOf && Number(e.data.wfDepth ?? 0) < 3 && e.data.contactId) {
        const h = parseJson(db.get<any>('SELECT * FROM workflows WHERE id = ? AND location_id = ?', target, e.locationId), ['steps', 'trigger', 'settings']);
        if (h && h.status === 'active') {
          // Every failure may start its own handler run, whatever the handler's "mehrfach durchlaufen" says.
          const rid = startWorkflow(app, { ...h, settings: { ...h.settings, allow_reentry: true } }, e.data.contactId, {
            error: { workflow_id: wf.id, workflow: wf.name, run_id: f.runId, step_id: f.stepId, step_type: f.stepType, step: f.step, message: f.message, stopped: f.stopped, at: f.at },
            errorOf: f.runId,
            wfDepth: Number(e.data.wfDepth ?? 0) + 1,
          });
          if (rid) await processRun(app, rid);
        }
      }
    });

    /** Repeats a stopped run from its failed step. */
    router.post('/api/workflow-runs/:id/retry', 'location', (ctx) => retryRun(app, ctx.locationId, ctx.params.id, processRun));

    /** Repeats every stopped run of a workflow (at most 100 at a time, oldest first). */
    router.post('/api/workflows/:id/retry-failed', 'location', async (ctx) => {
      const w = db.get<any>('SELECT id FROM workflows WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!w) throw notFound();
      const rows = db.all<{ id: string }>(`SELECT id FROM workflow_runs WHERE workflow_id = ? AND location_id = ? AND status = 'failed' ORDER BY updated_at LIMIT 100`, w.id, ctx.locationId);
      let retried = 0;
      let failedAgain = 0;
      for (const r of rows) {
        const res = await retryRun(app, ctx.locationId, r.id, processRun).catch(() => undefined);
        if (!res) continue;
        retried++;
        if (res.status === 'failed') failedAgain++;
      }
      return { retried, failed_again: failedAgain, remaining: db.get<{ n: number }>(`SELECT COUNT(*) n FROM workflow_runs WHERE workflow_id = ? AND status = 'failed'`, w.id)!.n };
    });
  },
};
