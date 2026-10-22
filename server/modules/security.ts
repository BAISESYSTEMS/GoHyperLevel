import type { App, Module } from '../core/app.js';
import { SESSION_COOKIE } from '../core/app.js';
import { HttpError, notFound, type Ctx, clampLimit } from '../core/http.js';
import { id, now, sha256 } from '../core/util.js';

/**
 * Security: an audit log of every write (who, how – session, API key, agency key, MCP – from where,
 * on which sub-account) plus the list of signed-in devices with sign-out.
 */

interface AuditInput {
  ctx?: Ctx;
  action: string;
  summary?: string;
  userId?: string | null;
  actor?: string;
  locationId?: string | null;
  entityId?: string | null;
  route?: string;
}

export function writeAudit(app: App, a: AuditInput) {
  const ctx = a.ctx;
  app.db.insert('audit_log', {
    id: id(),
    at: now(),
    user_id: a.userId ?? ctx?.user?.id ?? null,
    actor: (a.actor ?? ctx?.user?.name ?? (ctx?.viaApiKey ? 'API-Schlüssel' : '')).slice(0, 200),
    via: ctx?.via ?? (ctx ? 'public' : 'system'),
    ip: ctx?.ip ?? '',
    action: a.action.slice(0, 120),
    route: (a.route ?? '').slice(0, 200),
    location_id: a.locationId ?? (ctx?.locationId || null),
    entity_id: a.entityId ?? null,
    summary: (a.summary ?? '').slice(0, 500),
  });
}

/** "POST /api/contacts/:id/notes" → "contacts.notes.create" */
export function actionOf(method: string, pattern: string): string {
  const verb = method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update';
  const parts = pattern
    .replace(/^\/api\//, '')
    .split('/')
    .filter((p) => p && !p.startsWith(':'));
  return [...parts, verb].join('.');
}

export const securityModule: Module = {
  name: 'security',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, user_id TEXT, actor TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, route TEXT NOT NULL DEFAULT '', location_id TEXT, entity_id TEXT,
        summary TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX audit_at ON audit_log(at);
      CREATE INDEX audit_loc ON audit_log(location_id, at);
      ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
      ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.audit = (a: AuditInput) => writeAudit(app, a);
    app.services.onSessionStart = (hash: string, ctx: Ctx) => {
      db.run('UPDATE sessions SET ip = ?, user_agent = ? WHERE token_hash = ?', ctx.ip, String(ctx.req.headers['user-agent'] ?? '').slice(0, 300), hash);
    };

    app.afterWrite.push((ctx, route, result) => {
      // Marking a conversation as read is not worth a log line.
      if (route.pattern === '/api/conversations/:id' && ctx.method === 'PATCH') return;
      const r = result as any;
      writeAudit(app, {
        ctx,
        action: actionOf(ctx.method, route.pattern),
        route: `${ctx.method} ${route.pattern}`,
        entityId: ctx.params.id ?? (r && typeof r === 'object' && typeof r.id === 'string' ? r.id : null),
        summary: r && typeof r === 'object' ? String(r.name ?? r.title ?? r.subject ?? r.email ?? '').slice(0, 200) : '',
      });
    });
    // Data leaving the system is a security event too: exports, downloads, backups, privacy exports.
    const EXPORT = /(export|\.csv$|\.xml$|backups?(\/|$)|download|privacy-export|\/feed$)/;
    app.afterRead.push((ctx, route) => {
      if (!EXPORT.test(route.pattern)) return;
      writeAudit(app, { ctx, action: `export:${route.pattern.replace(/^\/api\//, '')}`, route: `GET ${route.pattern}`, entityId: ctx.params.id ?? ctx.params.name ?? null, summary: ctx.url.search.slice(0, 200) });
    });
    // Changes to people and their rights get a readable summary (which fields changed).
    app.afterWrite.push((ctx, route) => {
      if (route.pattern !== '/api/users/:id' || ctx.method !== 'PATCH') return;
      const fields = ['role', 'locations', 'permissions', 'password', 'name'].filter((k) => ctx.body?.[k] !== undefined);
      if (fields.length) writeAudit(app, { ctx, action: 'users.rights.update', route: `PATCH ${route.pattern}`, entityId: ctx.params.id, summary: `geändert: ${fields.join(', ')}${ctx.body?.role ? ` (Rolle: ${String(ctx.body.role).slice(0, 20)})` : ''}` });
    });
    // Old entries go after a year.
    let lastPrune = 0;
    app.onTick(() => {
      if (Date.now() - lastPrune < 864e5) return;
      lastPrune = Date.now();
      db.run('DELETE FROM audit_log WHERE at < ?', new Date(Date.now() - 365 * 864e5).toISOString());
      db.run('DELETE FROM sessions WHERE expires_at < ?', now());
    });

    const list = (where: string[], params: any[], ctx: Ctx) => {
      const before = ctx.query.get('before');
      if (before) {
        where.push('at < ?');
        params.push(before);
      }
      const q = ctx.query.get('q');
      if (q) {
        where.push(`(action || ' ' || actor || ' ' || summary || ' ' || route) LIKE ?`);
        params.push(`%${q}%`);
      }
      return db.all(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`, ...params, clampLimit(ctx.query.get('limit'), 100, 500));
    };
    router.get('/api/admin/audit', 'admin', (ctx) => {
      const where: string[] = [];
      const params: any[] = [];
      // Cloud mode: the log of a customer's sub-account (what was changed, with names) is theirs unless they opened the account for support.
      const hidden = app.services.hiddenLocations?.(ctx.user) as Set<string> | undefined;
      if (hidden?.size) {
        where.push('(location_id IS NULL OR location_id NOT IN (SELECT value FROM json_each(?)))');
        params.push(JSON.stringify([...hidden]));
      }
      const loc = ctx.query.get('location_id');
      if (loc) {
        where.push('location_id = ?');
        params.push(loc);
      }
      const via = ctx.query.get('via');
      if (via) {
        where.push('via = ?');
        params.push(via);
      }
      return list(where, params, ctx).map((r) => ({ ...r, location: r.location_id ? app.location(r.location_id)?.name : null }));
    });
    router.get('/api/audit', 'location', (ctx) => list(['location_id = ?'], [ctx.locationId], ctx));

    // --- signed-in devices ------------------------------------------------------------
    const handle = (hash: string) => hash.slice(0, 16);
    router.get('/api/me/sessions', 'user', (ctx) => {
      if (ctx.via !== 'session') throw new HttpError(403, 'Nur mit Anmeldung');
      const cur = sha256(ctx.cookies[SESSION_COOKIE] ?? '');
      return db
        .all('SELECT token_hash, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', ctx.user!.id, now())
        .map((s) => ({ id: handle(s.token_hash), created_at: s.created_at, expires_at: s.expires_at, ip: s.ip, user_agent: s.user_agent, current: s.token_hash === cur }));
    });
    router.delete('/api/me/sessions/:id', 'user', (ctx) => {
      if (ctx.via !== 'session') throw new HttpError(403, 'Nur mit Anmeldung');
      const row = db.all('SELECT token_hash FROM sessions WHERE user_id = ?', ctx.user!.id).find((s) => handle(s.token_hash) === ctx.params.id);
      if (!row) throw notFound();
      db.run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
      return { ok: true };
    });
    router.post('/api/me/sessions/revoke-others', 'user', (ctx) => {
      if (ctx.via !== 'session') throw new HttpError(403, 'Nur mit Anmeldung');
      const cur = sha256(ctx.cookies[SESSION_COOKIE] ?? '');
      const n = db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', ctx.user!.id, cur).changes;
      return { ok: true, revoked: n };
    });
    router.post('/api/users/:id/sessions/revoke', 'admin', (ctx) => {
      if (!db.get('SELECT id FROM users WHERE id = ?', ctx.params.id)) throw notFound();
      return { ok: true, revoked: db.run('DELETE FROM sessions WHERE user_id = ?', ctx.params.id).changes };
    });
  },
};
