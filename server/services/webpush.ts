import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

/**
 * Web Push without dependencies: VAPID (RFC 8292, ES256 JWT) and payload encryption
 * (RFC 8291, aes128gcm content coding from RFC 8188), both on node:crypto.
 */

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url – what the browser gets as applicationServerKey. */
  publicKey: string;
  /** Private scalar d (32 bytes), base64url. */
  privateKey: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(String(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), privateKey: jwk.d };
}

function vapidKeyObject(keys: VapidKeys) {
  const pub = fromB64u(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID-Schlüssel ungültig');
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
}

/** The signed VAPID token for one push service (audience = its origin). Valid for 12 hours. */
export function vapidJwt(audience: string, subject: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000), ttlSec = 12 * 3600): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: nowSec + ttlSec, sub: subject })));
  const data = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(data), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

export function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, nowSec?: number): string {
  return `vapid t=${vapidJwt(new URL(endpoint).origin, subject, keys, nowSec)}, k=${keys.publicKey}`;
}

const RECORD_SIZE = 4096;

/**
 * Encrypts a push message for one subscription (RFC 8291). `asPrivate` and `salt` exist only so
 * the RFC test vector can be reproduced; normally both are random.
 */
export function encryptPayload(payload: string | Buffer, p256dh: string, auth: string, opts: { asPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Ungültiger Geräteschlüssel (p256dh)');
  if (authSecret.length < 16) throw new Error('Ungültiges Geräte-Geheimnis (auth)');
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plain.length + 16 > RECORD_SIZE) throw new Error('Nachricht zu lang für Web Push');

  const ecdh = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer>; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

let pushFetch: PushFetch = (url, init) => fetch(url, init);
/** Tests swap the network for a fake. */
export function setPushFetch(fn?: PushFetch) {
  pushFetch = fn ?? ((url, init) => fetch(url, init));
}

/**
 * Push services we deliver to. Subscriptions come from browsers, but the endpoint is still
 * user input – only the big push services are accepted, over https.
 */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com', 'push.api.chromium.org'];

export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((p) => h === p || h.endsWith(`.${p}`));
}

export interface PushResult {
  status: number;
  /** The subscription is gone for good (unsubscribed, expired) – delete it. */
  gone: boolean;
  error?: string;
}

export async function sendWebPush(sub: PushSubscriptionKeys, payload: string, keys: VapidKeys, subject: string, opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {}): Promise<PushResult> {
  if (!isPushEndpoint(sub.endpoint)) return { status: 0, gone: true, error: 'Unbekannter Push-Dienst' };
  const body = encryptPayload(payload, sub.p256dh, sub.auth);
  const headers: Record<string, string> = {
    authorization: vapidAuthorization(sub.endpoint, subject, keys),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(opts.ttl ?? 24 * 3600),
    urgency: opts.urgency ?? 'normal',
  };
  // A newer message with the same topic replaces an undelivered older one (max 32 url-safe chars).
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  try {
    const r = await pushFetch(sub.endpoint, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(10_000) });
    if (r.status >= 200 && r.status < 300) return { status: r.status, gone: false };
    const text = (await r.text().catch(() => '')).slice(0, 200);
    return { status: r.status, gone: r.status === 404 || r.status === 410, error: `${r.status} ${text}`.trim() };
  } catch (e) {
    return { status: 0, gone: false, error: (e as Error).message };
  }
}
