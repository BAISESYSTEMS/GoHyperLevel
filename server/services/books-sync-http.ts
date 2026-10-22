import { randomBytes } from 'node:crypto';
import type { SafeResponse } from './net.js';
import { INTERVAL_MS, PROVIDER_LABEL, RateLimiter, type Provider } from './books-sync-model.js';

/**
 * HTTP for the Lexware Office / sevDesk live sync: fixed hosts, the key of the sub-account, a rate limiter per key,
 * retries with backoff on 429 / 5xx / lost connections (Retry-After is honoured), German errors. The network is
 * `safeFetch` unless a test puts a fake into app.services.booksSyncFetch.
 */

export const LEX_API = 'https://api.lexware.io/v1';
export const SEV_API = 'https://my.sevdesk.de/api/v1';

export type BooksFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number; secretHeaders?: string[] }) => Promise<SafeResponse>;

export interface BooksDeps {
  fetch: BooksFetch;
  sleep: (ms: number) => Promise<void>;
  limiter: RateLimiter;
}

export class BooksApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  /** Wrong key or missing right: retrying will not help until somebody fixes the connection. */
  get fatal() {
    return this.status === 401 || this.status === 403;
  }
}

const RETRIES = 3;
const header = (r: SafeResponse, name: string) => {
  const v = r.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

interface CallInit {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  body?: Buffer;
  contentType?: string;
}

/** One API account (provider + key): every call waits for its slot, retries on 429/5xx, throws BooksApiError. */
export class BooksClient {
  readonly vendor: string;
  constructor(
    private deps: BooksDeps,
    readonly provider: Provider,
    private apiKey: string,
  ) {
    this.vendor = PROVIDER_LABEL[provider];
  }

  private get base() {
    return this.provider === 'lexware' ? LEX_API : SEV_API;
  }

  async call(method: string, path: string, init: CallInit = {}): Promise<any> {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    const auth = this.provider === 'lexware' ? `Bearer ${this.apiKey}` : this.apiKey;
    const headers: Record<string, string> = { accept: 'application/json', authorization: auth };
    let body: string | Buffer | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers['content-type'] = init.contentType ?? 'application/octet-stream';
      body = init.body;
    }
    const where = path.split('?')[0];
    for (let attempt = 0; ; attempt++) {
      await this.deps.limiter.wait(`${this.provider}:${this.apiKey.slice(-12)}`, INTERVAL_MS[this.provider]);
      let r: SafeResponse;
      try {
        r = await this.deps.fetch(u.toString(), { method, headers, body, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
      } catch (e) {
        if (attempt >= RETRIES) throw new BooksApiError(0, `${this.vendor} nicht erreichbar: ${(e as Error).message}`);
        await this.deps.sleep(Math.min(1000 * 2 ** attempt, 10_000));
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= RETRIES) throw new BooksApiError(r.status, r.status === 429 ? `${this.vendor}: zu viele Anfragen – später erneut` : `${this.vendor} antwortet mit Fehler ${r.status}`);
        const ra = Number(header(r, 'retry-after'));
        await this.deps.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : Math.min(1000 * 2 ** attempt, 10_000));
        continue;
      }
      const raw = await r.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = null;
      }
      if (r.ok) return data;
      const own = String(data?.message ?? data?.error?.message ?? (Array.isArray(data?.IssueList) ? data.IssueList.map((i: any) => [i?.i18nKey, i?.source].filter(Boolean).join(' ')).join(', ') : '') ?? '').slice(0, 200);
      const msg =
        r.status === 401
          ? `${this.vendor}: API-Schlüssel ungültig oder abgelaufen`
          : r.status === 403
            ? `${this.vendor}: keine Berechtigung für ${where}${own ? ` (${own})` : ''}`
            : r.status === 404
              ? `${this.vendor}: nicht gefunden (${where})`
              : `${this.vendor}: ${own || `HTTP ${r.status}`}`;
      throw new BooksApiError(r.status, msg);
    }
  }
}

/** multipart/form-data with one file (and optional text fields) – Buffer body for safeFetch. */
export function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----gohigh${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  const safeName = file.name.replace(/["\r\n]/g, '_');
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// --- Lexware Office ---------------------------------------------------------------------------------------------------------

const first = (j: any): any => (Array.isArray(j?.content) ? j.content[0] : undefined);

export const lexApi = (c: BooksClient) => ({
  profile: () => c.call('GET', '/profile'),
  contactByNumber: async (n: string) => first(await c.call('GET', '/contacts', { query: { number: n, customer: 'true' } }))?.id as string | undefined,
  contactByEmail: async (e: string) => first(await c.call('GET', '/contacts', { query: { email: e, customer: 'true' } }))?.id as string | undefined,
  createContact: async (body: unknown) => String((await c.call('POST', '/contacts', { json: body }))?.id ?? ''),
  /** A voucher with exactly this number (the API filters, we compare again). */
  voucherByNumber: async (n: string) => {
    const j = await c.call('GET', '/vouchers', { query: { voucherNumber: n } });
    const list: any[] = Array.isArray(j?.content) ? j.content : Array.isArray(j) ? j : [];
    return list.find((v) => String(v?.voucherNumber ?? '') === n)?.id as string | undefined;
  },
  createVoucher: async (body: unknown) => String((await c.call('POST', '/vouchers', { json: body }))?.id ?? ''),
  attachFile: (voucherId: string, file: { name: string; data: Buffer }) => {
    const m = multipart({ type: 'voucher' }, { name: file.name, type: 'application/pdf', data: file.data });
    return c.call('POST', `/vouchers/${encodeURIComponent(voucherId)}/files`, { body: m.body, contentType: m.contentType });
  },
  payments: (voucherId: string) => c.call('GET', `/payments/${encodeURIComponent(voucherId)}`),
});

// --- sevDesk ---------------------------------------------------------------------------------------------------------------------

const objects = (j: any): any[] => (Array.isArray(j?.objects) ? j.objects : j?.objects ? [j.objects] : []);

export const sevApi = (c: BooksClient) => ({
  users: async () => objects(await c.call('GET', '/SevUser')),
  contactByNumber: async (n: string) => objects(await c.call('GET', '/Contact', { query: { customerNumber: n, depth: 1 } })).find((x) => String(x?.customerNumber ?? '') === n)?.id as string | undefined,
  /** Communication ways of type e-mail with this value; compared again here so a filter the API ignores can never mismatch. */
  contactByEmail: async (e: string) => {
    const list = objects(await c.call('GET', '/CommunicationWay', { query: { type: 'EMAIL', value: e, limit: 100 } }));
    const hit = list.find((w) => String(w?.type ?? '').toUpperCase() === 'EMAIL' && String(w?.value ?? '').trim().toLowerCase() === e.toLowerCase());
    return hit?.contact?.id ? String(hit.contact.id) : undefined;
  },
  createContact: async (body: unknown, email?: string) => {
    const created = objects(await c.call('POST', '/Contact', { json: body }))[0];
    const cid = String(created?.id ?? '');
    if (cid && email) await c.call('POST', '/CommunicationWay', { json: { contact: { id: Number(cid) || cid, objectName: 'Contact' }, type: 'EMAIL', value: email, key: { id: 2, objectName: 'CommunicationWayKey' }, main: true } });
    return cid;
  },
  invoiceByNumber: async (n: string) => objects(await c.call('GET', '/Invoice', { query: { invoiceNumber: n } })).find((x) => String(x?.invoiceNumber ?? '') === n)?.id as string | undefined,
  creditNoteByNumber: async (n: string) => objects(await c.call('GET', '/CreditNote', { query: { creditNoteNumber: n } })).find((x) => String(x?.creditNoteNumber ?? '') === n)?.id as string | undefined,
  saveInvoice: async (body: unknown) => {
    const j = await c.call('POST', '/Invoice/Factory/saveInvoice', { json: body });
    return String(j?.objects?.invoice?.id ?? objects(j)[0]?.invoice?.id ?? '');
  },
  saveCreditNote: async (body: unknown) => {
    const j = await c.call('POST', '/CreditNote/Factory/saveCreditNote', { json: body });
    return String(j?.objects?.creditNote?.id ?? objects(j)[0]?.creditNote?.id ?? '');
  },
  markSent: (id: string) => c.call('PUT', `/Invoice/${encodeURIComponent(id)}/sendBy`, { json: { sendType: 'VPDF', sendDraft: false } }),
  cancelInvoice: async (id: string) => String(objects(await c.call('POST', `/Invoice/${encodeURIComponent(id)}/cancelInvoice`))[0]?.id ?? ''),
  invoice: async (id: string) => objects(await c.call('GET', `/Invoice/${encodeURIComponent(id)}`))[0],
});
