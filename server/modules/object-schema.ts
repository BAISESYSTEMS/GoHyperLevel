import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import {
  BUILTIN_OBJECTS,
  CONTACT_FIELD_TYPES,
  PROPERTY_TYPES,
  STANDARD_PROPS,
  ValueError,
  cleanPropertyDef,
  keyFromLabel,
  validateProps,
  type ObjectInfo,
  type PropertyDef,
} from '../services/objects.js';
import { hiddenUser } from '../core/permissions.js';

/**
 * Properties ("Eigenschaften", like HubSpot) for every object in one place: contact custom fields
 * (the existing table, extended by group and description), company and deal properties and the
 * properties of custom objects – with property groups. Also the generic parts every record type
 * shares: saved list views per user, notes, an activity log, deal property values and value
 * checks (types, required, unique). Exposed to other modules as `app.services.objectSchema`.
 */

/** Where an object keeps its property values (for unique checks and removing a deleted property). */
export interface PropertyStore {
  table: string;
  column: string;
  idColumn?: string;
  where: (locationId: string, object: string) => [sql: string, params: unknown[]];
}

export interface ObjectSchema {
  objects(locationId: string): ObjectInfo[];
  object(locationId: string, key: string): ObjectInfo | undefined;
  defs(locationId: string, object: string): PropertyDef[];
  /** Validated values ready to store (null = remove); throws HttpError 400 in German. */
  validate(locationId: string, object: string, input: unknown, opts?: { partial?: boolean; current?: Record<string, unknown>; recordId?: string }): Record<string, unknown>;
  log(locationId: string, object: string, recordId: string, type: string, summary: string, data?: Record<string, unknown>, userId?: string | null): void;
  activities(locationId: string, object: string, recordId: string, limit?: number): any[];
  notes(locationId: string, object: string, recordId: string): any[];
  addNote(locationId: string, object: string, recordId: string, body: string, userId?: string | null): any;
  /** Removes notes, activity and stored values of a deleted record. */
  forget(object: string, recordId: string): void;
  registerObjects(fn: (locationId: string) => ObjectInfo[]): void;
  /** Same checks as the properties page; throws HttpError 400. */
  createProperty(locationId: string, object: string, input: any): any;
  registerStore(match: (object: string) => boolean, store: PropertyStore): void;
  users(locationId: string): { id: string; name: string; email: string }[];
}

const OUT_JSON = ['options'];
const propOut = (r: any) => ({ ...parseJson(r, OUT_JSON), required: !!r.is_required, unique: !!r.is_unique, is_required: undefined, is_unique: undefined });

export function getObjectSchema(app: App): ObjectSchema {
  return app.services.objectSchema;
}

export const objectSchemaModule: Module = {
  name: 'object-schema',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE property_groups (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        object_key TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, UNIQUE(location_id, object_key, key)
      );
      CREATE TABLE object_properties (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        object_key TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text',
        options TEXT NOT NULL DEFAULT '[]', group_key TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        is_required INTEGER NOT NULL DEFAULT 0, is_unique INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, object_key, key)
      );
      CREATE TABLE object_views (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        object_key TEXT NOT NULL, user_id TEXT, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
        shared INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX object_views_loc ON object_views(location_id, object_key);
      CREATE TABLE record_notes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        object_key TEXT NOT NULL, record_id TEXT NOT NULL, body TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX record_notes_rec ON record_notes(record_id, created_at);
      CREATE TABLE record_activities (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        object_key TEXT NOT NULL, record_id TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}', user_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX record_activities_rec ON record_activities(record_id, created_at);
      CREATE TABLE record_props (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, object_key TEXT NOT NULL,
        record_id TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        PRIMARY KEY (object_key, record_id)
      );
      ALTER TABLE custom_fields ADD COLUMN group_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE custom_fields ADD COLUMN description TEXT NOT NULL DEFAULT '';
      CREATE TRIGGER record_props_opportunity_deleted AFTER DELETE ON opportunities BEGIN
        DELETE FROM record_props WHERE object_key = 'opportunity' AND record_id = OLD.id;
      END;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const providers: ((loc: string) => ObjectInfo[])[] = [];
    const stores: { match: (o: string) => boolean; store: PropertyStore }[] = [
      { match: (o) => o === 'opportunity', store: { table: 'record_props', column: 'props', idColumn: 'record_id', where: (loc) => [`location_id = ? AND object_key = 'opportunity'`, [loc]] } },
    ];

    const objects = (loc: string): ObjectInfo[] => [...BUILTIN_OBJECTS, ...providers.flatMap((p) => p(loc))];
    const object = (loc: string, key: string) => objects(loc).find((o) => o.key === key);
    const needObject = (loc: string, key: unknown) => {
      const o = object(loc, String(key ?? ''));
      if (!o) throw bad('Unbekanntes Objekt');
      return o;
    };

    const contactDefs = (loc: string): PropertyDef[] =>
      parseRows(db.all('SELECT * FROM custom_fields WHERE location_id = ? ORDER BY position, label', loc), OUT_JSON).map((f) => ({
        key: f.key,
        label: f.label,
        type: (CONTACT_FIELD_TYPES as string[]).includes(f.type) ? f.type : 'text',
        options: f.options ?? [],
        group_key: f.group_key ?? '',
        description: f.description ?? '',
        required: false,
        unique: false,
        position: f.position ?? 0,
      }));
    const defs = (loc: string, obj: string): PropertyDef[] =>
      obj === 'contact'
        ? contactDefs(loc)
        : db.all('SELECT * FROM object_properties WHERE location_id = ? AND object_key = ? ORDER BY position, created_at', loc, obj).map((r) => {
            const p = propOut(r);
            return { key: p.key, label: p.label, type: p.type, options: p.options, group_key: p.group_key, description: p.description, required: p.required, unique: p.unique, position: p.position };
          });

    const storeFor = (obj: string) => stores.find((s) => s.match(obj))?.store;

    const users = (loc: string) =>
      db
        .all(`SELECT id, name, email, role FROM users WHERE role = 'admin' OR EXISTS (SELECT 1 FROM json_each(users.locations) WHERE value = ?) ORDER BY name`, loc)
        .filter((u) => !hiddenUser(app, u, loc))
        .map((u) => ({ id: u.id, name: u.name, email: u.email }));

    const validate: ObjectSchema['validate'] = (loc, obj, input, opts = {}) => {
      const list = defs(loc, obj);
      let out: Record<string, unknown>;
      try {
        out = validateProps(list, (input ?? {}) as Record<string, unknown>, { ...opts, tz: app.location(loc)?.timezone || 'Europe/Berlin' });
      } catch (e) {
        if (e instanceof ValueError) throw bad(e.message);
        throw e;
      }
      const store = storeFor(obj);
      for (const d of list) {
        const v = out[d.key];
        if (v === null || v === undefined) continue;
        if (d.type === 'user' && !users(loc).some((u) => u.id === v)) throw bad(`„${d.label}“: Nutzer hat keinen Zugriff auf diesen Sub-Account`);
        if (d.type === 'file') {
          const up = db.get('SELECT id, name, file FROM uploads WHERE id = ? AND location_id = ?', String(v), loc);
          if (!up) throw bad(`„${d.label}“: Datei nicht gefunden (erst hochladen)`);
          out[d.key] = { id: up.id, name: up.name, url: `${app.baseUrl()}/uploads/${up.file}` };
        }
        if (d.unique && store) {
          const [w, p] = store.where(loc, obj);
          const idc = store.idColumn ?? 'id';
          const taken = db.get(
            `SELECT ${idc} AS id FROM ${store.table} WHERE ${w} AND json_extract(${store.column}, '$.${d.key}') = ?${opts.recordId ? ` AND ${idc} != ?` : ''} LIMIT 1`,
            ...(p as any[]),
            v as any,
            ...(opts.recordId ? [opts.recordId] : []),
          );
          if (taken) throw bad(`„${d.label}“ muss eindeutig sein – „${String(v).slice(0, 80)}“ gibt es schon`);
        }
      }
      return out;
    };

    const log: ObjectSchema['log'] = (loc, obj, recordId, type, summary, data = {}, userId = null) =>
      db.insert('record_activities', { id: id(), location_id: loc, object_key: obj, record_id: recordId, type, summary: summary.slice(0, 500), data, user_id: userId, created_at: now() });

    const schema: ObjectSchema = {
      objects,
      object,
      defs,
      validate,
      log,
      activities: (loc, obj, rid, limit = 100) =>
        parseRows(
          db.all('SELECT a.*, u.name AS user_name FROM record_activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.location_id = ? AND a.object_key = ? AND a.record_id = ? ORDER BY a.created_at DESC LIMIT ?', loc, obj, rid, limit),
          ['data'],
        ),
      notes: (loc, obj, rid) => db.all('SELECT n.*, u.name AS user_name FROM record_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.location_id = ? AND n.object_key = ? AND n.record_id = ? ORDER BY n.created_at DESC', loc, obj, rid),
      addNote: (loc, obj, rid, body, userId = null) => {
        const note = { id: id(), location_id: loc, object_key: obj, record_id: rid, body: body.slice(0, 20000), user_id: userId, created_at: now() };
        db.insert('record_notes', note);
        log(loc, obj, rid, 'note.added', 'Notiz hinzugefügt', {}, userId);
        return note;
      },
      forget: (obj, rid) => {
        db.run('DELETE FROM record_notes WHERE object_key = ? AND record_id = ?', obj, rid);
        db.run('DELETE FROM record_activities WHERE object_key = ? AND record_id = ?', obj, rid);
        db.run('DELETE FROM record_props WHERE object_key = ? AND record_id = ?', obj, rid);
      },
      registerObjects: (fn) => void providers.push(fn),
      createProperty: () => {
        throw new Error('not ready');
      },
      registerStore: (match, store) => void stores.unshift({ match, store }),
      users,
    };
    app.services.objectSchema = schema;

    // --- properties page --------------------------------------------------------------------
    const allProps = (loc: string) => [
      ...parseRows(db.all('SELECT * FROM custom_fields WHERE location_id = ? ORDER BY position, label', loc), OUT_JSON).map((f) => ({
        id: f.id,
        object_key: 'contact',
        key: f.key,
        label: f.label,
        type: f.type,
        options: f.options,
        group_key: f.group_key ?? '',
        description: f.description ?? '',
        required: false,
        unique: false,
        position: f.position,
        created_at: f.created_at,
      })),
      ...db.all('SELECT * FROM object_properties WHERE location_id = ? ORDER BY object_key, position, created_at', loc).map(propOut),
    ];

    router.get('/api/properties', 'location', (ctx) => {
      const only = ctx.query.get('object');
      const objs = objects(ctx.locationId);
      const props = allProps(ctx.locationId).filter((p) => !only || p.object_key === only);
      const groups = db.all('SELECT * FROM property_groups WHERE location_id = ? ORDER BY object_key, position, label', ctx.locationId).filter((g) => !only || g.object_key === only);
      return {
        objects: objs,
        types: PROPERTY_TYPES,
        contact_types: CONTACT_FIELD_TYPES,
        standard: Object.fromEntries(Object.entries(STANDARD_PROPS).filter(([k]) => !only || k === only)),
        groups,
        properties: props.map((p) => ({ ...p, standard: false })),
      };
    });

    const groupExists = (loc: string, obj: string, key: string) => !key || !!db.get('SELECT id FROM property_groups WHERE location_id = ? AND object_key = ? AND key = ?', loc, obj, key);
    const asBad = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof ValueError) throw bad(e.message);
        throw e;
      }
    };

    const RESERVED = ['id', 'created_at', 'updated_at', 'owner_id', 'display', 'object', 'type', 'properties'];
    const createProperty = (loc: string, objKey: string, body: any) => {
      const o = needObject(loc, objKey);
      const def = asBad(() => cleanPropertyDef(body, { types: o.key === 'contact' ? CONTACT_FIELD_TYPES : undefined }));
      if (!groupExists(loc, o.key, def.group_key)) throw bad('Gruppe nicht gefunden');
      if ((STANDARD_PROPS[o.key] ?? []).some((s) => s.key === def.key)) throw bad(`„${def.key}“ ist eine Standard-Eigenschaft`);
      if (o.key !== 'contact' && RESERVED.includes(def.key)) throw bad(`„${def.key}“ ist reserviert – bitte einen anderen internen Namen`);
      if (o.key === 'contact') {
        if (db.get('SELECT id FROM custom_fields WHERE location_id = ? AND key = ?', loc, def.key)) throw bad('Interner Name existiert schon');
        const row = { id: id(), location_id: loc, key: def.key, label: def.label, type: def.type, options: def.options, position: def.position, group_key: def.group_key, description: def.description, created_at: now() };
        db.insert('custom_fields', row);
        return { ...row, object_key: 'contact', required: false, unique: false };
      }
      if (db.get('SELECT id FROM object_properties WHERE location_id = ? AND object_key = ? AND key = ?', loc, o.key, def.key)) throw bad('Interner Name existiert schon');
      const row = {
        id: id(),
        location_id: loc,
        object_key: o.key,
        key: def.key,
        label: def.label,
        type: def.type,
        options: def.options,
        group_key: def.group_key,
        description: def.description,
        is_required: def.required ? 1 : 0,
        is_unique: def.unique ? 1 : 0,
        position: def.position || db.get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM object_properties WHERE location_id = ? AND object_key = ?', loc, o.key)!.n,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('object_properties', row);
      return propOut(db.get('SELECT * FROM object_properties WHERE id = ?', row.id));
    };
    schema.createProperty = createProperty;
    router.post('/api/properties', 'location', (ctx) => createProperty(ctx.locationId, ctx.body?.object, ctx.body ?? {}));

    const findProp = (loc: string, pid: string): { kind: 'object' | 'contact'; row: any } => {
      const p = db.get('SELECT * FROM object_properties WHERE id = ? AND location_id = ?', pid, loc);
      if (p) return { kind: 'object' as const, row: propOut(p) };
      const f = parseJson(db.get('SELECT * FROM custom_fields WHERE id = ? AND location_id = ?', pid, loc), OUT_JSON);
      if (f) return { kind: 'contact' as const, row: { ...f, object_key: 'contact', required: false, unique: false } };
      throw notFound('Eigenschaft nicht gefunden');
    };

    router.patch('/api/properties/:id', 'location', (ctx) => {
      const found = findProp(ctx.locationId, ctx.params.id);
      const cur = found.row;
      // The internal name and the type of a contact field stay; a type change elsewhere must fit the stored values.
      const def = asBad(() => cleanPropertyDef({ ...ctx.body, key: cur.key }, { existing: { ...cur, key: cur.key }, types: found.kind === 'contact' ? CONTACT_FIELD_TYPES : undefined }));
      if (!groupExists(ctx.locationId, cur.object_key, def.group_key)) throw bad('Gruppe nicht gefunden');
      if (found.kind === 'contact') {
        db.update('custom_fields', cur.id, { label: def.label, type: def.type, options: def.options, position: def.position, group_key: def.group_key, description: def.description }, ctx.locationId);
        return { ...parseJson(db.get('SELECT * FROM custom_fields WHERE id = ?', cur.id), OUT_JSON), object_key: 'contact', required: false, unique: false };
      }
      if (def.unique && !cur.unique) {
        const store = storeFor(cur.object_key);
        if (store) {
          const [w, p] = store.where(ctx.locationId, cur.object_key);
          const dup = db.get(
            `SELECT json_extract(${store.column}, '$.${cur.key}') AS v, COUNT(*) AS n FROM ${store.table} WHERE ${w} AND json_extract(${store.column}, '$.${cur.key}') IS NOT NULL GROUP BY v HAVING n > 1 LIMIT 1`,
            ...(p as any[]),
          );
          if (dup) throw bad(`Nicht eindeutig: „${String(dup.v).slice(0, 80)}“ kommt ${dup.n}× vor`);
        }
      }
      db.update('object_properties', cur.id, { label: def.label, type: def.type, options: def.options, group_key: def.group_key, description: def.description, is_required: def.required ? 1 : 0, is_unique: def.unique ? 1 : 0, position: def.position, updated_at: now() }, ctx.locationId);
      return propOut(db.get('SELECT * FROM object_properties WHERE id = ?', cur.id));
    });

    router.delete('/api/properties/:id', 'location', (ctx) => {
      const found = findProp(ctx.locationId, ctx.params.id);
      if (found.kind === 'contact') {
        // Same as Settings → Felder: the values stay on the contacts.
        db.run('DELETE FROM custom_fields WHERE id = ?', found.row.id);
        return { ok: true };
      }
      const p = found.row;
      const store = storeFor(p.object_key);
      db.tx(() => {
        if (store) {
          const [w, params] = store.where(ctx.locationId, p.object_key);
          db.run(`UPDATE ${store.table} SET ${store.column} = json_remove(${store.column}, '$.${p.key}') WHERE ${w} AND json_extract(${store.column}, '$.${p.key}') IS NOT NULL`, ...(params as any[]));
        }
        db.run('DELETE FROM object_properties WHERE id = ?', p.id);
      });
      return { ok: true };
    });

    // --- property groups --------------------------------------------------------------------
    router.post('/api/property-groups', 'location', (ctx) => {
      const o = needObject(ctx.locationId, ctx.body.object);
      const label = str(ctx.body.label, 'Name', { required: true, max: 80 });
      const key = (str(ctx.body.key, 'Interner Name') || keyFromLabel(label)).slice(0, 60);
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw bad('Interner Name: nur a-z, 0-9 und _');
      if (db.get('SELECT id FROM property_groups WHERE location_id = ? AND object_key = ? AND key = ?', ctx.locationId, o.key, key)) throw bad('Gruppe existiert schon');
      const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM property_groups WHERE location_id = ? AND object_key = ?', ctx.locationId, o.key)!.n;
      const row = { id: id(), location_id: ctx.locationId, object_key: o.key, key, label, position: Number(ctx.body.position ?? pos) || pos, created_at: now() };
      db.insert('property_groups', row);
      return row;
    });
    router.patch('/api/property-groups/:id', 'location', (ctx) => {
      const patch: Record<string, unknown> = {};
      if (ctx.body.label !== undefined) patch.label = str(ctx.body.label, 'Name', { required: true, max: 80 });
      if (ctx.body.position !== undefined) patch.position = Number(ctx.body.position) || 0;
      if (!db.update('property_groups', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return db.get('SELECT * FROM property_groups WHERE id = ?', ctx.params.id);
    });
    router.delete('/api/property-groups/:id', 'location', (ctx) => {
      const g = db.get('SELECT * FROM property_groups WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!g) throw notFound();
      db.tx(() => {
        if (g.object_key === 'contact') db.run(`UPDATE custom_fields SET group_key = '' WHERE location_id = ? AND group_key = ?`, g.location_id, g.key);
        else db.run(`UPDATE object_properties SET group_key = '' WHERE location_id = ? AND object_key = ? AND group_key = ?`, g.location_id, g.object_key, g.key);
        db.run('DELETE FROM property_groups WHERE id = ?', g.id);
      });
      return { ok: true };
    });

    // Team members of the sub-account (owner/user properties) – everyone in the sub-account may see them.
    router.get('/api/location-users', 'location', (ctx) => users(ctx.locationId));

    // --- saved list views (per user, optionally shared) ---------------------------------------
    const cleanView = (b: any) => {
      const c = b?.config ?? {};
      return {
        columns: Array.isArray(c.columns) ? c.columns.map(String).slice(0, 40) : [],
        filters: Array.isArray(c.filters) ? c.filters.slice(0, 30).map((f: any) => ({ field: String(f?.field ?? ''), op: String(f?.op ?? 'eq'), value: f?.value ?? '' })) : [],
        sort: String(c.sort ?? '').slice(0, 80),
        q: String(c.q ?? '').slice(0, 200),
      };
    };
    const userKey = (ctx: Ctx) => ctx.user?.id ?? (ctx.viaApiKey ? 'api' : null);
    const canEditView = (ctx: Ctx, v: any) => v.user_id === userKey(ctx) || ctx.user?.role === 'admin';
    router.get('/api/object-views', 'location', (ctx) => {
      const obj = String(ctx.query.get('object') ?? '');
      return parseRows(
        db.all('SELECT * FROM object_views WHERE location_id = ? AND object_key = ? AND (user_id IS ? OR shared = 1) ORDER BY name', ctx.locationId, obj, userKey(ctx)),
        ['config'],
      ).map((v) => ({ ...v, shared: !!v.shared, mine: v.user_id === userKey(ctx) }));
    });
    router.post('/api/object-views', 'location', (ctx) => {
      const o = needObject(ctx.locationId, ctx.body.object);
      const row = { id: id(), location_id: ctx.locationId, object_key: o.key, user_id: userKey(ctx), name: str(ctx.body.name, 'Name', { required: true, max: 80 }), config: cleanView(ctx.body), shared: ctx.body.shared ? 1 : 0, created_at: now(), updated_at: now() };
      db.insert('object_views', row);
      return { ...row, shared: !!row.shared, mine: true };
    });
    router.patch('/api/object-views/:id', 'location', (ctx) => {
      const v = db.get('SELECT * FROM object_views WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v) throw notFound();
      if (!canEditView(ctx, v)) throw new HttpError(403, 'Nur die eigene Ansicht ändern');
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
      if (ctx.body.config !== undefined) patch.config = cleanView(ctx.body);
      if (ctx.body.shared !== undefined) patch.shared = ctx.body.shared ? 1 : 0;
      db.update('object_views', v.id, patch);
      const out: any = parseJson(db.get('SELECT * FROM object_views WHERE id = ?', v.id), ['config']);
      return { ...out, shared: !!out.shared, mine: out.user_id === userKey(ctx) };
    });
    router.delete('/api/object-views/:id', 'location', (ctx) => {
      const v = db.get('SELECT * FROM object_views WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v) throw notFound();
      if (!canEditView(ctx, v)) throw new HttpError(403, 'Nur die eigene Ansicht löschen');
      db.run('DELETE FROM object_views WHERE id = ?', v.id);
      return { ok: true };
    });

    // --- notes of companies and custom records -----------------------------------------------
    router.delete('/api/record-notes/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM record_notes WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound();
      return { ok: true };
    });

    // --- deal (opportunity) property values ----------------------------------------------------
    const opp = (loc: string, oid: string) => {
      const o = db.get('SELECT id FROM opportunities WHERE id = ? AND location_id = ?', oid, loc);
      if (!o) throw notFound('Opportunity nicht gefunden');
      return o;
    };
    const oppProps = (oid: string): Record<string, unknown> => parseJson(db.get('SELECT props FROM record_props WHERE object_key = ? AND record_id = ?', 'opportunity', oid), ['props'])?.props ?? {};
    router.get('/api/opportunities/:id/properties', 'location', (ctx) => {
      opp(ctx.locationId, ctx.params.id);
      return { properties: oppProps(ctx.params.id), definitions: defs(ctx.locationId, 'opportunity') };
    });
    router.put('/api/opportunities/:id/properties', 'location', (ctx) => {
      opp(ctx.locationId, ctx.params.id);
      const cur = oppProps(ctx.params.id);
      const patch = validate(ctx.locationId, 'opportunity', ctx.body?.properties ?? ctx.body, { partial: true, current: cur, recordId: ctx.params.id });
      const next = { ...cur };
      for (const [k, v] of Object.entries(patch)) v === null ? delete next[k] : (next[k] = v);
      db.run(
        `INSERT INTO record_props (location_id, object_key, record_id, props, updated_at) VALUES (?, 'opportunity', ?, ?, ?)
         ON CONFLICT(object_key, record_id) DO UPDATE SET props = excluded.props, updated_at = excluded.updated_at`,
        ctx.locationId,
        ctx.params.id,
        JSON.stringify(next),
        now(),
      );
      // Keeps the deal's "last changed" in step so mirrors and lists see the change.
      db.run('UPDATE opportunities SET updated_at = ? WHERE id = ?', now(), ctx.params.id);
      return { properties: next };
    });
  },
};
