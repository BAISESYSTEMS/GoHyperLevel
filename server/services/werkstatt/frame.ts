import { randomBytes } from 'node:crypto';
import { escapeHtml } from '../../core/template.js';

/**
 * The two documents behind a plugin's user interface.
 *
 *  1. HOST page (`/plugin-host/<plugin>`): our own trusted page, framed by the app. Its strict CSP allows
 *     no frames except our own origin and no connections except our own origin, so whatever happens inside
 *     the plugin frame cannot navigate away or phone home even though the app's own CSP allows https frames.
 *     It embeds the plugin frame, relays the plugin's postMessages to `POST /api/plugins/<id>/call` (same
 *     origin, the user's session – the plugin never sees a cookie or token) and passes resize/toast/navigate
 *     on to the app.
 *  2. PLUGIN frame (`/plugin-frame/<version>`): `<iframe sandbox="allow-scripts">` WITHOUT allow-same-origin,
 *     so it has an opaque origin: no cookies, no storage, no access to the host page or the app. Its response
 *     CSP (also `sandbox allow-scripts`, so opening the URL directly is just as isolated) allows only inline
 *     script/style and data: images – plus hosts the manifest declared and an admin allowed. It talks to the
 *     host through postMessage only, via the small `gohigh` bootstrap below.
 */

/** CSP of the plugin frame; `hosts` are the admin-approved external hosts of this plugin. */
export function frameCsp(hosts: string[]): string {
  const h = hosts.map((x) => ` https://${x}`).join('');
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline'${h}`,
    `style-src 'unsafe-inline'${h}`,
    `img-src data: blob:${h}`,
    `font-src data:${h}`,
    `media-src data: blob:${h}`,
    `connect-src ${hosts.length ? hosts.map((x) => `https://${x}`).join(' ') : "'none'"}`,
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** CSP of the trusted host page. */
export function hostCsp(nonce: string): string {
  return [`default-src 'none'`, `script-src 'nonce-${nonce}'`, `style-src 'unsafe-inline'`, `frame-src 'self'`, `connect-src 'self'`, `img-src data:`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'self'`].join('; ');
}

/** Response headers every plugin document gets (on top of the CSP). */
export const FRAME_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-dns-prefetch-control': 'off',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(), display-capture=(), publickey-credentials-get=()',
};

const BASE_CSS = `
:root{--bg:#f4f6fa;--panel:#fff;--text:#111827;--muted:#6b7280;--line:#e5e7eb;--brand:#2563eb;--brand-soft:#eff6ff;--green:#059669;--red:#dc2626;--yellow:#d97706;--radius:10px;color-scheme:light}
:root[data-theme=dark]{--bg:#0b1020;--panel:#121a2e;--text:#e5e7eb;--muted:#94a3b8;--line:#233049;--brand:#3b82f6;--brand-soft:#172554;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--text);font:14px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
body{padding:12px}
h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:0 0 8px}h3{font-size:14px;margin:0 0 6px}
a{color:var(--brand)}
.muted{color:var(--muted)}.small{font-size:12px}
.gh-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:12px;margin-bottom:10px}
.gh-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.gh-grow{flex:1;min-width:0}
.gh-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
.gh-btn{font:inherit;border:1px solid var(--brand);background:var(--brand);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}
.gh-btn.secondary{background:transparent;color:var(--text);border-color:var(--line)}
.gh-btn:disabled{opacity:.5;cursor:default}
.gh-input,.gh-select,.gh-textarea{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 8px;max-width:100%}
.gh-table{width:100%;border-collapse:collapse}.gh-table th,.gh-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}.gh-table th{color:var(--muted);font-weight:600;font-size:12px}
.gh-badge{display:inline-block;border-radius:99px;padding:1px 8px;font-size:12px;background:var(--brand-soft);color:var(--brand)}
.gh-badge.green{background:rgba(16,185,129,.16);color:var(--green)}.gh-badge.red{background:rgba(220,38,38,.14);color:var(--red)}.gh-badge.yellow{background:rgba(217,119,6,.16);color:var(--yellow)}
.gh-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--muted)}.gh-dot.green{background:var(--green)}.gh-dot.red{background:var(--red)}.gh-dot.yellow{background:var(--yellow)}
.gh-empty{color:var(--muted);text-align:center;padding:16px}
`;

/** The `gohigh` object of the UI. Runs first in the plugin frame; talks to the host page only through postMessage. */
const BOOTSTRAP = String.raw`
(function () {
  'use strict';
  var host = window.parent, seq = 0, pending = {}, inited = false, waiting = [], ctx = null;
  function post(m) { m.gh = 1; try { host.postMessage(m, '*'); } catch (e) {} }
  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      post({ type: 'call', id: id, op: String(op), args: args === undefined ? null : args });
    });
  }
  function report(e) {
    post({ type: 'error', message: String((e && e.message) || e || 'Fehler').slice(0, 300), stack: String((e && e.stack) || '').slice(0, 1500) });
  }
  var api = {
    call: call,
    ready: function (cb) { if (typeof cb !== 'function') return; if (inited) { try { cb(ctx); } catch (e) { report(e); } } else waiting.push(cb); },
    resize: function (h) { post({ type: 'resize', height: Math.max(40, Math.min(4000, Math.round(Number(h) || 0))) }); },
    toast: function (text, kind) { post({ type: 'toast', text: String(text).slice(0, 200), kind: kind === 'error' ? 'error' : 'ok' }); },
    navigate: function (path) { post({ type: 'navigate', path: String(path).slice(0, 200) }); },
    log: function () { try { console.log.apply(console, arguments); } catch (e) {} },
    context: null
  };
  window.addEventListener('message', function (e) {
    if (e.source !== host) return;
    var m = e.data;
    if (!m || m.gh !== 1) return;
    if (m.type === 'result') {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.ok) p.resolve(m.data);
      else { var err = new Error(m.error || 'Fehler'); err.status = m.status; p.reject(err); }
    } else if (m.type === 'init') {
      ctx = m.context;
      api.context = ctx;
      if (m.theme) document.documentElement.setAttribute('data-theme', m.theme.dark ? 'dark' : 'light');
      if (m.theme && m.theme.brand) document.documentElement.style.setProperty('--brand', m.theme.brand);
      (m.ops || []).forEach(function (op) {
        var parts = op.split('.');
        if (!api[parts[0]]) api[parts[0]] = {};
        api[parts[0]][parts[1]] = function (args) { return call(op, args); };
      });
      inited = true;
      waiting.splice(0).forEach(function (cb) { try { cb(ctx); } catch (e) { report(e); } });
    }
  });
  window.addEventListener('error', function (e) { report(e.error || { message: e.message }); });
  window.addEventListener('unhandledrejection', function (e) { report(e.reason); });
  // Links never navigate the frame: internal pages go through the app, everything else is dropped.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    e.preventDefault();
    var m = /^(?:\/app\/)?([a-z0-9-]+(?:\/[A-Za-z0-9._~%-]+){0,4})$/.exec(href);
    if (m) api.navigate(m[1]);
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
  // WebRTC can phone home without a CSP directive: not available inside plugins.
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription'].forEach(function (k) { try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch (e) {} });
  Object.defineProperty(window, 'gohigh', { value: api, writable: false, configurable: false });
  if (typeof ResizeObserver === 'function') {
    var last = 0;
    new ResizeObserver(function () { var h = Math.ceil(document.documentElement.getBoundingClientRect().height); if (h !== last) { last = h; post({ type: 'size', height: h }); } }).observe(document.documentElement);
  }
  post({ type: 'hello' });
})();
`;

export interface FrameOptions {
  html: string;
  title: string;
  theme: 'light' | 'dark';
  hosts: string[];
}

/** The document inside the sandboxed frame: base styles, the bootstrap, then the plugin's own markup and scripts. */
export function buildFrameDoc(o: FrameOptions): { html: string; csp: string } {
  const html = `<!doctype html>
<html lang="de" data-theme="${o.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(o.title)}</title>
<style>${BASE_CSS}</style>
<script>${BOOTSTRAP}</script>
</head><body>
${o.html}
</body></html>`;
  return { html, csp: frameCsp(o.hosts) };
}

// --- the trusted host page ----------------------------------------------------------------------------------

export interface HostConfig {
  pluginId: string;
  name: string;
  version: string;
  /** Plugin frame address (/plugin-frame/<version>?…). */
  frameUrl: string;
  /** Bridge endpoints (relative, same origin); empty in demo mode. */
  callUrl: string;
  reportUrl: string;
  locationId: string;
  demo: boolean;
  ops: string[];
  /** Sample data per operation (demo mode only). */
  samples: Record<string, unknown>;
  context: Record<string, unknown>;
  theme: { dark: boolean; brand: string };
  entry: { kind: string; id: string };
  entity: { type: string; id: string } | null;
  /** Fixed height for panels, 0 = follow the content. */
  height: number;
}

const HOST_SCRIPT = String.raw`
(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var frame = document.getElementById('f');
  var hello = false, dead = false, inflight = 0, mem = {};
  var NAV = /^[a-z0-9-]+(?:\/[A-Za-z0-9._~%-]+){0,4}(?:\?[A-Za-z0-9=&_.%+-]*)?$/;
  function toFrame(m) { m.gh = 1; try { frame.contentWindow.postMessage(m, '*'); } catch (e) {} }
  function toApp(m) { m.pghl = 'plugin'; m.plugin = cfg.pluginId; m.entry = cfg.entry.kind + ':' + cfg.entry.id; try { window.parent.postMessage(m, location.origin); } catch (e) {} }
  function stop(message) {
    if (dead) return;
    dead = true;
    frame.removeAttribute('src');
    frame.style.display = 'none';
    var box = document.getElementById('dead');
    box.textContent = message;
    box.style.display = 'block';
    report(message, '');
    toApp({ type: 'dead', message: message });
  }
  function report(message, stack) {
    if (cfg.demo || !cfg.reportUrl) return;
    try { fetch(cfg.reportUrl, { method: 'POST', headers: headers(), body: JSON.stringify({ message: message, stack: stack, entry: cfg.entry.kind + ':' + cfg.entry.id }) }); } catch (e) {}
  }
  function headers() { return { 'content-type': 'application/json', 'x-pghl': '1', 'x-location-id': cfg.locationId }; }
  function demoCall(op, args) {
    if (op.indexOf('storage.') === 0) {
      if (op === 'storage.get') return Promise.resolve(Object.prototype.hasOwnProperty.call(mem, args.key) ? mem[args.key] : null);
      if (op === 'storage.set') { mem[args.key] = args.value; return Promise.resolve({ ok: true }); }
      if (op === 'storage.remove') { delete mem[args.key]; return Promise.resolve({ ok: true }); }
      return Promise.resolve(Object.keys(mem).map(function (k) { return { key: k, value: mem[k] }; }));
    }
    if (cfg.ops.indexOf(op) < 0) return Promise.reject({ status: 403, error: 'Diese Funktion hat das Plugin nicht angefragt.' });
    return Promise.resolve(cfg.samples[op] === undefined ? null : cfg.samples[op]);
  }
  function realCall(op, args) {
    return fetch(cfg.callUrl, { method: 'POST', headers: headers(), body: JSON.stringify({ op: op, args: args, entry: cfg.entry.kind + ':' + cfg.entry.id, entity: cfg.entity }) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw { status: r.status, error: (j && j.error) || ('Fehler ' + r.status) }; return j.data; });
    });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== frame.contentWindow || dead) return;
    var m = e.data;
    if (!m || m.gh !== 1) return;
    if (m.type === 'hello') { hello = true; toFrame({ type: 'init', ops: cfg.ops, context: cfg.context, theme: cfg.theme }); }
    else if (m.type === 'call') {
      if (typeof m.id !== 'number' || typeof m.op !== 'string') return;
      if (inflight >= 20) return toFrame({ type: 'result', id: m.id, ok: false, error: 'Zu viele gleichzeitige Aufrufe.', status: 429 });
      inflight++;
      (cfg.demo ? demoCall(m.op, m.args || {}) : realCall(m.op, m.args)).then(
        function (data) { inflight--; toFrame({ type: 'result', id: m.id, ok: true, data: data }); },
        function (err) { inflight--; toFrame({ type: 'result', id: m.id, ok: false, error: String((err && err.error) || (err && err.message) || 'Fehler').slice(0, 300), status: (err && err.status) || 500 }); }
      );
    } else if (m.type === 'error') report(String(m.message || '').slice(0, 300), String(m.stack || '').slice(0, 1500));
    else if (m.type === 'size') { window.__ghSize = { at: Date.now() }; if (!cfg.height) toApp({ type: 'resize', height: Math.min(4000, Number(m.height) || 0) }); }
    else if (m.type === 'resize') toApp({ type: 'resize', height: Math.min(4000, Number(m.height) || 0) });
    else if (m.type === 'toast') toApp({ type: 'toast', text: String(m.text || '').slice(0, 200), kind: m.kind === 'error' ? 'error' : 'ok' });
    else if (m.type === 'navigate') { if (typeof m.path === 'string' && NAV.test(m.path)) toApp({ type: 'navigate', path: m.path }); }
  });
  // The frame loads exactly once. A second load event means the plugin navigated (or reloaded) somewhere else: switch it
  // off. (The first load fires after the plugin's scripts ran and said hello – so "hello seen" is no sign of a navigation.)
  var loads = 0;
  frame.src = cfg.frameUrl;
  frame.addEventListener('load', function () { if (++loads > 1) stop('Das Plugin wurde beendet: Es hat versucht, die Seite zu verlassen.'); });
})();
`;

export function buildHostPage(cfg: HostConfig): { html: string; csp: string } {
  const nonce = randomBytes(16).toString('base64url');
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(cfg.name)}</title>
<style>html,body{margin:0;height:100%;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}#dead{display:none;padding:14px;font:14px system-ui,sans-serif;color:#b91c1c}</style>
</head><body>
<iframe id="f" sandbox="allow-scripts" title="${escapeHtml(cfg.name)}" referrerpolicy="no-referrer" allow="" loading="eager"></iframe>
<div id="dead" role="alert"></div>
<script type="application/json" id="cfg">${json}</script>
<script nonce="${nonce}">${HOST_SCRIPT}</script>
</body></html>`;
  return { html, csp: hostCsp(nonce) };
}
