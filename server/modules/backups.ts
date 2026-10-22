import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { App, Module } from '../core/app.js';
import { notFound } from '../core/http.js';

/**
 * Daily database snapshots in <data>/backups (VACUUM INTO: consistent while the app runs),
 * keeping the newest PGHL_BACKUP_KEEP (default 14). PGHL_BACKUPS=0 turns it off.
 */

const NAME = /^pghl-\d{4}-\d{2}-\d{2}(-\d{6})?\.db$/;

export function backupDir(app: App) {
  return join(app.config.dataDir, 'backups');
}

export function listBackups(app: App) {
  const dir = backupDir(app);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => NAME.test(f))
    .map((f) => ({ name: f, size: statSync(join(dir, f)).size, at: statSync(join(dir, f)).mtime.toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Snapshots being written right now (their file does not exist yet). */
const inFlight = new Set<string>();

function target(app: App, at: Date) {
  const dir = backupDir(app);
  mkdirSync(dir, { recursive: true });
  const stamp = at.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');
  const name = `pghl-${stamp.slice(0, 10)}-${stamp.slice(11)}.db`;
  // VACUUM INTO refuses to overwrite: two snapshots in the same second (a click twice, the nightly job meeting a manual one)
  // used to end in a 500. The later one is the same moment a second later.
  if (existsSync(join(dir, name)) || inFlight.has(name)) return target(app, new Date(at.getTime() + 1000));
  return { name, file: join(dir, name) };
}

function prune(app: App) {
  const keep = Math.max(1, Number(process.env.PGHL_BACKUP_KEEP ?? 14));
  for (const old of listBackups(app).slice(keep)) rmSync(join(backupDir(app), old.name), { force: true });
}

/** Snapshot on the calling thread (tests, scripts). A big database blocks the event loop for seconds – the app uses makeBackupAsync. */
export function makeBackup(app: App, at = new Date()) {
  const { name, file } = target(app, at);
  app.db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune(app);
  return name;
}

/** Runs in a worker thread with its own read connection: WAL lets it copy a consistent snapshot while the app keeps serving. */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(workerData.db);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec("VACUUM INTO '" + workerData.out.replace(/'/g, "''") + "'");
  db.close();
  parentPort.postMessage({ ok: true });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
`;

/** A consistent copy of the database in `file`, written by a worker thread (the file must not exist yet). */
export function snapshotInto(app: App, file: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { db: app.config.dbFile, out: file } });
    w.once('message', (m: { ok: boolean; error?: string }) => (m.ok ? resolve() : reject(new Error(m.error))));
    w.once('error', reject);
    w.once('exit', (code) => code !== 0 && reject(new Error(`backup worker exited with ${code}`)));
  });
}

/** Like makeBackup, but the copy runs off the main thread, so requests keep being answered meanwhile. */
export async function makeBackupAsync(app: App, at = new Date()): Promise<string> {
  if (app.config.dbFile === ':memory:') return makeBackup(app, at);
  const { name, file } = target(app, at);
  inFlight.add(name);
  try {
    await snapshotInto(app, file);
  } finally {
    inFlight.delete(name);
  }
  prune(app);
  return name;
}

export const backupsModule: Module = {
  name: 'backups',
  register(app) {
    const { router } = app;
    let busy = false;
    app.onTick(async () => {
      if (process.env.PGHL_BACKUPS === '0' || busy) return;
      const last = listBackups(app)[0];
      if (last && Date.now() - new Date(last.at).getTime() < 24 * 3600_000) return;
      busy = true;
      try {
        console.log('[backups]', await makeBackupAsync(app));
      } catch (e) {
        console.error('[backups]', e);
      } finally {
        busy = false;
      }
    });

    router.get('/api/admin/backups', 'admin', () => ({ dir: backupDir(app), enabled: process.env.PGHL_BACKUPS !== '0', backups: listBackups(app) }));
    router.post('/api/admin/backups', 'admin', async () => ({ name: await makeBackupAsync(app) }));
    router.get('/api/admin/backups/:name', 'admin', (ctx) => {
      const name = ctx.params.name;
      if (!NAME.test(name) || !existsSync(join(backupDir(app), name))) throw notFound();
      const file = join(backupDir(app), name);
      // Streamed: a database of a few GB must not be read into memory to download it.
      return {
        __raw: true,
        status: 200,
        headers: { 'content-type': 'application/vnd.sqlite3', 'content-disposition': `attachment; filename="${name}"`, 'content-length': String(statSync(file).size) },
        body: createReadStream(file),
      };
    });
  },
};
