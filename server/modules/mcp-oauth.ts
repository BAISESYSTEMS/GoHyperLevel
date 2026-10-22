import type { Module } from '../core/app.js';
import { isRelay } from '../core/app.js';
import { HttpError, notFound, redirect, str, type Ctx, type RawResult, type User } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { id, now, sha256, token } from '../core/util.js';
import {
  ACCESS_PREFIX,
  ACCESS_TTL_S,
  CHALLENGE_RE,
  CODE_TTL_S,
  REFRESH_PREFIX,
  REFRESH_TTL_S,
  REQUEST_TTL_S,
  accessFromScope,
  authServerMetadata,
  challengeHeader,
  cleanClientMeta,
  protectedResourceMetadata,
  redirectLabel,
  scopeOf,
  verifyPkce,
  type Access,
} from '../services/mcp-oauth.js';
import { getBranding } from './agency.js';
import { canManageLocation } from './oauth-connect.js';
import { isReadOnlyToolRelay } from './mcp.js';

/**
 * OAuth 2.1 for the MCP server, so ChatGPT (apps/connectors), Claude.ai custom connectors, Codex
 * (`codex mcp login`) and other MCP clients connect without copying keys:
 *
 * - discovery: /.well-known/oauth-protected-resource (RFC 9728) and /.well-known/oauth-authorization-server (RFC 8414)
 * - dynamic client registration (RFC 7591) at POST /oauth/register
 * - authorization code + PKCE (S256 only) at GET /oauth/authorize → consent screen in the app
 *   (/app/oauth-consent: members pick one of their sub-accounts, admins may grant agency scope)
 * - POST /oauth/token (code exchange, rotating refresh tokens), POST /oauth/revoke (RFC 7009)
 *
 * Tokens are random, stored as SHA-256 only; access tokens live an hour, codes five minutes and are
 * single-use (a reused code revokes everything issued from it). /mcp takes the tokens with exactly the
 * scoping of `pghl_` (one sub-account) or `pghla_` keys (agency), via `app.services.mcpAuth`; the REST
 * API accepts them only from the MCP relay. Every grant checks its login on each use: a deleted user,
 * lost access to the sub-account or the settings area ends the connection.
 */

type Json = Record<string, unknown>;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const json = (status: number, body: unknown, extra: Record<string, string> = {}): RawResult => ({
  __raw: true,
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', pragma: 'no-cache', ...CORS, ...extra },
  body: JSON.stringify(body),
});
const oauthError = (status: number, error: string, description: string, extra: Record<string, string> = {}) => json(status, { error, error_description: description }, extra);
const iso = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();

/** Fixed-window limits per IP (or user) and bucket. */
const LIMITS: Record<string, [max: number, windowMs: number]> = {
  register: [30, 3600_000],
  authorize: [60, 60_000],
  token: [120, 60_000],
  revoke: [120, 60_000],
  consent: [30, 60_000],
};
const hits = new Map<string, { n: number; at: number }>();
function limited(bucket: keyof typeof LIMITS, who: string): boolean {
  const [max, windowMs] = LIMITS[bucket];
  const k = `${bucket}:${who}`;
  const t = Date.now();
  const h = hits.get(k);
  if (!h || t - h.at > windowMs) {
    if (hits.size > 50_000) hits.clear();
    hits.set(k, { n: 1, at: t });
    return false;
  }
  return ++h.n > max;
}

export interface GrantRow {
  id: string;
  client_name: string;
  redirect_host: string;
  known: string | null;
  user_name: string;
  location_id: string | null;
  location_name: string | null;
  access: Access;
  created_at: string;
  last_used_at: string | null;
}

function userOf(row: any): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role, locations: JSON.parse(row.locations || '[]'), permissions: row.permissions ? JSON.parse(row.permissions) : null };
}

export const mcpOAuthModule: Module = {
  name: 'mcp-oauth',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mcp_oauth_clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL,
        auth_method TEXT NOT NULL, secret_hash TEXT, client_uri TEXT, scope TEXT, created_ip TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_used_at TEXT
      );
      CREATE TABLE mcp_oauth_requests (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL, redirect_given INTEGER NOT NULL DEFAULT 1, state TEXT, code_challenge TEXT NOT NULL,
        access TEXT NOT NULL, resource TEXT, issuer TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE mcp_oauth_grants (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        access TEXT NOT NULL DEFAULT 'write', created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
      );
      CREATE INDEX mcp_oauth_grants_loc ON mcp_oauth_grants(location_id);
      CREATE TABLE mcp_oauth_codes (
        code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, redirect_given INTEGER NOT NULL DEFAULT 1,
        code_challenge TEXT NOT NULL, resource TEXT, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE TABLE mcp_oauth_tokens (
        token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE INDEX mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const audit = (a: Json) => app.services.audit?.(a);

    // --- origins ------------------------------------------------------------------------
    /** The app's own addresses (main + live agency domain); a request on one of them gets its own origin in metadata. */
    const origins = () => [...new Set([app.config.baseUrl, app.services.publicBaseUrl?.()].filter(Boolean).map((o: string) => o.replace(/\/$/, '')))];
    const originOf = (ctx: Ctx) => {
      const host = String(ctx.req.headers.host ?? '').toLowerCase();
      return origins().find((o) => new URL(o).host === host) ?? app.baseUrl();
    };
    const brandName = () => getBranding(app).name || 'HyperLevel';
    app.services.brandName = brandName;
    /** `resource` (RFC 8707) must name our MCP endpoint on one of our hosts. */
    const resourceOk = (ctx: Ctx, r: unknown) => {
      if (r === undefined || r === null || r === '') return true;
      try {
        const u = new URL(String(r));
        const hosts = new Set([...origins().map((o) => new URL(o).host), String(ctx.req.headers.host ?? '').toLowerCase()]);
        return hosts.has(u.host) && ['/mcp', '/mcp/', '/'].includes(u.pathname) && !u.hash;
      } catch {
        return false;
      }
    };

    // --- discovery ----------------------------------------------------------------------
    const prm = (ctx: Ctx) => json(200, protectedResourceMetadata(originOf(ctx), brandName()), { 'cache-control': 'public, max-age=3600' });
    const asm = (ctx: Ctx) => json(200, authServerMetadata(originOf(ctx)), { 'cache-control': 'public, max-age=3600' });
    router.get('/.well-known/oauth-protected-resource', 'public', prm);
    router.get('/.well-known/oauth-protected-resource/mcp', 'public', prm);
    router.get('/.well-known/oauth-authorization-server', 'public', asm);
    const preflight = (): RawResult => ({ __raw: true, status: 204, headers: { ...CORS, 'access-control-max-age': '86400' }, body: '' });
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke']) router.add('OPTIONS', p, 'public', preflight);
    app.services.mcpChallenge = (ctx: Ctx, error?: string) => challengeHeader(originOf(ctx), error);

    // --- dynamic client registration ----------------------------------------------------
    router.post('/oauth/register', 'public', (ctx) => {
      if (limited('register', ctx.ip)) return oauthError(429, 'slow_down', 'Zu viele Registrierungen – bitte später erneut versuchen');
      const meta = cleanClientMeta(ctx.body);
      if (!meta.ok) return oauthError(400, meta.error, meta.description);
      const m = meta.value;
      const clientId = `ghc_${token(18)}`;
      const secret = m.token_endpoint_auth_method === 'none' ? null : `ghs_${token(32)}`;
      const at = now();
      db.insert('mcp_oauth_clients', { id: clientId, name: m.client_name, redirect_uris: JSON.stringify(m.redirect_uris), grant_types: JSON.stringify(m.grant_types), auth_method: m.token_endpoint_auth_method, secret_hash: secret ? sha256(secret) : null, client_uri: m.client_uri, scope: m.scope, created_ip: ctx.ip, created_at: at });
      audit({ ctx, action: 'mcp_oauth.client.register', summary: `${m.client_name} → ${m.redirect_uris.map((u) => redirectLabel(u).host).join(', ')}`, entityId: clientId, actor: m.client_name });
      return json(201, {
        client_id: clientId,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.parse(at) / 1000),
        client_name: m.client_name,
        redirect_uris: m.redirect_uris,
        grant_types: m.grant_types,
        response_types: m.response_types,
        token_endpoint_auth_method: m.token_endpoint_auth_method,
        ...(m.client_uri ? { client_uri: m.client_uri } : {}),
        ...(m.scope ? { scope: m.scope } : {}),
      });
    });

    // --- authorization endpoint -----------------------------------------------------------
    const errorPage = (title: string, message: string): RawResult => ({ __raw: true, status: 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }, body: messagePage(title, message) });
    const back = (redirectUri: string, params: Record<string, string | null | undefined>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
      return u.toString();
    };
    router.get('/oauth/authorize', 'public', (ctx) => {
      if (limited('authorize', ctx.ip)) return errorPage('Zu viele Anfragen', 'Bitte kurz warten und in der App erneut verbinden.');
      const q = ctx.query;
      const client = db.get('SELECT * FROM mcp_oauth_clients WHERE id = ?', q.get('client_id') ?? '');
      // Without a known client and an exactly registered redirect URI nothing is sent anywhere.
      if (!client) return errorPage('Unbekannte App', 'Diese App ist nicht (mehr) registriert. Bitte die Verbindung in der App neu einrichten.');
      const uris: string[] = JSON.parse(client.redirect_uris);
      const given = q.get('redirect_uri');
      const redirectUri = given ?? (uris.length === 1 ? uris[0] : null);
      if (!redirectUri || !uris.includes(redirectUri)) return errorPage('Ungültige Weiterleitung', 'Die Rücksprung-Adresse dieser App stimmt nicht mit der registrierten überein. Aus Sicherheitsgründen wird nicht weitergeleitet.');
      const state = q.get('state');
      const issuer = originOf(ctx);
      const fail = (error: string, description: string) => redirect(back(redirectUri, { error, error_description: description, state, iss: issuer }));
      if (state && state.length > 1000) return fail('invalid_request', 'state ist zu lang');
      if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Nur response_type=code');
      const challenge = q.get('code_challenge') ?? '';
      if (!challenge) return fail('invalid_request', 'PKCE ist Pflicht (code_challenge fehlt)');
      if (q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'Nur code_challenge_method=S256');
      if (!CHALLENGE_RE.test(challenge)) return fail('invalid_request', 'code_challenge ist ungültig');
      if (!resourceOk(ctx, q.get('resource'))) return fail('invalid_target', 'resource muss der MCP-Server dieser Instanz sein');
      const reqId = token(24);
      db.insert('mcp_oauth_requests', { id: reqId, client_id: client.id, redirect_uri: redirectUri, redirect_given: given ? 1 : 0, state, code_challenge: challenge, access: accessFromScope(q.get('scope')), resource: q.get('resource'), issuer, created_at: now(), expires_at: iso(REQUEST_TTL_S) });
      return redirect(`/app/oauth-consent?request=${encodeURIComponent(reqId)}`);
    });

    // --- consent (the app's login) --------------------------------------------------------
    const sessionUser = (ctx: Ctx): User => {
      // Only a person signed in to the app may consent – never a key or token.
      if (ctx.via !== 'session' || !ctx.user) throw new HttpError(403, 'Nur mit Anmeldung im Browser');
      return ctx.user;
    };
    const pending = (reqId: string) => {
      const r = db.get('SELECT r.*, c.name AS client_name, c.client_uri FROM mcp_oauth_requests r JOIN mcp_oauth_clients c ON c.id = r.client_id WHERE r.id = ?', reqId);
      if (!r || r.expires_at <= now()) throw notFound('Diese Anfrage ist abgelaufen – bitte in der App neu verbinden.');
      return r;
    };
    /** Sub-accounts this login may connect: members only their own with the settings area, admins all. */
    const choices = (u: User) =>
      u.role === 'admin'
        ? db.all('SELECT id, name FROM locations ORDER BY name')
        : u.locations
            .filter((l) => canManageLocation(u, l))
            .map((l) => db.get('SELECT id, name FROM locations WHERE id = ?', l))
            .filter(Boolean);
    router.get('/api/mcp-oauth/requests/:id', 'user', (ctx) => {
      const u = sessionUser(ctx);
      const r = pending(ctx.params.id);
      return {
        id: r.id,
        client: { name: r.client_name, uri: r.client_uri },
        redirect: redirectLabel(r.redirect_uri),
        access_requested: r.access,
        can_agency: u.role === 'admin',
        locations: choices(u),
        user: { name: u.name, email: u.email },
        brand: brandName(),
        expires_at: r.expires_at,
      };
    });
    router.post('/api/mcp-oauth/requests/:id/approve', 'user', (ctx) => {
      const u = sessionUser(ctx);
      if (limited('consent', u.id)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
      const r = pending(ctx.params.id);
      const target = str(ctx.body?.target, 'Ziel', { required: true, max: 64 });
      let locationId: string | null = null;
      if (target === 'agency') {
        if (u.role !== 'admin') throw new HttpError(403, 'Nur Admins dürfen Zugriff auf die ganze Agentur geben');
      } else {
        if (!app.location(target)) throw notFound('Sub-Account nicht gefunden');
        if (!canManageLocation(u, target)) throw new HttpError(403, 'Für diesen Sub-Account fehlt dir das Recht „Einstellungen“');
        locationId = target;
      }
      // "nur lesen" requested by the app cannot be widened here.
      const access: Access = r.access === 'read' || ctx.body?.access === 'read' ? 'read' : 'write';
      const grantId = id();
      db.insert('mcp_oauth_grants', { id: grantId, client_id: r.client_id, user_id: u.id, location_id: locationId, access, created_at: now() });
      const code = token(32);
      db.insert('mcp_oauth_codes', { code_hash: sha256(code), grant_id: grantId, client_id: r.client_id, redirect_uri: r.redirect_uri, redirect_given: r.redirect_given, code_challenge: r.code_challenge, resource: r.resource, expires_at: iso(CODE_TTL_S) });
      db.run('DELETE FROM mcp_oauth_requests WHERE id = ?', r.id);
      audit({ ctx, action: 'mcp_oauth.consent', summary: `${r.client_name}: ${locationId ? app.location(locationId)!.name : 'ganze Agentur'} (${access === 'read' ? 'nur lesen' : 'lesen & schreiben'})`, locationId, entityId: grantId });
      return { redirect: back(r.redirect_uri, { code, state: r.state, iss: r.issuer }) };
    });
    router.post('/api/mcp-oauth/requests/:id/deny', 'user', (ctx) => {
      sessionUser(ctx);
      const r = pending(ctx.params.id);
      db.run('DELETE FROM mcp_oauth_requests WHERE id = ?', r.id);
      audit({ ctx, action: 'mcp_oauth.deny', summary: r.client_name });
      return { redirect: back(r.redirect_uri, { error: 'access_denied', error_description: 'Zugriff abgelehnt', state: r.state, iss: r.issuer }) };
    });

    // --- client authentication at the token/revocation endpoints -------------------------
    const authClient = (ctx: Ctx): { client: any } | { error: RawResult } => {
      const b = ctx.body ?? {};
      let clientId = typeof b.client_id === 'string' ? b.client_id : '';
      let secret: string | undefined = typeof b.client_secret === 'string' ? b.client_secret : undefined;
      const basic = String(ctx.req.headers.authorization ?? '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)?.[1];
      if (basic) {
        const raw = Buffer.from(basic, 'base64').toString('utf8');
        const i = raw.indexOf(':');
        let id2 = '';
        try {
          id2 = decodeURIComponent((i >= 0 ? raw.slice(0, i) : raw).replace(/\+/g, ' '));
          secret = decodeURIComponent((i >= 0 ? raw.slice(i + 1) : '').replace(/\+/g, ' '));
        } catch {
          return { error: oauthError(401, 'invalid_client', 'Client-Anmeldung ungültig', { 'www-authenticate': 'Basic realm="oauth"' }) };
        }
        if (clientId && clientId !== id2) return { error: oauthError(400, 'invalid_request', 'client_id passt nicht zur Anmeldung') };
        clientId = id2;
      }
      const client = clientId ? db.get('SELECT * FROM mcp_oauth_clients WHERE id = ?', clientId) : undefined;
      if (!client) return { error: oauthError(401, 'invalid_client', 'Unbekannte App (client_id)') };
      if (client.secret_hash && (!secret || sha256(secret) !== client.secret_hash)) return { error: oauthError(401, 'invalid_client', 'client_secret fehlt oder ist falsch', basic ? { 'www-authenticate': 'Basic realm="oauth"' } : {}) };
      return { client };
    };

    const revokeGrant = (grantId: string, why: string, ctx?: Ctx) => {
      const g = db.get('SELECT g.*, c.name AS client_name FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id = g.client_id WHERE g.id = ?', grantId);
      if (!g) return false;
      db.run('UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now(), grantId);
      db.run('DELETE FROM mcp_oauth_tokens WHERE grant_id = ?', grantId);
      db.run('DELETE FROM mcp_oauth_codes WHERE grant_id = ?', grantId);
      audit({ ctx, action: 'mcp_oauth.revoke', summary: `${g.client_name}: ${why}`, locationId: g.location_id, entityId: grantId });
      return true;
    };

    /** The login behind a grant still has the access it granted (else the grant ends). */
    const grantValid = (g: any): User | null => {
      if (g.revoked_at) return null;
      const row = db.get('SELECT * FROM users WHERE id = ?', g.user_id);
      if (!row) return null;
      const u = userOf(row);
      if (g.location_id) return app.location(g.location_id) && canManageLocation(u, g.location_id) ? u : null;
      return u.role === 'admin' ? u : null;
    };

    const issue = (grantId: string, access: Access) => {
      const at = `${ACCESS_PREFIX}${token(32)}`;
      const rt = `${REFRESH_PREFIX}${token(32)}`;
      const created = now();
      db.insert('mcp_oauth_tokens', { token_hash: sha256(at), grant_id: grantId, kind: 'access', created_at: created, expires_at: iso(ACCESS_TTL_S) });
      db.insert('mcp_oauth_tokens', { token_hash: sha256(rt), grant_id: grantId, kind: 'refresh', created_at: created, expires_at: iso(REFRESH_TTL_S) });
      return json(200, { access_token: at, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: rt, scope: scopeOf(access) });
    };

    // --- token endpoint -------------------------------------------------------------------
    router.post('/oauth/token', 'public', (ctx) => {
      if (limited('token', ctx.ip)) return oauthError(429, 'slow_down', 'Zu viele Anfragen – bitte kurz warten');
      const auth = authClient(ctx);
      if ('error' in auth) return auth.error;
      const client = auth.client;
      const b = ctx.body ?? {};
      const grantTypes: string[] = JSON.parse(client.grant_types);
      db.run('UPDATE mcp_oauth_clients SET last_used_at = ? WHERE id = ?', now(), client.id);

      if (b.grant_type === 'authorization_code') {
        const code = typeof b.code === 'string' ? b.code : '';
        const c = code ? db.get('SELECT * FROM mcp_oauth_codes WHERE code_hash = ?', sha256(code)) : undefined;
        if (!c) return oauthError(400, 'invalid_grant', 'Code unbekannt oder abgelaufen');
        if (c.client_id !== client.id) return oauthError(400, 'invalid_grant', 'Code gehört zu einer anderen App');
        if (c.used_at) {
          // A second use means the code leaked: end everything issued from it.
          revokeGrant(c.grant_id, 'Code wurde zweimal eingelöst', ctx);
          return oauthError(400, 'invalid_grant', 'Code wurde bereits eingelöst');
        }
        if (c.expires_at <= now()) return oauthError(400, 'invalid_grant', 'Code abgelaufen');
        if (b.redirect_uri !== undefined ? b.redirect_uri !== c.redirect_uri : c.redirect_given) return oauthError(400, 'invalid_grant', 'redirect_uri passt nicht');
        if (!verifyPkce(b.code_verifier, c.code_challenge)) return oauthError(400, 'invalid_grant', 'PKCE-Prüfung fehlgeschlagen (code_verifier)');
        if (!resourceOk(ctx, b.resource) || (b.resource && c.resource && String(b.resource).replace(/\/$/, '') !== String(c.resource).replace(/\/$/, ''))) return oauthError(400, 'invalid_target', 'resource passt nicht');
        // Single use, also under concurrency.
        if (!db.run('UPDATE mcp_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', now(), c.code_hash).changes) return oauthError(400, 'invalid_grant', 'Code wurde bereits eingelöst');
        const g = db.get('SELECT * FROM mcp_oauth_grants WHERE id = ?', c.grant_id);
        if (!g || !grantValid(g)) return oauthError(400, 'invalid_grant', 'Zugriff wurde widerrufen');
        audit({ ctx, action: 'mcp_oauth.token', summary: `${client.name}: Zugang ausgestellt`, locationId: g.location_id, entityId: g.id, userId: g.user_id, actor: client.name });
        return issue(g.id, g.access);
      }

      if (b.grant_type === 'refresh_token') {
        if (!grantTypes.includes('refresh_token')) return oauthError(400, 'unauthorized_client', 'Diese App darf keine Refresh-Tokens nutzen');
        const rt = typeof b.refresh_token === 'string' ? b.refresh_token : '';
        const row = rt.startsWith(REFRESH_PREFIX) ? db.get(`SELECT t.*, g.client_id, g.access, g.location_id, g.user_id, g.revoked_at FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'refresh'`, sha256(rt)) : undefined;
        if (!row || row.client_id !== client.id) return oauthError(400, 'invalid_grant', 'Refresh-Token unbekannt');
        if (row.used_at) {
          // Rotated already: a quick retry is tolerated, a later reuse looks like theft.
          if (Date.now() - Date.parse(row.used_at) > 10_000) revokeGrant(row.grant_id, 'Refresh-Token wurde erneut benutzt', ctx);
          return oauthError(400, 'invalid_grant', 'Refresh-Token wurde bereits benutzt');
        }
        if (row.expires_at <= now()) return oauthError(400, 'invalid_grant', 'Refresh-Token abgelaufen');
        if (!grantValid(row)) {
          revokeGrant(row.grant_id, 'Login hat keinen Zugriff mehr', ctx);
          return oauthError(400, 'invalid_grant', 'Zugriff wurde widerrufen');
        }
        if (!db.run('UPDATE mcp_oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', now(), row.token_hash).changes) return oauthError(400, 'invalid_grant', 'Refresh-Token wurde bereits benutzt');
        // A narrower scope may be asked for, never a wider one.
        const access: Access = row.access === 'read' || (b.scope !== undefined && accessFromScope(b.scope) === 'read') ? 'read' : 'write';
        if (access !== row.access) db.run('UPDATE mcp_oauth_grants SET access = ? WHERE id = ?', access, row.grant_id);
        return issue(row.grant_id, access);
      }
      return oauthError(400, 'unsupported_grant_type', 'Nur authorization_code und refresh_token');
    });

    // --- revocation (RFC 7009) --------------------------------------------------------------
    router.post('/oauth/revoke', 'public', (ctx) => {
      if (limited('revoke', ctx.ip)) return oauthError(429, 'slow_down', 'Zu viele Anfragen – bitte kurz warten');
      const auth = authClient(ctx);
      if ('error' in auth) return auth.error;
      const tok = typeof ctx.body?.token === 'string' ? ctx.body.token : '';
      const row = tok ? db.get('SELECT t.*, g.client_id FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?', sha256(tok)) : undefined;
      // Unknown tokens and tokens of other apps: answered the same way, nothing happens.
      if (row && row.client_id === auth.client.id) {
        if (row.kind === 'refresh') revokeGrant(row.grant_id, 'von der App abgemeldet', ctx);
        else db.run('DELETE FROM mcp_oauth_tokens WHERE token_hash = ?', row.token_hash);
      }
      return json(200, {});
    });

    // --- using the tokens ---------------------------------------------------------------
    /** A valid access token → its grant, client and login; null when unknown, expired or no longer allowed. */
    const resolveAccess = (tok: string) => {
      if (!tok.startsWith(ACCESS_PREFIX)) return null;
      const g = db.get(
        `SELECT g.*, t.expires_at AS token_expires, c.name AS client_name FROM mcp_oauth_tokens t
         JOIN mcp_oauth_grants g ON g.id = t.grant_id JOIN mcp_oauth_clients c ON c.id = g.client_id
         WHERE t.token_hash = ? AND t.kind = 'access'`,
        sha256(tok),
      );
      if (!g || g.token_expires <= now()) return null;
      const user = grantValid(g);
      if (!user) return null;
      db.run('UPDATE mcp_oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)', now(), g.id, new Date(Date.now() - 60_000).toISOString());
      return { grant: g, user };
    };

    // /mcp itself: same scoping as pghl_ (one sub-account) / pghla_ (agency) keys.
    app.services.mcpAuth = [
      ...(app.services.mcpAuth ?? []),
      (bearer: string) => {
        const r = resolveAccess(bearer);
        return r ? { agency: !r.grant.location_id, locationId: r.grant.location_id ?? undefined, access: r.grant.access } : null;
      },
    ];

    // The REST calls the MCP tools relay onto: only from the relay, never directly from outside.
    app.bearerAuth.push((ctx, tok, auth) => {
      if (!tok.startsWith(ACCESS_PREFIX)) return false;
      const r = resolveAccess(tok);
      if (!r) throw new HttpError(401, 'Ungültiges oder abgelaufenes Token');
      if (!isRelay(ctx)) throw new HttpError(403, 'OAuth-Tokens gelten nur für den MCP-Server (/mcp)');
      if (r.grant.access === 'read' && ctx.method !== 'GET' && !isReadOnlyToolRelay(ctx)) throw new HttpError(403, 'Diese Verbindung darf nur lesen');
      ctx.viaApiKey = true;
      ctx.via = 'mcp';
      ctx.scope = r.grant.access;
      if (r.grant.location_id) {
        if (auth !== 'location') throw new HttpError(403, 'Diese Verbindung gilt nur für einen Sub-Account');
        ctx.locationId = r.grant.location_id;
        return true;
      }
      ctx.user = { ...r.user, name: `${r.user.name} (${r.grant.client_name})`, locations: [], permissions: null };
      if (auth === 'location') {
        const loc = String(ctx.req.headers['x-location-id'] ?? ctx.query.get('locationId') ?? '');
        if (!loc) throw new HttpError(400, 'Kein Sub-Account gewählt (x-location-id)');
        if (!app.location(loc)) throw new HttpError(404, 'Sub-Account nicht gefunden');
        ctx.locationId = loc;
      }
      return true;
    });

    // --- connected apps (KI-Werkzeuge page) ---------------------------------------------------
    const list = (filter: { locationId?: string; agency?: boolean }): GrantRow[] => {
      const where = filter.agency ? 'g.location_id IS NULL' : 'g.location_id = ?';
      return db
        .all(
          `SELECT g.id, g.location_id, g.access, g.created_at, g.last_used_at, c.name AS client_name, c.redirect_uris, u.name AS user_name, l.name AS location_name
           FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id = g.client_id JOIN users u ON u.id = g.user_id LEFT JOIN locations l ON l.id = g.location_id
           WHERE ${where} AND g.revoked_at IS NULL AND EXISTS (SELECT 1 FROM mcp_oauth_tokens t WHERE t.grant_id = g.id AND t.expires_at > ? AND t.used_at IS NULL)
           ORDER BY COALESCE(g.last_used_at, g.created_at) DESC`,
          ...(filter.agency ? [] : [filter.locationId]),
          now(),
        )
        .map((g) => {
          const label = redirectLabel(JSON.parse(g.redirect_uris)[0] ?? '');
          return { id: g.id, client_name: g.client_name, redirect_host: label.host, known: label.known, user_name: g.user_name, location_id: g.location_id, location_name: g.location_name, access: g.access, created_at: g.created_at, last_used_at: g.last_used_at };
        });
    };
    app.services.mcpOAuth = {
      list,
      /** Ends a connection (tokens gone at once) if it belongs to the given scope. */
      revoke: (grantId: string, filter: { locationId?: string; agency?: boolean }, ctx?: Ctx) => {
        const g = db.get('SELECT location_id FROM mcp_oauth_grants WHERE id = ? AND revoked_at IS NULL', grantId);
        if (!g || (filter.agency ? g.location_id !== null : g.location_id !== filter.locationId)) return false;
        return revokeGrant(grantId, 'in den KI-Werkzeugen getrennt', ctx);
      },
    };

    // --- housekeeping -------------------------------------------------------------------------
    let lastClean = 0;
    app.onTick(() => {
      if (Date.now() - lastClean < 600_000) return;
      lastClean = Date.now();
      const t = now();
      const dayAgo = new Date(Date.now() - 86400_000).toISOString();
      db.run('DELETE FROM mcp_oauth_requests WHERE expires_at < ?', t);
      db.run('DELETE FROM mcp_oauth_codes WHERE expires_at < ?', dayAgo);
      db.run('DELETE FROM mcp_oauth_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', t, dayAgo);
      db.run('DELETE FROM mcp_oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at < ?', new Date(Date.now() - 30 * 86400_000).toISOString());
      // Registrations that never led to a connection.
      db.run('DELETE FROM mcp_oauth_clients WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.client_id = mcp_oauth_clients.id)', dayAgo);
    });
  },
};
