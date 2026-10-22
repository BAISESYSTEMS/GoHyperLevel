import type { App } from '../core/app.js';
import { parseRows } from '../core/db.js';
import type { Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { blockCss, imgTag, miniMarkdown, renderBlocks, siteBlocks, type Block, type BlockEnv } from './site-blocks.js';
import { pageUrl, resolveHref, safeUrl } from './site-url.js';
import { registerLayout, walkBlocks } from './site-layout.js';
import { HIDE_CSS, Rules, minify, tokensCss, tokensOf, type Tokens } from './site-style.js';

/**
 * Site builder: renders a page of a site into one self-contained HTML document – the pipeline behind `renderPage`.
 *
 *   tokens → blocks (sections, rows, columns, classic blocks) → header / footer / language links → critical CSS inline.
 *
 * Budgets (checked in tests/site-perf.test.ts): no stylesheet or script files to wait for, only the CSS of the block types a page
 * really uses (minified), pictures with width/height and lazy loading, system fonts, a single <main> landmark.
 */

export type MenuItem = { label: string; url: string; children?: MenuItem[] };
export { pageUrl };

/** The pages of a site in order (what menus, language links and search need). */
export function sitePages(app: App, funnelId: string): any[] {
  return parseRows(app.db.all('SELECT id, name, slug, position, seo, layout, updated_at FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', funnelId), ['seo', 'layout']);
}

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
export const langOf = (funnel: any, page: any): string => {
  const l = String(page?.layout?.lang || funnel?.settings?.languages?.default || 'de');
  return LANG.test(l) ? l : 'de';
};

export function firstImage(blocks: Block[]): string {
  let found = '';
  walkBlocks(blocks, (b) => {
    if (found) return;
    const src = b.type === 'hero' ? b.image : b.type === 'image' ? b.src : '';
    if (src && /^https?:\/\//.test(src)) found = src;
  });
  return found;
}

export interface RenderOpts {
  ctx?: Ctx;
  preview?: boolean;
  /** CMS item behind a dynamic page. */
  item?: Record<string, any>;
  /** Canonical address when it is not `pageUrl` (dynamic pages, the list page of a collection). */
  url?: string;
  /** Extra tags for the <head> (JSON-LD of an item …). */
  head?: string;
  /** Status the page is served with decides nothing here; a 404 page is marked noindex. */
  noindex?: boolean;
  /** No header/footer (the editor's component preview, error pages). */
  bare?: boolean;
  /** The pages of the site when they are not in the database (template previews). */
  pages?: any[];
}

/** Search and social preview tags: canonical, Open Graph, Twitter, robots. */
function seoHead(app: App, funnel: any, page: any, isFirst: boolean, o: RenderOpts): string {
  const s = funnel.settings ?? {};
  const seo = page.seo ?? {};
  const title = seo.title || page.name;
  const desc = seo.description || s.description || '';
  const image = seo.og_image || s.og_image || firstImage(page.blocks ?? []);
  const url = o.url ?? pageUrl(app, funnel, page, isFirst);
  const tags = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    desc ? `<meta property="og:description" content="${escapeHtml(desc)}">` : '',
    image ? `<meta property="og:image" content="${escapeHtml(safeUrl(image))}">` : '',
    s.site_name ? `<meta property="og:site_name" content="${escapeHtml(s.site_name)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    seo.noindex || s.noindex || o.noindex ? '<meta name="robots" content="noindex, nofollow">' : '',
  ];
  return tags.filter(Boolean).join('');
}

/** `<link rel="alternate" hreflang>` for the translations of a page (pages that share `layout.group`) and x-default. */
export function hreflangLinks(app: App, funnel: any, page: any, pages: any[]): string {
  const group = String(page?.layout?.group ?? '');
  if (!group) return '';
  const same = pages.filter((p) => String(p.layout?.group ?? '') === group);
  if (same.length < 2) return '';
  const first = pages[0];
  const links = same.map((p) => `<link rel="alternate" hreflang="${langOf(funnel, p)}" href="${escapeHtml(pageUrl(app, funnel, p, p.id === first?.id))}">`);
  const def = same.find((p) => langOf(funnel, p) === (funnel.settings?.languages?.default || 'de')) ?? same[0];
  links.push(`<link rel="alternate" hreflang="x-default" href="${escapeHtml(pageUrl(app, funnel, def, def.id === first?.id))}">`);
  return links.join('');
}

// --- header, footer ---------------------------------------------------------------------------------------------------

const menuUrl = (env: BlockEnv, raw: string): string => resolveHref(env, raw);

function menuHtml(env: BlockEnv, items: MenuItem[] | undefined, here: string, depth = 0): string {
  const list = (Array.isArray(items) ? items : []).slice(0, depth ? 12 : 10);
  if (!list.length) return '';
  return `<ul>${list
    .map((it) => {
      const href = menuUrl(env, it.url);
      const sub = depth < 1 ? menuHtml(env, it.children, here, depth + 1) : '';
      return `<li${sub ? ' class="has-sub"' : ''}><a href="${escapeHtml(href)}"${href === here ? ' aria-current="page"' : ''}>${escapeHtml(it.label)}</a>${sub}</li>`;
    })
    .join('')}</ul>`;
}

export const CHROME_CSS = `
.skip{position:absolute;left:-9999px;top:8px;z-index:100;background:var(--c-brand);color:var(--c-on-brand);padding:.7em 1.1em;border-radius:var(--r-sm)}.skip:focus{left:8px}
.gh{background:var(--c-bg);border-bottom:1px solid var(--line);position:relative;z-index:20}.gh.sticky{position:sticky;top:0}
.ghi{max-width:1200px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:18px}
.gh .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.15em;color:var(--text);text-decoration:none;min-height:44px}.gh .brand img{height:34px;width:auto}
.gn{flex:1}.gn ul{list-style:none;margin:0;padding:0;display:flex;gap:4px;flex-wrap:wrap}.gn li{position:relative}
.gn a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;color:var(--text);text-decoration:none;font-weight:600;border-radius:var(--r-sm)}.gn a:hover,.gn a[aria-current]{color:var(--c-brand)}
.gn li ul{display:none;position:absolute;left:0;top:100%;min-width:200px;background:var(--c-bg);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--sh-md);padding:6px;flex-direction:column;z-index:30}
.gn li.has-sub:hover>ul,.gn li.has-sub:focus-within>ul{display:flex}
.gh form.gs{display:flex;gap:6px}.gh form.gs input{width:150px;min-height:44px}.gh form.gs button{min-height:44px}
.gl{display:flex;gap:4px}.gl a{display:inline-flex;align-items:center;min-height:44px;padding:0 8px;color:var(--muted);text-decoration:none;font-weight:600}.gl a[aria-current]{color:var(--c-brand)}
.nt{display:none;margin-left:auto;background:transparent;color:var(--text);border:1px solid var(--line);min-width:44px;min-height:44px;font-size:1.3em;padding:0}
@media (max-width:820px){.nt{display:inline-flex;align-items:center;justify-content:center}.ghi{flex-wrap:wrap}.js .gn,.js .gh .cta-h,.js .gh form.gs{display:none}.js .gh.open .gn{display:block;flex-basis:100%}.js .gh.open .cta-h,.js .gh.open form.gs{display:flex}.gn ul{flex-direction:column}.gn li ul{display:flex;position:static;border:0;box-shadow:none;padding:0 0 0 14px}}
.gf{background:var(--c-surface);margin-top:0;padding:40px 0 26px;color:var(--text)}.gfi{max-width:1100px;margin:0 auto;padding:0 20px}
.gfc{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:24px;margin-bottom:24px}.gfc h2{font-size:1em;margin:0 0 .5em}.gfc ul{list-style:none;margin:0;padding:0}.gfc a{display:inline-block;padding:.3em 0;min-height:24px;color:var(--text)}
.gfb{border-top:1px solid var(--line);padding-top:16px;font-size:.88em;color:var(--muted);display:flex;gap:8px 20px;flex-wrap:wrap;justify-content:space-between}.gfb a{color:inherit;display:inline-block;padding:.35em 0;min-height:24px}.gfb p{margin:0}
`;

const SLUG_LEGAL: [string, string][] = [
  ['impressum', 'Impressum'],
  ['datenschutz', 'Datenschutz'],
  ['widerruf', 'Widerruf'],
  ['agb', 'AGB'],
  ['barrierefreiheit', 'Barrierefreiheit'],
];

function header(env: BlockEnv, here: string): string {
  const h = (env.funnel.settings ?? {}).header ?? {};
  const s = env.funnel.settings ?? {};
  const menus = s.menus ?? {};
  const items: MenuItem[] = menus[h.menu || 'main'] ?? [];
  const home = pageUrl(env.app, env.funnel, undefined, true);
  const brand = String(h.brand || s.site_name || env.funnel.name || '');
  const logo = h.logo ? imgTag(env, { src: h.logo, alt: '', eager: 'auto', count: false, w: Number(h.logo_w) || undefined, h: Number(h.logo_h) || undefined }) : '';
  const search = s.search?.enabled && h.search !== false ? `<form class="gs" role="search" action="${escapeHtml(pageUrl(env.app, env.funnel, { slug: 'search' }))}" method="get"><input type="search" name="q" aria-label="Website durchsuchen" placeholder="Suchen …" maxlength="80"><button type="submit">Suchen</button></form>` : '';
  const alt = languageLinks(env);
  const cta = h.cta_text ? `<a class="btn cta-h" href="${escapeHtml(menuUrl(env, h.cta_url || '#'))}">${escapeHtml(h.cta_text)}</a>` : '';
  const nav = menuHtml(env, items, here);
  return `<a class="skip" href="#main">Zum Inhalt springen</a><header class="gh${h.sticky ? ' sticky' : ''}" id="gh"><div class="ghi"><a class="brand" href="${escapeHtml(home)}">${logo}${brand ? `<span>${escapeHtml(brand)}</span>` : ''}</a>${nav ? `<button class="nt" id="nt" type="button" aria-expanded="false" aria-controls="gn" aria-label="Menü">☰</button><nav class="gn" id="gn" aria-label="Hauptnavigation">${nav}</nav>` : '<span style="flex:1"></span>'}${alt}${search}${cta}</div></header><script>(function(){var b=document.getElementById('nt');if(!b)return;document.documentElement.classList.add('js');b.addEventListener('click',function(){var o=document.getElementById('gh').classList.toggle('open');b.setAttribute('aria-expanded',o)})})()</script>`;
}

function languageLinks(env: BlockEnv): string {
  const s = env.funnel.settings ?? {};
  if (!s.header?.lang_switch) return '';
  const group = String(env.page?.layout?.group ?? '');
  if (!group) return '';
  const pages = env.pages();
  const same = pages.filter((p) => String(p.layout?.group ?? '') === group);
  if (same.length < 2) return '';
  const labels = new Map<string, string>((s.languages?.list ?? []).map((l: any) => [l.code, l.label]));
  const links = same.map((p) => {
    const code = langOf(env.funnel, p);
    return `<a href="${escapeHtml(pageUrl(env.app, env.funnel, p, p.id === pages[0]?.id))}" hreflang="${code}" lang="${code}"${p.id === env.page?.id ? ' aria-current="true"' : ''} title="${escapeHtml(labels.get(code) || code.toUpperCase())}">${code.toUpperCase()}</a>`;
  });
  return `<nav class="gl" aria-label="Sprache">${links.join('')}</nav>`;
}

function footer(env: BlockEnv, here: string): string {
  const s = env.funnel.settings ?? {};
  const f = s.footer ?? {};
  const cols = (Array.isArray(f.columns) ? f.columns : []).slice(0, 4);
  const menus = s.menus ?? {};
  const colsHtml = cols
    .map((c: any) => {
      const items: MenuItem[] = c.menu ? (menus[c.menu] ?? []) : (c.links ?? []);
      return `<div><h2>${escapeHtml(c.title ?? '')}</h2>${menuHtml(env, items, here)}</div>`;
    })
    .join('');
  const pages = env.pages();
  const legal = SLUG_LEGAL.filter(([slug]) => pages.some((p) => p.slug === slug)).map(([slug, label]) => `<a href="${escapeHtml(pageUrl(env.app, env.funnel, { slug }))}">${label}</a>`);
  if (env.app.services.cmp?.active?.(env.locationId)) legal.push('<a href="#cookie-settings">Cookie-Einstellungen</a>');
  const text = String(f.text || s.footer_text || '');
  const site = s.site_name || env.funnel.name;
  return `<footer class="gf"><div class="gfi">${colsHtml ? `<div class="gfc">${colsHtml}</div>` : ''}<div class="gfb"><p>${text ? miniMarkdown(text, (u) => resolveHref(env, u)).replace(/^<p>|<\/p>$/g, '') : `© ${new Date().getFullYear()} ${escapeHtml(site)}`}</p>${legal.length ? `<nav aria-label="Rechtliches">${legal.join(' · ')}</nav>` : ''}</div></div></footer>`;
}

// --- the page ------------------------------------------------------------------------------------------------------------

/** What the page needs everywhere, always printed (kept small on purpose). */
export const BASE_CSS = `
body{font-family:var(--ff-body);color:var(--text);background:var(--bg);font-size:1rem;line-height:1.55;margin:0;overflow-wrap:break-word}
h1,h2,h3,h4{font-family:var(--ff-head);line-height:1.15;letter-spacing:-.012em;margin:0 0 .5em;hyphens:auto;overflow-wrap:anywhere}h1{font-size:var(--fs-5)}h2{font-size:var(--fs-3)}h3{font-size:var(--fs-2)}h4{font-size:var(--fs-1)}
img{max-width:100%;height:auto}a{color:var(--lk,var(--c-brand))}
.btn,button{background:var(--btn,var(--c-brand));color:var(--btn-fg,var(--c-on-brand));border-radius:var(--r-md);min-height:44px;padding:.65em 1.35em;font-size:1rem;line-height:1.25;display:inline-flex;align-items:center;justify-content:center}.btn:hover,button:hover{filter:brightness(.92)}
.brow{display:flex;gap:12px;flex-wrap:wrap}.btn.secondary{background:transparent;color:var(--btn,var(--c-brand));border:2px solid var(--btn,var(--c-brand))}
:focus-visible{outline:3px solid var(--c-brand-dark);outline-offset:2px}
input,select,textarea{min-height:44px;font-size:1rem}
.blk .in{max-width:860px;margin:0 auto;padding:0 20px}.blk .in.wide{max-width:1100px}
.blk h2{font-size:var(--fs-3)}.muted{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px;text-align:left}
hr{border:0;border-top:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

const emptyRules = () => new Rules();

export function makeEnv(app: App, funnel: any, page: any, o: RenderOpts = {}): BlockEnv {
  let pages: any[] | undefined;
  const reg = siteBlocks(app);
  registerLayout(reg);
  const env: BlockEnv = {
    app,
    funnel,
    page,
    locationId: funnel.location_id,
    tokens: tokensOf(funnel.settings),
    lang: langOf(funnel, page),
    ctx: o.ctx,
    preview: !!o.preview,
    rules: emptyRules(),
    used: new Set(),
    imgs: 0,
    trail: [],
    item: o.item,
    pages: () => (pages ??= o.pages ?? sitePages(app, funnel.id)),
    render: (blocks, opts) => renderBlocks(env, blocks, opts),
  };
  return env;
}

/** Renders one page of a site (also the editor's live preview and CMS detail pages). */
export function renderPage(app: App, funnel: any, page: any, isFirst = false, o: RenderOpts = {}): string {
  const s = funnel.settings ?? {};
  const seo = page.seo ?? {};
  const env = makeEnv(app, funnel, page, o);
  const blocks = Array.isArray(page.blocks) ? (page.blocks as Block[]) : [];
  const main = env.render(blocks);
  const layout = page.layout ?? {};
  const chrome = !o.bare;
  const showHeader = chrome && layout.header !== false && !!s.header?.enabled;
  const showFooter = chrome && layout.footer !== false && !!s.footer?.enabled;
  const here = o.url ?? pageUrl(app, funnel, page, isFirst);
  const head = `${seoHead(app, funnel, page, isFirst, o)}${hreflangLinks(app, funnel, page, env.pages())}${o.head ?? ''}<style>${styles(app, env, s, showHeader || showFooter, main)}</style>${s.favicon ? `<link rel="icon" href="${escapeHtml(safeUrl(s.favicon))}">` : ''}${s.head_code ? `<!--pghl:owner-->${s.head_code}<!--/pghl:owner-->` : ''}`;
  const chat = s.chat_widget ? `<script src="/chat/${encodeURIComponent(funnel.location_id)}/widget.js" async></script>` : '';
  // Without the new footer the older one-line footer text stays as it was.
  const legacyFooter = !showFooter && s.footer_text ? `<footer style="text-align:center;padding:30px;color:var(--muted);font-size:13px">${miniMarkdown(s.footer_text)}</footer>` : '';
  const body = `${chat}${showHeader ? header(env, here) : ''}<main id="main">${main}</main>${showFooter ? footer(env, here) : legacyFooter}`;
  const doc = publicPage({ title: seo.title || page.name, description: seo.description || s.description, body, head, color: env.tokens.colors.brand });
  // The editor's preview cannot run the page's script (the app's policy covers its frames): it shows the page the way scripts leave it – menu folded on phones.
  // The shared page shell's own rules (forms, buttons) are minified like the rest.
  return doc.replace('<html lang="de">', `<html lang="${env.lang}"${o.preview ? ' class="js"' : ''}>`).replace(/<style>([\s\S]*?)<\/style>/, (_m, css) => `<style>${minify(css)}</style>`);
}

/** Tokens, base rules, the CSS of the block types the page uses, its per-element rules – minified, in this order. */
function styles(app: App, env: BlockEnv, s: Record<string, any>, chrome: boolean, mainHtml: string): string {
  const t: Tokens = env.tokens;
  let css = tokensCss(t) + BASE_CSS + blockCss(app, env.used) + (chrome ? CHROME_CSS : '');
  css = minify(css) + minify(env.rules.css());
  if (/\bhd-[dtp]\b/.test(mainHtml)) css += HIDE_CSS;
  // The older free-text font setting still works on top of the token fonts.
  if (s.font) css += `body{font-family:${escapeHtml(String(s.font)).replace(/[;{}]/g, '')}, system-ui, sans-serif}`;
  return css;
}

/** One block on its own (older callers): rendered with the site's tokens but no page around it. */
export function renderBlock(app: App, b: Block, locationId?: string): string {
  const env = makeEnv(app, { location_id: locationId ?? '', settings: {}, slug: '', id: '' }, { id: '', blocks: [] });
  return env.render([b]);
}

