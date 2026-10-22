#!/usr/bin/env node
/**
 * Renders the README screenshots (docs/assets/*.png) and the animated tour (docs/assets/tour.gif) from a
 * freshly seeded, fictional demo instance with headless Chromium. Dev-only, nothing is installed:
 *
 *   npm run build                          # the server serves the built UI
 *   npx -y playwright@1 install chromium   # once, if you have no Playwright browsers yet
 *   npm run screenshots                    # [-- --out docs/assets] [-- --no-gif]
 *
 * Playwright is loaded from the project, the global npm folder or PLAYWRIGHT_MODULE. The GIF needs ffmpeg.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'docs/assets'));
const wantGif = !args.includes('--no-gif');
const port = 4790 + Math.floor(Math.random() * 100);
// Browse via localhost (Chromium accepts Secure cookies there) while links show a neutral public address.
const base = `http://localhost:${port}`;
const publicUrl = 'https://crm.example.com';

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, join(root, 'node_modules/playwright'), (() => {
    try {
      return join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
    } catch {
      return undefined;
    }
  })()].filter(Boolean);
  for (const c of candidates) {
    try {
      return createRequire(import.meta.url)(c);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found – `npm i -g playwright && npx playwright install chromium`, or set PLAYWRIGHT_MODULE.');
}

if (!existsSync(join(root, 'dist-web/index.html'))) throw new Error('Run `npm run build` first.');
const { chromium } = loadPlaywright();
const data = mkdtempSync(join(tmpdir(), 'gohigh-shots-'));
mkdirSync(outDir, { recursive: true });

console.log('Seeding demo data …');
execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/demo-seed.ts', '--data-dir', data], { cwd: root, stdio: 'inherit', env: { ...process.env, PGHL_BASE_URL: publicUrl } });

const server = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PGHL_DATA_DIR: data, PORT: String(port), PGHL_BASE_URL: publicUrl, PGHL_TICK_MS: '0', PGHL_BACKUPS: '0', PGHL_DEMO_MODE: '0', PGHL_WEB_DIR: join(root, 'dist-web') },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not start');
}

try {
  await waitUp();
  const browser = await chromium.launch();
  const login = async (context) => {
    const r = await context.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    const me = await (await context.request.get(`${base}/api/me`)).json();
    return Object.fromEntries(me.locations.map((l) => [l.name, l.id]));
  };
  const api = async (context, loc, path) => (await context.request.get(`${base}${path}`, { headers: { 'x-location-id': loc } })).json();

  const shots = async (scheme) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    const locs = await login(context);
    const agency = locs['Nordlicht Digital'];
    const praxis = locs['Praxis Sonnenweg'];
    const coach = locs['FitWerk Coaching'];
    const page = await context.newPage();
    const go = async (path, loc, file, settle = 900) => {
      await page.goto(`${base}/app/${path}${path.includes('?') ? '&' : '?'}loc=${loc}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(settle);
      if (file) await page.screenshot({ path: join(outDir, file) });
    };
    const suffix = scheme === 'dark' ? '-dark' : '';
    if (scheme === 'dark') {
      await go('dashboard', agency, `dashboard${suffix}.png`);
      await go('opportunities', agency, `pipeline${suffix}.png`);
      await context.close();
      return;
    }
    const wf = (await api(context, agency, '/api/workflows')).find?.((w) => w.status === 'active') ?? (await api(context, agency, '/api/workflows'))[0];
    const site = (await api(context, agency, '/api/funnels')).find?.((f) => f.kind === 'website');
    const ticket = (await api(context, agency, '/api/tickets'))?.tickets?.[0] ?? (await api(context, agency, '/api/tickets'))?.[0];
    await go('dashboard', agency, 'dashboard.png');
    await go('agency', agency, 'agency.png');
    await go('contacts', agency, 'contacts.png');
    await go('opportunities', agency, 'pipeline.png');
    const convs = await api(context, agency, '/api/conversations');
    const conv = (Array.isArray(convs) ? convs : convs?.conversations ?? []).find((c) => c.unread) ?? (Array.isArray(convs) ? convs : convs?.conversations ?? [])[0];
    await go(conv?.id ? `conversations/${conv.id}` : 'conversations', agency, 'inbox.png', 1200);
    await go('calendars', praxis, 'calendar.png');
    if (wf?.id) await go(`workflows/${wf.id}`, agency, 'workflow.png');
    if (site?.id) await go(`funnels/${site.id}`, agency, 'funnel-builder.png', 1500);
    await go('reports', agency, 'reports.png', 1500);
    if (ticket?.id) await go(`tickets/${ticket.id}`, agency, 'helpdesk.png');
    else await go('tickets', agency, 'helpdesk.png');
    await go('invoices', agency, 'invoices.png');
    await go('courses', coach, 'courses.png');
    // Phone-sized view of the inbox for the mobile section.
    await page.setViewportSize({ width: 390, height: 844 });
    await go('dashboard', agency, 'mobile.png');
    await context.close();
  };

  console.log('Screenshots (light) …');
  await shots('light');
  console.log('Screenshots (dark) …');
  await shots('dark');

  if (wantGif) {
    let ffmpeg = 'ffmpeg';
    try {
      execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
    } catch {
      ffmpeg = '';
      console.warn('ffmpeg not found – skipping tour.gif');
    }
    if (ffmpeg) {
      console.log('Recording the animated tour …');
      const videoDir = mkdtempSync(join(tmpdir(), 'gohigh-video-'));
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
      const locs = await login(context);
      const agency = locs['Nordlicht Digital'];
      const page = await context.newPage();
      for (const path of ['dashboard', 'opportunities', 'conversations', 'calendars', 'reports', 'contacts']) {
        await page.goto(`${base}/app/${path}?loc=${path === 'calendars' ? locs['Praxis Sonnenweg'] : agency}`, { waitUntil: 'networkidle' });
        await page.mouse.move(820, 480);
        await page.mouse.wheel(0, 250);
        await page.waitForTimeout(1600);
      }
      await context.close();
      const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
      if (webm) {
        const src = join(videoDir, webm);
        const palette = join(videoDir, 'palette.png');
        const filters = 'fps=8,scale=960:-1:flags=lanczos';
        execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-vf', `${filters},palettegen=max_colors=128`, palette]);
        execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', src, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, join(outDir, 'tour.gif')]);
      }
      rmSync(videoDir, { recursive: true, force: true });
    }
  }
  await browser.close();
  console.log(`Done → ${outDir}`);
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
