import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * OAuth 2.0 authorization-code flow with PKCE (RFC 7636) for Google and Microsoft (Entra ID).
 * Pure helpers: provider endpoints, PKCE pair, a signed short-lived `state`, the authorize URL,
 * code exchange, refresh and revoke. The module (oauth-connect) stores tokens sealed.
 */

export type Provider = 'google' | 'microsoft';
export type Purpose = 'calendar' | 'business' | 'mail';

export interface ClientConfig {
  client_id: string;
  client_secret: string;
  /** Microsoft only: "common", "organizations", "consumers" or a tenant id. */
  tenant?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** Seconds until the access token expires. */
  expires_in: number;
  scope: string;
  id_token?: string;
}

export const PROVIDER_LABEL: Record<Provider, string> = { google: 'Google', microsoft: 'Microsoft' };

const GOOGLE_CAL = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];
const GOOGLE_BIZ = ['https://www.googleapis.com/auth/business.manage'];

/** Minimal scopes; "openid email" only tells us which account was connected (from the ID token). */
export function scopesFor(provider: Provider, purpose: Purpose): string[] {
  // Mail scopes depend on the access level chosen when connecting (services/mailbox-kit.ts); a refresh asks for what was granted.
  if (purpose === 'mail') return [];
  if (provider === 'google') return ['openid', 'email', ...(purpose === 'business' ? GOOGLE_BIZ : GOOGLE_CAL)];
  if (purpose === 'business') throw new Error('Unternehmensprofil gibt es nur mit Google');
  return ['openid', 'email', 'offline_access', 'Calendars.ReadWrite'];
}

/** Scopes the user must actually grant (Google lets people untick single permissions). */
export function requiredScopes(provider: Provider, purpose: Purpose): string[] {
  if (purpose === 'mail') return [];
  if (provider === 'google') return purpose === 'business' ? GOOGLE_BIZ : GOOGLE_CAL;
  return ['Calendars.ReadWrite'];
}

export function missingScopes(provider: Provider, purpose: Purpose, granted: string): string[] {
  const have = new Set(granted.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));
  // Microsoft answers with full URIs (https://graph.microsoft.com/Calendars.ReadWrite) or short names.
  const has = (s: string) => have.has(s.toLowerCase()) || have.has(`https://graph.microsoft.com/${s}`.toLowerCase());
  return requiredScopes(provider, purpose).filter((s) => !has(s));
}

const tenantOf = (cfg: ClientConfig) => (/^[A-Za-z0-9.-]{1,100}$/.test(cfg.tenant ?? '') ? cfg.tenant! : 'common');

export function endpoints(provider: Provider, cfg: ClientConfig) {
  if (provider === 'google') {
    return { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' };
  }
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(cfg))}/oauth2/v2.0`;
  // Microsoft has no endpoint to revoke a single refresh token; disconnecting drops ours.
  return { authorize: `${base}/authorize`, token: `${base}/token`, revoke: '' };
}

// --- PKCE ------------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString('base64url');

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)); // 64 chars, within RFC 7636's 43–128
  return { verifier, challenge: pkceChallenge(verifier) };
}

// --- state -----------------------------------------------------------------------

export interface StatePayload {
  /** Random id; the pending row (with the PKCE verifier) is stored under it. */
  n: string;
  p: Provider;
  k: Purpose;
  /** User id and a hash of the session the flow was started in. */
  u: string;
  s: string;
  l?: string;
  /** Expiry, ms since epoch. */
  e: number;
}

export const STATE_TTL_MS = 10 * 60_000;

const sign = (secret: string, data: string) => b64url(createHmac('sha256', `${secret}:oauth-state`).update(data).digest());

export function signState(secret: string, payload: StatePayload): string {
  const data = b64url(Buffer.from(JSON.stringify(payload)));
  return `${data}.${sign(secret, data)}`;
}

/** Checks signature, expiry and that the callback arrives in the same login session. */
export function verifyState(secret: string, state: string, expect: { sessionHash: string; now?: number }): StatePayload {
  const [data, mac] = String(state ?? '').split('.');
  if (!data || !mac) throw new Error('Ungültige Anfrage (state fehlt)');
  const want = Buffer.from(sign(secret, data));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error('Ungültige Anfrage (state passt nicht)');
  let p: StatePayload;
  try {
    p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Ungültige Anfrage (state unlesbar)');
  }
  if (!p || typeof p.e !== 'number' || p.e < (expect.now ?? Date.now())) throw new Error('Die Anmeldung hat zu lange gedauert – bitte noch einmal verbinden');
  const a = Buffer.from(String(p.s ?? ''));
  const b = Buffer.from(expect.sessionHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Die Anmeldung gehört zu einer anderen Sitzung – bitte noch einmal verbinden');
  return p;
}

// --- URLs and token calls ----------------------------------------------------------

export function authorizeUrl(provider: Provider, cfg: ClientConfig, o: { redirectUri: string; scopes: string[]; state: string; challenge: string; loginHint?: string }): string {
  const q = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.join(' '),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  });
  if (provider === 'google') {
    // offline + consent: Google only hands out a refresh token this way.
    q.set('access_type', 'offline');
    q.set('prompt', 'consent');
    q.set('include_granted_scopes', 'false');
  } else {
    q.set('response_mode', 'query');
    q.set('prompt', 'select_account');
  }
  if (o.loginHint) q.set('login_hint', o.loginHint);
  return `${endpoints(provider, cfg).authorize}?${q}`;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    public code = '',
    public status = 0,
  ) {
    super(message);
  }
  /** The grant is dead (revoked, expired, password changed): only reconnecting helps. */
  get needsReconnect() {
    return this.code === 'invalid_grant' || this.code === 'unauthorized_client' || this.code === 'invalid_client';
  }
}

async function tokenCall(fetcher: typeof fetch, provider: Provider, cfg: ClientConfig, params: Record<string, string>): Promise<TokenSet> {
  let r: Response;
  try {
    r = await fetcher(endpoints(provider, cfg).token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, ...params }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new OAuthError(`${PROVIDER_LABEL[provider]} nicht erreichbar: ${(e as Error).message}`, 'network');
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const code = String(j.error ?? '');
    throw new OAuthError(`${PROVIDER_LABEL[provider]}: ${j.error_description || code || `Fehler ${r.status}`}`.slice(0, 400), code, r.status);
  }
  return {
    access_token: String(j.access_token),
    refresh_token: j.refresh_token ? String(j.refresh_token) : undefined,
    expires_in: Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600,
    scope: String(j.scope ?? ''),
    id_token: j.id_token ? String(j.id_token) : undefined,
  };
}

export function exchangeCode(fetcher: typeof fetch, provider: Provider, cfg: ClientConfig, o: { code: string; verifier: string; redirectUri: string; scopes: string[] }) {
  return tokenCall(fetcher, provider, cfg, {
    grant_type: 'authorization_code',
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
    ...(provider === 'microsoft' ? { scope: o.scopes.join(' ') } : {}),
  });
}

export function refreshTokens(fetcher: typeof fetch, provider: Provider, cfg: ClientConfig, o: { refreshToken: string; scopes: string[] }) {
  return tokenCall(fetcher, provider, cfg, {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    // Without a scope Microsoft returns a token for everything granted before (mail connections).
    ...(provider === 'microsoft' && o.scopes.length ? { scope: o.scopes.join(' ') } : {}),
  });
}

/** Revokes the grant where the provider supports it (Google). Returns false if nothing was revoked. */
export async function revokeToken(fetcher: typeof fetch, provider: Provider, cfg: ClientConfig, token: string): Promise<boolean> {
  const url = endpoints(provider, cfg).revoke;
  if (!url || !token) return false;
  try {
    const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Account e-mail and name from the ID token. The token comes straight from the provider's token
 * endpoint over TLS, so it is only decoded (OIDC Core 3.1.3.7) – and used for display only.
 */
export function idTokenClaims(idToken?: string): { email: string; name: string; sub: string } {
  try {
    const part = String(idToken ?? '').split('.')[1];
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return { email: String(c.email ?? c.preferred_username ?? c.upn ?? '').slice(0, 200), name: String(c.name ?? '').slice(0, 200), sub: String(c.sub ?? c.oid ?? '') };
  } catch {
    return { email: '', name: '', sub: '' };
  }
}
