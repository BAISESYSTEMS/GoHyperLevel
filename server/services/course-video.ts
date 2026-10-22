import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { id, now } from '../core/util.js';
import { CHUNK } from './community-posts-ext.js';
import { openToken, signToken } from './creator-kit.js';
import { VIDEO_EXT, extOf, looksLikeVideo } from './webinar-video.js';
import { hasVoiceConnection, transcribe } from './voice-engine.js';
import {
  CAPTION_MAX_BYTES,
  EMPTY_PLAYBACK,
  audioSegmentArgs,
  cuesFromChunks,
  durationFromBanner,
  faststartArgs,
  formatVtt,
  heightFromBanner,
  hlsArgs,
  parseCaptions,
  posterArgs,
  runTool,
  type Playback,
  type ToolResult,
  type ToolRunner,
} from './course-media.js';

/**
 * Course videos on this server: the chunked upload (same protocol as the community's video upload: start, send 8 MB parts with
 * an offset, resume where the server says), storage under the data directory, the signed URLs members play from, poster frame,
 * the optional ffmpeg work (faststart, duration, poster, HLS) and AI captions through the voice layer's speech-to-text.
 */

export { CHUNK };

export interface CourseVideo {
  id: string;
  location_id: string;
  name: string;
  file: string;
  size: number;
  received: number;
  status: 'open' | 'complete';
  mime: string;
  duration_sec: number;
  poster: string;
  hls: '' | 'pending' | 'ready' | 'failed';
  hls_note: string;
  ai_status: '' | 'running' | 'done' | 'failed';
  ai_note: string;
  created_at: string;
}

export const courseVideoDir = (app: App) => join(app.config.dataDir, 'course-videos');
export const maxCourseVideoMb = () => Math.max(1, Number(process.env.PGHL_COURSE_VIDEO_MB) || 2048);
export const videoFile = (app: App, v: Pick<CourseVideo, 'file'>) => join(courseVideoDir(app), v.file);
export const hlsDir = (app: App, v: Pick<CourseVideo, 'id'>) => join(courseVideoDir(app), v.id, 'hls');
export const posterFile = (app: App, v: Pick<CourseVideo, 'id' | 'poster'>) => join(courseVideoDir(app), v.poster || `${v.id}.jpg`);

export const getVideo = (app: App, locationId: string, videoId: string) => app.db.get<CourseVideo>('SELECT * FROM course_videos WHERE id = ? AND location_id = ?', String(videoId ?? ''), locationId);

/** A finished upload of this sub-account, or null – lessons may only point at those. */
export const readyVideo = (app: App, locationId: string, videoId: unknown): CourseVideo | null => {
  const v = getVideo(app, locationId, String(videoId ?? ''));
  return v && v.status === 'complete' && existsSync(videoFile(app, v)) ? v : null;
};

// --- upload --------------------------------------------------------------------------------------------------------------

export function startUpload(app: App, locationId: string, name: string, size: number): CourseVideo {
  const n = String(name ?? '').replace(/[\r\n\\/]/g, '_').trim().slice(0, 200);
  if (!VIDEO_EXT.includes(extOf(n))) throw bad(`Nur Videodateien (${VIDEO_EXT.join(', ')})`);
  if (!(size > 0)) throw bad('Dateigröße fehlt');
  if (size > maxCourseVideoMb() * 1024 * 1024) throw bad(`Video größer als ${maxCourseVideoMb()} MB (Grenze einstellbar mit PGHL_COURSE_VIDEO_MB)`);
  const open = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM course_videos WHERE location_id = ? AND status = 'open'`, locationId)!.n;
  if (open >= 3) throw new HttpError(429, 'Es laufen schon drei Uploads – bitte warten oder einen abbrechen.');
  // Hosted service: the plan's media storage (fair use) counts videos too.
  app.services.storageGate?.(locationId, size);
  mkdirSync(courseVideoDir(app), { recursive: true });
  const vid = id(24);
  const row: CourseVideo = { id: vid, location_id: locationId, name: n, file: `${vid}${extOf(n)}`, size, received: 0, status: 'open', mime: 'video/mp4', duration_sec: 0, poster: '', hls: '', hls_note: '', ai_status: '', ai_note: '', created_at: now() };
  writeFileSync(videoFile(app, row), '');
  app.db.insert('course_videos', row);
  return row;
}

/** Appends one part at `offset`. A repeated part is answered with the current state; a gap is a 409 with the offset to resume at. */
export function appendChunk(app: App, v: CourseVideo, offset: number, buf: Buffer): { id: string; received: number; complete: boolean } {
  if (v.status !== 'open') return { id: v.id, received: v.received, complete: true };
  if (!buf?.length) throw bad('Daten fehlen');
  if (buf.length > CHUNK) throw bad(`Höchstens ${CHUNK / 1024 / 1024} MB pro Teil`);
  if (offset !== v.received) {
    if (offset + buf.length === v.received) return { id: v.id, received: v.received, complete: false };
    throw new HttpError(409, `Erwartet wird der Teil ab Byte ${v.received}`, { received: v.received });
  }
  if (offset + buf.length > v.size) throw bad('Mehr Daten als angekündigt');
  if (offset === 0 && !looksLikeVideo(buf)) {
    removeVideoFiles(app, v);
    app.db.run('DELETE FROM course_videos WHERE id = ?', v.id);
    throw bad('Das ist keine Videodatei (MP4, MOV, WebM, MKV, Ogg)');
  }
  appendFileSync(videoFile(app, v), buf);
  const received = offset + buf.length;
  const complete = received === v.size;
  app.db.run('UPDATE course_videos SET received = ?, status = ? WHERE id = ?', received, complete ? 'complete' : 'open', v.id);
  return { id: v.id, received, complete };
}

export function removeVideoFiles(app: App, v: Pick<CourseVideo, 'id' | 'file' | 'poster'>) {
  rmSync(videoFile(app, v), { force: true });
  rmSync(posterFile(app, v), { force: true });
  // HLS renditions and the audio cut for transcription live in <id>/ (the data export and the erase find them by that name).
  rmSync(join(courseVideoDir(app), v.id), { recursive: true, force: true });
}

/** Drops the per-video folder when nothing is left in it. */
function tidyDir(app: App, videoId: string) {
  try {
    rmdirSync(join(courseVideoDir(app), videoId));
  } catch {
    /* not empty or already gone */
  }
}

export function removeVideo(app: App, locationId: string, videoId: string): boolean {
  const v = getVideo(app, locationId, videoId);
  if (!v) return false;
  app.db.tx(() => {
    app.db.run(`UPDATE course_lessons SET video_id = NULL WHERE video_id = ? AND location_id = ?`, v.id, locationId);
    app.db.run('DELETE FROM course_videos WHERE id = ?', v.id);
  });
  removeVideoFiles(app, v);
  return true;
}

export const videoSize = (app: App, v: CourseVideo) => {
  try {
    return statSync(videoFile(app, v)).size;
  } catch {
    return 0;
  }
};

// --- signed URLs -----------------------------------------------------------------------------------------------------------

export const MEDIA_TTL_MS = Math.max(5, Number(process.env.PGHL_COURSE_URL_TTL_MIN) || 360) * 60_000;

/** A short-lived token for one member and one video. The server still wants the member's session cookie on top of it. */
export const signMedia = (app: App, videoId: string, contactId: string, locationId: string, ttlMs = MEDIA_TTL_MS) => signToken(app, 'cvid', { v: videoId, c: contactId, l: locationId }, ttlMs);
export const openMedia = (app: App, token: unknown) => openToken<{ v: string; c: string; l: string; exp: number }>(app, 'cvid', token);

// --- optional tools (ffmpeg) -------------------------------------------------------------------------------------------------

const runner = (app: App): ToolRunner => (app.services.courseMediaRun as ToolRunner | undefined) ?? runTool;
let detected: { ffmpeg: boolean; at: number } | undefined;

/** Is ffmpeg there? Asked once and remembered for a minute (the test hook is asked every time). */
export async function hasFfmpeg(app: App): Promise<boolean> {
  if (process.env.PGHL_COURSE_NO_FFMPEG === '1') return false;
  if (app.services.courseMediaRun) return (await runner(app)('ffmpeg', ['-version']).catch(() => ({ code: 1 }))).code === 0;
  if (detected && Date.now() - detected.at < 60_000) return detected.ffmpeg;
  const r = await runTool('ffmpeg', ['-version'], { timeoutMs: 8000 });
  detected = { ffmpeg: r.code === 0, at: Date.now() };
  return detected.ffmpeg;
}

export const toolRun = (app: App, tool: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs?: number): Promise<ToolResult> => runner(app)(tool, args, { timeoutMs });

/** Duration, height and audio of a file from ffmpeg's banner (`ffmpeg -i` prints it and exits with 1, which is fine here). */
export async function probe(app: App, file: string): Promise<{ duration: number; height: number; audio: boolean }> {
  const r = await toolRun(app, 'ffmpeg', ['-hide_banner', '-i', file], 30_000);
  const text = `${r.stderr}\n${r.stdout}`;
  return { duration: durationFromBanner(text), height: heightFromBanner(text), audio: /Stream #\d+:\d+[^\n]*Audio:/.test(text) };
}

/** After an upload (when ffmpeg is there): fast start for MP4/MOV, duration, poster frame. Never throws – a failure just leaves the file as it is. */
export async function afterUpload(app: App, locationId: string, videoId: string): Promise<void> {
  try {
    if (!(await hasFfmpeg(app))) return;
    const v = getVideo(app, locationId, videoId);
    if (!v || v.status !== 'complete') return;
    const input = videoFile(app, v);
    const info = await probe(app, input);
    if (info.duration > 0) app.db.run('UPDATE course_videos SET duration_sec = ? WHERE id = ?', Math.round(info.duration * 10) / 10, v.id);
    if (/\.(mp4|m4v|mov)$/i.test(v.file)) {
      const tmp = `${input}.fast.mp4`;
      const r = await toolRun(app, 'ffmpeg', faststartArgs(input, tmp), 3600_000);
      if (r.code === 0 && existsSync(tmp) && statSync(tmp).size > 0) {
        rmSync(input, { force: true });
        renameSync(tmp, input);
      } else rmSync(tmp, { force: true });
    }
    if (!v.poster) await makePoster(app, v.location_id, v.id, info.duration > 0 ? Math.min(info.duration * 0.1, 10) : 1);
    if (process.env.PGHL_COURSE_HLS === '1') await (await startHls(app, v.location_id, v.id))();
  } catch (e) {
    console.error('[course-video] nach dem Upload', (e as Error).message);
  }
}

export async function makePoster(app: App, locationId: string, videoId: string, at: number): Promise<boolean> {
  const v = getVideo(app, locationId, videoId);
  if (!v || !(await hasFfmpeg(app))) return false;
  const out = join(courseVideoDir(app), `${v.id}.jpg`);
  const r = await toolRun(app, 'ffmpeg', posterArgs(videoFile(app, v), out, at), 120_000);
  if (r.code !== 0 || !existsSync(out) || statSync(out).size === 0) {
    rmSync(out, { force: true });
    return false;
  }
  app.db.run('UPDATE course_videos SET poster = ? WHERE id = ?', `${v.id}.jpg`, v.id);
  return true;
}

const running = new Set<string>();

/**
 * HLS ladder (360/720/1080 as far as the source reaches). The checks run now and fail loudly; the returned function does the long
 * work (call it in the background) and keeps the state in the row.
 */
export async function startHls(app: App, locationId: string, videoId: string): Promise<() => Promise<void>> {
  const v = getVideo(app, locationId, videoId);
  if (!v || v.status !== 'complete') throw bad('Das Video ist noch nicht fertig hochgeladen');
  if (!(await hasFfmpeg(app))) throw new HttpError(409, 'ffmpeg ist auf diesem Server nicht installiert – ohne ffmpeg wird die MP4-Datei direkt ausgeliefert.');
  if (running.has(v.id)) throw new HttpError(409, 'Die Umwandlung läuft schon');
  running.add(v.id);
  app.db.run(`UPDATE course_videos SET hls = 'pending', hls_note = '' WHERE id = ?`, v.id);
  return async () => {
    try {
      const dir = hlsDir(app, v);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const info = await probe(app, videoFile(app, v));
      const r = await toolRun(app, 'ffmpeg', hlsArgs(videoFile(app, v), dir, info.height, info.audio), 6 * 3600_000);
      if (r.code !== 0 || !existsSync(join(dir, 'master.m3u8'))) throw new Error(r.stderr.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'ffmpeg ist fehlgeschlagen');
      app.db.run(`UPDATE course_videos SET hls = 'ready', hls_note = '' WHERE id = ?`, v.id);
    } catch (e) {
      rmSync(hlsDir(app, v), { recursive: true, force: true });
      tidyDir(app, v.id);
      app.db.run(`UPDATE course_videos SET hls = 'failed', hls_note = ? WHERE id = ?`, String((e as Error).message).slice(0, 300), v.id);
      throw e;
    } finally {
      running.delete(v.id);
    }
  };
}

export const hlsReady = (app: App, v: CourseVideo) => v.hls === 'ready' && existsSync(join(hlsDir(app, v), 'master.m3u8'));
export const hlsFiles = (app: App, v: CourseVideo): string[] => {
  try {
    return readdirSync(hlsDir(app, v));
  } catch {
    return [];
  }
};

// --- captions ------------------------------------------------------------------------------------------------------------

export interface Caption {
  id: string;
  location_id: string;
  video_id: string;
  lang: string;
  label: string;
  vtt: string;
  source: 'upload' | 'ai';
  created_at: string;
}

/** Stores (or replaces) a caption track from an uploaded WebVTT/SRT text. */
export function saveCaption(app: App, v: CourseVideo, lang: string, label: string, text: string, source: 'upload' | 'ai' = 'upload'): Caption {
  if (Buffer.byteLength(text) > CAPTION_MAX_BYTES) throw bad(`Die Untertitel-Datei ist größer als ${CAPTION_MAX_BYTES / 1024} KB`);
  const vtt = formatVtt(parseCaptions(text));
  app.db.run('DELETE FROM course_captions WHERE video_id = ? AND lang = ?', v.id, lang);
  const row: Caption = { id: id(20), location_id: v.location_id, video_id: v.id, lang, label: label.slice(0, 60) || lang, vtt, source, created_at: now() };
  app.db.insert('course_captions', row);
  return row;
}

export const captionsOf = (app: App, videoId: string) => app.db.all<Caption>('SELECT * FROM course_captions WHERE video_id = ? ORDER BY lang', videoId);

const LANG_NAME: Record<string, string> = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands', pl: 'Polski', pt: 'Português', tr: 'Türkçe' };
export const langLabel = (lang: string) => LANG_NAME[lang.split('-')[0]] ?? lang;

const aiRunning = new Set<string>();
export const MAX_AI_SEGMENTS = 240;

/**
 * AI captions: ffmpeg cuts the audio into 60 s pieces, the sub-account's speech-to-text connection (KI-Anbieter, "Spracherkennung")
 * transcribes them one after the other, the text is spread over the pieces' time. The checks run now; the returned function does the
 * long work (call it in the background) and keeps the state in the row.
 */
export async function startTranscribe(app: App, locationId: string, videoId: string, language: string): Promise<() => Promise<void>> {
  const v = getVideo(app, locationId, videoId);
  if (!v || v.status !== 'complete') throw bad('Das Video ist noch nicht fertig hochgeladen');
  if (!hasVoiceConnection(app, locationId, 'stt')) throw new HttpError(409, 'Für Spracherkennung ist kein KI-Anbieter eingerichtet (Einstellungen → KI-Anbieter, Fähigkeit „Spracherkennung“).');
  if (!(await hasFfmpeg(app))) throw new HttpError(409, 'Für KI-Untertitel wird ffmpeg gebraucht (es schneidet den Ton in Stücke) – es ist auf diesem Server nicht installiert. Lade stattdessen eine WebVTT-/SRT-Datei hoch.');
  if (aiRunning.has(v.id)) throw new HttpError(409, 'Die Transkription läuft schon');
  aiRunning.add(v.id);
  app.db.run(`UPDATE course_videos SET ai_status = 'running', ai_note = '' WHERE id = ?`, v.id);
  const dir = join(courseVideoDir(app), v.id, 'stt');
  return async () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const r = await toolRun(app, 'ffmpeg', audioSegmentArgs(videoFile(app, v), join(dir, 'seg%04d.mp3'), 60), 3600_000);
      const parts = readdirSync(dir).filter((f) => /^seg\d{4}\.mp3$/.test(f)).sort();
      if (r.code !== 0 || !parts.length) throw new Error('Der Ton konnte nicht gelesen werden (hat das Video eine Tonspur?)');
      if (parts.length > MAX_AI_SEGMENTS) throw new Error(`Das Video ist zu lang für die automatische Transkription (höchstens ${MAX_AI_SEGMENTS} Minuten)`);
      const chunks: { start: number; end: number; text: string }[] = [];
      const total = v.duration_sec > 0 ? v.duration_sec : parts.length * 60;
      for (let i = 0; i < parts.length; i++) {
        const out = await transcribe(app, { locationId, audio: readFileSync(join(dir, parts[i])), hint: 'audio/mpeg', language });
        chunks.push({ start: i * 60, end: Math.min((i + 1) * 60, Math.max(total, i * 60 + 1)), text: out.text });
      }
      const cues = cuesFromChunks(chunks);
      if (!cues.length) throw new Error('Es wurde keine Sprache erkannt');
      saveCaption(app, getVideo(app, locationId, v.id) ?? v, language, langLabel(language), formatVtt(cues), 'ai');
      app.db.run(`UPDATE course_videos SET ai_status = 'done', ai_note = '' WHERE id = ?`, v.id);
    } catch (e) {
      app.db.run(`UPDATE course_videos SET ai_status = 'failed', ai_note = ? WHERE id = ?`, String((e as Error).message).slice(0, 300), v.id);
      throw e;
    } finally {
      aiRunning.delete(v.id);
      rmSync(dir, { recursive: true, force: true });
      tidyDir(app, v.id);
    }
  };
}

// --- playback state -------------------------------------------------------------------------------------------------------------

export function getPlayback(app: App, enrollmentId: string, lessonId: string): Playback {
  return app.db.get<Playback>('SELECT position_sec, duration_sec, furthest_sec, watched_sec, speed, updated_at FROM course_playback WHERE enrollment_id = ? AND lesson_id = ?', enrollmentId, lessonId) ?? { ...EMPTY_PLAYBACK };
}

export function savePlayback(app: App, enrollmentId: string, lessonId: string, pb: Playback) {
  app.db.run(
    `INSERT INTO course_playback (enrollment_id, lesson_id, position_sec, duration_sec, furthest_sec, watched_sec, speed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(enrollment_id, lesson_id) DO UPDATE SET position_sec = excluded.position_sec, duration_sec = excluded.duration_sec, furthest_sec = excluded.furthest_sec, watched_sec = excluded.watched_sec, speed = excluded.speed, updated_at = excluded.updated_at`,
    enrollmentId,
    lessonId,
    pb.position_sec,
    pb.duration_sec,
    pb.furthest_sec,
    pb.watched_sec,
    pb.speed,
    pb.updated_at ?? now(),
  );
}

/** Uploads nobody finished within a day are removed. */
export function sweepUploads(app: App) {
  const before = new Date(Date.now() - 864e5).toISOString();
  for (const v of app.db.all<CourseVideo>(`SELECT * FROM course_videos WHERE status = 'open' AND created_at < ?`, before)) {
    removeVideoFiles(app, v);
    app.db.run('DELETE FROM course_videos WHERE id = ?', v.id);
  }
}
