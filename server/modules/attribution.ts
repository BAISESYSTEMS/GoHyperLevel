import type { Module } from '../core/app.js';
import { toCsv } from '../core/csv.js';
import { bad, num, str, text, type Ctx, type RawResult } from '../core/http.js';
import { jsonForScript } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { zonedToUtc, ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import {
  CONSENT_COOKIE,
  UTM_KEYS,
  VISITOR_COOKIE,
  consentState,
  mayStore,
  parseTouch,
  sameSource,
  signVisitor,
  sourceLabel,
  verifyVisitor,
  type AttributionHook,
  type ConsentState,
  type CookieMode,
  type Touch,
  type TouchRow,
} from '../services/attribution.js';
import type { Tool } from './mcp.js';
import { sealSettings } from '../core/secrets.js';
import { paidRevenueSql } from '../services/invoice-model.js';

/**
 * Marketing attribution: where leads and customers come from.
 * - Funnel/website pages record the visit (UTM, gclid/fbclid, referrer, landing page) on the
 *   server and hand the page a signed visitor token; forms, bookings, chat and buy links send
 *   it back, so the new contact gets its first and last touch (plus the full history).
 * - A first-party cookie (pghl_vid) remembers visitors across visits – only with consent
 *   (default), always, or never, per sub-account. Sec-GPC and `pghl_consent=0` are respected.
 * - External websites use /a/<locationId>/t.js (same logic, cookie on the site itself).
 * Other modules hook in via app.services.attribution (visit/capture/checkout) and
 * app.services.attributionHooks (onTouch/onLink – the affiliate manager uses them).
 */

export interface AttributionSettings {
  enabled: boolean;
  cookie: CookieMode;
  cookie_days: number;
  banner: boolean;
  banner_text: string;
}

const DEFAULTS: AttributionSettings = {
  enabled: true,
  cookie: 'consent',
  cookie_days: 90,
  banner: false,
  banner_text: 'Wir merken uns mit einem eigenen Cookie (kein Fremd-Tracking), über welche Werbung oder Seite du zu uns gefunden hast.',
};
const REPEAT_MS = 30 * 60_000;
const GROUPS = ['source', 'source_medium', 'campaign', 'funnel'] as const;
type Group = (typeof GROUPS)[number];

const TOOLS: Tool[] = [
  {
    name: 'ghl_attribution_report',
    title: 'Attribution: Leads & Umsatz je Quelle',
    description:
      'Woher Leads, gewonnene Deals und Umsatz (bezahlte Rechnungen inkl. Stripe) kommen – je Quelle, Quelle/Medium, Kampagne (utm_campaign) oder Funnel. from/to als YYYY-MM-DD (Standard: letzte 30 Tage), model first|last (erster oder letzter Kontaktpunkt).',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        from: { type: 'string' },
        to: { type: 'string' },
        group: { type: 'string', enum: [...GROUPS] },
        model: { type: 'string', enum: ['first', 'last'] },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => {
      const qs = new URLSearchParams();
      for (const k of ['from', 'to', 'group', 'model']) if (a[k]) qs.set(k, String(a[k]));
      return call.api('GET', `/api/attribution/report?${qs}`, { location: a.location_id });
    },
  },
];

/** Allowed redirect after the consent link: a path on the same site, never another host. */
const safeBack = (v: unknown) => {
  const s = String(v ?? '/');
  // Browsers drop tabs/newlines inside URLs ("/\t/evil.com" becomes "//evil.com"): no control characters at all.
  return s.startsWith('/') && !s.startsWith('//') && !/[\\\x00-\x1f\x7f]/.test(s) ? s.slice(0, 500) : '/';
};

export const attributionModule: Module = {
  name: 'attribution',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE attribution_touches (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        visitor_id TEXT, contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'visit', channel TEXT NOT NULL DEFAULT 'direct',
        source TEXT NOT NULL DEFAULT '', medium TEXT NOT NULL DEFAULT '', campaign TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '', term TEXT NOT NULL DEFAULT '',
        gclid TEXT NOT NULL DEFAULT '', fbclid TEXT NOT NULL DEFAULT '', click_id TEXT NOT NULL DEFAULT '',
        ref TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', landing_page TEXT NOT NULL DEFAULT '',
        funnel_id TEXT, page_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX attribution_touches_visitor ON attribution_touches(location_id, visitor_id, created_at);
      CREATE INDEX attribution_touches_contact ON attribution_touches(contact_id, created_at);
      CREATE TABLE attribution_visitors (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, visitor_id TEXT NOT NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        PRIMARY KEY (location_id, visitor_id)
      );
      CREATE TABLE attribution_contacts (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        first_touch_id TEXT, first_source TEXT NOT NULL DEFAULT '', first_medium TEXT NOT NULL DEFAULT '',
        first_campaign TEXT NOT NULL DEFAULT '', first_funnel_id TEXT, first_at TEXT,
        last_touch_id TEXT, last_source TEXT NOT NULL DEFAULT '', last_medium TEXT NOT NULL DEFAULT '',
        last_campaign TEXT NOT NULL DEFAULT '', last_funnel_id TEXT, last_at TEXT,
        touches INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE INDEX attribution_contacts_loc ON attribution_contacts(location_id);
      CREATE TABLE attribution_checkouts (
        session_id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        visitor_id TEXT, created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const hooks = (): AttributionHook[] => app.services.attributionHooks ?? [];

    const settingsOf = (locationId: string): AttributionSettings => {
      const s = { ...DEFAULTS, ...(app.location(locationId)?.settings.attribution ?? {}) };
      return { ...s, cookie: ['consent', 'always', 'never'].includes(s.cookie) ? s.cookie : 'consent', cookie_days: Math.min(Math.max(Math.round(num(s.cookie_days, 90)), 1), 730) };
    };
    // With the cookie banner (modules/consent-banner.ts) on, its choice decides (statistics or marketing allowed); otherwise the older consent cookie.
    const consentOf = (ctx: Ctx, locationId?: string): ConsentState =>
      (locationId && app.services.cmp?.active(locationId) ? (app.services.cmp.attributionConsent(ctx, locationId) as ConsentState) : undefined) ?? consentState(ctx.cookies[CONSENT_COOKIE], String(ctx.req.headers['sec-gpc'] ?? ''));
    /** Link previews and crawlers (they follow ad links with click ids) are not visitors. */
    const isBot = (ctx: Ctx) => /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|whatsapp|telegram|curl|wget|python-requests/i.test(String(ctx.req.headers['user-agent'] ?? ''));
    const secure = () => (app.config.baseUrl.startsWith('https://') ? '; Secure' : '');

    // --- core: record touches, link contacts -------------------------------------------------
    const lastTouch = (locationId: string, vid: string) =>
      db.get<TouchRow>('SELECT * FROM attribution_touches WHERE location_id = ? AND visitor_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', locationId, vid);

    function insertTouch(locationId: string, vid: string | null, t: Touch, kind: string, extra: { funnelId?: string; pageId?: string; contactId?: string | null } = {}): TouchRow {
      const { internal: _i, ...fields } = t;
      const row: TouchRow = { id: id(), location_id: locationId, visitor_id: vid, contact_id: extra.contactId ?? null, kind, funnel_id: extra.funnelId ?? null, page_id: extra.pageId ?? null, created_at: now(), ...fields };
      db.insert('attribution_touches', row);
      return row;
    }

    /** Keeps the per-contact summary (first touch, last non-direct touch) in step with the history. */
    function recompute(locationId: string, contactId: string) {
      const list = db.all<TouchRow>('SELECT * FROM attribution_touches WHERE location_id = ? AND contact_id = ? ORDER BY created_at, rowid', locationId, contactId);
      if (!list.length) return;
      const first = list[0];
      const last = [...list].reverse().find((t) => t.channel !== 'direct') ?? list[list.length - 1];
      db.run(
        `INSERT INTO attribution_contacts (contact_id, location_id, first_touch_id, first_source, first_medium, first_campaign, first_funnel_id, first_at,
           last_touch_id, last_source, last_medium, last_campaign, last_funnel_id, last_at, touches, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET first_touch_id = excluded.first_touch_id, first_source = excluded.first_source, first_medium = excluded.first_medium,
           first_campaign = excluded.first_campaign, first_funnel_id = excluded.first_funnel_id, first_at = excluded.first_at, last_touch_id = excluded.last_touch_id,
           last_source = excluded.last_source, last_medium = excluded.last_medium, last_campaign = excluded.last_campaign, last_funnel_id = excluded.last_funnel_id,
           last_at = excluded.last_at, touches = excluded.touches, updated_at = excluded.updated_at`,
        contactId, locationId, first.id, first.source, first.medium, first.campaign, first.funnel_id, first.created_at,
        last.id, last.source, last.medium, last.campaign, last.funnel_id, last.created_at, list.length, now(),
      );
    }

    /**
     * Records a visit for visitor `vid` (new id when empty) and returns the visitor id. Direct
     * visits and funnel-internal clicks only count as the visitor's very first touch; a reload of
     * the same source within 30 minutes is not a new touch.
     */
    function track(locationId: string, vidIn: string, t: Touch, info: { funnelId?: string; pageId?: string; ip?: string; userAgent?: string; persistent?: boolean }): string {
      const vid = vidIn || id(20);
      const last = vidIn ? lastTouch(locationId, vid) : undefined;
      const known = vidIn ? db.get('SELECT contact_id FROM attribution_visitors WHERE location_id = ? AND visitor_id = ?', locationId, vid) : undefined;
      let record = false;
      if (t.channel === 'direct' || t.internal) record = !last && !t.internal && info.persistent !== false;
      else record = !(last && sameSource(last, t) && Date.now() - Date.parse(last.created_at) < REPEAT_MS);
      // Page views without cookie and without a source leave nothing behind.
      if (record || vidIn)
        db.run(
          `INSERT INTO attribution_visitors (location_id, visitor_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(location_id, visitor_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
          locationId, vid, now(), now(),
        );
      if (record) {
        const row = insertTouch(locationId, vid, t, 'visit', { funnelId: info.funnelId, pageId: info.pageId, contactId: known?.contact_id ?? null });
        if (known?.contact_id) recompute(locationId, known.contact_id);
        for (const h of hooks()) {
          try {
            h.onTouch?.({ locationId, visitorId: vid, touch: row, ip: info.ip ?? '', userAgent: info.userAgent ?? '' });
          } catch (e) {
            console.error('[attribution] hook', e);
          }
        }
      }
      return vid;
    }

    const requestUrl = (ctx: Ctx) => {
      const proto = app.config.behindProxy && ctx.req.headers['x-forwarded-proto'] ? String(ctx.req.headers['x-forwarded-proto']).split(',')[0] : new URL(app.config.baseUrl).protocol.replace(':', '');
      return `${proto}://${String(ctx.req.headers.host ?? new URL(app.config.baseUrl).host)}${ctx.url.pathname}${ctx.url.search}`;
    };

    /**
     * A visitor opened one of our public pages (funnel page, buy page). Returns the signed token
     * the page hands to forms/bookings/chat; '' when the visitor said no or tracking is off.
     */
    function visit(ctx: Ctx, locationId: string, info: { funnelId?: string; pageId?: string; url?: string } = {}): string {
      const s = settingsOf(locationId);
      const state = consentOf(ctx, locationId);
      if (!s.enabled || state === 'denied' || isBot(ctx)) return '';
      const persistent = mayStore(s.cookie, state);
      const fromCookie = persistent ? verifyVisitor(app.config.secret, ctx.cookies[VISITOR_COOKIE]) : '';
      const t = parseTouch({ url: info.url ?? requestUrl(ctx), referrer: String(ctx.req.headers.referer ?? ''), selfHosts: [new URL(app.config.baseUrl).host] });
      const vid = track(locationId, fromCookie, t, { ...info, ip: ctx.ip, userAgent: String(ctx.req.headers['user-agent'] ?? ''), persistent: persistent || t.channel !== 'direct' });
      const tok = signVisitor(app.config.secret, vid);
      if (persistent) ctx.setCookie(VISITOR_COOKIE, tok, { maxAge: s.cookie_days * 86400 });
      return tok;
    }

    /**
     * A contact came out of a form, booking, chat or purchase: link the visitor's touches (token
     * from the page, else the cookie), add a touch for the conversion itself when it carries its
     * own source (UTM in the form's URL), and update first/last touch.
     */
    function capture(ctx: Ctx | undefined, locationId: string, contactId: string | null | undefined, kind: string, data: { attr?: unknown; page?: unknown; referrer?: unknown; params?: Record<string, unknown>; visitorId?: string } = {}) {
      // The visitor's cookie choice goes into the contact's consent ledger (channel "Tracking"), also when attribution itself is off.
      if (contactId) app.services.consent?.linkCmp?.(ctx, locationId, contactId);
      if (!contactId || !settingsOf(locationId).enabled) return;
      if (!getContact(app, locationId, contactId)) return;
      const state = ctx ? consentOf(ctx, locationId) : 'unknown';
      const vid = data.visitorId || verifyVisitor(app.config.secret, data.attr) || (ctx && state !== 'denied' ? verifyVisitor(app.config.secret, ctx.cookies[VISITOR_COOKIE]) : '');
      const params: Record<string, unknown> = {};
      for (const k of [...UTM_KEYS, 'gclid', 'fbclid', 'ref']) if (data.params?.[k] || data.params?.[`_${k}`]) params[k] = data.params[k] || data.params[`_${k}`];
      const t = parseTouch({ url: String(data.page ?? ''), params, referrer: String(data.referrer ?? ''), selfHosts: [new URL(app.config.baseUrl).host] });
      db.tx(() => {
        if (vid) {
          db.run('UPDATE attribution_touches SET contact_id = ? WHERE location_id = ? AND visitor_id = ? AND contact_id IS NULL', contactId, locationId, vid);
          db.run(
            `INSERT INTO attribution_visitors (location_id, visitor_id, contact_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(location_id, visitor_id) DO UPDATE SET contact_id = excluded.contact_id, last_seen_at = excluded.last_seen_at`,
            locationId, vid, contactId, now(), now(),
          );
        }
        const prev = db.get<TouchRow>('SELECT * FROM attribution_touches WHERE location_id = ? AND contact_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', locationId, contactId);
        const own = t.channel !== 'direct' && !t.internal;
        // The conversion's own source counts when it is new; a contact without any history gets at least this one.
        if ((own && !(prev && sameSource(prev, t))) || !prev) insertTouch(locationId, vid || null, t.internal ? { ...t, channel: 'direct', source: 'direct', medium: '(none)' } : t, kind, { contactId });
        recompute(locationId, contactId);
      });
      for (const h of hooks()) {
        try {
          h.onLink?.({ locationId, contactId, kind, visitorId: vid });
        } catch (e) {
          console.error('[attribution] hook', e);
        }
      }
    }

    /** A Stripe checkout started from a buy page: remember the visitor until the purchase arrives. */
    function checkout(ctx: Ctx, locationId: string, sessionId: string, attr?: unknown) {
      if (!settingsOf(locationId).enabled || consentOf(ctx, locationId) === 'denied') return;
      let vid = verifyVisitor(app.config.secret, attr) || verifyVisitor(app.config.secret, ctx.cookies[VISITOR_COOKIE]);
      // No token: the buy page's own URL (Referer) may still carry UTM or ?ref=.
      const t = parseTouch({ url: String(ctx.req.headers.referer ?? ''), selfHosts: [] });
      if (t.channel === 'campaign') vid = track(locationId, vid, t, { ip: ctx.ip, userAgent: String(ctx.req.headers['user-agent'] ?? '') });
      if (vid) db.run('INSERT OR REPLACE INTO attribution_checkouts (session_id, location_id, visitor_id, created_at) VALUES (?, ?, ?, ?)', sessionId, locationId, vid, now());
    }

    app.services.attribution = { visit, capture, checkout, recompute, settings: settingsOf, touchesOf: (locationId: string, contactId: string) => db.all<TouchRow>('SELECT * FROM attribution_touches WHERE location_id = ? AND contact_id = ? ORDER BY created_at, rowid', locationId, contactId) };

    // A buy-link purchase links the buyer to the visit that started the checkout.
    app.events.on('product.purchased', (e) => {
      if (!e.data.contactId || !e.data.sessionId) return;
      const row = db.get('SELECT * FROM attribution_checkouts WHERE session_id = ? AND location_id = ?', e.data.sessionId, e.locationId);
      capture(undefined, e.locationId, e.data.contactId, 'purchase', { visitorId: row?.visitor_id ?? '' });
    });
    // Data minimisation: visits nobody converted from are useless once the cookie has expired.
    let cleaned = 0;
    app.onTick(() => {
      if (Date.now() - cleaned < 3600_000) return;
      cleaned = Date.now();
      db.run('DELETE FROM attribution_checkouts WHERE created_at < ?', new Date(Date.now() - 7 * 864e5).toISOString());
      for (const { location_id } of db.all('SELECT DISTINCT location_id FROM attribution_visitors')) {
        const before = new Date(Date.now() - (settingsOf(location_id).cookie_days + 1) * 864e5).toISOString();
        db.run('DELETE FROM attribution_touches WHERE location_id = ? AND contact_id IS NULL AND created_at < ?', location_id, before);
        db.run('DELETE FROM attribution_visitors WHERE location_id = ? AND contact_id IS NULL AND last_seen_at < ?', location_id, before);
      }
    });

    // --- funnel pages: token for forms/bookings/chat/buy links, optional consent banner --------
    const tokenInto = (html: string, tok: string) => {
      const add = (url: string, q: string | undefined) => `${url}${q ? `${q}&` : '?'}_a=${encodeURIComponent(tok)}`;
      const base = escapeHtml(app.baseUrl());
      return html
        .replace(/(<form\b[^>]*class="pghl-form"[^>]*>)/g, `$1<input type="hidden" name="_attr" value="${escapeHtml(tok)}">`)
        .replace(/(src=")(\/book\/[^"?#]+)(\?[^"#]*)?"/g, (_m, a, u, q) => `${a}${add(u, q)}"`)
        .replace(new RegExp(`(href=")((?:${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?\\/buy\\/[^"?#]+)(\\?[^"#]*)?"`, 'g'), (_m, a, u, q) => `${a}${add(u, q)}"`)
        .replace('</head>', `<script>window.pghlAttr=${jsonForScript(tok)}</script></head>`);
    };
    // On the app's own host pages live under /p/<funnel>; on a connected domain at the root.
    const sitePrefix = (ctx: Ctx, funnel: any) => (ctx.url.pathname.startsWith('/p/') ? `/p/${funnel.slug}` : '');
    const banner = (s: AttributionSettings, prefix: string, back: string) => `
<div id="pghl-consent" style="position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;background:#111827;color:#fff;border-radius:12px;padding:14px 16px;z-index:2147483000;box-shadow:0 10px 30px rgba(0,0,0,.3);font:14px/1.45 system-ui,sans-serif">
${escapeHtml(s.banner_text)}
<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><a href="${escapeHtml(`${prefix}/pghl-consent?v=1&r=${encodeURIComponent(back)}`)}" style="background:#fff;color:#111827;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:600">Einverstanden</a><a href="${escapeHtml(`${prefix}/pghl-consent?v=0&r=${encodeURIComponent(back)}`)}" style="color:#fff;padding:8px 14px;border-radius:8px;text-decoration:underline">Nein, danke</a></div></div>`;

    app.services.pageVisit = [
      ...(app.services.pageVisit ?? []),
      (ctx: Ctx, funnel: any, page: any, html: string) => {
        const s = settingsOf(funnel.location_id);
        if (!s.enabled) return html;
        const tok = visit(ctx, funnel.location_id, { funnelId: funnel.id, pageId: page.id });
        let out = tok ? tokenInto(html, tok) : html;
        // One banner only: with the cookie banner on, this older one stays away.
        if (s.banner && s.cookie === 'consent' && !app.services.cmp?.active(funnel.location_id) && consentOf(ctx) === 'unknown') out = out.replace('</body>', `${banner(s, sitePrefix(ctx, funnel), `${ctx.url.pathname}${ctx.url.search}`)}</body>`);
        return out;
      },
    ];

    /** Sets the consent flag (and drops the visitor cookie on a no), then back to the page. */
    const consentRedirect = (query: URLSearchParams): RawResult => {
      const yes = query.get('v') === '1';
      const cookies = [`${CONSENT_COOKIE}=${yes ? '1' : '0'}; Path=/; Max-Age=${365 * 86400}; SameSite=Lax${secure()}`];
      if (!yes) cookies.push(`${VISITOR_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure()}`);
      return { __raw: true, status: 302, headers: { location: safeBack(query.get('r')), 'set-cookie': cookies as any, 'cache-control': 'no-store' }, body: '' };
    };
    app.services.sitePaths = [...(app.services.sitePaths ?? []), (_f: any, path: string, query: URLSearchParams) => (path === 'pghl-consent' ? consentRedirect(query) : undefined)];
    router.get('/a/consent', 'public', (ctx) => consentRedirect(ctx.query));

    // --- external websites: tracking snippet + touch endpoint ----------------------------------
    router.get('/a/:loc/t.js', 'public', (ctx) => {
      const loc = app.location(ctx.params.loc);
      const s = loc ? settingsOf(loc.id) : undefined;
      if (!loc || !s?.enabled) {
        const off = text('/* tracking off */', 'text/javascript; charset=utf-8');
        off.headers['cache-control'] = 'public, max-age=300';
        return off;
      }
      const js = `(function(){if(window.__pghlA)return;window.__pghlA=1;
var cur=document.currentScript,base=cur?new URL(cur.src).origin:'',loc=${jsonForScript(loc.id)},mode=${jsonForScript(s.cookie)},days=${s.cookie_days},K='${VISITOR_COOKIE}';
function ck(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):''}
function consent(){var c=window.pghlConsent;if(c===true||c===false)return c?'granted':'denied';c=ck('${CONSENT_COOKIE}');if(/^(0|no|false|denied|deny|none|necessary)$/i.test(c))return'denied';if(/^(1|yes|true|granted|all|marketing|statistics|analytics)$/i.test(c))return'granted';return navigator.globalPrivacyControl?'denied':'unknown'}
function may(s){return mode!=='never'&&s!=='denied'&&(mode==='always'||s==='granted')}
function save(t){if(may(consent()))document.cookie=K+'='+encodeURIComponent(t)+'; Path=/; Max-Age='+days*86400+'; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'')}
function deco(t){window.pghlAttr=t;var q=['/buy/','/f/','/book/'].map(function(p){return 'a[href^="'+base+p+'"],iframe[src^="'+base+p+'"]'}).join(',');document.querySelectorAll(q).forEach(function(el){var a=el.tagName==='A'?'href':'src',u=new URL(el.getAttribute(a),location.href);if(!u.searchParams.get('_a')){u.searchParams.set('_a',t);el.setAttribute(a,u.href)}})}
window.pghl={consent:function(v){window.pghlConsent=!!v;if(v&&window.pghlAttr)save(window.pghlAttr);if(!v)document.cookie=K+'=; Path=/; Max-Age=0'}};
var st=consent();if(st==='denied')return;
fetch(base+'/api/public/attribution/'+encodeURIComponent(loc)+'/touch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:may(st)?ck(K):'',url:location.href,referrer:document.referrer,consent:st,persistent:may(st)}),keepalive:true})
.then(function(r){return r.json()}).then(function(j){if(!j||!j.token)return;save(j.token);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){deco(j.token)});else deco(j.token)}).catch(function(){});
})();`;
      const r = text(js, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=300';
      return r;
    });

    const touchHits = new Map<string, number[]>();
    router.post('/api/public/attribution/:loc/touch', 'public', (ctx) => {
      const t0 = Date.now();
      const hits = (touchHits.get(ctx.ip) ?? []).filter((x) => t0 - x < 60_000);
      hits.push(t0);
      touchHits.set(ctx.ip, hits);
      if (touchHits.size > 20_000) touchHits.clear();
      if (hits.length > 120) return { token: '' };
      const loc = app.location(ctx.params.loc);
      if (!loc || !settingsOf(loc.id).enabled || isBot(ctx)) return { token: '' };
      const b = ctx.body ?? {};
      if (String(ctx.req.headers['sec-gpc'] ?? '') === '1' && b.consent !== 'granted') return { token: '' };
      const t = parseTouch({ url: str(b.url, 'URL', { max: 2000 }), referrer: str(b.referrer, 'Referrer', { max: 2000 }) });
      if (!t.landing_page) throw bad('URL fehlt');
      const vid = track(loc.id, verifyVisitor(app.config.secret, b.token), t, { ip: ctx.ip, userAgent: String(ctx.req.headers['user-agent'] ?? ''), persistent: !!b.persistent || t.channel !== 'direct' });
      return { token: signVisitor(app.config.secret, vid) };
    });

    // --- admin API ---------------------------------------------------------------------------
    router.get('/api/attribution/settings', 'location', (ctx) => ({
      ...settingsOf(ctx.locationId),
      snippet: `<script src="${app.baseUrl()}/a/${ctx.locationId}/t.js" async></script>`,
      consent_link: `${app.baseUrl()}/a/consent?v=1&r=/`,
    }));
    router.put('/api/attribution/settings', 'location', (ctx) => {
      const loc = app.location(ctx.locationId)!;
      const b = ctx.body ?? {};
      const cur = settingsOf(ctx.locationId);
      const next: AttributionSettings = {
        enabled: b.enabled !== undefined ? !!b.enabled : cur.enabled,
        cookie: b.cookie !== undefined ? (['consent', 'always', 'never'].includes(b.cookie) ? b.cookie : cur.cookie) : cur.cookie,
        cookie_days: b.cookie_days !== undefined ? Math.min(Math.max(Math.round(num(b.cookie_days, 90)), 1), 730) : cur.cookie_days,
        banner: b.banner !== undefined ? !!b.banner : cur.banner,
        banner_text: b.banner_text !== undefined ? str(b.banner_text, 'Banner-Text', { max: 500 }) || DEFAULTS.banner_text : cur.banner_text,
      };
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, attribution: next }).value), loc.id);
      return next;
    });

    router.get('/api/contacts/:id/attribution', 'location', (ctx) => {
      const c = getContact(app, ctx.locationId, ctx.params.id);
      if (!c) return { summary: null, touches: [] };
      const funnels = new Map(db.all('SELECT id, name FROM funnels WHERE location_id = ?', ctx.locationId).map((f) => [f.id, f.name]));
      const touches = db
        .all<TouchRow>('SELECT * FROM attribution_touches WHERE location_id = ? AND contact_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200', ctx.locationId, c.id)
        .map((t) => ({ ...t, funnel_name: t.funnel_id ? (funnels.get(t.funnel_id) ?? '') : '' }));
      const s = db.get('SELECT * FROM attribution_contacts WHERE contact_id = ?', c.id);
      return { summary: s ? { ...s, first_funnel_name: funnels.get(s.first_funnel_id) ?? '', last_funnel_name: funnels.get(s.last_funnel_id) ?? '' } : null, touches };
    });

    router.get('/api/attribution/sources', 'location', (ctx) => {
      const col = (c: string) =>
        db
          .all(`SELECT DISTINCT v FROM (SELECT first_${c} AS v FROM attribution_contacts WHERE location_id = ? UNION SELECT last_${c} FROM attribution_contacts WHERE location_id = ?) WHERE v != '' ORDER BY v LIMIT 500`, ctx.locationId, ctx.locationId)
          .map((r) => r.v as string);
      return { sources: col('source'), mediums: col('medium'), campaigns: col('campaign') };
    });

    // --- report ------------------------------------------------------------------------------
    const rangeOf = (ctx: Ctx) => {
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const today = ymdInTz(new Date(), tz);
      const ok = (s: string | null) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s : '');
      const to = ok(ctx.query.get('to')) || today;
      const from = ok(ctx.query.get('from')) || ymdInTz(new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 864e5), tz);
      if (from > to) throw bad('„Von“ liegt nach „Bis“');
      const end = new Date(zonedToUtc(to, '00:00', tz).getTime() + 864e5);
      return { from, to, fromIso: zonedToUtc(from, '00:00', tz).toISOString(), toIso: end.toISOString() };
    };

    function report(locationId: string, opts: { fromIso: string; toIso: string; group: Group; model: 'first' | 'last' }) {
      const p = opts.model === 'last' ? 'last' : 'first';
      const dims =
        opts.group === 'source' ? [`a.${p}_source`]
        : opts.group === 'source_medium' ? [`a.${p}_source`, `a.${p}_medium`]
        : opts.group === 'campaign' ? [`a.${p}_source`, `a.${p}_medium`, `a.${p}_campaign`]
        : [`a.${p}_funnel_id`];
      const sel = dims.map((d, i) => `COALESCE(${d}, '') AS d${i}`).join(', ');
      const grp = dims.map((_d, i) => `d${i}`).join(', ');
      const rows = new Map<string, any>();
      const row = (r: any) => {
        const key = dims.map((_d, i) => r[`d${i}`]).join('|');
        let x = rows.get(key);
        if (!x) {
          x = { key, source: '', medium: '', campaign: '', funnel_id: '', leads: 0, deals_won: 0, deal_value: 0, revenue_cents: 0, customers: 0 };
          if (opts.group === 'funnel') x.funnel_id = r.d0;
          else [x.source, x.medium, x.campaign] = [r.d0 ?? '', r.d1 ?? '', r.d2 ?? ''];
          rows.set(key, x);
        }
        return x;
      };
      for (const r of db.all(
        `SELECT ${sel}, COUNT(*) AS n FROM contacts c LEFT JOIN attribution_contacts a ON a.contact_id = c.id WHERE c.location_id = ? AND c.created_at >= ? AND c.created_at < ? GROUP BY ${grp}`,
        locationId, opts.fromIso, opts.toIso,
      ))
        row(r).leads += r.n;
      for (const r of db.all(
        `SELECT ${sel}, COUNT(*) AS n, COALESCE(SUM(o.value), 0) AS v FROM opportunities o LEFT JOIN attribution_contacts a ON a.contact_id = o.contact_id
         WHERE o.location_id = ? AND o.status = 'won' AND COALESCE(o.closed_at, o.updated_at) >= ? AND COALESCE(o.closed_at, o.updated_at) < ? GROUP BY ${grp}`,
        locationId, opts.fromIso, opts.toIso,
      )) {
        const x = row(r);
        x.deals_won += r.n;
        x.deal_value += r.v;
      }
      for (const r of db.all(
        `SELECT ${sel}, COALESCE(SUM(${paidRevenueSql('i.')}), 0) AS v, COUNT(DISTINCT i.contact_id) AS n FROM invoices i LEFT JOIN attribution_contacts a ON a.contact_id = i.contact_id
         WHERE i.location_id = ? AND i.kind = 'invoice' AND i.status = 'paid' AND i.paid_at >= ? AND i.paid_at < ? GROUP BY ${grp}`,
        locationId, opts.fromIso, opts.toIso,
      )) {
        const x = row(r);
        x.revenue_cents += r.v;
        x.customers += r.n;
      }
      const funnels = new Map(db.all('SELECT id, name FROM funnels WHERE location_id = ?', locationId).map((f) => [f.id, f.name]));
      const list = [...rows.values()]
        .map((x) => ({ ...x, funnel_name: x.funnel_id ? (funnels.get(x.funnel_id) ?? '(gelöscht)') : '', label: opts.group === 'funnel' ? (x.funnel_id ? (funnels.get(x.funnel_id) ?? '(gelöscht)') : '(kein Funnel)') : [x.source, opts.group !== 'source' ? x.medium : '', opts.group === 'campaign' ? x.campaign || '–' : ''].filter((v, i) => i === 0 || v).map(sourceLabel).join(' / ') }))
        .sort((a, b) => b.revenue_cents - a.revenue_cents || b.leads - a.leads || a.label.localeCompare(b.label));
      const totals = list.reduce((t, x) => ({ leads: t.leads + x.leads, deals_won: t.deals_won + x.deals_won, deal_value: t.deal_value + x.deal_value, revenue_cents: t.revenue_cents + x.revenue_cents, customers: t.customers + x.customers }), { leads: 0, deals_won: 0, deal_value: 0, revenue_cents: 0, customers: 0 });
      return { rows: list, totals };
    }
    app.services.attributionReport = report;

    const reportArgs = (ctx: Ctx) => {
      const range = rangeOf(ctx);
      const group = (GROUPS as readonly string[]).includes(ctx.query.get('group') ?? '') ? (ctx.query.get('group') as Group) : 'source_medium';
      const model = ctx.query.get('model') === 'last' ? 'last' : 'first';
      return { ...range, group, model } as const;
    };
    router.get('/api/attribution/report', 'location', (ctx) => {
      const a = reportArgs(ctx);
      return { from: a.from, to: a.to, group: a.group, model: a.model, ...report(ctx.locationId, a) };
    });
    router.get('/api/attribution/report.csv', 'location', (ctx) => {
      const a = reportArgs(ctx);
      const { rows } = report(ctx.locationId, a);
      const head = a.group === 'funnel' ? ['Funnel'] : ['Quelle', 'Medium', 'Kampagne'];
      const csv = toCsv([
        [...head, 'Leads', 'Gewonnene Deals', 'Deal-Wert (EUR)', 'Kunden', 'Umsatz (EUR)'],
        ...rows.map((r) => [
          ...(a.group === 'funnel' ? [r.label] : [sourceLabel(r.source), a.group === 'source' ? '' : sourceLabel(r.medium), a.group === 'campaign' ? r.campaign : '']),
          r.leads,
          r.deals_won,
          r.deal_value,
          r.customers,
          (r.revenue_cents / 100).toFixed(2).replace('.', ','),
        ]),
      ]);
      const out = text('\ufeff' + csv, 'text/csv; charset=utf-8');
      out.headers['content-disposition'] = `attachment; filename="attribution-${a.from}-${a.to}.csv"`;
      return out;
    });

    // --- contact lists & smart lists: filter by source/medium/campaign ------------------------
    app.services.contactFilters = [
      ...(app.services.contactFilters ?? []),
      (f: any) => {
        const get = (k: string): string => String(f?.query?.get?.(k) ?? f?.extra?.[k] ?? f?.[k] ?? '').trim();
        const touch = get('attr_touch') || 'any';
        const conds: string[] = [];
        const params: string[] = [];
        if (get('attr_source') === '__none__') return { sql: 'NOT EXISTS (SELECT 1 FROM attribution_contacts a WHERE a.contact_id = contacts.id)', params: [] };
        for (const k of ['source', 'medium', 'campaign']) {
          const v = get(`attr_${k}`);
          if (!v) continue;
          if (touch === 'first' || touch === 'last') (conds.push(`a.${touch}_${k} = ?`), params.push(v));
          else (conds.push(`(a.first_${k} = ? OR a.last_${k} = ?)`), params.push(v, v));
        }
        if (!conds.length) return undefined;
        return { sql: `EXISTS (SELECT 1 FROM attribution_contacts a WHERE a.contact_id = contacts.id AND ${conds.join(' AND ')})`, params };
      },
    ];
  },
};
