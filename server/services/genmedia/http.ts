import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { App } from '../../core/app.js';
import { isPrivateIp } from '../net.js';
import { ProviderError, type AiConnection, type GmRequest, type GmResponse } from './types.js';

/**
 * Outbound HTTP of the media generation: provider APIs (the base URL comes from the user's
 * connection, so it is treated like any user-supplied URL) and result downloads. Every request
 * refuses private, loopback and metadata addresses – literal IPs up front, host names on the
 * resolved address – and re-checks each redirect (auth headers are dropped when the host changes).
 * `PGHL_ALLOW_PRIVATE_FETCH=1` lifts the block for self-hosted setups (e.g. a local ComfyUI).
 * Tests replace the network with `app.services.genmediaFetch(url, init) → Response`; the URL
 * checks still run first.
 */

const allowPrivate = () => process.env.PGHL_ALLOW_PRIVATE_FETCH === '1';
const BLOCKED_NAMES = /^(localhost|metadata|metadata\.google\.internal|instance-data)$|\.(localhost|local|internal|lan|home|corp|intranet)$/i;

/** Throws when a URL may not be fetched (scheme, private/loopback IP literal, internal host name). */
export function checkUrl(raw: string, allow = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ProviderError('Ungültige Adresse');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ProviderError('Nur http(s)-Adressen');
  if (u.username || u.password) throw new ProviderError('Adressen mit Zugangsdaten sind nicht erlaubt');
  if (allow || allowPrivate()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) ? isPrivateIp(host) : BLOCKED_NAMES.test(host) || !host.includes('.')) throw new ProviderError('Ziel liegt in einem internen Netz und ist gesperrt');
  return u;
}

function guardedLookup(hostname: string, options: any, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void, allow = false) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = (addresses as unknown as LookupAddress[]) ?? [];
    if (!allow && !allowPrivate() && list.some((a) => isPrivateIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error('Ziel liegt in einem internen Netz und ist gesperrt');
      e.code = 'EPRIVATE';
      return cb(e, '');
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0]?.address ?? '', list[0]?.family);
  });
}

function response(status: number, headers: Record<string, string>, body: Buffer): GmResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    body,
    text: () => body.toString('utf8'),
    json: () => {
      try {
        return JSON.parse(body.toString('utf8'));
      } catch {
        return null;
      }
    },
  };
}

function lowerHeaders(h: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

const AUTH_HEADERS = ['authorization', 'x-goog-api-key', 'xi-api-key', 'x-api-key', 'api-key'];

async function nodeRequest(u: URL, init: GmRequest, redirects: number): Promise<GmResponse> {
  const maxBytes = init.maxBytes ?? 20 * 1024 * 1024;
  const body = typeof init.body === 'string' ? Buffer.from(init.body) : init.body;
  const res = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: init.method ?? 'GET',
        headers: { 'user-agent': 'HyperLevel-KI-Studio/1.0', ...(body ? { 'content-length': String(body.length) } : {}), ...(init.headers ?? {}) },
        lookup: ((h: string, o: any, cb: any) => guardedLookup(h, o, cb, !!init.allowPrivate)) as any,
        timeout: init.timeoutMs ?? 60_000,
      },
      (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) return void req.destroy(new ProviderError(`Antwort größer als ${Math.round(maxBytes / 1024 / 1024)} MB`));
          chunks.push(c);
        });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: lowerHeaders(r.headers), body: Buffer.concat(chunks) }));
        r.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new ProviderError('Zeitüberschreitung beim Anbieter', true)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
  if (res.status >= 300 && res.status < 400 && res.headers.location && redirects > 0) {
    const next = checkUrl(new URL(res.headers.location, u).toString(), !!init.allowPrivate);
    const sameHost = next.host === u.host;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([k]) => sameHost || !AUTH_HEADERS.includes(k.toLowerCase())));
    const keep = res.status === 307 || res.status === 308;
    return nodeRequest(next, { ...init, headers, method: keep ? init.method : 'GET', body: keep ? init.body : undefined }, redirects - 1);
  }
  return response(res.status, res.headers, res.body);
}

/** One HTTP call of the media module (provider APIs and downloads). */
export async function gmFetch(app: App, url: string, init: GmRequest = {}): Promise<GmResponse> {
  const u = checkUrl(url, !!init.allowPrivate);
  const hook = app.services.genmediaFetch as ((url: string, init: any) => Promise<Response>) | undefined;
  try {
    if (hook) {
      const r = await hook(u.toString(), { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
      const buf = Buffer.from(await r.arrayBuffer());
      if (init.maxBytes && buf.length > init.maxBytes) throw new ProviderError(`Antwort größer als ${Math.round(init.maxBytes / 1024 / 1024)} MB`);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      return response(r.status, headers, buf);
    }
    return await nodeRequest(u, init, 3);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const msg = (e as Error).message || 'Netzwerkfehler';
    throw new ProviderError(/intern/i.test(msg) ? msg : `Anbieter nicht erreichbar: ${msg}`, !/intern/i.test(msg));
  }
}

/** Trailing slash off; empty → the adapter's default. */
export const baseOf = (conn: AiConnection, fallback: string) => String(conn.baseUrl || fallback).trim().replace(/\/+$/, '');

/** Headers (and URL query) that carry the key, from the connection's auth style or the provider default. */
export function authFor(conn: AiConnection, defaultStyle: string): { headers: Record<string, string>; query?: [string, string] } {
  const style = String(conn.authStyle || defaultStyle || 'bearer').trim();
  const key = conn.apiKey ?? '';
  const headers: Record<string, string> = { ...(conn.headers ?? {}) };
  if (!key || style === 'none') return { headers };
  const [kind, name] = style.includes(':') ? [style.slice(0, style.indexOf(':')).toLowerCase(), style.slice(style.indexOf(':') + 1).trim()] : [style.toLowerCase(), ''];
  if (kind === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (kind === 'key') headers.authorization = `Key ${key}`;
  else if (kind === 'basic') headers.authorization = `Basic ${Buffer.from(key.includes(':') ? key : `${key}:`).toString('base64')}`;
  else if (kind === 'token') headers.authorization = `Token ${key}`;
  else if (kind === 'header' && name) headers[name.toLowerCase()] = key;
  else if (kind === 'query' && name) return { headers, query: [name, key] };
  else if (/^x-[\w-]+$|^[\w]+-[\w-]+$/i.test(style)) headers[style.toLowerCase()] = key;
  else headers.authorization = `Bearer ${key}`;
  return { headers };
}

export function withQuery(url: string, q?: [string, string]): string {
  if (!q) return url;
  const u = new URL(url);
  u.searchParams.set(q[0], q[1]);
  return u.toString();
}

/** Readable message from a provider error body. */
export function errorText(r: GmResponse, fallback = 'Fehler beim Anbieter'): string {
  const j = r.json();
  const pick = (v: any): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(pick).filter(Boolean).join('; ');
    return pick(v.message) || pick(v.msg) || pick(v.detail) || pick(v.error) || pick(v.title) || pick(v.errors) || '';
  };
  const msg = (j ? pick(j.error) || pick(j.detail) || pick(j.message) || pick(j.msg) || pick(j.errors) || pick(j.failure) : r.text().slice(0, 200)) || fallback;
  return `${msg}`.replace(/\s+/g, ' ').slice(0, 400);
}

/** Throws a ProviderError for non-2xx answers (429/5xx count as retryable). */
export function ensureOk(r: GmResponse, what: string): GmResponse {
  if (r.ok) return r;
  const msg = errorText(r);
  const hint = r.status === 401 || r.status === 403 ? ' – Schlüssel prüfen' : r.status === 402 ? ' – Guthaben beim Anbieter aufladen' : r.status === 429 ? ' – Limit beim Anbieter erreicht, später erneut' : '';
  throw new ProviderError(`${what}: ${msg} (HTTP ${r.status})${hint}`, r.status === 429 || r.status >= 500, r.status);
}

/** POST/GET JSON helper. */
export async function jsonCall(fetch: (url: string, init?: GmRequest) => Promise<GmResponse>, method: string, url: string, headers: Record<string, string>, body?: unknown, timeoutMs = 60_000, what = 'Anbieter'): Promise<any> {
  const r = await fetch(url, { method, headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, timeoutMs });
  ensureOk(r, what);
  const j = r.json();
  if (j === null && r.body.length) throw new ProviderError(`${what}: Antwort ist kein JSON`);
  return j ?? {};
}

/** multipart/form-data body (Node 22 has FormData, but a Buffer works with both the hook and raw requests). */
export function multipart(fields: Record<string, string | number | boolean | undefined | null | { filename: string; contentType: string; data: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = `----gohigh${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${v.filename.replace(/"/g, '')}"\r\nContent-Type: ${v.contentType}\r\n\r\n`), v.data, Buffer.from('\r\n'));
    } else parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(v)}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Tiny JSON path: `a.b[0].c`, `items[*].url`, `output`, `$.data.url` – returns every match
 * (a list), so templates may point at one URL or many.
 */
export function pathGet(obj: any, path: string): any[] {
  const p = String(path ?? '').trim().replace(/^\$\.?/, '');
  if (!p) return obj === undefined ? [] : [obj];
  const tokens = p.match(/[^.[\]]+|\[(\d+|\*)\]/g) ?? [];
  let cur: any[] = [obj];
  for (const t of tokens) {
    const key = t.startsWith('[') ? t.slice(1, -1) : t;
    const next: any[] = [];
    for (const c of cur) {
      if (c === null || c === undefined) continue;
      if (key === '*') {
        if (Array.isArray(c)) next.push(...c);
        else if (typeof c === 'object') next.push(...Object.values(c));
      } else if (Array.isArray(c) && /^\d+$/.test(key)) next.push(c[Number(key)]);
      else if (typeof c === 'object') next.push(c[key]);
    }
    cur = next.filter((x) => x !== undefined);
  }
  return cur;
}

/** Media URLs inside a value: strings, {url}, lists of either. */
export function urlsIn(v: any): string[] {
  const out: string[] = [];
  const walk = (x: any) => {
    if (!x) return;
    if (typeof x === 'string') {
      if (/^https?:\/\//i.test(x)) out.push(x);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === 'object') {
      if (typeof x.url === 'string') walk(x.url);
      else if (typeof x.uri === 'string') walk(x.uri);
    }
  };
  walk(v);
  return [...new Set(out)];
}

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v|mp3|wav|ogg|oga|flac|m4a|aac|opus)(\?|#|$)/i;
/** Last resort: every http(s) URL with a media file extension anywhere in a JSON answer. */
export function deepMediaUrls(obj: any, max = 12): string[] {
  const out = new Set<string>();
  const walk = (x: any, depth: number) => {
    if (out.size >= max || depth > 8 || x === null || x === undefined) return;
    if (typeof x === 'string') {
      if (/^https?:\/\//i.test(x) && MEDIA_EXT.test(x)) out.add(x);
    } else if (Array.isArray(x)) for (const y of x) walk(y, depth + 1);
    else if (typeof x === 'object') for (const y of Object.values(x)) walk(y, depth + 1);
  };
  walk(obj, 0);
  return [...out];
}

/** Host matches a pattern list (`*.example.com` allowed). */
export function hostIn(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.startsWith('*.') ? h.endsWith(q.slice(1)) || h === q.slice(2) : h === q;
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
