import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { pluginAnswer, stage1Plan, stage2Plan, usage } from './werkstatt-fakes.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { classify } from '../server/services/agent-safety.js';
import { toolCatalog } from '../server/services/agent-tools.js';
import { PURPOSES } from '../server/modules/ai-assistant.js';

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let admin: Call;
let member: Call;
let key = '';
let seq = 0;
let plan: () => any = () => stage1Plan(` ${++seq}`);
let ghCalls: { url: string; method: string; body: any }[] = [];
let timeline: any[] = [];

const rpc = async (tool: string, args: Record<string, unknown>) => {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const j: any = await r.json();
  const text = String(j.result?.content?.[0]?.text ?? '');
  return { isError: j.result?.isError as boolean, data: j.result?.structuredContent ?? (j.result?.isError ? null : JSON.parse(text || 'null')), text };
};
const wait = async () => void (await t.app.services.werkstatt.idle());
const allOk = ['scopes-minimal', 'no-exfiltration', 'no-external-resources', 'no-dangerous-apis', 'data-handling', 'writes-justified', 'ai-injection', 'matches-description', 'robustness'].map((id) => ({ id, ok: true, note: 'ok' }));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  admin = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await admin('POST', '/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  expect((await admin('POST', '/api/users', { email: 'm1@example.com', name: 'm1', password: 'passwort-1x', role: 'member', locations: [A], permissions: null })).status).toBe(200);
  member = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  await member('POST', '/api/auth/login', { email: 'm1@example.com', password: 'passwort-1x' });
  key = (await admin('POST', '/api/agency/api-keys', { name: 'Agentur' })).data.key;
  await admin('PUT', '/api/werkstatt/policy', { who: 'everyone', approval: true, budget_usd: 50 });
  // The Werkstatt only works with a top model (model gate): the assistant runs Claude Opus 5.5 here.
  for (const loc of [A]) expect((await admin('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' }, { 'x-location-id': loc })).status).toBe(200);
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => {
    const body = input.purpose === 'werkstatt_plan' ? plan() : input.purpose === 'werkstatt_spec' ? { title: 'Geburtstags-Erinnerungen im Kern', spec_markdown: '## Ziel\nGeburtstage gehören zu den Kontakten.' } : input.purpose === 'werkstatt_review' ? { verdict: 'pass', summary: 'ok', checks: allOk } : pluginAnswer('geburtstags-erinnerungen');
    return { text: JSON.stringify(body), model: 'claude-opus-5-5', stopReason: 'end_turn', usage, ms: 5 };
  };
  t.app.services.githubFetch = (async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    ghCalls.push({ url: String(url), method: init.method ?? 'GET', body });
    const u = String(url);
    if (init.method === 'POST' && u.endsWith('/issues')) return Response.json({ number: 42, html_url: 'https://github.com/acme/gohigh/issues/42' }, { status: 201 });
    if (u.includes('/timeline')) return Response.json(timeline);
    if (u.includes('/issues/42')) return Response.json({ number: 42, state: timeline.some((e) => e.source?.issue?.pull_request?.merged_at) ? 'closed' : 'open' });
    return Response.json({ message: 'nope' }, { status: 404 });
  }) as unknown as typeof fetch;
}, 60_000);
afterAll(() => t.close());

describe('MCP tools and the agent', () => {
  it('offers the tools; confirming a build and installing are "sensitive" for the agent (always asks), planning only writes, reading is not', async () => {
    const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = ((await r.json()) as any).result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_list_plugins', 'ghl_install_plugin', 'ghl_build_from_wish', 'ghl_plugin_status', 'ghl_change_plugin', 'ghl_discard_plugin', 'ghl_plugin_overview', 'ghl_plugin_admin']));
    const admins = { id: 'x', email: '', name: 'A', role: 'admin' as const, locations: [], permissions: null };
    const cat = toolCatalog(t.app, admins, { webFetch: false });
    const build = cat.find((x) => x.name === 'ghl_build_from_wish')!;
    expect(build.klass).toBe('sensitive');
    // planning builds nothing (a few cents of AI): an ordinary write; the build itself is the sensitive step
    expect(build.klassFor!({ text: 'Ich möchte etwas.' })).toBe('write');
    expect(build.klassFor!({ build_id: 'x', confirm: true, accept_permissions: true })).toBe('sensitive');
    for (const n of ['ghl_install_plugin', 'ghl_change_plugin', 'ghl_discard_plugin', 'ghl_plugin_admin']) expect(cat.find((x) => x.name === n)!.klass, n).toBe('sensitive');
    expect(cat.find((x) => x.name === 'ghl_plugin_overview')!.klass).toBe('read');
    // lifecycle tools are for admins only
    const members = { id: 'y', email: '', name: 'M', role: 'member' as const, locations: [A], permissions: null };
    const mine = toolCatalog(t.app, members, { webFetch: false }).map((x) => x.name);
    expect(mine).toContain('ghl_build_from_wish');
    expect(mine).not.toContain('ghl_plugin_admin');
    expect(mine).not.toContain('ghl_plugin_overview');
    expect(cat.find((x) => x.name === 'ghl_list_plugins')!.klass).toBe('read');
    expect(classify({ name: 'ghl_plugin_status', annotations: { readOnlyHint: true } })).toBe('read');
    expect(PURPOSES.werkstatt_plan).toBeTruthy();
  });

  it('the agent is told to offer a plugin only to people who may build', () => {
    const extras = t.app.services.agentPromptExtras as ((i: any) => string)[];
    const adminUser = { id: 'a', email: '', name: 'A', role: 'admin', locations: [], permissions: null };
    const memberUser = { id: 'm', email: '', name: 'M', role: 'member', locations: [A], permissions: null };
    const texts = (u: any, automatic = false) => extras.map((f) => f({ user: u, locationId: A, automatic })).filter(Boolean).join('\n');
    expect(texts(adminUser)).toContain('ghl_build_from_wish');
    expect(texts(adminUser)).toContain('als Karte im Chat');
    expect(texts(adminUser)).toContain('Bestätige den Plan nie selbst');
    expect(texts(adminUser)).toContain('ghl_plugin_admin'); // lifecycle help for admins
    expect(texts(adminUser, true)).toBe('');
    expect(texts(memberUser)).toContain('ghl_build_from_wish'); // policy "everyone"
    expect(texts(memberUser)).not.toContain('ghl_plugin_admin');
  });

  it('lists the Marktplatz and installed plugins; install first shows the permissions, then installs on consent', async () => {
    const wish = (await admin('POST', '/api/plugins/examples/notizen-zusammenfassung/install', { consent: EXAMPLES['notizen-zusammenfassung'].manifest.scopes })).data;
    // publish it so it is in the Marktplatz
    const rev = (await admin('POST', `/api/marktplatz/${wish.id}/security-review`, {})).data;
    expect((await admin('POST', `/api/marktplatz/${wish.id}/publish`, { review_id: rev.id, approve: true, accept_warnings: true })).status).toBe(200);
    const installed = await rpc('ghl_list_plugins', { location_id: A });
    expect(installed.data.plugins.map((p: any) => p.name)).toContain('Kontakt-Notizen-Zusammenfassung');
    const shop = await rpc('ghl_list_plugins', { location_id: A, scope: 'marktplatz', query: 'notizen' });
    expect(shop.data.plugins[0]).toMatchObject({ id: wish.id, risk: 'medium' });
    const loc2 = (await admin('POST', '/api/locations', { name: 'Zweitfirma' })).data.id;
    const ask = await rpc('ghl_install_plugin', { location_id: loc2, plugin_id: wish.id });
    expect(ask.data).toMatchObject({ needs_consent: true });
    expect(ask.data.permissions.map((p: any) => p.key).sort()).toEqual(['ai:run', 'contacts:read']);
    expect((await admin('GET', `/api/marktplatz/${wish.id}`)).data.installs).toBe(1);
    const done = await rpc('ghl_install_plugin', { location_id: loc2, plugin_id: wish.id, accept_permissions: true });
    expect(done.data).toMatchObject({ installed: true, scope: 'location' });
    expect((await admin('GET', `/api/marktplatz/${wish.id}`, { 'x-location-id': loc2 })).data.installs).toBe(2);
  });

  it('builds from a wish through the same policy and approval: plan first, then confirm; a member needs the admin', async () => {
    plan = () => stage1Plan(` ${++seq}`);
    const w = (await member('POST', '/api/feedback/wishes', { title: 'Rückrufe verwalten', what: 'Ich möchte Rückrufe meiner Kunden verwalten.' })).data.wish;
    const p1 = await rpc('ghl_build_from_wish', { location_id: A, wish_id: w.id });
    expect(p1.isError).toBe(false);
    expect(p1.data).toMatchObject({ status: 'planned', stage: 'Einrichtung', estimated_cost_usd: 0 });
    expect(p1.data.permissions.length).toBeGreaterThan(0);
    // without the consent flags nothing is built
    const noAccept = await rpc('ghl_build_from_wish', { location_id: A, build_id: p1.data.build_id, confirm: true });
    expect(noAccept.isError).toBe(true);
    expect(noAccept.text).toContain('accept_permissions');
    const go = await rpc('ghl_build_from_wish', { location_id: A, build_id: p1.data.build_id, confirm: true, accept_permissions: true });
    expect(go.data.status).toBe('building'); // an admin key: no approval needed
    await wait();
    const st = await rpc('ghl_plugin_status', { location_id: A, build_id: p1.data.build_id });
    expect(st.data).toMatchObject({ status: 'Fertig', stage: 'Einrichtung' });
    expect(st.data.created.join()).toContain('workflow');
    expect((await rpc('ghl_plugin_status', { location_id: A })).data.builds.length).toBeGreaterThan(0);
    // the same flow for a member waits for the approval of an admin
    const b = (await member('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas für Rückrufe haben.' })).data;
    await wait();
    const planned = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data;
    const c = await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, { accept_scopes: planned.plan.scopes.map((s: any) => s.key), accept_areas: planned.plan.areas });
    expect(c.data.status).toBe('awaiting_approval');
  });

  it('a stage 2 plan through the tool shows the permissions the plugin asks for and an estimate', async () => {
    plan = () => stage2Plan('deal-ampel');
    const p = await rpc('ghl_build_from_wish', { location_id: A, text: 'Ich will sehen, welche Deals stocken.' });
    expect(p.data).toMatchObject({ status: 'planned', stage: 'Mini-App' });
    expect(p.data.permissions).toEqual(['opportunities:read (Deals lesen)']);
    expect(p.data.estimated_cost_usd).toBeGreaterThan(0);
    plan = () => stage1Plan(` ${++seq}`);
  });
});

describe('stage 3 „Kernfeature“: spec, GitHub issue for a coding agent, tracking, shipping', () => {
  let pid = '';
  beforeAll(async () => {
    const r = await admin('POST', '/api/plugins/examples/geburtstags-erinnerungen/install', { consent: EXAMPLES['geburtstags-erinnerungen'].manifest.scopes });
    pid = r.data.id;
    await admin('POST', `/api/plugins/${pid}/scope`, { scope: 'location' });
  });

  it('without a GitHub token the specification is kept and the error is explained', async () => {
    const r = await admin('POST', `/api/werkstatt/plugins/${pid}/core-proposal`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'spec', title: 'Geburtstags-Erinnerungen im Kern' });
    expect(r.data.issue_error).toContain('GitHub-Token');
    expect(r.data.spec).toContain('Ziel');
    expect(r.data.flag).toBe(`core.${(await admin('GET', `/api/plugins/${pid}`)).data.slug}`);
    // the flag exists, switched off, for the staged rollout of the core feature
    expect((t.app.services.flags as any).get(r.data.flag)).toMatchObject({ stage: 'off' });
    // a second proposal for the same plugin is refused while one is running
    expect((await admin('POST', `/api/werkstatt/plugins/${pid}/core-proposal`, {})).status).toBe(400);
    await admin('DELETE', `/api/werkstatt/core/${r.data.id}`);
  });

  it('opens an issue with @codex (or @claude) instructions and the spec, and tracks it to „im Kern enthalten“', async () => {
    expect((await admin('PUT', `/api/github-codex/settings`, { token: TOKEN, default_repo: 'acme/gohigh' })).status).toBe(200);
    expect((await admin('PUT', '/api/werkstatt/policy', { core: { repo: 'acme/gohigh', agent: 'codex' } })).status).toBe(200);
    expect((await member('POST', `/api/werkstatt/plugins/${pid}/core-proposal`, {})).status).toBe(403);
    ghCalls = [];
    const r = await admin('POST', `/api/werkstatt/plugins/${pid}/core-proposal`, { target_version: '9.0.0', core_action: 'migrate' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'issue_open', issue_number: 42, issue_url: 'https://github.com/acme/gohigh/issues/42', repo: 'acme/gohigh', agent: 'codex', issue_error: '' });
    const issue = ghCalls.find((c) => c.method === 'POST')!;
    expect(issue.url).toBe('https://api.github.com/repos/acme/gohigh/issues');
    expect(issue.body.title).toBe('[Kernfeature] Geburtstags-Erinnerungen im Kern');
    expect(issue.body.body).toContain('Geburtstage gehören zu den Kontakten.');
    expect(issue.body.body).toContain('Geburtstags-Erinnerungen');
    expect(issue.body.body).toContain('core.');
    expect(issue.body.body).toMatch(/\n\n@codex Setze die oben beschriebene Spezifikation/);
    expect(issue.body.labels).toEqual(['kernfeature', 'plugin']);
    expect((await admin('GET', `/api/plugins/${pid}`)).data.core_status).toBe('proposed');
    // tracking: the issue is open, then a pull request mentions it, then it merges
    expect((await admin('POST', `/api/werkstatt/core/${r.data.id}/refresh`, {})).data.status).toBe('issue_open');
    timeline = [{ event: 'cross-referenced', source: { issue: { number: 7, html_url: 'https://github.com/acme/gohigh/pull/7', state: 'open', pull_request: { merged_at: null } } } }];
    expect((await admin('POST', `/api/werkstatt/core/${r.data.id}/refresh`, {})).data).toMatchObject({ status: 'in_progress', prs: [{ number: 7, merged: false }] });
    timeline = [{ event: 'cross-referenced', source: { issue: { number: 7, html_url: 'https://github.com/acme/gohigh/pull/7', state: 'closed', pull_request: { merged_at: '2026-10-05T10:00:00Z' } } } }];
    expect((await admin('POST', `/api/werkstatt/core/${r.data.id}/refresh`, {})).data.status).toBe('merged');
    // the target version has not been reached: the periodic check leaves it alone
    await (t.app.services.werkstattCore as any).poll(true);
    expect((await admin('GET', '/api/werkstatt/core')).data.proposals[0].status).toBe('merged');
    // an admin ships it: the plugin is marked, installs migrate (switched off, data kept)
    expect((await member('POST', `/api/werkstatt/core/${r.data.id}/ship`, { version: '9.0.0' })).status).toBe(403);
    expect((await admin('POST', `/api/werkstatt/core/${r.data.id}/ship`, { version: 'x' })).status).toBe(400);
    const shipped = await admin('POST', `/api/werkstatt/core/${r.data.id}/ship`, { version: '9.0.0', action: 'migrate' });
    expect(shipped.data).toMatchObject({ status: 'shipped', shipped_version: '9.0.0' });
    const p = (await admin('GET', `/api/plugins/${pid}`)).data;
    expect(p).toMatchObject({ status: 'in_core', core_status: 'shipped', core_version: '9.0.0' });
    expect((await member('GET', '/api/plugins/active')).data.map((x: any) => x.id)).not.toContain(pid);
    expect(t.app.db.all('SELECT enabled FROM plugin_installs WHERE plugin_id = ?', pid).every((i: any) => i.enabled === 0)).toBe(true);
  });

  it('@claude for another agent; "retire" removes the installs and their data', async () => {
    const r = await admin('POST', '/api/plugins/examples/followup-aufgabe/install', { consent: EXAMPLES['followup-aufgabe'].manifest.scopes });
    const id = r.data.id;
    ghCalls = [];
    timeline = [];
    const prop = await admin('POST', `/api/werkstatt/plugins/${id}/core-proposal`, { agent: 'claude', repo: 'https://github.com/acme/gohigh.git', core_action: 'retire' });
    expect(prop.data).toMatchObject({ status: 'issue_open', agent: 'claude' });
    expect(ghCalls.find((c) => c.method === 'POST')!.body.body).toContain('@claude Setze');
    await admin('POST', `/api/plugins/${id}/call`, { op: 'storage.set', args: { key: 'a', value: 1 } });
    (t.app.services.werkstattCore as any).ship(prop.data.id, '0.0.31', 'retire');
    expect(t.app.db.all('SELECT 1 FROM plugin_installs WHERE plugin_id = ?', id)).toHaveLength(0);
    expect(t.app.db.all('SELECT 1 FROM plugin_storage WHERE plugin_id = ?', id)).toHaveLength(0);
    expect((await admin('GET', `/api/plugins/${id}`)).data.status).toBe('in_core');
    // a plugin that is in the core can no longer be installed from the Marktplatz
    expect((await admin('POST', `/api/marktplatz/${id}/install`, { consent: [] })).status).toBe(404);
  });

  it('a proposal ships by itself once the app reaches the target version', async () => {
    const r = await admin('POST', '/api/plugins/examples/deal-ampel/install', { consent: EXAMPLES['deal-ampel'].manifest.scopes });
    timeline = [{ event: 'cross-referenced', source: { issue: { number: 9, html_url: 'https://github.com/acme/gohigh/pull/9', state: 'closed', pull_request: { merged_at: '2026-10-05T10:00:00Z' } } } }];
    const prop = (await admin('POST', `/api/werkstatt/plugins/${r.data.id}/core-proposal`, { target_version: '0.0.1' })).data;
    expect(prop.status).toBe('issue_open');
    await (t.app.services.werkstattCore as any).poll(true);
    const after = (await admin('GET', '/api/werkstatt/core')).data.proposals.find((x: any) => x.id === prop.id);
    expect(after).toMatchObject({ status: 'shipped', shipped_version: '0.0.1' });
    expect((await admin('GET', `/api/plugins/${r.data.id}`)).data.status).toBe('in_core');
  });
});
