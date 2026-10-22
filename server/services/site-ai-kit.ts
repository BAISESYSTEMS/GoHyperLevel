import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { costMicros, type SystemBlock, type Usage } from './anthropic.js';
import { budgetProblem, monthStart, withDefaults } from './ai-context.js';
import { parseAnswer, retryText } from './site-ai.js';

/**
 * Funnel & Website AI – the part that talks to the app: which model a sub-account uses for it (the BYOK registry's use
 * "Funnel & Website AI", else quick texts, else the KI-Assistent's own), what that costs, how much of the monthly limit is left,
 * and the ask-check-retry loop every AI step goes through (`aiRun` logs each call and enforces the limit).
 */

export const ATTEMPTS = 3;

export interface ModelInfo {
  label: string;
  model: string;
  byok: boolean;
  /** µ$ for a usage */
  price: (u: Usage) => number;
}

type AltProvider = { label: string; model: string; connectionId?: string; cost: (model: string, u: Usage) => number };

/** The model this sub-account's site AI runs on (the same resolution `aiRun` does). */
export function modelInfo(app: App, locationId: string, purpose: string, userId?: string | null): ModelInfo {
  const alt = app.services.aiProvider?.(locationId, purpose, userId ?? null) as AltProvider | null | undefined;
  if (alt) return { label: alt.label, model: alt.model, byok: !!alt.connectionId, price: (u) => alt.cost(alt.model, u) };
  const s = aiSettings(app, locationId);
  return { label: 'Claude', model: s.model, byok: false, price: (u) => costMicros(s.model, u, s.model) };
}

function aiSettings(app: App, locationId: string) {
  try {
    const row = app.db.get<{ data: string }>('SELECT data FROM ai_settings WHERE location_id = ?', locationId);
    return withDefaults(row ? JSON.parse(row.data) : null);
  } catch {
    return withDefaults(null);
  }
}

/** This month's AI spend of the sub-account against the KI-Assistent's limit (µ$ and tokens). */
export function budget(app: App, locationId: string): { used_usd: number; limit_usd: number; remaining_usd: number; tokens: number; token_limit: number; problem: string | null } {
  const s = aiSettings(app, locationId);
  let used = { cost: 0, tokens: 0 };
  try {
    const since = monthStart(app.location(locationId)?.timezone || 'Europe/Berlin');
    used = app.db.get<{ cost: number; tokens: number }>(
      `SELECT COALESCE(SUM(cost_micros), 0) AS cost, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens FROM ai_calls WHERE location_id = ? AND created_at >= ? AND status <> 'blocked'`,
      locationId,
      since,
    ) ?? used;
  } catch {
    /* the KI-Assistent is not built in */
  }
  const limit = s.monthly_limit_usd;
  return { used_usd: used.cost / 1e6, limit_usd: limit, remaining_usd: Math.max(0, limit - used.cost / 1e6), tokens: used.tokens, token_limit: s.monthly_token_limit, problem: budgetProblem(s, { cost_micros: used.cost, tokens: used.tokens }) };
}

/** An estimate in US dollars for tokens on this model, and whether the month's limit still has room for it. */
export function estimate(app: App, locationId: string, purpose: string, userId: string | null | undefined, t: { input: number; output: number; calls: number }) {
  const info = modelInfo(app, locationId, purpose, userId);
  const micros = info.price({ input_tokens: t.input, output_tokens: t.output, cache_read_tokens: 0, cache_write_tokens: 0 });
  const b = budget(app, locationId);
  const usd = Math.round(micros) / 1e6;
  return {
    usd,
    tokens: { input: t.input, output: t.output },
    calls: t.calls,
    model: { label: info.label, model: info.model, byok: info.byok },
    budget: { used_usd: b.used_usd, limit_usd: b.limit_usd, remaining_usd: b.remaining_usd },
    fits: !b.problem && usd <= b.remaining_usd,
    problem: b.problem ?? (usd > b.remaining_usd ? `Das Monatslimit des KI-Assistenten reicht dafür voraussichtlich nicht (geschätzt ${usd.toFixed(2)} $, frei ${b.remaining_usd.toFixed(2)} $). Das Limit lässt sich unter Einstellungen → KI-Assistent erhöhen.` : null),
  };
}

export interface Asked<T> {
  value: T;
  warnings: string[];
  attempts: number;
  tokens: number;
  cost_micros: number;
  model: string;
}

/**
 * One AI step: ask, read the JSON, check it, and on errors ask again with the list (up to three attempts). Transport and limit
 * problems (no key, limit reached, provider down) come from `aiRun` as they are – no retry. 422 with the problems at the end.
 */
export async function askChecked<T>(
  app: App,
  ctx: Ctx,
  o: { purpose: string; system: SystemBlock[]; user: string; maxTokens: number; timeoutMs: number; check: (raw: any) => { value?: T; errors: string[]; warnings: string[] }; what: string },
): Promise<Asked<T>> {
  const run = app.services.aiRun as ((i: any) => Promise<{ text: string; model: string; usage?: Usage; costMicros?: number }>) | undefined;
  if (!run) throw new HttpError(409, 'Der KI-Assistent ist nicht verfügbar.');
  const info = modelInfo(app, ctx.locationId, o.purpose, ctx.user?.id);
  let user = o.user;
  let errors: string[] = [];
  let tokens = 0;
  let cost = 0;
  let model = info.model;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const r = await run({ locationId: ctx.locationId, purpose: o.purpose, system: o.system, user, maxTokens: o.maxTokens, timeoutMs: o.timeoutMs, userId: ctx.user?.id ?? null });
    const u: Usage = { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0, cache_read_tokens: r.usage?.cache_read_tokens ?? 0, cache_write_tokens: r.usage?.cache_write_tokens ?? 0 };
    tokens += u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens;
    cost += r.costMicros ?? info.price(u);
    model = r.model || model;
    const raw = parseAnswer(r.text ?? '');
    const checked = raw ? o.check(raw) : { errors: ['Die Antwort war kein einzelnes JSON-Objekt. Antworte ausschließlich mit dem JSON-Objekt.'], warnings: [] };
    errors = checked.errors;
    if (!errors.length && checked.value !== undefined) return { value: checked.value, warnings: checked.warnings, attempts: attempt, tokens, cost_micros: Math.round(cost), model };
    user = retryText(o.user, r.text ?? '', errors);
  }
  throw new HttpError(422, `Die KI hat nach ${ATTEMPTS} Versuchen keinen gültigen ${o.what} geliefert: ${errors.slice(0, 4).join(' · ')}`);
}
