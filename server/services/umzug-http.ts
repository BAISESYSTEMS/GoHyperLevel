import { safeFetch } from './net.js';

/**
 * HTTP for the switch-over importers: one small client per vendor account with a pause between calls,
 * Retry-After / exponential backoff on 429 and 5xx, readable German errors and a test hook (the module
 * passes app.services.umzugFetch, so tests never touch the network). Vendor hosts are fixed or validated
 * (see the sources), the real fetch goes through safeFetch (no private targets, size and time limits).
 */

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}
export interface HttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export type FetchFn = (url: string, init?: HttpInit) => Promise<HttpResult>;

/** The real network: safeFetch with room for big pages (an ActiveCampaign page with sideloads is a few MB). */
export const networkFetch: FetchFn = async (url, init = {}) => {
  const r = await safeFetch(url, { method: init.method, headers: init.headers, body: init.body, timeoutMs: init.timeoutMs ?? 30_000, maxBytes: 40 * 1024 * 1024, secretHeaders: ['x-api-token', 'api-token', 'x-kit-api-key', 'x-keap-api-key', 'apikey', 'x-api-key', 'api-key', ...Object.keys(init.headers ?? {}).filter((h) => !/^(accept|content-type|revision|zoho-.*|x-.*-version)$/i.test(h))] });
  let cache: string | undefined;
  const text = async () => (cache ??= await r.text());
  return {
    status: r.status,
    ok: r.ok,
    headers: { get: (n: string) => (r.headers[n.toLowerCase()] === undefined ? null : String(Array.isArray(r.headers[n.toLowerCase()]) ? (r.headers[n.toLowerCase()] as string[])[0] : r.headers[n.toLowerCase()])) },
    json: async () => JSON.parse(await text()),
    text,
  };
};

export class UmzugError extends Error {
  constructor(
    public status: number,
    message: string,
    public path = '',
  ) {
    super(message);
  }
  /** Wrong or expired credentials: nothing else will work either, so the job stops here. */
  get fatal() {
    return this.status === 401 || this.status === 0;
  }
  /** Missing right or product not available in this plan: the step is skipped with a note. */
  get skippable() {
    return this.status === 403 || this.status === 404 || this.status === 402 || this.status === 405;
  }
}

export interface VendorHttpOptions {
  /** Vendor name for messages ("Mailchimp"). */
  vendor: string;
  base: string;
  headers: () => Record<string, string>;
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  /** Pause after each successful call. */
  pauseMs?: number;
  maxRetries?: number;
  /** Reads the vendor's own error text from a failed response body. */
  errorText?: (body: any) => string | undefined;
  /** Runs before every call (token exchange, refresh). */
  prepare?: () => Promise<void>;
  /** Response headers that say how many seconds to wait after a 429, in the order they are tried (default: Retry-After only). */
  retryHeaders?: string[];
  /** Wait before the first retry when the vendor names no time (default 1 s, then doubled; Airtable asks for 30 s). */
  retryBaseMs?: number;
  /** A successful (HTTP 200) answer that really is a rate-limit notice (GraphQL APIs): returns the seconds to wait, otherwise undefined. */
  softLimit?: (body: any) => number | undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class VendorHttp {
  calls = 0;
  /** Waits we did because of rate limits (tests read them). */
  readonly waits: number[] = [];
  constructor(private o: VendorHttpOptions) {}

  url(path: string, query: Record<string, unknown> = {}): string {
    const u = new URL(/^https?:\/\//.test(path) ? path : this.o.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    return u.toString();
  }

  async req(method: string, path: string, init: { query?: Record<string, unknown>; body?: unknown; form?: Record<string, string> } = {}): Promise<any> {
    await this.o.prepare?.();
    const url = this.url(path, init.query);
    const f = this.o.fetch ?? networkFetch;
    const sleep = this.o.sleep ?? realSleep;
    const max = this.o.maxRetries ?? 6;
    const where = path.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    const body = init.body !== undefined ? JSON.stringify(init.body) : init.form ? new URLSearchParams(init.form).toString() : undefined;
    const type: Record<string, string> = init.body !== undefined ? { 'content-type': 'application/json' } : init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {};
    for (let attempt = 0; ; attempt++) {
      this.calls++;
      let r: HttpResult;
      try {
        r = await f(url, { method, headers: { accept: 'application/json', ...this.o.headers(), ...type }, body });
      } catch (e) {
        if (attempt >= max) throw new UmzugError(0, `${this.o.vendor} nicht erreichbar: ${(e as Error).message}`, where);
        const wait = Math.min(1000 * 2 ** attempt, 30_000);
        this.waits.push(wait);
        await sleep(wait);
        continue;
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= max) throw new UmzugError(r.status, r.status === 429 ? `${this.o.vendor}-Limit erreicht – bitte später fortsetzen` : `${this.o.vendor} antwortet mit Fehler ${r.status}`, where);
        const ra = this.retryAfter(r);
        const wait = ra !== undefined ? Math.min(ra * 1000, 60_000) : Math.min((this.o.retryBaseMs ?? 1000) * 2 ** attempt, Math.max(30_000, (this.o.retryBaseMs ?? 0) * 4));
        this.waits.push(wait);
        await sleep(wait);
        continue;
      }
      let j: any = {};
      try {
        const t = await r.text();
        j = t ? JSON.parse(t) : {};
      } catch {
        j = {};
      }
      if (!r.ok) {
        const own = this.o.errorText?.(j) ?? (typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : typeof j?.detail === 'string' ? j.detail : undefined);
        const msg =
          r.status === 401
            ? `${this.o.vendor}: Zugangsdaten ungültig oder abgelaufen`
            : r.status === 403
              ? `${this.o.vendor}: fehlende Berechtigung für ${where}${own ? ` (${String(own).slice(0, 120)})` : ''}`
              : r.status === 404
                ? `Bei ${this.o.vendor} nicht vorhanden: ${where}`
                : `${this.o.vendor}: ${String(own ?? `HTTP ${r.status}`).slice(0, 200)}`;
        throw new UmzugError(r.status, msg, where);
      }
      const soft = r.ok ? this.o.softLimit?.(j) : undefined;
      if (soft !== undefined) {
        if (attempt >= max) throw new UmzugError(429, `${this.o.vendor}-Limit erreicht – bitte später fortsetzen`, where);
        const wait = Math.min(Math.max(soft, 1) * 1000, 60_000);
        this.waits.push(wait);
        await sleep(wait);
        continue;
      }
      if (this.o.pauseMs) await sleep(this.o.pauseMs);
      return j;
    }
  }

  /** Seconds the vendor asks us to wait (first usable header), if any. */
  private retryAfter(r: HttpResult): number | undefined {
    for (const name of this.o.retryHeaders ?? ['retry-after']) {
      const v = Number(r.headers.get(name));
      if (!Number.isFinite(v) || v <= 0) continue;
      // A Unix timestamp (X-RateLimit-Reset) instead of a number of seconds.
      return v > 1_000_000_000 ? Math.max(1, Math.ceil(v - Date.now() / 1000)) : v;
    }
    return undefined;
  }

  get(path: string, query?: Record<string, unknown>) {
    return this.req('GET', path, { query });
  }
}
