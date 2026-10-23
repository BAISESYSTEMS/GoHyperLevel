/**
 * Renders the screenshots of the Werkstatt "Sicherheitsnetz" and the agent chat cards (docs/assets/werkstatt-chat-*.png,
 * werkstatt-versions*.png, werkstatt-publish*.png, werkstatt-model-gate*.png, ai-effort*.png) from a freshly seeded,
 * fictional demo instance with headless Chromium. The AI is scripted (no keys, no network); the agent talks to a scripted
 * model as well – everything else is real: plan, build, sandboxed preview, review, second opinion, version diff.
 *
 *   npm run build
 *   PLAYWRIGHT_MODULE=/path/to/playwright-core PGHL_CHROMIUM=/path/to/chromium [PGHL_CHROMIUM_NO_SANDBOX=1] \
 *     node --no-warnings --import tsx scripts/werkstatt-safety-screenshots.ts [--out docs/assets]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/core/app.js';
import { loadConfig } from '../server/config.js';
import { MODULES } from '../server/modules/index.js';
import { demoCredentials } from '../server/modules/demo.js';
import { seedDemo } from '../server/services/demo-seed.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { REVIEW_CHECKS } from '../server/services/werkstatt/generate.js';
import { anthropicSse, sse } from '../tests/agent-fakes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'docs/assets'));
const port = 4890 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;

function loadPlaywright(): any {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    join(root, 'node_modules/playwright'),
    (() => {
      try {
        return join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
      } catch {
        return undefined;
      }
    })(),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return createRequire(import.meta.url)(c);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found – set PLAYWRIGHT_MODULE (e.g. a playwright-core folder).');
}

if (!existsSync(join(root, 'dist-web/index.html'))) throw new Error('Run `npm run build` first.');
const { chromium } = loadPlaywright();
const data = mkdtempSync(join(tmpdir(), 'gohigh-wk2-'));
mkdirSync(outDir, { recursive: true });

const config = { ...loadConfig({ ...process.env, PGHL_DATA_DIR: data, PORT: String(port), PGHL_TICK_MS: '0', PGHL_BACKUPS: '0', PGHL_DEMO_MODE: '0', PGHL_WEB_DIR: join(root, 'dist-web') }), host: '127.0.0.1', tickMs: 0, demoMode: false };
const instance = createApp(config, MODULES);
const { app } = instance;
installOutboundGuard();
await seedDemo(app, demoCredentials());
uninstallOutboundGuard();

// --- the scripted Werkstatt AI -------------------------------------------------------------------------------------
const usage = { input_tokens: 5200, output_tokens: 2100, cache_read_tokens: 0, cache_write_tokens: 0 };
const answer = (key: string, ui = '', changelog = 'Erste Version') => {
  const e = EXAMPLES[key];
  const m = e.manifest;
  return {
    manifest: {
      name: m.name, slug: m.slug, icon: m.icon, description: m.description, category: m.category, scopes: m.scopes,
      page_title: m.entries.page?.title ?? '',
      panels: (m.entries.panels ?? []).map((p) => ({ id: p.id, on: p.on, title: p.title, height: p.height ?? 220 })),
      widgets: (m.entries.widgets ?? []).map((w) => ({ id: w.id, title: w.title, size: w.size ?? 'm' })),
      actions: (m.entries.actions ?? []).map((a) => ({ id: a.id, label: a.label, fields: (a.fields ?? []).map((f) => ({ key: f.key, label: f.label })) })),
      jobs: (m.entries.jobs ?? []).map((j) => ({ id: j.id, label: j.label, every: j.every, at: j.at ?? '' })),
      server_mode: m.server?.mode ?? 'none',
    },
    ui_html: e.ui_html + ui, server_js: e.server_js, steps_json: e.steps ? JSON.stringify(e.steps) : '', changelog, notes: [],
  };
};
const planOf = (key: string) => ({ stage: 2, title: EXAMPLES[key].manifest.name, summary: EXAMPLES[key].manifest.description, rationale: 'Eine eigene Ansicht ist nötig, die Bausteine zeigen keine Ampel.', steps: [], manifest_json: JSON.stringify(EXAMPLES[key].manifest), notes: [] });
const okReview = (verdict = 'pass', note = 'Geprüft – unauffällig.') => ({
  verdict,
  summary: verdict === 'pass' ? 'Das Plugin liest nur die nötigen Daten und hat keinen Weg nach außen.' : 'Das Plugin ist unbedenklich, die Berechtigungen könnten aber enger sein.',
  checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: verdict === 'pass' || id !== 'scopes-minimal', note: verdict === 'pass' || id !== 'scopes-minimal' ? note : 'Mehr Rechte als der Code braucht.' })),
});
let wished = 'deal-ampel';
let ui = '';
const effort = { requested: 'xhigh', applied: 'high', sent: true, note: 'xhigh → high, vom Modell nicht unterstützt' };
app.services.aiReady = () => null;
app.services.aiRun = async (input: any) => {
  const body = input.purpose === 'werkstatt_plan' ? planOf(wished) : input.purpose === 'werkstatt_review' ? okReview() : input.purpose === 'werkstatt_review2' ? okReview('warn') : answer(wished, ui, ui ? 'Hinweiszeile ergänzt' : 'Erste Version');
  const model = input.purpose === 'werkstatt_review2' ? 'openai/gpt-6-sol' : 'claude-opus-5-5';
  return { text: JSON.stringify(body), model, stopReason: 'end_turn', usage, ms: 5, effort };
};

// --- the scripted agent model (Anthropic wire) -----------------------------------------------------------------------
const script: ((body: any) => Response)[] = [];
const say = (text: string) => ({ type: 'text' as const, text });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
app.services.agentFetch = (async (_url: string, init: any = {}) => {
  const next = script.shift();
  if (!next) return new Response(JSON.stringify({ error: { message: 'no scripted reply' } }), { status: 500, headers: { 'content-type': 'application/json' } });
  return next(init.body ? JSON.parse(init.body) : null);
}) as unknown as typeof fetch;

const server = await instance.listen();
const { email, password } = demoCredentials();
const idle = () => app.services.werkstatt.idle() as Promise<void>;

function client(loc = '') {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', ...(cookie ? { cookie } : {}), ...(loc ? { 'x-location-id': loc } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set && set.startsWith('pghl_session=')) cookie = set.split(';')[0];
    const text = await r.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* text */
    }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
    return data;
  };
  return { call };
}

try {
  const admin = client();
  await admin.call('POST', '/api/auth/login', { email, password });
  const locations: { id: string; name: string }[] = (await admin.call('GET', '/api/locations')).map((l: any) => ({ id: l.id, name: l.name }));
  const A = locations.find((l) => l.name === 'Nordlicht Digital')!.id;
  const aa = client(A);
  await aa.call('POST', '/api/auth/login', { email, password });
  for (const l of locations) await admin.call('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' }, { 'x-location-id': l.id });
  await aa.call('PUT', '/api/werkstatt/policy', { who: 'admins', approval: false, budget_usd: 50 });
  // the agent: Claude (scripted), autonomous for writes
  await aa.call('POST', '/api/ai-connections', { provider: 'anthropic', api_key: 'sk-ant-api03-demo-abcdefghijklmnopqrstuvwxyz', models: { text: 'claude-opus-5-5' } });
  await aa.call('PUT', '/api/agent/settings', { default_mode: 'auto' });
  // a second reviewer: GPT-6 Sol behind OpenRouter
  const or = await admin.call('POST', '/api/ai-connections', { scope: 'agency', provider: 'openrouter', label: 'OpenRouter', api_key: 'sk-or-v1-demo-abcdef123456', models: { text: 'openai/gpt-6-sol' } }, { 'x-location-id': A });
  await admin.call('PUT', '/api/ai-connections/routing', { scope: 'agency', usage: 'werkstatt_review', connection_id: or.id }, { 'x-location-id': A });
  await admin.call('PUT', '/api/ai-effort', { scope: 'agency', default: 'xhigh', caps: { voice: 'low', summary: 'medium' } }, { 'x-location-id': A });

  // a plugin with two versions (diff and badges), one unpublished plugin for the publish dialog
  console.log('Plugins, versions, reviews …');
  wished = 'deal-ampel';
  const ampel = await aa.call('POST', '/api/plugins/examples/deal-ampel/install', { consent: EXAMPLES['deal-ampel'].manifest.scopes });
  ui = '\n<p class="muted small">Ampel jetzt mit Hinweiszeile</p>';
  const ch = await aa.call('POST', `/api/werkstatt/plugins/${ampel.id}/change`, { feedback: 'Bitte eine Hinweiszeile unter der Ampel ergänzen.' });
  await idle();
  void ch;
  const rev = await aa.call('POST', `/api/marktplatz/${ampel.id}/security-review`, {});
  void rev;
  wished = 'geburtstags-erinnerungen';
  const bday = await aa.call('POST', '/api/plugins/examples/geburtstags-erinnerungen/install', { consent: EXAMPLES['geburtstags-erinnerungen'].manifest.scopes });

  const browser = await chromium.launch({ ...(process.env.PGHL_CHROMIUM ? { executablePath: process.env.PGHL_CHROMIUM } : {}), args: process.env.PGHL_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const session = async (scheme: 'light' | 'dark', viewport: { width: number; height: number }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    const r = await context.request.post(`${base}/api/auth/login`, { data: { email, password }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    // No first-run banners on the shots (as in scripts/shots-kit.mjs): Einfach-Modus offer answered, Academy welcome card hidden.
    await context.request.patch(`${base}/api/appearance`, { data: { goals: ['all'], goal_asked: true }, headers: { 'x-pghl': '1' } });
    await context.addInitScript(() => {
      try {
        localStorage.setItem('pghl.academyWelcome', '1');
      } catch {
        /* private mode */
      }
    });
    await context.addInitScript((loc: string) => {
      try {
        localStorage.setItem('pghl.location', loc);
      } catch {
        /* blocked */
      }
    }, A);
    const page = await context.newPage();
    page.on('pageerror', (e: Error) => console.warn('  [pageerror]', e.message.slice(0, 200)));
    page.on('console', (m: any) => m.type() === 'error' && console.warn('  [console]', m.text().slice(0, 200)));
    return { context, page };
  };
  const go = async (page: any, path: string, ready?: string, settle = 1500) => {
    await page.goto(`${base}/app/${path}${path.includes('?') ? '&' : '?'}loc=${A}`, { waitUntil: 'domcontentloaded' });
    if (ready) await page.waitForSelector(ready, { timeout: 20_000 }).catch(async () => {
      console.warn(`  (not found: ${ready} on ${page.url()})`);
      await page.screenshot({ path: join(outDir, `debug-${path.replace(/[^a-z0-9]+/gi, '-')}.png`) });
    });
    await page.waitForTimeout(settle);
  };
  const shot = (page: any, name: string, selector?: string) => (selector ? page.locator(selector).first().screenshot({ path: join(outDir, `${name}.png`) }) : page.screenshot({ path: join(outDir, `${name}.png`) }));

  console.log('Screenshots (light, dark, phone) …');
  for (const [scheme, viewport, suffix] of [['light', { width: 1440, height: 900 }, ''], ['dark', { width: 1440, height: 900 }, '-dark'], ['light', { width: 390, height: 844 }, '-phone']] as const) {
    const { context, page } = await session(scheme, viewport);
    const phone = suffix === '-phone';
    // every viewport starts with the same state: no reviews of the plugin yet
    app.db.run('DELETE FROM plugin_security_reviews WHERE plugin_id = ?', bday.id);
    // 1. versions with badges and the diff
    await go(page, `werkstatt/plugins/${ampel.id}`, '[data-tour="wk-versions"]', 2000);
    await shot(page, `werkstatt-versions${suffix}`, '[data-tour="wk-versions"]');
    // 2. the publish dialog with both reviews (second opinion = GPT-6 Sol)
    await go(page, `werkstatt/plugins/${bday.id}`, '[data-tour="wk-publish"]');
    await page.click('[data-tour="wk-publish"]');
    await page.getByRole('button', { name: /Sicherheitsprüfung starten/ }).click();
    await page.waitForSelector('[data-tour="mk-checklist"]', { timeout: 20_000 });
    await page.waitForSelector('[data-tour="mk-second-opinion"]', { timeout: 20_000 });
    await page.getByRole('button', { name: /Zweitmeinung einholen/ }).click();
    await page.waitForSelector('.wk-review-cmp', { timeout: 20_000 });
    await page.waitForTimeout(800);
    await shot(page, `werkstatt-publish${suffix}`);
    await page.keyboard.press('Escape');
    // 3. the policy with the model gate
    await go(page, 'werkstatt/policy', '[data-tour="wk-model-policy"]');
    await shot(page, `werkstatt-model-policy${suffix}`, '[data-tour="wk-model-policy"]');
    // 4. KI-Anbieter: Denkstufe
    await go(page, 'settings/ai-providers', '[data-tour="aic-effort"]');
    await shot(page, `ai-effort${suffix}`, '[data-tour="aic-effort"]');
    // 5. the model gate says no (an everyday model is connected)
    await admin.call('PUT', '/api/ai/settings', { model: 'claude-sonnet-5-5' }, { 'x-location-id': A });
    await go(page, 'werkstatt', '[data-tour="wk-model"]');
    await shot(page, `werkstatt-model-gate${suffix}`);
    await admin.call('PUT', '/api/ai/settings', { model: 'claude-opus-5-5' }, { 'x-location-id': A });
    void phone;
    await context.close();
  }

  // --- the agent chat: wish → plan card → build → preview → change → v2 -----------------------------------------------------
  console.log('Agent chat …');
  await aa.call('DELETE', `/api/plugins/${ampel.id}`); // the chat builds its own Deal-Ampel – not two of them on the dashboard
  for (const [scheme, viewport, suffix] of [['light', { width: 1440, height: 900 }, ''], ['dark', { width: 1440, height: 900 }, '-dark'], ['light', { width: 390, height: 844 }, '-phone']] as const) {
    // each run starts from a clean slate: new plugin names are not needed, the wish builds a fresh plugin every time
    wished = 'deal-ampel';
    ui = '';
    const { context, page } = await session(scheme, viewport);
    await context.addInitScript(() => {
      try {
        localStorage.setItem('pghl.agent.open', '1');
      } catch {
        /* blocked */
      }
    });
    await go(page, 'dashboard', '[data-tour="agent-panel"]', 1500);
    const ask = async (text: string) => {
      await page.locator('.agent-input-row textarea').fill(text);
      await page.keyboard.press('Enter');
    };
    // plan
    script.push(
      sse(anthropicSse([say('Das kann ich dir bauen lassen.'), tool('tu_1', 'ghl_build_from_wish', { text: 'Ich hätte gern eine Ampel, die zeigt, welche Deals lange liegen.', wait: true })])),
      sse(anthropicSse([say('Ich habe einen Plan erstellt – du siehst ihn in der Karte. Bestätige ihn dort, wenn er passt.')])),
    );
    await ask('Ich hätte gern eine Ampel, die zeigt, welche Deals lange liegen.');
    await page.waitForSelector('[data-tour="wk-plan"]', { timeout: 60_000 });
    await page.waitForTimeout(800);
    await shot(page, `werkstatt-chat-plan${suffix}`);
    // the person's click
    await page.locator('.wk-chat [data-tour="wk-consent"] input[type=checkbox], .wk-chat .wk-confirm input[type=checkbox]').first().check();
    await page.locator('.wk-chat [data-tour="wk-confirm"]').click();
    await page.waitForSelector('.wk-chat-preview iframe', { timeout: 90_000 });
    await page.waitForTimeout(3000);
    await shot(page, `werkstatt-chat-done${suffix}`);
    // a conversational change
    const pluginId = (await aa.call('GET', '/api/plugins')).plugins.find((p: any) => p.mine && p.origin === 'werkstatt')?.id;
    ui = '\n<style>.gh-card{border-width:2px}</style>\n<p class="muted small">Dunkler Rahmen, mit Hinweis.</p>';
    script.push(
      sse(anthropicSse([say('Ich passe das an.'), tool('tu_2', 'ghl_change_plugin', { plugin_id: pluginId, feedback: 'Mach die Karten kräftiger umrandet und ergänze einen Hinweis.' })])),
      sse(anthropicSse([say('Version 1.0.1 ist aktiv: kräftigere Rahmen und ein Hinweistext. Die alte Version bleibt erhalten.')])),
    );
    await ask('Mach die Karten kräftiger umrandet und ergänze einen Hinweis.');
    await page.getByRole('button', { name: /Ausführen/ }).first().click();
    await page.waitForSelector('text=Das hat sich geändert', { timeout: 120_000 });
    await page.waitForTimeout(1500);
    await shot(page, `werkstatt-chat-change${suffix}`);
    await context.close();
    // clean up: the plugin of this run goes away, so every viewport builds the same
    if (pluginId) await aa.call('DELETE', `/api/plugins/${pluginId}`);
  }
  await browser.close();
  console.log(`Done → ${outDir}`);
} finally {
  server.close();
  await instance.close();
  rmSync(data, { recursive: true, force: true });
}
