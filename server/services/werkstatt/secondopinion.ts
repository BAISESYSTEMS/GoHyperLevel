import type { App } from '../../core/app.js';
import type { User } from '../../core/http.js';
import { bareModel } from '../ai-effort.js';
import { gateProblem } from './models.js';
import { proProblem } from './license.js';
import { loadPolicy } from './policy.js';
import { reviewsOf } from './badges.js';
import type { VersionRow } from './store.js';

/**
 * The second opinion before a plugin goes to the Marktplatz (Pro): the same checklist, answered independently by
 * a *different* top model. It must differ from the model that wrote the version and from the one that did the
 * first review, so two different "minds" have looked at the code. The model comes from its own routing
 * ("Werkstatt: Zweitmeinung" in KI-Anbieter) and has to pass the model gate like every Werkstatt model.
 */

export interface SecondState {
  /** Pro license present? */
  pro: boolean;
  /** Can a second opinion be asked for right now? */
  available: boolean;
  /** Why not (plain German), or ''. */
  reason: string;
  /** Publishing waits for it (Pro, a second model is connected, the policy asks for it). */
  required: boolean;
  /** The model that would answer. */
  model: string;
  done: boolean;
}

export function secondState(app: App, locationId: string, v: VersionRow, user?: Pick<User, 'role'>): SecondState {
  const pro = proProblem(app, 'second_opinion');
  const policy = loadPolicy(app);
  const routed = app.services.aiConnections?.textProvider?.(locationId, 'werkstatt_review2') as { model: string } | null | undefined;
  const model = routed?.model ?? '';
  const done = reviewsOf(app, v.id).some((r) => r.kind === 'second_opinion');
  const base = { pro: !pro, model, done };
  if (pro) return { ...base, available: false, reason: pro, required: false };
  if (!routed) return { ...base, available: false, reason: 'Für die Zweitmeinung ist noch kein zweites Modell eingestellt: Einstellungen → KI-Anbieter → Zuordnung „Werkstatt: Zweitmeinung“ ein anderes Spitzenmodell wählen.', required: false };
  const gate = gateProblem(app, locationId, 'werkstatt_review2', user);
  if (gate) return { ...base, available: false, reason: gate, required: false };
  const writer = bareModel(v.meta?.ai?.model ?? '');
  const first = reviewsOf(app, v.id).find((r) => r.kind === 'review' || !r.kind);
  const same = [writer, bareModel(first?.model ?? '')].find((m) => m && m === bareModel(model));
  if (same) return { ...base, available: false, reason: `Die Zweitmeinung muss ein anderes Modell sein als das, das das Plugin geschrieben bzw. zuerst geprüft hat („${model}“). Wähle unter KI-Anbieter für „Werkstatt: Zweitmeinung“ ein anderes Spitzenmodell.`, required: policy.second_opinion };
  return { ...base, available: true, reason: '', required: policy.second_opinion };
}

/** What two reviews of the same version agree and disagree on. */
export function compareReviews(first: { verdict: string; checks: { id: string; ok: boolean }[] }, second: { verdict: string; checks: { id: string; ok: boolean }[] }) {
  const differing = first.checks.filter((c) => second.checks.find((s) => s.id === c.id && s.ok !== c.ok)).map((c) => c.id);
  return { agree: first.verdict === second.verdict && differing.length === 0, differing };
}
