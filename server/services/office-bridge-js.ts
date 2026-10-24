/**
 * The load/save bridge that runs inside an editor page (/office/app/<kind>/), before the editor's own code. The editors are
 * unmodified upstream WebAssembly builds that know only the browser's file picker, drag & drop and downloads – no API to hand them
 * a file or to get one back (docs/office.md#how-the-editors-load-and-save). So the bridge:
 *
 * - LOAD: waits until the editor has started, then drops the file on its canvas as a synthetic drag & drop (a real `File` in a
 *   `DataTransfer` – exactly what the editor receives when a person drops a file). The PDF editor instead reads `?file=` itself.
 * - SAVE: remembers every Blob the page turns into an object URL and catches the click on the hidden download link the editor
 *   creates when it saves; a file of the editor's own kind goes to HyperLevel (postMessage) instead of the download folder, anything
 *   else (a PDF export of a document …) is downloaded as usual and announced to HyperLevel, which offers to keep it.
 * - "Speichern" in HyperLevel presses Ctrl/Cmd+S in the editor (Ctrl/Cmd+Shift+S – Save As – for the spreadsheet editor, which saves a
 *   dropped file only that way) – the editor's own save, caught as above. The presentation editor saves its native format
 *   (.deckcraft); HyperLevel converts it to .pptx with the engine.
 *
 * Messages are bound to a channel id the parent puts into the page's #hash, and only exchanged with `window.parent`.
 * Plain ES5 without template literals: the text is served as is (no build step).
 */
export const BRIDGE_JS = String.raw`(function () {
  'use strict';
  var me = document.currentScript;
  var KIND = (me && me.getAttribute('data-kind')) || '';
  var EXTS = ((me && me.getAttribute('data-exts')) || '').split(',');
  var TARGET = (me && me.getAttribute('data-target')) || '*';
  var MAX = Number((me && me.getAttribute('data-max')) || 0) || 26214400;
  var SAVE_SHIFT = !!me && me.getAttribute('data-save') === 'shift';
  var channel = (String(location.hash).match(/[#&]c=([A-Za-z0-9_-]{8,64})/) || [])[1] || '';
  var parentWin = window.parent && window.parent !== window ? window.parent : null;
  var blobs = Object.create(null);
  var started = false;
  var readyPosted = false;
  var pending = null;

  function post(msg, transfer) {
    if (!parentWin || !channel) return;
    msg.channel = channel;
    msg.source = 'pghl-office';
    try { parentWin.postMessage(msg, TARGET, transfer || []); } catch (e) { try { parentWin.postMessage(msg, TARGET); } catch (e2) { /* gone */ } }
  }
  function extOf(name) { var m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }

  // --- SAVE: remember blobs, catch the download link -------------------------------------------------------------------
  var createURL = URL.createObjectURL.bind(URL);
  var revokeURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var url = createURL(obj);
    if (obj && typeof Blob !== 'undefined' && obj instanceof Blob && obj.size <= MAX) blobs[url] = obj;
    return url;
  };
  URL.revokeObjectURL = function (url) {
    // the editor may revoke right after click(); the bridge reads the Blob it kept, then forgets it
    setTimeout(function () { delete blobs[url]; }, 30000);
    return revokeURL(url);
  };
  function handOver(a) {
    var href = a.getAttribute('href') || '';
    var name = a.getAttribute('download');
    if (name === null || href.indexOf('blob:') !== 0) return false;
    var blob = blobs[href];
    if (!blob) return false;
    var ext = extOf(name);
    var own = EXTS.indexOf(ext) >= 0;
    blob.arrayBuffer().then(function (buf) {
      post({ type: own ? 'saved' : 'exported', name: name, ext: ext, size: buf.byteLength, bytes: buf }, [buf]);
    });
    return own;
  }
  var nativeClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = function () {
    if (this instanceof HTMLAnchorElement && handOver(this)) return undefined;
    return nativeClick.apply(this, arguments);
  };
  // links clicked through a dispatched event instead of click()
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (a && handOver(a)) e.preventDefault();
  }, true);

  // --- LOAD: drop the file on the editor's canvas ------------------------------------------------------------------------
  function canvas() { return document.querySelector('canvas'); }
  function drop(name, type, bytes) {
    var c = canvas();
    if (!c || typeof DataTransfer === 'undefined') { post({ type: 'error', message: 'drop-unsupported' }); return; }
    var file = new File([bytes], name, { type: type || 'application/octet-stream', lastModified: Date.now() });
    var dt = new DataTransfer();
    dt.items.add(file);
    ['dragenter', 'dragover', 'drop'].forEach(function (t) {
      var ev;
      try { ev = new DragEvent(t, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }); } catch (e) {
        ev = new Event(t, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
      }
      c.dispatchEvent(ev);
    });
    post({ type: 'loaded', name: name });
  }

  // --- the editor's own save, pressed from HyperLevel ------------------------------------------------------------------------
  function pressSave() {
    var c = canvas();
    if (!c) return;
    try { c.focus(); } catch (e) { /* not focusable */ }
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    var init = { key: SAVE_SHIFT ? 'S' : 's', code: 'KeyS', keyCode: 83, which: 83, bubbles: true, cancelable: true, composed: true, ctrlKey: !mac, metaKey: mac, shiftKey: SAVE_SHIFT };
    c.dispatchEvent(new KeyboardEvent('keydown', init));
    c.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  window.addEventListener('message', function (e) {
    if (!parentWin || e.source !== parentWin) return;
    var d = e.data;
    if (!d || d.channel !== channel || d.source !== 'pghl-office-host') return;
    if (d.type === 'load' && d.bytes) {
      if (started) drop(String(d.name || ('datei.' + KIND)), d.mime, d.bytes);
      else pending = d;
    } else if (d.type === 'save') pressSave();
    else if (d.type === 'ping') post({ type: started ? 'ready' : 'starting' });
  });

  // --- ready: the editor has started and listens to drops --------------------------------------------------------------
  function markReady() {
    if (readyPosted) return;
    readyPosted = true;
    // two frames for the editor's first paint (its event handlers are in place by then)
    requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(function () {
      started = true;
      post({ type: 'ready' });
      if (pending) { var p = pending; pending = null; drop(String(p.name || ('datei.' + KIND)), p.mime, p.bytes); }
    }, 250); }); });
  }
  window.addEventListener('TrunkApplicationStarted', markReady);
  var polls = 0;
  var timer = setInterval(function () {
    polls++;
    var loading = document.querySelector('[id$="_loading"]');
    var c = canvas();
    // the editors remove their "Loading …" note once running; without one, wait until the canvas got its real size
    if (c && ((!loading && c.width !== 300) || polls > 100)) { clearInterval(timer); markReady(); }
  }, 100);
  window.addEventListener('error', function (e) { post({ type: 'error', message: String((e && e.message) || 'error').slice(0, 300) }); });
  post({ type: 'starting' });
})();
`;
