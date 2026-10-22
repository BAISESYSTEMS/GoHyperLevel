import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, html, notFound, num, redirect, str, text, type Ctx, type RawResult, clampLimit } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { domainAlias } from '../core/domains.js';
import { id, now, sha256, slugify, uniq } from '../core/util.js';
import { portalUrl } from '../services/courses.js';
import { excerptOf, renderMarkdown, safeUrl, stripMarkdown } from '../services/markdown.js';
import { articleScore, searchTerms, sign, verifySig } from '../services/helpdesk.js';
import { loadHelpdeskSettings } from '../services/tickets.js';
import type { Tool } from './mcp.js';

/**
 * Knowledge base & public help center: categories and Markdown articles (draft/published), a help
 * center per sub-account at /help/<slug> (also under /help on connected website domains or on its
 * own domain), search, "War das hilfreich?" feedback, SEO tags and sitemap. The team gets article
 * suggestions while answering tickets, MCP gets ghl_search_kb, and published articles are offered to
 * the KI-Assistent as knowledge (app.services.aiKnowledge).
 */

const TOOLS: Tool[] = [
  {
    name: 'ghl_search_kb',
    title: 'Wissensdatenbank durchsuchen',
    description: 'Sucht veröffentlichte Hilfe-Artikel eines Projekts (Titel, Tags, Text). Gibt Titel, Auszug und öffentliche URL zurück; full=true liefert den Markdown-Text mit.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' }, full: { type: 'boolean' } }, required: ['location_id', 'q'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/kb/search?${new URLSearchParams({ q: String(a.q ?? ''), limit: String(a.limit ?? 5), ...(a.full ? { full: '1' } : {}) })}`, { location: a.location_id }),
  },
];

const CSS = `
:root{--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f6f7fb;--panel:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--text:#e5e7eb;--muted:#94a3b8;--line:#1e293b;--bg:#0b1020;--panel:#111a2e;color-scheme:dark}a,.side a,.top .ask{color:color-mix(in srgb,var(--brand) 65%,#fff)}}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg)}
a{color:var(--brand)}
.top{background:var(--panel);border-bottom:1px solid var(--line)}
.top .in{max-width:1080px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:12px;min-height:60px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:inherit;text-decoration:none;min-width:0}
.brand img{max-height:34px;max-width:160px;object-fit:contain}.brand .mark{width:32px;height:32px;border-radius:9px;background:var(--brand);color:#fff;display:grid;place-items:center;flex:none}
.brand span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.top .ask{margin-left:auto;font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap}
.hero{background:linear-gradient(135deg,var(--brand),color-mix(in srgb,var(--brand) 55%,#0f172a));color:#fff;padding:44px 20px 52px;text-align:center}
.hero h1{margin:0 0 6px;font-size:clamp(26px,4vw,36px);line-height:1.2}.hero p{margin:0 0 20px;opacity:.9}
.search{max-width:620px;margin:0 auto;display:flex;gap:8px;background:var(--panel);border-radius:14px;padding:6px;box-shadow:0 10px 30px rgba(15,23,42,.18)}
.search input{flex:1;min-width:0;border:0;background:transparent;color:var(--text);font:inherit;padding:10px 12px;outline:none}
.search button{border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;padding:10px 18px;cursor:pointer}
main{max-width:1080px;margin:0 auto;padding:30px 20px 64px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.cat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;text-decoration:none;color:inherit;display:block;transition:border-color .15s,transform .15s}
.cat:hover{border-color:var(--brand);transform:translateY(-1px)}.cat h2{margin:0 0 4px;font-size:18px}.cat p{margin:0;color:var(--muted);font-size:14px}.cat small{display:block;margin-top:10px;color:var(--brand);font-weight:600}
h2.sec{font-size:19px;margin:34px 0 12px}
.list{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.list a{display:block;padding:13px 18px;border-top:1px solid var(--line);text-decoration:none;color:inherit}.list a:first-child{border-top:0}.list a:hover{background:color-mix(in srgb,var(--brand) 8%,transparent)}
.list strong{display:block;color:var(--text)}.list span{display:block;color:var(--muted);font-size:14px}
.crumb{font-size:14px;color:var(--muted);margin-bottom:8px}.crumb a{color:var(--muted)}
.art{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:32px;align-items:start}
article.panel,.side{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:26px 28px}
.side{padding:18px 20px;position:sticky;top:20px}.side h3{margin:0 0 8px;font-size:15px}.side a{display:block;padding:5px 0;font-size:15px;text-decoration:none}
article h1{font-size:clamp(25px,3.4vw,32px);line-height:1.25;margin:0 0 6px}.meta{color:var(--muted);font-size:14px;margin-bottom:18px}
.prose{font-size:17px}.prose>:first-child{margin-top:0}.prose h2{font-size:22px;margin:26px 0 8px}.prose h3{font-size:19px;margin:20px 0 6px}
.prose img{max-width:100%;height:auto;border-radius:10px}.prose code{background:color-mix(in srgb,var(--brand) 10%,transparent);padding:1px 6px;border-radius:6px;font-size:.9em}
.prose pre{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:12px;overflow-x:auto}.prose pre code{background:none;padding:0}
.prose blockquote{margin:16px 0;padding:4px 18px;border-left:4px solid var(--brand);background:color-mix(in srgb,var(--brand) 8%,transparent);border-radius:0 10px 10px 0}
.md-video{position:relative;padding-top:56.25%;border-radius:12px;overflow:hidden;background:#000;margin:0 0 16px}.md-video iframe,.md-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
.helpful{margin-top:30px;padding-top:20px;border-top:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.helpful form{margin:0}.helpful button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:8px 16px;font:inherit;cursor:pointer}.helpful button:hover{border-color:var(--brand)}
.thanks{color:#059669;font-weight:600}
.contact{margin-top:34px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.btn{display:inline-block;background:var(--brand);color:#fff;border-radius:10px;padding:10px 18px;font-weight:600;text-decoration:none}
.empty{text-align:center;color:var(--muted);padding:40px 10px}
.flag{background:#fef3c7;color:#92400e;text-align:center;font-size:13px;padding:6px}
footer{text-align:center;color:var(--muted);font-size:13px;padding:0 20px 30px}
@media (max-width:860px){.art{grid-template-columns:1fr}.side{position:static}}
@media (max-width:560px){main{padding:22px 14px 48px}article.panel{padding:20px 18px}.hero{padding:32px 16px 40px}.top .ask{font-size:13px}}
`;

interface Center {
  locationId: string;
  slug: string;
  /** Path (or absolute URL) the help center's links start with; origin is prepended for canonical URLs. */
  base: string;
  origin: string;
  title: string;
  name: string;
  intro: string;
  color: string;
  logo: string;
  seoTitle: string;
  seoDescription: string;
  contactText: string;
  enabled: boolean;
  ask: string;
  indexable: boolean;
}

export const knowledgeBaseModule: Module = {
  name: 'knowledge-base',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE kb_categories (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, slug)
      );
      CREATE TABLE kb_articles (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        category_id TEXT REFERENCES kb_categories(id) ON DELETE SET NULL, title TEXT NOT NULL, slug TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        tags TEXT NOT NULL DEFAULT '[]', seo TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0, helpful_yes INTEGER NOT NULL DEFAULT 0, helpful_no INTEGER NOT NULL DEFAULT 0,
        author_id TEXT, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, slug)
      );
      CREATE INDEX kb_articles_loc ON kb_articles(location_id, status);
      CREATE TABLE kb_feedback (
        id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
        helpful INTEGER NOT NULL, voter TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX kb_feedback_voter ON kb_feedback(article_id, voter, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- data helpers ------------------------------------------------------------------------------
    const articleRow = (loc: string, aid: string) => parseJson(db.get('SELECT * FROM kb_articles WHERE id = ? AND location_id = ?', aid, loc), ['tags', 'seo']);
    const published = (loc: string) => parseRows(db.all(`SELECT * FROM kb_articles WHERE location_id = ? AND status = 'published' ORDER BY position, title`, loc), ['tags', 'seo']);
    const categories = (loc: string) => db.all('SELECT * FROM kb_categories WHERE location_id = ? ORDER BY position, name', loc);
    const uniqueSlug = (table: 'kb_articles' | 'kb_categories', loc: string, wanted: string, self = '') => {
      const base = slugify(wanted).slice(0, 70) || 'artikel';
      let slug = base;
      for (let i = 2; db.get(`SELECT id FROM ${table} WHERE location_id = ? AND slug = ? AND id != ?`, loc, slug, self); i++) slug = `${base}-${i}`;
      return slug;
    };
    const previewKey = (a: { id: string }) => sign(app.config.secret, `kb-preview:${a.id}`);

    // --- help center lookup -------------------------------------------------------------------------
    const centerFor = (loc: string, base: string, origin = app.baseUrl()): Center | undefined => {
      const l = app.location(loc);
      if (!l) return undefined;
      const s = loadHelpdeskSettings(app, loc);
      const hc = s.help_center;
      const brand = l.settings?.branding ?? {};
      const name = brand.name || l.name;
      return {
        locationId: loc,
        slug: hc.slug || loc,
        base,
        origin: base.startsWith('http') ? '' : origin,
        title: hc.title || `${name} Hilfe-Center`,
        name,
        intro: hc.intro || 'Wie können wir helfen?',
        color: [hc.color, brand.color].find((c) => /^#[0-9a-f]{6}$/i.test(c ?? '')) ?? '#2563eb',
        logo: brand.logo_url || l.logo_url || '',
        seoTitle: hc.seo_title,
        seoDescription: hc.seo_description,
        contactText: hc.contact_text,
        enabled: hc.enabled,
        ask: s.portal.enabled ? `${portalUrl(app, loc)}/tickets` : '',
        indexable: hc.enabled,
      };
    };
    const locBySlug = (slug: string): string | undefined =>
      db.get(`SELECT location_id FROM helpdesk_settings WHERE json_extract(data, '$.help_center.slug') = ?`, slug)?.location_id ?? (app.location(slug) ? slug : undefined);
    const absolute = (c: Center, path = '') => `${c.origin}${c.base}${path}`;

    // --- rendering ----------------------------------------------------------------------------------
    const page = (c: Center, o: { title: string; body: string; description?: string; canonical?: string; status?: number; noindex?: boolean; head?: string; flag?: string; hero?: string }): RawResult => {
      const robots = o.noindex || !c.indexable ? '<meta name="robots" content="noindex">' : '';
      const brand = c.logo ? `<img src="${escapeHtml(safeUrl(c.logo))}" alt="${escapeHtml(c.name)}">` : `<span class="mark">${escapeHtml(c.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(c.title)}</span>`;
      const doc = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>${o.description ? `<meta name="description" content="${escapeHtml(o.description)}">` : ''}${robots}
${o.canonical ? `<link rel="canonical" href="${escapeHtml(o.canonical)}"><meta property="og:url" content="${escapeHtml(o.canonical)}">` : ''}
<meta property="og:title" content="${escapeHtml(o.title)}">${o.description ? `<meta property="og:description" content="${escapeHtml(o.description)}">` : ''}<meta property="og:type" content="website"><meta name="theme-color" content="${c.color}">
<style>:root{--brand:${c.color}}${CSS}</style>${o.head ?? ''}</head><body>${o.flag ? `<div class="flag">${escapeHtml(o.flag)}</div>` : ''}
<header class="top"><div class="in"><a class="brand" href="${escapeHtml(c.base || '/')}">${brand}</a>${c.ask ? `<a class="ask" href="${escapeHtml(c.ask)}">Anfrage stellen</a>` : ''}</div></header>
${o.hero ?? ''}<main>${o.body}</main><footer>${escapeHtml(c.name)}</footer></body></html>`;
      const r = html(doc, o.status ?? 200);
      Object.assign(r.headers, {
        'cache-control': o.noindex ? 'no-store' : 'public, max-age=120',
        'content-security-policy': "default-src 'none'; img-src * data:; media-src https:; style-src 'unsafe-inline'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      return r;
    };
    const searchBox = (c: Center, q = '') => `<form class="search" method="get" action="${escapeHtml(c.base || '/')}" role="search"><input name="q" type="search" value="${escapeHtml(q)}" placeholder="Suchen, z. B. „Passwort ändern“" aria-label="Hilfe durchsuchen"><button>Suchen</button></form>`;
    const hero = (c: Center, q = '') => `<section class="hero"><h1>${escapeHtml(c.intro)}</h1><p>${escapeHtml(c.title)}</p>${searchBox(c, q)}</section>`;
    const artHref = (c: Center, a: any) => `${c.base}/${encodeURIComponent(a.slug)}`;
    const catHref = (c: Center, cat: any) => `${c.base}/k/${encodeURIComponent(cat.slug)}`;
    /** Short teaser: the excerpt, else the first text paragraph (no headings, lists or quotes). */
    const summary = (a: any) => {
      if (a.excerpt) return a.excerpt;
      const para = String(a.body ?? '').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^(#|>|[-*] |\d+\. |```|!\[)/.test(p));
      return excerptOf(stripMarkdown(para ?? a.body ?? ''), 160);
    };
    const listOf = (c: Center, arts: any[]) => (arts.length ? `<div class="list">${arts.map((a) => `<a href="${escapeHtml(artHref(c, a))}"><strong>${escapeHtml(a.title)}</strong><span>${escapeHtml(summary(a))}</span></a>`).join('')}</div>` : '<div class="list"><div class="empty">Noch keine Artikel.</div></div>');
    const contactBox = (c: Center) =>
      c.ask || c.contactText
        ? `<div class="contact"><div><strong>Nichts gefunden?</strong><div style="color:var(--muted)">${escapeHtml(c.contactText || 'Schreib uns – wir helfen gern weiter.')}</div></div>${c.ask ? `<a class="btn" href="${escapeHtml(c.ask)}">Anfrage stellen</a>` : ''}</div>`
        : '';

    const search = (loc: string, q: string, opts: { all?: boolean; limit?: number } = {}) => {
      const terms = searchTerms(q);
      const rows = parseRows(db.all(`SELECT * FROM kb_articles WHERE location_id = ? ${opts.all ? '' : `AND status = 'published'`}`, loc), ['tags', 'seo']);
      return rows
        .map((a) => ({ a, score: articleScore(a, terms) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score || y.a.views - x.a.views)
        .slice(0, Math.min(Math.max(1, opts.limit ?? 10), 50));
    };

    const indexPage = (c: Center, q: string): RawResult => {
      const loc = c.locationId;
      if (q.trim()) {
        const hits = search(loc, q, { limit: 30 });
        return page(c, {
          title: `Suche: ${q} – ${c.title}`,
          noindex: true,
          hero: hero(c, q),
          body: `<h2 class="sec" style="margin-top:0">${hits.length ? `${hits.length} ${hits.length === 1 ? 'Ergebnis' : 'Ergebnisse'} für „${escapeHtml(q)}“` : `Keine Treffer für „${escapeHtml(q)}“`}</h2>${hits.length ? listOf(c, hits.map((h) => h.a)) : '<p style="color:var(--muted)">Versuch es mit anderen Wörtern oder schau in die Kategorien.</p>'}${contactBox(c)}`,
        });
      }
      const arts = published(loc);
      const cats = categories(loc).filter((cat) => arts.some((a) => a.category_id === cat.id));
      const popular = [...arts].sort((a, b) => b.views - a.views).slice(0, 8);
      const uncategorized = arts.filter((a) => !a.category_id || !cats.some((cat) => cat.id === a.category_id));
      const desc = c.seoDescription || `${c.intro} Antworten und Anleitungen von ${c.name}.`;
      return page(c, {
        title: c.seoTitle || c.title,
        description: desc,
        canonical: absolute(c),
        hero: hero(c),
        body: `${cats.length ? `<div class="grid">${cats.map((cat) => `<a class="cat" href="${escapeHtml(catHref(c, cat))}"><h2>${escapeHtml(cat.name)}</h2>${cat.description ? `<p>${escapeHtml(cat.description)}</p>` : ''}<small>${arts.filter((a) => a.category_id === cat.id).length} Artikel</small></a>`).join('')}</div>` : ''}
${popular.length ? `<h2 class="sec">Beliebte Artikel</h2>${listOf(c, popular)}` : '<div class="empty">Hier entstehen bald Hilfe-Artikel.</div>'}
${cats.length && uncategorized.length ? `<h2 class="sec">Weitere Artikel</h2>${listOf(c, uncategorized)}` : ''}${contactBox(c)}`,
      });
    };

    const categoryPage = (c: Center, slug: string): RawResult => {
      const cat = db.get('SELECT * FROM kb_categories WHERE location_id = ? AND slug = ?', c.locationId, slug);
      if (!cat) return missing(c);
      const arts = published(c.locationId).filter((a) => a.category_id === cat.id);
      return page(c, {
        title: `${cat.name} – ${c.title}`,
        description: cat.description || `${cat.name}: Hilfe-Artikel von ${c.name}.`,
        canonical: absolute(c, `/k/${encodeURIComponent(cat.slug)}`),
        body: `<div class="crumb"><a href="${escapeHtml(c.base || '/')}">${escapeHtml(c.title)}</a></div><h1 style="margin:0 0 6px">${escapeHtml(cat.name)}</h1>${cat.description ? `<p style="color:var(--muted);margin:0 0 18px">${escapeHtml(cat.description)}</p>` : ''}<div style="margin:0 0 20px">${searchBox(c)}</div>${listOf(c, arts)}${contactBox(c)}`,
      });
    };

    const missing = (c: Center) => page(c, { title: `Nicht gefunden – ${c.title}`, status: 404, noindex: true, body: `<div class="empty"><h1 style="color:var(--text)">Nicht gefunden</h1><p>Diesen Artikel gibt es nicht (mehr).</p><a class="btn" href="${escapeHtml(c.base || '/')}">Zum Hilfe-Center</a></div>` });

    const articlePage = (c: Center, slug: string, query: URLSearchParams): RawResult => {
      const a = parseJson(db.get('SELECT * FROM kb_articles WHERE location_id = ? AND slug = ?', c.locationId, slug), ['tags', 'seo']);
      const preview = !!a && a.status !== 'published' && verifySig(app.config.secret, `kb-preview:${a.id}`, String(query.get('preview') ?? ''));
      if (!a || (a.status !== 'published' && !preview) || (!c.enabled && !preview)) return missing(c);
      if (!preview) db.run('UPDATE kb_articles SET views = views + 1 WHERE id = ?', a.id);
      const cat = a.category_id ? db.get('SELECT * FROM kb_categories WHERE id = ?', a.category_id) : null;
      const siblings = published(c.locationId).filter((x) => x.id !== a.id && (a.category_id ? x.category_id === a.category_id : true)).slice(0, 8);
      const desc = a.seo?.description || summary(a);
      const canonical = absolute(c, `/${encodeURIComponent(a.slug)}`);
      const updated = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: app.location(c.locationId)?.timezone || 'Europe/Berlin' }).format(new Date(a.updated_at));
      const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: desc, dateModified: a.updated_at, datePublished: a.published_at ?? a.created_at, url: canonical, publisher: { '@type': 'Organization', name: c.name } }).replace(/</g, '\\u003c');
      const thanks = query.get('danke');
      const vote = thanks
        ? `<span class="thanks">Danke für dein Feedback!</span>`
        : `<span>War das hilfreich?</span><form method="post" action="${escapeHtml(artHref(c, a))}/feedback"><input type="hidden" name="helpful" value="1"><button>👍 Ja</button></form><form method="post" action="${escapeHtml(artHref(c, a))}/feedback"><input type="hidden" name="helpful" value="0"><button>👎 Nein</button></form>`;
      return page(c, {
        title: `${a.seo?.title || a.title} – ${c.title}`,
        description: desc,
        canonical,
        noindex: !!a.seo?.noindex || preview,
        flag: preview ? 'Vorschau – dieser Artikel ist noch nicht veröffentlicht' : undefined,
        head: preview ? '' : `<script type="application/ld+json">${ld}</script>`,
        body: `<div class="crumb"><a href="${escapeHtml(c.base || '/')}">${escapeHtml(c.title)}</a>${cat ? ` / <a href="${escapeHtml(catHref(c, cat))}">${escapeHtml(cat.name)}</a>` : ''}</div>
<div class="art"><article class="panel"><h1>${escapeHtml(a.title)}</h1><div class="meta">Aktualisiert am ${updated}</div><div class="prose">${renderMarkdown(a.body, { embeds: true })}</div>
<div class="helpful">${preview ? '<span style="color:var(--muted)">Feedback ist in der Vorschau aus.</span>' : vote}</div></article>
${siblings.length ? `<aside class="side"><h3>${cat ? escapeHtml(cat.name) : 'Weitere Artikel'}</h3>${siblings.map((x) => `<a href="${escapeHtml(artHref(c, x))}">${escapeHtml(x.title)}</a>`).join('')}</aside>` : '<span></span>'}</div>${contactBox(c)}`,
      });
    };

    const feedback = (c: Center, slug: string, ctx: Ctx): RawResult => {
      const a = db.get(`SELECT id, slug FROM kb_articles WHERE location_id = ? AND slug = ? AND status = 'published'`, c.locationId, slug);
      if (!a || !c.enabled) return missing(c);
      const helpful = String(ctx.body?.helpful ?? '') === '1' ? 1 : 0;
      // One vote per visitor and article per day (hashed IP + browser, nothing stored in clear).
      const voter = sha256(`${app.config.secret}:${ctx.ip}:${ctx.req.headers['user-agent'] ?? ''}`).slice(0, 32);
      const dayAgo = new Date(Date.now() - 864e5).toISOString();
      if (!db.get('SELECT 1 FROM kb_feedback WHERE article_id = ? AND voter = ? AND created_at > ?', a.id, voter, dayAgo)) {
        db.insert('kb_feedback', { id: id(), article_id: a.id, helpful, voter, created_at: now() });
        db.run(`UPDATE kb_articles SET ${helpful ? 'helpful_yes = helpful_yes + 1' : 'helpful_no = helpful_no + 1'} WHERE id = ?`, a.id);
      }
      return redirect(`${artHref(c, a)}?danke=1`, 303);
    };

    const sitemap = (c: Center): RawResult => {
      const urls = c.enabled ? [{ loc: absolute(c), lastmod: '' }, ...published(c.locationId).filter((a) => !a.seo?.noindex).map((a) => ({ loc: absolute(c, `/${encodeURIComponent(a.slug)}`), lastmod: a.updated_at }))] : [];
      const r = text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}</url>`).join('')}</urlset>`, 'application/xml; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=600';
      return r;
    };

    /** Routes one help-center path ("" = start page, "k/<cat>", "<article>", "<article>/feedback"). */
    const serve = (c: Center | undefined, parts: string[], ctx: Ctx): RawResult => {
      if (!c) return html('<!doctype html><meta charset="utf-8"><title>Nicht gefunden</title><p style="font-family:system-ui;padding:40px;text-align:center">Dieses Hilfe-Center gibt es nicht.</p>', 404);
      const [a, b, x] = parts;
      // Draft previews work before the help center is switched on; everything else needs it on.
      if (!c.enabled && !(a && ctx.query.get('preview'))) return html('<!doctype html><meta charset="utf-8"><title>Nicht gefunden</title><p style="font-family:system-ui;padding:40px;text-align:center">Dieses Hilfe-Center ist nicht öffentlich.</p>', 404);
      if (!a) return indexPage(c, String(ctx.query.get('q') ?? '').slice(0, 200));
      if (a === 'sitemap.xml' && !b) return sitemap(c);
      if (a === 'k' && b && !x) return categoryPage(c, b);
      if (b === 'feedback' && !x) return ctx.method === 'POST' ? feedback(c, a, ctx) : redirect(artHref(c, { slug: a }), 303);
      if (!b) return articlePage(c, a, ctx.query);
      return missing(c);
    };

    const byPath = (ctx: Ctx) => {
      const loc = locBySlug(ctx.params.slug);
      if (!loc) return undefined;
      const host = String(ctx.req.headers.host ?? '').split(':')[0].toLowerCase();
      const hc = loadHelpdeskSettings(app, loc).help_center;
      // Served on its own domain (help.example.de): links start at the domain root.
      const own = !!hc.domain && (host === hc.domain || host === domainAlias(hc.domain));
      return centerFor(loc, own ? '' : `/help/${encodeURIComponent(hc.slug || loc)}`, own ? `https://${hc.domain}` : app.baseUrl());
    };
    router.get('/help/:slug', 'public', (ctx) => serve(byPath(ctx), [], ctx));
    router.get('/help/:slug/:a', 'public', (ctx) => serve(byPath(ctx), [ctx.params.a], ctx));
    router.get('/help/:slug/:a/:b', 'public', (ctx) => serve(byPath(ctx), [ctx.params.a, ctx.params.b], ctx));
    router.post('/help/:slug/:a/:b', 'public', (ctx) => serve(byPath(ctx), [ctx.params.a, ctx.params.b], ctx));

    // On a connected website (funnel) domain the help center lives under /help.
    const funnelCenter = (slug: string) => {
      const f = db.get('SELECT * FROM funnels WHERE slug = ?', slug);
      if (!f) return undefined;
      const base = f.domain ? `https://${f.domain}/help` : `/p/${encodeURIComponent(f.slug)}/help`;
      return centerFor(f.location_id, base);
    };
    app.services.sitePaths = [
      ...(app.services.sitePaths ?? []),
      (f: any, path: string, query: URLSearchParams) => {
        if (path !== 'help') return undefined;
        const c = funnelCenter(f.slug);
        if (!c?.enabled) return undefined;
        return indexPage(c, String(query.get('q') ?? '').slice(0, 200));
      },
    ];
    app.services.siteSitemap = [
      ...(app.services.siteSitemap ?? []),
      (f: any) => {
        if (f.settings?.noindex) return [];
        const c = funnelCenter(f.slug);
        if (!c?.enabled) return [];
        return [{ loc: absolute(c) }, ...published(c.locationId).filter((a) => !a.seo?.noindex).map((a) => ({ loc: absolute(c, `/${encodeURIComponent(a.slug)}`), lastmod: a.updated_at }))];
      },
    ];
    router.get('/p/:funnel/help/:a', 'public', (ctx) => serve(funnelCenter(ctx.params.funnel), [ctx.params.a], ctx));
    router.get('/p/:funnel/help/:a/:b', 'public', (ctx) => serve(funnelCenter(ctx.params.funnel), [ctx.params.a, ctx.params.b], ctx));
    router.post('/p/:funnel/help/:a/:b', 'public', (ctx) => serve(funnelCenter(ctx.params.funnel), [ctx.params.a, ctx.params.b], ctx));

    // Its own domain (help.example.de → the help center at the root).
    app.rewrites.push((host, path) => {
      const row = db.get(`SELECT location_id, json_extract(data, '$.help_center.slug') AS slug FROM helpdesk_settings WHERE json_extract(data, '$.help_center.domain') IN (?, ?)`, host, domainAlias(host) ?? host);
      if (!row) return undefined;
      if (path.startsWith('/api/') || path.startsWith('/portal/') || path.startsWith('/survey/')) return path;
      return `/help/${encodeURIComponent(row.slug || row.location_id)}${path === '/' ? '' : path}`;
    });

    /** Public JSON search (CORS open), e.g. for a search box on another website. */
    router.get('/api/public/help/:slug/search', 'public', (ctx) => {
      const loc = locBySlug(ctx.params.slug);
      const c = loc ? centerFor(loc, `/help/${encodeURIComponent(ctx.params.slug)}`) : undefined;
      if (!c?.enabled) throw notFound('Hilfe-Center nicht gefunden');
      return search(c.locationId, String(ctx.query.get('q') ?? '').slice(0, 200), { limit: clampLimit(ctx.query.get('limit'), 8, 50) }).map(({ a }) => ({ title: a.title, excerpt: summary(a), url: absolute(c, `/${encodeURIComponent(a.slug)}`) }));
    });

    // --- admin API -----------------------------------------------------------------------------------
    const publicUrl = (loc: string, a: any) => {
      const hc = loadHelpdeskSettings(app, loc).help_center;
      return `${hc.domain ? `https://${hc.domain}` : `${app.baseUrl()}/help/${encodeURIComponent(hc.slug || loc)}`}/${encodeURIComponent(a.slug)}`;
    };
    const articleOut = (loc: string, a: any, full = true) => ({
      ...a,
      ...(full ? {} : { body: undefined }),
      category_name: a.category_id ? (db.get('SELECT name FROM kb_categories WHERE id = ?', a.category_id)?.name ?? '') : '',
      url: publicUrl(loc, a),
      preview_url: a.status === 'published' ? undefined : `${publicUrl(loc, a)}?preview=${previewKey(a)}`,
    });

    router.get('/api/kb/categories', 'location', (ctx) =>
      db.all(
        `SELECT k.*, (SELECT COUNT(*) FROM kb_articles a WHERE a.category_id = k.id) AS articles, (SELECT COUNT(*) FROM kb_articles a WHERE a.category_id = k.id AND a.status = 'published') AS published
         FROM kb_categories k WHERE k.location_id = ? ORDER BY k.position, k.name`,
        ctx.locationId,
      ),
    );
    router.post('/api/kb/categories', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM kb_categories WHERE location_id = ?', ctx.locationId)!.n;
      const row = { id: id(), location_id: ctx.locationId, name, slug: uniqueSlug('kb_categories', ctx.locationId, str(ctx.body.slug, 'Adresse', { max: 80 }) || name), description: str(ctx.body.description, 'Beschreibung', { max: 300 }), position: pos, created_at: now(), updated_at: now() };
      db.insert('kb_categories', row);
      return row;
    });
    router.patch('/api/kb/categories/:id', 'location', (ctx) => {
      const cur = db.get('SELECT * FROM kb_categories WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body.description !== undefined) patch.description = str(ctx.body.description, 'Beschreibung', { max: 300 });
      if (ctx.body.slug !== undefined) patch.slug = uniqueSlug('kb_categories', ctx.locationId, str(ctx.body.slug, 'Adresse', { max: 80 }) || cur.name, cur.id);
      if (ctx.body.position !== undefined) patch.position = Math.round(num(ctx.body.position));
      db.update('kb_categories', cur.id, patch, ctx.locationId);
      return db.get('SELECT * FROM kb_categories WHERE id = ?', cur.id);
    });
    router.delete('/api/kb/categories/:id', 'location', (ctx) => {
      db.run('DELETE FROM kb_categories WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    const articleIn = (b: any, cur: any | null, loc: string) => {
      const out: Record<string, any> = {};
      if (b.title !== undefined || !cur) out.title = str(b.title, 'Titel', { required: true, max: 200 });
      if (b.body !== undefined) out.body = str(b.body, 'Text', { max: 200_000 });
      if (b.excerpt !== undefined) out.excerpt = str(b.excerpt, 'Auszug', { max: 400 });
      if (b.category_id !== undefined) {
        const cid = str(b.category_id, 'Kategorie', { max: 40 }) || null;
        if (cid && !db.get('SELECT 1 FROM kb_categories WHERE id = ? AND location_id = ?', cid, loc)) throw bad('Unbekannte Kategorie');
        out.category_id = cid;
      }
      if (b.status !== undefined) {
        if (!['draft', 'published'].includes(b.status)) throw bad('Status: draft oder published');
        out.status = b.status;
        if (b.status === 'published' && !cur?.published_at) out.published_at = now();
      }
      if (b.tags !== undefined) out.tags = uniq((Array.isArray(b.tags) ? b.tags : String(b.tags).split(',')).map((t: unknown) => String(t).trim().slice(0, 40)).filter(Boolean)).slice(0, 20);
      if (b.seo !== undefined) {
        const s = b.seo && typeof b.seo === 'object' ? b.seo : {};
        out.seo = { title: str(s.title, 'SEO-Titel', { max: 120 }), description: str(s.description, 'SEO-Beschreibung', { max: 300 }), noindex: !!s.noindex };
      }
      if (b.position !== undefined) out.position = Math.round(num(b.position));
      if (b.slug !== undefined || !cur) out.slug = uniqueSlug('kb_articles', loc, str(b.slug, 'Adresse', { max: 80 }) || out.title || cur?.title, cur?.id ?? '');
      return out;
    };
    router.get('/api/kb/articles', 'location', (ctx) => {
      const where = ['location_id = ?'];
      const params: any[] = [ctx.locationId];
      const status = ctx.query.get('status');
      if (status === 'draft' || status === 'published') (where.push('status = ?'), params.push(status));
      const cat = ctx.query.get('category_id');
      if (cat === 'none') where.push('category_id IS NULL');
      else if (cat) (where.push('category_id = ?'), params.push(cat));
      const q = ctx.query.get('q');
      if (q) (where.push('(title LIKE ? OR body LIKE ?)'), params.push(`%${q}%`, `%${q}%`));
      return parseRows(db.all(`SELECT * FROM kb_articles WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`, ...params), ['tags', 'seo']).map((a) => articleOut(ctx.locationId, a, false));
    });
    router.post('/api/kb/articles', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, body: '', excerpt: '', status: 'draft', tags: [], seo: {}, author_id: ctx.user?.id ?? null, created_at: now(), updated_at: now(), ...articleIn(ctx.body ?? {}, null, ctx.locationId) };
      db.insert('kb_articles', row);
      return articleOut(ctx.locationId, articleRow(ctx.locationId, row.id));
    });
    router.get('/api/kb/articles/:id', 'location', (ctx) => {
      const a = articleRow(ctx.locationId, ctx.params.id);
      if (!a) throw notFound();
      return articleOut(ctx.locationId, a);
    });
    router.patch('/api/kb/articles/:id', 'location', (ctx) => {
      const a = articleRow(ctx.locationId, ctx.params.id);
      if (!a) throw notFound();
      db.update('kb_articles', a.id, { ...articleIn(ctx.body ?? {}, a, ctx.locationId), updated_at: now() }, ctx.locationId);
      return articleOut(ctx.locationId, articleRow(ctx.locationId, a.id));
    });
    router.delete('/api/kb/articles/:id', 'location', (ctx) => {
      db.run('DELETE FROM kb_articles WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    /** Markdown preview for the editor (the renderer escapes everything, so the HTML is safe to show). */
    router.post('/api/kb/preview', 'location', (ctx) => ({ html: renderMarkdown(str(ctx.body.body, 'Text', { max: 200_000 }), { embeds: true }) }));
    /** Where the help center lives (for the knowledge-base screen; settings stay under Einstellungen). */
    router.get('/api/kb/info', 'location', (ctx) => {
      const hc = loadHelpdeskSettings(app, ctx.locationId).help_center;
      return { enabled: hc.enabled, url: hc.domain ? `https://${hc.domain}` : `${app.baseUrl()}/help/${encodeURIComponent(hc.slug || ctx.locationId)}`, slug: hc.slug };
    });
    /** Suggestions while answering a ticket, and ghl_search_kb. */
    router.get('/api/kb/search', 'location', (ctx) =>
      search(ctx.locationId, String(ctx.query.get('q') ?? '').slice(0, 500), { all: ctx.query.get('all') === '1', limit: clampLimit(ctx.query.get('limit'), 8, 50) }).map(({ a, score }) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        status: a.status,
        excerpt: summary(a),
        url: publicUrl(ctx.locationId, a),
        score,
        ...(ctx.query.get('full') === '1' ? { body: a.body } : {}),
      })),
    );

    // --- KI-Assistent: published articles as knowledge -------------------------------------------------
    app.services.aiKnowledge = [
      ...(app.services.aiKnowledge ?? []),
      (loc: string): string => {
        const arts = published(loc).slice(0, 80);
        if (!arts.length) return '';
        let budget = 24_000;
        const parts: string[] = [];
        for (const a of arts) {
          const chunk = `## ${a.title}\n${excerptOf(stripMarkdown(a.body), 1500)}\nLink: ${publicUrl(loc, a)}`;
          if (chunk.length > budget) break;
          budget -= chunk.length;
          parts.push(chunk);
        }
        return `# Hilfe-Center-Artikel\n${parts.join('\n\n')}`;
      },
    ];
  },
};
