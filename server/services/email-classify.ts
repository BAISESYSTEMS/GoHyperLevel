import { sha256 } from '../core/util.js';

/**
 * Who loaded a tracking pixel or followed a tracked link? Heuristics that tell a person from a machine.
 *
 * Mail clients and security gateways fetch mail content on their own: Apple Mail Privacy Protection, Gmail's image
 * proxy and Yahoo's proxy load every pixel when the mail arrives (the person may never read it); corporate scanners
 * (Microsoft Defender / Safe Links, Mimecast, Proofpoint, Barracuda …) follow every link seconds after delivery,
 * often with a HEAD request or a bot signature. Counting those as "opened" and "clicked" makes the numbers – and
 * every workflow that reacts to them – wrong. Nothing here is perfect (a scanner can look exactly like Chrome); the
 * rules are deliberately transparent and documented in docs/email-tracking.md, and every verdict keeps its reason.
 *
 * Pure functions, no database: the module that records the hits (modules/tracking.ts) feeds the signals in.
 */

export type EventKind = 'open' | 'click';
/** human = counts; proxy = a mail provider loaded it for the recipient; scanner = a security tool or bot followed it. */
export type Verdict = 'human' | 'proxy' | 'scanner';

/** An open within this long after sending is a prefetch (images are loaded on delivery, before anyone could read it). */
export const OPEN_FAST_MS = 5_000;
/** A click within this long after sending is a security scanner: nobody reads a mail and clicks in under ten seconds. */
export const CLICK_FAST_MS = 10_000;
/** Two different links of one mail clicked within this window: one person cannot do that, a scanner always does. */
export const BURST_WINDOW_MS = 2_000;
export const BURST_MIN_LINKS = 2;

export interface HitSignals {
  kind: EventKind;
  method: string;
  userAgent: string;
  /** The full address – only used here (Apple's range); never stored. */
  ip: string;
  /** Browsers always send Accept-Language; HTTP libraries (and most scanners) do not. */
  hasAcceptLanguage: boolean;
  /** Purpose / Sec-Purpose / X-Purpose / X-Moz header that says "prefetch" or "preview". */
  prefetch: boolean;
  /** When the mail was sent and when this hit arrived (epoch ms). NaN/undefined = unknown, timing rules are skipped. */
  sentAtMs?: number;
  atMs: number;
  /** Clicks only: how many *other* links of the same mail were hit within BURST_WINDOW_MS before this one. */
  otherLinksInBurst?: number;
}

export type Reason =
  | 'head-request'
  | 'prefetch'
  | 'scanner-ua'
  | 'bot-ua'
  | 'proxy-ua'
  | 'apple-mpp'
  | 'no-user-agent'
  | 'fast-open'
  | 'fast-click'
  | 'link-burst'
  | 'no-browser-headers'
  | 'human';

export const REASON_LABEL: Record<Reason, string> = {
  'head-request': 'Prüfabruf ohne Inhalt (HEAD)',
  prefetch: 'Vorab-Abruf des Browsers oder Mailprogramms',
  'scanner-ua': 'Sicherheits-Scanner (z. B. Defender, Mimecast, Proofpoint)',
  'bot-ua': 'Bot oder Link-Vorschau',
  'proxy-ua': 'Bild-Proxy des Mailanbieters (z. B. Gmail, Yahoo)',
  'apple-mpp': 'Apple Mail Datenschutz (lädt Bilder vorab)',
  'no-user-agent': 'Ohne Browserkennung',
  'fast-open': 'Sofort nach dem Versand geladen (Vorab-Abruf)',
  'fast-click': 'Sofort nach dem Versand geklickt (Sicherheits-Scanner)',
  'link-burst': 'Mehrere Links innerhalb von Sekunden (Scanner)',
  'no-browser-headers': 'Kein Browser (typische Kopfzeilen fehlen)',
  human: 'Mensch',
};

/**
 * Security gateways and other tools that follow links to check them. Vendor names first, then generic bot words.
 * Matched case-insensitively against the User-Agent.
 */
const SCANNER_UA = new RegExp(
  [
    'safelinks', 'microsoft[ -]?defender', 'microsoft[ -]?atp', 'ms[ -]?office[ -]?protocol', 'microsoftpreview', 'office365[ -]?(?:link|safe)',
    'mimecast', 'proofpoint', 'urldefense', 'barracuda', 'forcepoint', 'websense', 'symantec', 'messagelabs', 'trend ?micro', 'tmufe', 'sophos',
    'fireeye', 'zscaler', 'mcafee', 'ironport', 'cisco[ -]?(?:esa|umbrella|secure)', 'fortinet', 'fortimail', 'fortigate', 'kaspersky', 'avast',
    'bitdefender', 'f-secure', '\\beset\\b', 'check ?point', 'cloudmark', 'vade ?secure', 'hornetsecurity', 'libraesva', 'abnormal', 'avanan', 'darktrace',
    'trustwave', 'mailguard', 'spamtitan', 'spamexperts', 'cyren', 'area ?1', 'ironscales', 'knowbe4', 'cofense', 'phishme', 'urlscan', 'virustotal',
  ].join('|'),
  'i',
);

/** Everything that fetches a URL without being a person's browser: libraries, headless browsers, crawlers, link previews. */
const BOT_UA = new RegExp(
  [
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'python-requests', 'python-urllib', 'aiohttp', 'httpx', '(?:^|[^a-z])curl/', 'wget',
    'libwww-perl', 'go-http-client', '(?:^|[^a-z])java/', 'apache-httpclient', 'node-fetch', 'axios', 'postmanruntime', 'slackbot',
    'slack-imgproxy', 'facebookexternalhit', 'facebot', 'whatsapp', 'telegrambot', 'twitterbot', 'linkedinbot', 'discordbot', 'skypeuripreview', 'bingpreview',
    'googlebot', 'google-read-aloud', 'google-inspectiontool', 'bingbot', 'yandexbot', 'duckduckbot', 'applebot', 'pingdom', 'uptimerobot', 'datadog',
    'bot\\b', 'crawler', 'spider', 'scanner', 'fetcher', 'monitor', 'checker', 'validator', 'prefetch', 'link ?preview', 'linkcheck',
  ].join('|'),
  'i',
);

/** Mail providers that load images through their own proxy (the recipient's real address is hidden, the load happens on delivery or open). */
const PROXY_UA = /googleimageproxy|ggpht\.com|yahoomailproxy|yahoocachesystem|yahoo! slurp|(?:image|mail|privacy)[ -]?proxy|protonmail|proton mail|fastmailproxy|seznamemailproxy|apple-?mail-?privacy/i;

const norm = (ua: string) => String(ua ?? '').trim();

/** Apple Mail Privacy Protection loads images with a bare "Mozilla/5.0" (no engine, no platform, no version). */
const isBareMozilla = (ua: string) => /^mozilla\/5\.0$/i.test(norm(ua));

/** Apple owns 17.0.0.0/8; Mail Privacy Protection fetches come from it (and from relays, which this cannot see). */ // oss-check: allow (Apple MPP range, public)
export function isAppleIp(ip: string): boolean {
  const m = String(ip ?? '').trim().match(/^(?:::ffff:)?(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i);
  return !!m && Number(m[1]) === 17;
}

/**
 * The verdict for one hit. Order matters: the most certain signals first. The same inputs always give the same answer.
 *
 *  1. HEAD request                      → scanner (browsers never HEAD a link; scanners do)
 *  2. prefetch header                   → proxy
 *  3. security vendor in the UA         → scanner;  bot / library / preview in the UA → scanner
 *  4. provider image proxy in the UA    → proxy
 *  5. opens: bare "Mozilla/5.0" or Apple's address range → proxy (Apple Mail Privacy Protection)
 *  6. no UA at all                      → opens: proxy, clicks: scanner
 *  7. open within OPEN_FAST_MS of sending  → proxy (prefetch on delivery)
 *     click within CLICK_FAST_MS of sending → scanner
 *  8. click that is the 2nd+ different link within BURST_WINDOW_MS → scanner
 *  9. click without Accept-Language     → scanner (HTTP library, not a browser)
 * Anything else is a person.
 */
export function classifyHit(h: HitSignals): { verdict: Verdict; reason: Reason } {
  const ua = norm(h.userAgent);
  const click = h.kind === 'click';
  if (h.method.toUpperCase() === 'HEAD') return { verdict: 'scanner', reason: 'head-request' };
  if (h.prefetch) return { verdict: 'proxy', reason: 'prefetch' };
  if (SCANNER_UA.test(ua)) return { verdict: 'scanner', reason: 'scanner-ua' };
  if (PROXY_UA.test(ua)) return { verdict: 'proxy', reason: 'proxy-ua' };
  if (BOT_UA.test(ua)) return { verdict: 'scanner', reason: 'bot-ua' };
  if (!click && (isBareMozilla(ua) || isAppleIp(h.ip))) return { verdict: 'proxy', reason: 'apple-mpp' };
  if (!ua) return click ? { verdict: 'scanner', reason: 'no-user-agent' } : { verdict: 'proxy', reason: 'no-user-agent' };
  const since = h.sentAtMs !== undefined && Number.isFinite(h.sentAtMs) ? h.atMs - h.sentAtMs : undefined;
  if (since !== undefined) {
    if (click && since < CLICK_FAST_MS) return { verdict: 'scanner', reason: 'fast-click' };
    if (!click && since < OPEN_FAST_MS) return { verdict: 'proxy', reason: 'fast-open' };
  }
  if (click && (h.otherLinksInBurst ?? 0) + 1 >= BURST_MIN_LINKS) return { verdict: 'scanner', reason: 'link-burst' };
  if (click && !h.hasAcceptLanguage) return { verdict: 'scanner', reason: 'no-browser-headers' };
  return { verdict: 'human', reason: 'human' };
}

/** A short device class for the log – instead of the raw User-Agent, which is a fingerprint. */
export function uaClass(ua: string): string {
  const s = norm(ua);
  if (!s) return 'none';
  if (isBareMozilla(s)) return 'bare';
  if (PROXY_UA.test(s)) return 'proxy';
  if (SCANNER_UA.test(s) || BOT_UA.test(s)) return 'bot';
  if (/outlook/i.test(s)) return 'outlook';
  if (/iphone|ipad|ipod/i.test(s)) return 'ios';
  if (/android/i.test(s)) return 'android';
  if (/macintosh|mac os x/i.test(s)) return 'mac';
  if (/windows nt/i.test(s)) return 'windows';
  if (/linux|x11|cros/i.test(s)) return 'linux';
  return 'other';
}

/** A short one-way hash of the User-Agent: recognises the same client again without keeping the string. */
export const uaHash = (ua: string): string => (norm(ua) ? sha256(`ua:${norm(ua)}`).slice(0, 12) : '');

function expand6(addr: string): number[] | null {
  let a = addr.split('%')[0];
  const dotted = a.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(2).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const parts = a.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The network, not the address: IPv4 /24, IPv6 /48 (data minimisation – enough to tell "Apple's relay" or "a company
 * gateway" from a home line, not enough to identify a person). "" for anything that is not an IP address.
 */
export function ipPrefix(ip: string): string {
  let a = String(ip ?? '').trim().toLowerCase();
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) a = mapped[1];
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    return o.some((n) => n > 255) ? '' : `${o[0]}.${o[1]}.${o[2]}.0/24`;
  }
  if (!a.includes(':')) return '';
  const g = expand6(a);
  return g ? `${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}::/48` : '';
}
