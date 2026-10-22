import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * Encryption of off-site backups: AES-256-GCM with a key from the environment (PGHL_BACKUP_KEY, 32 bytes as hex or base64),
 * streamed so a database of several GB never sits in memory. File layout:
 *
 *   "PGHLENC1" (8) · key id (8) · IV (12) · flags (1, bit 0 = gzip) · ciphertext · GCM tag (16)
 *
 * The 29-byte header is the additional authenticated data, so nobody can flip the gzip flag or swap the key id unnoticed.
 * The key id (first 8 bytes of a SHA-256 of the key) lets a restore say "wrong key" instead of "corrupt file" and pick the
 * right one of several keys (PGHL_BACKUP_KEY_PREVIOUS after a rotation). Keys never leave the process.
 */

const MAGIC = Buffer.from('PGHLENC1');
const HEADER = 29;
const TAG = 16;

export interface BackupKey {
  key: Buffer;
  id: Buffer;
}

/** "0123…" (64 hex) or base64 of 32 bytes → the key; throws a German message for anything else. */
export function parseBackupKey(raw: string): BackupKey {
  const s = raw.trim();
  let key: Buffer | undefined;
  if (/^[0-9a-f]{64}$/i.test(s)) key = Buffer.from(s, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) key = b;
  }
  if (!key) throw new Error('PGHL_BACKUP_KEY muss 32 Bytes haben – als 64 Hex-Zeichen (openssl rand -hex 32) oder Base64');
  return { key, id: keyId(key) };
}

export const keyId = (key: Buffer) => createHash('sha256').update('pghl-backup-key-id').update(key).digest().subarray(0, 8);

/** The current key first, then earlier ones (only for reading). */
export function backupKeys(env: NodeJS.ProcessEnv = process.env): BackupKey[] {
  const list = [env.PGHL_BACKUP_KEY ?? '', ...(env.PGHL_BACKUP_KEY_PREVIOUS ?? '').split(',')].map((k) => k.trim()).filter(Boolean);
  return list.map(parseBackupKey);
}

/** Encrypts `src` into `dst` (gzip first when asked). Returns the size and SHA-256 of what was written – the upload signs that hash. */
export async function encryptFile(src: string, dst: string, key: BackupKey, o: { gzip?: boolean } = {}): Promise<{ bytes: number; sha256: string }> {
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, key.id, iv, Buffer.from([o.gzip ? 1 : 0])]);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(header);
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = (b: Buffer) => {
    hash.update(b);
    bytes += b.length;
    return b;
  };
  let started = false;
  const start = (t: Transform) => {
    if (started) return;
    started = true;
    t.push(tap(header));
  };
  const framer = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      start(this);
      const c = cipher.update(chunk);
      if (c.length) this.push(tap(c));
      cb();
    },
    flush(cb) {
      start(this);
      const f = cipher.final();
      if (f.length) this.push(tap(f));
      this.push(tap(cipher.getAuthTag()));
      cb();
    },
  });
  try {
    if (o.gzip) await pipeline(createReadStream(src), createGzip({ level: 6 }), framer, createWriteStream(dst, { mode: 0o600 }));
    else await pipeline(createReadStream(src), framer, createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    rmSync(dst, { force: true });
    throw e;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** Reads the header of an encrypted file: whether it is one of ours, which key it needs, whether it is gzipped. */
export async function readHeader(file: string): Promise<{ ok: boolean; keyId: string; gzip: boolean; size: number }> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(HEADER);
    await fh.read(head, 0, HEADER, 0);
    const ok = size >= HEADER + TAG && head.subarray(0, 8).equals(MAGIC);
    return { ok, keyId: head.subarray(8, 16).toString('hex'), gzip: (head[28] & 1) === 1, size };
  } finally {
    await fh.close();
  }
}

/** Decrypts `src` into `dst` with whichever of `keys` it was written with; a wrong key or a changed byte throws and leaves no `dst`. */
export async function decryptFile(src: string, dst: string, keys: BackupKey[]): Promise<void> {
  const fh = await open(src, 'r');
  let header: Buffer;
  let tag: Buffer;
  let size: number;
  try {
    size = (await fh.stat()).size;
    header = Buffer.alloc(HEADER);
    tag = Buffer.alloc(TAG);
    await fh.read(header, 0, HEADER, 0);
    if (size < HEADER + TAG || !header.subarray(0, 8).equals(MAGIC)) throw new Error('Keine verschlüsselte Sicherung von HyperLevel (Kennung fehlt)');
    await fh.read(tag, 0, TAG, size - TAG);
  } finally {
    await fh.close();
  }
  const id = header.subarray(8, 16);
  const key = keys.find((k) => k.id.equals(id));
  if (!key) throw new Error(`Diese Sicherung braucht einen anderen Schlüssel (Key-ID ${id.toString('hex')}) – PGHL_BACKUP_KEY bzw. PGHL_BACKUP_KEY_PREVIOUS prüfen`);
  const decipher = createDecipheriv('aes-256-gcm', key.key, header.subarray(16, 28));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const gzip = (header[28] & 1) === 1;
  try {
    // The tag is checked at the very end: a changed byte anywhere makes final() throw, and the half-written file is removed.
    const body = createReadStream(src, { start: HEADER, end: size - TAG - 1 });
    if (gzip) await pipeline(body, decipher, createGunzip(), createWriteStream(dst, { mode: 0o600 }));
    else await pipeline(body, decipher, createWriteStream(dst, { mode: 0o600 }));
  } catch (e) {
    rmSync(dst, { force: true });
    const msg = (e as Error).message;
    throw new Error(/authenticate|bad decrypt/i.test(msg) ? 'Die Sicherung ist beschädigt oder wurde verändert (Prüfsumme stimmt nicht)' : msg);
  }
}

/** SHA-256 (hex) of a file, streamed. */
export async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
