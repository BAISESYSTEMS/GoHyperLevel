import { api, currentLocation } from '../api';
import { BASE } from '../ui';
import { CURSOR_MAX_POINTS, EDIT_IDLE_MS, HEARTBEAT_MS, HIDDEN_PAUSE_MS, cleanPage, cursorsOn, ownPresence } from '../../../server/services/presence-model';
import { presenceState, setPresence, type Peer } from './store';

/**
 * The one presence connection of a tab (docs/collaboration.md): a single EventSource for the server's news, a heartbeat
 * every 15 s and on every page change, "I am typing" from input/change events in the page content (idle after 20 s),
 * "saved here" after a successful write of the app (api.ts announces `pghl:saved`), and – where both sides switched them
 * on – cursor samples (~20 per second, sent in bundles about three times a second: the API allows 900 requests a minute
 * per address, an office shares one). A hidden tab stops reporting after a minute; closing it says goodbye. When the
 * server ends the stream for good (`bye`: signed out, or a newer tab of the same person took its place) the tab neither
 * reports nor reconnects until it is looked at again; a stream refused with an error is retried after 30 s, 60 s … 5 min.
 */

/**
 * Requests that are not "saving something the others look at": presence itself, the agent, telemetry, own settings,
 * read-like POSTs (previews, checks, counts, AI drafts) and polling of background jobs.
 */
const NOT_SAVING = /^\/api\/(presence|agent|telemetry|feedback|bug-reports|diagnostics|undo|auth|me|appearance|language|tour|academy|xr|push|notifications|search|ai|voice|phone|cognee)(\/|$|\?)|\/(preview|search|suggest|query|data|test|validate|render|estimate|count|lookup|resolve|presence|typing|seen|read|heartbeat|ping|track|stream|events|summarize|draft|timer|poll|check|audience|generate|ai|refresh|options)(\/|$|\?)/;
const SAMPLE_MS = 50;
const FLUSH_MS = 320;
const SAVED_MS = 3000;
/** A write counts as "saved on this page" only shortly after the person did something in the page content (not a timer in the top bar, not a background sync). */
const ACTION_MS = 10_000;
const CURSOR_FADE_MS = 10_000;
/** After the stream failed for good (an error answer, not a dropped line the browser retries itself): wait, then try again – longer each time. */
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 300_000;

export interface RemoteCursor {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  at: number;
}

const randomId = () => {
  try {
    return `t${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  } catch {
    return `t${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
};

/** The app page below /app (`/contacts/abc`), as the server accepts it. */
export function currentPage(): string {
  const raw = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) || '/' : '/';
  return cleanPage(raw) ?? cleanPage(`/${raw.split('/')[1] ?? ''}`) ?? '/';
}

/** The element cursors are measured against: a page's own surface (Living Boards grid) or the main content. */
export function surface(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.content [data-presence-surface]') ?? document.querySelector<HTMLElement>('.main .content');
}

/** Touch-only devices neither show nor send cursors. */
const TOUCH_ONLY = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
export const touchOnly = () => TOUCH_ONLY;

class PresenceClient {
  readonly clientId = randomId();
  /** The sub-account this connection belongs to (a switch starts a new one – presence/Presence.tsx remounts with the page). */
  private readonly loc = currentLocation();
  private es: EventSource | null = null;
  /** The server said `bye` (signed out, or this person's oldest tab): no reconnect until the tab is looked at again. */
  private parked = false;
  private retryTimer: number | undefined;
  private retryMs = RETRY_MIN_MS;
  private peers = new Map<string, Peer>();
  private timer: number | undefined;
  private editTimer: number | undefined;
  private flushTimer: number | undefined;
  private hiddenSince: number | null = null;
  private lastSaved = 0;
  private lastAction = 0;
  private lastSample = 0;
  private pts: [number, number][] = [];
  private stops: (() => void)[] = [];
  cursors = new Map<string, RemoteCursor & { queue: [number, number][]; step?: number }>();

  start() {
    setPresence({ page: currentPage(), editing: false, saved: null, peers: [], live: false });
    this.connect();
    const on = (target: Window | Document, type: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn, opts);
      this.stops.push(() => target.removeEventListener(type, fn, opts));
    };
    on(window, 'pghl:nav', () => this.navigated());
    on(window, 'popstate', () => this.navigated());
    on(document, 'visibilitychange', () => {
      if (document.hidden) this.hiddenSince = Date.now();
      else {
        this.hiddenSince = null;
        if (this.parked || !this.es || this.es.readyState === EventSource.CLOSED) this.reconnect();
        else this.beat();
      }
    });
    on(window, 'pagehide', () => this.leave());
    // back from the browser's page cache: the stream may have been closed meanwhile
    on(window, 'pageshow', (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      if (!this.es || this.es.readyState === EventSource.CLOSED) this.reconnect();
      else this.beat();
    });
    on(document, 'input', (e: Event) => this.typed(e), { capture: true, passive: true });
    on(document, 'change', (e: Event) => this.typed(e), { capture: true, passive: true });
    on(window, 'pghl:saved', (e: CustomEvent<{ method: string; path: string }>) => this.savedLocally(e.detail?.path ?? ''));
    on(document, 'pointermove', (e: PointerEvent) => this.sample(e), { passive: true });
    const acted = (e: Event) => (e.target as HTMLElement | null)?.closest?.('.content') && (this.lastAction = Date.now());
    on(document, 'pointerdown', acted, { capture: true, passive: true });
    on(document, 'keydown', acted, { capture: true, passive: true });
    this.timer = window.setInterval(() => this.beat(), HEARTBEAT_MS);
    this.beat();
  }

  stop() {
    this.leave();
    this.es?.close();
    this.es = null;
    for (const s of this.stops.splice(0)) s();
    window.clearInterval(this.timer);
    window.clearTimeout(this.editTimer);
    window.clearTimeout(this.flushTimer);
    window.clearTimeout(this.retryTimer);
    this.peers.clear();
    this.cursors.clear();
    setPresence({ live: false, peers: [], editing: false, saved: null });
  }

  /** A fresh stream after `bye`, a failed one or the browser's page cache (the server sends the whole list again). */
  private reconnect() {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.parked = false;
    this.es?.close();
    this.connect();
  }

  private connect() {
    const es = new EventSource(`/api/presence/stream?clientId=${this.clientId}&locationId=${encodeURIComponent(this.loc)}`);
    this.es = es;
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    es.addEventListener('hello', (e) => {
      const d = data(e);
      this.retryMs = RETRY_MIN_MS;
      this.peers = new Map((d.peers as Peer[]).map((p) => [p.id, p]));
      setPresence({ live: !!d.enabled, enabled: !!d.enabled, prefs: d.prefs, peers: [...this.peers.values()] });
      this.beat();
    });
    es.addEventListener('presence', (e) => {
      const p = data(e) as Peer;
      this.peers.set(p.id, p);
      if (p.page !== presenceState().page) this.dropCursor(p.id);
      this.publishPeers();
    });
    es.addEventListener('gone', (e) => {
      const { id } = data(e);
      if (this.peers.delete(id)) this.publishPeers();
      this.dropCursor(id);
    });
    es.addEventListener('saved', (e) => {
      const d = data(e);
      if (d.page === presenceState().page && !ownPresence(d.page)) setPresence({ saved: { name: d.name, page: d.page, at: Date.now() } });
    });
    es.addEventListener('cursor', (e) => this.received(data(e)));
    // the server ends this stream for good (signed out, removed, or a newer tab of mine took its place): no reconnect loop
    es.addEventListener('bye', () => {
      es.close();
      this.parked = true;
      this.offline();
    });
    es.addEventListener('settings', (e) => {
      const { enabled } = data(e);
      if (!enabled) {
        this.peers.clear();
        this.cursors.clear();
        this.notifyCursors();
      }
      setPresence({ enabled, live: enabled, peers: [...this.peers.values()], saved: null });
      if (enabled) this.beat();
    });
    es.onerror = () => {
      // a dropped line: the browser reconnects itself and "hello" brings the list again. An error answer (403, 409, 503 …)
      // closes the stream for good: one more try after a while, longer each time, and only while the tab is looked at
      if (es.readyState !== EventSource.CLOSED || this.es !== es) return;
      this.offline();
      if (this.parked) return;
      window.clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = undefined;
        if (!document.hidden && this.es === es) this.reconnect();
      }, this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    };
  }

  /** No live stream: nobody shown, no cursors (and no heartbeats – `beat` needs an open stream). */
  private offline() {
    this.peers.clear();
    this.cursors.clear();
    this.notifyCursors();
    setPresence({ live: false, peers: [] });
  }

  private publishPeers() {
    setPresence({ peers: [...this.peers.values()] });
  }

  /** The heartbeat (and the carrier of "saved", "editing" and cursor samples). */
  beat(extra: Record<string, unknown> = {}) {
    const s = presenceState();
    // only with a live stream (no reporting after `bye`, sign-out or a failed stream) and only for this tab's sub-account
    if (!s.enabled || !this.es || this.es.readyState !== EventSource.OPEN || currentLocation() !== this.loc) return;
    if (this.hiddenSince !== null && Date.now() - this.hiddenSince > HIDDEN_PAUSE_MS) return;
    void api.post('/api/presence', { clientId: this.clientId, page: s.page, editing: s.editing, ...extra }).catch(() => undefined);
  }

  private leave() {
    if (!this.es || !presenceState().enabled) return;
    // sendBeacon cannot carry the CSRF header – a keepalive fetch survives the closing tab just the same
    try {
      void fetch('/api/presence', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-pghl': '1', 'x-location-id': this.loc },
        body: JSON.stringify({ clientId: this.clientId, leaving: true }),
      }).catch(() => undefined);
    } catch {
      /* the stream's end tells the server too */
    }
  }

  private navigated() {
    const page = currentPage();
    if (page === presenceState().page) return;
    window.clearTimeout(this.editTimer);
    this.pts = [];
    this.cursors.clear();
    this.notifyCursors();
    setPresence({ page, editing: false, saved: null });
    this.beat();
  }

  private typed(e: Event) {
    const el = e.target as HTMLElement | null;
    // search and filter boxes are not editing anything
    if (!el?.closest?.('.content') || el.closest('[data-presence-ignore]') || el.matches?.('input[type="search"], [role="searchbox"]')) return;
    window.clearTimeout(this.editTimer);
    this.editTimer = window.setTimeout(() => {
      setPresence({ editing: false });
      this.beat();
    }, EDIT_IDLE_MS);
    if (!presenceState().editing) {
      setPresence({ editing: true });
      this.beat();
    }
  }

  private savedLocally(path: string) {
    const page = presenceState().page;
    // a write counts only right after the person worked in the page content, in a tab they are looking at
    if (!path || document.hidden || NOT_SAVING.test(path) || ownPresence(page) || Date.now() - this.lastAction > ACTION_MS || Date.now() - this.lastSaved < SAVED_MS) return;
    this.lastSaved = Date.now();
    window.clearTimeout(this.editTimer);
    setPresence({ editing: false });
    this.beat({ saved: true });
  }

  // --- cursors ----------------------------------------------------------------------------------------------------------
  /** Somebody on my page who exchanges cursors here – only then are mine worth sending. */
  private sharing(): boolean {
    const s = presenceState();
    if (!s.live || touchOnly() || !cursorsOn(s.prefs.cursors, s.page) || s.prefs.invisible) return false;
    return s.peers.some((p) => p.page === s.page && p.cursors);
  }

  private sample(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || Date.now() - this.lastSample < SAMPLE_MS || !this.sharing()) return;
    const el = surface();
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    this.lastSample = Date.now();
    this.pts.push([(e.clientX - r.left) / r.width, e.clientY - r.top]);
    if (this.pts.length > CURSOR_MAX_POINTS) this.pts.shift();
    this.flushTimer ??= window.setTimeout(() => {
      this.flushTimer = undefined;
      const pts = this.pts.splice(0).map(([x, y]) => [Math.round(x * 10_000) / 10_000, Math.round(y)]);
      if (pts.length) this.beat({ pts });
    }, FLUSH_MS);
  }

  private received(d: { id: string; name: string; color: string; pts: [number, number][] }) {
    const s = presenceState();
    if (touchOnly() || !cursorsOn(s.prefs.cursors, s.page) || !Array.isArray(d.pts) || !d.pts.length) return;
    // right after a page change the server may still relay the old page's cursors for a moment
    if (this.peers.get(d.id)?.page !== s.page) return;
    const cur = this.cursors.get(d.id);
    const c = cur ?? { id: d.id, name: d.name, color: d.color, x: d.pts[0][0], y: d.pts[0][1], at: Date.now(), queue: [] };
    c.name = d.name;
    c.color = d.color;
    c.queue.push(...d.pts);
    if (c.queue.length > 30) c.queue.splice(0, c.queue.length - 30);
    this.cursors.set(d.id, c);
    // replay the bundle at the pace it was recorded
    const step = () => {
      const next = c.queue.shift();
      if (!next || this.cursors.get(c.id) !== c) return void (c.step = undefined);
      c.x = next[0];
      c.y = next[1];
      c.at = Date.now();
      this.notifyCursors();
      c.step = window.setTimeout(step, SAMPLE_MS);
    };
    if (c.step === undefined) step();
  }

  private dropCursor(id: string) {
    if (this.cursors.delete(id)) this.notifyCursors();
  }

  /** Cursors that went quiet fade out. */
  fadeCursors() {
    const t = Date.now();
    let gone = false;
    for (const [id, c] of this.cursors)
      if (t - c.at > CURSOR_FADE_MS) {
        this.cursors.delete(id);
        gone = true;
      }
    if (gone) this.notifyCursors();
  }

  private notifyCursors() {
    for (const fn of cursorListeners) fn();
  }
}

/** Redraws of the cursor layer (module-wide: the layer may mount before the connection starts). */
const cursorListeners = new Set<() => void>();
export function onCursors(fn: () => void) {
  cursorListeners.add(fn);
  return () => void cursorListeners.delete(fn);
}

let client: PresenceClient | null = null;
let users = 0;

/** Starts the tab's connection (once, however many components ask) – returns the stop function. */
export function startPresence(): () => void {
  users++;
  if (!client) {
    client = new PresenceClient();
    client.start();
  }
  return () => {
    users--;
    if (users <= 0 && client) {
      client.stop();
      client = null;
      users = 0;
    }
  };
}

export const presenceClient = () => client;
