import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { pluginAnswer, stage2Plan } from './werkstatt-fakes.js';
import { REVIEW_CHECKS } from '../server/services/werkstatt/generate.js';

/**
 * The whole life of a wish, as a member lives it – through the real aiRun / aiConnections path with a mocked
 * OpenAI-compatible provider (OpenRouter): wish → "Bauen lassen" → plan with cost → confirmation → approval
 * (in-app + push + email to the admin) → build → private plugin → test and rate → "Ändern lassen" → publish
 * to the Marktplatz → install in a second sub-account → "Als Kernfeature vorschlagen" → GitHub issue.
 * No network, no keys.
 */

type Kind = 'plan' | 'build' | 'review' | 'spec';
let t: Awaited<ReturnType<typeof startTestApp>>;
let A = ''; // agency's own sub-account
let B = ''; // Mia's sub-account
let C = ''; // another customer
let admin: Call;
let mia: Call;
let lena: Call; // also a member of B, not allowed to build
let carla: Call; // team member of C
let miaId = '';
let lenaId = '';

const sent: { url: string; kind: Kind; body: any; auth: string }[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
let handler: (kind: Kind, body: any) => string | Promise<string> = () => '{}';

const fenced = (o: unknown) => `Hier ist mein Vorschlag:\n\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\`\n\nSag Bescheid, wenn ich etwas ändern soll.`;
const okReview = () => ({ verdict: 'pass', summary: 'Das Plugin liest nur Deals und zeigt sie an. Keine Auffälligkeiten.', checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: true, note: 'Geprüft, unauffällig.' })) });
const defaults = (kind: Kind) =>
  kind === 'plan' ? fenced(stage2Plan('deal-ampel')) : kind === 'build' ? fenced(pluginAnswer('deal-ampel')) : kind === 'review' ? JSON.stringify(okReview()) : JSON.stringify({ title: 'Deal-Ampel im Kern', spec_markdown: '## Ziel\nDie Deal-Ampel gehört fest ins Dashboard.\n\n## Umsetzung\nEigenes Modul, Feature-Flag, Tests.' });
const reset = () => {
  sent.length = 0;
  handler = defaults;
};

const login = async (email: string, loc: string) => {
  const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await c('POST', '/api/auth/login', { email, password: 'passwort-1x' })).status).toBe(200);
  return c;
};
const idle = async () => void (await t.app.services.werkstatt.idle());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const consent = (b: any) => ({ accept_scopes: b.plan.scopes.map((s: any) => s.key), accept_areas: b.plan.areas });
const buildOf = async (c: Call, id: string) => (await c('GET', `/api/werkstatt/builds/${id}`)).data;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Mias Praxis' })).data.id;
  C = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
  admin = client(t.base, { 'x-pghl': '1', 'x-location-id': A });
  expect((await admin('POST', '/api/auth/login', { email: 'chef@example.com', password: 'geheim123' })).status).toBe(200);
  const mk = async (email: string, name: string, loc: string) => {
    const r = await admin('POST', '/api/users', { email, name, password: 'passwort-1x', role: 'member', locations: [loc], permissions: null });
    expect(r.status, r.text).toBe(200);
    return r.data.id as string;
  };
  miaId = await mk('mia@example.com', 'Mia Beispiel', B);
  lenaId = await mk('lena@example.com', 'Lena Beispiel', B);
  await mk('carla@example.com', 'Carla Beispiel', C);
  mia = await login('mia@example.com', B);
  lena = await login('lena@example.com', B);
  carla = await login('carla@example.com', C);
  // The provider: OpenRouter's Chat Completions, answering from a script. Which call is it? The system prompt tells.
  t.app.services.aiConnectionsFetch = (async (url: string, init: any = {}) => {
    const body = JSON.parse(init.body);
    const sys = String(body.messages?.[0]?.content ?? '');
    const kind: Kind = sys.includes('Bau-Assistent') ? 'plan' : sys.includes('Sicherheitsprüfer') ? 'review' : sys.includes('Coding-Agent-Team') ? 'spec' : 'build';
    sent.push({ url: String(url), kind, body, auth: String(new Headers(init.headers).get('authorization') ?? '') });
    const text = await handler(kind, body);
    return new Response(JSON.stringify({ id: `gen-${sent.length}`, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 6200, completion_tokens: 2400 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  t.app.services.feedbackMailer = async (_loc: unknown, mail: any) => {
    mails.push({ to: mail.to, subject: mail.subject, text: mail.text });
    return { status: 'sent' };
  };
  reset();
}, 60_000);
afterAll(() => t.close());

let wishId = '';
let planId = '';
let pluginId = '';

describe('safe defaults and clear errors before anything is set up', () => {
  it('a member cannot build by default and is told why', async () => {
    const me = (await mia('GET', '/api/werkstatt/me')).data;
    expect(me).toMatchObject({ can_build: false, who: 'admins' });
    expect(me.reason).toContain('Admins');
    const r = await mia('POST', '/api/werkstatt/builds', { text: 'Ich möchte meine Deals als Ampel sehen.' });
    expect(r.status).toBe(403);
    expect((await mia('GET', '/api/werkstatt/policy')).status).toBe(403);
  });

  it('the admin allows exactly one person – nobody else gains anything', async () => {
    const r = await admin('PUT', '/api/werkstatt/policy', { allow_users: [miaId, 'gibt-es-nicht'], approval: true, budget_usd: 5, repair_rounds: 1 });
    expect(r.status, r.text).toBe(200);
    expect(r.data.policy).toMatchObject({ who: 'admins', allow_users: [miaId], approval: true, budget_usd: 5, repair_rounds: 1, allow_locations: [] });
    expect((await mia('GET', '/api/werkstatt/me')).data.can_build).toBe(true);
    expect((await lena('GET', '/api/werkstatt/me')).data.can_build).toBe(false);
    expect((await lena('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas Neues haben.' })).status).toBe(403);
    expect((await admin('PUT', '/api/werkstatt/policy', { allow_users: 'mia' })).status).toBe(400);
    expect((await admin('PUT', '/api/werkstatt/policy', { repair_rounds: 99 })).data.policy.repair_rounds).toBe(4);
    await admin('PUT', '/api/werkstatt/policy', { repair_rounds: 1 });
    // The policy form lists the people and sub-accounts to choose from.
    const form = (await admin('GET', '/api/werkstatt/policy')).data;
    expect(form.users.map((u: any) => u.email)).toEqual(expect.arrayContaining(['mia@example.com', 'lena@example.com']));
  });

  it('without an AI connection the member sees a readable reason and how to fix it – and nothing starts', async () => {
    const me = (await mia('GET', '/api/werkstatt/me')).data;
    expect(me.ai_problem).toBeTruthy();
    expect(me.ai_hint).toContain('KI-Anbieter');
    const r = await mia('POST', '/api/werkstatt/builds', { text: 'Ich möchte meine Deals als Ampel sehen.' });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('KI');
    expect(sent).toHaveLength(0);
  });

  it('the admin connects OpenRouter once for everyone and switches the assistant on in the sub-accounts', async () => {
    const c = await admin('POST', '/api/ai-connections', { scope: 'agency', provider: 'openrouter', label: 'OpenRouter', api_key: 'sk-or-v1-testkey-abcdef123456', models: { text: 'anthropic/claude-opus-5.5' } });
    expect(c.status, c.text).toBe(200);
    expect((await admin('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'text', connection_id: c.data.id })).status).toBe(200);
    for (const loc of [A, B, C]) expect((await admin('PUT', '/api/ai/settings', { enabled: true }, { 'x-location-id': loc })).status).toBe(200);
    const me = (await mia('GET', '/api/werkstatt/me')).data;
    expect(me.ai_problem).toBeNull();
    expect(me.ai).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-opus-5.5' });
    expect(me.needs_approval).toBe(true);
  });

  it('the dry run checks policy, AI, budget and estimates – and asks the model nothing', async () => {
    const r = await mia('POST', '/api/werkstatt/dry-run', { text: 'Ich möchte meine Deals als Ampel sehen.' });
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ ok: true, problems: [], policy: { allowed: true, needs_approval: true }, ai: { ready: true, provider: 'openrouter' } });
    expect(r.data.estimate.build.typical_usd).toBeGreaterThanOrEqual(0);
    expect(r.data.prompt.approx_tokens).toBeGreaterThan(500);
    expect(JSON.stringify(r.data)).not.toContain('sk-or-v1');
    expect(sent).toHaveLength(0);
    expect((await lena('POST', '/api/werkstatt/dry-run', {})).data).toMatchObject({ ok: false, policy: { allowed: false } });
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM werkstatt_builds')!.n).toBe(0);
  });
});

describe('the member flow: wish → plan → approval → private plugin', () => {
  it('Mia submits a wish', async () => {
    const r = await mia('POST', '/api/feedback/reports', { category: 'wish', title: 'Deals als Ampel', what: 'Ich möchte auf einen Blick sehen, welche Deals länger nicht angefasst wurden – grün, gelb, rot.', area: 'CRM' });
    expect(r.status, r.text).toBe(200);
    wishId = r.data.id;
    expect(wishId).toBeTruthy();
  });

  it('"Bauen lassen" shows progress while the AI works, repairs an unusable answer and ends with a plan and its cost', async () => {
    let gate: () => void = () => {};
    const wait = new Promise<void>((r) => (gate = r));
    let n = 0;
    handler = async (kind) => {
      if (kind !== 'plan') return defaults(kind);
      await wait;
      // The first answer is prose without the structure – the second one is right.
      return ++n === 1 ? 'Gern! Ich würde dafür ein kleines Plugin bauen, das die Deals farbig anzeigt.' : fenced(stage2Plan('deal-ampel'));
    };
    const r = await mia('POST', '/api/werkstatt/builds', { wish_id: wishId });
    expect(r.status, r.text).toBe(200);
    planId = r.data.id;
    expect(r.data.status).toBe('planning');
    // live: the build says what it is doing
    let seen = '';
    for (let i = 0; i < 40 && !seen; i++) {
      seen = (await buildOf(mia, planId)).progress?.label ?? '';
      if (!seen) await sleep(25);
    }
    expect(seen).toContain('analysiert');
    gate();
    await idle();
    const b = await buildOf(mia, planId);
    expect(b.status, b.error).toBe('planned');
    expect(b.stage).toBe(2);
    expect(b.plan.estimate.typical_usd).toBeGreaterThan(0);
    expect(b.plan.scopes.map((s: any) => s.key)).toEqual(['opportunities:read']);
    expect(b.cost_usd).toBeGreaterThanOrEqual(0);
    expect(b.progress).toEqual({});
    const texts = b.log.map((l: any) => `${l.level}: ${l.text}`).join('\n');
    expect(texts).toContain('unbrauchbar');
    expect(texts).toContain('Versuch 2 von 2');
    expect(texts).toContain('Plan: Mini-App');
    // through the OpenAI-compatible wire, with the key the admin entered, for the wish's text
    expect(sent.map((s) => s.kind)).toEqual(['plan', 'plan']);
    expect(sent[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0].auth).toBe('Bearer sk-or-v1-testkey-abcdef123456');
    expect(sent[0].body.model).toBe('anthropic/claude-opus-5.5');
    expect(JSON.stringify(sent[0].body.messages)).toContain('Deals als Ampel');
    expect(JSON.stringify(sent[1].body.messages)).toContain('Dein letzter Plan war ungültig');
  });

  it('an unusable structure beyond the repair rounds ends with a readable error – and the log stays', async () => {
    reset();
    handler = (kind) => (kind === 'plan' ? 'Ich kann das leider nur als Fließtext beschreiben.' : defaults(kind));
    const r = await mia('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas, das kein Modell versteht.' });
    expect(r.status).toBe(200);
    await idle();
    const b = await buildOf(mia, r.data.id);
    expect(b.status).toBe('failed');
    expect(b.error).toContain('2 Versuchen');
    expect(b.error).toContain('keinen brauchbaren Plan');
    expect(b.log.length).toBeGreaterThanOrEqual(3);
    expect(b.log.at(-1).level).toBe('error');
    // the failure is also an in-app note for Mia
    const notes = (await mia('GET', '/api/werkstatt/notices')).data.notices;
    expect(notes.some((n: any) => n.kind === 'failed' && n.url.includes(r.data.id))).toBe(true);
    reset();
  });

  it('confirming sends the order to approval: the member sees "Wartet auf Freigabe", the admin is told by app, push and email', async () => {
    const b0 = await buildOf(mia, planId);
    // consent must equal the plan's list
    expect((await mia('POST', `/api/werkstatt/builds/${planId}/confirm`, { accept_scopes: [], accept_areas: [] })).status).toBe(400);
    mails.length = 0;
    const r = await mia('POST', `/api/werkstatt/builds/${planId}/confirm`, consent(b0));
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ status: 'awaiting_approval', status_label: 'Wartet auf Freigabe' });
    await idle();
    // in the app
    const adminNotes = (await admin('GET', '/api/werkstatt/notices')).data;
    const note = adminNotes.notices.find((n: any) => n.kind === 'approval');
    expect(adminNotes.unread).toBeGreaterThan(0);
    expect(note.title).toContain('Freigabe nötig');
    expect(note.body).toContain('Mia Beispiel');
    expect(note.url).toContain(`/app/werkstatt/${planId}`);
    expect(note.url).toContain(`loc=${B}`);
    expect((await admin('GET', '/api/werkstatt/me')).data.pending_approvals).toBe(1);
    // push (the log row is written per user, subscriptions or not)
    const push = t.app.db.get('SELECT * FROM push_log WHERE kind = ? AND title LIKE ?', 'werkstatt', '%Freigabe nötig%');
    expect(push).toBeTruthy();
    // email with deep links for approve and decline (they open the order, they never decide by themselves)
    const mail = mails.find((m) => m.to === 'chef@example.com');
    expect(mail, JSON.stringify(mails)).toBeTruthy();
    expect(mail!.subject).toContain('Freigabe nötig');
    expect(mail!.text).toContain(`/app/werkstatt/${planId}?loc=${B}&action=approve`);
    expect(mail!.text).toContain(`/app/werkstatt/${planId}?loc=${B}&action=reject`);
    expect(mail!.text).toContain('erst dort bestätigst du');
    expect(mails.some((m) => m.to === 'mia@example.com')).toBe(false);
    // nobody can approve their own order, others do not even see it
    expect((await mia('POST', `/api/werkstatt/builds/${planId}/approve`, {})).status).toBe(403);
    expect((await lena('GET', `/api/werkstatt/builds/${planId}`)).status).toBe(404);
    expect((await carla('GET', `/api/werkstatt/builds/${planId}`)).status).toBe(404);
    expect(sent.filter((s) => s.kind === 'build')).toHaveLength(0);
  });

  it('the admin approves: it builds through the same AI path and Mia gets a private plugin – only for him', async () => {
    mails.length = 0;
    const r = await admin('POST', `/api/werkstatt/builds/${planId}/approve`, { note: 'Sieht gut aus.' });
    expect(r.status, r.text).toBe(200);
    await idle();
    const b = await buildOf(mia, planId);
    expect(b.status, `${b.error}\n${JSON.stringify(b.log)}`).toBe('done');
    expect(b.approval).toMatchObject({ by: 'Chef', note: 'Sieht gut aus.' });
    pluginId = b.plugin_id;
    expect(pluginId).toBeTruthy();
    expect(b.log.map((l: any) => l.text).join('\n')).toContain('privat, nur in diesem Sub-Account');
    expect(sent.filter((s) => s.kind === 'build').length).toBeGreaterThanOrEqual(1);
    // Mia is told by mail and in the app
    expect(mails.some((m) => m.to === 'mia@example.com' && m.subject.includes('Freigegeben'))).toBe(true);
    expect((await mia('GET', '/api/werkstatt/notices')).data.notices.some((n: any) => n.title.includes('ist fertig'))).toBe(true);
    // private: Mia sees and runs it; Lena (same sub-account), Carla (another one) do not
    const mine = (await mia('GET', '/api/plugins')).data.plugins.find((p: any) => p.id === pluginId);
    expect(mine).toMatchObject({ scope: 'private', status: 'active', active_here: true, enabled_here: true, mine: true });
    expect((await mia('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(pluginId);
    expect((await lena('GET', '/api/plugins')).data.plugins.map((p: any) => p.id)).not.toContain(pluginId);
    expect((await lena('GET', '/api/plugins/active')).data.map((p: any) => p.id)).not.toContain(pluginId);
    expect((await carla('GET', '/api/plugins')).data.plugins.map((p: any) => p.id)).not.toContain(pluginId);
    expect((await lena('GET', `/api/plugins/${pluginId}`)).status).toBe(404);
    // its page runs for Mia in the isolated host page
    const host = await mia('GET', `/plugin-host/${pluginId}?entry=page`);
    expect(host.status).toBe(200);
    expect(host.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await lena('GET', `/plugin-host/${pluginId}?entry=page`)).text).toContain('nicht aktiv');
  });

  it('Mia tests the plugin and rates it – the admin sees the rating before publishing', async () => {
    const r = await mia('PUT', `/api/marktplatz/${pluginId}/reviews`, { rating: 4, body: 'Genau, was ich wollte – die gelben Deals könnten früher auffallen.' });
    expect(r.status, r.text).toBe(200);
    expect((await lena('PUT', `/api/marktplatz/${pluginId}/reviews`, { rating: 5 })).status).toBe(404);
    const detail = (await admin('GET', `/api/plugins/${pluginId}`)).data;
    expect(detail.health).toMatchObject({ rating: 4, reviews: 1 });
    expect(detail.wish).toMatchObject({ id: wishId });
  });

  it('"Ändern lassen" makes a new version after approval; the old one stays and can be restored', async () => {
    reset();
    const changed = pluginAnswer('deal-ampel');
    changed.ui_html = changed.ui_html.replace('</body>', '<!-- v2: gelb ab 7 Tagen --></body>');
    changed.changelog = 'Gelb schon ab 7 Tagen.';
    handler = (kind) => (kind === 'build' ? fenced(changed) : defaults(kind));
    const est = (await mia('GET', '/api/werkstatt/estimate?kind=change')).data;
    expect(est.typical_usd).toBeGreaterThanOrEqual(0);
    const r = await mia('POST', `/api/werkstatt/plugins/${pluginId}/change`, { feedback: 'Bitte schon ab 7 Tagen gelb anzeigen.' });
    expect(r.status, r.text).toBe(200);
    expect(r.data.status).toBe('awaiting_approval');
    const a = await admin('POST', `/api/werkstatt/builds/${r.data.id}/approve`, {});
    expect(a.status, a.text).toBe(200);
    await idle();
    const b = await buildOf(mia, r.data.id);
    expect(b.status, `${b.error}\n${JSON.stringify(b.log)}`).toBe('done');
    const d = (await mia('GET', `/api/plugins/${pluginId}`)).data;
    expect(d.versions).toHaveLength(2);
    expect(d.versions.find((v: any) => v.active).changelog).toContain('Gelb');
    expect(d.version).toBe(d.versions.find((v: any) => v.active).version);
    // rollback to the first version
    const first = d.versions.find((v: any) => !v.active);
    expect((await mia('POST', `/api/plugins/${pluginId}/versions/${first.id}/activate`, { consent: first.scopes })).status).toBe(200);
    expect((await mia('GET', `/api/plugins/${pluginId}`)).data.versions.find((v: any) => v.active).id).toBe(first.id);
    // and forward again: the newest version is the one the Marktplatz gets
    const latest = d.versions.find((v: any) => v.active);
    expect((await mia('POST', `/api/plugins/${pluginId}/versions/${latest.id}/activate`, { consent: latest.scopes })).status).toBe(200);
    reset();
  });
});

describe('publishing and installing in another sub-account', () => {
  it('only an admin publishes – after the AI security review and their own approval', async () => {
    expect((await mia('POST', `/api/marktplatz/${pluginId}/security-review`, {})).status).toBe(403);
    const rev = await admin('POST', `/api/marktplatz/${pluginId}/security-review`, {});
    expect(rev.status, rev.text).toBe(200);
    expect(rev.data.verdict).toBe('pass');
    expect(rev.data.checks).toHaveLength(REVIEW_CHECKS.length);
    expect((await mia('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true })).status).toBe(403);
    expect((await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id })).status).toBe(400);
    const pub = await admin('POST', `/api/marktplatz/${pluginId}/publish`, { review_id: rev.data.id, approve: true });
    expect(pub.status, pub.text).toBe(200);
    expect(sent.some((s) => s.kind === 'review')).toBe(true);
  });

  it('a team member of another sub-account finds it, sees the consent list and installs it for her sub-account', async () => {
    const list = (await carla('GET', '/api/marktplatz')).data;
    const card = list.plugins.find((p: any) => p.id === pluginId);
    expect(card).toMatchObject({ installed: false, name: expect.any(String) });
    expect(card.scopes.map((s: any) => s.key)).toEqual(['opportunities:read']);
    expect((await carla('POST', `/api/marktplatz/${pluginId}/install`, { scope: 'location', consent: [] })).status).toBe(400);
    const r = await carla('POST', `/api/marktplatz/${pluginId}/install`, { scope: 'location', consent: ['opportunities:read'] });
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ installed: true, installed_scope: 'location' });
    expect((await carla('GET', '/api/plugins/active')).data.map((p: any) => p.id)).toContain(pluginId);
    // Mia's builds and notes stay his
    expect((await carla('GET', '/api/werkstatt/builds')).data).toEqual([]);
    expect((await lena('GET', '/api/plugins/active')).data.map((p: any) => p.id)).not.toContain(pluginId);
    // she rates it; the Marktplatz shows both ratings and two installs
    expect((await carla('PUT', `/api/marktplatz/${pluginId}/reviews`, { rating: 5, body: 'Läuft.' })).status).toBe(200);
    const card2 = (await carla('GET', '/api/marktplatz')).data.plugins.find((p: any) => p.id === pluginId);
    expect(card2).toMatchObject({ rating: 4.5, reviews: 2, installs: 2 });
  });
});

describe('Stufe 3: "Als Kernfeature vorschlagen" opens a GitHub issue', () => {
  const issues: { url: string; body: any }[] = [];
  let proposalId = '';

  it('without a GitHub token the dialog says what to do instead of failing – the spec is kept', async () => {
    const hint = (await admin('GET', '/api/werkstatt/core/github')).data;
    expect(hint.ready).toBe(false);
    expect(hint.hint).toContain('Token');
    expect((await mia('GET', '/api/werkstatt/core/github')).status).toBe(403);
    const r = await admin('POST', `/api/werkstatt/plugins/${pluginId}/core-proposal`, { target_version: '0.0.40' });
    expect(r.status, r.text).toBe(200);
    proposalId = r.data.id;
    expect(r.data).toMatchObject({ status: 'spec', issue_number: null });
    expect(r.data.issue_error).toContain('Token');
    expect(r.data.spec).toContain('Deal-Ampel');
    expect(sent.some((s) => s.kind === 'spec')).toBe(true);
    // asking for the issue again says the same
    const again = await admin('POST', `/api/werkstatt/core/${proposalId}/issue`, {});
    expect(again.data.issue_error).toContain('Token');
  });

  it('with token and repository (configurable) the issue is opened for the chosen agent and tracked', async () => {
    t.app.services.githubFetch = (async (url: string, init: any = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      issues.push({ url: String(url), body });
      return new Response(JSON.stringify({ number: 42, html_url: 'https://github.com/acme/gohigh/issues/42' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect((await admin('PUT', '/api/github-codex/settings', { token: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz' })).status).toBe(200);
    // no repository yet → a clear hint
    expect((await admin('GET', '/api/werkstatt/core/github')).data.hint).toContain('Repository');
    expect((await admin('PUT', '/api/werkstatt/policy', { core: { repo: 'acme/gohigh', agent: 'claude', location_id: A } })).status).toBe(200);
    expect((await admin('GET', '/api/werkstatt/core/github')).data.ready).toBe(true);
    const r = await admin('POST', `/api/werkstatt/core/${proposalId}/issue`, {});
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ status: 'issue_open', issue_number: 42, repo: 'acme/gohigh', agent: 'codex' });
    expect(issues).toHaveLength(1);
    expect(issues[0].url).toBe('https://api.github.com/repos/acme/gohigh/issues');
    expect(issues[0].body.title).toContain('[Kernfeature]');
    expect(issues[0].body.body).toContain('Deal-Ampel');
    expect(issues[0].body.body).toContain('2 Installationen');
    expect(issues[0].body.body).toMatch(/@codex Setze die oben beschriebene/);
    expect(issues[0].body.labels).toEqual(['kernfeature', 'plugin']);
    const list = (await admin('GET', '/api/werkstatt/core')).data;
    expect(list.proposals[0]).toMatchObject({ plugin_id: pluginId, issue_url: 'https://github.com/acme/gohigh/issues/42' });
    // when the core version ships, the installs migrate (switched off, data kept) and the plugin is "im Kern enthalten"
    const ship = await admin('POST', `/api/werkstatt/core/${proposalId}/ship`, { version: '0.0.40', action: 'migrate' });
    expect(ship.status, ship.text).toBe(200);
    expect((await carla('GET', '/api/plugins/active')).data.map((p: any) => p.id)).not.toContain(pluginId);
    expect((await admin('GET', `/api/plugins/${pluginId}`)).data).toMatchObject({ status: 'in_core', core_version: '0.0.40' });
  });
});

describe('budget and approval details', () => {
  it('an exhausted monthly budget is a readable message for the member', async () => {
    reset();
    await admin('PUT', '/api/werkstatt/policy', { budgets: { [B]: 0.01 } });
    // Mia's builds have cost 0.02 $ by now – more than this sub-account's budget of 0.01 $.
    t.app.db.run(`UPDATE werkstatt_builds SET cost_micros = 20000 WHERE id = (SELECT id FROM werkstatt_builds WHERE location_id = ? ORDER BY created_at LIMIT 1)`, B);
    const me = (await mia('GET', '/api/werkstatt/me')).data;
    expect(me.budget_problem).toContain('Monatsbudget');
    const r = await mia('POST', '/api/werkstatt/builds', { text: 'Ich möchte noch etwas Neues bauen lassen.' });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('Monatsbudget');
    expect(r.data.error).toContain('Richtlinien');
    expect((await mia('POST', '/api/werkstatt/dry-run', {})).data).toMatchObject({ ok: false });
    await admin('PUT', '/api/werkstatt/policy', { budgets: {} });
  });

  it('with approval switched off the member\'s confirmed plan builds right away', async () => {
    reset();
    await admin('PUT', '/api/werkstatt/policy', { approval: false, budget_usd: 50 });
    const r = await mia('POST', '/api/werkstatt/builds', { text: 'Ich möchte meine Deals noch einmal als Ampel sehen (zweiter Versuch).' });
    expect(r.status, r.text).toBe(200);
    await idle();
    const b = await buildOf(mia, r.data.id);
    expect(b.status, b.error).toBe('planned');
    const c = await mia('POST', `/api/werkstatt/builds/${r.data.id}/confirm`, consent(b));
    expect(c.data.status).toBe('building');
    await idle();
    expect((await buildOf(mia, r.data.id)).status).toBe('done');
    // the second plugin has its own slug; nothing of the first was touched
    expect((await mia('GET', '/api/plugins')).data.plugins.filter((p: any) => p.scope === 'private').length).toBeGreaterThanOrEqual(1);
  });

  it('declining tells the member with the reason', async () => {
    reset();
    await admin('PUT', '/api/werkstatt/policy', { approval: true });
    const r = await mia('POST', '/api/werkstatt/builds', { text: 'Ich möchte etwas, das der Admin ablehnt.' });
    await idle();
    const b = await buildOf(mia, r.data.id);
    await mia('POST', `/api/werkstatt/builds/${r.data.id}/confirm`, consent(b));
    mails.length = 0;
    const rej = await admin('POST', `/api/werkstatt/builds/${r.data.id}/reject`, { note: 'Das gibt es schon als Bericht.' });
    expect(rej.status, rej.text).toBe(200);
    await idle();
    expect(rej.data).toMatchObject({ status: 'rejected' });
    expect((await buildOf(mia, r.data.id)).error).toContain('Das gibt es schon als Bericht.');
    expect(mails.find((m) => m.to === 'mia@example.com')!.text).toContain('Das gibt es schon als Bericht.');
    expect((await mia('GET', '/api/werkstatt/notices')).data.notices.some((n: any) => n.title.includes('Abgelehnt'))).toBe(true);
    // notes can be marked as read
    await mia('POST', '/api/werkstatt/notices/read', {});
    expect((await mia('GET', '/api/werkstatt/notices')).data.unread).toBe(0);
  });
});

/** scripts/werkstatt-smoke.mjs: runs against a live instance with an agency key and must never spend. */
const smoke = (base: string, key: string, extra: string[] = []) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/werkstatt-smoke.mjs', '--base', base, '--key', key, ...extra], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });

describe('live smoke script', () => {
  it('lists policy and connections and does a dry-run plan – without asking the model or spending', async () => {
    await admin('PUT', '/api/werkstatt/policy', { approval: true, budgets: {} });
    const k = (await admin('POST', '/api/agency/api-keys', { name: 'Smoke', scope: 'read' })).data.key as string;
    const calls = sent.length;
    const billed = t.app.db.get('SELECT COUNT(*) AS n FROM ai_calls')!.n;
    const r = await smoke(t.base, k, ['--location', 'Mias Praxis', '--user', 'mia@example.com']);
    expect(r.out).toContain('Geprüft wird Sub-Account „Mias Praxis“');
    expect(r.out).toContain('Mia Beispiel (mia@example.com)');
    expect(r.out).toContain('Mia Beispiel darf bauen: ja');
    expect(r.out).toContain('OpenRouter');
    expect(r.out).toContain('KI bereit');
    expect(r.out).toContain('Trockenlauf');
    expect(r.out).toContain('Es wurde keine KI angefragt');
    // the model gate, the Denkstufe and the Pro switch are part of the report
    expect(r.out).toContain('Mindest-Modell: nur Spitzenmodelle (auch neuere Versionen)');
    expect(r.out).toContain('Modell für Mini-Apps: anthropic/claude-opus-5.5 (Claude Opus 5.5)');
    expect(r.out).toContain('Denkstufe maximal (xhigh)');
    expect(r.out).toContain('Zweitmeinung (Pro): noch kein zweites Modell eingestellt');
    expect(r.out).toContain('Pro-Funktionen');
    expect(r.out).toContain('kein Lizenzsystem eingebaut – alles an');
    expect(r.out).not.toContain('sk-or-v1');
    expect(r.code, r.out).toBe(0);
    // nothing was asked, nothing was billed, nothing was stored
    expect(sent.length).toBe(calls);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM ai_calls')!.n).toBe(billed);
    // machine-readable
    const j = await smoke(t.base, k, ['--json', '--location', 'Mias Praxis']);
    expect(JSON.parse(j.out), j.out.slice(0, 3000)).toMatchObject({ ok: true, fails: 0 });
  });

  it('exits 1 with a plain reason when the instance cannot build yet', async () => {
    const bare = await startTestApp();
    try {
      await bare.setup();
      const k = (await bare.api.post('/api/agency/api-keys', { name: 'Smoke', scope: 'read' })).data.key as string;
      const r = await smoke(bare.base, k);
      expect(r.code).toBe(1);
      expect(r.out).toContain('FAIL');
      expect(r.out).toContain('KI nicht bereit');
      const wrong = await smoke(bare.base, 'pghla_falsch');
      expect(wrong.code).toBe(1);
      expect(wrong.out).toContain('abgelehnt');
    } finally {
      await bare.close();
    }
  });
});

void lenaId;
