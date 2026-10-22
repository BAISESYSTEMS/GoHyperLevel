import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { brotliCompress, brotliCompressSync, constants, createGzip, gzip, gzipSync } from 'node:zlib';

/**
 * Response compression shared by the static files and the JSON/HTML answers of the API:
 * content negotiation (Accept-Encoding with q-values), which types are worth compressing, and
 * brotli/gzip with settings for dynamic content (fast) – precompressed build files use the maximum.
 */

export type Encoding = 'br' | 'gzip';

/** Bodies below this size are sent as they are (the headers would eat the saving). */
export const MIN_COMPRESS_BYTES = 1024;
/** Up to this size compression runs inline (≈1–2 ms); bigger bodies go to the libuv thread pool. */
const INLINE_MAX = 256 * 1024;

/** The best encoding the client accepts – brotli before gzip – honouring `q=0` and `*`. */
export function pickEncoding(header: string | string[] | undefined, offer: readonly Encoding[] = ['br', 'gzip']): Encoding | null {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  if (!raw) return null;
  const q = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let v = 1;
    for (const p of params) {
      const m = p.trim().match(/^q=([0-9.]+)$/);
      if (m) v = Number(m[1]);
    }
    q.set(name.trim(), Number.isFinite(v) ? v : 0);
  }
  let best: Encoding | null = null;
  let bestQ = 0;
  for (const enc of offer) {
    const v = q.get(enc) ?? q.get('*') ?? 0;
    if (v > bestQ) {
      best = enc;
      bestQ = v;
    }
  }
  return best;
}

/** Text-like types gain from compression; images, video, fonts (woff2), archives are compressed already. */
export function isCompressible(contentType: string): boolean {
  const t = contentType.split(';')[0].trim().toLowerCase();
  if (!t || t === 'text/event-stream') return false;
  if (t.startsWith('text/')) return true;
  if (t === 'image/svg+xml' || t === 'image/x-icon' || t === 'application/wasm') return true;
  return /^application\/(json|javascript|x-javascript|xml|manifest\+json|[\w.+-]+\+(json|xml))$/.test(t);
}

const brOptions = (size: number, quality: number) => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: size } });

/** Dynamic content: brotli quality 4 / gzip level 6 – a few hundred microseconds for typical API answers. */
export function compressBuffer(body: Buffer, enc: Encoding): Promise<Buffer> {
  if (body.length <= INLINE_MAX) {
    try {
      return Promise.resolve(enc === 'br' ? brotliCompressSync(body, brOptions(body.length, 4)) : gzipSync(body, { level: 6 }));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (enc === 'br') brotliCompress(body, brOptions(body.length, 4), done);
    else gzip(body, { level: 6 }, done);
  });
}

/** Header names are case-insensitive; modules write them in lower case, but be safe. */
export function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return String(headers[k]);
  return undefined;
}

/** Adds Accept-Encoding to an existing Vary header (keeps what a module set). */
export function varyAcceptEncoding(current: string | undefined): string {
  if (!current) return 'Accept-Encoding';
  return /(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(current) ? current : `${current}, Accept-Encoding`;
}

/**
 * A streamed text answer (CSV export…) gzipped on the way out when the client accepts it. Brotli is left out
 * on purpose: its streaming mode at useful ratios is slow, and gzip already shrinks CSV/JSON about 5x.
 */
export function gzipStream(req: IncomingMessage | undefined, headers: Record<string, string>, body: Readable): { headers: Record<string, string>; body: Readable } {
  if (!req || pickEncoding(req.headers['accept-encoding'], ['gzip']) !== 'gzip' || !isCompressible(headerValue(headers, 'content-type') ?? '')) return { headers, body };
  const gz = createGzip({ level: 6 });
  body.on('error', (e) => gz.destroy(e));
  gz.on('close', () => body.destroy());
  return { headers: { ...headers, 'content-encoding': 'gzip', vary: varyAcceptEncoding(headerValue(headers, 'vary')) }, body: body.pipe(gz) };
}
