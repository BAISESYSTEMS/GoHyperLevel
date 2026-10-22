import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, text, type Ctx, type RawResult } from '../core/http.js';
import { contentMatches } from '../core/files.js';
import { hasVoiceConnection } from '../services/voice-engine.js';
import {
  CAPTION_MAX_BYTES,
  HLS_NAME,
  HLS_TYPES,
  applyPlayback,
  cleanLang,
  isWatchedEnough,
  mimeOfVideo,
  resumeAt,
  signPlaylist,
  watchedPercent,
} from '../services/course-media.js';
import {
  CHUNK,
  afterUpload,
  appendChunk,
  captionsOf,
  courseVideoDir,
  getPlayback,
  getVideo,
  hasFfmpeg,
  hlsDir,
  hlsReady,
  langLabel,
  makePoster,
  maxCourseVideoMb,
  openMedia,
  posterFile,
  readyVideo,
  removeVideo,
  saveCaption,
  savePlayback,
  signMedia,
  startHls,
  startTranscribe,
  startUpload,
  sweepUploads,
  videoFile,
  MEDIA_TTL_MS,
  type CourseVideo,
} from '../services/course-video.js';
import { PLAYER_CSS, PLAYER_JS, playerHtml } from '../services/course-player.js';
import { parseRange } from '../services/genmedia/media.js';
import { limiter } from '../services/creator-kit.js';

/**
 * Course video on this server (docs/courses.md): chunked upload, signed expiring URLs, range requests, poster, captions (WebVTT/SRT upload or
 * AI through the speech-to-text connection), optional ffmpeg work (fast start, duration, poster frame, HLS), the player of the lesson page
 * and the report of a student's position and watched time (resume, speed, "complete at X % watched").
 */

const POSTER_MAX = 2 * 1024 * 1024;
const POSTER_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const IMG_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MEDIA_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin' };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): RawResult => ({ __raw: true, status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body) });

/** A file with Range support (the browser seeks and the player resumes without downloading everything first). */
function streamFile(path: string, ctx: Ctx, mime: string, cache = 'private, no-cache'): RawResult {
  const size = statSync(path).size;
  const head: Record<string, string> = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': cache, 'content-disposition': 'inline', ...MEDIA_HEADERS };
  const wanted = ctx.req.headers.range;
  const range = parseRange(wanted, size);
  if (wanted && !range) return { __raw: true, status: 416, headers: { ...head, 'content-range': `bytes */${size}` }, body: '' };
  if (range) return { __raw: true, status: 206, headers: { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': String(range.end - range.start + 1) }, body: createReadStream(path, range) };
  return { __raw: true, status: 200, headers: { ...head, 'content-length': String(size) }, body: createReadStream(path) };
}

const plain = (status: number, message: string): RawResult => ({ __raw: true, status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...MEDIA_HEADERS }, body: message });

export const courseVideoModule: Module = {
  name: 'course-video',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE course_videos (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open', mime TEXT NOT NULL DEFAULT 'video/mp4', duration_sec REAL NOT NULL DEFAULT 0,
        poster TEXT NOT NULL DEFAULT '', hls TEXT NOT NULL DEFAULT '', hls_note TEXT NOT NULL DEFAULT '',
        ai_status TEXT NOT NULL DEFAULT '', ai_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX course_videos_loc ON course_videos(location_id, created_at);
      CREATE TABLE course_captions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL REFERENCES course_videos(id) ON DELETE CASCADE,
        lang TEXT NOT NULL, label TEXT NOT NULL, vtt TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'upload', created_at TEXT NOT NULL,
        UNIQUE(video_id, lang)
      );
      CREATE TABLE course_playback (
        enrollment_id TEXT NOT NULL REFERENCES course_enrollments(id) ON DELETE CASCADE,
        lesson_id TEXT NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
        position_sec REAL NOT NULL DEFAULT 0, duration_sec REAL NOT NULL DEFAULT 0, furthest_sec REAL NOT NULL DEFAULT 0,
        watched_sec REAL NOT NULL DEFAULT 0, speed REAL NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
        PRIMARY KEY (enrollment_id, lesson_id)
      );
      CREATE INDEX course_playback_lesson ON course_playback(lesson_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const jobs = new Set<Promise<unknown>>();
    /** Tests wait for the background work (ffmpeg, HLS, AI captions) with `await app.services.courseVideoJobs.flush()`. */
    app.services.courseVideoJobs = { flush: async () => void (await Promise.allSettled([...jobs])) };
    const background = (job: Promise<unknown>) => {
      const p = job.catch((e) => console.error('[course-video]', (e as Error).message));
      jobs.add(p);
      void p.finally(() => jobs.delete(p));
    };
    app.services.courseScripts = [...((app.services.courseScripts as string[] | undefined) ?? []), '/portal-course.js'];

    // Chunks of up to 8 MB arrive as the raw request body.
    const prevLimit = app.services.rawBodyLimit;
    app.services.rawBodyLimit = (method: string, path: string, req: any, cookies: Record<string, string>): number | undefined => {
      if (method === 'PUT' && /^\/api\/courses\/videos\/[A-Za-z0-9]{8,32}\/upload$/.test(path) && (cookies.pghl_session || req.headers.authorization)) return CHUNK + 4096;
      return prevLimit?.(method, path, req, cookies);
    };

    const mustVideo = (loc: string, vid: string) => {
      const v = getVideo(app, loc, vid);
      if (!v) throw notFound('Video nicht gefunden');
      return v;
    };
    const lessonsUsing = (loc: string, vid: string) =>
      db.all<{ id: string; title: string; course_id: string; course_title: string }>(
        `SELECT l.id, l.title, l.course_id, c.title AS course_title FROM course_lessons l JOIN courses c ON c.id = l.course_id WHERE l.location_id = ? AND l.video_id = ? ORDER BY c.title, l.position`,
        loc,
        vid,
      );
    const out = (v: CourseVideo) => ({
      id: v.id,
      name: v.name,
      size: v.size,
      received: v.received,
      status: v.status,
      duration_sec: v.duration_sec,
      has_poster: !!v.poster && existsSync(posterFile(app, v)),
      hls: hlsReady(app, v) ? 'ready' : v.hls === 'ready' ? '' : v.hls,
      hls_note: v.hls_note,
      ai_status: v.ai_status,
      ai_note: v.ai_note,
      created_at: v.created_at,
    });
    const detail = (v: CourseVideo) => ({
      ...out(v),
      captions: captionsOf(app, v.id).map((c) => ({ id: c.id, lang: c.lang, label: c.label, source: c.source, created_at: c.created_at })),
      lessons: lessonsUsing(v.location_id, v.id),
    });

    // --- admin: library, upload ---------------------------------------------------------------------------------------------------
    router.get('/api/courses/media/info', 'location', async (ctx) => ({
      ffmpeg: await hasFfmpeg(app),
      stt: hasVoiceConnection(app, ctx.locationId, 'stt'),
      max_mb: maxCourseVideoMb(),
      chunk_size: CHUNK,
      url_ttl_min: Math.round(MEDIA_TTL_MS / 60_000),
      auto_hls: process.env.PGHL_COURSE_HLS === '1',
    }));
    router.get('/api/courses/videos', 'location', (ctx) => db.all<CourseVideo>('SELECT * FROM course_videos WHERE location_id = ? ORDER BY created_at DESC LIMIT 500', ctx.locationId).map((v) => ({ ...out(v), lessons: lessonsUsing(ctx.locationId, v.id).length, captions: captionsOf(app, v.id).length })));
    router.post('/api/courses/videos', 'location', (ctx) => {
      const v = startUpload(app, ctx.locationId, String(ctx.body?.name ?? ''), Math.round(Number(ctx.body?.size)));
      return { id: v.id, chunk_size: CHUNK, size: v.size, received: 0 };
    });
    router.put('/api/courses/videos/:vid/upload', 'location', (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const r = appendChunk(app, v, Number(ctx.query.get('offset') ?? v.received), ctx.rawBuffer ?? Buffer.alloc(0));
      if (r.complete && v.status === 'open') background(afterUpload(app, v.location_id, v.id));
      return r;
    });
    router.get('/api/courses/videos/:vid', 'location', (ctx) => detail(mustVideo(ctx.locationId, ctx.params.vid)));
    router.patch('/api/courses/videos/:vid', 'location', (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const patch: Record<string, any> = {};
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 200 });
      if (ctx.body?.duration_sec !== undefined) {
        const d = Number(ctx.body.duration_sec);
        if (!Number.isFinite(d) || d < 0 || d > 86_400) throw bad('Dauer ungültig');
        patch.duration_sec = Math.round(d * 10) / 10;
      }
      if (Object.keys(patch).length) db.update('course_videos', v.id, patch);
      return detail(mustVideo(ctx.locationId, v.id));
    });
    router.delete('/api/courses/videos/:vid', 'location', (ctx) => {
      if (!removeVideo(app, ctx.locationId, ctx.params.vid)) throw notFound('Video nicht gefunden');
      return { ok: true };
    });

    // --- admin: preview, poster ----------------------------------------------------------------------------------------------------
    router.get('/api/courses/videos/:vid/file', 'location', (ctx) => {
      const v = readyVideo(app, ctx.locationId, ctx.params.vid);
      if (!v) throw notFound('Video nicht gefunden');
      return streamFile(videoFile(app, v), ctx, mimeOfVideo(v.file));
    });
    router.get('/api/courses/videos/:vid/poster', 'location', (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const f = posterFile(app, v);
      if (!v.poster || !existsSync(f)) throw notFound('Kein Titelbild');
      return { __raw: true, status: 200, headers: { 'content-type': IMG_MIME[v.poster.slice(v.poster.lastIndexOf('.'))] ?? 'image/jpeg', 'cache-control': 'private, no-cache', ...MEDIA_HEADERS }, body: readFileSync(f) } as RawResult;
    });
    /** `{at: seconds}` takes the frame with ffmpeg; `{data: "data:image/…;base64,…"}` is a picture of your own. */
    router.post('/api/courses/videos/:vid/poster', 'location', async (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      if (ctx.body?.data) {
        const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(ctx.body.data));
        if (!m) throw bad('Bitte ein JPEG-, PNG- oder WebP-Bild senden');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > POSTER_MAX) throw bad('Das Bild ist größer als 2 MB');
        if (!contentMatches(m[1], buf)) throw bad('Der Dateiinhalt passt nicht zum Bildtyp');
        const name = `${v.id}${POSTER_TYPES[m[1]]}`;
        writeFileSync(join(courseVideoDir(app), name), buf);
        db.run('UPDATE course_videos SET poster = ? WHERE id = ?', name, v.id);
      } else {
        if (!(await hasFfmpeg(app))) throw new HttpError(409, 'Ohne ffmpeg kann das Titelbild nicht aus dem Video geholt werden – lade ein Bild hoch.');
        const at = Math.max(0, Number(ctx.body?.at) || 0);
        if (!(await makePoster(app, ctx.locationId, v.id, at))) throw new HttpError(502, 'ffmpeg konnte kein Bild aus dem Video holen');
      }
      return detail(mustVideo(ctx.locationId, v.id));
    });

    // --- admin: captions -----------------------------------------------------------------------------------------------------------
    router.post('/api/courses/videos/:vid/captions', 'location', (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const body = String(ctx.body?.vtt ?? ctx.body?.text ?? '');
      if (Buffer.byteLength(body) > CAPTION_MAX_BYTES) throw bad(`Die Untertitel-Datei ist größer als ${CAPTION_MAX_BYTES / 1024} KB`);
      const lang = cleanLang(ctx.body?.lang);
      saveCaption(app, v, lang, str(ctx.body?.label, 'Name', { max: 60 }) || langLabel(lang), body, 'upload');
      return detail(v);
    });
    router.get('/api/courses/videos/:vid/captions/:cid', 'location', (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const c = captionsOf(app, v.id).find((x) => x.id === ctx.params.cid);
      if (!c) throw notFound('Untertitel nicht gefunden');
      return text(c.vtt, 'text/vtt; charset=utf-8');
    });
    router.delete('/api/courses/videos/:vid/captions/:cid', 'location', (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      if (!db.run('DELETE FROM course_captions WHERE id = ? AND video_id = ?', ctx.params.cid, v.id).changes) throw notFound('Untertitel nicht gefunden');
      return detail(v);
    });
    router.post('/api/courses/videos/:vid/captions/ai', 'location', async (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const run = await startTranscribe(app, ctx.locationId, v.id, cleanLang(ctx.body?.language ?? 'de'));
      background(run());
      return { ...detail(mustVideo(ctx.locationId, v.id)), started: true };
    });
    router.post('/api/courses/videos/:vid/hls', 'location', async (ctx) => {
      const v = mustVideo(ctx.locationId, ctx.params.vid);
      const run = await startHls(app, ctx.locationId, v.id);
      background(run());
      return { ...detail(mustVideo(ctx.locationId, v.id)), started: true };
    });

    // --- member: the player's files -------------------------------------------------------------------------------------------------
    /**
     * Member, signed token and a running enrolment: all three must fit. A copied link is useless without the member's own session,
     * and a link from a foreign page is refused outright (no embedding on other sites).
     */
    const memberMedia = (ctx: Ctx): { v: CourseVideo; contactId: string; token: string } | RawResult => {
      const kit = app.services.portalKit;
      const p = kit?.resolve(ctx.params.p);
      if (!p) return plain(404, 'Nicht gefunden');
      const m = kit.memberOf(ctx, p);
      if (!m) return plain(401, 'Bitte anmelden');
      const site = String(ctx.req.headers['sec-fetch-site'] ?? '');
      if (site && site !== 'same-origin') return plain(403, 'Nur im Mitgliederbereich');
      const ref = String(ctx.req.headers.referer ?? '');
      if (ref) {
        try {
          if (new URL(ref).host !== String(ctx.req.headers.host ?? '')) return plain(403, 'Nur im Mitgliederbereich');
        } catch {
          return plain(403, 'Nur im Mitgliederbereich');
        }
      }
      const raw = String(ctx.query.get('t') ?? '');
      const tok = openMedia(app, raw);
      if (!tok || tok.v !== ctx.params.vid || tok.c !== m.contact.id || tok.l !== p.locationId) return plain(403, 'Der Link ist abgelaufen – bitte die Lektion neu laden');
      const allowed = db.get(
        `SELECT 1 AS ok FROM course_lessons l JOIN courses c ON c.id = l.course_id JOIN course_enrollments e ON e.course_id = l.course_id
         WHERE l.video_id = ? AND l.location_id = ? AND l.published = 1 AND c.status = 'published' AND e.contact_id = ? AND e.status = 'active'`,
        tok.v,
        p.locationId,
        m.contact.id,
      );
      const v = allowed && readyVideo(app, p.locationId, tok.v);
      if (!v) return plain(404, 'Nicht gefunden');
      return { v, contactId: m.contact.id, token: raw };
    };
    const isRaw = (x: unknown): x is RawResult => !!x && typeof x === 'object' && (x as RawResult).__raw === true;

    router.get('/portal/:p/media/:vid/:file', 'public', (ctx) => {
      const got = memberMedia(ctx);
      if (isRaw(got)) return got;
      const { v } = got;
      const file = ctx.params.file;
      if (file === 'video.mp4') return streamFile(videoFile(app, v), ctx, mimeOfVideo(v.file));
      if (file === 'poster.jpg') {
        const f = posterFile(app, v);
        if (!v.poster || !existsSync(f)) return plain(404, 'Nicht gefunden');
        return { __raw: true, status: 200, headers: { 'content-type': IMG_MIME[v.poster.slice(v.poster.lastIndexOf('.'))] ?? 'image/jpeg', 'cache-control': 'private, max-age=600', ...MEDIA_HEADERS }, body: readFileSync(f) };
      }
      const cap = /^cap-([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)\.vtt$/.exec(file);
      if (cap) {
        const c = captionsOf(app, v.id).find((x) => x.lang === cap[1]);
        if (!c) return plain(404, 'Nicht gefunden');
        return { __raw: true, status: 200, headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'private, max-age=300', ...MEDIA_HEADERS }, body: c.vtt };
      }
      return plain(404, 'Nicht gefunden');
    });
    router.get('/portal/:p/media/:vid/hls/:name', 'public', (ctx) => {
      const got = memberMedia(ctx);
      if (isRaw(got)) return got;
      const { v, token } = got;
      const name = ctx.params.name;
      const path = join(hlsDir(app, v), name);
      if (!HLS_NAME.test(name) || !hlsReady(app, v) || !existsSync(path)) return plain(404, 'Nicht gefunden');
      const ext = name.slice(name.lastIndexOf('.'));
      if (ext === '.m3u8') return { __raw: true, status: 200, headers: { 'content-type': HLS_TYPES[ext], 'cache-control': 'private, no-cache', ...MEDIA_HEADERS }, body: signPlaylist(readFileSync(path, 'utf8'), token) };
      return streamFile(path, ctx, HLS_TYPES[ext]);
    });
    router.get('/portal-course.js', 'public', () => {
      const r = text(PLAYER_JS, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=3600';
      return r;
    });

    // --- member: the player on the lesson page --------------------------------------------------------------------------------------
    app.services.lessonVideo = [
      ...((app.services.lessonVideo as unknown[] | undefined) ?? []),
      (p: any, m: any, s: any, l: any): string | undefined => {
        if (!l.video_id) return undefined;
        const v = readyVideo(app, p.locationId, l.video_id);
        if (!v) return '<div class="panel empty"><p class="muted">Dieses Video ist gerade nicht verfügbar.</p></div>';
        const tok = signMedia(app, v.id, m.contact.id, p.locationId);
        const base = `${p.base}/media/${encodeURIComponent(v.id)}`;
        const q = `?t=${encodeURIComponent(tok)}`;
        const pb = getPlayback(app, s.enrollment.id, l.id);
        return (
          PLAYER_CSS +
          playerHtml({
            title: l.title,
            video: `${base}/video.mp4${q}`,
            hls: hlsReady(app, v) ? `${base}/hls/master.m3u8${q}` : undefined,
            poster: v.poster && existsSync(posterFile(app, v)) ? `${base}/poster.jpg${q}` : undefined,
            captions: captionsOf(app, v.id).map((c) => ({ lang: c.lang, label: c.label, src: `${base}/cap-${encodeURIComponent(c.lang)}.vtt${q}` })),
            chapters: Array.isArray(l.chapters) ? l.chapters : [],
            resume: resumeAt(pb),
            speed: pb.speed || 1,
            post: `${p.base}/c/${encodeURIComponent(s.course.slug)}/${encodeURIComponent(l.id)}/playback`,
            completePercent: l.complete_percent || 0,
            duration: pb.duration_sec || v.duration_sec || 0,
            watched: pb.watched_sec,
            furthest: pb.furthest_sec,
            done: s.done.has(l.id),
          })
        );
      },
    ];

    // "Complete at X % watched": the lesson cannot be ticked off by hand while the rule is on, and the page says where the student stands.
    const rule = (l: any) => !!l?.video_id && Number(l.complete_percent) > 0;
    const blockManual = (_s: unknown, l: any) => rule(l);
    app.services.lessonCompleteBlock = [...((app.services.lessonCompleteBlock as unknown[] | undefined) ?? []), blockManual];
    app.services.lessonExtras = [
      ...((app.services.lessonExtras as unknown[] | undefined) ?? []),
      (_p: any, _m: any, s: any, l: any) => {
        if (!rule(l)) return undefined;
        const pb = getPlayback(app, s.enrollment.id, l.id);
        const done = s.done.has(l.id);
        const note = done ? '<span class="pill ok">✓ Erledigt</span>' : `<span class="muted small">Gesehen: ${watchedPercent(pb)} % von ${l.complete_percent} % – die Lektion schließt sich von selbst ab.</span>`;
        return { html: `<p style="margin:22px 0 0">${note}</p>`, hideMark: true };
      },
    ];

    const reportLimit = limiter(120, 60_000);
    router.post('/portal/:p/c/:course/:lesson/playback', 'public', (ctx) => {
      const kit = app.services.portalKit;
      const course = app.services.courseKit;
      const p = kit?.resolve(ctx.params.p);
      if (!p || !course) return json({ error: 'Nicht gefunden' }, 404);
      const m = kit.memberOf(ctx, p);
      if (!m) return json({ error: 'Bitte neu anmelden' }, 401);
      // Only our own player may report: same origin and a header that a foreign page cannot add without our consent.
      if (!kit.sameOrigin(ctx) || ctx.req.headers['x-course-player'] !== '1') return json({ error: 'Anfrage abgelehnt' }, 403);
      if (reportLimit(m.contact.id)) return json({ error: 'Zu viele Meldungen' }, 429);
      const s = course.seat(p, m.contact.id, ctx.params.course);
      const l = s?.lessons.find((x: any) => x.id === ctx.params.lesson);
      if (!s || !l || !l.video_id || !course.open(s, l)) return json({ error: 'Nicht gefunden' }, 404);
      const v = readyVideo(app, p.locationId, l.video_id);
      const prev = getPlayback(app, s.enrollment.id, l.id);
      const pb = applyPlayback(prev.updated_at ? prev : undefined, ctx.body ?? {}, { duration: v?.duration_sec });
      savePlayback(app, s.enrollment.id, l.id, pb);
      let completed = s.done.has(l.id);
      const otherBlocks = ((app.services.lessonCompleteBlock ?? []) as ((s: unknown, l: unknown) => boolean)[]).filter((fn) => fn !== blockManual);
      if (!completed && rule(l) && isWatchedEnough(pb, l.complete_percent) && !otherBlocks.some((fn) => fn(s, l))) {
        course.setDone(s, l, true);
        completed = true;
      }
      return json({ ok: true, completed, watched_percent: watchedPercent(pb), position: pb.position_sec });
    });

    app.onTick(() => sweepUploads(app));

    // GDPR access: the watch progress hangs on the enrollment (it is deleted with it on erase).
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, c: { id: string }) => {
        const rows = db.all(
          `SELECT pb.lesson_id, pb.position_sec, pb.watched_sec, pb.furthest_sec, pb.duration_sec, pb.speed, pb.updated_at
           FROM course_playback pb JOIN course_enrollments e ON e.id = pb.enrollment_id WHERE e.contact_id = ? AND e.location_id = ?`,
          c.id,
          loc,
        );
        return rows.length ? { course_playback: rows } : {};
      },
    ];
  },
};
