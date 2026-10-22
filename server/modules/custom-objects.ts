import type { App, Module } from '../core/app.js';
import { parseCsv, toCsv } from '../core/csv.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, num, str, text, type Ctx, clampLimit } from '../core/http.js';
import { id, now } from '../core/util.js';
import {
  CUSTOM_OBJECT_RE,
  ValueError,
  changedKeys,
  displayValue,
  filterSql,
  jsonPath,
  keyFromLabel,
  mergeProps,
  parseFilters,
  sortSql,
  type FieldExpr,
  type ObjectInfo,
} from '../services/objects.js';
import type { AssociationsService, Ref } from './associations.js';
import type { ObjectSchema } from './object-schema.js';

/**
 * Custom objects (HubSpot "Benutzerdefinierte Objekte"): per sub-account object types with a
 * singular/plural name, an icon and a primary display property, typed properties (managed on the
 * properties page) and records with list views, CSV import/export and associations to contacts,
 * companies, deals and each other. Type keys start with p_ so they never clash with types other
 * modules register. Workflows hear record.created, record.updated and record.property_changed.
 */

const assoc = (app: App): AssociationsService => app.services.associations;
const schema = (app: App): ObjectSchema => app.services.objectSchema;
const MAX_TYPES = 50;
const PRIMARY_TYPES = ['text', 'email', 'phone', 'url', 'number', 'date'];

export function objectTypes(app: App, locationId: string) {
  return app.db.all('SELECT * FROM object_types WHERE location_id = ? ORDER BY position, plural', locationId);
}
export function objectType(app: App, locationId: string, keyOrId: string): any {
  return app.db.get('SELECT * FROM object_types WHERE location_id = ? AND (key = ? OR id = ?)', locationId, keyOrId, keyOrId);
}
export function getRecord(app: App, locationId: string, typeId: string, rid: string): any {
  return parseJson(app.db.get('SELECT * FROM object_records WHERE id = ? AND location_id = ? AND type_id = ?', rid, locationId, typeId), ['properties']);
}

const displayOf = (t: any, props: Record<string, unknown>) => {
  const v = props?.[t.primary_property];
  return (v === undefined || v === null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 300);
};

export interface RecordOpts {
  userId?: string | null;
  quiet?: boolean;
}

function checkOwner(app: App, locationId: string, owner: unknown) {
  if (owner === undefined) return undefined;
  if (!owner) return null;
  if (!schema(app).users(locationId).some((u) => u.id === owner)) throw bad('Zuständig: Nutzer hat keinen Zugriff auf diesen Sub-Account');
  return String(owner);
}

export function createRecord(app: App, locationId: string, t: any, input: { properties?: Record<string, unknown>; owner_id?: string | null }, opts: RecordOpts = {}) {
  const props = mergeProps({}, schema(app).validate(locationId, t.key, input.properties ?? {}, {}));
  const row = { id: id(), location_id: locationId, type_id: t.id, properties: props, display: displayOf(t, props), owner_id: checkOwner(app, locationId, input.owner_id) ?? null, created_at: now(), updated_at: now() };
  app.db.insert('object_records', row);
  const record = { ...getRecord(app, locationId, t.id, row.id)!, object: t.key };
  schema(app).log(locationId, t.key, row.id, 'record.created', `${t.singular} angelegt`, {}, opts.userId);
  if (!opts.quiet) app.events.emit(locationId, 'record.created', { recordId: row.id, objectKey: t.key, objectLabel: t.singular, record });
  return record;
}

export function updateRecord(app: App, locationId: string, t: any, rid: string, input: { properties?: Record<string, unknown>; owner_id?: string | null }, opts: RecordOpts = {}) {
  const cur = getRecord(app, locationId, t.id, rid);
  if (!cur) throw notFound(`${t.singular} nicht gefunden`);
  const patch = input.properties !== undefined ? schema(app).validate(locationId, t.key, input.properties, { partial: true, current: cur.properties, recordId: rid }) : {};
  const next = mergeProps(cur.properties, patch);
  const owner = checkOwner(app, locationId, input.owner_id);
  const changed = changedKeys(cur.properties, next);
  const ownerChanged = owner !== undefined && owner !== cur.owner_id;
  if (!changed.length && !ownerChanged) return { ...cur, object: t.key };
  app.db.update('object_records', rid, { properties: next, display: displayOf(t, next), ...(ownerChanged ? { owner_id: owner } : {}), updated_at: now() });
  const record = { ...getRecord(app, locationId, t.id, rid)!, object: t.key };
  const defs = new Map(schema(app).defs(locationId, t.key).map((d) => [d.key, d]));
  const parts = changed.map((k) => `${defs.get(k)?.label ?? k}: ${displayValue(defs.get(k), cur.properties[k]) || '–'} → ${displayValue(defs.get(k), next[k]) || '–'}`);
  if (ownerChanged) parts.push('Zuständig geändert');
  schema(app).log(locationId, t.key, rid, 'record.updated', parts.join(' · ').slice(0, 480), { changed }, opts.userId);
  if (!opts.quiet) {
    app.events.emit(locationId, 'record.updated', { recordId: rid, objectKey: t.key, objectLabel: t.singular, record, changed: ownerChanged ? [...changed, 'owner_id'] : changed });
    for (const k of changed) app.events.emit(locationId, 'record.property_changed', { recordId: rid, objectKey: t.key, objectLabel: t.singular, record, property: k, value: next[k] ?? null, previous: cur.properties[k] ?? null });
  }
  return record;
}

/** By id, then by any unique property value (dedupe), otherwise new. */
export function upsertRecord(app: App, locationId: string, t: any, input: { id?: string; properties?: Record<string, unknown>; owner_id?: string | null }, opts: RecordOpts = {}) {
  if (input.id) return { record: updateRecord(app, locationId, t, String(input.id), input, opts), created: false };
  const props = input.properties ?? {};
  for (const d of schema(app).defs(locationId, t.key).filter((x) => x.unique)) {
    const v = props[d.key];
    if (v === undefined || v === null || v === '') continue;
    const hit = app.db.get(`SELECT id FROM object_records WHERE type_id = ? AND lower(CAST(${jsonPath('properties', d.key)} AS TEXT)) = lower(?) LIMIT 1`, t.id, String(v).trim());
    if (hit) {
      // The matching value stays as stored (no case changes through a dedupe).
      const { [d.key]: _same, ...rest } = props;
      return { record: updateRecord(app, locationId, t, hit.id, { ...input, properties: rest }, opts), created: false };
    }
  }
  return { record: createRecord(app, locationId, t, input, opts), created: true };
}

export function deleteRecord(app: App, locationId: string, t: any, rid: string, opts: RecordOpts = {}) {
  const cur = getRecord(app, locationId, t.id, rid);
  if (!cur) throw notFound(`${t.singular} nicht gefunden`);
  // The delete trigger removes associations, notes and activity.
  app.db.run('DELETE FROM object_records WHERE id = ?', rid);
  if (!opts.quiet) app.events.emit(locationId, 'record.deleted', { recordId: rid, objectKey: t.key, objectLabel: t.singular, record: cur });
}

const recordExpr =
  (app: App, locationId: string, t: any): FieldExpr =>
  (field) => {
    if (field === 'created_at' || field === 'updated_at') return { sql: `r.${field}`, type: 'datetime' };
    if (field === 'owner_id') return { sql: 'r.owner_id', type: 'user' };
    if (field === 'display') return { sql: 'r.display', type: 'text' };
    const def = schema(app).defs(locationId, t.key).find((d) => d.key === field);
    return def ? { sql: jsonPath('r.properties', def.key), type: def.type } : undefined;
  };

export function listRecords(app: App, locationId: string, t: any, q: { q?: string; filters?: unknown; sort?: string; limit?: number; offset?: number; owner_id?: string }) {
  const expr = recordExpr(app, locationId, t);
  const where = ['r.type_id = ?', 'r.location_id = ?'];
  const params: unknown[] = [t.id, locationId];
  if (q.q) where.push('(r.display LIKE ? OR r.properties LIKE ?)'), params.push(`%${q.q}%`, `%${q.q}%`);
  if (q.owner_id) where.push('r.owner_id = ?'), params.push(q.owner_id);
  try {
    const f = filterSql(parseFilters(q.filters), expr);
    where.push(...f.where);
    params.push(...f.params);
  } catch (e) {
    if (e instanceof ValueError) throw bad(e.message);
    throw e;
  }
  const order = sortSql(q.sort, expr, 'r.updated_at DESC');
  const total = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM object_records r WHERE ${where.join(' AND ')}`, ...(params as any[]))!.n;
  const records = parseRows(
    app.db.all(`SELECT r.*, u.name AS owner_name FROM object_records r LEFT JOIN users u ON u.id = r.owner_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...(params as any[]), q.limit ?? 50, q.offset ?? 0),
    ['properties'],
  ).map((r): any => ({ ...r, object: t.key }));
  return { total, records };
}

export const customObjectsModule: Module = {
  name: 'custom-objects',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE object_types (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        key TEXT NOT NULL, singular TEXT NOT NULL, plural TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'layers',
        primary_property TEXT NOT NULL DEFAULT 'name', description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, key)
      );
      CREATE TABLE object_records (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        type_id TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
        properties TEXT NOT NULL DEFAULT '{}', display TEXT NOT NULL DEFAULT '', owner_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX object_records_type ON object_records(type_id, updated_at);
      CREATE INDEX object_records_display ON object_records(type_id, display COLLATE NOCASE);
      CREATE TRIGGER object_records_deleted AFTER DELETE ON object_records BEGIN
        DELETE FROM associations WHERE a_id = OLD.id OR b_id = OLD.id;
        DELETE FROM record_notes WHERE record_id = OLD.id;
        DELETE FROM record_activities WHERE record_id = OLD.id;
      END;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const A = assoc(app);
    const S = schema(app);

    const info = (t: any): ObjectInfo => ({ key: t.key, label: t.singular, plural: t.plural, icon: t.icon, builtin: false, primary: t.primary_property, id: t.id });
    S.registerObjects((loc) => objectTypes(app, loc).map(info));
    S.registerStore((o) => CUSTOM_OBJECT_RE.test(o), {
      table: 'object_records',
      column: 'properties',
      where: (loc, obj) => ['type_id = (SELECT id FROM object_types WHERE location_id = ? AND key = ?)', [loc, obj]],
    });
    A.registerProvider((loc) =>
      objectTypes(app, loc).map((t) => ({
        type: t.key,
        label: t.singular,
        plural: t.plural,
        icon: t.icon,
        get: (l: string, rid: string) => {
          const r = db.get('SELECT id, display FROM object_records WHERE id = ? AND location_id = ? AND type_id = ?', rid, l, t.id);
          return r ? { id: r.id, name: r.display || `${t.singular} ohne Namen`, sub: t.singular, link: `objects/${t.key}/${r.id}` } : undefined;
        },
        search: (l: string, q: string, limit: number) =>
          db.all('SELECT id, display FROM object_records WHERE location_id = ? AND type_id = ? AND (display LIKE ? OR properties LIKE ?) ORDER BY display LIMIT ?', l, t.id, `%${q}%`, `%${q}%`, limit).map((r) => ({ id: r.id, name: r.display || `${t.singular} ohne Namen`, sub: t.singular })),
      })),
    );
    A.onChange((c) => {
      if (c.kind === 'updated') return;
      for (const [me, other] of [
        [c.a, c.b],
        [c.b, c.a],
      ] as [Ref, Ref][]) {
        if (!CUSTOM_OBJECT_RE.test(me.type)) continue;
        const o = A.type(c.locationId, other.type);
        const name = o?.get(c.locationId, other.id)?.name;
        if (name) S.log(c.locationId, me.type, me.id, c.kind === 'linked' ? 'association.added' : 'association.removed', `${o!.label} „${name}“ ${c.kind === 'linked' ? 'verknüpft' : 'entfernt'}`);
      }
    });

    app.services.customObjects = {
      types: (loc: string) => objectTypes(app, loc),
      type: (loc: string, key: string) => objectType(app, loc, key),
      upsert: (loc: string, key: string, input: any, opts?: RecordOpts) => {
        const t = objectType(app, loc, key);
        if (!t) throw notFound('Objekttyp nicht gefunden');
        return upsertRecord(app, loc, t, input, opts);
      },
      update: (loc: string, key: string, rid: string, input: any, opts?: RecordOpts) => {
        const t = objectType(app, loc, key);
        if (!t) throw notFound('Objekttyp nicht gefunden');
        return updateRecord(app, loc, t, rid, input, opts);
      },
      get: (loc: string, key: string, rid: string) => {
        const t = objectType(app, loc, key);
        return t ? getRecord(app, loc, t.id, rid) : undefined;
      },
      list: (loc: string, key: string, q: any) => {
        const t = objectType(app, loc, key);
        if (!t) throw notFound('Objekttyp nicht gefunden');
        return listRecords(app, loc, t, q);
      },
    };

    const uid = (ctx: Ctx) => ctx.user?.id ?? null;
    const needType = (ctx: Ctx) => {
      const t = objectType(app, ctx.locationId, ctx.params.key);
      if (!t) throw notFound('Objekttyp nicht gefunden');
      return t;
    };
    const typeOut = (t: any) => ({
      ...t,
      properties: S.defs(t.location_id, t.key),
      groups: db.all('SELECT * FROM property_groups WHERE location_id = ? AND object_key = ? ORDER BY position, label', t.location_id, t.key),
      records: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM object_records WHERE type_id = ?', t.id)!.n,
    });

    // --- object types (schema: settings area) --------------------------------------------------
    const cleanIcon = (v: unknown) => {
      const s = String(v ?? '').trim();
      if (s && !/^[a-zA-Z0-9]{1,30}$/.test(s)) throw bad('Ungültiges Symbol');
      return s;
    };
    router.get('/api/object-types', 'location', (ctx) => objectTypes(app, ctx.locationId).map(typeOut));
    router.post('/api/object-types', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const singular = str(b.singular, 'Name (Einzahl)', { required: true, max: 60 });
      const plural = str(b.plural, 'Name (Mehrzahl)', { max: 60 }) || singular;
      const key = String(b.key ?? '').trim() || `p_${keyFromLabel(plural).slice(0, 40)}`;
      if (!CUSTOM_OBJECT_RE.test(key)) throw bad('Interner Name: p_ und dann a-z, 0-9, _');
      if (objectType(app, ctx.locationId, key)) throw bad(`Es gibt schon ein Objekt „${key}“`);
      if (objectTypes(app, ctx.locationId).length >= MAX_TYPES) throw bad(`Höchstens ${MAX_TYPES} eigene Objekte`);
      const primaryLabel = str(b.primary_label, 'Anzeige-Eigenschaft', { max: 100 }) || 'Name';
      const t = {
        id: id(),
        location_id: ctx.locationId,
        key,
        singular,
        plural,
        icon: cleanIcon(b.icon) || 'layers',
        primary_property: 'name',
        description: str(b.description, 'Beschreibung', { max: 500 }),
        position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM object_types WHERE location_id = ?', ctx.locationId)!.n,
        created_at: now(),
        updated_at: now(),
      };
      db.tx(() => {
        db.insert('object_types', t);
        db.insert('object_properties', { id: id(), location_id: ctx.locationId, object_key: key, key: 'name', label: primaryLabel, type: 'text', options: [], group_key: '', description: '', is_required: 1, is_unique: b.primary_unique ? 1 : 0, position: 0, created_at: now(), updated_at: now() });
      });
      // Extra properties in one go (API, MCP); each one is checked like on the properties page.
      const errors: string[] = [];
      for (const p of Array.isArray(b.properties) ? b.properties.slice(0, 100) : []) {
        try {
          S.createProperty(ctx.locationId, key, p);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      return { ...typeOut(objectType(app, ctx.locationId, t.id)), errors };
    });
    router.patch('/api/object-types/:id', 'location', (ctx) => {
      const t = objectType(app, ctx.locationId, ctx.params.id);
      if (!t) throw notFound('Objekttyp nicht gefunden');
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.singular !== undefined) patch.singular = str(b.singular, 'Name (Einzahl)', { required: true, max: 60 });
      if (b.plural !== undefined) patch.plural = str(b.plural, 'Name (Mehrzahl)', { required: true, max: 60 });
      if (b.icon !== undefined) patch.icon = cleanIcon(b.icon) || 'layers';
      if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { max: 500 });
      if (b.position !== undefined) patch.position = Number(b.position) || 0;
      if (b.primary_property !== undefined && b.primary_property !== t.primary_property) {
        const def = S.defs(ctx.locationId, t.key).find((d) => d.key === b.primary_property);
        if (!def || !PRIMARY_TYPES.includes(def.type)) throw bad('Anzeige-Eigenschaft: eine Text-, E-Mail-, Telefon-, URL-, Zahl- oder Datums-Eigenschaft wählen');
        patch.primary_property = def.key;
      }
      db.update('object_types', t.id, patch);
      if (patch.primary_property) db.run(`UPDATE object_records SET display = COALESCE(CAST(json_extract(properties, '$.' || ?) AS TEXT), '') WHERE type_id = ?`, patch.primary_property as string, t.id);
      return typeOut(objectType(app, ctx.locationId, t.id));
    });
    router.delete('/api/object-types/:id', 'location', (ctx) => {
      const t = objectType(app, ctx.locationId, ctx.params.id);
      if (!t) throw notFound('Objekttyp nicht gefunden');
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM object_records WHERE type_id = ?', t.id)!.n;
      if (n && ctx.query.get('force') !== '1') throw bad(`${t.plural} hat noch ${n} Datensätze – zum Löschen bestätigen (force=1)`);
      db.tx(() => {
        db.run('DELETE FROM object_types WHERE id = ?', t.id);
        for (const table of ['object_properties', 'property_groups', 'object_views']) db.run(`DELETE FROM ${table} WHERE location_id = ? AND object_key = ?`, ctx.locationId, t.key);
        db.run('DELETE FROM association_labels WHERE location_id = ? AND (a_type = ? OR b_type = ?)', ctx.locationId, t.key, t.key);
      });
      return { ok: true, deleted_records: n };
    });

    // --- records (contacts area) ------------------------------------------------------------------
    router.get('/api/objects', 'location', (ctx) => objectTypes(app, ctx.locationId).map(typeOut));
    const listQuery = (ctx: Ctx) => ({
      q: ctx.query.get('q') ?? '',
      filters: ctx.query.get('filters') ?? '',
      sort: ctx.query.get('sort') ?? '',
      owner_id: ctx.query.get('owner_id') ?? '',
      limit: clampLimit(ctx.query.get('limit'), 50, 500),
      offset: num(ctx.query.get('offset'), 0),
    });
    router.get('/api/objects/:key/records', 'location', (ctx) => listRecords(app, ctx.locationId, needType(ctx), listQuery(ctx)));
    router.post('/api/objects/:key/records', 'location', (ctx) => {
      const t = needType(ctx);
      const b = ctx.body ?? {};
      const r = upsertRecord(app, ctx.locationId, t, { id: b.id, properties: b.properties ?? {}, owner_id: b.owner_id }, { userId: uid(ctx) });
      for (const a of Array.isArray(b.associations) ? b.associations.slice(0, 100) : []) {
        A.link(ctx.locationId, { type: t.key, id: r.record.id }, { type: String(a?.type ?? ''), id: String(a?.id ?? '') }, { labels: a?.label ? [String(a.label)] : undefined, primary: !!a?.primary });
      }
      return { ...r.record, created: r.created };
    });
    router.get('/api/objects/:key/export.csv', 'location', (ctx) => {
      const t = needType(ctx);
      const { records } = listRecords(app, ctx.locationId, t, { ...listQuery(ctx), limit: 100000, offset: 0 });
      const defs = S.defs(ctx.locationId, t.key);
      const out = text(
        '﻿' + toCsv([['id', ...defs.map((d) => d.label), 'created_at'], ...records.map((r) => [r.id, ...defs.map((d) => displayValue(d, r.properties?.[d.key])), r.created_at])]),
        'text/csv; charset=utf-8',
      );
      out.headers['content-disposition'] = `attachment; filename="${t.key.slice(2)}.csv"`;
      return out;
    });
    router.post('/api/objects/:key/import', 'location', (ctx) => {
      const t = needType(ctx);
      const rows = parseCsv(String(ctx.body.csv ?? ''));
      if (rows.length < 2) throw bad('CSV braucht eine Kopfzeile und mindestens eine Zeile');
      if (rows.length > 20001) throw bad('Höchstens 20.000 Zeilen auf einmal');
      const defs = S.defs(ctx.locationId, t.key);
      const mapping: Record<number, string> = {};
      rows[0].forEach((h, i) => {
        const given = ctx.body.mapping?.[h];
        const k = h.trim().toLowerCase();
        const def = given ? defs.find((d) => d.key === given) : defs.find((d) => d.key === k || d.label.toLowerCase() === k);
        if (def) mapping[i] = def.key;
      });
      if (!Object.keys(mapping).length) throw bad(`Keine Spalte passt zu den Eigenschaften (${defs.map((d) => d.label).join(', ')})`);
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors: { row: number; error: string }[] = [];
      db.tx(() =>
        rows.slice(1).forEach((row, i) => {
          const props: Record<string, unknown> = {};
          for (const [col, key] of Object.entries(mapping)) {
            const v = row[Number(col)]?.trim();
            if (v) props[key] = v;
          }
          if (!Object.keys(props).length) return void skipped++;
          try {
            const r = upsertRecord(app, ctx.locationId, t, { properties: props }, { userId: uid(ctx), quiet: !ctx.body.triggerWorkflows });
            r.created ? created++ : updated++;
          } catch (e) {
            if (errors.length < 50) errors.push({ row: i + 2, error: (e as Error).message });
            skipped++;
          }
        }),
      );
      return { created, updated, skipped, errors, mapped: Object.values(mapping) };
    });
    router.get('/api/objects/:key/records/:id', 'location', (ctx) => {
      const t = needType(ctx);
      const r = getRecord(app, ctx.locationId, t.id, ctx.params.id);
      if (!r) throw notFound(`${t.singular} nicht gefunden`);
      return {
        ...r,
        object: t.key,
        type: typeOut(t),
        owner_name: r.owner_id ? (db.get('SELECT name FROM users WHERE id = ?', r.owner_id)?.name ?? null) : null,
        notes: S.notes(ctx.locationId, t.key, r.id),
        activities: S.activities(ctx.locationId, t.key, r.id, 200),
      };
    });
    router.patch('/api/objects/:key/records/:id', 'location', (ctx) => {
      const t = needType(ctx);
      return updateRecord(app, ctx.locationId, t, ctx.params.id, { properties: ctx.body?.properties, owner_id: ctx.body?.owner_id }, { userId: uid(ctx) });
    });
    router.delete('/api/objects/:key/records/:id', 'location', (ctx) => {
      deleteRecord(app, ctx.locationId, needType(ctx), ctx.params.id, { userId: uid(ctx) });
      return { ok: true };
    });
    router.post('/api/objects/:key/records/:id/notes', 'location', (ctx) => {
      const t = needType(ctx);
      if (!getRecord(app, ctx.locationId, t.id, ctx.params.id)) throw notFound(`${t.singular} nicht gefunden`);
      return S.addNote(ctx.locationId, t.key, ctx.params.id, str(ctx.body.body, 'Notiz', { required: true, max: 20000 }), uid(ctx));
    });
  },
};
