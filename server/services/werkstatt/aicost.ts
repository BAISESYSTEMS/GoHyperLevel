import type { App } from '../../core/app.js';
import { withDefaults } from '../ai-context.js';
import { costMicros, type Usage } from '../anthropic.js';

/** Model and price of AI calls for a sub-account (the chosen provider, else the KI-Assistent's Claude model). */
export function modelInfo(app: App, locId: string, purpose = 'werkstatt_build', userId?: string | null): { model: string; price: (u: Usage) => number } {
  // userId: a person's own ChatGPT sign-in may serve their Werkstatt builds (modules/ai-subscriptions.ts) – the gate must look at that model.
  const alt = app.services.aiProvider?.(locId, purpose, userId) as { model: string; cost: (m: string, u: Usage) => number } | null | undefined;
  const row = app.db.get<{ data: string }>('SELECT data FROM ai_settings WHERE location_id = ?', locId);
  const model = alt?.model ?? withDefaults(row ? JSON.parse(row.data) : null).model;
  return { model, price: (u) => (alt ? alt.cost(model, u) : costMicros(model, u, model)) };
}

/** What an AI result cost: the provider's own figure, or tokens × price. */
export function callCost(app: App, locId: string, r: { usage?: Usage; costMicros?: number }): number {
  return Math.round(r.costMicros ?? (r.usage ? modelInfo(app, locId).price(r.usage) : 0));
}

/** Which AI serves the Werkstatt in this sub-account (for the status screen and the dry run) – never the key itself. */
export function describeAi(app: App, locId: string, purpose = 'werkstatt_build', userId?: string | null): { provider: string; label: string; model: string; connection_id: string | null; key_source: string | null } {
  const alt = app.services.aiProvider?.(locId, purpose, userId) as { provider: string; label: string; model: string; connectionId?: string; keySource?: string | null } | null | undefined;
  if (alt) return { provider: alt.provider, label: alt.label, model: alt.model, connection_id: alt.connectionId ?? null, key_source: alt.keySource ?? null };
  return { provider: 'anthropic', label: 'Claude (Anthropic)', model: modelInfo(app, locId, purpose, userId).model, connection_id: null, key_source: null };
}
