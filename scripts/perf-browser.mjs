#!/usr/bin/env node
/**
 * Page-load check with headless Chromium (docs/performance.md): first contentful paint, largest contentful
 * paint, "content visible" and transferred bytes for the login page and the dashboard – cold (empty cache)
 * and warm (second visit) – on a throttled 4G connection (CDP network emulation). Dev-only, nothing is
 * installed; Playwright is loaded the same way as in scripts/screenshots.mjs.
 *
 *   npm run build && PGHL_DATA_DIR=./perf-data npm start         # a server with data (npm run perf:seed)
 *   node scripts/perf-browser.mjs --url http://127.0.0.1:4700 [--runs 3] [--cpu 1] [--no-throttle] [--out result.json]
 *
 *   --email / --password   login (default perf@example.test / perf-pass-123, see scripts/perf-seed.ts)
 *   --location <id>        sub-account for the dashboard (default: the one with the most contacts)
 *   --chrome <path>        Chromium binary (default: the one Playwright knows, or PGHL_CHROME)
 *   --label <text>         shown in the output (e.g. before / after)
 *
 * Numbers are the median of --runs runs. Network: 1.6 Mbit/s down, 750 kbit/s up, 150 ms round trip.
 * The service worker is blocked, so every byte is counted (with it, installed after the first load, requests it
 * answers are invisible to the page's network log). "warm" = the browser's HTTP cache from the first visit.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

if (flag('help')) {
  console.log('Usage: node scripts/perf-browser.mjs --url http://127.0.0.1:4700 [--runs 3] [--cpu 1] [--no-throttle] [--out result.json] [--label after]');
  process.exit(0);
}

function loadPlaywright() {
  const global = (() => {
    try {
      return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  })();
  const candidates = [process.env.PLAYWRIGHT_MODULE, join(root, 'node_modules/playwright'), join(root, 'node_modules/playwright-core'), global && join(global, 'playwright'), global && join(global, 'playwright-core')].filter(Boolean);
  for (const c of candidates) {
    try {
      return createRequire(import.meta.url)(c);
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found – `npm i -g playwright && npx playwright install chromium`, or set PLAYWRIGHT_MODULE.');
}

const BASE = opt('url', 'http://127.0.0.1:4700').replace(/\/$/, '');
const RUNS = Math.max(1, Number(opt('runs', 3)));
const CPU = Number(opt('cpu', 1));
const THROTTLE = !flag('no-throttle');
const EMAIL = opt('email', 'perf@example.test');
const PASSWORD = opt('password', 'perf-pass-123');
const LABEL = opt('label', '');

const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const kb = (b) => Math.round((b / 1024) * 10) / 10;

/** A page with throttling, byte counting and paint observers. Returns helpers to read the numbers. */
async function instrumented(context) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (THROTTLE) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const reqs = new Map();
  let inflight = 0;
  cdp.on('Network.requestWillBeSent', (e) => {
    if (!reqs.has(e.requestId)) inflight++;
    reqs.set(e.requestId, { url: e.request.url, bytes: 0, type: e.type, cached: false, done: false });
  });
  cdp.on('Network.loadingFailed', (e) => {
    const r = reqs.get(e.requestId);
    if (r && !r.done) {
      r.done = true;
      inflight--;
    }
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.status = e.response.status;
      r.encoding = e.response.headers['content-encoding'] ?? e.response.headers['Content-Encoding'] ?? '';
      r.cached = !!(e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache);
    }
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.bytes = e.encodedDataLength;
      if (!r.done) {
        r.done = true;
        inflight--;
      }
    }
  });
  await page.addInitScript(() => {
    window.__paint = { fcp: null, lcp: null };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__paint.fcp = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__paint.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  return {
    page,
    cdp,
    reqs,
    /** Bytes finished so far (call when the page content is visible). */
    bytesNow: () => [...reqs.values()].reduce((n, r) => n + (r.bytes || 0), 0),
    /** Waits until nothing is in flight for 1 s (at most 40 s – idle prefetching of the next pages counts), then reads paint times and bytes. */
    async settle(ready, readyBytes) {
      let quiet = 0;
      for (let i = 0; i < 400 && quiet < 10; i++) {
        await page.waitForTimeout(100);
        quiet = inflight <= 0 ? quiet + 1 : 0;
      }
      const paint = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return { ...window.__paint, dcl: nav?.domContentLoadedEventEnd ?? null, load: nav?.loadEventEnd ?? null };
      });
      const all = [...reqs.values()];
      if (process.env.PGHL_DEBUG_REQS) console.log(all.map((r) => `${String(r.bytes).padStart(8)} ${r.cached ? 'cache' : '     '} ${r.url.replace(BASE, '')}`).join('\n'), '\n---');
      const js = all.filter((r) => /\.js(\?|$)/.test(r.url));
      return {
        fcp: paint.fcp,
        lcp: paint.lcp,
        ready,
        readyBytes,
        dcl: paint.dcl,
        load: paint.load,
        bytes: all.reduce((n, r) => n + (r.bytes || 0), 0),
        requests: all.length,
        jsBytes: js.reduce((n, r) => n + (r.bytes || 0), 0),
        jsFiles: js.length,
        cached: all.filter((r) => r.cached).length,
      };
    },
  };
}

async function main() {
  const pw = loadPlaywright();
  const executablePath = opt('chrome', process.env.PGHL_CHROME);
  const browser = await pw.chromium.launch(executablePath ? { executablePath } : {});

  // Session for the dashboard scenarios (API login, so the login page itself is measured separately).
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  if (!login.ok) throw new Error(`login failed (${login.status}) – is the server seeded? (npm run perf:seed)`);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const [name, ...rest] = cookie.split('=');
  const authed = { 'x-pghl': '1', cookie };
  let location = opt('location');
  if (!location) {
    const overview = await (await fetch(`${BASE}/api/agency/overview`, { headers: authed })).json();
    location = [...overview].sort((a, b) => b.contacts - a.contacts)[0]?.id;
  }
  const url = new URL(BASE);
  const sessionCookie = { name, value: decodeURIComponent(rest.join('=')), domain: url.hostname, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' };

  const scenarios = { 'login cold': [], 'login warm': [], 'dashboard cold': [], 'dashboard warm': [] };
  for (let run = 0; run < RUNS; run++) {
    // --- login page: signed out ---
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      const t = await instrumented(ctx);
      const t0 = Date.now();
      await t.page.goto(`${BASE}/app`, { waitUntil: 'commit' });
      await t.page.waitForSelector('input[type=email]', { timeout: 60_000 });
      const ready = Date.now() - t0;
      scenarios['login cold'].push(await t.settle(ready, t.bytesNow()));
      await t.page.waitForTimeout(1500); // service worker installs and fills its cache
      await t.page.close();
      const w = await instrumented(ctx);
      const w0 = Date.now();
      await w.page.goto(`${BASE}/app`, { waitUntil: 'commit' });
      await w.page.waitForSelector('input[type=email]', { timeout: 60_000 });
      const wReady = Date.now() - w0;
      scenarios['login warm'].push(await w.settle(wReady, w.bytesNow()));
      await ctx.close();
    }
    // --- dashboard: signed in ---
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      await ctx.addCookies([sessionCookie]);
      await ctx.addInitScript((id) => {
        try {
          localStorage.setItem('pghl.location', id);
          localStorage.setItem('pghl.tour-seen', '1');
        } catch {
          /* ignore */
        }
      }, location);
      const t = await instrumented(ctx);
      const t0 = Date.now();
      await t.page.goto(`${BASE}/app/dashboard`, { waitUntil: 'commit' });
      await t.page.waitForSelector('[data-tour="dashboard-stats"]', { timeout: 60_000 });
      const ready = Date.now() - t0;
      scenarios['dashboard cold'].push(await t.settle(ready, t.bytesNow()));
      await t.page.waitForTimeout(1500);
      await t.page.close();
      const w = await instrumented(ctx);
      const w0 = Date.now();
      await w.page.goto(`${BASE}/app/dashboard`, { waitUntil: 'commit' });
      await w.page.waitForSelector('[data-tour="dashboard-stats"]', { timeout: 60_000 });
      const wReady = Date.now() - w0;
      scenarios['dashboard warm'].push(await w.settle(wReady, w.bytesNow()));
      await ctx.close();
    }
  }
  await browser.close();

  const out = {};
  console.log(`${LABEL ? `[${LABEL}] ` : ''}${BASE} – ${THROTTLE ? 'throttled 4G (1.6 Mbit/s, 150 ms RTT)' : 'no throttling'}${CPU > 1 ? `, CPU ${CPU}x slower` : ''}, median of ${RUNS}`);
  console.log(`${'scenario'.padEnd(16)} ${'FCP ms'.padStart(8)} ${'LCP ms'.padStart(8)} ${'ready ms'.padStart(9)} ${'KB@ready'.padStart(9)} ${'KB total'.padStart(9)} ${'req'.padStart(4)} ${'JS files'.padStart(8)}`);
  for (const [k, runs] of Object.entries(scenarios)) {
    const m = (f) => median(runs.map((r) => r[f]));
    out[k] = { fcp_ms: Math.round(m('fcp')), lcp_ms: Math.round(m('lcp')), ready_ms: Math.round(m('ready')), load_ms: Math.round(m('load')), transferred_kb_at_ready: kb(m('readyBytes')), transferred_kb_total: kb(m('bytes')), requests: m('requests'), js_kb: kb(m('jsBytes')), js_files: m('jsFiles'), from_cache: m('cached') };
    const o = out[k];
    console.log(`${k.padEnd(16)} ${String(o.fcp_ms).padStart(8)} ${String(o.lcp_ms).padStart(8)} ${String(o.ready_ms).padStart(9)} ${String(o.transferred_kb_at_ready).padStart(9)} ${String(o.transferred_kb_total).padStart(9)} ${String(o.requests).padStart(4)} ${String(o.js_files).padStart(8)}`);
  }
  const file = opt('out');
  if (file) writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), url: BASE, label: LABEL, throttled: THROTTLE, cpu: CPU, runs: RUNS, results: out }, null, 2));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
