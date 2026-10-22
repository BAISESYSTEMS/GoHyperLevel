/**
 * Pictures are scaled in the browser before they are uploaded: a few widths for `srcset` (phones fetch the small one), WebP where the
 * browser can write it (feature-detected on a canvas), the real width and height for the page (no layout shift while loading).
 * Without a canvas (or for GIFs) the file goes up unchanged. The server adds scaled copies on its own when it has an image engine
 * (server/modules/site-media.ts); a `srcset` written here takes precedence.
 */

/** Widths of the extra copies; the original is capped at MAX_W. */
export const LADDER = [640, 1280, 1920];
export const MAX_W = 2560;
/** Files this small are uploaded as they are (re-encoding would only add loss). */
const KEEP_BELOW = 250 * 1024;

export interface Plan {
  w: number;
  h: number;
  /** The widths to render besides the full size (always smaller than it). */
  widths: number[];
}

/** Sizes to produce for a picture of w × h. */
export function plan(w: number, h: number): Plan {
  const full = Math.min(w, MAX_W);
  const fh = Math.max(1, Math.round((h * full) / w));
  return { w: full, h: fh, widths: LADDER.filter((x) => x < full - 40) };
}

export interface Copy {
  url: string;
  w: number;
}
/** `url 640w, url 1280w` – smallest first; empty when there is only one size. */
export function srcsetOf(copies: Copy[]): string {
  const sorted = [...copies].sort((a, b) => a.w - b.w);
  return sorted.length > 1 ? sorted.map((c) => `${c.url} ${c.w}w`).join(', ') : '';
}

let webp: boolean | undefined;
/** Can this browser's canvas write WebP? */
export function canWriteWebp(): boolean {
  if (webp !== undefined) return webp;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    webp = c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webp = false;
  }
  return webp;
}

const readDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });

export interface Prepared {
  url: string;
  w: number;
  h: number;
  srcset: string;
}

/**
 * Scales and uploads a picture. `upload` stores one file (data URL) and returns its public link.
 * `onStep` reports progress ("2 von 4").
 */
export async function prepareImage(file: File, upload: (name: string, data: string) => Promise<{ url: string }>, onStep?: (done: number, total: number) => void): Promise<Prepared> {
  const plain = async (): Promise<Prepared> => {
    const up = await upload(file.name, await readDataUrl(file));
    return { url: up.url, w: 0, h: 0, srcset: '' };
  };
  // Animated GIFs stay as they are; so does everything when the browser cannot decode or draw it.
  if (file.type === 'image/gif' || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return plain();
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return plain();
  }
  try {
    const p = plan(bmp.width, bmp.height);
    const total = p.widths.length + 1;
    const type = canWriteWebp() ? 'image/webp' : file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const ext = type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : 'jpg';
    const base = file.name.replace(/\.[^.]+$/, '') || 'bild';
    const draw = (w: number) => {
      const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('kein Canvas');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      return c.toDataURL(type, 0.82);
    };
    const copies: Copy[] = [];
    let done = 0;
    for (const w of p.widths) {
      const up = await upload(`${base}-${w}.${ext}`, draw(w));
      copies.push({ url: up.url, w });
      onStep?.(++done, total);
    }
    // The full size: the original file when it is small and not larger than the cap, else a scaled copy.
    const keep = file.size <= KEEP_BELOW && bmp.width <= MAX_W;
    const full = await upload(keep ? file.name : `${base}.${ext}`, keep ? await readDataUrl(file) : draw(p.w));
    copies.push({ url: full.url, w: p.w });
    onStep?.(++done, total);
    return { url: full.url, w: p.w, h: p.h, srcset: srcsetOf(copies) };
  } finally {
    bmp.close?.();
  }
}
