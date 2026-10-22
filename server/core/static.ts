import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzip } from 'node:zlib';
import { MIN_COMPRESS_BYTES, isCompressible, pickEncoding, type Encoding } from './compress.js';

/**
 * The built web app (dist-web): hashed files under /assets/ are cached for a year (`immutable`),
 * index.html and everything else revalidate (`no-cache` + ETag/Last-Modified → 304). Text files are
 * sent brotli/gzip-compressed – from the `.br`/`.gz` files `npm run build` writes next to them, or
 * gzipped once on the fly and kept in memory. GET and HEAD are answered alike.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

export const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Files up to this size are kept in memory (the whole build is a few MB). */
const CACHE_MAX_FILE = 4 * 1024 * 1024;

interface Entry {
  file: string;
  size: number;
  mtimeMs: number;
  etag: string;
  lastModified: string;
  type: string;
  compressible: boolean;
  body?: Buffer;
  /** Precompressed siblings written at build time (path + size). */
  pre: Partial<Record<Encoding, { file: string; size: number; body?: Buffer }>>;
  /** gzip made on the fly when there is no precompressed file. */
  gz?: Promise<Buffer | null>;
}

const entries = new Map<string, Entry>();

function sibling(file: string, ext: string, original: Stats): { file: string; size: number } | undefined {
  const st = statSync(file + ext, { throwIfNoEntry: false });
  // A stale sibling (older than the file, e.g. a manual edit after the build) is ignored.
  if (!st?.isFile() || st.mtimeMs + 1000 < original.mtimeMs) return undefined;
  return { file: file + ext, size: st.size };
}

function entryFor(file: string, st: Stats): Entry {
  const hit = entries.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const compressible = isCompressible(type) && st.size > MIN_COMPRESS_BYTES;
  const e: Entry = {
    file,
    size: st.size,
    mtimeMs: st.mtimeMs,
    // Weak: the same file goes out in three encodings.
    etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
    lastModified: st.mtime.toUTCString(),
    type,
    compressible,
    pre: compressible ? { br: sibling(file, '.br', st), gzip: sibling(file, '.gz', st) } : {},
  };
  if (entries.size > 2000) entries.clear();
  entries.set(file, e);
  return e;
}

async function load(file: string, size: number, holder: { body?: Buffer }): Promise<Buffer | null> {
  if (holder.body) return holder.body;
  if (size > CACHE_MAX_FILE) return null;
  const buf = await readFile(file);
  holder.body = buf;
  return buf;
}

function gzipped(e: Entry): Promise<Buffer | null> {
  e.gz ??= (async () => {
    const body = await load(e.file, e.size, e);
    if (!body) return null;
    const out = await new Promise<Buffer>((ok, fail) => gzip(body, { level: 9 }, (err, b) => (err ? fail(err) : ok(b))));
    return out.length < body.length ? out : null;
  })().catch(() => null);
  return e.gz;
}

function notModified(req: IncomingMessage, e: Entry): boolean {
  const inm = req.headers['if-none-match'];
  if (inm) {
    const want = e.etag.replace(/^W\//, '');
    return inm.split(',').some((t) => {
      const v = t.trim();
      return v === '*' || v.replace(/^W\//, '') === want;
    });
  }
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const t = Date.parse(ims);
    return Number.isFinite(t) && Math.floor(e.mtimeMs / 1000) <= Math.floor(t / 1000);
  }
  return false;
}

export interface StaticOptions {
  root: string;
  path: string;
  /** Extra headers for an HTML response (the admin app's Content-Security-Policy). */
  htmlHeaders: () => Record<string, string>;
}

function plain(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  res.end(message);
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, o: StaticOptions): Promise<void> {
  const head = req.method === 'HEAD';
  const root = resolve(o.root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(o.path);
  } catch {
    return plain(res, 400, 'Ungültige Adresse');
  }
  let file = normalize(join(root, decoded));
  // Inside the web folder only (a sibling like dist-web.bak shares the prefix but is not inside).
  if (file !== root && !file.startsWith(root + sep)) return plain(res, 403, 'Verboten');
  let st = statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) {
    // A missing hashed file (an old tab asking for a chunk of the previous build) must not get the
    // HTML page with status 200 – the browser would try to run it and cache it for a year.
    if (decoded.startsWith('/assets/')) return plain(res, 404, 'Nicht gefunden');
    file = join(root, 'index.html');
    st = statSync(file, { throwIfNoEntry: false });
  }
  if (!st || !st.isFile()) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return void res.end(head ? undefined : '<h1>HyperLevel</h1><p>Die Oberfläche ist noch nicht gebaut: <code>npm run build</code>.</p>');
  }

  const e = entryFor(file, st);
  const immutable = file.startsWith(join(root, 'assets') + sep);
  const headers: Record<string, string> = {
    'content-type': e.type,
    'cache-control': immutable ? IMMUTABLE : 'no-cache',
    etag: e.etag,
    'last-modified': e.lastModified,
    // The admin app is never framed (clickjacking); public pages live on other routes.
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
    ...(e.type.startsWith('text/html') ? o.htmlHeaders() : {}),
  };
  if (e.compressible) headers.vary = 'Accept-Encoding';
  if (notModified(req, e)) {
    const { 'content-type': _t, ...rest } = headers;
    res.writeHead(304, rest);
    return void res.end();
  }

  let body: Buffer | null = null;
  let streamFile = e.file;
  let size = e.size;
  if (e.compressible) {
    const enc = pickEncoding(req.headers['accept-encoding'], e.pre.br ? ['br', 'gzip'] : ['gzip']);
    const pre = enc ? e.pre[enc] : undefined;
    if (pre) {
      headers['content-encoding'] = enc!;
      body = await load(pre.file, pre.size, pre);
      streamFile = pre.file;
      size = pre.size;
    } else if (enc === 'gzip') {
      const gz = await gzipped(e);
      if (gz) {
        headers['content-encoding'] = 'gzip';
        body = gz;
        size = gz.length;
      }
    }
  }
  if (!headers['content-encoding']) body = await load(e.file, e.size, e);
  headers['content-length'] = String(body ? body.length : size);
  res.writeHead(200, headers);
  if (head) return void res.end();
  if (body) return void res.end(body);
  const stream = createReadStream(streamFile);
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** For tests: forget cached files (the build folder changed under a running server). */
export function clearStaticCache() {
  entries.clear();
}
