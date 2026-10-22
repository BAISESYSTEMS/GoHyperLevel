import type { App } from '../core/app.js';
import type { Row } from '../core/db.js';
import type { Ctx } from '../core/http.js';
import { NEVER_KEEP, applyKids, applyPart, collectKids, decodeRow, encodeRow, sameValue, tableMeta, updateRow, upsertRow, type PartData, type Snapshot } from './undo-core.js';

/** How a changed value is shown in "before → after". */
export type Fmt = 'text' | 'bool' | 'date' | 'datetime' | 'money' | 'tags' | 'json' | ((value: unknown, row: Row, app: App) => string);
export interface FieldSpec {
  label: string;
  fmt?: Fmt;
}

/** `now`: the record as it is. `before`: just ahead of a tracked write (an entity may secure a version of its own history). `deep`: plus what a delete takes along. */
export type SnapMode = 'now' | 'before' | 'deep';

/** What one kind of record offers the journal (`app.services.undo.register(type, entity)`). */
export interface UndoEntity {
  /** Noun used in labels: "Aufgabe" → "Aufgabe „Angebot schreiben“ erledigt". */
  noun: string;
  plural?: string;
  /** Permission area (server/core/permissions.ts) the person needs to undo a change of this kind. */
  area: string;
  /** Columns ignored when asking "did it change since" (timestamps other code bumps by itself). */
  volatile?: string[];
  /** Key fields shown as before → after; without it every non-volatile column is shown. */
  fields?: Record<string, FieldSpec>;
  /** The record as it is now (null = it does not exist). */
  snapshot(id: string, ctx?: Ctx, mode?: SnapMode): Snapshot | null;
  /** Makes the record look like `target` (null = delete it). Runs inside the undo transaction and must not send anything. */
  restore(target: Snapshot | null, ctx: Ctx, current: Snapshot | null): void;
  /** "Aufgabe „Angebot schreiben“". */
  label(s: Snapshot): string;
  /** "erledigt", "verschoben" … – a word for what the change did; default by action. */
  verb?(before: Snapshot | null, after: Snapshot | null): string | undefined;
  /** After the transaction: side effects that are safe to repeat (e.g. let Todoist know). */
  afterRestore?(ctx: Ctx, target: Snapshot | null, current: Snapshot | null): void;
  /** The contact a record belongs to (so erasing the contact for GDPR also empties the journal). */
  contactId?(s: Snapshot): string | undefined;
}

export interface PartSpec {
  name: string;
  table: string;
  pk: string[];
  cols?: string[];
  mode: 'replace' | 'patch';
  fp?: boolean;
  where: { sql: string; params: unknown[] };
}

export interface TableSpec {
  noun: string;
  plural?: string;
  area: string;
  table: string;
  /** The quoted part of the label. */
  title: (row: Row, app: App) => string;
  /** Column holding the sub-account (default `location_id`; null = the table has none, `scope` decides). */
  locationCol?: string | null;
  scope?: (app: App, row: Row, locationId: string) => boolean;
  /** Columns other code maintains by itself (timestamps, counters, derived values): ignored when asking "did it change since". */
  volatile?: string[];
  /** Columns an undo never overwrites on an existing record (default updated_at) – e.g. the preview line of a conversation. */
  keep?: string[];
  fields?: Record<string, FieldSpec>;
  /** Related sets that travel with every snapshot of the record (assignees of a task, links of a company …). */
  parts?: (app: App, row: Row, ctx?: Ctx) => PartSpec[];
  /** Deep snapshots (delete) follow the foreign keys. Default true. */
  kids?: boolean;
  skipKids?: string[];
  extra?: (app: App, row: Row) => Record<string, unknown> | undefined;
  /** More to do inside the transaction when the record is put back (after the row, parts and kids). */
  onRestore?: (app: App, target: Snapshot | null, current: Snapshot | null, ctx: Ctx) => void;
  verb?: UndoEntity['verb'];
  afterRestore?: UndoEntity['afterRestore'];
  contactCol?: string | null;
}

const FOREIGN = 'Der Datensatz gehört zu einem anderen Sub-Account';

/** A journal entity for a table with an `id` primary key: row, parts, and (for deletes) everything the foreign keys take along. */
export function tableEntity(app: App, spec: TableSpec): UndoEntity {
  const { db } = app;
  const locCol = spec.locationCol === undefined ? 'location_id' : spec.locationCol;
  const contactCol = spec.contactCol === undefined ? 'contact_id' : spec.contactCol;
  const skip = new Set([...NEVER_KEEP, ...(spec.skipKids ?? [])]);
  const keep = spec.keep ?? ['updated_at'];
  const entity: UndoEntity = {
    noun: spec.noun,
    plural: spec.plural,
    area: spec.area,
    volatile: spec.volatile,
    fields: spec.fields,
    snapshot(id, ctx, mode = 'now') {
      const deep = mode === 'deep';
      const row = db.get<Row>(`SELECT * FROM "${spec.table}" WHERE id = ?${locCol && ctx?.locationId ? ` AND "${locCol}" = ?` : ''}`, id, ...(locCol && ctx?.locationId ? [ctx.locationId] : []));
      if (!row) return null;
      if (!locCol && spec.scope && ctx?.locationId && !spec.scope(app, row, ctx.locationId)) return null;
      const snap: Snapshot = { v: 1, entity: spec.table, id, row: encodeRow(row) };
      const parts = spec.parts?.(app, row, ctx);
      if (parts?.length) {
        snap.parts = {};
        for (const p of parts) {
          const cols = p.cols ? [...new Set([...p.pk, ...p.cols])] : undefined;
          const rows = db.all(`SELECT ${cols ? cols.map((c) => `"${c}"`).join(', ') : '*'} FROM "${p.table}" WHERE ${p.where.sql}`, ...(p.where.params as any[]));
          snap.parts[p.name] = { table: p.table, pk: p.pk, cols: p.cols, mode: p.mode, fp: p.fp !== false, rows: rows.map(encodeRow) } satisfies PartData;
        }
      }
      if (deep && spec.kids !== false) {
        const { kids, nulls } = collectKids(db, spec.table, [row], skip);
        if (Object.keys(kids).length) snap.kids = kids;
        if (nulls.length) snap.nulls = nulls;
      }
      const extra = spec.extra?.(app, row);
      if (extra) snap.extra = extra;
      return snap;
    },
    restore(target, ctx, current) {
      if (!target) {
        if (current) db.run(`DELETE FROM "${spec.table}" WHERE id = ?${locCol ? ` AND "${locCol}" = ?` : ''}`, current.id, ...(locCol ? [ctx.locationId] : []));
        return;
      }
      if (locCol && target.row[locCol] !== ctx.locationId) throw new Error(FOREIGN);
      if (current) {
        // The record exists: set the columns that differ (never the ones other code maintains), so unrelated later edits survive a forced undo.
        const cols = Object.keys(target.row).filter((c) => !keep.includes(c) && !sameValue(target.row[c], current.row[c]));
        if (cols.length) updateRow(db, spec.table, decodeRow(target.row), cols);
      } else upsertRow(db, spec.table, decodeRow(target.row));
      if (target.parts) {
        const specs = new Map((spec.parts?.(app, target.row, undefined) ?? []).map((p) => [p.name, p]));
        for (const [name, part] of Object.entries(target.parts)) applyPart(db, part, specs.get(name)?.where);
      }
      if (target.kids || target.nulls) applyKids(db, target);
      spec.onRestore?.(app, target, current, ctx);
    },
    label: (s) => `${spec.noun} „${clip(spec.title(s.row, app), 60)}“`,
    verb: spec.verb,
    afterRestore: spec.afterRestore,
    contactId: (s) => (spec.table === 'contacts' ? s.id : contactCol && typeof s.row[contactCol] === 'string' ? (s.row[contactCol] as string) : undefined),
  };
  // Make sure the table really has the columns the spec names (a typo here would only show up as a missing diff).
  const meta = tableMeta(db, spec.table);
  if (!meta.cols.length) throw new Error(`undo: unknown table ${spec.table}`);
  return entity;
}

export const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
