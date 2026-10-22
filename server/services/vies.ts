import type { App } from '../core/app.js';
import { checkVatId } from './invoice-model.js';

/**
 * Looks a VAT ID up at the European Commission's VIES service (qualified confirmation of an EU VAT ID). Only used when the
 * sub-account turned the check on (Einstellungen → Rechnungen). The host is fixed; the ID goes into the path only after
 * the format check. Tests replace the call with `app.services.viesFetch`.
 */

export interface ViesResult {
  /** The service answered. False = not reachable or "try again later" – the invoice is then not blocked. */
  checked: boolean;
  valid?: boolean;
  name?: string;
  address?: string;
  error?: string;
}

const HOST = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const UNAVAILABLE = new Set(['MS_UNAVAILABLE', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'GLOBAL_MAX_CONCURRENT_REQ', 'MS_MAX_CONCURRENT_REQ', 'MS_UNAVAILABLE_ERROR']);

export async function viesCheck(app: App, vatId: string): Promise<ViesResult> {
  const c = checkVatId(vatId);
  if (!c.valid) return { checked: false, error: c.reason };
  const cc = c.normalized.slice(0, 2);
  const num = c.normalized.slice(2);
  const f: typeof fetch = app.services.viesFetch ?? fetch;
  try {
    const r = await f(`${HOST}/${cc}/vat/${encodeURIComponent(num)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const j: any = await r.json().catch(() => ({}));
    const code = String(j?.userError ?? j?.errorWrappers?.[0]?.error ?? '');
    if (!r.ok && !('isValid' in j)) return { checked: false, error: UNAVAILABLE.has(code) ? 'VIES ist gerade nicht erreichbar' : `VIES antwortete mit Status ${r.status}` };
    if (UNAVAILABLE.has(code)) return { checked: false, error: 'VIES ist gerade nicht erreichbar' };
    const clean = (v: unknown) => (typeof v === 'string' && v !== '---' ? v.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined);
    return { checked: true, valid: j?.isValid === true, name: clean(j?.name), address: clean(j?.address) };
  } catch (e) {
    return { checked: false, error: `VIES nicht erreichbar: ${(e as Error).message}` };
  }
}
