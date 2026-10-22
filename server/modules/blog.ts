import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, html, notFound, num, str, text, type RawResult } from '../core/http.js';
import { jsonForScript, publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now, sha256, slugify } from '../core/util.js';
import { cssUrl, excerptOf, readingMinutes, renderMarkdown, safeUrl, stripMarkdown } from '../services/markdown.js';
import { miniMarkdown, pageUrl } from './funnels.js';
import type { Tool } from './mcp.js';

/**
 * Blog for websites: posts per website (draft, scheduled, published), public index with tags and
 * pagination at /blog, posts at /blog/<slug>, an RSS feed at /blog/rss.xml and the posts in the
 * site's sitemap.xml. Pages use the website's colour, font, favicon, tracking code and footer.
 */

export const POST_STATUS = ['draft', 'scheduled', 'published'] as const;
type Status = (typeof POST_STATUS)[number];

/**
 * What a requested status means at a given time: "published" with a future date is scheduled,
 * "scheduled" with a date that has passed goes live right away.
 */
export function resolveStatus(want: string, publishAt: string | null, at = new Date()): { status: Status; publish_at: string | null; published_at: string | null } {
  const t = publishAt ? Date.parse(publishAt) : NaN;
  const iso = Number.isNaN(t) ? null : new Date(t).toISOString();
  if (want === 'draft') return { status: 'draft', publish_at: iso, published_at: null };
  if (want === 'scheduled' && !iso) throw bad('Für „Geplant“ fehlt das Veröffentlichungsdatum');
  if (iso && t > at.getTime()) return { status: 'scheduled', publish_at: iso, published_at: null };
  if (want === 'published' || want === 'scheduled') return { status: 'published', publish_at: iso, published_at: iso ?? at.toISOString() };
  throw bad('Unbekannter Status');
}

const PROSE_CSS = `
.prose { font-size: 18.5px; line-height: 1.75; color: #1f2937; }
.prose > :first-child { margin-top: 0; }
.prose p { margin: 0 0 1.15em; }
.prose h2 { font-size: 27px; line-height: 1.3; margin: 1.6em 0 .55em; } .prose h3 { font-size: 22px; margin: 1.4em 0 .5em; } .prose h4 { font-size: 19px; margin: 1.2em 0 .4em; }
.prose a { color: var(--brand); text-decoration: underline; text-underline-offset: 2px; }
.prose img { max-width: 100%; height: auto; border-radius: 14px; margin: .6em 0; }
.prose ul, .prose ol { padding-left: 1.4em; margin: 0 0 1.15em; } .prose li { margin: .25em 0; }
.prose blockquote { margin: 1.4em 0; padding: .3em 1.2em; border-left: 4px solid var(--brand); color: #374151; font-style: italic; background: #f9fafb; border-radius: 0 12px 12px 0; }
.prose code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; font-size: .88em; }
.prose pre { background: #0f172a; color: #e2e8f0; padding: 16px 18px; border-radius: 12px; overflow-x: auto; font-size: 15px; } .prose pre code { background: none; padding: 0; }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 2.2em 0; }
.md-video { position: relative; padding-top: 56.25%; border-radius: 14px; overflow: hidden; background: #000; margin: 1.2em 0; }
.md-video iframe, .md-video video { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
`;

const BLOG_CSS = `
body { background: #fff; }
.bh { border-bottom: 1px solid var(--line); background: #fff; position: sticky; top: 0; z-index: 4; }
.bh .in { max-width: 1120px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.bh .site { font-weight: 800; font-size: 19px; color: var(--text); text-decoration: none; display: flex; align-items: center; gap: 10px; min-width: 0; }
.bh .site img { max-height: 34px; max-width: 160px; }
.bh nav { display: flex; gap: 20px; } .bh nav a { color: var(--muted); text-decoration: none; font-weight: 600; } .bh nav a.on, .bh nav a:hover { color: var(--brand); }
.bi { max-width: 1120px; margin: 0 auto; padding: 48px 20px 64px; }
.bi-head { text-align: center; margin-bottom: 38px; }
.bi-head h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.1; margin: 0 0 12px; letter-spacing: -.02em; }
.bi-head p { color: var(--muted); font-size: 19px; max-width: 660px; margin: 0 auto; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 22px; }
.chip { display: inline-block; padding: 5px 13px; border-radius: 99px; background: #f3f4f6; color: #374151; font-size: 14px; font-weight: 600; text-decoration: none; }
.chip:hover, .chip.on { background: var(--brand); color: #fff; }
.chip small { opacity: .7; font-weight: 500; }
.posts { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 28px; }
.pc { display: flex; flex-direction: column; text-decoration: none; color: inherit; border: 1px solid var(--line); border-radius: 18px; overflow: hidden; background: #fff; transition: transform .15s, box-shadow .15s; }
.pc:hover { transform: translateY(-3px); box-shadow: 0 18px 40px rgba(17,24,39,.09); }
.pc .img { aspect-ratio: 16 / 9; background: linear-gradient(135deg, var(--brand), #111827) center / cover no-repeat; }
.pc .b { padding: 18px 20px 22px; display: flex; flex-direction: column; gap: 9px; flex: 1; }
.pc h2 { font-size: 21px; line-height: 1.3; margin: 0; }
.pc p { margin: 0; color: var(--muted); font-size: 16px; }
.pc .meta { margin-top: auto; }
.pc.feat { grid-column: 1 / -1; flex-direction: row; }
.pc.feat .img { flex: 1 1 56%; aspect-ratio: auto; min-height: 340px; }
.pc.feat .b { flex: 1 1 44%; justify-content: center; padding: 34px; }
.pc.feat h2 { font-size: clamp(24px, 3vw, 32px); }
.meta { font-size: 14px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 12px; }
.kicker { font-size: 13px; font-weight: 700; color: var(--brand); text-transform: uppercase; letter-spacing: .05em; }
.pager { display: flex; justify-content: center; align-items: center; gap: 14px; margin-top: 44px; color: var(--muted); }
.empty { text-align: center; color: var(--muted); padding: 60px 0; }
article.post { max-width: 760px; margin: 0 auto; padding: 44px 20px 30px; }
.post .back { font-size: 15px; color: var(--muted); text-decoration: none; } .post .back:hover { color: var(--brand); }
.post h1 { font-size: clamp(32px, 5vw, 48px); line-height: 1.12; margin: 16px 0 14px; letter-spacing: -.02em; }
.post .lead { font-size: 21px; color: var(--muted); margin: 0 0 18px; line-height: 1.5; }
.post .cover { width: 100%; border-radius: 18px; margin: 28px 0 32px; aspect-ratio: 16 / 9; object-fit: cover; display: block; }
.post .chips { justify-content: flex-start; margin: 34px 0 0; }
.share { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--line); color: var(--muted); font-size: 15px; }
.share a { color: var(--text); text-decoration: none; border: 1px solid var(--line); border-radius: 99px; padding: 5px 13px; font-weight: 600; font-size: 14px; } .share a:hover { border-color: var(--brand); color: var(--brand); }
.related { max-width: 1120px; margin: 0 auto; padding: 24px 20px 64px; } .related > h2 { font-size: 24px; margin: 0 0 20px; }
.preview-flag { background: #fef3c7; color: #92400e; text-align: center; font-size: 14px; padding: 8px; }
footer.bf { text-align: center; padding: 30px 20px; color: #9ca3af; font-size: 13px; border-top: 1px solid var(--line); }
footer.bf a { color: inherit; }
@media (max-width: 760px) { .pc.feat { flex-direction: column; } .pc.feat .img { min-height: 0; aspect-ratio: 16 / 9; } .pc.feat .b { padding: 20px; } .bi { padding-top: 32px; } }
${PROSE_CSS}`;

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_blog_posts',
    title: 'Blog-Beiträge',
    description: 'Blog-Beiträge der Websites eines Projekts (ohne funnel_id: alle Websites) mit Status (draft, scheduled, published), Datum, Tags und öffentlicher Adresse.',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, funnel_id: { type: 'string', description: 'Website-ID (aus GET /api/funnels)' }, status: { type: 'string', enum: POST_STATUS } },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const qs = a.status ? `?status=${encodeURIComponent(a.status)}` : '';
      if (a.funnel_id) return call.api('GET', `/api/funnels/${encodeURIComponent(a.funnel_id)}/posts${qs}`, { location: a.location_id });
      const sites: any[] = await call.api('GET', '/api/funnels', { location: a.location_id });
      const out: any[] = [];
      for (const s of sites.filter((x) => x.kind === 'website')) for (const p of await call.api('GET', `/api/funnels/${encodeURIComponent(s.id)}/posts${qs}`, { location: a.location_id })) out.push({ ...p, website: s.name });
      return out;
    },
  },
  {
    name: 'ghl_create_blog_post',
    title: 'Blog-Beitrag anlegen',
    description:
      'Legt einen Blog-Beitrag auf einer Website an – standardmäßig als Entwurf. content ist Markdown (# Überschrift, **fett**, Listen, [Link](https://…), ![Bild](https://…), eine Zeile mit YouTube-Link = Video). status "scheduled" braucht publish_at (ISO), "published" veröffentlicht sofort.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        funnel_id: { type: 'string', description: 'Website-ID (aus GET /api/funnels bzw. ghl_list_blog_posts)' },
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown' },
        excerpt: { type: 'string' },
        author: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        cover_image: { type: 'string', description: 'https://… (z. B. aus den Uploads)' },
        status: { type: 'string', enum: POST_STATUS },
        publish_at: { type: 'string', description: 'ISO 8601' },
        seo_title: { type: 'string' },
        seo_description: { type: 'string' },
      },
      required: ['location_id', 'funnel_id', 'title', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) =>
      call.api('POST', `/api/funnels/${encodeURIComponent(a.funnel_id)}/posts`, {
        location: a.location_id,
        body: {
          title: a.title,
          content: a.content,
          excerpt: a.excerpt,
          author: a.author,
          tags: a.tags,
          cover_image: a.cover_image,
          status: a.status ?? 'draft',
          publish_at: a.publish_at,
          seo: { title: a.seo_title, description: a.seo_description },
        },
      }),
  },
];

const cleanUrl = (v: unknown, field: string) => {
  const s = str(v, field, { max: 1000 });
  if (s && !/^(https?:\/\/|\/)[^\s]*$/i.test(s)) throw bad(`${field}: bitte eine https://-Adresse`);
  return s;
};
const cleanTags = (v: unknown) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad('Tags: Liste erwartet');
  return [...new Set(v.map((t) => String(t).trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 20).map((t) => t.slice(0, 40));
};
const cleanSeo = (v: any, cur: Record<string, any> = {}) => {
  const s = { ...cur };
  if (!v || typeof v !== 'object') return s;
  if (v.title !== undefined) s.title = str(v.title, 'SEO-Titel', { max: 200 });
  if (v.description !== undefined) s.description = str(v.description, 'SEO-Beschreibung', { max: 400 });
  if (v.og_image !== undefined) s.og_image = cleanUrl(v.og_image, 'Social-Bild');
  if (v.noindex !== undefined) s.noindex = !!v.noindex;
  return s;
};

export const blogModule: Module = {
  name: 'blog',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE blog_posts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        title TEXT NOT NULL, slug TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', cover_image TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft', publish_at TEXT, published_at TEXT,
        seo TEXT NOT NULL DEFAULT '{}', views INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(funnel_id, slug)
      );
      CREATE INDEX blog_posts_public ON blog_posts(funnel_id, status, published_at);
      CREATE INDEX blog_posts_due ON blog_posts(status, publish_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    const getFunnel = (loc: string, fid: string) => parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, loc), ['settings']);
    const mustFunnel = (loc: string, fid: string) => {
      const f = getFunnel(loc, fid);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };
    const getPost = (fid: string, pid: string) => parseJson(db.get('SELECT * FROM blog_posts WHERE id = ? AND funnel_id = ?', pid, fid), ['tags', 'seo']);
    const uniqueSlug = (fid: string, base: string, except = '') => {
      const root = slugify(base) || 'beitrag';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM blog_posts WHERE funnel_id = ? AND slug = ? AND id != ?', fid, slug, except); i++) slug = `${root}-${i}`;
      return slug;
    };
    const blogUrl = (f: any) => pageUrl(app, f, { slug: 'blog' });
    const postUrl = (f: any, p: any) => `${blogUrl(f)}/${p.slug}`;
    const previewKey = (p: any) => sha256(`${app.config.secret}:blog-preview:${p.id}`).slice(0, 24);
    const blogSettings = (f: any) => ({ title: 'Blog', description: '', per_page: 9, ...(f.settings?.blog ?? {}) });
    const out = (f: any, p: any) => {
      const { content: _c, ...rest } = p;
      return { ...rest, url: postUrl(f, p), preview_url: p.status === 'published' ? undefined : `${postUrl(f, p)}?preview=${previewKey(p)}`, excerpt_auto: p.excerpt || excerptOf(stripMarkdown(p.content ?? ''), 200) };
    };

    const fields = (b: any, cur: any = {}) => {
      const patch: Record<string, any> = {};
      if (b.title !== undefined) patch.title = str(b.title, 'Titel', { required: true, max: 200 });
      if (b.excerpt !== undefined) patch.excerpt = str(b.excerpt, 'Kurzbeschreibung', { max: 600 });
      if (b.content !== undefined) patch.content = String(b.content ?? '').slice(0, 200_000);
      if (b.author !== undefined) patch.author = str(b.author, 'Autor', { max: 120 });
      if (b.cover_image !== undefined) patch.cover_image = cleanUrl(b.cover_image, 'Titelbild');
      if (b.tags !== undefined) patch.tags = cleanTags(b.tags);
      if (b.seo !== undefined) patch.seo = cleanSeo(b.seo, cur.seo ?? {});
      return patch;
    };

    // --- admin -------------------------------------------------------------------------
    router.get('/api/funnels/:id/posts', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      const st = ctx.query.get('status');
      const rows = parseRows(
        db.all(`SELECT * FROM blog_posts WHERE funnel_id = ? ${st ? 'AND status = ?' : ''} ORDER BY COALESCE(published_at, publish_at, created_at) DESC`, f.id, ...(st ? [st] : [])),
        ['tags', 'seo'],
      );
      return rows.map((p) => out(f, p));
    });
    router.get('/api/funnels/:id/blog', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      const tags = db.all(
        `SELECT j.value AS tag, COUNT(*) AS n FROM blog_posts p, json_each(p.tags) j WHERE p.funnel_id = ? GROUP BY j.value ORDER BY n DESC, j.value`,
        f.id,
      );
      return { url: blogUrl(f), rss_url: `${blogUrl(f)}/rss.xml`, settings: blogSettings(f), tags, page_conflict: !!db.get(`SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = 'blog'`, f.id) };
    });
    router.post('/api/funnels/:id/posts', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const base = fields(b);
      if (!base.title) throw bad('Titel fehlt');
      const st = resolveStatus(String(b.status ?? 'draft'), b.publish_at ? String(b.publish_at) : null);
      const p: Record<string, any> = {
        id: id(),
        location_id: ctx.locationId,
        funnel_id: f.id,
        slug: uniqueSlug(f.id, b.slug || base.title),
        excerpt: '',
        cover_image: '',
        content: '',
        author: ctx.user?.name && !ctx.viaApiKey ? ctx.user.name : '',
        tags: [],
        seo: {},
        ...base,
        ...st,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('blog_posts', p);
      if (p.status === 'published') app.events.emit(ctx.locationId, 'blog.post_published', { postId: p.id, funnelId: f.id, title: p.title, url: postUrl(f, p) });
      return { ...out(f, getPost(f.id, p.id)), content: p.content };
    });
    router.get('/api/funnels/:id/posts/:pid', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      const p = getPost(f.id, ctx.params.pid);
      if (!p) throw notFound('Beitrag nicht gefunden');
      return { ...out(f, p), content: p.content };
    });
    router.patch('/api/funnels/:id/posts/:pid', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      const cur = getPost(f.id, ctx.params.pid);
      if (!cur) throw notFound('Beitrag nicht gefunden');
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { ...fields(b, cur), updated_at: now() };
      if (b.slug !== undefined) {
        const slug = slugify(String(b.slug || patch.title || cur.title));
        if (db.get('SELECT id FROM blog_posts WHERE funnel_id = ? AND slug = ? AND id != ?', f.id, slug, cur.id)) throw bad('Diese Adresse hat schon ein anderer Beitrag');
        patch.slug = slug;
      }
      if (b.status !== undefined || b.publish_at !== undefined) {
        const want = String(b.status ?? cur.status);
        const at = b.publish_at !== undefined ? (b.publish_at ? String(b.publish_at) : null) : cur.publish_at;
        const st = resolveStatus(want, at);
        // Saving a published post keeps its date unless a new one is given.
        if (st.status === 'published' && cur.status === 'published' && !b.publish_at) st.published_at = cur.published_at;
        Object.assign(patch, st);
      }
      db.update('blog_posts', cur.id, patch);
      const p = getPost(f.id, cur.id)!;
      if (p.status === 'published' && cur.status !== 'published') app.events.emit(ctx.locationId, 'blog.post_published', { postId: p.id, funnelId: f.id, title: p.title, url: postUrl(f, p) });
      return { ...out(f, p), content: p.content };
    });
    router.delete('/api/funnels/:id/posts/:pid', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      if (!db.run('DELETE FROM blog_posts WHERE id = ? AND funnel_id = ?', ctx.params.pid, f.id).changes) throw notFound('Beitrag nicht gefunden');
      return { ok: true };
    });
    /** Live preview of an unsaved post in the site's look. */
    router.post('/api/funnels/:id/posts/preview', 'location', (ctx) => {
      const f = mustFunnel(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const p = {
        id: String(b.id || 'preview'),
        slug: slugify(String(b.slug || b.title || 'vorschau')),
        title: String(b.title || 'Ohne Titel').slice(0, 200),
        excerpt: String(b.excerpt ?? '').slice(0, 600),
        content: String(b.content ?? '').slice(0, 200_000),
        author: String(b.author ?? '').slice(0, 120),
        cover_image: safeUrl(b.cover_image) === '#' ? '' : String(b.cover_image),
        tags: Array.isArray(b.tags) ? cleanTags(b.tags) : [],
        seo: { ...(b.seo ?? {}), noindex: true },
        published_at: b.published_at || b.publish_at || now(),
        updated_at: now(),
      };
      return html(renderPost(f, p, { preview: true, related: [] }));
    });

    // --- public rendering ------------------------------------------------------------------
    const tz = (f: any) => app.location(f.location_id)?.timezone || 'Europe/Berlin';
    const fmtDay = (iso: string, zone: string) => {
      try {
        return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(new Date(iso));
      } catch {
        return String(iso).slice(0, 10);
      }
    };
    const rfc822 = (iso: string) => new Date(iso).toUTCString();
    const publicPosts = (fid: string) => parseRows(db.all(`SELECT * FROM blog_posts WHERE funnel_id = ? AND status = 'published' ORDER BY published_at DESC`, fid), ['tags', 'seo']);

    const shell = (f: any, opts: { title: string; description?: string; head: string; body: string; status?: number; nav?: 'blog' | 'post' }): RawResult => {
      const s = f.settings ?? {};
      const site = s.site_name || f.name;
      const home = pageUrl(app, f, undefined, true);
      const bs = blogSettings(f);
      const header = `<header class="bh"><div class="in"><a class="site" href="${escapeHtml(home)}">${s.favicon ? `<img src="${escapeHtml(safeUrl(s.favicon))}" alt="" style="max-height:26px">` : ''}${escapeHtml(site)}</a><nav><a href="${escapeHtml(home)}">Start</a><a class="on" href="${escapeHtml(blogUrl(f))}">${escapeHtml(bs.title || 'Blog')}</a></nav></div></header>`;
      const footer = `<footer class="bf">${s.footer_text ? miniMarkdown(s.footer_text) : `© ${new Date().getFullYear()} ${escapeHtml(site)}`}</footer>`;
      const chat = s.chat_widget ? `<script src="/chat/${encodeURIComponent(f.location_id)}/widget.js" async></script>` : '';
      const font = s.font ? `body{font-family:${escapeHtml(String(s.font)).replace(/[;{}]/g, '')}, system-ui, sans-serif}` : '';
      const head = `${opts.head}<link rel="alternate" type="application/rss+xml" title="${escapeHtml(`${site} – ${bs.title || 'Blog'}`)}" href="${escapeHtml(`${blogUrl(f)}/rss.xml`)}"><style>${BLOG_CSS}${font}</style>${s.favicon ? `<link rel="icon" href="${escapeHtml(safeUrl(s.favicon))}">` : ''}${s.head_code ? `<!--pghl:owner-->${s.head_code}<!--/pghl:owner-->` : ''}`;
      const r = html(publicPage({ title: opts.title, description: opts.description, head, color: s.color, body: chat + header + opts.body + footer }), opts.status ?? 200);
      // Same sandbox as the website's pages: the owner's tracking code never runs with our origin.
      r.headers['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation allow-modals';
      return r;
    };

    /** Author · date · reading time; small cards leave the author out so the line doesn't wrap. */
    const meta = (f: any, p: any, short = false) => {
      const bits = [p.author && !short ? `<span>${escapeHtml(p.author)}</span>` : '', p.published_at ? `<time datetime="${escapeHtml(p.published_at)}">${fmtDay(p.published_at, tz(f))}</time>` : '', `<span>${readingMinutes(p.content)} Min. Lesezeit</span>`];
      return `<div class="meta">${bits.filter(Boolean).join('<span aria-hidden="true">·</span>')}</div>`;
    };
    const card = (f: any, p: any, feat = false) =>
      `<a class="pc${feat ? ' feat' : ''}" href="${escapeHtml(postUrl(f, p))}"><div class="img"${p.cover_image ? ` style="background-image:url('${cssUrl(p.cover_image)}')"` : ''}></div><div class="b">${p.tags?.[0] ? `<span class="kicker">${escapeHtml(p.tags[0])}</span>` : ''}<h2>${escapeHtml(p.title)}</h2><p>${escapeHtml(p.excerpt || excerptOf(stripMarkdown(p.content), feat ? 260 : 150))}</p>${meta(f, p, !feat)}</div></a>`;

    const blogIndex = (f: any, q: URLSearchParams): RawResult => {
      const s = f.settings ?? {};
      const bs = blogSettings(f);
      const site = s.site_name || f.name;
      const tag = (q.get('tag') ?? '').trim().slice(0, 40);
      const all = publicPosts(f.id);
      const list = tag ? all.filter((p) => (p.tags ?? []).includes(tag)) : all;
      const per = Math.min(Math.max(Math.round(num(bs.per_page, 9)), 3), 48);
      const pages = Math.max(1, Math.ceil(list.length / per));
      const pageNo = Math.min(Math.max(Math.round(num(q.get('page'), 1)), 1), pages);
      const shown = list.slice((pageNo - 1) * per, pageNo * per);
      const counts = new Map<string, number>();
      for (const p of all) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
      const href = (params: Record<string, string | number | undefined>) => {
        const u = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && !(k === 'page' && v === 1)) u.set(k, String(v));
        const qs = u.toString();
        return `${blogUrl(f)}${qs ? `?${qs}` : ''}`;
      };
      const chips = counts.size
        ? `<div class="chips"><a class="chip${tag ? '' : ' on'}" href="${escapeHtml(href({}))}">Alle</a>${[...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 30)
            .map(([t, n]) => `<a class="chip${t === tag ? ' on' : ''}" href="${escapeHtml(href({ tag: t }))}">${escapeHtml(t)} <small>${n}</small></a>`)
            .join('')}</div>`
        : '';
      const grid = shown.length
        ? `<div class="posts">${shown.map((p, i) => card(f, p, i === 0 && pageNo === 1 && !tag && shown.length > 2)).join('')}</div>`
        : `<div class="empty">${tag ? `Keine Beiträge mit „${escapeHtml(tag)}“.` : 'Hier erscheinen bald die ersten Beiträge.'}</div>`;
      const pager =
        pages > 1
          ? `<nav class="pager" aria-label="Seiten">${pageNo > 1 ? `<a class="btn secondary" rel="prev" href="${escapeHtml(href({ tag, page: pageNo - 1 }))}">← Neuere</a>` : ''}<span>Seite ${pageNo} von ${pages}</span>${pageNo < pages ? `<a class="btn secondary" rel="next" href="${escapeHtml(href({ tag, page: pageNo + 1 }))}">Ältere →</a>` : ''}</nav>`
          : '';
      const title = `${tag ? `${tag} – ` : ''}${bs.title || 'Blog'}${pageNo > 1 ? ` (Seite ${pageNo})` : ''} – ${site}`;
      const desc = bs.description || s.description || '';
      const canonical = href({ tag, page: pageNo });
      const head = [
        `<link rel="canonical" href="${escapeHtml(canonical)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${escapeHtml(title)}">`,
        `<meta property="og:url" content="${escapeHtml(canonical)}">`,
        desc ? `<meta property="og:description" content="${escapeHtml(desc)}">` : '',
        s.og_image ? `<meta property="og:image" content="${escapeHtml(safeUrl(s.og_image))}">` : '',
        s.site_name ? `<meta property="og:site_name" content="${escapeHtml(s.site_name)}">` : '',
        `<meta name="twitter:card" content="${s.og_image ? 'summary_large_image' : 'summary'}">`,
        s.noindex ? '<meta name="robots" content="noindex, nofollow">' : '',
        pageNo > 1 ? `<link rel="prev" href="${escapeHtml(href({ tag, page: pageNo - 1 }))}">` : '',
        pageNo < pages ? `<link rel="next" href="${escapeHtml(href({ tag, page: pageNo + 1 }))}">` : '',
      ].join('');
      return shell(f, {
        title,
        description: desc,
        head,
        body: `<main class="bi"><div class="bi-head"><h1>${escapeHtml(tag ? `#${tag}` : bs.title || 'Blog')}</h1>${desc && !tag ? `<p>${escapeHtml(desc)}</p>` : ''}${chips}</div>${grid}${pager}</main>`,
      });
    };

    /** `preview`: not public (noindex); `flag`: banner text for shared preview links. */
    function renderPost(f: any, p: any, opts: { preview?: boolean; flag?: string; related?: any[] } = {}): string {
      const s = f.settings ?? {};
      const site = s.site_name || f.name;
      const seo = p.seo ?? {};
      const url = postUrl(f, p);
      const title = seo.title || p.title;
      const desc = seo.description || p.excerpt || excerptOf(stripMarkdown(p.content), 160);
      const image = seo.og_image || p.cover_image || s.og_image || '';
      const ld = {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: p.title,
        description: desc,
        datePublished: p.published_at,
        dateModified: p.updated_at,
        mainEntityOfPage: url,
        url,
        ...(image ? { image: [image] } : {}),
        ...(p.author ? { author: { '@type': 'Person', name: p.author } } : {}),
        publisher: { '@type': 'Organization', name: site },
        ...(p.tags?.length ? { keywords: p.tags.join(', ') } : {}),
      };
      const head = [
        `<link rel="canonical" href="${escapeHtml(url)}">`,
        `<meta property="og:type" content="article">`,
        `<meta property="og:title" content="${escapeHtml(title)}">`,
        `<meta property="og:url" content="${escapeHtml(url)}">`,
        desc ? `<meta property="og:description" content="${escapeHtml(desc)}">` : '',
        image ? `<meta property="og:image" content="${escapeHtml(safeUrl(image))}">` : '',
        `<meta property="og:site_name" content="${escapeHtml(site)}">`,
        p.published_at ? `<meta property="article:published_time" content="${escapeHtml(p.published_at)}">` : '',
        `<meta property="article:modified_time" content="${escapeHtml(p.updated_at)}">`,
        p.author ? `<meta property="article:author" content="${escapeHtml(p.author)}">` : '',
        ...(p.tags ?? []).map((t: string) => `<meta property="article:tag" content="${escapeHtml(t)}">`),
        `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
        seo.noindex || s.noindex || opts.preview ? '<meta name="robots" content="noindex, nofollow">' : '',
        `<script type="application/ld+json">${jsonForScript(ld)}</script>`,
      ].join('');
      const enc = encodeURIComponent;
      const share = `<div class="share"><span>Teilen:</span><a href="https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}" target="_blank" rel="noopener">LinkedIn</a><a href="https://www.facebook.com/sharer/sharer.php?u=${enc(url)}" target="_blank" rel="noopener">Facebook</a><a href="https://x.com/intent/post?url=${enc(url)}&text=${enc(p.title)}" target="_blank" rel="noopener">X</a><a href="https://wa.me/?text=${enc(`${p.title} ${url}`)}" target="_blank" rel="noopener">WhatsApp</a><a href="mailto:?subject=${enc(p.title)}&body=${enc(url)}">E-Mail</a></div>`;
      const related = opts.related?.length ? `<section class="related"><h2>Weitere Beiträge</h2><div class="posts">${opts.related.map((r) => card(f, r)).join('')}</div></section>` : '';
      const tags = p.tags?.length ? `<div class="chips">${p.tags.map((t: string) => `<a class="chip" href="${escapeHtml(`${blogUrl(f)}?tag=${enc(t)}`)}">${escapeHtml(t)}</a>`).join('')}</div>` : '';
      const body = `${opts.flag ? `<div class="preview-flag">${escapeHtml(opts.flag)}</div>` : ''}<article class="post">
<a class="back" href="${escapeHtml(blogUrl(f))}">← Alle Beiträge</a>
<h1>${escapeHtml(p.title)}</h1>
${p.excerpt ? `<p class="lead">${escapeHtml(p.excerpt)}</p>` : ''}
${meta(f, p)}
${p.cover_image ? `<img class="cover" src="${escapeHtml(safeUrl(p.cover_image))}" alt="">` : '<div style="height:26px"></div>'}
<div class="prose">${renderMarkdown(p.content, { embeds: true })}</div>
${tags}${share}</article>${related}`;
      return String(shell(f, { title: `${title} – ${site}`, description: desc, head, body }).body);
    }

    const rss = (f: any): RawResult => {
      const s = f.settings ?? {};
      const bs = blogSettings(f);
      const site = s.site_name || f.name;
      const posts = s.noindex ? [] : publicPosts(f.id).filter((p) => !p.seo?.noindex).slice(0, 30);
      const cdata = (x: string) => `<![CDATA[${x.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
      const items = posts
        .map(
          (p) => `<item><title>${escapeHtml(p.title)}</title><link>${escapeHtml(postUrl(f, p))}</link><guid isPermaLink="true">${escapeHtml(postUrl(f, p))}</guid><pubDate>${rfc822(p.published_at)}</pubDate>${p.author ? `<dc:creator>${escapeHtml(p.author)}</dc:creator>` : ''}${(p.tags ?? []).map((t: string) => `<category>${escapeHtml(t)}</category>`).join('')}<description>${escapeHtml(p.excerpt || excerptOf(stripMarkdown(p.content), 300))}</description><content:encoded>${cdata(`${p.cover_image ? `<p><img src="${escapeHtml(safeUrl(p.cover_image))}" alt=""></p>` : ''}${renderMarkdown(p.content, { embeds: true })}`)}</content:encoded></item>`,
        )
        .join('\n');
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>${escapeHtml(`${site} – ${bs.title || 'Blog'}`)}</title><link>${escapeHtml(blogUrl(f))}</link><description>${escapeHtml(bs.description || s.description || site)}</description><language>de-de</language>
<atom:link href="${escapeHtml(`${blogUrl(f)}/rss.xml`)}" rel="self" type="application/rss+xml"/>${posts[0] ? `<lastBuildDate>${rfc822(posts[0].published_at)}</lastBuildDate>` : ''}
${items}
</channel></rss>`;
      const r = text(body, 'application/rss+xml; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=300';
      return r;
    };

    const hasBlog = (fid: string) => !!db.get('SELECT id FROM blog_posts WHERE funnel_id = ? LIMIT 1', fid);
    const missing = (f: any) =>
      shell(f, { title: 'Beitrag nicht gefunden', head: '<meta name="robots" content="noindex">', status: 404, body: `<main class="bi"><div class="empty"><h1 style="color:var(--text)">Beitrag nicht gefunden</h1><p>Diesen Beitrag gibt es nicht (mehr).</p><a class="btn" href="${escapeHtml(blogUrl(f))}">Zum Blog</a></div></main>` });

    // /blog on the website (funnels.ts hands paths it doesn't know to us).
    app.services.sitePaths = [...(app.services.sitePaths ?? []), (f: any, path: string, q: URLSearchParams) => (path === 'blog' && hasBlog(f.id) ? blogIndex(f, q) : undefined)];
    app.services.siteSitemap = [
      ...(app.services.siteSitemap ?? []),
      (f: any) => {
        if (f.settings?.noindex) return [];
        const posts = publicPosts(f.id).filter((p) => !p.seo?.noindex);
        if (!posts.length) return [];
        return [{ loc: blogUrl(f), lastmod: posts[0].published_at }, ...posts.map((p) => ({ loc: postUrl(f, p), lastmod: p.updated_at > p.published_at ? p.updated_at : p.published_at }))];
      },
    ];

    // Posts in the site search (modules/site-routing.ts): app.services.siteSearchDocs = [(funnel) => SearchDoc[]].
    app.services.siteSearchDocs = [
      ...(app.services.siteSearchDocs ?? []),
      (f: any) => (f.settings?.noindex ? [] : publicPosts(f.id).filter((p) => !p.seo?.noindex).map((p) => ({ kind: 'post', title: p.title, url: postUrl(f, p), text: `${p.excerpt ?? ''} ${(p.tags ?? []).join(' ')} ${stripMarkdown(p.content ?? '')}`, label: 'Blog' }))),
    ];

    router.get('/p/:funnel/blog/:slug', 'public', (ctx) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE slug = ?', ctx.params.funnel), ['settings']);
      if (!f) return html('<p>Nicht gefunden</p>', 404);
      // Redirect rules of the site apply to the blog's paths too (modules/site-routing.ts).
      const moved = app.services.siteRedirect?.(ctx, f, ['blog', ctx.params.slug]);
      if (moved) return moved;
      if (ctx.params.slug === 'rss.xml') return rss(f);
      const p = parseJson(db.get('SELECT * FROM blog_posts WHERE funnel_id = ? AND slug = ?', f.id, ctx.params.slug), ['tags', 'seo']);
      const preview = !!p && p.status !== 'published' && ctx.query.get('preview') === previewKey(p);
      if (!p || (p.status !== 'published' && !preview)) return missing(f);
      if (!preview) db.run('UPDATE blog_posts SET views = views + 1 WHERE id = ?', p.id);
      const related = publicPosts(f.id)
        .filter((x) => x.id !== p.id)
        .sort((a, b) => (b.tags ?? []).filter((t: string) => (p.tags ?? []).includes(t)).length - (a.tags ?? []).filter((t: string) => (p.tags ?? []).includes(t)).length)
        .slice(0, 3);
      const r = html(renderPost(f, preview ? { ...p, published_at: p.published_at || p.publish_at || p.updated_at } : p, { preview, related, flag: preview ? 'Vorschau – dieser Beitrag ist noch nicht öffentlich' : '' }));
      r.headers['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation allow-modals';
      return r;
    });

    // Scheduled posts go live on the scheduler tick.
    app.onTick(() => {
      const due = db.all(`SELECT * FROM blog_posts WHERE status = 'scheduled' AND publish_at <= ?`, now());
      for (const p of due) {
        if (!db.run(`UPDATE blog_posts SET status = 'published', published_at = publish_at, updated_at = ? WHERE id = ? AND status = 'scheduled'`, now(), p.id).changes) continue;
        const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ?', p.funnel_id), ['settings']);
        if (f) app.events.emit(p.location_id, 'blog.post_published', { postId: p.id, funnelId: f.id, title: p.title, url: postUrl(f, p) });
      }
    });
  },
};
