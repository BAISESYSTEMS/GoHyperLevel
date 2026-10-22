import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';

/**
 * Signed plugin bundles (Ed25519). HyperLevel signs the plugins of its catalogue; this installation checks the
 * signature against the public keys it trusts before it says "von HyperLevel signiert". A bundle without a valid
 * signature from a trusted key is installed only with a plain warning: **„ungeprüft“**. A bundle whose signature
 * does not match its content (edited after signing) is refused.
 *
 * What is signed: the canonical JSON (sorted keys) of { format, bundle_version, plugin, version, integrity } –
 * not `exported_at` and not the signature itself, so exporting again does not break it. The key pair is made
 * with `node scripts/werkstatt-sign.mjs keygen`; only the PUBLIC half ever goes into a repository
 * (services/werkstatt/trusted-keys.ts) or the settings.
 */

export interface PublicKey {
  id: string;
  label: string;
  /** base64 of the SPKI DER, or a PEM block. */
  public_key: string;
  /** Marks the keys of the HyperLevel publisher itself (the built-in list). */
  gohigh?: boolean;
}

export interface BundleSignature {
  alg: 'ed25519';
  key_id: string;
  /** base64 */
  sig: string;
}

export type SignatureState = 'signed' | 'untrusted' | 'invalid' | 'unsigned';
export interface SignatureCheck {
  state: SignatureState;
  key_id: string;
  label: string;
  gohigh: boolean;
  /** Plain German for the consent screen (empty for a valid, trusted signature). */
  warning: string;
}

const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)])) : v);
/** Canonical JSON: the same bytes on every machine whatever the key order was. */
export const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));

export interface SignableBundle {
  format: string;
  bundle_version: number;
  plugin: unknown;
  version: unknown;
  integrity: string;
  signature?: unknown;
}
export const signedBytes = (b: SignableBundle): Buffer => Buffer.from(canonical({ format: b.format, bundle_version: b.bundle_version, plugin: b.plugin, version: b.version, integrity: b.integrity }), 'utf8');

const publicKeyOf = (k: string): KeyObject | null => {
  try {
    const t = k.trim();
    return t.includes('BEGIN') ? createPublicKey(t) : createPublicKey({ key: Buffer.from(t.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
};
/** Is this a usable Ed25519 public key? */
export const isPublicKey = (k: string): boolean => publicKeyOf(k)?.asymmetricKeyType === 'ed25519';

/** A fresh key pair: public as base64 SPKI (goes into the settings), private as PKCS#8 PEM (stays with the publisher). */
export function generateKeyPair(): { public_key: string; private_key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export function signBundle<T extends SignableBundle>(bundle: T, privateKeyPem: string, keyId: string): T & { signature: BundleSignature } {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Der Schlüssel ist kein Ed25519-Schlüssel.');
  const sig = edSign(null, signedBytes(bundle), key).toString('base64');
  return { ...bundle, signature: { alg: 'ed25519', key_id: keyId, sig } };
}

const UNSIGNED: SignatureCheck = { state: 'unsigned', key_id: '', label: '', gohigh: false, warning: 'Ungeprüft: Dieses Paket ist nicht signiert – es stammt nicht nachweislich von HyperLevel. Prüfe, woher es kommt, und lies die angefragten Berechtigungen genau.' };

/** Checks the signature of a (parsed) bundle against the keys this installation trusts. Never throws. */
export function checkSignature(bundle: SignableBundle, trusted: PublicKey[]): SignatureCheck {
  const s = bundle.signature as Partial<BundleSignature> | undefined;
  if (!s || typeof s !== 'object') return UNSIGNED;
  const key_id = String(s.key_id ?? '').slice(0, 80);
  const bad = (warning: string): SignatureCheck => ({ state: 'invalid', key_id, label: '', gohigh: false, warning });
  if (s.alg !== 'ed25519' || typeof s.sig !== 'string' || !key_id) return bad('Die Signatur im Paket ist unvollständig – das Paket wird nicht installiert.');
  const sig = Buffer.from(s.sig, 'base64');
  // Only the key the bundle names is tried: a signature never "borrows" another trusted key's authority.
  const known = trusted.filter((k) => k.id === key_id);
  for (const k of known) {
    const pub = publicKeyOf(k.public_key);
    if (!pub || pub.asymmetricKeyType !== 'ed25519') continue;
    let ok = false;
    try {
      ok = edVerify(null, signedBytes(bundle), pub, sig);
    } catch {
      ok = false;
    }
    if (ok) return { state: 'signed', key_id: k.id, label: k.label, gohigh: !!k.gohigh, warning: '' };
  }
  // A signature by a key we do not know cannot be checked – "ungeprüft", not "gefälscht".
  if (!known.length) return { state: 'untrusted', key_id, label: '', gohigh: false, warning: `Ungeprüft: Das Paket ist mit dem Schlüssel „${key_id}“ signiert, dem diese Installation nicht vertraut. Es stammt nicht nachweislich von HyperLevel.` };
  return bad('Die Signatur stimmt nicht mit dem Inhalt überein – das Paket wurde nach dem Signieren verändert oder ist gefälscht. Es wird nicht installiert.');
}
