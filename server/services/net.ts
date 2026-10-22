import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { APP_VERSION } from '../version.js';

/**
 * Outbound HTTP for user-supplied URLs (webhooks, workflow calls, uptime checks). Refuses private,
 * loopback and cloud-metadata addresses – checked on the resolved IP the socket actually connects
 * to, so DNS rebinding can't sneak past – and follows at most three redirects, each checked again.
 */

/** Private, loopback, link-local, carrier-grade NAT, documentation, multicast and transition ranges. */
const BLOCKED = new BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) BLOCKED.addSubnet(a, p, 'ipv4');
// IPv4-mapped addresses (::ffff:7f00:1, any spelling) are matched against the IPv4 rules by BlockList itself.
for (const [a, p] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(a, p, 'ipv6');

export function isPrivateIp(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '');
  const type = isIP(v);
  if (!type) return false;
  return BLOCKED.check(v, type === 4 ? 'ipv4' : 'ipv6');
}

const allowPrivate = () => process.env.PGHL_ALLOW_PRIVATE_FETCH === '1';

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * DNS lookup for sockets that refuses private targets. `allowInternal` is a per-call opt-in (an agency
 * admin ticked "internes Netz" for that target, e.g. an MCP server on the LAN); streaming clients that
 * can't use safeFetch pass `safeLookup(...)` as `lookup` to node:http(s).
 */
export const safeLookup = (allowInternal = false) => (hostname: string, options: any, cb: LookupCb) => guardedLookup(hostname, options, cb, allowInternal);

function guardedLookup(hostname: string, options: any, cb: LookupCb, allowInternal = false) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '');
    const list = (addresses as unknown as LookupAddress[]) ?? [];
    if (!allowInternal && !allowPrivate() && list.some((a) => isPrivateIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error('Ziel liegt in einem internen Netz und ist gesperrt');
      e.code = 'EPRIVATE';
      return cb(e, '');
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0]?.address ?? '', list[0]?.family);
  });
}

export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string | string[] | undefined>;
  text(): Promise<string>;
}

export async function safeFetch(
  url: string,
  /** `allowPrivate`: per-call opt-in for internal targets (only where an agency admin explicitly allowed it). */
  /** `body`: text, or a Buffer for binary uploads (multipart files). */
  init: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; maxBytes?: number; allowPrivate?: boolean; secretHeaders?: string[] } = {},
  redirects = 3,
): Promise<SafeResponse> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Ungültige URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur http(s)-Adressen');
  if (!init.allowPrivate && !allowPrivate() && isPrivateIp(u.hostname)) throw new Error('Ziel liegt in einem internen Netz und ist gesperrt');
  const maxBytes = init.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = init.timeoutMs ?? 10_000;
  const res = await new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
    // `timeout` below only notices an idle socket; this also ends a server that drips bytes forever.
    const deadline = setTimeout(() => req.destroy(new Error('Zeitüberschreitung')), timeoutMs + 5_000);
    deadline.unref();
    const done = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(deadline);
      fn(v);
    };
    resolve = done(resolve);
    reject = done(reject);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      { method: init.method ?? 'GET', headers: { 'user-agent': `HyperLevel/${APP_VERSION}`, ...(init.headers ?? {}) }, lookup: (init.allowPrivate ? safeLookup(true) : guardedLookup) as any, timeout: timeoutMs },
      (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error('Antwort zu groß'));
            return;
          }
          chunks.push(c);
        });
        r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }));
        r.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
  if (res.status >= 300 && res.status < 400 && res.headers.location && redirects > 0) {
    const nextUrl = new URL(String(res.headers.location), u);
    const method = res.status === 307 || res.status === 308 ? init.method : 'GET';
    // Credentials never follow a redirect to another origin.
    // `secretHeaders`: further credential headers of the caller (e.g. an API-key header named by the user).
    const secret = new Set((init.secretHeaders ?? []).map((h) => h.toLowerCase()));
    const headers = nextUrl.origin === u.origin ? init.headers : Object.fromEntries(Object.entries(init.headers ?? {}).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k) && !secret.has(k.toLowerCase())));
    return safeFetch(nextUrl.toString(), { ...init, headers, method, body: method === 'GET' ? undefined : init.body }, redirects - 1);
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text: async () => res.body.toString('utf8') };
}
