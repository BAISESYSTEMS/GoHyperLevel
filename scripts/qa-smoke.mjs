#!/usr/bin/env node
/**
 * Browser regression checks for things only a real layout engine can tell (found by crawling every page of the built app).
 * Dev-only, nothing is installed – same setup as scripts/screenshots.mjs:
 *
 *   npm run build                          # the server serves the built UI
 *   npx -y playwright@1 install chromium   # once, if you have no Playwright browsers yet
 *   node scripts/qa-smoke.mjs              # exit code 1 and a list if a check fails
 *
 * Playwright is loaded from the project, the global npm folder or PLAYWRIGHT_MODULE; PGHL_CHROMIUM points at a Chromium binary.
 * It seeds a fictional demo into a temp folder and changes nothing else.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4890 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;

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
const data = mkdtempSync(join(tmpdir(), 'gohigh-qa-'));
execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/demo-seed.ts', '--data-dir', data], { cwd: root, stdio: 'ignore', env: { ...process.env, PGHL_BASE_URL: base } });
const server = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PGHL_DATA_DIR: data, PORT: String(port), PGHL_BASE_URL: base, PGHL_TICK_MS: '0', PGHL_BACKUPS: '0', PGHL_DEMO_MODE: '0', PGHL_WEB_DIR: join(root, 'dist-web') },
  stdio: 'ignore',
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` – ${detail}`}`);
  if (!ok) failures.push(name);
};

try {
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
    if (i > 100) throw new Error('Server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch(process.env.PGHL_CHROMIUM ? { executablePath: process.env.PGHL_CHROMIUM, args: ['--no-sandbox'] } : {});
  const open = async (vp) => {
    const context = await browser.newContext(vp === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'de-DE' } : { viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
    const r = await context.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    const me = await (await context.request.get(`${base}/api/me`)).json();
    const loc = me.locations.find((l) => l.name === 'Nordlicht Digital').id;
    return { context, loc, page: await context.newPage() };
  };
  const goto = async (page, loc, path) => {
    await page.goto(`${base}/app/${path}?loc=${loc}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.content h1', { timeout: 15000 });
    await page.waitForTimeout(600);
  };

  // --- desktop: a saved contact closes its dialog (the list stays mounted next to the new contact) ------------------------------
  {
    const { context, loc, page } = await open('desktop');
    await goto(page, loc, 'contacts');
    await page.getByRole('button', { name: '+ Kontakt' }).click();
    const m = page.locator('.modal');
    await m.locator('label.field', { hasText: /^Vorname/ }).locator('input').fill('Smoke');
    await m.locator('label.field', { hasText: /^Nachname/ }).locator('input').fill('Test');
    await m.getByRole('button', { name: 'Speichern' }).click();
    await page.waitForURL(/\/app\/contacts\/\w+/, { timeout: 10000 });
    await page.waitForTimeout(800);
    check('new contact dialog closes after saving', (await page.locator('.modal').count()) === 0, 'the dialog is still open on top of the new contact');

    // --- Tab stays inside an open dialog (aria-modal) ---------------------------------------------------------------------------------
    await goto(page, loc, 'contacts');
    await page.getByRole('button', { name: '+ Kontakt' }).click();
    await page.waitForSelector('.modal');
    let escaped = '';
    for (let i = 0; i < 25 && !escaped; i++) {
      await page.keyboard.press('Tab');
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.modal')))) escaped = `after ${i + 1} Tab presses`;
    }
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    if (!escaped && !(await page.evaluate(() => !!document.activeElement?.closest('.modal')))) escaped = 'with Shift+Tab';
    check('Tab and Shift+Tab stay inside an open dialog', !escaped, `the focus left the dialog ${escaped}`);
    await page.keyboard.press('Escape');

    // --- the deal drawer fits the screen: its Speichern button must be reachable --------------------------------------------------
    await goto(page, loc, 'opportunities');
    await page.locator('.kcard').first().click();
    await page.waitForSelector('.modal.drawer .modal-foot');
    const foot = await page.locator('.modal.drawer .modal-foot').boundingBox();
    check('deal drawer footer (Speichern) is on screen', !!foot && foot.y + foot.height <= 900 + 1, foot ? `footer ends at ${Math.round(foot.y + foot.height)} px of 900` : 'no footer');
    await page.keyboard.press('Escape');

    // --- the bell's panel is empty (nothing to focus) and still closes with Esc ----------------------------------------------------
    await goto(page, loc, 'dashboard');
    const bell = page.locator('button.pm-bell');
    await bell.waitFor({ timeout: 15000 });
    await bell.click();
    await page.waitForSelector('.pm-pop');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('notification popover closes with Esc', (await page.locator('.pm-pop').count()) === 0, 'Esc does nothing while the focus stays on the bell');
    await context.close();
  }

  // --- phone ------------------------------------------------------------------------------------------------------------------
  {
    const { context, loc, page } = await open('phone');
    await goto(page, loc, 'contacts');
    await page.getByRole('button', { name: '+ Kontakt' }).click();
    const x = await page.locator('.modal .modal-head .icon-btn').boundingBox();
    check('dialog ✕ is at least 44 px on a phone', !!x && x.width >= 43.5 && x.height >= 43.5, x ? `${Math.round(x.width)}×${Math.round(x.height)}` : 'no ✕');
    await page.keyboard.press('Escape');

    await goto(page, loc, 'dashboard');
    const chip = page.locator('a.pm-chip-idle');
    await chip.waitFor({ timeout: 15000 });
    const label = await chip.evaluate((a) => a.getAttribute('aria-label') || a.innerText.trim());
    check('timer chip has a name although only its icon shows', !!label, 'the link is empty for screen readers');

    // Touch targets: the inbox channel filter and the sortable list headers are at least 44 px on a touch screen.
    const small = async (sel) =>
      page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.width && (r.width < 43.5 || r.height < 43.5)).map((r) => `${Math.round(r.width)}×${Math.round(r.height)}`));
    await goto(page, loc, 'conversations');
    await page.locator('.chan-chip').first().waitFor({ timeout: 15000 });
    const chips = await small('.chan-chip');
    check('inbox channel chips are at least 44 px on a phone', !chips.length, chips.join(', '));
    await goto(page, loc, 'companies');
    await page.locator('.th-sort').first().waitFor({ timeout: 15000 });
    const heads = await small('.th-sort');
    check('sortable table headers are at least 44 px on a phone', !heads.length, heads.join(', '));

    // The public invoice page must not widen the page: the layout viewport grows (innerWidth > screen.width) when a table does not fit.
    const inv = await (await context.request.get(`${base}/api/invoices`, { headers: { 'x-location-id': loc } })).json();
    const sent = inv.find((i) => i.kind === 'invoice' && i.status === 'sent');
    await page.goto(`${base}/i/${sent.public_token}`, { waitUntil: 'domcontentloaded' });
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, screen: screen.width, inner: innerWidth }));
    check('public invoice fits a 390 px phone', w.doc <= w.screen + 1 && w.inner <= w.screen + 1, `page is ${Math.max(w.doc, w.inner)} px wide`);
    await context.close();
  }
  await browser.close();
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll browser checks passed.');
