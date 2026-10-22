import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { notFound, redirect } from '../core/http.js';
import { FORMAT_EXT, FORMAT_MIME, HEADER_BYTES, OPT_WIDTHS, imageSize, pickFormat, srcsetFor, uploadFileOf, type Dims, type ImageEngine } from '../services/site-images.js';

/**
 * Image optimisation for pages. Two halves:
 *  - dimensions: every <img> of an upload gets width/height from the file's own header (`app.services.siteImages.dims`), so the page
 *    cannot shift while pictures load;
 *  - scaled copies: when an image engine is there, `srcset` points phones at smaller copies (`/uploads-opt/<width>/<file>`), written
 *    as AVIF/WebP for browsers that accept them and cached on disk. The engine is `sharp` when it is installed (detected at start,
 *    never required) or whatever a module puts into `app.services.imageEngine`. Without an engine the route sends the original, and
 *    the editor's own canvas resize (web/src/pages/site/ImageField.tsx) provides the `srcset` instead.
 */

let probed: Promise<ImageEngine | undefined> | undefined;
let sharpEngine: ImageEngine | undefined;

/** `sharp`, if it is installed. The name is not a literal so bundlers and the type checker do not insist on it. */
function probeSharp(): Promise<ImageEngine | undefined> {
  probed ??= (async () => {
    if (process.env.PGHL_IMAGE_ENGINE === 'off') return undefined;
    try {
      const name = 'sharp';
      const mod: any = await import(/* @vite-ignore */ name);
      const sharp = mod?.default ?? mod;
      if (typeof sharp !== 'function') return undefined;
      const can = (f: string) => !!sharp.format?.[f]?.output?.buffer;
      const formats = (['webp', 'avif'] as const).filter(can);
      const engine: ImageEngine = {
        name: 'sharp',
        formats,
        async resize(input, o) {
          // rotate() applies the EXIF turn and drops the metadata (GPS position, camera) from the copy
          let p = sharp(input, { failOn: 'none', limitInputPixels: 80_000_000 }).rotate().resize({ width: o.width, withoutEnlargement: true });
          p = o.format === 'avif' ? p.avif({ quality: 55, effort: 3 }) : o.format === 'webp' ? p.webp({ quality: 80 }) : o.format === 'png' ? p.png({ compressionLevel: 9, palette: true }) : p.jpeg({ quality: 82, mozjpeg: true });
          return p.toBuffer();
        },
      };
      return engine;
    } catch {
      return undefined;
    }
  })().then((e) => (sharpEngine = e));
  return probed;
}

export const siteMediaModule: Module = {
  name: 'site-media',
  register(app: App) {
    const { db, router } = app;
    const uploadDir = join(app.config.dataDir, 'uploads');
    const optDir = join(app.config.dataDir, 'uploads-opt');
    void probeSharp();
    const engine = (): ImageEngine | undefined => (app.services.imageEngine as ImageEngine | undefined) ?? sharpEngine;

    // Upload file names are random and never rewritten, so a size read once stays right.
    const sizes = new Map<string, Dims | null>();
    function dimsOf(file: string): Dims | undefined {
      const hit = sizes.get(file);
      if (hit !== undefined) return hit ?? undefined;
      let d: Dims | undefined;
      try {
        const path = join(uploadDir, file);
        if (existsSync(path)) {
          const fd = openSync(path, 'r');
          try {
            const buf = Buffer.alloc(HEADER_BYTES);
            const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
            d = imageSize(buf.subarray(0, n));
          } finally {
            closeSync(fd);
          }
        }
      } catch {
        d = undefined;
      }
      if (sizes.size > 5000) sizes.clear();
      if (d || existsSync(join(uploadDir, file))) sizes.set(file, d ?? null);
      return d;
    }
    const dims = (src: string): Dims | undefined => {
      const f = uploadFileOf(src);
      return f ? dimsOf(f) : undefined;
    };
    app.services.siteImages = {
      dims,
      srcset: (src: string) => {
        if (!engine()) return undefined;
        const s = srcsetFor(src, dims(src));
        return s ? { srcset: s } : undefined;
      },
      engine: () => engine()?.name,
    };

    // At most two pictures are scaled at once; the same copy requested twice is made once.
    let active = 0;
    const waiting: (() => void)[] = [];
    async function limited<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= 2) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    }
    const making = new Map<string, Promise<Buffer>>();

    router.get('/uploads-opt/:w/:file', 'public', async (ctx) => {
      const w = Number(ctx.params.w);
      const file = uploadFileOf(`/uploads/${ctx.params.file}`);
      if (!file || !(OPT_WIDTHS as readonly number[]).includes(w)) throw notFound();
      const row = db.get('SELECT file, mime FROM uploads WHERE file = ?', file);
      const source = join(uploadDir, file);
      if (!row || !/^image\/(png|jpeg|webp)$/.test(row.mime) || !existsSync(source)) throw notFound();
      const original = () => redirect(`${app.baseUrl()}/uploads/${file}`, 302);
      const eng = engine();
      const size = dimsOf(file);
      // No engine, or the picture is not larger than the copy: the original is the right answer.
      if (!eng || (size && size.w <= w)) return { ...original(), headers: { ...original().headers, 'cache-control': 'public, max-age=300' } };
      const fmt = pickFormat(String(ctx.req.headers.accept ?? ''), eng, row.mime);
      const cached = join(optDir, String(w), `${file.replace(/\.[^.]+$/, '')}.${FORMAT_EXT[fmt]}`);
      let body: Buffer;
      try {
        if (existsSync(cached)) body = readFileSync(cached);
        else {
          let job = making.get(cached);
          if (!job) {
            job = limited(async () => {
              const out = await eng.resize(readFileSync(source), { width: w, format: fmt });
              mkdirSync(join(optDir, String(w)), { recursive: true });
              writeFileSync(cached, out);
              return out;
            }).finally(() => making.delete(cached));
            making.set(cached, job);
          }
          body = await job;
        }
      } catch {
        // A picture the engine cannot read: show the original, never an error.
        return { ...original(), headers: { ...original().headers, 'cache-control': 'no-store' } };
      }
      return {
        __raw: true,
        status: 200,
        headers: { 'content-type': FORMAT_MIME[fmt], 'cache-control': 'public, max-age=31536000, immutable', vary: 'Accept', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" },
        body,
      };
    });
  },
};
