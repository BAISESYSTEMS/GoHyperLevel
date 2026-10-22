import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, notFound, str } from '../core/http.js';
import { id, now, slugify } from '../core/util.js';
import { cleanAccess } from '../services/courses.js';
import { applySnapshot, exportSnapshot, type SnapshotPart } from '../services/snapshots.js';

/**
 * Blog posts and courses in snapshots and in "copy to another sub-account": a website copy brings
 * its blog posts, a course copy brings its modules and lessons (with their download files) – never
 * enrollments or progress. Course references elsewhere (workflow steps, community groups) point at
 * the copies afterwards (see SnapshotPart.prepare).
 */

const POST_STATUS = ['draft', 'scheduled', 'published'];

/** A lesson download belongs to one sub-account: copy the file for the target (cached per run). */
function copyUpload(app: App, locationId: string, uploadId: string, cache: Map<string, string | null>): string | null {
  if (cache.has(uploadId)) return cache.get(uploadId)!;
  const up = app.db.get('SELECT * FROM uploads WHERE id = ?', uploadId);
  let out: string | null = null;
  if (up && up.location_id === locationId) out = up.id;
  else if (up) {
    const dir = join(app.config.dataDir, 'uploads');
    const src = join(dir, up.file);
    if (existsSync(src)) {
      mkdirSync(dir, { recursive: true });
      const file = `${id(20)}${extname(up.file).toLowerCase().replace(/[^.a-z0-9]/g, '')}`;
      copyFileSync(src, join(dir, file));
      out = id();
      app.db.insert('uploads', { id: out, location_id: locationId, name: up.name, file, mime: up.mime, size: up.size, created_at: now() });
    }
  }
  cache.set(uploadId, out);
  return out;
}

export const contentCopyModule: Module = {
  name: 'content-copy',
  register(app) {
    const { db, router } = app;

    const blogPart: SnapshotPart = {
      key: 'blog_posts',
      export: (_app, loc, only) => {
        if (only && !only.funnelIds?.length) return [];
        const ids = only?.funnelIds;
        return parseRows(
          db.all(`SELECT * FROM blog_posts WHERE location_id = ?${ids ? ` AND funnel_id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY created_at`, loc, ...(ids ?? [])),
          ['tags', 'seo'],
        ).map((p) => ({ funnel_id: p.funnel_id, title: p.title, slug: p.slug, excerpt: p.excerpt, cover_image: p.cover_image, content: p.content, author: p.author, tags: p.tags, status: p.status, publish_at: p.publish_at, published_at: p.published_at, seo: p.seo }));
      },
      apply: (_app, loc, items, ctx) => {
        let n = 0;
        for (const p of items) {
          const fid = ctx.maps.funnels?.get(String(p.funnel_id ?? ''));
          if (!fid) continue;
          const root = slugify(p.slug || p.title || 'beitrag');
          let slug = root;
          for (let i = 2; db.get('SELECT id FROM blog_posts WHERE funnel_id = ? AND slug = ?', fid, slug); i++) slug = `${root}-${i}`;
          const status = POST_STATUS.includes(p.status) ? p.status : 'draft';
          db.insert('blog_posts', {
            id: id(),
            location_id: loc,
            funnel_id: fid,
            title: String(p.title ?? 'Beitrag').slice(0, 200),
            slug,
            excerpt: String(p.excerpt ?? '').slice(0, 600),
            cover_image: String(p.cover_image ?? '').slice(0, 1000),
            content: String(p.content ?? '').slice(0, 200_000),
            author: String(p.author ?? '').slice(0, 120),
            tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, 20) : [],
            status,
            publish_at: p.publish_at ?? null,
            published_at: status === 'published' ? (p.published_at ?? now()) : null,
            seo: p.seo && typeof p.seo === 'object' ? p.seo : {},
            created_at: now(),
            updated_at: now(),
          });
          n++;
        }
        ctx.created.blog_posts = n;
      },
    };

    const coursePart: SnapshotPart = {
      key: 'courses',
      export: (_app, loc, only) => {
        if (only && !only.courseIds?.length) return [];
        const ids = only?.courseIds;
        return db
          .all(`SELECT * FROM courses WHERE location_id = ?${ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : ''} ORDER BY position, created_at`, loc, ...(ids ?? []))
          .map((raw) => {
            const c = parseJson(raw, ['access', 'settings']);
            const lessons = parseRows(db.all('SELECT * FROM course_lessons WHERE course_id = ? ORDER BY position, created_at', c.id), ['downloads']);
            return {
              id: c.id,
              title: c.title,
              slug: c.slug,
              description: c.description,
              cover_image: c.cover_image,
              status: c.status,
              position: c.position,
              access: c.access,
              settings: c.settings,
              modules: db.all('SELECT * FROM course_modules WHERE course_id = ? ORDER BY position, created_at', c.id).map((m) => ({
                title: m.title,
                position: m.position,
                drip_days: m.drip_days,
                published: m.published,
                lessons: lessons
                  .filter((l) => l.module_id === m.id)
                  .map((l) => ({ title: l.title, position: l.position, video_url: l.video_url, body: l.body, downloads: l.downloads, duration_min: l.duration_min, drip_days: l.drip_days, published: l.published })),
              })),
            };
          });
      },
      prepare: (_app, items, maps) => {
        maps.courses ??= new Map();
        for (const c of items) if (c.id) maps.courses.set(String(c.id), id());
      },
      apply: (_app, loc, items, ctx) => {
        const uploads = new Map<string, string | null>();
        const created: { id: string; slug: string; title: string }[] = [];
        let pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM courses WHERE location_id = ?', loc)!.n;
        for (const c of items) {
          const cid = (c.id && ctx.maps.courses?.get(String(c.id))) || id();
          const title = String(c.title ?? 'Kurs').slice(0, 160);
          const root = slugify(c.slug || title) || 'kurs';
          let slug = root;
          for (let i = 2; db.get('SELECT id FROM courses WHERE location_id = ? AND slug = ?', loc, slug); i++) slug = `${root}-${i}`;
          // Products only carry over inside a full snapshot (they're copied along there).
          const access = cleanAccess({ ...(c.access ?? {}), product_ids: (c.access?.product_ids ?? []).map((p: string) => ctx.maps.products?.get(p) ?? '').filter(Boolean) });
          db.insert('courses', {
            id: cid,
            location_id: loc,
            title,
            slug,
            description: String(c.description ?? '').slice(0, 5000),
            cover_image: String(c.cover_image ?? '').slice(0, 1000),
            status: c.status === 'published' ? 'published' : 'draft',
            position: pos++,
            access,
            settings: c.settings && typeof c.settings === 'object' ? c.settings : {},
            created_at: now(),
            updated_at: now(),
          });
          (Array.isArray(c.modules) ? c.modules : []).forEach((m: any, mi: number) => {
            const mid = id();
            db.insert('course_modules', { id: mid, location_id: loc, course_id: cid, title: String(m.title ?? `Modul ${mi + 1}`).slice(0, 160), position: Number(m.position ?? mi), drip_days: Number(m.drip_days) || 0, published: m.published === 0 ? 0 : 1, created_at: now(), updated_at: now() });
            (Array.isArray(m.lessons) ? m.lessons : []).forEach((l: any, li: number) => {
              const downloads = (Array.isArray(l.downloads) ? l.downloads : [])
                .map((d: any) => {
                  const up = copyUpload(app, loc, String(d?.upload_id ?? ''), uploads);
                  return up ? { upload_id: up, name: String(d.name ?? '').slice(0, 200) } : null;
                })
                .filter(Boolean);
              db.insert('course_lessons', {
                id: id(),
                location_id: loc,
                course_id: cid,
                module_id: mid,
                title: String(l.title ?? `Lektion ${li + 1}`).slice(0, 160),
                position: Number(l.position ?? li),
                video_url: String(l.video_url ?? '').slice(0, 1000),
                body: String(l.body ?? '').slice(0, 100_000),
                downloads,
                duration_min: Number(l.duration_min) || 0,
                drip_days: Number(l.drip_days) || 0,
                published: l.published === 0 ? 0 : 1,
                created_at: now(),
                updated_at: now(),
              });
            });
          });
          created.push({ id: cid, slug, title });
        }
        ctx.created.courses = created;
      },
    };

    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), blogPart, coursePart];

    /** Copy one course (modules, lessons, downloads – no members or progress) into another sub-account. */
    router.post('/api/courses/:id/copy', 'location', (ctx) => {
      const c = db.get('SELECT id FROM courses WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Kurs nicht gefunden');
      const target = str(ctx.body?.location_id, 'Ziel-Sub-Account') || ctx.locationId;
      const u = ctx.user;
      if (!app.location(target)) throw notFound('Sub-Account nicht gefunden');
      if (ctx.viaApiKey ? target !== ctx.locationId : u && u.role !== 'admin' && !u.locations.includes(target)) throw new HttpError(403, 'Kein Zugriff auf den Ziel-Sub-Account');
      return applySnapshot(app, target, exportSnapshot(app, ctx.locationId, { courseIds: [c.id] }));
    });
  },
};
