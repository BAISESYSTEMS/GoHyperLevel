import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Pure building blocks of the MCP OAuth 2.1 server (modules/mcp-oauth.ts): redirect URI rules,
 * PKCE (S256 only), scopes, client metadata (RFC 7591) and the discovery documents (RFC 8414 / RFC 9728).
 * No database, no network.
 */

export const ACCESS_PREFIX = 'pghlo_';
export const REFRESH_PREFIX = 'pghlr_';
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86400;
export const CODE_TTL_S = 300;
export const REQUEST_TTL_S = 900;
export const SCOPES = ['mcp', 'mcp:read'] as const;
export type Access = 'read' | 'write';

/** RFC 7636: 43–128 characters of [A-Z a-z 0-9 - . _ ~]. */
export const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** base64url(sha256(verifier)) is always 43 characters. */
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const a = Buffer.from(s256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:']);

/**
 * Allowed redirect URIs: https, http only on loopback (native apps, RFC 8252), or a private-use scheme
 * like cursor:// or com.example.app:/ – never with a fragment. Returns an error message or null.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri || uri.length > 2000) return 'redirect_uri fehlt oder ist zu lang';
  if (/[\s<>"]/.test(uri)) return 'redirect_uri enthält ungültige Zeichen';
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'redirect_uri ist keine gültige URL';
  }
  if (u.hash || uri.includes('#')) return 'redirect_uri darf keinen #-Teil haben';
  if (u.username || u.password) return 'redirect_uri darf keine Zugangsdaten enthalten';
  if (BLOCKED_SCHEMES.has(u.protocol)) return 'redirect_uri: dieses Schema ist nicht erlaubt';
  if (u.protocol === 'https:') return u.hostname ? null : 'redirect_uri braucht einen Host';
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname) ? null : 'redirect_uri: http nur für localhost/127.0.0.1, sonst https';
  // Private-use scheme (cursor://…, vscode://…, com.example.app:/…)
  return /^[a-z][a-z0-9+.-]{1,40}:$/i.test(u.protocol) ? null : 'redirect_uri: unbekanntes Schema';
}

/** Who will receive the code, as shown on the consent screen. */
export function redirectLabel(uri: string): { host: string; known: string | null } {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { host: uri, known: null };
  }
  const host = u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//${u.host}`;
  const h = u.hostname.toLowerCase();
  if (u.protocol === 'http:' && LOOPBACK.has(h)) return { host, known: 'App auf diesem Computer (z. B. Codex CLI, Claude Code, Cursor)' };
  if (h === 'chatgpt.com' || h === 'chat.openai.com' || h.endsWith('.chatgpt.com')) return { host, known: 'ChatGPT (OpenAI)' };
  if (h === 'claude.ai' || h === 'claude.com' || h.endsWith('.claude.ai')) return { host, known: 'Claude (Anthropic)' };
  if (u.protocol === 'cursor:') return { host, known: 'Cursor' };
  if (u.protocol === 'vscode:' || h === 'vscode.dev' || h === 'insiders.vscode.dev') return { host, known: 'Visual Studio Code' };
  return { host, known: null };
}

/** Requested scope → access level. No scope = full access (the user can still choose "nur lesen"). Unknown scopes are ignored. */
export function accessFromScope(scope: unknown): Access {
  const list = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
  if (!list.length) return 'write';
  return list.includes('mcp') ? 'write' : list.includes('mcp:read') ? 'read' : 'write';
}
export const scopeOf = (access: Access) => (access === 'read' ? 'mcp:read' : 'mcp');

export interface ClientMeta {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  client_uri: string | null;
  scope: string | null;
}

const clean = (v: unknown, max: number) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f<>]/g, '')
        .trim()
        .slice(0, max)
    : '';

/** RFC 7591 registration request → stored metadata, or an `invalid_*` error. */
export function cleanClientMeta(b: any): { ok: true; value: ClientMeta } | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string } {
  if (!b || typeof b !== 'object') return { ok: false, error: 'invalid_client_metadata', description: 'JSON-Objekt erwartet' };
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length) return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uris fehlt' };
  if (uris.length > 10) return { ok: false, error: 'invalid_redirect_uri', description: 'Höchstens 10 redirect_uris' };
  for (const u of uris) {
    const p = redirectUriProblem(u);
    if (p) return { ok: false, error: 'invalid_redirect_uri', description: p };
  }
  const grants = b.grant_types === undefined ? ['authorization_code', 'refresh_token'] : b.grant_types;
  if (!Array.isArray(grants) || !grants.length || grants.some((g: unknown) => g !== 'authorization_code' && g !== 'refresh_token'))
    return { ok: false, error: 'invalid_client_metadata', description: 'grant_types: nur authorization_code und refresh_token' };
  if (!grants.includes('authorization_code')) return { ok: false, error: 'invalid_client_metadata', description: 'grant_types braucht authorization_code' };
  const responses = b.response_types === undefined ? ['code'] : b.response_types;
  if (!Array.isArray(responses) || responses.some((r: unknown) => r !== 'code')) return { ok: false, error: 'invalid_client_metadata', description: 'response_types: nur code' };
  const method = b.token_endpoint_auth_method === undefined ? 'client_secret_basic' : b.token_endpoint_auth_method;
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method))
    return { ok: false, error: 'invalid_client_metadata', description: 'token_endpoint_auth_method: none, client_secret_post oder client_secret_basic' };
  let clientUri: string | null = null;
  if (typeof b.client_uri === 'string' && /^https:\/\/[^\s<>"]{3,300}$/i.test(b.client_uri)) clientUri = b.client_uri;
  return {
    ok: true,
    value: {
      client_name: clean(b.client_name, 100) || 'Unbenannte App',
      redirect_uris: [...new Set(uris as string[])],
      grant_types: [...new Set(grants as string[])],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      client_uri: clientUri,
      scope: typeof b.scope === 'string' ? clean(b.scope, 200) : null,
    },
  };
}

/** RFC 8414 authorization server metadata. */
export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/app/settings/ai-tools`,
  };
}

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(origin: string, name: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [...SCOPES],
    resource_name: name,
    resource_documentation: `${origin}/app/settings/ai-tools`,
  };
}

/** WWW-Authenticate for a 401 from /mcp: where to find the resource metadata (MCP authorization spec). */
export const challengeHeader = (origin: string, error?: string) =>
  `Bearer realm="mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"${error ? `, error="${error}"` : ''}`;
