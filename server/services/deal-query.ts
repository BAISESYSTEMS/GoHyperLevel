import type { App } from '../core/app.js';
import { filterSql, KEY_RE, parseFilters, sortSql, type FieldExpr, type PropertyDef, type PropertyType } from './objects.js';

/**
 * Filters and sorting of the deal list (`GET /api/opportunities?filters=[…]&sort=-value`, its CSV export and the bulk actions).
 * Uses the same filter engine as companies and custom objects (services/objects.ts): a filter names a field, an operator and a
 * value; the fields are the deal's own columns, a few of its contact's, and the custom deal properties as `props.<key>`.
 * Everything that reaches SQL is fixed code – user values only travel as parameters.
 */

/** The deal's own fields and a few of the contact's, with their type (decides how a filter compares). */
export const DEAL_FIELDS: Record<string, { sql: string; type: PropertyType | 'id' }> = {
  name: { sql: 'o.name', type: 'text' },
  value: { sql: 'o.value', type: 'number' },
  currency: { sql: 'o.currency', type: 'select' },
  status: { sql: 'o.status', type: 'select' },
  pipeline_id: { sql: 'o.pipeline_id', type: 'select' },
  stage_id: { sql: 'o.stage_id', type: 'select' },
  assigned_to: { sql: 'o.assigned_to', type: 'user' },
  source: { sql: 'o.source', type: 'text' },
  lost_reason: { sql: 'o.lost_reason', type: 'text' },
  expected_close_date: { sql: 'o.expected_close_date', type: 'date' },
  created_at: { sql: 'o.created_at', type: 'datetime' },
  updated_at: { sql: 'o.updated_at', type: 'datetime' },
  stage_changed_at: { sql: 'o.stage_changed_at', type: 'datetime' },
  contact_name: { sql: `trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))`, type: 'text' },
  contact_email: { sql: 'c.email', type: 'email' },
  contact_phone: { sql: 'c.phone', type: 'phone' },
  contact_company: { sql: 'c.company', type: 'text' },
  tags: { sql: 'c.tags', type: 'multiselect' },
};

/** Custom deal properties (Einstellungen → Eigenschaften → Deals), or none when the module is not there. */
export const dealProps = (app: App, locationId: string): PropertyDef[] => {
  try {
    return (app.services.objectSchema?.defs?.(locationId, 'opportunity') as PropertyDef[] | undefined) ?? [];
  } catch {
    return [];
  }
};

/** Field → SQL for the filter engine; `props.<key>` reads the deal's stored properties (joined as `rp`). */
export function dealFieldExpr(props: PropertyDef[]): FieldExpr {
  return (field) => {
    if (DEAL_FIELDS[field]) return DEAL_FIELDS[field];
    if (field.startsWith('props.')) {
      const key = field.slice(6);
      const def = props.find((p) => p.key === key);
      if (!def || !KEY_RE.test(key)) return undefined;
      return { sql: `json_extract(rp.props, '$.${key}')`, type: def.type };
    }
    return undefined;
  };
}

/** The FROM clause every deal list query uses (contact and stored properties joined). */
export const DEAL_FROM = `opportunities o JOIN contacts c ON c.id = o.contact_id LEFT JOIN record_props rp ON rp.object_key = 'opportunity' AND rp.record_id = o.id`;

/** Fields a person with hidden fields (record access) may neither filter nor sort by – that would reveal the value. */
export function deniedDealFields(access: { hidden: Record<string, Set<string>> } | null | undefined): string[] {
  if (!access) return [];
  const out: string[] = [];
  for (const k of access.hidden.deals ?? []) if (k === 'value' || k === 'source') out.push(k);
  if (access.hidden.contacts?.has('email')) out.push('contact_email');
  if (access.hidden.contacts?.has('phone')) out.push('contact_phone');
  return out;
}

/** Conditions and ORDER BY from the list's query string (`filters`, `sort`, `owner`, `stage_id`, `tag`). Throws Error on bad input. */
export function dealListSql(app: App, locationId: string, q: URLSearchParams, deny: string[] = []): { where: string[]; params: unknown[]; order: string } {
  const props = dealProps(app, locationId);
  const all = dealFieldExpr(props);
  const expr: FieldExpr = (field) => {
    if (deny.includes(field)) throw new Error(`Das Feld „${field}“ ist für dich ausgeblendet`);
    return all(field);
  };
  const filters = parseFilters(q.get('filters') ?? '');
  const extra: { field: string; op: 'eq' | 'empty' | 'in' | 'contains'; value?: unknown }[] = [];
  const owner = q.get('owner');
  if (owner === 'none') extra.push({ field: 'assigned_to', op: 'empty' });
  else if (owner) extra.push({ field: 'assigned_to', op: 'eq', value: owner });
  const stage = q.get('stage_id');
  if (stage) extra.push({ field: 'stage_id', op: 'in', value: stage });
  const tag = q.get('tag');
  if (tag) extra.push({ field: 'tags', op: 'contains', value: [tag] });
  const { where, params } = filterSql([...filters, ...(extra as typeof filters)], expr);
  const order = sortSql(q.get('sort'), expr, 'o.updated_at DESC');
  return { where, params, order: order === 'o.updated_at DESC' ? order : `${order}, o.updated_at DESC` };
}
