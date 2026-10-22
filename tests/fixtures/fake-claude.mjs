// A stand-in for `claude -p --output-format stream-json` in the bridge tests: reads the prompt from
// stdin, calls the HyperLevel MCP endpoint from --mcp-config like Claude Code would, prints stream-json.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.gohigh;
let prompt = '';
for await (const c of process.stdin) prompt += c;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rpc = async (id, method, params) => {
  const r = await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json', ...config.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  return r.json();
};
out({ type: 'system', subtype: 'init', tools: [], allowed: args[args.indexOf('--allowedTools') + 1], disallowed: args[args.indexOf('--disallowedTools') + 1] });
await rpc(1, 'initialize', { protocolVersion: '2025-06-18' });
const tools = (await rpc(2, 'tools/list', {})).result.tools.map((t) => t.name);
out({ type: 'assistant', message: { content: [{ type: 'text', text: `Prompt erhalten (${prompt.includes('Aktueller Auftrag') ? 'mit Auftrag' : 'leer'}), ${tools.length} Werkzeuge.` }] } });
const name = process.env.FAKE_TOOL || 'search_everything';
const callArgs = name === 'search_everything' ? { query: 'Lena' } : { title: 'Von der Bridge' };
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__gohigh__${name}`, input: callArgs }] } });
const res = await rpc(3, 'tools/call', { name, arguments: callArgs });
const text = res.result.content[0].text;
out({ type: 'result', subtype: 'success', is_error: false, result: res.result.isError ? `Fehler: ${text}` : `Fertig: ${text.includes('lena@lead.example') ? 'Lena gefunden' : 'erledigt'}.` });
