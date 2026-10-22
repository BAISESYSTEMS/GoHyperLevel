import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'vite';

/**
 * What the browser must download before the login page or the dashboard shows up, and that every
 * lazily loaded page really exists. The app is built once into a temp folder (about 10 s).
 *
 * Budget: 250 KB gzip of JavaScript for the first download (shell + login + dashboard); we are at ~115 KB,
 * the test fails at 160 KB so a regression is caught long before the target is touched.
 */
const JS_BUDGET_GZ = 160 * 1024;
const CSS_BUDGET_GZ = 40 * 1024;
const ROOT = resolve(__dirname, '..');

type Entry = { file: string; src?: string; isEntry?: boolean; isDynamicEntry?: boolean; imports?: string[]; dynamicImports?: string[]; css?: string[] };

describe('web bundle', () => {
  let out = '';
  let manifest: Record<string, Entry> = {};

  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), 'pghl-bundle-'));
    // vitest runs with NODE_ENV=test, which would bundle React's development build (twice the size).
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({ configFile: join(ROOT, 'vite.config.ts'), mode: 'production', logLevel: 'silent', build: { outDir: out, emptyOutDir: true, manifest: true, reportCompressedSize: false } });
    } finally {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
    }
    manifest = JSON.parse(readFileSync(join(out, '.vite/manifest.json'), 'utf8'));
  }, 180_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const gz = (file: string) => gzipSync(readFileSync(join(out, file))).length;
  /** The entry and everything it imports statically = what index.html makes the browser fetch. */
  const firstDownload = () => {
    const seen = new Set<string>();
    const walk = (key: string) => {
      if (seen.has(key)) return;
      seen.add(key);
      for (const i of manifest[key].imports ?? []) walk(i);
    };
    walk(Object.keys(manifest).find((k) => manifest[k].isEntry)!);
    return [...seen].map((k) => manifest[k]);
  };

  it('keeps the first download within budget (JS and CSS, gzip)', () => {
    const chunks = firstDownload();
    const js = chunks.reduce((n, c) => n + gz(c.file), 0);
    const css = chunks.flatMap((c) => c.css ?? []).reduce((n, f) => n + gz(f), 0);
    expect(js, `first-download JS is ${(js / 1024).toFixed(0)} KB gzip: ${chunks.map((c) => `${c.file} ${(gz(c.file) / 1024).toFixed(1)}`).join(', ')}`).toBeLessThan(JS_BUDGET_GZ);
    expect(css, `first-download CSS is ${(css / 1024).toFixed(0)} KB gzip`).toBeLessThan(CSS_BUDGET_GZ);
    // Entry + react + icons + app shell, nothing more.
    expect(chunks.length).toBeLessThanOrEqual(4);
  });

  it('loads no page, editor, tour or phone code up front', () => {
    const files = firstDownload().map((c) => c.file);
    for (const heavy of [/email-builder/, /twilio/, /engine/, /charts/, /Contacts/, /Settings/, /Workflows/, /Funnels/, /Reports/, /VideoStudio/, /Academy/, /Panel/, /Canvas/, /Workspace/, /XrViewer/, /XrButton/, /spatial/]) {
      expect(files.filter((f) => heavy.test(f)), String(heavy)).toEqual([]);
    }
  });

  it('splits every page into its own chunk, with vendors cached apart', () => {
    const dynamic = Object.values(manifest).filter((m) => m.isDynamicEntry && m.src?.startsWith('src/pages/'));
    expect(dynamic.length).toBeGreaterThan(30);
    const pages = dynamic.map((m) => m.src!.replace('src/pages/', '').replace('.tsx', ''));
    for (const p of ['Contacts', 'Conversations', 'Opportunities', 'Settings', 'Workflows', 'Funnels', 'Reports', 'Agency', 'Academy', 'SystemHealth']) expect(pages, p).toContain(p);
    // The infinite canvas (editor, renderer, its own CSS) is a lazy chunk of its own, never part of the first download.
    const canvas = Object.values(manifest).find((m) => m.isDynamicEntry && m.src === 'src/canvas/CanvasPage.tsx');
    expect(canvas, 'canvas chunk').toBeTruthy();
    expect(canvas!.css?.length, 'canvas CSS travels with its chunk').toBeGreaterThan(0);
    expect(firstDownload().map((c) => c.file)).not.toContain(canvas!.file);
    // The visual workflow canvas, too: a chunk of its own with its CSS, loaded from the workflow page only when opened.
    const wfCanvas = Object.values(manifest).find((m) => m.isDynamicEntry && m.src === 'src/workflow-canvas/WorkflowCanvas.tsx');
    expect(wfCanvas?.css?.length, 'workflow canvas chunk with its CSS').toBeGreaterThan(0);
    expect(firstDownload().map((c) => c.file)).not.toContain(wfCanvas!.file);
    // Dashboard and Login are in the first download, so they are not lazy.
    expect(pages).not.toContain('Dashboard');
    expect(pages).not.toContain('Login');
    const names = Object.values(manifest).map((m) => m.file);
    for (const vendor of ['react', 'icons']) expect(names.some((f) => new RegExp(`assets/${vendor}-`).test(f)), vendor).toBe(true);
  });

  it('keeps every language catalog a lazy chunk of its own – German users download none (web/src/i18n)', () => {
    const catalogs = Object.values(manifest).filter((m) => m.src?.startsWith('src/i18n/en/'));
    expect(catalogs.length).toBeGreaterThanOrEqual(10);
    const first = new Set(firstDownload().map((c) => c.file));
    for (const c of catalogs) {
      expect(c.isDynamicEntry, c.src).toBe(true);
      expect(first.has(c.file), c.src).toBe(false);
    }
  });

  it('every dynamic import resolves to an emitted file', () => {
    for (const m of Object.values(manifest)) {
      for (const d of m.dynamicImports ?? []) {
        expect(manifest[d], `${m.file} → ${d}`).toBeTruthy();
        expect(existsSync(join(out, manifest[d].file)), manifest[d].file).toBe(true);
      }
    }
  });

  it('the page shell is a static, no-JS-needed document with the preloads for the first download', () => {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('<div id="root"></div>');
    expect(html.match(/rel="modulepreload"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/<link rel="stylesheet"[^>]+app-[\w-]+\.css/);
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });
});

/** Source scan: `lazyPages(() => import('./pages/X'), 'A', 'B')` must name real files and real exports. */
describe('lazy routes', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  const sources = walk(join(ROOT, 'web/src'));
  const CALL = /lazyPages\(\s*\(\)\s*=>\s*import\('([^']+)'\)((?:\s*,\s*'[A-Za-z0-9_]+')+)\s*\)/g;

  const resolveModule = (from: string, spec: string) => {
    const base = resolve(dirname(from), spec);
    return [`${base}.tsx`, `${base}.ts`, join(base, 'index.ts'), join(base, 'index.tsx')].find((f) => existsSync(f));
  };
  const exportsName = (file: string, name: string, depth = 0): boolean => {
    const src = readFileSync(file, 'utf8');
    if (new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name}\\b`).test(src)) return true;
    if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(src)) return true;
    if (depth < 3) for (const m of src.matchAll(/export\s+\*\s+from\s+'(\.[^']+)'/g)) {
      const next = resolveModule(file, m[1]);
      if (next && exportsName(next, name, depth + 1)) return true;
    }
    return false;
  };

  const calls = sources.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(CALL)].map((m) => ({ file, spec: m[1], names: [...m[2].matchAll(/'([A-Za-z0-9_]+)'/g)].map((n) => n[1]) })));

  it('finds the lazy pages of the app', () => {
    expect(calls.length).toBeGreaterThan(40);
    expect(calls.some((c) => c.spec === './pages/Contacts' && c.names.includes('ContactDetail'))).toBe(true);
  });

  it('every lazy import points at an existing module that exports the names asked for', () => {
    for (const c of calls) {
      const target = resolveModule(c.file, c.spec);
      expect(target, `${c.file} imports ${c.spec}`).toBeTruthy();
      for (const n of c.names) expect(exportsName(target!, n), `${c.spec} should export ${n}`).toBe(true);
    }
  });

  it('keeps shell, login and dashboard out of the lazy set', () => {
    const lazySpecs = new Set(calls.map((c) => c.spec));
    for (const eager of ['./pages/Dashboard', './pages/Login', './pages/SaasBilling']) expect(lazySpecs.has(eager), eager).toBe(false);
    const main = readFileSync(join(ROOT, 'web/src/main.tsx'), 'utf8');
    expect(main).toMatch(/import \{ Dashboard \} from '\.\/pages\/Dashboard'/);
    expect(main).toMatch(/import \{ LoginPage, SecurityGate \} from '\.\/pages\/Login'/);
  });
});
