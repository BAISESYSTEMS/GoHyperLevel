/**
 * Image helpers for the site builder: the size of an upload from its file header (so every <img> carries width/height and cannot shift
 * the layout), the width ladder for `srcset`, and the shape of the optional image engine that scales and re-encodes pictures
 * (modules/site-media.ts). No dependencies: PNG, JPEG (with the EXIF turn), GIF and WebP headers are read by hand.
 */

export interface Dims {
  w: number;
  h: number;
}

/** Scales and re-encodes a picture. `sharp` fits this shape; tests bring a fake one (`app.services.imageEngine`). */
export interface ImageEngine {
  name: string;
  /** Modern formats the engine can write besides the original's own. */
  formats: ('webp' | 'avif')[];
  resize(input: Buffer, o: { width: number; format: 'webp' | 'avif' | 'jpeg' | 'png' }): Promise<Buffer>;
}

/** The widths `/uploads-opt/<w>/<file>` serves (a fixed ladder: the route cannot be asked to render arbitrary sizes). */
export const OPT_WIDTHS = [320, 640, 960, 1280, 1920] as const;

/** Largest picture that is worth reading headers of; the header sits in the first bytes except for JPEGs with big EXIF thumbnails. */
export const HEADER_BYTES = 512 * 1024;

const sane = (w: number, h: number): Dims | undefined => (w > 0 && h > 0 && w <= 65535 && h <= 65535 ? { w, h } : undefined);

/** EXIF orientation 5–8 turns the picture a quarter: the browser shows it with width and height swapped. */
function exifTurned(b: Buffer, at: number, len: number): boolean {
  // at = start of the APP1 payload ("Exif\0\0" + TIFF header)
  if (len < 14 || b.toString('latin1', at, at + 4) !== 'Exif') return false;
  const t = at + 6;
  const le = b.toString('latin1', t, t + 2) === 'II';
  if (!le && b.toString('latin1', t, t + 2) !== 'MM') return false;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  try {
    const ifd = t + u32(t + 4);
    const n = u16(ifd);
    for (let i = 0; i < Math.min(n, 64); i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > b.length) break;
      if (u16(e) === 0x0112) return u16(e + 8) >= 5 && u16(e + 8) <= 8;
    }
  } catch {
    /* a damaged header just means "not turned" */
  }
  return false;
}

/** Width and height of a PNG, JPEG, GIF or WebP from its first bytes; undefined when the header is not recognised. */
export function imageSize(b: Buffer): Dims | undefined {
  if (b.length < 24) return undefined;
  // PNG: IHDR right after the signature
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return sane(b.readUInt32BE(16), b.readUInt32BE(20));
  // GIF: logical screen descriptor
  if (b.toString('latin1', 0, 4) === 'GIF8') return sane(b.readUInt16LE(6), b.readUInt16LE(8));
  // WebP: lossy (VP8 ), lossless (VP8L) or extended (VP8X)
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ' && b.length >= 30) return sane(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (kind === 'VP8L' && b.length >= 25) {
      const v = b.readUInt32LE(21);
      return sane((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (kind === 'VP8X' && b.length >= 30) return sane(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return undefined;
  }
  // JPEG: walk the segments up to the first start-of-frame
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    let turned = false;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m === 0xd9 || m === 0xda) return undefined;
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      if (m === 0xe1) turned = exifTurned(b, i + 4, len - 2) || turned;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 9 > b.length) return undefined;
        const h = b.readUInt16BE(i + 5);
        const w = b.readUInt16BE(i + 7);
        return turned ? sane(h, w) : sane(w, h);
      }
      i += 2 + len;
    }
  }
  return undefined;
}

/** The stored file name of an upload from a link to it (`<origin>/uploads/<file>` or `/uploads/<file>`); undefined for anything else. */
export function uploadFileOf(src: string): string | undefined {
  const m = String(src ?? '').match(/^(?:https?:\/\/[^/?#]+)?\/uploads\/([A-Za-z0-9_-]{8,64}\.(?:png|jpe?g|webp|gif))(?:[?#].*)?$/);
  return m ? m[1] : undefined;
}

/** Widths of the optimised copies for a picture of this width (smaller than the original; none for small pictures). */
export function widthsFor(w: number): number[] {
  return OPT_WIDTHS.filter((x) => x < w - 40);
}

/**
 * `srcset` of an upload: the scaled copies from `/uploads-opt` plus the original at its own width. Undefined when the picture is too
 * small to need one or the link is not an upload.
 */
export function srcsetFor(src: string, dims: Dims | undefined): string | undefined {
  const file = uploadFileOf(src);
  // animated GIFs stay as they are
  if (!file || !dims || /\.gif$/i.test(file)) return undefined;
  const widths = widthsFor(dims.w);
  if (!widths.length) return undefined;
  const origin = src.slice(0, src.indexOf('/uploads/'));
  return [...widths.map((x) => `${origin}/uploads-opt/${x}/${file} ${x}w`), `${origin}/uploads/${file} ${dims.w}w`].join(', ');
}

/** Output format for a request: AVIF or WebP when the browser accepts it and the engine writes it, else the original's own format. */
export function pickFormat(accept: string, engine: Pick<ImageEngine, 'formats'>, mime: string): 'avif' | 'webp' | 'jpeg' | 'png' {
  if (engine.formats.includes('avif') && /image\/avif/i.test(accept)) return 'avif';
  if (engine.formats.includes('webp') && /image\/webp/i.test(accept)) return 'webp';
  return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpeg';
}

export const FORMAT_MIME = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' } as const;
export const FORMAT_EXT = { avif: 'avif', webp: 'webp', jpeg: 'jpg', png: 'png' } as const;
