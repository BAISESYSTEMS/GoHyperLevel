import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { signJwt } from '../server/services/jose.js';

/**
 * Test doubles for sign-in: OpenID Connect providers (discovery, JWKS, token endpoint with PKCE and
 * client-auth checks), Google/Microsoft/Apple/GitHub at their real URLs, and a software WebAuthn
 * authenticator. Plug `fakes.fetch` into `app.services.ssoFetch`.
 */

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });

export interface Account {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  groups?: string[];
  [k: string]: unknown;
}

export interface Tamper {
  badSignature?: boolean;
  expired?: boolean;
  aud?: string;
  iss?: string;
  nonce?: string;
  alg?: 'RS256' | 'ES256';
  noIdToken?: boolean;
}

interface Grant {
  account: Account;
  nonce: string;
  challenge: string;
  redirect: string;
  clientId: string;
  tamper: Tamper;
}

/** One OIDC provider. `endpoints` lets it pose as Google/Microsoft/Apple with their real URLs. */
export function createIdp(o: { issuer: string; clientId: string; clientSecret?: string; endpoints?: { authorize: string; token: string; jwks: string; userinfo?: string }; issuerFor?: (a: Account) => string; auth?: 'basic' | 'post' | 'apple'; appleKey?: KeyObject }) {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' };
  const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256', use: 'sig' };
  const base = o.issuer.replace(/\/$/, '');
  const ep = o.endpoints ?? { authorize: `${base}/protocol/openid-connect/auth`, token: `${base}/protocol/openid-connect/token`, jwks: `${base}/protocol/openid-connect/certs`, userinfo: `${base}/protocol/openid-connect/userinfo` };
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, Account>();
  let n = 0;
  const state = { calls: [] as { url: string; body: string; headers: Record<string, string> }[], lastIdToken: '', jwksHits: 0, keys: [rsaJwk, ecJwk] as any[] };

  function idToken(g: Grant) {
    const t = g.tamper;
    const nowS = Math.floor(Date.now() / 1000);
    const iss = t.iss ?? o.issuerFor?.(g.account) ?? o.issuer;
    const claims = { iss, aud: t.aud ?? g.clientId, iat: t.expired ? nowS - 7200 : nowS, exp: t.expired ? nowS - 3600 : nowS + 300, nonce: t.nonce ?? g.nonce, ...g.account };
    const alg = t.alg ?? 'RS256';
    let jwt = alg === 'ES256' ? signJwt(claims, ec.privateKey, { alg: 'ES256', kid: 'ec-1' }) : signJwt(claims, rsa.privateKey, { alg: 'RS256', kid: 'rsa-1' });
    if (t.badSignature) {
      const [h, , s] = jwt.split('.');
      jwt = `${h}.${b64u(JSON.stringify({ ...claims, email: 'mallory@evil.test' }))}.${s}`;
    }
    return jwt;
  }

  /** The consent screen: hands back code + state for an authorize URL (what the browser would carry to the callback). */
  function authorize(url: string, account: Account, tamper: Tamper = {}) {
    const u = new URL(url);
    if (`${u.origin}${u.pathname}` !== ep.authorize) throw new Error(`falscher authorize-Endpunkt: ${u.origin}${u.pathname}`);
    const code = `code-${++n}-${randomBytes(4).toString('hex')}`;
    grants.set(code, { account, nonce: u.searchParams.get('nonce') ?? '', challenge: u.searchParams.get('code_challenge') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '', clientId: u.searchParams.get('client_id') ?? '', tamper });
    return { code, state: u.searchParams.get('state') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '', params: Object.fromEntries(u.searchParams) };
  }

  async function handle(url: string, init: RequestInit = {}): Promise<Response | undefined> {
    const u = new URL(url);
    const path = `${u.origin}${u.pathname}`;
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if (path === `${base}/.well-known/openid-configuration` && !o.endpoints) {
      return json({ issuer: o.issuer, authorization_endpoint: ep.authorize, token_endpoint: ep.token, jwks_uri: ep.jwks, userinfo_endpoint: ep.userinfo, token_endpoint_auth_methods_supported: [o.auth === 'post' ? 'client_secret_post' : 'client_secret_basic'], code_challenge_methods_supported: ['S256'] });
    }
    if (path === ep.jwks) {
      state.jwksHits++;
      return json({ keys: state.keys });
    }
    if (path === ep.token) {
      const body = String(init.body ?? '');
      state.calls.push({ url, body, headers });
      const f = new URLSearchParams(body);
      const g = grants.get(f.get('code') ?? '');
      if (!g) return json({ error: 'invalid_grant', error_description: 'Code unbekannt' }, 400);
      grants.delete(f.get('code')!);
      if (f.get('redirect_uri') !== g.redirect) return json({ error: 'invalid_grant', error_description: 'redirect_uri passt nicht' }, 400);
      if (g.challenge && b64u(sha(f.get('code_verifier') ?? '')) !== g.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verifier falsch' }, 400);
      // client authentication
      if (o.auth === 'apple') {
        const [h, p, s] = String(f.get('client_secret') ?? '').split('.');
        const ok = !!o.appleKey && cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: o.appleKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s ?? '', 'base64url'));
        if (!ok) return json({ error: 'invalid_client' }, 400);
      } else if (o.clientSecret) {
        const basic = headers.authorization?.match(/^Basic (.+)$/)?.[1];
        const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [f.get('client_id'), f.get('client_secret')];
        if (id !== o.clientId || secret !== o.clientSecret) return json({ error: 'invalid_client' }, 401);
      }
      const access = `at-${++n}`;
      tokens.set(access, g.account);
      const idt = g.tamper.noIdToken ? undefined : idToken(g);
      if (idt) state.lastIdToken = idt;
      return json({ access_token: access, token_type: 'Bearer', expires_in: 300, scope: 'openid email profile', ...(idt ? { id_token: idt } : {}) });
    }
    if (ep.userinfo && path === ep.userinfo) {
      const a = tokens.get(String(headers.authorization ?? '').replace(/^Bearer /, ''));
      return a ? json(a) : json({ error: 'invalid_token' }, 401);
    }
    return undefined;
  }

  return { authorize, handle, state, rsa, ec, rotate: () => (state.keys = [{ ...rsaJwk, kid: 'rsa-2' }, ecJwk]) };
}

/** GitHub: OAuth token endpoint plus /user and /user/emails. */
export function createGithub(clientId: string, clientSecret: string) {
  const grants = new Map<string, { user: any; emails: any[]; challenge: string; redirect: string }>();
  const tokens = new Map<string, { user: any; emails: any[] }>();
  let n = 0;
  return {
    authorize(url: string, user: any, emails: any[]) {
      const u = new URL(url);
      const code = `gh-${++n}`;
      grants.set(code, { user, emails, challenge: u.searchParams.get('code_challenge') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '' });
      return { code, state: u.searchParams.get('state') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '', params: Object.fromEntries(u.searchParams) };
    },
    async handle(url: string, init: RequestInit = {}): Promise<Response | undefined> {
      if (url === 'https://github.com/login/oauth/access_token') {
        const f = new URLSearchParams(String(init.body ?? ''));
        const g = grants.get(f.get('code') ?? '');
        // GitHub answers 200 with an error body.
        if (!g || f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return json({ error: 'bad_verification_code' });
        if (g.challenge && b64u(sha(f.get('code_verifier') ?? '')) !== g.challenge) return json({ error: 'invalid_grant' });
        const t = `gho_${++n}`;
        tokens.set(t, g);
        return json({ access_token: t, token_type: 'bearer', scope: 'read:user,user:email' });
      }
      const auth = String((init.headers as any)?.authorization ?? '').replace(/^Bearer /, '');
      if (url === 'https://api.github.com/user') return tokens.has(auth) ? json(tokens.get(auth)!.user) : json({ message: 'Bad credentials' }, 401);
      if (url === 'https://api.github.com/user/emails') return tokens.has(auth) ? json(tokens.get(auth)!.emails) : json({ message: 'Bad credentials' }, 401);
      return undefined;
    },
  };
}

/** Routes fetch calls to the fakes; anything else fails loudly. */
export function fetchRouter(handlers: { handle(url: string, init?: RequestInit): Promise<Response | undefined> }[]) {
  const seen: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    for (const h of handlers) {
      const r = await h.handle(url, init);
      if (r) return r;
    }
    return json({ error: `kein Fake für ${url}` }, 599);
  }) as typeof fetch;
  return { fetch: f, seen };
}

// --- CBOR encoder + software authenticator ------------------------------------------------------

export function cborEncode(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'boolean') return Buffer.from([v ? 0xf5 : 0xf4]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cborEncode(k), cborEncode(x)])]);
  if (v && typeof v === 'object') return cborEncode(new Map(Object.entries(v)));
  throw new Error('cbor: Typ nicht unterstützt');
}

export type AuthAlg = 'ES256' | 'RS256' | 'EdDSA';

export function createAuthenticator(o: { rpId: string; origin: string; alg?: AuthAlg; userVerified?: boolean; synced?: boolean }) {
  const alg = o.alg ?? 'ES256';
  const pair = alg === 'ES256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : alg === 'RS256' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519');
  const credId = randomBytes(32);
  let counter = 0;
  let userHandle = '';
  const jwk = pair.publicKey.export({ format: 'jwk' }) as any;
  const cose =
    alg === 'ES256'
      ? new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
      : alg === 'RS256'
        ? new Map<number, unknown>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]])
        : new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]);
  const flags = (at: boolean) => 0x01 | (o.userVerified === false ? 0 : 0x04) | (o.synced ? 0x18 : 0) | (at ? 0x40 : 0);
  const sign = (data: Buffer) => (alg === 'EdDSA' ? cryptoSign(null, data, pair.privateKey) : cryptoSign('sha256', data, pair.privateKey));

  return {
    credId: b64u(credId),
    get counter() {
      return counter;
    },
    setCounter: (c: number) => (counter = c),
    publicKey: createPublicKey(pair.publicKey.export({ format: 'pem', type: 'spki' }) as string),
    /** navigator.credentials.create() */
    register(options: any, over: { origin?: string; rpId?: string; type?: string; challenge?: string; fmt?: string } = {}) {
      userHandle = options.user?.id ?? '';
      const clientData = Buffer.from(JSON.stringify({ type: over.type ?? 'webauthn.create', challenge: over.challenge ?? options.challenge, origin: over.origin ?? o.origin, crossOrigin: false }));
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(over.rpId ?? o.rpId), Buffer.from([flags(true)]), count, Buffer.alloc(16), len, credId, cborEncode(cose)]);
      const att = cborEncode(new Map<string, unknown>([['fmt', over.fmt ?? 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal', 'hybrid'] } };
    },
    /** navigator.credentials.get() */
    assert(options: any, over: { origin?: string; rpId?: string; counter?: number; challenge?: string } = {}) {
      counter = over.counter ?? counter + 1;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: over.challenge ?? options.challenge, origin: over.origin ?? o.origin }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(over.rpId ?? options.rpId ?? o.rpId), Buffer.from([flags(false)]), count]);
      const sig = sign(Buffer.concat([authData, sha(clientData)]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig), userHandle } };
    },
  };
}
