import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HttpError } from './http.js';

export type Row = Record<string, any>;
export type Param = SQLInputValue | boolean | undefined;

/** Prepared statements kept per SQL text (the same few hundred queries run all day). */
const STATEMENT_CACHE = 1000;

const envInt = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** PGHL_RESULT_CACHE=0 turns the result cache (db.memo) off – the benchmarks use it to show the uncached cost. */
const MEMO_ON = process.env.PGHL_RESULT_CACHE !== '0';

/** Thin synchronous wrapper over node:sqlite with JSON-column helpers. */
export class Db {
  readonly raw: DatabaseSync;
  /** Queries slower than this (ms) go to `onSlow`; 0 = no timing (PGHL_SLOW_QUERY_MS, see core/perf.ts). */
  slowMs = 0;
  onSlow?: (sql: string, ms: number) => void;
  private statements = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    // WAL + busy timeout for concurrent readers; secure_delete so erased personal data doesn't linger in free
    // pages of the file (GDPR erasure); trusted_schema off – no SQL functions run from schema definitions.
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = FAST; PRAGMA trusted_schema = OFF;');
    // Speed: with WAL, synchronous=NORMAL is crash-safe (a power cut may lose the last commits, never the file);
    // temp tables/sorts in memory, a 32 MB page cache, and the file memory-mapped (PGHL_SQLITE_MMAP_MB, default
    // 256, 0 = off; PGHL_SQLITE_CACHE_MB, default 32).
    const cacheKb = envInt(process.env.PGHL_SQLITE_CACHE_MB, 32) * 1000;
    const mmap = envInt(process.env.PGHL_SQLITE_MMAP_MB, 256) * 1024 * 1024;
    this.raw.exec(`PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -${cacheKb}; PRAGMA mmap_size = ${mmap};`);
    this.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  }

  /** A cached prepared statement (SQLite re-prepares it by itself after schema changes). */
  prepare(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (st) {
      // Most recently used last, so the oldest is evicted first.
      this.statements.delete(sql);
      this.statements.set(sql, st);
      return st;
    }
    st = this.raw.prepare(sql);
    this.statements.set(sql, st);
    if (this.statements.size > STATEMENT_CACHE) this.statements.delete(this.statements.keys().next().value!);
    return st;
  }

  /**
   * Forgets the prepared statements. Needed after a schema change made outside `migrate` (which does it
   * itself): a cached `SELECT *` keeps the column list it was prepared with.
   */
  invalidate(): void {
    this.statements.clear();
  }

  private timed<T>(sql: string, fn: () => T): T {
    if (!this.slowMs) return fn();
    const t = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t;
      if (ms > this.slowMs) this.onSlow?.(sql, ms);
    }
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.timed(sql, () => this.prepare(sql).all(...norm(params)) as T[]);
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.timed(sql, () => this.prepare(sql).get(...norm(params)) as T | undefined);
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    return this.timed(sql, () => {
      const r = this.prepare(sql).run(...norm(params));
      return { changes: Number(r.changes) };
    });
  }

  private tokenStmt?: StatementSync;
  private versionStmt?: StatementSync;
  private memos = new Map<string, { at: number; token: string; value: unknown }>();

  /**
   * Changes whenever data changed: rows written through this connection (total_changes) or committed by
   * another process (data_version). Equal tokens mean "no write since" – the key for result caches.
   */
  changeToken(): string {
    this.tokenStmt ??= this.raw.prepare('SELECT total_changes() AS n');
    this.versionStmt ??= this.raw.prepare('PRAGMA data_version');
    return `${(this.tokenStmt.get() as { n: number }).n}:${Object.values(this.versionStmt.get() ?? {})[0]}`;
  }

  /**
   * Result cache for read-only aggregates (dashboards, overviews): `fn()` runs again after any write
   * to the database or after `ttlMs` (time-dependent numbers such as "overdue"). The value is shared –
   * treat it as read-only. Not for answers that depend on who asks unless the key says so.
   */
  memo<T>(key: string, ttlMs: number, fn: () => T): T {
    if (!MEMO_ON) return fn();
    const token = this.changeToken();
    const hit = this.memos.get(key);
    if (hit && hit.token === token && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = fn();
    // A write inside fn (rare) must not leave a result that claims to be current.
    this.memos.set(key, { at: Date.now(), token: this.changeToken() === token ? token : '', value });
    if (this.memos.size > 500) this.memos.delete(this.memos.keys().next().value!);
    return value;
  }

  /**
   * Refreshes the query planner's statistics where they are missing or stale (bounded work: at most 1000
   * rows are sampled per index). `all` also looks at tables nothing has queried yet – used once after the
   * migrations, so new indexes are chosen correctly from the first request on (without statistics SQLite
   * guesses, and a wrong guess can cost 10x).
   */
  optimize(all = false): void {
    try {
      this.raw.exec(`PRAGMA analysis_limit = 1000; PRAGMA optimize${all ? '(0x10002)' : ''}`);
    } catch {
      /* busy or read-only: next time */
    }
  }

  /** Current values of the tuning PRAGMAs (admin metrics, tests). */
  pragmas(): Record<string, unknown> {
    const one = (name: string) => Object.values(this.raw.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    return Object.fromEntries(['journal_mode', 'synchronous', 'cache_size', 'temp_store', 'mmap_size', 'busy_timeout', 'foreign_keys', 'page_size', 'page_count', 'freelist_count'].map((n) => [n, one(n)]));
  }

  private txDepth = 0;

  /** One transaction; called inside another (an undo that runs a module's own restore) it becomes a savepoint of it. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const sp = `tx${this.txDepth}`;
      this.raw.exec(`SAVEPOINT ${sp}`);
      this.txDepth++;
      try {
        const out = fn();
        this.raw.exec(`RELEASE ${sp}`);
        return out;
      } catch (e) {
        this.raw.exec(`ROLLBACK TO ${sp}`);
        this.raw.exec(`RELEASE ${sp}`);
        throw e;
      } finally {
        this.txDepth--;
      }
    }
    this.raw.exec('BEGIN');
    this.txDepth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  migrate(name: string, sql: string): void {
    if (this.get('SELECT name FROM _migrations WHERE name = ?', name)) return;
    this.tx(() => {
      this.raw.exec(sql);
      this.run('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', name, new Date().toISOString());
    });
    this.invalidate();
  }

  /** Insert a plain object; objects/arrays are stored as JSON text. */
  insert(table: string, row: Row): void {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    this.run(sql, ...keys.map((k) => toSql(row[k])));
  }

  /** Updates one row by id; with `locationId` only when it belongs to that sub-account. */
  update(table: string, id: string, patch: Row, locationId?: string): number {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return this.get(`SELECT id FROM ${table} WHERE id = ?${locationId ? ' AND location_id = ?' : ''}`, id, ...(locationId ? [locationId] : [])) ? 1 : 0;
    const scope = locationId ? ' AND location_id = ?' : '';
    const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?${scope}`;
    return this.run(sql, ...keys.map((k) => toSql(patch[k])), id, ...(locationId ? [locationId] : [])).changes;
  }

  close(): void {
    this.statements.clear();
    this.memos.clear();
    this.optimize();
    this.raw.close();
  }
}

export function toSql(v: unknown): Param {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
  return v as Param;
}

function norm(params: Param[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    // A plain object or array is never a column value. node:sqlite would take it for a bag of *named* parameters and fail
    // with "Unknown named parameter 'a'" – a request that sent `{"name": {"a": 1}}` would end in a 500 instead of a 400.
    if (p !== null && typeof p === 'object' && !ArrayBuffer.isView(p)) throw new HttpError(400, 'Ungültiger Wert: erwartet wird Text oder eine Zahl');
    return p;
  });
}

/** Parse the JSON columns named in `cols` of a row (in place) and return it. */
export function parseJson<T extends Row | undefined>(row: T, cols: string[]): T {
  if (!row) return row;
  for (const c of cols) {
    const v = row[c];
    if (typeof v === 'string') {
      try {
        (row as Row)[c] = JSON.parse(v);
      } catch {
        /* leave as text */
      }
    }
  }
  return row;
}

export function parseRows<T extends Row>(rows: T[], cols: string[]): T[] {
  return rows.map((r) => parseJson(r, cols));
}
