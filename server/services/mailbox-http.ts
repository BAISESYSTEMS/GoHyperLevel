import { MailError, outcomeUnknown } from './mailbox-kit.js';

/**
 * One request to Gmail or Graph with the user's access token: JSON in and out, a timeout, a single
 * retry with a fresh token on 401, and provider errors turned into a MailError (German message, status,
 * Retry-After). Both clients use it; tests plug a fake in through `fetcher`.
 */

export type TokenFn = (force?: boolean) => Promise<string>;
export type Json = Record<string, any>;

export interface HttpInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Body is raw bytes (upload), not JSON. */
  raw?: Buffer;
  /** Statuses that are answers, not errors (e.g. 404 while looking something up). */
  allow?: number[];
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  json: Json;
  headers: Headers;
}

export async function mailRequest(label: string, fetcher: typeof fetch, token: TokenFn, url: string, init: HttpInit = {}): Promise<HttpResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(attempt > 0);
    let r: Response;
    try {
      r = await fetcher(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${t}`,
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        body: init.raw ? new Uint8Array(init.raw) : init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (e) {
      const err = new MailError(`${label} nicht erreichbar: ${(e as Error).message}`, 0);
      // a write that got no answer may have been carried out (the caller must not just repeat a send)
      err.unknownOutcome = (init.method ?? 'GET') !== 'GET' && outcomeUnknown(e);
      throw err;
    }
    if (r.status === 401 && attempt === 0) continue;
    const json: Json = r.status === 204 || r.status === 202 ? {} : await r.json().catch(() => ({}));
    if (r.ok || init.allow?.includes(r.status)) return { status: r.status, json, headers: r.headers };
    const msg = String(json?.error?.message ?? json?.error_description ?? (typeof json?.error === 'string' ? json.error : '') ?? '').slice(0, 300) || `Fehler ${r.status}`;
    throw new MailError(`${label}: ${msg}`, r.status, Number(r.headers.get('retry-after')) || 0);
  }
  throw new MailError(`${label}: Anmeldung abgelehnt`, 401);
}
