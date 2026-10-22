import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { guessDoc } from '../server/modules/docs.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc1 = '';
let loc2 = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc1 = t.api.location;
  loc2 = (await t.api.post('/api/locations', { name: 'Kunde Nord' })).data.id;
});
afterAll(() => t.close());

const mcpInit = async (key: string) =>
  t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

describe('KI-Werkzeuge: keys', () => {
  it('a sub-account key for the sub-account page, named after tool and device, shown once', async () => {
    const r = await t.api.post('/api/ai-tools/keys', { tool: 'codex', label: 'Laptop', scope: 'agency' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ name: 'Codex – Laptop', tool: 'codex', scope: 'location', mcp_url: 'http://localhost/mcp' });
    expect(r.data.key).toMatch(/^pghl_/);
    const page = (await t.api.get('/api/ai-tools')).data;
    expect(page.mcp_url).toBe('http://localhost/mcp');
    expect(page.oauth).toBe(true);
    const k = page.keys.find((x: any) => x.id === r.data.id);
    expect(k).toMatchObject({ name: 'Codex – Laptop', tool: 'codex', last_used_at: null });
    expect(JSON.stringify(page)).not.toContain(r.data.key);
    // the key really is limited to this sub-account
    const list = await (await mcpInit(r.data.key)).json();
    expect(list.result.tools.map((x: any) => x.name)).not.toContain('ghl_create_project');
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM agency_api_keys').n).toBe(0);
    // "last used" shows up after use
    expect((await t.api.get('/api/ai-tools')).data.keys.find((x: any) => x.id === r.data.id).last_used_at).toBeNull();
    await t.api.raw('/api/contacts', { headers: { authorization: `Bearer ${r.data.key}` } });
    expect((await t.api.get('/api/ai-tools')).data.keys.find((x: any) => x.id === r.data.id).last_used_at).toBeTruthy();
  });

  it('tests a key with MCP initialize + tools/list and refuses keys of other sub-accounts', async () => {
    const key = (await t.api.post('/api/ai-tools/keys', { tool: 'claude-code', label: 'PC' })).data.key;
    const test = await t.api.post('/api/ai-tools/test', { key });
    expect(test.status).toBe(200);
    expect(test.data).toMatchObject({ ok: true, protocol: '2025-06-18' });
    expect(test.data.tools).toBeGreaterThan(20);
    expect(test.data.sample).toContain('ghl_list_projects');
    expect((await t.api.post('/api/ai-tools/test', { key: 'pghl_unbekannt' })).status).toBe(400);
    t.api.setLocation(loc2);
    expect((await t.api.post('/api/ai-tools/test', { key })).status).toBe(403);
    t.api.setLocation(loc1);
  });

  it('revoking a key stops it at once', async () => {
    const r = (await t.api.post('/api/ai-tools/keys', { tool: 'cursor', label: 'Mac' })).data;
    expect((await mcpInit(r.key)).status).toBe(200);
    expect((await t.api.del(`/api/ai-tools/keys/${r.id}`)).status).toBe(200);
    expect((await mcpInit(r.key)).status).toBe(401);
    t.api.setLocation(loc2);
    const other = (await t.api.post('/api/ai-tools/keys', { tool: 'codex', label: 'x' })).data;
    t.api.setLocation(loc1);
    expect((await t.api.del(`/api/ai-tools/keys/${other.id}`)).status).toBe(404);
  });

  it('agency keys only for admins on the agency page; keys never create keys', async () => {
    const a = await t.api.post('/api/agency/ai-tools/keys', { tool: 'codex', label: 'Laptop', scope: 'read' });
    expect(a.data).toMatchObject({ name: 'Codex – Laptop', scope: 'read' });
    expect(a.data.key).toMatch(/^pghla_/);
    const page = (await t.api.get('/api/agency/ai-tools')).data;
    expect(page.keys.find((k: any) => k.id === a.data.id)).toMatchObject({ tool: 'codex', scope: 'read' });
    expect((await t.api.post('/api/agency/ai-tools/test', { key: a.data.key })).data.ok).toBe(true);

    const auth = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
    const write = (await t.api.post('/api/agency/ai-tools/keys', { tool: 'other', label: 'Skript' })).data.key;
    expect((await t.api.raw('/api/agency/ai-tools/keys', { method: 'POST', headers: auth(write), body: '{}' })).status).toBe(403);
    expect((await t.api.raw('/api/agency/ai-tools', { headers: auth(write) })).status).toBe(403);
    const loc = (await t.api.post('/api/ai-tools/keys', { tool: 'other' })).data.key;
    expect((await t.api.raw('/api/ai-tools/keys', { method: 'POST', headers: { ...auth(loc), 'x-location-id': loc1 }, body: '{}' })).status).toBe(403);
    expect((await t.api.raw('/api/ai-tools/keys', { method: 'POST', headers: { ...auth(write), 'x-location-id': loc1 }, body: '{}' })).status).toBe(403);
    expect((await t.api.del(`/api/agency/ai-tools/keys/${a.data.id}`)).status).toBe(200);
  });

  it('a client login with the settings area gets sub-account keys only – never an agency key', async () => {
    await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kunde', password: 'geheim1234', role: 'member', locations: [loc2], permissions: ['dashboard', 'settings'] });
    await t.api.post('/api/users', { email: 'team@example.com', name: 'Team', password: 'geheim1234', role: 'member', locations: [loc2], permissions: ['contacts'] });
    expect((await t.api.post('/api/auth/login', { email: 'kunde@example.com', password: 'geheim1234' })).status).toBe(200);
    t.api.setLocation(loc2);
    const before = t.app.db.get('SELECT COUNT(*) AS n FROM agency_api_keys').n;
    expect((await t.api.post('/api/agency/ai-tools/keys', { tool: 'codex', label: 'Laptop' })).status).toBe(403);
    expect((await t.api.post('/api/agency/api-keys', { name: 'x' })).status).toBe(403);
    expect((await t.api.get('/api/agency/ai-tools')).status).toBe(403);
    const r = await t.api.post('/api/ai-tools/keys', { tool: 'codex', label: 'Laptop', scope: 'agency', kind: 'agency' });
    expect(r.status).toBe(200);
    expect(r.data.key).toMatch(/^pghl_/);
    expect(r.data.key).not.toMatch(/^pghla_/);
    expect(t.app.db.get('SELECT location_id FROM api_keys WHERE id = ?', r.data.id).location_id).toBe(loc2);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM agency_api_keys').n).toBe(before);
    // not for a sub-account the login does not have
    t.api.setLocation(loc1);
    expect((await t.api.post('/api/ai-tools/keys', { tool: 'codex' })).status).toBe(403);
    t.api.setLocation(loc2);
    expect((await t.api.post('/api/ai-tools/test', { key: r.data.key })).data.ok).toBe(true);
    // without the settings area there is no KI-Werkzeuge page
    await t.api.post('/api/auth/login', { email: 'team@example.com', password: 'geheim1234' });
    expect((await t.api.get('/api/ai-tools')).status).toBe(403);
    expect((await t.api.post('/api/ai-tools/keys', { tool: 'codex' })).status).toBe(403);
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    t.api.setLocation(loc1);
  });
});

describe('integrations catalogue', () => {
  it('lists KI-Werkzeuge and OpenAI with live status', async () => {
    const cat = (await t.api.get('/api/integrations/catalog')).data.items;
    expect(cat.find((i: any) => i.key === 'ai_tools')).toMatchObject({ status: 'ok', setup: { location: 'settings/ai-tools' } });
    expect(cat.find((i: any) => i.key === 'ai_tools').detail).toContain('Schlüssel');
    expect(cat.find((i: any) => i.key === 'openai')).toMatchObject({ status: 'info', detail: 'Nicht gewählt (Claude aktiv)' });
    const agency = (await t.api.get('/api/agency/integrations/catalog')).data.items;
    expect(agency.find((i: any) => i.key === 'openai').detail).toContain('Standard: Claude');
  });
});

describe('Codex sessions and ChatGPT documents', () => {
  it('project profiles take Codex links and task ids', async () => {
    const r = await t.api.put('/api/project', { codex_sessions: [{ label: 'Landingpage', url: 'https://chatgpt.com/codex/tasks/task_e_68abc123' }, { label: '', url: 'task_e_99xyz' }, { label: 'Leer', url: '' }] });
    expect(r.status).toBe(200);
    expect(r.data.codex_sessions).toEqual([
      { label: 'Landingpage', url: 'https://chatgpt.com/codex/tasks/task_e_68abc123' },
      { label: 'Codex', url: 'https://chatgpt.com/codex/tasks/task_e_99xyz' },
    ]);
    expect((await t.api.put('/api/project', { codex_sessions: [{ url: 'https://evil.example/codex' }] })).status).toBe(400);
    expect((await t.api.put('/api/project', { codex_sessions: [{ url: 'https://chatgpt.com/share/abc' }] })).status).toBe(400);
    expect((await t.api.put('/api/project', { codex_sessions: [{ url: 'https://chatgpt.com/codex' }] })).status).toBe(200);
    const agency = (await t.api.get('/api/agency/projects')).data.find((p: any) => p.id === loc1);
    expect(agency.profile.codex_sessions).toEqual([{ label: 'Codex', url: 'https://chatgpt.com/codex' }]);
    expect((await t.api.get('/api/project')).data.claude_sessions).toEqual([]);
  });

  it('ghl_update_project sets codex_sessions over MCP', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'mcp' })).data.key;
    const r = await t.api.raw('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_update_project', arguments: { location_id: loc2, codex_sessions: [{ label: 'API', url: 'https://chatgpt.com/codex/tasks/task_e_1' }] } } }),
    });
    const out = await r.json();
    expect(out.result.isError).toBe(false);
    expect(out.result.structuredContent.codex_sessions).toEqual([{ label: 'API', url: 'https://chatgpt.com/codex/tasks/task_e_1' }]);
    const tools = await (await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
    const upd = tools.result.tools.find((x: any) => x.name === 'ghl_update_project');
    expect(upd.inputSchema.properties.codex_sessions).toBeTruthy();
  });

  it('chatgpt.com links are accepted as documents with kind and source', async () => {
    expect(guessDoc('https://chatgpt.com/codex/tasks/task_e_1')).toEqual({ kind: 'session', source: 'Codex' });
    expect(guessDoc('https://chatgpt.com/canvas/shared/abc')).toEqual({ kind: 'artifact', source: 'ChatGPT' });
    expect(guessDoc('https://chatgpt.com/share/abc')).toEqual({ kind: 'doc', source: 'ChatGPT' });
    expect(guessDoc('https://claude.ai/artifact/x')).toEqual({ kind: 'artifact', source: 'Claude' });
    expect(guessDoc('https://example.com/x')).toBeNull();
    const r = await t.api.post('/api/agency/docs', { docs: [{ url: 'https://chatgpt.com/codex/tasks/task_e_42', title: 'Codex: Checkout-Bug' }, { url: 'https://chatgpt.com/canvas/shared/c1', title: 'Konzept', location_id: loc1 }] });
    expect(r.data).toMatchObject({ created: 2 });
    const inbox = (await t.api.get('/api/agency/docs?unassigned=1')).data.find((d: any) => d.url.endsWith('task_e_42'));
    expect(inbox).toMatchObject({ kind: 'session', source: 'Codex' });
    const filed = (await t.api.get('/api/docs')).data.find((d: any) => d.title === 'Konzept');
    expect(filed).toMatchObject({ kind: 'artifact', source: 'ChatGPT' });
    // explicit kind/source still win
    await t.api.post('/api/docs', { url: 'https://chatgpt.com/share/s1', title: 'Chat', kind: 'link', source: 'Team' });
    expect((await t.api.get('/api/docs')).data.find((d: any) => d.title === 'Chat')).toMatchObject({ kind: 'link', source: 'Team' });
  });
});
