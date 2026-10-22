import { spawn } from 'node:child_process';
import { bad } from '../core/http.js';

/**
 * Course video, pure parts: chapters, captions (WebVTT / SRT), resume position and "watched" bookkeeping, the signed-URL
 * payload and the ffmpeg command lines. Nothing here touches the database or the disk (see course-video.ts for that), so every
 * rule can be tested with plain values.
 */

// --- chapters ------------------------------------------------------------------------------------------------------------

export interface Chapter {
  /** Start in seconds. */
  t: number;
  title: string;
}

/** "1:02:03", "12:30" or "45" → seconds (undefined when it is not a time). */
export function parseTimestamp(v: string): number | undefined {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,]\d{1,3})?$|^(\d{1,6})$/.exec(v.trim());
  if (!m) return undefined;
  if (m[4] !== undefined) return Number(m[4]);
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (s > 59 || (m[1] !== undefined && min > 59)) return undefined;
  return h * 3600 + min * 60 + s;
}

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/**
 * Chapters from the editor: a list of {t, title} or text in the usual YouTube style, one per line ("0:00 Einleitung").
 * Sorted by time, equal times keep the first, at most 60.
 */
export function cleanChapters(input: unknown): Chapter[] {
  let list: { t?: unknown; title?: unknown }[] = [];
  if (Array.isArray(input)) list = input as any[];
  else if (typeof input === 'string') {
    for (const line of input.split(/\r?\n/)) {
      const m = /^\s*[-*•]?\s*\(?(\d{1,2}:\d{2}(?::\d{2})?|\d{1,6})\)?\s*[-–—:.]?\s*(.+?)\s*$/.exec(line);
      if (m) list.push({ t: parseTimestamp(m[1]), title: m[2] });
      else if (line.trim()) throw bad(`Kapitel: „${line.trim().slice(0, 40)}“ – bitte als „0:00 Titel“ schreiben`);
    }
  } else if (input !== undefined && input !== null && input !== '') throw bad('Kapitel: Liste oder Text erwartet');
  const out: Chapter[] = [];
  for (const c of list.slice(0, 60)) {
    const t = typeof c.t === 'number' ? c.t : parseTimestamp(String(c.t ?? ''));
    const title = String(c.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (t === undefined || !Number.isFinite(t) || t < 0 || t > 86_400) throw bad('Kapitel: ungültige Zeit');
    if (!title) throw bad('Kapitel: Titel fehlt');
    out.push({ t: Math.round(t), title });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((c, i) => i === 0 || c.t !== out[i - 1].t);
}

export const chaptersText = (list: Chapter[]) => list.map((c) => `${formatTimestamp(c.t)} ${c.title}`).join('\n');

// --- captions ------------------------------------------------------------------------------------------------------------

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export const CAPTION_MAX_BYTES = 512 * 1024;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export function cleanLang(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!LANG.test(s)) throw bad('Sprachcode wie „de“ oder „en“ angeben');
  return s.replace(/^([a-z]+)(?:-([a-z0-9]+))?$/i, (_m, a, b) => (b ? `${a.toLowerCase()}-${b.length === 2 ? b.toUpperCase() : b.toLowerCase()}` : a.toLowerCase()));
}

const timeOf = (s: string): number | undefined => {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
};

/** Only plain text and the basic emphasis tags survive; a caption can never carry markup that does something. */
const cueText = (s: string) =>
  s
    .replace(/<(?!\/?(?:b|i|u)>)[^>]*>/gi, '')
    .replace(/&(?!amp;|lt;|gt;|nbsp;|#\d+;)/g, '&amp;')
    .replace(/\r/g, '')
    .trim();

/** WebVTT or SRT → cues. Throws a German message for text that is neither. */
export function parseCaptions(source: string): Cue[] {
  const text = String(source ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw bad('Die Untertitel-Datei ist leer');
  const isVtt = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text);
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = timeOf(a ?? '');
    const end = timeOf((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === undefined || end === undefined || end <= start) throw bad(`Untertitel: ungültige Zeitangabe „${lines[at].slice(0, 40)}“`);
    const body = cueText(lines.slice(at + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
    if (cues.length > 20_000) throw bad('Untertitel: zu viele Einträge');
  }
  if (!cues.length) throw bad(isVtt ? 'In der Datei stehen keine Untertitel-Einträge' : 'Das ist weder WebVTT noch SRT (die Datei muss mit „WEBVTT“ beginnen oder nummerierte Einträge haben)');
  cues.sort((x, y) => x.start - y.start);
  return cues;
}

const vttTime = (sec: number) => {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const two = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${two(h)}:${two(m)}:${two(s)}.${two(ms % 1000, 3)}`;
};

export const formatVtt = (cues: Cue[]) => `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join('\n\n')}\n`;

/** The text of a caption file without timings (for a transcript or a search). */
export const cuesPlain = (cues: Cue[]) => cues.map((c) => c.text.replace(/<[^>]+>/g, '')).join(' ').replace(/\s+/g, ' ').trim();

/**
 * Speech-to-text returns text per audio piece, not per word. Each piece is split into sentences and the piece's time is shared
 * between them by length, so captions follow the speech closely enough to read along.
 */
export function cuesFromChunks(chunks: { start: number; end: number; text: string }[], maxChars = 84): Cue[] {
  const cues: Cue[] = [];
  for (const ch of chunks) {
    const text = ch.text.replace(/\s+/g, ' ').trim();
    if (!text || !(ch.end > ch.start)) continue;
    const parts: string[] = [];
    for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text]) {
      let rest = sentence.trim();
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(' ', maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        parts.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) parts.push(rest);
    }
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let at = ch.start;
    for (const p of parts) {
      const dur = ((ch.end - ch.start) * p.length) / total;
      cues.push({ start: at, end: at + dur, text: p });
      at += dur;
    }
  }
  return cues;
}

// --- resume position and "watched" -------------------------------------------------------------------------------------------

export interface Playback {
  position_sec: number;
  duration_sec: number;
  furthest_sec: number;
  watched_sec: number;
  speed: number;
  updated_at: string | null;
}

export const EMPTY_PLAYBACK: Playback = { position_sec: 0, duration_sec: 0, furthest_sec: 0, watched_sec: 0, speed: 1, updated_at: null };
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const clampNum = (v: unknown, min: number, max: number, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/**
 * What a player report does to a student's stored state. The server never trusts the player blindly:
 *  - watched time only grows, and by at most 3× the wall-clock time since the last report plus a small allowance, so a script that
 *    posts "I watched everything" cannot finish a lesson in a second;
 *  - the duration is the file's own (when known), the player's figure only as a fallback;
 *  - position and furthest point stay inside the video.
 */
export function applyPlayback(prev: Playback | undefined, input: Record<string, unknown>, opts: { duration?: number; now?: number } = {}): Playback {
  const p = prev ?? EMPTY_PLAYBACK;
  const now = opts.now ?? Date.now();
  const reported = clampNum(input.duration, 0, 86_400);
  const duration = opts.duration && opts.duration > 0 ? opts.duration : reported || p.duration_sec;
  const cap = duration > 0 ? duration : 86_400;
  const position = clampNum(input.position, 0, cap);
  const furthest = Math.max(p.furthest_sec, clampNum(input.furthest, 0, cap), position);
  const elapsed = p.updated_at ? Math.max(0, (now - Date.parse(p.updated_at)) / 1000) : 0;
  const allowance = Math.min(elapsed, 6 * 3600) * 3 + 6;
  const watched = Math.max(p.watched_sec, Math.min(clampNum(input.watched, 0, cap), p.watched_sec + allowance));
  const speed = SPEEDS.includes(Number(input.speed)) ? Number(input.speed) : p.speed || 1;
  return { position_sec: round1(position), duration_sec: round1(duration), furthest_sec: round1(furthest), watched_sec: round1(watched), speed, updated_at: new Date(now).toISOString() };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Where "weiter ansehen" starts: not for the first seconds, not for the last ones (then it starts over). */
export function resumeAt(pb: Pick<Playback, 'position_sec' | 'duration_sec'> | undefined): number {
  if (!pb) return 0;
  const { position_sec: pos, duration_sec: dur } = pb;
  if (pos < 5) return 0;
  if (dur > 0 && pos > dur - 8) return 0;
  return Math.floor(pos);
}

/** Share of the video that was really watched, 0–100. */
export const watchedPercent = (pb: Pick<Playback, 'watched_sec' | 'duration_sec'>) => (pb.duration_sec > 0 ? Math.min(100, Math.round((pb.watched_sec / pb.duration_sec) * 100)) : 0);

/** Lesson setting "complete at X % watched": 0 = off, otherwise 10–100. */
export function cleanCompletePercent(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(n, 10), 100);
}

export const isWatchedEnough = (pb: Pick<Playback, 'watched_sec' | 'duration_sec'>, percent: number) => percent > 0 && pb.duration_sec > 0 && pb.watched_sec >= (pb.duration_sec * percent) / 100 - 0.5;

// --- file types ------------------------------------------------------------------------------------------------------------

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska' };
export const mimeOfVideo = (file: string) => MIME[(/\.[a-z0-9]{2,5}$/i.exec(file) ?? [''])[0].toLowerCase()] ?? 'video/mp4';

export const HLS_TYPES: Record<string, string> = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4' };

/** Names inside a video's HLS folder that may be served: flat, no path tricks. */
export const HLS_NAME = /^[A-Za-z0-9_-]{1,40}\.(m3u8|ts)$/;

/** Playlist lines that point at files get the viewer's token, so the segments are covered by the same signed URL. */
export function signPlaylist(playlist: string, token: string): string {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${withToken(u, token)}"`);
      return withToken(line.trim(), token);
    })
    .join('\n');
}
const withToken = (uri: string, token: string) => (/^[A-Za-z0-9_-]{1,40}\.(?:m3u8|ts)$/.test(uri) ? `${uri}?t=${encodeURIComponent(token)}` : uri);

// --- ffmpeg ------------------------------------------------------------------------------------------------------------------

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ToolRunner = (tool: 'ffmpeg' | 'ffprobe', args: string[], opts?: { timeoutMs?: number }) => Promise<ToolResult>;

/** Runs ffmpeg/ffprobe (the binary names or PGHL_FFMPEG / PGHL_FFPROBE) without a shell. */
export const runTool: ToolRunner = (tool, args, opts = {}) =>
  new Promise((resolve) => {
    const bin = (tool === 'ffmpeg' ? process.env.PGHL_FFMPEG : process.env.PGHL_FFPROBE) || tool;
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String((e as Error).message) });
    }
    let stdout = '';
    let stderr = '';
    const keep = (s: string, add: string) => (s + add).slice(-200_000);
    child.stdout.on('data', (d) => (stdout = keep(stdout, String(d))));
    child.stderr.on('data', (d) => (stderr = keep(stderr, String(d))));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 6 * 3600_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** "Duration: 00:12:34.56" in ffmpeg's banner → seconds. */
export function durationFromBanner(text: string): number {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(text);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

/** "Stream #0:0: Video: h264 …, 1920x1080" → the video's height. */
export function heightFromBanner(text: string): number {
  const m = /Stream #\d+:\d+[^\n]*Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(text);
  return m ? Number(m[2]) : 0;
}

export const posterArgs = (input: string, out: string, at: number) => ['-y', '-ss', String(Math.max(0, Math.floor(at))), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', out];
export const faststartArgs = (input: string, out: string) => ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', out];
export const audioSegmentArgs = (input: string, outPattern: string, seconds = 60) => ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1', outPattern];

export const HLS_LADDER = [
  { height: 360, video: '800k', audio: '96k' },
  { height: 720, video: '2800k', audio: '128k' },
  { height: 1080, video: '5000k', audio: '160k' },
];

/** The renditions worth making for a source of this height (never bigger than the source; at least one). */
export function hlsLadder(sourceHeight: number) {
  const ok = HLS_LADDER.filter((r) => !sourceHeight || r.height <= sourceHeight + 8);
  return ok.length ? ok : [HLS_LADDER[0]];
}

/** One ffmpeg run → master.m3u8 + one playlist per rendition (v0.m3u8 …) + segments (v0_000.ts …) in `dir`. */
export function hlsArgs(input: string, dir: string, sourceHeight: number, hasAudio = true): string[] {
  const ladder = hlsLadder(sourceHeight);
  const n = ladder.length;
  const split = `[0:v]split=${n}${ladder.map((_r, i) => `[s${i}]`).join('')}`;
  const scales = ladder.map((r, i) => `[s${i}]scale=-2:${r.height}[v${i}]`).join(';');
  const args = ['-y', '-i', input, '-filter_complex', `${split};${scales}`];
  ladder.forEach((r, i) => {
    args.push('-map', `[v${i}]`, `-c:v:${i}`, 'libx264', `-b:v:${i}`, r.video, `-maxrate:v:${i}`, r.video, `-bufsize:v:${i}`, String(parseInt(r.video, 10) * 2) + 'k');
    if (hasAudio) args.push('-map', 'a:0?', `-c:a:${i}`, 'aac', `-b:a:${i}`, r.audio);
  });
  args.push('-preset', 'veryfast', '-g', '48', '-sc_threshold', '0', '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments');
  args.push('-hls_segment_filename', `${dir}/v%v_%03d.ts`, '-master_pl_name', 'master.m3u8');
  args.push('-var_stream_map', ladder.map((_r, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '));
  args.push(`${dir}/v%v.m3u8`);
  return args;
}
