/**
 * Source of the sandbox child process (run with `node --permission -e <source>`; see sandbox.ts).
 * It is a string so it ships with the compiled server without an extra build step and the child needs no file
 * access at all. Layers, outermost first:
 *   - separate process: no environment, memory cap (--max-old-space-size), hard kill by the parent on timeout;
 *   - Node permission model (`--permission` without any --allow-*): no file system, child process, worker,
 *     addon or WASI access. The network is NOT covered by it in Node 22 – so
 *   - optionally a new network namespace (`unshare -rn`, when the host allows it), and always
 *   - this script closes the network modules before anything of the plugin runs, and
 *   - the plugin code runs in a fresh `vm` context that has no `process`, `require`, `fetch`, timers, buffers or
 *     `eval` (codeGeneration strings off) – only the JSON built-ins and the `gohigh` API defined *inside* it.
 *     No host object is ever passed into the context: requests leave and answers arrive as JSON strings, so
 *     there is no function or prototype to climb out on.
 * `vm` is not a security boundary on its own (Node says so); the point of the layers is that an escape from it
 * would still land in a process without files, children, workers or (where supported) network.
 */

/** Runs inside the plugin context: the `gohigh` API of server logic. No backticks or ${ in here (it is embedded as a string). */
const BOOT_SERVER = String.raw`
(function (global) {
  'use strict';
  const outbox = [];
  const pending = new Map();
  const logs = [];
  const handlers = { action: Object.create(null), job: Object.create(null) };
  let seq = 0;
  let state = { done: false };
  const call = function (op, args) {
    return new Promise(function (resolve, reject) {
      const id = ++seq;
      let payload;
      try { payload = JSON.stringify({ id: id, op: String(op), args: args === undefined ? null : args }); } catch (e) { reject(new Error('Die Eingabe ist kein gültiges JSON.')); return; }
      pending.set(id, { resolve: resolve, reject: reject });
      outbox.push(payload);
    });
  };
  const fail = function (e) { state = { done: true, ok: false, error: String((e && e.message) || e).slice(0, 400), errorType: String((e && e.name) || 'Error').slice(0, 40) }; };
  return {
    setup: function (opsJson, ctxJson) {
      const api = {
        call: call,
        log: function () { if (logs.length < 100) logs.push(Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ').slice(0, 300)); },
        action: function (id, fn) { if (typeof fn === 'function') handlers.action[String(id)] = fn; },
        job: function (id, fn) { if (typeof fn === 'function') handlers.job[String(id)] = fn; },
        context: Object.freeze(JSON.parse(ctxJson))
      };
      for (const op of JSON.parse(opsJson)) {
        const parts = op.split('.');
        if (!api[parts[0]]) api[parts[0]] = {};
        api[parts[0]][parts[1]] = function (args) { return call(op, args); };
      }
      for (const k of Object.keys(api)) if (api[k] && typeof api[k] === 'object' && k !== 'context') Object.freeze(api[k]);
      global.gohigh = Object.freeze(api);
      for (const k of ['ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly', 'FinalizationRegistry', 'WeakRef', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']) { try { delete global[k]; } catch (e) {} }
    },
    drain: function () { return JSON.stringify(outbox.splice(0, outbox.length)); },
    deliver: function (json) {
      const m = JSON.parse(json);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.data); else p.reject(new Error(String(m.error)));
    },
    start: function (kind, id, inputJson) {
      const fn = handlers[kind] && handlers[kind][id];
      if (typeof fn !== 'function') { fail(new Error('Kein Handler für ' + kind + ' „' + id + '“ registriert.')); return; }
      let p;
      try { p = Promise.resolve(fn(JSON.parse(inputJson))); } catch (e) { fail(e); return; }
      p.then(function (v) { try { state = { done: true, ok: true, value: JSON.stringify(v === undefined ? null : v) }; } catch (e) { fail(e); } }, fail);
    },
    registered: function () { return JSON.stringify({ action: Object.keys(handlers.action), job: Object.keys(handlers.job) }); },
    state: function () { return JSON.stringify(state); },
    logs: function () { return JSON.stringify(logs); }
  };
})(globalThis)
`;

/** Runs inside the plugin context: a stand-in browser (every DOM property exists) and the `gohigh` API of the UI. */
const BOOT_UI = String.raw`
(function (global) {
  'use strict';
  const outbox = [];
  const pending = new Map();
  const errors = [];
  const handlers = { ready: [], timers: [] };
  let seq = 0;
  const call = function (op, args) {
    return new Promise(function (resolve, reject) {
      const id = ++seq;
      let payload;
      try { payload = JSON.stringify({ id: id, op: String(op), args: args === undefined ? null : args }); } catch (e) { reject(new Error('Die Eingabe ist kein gültiges JSON.')); return; }
      pending.set(id, { resolve: resolve, reject: reject });
      outbox.push(payload);
    });
  };
  const note = function (e) { if (errors.length < 20) errors.push({ type: String((e && e.name) || 'Error').slice(0, 40), message: String((e && e.message) || e).slice(0, 300) }); };
  // A stand-in that accepts every property, call and construction: enough to run a page's scripts once.
  const stub = function () {
    const f = function () {};
    return new Proxy(f, {
      get: function (t, k) {
        if (k === Symbol.toPrimitive) return function () { return ''; };
        if (k === Symbol.iterator) return function () { return [][Symbol.iterator](); };
        if (k === 'then' || k === 'toJSON') return undefined;
        if (k === 'length') return 0;
        return stub();
      },
      set: function () { return true; },
      has: function () { return true; },
      apply: function () { return stub(); },
      construct: function () { return stub(); }
    });
  };
  const listeners = [];
  const doc = new Proxy(stub(), {
    get: function (t, k) {
      if (k === 'addEventListener') return function (type, fn) { if (typeof fn === 'function') listeners.push([String(type), fn]); };
      if (k === 'readyState') return 'loading';
      if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return function () { return []; };
      return t[k];
    },
    set: function () { return true; }
  });
  for (const n of ['navigator', 'location', 'history', 'screen', 'alert', 'confirm', 'prompt', 'getComputedStyle', 'matchMedia', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Image', 'FormData', 'Blob', 'performance', 'structuredClone', 'atob', 'btoa', 'crypto', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'Option', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'AbortController', 'localStorage', 'sessionStorage']) { try { global[n] = stub(); } catch (e) {} }
  global.document = doc;
  global.window = global;
  global.self = global;
  global.setTimeout = function (fn) { if (typeof fn === 'function') handlers.timers.push(fn); return 1; };
  global.setInterval = function (fn) { if (typeof fn === 'function') handlers.timers.push(fn); return 1; };
  global.clearTimeout = global.clearInterval = function () {};
  global.queueMicrotask = function (fn) { Promise.resolve().then(fn); };
  global.addEventListener = function (type, fn) { if (typeof fn === 'function') listeners.push([String(type), fn]); };
  global.removeEventListener = function () {};
  const api = {
    call: call,
    ready: function (fn) { if (typeof fn === 'function') handlers.ready.push(fn); },
    on: function () {},
    log: function () {},
    toast: function () {},
    navigate: function () {},
    resize: function () {},
    context: null
  };
  return {
    setup: function (opsJson, ctxJson) {
      api.context = Object.freeze(JSON.parse(ctxJson));
      for (const op of JSON.parse(opsJson)) {
        const parts = op.split('.');
        if (!api[parts[0]]) api[parts[0]] = {};
        api[parts[0]][parts[1]] = function (args) { return call(op, args); };
      }
      global.gohigh = api;
    },
    fire: function () {
      for (const l of listeners.slice()) if (l[0] === 'DOMContentLoaded' || l[0] === 'load') { try { l[1]({ type: l[0] }); } catch (e) { note(e); } }
      for (const fn of handlers.ready.splice(0)) { try { const r = fn(api.context); if (r && typeof r.then === 'function') r.then(null, note); } catch (e) { note(e); } }
      for (const fn of handlers.timers.splice(0, 20)) { try { const r = fn(); if (r && typeof r.then === 'function') r.then(null, note); } catch (e) { note(e); } }
    },
    note: function (type, message) { note({ name: type, message: message }); },
    drain: function () { return JSON.stringify(outbox.splice(0, outbox.length)); },
    deliver: function (json) {
      const m = JSON.parse(json);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.data); else p.reject(new Error(String(m.error)));
    },
    pending: function () { return pending.size; },
    errors: function () { return JSON.stringify(errors); }
  };
})(globalThis)
`;

/** The process itself (host side of the vm context). */
const MAIN = String.raw`
const vm = require('node:vm');
const ORIG = {};

// ---- 1. close the network doors before any plugin code exists ----------------------------------------
// Only the functions that open connections are replaced (replacing whole classes breaks Node's own stdio).
(function lockdown() {
  const fail = function (what) { return function () { throw new Error('In der Sandbox gesperrt: ' + what); }; };
  const wrap = function (obj, keys, what) {
    for (const k of keys) { if (obj && typeof obj[k] === 'function') { try { obj[k] = fail(what + '.' + k); } catch (e) { /* frozen */ } } }
  };
  const load = function (n) { try { return require('node:' + n); } catch (e) { return null; } };
  const net = load('net');
  if (net) { ORIG.Socket = net.Socket; ORIG.socketConnect = net.Socket.prototype.connect; wrap(net, ['connect', 'createConnection', 'createServer'], 'net'); wrap(net.Socket.prototype, ['connect'], 'net.Socket'); wrap(net.Server.prototype, ['listen'], 'net.Server'); }
  const tls = load('tls'); if (tls) wrap(tls, ['connect', 'createServer'], 'tls');
  for (const n of ['http', 'https']) { const m = load(n); if (m) wrap(m, ['request', 'get', 'createServer'], n); }
  const http2 = load('http2'); if (http2) wrap(http2, ['connect', 'createServer', 'createSecureServer'], 'http2');
  const dgram = load('dgram'); if (dgram) { wrap(dgram, ['createSocket'], 'dgram'); wrap(dgram.Socket.prototype, ['send', 'bind', 'connect'], 'dgram.Socket'); }
  const dns = load('dns');
  if (dns) {
    const keep = ['Resolver', 'getServers', 'setServers', 'setDefaultResultOrder', 'getDefaultResultOrder'];
    wrap(dns, Object.keys(dns).filter(function (k) { return keep.indexOf(k) < 0; }), 'dns');
    wrap(dns.promises, Object.keys(dns.promises || {}).filter(function (k) { return keep.indexOf(k) < 0; }), 'dns.promises');
  }
  for (const g of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers', 'FormData', 'BroadcastChannel', 'MessageChannel', 'Worker']) {
    try { Object.defineProperty(globalThis, g, { value: undefined, configurable: true, writable: true }); } catch (e) {}
  }
})();

const send = function (m) { try { process.send(m); } catch (e) {} };
let finished = false;
const finish = function (r) {
  if (finished) return;
  finished = true;
  try { process.send(Object.assign({ t: 'done' }, r), function () { process.exit(0); }); } catch (e) { process.exit(0); }
  setTimeout(function () { process.exit(0); }, 500);
};
const errText = function (e) { return String((e && e.message) || e).slice(0, 400); };
const errType = function (e) { return String((e && e.name) || 'Error').slice(0, 40); };
process.on('uncaughtException', function (e) { finish({ ok: false, error: 'Fehler: ' + errText(e), errorType: errType(e) }); });
process.on('unhandledRejection', function (e) { finish({ ok: false, error: 'Unbehandelter Fehler: ' + errText(e), errorType: errType(e) }); });

const FLUSH = new vm.Script('0');
const NO_BUFFERS = new vm.Script('(function (g) { for (const k of ["ArrayBuffer", "SharedArrayBuffer", "DataView", "Atomics", "WebAssembly", "FinalizationRegistry", "WeakRef", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]) { try { delete g[k]; } catch (e) {} } })(globalThis)');
const newContext = function () {
  const ctx = vm.createContext(Object.create(null), { name: 'plugin', codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  // No binary buffers (they live outside the memory cap), no shared memory, no weak references.
  NO_BUFFERS.runInContext(ctx);
  return ctx;
};

// ---- the pump: requests leave as JSON strings, answers arrive as JSON strings --------------------------
function pump(hooks, ctx, msg, onIdle) {
  const flush = function () { FLUSH.runInContext(ctx, { timeout: msg.timeoutMs || 10000 }); };
  const out = function () {
    for (const p of JSON.parse(hooks.drain())) {
      const r = JSON.parse(p);
      send({ t: 'call', id: r.id, op: r.op, args: r.args });
    }
  };
  process.on('message', function (m) {
    if (!m || m.t !== 'result') return;
    try {
      hooks.deliver(JSON.stringify({ id: m.id, ok: !!m.ok, data: m.data === undefined ? null : m.data, error: m.error }));
      flush();
      out();
      onIdle();
    } catch (e) { finish({ ok: false, error: 'Fehler: ' + errText(e), errorType: errType(e) }); }
  });
  flush();
  out();
  onIdle();
}

function runServer(msg) {
  const ctx = newContext();
  const hooks = new vm.Script(BOOT_SERVER, { filename: 'boot' }).runInContext(ctx);
  hooks.setup(JSON.stringify(msg.ops), JSON.stringify(msg.context));
  try {
    new vm.Script(msg.code, { filename: 'plugin.js' }).runInContext(ctx, { timeout: msg.timeoutMs || 10000 });
  } catch (e) {
    return finish({ ok: false, error: 'Fehler beim Laden des Skripts: ' + errText(e), errorType: errType(e), logs: [] });
  }
  if (msg.kind === 'check') return finish({ ok: true, registered: JSON.parse(hooks.registered()) });
  hooks.start(msg.kind, msg.id, JSON.stringify(msg.input === undefined ? null : msg.input));
  const idle = function () {
    const st = JSON.parse(hooks.state());
    if (!st.done) return;
    const logs = JSON.parse(hooks.logs());
    if (!st.ok) return finish({ ok: false, error: st.error, errorType: st.errorType, logs: logs });
    if (st.value.length > 256000) return finish({ ok: false, error: 'Das Ergebnis ist zu groß (höchstens 256 KB).', logs: logs });
    finish({ ok: true, result: JSON.parse(st.value), logs: logs });
  };
  pump(hooks, ctx, msg, idle);
}

function runUi(msg) {
  const ctx = newContext();
  const hooks = new vm.Script(BOOT_UI, { filename: 'boot' }).runInContext(ctx);
  hooks.setup(JSON.stringify(msg.ops), JSON.stringify(msg.context));
  for (const src of msg.scripts) {
    let script;
    try { script = new vm.Script(src, { filename: 'plugin-ui.js' }); } catch (e) { return finish({ ok: false, syntax: true, error: 'Syntaxfehler im Skript: ' + errText(e), errorType: errType(e), errors: [] }); }
    try { script.runInContext(ctx, { timeout: msg.timeoutMs || 10000 }); } catch (e) { hooks.note(errType(e), errText(e)); }
  }
  let fired = false;
  const idle = function () {
    if (!fired) {
      fired = true;
      hooks.fire();
      FLUSH.runInContext(ctx, { timeout: msg.timeoutMs || 10000 });
      for (const p of JSON.parse(hooks.drain())) { const r = JSON.parse(p); send({ t: 'call', id: r.id, op: r.op, args: r.args }); }
    }
    if (hooks.pending() > 0) return;
    finish({ ok: true, errors: JSON.parse(hooks.errors()) });
  };
  pump(hooks, ctx, msg, idle);
}

// ---- probe: what could an escaped plugin still do? --------------------------------------------------------
function runProbe() {
  const out = {};
  const tryit = function (name, fn) {
    try { fn(); out[name] = 'offen'; } catch (e) { out[name] = e && e.code === 'ERR_ACCESS_DENIED' ? 'gesperrt (Rechtemodell)' : 'gesperrt (' + errText(e).slice(0, 80) + ')'; }
  };
  tryit('fs', function () { require('node:fs').readFileSync('/etc/hostname'); });
  tryit('fs-write', function () { require('node:fs').writeFileSync('/tmp/gohigh-probe', 'x'); });
  tryit('child', function () { require('node:child_process').execSync('id'); });
  tryit('worker', function () { new (require('node:worker_threads').Worker)('1', { eval: true }); });
  // The network, with the original functions (what the permission model alone does) and after our lockdown.
  const socket = function () { return new Promise(function (resolve) { try { const s = new ORIG.Socket(); s.on('error', function (e) { s.destroy(); const c = e && e.code; resolve(c === 'ERR_ACCESS_DENIED' ? 'gesperrt (Rechtemodell)' : c === 'ENETUNREACH' || c === 'ENETDOWN' || c === 'EADDRNOTAVAIL' ? 'gesperrt (Netzwerk-Namespace)' : 'offen (' + (c || 'Fehler') + ')'); }); s.on('connect', function () { s.destroy(); resolve('offen (verbunden)'); }); ORIG.socketConnect.call(s, 9, '127.0.0.1'); } catch (e) { resolve('gesperrt (' + errText(e).slice(0, 60) + ')'); } }); };
  tryit('net', function () { require('node:net').connect(9, '127.0.0.1'); });
  tryit('http', function () { require('node:http').get('http://127.0.0.1:9/'); });
  tryit('dgram', function () { require('node:dgram').createSocket('udp4').send('x', 9, '127.0.0.1'); });
  tryit('dns', function () { require('node:dns').lookup('example.com', function () {}); });
  out.fetch = typeof globalThis.fetch;
  const ctx = newContext();
  out.context = JSON.parse(vm.runInContext('JSON.stringify({ process: typeof process, require: typeof require, fetch: typeof fetch, Buffer: typeof Buffer, setTimeout: typeof setTimeout, ArrayBuffer: typeof ArrayBuffer, evalStrings: (function () { try { return typeof eval("1"); } catch (e) { return "blocked"; } })(), fnCtor: (function () { try { return typeof (function () {}).constructor("return process")(); } catch (e) { return "blocked"; } })() })', ctx));
  socket().then(function (raw) { out.net_raw = raw; finish({ ok: true, probe: out }); });
}

process.once('message', function (msg) {
  try {
    if (msg.mode === 'probe') return runProbe();
    if (msg.mode === 'ui') return runUi(msg);
    return runServer(msg);
  } catch (e) { finish({ ok: false, error: 'Fehler: ' + errText(e), errorType: errType(e) }); }
});
send({ t: 'ready' });
`;

export const RUNNER_SOURCE = `'use strict';\nconst BOOT_SERVER = ${JSON.stringify(BOOT_SERVER)};\nconst BOOT_UI = ${JSON.stringify(BOOT_UI)};\n${MAIN}`;
