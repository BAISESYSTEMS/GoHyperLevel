import { createHash } from 'node:crypto';
import type { App } from '../../core/app.js';
import { id, now } from '../../core/util.js';
import { CogneeError, type LocationClient } from './client.js';
import { accountFor, type Account } from './connection.js';
import { activeTypes, CATALOG, TYPES, type CogneeSettings, type CogneeType, type OwnedDataset } from './model.js';
import { addCounts, NO_REDACTION, redact, type RedactCounts } from './redact.js';
import { documentText, kindOf, kindsOf, type Row } from './sources.js';
import { cancelDeletion, getItem, getSettings, getState, queueDeletion, saveState, type DeletionReason, type StateRow } from './store.js';

/**
 * The sync engine. One cycle per sub-account does a bounded amount of work and keeps its place in the database, so a restart,
 * an offline Cognee or a rate limit only delays it:
 *
 *   1. records changed since the cursor become documents (redacted if asked) and are `add`ed – unchanged texts are skipped
 *      by hash; a changed record gets a new Cognee data item and the old version is queued for deletion after the next build;
 *   2. when anything was added, one `cognify` run is started in the background and polled on the following cycles;
 *   3. records that were deleted, trashed or made private are removed (queue), and the queue is worked off with backoff.
 *
 * Failures back off 1, 2, 4 … 60 minutes (a 429 waits at least its Retry-After). Nothing here runs inside a request.
 */

const BATCH = 20;
const CYCLE_BUDGET_MS = 45_000;
const COGNIFY_TIMEOUT_MS = 60 * 60_000;
const FULL_RESCAN_MS = 7 * 864e5;
const MAX_BACKOFF_MS = 60 * 60_000;
/** After this many failed attempts a queued deletion keeps retrying only once a day (and shows up as an error). */
const DELETION_FAST_TRIES = 10;

const clock = (app: App): number => (typeof app.services.cogneeNow === 'function' ? app.services.cogneeNow() : Date.now());
const iso = (ms: number) => new Date(ms).toISOString();
export const backoffMs = (attempts: number) => Math.min(60_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface TypeReport {
  type: CogneeType;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  redacted: RedactCounts;
  /** More work is waiting (a full batch, a graph build in progress). */
  more: boolean;
  waiting?: boolean;
  error?: string;
}

export interface CycleReport {
  locationId: string;
  skipped?: 'no_connection' | 'open_server';
  types: TypeReport[];
  deleted: number;
  more: boolean;
}

const audit = (app: App, locationId: string, action: string, summary: string) => app.services.audit?.({ action, locationId, actor: 'Wissensgedächtnis', summary: summary.slice(0, 400) });

const WHY: Record<DeletionReason, string> = {
  erasure: 'DSGVO-Löschung',
  record_deleted: 'Datensatz gelöscht',
  stale: 'alte Fassung ersetzt',
  purge: 'auf Wunsch gelöscht',
  location_deleted: 'Sub-Account gelöscht',
};

// --- one type ---------------------------------------------------------------------------------------------------------------

/** Rows after the cursor across the kinds of a type, oldest first. */
function nextRows(app: App, loc: string, type: CogneeType, st: StateRow, limit: number): { kind: string; row: Row }[] {
  const out: { kind: string; row: Row }[] = [];
  for (const k of kindsOf(type)) {
    const cur = st.cursor[k.key] ?? { at: '', id: '' };
    for (const row of k.next(app, loc, cur, limit)) out.push({ kind: k.key, row });
  }
  return out.sort((a, b) => (a.row.at < b.row.at ? -1 : a.row.at > b.row.at ? 1 : a.row.rid < b.row.rid ? -1 : 1)).slice(0, limit);
}

/** Removes the mapping of a record and queues its data item for deletion (one transaction). */
export function dropItem(app: App, it: { id: string; location_id: string; type: CogneeType; data_id: string }, datasetId: string, reason: DeletionReason) {
  app.db.tx(() => {
    if (datasetId) queueDeletion(app, { locationId: it.location_id, type: it.type, datasetId, dataId: it.data_id, reason });
    app.db.run('DELETE FROM cognee_items WHERE id = ?', it.id);
  });
}

/** Background cycles look for vanished records at most this often per sub-account and type (a questions or a deletion event always do). */
const RECONCILE_EVERY_MS = 5 * 60_000;
const lastReconcile = new Map<string, number>();
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/** Mapped records that do not exist (or are not shared) any more: queued for deletion. No network – safe to run any time. */
export function reconcile(app: App, locationId: string, type: CogneeType): number {
  lastReconcile.set(`${locationId}:${type}`, clock(app));
  const datasetId = getState(app, locationId, type).dataset_id;
  let n = 0;
  for (const k of kindsOf(type)) {
    for (;;) {
      const gone = app.db.all<any>(`SELECT i.* FROM cognee_items i WHERE i.location_id = ? AND i.type = ? AND i.kind = ? AND NOT EXISTS (${k.alive}) LIMIT 200`, locationId, type, k.key);
      for (const it of gone) dropItem(app, it, datasetId, 'record_deleted');
      n += gone.length;
      if (gone.length < 200) break;
    }
  }
  return n;
}

export const reconcileAll = (app: App, locationId: string) => TYPES.reduce((n, t) => n + reconcile(app, locationId, t), 0);

/** The scheduler's version: throttled, and it lets requests through between the types (large sub-accounts have many mapped records). */
async function reconcileLater(app: App, locationId: string, type: CogneeType, background: boolean): Promise<number> {
  if (background && clock(app) - (lastReconcile.get(`${locationId}:${type}`) ?? 0) < RECONCILE_EVERY_MS) return 0;
  await yieldLoop();
  return reconcile(app, locationId, type);
}

/** Row-level refusals that skip the record instead of stopping the sync (bad input, too large). */
const permanent = (e: unknown) => e instanceof CogneeError && [400, 409, 413, 422].includes(e.upstream);

async function pushRow(app: App, client: LocationClient, st: StateRow, settings: CogneeSettings, ds: OwnedDataset, kindKey: string, row: Row, rep: TypeReport) {
  const type = st.type;
  const loc = client.locationId;
  const kind = kindOf(type, kindKey)!;
  const existing = getItem(app, loc, type, kind.key, row.rid);
  const built = kind.build(app, loc, row);
  if (!built) {
    if (existing) {
      dropItem(app, existing, st.dataset_id, 'record_deleted');
      rep.removed++;
    }
    return;
  }
  let text = documentText(type, kind.key, row.rid, built);
  if (settings.redact[type]) {
    const r = redact(text);
    text = r.text;
    rep.redacted = addCounts(rep.redacted, r.counts);
  }
  const hash = sha(text);
  if (existing && existing.content_hash === hash) {
    // Same text (a status change, a touched row): remember the new revision, send nothing.
    app.db.run('UPDATE cognee_items SET source_rev = ?, contact_id = ?, parent_id = ? WHERE id = ?', row.at, built.contactId ?? null, built.parentId ?? null, existing.id);
    return;
  }
  const dataId = await client.add(ds, text, `${type}:${kind.key}:${row.rid}`);
  app.db.tx(() => {
    const at = now();
    if (existing) {
      app.db.run('UPDATE cognee_items SET data_id = ?, content_hash = ?, source_rev = ?, contact_id = ?, parent_id = ?, chars = ?, synced_at = ? WHERE id = ?', dataId, hash, row.at, built.contactId ?? null, built.parentId ?? null, text.length, at, existing.id);
      // The previous version goes after the next graph build (so the record never disappears from search in between).
      if (existing.data_id !== dataId) queueDeletion(app, { locationId: loc, type, datasetId: ds.id, dataId: existing.data_id, reason: 'stale', afterCognify: true });
    } else {
      app.db.insert('cognee_items', { id: id(), location_id: loc, type, kind: kind.key, record_id: row.rid, parent_id: built.parentId ?? null, contact_id: built.contactId ?? null, data_id: dataId, content_hash: hash, source_rev: row.at, chars: text.length, synced_at: at });
    }
    // Cognee gave back an item that was waiting for deletion (a text that came back): keep it.
    cancelDeletion(app, loc, type, dataId);
  });
  st.dirty = true;
  if (existing) rep.updated++;
  else rep.added++;
}

async function pollCognify(app: App, client: LocationClient, st: StateRow): Promise<'done' | 'running'> {
  const ds = st.dataset_id ? await client.confirm(st.type, st.dataset_id) : null;
  if (!ds) {
    st.phase = 'idle';
    return 'done';
  }
  const s = await client.status(ds);
  if (s === 'completed') {
    st.phase = 'idle';
    st.cognify_started_at = null;
    st.last_sync_at = iso(clock(app));
    return 'done';
  }
  if (s === 'errored') {
    st.phase = 'idle';
    st.dirty = true;
    throw new CogneeError('Der Wissensgraph konnte auf dem Cognee-Server nicht gebaut werden – dort Protokoll, LLM-Schlüssel und Budget prüfen.', 502, 0, true);
  }
  if (st.cognify_started_at && clock(app) - Date.parse(st.cognify_started_at) > COGNIFY_TIMEOUT_MS) {
    st.phase = 'idle';
    st.dirty = true;
    throw new CogneeError('Der Wissensgraph wird seit über einer Stunde gebaut – Cognee-Server prüfen.', 502, 0, true);
  }
  return 'running';
}

async function syncType(app: App, acct: Account, settings: CogneeSettings, type: CogneeType, full: boolean, background: boolean, deadline: number): Promise<TypeReport> {
  const loc = acct.client.locationId;
  const client = acct.client;
  const rep: TypeReport = { type, added: 0, updated: 0, removed: 0, skipped: 0, redacted: { ...NO_REDACTION }, more: false };
  const st = getState(app, loc, type);
  if (st.next_attempt_at && Date.parse(st.next_attempt_at) > clock(app)) return { ...rep, waiting: true, more: false };
  if (full || !st.last_full_at || clock(app) - Date.parse(st.last_full_at) > FULL_RESCAN_MS) {
    // A full pass: every record is looked at again, unchanged texts are skipped by their hash.
    st.cursor = {};
    st.skipped = 0;
    st.last_full_at = iso(clock(app));
  }
  try {
    if (st.phase === 'cognify' && (await pollCognify(app, client, st)) === 'running') {
      rep.more = true;
      return rep;
    }
    let ds = st.dataset_id ? await client.confirm(type, st.dataset_id) : null;
    if (!ds) {
      // First run, or the dataset was removed on the server: its items are gone with it – start again.
      if (st.dataset_id) {
        app.db.run('DELETE FROM cognee_items WHERE location_id = ? AND type = ?', loc, type);
        st.cursor = {};
      }
      ds = await client.dataset(type, true);
      st.dataset_id = ds!.id;
    }
    for (;;) {
      const rows = nextRows(app, loc, type, st, BATCH);
      for (const { kind, row } of rows) {
        try {
          await pushRow(app, client, st, settings, ds!, kind, row, rep);
        } catch (e) {
          if (!permanent(e)) throw e;
          // Counted (the status shows "n von Cognee abgelehnt"); the record is tried again on the next full pass.
          rep.skipped++;
          st.skipped++;
        }
        st.cursor[kind] = { at: row.at, id: row.rid };
      }
      if (rows.length < BATCH) break;
      if (Date.now() > deadline) {
        rep.more = true;
        break;
      }
    }
    rep.removed += await reconcileLater(app, loc, type, background);
    if (st.dirty && st.phase === 'idle') {
      await client.cognify(ds!);
      st.dirty = false;
      st.phase = 'cognify';
      st.cognify_started_at = iso(clock(app));
      // One look right away: a small build is often done by now.
      rep.more = (await pollCognify(app, client, st)) === 'running';
    } else if (!rep.more) {
      st.last_sync_at = iso(clock(app));
    }
    st.attempts = 0;
    st.next_attempt_at = null;
    st.last_error = '';
  } catch (e) {
    const err = e as Error;
    st.attempts++;
    const wait = Math.max(backoffMs(st.attempts), (e instanceof CogneeError ? e.retryAfterMs : 0) || 0);
    st.next_attempt_at = iso(clock(app) + wait);
    st.last_error = err.message.slice(0, 300);
    st.last_error_at = iso(clock(app));
    rep.error = st.last_error;
    if (e instanceof CogneeError && e.upstream === 404) client.forget();
  } finally {
    saveState(app, st);
  }
  return rep;
}

// --- the deletion queue -----------------------------------------------------------------------------------------------------

export async function processDeletions(app: App, locationId: string): Promise<number> {
  const acct = accountFor(app, locationId);
  if (!acct) return 0;
  const t = clock(app);
  const rows = app.db.all<any>('SELECT * FROM cognee_deletions WHERE location_id = ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 100', locationId, iso(t));
  const done = new Map<string, number>();
  for (const row of rows) {
    if (row.after_cognify) {
      const st = getState(app, locationId, row.type);
      if (st.phase === 'cognify' || st.dirty) continue;
    }
    try {
      // The dataset id of the row counts only when the server confirms it carries this sub-account's name for that type.
      const ds = await acct.client.confirm(row.type, row.dataset_id);
      if (ds) {
        if (row.data_id) await acct.client.deleteData(ds, row.data_id);
        else await acct.client.deleteDataset(ds);
      }
      app.db.run('DELETE FROM cognee_deletions WHERE id = ?', row.id);
      const key = `${row.reason}|${row.data_id ? 'item' : 'dataset'}|${row.type}`;
      done.set(key, (done.get(key) ?? 0) + 1);
    } catch (e) {
      const attempts = row.attempts + 1;
      const wait = attempts > DELETION_FAST_TRIES ? 864e5 : Math.max(backoffMs(attempts), (e instanceof CogneeError ? e.retryAfterMs : 0) || 0);
      app.db.run('UPDATE cognee_deletions SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?', attempts, iso(t + wait), (e as Error).message.slice(0, 300), row.id);
      if (e instanceof CogneeError && e.upstream === 404) acct.client.forget();
    }
  }
  let total = 0;
  for (const [key, n] of done) {
    const [reason, what, type] = key.split('|') as [DeletionReason, string, CogneeType];
    total += n;
    audit(app, locationId, 'cognee.delete', what === 'dataset' ? `Alle Daten „${CATALOG[type].label}“ in Cognee gelöscht (${WHY[reason]})` : `${n} ${n === 1 ? 'Eintrag' : 'Einträge'} „${CATALOG[type].label}“ in Cognee gelöscht (${WHY[reason]})`);
  }
  // A deleted sub-account's own login goes once its data is gone.
  if (!app.db.get('SELECT 1 FROM locations WHERE id = ?', locationId) && !app.db.get('SELECT 1 FROM cognee_deletions WHERE location_id = ?', locationId)) app.db.run('DELETE FROM cognee_accounts WHERE location_id = ?', locationId);
  return total;
}

// --- one cycle ----------------------------------------------------------------------------------------------------------------

export async function syncCycle(app: App, locationId: string, opts: { full?: boolean; background?: boolean } = {}): Promise<CycleReport> {
  const out: CycleReport = { locationId, types: [], deleted: 0, more: false };
  const settings = getSettings(app, locationId);
  const active = activeTypes(settings);
  // Records that vanished are noted first – needs no server. (Types that are on do it in their own step.)
  const bg = !!opts.background;
  for (const t of TYPES) if (!active.includes(t)) await reconcileLater(app, locationId, t, bg);
  const acct = accountFor(app, locationId);
  if (!acct) {
    for (const t of active) await reconcileLater(app, locationId, t, bg);
    return { ...out, skipped: 'no_connection' };
  }
  const open = acct.conn.posture?.state === 'open' && !acct.conn.allow_open_server;
  const deadline = Date.now() + CYCLE_BUDGET_MS;
  if (open) for (const t of active) await reconcileLater(app, locationId, t, bg);
  else {
    for (const type of active) {
      const rep = await syncType(app, acct, settings, type, !!opts.full, bg, deadline);
      out.types.push(rep);
      out.more ||= rep.more;
      const parts = [rep.added && `${rep.added} neu`, rep.updated && `${rep.updated} geändert`, rep.removed && `${rep.removed} entfernt`, rep.skipped && `${rep.skipped} abgelehnt`].filter(Boolean);
      const red = rep.redacted.email + rep.redacted.phone + rep.redacted.iban;
      if (parts.length) audit(app, locationId, 'cognee.push', `${CATALOG[type].label}: ${parts.join(', ')}${red ? ` – ${red} Angaben (E-Mail/Telefon/IBAN) unkenntlich gemacht` : ''}`);
    }
  }
  out.deleted = await processDeletions(app, locationId);
  if (open) out.skipped = 'open_server';
  return out;
}

// --- erasure and purge ----------------------------------------------------------------------------------------------------------

/** Queues the removal of everything the memory holds about one contact (called inside the erase transaction; nothing is sent here). */
export function queueContactErasure(app: App, locationId: string, contactId: string): number {
  const items = app.db.all<any>('SELECT * FROM cognee_items WHERE location_id = ? AND contact_id = ?', locationId, contactId);
  for (const it of items) {
    const datasetId = getState(app, locationId, it.type).dataset_id;
    if (datasetId) queueDeletion(app, { locationId, type: it.type, datasetId, dataId: it.data_id, reason: 'erasure' });
    // A queued replacement of this contact's data goes with it.
    app.db.run('DELETE FROM cognee_items WHERE id = ?', it.id);
  }
  return items.length;
}

/** "Daten in Cognee löschen": the dataset of each type goes (with everything in it), the mapping and sync position are reset. */
export function queuePurge(app: App, locationId: string, types: CogneeType[]): { types: CogneeType[]; items: number } {
  let items = 0;
  const done: CogneeType[] = [];
  app.db.tx(() => {
    for (const type of types) {
      const st = getState(app, locationId, type);
      items += app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cognee_items WHERE location_id = ? AND type = ?', locationId, type)!.n;
      if (st.dataset_id) {
        // Single deletions of this dataset are covered by the dataset itself.
        app.db.run('DELETE FROM cognee_deletions WHERE location_id = ? AND type = ? AND dataset_id = ?', locationId, type, st.dataset_id);
        queueDeletion(app, { locationId, type, datasetId: st.dataset_id, dataId: '', reason: 'purge' });
      }
      app.db.run('DELETE FROM cognee_items WHERE location_id = ? AND type = ?', locationId, type);
      app.db.run('DELETE FROM cognee_state WHERE location_id = ? AND type = ?', locationId, type);
      // The notes people asked to remember exist only for the memory: forgetting means deleting them here too.
      if (type === 'memory') app.db.run('DELETE FROM cognee_memories WHERE location_id = ?', locationId);
      done.push(type);
    }
  });
  return { types: done, items };
}

