import { HttpError } from '../core/http.js';

/** Minimal client for the Postiz public API (self-hosted: https://<domain>/api/public/v1). */

export interface PostizConfig {
  url: string;
  api_key: string;
}

let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
/** Tests swap in a fake Postiz. */
export function setPostizFetch(f: typeof fetch) {
  fetchImpl = f;
}

export function postizBase(url: string) {
  return url.trim().replace(/\/+$/, '').replace(/\/api\/public\/v1$/, '');
}

export async function postiz<T = any>(cfg: PostizConfig, method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetchImpl(`${postizBase(cfg.url)}/api/public/v1${path}`, {
      method,
      headers: { authorization: cfg.api_key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    throw new HttpError(502, `Postiz nicht erreichbar: ${(e as Error).message}`);
  }
  const raw = await r.text();
  let data: any = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* plain text */
  }
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) throw new HttpError(502, 'Postiz: API-Schlüssel ungültig');
    if (r.status === 429) throw new HttpError(429, 'Postiz: zu viele Anfragen – bitte in ein paar Minuten nochmal');
    const msg = typeof data === 'object' && data ? (Array.isArray(data.message) ? data.message.join(', ') : data.message || data.error) : String(raw).slice(0, 200);
    throw new HttpError(502, `Postiz (${r.status}): ${msg || 'Fehler'}`);
  }
  return data as T;
}
