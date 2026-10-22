import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { App } from '../core/app.js';
import type { Ctx, RawResult } from '../core/http.js';
import { safeEqual } from '../core/util.js';
import { BRIDGE_JS } from './office-bridge-js.js';
import { KINDS, OFFICE_KINDS, isKind, type OfficeKind } from './office-model.js';

/**
 * The browser editors (optional, docs/office.md): unmodified upstream WebAssembly builds unpacked under `PGHL_OFFICE_DIR/<kind>/`
 * (docx, xlsx, pptx, pdf) and served at `/office/app/<kind>/`. The editor's page gets a strict Content-Security-Policy (own files
 * only, WebAssembly allowed, no third-party requests, framing by HyperLevel only), a nonce on its scripts and the load/save bridge
 * (office-bridge-js.ts) in front of them. The page runs in a sandboxed iframe without `allow-same-origin` by default
 * (`PGHL_OFFICE_SANDBOX=strict`): the editor's code gets an opaque origin and cannot reach HyperLevel's API or cookies – which is why its
 * files are served with `Access-Control-Allow-Origin: *` (they are public open-source files) and the PDF editor reads its file
 * through a short-lived signed link.
 */

export const officeDirRoot = () => (process.env.PGHL_OFFICE_DIR ?? '').trim();
export type SandboxMode = 'strict' | 'same-origin';
export const sandboxMode = (): SandboxMode => ((process.env.PGHL_OFFICE_SANDBOX ?? '').trim() === 'same-origin' ? 'same-origin' : 'strict');

export function editorDir(kind: OfficeKind): string | null {
  const root = officeDirRoot();
  if (!root) return null;
  const dir = resolve(root, kind);
  try {
    return statSync(join(dir, 'index.html')).isFile() ? dir : null;
  } catch {
    return null;
  }
}

export const editorStatus = (): Record<OfficeKind, boolean> => Object.fromEntries(OFFICE_KINDS.map((k) => [k, !!editorDir(k)])) as Record<OfficeKind, boolean>;

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};
/** Asset names as the release zips have them: one flat folder, letters, digits, dot, dash, underscore; no hidden files. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
/** Content-hashed names (trunk: `name-<hash>.js`, `name-<hash>_bg.wasm`) can be cached for good. */
const HASHED = /-[0-9a-f]{12,}(_bg)?\.(js|wasm|css)$/;

const plain = (status: number, body: string): RawResult => ({ __raw: true, status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body });

/** The request's own origin (scheme + host), the only window the bridge talks to. */
export function requestOrigin(app: App, ctx: Ctx): string {
  const base = new URL(app.config.baseUrl);
  const host = String(ctx.req.headers.host ?? '').trim();
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return base.origin;
  const proto = app.config.behindProxy ? String(ctx.req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || base.protocol.replace(':', '') : (ctx.req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

export function editorCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const notInstalledPage = (kind: OfficeKind) =>
  `<!doctype html><html lang="de"><meta charset="utf-8"><title>Editor nicht installiert</title><body style="font:15px system-ui,sans-serif;margin:2rem;color:#374151"><h1 style="font-size:1.2rem">Editor nicht installiert</h1><p>Der Browser-Editor für ${KINDS[kind].label} ist auf diesem Server nicht eingerichtet (<code>PGHL_OFFICE_DIR</code>). Die Datei lässt sich trotzdem herunterladen, in einer neuen Version hochladen und vom KI-Agenten bearbeiten. Einrichtung: docs/office.md.</p></body></html>`;

/** The editor's page: upstream index.html with a nonce on every script and the bridge in front of them. */
export function editorPage(app: App, ctx: Ctx, kindRaw: string, maxBytes: number): RawResult {
  if (!isKind(kindRaw)) return plain(404, 'Nicht gefunden');
  const kind = kindRaw;
  // Relative asset URLs ("./x.js") need the trailing slash.
  if (!ctx.path.endsWith('/')) return { __raw: true, status: 301, headers: { location: `/office/app/${kind}/${ctx.url.search}` }, body: '' };
  const nonce = randomBytes(18).toString('base64');
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': editorCsp(nonce),
    'x-frame-options': 'SAMEORIGIN',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
  };
  const dir = editorDir(kind);
  if (!dir) return { __raw: true, status: 200, headers: { ...headers, 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'" }, body: notInstalledPage(kind) };
  let html: string;
  try {
    html = readFileSync(join(dir, 'index.html'), 'utf8');
  } catch {
    return plain(500, 'index.html nicht lesbar');
  }
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const bridge = `<script nonce="${nonce}" src="/office/bridge.js" data-kind="${kind}" data-exts="${KINDS[kind].saveExts.join(',')}" data-save="${KINDS[kind].saveShift ? 'shift' : 'plain'}" data-target="${attr(requestOrigin(app, ctx))}" data-max="${Math.floor(maxBytes)}"></script>`;
  // every script of the page (trunk's inline module loader and its preloads) carries the nonce
  html = html.replace(/<script\b([^>]*)>/gi, (_m, attrs: string) => `<script nonce="${nonce}"${attrs.replace(/\snonce=("[^"]*"|'[^']*'|\S+)/gi, '')}>`);
  html = /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (m) => `${m}${bridge}`) : `${bridge}${html}`;
  return { __raw: true, status: 200, headers, body: html };
}

export const bridgeScript = (): RawResult => ({
  __raw: true,
  status: 200,
  headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' },
  body: BRIDGE_JS,
});

/** One file of an editor build. Precompressed siblings (`.br`, `.gz` – deploy/office/install.sh writes them) are used when accepted. */
export function editorAsset(ctx: Ctx, kindRaw: string, name: string): RawResult {
  if (!isKind(kindRaw) || !ASSET_NAME.test(name) || name === 'index.html') return plain(404, 'Nicht gefunden');
  const dir = editorDir(kindRaw);
  if (!dir) return plain(404, 'Editor nicht installiert');
  const file = resolve(dir, name);
  if (!file.startsWith(dir + sep)) return plain(403, 'Verboten');
  let st;
  try {
    st = statSync(file);
  } catch {
    return plain(404, 'Nicht gefunden');
  }
  if (!st.isFile()) return plain(404, 'Nicht gefunden');
  const type = MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
  const accept = String(ctx.req.headers['accept-encoding'] ?? '');
  let path = file;
  let size = st.size;
  let encoding = '';
  for (const [enc, ext] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (!new RegExp(`\\b${enc}\\b`).test(accept)) continue;
    try {
      const s = statSync(file + ext);
      if (s.isFile() && s.mtimeMs + 1000 >= st.mtimeMs) {
        path = file + ext;
        size = s.size;
        encoding = enc;
        break;
      }
    } catch {
      /* none */
    }
  }
  const headers: Record<string, string> = {
    'content-type': type,
    'content-length': String(size),
    'cache-control': HASHED.test(name) ? 'public, max-age=31536000, immutable' : 'no-cache',
    // the sandboxed editor page has an opaque origin: its module scripts and wasm are CORS requests
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'x-content-type-options': 'nosniff',
    vary: 'Accept-Encoding',
  };
  if (encoding) headers['content-encoding'] = encoding;
  if (ctx.method === 'HEAD') return { __raw: true, status: 200, headers, body: '' };
  return { __raw: true, status: 200, headers, body: createReadStream(path) };
}

// --- signed links for the PDF editor (it fetches `?file=<url>` itself, without cookies) ------------------------------------

export const BLOB_TTL_MS = 10 * 60_000;
const sign = (app: App, payload: string) => createHmac('sha256', `office-blob:${app.config.secret}`).update(payload).digest('base64url');

export function blobToken(app: App, locationId: string, fileId: string, version: number, at = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ l: locationId, f: fileId, v: version, e: at + BLOB_TTL_MS })).toString('base64url');
  return `${payload}.${sign(app, payload)}`;
}

export function readBlobToken(app: App, token: string, at = Date.now()): { locationId: string; fileId: string; version: number } | null {
  const [payload, sig] = String(token ?? '').split('.');
  if (!payload || !sig || !safeEqual(sig, sign(app, payload))) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof j.e !== 'number' || j.e < at || typeof j.f !== 'string' || typeof j.l !== 'string' || !Number.isInteger(j.v)) return null;
    return { locationId: j.l, fileId: j.f, version: j.v };
  } catch {
    return null;
  }
}
