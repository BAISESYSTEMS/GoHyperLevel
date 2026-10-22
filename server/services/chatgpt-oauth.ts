import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

/**
 * "Mit ChatGPT anmelden": OpenAI's official "Sign in with ChatGPT" flow for open-source and locally hosted apps
 * (ChatGPT plan usage). Implemented from OpenAI's published specification and reference implementation:
 *
 *   https://developers.openai.com/siwc/token-sharing-open-source            overview, client vs. agent host
 *   https://developers.openai.com/siwc/token-sharing-open-source/sign-in    registration, authorize URL, code exchange
 *   https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions   refresh, revoke
 *   https://developers.openai.com/siwc/token-sharing-open-source/token-reference         lifetimes, claims
 *   https://github.com/openai/sign-in-with-chatgpt-devkit                   OpenAI's reference code (packages/local/src/oauth.ts)
 *
 * The flow: authorization code + PKCE (S256) at auth.openai.com with `client_id=dynamic_agent_client` for the first
 * registration (no client secret, no partner key), OpenAI issues a client id bound to the user and workspace, scopes
 * `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`.
 * OpenAI only allows an HTTP loopback redirect on 127.0.0.1 – which on a web server is the user's own computer, not the
 * server. So the server starts the flow, the person signs in in their browser, the browser lands on a 127.0.0.1 address
 * that nobody listens on, and they paste that address back (the code in it is single use and useless without the PKCE
 * verifier, which never leaves the server). OpenAI's own page for remote machines describes the same "complete the
 * sign-in on the computer with the browser" situation (…/self-hosted-vms).
 *
 * Pure helpers plus calls through an injected fetch (tests mock every request). Nothing here stores anything.
 */

export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
/** Where people review and limit what an app may use of their plan. */
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const AUTHORIZE_FALLBACK = `${ISSUER}/api/accounts/authorize`;

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A failed step with a German message that can be shown as it is. */
export class OAuthError extends Error {
  constructor(
    message: string,
    public code = 'oauth_error',
    public status = 502,
    /** The saved sign-in can no longer be used – the person has to sign in again. */
    public reauth = false,
  ) {
    super(message);
  }
}

const b64u = (b: Buffer) => b.toString('base64url');
export const randomValue = () => b64u(randomBytes(32));
export const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');

export interface Pkce {
  state: string;
  nonce: string;
  verifier: string;
  challenge: string;
}
export function newPkce(): Pkce {
  const verifier = randomValue();
  return { state: randomValue(), nonce: randomValue(), verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
}

/** `ext_agent_host_id`: an opaque id of this installation (RFC 9562 UUIDv4 as `urn:uuid:…`), created once and kept. */
export const newHostId = () => `urn:uuid:${crypto.randomUUID()}`;
export const isHostId = (v: unknown): v is string => typeof v === 'string' && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// --- discovery --------------------------------------------------------------------------------------------

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  jwks_uri: string;
}

let cached: { at: number; d: Discovery } | null = null;

/** OpenAI's OpenID configuration (cached for an hour); every endpoint has to be on auth.openai.com. */
export async function discover(f: Fetch, fresh = false): Promise<Discovery> {
  if (!fresh && cached && Date.now() - cached.at < 3_600_000) return cached.d;
  let data: any;
  try {
    const res = await f(`${ISSUER}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    data = await res.json().catch(() => null);
    if (!res.ok) data = null;
  } catch {
    data = null;
  }
  const bad = () => new OAuthError('Die ChatGPT-Anmeldung ist gerade nicht erreichbar (OpenAI-Konfiguration nicht überprüfbar). Bitte später erneut versuchen.', 'discovery_failed', 503);
  if (!data || data.issuer !== ISSUER) throw bad();
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
    if (data[k] === undefined && k === 'revocation_endpoint') continue;
    try {
      if (typeof data[k] !== 'string' || new URL(data[k]).origin !== ISSUER) throw bad();
    } catch {
      throw bad();
    }
  }
  cached = { at: Date.now(), d: data as Discovery };
  return cached.d;
}
/** Test hook. */
export const resetDiscovery = () => (cached = null);

// --- authorize --------------------------------------------------------------------------------------------

export interface AuthorizeInput {
  /** The issued client id of an earlier registration, or undefined for the first sign-in (`dynamic_agent_client`). */
  clientId?: string;
  hostId: string;
  /** Shown to the person on OpenAI's consent page ("<app> möchte …"); display metadata only. */
  appName: string;
  pkce: Pick<Pkce, 'state' | 'nonce' | 'challenge'>;
  loginHint?: string;
  /** Ask for consent again (the person chose "ChatGPT-Abo erlauben" after declining). */
  reconsent?: boolean;
  redirectUri?: string;
}

export async function buildAuthorizeUrl(f: Fetch, i: AuthorizeInput): Promise<string> {
  const d = await discover(f).catch(() => null);
  const u = new URL(d?.authorization_endpoint ?? AUTHORIZE_FALLBACK);
  const q = new URLSearchParams({
    client_id: i.clientId || 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: i.redirectUri ?? REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state: i.pkce.state,
    nonce: i.pkce.nonce,
    code_challenge_method: 'S256',
    code_challenge: i.pkce.challenge,
    ext_agent_host_id: i.hostId,
  });
  // agent_name_hint only on the first registration, never on a re-authorization with an issued client id (spec).
  if (!i.clientId) q.set('agent_name_hint', i.appName.slice(0, 60));
  if (i.loginHint) q.set('login_hint', i.loginHint);
  if (i.reconsent) q.set('prompt', 'consent');
  u.search = q.toString();
  return u.toString();
}

// --- the pasted callback ----------------------------------------------------------------------------------------

const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * What the person pasted: the whole address from the browser ("http://127.0.0.1:1455/auth/callback?code=…&state=…&client_id=…"),
 * just its query string, or the parameters without the "?". The state must be the one of this attempt; only the query is read
 * (nothing is fetched from the pasted address).
 */
export function parseCallback(input: string, expectedState: string, savedClientId?: string): { code: string; clientId: string } {
  const raw = String(input ?? '').trim().slice(0, 4000);
  if (!raw) throw new OAuthError('Bitte die Adresse einfügen, auf der der Browser nach der Anmeldung gelandet ist.', 'empty', 400);
  let query = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('host');
      query = u.search;
    } catch {
      throw new OAuthError('Das ist nicht die Adresse nach der Anmeldung. Sie beginnt mit http://127.0.0.1:1455/auth/callback?code=…', 'bad_callback', 400);
    }
  }
  const p = new URLSearchParams(query.replace(/^[^?]*\?/, '').replace(/^\?/, ''));
  const states = p.getAll('state');
  if (states.length !== 1 || !same(states[0], expectedState)) throw new OAuthError('Diese Adresse gehört nicht zu der gestarteten Anmeldung (Code „state“ passt nicht). Bitte die Anmeldung neu starten und die Adresse aus dem neuen Browser-Tab einfügen.', 'state_mismatch', 400);
  const err = p.get('error');
  if (err) {
    throw err === 'access_denied' ? new OAuthError('Du hast die Freigabe in ChatGPT abgelehnt. Ohne Freigabe kann HyperLevel dein Abo nicht nutzen – du kannst die Anmeldung jederzeit neu starten.', 'access_denied', 400) : new OAuthError(`ChatGPT hat die Anmeldung abgebrochen (${err.slice(0, 80)}).`, 'oauth_error', 400);
  }
  const codes = p.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw new OAuthError('In der Adresse fehlt der Code („code=…“). Bitte die komplette Adresse aus der Adresszeile kopieren.', 'no_code', 400);
  const ids = p.getAll('client_id');
  const clientId = ids[0] ?? savedClientId;
  if (ids.length > 1 || !clientId || !CLIENT_ID_RE.test(clientId) || clientId === 'dynamic_agent_client' || (savedClientId && ids[0] && ids[0] !== savedClientId)) {
    throw new OAuthError('ChatGPT hat die Registrierung nicht abgeschlossen (die Adresse enthält keine gültige client_id). Bitte die Anmeldung neu starten.', 'registration_incomplete', 400);
  }
  return { code: codes[0], clientId };
}

// --- tokens ---------------------------------------------------------------------------------------------------

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** ms since epoch */
  expiresAt: number;
  scopes: string[];
}

/** OpenAI's error body → code + message (also `{detail: …}` from the direct route). */
export function errorOf(data: any): { code: string; message: string } {
  const e = data?.error;
  if (typeof e === 'string') return { code: e, message: String(data?.error_description ?? e) };
  if (e && typeof e === 'object') return { code: String(e.code ?? e.type ?? ''), message: String(e.message ?? '') };
  if (typeof data?.detail === 'string') return { code: '', message: data.detail };
  return { code: '', message: '' };
}

const REAUTH_CODES = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

async function tokenRequest(f: Fetch, body: Record<string, string>): Promise<any> {
  const d = await discover(f);
  let res: Response;
  try {
    res = await f(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new OAuthError('OpenAI ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.', 'network', 504);
  }
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    const { code, message } = errorOf(data);
    if (REAUTH_CODES.has(code)) throw new OAuthError('Deine ChatGPT-Anmeldung ist abgelaufen oder wurde widerrufen. Bitte melde dich neu an.', code, 401, true);
    if (code === 'invalid_client') throw new OAuthError('OpenAI kennt diese Registrierung nicht mehr. Bitte trenne die Verbindung und melde dich neu an.', code, 401, true);
    throw new OAuthError(`OpenAI hat die Anmeldung abgelehnt${message ? `: ${message.slice(0, 200)}` : ` (${res.status})`}`, code || 'token_error', res.status >= 500 ? 503 : 400);
  }
  if (!data || typeof data !== 'object') throw new OAuthError('OpenAI hat eine ungültige Antwort geschickt. Bitte erneut anmelden.', 'invalid_token_response', 502);
  return data;
}

/** The token response as credentials; throws when OpenAI left something out the flow needs. */
export function credentialsOf(data: any, previous?: Credentials, now = Date.now()): Credentials {
  const bad = (m: string) => new OAuthError(m, 'invalid_token_response', 502);
  // On a refresh OAuth may leave out "scope" when nothing changed.
  const scope = typeof data.scope === 'string' ? data.scope : previous ? previous.scopes.join(' ') : '';
  if (!scope) throw bad('ChatGPT hat die erteilten Berechtigungen nicht bestätigt. Bitte erneut anmelden.');
  const expiresIn = Number(data.expires_in);
  if (typeof data.access_token !== 'string' || !data.access_token || String(data.token_type ?? '').toLowerCase() !== 'bearer' || !Number.isFinite(expiresIn) || expiresIn <= 0) throw bad('ChatGPT hat unvollständige Zugangsdaten geschickt. Bitte erneut anmelden.');
  const scopes = scope.split(/\s+/).filter(Boolean);
  const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previous?.refreshToken;
  if (!refreshToken) throw bad('ChatGPT hat kein Erneuerungs-Token geschickt (offline_access fehlt). Bitte erneut anmelden.');
  return { accessToken: data.access_token, refreshToken, idToken: typeof data.id_token === 'string' && data.id_token ? data.id_token : (previous?.idToken ?? ''), expiresAt: now + expiresIn * 1000, scopes };
}

export const planEnabled = (c: Pick<Credentials, 'scopes'>) => c.scopes.includes(PLAN_SCOPE);

export async function exchangeCode(f: Fetch, i: { clientId: string; code: string; verifier: string; redirectUri?: string }): Promise<{ data: any; credentials: Credentials }> {
  const data = await tokenRequest(f, { grant_type: 'authorization_code', client_id: i.clientId, code: i.code, code_verifier: i.verifier, redirect_uri: i.redirectUri ?? REDIRECT_URI, resource: RESOURCE });
  return { data, credentials: credentialsOf(data) };
}

/** Refresh: omit `scope` to keep the grant; the answer carries a replacement refresh token (rotation). */
export async function refreshCredentials(f: Fetch, clientId: string, c: Credentials): Promise<Credentials> {
  const data = await tokenRequest(f, { grant_type: 'refresh_token', client_id: clientId, refresh_token: c.refreshToken, resource: RESOURCE });
  return credentialsOf(data, c);
}

/** End the renewable session at OpenAI. Resolves true when OpenAI confirmed (HTTP 200); false = remote revocation not confirmed. */
export async function revoke(f: Fetch, clientId: string, refreshToken: string): Promise<boolean> {
  let endpoint: string | undefined;
  try {
    endpoint = (await discover(f)).revocation_endpoint;
  } catch {
    return false;
  }
  if (!endpoint) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await f(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }).toString(), signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) return true;
      if (res.status < 500) return false;
    } catch {
      /* retry once */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// --- ID token -------------------------------------------------------------------------------------------------

export interface Identity {
  subject: string;
  email: string;
  name: string;
  /** ChatGPT plan as the ID token states it ("plus", "pro", "team" …) – '' when it does not say. */
  plan: string;
}

export function decodeJwt(token: string): { header: any; payload: any; signingInput: string; signature: Buffer } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')), payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), signingInput: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
  } catch {
    return null;
  }
}

let jwksCache: { uri: string; at: number; keys: any[] } | null = null;
async function jwks(f: Fetch, uri: string): Promise<any[]> {
  if (jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  let body: any;
  try {
    const res = await f(uri, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    body = res.ok ? await res.json().catch(() => null) : null;
  } catch {
    body = null;
  }
  if (!body || !Array.isArray(body.keys)) throw new OAuthError('Die Identität konnte gerade nicht geprüft werden (OpenAI-Schlüssel nicht erreichbar). Bitte später erneut versuchen.', 'identity_verification_unavailable', 503);
  jwksCache = { uri, at: Date.now(), keys: body.keys };
  return body.keys;
}
export const resetJwks = () => (jwksCache = null);

/** Planned plan names → label. */
export const PLAN_LABELS: Record<string, string> = { free: 'ChatGPT Free', go: 'ChatGPT Go', plus: 'ChatGPT Plus', pro: 'ChatGPT Pro', team: 'ChatGPT Team', business: 'ChatGPT Business', enterprise: 'ChatGPT Enterprise', edu: 'ChatGPT Edu' };
export const planLabel = (plan: string) => (plan ? (PLAN_LABELS[plan.toLowerCase()] ?? `ChatGPT ${plan.slice(0, 20)}`) : '');

/** A plan name found in the ID token's OpenAI claim, best effort (the specification calls the access token's metadata opaque). */
export function planOf(payload: any): string {
  const auth = payload?.['https://api.openai.com/auth'];
  const v = auth?.chatgpt_plan_type ?? auth?.plan_type ?? payload?.chatgpt_plan_type ?? payload?.plan_type;
  return typeof v === 'string' && /^[a-z0-9_ -]{1,30}$/i.test(v) ? v.toLowerCase() : '';
}

/**
 * Verifies an ID token the way the spec asks: RS256 signature against OpenAI's JWKS, issuer, audience = the issued client id,
 * expiry, and the nonce of this attempt (Node's crypto – no JOSE library needed).
 */
export async function verifyIdToken(f: Fetch, idToken: string, o: { clientId: string; nonce?: string; now?: number }): Promise<Identity> {
  const invalid = () => new OAuthError('Die ChatGPT-Identität konnte nicht bestätigt werden. Bitte erneut anmelden.', 'invalid_id_token', 400);
  const jwt = decodeJwt(idToken);
  if (!jwt || jwt.header?.alg !== 'RS256') throw invalid();
  const d = await discover(f);
  const keys = await jwks(f, d.jwks_uri);
  const jwk = keys.find((k) => k?.kty === 'RSA' && (!jwt.header.kid || k.kid === jwt.header.kid));
  if (!jwk) throw invalid();
  let ok = false;
  try {
    ok = cryptoVerify('RSA-SHA256', Buffer.from(jwt.signingInput), createPublicKey({ key: jwk, format: 'jwk' }), jwt.signature);
  } catch {
    ok = false;
  }
  const p = jwt.payload ?? {};
  const aud: string[] = Array.isArray(p.aud) ? p.aud : [p.aud];
  const nowS = Math.floor((o.now ?? Date.now()) / 1000);
  if (!ok || p.iss !== d.issuer || !aud.includes(o.clientId) || typeof p.sub !== 'string' || !p.sub || typeof p.exp !== 'number' || p.exp + 5 < nowS || typeof p.iat !== 'number') throw invalid();
  if (o.nonce !== undefined && p.nonce !== o.nonce) throw invalid();
  if (p.azp !== undefined && p.azp !== o.clientId) throw invalid();
  return { subject: p.sub, email: typeof p.email === 'string' ? p.email.slice(0, 200) : '', name: typeof p.name === 'string' ? p.name.slice(0, 200) : '', plan: planOf(p) };
}

/** The model catalogue of the signed-in account (`GET /v1/models`, entries with visibility "list", server order kept). */
export interface PlanModel {
  slug: string;
  name: string;
}
export async function listPlanModels(f: Fetch, accessToken: string): Promise<PlanModel[]> {
  let res: Response;
  try {
    res = await f(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new OAuthError('ChatGPT ist gerade nicht erreichbar.', 'network', 504);
  }
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const { message } = errorOf(body);
    throw new OAuthError(res.status === 401 ? 'Die ChatGPT-Anmeldung wurde nicht akzeptiert – bitte neu anmelden.' : `ChatGPT hat die Modell-Liste abgelehnt (${res.status})${message ? `: ${message.slice(0, 160)}` : ''}`, 'models_failed', res.status === 401 ? 401 : 502, res.status === 401);
  }
  if (!body || !Array.isArray(body.models)) throw new OAuthError('ChatGPT hat eine unerwartete Modell-Liste geschickt.', 'invalid_model_catalog', 502);
  const out: PlanModel[] = [];
  for (const m of body.models) {
    if (!m || typeof m !== 'object' || m.visibility !== 'list') continue;
    if (typeof m.slug !== 'string' || !m.slug.trim() || m.slug.length > 200) continue;
    out.push({ slug: m.slug, name: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.slice(0, 120) : m.slug });
  }
  return out;
}
