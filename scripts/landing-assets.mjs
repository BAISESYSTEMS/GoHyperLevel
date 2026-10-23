#!/usr/bin/env node
/**
 * Images of the launch landing page (docs/landing.md), written to web/public/landing/:
 *
 *  - shot-workflow|inbox|funnel|pipeline.webp – real screens of a freshly seeded, fictional demo instance (headless Chromium,
 *    1440×900, the product name set to HyperLevel in the agency branding), converted to WebP in the browser;
 *  - shot-jarvis|academy|themes|xr.webp – focus mode with Jarvis' briefing, the Academy with a running tour (German, like its
 *    tours), four looks side by side and the 3D preview of a board (the steps live in scripts/shots-kit.mjs);
 *  - og-en.png, og-de.png – the social cards (1200×630) with the hero line, set in the page's own font;
 *  - og-waitlist-en.png, og-waitlist-de.png – the same cards for the cloud waitlist mode (cloud "coming soon", no price as on offer);
 *  - og-stack-de.png, og-stack-en.png – "Replaces your stack" as a card (top rows and the total, from replaces.json);
 *  - stats.json – the test count (scripts/landing-stats.mjs).
 *
 *   npm run build                                  # the server serves the built UI
 *   node scripts/landing-assets.mjs [--no-shots]   # --no-shots: only the social cards and stats
 *
 * Dev-only. Playwright is loaded from the project, the global npm folder or PLAYWRIGHT_MODULE (like scripts/screenshots.mjs).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTests } from './landing-stats.mjs';
import { academyTour, endTour, focusBriefing, salesBoard, themeCollage, tidy, xrPreview } from './shots-kit.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'web/public/landing');
const MARK = `data:image/svg+xml;base64,${readFileSync(join(root, 'web/public/icon.svg')).toString('base64')}`;
const args = process.argv.slice(2);
const port = 4890 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;
const publicUrl = 'https://gohyperlevel.com';

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, join(root, 'node_modules/playwright'), '/opt/node22/lib/node_modules/playwright', (() => {
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
  throw new Error('Playwright not found – set PLAYWRIGHT_MODULE.');
}

const { chromium } = loadPlaywright();
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

/** PNG bytes → WebP bytes, encoded by Chromium itself (no image library needed). */
async function toWebp(png, quality = 0.84) {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(
    async ([b64, q]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', q);
    },
    [png.toString('base64'), quality],
  );
  await page.close();
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// --- screens of the demo ---------------------------------------------------------------------------------------------------
if (!args.includes('--no-shots')) {
  if (!existsSync(join(root, 'dist-web/index.html'))) throw new Error('Run `npm run build` first.');
  const data = mkdtempSync(join(tmpdir(), 'ghyl-landing-'));
  execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/demo-seed.ts', '--data-dir', data], { cwd: root, stdio: 'inherit', env: { ...process.env, PGHL_BASE_URL: publicUrl } });
  const server = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: { ...process.env, PGHL_DATA_DIR: data, PORT: String(port), PGHL_BASE_URL: publicUrl, PGHL_TICK_MS: '0', PGHL_BACKUPS: '0', PGHL_DEMO_MODE: '0', PGHL_WEB_DIR: join(root, 'dist-web') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    for (let i = 0; i < 100 && !(await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 200));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-GB', timezoneId: 'Europe/Berlin' });
    const r = await context.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
    await context.request.patch(`${base}/api/agency/branding`, { data: { name: 'HyperLevel' }, headers: { 'x-pghl': '1' } });
    await tidy(context, base);
    const me = await (await context.request.get(`${base}/api/me`)).json();
    const loc = Object.fromEntries(me.locations.map((l) => [l.name, l.id]));
    const agency = loc['Nordlicht Digital'];
    const api = async (path) => (await context.request.get(`${base}${path}`, { headers: { 'x-location-id': agency } })).json();
    const page = await context.newPage();
    const shot = async (path, file, settle = 1200, before) => {
      // Live pages keep a stream open, so "network idle" never comes: load, then give the app time to render.
      await page.goto(`${base}/app/${path}${path.includes('?') ? '&' : '?'}loc=${agency}`, { waitUntil: 'load' });
      await page.waitForTimeout(settle + 1200);
      if (before) await before();
      writeFileSync(join(out, file), await toWebp(await page.screenshot()));
      console.log(`  ${file}`);
    };
    const wfs = await api('/api/workflows');
    const wf = (Array.isArray(wfs) ? wfs : []).sort((a, b) => (b.steps?.length ?? 0) - (a.steps?.length ?? 0))[0];
    const convs = await api('/api/conversations');
    const list = Array.isArray(convs) ? convs : convs?.conversations ?? [];
    const conv = list.find((c) => c.channel === 'email' && c.unread) ?? list[0];
    const site = (await api('/api/funnels')).find?.((f) => f.kind === 'website');
    if (wf?.id) await shot(`workflows/${wf.id}`, 'shot-workflow.webp');
    await shot(conv?.id ? `conversations/${conv.id}` : 'conversations', 'shot-inbox.webp');
    if (site?.id) await shot(`funnels/${site.id}`, 'shot-funnel.webp', 1800);
    // The pipeline board. (An AI agent screen needs a configured model, which a fresh demo does not have.)
    await shot('opportunities', 'shot-pipeline.webp', 1500);
    const save = async (file, png) => (writeFileSync(join(out, file), await toWebp(png ?? (await page.screenshot()))), console.log(`  ${file}`));
    await focusBriefing(page, `${base}/app/focus?loc=${agency}`);
    await save('shot-jarvis.webp');
    const board = await salesBoard(context, base, agency);
    await xrPreview(page, `${base}/app/boards/${board.id}?loc=${agency}`);
    await save('shot-xr.webp');
    await save('shot-themes.webp', await themeCollage({ browser, context, base, loc: agency, lang: 'en' }));
    await context.close();
    // The Academy and its tours are German: the whole screen in German, so it does not mix languages.
    const de = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    await de.request.post(`${base}/api/auth/login`, { data: { email: 'demo@example.com', password: 'demo1234' }, headers: { 'x-pghl': '1' } });
    await tidy(de, base);
    const dp = await de.newPage();
    await academyTour(dp, `${base}/app/academy?loc=${agency}`);
    writeFileSync(join(out, 'shot-academy.webp'), await toWebp(await dp.screenshot()));
    console.log('  shot-academy.webp');
    await endTour(dp);
    await de.close();
  } finally {
    server.kill('SIGTERM');
    rmSync(data, { recursive: true, force: true });
  }
}

// --- social cards ----------------------------------------------------------------------------------------------------------
const font = readFileSync(join(out, 'inter-tight-latin-wght-normal.woff2')).toString('base64');
const CARDS = {
  en: { eyebrow: 'Open source · Self-host free · Cloud from €49.99', h1: 'The free, open-source growth OS for agentic solopreneurs, agencies, small businesses & startups', sub: 'CRM, funnels, automations and Jarvis, your AI business developer.', badges: ['Self-host: $0', 'Cloud from €49.99', 'MCP: Claude, ChatGPT, Codex, Cursor'] },
  de: { eyebrow: 'Open Source · Selbst gehostet kostenlos · Cloud ab 49,99 €', h1: 'Das freie Open-Source-Wachstums-Betriebssystem für agentische Solopreneure, Agenturen, kleine Unternehmen und Startups', sub: 'CRM, Funnels, Automationen und Jarvis, dein KI-Business-Developer.', badges: ['Selbst gehostet: 0 €', 'Cloud ab 49,99 €', 'Gehostet in Frankfurt'] },
};
// Cloud waitlist mode (docs/landing.md#cloud-waitlist-mode): the cloud is not on offer yet, so no cloud price and no "hosted in".
const CARDS_WAITLIST = {
  en: { ...CARDS.en, eyebrow: 'Open source · Self-host free · Cloud coming soon', badges: ['Self-host: $0', 'Cloud: waitlist open', 'MCP: Claude, ChatGPT, Codex, Cursor'] },
  de: { ...CARDS.de, eyebrow: 'Open Source · Selbst gehostet kostenlos · Cloud bald verfügbar', badges: ['Selbst gehostet: 0 €', 'Cloud: Warteliste offen', 'Dein Server, deine Daten'] },
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
for (const [prefix, lang, c] of [...Object.entries(CARDS).map(([l, x]) => ['', l, x]), ...Object.entries(CARDS_WAITLIST).map(([l, x]) => ['waitlist-', l, x])]) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
@font-face{font-family:D;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:radial-gradient(900px 420px at 92% -10%,#1d3a8a 0%,rgba(29,58,138,0) 62%),#0a1430;color:#f4f4ef;font-family:D,system-ui,sans-serif;letter-spacing:.01em;padding:58px 64px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:14px;font:600 26px D;letter-spacing:-.01em}.mk{width:46px;height:46px;border-radius:12px}
.eb{color:#f3c983;font-weight:500;font-size:22px;letter-spacing:.03em;margin:34px 0 16px}
h1{font:600 ${lang === 'de' ? 52 : 58}px/1.08 D;letter-spacing:-.022em;margin:0;max-width:1070px}
p{font-size:26px;color:#c3c8d3;margin:20px 0 0;max-width:1000px}
.b{display:flex;gap:12px;margin-top:auto}.b span{border:1px solid #ffffff33;border-radius:999px;padding:9px 18px;font-weight:500;font-size:20px;color:#dfe3ea}.b span:first-child{background:linear-gradient(180deg,#ffc56a,#ffb547);color:#0a1430;border-color:#ffb547}
.u{position:absolute;right:64px;top:72px;font:500 22px D;color:#aeb4c2}
</style></head><body><div class="top"><img class="mk" src="${MARK}" alt="">HyperLevel</div><div class="eb">${esc(c.eyebrow)}</div><h1>${esc(c.h1)}</h1><p>${esc(c.sub)}</p><div class="b">${c.badges.map((b) => `<span>${esc(b)}</span>`).join('')}</div><div class="u">gohyperlevel.com</div></body></html>`);
  await page.waitForTimeout(300);
  writeFileSync(join(out, `og-${prefix}${lang}.png`), await page.screenshot({ type: 'png' }));
  console.log(`  og-${prefix}${lang}.png`);
  await page.close();
}
// "Replaces your stack" as a card (top rows + the total bar) for X and LinkedIn.
const stackFile = join(out, 'replaces.json');
if (existsSync(stackFile)) {
  const st = JSON.parse(readFileSync(stackFile, 'utf8'));
  for (const lang of ['de', 'en']) {
    const fmt = (n, c) => new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-GB', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
    const rows = st.rows.filter((r) => r.coverage !== 'unique' && r.in_total !== false).slice(0, 10).concat(st.rows.filter((r) => r.coverage === 'unique').slice(0, 1));
    const tr = rows
      .map((r) => {
        const chips = r.tools.slice(0, 3).map((t) => `<i>${esc(t.name)}</i>`).join('');
        const price = r.min_price != null ? `${lang === 'de' ? 'ab' : 'from'} ${fmt(r.min_price, r.min_currency)}` : '–';
        const cov = r.coverage === 'full' ? `<b class="f">✓ ${lang === 'de' ? 'Inklusive' : 'Included'}</b>` : r.coverage === 'partial' ? `<b class="p">◐ ${lang === 'de' ? 'Teilweise' : 'Partly'}</b>` : `<b class="u">★ ${lang === 'de' ? 'Selbst hostbar nur hier' : 'Self-hostable only here'}</b>`;
        return `<tr><th>${esc(lang === 'de' ? r.label_de : r.label_en)}</th><td>${chips}</td><td class="pr">${r.coverage === 'unique' ? '' : price}</td><td>${cov}</td></tr>`;
      })
      .join('');
    const total = st.totals?.combined_eur_estimate ? `${lang === 'de' ? 'ab ca.' : 'from about'} ${fmt(Math.round(st.totals.combined_eur_estimate), 'EUR')}` : '';
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><head><style>
@font-face{font-family:D;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#f6f5ef;color:#0a1430;font-family:D,system-ui,sans-serif;letter-spacing:.01em;padding:30px 40px;display:flex;flex-direction:column}
h1{font:600 40px/1.1 D;margin:0 0 14px;letter-spacing:-.02em}h1 span{color:#b26b00}
table{width:100%;border-collapse:collapse;font-size:17px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #dedcd2}tr:nth-child(even){background:#efede4}
th{font-weight:550}i{font-style:normal;border:1px solid #cfccc0;border-radius:99px;padding:1px 9px;margin-right:5px;font-size:14px;font-weight:600;background:#fff;white-space:nowrap;display:inline-block}
.pr{font-weight:500;white-space:nowrap}b{border-radius:99px;padding:2px 10px;font-size:14px;white-space:nowrap}.f{color:#16794a;font-weight:550}.p{color:#8a5a00;font-weight:550}.u{color:#b26b00;font-weight:550}
.bar{margin-top:auto;display:grid;grid-template-columns:1fr auto 1fr;background:#0a1430;color:#f4f4ef;border-radius:16px;overflow:hidden}.bar div{padding:12px 20px}.bar small{display:block;color:#aeb4c2;font-weight:500;font-size:14px}.bar strong{font:600 34px D;letter-spacing:-.02em}
.bar .ar{font:500 34px D;color:#f3c983;align-self:center}.bar .us{background:#12204a}.bar .us strong{color:#f3c983}
.foot{font-size:12px;color:#545a66;margin-top:6px}
</style></head><body><h1>${lang === 'de' ? 'Ersetzt deinen <span>Tool-Stack</span>' : 'Replaces your <span>stack</span>'}</h1><table>${tr}</table>
<div class="bar"><div><small>${lang === 'de' ? `Tool-Stack · alle ${st.totals?.rows_priced ?? ''} Funktionen mit Preis · günstigstes Tool je Zeile` : `Tool stack · all ${st.totals?.rows_priced ?? ''} priced functions · cheapest tool per row`}</small><strong>${total}</strong>${lang === 'de' ? ' / Monat' : ' / month'}</div><div class="ar">→</div><div class="us"><small>HyperLevel</small><strong>${lang === 'de' ? '0 €' : '$0'}</strong> ${lang === 'de' ? '(selbst gehostet) · Cloud ab 49,99 €' : '(self-hosted) · cloud from €49.99'}</div></div>
<div class="foot">${lang === 'de' ? `Einstiegspreise laut Anbieter-Webseiten, Stand ${st.as_of} · unabhängiges Open-Source-Projekt, nicht mit den genannten Anbietern verbunden · gohyperlevel.com` : `Entry prices per the vendors' websites, as of ${st.as_of} · independent open-source project, not affiliated with the vendors named · gohyperlevel.com`}</div></body></html>`);
    await page.waitForTimeout(300);
    writeFileSync(join(out, `og-stack-${lang}.png`), await page.screenshot({ type: 'png' }));
    console.log(`  og-stack-${lang}.png`);
    await page.close();
  }
}
await browser.close();

writeFileSync(join(out, 'stats.json'), `${JSON.stringify({ tests: countTests(join(root, 'tests')) })}\n`);
console.log(`Done → ${out}`);
