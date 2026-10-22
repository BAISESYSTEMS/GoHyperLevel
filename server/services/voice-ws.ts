import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A minimal RFC 6455 WebSocket server endpoint (no npm package): handshake, frame parser and writer.
 * Used for Twilio Media Streams, which connects *to us*. Text and binary messages (also fragmented),
 * ping/pong, close handshake, payload limit, masking checks and an idle timeout. No extensions
 * (no compression), no sub-protocols.
 *
 * Wire-up: modules push a handler into `app.services.upgradeHandlers`; core/app.ts calls them for
 * every HTTP upgrade request and destroys the socket when none of them takes it.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** What the session logic needs from a socket – real connections and test fakes implement it. */
export interface WsLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

export const acceptKey = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

/** Encodes one unfragmented server frame (servers never mask). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Incremental frame decoder for client→server data; throws `WsProtocolError` for what a client must never send. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxPayload = 1024 * 1024) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = !!(b[0] & 0x80);
      if (b[0] & 0x70) throw new WsProtocolError(1002, 'Reservierte Bits');
      const opcode = b[0] & 0x0f;
      const masked = !!(b[1] & 0x80);
      if (!masked) throw new WsProtocolError(1002, 'Client-Frames müssen maskiert sein');
      let len = b[1] & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        pos = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new WsProtocolError(1009, 'Nachricht zu groß');
        len = Number(big);
        pos = 10;
      }
      if (len > this.maxPayload) throw new WsProtocolError(1009, 'Nachricht zu groß');
      const isControl = opcode >= 0x8;
      if (isControl && (!fin || len > 125)) throw new WsProtocolError(1002, 'Ungültiger Steuer-Frame');
      if (![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) throw new WsProtocolError(1002, 'Unbekannter Opcode');
      if (b.length < pos + 4 + len) break;
      const mask = b.subarray(pos, pos + 4);
      const payload = Buffer.from(b.subarray(pos + 4, pos + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      out.push({ fin, opcode, payload });
      this.buf = b.subarray(pos + 4 + len);
    }
    return out;
  }
}

export class WsProtocolError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerWsEvents {
  message: (data: string | Buffer, isBinary: boolean) => void;
  close: (code: number) => void;
  error: (e: Error) => void;
}

/** One accepted connection. */
export class ServerWs implements WsLike {
  private parser: FrameParser;
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closed = false;
  private closeSent = false;
  private readonly handlers: { [K in keyof ServerWsEvents]?: ServerWsEvents[K][] } = {};

  constructor(
    private readonly socket: Duplex,
    private readonly opts: { maxPayload?: number; idleMs?: number } = {},
  ) {
    this.parser = new FrameParser(opts.maxPayload ?? 1024 * 1024);
    socket.on('data', (c: Buffer) => this.onData(c));
    socket.on('close', () => this.finish(1006));
    socket.on('error', (e) => {
      this.emit('error', e);
      this.finish(1006);
    });
    (socket as any).setTimeout?.(opts.idleMs ?? 60_000, () => this.close(1001, 'Zeitüberschreitung'));
    (socket as any).setNoDelay?.(true);
  }

  get open() {
    return !this.closed && !this.closeSent;
  }
  /** Bytes queued in the socket (backpressure indicator). */
  get buffered(): number {
    return (this.socket as any).writableLength ?? 0;
  }

  on<K extends keyof ServerWsEvents>(event: K, fn: ServerWsEvents[K]) {
    (this.handlers[event] ??= [] as any).push(fn);
    return this;
  }
  private emit<K extends keyof ServerWsEvents>(event: K, ...args: Parameters<ServerWsEvents[K]>) {
    for (const fn of this.handlers[event] ?? []) {
      try {
        (fn as any)(...args);
      } catch (e) {
        console.error('[voice-ws]', (e as Error).message);
      }
    }
  }

  send(data: string | Uint8Array) {
    if (!this.open) return;
    const isText = typeof data === 'string';
    this.write(encodeFrame(isText ? 0x1 : 0x2, isText ? Buffer.from(data) : Buffer.from(data)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent) {
      this.closeSent = true;
      const r = Buffer.from(reason).subarray(0, 120);
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      this.write(encodeFrame(0x8, p));
    }
    // A well-behaved peer answers with its own close frame; do not wait forever for it.
    const t = setTimeout(() => this.socket.destroy(), 2000);
    t.unref?.();
  }

  private write(buf: Buffer) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(buf);
  }

  private fail(e: WsProtocolError) {
    this.close(e.code, e.message);
    setTimeout(() => this.socket.destroy(), 200).unref?.();
  }

  private onData(chunk: Buffer) {
    let frames: Frame[];
    try {
      frames = this.parser.push(chunk);
    } catch (e) {
      return this.fail(e instanceof WsProtocolError ? e : new WsProtocolError(1002, 'Protokollfehler'));
    }
    for (const f of frames) {
      if (f.opcode === 0x9) this.write(encodeFrame(0xa, f.payload));
      else if (f.opcode === 0xa) continue;
      else if (f.opcode === 0x8) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        if (!this.closeSent) {
          this.closeSent = true;
          this.write(encodeFrame(0x8, f.payload.subarray(0, 2)));
        }
        this.socket.end();
        this.finish(code);
        return;
      } else {
        if (f.opcode === 0x0) {
          if (!this.fragmentOpcode) return this.fail(new WsProtocolError(1002, 'Unerwartete Fortsetzung'));
        } else {
          if (this.fragmentOpcode) return this.fail(new WsProtocolError(1002, 'Neue Nachricht in einer unvollständigen'));
          this.fragmentOpcode = f.opcode;
        }
        this.fragments.push(f.payload);
        this.fragmentBytes += f.payload.length;
        if (this.fragmentBytes > (this.opts.maxPayload ?? 1024 * 1024)) return this.fail(new WsProtocolError(1009, 'Nachricht zu groß'));
        if (f.fin) {
          const data = Buffer.concat(this.fragments);
          const binary = this.fragmentOpcode === 0x2;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = 0;
          this.emit('message', binary ? data : data.toString('utf8'), binary);
        }
      }
    }
  }

  private finish(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
}

/**
 * Completes the handshake for an upgrade request. Returns null (after answering with an HTTP error and
 * destroying the socket) when the request is not a valid WebSocket upgrade.
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, opts: { maxPayload?: number; idleMs?: number } = {}): ServerWs | null {
  const key = String(req.headers['sec-websocket-key'] ?? '');
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (req.method !== 'GET' || upgrade !== 'websocket' || version !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    refuse(socket, 400, 'Bad Request');
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const ws = new ServerWs(socket, opts);
  // Bytes that arrived together with the handshake.
  if (head?.length) setImmediate(() => (ws as any).onData(head));
  return ws;
}

export function refuse(socket: Duplex, status: number, text: string) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

/** Browser-style client socket (the global WebSocket of Node 22; tests pass a fake with the same shape). */
export interface WsClientLike {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}
export type WsClientFactory = (url: string, protocols?: string[]) => WsClientLike;

export const defaultWsClient: WsClientFactory = (url, protocols) => new (globalThis as any).WebSocket(url, protocols) as WsClientLike;
