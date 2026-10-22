import { parseCsv } from '../core/csv.js';
import { sha256 } from '../core/util.js';

/**
 * Review sources for Reputation: one adapter per platform behind a small registry (registerReviewAdapter). An adapter reads the
 * rating, the count and the newest reviews through the platform's official API and – where the API allows it – posts the owner's
 * reply; everything else gets a "reply on the platform" link. The generic import adapter takes CSV, an RSS/Atom feed or a web hook
 * for platforms without an API (Jameda, Kununu, …). The module (modules/review-sources.ts) stores everything in one table,
 * fires the triggers and drafts AI replies. Endpoints follow the public documentation (October 2026); tests use fakes only.
 */

export interface ReviewIn {
  externalId: string;
  author: string;
  authorUrl?: string;
  /** 1–5; Facebook recommendations without stars map to 5 (recommends) / 1 (does not). */
  rating: number | null;
  recommend?: boolean | null;
  title?: string;
  text: string;
  language?: string;
  publishedAt: string | null;
  link: string;
  replyText?: string;
  replyAt?: string | null;
}

export interface FetchResult {
  reviews: ReviewIn[];
  rating?: number | null;
  total?: number | null;
  name?: string;
  profileUrl?: string;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  data: any;
  text: string;
}
/** An HTTP call to a fixed API host (the module swaps in a fake in tests). `form` posts application/x-www-form-urlencoded. */
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; json?: unknown; form?: Record<string, string> }) => Promise<HttpResult>;

export interface AdapterCtx {
  config: Record<string, string>;
  secrets: Record<string, string>;
  http: Http;
  /** Graph API with the token of the sub-account's page (Facebook adapter only). */
  graph?: (method: string, path: string, body?: unknown) => Promise<any>;
  /** A user-given URL (RSS feed): fetched with the SSRF guard. */
  fetchUrl?: (url: string) => Promise<string>;
}

export interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ReviewAdapter {
  id: string;
  label: string;
  /** api: read through the platform's API; import: CSV, RSS or web hook. */
  kind: 'api' | 'import';
  fields: FieldSpec[];
  /** One line for the setup dialog (what the API gives, what it does not). */
  hint: string;
  /** Keep only what the latest fetch returned (platforms whose terms forbid keeping reviews: Yelp, Tripadvisor). */
  mirror?: boolean;
  fetch(ctx: AdapterCtx): Promise<FetchResult>;
  /** Whether replies go out through the API with this configuration. */
  canReply(ctx: Pick<AdapterCtx, 'config' | 'secrets'>, review: { external_id: string; link: string }): boolean;
  reply?(ctx: AdapterCtx, review: { external_id: string; link: string }, text: string): Promise<void>;
  /** Where the owner answers on the platform itself. */
  replyLink(config: Record<string, string>, review: { external_id: string; link: string }): string;
}

const ADAPTERS = new Map<string, ReviewAdapter>();
export const registerReviewAdapter = (a: ReviewAdapter) => void ADAPTERS.set(a.id, a);
export const reviewAdapter = (id: string) => ADAPTERS.get(id);
export const reviewAdapters = () => [...ADAPTERS.values()];

// --- helpers ------------------------------------------------------------------------------------------------------------

const clip = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
const https = (v: unknown) => (/^https:\/\/\S+$/.test(String(v ?? '')) ? String(v) : '');
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const stars = (v: unknown): number | null => {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 5 ? n : null;
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
function must(r: HttpResult, label: string) {
  if (!r.ok) {
    const msg = r.data?.error?.message ?? r.data?.error?.description ?? r.data?.message ?? r.data?.errorMessage ?? (typeof r.data?.error === 'string' ? r.data.error : '');
    throw new Error(`${label}: ${clip(msg, 200) || `Fehler ${r.status}`}`);
  }
  return r.data;
}
const basic = (a: string, b: string) => `Basic ${Buffer.from(`${a}:${b}`).toString('base64')}`;

// --- Facebook page ratings (Graph API, page token of the Meta channels) ------------------------------------------------------

registerReviewAdapter({
  id: 'facebook',
  label: 'Facebook',
  kind: 'api',
  hint: 'Bewertungen/Empfehlungen der Seite über die Graph-API mit dem Seiten-Token aus Einstellungen → Kanäle (Berechtigung pages_read_user_content, zum Antworten pages_manage_engagement).',
  fields: [{ key: 'page_id', label: 'Seiten-ID', required: true, placeholder: 'z. B. 104…', help: 'Eine der unter Einstellungen → Kanäle verbundenen Seiten' }],
  async fetch(ctx) {
    if (!ctx.graph) throw new Error('Facebook-Seite ist nicht verbunden (Einstellungen → Kanäle)');
    const page = ctx.config.page_id;
    const info = await ctx.graph('GET', `${page}?fields=name,overall_star_rating,rating_count,link`);
    const j = await ctx.graph('GET', `${page}/ratings?fields=created_time,recommendation_type,review_text,rating,reviewer{id,name},open_graph_story{id}&limit=50`);
    const reviews: ReviewIn[] = [];
    for (const r of Array.isArray(j?.data) ? j.data : []) {
      const story = String(r?.open_graph_story?.id ?? '');
      const rec = r?.recommendation_type === 'positive' ? true : r?.recommendation_type === 'negative' ? false : null;
      const created = iso(r?.created_time);
      reviews.push({
        externalId: story || sha256(`${r?.reviewer?.id ?? ''}|${created ?? ''}|${r?.review_text ?? ''}`).slice(0, 40),
        author: clip(r?.reviewer?.name, 200) || 'Facebook-Nutzer',
        rating: stars(r?.rating) ?? (rec === true ? 5 : rec === false ? 1 : null),
        recommend: rec,
        text: clip(r?.review_text, 5000),
        publishedAt: created,
        link: story ? `https://www.facebook.com/${encodeURIComponent(story)}` : `https://www.facebook.com/${encodeURIComponent(page)}/reviews`,
      });
    }
    return { reviews, rating: round1(num(info?.overall_star_rating)), total: num(info?.rating_count), name: clip(info?.name, 200), profileUrl: https(info?.link) || `https://www.facebook.com/${encodeURIComponent(page)}/reviews` };
  },
  canReply: (_ctx, r) => /^\d+(_\d+)?$/.test(r.external_id),
  async reply(ctx, r, text) {
    if (!ctx.graph) throw new Error('Facebook-Seite ist nicht verbunden');
    await ctx.graph('POST', `${r.external_id}/comments`, { message: text });
  },
  replyLink: (c, r) => r.link || `https://www.facebook.com/${encodeURIComponent(c.page_id ?? '')}/reviews`,
});

// --- Trustpilot (Business API) -------------------------------------------------------------------------------------------

const TP = 'https://api.trustpilot.com/v1';
async function trustpilotUnit(ctx: AdapterCtx): Promise<string> {
  if (ctx.config.business_unit_id) return ctx.config.business_unit_id;
  if (!ctx.config.domain) throw new Error('Trustpilot: Business-Unit-ID oder Domain fehlt');
  const j = must(await ctx.http(`${TP}/business-units/find?name=${encodeURIComponent(ctx.config.domain)}`, { headers: { apikey: ctx.secrets.api_key } }), 'Trustpilot');
  if (!j?.id) throw new Error('Trustpilot: Firma zu dieser Domain nicht gefunden');
  return String(j.id);
}
registerReviewAdapter({
  id: 'trustpilot',
  label: 'Trustpilot',
  kind: 'api',
  hint: 'Öffentliche Bewertungen über die Trustpilot Business API (API-Key). Mit API-Secret und dem Login eines Business-Users antwortet HyperLevel direkt.',
  fields: [
    { key: 'domain', label: 'Domain bei Trustpilot', placeholder: 'beispiel.de' },
    { key: 'business_unit_id', label: 'Business-Unit-ID (optional)', help: 'Wird sonst über die Domain gesucht' },
    { key: 'api_key', label: 'API-Key', secret: true, required: true },
    { key: 'api_secret', label: 'API-Secret (zum Antworten)', secret: true },
    { key: 'username', label: 'Business-User (E-Mail, zum Antworten)' },
    { key: 'password', label: 'Passwort des Business-Users', secret: true },
  ],
  async fetch(ctx) {
    const unit = await trustpilotUnit(ctx);
    const h = { headers: { apikey: ctx.secrets.api_key } };
    const info = must(await ctx.http(`${TP}/business-units/${encodeURIComponent(unit)}`, h), 'Trustpilot');
    const j = must(await ctx.http(`${TP}/business-units/${encodeURIComponent(unit)}/reviews?perPage=100&orderBy=createdat.desc`, h), 'Trustpilot');
    const reviews: ReviewIn[] = (Array.isArray(j?.reviews) ? j.reviews : []).map((r: any) => ({
      externalId: String(r.id),
      author: clip(r?.consumer?.displayName, 200) || 'Trustpilot-Nutzer',
      rating: stars(r?.stars),
      title: clip(r?.title, 300),
      text: clip(r?.text, 5000),
      language: clip(r?.language, 12),
      publishedAt: iso(r?.createdAt),
      link: `https://www.trustpilot.com/reviews/${encodeURIComponent(String(r.id))}`,
      replyText: r?.companyReply?.text ? clip(r.companyReply.text, 5000) : '',
      replyAt: iso(r?.companyReply?.createdAt),
    }));
    const domain = clip(info?.name?.identifying ?? ctx.config.domain, 200);
    return { reviews, rating: round1(num(info?.score?.stars ?? info?.score?.trustScore)), total: num(info?.numberOfReviews?.total), name: clip(info?.displayName, 200), profileUrl: domain ? `https://www.trustpilot.com/review/${encodeURIComponent(domain)}` : '' };
  },
  canReply: (ctx) => !!(ctx.secrets.api_key && ctx.secrets.api_secret && ctx.config.username && ctx.secrets.password),
  async reply(ctx, r, text) {
    const tok = must(
      await ctx.http(`${TP}/oauth/oauth-business-users-for-applications/accesstoken`, {
        method: 'POST',
        headers: { authorization: basic(ctx.secrets.api_key, ctx.secrets.api_secret) },
        form: { grant_type: 'password', username: ctx.config.username, password: ctx.secrets.password },
      }),
      'Trustpilot-Anmeldung',
    );
    if (!tok?.access_token) throw new Error('Trustpilot-Anmeldung: kein Zugriffstoken');
    must(await ctx.http(`${TP}/private/reviews/${encodeURIComponent(r.external_id)}/reply`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}` }, json: { message: text } }), 'Trustpilot');
  },
  replyLink: (_c, r) => `https://businessapp.b2b.trustpilot.com/reviews/${encodeURIComponent(r.external_id)}`,
});

// --- ProvenExpert (API: rating summary) ----------------------------------------------------------------------------------

registerReviewAdapter({
  id: 'provenexpert',
  label: 'ProvenExpert',
  kind: 'api',
  hint: 'Die ProvenExpert-API liefert Gesamtnote und Anzahl (Widget, Statistik). Einzelne Bewertungen kommen über den Import (CSV-Export von ProvenExpert); geantwortet wird auf ProvenExpert.',
  fields: [
    { key: 'api_id', label: 'API-ID', required: true },
    { key: 'api_key', label: 'API-Key', secret: true, required: true },
    { key: 'profile_url', label: 'Profil-Link', placeholder: 'https://www.provenexpert.com/…' },
  ],
  async fetch(ctx) {
    const j = must(await ctx.http('https://www.provenexpert.com/api/v1/rating/summary/get', { method: 'POST', headers: { authorization: basic(ctx.config.api_id, ctx.secrets.api_key) }, json: {} }), 'ProvenExpert');
    if (j?.status === 'error') throw new Error(`ProvenExpert: ${clip(j?.errors?.[0] ?? j?.message, 200) || 'Fehler'}`);
    const d = j?.ratingSummary ?? j?.data ?? j;
    return { reviews: [], rating: round1(num(d?.ratingValue ?? d?.rating ?? d?.averageRating)), total: num(d?.reviewCount ?? d?.ratingCount ?? d?.count), profileUrl: https(ctx.config.profile_url) || https(d?.profileUrl) };
  },
  canReply: () => false,
  replyLink: (c, r) => r.link || https(c.profile_url) || 'https://www.provenexpert.com/de-de/login/',
});

// --- Yelp Fusion (read only) ---------------------------------------------------------------------------------------------

registerReviewAdapter({
  id: 'yelp',
  label: 'Yelp',
  kind: 'api',
  mirror: true,
  hint: 'Yelp Fusion API (API-Key): Note, Anzahl und die neuesten Auszüge – nur lesen. Yelp erlaubt kein dauerhaftes Speichern: HyperLevel behält nur, was der letzte Abruf geliefert hat. Antworten auf biz.yelp.com.',
  fields: [
    { key: 'business_id', label: 'Business-ID oder Alias', required: true, placeholder: 'malerei-muster-berlin' },
    { key: 'api_key', label: 'API-Key', secret: true, required: true },
  ],
  async fetch(ctx) {
    const h = { headers: { authorization: `Bearer ${ctx.secrets.api_key}` } };
    const base = `https://api.yelp.com/v3/businesses/${encodeURIComponent(ctx.config.business_id)}`;
    const info = must(await ctx.http(base, h), 'Yelp');
    const j = must(await ctx.http(`${base}/reviews?limit=20&sort_by=newest`, h), 'Yelp');
    const reviews: ReviewIn[] = (Array.isArray(j?.reviews) ? j.reviews : []).map((r: any) => ({
      externalId: String(r.id),
      author: clip(r?.user?.name, 200) || 'Yelp-Nutzer',
      authorUrl: https(r?.user?.profile_url),
      rating: stars(r?.rating),
      text: clip(r?.text, 5000),
      publishedAt: iso(String(r?.time_created ?? '').replace(' ', 'T')),
      link: https(r?.url) || https(info?.url),
    }));
    return { reviews, rating: round1(num(info?.rating)), total: num(info?.review_count), name: clip(info?.name, 200), profileUrl: https(info?.url) };
  },
  canReply: () => false,
  replyLink: (_c, r) => r.link || 'https://biz.yelp.com/',
});

// --- Tripadvisor Content API (read only) -------------------------------------------------------------------------------------

registerReviewAdapter({
  id: 'tripadvisor',
  label: 'Tripadvisor',
  kind: 'api',
  mirror: true,
  hint: 'Tripadvisor Content API (API-Key, Domain in der Freigabeliste): Note, Anzahl und die fünf neuesten Bewertungen – nur lesen. Antworten im Tripadvisor Management Center.',
  fields: [
    { key: 'location_id', label: 'Location-ID', required: true, placeholder: 'z. B. 1234567' },
    { key: 'api_key', label: 'API-Key', secret: true, required: true },
    { key: 'language', label: 'Sprache', placeholder: 'de' },
  ],
  async fetch(ctx) {
    const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(ctx.config.language ?? '') ? ctx.config.language : 'de';
    const base = `https://api.content.tripadvisor.com/api/v1/location/${encodeURIComponent(ctx.config.location_id)}`;
    const q = `key=${encodeURIComponent(ctx.secrets.api_key)}&language=${lang}`;
    const info = must(await ctx.http(`${base}/details?${q}`, { headers: { accept: 'application/json' } }), 'Tripadvisor');
    const j = must(await ctx.http(`${base}/reviews?${q}`, { headers: { accept: 'application/json' } }), 'Tripadvisor');
    const reviews: ReviewIn[] = (Array.isArray(j?.data) ? j.data : []).map((r: any) => ({
      externalId: String(r.id),
      author: clip(r?.user?.username, 200) || 'Tripadvisor-Nutzer',
      rating: stars(r?.rating),
      title: clip(r?.title, 300),
      text: clip(r?.text, 5000),
      language: clip(r?.lang, 12),
      publishedAt: iso(r?.published_date),
      link: https(r?.url) || https(info?.web_url),
    }));
    return { reviews, rating: round1(num(info?.rating)), total: num(info?.num_reviews), name: clip(info?.name, 200), profileUrl: https(info?.web_url) };
  },
  canReply: () => false,
  replyLink: (_c, r) => r.link || 'https://www.tripadvisor.com/Owners',
});

// --- generic import: CSV, RSS/Atom, web hook (Jameda, Kununu, …) ------------------------------------------------------------

/** A rating written in text: "4,5/5", "4 von 5", "★★★★☆". */
export function ratingFromText(s: string): number | null {
  const m = /(\d(?:[.,]\d)?)\s*(?:\/|von|of|out of)\s*5\b/i.exec(s);
  if (m) return stars(Number(m[1].replace(',', '.')));
  const full = (s.match(/★/g) ?? []).length;
  return full ? stars(full) : null;
}

/** One review from a CSV row or a web hook body (German or English keys). */
export function reviewFromRecord(r: Record<string, unknown>, fallbackLink = ''): ReviewIn | null {
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = r[k] ?? r[k.toLowerCase()];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };
  const text = clip(pick('text', 'comment', 'kommentar', 'bewertung', 'review', 'body', 'content'), 5000);
  const rating = stars(Number(pick('rating', 'stars', 'sterne', 'note', 'score').replace(',', '.'))) ?? ratingFromText(text);
  const author = clip(pick('author', 'name', 'autor', 'verfasser', 'reviewer'), 200);
  if (!text && rating === null) return null;
  const published = iso(pick('date', 'published_at', 'datum', 'created_at', 'time'));
  const link = https(pick('link', 'url')) || fallbackLink;
  const ext = clip(pick('id', 'external_id', 'review_id'), 200) || sha256(`${author}|${published ?? ''}|${text}`).slice(0, 40);
  return { externalId: ext, author: author || 'Anonym', rating, title: clip(pick('title', 'titel', 'headline'), 300), text, publishedAt: published, link, replyText: clip(pick('reply', 'antwort', 'response'), 5000) };
}

/** CSV with a header row → reviews (rows without text and rating are skipped). */
export function reviewsFromCsv(csv: string, fallbackLink = ''): ReviewIn[] {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows
    .slice(1, 5001)
    .map((cells) => reviewFromRecord(Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])), fallbackLink))
    .filter((x): x is ReviewIn => !!x);
}

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim();
};
const attr = (xml: string, name: string, a: string) => new RegExp(`<${name}[^>]*\\s${a}="([^"]*)"`, 'i').exec(xml)?.[1] ?? '';
const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** RSS 2.0 or Atom → reviews (a rating in the title or text is read; up to 100 items). */
export function reviewsFromFeed(xml: string): ReviewIn[] {
  const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, 100).map((m) => m[0]);
  const out: ReviewIn[] = [];
  for (const it of items) {
    const title = plain(tag(it, 'title'));
    const text = plain(tag(it, 'description') || tag(it, 'content:encoded') || tag(it, 'content') || tag(it, 'summary')).slice(0, 5000);
    const link = https(plain(tag(it, 'link'))) || https(attr(it, 'link', 'href'));
    const published = iso(plain(tag(it, 'pubDate') || tag(it, 'published') || tag(it, 'updated') || tag(it, 'dc:date')));
    const author = plain(tag(it, 'dc:creator') || tag(tag(it, 'author') || '', 'name') || tag(it, 'author')).slice(0, 200);
    const rating = ratingFromText(`${title} ${text}`);
    if (!text && !title) continue;
    const guid = plain(tag(it, 'guid') || tag(it, 'id')) || link;
    out.push({ externalId: (guid || sha256(`${title}|${text}`)).slice(0, 300), author: author || 'Anonym', rating, title: title.slice(0, 300), text: text || title, publishedAt: published, link });
  }
  return out;
}

registerReviewAdapter({
  id: 'import',
  label: 'Import (CSV, RSS, Web-Hook)',
  kind: 'import',
  hint: 'Für Plattformen ohne offizielle API (Jameda, Kununu, Golocal, …): CSV hochladen, einen RSS-/Atom-Feed abonnieren oder Bewertungen per Web-Hook schicken (z. B. aus Zapier/Make). Geantwortet wird auf der Plattform.',
  fields: [
    { key: 'platform_label', label: 'Plattform', required: true, placeholder: 'Jameda' },
    { key: 'profile_url', label: 'Profil-Link (zum Antworten)', placeholder: 'https://www.jameda.de/…' },
    { key: 'rss_url', label: 'RSS-/Atom-Feed (optional)', placeholder: 'https://…/feed.xml' },
  ],
  async fetch(ctx) {
    if (!ctx.config.rss_url) return { reviews: [] };
    if (!ctx.fetchUrl) throw new Error('Feed kann nicht geladen werden');
    return { reviews: reviewsFromFeed(await ctx.fetchUrl(ctx.config.rss_url)), profileUrl: https(ctx.config.profile_url) };
  },
  canReply: () => false,
  replyLink: (c, r) => r.link || https(c.profile_url),
});
