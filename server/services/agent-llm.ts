import { ZERO_USAGE, readUsage, type Usage } from './anthropic.js';
import { chatEndpoint, presetById, type FetchLike, type Resolved } from './ai-presets.js';
import { DEFAULT_EFFORT, effortFields, effortKind, isEffortRejection, planEffort, type Effort, type EffortPlan } from './ai-effort.js';

/**
 * Provider-agnostic chat with tool use for the HyperLevel Agent: one neutral message format, two wire
 * adapters (Anthropic Messages API and OpenAI-compatible Chat Completions), streaming over SSE with
 * a small parser, usage in one shape and German errors. No SDKs – plain fetch (test hook:
 * `app.services.agentFetch`).
 *
 *   chatWithTools({ connection, system, messages, tools, stream: true, onText }) → { message, text, toolCalls, usage }
 */

/** One piece of a message. `thinking` keeps Anthropic's thinking blocks verbatim (they must be sent back in tool loops). */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string; fileId?: string }
  /** A PDF the model reads itself (Anthropic documents; OpenAI file input) – used by the accounting's receipt reader. */
  | { type: 'document'; mediaType: string; data: string; name?: string }
  | { type: 'file'; fileId: string; name: string; mime: string; preview: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string; isError?: boolean; meta?: Record<string, unknown> }
  | { type: 'thinking'; raw: Record<string, unknown> };

export interface Msg {
  role: 'user' | 'assistant';
  content: Part[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The model's arguments were not valid JSON. */
  badArgs?: boolean;
}

/** Where a chat goes: a resolved BYOK connection (services/ai-presets.ts). `vision` overrides the capability. */
export type LlmTarget = Pick<Resolved, 'provider' | 'baseUrl' | 'model' | 'headers' | 'options' | 'wire'> & { capabilities?: string[]; label?: string; vision?: boolean };

const labelOf = (t: { provider: string; label?: string }) => t.label || presetById(t.provider)?.label || t.provider;
const visionOf = (t: LlmTarget) => t.vision ?? (t.capabilities ? t.capabilities.includes('vision') : !!presetById(t.provider)?.capabilities.includes('vision'));

export interface ChatRequest {
  connection: LlmTarget;
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  stream?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Streamed text as it arrives. */
  onText?: (delta: string) => void;
  /** Which app sends the request (OpenRouter headers). */
  app?: { baseUrl: string; name: string };
  /** JSON schema the answer must follow (quick AI texts); providers without schema support get JSON mode. */
  schema?: Record<string, unknown>;
  /** How hard the model thinks (services/ai-effort.ts); default `xhigh`, lowered to what the model takes. */
  effort?: Effort;
  /** Werkstatt: never below "high", always sent, a rejection is an error (no silent downgrade). */
  strictEffort?: boolean;
}

/** The Denkstufe this request is sent with (pure; also used to explain a rejection). */
export const effortPlanOf = (req: Pick<ChatRequest, 'connection' | 'effort' | 'strictEffort'>, skip = false): EffortPlan => planEffort(req.connection, req.effort ?? DEFAULT_EFFORT, { strict: req.strictEffort, skip });

/** Providers whose Chat Completions take response_format json_object (others only get the instruction). */
const JSON_MODE = new Set(['openrouter', 'groq', 'together', 'fireworks', 'deepseek', 'mistral', 'xai', 'gemini', 'litellm', 'ollama', 'lmstudio', 'cerebras', 'huggingface', 'custom']);

export interface ChatResult {
  message: Msg;
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage: Usage;
  model: string;
  ms: number;
  /** Usage was estimated from the text length (the server sent none). */
  estimated?: boolean;
  /** The Denkstufe that was asked for and what the model got (services/ai-effort.ts). */
  effort?: EffortPlan;
}

/** A failed model call: German message, HTTP status to answer with, usage if tokens were billed. */
export class AgentError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code = 'api_error',
    public usage: Usage = ZERO_USAGE,
  ) {
    super(message);
  }
}

/** Pause before the single retry on 429/5xx (tests lower it). */
export const retry = { ms: 900 };

// --- SSE ------------------------------------------------------------------------------------------

/** Server-sent events from a byte stream: `{event, data}` per blank-line separated block. */
export async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  const flush = function* (final: boolean) {
    buf = buf.replace(/\r\n?/g, (m, off: number) => (m === '\r' && off === buf.length - 1 && !final ? '\r' : '\n'));
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = parseBlock(block);
      if (ev) yield ev;
    }
    if (final && buf.trim()) {
      const ev = parseBlock(buf);
      buf = '';
      if (ev) yield ev;
    }
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    yield* flush(false);
  }
  buf += decoder.decode();
  yield* flush(true);
}

function parseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

// --- neutral → wire -------------------------------------------------------------------------------

const textOfFile = (p: Extract<Part, { type: 'file' }>) => `[Datei „${p.name}“ (${p.mime}), file_id: ${p.fileId}]\n${p.preview}`;

/** Messages in Anthropic's format (tool results first in a user turn, thinking blocks replayed as they came). */
export function toAnthropic(messages: Msg[], vision: boolean): any[] {
  const out: any[] = [];
  for (const m of messages) {
    const blocks: any[] = [];
    if (m.role === 'user') {
      for (const p of m.content) if (p.type === 'tool_result') blocks.push({ type: 'tool_result', tool_use_id: p.id, content: p.content || '(leer)', ...(p.isError ? { is_error: true } : {}) });
      for (const p of m.content) {
        if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'file') blocks.push({ type: 'text', text: textOfFile(p) });
        else if (p.type === 'image') blocks.push(vision ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } } : { type: 'text', text: `[Bild „${p.name ?? 'Bild'}“ – dieses Modell kann keine Bilder sehen]` });
        else if (p.type === 'document') blocks.push({ type: 'document', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
      }
    } else {
      for (const p of m.content) {
        if (p.type === 'thinking') blocks.push(p.raw);
        else if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'tool_call') blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.args ?? {} });
      }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '…' });
    // Consecutive turns of the same role are merged (the API wants them alternating).
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  return out;
}

/** Messages in the Chat Completions format (tool results become role "tool"). */
export function toOpenAI(messages: Msg[], vision: boolean, documents = false): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
      const calls = m.content.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      out.push({ role: 'assistant', content: text || (calls.length ? null : '…'), ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}) });
      continue;
    }
    for (const p of m.content) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.id, content: p.content || '(leer)' });
    const parts: any[] = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text) parts.push({ type: 'text', text: p.text });
      else if (p.type === 'file') parts.push({ type: 'text', text: textOfFile(p) });
      else if (p.type === 'image') parts.push(vision ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } } : { type: 'text', text: `[Bild „${p.name ?? 'Bild'}“ – dieses Modell kann keine Bilder sehen]` });
      else if (p.type === 'document') parts.push(documents ? { type: 'file', file: { filename: p.name || 'beleg.pdf', file_data: `data:${p.mediaType};base64,${p.data}` } } : { type: 'text', text: `[Dokument „${p.name ?? 'Dokument'}“ – dieses Modell kann keine PDFs lesen]` });
    }
    if (!parts.length) continue;
    out.push({ role: 'user', content: parts.every((x) => x.type === 'text') ? parts.map((x) => x.text).join('\n\n') : parts });
  }
  return out;
}

/** Anthropic request body (pure – tests check caching and tools without a network). */
export function anthropicBody(req: ChatRequest, skipEffort = false): Record<string, unknown> {
  const messages = toAnthropic(req.messages, visionOf(req.connection));
  // Cache breakpoints: after tools + system (static per agent) and on the newest turn (the loop resends it).
  const lastMsg = messages[messages.length - 1];
  const lastBlock = lastMsg?.content?.[lastMsg.content.length - 1];
  if (lastBlock && lastBlock.type !== 'thinking' && lastBlock.type !== 'redacted_thinking') lastBlock.cache_control = { type: 'ephemeral' };
  const body: Record<string, unknown> = {
    model: req.connection.model,
    max_tokens: req.maxTokens ?? 4096,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (req.tools.length) {
    const tools: any[] = req.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 1024), input_schema: t.inputSchema }));
    // Tools rarely change: their own breakpoint keeps them cached when the system prompt differs.
    tools[tools.length - 1].cache_control = { type: 'ephemeral' };
    body.tools = tools;
  }
  const outputConfig: Record<string, unknown> = { ...((effortFields('anthropic', effortPlanOf(req, skipEffort)).output_config as Record<string, unknown> | undefined) ?? {}) };
  if (req.schema) outputConfig.format = { type: 'json_schema', schema: req.schema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  if (req.stream) body.stream = true;
  return body;
}

/** Chat Completions request body. */
export function openaiBody(req: ChatRequest, ep: ReturnType<typeof chatEndpoint>, skipEffort = false): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.connection.model,
    messages: [{ role: 'system', content: req.system }, ...toOpenAI(req.messages, visionOf(req.connection), req.connection.provider === 'openai' || req.connection.provider === 'azure')],
    [ep.maxTokensParam]: req.maxTokens ?? 4096,
  };
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema } }));
    body.tool_choice = 'auto';
  }
  Object.assign(body, effortFields(effortKind(req.connection, 'chat'), effortPlanOf(req, skipEffort)));
  if (req.schema) {
    const p = req.connection.provider;
    if (p === 'openai' || p === 'azure') body.response_format = { type: 'json_schema', json_schema: { name: 'antwort', schema: req.schema, strict: false } };
    else if (JSON_MODE.has(p)) body.response_format = { type: 'json_object' };
  }
  if (req.stream) {
    body.stream = true;
    if (ep.streamUsage) body.stream_options = { include_usage: true };
  }
  return body;
}

// --- wire → neutral -------------------------------------------------------------------------------

const parseArgs = (raw: string): { args: Record<string, unknown>; bad: boolean } => {
  if (!raw || !raw.trim()) return { args: {}, bad: false };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? { args: v, bad: false } : { args: {}, bad: true };
  } catch {
    return { args: {}, bad: true };
  }
};

function fromAnthropicBlocks(blocks: any[]): { message: Msg; text: string; toolCalls: ToolCall[] } {
  const content: Part[] = [];
  const toolCalls: ToolCall[] = [];
  let text = '';
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      text += b.text;
      content.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      const call: ToolCall = { id: String(b.id), name: String(b.name), args: b.input && typeof b.input === 'object' ? b.input : {}, ...(b._bad ? { badArgs: true } : {}) };
      toolCalls.push(call);
      content.push({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      const { _json: _j, _bad: _b, ...raw } = b;
      content.push({ type: 'thinking', raw });
    }
  }
  return { message: { role: 'assistant', content }, text, toolCalls };
}

function fromOpenAI(text: string, calls: { id: string; name: string; args: string }[]): { message: Msg; text: string; toolCalls: ToolCall[] } {
  const content: Part[] = [];
  if (text) content.push({ type: 'text', text });
  const toolCalls: ToolCall[] = [];
  calls.forEach((c, i) => {
    if (!c.name) return;
    const { args, bad } = parseArgs(c.args);
    const call: ToolCall = { id: c.id || `call_${i}_${Date.now().toString(36)}`, name: c.name, args, ...(bad ? { badArgs: true } : {}) };
    toolCalls.push(call);
    content.push({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
  });
  return { message: { role: 'assistant', content }, text, toolCalls };
}

function openaiUsage(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const cached = n(u.prompt_tokens_details?.cached_tokens);
  return { input_tokens: Math.max(0, n(u.prompt_tokens ?? u.input_tokens) - cached), output_tokens: n(u.completion_tokens ?? u.output_tokens), cache_read_tokens: cached, cache_write_tokens: 0 };
}

/** Rough tokens for servers that report none (≈ 4 characters per token). */
export function estimateUsage(req: ChatRequest, outText: string, calls: ToolCall[]): Usage {
  const inChars = req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.tools).length;
  const outChars = outText.length + JSON.stringify(calls).length;
  return { input_tokens: Math.ceil(inChars / 4), output_tokens: Math.ceil(outChars / 4), cache_read_tokens: 0, cache_write_tokens: 0 };
}

// --- errors -----------------------------------------------------------------------------------------

export function providerError(provider: string, status: number, message: string, label = presetById(provider)?.label ?? provider): AgentError {
  const detail = message ? `: ${message.slice(0, 240)}` : '';
  if (status === 401) return new AgentError(`${label}: Der Schlüssel ist ungültig. Bitte die Verbindung unter „Modelle verbinden“ prüfen.`, 502, 'auth');
  if (status === 402) return new AgentError(`${label}: Zahlungsproblem beim Anbieter (Guthaben leer?).`, 502, 'billing');
  if (status === 403) return new AgentError(`${label}: Dieser Schlüssel darf das Modell nicht nutzen${detail}`, 502, 'permission');
  if (status === 404) return new AgentError(`${label}: Modell oder Adresse nicht gefunden${detail}`, 502, 'not_found');
  if (status === 413) return new AgentError(`${label}: Die Anfrage ist zu groß – bitte einen neuen Chat beginnen.`, 502, 'too_large');
  if (status === 429) return new AgentError(`${label}: Zu viele Anfragen oder Kontingent erschöpft – bitte kurz warten.`, 429, 'rate_limit');
  if (status === 529 || status === 503) return new AgentError(`${label} ist gerade überlastet – bitte gleich noch einmal versuchen.`, 503, 'overloaded');
  if (status >= 500) return new AgentError(`${label} hat gerade ein Problem – bitte später erneut versuchen.`, 503, 'server');
  return new AgentError(`${label} hat die Anfrage abgelehnt (${status})${detail}`, 502, 'invalid_request');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Gateways such as kie.ai answer HTTP 200 with an error envelope (`{"code": 500, "msg": "no_available_account"}`) instead of a status:
 * read it as the provider error it is (busy/broken → `upstream`, which services/model-fallback.ts retries and falls back on).
 */
export function envelopeError(data: any, label: string): AgentError | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const code = Number(data.code ?? data.status);
  const msg = String(data.msg ?? data.message ?? (typeof data.error === 'string' ? data.error : (data.error?.message ?? '')) ?? '').slice(0, 240);
  if (!msg && !(code >= 400)) return null;
  if (code === 429 || /rate.?limit|too many/i.test(msg)) return new AgentError(`${label}: Zu viele Anfragen oder Kontingent erschöpft – bitte kurz warten.`, 429, 'rate_limit');
  if (code === 401 || code === 403) return new AgentError(`${label}: Der Schlüssel ist ungültig oder darf das Modell nicht nutzen${msg ? `: ${msg}` : ''}`, 502, code === 401 ? 'auth' : 'permission');
  if (code >= 500 || /no_available_account|internal|overloaded|unavailable/i.test(msg)) return new AgentError(`${label} hat gerade ein Problem${msg ? ` (${msg})` : ''} – bitte später erneut versuchen.`, 503, 'upstream');
  return new AgentError(`${label} hat die Anfrage abgelehnt${msg ? `: ${msg}` : ''}`, 502, 'invalid_request');
}

function errorMessage(data: any, raw: string): string {
  const e = data?.error;
  if (typeof e === 'string') return e;
  if (e?.message) return String(e.message);
  if (Array.isArray(data) && data[0]?.error?.message) return String(data[0].error.message);
  if (data?.message) return String(data.message);
  return raw.slice(0, 200);
}

// --- the call ---------------------------------------------------------------------------------------

/** Wire formats that live in their own file and register themselves here (e.g. "responses", services/chatgpt-responses.ts). */
export const extraWires: Record<string, (req: ChatRequest, fetchImpl: FetchLike) => Promise<ChatResult>> = {};

/** One model turn: request, retry once on overload, stream or not, neutral result with usage. */
export async function chatWithTools(req: ChatRequest, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<ChatResult> {
  const started = Date.now();
  const extra = extraWires[req.connection.wire];
  if (extra) return extra(req, fetchImpl);
  if (req.connection.wire !== 'anthropic' && req.connection.wire !== 'openai') throw new AgentError(`${labelOf(req.connection)} ist kein Text-Modell (kein Chat möglich).`, 400, 'not_text');
  const ep = chatEndpoint(req.connection, req.app);
  let skipEffort = false;
  let body = ep.kind === 'anthropic' ? anthropicBody(req) : openaiBody(req, ep);
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 120_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(ep.url, { method: 'POST', headers: ep.headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (req.signal?.aborted) throw new AgentError('Abgebrochen.', 499, 'aborted');
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new AgentError('Das Modell hat nicht rechtzeitig geantwortet – bitte erneut versuchen.', 504, 'timeout');
      throw new AgentError(`${labelOf(req.connection)} ist nicht erreichbar (${(e as Error).message}).`, 504, 'network');
    }
    if (res.ok) break;
    const raw = await res.text().catch(() => '');
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(retry.ms);
      continue;
    }
    const detail = errorMessage(data, raw);
    const plan = effortPlanOf(req, skipEffort);
    if (plan.sent && isEffortRejection(res.status, detail)) {
      // Everyday calls are repeated once without the level; the Werkstatt never thinks less quietly.
      if (!req.strictEffort) {
        skipEffort = true;
        body = ep.kind === 'anthropic' ? anthropicBody(req, true) : openaiBody(req, ep, true);
        continue;
      }
      throw new AgentError(`${labelOf(req.connection)}: Das Modell „${req.connection.model}“ nimmt die Denkstufe „${plan.applied}“ nicht an (${detail.slice(0, 160)}). Bitte ein anderes Modell wählen oder die Denkstufe unter Einstellungen → KI-Anbieter → Denkstufe ändern.`, 400, 'effort_rejected');
    }
    throw providerError(req.connection.provider, res.status, detail, labelOf(req.connection));
  }
  const isStream = !!req.stream && (res.headers.get('content-type') ?? '').includes('event-stream') && !!res.body;
  const out = ep.kind === 'anthropic' ? await readAnthropic(res, isStream, req) : await readOpenAI(res, isStream, req);
  return { ...out, ms: Date.now() - started, effort: effortPlanOf(req, skipEffort) };
}

async function readAnthropic(res: Response, stream: boolean, req: ChatRequest): Promise<Omit<ChatResult, 'ms'>> {
  let usage: Usage = { ...ZERO_USAGE };
  let model = req.connection.model;
  let stopReason = '';
  let blocks: any[] = [];
  if (!stream) {
    const data: any = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.content)) throw envelopeError(data, labelOf(req.connection)) ?? new AgentError('Unerwartete Antwort von Anthropic.', 502, 'bad_response');
    blocks = data.content;
    usage = readUsage(data.usage);
    model = String(data.model || model);
    stopReason = String(data.stop_reason ?? '');
    for (const b of blocks) if (b.type === 'text' && b.text) req.onText?.(b.text);
  } else {
    for await (const ev of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (d.type) {
        case 'message_start':
          usage = readUsage(d.message?.usage);
          model = String(d.message?.model || model);
          break;
        case 'content_block_start':
          blocks[d.index] = { ...d.content_block, ...(d.content_block?.type === 'tool_use' ? { _json: '' } : {}) };
          break;
        case 'content_block_delta': {
          const b = blocks[d.index];
          const delta = d.delta ?? {};
          if (!b) break;
          if (delta.type === 'text_delta') {
            b.text = (b.text ?? '') + delta.text;
            req.onText?.(delta.text);
          } else if (delta.type === 'input_json_delta') b._json += delta.partial_json ?? '';
          else if (delta.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (delta.thinking ?? '');
          else if (delta.type === 'signature_delta') b.signature = (b.signature ?? '') + (delta.signature ?? '');
          break;
        }
        case 'content_block_stop': {
          const b = blocks[d.index];
          if (b?.type === 'tool_use' && typeof b._json === 'string') {
            const { args, bad } = parseArgs(b._json);
            b.input = args;
            if (bad) b._bad = true;
          }
          break;
        }
        case 'message_delta': {
          if (d.delta?.stop_reason) stopReason = String(d.delta.stop_reason);
          const u = readUsage(d.usage);
          usage = {
            input_tokens: Math.max(usage.input_tokens, u.input_tokens),
            output_tokens: Math.max(usage.output_tokens, u.output_tokens),
            cache_read_tokens: Math.max(usage.cache_read_tokens, u.cache_read_tokens),
            cache_write_tokens: Math.max(usage.cache_write_tokens, u.cache_write_tokens),
          };
          break;
        }
        case 'error':
          throw new AgentError(`Anthropic: ${String(d.error?.message ?? 'Fehler im Stream')}`, d.error?.type === 'overloaded_error' ? 503 : 502, 'stream_error', usage);
      }
    }
    blocks = blocks.filter(Boolean);
  }
  if (stopReason === 'refusal') throw new AgentError('Das Modell hat diese Anfrage aus Sicherheitsgründen abgelehnt.', 422, 'refusal', usage);
  const parsed = fromAnthropicBlocks(blocks);
  return { ...parsed, stopReason, usage, model };
}

async function readOpenAI(res: Response, stream: boolean, req: ChatRequest): Promise<Omit<ChatResult, 'ms'>> {
  let usage: Usage | null = null;
  let model = req.connection.model;
  let stopReason = '';
  let text = '';
  const calls: { id: string; name: string; args: string }[] = [];
  if (!stream) {
    const data: any = await res.json().catch(() => null);
    const choice = data?.choices?.[0];
    if (!choice) throw envelopeError(data, labelOf(req.connection)) ?? new AgentError(`Unerwartete Antwort von ${labelOf(req.connection)}.`, 502, 'bad_response');
    text = typeof choice.message?.content === 'string' ? choice.message.content : Array.isArray(choice.message?.content) ? choice.message.content.map((p: any) => p?.text ?? '').join('') : '';
    if (text) req.onText?.(text);
    for (const tc of choice.message?.tool_calls ?? []) calls.push({ id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), args: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}) });
    stopReason = String(choice.finish_reason ?? '');
    usage = openaiUsage(data.usage);
    model = String(data.model || model);
  } else {
    for await (const ev of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
      if (ev.data.trim() === '[DONE]') break;
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (d.error) throw new AgentError(`${labelOf(req.connection)}: ${errorMessage(d, ev.data)}`, 502, 'stream_error');
      if (d.model) model = String(d.model);
      const u = openaiUsage(d.usage);
      if (u) usage = u;
      for (const choice of d.choices ?? []) {
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          req.onText?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          let idx: number = typeof tc.index === 'number' ? tc.index : -1;
          if (idx < 0) idx = tc.id ? calls.findIndex((c) => c.id === tc.id) : calls.length - 1;
          if (idx < 0) idx = calls.length;
          calls[idx] ??= { id: '', name: '', args: '' };
          const c = calls[idx];
          if (tc.id && !c.id) c.id = String(tc.id);
          const fn = tc.function ?? {};
          if (fn.name) c.name = c.name ? (c.name === fn.name ? c.name : c.name + fn.name) : String(fn.name);
          if (fn.arguments !== undefined) c.args += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
        }
        if (choice.finish_reason) stopReason = String(choice.finish_reason);
      }
    }
  }
  const parsed = fromOpenAI(text, calls.filter(Boolean));
  if (stopReason === 'content_filter' && !parsed.text && !parsed.toolCalls.length) throw new AgentError('Der Anbieter hat die Antwort gefiltert.', 422, 'refusal');
  const estimated = !usage;
  return { ...parsed, stopReason, usage: usage ?? estimateUsage(req, parsed.text, parsed.toolCalls), model, ...(estimated ? { estimated: true } : {}) };
}
