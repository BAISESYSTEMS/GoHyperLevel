import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Time-based one-time passwords (RFC 6238, as used by Google Authenticator, Authy, 1Password…). */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Ungültiges Base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: string, at = Date.now(), step = 30): string {
  return hotp(secret, Math.floor(at / 1000 / step));
}

/** Accepts the current code and one step either side (clock drift). Returns the matched counter. */
export function verifyTotp(secret: string, code: string, at = Date.now(), step = 30): number | null {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = Math.floor(at / 1000 / step);
  for (const d of [0, -1, 1]) {
    const want = Buffer.from(hotp(secret, now + d));
    if (timingSafeEqual(want, Buffer.from(c))) return now + d;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
