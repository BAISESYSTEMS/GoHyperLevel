/**
 * Fake model APIs for the agent tests: Anthropic Messages (SSE) and OpenAI Chat Completions (SSE),
 * streamed in small chunks so the parsers see split events. No network, no keys.
 */

export type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type Block = { type: 'text'; text: string } | ToolUse | { type: 'thinking'; thinking: string; signature: string };

/** A streamed body cut into pieces of `size` bytes. */
export function chunked(text: string, size = 23): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

export function anthropicSse(blocks: Block[], usage = { input_tokens: 1000, output_tokens: 50 }, model = 'claude-sonnet-5-5'): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;
  let s = ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: usage.input_tokens, output_tokens: 1, cache_read_input_tokens: 0 } } });
  s += ': ping\n\n';
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      s += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      const half = Math.ceil(b.text.length / 2);
      s += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(0, half) } });
      s += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(half) } });
    } else if (b.type === 'tool_use') {
      s += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      const half = Math.ceil(json.length / 2);
      s += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } });
      s += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(half) } });
    } else {
      s += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
      s += ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      s += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    }
    s += ev('content_block_stop', { index });
  });
  s += ev('message_delta', { delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: usage.output_tokens } });
  s += ev('message_stop', {});
  return s;
}

export function openaiSse(text: string, calls: { id: string; name: string; args: Record<string, unknown> }[] = [], usage = { prompt_tokens: 900, completion_tokens: 40 }): string {
  const line = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
  let s = line({ id: 'c1', object: 'chat.completion.chunk', model: 'llama-test', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  if (text) for (const part of [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))]) s += line({ id: 'c1', model: 'llama-test', choices: [{ index: 0, delta: { content: part } }] });
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.args);
    s += line({ id: 'c1', model: 'llama-test', choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] });
    s += line({ id: 'c1', model: 'llama-test', choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(0, 7) } }] } }] });
    s += line({ id: 'c1', model: 'llama-test', choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: args.slice(7) } }] } }] });
  });
  s += line({ id: 'c1', model: 'llama-test', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
  s += line({ id: 'c1', model: 'llama-test', choices: [], usage });
  s += 'data: [DONE]\n\n';
  return s;
}

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake fetch answering from a script; every request is recorded. */
export function fakeModel() {
  const calls: FakeCall[] = [];
  let script: ((body: any, url: string) => Response)[] = [];
  const fetchImpl = (async (url: string, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers, body });
    const next = script.shift();
    if (!next) return new Response(JSON.stringify({ error: { message: 'no scripted reply' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    return next(body, String(url));
  }) as unknown as typeof fetch;
  return {
    calls,
    fetch: fetchImpl,
    reply(...fns: ((body: any, url: string) => Response)[]) {
      script.push(...fns);
    },
    reset() {
      calls.length = 0;
      script = [];
    },
    pending: () => script.length,
  };
}

export const sse = (text: string) => () => new Response(chunked(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
export const json = (data: unknown, status = 200) => () => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Events from an SSE response body of /api/agent/chat. */
export function events(text: string): any[] {
  return String(text)
    .split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l) => JSON.parse(l!.slice(6)));
}
