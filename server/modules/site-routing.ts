import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, html, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, now, slugify } from '../core/util.js';
import { isBot } from '../services/ab-stats.js';
import { pageText } from '../services/site-layout.js';
import { MAX_RULES, REDIRECT_CODES, cleanSource, cleanTarget, findLoop, matchRedirect, normPath, parseRuleLines, resolveTarget, type RedirectRule } from '../services/site-redirects.js';
import { search as runSearch, type SearchDoc } from '../services/site-search.js';
import { cleanPageLayout } from '../services/site-settings.js';
import { renderPage, pageUrl, sitePages } from '../services/site-render.js';
import { siteBlocks, wrap } from '../services/site-blocks.js';

/**
 * Routing of a site beyond the pages themselves: redirect manager (301/302, wildcards, the list of paths visitors did not find),
 * the deeper public paths (`/p/<site>/<a>/<b>…`, registered after the blog so its posts match first), site search at `/search`,
 * and translations of a page (hreflang pairs, see services/site-render.ts). The custom 404 page itself is rendered by funnels.ts.
 */

const SEARCH_HITS = new Map<string, number[]>();
const MISS_CAP = 300;
const NOISE = /(^|\/)(wp-|\.env|\.git|xmlrpc|phpmyadmin|admin\.php|favicon\.ico|apple-touch|sitemap_index|\.well-known)|\.(php|asp|aspx|jsp|map|ico|png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|txt|xml)$/i;

export const siteRoutingModule: Module = {
  name: 'site-routing',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE site_redirects (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
        source TEXT NOT NULL, target TEXT NOT NULL, code INTEGER NOT NULL DEFAULT 301,
        wildcard INTEGER NOT NULL DEFAULT 0, keep_query INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, last_hit_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(funnel_id, source)
      );
      CREATE INDEX site_redirects_funnel ON site_redirects(funnel_id, position);
      CREATE TABLE site_misses (
        funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        path TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
        PRIMARY KEY (funnel_id, path)
      );
      CREATE INDEX site_misses_loc ON site_misses(location_id, last_at);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const serve = () => app.services.siteServe as { page(ctx: Ctx, f: any, segments: string[]): unknown; bySlug(slug: string): any; gone(): RawResult; sandbox: string };

    const funnelOr404 = (ctx: Ctx, fid = ctx.params.id) => {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', fid, ctx.locationId), ['settings']);
      if (!f) throw notFound('Website nicht gefunden');
      return f;
    };
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };

    // --- redirect rules ---------------------------------------------------------------------------------------------------
    /** Rules per site, kept in memory (read on every page request); changes through the API drop the entry. */
    const cache = new Map<string, RedirectRule[]>();
    const rulesOf = (fid: string): RedirectRule[] => {
      let r = cache.get(fid);
      if (!r) {
        r = db.all('SELECT id, source, target, code, wildcard, keep_query, position FROM site_redirects WHERE funnel_id = ? ORDER BY position, created_at', fid).map((x) => ({ ...x, wildcard: !!x.wildcard, keep_query: !!x.keep_query }) as RedirectRule);
        if (cache.size > 2000) cache.clear();
        cache.set(fid, r);
      }
      return r;
    };
    const changed = (fid: string) => void cache.delete(fid);

    const pageConflict = (fid: string, source: string, wildcard: boolean) => {
      if (wildcard) return false;
      const seg = source.replace(/^\//, '');
      return !seg.includes('/') && !!db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = ?', fid, seg);
    };
    const ruleOut = (r: any, fid: string) => ({ ...r, wildcard: !!r.wildcard, keep_query: !!r.keep_query, page_conflict: pageConflict(fid, r.source, !!r.wildcard) });

    /** Validated fields of a rule from a request body; German messages. */
    function ruleFields(b: any, cur?: any) {
      try {
        const out: Record<string, any> = {};
        if (b.source !== undefined || !cur) Object.assign(out, (({ source, wildcard }) => ({ source, wildcard: wildcard ? 1 : 0 }))(cleanSource(b.source)));
        if (b.target !== undefined || !cur) out.target = cleanTarget(b.target);
        if (b.code !== undefined || !cur) out.code = (REDIRECT_CODES as readonly number[]).includes(Number(b.code)) ? Number(b.code) : 301;
        if (b.keep_query !== undefined) out.keep_query = b.keep_query === false || b.keep_query === 'false' ? 0 : 1;
        if (b.note !== undefined) out.note = String(b.note ?? '').slice(0, 200);
        return out;
      } catch (e) {
        throw bad((e as Error).message);
      }
    }

    function assertNoLoop(fid: string, row: { id: string; source: string; target: string; code: number; wildcard: any; keep_query?: any }) {
      const loop = findLoop(rulesOf(fid), { ...row, wildcard: !!row.wildcard, keep_query: row.keep_query !== 0 });
      if (loop) throw bad(loop);
    }

    app.services.siteRedirect = (ctx: Ctx, f: any, segments: string[]): RawResult | undefined => {
      const rules = rulesOf(f.id);
      if (!rules.length) return undefined;
      const path = `/${segments.join('/')}`;
      const m = matchRedirect(rules, path);
      if (!m) return undefined;
      const query = ctx.url.search;
      let url: string;
      try {
        // Captures come from the visitor's own address: they can fill the path of the target, never turn it into another host.
        const to = /^https?:\/\//i.test(m.to) ? m.to : `/${m.to.replace(/^\/+/, '')}`;
        if (/[\\\u0000-\u001f]/.test(to)) return undefined;
        url = new URL(resolveTarget(to, pageUrl(app, f), query, m.rule.keep_query)).href;
      } catch {
        return undefined;
      }
      if (normPath(new URL(url).pathname) === normPath(ctx.url.pathname) && new URL(url).host === String(ctx.req.headers.host ?? '')) return undefined;
      db.run('UPDATE site_redirects SET hits = hits + 1, last_hit_at = ? WHERE id = ?', now(), m.rule.id);
      return { __raw: true, status: m.rule.code, headers: { location: url, 'cache-control': m.rule.code === 301 || m.rule.code === 308 ? 'public, max-age=300' : 'no-store' }, body: '' };
    };

    /** The 404 page was shown: remember the path so the owner can point it somewhere (visitors only, no bots, no probes). */
    app.services.siteMissed = (ctx: Ctx, f: any) => {
      try {
        if (isBot(String(ctx.req.headers['user-agent'] ?? ''))) return;
        const path = normPath(ctx.url.pathname.replace(/^\/p\/[^/]+/, '') || '/');
        if (path === '/' || path.length > 200 || NOISE.test(path) || !/^[\w\-./~%*]+$/.test(path)) return;
        const at = now();
        db.run(
          `INSERT INTO site_misses (funnel_id, location_id, path, hits, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(funnel_id, path) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`,
          f.id,
          f.location_id,
          path,
          at,
          at,
        );
        const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_misses WHERE funnel_id = ?', f.id)!.n;
        if (n > MISS_CAP) db.run('DELETE FROM site_misses WHERE funnel_id = ? AND path IN (SELECT path FROM site_misses WHERE funnel_id = ? ORDER BY last_at ASC, hits ASC LIMIT ?)', f.id, f.id, n - MISS_CAP);
      } catch (e) {
        console.error('[site-routing] misses:', (e as Error).message);
      }
    };

    router.get('/api/funnels/:id/redirects', 'location', (ctx) => {
      const f = funnelOr404(ctx);
      return {
        rules: db.all('SELECT * FROM site_redirects WHERE funnel_id = ? ORDER BY position, created_at', f.id).map((r) => ruleOut(r, f.id)),
        misses: db.all('SELECT path, hits, last_at FROM site_misses WHERE funnel_id = ? ORDER BY hits DESC, last_at DESC LIMIT 50', f.id).filter((m) => !matchRedirect(rulesOf(f.id), m.path)),
        max: MAX_RULES,
      };
    });
    router.post('/api/funnels/:id/redirects', 'location', (ctx) => {
      writable(ctx);
      const f = funnelOr404(ctx);
      const b = ctx.body ?? {};
      const fields = ruleFields(b);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_redirects WHERE funnel_id = ?', f.id)!.n >= MAX_RULES) throw bad(`Höchstens ${MAX_RULES} Umleitungen je Website`);
      if (db.get('SELECT id FROM site_redirects WHERE funnel_id = ? AND source = ?', f.id, fields.source)) throw bad('Für diese Quelle gibt es schon eine Umleitung');
      const row = { id: id(), location_id: ctx.locationId, funnel_id: f.id, keep_query: 1, note: '', position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM site_redirects WHERE funnel_id = ?', f.id)!.n, hits: 0, created_at: now(), updated_at: now(), ...fields } as any;
      assertNoLoop(f.id, row);
      db.insert('site_redirects', row);
      changed(f.id);
      return ruleOut(row, f.id);
    });
    router.patch('/api/site-redirects/:id', 'location', (ctx) => {
      writable(ctx);
      const cur = db.get('SELECT * FROM site_redirects WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound('Umleitung nicht gefunden');
      const fields = ruleFields(ctx.body ?? {}, cur);
      if (fields.source && fields.source !== cur.source && db.get('SELECT id FROM site_redirects WHERE funnel_id = ? AND source = ? AND id != ?', cur.funnel_id, fields.source, cur.id)) throw bad('Für diese Quelle gibt es schon eine Umleitung');
      assertNoLoop(cur.funnel_id, { ...cur, ...fields } as any);
      db.update('site_redirects', cur.id, { ...fields, updated_at: now() });
      changed(cur.funnel_id);
      return ruleOut(db.get('SELECT * FROM site_redirects WHERE id = ?', cur.id), cur.funnel_id);
    });
    router.delete('/api/site-redirects/:id', 'location', (ctx) => {
      writable(ctx);
      const cur = db.get('SELECT funnel_id FROM site_redirects WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound('Umleitung nicht gefunden');
      db.run('DELETE FROM site_redirects WHERE id = ?', ctx.params.id);
      changed(cur.funnel_id);
      return { ok: true };
    });
    router.post('/api/funnels/:id/redirects/test', 'location', (ctx) => {
      const f = funnelOr404(ctx);
      const path = str(ctx.body?.path, 'Pfad', { required: true, max: 300 });
      const m = matchRedirect(rulesOf(f.id), path);
      if (!m) return { match: null };
      return { match: { id: m.rule.id, source: m.rule.source, code: m.rule.code }, url: resolveTarget(m.to, pageUrl(app, f), '', false) };
    });
    router.post('/api/funnels/:id/redirects/import', 'location', (ctx) => {
      writable(ctx);
      const f = funnelOr404(ctx);
      const parsed = parseRuleLines(String(ctx.body?.text ?? ''));
      let created = 0;
      let skipped = 0;
      const errors = [...parsed.errors];
      let pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM site_redirects WHERE funnel_id = ?', f.id)!.n;
      let total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_redirects WHERE funnel_id = ?', f.id)!.n;
      db.tx(() => {
        for (const r of parsed.rules) {
          if (total >= MAX_RULES) {
            errors.push(`Höchstens ${MAX_RULES} Umleitungen je Website – der Rest wurde nicht übernommen`);
            break;
          }
          const { source, wildcard } = cleanSource(r.source);
          if (db.get('SELECT id FROM site_redirects WHERE funnel_id = ? AND source = ?', f.id, source)) {
            skipped++;
            continue;
          }
          const row = { id: id(), location_id: ctx.locationId, funnel_id: f.id, source, target: r.target, code: r.code, wildcard: wildcard ? 1 : 0, keep_query: 1, note: '', position: pos++, hits: 0, created_at: now(), updated_at: now() };
          const loop = findLoop(rulesOf(f.id), { ...row, wildcard, keep_query: true });
          if (loop) {
            errors.push(`${source}: ${loop}`);
            continue;
          }
          db.insert('site_redirects', row);
          changed(f.id);
          total++;
          created++;
        }
      });
      return { created, skipped, errors };
    });
    router.delete('/api/funnels/:id/redirects/misses', 'location', (ctx) => {
      writable(ctx);
      const f = funnelOr404(ctx);
      const p = ctx.query.get('path');
      if (p) db.run('DELETE FROM site_misses WHERE funnel_id = ? AND path = ?', f.id, normPath(p));
      else db.run('DELETE FROM site_misses WHERE funnel_id = ?', f.id);
      return { ok: true };
    });

    // --- deeper public paths ----------------------------------------------------------------------------------------------------
    for (const depth of [2, 3, 4]) {
      const names = ['a', 'b', 'c', 'd'].slice(0, depth);
      router.get(`/p/:funnel/${names.map((n) => `:${n}`).join('/')}`, 'public', (ctx) => {
        const f = serve().bySlug(ctx.params.funnel);
        return f ? serve().page(ctx, f, names.map((n) => ctx.params[n])) : serve().gone();
      });
    }

    // --- translations (hreflang) ----------------------------------------------------------------------------------------------
    /** A copy of a page for another language: same group key, own path ("<path>-en"), same blocks to translate. */
    router.post('/api/funnel-pages/:id/translation', 'location', (ctx) => {
      writable(ctx);
      const p = parseJson(db.get('SELECT * FROM funnel_pages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId), ['blocks', 'seo', 'layout']);
      if (!p) throw notFound('Seite nicht gefunden');
      const f = funnelOr404(ctx, p.funnel_id);
      const lang = String(ctx.body?.lang ?? '').trim().toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/.test(lang)) throw bad('Sprache: ein Kürzel wie en oder fr');
      const group = String(p.layout?.group || id(8));
      const taken = pagesIn(f.id);
      if (taken.some((x) => String(x.layout?.group ?? '') === group && x.layout?.lang === lang)) throw bad('Für diese Sprache gibt es die Seite schon');
      const own = String(p.layout?.lang || f.settings?.languages?.default || 'de');
      if (lang === own) throw bad('Das ist die Sprache dieser Seite');
      let slug = slugify(String(ctx.body?.slug || `${p.slug}-${lang}`));
      for (let i = 2; db.get('SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = ?', f.id, slug); i++) slug = `${slugify(String(ctx.body?.slug || `${p.slug}-${lang}`))}-${i}`;
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM funnel_pages WHERE funnel_id = ?', f.id)!.n;
      const copy = { id: id(), location_id: ctx.locationId, funnel_id: f.id, name: `${p.name} (${lang.toUpperCase()})`, slug, position: pos, blocks: reId(p.blocks), seo: { ...p.seo }, layout: cleanPageLayout({ ...p.layout, lang, group }), created_at: now(), updated_at: now() };
      db.tx(() => {
        db.insert('funnel_pages', copy);
        if (!p.layout?.group) db.update('funnel_pages', p.id, { layout: cleanPageLayout({ ...p.layout, lang: own, group }), updated_at: now() });
      });
      // The site knows the language afterwards (header switcher, hreflang labels).
      const langs = f.settings?.languages ?? { default: own, list: [] };
      if (!langs.list?.some((l: any) => l.code === lang)) {
        const known: { code: string; label: string }[] = langs.list?.length ? langs.list : [{ code: own, label: own === 'de' ? 'Deutsch' : own.toUpperCase() }];
        db.update('funnels', f.id, { settings: { ...f.settings, languages: { default: langs.default || own, list: [...known, { code: lang, label: lang.toUpperCase() }].slice(0, 8) } }, updated_at: now() });
      }
      return { ...copy, url: pageUrl(app, f, copy) };
    });
    const pagesIn = (fid: string) => sitePages(app, fid);
    const reId = (blocks: any): any => JSON.parse(JSON.stringify(blocks ?? []), (k, v) => (k === 'id' && typeof v === 'string' ? id(8) : v));

    // --- site search ---------------------------------------------------------------------------------------------------------
    const docsOf = (f: any): SearchDoc[] =>
      db.memo(`site-search:${f.id}`, 30_000, () => {
        const docs: SearchDoc[] = [];
        // Pages other modules keep from visitors stay out (e.g. password-protected ones, modules/site-protect.ts):
        // app.services.siteSearchHide = [(funnel) => page ids].
        const hidden = new Set<string>();
        for (const fn of (app.services.siteSearchHide ?? []) as ((f: any) => string[])[]) for (const pid of fn(f) ?? []) hidden.add(pid);
        const pages = parseRows(db.all('SELECT id, name, slug, seo, blocks, layout FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at LIMIT 300', f.id), ['seo', 'blocks', 'layout']);
        pages.forEach((p, i) => {
          if (p.seo?.noindex || p.slug === '404' || p.layout?.hide_search || hidden.has(p.id)) return;
          docs.push({ kind: 'page', title: String(p.seo?.title || p.name), url: pageUrl(app, f, p, i === 0), text: `${p.seo?.description ?? ''} ${pageText(p.blocks)}`.trim(), label: 'Seite' });
        });
        // Blog posts, CMS items and others: app.services.siteSearchDocs = [(funnel) => SearchDoc[]].
        for (const fn of (app.services.siteSearchDocs ?? []) as ((f: any) => SearchDoc[])[]) {
          try {
            docs.push(...(fn(f) ?? []));
          } catch (e) {
            console.error('[site-search]', (e as Error).message);
          }
        }
        return docs;
      });

    const limited = (ip: string) => {
      const t = Date.now();
      const l = (SEARCH_HITS.get(ip) ?? []).filter((x) => t - x < 60_000);
      l.push(t);
      SEARCH_HITS.set(ip, l);
      if (SEARCH_HITS.size > 20_000) SEARCH_HITS.clear();
      return l.length > 40;
    };

    function searchPage(ctx: Ctx, f: any): RawResult {
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 80);
      const hits = q && !limited(ctx.ip) ? runSearch(docsOf(f), q, 20) : [];
      const page = {
        id: 'search',
        name: 'Suche',
        slug: 'search',
        seo: { title: q ? `Suche: ${q}` : 'Suche' },
        layout: {},
        blocks: [{ id: 'search1', type: 'search', q, results: hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, label: h.label })), padding: 56 }],
      };
      const r = html(renderPage(app, f, page, false, { ctx, noindex: true }));
      r.headers['cache-control'] = 'private, no-cache';
      r.headers['content-security-policy'] = serve().sandbox;
      return r;
    }
    app.services.sitePaths = [...(app.services.sitePaths ?? []), (f: any, path: string, _q: URLSearchParams, ctx: Ctx) => (path === 'search' && f.settings?.search?.enabled && !db.get(`SELECT id FROM funnel_pages WHERE funnel_id = ? AND slug = 'search'`, f.id) ? searchPage(ctx, f) : undefined)];

    siteBlocks(app).set('search', {
      type: 'search',
      css: `.sform{display:flex;gap:8px;margin:0 0 1.2em}.sform input{flex:1;min-width:0}.sres{list-style:none;padding:0;margin:0}.sres li{padding:.9em 0;border-bottom:1px solid var(--line)}.sres a{font-weight:700;font-size:1.1em}.sres small{color:var(--muted);display:block}.sres p{margin:.2em 0 0}`,
      render: (env, b, o) => {
        const action = pageUrl(env.app, env.funnel, { slug: 'search' });
        const q = typeof b.q === 'string' ? b.q : '';
        const results = Array.isArray(b.results) ? b.results : null;
        const list = results
          ? results.length
            ? `<ul class="sres">${results.slice(0, 20).map((r: any) => `<li><a href="${escapeHtml(String(r.url ?? '#'))}">${escapeHtml(String(r.title ?? ''))}</a>${r.label ? `<small>${escapeHtml(String(r.label))}</small>` : ''}${r.snippet ? `<p>${escapeHtml(String(r.snippet))}</p>` : ''}</li>`).join('')}</ul>`
            : `<p class="muted">Nichts gefunden${q ? ` zu „${escapeHtml(q)}“` : ''}. Versuch es mit einem anderen Wort.</p>`
          : '';
        return wrap(env, b, o.bare, `${b.heading ? `<h1>${escapeHtml(String(b.heading))}</h1>` : results ? '<h1>Suche</h1>' : ''}<form class="sform" role="search" action="${escapeHtml(action)}" method="get"><input type="search" name="q" value="${escapeHtml(q)}" aria-label="Suchbegriff" placeholder="${escapeHtml(String(b.placeholder || 'Suchen …'))}" maxlength="80"><button type="submit">Suchen</button></form>${list}`);
      },
    });
  },
};
