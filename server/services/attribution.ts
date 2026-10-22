import { sha256 } from '../core/util.js';

/**
 * Marketing attribution helpers (pure): where a visit came from (UTM, click ids, referrer),
 * signed visitor tokens and the consent decision. No third-party trackers – everything stays
 * on this server; the only browser storage is an optional first-party cookie.
 */

export interface Touch {
  /** campaign = UTM/click id/affiliate code, referral = another site, direct = no referrer. */
  channel: 'campaign' | 'referral' | 'direct';
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
  gclid: string;
  fbclid: string;
  /** Other ad click ids (msclkid, ttclid, gbraid/wbraid, li_fat_id) as "name:value". */
  click_id: string;
  /** Affiliate code from ?ref= (also ?aff= / ?am_id=). */
  ref: string;
  /** host + path of the referring page, never its query string. */
  referrer: string;
  /** origin + path of the landing page, never its query string (may hold e-mails or tokens). */
  landing_page: string;
  /** The referrer is a page of the same site (navigation inside a funnel). */
  internal: boolean;
}

/** A stored touch (row of attribution_touches). */
export interface TouchRow extends Omit<Touch, 'internal'> {
  id: string;
  location_id: string;
  visitor_id: string | null;
  contact_id: string | null;
  kind: string;
  funnel_id: string | null;
  page_id: string | null;
  created_at: string;
}

/** Other modules react to attribution through app.services.attributionHooks. */
export interface AttributionHook {
  /** A visit was recorded (e.g. affiliate click counting). */
  onTouch?: (e: { locationId: string; visitorId: string; touch: TouchRow; ip: string; userAgent: string }) => void;
  /** A contact was linked to its visits (lead, booking, chat, purchase). */
  onLink?: (e: { locationId: string; contactId: string; kind: string; visitorId: string }) => void;
}

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export const CLICK_KEYS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'] as const;

const SEARCH: [string, string][] = [
  ['google.', 'google'],
  ['bing.', 'bing'],
  ['duckduckgo.', 'duckduckgo'],
  ['search.yahoo.', 'yahoo'],
  ['ecosia.', 'ecosia'],
  ['qwant.', 'qwant'],
  ['startpage.', 'startpage'],
  ['yandex.', 'yandex'],
  ['baidu.', 'baidu'],
  ['search.brave.', 'brave'],
];
const SOCIAL: [string, string][] = [
  ['facebook.com', 'facebook'],
  ['fb.com', 'facebook'],
  ['fb.me', 'facebook'],
  ['instagram.com', 'instagram'],
  ['t.co', 'twitter'],
  ['twitter.com', 'twitter'],
  ['x.com', 'twitter'],
  ['linkedin.com', 'linkedin'],
  ['lnkd.in', 'linkedin'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['tiktok.com', 'tiktok'],
  ['pinterest.', 'pinterest'],
  ['reddit.com', 'reddit'],
  ['xing.com', 'xing'],
  ['threads.net', 'threads'],
];

const clip = (v: unknown, max = 200) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, max);
export const cleanRef = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);

function safeUrl(u: unknown): URL | undefined {
  const s = String(u ?? '').trim();
  if (!s) return undefined;
  try {
    const url = new URL(s);
    return /^https?:$/.test(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');
const matches = (host: string, needle: string) => (needle.endsWith('.') ? host.includes(needle) || host.startsWith(needle) : host === needle || host.endsWith(`.${needle}`));

/** Classifies a referring host: search engine (organic), social network or a plain referral. */
export function classifyReferrer(host: string): { source: string; medium: string } {
  const h = bareHost(host);
  for (const [needle, name] of SEARCH) if (matches(h, needle)) return { source: name, medium: 'organic' };
  for (const [needle, name] of SOCIAL) if (matches(h, needle)) return { source: name, medium: 'social' };
  return { source: h, medium: 'referral' };
}

/**
 * Reads a visit: `url` is the landing page (its query string carries UTM/click ids), `params`
 * may add or override them (form fields like _utm_source), `referrer` is the previous page and
 * `selfHosts` are the hosts of this site (so funnel-internal navigation is not a new source).
 */
export function parseTouch(input: { url?: string; params?: Record<string, unknown>; referrer?: string; selfHosts?: string[] }): Touch {
  const url = safeUrl(input.url);
  const p: Record<string, string> = {};
  if (url) for (const [k, v] of url.searchParams) p[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(input.params ?? {})) if (v !== undefined && v !== null && v !== '') p[k.toLowerCase().replace(/^_/, '')] = String(v);
  const ref = safeUrl(input.referrer);
  const self = (input.selfHosts ?? []).map(bareHost);
  if (url) self.push(bareHost(url.host));
  const refHost = ref ? bareHost(ref.host) : '';
  const internal = !!refHost && self.includes(refHost);

  const t: Touch = {
    channel: 'direct',
    source: '',
    medium: '',
    campaign: clip(p.utm_campaign),
    content: clip(p.utm_content),
    term: clip(p.utm_term),
    gclid: clip(p.gclid || p.gbraid || p.wbraid, 300),
    fbclid: clip(p.fbclid, 300),
    click_id: '',
    ref: cleanRef(p.ref || p.aff || p.am_id),
    referrer: ref ? clip(`${refHost}${ref.pathname === '/' ? '' : ref.pathname}`, 300) : '',
    landing_page: url ? clip(`${url.origin}${url.pathname}`, 500) : '',
    internal,
  };
  for (const k of ['msclkid', 'ttclid', 'li_fat_id', 'gbraid', 'wbraid'] as const) if (p[k] && !t.click_id) t.click_id = clip(`${k}:${p[k]}`, 300);

  const utmSource = clip(p.utm_source).toLowerCase();
  const utmMedium = clip(p.utm_medium).toLowerCase();
  if (utmSource || utmMedium || t.campaign) {
    t.channel = 'campaign';
    t.source = utmSource || (t.gclid ? 'google' : t.fbclid ? 'facebook' : refHost && !internal ? classifyReferrer(refHost).source : '(nicht gesetzt)');
    t.medium = utmMedium || (t.gclid || p.msclkid ? 'cpc' : '(nicht gesetzt)');
  } else if (t.gclid) Object.assign(t, { channel: 'campaign', source: 'google', medium: 'cpc' });
  else if (p.msclkid) Object.assign(t, { channel: 'campaign', source: 'bing', medium: 'cpc' });
  else if (t.fbclid) Object.assign(t, { channel: 'campaign', source: 'facebook', medium: 'social' });
  else if (p.ttclid) Object.assign(t, { channel: 'campaign', source: 'tiktok', medium: 'cpc' });
  else if (p.li_fat_id) Object.assign(t, { channel: 'campaign', source: 'linkedin', medium: 'cpc' });
  else if (t.ref) Object.assign(t, { channel: 'campaign', source: 'affiliate', medium: 'affiliate', campaign: t.ref });
  else if (refHost && !internal) Object.assign(t, { channel: 'referral', ...classifyReferrer(refHost) });
  else Object.assign(t, { channel: 'direct', source: 'direct', medium: '(none)' });
  return t;
}

/** Same source/medium/campaign/ref: a reload or a second page of the same visit. */
export function sameSource(a: Pick<Touch, 'source' | 'medium' | 'campaign' | 'ref'>, b: Pick<Touch, 'source' | 'medium' | 'campaign' | 'ref'>) {
  return a.source === b.source && a.medium === b.medium && a.campaign === b.campaign && a.ref === b.ref;
}

// --- visitor tokens -----------------------------------------------------------------------

const VID = /^[A-Za-z0-9]{16,32}$/;
export function signVisitor(secret: string, vid: string): string {
  return `${vid}.${sha256(`${secret}:attr:${vid}`).slice(0, 16)}`;
}
/** The visitor id of a valid token, else ''. Cookies and page tokens use the same format. */
export function verifyVisitor(secret: string, tok: unknown): string {
  const s = String(tok ?? '');
  const [vid, sig] = s.split('.');
  if (!vid || !sig || !VID.test(vid)) return '';
  return signVisitor(secret, vid) === s ? vid : '';
}

// --- consent ------------------------------------------------------------------------------

export type CookieMode = 'consent' | 'always' | 'never';
export type ConsentState = 'granted' | 'denied' | 'unknown';
export const CONSENT_COOKIE = 'pghl_consent';
export const VISITOR_COOKIE = 'pghl_vid';

/**
 * The visitor's choice: the site's own flag (cookie `pghl_consent`, set by our banner, a
 * cookie tool or `/pghl-consent?v=1`) wins; without one, Global Privacy Control (Sec-GPC: 1)
 * counts as a no.
 */
export function consentState(cookieValue: string | undefined, gpc: string | undefined): ConsentState {
  const c = String(cookieValue ?? '').trim();
  if (/^(0|no|false|denied|deny|none|necessary)$/i.test(c)) return 'denied';
  if (/^(1|yes|true|granted|all|marketing|statistics|analytics)$/i.test(c)) return 'granted';
  if (String(gpc ?? '') === '1') return 'denied';
  return 'unknown';
}
/** May we keep the visitor cookie on the device? */
export function mayStore(mode: CookieMode, state: ConsentState): boolean {
  if (mode === 'never' || state === 'denied') return false;
  return mode === 'always' || state === 'granted';
}

/** Human labels for the stored placeholder values. */
export function sourceLabel(v: string): string {
  return v === 'direct' ? '(direkt)' : v === '(none)' ? '(keins)' : v || '(unbekannt)';
}
