import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODEL_RE, VERSION, commandFor, pair, pollOnce } from '../bridge/gohigh-bridge.mjs';
import { startTestApp } from './helpers.js';

/**
 * The recommended way to use a Claude (or ChatGPT) subscription: the local bridge – Claude Code / Codex CLI on the person's own
 * computer, signed in there, with a one-line setup, a pairing code with QR code, live status and the model of their choice.
 * (Claude has no OAuth sign-in in HyperLevel: Anthropic does not allow it for third-party apps.)
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(() => t.close());

describe('bridge command lines', () => {
  const job = { mcp_url: 'https://crm.example.com/api/agent/bridge/mcp', mcp_token: 'ghbj_x' };
  const cmd = (cli: string, model?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    try {
      return commandFor(cli, { ...job, ...(model ? { model } : {}) }, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('passes the chosen model to Claude Code (--model) and to Codex (-m)', () => {
    const claude = cmd('claude', 'claude-sonnet-5-5').args;
    expect(claude.slice(claude.indexOf('--model'), claude.indexOf('--model') + 2)).toEqual(['--model', 'claude-sonnet-5-5']);
    const codex = cmd('codex', 'gpt-6.1-sol').args;
    expect(codex.slice(codex.indexOf('-m'), codex.indexOf('-m') + 2)).toEqual(['-m', 'gpt-6.1-sol']);
    // the safety switches stay
    expect(claude).toEqual(expect.arrayContaining(['--strict-mcp-config', '--allowedTools', 'mcp__gohigh', '--disallowedTools']));
    expect(codex).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
  });

  it('passes no model when there is none, and never anything that does not look like a model id', () => {
    expect(cmd('claude').args).not.toContain('--model');
    expect(cmd('codex').args).not.toContain('-m');
    for (const evil of ['--dangerously-skip-permissions', 'x; rm -rf ~', '$(id)', 'a b', '', '-m']) {
      const a = cmd('claude', evil).args;
      expect(a, evil).not.toContain('--model');
      expect(MODEL_RE.test(evil), evil).toBe(false);
    }
    expect(VERSION).toBe('1.1.0');
  });
});

describe('connecting a computer', () => {
  it('gives a one-line command, a pairing code, a QR code and the limits; the agency has to allow it first', async () => {
    expect((await t.api.post('/api/agent/bridge/code')).status).toBe(403);
    await t.api.put('/api/agent/agency-settings', { bridge_enabled: true });
    const r = (await t.api.post('/api/agent/bridge/code')).data;
    expect(r.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.expires_in_s).toBe(600);
    expect(r.command).toBe(`node gohigh-bridge.mjs pair http://localhost ${r.code}`);
    expect(r.command_oneline).toBe(`curl -fsSL http://localhost/api/agent/bridge/script -o gohigh-bridge.mjs && node gohigh-bridge.mjs pair http://localhost ${r.code} && node gohigh-bridge.mjs`);
    expect(r.command_windows).toContain('curl.exe');
    expect(r.qr_svg.startsWith('<svg')).toBe(true);
    // the code in the command is the code that pairs
    const script = await t.api.raw('/api/agent/bridge/script');
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(readFileSync(new URL('../bridge/gohigh-bridge.mjs', import.meta.url), 'utf8'));
  });

  it('shows live status, takes the model per computer and hands it to the CLI with each job', async () => {
    const code = (await t.api.post('/api/agent/bridge/code')).data.code;
    const cfg = await pair(t.base, code, { save: false, clis: ['claude', 'codex'], name: 'Annas MacBook' });
    const before = (await t.api.get('/api/agent/bridge')).data;
    expect(before.devices).toHaveLength(1);
    expect(before.devices[0]).toMatchObject({ name: 'Annas MacBook', cli: 'claude', model: '', clis: ['claude', 'codex'], version: '1.1.0', online: true });
    const id = before.devices[0].id;
    // model and CLI are set in HyperLevel
    expect((await t.api.patch(`/api/agent/bridge/devices/${id}`, { model: 'claude-sonnet-5-5' })).data).toMatchObject({ model: 'claude-sonnet-5-5', cli: 'claude' });
    expect((await t.api.patch(`/api/agent/bridge/devices/${id}`, { model: 'rm -rf /' })).status).toBe(400);
    expect((await t.api.patch(`/api/agent/bridge/devices/${id}`, { cli: 'gemini' })).status).toBe(400);
    expect((await t.api.get('/api/agent/bridge')).data.devices[0]).toMatchObject({ model: 'claude-sonnet-5-5' });
    // the next poll carries the model to the bridge
    let seen: any = null;
    const spy: typeof fetch = async (url: any, init: any) => {
      const res = await fetch(url, init);
      if (String(url).includes('/api/agent/bridge/poll') && res.status === 200) seen = await res.clone().json();
      return res;
    };
    const streaming = fetch(`${t.base}/api/agent/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie: t.api.cookie, 'x-location-id': t.api.location }, body: JSON.stringify({ message: 'Hallo', connection: 'bridge' }) });
    await new Promise((r) => setTimeout(r, 300));
    await pollOnce(cfg, { bin: [process.execPath, FAKE], wait: 5, fetch: spy });
    await (await streaming).text();
    expect(seen?.job?.model).toBe('claude-sonnet-5-5');
    // a device that stops polling goes offline (last seen is shown)
    t.app.db.run('UPDATE agent_bridge_devices SET last_seen_at = ?', new Date(Date.now() - 5 * 60_000).toISOString());
    expect((await t.api.get('/api/agent/bridge')).data.devices[0]).toMatchObject({ online: false });
    expect(t.app.services.agentBridge.statusFor((t.app.db.get('SELECT id FROM users LIMIT 1') as any).id)).toMatchObject({ paired: true, online: false });
  });

  it('is invisible to other people', async () => {
    await t.api.post('/api/users', { email: 'b@example.com', name: 'B', password: 'geheim123', role: 'member', locations: [t.api.location], permissions: ['conversations'] });
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'b@example.com', password: 'geheim123' });
    t.api.setLocation(t.app.db.get<any>('SELECT id FROM locations LIMIT 1').id);
    expect((await t.api.get('/api/agent/bridge')).data.devices).toEqual([]);
    const id = t.app.db.get<any>('SELECT id FROM agent_bridge_devices LIMIT 1').id;
    expect((await t.api.patch(`/api/agent/bridge/devices/${id}`, { model: 'x' })).status).toBe(404);
    expect((await t.api.del(`/api/agent/bridge/devices/${id}`)).status).toBe(404);
  });
});
