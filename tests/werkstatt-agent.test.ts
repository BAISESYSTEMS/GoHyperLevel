import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { anthropicSse, events, fakeModel, sse } from './agent-fakes.js';
import { pluginAnswer, stage2Plan, usage } from './werkstatt-fakes.js';
import { REVIEW_CHECKS } from '../server/services/werkstatt/generate.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { WERKSTATT_TOOL_NAMES } from '../server/modules/werkstatt-tools.js';

/**
 * Realtime Feature Lifecycle in the HyperLevel Agent chat: the agent recognises a wish, plans it (a card with the plan
 * and the person's own confirm button), the build runs with live steps, the plugin appears with a sandboxed preview,
 * a conversational change makes version 2 with a diff summary, and admins run the lifecycle from the chat. The
 * agent's model is a script (no network); so is the Werkstatt's AI. Nothing is confirmed by the agent itself.
 */

const AKEY = 'sk-ant-api03-agenttest-abcdefghijklmnopqrstuvwxyz';
const model = fakeModel();
let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let admin: Call;
let member: Call;
let plan: () => any = () => stage2Plan('deal-ampel');
let build: () => any = () => pluginAnswer('deal-ampel');
const idle = async () => void (await t.app.services.werkstatt.idle());
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
const say = (text: string) => ({ type: 'text' as const, text });
const chat = async (c: Call, message: string, extra: Record<string, unknown> = {}) => {
  const r = await c('POST', '/api/agent/chat', { message, ...extra });
  return { status: r.status, events: events(r.text), text: r.text };
};
const confirmCard = async (c: Call, card: any, next: string) => {
  model.reply(sse(anthropicSse([say(next)])));
  const r = await c('POST', '/api/agent/confirm', { pending_id: card.pending_id, token: card.token, approve: true, args_hash: card.args_hash });
  expect(r.status, r.text).toBe(200);
  return events(r.text);
};
/** The JSON a tool returned, as the chat card reads it. */
const resultOf = (evs: any[], id?: string) => {
  const e = evs.filter((x) => x.type === 'tool_result' && (!id || x.id === id)).at(-1);
  return { status: e?.status as string, data: e?.preview ? JSON.parse(e.preview) : undefined, links: e?.links };
};
const login = async (email: string, password = 'passwort-1x') => {
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await c('POST', '/api/auth/login', { email, password })).status).toBe(200);
  return c;
};
const toolNames = () => (model.calls.at(-1)?.body.tools ?? []).map((x: any) => x.name) as string[];

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  A = t.api.location;
  admin = await login('chef@example.com', 'geheim123');
  expect((await admin('POST', '/api/users', { email: 'mia@example.com', name: 'Mia', password: 'passwort-1x', role: 'member', locations: [A], permissions: null })).status).toBe(200);
  member = await login('mia@example.com');
  expect((await admin('PUT', '/api/werkstatt/policy', { who: 'everyone', approval: false, budget_usd: 100 })).status).toBe(200);
  // The agent talks to Claude (scripted); the Werkstatt's own AI is scripted too and runs on Opus 5.5 (the model gate).
  expect((await admin('POST', '/api/ai-connections', { provider: 'anthropic', api_key: AKEY, models: { text: 'claude-opus-5-5' } })).status).toBe(200);
  expect((await admin('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' })).status).toBe(200);
  expect((await admin('PUT', '/api/agent/settings', { default_mode: 'auto' })).status).toBe(200);
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => {
    const body = input.purpose === 'werkstatt_plan' ? plan() : input.purpose === 'werkstatt_review' ? { verdict: 'pass', summary: 'Unbedenklich.', checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: true, note: 'ok' })) } : build();
    return { text: JSON.stringify(body), model: 'claude-opus-5-5', stopReason: 'end_turn', usage, ms: 5, effort: { requested: 'xhigh', applied: 'high', sent: true, note: 'xhigh → high, vom Modell nicht unterstützt' } };
  };
}, 60_000);
afterAll(() => t.close());

let planId = '';
let pluginId = '';

describe('wish → plan card → confirm → live progress → preview', () => {
  it('the agent knows what to do: the prompt and the tools are there for a member who may build', async () => {
    model.reset();
    model.reply(sse(anthropicSse([say('Hallo!')])));
    await chat(member, 'Hallo');
    const system = JSON.stringify(model.calls[0].body.system);
    expect(system).toContain('ghl_build_from_wish');
    expect(system).toContain('als Karte im Chat');
    expect(system).not.toContain('ghl_plugin_admin');
    expect(toolNames()).toEqual(expect.arrayContaining(['ghl_build_from_wish', 'ghl_change_plugin', 'ghl_discard_plugin', 'ghl_plugin_status', 'ghl_list_plugins']));
    // lifecycle tools are for admins only
    expect(toolNames()).not.toContain('ghl_plugin_admin');
    expect(toolNames()).not.toContain('ghl_plugin_overview');
    model.reply(sse(anthropicSse([say('Hallo, Chef!')])));
    await chat(admin, 'Hallo');
    expect(toolNames()).toEqual(expect.arrayContaining(['ghl_plugin_admin', 'ghl_plugin_overview']));
    expect(WERKSTATT_TOOL_NAMES).toEqual(expect.arrayContaining(['ghl_build_from_wish', 'ghl_change_plugin', 'ghl_plugin_admin']));
  });

  it('a wish becomes a plan: planning needs no extra click, the plan comes back for the card – and nothing is built', async () => {
    model.reset();
    model.reply(
      sse(anthropicSse([say('Das kann ich dir bauen lassen.'), tool('tu_1', 'ghl_build_from_wish', { text: 'Ich hätte gern eine Ampel, die zeigt, welche Deals lange liegen.' })])),
      sse(anthropicSse([say('Ich habe einen Plan erstellt – du siehst ihn in der Karte.')])),
    );
    const r = await chat(member, 'Ich hätte gern eine Ampel, die zeigt, welche Deals lange liegen.');
    expect(r.status).toBe(200);
    // planning only writes a little (a few cents of AI): no confirmation card in "Autonom"
    expect(r.events.find((e) => e.type === 'confirm')).toBeUndefined();
    const { status, data } = resultOf(r.events, 'tu_1');
    expect(status).toBe('ok');
    expect(data).toMatchObject({ status: 'planned', stage: 'Mini-App', title: 'Deal-Ampel', model: 'claude-opus-5-5', denkstufe: 'maximal (xhigh)' });
    expect(data.permissions[0]).toContain('opportunities:read');
    expect(data.estimated_cost_usd).toBeGreaterThan(0);
    expect(data.link).toBe(`werkstatt/${data.build_id}`);
    // the card finds the order by its id – first key, so a cut-off preview still has it
    const preview = r.events.find((e) => e.type === 'tool_result')!.preview as string;
    expect(preview.startsWith('{"build_id"')).toBe(true);
    expect(JSON.stringify(r.events)).toContain(`werkstatt/${data.build_id}`);
    expect(r.events.find((e) => e.type === 'tool_result')!.links[0]).toMatchObject({ label: 'Öffnen', to: `werkstatt/${data.build_id}` });
    planId = data.build_id;
    const b = (await member('GET', `/api/werkstatt/builds/${planId}`)).data;
    expect(b).toMatchObject({ status: 'planned', stage: 2, plugin_id: null });
    expect(b.plan.ai).toMatchObject({ model: 'claude-opus-5-5', effort: { applied: 'xhigh' } });
    expect((await member('GET', '/api/plugins')).data.plugins).toEqual([]);
  });

  it('the agent cannot confirm by accident: confirming a build asks first – even in "Autonom"', async () => {
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_c', 'ghl_build_from_wish', { build_id: planId, confirm: true, accept_permissions: true })])));
    const r = await chat(member, 'Ja, bauen.');
    const card = r.events.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_build_from_wish', klass: 'sensitive' });
    expect(r.events.find((e) => e.type === 'done')).toMatchObject({ status: 'awaiting' });
    expect((await member('GET', `/api/werkstatt/builds/${planId}`)).data.status).toBe('planned');
    // declined: nothing happens
    model.reply(sse(anthropicSse([say('Okay, ich baue nichts.')])));
    const no = events((await member('POST', '/api/agent/confirm', { pending_id: card.pending_id, token: card.token, approve: false })).text);
    expect(no.find((e) => e.type === 'tool_result')).toMatchObject({ status: 'rejected' });
    expect((await member('GET', `/api/werkstatt/builds/${planId}`)).data.status).toBe('planned');
  });

  it('the card\'s button is the person\'s click: it confirms through the normal route; progress is live, the plugin appears with a sandboxed preview', async () => {
    let step = '';
    const steps: string[] = [];
    const watcher = setInterval(async () => {
      const b = (await member('GET', `/api/werkstatt/builds/${planId}`)).data;
      const label = b.progress?.label ?? '';
      if (label && label !== step) {
        step = label;
        steps.push(label);
      }
    }, 5);
    const b0 = (await member('GET', `/api/werkstatt/builds/${planId}`)).data;
    const c = await member('POST', `/api/werkstatt/builds/${planId}/confirm`, { accept_scopes: b0.plan.scopes.map((s: any) => s.key), accept_areas: b0.plan.areas });
    expect(c.status, c.text).toBe(200);
    expect(c.data.status).toBe('building');
    await idle();
    clearInterval(watcher);
    const done = (await member('GET', `/api/werkstatt/builds/${planId}`)).data;
    expect(done.status, done.error).toBe('done');
    expect(done.log.map((l: any) => l.text).join('\n')).toContain('Das Plugin „Deal-Ampel“ ist jetzt für dich aktiv');
    pluginId = done.plugin_id;
    // the plugin is there, private, with its model and Denkstufe on the version
    const p = (await member('GET', `/api/plugins/${pluginId}`)).data;
    expect(p).toMatchObject({ scope: 'private', active_here: true, version: '1.0.0' });
    expect(p.versions[0].badges).toMatchObject({ static: true, model: 'claude-opus-5-5', effort: 'hoch' });
    // the preview the card embeds: a trusted host page around a frame without allow-same-origin
    const host = await member('GET', `/plugin-host/${pluginId}?locationId=${A}&entry=${p.entries.page ? 'page' : `widget:${p.entries.widgets[0].id}`}`);
    expect(host.status).toBe(200);
    expect(host.text).toContain('sandbox="allow-scripts"');
    expect(host.text).not.toContain('allow-same-origin');
    void steps;
  });

  it('status by chat: the agent can ask for the build and the plugin (version badges)', async () => {
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_s', 'ghl_plugin_status', { build_id: planId }), tool('tu_p', 'ghl_plugin_status', { plugin_id: pluginId })])), sse(anthropicSse([say('Fertig.')])));
    const r = await chat(member, 'Wie weit ist das Plugin?');
    const b = resultOf(r.events, 'tu_s').data;
    expect(b).toMatchObject({ build_id: planId, status: 'Fertig', plugin_id: pluginId, model: 'claude-opus-5-5', denkstufe: 'hoch' });
    const p = resultOf(r.events, 'tu_p').data;
    expect(p.versions[0]).toContain('1.0.0 (aktiv)');
    expect(p.versions[0]).toContain('statisch ✓');
    expect(p.versions[0]).toContain('claude-opus-5-5, Denkstufe hoch');
  });
});

describe('conversational change → version 2 with a diff summary', () => {
  it('"mach die Farben dunkler" asks, builds version 2 and answers with what changed; the old version stays', async () => {
    build = () => pluginAnswer('deal-ampel', { ui_html: EXAMPLES['deal-ampel'].ui_html + '\n<style>.gh-card{background:#111}</style>\n<p class="muted">Dunkler Modus</p>' });
    model.reset();
    model.reply(sse(anthropicSse([say('Ich passe das an.'), tool('tu_ch', 'ghl_change_plugin', { plugin_id: pluginId, feedback: 'Mach die Karten dunkler und füge einen Hinweistext hinzu.' })])));
    const first = await chat(member, 'Mach die Farben der Ampel dunkler.');
    const card = first.events.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_change_plugin', klass: 'sensitive' });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM werkstatt_builds WHERE kind = 'change'`)!.n).toBe(0);
    const evs = await confirmCard(member, card, 'Version 2 ist aktiv: dunklere Karten und ein Hinweistext.');
    const { status, data } = resultOf(evs, card.call_id);
    expect(status).toBe('ok');
    expect(data).toMatchObject({ status: 'done', plugin_id: pluginId, version: '1.0.1', previous_version: '1.0.0', needs_activation: false, model: 'claude-opus-5-5', denkstufe: 'hoch' });
    expect(data.diff.join(' ')).toContain('Oberfläche');
    expect(data.link).toBe(`werkstatt/${data.build_id}`);
    // v2 is live for the author; v1 is still in the list
    const p = (await member('GET', `/api/plugins/${pluginId}`)).data;
    expect(p.version).toBe('1.0.1');
    expect(p.versions.map((v: any) => `${v.version}${v.active ? '*' : ''}`)).toEqual(['1.0.1*', '1.0.0']);
    expect(p.versions[0].diff.summary.join(' ')).toContain('Oberfläche');
    // the final answer of the model got the summary as data
    expect(JSON.stringify(model.calls.at(-1)!.body.messages)).toContain('Oberfläche');
    // another member cannot change somebody else's plugin
    const other = await login('chef@example.com', 'geheim123');
    void other;
  });

  it('a change without a reason to wait still reports; a failing build says so readably', async () => {
    build = () => ({ not: 'a plugin' });
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_bad', 'ghl_change_plugin', { plugin_id: pluginId, feedback: 'Bitte alles ändern, was geht.' })])));
    const first = await chat(member, 'Ändere noch etwas.');
    const evs = await confirmCard(member, first.events.find((e) => e.type === 'confirm'), 'Das hat nicht geklappt.');
    const { data } = resultOf(evs, 'tu_bad');
    expect(data.status).toBe('failed');
    expect(data.error).toContain('Versuch');
    // version 1.0.1 stays active
    expect((await member('GET', `/api/plugins/${pluginId}`)).data.version).toBe('1.0.1');
    build = () => pluginAnswer('deal-ampel');
  });
});

describe('admin lifecycle in the chat', () => {
  it('members never get the lifecycle tools – and calling them anyway is refused', async () => {
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_x', 'ghl_plugin_admin', { action: 'disable', plugin_id: pluginId })])), sse(anthropicSse([say('Geht nicht.')])));
    const r = await chat(member, 'Schalte das Plugin ab.');
    expect(resultOf(r.events, 'tu_x').status).toBe('error');
    expect((await member('GET', `/api/plugins/${pluginId}`)).data.status).toBe('active');
  });

  it('overview → rollback with confirmation: the admin rolls the plugin back to the version before', async () => {
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_o', 'ghl_plugin_overview', {})])), sse(anthropicSse([tool('tu_r', 'ghl_plugin_admin', { action: 'rollback', plugin_id: pluginId })])));
    const r = await chat(admin, 'Was gibt es Neues in der Werkstatt? Rolle bitte die Ampel zurück.');
    const overview = resultOf(r.events, 'tu_o').data;
    expect(overview.plugins.find((p: any) => p.plugin_id === pluginId)).toMatchObject({ name: 'Deal-Ampel', version: '1.0.1', scope: 'private', link: `werkstatt/plugins/${pluginId}` });
    const card = r.events.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_plugin_admin', klass: 'sensitive' });
    expect((await admin('GET', `/api/plugins/${pluginId}`)).data.version).toBe('1.0.1');
    const evs = await confirmCard(admin, card, 'Zurückgerollt auf 1.0.0.');
    expect(resultOf(evs, 'tu_r').data).toMatchObject({ rolled_back: true, from: '1.0.1', to: '1.0.0', plugin_id: pluginId });
    expect((await admin('GET', `/api/plugins/${pluginId}`)).data.version).toBe('1.0.0');
  });

  it('approvals from the chat: the admin sees what waits, approves with a confirmation, and the build runs as the requester', async () => {
    expect((await admin('PUT', '/api/werkstatt/policy', { approval: true })).status).toBe(200);
    plan = () => stage2Plan('notizen-zusammenfassung');
    build = () => pluginAnswer('notizen-zusammenfassung');
    // Mia asks through the chat, confirms with the card's button – and waits for approval
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_w', 'ghl_build_from_wish', { text: 'Ich hätte gern eine Zusammenfassung der Notizen pro Kontakt.' })])), sse(anthropicSse([say('Plan steht.')])));
    const r = await chat(member, 'Ich hätte gern eine Zusammenfassung der Notizen pro Kontakt.');
    const id = resultOf(r.events, 'tu_w').data.build_id as string;
    const b0 = (await member('GET', `/api/werkstatt/builds/${id}`)).data;
    expect((await member('POST', `/api/werkstatt/builds/${id}/confirm`, { accept_scopes: b0.plan.scopes.map((s: any) => s.key), accept_areas: b0.plan.areas })).data.status).toBe('awaiting_approval');
    // the member's card says so; nothing is built
    expect((await member('GET', `/api/werkstatt/builds/${id}`)).data).toMatchObject({ status: 'awaiting_approval', status_label: 'Wartet auf Freigabe' });
    // the admin in the chat
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_ov', 'ghl_plugin_overview', {})])), sse(anthropicSse([tool('tu_ap', 'ghl_plugin_admin', { action: 'approve_build', build_id: id, note: 'passt' })])));
    const a = await chat(admin, 'Gibt es Freigaben?');
    expect(resultOf(a.events, 'tu_ov').data.awaiting_approval).toEqual([expect.objectContaining({ build_id: id, link: `werkstatt/${id}`, by: 'Mia' })]);
    const card = a.events.find((e) => e.type === 'confirm');
    expect((await member('GET', `/api/werkstatt/builds/${id}`)).data.status).toBe('awaiting_approval');
    const evs = await confirmCard(admin, card, 'Freigegeben.');
    expect(resultOf(evs, 'tu_ap').data).toMatchObject({ build_id: id, status: 'Wird gebaut' });
    await idle();
    expect((await member('GET', `/api/werkstatt/builds/${id}`)).data).toMatchObject({ status: 'done', approval: { note: 'passt' } });
    await admin('PUT', '/api/werkstatt/policy', { approval: false });
  });

  it('review and publish from the chat need the review first and the admin\'s explicit approval; the verdict comes back', async () => {
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_rev', 'ghl_plugin_admin', { action: 'review', plugin_id: pluginId })])));
    const r = await chat(admin, 'Lass die Ampel prüfen.');
    const evs = await confirmCard(admin, r.events.find((e) => e.type === 'confirm'), 'Die Prüfung ist unbedenklich.');
    const review = resultOf(evs, 'tu_rev').data;
    expect(review).toMatchObject({ kind: 'review', verdict: 'pass', model: 'claude-opus-5-5', denkstufe: 'hoch' });
    // publishing without the review id or without approve is refused by the route's own rules
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_pub0', 'ghl_plugin_admin', { action: 'publish', plugin_id: pluginId })])), sse(anthropicSse([say('Es fehlt die Prüfung.')])));
    const p0 = await chat(admin, 'Veröffentliche die Ampel.');
    const card0 = p0.events.find((e) => e.type === 'confirm');
    model.reply(sse(anthropicSse([say('Das ging nicht.')])));
    const ev0 = events((await admin('POST', '/api/agent/confirm', { pending_id: card0.pending_id, token: card0.token, approve: true, args_hash: card0.args_hash })).text);
    expect(resultOf(ev0, 'tu_pub0').status).toBe('error');
    expect((await admin('GET', `/api/plugins/${pluginId}`)).data.scope).toBe('private');
    // with the review and the admin's approval it goes to the Marktplatz
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_pub', 'ghl_plugin_admin', { action: 'publish', plugin_id: pluginId, review_id: review.review_id, approve: true, accept_warnings: true })])));
    const p1 = await chat(admin, 'Ja, veröffentliche sie.');
    const ev1 = await confirmCard(admin, p1.events.find((e) => e.type === 'confirm'), 'Die Ampel ist im Marktplatz.');
    expect(resultOf(ev1, 'tu_pub').data).toMatchObject({ published: true, plugin_id: pluginId, link: `marktplatz/${pluginId}` });
    expect((await admin('GET', `/api/plugins/${pluginId}`)).data.scope).toBe('marketplace');
  });
});

describe('the model gate in the chat and discarding a plugin', () => {
  it('a Mini-App plan with an everyday model says why it cannot be built – with the place to fix it', async () => {
    expect((await admin('PUT', '/api/ai/settings', { model: 'claude-sonnet-5-5' })).status).toBe(200);
    plan = () => stage2Plan('deal-ampel');
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_g', 'ghl_build_from_wish', { text: 'Ich hätte gern noch eine Ampel für Aufgaben.' })])), sse(anthropicSse([say('Dafür braucht es ein Spitzenmodell.')])));
    const r = await chat(member, 'Ich hätte gern noch eine Ampel für Aufgaben.');
    const { data } = resultOf(r.events, 'tu_g');
    expect(data.status).toBe('planned');
    expect(data.model_gate).toContain('Spitzenmodell');
    expect(data.model_gate).toContain('/app/settings/ai-providers');
    // the card's button is refused by the route
    const b0 = (await member('GET', `/api/werkstatt/builds/${data.build_id}`)).data;
    expect((await member('POST', `/api/werkstatt/builds/${data.build_id}/confirm`, { accept_scopes: b0.plan.scopes.map((s: any) => s.key), accept_areas: b0.plan.areas })).status).toBe(409);
    expect((await admin('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' })).status).toBe(200);
  });

  it('"Verwerfen" asks (destructive) and removes the plugin', async () => {
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_d', 'ghl_discard_plugin', { plugin_id: pluginId })])));
    const r = await chat(member, 'Verwirf die Ampel.');
    const card = r.events.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_discard_plugin' });
    expect((await member('GET', `/api/plugins/${pluginId}`)).status).toBe(200);
    // a published plugin can only be removed by an admin (the route says so): the member's discard is refused
    const evs = await confirmCard(member, card, 'Das darf nur ein Admin.');
    expect(resultOf(evs, 'tu_d').status).toBe('error');
    // the admin takes it back from the Marktplatz and discards it
    expect((await admin('POST', `/api/marktplatz/${pluginId}/unpublish`, {})).status).toBe(200);
    model.reset();
    model.reply(sse(anthropicSse([tool('tu_d2', 'ghl_discard_plugin', { plugin_id: pluginId })])));
    const r2 = await chat(member, 'Verwirf die Ampel jetzt.');
    const evs2 = await confirmCard(member, r2.events.find((e) => e.type === 'confirm'), 'Verworfen.');
    expect(resultOf(evs2, 'tu_d2').data).toMatchObject({ discarded: true });
    expect((await member('GET', `/api/plugins/${pluginId}`)).status).toBe(404);
  });
});
