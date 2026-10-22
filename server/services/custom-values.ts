import { escapeHtml } from '../core/template.js';

/**
 * Custom Values (pure): the rules for keys, the placeholder syntax `{{custom_values.key}}` (optionally with a fallback
 * `{{custom_values.key|Standard}}`), finding the sub-account in template data and filling placeholders into a finished HTML page.
 * The module (modules/custom-values.ts) stores the values; the central renderer (core/template.ts) asks it through a namespace.
 */

export const NAMESPACE = 'custom_values';
export const KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;
export const LIMITS = { name: 120, value: 5000, folder: 60, description: 300, perLocation: 500 } as const;
/** `{{custom_values.key}}` or `{{ custom_values.key | fallback }}` – the same shape render() reads. */
export const PLACEHOLDER_RE = /\{\{\s*custom_values\.([a-z][a-z0-9_]{0,59})\s*(?:\|([^}]*))?\}\}/g;

const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };

/** A key from a name: „Telefon Hotline“ → telefon_hotline (letters, digits, underscore; starts with a letter). */
export function keyFromName(name: string): string {
  const k = String(name ?? '')
    .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUT[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'v_$1')
    .slice(0, 60);
  return k;
}

/** The key as stored (lower case) or null when it does not fit the rules. */
export function cleanKey(v: unknown): string | null {
  const k = String(v ?? '').trim().toLowerCase();
  return KEY_RE.test(k) ? k : null;
}

export const placeholderOf = (key: string) => `{{custom_values.${key}}}`;

/**
 * The sub-account a piece of template data belongs to: `location.id` (the row of app.location), `location_id`, the contact's,
 * the record's (`invoice.location_id` …) – the first one found. Empty when the data says nothing about it.
 */
export function locationOfData(data: Record<string, any> | null | undefined): string {
  if (!data || typeof data !== 'object') return '';
  const s = (v: unknown) => (typeof v === 'string' && v.length >= 4 && v.length <= 64 ? v : '');
  const direct = s(data.location?.id) || s(data.location_id) || s(data.contact?.location_id);
  if (direct) return direct;
  for (const v of Object.values(data)) if (v && typeof v === 'object' && !Array.isArray(v) && s((v as any).location_id)) return (v as any).location_id;
  return '';
}

/** Keys a piece of content refers to (blocks, settings, texts – anything JSON). */
export function referencedKeys(content: unknown): string[] {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const out = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
  return [...out];
}

/**
 * Fills the placeholders of a finished HTML page: the value escaped; an unknown or empty key takes its fallback (already escaped
 * page text, so it is kept as it is) or disappears.
 */
export function fillHtml(html: string, valueOf: (key: string) => string | undefined): string {
  if (!html.includes('custom_values.')) return html;
  return html.replace(PLACEHOLDER_RE, (_m, key: string, fallback: string | undefined) => {
    const v = valueOf(key);
    return v === undefined || v === '' ? (fallback ?? '').trim() : escapeHtml(v);
  });
}
