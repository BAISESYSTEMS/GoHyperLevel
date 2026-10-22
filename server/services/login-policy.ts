import { PERMISSIONS } from '../core/permissions.js';

/**
 * The agency's sign-in rules (stored as agency setting "login_policy"): which methods exist, who may
 * create an account on first login, 2FA for admins, session lifetime, and what a client's own login
 * domain offers. Pure – validation and decisions only.
 */

export type SignupMode = 'closed' | 'invite' | 'domains';

export interface ClientLogin {
  password: boolean;
  magic_link: boolean;
  passkey: boolean;
  /** Provider ids shown on the client's login domain (google, microsoft, github, apple, oidc:<id>); null = like the agency. */
  providers: string[] | null;
}

export interface LoginPolicy {
  password: boolean;
  magic_link: boolean;
  passkey: boolean;
  social: {
    google: { enabled: boolean };
    microsoft: { enabled: boolean };
    github: { enabled: boolean; client_id: string; client_secret?: string };
    apple: { enabled: boolean; client_id: string; team_id: string; key_id: string; private_key?: string };
  };
  signup: { mode: SignupMode; domains: string[]; locations: string[]; permissions: string[] | null };
  /** Social login may attach itself to an existing (non-admin) account with the same verified e-mail. */
  link_by_email: boolean;
  require_2fa_admins: boolean;
  session_days: number;
  /** Sub-account whose e-mail settings send magic links and invites ('' = automatic). */
  mail_location_id: string;
  /** Per sub-account: the methods its own login domain shows. */
  clients: Record<string, ClientLogin>;
}

export const DEFAULT_POLICY: LoginPolicy = {
  password: true,
  magic_link: false,
  passkey: true,
  social: {
    google: { enabled: false },
    microsoft: { enabled: false },
    github: { enabled: false, client_id: '' },
    apple: { enabled: false, client_id: '', team_id: '', key_id: '' },
  },
  signup: { mode: 'closed', domains: [], locations: [], permissions: null },
  link_by_email: true,
  require_2fa_admins: false,
  session_days: 30,
  mail_location_id: '',
  clients: {},
};

export class PolicyError extends Error {}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function domainList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const x of raw) {
    const d = String(x ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!d) continue;
    if (!DOMAIN.test(d)) throw new PolicyError(`Domain ungültig: ${d.slice(0, 80)}`);
    out.push(d);
  }
  return [...new Set(out)].slice(0, 100);
}

export const emailDomain = (email: string) => String(email ?? '').toLowerCase().split('@')[1] ?? '';

export function cleanPerms(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  return [...new Set(v.map(String).filter((p) => p in PERMISSIONS))];
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const s = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanClient(v: any): ClientLogin {
  return {
    password: bool(v?.password, true),
    magic_link: bool(v?.magic_link, true),
    passkey: bool(v?.passkey, true),
    providers: Array.isArray(v?.providers) ? [...new Set(v.providers.map(String).filter((p: string) => /^(google|microsoft|github|apple|oidc:[A-Za-z0-9]{6,40})$/.test(p)))].slice(0, 20) as string[] : null,
  };
}

/** Stored JSON → full policy with defaults (never throws; unknown values fall back). */
export function readPolicy(raw: any): LoginPolicy {
  const p = raw && typeof raw === 'object' ? raw : {};
  const so = p.social ?? {};
  const mode: SignupMode = ['closed', 'invite', 'domains'].includes(p.signup?.mode) ? p.signup.mode : 'closed';
  let domains: string[] = [];
  try {
    domains = domainList(p.signup?.domains);
  } catch {
    domains = [];
  }
  const clients: Record<string, ClientLogin> = {};
  for (const [k, v] of Object.entries(p.clients ?? {})) if (/^[A-Za-z0-9]{6,40}$/.test(k)) clients[k] = cleanClient(v);
  return {
    password: bool(p.password, true),
    magic_link: bool(p.magic_link, false),
    passkey: bool(p.passkey, true),
    social: {
      google: { enabled: bool(so.google?.enabled, false) },
      microsoft: { enabled: bool(so.microsoft?.enabled, false) },
      github: { enabled: bool(so.github?.enabled, false), client_id: s(so.github?.client_id), ...(so.github?.client_secret ? { client_secret: String(so.github.client_secret) } : {}) },
      apple: { enabled: bool(so.apple?.enabled, false), client_id: s(so.apple?.client_id), team_id: s(so.apple?.team_id, 20), key_id: s(so.apple?.key_id, 20), ...(so.apple?.private_key ? { private_key: String(so.apple.private_key) } : {}) },
    },
    signup: { mode, domains, locations: Array.isArray(p.signup?.locations) ? p.signup.locations.map(String).slice(0, 50) : [], permissions: cleanPerms(p.signup?.permissions) },
    link_by_email: bool(p.link_by_email, true),
    require_2fa_admins: bool(p.require_2fa_admins, false),
    session_days: Math.min(365, Math.max(1, Math.round(Number(p.session_days) || 30))),
    mail_location_id: s(p.mail_location_id, 40),
    clients,
  };
}

/**
 * Applies a patch from the settings page. Secrets are handled by the caller (sealed before this);
 * `masked` values keep what is stored. Throws PolicyError with a German message.
 */
export function patchPolicy(cur: LoginPolicy, b: any, o: { locationExists: (id: string) => boolean }): LoginPolicy {
  const next: LoginPolicy = JSON.parse(JSON.stringify(cur));
  for (const k of ['password', 'magic_link', 'passkey', 'link_by_email', 'require_2fa_admins'] as const) if (typeof b?.[k] === 'boolean') next[k] = b[k];
  if (b?.session_days !== undefined) {
    const d = Number(b.session_days);
    if (!Number.isFinite(d) || d < 1 || d > 365) throw new PolicyError('Sitzungsdauer: 1 bis 365 Tage');
    next.session_days = Math.round(d);
  }
  if (b?.mail_location_id !== undefined) {
    const id = s(b.mail_location_id, 40);
    if (id && !o.locationExists(id)) throw new PolicyError('Sub-Account für den Mail-Versand nicht gefunden');
    next.mail_location_id = id;
  }
  if (b?.signup && typeof b.signup === 'object') {
    if (b.signup.mode !== undefined) {
      if (!['closed', 'invite', 'domains'].includes(b.signup.mode)) throw new PolicyError('Registrierung: unbekannte Einstellung');
      next.signup.mode = b.signup.mode;
    }
    if (b.signup.domains !== undefined) next.signup.domains = domainList(b.signup.domains);
    if (b.signup.locations !== undefined) {
      if (!Array.isArray(b.signup.locations)) throw new PolicyError('Sub-Accounts als Liste');
      for (const id of b.signup.locations) if (!o.locationExists(String(id))) throw new PolicyError('Sub-Account für neue Konten nicht gefunden');
      next.signup.locations = b.signup.locations.map(String);
    }
    if (b.signup.permissions !== undefined) next.signup.permissions = cleanPerms(b.signup.permissions);
    if (next.signup.mode === 'domains' && !next.signup.domains.length) throw new PolicyError('Registrierung per Domain: mindestens eine Domain eintragen');
  }
  if (b?.clients && typeof b.clients === 'object') {
    for (const [id, v] of Object.entries(b.clients)) {
      if (!o.locationExists(id)) throw new PolicyError('Sub-Account nicht gefunden');
      if (v === null) delete next.clients[id];
      else next.clients[id] = cleanClient(v);
    }
  }
  return next;
}

/** Social providers with credentials complete enough to be offered. */
export function socialReady(p: LoginPolicy, id: 'google' | 'microsoft' | 'github' | 'apple', oauthConfigured: (p: 'google' | 'microsoft') => boolean): boolean {
  const c = p.social[id];
  if (!c.enabled) return false;
  if (id === 'google' || id === 'microsoft') return oauthConfigured(id);
  if (id === 'github') return !!(p.social.github.client_id && p.social.github.client_secret);
  return !!(p.social.apple.client_id && p.social.apple.team_id && p.social.apple.key_id && p.social.apple.private_key);
}

/** May someone without an account get one on first login? (Invites are checked by the caller.) */
export function signupAllowed(p: LoginPolicy, email: string, hasInvite: boolean): boolean {
  if (hasInvite) return p.signup.mode !== 'closed';
  return p.signup.mode === 'domains' && p.signup.domains.includes(emailDomain(email));
}

/** Methods on this host: the agency's, narrowed by the client's settings on its own login domain. */
export function hostMethods(p: LoginPolicy, locationId?: string): ClientLogin {
  const base: ClientLogin = { password: p.password, magic_link: p.magic_link, passkey: p.passkey, providers: null };
  const c = locationId ? p.clients[locationId] : undefined;
  if (!c) return base;
  return { password: base.password && c.password, magic_link: base.magic_link && c.magic_link, passkey: base.passkey && c.passkey, providers: c.providers };
}

/** Never lock everyone out: at least one way in must stay on. */
export function assertUsable(p: LoginPolicy, providersAvailable: number): void {
  if (!p.password && !p.magic_link && !p.passkey && providersAvailable === 0) throw new PolicyError('Mindestens eine Anmeldeart muss eingeschaltet bleiben');
}
