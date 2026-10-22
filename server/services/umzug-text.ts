import { slugify } from '../core/util.js';

/**
 * Pure helpers of the switch-over importers (Umzug): dates, money, keys, HTML → text/Markdown and the
 * conversion of other tools' merge tags into ours. No imports from the app – unit-testable on their own.
 */

export const UNSUB_TOKEN = '%%unsubscribe_url%%';

/** ISO timestamp from ISO, "YYYY-MM-DD HH:MM:SS" (Pipedrive, UTC), epoch seconds/milliseconds or a Date. */
export function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let d: Date;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e11 ? n * 1000 : n);
  } else {
    const s = String(v).trim();
    // "2024-05-01 14:30:00" has no zone: the vendors send UTC.
    d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}Z` : s);
  }
  return Number.isNaN(d.getTime()) || d.getFullYear() < 1900 || d.getFullYear() > 2100 ? undefined : d.toISOString();
}

export function toDay(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Mailchimp birthdays are MM/DD (no year): not a date we can keep.
  if (/^\d{1,2}\/\d{1,2}$/.test(s)) return undefined;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return toIso(s)?.slice(0, 10);
}

/** "1.234,50", "1234.5", 4500 → cents. Vendors that already send cents pass `cents: true`. */
export function toCents(v: unknown, opts: { cents?: boolean } = {}): number {
  if (v === undefined || v === null || v === '') return 0;
  let n: number;
  if (typeof v === 'number') n = v;
  else {
    let s = String(v).replace(/[^\d.,-]/g, '');
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.');
    n = Number(s);
  }
  if (!Number.isFinite(n)) return 0;
  return Math.round(opts.cents ? n : n * 100);
}

/** Key of a custom field from a label or tag ("Lieblings-Farbe" → lieblings_farbe). */
export function fieldKey(label: string): string {
  const k = String(label ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return k || slugify(label).replace(/-/g, '_').slice(0, 60) || 'feld';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function stripHtml(html: unknown): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Scripts, event handlers and javascript: links out of imported HTML (it ends up in mails and previews). */
export function cleanHtml(html: unknown): string {
  return String(html ?? '')
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

/** Simple HTML → Markdown for lesson texts (headings, paragraphs, lists, links, emphasis, images, quotes). */
export function htmlToMarkdown(html: unknown): string {
  let s = cleanHtml(html);
  if (!/<[a-z][\s\S]*>/i.test(s)) return decodeEntities(s).trim();
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Math.min(Number(n), 4))} ${stripHtml(t)}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, a: string, b: string, t: string) => {
      const url = (a ?? b ?? '').trim();
      const label = stripHtml(t) || url;
      return /^(https?:|mailto:|\/)/i.test(url) ? `[${label}](${url})` : label;
    })
    .replace(/<img\b[^>]*src\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, a: string, b: string) => {
      const url = (a ?? b ?? '').trim();
      return /^https?:/i.test(url) ? `\n\n![](${url})\n\n` : '';
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t: string) => `\n\n${stripHtml(t).split('\n').map((l) => `> ${l}`).join('\n')}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `\n- ${stripHtml(t).replace(/\n+/g, ' ')}`)
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<\s*br\s*\/?>/gi, '  \n')
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Source key of a vendor whose merge tags are known (see TAGS). */
export type Vendor = string;

const COMMON: Record<string, string> = { first_name: '{{contact.first_name|}}', last_name: '{{contact.last_name|}}', email: '{{contact.email}}', phone: '{{contact.phone|}}', company: '{{contact.company|}}', unsub: UNSUB_TOKEN };

/** [pattern, replacement] per vendor; the pattern's first capture is the tag's name, upper-cased. */
const TAGS: Record<string, { re: RegExp; map: (name: string) => string | undefined }> = {
  mailchimp: {
    re: /\*\|([A-Za-z0-9_:.\-/ ]+?)\|\*/g,
    map: (n) => {
      const k = n.toUpperCase().replace(/^LIST:/, '');
      return ({ FNAME: COMMON.first_name, LNAME: COMMON.last_name, EMAIL: COMMON.email, PHONE: COMMON.phone, COMPANY: COMMON.company, UNSUB: COMMON.unsub, UPDATE_PROFILE: COMMON.unsub, CURRENT_YEAR: String(new Date().getFullYear()), 'LIST:COMPANY': COMMON.company, 'MC:SUBJECT': '', 'MC:PREVIEW_TEXT': '' } as Record<string, string>)[k];
    },
  },
  activecampaign: {
    re: /%([A-Z0-9_]+)%/g,
    map: (n) => ({ FIRSTNAME: COMMON.first_name, LASTNAME: COMMON.last_name, EMAIL: COMMON.email, PHONE: COMMON.phone, ORGNAME: COMMON.company, UNSUBSCRIBELINK: COMMON.unsub, UNSUBSCRIBE: COMMON.unsub })[n] as string | undefined,
  },
  keap: {
    re: /~([A-Za-z0-9_.]+)~/g,
    map: (n) => ({ 'Contact.FirstName': COMMON.first_name, 'Contact.LastName': COMMON.last_name, 'Contact.Email': COMMON.email, 'Contact.Phone1': COMMON.phone, 'Contact.Company': COMMON.company })[n] as string | undefined,
  },
  kit: {
    re: /\{\{\s*([A-Za-z0-9_.]+)(?:\s*\|[^}]*)?\s*\}\}/g,
    map: (n) => ({ 'subscriber.first_name': COMMON.first_name, 'subscriber.email_address': COMMON.email, first_name: COMMON.first_name, email_address: COMMON.email, unsubscribe_url: COMMON.unsub })[n.toLowerCase()] as string | undefined,
  },
};

TAGS.systeme = {
  re: /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g,
  map: (n) => ({ 'contact.first_name': COMMON.first_name, 'contact.surname': COMMON.last_name, 'contact.last_name': COMMON.last_name, 'contact.email': COMMON.email, 'contact.phone_number': COMMON.phone, 'contact.company_name': COMMON.company })[n] as string | undefined,
};

TAGS.klaviyo = {
  // {{ first_name|default:"there" }}, {{ person.email }}, {% unsubscribe %} – the first word inside the braces is the name.
  re: /(?:\{\{\s*|\{%\s*)([A-Za-z0-9_.]+)[^}%]*?(?:\}\}|%\})/g,
  map: (n) =>
    ({ first_name: COMMON.first_name, 'person.first_name': COMMON.first_name, last_name: COMMON.last_name, 'person.last_name': COMMON.last_name, email: COMMON.email, 'person.email': COMMON.email, phone_number: COMMON.phone, 'person.phone_number': COMMON.phone, unsubscribe: COMMON.unsub, unsubscribe_link: COMMON.unsub, manage_preferences: COMMON.unsub })[n] as string | undefined,
};

TAGS.brevo = {
  // {{ contact.FIRSTNAME }}, {{ contact.EMAIL }}, {{ unsubscribe }}, {{ update_profile }}
  re: /\{\{\s*([A-Za-z0-9_.\-]+)[^}]*\}\}/g,
  map: (n) => ({ 'contact.FIRSTNAME': COMMON.first_name, 'contact.LASTNAME': COMMON.last_name, 'contact.EMAIL': COMMON.email, 'contact.SMS': COMMON.phone, 'contact.COMPANY': COMMON.company, unsubscribe: COMMON.unsub, update_profile: COMMON.unsub, unsubscribe_url: COMMON.unsub })[n] as string | undefined,
};

/** Does this source have a merge-tag converter (templates, mails of workflow drafts)? */
export const hasMergeTags = (v: string): boolean => Object.prototype.hasOwnProperty.call(TAGS, v);

/** Converts another tool's merge tags; returns the new text and the tags that had no equivalent. */
export function convertMergeTags(vendor: Vendor, text: string): { text: string; unknown: string[] } {
  const spec = TAGS[vendor];
  if (!spec) return { text, unknown: [] };
  const unknown = new Set<string>();
  const out = text.replace(spec.re, (m, name: string) => {
    const r = spec.map(name.trim());
    if (r !== undefined) return r;
    unknown.add(m);
    return m;
  });
  return { text: out, unknown: [...unknown] };
}

/** First non-empty value. */
export const first = <T>(...v: (T | undefined | null | '')[]): T | undefined => v.find((x) => x !== undefined && x !== null && x !== '') as T | undefined;

/** Splits "a, b; c | d" into trimmed, unique, non-empty parts. */
export function splitList(v: unknown, sep = /[,;|]/): string[] {
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  return [...new Set(String(v ?? '').split(sep).map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean))];
}

export const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

/** Euro amount from cents with German formatting, for report lines. */
export const eur = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format((cents || 0) / 100);
