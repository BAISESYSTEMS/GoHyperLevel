import { zonedToUtc } from '../core/time.js';
import { normalizeEmail, normalizePhone } from '../core/util.js';

/**
 * Building blocks of the relational CRM (companies, custom objects, properties): property types,
 * value checks per type, list filters on JSON properties and domain helpers. Pure functions – the
 * modules (object-schema, companies, custom-objects) add the database around them.
 */

export const PROPERTY_TYPES = {
  text: 'Text',
  textarea: 'Mehrzeiliger Text',
  number: 'Zahl',
  currency: 'Währung (€)',
  date: 'Datum',
  datetime: 'Datum & Uhrzeit',
  select: 'Auswahl',
  multiselect: 'Mehrfachauswahl',
  checkbox: 'Checkbox',
  url: 'URL',
  email: 'E-Mail',
  phone: 'Telefon',
  user: 'Nutzer',
  file: 'Datei',
} as const;
export type PropertyType = keyof typeof PROPERTY_TYPES;

/** Types the contact page can show (contact custom fields keep their own, smaller set). */
export const CONTACT_FIELD_TYPES: PropertyType[] = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'email', 'phone', 'url'];

export interface PropertyDef {
  key: string;
  label: string;
  type: PropertyType;
  options: string[];
  group_key: string;
  description: string;
  required: boolean;
  unique: boolean;
  position: number;
}

export const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

export class ValueError extends Error {}

const err = (m: string) => new ValueError(m);

/** "Mein Feld!" → "mein_feld" (a-z, 0-9, _; starts with a letter). */
export function keyFromLabel(label: string): string {
  const k = label
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 60);
}

/** Checks and normalises a property definition coming from the API. */
export function cleanPropertyDef(input: any, opts: { existing?: Partial<PropertyDef>; types?: PropertyType[] } = {}): PropertyDef {
  const ex = opts.existing;
  const label = String(input?.label ?? ex?.label ?? '').trim().slice(0, 100);
  if (!label) throw err('Bezeichnung fehlt');
  const key = ex?.key ?? (String(input?.key ?? '').trim() || keyFromLabel(label));
  if (!KEY_RE.test(key)) throw err('Interner Name: nur a-z, 0-9 und _ (beginnt mit einem Buchstaben)');
  const allowed = opts.types ?? (Object.keys(PROPERTY_TYPES) as PropertyType[]);
  const type = (input?.type ?? ex?.type ?? 'text') as PropertyType;
  if (!allowed.includes(type)) throw err(`Unbekannter Typ: ${type}`);
  const rawOpts = input?.options ?? ex?.options ?? [];
  const options = [...new Set((Array.isArray(rawOpts) ? rawOpts : String(rawOpts).split(',')).map((o: unknown) => String(o).trim().slice(0, 100)).filter(Boolean))].slice(0, 200);
  if ((type === 'select' || type === 'multiselect') && !options.length) throw err('Auswahl braucht mindestens eine Option');
  return {
    key,
    label,
    type,
    options: type === 'select' || type === 'multiselect' ? options : [],
    group_key: String(input?.group_key ?? ex?.group_key ?? '').trim().slice(0, 60),
    description: String(input?.description ?? ex?.description ?? '').trim().slice(0, 500),
    required: !!(input?.required ?? ex?.required),
    unique: !!(input?.unique ?? ex?.unique) && !['checkbox', 'multiselect', 'textarea', 'file'].includes(type),
    position: Number.isFinite(Number(input?.position)) ? Number(input.position) : (ex?.position ?? 0),
  };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/** A calendar day that exists (Date.parse takes "2026-02-31" as 3 March, so the parts are checked themselves). */
const realYmd = (y: string, m: string, d: string): string | null => {
  const ymd = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd ? ymd : null;
};

/** Reads YYYY-MM-DD or DD.MM.YYYY (also ISO timestamps) into YYYY-MM-DD; null for a day that does not exist. */
function day(v: unknown): string | null {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return realYmd(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return realYmd(m[3], m[2], m[1]);
  return null;
}

function parseNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[€\s]/g, '');
  // German notation 1.234,56 → 1234.56
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  return Number(s);
}

const pick = (options: string[], v: string) => options.find((o) => o.toLowerCase() === v.trim().toLowerCase());

/**
 * One value for a property, checked and normalised by type; null means "empty". Throws a
 * ValueError with a German message. user/file values are only shape-checked here – the module
 * checks that the user or upload belongs to the sub-account.
 */
export function coerceValue(def: Pick<PropertyDef, 'label' | 'type' | 'options'>, raw: unknown, tz = 'Europe/Berlin'): unknown {
  if (isEmpty(raw)) return null;
  const L = `„${def.label}“`;
  switch (def.type) {
    case 'text':
    case 'textarea': {
      const s = String(raw).trim();
      const max = def.type === 'text' ? 2000 : 20000;
      if (s.length > max) throw err(`${L} ist zu lang`);
      return s || null;
    }
    case 'number':
    case 'currency': {
      const n = parseNumber(raw);
      if (!Number.isFinite(n)) throw err(`${L} muss eine Zahl sein`);
      return def.type === 'currency' ? Math.round(n * 100) / 100 : n;
    }
    case 'date': {
      const d = day(raw);
      if (!d || Number.isNaN(Date.parse(d))) throw err(`${L}: Datum als JJJJ-MM-TT oder TT.MM.JJJJ`);
      return d;
    }
    case 'datetime': {
      const s = String(raw).trim();
      // A wall-clock time without a zone ("24.12.2026 18:00", "2026-12-24T18:00") is the sub-account's – Date.parse would take the
      // server's zone (UTC in the Docker image: 18:00 became 19:00 in Berlin). An instant with Z or an offset stays as it is.
      const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/);
      const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/);
      const local = de ? { ymd: realYmd(de[3], de[2], de[1]), h: de[4], m: de[5] } : iso ? { ymd: realYmd(iso[1], iso[2], iso[3]), h: iso[4], m: iso[5] } : null;
      let t: number;
      if (local) {
        const hh = Number(local.h ?? 0);
        const mm = Number(local.m ?? 0);
        if (!local.ymd || hh > 23 || mm > 59) throw err(`${L}: ungültiges Datum/Uhrzeit`);
        try {
          t = zonedToUtc(local.ymd, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, tz).getTime();
        } catch {
          t = Date.parse(`${local.ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
        }
      } else t = Date.parse(s);
      if (Number.isNaN(t)) throw err(`${L}: ungültiges Datum/Uhrzeit`);
      return new Date(t).toISOString();
    }
    case 'select': {
      const v = pick(def.options, String(raw));
      if (!v) throw err(`${L}: „${String(raw).slice(0, 60)}“ ist keine Option (${def.options.join(', ')})`);
      return v;
    }
    case 'multiselect': {
      const list = Array.isArray(raw) ? raw : String(raw).split(/[,;|]/);
      const out: string[] = [];
      for (const x of list.map((s) => String(s).trim()).filter(Boolean)) {
        const v = pick(def.options, x);
        if (!v) throw err(`${L}: „${x.slice(0, 60)}“ ist keine Option (${def.options.join(', ')})`);
        if (!out.includes(v)) out.push(v);
      }
      return out.length ? out : null;
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (['1', 'true', 'ja', 'yes', 'x', 'wahr', 'on'].includes(s)) return true;
      if (['0', 'false', 'nein', 'no', 'falsch', 'off'].includes(s)) return false;
      throw err(`${L}: ja oder nein`);
    }
    case 'url': {
      let s = String(raw).trim();
      if (!/^https?:\/\//i.test(s)) {
        if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s)) s = `https://${s}`;
        else throw err(`${L}: Adresse mit https:// angeben`);
      }
      try {
        const u = new URL(s);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        throw err(`${L}: ungültige Adresse`);
      }
      if (s.length > 2000) throw err(`${L} ist zu lang`);
      return s;
    }
    case 'email': {
      const e = normalizeEmail(raw);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw err(`${L}: ungültige E-Mail`);
      return e;
    }
    case 'phone': {
      const p = normalizePhone(String(raw));
      if (p.replace(/\D/g, '').length < 5) throw err(`${L}: ungültige Telefonnummer`);
      return p;
    }
    case 'user':
      if (typeof raw !== 'string' || raw.length > 64) throw err(`${L}: Nutzer-ID erwartet`);
      return raw;
    case 'file': {
      const fid = typeof raw === 'object' ? (raw as any)?.id ?? (raw as any)?.upload_id : raw;
      if (typeof fid !== 'string' || !fid || fid.length > 64) throw err(`${L}: Datei (Upload-ID) erwartet`);
      return fid;
    }
    default:
      throw err(`${L}: unbekannter Typ`);
  }
}

/**
 * Checks a set of property values against their definitions. With `partial` only the given keys
 * are checked (PATCH); otherwise required properties must be filled. Unknown keys are refused.
 * Returns the values to store (null = remove).
 */
export function validateProps(defs: PropertyDef[], input: Record<string, unknown>, opts: { partial?: boolean; current?: Record<string, unknown>; /** Zone of wall-clock date-times without one (the sub-account's). */ tz?: string } = {}): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('Eigenschaften als Objekt angeben');
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const def = byKey.get(k);
    if (!def) throw err(`Unbekannte Eigenschaft: ${k}`);
    out[k] = coerceValue(def, v, opts.tz);
  }
  for (const d of defs) {
    if (!d.required) continue;
    const next = k(out, d.key) ? out[d.key] : opts.current?.[d.key];
    if ((opts.partial ? k(out, d.key) : true) && isEmpty(next)) throw err(`„${d.label}“ ist ein Pflichtfeld`);
  }
  return out;
}
const k = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** Applies validated values (null removes the key). */
export function mergeProps(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...(current ?? {}) };
  for (const [key, v] of Object.entries(patch)) {
    if (v === null) delete out[key];
    else out[key] = v;
  }
  return out;
}

/** Keys whose value changed between two property sets. */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null));
}

/** Readable value for lists, CSV and activity entries. */
export function displayValue(def: Pick<PropertyDef, 'type'> | undefined, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (def?.type === 'checkbox') return v ? 'ja' : 'nein';
  if (def?.type === 'currency' && typeof v === 'number') return v.toFixed(2).replace('.', ',');
  if (typeof v === 'object') return String((v as any).name ?? (v as any).id ?? JSON.stringify(v));
  return String(v);
}

// --- list filters ---------------------------------------------------------------------------

export const FILTER_OPS = ['eq', 'neq', 'contains', 'not_contains', 'empty', 'not_empty', 'gt', 'lt', 'gte', 'lte', 'in'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export interface Filter {
  field: string;
  op: FilterOp;
  value?: unknown;
}
/** Where a filterable field lives: a SQL expression plus its type (decides how it compares). */
export type FieldExpr = (field: string) => { sql: string; type: PropertyType | 'id' } | undefined;

/** JSON path expression for a property key (keys are checked against KEY_RE first). */
export const jsonPath = (col: string, key: string) => {
  if (!KEY_RE.test(key)) throw err(`Ungültiges Feld: ${key}`);
  return `json_extract(${col}, '$.${key}')`;
};

/** Parses filters from a query string (JSON array) or a saved view. */
export function parseFilters(v: unknown): Filter[] {
  let list: unknown = v;
  if (typeof v === 'string') {
    if (!v.trim()) return [];
    try {
      list = JSON.parse(v);
    } catch {
      throw err('Filter: ungültiges JSON');
    }
  }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 30).map((f: any) => {
    if (!f || typeof f.field !== 'string' || !FILTER_OPS.includes(f.op)) throw err('Filter: field und op (eq, neq, contains, not_contains, empty, not_empty, gt, lt, gte, lte, in) angeben');
    return { field: f.field, op: f.op, value: f.value };
  });
}

/** SQL conditions (AND-ed) for filters; unknown fields are refused. */
export function filterSql(filters: Filter[], expr: FieldExpr): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    const e = expr(f.field);
    if (!e) throw err(`Filter: unbekanntes Feld ${f.field}`);
    const x = e.sql;
    const val = f.value;
    const numeric = e.type === 'number' || e.type === 'currency';
    if (f.op === 'empty' || f.op === 'not_empty') {
      const cond = e.type === 'multiselect' ? `(${x} IS NULL OR ${x} = '[]')` : `(${x} IS NULL OR ${x} = '')`;
      where.push(f.op === 'empty' ? cond : `NOT ${cond}`);
      continue;
    }
    if (e.type === 'multiselect') {
      const vals = (Array.isArray(val) ? val : String(val ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
      if (!vals.length) continue;
      const cond = `EXISTS (SELECT 1 FROM json_each(COALESCE(${x}, '[]')) WHERE lower(value) IN (${vals.map(() => 'lower(?)').join(',')}))`;
      where.push(f.op === 'neq' || f.op === 'not_contains' ? `NOT ${cond}` : cond);
      params.push(...vals);
      continue;
    }
    if (e.type === 'checkbox') {
      const on = val === true || ['1', 'true', 'ja', 'yes'].includes(String(val).toLowerCase());
      where.push(f.op === 'neq' ? `COALESCE(${x}, 0) != ?` : `COALESCE(${x}, 0) = ?`);
      params.push(on ? 1 : 0);
      continue;
    }
    switch (f.op) {
      case 'eq':
      case 'neq':
        if (numeric) where.push(`CAST(${x} AS REAL) ${f.op === 'eq' ? '=' : '!='} ?`), params.push(parseNumber(val));
        else where.push(`${f.op === 'eq' ? '' : 'NOT '}(lower(COALESCE(${x}, '')) = lower(?))`), params.push(String(val ?? ''));
        break;
      case 'contains':
      case 'not_contains':
        where.push(`${f.op === 'contains' ? '' : 'NOT '}(lower(COALESCE(${x}, '')) LIKE lower(?))`);
        params.push(`%${String(val ?? '')}%`);
        break;
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte': {
        const sym = { gt: '>', lt: '<', gte: '>=', lte: '<=' }[f.op];
        if (numeric) where.push(`CAST(${x} AS REAL) ${sym} ?`), params.push(parseNumber(val));
        else where.push(`${x} ${sym} ?`), params.push(String(val ?? ''));
        break;
      }
      case 'in': {
        const vals = (Array.isArray(val) ? val : String(val ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
        if (!vals.length) break;
        where.push(`lower(COALESCE(${x}, '')) IN (${vals.map(() => 'lower(?)').join(',')})`);
        params.push(...vals);
        break;
      }
    }
  }
  return { where, params };
}

/** ORDER BY for "field" or "-field" (descending); falls back to the given default. */
export function sortSql(sort: unknown, expr: FieldExpr, fallback: string): string {
  const s = String(sort ?? '').trim();
  if (!s) return fallback;
  const desc = s.startsWith('-');
  const e = expr(desc ? s.slice(1) : s);
  if (!e) return fallback;
  const x = e.type === 'number' || e.type === 'currency' ? `CAST(${e.sql} AS REAL)` : e.type === 'id' ? e.sql : `lower(COALESCE(${e.sql}, ''))`;
  return `${x} IS NULL, ${x} ${desc ? 'DESC' : 'ASC'}`;
}

// --- domains --------------------------------------------------------------------------------

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.Acme.de/kontakt" or "info@acme.de" → "acme.de"; "" when it isn't a domain. */
export function companyDomain(v: unknown): string {
  let s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop() ?? '';
  s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\d?\./, '');
  return DOMAIN_RE.test(s) ? s : '';
}

/** Mailbox providers: an address there says nothing about the employer. */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.de', 'yahoo.co.uk', 'yahoo.fr', 'ymail.com', 'outlook.com', 'outlook.de', 'hotmail.com',
  'hotmail.de', 'hotmail.co.uk', 'live.com', 'live.de', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.de', 'gmx.de', 'gmx.net',
  'gmx.at', 'gmx.ch', 'gmx.com', 'web.de', 't-online.de', 'freenet.de', 'posteo.de', 'posteo.net', 'mailbox.org', 'protonmail.com', 'proton.me',
  'pm.me', 'tutanota.com', 'tutanota.de', 'tuta.io', 'yandex.com', 'yandex.ru', 'mail.ru', 'zoho.com', 'arcor.de', 'online.de', '1und1.de',
  'kabelmail.de', 'vodafone.de', 'email.de', 'bluewin.ch', 'a1.net', 'chello.at', 'magenta.de', 'mail.de', 'fastmail.com', 'hey.com', 'qq.com',
  '163.com', 'example.com', 'example.org', 'example.net',
]);
export const isFreeMail = (domain: string) => FREE_MAIL_DOMAINS.has(domain.toLowerCase());

/** "mueller-bau.de" → "Mueller Bau" (a readable first guess for a company name). */
export function nameFromDomain(domain: string): string {
  const base = domain.split('.').slice(0, -1).join(' ') || domain;
  return base
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// --- built-in objects -----------------------------------------------------------------------

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
export const LIFECYCLE_STAGES: [string, string][] = [
  ['subscriber', 'Abonnent'],
  ['lead', 'Lead'],
  ['mql', 'Marketing-qualifiziert (MQL)'],
  ['sql', 'Vertriebs-qualifiziert (SQL)'],
  ['opportunity', 'Opportunity'],
  ['customer', 'Kunde'],
  ['evangelist', 'Fürsprecher'],
  ['other', 'Sonstiges'],
];

export interface ObjectInfo {
  key: string;
  label: string;
  plural: string;
  icon: string;
  builtin: boolean;
  /** Custom objects: the property shown as the record's name. */
  primary?: string;
  id?: string;
}

export const BUILTIN_OBJECTS: ObjectInfo[] = [
  { key: 'contact', label: 'Kontakt', plural: 'Kontakte', icon: 'contact', builtin: true },
  { key: 'company', label: 'Firma', plural: 'Firmen', icon: 'company', builtin: true },
  { key: 'opportunity', label: 'Deal', plural: 'Deals', icon: 'deal', builtin: true },
];

type Std = Pick<PropertyDef, 'key' | 'label' | 'type'> & { options?: string[] };
/** Standard properties of the built-in objects (fixed columns; shown read-only on the properties page). */
export const STANDARD_PROPS: Record<string, Std[]> = {
  contact: [
    { key: 'first_name', label: 'Vorname', type: 'text' },
    { key: 'last_name', label: 'Nachname', type: 'text' },
    { key: 'email', label: 'E-Mail', type: 'email' },
    { key: 'phone', label: 'Telefon', type: 'phone' },
    { key: 'company', label: 'Firma (Text, synchron zur primären Firma)', type: 'text' },
    { key: 'website', label: 'Webseite', type: 'url' },
    { key: 'address', label: 'Adresse', type: 'text' },
    { key: 'postal_code', label: 'PLZ', type: 'text' },
    { key: 'city', label: 'Ort', type: 'text' },
    { key: 'country', label: 'Land', type: 'text' },
    { key: 'date_of_birth', label: 'Geburtstag', type: 'date' },
    { key: 'source', label: 'Quelle', type: 'text' },
  ],
  company: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'domain', label: 'Domain', type: 'text' },
    { key: 'industry', label: 'Branche', type: 'text' },
    { key: 'size', label: 'Größe (Mitarbeitende)', type: 'select', options: COMPANY_SIZES },
    { key: 'phone', label: 'Telefon', type: 'phone' },
    { key: 'website', label: 'Webseite', type: 'url' },
    { key: 'address', label: 'Adresse', type: 'text' },
    { key: 'postal_code', label: 'PLZ', type: 'text' },
    { key: 'city', label: 'Ort', type: 'text' },
    { key: 'country', label: 'Land', type: 'text' },
    { key: 'owner_id', label: 'Zuständig', type: 'user' },
    { key: 'lifecycle_stage', label: 'Lebenszyklusphase', type: 'select', options: LIFECYCLE_STAGES.map(([k]) => k) },
    { key: 'description', label: 'Beschreibung', type: 'textarea' },
  ],
  opportunity: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'value', label: 'Wert', type: 'currency' },
    { key: 'status', label: 'Status', type: 'select', options: ['open', 'won', 'lost', 'abandoned'] },
    { key: 'source', label: 'Quelle', type: 'text' },
  ],
};

/** Keys custom objects get: p_<name>, never clashing with built-in or module types (ticket…). */
export const CUSTOM_OBJECT_RE = /^p_[a-z0-9_]{1,40}$/;
