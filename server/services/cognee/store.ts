import type { App } from '../../core/app.js';
import { id, now } from '../../core/util.js';
import { readSettings, TYPES, type CogneeSettings, type CogneeType } from './model.js';

/** Rows of the module's own tables (migrations in modules/cognee.ts). Everything is keyed by sub-account. */

export type Cursor = Record<string, { at: string; id: string }>;

export interface StateRow {
  location_id: string;
  type: CogneeType;
  dataset_id: string;
  cursor: Cursor;
  dirty: boolean;
  phase: 'idle' | 'cognify';
  cognify_started_at: string | null;
  last_sync_at: string | null;
  last_full_at: string | null;
  last_error: string;
  last_error_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  skipped: number;
}

const parse = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function getSettings(app: App, locationId: string): CogneeSettings {
  return readSettings(app.db.get('SELECT * FROM cognee_settings WHERE location_id = ?', locationId));
}

export function saveSettings(app: App, locationId: string, s: CogneeSettings, by: string | null) {
  const at = now();
  const prev = app.db.get<{ enabled: number; enabled_at: string | null }>('SELECT enabled, enabled_at FROM cognee_settings WHERE location_id = ?', locationId);
  const enabledAt = s.enabled ? (prev?.enabled && prev.enabled_at ? prev.enabled_at : at) : (prev?.enabled_at ?? null);
  app.db.run(
    `INSERT INTO cognee_settings (location_id, enabled, types, redact, members_ask, enabled_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id) DO UPDATE SET enabled = excluded.enabled, types = excluded.types, redact = excluded.redact, members_ask = excluded.members_ask,
       enabled_at = excluded.enabled_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    locationId,
    s.enabled ? 1 : 0,
    JSON.stringify(s.types),
    JSON.stringify(s.redact),
    s.members_ask ? 1 : 0,
    enabledAt,
    by,
    at,
  );
}

export function getState(app: App, locationId: string, type: CogneeType): StateRow {
  const r = app.db.get<any>('SELECT * FROM cognee_state WHERE location_id = ? AND type = ?', locationId, type);
  return {
    location_id: locationId,
    type,
    dataset_id: r?.dataset_id ?? '',
    cursor: parse<Cursor>(r?.cursor, {}),
    dirty: !!r?.dirty,
    phase: r?.phase === 'cognify' ? 'cognify' : 'idle',
    cognify_started_at: r?.cognify_started_at ?? null,
    last_sync_at: r?.last_sync_at ?? null,
    last_full_at: r?.last_full_at ?? null,
    last_error: r?.last_error ?? '',
    last_error_at: r?.last_error_at ?? null,
    attempts: Number(r?.attempts ?? 0),
    next_attempt_at: r?.next_attempt_at ?? null,
    skipped: Number(r?.skipped ?? 0),
  };
}

/** Writes the whole state row (the caller changed what it needed on the object `getState` returned). */
export function saveState(app: App, s: StateRow) {
  app.db.run(
    `INSERT INTO cognee_state (location_id, type, dataset_id, cursor, dirty, phase, cognify_started_at, last_sync_at, last_full_at, last_error, last_error_at, attempts, next_attempt_at, skipped, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, type) DO UPDATE SET dataset_id = excluded.dataset_id, cursor = excluded.cursor, dirty = excluded.dirty, phase = excluded.phase,
       cognify_started_at = excluded.cognify_started_at, last_sync_at = excluded.last_sync_at, last_full_at = excluded.last_full_at, last_error = excluded.last_error,
       last_error_at = excluded.last_error_at, attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at, skipped = excluded.skipped, updated_at = excluded.updated_at`,
    s.location_id,
    s.type,
    s.dataset_id,
    JSON.stringify(s.cursor),
    s.dirty ? 1 : 0,
    s.phase,
    s.cognify_started_at,
    s.last_sync_at,
    s.last_full_at,
    s.last_error.slice(0, 300),
    s.last_error_at,
    s.attempts,
    s.next_attempt_at,
    s.skipped,
    now(),
  );
}

/** Looks at every record of a type again on the next cycle (unchanged texts cost nothing; changed ones – e.g. after a redaction switch – are sent again). */
export function resetCursor(app: App, locationId: string, type: CogneeType) {
  app.db.run(`UPDATE cognee_state SET cursor = '{}', last_full_at = NULL, next_attempt_at = NULL WHERE location_id = ? AND type = ?`, locationId, type);
}

export function clearState(app: App, locationId: string, type: CogneeType) {
  app.db.run('DELETE FROM cognee_state WHERE location_id = ? AND type = ?', locationId, type);
}

/** Items per type for one sub-account (grouped, one query). */
export function itemCounts(app: App, locationId: string): Record<CogneeType, number> {
  const out = Object.fromEntries(TYPES.map((t) => [t, 0])) as Record<CogneeType, number>;
  for (const r of app.db.all<{ type: CogneeType; n: number }>('SELECT type, COUNT(*) AS n FROM cognee_items WHERE location_id = ? GROUP BY type', locationId)) if (r.type in out) out[r.type] = r.n;
  return out;
}

export interface ItemRow {
  id: string;
  location_id: string;
  type: CogneeType;
  kind: string;
  record_id: string;
  parent_id: string | null;
  contact_id: string | null;
  data_id: string;
  content_hash: string;
  source_rev: string;
  chars: number;
  synced_at: string;
}

export const getItem = (app: App, locationId: string, type: CogneeType, kind: string, recordId: string) =>
  app.db.get<ItemRow>('SELECT * FROM cognee_items WHERE location_id = ? AND type = ? AND kind = ? AND record_id = ?', locationId, type, kind, recordId);

// --- deletions: a queue that survives restarts and an offline Cognee ----------------------------------------------------

export type DeletionReason = 'erasure' | 'record_deleted' | 'stale' | 'purge' | 'location_deleted';

/** Queues the removal of one data item (`dataId`) or, with an empty id, of the whole dataset. */
export function queueDeletion(app: App, o: { locationId: string; type: CogneeType; datasetId: string; dataId: string; reason: DeletionReason; afterCognify?: boolean }) {
  // The same item is not queued twice.
  if (app.db.get('SELECT 1 FROM cognee_deletions WHERE location_id = ? AND type = ? AND dataset_id = ? AND data_id = ?', o.locationId, o.type, o.datasetId, o.dataId)) {
    // …but an immediate reason wins over "after the next graph build".
    if (!o.afterCognify) app.db.run('UPDATE cognee_deletions SET after_cognify = 0, reason = ? WHERE location_id = ? AND type = ? AND dataset_id = ? AND data_id = ?', o.reason, o.locationId, o.type, o.datasetId, o.dataId);
    return;
  }
  app.db.insert('cognee_deletions', { id: id(), location_id: o.locationId, type: o.type, dataset_id: o.datasetId, data_id: o.dataId, reason: o.reason, after_cognify: o.afterCognify ? 1 : 0, attempts: 0, next_attempt_at: null, last_error: '', created_at: now() });
}

/** A replaced version that comes back (A → B → A) must not be deleted any more. */
export function cancelDeletion(app: App, locationId: string, type: CogneeType, dataId: string) {
  app.db.run(`DELETE FROM cognee_deletions WHERE location_id = ? AND type = ? AND data_id = ? AND reason = 'stale'`, locationId, type, dataId);
}

export const pendingDeletions = (app: App, locationId: string) => app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cognee_deletions WHERE location_id = ?', locationId)!.n;
