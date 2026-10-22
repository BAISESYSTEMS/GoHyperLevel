import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, now, slugify } from '../core/util.js';
import { isBot } from '../services/ab-stats.js';
import { excerptOf, stripMarkdown } from '../services/markdown.js';
import { FIELD_LABEL, FIELD_TYPES, PRESETS, cleanData, cleanFields, cleanSettings, defaultDetail, display, fillTemplate, listItems, presetOf, type CollectionSettings, type Field, type ItemView } from '../services/site-cms.js';
import { imgTag, siteBlocks, type Block, type BlockEnv } from '../services/site-blocks.js';
import { cleanBlocks } from '../services/site-layout.js';
import { renderPage } from '../services/site-render.js';
import { pageUrl } from '../services/site-url.js';

/**
 * CMS collections for websites: your own record types (team, projects, products, testimonials, FAQ, jobs …) with fields you define.
 * A collection has a list (`/<site>/<collection>`, filter by select/tag fields, search, paging, sorting), a page per record
 * (`/<site>/<collection>/<record>`) built from a detail template with `{{field}}` placeholders, and can be placed on any page as a
 * "Sammlung" block. Records are drafts until published; published ones are in the sitemap and the site search. Product fields link
 * to the sub-account's products (Kauf-Button). Dynamic paths are served through `app.services.siteResolve` (see funnels.ts).
 */

const RESERVED_SLUGS = ['blog', 'search', 'sitemap.xml', 'robots.txt', 'pghl-consent', '404', 'api', 'p', 'f', 'book', 'buy', 'uploads'];
const MAX_COLLECTIONS = 20;
const MAX_ITEMS = 2000;

interface Coll {
  id: string;
  location_id: string;
  funnel_id: string;
  name: string;
  slug: string;
  singular: string;
  fields: Field[];
  settings: CollectionSettings;
  detail_blocks: Block[];
  created_at: string;
  updated_at: string;
}
interface Item {
  id: string;
  collection_id: string;
  slug: string;
  data: Record<string, any>;
  status: 'draft' | 'published';
  position: number;
  views: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

const CSS = `.coll>:is(h1,h2,h3){margin:0 0 .5em}.cintro{color:var(--muted);margin:0 0 1.2em}.cgrid{display:grid;gap:20px;grid-template-columns:repeat(var(--cc,3),minmax(0,1fr))}
.ccard{display:flex;flex-direction:column;background:var(--c-bg);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;box-shadow:var(--sh-sm);text-align:left}
.cimg{display:block;aspect-ratio:4/3;background:linear-gradient(135deg,var(--c-brand-soft),var(--c-surface))}.cimg img{width:100%;height:100%;object-fit:cover;display:block}
.cb{padding:1em 1.1em 1.2em;display:flex;flex-direction:column;gap:.35em;flex:1}.cb :is(h2,h3,h4){margin:0;font-size:var(--fs-1)}.cb :is(h2,h3,h4) a{color:inherit;text-decoration:none}.cb :is(h2,h3,h4) a:hover{color:var(--c-brand)}
.cmeta{margin:0;color:var(--muted);font-size:.88em}.ctext{margin:0}.cb .btn{align-self:flex-start;margin-top:auto}
.cgrid.lst{grid-template-columns:1fr}.lst .ccard{flex-direction:row}.lst .cimg{width:32%;aspect-ratio:auto;flex:none}.lst .ccard.noimg .cb{padding:1em 1.2em}
.cstars{color:#b45309;letter-spacing:.1em}
.cfilter{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 1.2em}.cfilter .chip{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:99px;background:var(--c-surface);color:var(--text);font-weight:600;text-decoration:none}.cfilter .chip.on,.cfilter .chip:hover{background:var(--c-brand);color:var(--c-on-brand)}
.cfilter form{display:flex;gap:6px;margin-left:auto}.cfilter input{width:170px}
.cpager{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:1.6em;color:var(--muted)}
@media (max-width:900px){.cgrid{grid-template-columns:repeat(min(var(--cc,3),2),minmax(0,1fr))}}@media (max-width:560px){.cgrid{grid-template-columns:1fr}.lst .ccard{flex-direction:column}.lst .cimg{width:auto;aspect-ratio:4/3}.cfilter form{margin-left:0;width:100%}.cfilter input{flex:1}}`;

export const siteCmsModule: Module = {
  name: 'site-cms',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE site_collections (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL, singular TEXT NOT NULL DEFAULT '',
        fields TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}', detail_blocks TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(funnel_id, slug)
      );
      CREATE INDEX site_collections_loc ON site_collections(location_id);
      CREATE TABLE site_items (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        collection_id TEXT NOT NULL REFERENCES site_collections(id) ON DELETE CASCADE,
        slug TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft',
        position INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, published_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(collection_id, slug)
      );
      CREATE INDEX site_items_list ON site_items(collection_id, status, position);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };

    const funnelOf = (loc: string, fid: string) => parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, loc), ['settings']);
    const funnelOr404 = (ctx: Ctx, fid = ctx.params.id) => {
      const f = funnelOf(ctx.locationId, fid);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };
    const parseColl = (r: any): Coll | undefined => (r ? (parseJson(r, ['fields', 'settings', 'detail_blocks']) as Coll) : undefined);
    const collOf = (loc: string, cid: string) => parseColl(db.get('SELECT * FROM site_collections WHERE id = ? AND location_id = ?', cid, loc));
    const collOr404 = (ctx: Ctx, cid = ctx.params.id) => {
      const c = collOf(ctx.locationId, cid);
      if (!c) throw notFound('Sammlung nicht gefunden');
      return c;
    };
    const parseItem = (r: any): Item => parseJson(r, ['data']) as Item;
    const itemsOf = (cid: string, status?: string): Item[] => db.all(`SELECT * FROM site_items WHERE collection_id = ?${status ? ' AND status = ?' : ''} ORDER BY position, created_at`, cid, ...(status ? [status] : [])).map(parseItem);
    const productExists = (loc: string) => (pid: string) => !!db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, loc);

    const collUrl = (f: any, c: Coll) => pageUrl(app, f, { slug: c.slug });
    const itemUrl = (f: any, c: Coll, it: Item) => `${collUrl(f, c)}/${it.slug}`;
    const money = (cents: number, cur: string) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: String(cur || 'EUR').toUpperCase() }).format(cents / 100);
    /** Product field → name, price and buy link (only for products that can be bought). */
    const productOf = (loc: string) => (pid: string) => {
      if (!pid) return undefined;
      const sb = app.services.stripeBuy;
      const found = sb?.resolveProduct?.(pid);
      if (!found || found.p.location_id !== loc) return undefined;
      const { gross } = sb.grossOf(found.p);
      return { name: String(found.p.name), price: money(gross, found.p.currency), url: `${app.baseUrl()}/buy/${encodeURIComponent(found.link?.slug || found.p.id)}` };
    };
    const viewOf = (f: any, c: Coll, it: Item): ItemView => ({ id: it.id, slug: it.slug, data: it.data, url: itemUrl(f, c, it), product: productOf(f.location_id) });

    const titleOf = (c: Coll, it: Item) => display(c.fields.find((x) => x.key === c.settings.title_field), it.data[c.settings.title_field]) || it.slug;
    const uniqueSlug = (cid: string, base: string, except = '') => {
      const root = slugify(base) || 'eintrag';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM site_items WHERE collection_id = ? AND slug = ? AND id != ?', cid, slug, except); i++) slug = `${root}-${i}`;
      return slug;
    };

    // --- rendering ---------------------------------------------------------------------------------------------------------
    /** The list: filters, search, cards, paging. Query parameters of the visitor's request: f_<field>, q, page. */
    function renderList(env: BlockEnv, c: Coll, o: { layout?: string; columns?: number; limit?: number; filter?: { field?: string; value?: string }; sort?: string; dir?: string; heading?: string; level?: number; filters?: boolean; paginate?: boolean; button?: string; intro?: string }, itemsOverride?: Item[]): string {
      // Heading levels: the list's own heading (2, or 1 on the list page), the cards one level below it; without a heading the cards are H2.
      const lvl = Math.min(3, Math.max(1, o.level ?? 2));
      const cardLvl = o.heading ? lvl + 1 : 2;
      const f = env.funnel;
      const s = c.settings;
      const q = env.ctx?.query ?? new URLSearchParams();
      const filters: Record<string, string> = {};
      if (o.filter?.field && o.filter.value) filters[o.filter.field] = o.filter.value;
      if (o.filters) for (const fd of c.fields) if (fd.filterable && q.get(`f_${fd.key}`)) filters[fd.key] = q.get(`f_${fd.key}`)!;
      const published = itemsOverride ?? itemsOf(c.id, 'published');
      const per = o.paginate ? s.per_page : Math.min(48, Math.max(1, o.limit || s.per_page));
      const res = listItems(published, c.fields, { filters, q: o.filters ? (q.get('q') ?? '') : '', page: o.paginate ? Number(q.get('page')) || 1 : 1, per, sort: o.sort || s.sort_field, dir: (o.dir || s.sort_dir) === 'desc' ? 'desc' : 'asc' });
      const base = collUrl(f, c);
      const href = (extra: Record<string, string>, drop: string[] = []) => {
        const u = new URLSearchParams();
        for (const [k, v] of q.entries()) if (/^(f_[a-z0-9_]+|q)$/.test(k) && !drop.includes(k)) u.set(k, v);
        for (const [k, v] of Object.entries(extra)) if (v) u.set(k, v);
        const qs = u.toString();
        return `${base}${qs ? `?${qs}` : ''}`;
      };
      const link = (it: Item) => (s.detail_pages ? itemUrl(f, c, it) : '');
      const imgField = c.fields.find((x) => x.key === s.image_field);
      const metaOf = (it: Item) =>
        s.meta_fields
          .map((k) => {
            const fd = c.fields.find((x) => x.key === k);
            const v = display(fd, it.data[k]);
            return v ? (fd?.type === 'rating' ? `<span class="cstars" role="img" aria-label="${Number(it.data[k])} von 5 Sternen">${escapeHtml(v)}</span>` : escapeHtml(v)) : '';
          })
          .filter(Boolean)
          .join(' · ');
      const cards = res.rows
        .map((it) => {
          const title = titleOf(c, it);
          const url = link(it);
          const imgSrc = imgField ? String(it.data[imgField.key] ?? '') : '';
          const img = imgSrc ? imgTag(env, { src: imgSrc, alt: '', sizes: '(max-width:560px) 100vw, 360px' }) : '';
          const textRaw = s.text_field ? String(it.data[s.text_field] ?? '') : '';
          const text = textRaw ? excerptOf(stripMarkdown(textRaw), 260) : '';
          const meta = metaOf(it);
          return `<article class="ccard${imgField && !img ? '' : img ? '' : ' noimg'}">${imgField ? `<${url ? `a href="${escapeHtml(url)}" tabindex="-1" aria-hidden="true"` : 'div'} class="cimg">${img}</${url ? 'a' : 'div'}>` : ''}<div class="cb"><h${cardLvl}>${url ? `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>` : escapeHtml(title)}</h${cardLvl}>${meta ? `<p class="cmeta">${meta}</p>` : ''}${text ? `<p class="ctext">${escapeHtml(text)}</p>` : ''}${url ? `<a class="btn secondary" href="${escapeHtml(url)}" aria-label="${escapeHtml(`${o.button || s.button_text}: ${title}`)}">${escapeHtml(o.button || s.button_text)}</a>` : ''}</div></article>`;
        })
        .join('');
      // chips for filter fields; free text search
      let bar = '';
      if (o.filters) {
        const chips: string[] = [];
        for (const fd of c.fields.filter((x) => x.filterable && x.type !== 'text')) {
          const values = fd.type === 'bool' ? ['1'] : fd.type === 'tags' ? [...new Set(published.flatMap((it) => (Array.isArray(it.data[fd.key]) ? it.data[fd.key] : [])))] : (fd.options ?? []).filter((v) => published.some((it) => it.data[fd.key] === v));
          if (!values.length) continue;
          const cur = q.get(`f_${fd.key}`) ?? '';
          chips.push(`<a class="chip${cur ? '' : ' on'}" href="${escapeHtml(href({}, [`f_${fd.key}`]))}"${cur ? '' : ' aria-current="true"'}>Alle ${escapeHtml(fd.label)}</a>`);
          for (const v of values as string[]) chips.push(`<a class="chip${cur === v ? ' on' : ''}" href="${escapeHtml(href({ [`f_${fd.key}`]: v }))}"${cur === v ? ' aria-current="true"' : ''}>${escapeHtml(fd.type === 'bool' ? fd.label : v)}</a>`);
        }
        const hidden = [...q.entries()].filter(([k]) => /^f_[a-z0-9_]+$/.test(k)).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
        bar = `<div class="cfilter">${chips.join('')}<form role="search" action="${escapeHtml(base)}" method="get">${hidden}<input type="search" name="q" value="${escapeHtml(q.get('q') ?? '')}" aria-label="In ${escapeHtml(c.name)} suchen" placeholder="Suchen …" maxlength="80"><button type="submit">Suchen</button></form></div>`;
      }
      const pager =
        o.paginate && res.pages > 1
          ? `<nav class="cpager" aria-label="Seiten">${res.page > 1 ? `<a class="btn secondary" rel="prev" href="${escapeHtml(href(res.page - 1 > 1 ? { page: String(res.page - 1) } : {}))}">← Zurück</a>` : ''}<span>Seite ${res.page} von ${res.pages}</span>${res.page < res.pages ? `<a class="btn secondary" rel="next" href="${escapeHtml(href({ page: String(res.page + 1) }))}">Weiter →</a>` : ''}</nav>`
          : '';
      const cols = Math.min(4, Math.max(1, Math.round(o.columns || s.columns)));
      const layout = (o.layout || s.layout) === 'list' ? 'list' : 'grid';
      const empty = `<p class="muted">${Object.keys(filters).length || q.get('q') ? 'Nichts gefunden – andere Filter probieren.' : 'Hier erscheinen bald die ersten Einträge.'}</p>`;
      return `<div class="coll">${o.heading ? `<h${lvl}>${escapeHtml(o.heading)}</h${lvl}>` : ''}${o.intro ? `<p class="cintro">${escapeHtml(o.intro)}</p>` : ''}${bar}${cards ? `<div class="cgrid${layout === 'list' ? ' lst' : ''}" style="--cc:${cols}">${cards}</div>` : empty}${pager}</div>`;
    }

    siteBlocks(app).set('collection', {
      type: 'collection',
      css: CSS,
      render: (env, b, o) => {
        // Template previews: a collection that does not exist yet shows the preset's example entries.
        const preset = env.preview && String(b.collection_id ?? '').startsWith('preset:') ? presetOf(String(b.collection_id).slice(7)) : undefined;
        if (preset) {
          const fields = cleanFields(preset.fields);
          const settings = cleanSettings(preset.settings, fields);
          const demo = { id: 'preset', location_id: env.locationId, funnel_id: '', name: preset.name, slug: preset.slug, singular: preset.singular, fields, settings, detail_blocks: [], created_at: '', updated_at: '' } as Coll;
          const items = preset.samples.map((raw, i) => ({ id: `s${i}`, collection_id: 'preset', slug: `beispiel-${i + 1}`, data: cleanData(fields, raw), status: 'published', position: i, views: 0, published_at: now(), created_at: now(), updated_at: now() }) as Item);
          const inner = renderList(env, demo, { layout: b.layout, columns: b.columns, limit: Number(b.limit) || undefined, filter: { field: b.filter_field, value: b.filter_value }, sort: b.sort_field, dir: b.sort_dir, heading: b.heading, filters: !!b.show_filters, paginate: !!b.paginate, button: b.button_text }, items);
          return o.bare ? `<div class="blk blk-collection">${inner}</div>` : `<section class="blk blk-collection"><div class="in wide">${inner}</div></section>`;
        }
        const c = collOf(env.locationId, String(b.collection_id ?? ''));
        // Only collections of this site (and so of its sub-account) are shown; its links point into this site.
        if (!c || (env.funnel.id && c.funnel_id !== env.funnel.id)) return env.preview ? `<div class="blk"><p class="muted" style="text-align:center;padding:24px">Sammlung wählen</p></div>` : '';
        const inner = renderList(env, c, { layout: b.layout, columns: b.columns, limit: Number(b.limit) || undefined, filter: { field: b.filter_field, value: b.filter_value }, sort: b.sort_field, dir: b.sort_dir, heading: b.heading, level: Number(b.heading_level) || undefined, filters: !!b.show_filters, paginate: !!b.paginate, button: b.button_text });
        return o.bare ? `<div class="blk blk-collection">${inner}</div>` : `<section class="blk blk-collection"><div class="in wide">${inner}</div></section>`;
      },
    });

    const SANDBOX = () => (app.services.siteServe as { sandbox: string }).sandbox;
    const done = (r: RawResult): RawResult => {
      r.headers['content-security-policy'] = SANDBOX();
      r.headers['cache-control'] = 'private, no-cache';
      return r;
    };

    function listPage(ctx: Ctx, f: any, c: Coll): RawResult {
      const s = c.settings;
      const page = {
        id: `coll:${c.id}`,
        name: c.name,
        slug: c.slug,
        seo: { title: s.seo_title ? s.seo_title.replace(/\{\{\s*(title|collection)\s*\}\}/g, c.name) : c.name, description: s.intro, noindex: !s.indexable || undefined },
        layout: {},
        blocks: [{ id: 'cl1', type: 'collection', collection_id: c.id, heading: c.name, heading_level: 1, show_filters: true, paginate: true, padding: 56 }],
      };
      // The collection's own intro text goes above the list.
      if (s.intro) (page.blocks[0] as any).intro = s.intro;
      const canonical = collUrl(f, c);
      return done(html(renderPage(app, f, page as any, false, { ctx, url: canonical })));
    }

    function detailPage(ctx: Ctx, f: any, c: Coll, it: Item, preview = false): RawResult {
      const view = viewOf(f, c, it);
      const site = String(f.settings?.site_name || f.name);
      const fill = <T,>(x: T) => fillTemplate(x, view, c.fields, c.settings, { collection: c.name, site });
      const tpl = c.detail_blocks.length ? c.detail_blocks : defaultDetail(c.fields, c.settings);
      const title = titleOf(c, it);
      const text = c.settings.text_field ? stripMarkdown(String(it.data[c.settings.text_field] ?? '')) : '';
      const img = c.settings.image_field ? String(it.data[c.settings.image_field] ?? '') : '';
      const page = {
        id: `item:${it.id}`,
        name: title,
        slug: `${c.slug}/${it.slug}`,
        seo: { title: fill(c.settings.seo_title || '{{title}}'), description: fill(c.settings.seo_description) || excerptOf(text, 160), og_image: /^https?:\/\//.test(img) ? img : undefined, noindex: !c.settings.indexable || preview || undefined },
        layout: {},
        blocks: fill(tpl) as Block[],
      };
      return done(html(renderPage(app, f, page as any, false, { ctx, url: itemUrl(f, c, it), item: it.data, preview })));
    }

    /** `app.services.siteResolve`: /<collection> and /<collection>/<record>. */
    app.services.siteResolve = [
      ...(app.services.siteResolve ?? []),
      (ctx: Ctx, f: any, segments: string[]): RawResult | undefined => {
        if (!segments.length || segments.length > 2) return undefined;
        const c = parseColl(db.get('SELECT * FROM site_collections WHERE funnel_id = ? AND slug = ?', f.id, segments[0]));
        if (!c) return undefined;
        if (segments.length === 1) return c.settings.list_page ? listPage(ctx, f, c) : undefined;
        if (!c.settings.detail_pages) return undefined;
        const row = db.get(`SELECT * FROM site_items WHERE collection_id = ? AND slug = ? AND status = 'published'`, c.id, segments[1]);
        if (!row) return undefined;
        const it = parseItem(row);
        if (!isBot(String(ctx.req.headers['user-agent'] ?? ''))) db.run('UPDATE site_items SET views = views + 1 WHERE id = ?', it.id);
        return detailPage(ctx, f, c, it);
      },
    ];

    app.services.siteSitemap = [
      ...(app.services.siteSitemap ?? []),
      (f: any) => {
        if (f.settings?.noindex) return [];
        const out: { loc: string; lastmod?: string }[] = [];
        for (const c of db.all('SELECT * FROM site_collections WHERE funnel_id = ?', f.id).map((r) => parseColl(r)!)) {
          if (!c.settings.indexable) continue;
          const items = itemsOf(c.id, 'published');
          if (!items.length) continue;
          if (c.settings.list_page) out.push({ loc: collUrl(f, c), lastmod: items.reduce((m, i) => (i.updated_at > m ? i.updated_at : m), '') });
          if (c.settings.detail_pages) for (const it of items) out.push({ loc: itemUrl(f, c, it), lastmod: it.updated_at });
        }
        return out;
      },
    ];

    app.services.siteSearchDocs = [
      ...(app.services.siteSearchDocs ?? []),
      (f: any) => {
        if (f.settings?.noindex) return [];
        const docs: { kind: string; title: string; url: string; text: string; label: string }[] = [];
        for (const c of db.all('SELECT * FROM site_collections WHERE funnel_id = ?', f.id).map((r) => parseColl(r)!)) {
          if (!c.settings.indexable || (!c.settings.detail_pages && !c.settings.list_page)) continue;
          for (const it of itemsOf(c.id, 'published')) {
            const text = c.fields.filter((x) => ['text', 'longtext', 'select', 'tags'].includes(x.type)).map((x) => stripMarkdown(display(x, it.data[x.key]))).join(' ');
            docs.push({ kind: 'item', title: titleOf(c, it), url: c.settings.detail_pages ? itemUrl(f, c, it) : collUrl(f, c), text, label: c.name });
          }
        }
        return docs;
      },
    ];

    // --- API: collections -------------------------------------------------------------------------------------------------
    const collOut = (c: Coll, f?: any) => {
      const counts = db.get<{ n: number; p: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(status = 'published'), 0) AS p FROM site_items WHERE collection_id = ?`, c.id)!;
      return { ...c, items: Number(counts.n), published: Number(counts.p), ...(f ? { url: collUrl(f, c) } : {}) };
    };
    const slugOk = (fid: string, slug: string, except = '') => {
      if (!slug || RESERVED_SLUGS.includes(slug)) throw bad(`Der Pfad „${slug || '…'}“ ist nicht möglich`);
      if (db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = ?', fid, slug)) throw bad(`Es gibt schon eine Seite mit dem Pfad „${slug}“`);
      if (db.get('SELECT id FROM site_collections WHERE funnel_id = ? AND slug = ? AND id != ?', fid, slug, except)) throw bad(`Es gibt schon eine Sammlung mit dem Pfad „${slug}“`);
    };

    router.get('/api/funnels/:id/collection-presets', 'location', (ctx) => {
      funnelOr404(ctx);
      return { presets: PRESETS.map((p) => ({ key: p.key, name: p.name, singular: p.singular, description: p.description, slug: p.slug, fields: p.fields })), field_types: FIELD_TYPES.map((t) => ({ key: t, label: FIELD_LABEL[t] })) };
    });
    router.get('/api/funnels/:id/collections', 'location', (ctx) => {
      const f = funnelOr404(ctx);
      return db.all('SELECT * FROM site_collections WHERE funnel_id = ? ORDER BY created_at', f.id).map((r) => collOut(parseColl(r)!, f));
    });
    router.post('/api/funnels/:id/collections', 'location', (ctx) => {
      writable(ctx);
      const f = funnelOr404(ctx);
      const b = ctx.body ?? {};
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_collections WHERE funnel_id = ?', f.id)!.n >= MAX_COLLECTIONS) throw bad(`Höchstens ${MAX_COLLECTIONS} Sammlungen je Website`);
      const preset = presetOf(b.preset);
      const name = str(b.name || preset?.name, 'Name', { required: true, max: 80 });
      const slug = slugify(String(b.slug || preset?.slug || name));
      slugOk(f.id, slug);
      const fields = cleanFields(b.fields ?? preset?.fields);
      const settings = cleanSettings({ ...(preset?.settings ?? {}), ...(b.settings ?? {}) }, fields);
      const c: Coll = { id: id(), location_id: ctx.locationId, funnel_id: f.id, name, slug, singular: str(b.singular || preset?.singular || 'Eintrag', 'Singular', { max: 60 }), fields, settings, detail_blocks: preset ? cleanBlocks(preset.detail()) : b.detail_blocks ? cleanBlocks(b.detail_blocks) : [], created_at: now(), updated_at: now() };
      db.tx(() => {
        db.insert('site_collections', c);
        if (preset && b.with_samples) {
          preset.samples.forEach((raw, i) => {
            const data = cleanData(fields, raw);
            db.insert('site_items', { id: id(), location_id: ctx.locationId, funnel_id: f.id, collection_id: c.id, slug: uniqueSlug(c.id, String(data[settings.title_field] ?? 'eintrag')), data, status: 'published', position: i, views: 0, published_at: now(), created_at: now(), updated_at: now() });
          });
        }
      });
      return collOut(c, f);
    });
    router.get('/api/site-collections/:id', 'location', (ctx) => {
      const c = collOr404(ctx);
      return collOut(c, funnelOf(ctx.locationId, c.funnel_id));
    });
    router.patch('/api/site-collections/:id', 'location', (ctx) => {
      writable(ctx);
      const c = collOr404(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 80 });
      if (b.singular !== undefined) patch.singular = str(b.singular, 'Singular', { max: 60 });
      if (b.slug !== undefined) {
        const slug = slugify(String(b.slug));
        if (slug !== c.slug) slugOk(c.funnel_id, slug, c.id);
        patch.slug = slug;
      }
      const fields = b.fields !== undefined ? cleanFields(b.fields) : c.fields;
      if (b.fields !== undefined) {
        // A field's type cannot change once records exist (the values would no longer fit).
        for (const old of c.fields) {
          const n = fields.find((x) => x.key === old.key);
          if (n && n.type !== old.type && db.get('SELECT id FROM site_items WHERE collection_id = ? LIMIT 1', c.id)) throw bad(`Der Typ von „${old.label}“ lässt sich nicht ändern, solange es Einträge gibt – lege ein neues Feld an`);
        }
        patch.fields = fields;
      }
      if (b.fields !== undefined || b.settings !== undefined) patch.settings = cleanSettings(b.settings, fields, c.settings);
      if (b.detail_blocks !== undefined) patch.detail_blocks = cleanBlocks(b.detail_blocks);
      db.update('site_collections', c.id, patch);
      return collOut(collOf(ctx.locationId, c.id)!, funnelOf(ctx.locationId, c.funnel_id));
    });
    router.delete('/api/site-collections/:id', 'location', (ctx) => {
      writable(ctx);
      const c = collOr404(ctx);
      db.run('DELETE FROM site_collections WHERE id = ?', c.id);
      return { ok: true };
    });

    // --- API: items --------------------------------------------------------------------------------------------------------
    const itemOut = (f: any, c: Coll, it: Item) => ({ ...it, title: titleOf(c, it), url: itemUrl(f, c, it) });
    const itemOr404 = (ctx: Ctx) => {
      const row = db.get('SELECT * FROM site_items WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!row) throw notFound('Eintrag nicht gefunden');
      const it = parseItem(row);
      return { it, c: collOf(ctx.locationId, it.collection_id)! };
    };
    const statusOf = (v: unknown, cur?: Item) => (v === 'published' || v === 'draft' ? v : (cur?.status ?? 'draft'));

    router.get('/api/site-collections/:id/items', 'location', (ctx) => {
      const c = collOr404(ctx);
      const f = funnelOf(ctx.locationId, c.funnel_id);
      const st = ctx.query.get('status');
      const q = String(ctx.query.get('q') ?? '').trim();
      let rows = itemsOf(c.id, st === 'draft' || st === 'published' ? st : undefined);
      if (q) rows = listItems(rows, c.fields, { q, per: 48 }).rows;
      return rows.slice(0, 500).map((it) => itemOut(f, c, it));
    });
    router.post('/api/site-collections/:id/items', 'location', (ctx) => {
      writable(ctx);
      const c = collOr404(ctx);
      const f = funnelOf(ctx.locationId, c.funnel_id);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_items WHERE collection_id = ?', c.id)!.n >= MAX_ITEMS) throw bad(`Höchstens ${MAX_ITEMS} Einträge je Sammlung`);
      const data = cleanData(c.fields, ctx.body?.data, productExists(ctx.locationId));
      const status = statusOf(ctx.body?.status);
      const row = {
        id: id(),
        location_id: ctx.locationId,
        funnel_id: c.funnel_id,
        collection_id: c.id,
        slug: uniqueSlug(c.id, String(ctx.body?.slug || data[c.settings.title_field] || c.singular)),
        data,
        status,
        position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM site_items WHERE collection_id = ?', c.id)!.n,
        views: 0,
        published_at: status === 'published' ? now() : null,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('site_items', row);
      if (status === 'published') app.events.emit(ctx.locationId, 'site.item_published', { itemId: row.id, collectionId: c.id, funnelId: c.funnel_id, title: titleOf(c, row as any), url: itemUrl(f, c, row as any) });
      return itemOut(f, c, row as any);
    });
    router.patch('/api/site-items/:id', 'location', (ctx) => {
      writable(ctx);
      const { it, c } = itemOr404(ctx);
      const f = funnelOf(ctx.locationId, c.funnel_id);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.data !== undefined) patch.data = cleanData(c.fields, b.data, productExists(ctx.locationId), it.data);
      if (b.slug !== undefined) {
        const slug = slugify(String(b.slug));
        if (!slug) throw bad('Pfad fehlt');
        if (db.get('SELECT id FROM site_items WHERE collection_id = ? AND slug = ? AND id != ?', c.id, slug, it.id)) throw bad('Diesen Pfad hat schon ein anderer Eintrag');
        patch.slug = slug;
      }
      if (b.status !== undefined) {
        patch.status = statusOf(b.status, it);
        if (patch.status === 'published' && it.status !== 'published') patch.published_at = now();
      }
      db.update('site_items', it.id, patch);
      const now2 = parseItem(db.get('SELECT * FROM site_items WHERE id = ?', it.id));
      if (now2.status === 'published' && it.status !== 'published') app.events.emit(ctx.locationId, 'site.item_published', { itemId: it.id, collectionId: c.id, funnelId: c.funnel_id, title: titleOf(c, now2), url: itemUrl(f, c, now2) });
      return itemOut(f, c, now2);
    });
    router.delete('/api/site-items/:id', 'location', (ctx) => {
      writable(ctx);
      const { it } = itemOr404(ctx);
      db.run('DELETE FROM site_items WHERE id = ?', it.id);
      return { ok: true };
    });
    router.post('/api/site-items/:id/duplicate', 'location', (ctx) => {
      writable(ctx);
      const { it, c } = itemOr404(ctx);
      const f = funnelOf(ctx.locationId, c.funnel_id);
      const row = { ...it, id: id(), slug: uniqueSlug(c.id, `${it.slug}-kopie`), status: 'draft', published_at: null, views: 0, position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM site_items WHERE collection_id = ?', c.id)!.n, created_at: now(), updated_at: now() };
      db.insert('site_items', { ...row, location_id: ctx.locationId, funnel_id: c.funnel_id });
      return itemOut(f, c, row as Item);
    });
    /** New order of the records: the ids in the order they should appear (positions of the others are untouched). */
    router.put('/api/site-collections/:id/order', 'location', (ctx) => {
      writable(ctx);
      const c = collOr404(ctx);
      const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String).slice(0, MAX_ITEMS) : [];
      db.tx(() => ids.forEach((iid, i) => db.run('UPDATE site_items SET position = ?, updated_at = ? WHERE id = ? AND collection_id = ?', i, now(), iid, c.id)));
      return { ok: true };
    });

    /** The detail template a collection without one of its own gets (the editor starts from it). */
    router.get('/api/site-collections/:id/detail-default', 'location', (ctx) => {
      const c = collOr404(ctx);
      return { blocks: defaultDetail(c.fields, c.settings) };
    });

    /** Editor preview of the detail template (with a record) or the list. */
    router.post('/api/site-collections/:id/preview', 'location', (ctx) => {
      const c = collOr404(ctx);
      const f = funnelOf(ctx.locationId, c.funnel_id);
      const draft: Coll = { ...c, detail_blocks: ctx.body?.detail_blocks ? cleanBlocks(ctx.body.detail_blocks) : c.detail_blocks, settings: ctx.body?.settings ? cleanSettings(ctx.body.settings, c.fields, c.settings) : c.settings };
      if (ctx.body?.kind === 'list') {
        const r = listPage(ctx, f, draft);
        return r;
      }
      const row = ctx.body?.item_id ? db.get('SELECT * FROM site_items WHERE id = ? AND collection_id = ?', ctx.body.item_id, c.id) : db.get('SELECT * FROM site_items WHERE collection_id = ? ORDER BY position LIMIT 1', c.id);
      if (!row) throw bad('Lege zuerst einen Eintrag an, dann gibt es etwas zu sehen');
      return detailPage(ctx, f, draft, parseItem(row), true);
    });
  },
};

