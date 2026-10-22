import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { Module } from '../core/app.js';
import { html, notFound, redirect, type Ctx, type RawResult } from '../core/http.js';
import { PERMISSIONS } from '../core/permissions.js';
import { PLAN_INFO, defaultSettings } from '../services/cloud.js';
import { CATALOG } from '../services/integrations-catalog.js';
import { WAITLIST_ANCHOR } from '../services/cloud-waitlist.js';
import { hasCalcQuery, parseCalc } from '../services/landing-calc.js';
import { MIX, mixTools, parseMatrix, type Matrix } from '../services/landing-compare.js';
import { parseStack } from '../services/landing-stack.js';
import type { Lang } from '../services/landing-copy.js';
import { CSP, defaultCalc, pagePath, renderLanding, sitemapXml, type LandingData, type PageKind, type Shot } from '../services/landing-page.js';
import { getBranding } from './agency.js';
import { cloudEnabled, cloudSettings } from './cloud.js';
import { TOOLS } from './mcp.js';

/**
 * The public launch landing page (PGHL_LANDING=1, off by default): `/` (English), `/de`, `/vergleich`, `/vergleich/highlevel`
 * (and their /de twins) and `/sitemap.xml`, only on the instance's own host (PGHL_BASE_URL, its www twin, or the hosts in
 * PGHL_LANDING_HOSTS). Any other host – a client's white-label login domain, a cloud sub-domain – keeps going to the app.
 * Without the flag none of these routes exist and `/` stays the web app.
 *
 * Data: prices from the cloud settings (or the list prices), the product name from the agency branding (the shipped default
 * shows as HyperLevel), counts from the running code, the latest Android APK, the GitHub star count (fetched in the
 * background, cached, hidden when unavailable), the comparison research (competitors.json, replaces.json) and screenshots
 * from web/public/landing/.
 * Cloud waitlist mode (modules/cloud-waitlist.ts): the page leads with self-hosting and shows the waitlist form instead of selling
 * the cloud; `?wl=` carries the result of a form post, `?plan=` preselects a plan.
 * Docs: docs/landing.md.
 */

const PRODUCT = 'HyperLevel';
const STARS_API = 'https://api.github.com/repos/gohyperlevel/gohyperlevel';
const STARS_TTL = 6 * 3600_000;
/** Screenshots of the demo in the hero, in the order of the copy's alt texts (scripts/landing-assets.mjs makes them). */
const SHOTS = ['shot-workflow.webp', 'shot-inbox.webp', 'shot-funnel.webp', 'shot-pipeline.webp'];

export const landingEnabled = () => process.env.PGHL_LANDING === '1';

const ROUTES: [PageKind, Lang][] = (['home', 'compare', 'highlevel'] as PageKind[]).flatMap((k) => (['en', 'de'] as Lang[]).map((l) => [k, l] as [PageKind, Lang]));

export const landingModule: Module = {
  name: 'landing',
  register(app) {
    if (!landingEnabled()) return;
    const { router } = app;
    const baseHost = () => new URL(app.config.baseUrl).hostname.toLowerCase();
    const hosts = () => {
      const own = baseHost();
      const extra = String(process.env.PGHL_LANDING_HOSTS ?? '')
        .split(/[\s,;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      return new Set([own, own.startsWith('www.') ? own.slice(4) : `www.${own}`, 'localhost', '127.0.0.1', ...extra]);
    };
    const onLandingHost = (ctx: Ctx) => hosts().has(String(ctx.req.headers.host ?? '').split(':')[0].toLowerCase());

    // --- files next to the build (dist-web/landing) or, in development, in the repository (web/public/landing) -------------
    const fileOf = (name: string) => [join(app.config.webDir, 'landing', name), join(process.cwd(), 'web/public/landing', name)].find((f) => existsSync(f));
    const jsonCache = new Map<string, { mtime: number; value: unknown }>();
    const readJson = (name: string): unknown => {
      const f = fileOf(name);
      if (!f) return undefined;
      const mtime = statSync(f).mtimeMs;
      const hit = jsonCache.get(name);
      if (hit && hit.mtime === mtime) return hit.value;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
        value = undefined;
      }
      jsonCache.set(name, { mtime, value });
      return value;
    };
    const matrix = (): Matrix | undefined => parseMatrix(readJson('competitors.json'));
    const shots = (): Shot[] => SHOTS.filter((n) => fileOf(n)).map((n) => ({ src: `/landing/${n}`, w: 1440, h: 900 }));

    // --- GitHub stars: fetched in the background, never on the request path ------------------------------------------------
    const stars: { n?: number; at: number; busy?: Promise<void> } = { at: 0 };
    const refreshStars = (force = false): Promise<void> => {
      if (stars.busy) return stars.busy;
      if (!force && Date.now() - stars.at < STARS_TTL) return Promise.resolve();
      const f: typeof fetch = app.services.landingFetch ?? fetch;
      stars.busy = f(STARS_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'gohyperlevel-landing' }, signal: AbortSignal.timeout(5000) })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: any) => {
          if (typeof j?.stargazers_count === 'number' && j.stargazers_count >= 0) stars.n = j.stargazers_count;
        })
        .catch(() => undefined)
        .finally(() => {
          stars.at = Date.now();
          stars.busy = undefined;
        });
      return stars.busy;
    };

    // --- counts: from the running code (tests: from the build, web/public/landing/stats.json) ------------------------------
    const stats = () => {
      const tests = Number((readJson('stats.json') as { tests?: number } | undefined)?.tests);
      return {
        areas: Object.keys(PERMISSIONS).length,
        tools: TOOLS.length + ((app.services.mcpTools as unknown[] | undefined)?.length ?? 0),
        integrations: CATALOG.length + ((app.services.catalogExtra as unknown[] | undefined)?.length ?? 0),
        tests: Number.isInteger(tests) && tests > 0 ? tests : undefined,
      };
    };

    const qrCache = new Map<string, string>();
    const qr = async (url: string) => {
      if (!qrCache.has(url)) qrCache.set(url, (await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0d12', light: '#ffffff' } })).replace(/<\?xml[^>]*>/, ''));
      return qrCache.get(url)!;
    };

    const brand = () => {
      const n = getBranding(app).name;
      return n && n !== 'HyperLevel' ? n : PRODUCT;
    };
    const prices = () => {
      const s = cloudEnabled(app) ? cloudSettings(app) : defaultSettings({});
      return { prices: { solo: s.prices.solo ?? PLAN_INFO.solo.price_month_cents, team: s.prices.team ?? PLAN_INFO.team.price_month_cents, agency: s.prices.agency ?? PLAN_INFO.agency.price_month_cents }, yearly: s.yearly_discount_percent };
    };
    const legal = () =>
      cloudEnabled(app)
        ? { imprint: '/cloud/legal/impressum', privacy: '/cloud/legal/datenschutz' }
        : { imprint: process.env.PGHL_LANDING_IMPRESSUM_URL || undefined, privacy: process.env.PGHL_LANDING_PRIVACY_URL || undefined };

    const page = async (ctx: Ctx, kind: PageKind, lang: Lang): Promise<RawResult> => {
      if (!onLandingHost(ctx)) return redirect('/app');
      void refreshStars();
      const base = app.baseUrl().replace(/\/$/, '');
      const m = matrix();
      const mix = mixTools(m);
      const q = ctx.query;
      const shared = hasCalcQuery(q) || q.has('m') || q.has('t');
      const keys = new Set(MIX.map((t) => t.key));
      const calc = shared
        ? { input: parseCalc(q), mode: (q.get('m') === 'hl' || !mix.length ? 'hl' : 'mix') as 'mix' | 'hl', mix: q.getAll('t').filter((t) => keys.has(t)), shared: true }
        : defaultCalc(mix);
      const apk = app.services.mobileAppInfo?.() as { version_name: string; size: number; sha256: string } | null | undefined;
      const p = prices();
      const home = pagePath('home', lang);
      const waitlist = app.services.cloudWaitlist?.enabled() ? app.services.cloudWaitlist.view({ lang, back: home, plan: q.get('plan'), state: q.get('wl') }) : undefined;
      const d: LandingData = {
        kind,
        lang,
        brand: brand(),
        base,
        prices: p.prices,
        yearlyDiscount: p.yearly,
        cloudUrl: waitlist ? `${home}#${WAITLIST_ANCHOR}` : cloudEnabled(app) ? '/cloud' : `${home === '/' ? '' : home}/#preise`,
        stars: stars.n,
        stats: stats(),
        apk: apk ? { version: apk.version_name, size: apk.size, sha256: apk.sha256 } : undefined,
        qr: kind === 'home' ? { android: await qr(`${base}/android`), ios: await qr(`${base}/app`) } : { android: '', ios: '' },
        matrix: m,
        stack: kind === 'home' ? parseStack(readJson('replaces.json')) : undefined,
        calc,
        legal: legal(),
        shots: shots(),
        waitlist,
      };
      const r = html(renderLanding(d, mix));
      r.headers['content-security-policy'] = CSP;
      // The result of a waitlist post (?wl=…) is for this visitor only.
      r.headers['cache-control'] = q.has('wl') ? 'no-store' : 'public, max-age=300';
      r.headers['x-frame-options'] = 'DENY';
      r.headers['content-language'] = lang;
      return r;
    };

    for (const method of ['GET', 'HEAD']) {
      for (const [kind, lang] of ROUTES) router.add(method, pagePath(kind, lang), 'public', (ctx) => page(ctx, kind, lang));
      // Old or guessed English addresses.
      router.add(method, '/en', 'public', (ctx) => (onLandingHost(ctx) ? redirect('/', 301) : redirect('/app')));
      router.add(method, '/sitemap.xml', 'public', (ctx) => {
        if (!onLandingHost(ctx)) throw notFound();
        const base = app.baseUrl().replace(/\/$/, '');
        return { __raw: true, status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' }, body: sitemapXml(base, cloudEnabled(app) ? ['/cloud'] : []) } satisfies RawResult;
      });
    }
    // robots.txt (modules/root-files.ts) names the sitemap.
    app.services.robotsExtra = [...((app.services.robotsExtra as (() => string[])[] | undefined) ?? []), () => [`Sitemap: ${app.baseUrl().replace(/\/$/, '')}/sitemap.xml`]];
    app.services.landing = { refreshStars, stats, matrix };
  },
};
