import type { App } from '../core/app.js';
import { HttpError, type Ctx } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import { clientConfig } from '../modules/oauth-connect.js';
import { writeAudit } from '../modules/security.js';
import { AdsError, googleAccessToken } from './ads.js';

/**
 * Shared state of the ads manager (Meta + Google): the per-sub-account connection (table ads_accounts, shared with
 * the reporting), the agency-wide credentials (Meta app, Google Ads developer token), the activity log of a
 * campaign, the spending rules every spend change goes through and a few small helpers.
 */

export type Platform = 'meta' | 'google';
export const PLATFORMS: Platform[] = ['meta', 'google'];
export const PLATFORM_LABEL: Record<Platform, string> = { meta: 'Meta (Facebook & Instagram)', google: 'Google Ads' };

/** Marketing API / Google Ads API versions the manager talks to. Both can be overridden per connection (config.api_version). */
export const META_ADS_VERSION = 'v25.0';
export const GOOGLE_ADS_VERSION = 'v25';
export const META_SCOPES = ['ads_management', 'ads_read', 'business_management'];
/** Only asked for when the person wants Lead Ads (instant forms): they need a Page access token and the leads. */
export const META_LEAD_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'leads_retrieval'];
export const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

export const MASK = '••••••';

export interface Connection {
  location_id: string;
  platform: Platform;
  config: Record<string, any>;
  secrets: Record<string, string>;
  enabled: boolean;
  last_error: string | null;
}

/** Test hook: tests replace the network for Meta and Google (the reporting uses the same one). */
export const fetcherOf = (app: App): typeof fetch => app.services.adsFetch ?? fetch;

export function loadConnection(app: App, locationId: string, platform: Platform): Connection | undefined {
  const row = app.db.get('SELECT * FROM ads_accounts WHERE location_id = ? AND platform = ?', locationId, platform);
  if (!row) return undefined;
  let secrets: Record<string, string> = {};
  try {
    secrets = row.secrets ? JSON.parse(openSecret(app, row.secrets)) : {};
  } catch {
    secrets = {}; // the server secret changed: the connection has to be made again
  }
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch {
    config = {};
  }
  return { location_id: locationId, platform, config, secrets, enabled: !!row.enabled, last_error: row.last_error ?? null };
}

/** Merges into the connection: `config` shallow, `secrets` per key (null removes one). */
export function saveConnection(app: App, locationId: string, platform: Platform, patch: { config?: Record<string, any>; secrets?: Record<string, string | null> }): Connection {
  const cur = loadConnection(app, locationId, platform);
  const config = { ...(cur?.config ?? {}), ...(patch.config ?? {}) };
  const secrets: Record<string, string> = { ...(cur?.secrets ?? {}) };
  for (const [k, v] of Object.entries(patch.secrets ?? {})) {
    if (v === null || v === '') delete secrets[k];
    else secrets[k] = v;
  }
  app.db.run(
    `INSERT INTO ads_accounts (location_id, platform, config, secrets, enabled, updated_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(location_id, platform) DO UPDATE SET config = excluded.config, secrets = excluded.secrets, updated_at = excluded.updated_at`,
    locationId, platform, JSON.stringify(config), sealSecret(app, JSON.stringify(secrets)), now(),
  );
  return loadConnection(app, locationId, platform)!;
}

export function setConnectionError(app: App, locationId: string, platform: Platform, msg: string | null) {
  app.db.run('UPDATE ads_accounts SET last_error = ? WHERE location_id = ? AND platform = ?', msg ? msg.slice(0, 500) : null, locationId, platform);
}

// --- agency-wide credentials ---------------------------------------------------------------------

export interface AgencyAds {
  meta: { app_id: string; app_secret: string; verify_token: string };
  google: { developer_token: string; login_customer_id: string };
}

const AGENCY_KEY = 'ads_agency';

function savedAgency(app: App): Record<string, any> {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', AGENCY_KEY);
  try {
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}

const openOr = (app: App, sealed: unknown, fallback = '') => {
  if (typeof sealed !== 'string' || !sealed) return fallback;
  try {
    return openSecret(app, sealed);
  } catch {
    return fallback;
  }
};

/** Saved settings first, then the environment (PGHL_META_APP_ID/-SECRET, PGHL_GOOGLE_ADS_DEVELOPER_TOKEN/-LOGIN_CUSTOMER_ID). */
export function agencyAds(app: App): AgencyAds {
  const s = savedAgency(app);
  return {
    meta: {
      app_id: s.meta?.app_id || process.env.PGHL_META_APP_ID || '',
      app_secret: openOr(app, s.meta?.app_secret, process.env.PGHL_META_APP_SECRET || ''),
      verify_token: s.meta?.verify_token || '',
    },
    google: {
      developer_token: openOr(app, s.google?.developer_token, process.env.PGHL_GOOGLE_ADS_DEVELOPER_TOKEN || ''),
      login_customer_id: String(s.google?.login_customer_id || process.env.PGHL_GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/\D/g, ''),
    },
  };
}

export function saveAgencyAds(app: App, patch: { meta?: Record<string, string | null>; google?: Record<string, string | null> }) {
  const s = savedAgency(app);
  const next: Record<string, any> = { meta: { ...(s.meta ?? {}) }, google: { ...(s.google ?? {}) } };
  for (const [k, v] of Object.entries(patch.meta ?? {})) {
    if (v === null || v === '') delete next.meta[k];
    else next.meta[k] = k === 'app_secret' ? sealSecret(app, v) : v;
  }
  for (const [k, v] of Object.entries(patch.google ?? {})) {
    if (v === null || v === '') delete next.google[k];
    else next.google[k] = k === 'developer_token' ? sealSecret(app, v) : v;
  }
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', AGENCY_KEY, JSON.stringify(next));
}

// --- credentials of one connection ---------------------------------------------------------------------

export interface MetaCreds {
  token: string;
  pageToken: string;
  adAccountId: string;
  pageId: string;
  pixelId: string;
  version: string;
}

export function metaCreds(conn: Connection | undefined): MetaCreds {
  const c = conn?.config ?? {};
  const v = String(c.api_version ?? '');
  return {
    token: conn?.secrets.token ?? '',
    pageToken: conn?.secrets.page_token ?? '',
    adAccountId: String(c.ad_account_id ?? ''),
    pageId: String(c.page_id ?? ''),
    pixelId: String(c.pixel_id ?? ''),
    version: /^v\d{2}\.\d$/.test(v) ? v : META_ADS_VERSION,
  };
}

export interface GoogleCreds {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId: string;
  version: string;
}

/** Per-connection values win (manual setup), then the agency's Google OAuth app and developer token. */
export function googleCreds(app: App, conn: Connection | undefined): GoogleCreds {
  const agency = agencyAds(app).google;
  const oauth = clientConfig(app, 'google');
  const c = conn?.config ?? {};
  const s = conn?.secrets ?? {};
  const v = String(c.api_version ?? '');
  return {
    developerToken: s.developer_token || agency.developer_token,
    clientId: s.client_id || oauth?.client_id || '',
    clientSecret: s.client_secret || oauth?.client_secret || '',
    refreshToken: s.refresh_token || '',
    customerId: String(c.customer_id ?? ''),
    loginCustomerId: String(c.login_customer_id || agency.login_customer_id || ''),
    version: /^v\d{1,3}$/.test(v) ? v : GOOGLE_ADS_VERSION,
  };
}

export const metaReady = (conn: Connection | undefined) => !!(conn?.secrets.token && conn.config.ad_account_id);
export const googleReady = (app: App, conn: Connection | undefined) => {
  const g = googleCreds(app, conn);
  return !!(g.developerToken && g.clientId && g.clientSecret && g.refreshToken && g.customerId);
};
export const connected = (app: App, platform: Platform, conn: Connection | undefined) => (platform === 'meta' ? metaReady(conn) : googleReady(app, conn));

/** Whether the token may change things (ads_management / the adwords scope), not just read. */
export function canManage(platform: Platform, conn: Connection | undefined): boolean {
  if (!conn) return false;
  // Manual connections (system-user token, refresh token) are trusted; the platform refuses what they may not do.
  if (conn.config.connected_via !== 'oauth') return true;
  const granted: string[] = Array.isArray(conn.config.scopes) ? conn.config.scopes : [];
  return platform === 'meta' ? granted.includes('ads_management') : granted.includes(GOOGLE_ADS_SCOPE);
}

const accessTokens = new Map<string, { token: string; until: number }>();

export interface GoogleAuth {
  accessToken: string;
  developerToken: string;
  customerId: string;
  loginCustomerId: string;
  version: string;
}

/** Access token (cached for most of its hour) plus the headers' ingredients. */
export async function googleAuth(app: App, conn: Connection | undefined): Promise<GoogleAuth> {
  const g = googleCreds(app, conn);
  if (!g.developerToken) throw new AdsError('Google Ads: Developer-Token fehlt (Anzeigen → Verbindungen → Agentur)');
  if (!g.clientId || !g.clientSecret) throw new AdsError('Google Ads: Die Google-App der Agentur fehlt (Agentur → Integrationen)');
  if (!g.refreshToken) throw new AdsError('Google Ads ist noch nicht verbunden');
  const key = `${conn!.location_id}:${g.refreshToken.slice(-12)}`;
  let hit = accessTokens.get(key);
  if (!hit || hit.until < Date.now()) {
    const token = await googleAccessToken(fetcherOf(app), { client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken });
    hit = { token, until: Date.now() + 50 * 60_000 };
    accessTokens.set(key, hit);
    if (accessTokens.size > 500) accessTokens.delete(accessTokens.keys().next().value!);
  }
  return { accessToken: hit.token, developerToken: g.developerToken, customerId: g.customerId, loginCustomerId: g.loginCustomerId, version: g.version };
}

// --- per-sub-account settings ----------------------------------------------------------------------------

/** Daily budget no campaign of this sub-account may exceed (also protects against typos and over-eager agents). */
export const DEFAULT_MAX_DAILY_CENTS = 50_000;

export function maxDailyBudget(app: App, locationId: string): number {
  const row = app.db.get<{ max_daily_budget_cents: number }>('SELECT max_daily_budget_cents FROM ads_settings WHERE location_id = ?', locationId);
  return row?.max_daily_budget_cents ?? DEFAULT_MAX_DAILY_CENTS;
}

// --- who is asking ---------------------------------------------------------------------------------------

/** A person clicking in the web app or the native app. API keys, MCP clients, the agent and workflows are not. */
export const isHuman = (ctx: Ctx | undefined) => !!ctx && (ctx.via === 'session' || ctx.via === 'app');

// --- log ---------------------------------------------------------------------------------------------------

export function audit(app: App, ctx: Ctx | undefined, action: string, summary: string, o: { locationId?: string | null; entityId?: string | null; actor?: string; userId?: string | null }) {
  writeAudit(app, { ctx, action, summary, locationId: o.locationId, entityId: o.entityId ?? null, actor: o.actor, userId: o.userId });
}

/** Timeline of one campaign (status changes, budget changes, rules, errors). */
export function activity(app: App, locationId: string, o: { campaignId?: string | null; platform?: Platform; remoteId?: string | null; kind: string; summary: string; actor?: string; via?: string }) {
  app.db.insert('ads_activity', {
    id: id(),
    location_id: locationId,
    campaign_id: o.campaignId ?? null,
    platform: o.platform ?? null,
    remote_id: o.remoteId ?? null,
    kind: o.kind,
    summary: o.summary.slice(0, 500),
    actor: (o.actor ?? '').slice(0, 200),
    via: o.via ?? '',
    created_at: now(),
  });
}

/** Platform errors surface as 502 with the platform's own readable message. */
export function relay<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof HttpError) throw e;
    if (e instanceof AdsError) throw new HttpError(502, e.message);
    if (e && typeof e === 'object' && 'status' in e && e instanceof Error) throw new HttpError(502, e.message);
    throw e;
  });
}

export const cents = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Smallest currency unit per whole unit: Meta takes budgets in minor units (EUR cents; JPY, KRW … whole units). */
export const currencyDivisor = (cur: string) => (['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'UGX'].includes(String(cur).toUpperCase()) ? 1 : 100);
