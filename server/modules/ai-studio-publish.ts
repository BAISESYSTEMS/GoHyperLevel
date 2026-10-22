import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { App, Module } from '../core/app.js';
import { domainAlias, normalizeDomain } from '../core/domains.js';
import { HttpError, bad, notFound, redirect, str, type Ctx, type RawResult } from '../core/http.js';
import { now } from '../core/util.js';
import { Workspace, buildProject, type Stack } from '../services/ai-studio.js';

/**
 * AI Studio publishing (docs/ai-studio.md#publish): a project's build is copied to `<workspace>/site/` and served as static files under
 * `/apps/<slug>/` – with a sandboxing CSP (opaque origin: the page never sees the app's cookies or API), never a cookie, and nothing but
 * files. Optional: `PGHL_APPS_ORIGIN` (a host of its own for every app, nothing else answers there) and a custom domain per app on
 * self-hosted installs (the host is rewritten to the app, listed for the TLS "ask" endpoint and reserved against other claims).
 * Publish and unpublish land in the audit log.
 */

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
const SEG = /^[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}$/;
const DEPTH = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
};
/** Static only: scripts and styles from the app itself, no forms to elsewhere, an opaque origin (no cookies, no same-origin API). Framing is allowed – widgets are embedded. */
export const SITE_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' https:; connect-src https:; base-uri 'self'; form-action 'none'; frame-ancestors *";

const countFiles = (dir: string): number => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
const slugOf = (name: string) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

export const aiStudioPublishModule: Module = {
  name: 'ai-studio-publish',
  migrations: [
    [
      '001-sites',
      `
      CREATE TABLE studio_sites (
        project_id TEXT PRIMARY KEY REFERENCES studio_projects(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE, domain TEXT NOT NULL DEFAULT '', files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
        published_by TEXT, published_at TEXT NOT NULL
      );
      CREATE INDEX studio_sites_loc ON studio_sites(location_id);
      CREATE INDEX studio_sites_domain ON studio_sites(domain);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const siteDir = (s: { location_id: string; project_id: string }) => join(new Workspace(app.config.dataDir, s.location_id, s.project_id).root, 'site');
    const appsOrigin = () => (process.env.PGHL_APPS_ORIGIN ?? '').trim().replace(/\/+$/, '');
    const publicUrl = (s: { slug: string; domain: string }) => (s.domain ? `https://${s.domain}/` : `${appsOrigin() || app.baseUrl()}/apps/${s.slug}/`);
    const view = (s: any) => (s ? { published: true, slug: s.slug, domain: s.domain, url: publicUrl(s), files: s.files, bytes: s.bytes, published_at: s.published_at } : { published: false });
    const project = (ctx: Ctx) => {
      const p = db.get<any>('SELECT * FROM studio_projects WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Projekt nicht gefunden');
      return p;
    };
    const audit = (ctx: Ctx, action: string, summary: string, entityId: string) => {
      try {
        app.services.audit?.({ ctx, action, summary: summary.slice(0, 480), entityId });
      } catch (e) {
        console.error('[ai-studio] audit', (e as Error).message);
      }
    };
    const studioHas = (d: string, except = '') => !!db.get(`SELECT 1 AS x FROM studio_sites WHERE domain IN (?, ?) AND domain != '' AND project_id != ?`, d, domainAlias(d) ?? d, except);

    router.get('/api/ai-studio/projects/:id/publish', 'location', (ctx) => view(db.get('SELECT * FROM studio_sites WHERE project_id = ?', project(ctx).id)));

    router.post('/api/ai-studio/projects/:id/publish', 'location', async (ctx) => {
      const p = project(ctx);
      const cur = db.get<any>('SELECT * FROM studio_sites WHERE project_id = ?', p.id);
      let slug = ctx.body?.slug !== undefined && ctx.body.slug !== '' ? str(ctx.body.slug, 'Adresse', { max: 48 }).toLowerCase() : (cur?.slug ?? '');
      if (!slug) {
        const base = slugOf(p.name).padEnd(3, '0');
        slug = db.get('SELECT 1 AS x FROM studio_sites WHERE slug = ?', base) ? `${base.slice(0, 40)}-${p.id.slice(-5).toLowerCase().replace(/[^a-z0-9]/g, '0')}` : base;
      }
      if (!SLUG.test(slug)) throw bad('Adresse: 3–48 Zeichen, nur a–z, 0–9 und Bindestriche, nicht am Anfang oder Ende.');
      if (db.get('SELECT 1 AS x FROM studio_sites WHERE slug = ? AND project_id != ?', slug, p.id)) throw new HttpError(409, 'Diese Adresse ist schon vergeben.');
      let domain = cur?.domain ?? '';
      if (ctx.body?.domain !== undefined) {
        domain = normalizeDomain(ctx.body.domain);
        if (domain && domain !== cur?.domain) {
          if (app.services.cloud?.enabled) throw bad('Eigene Domains für AI-Studio-Apps gibt es in der Cloud noch nicht – nutze die /apps/-Adresse.');
          if (studioHas(domain, p.id) || (app.services.domainTaken as ((d: string, e?: object, c?: unknown) => boolean) | undefined)?.(domain, {}, { user: ctx.user, studioProject: p.id })) throw new HttpError(409, 'Diese Domain ist schon vergeben.');
        }
      }
      const b = await buildProject(new Workspace(app.config.dataDir, p.location_id, p.id), p.stack as Stack);
      db.run('UPDATE studio_projects SET build_status = ?, build_log = ?, built_at = ?, updated_at = ? WHERE id = ?', b.ok ? 'ok' : 'error', [...b.errors, ...b.log].join('\n').slice(0, 8000), now(), now(), p.id);
      if (!b.ok) throw bad(`Build fehlgeschlagen – nichts veröffentlicht: ${b.errors.slice(0, 3).join(' · ')}`);
      const dir = siteDir({ location_id: p.location_id, project_id: p.id });
      const dist = join(new Workspace(app.config.dataDir, p.location_id, p.id).root, 'dist');
      rmSync(`${dir}.tmp`, { recursive: true, force: true });
      cpSync(dist, `${dir}.tmp`, { recursive: true });
      rmSync(dir, { recursive: true, force: true });
      renameSync(`${dir}.tmp`, dir);
      const row = { project_id: p.id, location_id: p.location_id, slug, domain, files: countFiles(dir), bytes: b.bytes, published_by: ctx.user?.id ?? null, published_at: now() };
      db.run('DELETE FROM studio_sites WHERE project_id = ?', p.id);
      db.insert('studio_sites', row);
      audit(ctx, cur ? 'ai_studio.republish' : 'ai_studio.publish', `AI-Studio-App „${p.name}“ veröffentlicht: ${publicUrl(row)}`, p.id);
      return view(row);
    });

    router.delete('/api/ai-studio/projects/:id/publish', 'location', (ctx) => {
      const p = project(ctx);
      const cur = db.get<any>('SELECT * FROM studio_sites WHERE project_id = ?', p.id);
      if (!cur) return { published: false };
      db.run('DELETE FROM studio_sites WHERE project_id = ?', p.id);
      rmSync(siteDir(cur), { recursive: true, force: true });
      audit(ctx, 'ai_studio.unpublish', `AI-Studio-App „${p.name}“ offline genommen (${publicUrl(cur)})`, p.id);
      return { published: false };
    });

    // --- the public, static side ------------------------------------------------------------------------------------
    const serve = (ctx: Ctx): RawResult => {
      const s = db.get<any>('SELECT * FROM studio_sites WHERE slug = ?', String(ctx.params.slug));
      if (!s) throw notFound('Diese App ist nicht (mehr) veröffentlicht.');
      const segs = DEPTH.map((k) => ctx.params[k]).filter((x): x is string => x !== undefined);
      if (segs.some((x) => !SEG.test(x))) throw notFound();
      const dir = siteDir(s);
      let file = normalize(join(dir, ...(segs.length ? segs : ['index.html'])));
      if (!file.startsWith(dir + sep)) throw notFound();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      // A path without an extension is a route of a single-page app: its index.html answers.
      if (!existsSync(file) && !extname(file)) file = join(dir, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) throw notFound();
      const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      return {
        __raw: true,
        status: 200,
        headers: { 'content-type': type, 'content-security-policy': SITE_CSP, 'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'cross-origin' },
        body: readFileSync(file),
      };
    };
    // `/apps/x` → `/apps/x/`, so the app's relative asset paths resolve inside it.
    router.get('/apps/:slug', 'public', (ctx) => (ctx.path.endsWith('/') ? serve(ctx) : redirect(`/apps/${encodeURIComponent(ctx.params.slug)}/`, 301)));
    // The router has no wildcard: one route per depth (a deeper path is not an app file and answers 404 below).
    for (let n = 1; n <= DEPTH.length; n++) router.get(`/apps/:slug/${DEPTH.slice(0, n).map((k) => `:${k}`).join('/')}`, 'public', serve);

    // A host of its own for the apps (PGHL_APPS_ORIGIN) and custom app domains: only the app's files answer there.
    app.rewrites.push((host, path) => {
      const origin = appsOrigin();
      if (origin && host === new URL(origin).hostname) return path.startsWith('/apps/') ? path : '/apps/-/';
      const s = db.get<{ slug: string }>(`SELECT slug FROM studio_sites WHERE domain != '' AND domain IN (?, ?)`, host, domainAlias(host) ?? host);
      if (!s) return undefined;
      return path.split('/').filter(Boolean).length > DEPTH.length ? '/apps/-/' : `/apps/${s.slug}${path === '/' ? '/' : path}`;
    });
    chainDomains(app, studioHas);
  },
};

/** The TLS "ask" endpoint lists custom app domains; funnels, help centers and logins cannot claim one (agency.ts domainTaken). */
function chainDomains(app: App, studioHas: (d: string, except?: string) => boolean) {
  const prevWanted = app.services.wantedDomains as (() => object[]) | undefined;
  app.services.wantedDomains = () => [
    ...(prevWanted?.() ?? []),
    ...app.db.all<{ domain: string; location_id: string; slug: string }>(`SELECT domain, location_id, slug FROM studio_sites WHERE domain != ''`).map((s) => ({ domain: s.domain, kind: 'studio', alias: domainAlias(s.domain), location_id: s.location_id, name: `AI Studio: ${s.slug}` })),
  ];
  const prevReserved = app.services.domainReserved as ((d: string, ctx?: any) => boolean) | undefined;
  app.services.domainReserved = (d: string, ctx?: any) => studioHas(d, ctx?.studioProject ?? '') || !!prevReserved?.(d, ctx);
}
