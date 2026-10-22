import type { App, Module } from '../core/app.js';
import { toCsv } from '../core/csv.js';
import { parseJson } from '../core/db.js';
import { domainAlias } from '../core/domains.js';
import { notFound, text, type Ctx } from '../core/http.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import { id, now } from '../core/util.js';
import { isBot } from '../services/ab-stats.js';
import { parseTouch } from '../services/attribution.js';
import { boardWidgets, type View } from '../services/boards-widgets.js';
import { callRoute } from '../services/route-call.js';
import { DEVICES, beaconScript, beatToken, buildSteps, deviceOf, rangeOf, readBeat, sourceWord, totalsOf, visitorKey, type ConvRow, type StepRow } from '../services/site-analytics.js';
import { pageUrl } from '../services/site-url.js';
import type { Tool } from './mcp.js';

/**
 * Funnel step analytics: for every page of a funnel the visitors, views, how many went on to a later step (and so how many dropped
 * off), conversions (form, booking, purchase) with their revenue, time on the page and scroll depth – plus the A/B test of the step,
 * the devices and sources, and the revenue the attribution module assigns to the funnel.
 *
 * Privacy: no cookies, nothing stored about a person. A visitor is a hash of secret, day, site, address and browser that changes every
 * day; counting skips bots and (by default) visitors who send "Do Not Track" or Global Privacy Control. Rows older than the retention
 * (180 days, 30–730 in the site's settings) are deleted. See docs/sites.md → "Auswertung" for what to say in the privacy policy.
 *
 * Counting: a page view is recorded when the page is served (`app.services.pageServe`); a small beacon adds time and scroll when the visitor
 * leaves. Conversions come from events: `form.submitted` (the form sits on the page that sent it), `product.purchased` (buy links on
 * pages carry `fp`, modules/site-product.ts) and `appointment.booked` (the page that embeds the calendar).
 */

const BEATS = new Map<string, number[]>();
const WIDGET_RANGES: [string, string][] = [['7', 'Letzte 7 Tage'], ['30', 'Letzte 30 Tage'], ['90', 'Letzte 90 Tage']];

export const siteAnalyticsModule: Module = {
  name: 'site-analytics',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE site_hits (
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        page_id TEXT NOT NULL, visitor TEXT NOT NULL, day TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 1, seconds INTEGER NOT NULL DEFAULT 0, scroll INTEGER NOT NULL DEFAULT 0,
        device TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', first_at TEXT NOT NULL, last_at TEXT NOT NULL,
        PRIMARY KEY (page_id, visitor, day)
      );
      CREATE INDEX site_hits_funnel_day ON site_hits(funnel_id, day);
      CREATE TABLE site_conversions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE, page_id TEXT NOT NULL,
        kind TEXT NOT NULL, ref_id TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
        day TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX site_conversions_funnel ON site_conversions(funnel_id, day);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
    const today = (loc: string) => ymdInTz(new Date(), tzOf(loc));

    const funnelOr404 = (ctx: Ctx, fid = ctx.params.id) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };

    // --- counting views ---------------------------------------------------------------------------------------------------------
    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (ctx: Ctx, funnel: any, page: any) => {
        const cfg = funnel.settings?.analytics ?? {};
        if (cfg.enabled === false) return undefined;
        const ua = String(ctx.req.headers['user-agent'] ?? '');
        if (isBot(ua, String(ctx.req.headers['sec-purpose'] ?? ctx.req.headers.purpose ?? ''))) return undefined;
        // Visitors who ask not to be measured are not (the default; the site's owner may switch it off).
        if (cfg.respect_dnt !== false && (ctx.req.headers.dnt === '1' || ctx.req.headers['sec-gpc'] === '1')) return undefined;
        const day = today(funnel.location_id);
        const visitor = visitorKey(app.config.secret, day, funnel.id, ctx.ip, ua);
        const host = String(ctx.req.headers.host ?? '').toLowerCase();
        const t = parseTouch({ url: `http://${host || 'localhost'}${ctx.url.pathname}${ctx.url.search}`, referrer: String(ctx.req.headers.referer ?? ''), selfHosts: [host, new URL(app.baseUrl()).host] });
        const at = now();
        db.run(
          `INSERT INTO site_hits (funnel_id, location_id, page_id, visitor, day, views, device, source, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
           ON CONFLICT(page_id, visitor, day) DO UPDATE SET views = views + 1, last_at = excluded.last_at`,
          funnel.id,
          funnel.location_id,
          page.id,
          visitor,
          day,
          deviceOf(ua),
          sourceWord(t.source, t.medium).slice(0, 40),
          at,
          at,
        );
        const token = beatToken(app.config.secret, page.id, visitor, day);
        return { transform: (h: string) => h.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${beaconScript(token)}</body>`) };
      },
    ];

    const limited = (ip: string) => {
      const t = Date.now();
      const l = (BEATS.get(ip) ?? []).filter((x) => t - x < 60_000);
      l.push(t);
      BEATS.set(ip, l);
      if (BEATS.size > 20_000) BEATS.clear();
      return l.length > 240;
    };
    /** Time on the page and scroll depth, sent by the page when the visitor leaves (signed per page view). */
    router.post('/api/public/site/beat', 'public', (ctx) => {
      if (limited(ctx.ip)) return { ok: false };
      const b = readBeat(app.config.secret, ctx.body?.k);
      if (!b) return { ok: false };
      const seconds = Math.min(1800, Math.max(0, Math.round(Number(ctx.body?.s) || 0)));
      const scroll = Math.min(100, Math.max(0, Math.round(Number(ctx.body?.m) || 0)));
      db.run('UPDATE site_hits SET seconds = MAX(seconds, ?), scroll = MAX(scroll, ?), last_at = ? WHERE page_id = ? AND visitor = ? AND day = ?', seconds, scroll, now(), b.pageId, b.visitor, b.day);
      return { ok: true };
    });

    // --- counting conversions --------------------------------------------------------------------------------------------------
    const baseHost = () => new URL(app.baseUrl()).hostname.toLowerCase();
    /** The funnel page an address belongs to (the app's /p/<site>/<page> or a connected domain), only within one sub-account. */
    function pageOfUrl(loc: string, raw: unknown): { funnel_id: string; page_id: string } | undefined {
      let u: URL;
      try {
        u = new URL(String(raw ?? ''), app.baseUrl());
      } catch {
        return undefined;
      }
      const host = u.hostname.toLowerCase();
      let funnel: any;
      let seg: string | undefined;
      if (host === baseHost() || host === 'localhost' || host === '127.0.0.1') {
        const m = u.pathname.match(/^\/p\/([^/]+)(?:\/([^/]+))?/);
        if (!m) return undefined;
        funnel = db.get('SELECT id, location_id FROM funnels WHERE slug = ? AND location_id = ?', m[1], loc);
        seg = m[2];
      } else {
        funnel = db.get('SELECT id, location_id FROM funnels WHERE (domain = ? OR domain = ?) AND location_id = ?', host, domainAlias(host) ?? host, loc);
        seg = u.pathname.split('/')[1] || undefined;
      }
      if (!funnel) return undefined;
      const page = seg ? db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = ?', funnel.id, decodeURIComponent(seg)) : db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 1', funnel.id);
      return page ? { funnel_id: funnel.id, page_id: page.id } : undefined;
    }
    const countable = (funnelId: string) => parseJson(db.get('SELECT settings FROM funnels WHERE id = ?', funnelId), ['settings'])?.settings?.analytics?.enabled !== false;
    function convert(loc: string, where: { funnel_id: string; page_id: string }, kind: string, ref: string, cents = 0, currency = 'EUR') {
      if (!countable(where.funnel_id)) return;
      db.insert('site_conversions', { id: id(), location_id: loc, funnel_id: where.funnel_id, page_id: where.page_id, kind, ref_id: String(ref ?? '').slice(0, 80), amount_cents: Math.max(0, Math.round(cents || 0)), currency: String(currency || 'EUR').toUpperCase().slice(0, 3), day: today(loc), created_at: now() });
    }

    app.events.on('form.submitted', (e) => {
      const where = pageOfUrl(e.locationId, e.data.submission?.meta?.page);
      if (where) convert(e.locationId, where, 'form', e.data.formId);
    });
    app.events.on('product.purchased', (e) => {
      const fp = String(e.data.metadata?.fp ?? '');
      if (!/^[A-Za-z0-9]{1,40}$/.test(fp)) return;
      const page = db.get('SELECT id, funnel_id FROM funnel_pages WHERE id = ? AND location_id = ?', fp, e.locationId);
      if (page) convert(e.locationId, { funnel_id: page.funnel_id, page_id: page.id }, 'purchase', e.data.productId, Number(e.data.amount_cents) || 0, e.data.currency);
    });
    // A calendar widget cannot say which page it sat on: a booking counts for the page that embeds the calendar – when there is exactly one.
    app.events.on('appointment.booked', (e) => {
      const cal = db.get('SELECT slug FROM calendars WHERE id = ? AND location_id = ?', e.data.calendarId, e.locationId);
      if (!cal) return;
      const pages = db.all('SELECT id, funnel_id FROM funnel_pages WHERE location_id = ? AND blocks LIKE ?', e.locationId, `%"calendar_slug":${JSON.stringify(cal.slug)}%`);
      if (pages.length === 1) convert(e.locationId, { funnel_id: pages[0].funnel_id, page_id: pages[0].id }, 'booking', e.data.calendarId);
    });

    // --- the report -------------------------------------------------------------------------------------------------------------
    /** Steps, totals, devices, sources and days of one funnel in a range (days in the sub-account's time zone). */
    function report(f: any, from: string, to: string) {
      const pages = db.all<{ id: string; name: string; slug: string; position: number }>('SELECT id, name, slug, position FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', f.id);
      const q = [f.id, from, to];
      const counts = new Map(
        db
          .all(
            `SELECT page_id, SUM(views) AS views, COUNT(*) AS visitors, SUM(CASE WHEN seconds > 0 THEN seconds ELSE 0 END) AS seconds, SUM(seconds > 0) AS seconds_n,
                    SUM(CASE WHEN scroll > 0 THEN scroll ELSE 0 END) AS scroll, SUM(scroll > 0) AS scroll_n
             FROM site_hits WHERE funnel_id = ? AND day BETWEEN ? AND ? GROUP BY page_id`,
            ...q,
          )
          .map((r) => [r.page_id, r]),
      );
      const entries = new Map(
        db
          .all(
            `SELECT page_id, COUNT(*) AS n FROM (SELECT page_id, ROW_NUMBER() OVER (PARTITION BY visitor, day ORDER BY first_at, rowid) AS rn FROM site_hits WHERE funnel_id = ? AND day BETWEEN ? AND ?) WHERE rn = 1 GROUP BY page_id`,
            ...q,
          )
          .map((r) => [r.page_id, Number(r.n)]),
      );
      const continued = new Map(
        db
          .all(
            `SELECT a.page_id, COUNT(*) AS n FROM site_hits a JOIN funnel_pages pa ON pa.id = a.page_id
             WHERE a.funnel_id = ? AND a.day BETWEEN ? AND ?
               AND EXISTS (SELECT 1 FROM site_hits b JOIN funnel_pages pb ON pb.id = b.page_id WHERE b.funnel_id = a.funnel_id AND b.visitor = a.visitor AND b.day = a.day AND pb.position > pa.position)
             GROUP BY a.page_id`,
            ...q,
          )
          .map((r) => [r.page_id, Number(r.n)]),
      );
      const rows: StepRow[] = pages.map((p) => {
        const c = counts.get(p.id) ?? {};
        return { page_id: p.id, name: p.name, slug: p.slug, position: p.position, views: Number(c.views ?? 0), visitors: Number(c.visitors ?? 0), entries: entries.get(p.id) ?? 0, continued: continued.get(p.id) ?? 0, seconds: Number(c.seconds ?? 0), seconds_n: Number(c.seconds_n ?? 0), scroll: Number(c.scroll ?? 0), scroll_n: Number(c.scroll_n ?? 0) };
      });
      const convs: ConvRow[] = db
        .all(`SELECT page_id, kind, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS cents FROM site_conversions WHERE funnel_id = ? AND day BETWEEN ? AND ? GROUP BY page_id, kind`, ...q)
        .map((r) => ({ page_id: r.page_id, kind: r.kind, n: Number(r.n), cents: Number(r.cents) }));
      const steps = buildSteps(rows, convs);
      const unique = Number(db.get('SELECT COUNT(*) AS n FROM (SELECT DISTINCT visitor, day FROM site_hits WHERE funnel_id = ? AND day BETWEEN ? AND ?)', ...q)?.n ?? 0);
      const devices = Object.fromEntries(DEVICES.map((d) => [d, 0])) as Record<string, number>;
      for (const r of db.all(`SELECT device, COUNT(*) AS n FROM (SELECT DISTINCT visitor, day, device FROM site_hits WHERE funnel_id = ? AND day BETWEEN ? AND ?) GROUP BY device`, ...q)) if (r.device in devices) devices[r.device] = Number(r.n);
      const sources = db
        .all(`SELECT source, COUNT(*) AS n FROM (SELECT source, ROW_NUMBER() OVER (PARTITION BY visitor, day ORDER BY first_at, rowid) AS rn FROM site_hits WHERE funnel_id = ? AND day BETWEEN ? AND ?) WHERE rn = 1 GROUP BY source ORDER BY n DESC LIMIT 8`, ...q)
        .map((r) => ({ source: String(r.source || 'direkt'), visitors: Number(r.n) }));
      const daily = db
        .all(
          `SELECT h.day, COUNT(DISTINCT h.visitor) AS visitors, (SELECT COUNT(*) FROM site_conversions c WHERE c.funnel_id = h.funnel_id AND c.day = h.day) AS conversions
           FROM site_hits h WHERE h.funnel_id = ? AND h.day BETWEEN ? AND ? GROUP BY h.day ORDER BY h.day`,
          ...q,
        )
        .map((r) => ({ day: r.day, visitors: Number(r.visitors), conversions: Number(r.conversions) }));
      return { steps, totals: totalsOf(steps, unique), devices, sources, daily };
    }

    /** The A/B test of each step (the running one, else the latest): numbers per variant from the A/B module. */
    async function abOf(ctx: Ctx, f: any) {
      try {
        const tests: any[] = await callRoute(app, ctx, 'GET', `/api/ab-tests?funnel_id=${encodeURIComponent(f.id)}`, {}, { quiet: true });
        const rank = (t: any) => (t.status === 'running' ? 3 : t.status === 'paused' ? 2 : t.status === 'draft' ? 0 : 1);
        const out = new Map<string, any>();
        for (const t of tests.sort((a, b) => rank(a) - rank(b) || String(a.created_at).localeCompare(String(b.created_at)))) {
          out.set(t.page_id, {
            id: t.id,
            name: t.name,
            status: t.status,
            visitors: t.visitors,
            conversions: t.conversions,
            leader: t.leader,
            small_sample: t.small_sample,
            winner_id: t.winner_id,
            variants: (t.variants ?? []).filter((v: any) => !v.archived || t.status === 'ended').map((v: any) => ({ key: v.key, name: v.name, visitors: v.visitors, conversions: v.conversions, rate: v.rate, uplift: v.uplift, verdict: v.verdict })),
          });
        }
        return out;
      } catch {
        return new Map<string, any>();
      }
    }

    /** Revenue the attribution module assigns to the funnel (first and last touch) – paid invoices incl. Stripe. */
    function attributed(loc: string, fid: string, from: string, to: string) {
      const fn = app.services.attributionReport as ((loc: string, o: { fromIso: string; toIso: string; group: string; model: string }) => { rows: any[] }) | undefined;
      if (!fn) return null;
      const tz = tzOf(loc);
      const fromIso = zonedToUtc(from, '00:00', tz).toISOString();
      const toIso = new Date(zonedToUtc(to, '00:00', tz).getTime() + 864e5).toISOString();
      const pick = (model: 'first' | 'last') => {
        const r = fn(loc, { fromIso, toIso, group: 'funnel', model }).rows.find((x) => x.funnel_id === fid);
        return { leads: Number(r?.leads ?? 0), customers: Number(r?.customers ?? 0), revenue_cents: Number(r?.revenue_cents ?? 0), deals_won: Number(r?.deals_won ?? 0) };
      };
      return { first: pick('first'), last: pick('last') };
    }

    const rangeFrom = (ctx: Ctx, loc: string) => rangeOf(ctx.query.get('from'), ctx.query.get('to'), today(loc), addDaysYmd);

    router.get('/api/funnels/:id/analytics', 'location', async (ctx) => {
      const f = funnelOr404(ctx);
      const { from, to } = rangeFrom(ctx, f.location_id);
      const r = report(f, from, to);
      const ab = await abOf(ctx, f);
      const pages = new Map(db.all('SELECT id, slug FROM funnel_pages WHERE funnel_id = ?', f.id).map((p) => [p.id, p.slug]));
      return {
        from,
        to,
        funnel: { id: f.id, name: f.name, kind: f.kind, url: pageUrl(app, f), analytics_enabled: f.settings?.analytics?.enabled !== false, retention_days: f.settings?.analytics?.retention_days ?? 180 },
        ...r,
        steps: r.steps.map((s) => ({ ...s, url: pageUrl(app, f, { slug: pages.get(s.page_id) ?? s.slug }, r.steps[0]?.page_id === s.page_id), ab: ab.get(s.page_id) ?? null })),
        attribution: attributed(f.location_id, f.id, from, to),
      };
    });

    router.get('/api/funnels/:id/analytics.csv', 'location', (ctx) => {
      const f = funnelOr404(ctx);
      const { from, to } = rangeFrom(ctx, f.location_id);
      const { steps } = report(f, from, to);
      const csv = toCsv([
        ['Schritt', 'Seite', 'Aufrufe', 'Besucher', 'Weiter zum nächsten Schritt', 'Absprung', 'Formulare', 'Termine', 'Käufe', 'Conversion', 'Umsatz (EUR)', 'Ø Sekunden', 'Ø Scroll %'],
        ...steps.map((s, i) => [i + 1, s.name, s.views, s.visitors, s.continued, `${Math.round(s.drop_off * 100)} %`, s.conversions.form, s.conversions.booking, s.conversions.purchase, `${(s.conv_rate * 100).toFixed(1).replace('.', ',')} %`, (s.revenue_cents / 100).toFixed(2).replace('.', ','), s.avg_seconds, s.avg_scroll]),
      ]);
      const r = text(`﻿${csv}`, 'text/csv; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="funnel-${f.slug}-${from}-${to}.csv"`;
      return r;
    });

    /** All funnels of the sub-account in one table (Dashboard widget, MCP tool). */
    function overview(loc: string, days: number) {
      return db.memo(`site-overview:${loc}:${days}`, 30_000, () => {
        const to = today(loc);
        const from = addDaysYmd(to, -(days - 1));
        return db.all('SELECT * FROM funnels WHERE location_id = ? ORDER BY updated_at DESC LIMIT 30', loc).map((raw) => {
          const f = parseJson(raw, ['settings']);
          const r = report(f, from, to);
          return { id: f.id, name: f.name, kind: f.kind, pages: r.steps.length, visitors: r.totals.visitors, views: r.totals.views, conversions: r.totals.conversions, conv_rate: r.totals.conv_rate, reach_last: r.totals.reach_last, revenue_cents: r.totals.revenue_cents };
        });
      });
    }
    router.get('/api/funnel-analytics', 'location', (ctx) => {
      const days = Math.min(365, Math.max(1, Math.round(Number(ctx.query.get('days')) || 30)));
      return { days, funnels: overview(ctx.locationId, days) };
    });

    // --- retention ------------------------------------------------------------------------------------------------------------
    let cleaned = 0;
    app.onTick(() => {
      if (Date.now() - cleaned < 3600_000) return;
      cleaned = Date.now();
      // Days are stored in each sub-account's own zone; a retention is "days or more", a day more or less does not matter.
      const cutoff = (days: number) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      for (const raw of db.all(`SELECT id, settings FROM funnels WHERE settings LIKE '%"retention_days"%'`)) {
        const days = Number(parseJson(raw, ['settings']).settings?.analytics?.retention_days);
        if (!Number.isFinite(days)) continue;
        const day = cutoff(Math.min(730, Math.max(30, days)));
        db.run('DELETE FROM site_hits WHERE funnel_id = ? AND day < ?', raw.id, day);
        db.run('DELETE FROM site_conversions WHERE funnel_id = ? AND day < ?', raw.id, day);
      }
      const def = cutoff(180);
      db.run(`DELETE FROM site_hits WHERE day < ? AND funnel_id IN (SELECT id FROM funnels WHERE settings NOT LIKE '%"retention_days"%')`, def);
      db.run(`DELETE FROM site_conversions WHERE day < ? AND funnel_id IN (SELECT id FROM funnels WHERE settings NOT LIKE '%"retention_days"%')`, def);
    });

    // --- board widget -----------------------------------------------------------------------------------------------------------
    const euro = (c: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100);
    const rate = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')} %`;
    try {
      boardWidgets(app).register({
        type: 'funnel_overview',
        source: 'site-analytics',
        label: 'Funnel-Auswertung',
        description: 'Besucher, Conversion und Umsatz deiner Funnels und Websites im Vergleich – je Seite des Funnels siehst du den Absprung im Funnel-Editor.',
        icon: 'funnels',
        category: 'zahlen',
        keywords: ['funnel', 'website', 'conversion', 'besucher', 'absprung'],
        access: '/api/funnels',
        accessLabel: 'Funnels & Websites',
        size: { w: 6, h: 4 },
        fields: [{ key: 'range', label: 'Zeitraum', type: 'select', options: WIDGET_RANGES, default: '30' }],
        data: (w, config): View => {
          const days = Number(config.range) || 30;
          const rows = overview(w.locationId, days).filter((r) => r.views > 0 || r.conversions > 0);
          return {
            kind: 'table',
            title: 'Funnel-Auswertung',
            columns: [
              { key: 'name', label: 'Funnel' },
              { key: 'visitors', label: 'Besucher', align: 'right' },
              { key: 'reach', label: 'Bis zum Ende', align: 'right' },
              { key: 'conv', label: 'Conversion', align: 'right' },
              { key: 'revenue', label: 'Umsatz', align: 'right' },
            ],
            rows: rows.map((r) => ({ name: r.name, visitors: r.visitors, reach: r.pages > 1 ? rate(r.reach_last) : '–', conv: rate(r.conv_rate), revenue: euro(r.revenue_cents) })),
            empty: 'Noch keine Besucher gezählt – sobald deine Seiten aufgerufen werden, erscheinen sie hier.',
            url: 'funnels',
          };
        },
      });
    } catch (e) {
      console.error('[site-analytics] widget:', (e as Error).message);
    }

    // --- MCP ------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_funnel_analytics',
        title: 'Funnel-Auswertung (Schritte, Absprung, Umsatz)',
        description:
          'Auswertung je Seite (Schritt) eines Funnels oder einer Website: Besucher, Aufrufe, wie viele zum nächsten Schritt weitergingen (Absprung), Conversions (Formular, Termin, Kauf) mit Umsatz, Zeit auf der Seite, A/B-Test je Schritt und der Umsatz laut Attribution. Ohne funnel_id: Vergleich aller Funnels des Projekts. from/to als YYYY-MM-DD (Standard: letzte 30 Tage).',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, funnel_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => {
          if (!a.funnel_id) return call.api('GET', '/api/funnel-analytics', { location: a.location_id });
          const qs = new URLSearchParams(Object.entries({ from: a.from, to: a.to }).filter(([, v]) => v) as [string, string][]).toString();
          return call.api('GET', `/api/funnels/${encodeURIComponent(a.funnel_id)}/analytics${qs ? `?${qs}` : ''}`, { location: a.location_id });
        },
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

  },
};
