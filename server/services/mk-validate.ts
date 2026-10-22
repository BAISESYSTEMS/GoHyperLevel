import { domainToASCII } from 'node:url';
import { DnsFailure, systemResolver, type DnsResolver } from './umzug-mailcheck.js';

/**
 * Checks of e-mail addresses before they cost reputation: syntax, a domain that can receive mail (MX, or an A record as
 * the fallback of RFC 5321), disposable domains, role addresses (info@, support@ …) and a "did you mean" for typos in
 * well-known domains. Pure apart from the resolver, which comes in as an argument (the DNS check code of the delivery
 * check is reused; tests pass a fake). Verdicts: ok · risky (works, but a bad bet) · invalid (will bounce).
 */

export type Verdict = 'ok' | 'risky' | 'invalid';
export interface Issue {
  code: 'syntax' | 'length' | 'domain' | 'no_mx' | 'disposable' | 'role' | 'typo' | 'reserved';
  level: 'error' | 'warn';
  text: string;
}
export interface Check {
  email: string;
  verdict: Verdict;
  issues: Issue[];
  role: boolean;
  disposable: boolean;
  /** true / false when the domain was looked up, null when it was not (or the lookup failed). */
  mx: boolean | null;
  suggestion?: string;
}

const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Role addresses belong to a function, not a person: nobody consents for them, they hit spam traps and complaint buttons more often. */
const ROLES = new Set([
  'info', 'kontakt', 'contact', 'office', 'buero', 'büro', 'mail', 'post', 'hallo', 'hello', 'hi', 'support', 'service', 'kundenservice', 'sales', 'vertrieb', 'verkauf', 'marketing', 'admin',
  'administrator', 'webmaster', 'postmaster', 'hostmaster', 'abuse', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'team', 'bewerbung', 'jobs', 'karriere', 'career', 'buchhaltung',
  'rechnung', 'rechnungen', 'billing', 'accounting', 'invoice', 'newsletter', 'presse', 'press', 'datenschutz', 'privacy', 'impressum', 'security', 'root', 'mailer-daemon', 'empfang', 'zentrale', 'anfrage',
]);

/** Throw-away mailbox providers (a growing list; the check says "risky", the sub-account decides what to do with it). */
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.de', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  '10minutemail.com', '10minutemail.net', '10minemail.com', '20minutemail.com', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'tempmailo.com', 'tempail.com', 'tempinbox.com',
  'yopmail.com', 'yopmail.fr', 'yopmail.net', 'cool.fr.nf', 'jetable.fr.nf', 'nospam.ze.tc', 'nomail.xl.cx', 'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf', 'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf',
  'trashmail.com', 'trashmail.de', 'trashmail.net', 'trashmail.org', 'trashmail.me', 'trash-mail.com', 'trash-mail.de', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'wegwerfemail.de',
  'einmalmail.de', 'wegwerf-email.de', 'wegwerf-emails.de', 'mail-temporaire.fr', 'getnada.com', 'nada.email', 'dispostable.com', 'discard.email', 'discardmail.com', 'discardmail.de', 'spambog.com',
  'spambog.de', 'spambog.ru', 'spamgourmet.com', 'spamex.com', 'spamfree24.org', 'spamherelots.com', 'throwawaymail.com', 'throwaway.email', 'fakeinbox.com', 'fakemailgenerator.com', 'maildrop.cc',
  'mailnesia.com', 'mailcatch.com', 'mailforspam.com', 'mailmoat.com', 'mailnull.com', 'mytrashmail.com', 'incognitomail.com', 'incognitomail.org', 'emailondeck.com', 'getairmail.com', 'harakirimail.com',
  'inboxkitten.com', 'mohmal.com', 'burnermail.io', 'anonbox.net', 'anonymbox.com', 'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'dropmail.me', 'emailfake.com', 'fakemail.net', 'mintemail.com',
  'mt2015.com', 'owlymail.com', 'rcpt.at', 'sogetthis.com', 'sofort-mail.de', 'sneakemail.com', 'objectmail.com', 'proxymail.eu', 'zehnminuten.de', 'zehnminutenmail.de', 'byom.de', 'e4ward.com',
  'meltmail.com', 'mailtothis.com', 'kasmail.com', 'killmail.net', 'lroid.com', 'luckymail.org', 'sharedmailbox.org', 'smailpro.com', 'crazymailing.com', 'spoofmail.de', 'trbvm.com', 'wh4f.org',
]);

/** Popular domains for the "did you mean" – a typo is a domain within two edits of one of these that is not one of them. */
const POPULAR = [
  'gmail.com', 'googlemail.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de', 'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.de', 'live.com', 'yahoo.com', 'yahoo.de',
  'icloud.com', 'me.com', 'freenet.de', 'posteo.de', 'mailbox.org', 'protonmail.com', 'proton.me', 'aol.com', '1und1.de', 'online.de', 'arcor.de', 'bluewin.ch', 'msn.com', 'ymail.com',
];

/** Plain mistakes in the ending of a domain. */
const TLD_TYPOS: Record<string, string> = { con: 'com', cmo: 'com', vom: 'com', xom: 'com', ocm: 'com', comm: 'com', dee: 'de', ed: 'de', nte: 'net', ent: 'net', ogr: 'org' };

/** Levenshtein distance, early out above `max`. */
export function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** "gmial.com" → "gmail.com"; undefined when the domain looks right (or is unknown territory). */
export function suggestDomain(domain: string): string | undefined {
  const d = domain.toLowerCase();
  if (POPULAR.includes(d)) return undefined;
  const dot = d.lastIndexOf('.');
  const tld = d.slice(dot + 1);
  if (TLD_TYPOS[tld]) return `${d.slice(0, dot + 1)}${TLD_TYPOS[tld]}`;
  let best: { d: string; n: number } | undefined;
  for (const p of POPULAR) {
    const n = distance(d, p, 2);
    // Short domains (gmx.de ↔ gmx.net …) would match each other too easily: one edit at most there.
    if (n <= (p.length <= 8 ? 1 : 2) && (!best || n < best.n)) best = { d: p, n };
  }
  return best?.d;
}

const RESERVED = /^(example\.(com|org|net)|invalid|test|localhost|local)$|\.(test|invalid|localhost|example|local)$/;

export function isDisposable(domain: string): boolean {
  const d = domain.toLowerCase();
  if (DISPOSABLE.has(d)) return true;
  // Subdomains of a throw-away provider (xyz.mailinator.com).
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join('.'))) return true;
  return false;
}

export function isRole(local: string): boolean {
  const l = local.toLowerCase().replace(/[+].*$/, '');
  return ROLES.has(l);
}

/** Splits an address and checks its form. Returns the cleaned parts or the problems. */
export function parseEmail(input: unknown): { ok: true; email: string; local: string; domain: string } | { ok: false; email: string; issues: Issue[] } {
  const raw = String(input ?? '').trim().toLowerCase().replace(/^mailto:/, '');
  const fail = (code: Issue['code'], text: string) => ({ ok: false as const, email: raw, issues: [{ code, level: 'error' as const, text }] });
  if (!raw) return fail('syntax', 'Keine Adresse angegeben');
  if (raw.length > 254) return fail('length', 'Die Adresse ist zu lang (höchstens 254 Zeichen)');
  const at = raw.lastIndexOf('@');
  if (at < 1 || raw.indexOf('@') !== at) return fail('syntax', at < 0 ? 'Das @-Zeichen fehlt' : 'Genau ein @-Zeichen ist erlaubt');
  const local = raw.slice(0, at);
  const host = raw.slice(at + 1);
  if (local.length > 64) return fail('length', 'Der Teil vor dem @ ist zu lang (höchstens 64 Zeichen)');
  if (/\s/.test(raw) || !LOCAL.test(local)) return fail('syntax', 'Der Teil vor dem @ enthält unzulässige Zeichen oder Punkte an der falschen Stelle');
  const domain = domainToASCII(host.replace(/\.$/, ''));
  if (!domain || domain.length > 253) return fail('domain', 'Die Domain nach dem @ ist ungültig');
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,63}$|^xn--[a-z0-9-]{2,59}$/.test(labels[labels.length - 1])) return fail('domain', 'Die Domain nach dem @ ist ungültig (z. B. „firma.de“)');
  return { ok: true, email: `${local}@${domain}`, local, domain };
}

/** The checks that need no network. */
export function checkStatic(input: unknown): Check {
  const p = parseEmail(input);
  if (!p.ok) return { email: p.email, verdict: 'invalid', issues: p.issues, role: false, disposable: false, mx: null };
  const issues: Issue[] = [];
  const disposable = isDisposable(p.domain);
  const role = isRole(p.local);
  if (RESERVED.test(p.domain)) issues.push({ code: 'reserved', level: 'warn', text: 'Beispiel- oder Test-Domain – hier kommt nichts an' });
  if (disposable) issues.push({ code: 'disposable', level: 'warn', text: 'Wegwerf-Adresse: Das Postfach verschwindet nach kurzer Zeit' });
  if (role) issues.push({ code: 'role', level: 'warn', text: 'Funktionsadresse (z. B. info@): gehört keiner Person, wird oft als Spam gemeldet' });
  const suggestion = suggestDomain(p.domain);
  if (suggestion) issues.push({ code: 'typo', level: 'warn', text: `Tippfehler? Meintest du @${suggestion}` });
  return { email: p.email, verdict: issues.length ? 'risky' : 'ok', issues, role, disposable, mx: null, ...(suggestion ? { suggestion: `${p.local}@${suggestion}` } : {}) };
}

/** Domains looked up recently, so a list with 5 000 addresses at gmail.com asks DNS once. Failures are not remembered. */
const cache = new Map<string, { at: number; mx: boolean }>();
const CACHE_MS = 6 * 3600_000;

/** Can this domain receive mail? true / false; throws DnsFailure when DNS itself did not answer (then nothing can be said). */
export async function domainAcceptsMail(domain: string, r: DnsResolver): Promise<boolean> {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.mx;
  const mx = await r.resolveMx(domain);
  let ok: boolean;
  if (mx.length) {
    // RFC 7505 "null MX": a single "." says the domain takes no mail at all.
    ok = !(mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.'));
  } else {
    // No MX record: mail goes to the domain's own address (RFC 5321 §5.1), if it has one.
    ok = (await r.resolve4(domain)).length > 0;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(domain, { at: Date.now(), mx: ok });
  return ok;
}

export const forgetDomains = () => cache.clear();

/** The full check, with the DNS lookup (skipped without `resolver`). A DNS outage leaves `mx: null` instead of calling the address invalid. */
export async function validateEmail(input: unknown, resolver?: DnsResolver | null): Promise<Check> {
  const base = checkStatic(input);
  if (base.verdict === 'invalid' || !resolver) return base;
  const domain = base.email.split('@')[1];
  try {
    const ok = await domainAcceptsMail(domain, resolver);
    if (ok) return { ...base, mx: true };
    const issues: Issue[] = [{ code: 'no_mx', level: 'error', text: 'Die Domain nimmt keine E-Mails an (kein Mailserver eingetragen)' }, ...base.issues];
    return { ...base, mx: false, verdict: 'invalid', issues };
  } catch (e) {
    if (e instanceof DnsFailure) return base;
    throw e;
  }
}

/** Many addresses with a limited number of lookups at a time. */
export async function validateMany(emails: unknown[], resolver: DnsResolver | null | undefined, concurrency = 8): Promise<Check[]> {
  const out: Check[] = new Array(emails.length);
  let next = 0;
  const worker = async () => {
    while (next < emails.length) {
      const i = next++;
      out[i] = await validateEmail(emails[i], resolver);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length) }, worker));
  return out;
}

/** The resolver the app uses for real lookups; a test (or a locked-down server) replaces it with app.services.dnsResolver. */
export const defaultResolver = (): DnsResolver => systemResolver();

export const VERDICT_LABEL: Record<Verdict, string> = { ok: 'in Ordnung', risky: 'riskant', invalid: 'ungültig' };
