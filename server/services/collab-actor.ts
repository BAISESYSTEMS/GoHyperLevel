import type { App } from '../core/app.js';
import type { Ctx, User } from '../core/http.js';
import { sha256 } from '../core/util.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Who is acting, for Wiki and Team-Chat: a person, the HyperLevel Agent on behalf of a person, an AI app
 * connected through OAuth, or an API key / MCP connection of the sub-account (a "bot": it has no
 * identity of its own, so it never gets into private channels and signs with the key's name).
 */

export interface Actor {
  id: string | null;
  name: string;
  kind: 'user' | 'agent' | 'bot';
}

export function actorOf(app: App, ctx: Ctx): Actor {
  const via = String(ctx.via ?? '');
  if (ctx.viaApiKey || !ctx.user) {
    if (ctx.user) return { id: null, name: ctx.user.name.slice(0, 200), kind: 'bot' };
    const bearer = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
    const key = bearer ? app.db.get<{ name: string }>('SELECT name FROM api_keys WHERE key_hash = ?', sha256(bearer)) : undefined;
    return { id: null, name: key ? `API: ${key.name}`.slice(0, 200) : 'KI-App', kind: 'bot' };
  }
  if (via === 'agent') return { id: ctx.user.id, name: ctx.user.name.slice(0, 200), kind: 'agent' };
  if (via === 'mcp') return { id: ctx.user.id, name: `${ctx.user.name} (KI-App)`.slice(0, 200), kind: 'agent' };
  return { id: ctx.user.id, name: ctx.user.name.slice(0, 200), kind: 'user' };
}

/** True for keys and MCP connections without a person behind them. */
export const isBot = (ctx: Ctx) => !ctx.user || !!ctx.viaApiKey;

export interface TeamUser extends User {
  avatar?: string;
}

export const userFromRow = (r: any): TeamUser => ({ id: r.id, email: r.email, name: r.name, role: r.role, locations: JSON.parse(r.locations || '[]'), permissions: r.permissions ? JSON.parse(r.permissions) : null });

/** People who can use `area` in a sub-account: agency admins and members of it with the right. */
export function teamUsers(app: App, locationId: string | null, area: string): TeamUser[] {
  return app.db
    .all('SELECT id, name, email, role, locations, permissions FROM users ORDER BY name')
    .map(userFromRow)
    .filter((u) => u.role === 'admin' || (locationId !== null && u.locations.includes(locationId)))
    .filter((u) => locationId === null || !hiddenUser(app, u, locationId))
    .filter((u) => u.role === 'admin' || !u.permissions || u.permissions.includes(area));
}

/** A copy of the request as another user (to ask "may this person see it?"). */
export const asUser = (ctx: Ctx, u: User): Ctx => ({ ...ctx, user: u, viaApiKey: false, via: 'session', scope: undefined });

export const userById = (app: App, id: string): TeamUser | undefined => {
  const r = app.db.get('SELECT id, name, email, role, locations, permissions FROM users WHERE id = ?', id);
  return r ? userFromRow(r) : undefined;
};

/** Fire-and-forget work (notifications) is tracked, so tests and a clean shutdown can wait for it (`app.services.collabIdle`). */
export function track(app: App, p: Promise<unknown>) {
  const set: Set<Promise<unknown>> = (app.services.collabPending ??= new Set());
  const q = p.catch((e) => console.error('[collab]', (e as Error).message)).finally(() => set.delete(q));
  set.add(q);
}
