/**
 * Realtime for the canvas: Server-Sent Events per board (changes, presence, comments) and the
 * presence list (cursors of people and agents). In memory – one HyperLevel process serves a board;
 * clients catch up after a reconnect with `/changes?since=<seq>`.
 * A person's stream is re-checked every heartbeat: it ends (`bye`) when the login it was opened with is gone
 * (signed out, revoked, expired – services/stream-login.ts) or the person may no longer see the board.
 */

import { PassThrough } from 'node:stream';
import { byeEvent, type ByeReason, type LoginCheck } from './stream-login.js';

export interface Viewer {
  clientId: string;
  userId?: string;
  name: string;
  color: string;
  kind: 'user' | 'agent';
  x?: number;
  y?: number;
  sel?: string[];
  at: number;
}

export interface CanvasSub {
  clientId: string;
  /** The person who opened the stream with their own login (re-checked); unset for keys and MCP connections. */
  userId?: string;
  /** Is the login behind the stream still valid (not signed out, revoked or expired)? Checked on every round. */
  alive?: LoginCheck;
  stream: PassThrough;
}

const COLORS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#0c8599', '#d6336c', '#5f3dc4', '#e67700', '#087f5b'];
export const colorFor = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
};

const USER_TTL = 45_000;
const AGENT_TTL = 12_000;
const MAX_SUBS_PER_BOARD = 200;

export class CanvasHub {
  private subs = new Map<string, Map<string, CanvasSub>>();
  private presence = new Map<string, Map<string, Viewer>>();
  private timer: NodeJS.Timeout | undefined;
  /** Re-checks that a stream's person may still look at the board (set by the module). */
  revalidate: (board: string, s: CanvasSub) => boolean = () => true;

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.heartbeat(), 20_000);
    this.timer.unref();
  }

  /** Closes streams that are dead, stuck, whose login ended or whose person lost access to the board. */
  sweep() {
    for (const [board, subs] of [...this.subs])
      for (const s of [...subs.values()]) {
        if (s.stream.destroyed || s.stream.writableLength > 1_000_000) this.drop(board, s.clientId, s);
        // signed out, session revoked or expired, access taken: closed for good (`bye` – the browser does not reconnect)
        else if (s.alive?.() === false || !this.revalidate(board, s)) this.drop(board, s.clientId, s, 'signed_out');
      }
  }

  private heartbeat() {
    this.sweep();
    const t = Date.now();
    for (const [board, subs] of this.subs) for (const s of subs.values()) this.write(board, s, ': ping\n\n');
    for (const [board, list] of this.presence)
      for (const [id, v] of list)
        if (t - v.at > (v.kind === 'agent' ? AGENT_TTL : USER_TTL)) {
          list.delete(id);
          this.publish(board, 'leave', { clientId: id });
        }
    if (!this.subs.size && !this.presence.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private write(board: string, s: CanvasSub, chunk: string) {
    // a client that stopped reading is dropped instead of growing our memory
    if (s.stream.destroyed || s.stream.writableLength > 2_000_000) {
      this.drop(board, s.clientId, s);
      return;
    }
    s.stream.write(chunk);
  }

  private drop(board: string, clientId: string, s?: CanvasSub, bye?: ByeReason) {
    const subs = this.subs.get(board);
    const cur = subs?.get(clientId);
    if (!cur || (s && cur !== s)) return;
    subs!.delete(clientId);
    if (!subs!.size) this.subs.delete(board);
    if (!cur.stream.destroyed) cur.stream.end(bye ? byeEvent(bye) : undefined);
    if (this.presence.get(board)?.delete(clientId)) this.publish(board, 'leave', { clientId });
    if (!this.presence.get(board)?.size) this.presence.delete(board);
  }

  /**
   * Opens an event stream for one client; the first event lists who is here. `person` binds it to a login (re-checked) – with
   * `userId` a person's, whose access is re-checked too. null = the board is full (the module answers 503, which ends the
   * browser's retries instead of a stream that ends at once and is opened again every few seconds).
   */
  subscribe(board: string, viewer: Viewer, seq: number, person?: { userId?: string; alive?: LoginCheck }): PassThrough | null {
    if ((this.subs.get(board)?.size ?? 0) >= MAX_SUBS_PER_BOARD && !this.subs.get(board)?.has(viewer.clientId)) return null;
    this.ensureTimer();
    const stream = new PassThrough();
    let subs = this.subs.get(board);
    if (!subs) this.subs.set(board, (subs = new Map()));
    const old = subs.get(viewer.clientId);
    if (old) this.drop(board, viewer.clientId, old);
    const sub: CanvasSub = { clientId: viewer.clientId, userId: person?.userId, alive: person?.alive, stream };
    subs.set(viewer.clientId, sub);
    stream.on('close', () => this.drop(board, viewer.clientId, sub));
    stream.write(`retry: 3000\n\n`);
    this.touch(board, viewer, false);
    this.write(board, sub, `event: hello\ndata: ${JSON.stringify({ seq, clientId: viewer.clientId, viewers: this.viewers(board) })}\n\n`);
    return stream;
  }

  /** Sends an event to everyone on the board (optionally not to the client that caused it). */
  publish(board: string, event: string, data: unknown, except?: string) {
    const subs = this.subs.get(board);
    if (!subs) return;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of [...subs.values()]) if (s.clientId !== except) this.write(board, s, chunk);
  }

  /** Updates a viewer's cursor/selection and tells the others. */
  touch(board: string, v: Viewer, announce = true) {
    let list = this.presence.get(board);
    if (!list) this.presence.set(board, (list = new Map()));
    const prev = list.get(v.clientId);
    const next = { ...prev, ...v, at: Date.now() };
    list.set(v.clientId, next);
    this.ensureTimer();
    if (announce || !prev) this.publish(board, 'presence', next, v.clientId);
  }

  viewers(board: string): Viewer[] {
    const t = Date.now();
    return [...(this.presence.get(board)?.values() ?? [])].filter((v) => t - v.at < (v.kind === 'agent' ? AGENT_TTL : USER_TTL));
  }

  watching(board: string): number {
    return this.subs.get(board)?.size ?? 0;
  }

  /** Open streams, all boards together. */
  streams(): number {
    let n = 0;
    for (const subs of this.subs.values()) n += subs.size;
    return n;
  }

  /** Closes every stream of a board (deleted board, revoked access). */
  closeBoard(board: string) {
    for (const s of [...(this.subs.get(board)?.values() ?? [])]) this.drop(board, s.clientId, s);
    this.presence.delete(board);
  }

  closeAll() {
    for (const board of [...this.subs.keys()]) this.closeBoard(board);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
