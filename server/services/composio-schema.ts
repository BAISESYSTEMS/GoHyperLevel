import { render } from '../core/template.js';

/**
 * Arguments for app actions (Composio tools): the action's JSON schema drives the form in the
 * workflow editor, values may hold merge fields ({{contact.email}}), and right before the call they
 * are rendered and coerced to the schema's types. Small subset of JSON Schema – what tool inputs use.
 */

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  default?: unknown;
  examples?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  [k: string]: unknown;
}

/** Replaces merge fields in every string of a (nested) value. */
export function renderArgs(value: unknown, vars: Record<string, unknown>, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return value.includes('{{') ? render(value, vars) : value;
  if (Array.isArray(value)) return value.map((v) => renderArgs(v, vars, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderArgs(v, vars, depth + 1)]));
  return value;
}

/** The first concrete type of a schema (handles ["string","null"] and anyOf/oneOf). */
export function typeOf(s: JsonSchema | undefined): string {
  if (!s) return 'string';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t) return t;
  const alt = (s.anyOf ?? s.oneOf ?? []).find((x) => typeOf(x) !== 'null' && (x.type || x.properties || x.items));
  if (alt) return typeOf(alt);
  if (s.properties) return 'object';
  if (s.items) return 'array';
  return 'string';
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function coerce(v: unknown, s: JsonSchema, path: string, errors: string[], depth: number): unknown {
  const t = typeOf(s);
  let out: unknown = v;
  switch (t) {
    case 'integer':
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
      if (!Number.isFinite(n)) {
        errors.push(`${path}: Zahl erwartet`);
        return undefined;
      }
      if (t === 'integer' && !Number.isInteger(n)) {
        errors.push(`${path}: ganze Zahl erwartet`);
        return undefined;
      }
      out = n;
      break;
    }
    case 'boolean': {
      if (typeof v === 'boolean') out = v;
      else {
        const s2 = String(v).trim().toLowerCase();
        if (['true', '1', 'ja', 'yes', 'on'].includes(s2)) out = true;
        else if (['false', '0', 'nein', 'no', 'off'].includes(s2)) out = false;
        else {
          errors.push(`${path}: ja/nein erwartet`);
          return undefined;
        }
      }
      break;
    }
    case 'array': {
      let list: unknown[];
      if (Array.isArray(v)) list = v;
      else {
        const str = String(v).trim();
        if (str.startsWith('[')) {
          try {
            const parsed = JSON.parse(str);
            list = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            errors.push(`${path}: Liste als JSON ungültig`);
            return undefined;
          }
        } else list = str.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
      }
      out = s.items && depth < 6 ? list.map((x, i) => coerce(x, s.items!, `${path}[${i}]`, errors, depth + 1)) : list;
      break;
    }
    case 'object': {
      let o: unknown = v;
      if (typeof v === 'string') {
        try {
          o = JSON.parse(v);
        } catch {
          errors.push(`${path}: Objekt als JSON erwartet`);
          return undefined;
        }
      }
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        errors.push(`${path}: Objekt erwartet`);
        return undefined;
      }
      out = s.properties && depth < 6 ? coerceObject(s, o as Record<string, unknown>, errors, `${path}.`, depth + 1) : o;
      break;
    }
    default:
      out = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (Array.isArray(s.enum) && s.enum.length && !s.enum.some((e) => e === out || String(e) === String(out))) {
    errors.push(`${path}: erlaubt sind ${s.enum.slice(0, 12).map(String).join(', ')}`);
    return undefined;
  }
  return out;
}

function coerceObject(schema: JsonSchema, input: Record<string, unknown>, errors: string[], prefix: string, depth: number): Record<string, unknown> {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(props)) {
    const v = input[k];
    if (empty(v)) {
      if (required.has(k)) errors.push(`${prefix}${k}: Pflichtfeld fehlt`);
      continue;
    }
    const c = coerce(v, s, `${prefix}${k}`, errors, depth);
    if (c !== undefined) out[k] = c;
  }
  // Keys the schema does not name are passed on unless it forbids them.
  if (schema.additionalProperties !== false) for (const [k, v] of Object.entries(input)) if (!(k in props) && !empty(v)) out[k] = v;
  return out;
}

/** Rendered arguments → typed arguments for the call, plus German errors (required, types, enums). */
export function coerceArgs(schema: JsonSchema | undefined, input: unknown): { args: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const s = schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
  return { args: coerceObject(s, src, errors, '', 0), errors };
}

/** A compact description of an action's inputs for the AI (name, type, required, short text). */
export function schemaSummary(schema: JsonSchema | undefined, max = 25): string {
  const props = Object.entries(schema?.properties ?? {}).slice(0, max);
  if (!props.length) return '(keine Eingaben)';
  const req = new Set(schema?.required ?? []);
  return props
    .map(([k, s]) => {
      const en = Array.isArray(s.enum) && s.enum.length ? ` [${s.enum.slice(0, 8).map(String).join('|')}]` : '';
      const d = String(s.description ?? s.title ?? '').replace(/\s+/g, ' ').slice(0, 140);
      return `- ${k} (${typeOf(s)}${req.has(k) ? ', Pflicht' : ''})${en}${d ? `: ${d}` : ''}`;
    })
    .join('\n');
}

/** Dot paths of a payload schema (for the field mapping of app events), e.g. customer.email. */
export function schemaPaths(schema: JsonSchema | undefined, prefix = '', depth = 0, out: { path: string; type: string; description: string }[] = []): { path: string; type: string; description: string }[] {
  if (!schema || depth > 4 || out.length >= 150) return out;
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    const t = typeOf(s);
    if (t === 'object' && s.properties) schemaPaths(s, path, depth + 1, out);
    else if (t === 'array' && s.items?.properties) schemaPaths(s.items, `${path}.0`, depth + 1, out);
    else out.push({ path, type: t, description: String(s.description ?? s.title ?? '').replace(/\s+/g, ' ').slice(0, 120) });
    if (out.length >= 150) break;
  }
  return out;
}
