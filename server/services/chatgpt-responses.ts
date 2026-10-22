import { ZERO_USAGE, type Usage } from './anthropic.js';
import { AgentError, effortPlanOf, estimateUsage, extraWires, retry, sseEvents, type ChatRequest, type ChatResult, type Msg, type Part, type ToolCall } from './agent-llm.js';
import { effortFields, isEffortRejection } from './ai-effort.js';
import type { FetchLike } from './ai-presets.js';
import { RESOURCE, USAGE_URL } from './chatgpt-oauth.js';

/**
 * Chat with tool use over OpenAI's Responses API for the personal "Mit ChatGPT anmelden" connection. The rules of this
 * route are OpenAI's (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations):
 *
 *   POST https://api.openai.com/v1/responses, `store: false` and `stream: true` on every request, the whole history in
 *   `input` (no previous_response_id), system text in `instructions`, tools grouped in a `namespace` (function tools),
 *   and none of: max_output_tokens, temperature, top_p, metadata, user, previous_response_id, hosted tools.
 *
 * Errors follow …/errors-and-recovery: usage limits, ineligible workspaces and revoked sessions get their own message.
 * Registered as wire "responses" in services/agent-llm.ts (`extraWires`), so the agent loop, the quick texts and the
 * Werkstatt use it like any other connection. The access token is added by the caller's fetch (modules/ai-subscriptions.ts).
 */

export const NAMESPACE = 'gohigh';
export const RESPONSES_URL = `${RESOURCE}/responses`;

const textOfFile = (p: Extract<Part, { type: 'file' }>) => `[Datei „${p.name}“ (${p.mime}), file_id: ${p.fileId}]\n${p.preview}`;

/** Messages as Responses `input` items: text and images as messages, tool calls and their results as function_call items. */
export function toResponsesInput(messages: Msg[], vision: boolean): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.content.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
      if (text) out.push({ role: 'assistant', content: text });
      for (const p of m.content) if (p.type === 'tool_call') out.push({ type: 'function_call', call_id: p.id, name: p.name, namespace: NAMESPACE, arguments: JSON.stringify(p.args ?? {}) });
      continue;
    }
    for (const p of m.content) if (p.type === 'tool_result') out.push({ type: 'function_call_output', call_id: p.id, output: p.content || '(leer)' });
    const parts: any[] = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text) parts.push({ type: 'input_text', text: p.text });
      else if (p.type === 'file') parts.push({ type: 'input_text', text: textOfFile(p) });
      else if (p.type === 'image') parts.push(vision ? { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` } : { type: 'input_text', text: `[Bild „${p.name ?? 'Bild'}“ – dieses Modell kann keine Bilder sehen]` });
      else if (p.type === 'document') parts.push({ type: 'input_file', filename: p.name || 'beleg.pdf', file_data: `data:${p.mediaType};base64,${p.data}` });
    }
    if (!parts.length) continue;
    out.push({ role: 'user', content: parts.every((x) => x.type === 'input_text') ? parts.map((x) => x.text).join('\n\n') : parts });
  }
  return out;
}

/** The request body (pure – tests check the rules above without a network). */
export function responsesBody(req: ChatRequest, skipEffort = false): Record<string, unknown> {
  const vision = req.connection.vision ?? (req.connection.capabilities ? req.connection.capabilities.includes('vision') : true);
  const body: Record<string, unknown> = {
    model: req.connection.model,
    instructions: req.system,
    input: toResponsesInput(req.messages, vision),
    store: false,
    stream: true,
  };
  if (req.tools.length) body.tools = [{ type: 'namespace', name: NAMESPACE, description: 'Werkzeuge des CRM HyperLevel', tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema })) }];
  Object.assign(body, effortFields('responses', effortPlanOf(req, skipEffort)));
  return body;
}

function usageOf(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const cached = n(u.input_tokens_details?.cached_tokens);
  return { input_tokens: Math.max(0, n(u.input_tokens) - cached), output_tokens: n(u.output_tokens), cache_read_tokens: cached, cache_write_tokens: 0 };
}

const LIMIT = `Das Nutzungslimit deines ChatGPT-Plans (oder das für diese App eingestellte Limit) ist erreicht. Unter ${USAGE_URL} kannst du es prüfen und anpassen.`;

/** A structured Responses error (HTTP body or stream event) → German message with the right status. */
export function planError(status: number, code: string, message: string, param?: string, usage: Usage = ZERO_USAGE): AgentError {
  const e = (msg: string, st = status, c = code || 'api_error') => new AgentError(`ChatGPT-Abo: ${msg}`, st, c, usage);
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return e(LIMIT, 429, 'rate_limit');
    case 'subscription_sharing_user_not_eligible':
      return e('Dein ChatGPT-Plan, Workspace oder eine Richtlinie erlaubt die Nutzung in Apps nicht. Nimm stattdessen einen API-Schlüssel (Einstellungen → KI-Anbieter).', 403, 'permission');
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return e('Die Nutzung konnte gerade nicht geprüft werden – bitte gleich noch einmal versuchen.', 503, 'overloaded');
    case 'subscription_sharing_unsupported_capability':
      return e(`Das Modell oder die Anfrage nutzt etwas, das ChatGPT-Pläne in Apps nicht unterstützen${param ? ` (${param})` : ''}.`, 400, 'invalid_request');
    case 'subscription_sharing_route_not_supported':
      return e('Diese Schnittstelle ist für ChatGPT-Pläne nicht freigegeben.', 403, 'permission');
    case 'subscription_sharing_invalid_user':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return e('Die Anmeldung wurde nicht akzeptiert. Bitte trenne die Verbindung und melde dich neu an.', status === 401 ? 401 : 403, 'auth');
  }
  if (status === 401) return e('Die Anmeldung wurde nicht akzeptiert. Bitte unter Einstellungen → KI-Anbieter neu anmelden.', 401, 'auth');
  if (status === 403) return e(`Eine Richtlinie hat die Anfrage abgelehnt${message ? `: ${message.slice(0, 200)}` : ' (z. B. die erlaubte Region)'}.`, 403, 'permission');
  if (status === 429) return e(LIMIT, 429, 'rate_limit');
  if (status === 503 || status === 502) return e('ChatGPT ist gerade nicht erreichbar – bitte gleich noch einmal versuchen.', 503, 'overloaded');
  if (status >= 500) return e('ChatGPT hat gerade ein Problem – bitte später erneut versuchen.', 503, 'server');
  return e(`Die Anfrage wurde abgelehnt (${status})${message ? `: ${message.slice(0, 240)}` : ''}`, 502, code || 'invalid_request');
}

const errFields = (data: any) => {
  const e = data?.error;
  if (e && typeof e === 'object') return { code: String(e.code ?? ''), message: String(e.message ?? ''), param: typeof e.param === 'string' ? e.param : undefined };
  if (typeof data?.detail === 'string') return { code: '', message: data.detail, param: undefined };
  return { code: '', message: typeof e === 'string' ? e : '', param: undefined };
};

const parseArgs = (raw: string): { args: Record<string, unknown>; bad: boolean } => {
  if (!raw || !raw.trim()) return { args: {}, bad: false };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? { args: v, bad: false } : { args: {}, bad: true };
  } catch {
    return { args: {}, bad: true };
  }
};

/** One model turn over the Responses API (streaming is mandatory on this route). */
export async function chatResponses(req: ChatRequest, fetchImpl: FetchLike): Promise<ChatResult> {
  const started = Date.now();
  let skipEffort = false;
  let body = responsesBody(req);
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 120_000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchImpl(RESPONSES_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (req.signal?.aborted) throw new AgentError('Abgebrochen.', 499, 'aborted');
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new AgentError('Das Modell hat nicht rechtzeitig geantwortet – bitte erneut versuchen.', 504, 'timeout');
      if (e instanceof AgentError) throw e;
      throw new AgentError(`ChatGPT-Abo: ChatGPT ist nicht erreichbar (${(e as Error).message}).`, 504, 'network');
    }
    if (res.ok) break;
    const raw = await res.text().catch(() => '');
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON */
    }
    const { code, message, param } = errFields(data);
    if (res.status === 503 && attempt === 0 && !code) {
      await new Promise((r) => setTimeout(r, retry.ms));
      continue;
    }
    const plan = effortPlanOf(req, skipEffort);
    if (plan.sent && isEffortRejection(res.status, message) && !req.strictEffort) {
      skipEffort = true;
      body = responsesBody(req, true);
      continue;
    }
    throw planError(res.status, code, message, param);
  }

  let text = '';
  let model = req.connection.model;
  let usage: Usage | null = null;
  let stopReason = '';
  let completed = false;
  const calls: { key: string; id: string; name: string; args: string }[] = [];
  const callAt = (key: string) => calls.find((c) => c.key === key);
  const finalItems: any[] = [];
  const isStream = !!res.body && (res.headers.get('content-type') ?? 'text/event-stream').includes('event-stream');
  if (!isStream) throw new AgentError('ChatGPT-Abo: ChatGPT hat keinen Antwort-Stream geschickt.', 502, 'bad_response');
  for await (const ev of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
    if (ev.data.trim() === '[DONE]') break;
    let d: any;
    try {
      d = JSON.parse(ev.data);
    } catch {
      continue;
    }
    switch (d.type) {
      case 'response.output_text.delta':
        if (typeof d.delta === 'string') {
          text += d.delta;
          req.onText?.(d.delta);
        }
        break;
      case 'response.output_item.added':
        if (d.item?.type === 'function_call') calls.push({ key: String(d.item.id ?? d.item_id ?? calls.length), id: String(d.item.call_id ?? ''), name: String(d.item.name ?? ''), args: typeof d.item.arguments === 'string' ? d.item.arguments : '' });
        break;
      case 'response.function_call_arguments.delta': {
        const c = callAt(String(d.item_id ?? ''));
        if (c && typeof d.delta === 'string') c.args += d.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const c = callAt(String(d.item_id ?? ''));
        if (c && typeof d.arguments === 'string') c.args = d.arguments;
        break;
      }
      case 'response.output_item.done':
        finalItems.push(d.item);
        if (d.item?.type === 'function_call') {
          const c = callAt(String(d.item.id ?? d.item_id ?? ''));
          if (c) {
            if (d.item.call_id) c.id = String(d.item.call_id);
            if (d.item.name) c.name = String(d.item.name);
            if (typeof d.item.arguments === 'string') c.args = d.item.arguments;
          } else calls.push({ key: String(d.item.id ?? calls.length), id: String(d.item.call_id ?? ''), name: String(d.item.name ?? ''), args: String(d.item.arguments ?? '') });
        }
        break;
      case 'response.completed':
        completed = true;
        usage = usageOf(d.response?.usage) ?? usage;
        if (d.response?.model) model = String(d.response.model);
        // Some servers send the finished output only here.
        if (!text && !calls.length && Array.isArray(d.response?.output)) {
          for (const item of d.response.output) {
            if (item?.type === 'message') for (const c of item.content ?? []) if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text;
            if (item?.type === 'function_call') calls.push({ key: String(item.id ?? calls.length), id: String(item.call_id ?? ''), name: String(item.name ?? ''), args: String(item.arguments ?? '') });
          }
          if (text) req.onText?.(text);
        }
        break;
      case 'response.incomplete':
        completed = true;
        usage = usageOf(d.response?.usage) ?? usage;
        stopReason = String(d.response?.incomplete_details?.reason ?? 'incomplete');
        break;
      case 'response.failed': {
        const f = errFields(d.response ?? d);
        throw planError(Number(d.response?.status_code) || (f.code === 'subscription_sharing_usage_limit_exceeded' ? 429 : 502), f.code, f.message, f.param, usageOf(d.response?.usage) ?? ZERO_USAGE);
      }
      case 'error': {
        const f = errFields(d);
        throw planError(502, f.code || String(d.code ?? ''), f.message || String(d.message ?? ''), f.param ?? (typeof d.param === 'string' ? d.param : undefined));
      }
    }
  }
  if (!completed) throw new AgentError('ChatGPT-Abo: Die Antwort wurde unterbrochen, bevor sie fertig war. Bitte erneut versuchen.', 502, 'stream_interrupted');

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
  if (stopReason === 'content_filter' && !text && !toolCalls.length) throw new AgentError('Das Modell hat diese Anfrage aus Sicherheitsgründen abgelehnt.', 422, 'refusal');
  const estimated = !usage;
  const out: ChatResult = { message: { role: 'assistant', content }, text, toolCalls, stopReason: stopReason === 'max_output_tokens' ? 'length' : stopReason || (toolCalls.length ? 'tool_use' : 'stop'), usage: usage ?? estimateUsage(req, text, toolCalls), model, ms: Date.now() - started, effort: effortPlanOf(req, skipEffort) };
  if (estimated) out.estimated = true;
  return out;
}

extraWires.responses = chatResponses;
