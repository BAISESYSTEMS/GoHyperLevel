/**
 * Generic OpenID Connect (Keycloak, Authentik, Authelia, Zitadel, Okta, Entra ID, Google Workspace …):
 * discovery, authorization URL, code exchange, userinfo, claim mapping and group → role / sub-account
 * mapping. Pure helpers – the sso module does storage, sessions and HTTP routing.
 */

export class OidcError extends Error {}

export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const SUFFIX = '/.well-known/openid-configuration';

/** Issuer or discovery URL → discovery URL and the issuer the document must announce. */
export function discoveryTarget(input: string): { url: string; issuer: string } {
  const raw = String(input ?? '').trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OidcError('Issuer-/Discovery-URL ungültig');
  }
  if (u.search || u.hash) throw new OidcError('Issuer-URL ohne ?… oder #… angeben');
  const s = u.toString();
  if (s.endsWith(SUFFIX)) return { url: s, issuer: s.slice(0, -SUFFIX.length) };
  const issuer = s.replace(/\/$/, '');
  return { url: `${issuer}${SUFFIX}`, issuer };
}

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

const endpointOk = (v: unknown, allowHttp: boolean) => {
  if (typeof v !== 'string' || v.length > 2000) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
  } catch {
    return false;
  }
};

/** Validates a discovery document (OIDC Discovery 4.3: the issuer must match exactly, trailing slash aside). */
export function parseDiscovery(doc: any, expectIssuer: string, opts: { allowHttp?: boolean } = {}): Discovery {
  if (!doc || typeof doc !== 'object') throw new OidcError('Discovery-Dokument unlesbar');
  const allowHttp = !!opts.allowHttp;
  for (const k of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (!endpointOk(doc[k], allowHttp)) throw new OidcError(`Discovery-Dokument: „${k}“ fehlt oder ist keine https-Adresse`);
  }
  const norm = (s: string) => s.replace(/\/$/, '');
  if (norm(doc.issuer) !== norm(expectIssuer)) throw new OidcError(`Issuer stimmt nicht: Dokument nennt ${String(doc.issuer).slice(0, 200)}`);
  if (doc.userinfo_endpoint !== undefined && !endpointOk(doc.userinfo_endpoint, allowHttp)) throw new OidcError('Discovery-Dokument: userinfo_endpoint ungültig');
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : undefined);
  return {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
    userinfo_endpoint: doc.userinfo_endpoint,
    token_endpoint_auth_methods_supported: list(doc.token_endpoint_auth_methods_supported),
    code_challenge_methods_supported: list(doc.code_challenge_methods_supported),
    id_token_signing_alg_values_supported: list(doc.id_token_signing_alg_values_supported),
  };
}

export async function fetchJson(fetcher: Fetcher, url: string, init?: Parameters<Fetcher>[1]): Promise<any> {
  let r;
  try {
    r = await fetcher(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (e) {
    throw new OidcError(`Anbieter nicht erreichbar: ${(e as Error).message}`.slice(0, 300));
  }
  const body = await r.text();
  let j: any;
  try {
    j = body ? JSON.parse(body) : {};
  } catch {
    throw new OidcError(`Anbieter antwortet nicht mit JSON (HTTP ${r.status})`);
  }
  if (!r.ok) throw new OidcError(`Anbieter: ${String(j?.error_description || j?.error || `HTTP ${r.status}`).slice(0, 300)}`);
  return j;
}

/** Discovery documents per URL, one hour. */
export class DiscoveryCache {
  private entries = new Map<string, { doc: Discovery; at: number }>();
  constructor(private ttlMs = 3600_000) {}
  async get(fetcher: Fetcher, input: string, opts: { allowHttp?: boolean } = {}): Promise<Discovery> {
    const t = discoveryTarget(input);
    const hit = this.entries.get(t.url);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.doc;
    const doc = parseDiscovery(await fetchJson(fetcher, t.url), t.issuer, opts);
    this.entries.set(t.url, { doc, at: Date.now() });
    return doc;
  }
  clear() {
    this.entries.clear();
  }
}

export function buildAuthorizeUrl(endpoint: string, p: { clientId: string; redirectUri: string; scope: string; state: string; nonce?: string; challenge?: string; extra?: Record<string, string> }): string {
  const u = new URL(endpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', p.scope);
  q.set('state', p.state);
  if (p.nonce) q.set('nonce', p.nonce);
  if (p.challenge) {
    q.set('code_challenge', p.challenge);
    q.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  return u.toString();
}

export type ClientAuth = 'basic' | 'post' | 'none';

/** client_secret_basic is the OIDC default; post when the provider only lists that; none for public clients. */
export function clientAuthFor(d: Pick<Discovery, 'token_endpoint_auth_methods_supported'>, hasSecret: boolean): ClientAuth {
  if (!hasSecret) return 'none';
  const m = d.token_endpoint_auth_methods_supported;
  if (!m || !m.length || m.includes('client_secret_basic')) return 'basic';
  return m.includes('client_secret_post') ? 'post' : 'basic';
}

export interface TokenResponse {
  access_token: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
}

export async function exchangeCode(fetcher: Fetcher, endpoint: string, p: { code: string; verifier?: string; redirectUri: string; clientId: string; clientSecret?: string; auth: ClientAuth }): Promise<TokenResponse> {
  const form: Record<string, string> = { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri };
  if (p.verifier) form.code_verifier = p.verifier;
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (p.auth === 'basic') {
    // RFC 6749 2.3.1: id and secret are form-encoded before the base64.
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
    headers.authorization = `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.clientSecret ?? '')}`).toString('base64')}`;
  } else {
    form.client_id = p.clientId;
    if (p.auth === 'post') form.client_secret = p.clientSecret ?? '';
  }
  const j = await fetchJson(fetcher, endpoint, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
  if (!j.access_token && !j.id_token) throw new OidcError(`Anbieter: ${String(j.error_description || j.error || 'keine Tokens erhalten').slice(0, 300)}`);
  return { access_token: String(j.access_token ?? ''), id_token: j.id_token ? String(j.id_token) : undefined, token_type: j.token_type, scope: j.scope };
}

export async function fetchUserinfo(fetcher: Fetcher, endpoint: string, accessToken: string): Promise<Record<string, any>> {
  const j = await fetchJson(fetcher, endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new OidcError('Userinfo unlesbar');
  return j;
}

// --- claims --------------------------------------------------------------------------------

/** A claim by name; a full key wins (Zitadel's "urn:zitadel:…:roles"), else a dotted path (Keycloak "realm_access.roles"). */
export function claimAt(claims: Record<string, any>, path: string): unknown {
  if (!path) return undefined;
  if (Object.prototype.hasOwnProperty.call(claims, path)) return claims[path];
  let cur: any = claims;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Groups/roles as a list: arrays, "a, b" strings or objects whose keys are the roles (Zitadel). */
export function readGroups(v: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) list = v;
  else if (typeof v === 'string') list = v.split(/[,\s]+/);
  else if (v && typeof v === 'object') list = Object.keys(v);
  return [...new Set(list.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter((s) => s && s.length <= 256))].slice(0, 500);
}

export const isTrue = (v: unknown) => v === true || v === 'true' || v === 1;

export interface ClaimMap {
  email: string;
  name: string;
  groups: string;
}

export function mapClaims(claims: Record<string, any>, map: ClaimMap, trustEmail: boolean) {
  const email = String(claimAt(claims, map.email || 'email') ?? '').trim().toLowerCase();
  const nameClaim = claimAt(claims, map.name || 'name');
  const name = String(nameClaim ?? ([claims.given_name, claims.family_name].filter(Boolean).join(' ') || claims.preferred_username || '')).trim();
  return {
    email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 200 ? email : '',
    name: name.slice(0, 200),
    // OIDC: only an explicit email_verified counts, unless the admin trusts this IdP's addresses (Entra ID sends none).
    emailVerified: isTrue(claims.email_verified) || trustEmail,
    groups: map.groups ? readGroups(claimAt(claims, map.groups)) : [],
  };
}

/** Authentication strength reported by the IdP (RFC 8176 amr values). */
export function amrIsMfa(claims: Record<string, any>): boolean {
  const amr = Array.isArray(claims.amr) ? claims.amr.map(String) : [];
  return amr.some((a: string) => ['mfa', 'otp', 'hwk', 'swk', 'fpt', 'face', 'iris', 'retina', 'sc', 'sms', 'tel', 'vbm'].includes(a.toLowerCase()));
}

// --- group mapping ----------------------------------------------------------------------------

export interface GroupRule {
  group: string;
  role?: 'admin' | 'member';
  locations?: string[];
  /** Areas for members; null = all areas. Omitted = rule adds no areas. */
  permissions?: string[] | null;
}

export interface MappingConfig {
  rules: GroupRule[];
  default_role: 'admin' | 'member';
  default_locations: string[];
  default_permissions: string[] | null;
  require_group: boolean;
  /** Provider of a client (sub-account): never admin, only this sub-account. */
  location_id?: string | null;
}

export interface Mapping {
  allowed: boolean;
  role: 'admin' | 'member';
  locations: string[];
  permissions: string[] | null;
  matched: string[];
}

/**
 * Groups → role, sub-accounts and areas. Admin if any matching rule says so; sub-accounts are the
 * union of defaults and matching rules; areas are the union of the matching rules' areas (a rule with
 * `null` = all), falling back to the defaults. A client's own IdP can only ever grant member access
 * to that client.
 */
export function mapGroups(groups: string[], cfg: MappingConfig): Mapping {
  const have = new Set(groups);
  const hits = cfg.rules.filter((r) => r && typeof r.group === 'string' && have.has(r.group));
  const matched = [...new Set(hits.map((r) => r.group))];
  const allowed = !cfg.require_group || hits.length > 0;
  let role: 'admin' | 'member' = hits.some((r) => r.role === 'admin') ? 'admin' : cfg.default_role === 'admin' ? 'admin' : 'member';
  let locations = [...new Set([...cfg.default_locations, ...hits.flatMap((r) => r.locations ?? [])])];
  const ruleperms = hits.filter((r) => r.permissions !== undefined);
  let permissions: string[] | null = ruleperms.length ? (ruleperms.some((r) => r.permissions === null) ? null : [...new Set(ruleperms.flatMap((r) => r.permissions ?? []))]) : cfg.default_permissions;
  if (cfg.location_id) {
    role = 'member';
    locations = [cfg.location_id];
  }
  if (role === 'admin') permissions = null;
  return { allowed, role, locations, permissions, matched };
}
