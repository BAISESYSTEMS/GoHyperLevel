import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { APP_VERSION } from '../version.js';
import { stripControl } from './agent-tool-sources.js';
import { isPrivateIp, safeFetch, safeLookup, type SafeResponse } from './net.js';

/**
 * MCP client: HyperLevel talks to remote MCP servers (Model Context Protocol) as a client – Streamable HTTP
 * (2025-06-18 / 2025-03-26) with a fallback to the older HTTP+SSE transport (2024-11-05), plus the
 * OAuth 2.1 client side of the MCP authorization spec (protected-resource metadata RFC 9728,
 * authorization-server metadata RFC 8414, dynamic client registration RFC 7591, PKCE S256, resource
 * indicators RFC 8707, refresh). All buffered HTTP goes through `safeFetch` (no internal targets unless
 * an agency admin allowed them for that server); the long-lived SSE stream uses the same DNS guard.
 * Tool definitions and results are sanitised here – they come from a system HyperLevel does not control.
 */

export const CLIENT_PROTOCOL = '2025-06-18';
export const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LIMITS = {
  timeoutMs: 30_000,
  /** Largest HTTP answer accepted from an MCP server. */
  maxBytes: 2 * 1024 * 1024,
  /** Characters of a tool result handed on (workflow, agent, MCP proxy). */
  resultChars: 100_000,
  tools: 200,
  schemaBytes: 16_000,
  description: 2000,
};

export type HttpFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean; secretHeaders?: string[] }) => Promise<SafeResponse>;

export type McpErrorCode = 'unauthorized' | 'http' | 'network' | 'timeout' | 'too_large' | 'private' | 'protocol' | 'rpc' | 'oauth';

export class McpError extends Error {
  constructor(
    message: string,
    public code: McpErrorCode,
    /** Status HyperLevel answers with. */
    public status = 502,
    public detail: { httpStatus?: number; wwwAuthenticate?: string; rpcCode?: number } = {},
  ) {
    super(message);
  }
}

export interface McpTarget {
  url: string;
  /** Authorization and other headers (bearer token, API key header). */
  headers: Record<string, string>;
  allowPrivate: boolean;
  transport: 'auto' | 'http' | 'sse';
  timeoutMs?: number;
  maxBytes?: number;
  /** Test hook / safeFetch. */
  fetch?: HttpFetch;
  /** Reuse a Streamable HTTP session (Mcp-Session-Id) from an earlier connect. */
  sessionId?: string;
  protocolVersion?: string;
}

export interface McpSession {
  transport: 'http' | 'sse';
  protocolVersion: string;
  sessionId: string;
  serverInfo: { name: string; version: string; title?: string };
  capabilities: Record<string, unknown>;
  instructions: string;
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

const netError = (e: unknown): McpError => {
  const m = (e as Error)?.message ?? '';
  if (/internen Netz/.test(m)) return new McpError('Die Adresse liegt in einem internen Netz und ist gesperrt (nur die Agentur kann „internes Netz“ erlauben).', 'private', 400);
  if (/zu groß/.test(m)) return new McpError(`Die Antwort des MCP-Servers ist zu groß (Limit ${Math.round(LIMITS.maxBytes / 1024 / 1024)} MB).`, 'too_large', 502);
  if (/Zeitüberschreitung|timeout/i.test(m)) return new McpError('Der MCP-Server hat nicht rechtzeitig geantwortet.', 'timeout', 504);
  if (/Ungültige URL|Nur http/.test(m)) return new McpError(m, 'protocol', 400);
  return new McpError(`Der MCP-Server ist nicht erreichbar${m ? ` (${m.slice(0, 120)})` : ''}.`, 'network', 504);
};

const header = (h: Record<string, unknown>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? '' : String(v);
};

// --- SSE parsing ---------------------------------------------------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Splits an event stream into events (data lines joined with \n). Incomplete trailing events are returned in `rest`. */
export function parseSse(text: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const b of blocks) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of b.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length) events.push({ event, data: data.join('\n'), id });
  }
  return { events, rest };
}

const parseMessages = (raw: string, type: string): any[] => {
  if (!raw.trim()) return [];
  if (type.includes('text/event-stream')) {
    const { events, rest } = parseSse(raw.endsWith('\n\n') ? raw : `${raw}\n\n`);
    void rest;
    return events
      .filter((e) => e.event === 'message')
      .flatMap((e) => {
        try {
          const m = JSON.parse(e.data);
          return Array.isArray(m) ? m : [m];
        } catch {
          return [];
        }
      });
  }
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new McpError('Der MCP-Server hat keine gültige JSON-RPC-Antwort geschickt.', 'protocol', 502);
  }
  return Array.isArray(m) ? m : [m];
};

const rpcResult = (msgs: any[], id: number, method: string) => {
  const m = msgs.find((x) => x && x.jsonrpc === '2.0' && x.id === id && ('result' in x || 'error' in x));
  if (!m) throw new McpError(`Der MCP-Server hat auf ${method} nicht geantwortet.`, 'protocol', 502);
  if (m.error) throw new McpError(`MCP-Server: ${stripControl(String(m.error.message ?? 'Fehler')).slice(0, 300)}`, 'rpc', 502, { rpcCode: Number(m.error.code) || 0 });
  return m.result;
};

const initParams = () => ({ protocolVersion: CLIENT_PROTOCOL, capabilities: {}, clientInfo: { name: 'gohigh', title: 'HyperLevel', version: APP_VERSION } });

const sessionInfo = (r: any) => ({
  protocolVersion: PROTOCOLS.includes(String(r?.protocolVersion)) ? String(r.protocolVersion) : CLIENT_PROTOCOL,
  serverInfo: { name: stripControl(String(r?.serverInfo?.name ?? '')).slice(0, 100), version: stripControl(String(r?.serverInfo?.version ?? '')).slice(0, 50), title: r?.serverInfo?.title ? stripControl(String(r.serverInfo.title)).slice(0, 100) : undefined },
  capabilities: r?.capabilities && typeof r.capabilities === 'object' ? r.capabilities : {},
  instructions: stripControl(String(r?.instructions ?? '')).slice(0, 2000),
});

// --- Streamable HTTP --------------------------------------------------------------------------------

async function httpSession(t: McpTarget): Promise<McpSession> {
  const fetcher: HttpFetch = t.fetch ?? safeFetch;
  let sessionId = t.sessionId ?? '';
  let protocol = t.protocolVersion ?? '';
  let nextId = 1;
  const post = async (msg: Record<string, unknown>) => {
    let r: SafeResponse;
    try {
      r = await fetcher(t.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...t.headers,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
        },
        body: JSON.stringify(msg),
        timeoutMs: t.timeoutMs ?? LIMITS.timeoutMs,
        maxBytes: t.maxBytes ?? LIMITS.maxBytes,
        allowPrivate: t.allowPrivate,
        // The target's headers are its credentials (bearer or a custom API-key header): never to another origin.
        secretHeaders: Object.keys(t.headers),
      });
    } catch (e) {
      throw netError(e);
    }
    const raw = await r.text();
    if (r.status === 401 || r.status === 403) {
      throw new McpError(r.status === 401 ? 'Der MCP-Server verlangt eine Anmeldung (Token fehlt, ist ungültig oder abgelaufen).' : 'Der MCP-Server verweigert den Zugriff (403).', 'unauthorized', 401, { httpStatus: r.status, wwwAuthenticate: header(r.headers, 'www-authenticate') });
    }
    if (r.status === 202) return [];
    if (!r.ok) throw new McpError(`Der MCP-Server antwortet ${r.status}${raw && raw.length < 300 ? `: ${stripControl(raw).slice(0, 200)}` : ''}.`, 'http', 502, { httpStatus: r.status });
    const sid = header(r.headers, 'mcp-session-id');
    if (sid && /^[\x21-\x7e]{1,200}$/.test(sid)) sessionId = sid;
    return parseMessages(raw, header(r.headers, 'content-type'));
  };
  const request = async (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    return rpcResult(await post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }), id, method);
  };

  let info: ReturnType<typeof sessionInfo>;
  if (t.sessionId && t.protocolVersion) {
    info = { protocolVersion: t.protocolVersion, serverInfo: { name: '', version: '', title: undefined }, capabilities: {}, instructions: '' };
  } else {
    const r = await request('initialize', initParams());
    info = sessionInfo(r);
    protocol = info.protocolVersion;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => []);
  }
  return {
    transport: 'http',
    ...info,
    get sessionId() {
      return sessionId;
    },
    request,
    async close() {
      if (!sessionId) return;
      try {
        await fetcher(t.url, { method: 'DELETE', headers: { ...t.headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': protocol }, timeoutMs: 5_000, maxBytes: 64 * 1024, allowPrivate: t.allowPrivate, secretHeaders: Object.keys(t.headers) });
      } catch {
        /* the server may not support explicit termination */
      }
    },
  };
}

// --- HTTP+SSE (2024-11-05) ------------------------------------------------------------------------------

interface Stream {
  close(): void;
}

/** A long-lived GET with the SSRF guard (same rules as safeFetch), size and idle limits. */
function openStream(url: string, headers: Record<string, string>, o: { allowPrivate: boolean; timeoutMs: number; maxBytes: number }, onEvent: (e: SseEvent) => void, onEnd: (err: McpError | null) => void, onOpen: (res: IncomingMessage) => void): Stream {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new McpError('Ungültige URL', 'protocol', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new McpError('Nur http(s)-Adressen', 'protocol', 400);
  if (!o.allowPrivate && process.env.PGHL_ALLOW_PRIVATE_FETCH !== '1' && isPrivateIp(u.hostname)) throw netError(new Error('Ziel liegt in einem internen Netz und ist gesperrt'));
  let size = 0;
  let buf = '';
  let ended = false;
  const end = (err: McpError | null) => {
    if (ended) return;
    ended = true;
    onEnd(err);
  };
  const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
    u,
    { method: 'GET', headers: { 'user-agent': `HyperLevel/${APP_VERSION}`, accept: 'text/event-stream', 'cache-control': 'no-cache', ...headers }, lookup: safeLookup(o.allowPrivate) as any, timeout: o.timeoutMs },
    (res) => {
      onOpen(res);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        size += chunk.length;
        if (size > o.maxBytes) {
          req.destroy();
          return end(new McpError('Der SSE-Stream des MCP-Servers ist zu groß geworden.', 'too_large'));
        }
        const parsed = parseSse(buf + chunk);
        buf = parsed.rest;
        for (const e of parsed.events) onEvent(e);
      });
      res.on('end', () => end(null));
      res.on('error', (e) => end(netError(e)));
    },
  );
  req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
  req.on('error', (e) => end(netError(e)));
  req.end();
  return {
    close() {
      ended = true;
      req.destroy();
    },
  };
}

async function sseSession(t: McpTarget): Promise<McpSession> {
  const fetcher: HttpFetch = t.fetch ?? safeFetch;
  const timeoutMs = t.timeoutMs ?? LIMITS.timeoutMs;
  const waiters = new Map<number, (m: any) => void>();
  let endpoint = '';
  let closed: McpError | null = null;
  let onEndpoint: ((v: string) => void) | null = null;
  let onFail: ((e: McpError) => void) | null = null;
  const stream = openStream(
    t.url,
    t.headers,
    { allowPrivate: t.allowPrivate, timeoutMs: timeoutMs * 4, maxBytes: (t.maxBytes ?? LIMITS.maxBytes) * 4 },
    (e) => {
      if (e.event === 'endpoint') {
        let next: URL;
        try {
          next = new URL(e.data.trim(), t.url);
        } catch {
          return onFail?.(new McpError('Der MCP-Server hat eine ungültige Endpoint-Adresse geschickt.', 'protocol'));
        }
        // The message endpoint must stay on the server's origin (no redirect of tool calls elsewhere).
        if (next.origin !== new URL(t.url).origin) return onFail?.(new McpError('Der MCP-Server nennt einen Endpoint auf einem anderen Host – abgelehnt.', 'protocol'));
        endpoint = next.toString();
        onEndpoint?.(endpoint);
      } else if (e.event === 'message') {
        let m: any;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        for (const x of Array.isArray(m) ? m : [m]) if (x && typeof x.id === 'number' && waiters.has(x.id)) waiters.get(x.id)!(x);
      }
    },
    (err) => {
      closed = err ?? new McpError('Der MCP-Server hat den SSE-Stream beendet.', 'network');
      onFail?.(closed);
      for (const w of waiters.values()) w({ jsonrpc: '2.0', error: { message: closed.message } });
    },
    (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) onFail?.(new McpError('Der MCP-Server verlangt eine Anmeldung (Token fehlt, ist ungültig oder abgelaufen).', 'unauthorized', 401, { httpStatus: res.statusCode, wwwAuthenticate: header(res.headers, 'www-authenticate') }));
      else if ((res.statusCode ?? 0) >= 300) onFail?.(new McpError(`Der MCP-Server antwortet ${res.statusCode} auf den SSE-Aufbau.`, 'http', 502, { httpStatus: res.statusCode }));
      else if (!String(res.headers['content-type'] ?? '').includes('text/event-stream')) onFail?.(new McpError('Der MCP-Server liefert keinen SSE-Stream.', 'protocol'));
    },
  );
  try {
    await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpError('Der MCP-Server hat keinen SSE-Endpoint geschickt.', 'timeout', 504)), timeoutMs);
      onEndpoint = (v) => (clearTimeout(timer), resolve(v));
      onFail = (e) => (clearTimeout(timer), reject(e));
      if (endpoint) onEndpoint(endpoint);
    });
  } catch (e) {
    stream.close();
    throw e;
  }
  onFail = null;
  let nextId = 1;
  const send = async (msg: Record<string, unknown>) => {
    if (closed) throw closed;
    let r: SafeResponse;
    try {
      r = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...t.headers }, body: JSON.stringify(msg), timeoutMs, maxBytes: t.maxBytes ?? LIMITS.maxBytes, allowPrivate: t.allowPrivate, secretHeaders: Object.keys(t.headers) });
    } catch (e) {
      throw netError(e);
    }
    const raw = await r.text();
    if (r.status === 401 || r.status === 403) throw new McpError('Der MCP-Server verlangt eine Anmeldung.', 'unauthorized', 401, { httpStatus: r.status, wwwAuthenticate: header(r.headers, 'www-authenticate') });
    if (!r.ok) throw new McpError(`Der MCP-Server antwortet ${r.status}.`, 'http', 502, { httpStatus: r.status });
    return raw;
  };
  const request = async (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    const answer = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => (waiters.delete(id), reject(new McpError(`Der MCP-Server hat auf ${method} nicht rechtzeitig geantwortet.`, 'timeout', 504))), timeoutMs);
      waiters.set(id, (m) => (clearTimeout(timer), waiters.delete(id), resolve(m)));
    });
    try {
      const raw = await send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      // Some servers answer inline instead of on the stream.
      if (raw.trim().startsWith('{')) {
        try {
          const m = JSON.parse(raw);
          if (m?.id === id) waiters.get(id)?.(m);
        } catch {
          /* not JSON – wait for the stream */
        }
      }
    } catch (e) {
      waiters.delete(id);
      throw e;
    }
    return rpcResult([await answer], id, method);
  };
  try {
    const r = await request('initialize', { ...initParams(), protocolVersion: '2024-11-05' });
    const info = sessionInfo(r);
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => '');
    return { transport: 'sse', ...info, sessionId: '', request, close: async () => stream.close() };
  } catch (e) {
    stream.close();
    throw e;
  }
}

/** Opens a session: Streamable HTTP first; on 400/404/405 (or `transport: 'sse'`) the older HTTP+SSE transport. */
export async function connectMcp(t: McpTarget): Promise<McpSession> {
  if (t.transport === 'sse') return sseSession(t);
  try {
    return await httpSession(t);
  } catch (e) {
    if (t.transport === 'auto' && e instanceof McpError && e.code === 'http' && [400, 404, 405].includes(e.detail.httpStatus ?? 0)) {
      try {
        return await sseSession(t);
      } catch {
        throw e;
      }
    }
    throw e;
  }
}

// --- tools --------------------------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input_schema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Hash of name, description and schema – a change ("rug pull") disables the tool until it is approved again. */
  hash: string;
}

export const TOOL_NAME_RE = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** tools/list entries → definitions HyperLevel stores; odd names, huge schemas and control characters are dropped. */
export function cleanToolDefs(raw: unknown): ToolDef[] {
  const out: ToolDef[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (out.length >= LIMITS.tools) break;
    const name = String(t?.name ?? '');
    if (!TOOL_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    let schema: Record<string, unknown> = t?.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? t.inputSchema : { type: 'object', properties: {} };
    if (JSON.stringify(schema).length > LIMITS.schemaBytes) schema = { type: 'object', properties: {}, additionalProperties: true, description: 'Schema zu groß – Eingaben als JSON' };
    if (schema.type !== 'object') schema = { ...schema, type: 'object' };
    const description = stripControl(String(t?.description ?? '')).slice(0, LIMITS.description);
    const title = stripControl(String(t?.title ?? t?.annotations?.title ?? '')).slice(0, 120);
    const a = t?.annotations ?? {};
    const annotations: ToolDef['annotations'] = {};
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) if (typeof a[k] === 'boolean') annotations[k] = a[k];
    const hash = createHash('sha256').update(JSON.stringify([name, description, schema])).digest('hex').slice(0, 16);
    out.push({ name, title, description, input_schema: schema, annotations, hash });
  }
  return out;
}

/** tools/list with pagination (at most 10 pages / LIMITS.tools tools). */
export async function listTools(s: McpSession): Promise<ToolDef[]> {
  const all: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await s.request('tools/list', cursor ? { cursor } : undefined);
    all.push(...(Array.isArray(r?.tools) ? r.tools : []));
    cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
    if (!cursor || all.length >= LIMITS.tools) break;
  }
  return cleanToolDefs(all);
}

export interface CallResult {
  /** Text of all content parts, cut to LIMITS.resultChars. */
  text: string;
  is_error: boolean;
  structured?: unknown;
  truncated: boolean;
  parts: number;
}

/** A tools/call result → text + structured content, size-limited; images and binary resources are only named. */
export function cleanCallResult(r: any, max = LIMITS.resultChars): CallResult {
  const parts: string[] = [];
  const content = Array.isArray(r?.content) ? r.content.slice(0, 100) : [];
  for (const c of content) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''));
    else if (c?.type === 'image' || c?.type === 'audio') parts.push(`[${c.type === 'image' ? 'Bild' : 'Audio'} ${String(c.mimeType ?? '').slice(0, 40)} – nicht übernommen]`);
    else if (c?.type === 'resource') parts.push(typeof c.resource?.text === 'string' ? c.resource.text : `[Ressource ${String(c.resource?.uri ?? '').slice(0, 200)}]`);
    else if (c?.type === 'resource_link') parts.push(`[Link ${String(c.uri ?? '').slice(0, 300)}]`);
  }
  let text = stripControl(parts.join('\n\n'));
  let truncated = false;
  if (text.length > max) {
    text = text.slice(0, max);
    truncated = true;
  }
  let structured: unknown;
  if (r?.structuredContent && typeof r.structuredContent === 'object') {
    const s = JSON.stringify(r.structuredContent);
    if (s.length <= max) structured = r.structuredContent;
    else truncated = true;
  }
  return { text, is_error: r?.isError === true, structured, truncated, parts: content.length };
}

export async function callTool(s: McpSession, name: string, args: Record<string, unknown>): Promise<CallResult> {
  return cleanCallResult(await s.request('tools/call', { name, arguments: args }));
}

// --- names ----------------------------------------------------------------------------------------------

/** Short server slug for tool prefixes: lowercase letters, digits and _ (max 20). */
export function serverSlug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20)
    .replace(/_+$/, '');
  return s || 'server';
}

/** `ext_<server>_<tool>` within 64 characters of [A-Za-z0-9_-] (a short hash keeps long names unique). */
export function exposedName(slug: string, tool: string): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  const full = `ext_${slug}_${clean}`;
  if (full.length <= 64 && clean === tool) return full;
  const h = createHash('sha256').update(tool).digest('hex').slice(0, 6);
  return `ext_${slug}_${clean}`.slice(0, 57) + `_${h}`;
}

// --- OAuth 2.1 client --------------------------------------------------------------------------------------

/** `WWW-Authenticate: Bearer resource_metadata="…", scope="…", error="…"` → parameters (lower-case keys). */
export function parseWwwAuthenticate(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const s = String(h ?? '').replace(/^\s*Bearer\s*/i, '');
  for (const m of s.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

export interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export interface OAuthDiscovery {
  /** RFC 8707 resource indicator (the MCP server's canonical URL). */
  resource: string;
  resource_metadata_url: string;
  scopes: string[];
  as: AuthServerMeta;
}

/** Canonical MCP server URI for `resource`: lower-case scheme/host, no fragment/query, no trailing slash. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

const getJson = async (url: string, fetcher: HttpFetch, allowPrivate: boolean): Promise<{ status: number; data: any }> => {
  let r: SafeResponse;
  try {
    r = await fetcher(url, { method: 'GET', headers: { accept: 'application/json', 'mcp-protocol-version': CLIENT_PROTOCOL }, timeoutMs: 10_000, maxBytes: 256 * 1024, allowPrivate });
  } catch (e) {
    throw netError(e);
  }
  const raw = await r.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  return { status: r.status, data };
};

const endpointOk = (v: unknown, allowPrivate: boolean) => {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || (allowPrivate && u.protocol === 'http:');
  } catch {
    return false;
  }
};

/**
 * Discovery: protected-resource metadata (from the 401's `resource_metadata` or the well-known paths),
 * then the authorization server's metadata (RFC 8414, then OpenID Connect). Servers that predate RFC 9728
 * (2025-03-26) fall back to the MCP server's origin as authorization server with default endpoints.
 */
export async function discoverOAuth(serverUrl: string, wwwAuthenticate: string | undefined, fetcher: HttpFetch, allowPrivate: boolean): Promise<OAuthDiscovery> {
  const su = new URL(serverUrl);
  const params = parseWwwAuthenticate(wwwAuthenticate);
  const path = su.pathname.replace(/\/+$/, '');
  const candidates = [params.resource_metadata, path && path !== '/' ? `${su.origin}/.well-known/oauth-protected-resource${path}` : '', `${su.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  let prm: any = null;
  let prmUrl = '';
  for (const c of candidates) {
    let u: URL;
    try {
      u = new URL(c, serverUrl);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) continue;
    const r = await getJson(u.toString(), fetcher, allowPrivate);
    if (r.status === 200 && r.data && Array.isArray(r.data.authorization_servers)) {
      prm = r.data;
      prmUrl = u.toString();
      break;
    }
  }
  const resource = canonicalResource(serverUrl);
  if (prm?.resource) {
    let ok = false;
    try {
      ok = new URL(String(prm.resource)).origin === su.origin;
    } catch {
      ok = false;
    }
    if (!ok) throw new McpError('Die OAuth-Metadaten des MCP-Servers gehören zu einer anderen Adresse – abgelehnt.', 'oauth', 400);
  }
  const issuer = String(prm?.authorization_servers?.[0] ?? su.origin).replace(/\/+$/, '');
  let iu: URL;
  try {
    iu = new URL(issuer);
  } catch {
    throw new McpError('Ungültige Adresse des Autorisierungs-Servers.', 'oauth', 400);
  }
  const ipath = iu.pathname.replace(/\/+$/, '');
  const asCandidates = ipath
    ? [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`, `${iu.origin}${ipath}/.well-known/openid-configuration`]
    : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
  let meta: any = null;
  for (const c of asCandidates) {
    const r = await getJson(c, fetcher, allowPrivate);
    if (r.status === 200 && r.data?.authorization_endpoint && r.data?.token_endpoint) {
      meta = r.data;
      break;
    }
  }
  if (!meta) {
    if (prm) throw new McpError('Der Autorisierungs-Server veröffentlicht keine Metadaten (/.well-known/oauth-authorization-server).', 'oauth', 502);
    meta = { issuer: iu.origin, authorization_endpoint: `${iu.origin}/authorize`, token_endpoint: `${iu.origin}/token`, registration_endpoint: `${iu.origin}/register` };
  }
  if (!endpointOk(meta.authorization_endpoint, allowPrivate) || !endpointOk(meta.token_endpoint, allowPrivate)) throw new McpError('Die OAuth-Endpunkte des Servers sind keine https-Adressen.', 'oauth', 400);
  if (meta.registration_endpoint && !endpointOk(meta.registration_endpoint, allowPrivate)) delete meta.registration_endpoint;
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported.map(String) : undefined;
  if (methods && !methods.includes('S256')) throw new McpError('Der Autorisierungs-Server unterstützt kein PKCE mit S256 – abgelehnt.', 'oauth', 400);
  const scopes = params.scope ? params.scope.split(/\s+/).filter(Boolean) : Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.map(String) : [];
  return {
    resource,
    resource_metadata_url: prmUrl,
    scopes: scopes.slice(0, 30),
    as: {
      issuer: String(meta.issuer ?? iu.origin),
      authorization_endpoint: String(meta.authorization_endpoint),
      token_endpoint: String(meta.token_endpoint),
      ...(meta.registration_endpoint ? { registration_endpoint: String(meta.registration_endpoint) } : {}),
      ...(Array.isArray(meta.scopes_supported) ? { scopes_supported: meta.scopes_supported.map(String).slice(0, 50) } : {}),
      ...(methods ? { code_challenge_methods_supported: methods } : {}),
      ...(Array.isArray(meta.token_endpoint_auth_methods_supported) ? { token_endpoint_auth_methods_supported: meta.token_endpoint_auth_methods_supported.map(String) } : {}),
    },
  };
}

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
}

/** RFC 7591 dynamic client registration (public client with PKCE unless the server hands out a secret). */
export async function registerClient(as: AuthServerMeta, o: { redirectUri: string; clientName: string; scope?: string }, fetcher: HttpFetch, allowPrivate: boolean): Promise<OAuthClient> {
  if (!as.registration_endpoint) throw new McpError('Der Server erlaubt keine automatische Registrierung – Client-ID und Secret von Hand eintragen.', 'oauth', 409);
  let r: SafeResponse;
  try {
    r = await fetcher(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: o.clientName.slice(0, 100),
        redirect_uris: [o.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(o.scope ? { scope: o.scope } : {}),
      }),
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
      allowPrivate,
    });
  } catch (e) {
    throw netError(e);
  }
  const raw = await r.text();
  let d: any = null;
  try {
    d = JSON.parse(raw);
  } catch {
    d = null;
  }
  if (!r.ok || !d?.client_id) throw new McpError(`Registrierung beim Autorisierungs-Server fehlgeschlagen (${r.status})${d?.error_description ? `: ${stripControl(String(d.error_description)).slice(0, 200)}` : ''}.`, 'oauth', 502);
  const secret = typeof d.client_secret === 'string' && d.client_secret ? d.client_secret : undefined;
  const method = String(d.token_endpoint_auth_method ?? (secret ? 'client_secret_basic' : 'none'));
  return { client_id: String(d.client_id), ...(secret ? { client_secret: secret } : {}), auth_method: method === 'client_secret_post' ? 'client_secret_post' : secret ? 'client_secret_basic' : 'none' };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(as: AuthServerMeta, p: { clientId: string; redirectUri: string; state: string; challenge: string; scope?: string; resource: string }): string {
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', p.resource);
  if (p.scope) u.searchParams.set('scope', p.scope);
  return u.toString();
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** ISO time or '' when the server sent no lifetime. */
  expires_at: string;
  scope: string;
  token_type: string;
}

/** Token endpoint call (authorization_code or refresh_token) with the client's auth method. */
export async function tokenRequest(as: AuthServerMeta, client: OAuthClient, params: Record<string, string>, fetcher: HttpFetch, allowPrivate: boolean): Promise<TokenSet> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.auth_method === 'client_secret_basic' && client.client_secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
  else {
    body.set('client_id', client.client_id);
    if (client.auth_method === 'client_secret_post' && client.client_secret) body.set('client_secret', client.client_secret);
  }
  let r: SafeResponse;
  try {
    r = await fetcher(as.token_endpoint, { method: 'POST', headers, body: body.toString(), timeoutMs: 15_000, maxBytes: 64 * 1024, allowPrivate });
  } catch (e) {
    throw netError(e);
  }
  const raw = await r.text();
  let d: any = null;
  try {
    d = JSON.parse(raw);
  } catch {
    d = Object.fromEntries(new URLSearchParams(raw));
  }
  if (!r.ok || !d?.access_token) {
    const why = String(d?.error ?? '');
    throw new McpError(`Token-Abruf fehlgeschlagen (${r.status}${why ? ` ${stripControl(why).slice(0, 60)}` : ''})${d?.error_description ? `: ${stripControl(String(d.error_description)).slice(0, 200)}` : ''}.`, 'oauth', why === 'invalid_grant' ? 401 : 502);
  }
  const exp = Number(d.expires_in);
  return {
    access_token: String(d.access_token),
    ...(d.refresh_token ? { refresh_token: String(d.refresh_token) } : {}),
    expires_at: Number.isFinite(exp) && exp > 0 ? new Date(Date.now() + exp * 1000).toISOString() : '',
    scope: String(d.scope ?? ''),
    token_type: String(d.token_type ?? 'Bearer'),
  };
}

// --- URL ------------------------------------------------------------------------------------------------

/** MCP server URL: http(s), no credentials or fragment, max 2000 characters. */
export function cleanServerUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 2000) throw new Error('Adresse fehlt oder ist zu lang');
  if (/[<>]/.test(s)) throw new Error('Die Adresse enthält noch Platzhalter wie <zone> – bitte ersetzen.');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Adresse ungültig (z. B. https://mcp.example.com/mcp)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Nur http(s)-Adressen');
  if (u.username || u.password) throw new Error('Zugangsdaten gehören nicht in die Adresse – als Token eintragen');
  if (u.hash) throw new Error('Adresse ohne #');
  return u.toString();
}

/** What the UI shows: origin + path with long token-like segments masked (URLs like Zapier's may carry a key). */
export function urlHint(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (seg.length >= 20 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) ? `${seg.slice(0, 3)}…` : seg))
      .join('/');
    return `${u.origin}${path}${u.search ? '?…' : ''}`;
  } catch {
    return '';
  }
}
