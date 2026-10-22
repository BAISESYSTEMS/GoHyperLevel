import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { normalizeLine, pair, pollOnce, commandFor } from '../bridge/gohigh-bridge.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let t: Awaited<ReturnType<typeof startTestApp>>;
let cfg: any;

/** Reads the chat's SSE stream while it is running and lets the test react to events. */
async function streamChat(body: Record<string, unknown>, onEvent: (e: any) => void | Promise<void>) {
  const r = await fetch(`${t.base}/api/agent/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': t.api.location }, body: JSON.stringify(body) });
  const all: any[] = [];
  let buf = '';
  for await (const chunk of r.body as any) {
    buf += new TextDecoder().decode(chunk);
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const e = JSON.parse(line.slice(6));
      all.push(e);
      await onEvent(e);
    }
  }
  return all;
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  await t.api.post('/api/contacts', { first_name: 'Lena', email: 'lena@lead.example' });
});
afterAll(() => t.close());

describe('local bridge', () => {
  it('normalizes Claude Code and Codex output lines', () => {
    expect(normalizeLine('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'mcp__gohigh__ghl_search_contacts' }] } }))).toEqual([
      { kind: 'text', text: 'Hi' },
      { kind: 'status', text: 'Werkzeug: ghl_search_contacts' },
    ]);
    expect(normalizeLine('claude', JSON.stringify({ type: 'result', subtype: 'success', result: 'Fertig' }))).toEqual([{ kind: 'result', text: 'Fertig' }]);
    expect(normalizeLine('claude', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }))[0].kind).toBe('error');
    expect(normalizeLine('codex', JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'Hallo' } }))).toEqual([{ kind: 'text', text: 'Hallo' }]);
    expect(normalizeLine('codex', JSON.stringify({ msg: { type: 'agent_message', message: 'Alt' } }))).toEqual([{ kind: 'text', text: 'Alt' }]);
    expect(normalizeLine('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'Limit' } }))).toEqual([{ kind: 'error', text: 'Limit' }]);
    expect(normalizeLine('codex', 'kein json')).toEqual([]);
    // Codex gets HyperLevel's MCP via -c overrides and the token via an env var, read-only sandbox; prompt on stdin
    const cmd = commandFor('codex', { mcp_url: 'https://crm.example.com/api/agent/bridge/mcp', mcp_token: 'ghbj_x' }, '/tmp/x');
    expect(cmd.args).toEqual(expect.arrayContaining(['exec', '--json', '--sandbox', 'read-only', 'mcp_servers.gohigh.url="https://crm.example.com/api/agent/bridge/mcp"', '-']));
    expect(cmd.env).toEqual({ GOHIGH_MCP_TOKEN: 'ghbj_x' });
    expect(cmd.args.join(' ')).not.toContain('ghbj_x');
  });

  it('is off until the agency enables it; pairs once with a one-time code', async () => {
    expect((await t.api.post('/api/agent/bridge/code')).status).toBe(403);
    await t.api.put('/api/agent/agency-settings', { bridge_enabled: true });
    const code = (await t.api.post('/api/agent/bridge/code')).data;
    expect(code.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code.command).toContain('gohigh-bridge.mjs pair');
    cfg = await pair(t.base, code.code, { clis: ['claude'], save: false, name: 'Laptop' });
    expect(cfg).toMatchObject({ user: 'Chef', cli: 'claude' });
    expect(cfg.token).toMatch(/^ghb_/);
    await expect(pair(t.base, code.code, { clis: ['claude'], save: false })).rejects.toThrow(/Code/);
    const status = (await t.api.get('/api/agent/bridge')).data;
    expect(status.devices[0]).toMatchObject({ name: 'Laptop', cli: 'claude', online: true });
    // a wrong device token is refused
    expect((await t.api.raw('/api/agent/bridge/poll?wait=0', { headers: { authorization: 'Bearer ghb_falsch' } })).status).toBe(401);
    expect(await pollOnce(cfg, { wait: 0 })).toBeNull();
    // the script itself is downloadable
    const script = await t.api.raw('/api/agent/bridge/script');
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('HyperLevel Bridge');
  });

  it('relays a chat to the local CLI, runs its MCP tool calls as the user and streams the answer back', async () => {
    let job: Promise<any> | null = null;
    const ev = await streamChat({ message: 'Finde Lena', connection: 'bridge' }, (e) => {
      if (e.type === 'bridge' && e.status === 'queued') job = pollOnce(cfg, { bin: [process.execPath, FAKE], wait: 5 });
    });
    const result = await job;
    expect(result.error).toBeFalsy();
    expect(ev.find((e) => e.type === 'tool')).toMatchObject({ name: 'search_everything', klass: 'read' });
    expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ status: 'ok' });
    const text = ev.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toContain('Prompt erhalten (mit Auftrag)');
    expect(text).toContain('Fertig: Lena gefunden.');
    expect(ev.at(-1)).toMatchObject({ type: 'done', status: 'done' });
    const convs = (await t.api.get('/api/agent/conversations')).data;
    expect(convs[0].connection).toBe('bridge');
    const conv = (await t.api.get(`/api/agent/conversations/${convs[0].id}`)).data;
    expect(conv.items[1].blocks.flatMap((b: any) => b.tools ?? [])[0]).toMatchObject({ name: 'search_everything', status: 'ok' });
    // the job token died with the job
    const late = await t.api.raw('/api/agent/bridge/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ghbj_whatever' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(late.status).toBe(401);
  });

  it('waits for a confirmation in the web chat before a write tool runs', async () => {
    process.env.FAKE_TOOL = 'ghl_create_task';
    let job: Promise<any> | null = null;
    try {
      const ev = await streamChat({ message: 'Lege eine Aufgabe an', connection: 'bridge' }, async (e) => {
        if (e.type === 'bridge' && e.status === 'queued') job = pollOnce(cfg, { bin: [process.execPath, FAKE], wait: 5 });
        if (e.type === 'confirm') {
          expect(e).toMatchObject({ tool: 'ghl_create_task', bridge: true });
          const r = await t.api.post('/api/agent/confirm', { pending_id: e.pending_id, token: e.token, approve: true });
          expect(r.status).toBe(200);
        }
      });
      await job;
      expect(ev.find((e) => e.type === 'confirm')).toBeTruthy();
      expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ status: 'ok' });
      const tasks = (await t.api.get('/api/tasks')).data;
      expect((tasks.tasks ?? tasks).some((x: any) => x.title === 'Von der Bridge')).toBe(true);
    } finally {
      delete process.env.FAKE_TOOL;
    }
  });
});
