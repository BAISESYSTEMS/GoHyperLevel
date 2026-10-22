import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { QUOTA_BYTES, Workspace, buildEngine, buildProject, cleanPath, starterFiles, stubChat } from '../server/services/ai-studio.js';

/**
 * AI Studio: workspace isolation and quota, the sandboxed build (native and the production engine esbuild-wasm), the preview, the
 * stub-model agent loop with snapshots, the monthly limit, the key empty state, and publishing under /apps/<slug>/.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  B = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
  t.app.services.aiStudioChat = stubChat; // no real AI calls
}, 60_000);
afterAll(async () => t?.close());

describe('workspace (pure)', () => {
  it('refuses paths outside the workspace, hidden files and reserved folders', () => {
    for (const bad of ['../x', 'a/../../b', '.env', 'src/.secret', 'dist/a.js', 'node_modules/x', 'a\\b', '']) expect(() => cleanPath(bad), bad).toThrow();
    expect(cleanPath('./src/App.jsx')).toBe('src/App.jsx');
    expect(cleanPath('/etc/passwd')).toBe('etc/passwd'); // leading slashes stay inside the workspace
  });
  it('keeps each sub-account in its own folder and enforces the quota', () => {
    const a = new Workspace(t.app.config.dataDir, 'locaaaaaaaa', 'projectone');
    const b = new Workspace(t.app.config.dataDir, 'locbbbbbbbb', 'projectone');
    expect(a.root).not.toBe(b.root);
    a.write('index.html', 'A');
    expect(b.files()).toEqual([]);
    const chunk = 'x'.repeat(500 * 1024);
    expect(() => {
      for (let i = 0; i < Math.ceil(QUOTA_BYTES / chunk.length) + 1; i++) a.write(`f${i}.txt`, chunk);
    }).toThrow(/Speicher/);
    expect(a.usage().bytes).toBeLessThanOrEqual(QUOTA_BYTES);
  });
});

describe('projects, agent loop and preview', () => {
  let pid = '';
  it('creates a project from the template with version 1 and a build', async () => {
    const r = await t.api.post('/api/ai-studio/projects', { name: 'Testseite', stack: 'html' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    pid = r.data.id;
    expect(r.data.build_status).toBe('ok');
    const d = (await t.api.get(`/api/ai-studio/projects/${pid}`)).data;
    expect(d.files.map((f: any) => f.path)).toContain('index.html');
    expect(d.versions).toHaveLength(1);
  });

  it('another sub-account sees nothing of it', async () => {
    t.api.setLocation(B);
    expect((await t.api.get(`/api/ai-studio/projects/${pid}`)).status).toBe(404);
    expect((await t.api.put(`/api/ai-studio/projects/${pid}/file`, { path: 'x.html', content: 'x' })).status).toBe(404);
    expect((await t.api.get('/api/ai-studio/projects')).data).toEqual([]);
    t.api.setLocation(A);
  });

  it('runs a turn with the stub model: tools, file activity, usage, snapshot, rebuilt preview', async () => {
    const r = await t.api.post(`/api/ai-studio/projects/${pid}/turns`, { prompt: 'Landingpage Bäckerei Sonne' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.tools.map((x: any) => x.name)).toEqual(['list_files', 'write_file', 'run_build']);
    expect(r.data.files).toEqual([{ action: 'write', path: 'index.html', bytes: expect.any(Number) }]);
    expect(r.data.reply).toContain('Bäckerei Sonne');
    expect(r.data.input_tokens).toBe(4800);
    expect(r.data.cost_usd).toBeGreaterThan(0);
    expect(r.data.version).toBe(2);
    const d = (await t.api.get(`/api/ai-studio/projects/${pid}`)).data;
    expect(d.project.cost_micros).toBe(r.data.cost_micros);
    const page = await t.api.raw(d.preview_url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts allow-forms; default-src 'none'/);
    expect(await page.text()).toContain('Bäckerei Sonne');
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM ai_calls WHERE purpose = 'ai_studio' AND location_id = ?`, A)!.n).toBe(4);
  });

  it('restores a version (as a new snapshot) and exports a ZIP', async () => {
    const r = await t.api.post(`/api/ai-studio/projects/${pid}/versions/1/restore`);
    expect(r.data).toMatchObject({ ok: true, version: 3 });
    expect((await t.api.get(`/api/ai-studio/projects/${pid}/file?path=index.html`)).data.content).not.toContain('Bäckerei');
    const zip = await t.api.get(`/api/ai-studio/projects/${pid}/export`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
  });

  it('rejects a forged or expired preview path', async () => {
    expect((await t.api.raw(`/studio-preview/${pid}.9999999999.forged/`)).status).toBe(404);
    expect((await t.api.raw(`/studio-preview/${pid}.1.x/`)).status).toBe(404);
  });

  it('respects the monthly AI limit before calling the model', async () => {
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 0.000001 });
    const r = await t.api.post(`/api/ai-studio/projects/${pid}/turns`, { prompt: 'Noch was' });
    expect(r.status).toBe(402);
    expect(r.data.error).toMatch(/Monatslimit/);
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 20 });
  });

  it('deleting the project removes its workspace', async () => {
    const root = new Workspace(t.app.config.dataDir, A, pid).root;
    expect(existsSync(root)).toBe(true);
    expect((await t.api.del(`/api/ai-studio/projects/${pid}`)).status).toBe(200);
    expect(existsSync(root)).toBe(false);
  });
});

describe.runIf(!!buildEngine())('sandboxed React build', () => {
  it('bundles the React template in the child process and refuses imports from outside the workspace', async () => {
    const p = (await t.api.post('/api/ai-studio/projects', { name: 'React App', stack: 'react' })).data;
    expect(p.build_status, p.build_log).toBe('ok');
    const dist = join(new Workspace(t.app.config.dataDir, A, p.id).root, 'dist');
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toContain('assets/app.js');
    expect(readFileSync(join(dist, 'assets/app.js'), 'utf8').length).toBeGreaterThan(1000);
    await t.api.put(`/api/ai-studio/projects/${p.id}/file`, { path: 'src/App.jsx', content: "import x from '../../../../../../etc/passwd';\nimport y from 'lodash';\nexport default () => x + y;\n" });
    const b = (await t.api.post(`/api/ai-studio/projects/${p.id}/build`)).data;
    expect(b.ok).toBe(false);
    expect(b.errors.join('\n')).toMatch(/nicht gefunden|nicht verfügbar/);
  }, 60_000);
});

describe('production toolchain (npm prune --omit=dev keeps it)', () => {
  it('esbuild-wasm, react and react-dom are runtime dependencies – none of the studio build packages is dev-only in the lockfile', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const d of ['esbuild-wasm', 'react', 'react-dom']) {
      expect(pkg.dependencies[d], d).toBeTruthy();
      expect(pkg.devDependencies?.[d], d).toBeUndefined();
    }
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    for (const d of ['esbuild-wasm', 'react', 'react-dom', 'scheduler']) expect(lock.packages[`node_modules/${d}`]?.dev, d).toBeUndefined();
  });

  it.runIf(!!buildEngine('wasm'))('builds the React template with esbuild-wasm in the sandbox and still refuses escapes', async () => {
    const ws = new Workspace(t.app.config.dataDir, 'locwasmtest', 'projwasm01');
    ws.replaceAll(starterFiles('react', 'Wasm'));
    const r = await buildProject(ws, 'react', 60_000, 'wasm');
    expect(r.ok, r.errors.join('\n')).toBe(true);
    expect(readFileSync(join(ws.dist, 'assets/app.js'), 'utf8')).toContain('createRoot');
    ws.write('src/App.jsx', "import x from '../../../../../../etc/passwd';\nimport y from 'lodash';\nexport default () => x + y;\n");
    const bad = await buildProject(ws, 'react', 60_000, 'wasm');
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/nicht gefunden|nicht verfügbar/);
  }, 60_000);
});

describe('empty state without an AI key', () => {
  it('reports whether a text connection can run a turn', async () => {
    expect((await t.api.get('/api/ai-studio/setup')).data).toMatchObject({ ai_ready: true, settings_path: 'settings/ai-providers' });
    const stub = t.app.services.aiStudioChat;
    delete t.app.services.aiStudioChat;
    try {
      expect((await t.api.get('/api/ai-studio/setup')).data.ai_ready).toBe(false);
    } finally {
      t.app.services.aiStudioChat = stub;
    }
  });
});

describe('publish under /apps/<slug>/', () => {
  let pid = '';
  const slug = 'studio-pub-test';
  const audit = (action: string) => t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND entity_id = ?', action, pid)!.n;
  beforeAll(async () => {
    pid = (await t.api.post('/api/ai-studio/projects', { name: 'Pub', stack: 'html' })).data.id;
    await t.api.put(`/api/ai-studio/projects/${pid}/file`, { path: 'index.html', content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>Version eins</body></html>' });
  });

  it('publishes the build as static files with a sandboxing CSP and no cookies', async () => {
    const r = await t.api.post(`/api/ai-studio/projects/${pid}/publish`, { slug });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ published: true, slug, url: expect.stringMatching(new RegExp(`/apps/${slug}/$`)) });
    expect(audit('ai_studio.publish')).toBe(1);
    const page = await t.api.raw(`/apps/${slug}/`, { headers: { cookie: 'pghl_session=abc' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Version eins');
    expect(page.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts allow-forms[^;]*; default-src 'none'; script-src 'self'/);
    expect(page.headers.get('set-cookie')).toBeNull();
    const css = await t.api.raw(`/apps/${slug}/style.css`);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    expect((await t.api.raw(`/apps/${slug}`, { redirect: 'manual' })).headers.get('location')).toBe(`/apps/${slug}/`);
    expect(await (await t.api.raw(`/apps/${slug}/some/route`)).text()).toContain('Version eins'); // single-page app routes
  });

  it('blocks path traversal and hidden files', async () => {
    for (const p of ['..%2f..%2fsrc%2findex.html', '%2e%2e%2f%2e%2e%2fsrc%2findex.html', '..%5c..%5cindex.html', '.env', 'a/..%2f..%2f..%2f..%2fetc%2fpasswd', '%00'])
      expect((await t.api.raw(`/apps/${slug}/${p}`)).status, p).toBe(404);
    expect((await t.api.raw(`/apps/${slug}/missing.js`)).status).toBe(404);
  });

  it('serves the published version until it is republished', async () => {
    await t.api.put(`/api/ai-studio/projects/${pid}/file`, { path: 'index.html', content: '<!doctype html><html><head></head><body>Version zwei</body></html>' });
    expect(await (await t.api.raw(`/apps/${slug}/`)).text()).toContain('Version eins');
    expect((await t.api.post(`/api/ai-studio/projects/${pid}/publish`, {})).data.slug).toBe(slug);
    expect(await (await t.api.raw(`/apps/${slug}/`)).text()).toContain('Version zwei');
    expect(audit('ai_studio.republish')).toBe(1);
  });

  it('keeps sub-accounts apart: no access to the project, no stealing the address', async () => {
    t.api.setLocation(B);
    try {
      expect((await t.api.post(`/api/ai-studio/projects/${pid}/publish`, { slug: 'other' })).status).toBe(404);
      expect((await t.api.del(`/api/ai-studio/projects/${pid}/publish`)).status).toBe(404);
      expect((await t.api.get(`/api/ai-studio/projects/${pid}/publish`)).status).toBe(404);
      const own = (await t.api.post('/api/ai-studio/projects', { name: 'Fremd', stack: 'html' })).data.id;
      expect((await t.api.post(`/api/ai-studio/projects/${own}/publish`, { slug })).status).toBe(409);
      expect((await t.api.post(`/api/ai-studio/projects/${own}/publish`, { slug: 'Bad Slug!' })).status).toBe(400);
    } finally {
      t.api.setLocation(A);
    }
    expect((await t.api.raw(`/apps/${slug}/`)).status).toBe(200);
  });

  it('a custom domain is rewritten to the app, listed for TLS and reserved against other claims', async () => {
    expect((await t.api.post(`/api/ai-studio/projects/${pid}/publish`, { domain: 'app.studio-test.example' })).data.url).toBe('https://app.studio-test.example/');
    expect(t.app.rewrites.map((rw) => rw('app.studio-test.example', '/assets/app.js')).find(Boolean)).toBe(`/apps/${slug}/assets/app.js`);
    expect(t.app.services.wantedDomains().some((d: any) => d.domain === 'app.studio-test.example' && d.kind === 'studio')).toBe(true);
    expect(t.app.services.domainTaken('app.studio-test.example')).toBe(true);
    expect((await t.api.post(`/api/ai-studio/projects/${pid}/publish`, { domain: '' })).data.domain).toBe('');
  });

  it('unpublish answers 404 afterwards; deleting the project takes the site down too', async () => {
    expect((await t.api.del(`/api/ai-studio/projects/${pid}/publish`)).data).toEqual({ published: false });
    expect((await t.api.raw(`/apps/${slug}/`)).status).toBe(404);
    expect(audit('ai_studio.unpublish')).toBe(1);
    expect((await t.api.post(`/api/ai-studio/projects/${pid}/publish`, { slug })).status).toBe(200);
    await t.api.del(`/api/ai-studio/projects/${pid}`);
    expect((await t.api.raw(`/apps/${slug}/`)).status).toBe(404);
  });
});
