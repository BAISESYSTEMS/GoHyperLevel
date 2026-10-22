/**
 * Restores an off-site backup (docs/backups.md):
 *
 *   npm run backup:restore -- --list                         # snapshots in the bucket, newest first
 *   npm run backup:restore -- latest                         # newest snapshot → <data>/restore-<stamp>/pghl.db, checked
 *   npm run backup:restore -- 2026-10-10T14-00-00Z --files   # that snapshot with all upload folders
 *   npm run backup:restore -- ./pghl-….db.gz.enc --to /srv/restore   # a downloaded, encrypted file
 *
 * In Docker: docker compose run --rm gohigh node dist-server/server/cli/backup-restore.js latest --files
 * Needs PGHL_BACKUP_KEY (and the PGHL_BACKUP_S3_* settings for the bucket). It never touches the running database: the result
 * lands in a folder of its own, checked with SQLite's integrity_check and the row counts of the manifest; the output says how to
 * switch over. Exit code 1 when the check fails.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backupKeys, decryptFile, readHeader } from '../services/backup-crypto.js';
import { listSnapshots, offsiteConfig, restoreSnapshot, verifyDb } from '../services/backup-offsite.js';
import { stampOf } from '../services/backup-retention.js';
import { S3Client } from '../services/s3-lite.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--to');
const dataDir = resolve(process.env.PGHL_DATA_DIR ?? './data');

function fail(msg: string): never {
  console.error(`Fehler: ${msg}`);
  process.exit(1);
}

async function main() {
  const c = offsiteConfig();
  if (flag('--list')) {
    if (!c.config) fail(c.error ?? 'Off-site-Backup ist nicht eingerichtet (PGHL_BACKUP_S3_* und PGHL_BACKUP_KEY)');
    const list = await listSnapshots(new S3Client(c.config.s3), c.config);
    if (!list.length) console.log('Keine Sicherungen im Bucket.');
    for (const s of list) console.log(`${s.stamp}  ${(s.size / 1024 / 1024).toFixed(1)} MB`);
    return;
  }
  if (!target) fail('Was soll wiederhergestellt werden? latest, ein Zeitstempel (--list zeigt sie) oder eine .enc-Datei');

  // A local encrypted file (downloaded from the bucket by hand): only the database.
  if (existsSync(target)) {
    const head = await readHeader(target);
    if (!head.ok) fail(`${target} ist keine verschlüsselte Sicherung von HyperLevel`);
    const dir = resolve(value('--to') ?? join(dataDir, `restore-${stampOf(new Date())}`));
    mkdirSync(dir, { recursive: true });
    const dbFile = join(dir, 'pghl.db');
    rmSync(dbFile, { force: true });
    await decryptFile(target, dbFile, backupKeys());
    const v = verifyDb(dbFile);
    report({ dir, dbFile, integrity: v.integrity, rows: v.rows, problems: v.integrity === 'ok' ? [] : [`integrity_check: ${v.integrity}`] });
    return;
  }

  if (!c.config) fail(c.error ?? 'Off-site-Backup ist nicht eingerichtet (PGHL_BACKUP_S3_* und PGHL_BACKUP_KEY)');
  const stamp = target === 'latest' ? undefined : target;
  if (stamp && !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(stamp)) fail(`Unbekannter Zeitstempel ${stamp} – Format 2026-10-10T14-00-00Z (--list zeigt alle)`);
  const dir = resolve(value('--to') ?? join(dataDir, `restore-${stamp ?? 'latest'}`));
  console.log(`Stelle ${stamp ?? 'die neueste Sicherung'} nach ${dir} wieder her${flag('--files') ? ' (mit Dateien)' : ''} …`);
  const r = await restoreSnapshot(c.config, { stamp, dir, files: flag('--files') });
  console.log(`Sicherung ${r.stamp}: ${r.files} Dateien im Manifest${flag('--files') ? `, ${r.filesChecked} wiederhergestellt` : ''}`);
  report({ dir, dbFile: r.dbFile, integrity: r.integrity, rows: r.rows, problems: r.problems });
}

function report(r: { dir: string; dbFile: string; integrity: string; rows: Record<string, number>; problems: string[] }) {
  console.log(`integrity_check: ${r.integrity}`);
  console.log(`Zeilen: ${Object.entries(r.rows).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  if (r.problems.length) {
    console.error(`\nProbleme:\n  ${r.problems.slice(0, 30).join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nGeprüft und bereit: ${r.dbFile}
So stellst du um (docs/backups.md#restore):
  1. App stoppen (docker compose stop gohigh).
  2. Die alte Datenbank beiseitelegen: pghl.db, pghl.db-wal und pghl.db-shm im Datenordner umbenennen.
  3. ${r.dbFile} als pghl.db in den Datenordner legen${existsSync(join(r.dir, 'uploads')) ? `, die Ordner aus ${r.dir} daneben` : ''} (oder PGHL_DATA_DIR auf ${r.dir} setzen).
  4. data/secret und data/data.key aus deiner getrennten Sicherung zurücklegen, falls der Server neu ist.
  5. App starten, /healthz prüfen.`);
}

main().catch((e) => fail((e as Error).message));
