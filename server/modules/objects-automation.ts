import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { HttpError } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { processRun, startWorkflow } from '../services/workflow-engine.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { CUSTOM_OBJECT_RE, companyDomain, jsonPath } from '../services/objects.js';
import type { AssociationsService, Ref } from './associations.js';
import { COMPANY_FIELDS, findCompanyByDomain, upsertCompany, updateCompany } from './companies.js';
import { objectType, updateRecord, upsertRecord } from './custom-objects.js';
import type { Tool } from './mcp.js';

/**
 * Companies and custom objects in the rest of the app: workflow triggers (record created/updated/
 * property changed → runs for the associated contacts) and actions (create/update record,
 * associate records), the object schema in snapshots, Supabase mirror tables and MCP tools.
 */

export const OBJECT_TRIGGERS = ['company.created', 'company.updated', 'company.property_changed', 'record.created', 'record.updated', 'record.property_changed'];

const assoc = (app: App): AssociationsService => app.services.associations;

/** Does a company/record event satisfy a workflow trigger's filters? */
export function objectTriggerMatches(config: Record<string, any> = {}, e: { type: string; data: Record<string, any> }): boolean {
  const d = e.data;
  if (e.type.startsWith('record.') && config.object && config.object !== d.objectKey) return false;
  if (e.type.endsWith('.updated') && config.property && !(d.changed ?? []).map((k: string) => k.replace(/^custom\./, '')).includes(config.property)) return false;
  if (e.type.endsWith('.property_changed')) {
    if (config.property && config.property !== d.property) return false;
    if (config.value !== undefined && config.value !== '' && String(Array.isArray(d.value) ? d.value.join(', ') : (d.value ?? '')).toLowerCase() !== String(config.value).toLowerCase()) return false;
  }
  return true;
}

/** Splits workflow/MCP values for a company into standard fields and custom properties. */
function companyInput(values: Record<string, unknown>) {
  const out: Record<string, any> = {};
  const custom: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if ((COMPANY_FIELDS as readonly string[]).includes(k)) out[k] = v;
    else custom[k.replace(/^custom\./, '')] = v;
  }
  if (Object.keys(custom).length) out.custom = custom;
  return out;
}

export const objectsAutomationModule: Module = {
  name: 'objects-automation',
  register(app) {
    const { db } = app;
    const A = assoc(app);

    // --- helpdesk tickets as an association type (when the helpdesk module is installed) ----------
    if (db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickets'`) && !A.type('', 'ticket')) {
      A.registerType({
        type: 'ticket',
        label: 'Ticket',
        plural: 'Tickets',
        icon: 'ticket',
        table: 'tickets',
        get: (loc, rid) => {
          const t = db.get('SELECT id, number, subject, status_kind FROM tickets WHERE id = ? AND location_id = ?', rid, loc);
          return t ? { id: t.id, name: `#${t.number} ${t.subject}`, sub: t.status_kind, link: `tickets/${t.id}` } : undefined;
        },
        search: (loc, q, limit) =>
          db.all(`SELECT id, number, subject, status_kind FROM tickets WHERE location_id = ? AND (subject LIKE ? OR CAST(number AS TEXT) = ?) ORDER BY created_at DESC LIMIT ?`, loc, `%${q}%`, q.replace(/^#/, ''), limit).map((t) => ({ id: t.id, name: `#${t.number} ${t.subject}`, sub: t.status_kind })),
      });
    }

    // --- workflows: triggers --------------------------------------------------------------------
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...OBJECT_TRIGGERS];
    for (const type of OBJECT_TRIGGERS) {
      app.events.on(type, async (e) => {
        const flows = parseRows(db.all(`SELECT * FROM workflows WHERE location_id = ? AND status = 'active'`, e.locationId), ['steps', 'trigger', 'settings']).filter((w) => w.trigger?.type === e.type);
        if (!flows.length) return;
        const ref: Ref | undefined = e.data.companyId ? { type: 'company', id: e.data.companyId } : e.data.recordId ? { type: e.data.objectKey, id: e.data.recordId } : undefined;
        if (!ref) return;
        for (const wf of flows) {
          const c = wf.trigger.config ?? {};
          if (!objectTriggerMatches(c, e)) continue;
          // Workflows run per contact: the contacts associated with the record (optionally only with a label / the primary ones).
          let linked = A.list(e.locationId, ref, { type: 'contact', label: c.label || undefined });
          if (c.enroll === 'primary') linked = linked.filter((l) => l.primary_for === l.record_id);
          for (const l of linked) {
            const rid = startWorkflow(app, wf, l.record_id, { ...e.data, trigger: e.type });
            if (rid) await processRun(app, rid);
          }
        }
      });
    }

    // --- workflows: actions ---------------------------------------------------------------------
    const tpl = (vars: Record<string, any>, values: unknown) =>
      Object.fromEntries(Object.entries((values && typeof values === 'object' ? values : {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => render(String(x), vars)) : render(String(v ?? ''), vars)]));
    const contactRef = (run: any): Ref => ({ type: 'contact', id: run.contact_id });
    const triggerRecord = (run: any, object: string): Ref | undefined => {
      const ev = run.event ?? {};
      if (object === 'company' && ev.companyId) return { type: 'company', id: ev.companyId };
      if (ev.recordId && ev.objectKey === object) return { type: object, id: ev.recordId };
      return undefined;
    };
    const needType = (loc: string, object: string) => {
      const t = objectType(app, loc, object);
      if (!t) throw new Error(object ? `Objekt ${object} nicht gefunden` : 'Kein Objekt gewählt');
      return t;
    };
    const findByProperty = (loc: string, object: string, property: string, value: string): string[] => {
      if (!value) return [];
      if (object === 'company') {
        if (property === 'domain') return [findCompanyByDomain(app, loc, companyDomain(value))?.id].filter(Boolean) as string[];
        if ((COMPANY_FIELDS as readonly string[]).includes(property)) return db.all(`SELECT id FROM companies WHERE location_id = ? AND lower(${property}) = lower(?) LIMIT 20`, loc, value).map((r) => r.id);
        return db.all(`SELECT id FROM companies WHERE location_id = ? AND lower(CAST(${jsonPath('custom', property)} AS TEXT)) = lower(?) LIMIT 20`, loc, value).map((r) => r.id);
      }
      const t = needType(loc, object);
      if (property === 'display') return db.all('SELECT id FROM object_records WHERE type_id = ? AND lower(display) = lower(?) LIMIT 20', t.id, value).map((r) => r.id);
      return db.all(`SELECT id FROM object_records WHERE type_id = ? AND lower(CAST(${jsonPath('properties', property)} AS TEXT)) = lower(?) LIMIT 20`, t.id, value).map((r) => r.id);
    };
    const linkContact = (run: any, step: any, target: Ref) =>
      A.link(run.location_id, contactRef(run), target, { labels: step.label ? [String(step.label)] : undefined, addLabels: true, primary: target.type === 'company' && !!step.primary });

    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      create_record: async (run: any, step: any, vars: any) => {
        const object = String(step.object ?? '');
        const values = tpl(vars, step.properties);
        let target: Ref;
        let created: boolean;
        let label: string;
        if (object === 'company') {
          const r = upsertCompany(app, run.location_id, companyInput(values), { source: 'Workflow' });
          target = { type: 'company', id: r.company.id };
          created = r.created;
          label = `Firma „${r.company.name}“`;
        } else {
          const t = needType(run.location_id, object);
          const r = upsertRecord(app, run.location_id, t, { properties: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')) });
          target = { type: t.key, id: r.record.id };
          created = r.created;
          label = `${t.singular} „${r.record.display}“`;
        }
        if (step.associate !== false) linkContact(run, step, target);
        return `${label} ${created ? 'angelegt' : 'aktualisiert'}`;
      },
      update_record: async (run: any, step: any, vars: any) => {
        const object = String(step.object ?? '');
        const values = tpl(vars, step.properties);
        const loc = run.location_id;
        let ids: string[] = [];
        const target = step.target ?? 'trigger';
        if (target === 'trigger') ids = [triggerRecord(run, object)?.id].filter(Boolean) as string[];
        else if (target === 'primary' && object === 'company') ids = [A.primary(loc, contactRef(run), 'company')].filter(Boolean) as string[];
        else ids = A.list(loc, contactRef(run), { type: object, label: step.label || undefined }).map((l) => l.record_id);
        if (!ids.length) return 'kein Datensatz';
        for (const rid of ids.slice(0, 50)) {
          if (object === 'company') updateCompany(app, loc, rid, companyInput(values), {});
          else updateRecord(app, loc, needType(loc, object), rid, { properties: values }, {});
        }
        return `${ids.length} aktualisiert`;
      },
      associate_records: async (run: any, step: any, vars: any) => {
        const object = String(step.object ?? '');
        const loc = run.location_id;
        let ids: string[] = [];
        if ((step.target ?? 'match') === 'trigger') ids = [triggerRecord(run, object)?.id].filter(Boolean) as string[];
        else {
          const value = render(String(step.value ?? ''), vars).trim();
          ids = findByProperty(loc, object, String(step.property ?? (object === 'company' ? 'domain' : 'display')), value);
          if (!ids.length && step.create_if_missing && value) {
            const prop = String(step.property ?? (object === 'company' ? 'domain' : 'name'));
            if (object === 'company') ids = [upsertCompany(app, loc, companyInput({ [prop]: value }), { source: 'Workflow' }).company.id];
            else ids = [upsertRecord(app, loc, needType(loc, object), { properties: { [prop === 'display' ? 'name' : prop]: value } }).record.id];
          }
        }
        if (!ids.length) return 'nichts gefunden';
        for (const rid of ids.slice(0, 20)) linkContact(run, step, { type: object, id: rid });
        return `${ids.length} verknüpft`;
      },
    };

    // --- snapshots: object definitions and property schemas (never records) -----------------------
    const part: SnapshotPart = {
      key: 'object_schema',
      export: (_app, loc, only) => {
        if (only) return [];
        return [
          ...db.all('SELECT * FROM object_types WHERE location_id = ? ORDER BY position', loc).map((t) => ({ kind: 'type', key: t.key, singular: t.singular, plural: t.plural, icon: t.icon, primary_property: t.primary_property, description: t.description, position: t.position })),
          ...db.all('SELECT * FROM property_groups WHERE location_id = ? ORDER BY object_key, position', loc).map((g) => ({ kind: 'group', object_key: g.object_key, key: g.key, label: g.label, position: g.position })),
          ...parseRows(db.all('SELECT * FROM object_properties WHERE location_id = ? ORDER BY object_key, position', loc), ['options']).map((p) => ({
            kind: 'property',
            object_key: p.object_key,
            key: p.key,
            label: p.label,
            type: p.type,
            options: p.options,
            group_key: p.group_key,
            description: p.description,
            required: !!p.is_required,
            unique: !!p.is_unique,
            position: p.position,
          })),
          ...db.all(`SELECT key, group_key, description FROM custom_fields WHERE location_id = ? AND (group_key != '' OR description != '')`, loc).map((f) => ({ kind: 'contact_field', key: f.key, group_key: f.group_key, description: f.description })),
          ...db.all('SELECT a_type, b_type, name FROM association_labels WHERE location_id = ? ORDER BY a_type, b_type, name', loc).map((l) => ({ kind: 'label', ...l })),
        ];
      },
      apply: (_app, loc, items, ctx) => {
        const ok = (s: unknown, re = /^[a-z][a-z0-9_]{0,59}$/) => typeof s === 'string' && re.test(s);
        const objKey = (k: unknown) => ['contact', 'company', 'opportunity'].includes(String(k)) || CUSTOM_OBJECT_RE.test(String(k));
        let types = 0;
        let props = 0;
        for (const t of items.filter((i) => i.kind === 'type' && CUSTOM_OBJECT_RE.test(String(i.key)))) {
          types += db.run(
            `INSERT OR IGNORE INTO object_types (id, location_id, key, singular, plural, icon, primary_property, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id(),
            loc,
            t.key,
            String(t.singular ?? t.key).slice(0, 60),
            String(t.plural ?? t.singular ?? t.key).slice(0, 60),
            /^[a-zA-Z0-9]{1,30}$/.test(String(t.icon)) ? t.icon : 'layers',
            ok(t.primary_property) ? t.primary_property : 'name',
            String(t.description ?? '').slice(0, 500),
            Number(t.position) || 0,
            now(),
            now(),
          ).changes;
        }
        for (const g of items.filter((i) => i.kind === 'group' && objKey(i.object_key) && ok(i.key))) {
          db.run('INSERT OR IGNORE INTO property_groups (id, location_id, object_key, key, label, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id(), loc, g.object_key, g.key, String(g.label ?? g.key).slice(0, 80), Number(g.position) || 0, now());
        }
        for (const p of items.filter((i) => i.kind === 'property' && objKey(i.object_key) && i.object_key !== 'contact' && ok(i.key))) {
          props += db.run(
            `INSERT OR IGNORE INTO object_properties (id, location_id, object_key, key, label, type, options, group_key, description, is_required, is_unique, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id(),
            loc,
            p.object_key,
            p.key,
            String(p.label ?? p.key).slice(0, 100),
            String(p.type ?? 'text'),
            JSON.stringify(Array.isArray(p.options) ? p.options.map(String) : []),
            String(p.group_key ?? ''),
            String(p.description ?? '').slice(0, 500),
            p.required ? 1 : 0,
            p.unique ? 1 : 0,
            Number(p.position) || 0,
            now(),
            now(),
          ).changes;
        }
        for (const f of items.filter((i) => i.kind === 'contact_field' && ok(i.key))) {
          db.run('UPDATE custom_fields SET group_key = ?, description = ? WHERE location_id = ? AND key = ?', String(f.group_key ?? ''), String(f.description ?? '').slice(0, 500), loc, f.key);
        }
        for (const l of items.filter((i) => i.kind === 'label' && objKey(i.a_type) && (objKey(i.b_type) || /^[a-z]+$/.test(String(i.b_type))))) {
          const [x, y] = [String(l.a_type), String(l.b_type)].sort();
          db.run('INSERT OR IGNORE INTO association_labels (id, location_id, a_type, b_type, name, created_at) VALUES (?, ?, ?, ?, ?, ?)', id(), loc, x, y, String(l.name ?? '').slice(0, 60), now());
        }
        ctx.created.object_types = types;
        ctx.created.object_properties = props;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- Supabase mirror tables -------------------------------------------------------------------
    const json = (v: unknown) => (typeof v === 'string' ? (v ? JSON.parse(v) : null) : (v ?? null));
    app.services.supabaseTables = [
      ...(app.services.supabaseTables ?? []),
      {
        table: 'ghl_companies',
        sql: `create table if not exists public.ghl_companies (id text primary key, location_id text, project text, name text, domain text, industry text, size text, phone text, website text, address text, postal_code text, city text, country text, owner_id text, lifecycle_stage text, description text, custom jsonb, created_at timestamptz, updated_at timestamptz, synced_at timestamptz);
alter table public.ghl_companies enable row level security;`,
        rows: (a: App, since?: string) =>
          a.db
            .all(
              `SELECT c.id, c.location_id, l.name AS project, c.name, c.domain, c.industry, c.size, c.phone, c.website, c.address, c.postal_code, c.city, c.country, c.owner_id, c.lifecycle_stage, c.description, c.custom, c.created_at, c.updated_at
               FROM companies c JOIN locations l ON l.id = c.location_id ${since ? 'WHERE c.updated_at > ?' : ''}`,
              ...(since ? [since] : []),
            )
            .map((c) => ({ ...c, custom: json(c.custom) ?? {} })),
      },
      {
        table: 'ghl_object_records',
        sql: `create table if not exists public.ghl_object_records (id text primary key, location_id text, project text, object_type text, object_label text, display text, properties jsonb, owner_id text, created_at timestamptz, updated_at timestamptz, synced_at timestamptz);
alter table public.ghl_object_records enable row level security;`,
        rows: (a: App, since?: string) =>
          a.db
            .all(
              `SELECT r.id, r.location_id, l.name AS project, t.key AS object_type, t.singular AS object_label, r.display, r.properties, r.owner_id, r.created_at, r.updated_at
               FROM object_records r JOIN object_types t ON t.id = r.type_id JOIN locations l ON l.id = r.location_id ${since ? 'WHERE r.updated_at > ?' : ''}`,
              ...(since ? [since] : []),
            )
            .map((r) => ({ ...r, properties: json(r.properties) ?? {} })),
      },
      {
        // New links every run, label/primary changes and deletions with the nightly full run.
        table: 'ghl_associations',
        sql: `create table if not exists public.ghl_associations (id text primary key, location_id text, a_type text, a_id text, b_type text, b_id text, labels jsonb, primary_of text, created_at timestamptz, synced_at timestamptz);
alter table public.ghl_associations enable row level security;`,
        rows: (a: App, since?: string) =>
          a.db
            .all(
              `SELECT x.id, x.location_id, x.a_type, x.a_id, x.b_type, x.b_id, x.labels, x.primary_of, x.created_at,
                 (SELECT json_group_array(l.name) FROM association_labels l, json_each(x.labels) j WHERE l.id = j.value) AS label_names
               FROM associations x ${since ? 'WHERE x.created_at > ?' : ''}`,
              ...(since ? [since] : []),
            )
            .map(({ label_names, ...r }) => ({ ...r, labels: json(label_names) ?? [] })),
      },
    ];

    // --- MCP tools ----------------------------------------------------------------------------------
    const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
    const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
    const RO = { readOnlyHint: true, openWorldHint: false };
    const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
    const qs = (p: Record<string, unknown>) => {
      const s = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null && v !== '') s.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      const out = s.toString();
      return out ? `?${out}` : '';
    };
    const FILTERS = { type: 'array', description: 'Filter [{field, op: eq|neq|contains|not_contains|empty|not_empty|gt|lt|gte|lte|in, value}]; Felder: Eigenschafts-Schlüssel (Firmen: Standardfelder oder custom.<schlüssel>)', items: { type: 'object' } };
    const TOOLS: Tool[] = [
      {
        name: 'ghl_list_companies',
        title: 'Firmen auflisten',
        description: 'Firmen eines Projekts mit Domain, Branche, Phase, Zuständigem, Anzahl Kontakte/Deals und Deal-Wert. Suche, Filter und Sortierung (z. B. "-deals_value").',
        inputSchema: obj({ ...LOC, query: { type: 'string' }, industry: { type: 'string' }, lifecycle_stage: { type: 'string' }, filters: FILTERS, sort: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, ['location_id']),
        annotations: RO,
        run: (call, a) => call.api('GET', `/api/companies${qs({ q: a.query, industry: a.industry, lifecycle_stage: a.lifecycle_stage, filters: a.filters, sort: a.sort, limit: a.limit ?? 50, offset: a.offset })}`, { location: a.location_id }),
      },
      {
        name: 'ghl_upsert_company',
        title: 'Firma anlegen/ändern',
        description:
          'Legt eine Firma an oder aktualisiert sie (per id, sonst per Domain – keine Dubletten). Felder: name, domain, industry, size (1-10 … 1000+ oder Zahl), phone, website, address, postal_code, city, country, lifecycle_stage (subscriber|lead|mql|sql|opportunity|customer|evangelist|other), description, custom {schlüssel: wert}; contact_ids verknüpft Kontakte (erste Firma wird primär).',
        inputSchema: obj(
          {
            ...LOC,
            id: { type: 'string' },
            name: { type: 'string' },
            domain: { type: 'string' },
            industry: { type: 'string' },
            size: { type: 'string' },
            phone: { type: 'string' },
            website: { type: 'string' },
            address: { type: 'string' },
            postal_code: { type: 'string' },
            city: { type: 'string' },
            country: { type: 'string' },
            lifecycle_stage: { type: 'string' },
            description: { type: 'string' },
            custom: { type: 'object' },
            contact_ids: { type: 'array', items: { type: 'string' } },
          },
          ['location_id'],
        ),
        annotations: { ...W, idempotentHint: true },
        run: (call, { location_id, ...body }) => call.api('POST', '/api/companies', { location: location_id, body }),
      },
      {
        name: 'ghl_list_object_types',
        title: 'Objekttypen',
        description: 'Eigene Objekte (benutzerdefinierte Objekte) eines Projekts mit Schlüssel (p_…), Namen, Anzeige-Eigenschaft, Eigenschaften (Typ, Pflicht, eindeutig, Optionen) und Anzahl Datensätze. Dazu die Verknüpfungs-Labels.',
        inputSchema: obj({ ...LOC }, ['location_id']),
        annotations: RO,
        run: async (call, a) => ({ types: await call.api('GET', '/api/objects', { location: a.location_id }), association_labels: await call.api('GET', '/api/association-labels', { location: a.location_id }) }),
      },
      {
        name: 'ghl_search_records',
        title: 'Datensätze suchen',
        description: 'Sucht Datensätze eines Objekts: object = p_… (eigenes Objekt), "company" oder "contact". query durchsucht Name/Eigenschaften; filters wie in ghl_list_companies (Felder = Eigenschafts-Schlüssel).',
        inputSchema: obj({ ...LOC, object: { type: 'string' }, query: { type: 'string' }, filters: FILTERS, sort: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, ['location_id', 'object']),
        annotations: RO,
        run: (call, a) => {
          const p = { q: a.query, filters: a.filters, sort: a.sort, limit: a.limit ?? 50, offset: a.offset };
          if (a.object === 'company') return call.api('GET', `/api/companies${qs(p)}`, { location: a.location_id });
          if (a.object === 'contact') return call.api('GET', `/api/contacts${qs({ q: a.query, limit: a.limit ?? 50, offset: a.offset })}`, { location: a.location_id });
          return call.api('GET', `/api/objects/${encodeURIComponent(a.object)}/records${qs(p)}`, { location: a.location_id });
        },
      },
      {
        name: 'ghl_upsert_record',
        title: 'Datensatz anlegen/ändern',
        description:
          'Legt einen Datensatz eines eigenen Objekts (object = p_…) an oder ändert ihn (per id, sonst per eindeutiger Eigenschaft). properties {schlüssel: wert} werden je Typ geprüft; associations [{type, id, label?, primary?}] verknüpft gleich. object = "company" leitet an ghl_upsert_company weiter.',
        inputSchema: obj({ ...LOC, object: { type: 'string' }, id: { type: 'string' }, properties: { type: 'object' }, owner_id: { type: 'string' }, associations: { type: 'array', items: { type: 'object' } } }, ['location_id', 'object']),
        annotations: { ...W, idempotentHint: true },
        run: async (call, a) => {
          if (a.object === 'company') {
            const out = await call.api('POST', '/api/companies', { location: a.location_id, body: { ...(a.id ? { id: a.id } : {}), ...companyInput(a.properties ?? {}) } });
            for (const x of Array.isArray(a.associations) ? a.associations : []) await call.api('POST', '/api/associations', { location: a.location_id, body: { from_type: 'company', from_id: out.id, to_type: x.type, to_id: x.id, label: x.label, primary: x.primary } });
            return out;
          }
          return call.api('POST', `/api/objects/${encodeURIComponent(a.object)}/records`, { location: a.location_id, body: { id: a.id, properties: a.properties ?? {}, owner_id: a.owner_id, associations: a.associations } });
        },
      },
      {
        name: 'ghl_associate',
        title: 'Datensätze verknüpfen',
        description:
          'Verknüpft zwei Datensätze (Typen: contact, company, opportunity, task, p_… und von Modulen registrierte wie ticket), optional mit Label (Name, z. B. "Entscheider") und primary=true (z. B. primäre Firma eines Kontakts: from=contact, to=company). remove=true löst die Verknüpfung.',
        inputSchema: obj({ ...LOC, from_type: { type: 'string' }, from_id: { type: 'string' }, to_type: { type: 'string' }, to_id: { type: 'string' }, label: { type: 'string' }, primary: { type: 'boolean' }, remove: { type: 'boolean' } }, ['location_id', 'from_type', 'from_id', 'to_type', 'to_id']),
        annotations: { ...W, idempotentHint: true },
        run: async (call, a) => {
          if (a.remove) {
            const list: any[] = await call.api('GET', `/api/associations${qs({ type: a.from_type, id: a.from_id, to_type: a.to_type })}`, { location: a.location_id });
            const hit = list.find((x) => x.record_id === a.to_id);
            if (!hit) throw new HttpError(404, 'Nicht verknüpft');
            await call.api('DELETE', `/api/associations/${hit.association_id}`, { location: a.location_id });
            return { ok: true, removed: true };
          }
          return call.api('POST', '/api/associations', { location: a.location_id, body: { from_type: a.from_type, from_id: a.from_id, to_type: a.to_type, to_id: a.to_id, label: a.label, primary: a.primary } });
        },
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
