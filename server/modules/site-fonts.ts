import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { FONT_STACKS } from '../services/site-style.js';

/**
 * Eigene Schriften – docs/sites.md#custom-fonts. Upload a font file (WOFF2, WOFF, TTF, OTF) per sub-account and use it as body or
 * heading font of a site. The files are served by this server (no third party, no consent needed); the page gets an
 * `@font-face` rule and the font as the first entry of `--ff-body`/`--ff-head`, with the site's system stack as fallback.
 */

const FORMATS: Record<string, { mime: string; css: string; magic: (b: Buffer) => boolean }> = {
  woff2: { mime: 'font/woff2', css: 'woff2', magic: (b) => b.subarray(0, 4).toString('latin1') === 'wOF2' },
  woff: { mime: 'font/woff', css: 'woff', magic: (b) => b.subarray(0, 4).toString('latin1') === 'wOFF' },
  ttf: { mime: 'font/ttf', css: 'truetype', magic: (b) => b.readUInt32BE(0) === 0x00010000 || b.subarray(0, 4).toString('latin1') === 'true' },
  otf: { mime: 'font/otf', css: 'opentype', magic: (b) => b.subarray(0, 4).toString('latin1') === 'OTTO' },
};
const MAX = 3 * 1024 * 1024;

/** A family name that is safe inside CSS quotes. */
export const cleanFamily = (v: unknown) => String(v ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
/** Detects the format from the bytes – the client's file name or type is never trusted. */
export function fontFormat(buf: Buffer): string | undefined {
  if (buf.length < 12) return undefined;
  return Object.keys(FORMATS).find((k) => FORMATS[k].magic(buf));
}

/** The CSS a page needs for its custom fonts. */
export function fontCss(base: string, fonts: { family: string; file: string; format: string; weight: number; style: string }[], use: { body?: string; heading?: string }, fallback: { body: string; heading: string }): string {
  const faces = fonts.map((f) => `@font-face{font-family:"${f.family}";src:url("${base}/site-fonts/${f.file}") format("${FORMATS[f.format]?.css ?? 'woff2'}");font-weight:${f.weight};font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-display:swap}`);
  const vars: string[] = [];
  if (use.body) vars.push(`--ff-body:"${use.body}",${fallback.body}`);
  if (use.heading) vars.push(`--ff-head:"${use.heading}",${fallback.heading}`);
  return faces.join('') + (vars.length ? `:root{${vars.join(';')}}` : '');
}

export const siteFontsModule: Module = {
  name: 'site-fonts',
  migrations: [
    [
      '001-fonts',
      `CREATE TABLE site_fonts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        family TEXT NOT NULL, weight INTEGER NOT NULL DEFAULT 400, style TEXT NOT NULL DEFAULT 'normal',
        file TEXT NOT NULL UNIQUE, format TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX site_fonts_location ON site_fonts(location_id);
      CREATE TABLE site_font_use (
        funnel_id TEXT PRIMARY KEY REFERENCES funnels(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        body TEXT NOT NULL DEFAULT '', heading TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'site-fonts');
    const fontsOf = (loc: string) => db.all<any>('SELECT * FROM site_fonts WHERE location_id = ? ORDER BY family, weight, style', loc);
    const out = (f: any) => ({ ...f, url: `${app.baseUrl()}/site-fonts/${f.file}` });
    const families = (loc: string) => [...new Set(fontsOf(loc).map((f) => f.family))];

    router.get('/api/site-fonts', 'location', (ctx) => ({ fonts: fontsOf(ctx.locationId).map(out), families: families(ctx.locationId) }));
    /** Upload: `{ family, weight?, style?, data: 'data:…;base64,…' }`. */
    router.post('/api/site-fonts', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const family = cleanFamily(ctx.body?.family);
      if (!family) throw bad('Name der Schrift fehlt');
      const m = String(ctx.body?.data ?? '').match(/^data:[\w/+.-]*;base64,(.+)$/);
      if (!m) throw bad('Erwarte eine data:-URL');
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > MAX) throw bad('Schriftdatei größer als 3 MB');
      const format = fontFormat(buf);
      if (!format) throw bad('Nur WOFF2, WOFF, TTF oder OTF');
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM site_fonts WHERE location_id = ?', ctx.locationId)!.n >= 40) throw bad('Höchstens 40 Schriftdateien je Sub-Account');
      const weight = Math.min(900, Math.max(100, Math.round(Number(ctx.body?.weight ?? 400) / 100) * 100 || 400));
      const style = ctx.body?.style === 'italic' ? 'italic' : 'normal';
      mkdirSync(dir, { recursive: true });
      const file = `${id(20)}.${format}`;
      writeFileSync(join(dir, file), buf);
      const row = { id: id(), location_id: ctx.locationId, family, weight, style, file, format, size: buf.length, created_at: now() };
      db.insert('site_fonts', row);
      return out(row);
    });
    router.delete('/api/site-fonts/:id', 'location', (ctx) => {
      const f = db.get<any>('SELECT * FROM site_fonts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!f) throw notFound('Schrift nicht gefunden');
      db.run('DELETE FROM site_fonts WHERE id = ?', f.id);
      try {
        unlinkSync(join(dir, f.file));
      } catch {
        /* already gone */
      }
      return { ok: true };
    });
    /** Which custom family a site uses for body and headings ('' = the design's system font). */
    router.get('/api/site-fonts/use/:funnel', 'location', (ctx) => {
      if (!db.get('SELECT id FROM funnels WHERE id = ? AND location_id = ?', ctx.params.funnel, ctx.locationId)) throw notFound('Website nicht gefunden');
      const u = db.get<any>('SELECT body, heading FROM site_font_use WHERE funnel_id = ?', ctx.params.funnel);
      return { body: u?.body ?? '', heading: u?.heading ?? '', families: families(ctx.locationId) };
    });
    router.put('/api/site-fonts/use/:funnel', 'location', (ctx) => {
      if (!db.get('SELECT id FROM funnels WHERE id = ? AND location_id = ?', ctx.params.funnel, ctx.locationId)) throw notFound('Website nicht gefunden');
      const fam = families(ctx.locationId);
      const pick = (v: unknown) => {
        const s = str(v, 'Schrift', { max: 60 });
        if (s && !fam.includes(s)) throw bad(`Schrift „${s}“ ist nicht hochgeladen`);
        return s;
      };
      const body = pick(ctx.body?.body);
      const heading = pick(ctx.body?.heading);
      db.run(
        `INSERT INTO site_font_use (funnel_id, location_id, body, heading, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(funnel_id) DO UPDATE SET body = excluded.body, heading = excluded.heading, updated_at = excluded.updated_at`,
        ctx.params.funnel, ctx.locationId, body, heading, now(),
      );
      return { body, heading, families: fam };
    });

    /** The files: long cache, CORS for pages on connected domains. */
    router.get('/site-fonts/:file', 'public', (ctx) => {
      const row = db.get<any>('SELECT file, format FROM site_fonts WHERE file = ?', ctx.params.file);
      const path = row && join(dir, row.file);
      if (!row || !path || !existsSync(path)) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': FORMATS[row.format]?.mime ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' }, body: readFileSync(path) };
    });

    const css = (f: any) => {
      const u = db.get<any>('SELECT body, heading FROM site_font_use WHERE funnel_id = ?', f.id);
      if (!u || (!u.body && !u.heading)) return '';
      const used = db.all<any>('SELECT family, file, format, weight, style FROM site_fonts WHERE location_id = ? AND family IN (?, ?)', f.location_id, u.body, u.heading);
      if (!used.length) return '';
      const tokens = f.settings?.tokens?.fonts ?? {};
      const stack = (k: string) => (FONT_STACKS[k] ?? FONT_STACKS.system).css;
      return fontCss(app.baseUrl(), used, { body: used.some((x) => x.family === u.body) ? u.body : '', heading: used.some((x) => x.family === u.heading) ? u.heading : '' }, { body: stack(tokens.body), heading: stack(tokens.heading) });
    };
    app.services.pageServe = [
      ...(app.services.pageServe ?? []),
      (_ctx: Ctx, f: any) => {
        const c = css(f);
        return c ? { transform: (h: string) => h.replace('</head>', `<style>${c}</style></head>`) } : undefined;
      },
    ];
    app.services.siteFontCss = css;
  },
};
