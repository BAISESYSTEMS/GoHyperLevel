import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { anthropicSse, fakeModel, sse } from './agent-fakes.js';
import { retry } from '../server/services/agent-llm.js';
import { scheduleDue } from '../server/modules/agent-custom.js';

const AKEY = 'sk-ant-api03-automation-abcdefghijklmnopqrstuvwxyz';
const model = fakeModel();
let t: Awaited<ReturnType<typeof startTestApp>>;
let contactId = '';
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
const say = (text: string) => ({ type: 'text' as const, text });
const login = async (email: string) => {
  t.api.clearCookie();
  expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
};

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  await t.api.post('/api/ai-connections', { provider: 'anthropic', api_key: AKEY, models: { text: 'claude-sonnet-5-5' } });
  contactId = (await t.api.post('/api/contacts', { first_name: 'Lena', last_name: 'Lead', email: 'lena@lead.example' })).data.id;
  await t.api.post('/api/users', { email: 'kunde@example.com', name: 'Kundin', password: 'geheim123', role: 'member', locations: [t.api.location], permissions: ['contacts', 'conversations', 'settings'] });
});
afterAll(() => t.close());
beforeEach(() => model.reset());

describe('custom agents', () => {
  it('creates from the template gallery, edits, clones, exports and imports', async () => {
    const templates = (await t.api.get('/api/agents/templates')).data;
    expect(templates.map((x: any) => x.name)).toEqual(['Vertriebs-Assistent', 'Support-Agent', 'Social-Media-Manager', 'Projekt-Manager', 'Rechnungs-Assistent', 'Onboarding-Coach', 'Daten-Aufräumer', 'Lead-Recherche']);
    const a = (await t.api.post('/api/agents', { template: 'sales' })).data;
    expect(a).toMatchObject({ name: 'Vertriebs-Assistent', emoji: '💼', mode: 'ask', visibility: 'private', template: 'sales', can_edit: true });
    expect(a.tools).toContain('ghl_list_opportunities');
    expect(a.starters.length).toBeGreaterThan(2);
    const p = (await t.api.patch(`/api/agents/${a.id}`, { name: 'Vertrieb Nord', instructions: 'Nur Norddeutschland.', starters: ['Was ist heute dran?'] })).data;
    expect(p).toMatchObject({ name: 'Vertrieb Nord', instructions: 'Nur Norddeutschland.', starters: ['Was ist heute dran?'] });
    const c = (await t.api.post(`/api/agents/${a.id}/clone`)).data;
    expect(c.name).toBe('Vertrieb Nord (Kopie)');
    const exp = (await t.api.get(`/api/agents/${a.id}/export`)).data;
    expect(exp).toMatchObject({ format: 'gohigh-agent', version: 1, agent: { name: 'Vertrieb Nord' } });
    expect(JSON.stringify(exp)).not.toContain(a.owner_id);
    const imp = (await t.api.post('/api/agents/import', exp)).data;
    expect(imp).toMatchObject({ name: 'Vertrieb Nord', visibility: 'private' });
    expect((await t.api.post('/api/agents/import', { data: { format: 'x' } })).status).toBe(400);
    expect((await t.api.del(`/api/agents/${c.id}`)).status).toBe(200);
  });

  it('visibility: private stays private, "location" is shared, only the owner (or an admin) edits', async () => {
    const mine = (await t.api.post('/api/agents', { name: 'Privat', instructions: 'geheim' })).data;
    const shared = (await t.api.post('/api/agents', { name: 'Für alle', visibility: 'location' })).data;
    await login('kunde@example.com');
    const list = (await t.api.get('/api/agents')).data.map((x: any) => x.name);
    expect(list).toContain('Für alle');
    expect(list).not.toContain('Privat');
    expect((await t.api.get(`/api/agents/${mine.id}`)).status).toBe(404);
    expect((await t.api.patch(`/api/agents/${shared.id}`, { name: 'Gekapert' })).status).toBe(403);
    // members can't switch off confirmations or pick the agency team
    expect((await t.api.post('/api/agents', { name: 'X', confirm_sensitive: false })).status).toBe(403);
    expect((await t.api.post('/api/agents', { name: 'X', visibility: 'team' })).status).toBe(403);
    // a member's private agent runs as the member, chatting with a private agent of someone else fails
    expect((await t.api.post('/api/agent/chat', { agent_id: mine.id, message: 'Hi' })).data).toContain('Agent nicht gefunden');
    await login('chef@example.com');
  });
});

describe('automatic runs', () => {
  it('workflow action "KI-Agent ausführen" writes the answer as a note', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'Zusammenfasser', visibility: 'location', mode: 'read' })).data;
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.steps).toContain('agent_run');
    const wf = (await t.api.post('/api/workflows', { name: 'Agent', trigger: { type: 'contact.tag_added', config: { tag: 'agent' } }, steps: [{ type: 'agent_run', agent_id: agent.id, prompt: 'Fasse {{contact.first_name}} zusammen.', target: 'note' }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    model.reply(sse(anthropicSse([tool('tu_1', 'ghl_get_contact', { contact_id: contactId })])), sse(anthropicSse([say('Lena ist ein neuer Lead.')])));
    await t.api.post(`/api/contacts/${contactId}/tags`, { add: ['agent'] });
    await t.app.events.flush();
    for (let i = 0; i < 20 && model.pending(); i++) await new Promise((r) => setTimeout(r, 25));
    await t.app.tick();
    expect(model.calls[0].body.messages[0].content.some((p: any) => String(p.text).includes('Fasse Lena zusammen.'))).toBe(true);
    const contact = (await t.api.get(`/api/contacts/${contactId}`)).data;
    expect(contact.notes.some((n: any) => n.body.includes('Lena ist ein neuer Lead.'))).toBe(true);
    const runs = (await t.api.get(`/api/agents/${agent.id}/runs`)).data;
    expect(runs[0]).toMatchObject({ source: 'workflow', status: 'done' });
  });

  it('automatic runs put actions that need a confirmation into "Freigaben" instead of running them', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'Mailer', visibility: 'location', mode: 'ask' })).data;
    model.reply(sse(anthropicSse([tool('tu_m', 'ghl_send_message', { contact_id: contactId, channel: 'email', subject: 'Hi', body: 'Hallo Lena' })])), sse(anthropicSse([say('Mail liegt zur Freigabe.')])));
    const r = (await t.api.post('/api/agent/run', { agent_id: agent.id, prompt: 'Schreib Lena' })).data;
    expect(r.status).toBe('done');
    expect(r.pending[0]).toMatchObject({ tool: 'ghl_send_message', deferred: true });
    expect((await t.api.get(`/api/contacts/${contactId}/messages`)).data).toHaveLength(0);
    const approvals = (await t.api.get('/api/agent/approvals')).data;
    expect(approvals[0]).toMatchObject({ tool: 'ghl_send_message', status: 'pending', agent: 'Mailer' });
    const done = (await t.api.post(`/api/agent/approvals/${approvals[0].id}`, { approve: true })).data;
    expect(done.status).toBe('done');
    expect((await t.api.get(`/api/contacts/${contactId}/messages`)).data[0]).toMatchObject({ subject: 'Hi' });
    expect((await t.api.post(`/api/agent/approvals/${approvals[0].id}`, { approve: true })).status).toBe(409);
  });

  it('schedules run when due and deliver a task', async () => {
    const tz = 'Europe/Berlin';
    const at = new Date('2026-10-05T08:30:00Z'); // Monday 10:30 in Berlin
    const s = { id: 's1', enabled: true, cadence: 'daily' as const, weekday: 0, day: 1, time: '10:00', prompt: 'x', deliver: 'task' as const };
    expect(scheduleDue(s, tz, undefined, at)).toBe('2026-10-05');
    expect(scheduleDue(s, tz, '2026-10-05', at)).toBeNull();
    expect(scheduleDue({ ...s, time: '11:00' }, tz, undefined, at)).toBeNull();
    expect(scheduleDue({ ...s, cadence: 'weekly', weekday: 2 }, tz, undefined, at)).toBeNull();
    expect(scheduleDue({ ...s, cadence: 'weekly', weekday: 0 }, tz, undefined, at)).toBe('2026-10-05');
    expect(scheduleDue({ ...s, cadence: 'weekdays' }, tz, undefined, new Date('2026-10-04T08:30:00Z'))).toBeNull();

    const agent = (await t.api.post('/api/agents', { name: 'Briefing', mode: 'read', schedules: [{ cadence: 'daily', time: '00:00', prompt: 'Was ist heute wichtig?', deliver: 'task' }] })).data;
    expect(agent.schedules[0]).toMatchObject({ cadence: 'daily', time: '00:00', deliver: 'task' });
    model.reply(sse(anthropicSse([say('Heute: 1 neuer Lead (Lena).')])));
    await t.app.tick();
    const tasks = (await t.api.get('/api/tasks')).data;
    const task = (tasks.tasks ?? tasks).find((x: any) => x.title.includes('Briefing'));
    expect(task.description).toContain('1 neuer Lead');
    // once per day
    await t.app.tick();
    expect(model.calls).toHaveLength(1);
  });

  it('auto-responder drafts a reply to an inbound mail (draft mode), read-only and tainted', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'Support', visibility: 'location', mode: 'auto', responder: { enabled: true, channels: ['email'], mode: 'draft' } })).data;
    expect(agent.responder).toMatchObject({ enabled: true, channels: ['email'], mode: 'draft' });
    model.reply(sse(anthropicSse([say('Hallo Lena, danke für deine Nachricht – wir melden uns heute noch.')])));
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const u = new URL(urls.email);
    await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Nora Neu <nora@neu.example>', subject: 'Angebot', text: 'Könnt ihr mir ein Angebot schicken?' }) });
    await t.app.events.flush();
    // (Lena got a mail from the team in the test before – the agent leaves such chats to the team.)
    expect(model.calls).toHaveLength(1);
    const first = model.calls[0].body;
    expect(first.tools.every((x: any) => !['ghl_send_message', 'ghl_create_task', 'web_fetch'].includes(x.name))).toBe(true);
    expect(JSON.stringify(first.messages)).toContain('trust=\\"untrusted\\"');
    const nora = (await t.api.get('/api/contacts?q=nora@neu.example')).data;
    const msgs = (await t.api.get(`/api/contacts/${(nora.contacts ?? nora)[0].id}/messages`)).data;
    const draft = msgs.find((m: any) => m.status === 'draft');
    expect(draft).toMatchObject({ source: 'KI-Agent', subject: 'Re: Angebot', channel: 'email' });
    expect(draft.body).toContain('wir melden uns');
    // the KI-Assistent's own e-mail drafts take precedence
    await t.api.put('/api/ai/settings', { enabled: true, api_key: AKEY, email_drafts: true });
    t.app.services.aiFetch = async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Entwurf vom Assistenten' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    model.reset();
    await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'nora@neu.example', subject: 'Noch was', text: 'Und der Preis?' }) });
    await t.app.events.flush();
    expect(model.calls).toHaveLength(0);
    await t.api.put('/api/ai/settings', { enabled: false, email_drafts: false });
    await t.api.patch(`/api/agents/${agent.id}`, { responder: { enabled: false, channels: [] } });
  });
});

describe('MCP, mobile app and Custom GPT actions', () => {
  it('runs a custom agent over MCP (ghl_list_agents / ghl_run_agent) as its owner', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'MCP-Agent', visibility: 'location', mode: 'read' })).data;
    const key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
    const rpc = async (body: any) => (await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })).json();
    const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((x: any) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['ghl_list_agents', 'ghl_run_agent']));
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_list_agents', arguments: { location_id: t.api.location } } });
    expect(JSON.parse(list.result.content[0].text).map((x: any) => x.name)).toContain('MCP-Agent');
    model.reply(sse(anthropicSse([say('Alles ruhig heute.')])));
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_run_agent', arguments: { location_id: t.api.location, agent_id: agent.id, prompt: 'Status?' } } });
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ status: 'done', text: 'Alles ruhig heute.' });
    // private agents of others are not reachable with a key
    const priv = (await t.api.post('/api/agents', { name: 'Nur ich' })).data;
    const denied = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghl_run_agent', arguments: { location_id: t.api.location, agent_id: priv.id, prompt: 'x' } } });
    expect(denied.result.isError).toBe(true);
  });

  it('answers the Android app on POST /api/mobile/agent (with confirmation)', async () => {
    const paired = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel', platform: 'android', app_version: '1.0' })).data;
    const auth = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
    const send = (path: string, body: unknown) => t.api.raw(path, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
    model.reply(sse(anthropicSse([tool('tu_t', 'ghl_create_task', { title: 'Rückruf Lena' })])));
    const r = await send('/api/mobile/agent', { location_id: t.api.location, message: 'Erinnere mich an einen Rückruf bei Lena' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'awaiting', confirmation: { tool: 'ghl_create_task' } });
    model.reply(sse(anthropicSse([say('Aufgabe angelegt.')])));
    const c = await send('/api/mobile/agent/confirm', { location_id: t.api.location, pending_id: r.data.confirmation.id, token: r.data.confirmation.token, approve: true });
    expect(c.data).toMatchObject({ status: 'done', text: 'Aufgabe angelegt.' });
    const info = await t.api.raw(`/api/mobile/agent?location=${t.api.location}`, { headers: auth }).then((x) => x.json());
    expect(info.conversations[0].id).toBe(r.data.conversation_id);
    // the app token works only under /api/mobile
    expect((await t.api.raw('/api/agent/conversations', { headers: { ...auth, 'x-location-id': t.api.location } })).status).toBe(403);
  });

  it('serves a valid OpenAPI 3.1 schema for Custom GPT actions and checks the bearer key', async () => {
    const k = (await t.api.post('/api/agent/gpt-actions/keys', { name: 'Mein GPT', tools: ['ghl_search_contacts', 'ghl_create_task', 'ghl_send_message'] })).data;
    expect(k.key).toMatch(/^gha_/);
    const doc = await t.api.raw(`/api/agent/gpt-actions/openapi.json?k=${k.id}`).then((r) => r.json());
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0].url).toBe('http://localhost');
    expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    const ops = Object.entries(doc.paths).map(([p, v]: [string, any]) => ({ p, ...v.post }));
    expect(ops.map((o) => o.operationId).sort()).toEqual(['ghl_create_task', 'ghl_search_contacts', 'ghl_send_message']);
    for (const o of ops) {
      expect(o.operationId).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(o.description.length).toBeLessThanOrEqual(300);
      expect(o.requestBody.content['application/json'].schema.type).toBe('object');
      expect(o.requestBody.content['application/json'].schema.properties.location_id).toBeUndefined();
      expect(typeof o['x-openai-isConsequential']).toBe('boolean');
    }
    expect(ops.find((o) => o.operationId === 'ghl_search_contacts')['x-openai-isConsequential']).toBe(false);
    const def = await t.api.raw('/api/agent/gpt-actions/openapi.json').then((r) => r.json());
    expect(Object.keys(def.paths).length).toBeLessThanOrEqual(30);

    const call = (name: string, body: unknown, key?: string) => t.api.raw(`/api/agent/gpt-actions/tools/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    expect((await call('ghl_search_contacts', { query: 'Lena' })).status).toBe(401);
    expect((await call('ghl_search_contacts', { query: 'Lena' }, 'gha_falsch')).status).toBe(401);
    expect((await call('ghl_list_tasks', {}, k.key)).status).toBe(403);
    // read-only key: no writes
    expect((await call('ghl_create_task', { title: 'Von ChatGPT' }, k.key)).status).toBe(403);
    const ok = await call('ghl_search_contacts', { query: 'Lena' }, k.key);
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).toContain('lena@lead.example');
    // a write key may write, but not send without the admin's extra permission
    const w = (await t.api.post('/api/agent/gpt-actions/keys', { name: 'Schreiben', tools: ['ghl_create_task', 'ghl_send_message'], allow_write: true })).data;
    expect((await call('ghl_create_task', { title: 'Von ChatGPT' }, w.key)).status).toBe(200);
    expect((await call('ghl_send_message', { contact_id: contactId, channel: 'email', body: 'x' }, w.key)).status).toBe(403);
    const audit = (await t.api.get('/api/audit?limit=3')).data;
    expect(audit[0]).toMatchObject({ via: 'agent' });
  });
});
