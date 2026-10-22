import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';

/**
 * E-Mail-Zustellung prüfen: DNS checks for a sending domain – SPF (one record, ends in an "all", at most 10
 * lookups, contains the provider), DKIM (selector per provider, key present and strong enough), DMARC (record,
 * policy, reports), MX (and a provider's return-path record) – with German fix steps and the records to copy.
 * Pure: the resolver and the provider facts come in as arguments, so tests run without a network.
 */

export type Status = 'ok' | 'warn' | 'fail' | 'unknown';
export type CheckKey = 'spf' | 'dkim' | 'dmarc' | 'mx' | 'return_path';

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCname(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
}

export class DnsFailure extends Error {}

/** The system resolver: missing names are empty answers, everything else (timeouts, SERVFAIL) is a DnsFailure. */
export function systemResolver(): DnsResolver {
  const r = new Resolver({ timeout: 3500, tries: 2 });
  const guard =
    <T>(fn: (n: string) => Promise<T>, empty: T) =>
    async (name: string): Promise<T> => {
      try {
        return await fn(name);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN' || code === 'NOTFOUND') return empty;
        throw new DnsFailure(`${code ?? 'DNS'}: ${(e as Error).message}`);
      }
    };
  return { resolveTxt: guard((n) => r.resolveTxt(n), []), resolveMx: guard((n) => r.resolveMx(n), []), resolveCname: guard((n) => r.resolveCname(n), []), resolve4: guard((n) => r.resolve4(n), []) };
}

export interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  /** Host as DNS panels want it: "@" for the domain itself, otherwise relative ("_dmarc", "resend._domainkey"). */
  host: string;
  fqdn: string;
  value: string;
  priority?: number;
  note?: string;
}

export interface Check {
  key: CheckKey;
  label: string;
  status: Status;
  summary: string;
  found: string[];
  problems: string[];
  /** What to do, in plain German, in order. */
  steps: string[];
  /** Records to create or change – copyable. */
  records: DnsRecord[];
  /** A recommendation (not part of the overall verdict when it only warns). */
  optional?: boolean;
}

export interface DomainResult {
  domain: string;
  provider: string;
  checked_at: string;
  status: Status;
  summary: string;
  checks: Check[];
  notes: string[];
}

// --- providers ---------------------------------------------------------------------------------------------

export const MAIL_PROVIDER_KEYS = ['ses', 'postmark', 'resend', 'brevo', 'mailgun', 'smtp'] as const;
export type MailProviderKey = (typeof MAIL_PROVIDER_KEYS)[number];

export const PROVIDER_LABELS: Record<MailProviderKey, string> = { ses: 'Amazon SES', postmark: 'Postmark', resend: 'Resend', brevo: 'Brevo', mailgun: 'Mailgun', smtp: 'SMTP (eigener Server)' };
export const isMailProviderKey = (v: unknown): v is MailProviderKey => typeof v === 'string' && (MAIL_PROVIDER_KEYS as readonly string[]).includes(v);

/** Facts the provider's API gave us about this domain (expected records), if the account is connected. */
export interface ProviderFacts {
  /** DKIM records the provider wants: host (FQDN), type, expected value. */
  dkim?: { fqdn: string; type: 'TXT' | 'CNAME'; value: string }[];
  /** Other records of the provider: SPF/return path/verification, as the provider lists them. */
  other?: { fqdn: string; type: 'TXT' | 'CNAME' | 'MX'; value: string; priority?: number; note?: string }[];
  /** The provider's own verdict ("verified"). */
  verified?: boolean;
  note?: string;
}

/** SMTP hosts → their SPF include and DKIM selectors (a hint, never a promise). */
const SMTP_HINTS: [RegExp, { include: string; selectors: string[]; name: string }][] = [
  [/(gmail|google)/i, { include: '_spf.google.com', selectors: ['google'], name: 'Google Workspace' }],
  [/(office365|outlook|microsoft)/i, { include: 'spf.protection.outlook.com', selectors: ['selector1', 'selector2'], name: 'Microsoft 365' }],
  [/(ionos|1und1|1and1)/i, { include: '_spf-eu.ionos.com', selectors: ['s1', 's2'], name: 'IONOS' }],
  [/strato/i, { include: 'spf.strato.de', selectors: ['strato'], name: 'Strato' }],
  [/mailbox\.org/i, { include: 'mailbox.org', selectors: ['mbo0001', 'mbo0002'], name: 'mailbox.org' }],
  [/sendgrid/i, { include: 'sendgrid.net', selectors: ['s1', 's2'], name: 'SendGrid' }],
  [/mailjet/i, { include: 'spf.mailjet.com', selectors: ['mailjet'], name: 'Mailjet' }],
  [/(zoho)/i, { include: 'zoho.eu', selectors: ['zoho', 'zmail'], name: 'Zoho' }],
  [/(all-inkl|kasserver)/i, { include: 'spf.kasserver.com', selectors: ['default'], name: 'all-inkl' }],
];
const PROBE_SELECTORS = ['default', 'mail', 'dkim', 'selector1', 'selector2', 'google', 'k1', 'k2', 's1', 's2', 'smtp', 'mandrill'];

export function smtpHint(host: string | undefined) {
  return host ? SMTP_HINTS.find(([re]) => re.test(host))?.[1] : undefined;
}

export const SPF_INCLUDE: Partial<Record<MailProviderKey, string>> = { postmark: 'spf.mtasv.net', brevo: 'spf.brevo.com', mailgun: 'mailgun.org', ses: 'amazonses.com', resend: 'amazonses.com' };

// --- helpers --------------------------------------------------------------------------------------------------

/** Domain as an ASCII hostname, or undefined when it cannot be a sending domain. */
export function cleanDomain(input: unknown): string | undefined {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^[^@]*@/, '').replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '');
  const a = domainToASCII(s);
  if (!a || a.length > 253 || !/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(a)) return undefined;
  if (/^(localhost|example\.(com|org|net)|invalid|test|local)$/i.test(a) || /\.(local|localhost|internal|invalid|test|lan|home|corp)$/i.test(a)) return undefined;
  return a;
}

const SECOND_LEVEL = /^(co|com|org|net|ac|gov|edu|or|ne)\.[a-z]{2}$/;
/** The registrable parent of a subdomain (a heuristic: node ships no public-suffix list). */
export function parentDomain(domain: string): string | undefined {
  const parts = domain.split('.');
  const keep = SECOND_LEVEL.test(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.length > keep ? parts.slice(1).join('.') : undefined;
}

const rel = (fqdn: string, domain: string) => (fqdn === domain ? '@' : fqdn.endsWith(`.${domain}`) ? fqdn.slice(0, -domain.length - 1) : fqdn);
const rec = (domain: string, type: DnsRecord['type'], fqdn: string, value: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({ type, host: rel(fqdn, domain), fqdn, value, ...extra });
const joinTxt = (chunks: string[]) => chunks.join('');

async function txt(r: DnsResolver, name: string): Promise<string[]> {
  return (await r.resolveTxt(name)).map(joinTxt);
}

// --- SPF -----------------------------------------------------------------------------------------------------------

const SPF_TERM = /^([+\-~?]?)(all|include|a|mx|ptr|ip4|ip6|exists|redirect|exp)([:=/].*)?$/i;

/** Number of DNS lookups an SPF record causes (include/redirect followed), capped when it is clearly too many. */
export async function spfLookups(r: DnsResolver, record: string, seen = new Set<string>(), depth = 0, budget = { queries: 0 }): Promise<number> {
  let n = 0;
  for (const raw of record.trim().split(/\s+/).slice(1)) {
    const m = SPF_TERM.exec(raw);
    if (!m) continue;
    const mech = m[2].toLowerCase();
    if (['a', 'mx', 'ptr', 'exists'].includes(mech)) n++;
    if (mech === 'include' || mech === 'redirect') {
      n++;
      const target = (m[3] ?? '').replace(/^[:=]/, '').toLowerCase();
      if (!target || seen.has(target) || depth >= 6 || budget.queries >= 24) continue;
      seen.add(target);
      budget.queries++;
      let inner: string[] = [];
      try {
        inner = (await txt(r, target)).filter((x) => /^v=spf1\b/i.test(x));
      } catch {
        /* a failing include is counted as one lookup, nothing more */
      }
      if (inner[0]) n += await spfLookups(r, inner[0], seen, depth + 1, budget);
    }
  }
  return n;
}

const hasInclude = async (r: DnsResolver, record: string, include: string, depth = 0, seen = new Set<string>()): Promise<boolean> => {
  const want = include.toLowerCase();
  for (const raw of record.trim().split(/\s+/).slice(1)) {
    const m = /^[+\-~?]?(include|redirect)[:=](.+)$/i.exec(raw);
    if (!m) continue;
    const target = m[2].toLowerCase();
    if (target === want) return true;
    if (depth < 4 && !seen.has(target)) {
      seen.add(target);
      try {
        const inner = (await txt(r, target)).find((x) => /^v=spf1\b/i.test(x));
        if (inner && (await hasInclude(r, inner, include, depth + 1, seen))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
};

/** An SPF record with `include:<x>` added before its closing "all". */
export function mergeSpf(record: string | undefined, include: string): string {
  if (!record) return `v=spf1 include:${include} ~all`;
  const parts = record.trim().split(/\s+/);
  const at = parts.findIndex((p) => /^[+\-~?]?all$/i.test(p));
  const add = `include:${include}`;
  if (parts.includes(add)) return record;
  if (at < 0) return `${record.trim()} ${add} ~all`;
  return [...parts.slice(0, at), add, ...parts.slice(at)].join(' ');
}

const GENERIC_STEPS = (what: string, host: string, type: string) => [
  'Öffne die DNS-Verwaltung deiner Domain – dort, wo die Domain registriert ist oder ihre Nameserver liegen (z. B. beim Domain-Anbieter oder bei Cloudflare).',
  `Lege ${what} an: Typ ${type}, Host/Name „${host}“, Wert wie unten kopiert (falls dein Anbieter die Domain automatisch anhängt, nur den kurzen Host eintragen).`,
  'Speichern und kurz warten (meist wenige Minuten, höchstens ein paar Stunden), dann hier auf „Erneut prüfen“ klicken.',
];

async function checkSpf(r: DnsResolver, domain: string, provider: MailProviderKey, facts: ProviderFacts | undefined, smtpHost: string | undefined): Promise<Check> {
  const c: Check = { key: 'spf', label: 'SPF', status: 'ok', summary: '', found: [], problems: [], steps: [], records: [] };
  const all = (await txt(r, domain)).filter((x) => /^v=spf1\b/i.test(x));
  c.found = all;
  const include = SPF_INCLUDE[provider] ?? smtpHint(smtpHost)?.include;
  // SES and Resend send with their own return-path domain: the SPF that counts is on that subdomain, not on the main domain.
  const subdomainOnly = provider === 'ses' || provider === 'resend';
  if (!all.length) {
    c.status = 'fail';
    c.summary = 'Kein SPF-Eintrag gefunden';
    c.problems.push('Ohne SPF können Empfänger nicht prüfen, ob dein Anbieter für diese Domain senden darf – Gmail und Yahoo sortieren solche Mails aus.');
    const value = subdomainOnly ? 'v=spf1 ~all' : mergeSpf(undefined, include ?? 'DEIN-ANBIETER.example');
    c.records.push(rec(domain, 'TXT', domain, value, include ? undefined : { note: 'Ersetze DEIN-ANBIETER.example durch den Include deines Mail-Anbieters (steht in dessen Hilfe unter „SPF“).' }));
    c.steps = GENERIC_STEPS('einen TXT-Eintrag', '@', 'TXT');
    return c;
  }
  if (all.length > 1) {
    c.status = 'fail';
    c.summary = `${all.length} SPF-Einträge – erlaubt ist genau einer`;
    c.problems.push('Mehrere SPF-Einträge machen SPF ungültig („permerror“). Fasse sie zu einem zusammen.');
    const merged = all.flatMap((x) => x.split(/\s+/).slice(1).filter((p) => /^[+]?(include|a|mx|ip4|ip6)/i.test(p))).filter((p, i, l) => l.indexOf(p) === i);
    c.records.push(rec(domain, 'TXT', domain, `v=spf1 ${merged.join(' ')} ${include && !merged.includes(`include:${include}`) ? `include:${include} ` : ''}~all`.replace(/\s+/g, ' ').trim()));
    c.steps = ['Lösche alle SPF-Einträge (TXT-Einträge, die mit „v=spf1“ beginnen) der Domain bis auf einen.', 'Ersetze den verbleibenden durch den zusammengeführten Wert unten.', 'Speichern, kurz warten und erneut prüfen.'];
    return c;
  }
  const record = all[0];
  const lookups = await spfLookups(r, record);
  const parts = record.trim().split(/\s+/);
  const allTerm = parts.find((p) => /^[+\-~?]?all$/i.test(p));
  const problems: string[] = [];
  let status: Status = 'ok';
  const lift = (s: Status) => {
    if (s === 'fail' || (s === 'warn' && status === 'ok')) status = s;
  };
  if (lookups > 10) {
    lift('fail');
    problems.push(`Der Eintrag löst ${lookups} DNS-Abfragen aus – erlaubt sind 10. Darüber bricht SPF ab. Entferne nicht mehr genutzte Anbieter (include:).`);
  } else if (lookups >= 9) {
    lift('warn');
    problems.push(`Der Eintrag löst ${lookups} von höchstens 10 DNS-Abfragen aus – jeder weitere Anbieter würde ihn kaputt machen.`);
  }
  if (!allTerm) {
    lift('warn');
    problems.push('Der Eintrag endet nicht mit „~all“ oder „-all“ – ohne Abschluss ist unklar, was mit fremden Absendern passieren soll.');
  } else if (/^\+?all$/i.test(allTerm)) {
    lift('fail');
    problems.push('„+all“ erlaubt jedem, in deinem Namen zu senden. Ändere es auf „~all“ oder „-all“.');
  } else if (/^\?all$/i.test(allTerm)) {
    lift('warn');
    problems.push('„?all“ ist neutral – besser „~all“ (Verdacht) oder „-all“ (ablehnen).');
  }
  if (parts.some((p) => /^[+\-~?]?ptr/i.test(p))) {
    lift('warn');
    problems.push('Der Mechanismus „ptr“ ist veraltet und langsam – entferne ihn.');
  }
  let fixed = record;
  if (include && !subdomainOnly && !(await hasInclude(r, record, include))) {
    lift('warn');
    problems.push(`„include:${include}“ fehlt – Mails über ${PROVIDER_LABELS[provider] ?? 'deinen Anbieter'} könnten SPF nicht bestehen.`);
    fixed = mergeSpf(record, include);
  }
  if (!allTerm && fixed === record) fixed = `${record.trim()} ~all`;
  c.status = status;
  c.problems = problems;
  c.summary = status === 'ok' ? `SPF in Ordnung (${lookups} von 10 Abfragen)` : problems[0];
  if (subdomainOnly && status === 'ok') c.summary += ` – der Versand-SPF von ${PROVIDER_LABELS[provider]} liegt auf einer Unterdomain (siehe Rückweg-Domain)`;
  if (fixed !== record) {
    c.records.push(rec(domain, 'TXT', domain, fixed, { note: 'Ersetzt den bisherigen SPF-Eintrag (nicht zusätzlich anlegen).' }));
    c.steps = ['Öffne die DNS-Verwaltung deiner Domain und suche den TXT-Eintrag, der mit „v=spf1“ beginnt.', 'Ersetze seinen Wert durch den unten kopierten (nicht einen zweiten Eintrag anlegen).', 'Speichern, kurz warten und erneut prüfen.'];
  }
  void facts;
  return c;
}

// --- DKIM -----------------------------------------------------------------------------------------------------------------

/** Approximate RSA modulus size from the base64 public key (SPKI adds about 38 bytes). */
export function dkimBits(p: string): number {
  const bytes = Math.floor((p.replace(/[^A-Za-z0-9+/]/g, '').length * 3) / 4) - 38;
  return Math.round((bytes * 8) / 256) * 256;
}

interface Probe {
  fqdn: string;
  found: 'key' | 'cname-nokey' | 'revoked' | 'none';
  bits?: number;
  record?: string;
}
async function probeDkim(r: DnsResolver, fqdn: string): Promise<Probe> {
  const records = (await txt(r, fqdn)).filter((x) => /v=DKIM1|p=/i.test(x));
  const key = records.find((x) => /(^|;)\s*p=([A-Za-z0-9+/=\s]+)/i.test(x));
  if (key) {
    const p = /(?:^|;)\s*p=([A-Za-z0-9+/=\s]*)/i.exec(key)?.[1]?.replace(/\s/g, '') ?? '';
    if (p) return { fqdn, found: 'key', bits: dkimBits(p), record: key.slice(0, 120) };
    return { fqdn, found: 'revoked', record: key.slice(0, 120) };
  }
  if (records.some((x) => /(^|;)\s*p=\s*(;|$)/i.test(x))) return { fqdn, found: 'revoked' };
  const cn = await r.resolveCname(fqdn);
  return cn.length ? { fqdn, found: 'cname-nokey', record: `CNAME ${cn[0]}` } : { fqdn, found: 'none' };
}

async function checkDkim(r: DnsResolver, domain: string, provider: MailProviderKey, selector: string, facts: ProviderFacts | undefined, smtpHost: string | undefined): Promise<Check> {
  const c: Check = { key: 'dkim', label: 'DKIM', status: 'ok', summary: '', found: [], problems: [], steps: [], records: [] };
  const sel = selector.trim().toLowerCase().replace(/\._domainkey.*$/, '');
  const hosts: string[] = [];
  let required = 1;
  let probing = false;
  if (facts?.dkim?.length) {
    for (const d of facts.dkim) hosts.push(d.fqdn);
    required = hosts.length;
    c.records.push(...facts.dkim.map((d) => rec(domain, d.type, d.fqdn, d.value)));
  } else if (sel) {
    hosts.push(`${sel}._domainkey.${domain}`);
  } else if (provider === 'resend') {
    hosts.push(`resend._domainkey.${domain}`);
    c.records.push(rec(domain, 'TXT', `resend._domainkey.${domain}`, 'p=… (Wert aus deinem Resend-Konto: Domains → deine Domain → DKIM)', { note: 'Den langen Wert zeigt Resend an – 1:1 kopieren.' }));
  } else if (provider === 'brevo') {
    required = 2;
    hosts.push(`brevo1._domainkey.${domain}`, `brevo2._domainkey.${domain}`);
    c.records.push(rec(domain, 'CNAME', `brevo1._domainkey.${domain}`, `b1.${domain.replace(/\./g, '-')}.dkim.brevo.com`), rec(domain, 'CNAME', `brevo2._domainkey.${domain}`, `b2.${domain.replace(/\./g, '-')}.dkim.brevo.com`));
  } else if (provider === 'mailgun') {
    hosts.push(`smtp._domainkey.${domain}`, `mx._domainkey.${domain}`, `k1._domainkey.${domain}`);
    probing = true;
  } else if (provider === 'ses') {
    required = 3;
    c.records.push(rec(domain, 'CNAME', `TOKEN1._domainkey.${domain}`, 'TOKEN1.dkim.amazonses.com', { note: 'Drei Einträge (TOKEN1–3): die Werte stehen in SES unter „Verified identities → deine Domain → DKIM“ – oder verbinde SES hier, dann zeige ich sie dir direkt.' }));
  } else if (provider === 'postmark') {
    c.records.push(rec(domain, 'TXT', `SELEKTOR._domainkey.${domain}`, 'k=rsa; p=… (Wert aus Postmark: Sender Signatures → DNS Settings)', { note: 'Der Selektor sieht aus wie 20240101120000pm und steht in Postmark – trage ihn oben im Feld „DKIM-Selektor“ ein, dann prüfe ich ihn.' }));
  } else {
    const hint = smtpHint(smtpHost);
    for (const s of hint?.selectors ?? PROBE_SELECTORS) hosts.push(`${s}._domainkey.${domain}`);
    probing = true;
  }
  if (!hosts.length) {
    c.status = 'unknown';
    c.summary = provider === 'postmark' ? 'Selektor fehlt – bitte aus Postmark eintragen' : 'Selektor unbekannt';
    c.problems.push('Ohne den Selektor des Anbieters kann ich den DKIM-Schlüssel nicht abfragen.');
    c.steps = ['Öffne bei deinem Anbieter die Seite zu DKIM/Domain-Verifizierung und kopiere den Selektor (der Teil vor „._domainkey“).', 'Trage ihn hier im Feld „DKIM-Selektor“ ein und prüfe erneut.'];
    return c;
  }
  const probes: Probe[] = [];
  for (const h of hosts.slice(0, 14)) probes.push(await probeDkim(r, h));
  const good = probes.filter((p) => p.found === 'key');
  c.found = probes.filter((p) => p.found !== 'none').map((p) => `${p.fqdn}: ${p.found === 'key' ? `Schlüssel gefunden (≈ ${p.bits} Bit)` : p.found === 'revoked' ? 'Schlüssel zurückgezogen (p= leer)' : (p.record ?? 'CNAME ohne Schlüssel')}`);
  if (probing) {
    if (good.length) {
      c.status = 'ok';
      c.summary = `DKIM-Schlüssel gefunden (${good.map((g) => g.fqdn.split('._domainkey')[0]).join(', ')})`;
    } else {
      c.status = 'warn';
      c.summary = `Kein DKIM-Schlüssel unter den üblichen Selektoren gefunden (${hosts.map((h) => h.split('._domainkey')[0]).join(', ')})`;
      c.problems.push('Dein Anbieter nutzt vermutlich einen anderen Selektor – oder DKIM ist nicht eingerichtet. Ohne DKIM landen Mails häufiger im Spam.');
      c.steps = ['Öffne bei deinem Anbieter die Einstellungen zu DKIM und kopiere den Selektor und den Eintrag.', 'Trage den Selektor hier im Feld „DKIM-Selektor“ ein, damit ich genau ihn prüfe.', 'Fehlt der Eintrag noch in deinem DNS: dort als TXT-Eintrag anlegen (Host: SELEKTOR._domainkey).'];
    }
  } else if (good.length >= required) c.summary = required > 1 ? `Alle ${required} DKIM-Einträge vorhanden` : `DKIM-Schlüssel vorhanden (≈ ${good[0].bits} Bit)`;
  else if (good.length) {
    c.status = 'warn';
    c.summary = `${good.length} von ${required} DKIM-Einträgen vorhanden`;
  } else {
    c.status = 'fail';
    c.summary = probes.some((p) => p.found === 'revoked') ? 'DKIM-Schlüssel wurde zurückgezogen' : 'Kein DKIM-Schlüssel gefunden';
  }
  if (!probing && c.status !== 'ok') {
    c.problems.push(...probes.filter((p) => p.found !== 'key').map((p) => `${p.fqdn}: ${p.found === 'revoked' ? 'Schlüssel leer (zurückgezogen)' : p.found === 'cname-nokey' ? 'zeigt auf ein Ziel ohne Schlüssel' : 'nicht gefunden'}`));
    c.steps = GENERIC_STEPS(required > 1 ? `die ${required} Einträge` : 'den Eintrag', hosts[0] ? rel(hosts[0], domain) : '…', facts?.dkim?.[0]?.type ?? 'TXT/CNAME');
  }
  const weak = good.filter((g) => (g.bits ?? 0) > 0 && (g.bits ?? 0) < 1024);
  if (weak.length) {
    c.status = c.status === 'ok' ? 'warn' : c.status;
    c.problems.push(`Der Schlüssel ist nur ≈ ${weak[0].bits} Bit lang – erzeuge bei deinem Anbieter einen mit 2048 Bit.`);
  } else if (good.some((g) => (g.bits ?? 0) === 1024) && c.status === 'ok') {
    c.problems.push('Der Schlüssel hat ≈ 1024 Bit – gültig, aber 2048 Bit sind heute üblich.');
  }
  if (c.status === 'ok' && !c.records.length) c.records = [];
  return c;
}

// --- DMARC ---------------------------------------------------------------------------------------------------------------------

export function parseDmarc(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

async function checkDmarc(r: DnsResolver, domain: string): Promise<Check> {
  const c: Check = { key: 'dmarc', label: 'DMARC', status: 'ok', summary: '', found: [], problems: [], steps: [], records: [] };
  let name = `_dmarc.${domain}`;
  let recs = (await txt(r, name)).filter((x) => /^v=DMARC1\b/i.test(x.trim()));
  let inherited = '';
  const parent = parentDomain(domain);
  if (!recs.length && parent) {
    const p = (await txt(r, `_dmarc.${parent}`)).filter((x) => /^v=DMARC1\b/i.test(x.trim()));
    if (p.length) {
      recs = p;
      inherited = parent;
      name = `_dmarc.${parent}`;
    }
  }
  c.found = recs;
  if (!recs.length) {
    c.status = 'fail';
    c.summary = 'Kein DMARC-Eintrag gefunden';
    c.problems.push('Gmail und Yahoo verlangen von Absendern mit größeren Mengen einen DMARC-Eintrag – ohne ihn werden Mails schlechter zugestellt.');
    c.records.push(rec(domain, 'TXT', `_dmarc.${domain}`, `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1`, { note: 'Startet im Beobachtungsmodus (p=none). Lege das Postfach dmarc@… an oder tausche die Adresse gegen eine eigene.' }));
    c.steps = GENERIC_STEPS('einen TXT-Eintrag', '_dmarc', 'TXT');
    return c;
  }
  if (recs.length > 1) {
    c.status = 'fail';
    c.summary = 'Mehrere DMARC-Einträge – erlaubt ist einer';
    c.problems.push('Bei mehr als einem DMARC-Eintrag ignorieren Empfänger alle. Lösche bis auf einen.');
    c.steps = ['Öffne die DNS-Verwaltung und lösche die überzähligen TXT-Einträge unter „_dmarc“ (Hosts, die mit v=DMARC1 beginnen) – einer bleibt.', 'Speichern, kurz warten und erneut prüfen.'];
    return c;
  }
  const t = parseDmarc(recs[0]);
  const p = (t.p ?? '').toLowerCase();
  const where = inherited ? ` (geerbt von ${inherited})` : '';
  if (!['none', 'quarantine', 'reject'].includes(p)) {
    c.status = 'fail';
    c.summary = `DMARC-Richtlinie fehlt oder ist ungültig${where}`;
    c.problems.push('Der Eintrag braucht p=none, p=quarantine oder p=reject.');
    c.records.push(rec(domain, 'TXT', name, `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1`));
    c.steps = ['Ersetze den Wert des DMARC-Eintrags durch den unten kopierten.', 'Speichern, kurz warten und erneut prüfen.'];
    return c;
  }
  if (p === 'none') {
    c.status = 'warn';
    c.summary = `DMARC im Beobachtungsmodus (p=none)${where}`;
    c.problems.push('p=none genügt für Gmail/Yahoo, schützt deine Domain aber nicht vor Missbrauch. Wenn die Berichte sauber sind, stelle auf p=quarantine, später p=reject.');
    c.records.push(rec(domain, 'TXT', name, `v=DMARC1; p=quarantine; pct=25; rua=${t.rua || `mailto:dmarc@${domain}`}; fo=1`, { note: 'Optional, wenn SPF und DKIM sauber sind: schrittweise verschärfen.' }));
  } else c.summary = `DMARC aktiv: p=${p}${where}`;
  if (!t.rua) {
    c.problems.push('Keine Berichts-Adresse (rua=): du erfährst nicht, wer in deinem Namen sendet oder woran Zustellung scheitert.');
    if (c.status === 'ok') c.status = 'warn';
    if (!c.records.length) c.records.push(rec(domain, 'TXT', name, `${recs[0].replace(/;\s*$/, '')}; rua=mailto:dmarc@${domain}`));
  }
  if (t.pct && Number(t.pct) < 100 && p !== 'none') c.problems.push(`Die Richtlinie gilt nur für ${t.pct} % der Mails (pct=${t.pct}).`);
  if (c.records.length && !c.steps.length) c.steps = ['Öffne die DNS-Verwaltung und ändere den bestehenden TXT-Eintrag unter „_dmarc“ auf den Wert unten.', 'Speichern, kurz warten und erneut prüfen.'];
  return c;
}

// --- MX and return path ----------------------------------------------------------------------------------------------------------

async function checkMx(r: DnsResolver, domain: string): Promise<Check> {
  const c: Check = { key: 'mx', label: 'MX (Empfang)', status: 'ok', summary: '', found: [], problems: [], steps: [], records: [] };
  const mx = await r.resolveMx(domain);
  c.found = mx.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
  if (mx.length) {
    c.summary = `${mx.length} Mailserver eingetragen`;
    if (mx.some((m) => !m.exchange || m.exchange === '.')) {
      c.status = 'fail';
      c.summary = 'Ein MX-Eintrag zeigt auf „.“ – die Domain nimmt keine Mails an';
      c.problems.push('„Null-MX“ sagt, dass die Domain keine Mails empfängt. Antworten und Rückläufer können nicht ankommen.');
    }
    return c;
  }
  const a = await r.resolve4(domain);
  if (a.length) {
    c.status = 'warn';
    c.summary = 'Kein MX-Eintrag – nur ein A-Eintrag';
    c.problems.push('Ohne MX versuchen andere Server, Mails an den Webserver zu schicken. Antworten und Rückläufer kommen meist nicht an.');
  } else {
    c.status = 'fail';
    c.summary = 'Kein MX-Eintrag gefunden';
    c.problems.push('Die Domain kann keine Mails empfangen: Antworten, Rückläufer und Abmeldungen per Mail gehen verloren – manche Empfänger lehnen Mails von solchen Domains ab.');
  }
  c.records.push(rec(domain, 'MX', domain, 'MAILSERVER.DEINES-ANBIETERS.example', { priority: 10, note: 'Den Mailserver nennt dein Postfach-Anbieter (z. B. Google Workspace, Microsoft 365, IONOS) – Wert dort nachsehen.' }));
  c.steps = GENERIC_STEPS('einen MX-Eintrag', '@', 'MX');
  return c;
}

async function checkReturnPath(r: DnsResolver, domain: string, provider: MailProviderKey, facts: ProviderFacts | undefined): Promise<Check | undefined> {
  const items = (facts?.other ?? []).filter((o) => o.type !== 'TXT' || /spf1/i.test(o.value) === false);
  const defaults: { fqdn: string; type: 'CNAME' | 'MX'; value: string; priority?: number }[] = [];
  if (!items.length) {
    if (provider === 'postmark') defaults.push({ fqdn: `pm-bounces.${domain}`, type: 'CNAME', value: 'pm.mtasv.net' });
    else if (provider === 'mailgun') defaults.push({ fqdn: `email.${domain}`, type: 'CNAME', value: 'mailgun.org' });
  }
  const wanted = items.length ? items.filter((o) => o.type === 'CNAME' || o.type === 'MX') : defaults;
  if (!wanted.length) return undefined;
  const c: Check = { key: 'return_path', label: 'Rückweg-Domain (Bounces)', status: 'ok', summary: '', found: [], problems: [], steps: [], records: [], optional: true };
  let present = 0;
  for (const w of wanted) {
    let ok = false;
    if (w.type === 'CNAME') {
      const cn = await r.resolveCname(w.fqdn);
      ok = cn.some((x) => x.replace(/\.$/, '').toLowerCase() === w.value.replace(/\.$/, '').toLowerCase());
      if (cn.length) c.found.push(`${w.fqdn}: CNAME ${cn[0]}`);
    } else {
      const mx = await r.resolveMx(w.fqdn);
      ok = mx.length > 0;
      if (mx.length) c.found.push(`${w.fqdn}: MX ${mx[0].priority} ${mx[0].exchange}`);
    }
    if (ok) present++;
    else c.records.push(rec(domain, w.type, w.fqdn, w.value, { priority: (w as any).priority }));
  }
  if (present === wanted.length) {
    c.summary = 'Rückweg-Domain eingerichtet';
    c.records = [];
    return c;
  }
  c.status = 'warn';
  c.summary = `${wanted.length - present} von ${wanted.length} Einträgen für die Rückweg-Domain fehlen`;
  c.problems.push('Optional, aber empfohlen: Mit eigener Rückweg-Domain stimmt die Absender-Domain in SPF und DMARC überein (bessere Zustellung).');
  c.steps = GENERIC_STEPS('die Einträge', rel(c.records[0].fqdn, domain), c.records[0].type);
  return c;
}

// --- the whole check --------------------------------------------------------------------------------------------------------------------

const ORDER: Record<Status, number> = { ok: 0, unknown: 1, warn: 2, fail: 3 };
export const worst = (list: Status[]): Status => list.reduce<Status>((w, s) => (ORDER[s] > ORDER[w] ? s : w), 'ok');

export interface CheckInput {
  domain: string;
  provider: MailProviderKey;
  selector?: string;
  smtpHost?: string;
  facts?: ProviderFacts;
}

async function safe(key: CheckKey, label: string, fn: () => Promise<Check | undefined>): Promise<Check | undefined> {
  try {
    return await fn();
  } catch (e) {
    return { key, label, status: 'unknown', summary: 'DNS-Abfrage fehlgeschlagen', found: [], problems: [`Die Abfrage kam nicht durch (${(e as Error).message}). Versuche es in einer Minute noch einmal.`], steps: ['Klicke auf „Erneut prüfen“. Klappt es mehrfach nicht, antworten die Nameserver der Domain gerade nicht – prüfe die Nameserver beim Domain-Anbieter.'], records: [] };
  }
}

export async function checkDomain(r: DnsResolver, input: CheckInput, at = new Date()): Promise<DomainResult> {
  const { domain, provider } = input;
  const checks = (
    await Promise.all([
      safe('spf', 'SPF', () => checkSpf(r, domain, provider, input.facts, input.smtpHost)),
      safe('dkim', 'DKIM', () => checkDkim(r, domain, provider, input.selector ?? '', input.facts, input.smtpHost)),
      safe('dmarc', 'DMARC', () => checkDmarc(r, domain)),
      safe('mx', 'MX (Empfang)', () => checkMx(r, domain)),
      safe('return_path', 'Rückweg-Domain (Bounces)', () => checkReturnPath(r, domain, provider, input.facts)),
    ])
  ).filter((c): c is Check => !!c);
  const status = worst(checks.filter((c) => !c.optional || c.status === 'unknown').map((c) => c.status));
  const bad = checks.filter((c) => c.status === 'fail' && !c.optional);
  const warn = checks.filter((c) => c.status === 'warn' && !c.optional);
  const notes: string[] = [];
  if (input.facts?.note) notes.push(input.facts.note);
  if (input.facts?.verified === false) notes.push(`${PROVIDER_LABELS[provider]} meldet die Domain noch nicht als bestätigt.`);
  return {
    domain,
    provider,
    checked_at: at.toISOString(),
    status,
    summary: status === 'ok' ? 'Alles in Ordnung – SPF, DKIM, DMARC und MX sind eingerichtet.' : bad.length ? `${bad.map((c) => c.label).join(', ')} ${bad.length > 1 ? 'müssen' : 'muss'} repariert werden.` : warn.length ? `${warn.map((c) => c.label).join(', ')} ${warn.length > 1 ? 'sollten' : 'sollte'} nachgebessert werden.` : 'Einige Abfragen sind fehlgeschlagen – bitte erneut prüfen.',
    checks,
    notes,
  };
}
