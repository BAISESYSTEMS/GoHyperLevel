import type { App } from '../../core/app.js';
import type { User } from '../../core/http.js';
import { GATE_FAMILIES, GATE_LINK, checkModel, gateMessage, needsTopModel } from './modelgate.js';
import { describeAi, modelInfo } from './aicost.js';
import { loadPolicy } from './policy.js';
import { maxEffort } from '../ai-effort.js';
import { effortOverview } from './effortview.js';

/**
 * The glue between the model gate (pure: modelgate.ts), the KI-Anbieter routing and the Werkstatt: which model
 * serves a purpose in a sub-account, whether the gate lets it through, and what the status screens show.
 */

/** The model that would serve an `aiRun` purpose in this sub-account (routing "werkstatt" → "text" → the assistant's own). */
export const modelOfPurpose = (app: App, locationId: string, purpose: string, userId?: string | null) => modelInfo(app, locationId, purpose, userId).model;

/** Why this purpose may not run with the connected model, or null. `user` only decides who is told to fix it. */
export function gateProblem(app: App, locationId: string, purpose: string, user?: Pick<User, 'role'> & { id?: string }): string | null {
  const gate = loadPolicy(app).model_gate;
  if (!needsTopModel(purpose, gate)) return null;
  const model = modelOfPurpose(app, locationId, purpose, user?.id);
  return checkModel(model, gate).ok ? null : gateMessage(model, user?.role === 'admin');
}

export interface GateStatus {
  enabled: boolean;
  stage1_normal: boolean;
  /** The model that writes plugins (purpose werkstatt_build). */
  model: string;
  ok: boolean;
  matched: string;
  message: string;
  link: string;
  /** Which connection serves it. */
  via: string;
  /** What the planning step uses and whether Stufe 1 may use it. */
  plan_model: string;
  plan_ok: boolean;
  families: { id: string; label: string; on: boolean }[];
  review: { model: string; ok: boolean; differs: boolean };
  effort: ReturnType<typeof effortOverview>;
}

/** Everything the Werkstatt page shows about the model: which one, allowed or not, with what Denkstufe. */
export function gateStatus(app: App, locationId: string, user?: Pick<User, 'role'> & { id?: string }): GateStatus {
  const gate = loadPolicy(app).model_gate;
  const build = describeAi(app, locationId, 'werkstatt_build', user?.id);
  const plan = describeAi(app, locationId, 'werkstatt_plan', user?.id);
  const rev = describeAi(app, locationId, 'werkstatt_review2');
  const v = checkModel(build.model, gate);
  const second = (app.services.aiProvider?.(locationId, 'werkstatt_review2') as { model: string; connectionId?: string } | null | undefined) ?? null;
  return {
    enabled: gate.enabled,
    stage1_normal: gate.stage1_normal,
    model: build.model,
    ok: v.ok,
    matched: v.matched ?? '',
    message: v.ok ? '' : gateMessage(build.model, user?.role === 'admin'),
    link: GATE_LINK,
    via: build.label,
    plan_model: plan.model,
    plan_ok: checkModel(plan.model, gate).ok,
    families: GATE_FAMILIES.map((f) => ({ id: f.id, label: f.label, on: gate.families.includes(f.id) })),
    review: { model: second ? rev.model : '', ok: !!second && checkModel(rev.model, gate).ok, differs: !!second && rev.model.toLowerCase() !== build.model.toLowerCase() },
    effort: effortOverview(app, locationId, build),
  };
}

export { maxEffort };
