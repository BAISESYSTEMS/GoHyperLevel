import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, redirect, str, type Ctx, type User } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { id, now, sha256, token } from '../core/util.js';
import {
  OAuthError,
  PROVIDER_LABEL,
  STATE_TTL_MS,
  authorizeUrl,
  exchangeCode,
  idTokenClaims,
  missingScopes,
  pkcePair,
  refreshTokens,
  revokeToken,
  scopesFor,
  signState,
  verifyState,
  type ClientConfig,
  type Provider,
  type Purpose,
} from '../services/oauth.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * One OAuth layer for Google and Microsoft: the agency enters its OAuth apps once (client id/secret,
 * secrets sealed), users connect their calendar (per login) and sub-accounts their Google Business
 * Profile (per location). Authorization-code flow with PKCE and a signed state bound to the login
 * session; refresh tokens are sealed, access tokens refreshed automatically. Other modules use
 * `app.services.oauth.token(connectionId)` and never see refresh tokens.
 */

const MASK = '••••••';
const PROVIDERS: Provider[] = ['google', 'microsoft'];
const PURPOSES: Purpose[] = ['calendar', 'business'];
const RETURN_TO: Record<Purpose, string> = { calendar: '/app/settings/account', business: '/app/settings/reviews', mail: '/app/settings/messaging' };

export interface OAuthConnection {
  id: string;
  provider: Provider;
  purpose: Purpose;
  user_id: string | null;
  location_id: string | null;
  account_email: string;
  account_name: string;
  scopes: string;
  status: 'ok' | 'error';
  last_error: string | null;
  settings: Record<string, any>;
  state: Record<string, any>;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the browser may see of a connection (never tokens). */
export function connectionOut(c: any) {
  const { access_token: _a, refresh_token: _r, state: _s, ...rest } = c;
  return { ...rest, needs_reconnect: c.status === 'error' && /neu verbinden/.test(c.last_error ?? '') };
}

function savedClients(app: App): Record<string, any> {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'oauth_clients');
  return row ? JSON.parse(row.value) : {};
}

/** The agency's OAuth app for a provider (saved settings first, then environment), or null. */
export function clientConfig(app: App, provider: Provider): ClientConfig | null {
  const s = savedClients(app)[provider] ?? {};
  const env = provider === 'google' ? { id: process.env.PGHL_GOOGLE_CLIENT_ID, secret: process.env.PGHL_GOOGLE_CLIENT_SECRET } : { id: process.env.PGHL_MS_CLIENT_ID, secret: process.env.PGHL_MS_CLIENT_SECRET };
  const client_id = s.client_id || env.id || '';
  let client_secret = env.secret || '';
  if (s.client_secret) {
    try {
      client_secret = openSecret(app, s.client_secret);
    } catch {
      client_secret = '';
    }
  }
  if (!client_id || !client_secret) return null;
  return { client_id, client_secret, ...(provider === 'microsoft' ? { tenant: s.tenant || process.env.PGHL_MS_TENANT || 'common' } : {}) };
}

/** Origins the app is reached on (main address + live agency domain): each needs its redirect URI registered. */
function origins(app: App): string[] {
  const list = [app.config.baseUrl.replace(/\/$/, '')];
  const pub = app.services.publicBaseUrl?.();
  if (pub) list.push(String(pub).replace(/\/$/, ''));
  return [...new Set(list)];
}
export const redirectUriFor = (origin: string, provider: Provider) => `${origin}/oauth/${provider}/callback`;

/** May this login manage the sub-account's connections (Google Business Profile)? */
export function canManageLocation(user: User | undefined, locationId: string): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return user.locations.includes(locationId) && (!user.permissions || user.permissions.includes('settings'));
}

export const oauthConnectModule: Module = {
  name: 'oauth-connect',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE oauth_connections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, purpose TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        account_email TEXT NOT NULL DEFAULT '', account_name TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '',
        access_token TEXT, refresh_token TEXT, expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'ok', last_error TEXT,
        settings TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
        last_sync_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX oauth_conn_user ON oauth_connections(user_id, provider) WHERE purpose = 'calendar';
      CREATE UNIQUE INDEX oauth_conn_location ON oauth_connections(location_id, provider) WHERE purpose = 'business';
      CREATE TABLE oauth_pending (
        nonce TEXT PRIMARY KEY, provider TEXT NOT NULL, purpose TEXT NOT NULL, user_id TEXT NOT NULL, location_id TEXT,
        verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_to TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = (): typeof fetch => app.services.oauthFetch ?? fetch;
    const get = (cid: string) => parseJson(db.get('SELECT * FROM oauth_connections WHERE id = ?', cid), ['settings', 'state']) as (OAuthConnection & { access_token: string | null; refresh_token: string | null; expires_at: string | null }) | undefined;

    // --- tokens ------------------------------------------------------------------
    const inflight = new Map<string, Promise<string>>();
    const markError = (cid: string, msg: string) => db.run('UPDATE oauth_connections SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', 'error', msg.slice(0, 500), now(), cid);

    /** A valid access token; refreshes (once at a time) when it is about to expire or `force` is set. */
    async function accessToken(cid: string, force = false): Promise<string> {
      const c = get(cid);
      if (!c) throw new OAuthError('Verbindung nicht gefunden', 'invalid_grant');
      if (!force && c.access_token && c.expires_at && Date.parse(c.expires_at) - Date.now() > 60_000) return openSecret(app, c.access_token);
      const running = inflight.get(cid);
      if (running) return running;
      const p = (async () => {
        if (!c.refresh_token) {
          markError(cid, `${PROVIDER_LABEL[c.provider]}: Zugriff abgelaufen – bitte neu verbinden`);
          throw new OAuthError('Zugriff abgelaufen – bitte neu verbinden', 'invalid_grant');
        }
        const cfg = clientConfig(app, c.provider);
        if (!cfg) throw new OAuthError(`Die ${PROVIDER_LABEL[c.provider]}-App der Agentur fehlt (Agentur → Integrationen)`, 'invalid_client');
        try {
          const t = await refreshTokens(fetcher(), c.provider, cfg, { refreshToken: openSecret(app, c.refresh_token), scopes: scopesFor(c.provider, c.purpose) });
          db.run(
            `UPDATE oauth_connections SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token), status = 'ok', last_error = NULL, updated_at = ? WHERE id = ?`,
            sealSecret(app, t.access_token),
            new Date(Date.now() + t.expires_in * 1000).toISOString(),
            t.refresh_token ? sealSecret(app, t.refresh_token) : null,
            now(),
            cid,
          );
          return t.access_token;
        } catch (e) {
          if (e instanceof OAuthError && e.needsReconnect) markError(cid, `${PROVIDER_LABEL[c.provider]}: Zugriff abgelaufen oder entzogen – bitte neu verbinden`);
          throw e;
        }
      })().finally(() => inflight.delete(cid));
      inflight.set(cid, p);
      return p;
    }

    app.services.oauth = {
      token: accessToken,
      get,
      fetcher,
      markError,
      clearError: (cid: string) => db.run(`UPDATE oauth_connections SET status = 'ok', last_error = NULL WHERE id = ? AND status = 'error' AND last_error NOT LIKE '%neu verbinden%'`, cid),
      configured: (p: Provider) => !!clientConfig(app, p),
      /** The Business Profile connection of a sub-account (Google), if any. */
      business: (locationId: string) => parseJson(db.get(`SELECT * FROM oauth_connections WHERE purpose = 'business' AND provider = 'google' AND location_id = ?`, locationId), ['settings', 'state']) as OAuthConnection | undefined,
      setSettings: (cid: string, settings: Record<string, any>) => db.run('UPDATE oauth_connections SET settings = ?, updated_at = ? WHERE id = ?', JSON.stringify(settings), now(), cid),
      setState: (cid: string, state: Record<string, any>) => db.run('UPDATE oauth_connections SET state = ? WHERE id = ?', JSON.stringify(state), cid),
    };

    // --- agency: OAuth apps ---------------------------------------------------------
    const clientsOut = () => {
      const s = savedClients(app);
      const out: Record<string, any> = {};
      for (const p of PROVIDERS) {
        const saved = s[p] ?? {};
        const envId = p === 'google' ? process.env.PGHL_GOOGLE_CLIENT_ID : process.env.PGHL_MS_CLIENT_ID;
        const envSecret = p === 'google' ? process.env.PGHL_GOOGLE_CLIENT_SECRET : process.env.PGHL_MS_CLIENT_SECRET;
        out[p] = {
          client_id: saved.client_id || envId || '',
          client_secret: saved.client_secret || envSecret ? MASK : '',
          secret_set: !!(saved.client_secret || envSecret),
          from_env: !saved.client_id && !!envId,
          configured: !!clientConfig(app, p),
          redirect_uris: origins(app).map((o) => redirectUriFor(o, p)),
          ...(p === 'microsoft' ? { tenant: saved.tenant || process.env.PGHL_MS_TENANT || 'common' } : {}),
        };
      }
      out.connections = db.all(`SELECT provider, purpose, COUNT(*) AS n FROM oauth_connections GROUP BY provider, purpose`);
      return out;
    };
    router.get('/api/agency/oauth', 'admin', () => clientsOut());
    router.put('/api/agency/oauth', 'admin', (ctx) => {
      const cur = savedClients(app);
      const next: Record<string, any> = { ...cur };
      for (const p of PROVIDERS) {
        const b = ctx.body?.[p];
        if (!b || typeof b !== 'object') continue;
        const row = { ...(cur[p] ?? {}) };
        if (b.client_id !== undefined) {
          const cid = str(b.client_id, 'Client-ID', { max: 200 });
          if (cid && p === 'google' && !/^[\w.-]{10,200}$/.test(cid)) throw bad('Google Client-ID ungültig (…apps.googleusercontent.com)');
          if (cid && p === 'microsoft' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cid)) throw bad('Microsoft Anwendungs-ID ungültig (GUID)');
          row.client_id = cid;
        }
        if (b.client_secret === null) delete row.client_secret;
        else if (typeof b.client_secret === 'string' && b.client_secret.trim() && b.client_secret !== MASK) row.client_secret = sealSecret(app, str(b.client_secret, 'Client-Secret', { max: 500 }));
        if (p === 'microsoft' && b.tenant !== undefined) {
          const t = str(b.tenant, 'Mandant', { max: 100 }) || 'common';
          if (!/^[A-Za-z0-9.-]{1,100}$/.test(t)) throw bad('Mandant ungültig (common, organizations, consumers oder Mandanten-ID)');
          row.tenant = t;
        }
        next[p] = row;
      }
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'oauth_clients', JSON.stringify(next));
      return clientsOut();
    });

    router.get('/api/oauth/providers', 'user', () => ({ google: !!clientConfig(app, 'google'), microsoft: !!clientConfig(app, 'microsoft') }));

    // --- connect -----------------------------------------------------------------------
    router.post('/api/oauth/start', 'user', (ctx) => {
      const provider = String(ctx.body.provider ?? '') as Provider;
      const purpose = String(ctx.body.purpose ?? 'calendar') as Purpose;
      if (!PROVIDERS.includes(provider)) throw bad('Unbekannter Anbieter');
      if (!PURPOSES.includes(purpose)) throw bad('Unbekannter Zweck');
      if (purpose === 'business' && provider !== 'google') throw bad('Unternehmensprofil gibt es nur mit Google');
      const sid = ctx.cookies[SESSION_COOKIE];
      if (!sid || ctx.via !== 'session') throw new HttpError(403, 'Verbinden geht nur angemeldet im Browser');
      let locationId: string | null = null;
      if (purpose === 'business') {
        locationId = str(ctx.body.location_id ?? ctx.req.headers['x-location-id'], 'Sub-Account', { required: true });
        if (!app.location(locationId)) throw notFound('Sub-Account nicht gefunden');
        if (!canManageLocation(ctx.user, locationId)) throw new HttpError(403, 'Kein Zugriff auf die Einstellungen dieses Sub-Accounts');
      }
      const cfg = clientConfig(app, provider);
      if (!cfg) throw new HttpError(409, `Die Agentur hat noch keine ${PROVIDER_LABEL[provider]}-App hinterlegt (Agentur → Integrationen)`);
      // Come back on the address the user is signed in on (main address or agency domain).
      const host = String(ctx.req.headers.host ?? '').toLowerCase();
      const origin = origins(app).find((o) => new URL(o).host === host) ?? app.baseUrl();
      const redirectUri = redirectUriFor(origin, provider);
      const nonce = token(18);
      const { verifier, challenge } = pkcePair();
      db.run('DELETE FROM oauth_pending WHERE expires_at < ?', now());
      db.insert('oauth_pending', {
        nonce,
        provider,
        purpose,
        user_id: ctx.user!.id,
        location_id: locationId,
        verifier,
        redirect_uri: redirectUri,
        return_to: RETURN_TO[purpose],
        expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString(),
      });
      const state = signState(app.config.secret, { n: nonce, p: provider, k: purpose, u: ctx.user!.id, s: sha256(sid), ...(locationId ? { l: locationId } : {}), e: Date.now() + STATE_TTL_MS });
      return { url: authorizeUrl(provider, cfg, { redirectUri, scopes: scopesFor(provider, purpose), state, challenge, loginHint: ctx.body.login_hint ? String(ctx.body.login_hint).slice(0, 200) : undefined }) };
    });

    const back = (to: string, params: Record<string, string>) => redirect(`${to}?${new URLSearchParams(params)}`);

    router.get('/oauth/:provider/callback', 'public', async (ctx: Ctx) => {
      const provider = ctx.params.provider as Provider;
      if (!PROVIDERS.includes(provider)) throw notFound();
      const sid = ctx.cookies[SESSION_COOKIE];
      const user = sid ? db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(sid), now()) : undefined;
      if (!user) return html(messagePage('Nicht angemeldet', 'Bitte zuerst anmelden und dann noch einmal verbinden.'), 401);
      let payload;
      try {
        payload = verifyState(app.config.secret, String(ctx.query.get('state') ?? ''), { sessionHash: sha256(sid!) });
        if (payload.p !== provider || payload.u !== user.id) throw new Error('Ungültige Anfrage (state passt nicht)');
      } catch (e) {
        return html(messagePage('Verbinden fehlgeschlagen', (e as Error).message), 400);
      }
      const pending = db.get('SELECT * FROM oauth_pending WHERE nonce = ?', payload.n);
      db.run('DELETE FROM oauth_pending WHERE nonce = ?', payload.n);
      const purpose = payload.k;
      const returnTo = RETURN_TO[purpose] ?? '/app';
      if (!pending || pending.user_id !== user.id || pending.provider !== provider || Date.parse(pending.expires_at) < Date.now()) {
        return back(returnTo, { oauth: 'error', msg: 'Die Anmeldung ist abgelaufen oder wurde schon benutzt – bitte noch einmal verbinden' });
      }
      // Purposes other modules own (mail: modules/mailboxes.ts) finish the flow themselves – state and pending flow are checked above.
      const custom = (app.services.oauthPurposes ?? {})[purpose];
      if (custom) return custom.callback({ ctx, user, provider, pending, back: (p: Record<string, string>) => back(returnTo, p) });
      if (ctx.query.get('error')) {
        const denied = ctx.query.get('error') === 'access_denied';
        return back(returnTo, { oauth: 'error', msg: denied ? 'Zugriff wurde nicht erlaubt' : `${PROVIDER_LABEL[provider]}: ${String(ctx.query.get('error_description') || ctx.query.get('error')).slice(0, 200)}` });
      }
      const code = String(ctx.query.get('code') ?? '');
      if (!code) return back(returnTo, { oauth: 'error', msg: 'Kein Code erhalten' });
      const cfg = clientConfig(app, provider);
      if (!cfg) return back(returnTo, { oauth: 'error', msg: `Die ${PROVIDER_LABEL[provider]}-App der Agentur fehlt` });
      try {
        const t = await exchangeCode(fetcher(), provider, cfg, { code, verifier: pending.verifier, redirectUri: pending.redirect_uri, scopes: scopesFor(provider, purpose) });
        if (t.scope) {
          const missing = missingScopes(provider, purpose, t.scope);
          if (missing.length) {
            await revokeToken(fetcher(), provider, cfg, t.refresh_token ?? t.access_token);
            return back(returnTo, { oauth: 'error', msg: 'Bitte beim Verbinden alle Berechtigungen erlauben (Kalender lesen und Termine eintragen bzw. Unternehmensprofil verwalten)' });
          }
        }
        if (!t.refresh_token) return back(returnTo, { oauth: 'error', msg: `${PROVIDER_LABEL[provider]} hat keinen dauerhaften Zugriff erteilt – bitte noch einmal verbinden` });
        const claims = idTokenClaims(t.id_token);
        const locationId = purpose === 'business' ? (pending.location_id as string) : null;
        if (purpose === 'business') {
          const fullUser: User = { id: user.id, email: user.email, name: user.name, role: user.role, locations: JSON.parse(user.locations || '[]'), permissions: user.permissions ? JSON.parse(user.permissions) : null };
          if (!locationId || !canManageLocation(fullUser, locationId)) throw new Error('Kein Zugriff auf diesen Sub-Account');
        }
        const existing =
          purpose === 'calendar'
            ? db.get(`SELECT * FROM oauth_connections WHERE purpose = 'calendar' AND user_id = ? AND provider = ?`, user.id, provider)
            : db.get(`SELECT * FROM oauth_connections WHERE purpose = 'business' AND location_id = ? AND provider = ?`, locationId, provider);
        const tokens = {
          access_token: sealSecret(app, t.access_token),
          refresh_token: sealSecret(app, t.refresh_token),
          expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
          scopes: t.scope.slice(0, 2000),
          status: 'ok',
          last_error: null,
          updated_at: now(),
        };
        let cid: string;
        // Same account again: keep the choices and the sync state. Another account starts fresh.
        if (existing && (!claims.email || existing.account_email === claims.email)) {
          cid = existing.id;
          db.update('oauth_connections', cid, { ...tokens, account_name: claims.name || existing.account_name });
        } else {
          if (existing) db.run('DELETE FROM oauth_connections WHERE id = ?', existing.id);
          cid = id();
          db.insert('oauth_connections', {
            id: cid,
            provider,
            purpose,
            user_id: purpose === 'calendar' ? user.id : null,
            location_id: locationId,
            account_email: claims.email,
            account_name: claims.name,
            settings: {},
            state: {},
            created_at: now(),
            ...tokens,
          });
        }
        app.services.audit?.({ ctx, action: 'oauth.connect', summary: `${PROVIDER_LABEL[provider]} (${purpose === 'calendar' ? 'Kalender' : 'Unternehmensprofil'}): ${claims.email}`, userId: user.id, actor: user.name, locationId, entityId: cid });
        return back(returnTo, { oauth: 'ok', provider, connection: cid });
      } catch (e) {
        return back(returnTo, { oauth: 'error', msg: (e as Error).message.slice(0, 300) });
      }
    });

    /** Disconnect: revoke at the provider where possible, then forget the tokens (and everything synced with them). */
    router.delete('/api/oauth/connections/:id', 'user', async (ctx) => {
      const c = get(ctx.params.id);
      if (!c) throw notFound();
      const u = ctx.user!;
      const allowed = c.purpose === 'calendar' ? c.user_id === u.id || u.role === 'admin' : canManageLocation(u, c.location_id ?? '');
      if (!allowed) throw notFound();
      const cfg = clientConfig(app, c.provider);
      let revoked = false;
      if (cfg) {
        const tok = c.refresh_token ? openSecret(app, c.refresh_token) : c.access_token ? openSecret(app, c.access_token) : '';
        revoked = await revokeToken(fetcher(), c.provider, cfg, tok);
      }
      db.run('DELETE FROM oauth_connections WHERE id = ?', c.id);
      app.services.audit?.({ ctx, action: 'oauth.disconnect', summary: `${PROVIDER_LABEL[c.provider]}: ${c.account_email}`, locationId: c.location_id, entityId: c.id });
      return { ok: true, revoked };
    });

    app.onTick(() => void db.run('DELETE FROM oauth_pending WHERE expires_at < ?', now()));
  },
};
