/**
 * Renders the Werkstatt/Marktplatz screenshots (docs/assets/werkstatt-*.png, marktplatz-*.png) from a freshly seeded,
 * fictional demo instance with headless Chromium. The AI is scripted (no keys, no network); everything else is real:
 * the plan, the build, the sandboxed plugin, the security review, the Marktplatz with ratings and installs.
 *
 *   npm run build                                   # the server serves the built UI
 *   PLAYWRIGHT_MODULE=/path/to/playwright-core PGHL_CHROMIUM=/path/to/chromium [PGHL_CHROMIUM_NO_SANDBOX=1] \
 *     node --no-warnings --import tsx scripts/werkstatt-screenshots.ts [--out docs/assets]
 *
 * Playwright is loaded from the project, the global npm folder or PLAYWRIGHT_MODULE. The automatic Marktplatz images
 * use the server's own opt-in feature (PGHL_PLUGIN_SCREENSHOTS, PGHL_CHROMIUM) – so this also exercises it.
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
const data = mkdtempSync(join(tmpdir(), 'gohigh-wk-'));
mkdirSync(outDir, { recursive: true });
process.env.PGHL_PLUGIN_SCREENSHOTS = '1';

// --- the app, in this process, with a scripted AI ------------------------------------------------------------------
const config = { ...loadConfig({ ...process.env, PGHL_DATA_DIR: data, PORT: String(port), PGHL_TICK_MS: '0', PGHL_BACKUPS: '0', PGHL_DEMO_MODE: '0', PGHL_WEB_DIR: join(root, 'dist-web') }), host: '127.0.0.1', tickMs: 0, demoMode: false };
const instance = createApp(config, MODULES);
const { app } = instance;
installOutboundGuard();
await seedDemo(app, demoCredentials());
uninstallOutboundGuard();

const usage = { input_tokens: 5200, output_tokens: 2100, cache_read_tokens: 0, cache_write_tokens: 0 };
const manifestOf = (key: string) => EXAMPLES[key].manifest;
const answer = (key: string) => {
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
    ui_html: e.ui_html, server_js: e.server_js, steps_json: e.steps ? JSON.stringify(e.steps) : '', changelog: 'Erste Version', notes: [],
  };
};
const stage1 = {
  stage: 1,
  title: 'Rückruf-Wünsche verwalten',
  summary: 'Ein eigenes Objekt „Rückrufe“ und eine Automation, die bei jeder Formular-Anfrage eine Aufgabe zum Zurückrufen anlegt.',
  rationale: 'Das lässt sich vollständig mit vorhandenen Bausteinen lösen – kein eigener Code nötig.',
  steps: [
    { block: 'object_type', title: 'Objekt „Rückrufe“ mit Grund und Dringlichkeit', params_json: JSON.stringify({ singular: 'Rückruf', plural: 'Rückrufe', properties: [{ key: 'grund', label: 'Grund', type: 'text' }, { key: 'dringlichkeit', label: 'Dringlichkeit', type: 'select', options: ['Normal', 'Dringend'] }] }) },
    { block: 'workflow', title: 'Automation: Aufgabe bei neuer Anfrage', params_json: JSON.stringify({ name: 'Rückruf: Aufgabe anlegen', trigger: { type: 'form.submitted', config: {} }, steps: [{ type: 'create_task', title: '{{contact.name}} zurückrufen', due_in_days: 1 }] }) },
    { block: 'tag', title: 'Tag „rückruf“', params_json: JSON.stringify({ name: 'rückruf' }) },
  ],
  manifest_json: '',
  notes: ['Die Automation wird als Entwurf angelegt – bitte prüfen und einschalten.'],
};
const okReview = {
  verdict: 'pass',
  summary: 'Das Plugin liest nur die nötigen Daten, zeigt sie lokal an und hat keinen Weg nach außen. Alle Zugriffe passen zur Beschreibung; der Selbsttest lief ohne Fehler.',
  checks: REVIEW_CHECKS.map(([id]) => ({ id, ok: true, note: 'Geprüft – unauffällig.' })),
};
app.services.aiReady = () => null;
app.services.aiRun = async (input: any) => {
  const text = String(input.user);
  const body = input.purpose === 'werkstatt_plan' ? (text.includes('Wunsch: Rückrufe') ? stage1 : { stage: 2, title: manifestOf('geburtstags-erinnerungen').name, summary: manifestOf('geburtstags-erinnerungen').description, rationale: 'Eine tägliche Prüfung und eine eigene Übersicht brauchen ein Plugin – Automationen allein zeigen keine Liste.', steps: [], manifest_json: JSON.stringify(manifestOf('geburtstags-erinnerungen')), notes: ['Das Plugin legt nur Aufgaben an – es versendet keine Nachrichten.'] }) : input.purpose === 'werkstatt_review' ? okReview : answer('geburtstags-erinnerungen');
  return { text: JSON.stringify(body), model: 'claude-sonnet-5-5', stopReason: 'end_turn', usage, ms: 5 };
};

const server = await instance.listen();
const { email, password } = demoCredentials();
const idle = () => app.services.werkstatt.idle() as Promise<void>;

// --- a small API client with its own cookie ------------------------------------------------------------------------
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
  return { call, cookie: () => cookie };
}

try {
  const admin = client();
  await admin.call('POST', '/api/auth/login', { email, password });
  const locations: { id: string; name: string }[] = (await admin.call('GET', '/api/locations')).map((l: any) => ({ id: l.id, name: l.name }));
  const loc = (name: string) => locations.find((l) => l.name === name)!.id;
  const A = loc('Nordlicht Digital');
  const aa = client(A);
  await aa.call('POST', '/api/auth/login', { email, password });
  await aa.call('PUT', '/api/werkstatt/policy', { who: 'admins', approval: true, budget_usd: 10 });

  console.log('Building plans and plugins …');
  // an order that is done (Stufe 1) and one that waits for the requester's confirmation (Stufe 2)
  const wish1 = await aa.call('POST', '/api/feedback/reports', { category: 'wish', title: 'Rückrufe verwalten', what: 'Ich möchte Rückruf-Wünsche aus dem Formular nicht verlieren – am liebsten als Liste mit Aufgabe.', area: 'CRM' });
  const b1 = await aa.call('POST', '/api/werkstatt/builds', { wish_id: wish1.id });
  await idle();
  const p1 = await aa.call('GET', `/api/werkstatt/builds/${b1.id}`);
  await aa.call('POST', `/api/werkstatt/builds/${b1.id}/confirm`, { accept_scopes: p1.plan.scopes.map((s: any) => s.key), accept_areas: p1.plan.areas });
  await idle();
  const wish2 = await aa.call('POST', '/api/feedback/reports', { category: 'wish', title: 'Geburtstage nicht vergessen', what: 'Ich möchte vor den Geburtstagen meiner Kontakte erinnert werden und sehen, wer in den nächsten Wochen Geburtstag hat.', area: 'CRM' });
  const planned = await aa.call('POST', '/api/werkstatt/builds', { wish_id: wish2.id });
  await idle();

  // examples → plugins; the three that go to the Marktplatz get reviewed and published
  const ids: Record<string, string> = {};
  for (const key of ['deal-ampel', 'geburtstags-erinnerungen', 'notizen-zusammenfassung']) {
    const p = await aa.call('POST', `/api/plugins/examples/${key}/install`, { consent: EXAMPLES[key].manifest.scopes });
    ids[key] = p.id;
  }
  console.log('Security review, publishing and preview images (headless Chromium) …');
  for (const key of Object.keys(ids)) {
    const rev = await aa.call('POST', `/api/marktplatz/${ids[key]}/security-review`, {});
    await aa.call('POST', `/api/marktplatz/${ids[key]}/publish`, { review_id: rev.id, approve: true, accept_warnings: true });
    await aa.call('POST', `/api/marktplatz/${ids[key]}/screenshots/auto`, {}).catch((e: Error) => console.warn(`  (kein automatisches Bild für ${key}: ${e.message.slice(0, 120)})`));
  }
  // customers of other sub-accounts install and rate (fictional people)
  const crowd: [string, string, string, string[], [string, number, string][]][] = [
    ['Praxis Sonnenweg', 'anna.berger@example.com', 'Anna Berger', ['deal-ampel', 'geburtstags-erinnerungen'], [['deal-ampel', 5, 'Genau der Überblick, den ich gesucht habe.'], ['geburtstags-erinnerungen', 4, 'Die Aufgaben kommen pünktlich – ich würde gern die Uhrzeit wählen.']]],
    ['FitWerk Coaching', 'tom.weiss@example.com', 'Tom Weiß', ['deal-ampel'], [['deal-ampel', 4, 'Praktisch. Gelb könnte früher anspringen.']]],
    ['Nordlicht Digital', 'lea.kraft@example.com', 'Lea Kraft', ['geburtstags-erinnerungen', 'notizen-zusammenfassung'], [['notizen-zusammenfassung', 5, 'Spart mir vor jedem Telefonat zehn Minuten.']]],
  ];
  for (const [where, mail, name, installs, reviews] of crowd) {
    await admin.call('POST', '/api/users', { email: mail, name, password: 'passwort-1x', role: 'member', locations: [loc(where)], permissions: null });
    const c = client(loc(where));
    await c.call('POST', '/api/auth/login', { email: mail, password: 'passwort-1x' });
    for (const k of installs) await c.call('POST', `/api/marktplatz/${ids[k]}/install`, { scope: 'location', consent: EXAMPLES[k].manifest.scopes });
    for (const [k, rating, body] of reviews) await c.call('PUT', `/api/marktplatz/${ids[k]}/reviews`, { rating, body });
  }
  

  // The notes strip is for real use; the pictures show the pages themselves.
  await aa.call('POST', '/api/werkstatt/notices/read', {});
  console.log('Screenshots …');
  const browser = await chromium.launch({ ...(process.env.PGHL_CHROMIUM ? { executablePath: process.env.PGHL_CHROMIUM } : {}), args: process.env.PGHL_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
  const shoot = async (scheme: 'light' | 'dark', viewport: { width: number; height: number }, suffix: string, list: [string, string, string?, number?][], opts: { settle?: number; full?: boolean } = {}) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    const r = await context.request.post(`${base}/api/auth/login`, { data: { email, password }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    const page = await context.newPage();
    for (const [path, file, ready, height] of list) {
      await page.setViewportSize({ width: viewport.width, height: height ?? viewport.height });
      await page.goto(`${base}/app/${path}${path.includes('?') ? '&' : '?'}loc=${A}`, { waitUntil: 'domcontentloaded' });
      if (ready) await page.waitForSelector(ready, { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(opts.settle ?? 1500);
      await page.screenshot({ path: join(outDir, `${file}${suffix}.png`), fullPage: !!opts.full });
    }
    await context.close();
  };
  const plan = `werkstatt/${planned.id}`;
  const done = `werkstatt/${b1.id}`;
  // [route, file, element to wait for, viewport height]
  const pages: [string, string, string?, number?][] = [
    [plan, 'werkstatt-plan', '[data-tour="wk-plan"]', 1030],
    [`plugin/${ids['deal-ampel']}`, 'werkstatt-plugin', '[data-tour="plugin-frame"]', 560],
    ['marktplatz', 'marktplatz', '[data-tour="mk-grid"]', 760],
  ];
  await shoot('light', { width: 1440, height: 900 }, '', pages, { settle: 2500 });
  await shoot('dark', { width: 1440, height: 900 }, '-dark', pages, { settle: 2500 });
  await shoot('light', { width: 390, height: 844 }, '-phone', pages, { settle: 2500, full: true });
  await shoot('light', { width: 1440, height: 900 }, '', [
    [`marktplatz/${ids['deal-ampel']}`, 'marktplatz-detail', '[data-tour="mk-preview"]', 1000],
    ['werkstatt', 'werkstatt-builds', '[data-tour="wk-builds"]', 620],
    ['werkstatt/policy', 'werkstatt-policy', '[data-tour="wk-policy"]', 1300],
    [done, 'werkstatt-build-done', '[data-tour="wk-log"]', 900],
  ], { settle: 2500 });
  await browser.close();
  console.log(`Done → ${outDir}`);
} finally {
  server.close();
  await instance.close();
  rmSync(data, { recursive: true, force: true });
}
