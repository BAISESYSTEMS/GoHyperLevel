import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { HttpError, bad, html, notFound, redirect, str, type Ctx, type User } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { now, sha256, token } from '../core/util.js';
import { discoverCustomers, googleApi, type GoogleCustomer } from '../services/ads-google.js';
import { discover, exchangeMetaCode, extendMetaToken, grantedScopes, metaApi, metaAuthorizeUrl, pixels } from '../services/ads-meta.js';
import {
  GOOGLE_ADS_SCOPE,
  MASK,
  META_LEAD_SCOPES,
  META_SCOPES,
  agencyAds,
  audit,
  canManage,
  connected,
  isHuman,
  fetcherOf,
  googleAuth,
  googleCreds,
  loadConnection,
  maxDailyBudget,
  metaCreds,
  relay,
  saveAgencyAds,
  saveConnection,
  setConnectionError,
  type Platform,
  META_ADS_VERSION,
} from '../services/ads-store.js';
import { STATE_TTL_MS, authorizeUrl, exchangeCode, idTokenClaims, pkcePair, revokeToken, signState, verifyState, type Purpose, type StatePayload } from '../services/oauth.js';
import { canManageLocation, clientConfig } from './oauth-connect.js';

/**
 * Connections of the ads manager: per sub-account Meta (Facebook Login → long-lived token, ad account, Page, pixel)
 * and Google Ads (the agency's Google OAuth app + developer token → refresh token, customer account), plus the
 * agency's own settings (Meta app, Google Ads developer token, manager account) and the per-sub-account budget limit.
 * The connection lives in `ads_accounts` – the same row the ad reporting reads, so one login serves both.
 */

const PLATFORMS: Platform[] = ['meta', 'google'];
const RETURN_TO = '/app/ads/connections';
const REFRESH_WITHIN_MS = 20 * 86400_000;

export const metaRedirectUri = (origin: string) => `${origin}/oauth/ads/meta/callback`;
export const googleRedirectUri = (origin: string) => `${origin}/oauth/ads/google/callback`;

function origins(app: App): string[] {
  const list = [app.config.baseUrl.replace(/\/$/, '')];
  const pub = app.services.publicBaseUrl?.();
  if (pub) list.push(String(pub).replace(/\/$/, ''));
  return [...new Set(list)];
}

/** Credentials, limits and the choice of the ad account that spends money: a person in the app, never a key, MCP client or agent. */
const person = (ctx: Ctx) => {
  if (!isHuman(ctx)) throw new HttpError(403, 'Das geht nur angemeldet in der Oberfläche – nicht mit API-Schlüssel, MCP oder Agent');
};

const fullUser = (row: any): User => ({ id: row.id, email: row.email, name: row.name, role: row.role, locations: JSON.parse(row.locations || '[]'), permissions: row.permissions ? JSON.parse(row.permissions) : null });

export const adsConnectModule: Module = {
  name: 'ads-connect',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_oauth_pending (
        nonce TEXT PRIMARY KEY, platform TEXT NOT NULL, user_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, lead_ads INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL
      );
      CREATE TABLE ads_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        max_daily_budget_cents INTEGER NOT NULL DEFAULT 50000, updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = () => fetcherOf(app);

    /** What the browser may see of a connection: never tokens. */
    const out = (locationId: string, platform: Platform) => {
      const conn = loadConnection(app, locationId, platform);
      const c = conn?.config ?? {};
      const meta = metaCreds(conn);
      const g = googleCreds(app, conn);
      const ready = connected(app, platform, conn);
      const hasToken = platform === 'meta' ? !!meta.token : !!g.refreshToken;
      const scopes: string[] = Array.isArray(c.scopes) ? c.scopes : [];
      return {
        platform,
        connected: ready,
        has_token: hasToken,
        needs_selection: hasToken && !ready && (platform === 'meta' ? !!meta.token && !meta.adAccountId : !!g.refreshToken && !g.customerId && !!(g.developerToken && g.clientId)),
        via: conn ? (c.connected_via === 'oauth' ? 'oauth' : 'manual') : null,
        can_manage: ready ? canManage(platform, conn) : false,
        account: platform === 'meta' ? (meta.adAccountId ? { id: meta.adAccountId, name: c.ad_account_name ?? '', currency: c.currency ?? 'EUR' } : null) : g.customerId ? { id: g.customerId, name: c.customer_name ?? '', currency: c.currency ?? 'EUR' } : null,
        page: platform === 'meta' && meta.pageId ? { id: meta.pageId, name: c.page_name ?? '' } : null,
        pixel_id: platform === 'meta' ? meta.pixelId : undefined,
        login_customer_id: platform === 'google' ? g.loginCustomerId : undefined,
        lead_ads: platform === 'meta' ? !!(meta.pageToken && scopes.includes('leads_retrieval')) : undefined,
        account_email: c.account_email ?? c.fb_user_name ?? '',
        scopes,
        token_expires_at: c.token_expires_at ?? null,
        test_account: c.test_account ?? undefined,
        last_error: conn?.last_error ?? null,
        // What is missing on the agency side, so the screen can say what to do first.
        agency: platform === 'meta' ? { ready: !!(agencyAds(app).meta.app_id && agencyAds(app).meta.app_secret) } : { ready: !!clientConfig(app, 'google') && !!g.developerToken, oauth_app: !!clientConfig(app, 'google'), developer_token: !!g.developerToken },
      };
    };

    router.get('/api/ads/connections', 'location', (ctx) => ({
      meta: out(ctx.locationId, 'meta'),
      google: out(ctx.locationId, 'google'),
      settings: { max_daily_budget_cents: maxDailyBudget(app, ctx.locationId) },
    }));

    router.get('/api/ads/settings', 'location', (ctx) => ({ max_daily_budget_cents: maxDailyBudget(app, ctx.locationId) }));
    router.put('/api/ads/settings', 'location', (ctx) => {
      person(ctx);
      const v = Math.round(Number(ctx.body?.max_daily_budget_cents));
      if (!Number.isFinite(v) || v < 100 || v > 100_000_000) throw bad('Tageslimit: zwischen 1 € und 1.000.000 €');
      db.run(
        `INSERT INTO ads_settings (location_id, max_daily_budget_cents, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET max_daily_budget_cents = excluded.max_daily_budget_cents, updated_at = excluded.updated_at`,
        ctx.locationId, v, now(),
      );
      audit(app, ctx, 'ads.settings.limit', `Tageslimit für Anzeigen auf ${(v / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })} gesetzt`, { locationId: ctx.locationId });
      return { max_daily_budget_cents: v };
    });

    // --- agency: Meta app, Google Ads developer token ----------------------------------------------------
    const agencyOut = () => {
      const a = agencyAds(app);
      let verify = a.meta.verify_token;
      if (!verify) {
        verify = token(18);
        saveAgencyAds(app, { meta: { verify_token: verify } });
      }
      const o = origins(app);
      return {
        meta: {
          app_id: a.meta.app_id,
          app_secret: a.meta.app_secret ? MASK : '',
          secret_set: !!a.meta.app_secret,
          verify_token: verify,
          webhook_url: `${app.baseUrl()}/hooks/ads/meta`,
          redirect_uris: o.map(metaRedirectUri),
          api_version: META_ADS_VERSION,
        },
        google: {
          developer_token: a.google.developer_token ? MASK : '',
          developer_token_set: !!a.google.developer_token,
          login_customer_id: a.google.login_customer_id,
          oauth_app: !!clientConfig(app, 'google'),
          redirect_uris: o.map(googleRedirectUri),
        },
      };
    };
    router.get('/api/ads/agency', 'admin', () => agencyOut());
    router.put('/api/ads/agency', 'admin', (ctx) => {
      person(ctx);
      const b = ctx.body ?? {};
      const meta: Record<string, string | null> = {};
      const google: Record<string, string | null> = {};
      if (b.meta && typeof b.meta === 'object') {
        if (b.meta.app_id !== undefined) {
          const v = str(b.meta.app_id, 'App-ID', { max: 30 }).replace(/\s/g, '');
          if (v && !/^\d{5,25}$/.test(v)) throw bad('Meta App-ID: nur Ziffern');
          meta.app_id = v || null;
        }
        if (b.meta.app_secret === null) meta.app_secret = null;
        else if (typeof b.meta.app_secret === 'string' && b.meta.app_secret.trim() && b.meta.app_secret !== MASK) {
          const v = b.meta.app_secret.trim();
          if (!/^[\w-]{16,80}$/.test(v)) throw bad('Meta App-Secret sieht ungültig aus');
          meta.app_secret = v;
        }
        if (b.meta.regenerate_verify_token) meta.verify_token = token(18);
      }
      if (b.google && typeof b.google === 'object') {
        if (b.google.developer_token === null) google.developer_token = null;
        else if (typeof b.google.developer_token === 'string' && b.google.developer_token.trim() && b.google.developer_token !== MASK) {
          const v = b.google.developer_token.trim();
          if (!/^[\w-]{10,80}$/.test(v)) throw bad('Developer-Token sieht ungültig aus');
          google.developer_token = v;
        }
        if (b.google.login_customer_id !== undefined) {
          const v = String(b.google.login_customer_id ?? '').replace(/\D/g, '');
          if (v && v.length !== 10) throw bad('Verwaltungskonto-ID: 10 Ziffern (123-456-7890)');
          google.login_customer_id = v || null;
        }
      }
      saveAgencyAds(app, { meta, google });
      audit(app, ctx, 'ads.agency.update', `Anzeigen-Zugänge der Agentur geändert (${[...Object.keys(meta).map((k) => `Meta ${k}`), ...Object.keys(google).map((k) => `Google ${k}`)].join(', ') || 'nichts'})`, { locationId: null });
      return agencyOut();
    });

    // --- OAuth: start -----------------------------------------------------------------------------------------
    const originFor = (ctx: Ctx) => {
      const host = String(ctx.req.headers.host ?? '').toLowerCase();
      return origins(app).find((o) => new URL(o).host === host) ?? app.baseUrl();
    };

    router.post('/api/ads/connect/:platform/start', 'location', (ctx) => {
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw bad('Unbekannte Plattform');
      const sid = ctx.cookies[SESSION_COOKIE];
      if (!sid || ctx.via !== 'session') throw new HttpError(403, 'Verbinden geht nur angemeldet im Browser');
      const leadAds = !!ctx.body?.lead_ads;
      const redirectUri = (platform === 'meta' ? metaRedirectUri : googleRedirectUri)(originFor(ctx));
      const nonce = token(18);
      const { verifier, challenge } = pkcePair();
      db.run('DELETE FROM ads_oauth_pending WHERE expires_at < ?', now());
      let url: string;
      const payload = { n: nonce, p: platform as unknown as StatePayload['p'], k: 'ads' as unknown as Purpose, u: ctx.user!.id, s: sha256(sid), l: ctx.locationId, e: Date.now() + STATE_TTL_MS };
      if (platform === 'meta') {
        const a = agencyAds(app).meta;
        if (!a.app_id || !a.app_secret) throw new HttpError(409, 'Die Agentur hat noch keine Meta-App hinterlegt (Anzeigen → Verbindungen → Agentur)');
        url = metaAuthorizeUrl(META_ADS_VERSION, { appId: a.app_id, redirectUri, state: signState(app.config.secret, payload), scopes: [...META_SCOPES, ...(leadAds ? META_LEAD_SCOPES : [])] });
      } else {
        const cfg = clientConfig(app, 'google');
        if (!cfg) throw new HttpError(409, 'Die Agentur hat noch keine Google-App hinterlegt (Agentur → Integrationen)');
        if (!googleCreds(app, loadConnection(app, ctx.locationId, 'google')).developerToken) throw new HttpError(409, 'Der Google-Ads-Developer-Token fehlt (Anzeigen → Verbindungen → Agentur)');
        url = authorizeUrl('google', cfg, { redirectUri, scopes: ['openid', 'email', GOOGLE_ADS_SCOPE], state: signState(app.config.secret, payload), challenge });
      }
      db.insert('ads_oauth_pending', { nonce, platform, user_id: ctx.user!.id, location_id: ctx.locationId, verifier, redirect_uri: redirectUri, lead_ads: leadAds ? 1 : 0, expires_at: new Date(Date.now() + STATE_TTL_MS).toISOString() });
      return { url };
    });

    // --- OAuth: callback -----------------------------------------------------------------------------------------
    const back = (params: Record<string, string>) => redirect(`${RETURN_TO}?${new URLSearchParams(params)}`);

    router.get('/oauth/ads/:platform/callback', 'public', async (ctx: Ctx) => {
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw notFound();
      const sid = ctx.cookies[SESSION_COOKIE];
      const user = sid ? db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(sid), now()) : undefined;
      if (!user) return html(messagePage('Nicht angemeldet', 'Bitte zuerst anmelden und dann noch einmal verbinden.'), 401);
      let payload: StatePayload;
      try {
        payload = verifyState(app.config.secret, String(ctx.query.get('state') ?? ''), { sessionHash: sha256(sid!) });
        if ((payload.p as string) !== platform || payload.u !== user.id) throw new Error('Ungültige Anfrage (state passt nicht)');
      } catch (e) {
        return html(messagePage('Verbinden fehlgeschlagen', (e as Error).message), 400);
      }
      const pending = db.get('SELECT * FROM ads_oauth_pending WHERE nonce = ?', payload.n);
      db.run('DELETE FROM ads_oauth_pending WHERE nonce = ?', payload.n);
      if (!pending || pending.user_id !== user.id || pending.platform !== platform || Date.parse(pending.expires_at) < Date.now()) return back({ oauth: 'error', msg: 'Die Anmeldung ist abgelaufen oder wurde schon benutzt – bitte noch einmal verbinden' });
      const locationId: string = pending.location_id;
      if (!canManageLocation(fullUser(user), locationId)) return back({ oauth: 'error', msg: 'Kein Zugriff auf die Einstellungen dieses Sub-Accounts' });
      if (ctx.query.get('error')) {
        const denied = ['access_denied', 'user_denied'].includes(String(ctx.query.get('error_reason') ?? ctx.query.get('error')));
        return back({ oauth: 'error', msg: denied ? 'Zugriff wurde nicht erlaubt' : `${platform === 'meta' ? 'Meta' : 'Google'}: ${String(ctx.query.get('error_description') || ctx.query.get('error')).slice(0, 200)}` });
      }
      const code = String(ctx.query.get('code') ?? '');
      if (!code) return back({ oauth: 'error', msg: 'Kein Code erhalten' });
      try {
        if (platform === 'meta') await finishMeta(ctx, user, locationId, code, pending);
        else await finishGoogle(ctx, user, locationId, code, pending);
        return back({ oauth: 'ok', platform });
      } catch (e) {
        return back({ oauth: 'error', msg: (e as Error).message.slice(0, 300) });
      }
    });

    async function finishMeta(ctx: Ctx, user: any, locationId: string, code: string, pending: any) {
      const a = agencyAds(app).meta;
      if (!a.app_id || !a.app_secret) throw new Error('Die Meta-App der Agentur fehlt');
      const t = await exchangeMetaCode(fetcher(), META_ADS_VERSION, { appId: a.app_id, appSecret: a.app_secret, redirectUri: pending.redirect_uri, code });
      const api = metaApi(fetcher(), META_ADS_VERSION, t.access_token);
      const granted = await grantedScopes(api).catch(() => [] as string[]);
      if (!granted.includes('ads_management') && !granted.includes('ads_read')) throw new Error('Bitte beim Verbinden die Rechte für Anzeigen erlauben (ads_management und ads_read)');
      const found = await discover(api);
      const cur = loadConnection(app, locationId, 'meta');
      const same = cur?.config.fb_user_id && cur.config.fb_user_id === found.user.id;
      const config: Record<string, any> = {
        connected_via: 'oauth',
        scopes: granted,
        token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        fb_user_id: found.user.id,
        fb_user_name: found.user.name,
        connected_at: now(),
      };
      const secrets: Record<string, string | null> = { token: t.access_token };
      // Same person again keeps the choices; another login starts fresh. A single account/page is picked right away.
      const keepAccount = same && found.ad_accounts.find((x) => x.id === cur!.config.ad_account_id);
      const account = keepAccount || (found.ad_accounts.length === 1 ? found.ad_accounts[0] : undefined);
      if (account) Object.assign(config, { ad_account_id: account.id, ad_account_name: account.name, currency: account.currency });
      else Object.assign(config, { ad_account_id: '', ad_account_name: '', currency: 'EUR', pixel_id: '' });
      const keepPage = same && found.pages.find((x) => x.id === cur!.config.page_id);
      const page = keepPage || (found.pages.length === 1 ? found.pages[0] : undefined);
      if (page) {
        Object.assign(config, { page_id: page.id, page_name: page.name });
        secrets.page_token = page.token || null;
      } else {
        Object.assign(config, { page_id: '', page_name: '' });
        secrets.page_token = null;
      }
      if (!same) config.pixel_id = '';
      saveConnection(app, locationId, 'meta', { config, secrets });
      setConnectionError(app, locationId, 'meta', null);
      audit(app, ctx, 'ads.connect', `Meta verbunden: ${found.user.name}${granted.includes('ads_management') ? '' : ' (nur lesend – ads_management fehlt)'}`, { locationId, userId: user.id, actor: user.name });
    }

    async function finishGoogle(ctx: Ctx, user: any, locationId: string, code: string, pending: any) {
      const cfg = clientConfig(app, 'google');
      if (!cfg) throw new Error('Die Google-App der Agentur fehlt');
      const t = await exchangeCode(fetcher(), 'google', cfg, { code, verifier: pending.verifier, redirectUri: pending.redirect_uri, scopes: [] });
      if (t.scope && !t.scope.split(/\s+/).includes(GOOGLE_ADS_SCOPE)) {
        await revokeToken(fetcher(), 'google', cfg, t.refresh_token ?? t.access_token);
        throw new Error('Bitte beim Verbinden den Zugriff auf Google Ads erlauben');
      }
      if (!t.refresh_token) throw new Error('Google hat keinen dauerhaften Zugriff erteilt – bitte noch einmal verbinden');
      const claims = idTokenClaims(t.id_token);
      const cur = loadConnection(app, locationId, 'google');
      const same = cur?.config.account_email && cur.config.account_email === claims.email;
      const config: Record<string, any> = { connected_via: 'oauth', scopes: ['openid', 'email', GOOGLE_ADS_SCOPE], account_email: claims.email, connected_at: now() };
      if (!same) Object.assign(config, { customer_id: '', customer_name: '', login_customer_id: '' });
      // The OAuth app is the agency's: values from an earlier manual setup must not shadow it.
      saveConnection(app, locationId, 'google', { config, secrets: { refresh_token: t.refresh_token, client_id: null, client_secret: null } });
      setConnectionError(app, locationId, 'google', null);
      audit(app, ctx, 'ads.connect', `Google Ads verbunden: ${claims.email}`, { locationId, userId: user.id, actor: user.name });
    }

    // --- choose the ad account ---------------------------------------------------------------------------------
    const metaApiFor = (locationId: string) => {
      const conn = loadConnection(app, locationId, 'meta');
      const c = metaCreds(conn);
      if (!c.token) throw bad('Meta ist noch nicht verbunden');
      return { conn: conn!, c, api: metaApi(fetcher(), c.version, c.token) };
    };

    router.get('/api/ads/connections/:platform/options', 'location', async (ctx) => {
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw bad('Unbekannte Plattform');
      if (platform === 'meta') {
        const { c, api } = metaApiFor(ctx.locationId);
        const found = await relay(() => discover(api));
        const accountId = String(ctx.query.get('ad_account_id') || c.adAccountId || '').replace(/^act_/, '');
        const px = accountId && found.ad_accounts.some((a) => a.id === accountId) ? await pixels(api, accountId).catch(() => []) : [];
        return { ad_accounts: found.ad_accounts, pages: found.pages.map((p) => ({ id: p.id, name: p.name })), pixels: px };
      }
      const conn = loadConnection(app, ctx.locationId, 'google');
      const g = googleCreds(app, conn);
      if (!g.refreshToken) throw bad('Google Ads ist noch nicht verbunden');
      const list: GoogleCustomer[] = await relay(async () => discoverCustomers(googleApi(fetcher(), await googleAuth(app, conn)), g.loginCustomerId));
      return { customers: list, login_customer_id: g.loginCustomerId };
    });

    router.put('/api/ads/connections/:platform/selection', 'location', async (ctx) => {
      person(ctx);
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw bad('Unbekannte Plattform');
      const b = ctx.body ?? {};
      if (platform === 'meta') {
        const { c, api } = metaApiFor(ctx.locationId);
        const found = await relay(() => discover(api));
        const config: Record<string, any> = {};
        const secrets: Record<string, string | null> = {};
        let accountId = c.adAccountId;
        if (b.ad_account_id !== undefined) {
          accountId = String(b.ad_account_id).replace(/^act_/, '').replace(/\s/g, '');
          const acc = found.ad_accounts.find((x) => x.id === accountId);
          if (!acc) throw bad('Dieses Werbekonto ist mit dem Zugang nicht erreichbar');
          if (accountId !== c.adAccountId) config.pixel_id = '';
          Object.assign(config, { ad_account_id: acc.id, ad_account_name: acc.name, currency: acc.currency });
        }
        if (b.page_id !== undefined) {
          const pid = String(b.page_id).trim();
          if (pid) {
            const page = found.pages.find((x) => x.id === pid);
            if (!page) throw bad('Diese Facebook-Seite ist mit dem Zugang nicht erreichbar');
            Object.assign(config, { page_id: page.id, page_name: page.name });
            secrets.page_token = page.token || null;
          } else Object.assign(config, { page_id: '', page_name: '' }), (secrets.page_token = null);
        }
        if (b.pixel_id !== undefined) {
          const px = String(b.pixel_id).trim();
          if (px) {
            if (!accountId) throw bad('Bitte zuerst ein Werbekonto wählen');
            const list = await relay(() => pixels(api, accountId));
            if (!list.some((x) => x.id === px)) throw bad('Dieses Pixel gehört nicht zum Werbekonto');
          }
          config.pixel_id = px;
        }
        saveConnection(app, ctx.locationId, 'meta', { config, secrets });
        audit(app, ctx, 'ads.connect.select', `Meta: Werbekonto/Seite/Pixel gewählt (${config.ad_account_name ?? c.adAccountId})`, { locationId: ctx.locationId });
        return out(ctx.locationId, 'meta');
      }
      const conn = loadConnection(app, ctx.locationId, 'google');
      const g = googleCreds(app, conn);
      if (!g.refreshToken) throw bad('Google Ads ist noch nicht verbunden');
      const config: Record<string, any> = {};
      if (b.customer_id !== undefined) {
        const cid = String(b.customer_id).replace(/\D/g, '');
        const list = await relay(async () => discoverCustomers(googleApi(fetcher(), await googleAuth(app, conn)), g.loginCustomerId));
        const hit = list.find((x) => x.id === cid);
        if (!hit) throw bad('Dieses Google-Ads-Konto ist mit dem Zugang nicht erreichbar');
        Object.assign(config, { customer_id: hit.id, customer_name: hit.name, currency: hit.currency, test_account: hit.test });
        // Accounts of the agency's manager account are called with that account as login customer.
        config.login_customer_id = hit.via_mcc ? g.loginCustomerId : '';
      }
      if (b.login_customer_id !== undefined) {
        const v = String(b.login_customer_id).replace(/\D/g, '');
        if (v && v.length !== 10) throw bad('Verwaltungskonto-ID: 10 Ziffern');
        config.login_customer_id = v;
      }
      saveConnection(app, ctx.locationId, 'google', { config });
      audit(app, ctx, 'ads.connect.select', `Google Ads: Konto gewählt (${config.customer_name ?? g.customerId})`, { locationId: ctx.locationId });
      return out(ctx.locationId, 'google');
    });

    router.delete('/api/ads/connections/:platform', 'location', async (ctx) => {
      person(ctx);
      const platform = ctx.params.platform as Platform;
      if (!PLATFORMS.includes(platform)) throw bad('Unbekannte Plattform');
      const conn = loadConnection(app, ctx.locationId, platform);
      let revoked = false;
      if (conn?.config.connected_via === 'oauth') {
        try {
          if (platform === 'google') {
            const cfg = clientConfig(app, 'google');
            if (cfg && conn.secrets.refresh_token) revoked = await revokeToken(fetcher(), 'google', cfg, conn.secrets.refresh_token);
          } else if (conn.secrets.token) {
            await metaApi(fetcher(), metaCreds(conn).version, conn.secrets.token).call('DELETE', 'me/permissions');
            revoked = true;
          }
        } catch {
          /* the grant stays at the platform; the person can remove it there */
        }
      }
      db.run('DELETE FROM ads_accounts WHERE location_id = ? AND platform = ?', ctx.locationId, platform);
      db.run('DELETE FROM ads_daily WHERE location_id = ? AND platform = ?', ctx.locationId, platform);
      db.run('DELETE FROM ads_remote WHERE location_id = ? AND platform = ?', ctx.locationId, platform);
      audit(app, ctx, 'ads.disconnect', `${platform === 'meta' ? 'Meta' : 'Google Ads'} getrennt${revoked ? ' (Zugriff entzogen)' : ''}`, { locationId: ctx.locationId });
      return { ok: true, revoked };
    });

    // --- keep Meta's token alive ----------------------------------------------------------------------------------
    // Long-lived user tokens last about 60 days; exchanging one that is still valid gives a fresh one.
    let lastRefresh = 0;
    app.onTick(async () => {
      if (Date.now() - lastRefresh < 6 * 3600_000) return;
      lastRefresh = Date.now();
      const a = agencyAds(app).meta;
      if (!a.app_id || !a.app_secret) return;
      for (const row of db.all<{ location_id: string }>(`SELECT location_id FROM ads_accounts WHERE platform = 'meta'`)) {
        const conn = loadConnection(app, row.location_id, 'meta');
        if (!conn || conn.config.connected_via !== 'oauth' || !conn.secrets.token) continue;
        const left = Date.parse(conn.config.token_expires_at ?? '') - Date.now();
        if (!(left < REFRESH_WITHIN_MS)) continue;
        try {
          const t = await extendMetaToken(fetcher(), metaCreds(conn).version, { appId: a.app_id, appSecret: a.app_secret, token: conn.secrets.token });
          saveConnection(app, row.location_id, 'meta', { config: { token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() }, secrets: { token: t.access_token } });
          setConnectionError(app, row.location_id, 'meta', null);
        } catch (e) {
          if (left < 3 * 86400_000) setConnectionError(app, row.location_id, 'meta', 'Der Meta-Zugang läuft bald ab – bitte unter Anzeigen → Verbindungen neu verbinden');
          console.warn('[ads] token refresh', row.location_id, (e as Error).message);
        }
      }
    });
    app.onTick(() => void db.run('DELETE FROM ads_oauth_pending WHERE expires_at < ?', now()));
  },
};
