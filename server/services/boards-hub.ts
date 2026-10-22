/**
 * Living Boards realtime: one Server-Sent-Events stream per open tab and board – the same pattern as the Team-Chat
 * (SSE for the server's news, ordinary requests for everything the client does). Whoever changes a board – the editor,
 * the agent, MCP, an undo – publishes the new version here and every open tab shows it at once. Also who is looking
 * (names, no cursors). In memory: one HyperLevel process serves a board; a tab that reconnects reloads the board.
 * Streams are re-checked every heartbeat so a person who lost access (board made personal, right removed, user
 * deleted) or whose login ended (signed out, session revoked or expired) is cut off within 20 seconds – signing out and
 * revoking at once (services/stream-login.ts).
 */

import { PassThrough } from 'node:stream';
import { byeEvent, type ByeReason, type LoginCheck } from './stream-login.js';

export interface BoardSub {
  clientId: string;
  boardId: string;
  locationId: string;
  userId: string | null;
  name: string;
  /** Is the login behind the stream still valid (not signed out, revoked or expired)? Checked on every round. */
  alive?: LoginCheck;
  stream: PassThrough;
}

const HEARTBEAT = 20_000;
const MAX_STREAMS = 500;
const MAX_PER_BOARD = 100;
const MAX_PER_USER = 8;

export class BoardsHub {
  private subs = new Map<string, BoardSub>();
  private timer: NodeJS.Timeout | undefined;
  /** Re-checks that a stream's person may still look at its board (set by the module). */
  revalidate: (s: BoardSub) => boolean = () => true;

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT);
    this.timer.unref();
  }

  /** Closes streams that are dead, stuck, whose login ended or whose person lost the right to be here. */
  sweep() {
    for (const s of [...this.subs.values()]) {
      if (s.stream.destroyed || s.stream.writableLength > 1_000_000) this.drop(s);
      // signed out, session revoked or expired, access taken: closed for good (`bye` – the browser does not reconnect)
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

  private drop(s: BoardSub, bye?: ByeReason) {
    if (this.subs.get(s.clientId) !== s) return;
    this.subs.delete(s.clientId);
    if (!s.stream.destroyed) s.stream.end(bye ? byeEvent(bye) : undefined);
    this.announce(s.boardId);
  }

  /** Who is looking at a board: one entry per person, however many tabs. */
  viewers(boardId: string): { user_id: string | null; name: string }[] {
    const seen = new Map<string, { user_id: string | null; name: string }>();
    for (const s of this.subs.values()) if (s.boardId === boardId) seen.set(s.userId ?? s.clientId, { user_id: s.userId, name: s.name });
    return [...seen.values()];
  }

  private announce(boardId: string) {
    this.publish(boardId, 'viewers', { viewers: this.viewers(boardId) });
  }

  /**
   * Opens a stream; the first event says who is here. null = the server or the board is full (the module answers 503, which
   * ends the browser's retries – a stream that ended at once was opened again every three seconds).
   */
  subscribe(o: { clientId: string; boardId: string; locationId: string; userId: string | null; name: string; alive?: LoginCheck }): PassThrough | null {
    const old = this.subs.get(o.clientId);
    const all = [...this.subs.values()].filter((s) => s !== old);
    if (all.length >= MAX_STREAMS || all.filter((s) => s.boardId === o.boardId).length >= MAX_PER_BOARD) return null;
    this.ensureTimer();
    const stream = new PassThrough();
    if (old) this.drop(old);
    const mine = all.filter((s) => s.userId && s.userId === o.userId);
    // the oldest tab of this person makes room – told `bye`, so it waits until it is looked at again (no ping-pong)
    if (mine.length >= MAX_PER_USER) this.drop(mine[0], 'tabs');
    const sub: BoardSub = { ...o, stream };
    this.subs.set(o.clientId, sub);
    stream.on('close', () => this.drop(sub));
    stream.write('retry: 3000\n\n');
    stream.write(`event: hello\ndata: ${JSON.stringify({ client_id: o.clientId, viewers: this.viewers(o.boardId) })}\n\n`);
    this.announce(o.boardId);
    return stream;
  }

  /** Sends an event to every stream of a board (optionally only those the filter accepts). */
  publish(boardId: string, event: string, data: unknown, to: (s: BoardSub) => boolean = () => true) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of [...this.subs.values()]) {
      if (s.boardId !== boardId || !to(s)) continue;
      if (s.stream.destroyed || s.stream.writableLength > 2_000_000) this.drop(s);
      else s.stream.write(chunk);
    }
  }

  /** The board is gone: tell its viewers and close the streams. */
  closeBoard(boardId: string, event = 'deleted') {
    this.publish(boardId, event, { board_id: boardId });
    for (const s of [...this.subs.values()]) if (s.boardId === boardId) this.drop(s);
  }

  closeUser(userId: string) {
    for (const s of [...this.subs.values()]) if (s.userId === userId) this.drop(s);
  }

  streams(boardId?: string): number {
    return boardId ? [...this.subs.values()].filter((s) => s.boardId === boardId).length : this.subs.size;
  }

  closeAll() {
    for (const s of [...this.subs.values()]) this.drop(s);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
