import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Config } from './app.js';

/**
 * Secrets at rest (SMTP passwords, API tokens, OAuth tokens, 2FA secrets): AES-256-GCM.
 *
 * - `v1:<iv>:<tag>:<data>` – sealed with the legacy key derived from PGHL_SECRET (installs that never rotated).
 * - `v2:<kid>:<iv>:<tag>:<data>` – sealed with a data key (`data.key` / PGHL_DATA_KEY); `kid` names the key,
 *   so values sealed with a previous key (`data.key.previous` / PGHL_DATA_KEY_PREVIOUS) still open.
 *
 * `npm run rotate-secret` creates a new data key and re-seals every stored value (server/cli/rotate-secret.ts).
 */

type KeyConfig = Pick<Config, 'secret'> & { dataKey?: string; previousDataKeys?: string[] };

interface Ring {
  legacy: Buffer;
  current: { kid: string; key: Buffer } | null;
  byKid: Map<string, Buffer>;
}

export const kidOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);
export const legacyKey = (secret: string) => createHash('sha256').update(`${secret}:mailbox`).digest();

const hexKey = (hex: string) => {
  const k = Buffer.from(hex.trim(), 'hex');
  if (k.length !== 32) throw new Error('Datenschlüssel muss 32 Byte (64 Hex-Zeichen) lang sein');
  return k;
};

const rings = new WeakMap<object, Ring>();
function ring(cfg: KeyConfig): Ring {
  let r = rings.get(cfg);
  if (r) return r;
  const byKid = new Map<string, Buffer>();
  for (const hex of cfg.previousDataKeys ?? []) {
    const k = hexKey(hex);
    byKid.set(kidOf(k), k);
  }
  let current: Ring['current'] = null;
  if (cfg.dataKey) {
    const k = hexKey(cfg.dataKey);
    current = { kid: kidOf(k), key: k };
    byKid.set(current.kid, k);
  }
  r = { legacy: legacyKey(cfg.secret), current, byKid };
  rings.set(cfg, r);
  return r;
}

const SEALED_RE = /^(v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*|v2:[0-9a-f]{8}:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*)$/;
/** Sealed values anywhere inside a text (JSON blobs) – used by the rotation tool. */
export const SEALED_IN_TEXT = /v1:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]*|v2:[0-9a-f]{8}:[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{24}:[A-Za-z0-9+/=]*/g;

export const isSealed = (v: unknown): v is string => typeof v === 'string' && SEALED_RE.test(v);

function encrypt(key: Buffer, plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(key: Buffer, iv: string, tag: string, data: string) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

/** Seals with the current data key (v2) or, without one, the legacy key (v1). */
export function sealWith(cfg: KeyConfig, plain: string): string {
  const r = ring(cfg);
  return r.current ? `v2:${r.current.kid}:${encrypt(r.current.key, plain)}` : `v1:${encrypt(r.legacy, plain)}`;
}

/** Opens a sealed value (throws when no known key fits or the value was tampered with). */
export function openWith(cfg: KeyConfig, sealed: string): string {
  const r = ring(cfg);
  const parts = String(sealed).split(':');
  if (parts[0] === 'v2') {
    const key = r.byKid.get(parts[1]);
    if (!key) throw new Error('Unbekannter Datenschlüssel – fehlt data.key.previous?');
    return decrypt(key, parts[2], parts[3], parts[4]);
  }
  if (parts[0] === 'v1') return decrypt(r.legacy, parts[1], parts[2], parts[3]);
  throw new Error('Kein versiegelter Wert');
}

export const sealSecret = (app: { config: KeyConfig }, plain: string) => sealWith(app.config, plain);
export const openSecret = (app: { config: KeyConfig }, sealed: string) => openWith(app.config, sealed);

/** Stored values from before sealing was introduced stay readable: plain text passes through. */
export function openIfSealed(app: { config: KeyConfig }, v: unknown): string {
  if (!isSealed(v)) return typeof v === 'string' ? v : '';
  try {
    return openWith(app.config, v);
  } catch {
    return '';
  }
}

/** Keys inside a sub-account's settings JSON that hold credentials (SMTP password, SMS tokens, inbound key). */
export const SETTINGS_SECRET_KEYS = ['pass', 'password', 'authToken', 'apiKey', 'secret', 'token', 'inbound_key'];

function walk(v: any, fn: (s: string) => string): { value: any; changed: boolean } {
  let changed = false;
  const visit = (o: any): any => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(o)) {
      if (x && typeof x === 'object' && !Array.isArray(x)) out[k] = visit(x);
      else if (SETTINGS_SECRET_KEYS.includes(k) && typeof x === 'string' && x) {
        const y = fn(x);
        if (y !== x) changed = true;
        out[k] = y;
      } else out[k] = x;
    }
    return out;
  };
  return { value: visit(v), changed };
}

/** Seals every credential in a settings object that is still plain text. */
export function sealSettings(app: { config: KeyConfig }, settings: Record<string, any>) {
  return walk(settings ?? {}, (s) => (isSealed(s) ? s : sealWith(app.config, s)));
}

/** The settings with credentials opened, for code that sends mail/SMS (never for responses: maskSettings). */
export function openSettings(app: { config: KeyConfig }, settings: Record<string, any>): Record<string, any> {
  return walk(settings ?? {}, (s) => openIfSealed(app, s)).value;
}
