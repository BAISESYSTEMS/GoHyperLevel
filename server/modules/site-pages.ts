import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Seitenverwaltung: einzelne Seiten offline nehmen und die Reihenfolge ändern – docs/sites.md#seo--zugang. An offline page answers
 * with the site's own 404 (the domain and every other page stay online) and is marked `noindex` while offline (its earlier setting
 * comes back with it). The order is the pages' `position` – the first page is the start page.
 */

export const sitePagesModule: Module = {
  name: 'site-pages',
  migrations: [
    [
      '001-offline',
      `CREATE TABLE site_page_offline (
        page_id TEXT PRIMARY KEY REFERENCES funnel_pages(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        prev_noindex INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL
      );
      CREATE INDEX site_page_offline_funnel ON site_page_offline(funnel_id);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const funnelOr404 = (ctx: Ctx, fid: string) => {
      const f = db.get<{ id: string }>('SELECT id FROM funnels WHERE id = ? AND location_id = ?', fid, ctx.locationId);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };
    const state = (fid: string) => {
      const off = new Set(db.all<{ page_id: string }>('SELECT page_id FROM site_page_offline WHERE funnel_id = ?', fid).map((r) => r.page_id));
      return db.all<any>('SELECT id, name, slug, position FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', fid).map((p, i) => ({ ...p, start: i === 0, offline: off.has(p.id) }));
    };

    router.get('/api/funnels/:id/pages-state', 'location', (ctx) => state(funnelOr404(ctx, ctx.params.id).id));
    router.put('/api/funnel-pages/:id/offline', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const p = parseJson(db.get<any>('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['seo']);
      if (!p) throw notFound('Seite nicht gefunden');
      const offline = ctx.body?.offline === true;
      const row = db.get<{ prev_noindex: number }>('SELECT prev_noindex FROM site_page_offline WHERE page_id = ?', p.id);
      db.tx(() => {
        if (offline && !row) {
          db.insert('site_page_offline', { page_id: p.id, location_id: ctx.locationId, funnel_id: p.funnel_id, prev_noindex: p.seo?.noindex ? 1 : 0, at: now() });
          db.update('funnel_pages', p.id, { seo: { ...(p.seo ?? {}), noindex: true } });
        } else if (!offline && row) {
          db.run('DELETE FROM site_page_offline WHERE page_id = ?', p.id);
          db.update('funnel_pages', p.id, { seo: { ...(p.seo ?? {}), noindex: !!row.prev_noindex } });
        }
      });
      return state(p.funnel_id);
    });
    /** `{ page_ids: [...] }` in the new order (every page of the site once). */
    router.post('/api/funnels/:id/reorder', 'location', (ctx) => {
      const f = funnelOr404(ctx, ctx.params.id);
      const ids: string[] = Array.isArray(ctx.body?.page_ids) ? ctx.body.page_ids.map(String) : [];
      const have = db.all<{ id: string }>('SELECT id FROM funnel_pages WHERE funnel_id = ?', f.id).map((r) => r.id);
      if (ids.length !== have.length || new Set(ids).size !== ids.length || ids.some((x) => !have.includes(x))) throw bad('Bitte jede Seite der Website genau einmal angeben');
      db.tx(() => {
        ids.forEach((pid, i) => db.run('UPDATE funnel_pages SET position = ? WHERE id = ?', i, pid));
        db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', now(), f.id);
      });
      return state(f.id);
    });

    // The page pipeline asks app.services.siteRedirect first: an offline page answers with the site's 404 there.
    const previous = app.services.siteRedirect as ((ctx: Ctx, f: any, segments: string[]) => unknown) | undefined;
    app.services.siteRedirect = (ctx: Ctx, f: any, segments: string[]) => {
      if (f?.id && segments.length <= 1 && db.get('SELECT 1 FROM site_page_offline WHERE funnel_id = ? LIMIT 1', f.id)) {
        const pages = parseRows(db.all<any>('SELECT id, slug FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', f.id), []);
        const page = segments.length ? pages.find((p) => p.slug === segments[0]) : pages[0];
        if (page && db.get('SELECT 1 FROM site_page_offline WHERE page_id = ?', page.id)) {
          const r = app.services.siteNotFound?.(ctx, f);
          if (r) {
            r.headers['cache-control'] = 'no-store';
            return r;
          }
        }
      }
      return previous?.(ctx, f, segments);
    };

    const TOOLS: Tool[] = [
      {
        name: 'ghl_site_page_offline',
        title: 'Seite offline nehmen oder wieder online stellen',
        description: 'Nimmt eine einzelne Seite einer Website offline (Besucher sehen die 404-Seite, die Domain und andere Seiten bleiben online) oder stellt sie wieder online.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, page_id: { type: 'string' }, offline: { type: 'boolean' } }, required: ['location_id', 'page_id', 'offline'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        run: (call, a) => call.api('PUT', `/api/funnel-pages/${encodeURIComponent(a.page_id)}/offline`, { location: a.location_id, body: { offline: a.offline } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
