import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function id(len = 16): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

export const now = () => new Date().toISOString();

/**
 * Passwords: scrypt N=2^15, r=8, p=3 (OWASP's 32 MiB profile), stored as `scrypt$N$r$p$salt$hash`.
 * Hashes from before (`scrypt$salt$hash`, N=2^14, p=1) still verify and are upgraded at the next login.
 */
const SCRYPT = { N: 32768, r: 8, p: 3 };
const MAXMEM = 128 * 1024 * 1024;
const encode = (salt: Buffer, hash: Buffer, o = SCRYPT) => `scrypt$${o.N}$${o.r}$${o.p}$${salt.toString('base64')}$${hash.toString('base64')}`;

function parseHash(stored: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = String(stored ?? '').split('$');
  if (parts[0] !== 'scrypt') return null;
  if (parts.length === 3 && parts[1] && parts[2]) return { N: 16384, r: 8, p: 1, salt: Buffer.from(parts[1], 'base64'), hash: Buffer.from(parts[2], 'base64') };
  if (parts.length !== 6) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Bounds: a tampered row must not make us burn gigabytes of memory.
  if (!(N >= 1024 && N <= 1 << 20 && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return null;
  return { N, r, p, salt: Buffer.from(parts[4], 'base64'), hash: Buffer.from(parts[5], 'base64') };
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return encode(salt, scryptSync(pw, salt, 64, { ...SCRYPT, maxmem: MAXMEM }));
}

export function verifyPassword(pw: string, stored: string): boolean {
  const h = parseHash(stored);
  if (!h || !h.hash.length) return false;
  const actual = scryptSync(pw, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: MAXMEM });
  return timingSafeEqual(h.hash, actual);
}

/** True when a stored hash uses weaker parameters than today's (rehash after a successful login). */
export function needsRehash(stored: string): boolean {
  const h = parseHash(stored);
  return !h || h.N < SCRYPT.N || h.r < SCRYPT.r || h.p < SCRYPT.p;
}

// Async variants for request handlers: scrypt runs on the libuv pool instead of blocking every other request,
// and at most a few run at once so a login flood can't exhaust memory or starve DNS/file I/O.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 4) {
    if (waiting.length >= 200) throw new Error('Server ausgelastet – bitte gleich noch einmal');
    await new Promise<void>((r) => waiting.push(r));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}
const scryptAsync = (pw: string, salt: Buffer, len: number, o: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pw, salt, len, { ...o, maxmem: MAXMEM }, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPasswordAsync(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return encode(salt, await slot(() => scryptAsync(pw, salt, 64, SCRYPT)));
}

/** A hash of a random password: compared against for unknown e-mails, so timing doesn't reveal which accounts exist. */
const DUMMY = encode(randomBytes(16), randomBytes(64));
export async function verifyPasswordAsync(pw: string, stored: string | undefined | null): Promise<boolean> {
  const h = parseHash(stored ?? DUMMY) ?? parseHash(DUMMY)!;
  const actual = await slot(() => scryptAsync(pw, h.salt, h.hash.length, h));
  return !!stored && timingSafeEqual(h.hash, actual);
}

/** Constant-time comparison for tokens, keys and signatures given as text. */
export function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'seite'
  );
}

export function normalizeEmail(e: unknown): string {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

/**
 * Keeps a leading + and digits; turns a German 0-prefix into +49 when a default country code is given. The trunk 0 that is
 * often written after the country code – "+49 (0)30 1234567", "+49 0170 …" – is dropped: it is not dialled from abroad, and
 * "+490301234567" neither reached anybody nor matched the same contact stored as +49301234567.
 */
export function normalizePhone(p: unknown, defaultCc = '+49'): string {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p
    .trim()
    .replace(/^((?:\+|00)\s*\d{1,3})\s*\(\s*0\s*\)/, '$1')
    .replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0') && defaultCc) s = defaultCc + s.slice(1);
  else if (!s.startsWith('+') && s.length > 6) s = '+' + s;
  // Germany, Austria and Switzerland never keep the trunk 0 in the international form (Italy does, so this is not general).
  return s.replace(/^\+(49|43|41)0+(?=\d)/, '+$1');
}

export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function centsToMoney(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format((cents || 0) / 100);
}
