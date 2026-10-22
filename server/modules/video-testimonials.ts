import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { bad, html, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { escapeHtml } from '../core/template.js';
import { id, now, normalizeEmail, safeEqual, sha256, token } from '../core/util.js';
import { limiter } from '../services/creator-kit.js';
import { parseRange } from '../services/genmedia/media.js';
import type { Tool } from './mcp.js';

/**
 * Video-Testimonials – docs/reputation.md#video-testimonials. Each sub-account gets a collect page (`/testimonials/<slug>`): a
 * customer records a short video on the phone (or picks a file), adds name, a sentence and consent, and sends it. Videos arrive
 * as "neu"; only approved ones appear on the embeddable wall (`/testimonials/<slug>/wall`) and are reachable by URL. The team
 * plays, approves, rejects or deletes them under Bewertungen. The collect page is off until the team switches it on.
 * Uploads: one raw PUT with a one-time token, at most 80 MB and never more than the size announced at start (the body is cut
 * off while it streams in), WebM/MP4/MOV checked by their bytes; starts are rate-limited per address and per sub-account, and a
 * sub-account's videos have a disk quota (`PGHL_TESTIMONIALS_MB`, plus the cloud plan's media storage).
 */

const MAX = 80 * 1024 * 1024;
const MB = 1024 * 1024;
/** Uploads started per hour: per visitor address and per sub-account. */
export const UPLOAD_LIMITS = { perIp: 10, perLocation: 30, windowMs: 60 * 60_000 };
/** Videos read at the same time on the whole server (each is held in memory until it is written). */
const MAX_PARALLEL = 8;
/** An upload that was started but not sent within this time is dropped (and its reserved space freed). */
const OPEN_FOR_MS = 60 * 60_000;

/** Disk space for a sub-account's videos in bytes (null = no cap of its own): `PGHL_TESTIMONIALS_MB`, default 2048, `0` = none. */
export function testimonialQuota(): number | null {
  const raw = process.env.PGHL_TESTIMONIALS_MB;
  const mb = raw === undefined || raw.trim() === '' ? 2048 : Number(raw);
  if (!Number.isFinite(mb) || mb < 0) return 2048 * MB;
  return mb === 0 ? null : Math.round(mb * MB);
}
const TYPES: Record<string, { ext: string; mime: string; magic: (b: Buffer) => boolean }> = {
  webm: { ext: 'webm', mime: 'video/webm', magic: (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3 },
  mp4: { ext: 'mp4', mime: 'video/mp4', magic: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && !/^qt/.test(b.subarray(8, 12).toString('latin1')) },
  mov: { ext: 'mov', mime: 'video/quicktime', magic: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^qt/.test(b.subarray(8, 12).toString('latin1')) },
};
/** The video type from the bytes (never from the browser's claim). */
export const videoType = (b: Buffer) => Object.keys(TYPES).find((k) => TYPES[k].magic(b));
const MEDIA_HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' };

function stream(path: string, ctx: Ctx, mime: string, cache: string): RawResult {
  const size = statSync(path).size;
  const head: Record<string, string> = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': cache, ...MEDIA_HEADERS };
  const wanted = ctx.req.headers.range;
  const range = parseRange(wanted, size);
  if (wanted && !range) return { __raw: true, status: 416, headers: { ...head, 'content-range': `bytes */${size}` }, body: '' };
  if (range) return { __raw: true, status: 206, headers: { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) }, body: createReadStream(path, range) };
  return { __raw: true, status: 200, headers: { ...head, 'content-length': String(size) }, body: createReadStream(path) };
}
const json = (body: unknown, status = 200): RawResult => ({ __raw: true, status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

const collectScript = (slug: string, maxMb: number) => `
document.getElementById('vt').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, file = f.video.files[0], out = document.getElementById('vt-msg'), btn = f.querySelector('button');
  if (!file) { out.textContent = 'Bitte ein Video aufnehmen oder auswählen.'; return; }
  if (file.size > ${maxMb} * 1048576) { out.textContent = 'Das Video ist zu groß (max. ${maxMb} MB).'; return; }
  btn.disabled = true; out.textContent = 'Wird hochgeladen …';
  try {
    const s = await fetch('/testimonials/${slug}/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name.value, email: f.email.value, text: f.text.value, consent: f.consent.checked, size: file.size }) });
    const j = await s.json(); if (!s.ok) throw new Error(j.error || 'Fehler');
    const u = await fetch('/testimonials/${slug}/upload/' + j.id + '?t=' + encodeURIComponent(j.token), { method: 'PUT', body: file });
    const k = await u.json(); if (!u.ok) throw new Error(k.error || 'Fehler');
    f.hidden = true; out.textContent = document.getElementById('vt').dataset.thanks;
  } catch (err) { out.textContent = err.message; btn.disabled = false; }
});`;

export const videoTestimonialsModule: Module = {
  name: 'video-testimonials',
  migrations: [
    [
      '001-init',
      `CREATE TABLE testimonial_pages (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL, intro TEXT NOT NULL DEFAULT '', thank_you TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
      CREATE TABLE video_testimonials (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', file TEXT, mime TEXT, size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'uploading', token_hash TEXT, consent_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX video_testimonials_loc ON video_testimonials(location_id, status, created_at);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const dir = join(app.config.dataDir, 'testimonials');

    /** The stored page, or the default one (reads never write: the row appears when the team changes the page). The default
     * address is the sub-account's id – already public in the chat widget's URL – so the default page takes no videos: anonymous
     * uploads only reach a sub-account that switched its collect page on. */
    const defaults = (loc: string) => {
      const name = app.location(loc)?.name ?? 'Unternehmen';
      return { location_id: loc, slug: loc, title: `Dein Video für ${name}`, intro: 'Erzähl in 30–60 Sekunden, wie dir unsere Arbeit geholfen hat. Einfach mit dem Handy aufnehmen.', thank_you: 'Danke! Wir haben dein Video erhalten.', active: 0, updated_at: now() };
    };
    const pageOf = (loc: string) => {
      const p = db.get<any>('SELECT * FROM testimonial_pages WHERE location_id = ?', loc) ?? defaults(loc);
      return { ...p, active: !!p.active, url: `${app.baseUrl()}/testimonials/${p.slug}`, wall_url: `${app.baseUrl()}/testimonials/${p.slug}/wall` };
    };
    const bySlug = (slug: string) => db.get<any>('SELECT * FROM testimonial_pages WHERE slug = ?', slug) ?? (db.get('SELECT id FROM locations WHERE id = ?', slug) ? defaults(slug) : undefined);
    const out = (v: any) => ({ id: v.id, name: v.name, email: v.email, text: v.text, status: v.status, size: v.size, mime: v.mime, created_at: v.created_at, video_url: v.file ? `/api/video-testimonials/${v.id}/video?locationId=${encodeURIComponent(v.location_id)}` : null });
    const pathOf = (v: any) => (v.file ? join(dir, v.file) : '');

    // --- team ----------------------------------------------------------------------------------------------------------------------
    router.get('/api/video-testimonials', 'location', (ctx) => ({
      page: pageOf(ctx.locationId),
      items: db.all("SELECT * FROM video_testimonials WHERE location_id = ? AND status != 'uploading' ORDER BY created_at DESC LIMIT 200", ctx.locationId).map(out),
    }));
    router.put('/api/video-testimonials/page', 'location', (ctx) => {
      const p = pageOf(ctx.locationId);
      if (!db.get('SELECT 1 FROM testimonial_pages WHERE location_id = ?', p.location_id)) db.insert('testimonial_pages', defaults(p.location_id));
      const patch: Record<string, unknown> = { updated_at: now() };
      if (ctx.body?.title !== undefined) patch.title = str(ctx.body.title, 'Titel', { required: true, max: 120 });
      if (ctx.body?.intro !== undefined) patch.intro = str(ctx.body.intro, 'Einleitung', { max: 600 });
      if (ctx.body?.thank_you !== undefined) patch.thank_you = str(ctx.body.thank_you, 'Danke-Text', { max: 300 });
      if (ctx.body?.active !== undefined) patch.active = ctx.body.active ? 1 : 0;
      const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
      db.run(`UPDATE testimonial_pages SET ${sets} WHERE location_id = ?`, ...Object.values(patch).map((v) => v as string | number), p.location_id);
      return pageOf(ctx.locationId);
    });
    router.patch('/api/video-testimonials/:id', 'location', (ctx) => {
      const status = String(ctx.body?.status ?? '');
      if (!['pending', 'approved', 'rejected'].includes(status)) throw bad('Status: pending, approved oder rejected');
      if (!db.run("UPDATE video_testimonials SET status = ?, updated_at = ? WHERE id = ? AND location_id = ? AND status != 'uploading'", status, now(), ctx.params.id, ctx.locationId).changes) throw notFound('Video nicht gefunden');
      return out(db.get('SELECT * FROM video_testimonials WHERE id = ?', ctx.params.id));
    });
    router.delete('/api/video-testimonials/:id', 'location', (ctx) => {
      const v = db.get<any>('SELECT * FROM video_testimonials WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v) throw notFound('Video nicht gefunden');
      db.run('DELETE FROM video_testimonials WHERE id = ?', v.id);
      try {
        if (v.file) unlinkSync(pathOf(v));
      } catch {
        /* gone */
      }
      return { ok: true };
    });
    router.get('/api/video-testimonials/:id/video', 'location', (ctx) => {
      const v = db.get<any>('SELECT * FROM video_testimonials WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!v?.file || !existsSync(pathOf(v))) throw notFound('Video nicht gefunden');
      return stream(pathOf(v), ctx, v.mime, 'private, no-cache');
    });

    // --- customer ------------------------------------------------------------------------------------------------------------------
    const closed = () => html(publicPage({ title: 'Nicht verfügbar', body: '<div class="wrap"><div class="card"><h1>Nicht verfügbar</h1><p class="muted">Diese Seite nimmt gerade keine Videos an.</p></div></div>' }), 404);
    router.get('/testimonials/:slug', 'public', (ctx) => {
      const p = bySlug(ctx.params.slug);
      if (!p || !p.active) return closed();
      const body = `<div class="wrap" style="max-width:560px"><div class="card"><h1>${escapeHtml(p.title)}</h1><p class="muted">${escapeHtml(p.intro)}</p>
<form id="vt" data-thanks="${escapeHtml(p.thank_you)}">
<label for="vt-video">Video</label><input id="vt-video" name="video" type="file" accept="video/*" capture="user" required>
<label for="vt-name">Dein Name</label><input id="vt-name" name="name" required maxlength="80" autocomplete="name">
<label for="vt-email">E-Mail (wird nicht veröffentlicht)</label><input id="vt-email" name="email" type="email" maxlength="160" autocomplete="email">
<label for="vt-text">Ein Satz dazu (optional)</label><textarea id="vt-text" name="text" rows="2" maxlength="500"></textarea>
<label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input type="checkbox" name="consent" required style="width:auto"> <span>Ich bin einverstanden, dass ${escapeHtml(app.location(p.location_id)?.name ?? 'das Unternehmen')} mein Video mit meinem Namen auf der Website und in sozialen Netzwerken zeigt. Widerruf jederzeit per E-Mail.</span></label>
<button type="submit" style="margin-top:12px">Video senden</button></form><p id="vt-msg" role="status"></p></div></div>
<script>${collectScript(escapeHtml(p.slug), Math.round(MAX / 1048576))}</script>`;
      const r = html(publicPage({ title: p.title, body, head: '<meta name="robots" content="noindex">' }));
      r.headers['cache-control'] = 'no-store';
      return r;
    });
    const ipLimited = limiter(UPLOAD_LIMITS.perIp, UPLOAD_LIMITS.windowMs);
    const locationLimited = limiter(UPLOAD_LIMITS.perLocation, UPLOAD_LIMITS.windowMs);
    /** Bytes a sub-account's videos take, open uploads with the size announced at start (so parallel starts cannot pass the quota). */
    const usedBytes = (loc: string) => Number(db.get<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM video_testimonials WHERE location_id = ?', loc)?.n ?? 0);
    /** Whether `incoming` more bytes fit: the sub-account's own quota and, in the hosted cloud, the plan's media storage (whose meter does not count these videos itself). */
    const fits = (loc: string, incoming: number) => {
      const used = usedBytes(loc);
      const cap = testimonialQuota();
      if (cap !== null && used + incoming > cap) return false;
      const plan = app.services.storageMeter?.(loc) as { used: number; limit: number | null } | undefined;
      return !(plan && plan.limit !== null && plan.used + used + incoming > plan.limit);
    };
    router.post('/testimonials/:slug/start', 'public', (ctx) => {
      const p = bySlug(ctx.params.slug);
      if (!p || !p.active) return json({ error: 'Diese Seite nimmt gerade keine Videos an' }, 404);
      const name = String(ctx.body?.name ?? '').trim().slice(0, 80);
      if (!name) return json({ error: 'Bitte deinen Namen angeben' }, 400);
      if (ctx.body?.consent !== true) return json({ error: 'Bitte die Einwilligung bestätigen' }, 400);
      const size = Math.round(Number(ctx.body?.size));
      if (!(size > 0) || size > MAX) return json({ error: `Das Video ist zu groß (max. ${Math.round(MAX / 1048576)} MB)` }, 400);
      if (ipLimited(ctx.ip)) return json({ error: 'Zu viele Videos von dieser Verbindung – bitte in einer Stunde noch einmal' }, 429);
      if (locationLimited(p.location_id)) return json({ error: 'Zu viele Videos auf einmal – bitte später noch einmal' }, 429);
      // Unfinished uploads of this page go away after an hour (and free the space they reserved).
      db.run("DELETE FROM video_testimonials WHERE location_id = ? AND status = 'uploading' AND created_at < ?", p.location_id, new Date(Date.now() - OPEN_FOR_MS).toISOString());
      if (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM video_testimonials WHERE location_id = ? AND status = 'uploading'", p.location_id)!.n > 50) return json({ error: 'Gerade sind zu viele Uploads offen – bitte später noch einmal' }, 429);
      if (!fits(p.location_id, size)) return json({ error: 'Gerade können keine Videos angenommen werden: der Speicherplatz ist voll. Bitte melde dich direkt beim Unternehmen.' }, 413);
      const raw = token(24);
      // `size` reserves the announced bytes until the video arrives (then it is the real size).
      const row = { id: id(), location_id: p.location_id, name, email: normalizeEmail(ctx.body?.email ?? '') || '', text: String(ctx.body?.text ?? '').trim().slice(0, 500), size, status: 'uploading', token_hash: sha256(raw), consent_at: now(), created_at: now(), updated_at: now() };
      db.insert('video_testimonials', row);
      return json({ id: row.id, token: raw });
    });
    /** A started upload of an active page with its token (and the size announced at start), or nothing. */
    const openUpload = (slug: string, uploadId: string, tok: string) => {
      const p = bySlug(slug);
      const v = p?.active && db.get<any>("SELECT * FROM video_testimonials WHERE id = ? AND location_id = ? AND status = 'uploading'", uploadId, p.location_id);
      return p && v && v.size > 0 && safeEqual(v.token_hash ?? '', sha256(tok)) ? { p, v } : undefined;
    };
    /** Uploads whose body is being read right now, and which request reads it: one body per upload, MAX_PARALLEL on the server. */
    const inflight = new Set<string>();
    const claims = new WeakMap<IncomingMessage, string>();
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: IncomingMessage, cookies: Record<string, string>): number | undefined => {
      const m = method === 'PUT' ? /^\/testimonials\/([A-Za-z0-9_-]{1,90})\/upload\/([A-Za-z0-9]{8,32})$/.exec(path) : null;
      if (!m) return prevLimit?.(method, path, req, cookies);
      // Only a started upload with its token is read past the normal public limit – and never past the size announced at start
      // (readBodyBuffer stops with 413 while the bytes stream in). Everything else is refused by the route after at most 1 MB.
      let tok = '';
      try {
        tok = new URL(req.url ?? '', 'http://x').searchParams.get('t') ?? '';
      } catch {
        /* no token */
      }
      const o = openUpload(m[1], m[2], tok);
      if (!o || inflight.has(o.v.id) || inflight.size >= MAX_PARALLEL) return undefined;
      const uploadId = o.v.id as string;
      inflight.add(uploadId);
      claims.set(req, uploadId);
      req.once('close', () => inflight.delete(uploadId));
      return Math.min(MAX, o.v.size);
    };
    router.put('/testimonials/:slug/upload/:id', 'public', (ctx) => {
      const o = openUpload(ctx.params.slug, ctx.params.id, ctx.query.get('t') ?? '');
      if (!o) return json({ error: 'Upload nicht gefunden – bitte Seite neu laden' }, 404);
      const { p, v } = o;
      if (claims.get(ctx.req) !== v.id) {
        return inflight.has(v.id) ? json({ error: 'Dieses Video wird gerade schon hochgeladen' }, 409) : json({ error: 'Gerade werden sehr viele Videos hochgeladen – bitte gleich noch einmal' }, 503);
      }
      const buf = ctx.rawBuffer ?? Buffer.alloc(0);
      const kind = videoType(buf);
      if (!kind) {
        // The token is used up (a new try starts again, as the page does): one body per start.
        db.run("DELETE FROM video_testimonials WHERE id = ? AND status = 'uploading'", v.id);
        return json({ error: 'Bitte ein Video (MP4, MOV oder WebM) senden' }, 400);
      }
      mkdirSync(dir, { recursive: true });
      const file = `${id(20)}.${TYPES[kind].ext}`;
      writeFileSync(join(dir, file), buf);
      db.run("UPDATE video_testimonials SET file = ?, mime = ?, size = ?, status = 'pending', token_hash = NULL, updated_at = ? WHERE id = ?", file, TYPES[kind].mime, buf.length, now(), v.id);
      app.events.emit(p.location_id, 'testimonial.received', { testimonialId: v.id, name: v.name, email: v.email, text: v.text });
      return json({ ok: true });
    });
    /** The wall: approved videos only (embeddable as an iframe). */
    router.get('/testimonials/:slug/wall', 'public', (ctx) => {
      const p = bySlug(ctx.params.slug);
      if (!p) return closed();
      const items = db.all<any>("SELECT * FROM video_testimonials WHERE location_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 24", p.location_id);
      const cards = items
        .map((v) => `<figure class="card" style="margin:0"><video controls preload="metadata" playsinline src="/testimonials/${escapeHtml(p.slug)}/v/${escapeHtml(v.id)}" style="width:100%;border-radius:8px;background:#000"></video><figcaption><strong>${escapeHtml(v.name)}</strong>${v.text ? `<br><span class="muted">${escapeHtml(v.text)}</span>` : ''}</figcaption></figure>`)
        .join('');
      const r = html(publicPage({ title: 'Kundenstimmen', embed: true, body: `<div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));padding:16px">${cards || '<p class="muted">Noch keine Videos.</p>'}</div>` }));
      r.headers['cache-control'] = 'public, max-age=300';
      return r;
    });
    router.get('/testimonials/:slug/v/:id', 'public', (ctx) => {
      const p = bySlug(ctx.params.slug);
      const v = p && db.get<any>("SELECT * FROM video_testimonials WHERE id = ? AND location_id = ? AND status = 'approved'", ctx.params.id, p.location_id);
      if (!v?.file || !existsSync(pathOf(v))) return json({ error: 'Nicht gefunden' }, 404);
      return stream(pathOf(v), ctx, v.mime, 'public, max-age=3600');
    });

    // --- MCP ---------------------------------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_video_testimonials',
        title: 'Video-Testimonials anzeigen',
        description: 'Listet eingegangene Video-Testimonials (Name, Satz, Status pending/approved/rejected) und die Links der Sammelseite und der Video-Wand.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        untrusted: true,
        run: (call, a) => call.api('GET', '/api/video-testimonials', { location: a.location_id }),
      },
      {
        name: 'ghl_video_testimonial_review',
        title: 'Video-Testimonial freigeben oder ablehnen',
        description: 'Setzt den Status eines Video-Testimonials: approved (erscheint auf der Video-Wand), rejected oder pending.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, testimonial_id: { type: 'string' }, status: { type: 'string', enum: ['approved', 'rejected', 'pending'] } }, required: ['location_id', 'testimonial_id', 'status'], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        run: (call, a) => call.api('PATCH', `/api/video-testimonials/${encodeURIComponent(a.testimonial_id)}`, { location: a.location_id, body: { status: a.status } }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
