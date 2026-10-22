import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, html, notFound, num, str, text, type Ctx } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { domainAlias, normalizeDomain } from '../core/domains.js';
import { id, now, slugify } from '../core/util.js';
import { cleanBlocks } from '../services/site-layout.js';
import { pageUrl, renderPage, renderBlock } from '../services/site-render.js';
import { miniMarkdown, type Block } from '../services/site-blocks.js';
import { cleanPageLayout, cleanSiteSettings } from '../services/site-settings.js';

/**
 * Funnels and websites: the sites, their pages, the public pages (/p/<site>/<page>, custom domains), sitemap.xml and robots.txt.
 * How a page is built lives in the site builder services – blocks (`site-blocks.ts`), sections/rows/columns (`site-layout.ts`),
 * design tokens (`site-style.ts`), the page renderer with header/footer (`site-render.ts`); the other site modules (design, templates,
 * CMS, redirects, accessibility, analytics, product) plug in through `app.services.siteBlocks/siteRedirect/sitePaths/siteSitemap/pageServe`.
 * What other modules import from here stays: `Block`, `miniMarkdown`, `renderBlock`, `renderPage`, `pageUrl`, `cleanBlocks`.
 */
export { cleanBlocks, miniMarkdown, pageUrl, renderBlock, renderPage };
export type { Block };

const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation allow-modals';

const TEMPLATES: Record<string, { name: string; slug: string; blocks: Omit<Block, 'id'>[] }[]> = {
  leadmagnet: [
    {
      name: 'Opt-in',
      slug: 'start',
      blocks: [
        { type: 'hero', heading: 'Der kostenlose Leitfaden für dein Ziel', subheading: 'Trag dich ein und erhalte ihn sofort per E-Mail.', button_text: '', button_url: '', align: 'center', bg: '#eff6ff' },
        { type: 'form', form_id: '', heading: 'Jetzt kostenlos sichern' },
        { type: 'features', heading: 'Das lernst du', items: [{ icon: '🚀', title: 'Schnell starten', text: 'In 10 Minuten zum ersten Ergebnis.' }, { icon: '🎯', title: 'Klarer Plan', text: 'Schritt für Schritt erklärt.' }, { icon: '💡', title: 'Praxis', text: 'Mit Beispielen und Vorlagen.' }] },
      ],
    },
    { name: 'Danke', slug: 'danke', blocks: [{ type: 'hero', heading: 'Danke! 🎉', subheading: 'Schau in dein Postfach – der Leitfaden ist unterwegs.', align: 'center' }] },
  ],
  booking: [
    {
      name: 'Termin',
      slug: 'termin',
      blocks: [
        { type: 'hero', heading: 'Kostenloses Erstgespräch', subheading: 'Such dir einen Termin aus, der dir passt.', align: 'center', bg: '#f0fdf4' },
        { type: 'calendar', calendar_slug: '' },
        { type: 'faq', heading: 'Häufige Fragen', items: [{ q: 'Was kostet das Gespräch?', a: 'Nichts. Es ist unverbindlich.' }, { q: 'Wie lange dauert es?', a: 'Etwa 30 Minuten.' }] },
      ],
    },
  ],
  website: [
    {
      name: 'Startseite',
      slug: 'home',
      blocks: [
        { type: 'hero', heading: 'Willkommen bei uns', subheading: 'Wir helfen dir, mehr Kunden zu gewinnen.', button_text: 'Kontakt aufnehmen', button_url: '#kontakt', align: 'center' },
        { type: 'features', heading: 'Leistungen', items: [{ icon: '⭐', title: 'Leistung 1', text: 'Kurze Beschreibung.' }, { icon: '⚡', title: 'Leistung 2', text: 'Kurze Beschreibung.' }, { icon: '🤝', title: 'Leistung 3', text: 'Kurze Beschreibung.' }] },
        { type: 'testimonial', quote: 'Großartige Zusammenarbeit!', author: 'Zufriedener Kunde' },
        { type: 'form', form_id: '', heading: 'Kontakt' },
      ],
    },
    { name: 'Impressum', slug: 'impressum', blocks: [{ type: 'heading', text: 'Impressum', level: 1 }, { type: 'text', text: 'Angaben gemäß § 5 DDG\n\nName\nStraße\nPLZ Ort' }] },
    { name: 'Datenschutz', slug: 'datenschutz', blocks: [{ type: 'heading', text: 'Datenschutzerklärung', level: 1 }, { type: 'text', text: 'Hier deine Datenschutzerklärung einfügen.' }] },
  ],
  blank: [{ name: 'Seite 1', slug: 'start', blocks: [{ type: 'hero', heading: 'Überschrift', subheading: 'Unterzeile', align: 'center' }] }],
};

export const funnelsModule: Module = {
  name: 'funnels',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE funnels (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'funnel',
        domain TEXT UNIQUE, settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE funnel_pages (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
        blocks TEXT NOT NULL DEFAULT '[]', seo TEXT NOT NULL DEFAULT '{}', views INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(funnel_id, slug)
      );
      `,
    ],
    // Site builder 2.0: per-page layout options (header/footer on or off, language, translation group).
    ['002-page-layout', `ALTER TABLE funnel_pages ADD COLUMN layout TEXT NOT NULL DEFAULT '{}';`],
  ],
  register(app) {
    const { db, router } = app;
    const getFunnel = (locationId: string, fid: string) => parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, locationId), ['settings']);
    const pagesOf = (fid: string) => parseRows(db.all('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', fid), ['blocks', 'seo', 'layout']);
    const uniqueSlug = (base: string, except = '') => {
      let slug = slugify(base);
      for (let i = 2; db.get('SELECT id FROM funnels WHERE slug = ? AND id != ?', slug, except); i++) slug = `${slugify(base)}-${i}`;
      return slug;
    };
    const urlOf = (f: any, p?: any) => `${f.domain ? `https://${f.domain}` : `${app.baseUrl()}/p/${f.slug}`}${p ? `/${p.slug}` : ''}`;
    const withDomain = (f: any) => ({ ...f, domain_status: f.domain ? app.services.domainStatus?.(f.domain) : undefined });

    router.get('/api/funnels', 'location', (ctx) =>
      parseRows(
        db.all(
          `SELECT f.*, (SELECT COUNT(*) FROM funnel_pages p WHERE p.funnel_id = f.id) AS pages, (SELECT COALESCE(SUM(views),0) FROM funnel_pages p WHERE p.funnel_id = f.id) AS views
           FROM funnels f WHERE f.location_id = ? ORDER BY f.updated_at DESC`,
          ctx.locationId,
        ),
        ['settings'],
      ).map((f) => withDomain({ ...f, url: urlOf(f) })),
    );
    router.post('/api/funnels', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      const kind = ctx.body.kind === 'website' ? 'website' : 'funnel';
      const tpl = TEMPLATES[ctx.body.template] ?? TEMPLATES[kind === 'website' ? 'website' : 'blank'];
      const f = { id: id(), location_id: ctx.locationId, name, slug: uniqueSlug(ctx.body.slug || name), kind, settings: { color: '#2563eb', ...cleanSiteSettings(ctx.body.settings ?? {}) }, created_at: now(), updated_at: now() };
      db.tx(() => {
        db.insert('funnels', f);
        tpl.forEach((p, i) =>
          db.insert('funnel_pages', { id: id(), location_id: ctx.locationId, funnel_id: f.id, name: p.name, slug: p.slug, position: i, blocks: p.blocks.map((b) => ({ ...b, id: id(8) })), seo: { title: p.name }, created_at: now(), updated_at: now() }),
        );
      });
      // A new website: its Impressum and Datenschutz pages are filled from the company data (modules/legal-pages.ts) instead of "Hier einfügen".
      if (tpl === TEMPLATES.website) app.services.legalTexts?.prefill?.(ctx.locationId, f.id);
      return { ...f, url: urlOf(f), pages: pagesOf(f.id) };
    });
    router.get('/api/funnels/:id', 'location', (ctx) => {
      const f = getFunnel(ctx.locationId, ctx.params.id);
      if (!f) throw notFound();
      return withDomain({ ...f, url: urlOf(f), pages: pagesOf(f.id).map((p) => ({ ...p, url: urlOf(f, p) })) });
    });
    router.patch('/api/funnels/:id', 'location', (ctx) => {
      const f = getFunnel(ctx.locationId, ctx.params.id);
      if (!f) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true });
      if (ctx.body.slug !== undefined) patch.slug = uniqueSlug(ctx.body.slug, f.id);
      if (ctx.body.domain !== undefined) {
        const d = normalizeDomain(ctx.body.domain);
        const alias = d ? domainAlias(d) : undefined;
        if (d && db.get('SELECT id FROM funnels WHERE (domain = ? OR domain = ?) AND id != ?', d, alias ?? d, f.id)) throw bad('Domain schon verbunden');
        if (d && d === new URL(app.config.baseUrl).hostname) throw bad('Das ist die Adresse der App selbst');
        // Not a login domain of the agency or of a client, not a help center's, nothing the host service reserves (a host decides which pages it serves).
        if (d && d !== f.domain && app.services.domainTaken?.(d, { funnel: f.id }, ctx)) throw bad('Diese Domain ist schon vergeben');
        patch.domain = d || null;
      }
      if (ctx.body.settings) patch.settings = { ...f.settings, ...cleanSiteSettings(ctx.body.settings, f.settings) };
      db.update('funnels', f.id, patch);
      const out = getFunnel(ctx.locationId, f.id)!;
      return withDomain({ ...out, url: urlOf(out) });
    });
    router.delete('/api/funnels/:id', 'location', (ctx) => {
      db.run('DELETE FROM funnels WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    router.post('/api/funnels/:id/pages', 'location', (ctx) => {
      const f = getFunnel(ctx.locationId, ctx.params.id);
      if (!f) throw notFound();
      const name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      let slug = slugify(ctx.body.slug || name);
      for (let i = 2; db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = ?', f.id, slug); i++) slug = `${slugify(ctx.body.slug || name)}-${i}`;
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM funnel_pages WHERE funnel_id = ?', f.id)!.n;
      const p = { id: id(), location_id: ctx.locationId, funnel_id: f.id, name, slug, position: pos, blocks: ctx.body.blocks ? cleanBlocks(ctx.body.blocks) : [], seo: { title: name }, created_at: now(), updated_at: now() };
      db.insert('funnel_pages', p);
      return { ...p, url: urlOf(f, p) };
    });
    router.patch('/api/funnel-pages/:id', 'location', (ctx) => {
      const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['blocks', 'seo', 'layout']);
      if (!p) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true });
      if (ctx.body.slug !== undefined) {
        const slug = slugify(ctx.body.slug);
        if (db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = ? AND id != ?', p.funnel_id, slug, p.id)) throw bad('Pfad schon vergeben');
        patch.slug = slug;
      }
      if (ctx.body.position !== undefined) patch.position = num(ctx.body.position);
      if (ctx.body.blocks !== undefined) patch.blocks = cleanBlocks(ctx.body.blocks);
      if (ctx.body.seo) patch.seo = { ...p.seo, ...ctx.body.seo };
      if (ctx.body.layout !== undefined) patch.layout = cleanPageLayout(ctx.body.layout, p.layout);
      db.update('funnel_pages', p.id, patch);
      db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', now(), p.funnel_id);
      return parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ?', p.id), ['blocks', 'seo', 'layout']);
    });
    router.delete('/api/funnel-pages/:id', 'location', (ctx) => {
      db.run('DELETE FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    /** Live preview from the builder without saving: unsaved blocks, page layout and site settings (design, header, footer) can come along. */
    router.post('/api/funnel-pages/:id/preview', 'location', (ctx) => {
      const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['blocks', 'seo', 'layout']);
      if (!p) throw notFound();
      const f = getFunnel(ctx.locationId, p.funnel_id)!;
      const draft = ctx.body.settings && typeof ctx.body.settings === 'object' ? { ...f, settings: { ...f.settings, ...cleanSiteSettings(ctx.body.settings, f.settings) } } : f;
      const layout = ctx.body.layout && typeof ctx.body.layout === 'object' ? cleanPageLayout(ctx.body.layout, p.layout) : p.layout;
      return html(renderPage(app, draft, { ...p, layout, blocks: cleanBlocks(ctx.body.blocks ?? p.blocks) }, false, { preview: true }));
    });

    /** The site's own "Seite nicht gefunden": the page chosen under Einstellungen (or one with the path "404"), else a plain themed notice. */
    const notFoundPage = (ctx: Ctx, f: any, pages: any[]) => {
      const nf = f.settings?.not_found ?? {};
      const chosen = (nf.page_id && pages.find((p) => p.id === nf.page_id)) || pages.find((p) => p.slug === '404');
      const home = pageUrl(app, f, pages[0], true);
      const page = chosen ?? {
        id: '404',
        name: 'Seite nicht gefunden',
        slug: '404',
        seo: { title: 'Seite nicht gefunden' },
        layout: {},
        blocks: [{ id: 'nf1', type: 'hero', heading: nf.heading || 'Seite nicht gefunden', subheading: nf.text || 'Diese Seite gibt es nicht (mehr).', button_text: 'Zur Startseite', button_url: home, align: 'center', padding: 96 }],
      };
      app.services.siteMissed?.(ctx, f);
      const r = html(renderPage(app, f, page, false, { ctx, noindex: true }), 404);
      r.headers['cache-control'] = 'private, no-cache';
      r.headers['content-security-policy'] = SANDBOX;
      return r;
    };
    app.services.siteNotFound = (ctx: Ctx, f: any) => notFoundPage(ctx, f, pagesOf(f.id));

    const servePage = (ctx: Ctx, f: any, segments: string[] = []) => {
      const query = ctx.query;
      const pageSlug = segments.length === 1 ? segments[0] : undefined;
      // Redirect rules of the site (modules/site-routing.ts): app.services.siteRedirect = (ctx, funnel, segments) => RawResult | undefined.
      const moved = app.services.siteRedirect?.(ctx, f, segments);
      if (moved) return moved;
      const pages = pagesOf(f.id);
      if (pageSlug === 'sitemap.xml') {
        const urls = pages
          .filter((p) => !p.seo?.noindex && !f.settings?.noindex)
          .map((p, i) => `<url><loc>${escapeHtml(pageUrl(app, f, p, i === 0))}</loc><lastmod>${String(p.updated_at).slice(0, 10)}</lastmod></url>`);
        // Other modules add their public URLs (e.g. blog posts): app.services.siteSitemap = [(funnel) => [{loc, lastmod}]].
        for (const fn of app.services.siteSitemap ?? []) for (const u of fn(f) ?? []) urls.push(`<url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${String(u.lastmod).slice(0, 10)}</lastmod>` : ''}</url>`);
        return { __raw: true, status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' }, body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>` };
      }
      if (pageSlug === 'robots.txt') {
        const body = f.settings?.noindex ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\nSitemap: ${pageUrl(app, f, { slug: 'sitemap.xml' })}\n`;
        return text(body);
      }
      // Paths other modules serve on the site (e.g. /blog): app.services.sitePaths = [(funnel, path, query) => RawResult | undefined].
      if (pageSlug) for (const fn of app.services.sitePaths ?? []) {
        const r = fn(f, pageSlug, query ?? new URLSearchParams(), ctx);
        if (r) return r;
      }
      const page = segments.length > 1 ? undefined : pageSlug ? pages.find((p) => p.slug === pageSlug) : pages[0];
      if (!page) {
        // Dynamic content of other modules (CMS lists and items): app.services.siteResolve = [(ctx, funnel, segments) => RawResult | undefined].
        for (const fn of app.services.siteResolve ?? []) {
          const r = fn(ctx, f, segments);
          if (r) return r;
        }
        return notFoundPage(ctx, f, pages);
      }
      // Other modules may show this visitor another version of the page or decorate it (e.g. A/B tests):
      // app.services.pageServe = [(ctx, funnel, page) => ({ page?, transform?(html), headers? }) | undefined].
      let shown = page;
      const extras: { transform?: (h: string) => string; headers?: Record<string, string> }[] = [];
      for (const fn of app.services.pageServe ?? []) {
        const x = fn(ctx, f, shown);
        if (!x) continue;
        if (x.page) shown = x.page;
        extras.push(x);
      }
      db.run('UPDATE funnel_pages SET views = views + 1 WHERE id = ?', page.id);
      const r = html(renderPage(app, f, shown, page.id === pages[0]?.id, { ctx }));
      for (const x of extras) {
        if (x.transform) r.body = x.transform(String(r.body));
        Object.assign(r.headers, x.headers ?? {});
      }
      // Per-visit additions from other modules (e.g. attribution token): app.services.pageVisit = [(ctx, funnel, page, html) => html].
      if (app.services.pageVisit?.length) {
        for (const fn of app.services.pageVisit) r.body = fn(ctx, f, page, String(r.body)) ?? r.body;
        if (!/no-store/.test(r.headers['cache-control'] ?? '')) r.headers['cache-control'] = 'private, no-cache';
      }
      // Pages can carry the owner's custom code; sandboxing gives them an opaque origin so that
      // code can never use a visiting admin's session against the API.
      r.headers['content-security-policy'] = SANDBOX;
      return r;
    };
    const bySlug = (slug: string) => parseJson(db.get('SELECT * FROM funnels WHERE slug = ?', slug), ['settings']);
    const gone = () => html(messagePage('Nicht gefunden', 'Diese Seite gibt es nicht.'), 404);
    router.get('/p/:funnel', 'public', (ctx) => {
      const f = bySlug(ctx.params.funnel);
      return f ? servePage(ctx, f) : gone();
    });
    router.get('/p/:funnel/:page', 'public', (ctx) => {
      const f = bySlug(ctx.params.funnel);
      return f ? servePage(ctx, f, [ctx.params.page]) : gone();
    });
    // Deeper paths (/p/<site>/<a>/<b>…: CMS items, redirects with wildcards, 404) are routed by modules/site-routing.ts, which registers
    // after the blog – its /blog/<post> route has to match first.
    app.services.siteServe = { page: servePage, bySlug, gone, notFound: (ctx: Ctx, f: any) => notFoundPage(ctx, f, pagesOf(f.id)), sandbox: SANDBOX };

    // Custom domains: a request for a connected domain serves that funnel at its root.
    app.rewrites.push((host, path) => {
      // Both halves of a www pair reach the funnel (example.de and www.example.de).
      const f = db.get('SELECT slug FROM funnels WHERE domain = ? OR domain = ?', host, domainAlias(host) ?? host);
      if (!f) return undefined;
      if (path.startsWith('/api/') || /^\/(f|book|uploads|uploads-opt|i|r|u|chat|l|t|s)\//.test(path)) return path;
      return `/p/${f.slug}${path === '/' ? '' : path}`;
    });
  },
};
