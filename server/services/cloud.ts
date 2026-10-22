import { PERMISSIONS, type Permission } from '../core/permissions.js';
import { slugify } from '../core/util.js';
import type { Interval } from './saas.js';

/**
 * Cloud mode (PGHL_CLOUD_MODE=1), pure part: the plan catalogue, fair-use limits, the operator's settings and their
 * validation, price maths, the dunning / deletion timeline, the signup abuse checks and slugs. No I/O – the modules
 * cloud*.ts do that.
 *
 * Tenancy: every cloud customer is a *tenant* (cloud_tenants). A tenant owns one primary sub-account (Solo, Team) or a
 * primary plus any number of client sub-accounts (Agentur). Isolation is the existing one: a member login only lists
 * the sub-accounts of its tenant. Billing state lives in the SaaS tables (saas_subscriptions) of the primary
 * sub-account, so the SaaS gate, banner, dunning and usage metering work unchanged.
 */

export type PlanKey = 'solo' | 'team' | 'agency';
export const PLAN_KEYS: PlanKey[] = ['solo', 'team', 'agency'];
export const planIdOf = (k: PlanKey) => `cloud-${k}`;
/** Plan row of an Agentur customer's client sub-accounts: same limits, no price (no double counting in the MRR). */
export const CLIENT_PLAN_ID = 'cloud-agency-client';
export const planKeyOf = (planId: string | null | undefined): PlanKey | undefined => PLAN_KEYS.find((k) => planIdOf(k) === planId);
/** The plan rows of the hosted cloud in saas_plans: sold only through /start, never through the SaaS sign-up or a SaaS Checkout. */
export const CLOUD_PLAN_IDS: string[] = [...PLAN_KEYS.map(planIdOf), CLIENT_PLAN_ID];
export const isCloudPlanId = (id: unknown): boolean => CLOUD_PLAN_IDS.includes(String(id ?? ''));
export const isPlanKey = (v: unknown): v is PlanKey => PLAN_KEYS.includes(v as PlanKey);

export interface PlanInfo {
  key: PlanKey;
  name: string;
  tagline: string;
  /** Default price per month in cents; the operator can change it in the settings. */
  price_month_cents: number;
  /** null = unlimited. */
  users: number | null;
  white_label: boolean;
  client_accounts: boolean;
  custom_domain: boolean;
  highlights: string[];
}

export const PLAN_INFO: Record<PlanKey, PlanInfo> = {
  solo: {
    key: 'solo',
    name: 'Cloud Solo',
    tagline: 'Für dich allein: eine Person, Kontakte, Funnels und Workflows unbegrenzt.',
    price_month_cents: 4999,
    users: 1,
    white_label: false,
    client_accounts: false,
    custom_domain: false,
    highlights: ['1 Nutzer', 'Alle Funktionen außer White-Label und Kunden-Accounts', 'Unbegrenzt Kontakte, Funnels und Workflows', 'Datenexport jederzeit'],
  },
  team: {
    key: 'team',
    name: 'Cloud Team & Company',
    tagline: 'Für Teams und Firmen: unbegrenzt Nutzer, ein Preis pro Firma.',
    price_month_cents: 9999,
    users: null,
    white_label: false,
    client_accounts: false,
    custom_domain: false,
    highlights: ['Unbegrenzt Nutzer – keine Gebühr pro Platz', 'Alle Funktionen außer White-Label und Kunden-Accounts', 'Unbegrenzt Kontakte, Funnels und Workflows', 'Datenexport jederzeit'],
  },
  agency: {
    key: 'agency',
    name: 'Cloud Agentur',
    tagline: 'White-Label für Agenturen: deine Marke statt unserer, Kunden-Accounts ohne Aufpreis.',
    price_month_cents: 19900,
    users: null,
    white_label: true,
    client_accounts: true,
    custom_domain: true,
    highlights: [
      'White-Label: dein Name, Logo und deine Farben',
      'Eigene Login-Domain und eigene Domains für deine Kunden',
      'Installierbare App mit deinem Namen und Icon',
      'Unbegrenzt Nutzer und Kunden-Sub-Accounts',
      'Alle Funktionen – nichts gesperrt',
    ],
  },
};

// --- fair use ----------------------------------------------------------------------------------------------

export type Limit = number | null;
export interface FairUse {
  /** E-mails per month and sub-account. */
  emails: Limit;
  /** SMS per month included (0 = pass-through at cost). */
  sms: Limit;
  /** AI calls per month with the operator's key (own keys – BYOK – are not limited here). */
  ai: Limit;
  /** Media uploads in MB per sub-account. */
  storage_mb: Limit;
}
export type OverageMode = 'block' | 'bill';
export const METRICS = ['emails', 'sms', 'ai'] as const;
export type Metric = (typeof METRICS)[number];

export const DEFAULT_FAIR_USE: Record<PlanKey, FairUse> = {
  solo: { emails: 10_000, sms: 0, ai: 300, storage_mb: 5_000 },
  team: { emails: 50_000, sms: 0, ai: 2_000, storage_mb: 25_000 },
  agency: { emails: 50_000, sms: 0, ai: 2_000, storage_mb: 25_000 },
};

export const FAIR_USE_LABEL: Record<keyof FairUse, string> = {
  emails: 'E-Mails pro Monat',
  sms: 'SMS pro Monat inklusive',
  ai: 'KI-Aufrufe pro Monat inklusive',
  storage_mb: 'Medien-Speicher',
};

// --- settings ---------------------------------------------------------------------------------------------

export interface Operator {
  name: string;
  street: string;
  zip_city: string;
  country: string;
  email: string;
  phone: string;
  vat_id: string;
  register: string;
  representative: string;
  /** Hosting provider and server location, named in the AVV and the privacy policy ({{operator.hosting}}). */
  hosting: string;
}

export interface CloudSettings {
  signup_open: boolean;
  trial_days: number;
  /** true: Stripe Checkout asks for a card at signup; false: the trial starts without payment data. */
  card_required: boolean;
  yearly_discount_percent: number;
  prices: Record<PlanKey, number>;
  fair_use: Record<PlanKey, FairUse>;
  overage: Record<Metric, OverageMode>;
  /** The operator's cost per unit in cents and the markup – used when an overage is billed (SaaS usage rebilling). */
  unit_cost: Record<Metric, number>;
  markup_percent: number;
  /** Days after a failed payment until the account turns read-only. */
  grace_days: number;
  /** Days of read-only until the data export is offered and the deletion is scheduled. */
  retention_days: number;
  /** Days between that notice and the hard delete. */
  deletion_notice_days: number;
  /** Days between the customer's own "delete my account" and the hard delete. */
  self_delete_days: number;
  stripe_tax: boolean;
  tax_id_collection: boolean;
  /** Only businesses may sign up: company name plus VAT ID or the confirmation "I order as a business" (services/cloud-b2b.ts). */
  b2b_only: boolean;
  block_disposable: boolean;
  extra_blocked_domains: string[];
  signups_per_ip_hour: number;
  /** Wildcard domain for <slug>.<cloud_domain> (DNS *.cloud_domain → server); empty = path-based only. */
  cloud_domain: string;
  mail_location_id: string;
  default_snapshot_id: string;
  status_url: string;
  docs_url: string;
  support_email: string;
  /** What the price pages say about VAT. */
  price_note: 'net' | 'gross' | 'none';
  /** 0 = unlimited client accounts for the Agentur plan. */
  agency_max_clients: number;
  operator: Operator;
}

export const DEFAULT_OPERATOR: Operator = { name: '', street: '', zip_city: '', country: 'Deutschland', email: '', phone: '', vat_id: '', register: '', representative: '', hosting: '' };

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): CloudSettings {
  const trial = Number(env.PGHL_CLOUD_TRIAL_DAYS ?? 14);
  return {
    signup_open: true,
    trial_days: Number.isInteger(trial) && trial >= 0 && trial <= 90 ? trial : 14,
    card_required: env.PGHL_CLOUD_CARD_REQUIRED !== '0',
    yearly_discount_percent: 20,
    prices: { solo: PLAN_INFO.solo.price_month_cents, team: PLAN_INFO.team.price_month_cents, agency: PLAN_INFO.agency.price_month_cents },
    fair_use: structuredClone(DEFAULT_FAIR_USE),
    overage: { emails: 'block', sms: 'bill', ai: 'block' },
    unit_cost: { emails: 0.1, sms: 8, ai: 3 },
    markup_percent: 30,
    grace_days: 7,
    retention_days: 30,
    deletion_notice_days: 14,
    self_delete_days: 7,
    stripe_tax: true,
    tax_id_collection: true,
    b2b_only: true,
    block_disposable: true,
    extra_blocked_domains: [],
    signups_per_ip_hour: 6,
    cloud_domain: normalizeDomainLoose(env.PGHL_CLOUD_DOMAIN ?? ''),
    mail_location_id: '',
    default_snapshot_id: '',
    status_url: '',
    docs_url: '',
    support_email: '',
    price_note: 'net',
    agency_max_clients: 0,
    operator: { ...DEFAULT_OPERATOR },
  };
}

/** A host name without scheme, path or port; '' when it is not a plausible domain. */
export function normalizeDomainLoose(v: unknown): string {
  const d = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d) ? d : '';
}

const int = (v: unknown, label: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: ganze Zahl von ${min} bis ${max}`);
  return n;
};
const limit = (v: unknown, label: string): Limit => {
  if (v === null || v === undefined || v === '') return null;
  return int(v, `${label} (leer = unbegrenzt)`, 0, 1_000_000_000);
};
const cost = (v: unknown, label: string): number => {
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new Error(`${label}: 0 bis 10.000 Cent`);
  return n;
};
const text = (v: unknown, label: string, max: number): string => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new Error(`${label} ist zu lang`);
  return s;
};
const url = (v: unknown, label: string): string => {
  const s = text(v, label, 500);
  if (s && !/^https:\/\/\S+$/i.test(s)) throw new Error(`${label}: bitte mit https:// angeben`);
  return s;
};

/** Merges a patch from the browser into the current settings; throws German messages. */
export function cleanSettings(b: any, cur: CloudSettings): CloudSettings {
  const s: CloudSettings = structuredClone(cur);
  const bool = (k: 'signup_open' | 'card_required' | 'stripe_tax' | 'tax_id_collection' | 'b2b_only' | 'block_disposable') => {
    if (b[k] !== undefined) s[k] = !!b[k];
  };
  for (const k of ['signup_open', 'card_required', 'stripe_tax', 'tax_id_collection', 'b2b_only', 'block_disposable'] as const) bool(k);
  if (b.trial_days !== undefined) s.trial_days = int(b.trial_days, 'Testphase (Tage)', 0, 90);
  if (b.yearly_discount_percent !== undefined) s.yearly_discount_percent = int(b.yearly_discount_percent, 'Jahresrabatt (%)', 0, 60);
  if (b.prices && typeof b.prices === 'object') {
    for (const k of PLAN_KEYS) if (b.prices[k] !== undefined) s.prices[k] = int(b.prices[k], `Preis ${PLAN_INFO[k].name} (in Cent pro Monat)`, 100, 1_000_000);
  }
  if (b.fair_use && typeof b.fair_use === 'object') {
    for (const k of PLAN_KEYS) {
      for (const f of Object.keys(DEFAULT_FAIR_USE.solo) as (keyof FairUse)[]) if (b.fair_use[k]?.[f] !== undefined) s.fair_use[k][f] = limit(b.fair_use[k][f], `${PLAN_INFO[k].name}: ${FAIR_USE_LABEL[f]}`);
    }
  }
  if (b.overage && typeof b.overage === 'object') for (const m of METRICS) if (b.overage[m] !== undefined) s.overage[m] = b.overage[m] === 'bill' ? 'bill' : 'block';
  if (b.unit_cost && typeof b.unit_cost === 'object') for (const m of METRICS) if (b.unit_cost[m] !== undefined) s.unit_cost[m] = cost(b.unit_cost[m], `Kosten je ${m}`);
  if (b.markup_percent !== undefined) {
    const m = Number(b.markup_percent);
    if (!Number.isFinite(m) || m < 0 || m > 1000) throw new Error('Aufschlag: 0 bis 1000 %');
    s.markup_percent = m;
  }
  if (b.grace_days !== undefined) s.grace_days = int(b.grace_days, 'Kulanzzeit (Tage)', 0, 60);
  if (b.retention_days !== undefined) s.retention_days = int(b.retention_days, 'Aufbewahrung im Nur-Lesen-Modus (Tage)', 1, 365);
  if (b.deletion_notice_days !== undefined) s.deletion_notice_days = int(b.deletion_notice_days, 'Frist bis zur Löschung (Tage)', 1, 90);
  if (b.self_delete_days !== undefined) s.self_delete_days = int(b.self_delete_days, 'Frist bei eigener Löschung (Tage)', 0, 60);
  if (b.signups_per_ip_hour !== undefined) s.signups_per_ip_hour = int(b.signups_per_ip_hour, 'Anmeldungen pro Stunde und Adresse', 1, 100);
  if (b.agency_max_clients !== undefined) s.agency_max_clients = int(b.agency_max_clients, 'Kunden-Accounts (0 = unbegrenzt)', 0, 100_000);
  if (b.extra_blocked_domains !== undefined) {
    const list = (Array.isArray(b.extra_blocked_domains) ? b.extra_blocked_domains : String(b.extra_blocked_domains).split(/[\s,;]+/)).map((x: unknown) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    if (list.some((x: string) => !/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(x) || x.length > 100)) throw new Error('Gesperrte Domains: nur Domain-Namen, z. B. wegwerf-mail.de');
    s.extra_blocked_domains = [...new Set<string>(list)].slice(0, 500);
  }
  if (b.cloud_domain !== undefined) {
    const raw = String(b.cloud_domain ?? '').trim();
    s.cloud_domain = normalizeDomainLoose(raw);
    if (raw && !s.cloud_domain) throw new Error('Cloud-Domain: bitte nur den Domain-Namen angeben, z. B. cloud.example.com');
  }
  if (b.mail_location_id !== undefined) s.mail_location_id = text(b.mail_location_id, 'Absender-Sub-Account', 60);
  if (b.default_snapshot_id !== undefined) s.default_snapshot_id = text(b.default_snapshot_id, 'Snapshot', 60);
  if (b.status_url !== undefined) s.status_url = url(b.status_url, 'Status-Seite');
  if (b.docs_url !== undefined) s.docs_url = url(b.docs_url, 'Link zur Selbst-Hosting-Anleitung');
  if (b.support_email !== undefined) {
    s.support_email = text(b.support_email, 'Support-E-Mail', 200);
    if (s.support_email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s.support_email)) throw new Error('Support-E-Mail ist ungültig');
  }
  if (b.price_note !== undefined) s.price_note = b.price_note === 'gross' ? 'gross' : b.price_note === 'none' ? 'none' : 'net';
  if (b.operator && typeof b.operator === 'object') {
    for (const k of Object.keys(DEFAULT_OPERATOR) as (keyof Operator)[]) if (b.operator[k] !== undefined) s.operator[k] = text(b.operator[k], `Anbieter: ${k}`, 200);
  }
  return s;
}

/**
 * Yearly price: twelve months minus the discount, rounded *down* to whole euros – the customer never gets less than the
 * advertised discount (49,99 € × 12 − 20 % = 479,90 € → 479 €, not 480 €).
 */
export function yearlyCents(monthCents: number, discountPercent: number): number {
  return Math.floor(Math.round(monthCents * 12 * (100 - discountPercent)) / 10000) * 100;
}
export const priceFor = (s: Pick<CloudSettings, 'prices' | 'yearly_discount_percent'>, k: PlanKey, i: Interval) => (i === 'year' ? yearlyCents(s.prices[k], s.yearly_discount_percent) : s.prices[k]);

// --- timeline: payment failed → read-only → export offered + deletion scheduled → deleted --------------------------

const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString();

export interface Timeline {
  /** Account turned read-only. */
  read_only_since: string;
  /** Export offered, deletion scheduled (notice mail). */
  schedule_at: string;
  /** Hard delete. */
  delete_at: string;
}

export function deletionTimeline(readOnlySince: string | Date, s: Pick<CloudSettings, 'retention_days' | 'deletion_notice_days'>): Timeline {
  const t0 = new Date(readOnlySince).getTime();
  return { read_only_since: iso(t0), schedule_at: iso(t0 + s.retention_days * DAY), delete_at: iso(t0 + (s.retention_days + s.deletion_notice_days) * DAY) };
}

/** Whole days from `at` until `iso` (rounded up, never negative). */
export const daysUntil = (to: string | Date, at: Date = new Date()) => Math.max(0, Math.ceil((new Date(to).getTime() - at.getTime()) / DAY));

// --- abuse protection ----------------------------------------------------------------------------------------------

/** Free throw-away mail providers (a short list of the common ones; the operator adds more). */
export const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me',
  '10minutemail.com', '10minutemail.net', '20minutemail.com', 'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'temp-mail.io', 'tempail.com', 'tempinbox.com',
  'throwawaymail.com', 'trashmail.com', 'trashmail.net', 'trashmail.de', 'trash-mail.com', 'wegwerfemail.de', 'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'einrot.com',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.org', 'nospam.ze.tc', 'getnada.com', 'nada.email', 'maildrop.cc', 'mailnesia.com', 'mailcatch.com',
  'dispostable.com', 'fakeinbox.com', 'fakemail.net', 'emailondeck.com', 'mohmal.com', 'mintemail.com', 'mytemp.email', 'burnermail.io', 'discard.email', 'spamgourmet.com',
  'mailtemp.info', 'moakt.com', 'inboxkitten.com', 'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'emailfake.com', 'fakemailgenerator.com', 'mail-temporaire.fr', 'mailforspam.com',
  'harakirimail.com', 'getairmail.com', 'incognitomail.org', 'mailexpire.com', 'meltmail.com', 'spambox.us', 'spamex.com', 'trbvm.com', 'dropmail.me', 'emltmp.com',
  'luxusmail.org', 'tempr.email', 'anonbox.net', 'byom.de', 'cuvox.de', 'dayrep.com', 'einrot.de', 'fleckens.hu', 'gustr.com', 'rhyta.com', 'superrito.com', 'teleworm.us', 'armyspy.com',
];

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Is the address on a throw-away provider (or a subdomain of one) – from the built-in list or the operator's? */
export function isDisposableEmail(email: string, extra: string[] = []): boolean {
  const d = emailDomain(email);
  if (!d || d === email.toLowerCase()) return false;
  const all = new Set([...DISPOSABLE_DOMAINS, ...extra]);
  return d.split('.').some((_, i, parts) => all.has(parts.slice(i).join('.')));
}

/**
 * Time token for the signup form: the form carries `ts.hmac`; a submit sooner than `minMs` after it was rendered
 * (or with an old/forged token) looks like a bot. Stateless and cookie-free.
 */
export function formTimeOk(token: string, verify: (ts: string, mac: string) => boolean, now = Date.now(), minMs = 2500, maxMs = 24 * 3600_000): boolean {
  const [ts, mac] = String(token ?? '').split('.');
  if (!ts || !mac || !/^\d{10,15}$/.test(ts) || !verify(ts, mac)) return false;
  const age = now - Number(ts);
  return age >= minMs && age <= maxMs;
}

// --- slugs ----------------------------------------------------------------------------------------------------------

const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'status', 'cloud', 'start', 'login', 'signup', 'hooks', 'static', 'cdn', 'docs', 'help', 'support', 'billing', 'blog', 'shop', 'demo', 'test',
  'staging', 'dev', 'ns1', 'ns2', 'mcp', 'oauth', 'auth', 'dashboard', 'console', 'root', 'security', 'abuse', 'postmaster', 'webmaster', 'info', 'noreply', 'gohigh',
]);

/** A DNS-safe sub-domain label for the tenant; `taken` says whether a candidate exists already. */
export function tenantSlug(company: string, taken: (slug: string) => boolean, rnd: () => string = () => Math.random().toString(36).slice(2, 6)): string {
  let base = slugify(company).replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  if (base === 'seite' || base.length < 3) base = `firma${base.length < 3 && base ? `-${base}` : ''}`;
  if (RESERVED.has(base)) base = `${base}-co`;
  if (!taken(base)) return base;
  for (let n = 2; n <= 20; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${rnd()}${rnd()}`;
}

// --- entitlements -----------------------------------------------------------------------------------------------

/** Every area is in every plan – cloud plans never lock a feature area. White-label, client sub-accounts and custom domains
 * are entitlements of the Agentur plan (below), not areas. */
export const ALL_AREAS = Object.keys(PERMISSIONS) as Permission[];

export interface Entitlements {
  users: number | null;
  white_label: boolean;
  client_accounts: boolean;
  custom_domain: boolean;
  max_clients: number | null;
}
export function entitlements(k: PlanKey, s: Pick<CloudSettings, 'agency_max_clients'>): Entitlements {
  const p = PLAN_INFO[k];
  return { users: p.users, white_label: p.white_label, client_accounts: p.client_accounts, custom_domain: p.custom_domain, max_clients: p.client_accounts && s.agency_max_clients > 0 ? s.agency_max_clients : null };
}

export const CANCEL_REASONS: Record<string, string> = {
  price: 'Zu teuer',
  features: 'Es fehlt eine Funktion',
  switched: 'Zu einem anderen Anbieter gewechselt',
  selfhost: 'Ich hoste selbst',
  not_needed: 'Brauche ich nicht mehr',
  other: 'Anderer Grund',
};
