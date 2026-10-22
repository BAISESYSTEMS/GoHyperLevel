import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { id, now } from '../core/util.js';
import { looksLikeVideo, extOf, VIDEO_EXT } from './webinar-video.js';
import { embedHtml, videoEmbed } from './markdown.js';

/**
 * What a community post can carry besides text and pictures: a poll, a video (YouTube, Vimeo, Loom or MP4 link, or a file the
 * person uploaded) and a GIF by link. All of it is checked before the post exists; nothing from outside is embedded unchecked.
 */

// --- polls -----------------------------------------------------------------------------------------------------------------

export const POLL_OPTIONS_MAX = 6;

export interface PollInput {
  question: string;
  options: string[];
  multi: boolean;
  days: number;
}

/** Reads a poll from form fields or the API; null when none was asked for. */
export function cleanPoll(input: { question?: unknown; options?: unknown; multi?: unknown; days?: unknown } | null | undefined): PollInput | null {
  if (!input) return null;
  const question = String(input.question ?? '').replace(/\s+/g, ' ').trim();
  const options = [...new Set((Array.isArray(input.options) ? input.options : []).map((o) => String(o ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))];
  if (!question && !options.length) return null;
  if (question.length < 3) throw bad('Umfrage: bitte eine Frage stellen');
  if (question.length > 200) throw bad('Umfrage: die Frage ist zu lang');
  if (options.length < 2) throw bad('Umfrage: mindestens zwei Antworten');
  if (options.length > POLL_OPTIONS_MAX) throw bad(`Umfrage: höchstens ${POLL_OPTIONS_MAX} Antworten`);
  const days = Math.min(Math.max(Math.round(Number(input.days) || 0), 0), 30);
  return { question, options, multi: input.multi === true || input.multi === '1' || input.multi === 'on' || input.multi === 'true', days };
}

export function createPoll(app: App, post: { id: string; location_id: string; group_id: string }, p: PollInput) {
  const options = p.options.map((text, i) => ({ id: `o${i + 1}`, text }));
  app.db.insert('community_polls', {
    id: id(),
    post_id: post.id,
    location_id: post.location_id,
    group_id: post.group_id,
    question: p.question,
    options,
    multi: p.multi ? 1 : 0,
    closes_at: p.days ? new Date(Date.now() + p.days * 864e5).toISOString() : null,
    created_at: now(),
  });
}

export interface PollView {
  id: string;
  question: string;
  options: { id: string; text: string; votes: number; mine: boolean }[];
  multi: boolean;
  closes_at: string | null;
  closed: boolean;
  voters: number;
  voted: boolean;
}

export function pollOf(app: App, postId: string, contactId?: string | null): PollView | undefined {
  const row = app.db.get<any>('SELECT * FROM community_polls WHERE post_id = ?', postId);
  if (!row) return undefined;
  const opts: { id: string; text: string }[] = JSON.parse(row.options);
  const counts = new Map(app.db.all<{ option_id: string; n: number }>('SELECT option_id, COUNT(*) AS n FROM community_poll_votes WHERE poll_id = ? GROUP BY option_id', row.id).map((r) => [r.option_id, r.n]));
  const mine = new Set(contactId ? app.db.all<{ option_id: string }>('SELECT option_id FROM community_poll_votes WHERE poll_id = ? AND contact_id = ?', row.id, contactId).map((r) => r.option_id) : []);
  const voters = app.db.get<{ n: number }>('SELECT COUNT(DISTINCT contact_id) AS n FROM community_poll_votes WHERE poll_id = ?', row.id)!.n;
  return {
    id: row.id,
    question: row.question,
    options: opts.map((o) => ({ ...o, votes: counts.get(o.id) ?? 0, mine: mine.has(o.id) })),
    multi: !!row.multi,
    closes_at: row.closes_at,
    closed: !!row.closes_at && row.closes_at <= now(),
    voters,
    voted: mine.size > 0,
  };
}

/** Records (or replaces) a member's vote; a closed poll takes none. */
export function castVote(app: App, pollId: string, contactId: string, optionIds: string[]): void {
  const row = app.db.get<any>('SELECT * FROM community_polls WHERE id = ?', pollId);
  if (!row) throw new HttpError(404, 'Umfrage nicht gefunden');
  if (row.closes_at && row.closes_at <= now()) throw bad('Diese Umfrage ist beendet.');
  const valid = new Set((JSON.parse(row.options) as { id: string }[]).map((o) => o.id));
  const picked = [...new Set(optionIds.filter((o) => valid.has(o)))];
  if (!picked.length) throw bad('Bitte eine Antwort wählen.');
  if (picked.length > 1 && !row.multi) throw bad('Bei dieser Umfrage ist nur eine Antwort möglich.');
  app.db.tx(() => {
    app.db.run('DELETE FROM community_poll_votes WHERE poll_id = ? AND contact_id = ?', pollId, contactId);
    for (const o of picked) app.db.run('INSERT INTO community_poll_votes (poll_id, contact_id, option_id, created_at) VALUES (?, ?, ?, ?)', pollId, contactId, o, now());
  });
}

// --- GIFs -------------------------------------------------------------------------------------------------------------------------

/** Where a GIF may come from: the big GIF services and image hosts – never a tracking pixel on a stranger's server. */
export const GIF_HOSTS = ['media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com', 'i.giphy.com', 'media.tenor.com', 'c.tenor.com', 'i.imgur.com', 'upload.wikimedia.org'];
const GIF_EXT = /\.(gif|webp|png|jpe?g|avif)$/i;

export function cleanGifUrl(v: unknown, opts: { extraHosts?: string[]; ownHost?: string } = {}): string {
  let s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length > 500) throw bad('GIF: der Link ist zu lang');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad('GIF: bitte den Link zu einem GIF angeben (https://…)');
  }
  if (u.protocol !== 'https:') throw bad('GIF: nur https://-Links sind erlaubt');
  if (u.username || u.password) throw bad('GIF: Links ohne Zugangsdaten bitte');
  // A Giphy page link becomes the image behind it.
  const page = /^(?:www\.)?giphy\.com$/.test(u.hostname) ? /\/(?:gifs|stickers|embed)\/(?:[\w-]*-)?([A-Za-z0-9]{8,24})\/?$/.exec(u.pathname) : null;
  if (page) {
    s = `https://media.giphy.com/media/${page[1]}/giphy.gif`;
    u = new URL(s);
  }
  const allowed = [...GIF_HOSTS, ...(opts.extraHosts ?? []).map((h) => h.toLowerCase()), ...(opts.ownHost ? [opts.ownHost.toLowerCase()] : [])];
  if (!allowed.includes(u.hostname.toLowerCase())) throw bad(`GIF: dieser Anbieter ist nicht freigegeben (erlaubt: Giphy, Tenor, Imgur – oder ein Link zu einem GIF auf dieser Website)`);
  if (!GIF_EXT.test(u.pathname)) throw bad('GIF: der Link muss direkt auf eine Bilddatei zeigen (.gif, .webp …)');
  return u.href;
}

// --- video ---------------------------------------------------------------------------------------------------------------------------

export type PostVideo = { kind: 'link'; url: string } | { kind: 'upload'; upload_id: string; name: string };

export function cleanVideoLink(v: unknown): PostVideo | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^https:\/\//i.test(s) || s.length > 500) throw bad('Video: bitte einen Link mit https:// angeben (YouTube, Vimeo, Loom oder eine MP4-Datei)');
  if (!videoEmbed(s)) throw bad('Video: YouTube, Vimeo, Loom oder eine direkte MP4-/WebM-Datei – anderen Links fehlt ein Player');
  return { kind: 'link', url: s };
}

export const videoDir = (app: App) => join(app.config.dataDir, 'community', 'videos');
export const maxVideoMb = () => Math.max(1, Number(process.env.PGHL_COMMUNITY_VIDEO_MB) || 500);
export const CHUNK = 8 * 1024 * 1024;

export interface VideoUpload {
  id: string;
  location_id: string;
  group_id: string;
  contact_id: string | null;
  name: string;
  file: string;
  size: number;
  received: number;
  status: 'open' | 'complete';
  created_at: string;
}

export function startVideoUpload(app: App, g: { id: string; location_id: string }, contactId: string | null, name: string, size: number): VideoUpload {
  const n = String(name ?? '').trim().slice(0, 200);
  if (!VIDEO_EXT.includes(extOf(n))) throw bad(`Nur Videodateien (${VIDEO_EXT.join(', ')})`);
  if (!(size > 0)) throw bad('Dateigröße fehlt');
  if (size > maxVideoMb() * 1024 * 1024) throw bad(`Video größer als ${maxVideoMb()} MB (Grenze einstellbar mit PGHL_COMMUNITY_VIDEO_MB)`);
  // A few unfinished uploads per person, never more.
  const open = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_videos WHERE group_id = ? AND status = 'open' AND COALESCE(contact_id, '') = ?`, g.id, contactId ?? '')!.n;
  if (open >= 2) throw new HttpError(429, 'Es laufen schon zwei Uploads – bitte warten.');
  // A member (anybody who joined) may not fill the disk with videos nobody attaches to a post: three videos' worth per day, the team is not limited.
  if (contactId) {
    const today = new Date(Date.now() - 864e5).toISOString();
    const used = Number(app.db.get<{ n: number }>(`SELECT COALESCE(SUM(size), 0) AS n FROM community_videos WHERE group_id = ? AND contact_id = ? AND created_at >= ?`, g.id, contactId, today)?.n ?? 0);
    if (used + size > 3 * maxVideoMb() * 1024 * 1024) throw new HttpError(429, 'Du hast heute schon viele Videos hochgeladen – bitte morgen noch einmal.');
  }
  app.services.storageGate?.(g.location_id, size);
  mkdirSync(videoDir(app), { recursive: true });
  const row: VideoUpload = { id: id(24), location_id: g.location_id, group_id: g.id, contact_id: contactId, name: n, file: `${id(20)}${extOf(n)}`, size, received: 0, status: 'open', created_at: now() };
  writeFileSync(join(videoDir(app), row.file), '');
  app.db.insert('community_videos', row);
  return row;
}

/** Appends one part; returns the new state. The first part must look like a video container. */
export function appendVideoChunk(app: App, up: VideoUpload, offset: number, buf: Buffer): { id: string; received: number; complete: boolean } {
  if (up.status !== 'open') return { id: up.id, received: up.received, complete: true };
  if (!buf?.length) throw bad('Daten fehlen');
  if (buf.length > CHUNK) throw bad(`Höchstens ${CHUNK / 1024 / 1024} MB pro Teil`);
  if (offset !== up.received) {
    if (offset + buf.length === up.received) return { id: up.id, received: up.received, complete: false };
    throw new HttpError(409, `Erwartet wird der Teil ab Byte ${up.received}`);
  }
  if (offset + buf.length > up.size) throw bad('Mehr Daten als angekündigt');
  if (offset === 0 && !looksLikeVideo(buf)) {
    rmSync(join(videoDir(app), up.file), { force: true });
    app.db.run('DELETE FROM community_videos WHERE id = ?', up.id);
    throw bad('Das ist keine Videodatei (MP4, MOV, WebM, MKV, Ogg)');
  }
  appendFileSync(join(videoDir(app), up.file), buf);
  const received = offset + buf.length;
  const complete = received === up.size;
  app.db.run('UPDATE community_videos SET received = ?, status = ? WHERE id = ?', received, complete ? 'complete' : 'open', up.id);
  return { id: up.id, received, complete };
}

export function removeVideo(app: App, uploadId: string) {
  const up = app.db.get<VideoUpload>('SELECT * FROM community_videos WHERE id = ?', uploadId);
  if (!up) return;
  rmSync(join(videoDir(app), up.file), { force: true });
  app.db.run('DELETE FROM community_videos WHERE id = ?', up.id);
}

export const videoPath = (app: App, up: Pick<VideoUpload, 'file'>) => join(videoDir(app), up.file);
export const videoExists = (app: App, up: Pick<VideoUpload, 'file'>) => existsSync(videoPath(app, up)) && statSync(videoPath(app, up)).isFile();

/** The player for a post video; uploads stream from `src(id)`. */
export function videoHtml(v: PostVideo, src: (uploadId: string) => string, title = 'Video'): string {
  if (v.kind === 'link') {
    const e = videoEmbed(v.url);
    return e ? embedHtml(e, title) : `<p><a href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer">Video öffnen</a></p>`;
  }
  return `<div class="md-video"><video src="${escapeHtml(src(v.upload_id))}" controls preload="metadata" playsinline></video></div>`;
}
