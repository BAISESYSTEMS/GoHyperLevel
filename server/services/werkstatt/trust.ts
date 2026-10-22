import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { App } from '../../core/app.js';
import { loadPolicy } from './policy.js';
import { GOHIGH_PUBLIC_KEYS } from './trusted-keys.js';
import { isPublicKey, signBundle, type PublicKey, type SignableBundle } from './signing.js';

/** Which public keys this installation trusts for plugin bundles, and (optionally) its own signing key for exports. */

const envKeys = (): PublicKey[] => {
  try {
    const raw = (process.env.PGHL_PLUGIN_TRUSTED_KEYS ?? '').trim();
    const list = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).map((k: any) => ({ id: String(k?.id ?? '').slice(0, 40), label: String(k?.label ?? k?.id ?? '').slice(0, 60), public_key: String(k?.public_key ?? '') })).filter((k) => k.id && isPublicKey(k.public_key));
  } catch {
    return [];
  }
};

/** The installation's own signing key (PGHL_PLUGIN_SIGNING_KEY = PKCS#8 PEM, PGHL_PLUGIN_SIGNING_KEY_ID): signs exports, trusted by itself. */
export function ownSigner(): { id: string; privateKey: string; publicKey: PublicKey } | null {
  const pem = (process.env.PGHL_PLUGIN_SIGNING_KEY ?? '').replace(/\\n/g, '\n').trim();
  if (!pem) return null;
  try {
    const id = (process.env.PGHL_PLUGIN_SIGNING_KEY_ID ?? 'eigener-schluessel').trim().slice(0, 40) || 'eigener-schluessel';
    if (createPrivateKey(pem).asymmetricKeyType !== 'ed25519') return null;
    const pub = createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64');
    return { id, privateKey: pem, publicKey: { id, label: 'Eigener Schlüssel dieser Installation', public_key: pub } };
  } catch {
    return null;
  }
}

export function trustedKeys(app: App): PublicKey[] {
  const own = ownSigner();
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  // The built-in HyperLevel keys come first and win on the same id: nobody can impersonate them through the settings.
  for (const k of [...GOHIGH_PUBLIC_KEYS, ...envKeys(), ...loadPolicy(app).trusted_keys.map((k) => ({ ...k, gohigh: false })), ...(own ? [own.publicKey] : [])]) {
    if (seen.has(k.id)) continue;
    seen.add(k.id);
    out.push({ ...k, gohigh: GOHIGH_PUBLIC_KEYS.some((g) => g.id === k.id) });
  }
  return out;
}

/** Signs an export when the installation has its own key; otherwise the bundle stays unsigned. */
export function maybeSign<T extends SignableBundle>(bundle: T): T {
  const s = ownSigner();
  return s ? signBundle(bundle, s.privateKey, s.id) : bundle;
}
