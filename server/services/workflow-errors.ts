import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad } from '../core/http.js';
import { now } from '../core/util.js';
import { BUILTIN_ACTION_META } from './wfx-catalog.js';

/**
 * Error handling of workflows: what happens when a step fails.
 *
 * - Per step `continue_on_error`: "Fehler ignorieren und weiter" – the error is logged (marked ignored), the run goes on even when the
 *   workflow stops on errors, and nothing is reported.
 * - Per workflow (`settings`): `on_error_workflow_id` starts another workflow for the same contact, `error_bell` sends a push notification
 *   ("Glocke") and `error_email` an e-mail to the team – each with the failing step and its message. Once per run and failing moment.
 * - A run that stopped (`stop_on_error`) can be repeated from the failed step.
 *
 * The engine only calls `reportStepError`; the work happens in modules/workflow-errors.ts on the event `workflow.step_failed`.
 */

export const STEP_FAILED_EVENT = 'workflow.step_failed';

export interface ErrorSettings {
  on_error_workflow_id: string;
  error_bell: boolean;
  error_email: boolean;
}

const bool = (v: unknown) => v === true || v === 'true' || v === 1;

/** Validates the error keys of a workflow's settings (only those present). `prev` = the stored settings: an unchanged, now missing handler is dropped instead of refused. */
export function cleanErrorSettings(app: App, locationId: string, next: Record<string, any>, prev: Record<string, any> = {}, selfId?: string): Record<string, any> {
  const out = { ...next };
  if ('on_error_workflow_id' in next) {
    const wid = String(next.on_error_workflow_id ?? '').trim();
    if (!wid) out.on_error_workflow_id = '';
    else {
      const exists = !!app.db.get('SELECT 1 FROM workflows WHERE id = ? AND location_id = ?', wid, locationId);
      if (wid === selfId) throw bad('Ein Workflow kann nicht sein eigener Fehler-Workflow sein');
      if (!exists) {
        if (wid === prev.on_error_workflow_id) out.on_error_workflow_id = '';
        else throw bad('Fehler-Workflow nicht gefunden');
      } else out.on_error_workflow_id = wid;
    }
  }
  if ('error_bell' in next) out.error_bell = bool(next.error_bell);
  if ('error_email' in next) out.error_email = bool(next.error_email);
  return out;
}

/** The step's name in the editor's words (the catalog's label, then the step's own name, then the type). */
export function stepLabel(app: App, step: { type: string; name?: string }): string {
  const label = app.services.workflowActionMeta?.[step.type]?.label ?? BUILTIN_ACTION_META[step.type]?.label ?? step.type;
  return step.name ? `${label} („${step.name}“)` : label;
}

export interface StepFailure {
  workflowId: string;
  workflowName: string;
  runId: string;
  stepId: string;
  stepType: string;
  step: string;
  message: string;
  /** The run stopped here (the workflow stops on errors) – otherwise it went on with the next step. */
  stopped: boolean;
  at: string;
}

/**
 * Called by the engine when a step failed and is not marked "ignore". Tells the error module once per run (until the run is repeated);
 * does nothing for workflows without error handling and never in test runs. The run's variables carry the "already reported" mark.
 */
export function reportStepError(app: App, run: { id: string; location_id: string; contact_id: string; workflow_id: string; event?: Record<string, any>; vars: Record<string, any> }, wf: { name?: string; settings?: Record<string, any> }, step: { id: string; type: string; name?: string }, message: string): void {
  const s = wf.settings ?? {};
  if (!s.on_error_workflow_id && !s.error_bell && !s.error_email) return;
  if (run.vars._err_reported) return;
  run.vars._err_reported = now();
  const failure: StepFailure = { workflowId: run.workflow_id, workflowName: String(wf.name ?? ''), runId: run.id, stepId: step.id, stepType: step.type, step: stepLabel(app, step), message: String(message).slice(0, 500), stopped: !!s.stop_on_error, at: now() };
  app.events.emit(run.location_id, STEP_FAILED_EVENT, { contactId: run.contact_id, failure, errorOf: run.event?.errorOf ?? null, wfDepth: Number(run.event?.wfDepth ?? 0) });
}

/** Repeats a stopped run from the step that failed. Throws German 4xx errors when it cannot. */
export async function retryRun(app: App, locationId: string, runId: string, processRun: (app: App, id: string) => Promise<void>): Promise<{ id: string; status: string }> {
  const run = parseJson(app.db.get<any>('SELECT * FROM workflow_runs WHERE id = ? AND location_id = ?', runId, locationId), ['cursor', 'log', 'vars']);
  if (!run) throw new HttpError(404, 'Lauf nicht gefunden');
  if (run.status !== 'failed') throw bad('Nur angehaltene (fehlgeschlagene) Läufe lassen sich wiederholen');
  const wf = app.db.get<any>('SELECT id, status, steps FROM workflows WHERE id = ? AND location_id = ?', run.workflow_id, locationId);
  if (!wf) throw new HttpError(404, 'Workflow nicht gefunden');
  if (wf.status !== 'active') throw bad('Der Workflow ist nicht aktiv – erst aktivieren, dann wiederholen');
  const log: any[] = Array.isArray(run.log) ? run.log : [];
  const failed = [...log].reverse().find((l) => l.error);
  const vars = run.vars && typeof run.vars === 'object' ? { ...run.vars } : {};
  // A fresh step budget and a fresh report: another failure is announced again.
  vars._steps = 0;
  delete vars._err_reported;
  log.push({ at: now(), step: failed?.step ?? '', type: 'retry', result: `Wiederholung ab dem fehlgeschlagenen Schritt${failed?.type ? ` (${failed.type})` : ''}` });
  app.db.update('workflow_runs', run.id, { status: 'active', vars, log: log.slice(-200), next_run_at: null, updated_at: now() });
  await processRun(app, run.id);
  const after = app.db.get<{ status: string }>('SELECT status FROM workflow_runs WHERE id = ?', run.id);
  return { id: run.id, status: after?.status ?? 'unknown' };
}
