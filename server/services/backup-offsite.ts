import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupKeys, decryptFile, encryptFile, type BackupKey } from './backup-crypto.js';
import { parseRetention, type Retention } from './backup-retention.js';
import { S3Client, type S3Config } from './s3-lite.js';

/**
 * Off-site backups: the pieces both the app (modules/offsite-backup.ts) and the restore command (cli/backup-restore.ts) use –
 * the configuration from the environment, the object layout in the bucket, the manifest, walking the upload folders and
 * restoring a snapshot into a folder with its check. No App here: the restore runs while the server is stopped.
 *
 * Bucket layout (under PGHL_BACKUP_S3_PREFIX):
 *   db/<stamp>.db.gz.enc          the database (VACUUM INTO copy, gzip, AES-256-GCM)
 *   manifests/<stamp>.json.enc    what belongs to the snapshot: database object, row counts, every file with its object
 *   files/<hash>.enc              one object per file version of the upload folders (uploaded once, kept while a snapshot needs it)
 */

export interface OffsiteConfig {
  s3: S3Config;
  prefix: string;
  keys: BackupKey[];
  intervalMin: number;
  retention: Retention;
  files: boolean;
  pingUrl: string;
}

const REQUIRED = ['PGHL_BACKUP_S3_ENDPOINT', 'PGHL_BACKUP_S3_BUCKET', 'PGHL_BACKUP_S3_ACCESS_KEY', 'PGHL_BACKUP_S3_SECRET_KEY', 'PGHL_BACKUP_KEY'] as const;

/** Reads the environment. `config` is set only when everything needed is there; `error` explains a half-done setup. */
export function offsiteConfig(env: NodeJS.ProcessEnv = process.env): { config?: OffsiteConfig; missing: string[]; error?: string } {
  const missing = REQUIRED.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length === REQUIRED.length) return { missing };
  if (missing.length) return { missing, error: `Off-site-Backup unvollständig eingerichtet – es fehlt: ${missing.join(', ')}` };
  let keys: BackupKey[];
  try {
    keys = backupKeys(env);
  } catch (e) {
    return { missing: [], error: (e as Error).message };
  }
  const endpoint = String(env.PGHL_BACKUP_S3_ENDPOINT).trim();
  if (!/^https?:\/\/[^/\s]+/i.test(endpoint)) return { missing: [], error: 'PGHL_BACKUP_S3_ENDPOINT: bitte als Adresse mit https:// angeben' };
  const prefix = String(env.PGHL_BACKUP_S3_PREFIX ?? '').trim().replace(/^\/+/, '');
  const interval = Number(env.PGHL_BACKUP_INTERVAL_MIN ?? 60);
  return {
    missing: [],
    config: {
      s3: {
        endpoint,
        bucket: String(env.PGHL_BACKUP_S3_BUCKET).trim(),
        region: String(env.PGHL_BACKUP_S3_REGION ?? '').trim() || 'us-east-1',
        accessKey: String(env.PGHL_BACKUP_S3_ACCESS_KEY).trim(),
        secretKey: String(env.PGHL_BACKUP_S3_SECRET_KEY).trim(),
        pathStyle: env.PGHL_BACKUP_S3_PATH_STYLE !== '0',
      },
      prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
      keys,
      intervalMin: Number.isFinite(interval) && interval >= 5 ? Math.min(interval, 24 * 60) : 60,
      retention: parseRetention(env.PGHL_BACKUP_RETENTION),
      files: env.PGHL_BACKUP_FILES !== '0',
      pingUrl: String(env.PGHL_BACKUP_PING_URL ?? '').trim(),
    },
  };
}

export const objectKeys = (prefix: string) => ({
  db: (stamp: string) => `${prefix}db/${stamp}.db.gz.enc`,
  manifest: (stamp: string) => `${prefix}manifests/${stamp}.json.enc`,
  file: (hash: string) => `${prefix}files/${hash}.enc`,
  dbPrefix: `${prefix}db/`,
  stampOf: (key: string) => /([0-9T:-]+Z)\.db\.gz\.enc$/.exec(key)?.[1],
});

export interface Manifest {
  format: 1;
  stamp: string;
  created_at: string;
  instance: string;
  db: { key: string; bytes: number };
  rows: Record<string, number>;
  /** [relative path (forward slashes), object key, size] */
  files: [string, string, number][];
}

/** One object per version of a file: path, size and modification time decide; the name says nothing about the content. */
export const fileHash = (rel: string, size: number, mtimeMs: number) => createHash('sha256').update(`${rel}\0${size}\0${Math.floor(mtimeMs)}`).digest('hex');

/** Top-level folders of the data folder that are no upload folders: backups, our own temp folders, restores. */
const SKIP_TOP = /^(backups|offsite-tmp|restore-.*|tmp|\.tmp)$/;

/** Every file in the upload folders (all sub-folders of the data folder but backups and temp; never the database or the keys at the top). */
export async function* walkFiles(dataDir: string): AsyncGenerator<{ rel: string; abs: string; size: number; mtimeMs: number }> {
  const top = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const stack = top.filter((d) => d.isDirectory() && !SKIP_TOP.test(d.name)).map((d) => join(dataDir, d.name));
  let n = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) {
        const s = await stat(abs).catch(() => undefined);
        if (!s) continue;
        yield { rel: relative(dataDir, abs).split(sep).join('/'), abs, size: s.size, mtimeMs: s.mtimeMs };
        // Let requests through now and then on a big tree.
        if (++n % 200 === 0) await new Promise<void>((r) => setImmediate(r));
      }
    }
  }
}

/** Tables counted at backup time and compared by the restore test. */
export const COUNTED = ['locations', 'users', 'contacts', 'opportunities', 'messages', 'conversations', 'tasks', 'invoices', 'appointments', 'funnels'];

/** Integrity and row counts of a database file (opened read-only). */
export function verifyDb(file: string, quick = false): { integrity: string; rows: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = String((db.prepare(quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check').get() as Record<string, unknown> | undefined)?.[quick ? 'quick_check' : 'integrity_check'] ?? '');
    const rows: Record<string, number> = {};
    for (const t of COUNTED) {
      try {
        rows[t] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n);
      } catch {
        /* a table of a module that is not installed */
      }
    }
    return { integrity, rows };
  } finally {
    db.close();
  }
}

/** Encrypts and uploads one local file; returns the bytes sent. */
export async function uploadEncrypted(s3: S3Client, key: string, src: string, tmpDir: string, k: BackupKey, gzip: boolean): Promise<number> {
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${createHash('sha1').update(key).digest('hex')}.enc`);
  try {
    const { bytes, sha256 } = await encryptFile(src, tmp, k, { gzip });
    await s3.putFile(key, tmp, bytes, sha256);
    return bytes;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Downloads and decrypts one object into `dst`. */
export async function downloadDecrypted(s3: S3Client, key: string, dst: string, keys: BackupKey[]): Promise<void> {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.download`;
  try {
    await s3.getToFile(key, tmp);
    await decryptFile(tmp, dst, keys);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function readManifest(s3: S3Client, cfg: OffsiteConfig, stamp: string, tmpDir: string): Promise<Manifest> {
  const out = join(tmpDir, `manifest-${stamp}.json`);
  await downloadDecrypted(s3, objectKeys(cfg.prefix).manifest(stamp), out, cfg.keys);
  try {
    return JSON.parse(readFileSync(out, 'utf8')) as Manifest;
  } finally {
    rmSync(out, { force: true });
  }
}

export async function writeManifest(s3: S3Client, cfg: OffsiteConfig, m: Manifest, tmpDir: string): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  const plain = join(tmpDir, `manifest-${m.stamp}.json`);
  writeFileSync(plain, JSON.stringify(m), { mode: 0o600 });
  try {
    await uploadEncrypted(s3, objectKeys(cfg.prefix).manifest(m.stamp), plain, tmpDir, cfg.keys[0], true);
  } finally {
    rmSync(plain, { force: true });
  }
}

/** Snapshots in the bucket, newest first. */
export async function listSnapshots(s3: S3Client, cfg: OffsiteConfig): Promise<{ stamp: string; key: string; size: number }[]> {
  const k = objectKeys(cfg.prefix);
  return (await s3.list(k.dbPrefix))
    .map((o) => ({ stamp: k.stampOf(o.key) ?? '', key: o.key, size: o.size }))
    .filter((o) => o.stamp)
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

export interface RestoreResult {
  stamp: string;
  dir: string;
  dbFile: string;
  integrity: string;
  rows: Record<string, number>;
  expectedRows?: Record<string, number>;
  rowsMatch?: boolean;
  files: number;
  filesChecked: number;
  problems: string[];
}

/**
 * Restores a snapshot from the bucket into `dir` (`pghl.db` plus, with `files`, the upload folders) and checks it: SQLite's
 * integrity check, the row counts against the manifest, and every restored file's size. `sampleFiles` restores only that many
 * files (the monthly restore test); `files: false` only the database.
 */
export async function restoreSnapshot(cfg: OffsiteConfig, o: { stamp?: string; dir: string; files?: boolean; sampleFiles?: number; s3?: S3Client }): Promise<RestoreResult> {
  const s3 = o.s3 ?? new S3Client(cfg.s3);
  const stamp = o.stamp && o.stamp !== 'latest' ? o.stamp : (await listSnapshots(s3, cfg))[0]?.stamp;
  if (!stamp) throw new Error('Im Bucket liegt noch keine Sicherung');
  mkdirSync(o.dir, { recursive: true });
  const problems: string[] = [];
  let manifest: Manifest | undefined;
  try {
    manifest = await readManifest(s3, cfg, stamp, o.dir);
  } catch (e) {
    problems.push(`Manifest fehlt oder ist unlesbar: ${(e as Error).message}`);
  }
  const dbFile = join(o.dir, 'pghl.db');
  rmSync(dbFile, { force: true });
  await downloadDecrypted(s3, manifest?.db.key ?? objectKeys(cfg.prefix).db(stamp), dbFile, cfg.keys);
  const { integrity, rows } = verifyDb(dbFile);
  if (integrity !== 'ok') problems.push(`integrity_check: ${integrity.slice(0, 300)}`);
  let rowsMatch: boolean | undefined;
  if (manifest) {
    const diff = Object.entries(manifest.rows).filter(([t, n]) => rows[t] !== n);
    rowsMatch = diff.length === 0;
    if (!rowsMatch) problems.push(`Zeilen stimmen nicht: ${diff.map(([t, n]) => `${t} ${rows[t] ?? '–'} statt ${n}`).join(', ')}`);
  }
  let filesChecked = 0;
  const list = manifest?.files ?? [];
  const wanted = o.files ? list : o.sampleFiles ? pickSample(list, o.sampleFiles) : [];
  for (const [rel, key, size] of wanted) {
    if (rel.split('/').some((p) => p === '..' || p === '')) {
      problems.push(`Ungültiger Pfad im Manifest: ${rel}`);
      continue;
    }
    const dst = join(o.dir, ...rel.split('/'));
    try {
      await downloadDecrypted(s3, key, dst, cfg.keys);
      const got = (await stat(dst)).size;
      if (got !== size) problems.push(`${rel}: ${got} statt ${size} Bytes`);
      filesChecked++;
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
    if (!o.files) rmSync(dst, { force: true });
  }
  return { stamp, dir: o.dir, dbFile, integrity, rows, expectedRows: manifest?.rows, rowsMatch, files: list.length, filesChecked, problems };
}

function pickSample<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  const out: T[] = [];
  const step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/** healthchecks.io-style ping: GET <url> on success, <url>/fail on failure. Never throws. */
export async function ping(url: string, ok: boolean, fetcher: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  try {
    await fetcher(ok ? url : `${url.replace(/\/$/, '')}/fail`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  } catch {
    /* the monitor notices the missing ping itself */
  }
}
