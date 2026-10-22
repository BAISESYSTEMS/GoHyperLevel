import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Extra fields for the JSON answer next to `error` (e.g. the diff of a 409 conflict). */
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (what = 'Nicht gefunden') => new HttpError(404, what);

/**
 * A SQLite constraint that a request ran into (a required column sent as null, a duplicate, a link to a record that is gone, or a
 * trigger that guards a frozen record) is the caller's conflict, not a crash: 400 / 409 with a plain message instead of "Interner Fehler".
 * Other database errors (a typo in SQL, a locked file) stay 500s.
 */
export function constraintError(e: unknown): HttpError | undefined {
  const x = e as { code?: string; errcode?: number; message?: string } | null;
  if (!x || x.code !== 'ERR_SQLITE_ERROR' || typeof x.errcode !== 'number' || (x.errcode & 0xff) !== 19) return undefined;
  const msg = String(x.message ?? '');
  switch (x.errcode) {
    case 2067: // UNIQUE
    case 1555: // PRIMARY KEY
      return new HttpError(409, 'Diesen Eintrag gibt es schon');
    case 1299: // NOT NULL
      return new HttpError(400, `Pflichtangabe fehlt oder ist leer${/: \w+\.(\w+)$/.exec(msg) ? ` (${/: \w+\.(\w+)$/.exec(msg)![1]})` : ''}`);
    case 787: // FOREIGN KEY
      return new HttpError(400, 'Der verknüpfte Datensatz existiert nicht (mehr)');
    case 275: // CHECK
      return new HttpError(400, 'Ungültiger Wert');
    case 1811: // RAISE(ABORT, '…') of one of our triggers (frozen invoices …): the text is the rule
      return new HttpError(409, msg || 'Aktion nicht erlaubt');
    default:
      return undefined;
  }
}

export type Auth = 'public' | 'user' | 'admin' | 'location';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  locations: string[];
  /** Modules a member may use (null = all). Admins always have all. */
  permissions: string[] | null;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  rawBody: string;
  /** The untouched bytes on routes a module takes binary uploads on (app.services.rawBodyLimit); rawBody is then empty. */
  rawBuffer?: Buffer;
  user?: User;
  /** Set for 'location' routes: the sub-account the request acts on. */
  locationId: string;
  viaApiKey: boolean;
  /** How the caller authenticated: session, location key, agency key (+ "mcp" when the MCP endpoint relays), native app token. */
  via?: 'session' | 'api_key' | 'agency_key' | 'mcp' | 'app';
  /** Set by a handler that already ran the write hooks itself (the mobile API relays onto the regular routes). */
  skipAfterWrite?: boolean;
  /** Agency keys: read-only keys may not write. */
  scope?: 'read' | 'write';
  /** Journal entries this request (and every route it relays) created – the agent shows them as "Rückgängig" (modules/undo.ts). */
  undoSink?: { id: string; label: string; notice?: string }[];
  ip: string;
  setCookie(name: string, value: string, opts?: { maxAge?: number; httpOnly?: boolean }): void;
  cookies: Record<string, string>;
}

export interface RawResult {
  __raw: true;
  status: number;
  headers: Record<string, string>;
  /** A Readable is piped (e.g. a proxied video) and stopped when the client goes away. */
  body: string | Buffer | Readable;
}

export const html = (body: string, status = 200): RawResult => ({
  __raw: true,
  status,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body,
});
export const text = (body: string, type = 'text/plain; charset=utf-8', status = 200): RawResult => ({
  __raw: true,
  status,
  headers: { 'content-type': type },
  body,
});
export const redirect = (location: string, status = 302): RawResult => ({
  __raw: true,
  status,
  headers: { location },
  body: '',
});

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export interface Route {
  method: string;
  /** The pattern as registered, e.g. /api/contacts/:id (audit log, rate limits). */
  pattern: string;
  parts: string[];
  auth: Auth;
  handler: Handler;
  /** The module that registered the route (set while modules register; the agents' route catalogue and coverage test use it). */
  module?: string;
}

export class Router {
  private routes: Route[] = [];
  /** Name of the module registering right now (core/app.ts sets it around each module's register). */
  owner = 'core';
  /**
   * Modules may wrap what a route does without touching its file: each wrapper gets the route and its handler and returns the handler
   * to run instead (or `next` unchanged). Used by the record-level access rules (modules/record-access.ts) to check the record a
   * request names and to shape the answer. Applied when a route is matched, so it covers the web, the app and in-process calls alike.
   */
  wrappers: ((route: Route, next: Handler) => Handler)[] = [];
  private wrapped = new Map<Route, Route>();
  private wrappedFor = 0;

  add(method: string, path: string, auth: Auth, handler: Handler): void {
    this.routes.push({ method, pattern: path, parts: split(path), auth, handler, module: this.owner });
  }
  /** Every registered route (method, pattern, auth, module) – read-only view for catalogues and tests. */
  list(): { method: string; pattern: string; auth: Auth; module: string }[] {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, auth: r.auth, module: r.module ?? 'core' }));
  }
  get(path: string, auth: Auth, h: Handler) {
    this.add('GET', path, auth, h);
  }
  post(path: string, auth: Auth, h: Handler) {
    this.add('POST', path, auth, h);
  }
  put(path: string, auth: Auth, h: Handler) {
    this.add('PUT', path, auth, h);
  }
  patch(path: string, auth: Auth, h: Handler) {
    this.add('PATCH', path, auth, h);
  }
  delete(path: string, auth: Auth, h: Handler) {
    this.add('DELETE', path, auth, h);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = split(path);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = safeDecode(parts[i]);
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: this.wrappers.length ? this.wrap(route) : route, params };
    }
    return undefined;
  }

  private wrap(route: Route): Route {
    if (this.wrappedFor !== this.wrappers.length) {
      this.wrapped.clear();
      this.wrappedFor = this.wrappers.length;
    }
    let w = this.wrapped.get(route);
    if (!w) {
      let handler = route.handler;
      for (const fn of this.wrappers) handler = fn(route, handler);
      w = handler === route.handler ? route : { ...route, handler };
      this.wrapped.set(route, w);
    }
    return w;
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** decodeURIComponent that keeps a malformed escape (`%E0%A4%A`) as it is instead of throwing – the route then answers 404/400, not 500. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = safeDecode(part.slice(i + 1).trim());
  }
  return out;
}

export async function readBodyBuffer(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Anfrage zu groß');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readBody(req: IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return (await readBodyBuffer(req, limit)).toString('utf8');
}

export function parseBody(raw: string, type: string | undefined): any {
  if (!raw) return {};
  if (type?.includes('application/json')) {
    try {
      // A literal `null` is no body at all: handlers read fields off it (`ctx.body.name`).
      return JSON.parse(raw) ?? {};
    } catch {
      throw bad('Ungültiges JSON');
    }
  }
  if (type?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return { raw };
  }
}

/** Small helpers for validating request bodies. */
export function str(v: unknown, field: string, opts: { required?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw bad(`${field} fehlt`);
    return '';
  }
  const s = String(v).trim();
  if (opts.max && s.length > opts.max) throw bad(`${field} ist zu lang`);
  return s;
}

/**
 * An outgoing call that failed on the network (no route, refused, reset, timed out) is the other side's outage: 502 with a plain message,
 * not "Interner Fehler". Routes that know better (Twilio's error text, Stripe's message) catch the error themselves first.
 */
export function upstreamError(e: unknown): HttpError | undefined {
  if (!(e instanceof Error)) return undefined;
  const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
  const failed = e instanceof TypeError && e.message === 'fetch failed';
  return timedOut || failed ? new HttpError(502, 'Der externe Dienst ist gerade nicht erreichbar oder antwortet nicht – bitte später noch einmal versuchen') : undefined;
}

/** A `YYYY-MM-DD` value from a query or body (empty = undefined). Anything else is a 400 – not an "Invalid time value" three calls deeper. */
export function ymdParam(v: unknown, field = 'Datum'): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m || new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) !== s) throw bad(`${field}: bitte als JJJJ-MM-TT angeben`);
  return s;
}

/** A page size from the query: whole number between 1 and `max` (SQLite treats LIMIT -1 as "no limit"). */
export function clampLimit(v: unknown, fallback: number, max: number): number {
  const n = Math.floor(num(v, fallback));
  return Math.min(Math.max(n, 1), max);
}

export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
