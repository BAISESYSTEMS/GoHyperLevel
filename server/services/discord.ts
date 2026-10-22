import { createPublicKey, verify } from 'node:crypto';
import type { FetchLike } from './channel-kit.js';

/**
 * Discord: REST calls, the Gateway connection that delivers messages (Discord has no message
 * webhooks for bots) and the signature check of the Interactions endpoint (slash command
 * /support). Pure building blocks; modules/discord.ts keeps accounts and contacts.
 */

export const DISCORD_API = 'https://discord.com/api/v10';
export const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
export const TEXT_LIMIT = 2000;
export const SNOWFLAKE = /^\d{15,22}$/;
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged: switch on under Bot in the Developer Portal). */
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
/** View Channels + Send Messages + Read Message History. */
export const BOT_PERMISSIONS = 1024 + 2048 + 65536;

export class DiscordError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export function discordErrorText(status: number, code: number, message: string): string {
  if (status === 401) return 'Bot-Token ungültig';
  if (code === 50007) return 'Kontakt nimmt keine Direktnachrichten vom Bot an (Datenschutz-Einstellung oder kein gemeinsamer Server)';
  if (code === 50001 || code === 50013) return 'Dem Bot fehlt die Berechtigung für diesen Kanal';
  if (code === 10003) return 'Kanal nicht gefunden';
  if (status === 429) return 'Zu viele Anfragen – Discord bittet um eine kurze Pause';
  return `Discord: ${message.slice(0, 200) || `Fehler ${status}`}`;
}

export async function discordCall<T = any>(fetcher: FetchLike, botToken: string, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  let r: Response;
  try {
    r = await fetcher(`${DISCORD_API}${path}`, {
      method,
      headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (https://github.com, 1.0) HyperLevel' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new DiscordError(0, 0, `Discord nicht erreichbar: ${(e as Error).message}`);
  }
  if (r.status === 204) return undefined as T;
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new DiscordError(r.status, Number(j?.code) || 0, discordErrorText(r.status, Number(j?.code) || 0, String(j?.message ?? '')));
  return j as T;
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** X-Signature-Ed25519 over timestamp + raw body with the application's public key (hex). */
export function verifyInteraction(raw: string | Buffer, signatureHex: string, timestamp: string, publicKeyHex: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex) || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSec - Number(timestamp)) > 300) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp), Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')]), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

export interface DiscordMedia {
  kind: 'image' | 'audio' | 'video' | 'document';
  url: string;
  mime?: string;
  filename?: string;
  size?: number;
}

export interface DiscordInbound {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  name: string;
  username: string;
  body: string;
  media: DiscordMedia | null;
  at: string;
}

const isCdn = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(x.hostname);
  } catch {
    return false;
  }
};
export const isDiscordCdn = isCdn;

/** A MESSAGE_CREATE payload → what we store; null for bots, webhooks, system messages and empty ones. */
export function parseMessage(d: any): DiscordInbound | null {
  if (!d || typeof d !== 'object' || !d.author) return null;
  if (d.author.bot || d.webhook_id || (d.type !== undefined && d.type !== 0 && d.type !== 19)) return null;
  const id = String(d.id ?? '');
  const channelId = String(d.channel_id ?? '');
  const authorId = String(d.author.id ?? '');
  if (!SNOWFLAKE.test(id) || !SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(authorId)) return null;
  const username = String(d.author.username ?? '').replace(/[^\w.]/g, '').slice(0, 64);
  const name = String(d.member?.nick || d.author.global_name || username || 'Discord-Nutzer').slice(0, 120);
  const atts: any[] = Array.isArray(d.attachments) ? d.attachments.filter((a: any) => isCdn(String(a?.url ?? ''))) : [];
  let media: DiscordMedia | null = null;
  if (atts.length) {
    const a = atts[0];
    const mime = String(a.content_type ?? '').split(';')[0].toLowerCase();
    const kind: DiscordMedia['kind'] = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'document';
    media = { kind, url: String(a.url), mime: mime || undefined, filename: String(a.filename ?? 'datei').slice(0, 120), size: Number(a.size) || undefined };
  }
  const extra = atts.slice(media ? 1 : 0).map((a) => `📎 ${String(a.filename ?? 'Datei').slice(0, 120)}`);
  let body = String(d.content ?? '').slice(0, TEXT_LIMIT * 2);
  if (!body && media) body = media.kind === 'image' ? '📷 Bild' : media.kind === 'audio' ? '🎤 Audio' : media.kind === 'video' ? '🎬 Video' : `📄 ${media.filename}`;
  if (extra.length) body = [body, ...extra].filter(Boolean).join('\n');
  if (!body.trim()) return null;
  return { id, channelId, guildId: d.guild_id ? String(d.guild_id) : null, authorId, name, username, body, media, at: d.timestamp ? new Date(d.timestamp).toISOString() : new Date().toISOString() };
}

export function inviteUrl(appId: string): string {
  return SNOWFLAKE.test(appId) ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}` : '';
}

/** The slash command members can use anywhere the bot is: /support nachricht:<text>. */
export const SUPPORT_COMMAND = {
  name: 'support',
  type: 1,
  description: 'Nachricht an das Team schicken',
  dm_permission: true,
  options: [{ type: 3, name: 'nachricht', description: 'Deine Nachricht', required: true, max_length: 2000 }],
};

// --- Gateway -------------------------------------------------------------------------------

/** The part of a WebSocket the gateway uses (the global WebSocket of Node 22 fits; tests pass a fake). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

const FATAL: Record<number, string> = {
  4004: 'Bot-Token ungültig',
  4010: 'Ungültiger Shard',
  4011: 'Der Bot ist auf zu vielen Servern (Sharding nötig)',
  4012: 'Ungültige API-Version',
  4013: 'Ungültige Intents',
  4014: 'Privileged Intent „Message Content“ fehlt – im Discord Developer Portal unter Bot einschalten',
};

export type GatewayStatus = 'idle' | 'connecting' | 'ready' | 'stopped' | 'error';

/**
 * Minimal Discord Gateway client: identify, heartbeat (with zombie detection), resume after
 * drops, reconnect with backoff, stop for good on fatal close codes.
 */
export class DiscordGateway {
  status: GatewayStatus = 'idle';
  error = '';
  private ws?: WsLike;
  private seq: number | null = null;
  private sessionId = '';
  private resumeUrl = '';
  private hb?: NodeJS.Timeout;
  private hbFirst?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private acked = true;
  private retries = 0;
  private stopped = false;

  constructor(
    private o: { token: string; intents?: number; socket: WsFactory; onDispatch: (t: string, d: any) => void; onState?: (status: GatewayStatus, error?: string) => void; url?: string },
  ) {}

  get token() {
    return this.o.token;
  }

  start() {
    this.stopped = false;
    this.connect(false);
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.close(1000, 'stop');
    } catch {
      /* already closed */
    }
    this.ws = undefined;
    this.set('stopped');
  }

  private set(status: GatewayStatus, error = '') {
    this.status = status;
    this.error = error;
    this.o.onState?.(status, error || undefined);
  }

  private clearTimers() {
    clearInterval(this.hb);
    clearTimeout(this.hbFirst);
    clearTimeout(this.retryTimer);
  }

  private send(op: number, d: unknown) {
    try {
      this.ws?.send(JSON.stringify({ op, d }));
    } catch {
      /* the close handler reconnects */
    }
  }

  private connect(resume: boolean) {
    this.clearTimers();
    this.set('connecting');
    const url = resume && this.resumeUrl ? `${this.resumeUrl.replace(/\/?(\?.*)?$/, '')}/?v=10&encoding=json` : (this.o.url ?? GATEWAY_URL);
    let ws: WsLike;
    try {
      ws = this.o.socket(url);
    } catch (e) {
      this.set('error', (e as Error).message);
      return this.retry(false);
    }
    this.ws = ws;
    const resuming = resume && !!this.sessionId;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let p: any;
      try {
        p = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch {
        return;
      }
      if (typeof p?.s === 'number') this.seq = p.s;
      switch (p?.op) {
        case 10: {
          const every = Math.max(1000, Number(p.d?.heartbeat_interval) || 41_250);
          this.acked = true;
          this.hbFirst = setTimeout(() => this.beat(), Math.floor(every * Math.random()));
          this.hbFirst.unref?.();
          this.hb = setInterval(() => this.beat(), every);
          this.hb.unref?.();
          if (resuming) this.send(6, { token: this.o.token, session_id: this.sessionId, seq: this.seq });
          else this.send(2, { token: this.o.token, intents: this.o.intents ?? INTENTS, properties: { os: process.platform, browser: 'gohigh', device: 'gohigh' } });
          break;
        }
        case 11:
          this.acked = true;
          break;
        case 1:
          this.send(1, this.seq);
          break;
        case 7: // Discord asks us to reconnect and resume
          this.reconnect(true);
          break;
        case 9: // invalid session; d = resumable
          if (!p.d) {
            this.sessionId = '';
            this.seq = null;
          }
          this.reconnect(!!p.d, 1000 + Math.floor(Math.random() * 4000));
          break;
        case 0:
          if (p.t === 'READY') {
            this.sessionId = String(p.d?.session_id ?? '');
            this.resumeUrl = String(p.d?.resume_gateway_url ?? '');
            this.retries = 0;
            this.set('ready');
          } else if (p.t === 'RESUMED') {
            this.retries = 0;
            this.set('ready');
          }
          try {
            this.o.onDispatch(String(p.t), p.d);
          } catch (e) {
            console.error('[discord] dispatch', e);
          }
          break;
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.clearTimers();
      if (this.stopped) return;
      const fatal = FATAL[ev?.code];
      if (fatal) {
        this.stopped = true;
        return this.set('error', fatal);
      }
      this.retry(true);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private beat() {
    if (!this.acked) {
      // No ACK since the last heartbeat: the connection is a zombie.
      return this.reconnect(true);
    }
    this.acked = false;
    this.send(1, this.seq);
  }

  private reconnect(resume: boolean, delay = 0) {
    const old = this.ws;
    this.ws = undefined;
    this.clearTimers();
    try {
      old?.close(resume ? 4000 : 1000, 'reconnect');
    } catch {
      /* ignore */
    }
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => this.connect(resume), delay);
    this.retryTimer.unref?.();
  }

  private retry(resume: boolean) {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.retries++, 6));
    this.set('connecting', this.error);
    this.retryTimer = setTimeout(() => this.connect(resume), delay);
    this.retryTimer.unref?.();
  }
}
