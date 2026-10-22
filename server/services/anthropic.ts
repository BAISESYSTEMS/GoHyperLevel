/**
 * Minimal client for the Claude Messages API over plain fetch (no SDK dependency).
 * POST https://api.anthropic.com/v1/messages with x-api-key + anthropic-version.
 *
 * - The static part of the prompt (instructions + knowledge) goes into `system` blocks; the last one
 *   carries cache_control so repeated calls for the same sub-account read it from the prompt cache.
 * - Sonnet 5.5 / Opus 5.5 run with adaptive thinking (the default) at effort "low" – short chat
 *   replies don't need more – and opt into server-side refusal fallbacks ("default").
 * - Haiku 4.5 takes neither `effort` nor adaptive thinking, so both are left out there.
 * - Errors become German messages; usage is returned (also on refusals) so every call can be logged.
 */

import { DEFAULT_EFFORT, effortFields, isEffortRejection, planEffort, type Effort, type EffortPlan } from './ai-effort.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const MODELS_URL = 'https://api.anthropic.com/v1/models';
export const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Models the user can pick (first = default). */
export const MODELS: { id: string; label: string }[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 – schnell & günstig (empfohlen)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 – am stärksten, teurer' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 – am günstigsten, einfacher' },
];
export const DEFAULT_MODEL = MODELS[0].id;

/** USD per million tokens (5-minute cache writes = 1.25 × input). Fallback models are priced too. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

/** Cost in micro-dollars: $/MTok × tokens = µ$. Unknown models are priced like the requested one. */
export function costMicros(model: string, u: Usage, fallbackModel = DEFAULT_MODEL): number {
  const p = PRICES[model] ?? PRICES[fallbackModel] ?? PRICES[DEFAULT_MODEL];
  return Math.round(u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_tokens * p.cacheRead + u.cache_write_tokens * p.cacheWrite);
}

export interface SystemBlock {
  text: string;
  /** Put a cache breakpoint after this block (use on the last static block). */
  cache?: boolean;
}

export interface ClaudeRequest {
  apiKey: string;
  model: string;
  system: SystemBlock[];
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  /** JSON schema: the answer is constrained to it (structured outputs, output_config.format). */
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Server-side refusal fallback (on by default for the 5.5 models). */
  fallbacks?: boolean;
  /** Denkstufe (services/ai-effort.ts), default `xhigh`, lowered to what the model takes. */
  effort?: Effort;
  /** Werkstatt: never below "high", a rejection is an error. */
  strictEffort?: boolean;
}

export interface ClaudeResult {
  text: string;
  model: string;
  stopReason: string;
  usage: Usage;
  ms: number;
  /** The Denkstufe that was asked for and what the model got (services/ai-effort.ts). */
  effort?: EffortPlan;
}

/** A failed call: German message, HTTP status to answer with, and usage if tokens were billed. */
export class AiError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code = 'api_error',
    public usage: Usage = ZERO_USAGE,
    public model = '',
  ) {
    super(message);
  }
}

const supportsFallbacks = (model: string) => model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5';

/** The request body (pure, so tests can check caching, effort and format without a network). */
export function buildBody(req: ClaudeRequest, opts: { fallbacks?: boolean; skipEffort?: boolean } = {}): Record<string, unknown> {
  const system = req.system
    .filter((b) => b.text.trim())
    .map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) }));
  const outputConfig: Record<string, unknown> = {};
  Object.assign(outputConfig, effortFields('anthropic', planEffort({ provider: 'anthropic', wire: 'anthropic', model: req.model }, req.effort ?? DEFAULT_EFFORT, { strict: req.strictEffort, skip: opts.skipEffort })).output_config ?? {});
  if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system,
    messages: req.messages,
  };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if ((opts.fallbacks ?? req.fallbacks ?? true) && supportsFallbacks(req.model)) body.fallbacks = 'default';
  return body;
}

export function headersFor(apiKey: string, withFallbacks: boolean): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    ...(withFallbacks ? { 'anthropic-beta': FALLBACK_BETA } : {}),
  };
}

export function readUsage(u: any): Usage {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  return {
    input_tokens: n(u?.input_tokens),
    output_tokens: n(u?.output_tokens),
    cache_read_tokens: n(u?.cache_read_input_tokens),
    cache_write_tokens: n(u?.cache_creation_input_tokens),
  };
}

/** HTTP status from Anthropic → German message (and the status we answer with). */
export function apiError(status: number, message: string): AiError {
  const detail = message ? `: ${message.slice(0, 200)}` : '';
  switch (status) {
    case 400:
      return new AiError(`Anthropic hat die Anfrage abgelehnt${detail}`, 502, 'invalid_request');
    case 401:
      return new AiError('Anthropic-API-Schlüssel ist ungültig. Bitte unter Einstellungen → KI-Assistent prüfen.', 502, 'auth');
    case 402:
      return new AiError('Anthropic-Konto hat ein Zahlungsproblem (Guthaben leer?). Bitte in der Anthropic Console prüfen.', 502, 'billing');
    case 403:
      return new AiError('Dieser API-Schlüssel darf das gewählte Modell nicht nutzen.', 502, 'permission');
    case 404:
      return new AiError('Das gewählte Modell ist für diesen Schlüssel nicht verfügbar.', 502, 'not_found');
    case 413:
      return new AiError('Die Anfrage an die KI ist zu groß – bitte Wissen kürzen.', 502, 'too_large');
    case 429:
      return new AiError('Zu viele Anfragen bei Anthropic – bitte kurz warten und erneut versuchen.', 429, 'rate_limit');
    case 529:
      return new AiError('Anthropic ist gerade überlastet – bitte gleich noch einmal versuchen.', 503, 'overloaded');
    default:
      return status >= 500 ? new AiError('Anthropic hat gerade ein Problem – bitte später erneut versuchen.', 503, 'server') : new AiError(`Fehler von Anthropic (${status})${detail}`, 502, 'api_error');
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pause before the single retry on 5xx/529 (tests lower it). */
export const retry = { ms: 800 };

/** One Messages API call with one retry on overload, German errors and usage on every outcome. */
export async function callClaude(req: ClaudeRequest, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<ClaudeResult> {
  const started = Date.now();
  let fallbacks = req.fallbacks ?? true;
  let skipEffort = false;
  const planOf = () => planEffort({ provider: 'anthropic', wire: 'anthropic', model: req.model }, req.effort ?? DEFAULT_EFFORT, { strict: req.strictEffort, skip: skipEffort });
  for (let attempt = 0; ; attempt++) {
    const body = buildBody(req, { fallbacks, skipEffort });
    const withFallbacks = 'fallbacks' in body;
    let r: Response;
    try {
      r = await fetchImpl(API_URL, { method: 'POST', headers: headersFor(req.apiKey, withFallbacks), body: JSON.stringify(body), signal: AbortSignal.timeout(req.timeoutMs ?? 60_000) });
    } catch (e) {
      const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      throw new AiError(timeout ? 'Die KI hat nicht rechtzeitig geantwortet – bitte erneut versuchen.' : 'Anthropic ist nicht erreichbar – bitte Internetverbindung des Servers prüfen.', 504, timeout ? 'timeout' : 'network');
    }
    const raw = await r.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) {
      const msg = String(data?.error?.message ?? '').trim();
      // Orgs without the fallback beta get a 400 naming it: send the same request once without it.
      if (r.status === 400 && withFallbacks && /anthropic-beta|fallback/i.test(msg)) {
        fallbacks = false;
        continue;
      }
      if ((r.status >= 500 || r.status === 529) && attempt === 0) {
        await sleep(retry.ms);
        continue;
      }
      const plan = planOf();
      if (plan.sent && isEffortRejection(r.status, msg)) {
        if (!req.strictEffort) {
          skipEffort = true;
          continue;
        }
        throw new AiError(`Anthropic: Das Modell „${req.model}“ nimmt die Denkstufe „${plan.applied}“ nicht an (${msg.slice(0, 160)}). Bitte ein anderes Modell wählen oder die Denkstufe unter Einstellungen → KI-Anbieter → Denkstufe ändern.`, 400, 'effort_rejected', ZERO_USAGE, req.model);
      }
      throw apiError(r.status, msg);
    }
    if (!data || !Array.isArray(data.content)) throw new AiError('Unerwartete Antwort von Anthropic.', 502, 'bad_response');
    const usage = readUsage(data.usage);
    const model = String(data.model || req.model);
    const stopReason = String(data.stop_reason ?? '');
    if (stopReason === 'refusal') throw new AiError('Die KI hat diese Anfrage aus Sicherheitsgründen abgelehnt.', 422, 'refusal', usage, model);
    const text = data.content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
      .trim();
    if (!text) throw new AiError(stopReason === 'max_tokens' ? 'Die Antwort der KI wurde abgeschnitten – bitte erneut versuchen.' : 'Die KI hat keinen Text geliefert.', 502, 'empty', usage, model);
    return { text, model, stopReason, usage, ms: Date.now() - started, effort: planOf() };
  }
}

/** Checks a key without spending tokens (GET /v1/models/{model}). */
export async function checkKey(apiKey: string, model: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<{ model: string; name: string }> {
  let r: Response;
  try {
    r = await fetchImpl(`${MODELS_URL}/${encodeURIComponent(model)}`, { method: 'GET', headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AiError('Anthropic ist nicht erreichbar – bitte Internetverbindung des Servers prüfen.', 504, 'network');
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok) throw apiError(r.status, String(data?.error?.message ?? ''));
  return { model: String(data?.id ?? model), name: String(data?.display_name ?? model) };
}
