import type { Db } from '../core/db.js';

/**
 * Full-text search for the Wiki and the Team-Chat on SQLite FTS5 (part of node:sqlite). The index is a
 * plain FTS5 table keyed by the rowid of the table it indexes; callers join it back to their own table
 * (and so to the sub-account filter), so the index never decides who may see what.
 * Without FTS5 (a build of SQLite that lacks it) `ok` is false and callers fall back to LIKE with the
 * ordinary indexes.
 *
 * Words are matched as prefixes ("proto" finds "Protokoll"), upper/lower case and umlaut accents are ignored
 * ("buro" finds "Büro"), every word of the query must appear.
 */

/** Marks around a hit in snippets (control characters – the UI turns them into highlighting). */
export const HIT_START = '\u0001';
export const HIT_END = '\u0002';

export interface Fts {
  ok: boolean;
  table: string;
  upsert(rowid: number, values: Record<string, string>): void;
  remove(rowid: number): void;
  clear(): void;
  /** Fills an empty index from existing rows (a database that had pages before the index existed). */
  backfill(rows: () => { rowid: number; values: Record<string, string> }[]): void;
}

export function createFts(db: Db, table: string, columns: string[]): Fts {
  let ok = false;
  try {
    db.raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(${columns.join(', ')}, tokenize = 'unicode61 remove_diacritics 2')`);
    ok = true;
  } catch {
    ok = false;
  }
  const fts: Fts = {
    ok,
    table,
    upsert(rowid, values) {
      if (!ok) return;
      try {
        db.run(`DELETE FROM ${table} WHERE rowid = ?`, rowid);
        db.run(`INSERT INTO ${table} (rowid, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`, rowid, ...columns.map((c) => String(values[c] ?? '')));
      } catch (e) {
        console.error(`[${table}]`, (e as Error).message);
      }
    },
    remove(rowid) {
      if (!ok) return;
      try {
        db.run(`DELETE FROM ${table} WHERE rowid = ?`, rowid);
      } catch (e) {
        console.error(`[${table}]`, (e as Error).message);
      }
    },
    clear() {
      if (ok) db.run(`DELETE FROM ${table}`);
    },
    backfill(rows) {
      if (!ok) return;
      if (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n) return;
      const list = rows();
      if (!list.length) return;
      db.tx(() => {
        for (const r of list) fts.upsert(r.rowid, r.values);
      });
    },
  };
  return fts;
}

/** Words of a user's search text (letters and digits only, at most 8). */
export function searchWords(q: string): string[] {
  return String(q ?? '')
    .slice(0, 300)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
}

/** An FTS5 MATCH expression for the words (all must match, each as a prefix), or null when there are none. */
export function matchExpr(q: string): string | null {
  const words = searchWords(q);
  return words.length ? words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ') : null;
}

/** LIKE pattern for the fallback (escape character "\"): `col LIKE ? ESCAPE '\'`. */
export const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Snippet around the first hit when FTS is not available (same marks as FTS5's snippet()). */
export function plainSnippet(text: string, words: string[], width = 140): string {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  let at = -1;
  for (const w of words) {
    const k = lower.indexOf(w);
    if (k >= 0 && (at < 0 || k < at)) at = k;
  }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  let out = t.slice(start, start + width);
  for (const w of words) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `${HIT_START}${m}${HIT_END}`);
  return `${start > 0 ? '…' : ''}${out}${start + width < t.length ? '…' : ''}`;
}
