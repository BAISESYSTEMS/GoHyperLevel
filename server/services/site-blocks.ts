import type { App } from '../core/app.js';
import type { Ctx as HttpCtx } from '../core/http.js';
import { num } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { getForm, renderForm } from '../modules/forms.js';
import { cssUrl, videoEmbed } from './markdown.js';
import { resolveHref, safeUrl } from './site-url.js';
import { Rules, cid, colorCss, colorHex, contrast, hideClasses, readableOn, type Tokens } from './site-style.js';

/**
 * Site builder: the blocks of a page and how each one is rendered (the registry `siteBlocks(app)`).
 *
 * A page is a list of blocks. The 14 classic blocks (hero, text, image …) stack full-width as before; a `section` block
 * (services/site-layout.ts) holds rows and columns that carry the same blocks side by side. Modules add block types
 * through the registry (product, CMS collection, component …): `siteBlocks(app).set('product', { type, render, css })`.
 * Everything a block prints is escaped; colours and sizes are validated, so a block can never inject markup or CSS.
 */

export type Block = { id: string; type: string; [k: string]: any };

export { safeUrl };
const clamp = (v: unknown, min: number, max: number, d: number) => Math.min(max, Math.max(min, num(v, d)));

/** **bold**, *italic*, [text](url) and line breaks — enough for page copy without a full editor. */
export function miniMarkdown(s: string, href: (u: string) => string = safeUrl): string {
  return escapeHtml(s ?? '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${escapeHtml(href(u.replace(/&amp;/g, '&')))}">${t}</a>`)
    .split(/\n{2,}/)
    .map((p) => (/^\s*[-•] /.test(p) ? `<ul>${p.split('\n').map((l) => `<li>${l.replace(/^\s*[-•] /, '')}</li>`).join('')}</ul>` : `<p>${p.replace(/\n/g, '<br>')}</p>`))
    .join('');
}

/** What a block renderer gets: the app, the site and page being rendered and the page-wide collectors. */
export interface BlockEnv {
  app: App;
  funnel: any;
  page: any;
  locationId: string;
  tokens: Tokens;
  lang: string;
  /** The visitor's request, when a real page is served (not in the editor preview). */
  ctx?: HttpCtx;
  preview: boolean;
  rules: Rules;
  /** Block types used on the page: only their CSS is printed. */
  used: Set<string>;
  /** Images rendered so far (the first one is the likely largest paint and loads eagerly). */
  imgs: number;
  /** Components being expanded (a component that contains itself is cut off). */
  trail: string[];
  /** The CMS item a dynamic page shows. */
  item?: Record<string, any>;
  pages(): any[];
  render(blocks: Block[], opts?: { bare?: boolean }): string;
}

export interface BlockDef {
  type: string;
  render(env: BlockEnv, b: Block, o: { bare: boolean }): string;
  /** Stylesheet printed once when the page uses the block (written readable, minified when composed). */
  css?: string;
}
export type BlockRegistry = Map<string, BlockDef>;

// --- images ------------------------------------------------------------------------------------------------------

export interface ImgOpts {
  src: string;
  alt?: string;
  w?: number;
  h?: number;
  srcset?: string;
  sizes?: string;
  /** true: above the fold (no lazy loading, high priority); 'auto': no lazy loading, normal priority (the logo); default: the first picture of a page is eager, the rest lazy. */
  eager?: boolean | 'auto';
  /** false: does not count as "the first picture" (header logo). */
  count?: boolean;
  cls?: string;
  style?: string;
}

/** A `srcset` value of `url 480w, url 960w` pairs: only http(s)/relative URLs with a width descriptor. */
export function cleanSrcset(v: unknown): string {
  return String(v ?? '')
    .split(',')
    .map((p) => p.trim().split(/\s+/))
    .filter((p) => p.length === 2 && /^(https?:\/\/|\/)[^\s"'<>]+$/i.test(p[0]) && /^\d{2,5}w$/.test(p[1]))
    .slice(0, 8)
    .map((p) => `${escapeHtml(p[0])} ${p[1]}`)
    .join(', ');
}

/**
 * An <img> that cannot shift the layout: width/height when known (from the block, or the upload's own header via
 * `app.services.siteImages`), `srcset` for phones, lazy loading below the fold, `fetchpriority` for the first picture.
 */
export function imgTag(env: BlockEnv, o: ImgOpts): string {
  const src = safeUrl(o.src);
  if (src === '#') return '';
  const lib = env.app.services.siteImages as { dims?(u: string): { w: number; h: number } | undefined; srcset?(u: string): { srcset: string; sizes?: string } | undefined } | undefined;
  const dims = o.w && o.h ? { w: o.w, h: o.h } : lib?.dims?.(src);
  const auto = !cleanSrcset(o.srcset) ? lib?.srcset?.(src) : undefined;
  const srcset = cleanSrcset(o.srcset) || (auto ? cleanSrcset(auto.srcset) : '');
  const first = env.imgs === 0 && o.eager === undefined;
  if (o.count !== false) env.imgs++;
  const mode = o.eager === 'auto' ? 'auto' : (o.eager ?? first) ? 'high' : 'lazy';
  return `<img src="${escapeHtml(src)}"${srcset ? ` srcset="${srcset}" sizes="${escapeHtml(String(o.sizes || auto?.sizes || '(max-width:700px) 100vw, 860px').replace(/[^\w\s()%,.:-]/g, ''))}"` : ''} alt="${escapeHtml(o.alt ?? '')}"${dims ? ` width="${Math.round(dims.w)}" height="${Math.round(dims.h)}"` : ''}${mode === 'high' ? ' fetchpriority="high"' : mode === 'lazy' ? ' loading="lazy"' : ''} decoding="async"${o.cls ? ` class="${escapeHtml(o.cls)}"` : ''}${o.style ? ` style="${escapeHtml(o.style)}"` : ''}>`;
}

// --- wrapper and shared style props ---------------------------------------------------------------------------------------

const ALIGN = ['left', 'center', 'right'];
const anchorOf = (v: unknown) => {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,39}$/.test(s) ? s : '';
};

/** Font-size overrides per breakpoint (percent of the surrounding text); returns the class to put on the element. */
export function fsClass(env: BlockEnv, id: unknown, fs: unknown): string {
  const o = (fs && typeof fs === 'object' ? fs : {}) as Record<string, unknown>;
  const c = cid(id);
  let any = false;
  for (const bp of ['desktop', 'tablet', 'phone'] as const) {
    const n = Number(o[bp]);
    if (!Number.isFinite(n) || n < 50 || n > 220 || n === 100) continue;
    env.rules.add(bp, `.${c}.fz{font-size:${Math.round(n)}%}`);
    any = true;
  }
  return any ? `${c} fz` : '';
}

/**
 * Buttons and links on a coloured background: when the brand colour would disappear on it, they switch to the colour the text uses
 * (a white button with brand-coloured text on a brand section). Returns inline custom properties.
 */
export function onBg(env: BlockEnv, bg: unknown): string {
  const hex = colorHex(bg, env.tokens);
  if (!hex) return '';
  const brand = env.tokens.colors.brand;
  if (contrast(brand, hex) >= 3) return '';
  const fg = readableOn(hex);
  return `--btn:${fg};--btn-fg:${hex};--lk:${fg}`;
}

/** The shared look of a block: background, text colour, alignment, radius, shadow, visibility, font size, anchor. */
export function styleOf(env: BlockEnv, b: Block, bare: boolean): { style: string; cls: string; id: string } {
  const st: string[] = [];
  const bg = colorCss(b.bg);
  const col = colorCss(b.color);
  if (bg) st.push(`background:${bg}`);
  const vars = onBg(env, b.bg);
  if (vars) st.push(vars);
  // No text colour chosen: white or near-black by what the background needs (a dark block never has dark text).
  const hex = !col ? colorHex(b.bg, env.tokens) : '';
  if (col) st.push(`color:${col}`);
  else if (hex) st.push(`color:${readableOn(hex)}`);
  if (ALIGN.includes(b.align)) st.push(`text-align:${b.align}`);
  if (bare) {
    if (b.padding !== undefined && b.padding !== '') st.push(`padding:${clamp(b.padding, 0, 200, 0)}px`);
  } else st.push(`padding:${clamp(b.padding, 0, 200, 48)}px 0`);
  if (b.radius !== undefined && b.radius !== '') st.push(`border-radius:${clamp(b.radius, 0, 64, 0)}px`);
  if (['sm', 'md', 'lg'].includes(b.shadow)) st.push(`box-shadow:var(--sh-${b.shadow})`);
  const cls = [hideClasses(b.hide), fsClass(env, b.id, b.fs)].filter(Boolean).join(' ');
  const a = anchorOf(b.anchor);
  return { style: st.join(';'), cls, id: a };
}

/** The classic wrapper: a full-width <section> with a centred column – or, inside a column, a plain <div>. */
export function wrap(env: BlockEnv, b: Block, bare: boolean, content: string, o: { wide?: boolean; cls?: string } = {}): string {
  const s = styleOf(env, b, bare);
  const cls = ['blk', `blk-${String(b.type).replace(/[^a-z0-9_-]/gi, '')}`, o.cls, s.cls].filter(Boolean).join(' ');
  const attrs = `class="${cls}"${s.id ? ` id="${s.id}"` : ''}${s.style ? ` style="${escapeHtml(s.style)}"` : ''}`;
  if (bare) return `<div ${attrs}>${content}</div>`;
  return `<section ${attrs}><div class="in${o.wide ? ' wide' : ''}">${content}</div></section>`;
}

const btn = (env: BlockEnv, text: string, url: string, cls = '') => (text ? `<a class="btn${cls ? ` ${cls}` : ''}" href="${escapeHtml(resolveHref(env, url))}">${escapeHtml(text)}</a>` : '');
const heading2 = (t: unknown) => (t ? `<h2>${escapeHtml(String(t))}</h2>` : '');

// --- the classic blocks -----------------------------------------------------------------------------------------------

const list = (v: unknown, max = 60): any[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, max) : []);

const CORE: BlockDef[] = [
  {
    type: 'hero',
    css: `.hero h1{font-size:var(--fs-5);margin:0 0 .35em}.hero .lead{font-size:var(--fs-1);opacity:.85;margin:0 0 1.3em}.hero-img{max-width:100%;height:auto;border-radius:var(--r-lg);margin-bottom:1.4em}`,
    render: (env, b, o) =>
      wrap(env, b, o.bare, `<div class="hero">${b.image ? imgTag(env, { src: b.image, alt: b.image_alt ?? '', w: num(b.image_w, 0) || undefined, h: num(b.image_h, 0) || undefined, srcset: b.image_srcset, cls: 'hero-img', sizes: '(max-width:700px) 100vw, 860px' }) : ''}<h1>${escapeHtml(b.heading ?? '')}</h1>${b.subheading ? `<p class="lead">${escapeHtml(b.subheading)}</p>` : ''}${btn(env, b.button_text, b.button_url)}</div>`),
  },
  {
    type: 'heading',
    render: (env, b, o) => {
      const lvl = [1, 2, 3].includes(Number(b.level)) ? Number(b.level) : 2;
      return wrap(env, b, o.bare, `<h${lvl}>${escapeHtml(b.text ?? '')}</h${lvl}>`);
    },
  },
  { type: 'text', css: `.prose{font-size:1.05em}.prose p{margin:0 0 .85em}.prose ul{padding-left:1.2em}.prose a{text-decoration:underline;text-underline-offset:2px}`, render: (env, b, o) => wrap(env, b, o.bare, `<div class="prose">${miniMarkdown(b.text ?? '', (u) => resolveHref(env, u))}</div>`) },
  {
    type: 'image',
    render: (env, b, o) => {
      const img = imgTag(env, { src: b.src, alt: b.alt ?? '', w: num(b.w, 0) || undefined, h: num(b.h, 0) || undefined, srcset: b.srcset, style: `max-width:${clamp(b.width, 1, 100, 100)}%;height:auto;border-radius:var(--r-md)` });
      return img ? wrap(env, b, o.bare, img) : env.preview ? wrap(env, b, o.bare, '<p class="muted">Bild fehlt</p>') : '';
    },
  },
  {
    type: 'button',
    render: (env, b, o) => {
      // An optional second, quieter button next to the first (text2/url2).
      const second = b.text2 ? btn(env, b.text2, b.url2, 'secondary') : '';
      const just = b.align === 'center' ? 'center' : b.align === 'right' ? 'flex-end' : 'flex-start';
      return wrap(env, b, o.bare, second ? `<div class="brow" style="justify-content:${just}">${btn(env, b.text || 'Jetzt starten', b.url)}${second}</div>` : btn(env, b.text || 'Jetzt starten', b.url));
    },
  },
  {
    type: 'video',
    css: `.video{position:relative;aspect-ratio:16/9;background:#000;border-radius:var(--r-md);overflow:hidden}.video iframe,.video video{position:absolute;inset:0;width:100%;height:100%;border:0}`,
    render: (env, b, o) => {
      const e = videoEmbed(b.url);
      if (e?.kind === 'iframe') e.src = e.src.replace(/\?rel=0$/, '');
      const title = escapeHtml(String(b.title || 'Video'));
      const inner = e
        ? e.kind === 'iframe'
          ? `<div class="video"><iframe src="${escapeHtml(e.src)}" title="${title}" loading="lazy" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`
          : `<div class="video"><video src="${escapeHtml(e.src)}" controls preload="metadata" playsinline aria-label="${title}"></video></div>`
        : '<p class="muted">Video-URL fehlt</p>';
      return wrap(env, b, o.bare, inner);
    },
  },
  {
    type: 'form',
    css: `.form-card{text-align:left;max-width:560px;margin:0 auto;padding:1.4em;background:var(--c-bg);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--sh-sm)}`,
    render: (env, b, o) => {
      const found = b.form_id ? getForm(env.app, b.form_id) : undefined;
      // A page only ever shows forms of its own sub-account.
      const f = found && (!env.locationId || found.location_id === env.locationId) ? found : undefined;
      // In the editor and in template previews a block without a form shows how it will look (a form that does nothing).
      if (!f && env.preview && !b.form_id) {
        const k = cid(b.id);
        return wrap(env, b, o.bare, `<div class="card form-card">${b.heading ? `<h2>${escapeHtml(b.heading)}</h2>` : ''}<form onsubmit="return false" aria-label="Beispiel-Formular"><label for="${k}n">Vorname</label><input id="${k}n" type="text" autocomplete="given-name"><label for="${k}e">E-Mail</label><input id="${k}e" type="email" autocomplete="email"><p style="margin:16px 0 0"><button type="button">Absenden</button></p></form><p class="muted" style="font-size:.8em;margin:.8em 0 0">Vorschau – hier erscheint dein Formular.</p></div>`);
      }
      return wrap(env, b, o.bare, f ? `<div class="card form-card">${b.heading ? `<h2>${escapeHtml(b.heading)}</h2>` : ''}${renderForm(f)}</div>` : env.preview ? '<p class="muted">Formular wählen</p>' : '');
    },
  },
  {
    type: 'calendar',
    render: (env, b, o) =>
      wrap(env, b, o.bare, b.calendar_slug ? `<iframe src="/book/${encodeURIComponent(b.calendar_slug)}?embed=1" title="${escapeHtml(String(b.title || 'Terminbuchung'))}" loading="lazy" style="width:100%;min-height:720px;border:0"></iframe>` : env.preview ? `<div class="card" style="min-height:300px;display:grid;place-items:center;text-align:center"><p class="muted">Vorschau – hier erscheint dein Terminkalender.</p></div>` : '', { wide: true }),
  },
  {
    type: 'features',
    css: `.feat{background:var(--c-surface);border-radius:var(--r-md);padding:1.1em 1.2em}.feat .icon{font-size:1.7em;line-height:1}.feat h3{margin:.4em 0 .25em;font-size:var(--fs-1)}.feat p{margin:0}`,
    render: (env, b, o) =>
      wrap(env, b, o.bare, `${heading2(b.heading)}<div class="grid">${list(b.items)
        .map((it) => `<div class="feat"><div class="icon" aria-hidden="true">${escapeHtml(it.icon ?? '✓')}</div><h3>${escapeHtml(it.title ?? '')}</h3><p>${escapeHtml(it.text ?? '')}</p></div>`)
        .join('')}</div>`, { wide: true }),
  },
  {
    type: 'testimonial',
    css: `blockquote{font-size:var(--fs-1);font-style:italic;margin:0}blockquote footer{font-size:.8em;font-style:normal;color:var(--muted);margin-top:.6em}`,
    render: (env, b, o) => wrap(env, b, o.bare, `<blockquote>“${escapeHtml(b.quote ?? '')}”<footer>— ${escapeHtml(b.author ?? '')}</footer></blockquote>`),
  },
  {
    type: 'faq',
    css: `details{border:1px solid var(--line);border-radius:var(--r-md);padding:.85em 1.1em;margin:.6em 0;text-align:left;background:var(--c-bg)}summary{font-weight:600;cursor:pointer;min-height:24px}details[open] summary{margin-bottom:.5em}details p{margin:0 0 .6em}`,
    render: (env, b, o) => wrap(env, b, o.bare, `${heading2(b.heading)}${list(b.items).map((it) => `<details><summary>${escapeHtml(it.q ?? '')}</summary><div>${miniMarkdown(it.a ?? '', (u) => resolveHref(env, u))}</div></details>`).join('')}`),
  },
  {
    type: 'pricing',
    css: `.price{padding:1.3em;background:var(--c-bg);border:1px solid var(--line);border-radius:var(--r-md);box-shadow:var(--sh-sm)}.price h3{margin:0}.price .amount{font-size:var(--fs-3);font-weight:700;margin:.2em 0 .4em}.price ul{padding-left:1.1em}`,
    render: (env, b, o) =>
      wrap(env, b, o.bare, `${heading2(b.heading)}<div class="grid">${list(b.items)
        .map(
          (it) =>
            `<div class="price card"><h3>${escapeHtml(it.name ?? '')}</h3><div class="amount">${escapeHtml(it.price ?? '')}</div><ul>${String(it.features ?? '')
              .split('\n')
              .filter(Boolean)
              .map((l) => `<li>${escapeHtml(l)}</li>`)
              .join('')}</ul>${btn(env, it.button_text, it.button_url)}</div>`,
        )
        .join('')}</div>`, { wide: true }),
  },
  {
    type: 'countdown',
    css: `.countdown{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}.countdown div{background:var(--c-brand);color:var(--c-on-brand);border-radius:var(--r-md);padding:.6em .8em;min-width:4.4em;text-align:center}.countdown b{display:block;font-size:1.7em}.countdown span{font-size:.75em;opacity:.9}`,
    render: (env, b, o) => {
      const until = new Date(b.until ?? '').getTime();
      if (!until) return wrap(env, b, o.bare, '<p class="muted">Enddatum fehlt</p>');
      const c = `cd_${String(b.id).replace(/[^A-Za-z0-9_]/g, '')}`;
      return wrap(
        env,
        b,
        o.bare,
        `<div class="countdown" id="${c}" role="timer" aria-label="Countdown"></div><script>(function(){const e=document.getElementById('${c}'),u=${until};function t(){let s=Math.max(0,Math.floor((u-Date.now())/1000));const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);s%=60;e.innerHTML=[[d,'Tage'],[h,'Std'],[m,'Min'],[s,'Sek']].map(([v,l])=>'<div><b>'+String(v).padStart(2,'0')+'</b><span>'+l+'</span></div>').join('')}t();setInterval(t,1000)})()</script>`,
      );
    },
  },
  { type: 'divider', render: (env, b, o) => wrap(env, b, o.bare, '<hr>') },
  {
    type: 'spacer',
    render: (env, b) => {
      const cls = [hideClasses(b.hide)].filter(Boolean).join(' ');
      return `<div${cls ? ` class="${cls}"` : ''} style="height:${clamp(b.height, 0, 400, 40)}px" aria-hidden="true"></div>`;
    },
  },
  {
    type: 'html',
    // Written by the account owner in the builder (tracking pixels, embeds): trusted on purpose. The consent banner finds it by this exact wrapper.
    render: (_env, b) => `<section class="blk blk-html">${String(b.html ?? '')}</section>`,
  },

  // --- newer content blocks ---------------------------------------------------------------------------------------
  {
    type: 'logos',
    css: `.logos{display:flex;flex-wrap:wrap;gap:18px 34px;justify-content:center;align-items:center}.logos img{height:40px;width:auto;max-width:150px;object-fit:contain}.logos.gray img{filter:grayscale(1);opacity:.7}.logos p.t{width:100%;margin:0;color:var(--muted);font-size:.9em;text-align:center}`,
    render: (env, b, o) =>
      wrap(
        env,
        b,
        o.bare,
        `<div class="logos${b.grayscale ? ' gray' : ''}">${b.heading ? `<p class="t">${escapeHtml(b.heading)}</p>` : ''}${list(b.items, 16)
          .map((it) => {
            const img = imgTag(env, { src: it.src, alt: it.alt ?? '', w: num(it.w, 0) || undefined, h: num(it.h, 0) || undefined, eager: false });
            return it.url && img ? `<a href="${escapeHtml(resolveHref(env, it.url))}" aria-label="${escapeHtml(it.alt || 'Zur Website')}">${img}</a>` : img;
          })
          .join('')}</div>`,
        { wide: true },
      ),
  },
  {
    type: 'stats',
    css: `.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:18px;text-align:center}.stats b{display:block;font-size:var(--fs-4);line-height:1.1;color:var(--c-brand);font-family:var(--ff-head)}.stats span{color:var(--muted)}`,
    render: (env, b, o) =>
      wrap(env, b, o.bare, `${heading2(b.heading)}<div class="stats">${list(b.items, 8).map((it) => `<div><b>${escapeHtml(it.value ?? '')}</b><span>${escapeHtml(it.label ?? '')}</span></div>`).join('')}</div>`, { wide: true }),
  },
  {
    type: 'steps',
    css: `.steps{list-style:none;counter-reset:s;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;text-align:left}.steps li{counter-increment:s;position:relative;padding-top:3em}.steps li::before{content:counter(s);position:absolute;top:0;left:0;width:2.3em;height:2.3em;border-radius:50%;background:var(--c-brand);color:var(--c-on-brand);display:grid;place-items:center;font-weight:700}.steps h3{margin:0 0 .2em;font-size:var(--fs-1)}.steps p{margin:0}`,
    render: (env, b, o) =>
      wrap(env, b, o.bare, `${heading2(b.heading)}<ol class="steps">${list(b.items, 8).map((it) => `<li><h3>${escapeHtml(it.title ?? '')}</h3><p>${escapeHtml(it.text ?? '')}</p></li>`).join('')}</ol>`, { wide: true }),
  },
  {
    type: 'gallery',
    css: `.gal{display:grid;gap:12px;grid-template-columns:repeat(var(--gc,3),minmax(0,1fr))}.gal img{width:100%;height:auto;border-radius:var(--r-md);display:block;aspect-ratio:4/3;object-fit:cover}@media (max-width:640px){.gal{grid-template-columns:repeat(2,minmax(0,1fr))}}`,
    render: (env, b, o) =>
      wrap(
        env,
        b,
        o.bare,
        `${heading2(b.heading)}<div class="gal" style="--gc:${Math.round(clamp(b.columns, 2, 4, 3))}">${list(b.items, 24)
          .map((it) => imgTag(env, { src: it.src, alt: it.alt ?? '', w: num(it.w, 0) || undefined, h: num(it.h, 0) || undefined, srcset: it.srcset, sizes: '(max-width:640px) 50vw, 360px' }))
          .join('')}</div>`,
        { wide: true },
      ),
  },
  {
    type: 'cta',
    css: `.cta{padding:2.2em 1.4em;border-radius:var(--r-lg);text-align:center;background:var(--c-brand);color:var(--c-on-brand)}.cta.dark{background:#111827;color:#fff}.cta.light{background:var(--c-surface);color:var(--text)}.cta h2{margin:0 0 .3em}.cta p{margin:0 0 1.2em;opacity:.92}.cta .btn{background:#fff;color:#111827}.cta.light .btn{background:var(--c-brand);color:var(--c-on-brand)}.cta .btn.secondary{background:transparent;color:inherit;border:2px solid currentColor}.cta .row2{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}`,
    render: (env, b, o) =>
      wrap(env, b, o.bare, `<div class="cta${['dark', 'light'].includes(b.style) ? ` ${b.style}` : ''}"><h2>${escapeHtml(b.heading ?? '')}</h2>${b.text ? `<p>${escapeHtml(b.text)}</p>` : ''}<div class="row2">${btn(env, b.button_text, b.button_url)}${btn(env, b.button2_text, b.button2_url, 'secondary')}</div></div>`),
  },
];

/** The registry of this app, created on first use with the built-in blocks; modules add their own types. */
export function siteBlocks(app: App): BlockRegistry {
  if (!app.services.siteBlocks) app.services.siteBlocks = new Map<string, BlockDef>(CORE.map((d) => [d.type, d]));
  return app.services.siteBlocks as BlockRegistry;
}

/** Renders a list of blocks; one broken block never takes the page down. */
export function renderBlocks(env: BlockEnv, blocks: Block[], o: { bare?: boolean } = {}): string {
  const reg = siteBlocks(env.app);
  let out = '';
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const def = b && typeof b === 'object' ? reg.get(String(b.type)) : undefined;
    if (!def) continue;
    // `component` placeholders and sections need the page-wide collectors, so the used flag is set before rendering.
    env.used.add(def.type);
    try {
      out += def.render(env, b, { bare: !!o.bare });
    } catch (e) {
      console.error(`[site] Block „${def.type}“:`, (e as Error).message);
    }
  }
  return out;
}

/** The stylesheet of the block types a page used (each type once), readable – the caller minifies. */
export function blockCss(app: App, used: Set<string>): string {
  const reg = siteBlocks(app);
  let css = '';
  for (const t of used) css += reg.get(t)?.css ?? '';
  return css;
}

export const BG_URL = (u: unknown) => `url('${cssUrl(u)}')`;
