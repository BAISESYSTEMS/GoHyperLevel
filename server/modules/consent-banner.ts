import type { App, Module } from '../core/app.js';
import { HttpError, html, num, type Ctx, type RawResult } from '../core/http.js';
import { sealSettings } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import { attributionConsent, applyCmp, cleanCmp, cmpCookie, OPTIONAL, parseChoice, previewHtml, placeholderLabels, wordingKey, CMP_COOKIE, DEFAULT_CMP, type BannerUrls, type Choice, type CmpSettings, type Optional } from '../services/cmp.js';
import { ipNetwork, uaHash } from '../services/consent-model.js';
import { grantConsent, eventsOf, revokeConsent, type EventRow } from '../services/consent.js';
import { CONSENT_COOKIE, VISITOR_COOKIE } from '../services/attribution.js';

/**
 * Cookie consent banner (CMP) for funnels, websites, blog, forms, booking pages, buy pages, community pages and the member
 * portal – no third-party CMP. One banner for everything: it replaces the older banner of the attribution module (which asks the
 * CMP for its consent state when the CMP is on). What it does:
 *  - blocks the owner's own code (head code, HTML blocks, pixels, video/map embeds) until the visitor allowed its category
 *    (statistics, marketing, external media) – `type="text/plain" data-category="…"`, see services/cmp.ts;
 *  - sends Google Consent Mode v2 signals ("denied" first, the choice as an update);
 *  - keeps a consent log (pseudonymous id, version, choice, IP network, browser fingerprint) and, when the visitor becomes a
 *    contact, writes the choice into that contact's ledger (channel "Tracking");
 *  - a re-open tab and `href="#cookie-settings"` links to change or withdraw the choice.
 * The buttons are plain links on the page itself (`?pghl_cmp=accept|reject|save|allow|open`): the server sets the cookie and
 * redirects back, so it works on the sandboxed funnel pages and without JavaScript.
 */

export const consentBannerModule: Module = {
  name: 'consent-banner',
  migrations: [
    [
      '001-log',
      `
      CREATE TABLE cmp_log (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        cid TEXT NOT NULL, version INTEGER NOT NULL, choice TEXT NOT NULL,
        statistics INTEGER NOT NULL DEFAULT 0, marketing INTEGER NOT NULL DEFAULT 0, external_media INTEGER NOT NULL DEFAULT 0,
        page TEXT NOT NULL DEFAULT '', ip_net TEXT NOT NULL DEFAULT '', ua_digest TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX cmp_log_loc ON cmp_log(location_id, created_at);
      CREATE INDEX cmp_log_cid ON cmp_log(location_id, cid);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;

    const settingsOf = (locationId: string): CmpSettings => cleanCmp(app.location(locationId)?.settings.cmp);
    const save = (locationId: string, next: CmpSettings) => {
      const loc = app.location(locationId)!;
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, cmp: next }).value), locationId);
    };

    const choiceOf = (ctx: Ctx, locationId: string): Choice => {
      const c = parseChoice(ctx.cookies[CMP_COOKIE], settingsOf(locationId).version);
      // Global Privacy Control without a decision: nothing optional until the visitor says otherwise.
      return c;
    };
    const gpc = (ctx: Ctx) => String(ctx.req.headers['sec-gpc'] ?? '') === '1';

    // --- what the other modules ask --------------------------------------------------------------------------------------
    app.services.cmp = {
      settings: settingsOf,
      active: (locationId: string) => settingsOf(locationId).enabled,
      choiceOf,
      /** The attribution module: may it set its first-party cookie? (statistics or marketing allowed). */
      attributionConsent: (ctx: Ctx, locationId: string) => (gpc(ctx) && !parseChoice(ctx.cookies[CMP_COOKIE], settingsOf(locationId).version).decided ? 'denied' : attributionConsent(choiceOf(ctx, locationId))),
    };

    // --- finding the sub-account of a public page ----------------------------------------------------------------------------
    const locate = (path: string): string | undefined => {
      let m: RegExpMatchArray | null;
      if ((m = path.match(/^\/p\/([^/]+)/))) return db.get<{ location_id: string }>('SELECT location_id FROM funnels WHERE slug = ?', m[1])?.location_id;
      if ((m = path.match(/^\/f\/([^/]+)$/))) return db.get<{ location_id: string }>('SELECT location_id FROM forms WHERE id = ?', m[1])?.location_id;
      if ((m = path.match(/^\/book\/([^/]+)$/))) return db.get<{ location_id: string }>('SELECT location_id FROM calendars WHERE slug = ?', m[1])?.location_id;
      if ((m = path.match(/^\/buy\/([^/]+)(?:\/danke)?$/)))
        return (db.get<{ location_id: string }>('SELECT location_id FROM products WHERE id = ?', m[1]) ?? db.get<{ location_id: string }>('SELECT p.location_id FROM products p JOIN stripe_product_links l ON l.product_id = p.id WHERE l.slug = ?', m[1].toLowerCase()))?.location_id;
      if ((m = path.match(/^\/c\/([^/]+)(?:\/join)?$/))) return db.get<{ location_id: string }>('SELECT location_id FROM community_pages WHERE slug = ?', m[1])?.location_id;
      if ((m = path.match(/^\/portal\/([^/]+)/))) return db.get<{ location_id: string }>('SELECT location_id FROM course_portals WHERE slug = ? OR location_id = ?', m[1], m[1])?.location_id ?? (app.location(m[1]) ? m[1] : undefined);
      return undefined;
    };

    // --- the decision ------------------------------------------------------------------------------------------------------
    const hits = new Map<string, number[]>();
    const logLimited = (ip: string) => {
      const t = Date.now();
      const l = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
      l.push(t);
      hits.set(ip, l);
      if (hits.size > 20_000) hits.clear();
      return l.length > 30;
    };

    /** The page's own address without the banner's parameters – where the visitor goes back to. */
    const backUrl = (ctx: Ctx) => {
      const q = new URLSearchParams(ctx.url.search);
      for (const k of [...q.keys()]) if (/^pghl_(cmp|s|m|e|c)$/.test(k)) q.delete(k);
      const qs = q.toString();
      return `${ctx.url.pathname}${qs ? `?${qs}` : ''}`;
    };

    /** Applies ?pghl_cmp=… : cookie, log, redirect back. Returns false for anything that is not a banner action. */
    const decide = (ctx: Ctx, r: RawResult, locationId: string, s: CmpSettings, current: Choice): boolean => {
      const action = ctx.query.get('pghl_cmp');
      if (!action || action === 'open') return false;
      // Only a visitor's own navigation counts: not an <img>, <script> or <iframe> of another site pointing here.
      const dest = String(ctx.req.headers['sec-fetch-dest'] ?? '');
      if (dest && dest !== 'document') {
        r.status = 403;
        r.headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
        r.body = 'Nur über die Seite selbst';
        return true;
      }
      let granted: Record<Optional, boolean>;
      let choice: 'accept_all' | 'reject_all' | 'custom';
      if (action === 'accept') (granted = { statistics: true, marketing: true, external_media: true }), (choice = 'accept_all');
      else if (action === 'reject') (granted = { statistics: false, marketing: false, external_media: false }), (choice = 'reject_all');
      else if (action === 'save') {
        granted = { statistics: ctx.query.get('pghl_s') === '1', marketing: ctx.query.get('pghl_m') === '1', external_media: ctx.query.get('pghl_e') === '1' };
        choice = granted.statistics && granted.marketing && granted.external_media ? 'accept_all' : !granted.statistics && !granted.marketing && !granted.external_media ? 'reject_all' : 'custom';
      } else if (action === 'allow') {
        const cat = ctx.query.get('pghl_c');
        if (!(OPTIONAL as readonly string[]).includes(cat ?? '')) return false;
        granted = { ...current.granted, [cat as Optional]: true };
        choice = 'custom';
      } else return false;
      const cid = current.cid || id(16);
      const days = s.expiry_days * 86400;
      ctx.setCookie(CMP_COOKIE, cmpCookie(s.version, granted, cid), { maxAge: days, httpOnly: false });
      // The older attribution cookie keeps working for the tracking snippet on other sites: statistics or marketing allowed = yes.
      ctx.setCookie(CONSENT_COOKIE, granted.statistics || granted.marketing ? '1' : '0', { maxAge: 365 * 86400, httpOnly: false });
      if (!granted.statistics && !granted.marketing) ctx.setCookie(VISITOR_COOKIE, '', { maxAge: 0 });
      if (!logLimited(ctx.ip)) {
        db.insert('cmp_log', { id: id(), location_id: locationId, cid, version: s.version, choice, statistics: +granted.statistics, marketing: +granted.marketing, external_media: +granted.external_media, page: `${ctx.req.headers.host ?? ''}${ctx.url.pathname}`.slice(0, 300), ip_net: ipNetwork(ctx.ip), ua_digest: uaHash(ctx.req.headers['user-agent']), created_at: now() });
      }
      r.status = 303;
      r.headers = { location: backUrl(ctx), 'cache-control': 'no-store' };
      r.body = '';
      return true;
    };

    // --- the page ------------------------------------------------------------------------------------------------------------
    app.services.htmlTransforms = [
      ...(app.services.htmlTransforms ?? []),
      (ctx: Ctx, r: RawResult) => {
        if (ctx.query.get('embed') === '1' || String(ctx.req.headers['sec-fetch-dest'] ?? '') === 'iframe') return;
        const locationId = locate(ctx.path);
        if (!locationId) return;
        const s = settingsOf(locationId);
        if (!s.enabled) return;
        const current = choiceOf(ctx, locationId);
        if (decide(ctx, r, locationId, s, current)) return;
        const open = ctx.query.get('pghl_cmp') === 'open';
        const back = backUrl(ctx);
        const sep = back.includes('?') ? '&' : '?';
        const urls: BannerUrls = {
          action: (a, cat) => `${back}${sep}pghl_cmp=${a}${cat ? `&pghl_c=${cat}` : ''}`,
          formAction: ctx.url.pathname,
          hidden: [...new URLSearchParams(back.split('?')[1] ?? '').entries()],
        };
        const selfHosts = [new URL(app.config.baseUrl).hostname, String(ctx.req.headers.host ?? '').split(':')[0]];
        const out = applyCmp(String(r.body), {
          settings: s,
          choice: current,
          showBanner: open || !current.decided,
          urls,
          reopenHref: `${back}${sep}pghl_cmp=open`,
          granted: current.granted,
          selfHosts,
          unknown: s.unknown_scripts,
          allowLink: (cat) => urls.action('allow', cat),
          labels: placeholderLabels(s),
        });
        r.body = out.html;
        // The page now depends on the visitor's cookie: nobody may cache it for somebody else.
        if (!/no-store/.test(r.headers['cache-control'] ?? '')) r.headers['cache-control'] = 'private, no-cache';
        r.headers.vary = [r.headers.vary, 'Cookie'].filter(Boolean).join(', ');
      },
    ];

    // --- the visitor became a contact: the choice goes into the ledger (channel "Tracking") ---------------------------------
    app.services.consent.linkCmp = (ctx: Ctx | undefined, locationId: string, contactId: string) => {
      if (!ctx) return;
      try {
        const s = settingsOf(locationId);
        const c = parseChoice(ctx.cookies[CMP_COOKIE], s.version);
        if (!s.enabled || !c.decided) return;
        const events = eventsOf(app, contactId, 'tracking');
        const last = (p: string): EventRow | undefined => [...events].reverse().find((e) => e.purpose === p && (e.action === 'granted' || e.action === 'revoked'));
        for (const p of OPTIONAL) {
          const was = last(p);
          if (c.granted[p] && was?.action !== 'granted') {
            grantConsent(app, { locationId, contactId, channel: 'tracking', purposes: [p], source: { kind: 'cmp', id: c.cid, label: `Cookie-Banner (Version ${s.version})` }, text: { key: `cmp:${p}`, text: `${s.categories[p].label}: ${s.categories[p].description}` }, note: `Entscheidung im Cookie-Banner, Protokoll-ID ${c.cid}`, meta: { ip_net: ipNetwork(ctx.ip), ua_digest: uaHash(ctx.req.headers['user-agent']) }, actor: 'contact' });
          } else if (!c.granted[p] && was?.action === 'granted') {
            revokeConsent(app, { locationId, contactId, channel: 'tracking', purposes: [p], source: { kind: 'cmp', id: c.cid, label: 'Cookie-Banner' }, actor: 'contact', note: `Entscheidung im Cookie-Banner, Protokoll-ID ${c.cid}` });
          }
        }
      } catch (e) {
        console.error('[cmp] link:', (e as Error).message);
      }
    };

    // --- admin API ---------------------------------------------------------------------------------------------------------------
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    router.get('/api/cmp/settings', 'location', (ctx) => ({ settings: settingsOf(ctx.locationId), defaults: DEFAULT_CMP, reopen_link: '<a href="#cookie-settings">Cookie-Einstellungen</a>' }));
    router.put('/api/cmp/settings', 'location', (ctx) => {
      writable(ctx);
      const cur = settingsOf(ctx.locationId);
      const b = ctx.body ?? {};
      const merged = {
        ...cur,
        ...b,
        categories: Object.fromEntries(Object.keys(cur.categories).map((k) => [k, { ...(cur.categories as any)[k], ...(b.categories?.[k] ?? {}) }])),
        colors: { ...cur.colors, ...(b.colors ?? {}) },
        reopen: { ...cur.reopen, ...(b.reopen ?? {}) },
        version: cur.version,
      };
      const next = cleanCmp(merged);
      // New wording or categories: everybody is asked again.
      if (wordingKey(next) !== wordingKey(cur)) next.version = cur.version + 1;
      save(ctx.locationId, next);
      return { settings: next };
    });
    router.post('/api/cmp/reask', 'location', (ctx) => {
      writable(ctx);
      const cur = settingsOf(ctx.locationId);
      const next = { ...cur, version: cur.version + 1 };
      save(ctx.locationId, next);
      return { settings: next };
    });
    /** The editor's preview: a page with the banner as the posted draft would show it. */
    router.post('/api/cmp/preview', 'location', (ctx) => {
      const draft = cleanCmp({ ...settingsOf(ctx.locationId), ...(ctx.body?.settings ?? {}), enabled: true });
      const r = html(previewHtml(draft, { decided: false, stale: false, granted: { statistics: false, marketing: false, external_media: false }, cid: '' }));
      r.headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";
      r.headers['cache-control'] = 'no-store';
      return r;
    });
    router.get('/api/cmp/log', 'location', (ctx) => {
      const limit = Math.min(Math.max(num(ctx.query.get('limit'), 100), 1), 500);
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const stats = db.all<{ choice: string; n: number }>('SELECT choice, COUNT(*) n FROM cmp_log WHERE location_id = ? AND created_at >= ? GROUP BY choice', ctx.locationId, since);
      return { rows: db.all('SELECT id, cid, version, choice, statistics, marketing, external_media, page, ip_net, created_at FROM cmp_log WHERE location_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', ctx.locationId, limit), last_30_days: Object.fromEntries(stats.map((x) => [x.choice, Number(x.n)])) };
    });

    // Proof of consent is kept for three years, then it goes.
    let cleaned = 0;
    app.onTick(() => {
      if (Date.now() - cleaned < 6 * 3600_000) return;
      cleaned = Date.now();
      db.run('DELETE FROM cmp_log WHERE created_at < ?', new Date(Date.now() - 3 * 365 * 864e5).toISOString());
    });
  },
};
