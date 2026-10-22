import type { App, Module } from '../core/app.js';
import { parseCsv, toCsv } from '../core/csv.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, num, str, text, type Ctx, clampLimit } from '../core/http.js';
import { sliceTimer } from '../core/perf.js';
import { id, normalizePhone, now } from '../core/util.js';
import { contactName, getContact } from '../services/contacts.js';
import { maskRow, permits, resolve, scopeClause, type Who } from '../services/record-access.js';
import {
  COMPANY_SIZES,
  LIFECYCLE_STAGES,
  STANDARD_PROPS,
  ValueError,
  changedKeys,
  coerceValue,
  companyDomain,
  displayValue,
  filterSql,
  isFreeMail,
  jsonPath,
  mergeProps,
  nameFromDomain,
  parseFilters,
  sortSql,
  type FieldExpr,
} from '../services/objects.js';
import type { AssociationsService, Ref } from './associations.js';
import type { ObjectSchema } from './object-schema.js';
import { sealSettings } from '../core/secrets.js';

/**
 * Companies (HubSpot's built-in object): standard properties plus custom ones, many-to-many with
 * contacts (one primary company per contact – contacts.company stays in sync as text), linked to
 * deals, auto-associated by e-mail domain, deduplicated by domain. Company page with associated
 * contacts and deals, activity from all of them, notes and tasks. Workflows hear company.created,
 * company.updated and company.property_changed.
 */

export const COMPANY_FIELDS = ['name', 'domain', 'industry', 'size', 'phone', 'website', 'address', 'postal_code', 'city', 'country', 'owner_id', 'lifecycle_stage', 'description'] as const;

export interface CompanySettings {
  /** Link contacts to the company with their e-mail domain (never for free-mail domains). */
  auto_associate: boolean;
  /** Create a company from an unknown e-mail domain. */
  create_from_domain: boolean;
  /** Create a company from the contact's "Firma" text. */
  create_from_text: boolean;
}
const DEFAULT_SETTINGS: CompanySettings = { auto_associate: true, create_from_domain: false, create_from_text: true };

const STAGE_KEYS = LIFECYCLE_STAGES.map(([k]) => k);

/** CSV header → company field (German and English names, HubSpot exports). */
export function guessCompanyField(header: string): string | undefined {
  const h = header.toLowerCase().replace(/[\s_\-.]+/g, '');
  const map: Record<string, string> = {
    name: 'name', firma: 'name', firmenname: 'name', company: 'name', companyname: 'name', unternehmen: 'name',
    domain: 'domain', companydomainname: 'domain', domainname: 'domain',
    industry: 'industry', branche: 'industry',
    size: 'size', größe: 'size', groesse: 'size', mitarbeiter: 'size', mitarbeitende: 'size', numberofemployees: 'size', employees: 'size',
    phone: 'phone', telefon: 'phone', phonenumber: 'phone', telefonnummer: 'phone',
    website: 'website', webseite: 'website', websiteurl: 'website', url: 'website',
    address: 'address', adresse: 'address', strasse: 'address', straße: 'address', streetaddress: 'address',
    postalcode: 'postal_code', zip: 'postal_code', plz: 'postal_code', postleitzahl: 'postal_code',
    city: 'city', stadt: 'city', ort: 'city',
    country: 'country', land: 'country', countryregion: 'country',
    lifecyclestage: 'lifecycle_stage', lebenszyklusphase: 'lifecycle_stage', phase: 'lifecycle_stage',
    description: 'description', beschreibung: 'description',
    owner: 'owner_id', zuständig: 'owner_id', companyowner: 'owner_id',
  };
  return map[h];
}

const assoc = (app: App): AssociationsService => app.services.associations;
const schema = (app: App): ObjectSchema => app.services.objectSchema;

export function companySettings(app: App, locationId: string): CompanySettings {
  return { ...DEFAULT_SETTINGS, ...(app.location(locationId)?.settings?.companies ?? {}) };
}

export function getCompany(app: App, locationId: string, cid: string): any {
  return parseJson(app.db.get('SELECT * FROM companies WHERE id = ? AND location_id = ?', cid, locationId), ['custom']);
}
export function findCompanyByDomain(app: App, locationId: string, domain: string): any {
  return domain ? parseJson(app.db.get('SELECT * FROM companies WHERE location_id = ? AND domain = ? ORDER BY created_at LIMIT 1', locationId, domain), ['custom']) : undefined;
}
export function findCompanyByName(app: App, locationId: string, name: string): any {
  const n = name.trim();
  return n ? parseJson(app.db.get('SELECT * FROM companies WHERE location_id = ? AND name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1', locationId, n), ['custom']) : undefined;
}

/** Checks the standard fields of a company (partial for updates). */
function cleanFields(app: App, locationId: string, input: Record<string, any>, partial: boolean) {
  const out: Record<string, any> = {};
  const has = (k: string) => input[k] !== undefined;
  const s = (k: string, max = 500) => (input[k] === null ? '' : String(input[k]).trim().slice(0, max));
  if (has('name')) out.name = s('name', 200);
  if (has('domain')) {
    const raw = s('domain', 300);
    out.domain = companyDomain(raw);
    if (raw && !out.domain) throw bad('Ungültige Domain');
  }
  if (has('website')) {
    const w = s('website', 1000);
    if (w) {
      try {
        out.website = coerceValue({ label: 'Webseite', type: 'url', options: [] }, w);
      } catch (e) {
        throw bad((e as Error).message);
      }
    } else out.website = '';
    if (!has('domain') && out.website && !partial) out.domain = companyDomain(out.website);
  }
  for (const k of ['industry', 'address', 'postal_code', 'city', 'country']) if (has(k)) out[k] = s(k, 200);
  if (has('description')) out.description = s('description', 20000);
  if (has('phone')) out.phone = input.phone ? normalizePhone(String(input.phone)) : '';
  if (has('size')) {
    const v = s('size', 40);
    const n = Number(v.replace(/[^\d]/g, ''));
    if (!v) out.size = '';
    else if (COMPANY_SIZES.includes(v)) out.size = v;
    else if (/^\d+$/.test(v.replace(/[.\s]/g, '')) && n > 0) out.size = n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 500 ? '201-500' : n <= 1000 ? '501-1000' : '1000+';
    else throw bad(`Größe: ${COMPANY_SIZES.join(', ')} oder eine Zahl`);
  }
  if (has('lifecycle_stage')) {
    const v = s('lifecycle_stage', 60).toLowerCase();
    const hit = LIFECYCLE_STAGES.find(([k, l]) => k === v || l.toLowerCase() === v || l.toLowerCase().startsWith(`${v} `));
    if (v && !hit) throw bad(`Lebenszyklusphase: ${STAGE_KEYS.join(', ')}`);
    out.lifecycle_stage = hit?.[0] ?? '';
  }
  if (has('owner_id')) {
    const v = input.owner_id ? String(input.owner_id) : null;
    if (v && !schema(app).users(locationId).some((u) => u.id === v || u.email === v.toLowerCase())) throw bad('Zuständig: Nutzer hat keinen Zugriff auf diesen Sub-Account');
    out.owner_id = v ? schema(app).users(locationId).find((u) => u.id === v || u.email === v.toLowerCase())!.id : null;
  }
  return out;
}

const LABELS: Record<string, string> = Object.fromEntries(STANDARD_PROPS.company.map((p) => [p.key, p.label]));

export interface CompanyOpts {
  userId?: string | null;
  source?: string;
  /** No workflow events (imports). */
  quiet?: boolean;
}

export function createCompany(app: App, locationId: string, input: Record<string, any>, opts: CompanyOpts = {}): any {
  const fields = cleanFields(app, locationId, input, false);
  if (!fields.name && fields.domain) fields.name = nameFromDomain(fields.domain);
  if (!fields.name) throw bad('Name oder Domain angeben');
  if (fields.domain) {
    const dup = findCompanyByDomain(app, locationId, fields.domain);
    if (dup) throw new HttpError(409, `Die Domain ${fields.domain} gehört schon zu „${dup.name}“`);
  }
  const custom = schema(app).validate(locationId, 'company', input.custom ?? {}, {});
  const row = {
    id: id(),
    location_id: locationId,
    name: '',
    domain: '',
    industry: '',
    size: '',
    phone: '',
    website: '',
    address: '',
    postal_code: '',
    city: '',
    country: '',
    owner_id: null,
    lifecycle_stage: '',
    description: '',
    ...fields,
    custom: mergeProps({}, custom),
    source: String(opts.source ?? input.source ?? 'manuell').slice(0, 80),
    created_at: now(),
    updated_at: now(),
  };
  app.db.insert('companies', row);
  const company = getCompany(app, locationId, row.id)!;
  schema(app).log(locationId, 'company', row.id, 'company.created', `Firma angelegt (${row.source})`, {}, opts.userId);
  if (!opts.quiet) app.events.emit(locationId, 'company.created', { companyId: row.id, company });
  if (company.domain) associateDomainContacts(app, locationId, company);
  return company;
}

export function updateCompany(app: App, locationId: string, cid: string, input: Record<string, any>, opts: CompanyOpts = {}): any {
  const cur = getCompany(app, locationId, cid);
  if (!cur) throw notFound('Firma nicht gefunden');
  const fields = cleanFields(app, locationId, input, true);
  if (fields.name !== undefined && !fields.name) throw bad('Name darf nicht leer sein');
  if (fields.domain && fields.domain !== cur.domain) {
    const dup = findCompanyByDomain(app, locationId, fields.domain);
    if (dup && dup.id !== cur.id) throw new HttpError(409, `Die Domain ${fields.domain} gehört schon zu „${dup.name}“ – Firmen zusammenführen?`);
  }
  const customPatch = input.custom !== undefined ? schema(app).validate(locationId, 'company', input.custom, { partial: true, current: cur.custom, recordId: cur.id }) : {};
  const nextCustom = mergeProps(cur.custom, customPatch);
  const std = (src: Record<string, any>) => Object.fromEntries(COMPANY_FIELDS.map((k) => [k, src[k] ?? (k === 'owner_id' ? null : '')]));
  const prefixed = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [`custom.${k}`, v]));
  const before: Record<string, unknown> = { ...std(cur), ...prefixed(cur.custom) };
  const after: Record<string, unknown> = { ...std({ ...cur, ...fields }), ...prefixed(nextCustom) };
  const changed = changedKeys(before, after);
  if (!changed.length) return cur;
  app.db.update('companies', cur.id, { ...fields, custom: nextCustom, updated_at: now() });
  const company = getCompany(app, locationId, cur.id)!;
  const defs = new Map(schema(app).defs(locationId, 'company').map((d) => [d.key, d]));
  const label = (k: string) => (k.startsWith('custom.') ? (defs.get(k.slice(7))?.label ?? k.slice(7)) : (LABELS[k] ?? k));
  const show = (k: string, v: unknown) => (k.startsWith('custom.') ? displayValue(defs.get(k.slice(7)), v) : displayValue(undefined, v)) || '–';
  schema(app).log(locationId, 'company', cur.id, 'company.updated', changed.map((k) => `${label(k)}: ${show(k, before[k])} → ${show(k, after[k])}`).join(' · ').slice(0, 480), { changed }, opts.userId);
  if (fields.name !== undefined && fields.name !== cur.name) {
    // Contacts with this primary company carry the new name.
    app.db.run(
      `UPDATE contacts SET company = ?, updated_at = ? WHERE location_id = ? AND id IN (
         SELECT CASE WHEN a_type = 'contact' THEN a_id ELSE b_id END FROM associations
         WHERE location_id = ? AND primary_of != '' AND ((a_type = 'company' AND a_id = ? AND b_type = 'contact' AND b_id = primary_of) OR (b_type = 'company' AND b_id = ? AND a_type = 'contact' AND a_id = primary_of)))`,
      company.name,
      now(),
      locationId,
      locationId,
      cur.id,
      cur.id,
    );
  }
  if (!opts.quiet) {
    app.events.emit(locationId, 'company.updated', { companyId: cur.id, company, changed });
    for (const k of changed) app.events.emit(locationId, 'company.property_changed', { companyId: cur.id, company, property: k.replace(/^custom\./, ''), value: after[k] ?? null, previous: before[k] ?? null });
  }
  if (company.domain && company.domain !== cur.domain) associateDomainContacts(app, locationId, company);
  return company;
}

/** Creates or updates (by id, then by domain – no duplicate domains). */
export function upsertCompany(app: App, locationId: string, input: Record<string, any>, opts: CompanyOpts = {}) {
  if (input.id) {
    if (!getCompany(app, locationId, String(input.id))) throw notFound('Firma nicht gefunden');
    const { id: cid, ...rest } = input;
    return { company: updateCompany(app, locationId, String(cid), rest, opts), created: false };
  }
  const domain = companyDomain(input.domain || input.website || '');
  const existing = findCompanyByDomain(app, locationId, domain);
  if (existing) {
    const patch: Record<string, any> = {};
    // Only fill in what's given; never overwrite with empty values on a merge.
    for (const [k, v] of Object.entries(input)) if (v !== '' && v !== null && v !== undefined && k !== 'source') patch[k] = v;
    return { company: updateCompany(app, locationId, existing.id, patch, opts), created: false };
  }
  return { company: createCompany(app, locationId, input, opts), created: true };
}

export function deleteCompany(app: App, locationId: string, cid: string, opts: CompanyOpts = {}) {
  const c = getCompany(app, locationId, cid);
  if (!c) throw notFound('Firma nicht gefunden');
  const contacts = app.db.all(
    `SELECT primary_of AS id FROM associations WHERE location_id = ? AND primary_of NOT IN ('', ?) AND ((a_type = 'company' AND a_id = ?) OR (b_type = 'company' AND b_id = ?)) AND (a_type = 'contact' OR b_type = 'contact')`,
    locationId,
    cid,
    cid,
    cid,
  );
  app.db.tx(() => {
    app.db.run('DELETE FROM companies WHERE id = ?', cid);
    schema(app).forget('company', cid);
  });
  // Contacts whose primary company this was: the next linked company takes over, otherwise the text is cleared.
  for (const r of contacts) promoteOrClear(app, locationId, r.id);
  if (!opts.quiet) app.events.emit(locationId, 'company.deleted', { companyId: cid, company: c });
}

function writeContactCompanyText(app: App, locationId: string, contactId: string) {
  const prim = assoc(app).primary(locationId, { type: 'contact', id: contactId }, 'company');
  const name = prim ? (getCompany(app, locationId, prim)?.name ?? '') : '';
  app.db.run('UPDATE contacts SET company = ?, updated_at = ? WHERE id = ? AND location_id = ? AND company != ?', name, now(), contactId, locationId, name);
}

function promoteOrClear(app: App, locationId: string, contactId: string) {
  const c: Ref = { type: 'contact', id: contactId };
  if (assoc(app).primary(locationId, c, 'company')) return writeContactCompanyText(app, locationId, contactId);
  const next = assoc(app).ids(locationId, c, 'company')[0];
  if (next) assoc(app).setPrimary(locationId, c, { type: 'company', id: next });
  else writeContactCompanyText(app, locationId, contactId);
}

/** Links contacts with the company's e-mail domain (when the setting is on). */
export function associateDomainContacts(app: App, locationId: string, company: { id: string; domain: string }) {
  if (!company.domain || isFreeMail(company.domain) || !companySettings(app, locationId).auto_associate) return 0;
  const rows = app.db.all(`SELECT id FROM contacts WHERE location_id = ? AND email LIKE ? LIMIT 5000`, locationId, `%@${company.domain}`);
  let n = 0;
  for (const r of rows) {
    const ref: Ref = { type: 'contact', id: r.id };
    if (assoc(app).ids(locationId, ref, 'company').includes(company.id)) continue;
    assoc(app).link(locationId, ref, { type: 'company', id: company.id });
    n++;
  }
  return n;
}

/**
 * Keeps one contact in step with companies: the "Firma" text picks (or creates) the primary
 * company, an empty text drops the primary flag, the e-mail domain links the company with that
 * domain. Writes to contacts never emit events (no workflow loops).
 */
export function syncContact(app: App, locationId: string, contactId: string) {
  const c = getContact(app, locationId, contactId);
  if (!c) return;
  const A = assoc(app);
  const set = companySettings(app, locationId);
  const ref: Ref = { type: 'contact', id: c.id };
  const primId = A.primary(locationId, ref, 'company');
  const prim = primId ? getCompany(app, locationId, primId) : undefined;
  const textValue = String(c.company ?? '').trim();
  const dom = companyDomain(c.email);
  const workDomain = dom && !isFreeMail(dom) ? dom : '';
  if (textValue) {
    if (!prim || prim.name.toLowerCase() !== textValue.toLowerCase()) {
      // The typed name wins over the e-mail domain (a consultant may write the client's name).
      let target = findCompanyByName(app, locationId, textValue);
      if (!target && set.create_from_text) target = createCompany(app, locationId, { name: textValue }, { source: 'Kontakt' });
      if (target) A.link(locationId, ref, { type: 'company', id: target.id }, { primary: true });
    }
  } else if (prim) {
    // "Firma" emptied on the contact: keep the link, drop the primary flag.
    app.db.run(`UPDATE associations SET primary_of = '' WHERE location_id = ? AND primary_of = ? AND (a_type = 'company' OR b_type = 'company')`, locationId, c.id);
  }
  if (workDomain && set.auto_associate) {
    let byDomain = findCompanyByDomain(app, locationId, workDomain);
    if (!byDomain && set.create_from_domain && !A.primary(locationId, ref, 'company')) byDomain = createCompany(app, locationId, { domain: workDomain }, { source: 'E-Mail-Domain' });
    if (byDomain && !A.ids(locationId, ref, 'company').includes(byDomain.id)) A.link(locationId, ref, { type: 'company', id: byDomain.id }, { primary: !A.primary(locationId, ref, 'company') && !textValue });
  }
}

/** Expression for a filterable/sortable company field. */
const companyExpr =
  (app: App, locationId: string): FieldExpr =>
  (field) => {
    if ((COMPANY_FIELDS as readonly string[]).includes(field)) return { sql: `c.${field}`, type: (STANDARD_PROPS.company.find((p) => p.key === field)?.type ?? 'text') as any };
    if (field === 'created_at' || field === 'updated_at') return { sql: `c.${field}`, type: 'datetime' };
    if (field === 'contacts_count' || field === 'deals_count' || field === 'deals_value') return { sql: field, type: 'number' };
    if (field.startsWith('custom.')) {
      const key = field.slice(7);
      const def = schema(app).defs(locationId, 'company').find((d) => d.key === key);
      if (!def) return undefined;
      return { sql: jsonPath('c.custom', key), type: def.type };
    }
    return undefined;
  };

const LINK = (other: string) =>
  `((a.a_type = 'company' AND a.a_id = c.id AND a.b_type = '${other}') OR (a.b_type = 'company' AND a.b_id = c.id AND a.a_type = '${other}'))`;
const OTHER_ID = `CASE WHEN a.a_type = 'company' THEN a.b_id ELSE a.a_id END`;
const COUNTS = `
  (SELECT COUNT(*) FROM associations a WHERE a.location_id = c.location_id AND ${LINK('contact')}) AS contacts_count,
  (SELECT COUNT(*) FROM associations a WHERE a.location_id = c.location_id AND ${LINK('opportunity')}) AS deals_count,
  (SELECT COALESCE(SUM(o.value), 0) FROM associations a JOIN opportunities o ON o.id = ${OTHER_ID} WHERE a.location_id = c.location_id AND ${LINK('opportunity')} AND o.status != 'lost') AS deals_value`;

export function listCompanies(app: App, locationId: string, q: { q?: string; filters?: unknown; sort?: string; limit?: number; offset?: number; owner_id?: string; lifecycle_stage?: string; industry?: string; /** The person asking (record-access rules narrow the list and hide fields). */ who?: Who }) {
  const expr = companyExpr(app, locationId);
  const where = ['1 = 1'];
  const params: unknown[] = [locationId];
  if (q.q) {
    where.push(`(c.name || ' ' || c.domain || ' ' || c.city || ' ' || c.industry) LIKE ?`);
    params.push(`%${q.q}%`);
  }
  for (const k of ['owner_id', 'lifecycle_stage', 'industry'] as const) if (q[k]) where.push(`c.${k} = ?`), params.push(q[k]);
  let f;
  try {
    f = filterSql(parseFilters(q.filters), expr);
  } catch (e) {
    if (e instanceof ValueError) throw bad(e.message);
    throw e;
  }
  where.push(...f.where);
  params.push(...f.params);
  const access = q.who ? resolve(app, { ...q.who, locationId }) : null;
  const scope = scopeClause(access, 'companies', 'c');
  if (scope) (where.push(scope.sql), params.push(...scope.params));
  const order = sortSql(q.sort, expr, 'c.updated_at DESC');
  const base = `SELECT c.*, u.name AS owner_name, ${COUNTS} FROM companies c LEFT JOIN users u ON u.id = c.owner_id WHERE c.location_id = ?`;
  const sql = `SELECT * FROM (${base}) c WHERE ${where.join(' AND ')}`;
  // Counts are sub-selects: filter/sort on them works on the wrapped query.
  const total = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`, ...(params as any[]))!.n;
  const rows = parseRows(app.db.all(`${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...(params as any[]), q.limit ?? 50, q.offset ?? 0), ['custom']);
  return { total, companies: access ? rows.map((r) => maskRow(access, 'companies', r)) : rows };
}

export const companiesModule: Module = {
  name: 'companies',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE companies (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', industry TEXT NOT NULL DEFAULT '', size TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
        postal_code TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '',
        owner_id TEXT, lifecycle_stage TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        custom TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX companies_loc_domain ON companies(location_id, domain);
      CREATE INDEX companies_loc_name ON companies(location_id, name COLLATE NOCASE);
      CREATE INDEX companies_loc_updated ON companies(location_id, updated_at);
      CREATE TABLE companies_sync (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `,
    ],
    [
      '002-external-ids',
      `
      ALTER TABLE companies ADD COLUMN external_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE companies ADD COLUMN external_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX companies_external ON companies(location_id, external_source, external_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const A = assoc(app);
    const S = schema(app);

    S.registerStore((o) => o === 'company', { table: 'companies', column: 'custom', where: (loc) => ['location_id = ?', [loc]] });

    A.registerType({
      type: 'company',
      label: 'Firma',
      plural: 'Firmen',
      icon: 'company',
      table: 'companies',
      get: (loc, cid) => {
        const c = db.get('SELECT id, name, domain, city FROM companies WHERE id = ? AND location_id = ?', cid, loc);
        return c ? { id: c.id, name: c.name, sub: [c.domain, c.city].filter(Boolean).join(' · '), link: `companies/${c.id}` } : undefined;
      },
      search: (loc, q, limit) =>
        db.all(`SELECT id, name, domain, city FROM companies WHERE location_id = ? AND (name || ' ' || domain) LIKE ? ORDER BY name LIMIT ?`, loc, `%${q}%`, limit).map((c) => ({ id: c.id, name: c.name, sub: [c.domain, c.city].filter(Boolean).join(' · ') })),
    });

    app.services.companies = {
      get: (loc: string, cid: string) => getCompany(app, loc, cid),
      /**
       * Create or update; returns {id, created, company}. Imports (e.g. HubSpot) pass external_source/
       * external_id (idempotent: the same external record always lands on the same company) and
       * existing_id; without them the domain dedupes.
       */
      upsert: (loc: string, input: Record<string, any>, opts: CompanyOpts = {}) => {
        const { external_source, external_id, existing_id, ...rest } = input ?? {};
        const src = String(external_source ?? '').slice(0, 40);
        const ext = String(external_id ?? '').slice(0, 120);
        const known =
          (existing_id && getCompany(app, loc, String(existing_id))) ||
          (src && ext ? parseJson(db.get('SELECT * FROM companies WHERE location_id = ? AND external_source = ? AND external_id = ?', loc, src, ext), ['custom']) : undefined);
        const options: CompanyOpts = src ? { quiet: true, source: `${src === 'hubspot' ? 'HubSpot' : src}-Import`, ...opts } : opts;
        let r: { company: any; created: boolean };
        if (known) {
          const patch = Object.fromEntries(Object.entries(rest).filter(([k, v]) => v !== '' && v !== null && v !== undefined && k !== 'source' && k !== 'id'));
          // Another company may already own the domain: keep the link to the external record, drop the domain.
          if (patch.domain && findCompanyByDomain(app, loc, companyDomain(patch.domain))?.id !== known.id && findCompanyByDomain(app, loc, companyDomain(patch.domain))) delete patch.domain;
          r = { company: updateCompany(app, loc, known.id, patch, options), created: false };
        } else r = upsertCompany(app, loc, rest, options);
        if (src && ext) db.run('UPDATE companies SET external_source = ?, external_id = ? WHERE id = ?', src, ext, r.company.id);
        return { id: r.company.id, created: r.created, company: getCompany(app, loc, r.company.id) };
      },
      /** Links a contact to a company (the first company becomes the primary one). */
      linkContact: (loc: string, companyId: string, contactId: string) => A.link(loc, { type: 'contact', id: contactId }, { type: 'company', id: companyId }),
      update: (loc: string, cid: string, input: Record<string, any>, opts?: CompanyOpts) => updateCompany(app, loc, cid, input, opts),
      list: (loc: string, q: any) => listCompanies(app, loc, q),
      findByDomain: (loc: string, d: string) => findCompanyByDomain(app, loc, companyDomain(d)),
      syncContact: (loc: string, cid: string) => syncContact(app, loc, cid),
    };

    // --- keep contacts.company and the primary company in step --------------------------------
    A.onChange((c) => {
      const contact = c.a.type === 'contact' ? c.a : c.b.type === 'contact' ? c.b : undefined;
      const company = c.a.type === 'company' ? c.a : c.b.type === 'company' ? c.b : undefined;
      if (company) {
        const other = c.a === company ? c.b : c.a;
        if (c.kind !== 'updated' && other.type !== 'task') {
          const info = A.type(c.locationId, other.type)?.get(c.locationId, other.id);
          if (info) S.log(c.locationId, 'company', company.id, c.kind === 'linked' ? 'association.added' : 'association.removed', `${A.type(c.locationId, other.type)?.label ?? other.type} „${info.name}“ ${c.kind === 'linked' ? 'verknüpft' : 'entfernt'}`);
        }
      }
      if (!contact || !company) return;
      if (c.kind === 'linked' && !A.primary(c.locationId, contact, 'company')) return A.setPrimary(c.locationId, contact, company);
      if (c.kind === 'unlinked' && c.primaryOf === contact.id) return promoteOrClear(app, c.locationId, contact.id);
      writeContactCompanyText(app, c.locationId, contact.id);
    });
    const onContact = (e: any) => {
      if (e.data.contactId) syncContact(app, e.locationId, e.data.contactId);
    };
    app.events.on('contact.created', onContact);
    app.events.on('contact.updated', onContact);
    // A new deal belongs to its contact's primary company, like HubSpot's default.
    app.events.on('opportunity.created', (e) => {
      const opp = e.data.opportunity;
      if (!opp?.id || !e.data.contactId) return;
      const prim = A.primary(e.locationId, { type: 'contact', id: e.data.contactId }, 'company');
      if (prim && A.exists(e.locationId, { type: 'opportunity', id: opp.id })) A.link(e.locationId, { type: 'opportunity', id: opp.id }, { type: 'company', id: prim });
    });

    /**
     * Catch-up for contact changes without events (CSV imports, workflow "set field", the first
     * start with existing data): a cursor over contacts.updated_at, 300 contacts per tick.
     */
    function* catchUpSteps(limit: number): Generator<void, number> {
      const cursor = db.get('SELECT value FROM companies_sync WHERE key = ?', 'contacts')?.value ?? '';
      const rows = db.all(`SELECT id, location_id, updated_at FROM contacts WHERE updated_at > ? AND (company != '' OR email LIKE '%@%') ORDER BY updated_at LIMIT ?`, cursor, limit);
      if (!rows.length) return 0;
      const hasCompanies = new Map<string, boolean>();
      for (const r of rows) {
        const set = companySettings(app, r.location_id);
        if (!hasCompanies.has(r.location_id)) hasCompanies.set(r.location_id, !!db.get('SELECT 1 FROM companies WHERE location_id = ? LIMIT 1', r.location_id));
        // Without the text and without any company, only a domain-created company would apply.
        const c = db.get('SELECT company FROM contacts WHERE id = ?', r.id);
        if (!c?.company && !hasCompanies.get(r.location_id) && !set.create_from_domain) {
          yield;
          continue;
        }
        try {
          syncContact(app, r.location_id, r.id);
          hasCompanies.set(r.location_id, true);
        } catch (e) {
          console.error('[companies] sync', (e as Error).message);
        }
        yield;
      }
      db.run('INSERT INTO companies_sync (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'contacts', rows[rows.length - 1].updated_at);
      return rows.length;
    }
    /** All at once (tests, scripts). */
    const catchUp = (limit = 300) => {
      const steps = catchUpSteps(limit);
      for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
    };
    // In the background it runs in slices of ~40 ms, so requests are answered in between.
    app.onTick(async () => {
      const steps = catchUpSteps(300);
      const pause = sliceTimer(40);
      for (let r = steps.next(); !r.done; r = steps.next()) await pause();
    });
    app.services.companiesCatchUp = catchUp;

    // --- API ------------------------------------------------------------------------------------
    const uid = (ctx: Ctx) => ctx.user?.id ?? null;
    const listQuery = (ctx: Ctx) => ({
      q: ctx.query.get('q') ?? '',
      filters: ctx.query.get('filters') ?? '',
      sort: ctx.query.get('sort') ?? '',
      owner_id: ctx.query.get('owner_id') ?? '',
      lifecycle_stage: ctx.query.get('lifecycle_stage') ?? '',
      industry: ctx.query.get('industry') ?? '',
      limit: clampLimit(ctx.query.get('limit'), 50, 500),
      offset: num(ctx.query.get('offset'), 0),
      who: ctx,
    });
    router.get('/api/companies', 'location', (ctx) => listCompanies(app, ctx.locationId, listQuery(ctx)));

    router.get('/api/companies/settings', 'location', (ctx) => companySettings(app, ctx.locationId));
    router.put('/api/companies/settings', 'location', (ctx) => {
      const cur = companySettings(app, ctx.locationId);
      const next: CompanySettings = { ...cur };
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof CompanySettings)[]) if (ctx.body[k] !== undefined) next[k] = !!ctx.body[k];
      const loc = app.location(ctx.locationId)!;
      db.update('locations', ctx.locationId, { settings: sealSettings(app, { ...loc.settings, companies: next }).value });
      return next;
    });
    router.post('/api/companies/sync', 'location', (ctx) => {
      // Re-checks every contact of the sub-account (after changing the settings).
      let n = 0;
      for (const r of db.all('SELECT id FROM contacts WHERE location_id = ?', ctx.locationId)) {
        syncContact(app, ctx.locationId, r.id);
        n++;
      }
      return { contacts: n, companies: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM companies WHERE location_id = ?', ctx.locationId)!.n };
    });

    router.get('/api/companies/export.csv', 'location', (ctx) => {
      const { companies } = listCompanies(app, ctx.locationId, { ...listQuery(ctx), limit: 100000, offset: 0 });
      const access = resolve(app, ctx);
      const defs = S.defs(ctx.locationId, 'company');
      const users = new Map(S.users(ctx.locationId).map((u) => [u.id, u.email]));
      const header = [...COMPANY_FIELDS.map((k) => (k === 'owner_id' ? 'owner' : k)), ...defs.map((d) => d.key), 'contacts', 'deals_value', 'created_at'];
      const rows = companies.map((c) => [
        ...COMPANY_FIELDS.map((k) => (k === 'owner_id' ? (users.get(c.owner_id) ?? '') : (c[k] ?? ''))),
        ...defs.map((d) => displayValue(d, c.custom?.[d.key])),
        A.list(ctx.locationId, { type: 'company', id: c.id }, { type: 'contact' }).filter((x) => permits(app, access, 'contacts', x.record_id)).map((x) => x.sub || x.name).join(', '),
        c.deals_value,
        c.created_at,
      ]);
      const out = text('﻿' + toCsv([header, ...rows]), 'text/csv; charset=utf-8');
      out.headers['content-disposition'] = 'attachment; filename="firmen.csv"';
      return out;
    });

    router.post('/api/companies/import', 'location', (ctx) => {
      const rows = parseCsv(String(ctx.body.csv ?? ''));
      if (rows.length < 2) throw bad('CSV braucht eine Kopfzeile und mindestens eine Zeile');
      if (rows.length > 20001) throw bad('Höchstens 20.000 Zeilen auf einmal');
      const defs = S.defs(ctx.locationId, 'company');
      const mapping: Record<number, string> = {};
      rows[0].forEach((h, i) => {
        const given = ctx.body.mapping?.[h];
        const def = defs.find((d) => d.key === h.trim().toLowerCase() || d.label.toLowerCase() === h.trim().toLowerCase());
        const m = given ?? guessCompanyField(h) ?? (def ? `custom.${def.key}` : undefined);
        if (m) mapping[i] = m;
      });
      if (!Object.values(mapping).some((m) => m === 'name' || m === 'domain' || m === 'website')) throw bad('Spalte für Name, Domain oder Webseite fehlt');
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors: { row: number; error: string }[] = [];
      db.tx(() => rows.slice(1).forEach((row, i) => {
        const input: Record<string, any> = { custom: {} };
        for (const [col, field] of Object.entries(mapping)) {
          const v = row[Number(col)]?.trim();
          if (!v) continue;
          if (field.startsWith('custom.')) input.custom[field.slice(7)] = v;
          else input[field] = v;
        }
        if (!input.name && !input.domain && !input.website) return void skipped++;
        if (!Object.keys(input.custom).length) delete input.custom;
        try {
          // Dedupe: same domain, otherwise same name → update instead of a second company.
          const byName = !companyDomain(input.domain || input.website || '') && input.name ? findCompanyByName(app, ctx.locationId, input.name) : undefined;
          const r = byName ? { company: updateCompany(app, ctx.locationId, byName.id, input, { userId: uid(ctx), quiet: !ctx.body.triggerWorkflows }), created: false } : upsertCompany(app, ctx.locationId, input, { userId: uid(ctx), source: 'CSV-Import', quiet: !ctx.body.triggerWorkflows });
          r.created ? created++ : updated++;
        } catch (e) {
          if (errors.length < 50) errors.push({ row: i + 2, error: (e as Error).message });
          skipped++;
        }
      }));
      return { created, updated, skipped, errors, mapped: Object.values(mapping) };
    });

    router.get('/api/companies/duplicates', 'location', (ctx) => {
      const groups = db.all(
        `SELECT lower(name) AS k, json_group_array(id) AS ids FROM companies WHERE location_id = ? GROUP BY lower(name) HAVING COUNT(*) > 1
         UNION ALL SELECT domain AS k, json_group_array(id) AS ids FROM companies WHERE location_id = ? AND domain != '' GROUP BY domain HAVING COUNT(*) > 1 LIMIT 100`,
        ctx.locationId,
        ctx.locationId,
      );
      const access = resolve(app, ctx);
      return groups
        .map((g) => ({ key: g.k, companies: (JSON.parse(g.ids) as string[]).filter((cid) => permits(app, access, 'companies', cid)).map((cid) => getCompany(app, ctx.locationId, cid)).filter(Boolean).map((c) => maskRow(access, 'companies', c)) }))
        .filter((g) => !access || g.companies.length > 1);
    });

    router.post('/api/companies', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const r = upsertCompany(app, ctx.locationId, b, { userId: uid(ctx), source: ctx.viaApiKey ? 'API' : 'manuell' });
      if (Array.isArray(b.contact_ids)) for (const cid of b.contact_ids.map(String).slice(0, 500)) A.link(ctx.locationId, { type: 'contact', id: cid }, { type: 'company', id: r.company.id });
      return { ...r.company, created: r.created };
    });

    router.get('/api/companies/:id', 'location', (ctx) => {
      const c = getCompany(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Firma nicht gefunden');
      const loc = ctx.locationId;
      const ref: Ref = { type: 'company', id: c.id };
      const contacts = A.list(loc, ref, { type: 'contact' });
      const deals = A.list(loc, ref, { type: 'opportunity' }).map((d) => ({ ...d, ...(db.get('SELECT value, status, stage_id, pipeline_id FROM opportunities WHERE id = ?', d.record_id) ?? {}) }));
      const contactIds = contacts.map((x) => x.record_id);
      const inList = contactIds.map(() => '?').join(',');
      const contactActs = contactIds.length
        ? parseRows(db.all(`SELECT a.*, c.first_name, c.last_name, c.email FROM activities a JOIN contacts c ON c.id = a.contact_id WHERE a.location_id = ? AND a.contact_id IN (${inList}) ORDER BY a.created_at DESC LIMIT 150`, loc, ...contactIds), ['data'])
        : [];
      const own = S.activities(loc, 'company', c.id, 150);
      const notes = S.notes(loc, 'company', c.id);
      const timeline = [
        ...own.map((a) => ({ id: a.id, at: a.created_at, kind: 'company', type: a.type, summary: a.summary, by: a.user_name ?? null })),
        ...contactActs.map((a) => ({ id: a.id, at: a.created_at, kind: 'contact', type: a.type, summary: a.summary, contact_id: a.contact_id, contact_name: contactName(a) })),
        ...notes.map((n) => ({ id: n.id, at: n.created_at, kind: 'note', type: 'note', summary: n.body.slice(0, 200), by: n.user_name ?? null })),
      ]
        .sort((x, y) => (x.at < y.at ? 1 : -1))
        .slice(0, 200);
      const taskIds = A.ids(loc, ref, 'task');
      const tasks = taskIds.length ? db.all(`SELECT * FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')}) ORDER BY done, COALESCE(due_at, '9999')`, ...taskIds) : [];
      const contactTasks = contactIds.length ? db.all(`SELECT t.*, c.first_name, c.last_name, c.email FROM tasks t JOIN contacts c ON c.id = t.contact_id WHERE t.done = 0 AND t.contact_id IN (${inList}) ORDER BY COALESCE(t.due_at, '9999') LIMIT 50`, ...contactIds) : [];
      return {
        ...c,
        owner_name: c.owner_id ? (db.get('SELECT name FROM users WHERE id = ?', c.owner_id)?.name ?? null) : null,
        contacts,
        deals,
        deals_value: deals.filter((d: any) => d.status !== 'lost').reduce((n: number, d: any) => n + (d.value || 0), 0),
        notes,
        tasks,
        contact_tasks: contactTasks,
        timeline,
      };
    });

    router.patch('/api/companies/:id', 'location', (ctx) => {
      const { id: _drop, created_at: _c, ...patch } = ctx.body ?? {};
      return updateCompany(app, ctx.locationId, ctx.params.id, patch, { userId: uid(ctx) });
    });
    router.delete('/api/companies/:id', 'location', (ctx) => {
      deleteCompany(app, ctx.locationId, ctx.params.id, { userId: uid(ctx) });
      return { ok: true };
    });

    router.post('/api/companies/:id/merge', 'location', (ctx) => {
      const keep = getCompany(app, ctx.locationId, ctx.params.id);
      const other = getCompany(app, ctx.locationId, str(ctx.body.from_id, 'Zweite Firma', { required: true }));
      if (!keep || !other) throw notFound('Firma nicht gefunden');
      if (keep.id === other.id) throw bad('Zweimal dieselbe Firma');
      const loc = ctx.locationId;
      db.tx(() => {
        // Empty fields of the kept company take the other's values.
        const fill: Record<string, any> = {};
        for (const k of COMPANY_FIELDS) if (!keep[k] && other[k] && k !== 'domain') fill[k] = other[k];
        const custom = { ...(other.custom ?? {}), ...(keep.custom ?? {}) };
        db.update('companies', keep.id, { ...fill, ...(!keep.domain && other.domain ? { domain: other.domain } : {}), custom, updated_at: now() });
        const ref: Ref = { type: 'company', id: other.id };
        for (const r of db.all(`SELECT * FROM associations WHERE location_id = ? AND ((a_type = 'company' AND a_id = ?) OR (b_type = 'company' AND b_id = ?))`, loc, other.id, other.id)) {
          const side: Ref = r.a_type === 'company' && r.a_id === other.id ? { type: r.b_type, id: r.b_id } : { type: r.a_type, id: r.a_id };
          if (side.type === 'company' && side.id === keep.id) continue;
          A.link(loc, side, { type: 'company', id: keep.id }, { labels: JSON.parse(r.labels || '[]'), addLabels: true });
          if (r.primary_of === side.id) A.setPrimary(loc, side, { type: 'company', id: keep.id });
        }
        db.run(`UPDATE record_notes SET record_id = ? WHERE object_key = 'company' AND record_id = ?`, keep.id, other.id);
        db.run(`UPDATE record_activities SET record_id = ? WHERE object_key = 'company' AND record_id = ?`, keep.id, other.id);
        A.removeAll(ref);
        db.run('DELETE FROM companies WHERE id = ?', other.id);
        S.log(loc, 'company', keep.id, 'company.merged', `„${other.name}“ zusammengeführt`, { from: other.id }, uid(ctx));
      });
      const company = getCompany(app, loc, keep.id)!;
      app.events.emit(loc, 'company.updated', { companyId: keep.id, company, changed: ['merged'] });
      return company;
    });

    router.post('/api/companies/:id/notes', 'location', (ctx) => {
      if (!getCompany(app, ctx.locationId, ctx.params.id)) throw notFound('Firma nicht gefunden');
      return S.addNote(ctx.locationId, 'company', ctx.params.id, str(ctx.body.body, 'Notiz', { required: true, max: 20000 }), uid(ctx));
    });
    router.post('/api/companies/:id/tasks', 'location', (ctx) => {
      const c = getCompany(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Firma nicht gefunden');
      const contactId = ctx.body.contact_id ? String(ctx.body.contact_id) : null;
      if (contactId && !getContact(app, ctx.locationId, contactId)) throw bad('Kontakt nicht gefunden');
      const t = {
        id: id(),
        location_id: ctx.locationId,
        contact_id: contactId,
        title: str(ctx.body.title, 'Titel', { required: true, max: 300 }),
        description: str(ctx.body.description, 'Beschreibung', { max: 5000 }),
        due_at: ctx.body.due_at || null,
        assigned_to: ctx.body.assigned_to || ctx.user?.id || null,
        done: 0,
        created_at: now(),
      };
      db.insert('tasks', t);
      A.link(ctx.locationId, { type: 'task', id: t.id }, { type: 'company', id: c.id });
      S.log(ctx.locationId, 'company', c.id, 'task.created', `Aufgabe „${t.title}“ angelegt`, {}, uid(ctx));
      return t;
    });
    router.get('/api/companies/:id/activities', 'location', (ctx) => {
      if (!getCompany(app, ctx.locationId, ctx.params.id)) throw notFound('Firma nicht gefunden');
      return S.activities(ctx.locationId, 'company', ctx.params.id, clampLimit(ctx.query.get('limit'), 100, 500));
    });

    // --- contact lists & smart lists: filter by properties of associated companies ------------
    const FILTERABLE = new Set([...COMPANY_FIELDS, 'id', 'q', 'none']);
    app.services.contactFilters = [
      ...(app.services.contactFilters ?? []),
      (f: any) => {
        const entries: [string, string][] = [];
        const seen = new Set<string>();
        const add = (k: string, v: unknown) => {
          if (!k.startsWith('company.') || seen.has(k)) return;
          const s = String(v ?? '').trim();
          if (!s) return;
          seen.add(k);
          entries.push([k.slice(8), s]);
        };
        if (f?.query?.entries) for (const [k, v] of f.query.entries()) add(k, v);
        if (f?.extra && typeof f.extra === 'object') for (const [k, v] of Object.entries(f.extra)) add(k, v);
        if (f?.extra?.company && typeof f.extra.company === 'object') for (const [k, v] of Object.entries(f.extra.company)) add(`company.${k}`, v);
        if (!entries.length) return undefined;
        const conds: string[] = [];
        const params: unknown[] = [];
        let none = false;
        for (const [field, v] of entries) {
          if (field === 'none') {
            none = v === '1' || v === 'true';
            continue;
          }
          if (field === 'id') conds.push('co.id = ?'), params.push(v);
          else if (field === 'q') conds.push(`(co.name || ' ' || co.domain) LIKE ?`), params.push(`%${v}%`);
          else if (FILTERABLE.has(field)) conds.push(`lower(co.${field}) = lower(?)`), params.push(v);
          else if (field.startsWith('custom.') && /^[a-z][a-z0-9_]*$/.test(field.slice(7))) {
            conds.push(`(lower(CAST(json_extract(co.custom, '$.${field.slice(7)}') AS TEXT)) = lower(?) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(co.custom, '$.${field.slice(7)}') = 'array' THEN json_extract(co.custom, '$.${field.slice(7)}') ELSE '[]' END) WHERE lower(value) = lower(?)))`);
            params.push(v, v);
          }
        }
        const join = `FROM associations a JOIN companies co ON co.id = CASE WHEN a.a_type = 'company' THEN a.a_id ELSE a.b_id END
          WHERE a.location_id = contacts.location_id AND ((a.a_type = 'company' AND a.b_type = 'contact' AND a.b_id = contacts.id) OR (a.b_type = 'company' AND a.a_type = 'contact' AND a.a_id = contacts.id))`;
        if (none && !conds.length) return { sql: `NOT EXISTS (SELECT 1 ${join})`, params: [] };
        if (!conds.length) return undefined;
        return { sql: `EXISTS (SELECT 1 ${join} AND ${conds.join(' AND ')})`, params };
      },
    ];
  },
};
