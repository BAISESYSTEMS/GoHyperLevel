import { SESSION_COOKIE, type Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, redirect, str, type Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { hashPassword, id, now, sha256, token, verifyPassword } from '../core/util.js';
import { JoseError, JwksCache, verifyIdToken } from '../services/jose.js';
import { cleanPerms, domainList, emailDomain, PolicyError, socialReady } from '../services/login-policy.js';
import { exchangeCode as oauthExchange, pkcePair } from '../services/oauth.js';
import {
  DiscoveryCache,
  OidcError,
  amrIsMfa,
  buildAuthorizeUrl,
  clientAuthFor,
  exchangeCode,
  fetchJson,
  fetchUserinfo,
  mapClaims,
  mapGroups,
  type Fetcher,
  type GroupRule,
} from '../services/oidc.js';
import { safeFetch } from '../services/net.js';
import {
  SOCIAL_IDS,
  SOCIAL_LABEL,
  appleClientSecret,
  githubIdentity,
  identityFromClaims,
  socialEndpoints,
  socialIssuerCheck,
  socialTokenRequest,
  type SocialId,
} from '../services/social-login.js';
import { getBranding } from './agency.js';
import { safeNext, type HostInfo } from './login-policy.js';
import { sealSecret } from './mail-sync.js';
import { clientConfig } from './oauth-connect.js';

/**
 * Sign-in with Google, Microsoft, GitHub, Apple and any OpenID Connect provider (Keycloak, Authentik,
 * Authelia, Zitadel, Okta, Entra ID, Google Workspace …). Authorization-code flow with PKCE, state and
 * nonce; ID tokens are verified against the provider's JWKS. The callback never signs a browser in by
 * itself: it leaves a short-lived ticket bound to the random cookie of the browser (or Android-app
 * WebView) that started the flow, and that browser redeems it (`POST /api/auth/sso/poll`). This
 * keeps login CSRF out, lets client login domains use the main address as redirect URI and lets the
 * Android app finish a login that ran in a Custom Tab.
 */

const FLOW_COOKIE = 'pghl_sso';
const FLOW_TTL = 10 * 60_000;
const MASK = '••••••';
const PRESETS = ['keycloak', 'authentik', 'authelia', 'zitadel', 'okta', 'azure', 'google', 'generic'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;

class LoginError extends Error {}

export interface OidcConfig {
  claims: { email: string; name: string; groups: string };
  trust_email: boolean;
  use_userinfo: boolean;
  jit: boolean;
  default_role: 'admin' | 'member';
  default_locations: string[];
  default_permissions: string[] | null;
  group_rules: GroupRule[];
  require_group: boolean;
  sync_roles: boolean;
  enforce_domains: string[];
  allowed_domains: string[];
  /** The IdP handles MFA: no extra second factor here. */
  skip_2fa: boolean;
}

interface OidcRow {
  id: string;
  slug: string;
  name: string;
  preset: string;
  location_id: string | null;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  scopes: string;
  config: OidcConfig;
  enabled: number;
}

type Prov = { kind: 'social'; key: SocialId; slug: SocialId; label: string } | { kind: 'oidc'; key: string; slug: string; label: string; row: OidcRow };

interface Identity {
  provider: string;
  label: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  groups: string[];
  mfa: boolean;
}

const DEFAULT_CONFIG: OidcConfig = {
  claims: { email: 'email', name: 'name', groups: 'groups' },
  trust_email: false,
  use_userinfo: false,
  jit: false,
  default_role: 'member',
  default_locations: [],
  default_permissions: null,
  group_rules: [],
  require_group: false,
  sync_roles: false,
  enforce_domains: [],
  allowed_domains: [],
  skip_2fa: true,
};

export const ssoModule: Module = {
  name: 'sso',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE auth_identities (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, last_login_at TEXT
      );
      CREATE UNIQUE INDEX auth_identities_sub ON auth_identities(provider, subject);
      CREATE INDEX auth_identities_user ON auth_identities(user_id);
      CREATE TABLE sso_providers (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, preset TEXT NOT NULL DEFAULT 'generic',
        location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        issuer TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT, scopes TEXT NOT NULL DEFAULT 'openid email profile',
        config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sso_flows (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, mode TEXT NOT NULL, user_id TEXT, cookie_hash TEXT NOT NULL,
        verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL, origin TEXT NOT NULL, next TEXT NOT NULL,
        app INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX sso_flows_cookie ON sso_flows(cookie_hash);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const lp = () => app.services.loginPolicy;
    const allowHttp = app.config.baseUrl.startsWith('http://');

    // --- outbound HTTP (test hook app.services.ssoFetch; user-supplied issuers go through safeFetch) ----
    const httpFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const r = await safeFetch(String(url), { method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string, timeoutMs: 15_000, maxBytes: 1024 * 1024 });
      const body = [204, 205, 304].includes(r.status) ? null : await r.text();
      return new Response(body, { status: r.status >= 200 && r.status <= 599 ? r.status : 502, headers: { 'content-type': String(r.headers['content-type'] ?? 'application/json') } });
    }) as typeof fetch;
    const fetcher = (): typeof fetch => app.services.ssoFetch ?? httpFetch;
    const jwks = new JwksCache((url) => fetchJson(fetcher() as Fetcher, url));
    const discovery = new DiscoveryCache();

    // --- providers ---------------------------------------------------------------------------------
    const rowOut = (r: any): OidcRow | undefined => {
      if (!r) return undefined;
      const row = parseJson(r, ['config']) as OidcRow;
      row.config = { ...DEFAULT_CONFIG, ...(row.config ?? {}), claims: { ...DEFAULT_CONFIG.claims, ...(row.config?.claims ?? {}) } };
      return row;
    };
    const oidcById = (pid: string) => rowOut(db.get('SELECT * FROM sso_providers WHERE id = ?', pid));
    const oidcEnabled = () => db.all('SELECT * FROM sso_providers WHERE enabled = 1 ORDER BY name').map((r) => rowOut(r)!);
    const policyReady = (s: SocialId) => socialReady(lp().get(), s, (p: 'google' | 'microsoft') => !!clientConfig(app, p));

    /** "google" / "oidc:<id>" / an OIDC slug (callback path) → provider. Only enabled ones. */
    function resolve(key: string): Prov | undefined {
      if ((SOCIAL_IDS as string[]).includes(key)) {
        const s = key as SocialId;
        return policyReady(s) ? { kind: 'social', key: s, slug: s, label: SOCIAL_LABEL[s] } : undefined;
      }
      const row = key.startsWith('oidc:') ? oidcById(key.slice(5)) : rowOut(db.get('SELECT * FROM sso_providers WHERE slug = ?', key));
      if (!row || !row.enabled) return undefined;
      return { kind: 'oidc', key: `oidc:${row.id}`, slug: row.slug, label: row.name, row };
    }
    const labelOf = (key: string) => ((SOCIAL_IDS as string[]).includes(key) ? SOCIAL_LABEL[key as SocialId] : (oidcById(key.replace(/^oidc:/, ''))?.name ?? 'SSO'));
    const iconOf = (key: string) => ((SOCIAL_IDS as string[]).includes(key) ? key : 'key');

    app.services.ssoProviders = (locationId?: string) =>
      oidcEnabled()
        .filter((r) => !r.location_id || r.location_id === locationId)
        .map((r) => ({ id: `oidc:${r.id}`, label: r.name, icon: 'key', location_id: r.location_id }));
    app.services.ssoEnforced = (email: string) => {
      const d = emailDomain(email);
      if (!d) return null;
      const r = oidcEnabled().find((x) => x.config.enforce_domains.includes(d));
      return r ? { id: `oidc:${r.id}`, label: r.name } : null;
    };

    // --- flows -------------------------------------------------------------------------------------
    const starts = new Map<string, number[]>();
    const throttle = (ip: string) => {
      const t = Date.now();
      const list = (starts.get(ip) ?? []).filter((x) => t - x < 10 * 60_000);
      list.push(t);
      starts.set(ip, list);
      if (starts.size > 20_000) starts.clear();
      if (list.length > 40) throw new HttpError(429, 'Zu viele Anmeldeversuche – bitte kurz warten');
    };

    async function authorizeUrl(p: Prov, o: { redirectUri: string; state: string; nonce: string; challenge: string }): Promise<string> {
      if (p.kind === 'oidc') {
        const d = await discovery.get(fetcher() as Fetcher, p.row.issuer, { allowHttp });
        return buildAuthorizeUrl(d.authorization_endpoint, { clientId: p.row.client_id, redirectUri: o.redirectUri, scope: p.row.scopes, state: o.state, nonce: o.nonce, challenge: o.challenge });
      }
      const pol = lp().get();
      const cfg = p.key === 'google' || p.key === 'microsoft' ? clientConfig(app, p.key) : null;
      const ep = socialEndpoints(p.key, { tenant: cfg?.tenant });
      const clientId = cfg?.client_id ?? (p.key === 'github' ? pol.social.github.client_id : pol.social.apple.client_id);
      // Apple documents no PKCE; its code is bound to our signed client secret instead.
      return buildAuthorizeUrl(ep.authorize, { clientId, redirectUri: o.redirectUri, scope: ep.scope, state: o.state, nonce: p.key === 'github' ? undefined : o.nonce, challenge: p.key === 'apple' ? undefined : o.challenge, extra: ep.extra });
    }

    async function startFlow(ctx: Ctx, key: string, mode: 'login' | 'link', next: string, userId?: string): Promise<string> {
      throttle(ctx.ip);
      const p = resolve(String(key ?? ''));
      if (!p) throw notFound('Diese Anmeldeart ist nicht eingerichtet');
      const h: HostInfo = lp().hostInfo(ctx);
      // Social buttons follow the client domain's settings; an OIDC provider also starts from e-mail discovery or a direct link.
      if (mode === 'login' && p.kind === 'social' && !lp().providerAllowedHere(h, p.key)) throw new HttpError(403, 'Diese Anmeldeart gibt es auf dieser Seite nicht');
      // Redirect URIs are registered for the main address (and the live agency domain); client domains come back via a ticket.
      const callbackOrigin = h.canonical ? h.origin : app.baseUrl();
      const redirectUri = `${callbackOrigin}/auth/sso/${p.slug}/callback`;
      const cookie = token(32);
      const state = token(24);
      const nonce = token(24);
      const { verifier, challenge } = pkcePair();
      db.run('DELETE FROM sso_flows WHERE expires_at < ?', now());
      db.insert('sso_flows', {
        id: sha256(state),
        provider: p.key,
        mode,
        user_id: userId ?? null,
        cookie_hash: sha256(cookie),
        verifier,
        nonce,
        redirect_uri: redirectUri,
        origin: h.origin,
        next: safeNext(next),
        app: /GoHighApp\//.test(String(ctx.req.headers['user-agent'] ?? '')) ? 1 : 0,
        expires_at: new Date(Date.now() + FLOW_TTL).toISOString(),
        created_at: now(),
      });
      ctx.setCookie(FLOW_COOKIE, cookie, { maxAge: FLOW_TTL / 1000 });
      return authorizeUrl(p, { redirectUri, state, nonce, challenge });
    }

    router.post('/api/auth/sso/start', 'public', async (ctx) => ({ url: await startFlow(ctx, ctx.body.provider, 'login', ctx.body.next) }));
    /** Direct link (IdP app tile, bookmark): /auth/sso/<slug>?next=/app/… */
    router.get('/auth/sso/:provider', 'public', async (ctx) => {
      try {
        return redirect(await startFlow(ctx, ctx.params.provider, 'login', String(ctx.query.get('next') ?? '/app')));
      } catch (e) {
        return messagePage(ctx, 'Anmeldung nicht möglich', (e as Error).message, (e as HttpError).status ?? 400);
      }
    });

    // --- callback: verify the provider's answer, leave a ticket ------------------------------------
    async function identify(p: Prov, flow: any, code: string, appleUser: unknown): Promise<Identity> {
      const f = fetcher();
      if (p.kind === 'oidc') {
        const r = p.row;
        const d = await discovery.get(f as Fetcher, r.issuer, { allowHttp });
        const secret = r.client_secret ? lp().secret(r.client_secret) : '';
        const t = await exchangeCode(f as Fetcher, d.token_endpoint, { code, verifier: flow.verifier, redirectUri: flow.redirect_uri, clientId: r.client_id, clientSecret: secret, auth: clientAuthFor(d, !!secret) });
        if (!t.id_token) throw new LoginError(`${r.name} hat kein ID-Token geliefert (Scope „openid“?)`);
        const claims = await verifyIdToken(t.id_token, jwks, d.jwks_uri, { issuer: d.issuer, audience: r.client_id, nonce: flow.nonce });
        let all = claims;
        if (r.config.use_userinfo && d.userinfo_endpoint && t.access_token) {
          const info = await fetchUserinfo(f as Fetcher, d.userinfo_endpoint, t.access_token);
          // Userinfo must describe the same subject (OIDC Core 5.3.2); ID-token claims win.
          if (info.sub === claims.sub) all = { ...info, ...claims };
        }
        const m = mapClaims(all, r.config.claims, r.config.trust_email);
        return { provider: p.key, label: r.name, subject: String(claims.sub), email: m.email, emailVerified: m.emailVerified, name: m.name, groups: m.groups, mfa: r.config.skip_2fa || amrIsMfa(claims) };
      }
      const pol = lp().get();
      const ep = socialEndpoints(p.key, { tenant: clientConfig(app, 'microsoft')?.tenant });
      if (p.key === 'github') {
        const t = await socialTokenRequest(f as Fetcher, ep.token, { client_id: pol.social.github.client_id, client_secret: lp().secret(pol.social.github.client_secret), code, redirect_uri: flow.redirect_uri, code_verifier: flow.verifier });
        const g = await githubIdentity(f as Fetcher, t.access_token);
        return { provider: 'github', label: 'GitHub', ...g, groups: [], mfa: false };
      }
      let idToken: string | undefined;
      let audience: string;
      let tenant: string | undefined;
      if (p.key === 'apple') {
        const a = pol.social.apple;
        audience = a.client_id;
        const secret = appleClientSecret({ teamId: a.team_id, keyId: a.key_id, clientId: a.client_id, privateKey: lp().secret(a.private_key) });
        idToken = (await socialTokenRequest(f as Fetcher, ep.token, { grant_type: 'authorization_code', client_id: a.client_id, client_secret: secret, code, redirect_uri: flow.redirect_uri })).id_token;
      } else {
        // Google / Microsoft: the agency's OAuth app (same as for calendars), shared token helper.
        const cfg = clientConfig(app, p.key);
        if (!cfg) throw new LoginError(`Die ${p.label}-App der Agentur fehlt`);
        audience = cfg.client_id;
        tenant = cfg.tenant;
        idToken = (await oauthExchange(f, p.key, cfg, { code, verifier: flow.verifier, redirectUri: flow.redirect_uri, scopes: ['openid', 'email', 'profile'] })).id_token;
      }
      if (!idToken) throw new LoginError(`${p.label} hat kein ID-Token geliefert`);
      const claims = await verifyIdToken(idToken, jwks, ep.jwks!, { issuer: socialIssuerCheck(p.key, { tenant }), audience, nonce: flow.nonce });
      return { provider: p.key, label: p.label, ...identityFromClaims(p.key, claims, appleUser), groups: [], mfa: amrIsMfa(claims) };
    }

    const userRow = (uid: string) => db.get('SELECT * FROM users WHERE id = ?', uid);
    const identityOf = (provider: string, subject: string) => db.get('SELECT * FROM auth_identities WHERE provider = ? AND subject = ?', provider, subject);
    const link = (userId: string, i: Identity) => {
      db.insert('auth_identities', { id: id(), user_id: userId, provider: i.provider, subject: i.subject, email: i.email, name: i.name, created_at: now(), last_login_at: now() });
      app.services.audit?.({ action: 'identity.link', summary: `${i.label}: ${i.email || i.subject}`, userId, actor: i.name || i.email });
    };
    const mappingFor = (r: OidcRow, groups: string[]) =>
      mapGroups(groups, { rules: r.config.group_rules, default_role: r.config.default_role, default_locations: r.config.default_locations, default_permissions: r.config.default_permissions, require_group: r.config.require_group, location_id: r.location_id });
    /** A client's own IdP may only ever speak for logins of that client alone. */
    const onlyClientOf = (u: any, locationId: string) => u.role === 'member' && JSON.stringify(JSON.parse(u.locations || '[]')) === JSON.stringify([locationId]);
    const lastAdmin = (uid: string) => db.get<{ n: number }>(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND id != ?`, uid)!.n === 0;
    function syncRoles(u: any, r: OidcRow, groups: string[]) {
      const m = mappingFor(r, groups);
      const role = u.role === 'admin' && m.role !== 'admin' && lastAdmin(u.id) ? 'admin' : m.role;
      db.run('UPDATE users SET role = ?, locations = ?, permissions = ? WHERE id = ?', role, JSON.stringify(m.locations), role === 'admin' || m.permissions === null ? null : JSON.stringify(m.permissions), u.id);
    }
    function mayLink(p: Prov, u: any, auto: boolean): boolean {
      if (p.kind === 'oidc') return p.row.location_id ? onlyClientOf(u, p.row.location_id) : true;
      return auto ? lp().get().link_by_email && u.role !== 'admin' : true;
    }

    type Outcome = { kind: 'login' | 'link' | 'link_confirm' | 'error'; userId?: string; data: Record<string, any> };

    function loginOutcome(u: any, p: Prov, i: Identity): Outcome {
      const why = lp().refusal(u, { method: 'sso', provider: p.key });
      if (why) throw new LoginError(why);
      return { kind: 'login', userId: u.id, data: { provider: p.key, mfa: i.mfa } };
    }

    function decide(p: Prov, i: Identity): Outcome {
      const known = identityOf(i.provider, i.subject);
      if (known) {
        const u = userRow(known.user_id);
        if (!u) throw new LoginError('Konto nicht gefunden');
        if (p.kind === 'oidc') {
          if (p.row.location_id && !onlyClientOf(u, p.row.location_id)) throw new LoginError(`Dieses Konto kann nicht über ${p.label} angemeldet werden`);
          if (!mappingFor(p.row, i.groups).allowed) throw new LoginError(`Kein Zugriff: dein ${p.label}-Konto ist in keiner freigegebenen Gruppe`);
          if (p.row.config.sync_roles) syncRoles(u, p.row, i.groups);
        }
        db.run('UPDATE auth_identities SET email = ?, name = ?, last_login_at = ? WHERE id = ?', i.email, i.name, now(), known.id);
        return loginOutcome(userRow(u.id), p, i);
      }
      if (!i.email) throw new LoginError(`${p.label} hat keine bestätigte E-Mail-Adresse übermittelt`);
      if (!i.emailVerified) throw new LoginError(`Die E-Mail-Adresse ist bei ${p.label} nicht bestätigt`);
      if (p.kind === 'oidc' && p.row.config.allowed_domains.length && !p.row.config.allowed_domains.includes(emailDomain(i.email))) throw new LoginError(`@${emailDomain(i.email)} ist für ${p.label} nicht freigegeben`);
      const existing = db.get('SELECT * FROM users WHERE email = ?', i.email);
      if (existing) {
        if (mayLink(p, existing, true)) {
          if (p.kind === 'oidc') {
            if (!mappingFor(p.row, i.groups).allowed) throw new LoginError(`Kein Zugriff: dein ${p.label}-Konto ist in keiner freigegebenen Gruppe`);
            if (p.row.config.sync_roles) syncRoles(existing, p.row, i.groups);
          }
          link(existing.id, i);
          return loginOutcome(userRow(existing.id), p, i);
        }
        if (p.kind === 'oidc' && p.row.location_id) throw new LoginError(`Dieses Konto kann nicht über ${p.label} angemeldet werden`);
        if (existing.password_set) return { kind: 'link_confirm', userId: existing.id, data: { identity: i } };
        throw new LoginError(`Für ${i.email} gibt es schon ein Konto. Melde dich wie bisher an und verknüpfe ${p.label} unter Einstellungen → Mein Konto.`);
      }
      let u: any;
      if (p.kind === 'oidc') {
        if (!p.row.config.jit) throw new LoginError(`Für ${i.email} gibt es noch keinen Zugang – bitte bei der Agentur melden`);
        const m = mappingFor(p.row, i.groups);
        if (!m.allowed) throw new LoginError(`Kein Zugriff: dein ${p.label}-Konto ist in keiner freigegebenen Gruppe`);
        u = lp().createUser({ email: i.email, name: i.name, role: m.role, locations: m.locations, permissions: m.permissions, via: p.label });
      } else {
        u = lp().provision(i.email, i.name, p.label);
        if (!u) throw new LoginError(`Für ${i.email} gibt es kein Konto, und neue Konten sind nicht freigegeben`);
      }
      link(u.id, i);
      return loginOutcome(u, p, i);
    }

    function linkOutcome(p: Prov, flow: any, i: Identity): Outcome {
      const u = userRow(flow.user_id);
      if (!u) throw new LoginError('Konto nicht gefunden');
      const known = identityOf(i.provider, i.subject);
      if (known && known.user_id !== u.id) throw new LoginError(`Dieses ${p.label}-Konto ist schon mit einem anderen Login verknüpft`);
      if (!mayLink(p, u, false)) throw new LoginError(`${p.label} gehört zu einem Kunden-Konto und kann hier nicht verknüpft werden`);
      return { kind: 'link', userId: u.id, data: { identity: i } };
    }

    function messagePage(ctx: Ctx, title: string, text: string, status = 200, action?: { href: string; label: string }) {
      const b = getBranding(app);
      const btn = action ? `<p style="margin-top:22px"><a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>` : '';
      return html(publicPage({ title: `${title} – ${b.name}`, color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : undefined, body: `<div class="wrap" style="max-width:520px"><div class="card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(text)}</p>${btn}</div></div>` }), status);
    }

    async function callback(ctx: Ctx) {
      const q = ctx.method === 'POST' ? (ctx.body ?? {}) : Object.fromEntries(ctx.query);
      const state = String(q.state ?? '');
      const flow = state && state.length < 200 ? db.get('DELETE FROM sso_flows WHERE id = ? RETURNING *', sha256(state)) : undefined;
      if (!flow || flow.expires_at < now()) return messagePage(ctx, 'Anmeldung abgelaufen', 'Dieser Anmelde-Link ist abgelaufen oder wurde schon benutzt. Bitte noch einmal anmelden.', 400, { href: '/app', label: 'Zur Anmeldung' });
      const p = resolve(flow.provider);
      let outcome: Outcome;
      try {
        if (!p || p.slug !== ctx.params.provider) throw new LoginError('Anmeldeart passt nicht (mehr) – bitte noch einmal anmelden');
        if (q.error) {
          const denied = ['access_denied', 'user_cancelled_authorize', 'consent_required'].includes(String(q.error));
          throw new LoginError(denied ? 'Anmeldung abgebrochen' : `${p.label}: ${String(q.error_description || q.error).slice(0, 200)}`);
        }
        const code = String(q.code ?? '');
        if (!code || code.length > 4096) throw new LoginError('Kein Code erhalten');
        const ident = await identify(p, flow, code, q.user);
        outcome = flow.mode === 'link' ? linkOutcome(p, flow, ident) : decide(p, ident);
      } catch (e) {
        const expected = e instanceof LoginError || e instanceof JoseError || e instanceof OidcError || e instanceof PolicyError;
        const msg = expected ? (e as Error).message : `Anmeldung fehlgeschlagen: ${(e as Error).message}`.slice(0, 300);
        if (!expected) console.error('[sso]', flow.provider, e);
        app.services.audit?.({ ctx, action: 'login.sso_failed', summary: `${labelOf(flow.provider)}: ${msg}`.slice(0, 300) });
        outcome = { kind: 'error', data: { message: msg } };
      }
      lp().tickets.create(outcome.kind, { ...outcome.data, next: flow.next, provider: flow.provider }, { userId: outcome.userId ?? flow.user_id, cookieHash: flow.cookie_hash });
      const back = `${flow.origin}${flow.mode === 'link' ? '/app/settings/account' : '/app/'}`;
      if (flow.app) {
        // Android app: this ran in a Custom Tab; the app's WebView picks the result up on its own.
        return outcome.kind === 'error'
          ? messagePage(ctx, 'Anmeldung fehlgeschlagen', String(outcome.data.message), 200, { href: back, label: 'Zurück zur App' })
          : messagePage(ctx, 'Fast geschafft', 'Du kannst dieses Fenster schließen und zur App zurückkehren.', 200, { href: back, label: 'Zurück zur App' });
      }
      return redirect(back, 303);
    }
    router.get('/auth/sso/:provider/callback', 'public', callback);
    // Apple answers with a form post.
    router.post('/auth/sso/:provider/callback', 'public', callback);

    // --- the browser that started the flow redeems the ticket ---------------------------------------
    const sessionUser = (ctx: Ctx) => {
      const sid = ctx.cookies[SESSION_COOKIE];
      return sid ? db.get('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', sha256(sid), now()) : undefined;
    };
    router.post('/api/auth/sso/poll', 'public', (ctx) => {
      if (ctx.req.headers['x-pghl'] !== '1') throw new HttpError(403, 'CSRF-Schutz: Header fehlt');
      const cookie = ctx.cookies[FLOW_COOKIE];
      if (!cookie || !/^[A-Za-z0-9_-]{20,100}$/.test(cookie)) return { pending: false };
      const hash = sha256(cookie);
      const t = lp().tickets.takeByCookie(hash, ['login', 'link', 'link_confirm', 'error']);
      if (!t) return { pending: !!db.get('SELECT id FROM sso_flows WHERE cookie_hash = ? AND expires_at > ?', hash, now()) };
      ctx.setCookie(FLOW_COOKIE, '', { maxAge: 0 });
      const label = labelOf(t.data.provider ?? '');
      if (t.kind === 'error') return { error: t.data.message };
      const u = t.user_id ? userRow(t.user_id) : undefined;
      if (!u) return { error: 'Konto nicht gefunden' };
      if (t.kind === 'link') {
        const me = sessionUser(ctx);
        if (!me || me.id !== u.id) return { error: 'Bitte mit dem Konto angemeldet bleiben, mit dem du verknüpfen wolltest' };
        const i = t.data.identity as Identity;
        const known = identityOf(i.provider, i.subject);
        if (known && known.user_id !== u.id) return { error: `Dieses ${label}-Konto ist schon mit einem anderen Login verknüpft` };
        if (!known) link(u.id, i);
        return { linked: label };
      }
      if (t.kind === 'link_confirm') {
        const tk = lp().tickets.create('link_confirm', { identity: t.data.identity, next: t.data.next, provider: t.data.provider }, { userId: u.id, ttlMs: 10 * 60_000 });
        return { link_confirm: { token: tk, email: u.email, provider: label } };
      }
      try {
        return lp().finish(ctx, u, { method: 'sso', provider: t.data.provider, mfa: !!t.data.mfa, next: t.data.next });
      } catch (e) {
        if (e instanceof HttpError) return { error: e.message };
        throw e;
      }
    });

    /** "An account with this e-mail exists": confirm with its password (and second factor) to link and sign in. */
    router.post('/api/auth/sso/link-confirm', 'public', (ctx) => {
      const t = String(ctx.body.token ?? '');
      const tk = lp().tickets.peek(t, 'link_confirm');
      if (!tk) throw new HttpError(410, 'Abgelaufen – bitte noch einmal anmelden');
      const u = userRow(tk.user_id);
      if (!u) throw new HttpError(410, 'Konto nicht gefunden');
      const fail = (msg: string) => {
        if (lp().tickets.failed(t) >= 5) {
          lp().tickets.drop(t);
          throw new HttpError(429, 'Zu viele Fehlversuche – bitte noch einmal anmelden');
        }
        throw new HttpError(401, msg);
      };
      if (!verifyPassword(String(ctx.body.password ?? ''), u.password_hash)) fail('Passwort falsch');
      const second = app.services.secondFactor?.(u, ctx.body.code, ctx) ?? 'ok';
      if (second === 'needed') return { needs_code: true, ...(app.services.secondFactorOptions?.(u, ctx) ?? {}) };
      if (second === 'invalid') fail('Code falsch');
      if (!lp().tickets.take(t, 'link_confirm')) throw new HttpError(410, 'Abgelaufen – bitte noch einmal anmelden');
      const i = tk.data.identity as Identity;
      const known = identityOf(i.provider, i.subject);
      if (known && known.user_id !== u.id) throw bad(`Dieses ${i.label}-Konto ist schon mit einem anderen Login verknüpft`);
      if (!known) link(u.id, i);
      return lp().finish(ctx, u, { method: 'sso', provider: i.provider, mfa: true, next: tk.data.next });
    });

    // --- my linked accounts ---------------------------------------------------------------------------
    const linkable = (u: any) => {
      const social = SOCIAL_IDS.filter((s) => policyReady(s)).map((s) => ({ id: s as string, label: SOCIAL_LABEL[s], icon: s as string }));
      const oidc = oidcEnabled()
        .filter((r) => !r.location_id || onlyClientOf(u, r.location_id))
        .map((r) => ({ id: `oidc:${r.id}`, label: r.name, icon: 'key' }));
      return [...social, ...oidc];
    };
    router.get('/api/me/identities', 'user', (ctx) => {
      const u = userRow(ctx.user!.id)!;
      return {
        identities: db.all('SELECT id, provider, email, name, created_at, last_login_at FROM auth_identities WHERE user_id = ? ORDER BY created_at', u.id).map((r) => ({ ...r, label: labelOf(r.provider), icon: iconOf(r.provider) })),
        available: linkable(u),
        password_set: !!u.password_set,
        passkeys: app.services.passkeys?.count?.(u.id) ?? 0,
        enforced: app.services.ssoEnforced?.(u.email) ?? null,
      };
    });
    router.post('/api/me/identities/link', 'user', async (ctx) => {
      if (ctx.via !== 'session') throw new HttpError(403, 'Verknüpfen geht nur angemeldet im Browser');
      const u = userRow(ctx.user!.id)!;
      const key = String(ctx.body.provider ?? '');
      if (!linkable(u).some((x) => x.id === key)) throw notFound('Diese Anmeldeart kann hier nicht verknüpft werden');
      return { url: await startFlow(ctx, key, 'link', '/app/settings/account', u.id) };
    });
    router.delete('/api/me/identities/:id', 'user', (ctx) => {
      const u = userRow(ctx.user!.id)!;
      const row = db.get('SELECT * FROM auth_identities WHERE id = ? AND user_id = ?', ctx.params.id, u.id);
      if (!row) throw notFound();
      const others = db.get<{ n: number }>('SELECT COUNT(*) n FROM auth_identities WHERE user_id = ? AND id != ?', u.id, row.id)!.n;
      const keys = app.services.passkeys?.count?.(u.id) ?? 0;
      if (!u.password_set && !others && !keys) throw bad('Das ist deine einzige Anmeldeart – lege erst ein Passwort oder einen Passkey an');
      db.run('DELETE FROM auth_identities WHERE id = ?', row.id);
      app.services.audit?.({ ctx, action: 'identity.unlink', summary: `${labelOf(row.provider)}: ${row.email}` });
      return { ok: true };
    });
    /** Accounts created by SSO/magic link have no password yet: set one (once) without the old one. */
    router.post('/api/me/password/set', 'user', (ctx) => {
      const u = userRow(ctx.user!.id)!;
      if (u.password_set) throw bad('Du hast schon ein Passwort – ändere es mit dem aktuellen Passwort');
      const pw = str(ctx.body.password, 'Passwort', { required: true, max: 200 });
      if (pw.length < 8) throw bad('Passwort braucht mindestens 8 Zeichen');
      db.run('UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ?', hashPassword(pw), u.id);
      return { ok: true };
    });

    // --- agency: OpenID Connect providers --------------------------------------------------------------
    const origins = () => [...new Set([app.config.baseUrl.replace(/\/$/, ''), app.services.publicBaseUrl?.()].filter(Boolean) as string[])];
    const providerOut = (r: OidcRow) => ({
      ...r,
      enabled: !!r.enabled,
      client_secret: r.client_secret ? MASK : '',
      redirect_uris: origins().map((o) => `${o}/auth/sso/${r.slug}/callback`),
      login_url: `${app.baseUrl()}/auth/sso/${r.slug}`,
      users: db.get<{ n: number }>('SELECT COUNT(*) n FROM auth_identities WHERE provider = ?', `oidc:${r.id}`)!.n,
    });

    function validate(b: any, cur?: OidcRow): Omit<OidcRow, 'id'> {
      const name = str(b.name ?? cur?.name, 'Name', { required: true, max: 80 });
      const slug = str(b.slug ?? cur?.slug, 'Kurzname', { required: true, max: 40 }).toLowerCase();
      if (!SLUG.test(slug) || (SOCIAL_IDS as string[]).includes(slug)) throw bad('Kurzname: Kleinbuchstaben, Ziffern, Bindestrich (nicht google/microsoft/github/apple)');
      if (db.get('SELECT id FROM sso_providers WHERE slug = ? AND id != ?', slug, cur?.id ?? '')) throw bad('Kurzname schon vergeben');
      const preset = String(b.preset ?? cur?.preset ?? 'generic');
      if (!(PRESETS as readonly string[]).includes(preset)) throw bad('Unbekannte Vorlage');
      const issuer = str(b.issuer ?? cur?.issuer, 'Issuer-URL', { required: true, max: 500 });
      if (!/^https:\/\//.test(issuer) && !(allowHttp && /^http:\/\//.test(issuer))) throw bad('Issuer-URL muss mit https:// beginnen');
      if (preset === 'azure' && /\/(common|organizations|consumers)\//.test(issuer)) throw bad('Entra ID: Issuer mit deiner Mandanten-ID angeben (nicht common/organizations)');
      const client_id = str(b.client_id ?? cur?.client_id, 'Client-ID', { required: true, max: 300 });
      let client_secret = cur?.client_secret ?? null;
      if (b.client_secret === null) client_secret = null;
      else if (typeof b.client_secret === 'string' && b.client_secret.trim() && b.client_secret !== MASK) client_secret = sealSecret(app, str(b.client_secret, 'Client-Secret', { max: 1000 }));
      const scopes = str(b.scopes ?? cur?.scopes ?? 'openid email profile', 'Scopes', { max: 500 }).replace(/\s+/g, ' ');
      if (!/^[\w:./-]+( [\w:./-]+)*$/.test(scopes) || !scopes.split(' ').includes('openid')) throw bad('Scopes durch Leerzeichen getrennt, „openid“ ist Pflicht');
      const location_id = b.location_id !== undefined ? (b.location_id ? String(b.location_id) : null) : (cur?.location_id ?? null);
      if (location_id && !app.location(location_id)) throw notFound('Sub-Account nicht gefunden');
      const c = { ...(cur?.config ?? DEFAULT_CONFIG), ...(typeof b.config === 'object' && b.config ? b.config : {}) };
      const claimStr = (v: unknown, d: string) => (typeof v === 'string' ? v.trim().slice(0, 200) : d);
      const locs = (v: unknown, what: string) => {
        if (!Array.isArray(v)) return [];
        const list = v.map(String).slice(0, 100);
        for (const l of list) if (!app.location(l)) throw bad(`${what}: Sub-Account nicht gefunden`);
        return list;
      };
      let enforce: string[];
      let allowed: string[];
      try {
        enforce = domainList(c.enforce_domains);
        allowed = domainList(c.allowed_domains);
      } catch (e) {
        throw bad((e as Error).message);
      }
      for (const d of enforce) {
        const other = db.all('SELECT id, name, config FROM sso_providers WHERE id != ?', cur?.id ?? '').find((r) => (JSON.parse(r.config || '{}').enforce_domains ?? []).includes(d));
        if (other) throw bad(`@${d} ist schon „${other.name}“ zugeordnet`);
      }
      if (preset === 'google' && !allowed.length) throw bad('Google Workspace: erlaubte Domains eintragen (sonst kann sich jedes Google-Konto anmelden)');
      const rules: GroupRule[] = (Array.isArray(c.group_rules) ? c.group_rules : []).slice(0, 100).map((r: any) => {
        const group = str(r?.group, 'Gruppe', { required: true, max: 256 });
        const role = r?.role === 'admin' ? 'admin' : r?.role === 'member' ? 'member' : undefined;
        if (role === 'admin' && location_id) throw bad('Der Login eines Kunden kann keine Agentur-Admins anlegen');
        return { group, ...(role ? { role } : {}), locations: locs(r?.locations, 'Gruppe'), ...(r?.permissions !== undefined ? { permissions: cleanPerms(r.permissions) } : {}) };
      });
      const default_role = c.default_role === 'admin' && !location_id ? 'admin' : 'member';
      const config: OidcConfig = {
        claims: { email: claimStr(c.claims?.email, 'email') || 'email', name: claimStr(c.claims?.name, 'name') || 'name', groups: claimStr(c.claims?.groups, 'groups') },
        trust_email: !!c.trust_email,
        use_userinfo: !!c.use_userinfo,
        jit: !!c.jit,
        default_role,
        default_locations: locs(c.default_locations, 'Standard'),
        default_permissions: cleanPerms(c.default_permissions),
        group_rules: rules,
        require_group: !!c.require_group,
        sync_roles: !!c.sync_roles,
        enforce_domains: enforce,
        allowed_domains: allowed,
        skip_2fa: c.skip_2fa !== false,
      };
      return { slug, name, preset, location_id, issuer, client_id, client_secret, scopes, config, enabled: b.enabled === undefined ? (cur?.enabled ?? 1) : b.enabled ? 1 : 0 };
    }

    router.get('/api/agency/sso', 'admin', () => ({ providers: db.all('SELECT * FROM sso_providers ORDER BY name').map((r) => providerOut(rowOut(r)!)), callback_base: origins() }));
    router.post('/api/agency/sso', 'admin', (ctx) => {
      const v = validate(ctx.body ?? {});
      const row = { id: id(), ...v, config: JSON.stringify(v.config), created_at: now(), updated_at: now() };
      db.insert('sso_providers', row);
      discovery.clear();
      return providerOut(oidcById(row.id)!);
    });
    router.patch('/api/agency/sso/:id', 'admin', (ctx) => {
      const cur = oidcById(ctx.params.id);
      if (!cur) throw notFound();
      const v = validate(ctx.body ?? {}, cur);
      db.update('sso_providers', cur.id, { ...v, config: JSON.stringify(v.config), updated_at: now() });
      discovery.clear();
      return providerOut(oidcById(cur.id)!);
    });
    router.delete('/api/agency/sso/:id', 'admin', (ctx) => {
      const cur = oidcById(ctx.params.id);
      if (!cur) throw notFound();
      db.run('DELETE FROM auth_identities WHERE provider = ?', `oidc:${cur.id}`);
      db.run('DELETE FROM sso_providers WHERE id = ?', cur.id);
      return { ok: true };
    });
    /** Fetch discovery and keys once: shows typos in the issuer before anyone tries to sign in. */
    router.post('/api/agency/sso/:id/test', 'admin', async (ctx) => {
      const cur = oidcById(ctx.params.id);
      if (!cur) throw notFound();
      discovery.clear();
      try {
        const d = await discovery.get(fetcher() as Fetcher, cur.issuer, { allowHttp });
        const keys = await fetchJson(fetcher() as Fetcher, d.jwks_uri);
        return { ok: true, issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, userinfo_endpoint: d.userinfo_endpoint ?? null, keys: Array.isArray(keys?.keys) ? keys.keys.length : 0, pkce: d.code_challenge_methods_supported?.includes('S256') ?? null };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });

    app.onTick(() => void db.run('DELETE FROM sso_flows WHERE expires_at < ?', now()));
  },
};

export const SSO_FLOW_COOKIE = FLOW_COOKIE;
