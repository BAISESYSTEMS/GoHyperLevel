/* Boot guard: the app must never stay blank without saying why.
 *
 * A plain blocking script (the admin app's Content-Security-Policy allows no inline scripts), written in ES5 on
 * purpose: it has to run on a WebView too old to parse the app bundle, which is exactly when it is needed.
 *
 * - Buffers early `error`, `unhandledrejection`, failed <script>/<link> loads and CSP violations
 *   (window.__pghlBoot.errors) – the app itself only listens once it is up.
 * - The app sets `window.__pghlMounted = true` after its first render (web/src/boot.tsx).
 * - Not mounted after 10 s: a plain HTML page replaces the empty #root ("Die App konnte nicht starten", the error text,
 *   Neu laden, Offline-Daten löschen) and the buffered errors go to the automatic error capture of "Fehler & Wünsche"
 *   (POST /api/feedback/client-errors – kept only for users who allowed it, rate limited there and here).
 * - The Android app reads the same flag and #root to decide whether to show its own error screen.
 *
 * Tests: tests/boot-guard.test.ts runs this very file against a small fake DOM. */
(function () {
  'use strict';
  if (window.__pghlBoot) return;

  var MOUNT_TIMEOUT = 10000;
  var MAX_ERRORS = 20;
  var REPORT_COOLDOWN = 10 * 60 * 1000;
  var REPORT_KEY = 'pghl.bootreport';
  var HEAL_KEY = 'pghl.bootheal';
  var HEAL_COOLDOWN = 10 * 60 * 1000;

  var boot = (window.__pghlBoot = { errors: [], started: new Date().getTime(), reported: false, timeout: MOUNT_TIMEOUT });

  function clip(s, n) {
    s = String(s === undefined || s === null ? '' : s);
    return s.length > n ? s.slice(0, n) : s;
  }

  function add(kind, message, source, line, col, stack) {
    boot.errors.push({
      kind: kind,
      message: clip(message, 300) || 'Unbekannter Fehler',
      source: clip(source, 200),
      line: Number(line) || 0,
      col: Number(col) || 0,
      stack: clip(stack, 800),
      at: new Date().toISOString(),
    });
    if (boot.errors.length > MAX_ERRORS) boot.errors.splice(0, boot.errors.length - MAX_ERRORS);
  }

  /** The app adds what only it knows (a render error caught by its root boundary). */
  boot.add = add;

  window.addEventListener(
    'error',
    function (ev) {
      var t = ev && ev.target;
      if (t && t !== window && t.tagName) {
        // Failed loads of scripts and stylesheets do not bubble: only the capture phase sees them (images are noise).
        if (t.tagName === 'SCRIPT' || t.tagName === 'LINK') {
          var url = t.src || t.href || '';
          add('resource', 'Datei nicht geladen: ' + (url.replace(/^https?:\/\/[^/]+/, '') || t.tagName), url, 0, 0, '');
        }
        return;
      }
      var err = ev && ev.error;
      var message = err && err.message ? (err.name || 'Error') + ': ' + err.message : (ev && ev.message) || 'Fehler';
      add('error', message, ev && ev.filename, ev && ev.lineno, ev && ev.colno, err && err.stack);
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var message = r && r.message ? (r.name || 'Error') + ': ' + r.message : 'Unbehandelt: ' + clip(r, 200);
    add('rejection', message, '', 0, 0, r && r.stack);
  });
  document.addEventListener('securitypolicyviolation', function (ev) {
    add('csp', 'Blockiert (' + (ev.violatedDirective || 'CSP') + '): ' + (ev.blockedURI || ''), ev.sourceFile, ev.lineNumber, ev.columnNumber, '');
  });

  function root() {
    return document.getElementById('root');
  }

  /** True while the fallback page is what #root shows (the app replaces it when it mounts late). */
  boot.isShown = function () {
    return !!document.getElementById('pghl-boot-fallback');
  };

  /** True once the app has rendered (flag) and its page is really in #root. */
  boot.mounted = function () {
    var r = root();
    return window.__pghlMounted === true && !!r && r.childNodes.length > 0 && !boot.isShown();
  };

  /** One line per buffered error, newest last – what the fallback page and the report show. */
  boot.text = function (max) {
    var list = boot.errors.slice(-(max || 3));
    var lines = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      // A failed file already names itself in the message.
      lines.push(e.message + (e.source && e.kind !== 'resource' ? ' (' + e.source.replace(/^https?:\/\/[^/]+/, '') + (e.line ? ':' + e.line : '') + ')' : ''));
    }
    return lines.join('\n');
  };

  /** Unregisters every service worker and deletes every cache of this origin (promise, never rejects). */
  boot.clearOffline = function () {
    var jobs = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(
          navigator.serviceWorker.getRegistrations().then(function (list) {
            return Promise.all(
              list.map(function (r) {
                return r.unregister();
              }),
            );
          }),
        );
      }
      if (window.caches && caches.keys) {
        jobs.push(
          caches.keys().then(function (keys) {
            return Promise.all(
              keys.map(function (k) {
                return caches.delete(k);
              }),
            );
          }),
        );
      }
    } catch (e) {
      /* nothing to clear */
    }
    return Promise.all(
      jobs.map(function (j) {
        return j.catch(function () {});
      }),
    );
  };

  function dark() {
    try {
      return !!window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;
    }
  }

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.setAttribute('style', css);
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /** The fallback page, as plain DOM (the app's CSS may be the very thing that failed to load). */
  boot.render = function (target, reason) {
    if (!target) return;
    var night = dark();
    var fg = night ? '#f1f5f9' : '#0f172a';
    var muted = night ? '#94a3b8' : '#475569';
    var card = night ? '#1e293b' : '#f1f5f9';
    var button = 'font:inherit;font-weight:600;padding:12px 18px;margin:0 10px 10px 0;border-radius:10px;cursor:pointer;min-height:44px;';
    // padding inside the safe areas: on iPhone/iPad the page may run behind the notch and the home indicator (viewport-fit=cover)
    var wrap = el('div', 'box-sizing:border-box;max-width:520px;margin:0 auto;padding:32px 20px;padding:max(32px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(32px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));font:16px/1.5 system-ui,-apple-system,Roboto,sans-serif;color:' + fg);
    wrap.setAttribute('id', 'pghl-boot-fallback');
    wrap.setAttribute('role', 'alert');
    wrap.appendChild(el('h1', 'font-size:22px;margin:0 0 8px', 'Die App konnte nicht starten'));
    wrap.appendChild(el('p', 'margin:0 0 16px;color:' + muted, 'Die Oberfläche wurde nicht geladen. Meist hilft Neu laden; wenn nicht, die gespeicherten Offline-Daten löschen.'));
    var detail = clip(reason, 300) || boot.text(3) || 'Keine Fehlermeldung – eine Datei der App kam nicht an oder wurde blockiert.';
    wrap.appendChild(el('pre', 'white-space:pre-wrap;word-break:break-word;margin:0 0 16px;padding:12px;border-radius:10px;font:12px/1.4 ui-monospace,monospace;background:' + card + ';color:' + fg, detail));
    var status = el('p', 'margin:0 0 12px;color:' + muted + ';min-height:1.4em');
    var reload = el('button', button + 'border:0;background:#2563eb;color:#fff', 'Neu laden');
    reload.setAttribute('type', 'button');
    reload.addEventListener('click', function () {
      location.reload();
    });
    var clear = el('button', button + 'border:1px solid ' + muted + ';background:transparent;color:' + fg, 'Offline-Daten löschen');
    clear.setAttribute('type', 'button');
    clear.addEventListener('click', function () {
      status.textContent = 'Wird gelöscht …';
      boot.clearOffline().then(function () {
        status.textContent = 'Gelöscht – die App lädt neu.';
        location.reload();
      });
    });
    wrap.appendChild(status);
    wrap.appendChild(reload);
    wrap.appendChild(clear);
    var ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    wrap.appendChild(el('p', 'margin:16px 0 0;font-size:12px;color:' + muted + ';word-break:break-word', clip(ua, 160)));
    while (target.firstChild) target.removeChild(target.firstChild);
    target.appendChild(wrap);
  };

  function buildId() {
    try {
      var s = document.querySelector('script[type="module"][src*="/assets/"]');
      var m = s && /index-([\w-]+)\.js/.exec(s.getAttribute('src') || '');
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  function loadedAssets() {
    try {
      var list = performance.getEntriesByType('resource');
      var n = 0;
      for (var i = 0; i < list.length; i++) if (/\/assets\//.test(list[i].name)) n++;
      return n;
    } catch (e) {
      return -1;
    }
  }

  /**
   * Sends the buffered errors to the automatic error capture (once per page, at most every 10 minutes per device).
   * The server keeps them only for users who allowed automatic reports and groups equal ones into one ticket.
   */
  boot.report = function (reason, headline) {
    if (boot.reported || typeof fetch !== 'function') return false;
    try {
      var last = Number(localStorage.getItem(REPORT_KEY) || 0);
      if (new Date().getTime() - last < REPORT_COOLDOWN) return false;
      localStorage.setItem(REPORT_KEY, String(new Date().getTime()));
    } catch (e) {
      /* storage blocked: report anyway, once per page */
    }
    boot.reported = true;
    var first = headline || (boot.errors.length ? boot.errors[0].message : 'ohne Fehlermeldung');
    var errors = [
      {
        message: 'App-Start fehlgeschlagen (' + clip(reason, 80) + '): ' + clip(first, 200),
        stack: 'Geladene /assets/-Dateien: ' + loadedAssets() + '; readyState=' + document.readyState + '; online=' + (navigator.onLine !== false),
        source: '',
        line: 0,
        col: 0,
        at: new Date().toISOString(),
      },
    ];
    var rest = boot.errors.slice(-4);
    for (var i = 0; i < rest.length; i++) errors.push({ message: rest[i].message, stack: rest[i].stack, source: rest[i].source, line: rest[i].line, col: rest[i].col, at: rest[i].at });
    try {
      var p = fetch('/api/feedback/client-errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pghl': '1' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify({ errors: errors, diagnostics: { route: location.pathname, user_agent: navigator.userAgent, build: buildId(), online: navigator.onLine !== false } }),
      });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {
      /* offline: not worth retrying */
    }
    return true;
  };

  /** Called by the timer and by the app's root error boundary. */
  boot.fail = function (reason) {
    var r = root();
    if (!r) return false;
    boot.render(r, reason ? clip(reason, 300) + (boot.errors.length ? '\n' + boot.text(2) : '') : '');
    boot.report(reason ? 'Darstellungsfehler' : 'nicht gestartet nach ' + Math.round(MOUNT_TIMEOUT / 1000) + ' s', reason);
    return true;
  };

  /**
   * A service worker controls this blank page: its cache may be what is broken. Clear it and reload once (at most
   * every 10 minutes) before showing the fallback page. Returns true when it started.
   */
  boot.heal = function () {
    try {
      if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) return false;
      var last = Number(localStorage.getItem(HEAL_KEY) || 0);
      if (new Date().getTime() - last < HEAL_COOLDOWN) return false;
      localStorage.setItem(HEAL_KEY, String(new Date().getTime()));
    } catch (e) {
      return false;
    }
    add('heal', 'Offline-Daten automatisch gelöscht (Service Worker aktiv, App nicht gestartet)', '', 0, 0, '');
    boot.clearOffline().then(function () {
      location.reload();
    });
    return true;
  };

  /**
   * The 10 s check. A page that is still downloading without any error (slow connection) gets up to 30 s before it is
   * called failed; anything that went wrong is shown at once.
   */
  boot.check = function () {
    if (boot.mounted()) return false;
    var waited = new Date().getTime() - boot.started;
    if (!boot.errors.length && document.readyState !== 'complete' && waited < 3 * MOUNT_TIMEOUT) {
      setTimeout(boot.check, MOUNT_TIMEOUT / 2);
      return false;
    }
    if (boot.heal()) return true;
    return boot.fail('');
  };

  setTimeout(boot.check, MOUNT_TIMEOUT);
})();
