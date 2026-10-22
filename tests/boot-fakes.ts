import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { vi } from 'vitest';

/** A small fake DOM and browser (no jsdom in this project) that web/public/boot-guard.js and the Android probe run against. */

export const ROOT = resolve(__dirname, '..');
export const SOURCE = readFileSync(join(ROOT, 'web/public/boot-guard.js'), 'utf8');

export class FakeNode {
  attrs: Record<string, string> = {};
  childNodes: FakeNode[] = [];
  listeners: Record<string, ((ev?: unknown) => void)[]> = {};
  parent: FakeNode | null = null;
  text = '';
  constructor(public tagName: string) {}
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  set textContent(v: string) {
    this.text = v;
  }
  get textContent(): string {
    return this.text + this.childNodes.map((c) => c.textContent).join('');
  }
  appendChild(c: FakeNode) {
    c.parent = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: FakeNode) {
    this.childNodes = this.childNodes.filter((n) => n !== c);
    return c;
  }
  addEventListener(type: string, fn: (ev?: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const f of this.listeners.click ?? []) f();
  }
  find(pred: (n: FakeNode) => boolean): FakeNode | null {
    if (pred(this)) return this;
    for (const c of this.childNodes) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return null;
  }
}

export interface Options {
  /** A service worker controls the page. */
  controller?: boolean;
  readyState?: string;
  storage?: Record<string, string>;
  withRoot?: boolean;
}

export function boot(options: Options = {}, withGuard = true) {
  const body = new FakeNode('BODY');
  const root = new FakeNode('DIV');
  root.setAttribute('id', 'root');
  if (options.withRoot !== false) body.appendChild(root);
  const timers: { fn: () => void; ms: number }[] = [];
  const store: Record<string, string> = { ...(options.storage ?? {}) };
  const winListeners: Record<string, ((ev: unknown) => void)[]> = {};
  const docListeners: Record<string, ((ev: unknown) => void)[]> = {};
  const unregistered: string[] = [];
  const deletedCaches: string[] = [];
  const fetchCalls: { url: string; init: any }[] = [];
  const reload = vi.fn();
  const sandbox: Record<string, any> = {
    document: {
      readyState: options.readyState ?? 'complete',
      getElementById: (id: string) => body.find((n) => n.attrs.id === id),
      createElement: (tag: string) => new FakeNode(tag.toUpperCase()),
      querySelector: () => ({ getAttribute: () => '/assets/index-Ab12Cd34.js' }),
      addEventListener: (t: string, f: (ev: unknown) => void) => (docListeners[t] ??= []).push(f),
    },
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 9; wv) Chrome/74.0.3729.136 Mobile Safari/537.36 GoHighApp/1.0.2',
      onLine: true,
      serviceWorker: {
        controller: options.controller ? {} : null,
        getRegistrations: async () => [{ unregister: async () => unregistered.push('reg') }, { unregister: async () => unregistered.push('reg2') }],
      },
    },
    location: { pathname: '/app/contacts', reload },
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) },
    caches: { keys: async () => ['pghl-shell-v1', 'pghl-api-v1'], delete: async (k: string) => (deletedCaches.push(k), true) },
    performance: { getEntriesByType: () => [{ name: 'https://crm.example.test/assets/index-Ab12Cd34.js' }, { name: 'https://crm.example.test/api/x' }] },
    fetch: async (url: string, init: any) => {
      fetchCalls.push({ url, init });
      return { ok: true };
    },
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    console,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (t: string, f: (ev: unknown) => void) => (winListeners[t] ??= []).push(f);
  if (withGuard) vm.runInNewContext(SOURCE, sandbox);
  return {
    win: sandbox,
    guard: sandbox.__pghlBoot,
    root,
    store,
    timers,
    fetchCalls,
    reload,
    unregistered,
    deletedCaches,
    emit: (type: string, ev: unknown) => (winListeners[type] ?? []).forEach((f) => f(ev)),
    emitDoc: (type: string, ev: unknown) => (docListeners[type] ?? []).forEach((f) => f(ev)),
    fallback: () => root.find((n) => n.attrs.id === 'pghl-boot-fallback'),
    /** The app renders (what React does on its first commit). */
    mountApp: () => {
      root.appendChild(new FakeNode('DIV'));
      sandbox.__pghlMounted = true;
    },
    flush: () => new Promise((ok) => setImmediate(ok)),
  };
}
