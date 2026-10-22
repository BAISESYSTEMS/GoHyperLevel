import type { App, LocationRow } from '../core/app.js';
import { html, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney } from '../core/util.js';
import { cssUrl, embedHtml, excerptOf, renderMarkdown, stripMarkdown, videoEmbed } from './markdown.js';
import { billingsOf, priceText, type Billing, type PageRow, type Question, type Tier, type TierPrices } from './community-tiers.js';

/**
 * Server-rendered public pages of a community: the About page (/c/<slug>), the join form, the answers after joining and the
 * Discovery page (/communities). No script runs on them except one small file of ours; everything the visitor typed is escaped.
 */

export interface PublicBrand {
  name: string;
  color: string;
  logo: string;
  favicon: string;
}

export function publicBrand(loc: LocationRow): PublicBrand {
  const b = loc.settings?.branding ?? {};
  const color = /^#[0-9a-f]{6}$/i.test(String(b.color ?? '')) ? String(b.color) : '#2563eb';
  return { name: String(b.name || loc.name), color, logo: String(b.logo_url || loc.logo_url || ''), favicon: String(b.favicon_url || '') };
}

const CSS = `
:root{--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f6f7fb;--panel:#fff;--ok:#059669;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--text:#e5e7eb;--muted:#94a3b8;--line:#1e293b;--bg:#0b1020;--panel:#111a2e;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);background:var(--bg)}
a{color:var(--brand)}
.top{background:var(--panel);border-bottom:1px solid var(--line)}
.top .in{max-width:1120px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:14px;min-height:60px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;color:inherit;text-decoration:none;min-width:0}
.brand>span:last-child:not(.mark){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand img{max-height:36px;max-width:170px;object-fit:contain}
.brand .mark{width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center;flex:none}
.nav{margin-left:auto;display:flex;gap:6px;align-items:center}
.nav a{color:var(--muted);text-decoration:none;padding:10px 12px;border-radius:10px;font-weight:600;font-size:15px;min-height:44px;display:inline-flex;align-items:center}
.nav a:hover,.nav a:focus-visible{color:var(--text);background:var(--soft)}
main{max-width:1120px;margin:0 auto;padding:28px 20px 72px}
h1{font-size:clamp(26px,3.6vw,38px);line-height:1.15;margin:0 0 8px;letter-spacing:-.015em}
h2{font-size:21px;margin:30px 0 12px}
.muted{color:var(--muted)}.small{font-size:14px}
.hero{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:32px;align-items:start}
.media{aspect-ratio:16/9;border-radius:20px;overflow:hidden;background:linear-gradient(135deg,var(--brand),#0f172a) center/cover no-repeat;display:grid;place-items:center;color:rgba(255,255,255,.9);font-size:64px;font-weight:800;margin:18px 0 6px;position:relative}
.media .md-video{position:absolute;inset:0;padding:0;margin:0;border-radius:0}
.md-video{position:relative;padding-top:56.25%;overflow:hidden;background:#000}
.md-video iframe,.md-video video{position:absolute;inset:0;width:100%;height:100%;border:0}
.tagline{font-size:18px;color:var(--muted);margin:0}
.stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:15px;margin-top:10px}
.stats b{color:var(--text)}
.prose{font-size:17px}.prose>:first-child{margin-top:0}
.prose h2{font-size:23px;margin:26px 0 10px}.prose h3{font-size:19px;margin:20px 0 8px}
.prose img{max-width:100%;height:auto;border-radius:12px}
.prose blockquote{margin:16px 0;padding:4px 18px;border-left:4px solid var(--brand);background:var(--soft);border-radius:0 10px 10px 0}
.buy{position:sticky;top:20px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:22px;box-shadow:0 10px 34px rgba(15,23,42,.07)}
.buy h3{margin:0 0 4px;font-size:19px}
.price{font-size:30px;font-weight:800;margin:8px 0 0;letter-spacing:-.01em}.price small{font-size:15px;font-weight:600;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--brand);color:#fff;border:0;border-radius:12px;padding:13px 20px;font:inherit;font-weight:700;cursor:pointer;text-decoration:none;min-height:48px;text-align:center}
.btn:hover{filter:brightness(1.07)}.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:3px solid var(--brand);outline-offset:2px}
.btn.wide{width:100%}.btn.ghost{background:var(--panel);color:var(--text);border:1px solid var(--line)}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}
.tier{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:6px}
.tier.hl{border:2px solid var(--brand)}.tier h3{margin:0;font-size:18px}
.tier ul{margin:6px 0 0;padding:0;list-style:none;font-size:15px}.tier li{padding:3px 0 3px 22px;position:relative}
.tier li:before{content:"✓";position:absolute;left:0;color:var(--ok);font-weight:800}
.pill{display:inline-flex;align-items:center;font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;background:var(--soft);color:var(--brand)}
.admins{display:flex;gap:14px;flex-wrap:wrap}.admin{display:flex;gap:10px;align-items:center}
.av{width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--brand);color:#fff;display:inline-grid;place-items:center;font-weight:700}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:26px}
form.join{max-width:640px;margin:0 auto}
label.f{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}
input.t,select.t,textarea.t{width:100%;padding:13px 14px;border:1px solid var(--line);border-radius:12px;font:inherit;font-size:16px;background:var(--panel);color:var(--text);min-height:48px}
textarea.t{min-height:90px;resize:vertical}
.opt{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px;background:var(--panel);cursor:pointer;min-height:48px}
.opt:has(input:checked){border-color:var(--brand);box-shadow:0 0 0 1px var(--brand) inset;background:var(--soft)}
.opt input{margin-top:4px;width:20px;height:20px;flex:none;accent-color:var(--brand)}
.opt .b{flex:1;min-width:0}.opt .p{font-weight:800;white-space:nowrap}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px;margin:12px 0;color:var(--muted)}.check input{margin-top:3px;width:20px;height:20px;flex:none;accent-color:var(--brand)}
.err{background:rgba(220,38,38,.1);color:#dc2626;padding:12px 16px;border-radius:12px;margin:0 0 18px;font-weight:600}
.ok{background:rgba(5,150,105,.12);color:var(--ok);padding:12px 16px;border-radius:12px;font-weight:600}
.center{text-align:center;max-width:560px;margin:40px auto}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;overflow:hidden;text-decoration:none;color:inherit;display:flex;flex-direction:column;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-2px);box-shadow:0 14px 34px rgba(15,23,42,.1)}
.card .cv{aspect-ratio:16/9;background:linear-gradient(135deg,var(--c,#2563eb),#0f172a) center/cover no-repeat;display:grid;place-items:center;color:rgba(255,255,255,.92);font-size:44px;font-weight:800}
.card .bd{padding:16px 18px 18px;display:flex;flex-direction:column;gap:6px;flex:1}.card h3{margin:0;font-size:18px}
.filters{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 22px}.filters .t{max-width:320px}
.foot{margin-top:46px;text-align:center;color:var(--muted);font-size:13px}
@media (max-width:900px){.hero{grid-template-columns:1fr}.buy{position:static;order:-1}}
@media (max-width:560px){main{padding:18px 14px 56px}.media{border-radius:14px}.top .in{padding:8px 14px;gap:8px}.nav{flex:none;gap:0}.nav a{padding:10px 9px;font-size:14px;white-space:nowrap}.opt{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:12px;row-gap:4px}.opt .p{grid-column:2}}
@media (min-aspect-ratio:21/9) and (min-width:1800px){main,.top .in{max-width:1500px}.hero{grid-template-columns:minmax(0,1fr) 440px}}
`;

export interface LayoutOpts {
  title: string;
  description?: string;
  canonical?: string;
  image?: string;
  robots?: string;
  jsonld?: unknown;
  body: string;
  status?: number;
  /** The small script of the join form. */
  script?: boolean;
  navLinks?: [string, string][];
  head?: string;
}

/** The common frame: brand header, theme colour, SEO tags, strict CSP. */
export function layout(app: App, loc: LocationRow, o: LayoutOpts): RawResult {
  const b = publicBrand(loc);
  const mark = b.logo ? `<img src="${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)}">` : `<span class="mark">${escapeHtml(b.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(b.name)}</span>`;
  const desc = o.description ? escapeHtml(excerptOf(o.description, 160)) : '';
  const abs = (u: string) => (/^https?:\/\//i.test(u) ? u : u ? `${app.baseUrl()}${u.startsWith('/') ? '' : '/'}${u}` : '');
  const og = [
    ['og:type', 'website'],
    ['og:title', o.title],
    ...(desc ? [['og:description', excerptOf(o.description!, 160)]] : []),
    ...(o.canonical ? [['og:url', o.canonical]] : []),
    ['og:site_name', b.name],
    ...(o.image ? [['og:image', abs(o.image)]] : []),
  ];
  const doc = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
${desc ? `<meta name="description" content="${desc}">` : ''}
<meta name="robots" content="${escapeHtml(o.robots ?? 'index, follow')}"><meta name="theme-color" content="${b.color}"><meta name="referrer" content="strict-origin-when-cross-origin">
${o.canonical ? `<link rel="canonical" href="${escapeHtml(o.canonical)}">` : ''}
${b.favicon ? `<link rel="icon" href="${escapeHtml(b.favicon)}">` : ''}
${og.map(([k, v]) => `<meta property="${k}" content="${escapeHtml(String(v))}">`).join('\n')}
<meta name="twitter:card" content="${o.image ? 'summary_large_image' : 'summary'}">
${o.jsonld ? `<script type="application/ld+json">${JSON.stringify(o.jsonld).replace(/</g, '\\u003c')}</script>` : ''}
<style>:root{--brand:${b.color};--soft:${b.color}1f}@media (prefers-color-scheme:dark){:root{--soft:${b.color}33}}${CSS}</style>${o.head ?? ''}</head>
<body><header class="top"><div class="in"><a class="brand" href="/">${mark}</a><nav class="nav" aria-label="Hauptmenü">${(o.navLinks ?? []).map(([href, label]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`).join('')}</nav></div></header>
<main>${o.body}</main>${o.script ? '<script src="/community-join.js" defer></script>' : ''}</body></html>`;
  const r = html(doc, o.status ?? 200);
  Object.assign(r.headers, {
    'cache-control': 'private, no-cache',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; img-src * data:; media-src https: blob:; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  return r;
}

// --- About page -----------------------------------------------------------------------------------------------------

export interface TierView {
  tier: Tier;
  prices: TierPrices;
}

export interface AboutData {
  g: { id: string; name: string; slug: string; description: string; cover_image: string };
  page: PageRow;
  tiers: TierView[];
  members: number;
  admins: { name: string; avatar: string; headline: string }[];
  joinUrl: string;
  loginUrl: string;
  discoverUrl: string;
  canonical: string;
  invite?: string;
}

const initials = (n: string) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export function priceLines(v: TierView): string[] {
  const p = v.prices;
  if (p.free) return ['Kostenlos'];
  return (['month', 'year', 'once'] as const).filter((b) => p[b]).map((b) => priceText(p[b]!));
}

const fromPrice = (views: TierView[]): string => {
  const all = views.flatMap((v) => (v.prices.free ? [{ cents: 0, text: 'Kostenlos' }] : (['month', 'year', 'once'] as const).filter((b) => v.prices[b]).map((b) => ({ cents: v.prices[b]!.gross_cents / (b === 'year' ? 12 : 1), text: priceText(v.prices[b]!) }))));
  if (!all.length) return 'Kostenlos';
  const min = all.sort((a, b) => a.cents - b.cents)[0];
  return views.length > 1 && min.cents > 0 ? `ab ${min.text}` : min.text;
};

export const joinLabel = (page: PageRow, views: TierView[]) => (page.approval ? 'Beitritt anfragen' : views.every((v) => v.prices.free) ? 'Kostenlos beitreten' : 'Jetzt beitreten');

export function aboutHtml(app: App, loc: LocationRow, d: AboutData): RawResult {
  const { g, page, tiers } = d;
  const cover = page.cover_image || g.cover_image;
  const embed = page.video_url ? videoEmbed(page.video_url) : null;
  const media = embed ? `<div class="media">${embedHtml(embed, g.name)}</div>` : `<div class="media"${cover ? ` style="background-image:url('${cssUrl(cover)}')"` : ''}>${cover ? '' : escapeHtml(g.name.slice(0, 1).toUpperCase())}</div>`;
  const desc = page.seo_description || stripMarkdown(page.about) || page.tagline || stripMarkdown(g.description);
  const trial = tiers.map((v) => v.tier.trial_days).filter((n) => n > 0);
  const stats = [
    page.show_member_count ? `<span><b>${d.members}</b> ${d.members === 1 ? 'Mitglied' : 'Mitglieder'}</span>` : '',
    `<span>${tiers.every((v) => v.prices.free) ? 'Kostenlos' : escapeHtml(fromPrice(tiers))}</span>`,
    trial.length ? `<span>${Math.max(...trial)} Tage kostenlos testen</span>` : '',
    page.approval ? '<span>Beitritt nach Freigabe</span>' : '',
  ].filter(Boolean);
  const tierCards = tiers.length > 1
    ? `<h2>Mitgliedschaften</h2><div class="tiers">${tiers
        .map((v) => `<div class="tier${v.tier.highlight ? ' hl' : ''}"><h3>${escapeHtml(v.tier.name)}${v.tier.highlight ? ' <span class="pill">Beliebt</span>' : ''}</h3>${v.tier.description ? `<p class="muted small" style="margin:0">${escapeHtml(v.tier.description)}</p>` : ''}${priceLines(v).map((l, i) => `<div class="${i ? 'muted small' : 'price'}">${escapeHtml(l)}</div>`).join('')}${v.tier.trial_days ? `<div class="small" style="color:var(--ok);font-weight:600">${v.tier.trial_days} Tage kostenlos testen</div>` : ''}${v.tier.features.length ? `<ul>${v.tier.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}<a class="btn ${v.tier.highlight ? '' : 'ghost'} wide" style="margin-top:auto" href="${escapeHtml(d.joinUrl)}${d.joinUrl.includes('?') ? '&' : '?'}tier=${encodeURIComponent(v.tier.id)}">Wählen</a></div>`)
        .join('')}</div>`
    : '';
  const one = tiers[0];
  const cta = `<aside class="buy"><h3>${escapeHtml(g.name)}</h3>${tiers.length === 1 && one ? `${priceLines(one).map((l, i) => `<div class="${i ? 'muted small' : 'price'}">${escapeHtml(l)}</div>`).join('')}${one.tier.trial_days ? `<p class="small" style="color:var(--ok);font-weight:600;margin:6px 0 0">${one.tier.trial_days} Tage kostenlos testen</p>` : ''}${one.tier.features.length ? `<ul class="small" style="padding-left:18px;margin:12px 0">${one.tier.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}` : `<div class="price"><small>${escapeHtml(fromPrice(tiers))}</small></div><p class="muted small">Wähle unten oder im nächsten Schritt deine Mitgliedschaft.</p>`}
<p style="margin:16px 0 0"><a class="btn wide" href="${escapeHtml(d.joinUrl)}">${escapeHtml(joinLabel(page, tiers))}</a></p>
<p class="muted small" style="text-align:center;margin:12px 0 0">Schon dabei? <a href="${escapeHtml(d.loginUrl)}">Anmelden</a></p></aside>`;
  const admins = page.show_admins && d.admins.length ? `<h2>Das Team</h2><div class="admins">${d.admins.map((a) => `<div class="admin">${a.avatar ? `<img class="av" src="${escapeHtml(a.avatar)}" alt="">` : `<span class="av" aria-hidden="true">${escapeHtml(initials(a.name))}</span>`}<div><strong>${escapeHtml(a.name)}</strong>${a.headline ? `<div class="muted small">${escapeHtml(a.headline)}</div>` : ''}</div></div>`).join('')}</div>` : '';
  const body = `<div class="hero"><section><h1>${escapeHtml(g.name)}</h1>${page.tagline ? `<p class="tagline">${escapeHtml(page.tagline)}</p>` : ''}${media}<div class="stats">${stats.join('')}</div>
${page.about ? `<h2>Worum es geht</h2><div class="prose">${renderMarkdown(page.about, { embeds: true })}</div>` : g.description ? `<h2>Worum es geht</h2><div class="prose">${renderMarkdown(g.description)}</div>` : ''}${tierCards}${admins}</section>${cta}</div>
<p class="foot"><a href="${escapeHtml(d.discoverUrl)}">Weitere Communities entdecken</a></p>`;
  const offers = tiers.flatMap((v) =>
    (['month', 'year', 'once'] as const).filter((b) => v.prices[b]).map((b) => ({ '@type': 'Offer', name: v.tier.name, price: (v.prices[b]!.gross_cents / 100).toFixed(2), priceCurrency: v.prices[b]!.currency, url: d.joinUrl })),
  );
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: g.name,
    description: excerptOf(desc, 300),
    ...(cover ? { image: cover.startsWith('/') ? `${app.baseUrl()}${cover}` : cover } : {}),
    brand: { '@type': 'Brand', name: publicBrand(loc).name },
    ...(offers.length ? { offers } : { offers: { '@type': 'Offer', price: '0.00', priceCurrency: 'EUR', url: d.joinUrl } }),
  };
  return layout(app, loc, {
    title: page.seo_title || `${g.name} – ${publicBrand(loc).name}`,
    description: desc,
    canonical: d.canonical,
    image: cover || undefined,
    robots: page.indexable ? 'index, follow' : 'noindex, nofollow',
    jsonld,
    body,
    navLinks: [[d.loginUrl, 'Anmelden'], [d.discoverUrl, 'Alle Communities']],
  });
}

// --- join form ----------------------------------------------------------------------------------------------------------

export interface JoinFormData {
  g: { id: string; name: string; slug: string };
  page: PageRow;
  tiers: TierView[];
  formToken: string;
  action: string;
  selectedTier?: string;
  billing?: string;
  invite?: { code: string; skip_approval: boolean };
  error?: string;
  values?: Record<string, string>;
  stripePromo?: boolean;
  couponVisible: boolean;
  couponUrl: string;
  ref?: string;
  attr?: string;
}

const optionLabel = (b: Billing, v: TierView) => {
  const p = v.prices;
  if (b === 'free') return 'Kostenlos';
  return p[b] ? priceText(p[b]!) : '';
};

export function joinHtml(app: App, loc: LocationRow, d: JoinFormData): RawResult {
  const v = d.values ?? {};
  const sel = d.selectedTier && d.tiers.some((t) => t.tier.id === d.selectedTier) ? d.selectedTier : d.tiers[0]?.tier.id;
  const tierChoice = d.tiers.length > 1
    ? `<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="padding:0">Deine Mitgliedschaft</legend>${d.tiers
        .map((t) => {
          const bills = billingsOf(t.prices);
          return `<label class="opt"><input type="radio" name="tier" value="${escapeHtml(t.tier.id)}"${t.tier.id === sel ? ' checked' : ''} required data-bills="${bills.join(',')}"><span class="b"><strong>${escapeHtml(t.tier.name)}</strong>${t.tier.description ? `<br><span class="muted small">${escapeHtml(t.tier.description)}</span>` : ''}${t.tier.trial_days ? `<br><span class="small" style="color:var(--ok);font-weight:600">${t.tier.trial_days} Tage kostenlos testen</span>` : ''}</span><span class="p">${escapeHtml(priceLines(t)[0])}</span></label>`;
        })
        .join('')}</fieldset>`
    : `<input type="hidden" name="tier" value="${escapeHtml(d.tiers[0]?.tier.id ?? '')}">`;
  // Billing choice: only where a tier really has more than one way to pay.
  const multi = d.tiers.filter((t) => billingsOf(t.prices).length > 1);
  const billingChoice = multi.length
    ? `<fieldset style="border:0;padding:0;margin:0" data-billing><legend class="f" style="padding:0">Zahlungsweise</legend>${d.tiers
        .filter((t) => billingsOf(t.prices).length > 1)
        .flatMap((t) =>
          billingsOf(t.prices).map((b, i) => `<label class="opt" data-tier="${escapeHtml(t.tier.id)}"><input type="radio" name="billing" value="${b}"${(d.billing ? d.billing === b : i === 0) ? ' checked' : ''}><span class="b"><strong>${b === 'month' ? 'Monatlich' : b === 'year' ? 'Jährlich' : 'Einmalig (lebenslang)'}</strong></span><span class="p">${escapeHtml(optionLabel(b, t))}</span></label>`),
        )
        .join('')}</fieldset>`
    : '';
  const questions = d.page.questions.map((q: Question) => `<label class="f" for="q-${escapeHtml(q.id)}">${escapeHtml(q.label)}${q.required ? '' : ' <span class="muted" style="font-weight:400">(optional)</span>'}</label><textarea class="t" id="q-${escapeHtml(q.id)}" name="q_${escapeHtml(q.id)}" maxlength="500" rows="2"${q.required ? ' required' : ''}>${escapeHtml(v[`q_${q.id}`] ?? '')}</textarea>`).join('');
  const paid = d.tiers.some((t) => !t.prices.free);
  const coupon = paid && d.couponVisible ? `<details style="margin:16px 0 0"${v.coupon ? ' open' : ''}><summary class="muted" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Rabattcode einlösen</summary><input class="t" name="coupon" autocomplete="off" placeholder="Code" value="${escapeHtml(v.coupon ?? '')}" style="text-transform:uppercase" data-coupon-url="${escapeHtml(d.couponUrl)}"><div class="small" data-coupon-msg style="margin-top:6px"></div></details>` : '';
  const note = d.page.approval && !d.invite?.skip_approval ? '<p class="muted small" style="margin:14px 0 0">Das Team prüft jede Anfrage. Du bekommst eine E-Mail, sobald es weitergeht.</p>' : '';
  const body = `<form class="join" method="post" action="${escapeHtml(d.action)}"><div class="panel">
<h1 style="font-size:28px">${escapeHtml(d.g.name)} beitreten</h1>
<p class="muted" style="margin:0 0 6px">${d.invite ? 'Du wurdest eingeladen. ' : ''}Ein paar Angaben – dann bist du dabei.</p>
${d.error ? `<div class="err" role="alert">${escapeHtml(d.error)}</div>` : ''}
<input type="hidden" name="_t" value="${escapeHtml(d.formToken)}"><input type="hidden" name="invite" value="${escapeHtml(d.invite?.code ?? '')}">${d.attr ? `<input type="hidden" name="_a" value="${escapeHtml(d.attr)}">` : ''}
<div class="hp" aria-hidden="true"><label>Website <input tabindex="-1" autocomplete="off" name="website"></label></div>
<label class="f" for="jn">Dein Name</label><input class="t" id="jn" name="name" required maxlength="100" autocomplete="name" value="${escapeHtml(v.name ?? '')}" autofocus>
<label class="f" for="je">E-Mail-Adresse</label><input class="t" id="je" name="email" type="email" required maxlength="200" autocomplete="email" value="${escapeHtml(v.email ?? '')}">
${questions}${tierChoice ? `<div style="margin-top:18px">${tierChoice}</div>` : ''}${billingChoice ? `<div style="margin-top:12px">${billingChoice}</div>` : ''}${coupon}
${d.page.terms_url || d.page.privacy_url ? `<label class="check"><input type="checkbox" name="terms" value="1" required><span>Ich habe ${d.page.terms_url ? `die <a href="${escapeHtml(d.page.terms_url)}" target="_blank" rel="noopener">AGB</a>` : ''}${d.page.terms_url && d.page.privacy_url ? ' und ' : ''}${d.page.privacy_url ? `die <a href="${escapeHtml(d.page.privacy_url)}" target="_blank" rel="noopener">Datenschutzhinweise</a>` : ''} gelesen und akzeptiere sie.</span></label>` : ''}
${d.page.consent_text ? `<label class="check"><input type="checkbox" name="consent" value="1"><span>${escapeHtml(d.page.consent_text)}</span></label>` : ''}
${note}
<p style="margin:20px 0 0"><button class="btn wide" type="submit">${escapeHtml(joinLabel(d.page, d.tiers))}</button></p>
</div></form>`;
  return layout(app, loc, { title: `${d.g.name} beitreten`, robots: 'noindex, nofollow', body, script: true, navLinks: [[`/c/${encodeURIComponent(d.g.slug)}`, 'Zurück zur Seite']], status: d.error ? 400 : 200 });
}

export function noticeHtml(app: App, loc: LocationRow, o: { title: string; text: string; button?: [string, string]; status?: number; extra?: string }): RawResult {
  return layout(app, loc, {
    title: o.title,
    robots: 'noindex, nofollow',
    status: o.status,
    body: `<div class="center panel"><h1 style="font-size:28px">${escapeHtml(o.title)}</h1><p class="muted">${escapeHtml(o.text)}</p>${o.extra ?? ''}${o.button ? `<p style="margin:22px 0 0"><a class="btn" href="${escapeHtml(o.button[1])}">${escapeHtml(o.button[0])}</a></p>` : ''}</div>`,
  });
}

// --- Discovery -----------------------------------------------------------------------------------------------------------------

export interface DiscoverItem {
  slug: string;
  name: string;
  tagline: string;
  cover: string;
  color: string;
  members: number;
  from: string;
  category: string;
  brand: string;
}

export function discoverHtml(app: App, o: { items: DiscoverItem[]; q: string; category: string; categories: string[]; title: string }): RawResult {
  const body = `<h1>${escapeHtml(o.title)}</h1><p class="muted">Offene Communities auf dieser Plattform – stöbere und tritt bei.</p>
<form class="filters" method="get" action="/communities"><input class="t" type="search" name="q" value="${escapeHtml(o.q)}" placeholder="Suchen …" aria-label="Suchen">${o.categories.length ? `<select class="t" name="category" aria-label="Kategorie"><option value="">Alle Kategorien</option>${o.categories.map((c) => `<option${c === o.category ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>` : ''}<button class="btn">Suchen</button></form>
${o.items.length ? `<div class="grid">${o.items.map((i) => `<a class="card" href="/c/${encodeURIComponent(i.slug)}" style="--c:${i.color}"><div class="cv"${i.cover ? ` style="background-image:url('${cssUrl(i.cover)}')"` : ''}>${i.cover ? '' : escapeHtml(i.name.slice(0, 1).toUpperCase())}</div><div class="bd"><h3>${escapeHtml(i.name)}</h3>${i.tagline ? `<p class="muted small" style="margin:0">${escapeHtml(excerptOf(i.tagline, 110))}</p>` : ''}<div class="muted small" style="margin-top:auto">${i.members} ${i.members === 1 ? 'Mitglied' : 'Mitglieder'} · ${escapeHtml(i.from)}${i.category ? ` · ${escapeHtml(i.category)}` : ''}</div><div class="muted small">von ${escapeHtml(i.brand)}</div></div></a>`).join('')}</div>` : '<div class="panel center"><p class="muted">Keine Community gefunden.</p></div>'}`;
  const r = html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(o.title)}</title><meta name="description" content="Offene Communities – stöbern und beitreten."><meta name="robots" content="index, follow"><meta name="theme-color" content="#2563eb"><style>:root{--brand:#2563eb;--soft:#2563eb1f}@media (prefers-color-scheme:dark){:root{--soft:#2563eb33}}${CSS}</style></head><body><header class="top"><div class="in"><a class="brand" href="/communities"><span class="mark">★</span><span>${escapeHtml(o.title)}</span></a></div></header><main>${body}</main></body></html>`);
  Object.assign(r.headers, { 'cache-control': 'public, max-age=60', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  return r;
}

export { centsToMoney };
