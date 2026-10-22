import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SEALED_IN_TEXT, kidOf, openWith, sealWith } from '../core/secrets.js';

/**
 * Re-seals every stored secret with a new data key (used by `npm run rotate-secret`).
 * Sealed values are found by their format in every text column (also inside JSON blobs), opened with the
 * old keys and sealed again – all in one transaction. The new key is written to data.key.next first and only
 * becomes data.key after the commit, so a crash in between never leaves values nobody can open
 * (config.ts also reads data.key.next as a fallback key).
 */

export interface RotateOptions {
  dataDir: string;
  dbFile: string;
  secret: string;
  dataKey?: string;
  previousDataKeys?: string[];
  /** Hex key to switch to (default: a new random one). */
  newKey?: string;
  dryRun?: boolean;
  /** Keys come from the environment (PGHL_DATA_KEY): nothing is written to disk, the new key is printed. */
  keysFromEnv?: boolean;
}

export interface RotateResult {
  values: number;
  rows: number;
  tables: string[];
  failed: string[];
  newKey: string;
  kid: string;
  wroteKeyFile: boolean;
}

export function rotateDataKey(o: RotateOptions): RotateResult {
  const newKey = (o.newKey ?? randomBytes(32).toString('hex')).trim();
  if (!/^[0-9a-f]{64}$/i.test(newKey)) throw new Error('Neuer Schlüssel: 64 Hex-Zeichen erwartet');
  const oldCfg = { secret: o.secret, dataKey: o.dataKey, previousDataKeys: o.previousDataKeys ?? [] };
  const newCfg = { secret: o.secret, dataKey: newKey, previousDataKeys: [] };
  const db = new DatabaseSync(o.dbFile);
  db.exec('PRAGMA busy_timeout = 10000');
  const result: RotateResult = { values: 0, rows: 0, tables: [], failed: [], newKey, kid: kidOf(Buffer.from(newKey, 'hex')), wroteKeyFile: false };
  const updates: { table: string; col: string; rowid: number; value: string }[] = [];
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    for (const { name: t } of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`).all() as { name: string; type: string }[]).filter((c) => !c.type || /TEXT|CHAR|CLOB/i.test(c.type));
      for (const { name: c } of cols) {
        const q = `SELECT rowid AS r, "${c.replace(/"/g, '""')}" AS v FROM "${t.replace(/"/g, '""')}" WHERE "${c.replace(/"/g, '""')}" LIKE '%v1:%' OR "${c.replace(/"/g, '""')}" LIKE '%v2:%'`;
        let rows: { r: number; v: unknown }[];
        try {
          rows = db.prepare(q).all() as { r: number; v: unknown }[];
        } catch {
          continue; // WITHOUT ROWID tables or virtual tables: nothing sealed lives there
        }
        for (const row of rows) {
          if (typeof row.v !== 'string') continue;
          let n = 0;
          const next = row.v.replace(SEALED_IN_TEXT, (m) => {
            try {
              const plain = openWith(oldCfg, m);
              n++;
              return sealWith(newCfg, plain);
            } catch {
              result.failed.push(`${t}.${c} (rowid ${row.r})`);
              return m;
            }
          });
          if (n) {
            updates.push({ table: t, col: c, rowid: row.r, value: next });
            result.values += n;
            if (!result.tables.includes(t)) result.tables.push(t);
          }
        }
      }
    }
    result.rows = updates.length;
    if (o.dryRun || result.failed.length) return result;

    const nextFile = join(o.dataDir, 'data.key.next');
    if (!o.keysFromEnv) writeFileSync(nextFile, `${newKey}\n`, { mode: 0o600 });
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const u of updates) db.prepare(`UPDATE "${u.table.replace(/"/g, '""')}" SET "${u.col.replace(/"/g, '""')}" = ? WHERE rowid = ?`).run(u.value, u.rowid);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (!o.keysFromEnv) rmSync(nextFile, { force: true });
      throw e;
    }
    if (!o.keysFromEnv) {
      const keyFile = join(o.dataDir, 'data.key');
      // The old key stays as a fallback (backups taken before the rotation still open).
      if (o.dataKey) appendFileSync(join(o.dataDir, 'data.key.previous'), `${o.dataKey}\n`, { mode: 0o600 });
      renameSync(nextFile, keyFile);
      result.wroteKeyFile = true;
    }
    return result;
  } finally {
    db.close();
  }
}

/** A new signing secret (data/secret); old unsubscribe, survey and tracking links stop working. */
export function rotateSigningSecret(dataDir: string): { file: string; backup: string } {
  const file = join(dataDir, 'secret');
  const backup = join(dataDir, `secret.old-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (existsSync(file)) writeFileSync(backup, readFileSync(file), { mode: 0o600 });
  writeFileSync(`${file}.next`, randomBytes(32).toString('hex'), { mode: 0o600 });
  renameSync(`${file}.next`, file);
  return { file, backup };
}
