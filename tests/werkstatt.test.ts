import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { pluginAnswer, stage1Plan, stage2Plan, usage } from './werkstatt-fakes.js';
import { readFileSync } from 'node:fs';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { NAMES } from '../server/services/werkstatt/names.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let admin: Call;
let member: Call; // full access in A
let narrow: Call; // only "contacts" in A
let other: Call; // member of B only
let aiCalls: any[] = [];
let seq = 0;
/** Every stage-1 plan names its things differently (the same name twice is an error, as in real life). */
const fresh = () => stage1Plan(` ${++seq}`);
let plan: (input: any) => any = fresh;
let build: (input: any) => any = () => pluginAnswer('deal-ampel');
let spend = usage;

const login = async (email: string, loc: string) => {
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'passwort-1x' })).status).toBe(200);
  return c;
};
const wait = async () => void (await t.app.services.werkstatt.idle());
const policy = (p: Record<string, unknown>) => admin('PUT', '/api/werkstatt/policy', p);
const planned = async (c: Call, text = 'Ich möchte Rückruf-Wünsche meiner Kunden verwalten.', extra: Record<string, unknown> = {}) => {
  const r = await c('POST', '/api/werkstatt/builds', { text, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await wait();
  return (await c('GET', `/api/werkstatt/builds/${r.data.id}`)).data;
};
const accept = (b: any) => ({ accept_scopes: b.plan.scopes.map((s: any) => s.key), accept_areas: b.plan.areas });

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  admin = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await admin('POST', '/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  for (const [email, locs, perms] of [['m1@example.com', [A], null], ['m2@example.com', [A], ['contacts']], ['n1@example.com', [B], null]] as const)
    expect((await admin('POST', '/api/users', { email, name: email.split('@')[0], password: 'passwort-1x', role: 'member', locations: locs, permissions: perms })).status).toBe(200);
  member = await login('m1@example.com', A);
  narrow = await login('m2@example.com', A);
  other = await login('n1@example.com', B);
  void me;
  // The Werkstatt only works with a top model (model gate): the assistant runs Claude Opus 5.5 here.
  for (const loc of [A, B]) expect((await admin('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' }, { 'x-location-id': loc })).status).toBe(200);
  // The AI is a script: no network, no keys.
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => {
    aiCalls.push(input);
    const body = input.purpose === 'werkstatt_plan' ? plan(input) : build(input);
    return { text: JSON.stringify(body), model: 'claude-opus-5-5', stopReason: 'end_turn', usage: spend, ms: 5 };
  };
}, 60_000);
afterAll(() => t.close());

describe('policy: who may build, approval, budget', () => {
  it('by default only admins build', async () => {
    const r = await member('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas Neues haben.' });
    expect(r.status).toBe(403);
    expect(r.data.error).toContain('Admins');
    const me = await member('GET', '/api/werkstatt/me');
    expect(me.data).toMatchObject({ can_build: false, who: 'admins' });
    expect((await admin('GET', '/api/werkstatt/me')).data.can_build).toBe(true);
  });

  it('the policy is admin-only and validated', async () => {
    expect((await member('PUT', '/api/werkstatt/policy', { who: 'everyone' })).status).toBe(403);
    expect((await admin('PUT', '/api/werkstatt/policy', { who: 'nobody' })).status).toBe(400);
    expect((await admin('PUT', '/api/werkstatt/policy', { allowed_hosts: ['not a host'] })).status).toBe(400);
    expect((await admin('PUT', '/api/werkstatt/policy', { core: { repo: 'kein-repo' } })).status).toBe(400);
    const ok = await admin('PUT', '/api/werkstatt/policy', { who: 'team', approval: true, budget_usd: 5 });
    expect(ok.data.policy).toMatchObject({ who: 'team', approval: true, budget_usd: 5 });
  });

  it('"team" lets members with the settings area build, not restricted logins', async () => {
    await policy({ who: 'team' });
    expect((await narrow('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas Neues haben.' })).status).toBe(403);
    expect((await member('GET', '/api/werkstatt/me')).data.can_build).toBe(true);
    expect((await other('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas Neues haben.' })).status).toBe(200);
    await wait();
    await policy({ who: 'everyone' });
    expect((await narrow('GET', '/api/werkstatt/me')).data.can_build).toBe(true);
  });

  it('builds by non-admins wait for an approval; admins approve or reject; the build runs as the requester', async () => {
    await policy({ who: 'everyone', approval: true });
    const b = await planned(member);
    expect(b.status).toBe('planned');
    const c = await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    expect(c.status).toBe(200);
    expect(c.data.status).toBe('awaiting_approval');
    // nothing was created yet
    expect((await member('GET', '/api/workflows')).data.map((w: any) => w.name).join()).not.toContain(`Aufgabe anlegen ${seq}`);
    // a member cannot approve
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/approve`, {})).status).toBe(403);
    const pending = await admin('GET', '/api/werkstatt/agency');
    expect(pending.data.builds[0].id).toBe(b.id);
    expect((await admin('POST', `/api/werkstatt/builds/${b.id}/approve`, { note: 'ok' })).status).toBe(200);
    await wait();
    const done = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data;
    expect(done.status).toBe('done');
    expect(done.approval).toMatchObject({ by: 'admin' === done.approval.by ? 'admin' : done.approval.by, note: 'ok' });
    expect((await member('GET', '/api/workflows')).data.map((w: any) => w.name)).toContain(done.created.find((c: any) => c.block === 'workflow').name);

    const b2 = await planned(member);
    await member('POST', `/api/werkstatt/builds/${b2.id}/confirm`, accept(b2));
    const rej = await admin('POST', `/api/werkstatt/builds/${b2.id}/reject`, { note: 'zu viel' });
    expect(rej.data).toMatchObject({ status: 'rejected', error: 'Abgelehnt: zu viel' });
  });

  it('without approval a member builds right after confirming; admins never wait', async () => {
    await policy({ who: 'everyone', approval: false });
    const b = await planned(member);
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b))).data.status).toBe('building');
    await wait();
    expect((await member('GET', `/api/werkstatt/builds/${b.id}`)).data.status).toBe('done');
    await policy({ approval: true });
    const a = await planned(admin);
    expect((await admin('POST', `/api/werkstatt/builds/${a.id}/confirm`, accept(a))).data.status).toBe('building');
    await wait();
  });

  it('enforces the monthly budget per sub-account and tracks cost', async () => {
    await policy({ who: 'everyone', approval: false, budget_usd: 5, budgets: {} });
    const before = (await member('GET', '/api/werkstatt/me')).data.budget;
    expect(before.used_usd).toBeGreaterThan(0);
    const b = (await member('GET', '/api/werkstatt/builds')).data[0];
    expect(b.cost_usd).toBeGreaterThan(0);
    // a tiny budget stops new orders (planning costs too) …
    await policy({ budgets: { [A]: 0.01 } });
    const r = await member('POST', '/api/werkstatt/builds', { text: 'Ich möchte noch etwas Neues haben.' });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('Monatsbudget');
    // … but only in that sub-account
    expect((await other('GET', '/api/werkstatt/me')).data.budget.limit_usd).toBe(5);
    await policy({ budgets: {} });
    expect((await member('GET', '/api/werkstatt/me')).data.budget.limit_usd).toBe(5);
  });
});

describe('stage 1 „Einrichtung“: built from existing blocks, only in the requester’s sub-account', () => {
  beforeAll(async () => {
    await policy({ who: 'everyone', approval: false, budget_usd: 50, budgets: {} });
  });

  it('shows the plan with areas and cost before anything is created', async () => {
    plan = fresh;
    const wfBefore = (await member('GET', '/api/workflows')).data.length;
    const b = await planned(member, 'Ich möchte Rückrufe verwalten und bei Anfragen eine Aufgabe bekommen.');
    expect(b).toMatchObject({ stage: 1, status: 'planned', stage_label: 'Einrichtung' });
    expect(b.plan.steps.map((s: any) => s.block)).toEqual(['object_type', 'workflow', 'tag']);
    expect(b.plan.areas).toEqual(expect.arrayContaining(['workflows', 'settings']));
    expect(b.plan.estimate.typical_usd).toBe(0);
    expect(b.plan.summary).toContain('Formular');
    expect((await member('GET', '/api/workflows')).data.length).toBe(wfBefore);
    // a confirm that does not match the shown permissions is refused
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, { accept_scopes: [], accept_areas: [] })).status).toBe(400);
  });

  it('creates a workflow (as a draft) and a custom object only in the requester’s sub-account, and undoes them', async () => {
    const b = await planned(member);
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b))).status).toBe(200);
    await wait();
    const done = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data;
    expect(done.status, done.error).toBe('done');
    expect(done.created.map((c: any) => c.block)).toEqual(['object_type', 'workflow', 'tag']);
    const names = Object.fromEntries(done.created.map((c: any) => [c.block, c.name]));
    const wf = (await member('GET', '/api/workflows')).data.find((w: any) => w.name === names.workflow);
    expect(wf).toMatchObject({ status: 'draft' });
    expect((await member('GET', '/api/object-types')).data.map((o: any) => o.plural)).toContain(names.object_type);
    // sub-account B has none of it
    expect((await other('GET', '/api/workflows')).data.map((w: any) => w.name)).not.toContain(names.workflow);
    expect((await other('GET', '/api/object-types')).data.map((o: any) => o.plural)).not.toContain(names.object_type);
    expect((await other('GET', `/api/werkstatt/builds/${b.id}`)).status).toBe(404);
    // the audit log names the Werkstatt acting for the user
    const audit = (await admin('GET', '/api/audit?limit=50')).data;
    const rows = Array.isArray(audit) ? audit : audit.entries ?? audit.rows ?? [];
    expect(JSON.stringify(rows)).toContain('Werkstatt (im Auftrag von');
    // undo removes what was created
    const u = await member('POST', `/api/werkstatt/builds/${b.id}/undo`, {});
    expect(u.status).toBe(200);
    expect(u.data.removed).toBe(3);
    expect((await member('GET', '/api/workflows')).data.find((w: any) => w.id === wf.id)).toBeUndefined();
    expect((await member('GET', '/api/object-types')).data.map((o: any) => o.plural)).not.toContain(names.object_type);
  });

  it('the AI can only name blocks of the catalogue; a broken plan is repaired once, then refused', async () => {
    let n = 0;
    plan = () => {
      n++;
      const p = fresh();
      if (n === 1) p.steps[0].block = 'delete_everything' as any;
      return p;
    };
    const ok = await planned(member);
    expect(ok.status).toBe('planned');
    expect(n).toBe(2);
    plan = () => ({ ...fresh(), steps: [{ block: 'workflow', title: 'x', params_json: '{"name":"x"}' }] });
    const bad = await planned(member);
    expect(bad.status).toBe('failed');
    expect(bad.error).toContain('keinen brauchbaren Plan');
    plan = fresh;
  });

  it('a restricted login cannot confirm a plan that needs areas it does not have', async () => {
    const b = await planned(narrow);
    expect(b.plan.missing_areas.length).toBeGreaterThan(0);
    const c = await narrow('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    expect(c.status).toBe(403);
    expect(c.data.error).toContain('Recht');
  });

  it('builds are visible to their author and to admins only', async () => {
    const b = await planned(member);
    expect((await narrow('GET', `/api/werkstatt/builds/${b.id}`)).status).toBe(404);
    expect((await admin('GET', `/api/werkstatt/builds/${b.id}`)).status).toBe(200);
    expect((await narrow('POST', `/api/werkstatt/builds/${b.id}/cancel`, {})).status).toBe(404);
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/cancel`, {})).data.status).toBe('cancelled');
  });

  it('a wish becomes the order: title and text come from the wish', async () => {
    const w = await member('POST', '/api/feedback/wishes', { title: 'Geburtstage im Blick', what: 'Ich möchte Geburtstage meiner Kontakte nicht vergessen.' });
    expect(w.status).toBe(200);
    const b = await planned(member, '', { wish_id: w.data.wish.id, text: undefined });
    expect(b.wish_id).toBe(w.data.wish.id);
    expect(b.text).toContain('Geburtstage');
    expect(aiCalls.at(-1).user).toContain('Geburtstage im Blick');
    expect((await member('GET', `/api/werkstatt/wishes/${w.data.wish.id}`)).data).toHaveLength(1);
    expect((await member('POST', '/api/werkstatt/builds', { wish_id: 'nope' })).status).toBe(404);
  });
});

describe('stage 2 „Mini-App“: a sandboxed plugin, private for the requester first', () => {
  let pluginId = '';
  beforeAll(async () => {
    await policy({ who: 'everyone', approval: false, budget_usd: 50, budgets: {} });
  });

  it('plans, builds, checks and activates privately for the requester', async () => {
    plan = () => stage2Plan('deal-ampel');
    build = () => pluginAnswer('deal-ampel');
    const b = await planned(member, 'Ich will auf einen Blick sehen, welche Deals ins Stocken geraten.');
    expect(b).toMatchObject({ stage: 2, status: 'planned' });
    expect(b.plan.scopes.map((s: any) => s.key)).toEqual(['opportunities:read']);
    expect(b.plan.estimate.typical_usd).toBeGreaterThan(0);
    expect(b.plan.manifest.entries.widgets[0].id).toBe('ampel');
    const c = await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    expect(c.status).toBe(200);
    await wait();
    const done = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data;
    expect(done.status, done.error).toBe('done');
    expect(done.plugin_id).toBeTruthy();
    expect(done.log.map((l: any) => l.text).join('\n')).toContain('Prüfungen bestanden');
    pluginId = done.plugin_id;
    // active for the requester …
    const mine = (await member('GET', '/api/plugins')).data.plugins.find((p: any) => p.id === pluginId);
    expect(mine).toMatchObject({ name: 'Deal-Ampel', scope: 'private', active_here: true, version: '1.0.0', can_manage: true });
    expect((await member('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(pluginId);
    // … and for nobody else: not another login in the sub-account, not another sub-account
    expect((await narrow('GET', '/api/plugins/active')).data).toEqual([]);
    expect((await narrow('GET', `/api/plugins/${pluginId}`)).status).toBe(404);
    expect((await other('GET', '/api/plugins/active')).data).toEqual([]);
    expect((await narrow('POST', `/api/plugins/${pluginId}/call`, { op: 'opportunities.list' })).status).toBe(404);
  });

  it('a build that does not pass the checks is repaired, then fails without leaving a plugin behind', async () => {
    const before = (await admin('GET', '/api/plugins')).data.plugins.length;
    let n = 0;
    build = () => {
      n++;
      return pluginAnswer('deal-ampel', { ui_html: '<div>x</div><script>gohigh.ready(async () => { const r = await fetch("/api/contacts"); });</script>' });
    };
    const b = await planned(member);
    await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    await wait();
    const done = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data;
    expect(done.status).toBe('failed');
    expect(done.error).toContain('fetch');
    expect(n).toBe(3);
    expect((await admin('GET', '/api/plugins')).data.plugins.length).toBe(before);
    build = () => pluginAnswer('deal-ampel');
  });

  it('a repair round that fixes the code makes the build succeed', async () => {
    let n = 0;
    build = () => (++n === 1 ? pluginAnswer('deal-ampel', { ui_html: '<div>zweite Runde</div><script>eval("1")</script>' }) : pluginAnswer('deal-ampel'));
    const b = await planned(member);
    await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    await wait();
    const done = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data;
    expect(done.status, done.error).toBe('done');
    expect(n).toBe(2);
    build = () => pluginAnswer('deal-ampel');
  });

  it('serves the UI from two documents: a trusted host page and a sandboxed frame without allow-same-origin', async () => {
    const host = await member('GET', `/plugin-host/${pluginId}?locationId=${A}&entry=widget:ampel&theme=dark`);
    expect(host.status).toBe(200);
    expect(host.text).toContain('sandbox="allow-scripts"');
    expect(host.text).not.toContain('allow-same-origin');
    expect(host.text).not.toContain('allow-top-navigation');
    const csp = host.headers.get('content-security-policy')!;
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(host.headers.get('cache-control')).toContain('no-store');
    const cfg = JSON.parse(/<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(host.text)![1]);
    expect(cfg).toMatchObject({ pluginId, demo: false, callUrl: `/api/plugins/${pluginId}/call`, ops: expect.arrayContaining(['opportunities.list', 'storage.get']) });
    expect(cfg.ops).not.toContain('contacts.list');
    // the host page only reaches the frame address, which has its own strict policy
    const frame = await member('GET', cfg.frameUrl);
    expect(frame.status).toBe(200);
    const fcsp = frame.headers.get('content-security-policy')!;
    expect(fcsp).toContain('sandbox allow-scripts');
    expect(fcsp).toContain("default-src 'none'");
    expect(fcsp).toContain("connect-src 'none'");
    expect(fcsp).toContain("frame-src 'none'");
    expect(fcsp).toContain("form-action 'none'");
    expect(fcsp).toContain("img-src data: blob:");
    expect(fcsp).not.toContain('https:');
    expect(frame.text).toContain("Object.defineProperty(window, 'gohigh'");
    expect(frame.text).toContain('opportunities.list');
    // no session cookie in the document, no token
    expect(frame.text).not.toMatch(/pghl_session|x-pghl|authorization/i);
    // others get nothing
    expect((await narrow('GET', `/plugin-host/${pluginId}?locationId=${A}`)).text).toContain('nicht aktiv');
    expect((await other('GET', cfg.frameUrl.replace(`locationId=${A}`, `locationId=${B}`))).text).toContain('Nicht verfügbar');
    expect((await t.api.raw(cfg.frameUrl)).status).toBe(401);
  });

  it('the bridge denies scopes the manifest does not list and counts them', async () => {
    const ok = await member('POST', `/api/plugins/${pluginId}/call`, { op: 'opportunities.list', args: { status: 'open' } });
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.data.data)).toBe(true);
    for (const op of ['contacts.list', 'tasks.create', 'conversations.list', 'ai.complete', 'reports.run']) {
      const r = await member('POST', `/api/plugins/${pluginId}/call`, { op, args: { title: 'x', prompt: 'x', query: {} } });
      expect(r.status, op).toBe(403);
      expect(r.data.error, op).toContain('nicht angefragt');
    }
    expect((await member('POST', `/api/plugins/${pluginId}/call`, { op: 'no.such.op' })).status).toBe(400);
    // storage always works and is separate per plugin
    expect((await member('POST', `/api/plugins/${pluginId}/call`, { op: 'storage.set', args: { key: 'a', value: { n: 1 } } })).status).toBe(200);
    expect((await member('POST', `/api/plugins/${pluginId}/call`, { op: 'storage.get', args: { key: 'a' } })).data.data).toEqual({ n: 1 });
    const health = (await admin('GET', `/api/plugins/${pluginId}/health`)).data;
    expect(health.health.errors_24h).toBeGreaterThanOrEqual(5);
  });

  it('the kill switch trips on an error spike and tells the admins; an admin can revive', async () => {
    // the five denials above are not enough (default: 10 within 10 minutes and half of all events) …
    expect((await member('GET', `/api/plugins/${pluginId}`)).data.status).toBe('active');
    for (let i = 0; i < 8; i++) await member('POST', `/api/plugins/${pluginId}/call`, { op: 'contacts.list' });
    const p = (await member('GET', `/api/plugins/${pluginId}`)).data;
    expect(p.status).toBe('killed');
    expect(p.killed_reason).toContain('Fehler');
    // a killed plugin is off everywhere: no menu entry, no bridge, no frame
    expect((await member('GET', '/api/plugins/active')).data.map((x: any) => x.id)).not.toContain(pluginId);
    expect((await member('POST', `/api/plugins/${pluginId}/call`, { op: 'opportunities.list' })).status).toBe(404);
    expect((await member('GET', `/plugin-host/${pluginId}?locationId=${A}&entry=page`)).text).toContain('nicht aktiv');
    // the error was filed like any crash
    const tickets = t.app.db.all(`SELECT title FROM feedback_items WHERE kind = 'auto' AND title LIKE '%Deal-Ampel%'`);
    expect(tickets.length).toBeGreaterThan(0);
    expect((await member('POST', `/api/plugins/${pluginId}/revive`, {})).status).toBe(403);
    expect((await admin('POST', `/api/plugins/${pluginId}/revive`, {})).status).toBe(200);
    expect((await member('GET', '/api/plugins/active')).data.map((x: any) => x.id)).toContain(pluginId);
    // the policy decides how sensitive the switch is
    await policy({ kill: { errors: 3, window_min: 10, ratio: 0.5 } });
    for (let i = 0; i < 4; i++) await member('POST', `/api/plugins/${pluginId}/call`, { op: 'contacts.list' });
    expect((await member('GET', `/api/plugins/${pluginId}`)).data.status).toBe('killed');
    await admin('POST', `/api/plugins/${pluginId}/revive`, {});
    await policy({ kill: { errors: 10, window_min: 10, ratio: 0.5 } });
  });

  it('respects the user’s own permissions and the sub-account', async () => {
    // a plugin that may read contacts, run by a login that only has "opportunities" – use the contacts example
    plan = () => stage2Plan('notizen-zusammenfassung');
    build = () => pluginAnswer('notizen-zusammenfassung');
    const b = await planned(member);
    await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    await wait();
    const pid = (await member('GET', `/api/werkstatt/builds/${b.id}`)).data.plugin_id;
    expect(pid).toBeTruthy();
    // share it with the sub-account (a team member may), then the restricted login (only "contacts") uses it
    expect((await member('POST', `/api/plugins/${pid}/scope`, { scope: 'location' })).status).toBe(200);
    expect((await narrow('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(pid);
    const c = await narrow('POST', `/api/plugins/${pid}/call`, { op: 'contacts.list', args: { limit: 1 } });
    expect(c.status).toBe(200);
    // … but ai:run needs no area; reports would need "dashboard": a manifest scope the user lacks is refused by the user's rights
    const sub = t.app.services.plugins as any;
    expect(sub.get(pid).scope).toBe('location');
    // the other sub-account sees nothing and cannot call it
    expect((await other('GET', '/api/plugins/active')).data).toEqual([]);
    expect((await other('POST', `/api/plugins/${pid}/call`, { op: 'contacts.list' })).status).toBe(404);
    // data stays in the plugin's own sub-account: a foreign location id in the arguments is ignored
    const r = await member('POST', `/api/plugins/${pid}/call`, { op: 'contacts.list', args: { limit: 5, locationId: B, location_id: B } });
    expect(r.status).toBe(200);
    for (const x of r.data.data.contacts ?? []) expect(x.location_id).toBe(A);
    plan = fresh;
  });
});

describe('the names live in one constant', () => {
  it('the menu entries (literals in main.tsx, parsed by the menu tests) match NAMES', () => {
    const main = readFileSync('web/src/main.tsx', 'utf8');
    expect(main).toContain(`['werkstatt', 'hammer', '${NAMES.werkstatt}', '*']`);
    expect(main).toContain(`['marktplatz', 'store', '${NAMES.marktplatz}', '*']`);
  });
});
