import type { Module } from '../core/app.js';
import { notFound, type RawResult } from '../core/http.js';
import { escapeHtml as esc } from '../core/template.js';
import { now, sha256, slugify } from '../core/util.js';
import { renderMarkdown } from '../services/wiki-markdown.js';
import type { PageRow, SpaceRow } from '../services/wiki-store.js';

/**
 * Public read-only pages of the Wiki: `/wiki/s/<token>` (unguessable token – only its SHA-256 is stored –,
 * revocable, no login, never indexed) with its JSON form `/api/public/wiki/<token>` and a PDF download.
 * The body is rendered in public mode: no live data from the CRM, no links into the app, checkboxes
 * read-only; the page's CSP allows no script at all.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export const PUBLIC_CSS = `
:root{--bg:#f6f7fb;--panel:#fff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--brand:#2563eb;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--panel:#111a2e;--text:#e5e7eb;--muted:#94a3b8;--line:#1e293b;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:var(--panel);border-bottom:1px solid var(--line)}header .in{max-width:860px;margin:0 auto;padding:12px 20px;display:flex;gap:10px;align-items:center;font-weight:600}
header .badge{margin-left:auto;font-size:12px;font-weight:500;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 10px}
main{max-width:860px;margin:0 auto;padding:28px 20px 60px}article{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:30px 34px}
h1.title{margin:0 0 4px;font-size:clamp(26px,4vw,34px);line-height:1.2}.meta{color:var(--muted);font-size:14px;margin-bottom:22px}
.wk h2{font-size:24px;margin:28px 0 8px}.wk h3{font-size:20px;margin:22px 0 6px}.wk h4,.wk h5,.wk h6{font-size:17px;margin:18px 0 4px}
.wk p{margin:0 0 12px}.wk img{max-width:100%;height:auto;border-radius:10px}.wk a{color:var(--brand)}
.wk code{background:color-mix(in srgb,var(--brand) 10%,transparent);padding:1px 6px;border-radius:6px;font-size:.9em}
.wk pre{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:12px;overflow-x:auto}.wk pre code{background:none;padding:0}
.wk blockquote{margin:14px 0;padding:2px 16px;border-left:4px solid var(--brand);background:color-mix(in srgb,var(--brand) 7%,transparent);border-radius:0 10px 10px 0}
.wk mark{background:#fde68a;color:#111;border-radius:3px;padding:0 2px}.wk hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.wk ul,.wk ol{padding-left:24px;margin:0 0 12px}.wk ul.wk-tasks{list-style:none;padding-left:4px}.wk li.wk-task input{margin-right:6px}.wk li.wk-done>span{color:var(--muted);text-decoration:line-through}
.wk-table-wrap{overflow-x:auto;margin:0 0 14px}.wk-table{border-collapse:collapse;min-width:50%}.wk-table th,.wk-table td{border:1px solid var(--line);padding:6px 12px;text-align:left}.wk-table th{background:color-mix(in srgb,var(--brand) 8%,transparent)}
.wk-al-c{text-align:center!important}.wk-al-r{text-align:right!important}
.wk-callout{border-radius:12px;padding:10px 16px;margin:14px 0;border:1px solid var(--line);border-left-width:4px;background:color-mix(in srgb,var(--brand) 6%,transparent)}
.wk-callout-title{font-weight:700;margin-bottom:2px}.wk-callout-body>:last-child{margin-bottom:0}
.wk-callout-warning{border-left-color:#f59e0b;background:#fffbeb}.wk-callout-danger{border-left-color:#dc2626;background:#fef2f2}.wk-callout-success{border-left-color:#16a34a;background:#f0fdf4}.wk-callout-tip{border-left-color:#8b5cf6;background:#f5f3ff}
@media (prefers-color-scheme:dark){.wk-callout-warning{background:#2a2108}.wk-callout-danger{background:#2b1010}.wk-callout-success{background:#0b2414}.wk-callout-tip{background:#1a1433}}
.wk-chip,.wk-mention,.wk-pagelink{background:color-mix(in srgb,var(--brand) 12%,transparent);border-radius:6px;padding:1px 7px;font-size:.92em}
.wk-card{margin:12px 0}.wk-card .wk-chip{display:inline-block;padding:6px 12px}
.foot{text-align:center;color:var(--muted);font-size:13px;margin-top:26px}.foot a{color:var(--muted)}
@media (max-width:560px){article{padding:20px 18px}main{padding:18px 12px 40px}}
@media print{body{background:#fff}header,.foot{display:none}article{border:0;padding:0}}
`;

export function publicPage(o: { title: string; html: string; brand: string; updated: string; pdfUrl?: string; status?: number }): RawResult {
  const doc = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(o.title)} – ${esc(o.brand)}</title><style>${PUBLIC_CSS}</style></head><body>
<header><div class="in"><span>${esc(o.brand)}</span><span class="badge">Nur ansehen</span></div></header>
<main><article><h1 class="title">${esc(o.title)}</h1>${o.updated ? `<div class="meta">Aktualisiert am ${esc(o.updated)}</div>` : ''}<div class="wk">${o.html}</div></article>
<div class="foot">Geteilt aus ${esc(o.brand)}${o.pdfUrl ? ` · <a href="${esc(o.pdfUrl)}">Als PDF laden</a>` : ''}</div></main></body></html>`;
  return {
    __raw: true,
    status: o.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    body: doc,
  };
}

export const wikiPublicModule: Module = {
  name: 'wiki-public',
  register(app) {
    const { db, router } = app;
    const brand = () => String(app.services.brandName?.() ?? 'HyperLevel');

    /** The share and its page for a token (revoked, unknown or trashed → undefined). */
    const shared = (tok: string) => {
      if (!TOKEN_RE.test(tok)) return undefined;
      const s = db.get<{ id: string; page_id: string; location_id: string }>('SELECT id, page_id, location_id FROM wiki_shares WHERE token_hash = ? AND revoked_at IS NULL', sha256(tok));
      const p = s && db.get<PageRow>('SELECT * FROM wiki_pages WHERE id = ? AND location_id = ? AND trashed_at IS NULL', s.page_id, s.location_id);
      const sp = p && db.get<SpaceRow>('SELECT * FROM wiki_spaces WHERE id = ?', p.space_id);
      return s && p && sp ? { share: s, page: p, space: sp } : undefined;
    };
    const day = (iso: string, loc: string) => new Date(iso).toLocaleDateString('de-DE', { timeZone: app.location(loc)?.timezone || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

    router.get('/wiki/s/:token', 'public', (ctx) => {
      const hit = shared(ctx.params.token);
      if (!hit) return publicPage({ title: 'Link ungültig', html: '<p>Dieser Link ist abgelaufen oder wurde widerrufen.</p>', brand: brand(), updated: '', status: 404 });
      db.run('UPDATE wiki_shares SET views = views + 1, last_used_at = ? WHERE id = ?', now(), hit.share.id);
      const r = renderMarkdown(hit.page.body, { publicView: true, baseLevel: 2 });
      return publicPage({ title: hit.page.title, html: r.html, brand: brand(), updated: day(hit.page.updated_at, hit.page.location_id), pdfUrl: `/api/public/wiki/${ctx.params.token}/pdf` });
    });

    router.get('/api/public/wiki/:token', 'public', (ctx) => {
      const hit = shared(ctx.params.token);
      if (!hit) throw notFound('Link ungültig oder widerrufen');
      const r = renderMarkdown(hit.page.body, { publicView: true, baseLevel: 2 });
      return { title: hit.page.title, html: r.html, toc: r.toc, updated_at: hit.page.updated_at };
    });

    router.get('/api/public/wiki/:token/pdf', 'public', (ctx) => {
      const hit = shared(ctx.params.token);
      if (!hit) throw notFound('Link ungültig oder widerrufen');
      const make = app.services.wikiPdf as ((a: unknown, p: PageRow[], opts: { space: string; baseUrl: string; author: string; publicView?: boolean }) => Uint8Array) | undefined;
      if (!make) throw notFound();
      const bytes = make(app, [hit.page], { space: hit.space.name, baseUrl: app.baseUrl(), author: hit.page.updated_by_name, publicView: true });
      return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${slugify(hit.page.title) || 'seite'}.pdf"`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }, body: Buffer.from(bytes) };
    });
  },
};
