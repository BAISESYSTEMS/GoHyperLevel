import type { App } from '../../core/app.js';
import { openIfSealed, sealSecret } from '../../core/secrets.js';
import { now } from '../../core/util.js';
import { CogneeClient, LocationClient, type CogneeFetch } from './client.js';

/**
 * Where the Cognee server and its login are kept. The agency enters the address and ONE login (e-mail + password, or an
 * API key) for HyperLevel's own Cognee user; a sub-account may get a login of its own (override), so Cognee itself keeps
 * its data apart from the others. Secrets are sealed at rest (core/secrets.ts) and never leave the server.
 */

export type AuthMode = 'password' | 'api_key';

export interface Posture {
  /** closed = the server wants a login (access control expected), open = it answers without one, unknown = could not tell. */
  state: 'closed' | 'open' | 'unknown';
  reason: string;
  at: string;
}

export interface AgencyConn {
  base_url: string;
  auth_mode: AuthMode;
  email: string;
  /** Opened password or API key – never put into a response. */
  secret: string;
  hint: string;
  /** The server is in the internal network (docker, LAN): lets the connection reach private addresses. */
  allow_private: boolean;
  /** Keep sharing although the server answers without a login (not recommended). */
  allow_open_server: boolean;
  /** Sub-account admins may switch their sub-account on (otherwise only the agency). */
  locations_may_enable: boolean;
  posture?: Posture;
  last_test?: { at: string; ok: boolean; summary: string; version?: string };
  updated_at: string;
}

const KEY = 'cognee';

export function readConn(app: App): AgencyConn | null {
  const row = app.db.get<{ value: string }>('SELECT value FROM agency_settings WHERE key = ?', KEY);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value);
    if (!v?.base_url) return null;
    return {
      base_url: String(v.base_url),
      auth_mode: v.auth_mode === 'api_key' ? 'api_key' : 'password',
      email: String(v.email ?? ''),
      secret: openIfSealed(app, v.secret_sealed),
      hint: String(v.hint ?? ''),
      allow_private: !!v.allow_private,
      allow_open_server: !!v.allow_open_server,
      locations_may_enable: v.locations_may_enable !== false,
      posture: v.posture,
      last_test: v.last_test,
      updated_at: String(v.updated_at ?? ''),
    };
  } catch {
    return null;
  }
}

export function writeConn(app: App, c: AgencyConn) {
  const { secret, ...rest } = c;
  const value = JSON.stringify({ ...rest, secret_sealed: secret ? sealSecret(app, secret) : '', updated_at: now() });
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, value);
}

export const clearConn = (app: App) => app.db.run('DELETE FROM agency_settings WHERE key = ?', KEY);

/** What the browser may see of the connection: everything but the secret. */
export function connOut(c: AgencyConn | null) {
  if (!c) return { configured: false };
  return {
    configured: true,
    base_url: c.base_url,
    auth_mode: c.auth_mode,
    email: c.email,
    secret_set: !!c.secret,
    hint: c.hint,
    allow_private: c.allow_private,
    allow_open_server: c.allow_open_server,
    locations_may_enable: c.locations_may_enable,
    posture: c.posture ?? null,
    last_test: c.last_test ?? null,
    updated_at: c.updated_at,
  };
}

export const secretHint = (s: string) => (s.length > 4 ? `…${s.slice(-4)}` : '…');

// --- per-sub-account login ----------------------------------------------------------------------------------------------

export interface Override {
  location_id: string;
  auth_mode: AuthMode;
  email: string;
  secret: string;
  hint: string;
}

export function readOverride(app: App, locationId: string): Override | null {
  const r = app.db.get<any>('SELECT * FROM cognee_accounts WHERE location_id = ?', locationId);
  return r ? { location_id: r.location_id, auth_mode: r.auth_mode === 'api_key' ? 'api_key' : 'password', email: r.email, secret: openIfSealed(app, r.secret_sealed), hint: r.hint } : null;
}

export function writeOverride(app: App, o: Override) {
  const at = now();
  app.db.run(
    `INSERT INTO cognee_accounts (location_id, auth_mode, email, secret_sealed, hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id) DO UPDATE SET auth_mode = excluded.auth_mode, email = excluded.email, secret_sealed = excluded.secret_sealed, hint = excluded.hint, updated_at = excluded.updated_at`,
    o.location_id,
    o.auth_mode,
    o.email,
    sealSecret(app, o.secret),
    o.hint,
    at,
    at,
  );
}

// --- clients -----------------------------------------------------------------------------------------------------------

/** Test hooks (app.services.cogneeFetch/cogneeSleep/cogneeNow/cogneeGapMs): fake server, no waiting, a movable clock. */
export function clientOptions(app: App, c: Pick<AgencyConn, 'base_url' | 'allow_private'> & { auth_mode: AuthMode; email: string; secret: string }) {
  return {
    baseUrl: c.base_url,
    allowPrivate: c.allow_private,
    mode: c.auth_mode,
    email: c.email,
    secret: c.secret,
    fetch: app.services.cogneeFetch as CogneeFetch | undefined,
    sleep: app.services.cogneeSleep as ((ms: number) => Promise<void>) | undefined,
    now: app.services.cogneeNow as (() => number) | undefined,
    minGapMs: app.services.cogneeGapMs as number | undefined,
  };
}

export interface Account {
  client: LocationClient;
  source: 'agency' | 'override';
  conn: AgencyConn;
}

/** The client for one sub-account: its own login when it has one, the agency's otherwise. Null: no server set up. */
export function accountFor(app: App, locationId: string): Account | null {
  const conn = readConn(app);
  if (!conn || !conn.secret || (conn.auth_mode === 'password' && !conn.email)) return null;
  const o = readOverride(app, locationId);
  const login = o && o.secret ? { auth_mode: o.auth_mode, email: o.email, secret: o.secret } : { auth_mode: conn.auth_mode, email: conn.email, secret: conn.secret };
  return { client: new LocationClient(locationId, new CogneeClient(clientOptions(app, { ...conn, ...login }))), source: o?.secret ? 'override' : 'agency', conn };
}
