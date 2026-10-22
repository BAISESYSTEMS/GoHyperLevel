import { signJwt } from './jose.js';
import { fetchJson, isTrue, type Fetcher } from './oidc.js';

/**
 * Built-in social sign-in: Google, Microsoft (Entra ID, multi-tenant), GitHub and Apple. Google,
 * Microsoft and Apple are OpenID Connect (ID token checked against their JWKS); GitHub is plain
 * OAuth 2.0, so the account comes from its API (only a verified primary e-mail counts).
 */

export type SocialId = 'google' | 'microsoft' | 'github' | 'apple';
export const SOCIAL_IDS: SocialId[] = ['google', 'microsoft', 'github', 'apple'];

export const SOCIAL_LABEL: Record<SocialId, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub', apple: 'Apple' };

/** Personal Microsoft accounts (outlook.com, hotmail …) all live in this tenant. */
export const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export interface SocialEndpoints {
  authorize: string;
  token: string;
  /** OIDC providers: JWKS and issuer check. */
  jwks?: string;
  scope: string;
  extra?: Record<string, string>;
}

const tenantOk = (t: string) => (/^[A-Za-z0-9.-]{1,100}$/.test(t) ? t : 'common');

export function socialEndpoints(id: SocialId, o: { tenant?: string } = {}): SocialEndpoints {
  switch (id) {
    case 'google':
      return { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', scope: 'openid email profile', extra: { prompt: 'select_account' } };
    case 'microsoft': {
      const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantOk(o.tenant ?? 'common'))}`;
      return { authorize: `${base}/oauth2/v2.0/authorize`, token: `${base}/oauth2/v2.0/token`, jwks: `${base}/discovery/v2.0/keys`, scope: 'openid email profile', extra: { response_mode: 'query', prompt: 'select_account' } };
    }
    case 'github':
      return { authorize: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'read:user user:email', extra: { allow_signup: 'false' } };
    case 'apple':
      // Apple posts the result back (form_post) when name/email are requested.
      return { authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys', scope: 'name email', extra: { response_mode: 'form_post' } };
  }
}

/** Issuer check per provider. Microsoft's multi-tenant issuer carries the tenant of the account. */
export function socialIssuerCheck(id: SocialId, o: { tenant?: string } = {}): (iss: string, claims: Record<string, any>) => boolean {
  if (id === 'google') return (iss) => iss === 'https://accounts.google.com' || iss === 'accounts.google.com';
  if (id === 'apple') return (iss) => iss === 'https://appleid.apple.com';
  const tenant = (o.tenant ?? 'common').toLowerCase();
  return (iss, c) => {
    const tid = typeof c.tid === 'string' ? c.tid.toLowerCase() : '';
    if (!/^[0-9a-f-]{36}$/.test(tid) || iss.toLowerCase() !== `https://login.microsoftonline.com/${tid}/v2.0`) return false;
    if (tenant === 'common') return true;
    if (tenant === 'consumers') return tid === MS_CONSUMER_TENANT;
    if (tenant === 'organizations') return tid !== MS_CONSUMER_TENANT;
    // A single tenant by GUID; a domain name ("contoso.onmicrosoft.com") was already pinned by the authorize URL.
    return /^[0-9a-f-]{36}$/.test(tenant) ? tid === tenant : true;
  };
}

/**
 * Microsoft's `email` claim is editable by tenant admins (the "nOAuth" problem), so it only counts as
 * verified for personal accounts or when Entra marks the domain as verified (optional claim xms_edov).
 */
export function microsoftEmailVerified(c: Record<string, any>): boolean {
  if (String(c.tid ?? '').toLowerCase() === MS_CONSUMER_TENANT) return true;
  return isTrue(c.xms_edov);
}

export interface SocialIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

const cleanEmail = (e: unknown) => {
  const s = String(e ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 200 ? s : '';
};

/** Identity from a verified ID token of Google, Microsoft or Apple. */
export function identityFromClaims(id: SocialId, c: Record<string, any>, appleUser?: unknown): SocialIdentity {
  const email = cleanEmail(c.email);
  if (id === 'microsoft') {
    // Stable per account across apps of the tenant: tid + oid; sub is per app.
    const subject = c.tid && c.oid ? `${String(c.tid).toLowerCase()}:${String(c.oid).toLowerCase()}` : String(c.sub);
    return { subject, email, emailVerified: !!email && microsoftEmailVerified(c), name: String(c.name ?? '').slice(0, 200) };
  }
  let name = String(c.name ?? '').slice(0, 200);
  if (id === 'apple' && !name && appleUser) {
    // Apple sends the name only once, as JSON in the form post ("user").
    try {
      const u = typeof appleUser === 'string' ? JSON.parse(appleUser) : appleUser;
      name = [u?.name?.firstName, u?.name?.lastName].filter((x) => typeof x === 'string').join(' ').slice(0, 200);
    } catch {
      /* no name */
    }
  }
  return { subject: String(c.sub), email, emailVerified: !!email && isTrue(c.email_verified), name };
}

/** GitHub: account id and the verified primary e-mail from the API. */
export async function githubIdentity(fetcher: Fetcher, accessToken: string): Promise<SocialIdentity> {
  const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'HyperLevel-Login', 'x-github-api-version': '2022-11-28' };
  const user = await fetchJson(fetcher, 'https://api.github.com/user', { headers });
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string')) throw new Error('GitHub: Konto unlesbar');
  const emails = await fetchJson(fetcher, 'https://api.github.com/user/emails', { headers }).catch(() => []);
  const primary = Array.isArray(emails) ? emails.find((e: any) => e?.primary && e?.verified) : undefined;
  const email = cleanEmail(primary?.email);
  return { subject: String(user.id), email, emailVerified: !!email, name: String(user.name || user.login || '').slice(0, 200) };
}

/** Apple's client_secret: an ES256 JWT signed with the .p8 key, valid up to six months (we use one hour). */
export function appleClientSecret(o: { teamId: string; keyId: string; clientId: string; privateKey: string; now?: number }): string {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  return signJwt({ iss: o.teamId, iat, exp: iat + 3600, aud: 'https://appleid.apple.com', sub: o.clientId }, o.privateKey, { alg: 'ES256', kid: o.keyId });
}

/** Token request of the OAuth providers that don't fit the generic helper (GitHub answers 200 with an error body). */
export async function socialTokenRequest(fetcher: Fetcher, endpoint: string, form: Record<string, string>): Promise<{ access_token: string; id_token?: string }> {
  const j = await fetchJson(fetcher, endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  if (!j.access_token) throw new Error(String(j.error_description || j.error || 'Keine Tokens erhalten').slice(0, 300));
  return { access_token: String(j.access_token), id_token: j.id_token ? String(j.id_token) : undefined };
}
