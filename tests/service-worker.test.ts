import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * web/public/sw.js against in-memory caches and a scripted network. What must hold so the service worker can never
 * turn a deploy, a flaky network or a hotspot login page into a blank app:
 * - a missing /assets/ file (404) is passed through and never cached, an HTML page under a script name neither;
 * - a cached entry that is not the file its name says is dropped and fetched again;
 * - the offline shell is only served when every file it names is cached, and only real index.html files are kept;
 * - the cache version is bumped (v2), so every device drops what the old worker cached.
 */

const ROOT = resolve(__dirname, '..');
const SOURCE = readFileSync(join(ROOT, 'web/public/sw.js'), 'utf8');
const ORIGIN = 'https://crm.example.test';
const SHELL = 'pghl-shell-v2';

const INDEX = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AAAA1111.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-BBBB2222.js">
<link rel="stylesheet" crossorigin href="/assets/app-CCCC3333.css">
</head><body><div id="root"></div></body></html>`;
const JS = 'export default 1;';
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const js = (body = JS, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/javascript; charset=utf-8' } });
const css = () => new Response('a{}', { status: 200, headers: { 'content-type': 'text/css; charset=utf-8' } });
const text404 = () => new Response('Nicht gefunden', { status: 404, headers: { 'content-type': 'text/plain' } });

type Route = () => Response | Promise<Response>;
type Entry = { status: number; headers: [string, string][]; body: Buffer };

function worker(routes: Record<string, Route | 'offline'> = {}) {
  const listeners: Record<string, (ev: any) => void> = {};
  const store = new Map<string, Map<string, Entry>>();
  const href = (k: unknown) => new URL(typeof k === 'string' ? k : (k as { url: string }).url, ORIGIN).href;
  const cacheOf = (name: string) => {
    const entries = store.get(name) ?? store.set(name, new Map()).get(name)!;
    const toResponse = (e: Entry) => new Response(e.body, { status: e.status, headers: e.headers });
    return {
      put: async (k: unknown, res: Response) => void entries.set(href(k), { status: res.status, headers: [...res.headers.entries()], body: Buffer.from(await res.arrayBuffer()) }),
      add: async (k: unknown) => {
        const res = await fetchMock(k as string);
        if (!res.ok) throw new TypeError('bad response');
        entries.set(href(k), { status: res.status, headers: [...res.headers.entries()], body: Buffer.from(await res.arrayBuffer()) });
      },
      match: async (k: unknown) => {
        const e = entries.get(href(k));
        return e ? toResponse(e) : undefined;
      },
      delete: async (k: unknown) => entries.delete(href(k)),
      keys: async () => [...entries.keys()],
    };
  };
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(typeof input === 'string' ? input : (input as { url: string }).url, ORIGIN);
    calls.push(url.pathname);
    const route = routes[url.pathname];
    if (route === 'offline' || (!route && routes['*'] === 'offline')) throw new TypeError('Failed to fetch');
    return route ? route() : text404();
  });
  const self = {
    addEventListener: (type: string, fn: (ev: any) => void) => (listeners[type] = fn),
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined), matchAll: async () => [], openWindow: async () => undefined },
    registration: { showNotification: async () => undefined },
  };
  const caches = {
    open: async (name: string) => cacheOf(name),
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
  };
  vm.runInNewContext(SOURCE, { self, caches, fetch: fetchMock, Response, Request, Headers, URL, console });

  /** Dispatches an event the way the browser does and waits for everything the worker kept alive. */
  async function fire(type: string, init: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners[type]({ ...init, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<Response>) => (responded = Promise.resolve(p)) });
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return { response, handled: !!responded };
  }
  const request = (path: string, mode = 'no-cors', headers: Record<string, string> = {}) => ({ url: `${ORIGIN}${path}`, method: 'GET', mode, headers: new Headers(headers) });
  return {
    fetchMock,
    calls,
    store,
    keys: (name = SHELL) => [...(store.get(name)?.keys() ?? [])].map((k) => new URL(k).pathname).sort(),
    install: () => fire('install'),
    activate: () => fire('activate'),
    get: (path: string, mode?: string, headers?: Record<string, string>) => fire('fetch', { request: request(path, mode, headers) }),
    self,
  };
}

const goodNetwork = (): Record<string, Route> => ({
  '/app': () => html(INDEX),
  '/assets/index-AAAA1111.js': () => js(),
  '/assets/react-BBBB2222.js': () => js(),
  '/assets/app-CCCC3333.css': css,
  '/icon.svg': () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
  '/icon-192.png': () => new Response('png', { headers: { 'content-type': 'image/png' } }),
  '/badge-72.png': () => new Response('png', { headers: { 'content-type': 'image/png' } }),
  '/theme-boot.js': () => js('/*t*/'),
  '/boot-guard.js': () => js('/*g*/'),
});

describe('service worker – versions', () => {
  it('uses cache version v2 and an install drops nothing of its own', async () => {
    const w = worker(goodNetwork());
    await w.install();
    expect([...w.store.keys()]).toEqual([SHELL]);
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });

  it('activate deletes the caches of older versions (a poisoned v1 cache is gone on every device) and keeps foreign ones', async () => {
    const w = worker();
    w.store.set('pghl-shell-v1', new Map([[`${ORIGIN}/assets/x.js`, { status: 200, headers: [], body: Buffer.from('<html>') }]]));
    w.store.set('pghl-api-v1', new Map());
    w.store.set(SHELL, new Map());
    w.store.set('pghl-api-v2', new Map());
    w.store.set('other-app', new Map());
    await w.activate();
    expect([...w.store.keys()].sort()).toEqual(['other-app', 'pghl-api-v2', SHELL]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });
});

describe('service worker – install', () => {
  it('caches the shell together with every file it names, the icons and the boot scripts', async () => {
    const w = worker(goodNetwork());
    await w.install();
    expect(w.keys()).toEqual(['/app', '/assets/app-CCCC3333.css', '/assets/index-AAAA1111.js', '/assets/react-BBBB2222.js', '/badge-72.png', '/boot-guard.js', '/icon-192.png', '/icon.svg', '/theme-boot.js']);
  });

  it('does not cache the shell when one of its files cannot be fetched (it could not start)', async () => {
    const net = goodNetwork();
    net['/assets/react-BBBB2222.js'] = text404;
    const w = worker(net);
    await w.install();
    expect(w.keys()).not.toContain('/app');
    expect(w.keys()).not.toContain('/assets/react-BBBB2222.js');
  });

  it('does not cache a shell that is not our index.html (hotspot login page) or an HTML page for a script', async () => {
    const portal = goodNetwork();
    portal['/app'] = () => html('<html><body>Bitte im WLAN anmelden</body></html>');
    const w1 = worker(portal);
    await w1.install();
    expect(w1.keys()).not.toContain('/app');

    const poisoned = goodNetwork();
    poisoned['/assets/index-AAAA1111.js'] = () => html('<!doctype html><div id="root"></div>');
    const w2 = worker(poisoned);
    await w2.install();
    expect(w2.keys()).not.toContain('/app');
    expect(w2.keys()).not.toContain('/assets/index-AAAA1111.js');
  });

  it('survives being offline', async () => {
    const w = worker({ '*': 'offline' });
    await w.install();
    expect(w.keys()).toEqual([]);
    expect(w.self.skipWaiting).toHaveBeenCalled();
  });
});

describe('service worker – /assets/', () => {
  it('passes a missing file (404) through to the page and never caches it', async () => {
    const w = worker({ '/assets/Settings-OLD00000.js': text404 });
    const { response } = await w.get('/assets/Settings-OLD00000.js');
    expect(response!.status).toBe(404);
    expect(await response!.text()).toBe('Nicht gefunden');
    expect(w.keys()).toEqual([]);
    // asked again: the network is asked again (no cached error, no stale shell in its place)
    await w.get('/assets/Settings-OLD00000.js');
    expect(w.calls).toEqual(['/assets/Settings-OLD00000.js', '/assets/Settings-OLD00000.js']);
  });

  it('never caches a server error or a partial answer', async () => {
    const w = worker({ '/assets/a-1.js': () => js('x', 502), '/assets/b-2.js': () => js('x', 206), '/assets/c-3.css': () => new Response('x', { status: 500, headers: { 'content-type': 'text/css' } }) });
    for (const p of ['/assets/a-1.js', '/assets/b-2.js', '/assets/c-3.css']) expect((await w.get(p)).response).toBeTruthy();
    expect(w.keys()).toEqual([]);
  });

  it('never caches an HTML page that answers for a script or a stylesheet (it stays uncached, the page sees it as is)', async () => {
    const w = worker({ '/assets/index-ZZZZ9999.js': () => html('<!doctype html><div id="root"></div>'), '/assets/app-ZZZZ9999.css': () => html('<!doctype html>') });
    expect((await w.get('/assets/index-ZZZZ9999.js')).response!.headers.get('content-type')).toContain('text/html');
    await w.get('/assets/app-ZZZZ9999.css');
    expect(w.keys()).toEqual([]);
  });

  it('caches a real file and then serves it without the network', async () => {
    const w = worker({ '/assets/Contacts-1a2b3c4d.js': () => js('export const a = 1;') });
    const first = (await w.get('/assets/Contacts-1a2b3c4d.js')).response!;
    expect(await first.text()).toBe('export const a = 1;');
    expect(w.keys()).toEqual(['/assets/Contacts-1a2b3c4d.js']);
    const second = (await w.get('/assets/Contacts-1a2b3c4d.js')).response!;
    expect(await second.text()).toBe('export const a = 1;');
    expect(w.calls).toHaveLength(1);
  });

  it('forgets a poisoned cache entry (HTML under a .js name) and fetches the real file', async () => {
    const w = worker({ '/assets/index-AAAA1111.js': () => js('export default 2;') });
    w.store.set(SHELL, new Map([[`${ORIGIN}/assets/index-AAAA1111.js`, { status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<!doctype html>') }]]));
    const res = (await w.get('/assets/index-AAAA1111.js')).response!;
    expect(await res.text()).toBe('export default 2;');
    expect(w.calls).toEqual(['/assets/index-AAAA1111.js']);
    expect(w.keys()).toEqual(['/assets/index-AAAA1111.js']);
  });

  it('offline: a file that is not cached fails like any request (no made-up answer)', async () => {
    const w = worker({ '*': 'offline' });
    await expect(w.get('/assets/Contacts-1a2b3c4d.js')).rejects.toThrow('Failed to fetch');
  });
});

describe('service worker – navigation to /app', () => {
  const installed = async (net = goodNetwork()) => {
    const w = worker(net);
    await w.install();
    return w;
  };

  it('online: the network answer, and a real index.html is kept for later', async () => {
    const w = worker({ ...goodNetwork(), '/app/contacts': () => html(INDEX) });
    const { response } = await w.get('/app/contacts', 'navigate');
    expect(await response!.text()).toBe(INDEX);
    expect(w.keys()).toEqual(['/app']);
  });

  it('online: a page that is not our index.html is shown but not kept', async () => {
    const w = worker({ '/app': () => html('<html>WLAN-Anmeldung</html>') });
    const { response } = await w.get('/app', 'navigate');
    expect(await response!.text()).toContain('WLAN-Anmeldung');
    expect(w.keys()).toEqual([]);
  });

  it('offline: the cached shell when all its files are cached', async () => {
    const w = await installed();
    w.fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { response } = await w.get('/app/tasks', 'navigate');
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe(INDEX);
  });

  it('offline: NOT the cached shell when a file it names is missing – the offline page instead of a blank app', async () => {
    const w = await installed();
    // an older worker left a shell behind, but one of its files is gone from the cache
    w.store.get(SHELL)!.delete(`${ORIGIN}/assets/react-BBBB2222.js`);
    w.fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { response } = await w.get('/app', 'navigate');
    expect(response!.status).toBe(503);
    expect(await response!.text()).toContain('Offline');
  });

  it('offline without any cache: the offline page', async () => {
    const w = worker({ '*': 'offline' });
    const { response } = await w.get('/app', 'navigate');
    expect(response!.status).toBe(503);
  });

  it('server restarting (502): the complete cached shell instead of the proxy error page', async () => {
    const w = await installed();
    w.fetchMock.mockImplementation(async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    const { response } = await w.get('/app', 'navigate');
    expect(response!.status).toBe(200);
    expect(await response!.text()).toBe(INDEX);
  });

  it('server error without a usable cache: the error itself', async () => {
    const w = worker({ '/app': () => html('Fehler', 500) });
    const { response } = await w.get('/app', 'navigate');
    expect(response!.status).toBe(500);
  });

  it('ignores navigations outside /app and other origins', async () => {
    const w = worker(goodNetwork());
    expect((await w.get('/i/abc', 'navigate')).handled).toBe(false);
    expect((await w.get('/login', 'navigate')).handled).toBe(false);
  });
});

describe('service worker – the small boot scripts', () => {
  it('network first: the current script, with the cached copy only when offline', async () => {
    const w = worker({ '/boot-guard.js': () => js('/*v1*/') });
    expect(await (await w.get('/boot-guard.js')).response!.text()).toBe('/*v1*/');
    w.fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await (await w.get('/boot-guard.js')).response!.text()).toBe('/*v1*/');
  });

  it('does not keep an error or an HTML page as the script', async () => {
    const w = worker({ '/theme-boot.js': () => html('<html>Portal</html>') });
    await w.get('/theme-boot.js');
    expect(w.keys()).toEqual([]);
    const w2 = worker({ '/theme-boot.js': text404 });
    await w2.get('/theme-boot.js');
    expect(w2.keys()).toEqual([]);
  });
});

describe('service worker – API', () => {
  it('still answers /api GETs from the cache when offline, per sub-account, and never caches an error', async () => {
    const w = worker({
      '/api/contacts': () => new Response('[1]', { headers: { 'content-type': 'application/json' } }),
      '/api/broken': () => new Response('{"error":"x"}', { status: 500, headers: { 'content-type': 'application/json' } }),
    });
    expect(await (await w.get('/api/contacts', 'cors', { 'x-location-id': 'loc1' })).response!.text()).toBe('[1]');
    await w.get('/api/broken');
    w.fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await (await w.get('/api/contacts', 'cors', { 'x-location-id': 'loc1' })).response!.text()).toBe('[1]');
    // another sub-account has no copy: the offline answer, not somebody else's data
    const other = (await w.get('/api/contacts', 'cors', { 'x-location-id': 'loc2' })).response!;
    expect(other.status).toBe(503);
    expect((await w.get('/api/broken')).response!.status).toBe(503);
  });

  it('forgets the cached answers after a 401 or a logout', async () => {
    const w = worker({ '/api/me': () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }) });
    w.store.set('pghl-api-v2', new Map([[`${ORIGIN}/api/x`, { status: 200, headers: [], body: Buffer.from('1') }]]));
    await w.get('/api/me');
    expect(w.store.has('pghl-api-v2')).toBe(false);
  });
});
