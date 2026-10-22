import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';

/**
 * WebAuthn (passkeys) relying-party checks with node:crypto: a small CBOR decoder, authenticator
 * data, COSE keys (ES256, RS256, EdDSA), registration ("none" attestation – the statement is not
 * trusted) and assertion verification including the signature counter.
 */

export class WebAuthnError extends Error {}

// --- CBOR (RFC 8949, definite lengths – all WebAuthn needs) ------------------------------------

export function cborDecodeFirst(buf: Buffer, start = 0, depth = 0): { value: any; end: number } {
  if (depth > 16) throw new WebAuthnError('CBOR zu tief verschachtelt');
  let pos = start;
  const need = (n: number) => {
    if (pos + n > buf.length) throw new WebAuthnError('CBOR abgeschnitten');
  };
  need(1);
  const ib = buf[pos++];
  const major = ib >> 5;
  const info = ib & 0x1f;
  const readLen = (): number => {
    if (info < 24) return info;
    if (info === 24) return need(1), buf[pos++];
    if (info === 25) return need(2), (pos += 2), buf.readUInt16BE(pos - 2);
    if (info === 26) return need(4), (pos += 4), buf.readUInt32BE(pos - 4);
    if (info === 27) {
      need(8);
      const v = buf.readBigUInt64BE(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebAuthnError('CBOR-Zahl zu groß');
      return Number(v);
    }
    throw new WebAuthnError('CBOR: unbestimmte Längen werden nicht unterstützt');
  };
  switch (major) {
    case 0:
      return { value: readLen(), end: pos };
    case 1:
      return { value: -1 - readLen(), end: pos };
    case 2: {
      const n = readLen();
      need(n);
      return { value: Buffer.from(buf.subarray(pos, pos + n)), end: pos + n };
    }
    case 3: {
      const n = readLen();
      need(n);
      return { value: buf.subarray(pos, pos + n).toString('utf8'), end: pos + n };
    }
    case 4: {
      const n = readLen();
      if (n > 10_000) throw new WebAuthnError('CBOR-Liste zu lang');
      const out: any[] = [];
      for (let i = 0; i < n; i++) {
        const r = cborDecodeFirst(buf, pos, depth + 1);
        out.push(r.value);
        pos = r.end;
      }
      return { value: out, end: pos };
    }
    case 5: {
      const n = readLen();
      if (n > 10_000) throw new WebAuthnError('CBOR-Map zu lang');
      // Keys become strings ("1", "-2", "fmt"), which is how COSE and attestation objects are read below.
      const out: Record<string, any> = Object.create(null);
      for (let i = 0; i < n; i++) {
        const k = cborDecodeFirst(buf, pos, depth + 1);
        const v = cborDecodeFirst(buf, k.end, depth + 1);
        out[String(k.value)] = v.value;
        pos = v.end;
      }
      return { value: out, end: pos };
    }
    case 6: {
      readLen();
      return cborDecodeFirst(buf, pos, depth + 1);
    }
    default: {
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22 || info === 23) return { value: null, end: pos };
      if (info === 25) return need(2), { value: decodeHalf(buf.readUInt16BE(pos)), end: pos + 2 };
      if (info === 26) return need(4), { value: buf.readFloatBE(pos), end: pos + 4 };
      if (info === 27) return need(8), { value: buf.readDoubleBE(pos), end: pos + 8 };
      throw new WebAuthnError('CBOR: unbekannter Wert');
    }
  }
}

function decodeHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export function cborDecode(buf: Buffer): any {
  const r = cborDecodeFirst(buf);
  if (r.end !== buf.length) throw new WebAuthnError('CBOR: Daten nach dem Ende');
  return r.value;
}

// --- authenticator data -----------------------------------------------------------------------

export interface AuthData {
  rpIdHash: Buffer;
  flags: { up: boolean; uv: boolean; be: boolean; bs: boolean; at: boolean; ed: boolean };
  signCount: number;
  credentialId?: Buffer;
  cosePublicKey?: Record<string, any>;
}

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new WebAuthnError('Authenticator-Daten zu kurz');
  const f = buf[32];
  const out: AuthData = {
    rpIdHash: buf.subarray(0, 32),
    flags: { up: !!(f & 0x01), uv: !!(f & 0x04), be: !!(f & 0x08), bs: !!(f & 0x10), at: !!(f & 0x40), ed: !!(f & 0x80) },
    signCount: buf.readUInt32BE(33),
  };
  if (out.flags.at) {
    if (buf.length < 55) throw new WebAuthnError('Authenticator-Daten ohne Schlüssel');
    const len = buf.readUInt16BE(53);
    if (len < 16 || len > 1023 || buf.length < 55 + len) throw new WebAuthnError('Credential-ID ungültig');
    out.credentialId = buf.subarray(55, 55 + len);
    const key = cborDecodeFirst(buf, 55 + len);
    out.cosePublicKey = key.value;
    if (!out.flags.ed && key.end !== buf.length) throw new WebAuthnError('Authenticator-Daten: unerwartete Bytes');
  }
  return out;
}

// --- COSE keys ---------------------------------------------------------------------------------

export const COSE_ALGS = [-7, -257, -8] as const;
export type CoseAlg = (typeof COSE_ALGS)[number];

/** COSE_Key → JWK (stored as JSON) + algorithm. */
export function coseToJwk(cose: Record<string, any>): { jwk: Record<string, string>; alg: CoseAlg } {
  const kty = cose['1'];
  const alg = cose['3'];
  const b = (v: unknown, len?: number) => {
    if (!Buffer.isBuffer(v) || (len !== undefined && v.length !== len)) throw new WebAuthnError('Passkey-Schlüssel unlesbar');
    return v.toString('base64url');
  };
  let jwk: Record<string, string>;
  if (kty === 2 && alg === -7) {
    if (cose['-1'] !== 1) throw new WebAuthnError('Nur P-256 wird unterstützt');
    jwk = { kty: 'EC', crv: 'P-256', x: b(cose['-2'], 32), y: b(cose['-3'], 32) };
  } else if (kty === 3 && alg === -257) {
    jwk = { kty: 'RSA', n: b(cose['-1']), e: b(cose['-2']) };
  } else if (kty === 1 && alg === -8) {
    if (cose['-1'] !== 6) throw new WebAuthnError('Nur Ed25519 wird unterstützt');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: b(cose['-2'], 32) };
  } else {
    throw new WebAuthnError('Passkey-Verfahren wird nicht unterstützt (ES256, RS256 oder EdDSA)');
  }
  const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  if (jwk.kty === 'RSA' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new WebAuthnError('RSA-Schlüssel zu kurz');
  return { jwk, alg };
}

// --- ceremonies --------------------------------------------------------------------------------

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const bufEq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

function decodeField(v: unknown, what: string): Buffer {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(v.replace(/\+/g, '-').replace(/\//g, '_'))) throw new WebAuthnError(`${what} fehlt`);
  return Buffer.from(v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function checkClientData(raw: Buffer, type: string, challenge: string, origins: string[]): ClientData {
  let c: ClientData;
  try {
    c = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON unlesbar');
  }
  if (c?.type !== type) throw new WebAuthnError('Falscher Vorgang (clientData.type)');
  const got = Buffer.from(String(c.challenge ?? ''));
  if (!bufEq(got, Buffer.from(challenge))) throw new WebAuthnError('Challenge passt nicht – bitte noch einmal versuchen');
  if (!origins.includes(String(c.origin))) throw new WebAuthnError(`Passkey von falscher Adresse (${String(c.origin).slice(0, 100)})`);
  if (c.crossOrigin === true) throw new WebAuthnError('Passkey aus eingebettetem Fenster wird nicht angenommen');
  return c;
}

export interface CredentialJSON {
  id: string;
  rawId?: string;
  type?: string;
  response: Record<string, any>;
}

export interface RegistrationResult {
  credentialId: string;
  jwk: Record<string, string>;
  alg: CoseAlg;
  signCount: number;
  uv: boolean;
  backedUp: boolean;
  transports: string[];
}

/** navigator.credentials.create() result → the credential to store. */
export function verifyRegistration(cred: CredentialJSON, o: { challenge: string; origins: string[]; rpId: string; requireUV?: boolean }): RegistrationResult {
  if (!cred || typeof cred !== 'object' || !cred.response) throw new WebAuthnError('Passkey-Antwort fehlt');
  if (cred.type !== undefined && cred.type !== 'public-key') throw new WebAuthnError('Falscher Credential-Typ');
  const clientData = decodeField(cred.response.clientDataJSON, 'clientDataJSON');
  checkClientData(clientData, 'webauthn.create', o.challenge, o.origins);
  const att = cborDecode(decodeField(cred.response.attestationObject, 'attestationObject'));
  if (!att || !Buffer.isBuffer(att.authData) || typeof att.fmt !== 'string') throw new WebAuthnError('Attestation unlesbar');
  // We ask for attestation "none": the statement is not verified (and not needed), the key is what counts.
  if (att.fmt === 'none' && att.attStmt && Object.keys(att.attStmt).length) throw new WebAuthnError('Attestation „none“ mit Inhalt');
  const ad = parseAuthData(att.authData);
  if (!bufEq(ad.rpIdHash, sha256(o.rpId))) throw new WebAuthnError('Passkey gehört zu einer anderen Domain (rpId)');
  if (!ad.flags.up) throw new WebAuthnError('Anwesenheit nicht bestätigt');
  if (o.requireUV && !ad.flags.uv) throw new WebAuthnError('Gerät hat dich nicht verifiziert (PIN/Biometrie)');
  if (!ad.flags.at || !ad.credentialId || !ad.cosePublicKey) throw new WebAuthnError('Kein Schlüssel in der Antwort');
  const credentialId = ad.credentialId.toString('base64url');
  const claimed = decodeField(cred.rawId ?? cred.id, 'Credential-ID').toString('base64url');
  if (claimed !== credentialId) throw new WebAuthnError('Credential-ID passt nicht');
  const { jwk, alg } = coseToJwk(ad.cosePublicKey);
  const transports = Array.isArray(cred.response.transports) ? cred.response.transports.filter((t: unknown) => typeof t === 'string' && /^[a-z-]{2,20}$/.test(t)).slice(0, 8) : [];
  return { credentialId, jwk, alg, signCount: ad.signCount, uv: ad.flags.uv, backedUp: ad.flags.bs, transports };
}

export interface AssertionResult {
  signCount: number;
  uv: boolean;
  backedUp: boolean;
  userHandle: string | null;
}

/** navigator.credentials.get() result, checked against the stored key. */
export function verifyAssertion(cred: CredentialJSON, o: { challenge: string; origins: string[]; rpId: string; jwk: Record<string, string>; alg: number; storedSignCount: number; requireUV?: boolean }): AssertionResult {
  if (!cred || typeof cred !== 'object' || !cred.response) throw new WebAuthnError('Passkey-Antwort fehlt');
  const clientData = decodeField(cred.response.clientDataJSON, 'clientDataJSON');
  checkClientData(clientData, 'webauthn.get', o.challenge, o.origins);
  const authDataRaw = decodeField(cred.response.authenticatorData, 'authenticatorData');
  const ad = parseAuthData(authDataRaw);
  if (!bufEq(ad.rpIdHash, sha256(o.rpId))) throw new WebAuthnError('Passkey gehört zu einer anderen Domain (rpId)');
  if (!ad.flags.up) throw new WebAuthnError('Anwesenheit nicht bestätigt');
  if (o.requireUV && !ad.flags.uv) throw new WebAuthnError('Gerät hat dich nicht verifiziert (PIN/Biometrie)');
  const sig = decodeField(cred.response.signature, 'Signatur');
  const data = Buffer.concat([authDataRaw, sha256(clientData)]);
  const key = createPublicKey({ key: o.jwk as JsonWebKey, format: 'jwk' });
  let ok = false;
  try {
    if (o.alg === -7) ok = cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, sig);
    else if (o.alg === -257) ok = cryptoVerify('sha256', data, key, sig);
    else if (o.alg === -8) ok = cryptoVerify(null, data, key, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new WebAuthnError('Passkey-Signatur ungültig');
  // A counter that doesn't grow hints at a cloned authenticator (synced passkeys always send 0).
  if ((ad.signCount !== 0 || o.storedSignCount !== 0) && ad.signCount <= o.storedSignCount) throw new WebAuthnError('Passkey-Zähler ist zurückgegangen – möglicherweise kopiert');
  const uh = cred.response.userHandle;
  return { signCount: ad.signCount, uv: ad.flags.uv, backedUp: ad.flags.bs, userHandle: typeof uh === 'string' && uh ? decodeField(uh, 'userHandle').toString('utf8') : null };
}
