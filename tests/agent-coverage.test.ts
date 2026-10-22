import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { anthropicSse, events, fakeModel, sse } from './agent-fakes.js';
import { retry } from '../server/services/agent-llm.js';
import { classify, decide, routeProblem, type Klass } from '../server/services/agent-safety.js';
import { AGENT_EXEMPT, agentCoverage, sampleArgs, toolInfos, traceToolCalls, type ToolInfo } from '../server/services/agent-coverage.js';
import { toolCatalog } from '../server/services/agent-tools.js';
import { TEMPLATES } from '../server/services/agent-templates.js';
import { compactResult } from '../server/services/agent-runtime.js';
import { routeRecord } from '../server/services/agent-context.js';
import { TOOLS as CORE_TOOLS, type Tool } from '../server/modules/mcp.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';

/**
 * "KI-Agenten sollen überall frei agieren können" – validated (docs/agent.md#abdeckung):
 * (a) every module with write routes behind a login is reachable by an agent tool (specific or ghl_api) or exempt on purpose,
 * (b) every tool has a valid schema, a description, a class, and calls only routes behind a login that fit its class,
 * (c) changes ask first exactly per the rules – a typed or spoken "ja" and automatic runs never confirm,
 * (d) a tool call stays in the sub-account and within the member's areas.
 */

const AKEY = 'sk-ant-api03-agentcoverage-abcdefghijklmnopqrstuvwxyz';
const model = fakeModel();
let t: Awaited<ReturnType<typeof startTestApp>>;
let locA = '';
let locB = '';
let contactA = '';
let contactB = '';
let taskA = '';
let taskB = '';
let apptA = '';
let apptB = '';
let infos: ToolInfo[] = [];

const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
const say = (text: string) => ({ type: 'text' as const, text });
const chat = async (body: Record<string, unknown>) => {
  const r = await t.api.post('/api/agent/chat', body);
  return typeof r.data === 'string' ? events(r.data) : [];
};
const login = async (email: string) => {
  t.api.clearCookie();
  expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
};
const allTools = (): Tool[] => [...CORE_TOOLS, ...((t.app.services.mcpTools ?? []) as Tool[])];
const task = (id: string) => t.app.db.get('SELECT * FROM tasks WHERE id = ?', id);
const appt = (id: string) => t.app.db.get('SELECT * FROM appointments WHERE id = ?', id);

beforeAll(async () => {
  installOutboundGuard();
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  locA = t.api.location;
  contactA = (await t.api.post('/api/contacts', { first_name: 'Max', last_name: 'Muster', email: 'max@kunde.example' })).data.id;
  taskA = (await t.api.post('/api/tasks', { title: 'Angebot nachfassen', contact_id: contactA })).data.id;
  const calA = (await t.api.post('/api/calendars', { name: 'Beratung' })).data.id;
  apptA = (await t.api.post('/api/appointments', { calendar_id: calA, contact_id: contactA, start: '2026-12-01T10:00:00Z', force: true })).data.id;
  expect((await t.api.post('/api/ai-connections', { provider: 'anthropic', api_key: AKEY, models: { text: 'claude-sonnet-5-5' } })).status).toBe(200);
  locB = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
  t.api.setLocation(locB);
  contactB = (await t.api.post('/api/contacts', { first_name: 'Geheim', last_name: 'B', email: 'geheim@b.example' })).data.id;
  taskB = (await t.api.post('/api/tasks', { title: 'Geheime Aufgabe' })).data.id;
  const calB = (await t.api.post('/api/calendars', { name: 'B-Kalender' })).data.id;
  apptB = (await t.api.post('/api/appointments', { calendar_id: calB, contact_id: contactB, start: '2026-12-02T10:00:00Z', force: true })).data.id;
  t.api.setLocation(locA);
  await t.api.post('/api/users', { email: 'mia@example.com', name: 'Mia Mitarbeiterin', password: 'geheim123', role: 'member', locations: [locA], permissions: ['contacts', 'conversations'] });
  infos = await toolInfos(t.app, { trace: true });
}, 120_000);
afterAll(async () => {
  await t.close();
  uninstallOutboundGuard();
});
beforeEach(() => model.reset());

describe('(a) coverage: every area is reachable', () => {
  it('every module with write routes has an agent tool, is reachable through ghl_api, or is exempt with a reason', () => {
    const rows = agentCoverage(t.app, infos);
    const none = rows.filter((r) => r.writes && r.status === 'none').map((r) => r.module);
    expect(none, 'Modul ohne Agenten-Zugang: eigenes Tool anlegen, Route freigeben oder in AGENT_EXEMPT (services/agent-coverage.ts) begründen').toEqual([]);
    for (const [m, reason] of Object.entries(AGENT_EXEMPT)) {
      const row = rows.find((r) => r.module === m);
      expect(row, `AGENT_EXEMPT nennt ein Modul ohne Routen: ${m}`).toBeTruthy();
      expect(row!.status, `${m} ist für Agenten erreichbar – aus AGENT_EXEMPT streichen`).toBe('exempt');
      expect(reason.length).toBeGreaterThan(20);
    }
    // most of the app is reachable: exemptions stay the exception
    expect(rows.filter((r) => r.status === 'exempt').length).toBeLessThan(rows.length / 8);
  });

  it('everyday operations keep their own tools (models pick those reliably)', () => {
    const rows = agentCoverage(t.app, infos);
    const row = (m: string) => rows.find((r) => r.module === m)!;
    for (const m of ['contacts', 'pipelines', 'calendars', 'conversations', 'payments', 'invoicing', 'workflows', 'tickets', 'contact-duplicates', 'campaigns'])
      expect(row(m).tools.length, `${m}: kein eigenes Tool für Änderungen`).toBeGreaterThan(0);
    for (const m of ['forms', 'csat', 'reputation', 'reports', 'calendars', 'workflows', 'campaigns']) expect(row(m).readTools.length, `${m}: kein eigenes Lese-Tool`).toBeGreaterThan(0);
    const names = new Set(allTools().map((x) => x.name));
    for (const n of ['ghl_update_task', 'ghl_list_appointments', 'ghl_create_appointment', 'ghl_update_appointment', 'ghl_cancel_appointment', 'ghl_update_contact', 'ghl_tag_contact', 'ghl_merge_contacts', 'ghl_draft_email', 'ghl_create_invoice', 'ghl_list_campaigns', 'ghl_create_campaign', 'ghl_list_workflows', 'ghl_workflow_enroll', 'ghl_workflow_set_status', 'ghl_list_forms', 'ghl_form_submissions', 'ghl_survey_results', 'ghl_list_reviews', 'ghl_settings_overview', 'ghl_api', 'ghl_api_routes'])
      expect(names.has(n), n).toBe(true);
  });

  it('ghl_api_routes finds routes of any module, never denied ones', async () => {
    const routes = allTools().find((x) => x.name === 'ghl_api_routes')!;
    const caller = { agency: false, locationId: locA, api: async () => ({}) };
    const r: any = await routes.run(caller, { query: 'formular einsendungen' });
    expect(r.routes.some((x: string) => x.startsWith('GET /api/forms/:id/submissions'))).toBe(true);
    const wf: any = await routes.run(caller, { module: 'workflows', method: 'POST' });
    expect(wf.routes).toEqual(expect.arrayContaining([expect.stringMatching(/^POST \/api\/workflows\/:id\/enroll/)]));
    const keys: any = await routes.run(caller, { query: 'api-keys passwort 2fa users', limit: 100 });
    expect(keys.routes.some((x: string) => /\/api\/(api-keys|users|me|auth)\b/.test(x))).toBe(false);
    // agency AI keys and personal AI subscriptions are off-limits like the other keys
    expect(keys.routes.concat((await routes.run(caller, { query: 'ai-subscriptions ai-provider ai-tools', limit: 100 }) as any).routes).some((x: string) => /ai-subscriptions|agency\/ai-(provider|tools)/.test(x))).toBe(false);
  });
});

describe('(b) every tool: schema, description, class, scope', () => {
  const validSchema = (s: any, where: string): string[] => {
    const errs: string[] = [];
    if (!s || typeof s !== 'object') return [`${where}: kein Schema`];
    if (s.type === 'object' || s.properties) {
      if (s.properties !== undefined && (typeof s.properties !== 'object' || Array.isArray(s.properties))) errs.push(`${where}: properties ist kein Objekt`);
      for (const [k, p] of Object.entries<any>(s.properties ?? {})) {
        if (!p || typeof p !== 'object') errs.push(`${where}.${k}: kein Schema`);
        // a property without type accepts any value – fine when its description says what goes in
        else if (!p.type && !p.enum && !p.anyOf && !p.oneOf && !p.$ref && !p.const && !p.description) errs.push(`${where}.${k}: weder type noch Beschreibung`);
        else errs.push(...validSchema(p, `${where}.${k}`));
      }
      if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((r: string) => !(r in (s.properties ?? {}))))) errs.push(`${where}: required nennt unbekannte Felder`);
    }
    if (s.type === 'array' && s.items) errs.push(...validSchema(s.items, `${where}[]`));
    if (s.enum && (!Array.isArray(s.enum) || !s.enum.length)) errs.push(`${where}: leeres enum`);
    return errs;
  };

  it('valid JSON schema, title, description and a class for every MCP tool; names unique', () => {
    const tools = allTools();
    const names = tools.map((x) => x.name);
    expect(new Set(names).size).toBe(names.length);
    const errs: string[] = [];
    for (const x of tools) {
      if (!/^[a-z][a-z0-9_]{2,63}$/.test(x.name)) errs.push(`${x.name}: Name`);
      if (!x.title?.trim()) errs.push(`${x.name}: Titel fehlt`);
      if ((x.description ?? '').trim().length < 20) errs.push(`${x.name}: Beschreibung fehlt/zu kurz`);
      if (x.inputSchema?.type !== 'object') errs.push(`${x.name}: Schema ist kein Objekt`);
      errs.push(...validSchema(x.inputSchema, x.name));
      if (!x.annotations || typeof x.annotations !== 'object') errs.push(`${x.name}: annotations fehlen`);
      if (!['read', 'write', 'sensitive'].includes(classify(x))) errs.push(`${x.name}: keine Klasse`);
      if (typeof x.run !== 'function') errs.push(`${x.name}: run fehlt`);
    }
    expect(errs).toEqual([]);
  });

  it('the agent catalogue gives every tool a class and a group; members never see location_id', () => {
    const admin = t.app.db.get('SELECT * FROM users WHERE role = ? LIMIT 1', 'admin');
    const member = t.app.db.get('SELECT * FROM users WHERE email = ?', 'mia@example.com');
    const forAdmin = toolCatalog(t.app, admin, { webFetch: false });
    const forMember = toolCatalog(t.app, { ...member, permissions: JSON.parse(member.permissions || '[]') }, { webFetch: false });
    for (const x of forAdmin) {
      expect(['read', 'write', 'sensitive', 'internal'], x.name).toContain(x.klass);
      expect(x.group, x.name).toBeTruthy();
    }
    expect(forAdmin.map((x) => x.name)).toEqual(expect.arrayContaining(['ghl_api', 'ghl_api_routes', 'ghl_update_task', 'ghl_cancel_appointment']));
    expect(forMember.filter((x) => x.inputSchema.properties?.location_id).map((x) => x.name)).toEqual([]);
    // the templates only name tools that exist
    for (const tpl of TEMPLATES) for (const n of tpl.tools) expect(forAdmin.some((x) => x.name === n) || n === 'web_fetch', `${tpl.key}: ${n}`).toBe(true);
    // agency-only tools stay with admins
    const agencyOnly = allTools().filter((x) => x.agencyOnly).map((x) => x.name);
    expect(forMember.some((x) => agencyOnly.includes(x.name))).toBe(false);
  });

  it('tools only call routes behind a login, read tools only read, and outbound routes are behind a sensitive class', () => {
    const errs: string[] = [];
    for (const info of infos) {
      const x = allTools().find((y) => y.name === info.name)!;
      const klass: Klass = x.klassFor?.(sampleArgs(x.inputSchema)) ?? classify(x);
      for (const c of info.calls) {
        // the route the router would pick for this call
        const r = t.app.router.match(c.method, c.path)?.route;
        if (r && r.auth === 'public') errs.push(`${x.name}: ruft die öffentliche Route ${c.method} ${r.pattern}`);
        if (klass === 'read' && routeProblem(c.method, c.path, 'read')) errs.push(`${x.name}: Lese-Tool ruft ${c.method} ${c.path}`);
        if (klass === 'write' && routeProblem(c.method, c.path, 'write')) errs.push(`${x.name}: ${c.method} ${c.path} braucht die Klasse „sensitive“`);
      }
    }
    expect(errs).toEqual([]);
  });
});

describe('(c) confirmations exactly per the rules', () => {
  const klass = (name: string, args: Record<string, unknown> = {}) => {
    const x = allTools().find((y) => y.name === name)!;
    return x.klassFor?.(args) ?? classify(x);
  };

  it('classes of the everyday tools and what each mode decides', () => {
    expect(klass('ghl_list_appointments')).toBe('read');
    expect(klass('ghl_update_task')).toBe('write');
    expect(klass('ghl_update_appointment')).toBe('write');
    expect(klass('ghl_draft_email')).toBe('write');
    expect(klass('ghl_create_campaign')).toBe('write'); // a draft – sending stays a separate step
    expect(klass('ghl_create_invoice')).toBe('write');
    expect(klass('ghl_workflow_set_status', { status: 'paused' })).toBe('write');
    for (const [n, a] of [['ghl_cancel_appointment', {}], ['ghl_merge_contacts', {}], ['ghl_workflow_enroll', {}], ['ghl_workflow_set_status', { status: 'active' }], ['ghl_create_appointment', {}], ['ghl_send_message', {}], ['ghl_api', { method: 'POST' }]] as const)
      expect(klass(n, a), n).toBe('sensitive');
    expect(klass('ghl_api', { method: 'GET' })).toBe('read');
    const admin = t.app.db.get('SELECT * FROM users WHERE role = ? LIMIT 1', 'admin');
    for (const x of toolCatalog(t.app, admin, { webFetch: true })) {
      const k = x.klass;
      const ask = decide(k, 'ask', { confirmSensitive: true, tainted: false });
      expect(ask, x.name).toBe(k === 'read' || k === 'internal' ? 'run' : 'confirm');
      if (k === 'write' || k === 'sensitive') expect(decide(k, 'read', { confirmSensitive: true, tainted: false }), x.name).toBe('block');
      if (k === 'sensitive') {
        expect(decide(k, 'auto', { confirmSensitive: true, tainted: false }), x.name).toBe('confirm');
        expect(decide(k, 'auto', { confirmSensitive: false, tainted: true }), x.name).toBe('confirm');
      }
    }
  });

  it('a typed or spoken "ja" never confirms – only the card does', async () => {
    model.reply(sse(anthropicSse([say('Ich ändere die Aufgabe.'), tool('tu_1', 'ghl_update_task', { task_id: taskA, title: 'Geändert' })])));
    const first = await chat({ message: 'Benenne die Aufgabe um', ui: { route: `contacts/${contactA}` } });
    const card = first.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_update_task', klass: 'write' });
    const conv = first.find((e) => e.type === 'start').conversation_id;
    // the person says "ja" in focus mode (speech becomes text) – that is a new message, not a confirmation
    model.reply(sse(anthropicSse([say('Okay.')])));
    const second = await chat({ conversation_id: conv, message: 'Ja', source: 'focus' });
    expect(second.some((e) => e.type === 'tool_result' && e.status === 'ok')).toBe(false);
    expect(task(taskA).title).toBe('Angebot nachfassen');
    expect(JSON.stringify(model.calls.at(-1)!.body.messages)).toContain('Nicht ausgeführt');
    // the old card is dead
    expect((await t.api.post('/api/agent/confirm', { pending_id: card.pending_id, token: card.token, approve: true, args_hash: card.args_hash })).status).toBe(409);
    expect(task(taskA).title).toBe('Angebot nachfassen');
  });

  it('the confirmation card runs the change once', async () => {
    model.reply(sse(anthropicSse([tool('tu_2', 'ghl_update_appointment', { appointment_id: apptA, start: '2026-12-01T14:00:00Z' })])));
    const card = (await chat({ message: 'Verschiebe den Termin auf 15 Uhr' })).find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_update_appointment' });
    expect(appt(apptA).start_at).toBe('2026-12-01T10:00:00.000Z');
    model.reply(sse(anthropicSse([say('Verschoben.')])));
    const ev = events((await t.api.post('/api/agent/confirm', { pending_id: card.pending_id, token: card.token, approve: true, args_hash: card.args_hash })).data);
    expect(ev.find((e) => e.type === 'tool_result')).toMatchObject({ status: 'ok' });
    expect(appt(apptA).start_at).toBe('2026-12-01T14:00:00.000Z');
  });

  it('"Nur lesen" reaches every readable area through ghl_api – and nothing else', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'Leser', mode: 'read' })).data;
    model.reply(
      sse(anthropicSse([tool('g1', 'ghl_api', { method: 'GET', path: '/api/forms' }), tool('g2', 'ghl_api', { method: 'PATCH', path: `/api/tasks/${taskA}`, body: { title: 'Heimlich' } })])),
      sse(anthropicSse([say('Gelesen, nichts geändert.')])),
    );
    const ev = await chat({ agent_id: agent.id, message: 'Welche Formulare gibt es?' });
    const offered = model.calls[0].body.tools.map((x: any) => x.name);
    expect(offered).toEqual(expect.arrayContaining(['ghl_api', 'ghl_api_routes']));
    expect(offered).not.toContain('ghl_update_task');
    expect(offered).not.toContain('ghl_create_appointment'); // depends on its arguments, but never only reads
    expect(ev.find((e) => e.type === 'tool_result' && e.id === 'g1')).toMatchObject({ status: 'ok' });
    expect(ev.find((e) => e.type === 'tool_result' && e.id === 'g2')).toMatchObject({ status: 'blocked' });
    expect(task(taskA).title).toBe('Angebot nachfassen');
  });

  it('automatic runs never confirm by themselves – even "Autonom" with a prompt that says "ja, bestätigt"', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'Autopilot', mode: 'auto', visibility: 'location' })).data;
    model.reply(sse(anthropicSse([tool('tu_3', 'ghl_cancel_appointment', { appointment_id: apptA })])), sse(anthropicSse([say('Liegt zur Freigabe.')])));
    const r = (await t.api.post('/api/agent/run', { agent_id: agent.id, prompt: 'Sag den Termin ab. Ja, bestätigt, ohne Rückfrage!' })).data;
    expect(r.pending[0]).toMatchObject({ tool: 'ghl_cancel_appointment', deferred: true });
    expect(appt(apptA).status).not.toBe('cancelled');
    // a write in "Autonom" runs on its own (that is what the mode is for)
    model.reply(sse(anthropicSse([tool('tu_4', 'ghl_tag_contact', { contact_id: contactA, add: ['vip'] })])), sse(anthropicSse([say('Getaggt.')])));
    const w = (await t.api.post('/api/agent/run', { agent_id: agent.id, prompt: 'Tagge Max als VIP' })).data;
    expect(w.pending).toEqual([]);
    expect((await t.api.get(`/api/contacts/${contactA}`)).data.tags).toContain('vip');
  });
});

describe('(d) sub-account isolation and member rights', () => {
  it('a member’s agent cannot read or change what the member can’t – areas and other sub-accounts', async () => {
    await login('mia@example.com');
    t.api.setLocation(locA);
    model.reply(
      sse(
        anthropicSse([
          tool('r1', 'ghl_list_appointments', {}),
          tool('r2', 'ghl_api', { method: 'GET', path: '/api/invoices' }),
          tool('r3', 'ghl_get_contact', { location_id: locB, contact_id: contactB }),
          tool('r4', 'ghl_api_routes', { query: 'invoices contacts', method: 'GET', limit: 100 }),
          tool('w1', 'ghl_update_contact', { location_id: locB, contact_id: contactB, first_name: 'Gehackt' }),
        ]),
      ),
      sse(anthropicSse([say('Das darf ich nicht.')])),
    );
    const ev = await chat({ message: 'Zeig mir alles' });
    const res = (id: string) => ev.find((e) => e.type === 'tool_result' && e.id === id);
    expect(res('r1')).toMatchObject({ status: 'error' }); // calendars area
    expect(res('r2')).toMatchObject({ status: 'error' }); // payments area
    expect(res('r3')).toMatchObject({ status: 'error' }); // other sub-account
    // the route finder only offers what the member may use
    expect(res('r4').preview).toContain('GET /api/contacts');
    expect(res('r4').preview).not.toContain('/api/invoices');
    expect(JSON.stringify(model.calls.map((c) => c.body))).not.toContain('geheim@b.example');
    // the write asks first – and confirmed, it still only acts in the member's own sub-account
    const card = ev.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_update_contact' });
    model.reply(sse(anthropicSse([say('Nicht gefunden.')])));
    const done = events((await t.api.post('/api/agent/confirm', { pending_id: card.pending_id, token: card.token, approve: true, args_hash: card.args_hash })).data);
    expect(done.find((e) => e.type === 'tool_result')).toMatchObject({ status: 'error' });
    expect(t.app.db.get('SELECT first_name FROM contacts WHERE id = ?', contactB).first_name).toBe('Geheim');
    await login('chef@example.com');
    t.api.setLocation(locA);
  });

  it('a sub-account key over MCP never reaches another sub-account’s records with the new tools', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Agent A' })).data.key;
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      return (await r.json()).result;
    };
    expect((await call('ghl_update_task', { task_id: taskB, title: 'Gekapert' })).isError).toBe(true);
    expect((await call('ghl_cancel_appointment', { appointment_id: apptB })).isError).toBe(true);
    expect((await call('ghl_update_contact', { location_id: locB, contact_id: contactB, first_name: 'X' })).isError).toBe(true);
    expect((await call('ghl_api', { method: 'PATCH', path: `/api/tasks/${taskB}`, body: { title: 'Gekapert' } })).isError).toBe(true);
    expect(task(taskB).title).toBe('Geheime Aufgabe');
    expect(appt(apptB).status).not.toBe('cancelled');
    // inside its own sub-account the same tools work
    const ok = await call('ghl_list_appointments', {});
    expect(ok.isError).toBe(false);
    expect(ok.content[0].text).toContain(apptA);
    expect(ok.content[0].text).not.toContain(apptB);
  });
});

describe('the everyday tools do what they say (MCP, real data)', () => {
  let key = '';
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const res = (await r.json()).result;
    expect(res.isError, `${name}: ${res.content?.[0]?.text}`).toBe(false);
    return JSON.parse(res.content[0].text);
  };
  beforeAll(async () => {
    t.api.setLocation(locA);
    key = (await t.api.post('/api/api-keys', { name: 'Alltag' })).data.key;
  });

  it('tasks, appointments, contacts', async () => {
    expect(await call('ghl_update_task', { task_id: taskA, due_at: '2026-12-24T09:00:00Z', done: true })).toMatchObject({ id: taskA, done: 1 });
    const list = await call('ghl_list_appointments', {});
    expect(list.appointments.find((a: any) => a.id === apptA)).toMatchObject({ contact: 'Max Muster', calendar: 'Beratung', contact_id: contactA });
    expect(list.appointments[0]).not.toHaveProperty('manage_token');
    expect(await call('ghl_update_appointment', { appointment_id: apptA, status: 'showed' })).toMatchObject({ status: 'showed' });
    expect(await call('ghl_update_contact', { contact_id: contactA, company: 'Muster GmbH', dnd: false })).toMatchObject({ company: 'Muster GmbH' });
    expect((await call('ghl_tag_contact', { contact_id: contactA, add: ['kunde'], remove: ['vip'] })).tags).toEqual(expect.arrayContaining(['kunde']));
    const dup = (await t.api.post('/api/contacts', { first_name: 'Max', last_name: 'Muster', phone: '+4915112345678' })).data.id;
    expect(await call('ghl_merge_contacts', { keep_id: contactA, from_id: dup })).toMatchObject({ contact_id: contactA });
    expect(t.app.db.get('SELECT id FROM contacts WHERE id = ?', dup)).toBeUndefined();
    const cancelled = await call('ghl_cancel_appointment', { appointment_id: apptA });
    expect(cancelled.status).toBe('cancelled');
  });

  it('drafts never send: e-mail draft, invoice draft, campaign draft', async () => {
    const d = await call('ghl_draft_email', { contact_id: contactA, subject: 'Ihr Angebot', body: 'Hallo Max, anbei …' });
    expect(d).toMatchObject({ ok: true, draft: true, to: 'max@kunde.example' });
    const drafts = (await t.api.get('/api/conversations/drafts')).data;
    expect(JSON.stringify(drafts)).toContain('Ihr Angebot');
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND status = 'sent'`, contactA).n).toBe(0);
    const inv = await call('ghl_create_invoice', { contact_id: contactA, title: 'Beratung', items: [{ name: 'Beratung', qty: 2, price_cents: 10000 }] });
    expect(inv).toMatchObject({ kind: 'invoice', status: 'draft', total_cents: 23800, link: `invoices/${inv.id}` });
    const c = await call('ghl_create_campaign', { name: 'Herbst', channel: 'email', subject: 'Neu', body: 'Hallo' });
    expect(c).toMatchObject({ status: 'draft' });
    expect((await call('ghl_list_campaigns', { status: 'draft' })).campaigns.map((x: any) => x.name)).toContain('Herbst');
  });

  it('workflows, forms, surveys, reviews, settings', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Nachfassen', trigger: { type: 'contact.tag_added', config: { tag: 'x' } }, steps: [] })).data;
    expect((await call('ghl_list_workflows')).find((w: any) => w.id === wf.id)).toMatchObject({ name: 'Nachfassen', status: 'draft' });
    expect(await call('ghl_workflow_set_status', { workflow_id: wf.id, status: 'active' })).toMatchObject({ status: 'active' });
    expect(await call('ghl_workflow_enroll', { workflow_id: wf.id, contact_ids: [contactA] })).toMatchObject({ enrolled: 1 });
    expect(await call('ghl_workflow_set_status', { workflow_id: wf.id, status: 'paused' })).toMatchObject({ status: 'paused' });
    const form = (await t.api.post('/api/forms', { name: 'Kontakt' })).data;
    expect((await call('ghl_list_forms')).find((f: any) => f.id === form.id)).toMatchObject({ name: 'Kontakt', submissions: 0 });
    expect(await call('ghl_form_submissions', { form_id: form.id })).toMatchObject({ total: 0, submissions: [] });
    expect(await call('ghl_survey_results')).toHaveProperty('nps');
    expect(await call('ghl_list_reviews')).toHaveProperty('reviews');
    const s = await call('ghl_settings_overview');
    expect(s).toMatchObject({ name: 'Testfirma', timezone: expect.any(String), channels: { email: expect.any(Boolean), sms: expect.any(Boolean) } });
    expect(JSON.stringify(s)).not.toMatch(/pass|secret|token/i);
  });
});

describe('"Erledige das hier" from any record page, noise-free results', () => {
  it('record routes resolve to the record; tabs and unknown pages do not', async () => {
    expect(routeRecord(`workflows/abc`)).toMatchObject({ id: 'abc', kind: { type: 'workflow' } });
    expect(routeRecord('campaigns/gallery')).toBeNull();
    expect(routeRecord('tickets/uebersicht')).toBeNull();
    expect(routeRecord('settings/ai')).toBeNull();
    const wf = (await t.api.post('/api/workflows', { name: 'Willkommen', trigger: { type: 'contact.created', config: {} }, steps: [] })).data;
    expect((await t.api.get(`/api/agent/context?route=${encodeURIComponent(`workflows/${wf.id}`)}`)).data).toMatchObject({ entity: { type: 'workflow', id: wf.id, label: 'Willkommen' } });
    // the server resolves the record when the client only sends the route – also the page focus mode was opened from
    model.reply(sse(anthropicSse([say('Erledigt.')])));
    await chat({ message: 'Pausiere das hier', ui: { route: 'focus', label: 'Fokus-Modus', from: `workflows/${wf.id}` } });
    const first = JSON.stringify(model.calls[0].body.messages[0]);
    expect(first).toContain(`ausgewählt: workflow „Willkommen“ (ID ${wf.id})`);
    expect(first).toContain(`geöffnet von: workflows/${wf.id}`);
  });

  it('tool results lose empty fields, secrets and endless lists', () => {
    const out: any = compactResult({ id: 'a', note: '', phone: null, manage_token: 'geheim', location_id: 'L', rows: Array.from({ length: 80 }, (_, i) => ({ i, location_id: 'L', x: null })), long: 'x'.repeat(5000) }, 'L');
    expect(out).not.toHaveProperty('note');
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('manage_token');
    expect(out.location_id).toBe('L');
    expect(out.rows).toHaveLength(61);
    expect(out.rows[0]).toEqual({ i: 0 });
    expect(out.rows[60]).toContain('+20 weitere');
    expect(out.long.length).toBeLessThan(4100);
  });

  it('every traced tool call is recorded (sanity of the coverage tracer)', async () => {
    const t1 = allTools().find((x) => x.name === 'ghl_cancel_appointment')!;
    expect(await traceToolCalls(t1)).toEqual([{ method: 'PATCH', path: '/api/appointments/x1' }]);
  });
});
