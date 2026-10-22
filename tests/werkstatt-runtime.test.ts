import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staticChecks, type PluginFiles } from '../server/services/werkstatt/checks.js';
import { runSteps, validateSteps } from '../server/services/werkstatt/declarative.js';
import { EXAMPLES } from '../server/services/werkstatt/examples.js';
import { parseManifest } from '../server/services/werkstatt/manifest.js';
import { OPS, OP_NAMES, PLUGIN_ROUTES, opsFor } from '../server/services/werkstatt/ops.js';
import { probeSandbox, runSandbox } from '../server/services/werkstatt/sandbox.js';
import { splitUi } from '../server/services/werkstatt/checks.js';
import { buildHostPage } from '../server/services/werkstatt/frame.js';

const base = { allowedHosts: [], serverLogic: 'script' as const, sandboxOk: true };
const files = (name: string): PluginFiles => ({ manifest: EXAMPLES[name].manifest, ui_html: EXAMPLES[name].ui_html, server_js: EXAMPLES[name].server_js, steps: EXAMPLES[name].steps ?? null });

describe('manifest', () => {
  it('accepts the examples and normalises', () => {
    for (const [k, e] of Object.entries(EXAMPLES)) {
      const r = parseManifest(e.manifest);
      expect(r.ok, k).toBe(true);
    }
  });
  it('rejects unknown scopes, fields, entries and missing server mode', () => {
    const bad = (m: any) => (parseManifest({ name: 'Test', description: 'Eine Beschreibung', entries: { page: {} }, ...m }) as any).errors?.join(' ') ?? 'ok';
    expect(bad({ scopes: ['contacts:delete'] })).toContain('Unbekannte Berechtigung');
    expect(bad({ evil: 1 })).toContain('Unbekanntes Feld');
    expect(bad({ entries: { jobs: [{ id: 'a', every: 'daily' }] } })).toContain('server.mode');
    expect(bad({ entries: { cron: [] } })).toContain('Unbekannter Einstiegspunkt');
    expect(bad({ externalHosts: ['not a host'] })).toContain('Ungültiger Host');
    expect(bad({ version: '1.0' })).toContain('Version');
    expect(parseManifest({ name: 'x' }).ok).toBe(false);
  });
});

describe('ops catalogue', () => {
  it('every operation maps to an allowed route and validates its arguments', () => {
    const sample: Record<string, any> = { id: 'abc123', contact_id: 'abc123', title: 'T', body: 'B', name: 'N', key: 'p_projekte', prompt: 'x', query: { source: 'contacts', measures: ['count'] }, properties: { name: 'x' } };
    for (const op of OP_NAMES) {
      const def = OPS[op];
      if (def.kind !== 'route') continue;
      const call = def.build(sample);
      expect(PLUGIN_ROUTES.some((r) => r.test(`${call.method} ${call.path.split('?')[0]}`)), `${op} → ${call.method} ${call.path}`).toBe(true);
      if (def.write) expect(call.method).not.toBe('GET');
    }
  });
  it('never forwards ids with path tricks or unknown fields', () => {
    expect(() => OPS['contacts.get'].build({ id: '../../api/users' })).toThrow();
    expect(() => OPS['contacts.get'].build({ id: 'a/b' })).toThrow();
    expect(() => OPS['objects.list'].build({ key: 'contacts' })).toThrow();
    expect(OPS['contacts.update'].build({ id: 'a1', first_name: 'X', dnd: true, role: 'admin', assigned_to: 'u' }).body).toEqual({ first_name: 'X' });
    expect(OPS['contacts.list'].build({ limit: 99999, q: 'x&locationId=evil' }).path).toBe('/api/contacts?q=x%26locationId%3Devil&limit=500');
  });
  it('offers only what the manifest scopes allow (storage is always there)', () => {
    const ops = opsFor(['tasks:write']);
    expect(ops).toContain('tasks.create');
    expect(ops).toContain('storage.get');
    expect(ops).not.toContain('contacts.list');
    expect(ops).not.toContain('tasks.list');
  });
});

describe('static checks', () => {
  it('pass for all four examples', () => {
    for (const k of Object.keys(EXAMPLES)) {
      const r = staticChecks(files(k), base);
      expect(r.issues.filter((i) => i.level === 'error'), k).toEqual([]);
    }
  });
  const ui = (html: string, extra: Partial<PluginFiles['manifest']> = {}): PluginFiles => ({ manifest: { ...EXAMPLES['deal-ampel'].manifest, ...extra }, ui_html: `<div></div><script>${html}</script>`, server_js: '', steps: null });
  const codes = (f: PluginFiles, o = base) => staticChecks(f, o).issues.filter((i) => i.level === 'error').map((i) => i.code);
  it('rejects forbidden APIs in the UI', () => {
    expect(codes(ui("fetch('/api/contacts')"))).toContain('ui-fetch');
    expect(codes(ui('document.cookie'))).toContain('ui-cookie');
    expect(codes(ui("localStorage.setItem('a','b')"))).toContain('ui-browser-storage');
    expect(codes(ui('eval("1")'))).toContain('ui-eval');
    expect(codes(ui('new Function("return 1")'))).toContain('ui-function-ctor');
    expect(codes(ui("window.open('x')"))).toContain('ui-window-open');
    expect(codes(ui("location.href = 'x'"))).toContain('ui-location');
    expect(codes(ui("parent.postMessage('x','*')"))).toContain('ui-post-message');
    expect(codes(ui('new RTCPeerConnection()'))).toContain('ui-webrtc');
    expect(codes(ui('var x = 1; x.constructor.constructor("return this")()'))).toContain('ui-proto');
    // comments and the word "fetch" in prose are fine
    expect(codes(ui('// we do not fetch( anything here\nvar a = 1;'))).not.toContain('ui-fetch');
  });
  it('rejects forbidden markup', () => {
    const f = (h: string): PluginFiles => ({ manifest: EXAMPLES['deal-ampel'].manifest, ui_html: h, server_js: '', steps: null });
    expect(codes(f('<iframe src="x"></iframe><p>padding to be long enough</p>'))).toContain('ui-tag');
    expect(codes(f('<meta http-equiv="refresh" content="0;url=x"><p>padding to be long enough</p>'))).toContain('ui-tag');
    expect(codes(f('<form action="/x"><input></form><p>padding to be long enough</p>'))).toContain('ui-form-action');
    expect(codes(f('<p>padding to be long enough</p><a href="javascript:alert(1)">x</a>'))).toContain('ui-js-url');
    expect(codes(f('<style>@import "x.css";</style><p>padding to be long enough</p>'))).toContain('ui-css-import');
  });
  it('rejects external URLs unless declared and allowed by an admin', () => {
    const f = (extra: Partial<PluginFiles['manifest']> = {}): PluginFiles => ({ manifest: { ...EXAMPLES['deal-ampel'].manifest, ...extra }, ui_html: '<p>padding to be long enough</p><img src="https://cdn.example.org/logo.png">', server_js: '', steps: null });
    expect(codes(f())).toContain('url-undeclared');
    expect(codes(f({ externalHosts: ['cdn.example.org'] }))).toContain('url-not-allowed');
    expect(codes(f({ externalHosts: ['cdn.example.org'] }), { ...base, allowedHosts: ['cdn.example.org'] })).toEqual([]);
    expect(codes(f({ externalHosts: ['cdn.example.org'] }), { ...base, allowedHosts: ['cdn.example.org'] })).not.toContain('url-undeclared');
    expect(staticChecks({ manifest: EXAMPLES['deal-ampel'].manifest, ui_html: '<svg xmlns="http://www.w3.org/2000/svg"></svg><p>padding to be long enough</p>', server_js: '', steps: null }, base).ok).toBe(true);
  });
  it('checks operations against the declared scopes and the entry points against the code', () => {
    const f = ui("gohigh.ready(async () => { await gohigh.contacts.list({}); await gohigh.nothing.at.all(); });");
    expect(codes(f)).toContain('scope-missing');
    expect(codes(ui('gohigh.contacts.explode()'))).toContain('op-unknown');
    const noJob: PluginFiles = { ...files('geburtstags-erinnerungen'), server_js: 'gohigh.job("other", async () => 1);' };
    expect(codes(noJob)).toContain('job-missing');
    expect(codes({ ...files('geburtstags-erinnerungen'), server_js: 'require("fs"); gohigh.job("daily", async () => 1); fetch("https://x.example.org/");' })).toEqual(expect.arrayContaining(['server-require', 'server-fetch']));
  });
  it('applies size limits and the policy (script off, sandbox missing)', () => {
    expect(codes({ ...files('deal-ampel'), ui_html: `<p>${'x'.repeat(210_000)}</p>` })).toContain('size-ui');
    expect(codes(files('geburtstags-erinnerungen'), { ...base, serverLogic: 'declarative' })).toContain('server-script-off');
    expect(codes(files('geburtstags-erinnerungen'), { ...base, sandboxOk: false })).toContain('sandbox');
    expect(codes(files('geburtstags-erinnerungen'), { ...base, serverLogic: 'off' })).toContain('server-off');
  });
});

describe('declarative steps', () => {
  const m = EXAMPLES['followup-aufgabe'].manifest;
  it('validates against the manifest', () => {
    expect(validateSteps(EXAMPLES['followup-aufgabe'].steps, m).errors).toEqual([]);
    expect(validateSteps({ actions: {} }, m).errors.join()).toContain('Schritte fehlen');
    expect(validateSteps({ actions: { followup: [{ op: 'contacts.list' }] } }, m).errors.join()).toContain('Berechtigung');
    expect(validateSteps({ actions: { followup: [{ op: 'nope.nope' }] } }, m).errors.join()).toContain('unbekannte Funktion');
    expect(validateSteps({ actions: { followup: [{ foreach: 'x', do: [] }] } }, m).errors.join()).toContain('as');
  });
  it('runs with merge fields, loops and conditions', async () => {
    const calls: any[] = [];
    const spec = { actions: { a: [{ op: 'contacts.list', args: { limit: 5 }, as: 'res' }, { foreach: 'res.contacts', as: 'c', do: [{ if: { path: 'c.date_of_birth', op: 'endswith', value: '-{{today_md}}' }, then: [{ op: 'tasks.create', args: { title: 'Gratulieren: {{c.first_name}}', contact_id: '{{c.id}}' } }] }] }, { result: { n: '{{res.total}}' } }] } };
    const out = await runSteps(spec as any, 'actions', 'a', { today_md: '05-17', input: {} }, async (op, args) => {
      calls.push([op, args]);
      return op === 'contacts.list' ? { total: 2, contacts: [{ id: '1', first_name: 'A', date_of_birth: '1990-05-17' }, { id: '2', first_name: 'B', date_of_birth: '1991-01-01' }] } : { id: 't' };
    });
    expect(calls.map((c) => c[0])).toEqual(['contacts.list', 'tasks.create']);
    expect(calls[1][1]).toEqual({ title: 'Gratulieren: A', contact_id: '1' });
    expect(out.result).toEqual({ n: 2 });
  });
});

describe('sandbox (child process, permission model, no network)', () => {
  let status: Awaited<ReturnType<typeof probeSandbox>>;
  beforeAll(async () => {
    status = await probeSandbox();
  }, 30_000);
  afterAll(() => undefined);

  it('probe: a plugin that escaped its context still has no files, processes, workers or network', () => {
    expect(status.reason).toBeUndefined();
    expect(status.ok).toBe(true);
    const p = status.probe!;
    for (const k of ['fs', 'fs-write', 'child', 'worker', 'net', 'http', 'dgram', 'dns']) expect(String(p[k]), k).toMatch(/^gesperrt/);
    expect(p.context).toMatchObject({ process: 'undefined', require: 'undefined', fetch: 'undefined', Buffer: 'undefined', setTimeout: 'undefined', evalStrings: 'blocked', fnCtor: 'blocked' });
  });

  const run = (code: string, kind: 'action' | 'job' = 'job', id = 't', calls: any[] = [], timeoutMs = 4000) =>
    runSandbox({ mode: 'server', code, kind, id, input: { x: 1 }, ops: opsFor(['contacts:read', 'tasks:write']), context: { today: '2025-05-17' }, timeoutMs, call: async (op, args) => (calls.push([op, args]), op === 'contacts.list' ? { total: 1, contacts: [{ id: 'c1', first_name: 'Anna' }] } : { id: 'x' }) });

  it('runs handlers and passes data only through the bridge', async () => {
    const calls: any[] = [];
    const r = await run(`gohigh.job('t', async (input) => { const r = await gohigh.contacts.list({limit: 1}); await gohigh.tasks.create({title: 'Hi ' + r.contacts[0].first_name}); gohigh.log('ok', gohigh.context.today); return { n: r.total, input }; });`, 'job', 't', calls);
    expect(r).toMatchObject({ ok: true, result: { n: 1, input: { x: 1 } }, logs: ['ok 2025-05-17'], calls: 2 });
    expect(calls).toEqual([['contacts.list', { limit: 1 }], ['tasks.create', { title: 'Hi Anna' }]]);
  });

  it('the plugin context has no way out: no process, require, fetch, eval, Function, buffers, timers', async () => {
    const r = await run(`gohigh.job('t', async () => {
      const out = {};
      out.types = [typeof process, typeof require, typeof fetch, typeof Buffer, typeof setTimeout, typeof ArrayBuffer, typeof WebAssembly].join(',');
      try { out.fn = typeof this.constructor.constructor('return process')(); } catch (e) { out.fn = 'blocked'; }
      try { out.ev = eval('1'); } catch (e) { out.ev = 'blocked'; }
      try { out.proto = typeof (async function () {}).constructor('return process'); } catch (e) { out.proto = 'blocked'; }
      try { out.glob = typeof globalThis.process; } catch (e) { out.glob = 'err'; }
      return out;
    });`);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ types: 'undefined,undefined,undefined,undefined,undefined,undefined,undefined', fn: 'blocked', ev: 'blocked', proto: 'blocked', glob: 'undefined' });
  });

  it('scripts cannot call operations their manifest does not allow (the host also checks)', async () => {
    const r = await run(`gohigh.job('t', async () => { return typeof gohigh.opportunities + typeof gohigh.contacts.list; });`);
    expect(r.result).toBe('undefinedfunction');
  });

  it('reports errors, missing handlers, endless loops and memory hogs without taking the server down', async () => {
    expect(await run(`gohigh.job('t', async () => { throw new Error('kaputt'); });`)).toMatchObject({ ok: false, error: 'kaputt' });
    expect(await run(`gohigh.job('other', async () => 1);`)).toMatchObject({ ok: false, error: expect.stringContaining('Kein Handler') });
    expect(await run(`gohigh.job('t', async () => { while (true) {} });`, 'job', 't', [], 1500)).toMatchObject({ ok: false, killed: 'timeout' });
    expect(await run(`gohigh.job('t', async () => { const a = []; for (;;) a.push('x'.repeat(1e6) + Math.random()); });`, 'job', 't', [], 8000)).toMatchObject({ ok: false, killed: 'memory' });
    expect(await run(`this is not javascript`)).toMatchObject({ ok: false, error: expect.stringContaining('Skript') });
  }, 40_000);

  it('limits the number of calls', async () => {
    const r = await runSandbox({ mode: 'server', code: `gohigh.job('t', async () => { for (let i = 0; i < 50; i++) await gohigh.contacts.list({}); });`, kind: 'job', id: 't', ops: opsFor(['contacts:read']), context: {}, maxCalls: 5, timeoutMs: 5000, call: async () => ({}) });
    expect(r).toMatchObject({ ok: false, killed: 'calls' });
  });

  it('runs the UI scripts against a stand-in browser and reports syntax errors', async () => {
    const e = EXAMPLES['deal-ampel'];
    const calls: string[] = [];
    const ui = await runSandbox({ mode: 'ui', scripts: splitUi(e.ui_html).scripts, ops: opsFor(e.manifest.scopes), context: { today: '2025-05-17', entity: null }, timeoutMs: 5000, call: async (op) => (calls.push(op), OPS[op].sample()) });
    expect(ui.ok).toBe(true);
    expect(ui.errors).toEqual([]);
    expect(calls).toEqual(['opportunities.list']);
    const syn = await runSandbox({ mode: 'ui', scripts: ['var = ;'], ops: [], context: {}, call: async () => null });
    expect(syn).toMatchObject({ ok: false, syntax: true });
  });

  it('the example job creates a birthday task through the bridge', async () => {
    const calls: any[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const r = await runSandbox({
      mode: 'server',
      code: EXAMPLES['geburtstags-erinnerungen'].server_js,
      kind: 'job',
      id: 'daily',
      ops: opsFor(EXAMPLES['geburtstags-erinnerungen'].manifest.scopes),
      context: { today },
      timeoutMs: 5000,
      call: async (op, args) => {
        calls.push([op, args]);
        if (op === 'contacts.list') return { total: 2, contacts: [{ id: 'c1', first_name: 'Anna', last_name: 'B', date_of_birth: `1990-${today.slice(5)}` }, { id: 'c2', first_name: 'Ben', date_of_birth: '1990-01-01' }] };
        if (op === 'storage.get') return null;
        return { id: 't1' };
      },
    });
    expect(r.ok).toBe(true);
    const task = calls.find((c) => c[0] === 'tasks.create');
    expect(task[1].title).toContain('Anna B');
    expect(task[1].contact_id).toBe('c1');
    expect((r.result as any).created).toBe(1);
  });
});

describe('host page: navigation detection (the script as a browser runs it)', () => {
  /** Runs the host page's script against a stand-in for window, document and the iframe. */
  const run = () => {
    const page = buildHostPage({ pluginId: 'p1', name: 'Test', version: '1.0.0', frameUrl: '/plugin-frame/v1', callUrl: '', reportUrl: '', locationId: 'l1', demo: true, ops: [], samples: {}, context: {}, theme: { dark: false, brand: '#2563eb' }, entry: { kind: 'page', id: 'main' }, entity: null, height: 0 } as any);
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(page.html)![1];
    const frameListeners: Record<string, (() => void)[]> = {};
    const frame = { src: '', style: {} as Record<string, string>, contentWindow: { postMessage: () => {} }, removeAttribute: () => {}, addEventListener: (t: string, f: () => void) => (frameListeners[t] ??= []).push(f) };
    const box = { style: {} as Record<string, string>, textContent: '' };
    const cfg = { textContent: JSON.stringify(JSON.parse(/<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(page.html)![1])) };
    const toApp: any[] = [];
    let onMessage: (e: any) => void = () => {};
    const win = { addEventListener: (t: string, f: (e: any) => void) => t === 'message' && (onMessage = f), parent: { postMessage: (m: any) => toApp.push(m) } };
    const doc = { getElementById: (id: string) => (id === 'cfg' ? cfg : id === 'f' ? frame : box) };
    new Function('document', 'window', 'location', 'fetch', script)(doc, win, { origin: 'http://localhost' }, async () => ({}));
    return { frame, box, toApp, load: () => frameListeners.load?.forEach((f) => f()), hello: () => onMessage({ source: frame.contentWindow, data: { gh: 1, type: 'hello' } }) };
  };

  it('the normal load – which fires after the plugin said hello – does not stop the plugin', () => {
    const h = run();
    expect(h.frame.src).toBe('/plugin-frame/v1');
    h.hello(); // the plugin's script runs first …
    h.load(); // … then the browser fires the frame's load event
    expect(h.box.textContent).toBe('');
    expect(h.toApp.some((m) => m.type === 'dead')).toBe(false);
  });

  it('a second load (the plugin navigated or reloaded itself) switches it off', () => {
    const h = run();
    h.hello();
    h.load();
    h.load();
    expect(h.box.textContent).toContain('verlassen');
    expect(h.toApp.some((m) => m.type === 'dead')).toBe(true);
    expect(h.frame.style.display).toBe('none');
  });
});
