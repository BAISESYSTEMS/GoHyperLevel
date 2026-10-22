/**
 * Realtime for the Team-Chat: one Server-Sent-Events stream per open browser tab (the client posts
 * messages, typing and "I'm here" signals with ordinary requests – SSE + POST), presence (who has a tab
 * open), typing indicators and the "is somebody looking right now" signal that keeps push notifications
 * from buzzing someone who is reading. In memory – one HyperLevel process serves the chat; clients catch up
 * after a reconnect by loading the channel again.
 */

import { PassThrough } from 'node:stream';
import { byeEvent, type ByeReason, type LoginCheck } from './stream-login.js';

export interface ChatSub {
  clientId: string;
  userId: string;
  locationId: string;
  admin: boolean;
  stream: PassThrough;
  /** Last time this tab said it is in the foreground. */
  activeAt: number;
  /** Is the login behind the stream still valid (not signed out, revoked or expired)? Checked on every round. */
  alive?: LoginCheck;
}

const HEARTBEAT = 20_000;
const MAX_STREAMS = 600;
const MAX_PER_USER = 8;
/** A tab counts as "looking" for this long after its last signal. */
export const ACTIVE_MS = 45_000;

export class ChatHub {
  private subs = new Map<string, ChatSub>();
  private timer: NodeJS.Timeout | undefined;
  private typingAt = new Map<string, number>();
  /** Re-checks that a stream's person may still be here (rights removed, user deleted); set by the module. */
  revalidate: (s: ChatSub) => boolean = () => true;

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT);
    this.timer.unref();
  }

  /** Closes streams that are dead, stuck, whose login ended or whose person lost the right to be here. */
  sweep() {
    for (const s of [...this.subs.values()]) {
      if (s.stream.destroyed || s.stream.writableLength > 1_000_000) this.drop(s);
      // signed out, session revoked or expired, removed, right taken: closed for good (`bye` – the browser does not reconnect)
      else if (s.alive?.() === false || !this.revalidate(s)) this.drop(s, 'signed_out');
    }
  }

  private heartbeat() {
    this.sweep();
    for (const s of this.subs.values()) s.stream.write(': ping\n\n');
    if (!this.subs.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private drop(s: ChatSub, bye?: ByeReason) {
    if (this.subs.get(s.clientId) !== s) return;
    this.subs.delete(s.clientId);
    if (!s.stream.destroyed) s.stream.end(bye ? byeEvent(bye) : undefined);
    if (!this.online(s.userId)) this.publish('presence', { user_id: s.userId, online: false }, (o) => o.userId !== s.userId);
  }

  /**
   * Opens a stream; the first event says who is online. null = the server is full (the module answers 503, which ends the
   * browser's retries – a stream that ended at once was opened again every three seconds).
   */
  subscribe(o: { clientId: string; userId: string; locationId: string; admin: boolean; alive?: LoginCheck; onlineIds?: (ids: string[]) => string[] }): PassThrough | null {
    const old = this.subs.get(o.clientId);
    const mine = [...this.subs.values()].filter((s) => s.userId === o.userId && s !== old);
    if (!old && mine.length < MAX_PER_USER && this.subs.size >= MAX_STREAMS) return null;
    this.ensureTimer();
    const stream = new PassThrough();
    if (old) this.drop(old);
    // the oldest tab of this person makes room – told `bye`, so it waits until it is looked at again instead of
    // reconnecting and pushing the next tab out (ping-pong)
    if (mine.length >= MAX_PER_USER) this.drop(mine[0], 'tabs');
    const wasOnline = this.online(o.userId);
    const sub: ChatSub = { clientId: o.clientId, userId: o.userId, locationId: o.locationId, admin: o.admin, stream, activeAt: Date.now(), alive: o.alive };
    this.subs.set(o.clientId, sub);
    stream.on('close', () => this.drop(sub));
    stream.write('retry: 3000\n\n');
    const all = this.onlineIds();
    stream.write(`event: hello\ndata: ${JSON.stringify({ client_id: o.clientId, online: o.onlineIds ? o.onlineIds(all) : all })}\n\n`);
    if (!wasOnline) this.publish('presence', { user_id: o.userId, online: true }, (s) => s.userId !== o.userId);
    return stream;
  }

  /** Sends an event to every stream the filter accepts. */
  publish(event: string, data: unknown, to: (s: ChatSub) => boolean) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of [...this.subs.values()]) {
      if (!to(s)) continue;
      if (s.stream.destroyed || s.stream.writableLength > 2_000_000) this.drop(s);
      else s.stream.write(chunk);
    }
  }

  /** "Somebody is typing": at most one signal per person and channel every two seconds. */
  typing(channelId: string, userId: string): boolean {
    const key = `${channelId}:${userId}`;
    const t = Date.now();
    if (t - (this.typingAt.get(key) ?? 0) < 2000) return false;
    this.typingAt.set(key, t);
    if (this.typingAt.size > 5000) for (const [k, at] of this.typingAt) if (t - at > 10_000) this.typingAt.delete(k);
    return true;
  }

  /** A tab says it is in the foreground (or not). */
  touch(clientId: string, userId: string, active: boolean) {
    const s = this.subs.get(clientId);
    if (s && s.userId === userId) s.activeAt = active ? Date.now() : 0;
  }
  /** Does this person have a tab in the foreground right now? */
  looking(userId: string): boolean {
    const t = Date.now();
    for (const s of this.subs.values()) if (s.userId === userId && t - s.activeAt < ACTIVE_MS) return true;
    return false;
  }
  online(userId: string): boolean {
    for (const s of this.subs.values()) if (s.userId === userId) return true;
    return false;
  }
  onlineIds(): string[] {
    return [...new Set([...this.subs.values()].map((s) => s.userId))];
  }
  streams(): number {
    return this.subs.size;
  }
  /** Closes the streams of one person (signed out, removed). */
  closeUser(userId: string) {
    for (const s of [...this.subs.values()]) if (s.userId === userId) this.drop(s);
  }
  closeAll() {
    for (const s of [...this.subs.values()]) this.drop(s);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
