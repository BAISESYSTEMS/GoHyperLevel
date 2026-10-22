import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client } from './security-fixtures.js';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';

/**
 * Security wave 10b (agency): the Prompt-Optimierer only reaches the AI agents the caller may see (a colleague's private agent
 * stays private, also for admins and sub-account keys), and agency keys cannot change people's areas through own roles.
 */

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const SECRET = 'GEHEIMREZEPT-4711';
const calls: any[] = [];
const fake = (async (_url: string, init: any = {}) => {
  const body = JSON.parse(init.body);
  calls.push(body);
  const sys = JSON.stringify(body.system ?? '');
  const text = sys.includes('prüfst streng') ? '{"pass":true,"score":10,"reason":"gut"}' : sys.includes('verbesserst') ? '{"instructions":"neu","changes":[]}' : 'Hallo!';
  return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let mia: ReturnType<typeof client>;
beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fake;
  await t.setup();
  loc = t.api.location;
  expect((await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true })).status).toBe(200);
  const u = await t.api.post('/api/users', { email: 'mia@example.com', password: 'passwort-123', name: 'Mia', locations: [loc], permissions: ['dashboard', 'contacts', 'settings'] });
  expect(u.status, JSON.stringify(u.data)).toBe(200);
  mia = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await mia('POST', '/api/auth/login', { email: 'mia@example.com', password: 'passwort-123' })).status).toBe(200);
}, 60_000);
afterAll(() => t?.close());

const cases = [{ input: 'Was kostet es?', expect: 'Nennt keinen erfundenen Preis' }];

describe('Prompt-Optimierer respects private AI agents', () => {
  let priv = '';
  let shared = '';
  let foreignSuite = '';
  let subKey = '';
  beforeAll(async () => {
    const a = await mia('POST', '/api/agents', { name: 'Mias Notizen', instructions: `Interne Preisliste: ${SECRET}` });
    expect(a.status, JSON.stringify(a.data)).toBe(200);
    priv = a.data.id;
    expect(t.app.db.get<{ visibility: string }>('SELECT visibility FROM agents WHERE id = ?', priv)!.visibility).toBe('private');
    const s = await t.api.post('/api/agents', { name: 'Empfang', instructions: 'Du beantwortest Fragen von Kunden.', visibility: 'location' });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    shared = s.data.id;
    // A suite on Mia's private agent (made by Mia, with a fully passed last run).
    const mine = await mia('POST', '/api/prompt-lab', { kind: 'agent', target_id: priv, name: 'Meine Tests', cases });
    expect(mine.status, JSON.stringify(mine.data)).toBe(200);
    foreignSuite = mine.data.id;
    t.app.db.run('UPDATE prompt_suites SET last_run = ? WHERE id = ?', JSON.stringify({ at: new Date().toISOString(), passed: 1, total: 1, score: 100, results: [{ ...cases[0], answer: `Laut Liste ${SECRET}`, pass: true, score: 10, reason: 'ok' }] }), foreignSuite);
    subKey = (await t.api.post('/api/api-keys', { name: 'Sub' })).data.key;
    expect(subKey).toBeTruthy();
  });

  it('does not list a colleague’s private agent (not even for an admin)', async () => {
    const r = await t.api.get('/api/prompt-lab');
    expect(r.status).toBe(200);
    expect(r.data.agents.map((x: any) => x.id)).toContain(shared);
    expect(r.data.agents.map((x: any) => x.id)).not.toContain(priv);
    expect(JSON.stringify(r.data)).not.toContain(SECRET);
    expect(r.data.suites.map((x: any) => x.id)).not.toContain(foreignSuite);
  });

  it('refuses a suite on a colleague’s private agent', async () => {
    const r = await t.api.post('/api/prompt-lab', { kind: 'agent', target_id: priv, name: 'Spion', cases });
    expect(r.status).toBe(404);
  });

  it('refuses to run, improve or change a suite on a colleague’s private agent', async () => {
    calls.length = 0;
    const imp = await t.api.post(`/api/prompt-lab/${foreignSuite}/improve`);
    expect(imp.status).toBe(404);
    expect(JSON.stringify(imp.data)).not.toContain(SECRET);
    const run = await t.api.post(`/api/prompt-lab/${foreignSuite}/run`);
    expect(run.status).toBe(404);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect((await t.api.patch(`/api/prompt-lab/${foreignSuite}`, { name: 'x' })).status).toBe(404);
    expect((await t.api.del(`/api/prompt-lab/${foreignSuite}`)).status).toBe(404);
  });

  it('a sub-account API key reaches shared agents only', async () => {
    const key = client(t.base, { authorization: `Bearer ${subKey}` });
    const list = await key('GET', '/api/prompt-lab');
    expect(list.status).toBe(200);
    expect(list.data.agents.map((x: any) => x.id)).toContain(shared);
    expect(list.data.agents.map((x: any) => x.id)).not.toContain(priv);
    expect(JSON.stringify(list.data)).not.toContain(SECRET);
    expect((await key('POST', '/api/prompt-lab', { kind: 'agent', target_id: priv, name: 'Spion', cases })).status).toBe(404);
    expect((await key('POST', `/api/prompt-lab/${foreignSuite}/improve`)).status).toBe(404);
    expect((await key('POST', `/api/prompt-lab/${foreignSuite}/run`)).status).toBe(404);
    const ok = await key('POST', '/api/prompt-lab', { kind: 'agent', target_id: shared, name: 'Empfang', cases });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    calls.length = 0;
    const run = await key('POST', `/api/prompt-lab/${ok.data.id}/run`);
    expect(run.status, JSON.stringify(run.data)).toBe(200);
    expect(JSON.stringify(calls[0].system)).toContain('Du beantwortest Fragen von Kunden.');
  });

  it('the owner still tests and improves her own private agent', async () => {
    const list = await mia('GET', '/api/prompt-lab');
    expect(list.data.agents.map((x: any) => x.id)).toEqual(expect.arrayContaining([priv, shared]));
    expect(list.data.suites.map((x: any) => x.id)).toContain(foreignSuite);
    calls.length = 0;
    const run = await mia('POST', `/api/prompt-lab/${foreignSuite}/run`);
    expect(run.status, JSON.stringify(run.data)).toBe(200);
    expect(JSON.stringify(calls[0].system)).toContain(SECRET);
    const imp = await mia('POST', `/api/prompt-lab/${foreignSuite}/improve`);
    expect(imp.status).toBe(200);
    expect(imp.data).toMatchObject({ unchanged: true });
    expect(imp.data.instructions).toContain(SECRET);
  });

  it('a suite whose agent was deleted can still be removed', async () => {
    const tmp = (await t.api.post('/api/agents', { name: 'Weg', instructions: 'x', visibility: 'location' })).data.id;
    const s = (await t.api.post('/api/prompt-lab', { kind: 'agent', target_id: tmp, name: 'Weg', cases })).data;
    expect((await t.api.del(`/api/agents/${tmp}`)).status).toBe(200);
    expect((await t.api.post(`/api/prompt-lab/${s.id}/run`)).status).toBe(404);
    expect((await t.api.del(`/api/prompt-lab/${s.id}`)).status).toBe(200);
  });
});

describe('agency keys cannot change people’s areas through own roles', () => {
  let agencyKey = '';
  let memberId = '';
  let tpl = '';
  let key: ReturnType<typeof client>;
  beforeAll(async () => {
    const k = await t.api.post('/api/agency/api-keys', { name: 'Integration', scope: 'write' });
    expect(k.status, JSON.stringify(k.data)).toBe(200);
    agencyKey = k.data.key;
    key = client(t.base, { authorization: `Bearer ${agencyKey}` });
    const u = await t.api.post('/api/users', { email: 'opfer@example.com', password: 'passwort-123', name: 'Opfer', locations: [loc], permissions: ['dashboard'] });
    expect(u.status, JSON.stringify(u.data)).toBe(200);
    memberId = u.data.id;
    const r = await t.api.post('/api/role-templates', { preset: 'assistant', name: 'Assistenz' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    tpl = r.data.id;
  });
  const perms = () => JSON.parse(t.app.db.get<{ permissions: string }>('SELECT permissions FROM users WHERE id = ?', memberId)!.permissions);

  it('still reads the roles (MCP ghl_role_templates)', async () => {
    const r = await key('GET', '/api/role-templates');
    expect(r.status).toBe(200);
    expect(r.data.templates.map((x: any) => x.id)).toContain(tpl);
  });

  it('refuses creating, changing, assigning, unassigning and deleting roles', async () => {
    const all = (await t.api.get('/api/role-templates')).data.permissions;
    const created = await key('POST', '/api/role-templates', { name: 'Alles', permissions: Object.keys(all) });
    expect(created.status).toBe(403);
    expect(t.app.db.get('SELECT id FROM role_templates WHERE name = ?', 'Alles')).toBeFalsy();
    expect((await key('PATCH', `/api/role-templates/${tpl}`, { permissions: Object.keys(all) })).status).toBe(403);
    expect((await key('POST', `/api/role-templates/${tpl}/assign`, { user_ids: [memberId] })).status).toBe(403);
    expect(perms()).toEqual(['dashboard']);
    expect((await key('POST', '/api/role-templates/unassign', { user_id: memberId })).status).toBe(403);
    expect((await key('DELETE', `/api/role-templates/${tpl}`)).status).toBe(403);
    expect(t.app.db.get('SELECT id FROM role_templates WHERE id = ?', tpl)).toBeTruthy();
    expect(t.app.db.get<{ permissions: string }>('SELECT permissions FROM role_templates WHERE id = ?', tpl)!.permissions).not.toContain('settings');
  });

  it('a logged-in admin still manages roles', async () => {
    expect((await t.api.post(`/api/role-templates/${tpl}/assign`, { user_ids: [memberId] })).status).toBe(200);
    expect(perms()).toEqual(expect.arrayContaining(['contacts', 'calendars']));
    expect((await t.api.post('/api/role-templates/unassign', { user_id: memberId })).status).toBe(200);
    expect((await t.api.del(`/api/role-templates/${tpl}`)).status).toBe(200);
  });
});
