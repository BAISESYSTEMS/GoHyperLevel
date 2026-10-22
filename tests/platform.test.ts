import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { isPrivateIp, safeFetch } from '../server/services/net.js';
import { actionOf } from '../server/modules/security.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
});
afterAll(async () => {
  await t.close();
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('hardening', () => {
  it('blocks internal targets for user-supplied URLs', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPrivateIp(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '93.184.216.34', '2a00:1450:4001::1']) expect(isPrivateIp(ip)).toBe(false);
    await expect(safeFetch('http://127.0.0.1:1/x')).rejects.toThrow(/intern/);
    await expect(safeFetch('http://localhost:1/x')).rejects.toThrow(/intern/);
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('checks upload contents against the type', async () => {
    expect((await t.api.post('/api/uploads', { name: 'a.png', data: PNG })).status).toBe(200);
    const fake = 'data:image/png;base64,' + Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    expect((await t.api.post('/api/uploads', { name: 'evil.png', data: fake })).data.error).toContain('passt nicht');
  });

  it('sets security headers', async () => {
    const r = await t.api.raw('/api/auth/status');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBeTruthy();
  });

  it('logs writes with who and how', async () => {
    expect(actionOf('POST', '/api/contacts/:id/notes')).toBe('contacts.notes.create');
    const c = (await t.api.post('/api/contacts', { email: 'audit@x.de', first_name: 'Audit' })).data;
    await t.api.patch(`/api/contacts/${c.id}`, { company: 'Prüf GmbH' });
    const log = (await t.api.get('/api/admin/audit?limit=20')).data;
    const upd = log.find((e: any) => e.action === 'contacts.update');
    expect(upd).toMatchObject({ entity_id: c.id, via: 'session', actor: 'Chef', location_id: t.api.location });
    expect(log.some((e: any) => e.action === 'login' || e.action === 'contacts.create')).toBe(true);
    expect((await t.api.get('/api/audit')).data.length).toBeGreaterThan(0);
  });

  it('lists signed-in devices and signs others out', async () => {
    const mine = t.api.cookie;
    t.api.clearCookie();
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
    const other = t.api.cookie;
    const list = (await t.api.get('/api/me/sessions')).data;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s: any) => s.current)).toHaveLength(1);
    expect((await t.api.post('/api/me/sessions/revoke-others')).data.revoked).toBeGreaterThanOrEqual(1);
    expect(t.api.cookie).toBe(other);
    // The first session is gone now.
    const r = await t.api.raw('/api/me', { headers: { cookie: mine } });
    expect(r.status).toBe(401);
  });
});

describe('projects hub', () => {
  it('stores a project profile and shows all projects to the agency', async () => {
    const r = await t.api.put('/api/project', { status: 'live', tagline: 'Online-Kurse für Hobbygärtner', website: 'https://example.com', repos: ['beispiel-org/gartenkurse'], links: [{ label: 'Studio', url: 'https://kurse.example.com' }], kpis: [{ label: 'Bücher', value: '21', target: '50' }] });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'live', repos: ['beispiel-org/gartenkurse'] });
    expect((await t.api.put('/api/project', { status: 'fertig' })).status).toBe(400);
    expect((await t.api.put('/api/project', { website: 'javascript:alert(1)' })).status).toBe(400);
    const p = (await t.api.get('/api/project')).data;
    expect(p.stats).toHaveProperty('open_tasks');
    const all = (await t.api.get('/api/agency/projects')).data;
    expect(all[0].profile.tagline).toBe('Online-Kurse für Hobbygärtner');
  });

  it('links Claude sessions to a project', async () => {
    const r = await t.api.put('/api/project', { claude_sessions: [{ label: 'Go-to-Market', url: 'session_01ABCdef' }, { label: 'Web', url: 'https://claude.ai/code/session_02XYZ' }] });
    expect(r.data.claude_sessions).toEqual([
      { label: 'Go-to-Market', url: 'https://claude.ai/code/session_01ABCdef' },
      { label: 'Web', url: 'https://claude.ai/code/session_02XYZ' },
    ]);
    expect((await t.api.put('/api/project', { claude_sessions: [{ url: 'https://evil.example/session' }] })).status).toBe(400);
    const all = (await t.api.get('/api/agency/projects')).data;
    expect(all[0].profile.claude_sessions).toHaveLength(2);
  });

  it('lists contacts and deals of every project for the agency', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'quer@x.de', first_name: 'Quer', company: 'Querfirma' })).data;
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    await t.api.post('/api/opportunities', { pipeline_id: pipe.id, stage_id: pipe.stages[1].id, name: 'Querdeal', value: 500, contact_id: c.id });
    const all = (await t.api.get('/api/agency/contacts?q=querfirma')).data;
    expect(all.total).toBe(1);
    expect(all.contacts[0]).toMatchObject({ email: 'quer@x.de', open_deals: 1 });
    expect(all.contacts[0].project).toBeTruthy();
    const deals = (await t.api.get('/api/agency/opportunities?q=Querdeal')).data;
    expect(deals[0]).toMatchObject({ name: 'Querdeal', stage: pipe.stages[1].name, pipeline: pipe.name });
    expect((await t.api.get('/api/pipelines')).data[0].open_count).toBeGreaterThan(0);
  });
});

describe('documents', () => {
  it('files artifacts by URL, keeps manual assignments and offers MCP tools', async () => {
    const loc = (await t.api.get('/api/me')).data.locations[0].id;
    const r = await t.api.post('/api/agency/docs', { docs: [{ url: 'https://claude.ai/artifact/AAA', title: 'Launch-Kit', location_id: loc, session_url: 'https://claude.ai/code/session_01X' }, { url: 'https://claude.ai/artifact/BBB', title: 'Idee ohne Projekt' }] });
    expect(r.data).toEqual({ created: 2, updated: 0 });
    expect((await t.api.get('/api/docs')).data.map((d: any) => d.title)).toContain('Launch-Kit');
    const inbox = (await t.api.get('/api/agency/docs?unassigned=1')).data;
    expect(inbox.map((d: any) => d.title)).toEqual(['Idee ohne Projekt']);
    // assign by hand, then a later sync without location must not move it back
    await t.api.patch(`/api/agency/docs/${inbox[0].id}`, { location_id: loc });
    await t.api.post('/api/agency/docs', { docs: [{ url: 'https://claude.ai/artifact/BBB', title: 'Idee (neu)', location_id: null }] });
    const moved = (await t.api.get('/api/docs')).data.find((d: any) => d.url.endsWith('BBB'));
    expect(moved).toMatchObject({ title: 'Idee (neu)', location_id: loc });
    expect((await t.api.post('/api/agency/docs', { docs: [{ url: 'javascript:alert(1)' }] })).status).toBe(400);
    const key = (await t.api.post('/api/agency/api-keys', { name: 'docs', scope: 'write' })).data.key;
    const rpc = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = (await rpc.json()).result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_list_docs', 'ghl_save_docs', 'ghl_assign_doc']));
  });
});

describe('accounting links', () => {
  it('links invoices to Norman and lists the ones still to hand over', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'kunde@norman.de', first_name: 'Kunde' })).data;
    const inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Website', items: [{ name: 'Landingpage', qty: 1, price_cents: 50000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' });
    const open = (await t.api.get('/api/agency/invoices?unsynced=1')).data;
    expect(open.map((i: any) => i.id)).toContain(inv.id);
    expect((await t.api.put(`/api/invoices/${inv.id}/external`, { provider: 'datev' })).status).toBe(400);
    const r = await t.api.put(`/api/invoices/${inv.id}/external`, { provider: 'norman', external_id: 'n-1', number: 'RE-2026-001', status: 'paid', url: 'https://app.norman.finance/invoices/n-1' });
    expect(r.data).toMatchObject({ provider: 'norman', number: 'RE-2026-001' });
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data.status).toBe('paid');
    expect((await t.api.get('/api/agency/invoices?unsynced=1')).data.map((i: any) => i.id)).not.toContain(inv.id);
    expect((await t.api.get('/api/invoice-links')).data[0]).toMatchObject({ invoice_id: inv.id, status: 'paid' });
  });
});

describe('email import', () => {
  it('imports threads and drafts once, matched to contacts', async () => {
    const messages = [
      { external_id: 'g-1', direction: 'out', from: 'inhaber@me.example', to: ['Anna Partner <anna@partner.de>'], subject: 'Kooperation?', body: 'Hallo Anna …', date: '2026-09-20T10:00:00Z' },
      { external_id: 'g-2', direction: 'in', from: 'Anna Partner <anna@partner.de>', to: ['inhaber@me.example'], subject: 'Re: Kooperation?', body: 'Gern!', date: '2026-09-21T10:00:00Z' },
      { external_id: 'd-1', status: 'draft', to: ['info@verein.de'], subject: 'Anfrage', body: 'Entwurf …', date: '2026-10-02T08:00:00Z', contact: { company: 'Verein e.V.' } },
      { external_id: 'x-1', direction: 'in', from: 'kaputt', subject: 'x', body: 'x' },
    ];
    const r = (await t.api.post('/api/conversations/import', { messages, source: 'Gmail', tags: ['gmail'] })).data;
    expect(r).toMatchObject({ created: 3, skipped: 1, contacts: 2 });
    expect((await t.api.post('/api/conversations/import', { messages })).data).toMatchObject({ created: 0, skipped: 4 });
    const drafts = (await t.api.get('/api/conversations/drafts')).data;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ email: 'info@verein.de', company: 'Verein e.V.', subject: 'Anfrage' });
    const conv = (await t.api.get('/api/conversations?q=anna')).data[0];
    const thread = (await t.api.get(`/api/conversations/${conv.id}/messages`)).data;
    expect(thread.messages.map((m: any) => [m.direction, m.status])).toEqual([['out', 'sent'], ['in', 'received']]);
    expect(conv.last_message).toContain('Re: Kooperation');
    expect((await t.api.del(`/api/messages/${thread.messages[0].id}`)).status).toBe(400);
    expect((await t.api.del(`/api/messages/${drafts[0].id}`)).status).toBe(200);
  });
});

describe('agency API keys and MCP', () => {
  let key = '';
  const rpc = async (body: any, auth = key) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
    return { status: r.status, data: r.status === 202 ? null : await r.json() };
  };
  const call = async (name: string, args: any = {}) => {
    const r = await rpc({ jsonrpc: '2.0', id: Math.random(), method: 'tools/call', params: { name, arguments: args } });
    const res = r.data.result;
    return { ...res, json: res && !res.isError ? JSON.parse(res.content[0].text) : null };
  };

  it('creates keys that act on every sub-account', async () => {
    const k = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data;
    expect(k.key).toMatch(/^pghla_/);
    expect(k.mcp_url).toBe('http://localhost/mcp');
    key = k.key;
    const list = await t.api.raw('/api/agency/projects', { headers: { authorization: `Bearer ${key}` } });
    expect(list.status).toBe(200);
    const contacts = await t.api.raw('/api/contacts', { headers: { authorization: `Bearer ${key}`, 'x-location-id': t.api.location } });
    expect(contacts.status).toBe(200);
    expect((await t.api.raw('/api/contacts', { headers: { authorization: `Bearer ${key}` } })).status).toBe(400);
    expect((await t.api.raw('/api/users', { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    const ro = (await t.api.post('/api/agency/api-keys', { name: 'Nur lesen', scope: 'read' })).data.key;
    const w = await t.api.raw('/api/contacts', { method: 'POST', headers: { authorization: `Bearer ${ro}`, 'x-location-id': t.api.location, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@y.de' }) });
    expect(w.status).toBe(403);
  });

  it('speaks MCP: initialize, tools/list, tools/call', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'falsch')).status).toBe(401);
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(init.data.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'gohigh' }, capabilities: { tools: {} } });
    expect((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const tools = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).data.result.tools;
    expect(tools.map((x: any) => x.name)).toContain('ghl_create_opportunity');
    expect(tools.find((x: any) => x.name === 'ghl_list_projects').annotations.readOnlyHint).toBe(true);
    expect((await rpc({ jsonrpc: '2.0', id: 3, method: 'nope' })).data.error.code).toBe(-32601);
    expect((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ghl_get_project', arguments: {} } })).data.error.code).toBe(-32602);
  });

  it('runs a project end to end through MCP', async () => {
    const proj = await call('ghl_create_project', { name: 'laufclub.example', profile: { status: 'beta', website: 'https://example.org', tagline: 'Lauftreffs in deiner Stadt' } });
    expect(proj.isError).toBe(false);
    const loc = proj.json.location_id;
    const pipe = await call('ghl_create_pipeline', { location_id: loc, name: 'Verbände & Partner', stages: ['Recherche', 'Entwurf', 'Kontaktiert', 'Gespräch', 'Partner'] });
    const opp = await call('ghl_create_opportunity', { location_id: loc, pipeline_id: pipe.json.id, stage: 'entwurf', name: 'Sportbund Jugend', contact: { email: 'jugend@verband.example', company: 'Sportbund Jugend' }, source: 'Gmail-Entwurf' });
    expect(opp.isError).toBe(false);
    const bad = await call('ghl_create_opportunity', { location_id: loc, pipeline_id: pipe.json.id, stage: 'Gibtsnicht', name: 'x', contact: { email: 'a@b.de' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('verfügbare');
    await call('ghl_update_opportunity', { location_id: loc, opportunity_id: opp.json.id, stage: 'Kontaktiert' });
    const opps = await call('ghl_list_opportunities', { location_id: loc });
    expect(opps.json[0].stage_id).toBe(pipe.json.stages[2].id);
    const task = await call('ghl_create_task', { location_id: loc, title: 'Nachfassen beim Sportbund', due_at: '2026-10-10T09:00:00Z' });
    await call('ghl_complete_task', { location_id: loc, task_id: task.json.id });
    expect((await call('ghl_list_tasks', { location_id: loc, status: 'done' })).json).toHaveLength(1);
    const imp = await call('ghl_import_emails', { location_id: loc, messages: [{ external_id: 'draft-1', status: 'draft', to: ['jungeretina@example.org'], subject: 'Frage ans Team', body: 'Hallo …' }] });
    expect(imp.json.created).toBe(1);
    expect((await call('ghl_list_drafts', { location_id: loc })).json).toHaveLength(1);
    const all = await call('ghl_list_all_tasks', { status: 'done' });
    expect(all.json.some((x: any) => x.title === 'Nachfassen beim Sportbund' && x.project === 'laufclub.example')).toBe(true);
    const projects = await call('ghl_list_projects');
    expect(projects.json.find((p: any) => p.id === loc).stats.drafts).toBe(1);
    const audit = await call('ghl_audit_log', { location_id: loc });
    expect(audit.json.some((e: any) => e.via === 'mcp' && e.action === 'opportunities.update')).toBe(true);
  });

  it('limits sub-account keys to their sub-account', async () => {
    const k = (await t.api.post('/api/api-keys', { name: 'Kunde' })).data.key;
    const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, k)).data.result.tools.map((x: any) => x.name);
    expect(tools).not.toContain('ghl_create_project');
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_search_contacts', arguments: { location_id: 'fremd' } } }, k);
    expect(r.data.result.isError).toBe(true);
    const own = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ghl_search_contacts', arguments: { location_id: t.api.location, query: 'audit' } } }, k);
    expect(JSON.parse(own.data.result.content[0].text).contacts[0].email).toBe('audit@x.de');
  });
});
