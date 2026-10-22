#!/usr/bin/env node
/**
 * iPhone, iPad and foldable check of the installed web app, in headless Chromium with iOS user agents and the viewports of the real
 * devices (docs/ios-web-app.md). Two jobs:
 *
 *   1. screenshots of dashboard, inbox (also with a keyboard-sized hole in the viewport), bottom bar / drawer, a dialog, a record
 *      drawer, the install sheet and the push settings – light and dark – to look at (and to fix what looks off)
 *   2. checks of the touch behaviour: install sheet (shown in the browser, never in the installed app, remembered), 16 px fields and
 *      44 px targets, the keyboard stand-in, ⌘N / ⌘/ / Esc, pull-to-refresh with real touch events
 *   3. the fold check: one session switches viewport 466×678 → 890×626 → 466×678 (iPhone Duo folded / unfolded) and asserts that
 *      route, scroll position, open dialog and drawer, typed text and selection survive without a reload
 *
 *   npm run build                                   # the server serves the built UI
 *   npm run ios:shots -- --out /some/folder         # both jobs     [--only shots|checks|fold] [--device ipad-mini-portrait,duo-folded]
 *
 * Playwright comes from the project, the global npm folder or PLAYWRIGHT_MODULE (browsers: PLAYWRIGHT_BROWSERS_PATH). Dev-only,
 * nothing is installed. Exit code 1 when a fold-check assertion fails.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const outDir = resolve(arg('out', join(root, 'ios-pwa-shots')));
const only = arg('only', 'all');
const wantDevices = arg('device', '')
  .split(',')
  .filter(Boolean);
const port = 4890 + Math.floor(Math.random() * 100);
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
  throw new Error('Playwright not found – `npm i -g playwright`, or set PLAYWRIGHT_MODULE.');
}

if (!existsSync(join(root, 'dist-web/index.html'))) throw new Error('Run `npm run build` first.');
const { chromium, devices } = loadPlaywright();
mkdirSync(outDir, { recursive: true });

// --- devices (CSS sizes of the real screens; iOS Safari user agents so the app takes its iOS paths) -------------------------------------
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const dev = (id, w, h, ua, dpr = 2) => ({ id, viewport: { width: w, height: h }, userAgent: ua, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
const fromPlaywright = (id, name, dpr = 2) => ({ id, ...devices[name], deviceScaleFactor: dpr, userAgent: devices[name].userAgent.replace(/OS 1\d_\d/, 'OS 17_4') });
const DEVICES = [
  fromPlaywright('iphone-15', 'iPhone 15'),
  fromPlaywright('iphone-se', 'iPhone SE'),
  fromPlaywright('iphone-15-landscape', 'iPhone 15 landscape'),
  dev('ipad-pro-12-landscape', 1366, 1024, IPAD_UA),
  dev('ipad-pro-12-portrait', 1024, 1366, IPAD_UA),
  dev('ipad-mini-portrait', 744, 1133, IPAD_UA),
  dev('ipad-split-507', 507, 1024, IPAD_UA),
  dev('ipad-split-678', 678, 1024, IPAD_UA),
  // iPhone Duo (third-party figures, docs/ios-web-app.md): folded 466 × 678, unfolded 890 × 626 (626 × 890 held upright), 3×.
  dev('duo-folded', 466, 678, IPHONE_UA, 3),
  dev('duo-unfolded', 890, 626, IPHONE_UA, 3),
].filter((d) => !wantDevices.length || wantDevices.includes(d.id));

// --- the demo instance ------------------------------------------------------------------------------------------------------------
const data = mkdtempSync(join(tmpdir(), 'gohigh-ios-'));
console.log('Seeding demo data …');
execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/demo-seed.ts', '--data-dir', data], { cwd: root, stdio: 'ignore', env: { ...process.env, PGHL_BASE_URL: publicUrl } });
const server = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PGHL_DATA_DIR: data, PORT: String(port), PGHL_BASE_URL: publicUrl, PGHL_TICK_MS: '0', PGHL_BACKUPS: '0', PGHL_DEMO_MODE: '0', PGHL_WEB_DIR: join(root, 'dist-web') },
  stdio: ['ignore', 'ignore', 'inherit'],
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

const failures = [];
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok   ${name}`),
      (e) => (failures.push(`${name}: ${e.message.split('\n')[0]}`), console.log(`  FAIL ${name}\n       ${e.message.split('\n').slice(0, 3).join('\n       ')}`)),
    );

try {
  await waitUp();
  const browser = await chromium.launch();
  let loc = '';
  let conv = '';
  {
    // which sub-account and conversation to show
    const boot = await browser.newContext({ locale: 'de-DE' });
    const r = await boot.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    const me = await (await boot.request.get(`${base}/api/me`)).json();
    loc = me.locations.find((l) => l.name === 'Nordlicht Digital')?.id ?? me.locations[0].id;
    const convs = await (await boot.request.get(`${base}/api/conversations`, { headers: { 'x-location-id': loc } })).json();
    conv = (Array.isArray(convs) ? convs : convs.conversations ?? []).find((c) => c.unread)?.id ?? (Array.isArray(convs) ? convs : convs.conversations ?? [])[0]?.id;
    await boot.close();
  }

  const open = async (device, scheme, { standalone = true, keyboard = false } = {}) => {
    const { id: _id, ...options } = device;
    const context = await browser.newContext({ ...options, colorScheme: scheme, locale: 'de-DE', timezoneId: 'Europe/Berlin', serviceWorkers: 'block' });
    const r = await context.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    await context.addInitScript(
      ({ standalone, keyboard }) => {
        // Safari on iPhone and iPad has no WebXR (only visionOS has); Chromium does, and the app would take it for a headset.
        delete Navigator.prototype.xr;
        // The installed app: Safari's own flag.
        if (standalone) Object.defineProperty(navigator, 'standalone', { get: () => true });
        // An on-screen keyboard cannot be summoned in headless Chromium; a stand-in visual viewport can be shrunk by the test.
        if (keyboard) {
          const target = new EventTarget();
          const fake = { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) };
          Object.defineProperty(window, 'visualViewport', { get: () => fake });
          window.__fakeKeyboard = (px) => {
            fake.height = innerHeight - px;
            target.dispatchEvent(new Event('resize'));
          };
        }
      },
      { standalone, keyboard },
    );
    const page = await context.newPage();
    return { context, page };
  };
  const go = async (page, path, settle = 900) => {
    await page.goto(`${base}/app/${path}${path.includes('?') ? '&' : '?'}loc=${loc}`, { waitUntil: 'load' });
    await page.waitForTimeout(settle);
  };
  const shot = (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) });

  // ---- 1. screenshots ----------------------------------------------------------------------------------------------------------------
  if (only === 'all' || only === 'shots') {
    for (const device of DEVICES) {
      const width = device.viewport.width;
      for (const scheme of ['light', 'dark']) {
        const tag = `${device.id}-${scheme}`;
        console.log(`Shots ${tag} …`);
        // dashboard, inbox, dialog, record drawer, push settings, in the installed app
        {
          const { context, page } = await open(device, scheme, { keyboard: true });
          await go(page, 'dashboard');
          await shot(page, `${tag}-1-dashboard`);
          if (width < 600) {
            await page.getByRole('button', { name: 'Mehr: ganzes Menü' }).click();
            await page.waitForTimeout(350);
            await shot(page, `${tag}-2-menu`);
            await page.keyboard.press('Escape');
          }
          await go(page, conv ? `conversations/${conv}` : 'conversations', 1300);
          await shot(page, `${tag}-3-inbox`);
          if (conv) {
            const composer = page.locator('.inbox .thread textarea').last();
            if (await composer.count()) {
              await composer.click();
              await page.evaluate((h) => window.__fakeKeyboard(h), device.viewport.height > device.viewport.width ? 336 : 220);
              await page.waitForTimeout(600);
              await shot(page, `${tag}-4-inbox-keyboard`);
              await page.evaluate(() => window.__fakeKeyboard(0));
            }
          }
          await go(page, 'contacts');
          const primary = page.locator('.page-head .actions .btn:not(.secondary)').first();
          if (await primary.count()) {
            await primary.click();
            await page.waitForTimeout(400);
            await shot(page, `${tag}-5-modal`);
            await page.keyboard.press('Escape');
          }
          if (width >= 600) {
            await go(page, 'opportunities');
            const card = page.locator('.kcard').first();
            if (await card.count()) {
              await card.click();
              await page.waitForTimeout(500);
              await shot(page, `${tag}-6-deal-drawer`);
            }
          }
          if (width >= 720) {
            await go(page, 'contacts');
            await page.locator('table.t tr.click').first().click();
            await page.waitForTimeout(900);
            await shot(page, `${tag}-9-contact-next-to-list`);
            await go(page, 'tasks');
            await page.locator('[data-tour="task-open"]').first().click();
            await page.waitForTimeout(500);
            await shot(page, `${tag}-10-task-next-to-list`);
          }
          await go(page, 'settings/account', 1200);
          await page.locator('[data-tour="ios-app"]').scrollIntoViewIfNeeded().catch(() => undefined);
          await shot(page, `${tag}-7-settings`);
          await context.close();
        }
        // the install sheet: in the browser (not installed), a few seconds after the app is up
        {
          const { context, page } = await open(device, scheme, { standalone: false });
          await go(page, 'dashboard', 8500);
          await shot(page, `${tag}-8-install-sheet`);
          await context.close();
        }
      }
    }
  }


  // ---- 2. touch behaviour -------------------------------------------------------------------------------------------------------------
  if (only === 'all' || only === 'checks') {
    console.log('Touch checks …');
    const phone = dev('phone', 393, 852, IPHONE_UA, 2);
    const tablet = dev('tablet', 1194, 834, IPAD_UA, 2);

    // install sheet: in the browser yes, remembered, never in the installed app
    {
      const { context, page } = await open(phone, 'light', { standalone: false });
      await go(page, 'dashboard', 8500);
      await check('install sheet shows in Safari on an iPhone, with the steps and a ✕', async () => {
        assert.ok(await page.locator('.modal.ios-sheet').isVisible(), 'sheet visible');
        assert.match(await page.locator('.modal.ios-sheet').innerText(), /Zum Home-Bildschirm/);
        assert.ok(await page.locator('.modal.ios-sheet .modal-head [aria-label="Schließen"]').isVisible(), '✕ visible');
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await check('Esc closes it, and it stays away after a reload (remembered per person)', async () => {
        assert.equal(await page.locator('.modal.ios-sheet').count(), 0);
        await go(page, 'dashboard', 8500);
        assert.equal(await page.locator('.modal.ios-sheet').count(), 0, 'not shown again');
      });
      await context.close();
    }
    {
      const { context, page } = await open(phone, 'light', { standalone: true });
      await go(page, 'dashboard', 8500);
      await check('install sheet never shows inside the installed app', async () => assert.equal(await page.locator('.modal.ios-sheet').count(), 0));
      await check('the settings card says the app is installed and offers the explicit push step', async () => {
        await go(page, 'settings/account', 1500);
        assert.match(await page.locator('[data-tour="ios-app"]').innerText(), /als App geöffnet/);
        assert.ok(await page.locator('[data-tour="push-step"]').count(), 'push step shown');
      });
      await context.close();
    }

    // sizes: fields at 16 px (iOS zooms into smaller ones), targets at 44 px
    {
      const { context, page } = await open(phone, 'light', { standalone: true });
      for (const path of ['contacts', 'tasks', 'settings/company', `conversations/${conv}`]) {
        await go(page, path, 1500);
        await check(`${path}: every field is at least 16 px (no zoom on focus)`, async () => {
          const small = await page.evaluate(() =>
            [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]):not([type=hidden]), select, textarea')]
              .filter((e) => e.getClientRects().length)
              .map((e) => ({ tag: e.tagName, cls: e.className, size: parseFloat(getComputedStyle(e).fontSize) }))
              .filter((e) => e.size < 16),
          );
          assert.deepEqual(small, []);
        });
      }
      await go(page, 'contacts', 1500);
      await check('buttons and the bottom bar are at least 44 px high', async () => {
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('.tab, .page-head .btn, .tabs button, .topbar .btn')]
            .filter((e) => e.getClientRects().length)
            .map((e) => ({ cls: e.className, h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
            .filter((e) => e.h < 44 || e.w < 44),
        );
        assert.deepEqual(small, []);
      });
      await check('pinch zoom is not blocked', async () => assert.ok(!/user-scalable|maximum-scale/.test(await page.evaluate(() => document.querySelector('meta[name=viewport]').content))));
      await check('the page never scrolls sideways', async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal scroll'));
      await context.close();
    }

    // keyboard stand-in: shell, bottom bar and composer follow the visible part
    {
      const { context, page } = await open(phone, 'light', { standalone: true, keyboard: true });
      await go(page, `conversations/${conv}`, 1500);
      await page.locator('.inbox .thread textarea').last().click();
      await page.evaluate(() => window.__fakeKeyboard(336));
      await page.waitForTimeout(500);
      await check('with the keyboard up: data-keyboard is set, the bottom bar steps aside, the composer is inside the visible 516 px', async () => {
        assert.equal(await page.evaluate(() => document.documentElement.dataset.keyboard), 'open');
        assert.ok(!(await page.locator('.tabbar').isVisible()), 'bottom bar hidden');
        const box = await page.locator('.inbox .thread textarea').last().boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= 516 + 1, `textarea ${JSON.stringify(box)}`);
        const shell = await page.locator('.shell').boundingBox();
        assert.ok(shell && Math.abs(shell.height - 516) <= 1, `shell height ${shell?.height}`);
      });
      await page.evaluate(() => window.__fakeKeyboard(0));
      await page.waitForTimeout(400);
      await check('and back to normal when it goes away', async () => {
        assert.equal(await page.evaluate(() => document.documentElement.dataset.keyboard), undefined);
        assert.ok(await page.locator('.tabbar').isVisible(), 'bottom bar back');
      });
      await context.close();
    }

    // hardware keyboard on the iPad
    {
      const { context, page } = await open(tablet, 'light');
      await go(page, 'contacts', 6000);
      await check('⌘N opens the page’s main action, Esc closes it again', async () => {
        await page.keyboard.press('Control+n');
        await page.waitForTimeout(400);
        assert.ok(await page.locator('.modal').isVisible(), 'dialog open');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        assert.equal(await page.locator('.modal').count(), 0);
      });
      await check('⌘/ shows the shortcut overview (with ✕), Esc closes it', async () => {
        await page.keyboard.press('Control+/');
        await page.waitForTimeout(400);
        assert.match(await page.locator('.modal').innerText(), /Tastaturkürzel/);
        assert.ok(await page.locator('.modal .modal-head [aria-label="Schließen"]').isVisible(), '✕');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        assert.equal(await page.locator('.modal').count(), 0);
      });
      await check('holding ⌘ for a second shows the short list, releasing hides it', async () => {
        await page.keyboard.down('Control');
        await page.waitForTimeout(1300);
        assert.ok(await page.locator('.kb-hint').isVisible(), 'hint visible');
        await page.keyboard.up('Control');
        await page.waitForTimeout(200);
        assert.equal(await page.locator('.kb-hint').count(), 0);
      });
      await check('iPad landscape: sidebar, list and contact side by side', async () => {
        await page.locator('table.t tr.click').first().click();
        await page.waitForTimeout(900);
        assert.ok(await page.locator('.md-list').isVisible(), 'list');
        assert.ok(await page.locator('.md-detail .page-head').isVisible(), 'contact');
        assert.ok(await page.locator('table.t tr.click.on').count(), 'row of the open contact marked');
      });
      await context.close();
    }

    // pull to refresh with real touch events
    {
      const { context, page } = await open(phone, 'light', { standalone: true });
      await go(page, 'dashboard', 6500); // the iOS layer mounts when the page is idle
      await page.evaluate(() => {
        window.__refreshed = 0;
        window.addEventListener('pghl:refresh', () => (window.__refreshed += 1));
      });
      const cdp = await context.newCDPSession(page);
      const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 200, y }] });
      const pull = async (to) => {
        await touch('touchStart', 220);
        for (let y = 220; y <= to; y += 20) await touch('touchMove', y);
        await touch('touchEnd', to);
        await page.waitForTimeout(300);
      };
      await check('a short pull does nothing, a long pull at the top reloads the page', async () => {
        await pull(260);
        assert.equal(await page.evaluate(() => window.__refreshed), 0, 'short pull');
        await pull(420);
        assert.equal(await page.evaluate(() => window.__refreshed), 1, 'long pull');
      });
      await check('no pull-to-refresh once the page is scrolled down', async () => {
        await page.evaluate(() => (document.querySelector('.main').scrollTop = 300));
        await page.waitForTimeout(200);
        await pull(460);
        assert.equal(await page.evaluate(() => window.__refreshed), 1);
      });
      await context.close();
    }
  }

  // ---- 3. fold / unfold continuity -----------------------------------------------------------------------------------------------------
  if (only === 'all' || only === 'fold') {
    console.log('Fold check (iPhone Duo 466×678 → 890×626 → 466×678) …');
    const FOLDED = { width: 466, height: 678 };
    const OPEN = { width: 890, height: 626 };
    const duo = dev('duo', FOLDED.width, FOLDED.height, IPHONE_UA, 3);
    // the conversation with the most messages (something to scroll in both layouts)
    let longest = conv;
    {
      const probe = await browser.newContext({ locale: 'de-DE' });
      await probe.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
      const list = await (await probe.request.get(`${base}/api/conversations`, { headers: { 'x-location-id': loc } })).json();
      let best = -1;
      for (const c of (Array.isArray(list) ? list : list.conversations ?? []).filter((x) => ['email', 'sms'].includes(x.last_channel)).slice(0, 12)) {
        const t = await (await probe.request.get(`${base}/api/conversations/${c.id}/messages`, { headers: { 'x-location-id': loc } })).json();
        if (t.messages?.length > best) [best, longest] = [t.messages.length, c.id];
      }
      await probe.close();
    }
    const size = (page) => page.evaluate(() => document.documentElement.dataset.size);
    const switchTo = async (page, v) => {
      await page.setViewportSize(v);
      await page.waitForTimeout(450);
    };

    // inbox: the conversation, typed text, selection, scroll position of the messages
    {
      const { context, page } = await open(duo, 'light');
      await go(page, `conversations/${longest}`, 1400);
      await page.evaluate(() => {
        window.__session = 'same-page-' + Math.random();
      });
      const session = await page.evaluate(() => window.__session);
      const composer = page.locator('.inbox .thread textarea').last();
      await composer.click();
      await composer.fill('Hallo Anna, danke für deine Nachricht – ich melde mich heute noch.');
      await composer.evaluate((el) => el.setSelectionRange(6, 10));
      // read the conversation half way up: the scroller is the whole thread in the phone layout
      const ratio = () =>
        page.evaluate(() => {
          const els = ['.inbox .thread', '.inbox .msgs'].map((s) => document.querySelector(s)).filter((e) => e && e.scrollHeight - e.clientHeight > 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
          const e = els[0];
          return e ? e.scrollTop / (e.scrollHeight - e.clientHeight) : null;
        });
      await page.evaluate(() => {
        const e = document.querySelector('.inbox .thread');
        e.scrollTop = (e.scrollHeight - e.clientHeight) * 0.4;
      });
      await page.waitForTimeout(200);
      const before = await page.evaluate(() => {
        const t = document.querySelector('.inbox .thread textarea:last-of-type');
        return { path: location.pathname, value: t.value, start: t.selectionStart, end: t.selectionEnd };
      });
      before.ratio = await ratio();
      await check('the conversation is long enough to test scrolling (read half way up)', () => assert.ok(before.ratio !== null && before.ratio > 0.3 && before.ratio < 0.5, `ratio ${before.ratio}`));
      await check('folded: phone layout (bottom bar, one pane)', async () => {
        assert.equal(await size(page), 'compact');
        assert.ok(await page.locator('.tabbar').isVisible(), 'bottom bar visible');
        assert.ok(await page.locator('.inbox .thread').isVisible(), 'conversation visible');
        assert.ok(!(await page.locator('.inbox .list').isVisible()), 'list hidden while the conversation is open');
      });
      await shot(page, 'duo-fold-1-folded-inbox');
      await switchTo(page, OPEN);
      const mid = await page.evaluate(() => {
        const t = document.querySelector('.inbox .thread textarea:last-of-type');
        return { path: location.pathname, session: window.__session, value: t?.value, start: t?.selectionStart, end: t?.selectionEnd, active: document.activeElement === t };
      });
      mid.ratio = await ratio();
      await shot(page, 'duo-fold-2-unfolded-inbox');
      await check('unfolded: tablet layout (rail, list + conversation side by side, no bottom bar)', async () => {
        assert.equal(await size(page), 'medium');
        assert.ok(await page.locator('.inbox .list').isVisible(), 'list visible');
        assert.ok(await page.locator('.inbox .thread').isVisible(), 'conversation visible');
        assert.ok(!(await page.locator('.tabbar').isVisible()), 'bottom bar gone');
        const side = await page.locator('aside.side').boundingBox();
        assert.ok(side && side.width < 100 && side.x === 0, `rail on the left, ${JSON.stringify(side)}`);
      });
      await check('unfolding keeps route, page, typed text, selection, focus and scroll position', () => {
        assert.equal(mid.path, before.path);
        assert.equal(mid.session, session, 'no reload');
        assert.equal(mid.value, before.value);
        assert.deepEqual([mid.start, mid.end], [before.start, before.end]);
        assert.ok(mid.active, 'composer keeps the focus');
        // the message list may fit entirely in the wider layout (nothing to scroll); if it scrolls, it is where the reader was
        assert.ok(mid.ratio === null || Math.abs(mid.ratio - before.ratio) < 0.08, `scroll position ${before.ratio} → ${mid.ratio}`);
      });
      await switchTo(page, FOLDED);
      const after = await page.evaluate(() => {
        const t = document.querySelector('.inbox .thread textarea:last-of-type');
        return { path: location.pathname, session: window.__session, value: t?.value, start: t?.selectionStart, end: t?.selectionEnd, active: document.activeElement === t };
      });
      after.ratio = await ratio();
      await check('folding again returns to the phone layout with everything still there', async () => {
        assert.equal(await size(page), 'compact');
        assert.ok(await page.locator('.tabbar').isVisible());
        assert.equal(after.path, before.path);
        assert.equal(after.session, session);
        assert.equal(after.value, before.value);
        assert.deepEqual([after.start, after.end], [before.start, before.end]);
        assert.ok(after.active);
        assert.ok(after.ratio !== null && Math.abs(after.ratio - before.ratio) < 0.08, `scroll position ${before.ratio} → ${after.ratio}`);
      });
      await context.close();
    }

    // dialog with a half-filled form, and the phone drawer
    {
      const { context, page } = await open(duo, 'light');
      await go(page, 'contacts');
      await page.evaluate(() => (window.__session = 'same-' + Math.random()));
      const session = await page.evaluate(() => window.__session);
      await page.locator('.page-head .actions .btn:not(.secondary)').first().click();
      await page.waitForTimeout(300);
      const field = page.locator('.modal input').first();
      await field.fill('Marlene Fischer');
      await field.evaluate((el) => el.setSelectionRange(3, 7));
      await switchTo(page, OPEN);
      await check('an open dialog and its half-filled form survive unfolding', async () => {
        assert.ok(await page.locator('.modal').isVisible(), 'dialog open');
        assert.equal(await page.locator('.modal input').first().inputValue(), 'Marlene Fischer');
        assert.deepEqual(await page.locator('.modal input').first().evaluate((el) => [el.selectionStart, el.selectionEnd]), [3, 7]);
        assert.equal(await page.evaluate(() => window.__session), session);
        const m = await page.locator('.modal').boundingBox();
        assert.ok(m && m.x >= 0 && m.x + m.width <= OPEN.width, 'dialog inside the window');
      });
      await shot(page, 'duo-fold-3-unfolded-modal');
      await switchTo(page, FOLDED);
      await check('…and folding again', async () => {
        assert.ok(await page.locator('.modal').isVisible());
        assert.equal(await page.locator('.modal input').first().inputValue(), 'Marlene Fischer');
        const m = await page.locator('.modal').boundingBox();
        assert.ok(m && m.x >= 0 && m.x + m.width <= FOLDED.width, 'dialog inside the window');
      });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: 'Mehr: ganzes Menü' }).click();
      await page.waitForTimeout(300);
      await switchTo(page, OPEN);
      await switchTo(page, FOLDED);
      await check('the open menu drawer is still open after unfold and fold', async () => {
        assert.ok(await page.locator('aside.side.open').isVisible(), 'drawer open');
        assert.equal(await page.evaluate(() => window.__session), session);
      });
      await shot(page, 'duo-fold-4-folded-drawer');
      await context.close();
    }

    // plain page scroll (dashboard)
    {
      const { context, page } = await open(duo, 'light');
      await go(page, 'dashboard');
      await page.evaluate(() => {
        window.__session = 'same-' + Math.random();
        document.querySelector('.main').scrollTop = 220;
      });
      const before = await page.evaluate(() => ({ s: window.__session, top: document.querySelector('.main').scrollTop }));
      await switchTo(page, OPEN);
      await switchTo(page, FOLDED);
      await check('the scroll position of a page survives unfold and fold', async () => {
        const now = await page.evaluate(() => ({ s: window.__session, top: document.querySelector('.main').scrollTop }));
        assert.equal(now.s, before.s);
        assert.ok(before.top > 0, 'page was scrolled');
        assert.ok(Math.abs(now.top - before.top) <= 3, `scroll ${before.top} → ${now.top}`);
      });
      await context.close();
    }
  }
  await browser.close();
  console.log(failures.length ? `\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}` : `\nDone → ${outDir}`);
  if (failures.length) process.exitCode = 1;
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
