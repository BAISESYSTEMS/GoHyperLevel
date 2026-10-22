import type { App } from '../core/app.js';
import { id, now } from '../core/util.js';
import { CUSTOM_OBJECT_RE, ValueError, coerceValue, keyFromLabel, type PropertyDef } from './objects.js';
import type { RObjectLink, RObjectRecord, RObjectType } from './umzug-core.js';
import type { ExtraEnv, Host, UndoHelpers } from './umzug-extra.js';
import { clip } from './umzug-text.js';

/**
 * Tables and databases of the switch-over importers (Airtable tables, Notion databases) as custom objects: an object type with
 * typed properties, its records (through the objects' own upsert, quiet: no workflow events) and the links between records
 * (linked records / relations) as associations. A select value the table has but the definition lacks becomes a new option instead
 * of being lost; a value that does not fit its type is left out and noted. A record a person has changed since the import stays
 * as they left it (the stamp of the last write is kept in the id map).
 */

const MAX_TYPES = 50;
const MAX_PROPS = 100;
const RESERVED = new Set(['id', 'created_at', 'updated_at', 'owner_id', 'display', 'object', 'type', 'properties', 'name']);

type Defs = Map<string, PropertyDef>;

export class ObjectsWriter {
  private readonly app: App;
  private readonly db: App['db'];
  private readonly loc: string;
  private ready: boolean | undefined;
  private readonly defs = new Map<string, Defs>();
  private readonly told = new Set<string>();

  constructor(
    private env: ExtraEnv,
    private host: Host,
  ) {
    this.app = env.app;
    this.db = env.app.db;
    this.loc = env.locationId;
  }

  private available(): boolean {
    this.ready ??= !!this.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'object_types'") && !!this.app.services.customObjects && !!this.app.services.objectSchema && !!this.app.services.associations;
    return this.ready;
  }

  private defsOf(typeKey: string, fresh = false): Defs {
    let d = this.defs.get(typeKey);
    if (!d || fresh) {
      d = new Map((this.app.services.objectSchema.defs(this.loc, typeKey) as PropertyDef[]).map((x) => [x.key, x]));
      this.defs.set(typeKey, d);
    }
    return d;
  }

  private tell(key: string, message: string) {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.env.warn(message);
  }

  // --- object types -----------------------------------------------------------------------------------------------

  type(rec: RObjectType) {
    const known = this.host.getId('object_type', rec.ext);
    if (this.env.dry) {
      this.host.stat('object_types', known ? 'updated' : 'created');
      return void this.host.virtual.add(`object_type:${rec.ext}`);
    }
    if (!this.available()) {
      this.host.stat('object_types', 'skipped');
      return void this.env.warn(`Tabelle „${clip(rec.singular, 60)}“ nicht angelegt: eigene Objekte sind in dieser Installation nicht verfügbar`);
    }
    const there = known && !known.local.startsWith('dry:') ? this.db.get<{ id: string; key: string }>('SELECT id, key FROM object_types WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    let key: string;
    if (there) {
      key = there.key;
      this.host.stat('object_types', 'updated');
    } else {
      const singular = clip(rec.singular, 60).trim() || 'Eintrag';
      const plural = clip(rec.plural || rec.singular, 60).trim() || singular;
      if (Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM object_types WHERE location_id = ?', this.loc)?.n) >= MAX_TYPES) throw new Error(`Höchstens ${MAX_TYPES} eigene Objekte – „${plural}“ passt nicht mehr hinein`);
      const base = `p_${keyFromLabel(plural)}`.slice(0, 38);
      key = base;
      for (let i = 2; this.db.get('SELECT 1 FROM object_types WHERE location_id = ? AND key = ?', this.loc, key); i++) key = `${base}_${i}`;
      if (!CUSTOM_OBJECT_RE.test(key)) key = `p_${id(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
      const primary = rec.properties.find((p) => p.primary) ?? rec.properties.find((p) => ['text', 'email', 'phone', 'url', 'number', 'date'].includes(p.type)) ?? rec.properties[0];
      const tid = id();
      this.db.tx(() => {
        this.db.insert('object_types', {
          id: tid,
          location_id: this.loc,
          key,
          singular,
          plural,
          icon: 'layers',
          primary_property: 'name',
          description: clip(rec.description || `Aus ${this.env.label} übernommen`, 500),
          position: this.db.get<{ n: number }>('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM object_types WHERE location_id = ?', this.loc)!.n,
          created_at: now(),
          updated_at: now(),
        });
        this.db.insert('object_properties', { id: id(), location_id: this.loc, object_key: key, key: 'name', label: clip(primary?.label || 'Name', 100), type: 'text', options: [], group_key: '', description: '', is_required: 0, is_unique: 0, position: 0, created_at: now(), updated_at: now() });
      });
      this.host.setId('object_type', rec.ext, tid, key);
      this.host.item('object_type', tid, rec.ext, true);
      if (primary) this.host.setId('object_prop', `${rec.ext}:${primary.ext}`, 'name');
      this.host.stat('object_types', 'created');
    }
    const have = this.defsOf(key, true);
    const used = new Set(have.keys());
    const primary = rec.properties.find((p) => p.primary) ?? rec.properties.find((p) => ['text', 'email', 'phone', 'url', 'number', 'date'].includes(p.type)) ?? rec.properties[0];
    let n = have.size;
    for (const p of rec.properties) {
      if (p === primary && !there) continue;
      if (there && this.host.getId('object_prop', `${rec.ext}:${p.ext}`)) continue;
      if (n >= MAX_PROPS) {
        this.tell(`props:${rec.ext}`, `„${clip(rec.singular, 60)}“: mehr als ${MAX_PROPS} Spalten – die übrigen wurden nicht übernommen`);
        break;
      }
      let pk = keyFromLabel(p.label).slice(0, 56);
      if (RESERVED.has(pk)) pk = `${pk}_2`;
      for (let i = 2; used.has(pk); i++) pk = `${keyFromLabel(p.label).slice(0, 54)}_${i}`;
      try {
        this.app.services.objectSchema.createProperty(this.loc, key, { key: pk, label: clip(p.label, 100) || pk, type: p.type, options: p.options ?? [] });
        used.add(pk);
        n++;
        this.host.setId('object_prop', `${rec.ext}:${p.ext}`, pk);
      } catch (e) {
        this.tell(`prop:${rec.ext}:${p.ext}`, `Spalte „${clip(p.label, 40)}“ in „${clip(rec.singular, 40)}“ nicht angelegt: ${(e as Error).message}`);
      }
    }
    this.defsOf(key, true);
  }

  // --- records ----------------------------------------------------------------------------------------------------

  /** One value checked for its property; a select value that is not a choice yet becomes one. Returns undefined when it cannot be kept. */
  private value(typeKey: string, d: PropertyDef, raw: unknown, where: string): unknown {
    try {
      return coerceValue(d, raw, this.app.location(this.loc)?.timezone || 'Europe/Berlin');
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      if (d.type === 'select' || d.type === 'multiselect') {
        const wanted = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).trim()).filter(Boolean);
        const options = [...d.options];
        for (const w of wanted) if (!options.some((o) => o.toLowerCase() === w.toLowerCase()) && options.length < 200) options.push(w.slice(0, 100));
        if (options.length !== d.options.length) {
          this.db.run('UPDATE object_properties SET options = ?, updated_at = ? WHERE location_id = ? AND object_key = ? AND key = ?', JSON.stringify(options), now(), this.loc, typeKey, d.key);
          d.options = options;
          try {
            return coerceValue(d, raw, this.app.location(this.loc)?.timezone || 'Europe/Berlin');
          } catch {
            /* falls through to "left out" */
          }
        }
      }
      this.tell(`val:${typeKey}:${d.key}`, `${where}: ein Wert in „${d.label}“ passt nicht zum Typ und wurde weggelassen (${e.message.slice(0, 100)})`);
      return undefined;
    }
  }

  record(rec: RObjectRecord) {
    const known = this.host.getId('object_record', rec.ext);
    if (this.env.dry) {
      this.host.stat('object_records', known ? 'updated' : 'created');
      return void this.host.virtual.add(`object_record:${rec.ext}`);
    }
    const t = this.host.getId('object_type', rec.type);
    if (!t || t.local.startsWith('dry:') || !t.extra) {
      this.host.stat('object_records', 'skipped');
      return void this.tell(`notype:${rec.type}`, `Datensätze übersprungen: die Tabelle „${clip(rec.type, 40)}“ ist nicht angelegt`);
    }
    const typeKey = t.extra;
    const defs = this.defsOf(typeKey);
    const where = `Tabelle „${typeKey.slice(2)}“`;
    const props: Record<string, unknown> = {};
    for (const [pext, raw] of Object.entries(rec.values)) {
      const pk = this.host.getId('object_prop', `${rec.type}:${pext}`)?.local;
      const d = pk ? defs.get(pk) : undefined;
      if (!pk || !d) continue;
      const v = this.value(typeKey, d, raw, where);
      if (v !== undefined) props[pk] = v;
    }
    const objects = this.app.services.customObjects;
    const row = known ? this.db.get<{ id: string; updated_at: string }>('SELECT id, updated_at FROM object_records WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    if (row) {
      if (known!.extra && row.updated_at !== known!.extra) {
        this.host.stat('object_records', 'skipped');
        return;
      }
      const out = objects.update(this.loc, typeKey, row.id, { properties: props }, { quiet: true });
      this.host.setId('object_record', rec.ext, row.id, String(out.updated_at ?? ''));
      this.host.stat('object_records', 'updated');
      return;
    }
    const { record } = objects.upsert(this.loc, typeKey, { properties: props }, { quiet: true });
    const created = rec.created_at && !Number.isNaN(Date.parse(rec.created_at)) ? new Date(rec.created_at).toISOString() : undefined;
    const at = now();
    this.db.update('object_records', record.id, { ...(created ? { created_at: created } : {}), updated_at: at }, this.loc);
    this.host.setId('object_record', rec.ext, record.id, at);
    this.host.item('object_record', record.id, rec.ext, true);
    this.host.stat('object_records', 'created');
  }

  // --- links ------------------------------------------------------------------------------------------------------

  link(rec: RObjectLink) {
    if (this.env.dry) return void this.host.stat('object_links', 'created');
    const a = this.host.getId('object_record', rec.a);
    const b = this.host.getId('object_record', rec.b);
    if (!a || !b || a.local === b.local) return void this.host.stat('object_links', 'skipped');
    const of = (rid: string) => this.db.get<{ key: string }>('SELECT t.key AS key FROM object_records r JOIN object_types t ON t.id = r.type_id WHERE r.id = ? AND r.location_id = ?', rid, this.loc)?.key;
    const ta = of(a.local);
    const tb = of(b.local);
    if (!ta || !tb) return void this.host.stat('object_links', 'skipped');
    const A = this.app.services.associations;
    if ((A.ids(this.loc, { type: ta, id: a.local }, tb) as string[]).includes(b.local)) return void this.host.stat('object_links', 'updated');
    A.link(this.loc, { type: ta, id: a.local }, { type: tb, id: b.local });
    this.host.stat('object_links', 'created');
  }
}

// --- undo ---------------------------------------------------------------------------------------------------------

type Item = { kind: string; local_id: string; ext_id: string; created: number };

/** Records first (their links, notes and history go with them), then the object types nobody uses any more. */
export function undoObjects(app: App, loc: string, items: Item[], h: UndoHelpers) {
  const db = app.db;
  for (const it of items.filter((i) => i.kind === 'object_record' && i.created)) {
    try {
      if (db.get('SELECT 1 FROM record_notes WHERE record_id = ? LIMIT 1', it.local_id)) {
        h.keep('object_records');
        h.notes.push('Datensätze bleiben, weil dazu inzwischen Notizen geschrieben wurden.');
        continue;
      }
      if (db.run('DELETE FROM object_records WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (h.del('object_records'), h.gone.push(it.local_id));
    } catch {
      /* custom objects not installed */
    }
  }
  for (const it of items.filter((i) => i.kind === 'object_type' && i.created)) {
    try {
      const t = db.get<{ key: string }>('SELECT key FROM object_types WHERE id = ? AND location_id = ?', it.local_id, loc);
      if (!t) continue;
      if (db.get('SELECT 1 FROM object_records WHERE type_id = ? LIMIT 1', it.local_id)) {
        h.keep('object_types');
        h.notes.push('Ein eigenes Objekt bleibt, weil es noch Datensätze enthält, die nicht aus dem Umzug stammen.');
        continue;
      }
      db.tx(() => {
        db.run('DELETE FROM object_types WHERE id = ?', it.local_id);
        for (const table of ['object_properties', 'property_groups', 'object_views']) db.run(`DELETE FROM ${table} WHERE location_id = ? AND object_key = ?`, loc, t.key);
        db.run('DELETE FROM association_labels WHERE location_id = ? AND (a_type = ? OR b_type = ?)', loc, t.key, t.key);
      });
      h.del('object_types');
      h.gone.push(it.local_id);
    } catch {
      /* custom objects not installed */
    }
  }
}
