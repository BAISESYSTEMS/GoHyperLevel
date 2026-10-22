import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { contactName } from '../services/contacts.js';

/**
 * Associations like HubSpot's: links between any two records – contacts, companies, deals, tasks,
 * custom object records and types other modules register (e.g. "ticket" from a helpdesk) – with
 * optional labels ("Entscheider", "Rechnungsempfänger") and a primary flag (a contact's primary
 * company). Other modules use `app.services.associations` (see AssociationsService).
 */

export interface Ref {
  type: string;
  id: string;
}
export interface RecordInfo {
  id: string;
  name: string;
  sub?: string;
  /** App route (without /app/) of the record's page. */
  link?: string;
}
export interface AssocType {
  type: string;
  label: string;
  plural: string;
  icon?: string;
  /** Deleting a row in this table removes its associations (a trigger is created once). */
  table?: string;
  get(locationId: string, recordId: string): RecordInfo | undefined;
  search?(locationId: string, q: string, limit: number): RecordInfo[];
}
export interface Linked extends RecordInfo {
  association_id: string;
  type: string;
  record_id: string;
  labels: { id: string; name: string }[];
  /** This link is the primary one for `primary_for` (e.g. the contact whose primary company it is). */
  primary: boolean;
  primary_for: string;
  created_at: string;
}
export type AssocChange = { kind: 'linked' | 'unlinked' | 'updated'; locationId: string; a: Ref; b: Ref; primaryOf: string };

export interface AssociationsService {
  registerType(def: AssocType): void;
  /** Types that differ per sub-account (custom objects). */
  registerProvider(fn: (locationId: string) => AssocType[]): void;
  types(locationId: string): AssocType[];
  type(locationId: string, type: string): AssocType | undefined;
  exists(locationId: string, ref: Ref): boolean;
  link(locationId: string, a: Ref, b: Ref, opts?: { labels?: string[]; primary?: boolean; addLabels?: boolean }): any;
  unlink(locationId: string, a: Ref, b: Ref): boolean;
  list(locationId: string, ref: Ref, opts?: { type?: string; label?: string }): Linked[];
  ids(locationId: string, ref: Ref, type: string): string[];
  primary(locationId: string, from: Ref, type: string): string | undefined;
  setPrimary(locationId: string, from: Ref, to: Ref): void;
  removeAll(ref: Ref): number;
  labels(locationId: string, aType?: string, bType?: string): { id: string; name: string; a_type: string; b_type: string }[];
  /** Synchronous listeners (e.g. companies keep contacts.company in step). */
  onChange(fn: (c: AssocChange) => void): void;
  /** Delete trigger for a table; without `type` it matches the record id alone. */
  cascade(table: string, type?: string): void;
}

const ord = (a: Ref, b: Ref): [Ref, Ref] => (`${a.type}\u0000${a.id}` <= `${b.type}\u0000${b.id}` ? [a, b] : [b, a]);
const pairTypes = (x: string, y: string): [string, string] => (x <= y ? [x, y] : [y, x]);
const TYPE_RE = /^[a-z][a-z0-9_]{0,40}$/;

export const associationsModule: Module = {
  name: 'associations',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE associations (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        a_type TEXT NOT NULL, a_id TEXT NOT NULL, b_type TEXT NOT NULL, b_id TEXT NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]', primary_of TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        UNIQUE(location_id, a_type, a_id, b_type, b_id)
      );
      CREATE INDEX associations_a ON associations(a_id, b_type);
      CREATE INDEX associations_b ON associations(b_id, a_type);
      CREATE TABLE association_labels (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        a_type TEXT NOT NULL, b_type TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(location_id, a_type, b_type, name)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fixed = new Map<string, AssocType>();
    const providers: ((loc: string) => AssocType[])[] = [];
    const listeners: ((c: AssocChange) => void)[] = [];

    const cascade = (table: string, type?: string) => {
      if (!/^[a-z_]+$/.test(table) || (type && !TYPE_RE.test(type))) throw new Error('associations.cascade: ungültiger Name');
      const name = `assoc_cascade_${table}${type ? `_${type}` : ''}`;
      const cond = type ? `(a_type = '${type}' AND a_id = OLD.id) OR (b_type = '${type}' AND b_id = OLD.id)` : `a_id = OLD.id OR b_id = OLD.id`;
      db.raw.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER DELETE ON ${table} BEGIN DELETE FROM associations WHERE ${cond}; END;`);
    };

    const types = (loc: string) => [...fixed.values(), ...providers.flatMap((p) => p(loc))];
    const type = (loc: string, t: string) => fixed.get(t) ?? providers.flatMap((p) => p(loc)).find((x) => x.type === t);
    const exists = (loc: string, ref: Ref) => !!type(loc, ref.type)?.get(loc, ref.id);
    const notify = (c: AssocChange) => {
      for (const fn of listeners) {
        try {
          fn(c);
        } catch (e) {
          console.error('[associations]', e);
        }
      }
    };
    const rowFor = (loc: string, a: Ref, b: Ref) => {
      const [x, y] = ord(a, b);
      return db.get('SELECT * FROM associations WHERE location_id = ? AND a_type = ? AND a_id = ? AND b_type = ? AND b_id = ?', loc, x.type, x.id, y.type, y.id);
    };
    const labelRows = (loc: string, t1: string, t2: string) => {
      const [x, y] = pairTypes(t1, t2);
      return db.all('SELECT id, name, a_type, b_type FROM association_labels WHERE location_id = ? AND a_type = ? AND b_type = ? ORDER BY name', loc, x, y);
    };
    /** Label ids from ids or names (case-insensitive) valid for this pair of types. */
    const resolveLabels = (loc: string, a: Ref, b: Ref, input: string[]) => {
      const avail = labelRows(loc, a.type, b.type);
      return [
        ...new Set(
          input.map((l) => {
            const s = String(l).trim();
            const hit = avail.find((x) => x.id === s || x.name.toLowerCase() === s.toLowerCase());
            if (!hit) throw bad(`Unbekanntes Label „${s.slice(0, 60)}“ für ${a.type} ↔ ${b.type}`);
            return hit.id;
          }),
        ),
      ];
    };
    const contactOf = (a: Ref, b: Ref) => (a.type === 'contact' ? a.id : b.type === 'contact' ? b.id : undefined);

    const setPrimary = (loc: string, from: Ref, to: Ref) => {
      const row = rowFor(loc, from, to);
      if (!row) throw bad('Nicht verknüpft');
      // No transaction here: callers may already be inside one (imports, merges, snapshots).
      db.run(
        `UPDATE associations SET primary_of = '' WHERE location_id = ? AND primary_of = ? AND ((a_id = ? AND b_type = ?) OR (b_id = ? AND a_type = ?))`,
        loc,
        from.id,
        from.id,
        to.type,
        from.id,
        to.type,
      );
      db.run('UPDATE associations SET primary_of = ? WHERE id = ?', from.id, row.id);
      notify({ kind: 'updated', locationId: loc, a: from, b: to, primaryOf: from.id });
    };

    const service: AssociationsService = {
      registerType(def) {
        if (!TYPE_RE.test(def.type) || def.type.startsWith('p_')) throw new Error(`associations: Typ „${def.type}“ ungültig (p_ ist eigenen Objekten vorbehalten)`);
        fixed.set(def.type, def);
        if (def.table) cascade(def.table, def.type);
      },
      registerProvider: (fn) => void providers.push(fn),
      types,
      type,
      exists,
      link(loc, a, b, opts = {}) {
        if (a.type === b.type && a.id === b.id) throw bad('Ein Datensatz kann nicht mit sich selbst verknüpft werden');
        for (const r of [a, b]) {
          const t = type(loc, r.type);
          if (!t) throw bad(`Unbekannter Objekttyp: ${r.type}`);
          if (!t.get(loc, r.id)) throw notFound(`${t.label} nicht gefunden`);
        }
        const labels = opts.labels ? resolveLabels(loc, a, b, opts.labels) : undefined;
        const cur = rowFor(loc, a, b);
        const [x, y] = ord(a, b);
        let row = cur;
        if (!cur) {
          row = { id: id(), location_id: loc, a_type: x.type, a_id: x.id, b_type: y.type, b_id: y.id, labels: labels ?? [], primary_of: '', created_at: now() };
          db.insert('associations', row);
          row = db.get('SELECT * FROM associations WHERE id = ?', row.id);
          notify({ kind: 'linked', locationId: loc, a, b, primaryOf: '' });
          app.events.emit(loc, 'association.created', { contactId: contactOf(a, b), from: a, to: b, labels: labels ?? [] });
        } else if (labels) {
          const old: string[] = JSON.parse(cur.labels || '[]');
          const next = opts.addLabels ? [...new Set([...old, ...labels])] : labels;
          db.run('UPDATE associations SET labels = ? WHERE id = ?', JSON.stringify(next), cur.id);
        }
        if (opts.primary) setPrimary(loc, a, b);
        return parseJson(db.get('SELECT * FROM associations WHERE id = ?', row!.id), ['labels']);
      },
      unlink(loc, a, b) {
        const row = rowFor(loc, a, b);
        if (!row) return false;
        db.run('DELETE FROM associations WHERE id = ?', row.id);
        notify({ kind: 'unlinked', locationId: loc, a, b, primaryOf: row.primary_of });
        app.events.emit(loc, 'association.removed', { contactId: contactOf(a, b), from: a, to: b });
        return true;
      },
      list(loc, ref, opts = {}) {
        const rows = db.all(
          `SELECT * FROM associations WHERE location_id = ? AND ((a_type = ? AND a_id = ?${opts.type ? ' AND b_type = ?' : ''}) OR (b_type = ? AND b_id = ?${opts.type ? ' AND a_type = ?' : ''})) ORDER BY created_at`,
          loc,
          ref.type,
          ref.id,
          ...(opts.type ? [opts.type] : []),
          ref.type,
          ref.id,
          ...(opts.type ? [opts.type] : []),
        );
        const labelNames = new Map<string, string>(db.all('SELECT id, name FROM association_labels WHERE location_id = ?', loc).map((l) => [l.id, l.name]));
        const out: Linked[] = [];
        for (const r of rows) {
          const other: Ref = r.a_type === ref.type && r.a_id === ref.id ? { type: r.b_type, id: r.b_id } : { type: r.a_type, id: r.a_id };
          const info = type(loc, other.type)?.get(loc, other.id);
          if (!info) continue;
          const labels = (JSON.parse(r.labels || '[]') as string[]).filter((l) => labelNames.has(l)).map((l) => ({ id: l, name: labelNames.get(l)! }));
          if (opts.label && !labels.some((l) => l.id === opts.label || l.name.toLowerCase() === opts.label!.toLowerCase())) continue;
          out.push({ ...info, association_id: r.id, type: other.type, record_id: other.id, labels, primary: !!r.primary_of, primary_for: r.primary_of, created_at: r.created_at });
        }
        return out;
      },
      ids(loc, ref, t) {
        return db
          .all(
            `SELECT CASE WHEN a_type = ? AND a_id = ? THEN b_id ELSE a_id END AS id FROM associations
             WHERE location_id = ? AND ((a_type = ? AND a_id = ? AND b_type = ?) OR (b_type = ? AND b_id = ? AND a_type = ?))`,
            ref.type,
            ref.id,
            loc,
            ref.type,
            ref.id,
            t,
            ref.type,
            ref.id,
            t,
          )
          .map((r) => r.id);
      },
      primary(loc, from, t) {
        return db.get(
          `SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS id FROM associations
           WHERE location_id = ? AND primary_of = ? AND ((a_id = ? AND a_type = ? AND b_type = ?) OR (b_id = ? AND b_type = ? AND a_type = ?))`,
          from.id,
          loc,
          from.id,
          from.id,
          from.type,
          t,
          from.id,
          from.type,
          t,
        )?.id;
      },
      setPrimary,
      removeAll(ref) {
        return db.run('DELETE FROM associations WHERE (a_type = ? AND a_id = ?) OR (b_type = ? AND b_id = ?)', ref.type, ref.id, ref.type, ref.id).changes;
      },
      labels: (loc, t1, t2) => (t1 && t2 ? labelRows(loc, t1, t2) : db.all('SELECT id, name, a_type, b_type FROM association_labels WHERE location_id = ? ORDER BY a_type, b_type, name', loc)) as any,
      onChange: (fn) => void listeners.push(fn),
      cascade,
    };
    app.services.associations = service;

    // --- built-in record types ----------------------------------------------------------------
    service.registerType({
      type: 'contact',
      label: 'Kontakt',
      plural: 'Kontakte',
      icon: 'contact',
      table: 'contacts',
      get: (loc, rid) => {
        const c = db.get('SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ? AND location_id = ?', rid, loc);
        return c ? { id: c.id, name: contactName(c), sub: c.email || c.phone || '', link: `contacts/${c.id}` } : undefined;
      },
      search: (loc, q, limit) =>
        db
          .all(`SELECT id, first_name, last_name, email, phone FROM contacts WHERE location_id = ? AND (first_name || ' ' || last_name || ' ' || email || ' ' || phone) LIKE ? ORDER BY first_name LIMIT ?`, loc, `%${q}%`, limit)
          .map((c) => ({ id: c.id, name: contactName(c), sub: c.email || c.phone || '' })),
    });
    service.registerType({
      type: 'opportunity',
      label: 'Deal',
      plural: 'Deals',
      icon: 'deal',
      table: 'opportunities',
      get: (loc, rid) => {
        const o = db.get('SELECT o.id, o.name, o.value, o.status, o.pipeline_id, p.name AS pipeline FROM opportunities o JOIN pipelines p ON p.id = o.pipeline_id WHERE o.id = ? AND o.location_id = ?', rid, loc);
        const status: Record<string, string> = { open: 'offen', won: 'gewonnen', lost: 'verloren', abandoned: 'aufgegeben' };
        return o ? { id: o.id, name: o.name, sub: `${o.pipeline} · ${new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(o.value || 0)} · ${status[o.status] ?? o.status}`, link: `opportunities?pipeline=${o.pipeline_id}` } : undefined;
      },
      search: (loc, q, limit) => db.all('SELECT id, name, value FROM opportunities WHERE location_id = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT ?', loc, `%${q}%`, limit).map((o) => ({ id: o.id, name: o.name, sub: `${o.value} €` })),
    });
    service.registerType({
      type: 'task',
      label: 'Aufgabe',
      plural: 'Aufgaben',
      icon: 'tasks',
      table: 'tasks',
      get: (loc, rid) => {
        const t = db.get('SELECT id, title, due_at, done FROM tasks WHERE id = ? AND location_id = ?', rid, loc);
        return t ? { id: t.id, name: t.title, sub: t.done ? 'erledigt' : t.due_at ? `fällig ${t.due_at.slice(0, 10)}` : 'offen', link: 'tasks' } : undefined;
      },
    });

    // --- API ------------------------------------------------------------------------------------
    const ref = (t: unknown, rid: unknown, what: string): Ref => {
      const type = str(t, `${what}: Typ`, { required: true, max: 60 });
      const idv = str(rid, `${what}: ID`, { required: true, max: 64 });
      return { type, id: idv };
    };
    const typeOut = (t: AssocType) => ({ type: t.type, label: t.label, plural: t.plural, icon: t.icon ?? 'link', searchable: !!t.search });

    router.get('/api/associations/types', 'location', (ctx) => types(ctx.locationId).map(typeOut));
    router.get('/api/associations', 'location', (ctx) => {
      const r = ref(ctx.query.get('type'), ctx.query.get('id'), 'Datensatz');
      if (!type(ctx.locationId, r.type)) throw bad('Unbekannter Objekttyp');
      return service.list(ctx.locationId, r, { type: ctx.query.get('to_type') || undefined, label: ctx.query.get('label') || undefined });
    });
    router.get('/api/associations/search', 'location', (ctx) => {
      const t = type(ctx.locationId, String(ctx.query.get('type') ?? ''));
      if (!t) throw bad('Unbekannter Objekttyp');
      if (!t.search) return [];
      return t.search(ctx.locationId, String(ctx.query.get('q') ?? '').slice(0, 100), Math.min(Number(ctx.query.get('limit')) || 10, 50));
    });
    router.post('/api/associations', 'location', (ctx) => {
      const a = ref(ctx.body.from_type, ctx.body.from_id, 'Von');
      const b = ref(ctx.body.to_type, ctx.body.to_id, 'Zu');
      const labels = Array.isArray(ctx.body.labels) ? ctx.body.labels.map(String) : ctx.body.label ? [String(ctx.body.label)] : undefined;
      const row = service.link(ctx.locationId, a, b, { labels, primary: !!ctx.body.primary });
      return { ...row, labels: row.labels };
    });
    const byId = (loc: string, aid: string) => {
      const r = parseJson(db.get('SELECT * FROM associations WHERE id = ? AND location_id = ?', aid, loc), ['labels']);
      if (!r) throw notFound('Verknüpfung nicht gefunden');
      return r;
    };
    router.patch('/api/associations/:id', 'location', (ctx) => {
      const r = byId(ctx.locationId, ctx.params.id);
      const a = { type: r.a_type, id: r.a_id };
      const b = { type: r.b_type, id: r.b_id };
      if (Array.isArray(ctx.body.labels)) {
        const ids = resolveLabels(ctx.locationId, a, b, ctx.body.labels.map(String));
        db.run('UPDATE associations SET labels = ? WHERE id = ?', JSON.stringify(ids), r.id);
      }
      if (ctx.body.primary_for !== undefined) {
        const pf = String(ctx.body.primary_for ?? '');
        if (!pf) {
          db.run(`UPDATE associations SET primary_of = '' WHERE id = ?`, r.id);
          notify({ kind: 'updated', locationId: ctx.locationId, a, b, primaryOf: '' });
        } else if (pf === a.id) setPrimary(ctx.locationId, a, b);
        else if (pf === b.id) setPrimary(ctx.locationId, b, a);
        else throw bad('primary_for muss eine der beiden IDs sein');
      }
      return byId(ctx.locationId, r.id);
    });
    router.delete('/api/associations/:id', 'location', (ctx) => {
      const r = byId(ctx.locationId, ctx.params.id);
      service.unlink(ctx.locationId, { type: r.a_type, id: r.a_id }, { type: r.b_type, id: r.b_id });
      return { ok: true };
    });

    // --- labels -----------------------------------------------------------------------------------
    router.get('/api/association-labels', 'location', (ctx) => {
      const t1 = ctx.query.get('a_type');
      const t2 = ctx.query.get('b_type');
      return service.labels(ctx.locationId, t1 || undefined, t2 || undefined);
    });
    router.post('/api/association-labels', 'location', (ctx) => {
      const t1 = str(ctx.body.a_type, 'Typ 1', { required: true, max: 60 });
      const t2 = str(ctx.body.b_type, 'Typ 2', { required: true, max: 60 });
      if (!type(ctx.locationId, t1) || !type(ctx.locationId, t2)) throw bad('Unbekannter Objekttyp');
      const name = str(ctx.body.name, 'Name', { required: true, max: 60 });
      const [x, y] = pairTypes(t1, t2);
      if (db.get('SELECT id FROM association_labels WHERE location_id = ? AND a_type = ? AND b_type = ? AND lower(name) = lower(?)', ctx.locationId, x, y, name)) throw bad('Label existiert schon');
      const row = { id: id(), location_id: ctx.locationId, a_type: x, b_type: y, name, created_at: now() };
      db.insert('association_labels', row);
      return row;
    });
    router.patch('/api/association-labels/:id', 'location', (ctx) => {
      const name = str(ctx.body.name, 'Name', { required: true, max: 60 });
      if (!db.update('association_labels', ctx.params.id, { name }, ctx.locationId)) throw notFound();
      return db.get('SELECT * FROM association_labels WHERE id = ?', ctx.params.id);
    });
    router.delete('/api/association-labels/:id', 'location', (ctx) => {
      const l = db.get('SELECT * FROM association_labels WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!l) throw notFound();
      db.tx(() => {
        // Drop the label from every association that carries it.
        for (const r of parseRows(db.all(`SELECT id, labels FROM associations WHERE location_id = ? AND labels LIKE ?`, l.location_id, `%${l.id}%`), ['labels'])) {
          db.run('UPDATE associations SET labels = ? WHERE id = ?', JSON.stringify((r.labels as string[]).filter((x) => x !== l.id)), r.id);
        }
        db.run('DELETE FROM association_labels WHERE id = ?', l.id);
      });
      return { ok: true };
    });
  },
};
