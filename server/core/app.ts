import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { compressBuffer, headerValue, isCompressible, MIN_COMPRESS_BYTES, pickEncoding, varyAcceptEncoding } from './compress.js';
import { Db } from './db.js';
import { EventBus } from './events.js';
import {
  HttpError,
  Router,
  constraintError,
  upstreamError,
  parseBody,
  parseCookies,
  readBody,
  readBodyBuffer,
  type Auth,
  type Ctx,
  type RawResult,
  type Route,
  type User,
} from './http.js';
import { PerfMonitor } from './perf.js';
import { openSettings, sealSettings } from './secrets.js';
import { serveStatic } from './static.js';
import { sha256 } from './util.js';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  /** Public address used in links (booking confirmations, invoices, review requests). */
  baseUrl: string;
  webDir: string;
  behindProxy: boolean;
  /** Proxies in front of the app that append to X-Forwarded-For (PGHL_PROXY_HOPS, default 1). */
  proxyHops?: number;
  /** Ticks of the background scheduler (workflow waits, scheduled campaigns). 0 turns it off. */
  tickMs: number;
  /** How long the scheduler waits for one job before it goes on with the next one (default 60 s; the job keeps running). */
  jobBudgetMs?: number;
  /** Signs unsubscribe links and other tokens; kept in the data folder. */
  secret: string;
  /** Public demo instance (PGHL_DEMO_MODE=1): seeded data, nightly reset, no outgoing connections. */
  demoMode?: boolean;
  /** Hosted cloud service (PGHL_CLOUD_MODE=1): self-serve signup, billing and tenants – see docs/cloud.md. Off for self-hosters. */
  cloudMode?: boolean;
  /** Key for secrets at rest (hex, 32 bytes; data.key or PGHL_DATA_KEY). Without it a key derived from `secret` is used. */
  dataKey?: string;
  /** Earlier data keys, so values sealed before a rotation still open (data.key.previous / PGHL_DATA_KEY_PREVIOUS). */
  previousDataKeys?: string[];
}

export interface App {
  config: Config;
  db: Db;
  router: Router;
  events: EventBus;
  /** Shared services modules expose to each other (mail, sms, contacts…), filled in at registration. */
  services: Record<string, any>;
  /** Event-loop lag, slow requests/queries and per-job tick times (GET /api/admin/metrics, core/perf.ts). */
  perf: PerfMonitor;
  /** Called on every scheduler tick. */
  onTick(fn: () => void | Promise<void>): void;
  tick(): Promise<void>;
  baseUrl(): string;
  location(id: string): LocationRow | undefined;
  /** Host-based rewrites (custom funnel domains): return a new path, or undefined to pass. */
  rewrites: ((host: string, path: string) => string | undefined)[];
  /** Run after authentication on every non-public route; throw an HttpError to refuse. */
  guards: ((ctx: Ctx, auth: Auth) => void)[];
  /** Other bearer tokens (agency API keys): return true when the token was recognised and ctx filled in. */
  bearerAuth: ((ctx: Ctx, token: string, auth: Auth) => boolean)[];
  /** Called after every successful authenticated write (audit log). */
  afterWrite: ((ctx: Ctx, route: Route, result: unknown) => void)[];
  /** Called after every successful authenticated read (the audit log records exports and downloads). */
  afterRead: ((ctx: Ctx, route: Route) => void)[];
  /** The app's own address for in-process calls (MCP relays REST), set once listening. */
  selfUrl: string;
}

export interface LocationRow {
  id: string;
  name: string;
  timezone: string;
  settings: Record<string, any>;
  /** The app the row was read from (set by app.location, not enumerable). */
  readonly app?: App;
  [k: string]: any;
}

export interface Module {
  name: string;
  /** Ordered, named SQL migrations. Names must never change once shipped. */
  migrations?: [name: string, sql: string][];
  register(app: App): void;
}

const SESSION_COOKIE = 'pghl_session';
const CSRF_HEADER = 'x-pghl';

export function createApp(config: Config, modules: Module[]) {
  const db = new Db(config.dbFile);
  const perf = new PerfMonitor();
  if (perf.slowQueryMs > 0) {
    db.slowMs = perf.slowQueryMs;
    db.onSlow = (sql, ms) => perf.query(sql, ms);
  }
  const router = new Router();
  const events = new EventBus();
  // Each job is labelled with the module that registered it (admin metrics show which one is slow).
  // `running` is the run that is still going: a job is never started twice at once, and one that hangs (a mail server or an
  // API that never answers) is left behind after `jobBudgetMs` instead of holding up every job after it.
  const tickers: { fn: () => void | Promise<void>; module: string; running?: Promise<void> }[] = [];
  let registering = 'core';
  const jobBudgetMs = config.jobBudgetMs ?? 60_000;

  const app: App = {
    config,
    db,
    router,
    events,
    services: {},
    perf,
    onTick: (fn) => void tickers.push({ fn, module: registering }),
    async tick() {
      const seen = new Map<string, number>();
      for (const job of tickers) {
        const { fn, module } = job;
        const n = (seen.get(module) ?? 0) + 1;
        seen.set(module, n);
        const label = n > 1 ? `${module}#${n}` : module;
        // The previous run is still going (slow import, hung connection): do not start it a second time.
        if (job.running) continue;
        const t = performance.now();
        const run: Promise<void> = (async () => {
          try {
            await fn();
          } catch (e) {
            console.error(`[tick] ${label}:`, e);
          }
        })();
        job.running = run.finally(() => {
          job.running = undefined;
        });
        let late: NodeJS.Timeout | undefined;
        const overBudget = await Promise.race([
          run.then(() => false),
          new Promise<boolean>((r) => {
            late = setTimeout(() => r(true), jobBudgetMs);
            late.unref?.();
          }),
        ]);
        clearTimeout(late);
        if (overBudget) console.warn(`[tick] Job „${label}“ läuft schon über ${Math.round(jobBudgetMs / 1000)} s – die anderen Jobs laufen weiter, er wird erst wieder gestartet, wenn er fertig ist`);
        perf.job(label, performance.now() - t);
        // Jobs run one after the other; let requests through between two of them.
        await new Promise<void>((r) => setImmediate(r));
      }
    },
    // A module (agency white-label) may serve links from another domain once it is live.
    baseUrl: () => (app.services.publicBaseUrl?.() ?? config.baseUrl).replace(/\/$/, ''),
    rewrites: [],
    guards: [],
    bearerAuth: [],
    afterWrite: [],
    afterRead: [],
    selfUrl: '',
    location(id) {
      const row = db.get('SELECT * FROM locations WHERE id = ?', id);
      if (!row) return undefined;
      // Credentials in the settings (SMTP password, SMS tokens…) are stored sealed; a value some code wrote
      // in plain text is sealed on the next read. Callers get them opened – responses go through maskSettings.
      const sealed = sealSettings(app, row.settings ? JSON.parse(row.settings) : {});
      if (sealed.changed) db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealed.value), id);
      row.settings = openSettings(app, sealed.value);
      // Senders other modules register (app.services.emailTransports/smsTransports) reach the app through
      // the row; not enumerable, so it never ends up in JSON.
      Object.defineProperty(row, 'app', { value: app, enumerable: false });
      return row as LocationRow;
    },
  };

  for (const m of modules) for (const [name, sql] of m.migrations ?? []) db.migrate(`${m.name}:${name}`, sql);
  // Planner statistics for tables and indexes that have none yet (new indexes from the migrations above).
  db.optimize(true);
  for (const m of modules) {
    registering = m.name;
    app.router.owner = m.name;
    m.register(app);
    // MCP tools remember the module that brought them (agents' coverage matrix, services/agent-coverage.ts)
    for (const t of (app.services.mcpTools ?? []) as { module?: string }[]) t.module ??= m.name;
  }
  registering = 'core';
  app.router.owner = 'core';

  const server = createServer((req, res) => {
    handle(app, req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Interner Fehler' });
    });
  });
  // HTTP upgrades (WebSockets, e.g. Twilio Media Streams): modules add `(req, socket, head) => boolean` handlers to
  // app.services.upgradeHandlers, the first one that returns true owns the socket. Nobody takes it: it is closed.
  server.on('upgrade', (req, socket, head) => {
    // A client that vanishes during the handshake must not crash the process (no listener = uncaught 'error').
    socket.on('error', () => undefined);
    try {
      for (const h of (app.services.upgradeHandlers ?? []) as ((req: IncomingMessage, socket: Duplex, head: Buffer) => boolean)[]) if (h(req, socket, head)) return;
    } catch (e) {
      console.error('[upgrade]', e);
    }
    socket.destroy();
  });
  // Slow clients: headers must arrive within 20 s, a whole request within 5 min (large uploads), idle sockets close.
  server.headersTimeout = 20_000;
  server.requestTimeout = 300_000;
  server.keepAliveTimeout = 5_000;

  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  if (config.tickMs > 0) {
    timer = setInterval(async () => {
      if (ticking) return;
      ticking = true;
      try {
        await app.tick();
      } catch (e) {
        console.error('[tick]', e);
      } finally {
        ticking = false;
      }
    }, config.tickMs);
    timer.unref();
  }

  return {
    app,
    server,
    listen(): Promise<Server> {
      return new Promise((r) =>
        server.listen(config.port, config.host, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : config.port;
          app.selfUrl = `http://127.0.0.1:${port}`;
          perf.start();
          r(server);
        }),
      );
    },
    async close() {
      perf.stop();
      if (timer) clearInterval(timer);
      await events.flush();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      db.close();
    },
  };
}

const bodylessMethod = (m: string) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body ?? null);
  void sendBody(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, json);
}

/**
 * Writes a complete (non-streamed) answer, brotli/gzip-compressed when the client accepts it and it is
 * text over 1 KB. Not for: our own MCP relay (loopback), ranges, bodies a module encoded or sized itself.
 */
async function sendBody(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer | undefined) {
  const req = res.req as IncomingMessage | undefined;
  const size = body === undefined ? 0 : typeof body === 'string' ? Buffer.byteLength(body) : body.length;
  const type = headerValue(headers, 'content-type') ?? '';
  const eligible =
    !!req && req.method !== 'HEAD' && size > MIN_COMPRESS_BYTES && status !== 204 && status !== 206 && status !== 304 && isCompressible(type) && !req.headers['x-pghl-via'] &&
    !headerValue(headers, 'content-encoding') && !headerValue(headers, 'content-length') && !headerValue(headers, 'content-range') && !/no-transform/i.test(headerValue(headers, 'cache-control') ?? '');
  if (eligible) {
    const enc = pickEncoding(req.headers['accept-encoding']);
    const vary = varyAcceptEncoding(headerValue(headers, 'vary'));
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'vary') delete headers[k];
    headers.vary = vary;
    if (enc) {
      try {
        const out = await compressBuffer(typeof body === 'string' ? Buffer.from(body) : body!, enc);
        if (res.destroyed) return;
        res.writeHead(status, { ...headers, 'content-encoding': enc, 'content-length': String(out.length) });
        return void res.end(out);
      } catch {
        /* send it uncompressed */
      }
    }
  }
  res.writeHead(status, headers);
  res.end(body);
}

/** Simple per-IP limiters (loopback, i.e. the MCP relay, is exempt); one bucket per purpose. */
const buckets = new Map<string, Map<string, { n: number; at: number }>>();
function overLimit(ip: string, max: number, bucket = 'api'): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return false;
  let hits = buckets.get(bucket);
  if (!hits) buckets.set(bucket, (hits = new Map()));
  const t = Date.now();
  const h = hits.get(ip);
  if (!h || t - h.at > 60_000) {
    hits.set(ip, { n: 1, at: t });
    if (hits.size > 50_000) hits.clear();
    return false;
  }
  h.n++;
  return h.n > max;
}

/** Request bodies: 1 MB for public routes (forms, booking, chat, webhooks…), 12 MB behind a login. */
export const PUBLIC_BODY_LIMIT = 1024 * 1024;
export const AUTH_BODY_LIMIT = 12 * 1024 * 1024;
/**
 * Public routes that need more register here (app.services.bodyLimits), e.g. form uploads or inbound mail:
 * `{ match: (method, path, req) => boolean, bytes }`.
 */
function bodyLimit(app: App, method: string, path: string, auth: string, req: IncomingMessage): number {
  for (const l of (app.services.bodyLimits ?? []) as { match: (m: string, p: string, req: IncomingMessage) => boolean; bytes: number }[]) if (l.match(method, path, req)) return l.bytes;
  return auth === 'public' ? PUBLIC_BODY_LIMIT : AUTH_BODY_LIMIT;
}

/** Baseline for every response; pages add their own CSP (funnels: sandbox, portals: strict). */
const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(self), payment=(self), usb=(), browsing-topics=()';

/**
 * The visitor's address. Behind a proxy the *rightmost* X-Forwarded-For entries are the ones our proxies added
 * (PGHL_PROXY_HOPS, default 1); the leftmost is whatever the client sent and must never be trusted – otherwise
 * every rate limit and login lockout could be dodged with a made-up header.
 */
export function clientIp(req: IncomingMessage, behindProxy: boolean, hops = 1): string {
  if (behindProxy) {
    const list = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list[Math.max(0, list.length - Math.max(1, hops))];
  }
  return req.socket.remoteAddress || '';
}

/** Long-lived requests that are slow by design (long polls, streams): not counted as slow. */
const LONG_LIVED = /^\/api\/agent\/bridge\//;

/** Times the request (until the handler has answered or started streaming) for app.perf. */
async function handle(app: App, req: IncomingMessage, res: ServerResponse) {
  const t0 = performance.now();
  const seen: { route?: string } = {};
  try {
    await handleRequest(app, req, res, seen);
  } finally {
    const path = (req.url ?? '/').split('?')[0];
    if (!LONG_LIVED.test(path) && !String(res.getHeader('content-type') ?? '').startsWith('text/event-stream')) {
      // Unmatched paths (static files, 404s) share one label per kind: never the raw path.
      const route = seen.route ?? (path.startsWith('/api/') ? '/api/(unknown)' : '(static)');
      app.perf.request((req.method ?? 'GET').toUpperCase(), route, res.statusCode, performance.now() - t0);
    }
  }
}

async function handleRequest(app: App, req: IncomingMessage, res: ServerResponse, seen: { route?: string }) {
  // A leading `//` would otherwise be read as a host (`//api/users` → host `api`, path `/users`).
  const url = new URL((req.url ?? '/').replace(/^\/{2,}/, '/'), 'http://local');
  const method = (req.method ?? 'GET').toUpperCase();
  // One spelling per route: `//api//users/` must not slip past guards that compare `ctx.path` with `/api/users`.
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (path.length > 5 && path.startsWith('/api/') && path.endsWith('/')) path = path.slice(0, -1);
  const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
  if (host && host !== new URL(app.config.baseUrl).hostname && host !== 'localhost' && host !== '127.0.0.1') {
    for (const rw of app.rewrites) {
      const next = rw(host, path);
      if (next) {
        path = next;
        break;
      }
    }
  }
  const isPublicApi = path.startsWith('/api/public/') || path.startsWith('/hooks/');
  // Baseline headers for every response; pages that must not be framed set their own.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', PERMISSIONS_POLICY);
  if (app.config.baseUrl.startsWith('https://')) res.setHeader('strict-transport-security', 'max-age=31536000');
  const ip = clientIp(req, app.config.behindProxy, app.config.proxyHops);
  if (path.startsWith('/api/') || path === '/mcp' || path.startsWith('/hooks/')) {
    if (overLimit(ip, 900)) return send(res, 429, { error: 'Zu viele Anfragen – bitte kurz warten' });
  }

  if (isPublicApi) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (method === 'OPTIONS') return void res.writeHead(204).end();
  }

  const found = app.router.match(method, path);
  if (!found) {
    // The web app's files: GET and HEAD alike (a HEAD request used to get a 404 JSON with no-store).
    if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/')) {
      return serveStatic(req, res, { root: app.config.webDir, path, htmlHeaders: () => ({ 'content-security-policy': contentSecurityPolicy(app) }) });
    }
    return send(res, 404, { error: 'Nicht gefunden' });
  }
  seen.route = found.route.pattern;
  // Public writes by people (forms, booking, chat, sign-ups, portal posts): 120 a minute per address is plenty;
  // provider webhooks (/hooks/…), the domain agent and MCP keep the API limit above.
  // One-click unsubscribes (/u/…) come from the mail providers' servers, many people from one address: the signed link is the protection.
  if (found.route.auth === 'public' && !bodylessMethod(method) && !path.startsWith('/hooks/') && !path.startsWith('/u/') && !path.startsWith('/api/agent/') && path !== '/mcp' && overLimit(ip, 120, 'public-write')) {
    return send(res, 429, { error: 'Zu viele Anfragen – bitte kurz warten' }, { 'retry-after': '60' });
  }

  const cookies = parseCookies(req.headers.cookie);
  const outCookies: string[] = [];
  const bodyless = method === 'GET' || method === 'HEAD';
  const ctx: Ctx = {
    req,
    res,
    method,
    url,
    path,
    params: found.params,
    query: url.searchParams,
    body: {},
    rawBody: '',
    rawBuffer: undefined,
    locationId: '',
    viaApiKey: false,
    ip,
    cookies,
    setCookie(name, value, opts = {}) {
      const secure = app.config.baseUrl.startsWith('https://') ? '; Secure' : '';
      const age = opts.maxAge !== undefined ? `; Max-Age=${opts.maxAge}` : '';
      const httpOnly = opts.httpOnly === false ? '' : '; HttpOnly';
      outCookies.push(`${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${httpOnly}${secure}${age}`);
    },
  };

  // Who is asking is known from the headers alone: a request without a valid login is refused before
  // its body is read (nobody can make the server buffer 12 MB without credentials).
  try {
    authenticate(app, ctx, found.route.auth);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message }, bodyless ? {} : { connection: 'close' });
    throw e;
  }

  // A module may take a binary upload on a route (app.services.rawBodyLimit → max bytes, e.g. the Android app).
  const rawLimit: number | undefined = bodyless ? undefined : app.services.rawBodyLimit?.(method, path, req, cookies);
  try {
    if (rawLimit) ctx.rawBuffer = await readBodyBuffer(req, rawLimit);
    else if (!bodyless) ctx.rawBody = await readBody(req, bodyLimit(app, method, path, found.route.auth, req));
  } catch (e) {
    // The rest of an oversized body is not read: close the connection after answering.
    if (e instanceof HttpError) return send(res, e.status, { error: e.message }, { connection: 'close' });
    throw e;
  }

  try {
    ctx.body = parseBody(ctx.rawBody, req.headers['content-type']);
    if (found.route.auth !== 'public') for (const g of app.guards) g(ctx, found.route.auth);
    const result = await found.route.handler(ctx);
    // Public pages as they leave the server: modules may rewrite the HTML for this visitor or answer in its place (the cookie
    // banner blocks third-party code until consent). app.services.htmlTransforms = [(ctx, result) => void]; they only see
    // GET pages with a 200 and a string body, and may set cookies and replace the result.
    if (found.route.auth === 'public' && method === 'GET' && result && typeof result === 'object' && (result as RawResult).__raw) {
      const r = result as RawResult;
      if (r.status === 200 && typeof r.body === 'string' && String(r.headers['content-type'] ?? '').startsWith('text/html')) {
        for (const fn of (app.services.htmlTransforms ?? []) as ((ctx: Ctx, r: RawResult) => void)[]) {
          try {
            fn(ctx, r);
          } catch (e) {
            console.error('[htmlTransforms]', e);
          }
        }
      }
    }
    if (method !== 'GET' && found.route.auth !== 'public' && !ctx.skipAfterWrite) {
      for (const fn of app.afterWrite) {
        try {
          fn(ctx, found.route, result);
        } catch (e) {
          console.error('[afterWrite]', e);
        }
      }
    }
    if (method === 'GET' && found.route.auth !== 'public') {
      for (const fn of app.afterRead) {
        try {
          fn(ctx, found.route);
        } catch (e) {
          console.error('[afterRead]', e);
        }
      }
    }
    if (outCookies.length) res.setHeader('set-cookie', outCookies);
    if (result && typeof result === 'object' && (result as RawResult).__raw) {
      const r = result as RawResult;
      // Server-rendered pages without their own policy: no plugins, no <base> hijacking (scripts stay inline-capable).
      if (String(r.headers['content-type'] ?? '').startsWith('text/html') && !Object.keys(r.headers).some((k) => k.toLowerCase() === 'content-security-policy')) {
        r.headers['content-security-policy'] = "object-src 'none'; base-uri 'self'";
      }
      if (typeof r.body === 'object' && !Buffer.isBuffer(r.body) && typeof r.body.pipe === 'function') {
        res.writeHead(r.status, r.headers);
        const stream = r.body;
        res.on('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        return void stream.pipe(res);
      }
      return void (await sendBody(res, r.status, r.headers, r.body as string | Buffer));
    }
    send(res, 200, result ?? { ok: true });
  } catch (e) {
    if (outCookies.length) res.setHeader('set-cookie', outCookies);
    if (e instanceof HttpError) return send(res, e.status, e.data ? { ...e.data, error: e.message } : { error: e.message });
    const constraint = constraintError(e);
    if (constraint) {
      console.warn(`[request] ${found.route.method} ${found.route.pattern}: ${(e as Error).message}`);
      return send(res, constraint.status, { error: constraint.message });
    }
    const upstream = upstreamError(e);
    if (upstream) {
      console.warn(`[request] ${found.route.method} ${found.route.pattern}: ${(e as Error).message}${(e as any).cause?.code ? ` (${(e as any).cause.code})` : ''}`);
      return send(res, upstream.status, { error: upstream.message });
    }
    // A date or time the client sent that nobody checked (`new Date('zzz').toISOString()`) is the client's mistake, not ours.
    if (e instanceof RangeError && /Invalid time value/.test(e.message)) return send(res, 400, { error: 'Ungültiges Datum oder ungültige Uhrzeit' });
    // Unexpected error: a module may record it (app.services.serverError → request id for the answer).
    let requestId: string | undefined;
    try {
      requestId = app.services.serverError?.(e, ctx, found.route);
    } catch {
      requestId = undefined;
    }
    if (requestId) {
      console.error(`[request ${requestId}]`, e);
      return send(res, 500, { error: `Interner Fehler (Request-ID ${requestId})`, request_id: requestId }, { 'x-request-id': requestId });
    }
    throw e;
  }
}

function authenticate(app: App, ctx: Ctx, auth: string) {
  if (auth === 'public') return;
  const bearer = String(ctx.req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];

  if (bearer) {
    for (const fn of app.bearerAuth) if (fn(ctx, bearer, auth as Auth)) return;
    if (auth !== 'location') throw new HttpError(403, 'API-Schlüssel gelten nur für Sub-Account-Endpunkte');
    const key = app.db.get('SELECT * FROM api_keys WHERE key_hash = ?', sha256(bearer));
    if (!key) throw new HttpError(401, 'Ungültiger API-Schlüssel');
    app.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', new Date().toISOString(), key.id);
    ctx.locationId = key.location_id;
    ctx.viaApiKey = true;
    ctx.via = isRelay(ctx) ? 'mcp' : 'api_key';
    return;
  }

  const sid = ctx.cookies[SESSION_COOKIE];
  const row = sid
    ? app.db.get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
        sha256(sid),
        new Date().toISOString(),
      )
    : undefined;
  if (!row) throw new HttpError(401, 'Nicht angemeldet');
  // Cookie-authenticated writes must come from our own app (blocks cross-site form posts).
  if (ctx.method !== 'GET' && ctx.req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, 'CSRF-Schutz: Header fehlt');
  const user: User = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    locations: JSON.parse(row.locations || '[]'),
    permissions: row.permissions ? JSON.parse(row.permissions) : null,
  };
  ctx.user = user;
  ctx.via = 'session';
  if (auth === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Nur für Admins');
  if (auth === 'location') {
    const loc = String(ctx.req.headers['x-location-id'] ?? ctx.query.get('locationId') ?? '');
    if (!loc) throw new HttpError(400, 'Kein Sub-Account gewählt (x-location-id)');
    if (user.role !== 'admin' && !user.locations.includes(loc)) throw new HttpError(403, 'Kein Zugriff auf diesen Sub-Account');
    if (!app.db.get('SELECT id FROM locations WHERE id = ?', loc)) throw new HttpError(404, 'Sub-Account nicht gefunden');
    ctx.locationId = loc;
  }
}

export { SESSION_COOKIE };

/** A request relayed by our own MCP endpoint (loopback + marker header). */
export function isRelay(ctx: Ctx): boolean {
  return ctx.req.headers['x-pghl-via'] === 'mcp' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ctx.ip);
}

/** Extra origins a module may allow in the admin app (app.services.cspExtra), e.g. the browser phone's Twilio hosts. */
const CSP_SOURCE = /^(https|wss):\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;
const cspList = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && CSP_SOURCE.test(s)))].map((s) => ` ${s}`).join('') : '';

/** Content-Security-Policy of the admin app; only plain https/wss origins from modules are added. */
export function contentSecurityPolicy(app: App): string {
  const extra = app.services.cspExtra ?? {};
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; connect-src 'self'${cspList(extra.connect)}; frame-src 'self' https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
}

