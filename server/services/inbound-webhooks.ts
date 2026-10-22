import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound webhooks ("Webhook empfangen" workflow trigger): read fields out of any JSON with
 * dot paths, map them onto contact fields / custom fields / tags, verify an optional HMAC
 * signature and limit requests per URL. Pure helpers – the module does the I/O.
 */

export const CONTACT_TARGETS = ['first_name', 'last_name', 'name', 'email', 'phone', 'company', 'address', 'city', 'postal_code', 'country', 'website', 'source', 'date_of_birth', 'tags', 'dnd'] as const;

export interface FieldMap {
  /** Dot path into the payload, e.g. data.customer.email or items.0.name */
  from: string;
  /** Contact field, `tags`, `dnd` or `custom.<key>` */
  to: string;
}

/** Reads `a.b.0.c` or `a.b[0].c` from an object. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Leaf paths of a payload with an example value (for the mapping dropdowns). */
export function flattenPaths(obj: unknown, prefix = '', depth = 0, out: { path: string; sample: string }[] = []): { path: string; sample: string }[] {
  if (out.length >= 200 || depth > 6) return out;
  if (Array.isArray(obj)) {
    if (prefix && obj.every((x) => x === null || typeof x !== 'object')) out.push({ path: prefix, sample: obj.slice(0, 5).join(', ').slice(0, 80) });
    obj.slice(0, 3).forEach((v, i) => {
      if (v && typeof v === 'object') flattenPaths(v, prefix ? `${prefix}.${i}` : String(i), depth + 1, out);
    });
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') flattenPaths(v, p, depth + 1, out);
      else out.push({ path: p, sample: v === null || v === undefined ? '' : String(v).slice(0, 80) });
      if (out.length >= 200) break;
    }
  }
  return out;
}

export function cleanMapping(input: unknown, customKeys: string[]): FieldMap[] {
  if (!Array.isArray(input)) return [];
  const out: FieldMap[] = [];
  for (const m of input.slice(0, 100)) {
    const from = String(m?.from ?? '').trim().slice(0, 200);
    const to = String(m?.to ?? '').trim();
    if (!from || !to) continue;
    const ok = (CONTACT_TARGETS as readonly string[]).includes(to) || (to.startsWith('custom.') && customKeys.includes(to.slice(7)));
    if (!ok) throw new Error(`Unbekanntes Zielfeld: ${to}`);
    out.push({ from, to });
  }
  return out;
}

const asText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();

/**
 * Builds the contact input for upsertContact. Without a mapping the payload is read like the
 * classic webhook: `{contact: {...}}` or top-level `email`, `phone`, `first_name` … and `tags`.
 */
export function applyMapping(payload: any, mapping: FieldMap[], extraTags: string[] = []): { input: Record<string, any>; tags: string[] } {
  const tags = new Set(extraTags.map((t) => t.trim()).filter(Boolean));
  if (!mapping.length) {
    const src = payload?.contact && typeof payload.contact === 'object' ? payload.contact : (payload ?? {});
    const input: Record<string, any> = {};
    for (const k of CONTACT_TARGETS) {
      if (k === 'tags' || k === 'dnd') continue;
      if (src[k] !== undefined && src[k] !== null && src[k] !== '') input[k] = asText(src[k]);
    }
    if (src.firstName && !input.first_name) input.first_name = asText(src.firstName);
    if (src.lastName && !input.last_name) input.last_name = asText(src.lastName);
    if (src.custom && typeof src.custom === 'object') input.custom = src.custom;
    for (const t of Array.isArray(payload?.tags) ? payload.tags : Array.isArray(src.tags) ? src.tags : []) tags.add(String(t).trim());
    return { input, tags: [...tags].filter(Boolean) };
  }
  const input: Record<string, any> = {};
  const custom: Record<string, any> = {};
  for (const m of mapping) {
    const v = getPath(payload, m.from);
    if (v === undefined || v === null || v === '') continue;
    if (m.to === 'tags') {
      const list = Array.isArray(v) ? v : String(v).split(',');
      for (const t of list) if (String(t).trim()) tags.add(String(t).trim());
    } else if (m.to === 'dnd') input.dnd = v === true || ['1', 'true', 'ja', 'yes'].includes(String(v).toLowerCase());
    else if (m.to.startsWith('custom.')) custom[m.to.slice(7)] = Array.isArray(v) ? v.join(', ') : asText(v);
    else input[m.to] = asText(v);
  }
  if (Object.keys(custom).length) input.custom = custom;
  return { input, tags: [...tags] };
}

export const hasIdentity = (input: Record<string, any>) => !!(input.email || input.phone || input.first_name || input.last_name || input.name);

/** HMAC-SHA256 over the raw body; header as `sha256=<hex>`, plain hex or base64. */
export function verifyHmac(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const given = header.trim().replace(/^sha256=/i, '');
  const mac = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const candidates = [Buffer.from(mac.toString('hex')), Buffer.from(mac.toString('base64'))];
  const g = Buffer.from(given);
  return candidates.some((c) => c.length === g.length && timingSafeEqual(c, g));
}

export const SIGNATURE_HEADERS = ['x-pghl-hmac', 'x-signature-256', 'x-hub-signature-256', 'x-signature'];

/** Fixed one-minute windows per key. */
export class RateLimiter {
  private hits = new Map<string, { n: number; start: number }>();
  allow(key: string, max: number, at = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || at - h.start >= 60_000) {
      this.hits.set(key, { n: 1, start: at });
      if (this.hits.size > 20_000) this.hits.clear();
      return true;
    }
    h.n++;
    return h.n <= max;
  }
}
