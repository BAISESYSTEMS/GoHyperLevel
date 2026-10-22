import { api, currentLocation } from '../api';
import { type CanvasElement, sortByZ } from '../../../server/services/canvas-model';
import type { CardData } from '../../../server/services/canvas-render';

/**
 * Client side of a board: the element map, local changes sent as batched operations, undo/redo,
 * realtime (Server-Sent Events) and presence. React subscribes via `useSyncExternalStore`.
 *
 * Local edits are applied at once (optimistic), queued and flushed every ~120 ms with this client's
 * id; the server echoes everyone else's changes over SSE. While an element has unsent local changes,
 * remote versions of it are not applied – our write follows and wins (last writer per field).
 */

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

export interface Comment {
  id: string;
  element_id: string | null;
  x: number | null;
  y: number | null;
  parent_id: string | null;
  body: string;
  mentions: string[];
  author_id: string | null;
  author_name: string;
  resolved_at: string | null;
  created_at: string;
}

type Op = { op: 'add'; element: CanvasElement } | { op: 'update'; id: string; props: Record<string, unknown> } | { op: 'delete'; id: string };
type Change = { id: string; before: CanvasElement | null; after: CanvasElement | null };

const rid = (n = 12) => {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => a[x % a.length]).join('');
};
export const newId = () => rid(12);

export class BoardStore {
  readonly clientId = `c${rid(14)}`;
  els = new Map<string, CanvasElement>();
  ordered: CanvasElement[] = [];
  seq = 0;
  viewers = new Map<string, Viewer>();
  comments: Comment[] = [];
  cards: Record<string, CardData> = {};
  status: 'online' | 'offline' | 'saving' = 'online';
  /** Bumps on every change (React re-render key). */
  rev = 0;
  private listeners = new Set<() => void>();
  private queue: Op[] = [];
  private inflight = false;
  private inflightP: Promise<void> | null = null;
  private pending = new Map<string, number>();
  /** Fields changed locally with `send: false` (drags), sent by `sendDirty` when the gesture ends. */
  private dirty = new Map<string, Set<string>>();
  private timer: number | undefined;
  private undoStack: Change[][] = [];
  private redoStack: Change[][] = [];
  private tx: Map<string, Change> | null = null;
  private es: EventSource | null = null;
  /** After the server's `bye`: opens the stream again when the tab is looked at again. */
  private resume: (() => void) | null = null;
  private presenceTimer: number | undefined;
  private lastPresence: { x?: number; y?: number; sel?: string[] } = {};
  private presenceDue = false;
  private lastSent = 0;
  private closed = false;
  onBoard?: (b: any) => void;
  onReload?: () => void;
  onDeleted?: () => void;
  onRemote?: (actor: { name: string; kind: string }, ids: string[]) => void;
  onError?: (e: Error) => void;

  constructor(readonly boardId: string) {}

  // --- subscription ------------------------------------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getRev = () => this.rev;
  private emit() {
    this.rev++;
    this.ordered = sortByZ([...this.els.values()]);
    for (const fn of this.listeners) fn();
  }
  touch() {
    this.rev++;
    for (const fn of this.listeners) fn();
  }

  // --- loading ---------------------------------------------------------------------------------------
  load(elements: CanvasElement[], seq: number) {
    this.els = new Map(elements.map((e) => [e.id, e]));
    this.seq = seq;
    this.emit();
  }

  // --- local changes -----------------------------------------------------------------------------------
  /** Groups the following changes into one undo step (call `commit` when done). */
  begin() {
    if (!this.tx) this.tx = new Map();
  }
  commit() {
    const tx = this.tx;
    this.tx = null;
    if (!tx || !tx.size) return;
    const changes = [...tx.values()].filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
    if (!changes.length) return;
    this.undoStack.push(changes);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  private record(id: string, before: CanvasElement | null, after: CanvasElement | null) {
    const own = !this.tx;
    if (own) this.begin();
    const cur = this.tx!.get(id);
    this.tx!.set(id, { id, before: cur ? cur.before : before, after });
    if (own) this.commit();
  }

  /** One call = one undo step, also when it touches many elements (paste, align, delete a frame …). */
  private step(fn: () => void) {
    const own = !this.tx;
    if (own) this.begin();
    try {
      fn();
    } finally {
      if (own) this.commit();
    }
  }

  add(els: CanvasElement[], opts: { history?: boolean } = {}) {
    this.step(() => {
      let top = this.ordered.length ? (this.ordered[this.ordered.length - 1].z ?? 0) : 0;
      for (const raw of els) {
        const el = { ...raw, z: raw.z ?? ++top };
        if (opts.history !== false) this.record(el.id, this.els.get(el.id) ?? null, el);
        this.els.set(el.id, el);
        this.push({ op: 'add', element: el });
      }
    });
    this.emit();
  }

  /** Changes elements: `patch` per id (merged), sent as updates. */
  update(patches: Record<string, Partial<CanvasElement>>, opts: { history?: boolean; send?: boolean } = {}) {
    this.step(() => this.applyPatches(patches, opts));
    this.emit();
  }

  private applyPatches(patches: Record<string, Partial<CanvasElement>>, opts: { history?: boolean; send?: boolean }) {
    for (const [id, p] of Object.entries(patches)) {
      const cur = this.els.get(id);
      if (!cur) continue;
      const next = { ...cur } as Record<string, unknown>;
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || v === null) delete next[k];
        else next[k] = v;
      }
      if (opts.history !== false) this.record(id, cur, next as unknown as CanvasElement);
      this.els.set(id, next as unknown as CanvasElement);
      if (opts.send !== false) this.push({ op: 'update', id, props: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === undefined ? null : v])) });
      else {
        const d = this.dirty.get(id) ?? this.dirty.set(id, new Set()).get(id)!;
        for (const k of Object.keys(p)) d.add(k);
      }
    }
  }

  /** Sends what was changed with `send: false` (a finished drag, resize, rotation …) as updates; removed fields go as null. */
  sendDirty(ids?: Iterable<string>) {
    const want = ids ? new Set(ids) : null;
    for (const [id, keys] of this.dirty) {
      if (want && !want.has(id)) continue;
      this.dirty.delete(id);
      const el = this.els.get(id) as unknown as Record<string, unknown> | undefined;
      if (!el) continue;
      this.push({ op: 'update', id, props: Object.fromEntries([...keys].map((k) => [k, el[k] === undefined ? null : el[k]])) });
    }
  }

  /** Changes not yet confirmed by the server (warns before the tab closes). */
  hasUnsent() {
    return this.queue.length > 0 || this.inflight || this.dirty.size > 0;
  }

  remove(ids: string[], opts: { history?: boolean } = {}) {
    // frames take their contents along (like the server)
    const all = new Set(ids);
    for (const e of this.els.values()) if (e.frameId && all.has(e.frameId)) all.add(e.id);
    this.step(() => {
      for (const id of all) {
        const cur = this.els.get(id);
        if (!cur) continue;
        if (opts.history !== false) this.record(id, cur, null);
        this.els.delete(id);
        this.dirty.delete(id);
        this.push({ op: 'delete', id });
      }
    });
    this.emit();
  }

  canUndo = () => this.undoStack.length > 0;
  canRedo = () => this.redoStack.length > 0;
  undo() {
    const step = this.undoStack.pop();
    if (!step) return;
    this.applyStep(step, 'before');
    this.redoStack.push(step);
  }
  redo() {
    const step = this.redoStack.pop();
    if (!step) return;
    this.applyStep(step, 'after');
    this.undoStack.push(step);
  }
  private applyStep(step: Change[], side: 'before' | 'after') {
    for (const c of step) {
      const want = c[side];
      if (!want) {
        if (this.els.has(c.id)) {
          this.els.delete(c.id);
          this.push({ op: 'delete', id: c.id });
        }
      } else {
        this.els.set(c.id, want);
        this.push({ op: 'add', element: want });
      }
    }
    this.emit();
  }

  /** Records elements created elsewhere (server generators) as one undo step. */
  recordCreated(els: CanvasElement[]) {
    if (!els.length) return;
    this.undoStack.push(els.map((e) => ({ id: e.id, before: null, after: e })));
    this.redoStack = [];
  }

  // --- sending ----------------------------------------------------------------------------------------------
  private push(op: Op) {
    const id = op.op === 'add' ? op.element.id : op.id;
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
    // coalesce: an update after an add/update of the same element merges into it
    const last = this.queue.length ? this.queue[this.queue.length - 1] : undefined;
    if (op.op === 'update' && last && ((last.op === 'update' && last.id === op.id) || (last.op === 'add' && last.element.id === op.id))) {
      if (last.op === 'update') last.props = { ...last.props, ...op.props };
      else last.element = this.els.get(op.id) ?? last.element;
      this.pending.set(id, this.pending.get(id)! - 1);
    } else this.queue.push(op);
    this.schedule();
  }
  private schedule(ms = 120) {
    if (this.timer || this.closed) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, ms);
  }

  /** Sends everything queued, one batch after the other; resolves when nothing is left (or the connection is down). */
  async flush(): Promise<void> {
    this.sendDirty();
    await this.drain();
  }

  private async drain(): Promise<void> {
    for (let guard = 0; guard < 60; guard++) {
      if (this.inflightP) {
        await this.inflightP;
        continue;
      }
      if (!this.queue.length || this.status === 'offline') return;
      this.inflightP = this.sendBatch().finally(() => (this.inflightP = null));
      await this.inflightP;
    }
  }

  private async sendBatch(): Promise<void> {
    const batch = this.queue.splice(0, 800);
    this.inflight = true;
    this.status = 'saving';
    let retry = false;
    try {
      const r = await api.post(`/api/canvas/${this.boardId}/ops`, { clientId: this.clientId, ops: batch });
      if (r.seq > this.seq) this.seq = r.seq;
      // merged states for conflicts (someone else changed other fields meanwhile)
      for (const cur of r.current ?? []) if (!this.queue.some((o) => (o.op === 'add' ? o.element.id : o.id) === cur.id) && !this.dirty.has(cur.id)) this.els.set(cur.id, cur);
      for (const res of r.results ?? []) {
        const el = this.els.get(res.id);
        if (el && res.version) this.els.set(res.id, { ...el, version: res.version });
      }
      this.status = 'online';
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      this.status = 'online';
      // network trouble: send again later, in order; refusals (403, 400 …) are dropped
      if (status === 0 || status >= 500 || status === 429) {
        this.queue.unshift(...batch);
        this.status = 'offline';
        retry = true;
      } else this.onError?.(e as Error);
    } finally {
      if (!retry)
        for (const op of batch) {
          const id = op.op === 'add' ? op.element.id : op.id;
          const n = (this.pending.get(id) ?? 1) - 1;
          if (n <= 0) this.pending.delete(id);
          else this.pending.set(id, n);
        }
      this.inflight = false;
      this.emit();
    }
    if (retry)
      window.setTimeout(() => {
        if (this.closed) return;
        this.status = 'saving';
        this.touch();
        void this.drain();
      }, 3000);
    else if (this.queue.length) this.schedule(30);
  }

  // --- remote --------------------------------------------------------------------------------------------------
  applyRemote(elements: CanvasElement[], deleted: string[], seq?: number) {
    let changed = false;
    for (const el of elements) {
      if (this.pending.has(el.id)) continue;
      const cur = this.els.get(el.id);
      if (cur && (cur.version ?? 0) > (el.version ?? 0)) continue;
      this.els.set(el.id, el);
      changed = true;
    }
    for (const id of deleted) {
      if (this.pending.has(id)) continue;
      if (this.els.delete(id)) changed = true;
    }
    if (seq && seq > this.seq) this.seq = seq;
    if (changed) this.emit();
  }

  async catchUp() {
    const r = await api.get(`/api/canvas/${this.boardId}/changes?since=${this.seq}`);
    const before = new Map(this.els);
    this.applyRemote(r.elements, r.deleted, r.seq);
    return { created: (r.elements as CanvasElement[]).filter((e) => !before.has(e.id)), elements: r.elements as CanvasElement[] };
  }

  connect() {
    const loc = encodeURIComponent(currentLocation());
    const es = new EventSource(`/api/canvas/${this.boardId}/stream?clientId=${this.clientId}&locationId=${loc}`);
    this.es = es;
    let opened = false;
    es.addEventListener('hello', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      this.viewers = new Map((d.viewers as Viewer[]).filter((v) => v.clientId !== this.clientId).map((v) => [v.clientId, { ...v, at: Date.now() }]));
      // after a reconnect: fetch what we missed
      if (opened || d.seq > this.seq) void this.catchUp().catch(() => {});
      opened = true;
      this.status = 'online';
      this.touch();
      void this.drain();
    });
    es.addEventListener('ops', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (d.clientId === this.clientId) return;
      this.applyRemote(d.elements ?? [], d.deleted ?? [], d.seq);
      this.onRemote?.(d.actor, (d.elements ?? []).map((x: CanvasElement) => x.id));
    });
    es.addEventListener('presence', (e) => {
      const v = JSON.parse((e as MessageEvent).data) as Viewer;
      if (v.clientId === this.clientId) return;
      this.viewers.set(v.clientId, { ...v, at: Date.now() });
      this.touch();
    });
    es.addEventListener('leave', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      if (this.viewers.delete(d.clientId)) this.touch();
    });
    es.addEventListener('comment', (e) => {
      const c = JSON.parse((e as MessageEvent).data) as Comment;
      const i = this.comments.findIndex((x) => x.id === c.id);
      if (i >= 0) this.comments[i] = c;
      else this.comments.push(c);
      this.comments = [...this.comments];
      this.touch();
    });
    es.addEventListener('comment-deleted', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      this.comments = this.comments.filter((c) => c.id !== d.id && c.parent_id !== d.id);
      this.touch();
    });
    es.addEventListener('board', (e) => this.onBoard?.(JSON.parse((e as MessageEvent).data)));
    es.addEventListener('reload', () => this.onReload?.());
    es.addEventListener('deleted', () => this.onDeleted?.());
    // the server ended the stream for good (`bye`: signed out, session revoked or expired, no access any more; or an error
    // answer such as 503 when the server is full): no reconnect loop – one new try when the tab is looked at again (its hello
    // fetches what was missed)
    const park = () => {
      es.close();
      window.clearInterval(this.presenceTimer);
      this.viewers.clear();
      this.status = 'offline';
      this.touch();
      this.stopResume();
      this.resume = () => {
        if (document.hidden || this.closed || this.es !== es) return;
        this.stopResume();
        this.connect();
      };
      document.addEventListener('visibilitychange', this.resume);
    };
    es.addEventListener('bye', park);
    es.onerror = () => {
      this.status = 'offline';
      this.touch();
      if (es.readyState === EventSource.CLOSED && this.es === es && !this.closed) park();
    };
    // agents' cursors fade out on their own
    this.presenceTimer = window.setInterval(() => {
      const t = Date.now();
      let gone = false;
      for (const [id, v] of this.viewers)
        if (t - v.at > (v.kind === 'agent' ? 12_000 : 60_000)) {
          this.viewers.delete(id);
          gone = true;
        }
      if (gone) this.touch();
      // only worth sending while somebody else is on the board (the API allows 900 calls a minute per address)
      if (this.viewers.size && ((this.presenceDue && t - this.lastSent >= 400) || t - this.lastSent > 20_000)) this.sendPresence();
    }, 250);
  }

  /** Cursor (board coordinates) and selection for the others; sent at most 2.5× per second, and only while others are watching. */
  presence(p: { x?: number; y?: number; sel?: string[] }) {
    this.lastPresence = { ...this.lastPresence, ...p };
    this.presenceDue = true;
  }
  private sendPresence() {
    this.presenceDue = false;
    this.lastSent = Date.now();
    void api.post(`/api/canvas/${this.boardId}/presence`, { clientId: this.clientId, ...this.lastPresence }).catch(() => {});
  }

  private stopResume() {
    if (this.resume) document.removeEventListener('visibilitychange', this.resume);
    this.resume = null;
  }

  close() {
    this.closed = true;
    this.stopResume();
    this.es?.close();
    this.es = null;
    if (this.presenceTimer) window.clearInterval(this.presenceTimer);
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.flush();
  }
}
