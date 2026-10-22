#!/usr/bin/env node
/**
 * Signs and checks plugin bundles (Ed25519) – for publishers of plugin catalogues (HyperLevel itself, or you).
 *
 *   node scripts/werkstatt-sign.mjs keygen [--id gohigh-2026] [--out ./keys]       make a key pair (private key stays with you!)
 *   node scripts/werkstatt-sign.mjs sign  <bundle.json> --key <private.pem> --id <key id> [--out signed.json]
 *   node scripts/werkstatt-sign.mjs verify <bundle.json> --public <base64 or pem file> [--id <key id>]
 *
 * `keygen` prints the PUBLIC key (base64): that goes into server/services/werkstatt/trusted-keys.ts (HyperLevel) or
 * Werkstatt → Richtlinien → „Signierte Plugins“ / PGHL_PLUGIN_TRUSTED_KEYS (a self-hoster's own catalogue). The private key
 * is a PKCS#8 PEM file – never commit it. What is signed: the canonical JSON of { format, bundle_version, plugin, version,
 * integrity } (same rules as services/werkstatt/signing.ts, which checks the signature in the app).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : '';
};
const file = rest.find((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
const fail = (m) => {
  console.error(m);
  process.exit(1);
};

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)])) : v);
const bytes = (b) => Buffer.from(JSON.stringify(sortKeys({ format: b.format, bundle_version: b.bundle_version, plugin: b.plugin, version: b.version, integrity: b.integrity })), 'utf8');
const readBundle = (f) => {
  if (!f || !existsSync(f)) fail('Bundle-Datei fehlt. Aufruf: node scripts/werkstatt-sign.mjs <keygen|sign|verify> …');
  try {
    const b = JSON.parse(readFileSync(f, 'utf8'));
    if (b?.format !== 'gohigh-plugin') fail('Das ist kein Plugin-Paket (format „gohigh-plugin“ fehlt).');
    return b;
  } catch (e) {
    return fail(`Datei nicht lesbar: ${e.message}`);
  }
};

if (cmd === 'keygen') {
  const id = opt('id') || 'gohigh-key';
  const out = opt('out') || '.';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(out, { recursive: true });
  const priv = join(out, `${id}.private.pem`);
  if (existsSync(priv)) fail(`${priv} gibt es schon – aus Sicherheitsgründen wird nichts überschrieben.`);
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  try {
    chmodSync(priv, 0o600);
  } catch {
    /* not supported here */
  }
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  writeFileSync(join(out, `${id}.public.txt`), `${pub}\n`);
  console.log(`Privater Schlüssel: ${priv}  (geheim halten, nie einchecken)`);
  console.log(`Öffentlicher Schlüssel (base64):\n${pub}\n`);
  console.log(`In trusted-keys.ts:  { id: '${id}', label: '…', public_key: '${pub}', gohigh: true }`);
} else if (cmd === 'sign') {
  const b = readBundle(file);
  const keyFile = opt('key');
  const id = opt('id');
  if (!keyFile || !id) fail('Es fehlen --key <private.pem> und --id <Schlüssel-ID>.');
  const key = createPrivateKey(readFileSync(keyFile, 'utf8'));
  if (key.asymmetricKeyType !== 'ed25519') fail('Der Schlüssel ist kein Ed25519-Schlüssel.');
  const signed = { ...b, signature: { alg: 'ed25519', key_id: id, sig: sign(null, bytes(b), key).toString('base64') } };
  const out = opt('out') || file.replace(/\.json$/, '.signed.json');
  writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`);
  console.log(`Signiert mit „${id}“ → ${out}`);
} else if (cmd === 'verify') {
  const b = readBundle(file);
  const pubArg = opt('public');
  if (!pubArg) fail('Es fehlt --public <base64 oder PEM-Datei>.');
  const raw = existsSync(pubArg) ? readFileSync(pubArg, 'utf8').trim() : pubArg.trim();
  const pub = raw.includes('BEGIN') ? createPublicKey(raw) : createPublicKey({ key: Buffer.from(raw.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  const s = b.signature;
  if (!s) fail('Das Paket ist nicht signiert („ungeprüft“).');
  if (opt('id') && s.key_id !== opt('id')) fail(`Das Paket ist mit „${s.key_id}“ signiert, nicht mit „${opt('id')}“.`);
  const ok = verify(null, bytes(b), pub, Buffer.from(String(s.sig), 'base64'));
  if (!ok) fail('Die Signatur stimmt NICHT – das Paket wurde verändert oder ist gefälscht.');
  console.log(`Signatur in Ordnung (Schlüssel „${s.key_id}“).`);
} else {
  console.log('Aufruf: node scripts/werkstatt-sign.mjs keygen [--id <id>] [--out <ordner>] | sign <bundle.json> --key <private.pem> --id <id> | verify <bundle.json> --public <base64|datei>');
  process.exit(cmd ? 1 : 0);
}
