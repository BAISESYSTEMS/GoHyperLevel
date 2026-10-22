import type { Capability } from './types.js';

/**
 * File checks for generated media: the type is decided from the bytes (never trusted from a URL
 * or header), so a provider – or anyone answering in its place – can't slip HTML, SVG or scripts
 * into the media library.
 */

export const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/webm': '.weba',
};

/** MIME type from the first bytes, or '' when it is not an allowed media file. `hint` decides WebM/MP4 audio vs. video. */
export function sniff(buf: Buffer, hint = ''): string {
  if (buf.length < 4) return '';
  const s = (a: number, b: number) => buf.subarray(a, b).toString('latin1');
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (buf.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 12 && s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (/^M4A|^M4B|^F4A/.test(brand) || (hint.startsWith('audio') && !/^qt/.test(brand))) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return hint.startsWith('audio') ? 'audio/webm' : 'video/webm';
  if (s(0, 3) === 'ID3') return 'audio/mpeg';
  if (s(0, 4) === 'OggS') return 'audio/ogg';
  if (s(0, 4) === 'fLaC') return 'audio/flac';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return '';
}

export const kindOf = (mime: string): 'image' | 'video' | 'audio' | '' => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : '');

/** Which file kinds count as a result of a capability. */
export function accepts(cap: Capability, mime: string): boolean {
  const k = kindOf(mime);
  if (cap === 'image') return k === 'image';
  if (cap === 'video') return k === 'video';
  if (cap === 'audio_tts' || cap === 'audio_music') return k === 'audio' || mime === 'video/mp4';
  return false;
}

const MB = 1024 * 1024;
const envMb = (name: string, def: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n * MB : def * MB;
};
/** Largest result we keep per capability (env PGHL_GENMEDIA_MAX_<KIND>_MB). */
export function maxBytesFor(cap: Capability): number {
  if (cap === 'video') return envMb('PGHL_GENMEDIA_MAX_VIDEO_MB', 200);
  if (cap === 'image') return envMb('PGHL_GENMEDIA_MAX_IMAGE_MB', 30);
  return envMb('PGHL_GENMEDIA_MAX_AUDIO_MB', 60);
}
export const MAX_INPUT_BYTES = 25 * MB;

/** Raw 16-bit PCM (Gemini TTS) → a playable WAV file. */
export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];

/** `16:9` → {w:16,h:9}; invalid → null. */
export function ratio(a?: string): { w: number; h: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(a ?? ''));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}
export const orientation = (a?: string): 'square' | 'landscape' | 'portrait' => {
  const r = ratio(a);
  if (!r || r.w === r.h) return 'square';
  return r.w > r.h ? 'landscape' : 'portrait';
};

/** `bytes=0-99` → inclusive range within `size`, or null (whole file). */
export function parseRange(header: unknown, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  if (start < 0) start = 0;
  if (end >= size) end = size - 1;
  if (start > end) return null;
  return { start, end };
}
