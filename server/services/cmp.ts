import { escapeHtml } from '../core/template.js';

/**
 * Cookie consent (CMP) – the pure part: settings, the cookie, which script/iframe/pixel belongs to which category, the
 * server-side blocking of the owner's code (head code, HTML blocks, embeds) until consent, Google Consent Mode v2 signals and
 * the banner itself. No third-party CMP and no JavaScript needed: the page is rendered for the visitor with what they allowed,
 * the buttons are links (the server sets the cookie and sends them back), which also works on sandboxed funnel pages.
 * modules/consent-banner.ts wires it into the public pages.
 */

export const CMP_CATEGORIES = ['necessary', 'statistics', 'marketing', 'external_media'] as const;
export type CmpCategory = (typeof CMP_CATEGORIES)[number];
/** The categories a visitor decides about (necessary is always on). */
export const OPTIONAL = ['statistics', 'marketing', 'external_media'] as const;
export type Optional = (typeof OPTIONAL)[number];

export interface CmpSettings {
  enabled: boolean;
  layout: 'box' | 'bar' | 'center';
  position: 'left' | 'right' | 'middle';
  title: string;
  text: string;
  accept_all: string;
  reject_all: string;
  customize: string;
  save: string;
  policy_url: string;
  policy_label: string;
  imprint_url: string;
  categories: Record<CmpCategory, { label: string; description: string }>;
  colors: { bg: string; text: string; accent: string; accent_text: string };
  reopen: { enabled: boolean; label: string };
  /** Google Consent Mode v2: default "denied" before any tag, "update" with the visitor's choice. */
  consent_mode: boolean;
  /** Scripts the classifier does not know: "block" (as marketing) or "allow" (as necessary). */
  unknown_scripts: 'block' | 'allow';
  expiry_days: number;
  /** Raised whenever the texts or categories change (or by hand): everybody is asked again. */
  version: number;
}

export const DEFAULT_CMP: CmpSettings = {
  enabled: false,
  layout: 'box',
  position: 'left',
  title: 'Wir respektieren deine Privatsphäre',
  text: 'Wir verwenden Cookies und ähnliche Technologien. Manche sind technisch notwendig, andere helfen uns, die Seite zu verbessern (Statistik), Inhalte von Drittanbietern zu zeigen (z. B. Videos) oder Werbung zu messen. Du entscheidest – und kannst deine Wahl jederzeit ändern.',
  accept_all: 'Alle akzeptieren',
  reject_all: 'Nur notwendige',
  customize: 'Einstellungen',
  save: 'Auswahl speichern',
  policy_url: '',
  policy_label: 'Datenschutzerklärung',
  imprint_url: '',
  categories: {
    necessary: { label: 'Notwendig', description: 'Technisch erforderlich, z. B. für Formulare, Sicherheit und deine Cookie-Auswahl. Immer aktiv.' },
    statistics: { label: 'Statistik', description: 'Hilft uns zu verstehen, wie die Seite genutzt wird – auch unser eigener Reichweiten-Cookie.' },
    marketing: { label: 'Marketing', description: 'Misst den Erfolg von Werbung und ermöglicht passende Anzeigen auf anderen Seiten.' },
    external_media: { label: 'Externe Medien', description: 'Videos, Karten und Dienste von Drittanbietern (z. B. YouTube, Google Maps). Dabei wird deine IP-Adresse an den Anbieter übertragen.' },
  },
  colors: { bg: '#ffffff', text: '#111827', accent: '#2563eb', accent_text: '#ffffff' },
  reopen: { enabled: true, label: 'Cookie-Einstellungen' },
  consent_mode: true,
  unknown_scripts: 'block',
  expiry_days: 180,
  version: 1,
};

const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v ?? '')) ? String(v).toLowerCase() : d);
const txt = (v: unknown, d: string, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : d);
const url = (v: unknown) => (/^(https?:\/\/[^\s"'<>]{3,500}|\/[^\s"'<>\\]{0,500})$/i.test(String(v ?? '').trim()) ? String(v).trim() : '');

/** Stored settings (anything a client could have written) → complete, clamped settings. */
export function cleanCmp(raw: unknown): CmpSettings {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_CMP;
  const cats = {} as CmpSettings['categories'];
  for (const k of CMP_CATEGORIES) cats[k] = { label: txt(r.categories?.[k]?.label, d.categories[k].label, 60), description: txt(r.categories?.[k]?.description, d.categories[k].description, 400) };
  const exp = Math.round(Number(r.expiry_days));
  const ver = Math.round(Number(r.version));
  return {
    enabled: r.enabled === true,
    layout: r.layout === 'bar' || r.layout === 'center' ? r.layout : 'box',
    position: r.position === 'right' || r.position === 'middle' ? r.position : 'left',
    title: txt(r.title, d.title, 120),
    text: txt(r.text, d.text, 900),
    accept_all: txt(r.accept_all, d.accept_all, 40),
    reject_all: txt(r.reject_all, d.reject_all, 40),
    customize: txt(r.customize, d.customize, 40),
    save: txt(r.save, d.save, 40),
    policy_url: url(r.policy_url),
    policy_label: txt(r.policy_label, d.policy_label, 60),
    imprint_url: url(r.imprint_url),
    categories: cats,
    colors: { bg: hex(r.colors?.bg, d.colors.bg), text: hex(r.colors?.text, d.colors.text), accent: hex(r.colors?.accent, d.colors.accent), accent_text: hex(r.colors?.accent_text, d.colors.accent_text) },
    reopen: { enabled: r.reopen?.enabled !== false, label: txt(r.reopen?.label, d.reopen.label, 40) },
    consent_mode: r.consent_mode !== false,
    unknown_scripts: r.unknown_scripts === 'allow' ? 'allow' : 'block',
    expiry_days: Number.isFinite(exp) ? Math.min(Math.max(exp, 1), 395) : d.expiry_days,
    version: Number.isFinite(ver) && ver >= 1 ? Math.min(ver, 100000) : 1,
  };
}

/** What a change of the wording is worth a new version for (texts and categories, not colours or the position). */
export const wordingKey = (s: CmpSettings) => JSON.stringify([s.title, s.text, s.accept_all, s.reject_all, s.categories, s.policy_url]);

// --- the visitor's choice ------------------------------------------------------------------------------------------

export const CMP_COOKIE = 'pghl_cmp';

export interface Choice {
  /** The visitor decided (for the current version of the banner). */
  decided: boolean;
  /** There is a choice, but for an older version of the banner: ask again. */
  stale: boolean;
  granted: Record<Optional, boolean>;
  /** Pseudonymous id of the visitor's decisions (consent log); '' before the first one. */
  cid: string;
}

const NONE: Record<Optional, boolean> = { statistics: false, marketing: false, external_media: false };

/** `v<version>.<bits>.<cid>` – bits = statistics, marketing, external media as 0/1. */
export function cmpCookie(version: number, granted: Record<Optional, boolean>, cid: string): string {
  return `v${version}.${OPTIONAL.map((k) => (granted[k] ? '1' : '0')).join('')}.${cid}`;
}

export function parseChoice(cookie: string | undefined, version: number): Choice {
  const m = String(cookie ?? '').match(/^v(\d{1,6})\.([01]{3})\.([A-Za-z0-9]{8,32})$/);
  if (!m) return { decided: false, stale: false, granted: { ...NONE }, cid: '' };
  const granted = Object.fromEntries(OPTIONAL.map((k, i) => [k, m[2][i] === '1'])) as Record<Optional, boolean>;
  const stale = Number(m[1]) !== version;
  return { decided: !stale, stale, granted: stale ? { ...NONE } : granted, cid: m[3] };
}

/** Consent for the first-party attribution cookie (counts as statistics) – 'unknown' until the visitor decided. */
export const attributionConsent = (c: Choice): 'granted' | 'denied' | 'unknown' => (!c.decided ? 'unknown' : c.granted.statistics || c.granted.marketing ? 'granted' : 'denied');

/** The Google Consent Mode v2 signals for a choice (security and functionality storage belong to "necessary"). */
export function consentSignals(granted: Record<Optional, boolean>): Record<string, 'granted' | 'denied'> {
  const g = (b: boolean) => (b ? 'granted' : 'denied');
  return {
    ad_storage: g(granted.marketing),
    ad_user_data: g(granted.marketing),
    ad_personalization: g(granted.marketing),
    analytics_storage: g(granted.statistics),
    functionality_storage: 'granted',
    personalization_storage: g(granted.marketing),
    security_storage: 'granted',
  };
}

/** Goes right after <head>: the default "denied" before any tag, the visitor's choice right behind it. */
export function consentModeSnippet(granted: Record<Optional, boolean>, decided: boolean): string {
  const def = consentSignals(NONE);
  const lines = [`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}`, `gtag('consent','default',${JSON.stringify({ ...def, wait_for_update: 500 })});`];
  if (decided) lines.push(`gtag('consent','update',${JSON.stringify(consentSignals(granted))});`);
  return `<script data-category="necessary">${lines.join('')}</script>`;
}

// --- classification --------------------------------------------------------------------------------------------------

/** [host pattern, category, optional path pattern] – the first match wins, so the specific ones come first. */
const URLS: [RegExp, CmpCategory, RegExp?][] = [
  [/(^|\.)facebook\.com$/, 'external_media', /^\/(plugins|v\d|sharer|dialog)/],
  [/(^|\.)google\.com$/, 'external_media', /^\/(maps|recaptcha)/],
  [/(^|\.)gstatic\.com$/, 'external_media', /^\/recaptcha/],
  [/(^|\.)google\.com$/, 'marketing', /^\/(pagead|ads|ccm|measurement)/],
  [/(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|hotjar\.(com|io)|clarity\.ms|plausible\.io|usefathom\.com|mixpanel\.com|segment\.(com|io)|heapanalytics\.com|amplitude\.com|posthog\.com|matomo\.cloud|piwik\.pro|cloudflareinsights\.com|statcounter\.com|crazyegg\.com|mouseflow\.com|fullstory\.com|simpleanalyticscdn\.com)$/, 'statistics'],
  [/(^|\.)(facebook\.net|facebook\.com|fbcdn\.net|doubleclick\.net|googleadservices\.com|googlesyndication\.com|licdn\.com|linkedin\.com|ads-twitter\.com|analytics\.tiktok\.com|snapchat\.com|sc-static\.net|pinimg\.com|criteo\.(com|net)|taboola\.com|outbrain\.com|adroll\.com|hs-scripts\.com|hs-analytics\.net|hs-banner\.com|hsforms\.(com|net)|hubspot\.com|trackcmp\.net|activehosted\.com|klaviyo\.com|chimpstatic\.com|bat\.bing\.com|redditstatic\.com|quora\.com)$/, 'marketing'],
  [/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|vimeo\.com|vimeocdn\.com|wistia\.(com|net)|loom\.com|dailymotion\.com|spotify\.com|soundcloud\.com|twitch\.tv|calendly\.com|typeform\.com|openstreetmap\.org|maps\.googleapis\.com|maps\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|platform\.twitter\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|issuu\.com|hcaptcha\.com|tawk\.to|intercom\.(io|com)|intercomcdn\.com|crisp\.chat|drift\.com|tidio\.(co|com)|zdassets\.com|livechatinc\.com|userlike\.com)$/, 'external_media'],
];

/** The category of an address; null = no match (an unknown third party or a first-party address). */
export function classifyUrl(raw: string, selfHosts: string[] = []): CmpCategory | 'unknown' | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/^\/\//, 'https://'), 'http://self.invalid');
  } catch {
    return null;
  }
  if (u.hostname === 'self.invalid') return null;
  const host = u.hostname.toLowerCase();
  if (selfHosts.some((h) => h.toLowerCase() === host)) return null;
  for (const [h, cat, p] of URLS) if (h.test(host) && (!p || p.test(u.pathname))) return cat;
  return 'unknown';
}

/** What an inline script is about, by the calls it makes (null = nothing we recognise). */
export function classifyInline(code: string): CmpCategory | null {
  if (/\bgtag\(\s*['"]config['"]\s*,\s*['"]AW-|googleadservices|\bfbq\s*\(|\bttq\.|\blintrk\s*\(|\bsnaptr\s*\(|\bpintrk\s*\(|\b_hsq\b|\bobApi\b|\btwq\s*\(/.test(code)) return 'marketing';
  if (/\bgtag\(|\bga\s*\(\s*['"]create['"]|GTM-[A-Z0-9]+|googletagmanager|google-analytics\.com|\b_paq\.push|\bhj\s*\(|\bclarity\s*\(|plausible|\bmixpanel\b|\bposthog\b|\bamplitude\b|\bdataLayer\b/.test(code)) return 'statistics';
  if (/youtube(-nocookie)?\.com|player\.vimeo\.com|google\.com\/maps|maps\.googleapis/.test(code)) return 'external_media';
  return null;
}

const normCat = (v: string): CmpCategory | null => {
  const s = v.trim().toLowerCase().replace(/-/g, '_');
  if (s === 'media' || s === 'external' || s === 'embeds') return 'external_media';
  if (s === 'analytics' || s === 'stats') return 'statistics';
  if (s === 'advertising' || s === 'ads') return 'marketing';
  return (CMP_CATEGORIES as readonly string[]).includes(s) ? (s as CmpCategory) : null;
};

// --- blocking --------------------------------------------------------------------------------------------------------

interface Attr {
  name: string;
  value: string | null;
}
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string): Attr[] {
  const out: Attr[] = [];
  for (const m of s.matchAll(ATTR)) out.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? null });
  return out;
}
const attrOf = (a: Attr[], n: string) => a.find((x) => x.name.toLowerCase() === n)?.value ?? null;
const hasAttr = (a: Attr[], n: string) => a.some((x) => x.name.toLowerCase() === n);
const without = (a: Attr[], ...n: string[]) => a.filter((x) => !n.includes(x.name.toLowerCase()));
const emit = (a: Attr[]) => a.map((x) => (x.value === null ? ` ${x.name}` : ` ${x.name}="${x.value.replace(/"/g, '&quot;')}"`)).join('');
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export interface BlockOptions {
  granted: Record<Optional, boolean>;
  /** Hosts that are this site (never blocked). */
  selfHosts: string[];
  unknown: 'block' | 'allow';
  /** Where "allow this category" leads (placeholder button). */
  allowLink?: (cat: Optional) => string;
  labels?: Partial<Record<CmpCategory, string>>;
}
export interface Blocked {
  category: CmpCategory;
  what: 'script' | 'iframe' | 'img' | 'link' | 'noscript';
  src: string;
}

const allowed = (o: BlockOptions, cat: CmpCategory) => cat === 'necessary' || o.granted[cat as Optional] === true;

/**
 * The owner's code in a piece of HTML (head code, an HTML block): scripts, stylesheets, images and embeds of other sites, and the
 * tracking pixels in <noscript>, sorted into categories. What the visitor has not allowed becomes inert: scripts get
 * `type="text/plain" data-category="…"` (and `data-src` instead of `src`), the rest `data-src`; what they allowed is switched on
 * (so code written as `type="text/plain" data-category="marketing"` runs once marketing is allowed).
 * An explicit `data-category="necessary|statistics|marketing|external_media"` on a tag always wins.
 */
export function blockOwnerCode(html: string, o: BlockOptions): { html: string; blocked: Blocked[] } {
  const blocked: Blocked[] = [];
  const catOf = (a: Attr[], src: string | null, inline = ''): CmpCategory => {
    const explicit = attrOf(a, 'data-category');
    const forced = explicit ? normCat(explicit) : null;
    if (forced) return forced;
    if (src) {
      const c = classifyUrl(decode(src), o.selfHosts);
      if (c === null) return 'necessary';
      if (c !== 'unknown') return c;
      return o.unknown === 'allow' ? 'necessary' : 'marketing';
    }
    return classifyInline(inline) ?? (o.unknown === 'allow' ? 'necessary' : 'marketing');
  };

  let out = html.replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/gi, (m, inner: string) => {
    // A pixel or frame in <noscript> loads without JavaScript and without a choice: it stays only if its category is allowed.
    const srcs = [...inner.matchAll(/<(?:img|iframe)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((x) => x[1]);
    for (const s of srcs) {
      const c = classifyUrl(decode(s), o.selfHosts);
      if (c !== null && !allowed(o, c === 'unknown' ? (o.unknown === 'allow' ? 'necessary' : 'marketing') : c)) {
        blocked.push({ category: c === 'unknown' ? 'marketing' : c, what: 'noscript', src: s });
        return '';
      }
    }
    return m;
  });

  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi, (m, attrStr: string, body: string) => {
    const a = parseAttrs(attrStr);
    const type = (attrOf(a, 'type') ?? '').toLowerCase();
    // JSON-LD, import maps and the like are data, not code.
    if (type && type !== 'text/plain' && !/javascript|ecmascript|module/.test(type)) return m;
    const src = attrOf(a, 'src') ?? attrOf(a, 'data-src');
    const cat = catOf(a, src, body);
    const inert = type === 'text/plain';
    if (allowed(o, cat)) {
      if (!inert && !hasAttr(a, 'data-src')) return m;
      // Switch on: back to a normal script.
      const next = without(a, 'type', 'data-src', 'data-category', 'src');
      if (src) next.push({ name: 'src', value: src });
      return `<script${emit(next)}>${body}</script>`;
    }
    blocked.push({ category: cat, what: 'script', src: src ?? '(inline)' });
    const next = without(a, 'type', 'src', 'data-src', 'data-category');
    next.push({ name: 'type', value: 'text/plain' }, { name: 'data-category', value: cat });
    if (src) next.push({ name: 'data-src', value: src });
    return `<script${emit(next)}>${body}</script>`;
  });

  // Stylesheets, fonts, preconnects of other sites (Google Fonts …).
  out = out.replace(/<link\b([^>]*)>/gi, (m, attrStr: string) => {
    const a = parseAttrs(attrStr);
    const href = attrOf(a, 'href') ?? attrOf(a, 'data-href');
    const rel = (attrOf(a, 'rel') ?? attrOf(a, 'data-rel') ?? '').toLowerCase();
    if (!href || !/stylesheet|preconnect|preload|dns-prefetch/.test(rel)) return m;
    const c = classifyUrl(decode(href), o.selfHosts);
    if (c === null) return m;
    const cat = attrOf(a, 'data-category') ? (normCat(attrOf(a, 'data-category')!) ?? 'marketing') : c === 'unknown' ? (o.unknown === 'allow' ? 'necessary' : 'marketing') : c;
    if (allowed(o, cat)) {
      if (!hasAttr(a, 'data-href')) return m;
      const next = without(a, 'data-href', 'data-rel', 'data-category', 'rel', 'href');
      next.push({ name: 'rel', value: rel }, { name: 'href', value: href });
      return `<link${emit(next)}>`;
    }
    blocked.push({ category: cat, what: 'link', src: href });
    return `<link${emit([...without(a, 'href', 'rel', 'data-category', 'data-href', 'data-rel'), { name: 'data-rel', value: rel }, { name: 'data-href', value: href }, { name: 'data-category', value: cat }])}>`;
  });

  // Images from other sites (tracking pixels).
  out = out.replace(/<img\b([^>]*)>/gi, (m, attrStr: string) => {
    const a = parseAttrs(attrStr);
    const src = attrOf(a, 'src') ?? attrOf(a, 'data-src');
    if (!src || /^data:/i.test(src)) return m;
    const c = classifyUrl(decode(src), o.selfHosts);
    // Only pixels and known trackers: ordinary pictures of other sites are not blocked here.
    const pixel = /^\s*1\s*(px)?\s*$/.test(attrOf(a, 'width') ?? '') || /^\s*1\s*(px)?\s*$/.test(attrOf(a, 'height') ?? '') || /display\s*:\s*none/i.test(attrOf(a, 'style') ?? '');
    if (c === null || (c === 'unknown' && !pixel)) return m;
    const cat: CmpCategory = attrOf(a, 'data-category') ? (normCat(attrOf(a, 'data-category')!) ?? 'marketing') : c === 'unknown' ? 'marketing' : c;
    if (allowed(o, cat)) {
      if (!hasAttr(a, 'data-src')) return m;
      return `<img${emit([...without(a, 'data-src', 'data-category', 'src'), { name: 'src', value: src }])}>`;
    }
    blocked.push({ category: cat, what: 'img', src });
    return `<img${emit([...without(a, 'src', 'data-src', 'data-category'), { name: 'data-src', value: src }, { name: 'data-category', value: cat }])}>`;
  });
  return { html: out, blocked };
}

/**
 * Embeds of other sites anywhere on the page (the video block, an iframe in an HTML block): replaced by a note with the way to
 * allow them, until the visitor allowed their category. Our own frames (booking calendars, forms) are untouched.
 */
export function blockEmbeds(html: string, o: BlockOptions): { html: string; blocked: Blocked[] } {
  const blocked: Blocked[] = [];
  const out = html.replace(/<iframe\b([^>]*)>([\s\S]*?)<\/iframe\s*>/gi, (m, attrStr: string) => {
    const a = parseAttrs(attrStr);
    const src = attrOf(a, 'src') ?? attrOf(a, 'data-src');
    if (!src) return m;
    const c = classifyUrl(decode(src), o.selfHosts);
    if (c === null) return m;
    const forced = attrOf(a, 'data-category') ? normCat(attrOf(a, 'data-category')!) : null;
    const cat: CmpCategory = forced ?? (c === 'unknown' ? (o.unknown === 'allow' ? 'necessary' : 'external_media') : c);
    if (allowed(o, cat)) {
      if (!hasAttr(a, 'data-src')) return m;
      return `<iframe${emit([...without(a, 'data-src', 'data-category', 'src'), { name: 'src', value: src }])}></iframe>`;
    }
    blocked.push({ category: cat, what: 'iframe', src });
    let host = '';
    try {
      host = new URL(decode(src).replace(/^\/\//, 'https://')).hostname.replace(/^www\./, '');
    } catch {
      /* no host to show */
    }
    const label = o.labels?.[cat] ?? 'Externe Medien';
    const link = cat === 'necessary' ? '' : (o.allowLink?.(cat as Optional) ?? '#');
    const w = attrOf(a, 'width');
    const style = `${w && /^\d{2,4}$/.test(w) ? `max-width:${w}px;` : ''}`;
    return `<div class="pghl-cmp-ph" data-category="${cat}" data-src="${escapeHtml(src)}" style="${style}"><p>Dieser Inhalt${host ? ` von <strong>${escapeHtml(host)}</strong>` : ''} wird erst nach deiner Zustimmung geladen.</p><a class="pghl-cmp-btn" href="${escapeHtml(link)}" rel="nofollow">${escapeHtml(label)} erlauben</a></div>`;
  });
  return { html: out, blocked };
}

// --- the banner ----------------------------------------------------------------------------------------------------------

export interface BannerUrls {
  /** Link for an action: accept / reject / open, or save with the categories; `cat` for "allow this one". */
  action(a: 'accept' | 'reject' | 'open' | 'allow', cat?: Optional): string;
  /** Action of the settings form and the hidden fields to keep (other query parameters of the page). */
  formAction: string;
  hidden: [string, string][];
}

/** Styles of the banner, the re-open tab and the placeholders (once per page). */
export const cmpCss = (s: CmpSettings) => {
  const c = s.colors;
  const place = s.layout === 'bar' ? 'left:0;right:0;bottom:0;border-radius:14px 14px 0 0' : s.layout === 'center' ? 'left:50%;top:50%;transform:translate(-50%,-50%);max-width:560px;width:calc(100% - 32px)' : `bottom:16px;${s.position === 'right' ? 'right:16px' : s.position === 'middle' ? 'left:50%;transform:translateX(-50%)' : 'left:16px'};max-width:460px;width:calc(100% - 32px)`;
  return `<style>
#pghl-cmp{position:fixed;${place};z-index:2147483000;background:${c.bg};color:${c.text};padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.28);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;border-radius:14px;max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box}
#pghl-cmp *{box-sizing:border-box}#pghl-cmp h2{font-size:17px;margin:0 0 6px;color:${c.text}}#pghl-cmp p{margin:0 0 10px;color:${c.text}}
#pghl-cmp a.pghl-cmp-link{color:${c.accent};text-decoration:underline}
.pghl-cmp-btn{display:inline-block;background:${c.accent};color:${c.accent_text} !important;border:2px solid ${c.accent};border-radius:9px;padding:10px 16px;font:600 14px/1.2 system-ui,sans-serif;text-decoration:none;cursor:pointer;text-align:center}
.pghl-cmp-btn.alt{background:transparent;color:${c.accent} !important}
.pghl-cmp-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pghl-cmp-row>.pghl-cmp-btn{flex:1 1 130px}
#pghl-cmp details{margin-top:12px;border-top:1px solid ${c.text}22;padding-top:10px}#pghl-cmp summary{cursor:pointer;font-weight:600;color:${c.accent}}
#pghl-cmp label.pghl-cmp-cat{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-weight:400}#pghl-cmp label.pghl-cmp-cat input{width:20px;height:20px;margin-top:2px;flex:none}
#pghl-cmp small{display:block;opacity:.8}
.pghl-cmp-reopen{position:fixed;left:12px;bottom:12px;z-index:2147482999;background:${c.bg};color:${c.text} !important;border:1px solid ${c.text}33;border-radius:999px;padding:6px 12px;font:12px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.pghl-cmp-ph{background:#f3f4f6;color:#111827;border:1px dashed #9ca3af;border-radius:10px;padding:18px;margin:12px auto;text-align:center;font:14px/1.5 system-ui,sans-serif}.pghl-cmp-ph .pghl-cmp-btn{color:${c.accent_text} !important}
${s.layout === 'center' ? 'body:has(#pghl-cmp)::before{content:"";position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147482998}' : ''}
</style>`;
};

/** The banner: first level with accept / reject (equally prominent) and "Einstellungen"; the categories behind it, none pre-selected. */
export function bannerHtml(s: CmpSettings, choice: Choice, u: BannerUrls): string {
  const e = escapeHtml;
  const cat = (k: CmpCategory) => {
    const c = s.categories[k];
    const on = k === 'necessary' ? ' checked disabled' : choice.granted[k as Optional] ? ' checked' : '';
    const name = k === 'necessary' ? '' : ` name="pghl_${k === 'statistics' ? 's' : k === 'marketing' ? 'm' : 'e'}" value="1"`;
    return `<label class="pghl-cmp-cat"><input type="checkbox"${name}${on}><span><strong>${e(c.label)}</strong><small>${e(c.description)}</small></span></label>`;
  };
  const links = [s.policy_url ? `<a class="pghl-cmp-link" href="${e(s.policy_url)}">${e(s.policy_label)}</a>` : '', s.imprint_url ? `<a class="pghl-cmp-link" href="${e(s.imprint_url)}">Impressum</a>` : ''].filter(Boolean).join(' · ');
  return `<div id="pghl-cmp" role="dialog" aria-modal="false" aria-labelledby="pghl-cmp-t" data-version="${s.version}">
<h2 id="pghl-cmp-t">${e(s.title)}</h2>
<p>${e(s.text)}</p>${links ? `<p>${links}</p>` : ''}
<div class="pghl-cmp-row"><a class="pghl-cmp-btn" href="${e(u.action('accept'))}" rel="nofollow">${e(s.accept_all)}</a><a class="pghl-cmp-btn" href="${e(u.action('reject'))}" rel="nofollow">${e(s.reject_all)}</a></div>
<details${choice.stale || choice.decided ? ' open' : ''}><summary>${e(s.customize)}</summary>
<form method="get" action="${e(u.formAction)}">${u.hidden.map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`).join('')}<input type="hidden" name="pghl_cmp" value="save">
${CMP_CATEGORIES.map(cat).join('\n')}
<div class="pghl-cmp-row"><button type="submit" class="pghl-cmp-btn alt">${e(s.save)}</button></div></form></details>
</div>`;
}

/** The small "Cookie-Einstellungen" tab once a choice exists – the way to change or withdraw it (as easy as giving it). */
export const reopenHtml = (s: CmpSettings, href: string) => `<a class="pghl-cmp-reopen" href="${escapeHtml(href)}" rel="nofollow">${escapeHtml(s.reopen.label)}</a>`;

/** Words for a placeholder button ("Externe Medien erlauben"). */
export const placeholderLabels = (s: CmpSettings): Partial<Record<CmpCategory, string>> => Object.fromEntries(CMP_CATEGORIES.map((k) => [k, s.categories[k].label]));

export interface PageOptions extends BlockOptions {
  settings: CmpSettings;
  choice: Choice;
  /** Show the banner (no choice yet, an old one, or opened again). */
  showBanner: boolean;
  urls: BannerUrls;
  /** Link of the re-open tab and of `href="#cookie-settings"` links. */
  reopenHref: string;
}

/**
 * The whole page for one visitor: the owner's code between `<!--pghl:owner-->` markers and the HTML blocks sorted by category,
 * foreign embeds replaced, Consent Mode signals after <head>, the banner (or the re-open tab) before </body>.
 */
export function applyCmp(page: string, o: PageOptions): { html: string; blocked: Blocked[] } {
  const blocked: Blocked[] = [];
  let html = page.replace(/<!--pghl:owner-->([\s\S]*?)<!--\/pghl:owner-->/g, (_m, inner: string) => {
    const r = blockOwnerCode(inner, o);
    blocked.push(...r.blocked);
    return r.html;
  });
  html = html.replace(/(<section class="blk blk-html">)([\s\S]*?)(<\/section>)/g, (_m, a: string, inner: string, b: string) => {
    const r = blockOwnerCode(inner, o);
    blocked.push(...r.blocked);
    return a + r.html + b;
  });
  const emb = blockEmbeds(html, o);
  html = emb.html;
  blocked.push(...emb.blocked);
  if (o.settings.consent_mode) {
    // Right after the charset declaration (it has to stay within the first 1024 bytes), before any other tag of the head.
    const snippet = consentModeSnippet(o.choice.granted, o.choice.decided);
    html = /<meta\s+charset=[^>]*>/i.test(html) ? html.replace(/<meta\s+charset=[^>]*>/i, (m) => `${m}${snippet}`) : html.replace(/<head\b[^>]*>/i, (m) => `${m}${snippet}`);
  }
  // A link anywhere on the page opens the settings again.
  html = html.replace(/href=(["'])#(?:cookie-settings|cookie-einstellungen)\1/gi, `href="${escapeHtml(o.reopenHref)}" rel="nofollow"`);
  const needsCss = o.showBanner || o.settings.reopen.enabled || emb.blocked.length > 0;
  const extra = (needsCss ? cmpCss(o.settings) : '') + (o.showBanner ? bannerHtml(o.settings, o.choice, o.urls) : '') + (!o.showBanner && o.settings.reopen.enabled ? reopenHtml(o.settings, o.reopenHref) : '');
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${extra}</body>`) : html + extra;
  return { html, blocked };
}

/** The full preview page for the editor (no real actions, a made-up page behind the banner). */
export function previewHtml(s: CmpSettings, choice: Choice): string {
  const u: BannerUrls = { action: () => '#', formAction: '#', hidden: [] };
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vorschau</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#f9fafb;color:#111827}.demo{max-width:720px;margin:0 auto;padding:60px 20px}.demo h1{font-size:34px}.demo p{color:#6b7280;font-size:18px}</style></head><body><div class="demo"><h1>Deine Seite</h1><p>So sieht das Banner für Besucher aus. Die Buttons sind in der Vorschau ohne Funktion.</p><div class="pghl-cmp-ph" style="max-width:420px"><p>Dieser Inhalt von <strong>youtube-nocookie.com</strong> wird erst nach deiner Zustimmung geladen.</p><a class="pghl-cmp-btn" href="#">${escapeHtml(s.categories.external_media.label)} erlauben</a></div></div>${cmpCss(s)}${bannerHtml(s, choice, u)}</body></html>`;
}
