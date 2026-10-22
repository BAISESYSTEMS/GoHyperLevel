import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { pageUrl, renderPage } from '../services/site-render.js';
import { buildSchema, checkSeo, externalSeoIssues, faqOf, SCHEMA_TYPES, schemaScript, seoScore, siteSeoIssues } from '../services/site-seo.js';
import { safeFetch } from '../services/net.js';
import type { Tool } from './mcp.js';

/**
 * SEO-Check and structured data (schema.org JSON-LD) for the pages of a site – docs/sites.md#seo-check.
 * The check renders each page the way visitors get it and lists what to fix (title, description, H1, alt texts, text amount,
 * links, social preview, duplicates across pages). Structured data is chosen per page (type + a few fields, prefilled from the
 * company data; FAQ is read from the page's FAQ blocks) and printed into the page's <head> when it is served.
 */

export const siteSeoModule: Module = {
  name: 'site-seo',
  migrations: [
    [
      '001-schema',
      `CREATE TABLE site_schema (
        page_id TEXT PRIMARY KEY REFERENCES funnel_pages(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE INDEX site_schema_funnel ON site_schema(funnel_id);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;

    const funnelOr404 = (ctx: Ctx, fid: string) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };
    const pageOr404 = (ctx: Ctx) => {
      const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['blocks', 'seo', 'layout']);
      if (!p) throw notFound('Seite nicht gefunden');
      return p;
    };
    const isFirst = (p: any) => db.get<{ id: string }>('SELECT id FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 1', p.funnel_id)?.id === p.id;
    const hostOf = (f: any) => f.domain || new URL(app.baseUrl()).hostname;
    const schemaRow = (pageId: string) => parseJson(db.get('SELECT * FROM site_schema WHERE page_id = ?', pageId), ['data']) as { type: string; data: Record<string, unknown> } | undefined;
    const jsonFor = (f: any, p: any, first: boolean, row = schemaRow(p.id)) =>
      row ? buildSchema(row.type, row.data ?? {}, { url: pageUrl(app, f, p, first), blocks: p.blocks, title: p.seo?.title || p.name, description: p.seo?.description || f.settings?.description }) : null;

    // --- the check -------------------------------------------------------------------------------------------------------------------
    function report(f: any, only?: string) {
      const rows = parseRows(db.all('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 80', f.id), ['blocks', 'seo', 'layout']);
      const pages = rows
        .map((p, i) => {
          if (only && p.id !== only) return null;
          const first = i === 0;
          const schema = jsonFor(f, p, first);
          let html = renderPage(app, f, p, first, { preview: true });
          if (schema) html = html.replace('</head>', `${schemaScript(schema)}</head>`);
          const { facts, issues } = checkSeo(html, { host: hostOf(f), slug: first ? undefined : p.slug });
          return { id: p.id, name: p.name, slug: p.slug, url: pageUrl(app, f, p, first), facts, issues, score: seoScore(issues), schema_type: schema ? (schema['@type'] as string) : null };
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      const site = only ? [] : siteSeoIssues(pages);
      const score = pages.length ? Math.round(pages.reduce((n, p) => n + p.score, 0) / pages.length) - site.length * 3 : 0;
      return { checked_at: now(), score: Math.max(0, score), site, pages };
    }
    router.get('/api/funnels/:id/seo', 'location', (ctx) => report(funnelOr404(ctx, ctx.params.id), ctx.query.get('page') || undefined));

    /** SEO audit of any page on the web (a prospect's site, an old website): fetched safely, checked like our own pages. */
    router.post('/api/seo-audit', 'location', async (ctx) => {
      let url = String(ctx.body?.url ?? '').trim();
      if (!url) throw bad('Adresse fehlt');
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      const started = Date.now();
      let res;
      try {
        res = await safeFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; HyperLevel-SEO-Check)', accept: 'text/html' }, timeoutMs: 12_000, maxBytes: 3 * 1024 * 1024 });
      } catch (e) {
        throw bad(`Seite nicht erreichbar: ${(e as Error).message}`);
      }
      const html = await res.text();
      const ms = Date.now() - started;
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        throw bad('Ungültige Adresse');
      }
      const { facts, issues } = checkSeo(html, { host });
      const all = [...externalSeoIssues(html, { url, status: res.status, ms, bytes: Buffer.byteLength(html) }), ...issues];
      const order = { error: 0, warning: 1, info: 2 } as const;
      all.sort((a, b) => order[a.level] - order[b.level]);
      return { url, checked_at: now(), status: res.status, ms, facts, issues: all, score: seoScore(all) };
    });

    // --- structured data -----------------------------------------------------------------------------------------------------------
    /** What the form starts with when nothing is saved: the company data for a business, FAQ when the page has FAQ blocks. */
    const suggestion = (ctx: Ctx, p: any) => {
      const prof = (app.services.legalTexts?.profile?.(ctx.locationId) ?? {}) as Record<string, string>;
      if (faqOf(p.blocks).length) return { type: 'FAQPage', data: {} };
      return { type: 'LocalBusiness', data: { name: prof.company ?? '', telephone: prof.phone ?? '', email: prof.email ?? '', street: prof.street ?? '', zip: prof.zip ?? '', city: prof.city ?? '', country: 'DE' } };
    };
    router.get('/api/funnel-pages/:id/schema', 'location', (ctx) => {
      const p = pageOr404(ctx);
      const f = funnelOr404(ctx, p.funnel_id);
      const row = schemaRow(p.id);
      const first = isFirst(p);
      return { saved: !!row, type: row?.type ?? '', data: row?.data ?? {}, suggestion: row ? undefined : suggestion(ctx, p), json: jsonFor(f, p, first, row), faq: faqOf(p.blocks).length, types: SCHEMA_TYPES };
    });
    router.put('/api/funnel-pages/:id/schema', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const p = pageOr404(ctx);
      const f = funnelOr404(ctx, p.funnel_id);
      const type = String(ctx.body?.type ?? '');
      if (!type) {
        db.run('DELETE FROM site_schema WHERE page_id = ?', p.id);
        return { saved: false, type: '', data: {}, json: null };
      }
      if (!SCHEMA_TYPES[type]) throw bad('Unbekannter Typ');
      const data: Record<string, string> = {};
      for (const fd of SCHEMA_TYPES[type].fields) if (ctx.body?.data?.[fd.key] !== undefined) data[fd.key] = String(ctx.body.data[fd.key]).slice(0, 1000);
      const json = buildSchema(type, data, { url: pageUrl(app, f, p, isFirst(p)), blocks: p.blocks, title: p.seo?.title || p.name, description: p.seo?.description });
      if (!json) throw bad(type === 'FAQPage' ? 'Die Seite hat noch keinen FAQ-Block mit Fragen und Antworten' : 'Pflichtfelder fehlen');
      db.run(
        `INSERT INTO site_schema (page_id, location_id, funnel_id, type, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at`,
        p.id, ctx.locationId, p.funnel_id, type, JSON.stringify(data), now(),
      );
      return { saved: true, type, data, json };
    });

    // Printed into the served page (A/B variants keep the original page's markup).
    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (_ctx: Ctx, f: any, page: any) => {
        const row = schemaRow(page.id);
        if (!row) return undefined;
        const json = jsonFor(f, page, isFirst(page), row);
        return json ? { transform: (h: string) => h.replace('</head>', `${schemaScript(json)}</head>`) } : undefined;
      },
    ];

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const loc = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' } };
    const TOOLS: Tool[] = [
      {
        name: 'ghl_site_seo_check',
        title: 'SEO-Check einer Website',
        description: 'Prüft die Seiten einer Website/eines Funnels auf SEO: Seitentitel, Meta-Beschreibung, H1, Alternativtexte, Textmenge, interne Links, Vorschaubild, strukturierte Daten, doppelte Titel. Liefert je Seite Befunde mit Hinweis und eine Punktzahl (0–100).',
        inputSchema: { type: 'object', properties: { ...loc, funnel_id: { type: 'string', description: 'Website/Funnel-ID (aus GET /api/funnels)' }, page_id: { type: 'string', description: 'nur eine Seite' } }, required: ['location_id', 'funnel_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: (call, a) => call.api('GET', `/api/funnels/${encodeURIComponent(a.funnel_id)}/seo${a.page_id ? `?page=${encodeURIComponent(a.page_id)}` : ''}`, { location: a.location_id }),
      },
      {
        name: 'ghl_seo_audit_url',
        title: 'SEO-Audit einer beliebigen Website',
        description: 'Lädt eine öffentliche Webseite (z. B. die eines Interessenten) und prüft sie auf SEO: HTTPS, Handy-Ansicht, Titel, Beschreibung, H1, Alternativtexte, Textmenge, Links, Ladezeit, strukturierte Daten. Liefert Befunde mit Hinweis und eine Punktzahl (0–100) – gut als Aufhänger für ein Angebot.',
        inputSchema: { type: 'object', properties: { ...loc, url: { type: 'string', description: 'https://…' } }, required: ['location_id', 'url'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: true },
        klassFor: () => 'read',
        run: (call, a) => call.api('POST', '/api/seo-audit', { location: a.location_id, body: { url: a.url } }),
      },
      {
        name: 'ghl_site_schema_set',
        title: 'Strukturierte Daten einer Seite setzen',
        description: `Setzt die schema.org-Auszeichnung (JSON-LD) einer Seite. type: ${Object.keys(SCHEMA_TYPES).join(', ')} – leer entfernt sie. FAQPage liest die FAQ-Blöcke der Seite. Felder je Typ: GET /api/funnel-pages/<id>/schema → types.`,
        inputSchema: { type: 'object', properties: { ...loc, page_id: { type: 'string' }, type: { type: 'string' }, data: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['location_id', 'page_id', 'type'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        run: (call, a) => call.api('PUT', `/api/funnel-pages/${encodeURIComponent(a.page_id)}/schema`, { location: a.location_id, body: { type: a.type, data: a.data ?? {} } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
