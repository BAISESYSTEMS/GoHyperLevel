import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { id, now, slugify } from '../core/util.js';
import type { Maps, SnapshotPart } from '../services/snapshots.js';

/**
 * Copying a site (agency snapshots, "copy to another sub-account", cloud/SaaS signup templates) carries what the page builder added:
 * the page layout (header/footer off, language, translation group), the components the pages use, the collections with their entries,
 * and the redirects. References are rewritten to the copies: `component_id`, `collection_id`, `page:<id>` links and the custom 404 page.
 * Not copied: analytics, the list of unknown paths, and the visitors' data – a copy starts counting from zero.
 */

/** Which kinds of reference live under which key of a block or setting (the same as snapshots.ts uses for forms, calendars, products). */
const OTHER_REFS: Record<string, string> = { form_id: 'forms', calendar_slug: 'calendarSlugs', calendar_id: 'calendars', product_id: 'products', course_id: 'courses', group_id: 'communityGroups' };

interface Maps2 {
  pages: Map<string, string>;
  comps: Map<string, string>;
  cols: Map<string, string>;
}

/**
 * Rewrites references inside a block tree or settings. `others` additionally maps forms/calendars/products – for content the snapshot's
 * own page copy did not already remap (components, collection templates). Template placeholders (`{{product.id}}`) stay as they are.
 */
function rewrite<T>(value: T, m: Maps2, others?: Maps): T {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, m, others)) as T;
  if (typeof value === 'string') return (/^page:([A-Za-z0-9_-]{1,60})$/.test(value) ? `page:${m.pages.get(value.slice(5)) ?? value.slice(5)}` : value) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && v && !v.includes('{{')) {
      if (k === 'component_id') {
        out[k] = m.comps.get(v) ?? '';
        continue;
      }
      if (k === 'collection_id' && !v.startsWith('preset:')) {
        out[k] = m.cols.get(v) ?? '';
        continue;
      }
      if (k === 'page_id') {
        out[k] = m.pages.get(v) ?? '';
        continue;
      }
      if (others && OTHER_REFS[k]) {
        out[k] = others[OTHER_REFS[k]]?.get(v) ?? '';
        continue;
      }
    }
    out[k] = rewrite(v, m, others);
  }
  return out as T;
}

/** Every `component_id` in a tree. */
function componentRefs(v: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => componentRefs(x, into));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'component_id' && typeof x === 'string' && x) into.add(x);
      else componentRefs(x, into);
    }
  }
  return into;
}

export const siteSnapshotModule: Module = {
  name: 'site-snapshot',
  register(app: App) {
    const { db } = app;

    const part: SnapshotPart = {
      key: 'site_parts',
      export(_app, locationId, only) {
        const funnels = db.all('SELECT id FROM funnels WHERE location_id = ? ORDER BY created_at', locationId).filter((f) => !only || (only.funnelIds ?? []).includes(f.id));
        return funnels.map((f) => {
          const pages = parseRows(db.all('SELECT id, slug, blocks, layout FROM funnel_pages WHERE funnel_id = ? ORDER BY position', f.id), ['blocks', 'layout']);
          const collections = parseRows(db.all('SELECT * FROM site_collections WHERE funnel_id = ? ORDER BY created_at', f.id), ['fields', 'settings', 'detail_blocks']);
          // The components the pages use – and the ones those use in turn.
          const want = new Set<string>();
          pages.forEach((p) => componentRefs(p.blocks, want));
          collections.forEach((c) => componentRefs(c.detail_blocks, want));
          const comps = new Map<string, { id: string; name: string; blocks: any[] }>();
          for (let todo = [...want]; todo.length; ) {
            const cid = todo.pop()!;
            if (comps.has(cid)) continue;
            const row = db.get('SELECT id, name, blocks FROM site_components WHERE id = ? AND location_id = ?', cid, locationId);
            if (!row) continue;
            const blocks = JSON.parse(row.blocks || '[]');
            comps.set(cid, { id: row.id, name: row.name, blocks });
            todo.push(...componentRefs(blocks));
          }
          return {
            funnel_id: f.id,
            pages: pages.map((p) => ({ id: p.id, slug: p.slug, layout: p.layout })),
            components: [...comps.values()],
            collections: collections.map((c) => ({
              id: c.id,
              name: c.name,
              slug: c.slug,
              singular: c.singular,
              fields: c.fields,
              settings: c.settings,
              detail_blocks: c.detail_blocks,
              items: db
                .all('SELECT slug, data, status, position, published_at FROM site_items WHERE collection_id = ? ORDER BY position, created_at', c.id)
                .map((i) => ({ slug: i.slug, data: JSON.parse(i.data || '{}'), status: i.status, position: i.position, published_at: i.published_at })),
            })),
            redirects: db.all('SELECT source, target, code, wildcard, keep_query, note, position FROM site_redirects WHERE funnel_id = ? ORDER BY position', f.id),
          };
        });
      },

      apply(_app, locationId, items, ctx) {
        const recs = items.filter((r) => ctx.maps.funnels.get(String(r.funnel_id)));
        if (!recs.length) return;

        // Components belong to the sub-account: copying within it shares them, copying elsewhere makes copies.
        const m: Maps2 = { pages: new Map(), comps: new Map(), cols: new Map() };
        const fresh: { id: string; name: string; blocks: any[] }[] = [];
        for (const r of recs) {
          for (const c of Array.isArray(r.components) ? r.components : []) {
            if (m.comps.has(c.id)) continue;
            if (db.get('SELECT id FROM site_components WHERE id = ? AND location_id = ?', c.id, locationId)) m.comps.set(c.id, c.id);
            else {
              m.comps.set(c.id, id());
              fresh.push(c);
            }
          }
          for (const c of Array.isArray(r.collections) ? r.collections : []) m.cols.set(c.id, id());
        }
        for (const c of fresh) {
          db.insert('site_components', { id: m.comps.get(c.id), location_id: locationId, name: String(c.name ?? 'Komponente').slice(0, 120), blocks: rewrite(Array.isArray(c.blocks) ? c.blocks : [], m, ctx.maps), created_at: now(), updated_at: now() });
        }

        for (const r of recs) {
          const nf = ctx.maps.funnels.get(String(r.funnel_id))!;
          // Pages are matched by their path: the snapshot's page copies have new ids.
          const copies = db.all('SELECT id, slug, blocks FROM funnel_pages WHERE funnel_id = ?', nf);
          const bySlug = new Map(copies.map((p) => [p.slug, p]));
          m.pages = new Map();
          const layouts = new Map<string, any>();
          for (const p of Array.isArray(r.pages) ? r.pages : []) {
            const copy = bySlug.get(slugify(String(p.slug ?? '')));
            if (!copy) continue;
            m.pages.set(String(p.id), copy.id);
            layouts.set(copy.id, p.layout && typeof p.layout === 'object' ? p.layout : {});
          }
          for (const p of copies) db.update('funnel_pages', p.id, { blocks: rewrite(JSON.parse(p.blocks || '[]'), m), layout: layouts.get(p.id) ?? {} });
          const f = db.get('SELECT settings FROM funnels WHERE id = ?', nf);
          if (f) db.update('funnels', nf, { settings: rewrite(JSON.parse(f.settings || '{}'), m) });

          for (const c of Array.isArray(r.collections) ? r.collections : []) {
            const cid = m.cols.get(c.id)!;
            db.insert('site_collections', {
              id: cid,
              location_id: locationId,
              funnel_id: nf,
              name: String(c.name ?? 'Sammlung').slice(0, 120),
              slug: slugify(String(c.slug ?? c.name ?? 'sammlung')),
              singular: String(c.singular ?? '').slice(0, 120),
              fields: Array.isArray(c.fields) ? c.fields : [],
              settings: rewrite(c.settings && typeof c.settings === 'object' ? c.settings : {}, m, ctx.maps),
              detail_blocks: rewrite(Array.isArray(c.detail_blocks) ? c.detail_blocks : [], m, ctx.maps),
              created_at: now(),
              updated_at: now(),
            });
            (Array.isArray(c.items) ? c.items : []).forEach((it: any, i: number) => {
              db.insert('site_items', {
                id: id(),
                location_id: locationId,
                funnel_id: nf,
                collection_id: cid,
                slug: slugify(String(it.slug ?? `eintrag-${i + 1}`)) || `eintrag-${i + 1}`,
                data: it.data && typeof it.data === 'object' ? it.data : {},
                status: it.status === 'draft' ? 'draft' : 'published',
                position: Number(it.position ?? i) || 0,
                views: 0,
                published_at: it.published_at ?? null,
                created_at: now(),
                updated_at: now(),
              });
            });
          }
          (Array.isArray(r.redirects) ? r.redirects : []).forEach((x: any, i: number) => {
            db.insert('site_redirects', {
              id: id(),
              location_id: locationId,
              funnel_id: nf,
              source: String(x.source),
              target: String(x.target),
              code: x.code === 302 ? 302 : 301,
              wildcard: x.wildcard ? 1 : 0,
              keep_query: x.keep_query === 0 ? 0 : 1,
              note: String(x.note ?? '').slice(0, 200),
              position: Number(x.position ?? i) || 0,
              hits: 0,
              created_at: now(),
              updated_at: now(),
            });
          });
        }
      },
    };

    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];
  },
};
