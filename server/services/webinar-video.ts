/**
 * Where the video of a webinar comes from, and how the room plays it. Pure functions.
 *
 *  upload        – a file the team uploaded to this server (chunked upload, streamed with Range)
 *  url           – a direct MP4/WebM link or an HLS playlist (.m3u8), https only
 *  youtube/vimeo – an embed; the room starts it at the right second (no player API: no drift correction)
 *  studio_clip   – a finished clip of the Video-Studio of this sub-account
 *  studio_upload – a video that was uploaded to the Video-Studio of this sub-account
 */

export type VideoSource =
  | { type: 'none' }
  | { type: 'upload'; upload_id: string; name: string }
  | { type: 'url'; url: string }
  | { type: 'youtube'; id: string }
  | { type: 'vimeo'; id: string; hash?: string }
  | { type: 'studio_clip'; clip_id: string; title?: string }
  | { type: 'studio_upload'; upload_id: string; name?: string };

export const VIDEO_TYPES = ['none', 'upload', 'url', 'youtube', 'vimeo', 'studio_clip', 'studio_upload'] as const;
export const NO_VIDEO: VideoSource = { type: 'none' };

export class VideoError extends Error {}

const ID = /^[A-Za-z0-9_-]{6,40}$/;
const YT = /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})(?:[?&#/].*)?$/i;
const VIMEO = /^(?:https?:\/\/)?(?:www\.)?(?:player\.)?vimeo\.com\/(?:video\/|[\w-]+\/)?(\d{5,12})(?:\/([0-9a-f]{6,16}))?(?:[?#].*)?$/i;

/** An https URL without credentials, or an error. */
export function httpsUrl(v: unknown, what = 'Link'): string {
  const raw = String(v ?? '').trim();
  if (!raw) throw new VideoError(`${what} fehlt`);
  if (raw.length > 2000) throw new VideoError(`${what} ist zu lang`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new VideoError(`${what}: bitte eine vollständige Adresse mit https:// angeben`);
  }
  if (u.protocol !== 'https:') throw new VideoError(`${what}: nur https:// ist erlaubt (Browser blockieren gemischte Inhalte)`);
  if (u.username || u.password) throw new VideoError(`${what}: Zugangsdaten gehören nicht in die Adresse`);
  return u.href;
}

/** Validates a video source from the editor or the API. YouTube and Vimeo links of any form are reduced to their id. */
export function cleanVideo(input: unknown): VideoSource {
  if (input === undefined || input === null || input === '') return NO_VIDEO;
  if (typeof input !== 'object' || Array.isArray(input)) throw new VideoError('Video: Objekt erwartet');
  const i = input as Record<string, any>;
  const type = String(i.type ?? 'none');
  switch (type) {
    case 'none':
      return NO_VIDEO;
    case 'upload': {
      const id = String(i.upload_id ?? '').trim();
      if (!/^[A-Za-z0-9]{8,32}$/.test(id)) throw new VideoError('Video: Upload fehlt');
      return { type, upload_id: id, name: String(i.name ?? '').slice(0, 200) };
    }
    case 'url': {
      const url = httpsUrl(i.url, 'Video-Link');
      // A YouTube/Vimeo link pasted as "MP4-Link" still works: it becomes an embed.
      const embed = embedOf(url);
      return embed ?? { type, url };
    }
    case 'youtube':
    case 'vimeo': {
      const raw = String(i.id ?? i.url ?? '').trim();
      const embed = embedOf(raw) ?? (type === 'youtube' && /^[\w-]{11}$/.test(raw) ? ({ type: 'youtube', id: raw } as VideoSource) : type === 'vimeo' && /^\d{5,12}$/.test(raw) ? ({ type: 'vimeo', id: raw } as VideoSource) : undefined);
      if (!embed || embed.type !== type) throw new VideoError(type === 'youtube' ? 'YouTube: bitte den Link oder die Video-ID angeben' : 'Vimeo: bitte den Link oder die Video-ID angeben');
      return embed;
    }
    case 'studio_clip': {
      const id = String(i.clip_id ?? '').trim();
      if (!ID.test(id)) throw new VideoError('Video-Studio: Clip fehlt');
      return { type, clip_id: id, title: String(i.title ?? '').slice(0, 200) };
    }
    case 'studio_upload': {
      const id = String(i.upload_id ?? '').trim();
      if (!ID.test(id)) throw new VideoError('Video-Studio: Upload fehlt');
      return { type, upload_id: id, name: String(i.name ?? '').slice(0, 200) };
    }
    default:
      throw new VideoError(`Videoquelle „${type.slice(0, 30)}“ gibt es nicht (${VIDEO_TYPES.join(', ')})`);
  }
}

/** YouTube/Vimeo id out of a link (any common form), or undefined. */
export function embedOf(link: string): VideoSource | undefined {
  const yt = YT.exec(link.trim());
  if (yt) return { type: 'youtube', id: yt[1] };
  const vm = VIMEO.exec(link.trim());
  if (vm) return { type: 'vimeo', id: vm[1], ...(vm[2] ? { hash: vm[2] } : {}) };
  return undefined;
}

export type Playback =
  | { kind: 'none' }
  | { kind: 'file'; src: string; mime?: string }
  | { kind: 'hls'; src: string }
  | { kind: 'embed'; provider: 'youtube' | 'vimeo'; src: string };

const FILE_MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/mp4' };

/**
 * What the player gets. `mediaUrl` is the room's own streaming address (with the viewer's token) for uploads and Video-Studio
 * assets. Embeds come without a start: the room adds `&start=N` (YouTube) or `#t=Ns` (Vimeo) when it knows the viewer's place on
 * the schedule – the player itself is not in our hands, so there is no drift correction for embeds.
 */
export function playbackOf(v: VideoSource, opts: { mediaUrl: string }): Playback {
  switch (v.type) {
    case 'upload':
    case 'studio_clip':
    case 'studio_upload':
      return { kind: 'file', src: opts.mediaUrl, mime: 'video/mp4' };
    case 'url': {
      let path = '';
      try {
        path = new URL(v.url).pathname.toLowerCase();
      } catch {
        return { kind: 'none' };
      }
      if (path.endsWith('.m3u8')) return { kind: 'hls', src: v.url };
      return { kind: 'file', src: v.url, mime: FILE_MIME[path.split('.').pop() ?? ''] };
    }
    case 'youtube':
      // Controls and keyboard off: the room keeps the schedule. A layer over the player blocks clicks.
      return { kind: 'embed', provider: 'youtube', src: `https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&controls=0&disablekb=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3&fs=0` };
    case 'vimeo':
      return { kind: 'embed', provider: 'vimeo', src: `https://player.vimeo.com/video/${v.id}?autoplay=1&dnt=1&title=0&byline=0&portrait=0&playsinline=1${v.hash ? `&h=${v.hash}` : ''}` };
    default:
      return { kind: 'none' };
  }
}

/** The origin an embed needs in the page's CSP (frame-src), or '' when there is none. */
export function embedOrigin(v: VideoSource): string {
  return v.type === 'youtube' ? 'https://www.youtube-nocookie.com' : v.type === 'vimeo' ? 'https://player.vimeo.com' : '';
}

/** First bytes of a video container: MP4/MOV, WebM/Matroska, Ogg, AVI. */
export function looksLikeVideo(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return true;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return true;
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return true;
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'AVI ') return true;
  return ['moov', 'mdat', 'wide', 'free', 'skip'].includes(buf.subarray(4, 8).toString('latin1'));
}

export const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'];
export const extOf = (name: string) => {
  const m = /\.[A-Za-z0-9]{2,5}$/.exec(name);
  return m ? m[0].toLowerCase() : '';
};

/** One byte range of a file as the Range header asks for it (single range only), or null. */
export function parseRange(header: unknown, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2]) || size <= 0) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start >= size) return null;
  return { start, end };
}
