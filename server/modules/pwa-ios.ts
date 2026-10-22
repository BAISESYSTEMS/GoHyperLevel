import { existsSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import type { Module } from '../core/app.js';
import { notFound, type Ctx, type RawResult } from '../core/http.js';
import { decodeImage, type Bitmap } from '../services/canvas-png.js';
import { safeLookup } from '../services/net.js';
import { brandKey, iconPng, isIconKind, parseSplashFile, pwaBrand, splashPng, type IconSources, type PwaBrand } from '../services/pwa-ios.js';
import { effectiveBranding } from './agency.js';

/**
 * The installable app on iPhone, iPad and foldables (docs/ios-web-app.md): touch icons and launch images in the colour and with the
 * logo of the agency's white label (drawn here, nothing is stored), and the number for the app icon (Badging API) – also
 * handed to push messages (app.services.pushBadge) so the badge is right while the app is closed.
 */

const IMG_MAX = 2 * 1024 * 1024;

export const pwaIosModule: Module = {
  name: 'pwa-ios',
  register(app) {
    const { db, router } = app;

    /** The sub-account whose own domain this request came in on (the same rule as the manifest). */
    const locationByHost = (ctx: Ctx) => {
      const host = String(ctx.req.headers.host ?? '').split(':')[0].toLowerCase();
      return host ? (db.get(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, host)?.id as string | undefined) : undefined;
    };
    const brandOf = (ctx: Ctx): PwaBrand => pwaBrand(effectiveBranding(app, locationByHost(ctx)));

    // --- pictures -------------------------------------------------------------------------------------------------------
    let stock: { at: number; bmp: Bitmap | null } | undefined;
    /** The shipped 1024 px icon (the stock look is scaled from it); null where the web build is missing. */
    const stockIcon = (): Bitmap | null => {
      const file = join(app.config.webDir, 'icon-1024.png');
      const st = statSync(file, { throwIfNoEntry: false });
      if (!st?.isFile()) return null;
      if (stock && stock.at === st.mtimeMs) return stock.bmp;
      let bmp: Bitmap | null = null;
      try {
        bmp = decodeImage(readFileSync(file));
      } catch {
        bmp = null;
      }
      stock = { at: st.mtimeMs, bmp };
      return bmp;
    };

    const logos = new Map<string, { at: number; bmp: Bitmap | null }>();
    const uploadFile = (name: string) => {
      const row = db.get('SELECT file FROM uploads WHERE file = ?', name);
      const path = row && join(app.config.dataDir, 'uploads', String(row.file));
      return path && existsSync(path) ? readFileSync(path) : null;
    };
    /** A picture from the web: public hosts only (checked on the address the socket connects to), 2 MB, a few seconds. */
    const download = (url: URL) =>
      new Promise<Buffer | null>((resolve) => {
        const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', lookup: safeLookup(false) as any, timeout: 4000 }, (r) => {
          if ((r.statusCode ?? 0) !== 200) return void (r.resume(), resolve(null));
          const chunks: Buffer[] = [];
          let size = 0;
          r.on('data', (c: Buffer) => {
            size += c.length;
            if (size > IMG_MAX) req.destroy();
            else chunks.push(c);
          });
          r.on('end', () => resolve(Buffer.concat(chunks)));
          r.on('error', () => resolve(null));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(null));
        req.end();
      });
    const readLogo = async (address: string): Promise<Buffer | null> => {
      let u: URL;
      try {
        u = new URL(address, app.baseUrl());
      } catch {
        return null;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const own = u.origin === new URL(app.baseUrl()).origin;
      const m = /^\/uploads\/([\w.-]+)$/.exec(u.pathname);
      if (m && (own || !/^https?:/i.test(address))) return uploadFile(m[1]);
      return download(u);
    };
    /** The logo as pixels (PNG or JPEG; an SVG or anything else gives the first letter of the name). Kept for an hour. */
    const logoOf = async (address: string): Promise<Bitmap | null> => {
      if (!address) return null;
      const hit = logos.get(address);
      if (hit && Date.now() - hit.at < 3_600_000) return hit.bmp;
      let bmp: Bitmap | null = null;
      try {
        const buf = await readLogo(address);
        bmp = buf && buf.length <= IMG_MAX ? decodeImage(buf) : null;
      } catch {
        bmp = null;
      }
      if (logos.size > 40) logos.clear();
      logos.set(address, { at: Date.now(), bmp });
      return bmp;
    };
    const sourcesOf = async (b: PwaBrand): Promise<IconSources> => (b.custom ? { logo: await logoOf(b.logo) } : { stock: stockIcon() });

    const made = new Map<string, Buffer>();
    const memo = async (key: string, make: () => Buffer | Promise<Buffer>) => {
      const hit = made.get(key);
      if (hit) return hit;
      const png = await make();
      // 8 icons + 92 launch images (a few KB each) fit: a loop over every size must not make the server draw them all again
      if (made.size > 160) made.clear();
      made.set(key, png);
      return png;
    };
    const png = (body: Buffer, maxAge: number): RawResult => ({ __raw: true, status: 200, headers: { 'content-type': 'image/png', 'cache-control': `public, max-age=${maxAge}`, 'x-content-type-options': 'nosniff' }, body });
    const stamp = (b: PwaBrand, s: IconSources) => brandKey(b, `${s.logo ? `${s.logo.w}x${s.logo.h}:${s.logo.data[(s.logo.data.length >> 1) | 1] ?? 0}` : ''}${s.stock ? 'stock' : ''}`);

    router.get('/pwa/icon/:file', 'public', async (ctx) => {
      const kind = String(ctx.params.file).replace(/\.png$/, '');
      if (!isIconKind(kind)) throw notFound();
      const b = brandOf(ctx);
      const src = await sourcesOf(b);
      return png(await memo(`icon|${kind}|${stamp(b, src)}`, () => iconPng(b, kind, src)), 3600);
    });
    router.get('/pwa/splash/:file', 'public', async (ctx) => {
      const spec = parseSplashFile(String(ctx.params.file));
      if (!spec) throw notFound();
      const b = brandOf(ctx);
      const src = await sourcesOf(b);
      return png(await memo(`splash|${ctx.params.file}|${stamp(b, src)}`, () => splashPng(b, spec.px, spec.py, spec.scheme, src)), 3600);
    });

    // --- the number on the app icon ----------------------------------------------------------------------------------------
    interface Who {
      role: string;
      locations: string[];
      permissions: string[] | null;
    }
    /**
     * Unread messages in every sub-account this person may see (and only if they may use the inbox): `total` is for the app icon,
     * `here` for the sub-account the app shows (the bottom bar's number), `unread` the same as `total` before the cap.
     */
    const countFor = (u: Who, want = '') => {
      if (u.role !== 'admin' && u.permissions && !u.permissions.includes('conversations')) return { unread: 0, total: 0, here: 0 };
      const locs = u.role === 'admin' ? db.all('SELECT id FROM locations').map((l) => String(l.id)) : u.locations;
      if (!locs.length) return { unread: 0, total: 0, here: 0 };
      const sum = (ids: string[]) => Math.max(0, Math.round(Number(db.get(`SELECT COALESCE(SUM(unread), 0) n FROM conversations WHERE unread > 0 AND location_id IN (${ids.map(() => '?').join(',')})`, ...ids)?.n) || 0));
      const unread = sum(locs);
      return { unread, total: Math.min(999, unread), here: locs.includes(want) && locs.length > 1 ? sum([want]) : unread };
    };
    const whoIs = (userId: string): Who | null => {
      const r = db.get('SELECT role, locations, permissions FROM users WHERE id = ?', userId);
      if (!r) return null;
      const list = (v: unknown) => {
        try {
          return JSON.parse(String(v ?? 'null'));
        } catch {
          return null;
        }
      };
      return { role: String(r.role), locations: (list(r.locations) as string[] | null) ?? [], permissions: list(r.permissions) as string[] | null };
    };
    /** Push messages carry the number, so the icon is right while the app is closed (modules/push.ts asks for it per user). */
    app.services.pushBadge = (userId: string): number => {
      const u = whoIs(userId);
      return u ? countFor(u).total : 0;
    };
    router.get('/api/app-badge', 'user', (ctx) => {
      const u = ctx.user!;
      return countFor({ role: u.role, locations: u.locations ?? [], permissions: u.permissions ?? null }, String(ctx.req.headers['x-location-id'] ?? ''));
    });
  },
};

export type PushBadge = (userId: string) => number;
