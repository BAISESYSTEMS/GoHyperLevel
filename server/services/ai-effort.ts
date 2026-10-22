/**
 * "Denkstufe": how hard a model is asked to think (reasoning effort). One global default – `xhigh` – with an optional
 * override per capability (agent chat, Werkstatt, review, quick texts, summaries, voice agent), kept in the KI-Anbieter
 * registry (modules/ai-connections.ts). This file is the pure part: which level a model can take, what is sent to which
 * provider, and the plain-language note when a model cannot do what was asked.
 *
 *   Anthropic           output_config.effort                 (Claude 5 family; Haiku has none)
 *   OpenAI (Responses)  reasoning.effort                      (gpt-5 / o-series / gpt-6)
 *   OpenAI-compatible   reasoning_effort                      (Chat Completions: OpenAI, Azure, Gemini's layer, …)
 *   OpenRouter          reasoning: { effort }                 (their unified parameter)
 *
 * A model that cannot take the requested level gets its highest supported one ("xhigh → high, vom Modell nicht
 * unterstützt"). For the Werkstatt (`strict`) the level is never below "high" and the parameter is always sent – if the
 * provider then rejects it, the call fails with a clear message instead of quietly thinking less.
 */

export const EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'xhigh';
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
const RANK: Record<Effort, number> = { low: 1, medium: 2, high: 3, xhigh: 4 };
export const lower = (a: Effort, b: Effort): Effort => (RANK[a] <= RANK[b] ? a : b);
export const atLeast = (a: Effort, min: Effort): Effort => (RANK[a] >= RANK[min] ? a : min);
export const EFFORT_LABELS: Record<Effort, string> = { low: 'niedrig', medium: 'mittel', high: 'hoch', xhigh: 'maximal (xhigh)' };

/** What the Denkstufe can be set for. `werkstatt` and `review` are always strict. */
export const EFFORT_CAPS = [
  { id: 'agent', label: 'KI-Agent (Chat & Werkzeuge)' },
  { id: 'werkstatt', label: 'Werkstatt: Bauen, Ändern, Kernfeature-Vorschläge' },
  { id: 'review', label: 'Werkstatt: Sicherheitsprüfung und Zweitmeinung' },
  { id: 'text', label: 'Schnelle KI-Texte (KI-Assistent, Workflows …)' },
  { id: 'summary', label: 'Zusammenfassungen' },
  { id: 'voice', label: 'KI-Telefonagent' },
] as const;
export type EffortCap = (typeof EFFORT_CAPS)[number]['id'];
export const EFFORT_CAP_IDS = EFFORT_CAPS.map((c) => c.id) as EffortCap[];
export const isEffortCap = (v: unknown): v is EffortCap => typeof v === 'string' && (EFFORT_CAP_IDS as string[]).includes(v);
export const EFFORT_COST_NOTE = 'Eine höhere Denkstufe kostet mehr Tokens und dauert länger – dafür sind die Ergebnisse besser. Für Telefonagent und schnelle Texte lohnt sich oft eine niedrigere Stufe.';

/** Which capability an `aiRun` purpose belongs to (decides its Denkstufe and whether it is strict). */
export function capOfPurpose(purpose: string): EffortCap {
  if (purpose === 'werkstatt_review' || purpose === 'werkstatt_review2') return 'review';
  if (purpose.startsWith('werkstatt')) return 'werkstatt';
  if (purpose === 'summary') return 'summary';
  if (purpose === 'voice_agent') return 'voice';
  return 'text';
}
export const isStrictCap = (cap: EffortCap) => cap === 'werkstatt' || cap === 'review';

export interface ModelRef {
  provider: string;
  model: string;
  wire?: string;
}

/** Model id without a vendor prefix (OpenRouter: "anthropic/claude-opus-5-5"), lower case, dots as dashes. */
export const bareModel = (model: string) => String(model ?? '').toLowerCase().replace(/^[a-z0-9._-]+\//, '').replace(/(\d)\.(\d)/g, '$1-$2');

const version = (m: string, family: RegExp): [number, number] | null => {
  const x = family.exec(m);
  return x ? [Number(x[1]), x[2] === undefined ? 0 : Number(x[2])] : null;
};

/** The highest level the model takes, or null when it has no reasoning control (or none we know of). */
export function maxEffort(c: ModelRef): Effort | null {
  const m = bareModel(c.model);
  if (c.wire === 'anthropic' || m.startsWith('claude')) {
    if (m.includes('haiku')) return null;
    const v = version(m, /(?:opus|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/);
    if (v) return v[0] > 5 || (v[0] === 5 && v[1] >= 5) ? 'xhigh' : 'high';
    return /sonnet-5|opus/.test(m) ? 'high' : null;
  }
  if (/(^|[-_])astra/.test(m)) return 'xhigh';
  const gpt = version(m, /^gpt-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (gpt) {
    if (/-chat/.test(m)) return null;
    if (gpt[0] >= 6) return 'xhigh';
    if (gpt[0] === 5) return gpt[1] >= 1 ? 'xhigh' : 'high';
    return null;
  }
  if (/^o\d/.test(m)) return 'high';
  if (c.provider === 'gemini' || /gemini-(2-5|3)/.test(m)) return 'high';
  return null;
}

export interface EffortPlan {
  requested: Effort;
  /** The level that is sent; null = the model has no Denkstufe (nothing is sent). */
  applied: Effort | null;
  sent: boolean;
  /** Plain language for the build log and the settings, empty when all is as asked. */
  note: string;
}

export function planEffort(c: ModelRef, want: Effort, o: { strict?: boolean; skip?: boolean } = {}): EffortPlan {
  let requested = want;
  let note = '';
  // An everyday call whose provider refused the level is repeated once without it (never for the Werkstatt).
  if (o.skip && !o.strict) return { requested, applied: null, sent: false, note: `${requested} → ohne Denkstufe wiederholt, der Anbieter hat sie abgelehnt` };
  if (o.strict && RANK[want] < RANK.high) {
    requested = 'high';
    note = `${want} → high (Mindeststufe der Werkstatt). `;
  }
  const max = maxEffort(c);
  if (!max) {
    // The Werkstatt always asks for reasoning; everyday calls only where the model is known to take it.
    if (o.strict) return { requested, applied: lower(requested, 'high'), sent: true, note: `${note}${requested === 'xhigh' ? 'xhigh → high (Modell nicht bekannt, höchste sichere Stufe)' : ''}`.trim() };
    return { requested, applied: null, sent: false, note: 'Modell ohne Denkstufe' };
  }
  const applied = lower(requested, max);
  if (applied !== requested) note += `${requested} → ${applied}, vom Modell nicht unterstützt`;
  return { requested, applied, sent: true, note: note.trim() };
}

export type EffortKind = 'anthropic' | 'responses' | 'openrouter' | 'chat';

/** The wire kind a provider takes the level in. */
export const effortKind = (c: ModelRef, api: 'messages' | 'responses' | 'chat'): EffortKind => (api === 'messages' ? 'anthropic' : api === 'responses' ? 'responses' : c.provider === 'openrouter' ? 'openrouter' : 'chat');

/** The request fields for a plan (merged into the body by the adapters). */
export function effortFields(kind: EffortKind, plan: EffortPlan): Record<string, unknown> {
  if (!plan.sent || !plan.applied) return {};
  switch (kind) {
    case 'anthropic':
      return { output_config: { effort: plan.applied } };
    case 'responses':
    case 'openrouter':
      return { reasoning: { effort: plan.applied } };
    default:
      return { reasoning_effort: plan.applied };
  }
}

/** Does an error answer say the Denkstufe was the problem? */
export const isEffortRejection = (status: number, message: string) => (status === 400 || status === 422) && /reasoning|effort|thinking|xhigh/i.test(message);
