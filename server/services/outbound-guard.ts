import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

/**
 * Process-wide "nothing leaves this server" switch for demo mode.
 *
 * Every outgoing TCP connection in Node – fetch (undici), node:http/https, nodemailer (SMTP), imapflow
 * (IMAP), web push – ends up in net.Socket.prototype.connect (TLS sockets inherit it). While the guard
 * is installed, connections to anything but loopback or a unix socket are refused before DNS is even
 * asked: the socket is destroyed with an EDEMOBLOCKED error, which the caller sees as a normal network
 * failure, and the attempt is recorded. DNS lookups of outside names are refused the same way (some
 * clients, e.g. nodemailer, resolve before they connect), so not even a query leaves. The app's own
 * server (inbound requests) is not affected.
 */

export interface BlockedConnection {
  at: string;
  host: string;
  port: number | null;
}

interface GuardState {
  original: typeof net.Socket.prototype.connect;
  /** Replaced DNS functions: [owner object, name, original]. */
  dns: [Record<string, any>, string, any][];
  log: BlockedConnection[];
  onBlock?: (b: BlockedConnection) => void;
}

const MAX_LOG = 200;
let state: GuardState | null = null;

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '' || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\./.test(h);
}

/** Host/port/path a connect() call aims at – handles (options), (port, host), (path) and Node's normalized [options, cb]. */
function targetOf(args: unknown[]): { host?: string; port?: number; path?: string } {
  const a = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const first = a[0] as any;
  if (first && typeof first === 'object') {
    if (first.path) return { path: String(first.path) };
    return { host: first.host === undefined || first.host === null ? 'localhost' : String(first.host), port: first.port === undefined ? undefined : Number(first.port) };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { port: Number(first), host: typeof a[1] === 'string' ? a[1] : 'localhost' };
}

const DNS_CALLBACK_FNS = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt'];

function blockedError(entry: BlockedConnection): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`Demo-Modus: Verbindung nach außen gesperrt (${entry.host}${entry.port ? `:${entry.port}` : ''})`);
  err.code = 'EDEMOBLOCKED';
  return err;
}

export function installOutboundGuard(onBlock?: (b: BlockedConnection) => void): void {
  if (state) {
    if (onBlock) state.onBlock = onBlock;
    return;
  }
  const s: GuardState = { original: net.Socket.prototype.connect, dns: [], log: [], onBlock };
  const record = (host: string, port: number | null): BlockedConnection => {
    const entry: BlockedConnection = { at: new Date().toISOString(), host, port };
    s.log.push(entry);
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    try {
      s.onBlock?.(entry);
    } catch {
      /* logging must never break the caller */
    }
    return entry;
  };
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const t = targetOf(args);
    if (t.path || isLoopbackHost(t.host ?? '')) return (s.original as any).apply(this, args);
    const err = blockedError(record(String(t.host), Number.isFinite(t.port) ? (t.port as number) : null));
    process.nextTick(() => this.destroy(err));
    return this;
  } as typeof net.Socket.prototype.connect;
  // Callback DNS API (module functions and the Resolver class nodemailer uses) and the promise lookup.
  const wrapCallback = (owner: Record<string, any>, name: string) => {
    const orig = owner[name];
    if (typeof orig !== 'function') return;
    s.dns.push([owner, name, orig]);
    owner[name] = function guardedDns(this: unknown, host: unknown, ...rest: unknown[]) {
      const cb = rest[rest.length - 1];
      if (typeof host !== 'string' || isLoopbackHost(host) || net.isIP(host) || typeof cb !== 'function') return orig.call(this, host, ...rest);
      const err = blockedError(record(host, null));
      process.nextTick(() => (cb as (e: Error) => void)(err));
      return undefined;
    };
  };
  for (const name of DNS_CALLBACK_FNS) {
    wrapCallback(dns as unknown as Record<string, any>, name);
    if (name !== 'lookup') wrapCallback(dns.Resolver.prototype as unknown as Record<string, any>, name);
  }
  const promises = dns.promises as unknown as Record<string, any>;
  const origLookup = promises.lookup;
  s.dns.push([promises, 'lookup', origLookup]);
  promises.lookup = function guardedLookup(this: unknown, host: unknown, ...rest: unknown[]) {
    if (typeof host !== 'string' || isLoopbackHost(host) || net.isIP(host)) return origLookup.call(this, host, ...rest);
    return Promise.reject(blockedError(record(host, null)));
  };
  // The promise API's Resolver is a class of its own (node:dns/promises – the sending-domain check uses it).
  const promiseResolver = (promises.Resolver as { prototype?: Record<string, any> } | undefined)?.prototype;
  if (promiseResolver) {
    for (const name of DNS_CALLBACK_FNS) {
      const orig = promiseResolver[name];
      if (name === 'lookup' || typeof orig !== 'function') continue;
      s.dns.push([promiseResolver, name, orig]);
      promiseResolver[name] = function guardedResolve(this: unknown, host: unknown, ...rest: unknown[]) {
        if (typeof host !== 'string' || isLoopbackHost(host) || net.isIP(host)) return orig.call(this, host, ...rest);
        return Promise.reject(blockedError(record(host, null)));
      };
    }
  }
  // ESM named imports of node:dns follow the patched functions too.
  syncBuiltinESMExports();
  state = s;
}

/** Restores the original connect (tests; a running demo server keeps the guard for its whole life). */
export function uninstallOutboundGuard(): void {
  if (!state) return;
  net.Socket.prototype.connect = state.original;
  for (const [owner, name, orig] of state.dns.reverse()) owner[name] = orig;
  syncBuiltinESMExports();
  state = null;
}

export const outboundGuardActive = (): boolean => state !== null;

/** Recent refused connections, newest last. */
export const blockedConnections = (): BlockedConnection[] => [...(state?.log ?? [])];
