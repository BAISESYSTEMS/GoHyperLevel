import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { pluginAnswer, stage1Plan, stage2Plan, usage } from './werkstatt-fakes.js';
import { REVIEW_CHECKS } from '../server/services/werkstatt/generate.js';
import { DEFAULT_GATE, GATE_EXAMPLES, GATE_LINK, checkModel, cleanPatterns, gateMessage, loadGate, matchesGlob, needsTopModel } from '../server/services/werkstatt/modelgate.js';
import { diffVersions, lineDiff } from '../server/services/werkstatt/diff.js';
import { GOHIGH_PUBLIC_KEYS } from '../server/services/werkstatt/trusted-keys.js';
import { checkSignature, generateKeyPair, signBundle } from '../server/services/werkstatt/signing.js';
import { recordEvent, slowCheck } from '../server/services/werkstatt/health.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { selfTest } from '../server/services/werkstatt/logic.js';
import { parseManifest } from '../server/services/werkstatt/manifest.js';

/**
 * The safety net around the Werkstatt: the model gate ("Mindest-Modell"), model and Denkstufe on builds and versions,
 * the second opinion of another top model, signed bundles, the Pro switch, health monitoring and one-click rollback.
 */

describe('model gate (pure)', () => {
  const g = DEFAULT_GATE;
  it('lets the four families through – also behind an OpenRouter vendor prefix, in any case', () => {
    for (const m of ['gpt-6-sol', 'openai/gpt-6-sol', 'GPT-6.1-SOL-pro', 'astra-1', 'vendor/Astra-Max', 'claude-opus-5-5', 'anthropic/claude-opus-5.5', 'claude-opus-5-5-20260101', 'claude-fable-5-5', 'anthropic/claude-fable-5.5'])
      expect(checkModel(m, g), m).toMatchObject({ ok: true });
    expect(checkModel('anthropic/claude-opus-5.5', g).matched).toBe('Claude Opus 5.5');
  });

  it('refuses everyday and older models', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-opus-4-20250514', 'gpt-5-mini', 'gpt-6-mini', 'gpt-4.1', 'llama-3.3-70b-versatile', 'anthropic/claude-3-opus', ''])
      expect(checkModel(m, g).ok, m).toBe(false);
  });

  it('"newer versions of these families" can be switched off', () => {
    for (const m of ['gpt-7-sol', 'openai/gpt-7.2-sol', 'claude-opus-5-6', 'claude-opus-6', 'anthropic/claude-fable-6', 'claude-fable-5-7']) {
      expect(checkModel(m, g), m).toMatchObject({ ok: true });
      expect(checkModel(m, { ...g, newer: false }).ok, `${m} without newer`).toBe(false);
    }
    expect(checkModel('claude-opus-5-6', g).matched).toContain('neuere Version');
    // Astra matches every version by its pattern, with or without the toggle
    expect(checkModel('astra-9', { ...g, newer: false }).ok).toBe(true);
  });

  it('families can be switched off one by one, patterns added, the whole gate disabled', () => {
    expect(checkModel('astra-1', { ...g, families: ['opus-5-5'] }).ok).toBe(false);
    expect(checkModel('claude-opus-5-5', { ...g, families: ['opus-5-5'] }).ok).toBe(true);
    expect(checkModel('my-company/best-model-2', g).ok).toBe(false);
    expect(checkModel('my-company/best-model-2', { ...g, extra: ['*best-model*'] })).toMatchObject({ ok: true, matched: '*best-model*' });
    expect(checkModel('claude-sonnet-5-5', { ...g, enabled: false }).ok).toBe(true);
    expect(matchesGlob('Anthropic/Claude-Opus-5.5', '*OPUS-5-5*')).toBe(true);
    expect(matchesGlob('claude-opus-5-5', 'gpt-6*sol*')).toBe(false);
  });

  it('custom patterns are validated (no blanket "*", no odd characters)', () => {
    const fail = (m: string) => new Error(m);
    expect(cleanPatterns([' *Mein-Modell* ', 'x/y-123', ''], fail)).toEqual(['*mein-modell*', 'x/y-123']);
    expect(() => cleanPatterns(['*'], fail)).toThrow('zu allgemein');
    expect(() => cleanPatterns(['a*'], fail)).toThrow('zu allgemein');
    expect(() => cleanPatterns(['rm -rf /'], fail)).toThrow('Ungültiges Muster');
    expect(() => cleanPatterns('nope', fail)).toThrow('Liste');
    expect(loadGate({ enabled: false, families: ['astra', 'gibts-nicht'], extra: ['*ok-muster*', 'böse muster'] })).toMatchObject({ enabled: false, families: ['astra'], extra: ['*ok-muster*'], newer: true, stage1_normal: true });
  });

  it('says in German what to do, and where', () => {
    const m = gateMessage('claude-sonnet-5-5', true);
    expect(m).toContain(`Für die Werkstatt brauchst du ein Spitzenmodell (z. B. ${GATE_EXAMPLES})`);
    expect(m).toContain('„claude-sonnet-5-5“');
    expect(m).toContain(GATE_LINK);
    expect(gateMessage('x', false)).toContain('Bitte einen Admin');
    expect(GATE_EXAMPLES).toBe('GPT-6 Sol, Astra, Claude Opus 5.5 oder Fable 5.5');
  });

  it('knows which purposes need the top model: code and reviews always, planning only when Stufe 1 may not use the normal one', () => {
    for (const p of ['werkstatt_build', 'werkstatt_spec', 'werkstatt_review', 'werkstatt_review2']) expect(needsTopModel(p, g)).toBe(true);
    expect(needsTopModel('werkstatt_plan', g)).toBe(false);
    expect(needsTopModel('werkstatt_plan', { ...g, stage1_normal: false })).toBe(true);
    expect(needsTopModel('suggest', g)).toBe(false);
    expect(needsTopModel('werkstatt_build', { ...g, enabled: false })).toBe(false);
  });
});

describe('what changed between two versions (pure)', () => {
  const v = (version: string, patch: Record<string, any> = {}) => ({ version, manifest: { ...EXAMPLES['deal-ampel'].manifest, version, ...(patch.manifest ?? {}) }, ui_html: patch.ui_html ?? '<div>a</div>\n<script>x()</script>', server_js: patch.server_js ?? '', steps: patch.steps ?? null });
  it('counts added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd\ne')).toEqual({ added: 2, removed: 1 });
    expect(lineDiff('', '')).toEqual({ added: 0, removed: 0 });
  });
  it('names permissions, entries and code changes in plain German', () => {
    const d = diffVersions(v('1.0.0'), v('1.0.1', { ui_html: '<div>a</div>\n<script>x()</script>\n<p>neu</p>', manifest: { scopes: [...EXAMPLES['deal-ampel'].manifest.scopes, 'contacts:read'] } }));
    expect(d).toMatchObject({ from: '1.0.0', to: '1.0.1', scopes_added: ['contacts:read'], ui: { added: 1, removed: 0 } });
    expect(d.summary.join(' ')).toContain('Neue Berechtigung: contacts:read');
    expect(d.summary.join(' ')).toContain('Oberfläche: 1 Zeilen neu');
    expect(diffVersions(v('1.0.0'), v('1.0.1')).summary).toEqual(['Keine inhaltliche Änderung gegenüber der Vorversion.']);
  });
});

describe('signed bundles (pure)', () => {
  const bundle = () => ({ format: 'gohigh-plugin', bundle_version: 1, exported_at: 'x', plugin: { name: 'P' }, version: { version: '1.0.0', ui_html: '<div></div>' }, integrity: 'abc' });
  it('verifies against trusted keys, ignores exported_at, detects every change', () => {
    const kp = generateKeyPair();
    const trusted = [{ id: 'acme', label: 'Acme', public_key: kp.public_key }];
    const signed = signBundle(bundle(), kp.private_key, 'acme');
    expect(checkSignature(signed, trusted)).toMatchObject({ state: 'signed', key_id: 'acme', label: 'Acme', warning: '' });
    expect(checkSignature({ ...signed, exported_at: 'another day' }, trusted).state).toBe('signed');
    expect(checkSignature({ ...signed, version: { ...signed.version, ui_html: '<script>evil()</script>' } }, trusted).state).toBe('invalid');
    expect(checkSignature({ ...signed, plugin: { name: 'Q' } }, trusted).state).toBe('invalid');
    expect(checkSignature(signed, [{ id: 'acme', label: 'Acme', public_key: generateKeyPair().public_key }]).state).toBe('invalid');
    // a key we do not know cannot be checked: ungeprüft, not forged
    const u = checkSignature(signed, []);
    expect(u).toMatchObject({ state: 'untrusted', key_id: 'acme' });
    expect(u.warning).toContain('Ungeprüft');
    const none = checkSignature(bundle(), trusted);
    expect(none).toMatchObject({ state: 'unsigned', gohigh: false });
    expect(none.warning).toContain('Ungeprüft');
    expect(checkSignature({ ...bundle(), signature: { alg: 'rsa', key_id: 'acme', sig: 'x' } }, trusted).state).toBe('invalid');
    expect(() => signBundle(bundle(), 'kein schluessel', 'x')).toThrow();
  });
});

// --- the app ----------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let admin: Call;
let member: Call;
let other: Call;
let aiCalls: { purpose: string; effort?: string }[] = [];
let plan: (input: any) => any = () => stage1Plan(` ${++seq}`);
let seq = 0;
let build: (input: any) => any = () => pluginAnswer('deal-ampel');
const models: Record<string, string> = {};
let review = () => ({ verdict: 'pass', summary: 'Unbedenklich.', checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: true, note: 'Geprüft.' })) });
const effortFor = (purpose: string) => (/review|build|plan|spec/.test(purpose) ? { requested: 'xhigh', applied: 'high', sent: true, note: 'xhigh → high, vom Modell nicht unterstützt' } : undefined);
const idle = async () => void (await t.app.services.werkstatt.idle());
const accept = (b: any) => ({ accept_scopes: b.plan.scopes.map((s: any) => s.key), accept_areas: b.plan.areas });
const policy = (p: Record<string, unknown>) => admin('PUT', '/api/werkstatt/policy', p);
const assistantModel = (loc: string, model: string) => admin('PUT', '/api/ai/settings', { model }, { 'x-location-id': loc });
const login = async (email: string, loc: string) => {
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'passwort-1x' })).status).toBe(200);
  return c;
};
const planned = async (c: Call, text = 'Ich möchte meine Deals als Ampel sehen und Rückrufe verwalten.') => {
  const r = await c('POST', '/api/werkstatt/builds', { text });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await idle();
  return (await c('GET', `/api/werkstatt/builds/${r.data.id}`)).data;
};
/** A finished Mini-App for `c`: plan → confirm → build. */
const miniApp = async (c: Call, key = 'deal-ampel') => {
  plan = () => stage2Plan(key);
  build = () => pluginAnswer(key);
  const b = await planned(c);
  expect(b.status, b.error).toBe('planned');
  expect((await c('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b))).status).toBe(200);
  await idle();
  const done = (await c('GET', `/api/werkstatt/builds/${b.id}`)).data;
  expect(done.status, done.error).toBe('done');
  return done;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  admin = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await admin('POST', '/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  for (const [email, loc] of [['m1@example.com', A], ['n1@example.com', B]] as const) expect((await admin('POST', '/api/users', { email, name: email.split('@')[0], password: 'passwort-1x', role: 'member', locations: [loc], permissions: null })).status).toBe(200);
  member = await login('m1@example.com', A);
  other = await login('n1@example.com', B);
  expect((await policy({ who: 'everyone', approval: false, budget_usd: 100 })).status).toBe(200);
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async (input: any) => {
    aiCalls.push({ purpose: input.purpose });
    const body = input.purpose === 'werkstatt_plan' ? plan(input) : input.purpose === 'werkstatt_review' || input.purpose === 'werkstatt_review2' ? review() : input.purpose === 'werkstatt_spec' ? { title: 'Spec', spec_markdown: '## Ziel' } : build(input);
    // The real aiRun reports the model that served it; the scripted one reads it from the routing (the gate looks at the same).
    const model = models[input.purpose] ?? (t.app.services.aiProvider?.(input.locationId, input.purpose)?.model as string) ?? 'claude-opus-5-5';
    return { text: JSON.stringify(body), model, stopReason: 'end_turn', usage, ms: 5, effort: effortFor(input.purpose) };
  };
}, 60_000);
afterAll(() => t.close());

describe('the model gate in the Werkstatt', () => {
  it('everyday model: the status screen says so in German with a link – and Stufe 1 still works', async () => {
    const me = (await member('GET', '/api/werkstatt/me')).data;
    expect(me.model_gate).toMatchObject({ enabled: true, ok: false, model: 'claude-sonnet-5-5', link: GATE_LINK, stage1_normal: true });
    expect(me.model_gate.message).toContain('Für die Werkstatt brauchst du ein Spitzenmodell (z. B. GPT-6 Sol, Astra, Claude Opus 5.5 oder Fable 5.5)');
    expect(me.model_gate.message).toContain('Bitte einen Admin');
    expect((await admin('GET', '/api/werkstatt/me')).data.model_gate.message).toContain('Wähle unter Einstellungen');
    expect(me.model_gate.families.map((f: any) => f.label)).toEqual(['GPT-6 Sol', 'Astra', 'Claude Opus 5.5', 'Claude Fable 5.5']);
    plan = () => stage1Plan(` ${++seq}`);
    const b = await planned(member);
    expect(b).toMatchObject({ stage: 1, status: 'planned' });
    expect(b.plan.model_gate).toEqual({ ok: true });
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b))).status).toBe(200);
    await idle();
    expect((await member('GET', `/api/werkstatt/builds/${b.id}`)).data.status).toBe('done');
  });

  it('a Mini-App plan is shown with the refusal, confirming is refused, nothing is written; a new plan works once a top model is set', async () => {
    plan = () => stage2Plan('deal-ampel');
    const b = await planned(member);
    expect(b).toMatchObject({ stage: 2, status: 'planned' });
    expect(b.plan.model_gate.ok).toBe(false);
    expect(b.plan.model_gate.message).toContain('Spitzenmodell');
    expect(b.plan.notes.join(' ')).toContain('Spitzenmodell');
    const c = await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    expect(c.status).toBe(409);
    expect(c.data.error).toContain('Für die Werkstatt brauchst du ein Spitzenmodell');
    expect(c.data.error).toContain(GATE_LINK);
    expect(aiCalls.some((x) => x.purpose === 'werkstatt_build')).toBe(false);
    // the admin connects Opus 5.5 – the same wish is planned again with one click
    expect((await assistantModel(A, 'claude-opus-5-5')).status).toBe(200);
    const again = await member('POST', `/api/werkstatt/builds/${b.id}/replan`, {});
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(again.data.id).not.toBe(b.id);
    await idle();
    expect((await member('GET', `/api/werkstatt/builds/${b.id}`)).data.status).toBe('cancelled');
    const b2 = (await member('GET', `/api/werkstatt/builds/${again.data.id}`)).data;
    expect(b2.plan.model_gate).toEqual({ ok: true });
    expect(b2.plan.ai).toMatchObject({ model: 'claude-opus-5-5', effort: { requested: 'xhigh', applied: 'xhigh' } });
    expect((await member('GET', '/api/werkstatt/me')).data.model_gate).toMatchObject({ ok: true, matched: 'Claude Opus 5.5' });
  });

  it('only the owner replans, and only a finished plan', async () => {
    const b = await planned(member);
    expect((await other('POST', `/api/werkstatt/builds/${b.id}/replan`, {})).status).toBe(404);
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/cancel`, {})).status).toBe(200);
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/replan`, {})).status).toBe(400);
  });

  it('without "Stufe 1 darf das normale Modell" even planning needs a top model; the dry run and the smoke status say so', async () => {
    expect((await assistantModel(B, 'claude-sonnet-5-5')).status).toBe(200);
    expect((await policy({ model_gate: { stage1_normal: false } })).data.policy.model_gate.stage1_normal).toBe(false);
    const r = await other('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas Neues haben.' });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('Spitzenmodell');
    const dry = (await other('POST', '/api/werkstatt/dry-run', { text: 'Ich möchte etwas Neues haben.' })).data;
    expect(dry.ok).toBe(false);
    expect(dry.problems.join(' ')).toContain('Spitzenmodell');
    expect(dry.model_gate).toMatchObject({ ok: false, model: 'claude-sonnet-5-5', plan_ok: false });
    // the sub-account with Opus is unaffected
    expect((await member('POST', '/api/werkstatt/dry-run', { text: 'Ich möchte etwas Neues haben.' })).data.ok).toBe(true);
    await policy({ model_gate: { stage1_normal: true } });
    const dry2 = (await other('POST', '/api/werkstatt/dry-run', { text: 'Ich möchte etwas Neues haben.' })).data;
    expect(dry2.ok).toBe(true);
    expect(dry2.warnings.join(' ')).toContain('Spitzenmodell');
  });

  it('the build itself checks the model again – a switch between plan and build cannot sneak a weak model in', async () => {
    const b = await planned(member);
    expect((await assistantModel(A, 'claude-sonnet-5-5')).status).toBe(200);
    const c = await member('POST', `/api/werkstatt/builds/${b.id}/confirm`, accept(b));
    expect(c.status).toBe(409);
    expect((await member('POST', `/api/werkstatt/builds/${b.id}/cancel`, {})).status).toBe(200);
    // changes ("Ändern lassen") need it before the order is even created
    expect((await assistantModel(A, 'claude-opus-5-5')).status).toBe(200);
    const done = await miniApp(member);
    expect((await assistantModel(A, 'claude-sonnet-5-5')).status).toBe(200);
    const ch = await member('POST', `/api/werkstatt/plugins/${done.plugin_id}/change`, { feedback: 'Bitte die Farben ändern.' });
    expect(ch.status).toBe(409);
    expect(ch.data.error).toContain('Spitzenmodell');
    expect((await assistantModel(A, 'claude-opus-5-5')).status).toBe(200);
  });

  it('review and core proposals are gated like building', async () => {
    const done = await miniApp(member);
    expect((await assistantModel(A, 'claude-sonnet-5-5')).status).toBe(200);
    const r = await admin('POST', `/api/marktplatz/${done.plugin_id}/security-review`, {});
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('Spitzenmodell');
    const spec = await admin('POST', `/api/werkstatt/plugins/${done.plugin_id}/core-proposal`, {});
    expect(spec.status).toBe(409);
    expect(spec.data.error).toContain('Spitzenmodell');
    expect((await assistantModel(A, 'claude-opus-5-5')).status).toBe(200);
  });

  it('admins add patterns, switch families or the whole gate – validated, admin only', async () => {
    expect((await member('PUT', '/api/werkstatt/policy', { model_gate: { enabled: false } })).status).toBe(403);
    expect((await policy({ model_gate: { extra: ['*'] } })).status).toBe(400);
    expect((await policy({ model_gate: { families: ['gibts-nicht'] } })).status).toBe(400);
    expect((await policy({ model_gate: { families: 'astra' } })).status).toBe(400);
    expect((await assistantModel(A, 'claude-sonnet-5-5')).status).toBe(200);
    expect((await policy({ model_gate: { extra: ['*sonnet-5-5*'] } })).data.policy.model_gate.extra).toEqual(['*sonnet-5-5*']);
    expect((await member('GET', '/api/werkstatt/me')).data.model_gate).toMatchObject({ ok: true, matched: '*sonnet-5-5*' });
    await policy({ model_gate: { extra: [], enabled: false } });
    expect((await member('GET', '/api/werkstatt/me')).data.model_gate).toMatchObject({ enabled: false, ok: true });
    await policy({ model_gate: { enabled: true, families: ['opus-5-5'] } });
    expect((await member('GET', '/api/werkstatt/me')).data.model_gate.families.filter((f: any) => f.on).map((f: any) => f.id)).toEqual(['opus-5-5']);
    await policy({ model_gate: { families: ['gpt-6-sol', 'astra', 'opus-5-5', 'fable-5-5'] } });
    expect((await assistantModel(A, 'claude-opus-5-5')).status).toBe(200);
  });

  it('a routing "Werkstatt" in KI-Anbieter decides the model – a GPT-6 Sol behind OpenRouter passes, the assistant\'s own model is no longer asked', async () => {
    expect((await assistantModel(A, 'claude-sonnet-5-5')).status).toBe(200);
    const c = await admin('POST', '/api/ai-connections', { scope: 'agency', provider: 'openrouter', label: 'OpenRouter', api_key: 'sk-or-v1-testkey-abcdef123456', models: { text: 'openai/gpt-6-sol' } });
    expect(c.status, c.text).toBe(200);
    expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt', connection_id: c.data.id })).status).toBe(200);
    const me = (await member('GET', '/api/werkstatt/me')).data;
    expect(me.model_gate).toMatchObject({ ok: true, model: 'openai/gpt-6-sol', matched: 'GPT-6 Sol' });
    expect(me.ai.model).toBe('openai/gpt-6-sol');
    // the same routing with a weaker model is refused again
    expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt', connection_id: c.data.id, model: 'meta-llama/llama-3.3-70b-instruct' })).status).toBe(200);
    expect((await member('GET', '/api/werkstatt/me')).data.model_gate).toMatchObject({ ok: false, model: 'meta-llama/llama-3.3-70b-instruct' });
    expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt', connection_id: c.data.id, model: '' })).status).toBe(200);
    await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt', connection_id: '' });
    await admin('DELETE', `/api/ai-connections/${c.data.id}`);
    expect((await assistantModel(A, 'claude-opus-5-5')).status).toBe(200);
  });
});

describe('model and Denkstufe on every build and version', () => {
  it('are recorded on the build (with one log line), on the version and shown as badges', async () => {
    aiCalls = [];
    const done = await miniApp(member);
    expect(done.ai).toMatchObject({ model: 'claude-opus-5-5', requested: 'xhigh', applied: 'high', label: 'hoch', note: 'xhigh → high, vom Modell nicht unterstützt' });
    const texts = done.log.map((l: any) => l.text).join('\n');
    expect(texts).toContain('KI: claude-opus-5-5 · Denkstufe hoch (xhigh → high, vom Modell nicht unterstützt)');
    const p = (await member('GET', `/api/plugins/${done.plugin_id}`)).data;
    const v = p.versions[0];
    expect(v.badges).toMatchObject({ static: true, tests: true, model: 'claude-opus-5-5', effort: 'hoch', effort_note: 'xhigh → high, vom Modell nicht unterstützt', review: null, second_opinion: null, signature: null });
    expect(v.badges.tests_detail).toContain('Handler');
  });
});

describe('the second opinion (Pro): another top model, independently, before the Marktplatz', () => {
  let pluginId = '';
  let conn = '';
  it('the publish dialog says what is missing; without a second model there is a hint, not a block', async () => {
    pluginId = (await miniApp(member)).plugin_id;
    const rev = await admin('POST', `/api/marktplatz/${pluginId}/security-review`, {});
    expect(rev.status, JSON.stringify(rev.data)).toBe(200);
    expect(rev.data).toMatchObject({ kind: 'review', verdict: 'pass', model: 'claude-opus-5-5' });
    expect(rev.data.effort).toMatchObject({ applied: 'high', label: 'hoch' });
    const chk = (await admin('GET', `/api/marktplatz/${pluginId}/publish-check`)).data;
    expect(chk.review.verdict).toBe('pass');
    expect(chk.second_opinion).toBeNull();
    expect(chk.second_state).toMatchObject({ pro: true, available: false, required: false, done: false });
    expect(chk.second_state.reason).toContain('Zweitmeinung');
    expect((await admin('POST', `/api/marktplatz/${pluginId}/second-opinion`, {})).status).toBe(409);
    // publishing is not blocked by a missing second model
    const pub = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true });
    expect(pub.status, JSON.stringify(pub.data)).toBe(200);
    await admin('POST', `/api/marktplatz/${pluginId}/unpublish`, {});
  });

  it('it must be a different model than the one that wrote the code', async () => {
    const c = await admin('POST', '/api/ai-connections', { scope: 'agency', provider: 'openrouter', label: 'OpenRouter', api_key: 'sk-or-v1-testkey-abcdef123456', models: { text: 'anthropic/claude-opus-5.5' } });
    conn = c.data.id;
    // routed to the very model that built the plugin (claude-opus-5-5 == anthropic/claude-opus-5.5)
    expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt_review', connection_id: conn })).status).toBe(200);
    const chk = (await admin('GET', `/api/marktplatz/${pluginId}/publish-check`)).data;
    expect(chk.second_state).toMatchObject({ available: false, required: true });
    expect(chk.second_state.reason).toContain('anderes Modell');
    expect((await admin('POST', `/api/marktplatz/${pluginId}/second-opinion`, {})).status).toBe(409);
  });

  it('with GPT-6 Sol as second reviewer it runs, shows both verdicts and what differs, and publishing then waits for it', async () => {
    expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt_review', connection_id: conn, model: 'openai/gpt-6-sol' })).status).toBe(200);
    const rev = await admin('POST', `/api/marktplatz/${pluginId}/security-review`, {});
    const needs = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true });
    expect(needs.status).toBe(409);
    expect(needs.data.error).toContain('Zweitmeinung');
    review = () => ({ verdict: 'warn', summary: 'Eine Berechtigung ist breit.', checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: id !== 'scopes-minimal', note: id === 'scopes-minimal' ? 'Mehr als nötig.' : 'ok.' })) });
    models.werkstatt_review2 = 'openai/gpt-6-sol';
    const r = await admin('POST', `/api/marktplatz/${pluginId}/second-opinion`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.second_opinion).toMatchObject({ kind: 'second_opinion', verdict: 'warn', model: 'openai/gpt-6-sol' });
    expect(r.data.review.verdict).toBe('pass');
    expect(r.data.comparison).toEqual({ agree: false, differing: ['scopes-minimal'] });
    expect(r.data.second_state).toMatchObject({ done: true, model: 'openai/gpt-6-sol' });
    // warnings of the second opinion need the same explicit OK
    expect((await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true })).status).toBe(400);
    const pub = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true, accept_warnings: true });
    expect(pub.status, JSON.stringify(pub.data)).toBe(200);
    const v = (await admin('GET', `/api/plugins/${pluginId}`)).data.versions[0];
    expect(v.badges).toMatchObject({ review: { verdict: 'pass', model: 'claude-opus-5-5' }, second_opinion: { verdict: 'warn', model: 'openai/gpt-6-sol' } });
    await admin('POST', `/api/marktplatz/${pluginId}/unpublish`, {});
  });

  it('a second opinion that fails blocks publishing until a better one exists; the policy can drop the requirement', async () => {
    review = () => ({ verdict: 'fail', summary: 'Nicht veröffentlichen.', checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: id !== 'no-exfiltration', note: 'x' })) });
    expect((await admin('POST', `/api/marktplatz/${pluginId}/second-opinion`, {})).status).toBe(200);
    review = () => ({ verdict: 'pass', summary: 'Unbedenklich.', checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: true, note: 'Geprüft.' })) });
    const rev = await admin('POST', `/api/marktplatz/${pluginId}/security-review`, {});
    const blocked = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true, accept_warnings: true });
    expect(blocked.status).toBe(409);
    expect(blocked.data.error).toContain('Zweitmeinung ist durchgefallen');
    // the policy only decides whether a missing second opinion blocks – a failed one always does
    await policy({ second_opinion: false });
    expect((await admin('GET', `/api/marktplatz/${pluginId}/publish-check`)).data.second_state.required).toBe(false);
    expect((await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true, accept_warnings: true })).status).toBe(409);
    await policy({ second_opinion: true });
    // a new second opinion (passing) replaces it
    expect((await admin('POST', `/api/marktplatz/${pluginId}/second-opinion`, {})).status).toBe(200);
    const ok = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    await admin('POST', `/api/marktplatz/${pluginId}/unpublish`, {});
  });

  it('is a Pro feature: without a license there is a plain message', async () => {
    t.app.services.license = { has: () => false };
    const r = await admin('POST', `/api/marktplatz/${pluginId}/second-opinion`, {});
    expect(r.status).toBe(403);
    expect(r.data.error).toContain('Pro-Funktion');
    const chk = (await admin('GET', `/api/marktplatz/${pluginId}/publish-check`)).data;
    expect(chk.second_state).toMatchObject({ pro: false, available: false, required: false });
    expect(chk.license.pro).toBe(false);
    t.app.services.license = { has: () => true, stub: true };
    await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt_review', connection_id: '' });
    delete models.werkstatt_review2;
  });
});

describe('Pro: the Marktplatz, signed plugins and the advanced rollout – the stub unlocks everything', () => {
  afterEach(() => {
    t.app.services.license = { has: () => true, stub: true };
  });
  it('a license stub exists and says yes; the status screens show it', async () => {
    expect(t.app.services.license.has('pro')).toBe(true);
    const r = (await admin('GET', '/api/marktplatz')).data;
    expect(r.license).toMatchObject({ pro: true, stub: true });
    expect(r.license.features.map((f: any) => f.id)).toEqual(['marktplatz', 'signed', 'second_opinion', 'rollout']);
  });

  it('without a license: publishing, installing and the percent rollout are refused with a clear message; building, private use and agency-wide stay free', async () => {
    const done = await miniApp(member);
    const pluginId = done.plugin_id as string;
    const rev = await admin('POST', `/api/marktplatz/${pluginId}/security-review`, {});
    expect(rev.status).toBe(200);
    t.app.services.license = { has: () => false };
    const pub = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true, accept_warnings: true });
    expect(pub.status).toBe(403);
    expect(pub.data.error).toContain('Pro-Funktion');
    expect(pub.data.error).toContain('ohne Lizenz');
    // agency-wide rollout and the plugin itself work without a license
    expect((await admin('POST', `/api/plugins/${pluginId}/scope`, { scope: 'agency' })).status).toBe(200);
    expect((await member('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(pluginId);
    expect((await admin('POST', `/api/plugins/${pluginId}/scope`, { scope: 'private' })).status).toBe(200);
    // flags: private/location/all are free, the percentage is Pro
    await admin('POST', '/api/flags', { name: 'core.pro-test', stage: 'private' });
    expect((await admin('PUT', '/api/flags/core.pro-test', { stage: 'location' })).status).toBe(200);
    const p = await admin('PUT', '/api/flags/core.pro-test', { stage: 'percent', percent: 20 });
    expect(p.status).toBe(403);
    expect(p.data.error).toContain('Pro-Funktion');
    expect((await admin('PUT', '/api/flags/core.pro-test', { stage: 'all' })).status).toBe(200);
    t.app.services.license = { has: () => true, stub: true };
    expect((await admin('PUT', '/api/flags/core.pro-test', { stage: 'percent', percent: 20 })).status).toBe(200);
    // install from the Marktplatz is Pro too
    const pub2 = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true, accept_warnings: true });
    expect(pub2.status, JSON.stringify(pub2.data)).toBe(200);
    t.app.services.license = { has: () => false };
    const inst = await other('POST', `/api/marktplatz/${pluginId}/install`, { consent: ['opportunities:read'] });
    expect(inst.status).toBe(403);
    expect(inst.data.error).toContain('Pro-Funktion');
    // browsing stays possible
    expect((await other('GET', '/api/marktplatz')).status).toBe(200);
    t.app.services.license = { has: () => true, stub: true };
    expect((await other('POST', `/api/marktplatz/${pluginId}/install`, { consent: ['opportunities:read'] })).status).toBe(200);
    await admin('POST', `/api/marktplatz/${pluginId}/unpublish`, {});
  });
});

describe('signed bundles: HyperLevel-signed = installable with Pro, everything else is "ungeprüft"', () => {
  let bundle: any;
  let kp = generateKeyPair();
  let before = 0;
  it('an unsigned bundle needs the importer\'s explicit OK and shows the warning', async () => {
    before = GOHIGH_PUBLIC_KEYS.length;
    const done = await miniApp(member);
    const ex = await member('GET', `/api/plugins/${done.plugin_id}/export`);
    bundle = JSON.parse(ex.text);
    expect(bundle.signature).toBeUndefined();
    const pre = (await other('POST', '/api/plugins/import/preview', { bundle })).data;
    expect(pre.signature).toMatchObject({ state: 'unsigned', gohigh: false });
    expect(pre.signature.warning).toContain('Ungeprüft');
    const no = await other('POST', '/api/plugins/import', { bundle, consent: ['opportunities:read'] });
    expect(no.status).toBe(400);
    expect(no.data.error).toContain('Ungeprüft');
    expect(no.data.error).toContain('accept_unverified');
    const yes = await other('POST', '/api/plugins/import', { bundle, consent: ['opportunities:read'], accept_unverified: true });
    expect(yes.status, JSON.stringify(yes.data)).toBe(200);
    expect(yes.data.signature.state).toBe('unsigned');
    const vs = (await other('GET', `/api/plugins/${yes.data.id}`)).data.versions;
    expect(vs[0].badges.signature).toMatchObject({ state: 'unsigned' });
  });

  it('a signature by a key this installation does not know is "ungeprüft", not trusted', async () => {
    kp = generateKeyPair();
    const signed = signBundle(bundle, kp.private_key, 'acme-2026');
    const pre = (await other('POST', '/api/plugins/import/preview', { bundle: signed })).data;
    expect(pre.signature).toMatchObject({ state: 'untrusted', key_id: 'acme-2026' });
    expect((await other('POST', '/api/plugins/import', { bundle: signed, consent: ['opportunities:read'] })).status).toBe(400);
  });

  it('keys are added by an admin (validated); a signed bundle then installs – Pro only', async () => {
    expect((await member('PUT', '/api/werkstatt/policy', { trusted_keys: [{ id: 'acme-2026', public_key: kp.public_key }] })).status).toBe(403);
    expect((await policy({ trusted_keys: [{ id: 'acme-2026', public_key: 'kein-schluessel' }] })).status).toBe(400);
    expect((await policy({ trusted_keys: [{ id: 'X', public_key: kp.public_key }] })).status).toBe(400);
    expect((await policy({ trusted_keys: [{ id: 'acme-2026', public_key: kp.public_key }, { id: 'acme-2026', public_key: kp.public_key }] })).status).toBe(400);
    expect((await policy({ trusted_keys: [{ id: 'acme-2026', label: 'Acme GmbH', public_key: kp.public_key }] })).data.policy.trusted_keys).toHaveLength(1);
    const signed = signBundle(bundle, kp.private_key, 'acme-2026');
    const pre = (await other('POST', '/api/plugins/import/preview', { bundle: signed })).data;
    expect(pre.signature).toMatchObject({ state: 'signed', label: 'Acme GmbH', gohigh: false, warning: '' });
    t.app.services.license = { has: () => false };
    const noPro = await other('POST', '/api/plugins/import', { bundle: signed, consent: ['opportunities:read'] });
    expect(noPro.status).toBe(403);
    expect(noPro.data.error).toContain('Pro-Funktion');
    expect((await other('POST', '/api/plugins/import/preview', { bundle: signed })).data.pro_required).toBe(true);
    // an unsigned import stays possible without a license
    expect((await other('POST', '/api/plugins/import', { bundle, consent: ['opportunities:read'], accept_unverified: true })).status).toBe(200);
    t.app.services.license = { has: () => true, stub: true };
    const ok = await other('POST', '/api/plugins/import', { bundle: signed, consent: ['opportunities:read'] });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.signature).toMatchObject({ state: 'signed', key_id: 'acme-2026' });
    expect((await other('GET', `/api/plugins/${ok.data.id}`)).data.versions[0].badges.signature).toMatchObject({ state: 'signed', label: 'Acme GmbH' });
  });

  it('a bundle that was changed after signing is refused – with no way around it', async () => {
    const signed = signBundle(bundle, kp.private_key, 'acme-2026');
    const evil = JSON.parse(JSON.stringify(signed));
    evil.version.ui_html += '\n<!-- manipuliert -->';
    const pre = (await other('POST', '/api/plugins/import/preview', { bundle: evil })).data;
    expect(pre.signature.state).toBe('invalid');
    const r = await other('POST', '/api/plugins/import', { bundle: evil, consent: ['opportunities:read'], accept_unverified: true });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('verändert');
  });

  it('the built-in HyperLevel keys win: "von HyperLevel signiert" – nobody can claim the id through the settings', async () => {
    const gh = generateKeyPair();
    GOHIGH_PUBLIC_KEYS.push({ id: 'gohigh-test', label: 'HyperLevel', public_key: gh.public_key, gohigh: true });
    try {
      const signed = signBundle(bundle, gh.private_key, 'gohigh-test');
      expect((await other('POST', '/api/plugins/import/preview', { bundle: signed })).data.signature).toMatchObject({ state: 'signed', gohigh: true, label: 'HyperLevel' });
      // an admin registers a different key under the same id: the built-in one stays
      const mine = generateKeyPair();
      await policy({ trusted_keys: [{ id: 'gohigh-test', public_key: mine.public_key }] });
      const fake = signBundle(bundle, mine.private_key, 'gohigh-test');
      expect((await other('POST', '/api/plugins/import/preview', { bundle: fake })).data.signature.state).toBe('invalid');
    } finally {
      GOHIGH_PUBLIC_KEYS.length = before;
      await policy({ trusted_keys: [] });
    }
  });
});

describe('health monitoring, auto-disable and one-click rollback', () => {
  let pluginId = '';
  let pushes: any[] = [];
  it('a slow plugin is switched off, the admins and the author are told (app, push, email) – with a rollback action', async () => {
    t.app.services.pushNotify = async (n: any) => void pushes.push(n);
    const feed: any[] = [];
    const realFeed = t.app.services.mobileFeed;
    t.app.services.mobileFeed = (e: any) => (feed.push(e), realFeed ? realFeed(e) : 0);
    const mails: any[] = [];
    t.app.services.feedbackMailer = async (_l: unknown, m: any) => (mails.push(m), { status: 'sent' });
    pluginId = (await miniApp(member)).plugin_id;
    slowCheck.ms = 0;
    await policy({ kill: { errors: 10, window_min: 10, ratio: 0.5, latency_ms: 300, min_calls: 4 } });
    for (let i = 0; i < 3; i++) recordEvent(t.app, pluginId, A, 'call', 'contacts.list', 900);
    expect((await member('GET', `/api/plugins/${pluginId}`)).data.status).toBe('active');
    recordEvent(t.app, pluginId, A, 'call', 'contacts.list', 900);
    const p = (await member('GET', `/api/plugins/${pluginId}`)).data;
    expect(p.status).toBe('killed');
    expect(p.killed_reason).toContain('Zu langsam');
    expect(p.killed_reason).toContain('900 ms');
    await idle();
    await new Promise((r) => setTimeout(r, 50));
    const note = t.app.db.all<any>(`SELECT n.kind, n.title, n.url, n.user_id, u.role FROM werkstatt_notices n JOIN users u ON u.id = n.user_id WHERE n.kind = 'alarm'`);
    expect(note.map((n) => n.role).sort()).toEqual(['admin', 'member']);
    expect(note[0].title).toContain('wurde abgeschaltet');
    expect(note[0].url).toContain(`/app/werkstatt/plugins/${pluginId}`);
    const push = pushes.find((x) => String(x.title).includes('abgeschaltet'));
    expect(push?.actions?.[0]).toMatchObject({ action: 'rollback', title: 'Zurückrollen' });
    expect(push.actions[0].url).toContain('action=rollback');
    // the phone app's local notifications get the same note (type "werkstatt", only for the person it is meant for)
    expect(feed.filter((e) => String(e.title).includes('abgeschaltet')).map((e) => e.userId).sort()).toEqual(note.map((n) => n.user_id).sort());
    expect(feed.every((e) => e.locationId && e.userId && /^werkstatt:/.test(e.ref))).toBe(true);
    expect(mails.some((m) => String(m.subject).includes('abgeschaltet') && String(m.text).includes('Zurückrollen'))).toBe(true);
    // the health numbers show it
    expect((await member('GET', `/api/plugins/${pluginId}`)).data.health).toMatchObject({ killed: true, avg_ms_24h: 900 });
    await policy({ kill: { errors: 10, window_min: 10, ratio: 0.5, latency_ms: 8000, min_calls: 10 } });
  });

  it('one click goes back to the version before – installs, the killed state and the old errors are cleaned up', async () => {
    // no older version yet
    expect((await member('POST', `/api/plugins/${pluginId}/rollback`, {})).status).toBe(400);
    // a second version through "Ändern lassen"
    build = () => pluginAnswer('deal-ampel', { ui_html: EXAMPLES['deal-ampel'].ui_html + '\n<!-- v2 -->\n<p class="muted">Neue Zeile</p>' });
    const ch = await member('POST', `/api/werkstatt/plugins/${pluginId}/change`, { feedback: 'Bitte eine Zeile ergänzen.' });
    // the plugin is killed: the change is refused until it runs again
    expect(ch.status).toBe(400);
    await admin('POST', `/api/plugins/${pluginId}/revive`, {});
    const ch2 = await member('POST', `/api/werkstatt/plugins/${pluginId}/change`, { feedback: 'Bitte eine Zeile ergänzen.' });
    expect(ch2.status, JSON.stringify(ch2.data)).toBe(200);
    await idle();
    const b = (await member('GET', `/api/werkstatt/builds/${ch2.data.id}`)).data;
    expect(b.status, b.error).toBe('done');
    // the diff summary is on the build and the version
    expect(b.plan.diff).toMatchObject({ from: '1.0.0', to: '1.0.1' });
    expect(b.plan.diff.summary.join(' ')).toContain('Oberfläche');
    expect(b.log.map((l: any) => l.text).join('\n')).toContain('Änderung: Oberfläche');
    let p = (await member('GET', `/api/plugins/${pluginId}`)).data;
    expect(p.version).toBe('1.0.1');
    expect(p.versions[0].diff.summary.join(' ')).toContain('Oberfläche');
    expect(p.versions[0].badges).toMatchObject({ model: 'claude-opus-5-5', effort: 'hoch' });
    // the new version is bad: it is killed again, a member of nobody else may roll back, the author may
    await admin('POST', `/api/plugins/${pluginId}/kill`, { reason: 'Test' });
    expect((await other('POST', `/api/plugins/${pluginId}/rollback`, {})).status).toBe(404);
    const r = await member('POST', `/api/plugins/${pluginId}/rollback`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ from: '1.0.1', to: '1.0.0', revived: true, unpublished: false });
    p = (await member('GET', `/api/plugins/${pluginId}`)).data;
    expect(p).toMatchObject({ version: '1.0.0', status: 'active' });
    expect(p.versions.find((v: any) => v.version === '1.0.0').active).toBe(true);
    expect(p.versions.map((v: any) => v.version)).toContain('1.0.1'); // the bad version stays, it can be activated again
    expect((await member('GET', '/api/plugins/active')).data.map((x: any) => x.id)).toContain(pluginId);
    // a named version works too
    const v2 = p.versions.find((v: any) => v.version === '1.0.1');
    expect((await member('POST', `/api/plugins/${pluginId}/rollback`, { version_id: v2.id })).data).toMatchObject({ from: '1.0.0', to: '1.0.1' });
    expect((await member('POST', `/api/plugins/${pluginId}/rollback`, { version_id: 'gibts-nicht' })).status).toBe(400);
  });

  it('a version of the Marktplatz that is rolled back takes the installs with it; an unreviewed older one unpublishes the listing', async () => {
    const id = (await miniApp(member)).plugin_id as string;
    const rev1 = await admin('POST', `/api/marktplatz/${id}/security-review`, {});
    await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: rev1.data.id, approve: true, accept_warnings: true });
    build = () => pluginAnswer('deal-ampel', { ui_html: EXAMPLES['deal-ampel'].ui_html + '\n<!-- v2 -->' });
    const ch = await member('POST', `/api/werkstatt/plugins/${id}/change`, { feedback: 'Bitte etwas ändern.' });
    expect(ch.status, JSON.stringify(ch.data)).toBe(200);
    await idle();
    // a published plugin does not switch by itself: its author activates the new version, then it is reviewed
    const v2 = (await admin('GET', `/api/plugins/${id}`)).data.versions.find((v: any) => v.version === '1.0.1');
    expect((await admin('POST', `/api/plugins/${id}/versions/${v2.id}/activate`, {})).status).toBe(200);
    const rev2 = await admin('POST', `/api/marktplatz/${id}/security-review`, {});
    await admin('POST', `/api/marktplatz/${id}/publish`, { review_id: rev2.data.id, approve: true, accept_warnings: true });
    expect((await other('POST', `/api/marktplatz/${id}/install`, { consent: ['opportunities:read'] })).status).toBe(200);
    const r = await admin('POST', `/api/plugins/${id}/rollback`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // version 1.0.0 had been reviewed and published before: the listing offers it again
    expect(r.data).toMatchObject({ from: '1.0.1', to: '1.0.0', unpublished: false });
    const card = (await other('GET', `/api/marktplatz/${id}`)).data;
    expect(card.version).toBe('1.0.0');
    expect(card.installed).toBe(true);
    expect(card.update_available).toBe(false);
    await admin('POST', `/api/marktplatz/${id}/unpublish`, {});
  });
});

describe('automatic smoke tests: one run per entry point', () => {
  const base = () => EXAMPLES['deal-ampel'].manifest;
  const manifest = (panels: unknown[]) => {
    const m = parseManifest({ ...base(), entries: { ...base().entries, panels } });
    if (!m.ok) throw new Error(m.errors.join(' '));
    return m.manifest;
  };
  it('a panel that crashes fails the test even though the page works – and the result names the entry points', async () => {
    const ui = `<div id="x"></div><script>gohigh.ready(async function (ctx) { if (ctx.entry.kind === 'panel') throw new Error('Panel kaputt'); document.getElementById('x').textContent = ctx.entry.kind; });</script>`;
    const r = await selfTest(t.app, { manifest: manifest([{ id: 'p1', on: 'contact', title: 'Kontakt-Panel', height: 200 }]), ui_html: ui, server_js: '', steps: null }, A);
    expect(r.entries!.map((e) => `${e.kind}:${e.id}:${e.ok}`)).toEqual(['page:main:true', 'panel:p1:false', `widget:${base().entries.widgets![0].id}:true`]);
    expect(r.issues.map((i) => i.message).join(' ')).toContain('Panel „p1“');
    expect(r.issues.map((i) => i.message).join(' ')).not.toContain('Seite');
  });

  it('a clean plugin passes on every entry point and the badge says how many', async () => {
    const ui = `<div></div><script>gohigh.ready(function (ctx) { gohigh.toast(ctx.entry.kind); });</script>`;
    const r = await selfTest(t.app, { manifest: manifest([{ id: 'p1', on: 'deal', title: 'Deal-Panel', height: 200 }]), ui_html: ui, server_js: '', steps: null }, A);
    expect(r.ok).toBe(true);
    expect(r.entries!.every((e) => e.ok)).toBe(true);
    expect(r.entries).toHaveLength(3);
  });
});

describe('scripts/werkstatt-sign.mjs (for publishers of plugin catalogues)', () => {
  const run = (...a: string[]) => spawnSync(process.execPath, ['scripts/werkstatt-sign.mjs', ...a], { cwd: process.cwd(), encoding: 'utf8' });
  it('makes a key pair, signs a bundle that the app accepts, and verifies – a changed bundle fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-sign-'));
    const k = run('keygen', '--id', 'acme-1', '--out', dir);
    expect(k.status, k.stderr).toBe(0);
    expect(k.stdout).toContain('geheim halten');
    expect(run('keygen', '--id', 'acme-1', '--out', dir).status).toBe(1); // never overwrites a private key
    const pub = readFileSync(join(dir, 'acme-1.public.txt'), 'utf8').trim();
    expect(readFileSync(join(dir, 'acme-1.private.pem'), 'utf8')).toContain('PRIVATE KEY');
    const bundle = { format: 'gohigh-plugin', bundle_version: 1, exported_at: 'heute', plugin: { name: 'P' }, version: { version: '1.0.0', ui_html: '<div></div>' }, integrity: 'abc' };
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify(bundle));
    const s = run('sign', file, '--key', join(dir, 'acme-1.private.pem'), '--id', 'acme-1', '--out', join(dir, 'p.signed.json'));
    expect(s.status, s.stderr).toBe(0);
    const signed = JSON.parse(readFileSync(join(dir, 'p.signed.json'), 'utf8'));
    // the app's own check accepts what the script signed
    expect(checkSignature(signed, [{ id: 'acme-1', label: 'Acme', public_key: pub }]).state).toBe('signed');
    const ok = run('verify', join(dir, 'p.signed.json'), '--public', pub, '--id', 'acme-1');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Signatur in Ordnung');
    // changed after signing
    signed.version.ui_html = '<script>evil()</script>';
    writeFileSync(join(dir, 'evil.json'), JSON.stringify(signed));
    const bad = run('verify', join(dir, 'evil.json'), '--public', pub);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('NICHT');
    expect(checkSignature(signed, [{ id: 'acme-1', label: 'Acme', public_key: pub }]).state).toBe('invalid');
    // not signed at all, wrong key id, no arguments
    expect(run('verify', file, '--public', pub).stderr).toContain('nicht signiert');
    expect(run('verify', join(dir, 'p.signed.json'), '--public', pub, '--id', 'anders').stderr).toContain('nicht mit');
    expect(run('sign', file).status).toBe(1);
    expect(run().status).toBe(0);
  });
});
