import type { App } from '../core/app.js';
import { bad } from '../core/http.js';

/**
 * Smart Lists 2.0 – the pure parts (docs/sales.md#smart-lists): which columns a saved contact view may show and sort by, and the
 * ORDER BY for a sort key. Sorting never puts text from the request into SQL: built-in keys map to fixed SQL below, custom
 * fields must match a strict key pattern *and* exist in the sub-account, and their JSON path travels as a bound parameter.
 */

export type Dir = 'asc' | 'desc';
interface SortDef {
  sql: string;
  dir: Dir;
}

/** Built-in sort keys → fixed SQL on the `contacts` table (unaliased, as findContacts queries it). */
const BUILTIN: Record<string, SortDef> = {
  name: { sql: `lower(trim(first_name || ' ' || last_name))`, dir: 'asc' },
  first_name: { sql: 'lower(first_name)', dir: 'asc' },
  last_name: { sql: 'lower(last_name)', dir: 'asc' },
  email: { sql: 'lower(email)', dir: 'asc' },
  phone: { sql: 'phone', dir: 'asc' },
  company: { sql: 'lower(company)', dir: 'asc' },
  city: { sql: 'lower(city)', dir: 'asc' },
  postal_code: { sql: 'postal_code', dir: 'asc' },
  country: { sql: 'lower(country)', dir: 'asc' },
  website: { sql: 'lower(website)', dir: 'asc' },
  source: { sql: 'lower(source)', dir: 'asc' },
  date_of_birth: { sql: 'date_of_birth', dir: 'asc' },
  created: { sql: 'created_at', dir: 'desc' },
  updated: { sql: 'updated_at', dir: 'desc' },
  activity: { sql: 'last_activity_at', dir: 'desc' },
};
export const SORT_KEYS = Object.keys(BUILTIN);

/** Columns a contact smart list can show: the list's own plus custom fields as `custom.<key>`. */
export const LIST_COLUMNS = ['name', 'email', 'phone', 'tags', 'score', 'source', 'health', 'created', 'company', 'city', 'activity'] as const;
export const DEFAULT_COLUMNS = ['name', 'email', 'phone', 'tags'];
const CUSTOM_RE = /^custom\.([A-Za-z0-9_]{1,60})$/;

/** The custom field behind `custom.<key>`, or undefined when the key is malformed or not a field of this sub-account. */
function customField(app: App, locationId: string, key: string): { key: string; type: string } | undefined {
  const m = CUSTOM_RE.exec(key);
  if (!m) return undefined;
  return app.db.get<{ key: string; type: string }>('SELECT key, type FROM custom_fields WHERE location_id = ? AND key = ?', locationId, m[1]);
}

export const cleanDir = (v: unknown): Dir | '' => (v === 'asc' || v === 'desc' ? v : '');

/**
 * ORDER BY for a sort key: `{ sql, params }`, or undefined for a key this function does not know (the caller falls back to its
 * default or to the sorts other modules register in `contactSorts`). Empty values always come last; ties by newest first.
 */
export function contactOrder(app: App, locationId: string, key: string, dir?: string): { sql: string; params: string[] } | undefined {
  const d = BUILTIN[key];
  if (d) {
    const way = (cleanDir(dir) || d.dir).toUpperCase();
    return { sql: `(${d.sql} IS NULL OR ${d.sql} = '') ASC, ${d.sql} ${way}, created_at DESC, id`, params: [] };
  }
  const f = customField(app, locationId, key);
  if (!f) return undefined;
  const way = (cleanDir(dir) || 'asc').toUpperCase();
  const path = `$.${f.key}`;
  const raw = 'json_extract(custom, ?)';
  const expr = f.type === 'number' ? `CAST(${raw} AS REAL)` : `lower(CAST(${raw} AS TEXT))`;
  return { sql: `(${raw} IS NULL OR ${raw} = '') ASC, ${expr} ${way}, created_at DESC, id`, params: [path, path, path] };
}

/** A sort key a list may store: built-in, a custom field of the sub-account, or a sort another module registered (e.g. `score`). */
export function cleanSort(app: App, locationId: string, v: unknown): string {
  const key = String(v ?? '').trim();
  if (!key) return '';
  if (BUILTIN[key] || app.services.contactSorts?.[key] || customField(app, locationId, key)) return key;
  throw bad(`Sortierung „${key.slice(0, 60)}“ gibt es nicht`);
}

/** Columns to show: known keys and existing custom fields, in the given order, without duplicates (unknown ones dropped). */
export function cleanColumns(app: App, locationId: string, v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v.slice(0, 40)) {
    const k = String(raw ?? '').trim();
    if (out.includes(k)) continue;
    if ((LIST_COLUMNS as readonly string[]).includes(k) || customField(app, locationId, k)) out.push(k);
  }
  return out;
}

/** The saved filter: the contact list's query values (search, tags, attribution, company, score, health …) – plain values only. */
export function cleanFilter(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('Filter: ein Objekt angeben');
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(k)) continue;
    if (typeof x === 'string') out[k] = x.slice(0, 300);
    else if (typeof x === 'number' || typeof x === 'boolean') out[k] = x;
    else if (Array.isArray(x)) out[k] = x.filter((y) => typeof y === 'string').slice(0, 50).map((y) => (y as string).slice(0, 120));
    else if (x && typeof x === 'object') out[k] = cleanFilter(x);
  }
  if (JSON.stringify(out).length > 8000) throw bad('Filter zu groß');
  return out;
}

// --- loading a list by id: the one gate every module goes through -----------------------------------------------------------

/**
 * Who loads a list: a request (`ctx` – a person, or a key/automation without one) or `'system'` for background work that runs a
 * reference somebody already attached (scheduled campaign sends). A person sees shared lists and their own private ones; a
 * request without a person sees the shared ones only; `'system'` sees every list of the sub-account.
 */
export type ListReader = { user?: { id: string } | null } | 'system';

/** WHERE part for the lists `who` may load (on `smart_lists`, optional alias), sub-account included. */
export function smartListScope(locationId: string, who: ListReader, alias = ''): { sql: string; params: string[] } {
  const a = alias ? `${alias}.` : '';
  if (who === 'system') return { sql: `${a}location_id = ?`, params: [locationId] };
  return { sql: `${a}location_id = ? AND (${a}visibility = 'shared' OR ${a}owner_id = ?)`, params: [locationId, who.user?.id ?? ''] };
}

export interface SmartListRow {
  id: string;
  location_id: string;
  name: string;
  filter: Record<string, any>;
  columns: string[];
  sort: string;
  sort_dir: string;
  visibility: 'shared' | 'private';
  owner_id: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * A smart list by id, or undefined when it does not exist in the sub-account – or is another person's private list, which is
 * treated exactly like a missing one (dialer, sequences, surveys, ad audiences, campaigns … all load lists through here).
 */
export function smartListById(app: App, locationId: string, listId: unknown, who: ListReader): SmartListRow | undefined {
  const sid = String(listId ?? '');
  if (!sid) return undefined;
  const s = smartListScope(locationId, who);
  const row = app.db.get<any>(`SELECT * FROM smart_lists WHERE id = ? AND ${s.sql}`, sid, ...s.params);
  if (!row) return undefined;
  const parse = (v: unknown, def: any) => {
    try {
      return typeof v === 'string' ? JSON.parse(v) : (v ?? def);
    } catch {
      return def;
    }
  };
  return { ...row, filter: parse(row.filter, {}) ?? {}, columns: parse(row.columns, []) ?? [] };
}
