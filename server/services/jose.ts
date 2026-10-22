import { constants, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Just enough JOSE for OpenID Connect login, with node:crypto only: decode a JWT, verify its
 * signature against a JWK (RS256/384/512, PS256, ES256/384), cache a provider's JWKS, check the
 * ID-token claims (iss, aud/azp, exp, iat, nbf, nonce) and sign small JWTs (Apple client secret).
 */

export class JoseError extends Error {}

export const b64url = {
  enc: (b: Buffer | Uint8Array | string) => Buffer.from(b as any).toString('base64url'),
  dec: (s: string) => Buffer.from(String(s ?? ''), 'base64url'),
};

export interface Jwt {
  header: Record<string, any>;
  payload: Record<string, any>;
  signingInput: string;
  signature: Buffer;
}

export function decodeJwt(token: string): Jwt {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new JoseError('Token hat kein JWT-Format');
  let header: any;
  let payload: any;
  try {
    header = JSON.parse(b64url.dec(parts[0]).toString('utf8'));
    payload = JSON.parse(b64url.dec(parts[1]).toString('utf8'));
  } catch {
    throw new JoseError('Token unlesbar');
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JoseError('Token unlesbar');
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: b64url.dec(parts[2]) };
}

interface AlgSpec {
  hash: string;
  kty: 'RSA' | 'EC';
  crv?: string;
  /** Raw r||s length of an ECDSA signature. */
  sigLen?: number;
  pss?: boolean;
}

const ALGS: Record<string, AlgSpec> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', crv: 'P-256', sigLen: 64 },
  ES384: { hash: 'sha384', kty: 'EC', crv: 'P-384', sigLen: 96 },
};
/** Asymmetric algorithms only: "none" and HMAC (HS*) are always refused. */
export const SUPPORTED_ALGS = Object.keys(ALGS);

function publicKeyOf(jwk: Record<string, any>): KeyObject {
  try {
    const { kty, crv, x, y, n, e } = jwk;
    return createPublicKey({ key: { kty, crv, x, y, n, e } as JsonWebKey, format: 'jwk' });
  } catch {
    throw new JoseError('Schlüssel des Anbieters unlesbar');
  }
}

/** Verifies the JWS signature of `jwt` with `jwk`. False when key and algorithm don't fit together. */
export function verifyJws(jwt: Jwt, jwk: Record<string, any>): boolean {
  const alg = ALGS[jwt.header.alg];
  if (!alg) throw new JoseError(`Signaturverfahren „${String(jwt.header.alg).slice(0, 20)}“ nicht erlaubt`);
  if (!jwk || jwk.kty !== alg.kty) return false;
  if (jwk.alg && jwk.alg !== jwt.header.alg) return false;
  if (jwk.use && jwk.use !== 'sig') return false;
  if (alg.crv && jwk.crv !== alg.crv) return false;
  const key = publicKeyOf(jwk);
  const data = Buffer.from(jwt.signingInput);
  if (alg.kty === 'RSA') {
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new JoseError('RSA-Schlüssel des Anbieters ist zu kurz');
    if (alg.pss) return cryptoVerify(alg.hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, jwt.signature);
    return cryptoVerify(alg.hash, data, key, jwt.signature);
  }
  if (jwt.signature.length !== alg.sigLen) return false;
  return cryptoVerify(alg.hash, data, { key, dsaEncoding: 'ieee-p1363' }, jwt.signature);
}

// --- JWKS -------------------------------------------------------------------------------

export type JsonFetcher = (url: string) => Promise<any>;

/**
 * Keys per JWKS URI, kept for an hour. An unknown `kid` (key rotation) triggers one fresh download,
 * at most once a minute per URI, so forged tokens with random kids can't hammer the provider.
 */
export class JwksCache {
  private entries = new Map<string, { keys: Record<string, any>[]; at: number }>();

  constructor(
    private fetchJson: JsonFetcher,
    private opts: { ttlMs?: number; minRefreshMs?: number; now?: () => number } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private async load(uri: string) {
    const doc = await this.fetchJson(uri);
    const keys = Array.isArray(doc?.keys) ? doc.keys.filter((k: any) => k && typeof k === 'object' && typeof k.kty === 'string').slice(0, 100) : [];
    if (!keys.length) throw new JoseError('Der Anbieter liefert keine Signaturschlüssel (JWKS)');
    const entry = { keys, at: this.now() };
    this.entries.set(uri, entry);
    return entry;
  }

  private static pick(keys: Record<string, any>[], header: Record<string, any>) {
    const spec = ALGS[header.alg];
    const usable = keys.filter((k) => (!k.use || k.use === 'sig') && (!spec || k.kty === spec.kty));
    if (header.kid !== undefined) return usable.find((k) => k.kid === header.kid);
    return usable.length === 1 ? usable[0] : undefined;
  }

  async keyFor(uri: string, header: Record<string, any>): Promise<Record<string, any>> {
    let entry = this.entries.get(uri);
    if (!entry || this.now() - entry.at > (this.opts.ttlMs ?? 3600_000)) entry = await this.load(uri);
    let key = JwksCache.pick(entry.keys, header);
    if (!key && this.now() - entry.at > (this.opts.minRefreshMs ?? 60_000)) {
      entry = await this.load(uri);
      key = JwksCache.pick(entry.keys, header);
    }
    if (!key) throw new JoseError('Signaturschlüssel des Anbieters nicht gefunden (kid unbekannt)');
    return key;
  }

  clear() {
    this.entries.clear();
  }
}

// --- ID token ----------------------------------------------------------------------------

export interface IdTokenExpectations {
  /** Exact issuer, or a check for issuers with a template (Microsoft multi-tenant: …/{tid}/v2.0). */
  issuer: string | ((iss: string, claims: Record<string, any>) => boolean);
  /** Our client id. */
  audience: string;
  /** The nonce sent with the authorization request; required when given. */
  nonce?: string;
  now?: number;
  leewaySec?: number;
  /** Refuse tokens issued longer ago than this (default 10 minutes). */
  maxAgeSec?: number;
}

/** The claim checks of OIDC Core 3.1.3.7 (signature is checked separately). Throws in German. */
export function checkIdTokenClaims(c: Record<string, any>, expect: IdTokenExpectations): void {
  const now = Math.floor((expect.now ?? Date.now()) / 1000);
  const leeway = expect.leewaySec ?? 60;
  const iss = typeof c.iss === 'string' ? c.iss : '';
  const issOk = typeof expect.issuer === 'function' ? !!iss && expect.issuer(iss, c) : iss === expect.issuer;
  if (!issOk) throw new JoseError('ID-Token stammt nicht vom erwarteten Anbieter (iss)');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(expect.audience)) throw new JoseError('ID-Token ist nicht für diese App ausgestellt (aud)');
  if (aud.length > 1 && c.azp !== expect.audience) throw new JoseError('ID-Token ist nicht für diese App ausgestellt (azp)');
  if (c.azp !== undefined && c.azp !== expect.audience) throw new JoseError('ID-Token ist nicht für diese App ausgestellt (azp)');
  if (typeof c.exp !== 'number' || c.exp <= now - leeway) throw new JoseError('ID-Token ist abgelaufen');
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf > now + leeway)) throw new JoseError('ID-Token ist noch nicht gültig');
  if (c.iat !== undefined) {
    if (typeof c.iat !== 'number' || c.iat > now + leeway) throw new JoseError('ID-Token hat ein Ausstellungsdatum in der Zukunft');
    if (c.iat < now - (expect.maxAgeSec ?? 600) - leeway) throw new JoseError('ID-Token ist zu alt');
  }
  if (typeof c.sub !== 'string' || !c.sub || c.sub.length > 255) throw new JoseError('ID-Token ohne Nutzer-Kennung (sub)');
  if (expect.nonce !== undefined && c.nonce !== expect.nonce) throw new JoseError('ID-Token passt nicht zu dieser Anmeldung (nonce)');
}

/** Signature (key from the provider's JWKS) + claims. Returns the claims. */
export async function verifyIdToken(token: string, jwks: JwksCache, jwksUri: string, expect: IdTokenExpectations): Promise<Record<string, any>> {
  const jwt = decodeJwt(token);
  if (!SUPPORTED_ALGS.includes(jwt.header.alg)) throw new JoseError(`Signaturverfahren „${String(jwt.header.alg).slice(0, 20)}“ nicht erlaubt`);
  if (jwt.header.crit !== undefined) throw new JoseError('ID-Token mit unbekannten Pflicht-Erweiterungen (crit)');
  const jwk = await jwks.keyFor(jwksUri, jwt.header);
  if (!verifyJws(jwt, jwk)) throw new JoseError('Signatur des ID-Tokens ist ungültig');
  checkIdTokenClaims(jwt.payload, expect);
  return jwt.payload;
}

// --- signing (Apple client secret, test doubles) ----------------------------------------------

export function signJwt(payload: Record<string, any>, privateKeyPem: string | KeyObject, header: { alg: 'ES256' | 'RS256'; kid?: string }): string {
  const h = b64url.enc(JSON.stringify({ typ: 'JWT', ...header }));
  const p = b64url.enc(JSON.stringify(payload));
  const key = typeof privateKeyPem === 'string' ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const data = Buffer.from(`${h}.${p}`);
  const sig = header.alg === 'ES256' ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) : cryptoSign('sha256', data, key);
  return `${h}.${p}.${b64url.enc(sig)}`;
}
