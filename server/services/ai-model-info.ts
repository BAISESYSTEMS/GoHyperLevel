/**
 * Live model lists with details: which models a provider offers, what they cost per million tokens, context size,
 * vision and tool support – for the provider gallery (Einstellungen → KI-Anbieter) and for more exact cost tracking.
 *
 * Providers describe their models differently. Every shape below was checked against the provider's real, public
 * `GET /models` answer (October 2026); a provider that sends no prices simply yields entries without them.
 *
 *   openrouter   pricing.prompt / pricing.completion = USD per TOKEN as strings, architecture.output_modalities
 *   vercel       pricing.input / pricing.output = USD per TOKEN as strings, type "language", modalities.input
 *   requesty     input_price / output_price = USD per TOKEN (numbers), api "chat", supports_vision / supports_tool_calling
 *   novita       pricing.prompt.price_per_m_decimal = USD per MILLION tokens as a string, model_type "chat"
 *   venice       model_spec.pricing.input.usd / output.usd = USD per MILLION tokens, capabilities.supportsVision
 *   sambanova    pricing.prompt / pricing.completion = USD per TOKEN as strings
 *   ovh          pricing.prompt / pricing.completion = USD per TOKEN as strings (OVHcloud AI Endpoints)
 *   featherless  pricing.prompt / pricing.completion = USD per TOKEN as strings, is_gated
 *
 * Pure functions plus a small price cache; no network, no imports from the preset file (it imports this one).
 */

export type ModelInfoKind = 'openrouter' | 'vercel' | 'requesty' | 'novita' | 'venice' | 'sambanova' | 'ovh' | 'featherless';

export interface ModelInfo {
  id: string;
  name?: string;
  /** Context window in tokens. */
  context?: number;
  /** USD per million input / output tokens – only where the provider's list says so. */
  in?: number;
  out?: number;
  free?: boolean;
  vision?: boolean;
  tools?: boolean;
}

/** Entries sent to the browser per list (Featherless alone lists more than 20 000 models). */
export const MAX_MODEL_INFOS = 1500;

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** USD per token → USD per million tokens, rounded to 4 decimals; negative values (OpenRouter's "-1" for routers) mean "no fixed price". */
const perMillion = (perToken: unknown): number | undefined => {
  const n = num(perToken);
  return n === undefined || n < 0 ? undefined : Math.round(n * 1e6 * 10_000) / 10_000;
};
const perM = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined || n < 0 ? undefined : Math.round(n * 10_000) / 10_000;
};
const posInt = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? Math.round(n) : undefined;
};
const str = (v: unknown, max = 120): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (data: any): any[] => (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []);
const has = (arr: unknown, v: string) => Array.isArray(arr) && arr.includes(v);

/** Models that are not chat models even though a provider's list mixes them in (OVHcloud has no type field). */
const NOT_CHAT = /embed|bge-|rerank|whisper|(^|[-_/])tts|stable-diffusion|flux|guard/i;

const finish = (m: ModelInfo): ModelInfo => {
  const out: ModelInfo = { id: m.id };
  for (const [k, v] of Object.entries(m)) if (v !== undefined && k !== 'id') (out as any)[k] = v;
  if (out.in === 0 && out.out === 0) out.free = true;
  return out;
};

const PARSERS: Record<ModelInfoKind, (m: any) => ModelInfo | null> = {
  openrouter: (m) => {
    const out: unknown = m.architecture?.output_modalities;
    // Image generators list "image" as an output: they are not text models.
    if (Array.isArray(out) && (!out.includes('text') || out.includes('image'))) return null;
    return { id: String(m.id), name: str(m.name), context: posInt(m.context_length), in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion), vision: has(m.architecture?.input_modalities, 'image'), tools: has(m.supported_parameters, 'tools') };
  },
  vercel: (m) => {
    if (m.type !== 'language') return null;
    return { id: String(m.id), name: str(m.name), context: posInt(m.context_window), in: perMillion(m.pricing?.input), out: perMillion(m.pricing?.output), vision: has(m.modalities?.input, 'image'), tools: has(m.supported_parameters, 'tools') || has(m.tags, 'tool-use') };
  },
  requesty: (m) => {
    if (m.api && m.api !== 'chat') return null;
    return { id: String(m.id), context: posInt(m.context_window), in: perMillion(m.input_price), out: perMillion(m.output_price), vision: !!m.supports_vision, tools: !!m.supports_tool_calling };
  },
  novita: (m) => {
    if (m.model_type && m.model_type !== 'chat') return null;
    // price_per_m_decimal is already dollars per million tokens; the integer fields are tenths of a cent.
    const pin = num(m.pricing?.prompt?.price_per_m_decimal) ?? (num(m.input_token_price_per_m) !== undefined ? num(m.input_token_price_per_m)! / 10_000 : undefined);
    const pout = num(m.pricing?.completion?.price_per_m_decimal) ?? (num(m.output_token_price_per_m) !== undefined ? num(m.output_token_price_per_m)! / 10_000 : undefined);
    return { id: String(m.id), name: str(m.display_name ?? m.title), context: posInt(m.context_size), in: perM(pin), out: perM(pout), vision: has(m.input_modalities, 'image'), tools: has(m.features, 'function-calling') };
  },
  venice: (m) => {
    if (m.type && m.type !== 'text') return null;
    const spec = m.model_spec ?? {};
    return { id: String(m.id), name: str(spec.name), context: posInt(m.context_length ?? spec.availableContextTokens), in: perM(spec.pricing?.input?.usd), out: perM(spec.pricing?.output?.usd), vision: !!spec.capabilities?.supportsVision, tools: !!spec.capabilities?.supportsFunctionCalling };
  },
  sambanova: (m) => ({ id: String(m.id), context: posInt(m.context_length), in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion) }),
  ovh: (m) => {
    const id = String(m.id);
    if (NOT_CHAT.test(id)) return null;
    return { id, context: posInt(m.context_length), in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion), vision: /(^|[-_])vl([-_]|$)|vision/i.test(id) };
  },
  featherless: (m) => {
    if (m.is_gated) return null;
    return { id: String(m.id), context: posInt(m.context_length), in: perMillion(m.pricing?.prompt), out: perMillion(m.pricing?.completion) };
  },
};

/** Details of the models in a provider's list (sorted by id, at most MAX_MODEL_INFOS). Without a known shape: ids only. */
export function parseModelInfo(kind: ModelInfoKind | undefined, data: unknown): ModelInfo[] {
  const parse = kind ? PARSERS[kind] : undefined;
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of list(data)) {
    if (!raw || typeof raw !== 'object') continue;
    let info: ModelInfo | null;
    try {
      info = parse ? parse(raw) : { id: String((raw as any).id ?? (raw as any).name ?? '').replace(/^models\//, '') };
    } catch {
      info = null;
    }
    if (!info || !info.id || info.id === 'undefined' || info.id.length > 200 || seen.has(info.id)) continue;
    seen.add(info.id);
    out.push(finish(info));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// --- prices as cost basis ----------------------------------------------------------------------------------

const prices = new Map<string, { in: number; out: number }>();
const MAX_PRICES = 60_000;

/** Remember the prices of a fresh list: the cost estimate of a call uses them unless the connection sets its own. */
export function rememberPrices(provider: string, infos: ModelInfo[]) {
  for (const m of infos) {
    if (m.in === undefined || m.out === undefined) continue;
    if (prices.size >= MAX_PRICES && !prices.has(`${provider}|${m.id}`)) continue;
    prices.set(`${provider}|${m.id}`, { in: m.in, out: m.out });
  }
}

/** USD per million tokens a provider's own list stated for a model, if a list was loaded in this process. */
export const livePrice = (provider: string, model: string): { in: number; out: number } | undefined => prices.get(`${provider}|${model}`);

/** Test hook. */
export const forgetPrices = () => prices.clear();
