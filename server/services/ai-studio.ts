import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { HttpError, bad } from '../core/http.js';
import type { ChatRequest, ChatResult, Msg, Part, ToolDef } from './agent-llm.js';

/**
 * AI Studio (docs/ai-studio.md): the per-project workspace on disk (`<data>/ai-studio/<sub-account>/<project>/`), its quota,
 * snapshots, the sandboxed build (esbuild in a child process: Node permission model, no environment, memory and time limits,
 * a new network namespace where the host allows it – the project's files travel over IPC, esbuild never reads the workspace)
 * and the agent loop with its seven tools. Pure of the HTTP layer: modules/ai-studio.ts wires it to routes.
 */

export type Stack = 'react' | 'html';
export const QUOTA_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_FILES = 400;
export const MAX_VERSIONS = 40;
const SAFE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const SEG = /^[A-Za-z0-9_@][A-Za-z0-9._@-]{0,79}$/;

/** A relative POSIX path inside the workspace: no `..`, no hidden files (no `.env`), not `dist`/`node_modules`. */
export function cleanPath(raw: unknown): string {
  const p = String(raw ?? '').trim().replace(/^\.?\/+/, '');
  const segs = p.split('/');
  if (!p || p.length > 200 || segs.length > 8 || segs.some((s) => !SEG.test(s))) throw bad(`Ungültiger Dateipfad: ${String(raw ?? '').slice(0, 80)}`);
  if (segs[0] === 'dist' || segs[0] === 'node_modules') throw bad('dist/ und node_modules/ sind reserviert.');
  return p;
}

export class Workspace {
  readonly root: string;
  constructor(dataDir: string, locationId: string, projectId: string) {
    if (!SAFE_ID.test(locationId) || !SAFE_ID.test(projectId)) throw bad('Ungültige ID');
    this.root = join(dataDir, 'ai-studio', locationId, projectId);
  }
  get src() {
    return join(this.root, 'src');
  }
  get dist() {
    return join(this.root, 'dist');
  }
  files(): { path: string; size: number }[] {
    const out: { path: string; size: number }[] = [];
    const walk = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const n of readdirSync(dir).sort()) {
        const p = join(dir, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, `${rel}${n}/`);
        else if (st.isFile()) out.push({ path: `${rel}${n}`, size: st.size });
      }
    };
    walk(this.src, '');
    return out;
  }
  usage() {
    const list = this.files();
    return { files: list.length, bytes: list.reduce((n, f) => n + f.size, 0), quota: QUOTA_BYTES };
  }
  read(path: string): string {
    const f = join(this.src, cleanPath(path));
    if (!existsSync(f)) throw new HttpError(404, `Datei nicht gefunden: ${path}`);
    return readFileSync(f, 'utf8');
  }
  write(path: string, content: string): number {
    const p = cleanPath(path);
    const bytes = Buffer.byteLength(String(content ?? ''));
    if (bytes > MAX_FILE_BYTES) throw bad(`Datei zu groß (höchstens ${MAX_FILE_BYTES / 1024} KB).`);
    const list = this.files();
    const old = list.find((f) => f.path === p);
    if (!old && list.length >= MAX_FILES) throw bad(`Zu viele Dateien (höchstens ${MAX_FILES}).`);
    const total = list.reduce((n, f) => n + f.size, 0) - (old?.size ?? 0) + bytes;
    if (total > QUOTA_BYTES) throw new HttpError(413, `Speicher des Projekts voll (${Math.round(QUOTA_BYTES / 1048576)} MB).`);
    const f = join(this.src, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(content ?? ''));
    return bytes;
  }
  remove(path: string): boolean {
    const f = join(this.src, cleanPath(path));
    if (!existsSync(f)) return false;
    rmSync(f);
    return true;
  }
  readAll(): Record<string, string> {
    return Object.fromEntries(this.files().map((f) => [f.path, readFileSync(join(this.src, f.path), 'utf8')]));
  }
  replaceAll(map: Record<string, string>) {
    rmSync(this.src, { recursive: true, force: true });
    for (const [p, c] of Object.entries(map)) this.write(p, c);
  }
  search(query: string): string[] {
    const q = String(query ?? '').toLowerCase();
    if (!q) return [];
    const hits: string[] = [];
    for (const [p, text] of Object.entries(this.readAll())) {
      text.split('\n').forEach((line, i) => {
        if (hits.length < 60 && line.toLowerCase().includes(q)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    return hits;
  }
  saveVersion(n: number, map = this.readAll()) {
    mkdirSync(join(this.root, 'versions'), { recursive: true });
    writeFileSync(join(this.root, 'versions', `${n}.json.gz`), gzipSync(JSON.stringify(map)));
  }
  loadVersion(n: number): Record<string, string> {
    const f = join(this.root, 'versions', `${n}.json.gz`);
    if (!existsSync(f)) throw new HttpError(404, 'Version nicht gefunden');
    return JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
  }
  dropVersion(n: number) {
    rmSync(join(this.root, 'versions', `${n}.json.gz`), { force: true });
  }
  destroy() {
    rmSync(this.root, { recursive: true, force: true });
  }
}

// --- templates ----------------------------------------------------------------------------------------------------

export function starterFiles(stack: Stack, name: string): Record<string, string> {
  const title = name.replace(/[<>&"]/g, '');
  if (stack === 'html')
    return {
      'index.html': `<!doctype html>\n<html lang="de">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${title}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>${title}</h1>\n    <p>Beschreibe im Chat, was hier entstehen soll.</p>\n  </main>\n  <script src="script.js" defer></script>\n</body>\n</html>\n`,
      'style.css': 'body { font-family: system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }\nmain { max-width: 720px; margin: 10vh auto; padding: 24px; }\n',
      'script.js': '// Your JavaScript\n',
    };
  return {
    'index.html': `<!doctype html>\n<html lang="de">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    'src/App.jsx': `export default function App() {\n  return (\n    <main className="page">\n      <h1>${title}</h1>\n      <p>Beschreibe im Chat, was hier entstehen soll.</p>\n    </main>\n  );\n}\n`,
    'src/index.css': 'body { font-family: system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }\n.page { max-width: 720px; margin: 10vh auto; padding: 24px; }\n',
    'package.json': `${JSON.stringify({ name: 'studio-app', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^7.0.0', '@vitejs/plugin-react': '^5.0.0' } }, null, 2)}\n`,
    'vite.config.js': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()], base: './' });\n",
  };
}

// --- the sandboxed build ------------------------------------------------------------------------------------------

export interface BuildResult {
  ok: boolean;
  ms: number;
  errors: string[];
  log: string[];
  bytes: number;
}

/**
 * The child: esbuild over a virtual file system sent through IPC; bare imports only from the built-in packages, whose files
 * the plugin reads itself (so esbuild-wasm runs in-process through its browser API, with no file system and no child process).
 */
const RUNNER = `
process.once('message', async (m) => {
  const send = (r) => { process.send(r, () => process.exit(0)); };
  try {
    const fs = require('fs');
    const path = require('path');
    // node -e exposes the built-in modules as globals; the Go runtime of esbuild-wasm would then write to the real fs/stdout.
    if (m.wasm) { globalThis.self = globalThis; delete globalThis.fs; delete globalThis.path; }
    const esbuild = require(m.engine);
    if (m.wasm) await esbuild.initialize({ wasmModule: new WebAssembly.Module(fs.readFileSync(m.wasm)), worker: false });
    const files = m.files;
    const ext = ['', '.jsx', '.js', '.tsx', '.ts', '/index.jsx', '/index.js'];
    const norm = (p) => { const out = []; for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); } return out.join('/'); };
    const loaders = { js: 'jsx', jsx: 'jsx', ts: 'ts', tsx: 'tsx', css: 'css', json: 'json', svg: 'dataurl', txt: 'text' };
    const inPkgs = (f) => f.startsWith(m.nodeModules + path.sep) ? { path: f, namespace: 'pkg' } : { errors: [{ text: 'Paket-Datei außerhalb: ' + f }] };
    const plugin = { name: 'studio', setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.namespace === 'pkg' && a.path.startsWith('.')) return inPkgs(require.resolve(path.join(a.resolveDir, a.path)));
        if (a.namespace !== 'pkg' && (a.path.startsWith('.') || a.path.startsWith('/') || a.kind === 'entry-point')) {
          const base = a.kind === 'entry-point' ? '' : a.resolveDir.replace(/^\\/ws\\/?/, '');
          const want = norm(a.path.startsWith('/') ? a.path : base + '/' + a.path);
          for (const e of ext) if (Object.prototype.hasOwnProperty.call(files, want + e)) return { path: '/ws/' + want + e, namespace: 'ws' };
          return { errors: [{ text: 'Datei nicht gefunden: ' + a.path }] };
        }
        const pkg = a.path.split('/')[0];
        if (!m.packages.includes(pkg)) return { errors: [{ text: 'Paket nicht verfügbar: ' + pkg + ' (eingebaut: ' + m.packages.join(', ') + ')' }] };
        return inPkgs(require.resolve(a.path, { paths: [m.nodeModules] }));
      });
      b.onLoad({ filter: /.*/, namespace: 'ws' }, (a) => {
        const p = a.path.slice(4);
        const e = (p.split('.').pop() || '').toLowerCase();
        return { contents: files[p], loader: loaders[e] || 'text', resolveDir: '/ws/' + p.split('/').slice(0, -1).join('/') };
      });
      b.onLoad({ filter: /.*/, namespace: 'pkg' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8'), loader: a.path.endsWith('.json') ? 'json' : 'js', resolveDir: path.dirname(a.path) }));
    } };
    const r = await esbuild.build({ entryPoints: [m.entry], bundle: true, write: false, outdir: '/out', entryNames: 'app', format: 'iife', minify: true, target: 'es2020', jsx: 'automatic', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [plugin] });
    send({ ok: true, outputs: r.outputFiles.map((f) => ({ path: f.path, text: f.text })), warnings: r.warnings.map((w) => w.text) });
  } catch (e) {
    send({ ok: false, errors: (e.errors || []).map((x) => (x.location ? x.location.file.replace('ws:/ws/', '') + ':' + x.location.line + ': ' : '') + x.text).slice(0, 20), message: String(e.message || e).slice(0, 500) });
  }
});
`;

const req = createRequire(import.meta.url);
const tryResolve = (id: string) => {
  try {
    return req.resolve(id);
  } catch {
    return null;
  }
};
/**
 * The build engine: esbuild-wasm is a production dependency (pure JavaScript + WebAssembly, the same file on every CPU, so the
 * multi-arch Docker image keeps it after `npm prune --omit=dev`); the native esbuild (a dev dependency through Vite) is faster
 * and used when it is installed. `prefer = 'wasm'` forces the production engine (tests). null = no engine.
 */
export const buildEngine = (prefer?: 'wasm'): string | null =>
  prefer === 'wasm' ? tryResolve('esbuild-wasm') : (tryResolve('esbuild') ?? tryResolve('esbuild-wasm'));
let netns: string | null | undefined;
function netnsBin(): string | null {
  if (netns !== undefined) return netns;
  netns = null;
  const bin = ['/usr/bin/unshare', '/bin/unshare'].find((p) => existsSync(p));
  if (process.platform === 'linux' && bin && spawnSync(bin, ['-rn', '--', process.execPath, '-e', '0'], { env: {}, timeout: 5000, stdio: 'ignore' }).status === 0) netns = bin;
  return netns;
}

function runChild(msg: Record<string, unknown>, nodeModules: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const flags = ['--permission', `--allow-fs-read=${nodeModules}`, '--allow-child-process', '--max-old-space-size=256', '--no-warnings', '-e', RUNNER];
    const ns = netnsBin();
    // PATH holds only Node's own folder: esbuild-wasm starts its WebAssembly service as `node …`.
    const opts = { env: { GOMEMLIMIT: '256MiB', PATH: dirname(process.execPath) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] as ('ignore' | 'pipe' | 'ipc')[], cwd: '/' };
    const child = ns ? spawn(ns, ['-rn', '--', process.execPath, ...flags], opts) : spawn(process.execPath, flags, opts);
    let done = false;
    let stderr = '';
    const finish = (r: any) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, errors: [`Zeitlimit des Builds überschritten (${timeoutMs / 1000} s).`] }), timeoutMs);
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1500)));
    child.on('message', finish);
    child.on('error', (e) => finish({ ok: false, errors: [`Build konnte nicht starten: ${e.message}`] }));
    child.on('exit', (code) => finish({ ok: false, errors: [`Build-Prozess beendet (${code}). ${stderr.split('\n').find((l) => l.trim()) ?? ''}`.trim()] }));
    child.send(msg);
  });
}

/** Builds the workspace into dist/ (replaced only on success). HTML projects are copied; React projects are bundled in the sandbox. */
export async function buildProject(ws: Workspace, stack: Stack, timeoutMs = 60_000, engineName?: 'wasm'): Promise<BuildResult> {
  const t0 = Date.now();
  const files = ws.readAll();
  const out: Record<string, string> = {};
  const log: string[] = [];
  if (stack === 'html') {
    for (const [p, c] of Object.entries(files)) out[p] = c;
    if (!out['index.html']) return { ok: false, ms: Date.now() - t0, errors: ['index.html fehlt.'], log, bytes: 0 };
  } else {
    const engine = buildEngine(engineName);
    const react = tryResolve('react/package.json');
    if (!engine || !react) return { ok: false, ms: Date.now() - t0, errors: ['Keine Build-Engine installiert (esbuild-wasm und react gehören zu den dependencies – npm ci ohne --omit=prod).'], log, bytes: 0 };
    const html = files['index.html'] ?? '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>';
    const entry = /<script[^>]*type="module"[^>]*src="\/?([^"]+)"/i.exec(html)?.[1] ?? 'src/main.jsx';
    const nodeModules = dirname(dirname(react));
    // esbuild-wasm: its browser build runs the WebAssembly in the sandboxed child itself (no service process, no file access).
    const wasm = engine.includes(`${sep}esbuild-wasm${sep}`) ? { engine: join(dirname(engine), 'browser.js'), wasm: join(dirname(dirname(engine)), 'esbuild.wasm') } : { engine };
    const r = await runChild({ ...wasm, files, entry: `/${entry}`, packages: ['react', 'react-dom', 'scheduler'], nodeModules }, nodeModules, timeoutMs);
    if (!r?.ok) return { ok: false, ms: Date.now() - t0, errors: r?.errors?.length ? r.errors : [String(r?.message ?? 'Build fehlgeschlagen')], log, bytes: 0 };
    log.push(...(r.warnings ?? []).slice(0, 20).map((w: string) => `Warnung: ${w}`));
    let css = false;
    for (const o of r.outputs as { path: string; text: string }[]) {
      const name = o.path.split('/').pop()!;
      out[`assets/${name}`] = o.text;
      if (name.endsWith('.css')) css = true;
    }
    out['index.html'] = html
      .replace(/<script[^>]*type="module"[^>]*><\/script>\s*/gi, '')
      .replace('</head>', `${css ? '  <link rel="stylesheet" href="assets/app.css">\n' : ''}  <script defer src="assets/app.js"></script>\n</head>`);
    for (const [p, c] of Object.entries(files)) if (p.startsWith('public/')) out[p.slice(7)] = c;
  }
  const bytes = Object.values(out).reduce((n, c) => n + Buffer.byteLength(c), 0);
  const tmp = `${ws.dist}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [p, c] of Object.entries(out)) {
    mkdirSync(dirname(join(tmp, p)), { recursive: true });
    writeFileSync(join(tmp, p), c);
  }
  rmSync(ws.dist, { recursive: true, force: true });
  renameSync(tmp, ws.dist);
  log.push(`Build ok: ${Object.keys(out).length} Dateien, ${Math.round(bytes / 1024)} KB`);
  return { ok: true, ms: Date.now() - t0, errors: [], log, bytes };
}

// --- the agent loop -----------------------------------------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  { name: 'list_files', description: 'List all project files with sizes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'Read one file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: 'Create or replace a file with the full content.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'delete_file', description: 'Delete a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'search_files', description: 'Find a text in all files (case-insensitive); returns path:line hits.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'run_build', description: 'Build the project; returns errors or success.', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_logs', description: 'Read the last build log and runtime errors of the preview.', inputSchema: { type: 'object', properties: {} } },
];

export const systemPrompt = (stack: Stack) =>
  `You are AI Studio, a builder of static websites and web apps inside a CRM. Work only through the tools on the project files.
Stack: ${stack === 'react' ? 'React 19 bundled by esbuild (entry src/main.jsx from index.html; only the packages react and react-dom exist; plain CSS files imported from JS)' : 'plain HTML, CSS and JavaScript (index.html at the root)'}.
Rules: the app runs fully client-side and static; never put secrets or API keys in files; keep files small and focused; after changes run_build and fix errors.
Finish with a short summary for the user, in the user's language.`;

export interface ToolCard {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  ms: number;
}
export interface TurnDeps {
  chat: (req: ChatRequest) => Promise<ChatResult>;
  target: ChatRequest['connection'];
  ws: Workspace;
  stack: Stack;
  build: () => Promise<BuildResult>;
  logs: () => string;
  budgetProblem: () => string | null;
  record: (r: ChatResult) => number;
  maxSteps?: number;
}
export interface TurnOutcome {
  reply: string;
  tools: ToolCard[];
  files: { action: 'write' | 'delete'; path: string; bytes: number }[];
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  thought_ms: number;
  changed: boolean;
  model: string;
  error: string;
}

export async function runTurn(d: TurnDeps, prompt: string, history: { prompt: string; reply: string }[]): Promise<TurnOutcome> {
  const o: TurnOutcome = { reply: '', tools: [], files: [], input_tokens: 0, output_tokens: 0, cost_micros: 0, thought_ms: 0, changed: false, model: d.target.model, error: '' };
  const messages: Msg[] = history.slice(-6).flatMap((h) => [
    { role: 'user' as const, content: [{ type: 'text' as const, text: h.prompt }] },
    { role: 'assistant' as const, content: [{ type: 'text' as const, text: h.reply || '…' }] },
  ]);
  messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
  let builtAfterChange = true;
  for (let step = 0; step < (d.maxSteps ?? 20); step++) {
    const problem = d.budgetProblem();
    if (problem) {
      o.error = problem;
      break;
    }
    const r = await d.chat({ connection: d.target, system: systemPrompt(d.stack), messages, tools: TOOLS, maxTokens: 8000, effort: 'medium' });
    o.thought_ms += r.ms;
    o.input_tokens += r.usage.input_tokens + r.usage.cache_read_tokens + r.usage.cache_write_tokens;
    o.output_tokens += r.usage.output_tokens;
    o.cost_micros += d.record(r);
    o.model = r.model || o.model;
    messages.push(r.message);
    if (!r.toolCalls.length) {
      o.reply = r.text;
      break;
    }
    const results: Part[] = [];
    for (const call of r.toolCalls) {
      const t0 = Date.now();
      let content = '';
      let ok = true;
      try {
        const a = call.args as Record<string, any>;
        switch (call.name) {
          case 'list_files':
            content = d.ws.files().map((f) => `${f.path} (${f.size} B)`).join('\n') || '(leer)';
            break;
          case 'read_file':
            content = d.ws.read(a.path).slice(0, 60_000);
            break;
          case 'write_file': {
            const bytes = d.ws.write(a.path, String(a.content ?? ''));
            o.files.push({ action: 'write', path: cleanPath(a.path), bytes });
            o.changed = true;
            builtAfterChange = false;
            content = `ok, ${bytes} Bytes`;
            break;
          }
          case 'delete_file':
            content = d.ws.remove(a.path) ? 'gelöscht' : 'nicht vorhanden';
            o.files.push({ action: 'delete', path: cleanPath(a.path), bytes: 0 });
            o.changed = true;
            builtAfterChange = false;
            break;
          case 'search_files':
            content = d.ws.search(a.query).join('\n') || 'keine Treffer';
            break;
          case 'run_build': {
            const b = await d.build();
            builtAfterChange = true;
            ok = b.ok;
            content = b.ok ? b.log.join('\n') : `Build fehlgeschlagen:\n${b.errors.join('\n')}`;
            break;
          }
          case 'read_logs':
            content = d.logs() || '(keine Logs)';
            break;
          default:
            ok = false;
            content = `Unbekanntes Werkzeug ${call.name}`;
        }
      } catch (e) {
        ok = false;
        content = (e as Error).message;
      }
      o.tools.push({ id: call.id, name: call.name, args: call.name === 'write_file' ? { path: (call.args as any).path } : call.args, ok, summary: content.split('\n')[0].slice(0, 160), ms: Date.now() - t0 });
      results.push({ type: 'tool_result', id: call.id, name: call.name, content, isError: !ok });
    }
    messages.push({ role: 'user', content: results });
  }
  if (o.changed && !builtAfterChange) await d.build();
  if (!o.reply && !o.error) o.reply = 'Schrittlimit erreicht – schreib „weiter“, um fortzufahren.';
  return o;
}

/** A deterministic model for tests, demos and screenshots: list → write the page → build → summary. No network. */
export async function stubChat(req: ChatRequest): Promise<ChatResult> {
  const results = req.messages.filter((m) => m.role === 'user' && m.content.some((p) => p.type === 'tool_result')).length;
  const firstUser = [...req.messages].reverse().find((m) => m.role === 'user' && m.content[0]?.type === 'text');
  const prompt = firstUser?.content[0]?.type === 'text' ? firstUser.content[0].text : '';
  const title = prompt.replace(/[<>&"{}`$\\]/g, '').slice(0, 60) || 'Meine App';
  const react = req.system.includes('React');
  const usage = { input_tokens: 1200, output_tokens: 160, cache_read_tokens: 0, cache_write_tokens: 0 };
  const calls =
    results === 0
      ? [{ id: 'stub_1', name: 'list_files', args: {} }]
      : results === 1
        ? [react ? { id: 'stub_2', name: 'write_file', args: { path: 'src/App.jsx', content: `export default function App() {\n  return (\n    <main className="page">\n      <h1>${title}</h1>\n      <p>Gebaut vom Stub-Modell.</p>\n    </main>\n  );\n}\n` } } : { id: 'stub_2', name: 'write_file', args: { path: 'index.html', content: `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="style.css"></head><body><main><h1>${title}</h1><p>Gebaut vom Stub-Modell.</p></main></body></html>\n` } }]
        : results === 2
          ? [{ id: 'stub_3', name: 'run_build', args: {} }]
          : [];
  const text = calls.length ? '' : `Fertig: „${title}“ ist gebaut.`;
  const content: Part[] = [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((c) => ({ type: 'tool_call' as const, ...c }))];
  return { message: { role: 'assistant', content }, text, toolCalls: calls, stopReason: calls.length ? 'tool_use' : 'end_turn', usage, model: 'stub-1', ms: 5 };
}
