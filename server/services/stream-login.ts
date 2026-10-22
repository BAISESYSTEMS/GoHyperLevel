import { SESSION_COOKIE, type App } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { sha256 } from '../core/util.js';

/**
 * Live streams (Server-Sent Events) end with the login they were opened with. A stream outlives the request that
 * opened it, so the hubs (Team-Chat, Team-Posteingang, Canvas, Living Boards, presence) check on every round that the
 * browser session – or the app's device token – behind it still exists and has not run out:
 *
 *   const alive = loginOf(app, ctx);              // when the stream is opened
 *   hub.subscribe({ …, alive });
 *   if (s.alive?.() === false) → end with `bye`   // in the hub's sweep (every 20 s)
 *   sweepOnLoginChange(app, hub);                 // and at once after signing out, revoking, a new password …
 *
 * A stream opened with a key is bound to that key the same way: a sub-account or agency API key that is deleted, an MCP
 * connection (OAuth) that is disconnected or whose access token ran out ends it. Public streams have no login at all.
 */

/** Is the login behind a stream still valid (not signed out, revoked or expired)? */
export type LoginCheck = () => boolean;

const bearerOf = (ctx: Ctx) => String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1] ?? '';

/**
 * The check for a key: a sub-account key (pghl_), an agency key (pghla_) or an MCP connection's access token – also when the
 * MCP endpoint relays a request made with one of them.
 */
function keyAlive(app: App, bearer: string): LoginCheck {
  const hash = bearer ? sha256(bearer) : '';
  const sql = bearer.startsWith('pghla_')
    ? 'SELECT 1 AS x FROM agency_api_keys WHERE key_hash = ?'
    : bearer.startsWith('pghl_')
      ? 'SELECT 1 AS x FROM api_keys WHERE key_hash = ?'
      : `SELECT 1 AS x FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at IS NULL`;
  return () => {
    try {
      return !!hash && !!app.db.get(sql, hash, ...(sql.includes('expires_at') ? [new Date().toISOString()] : []));
    } catch {
      return false;
    }
  };
}

/** The check for the login of this request – a browser session, the app's device token or a key; undefined without one. */
export function loginOf(app: App, ctx: Ctx): LoginCheck | undefined {
  if (ctx.via === 'api_key' || ctx.via === 'agency_key' || ctx.via === 'mcp') return keyAlive(app, bearerOf(ctx));
  if (ctx.via === 'session') {
    const hash = sha256(ctx.cookies[SESSION_COOKIE] ?? '');
    return () => {
      try {
        return !!app.db.get('SELECT 1 AS x FROM sessions WHERE token_hash = ? AND expires_at > ?', hash, new Date().toISOString());
      } catch {
        return false;
      }
    };
  }
  if (ctx.via === 'app') {
    const bearer = bearerOf(ctx);
    const hash = bearer ? sha256(bearer) : '';
    return () => {
      try {
        return !!hash && !!app.db.get('SELECT 1 AS x FROM mobile_devices WHERE token_hash = ?', hash);
      } catch {
        return false;
      }
    };
  }
  return undefined;
}

/**
 * Requests after which open streams are checked at once instead of at the next round: signed out, a session or device
 * revoked, a new password (own or set by the admin), a person changed or removed, a sub-account deleted, an API key
 * deleted or an MCP connection disconnected (Einstellungen → API, KI-Werkzeuge).
 */
export const LOGINS_CHANGED =
  /^(POST \/api\/auth\/logout|POST \/api\/me\/password|DELETE \/api\/me\/sessions\/:id|POST \/api\/me\/sessions\/revoke-others|POST \/api\/users\/:id\/sessions\/revoke|(PATCH|DELETE) \/api\/users\/:id|DELETE \/api\/locations\/:id|DELETE \/api\/mobile\/devices\/:id|POST \/api\/mobile\/logout|DELETE \/api\/(agency\/)?api-keys\/:id|DELETE \/api\/(agency\/)?ai-tools\/(keys|apps)\/:id)$/;

/**
 * Sweeps a hub right after those requests. Deferred until every afterWrite hook has run (another module's hook may still
 * revoke something, e.g. the app's devices after a new password) – still before the next request is read.
 */
export function sweepOnLoginChange(app: App, hub: { streams(): number; sweep(): void }) {
  app.afterWrite.push((_ctx, route) => {
    if (LOGINS_CHANGED.test(`${route.method} ${route.pattern}`)) queueMicrotask(() => hub.streams() && hub.sweep());
  });
}

/** Why the server ends a stream for good. */
export type ByeReason = 'signed_out' | 'tabs';

/** The last event of a stream the server ends for good: the browser must not reconnect on its own (no reconnect loop). */
export const byeEvent = (reason: ByeReason) => `event: bye\ndata: ${JSON.stringify({ reason })}\n\n`;
