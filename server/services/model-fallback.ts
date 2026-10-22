import { ZERO_USAGE, type Usage } from './anthropic.js';
import { AgentError, chatWithTools, type ChatRequest, type ChatResult } from './agent-llm.js';
import type { FetchLike, Resolved } from './ai-presets.js';

/**
 * Ersatzmodelle – the intelligence must not collapse when one model fails (docs/agent.md#ersatzmodelle). A failing provider
 * (5xx "Internal error", 429, "overloaded", kie.ai's "no_available_account", a timeout or a dropped connection) no longer ends the
 * run: the request is retried once (HTTP 429/5xx inside chatWithTools, a broken stream or an error envelope here), then the next
 * model of the same connection is tried – the routing's `fallbacks` list of that usage, or the provider's default order
 * (kie.ai: claude-sonnet-5-5 → claude-sonnet-5 → claude-haiku-5-5) –, then the sub-account's other text connections. Which model
 * answered is reported (`onAttempt`, the agent's "model" event and the AI-call log). Errors that a new model cannot fix (bad key,
 * billing, refusal, the person stopped it) end the run as before. Text that was already streamed is never repeated by a second
 * model: once words reached the person, a failure is final.
 */

/** Default fallback order per provider (same connection) when the routing names none. */
export const DEFAULT_FALLBACKS: Record<string, string[]> = {
  kie_llm: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5'],
};
/** At most this many fallback targets after the primary one. */
export const MAX_FALLBACKS = 6;
/** Fallback models stored per usage in the routing. */
export const MAX_ROUTING_FALLBACKS = 5;

/** Codes of a provider that is (probably) only busy or briefly broken. */
const RETRYABLE_CODES = new Set(['rate_limit', 'overloaded', 'server', 'timeout', 'network', 'stream_error', 'bad_response', 'upstream', 'all_failed']);
/** Failures without an HTTP status of their own (chatWithTools already retried HTTP 429/5xx once): retried once on the same model. */
const RETRY_SAME = new Set(['network', 'stream_error', 'bad_response', 'upstream']);
const RETRYABLE_TEXT = /no_available_account|internal (server )?error|overloaded|temporarily unavailable|service unavailable|rate.?limit|too many requests|timed? ?out|econnreset|socket hang up/i;
/** Never worth another model: the key, the bill, a refusal or the person stopping it. */
const FINAL_CODES = new Set(['auth', 'billing', 'refusal', 'aborted', 'too_large', 'effort_rejected']);

/** Is this a provider failure another attempt or model may get past? Pure. */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = String((e as { code?: unknown }).code ?? '');
  if (FINAL_CODES.has(code)) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  return RETRYABLE_TEXT.test(e.message);
}

/** On a fallback model a missing model id or a model the key may not use only skips to the next one. Pure. */
const skippable = (e: unknown) => isRetryable(e) || ['not_found', 'permission', 'invalid_request'].includes(String((e as { code?: unknown })?.code ?? ''));

/** Clean model ids for a routing's `fallbacks` (array or comma separated), at most MAX_ROUTING_FALLBACKS, unique. Pure. */
export function cleanFallbacks(v: unknown, modelRe: RegExp): string[] {
  const list = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  for (const m of list) if (!modelRe.test(m)) throw new Error(`Ersatzmodell „${m.slice(0, 60)}“: bitte die Modell-ID des Anbieters.`);
  if (list.length > MAX_ROUTING_FALLBACKS) throw new Error(`Höchstens ${MAX_ROUTING_FALLBACKS} Ersatzmodelle`);
  return [...new Set(list)];
}

/**
 * The chain after the primary target: the same connection with the fallback models (the routing's list, else the provider's default
 * order; the primary model itself skipped), then the other text connections with their own default model. Pure.
 */
export function fallbackChain(primary: Resolved, o: { models?: string[] | null; others?: Resolved[]; max?: number }): Resolved[] {
  const out: Resolved[] = [];
  const models = o.models?.length ? o.models : (DEFAULT_FALLBACKS[primary.provider] ?? []);
  for (const m of models) if (m && m !== primary.model && !out.some((x) => x.model === m)) out.push({ ...primary, model: m });
  const seen = new Set([primary.connectionId]);
  for (const c of o.others ?? []) {
    if (seen.has(c.connectionId) || (c.wire !== 'anthropic' && c.wire !== 'openai')) continue;
    seen.add(c.connectionId);
    out.push(c);
  }
  return out.slice(0, o.max ?? MAX_FALLBACKS);
}

export interface Attempt {
  target: Resolved;
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  code?: string;
  usage: Usage;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pause before retrying a broken stream (tests lower it). */
export const fallbackPause = { ms: 600 };

/** `provider:model` for logs and the "model" event. */
export const targetLabel = (t: Pick<Resolved, 'provider' | 'model' | 'label'>) => `${t.label || t.provider} · ${t.model}`;

/**
 * One model turn through the chain: each target is tried (a broken stream or an error envelope once more on the same model), the
 * first answer wins. The primary target only hands over on a retryable failure; a fallback target skips on any provider error. When
 * every target failed, the first failure is thrown with code `all_failed` (its message names the models tried).
 */
export async function chatWithFallback(
  req: ChatRequest,
  targets: Resolved[],
  fetchFor: (t: Resolved) => FetchLike,
  o: { onAttempt?: (a: Attempt) => void } = {},
): Promise<{ result: ChatResult; target: Resolved; attempts: Attempt[] }> {
  if (!targets.length) throw new AgentError('Kein Text-Modell verbunden.', 409, 'no_model');
  const attempts: Attempt[] = [];
  let streamed = false;
  const onText = req.onText
    ? (delta: string) => {
        if (delta) streamed = true;
        req.onText!(delta);
      }
    : undefined;
  let first: AgentError | null = null;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    for (let retry = 0; retry < 2; retry++) {
      const started = Date.now();
      try {
        const result = await chatWithTools({ ...req, connection: target, onText }, fetchFor(target));
        const a: Attempt = { target, provider: target.provider, model: result.model || target.model, ok: true, usage: result.usage, ms: result.ms };
        attempts.push(a);
        o.onAttempt?.(a);
        return { result, target, attempts };
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError((e as Error).message || 'Fehler', 502, (e as { code?: string }).code ?? 'api_error');
        const a: Attempt = { target, provider: target.provider, model: target.model, ok: false, error: err.message, code: err.code, usage: err.usage ?? ZERO_USAGE, ms: Date.now() - started };
        attempts.push(a);
        o.onAttempt?.(a);
        first ??= err;
        // words already reached the person, or they stopped it: no second voice
        if (streamed || req.signal?.aborted || err.code === 'aborted') throw err;
        if (i === 0 && !isRetryable(err)) throw err;
        if (i > 0 && !skippable(err)) throw err;
        if (retry === 0 && RETRY_SAME.has(err.code)) {
          await sleep(fallbackPause.ms);
          continue;
        }
        break;
      }
    }
  }
  const tried = [...new Set(attempts.map((a) => a.model))].join(', ');
  const f = first!;
  throw new AgentError(targets.length > 1 ? `${f.message} Auch die Ersatzmodelle haben nicht geantwortet (versucht: ${tried}).` : f.message, f.status, 'all_failed', f.usage);
}
