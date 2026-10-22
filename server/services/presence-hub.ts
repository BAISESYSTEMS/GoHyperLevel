/**
 * Live-Zusammenarbeit überall: the in-memory state behind the presence of the whole app – one Server-Sent-Events stream
 * per open tab (news from the server) and one small state per tab that the tab's heartbeat keeps alive (which page, is
 * somebody typing there). Same pattern as the Team-Chat (services/teamchat-hub.ts): SSE + ordinary POSTs.
 *
 * Nothing is persisted or logged: the state lives in this process only and a tab that stops reporting is gone after
 * PRESENCE_TTL_MS. Who sees what is decided per receiver: the same sub-account only, never the own tabs, never somebody
 * invisible or hidden, a page only if the receiver may open its area (else just "online"), cursors only between two
 * people on the same page who both switched them on (services/presence-model.ts).
 */

import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { CURSOR_MIN_MS, PRESENCE_TTL_MS, SAVED_MIN_MS, cursorsOn, maySeePage, type PresencePrefs } from './presence-model.js';
import { byeEvent, type ByeReason, type LoginCheck } from './stream-login.js';

/** The rights of a receiver, refreshed on every check of its stream. */
export interface PresenceViewer {
  id: string;
  role: string;
  permissions: string[] | null;
}

export interface PresenceSub {
  clientId: string;
  userId: string;
  locationId: string;
  viewer: PresenceViewer;
  prefs: PresencePrefs;
  /** Is the login behind the stream still valid (session not signed out or revoked)? Checked on every round. */
  alive?: LoginCheck;
  stream: PassThrough;
}

/** One open tab that reported in. `pid` is what others see – the clientId never leaves the server. */
export interface PresenceClient {
  clientId: string;
  pid: string;
  userId: string;
  name: string;
  color: string;
  locationId: string;
  page: string;
  editing: boolean;
  at: number;
  cursorAt: number;
  savedAt: number;
  /** Invisible by choice or hidden (cloud operator): kept for its own bookkeeping, never shown to anybody. */
  silent: boolean;
  prefs: PresencePrefs;
}

/** What a receiver gets about a colleague's tab. */
export interface PeerOut {
  id: string;
  user_id: string;
  name: string;
  color: string;
  /** null = the receiver may not see where (only that the colleague is online). */
  page: string | null;
  /** Always null: the server relays no free text from a browser (the reader's app names the page from its own menu). */
  title: null;
  editing: boolean;
  /** Exchanges cursors on this page (so the receiver's tab knows whether to send its own). */
  cursors: boolean;
}

const HEARTBEAT = 20_000;
const MAX_STREAMS = 1000;
const MAX_STREAMS_PER_USER = 10;
const MAX_CLIENTS = 5000;
const MAX_CLIENTS_PER_USER = 10;
/** Heartbeats, cursor bundles and "saved" of one person, all tabs together (the browser sends about 3 a second while the mouse moves). */
export const PRESENCE_POSTS_PER_MINUTE = 300;

export class PresenceHub {
  private subs = new Map<string, PresenceSub>();
  private clients = new Map<string, PresenceClient>();
  private posts = new Map<string, { at: number; n: number }>();
  private timer: NodeJS.Timeout | undefined;
  /** The clock (tests move it to check the expiry). */
  now: () => number = () => Date.now();
  /** Re-checks that a stream's person may still be here and refreshes its rights; false closes the stream (set by the module). */
  revalidate: (s: PresenceSub) => boolean = () => true;
  /** Re-checks a tab's state (person removed, feature switched off); false drops it (set by the module). */
  keep: (c: PresenceClient) => boolean = () => true;
  /** Runs before each check round (the module empties its lookup cache there). */
  beforeSweep: () => void = () => undefined;

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT);
    this.timer.unref();
  }

  private heartbeat() {
    this.sweep();
    for (const s of this.subs.values()) s.stream.write(': ping\n\n');
    if (!this.subs.size && !this.clients.size && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.posts.clear();
    }
  }

  /** Closes dead, stuck or no longer allowed streams and forgets tabs that stopped reporting. */
  sweep() {
    this.beforeSweep();
    for (const s of [...this.subs.values()]) {
      if (s.stream.destroyed || s.stream.writableLength > 1_000_000) this.drop(s);
      // signed out, session revoked, removed from the sub-account, deleted: closed for good (no reconnect loop)
      else if (s.alive?.() === false || !this.revalidate(s)) this.drop(s, false, 'signed_out');
    }
    const t = this.now();
    for (const c of [...this.clients.values()]) if (t - c.at >= PRESENCE_TTL_MS || !this.keep(c)) this.remove(c.clientId);
    for (const [userId, p] of this.posts) if (t - p.at >= 60_000) this.posts.delete(userId);
  }

  private drop(s: PresenceSub, replaced = false, bye?: ByeReason) {
    if (this.subs.get(s.clientId) !== s) return;
    this.subs.delete(s.clientId);
    if (!s.stream.destroyed) s.stream.end(bye ? byeEvent(bye) : undefined);
    // a closed tab is gone at once (a reconnect of the same tab keeps its state)
    if (!replaced) this.remove(s.clientId);
  }

  /**
   * Opens a stream; `hello` builds the first event for it (who is here). A person's 11th tab takes the place of their
   * oldest one, which is told `bye` (its browser then waits until the tab is looked at again instead of reconnecting
   * and pushing the next one out). null = the server is full (the module answers 503, which ends the browser's retries).
   */
  subscribe(o: Omit<PresenceSub, 'stream'>, hello: (s: PresenceSub) => unknown): PassThrough | null {
    const old = this.subs.get(o.clientId);
    const mine = [...this.subs.values()].filter((s) => s.userId === o.userId && s !== old);
    if (!old && mine.length < MAX_STREAMS_PER_USER && this.subs.size >= MAX_STREAMS) return null;
    this.ensureTimer();
    if (old) this.drop(old, true);
    for (const s of mine.slice(0, Math.max(0, mine.length - MAX_STREAMS_PER_USER + 1))) this.drop(s, false, 'tabs');
    const stream = new PassThrough();
    const sub: PresenceSub = { ...o, stream };
    this.subs.set(o.clientId, sub);
    stream.on('close', () => this.drop(sub));
    // a little jitter: after a restart not every tab of the office comes back in the same second
    stream.write(`retry: ${5000 + Math.floor(Math.random() * 5000)}\n\n`);
    stream.write(`event: hello\ndata: ${JSON.stringify(hello(sub))}\n\n`);
    return stream;
  }

  /** Counts a heartbeat of a person; false when they sent more than PRESENCE_POSTS_PER_MINUTE in the current minute. */
  allow(userId: string): boolean {
    const t = this.now();
    let p = this.posts.get(userId);
    if (!p || t - p.at >= 60_000) {
      if (!p && this.posts.size >= 10_000) this.posts.clear();
      p = { at: t, n: 0 };
      this.posts.set(userId, p);
    }
    return ++p.n <= PRESENCE_POSTS_PER_MINUTE;
  }

  sub(clientId: string): PresenceSub | undefined {
    return this.subs.get(clientId);
  }
  client(clientId: string): PresenceClient | undefined {
    return this.clients.get(clientId);
  }

  /** Sends an event to the streams the filter accepts. */
  publish(event: string, data: unknown, to: (s: PresenceSub) => boolean) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.publishEach(event, () => chunk, to, true);
  }

  /** Sends an event whose data differs per receiver (`data` returns undefined = nothing for this one). */
  publishEach(event: string, data: (s: PresenceSub) => unknown, to: (s: PresenceSub) => boolean, raw = false) {
    for (const s of [...this.subs.values()]) {
      if (!to(s)) continue;
      const d = data(s);
      if (d === undefined) continue;
      if (s.stream.destroyed || s.stream.writableLength > 2_000_000) this.drop(s);
      else s.stream.write(raw ? (d as string) : `event: ${event}\ndata: ${JSON.stringify(d)}\n\n`);
    }
  }

  /** What `s` may know about the tab `c` (undefined = nothing at all). */
  viewFor(s: { userId: string; locationId: string; viewer: PresenceViewer }, c: PresenceClient, at = this.now()): PeerOut | undefined {
    if (c.locationId !== s.locationId || c.userId === s.userId || c.silent || at - c.at >= PRESENCE_TTL_MS) return undefined;
    const show = maySeePage(s.viewer, c.page);
    return { id: c.pid, user_id: c.userId, name: c.name, color: c.color, page: show ? c.page : null, title: null, editing: show && c.editing, cursors: show && cursorsOn(c.prefs.cursors, c.page) };
  }

  /** Every colleague tab `s` may know about. */
  peersFor(s: { userId: string; locationId: string; viewer: PresenceViewer }): PeerOut[] {
    const at = this.now();
    const out: PeerOut[] = [];
    for (const c of this.clients.values()) {
      const v = this.viewFor(s, c, at);
      if (v) out.push(v);
    }
    return out;
  }

  /** The tabs of a sub-account (for the team list), fresh ones only. */
  clientsIn(locationId: string): PresenceClient[] {
    const at = this.now();
    return [...this.clients.values()].filter((c) => c.locationId === locationId && at - c.at < PRESENCE_TTL_MS);
  }

  /**
   * A tab reports in. Returns false when the clientId belongs to somebody else. Announces the tab to the others when
   * something they see changed (new, other page, editing on/off, became visible).
   */
  report(o: Omit<PresenceClient, 'pid' | 'at' | 'cursorAt' | 'savedAt'>): PresenceClient | false {
    this.ensureTimer();
    let c = this.clients.get(o.clientId);
    if (c && c.userId !== o.userId) return false;
    if (c && c.locationId !== o.locationId) {
      this.remove(c.clientId);
      c = undefined;
    }
    const at = this.now();
    if (!c) {
      const mine = [...this.clients.values()].filter((x) => x.userId === o.userId).sort((a, b) => a.at - b.at);
      if (mine.length >= MAX_CLIENTS_PER_USER) this.remove(mine[0].clientId);
      if (this.clients.size >= MAX_CLIENTS) {
        const oldest = [...this.clients.values()].sort((a, b) => a.at - b.at)[0];
        if (oldest) this.remove(oldest.clientId);
      }
      c = { ...o, pid: randomUUID().replace(/-/g, '').slice(0, 12), at, cursorAt: 0, savedAt: 0 };
      this.clients.set(c.clientId, c);
      if (!c.silent) this.announce(c);
      return c;
    }
    const expired = at - c.at >= PRESENCE_TTL_MS;
    const changed = expired || c.page !== o.page || c.editing !== o.editing || c.silent !== o.silent || c.name !== o.name || c.prefs.cursors !== o.prefs.cursors;
    const vanished = !c.silent && o.silent;
    Object.assign(c, { name: o.name, color: o.color, page: o.page, editing: o.editing, silent: o.silent, prefs: o.prefs, at });
    if (vanished) this.publish('gone', { id: c.pid }, (s) => s.locationId === c!.locationId);
    else if (changed && !c.silent) this.announce(c);
    return c;
  }

  /** Tells every stream of the sub-account what it may know about the tab. */
  announce(c: PresenceClient) {
    this.publishEach('presence', (s) => this.viewFor(s, c), (s) => s.locationId === c.locationId && s.userId !== c.userId);
  }

  /** Forgets a tab (closed, left, expired) and tells the others. */
  remove(clientId: string) {
    const c = this.clients.get(clientId);
    if (!c) return;
    this.clients.delete(clientId);
    if (!c.silent) this.publish('gone', { id: c.pid }, (s) => s.locationId === c.locationId && s.userId !== c.userId);
  }

  /** Forgets every tab of a person (gone invisible) or of a sub-account (feature switched off). */
  removeWhere(fn: (c: PresenceClient) => boolean) {
    for (const c of [...this.clients.values()]) if (fn(c)) this.remove(c.clientId);
  }

  /** The live tab behind a stream – in the stream's own sub-account (a tab that moved to another one does not count here). */
  private tabOf(s: PresenceSub): PresenceClient | undefined {
    const c = this.clients.get(s.clientId);
    return c && c.locationId === s.locationId && this.now() - c.at < PRESENCE_TTL_MS ? c : undefined;
  }

  /** "Anna saved here": to the other people on the same page. False when throttled. */
  saved(c: PresenceClient): boolean {
    const at = this.now();
    if (c.silent || at - c.savedAt < SAVED_MIN_MS) return false;
    c.savedAt = at;
    this.publish('saved', { id: c.pid, user_id: c.userId, name: c.name, page: c.page }, (s) => s.locationId === c.locationId && s.userId !== c.userId && this.tabOf(s)?.page === c.page && maySeePage(s.viewer, c.page));
    return true;
  }

  /**
   * Cursor samples: only to people on the same page who, like the sender, have cursors switched on there – and who are
   * visible themselves (an invisible or hidden person sends no cursor, so they get none: nobody watches unseen). False when throttled.
   */
  cursor(c: PresenceClient, pts: [number, number][]): boolean {
    const at = this.now();
    if (c.silent || !pts.length || at - c.cursorAt < CURSOR_MIN_MS || !cursorsOn(c.prefs.cursors, c.page)) return false;
    c.cursorAt = at;
    const data = { id: c.pid, user_id: c.userId, name: c.name, color: c.color, pts };
    this.publish('cursor', data, (s) => {
      if (s.locationId !== c.locationId || s.userId === c.userId || !cursorsOn(s.prefs.cursors, c.page) || !maySeePage(s.viewer, c.page)) return false;
      const tab = this.tabOf(s);
      return !!tab && tab.page === c.page && !tab.silent;
    });
    return true;
  }

  /** Tells the others again about a person's visible tabs (their cursor choice changed). */
  reannounce(userId: string) {
    for (const c of this.clients.values()) if (c.userId === userId && !c.silent && this.now() - c.at < PRESENCE_TTL_MS) this.announce(c);
  }

  /** Updates the stored preferences on a person's open streams and tabs. */
  setPrefs(userId: string, prefs: PresencePrefs) {
    for (const s of this.subs.values()) if (s.userId === userId) s.prefs = prefs;
    for (const c of this.clients.values()) if (c.userId === userId) c.prefs = prefs;
  }

  streams(locationId?: string): number {
    return locationId ? [...this.subs.values()].filter((s) => s.locationId === locationId).length : this.subs.size;
  }
  size(): number {
    return this.clients.size;
  }

  closeAll() {
    for (const s of [...this.subs.values()]) this.drop(s);
    this.clients.clear();
    this.posts.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
