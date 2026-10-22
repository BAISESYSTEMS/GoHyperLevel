import type { PublicKey } from './signing.js';

/**
 * The public keys of the HyperLevel plugin publisher: bundles signed with one of them show "von HyperLevel signiert".
 * Public keys only – never a private key. The maintainers make the pair with
 * `node scripts/werkstatt-sign.mjs keygen --id gohigh-2026` and add the public half here:
 *
 *   { id: 'gohigh-2026', label: 'HyperLevel', public_key: '<base64 SPKI printed by keygen>', gohigh: true },
 *
 * Until a key is listed, no bundle counts as HyperLevel-signed (everything is "ungeprüft"). A self-hoster who runs
 * their own catalogue adds their keys without touching the code: PGHL_PLUGIN_TRUSTED_KEYS (JSON) or the policy.
 */
export const GOHIGH_PUBLIC_KEYS: PublicKey[] = [];
