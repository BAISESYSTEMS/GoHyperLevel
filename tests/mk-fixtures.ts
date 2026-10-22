import { STARTERS } from '../server/services/email-starters.js';
import type { EmailDesign } from '../server/services/email-render.js';

/** A valid design with footer (the "Newsletter" starter of the builder). */
export const starterDesign = (): EmailDesign => STARTERS[0].build();

type Harness = { api: { raw: (p: string, init?: RequestInit) => Promise<Response>; post: (p: string, b?: unknown) => Promise<{ data: any }> } };

/** MCP over HTTP with a fresh location API key: `rpc(name, args)` calls a tool for the given sub-account. */
export async function mcpClient(t: Harness, loc: string) {
  const key = (await t.api.post('/api/api-keys', { name: 'mcp-test' })).data.key;
  const call = async (method: string, params?: unknown) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()) as any;
  };
  return {
    tools: async (): Promise<any[]> => (await call('tools/list')).result.tools,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      const j = await call('tools/call', { name, arguments: { location_id: loc, ...args } });
      const text = String(j.result?.content?.[0]?.text ?? '');
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        /* plain text */
      }
      return { error: !!j.result?.isError, text, json };
    },
  };
}
