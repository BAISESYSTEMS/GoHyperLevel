import { createHmac } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { safeFetch } from '../services/net.js';
import { join } from 'node:path';
import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { contentMatches, extFor } from '../core/files.js';
import { HttpError, bad, notFound, str, text, type Ctx } from '../core/http.js';
import { cleanPermissions, visibleLocations } from '../core/permissions.js';
import { isValidTz } from '../core/time.js';
import { hashPassword, hashPasswordAsync, id, needsRehash, now, sha256, token, verifyPasswordAsync } from '../core/util.js';
import { openIfSealed, sealSecret, sealSettings } from '../core/secrets.js';
import { snapshotInto } from './backups.js';
import { eraseLocations } from '../services/cloud-export.js';
import { forgetUser } from '../services/user-erase.js';

const SESSION_DAYS = 30;
const loginAttempts = new Map<string, { n: number; until: number }>();

/** Settings fields whose values are secrets: never sent back to the browser. */
const SECRET_KEYS = ['pass', 'password', 'authToken', 'apiKey', 'secret', 'token', 'inbound_key'];

export function maskSettings(s: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(s ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = maskSettings(v);
    else out[k] = SECRET_KEYS.includes(k) && v ? '••••••' : v;
  }
  return out;
}

/** Deep-merges a settings patch, keeping stored secrets the browser only saw masked. */
export function mergeSettings(cur: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...(cur ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergeSettings(cur?.[k] ?? {}, v);
    else if (v === '••••••') continue;
    else out[k] = v;
  }
  return out;
}

function userOut(u: any) {
  const perms = typeof u.permissions === 'string' ? JSON.parse(u.permissions) : (u.permissions ?? null);
  return { id: u.id, email: u.email, name: u.name, role: u.role, locations: JSON.parse(u.locations || '[]'), permissions: perms, created_at: u.created_at, totp_enabled: !!u.totp_enabled };
}

/** New passwords: 8 to 1024 characters (scrypt input stays bounded). */
function checkPassword(v: unknown, field: string): string {
  const pw = str(v, field, { required: true });
  if (pw.length < 8) throw bad('Passwort braucht mindestens 8 Zeichen');
  if (pw.length > 1024) throw bad('Passwort ist zu lang');
  return pw;
}

/** Signs the browser in; returns the session's token hash. Lifetime: login policy (app.services.sessionDays) or 30 days. */
export function startSession(ctx: Ctx, app: App, userId: string): string {
  // A session id the browser brought along (planted by someone else, or the previous user's) never survives a login.
  const old = ctx.cookies[SESSION_COOKIE];
  if (old) app.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(old));
  const t = token(32);
  const days = Math.min(365, Math.max(1, Number(app.services.sessionDays?.(userId)) || SESSION_DAYS));
  const expires = new Date(Date.now() + days * 864e5).toISOString();
  app.db.insert('sessions', { token_hash: sha256(t), user_id: userId, created_at: now(), expires_at: expires });
  // Device info for "signed-in devices" (security module).
  app.services.onSessionStart?.(sha256(t), ctx, userId);
  ctx.setCookie(SESSION_COOKIE, t, { maxAge: days * 86400 });
  return sha256(t);
}

/** Failed logins per account (on top of per-IP), so a botnet can't guess one password slowly. */
const accountFails = new Map<string, number[]>();
function accountLocked(email: string): boolean {
  const t = Date.now();
  const list = (accountFails.get(email) ?? []).filter((x) => t - x < 15 * 60_000);
  if (accountFails.size > 100_000) accountFails.clear();
  accountFails.set(email, list);
  return list.length >= 10;
}

export function createLocation(db: any, name: string, timezone = 'Europe/Berlin', extra: Record<string, any> = {}) {
  const loc = {
    id: id(),
    name,
    timezone,
    email: extra.email ?? '',
    phone: extra.phone ?? '',
    address: extra.address ?? '',
    website: extra.website ?? '',
    settings: extra.settings ?? { email: { provider: 'log' }, sms: { provider: 'log' } },
    created_at: now(),
  };
  db.insert('locations', loc);
  // Every sub-account starts with the pipeline GHL gives new accounts.
  db.insert('pipelines', {
    id: id(),
    location_id: loc.id,
    name: 'Vertrieb',
    stages: ['Neuer Lead', 'Kontaktiert', 'Termin gebucht', 'Angebot', 'Gewonnen'].map((n) => ({ id: id(8), name: n })),
    created_at: now(),
  });
  return loc;
}

export const coreModule: Module = {
  name: 'core',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE locations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
        email TEXT, phone TEXT, address TEXT, website TEXT, logo_url TEXT,
        settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member', locations TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
        created_at TEXT NOT NULL, last_used_at TEXT
      );
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, last_status TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE uploads (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      `,
    ],
    ['002-user-permissions', `ALTER TABLE users ADD COLUMN permissions TEXT;`],
  ],
  register(app) {
    const { db, router } = app;
    const uploadDir = join(app.config.dataDir, 'uploads');

    // --- auth ---------------------------------------------------------------
    router.get('/api/auth/status', 'public', () => ({
      needsSetup: !db.get('SELECT id FROM users LIMIT 1'),
    }));

    router.post('/api/auth/setup', 'public', (ctx) => {
      if (db.get('SELECT id FROM users LIMIT 1')) throw new HttpError(409, 'Schon eingerichtet');
      const email = str(ctx.body.email, 'E-Mail', { required: true }).toLowerCase();
      const password = checkPassword(ctx.body.password, 'Passwort');
      const user = { id: id(), email, name: str(ctx.body.name, 'Name') || email, password_hash: hashPassword(password), role: 'admin', locations: [], created_at: now() };
      db.insert('users', user);
      createLocation(db, str(ctx.body.locationName, 'Firma') || 'Meine Firma', str(ctx.body.timezone, 'Zeitzone') || 'Europe/Berlin');
      startSession(ctx, app, user.id);
      return { user: userOut({ ...user, locations: '[]' }) };
    });

    router.post('/api/auth/login', 'public', async (ctx) => {
      const key = ctx.ip;
      const att = loginAttempts.get(key);
      if (att && att.until > Date.now()) throw new HttpError(429, 'Zu viele Versuche, bitte kurz warten');
      const email = str(ctx.body.email, 'E-Mail', { required: true, max: 320 }).toLowerCase();
      // Login policy (login-policy module): password sign-in off here, or SSO enforced for the domain.
      const refused = app.services.passwordRefused?.(ctx, email);
      if (refused) throw new HttpError(403, refused);
      if (accountLocked(email)) {
        app.services.audit?.({ ctx, action: 'login.locked', summary: email });
        throw new HttpError(429, 'Zu viele Fehlversuche für dieses Konto – bitte in 15 Minuten wieder');
      }
      const failed = (what: string, userId?: string) => {
        const n = (att?.n ?? 0) + 1;
        loginAttempts.set(key, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
        if (loginAttempts.size > 50_000) loginAttempts.clear();
        accountFails.get(email)!.push(Date.now());
        app.services.audit?.({ ctx, action: what, summary: email, userId });
      };
      const u = db.get('SELECT * FROM users WHERE email = ?', email);
      // Unknown e-mails cost the same scrypt run, so response times don't reveal which accounts exist.
      const password = String(ctx.body.password ?? '').slice(0, 1024);
      if (!(await verifyPasswordAsync(password, u?.password_hash)) || !u) {
        failed('login.failed', u?.id);
        throw new HttpError(401, 'E-Mail oder Passwort falsch');
      }
      // Optional second factor (twofactor module): ask for the code before starting a session.
      const second = app.services.secondFactor?.(u, ctx.body.code, ctx) ?? 'ok';
      // Which second factors the user has (code, passkey) – passkeys module adds a WebAuthn challenge.
      if (second === 'needed') return { needs_code: true, ...(app.services.secondFactorOptions?.(u, ctx) ?? {}) };
      if (second === 'invalid') {
        // Wrong codes count against the account too: guessing 6 digits from many IPs must not work.
        failed('login.2fa_failed', u.id);
        throw new HttpError(401, 'Code falsch');
      }
      loginAttempts.delete(key);
      accountFails.delete(email);
      if (needsRehash(u.password_hash)) db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPasswordAsync(password), u.id);
      startSession(ctx, app, u.id);
      app.services.audit?.({ ctx, action: 'login', summary: u.email, userId: u.id, actor: u.name });
      return { user: userOut(u) };
    });

    router.post('/api/auth/logout', 'user', (ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      if (sid) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(sid));
      ctx.setCookie(SESSION_COOKIE, '', { maxAge: 0 });
      return { ok: true };
    });

    router.get('/api/me', 'user', (ctx) => {
      const u = ctx.user!;
      const locs =
        u.role === 'admin'
          ? db.all('SELECT id, name, timezone FROM locations ORDER BY name')
          : db.all(`SELECT id, name, timezone FROM locations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name`, JSON.stringify(u.locations));
      // Modules add fields of their own to the user (app.services.meFields, e.g. the UI language of modules/language.ts).
      const extra = ((app.services.meFields ?? []) as ((user: typeof u) => Record<string, unknown>)[]).reduce((o, fn) => ({ ...o, ...fn(u) }), {});
      return { user: { ...extra, ...u }, locations: visibleLocations(app, u, locs) };
    });

    router.post('/api/me/password', 'user', async (ctx) => {
      const u = db.get('SELECT * FROM users WHERE id = ?', ctx.user!.id)!;
      // A stolen session must not be able to guess the current password at full speed.
      if (accountLocked(`pw:${u.id}`)) throw new HttpError(429, 'Zu viele Fehlversuche – bitte in 15 Minuten wieder');
      if (!(await verifyPasswordAsync(String(ctx.body.current ?? '').slice(0, 1024), u.password_hash))) {
        accountFails.get(`pw:${u.id}`)!.push(Date.now());
        throw bad('Aktuelles Passwort falsch');
      }
      const next = checkPassword(ctx.body.next, 'Neues Passwort');
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPasswordAsync(next), u.id);
      app.services.audit?.({ ctx, action: 'me.password.change', summary: u.email });
      // Other devices must sign in again with the new password.
      const sid = ctx.cookies[SESSION_COOKIE];
      db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', u.id, sid ? sha256(sid) : '');
      return { ok: true };
    });

    // --- users (agency level) ----------------------------------------------
    router.get('/api/users', 'admin', () => db.all('SELECT * FROM users ORDER BY created_at').map(userOut));
    router.post('/api/users', 'admin', async (ctx) => {
      const email = str(ctx.body.email, 'E-Mail', { required: true }).toLowerCase();
      if (db.get('SELECT id FROM users WHERE email = ?', email)) throw bad('E-Mail schon vergeben');
      const password = checkPassword(ctx.body.password, 'Passwort');
      const u = {
        id: id(),
        email,
        name: str(ctx.body.name, 'Name') || email,
        password_hash: await hashPasswordAsync(password),
        role: ctx.body.role === 'admin' ? 'admin' : 'member',
        locations: Array.isArray(ctx.body.locations) ? ctx.body.locations.map(String) : [],
        permissions: cleanPermissions(ctx.body.permissions),
        created_at: now(),
      };
      db.insert('users', u);
      return userOut({ ...u, locations: JSON.stringify(u.locations) });
    });
    router.patch('/api/users/:id', 'admin', async (ctx) => {
      const patch: Record<string, any> = {};
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name');
      if (ctx.body.role !== undefined) patch.role = ctx.body.role === 'admin' ? 'admin' : 'member';
      if (Array.isArray(ctx.body.locations)) patch.locations = ctx.body.locations.map(String);
      // null (or omitted list) = access to every area.
      if (ctx.body.permissions !== undefined) patch.permissions = cleanPermissions(ctx.body.permissions);
      if (ctx.body.password) patch.password_hash = await hashPasswordAsync(checkPassword(ctx.body.password, 'Passwort'));
      if (ctx.params.id === ctx.user!.id && patch.role === 'member') throw bad('Du kannst dir die Admin-Rolle nicht selbst nehmen');
      if (patch.permissions === null) {
        db.run('UPDATE users SET permissions = NULL WHERE id = ?', ctx.params.id);
        delete patch.permissions;
      }
      if (!db.update('users', ctx.params.id, patch)) throw notFound();
      // A password set by the admin (lost or leaked password) signs the person out everywhere else.
      if (patch.password_hash) {
        const sid = ctx.cookies[SESSION_COOKIE];
        db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', ctx.params.id, sid ? sha256(sid) : '');
      }
      return userOut(db.get('SELECT * FROM users WHERE id = ?', ctx.params.id));
    });
    router.delete('/api/users/:id', 'admin', (ctx) => {
      if (ctx.params.id === ctx.user!.id) throw bad('Du kannst dich nicht selbst löschen');
      // The login and what is private to it (AI chats, own credentials, private views …); the team's records keep the name.
      db.tx(() => {
        if (db.run('DELETE FROM users WHERE id = ?', ctx.params.id).changes) forgetUser(app, ctx.params.id);
      });
      return { ok: true };
    });

    // --- locations (sub-accounts) -------------------------------------------
    router.get('/api/locations', 'admin', (ctx) => visibleLocations(app, ctx.user, parseRows(db.all('SELECT * FROM locations ORDER BY name'), ['settings'])).map((l) => ({ ...l, settings: maskSettings(l.settings) })));
    router.post('/api/locations', 'admin', (ctx) => {
      const tz = str(ctx.body.timezone, 'Zeitzone') || 'Europe/Berlin';
      if (!isValidTz(tz)) throw bad('Unbekannte Zeitzone');
      return createLocation(db, str(ctx.body.name, 'Name', { required: true, max: 120 }), tz, ctx.body);
    });
    router.delete('/api/locations/:id', 'admin', (ctx) => {
      if (db.get<{ n: number }>('SELECT COUNT(*) n FROM locations')!.n <= 1) throw bad('Der letzte Sub-Account kann nicht gelöscht werden');
      if (!/^[A-Za-z0-9_-]+$/.test(ctx.params.id)) throw notFound();
      // Everything of the sub-account goes – also rows without a foreign key (web hook payloads, tracked links …) and the people's
      // files (form uploads, HR documents, certificates, imports, recordings …). The media library stays (pages of other
      // sub-accounts may show its pictures), and so does the audit log (the agency's own record).
      return { ok: true, ...eraseLocations(app, [ctx.params.id], { keep: ['uploads', 'audit_log', 'docs'] }) };
    });

    /** The current sub-account's profile and settings (providers, branding, review link). */
    router.get('/api/location', 'location', (ctx) => {
      const l = app.location(ctx.locationId)!;
      return { ...l, settings: maskSettings(l.settings) };
    });
    router.patch('/api/location', 'location', (ctx) => {
      const cur = app.location(ctx.locationId)!;
      const patch: Record<string, any> = {};
      for (const k of ['name', 'email', 'phone', 'address', 'website', 'logo_url']) if (ctx.body[k] !== undefined) patch[k] = str(ctx.body[k], k, { max: 500 });
      if (ctx.body.timezone !== undefined) {
        if (!isValidTz(ctx.body.timezone)) throw bad('Unbekannte Zeitzone');
        patch.timezone = ctx.body.timezone;
      }
      if (ctx.body.settings) {
        // The client's branding (incl. its login domain) is set by the agency only.
        const { branding: _b, ...rest } = ctx.body.settings;
        patch.settings = sealSettings(app, mergeSettings(cur.settings, rest)).value;
      }
      db.update('locations', ctx.locationId, patch);
      const l = app.location(ctx.locationId)!;
      return { ...l, settings: maskSettings(l.settings) };
    });

    // --- API keys -----------------------------------------------------------
    router.get('/api/api-keys', 'location', (ctx) =>
      db.all('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId),
    );
    router.post('/api/api-keys', 'location', (ctx) => {
      if (ctx.viaApiKey) throw new HttpError(403, 'API-Schlüssel können keine Schlüssel anlegen');
      const key = `pghl_${token(24)}`;
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body.name, 'Name') || 'API', key_hash: sha256(key), prefix: key.slice(0, 10), created_at: now() };
      db.insert('api_keys', row);
      return { id: row.id, name: row.name, key };
    });
    router.delete('/api/api-keys/:id', 'location', (ctx) => {
      db.run('DELETE FROM api_keys WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- outbound webhooks --------------------------------------------------
    // Signing secrets are stored sealed; the owner sees them to verify deliveries.
    router.get('/api/webhooks', 'location', (ctx) => parseRows(db.all('SELECT * FROM webhooks WHERE location_id = ?', ctx.locationId), ['events']).map((h) => ({ ...h, secret: openIfSealed(app, h.secret) })));
    router.post('/api/webhooks', 'location', (ctx) => {
      const url = str(ctx.body.url, 'URL', { required: true, max: 2000 });
      if (!/^https?:\/\//.test(url)) throw bad('URL muss mit http(s):// beginnen');
      const secret = token(18);
      const row = { id: id(), location_id: ctx.locationId, url, events: Array.isArray(ctx.body.events) && ctx.body.events.length ? ctx.body.events.map(String).slice(0, 100) : ['*'], secret: sealSecret(app, secret), active: 1, created_at: now() };
      db.insert('webhooks', row);
      return { ...row, secret };
    });
    router.delete('/api/webhooks/:id', 'location', (ctx) => {
      db.run('DELETE FROM webhooks WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    app.events.on('*', async (e) => {
      const hooks = parseRows(db.all('SELECT * FROM webhooks WHERE location_id = ? AND active = 1', e.locationId), ['events']);
      for (const h of hooks) {
        if (!h.events.includes('*') && !h.events.includes(e.type)) continue;
        const body = JSON.stringify({ type: e.type, locationId: e.locationId, at: e.at, data: e.data });
        const secret = openIfSealed(app, h.secret);
        try {
          const r = await safeFetch(h.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-pghl-signature': sha256(secret + body), 'x-pghl-signature-256': `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}` },
            body,
            timeoutMs: 10_000,
          });
          db.run('UPDATE webhooks SET last_status = ? WHERE id = ?', `${r.status} ${e.type}`, h.id);
        } catch (err) {
          db.run('UPDATE webhooks SET last_status = ? WHERE id = ?', `Fehler: ${(err as Error).message}`, h.id);
        }
      }
    });

    // --- uploads (images for funnels, logos) --------------------------------
    router.post('/api/uploads', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Dateiname', { required: true, max: 200 });
      const m = String(ctx.body.data ?? '').match(/^data:([\w/+.-]+);base64,(.+)$/);
      if (!m) throw bad('Erwarte eine data:-URL');
      const mime = m[1];
      // No SVG: served from our own origin it could carry script.
      if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(mime)) throw bad('Nur PNG, JPG, GIF, WebP oder PDF');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) throw bad('Datei größer als 8 MB');
      // The bytes must match the claimed type (no HTML or scripts disguised as images).
      if (!contentMatches(mime, buf)) throw bad('Dateiinhalt passt nicht zum Dateityp');
      mkdirSync(uploadDir, { recursive: true });
      // The stored name's extension comes from the checked type, never from the client's file name.
      const file = `${id(20)}${extFor(mime)}`;
      writeFileSync(join(uploadDir, file), buf);
      const row = { id: id(), location_id: ctx.locationId, name, file, mime, size: buf.length, created_at: now() };
      db.insert('uploads', row);
      return { ...row, url: `${app.baseUrl()}/uploads/${file}` };
    });
    router.get('/api/uploads', 'location', (ctx) =>
      db.all('SELECT * FROM uploads WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId).map((u) => ({ ...u, url: `${app.baseUrl()}/uploads/${u.file}` })),
    );
    router.get('/uploads/:file', 'public', (ctx) => {
      const row = db.get('SELECT * FROM uploads WHERE file = ?', ctx.params.file);
      const path = row && join(uploadDir, row.file);
      if (!row || !path || !existsSync(path)) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': row.mime, 'cache-control': 'public, max-age=31536000', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }, body: readFileSync(path) };
    });

    /** A consistent snapshot of the whole database, to download as a backup. */
    router.get('/api/admin/backup', 'admin', async () => {
      const file = join(app.config.dataDir, `backup-${Date.now()}-${id(6)}.db`);
      // The copy is made by a worker thread (the request loop keeps answering) and streamed, never read into memory as a whole.
      if (app.config.dbFile === ':memory:') db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      else await snapshotInto(app, file);
      const body = createReadStream(file);
      body.once('close', () => rmSync(file, { force: true }));
      return {
        __raw: true,
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3', 'content-disposition': `attachment; filename="pghl-backup-${new Date().toISOString().slice(0, 10)}.db"`, 'content-length': String(statSync(file).size) },
        body,
      };
    });

    router.get('/healthz', 'public', () => text('ok'));
  },
};
