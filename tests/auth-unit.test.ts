import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { JwksCache, checkIdTokenClaims, decodeJwt, signJwt, verifyIdToken, verifyJws } from '../server/services/jose.js';
import { claimAt, clientAuthFor, discoveryTarget, mapClaims, mapGroups, parseDiscovery, readGroups, amrIsMfa } from '../server/services/oidc.js';
import { MS_CONSUMER_TENANT, appleClientSecret, identityFromClaims, microsoftEmailVerified, socialIssuerCheck } from '../server/services/social-login.js';
import { cborDecode, coseToJwk, parseAuthData, verifyAssertion, verifyRegistration } from '../server/services/webauthn.js';
import { DEFAULT_POLICY, assertUsable, domainList, hostMethods, patchPolicy, readPolicy, signupAllowed } from '../server/services/login-policy.js';
import { cborEncode, createAuthenticator } from './auth-fakes.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'r1', alg: 'RS256' };
const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'e1' };
const nowS = () => Math.floor(Date.now() / 1000);
const base = (over: Record<string, unknown> = {}) => ({ iss: 'https://idp.test', aud: 'client-1', sub: 'u1', iat: nowS(), exp: nowS() + 300, nonce: 'n-1', ...over });
const expect0 = { issuer: 'https://idp.test', audience: 'client-1', nonce: 'n-1' };

describe('JOSE: ID token verification', () => {
  const jwks = (keys: any[]) => {
    let hits = 0;
    let t = 1_000_000;
    const cache = new JwksCache(
      async () => {
        hits++;
        return { keys };
      },
      { now: () => t },
    );
    return { cache, hits: () => hits, tick: (ms: number) => (t += ms) };
  };

  it('accepts RS256 and ES256 tokens signed by a key of the JWKS', async () => {
    const { cache } = jwks([rsaJwk, ecJwk]);
    const a = signJwt(base(), rsa.privateKey, { alg: 'RS256', kid: 'r1' });
    const b = signJwt(base(), ec.privateKey, { alg: 'ES256', kid: 'e1' });
    expect((await verifyIdToken(a, cache, 'https://idp.test/jwks', expect0)).sub).toBe('u1');
    expect((await verifyIdToken(b, cache, 'https://idp.test/jwks', expect0)).sub).toBe('u1');
  });

  it('refuses a bad signature, alg none / HS256 and a key of the wrong type', async () => {
    const { cache } = jwks([rsaJwk, ecJwk]);
    const good = signJwt(base(), rsa.privateKey, { alg: 'RS256', kid: 'r1' });
    const [h, , s] = good.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify(base({ sub: 'admin' }))).toString('base64url')}.${s}`;
    await expect(verifyIdToken(forged, cache, 'u', expect0)).rejects.toThrow(/Signatur/);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(base())).toString('base64url')}.`;
    await expect(verifyIdToken(none, cache, 'u', expect0)).rejects.toThrow(/nicht erlaubt/);
    const hs = `${Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'r1' })).toString('base64url')}.${Buffer.from(JSON.stringify(base())).toString('base64url')}.c2ln`;
    await expect(verifyIdToken(hs, cache, 'u', expect0)).rejects.toThrow(/nicht erlaubt/);
    // An ES256 header pointing at the RSA key must not verify.
    const mixed = signJwt(base(), ec.privateKey, { alg: 'ES256', kid: 'r1' });
    await expect(verifyIdToken(mixed, cache, 'u', expect0)).rejects.toThrow(/Signatur|kid/);
    expect(() => decodeJwt('a.b')).toThrow(/JWT-Format/);
    expect(verifyJws(decodeJwt(good), ecJwk)).toBe(false);
  });

  it('checks iss, aud/azp, exp, iat, nbf, sub and nonce', () => {
    expect(() => checkIdTokenClaims(base({ iss: 'https://evil.test' }), expect0)).toThrow(/iss/);
    expect(() => checkIdTokenClaims(base({ aud: 'other' }), expect0)).toThrow(/aud/);
    expect(() => checkIdTokenClaims(base({ aud: ['client-1', 'other'] }), expect0)).toThrow(/azp/);
    expect(() => checkIdTokenClaims(base({ aud: ['client-1', 'other'], azp: 'client-1' }), expect0)).not.toThrow();
    expect(() => checkIdTokenClaims(base({ exp: nowS() - 120 }), expect0)).toThrow(/abgelaufen/);
    expect(() => checkIdTokenClaims(base({ exp: nowS() - 30 }), expect0)).not.toThrow(); // within leeway
    expect(() => checkIdTokenClaims(base({ iat: nowS() + 3600 }), expect0)).toThrow(/Zukunft/);
    expect(() => checkIdTokenClaims(base({ iat: nowS() - 3600 }), expect0)).toThrow(/zu alt/);
    expect(() => checkIdTokenClaims(base({ nbf: nowS() + 3600 }), expect0)).toThrow(/noch nicht/);
    expect(() => checkIdTokenClaims(base({ sub: '' }), expect0)).toThrow(/sub/);
    expect(() => checkIdTokenClaims(base({ nonce: 'replayed' }), expect0)).toThrow(/nonce/);
    expect(() => checkIdTokenClaims(base({ nonce: undefined }), expect0)).toThrow(/nonce/);
    const msIssuer = socialIssuerCheck('microsoft', { tenant: 'common' });
    const tid = '72f988bf-86f1-41af-91ab-2d7cd011db47';
    expect(() => checkIdTokenClaims(base({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid }), { ...expect0, issuer: msIssuer })).not.toThrow();
    expect(() => checkIdTokenClaims(base({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, tid: MS_CONSUMER_TENANT }), { ...expect0, issuer: msIssuer })).toThrow(/iss/);
  });

  it('caches the JWKS and fetches again only for an unknown kid, at most once a minute', async () => {
    const keys: any[] = [rsaJwk];
    const j = jwks(keys);
    const t1 = signJwt(base(), rsa.privateKey, { alg: 'RS256', kid: 'r1' });
    await verifyIdToken(t1, j.cache, 'u', expect0);
    await verifyIdToken(t1, j.cache, 'u', expect0);
    expect(j.hits()).toBe(1);
    // rotated key: unknown kid right away → no refetch (rate limit), after a minute → refetch finds it
    keys.push({ ...ecJwk, kid: 'e2' });
    const t2 = signJwt(base(), ec.privateKey, { alg: 'ES256', kid: 'e2' });
    await expect(verifyIdToken(t2, j.cache, 'u', expect0)).rejects.toThrow(/kid/);
    expect(j.hits()).toBe(1);
    j.tick(61_000);
    expect((await verifyIdToken(t2, j.cache, 'u', expect0)).sub).toBe('u1');
    expect(j.hits()).toBe(2);
    // after an hour everything is reloaded
    j.tick(3_600_001);
    await verifyIdToken(t1, j.cache, 'u', expect0);
    expect(j.hits()).toBe(3);
  });

  it('signs the Apple client secret with ES256', () => {
    const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = k.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const s = appleClientSecret({ teamId: 'TEAM123456', keyId: 'KEY1234567', clientId: 'com.example.login', privateKey: pem, now: 1_700_000_000_000 });
    const jwt = decodeJwt(s);
    expect(jwt.header).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(jwt.payload).toMatchObject({ iss: 'TEAM123456', sub: 'com.example.login', aud: 'https://appleid.apple.com', iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(cryptoVerify('sha256', Buffer.from(jwt.signingInput), { key: k.publicKey, dsaEncoding: 'ieee-p1363' }, jwt.signature)).toBe(true);
  });
});

describe('OIDC helpers', () => {
  it('finds the discovery document and insists on the announced issuer', () => {
    expect(discoveryTarget('https://sso.example.com/realms/acme/')).toEqual({ url: 'https://sso.example.com/realms/acme/.well-known/openid-configuration', issuer: 'https://sso.example.com/realms/acme' });
    expect(discoveryTarget('https://x.test/.well-known/openid-configuration').issuer).toBe('https://x.test');
    expect(() => discoveryTarget('nope')).toThrow();
    const doc = { issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/a', token_endpoint: 'https://idp.test/t', jwks_uri: 'https://idp.test/k' };
    expect(parseDiscovery(doc, 'https://idp.test/').issuer).toBe('https://idp.test');
    expect(() => parseDiscovery({ ...doc, issuer: 'https://evil.test' }, 'https://idp.test')).toThrow(/Issuer/);
    expect(() => parseDiscovery({ ...doc, token_endpoint: 'http://idp.test/t' }, 'https://idp.test')).toThrow(/https/);
    expect(parseDiscovery({ ...doc, token_endpoint: 'http://idp.test/t' }, 'https://idp.test', { allowHttp: true }).token_endpoint).toBe('http://idp.test/t');
    expect(clientAuthFor({ token_endpoint_auth_methods_supported: ['client_secret_post'] }, true)).toBe('post');
    expect(clientAuthFor({}, true)).toBe('basic');
    expect(clientAuthFor({}, false)).toBe('none');
  });

  it('reads claims by name or path and normalises groups', () => {
    const c = { email: 'Anna@Acme.TEST', email_verified: 'true', realm_access: { roles: ['crm-admin'] }, 'urn:zitadel:iam:org:project:roles': { editor: {}, viewer: {} }, groups: 'a, b c', amr: ['pwd', 'mfa'] };
    expect(claimAt(c, 'realm_access.roles')).toEqual(['crm-admin']);
    expect(readGroups(claimAt(c, 'urn:zitadel:iam:org:project:roles'))).toEqual(['editor', 'viewer']);
    expect(readGroups(c.groups)).toEqual(['a', 'b', 'c']);
    expect(mapClaims(c, { email: 'email', name: 'name', groups: 'realm_access.roles' }, false)).toMatchObject({ email: 'anna@acme.test', emailVerified: true, groups: ['crm-admin'] });
    expect(mapClaims({ email: 'x@y.de' }, { email: 'email', name: 'name', groups: '' }, false).emailVerified).toBe(false);
    expect(mapClaims({ email: 'x@y.de' }, { email: 'email', name: 'name', groups: '' }, true).emailVerified).toBe(true);
    expect(amrIsMfa(c)).toBe(true);
    expect(amrIsMfa({ amr: ['pwd'] })).toBe(false);
  });

  it('maps groups to role, sub-accounts and areas', () => {
    const cfg = {
      rules: [
        { group: 'crm-admins', role: 'admin' as const },
        { group: 'kunde-a', locations: ['A'], permissions: ['contacts'] },
        { group: 'kunde-b', locations: ['B'], permissions: ['calendars'] },
      ],
      default_role: 'member' as const,
      default_locations: ['D'],
      default_permissions: ['dashboard'],
      require_group: false,
    };
    expect(mapGroups(['kunde-a', 'kunde-b', 'other'], cfg)).toEqual({ allowed: true, role: 'member', locations: ['D', 'A', 'B'], permissions: ['contacts', 'calendars'], matched: ['kunde-a', 'kunde-b'] });
    expect(mapGroups(['crm-admins'], cfg)).toMatchObject({ role: 'admin', permissions: null });
    expect(mapGroups([], cfg)).toMatchObject({ allowed: true, permissions: ['dashboard'], locations: ['D'] });
    expect(mapGroups([], { ...cfg, require_group: true }).allowed).toBe(false);
    // A client's own IdP never grants admin or other sub-accounts.
    expect(mapGroups(['crm-admins', 'kunde-b'], { ...cfg, location_id: 'A' })).toMatchObject({ role: 'member', locations: ['A'], permissions: ['calendars'] });
  });
});

describe('social providers', () => {
  it('trusts Microsoft e-mails only for personal accounts or verified domains (nOAuth)', () => {
    expect(microsoftEmailVerified({ tid: MS_CONSUMER_TENANT })).toBe(true);
    expect(microsoftEmailVerified({ tid: '72f988bf-86f1-41af-91ab-2d7cd011db47' })).toBe(false);
    expect(microsoftEmailVerified({ tid: '72f988bf-86f1-41af-91ab-2d7cd011db47', xms_edov: true })).toBe(true);
    const id = identityFromClaims('microsoft', { sub: 's', tid: 'T-ID', oid: 'O-ID', email: 'a@b.de' });
    expect(id).toMatchObject({ subject: 't-id:o-id', emailVerified: false });
    const org = socialIssuerCheck('microsoft', { tenant: 'organizations' });
    expect(org(`https://login.microsoftonline.com/${MS_CONSUMER_TENANT}/v2.0`, { tid: MS_CONSUMER_TENANT })).toBe(false);
    const single = socialIssuerCheck('microsoft', { tenant: '11111111-2222-3333-4444-555555555555' });
    expect(single('https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0', { tid: '11111111-2222-3333-4444-555555555555' })).toBe(true);
    expect(single('https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0', { tid: '99999999-2222-3333-4444-555555555555' })).toBe(false);
    expect(socialIssuerCheck('google')('accounts.google.com', {})).toBe(true);
  });

  it('takes Apple’s name from the one-time form field and treats "true" strings as verified', () => {
    expect(identityFromClaims('apple', { sub: '001.abc', email: 'x@privaterelay.appleid.com', email_verified: 'true' }, JSON.stringify({ name: { firstName: 'Ada', lastName: 'L' } }))).toEqual({ subject: '001.abc', email: 'x@privaterelay.appleid.com', emailVerified: true, name: 'Ada L' });
    expect(identityFromClaims('google', { sub: '1', email: 'a@gmail.com', email_verified: false }).emailVerified).toBe(false);
  });
});

describe('WebAuthn', () => {
  it('decodes the CBOR examples of RFC 8949 (appendix A)', () => {
    const hex = (h: string) => cborDecode(Buffer.from(h, 'hex'));
    expect(hex('1903e8')).toBe(1000);
    expect(hex('3863')).toBe(-100);
    expect(hex('6449455446')).toBe('IETF');
    expect(hex('4401020304')).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(hex('83010203')).toEqual([1, 2, 3]);
    expect({ ...hex('a201020304') }).toEqual({ '1': 2, '3': 4 });
    expect(hex('f93c00')).toBe(1);
    expect(hex('fb3ff199999999999a')).toBe(1.1);
    expect(hex('f5')).toBe(true);
    expect(hex('f6')).toBe(null);
    expect(() => hex('5f42010243030405ff')).toThrow(/unbestimmte/);
    expect(() => hex('8301')).toThrow(/abgeschnitten/);
    expect(cborDecode(cborEncode(new Map<unknown, unknown>([[-2, Buffer.from('x')], ['fmt', 'none']])))).toMatchObject({ '-2': Buffer.from('x'), fmt: 'none' });
  });

  const rp = { rpId: 'crm.example.com', origin: 'https://crm.example.com' };
  for (const alg of ['ES256', 'RS256', 'EdDSA'] as const) {
    it(`registers and verifies a ${alg} passkey`, () => {
      const a = createAuthenticator({ ...rp, alg });
      const reg = verifyRegistration(a.register({ challenge: 'Y2hhbGxlbmdlLTE', user: { id: 'dTE' } }), { challenge: 'Y2hhbGxlbmdlLTE', origins: [rp.origin], rpId: rp.rpId });
      expect(reg).toMatchObject({ credentialId: a.credId, alg: { ES256: -7, RS256: -257, EdDSA: -8 }[alg], signCount: 0, uv: true });
      const r = verifyAssertion(a.assert({ challenge: 'Y2hhbGxlbmdlLTI', rpId: rp.rpId }), { challenge: 'Y2hhbGxlbmdlLTI', origins: [rp.origin], rpId: rp.rpId, jwk: reg.jwk, alg: reg.alg, storedSignCount: 0 });
      expect(r).toMatchObject({ signCount: 1, uv: true, userHandle: 'u1' });
    });
  }

  it('refuses wrong origin, rpId, challenge, type and a forged signature', () => {
    const a = createAuthenticator(rp);
    const o = { challenge: 'Y2gx', origins: [rp.origin], rpId: rp.rpId };
    expect(() => verifyRegistration(a.register({ challenge: 'Y2gx' }, { origin: 'https://evil.test' }), o)).toThrow(/falscher Adresse/);
    expect(() => verifyRegistration(a.register({ challenge: 'Y2gx' }, { rpId: 'evil.test' }), o)).toThrow(/rpId/);
    expect(() => verifyRegistration(a.register({ challenge: 'b3RoZXI' }), o)).toThrow(/Challenge/);
    expect(() => verifyRegistration(a.register({ challenge: 'Y2gx' }, { type: 'webauthn.get' }), o)).toThrow(/clientData.type/);
    const reg = verifyRegistration(a.register({ challenge: 'Y2gx' }), o);
    const assertion = a.assert({ challenge: 'Y2gy', rpId: rp.rpId });
    const tampered = { ...assertion, response: { ...assertion.response, signature: Buffer.alloc(70, 1).toString('base64url') } };
    expect(() => verifyAssertion(tampered, { ...o, challenge: 'Y2gy', jwk: reg.jwk, alg: reg.alg, storedSignCount: 0 })).toThrow(/Signatur/);
    expect(() => verifyAssertion(a.assert({ challenge: 'Y2gy', rpId: rp.rpId }), { ...o, challenge: 'Y2gy', origins: ['https://other.test'], jwk: reg.jwk, alg: reg.alg, storedSignCount: 0 })).toThrow(/falscher Adresse/);
  });

  it('detects a counter going backwards and can require user verification', () => {
    const a = createAuthenticator(rp);
    const reg = verifyRegistration(a.register({ challenge: 'Y2gx' }), { challenge: 'Y2gx', origins: [rp.origin], rpId: rp.rpId });
    const o = { challenge: 'Y2gy', origins: [rp.origin], rpId: rp.rpId, jwk: reg.jwk, alg: reg.alg };
    expect(verifyAssertion(a.assert({ challenge: 'Y2gy' }, { counter: 7 }), { ...o, storedSignCount: 5 }).signCount).toBe(7);
    expect(() => verifyAssertion(a.assert({ challenge: 'Y2gy' }, { counter: 5 }), { ...o, storedSignCount: 5 })).toThrow(/Zähler/);
    // synced passkeys always report 0 – that is fine
    expect(verifyAssertion(a.assert({ challenge: 'Y2gy' }, { counter: 0 }), { ...o, storedSignCount: 0 }).signCount).toBe(0);
    const noUv = createAuthenticator({ ...rp, userVerified: false });
    expect(() => verifyRegistration(noUv.register({ challenge: 'Y2gx' }), { challenge: 'Y2gx', origins: [rp.origin], rpId: rp.rpId, requireUV: true })).toThrow(/verifiziert/);
  });

  it('parses authenticator data and COSE keys', () => {
    const ad = parseAuthData(Buffer.concat([Buffer.alloc(32, 7), Buffer.from([0x05]), Buffer.from([0, 0, 0, 9])]));
    expect(ad.flags).toMatchObject({ up: true, uv: true, at: false });
    expect(ad.signCount).toBe(9);
    expect(() => parseAuthData(Buffer.alloc(10))).toThrow(/zu kurz/);
    expect(() => coseToJwk({ '1': 2, '3': -7, '-1': 2, '-2': Buffer.alloc(48), '-3': Buffer.alloc(48) })).toThrow(/P-256/);
    expect(() => coseToJwk({ '1': 4, '3': -36 })).toThrow(/nicht unterstützt/);
  });
});

describe('login policy', () => {
  const exists = (id: string) => ['locA00', 'locB00'].includes(id);
  it('fills defaults and validates changes', () => {
    expect(readPolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(readPolicy({ session_days: 9999, signup: { mode: 'weird' } })).toMatchObject({ session_days: 365, signup: { mode: 'closed' } });
    const p = patchPolicy(DEFAULT_POLICY, { magic_link: true, session_days: 7, signup: { mode: 'domains', domains: '@Acme.test, beispiel.de', locations: ['locA00'] } }, { locationExists: exists });
    expect(p).toMatchObject({ magic_link: true, session_days: 7, signup: { mode: 'domains', domains: ['acme.test', 'beispiel.de'], locations: ['locA00'] } });
    expect(() => patchPolicy(DEFAULT_POLICY, { session_days: 0 }, { locationExists: exists })).toThrow(/Sitzungsdauer/);
    expect(() => patchPolicy(DEFAULT_POLICY, { signup: { mode: 'domains' } }, { locationExists: exists })).toThrow(/Domain/);
    expect(() => patchPolicy(DEFAULT_POLICY, { signup: { locations: ['nope00'] } }, { locationExists: exists })).toThrow(/nicht gefunden/);
    expect(() => domainList('not a domain!')).toThrow(/ungültig/);
    expect(() => assertUsable({ ...DEFAULT_POLICY, password: false, passkey: false, magic_link: false }, 0)).toThrow(/Mindestens/);
    expect(() => assertUsable({ ...DEFAULT_POLICY, password: false, passkey: false, magic_link: false }, 1)).not.toThrow();
  });

  it('decides sign-up and the methods of a client domain', () => {
    const p = { ...DEFAULT_POLICY, signup: { ...DEFAULT_POLICY.signup, mode: 'domains' as const, domains: ['acme.test'] } };
    expect(signupAllowed(p, 'a@acme.test', false)).toBe(true);
    expect(signupAllowed(p, 'a@other.test', false)).toBe(false);
    expect(signupAllowed(DEFAULT_POLICY, 'a@acme.test', true)).toBe(false); // closed: no invites either
    expect(signupAllowed({ ...DEFAULT_POLICY, signup: { ...DEFAULT_POLICY.signup, mode: 'invite' } }, 'a@x.test', true)).toBe(true);
    const c = patchPolicy(DEFAULT_POLICY, { clients: { locA00: { password: false, providers: ['oidc:abcdef123456', 'google', 'bogus'] } } }, { locationExists: exists });
    expect(hostMethods(c, 'locA00')).toEqual({ password: false, magic_link: false, passkey: true, providers: ['oidc:abcdef123456', 'google'] });
    expect(hostMethods(c, 'locB00')).toEqual({ password: true, magic_link: false, passkey: true, providers: null });
  });
});
