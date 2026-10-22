import { createHash } from 'node:crypto';
import type { Db, Row } from '../core/db.js';

/**
 * Building blocks of the undo journal (modules/undo.ts): what a "snapshot" of a record is, how the
 * rows a delete takes along are found and put back, and how two snapshots are compared.
 *
 * A snapshot is plain JSON: the changed row, "parts" (small related sets that belong to it, e.g. the
 * assignees of a task) and – only for deletes – "kids": the rows the foreign keys (ON DELETE CASCADE)
 * remove with it, plus the rows whose link is set to NULL (ON DELETE SET NULL). That is what makes
 * "delete contact → undo" bring notes, tasks and deals back with the same ids. The journal keeps only
 * the changed rows, never copies of whole tables.
 */

export interface PartData {
  table: string;
  pk: string[];
  /** Only these columns are stored and restored (the rest of the row is left alone). */
  cols?: string[];
  /** `replace`: the set is exactly as snapshotted (extra rows are removed); `patch`: only the stored columns of existing rows are set. */
  mode: 'replace' | 'patch';
  /** Takes part in the "did it change since" comparison (false for parts that are only read when a request touches them). */
  fp: boolean;
  rows: Row[];
}

export interface NullRef {
  table: string;
  pk: Record<string, unknown>;
  col: string;
  value: unknown;
}

export interface Snapshot {
  v: 1;
  entity: string;
  id: string;
  row: Row;
  parts?: Record<string, PartData>;
  kids?: Record<string, Row[]>;
  nulls?: NullRef[];
  /** Entity specific data (e.g. the next occurrence a recurring task spawned). */
  extra?: Record<string, unknown>;
}

export class TooBig extends Error {
  constructor() {
    super('Zu viele verknüpfte Datensätze für den Papierkorb');
  }
}

export const LIMITS = { rows: 20_000, bytes: 8_000_000 };

// --- schema knowledge ------------------------------------------------------------------------------

interface TableMeta {
  cols: string[];
  pk: string[];
}
interface Fk {
  child: string;
  from: string;
  to: string | null;
  onDelete: string;
}
const metaCache = new WeakMap<Db, Map<string, TableMeta>>();
const fkCache = new WeakMap<Db, Map<string, Fk[]>>();

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function tableMeta(db: Db, table: string): TableMeta {
  let m = metaCache.get(db);
  if (!m) metaCache.set(db, (m = new Map()));
  let t = m.get(table);
  if (!t) {
    const info = db.all<{ name: string; pk: number }>(`PRAGMA table_info(${ident(table)})`);
    t = { cols: info.map((c) => c.name), pk: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name) };
    m.set(table, t);
  }
  return t;
}

/** Tables that point at `table` with a foreign key (and what happens to them when a row is deleted). */
export function fkChildren(db: Db, table: string): Fk[] {
  let m = fkCache.get(db);
  if (!m) {
    m = new Map();
    fkCache.set(db, m);
    for (const { name } of db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)) {
      for (const fk of db.all<{ table: string; from: string; to: string | null; on_delete: string }>(`PRAGMA foreign_key_list(${ident(name)})`)) {
        const list = m.get(fk.table) ?? [];
        list.push({ child: name, from: fk.from, to: fk.to, onDelete: String(fk.on_delete).toUpperCase() });
        m.set(fk.table, list);
      }
    }
  }
  return m.get(table) ?? [];
}

// --- row encoding ------------------------------------------------------------------------------------

export function encodeRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? { __b64: Buffer.from(v).toString('base64') } : typeof v === 'bigint' ? Number(v) : v;
  return out;
}
export function decodeRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = v && typeof v === 'object' && typeof (v as any).__b64 === 'string' ? Buffer.from((v as any).__b64, 'base64') : v;
  return out;
}

const size = (row: Row) => {
  let n = 16;
  for (const v of Object.values(row)) n += typeof v === 'string' ? v.length : 8;
  return n;
};
const keyOf = (row: Row, pk: string[]) => (pk.length ? JSON.stringify(pk.map((c) => row[c])) : JSON.stringify(row));
const chunks = <T>(xs: T[], n = 400): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// --- what a delete takes along ----------------------------------------------------------------------------

/** Tables whose rows are credentials of the deleted person: never copied into the journal. */
export const NEVER_KEEP = new Set(['member_sessions', 'member_login_tokens', 'sessions', 'chat_visitors']);

/**
 * The rows the database removes (CASCADE) or detaches (SET NULL) when `rows` of `table` are deleted,
 * found by walking the foreign keys breadth first (so parents come before their children).
 */
export function collectKids(db: Db, table: string, rows: Row[], skip: Set<string> = NEVER_KEEP): { kids: Record<string, Row[]>; nulls: NullRef[] } {
  const kids: Record<string, Row[]> = {};
  const nulls: NullRef[] = [];
  const seen = new Map<string, Set<string>>();
  const mark = (t: string, pk: string[], row: Row) => {
    let s = seen.get(t);
    if (!s) seen.set(t, (s = new Set()));
    const k = keyOf(row, pk);
    if (s.has(k)) return false;
    s.add(k);
    return true;
  };
  for (const r of rows) mark(table, tableMeta(db, table).pk, r);
  let total = 0;
  let bytes = 0;
  let level: { table: string; rows: Row[] }[] = [{ table, rows }];
  while (level.length) {
    const next: { table: string; rows: Row[] }[] = [];
    for (const { table: parent, rows: prows } of level) {
      const parentPk = tableMeta(db, parent).pk;
      for (const fk of fkChildren(db, parent)) {
        if (skip.has(fk.child) || (fk.onDelete !== 'CASCADE' && fk.onDelete !== 'SET NULL')) continue;
        const refCol = fk.to ?? parentPk[0];
        const vals = [...new Set(prows.map((r) => r[refCol]).filter((v) => v !== null && v !== undefined))];
        if (!vals.length) continue;
        const cm = tableMeta(db, fk.child);
        for (const part of chunks(vals)) {
          const marks = part.map(() => '?').join(',');
          if (fk.onDelete === 'CASCADE') {
            const found = db.all(`SELECT * FROM ${ident(fk.child)} WHERE ${ident(fk.from)} IN (${marks})`, ...(part as any[]));
            const fresh = found.filter((r) => mark(fk.child, cm.pk, r));
            if (!fresh.length) continue;
            total += fresh.length;
            for (const r of fresh) bytes += size(r);
            if (total > LIMITS.rows || bytes > LIMITS.bytes) throw new TooBig();
            (kids[fk.child] ??= []).push(...fresh.map(encodeRow));
            next.push({ table: fk.child, rows: fresh });
          } else {
            const idCols = cm.pk.length ? cm.pk : ['rowid'];
            const found = db.all(`SELECT ${idCols.map(ident).join(', ')}, ${ident(fk.from)} AS __v FROM ${ident(fk.child)} WHERE ${ident(fk.from)} IN (${marks})`, ...(part as any[]));
            total += found.length;
            if (total > LIMITS.rows) throw new TooBig();
            for (const r of found) nulls.push({ table: fk.child, pk: Object.fromEntries(idCols.map((c) => [c, r[c]])), col: fk.from, value: r.__v });
          }
        }
      }
    }
    level = next;
  }
  return { kids, nulls };
}

// --- writing rows back ------------------------------------------------------------------------------------------

/** Insert the row, or update it when its key exists (never REPLACE: that would delete – and cascade – first). */
export function upsertRow(db: Db, table: string, row: Row, only?: string[]) {
  const meta = tableMeta(db, table);
  const cols = Object.keys(row).filter((c) => meta.cols.includes(c) && (!only || only.includes(c) || meta.pk.includes(c)));
  if (!cols.length) return;
  const values = cols.map((c) => (row[c] === undefined ? null : row[c])) as any[];
  const sets = cols.filter((c) => !meta.pk.includes(c));
  const conflict = meta.pk.length ? ` ON CONFLICT(${meta.pk.map(ident).join(', ')}) DO ${sets.length ? `UPDATE SET ${sets.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}` : 'NOTHING'}` : '';
  db.run(`INSERT INTO ${ident(table)} (${cols.map(ident).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${conflict}`, ...values);
}

/** Sets some columns of an existing row (found by its primary key). */
export function updateRow(db: Db, table: string, row: Row, cols: string[]) {
  const meta = tableMeta(db, table);
  const sets = cols.filter((c) => meta.cols.includes(c) && !meta.pk.includes(c));
  if (!sets.length || !meta.pk.length) return;
  db.run(`UPDATE ${ident(table)} SET ${sets.map((c) => `${ident(c)} = ?`).join(', ')} WHERE ${meta.pk.map((c) => `${ident(c)} = ?`).join(' AND ')}`, ...(sets.map((c) => row[c] ?? null) as any[]), ...(meta.pk.map((c) => row[c]) as any[]));
}

/** Puts a part (a small related set) back: `replace` makes the set exactly the snapshotted one, `patch` sets columns of existing rows. */
export function applyPart(db: Db, part: PartData, where: { sql: string; params: unknown[] } | undefined) {
  if (part.mode === 'patch') {
    const meta = tableMeta(db, part.table);
    for (const raw of part.rows) {
      const row = decodeRow(raw);
      const sets = (part.cols ?? Object.keys(row)).filter((c) => !part.pk.includes(c) && meta.cols.includes(c));
      if (!sets.length) continue;
      db.run(`UPDATE ${ident(part.table)} SET ${sets.map((c) => `${ident(c)} = ?`).join(', ')} WHERE ${part.pk.map((c) => `${ident(c)} = ?`).join(' AND ')}`, ...(sets.map((c) => row[c] ?? null) as any[]), ...(part.pk.map((c) => row[c]) as any[]));
    }
    return;
  }
  const keep = new Set(part.rows.map((r) => keyOf(r, part.pk)));
  if (where) {
    for (const cur of db.all(`SELECT * FROM ${ident(part.table)} WHERE ${where.sql}`, ...(where.params as any[]))) if (!keep.has(keyOf(encodeRow(cur), part.pk))) db.run(`DELETE FROM ${ident(part.table)} WHERE ${part.pk.map((c) => `${ident(c)} = ?`).join(' AND ')}`, ...(part.pk.map((c) => cur[c]) as any[]));
  }
  for (const raw of part.rows) upsertRow(db, part.table, decodeRow(raw));
}

/** Rows a delete took along go back (parents first; foreign keys are checked at the end of the transaction). */
export function applyKids(db: Db, snap: Snapshot) {
  for (const [table, rows] of Object.entries(snap.kids ?? {})) for (const row of rows) upsertRow(db, table, decodeRow(row));
  for (const n of snap.nulls ?? []) {
    const cols = Object.keys(n.pk);
    // Only where nothing else has been linked in the meantime.
    db.run(`UPDATE ${ident(n.table)} SET ${ident(n.col)} = ? WHERE ${cols.map((c) => `${ident(c)} = ?`).join(' AND ')} AND ${ident(n.col)} IS NULL`, ...([n.value, ...cols.map((c) => n.pk[c])] as any[]));
  }
}

// --- comparing ---------------------------------------------------------------------------------------------------

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * A fingerprint of what a snapshot says about the record (volatile columns such as updated_at left out). Rows come from
 * `SELECT *`, so their keys always have the same order and plain JSON is stable enough – no sorting needed.
 */
export function fingerprint(s: Snapshot | null, volatile: string[] = [], withKids = true): string {
  if (!s) return 'absent';
  let row = s.row;
  if (volatile.length) {
    row = {};
    for (const k in s.row) if (!volatile.includes(k)) row[k] = s.row[k];
  }
  let parts: Record<string, Row[]> | null = null;
  if (s.parts) for (const k in s.parts) if (s.parts[k].fp) (parts ??= {})[k] = s.parts[k].rows;
  return createHash('sha1').update(JSON.stringify([row, parts, withKids ? (s.kids ?? null) : null])).digest('hex');
}

/** JSON-ish equality of two column values (a task's `done` 0 vs "0" is the same state). */
export const sameValue = (a: unknown, b: unknown) => a === b || canonical(a ?? null) === canonical(b ?? null);

export function changedColumns(a: Row | undefined, b: Row | undefined, skip: string[] = []): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => !skip.includes(k) && !sameValue(a?.[k], b?.[k]));
}

/** Rows per table, e.g. "3 Notizen, 2 Aufgaben" (the trash shows what comes back with a record). */
export function kidCounts(kids: Record<string, Row[]> | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(kids ?? {}).map(([t, r]) => [t, r.length]));
}

export const KID_NOUNS: Record<string, [string, string]> = {
  notes: ['Notiz', 'Notizen'],
  tasks: ['Aufgabe', 'Aufgaben'],
  opportunities: ['Deal', 'Deals'],
  appointments: ['Termin', 'Termine'],
  conversations: ['Konversation', 'Konversationen'],
  messages: ['Nachricht', 'Nachrichten'],
  activities: ['Aktivität', 'Aktivitäten'],
  form_submissions: ['Formular-Einsendung', 'Formular-Einsendungen'],
  funnel_pages: ['Seite', 'Seiten'],
  workflow_versions: ['Version', 'Versionen'],
  workflow_runs: ['Workflow-Lauf', 'Workflow-Läufe'],
  canvas_elements: ['Element', 'Elemente'],
  invoices: ['Rechnung', 'Rechnungen'],
  tickets: ['Ticket', 'Tickets'],
};

export function kidsText(counts: Record<string, number>, max = 4): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => {
      const noun = KID_NOUNS[t];
      return noun ? `${n} ${n === 1 ? noun[0] : noun[1]}` : null;
    })
    .filter(Boolean) as string[];
  const rest = Object.entries(counts).filter(([t, n]) => n > 0 && !KID_NOUNS[t]).reduce((s, [, n]) => s + n, 0);
  const shown = parts.slice(0, max);
  if (rest || parts.length > max) shown.push('weitere Einträge');
  return shown.join(', ');
}
