import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { normalizeDomain } from '../core/domains.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { hashPassword, id, now, sha256, token } from '../core/util.js';
import {
  DEFAULT_POLICY,
  PolicyError,
  assertUsable,
  cleanPerms,
  emailDomain,
  hostMethods,
  patchPolicy,
  readPolicy,
  signupAllowed,
  socialReady,
  type LoginPolicy,
} from '../services/login-policy.js';
import { SOCIAL_IDS, SOCIAL_LABEL } from '../services/social-login.js';
import { getBranding } from './agency.js';
import { startSession } from './core.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { clientConfig, redirectUriFor } from './oauth-connect.js';

/**
 * Sign-in policy for the whole installation: allowed methods (also per client login domain), who gets
 * an account on first login (closed / invite / e-mail domains), 2FA for admins, session lifetime.
 * Also the one place where every login method ends: `finish()` checks the policy (SSO enforced for the
 * e-mail domain …), asks for the second factor where needed and starts the session.
 * Other modules: app.services.loginPolicy (sso, passkeys, magic-link), sessionDays + passwordRefused (core).
 */

const MASK = '••••••';
const TICKET_TTL = 10 * 60_000;
/** Escape hatch when SSO is broken: admins may use their password again (set in the environment, restart). */
const breakGlass = () => process.env.PGHL_AUTH_BREAK_GLASS === '1';

export interface HostInfo {
  /** Origin the browser is on, e.g. https://crm.kunde.de */
  origin: string;
  host: string;
  /** Sub-account whose own login domain this is. */
  locationId?: string;
  /** Main address or live agency domain (redirect URIs are registered for these). */
  canonical: boolean;
}

export interface FinishOptions {
  method: 'password' | 'passkey' | 'magic' | 'sso';
  /** Provider id for SSO (google, oidc:<id> …). */
  provider?: string;
  /** Already two factors (passkey with user verification, IdP-side MFA, second factor done). */
  mfa?: boolean;
  next?: string;
}

export type FinishResult = { done: true; user: { id: string; email: string; name: string; role: string }; next: string } | { second_factor: Record<string, any> };

/** Only paths inside the app; anything else becomes /app. */
export function safeNext(v: unknown): string {
  const s = String(v ?? '');
  return /^\/app(\/[A-Za-z0-9/_\-.?=&%]*)?$/.test(s) && !s.includes('//') && s.length < 300 ? s : '/app';
}

export function hostInfo(app: App, ctx: Ctx): HostInfo {
  const base = new URL(app.config.baseUrl);
  const host = String(ctx.req.headers.host ?? '').toLowerCase();
  if (!host || host === base.host) return { origin: base.origin, host: base.host, canonical: true };
  let bare = '';
  try {
    bare = normalizeDomain(host);
  } catch {
    bare = '';
  }
  const agency = getBranding(app).app_domain;
  if (bare && agency && bare === agency) return { origin: `${base.protocol}//${host}`, host, canonical: true };
  const loc = bare ? app.db.get(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, bare) : undefined;
  if (loc) return { origin: `${base.protocol}//${host}`, host, locationId: loc.id, canonical: false };
  // Unknown host (IP, internal name): behave like the main address.
  const pub = new URL(app.baseUrl());
  return { origin: pub.origin, host: pub.host, canonical: true };
}

export const loginPolicyModule: Module = {
  name: 'login-policy',
  migrations: [
    [
      '001-init',
      `
      ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';
      ALTER TABLE sessions ADD COLUMN auth_mfa INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE auth_tickets (
        token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, cookie_hash TEXT,
        data TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX auth_tickets_cookie ON auth_tickets(cookie_hash);
      CREATE TABLE login_invites (
        email TEXT PRIMARY KEY, locations TEXT NOT NULL DEFAULT '[]', permissions TEXT,
        invited_by TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- policy storage (cached; saved only here) ---------------------------------------
    let cached: LoginPolicy | null = null;
    const policy = (): LoginPolicy => {
      if (!cached) {
        const row = db.get('SELECT value FROM agency_settings WHERE key = ?', 'login_policy');
        cached = readPolicy(row ? JSON.parse(row.value) : DEFAULT_POLICY);
      }
      return cached;
    };
    const save = (p: LoginPolicy) => {
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'login_policy', JSON.stringify(p));
      cached = null;
    };
    const oauthReady = (p: 'google' | 'microsoft') => !!clientConfig(app, p);
    const secret = (sealed?: string) => {
      if (!sealed) return '';
      try {
        return openSecret(app, sealed);
      } catch {
        return '';
      }
    };

    // --- tickets: short-lived, single-use steps between requests (handoff, second factor, link) ----
    const tickets = {
      create(kind: string, data: Record<string, any>, o: { userId?: string | null; cookieHash?: string | null; ttlMs?: number } = {}): string {
        const t = token(32);
        db.run('DELETE FROM auth_tickets WHERE expires_at < ?', now());
        db.insert('auth_tickets', { token_hash: sha256(t), kind, user_id: o.userId ?? null, cookie_hash: o.cookieHash ?? null, data: JSON.stringify(data), expires_at: new Date(Date.now() + (o.ttlMs ?? TICKET_TTL)).toISOString(), created_at: now() });
        return t;
      },
      /** Reads without using it up (second factor allows a few attempts). */
      peek(t: string, kind: string) {
        if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(t)) return undefined;
        const row = db.get('SELECT * FROM auth_tickets WHERE token_hash = ? AND kind = ? AND expires_at > ?', sha256(t), kind, now());
        return row ? { ...row, user_id: row.user_id as string, data: JSON.parse(row.data) } : undefined;
      },
      take(t: string, kind: string) {
        if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(t)) return undefined;
        const row = db.get('DELETE FROM auth_tickets WHERE token_hash = ? AND kind = ? RETURNING *', sha256(t), kind);
        return row && row.expires_at > now() ? { ...row, data: JSON.parse(row.data) } : undefined;
      },
      /** The ticket waiting for the browser that holds this flow cookie. */
      takeByCookie(cookieHash: string, kinds: string[]) {
        const row = db.get(`DELETE FROM auth_tickets WHERE token_hash = (SELECT token_hash FROM auth_tickets WHERE cookie_hash = ? AND kind IN (${kinds.map(() => '?').join(',')}) AND expires_at > ? ORDER BY created_at DESC LIMIT 1) RETURNING *`, cookieHash, ...kinds, now());
        return row ? { ...row, data: JSON.parse(row.data) } : undefined;
      },
      failed(t: string): number {
        db.run('UPDATE auth_tickets SET attempts = attempts + 1 WHERE token_hash = ?', sha256(t));
        return db.get('SELECT attempts FROM auth_tickets WHERE token_hash = ?', sha256(t))?.attempts ?? 99;
      },
      drop: (t: string) => void db.run('DELETE FROM auth_tickets WHERE token_hash = ?', sha256(t)),
    };

    // --- who may do what ----------------------------------------------------------------------
    const userRow = (uid: string) => db.get('SELECT * FROM users WHERE id = ?', uid);
    const hasPasskey = (uid: string) => !!app.services.passkeys?.count?.(uid);
    const has2fa = (u: any) => !!u.totp_enabled || hasPasskey(u.id);
    const adminNeeds2fa = (u: any) => u.role === 'admin' && policy().require_2fa_admins && !breakGlass();
    /** SSO provider that owns this e-mail domain ("SSO erzwingen"), if any. */
    const enforced = (email: string): { id: string; label: string } | null => app.services.ssoEnforced?.(email) ?? null;

    /** Why this user may not sign in this way (German), or null. */
    function refusal(u: any, o: FinishOptions, host?: HostInfo): string | null {
      if (breakGlass() && u.role === 'admin') return null;
      const sso = enforced(u.email);
      if (sso && !(o.method === 'sso' && o.provider === sso.id)) return `Für @${emailDomain(u.email)} ist die Anmeldung über „${sso.label}“ vorgeschrieben`;
      if (host) {
        const m = hostMethods(policy(), host.locationId);
        if (o.method === 'password' && !m.password) return 'Anmelden mit Passwort ist hier ausgeschaltet';
        if (o.method === 'passkey' && !m.passkey) return 'Anmelden mit Passkey ist hier ausgeschaltet';
        if (o.method === 'magic' && !m.magic_link) return 'Anmelden per E-Mail-Link ist hier ausgeschaltet';
      }
      return null;
    }

    /** Second factor after a login that proved only one: TOTP users always; admins with a passkey when 2FA is required. */
    const secondFactorNeeded = (u: any, o: FinishOptions) => !o.mfa && o.method !== 'password' && (!!u.totp_enabled || (adminNeeds2fa(u) && hasPasskey(u.id)));
    const secondFactorInfo = (u: any, ctx: Ctx) => ({ methods: u.totp_enabled ? ['code'] : [], ...(app.services.secondFactorOptions?.(u, ctx) ?? {}) });

    const methodLabel = (o: FinishOptions) => (o.method === 'sso' ? `sso:${o.provider ?? ''}` : o.method).slice(0, 60);

    function complete(ctx: Ctx, u: any, o: FinishOptions): FinishResult {
      const hash = startSession(ctx, app, u.id);
      db.run('UPDATE sessions SET auth_method = ?, auth_mfa = ? WHERE token_hash = ?', methodLabel(o), o.mfa ? 1 : 0, hash);
      app.services.audit?.({ ctx, action: 'login', summary: `${u.email} (${methodLabel(o)})`, userId: u.id, actor: u.name });
      return { done: true, user: { id: u.id, email: u.email, name: u.name, role: u.role }, next: safeNext(o.next) };
    }

    /** Every login method ends here. Throws HttpError(403) when the policy refuses. */
    function finish(ctx: Ctx, u: any, o: FinishOptions): FinishResult {
      const why = refusal(u, o, hostInfo(app, ctx));
      if (why) {
        app.services.audit?.({ ctx, action: 'login.refused', summary: `${u.email}: ${why}`, userId: u.id });
        throw new HttpError(403, why);
      }
      if (secondFactorNeeded(u, o)) {
        const t = tickets.create('second_factor', { method: o.method, provider: o.provider ?? null, next: safeNext(o.next) }, { userId: u.id, ttlMs: 5 * 60_000 });
        return { second_factor: { token: t, ...secondFactorInfo(u, ctx) } };
      }
      return complete(ctx, u, o);
    }

    // --- accounts created on first login --------------------------------------------------------
    const inviteOf = (email: string) => {
      const row = db.get('SELECT * FROM login_invites WHERE email = ? AND expires_at > ?', email, now());
      return row ? { ...row, locations: JSON.parse(row.locations || '[]'), permissions: row.permissions ? JSON.parse(row.permissions) : null } : undefined;
    };
    function createUser(o: { email: string; name: string; role: 'admin' | 'member'; locations: string[]; permissions: string[] | null; via: string }) {
      const known = new Set(db.all('SELECT id FROM locations').map((l) => l.id));
      const u = { id: id(), email: o.email, name: o.name || o.email, password_hash: hashPassword(token(24)), role: o.role, locations: o.locations.filter((l) => known.has(l)), permissions: o.role === 'admin' ? null : o.permissions, created_at: now(), password_set: 0 };
      db.insert('users', u);
      app.services.audit?.({ action: 'user.provisioned', summary: `${o.email} (${o.via})`, userId: u.id, actor: 'Anmeldung' });
      return userRow(u.id);
    }
    /** Social login / magic link for an unknown e-mail: invite or allowed domain → new member, else null. */
    function provision(email: string, name: string, via: string) {
      const p = policy();
      const inv = inviteOf(email);
      if (!signupAllowed(p, email, !!inv)) return null;
      const user = inv
        ? createUser({ email, name, role: 'member', locations: inv.locations, permissions: inv.permissions, via: `${via}, Einladung` })
        : createUser({ email, name, role: 'member', locations: p.signup.locations, permissions: p.signup.permissions, via });
      if (inv) db.run('DELETE FROM login_invites WHERE email = ?', email);
      return user;
    }

    // --- providers the login page offers ----------------------------------------------------------
    function providersFor(h: HostInfo) {
      const p = policy();
      const social: { id: string; label: string; icon: string; location_id?: string | null }[] = SOCIAL_IDS.filter((s) => socialReady(p, s, oauthReady)).map((s) => ({ id: s, label: SOCIAL_LABEL[s], icon: s }));
      const oidc: { id: string; label: string; icon: string; location_id?: string | null }[] = app.services.ssoProviders?.(h.locationId) ?? [];
      const all = [...social, ...oidc];
      const allowed = hostMethods(p, h.locationId).providers;
      // A client's domain: its own IdP always, the rest as configured for that client.
      return all.filter((x) => !allowed || allowed.includes(x.id) || (h.locationId && x.location_id === h.locationId)).map(({ id, label, icon }) => ({ id, label, icon }));
    }
    const providerAllowedHere = (h: HostInfo, providerId: string) => providersFor(h).some((x) => x.id === providerId);

    app.services.loginPolicy = { get: policy, hostInfo: (ctx: Ctx) => hostInfo(app, ctx), finish, refusal, tickets, provision, createUser, inviteOf, adminNeeds2fa, providerAllowedHere, secret, breakGlass };
    app.services.sessionDays = () => policy().session_days;
    app.services.passwordRefused = (ctx: Ctx, email: string): string | null => {
      if (breakGlass() && db.get(`SELECT id FROM users WHERE email = ? AND role = 'admin'`, email)) return null;
      const m = hostMethods(policy(), hostInfo(app, ctx).locationId);
      if (!m.password) return 'Anmelden mit Passwort ist ausgeschaltet – bitte eine andere Anmeldeart wählen';
      const sso = enforced(email);
      return sso ? `Für @${emailDomain(email)} ist die Anmeldung über „${sso.label}“ vorgeschrieben` : null;
    };

    // --- 2FA duty for admins: until set up, only the setup screens work ---------------------------------
    const GATE_OPEN = ['/api/me/2fa', '/api/me/passkeys', '/api/auth/gate', '/api/auth/logout', '/api/branding/me', '/api/me/sessions'];
    const gated = (ctx: Ctx) => {
      const u = ctx.user;
      if (!u || ctx.via !== 'session' || !adminNeeds2fa(u)) return false;
      const row = userRow(u.id);
      if (!row || has2fa(row)) return false;
      const s = db.get('SELECT auth_mfa FROM sessions WHERE token_hash = ?', sha256(ctx.cookies[SESSION_COOKIE] ?? ''));
      return !s?.auth_mfa;
    };
    app.guards.push((ctx) => {
      if (ctx.path === '/api/me' && ctx.method === 'GET') return;
      if (GATE_OPEN.some((p) => ctx.path === p || ctx.path.startsWith(p + '/'))) return;
      if (gated(ctx)) throw new HttpError(403, 'Zwei-Faktor-Login ist für Admins Pflicht – bitte zuerst einrichten');
    });
    router.get('/api/auth/gate', 'user', (ctx) => {
      const row = userRow(ctx.user!.id);
      return { require_2fa: gated(ctx), has_2fa: !!row && has2fa(row), passkeys: policy().passkey };
    });

    // --- public: what the login page shows -----------------------------------------------------
    router.get('/api/auth/methods', 'public', (ctx) => {
      const h = hostInfo(app, ctx);
      const m = hostMethods(policy(), h.locationId);
      return { password: m.password, magic_link: m.magic_link, passkey: m.passkey, providers: providersFor(h), break_glass: breakGlass() };
    });

    const discoverHits = new Map<string, number[]>();
    /** Home-realm discovery: which SSO the typed e-mail must use (domain-level, no account lookup). */
    router.post('/api/auth/discover', 'public', (ctx) => {
      const t = Date.now();
      const list = (discoverHits.get(ctx.ip) ?? []).filter((x) => t - x < 60_000);
      list.push(t);
      discoverHits.set(ctx.ip, list);
      if (discoverHits.size > 20_000) discoverHits.clear();
      if (list.length > 60) throw new HttpError(429, 'Zu viele Anfragen – bitte kurz warten');
      const email = str(ctx.body.email, 'E-Mail', { max: 200 }).toLowerCase();
      const sso = email.includes('@') ? enforced(email) : null;
      const m = hostMethods(policy(), hostInfo(app, ctx).locationId);
      return { sso: sso && !breakGlass() ? sso : null, password: m.password && !(sso && !breakGlass()) };
    });

    // --- second factor after SSO, magic link or passkey without verification ------------------------
    router.post('/api/auth/second-factor', 'public', (ctx) => {
      const t = String(ctx.body.token ?? '');
      const tk = tickets.peek(t, 'second_factor');
      if (!tk) throw new HttpError(410, 'Die Anmeldung ist abgelaufen – bitte noch einmal anmelden');
      const u = userRow(tk.user_id);
      if (!u) throw new HttpError(410, 'Konto nicht gefunden');
      const r = app.services.secondFactor?.(u, ctx.body.code, ctx) ?? 'ok';
      if (r === 'needed') throw bad('Bitte den Code eingeben oder mit Passkey bestätigen');
      if (r === 'invalid') {
        if (tickets.failed(t) >= 5) {
          tickets.drop(t);
          throw new HttpError(429, 'Zu viele Fehlversuche – bitte neu anmelden');
        }
        throw new HttpError(401, 'Code falsch');
      }
      if (!tickets.take(t, 'second_factor')) throw new HttpError(410, 'Die Anmeldung ist abgelaufen – bitte noch einmal anmelden');
      return complete(ctx, u, { method: tk.data.method, provider: tk.data.provider ?? undefined, mfa: true, next: tk.data.next });
    });

    // --- agency settings ------------------------------------------------------------------------------
    const out = () => {
      const p = policy();
      const origins = [...new Set([app.config.baseUrl.replace(/\/$/, ''), app.services.publicBaseUrl?.()].filter(Boolean) as string[])];
      return {
        ...p,
        social: {
          google: { ...p.social.google, oauth_configured: oauthReady('google'), redirect_uris: origins.map((o) => `${o}/auth/sso/google/callback`), calendar_redirect_uris: origins.map((o) => redirectUriFor(o, 'google')) },
          microsoft: { ...p.social.microsoft, oauth_configured: oauthReady('microsoft'), tenant: clientConfig(app, 'microsoft')?.tenant ?? 'common', redirect_uris: origins.map((o) => `${o}/auth/sso/microsoft/callback`) },
          github: { enabled: p.social.github.enabled, client_id: p.social.github.client_id, client_secret: p.social.github.client_secret ? MASK : '', redirect_uris: origins.map((o) => `${o}/auth/sso/github/callback`) },
          apple: { enabled: p.social.apple.enabled, client_id: p.social.apple.client_id, team_id: p.social.apple.team_id, key_id: p.social.apple.key_id, private_key: p.social.apple.private_key ? MASK : '', redirect_uris: origins.map((o) => `${o}/auth/sso/apple/callback`) },
        },
        ready: Object.fromEntries(SOCIAL_IDS.map((s) => [s, socialReady(p, s, oauthReady)])),
        break_glass: breakGlass(),
        invites: db.all('SELECT email, locations, permissions, expires_at, created_at FROM login_invites WHERE expires_at > ? ORDER BY created_at DESC', now()).map((r) => ({ ...r, locations: JSON.parse(r.locations || '[]'), permissions: r.permissions ? JSON.parse(r.permissions) : null })),
      };
    };
    router.get('/api/agency/login', 'admin', () => out());
    router.put('/api/agency/login', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      let next: LoginPolicy;
      try {
        next = patchPolicy(policy(), b, { locationExists: (lid) => !!app.location(lid) });
      } catch (e) {
        if (e instanceof PolicyError) throw bad(e.message);
        throw e;
      }
      const so = b.social ?? {};
      for (const s of SOCIAL_IDS) if (typeof so[s]?.enabled === 'boolean') next.social[s].enabled = so[s].enabled;
      if (so.github) {
        if (so.github.client_id !== undefined) next.social.github.client_id = str(so.github.client_id, 'GitHub Client-ID', { max: 100 });
        if (so.github.client_secret === null) delete next.social.github.client_secret;
        else if (typeof so.github.client_secret === 'string' && so.github.client_secret.trim() && so.github.client_secret !== MASK) next.social.github.client_secret = sealSecret(app, str(so.github.client_secret, 'GitHub Client-Secret', { max: 200 }));
      }
      if (so.apple) {
        for (const k of ['client_id', 'team_id', 'key_id'] as const) if (so.apple[k] !== undefined) next.social.apple[k] = str(so.apple[k], `Apple ${k}`, { max: k === 'client_id' ? 200 : 20 });
        if (next.social.apple.team_id && !/^[A-Z0-9]{10}$/.test(next.social.apple.team_id)) throw bad('Apple Team-ID: 10 Zeichen (A–Z, 0–9)');
        if (next.social.apple.key_id && !/^[A-Z0-9]{10}$/.test(next.social.apple.key_id)) throw bad('Apple Key-ID: 10 Zeichen (A–Z, 0–9)');
        if (so.apple.private_key === null) delete next.social.apple.private_key;
        else if (typeof so.apple.private_key === 'string' && so.apple.private_key.trim() && so.apple.private_key !== MASK) {
          const pem = so.apple.private_key.trim();
          if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(pem) || pem.length > 2000) throw bad('Apple-Schlüssel: Inhalt der .p8-Datei einfügen (BEGIN PRIVATE KEY …)'); // oss-check: allow
          next.social.apple.private_key = sealSecret(app, pem);
        }
      }
      try {
        const extra = (app.services.ssoProviders?.(undefined) ?? []).length;
        assertUsable(next, SOCIAL_IDS.filter((s) => socialReady(next, s, oauthReady)).length + extra);
      } catch (e) {
        throw bad((e as Error).message);
      }
      save(next);
      app.services.audit?.({ ctx, action: 'login_policy.update', summary: 'Anmelde-Einstellungen geändert' });
      return out();
    });

    // --- invites (sign-up mode "invite") ------------------------------------------------------------
    router.post('/api/agency/login/invites', 'admin', async (ctx) => {
      const email = str(ctx.body.email, 'E-Mail', { required: true, max: 200 }).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('E-Mail ungültig');
      if (db.get('SELECT id FROM users WHERE email = ?', email)) throw bad('Für diese E-Mail gibt es schon ein Konto');
      if (policy().signup.mode === 'closed') throw bad('Neue Konten sind geschlossen – stelle die Registrierung erst auf „Nur mit Einladung“');
      const locations = Array.isArray(ctx.body.locations) ? ctx.body.locations.map(String) : [];
      for (const l of locations) if (!app.location(l)) throw notFound('Sub-Account nicht gefunden');
      const days = Math.min(90, Math.max(1, Number(ctx.body.days) || 14));
      db.run(
        `INSERT INTO login_invites (email, locations, permissions, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET locations = excluded.locations, permissions = excluded.permissions, invited_by = excluded.invited_by, expires_at = excluded.expires_at`,
        email,
        JSON.stringify(locations),
        ctx.body.permissions === undefined || ctx.body.permissions === null ? null : JSON.stringify(cleanPerms(ctx.body.permissions)),
        ctx.user!.id,
        new Date(Date.now() + days * 864e5).toISOString(),
        now(),
      );
      let mail = 'skipped';
      if (ctx.body.send && app.services.magicLink?.sendInvite) mail = await app.services.magicLink.sendInvite(email, hostInfo(app, ctx).origin, days);
      return { email, mail, mode: policy().signup.mode };
    });
    router.delete('/api/agency/login/invites/:email', 'admin', (ctx) => {
      db.run('DELETE FROM login_invites WHERE email = ?', String(ctx.params.email).toLowerCase());
      return { ok: true };
    });

    app.onTick(() => void db.run('DELETE FROM auth_tickets WHERE expires_at < ?', now()));
  },
};
