import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { id, now } from '../core/util.js';
import { listBackups, snapshotInto } from './backups.js';
import { plan, stampOf, timeOfStamp } from '../services/backup-retention.js';
import { fileHash, listSnapshots, objectKeys, offsiteConfig, ping, restoreSnapshot, uploadEncrypted, verifyDb, walkFiles, writeManifest, type Manifest, type OffsiteConfig } from '../services/backup-offsite.js';
import { S3Client } from '../services/s3-lite.js';

/**
 * Off-site encrypted backups (docs/backups.md): every PGHL_BACKUP_INTERVAL_MIN (default 60) a consistent copy of the database
 * (VACUUM INTO in a worker thread) and every new file of the upload folders go to S3-compatible storage, encrypted with
 * AES-256-GCM (PGHL_BACKUP_KEY). Retention hourly 48 / daily 14 / monthly 6 (PGHL_BACKUP_RETENTION). Once a month a restore
 * test downloads the newest snapshot into a temp folder, runs SQLite's integrity check, compares the row counts with the
 * manifest and decrypts a sample of files; a failure raises an alert (app.services.opsAlert). Without the environment the
 * module stays idle. Status and buttons: Agentur → System. The local daily snapshots (modules/backups.ts) are unaffected.
 */

const RESTORE_TEST_DAYS = 30;
const RETRY_MIN = 15;
const SAMPLE_FILES = 20;

interface Run {
  id: string;
  kind: 'backup' | 'restore_test';
  status: 'running' | 'ok' | 'failed';
  started_at: string;
  finished_at: string | null;
  stamp: string;
  bytes: number;
  files_uploaded: number;
  error: string;
  detail: string;
}

const out = (r: Run | undefined) => (r ? { ...r, detail: JSON.parse(r.detail || '{}') } : null);

export const offsiteBackupModule: Module = {
  name: 'offsite-backup',
  migrations: [
    [
      '001-init',
      `CREATE TABLE backup_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        stamp TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, files_uploaded INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX backup_runs_kind ON backup_runs(kind, started_at);
      CREATE TABLE backup_files (hash TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL, gone_at TEXT);
      CREATE INDEX backup_files_gone ON backup_files(gone_at);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const tmpDir = join(app.config.dataDir, 'offsite-tmp');
    let busy: Promise<unknown> | undefined;

    const cfg = () => offsiteConfig();
    const last = (kind: Run['kind'], status?: Run['status']) =>
      db.get<Run>(`SELECT * FROM backup_runs WHERE kind = ?${status ? ' AND status = ?' : ''} ORDER BY started_at DESC LIMIT 1`, ...(status ? [kind, status] : [kind]));
    const finish = (runId: string, patch: Partial<Run>) => {
      const p = { ...patch, finished_at: now() };
      db.run(`UPDATE backup_runs SET ${Object.keys(p).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(p), runId);
    };
    // A run that was going when the process stopped never finishes: mark it.
    db.run(`UPDATE backup_runs SET status = 'failed', error = 'Abgebrochen (Neustart)', finished_at = ? WHERE status = 'running'`, now());

    /** Uploads the files that are new since the last run and returns the manifest's file list. */
    async function syncFiles(c: OffsiteConfig, s3: S3Client): Promise<{ list: Manifest['files']; uploaded: number; bytes: number }> {
      const known = new Map(db.all<{ hash: string; gone_at: string | null }>('SELECT hash, gone_at FROM backup_files').map((r) => [r.hash, r.gone_at]));
      const seen = new Set<string>();
      const list: Manifest['files'] = [];
      const keys = objectKeys(c.prefix);
      let uploaded = 0;
      let bytes = 0;
      for await (const f of walkFiles(app.config.dataDir)) {
        const hash = fileHash(f.rel, f.size, f.mtimeMs);
        seen.add(hash);
        if (!known.has(hash)) {
          try {
            // Already compressed formats (images, video, audio, PDF, ZIP) gain nothing from gzip.
            const gzip = !/\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|m4a|mp3|ogg|opus|wav|pdf|zip|gz|br|woff2?)$/i.test(f.rel);
            bytes += await uploadEncrypted(s3, keys.file(hash), f.abs, tmpDir, c.keys[0], gzip);
            db.insert('backup_files', { hash, path: f.rel, size: f.size, uploaded_at: now(), gone_at: null });
            known.set(hash, null);
            uploaded++;
          } catch (e) {
            // A file that vanished while we read it is no failure of the backup.
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw e;
          }
        }
        list.push([f.rel, keys.file(hash), f.size]);
      }
      // Bookkeeping for the clean-up: when did a file version disappear locally?
      db.tx(() => {
        for (const [hash, gone] of known) {
          if (!seen.has(hash) && !gone) db.run('UPDATE backup_files SET gone_at = ? WHERE hash = ?', now(), hash);
          else if (seen.has(hash) && gone) db.run('UPDATE backup_files SET gone_at = NULL WHERE hash = ?', hash);
        }
      });
      return { list, uploaded, bytes };
    }

    /** Deletes snapshots outside the retention and file objects no kept snapshot needs any more. */
    async function prune(c: OffsiteConfig, s3: S3Client): Promise<{ kept: number; pruned: number; files_deleted: number }> {
      const keys = objectKeys(c.prefix);
      const snaps = await listSnapshots(s3, c);
      const p = plan(snaps.map((x) => x.stamp), c.retention);
      for (const stamp of p.prune) {
        await s3.delete(keys.db(stamp));
        await s3.delete(keys.manifest(stamp));
      }
      // A file version that disappeared before the oldest kept snapshot was taken is in no kept manifest.
      const oldest = p.keep.length ? timeOfStamp(p.keep[p.keep.length - 1]) : undefined;
      let filesDeleted = 0;
      if (oldest !== undefined) {
        for (const f of db.all<{ hash: string }>('SELECT hash FROM backup_files WHERE gone_at IS NOT NULL AND gone_at < ? LIMIT 5000', new Date(oldest).toISOString())) {
          await s3.delete(keys.file(f.hash));
          db.run('DELETE FROM backup_files WHERE hash = ?', f.hash);
          filesDeleted++;
        }
      }
      return { kept: p.keep.length, pruned: p.prune.length, files_deleted: filesDeleted };
    }

    async function backup(c: OffsiteConfig): Promise<Run> {
      const runId = id();
      let at = new Date();
      // Two runs in the same second would share a stamp (and overwrite each other's objects): the later one moves a second on.
      while (db.get(`SELECT 1 AS x FROM backup_runs WHERE kind = 'backup' AND stamp = ?`, stampOf(at))) at = new Date(at.getTime() + 1000);
      const stamp = stampOf(at);
      db.insert('backup_runs', { id: runId, kind: 'backup', status: 'running', started_at: at.toISOString(), stamp, detail: '{}' });
      rmSync(tmpDir, { recursive: true, force: true });
      const s3 = (app.services.offsiteS3 as ((c: OffsiteConfig) => S3Client) | undefined)?.(c) ?? new S3Client(c.s3);
      try {
        const files = c.files ? await syncFiles(c, s3) : { list: [], uploaded: 0, bytes: 0 };
        const snap = join(tmpDir, `snapshot-${stamp}.db`);
        mkdirSync(tmpDir, { recursive: true });
        await snapshotInto(app, snap);
        const { rows } = verifyDb(snap, true);
        const keys = objectKeys(c.prefix);
        const dbBytes = await uploadEncrypted(s3, keys.db(stamp), snap, tmpDir, c.keys[0], true);
        rmSync(snap, { force: true });
        await writeManifest(s3, c, { format: 1, stamp, created_at: at.toISOString(), instance: app.config.baseUrl, db: { key: keys.db(stamp), bytes: dbBytes }, rows, files: files.list }, tmpDir);
        const pruned = await prune(c, s3);
        finish(runId, { status: 'ok', bytes: dbBytes + files.bytes, files_uploaded: files.uploaded, detail: JSON.stringify({ rows, files: files.list.length, db_bytes: dbBytes, ...pruned }) });
        await ping(c.pingUrl, true, app.services.backupPingFetch ?? fetch);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        console.error('[offsite-backup]', msg);
        finish(runId, { status: 'failed', error: msg });
        await ping(c.pingUrl, false, app.services.backupPingFetch ?? fetch);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      return db.get<Run>('SELECT * FROM backup_runs WHERE id = ?', runId)!;
    }

    async function restoreTest(c: OffsiteConfig): Promise<Run> {
      const runId = id();
      db.insert('backup_runs', { id: runId, kind: 'restore_test', status: 'running', started_at: now(), detail: '{}' });
      const dir = join(tmpDir, `restore-test-${runId}`);
      const s3 = (app.services.offsiteS3 as ((c: OffsiteConfig) => S3Client) | undefined)?.(c) ?? new S3Client(c.s3);
      const t0 = Date.now();
      try {
        const r = await restoreSnapshot(c, { dir, sampleFiles: SAMPLE_FILES, s3 });
        const detail = JSON.stringify({ integrity: r.integrity, rows: r.rows, expected: r.expectedRows, files: r.files, files_checked: r.filesChecked, seconds: Math.round((Date.now() - t0) / 1000), problems: r.problems });
        if (r.problems.length) {
          finish(runId, { status: 'failed', stamp: r.stamp, error: r.problems.slice(0, 5).join(' · ').slice(0, 500), detail });
          app.services.opsAlert?.event({ key: 'restore_test_failed', severity: 'critical', title: 'Restore-Test fehlgeschlagen', body: `Sicherung ${r.stamp}: ${r.problems.slice(0, 5).join(' · ')}` });
        } else finish(runId, { status: 'ok', stamp: r.stamp, detail });
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        finish(runId, { status: 'failed', error: msg });
        app.services.opsAlert?.event({ key: 'restore_test_failed', severity: 'critical', title: 'Restore-Test fehlgeschlagen', body: msg });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      return db.get<Run>('SELECT * FROM backup_runs WHERE id = ?', runId)!;
    }

    /** Runs one job at a time; a second call while one runs gets the running one. */
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
      if (busy) return busy as Promise<T>;
      const p = fn().finally(() => {
        busy = undefined;
      });
      busy = p;
      return p;
    };
    const need = () => {
      const c = cfg();
      if (!c.config) throw new HttpError(400, c.error ?? 'Off-site-Backup ist nicht eingerichtet (PGHL_BACKUP_S3_* und PGHL_BACKUP_KEY, siehe docs/backups.md)');
      return c.config;
    };

    const service = {
      configured: () => !!cfg().config,
      run: () => exclusive(() => backup(need())),
      restoreTest: () => exclusive(() => restoreTest(need())),
      idle: () => busy ?? Promise.resolve(),
      /** Newest successful off-site snapshot, or undefined. */
      lastOkAt: () => last('backup', 'ok')?.started_at,
      /** What the health check needs: the age of the newest backup that counts and how old it may be. */
      age: (): { source: 'offsite' | 'local' | 'none'; at?: string; maxMinutes: number } => {
        const c = cfg().config;
        if (c) return { source: 'offsite', at: last('backup', 'ok')?.started_at, maxMinutes: Math.max(120, c.intervalMin * 2) };
        const local = listBackups(app)[0]?.at;
        return { source: local || process.env.PGHL_BACKUPS !== '0' ? 'local' : 'none', at: local, maxMinutes: 26 * 60 };
      },
    };
    app.services.offsiteBackup = service;

    app.onTick(() => {
      const c = cfg().config;
      if (!c || busy) return;
      const prev = last('backup');
      const due = !prev || Date.now() - Date.parse(prev.started_at) >= (prev.status === 'failed' ? Math.min(RETRY_MIN, c.intervalMin) : c.intervalMin) * 60_000;
      if (due) {
        void exclusive(() => backup(c));
        return;
      }
      const test = last('restore_test');
      const testDue = !test || Date.now() - Date.parse(test.started_at) >= (test.status === 'failed' ? 1 : RESTORE_TEST_DAYS) * 864e5;
      if (testDue && last('backup', 'ok')) void exclusive(() => restoreTest(c));
    });

    router.get('/api/admin/offsite-backup', 'admin', () => {
      const c = cfg();
      const k = c.config;
      return {
        configured: !!k,
        missing: c.missing,
        error: c.error ?? '',
        running: !!busy,
        target: k ? { endpoint: new URL(k.s3.endpoint).host, bucket: k.s3.bucket, prefix: k.prefix, region: k.s3.region } : null,
        key_id: k ? k.keys[0].id.toString('hex') : '',
        interval_min: k?.intervalMin ?? 60,
        retention: k?.retention ?? null,
        files: k?.files ?? false,
        ping: !!k?.pingUrl,
        last_backup: out(last('backup')),
        last_ok: out(last('backup', 'ok')),
        last_restore_test: out(last('restore_test')),
        runs: db.all<Run>('SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 20').map(out),
        files_tracked: Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM backup_files WHERE gone_at IS NULL')?.n ?? 0),
      };
    });
    router.post('/api/admin/offsite-backup/run', 'admin', () => {
      need();
      if (busy) throw new HttpError(409, 'Es läuft gerade schon eine Sicherung oder ein Restore-Test');
      void service.run();
      return { started: true };
    });
    router.post('/api/admin/offsite-backup/restore-test', 'admin', () => {
      need();
      if (busy) throw new HttpError(409, 'Es läuft gerade schon eine Sicherung oder ein Restore-Test');
      void service.restoreTest();
      return { started: true };
    });
    router.get('/api/admin/offsite-backup/snapshots', 'admin', async () => {
      const c = need();
      const s3 = (app.services.offsiteS3 as ((c: OffsiteConfig) => S3Client) | undefined)?.(c) ?? new S3Client(c.s3);
      return { snapshots: (await listSnapshots(s3, c)).slice(0, 200) };
    });
  },
};

/** For other modules and tests: the backup service of an app (undefined without the module). */
export const offsiteBackup = (app: App) => app.services.offsiteBackup as { configured(): boolean; run(): Promise<Run>; restoreTest(): Promise<Run>; idle(): Promise<unknown>; lastOkAt(): string | undefined } | undefined;
