import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * MCP revision 2026-07-28 ("modern", stateless) next to the legacy initialize handshake (docs/api.md → MCP):
 * per-request `_meta` (protocol version, client capabilities), `resultType` on every result, `server/discover`,
 * multi round-trip requests (`input_required` with `inputRequests` / `requestState`) for confirmations, and the
 * extensions Skills, Tasks and File Uploads. Pure helpers – the endpoint lives in modules/mcp.ts.
 */

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  caps: 'io.modelcontextprotocol/clientCapabilities',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;
export const EXT = {
  skills: 'io.modelcontextprotocol/skills',
  tasks: 'io.modelcontextprotocol/tasks',
  files: 'io.modelcontextprotocol/files',
} as const;

/** Error codes of the reserved MCP range. */
export const ERR = { headerMismatch: -32020, missingCapability: -32021, unsupportedVersion: -32022 } as const;

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export interface RequestMeta {
  /** The protocol version from `_meta` (modern request), or null (legacy/handshake-based client). */
  version: string | null;
  caps: Json;
}

export function requestMeta(params: unknown): RequestMeta {
  const meta = isObj(params) && isObj(params._meta) ? params._meta : {};
  const v = meta[META.version];
  return { version: typeof v === 'string' && v ? v : null, caps: isObj(meta[META.caps]) ? meta[META.caps] : {} };
}

/** What a modern request says the client can do (a legacy request: nothing of this). */
export function clientCan(m: RequestMeta) {
  if (!m.version) return { elicitForm: false, elicitUrl: false, tasks: false, upload: false, download: false };
  const e = m.caps.elicitation;
  const elicit = isObj(e) ? e : null;
  const ext = isObj(m.caps.extensions) ? m.caps.extensions : {};
  const files = isObj(ext[EXT.files]) && !('revision' in ext[EXT.files]) ? ext[EXT.files] : {};
  return {
    // {} = form only (backwards compatible)
    elicitForm: !!elicit && (Object.keys(elicit).length === 0 || isObj(elicit.form)),
    elicitUrl: !!elicit && isObj(elicit.url),
    tasks: isObj(ext[EXT.tasks]),
    upload: isObj(files.upload),
    download: isObj(files.download),
  };
}

/** `Mcp-Name: =?base64?…?=` → the decoded value. */
export function decodeHeader(v: string): string {
  const m = v.match(/^=\?base64\?(.*)\?=$/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/**
 * Header checks of the Streamable HTTP binding for a modern request: MCP-Protocol-Version, Mcp-Method and Mcp-Name must match
 * the body when they are sent. Returns the problem, or null. (Missing headers are tolerated: the body is authoritative here.)
 */
export function headerProblem(headers: Record<string, unknown>, msg: Json, version: string): string | null {
  const h = (k: string) => (typeof headers[k] === 'string' ? (headers[k] as string) : undefined);
  const pv = h('mcp-protocol-version');
  if (pv !== undefined && pv !== version) return `MCP-Protocol-Version „${pv.slice(0, 40)}“ passt nicht zu _meta (${version})`;
  const method = h('mcp-method');
  if (method !== undefined && method !== msg.method) return `Mcp-Method „${method.slice(0, 60)}“ passt nicht zur Methode im Body`;
  const name = h('mcp-name');
  const bodyName = msg.params?.name ?? msg.params?.uri;
  if (name !== undefined && bodyName !== undefined && decodeHeader(name) !== String(bodyName)) return 'Mcp-Name passt nicht zum Body';
  return null;
}

/** JSON with sorted keys: two argument objects compare equal regardless of member order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const argsDigest = (tool: string, args: unknown) => createHash('sha256').update(`${tool}\n${canonical(args)}`).digest('base64url');

/**
 * requestState for multi round-trip requests: integrity-protected (HMAC), bound to the principal, the tool and its arguments,
 * with a short expiry – a client can echo it but not change or reuse it for another call or user.
 */
export function sealState(secret: string, payload: { p: string; t: string; d: string; k: string }, ttlMs = 10 * 60_000): string {
  const body = Buffer.from(JSON.stringify({ ...payload, e: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${createHmac('sha256', `mcp-state:${secret}`).update(body).digest('base64url')}`;
}
export function openState(secret: string, state: unknown): { p: string; t: string; d: string; k: string; e: number } | null {
  if (typeof state !== 'string' || state.length > 4000) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', `mcp-state:${secret}`).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return typeof p?.e === 'number' && p.e > Date.now() ? p : null;
  } catch {
    return null;
  }
}

// --- confirmations (elicitation, form mode) -------------------------------------------------------------------------------

/** Tools where typing a word is asked for, not just a tick: deleting, erasing, merging. */
const HARD = /(^|_)(delete|erase|remove|merge|cancel|revoke|refund)(_|$)/;
export const CONFIRM_WORD = 'LÖSCHEN';
export const needsWord = (tool: string) => HARD.test(tool.replace(/^ghl_/, ''));

/** A short, readable summary of the arguments for the confirmation text (no long texts, no secrets). */
export function argSummary(args: Json): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === undefined || v === null || v === '' || /key|token|secret|password/i.test(k)) continue;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length > 80) s = `${s.slice(0, 77)}…`;
    parts.push(`${k}: ${s}`);
    if (parts.length >= 6) break;
  }
  return parts.join(' · ');
}

export function confirmRequest(tool: { name: string; title: string }, args: Json) {
  const word = needsWord(tool.name);
  const summary = argSummary(args);
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: `HyperLevel: „${tool.title}“ ausführen?${summary ? ` (${summary})` : ''} Das wirkt sofort${word ? ' und lässt sich nicht einfach rückgängig machen' : ''}.`,
      requestedSchema: word
        ? { type: 'object', properties: { confirm: { type: 'string', title: `Zum Bestätigen ${CONFIRM_WORD} eintippen`, minLength: 1, maxLength: 20 } }, required: ['confirm'] }
        : { type: 'object', properties: { confirm: { type: 'boolean', title: 'Ja, ausführen', default: false } }, required: ['confirm'] },
    },
  };
}

/** The user's answer to a confirmation: 'yes', 'no' (declined, cancelled or not confirmed) or 'missing' (no answer sent). */
export function confirmAnswer(tool: string, responses: unknown): 'yes' | 'no' | 'missing' {
  const r = isObj(responses) ? responses.confirm : undefined;
  if (!isObj(r)) return 'missing';
  if (r.action !== 'accept') return 'no';
  const v = isObj(r.content) ? r.content.confirm : undefined;
  if (needsWord(tool)) return typeof v === 'string' && v.trim().toUpperCase().replace(/OE/g, 'Ö') === CONFIRM_WORD ? 'yes' : 'no';
  return v === true ? 'yes' : 'no';
}

/** Results of a modern request always carry resultType (absent = "complete" for older clients, so harmless there). */
export const complete = <T extends Json>(r: T) => ({ resultType: 'complete', ...r });
