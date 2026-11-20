import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

// One login per AI agent: a sub-account key bound to a team user gets that user's areas, not the whole sub-account.
describe('API keys bound to a team user', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let agentId = '';
  const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    t = await startTestApp();
    await t.setup();
    const u = await t.api.post('/api/users', { email: 'grok@agents.test', password: 'agent12345', name: 'GrokBot', locations: [t.api.location], permissions: ['contacts'] });
    expect(u.status).toBe(200);
    agentId = u.data.id;
  });
  afterAll(() => t.close());

  it('acts with the user’s areas and names the user in the audit log', async () => {
    const k = await t.api.post('/api/api-keys', { name: 'GrokBot', user_id: agentId });
    expect(k.status).toBe(200);
    expect(k.data.user_id).toBe(agentId);
    const h = bearer(k.data.key);
    expect((await t.api.get('/api/contacts', h)).status).toBe(200);
    const c = await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@kunde.test' }, h);
    expect(c.status).toBe(200);
    expect((await t.api.get('/api/opportunities', h)).status).toBe(403);
    expect((await t.api.get('/api/invoices', h)).status).toBe(403);
    const list = (await t.api.get('/api/api-keys')).data;
    expect(list.find((x: any) => x.id === k.data.id)).toMatchObject({ user_id: agentId, user_name: 'GrokBot' });
    const row = t.app.db.get<{ actor: string; user_id: string }>(`SELECT actor, user_id FROM audit_log WHERE route = 'POST /api/contacts' ORDER BY at DESC`);
    expect(row).toMatchObject({ actor: 'GrokBot', user_id: agentId });
  });

  it('leaves unbound keys as before (whole sub-account)', async () => {
    const k = await t.api.post('/api/api-keys', { name: 'Skript' });
    expect(k.data.user_id).toBeNull();
    expect((await t.api.get('/api/opportunities', bearer(k.data.key))).status).toBe(200);
  });

  it('stops working when the user loses the sub-account or is deleted', async () => {
    const u = await t.api.post('/api/users', { email: 'codex@agents.test', password: 'agent12345', name: 'Codex', locations: [t.api.location], permissions: ['contacts'] });
    const k = await t.api.post('/api/api-keys', { name: 'Codex', user_id: u.data.id });
    const h = bearer(k.data.key);
    expect((await t.api.get('/api/contacts', h)).status).toBe(200);
    t.app.db.run(`UPDATE users SET locations = '[]' WHERE id = ?`, u.data.id);
    expect((await t.api.get('/api/contacts', h)).status).toBe(403);
    t.app.db.run('DELETE FROM users WHERE id = ?', u.data.id);
    expect((await t.api.get('/api/contacts', h)).status).toBe(401);
    expect((await t.api.get('/api/api-keys')).data.some((x: any) => x.id === k.data.id)).toBe(false);
  });

  it('refuses users without access and members handing out more than they have', async () => {
    const outsider = await t.api.post('/api/users', { email: 'fremd@agents.test', password: 'agent12345', name: 'Fremd', locations: [], permissions: ['contacts'] });
    expect((await t.api.post('/api/api-keys', { name: 'x', user_id: outsider.data.id })).status).toBe(400);
    expect((await t.api.post('/api/api-keys', { name: 'x', user_id: 'nope' })).status).toBe(400);
    // A member with only "contacts" + "settings" may not bind a key to a user who also has "opportunities".
    const wide = await t.api.post('/api/users', { email: 'wide@agents.test', password: 'agent12345', name: 'Wide', locations: [t.api.location], permissions: ['contacts', 'opportunities'] });
    await t.api.post('/api/users', { email: 'member@kunde.test', password: 'member12345', name: 'Mitglied', locations: [t.api.location], permissions: ['contacts', 'settings'] });
    const loc = t.api.location;
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'member@kunde.test', password: 'member12345' })).status).toBe(200);
    t.api.setLocation(loc);
    expect((await t.api.post('/api/api-keys', { name: 'x', user_id: wide.data.id })).status).toBe(403);
    expect((await t.api.post('/api/api-keys', { name: 'x', user_id: agentId })).status).toBe(200);
  });

  it('tasks & projects are their own area: an agent plans along without seeing customers', async () => {
    // back to the owner (the test before signed in as a member)
    const loc = t.api.location;
    t.api.clearCookie();
    expect((await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
    t.api.setLocation(loc);
    const u = await t.api.post('/api/users', { email: 'planer@agents.test', password: 'agent12345', name: 'Planer', locations: [t.api.location], permissions: ['tasks', 'teamchat'] });
    const h = bearer((await t.api.post('/api/api-keys', { name: 'Planer', user_id: u.data.id })).data.key);
    const c = (await t.api.post('/api/contacts', { first_name: 'Familie', last_name: 'Kind', email: 'familie@kunde.test' })).data;
    const p = (await t.api.post('/api/pm/projects', { name: 'Planung' })).data;
    await t.api.post('/api/pm/tasks', { project_id: p.id, title: 'Buch drucken', contact_id: c.id });
    await t.api.post('/api/tasks', { title: 'Anrufen', contact_id: c.id });
    const pm = await t.api.get(`/api/pm/tasks?project_id=${p.id}`, h);
    expect(pm.status).toBe(200);
    const list = JSON.stringify(pm.data);
    expect(list).toContain('Buch drucken');
    expect(list).not.toContain('Familie');
    const simple = await t.api.get('/api/tasks', h);
    expect(simple.status).toBe(200);
    expect(JSON.stringify(simple.data)).not.toContain('familie@kunde.test');
    expect((await t.api.get('/api/contacts', h)).status).toBe(403);
    expect((await t.api.get(`/api/contacts/${c.id}`, h)).status).toBe(403);
    // the owner still sees the customer behind the task
    expect(JSON.stringify((await t.api.get(`/api/pm/tasks?project_id=${p.id}`)).data)).toContain('Familie');
  });

  it('read-only keys read but never write, also over MCP', async () => {
    const k = await t.api.post('/api/api-keys', { name: 'Leser', scope: 'read' });
    expect(k.data.scope).toBe('read');
    const h = bearer(k.data.key);
    expect((await t.api.get('/api/contacts', h)).status).toBe(200);
    expect((await t.api.post('/api/contacts', { first_name: 'Neu' }, h)).status).toBe(403);
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const r = await t.api.raw('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${k.data.key}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return JSON.stringify(await r.json());
    };
    expect(await mcp('ghl_search_contacts', { location_id: t.api.location, query: 'Anna' })).toContain('Anna');
    const write = await mcp('ghl_upsert_contact', { location_id: t.api.location, first_name: 'Darf', email: 'darf@nicht.test' });
    expect(write).toContain('nur lesen');
    expect((await t.api.get('/api/contacts?q=darf')).data.contacts).toEqual([]);
  });
});
