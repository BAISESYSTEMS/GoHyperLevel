import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SafeResponse } from './net.js';

/**
 * Nango (nango.dev) over its REST API – plain fetch, no SDK. Every Nango HTTP call HyperLevel makes lives
 * in this file, plus the pure helpers (webhook signature, allow-list, proxy paths). The network is
 * `safeFetch` unless a test sets `app.services.nangoFetch`.
 *
 * Written against Nango's published OpenAPI spec (docs/spec.yaml in NangoHQ/nango) and its server
 * sources; points that could only be checked against the spec, not a live instance, are marked
 * ASSUMPTION – see docs/nango.md#what-to-verify-with-real-keys.
 *
 * Licence note: Nango is source-available under the Elastic License 2.0 (not OSI open source). HyperLevel
 * ships no Nango code; it talks to Nango Cloud or a Nango instance the operator runs.
 */

export const NANGO_CLOUD = 'https://api.nango.dev';
export const NANGO_CLOUD_CONNECT = 'https://connect.nango.dev';

/** One Nango end user per sub-account: its connections carry this id (end_user.id → tag end_user_id). */
export const endUserFor = (locationId: string) => `gohigh:${locationId}`;

export type NangoFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean }) => Promise<SafeResponse>;

export class NangoError extends Error {
  constructor(
    message: string,
    /** Status we answer with. */
    public status = 502,
    /** Status Nango answered with (0 = no answer). */
    public upstream = 0,
    public code = '',
  ) {
    super(message);
  }
}

/** Nango's error body `{error: {code, message, errors}}` (or legacy `{message}`) → German message. */
export function nangoErrorFor(status: number, body: any): NangoError {
  const e = body?.error ?? body ?? {};
  const code = String(typeof e === 'object' ? (e.code ?? '') : '');
  const raw = typeof e === 'string' ? e : String(e.message ?? body?.message ?? '');
  const details = Array.isArray(e?.errors) ? e.errors.map((x: any) => `${(x.path ?? []).join('.')}: ${x.message ?? ''}`).join('; ') : '';
  const msg = `${raw}${details ? ` (${details})` : ''}`.trim().slice(0, 300);
  const detail = msg ? `: ${msg}` : '';
  switch (status) {
    case 400:
    case 422:
      return new NangoError(`Nango hat die Anfrage abgelehnt${detail}`, 400, status, code);
    case 401:
      return new NangoError('Der Nango-Secret-Key ist ungültig (Agentur → Integrationen → Nango prüfen).', 502, status, code);
    case 403:
      return new NangoError(`Nango verweigert den Zugriff${detail}`, 403, status, code);
    case 404:
      return new NangoError(`Bei Nango nicht gefunden${detail}`, 404, status, code);
    case 424:
      return new NangoError('Die Verbindung ist abgelaufen – bitte neu verbinden.', 409, status, code || 'refresh_exhausted');
    case 429:
      return new NangoError('Zu viele Anfragen bei Nango – bitte kurz warten.', 429, status, code);
    default:
      return status >= 500 ? new NangoError(`Nango hat gerade ein Problem${detail}`, 503, status, code) : new NangoError(`Fehler von Nango (${status})${detail}`, 502, status, code);
  }
}

export interface NangoIntegration {
  key: string;
  name: string;
  provider: string;
  logo: string;
}

export interface NangoConnection {
  connection_id: string;
  integration: string;
  provider: string;
  created: string;
  end_user_id: string;
  /** Errors Nango reports (type auth = credentials invalid / refresh failed). */
  errors: { type: string; log_id?: string }[];
}

export interface ProxyResult {
  status: number;
  ok: boolean;
  data: unknown;
  content_type: string;
  bytes: number;
}

export interface ClientOptions {
  baseUrl: string;
  secretKey: string;
  fetch: NangoFetch;
  /** Agency admin ticked "internes Netz" (self-hosted Nango inside the same Docker network). */
  allowPrivate?: boolean;
  timeoutMs?: number;
}

const OAUTH_MODES = new Set(['OAUTH1', 'OAUTH2', 'MCP_OAUTH2', 'MCP_OAUTH2_GENERIC']);

/** Integration ids HyperLevel accepts (Nango allows a few more legacy characters, e.g. spaces – not supported here). */
export const INTEGRATION_RE = /^[A-Za-z0-9~.@_-]{1,100}$/;

/** A thin client: one method per Nango endpoint HyperLevel uses. */
export function nangoClient(o: ClientOptions) {
  const base = o.baseUrl.replace(/\/+$/, '');

  async function request<T = any>(method: string, path: string, opts: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {}): Promise<{ status: number; data: T; raw: string; headers: Record<string, unknown> }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    let r: SafeResponse;
    try {
      r = await o.fetch(url.toString(), {
        method,
        headers: { authorization: `Bearer ${o.secretKey}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
        body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
        timeoutMs: opts.timeoutMs ?? o.timeoutMs ?? 20_000,
        maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
        allowPrivate: o.allowPrivate,
      });
    } catch (e) {
      const m = (e as Error).message ?? '';
      if (/internen Netz/.test(m)) throw new NangoError('Die Nango-Adresse liegt in einem internen Netz – unter Agentur → Integrationen → Nango „internes Netz“ erlauben oder die öffentliche Adresse eintragen.', 400, 0, 'private');
      if (/zu groß/.test(m)) throw new NangoError('Die Antwort ist zu groß (Limit 1 MB) – Filter oder Seitengröße nutzen.', 502, 0, 'too_large');
      throw new NangoError(/Zeitüberschreitung/.test(m) ? 'Nango hat nicht rechtzeitig geantwortet – bitte erneut versuchen.' : 'Nango ist nicht erreichbar – Adresse und Internetverbindung des Servers prüfen.', 504, 0, 'network');
    }
    const raw = await r.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    return { status: r.status, data, raw, headers: r.headers };
  }

  const ok = async <T = any>(method: string, path: string, opts: Parameters<typeof request>[2] = {}): Promise<T> => {
    const r = await request<T>(method, path, opts);
    if (r.status >= 200 && r.status < 300) return r.data;
    throw nangoErrorFor(r.status, r.data ?? r.raw);
  };

  return {
    base,

    /** GET /integrations – no query parameters allowed (the server validates an empty query). */
    async listIntegrations(): Promise<NangoIntegration[]> {
      const r = await ok<any>('GET', '/integrations');
      const list: any[] = Array.isArray(r?.data) ? r.data : Array.isArray(r?.configs) ? r.configs : [];
      return list
        .map((i) => ({
          key: String(i.unique_key ?? ''),
          name: String(i.display_name || i.provider || i.unique_key || ''),
          provider: String(i.provider ?? ''),
          logo: typeof i.logo === 'string' && /^https:\/\//.test(i.logo) ? i.logo : '',
        }))
        .filter((i) => i.key);
    },

    /** GET /providers/{provider} – auth mode and the fields the user must fill in (connection_config). */
    async getProvider(provider: string): Promise<{ auth_mode: string; needs_form: boolean; display_name: string }> {
      const r = await ok<any>('GET', `/providers/${encodeURIComponent(provider)}`);
      const p = r?.data ?? r ?? {};
      const cfg = p.connection_config && typeof p.connection_config === 'object' ? Object.values<any>(p.connection_config) : [];
      const needsConfig = cfg.some((f) => f && f.optional !== true && f.automated !== true);
      return { auth_mode: String(p.auth_mode ?? ''), needs_form: needsConfig || !!p.installation, display_name: String(p.display_name ?? provider) };
    },

    /**
     * POST /connect/sessions. Uses `end_user` + `organization` (accepted by old and current Nango; the
     * current server derives the tags end_user_id/organization_id from them) and limits the session to
     * one integration. → token (for the Connect UI / OAuth URL) and connect_link (hosted Connect UI).
     */
    async createConnectSession(p: { endUserId: string; displayName?: string; organizationId?: string; organizationName?: string; integration: string }): Promise<{ token: string; connect_link: string; expires_at: string }> {
      const body = {
        end_user: { id: p.endUserId, ...(p.displayName ? { display_name: p.displayName.slice(0, 255) } : {}) },
        ...(p.organizationId ? { organization: { id: p.organizationId, ...(p.organizationName ? { display_name: p.organizationName.slice(0, 255) } : {}) } } : {}),
        allowed_integrations: [p.integration],
      };
      const r = await ok<any>('POST', '/connect/sessions', { body });
      const d = r?.data ?? r ?? {};
      const tokenValue = String(d.token ?? '');
      if (!tokenValue) throw new NangoError('Nango hat kein Sitzungs-Token geliefert.', 502);
      const link = typeof d.connect_link === 'string' && /^https?:\/\//.test(d.connect_link) ? d.connect_link : '';
      return { token: tokenValue, connect_link: link, expires_at: String(d.expires_at ?? '') };
    },

    /** GET /connections?endUserId= – the sub-account's connections (no credentials). */
    async listConnections(endUserId: string): Promise<NangoConnection[]> {
      // ASSUMPTION: `endUserId` is accepted by old and current servers (deprecated in favour of tags[end_user_id]).
      const r = await ok<any>('GET', '/connections', { query: { endUserId } });
      const list: any[] = Array.isArray(r?.connections) ? r.connections : [];
      return list.map((c) => ({
        connection_id: String(c.connection_id ?? ''),
        integration: String(c.provider_config_key ?? ''),
        provider: String(c.provider ?? ''),
        created: String(c.created ?? c.created_at ?? ''),
        end_user_id: String(c.tags?.end_user_id ?? c.end_user?.id ?? c.end_user?.endUserId ?? ''),
        errors: Array.isArray(c.errors) ? c.errors.map((x: any) => ({ type: String(x?.type ?? ''), log_id: x?.log_id ? String(x.log_id) : undefined })) : [],
      }));
    },

    /** DELETE /connections/{id}?provider_config_key= (legacy route /connection/{id} on older instances). */
    async deleteConnection(connectionId: string, integration: string): Promise<void> {
      const q = { query: { provider_config_key: integration } };
      const r = await request('DELETE', `/connections/${encodeURIComponent(connectionId)}`, q);
      if (r.status >= 200 && r.status < 300) return;
      if (r.status === 404) {
        const legacy = await request('DELETE', `/connection/${encodeURIComponent(connectionId)}`, q);
        if ((legacy.status >= 200 && legacy.status < 300) || legacy.status === 404) return;
        throw nangoErrorFor(legacy.status, legacy.data ?? legacy.raw);
      }
      throw nangoErrorFor(r.status, r.data ?? r.raw);
    },

    /** The Proxy: `/proxy/<path>` with Connection-Id + Provider-Config-Key; extra headers as Nango-Proxy-*. */
    async proxy(p: { method: string; path: string; query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; connectionId: string; integration: string; timeoutMs?: number; maxBytes?: number }): Promise<ProxyResult> {
      const headers: Record<string, string> = { 'connection-id': p.connectionId, 'provider-config-key': p.integration };
      for (const [k, v] of Object.entries(p.headers ?? {})) headers[`nango-proxy-${k.toLowerCase()}`] = v;
      const hasBody = p.body !== undefined && p.body !== null && p.body !== '' && !['GET', 'HEAD', 'DELETE'].includes(p.method);
      const r = await request(p.method, `/proxy${p.path}`, { query: p.query, body: hasBody ? p.body : undefined, headers, timeoutMs: p.timeoutMs ?? 30_000, maxBytes: p.maxBytes ?? 1024 * 1024 });
      const type = String(r.headers?.['content-type'] ?? '');
      const data = r.data !== null ? r.data : r.raw.slice(0, 100_000);
      // Nango's own failures (no connection, refresh exhausted) come as {error: {code}} with 4xx before reaching the API.
      if (!(r.status >= 200 && r.status < 300) && r.data?.error?.code && /^(unknown_connection|connection_not_found|unknown_provider_config|missing_provider_config|connection_refresh_backoff|refresh_token_external_error|invalid_connection|invalid_headers|base_url_override_not_allowed)$/.test(String(r.data.error.code))) {
        throw nangoErrorFor(r.status === 404 ? 404 : r.status === 424 ? 424 : r.status, r.data);
      }
      return { status: r.status, ok: r.status >= 200 && r.status < 300, data, content_type: type.slice(0, 100), bytes: r.raw.length };
    },

    /** URL of the OAuth flow without the Connect UI: plain redirects, no popup (OAuth providers without extra fields). */
    oauthUrl(integration: string, sessionToken: string): string {
      return `${base}/oauth/connect/${encodeURIComponent(integration)}?connect_session_token=${encodeURIComponent(sessionToken)}`;
    },

    isOAuth: (authMode: string) => OAUTH_MODES.has(authMode.toUpperCase()),
  };
}

export type NangoClient = ReturnType<typeof nangoClient>;

// --- webhooks ------------------------------------------------------------------------------------

/**
 * `X-Nango-Hmac-Sha256`: hex HMAC-SHA256 of the raw body, keyed with the environment's webhook signing key
 * (Environment Settings → Webhooks). The legacy `X-Nango-Signature` (plain SHA-256) is not accepted.
 */
export function signWebhook(rawBody: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(rawBody, 'utf8').digest('hex');
}

export function verifyWebhook(rawBody: string, header: unknown, signingKeys: string[]): boolean {
  const got = String(Array.isArray(header) ? header[0] : (header ?? '')).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  for (const k of signingKeys.filter(Boolean)) {
    const want = Buffer.from(signWebhook(rawBody, k));
    const g = Buffer.from(got);
    if (want.length === g.length && timingSafeEqual(want, g)) return true;
  }
  return false;
}

// --- allow-list for AI and MCP callers -----------------------------------------------------------

export interface AllowEntry {
  integration: string;
  /** ['*'] = every method; otherwise e.g. ['GET']. */
  methods: string[];
  /** Optional path pattern, `*` = any characters (e.g. /repos/*); empty = every path. */
  path: string;
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Validates and normalises the allow-list (German error messages). */
export function cleanNangoAllow(v: unknown): AllowEntry[] {
  if (!Array.isArray(v)) throw new Error('Freigaben müssen eine Liste sein');
  if (v.length > 100) throw new Error('Höchstens 100 Freigaben');
  const out: AllowEntry[] = [];
  for (const x of v) {
    const integration = String(x?.integration ?? '').trim();
    if (!INTEGRATION_RE.test(integration)) throw new Error(`Unbekannte Integration: ${integration.slice(0, 40)}`);
    const methods = (Array.isArray(x?.methods) && x.methods.length ? x.methods : ['*']).map((m: unknown) => String(m).toUpperCase());
    if (methods.some((m: string) => m !== '*' && !(METHODS as readonly string[]).includes(m))) throw new Error('Erlaubte Methoden: GET, POST, PUT, PATCH, DELETE oder *');
    const path = String(x?.path ?? '').trim();
    if (path && (!path.startsWith('/') || path.length > 300 || /[\s?#]/.test(path))) throw new Error(`Pfad-Muster ungültig: ${path.slice(0, 40)} (beginnt mit /, ohne Leerzeichen und ?)`);
    out.push({ integration, methods: methods.includes('*') ? ['*'] : [...new Set<string>(methods)], path });
  }
  return out;
}

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

export function isNangoAllowed(allow: AllowEntry[], integration: string, method: string, path: string): boolean {
  const m = method.toUpperCase();
  return allow.some((a) => a.integration === integration && (a.methods.includes('*') || a.methods.includes(m)) && (!a.path || glob(a.path).test(path)));
}

// --- proxy input -----------------------------------------------------------------------------------

const PATH_CHARS = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const BLOCKED_HEADERS = /^(authorization|cookie|host|connection-id|provider-config-key|content-length|transfer-encoding|proxy-.*|x-forwarded-.*|nango-.*)$/i;

/** The API path for the proxy: starts with /, no scheme/host, no dot segments, no query (that goes into `query`). */
export function cleanProxyPath(v: unknown): string {
  const p = String(v ?? '').trim();
  if (!p) throw new Error('Pfad fehlt (z. B. /user)');
  if (p.length > 1000) throw new Error('Pfad zu lang');
  if (!PATH_CHARS.test(p)) throw new Error('Pfad ungültig – er beginnt mit / und enthält keine Leerzeichen, ? oder #');
  if (p.split('/').some((s) => s === '..' || s === '.' || /^%2e/i.test(s))) throw new Error('Pfad ungültig (.. nicht erlaubt)');
  if (p.startsWith('//')) throw new Error('Pfad ungültig');
  return p;
}

export function cleanMethod(v: unknown): string {
  const m = String(v ?? 'GET').trim().toUpperCase() || 'GET';
  if (!(METHODS as readonly string[]).includes(m)) throw new Error('Methode muss GET, POST, PUT, PATCH oder DELETE sein');
  return m;
}

/** Query parameters: an object of strings (or a "a=1&b=2" text), at most 50. */
export function cleanQuery(v: unknown): Record<string, string> {
  if (v === undefined || v === null || v === '') return {};
  let src: Record<string, unknown>;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{')) {
      try {
        src = JSON.parse(s);
      } catch {
        throw new Error('Query als JSON ungültig');
      }
    } else src = Object.fromEntries(new URLSearchParams(s.replace(/^\?/, '')));
  } else if (typeof v === 'object' && !Array.isArray(v)) src = v as Record<string, unknown>;
  else throw new Error('Query muss ein Objekt sein');
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(src).slice(0, 50)) {
    if (!k || k.length > 100) continue;
    if (x === undefined || x === null) continue;
    out[k] = (typeof x === 'object' ? JSON.stringify(x) : String(x)).slice(0, 2000);
  }
  return out;
}

/** Extra headers for the API (Accept, versions …); credentials and hop headers are refused. */
export function cleanHeaders(v: unknown): Record<string, string> {
  if (v === undefined || v === null || v === '') return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('Header müssen ein Objekt sein');
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k)) throw new Error(`Header-Name ungültig: ${k.slice(0, 30)}`);
    if (BLOCKED_HEADERS.test(k)) throw new Error(`Header ${k} ist nicht erlaubt – die Anmeldung übernimmt Nango`);
    const s = String(x ?? '');
    if (/[\r\n]/.test(s) || s.length > 1000) throw new Error(`Header ${k}: Wert ungültig`);
    out[k] = s;
  }
  return out;
}

/** Nango base URL: http(s), no credentials, no query/fragment; trailing slash removed. */
export function cleanBaseUrl(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Adresse ungültig (z. B. https://api.nango.dev)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nur http(s)-Adressen');
  if (u.username || u.password || u.search || u.hash) throw new Error('Adresse ohne Zugangsdaten, ? oder #');
  return s;
}
