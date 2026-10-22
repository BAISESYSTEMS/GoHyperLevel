import { AiError, ZERO_USAGE, type SystemBlock, type Usage } from './anthropic.js';

/**
 * Minimal client for the OpenAI Responses API over plain fetch (no SDK dependency).
 * POST https://api.openai.com/v1/responses with a Bearer key.
 *
 * - The static part of the prompt (instructions + knowledge) goes into `instructions`, the request
 *   into `input` – OpenAI caches long, identical prefixes automatically (cached input is cheaper).
 * - Reasoning models (gpt-5 family, o-series) run with reasoning effort "low"; short replies don't need more.
 * - JSON answers use Structured Outputs (`text.format` = json_schema, strict when the schema allows it).
 * - `store: false`: OpenAI does not keep the conversation for later retrieval.
 * - Errors become German messages; usage is returned (also on refusals) so every call can be logged.
 */

import { DEFAULT_EFFORT, effortFields, isEffortRejection, planEffort, type Effort, type EffortPlan } from './ai-effort.js';

export const API_URL = 'https://api.openai.com/v1/responses';
export const MODELS_URL = 'https://api.openai.com/v1/models';

/** Models offered in the picker (first = default). Any other model id can be typed in. */
export const MODELS: { id: string; label: string }[] = [
  { id: 'gpt-5-mini', label: 'GPT-5 mini – schnell & günstig (empfohlen)' },
  { id: 'gpt-5.1', label: 'GPT-5.1 – am stärksten, teurer' },
  { id: 'gpt-5-nano', label: 'GPT-5 nano – am günstigsten, einfacher' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini – ohne Nachdenken, sehr schnell (Chat, Telefon)' },
];
export const DEFAULT_MODEL = MODELS[0].id;

/** USD per million tokens. Unknown models are priced carefully, like an expensive one. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
};
const UNKNOWN_PRICE = { input: 2, output: 10, cacheRead: 0.5 };

/** "gpt-5-mini-2025-08-07" → price of "gpt-5-mini" (longest known prefix). */
export function priceOf(model: string) {
  const known = Object.keys(PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return known ? PRICES[known] : UNKNOWN_PRICE;
}

/** Cost in micro-dollars ($/MTok × tokens = µ$). */
export function costMicros(model: string, u: Usage): number {
  const p = priceOf(model);
  return Math.round(u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_tokens * p.cacheRead);
}

/** sk-… or sk-proj-… keys. */
export const KEY_RE = /^sk-[A-Za-z0-9_-]{20,}$/;
/** Model ids as OpenAI writes them (gpt-5-mini, gpt-4.1, o4-mini, ft:gpt-4.1:org::id …). */
export const MODEL_RE = /^[a-z0-9][a-z0-9._:-]{1,99}$/i;

export interface OpenAiRequest {
  apiKey: string;
  model: string;
  system: SystemBlock[];
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  /** JSON schema: the answer is constrained to it (Structured Outputs). */
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Denkstufe (services/ai-effort.ts), default `xhigh`, lowered to what the model takes. */
  effort?: Effort;
  /** Werkstatt: never below "high", a rejection is an error. */
  strictEffort?: boolean;
}

export interface OpenAiResult {
  text: string;
  model: string;
  stopReason: string;
  usage: Usage;
  ms: number;
  costMicros: number;
  /** The Denkstufe that was asked for and what the model got (services/ai-effort.ts). */
  effort?: EffortPlan;
}

const STRICT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', '$ref', '$defs', 'description', 'const', 'pattern', 'format', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems', 'title']);

/** Strict Structured Outputs need closed objects with every property required and a limited keyword set. */
export function strictCompatible(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, any>;
  if (Object.keys(s).some((k) => !STRICT_KEYS.has(k))) return false;
  if (s.type === 'object' || s.properties) {
    if (s.additionalProperties !== false) return false;
    const props = Object.keys(s.properties ?? {});
    const req: string[] = Array.isArray(s.required) ? s.required : [];
    if (props.length !== req.length || props.some((p) => !req.includes(p))) return false;
    if (!props.every((p) => strictCompatible(s.properties[p]))) return false;
  }
  if (s.items !== undefined && !strictCompatible(s.items)) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.every(strictCompatible)) return false;
  if (s.$defs && !Object.values(s.$defs).every(strictCompatible)) return false;
  return true;
}

/** The request body (pure, so tests can check format, reasoning and JSON mode without a network). */
export function buildBody(req: OpenAiRequest, opts: { skipEffort?: boolean } = {}): Record<string, unknown> {
  const instructions = req.system
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.messages.map((m) => ({ role: m.role, content: m.content })),
    max_output_tokens: req.maxTokens,
    store: false,
  };
  if (instructions) body.instructions = instructions;
  Object.assign(body, effortFields('responses', planEffort({ provider: 'openai', wire: 'openai', model: req.model }, req.effort ?? DEFAULT_EFFORT, { strict: req.strictEffort, skip: opts.skipEffort })));
  if (req.schema) body.text = { format: { type: 'json_schema', name: 'antwort', schema: req.schema, strict: strictCompatible(req.schema) } };
  return body;
}

export function readUsage(u: any): Usage {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const cached = n(u?.input_tokens_details?.cached_tokens);
  return { input_tokens: Math.max(0, n(u?.input_tokens) - cached), output_tokens: n(u?.output_tokens), cache_read_tokens: cached, cache_write_tokens: 0 };
}

/** HTTP status (+ error code) from OpenAI → German message and the status we answer with. */
export function apiError(status: number, message: string, code = ''): AiError {
  const detail = message ? `: ${message.slice(0, 200)}` : '';
  if (code === 'insufficient_quota') return new AiError('OpenAI-Konto hat kein Guthaben mehr (insufficient_quota). Bitte unter platform.openai.com → Billing prüfen.', 502, 'billing');
  switch (status) {
    case 400:
      return new AiError(`OpenAI hat die Anfrage abgelehnt${detail}`, 502, 'invalid_request');
    case 401:
      return new AiError('OpenAI-API-Schlüssel ist ungültig. Bitte unter Einstellungen → KI-Assistent prüfen.', 502, 'auth');
    case 403:
      return new AiError('Dieser OpenAI-Schlüssel darf das gewählte Modell nicht nutzen (Projekt- oder Organisationsrechte prüfen).', 502, 'permission');
    case 404:
      return new AiError('Das gewählte OpenAI-Modell ist für diesen Schlüssel nicht verfügbar.', 502, 'not_found');
    case 413:
      return new AiError('Die Anfrage an die KI ist zu groß – bitte Wissen kürzen.', 502, 'too_large');
    case 429:
      return new AiError('Zu viele Anfragen bei OpenAI – bitte kurz warten und erneut versuchen.', 429, 'rate_limit');
    default:
      return status >= 500 ? new AiError('OpenAI hat gerade ein Problem – bitte später erneut versuchen.', 503, 'server') : new AiError(`Fehler von OpenAI (${status})${detail}`, 502, 'api_error');
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Pause before the single retry on 5xx (tests lower it). */
export const retry = { ms: 800 };

/** Text of the assistant message(s); a refusal part counts as refusal. */
function outputOf(data: any): { text: string; refusal: string } {
  let text = '';
  let refusal = '';
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
      else if (part?.type === 'refusal') refusal += String(part.refusal ?? '');
    }
  }
  if (!text && typeof data?.output_text === 'string') text = data.output_text;
  return { text: text.trim(), refusal: refusal.trim() };
}

/** One Responses API call with one retry on server errors, German errors and usage on every outcome. */
export async function callOpenAi(req: OpenAiRequest, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<OpenAiResult> {
  const started = Date.now();
  let skipEffort = false;
  const planOf = () => planEffort({ provider: 'openai', wire: 'openai', model: req.model }, req.effort ?? DEFAULT_EFFORT, { strict: req.strictEffort, skip: skipEffort });
  for (let attempt = 0; ; attempt++) {
    const body = buildBody(req, { skipEffort });
    let r: Response;
    try {
      r = await fetchImpl(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(req.timeoutMs ?? 60_000) });
    } catch (e) {
      const timeout = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
      throw new AiError(timeout ? 'Die KI hat nicht rechtzeitig geantwortet – bitte erneut versuchen.' : 'OpenAI ist nicht erreichbar – bitte Internetverbindung des Servers prüfen.', 504, timeout ? 'timeout' : 'network', ZERO_USAGE, req.model);
    }
    const raw = await r.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    if (!r.ok) {
      if (r.status >= 500 && attempt === 0) {
        await sleep(retry.ms);
        continue;
      }
      const msg = String(data?.error?.message ?? '').trim();
      const plan = planOf();
      if (plan.sent && isEffortRejection(r.status, msg)) {
        if (!req.strictEffort) {
          skipEffort = true;
          continue;
        }
        throw new AiError(`OpenAI: Das Modell „${req.model}“ nimmt die Denkstufe „${plan.applied}“ nicht an (${msg.slice(0, 160)}). Bitte ein anderes Modell wählen oder die Denkstufe unter Einstellungen → KI-Anbieter → Denkstufe ändern.`, 400, 'effort_rejected', ZERO_USAGE, req.model);
      }
      const e = apiError(r.status, msg, String(data?.error?.code ?? ''));
      e.model = req.model;
      throw e;
    }
    if (!data || !Array.isArray(data.output)) throw new AiError('Unerwartete Antwort von OpenAI.', 502, 'bad_response', ZERO_USAGE, req.model);
    const usage = readUsage(data.usage);
    const model = String(data.model || req.model);
    const { text, refusal } = outputOf(data);
    const incomplete = data.status === 'incomplete' ? String(data.incomplete_details?.reason ?? 'incomplete') : '';
    const stopReason = refusal ? 'refusal' : incomplete || String(data.status ?? 'completed');
    if (refusal || incomplete === 'content_filter') throw new AiError('Die KI hat diese Anfrage aus Sicherheitsgründen abgelehnt.', 422, 'refusal', usage, model);
    if (!text) throw new AiError(incomplete === 'max_output_tokens' ? 'Die Antwort der KI wurde abgeschnitten – bitte erneut versuchen.' : 'Die KI hat keinen Text geliefert.', 502, 'empty', usage, model);
    if (incomplete === 'max_output_tokens' && req.schema) throw new AiError('Die Antwort der KI wurde abgeschnitten – bitte erneut versuchen.', 502, 'empty', usage, model);
    return { text, model, stopReason, usage, ms: Date.now() - started, costMicros: costMicros(model, usage), effort: planOf() };
  }
}

/** Checks a key without spending tokens (GET /v1/models/{model}). */
export async function checkKey(apiKey: string, model: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<{ model: string; name: string }> {
  let r: Response;
  try {
    r = await fetchImpl(`${MODELS_URL}/${encodeURIComponent(model)}`, { method: 'GET', headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AiError('OpenAI ist nicht erreichbar – bitte Internetverbindung des Servers prüfen.', 504, 'network');
  }
  const data: any = await r.json().catch(() => null);
  if (!r.ok) throw apiError(r.status, String(data?.error?.message ?? ''), String(data?.error?.code ?? ''));
  return { model: String(data?.id ?? model), name: String(data?.id ?? model) };
}
