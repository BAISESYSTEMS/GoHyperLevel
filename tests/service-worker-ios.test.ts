import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * web/public/sw.js on iPhone and iPad (docs/ios-web-app.md): what it does for the number on the app icon, notification clicks that
 * must open the right page of the installed app (and never another site), subscriptions that the push service replaces, the
 * offline page and a small answer cache (iOS evicts storage under pressure). The caching rules are in service-worker.test.ts.
 */

const SOURCE = readFileSync(join(resolve(__dirname, '..'), 'web/public/sw.js'), 'utf8');
const ORIGIN = 'https://crm.example.test';

function worker(opts: { fetch?: (url: URL, init?: any) => Response | Promise<Response>; windows?: any[]; badge?: boolean } = {}) {
  const listeners: Record<string, (ev: any) => void> = {};
  const store = new Map<string, Map<string, Response>>();
  const href = (k: unknown) => new URL(typeof k === 'string' ? k : (k as { url: string }).url, ORIGIN).href;
  const cacheOf = (name: string) => {
    const m = store.get(name) ?? store.set(name, new Map()).get(name)!;
    return {
      put: async (k: unknown, r: Response) => void m.set(href(k), r),
      match: async (k: unknown) => m.get(href(k))?.clone(),
      delete: async (k: unknown) => m.delete(href(k)),
      keys: async () => [...m.keys()],
      add: async () => undefined,
    };
  };
  const shown: { title: string; options: any }[] = [];
  const badge = { set: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
  const subscribed: any[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    if (!opts.fetch) throw new TypeError('Failed to fetch');
    return opts.fetch(url, init);
  });
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (ev: any) => void) => (listeners[type] = fn),
    location: { origin: ORIGIN },
    skipWaiting: async () => undefined,
    navigator: opts.badge === false ? {} : { setAppBadge: badge.set, clearAppBadge: badge.clear },
    clients: { claim: async () => undefined, matchAll: async () => opts.windows ?? [], openWindow: async (u: string) => void opened.push(u) },
    registration: {
      showNotification: async (title: string, options: any) => void shown.push({ title, options }),
      pushManager: { subscribe: async (o: any) => (subscribed.push(o), { toJSON: () => ({ endpoint: 'https://web.push.apple.com/new', keys: { p256dh: 'x', auth: 'y' } }) }) },
    },
  };
  vm.runInNewContext(SOURCE, { self, caches: { open: async (n: string) => cacheOf(n), keys: async () => [...store.keys()], delete: async (n: string) => store.delete(n) }, fetch: fetchMock, Response, Request, Headers, URL, console });
  async function fire(type: string, init: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners[type]({ ...init, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = Promise.resolve(p)) });
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return response;
  }
  const push = (data: unknown) => fire('push', { data: { json: () => data, text: () => JSON.stringify(data) } });
  const click = (data: Record<string, unknown>, action = '') => fire('notificationclick', { action, notification: { close: () => undefined, data } });
  return { fire, push, click, shown, badge, opened, subscribed, fetchMock, store };
}

describe('service worker – number on the app icon', () => {
  it('sets the number a push message carries and shows the notification (iOS wants one for every push)', async () => {
    const w = worker();
    await w.push({ title: 'Neue SMS von Anna', body: 'Hallo', url: '/app/conversations/c1', badge: 3 });
    expect(w.badge.set).toHaveBeenCalledWith(3);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe('Neue SMS von Anna');
    expect(w.shown[0].options.data.url).toBe('/app/conversations/c1');
  });

  it('clears the number when nothing is unread, caps it, and leaves it alone when the message has none', async () => {
    const w = worker();
    await w.push({ title: 'x', badge: 0 });
    expect(w.badge.clear).toHaveBeenCalled();
    await w.push({ title: 'y', badge: 5000 });
    expect(w.badge.set).toHaveBeenLastCalledWith(999);
    w.badge.set.mockClear();
    w.badge.clear.mockClear();
    await w.push({ title: 'z' });
    expect(w.badge.set).not.toHaveBeenCalled();
    expect(w.badge.clear).not.toHaveBeenCalled();
    expect(w.shown).toHaveLength(3);
  });

  it('still shows the notification where the Badging API does not exist', async () => {
    const w = worker({ badge: false });
    await w.push({ title: 'Ohne Badge', badge: 2 });
    expect(w.shown.map((s) => s.title)).toEqual(['Ohne Badge']);
  });

  it('shows a generic notification when the payload is unreadable and the server cannot be asked (offline)', async () => {
    const w = worker();
    await w.fire('push', { data: { json: () => { throw new Error('bad'); }, text: () => '' } });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe('Neue Benachrichtigung');
  });
});

describe('service worker – notification click', () => {
  const win = (url: string, extra: Partial<{ focus: () => Promise<void> }> = {}) => {
    const messages: unknown[] = [];
    return { url, focus: vi.fn(async () => undefined), postMessage: (m: unknown) => void messages.push(m), messages, ...extra };
  };

  it('focuses the open app and tells it which page (and sub-account) to show', async () => {
    const open = win(`${ORIGIN}/app/dashboard`);
    const w = worker({ windows: [open] });
    await w.click({ url: '/app/conversations/c9', location_id: 'loc1' });
    expect(open.focus).toHaveBeenCalled();
    expect(open.messages).toEqual([{ type: 'navigate', url: '/app/conversations/c9', location_id: 'loc1' }]);
    expect(w.opened).toEqual([]);
  });

  it('opens the app at the page when it is not open – with the sub-account in the address', async () => {
    const w = worker();
    await w.click({ url: '/app/tasks', location_id: 'loc2' });
    expect(w.opened).toEqual([`${ORIGIN}/app/tasks?loc=loc2`]);
    const w2 = worker();
    await w2.click({});
    expect(w2.opened).toEqual([`${ORIGIN}/app`]);
  });

  it('opens a new window when the old one cannot be focused (iOS, a frozen page)', async () => {
    const dead = win(`${ORIGIN}/app/x`, { focus: async () => { throw new Error('no'); } });
    const w = worker({ windows: [dead] });
    await w.click({ url: '/app/contacts/1' });
    expect(w.opened).toEqual([`${ORIGIN}/app/contacts/1`]);
  });

  it('never leaves the app: other sites, protocol-relative addresses and other paths open the start page', async () => {
    for (const url of ['//evil.example/phish', 'https://evil.example/x', '/api/auth/logout', '/applications', 'javascript:alert(1)', '']) {
      const w = worker();
      await w.click({ url });
      expect(w.opened, url).toEqual([`${ORIGIN}/app`]);
    }
    const w = worker();
    await w.click({ url: '/app/conversations/c1?x=1#top' });
    expect(w.opened).toEqual([`${ORIGIN}/app/conversations/c1?x=1#top`]);
  });

  it('a button opens its own page', async () => {
    const w = worker();
    await w.click({ url: '/app/werkstatt', actions: [{ action: 'approve', url: '/app/werkstatt/7?action=approve' }, { action: 'deny', url: '//evil.example' }] }, 'approve');
    expect(w.opened).toEqual([`${ORIGIN}/app/werkstatt/7?action=approve`]);
    const w2 = worker();
    await w2.click({ url: '/app/werkstatt', actions: [{ action: 'deny', url: '//evil.example' }] }, 'deny');
    expect(w2.opened).toEqual([`${ORIGIN}/app`]);
  });
});

describe('service worker – subscription replaced by the push service', () => {
  it('subscribes again with the same key and tells the server', async () => {
    const calls: { url: string; init: any }[] = [];
    const w = worker({ fetch: (url, init) => (calls.push({ url: url.pathname, init }), new Response('{}', { headers: { 'content-type': 'application/json' } })) });
    await w.fire('pushsubscriptionchange', { oldSubscription: { options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer } } });
    expect(w.subscribed).toHaveLength(1);
    expect(w.subscribed[0]).toMatchObject({ userVisibleOnly: true });
    const post = calls.find((c) => c.url === '/api/push/subscribe')!;
    expect(post.init.method).toBe('POST');
    expect(post.init.headers['x-pghl']).toBe('1');
    expect(JSON.parse(post.init.body).subscription.endpoint).toBe('https://web.push.apple.com/new');
  });

  it('takes the key from the server when the old subscription is gone, and never throws offline', async () => {
    const w = worker({ fetch: (url) => (url.pathname === '/api/push/public-key' ? new Response(JSON.stringify({ key: 'BKEY' }), { headers: { 'content-type': 'application/json' } }) : new Response('{}')) });
    await w.fire('pushsubscriptionchange', {});
    expect(w.subscribed[0].applicationServerKey).toBe('BKEY');
    const off = worker();
    await expect(off.fire('pushsubscriptionchange', {})).resolves.toBeUndefined();
  });
});

describe('service worker – offline page and answer cache', () => {
  it('shows a page of its own when offline without a cached app: German, light and dark, safe areas, a retry button', async () => {
    const w = worker();
    const res = await w.fire('fetch', { request: { url: `${ORIGIN}/app/contacts`, method: 'GET', mode: 'navigate', headers: new Headers() } });
    expect(res!.status).toBe(503);
    const html = await res!.text();
    expect(html).toContain('Du bist offline');
    expect(html).toContain('Erneut versuchen');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).not.toMatch(/<script|src=|href=/); // nothing it needs from outside
  });

  it('keeps at most 80 answers per device and drops the oldest first', async () => {
    const w = worker({ fetch: (url) => new Response(JSON.stringify({ n: url.searchParams.get('n') }), { headers: { 'content-type': 'application/json' } }) });
    for (let i = 0; i < 100; i++) await w.fire('fetch', { request: { url: `${ORIGIN}/api/contacts?n=${i}`, method: 'GET', mode: 'cors', headers: new Headers({ 'x-location-id': 'l1' }) } });
    const keys = [...w.store.get('pghl-api-v2')!.keys()];
    expect(keys).toHaveLength(80);
    expect(keys.some((k) => k.includes('n=0&') || k.includes('n=0 '))).toBe(false);
    expect(keys.some((k) => k.includes('n=99&'))).toBe(true);
  });
});
