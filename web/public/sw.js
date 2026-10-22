/* Service worker of the installable app (scope /app).
 * - App shell (index.html + hashed assets) cached, so the app starts offline – but only a shell whose files are all
 *   in the cache: a shell that references files we do not have would start a blank page.
 * - Hashed files (/assets/*) are cached only when they really are what their name says (200, not an HTML page that a
 *   proxy or an old server sent instead). A missing file (404 after a deploy) is passed through and never cached.
 * - /api: network first; the last good answer is the offline fallback (per sub-account, cleared on logout).
 * - Push: shows the notification, sets the number on the app icon (Badging API) and re-subscribes when the push service
 *   replaces the subscription; a click opens or focuses the app at the right page (only paths inside /app).
 * - iPhone/iPad: the offline page is plain HTML with its own styles (works without the app's CSS), the API cache stays small
 *   (iOS evicts a site's storage under pressure; docs/ios-web-app.md).
 * Tests: tests/service-worker.test.ts and tests/service-worker-ios.test.ts run this very file against fake caches. */
const VERSION = 'v2';
const SHELL = `pghl-shell-${VERSION}`;
const API = `pghl-api-${VERSION}`;
const ICONS = ['/icon.svg', '/icon-192.png', '/badge-72.png'];
/** Small scripts without a hash in their name: network first, the cached copy only when offline. */
const BOOT = ['/theme-boot.js', '/boot-guard.js'];
const ASSET_RE = /\/assets\/[\w.-]+\.(?:js|css)/g;

const typeOf = (res) => (res.headers.get('content-type') || '').toLowerCase();

/** The hashed files an index.html loads (entry, preloads, stylesheet). */
const assetsOf = (html) => [...new Set(html.match(ASSET_RE) || [])];

/** Our index.html, not a captive-portal page or an error page that happens to be HTML. */
const looksLikeShell = (html) => html.includes('id="root"') && assetsOf(html).length > 0;

/** Is this answer the file its URL names? 200 only (no 404/5xx/206) and never an HTML page for a script or stylesheet. */
function assetOk(pathname, res) {
  if (!res || res.status !== 200) return false;
  const type = typeOf(res);
  if (type.includes('text/html')) return false;
  if (/\.m?js$/.test(pathname)) return /javascript|ecmascript/.test(type);
  if (/\.css$/.test(pathname)) return type.includes('text/css');
  return true;
}

/** Fetches a hashed file into the cache; true when it is there afterwards. */
async function fetchAsset(cache, path) {
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!assetOk(path, res)) return false;
    await cache.put(path, res);
    return true;
  } catch {
    return false;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch('/app', { cache: 'no-store', credentials: 'same-origin' });
        const html = res.ok ? await res.clone().text() : '';
        if (looksLikeShell(html)) {
          // All files first, the shell last: a half-installed shell would start without its scripts.
          const done = await Promise.all(assetsOf(html).map((a) => fetchAsset(cache, a)));
          if (done.every(Boolean)) await cache.put('/app', res);
        }
        await Promise.all([...ICONS, ...BOOT].map((u) => cache.add(u).catch(() => undefined)));
      } catch {
        /* offline during install: the next visit fills the cache */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('pghl-') && !key.endsWith(VERSION)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const offlineJson = () => new Response(JSON.stringify({ error: 'Offline – keine Verbindung zum Server' }), { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } });
/** Offline and no cached app yet: a page of its own (light/dark, safe areas, a big retry button), nothing from the app is needed. */
const OFFLINE_HTML =
  '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>Offline</title>' +
  '<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;box-sizing:border-box;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));font:16px/1.5 system-ui,-apple-system,sans-serif;background:#f4f6fa;color:#111827;text-align:center}' +
  '.c{max-width:360px}h1{font-size:22px;margin:8px 0}p{color:#475569;margin:0 0 20px}.i{font-size:48px}' +
  'button{font:inherit;font-weight:700;min-height:48px;padding:0 28px;border:0;border-radius:12px;background:#2563eb;color:#fff;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}' +
  '@media(prefers-color-scheme:dark){body{background:#0b1020;color:#e5e7eb}p{color:#94a3b8}}</style></head>' +
  '<body><div class="c"><div class="i" aria-hidden="true">&#128225;</div><h1>Du bist offline</h1><p>Die App braucht eine Verbindung, um Daten zu laden. Sobald du wieder Empfang hast, geht es hier weiter.</p><button type="button" onclick="location.reload()">Erneut versuchen</button></div></body></html>';
const offlinePage = () => new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** The cached shell – only when every file it names is cached too (otherwise null: better "Offline" than a blank page). */
async function cachedShell(cache) {
  const hit = await cache.match('/app');
  if (!hit) return null;
  const html = await hit.clone().text();
  for (const a of assetsOf(html)) if (!(await cache.match(a))) return null;
  return hit;
}

/** Navigation to the app: the network's answer; the cached shell only when the network is not there. */
async function shell(request, event) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.ok && typeOf(res).includes('text/html')) {
      const keep = res.clone();
      // Only a real index.html is kept – a login page of a hotspot must not become "the app".
      event.waitUntil(
        keep
          .clone()
          .text()
          .then((html) => (looksLikeShell(html) ? cache.put('/app', keep) : undefined))
          .catch(() => undefined),
      );
    }
    // The server is restarting (nginx 502/503/504): the complete cached shell beats the proxy's error page.
    if (res.status >= 500) return (await cachedShell(cache)) || res;
    return res;
  } catch {
    return (await cachedShell(cache)) || offlinePage();
  }
}

/** Hashed file: from the cache, else the network (cached only when it is the right file). */
async function asset(request) {
  const { pathname } = new URL(request.url);
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) {
    if (assetOk(pathname, hit)) return hit;
    await cache.delete(request); // a bad entry (HTML under a .js name, left by an older worker): forget it, ask the network
  }
  const res = await fetch(request);
  if (assetOk(pathname, res)) await cache.put(request, res.clone()).catch(() => undefined);
  return res;
}

/** Unhashed small script: always the network's current one, the cached copy only offline. */
async function fresh(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    if (res.status === 200 && !typeOf(res).includes('text/html')) await cache.put(request, res.clone()).catch(() => undefined);
    return res;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

/** Entries kept per answer cache: iOS may evict a whole site's storage when space runs short, so the cache stays small. */
const API_MAX_ENTRIES = 80;
async function trim(cache, max) {
  try {
    const keys = await cache.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
  } catch {
    /* the cache is only a convenience */
  }
}

async function api(request) {
  const url = new URL(request.url);
  url.searchParams.set('__loc', request.headers.get('x-location-id') || '');
  const key = url.toString();
  const cache = await caches.open(API);
  try {
    const res = await fetch(request);
    if (res.status === 401) await caches.delete(API);
    else if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      await cache.put(key, res.clone());
      await trim(cache, API_MAX_ENTRIES);
    }
    return res;
  } catch {
    return (await cache.match(key)) || offlineJson();
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') {
    if (url.pathname === '/api/auth/logout') event.waitUntil(caches.delete(API));
    return;
  }
  if (req.mode === 'navigate') {
    if (url.pathname === '/app' || url.pathname.startsWith('/app/')) event.respondWith(shell(req, event));
    return;
  }
  if (url.pathname.startsWith('/assets/')) return event.respondWith(asset(req));
  if (BOOT.includes(url.pathname)) return event.respondWith(fresh(req));
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') && !url.pathname.startsWith('/api/push/latest')) return event.respondWith(api(req));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'logout') event.waitUntil(caches.delete(API));
});

// --- push ---------------------------------------------------------------------
/** Badging API from the worker: a number, or nothing for 0. Never throws (not every browser has it). */
async function setBadge(n) {
  try {
    const nav = self.navigator;
    if (!nav) return;
    if (n > 0 && nav.setAppBadge) await nav.setAppBadge(Math.min(n, 999));
    else if (nav.clearAppBadge) await nav.clearAppBadge();
  } catch {
    /* no permission yet, or not supported */
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let data = null;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        data = event.data ? { title: event.data.text() } : null;
      }
      if (!data || !data.title) {
        // Payload missing or unreadable: fetch the latest notification text.
        try {
          const r = await fetch('/api/push/latest', { credentials: 'same-origin' });
          if (r.ok) data = await r.json();
        } catch {
          /* show a generic note below */
        }
      }
      data = data && data.title ? data : { title: 'Neue Benachrichtigung', url: '/app' };
      // The number on the app icon (iOS 16.4+ from the installed app, Android, desktop): the server counts what is unread.
      // Not awaited before the notification: iOS wants it shown promptly, and the number is a bonus.
      const badge = typeof data.badge === 'number' ? setBadge(data.badge) : null;
      await self.registration.showNotification(data.title, {
        body: data.body || '',
        tag: data.tag || undefined,
        renotify: !!data.tag,
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        lang: 'de',
        timestamp: data.at ? Date.parse(data.at) : Date.now(),
        // Buttons (e.g. Werkstatt: "Freigeben" / "Ablehnen"): each one opens its own page in the app.
        actions: Array.isArray(data.actions) ? data.actions.slice(0, 2).map((a) => ({ action: a.action, title: a.title })) : [],
        data: { url: data.url || '/app', location_id: data.location_id || null, actions: Array.isArray(data.actions) ? data.actions : [] },
      });
      if (badge) await badge;
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/app', location_id: locationId = null, actions = [] } = event.notification.data || {};
  const picked = event.action ? actions.find((a) => a.action === event.action) : null;
  const wanted = String(picked ? picked.url : url);
  // Only pages of the app (a "//host" or another path would leave it); anything else opens the app's start page.
  const path = /^\/app(?:[/?#]|$)/.test(wanted) ? wanted : '/app';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).pathname.startsWith('/app'));
      if (open) {
        try {
          await open.focus();
          open.postMessage({ type: 'navigate', url: path, location_id: locationId });
          return;
        } catch {
          /* the window cannot be focused (iOS, a frozen page): open it again below */
        }
      }
      const target = new URL(path, self.location.origin);
      if (locationId) target.searchParams.set('loc', locationId);
      await self.clients.openWindow(target.toString());
    })(),
  );
});

/** The push service replaced or dropped the subscription (iOS does this now and then): subscribe again and tell the server. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const old = event.oldSubscription;
        const key = (old && old.options && old.options.applicationServerKey) || (await (await fetch('/api/push/public-key', { credentials: 'same-origin' })).json()).key;
        const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-pghl': '1' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      } catch {
        /* not signed in or offline: the app subscribes again the next time it is opened (web/src/ios/push.ts) */
      }
    })(),
  );
});
