import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { HttpError, notFound } from '../core/http.js';
import { contentMatches } from '../core/files.js';
import { id, now } from '../core/util.js';
import type { Actor } from './collab-actor.js';
import { KINDS, activeLock, lockMessage, type LockRow, type OfficeKind } from './office-model.js';

/**
 * Storage of Office files: the rows (`office_files`, `office_versions` – a version is never changed, a trigger refuses it) and the
 * bytes of every version on disk under `<data>/office-files/` (names from a random id and the checked type, never from the client).
 * Size limit per file and quota per sub-account come from the environment (docs/office.md#limits).
 */

const MB = 1024 * 1024;

export interface FileRow {
  id: string;
  location_id: string;
  kind: OfficeKind;
  name: string;
  size: number;
  version: number;
  contact_id: string | null;
  deal_id: string | null;
  project_id: string | null;
  created_by: string | null;
  created_by_name: string;
  updated_by_name: string;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  file_id: string;
  location_id: string;
  version: number;
  blob: string;
  size: number;
  sha256: string;
  author_id: string | null;
  author_name: string;
  author_kind: string;
  message: string;
  restored_from: number | null;
  created_at: string;
}

const envMb = (name: string, fallback: number): number | null => {
  const raw = process.env[name];
  const mb = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return fallback * MB;
  return mb === 0 ? null : Math.round(mb * MB);
};
/** Largest file (each version) in bytes: PGHL_OFFICE_MAX_MB, default 25 MB. */
export const maxFileBytes = (): number => envMb('PGHL_OFFICE_MAX_MB', 25) ?? 25 * MB;
/** All versions of all files of a sub-account: PGHL_OFFICE_QUOTA_MB, default 2048 MB, 0 = no cap. */
export const quotaBytes = (): number | null => envMb('PGHL_OFFICE_QUOTA_MB', 2048);

export const officeDir = (app: App) => join(app.config.dataDir, 'office-files');
export const blobPath = (app: App, blob: string) => join(officeDir(app), blob.replace(/[^A-Za-z0-9._-]/g, ''));

export function usedBytes(app: App, locationId: string): number {
  return Number(app.db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM office_versions WHERE location_id = ?', locationId)?.n ?? 0);
}

/** The checks every new version passes: not empty, not too big, the bytes match the kind, the quota has room. */
export function checkBytes(app: App, locationId: string, kind: OfficeKind, buf: Buffer) {
  if (!buf.length) throw new HttpError(400, 'Die Datei ist leer');
  const max = maxFileBytes();
  if (buf.length > max) throw new HttpError(413, `Datei größer als ${Math.round(max / MB)} MB`);
  if (!contentMatches(KINDS[kind].mime, buf)) throw new HttpError(400, `Dateiinhalt passt nicht zum Dateityp (${KINDS[kind].one})`);
  const quota = quotaBytes();
  if (quota !== null && usedBytes(app, locationId) + buf.length > quota) throw new HttpError(413, `Der Office-Speicher dieses Sub-Accounts ist voll (${Math.round(quota / MB)} MB) – alte Dateien löschen oder das Limit erhöhen (PGHL_OFFICE_QUOTA_MB)`);
}

export function getFile(app: App, locationId: string, fileId: string): FileRow {
  const f = app.db.get<FileRow>('SELECT * FROM office_files WHERE id = ? AND location_id = ?', String(fileId ?? ''), locationId);
  if (!f) throw notFound('Datei nicht gefunden');
  return f;
}

export function getVersion(app: App, file: FileRow, version?: number | null): VersionRow {
  const n = version ?? file.version;
  const v = app.db.get<VersionRow>('SELECT * FROM office_versions WHERE file_id = ? AND version = ?', file.id, n);
  if (!v) throw notFound(`Version ${n} nicht gefunden`);
  return v;
}

export function readVersion(app: App, v: VersionRow): Buffer {
  try {
    return readFileSync(blobPath(app, v.blob));
  } catch {
    throw new HttpError(410, `Die Datei der Version ${v.version} fehlt auf dem Server`);
  }
}

export function lockOf(app: App, fileId: string): LockRow | null {
  return activeLock(app.db.get<LockRow>('SELECT * FROM office_locks WHERE file_id = ?', fileId));
}

/** Refuses a write while somebody else holds the edit lock (423 with who and until when). */
export function assertWritable(app: App, file: FileRow, actor: Actor) {
  const l = lockOf(app, file.id);
  if (l && (!actor.id || l.user_id !== actor.id)) throw new HttpError(423, lockMessage(l), { locked_by: l.user_name, locked_until: l.expires_at });
}

/**
 * Stores bytes as the next version of a file (or the first one of a new file) and moves the file row forward. Must run inside
 * `db.tx`; the bytes are written before the row, and removed again when the transaction fails (the caller's `catch`).
 */
export function addVersion(app: App, file: FileRow, buf: Buffer, actor: Actor, message: string, restoredFrom: number | null = null): VersionRow {
  checkBytes(app, file.location_id, file.kind, buf);
  mkdirSync(officeDir(app), { recursive: true });
  const blob = `${id(24)}.${KINDS[file.kind].ext}`;
  writeFileSync(blobPath(app, blob), buf, { mode: 0o600 });
  try {
    const at = now();
    const next = Number(app.db.get<{ n: number }>('SELECT COALESCE(MAX(version), 0) AS n FROM office_versions WHERE file_id = ?', file.id)?.n ?? 0) + 1;
    const row: VersionRow = {
      id: id(),
      file_id: file.id,
      location_id: file.location_id,
      version: next,
      blob,
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      author_id: actor.id,
      author_name: actor.name,
      author_kind: actor.kind,
      message: message.slice(0, 300),
      restored_from: restoredFrom,
      created_at: at,
    };
    app.db.insert('office_versions', row as unknown as Record<string, unknown>);
    app.db.run('UPDATE office_files SET version = ?, size = ?, updated_at = ?, updated_by_name = ? WHERE id = ?', next, buf.length, at, actor.name, file.id);
    file.version = next;
    file.size = buf.length;
    file.updated_at = at;
    file.updated_by_name = actor.name;
    return row;
  } catch (e) {
    rmSync(blobPath(app, blob), { force: true });
    throw e;
  }
}

/** Paths of every stored version of the given files (to delete them from disk after the rows are gone). */
export function blobsOf(app: App, fileIds: string[]): string[] {
  if (!fileIds.length) return [];
  const out: string[] = [];
  for (let i = 0; i < fileIds.length; i += 500) {
    const part = fileIds.slice(i, i + 500);
    out.push(...app.db.all<{ blob: string }>(`SELECT blob FROM office_versions WHERE file_id IN (${part.map(() => '?').join(',')})`, ...part).map((r) => blobPath(app, r.blob)));
  }
  return out;
}

export function removeBlobs(paths: string[]) {
  for (const p of paths) rmSync(p, { force: true });
}
