import type { App } from '../../core/app.js';
import { EFFORT_LABELS, maxEffort, planEffort, type Effort } from '../ai-effort.js';

/** What the Werkstatt will ask of the model that serves it: the level from the settings and what the model takes. */
export function effortOverview(app: App, locationId: string, ai: { provider: string; model: string }) {
  const choice = app.services.aiEffort?.forCap(locationId, 'werkstatt') as { effort: Effort } | undefined;
  const wanted: Effort = choice?.effort ?? 'xhigh';
  const wire = /claude/i.test(ai.model) || ai.provider === 'anthropic' ? 'anthropic' : 'openai';
  const plan = planEffort({ provider: ai.provider, model: ai.model, wire }, wanted, { strict: true });
  return { requested: wanted, applied: plan.applied, label: plan.applied ? EFFORT_LABELS[plan.applied] : '', note: plan.note, model_max: maxEffort({ provider: ai.provider, model: ai.model, wire }) };
}
