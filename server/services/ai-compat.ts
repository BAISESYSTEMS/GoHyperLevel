import { AiError, type SystemBlock, type Usage } from './anthropic.js';
import { AgentError, chatWithTools, type LlmTarget } from './agent-llm.js';
import { textCost, type FetchLike } from './ai-presets.js';
import type { Effort, EffortPlan } from './ai-effort.js';

/**
 * Quick AI texts (`aiRun` of the KI-Assistent) through any BYOK text connection: one request without
 * tools over the Anthropic Messages API or OpenAI-compatible Chat Completions. JSON answers use the
 * provider's schema/JSON mode where it has one, otherwise an instruction – and the JSON object is cut
 * out of the reply (fences, chatter), because the callers parse it strictly.
 */

export interface CompatInput {
  system: SystemBlock[];
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  /** Denkstufe and whether it is strict (Werkstatt): see services/ai-effort.ts. */
  effort?: Effort;
  strictEffort?: boolean;
}

export interface CompatResult {
  text: string;
  model: string;
  stopReason: string;
  usage: Usage;
  ms: number;
  costMicros: number;
  effort?: EffortPlan;
}

/** The first complete JSON object in a reply ("```json {…} ```", "Hier ist: {…}") or the reply itself. */
export function extractJson(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    JSON.parse(t);
    return t;
  } catch {
    /* look inside */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const inner = t.slice(start, end + 1);
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      /* not JSON */
    }
  }
  return t;
}

export async function completeText(target: LlmTarget, input: CompatInput, fetchImpl: FetchLike, app?: { baseUrl: string; name: string }): Promise<CompatResult> {
  const nativeSchema = target.wire === 'anthropic' || target.provider === 'openai' || target.provider === 'azure';
  const system = [
    ...input.system.filter((b) => b.text.trim()).map((b) => b.text),
    input.schema && !nativeSchema ? `Antworte ausschließlich mit einem gültigen JSON-Objekt (ohne Markdown, ohne Erklärung) nach diesem JSON-Schema:\n${JSON.stringify(input.schema)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const r = await chatWithTools(
      {
        connection: target,
        system,
        messages: input.messages.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
        tools: [],
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs ?? 60_000,
        schema: input.schema,
        effort: input.effort,
        strictEffort: input.strictEffort,
        app,
      },
      fetchImpl,
    );
    const text = input.schema ? extractJson(r.text) : r.text.trim();
    if (!text) throw new AiError(r.stopReason === 'length' || r.stopReason === 'max_tokens' ? 'Die Antwort der KI wurde abgeschnitten – bitte erneut versuchen.' : 'Die KI hat keinen Text geliefert.', 502, 'empty', r.usage, r.model);
    return { text, model: r.model, stopReason: r.stopReason, usage: r.usage, ms: r.ms, costMicros: textCost({ ...target, model: r.model }, r.usage), effort: r.effort };
  } catch (e) {
    if (e instanceof AgentError) throw new AiError(e.message, e.status, e.code, e.usage, target.model);
    throw e;
  }
}
