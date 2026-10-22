import QRCode from 'qrcode';
import type { Module } from '../core/app.js';
import { bad, type RawResult } from '../core/http.js';

/**
 * QR codes for share links (booking pages, review links, buy links, funnel pages, trigger links): the app shows a small
 * "QR-Code" button next to each link; this route draws the code as PNG or SVG, optionally as a download.
 *
 *   GET /api/qr?url=<https link or /path>&format=png|svg&size=120..2048&fg=%23111827&bg=%23ffffff&ec=L|M|Q|H&margin=0..8&download=1&name=<file name>
 *
 * Needs a signed-in user only (nothing of the sub-account is read: the link is encoded as given). Only http(s) links are
 * encoded, so the route cannot be used for anything else; a path such as /book/beratung is completed with the base URL.
 */

export const QR_MAX_URL = 2000;
const HEX = /^#[0-9a-f]{6}$/i;
const LEVELS = ['L', 'M', 'Q', 'H'] as const;

export interface QrOptions {
  format: 'png' | 'svg';
  size: number;
  margin: number;
  ec: (typeof LEVELS)[number];
  fg: string;
  bg: string;
}

const intParam = (v: string | null, min: number, max: number, def: number, what: string) => {
  if (v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${what}: ganze Zahl von ${min} bis ${max}`);
  return n;
};

/** Reads and checks the options of a request. Throws German 400 errors. */
export function qrOptions(q: URLSearchParams): QrOptions {
  const format = (q.get('format') ?? 'png').toLowerCase();
  if (format !== 'png' && format !== 'svg') throw bad('Format: png oder svg');
  const ec = (q.get('ec') ?? 'M').toUpperCase();
  if (!LEVELS.includes(ec as any)) throw bad('Fehlerkorrektur: L, M, Q oder H');
  const fg = q.get('fg') ?? '#111827';
  const bg = q.get('bg') ?? '#ffffff';
  if (!HEX.test(fg) || !HEX.test(bg)) throw bad('Farben als #rrggbb angeben');
  return { format, size: intParam(q.get('size'), 120, 2048, 512, 'Größe'), margin: intParam(q.get('margin'), 0, 8, 2, 'Rand'), ec: ec as QrOptions['ec'], fg: fg.toLowerCase(), bg: bg.toLowerCase() };
}

/** The text to encode: an http(s) link, or a path on this server. */
export function qrTarget(raw: string | null, baseUrl: string): string {
  const v = (raw ?? '').trim();
  if (!v) throw bad('Link fehlt');
  if (v.length > QR_MAX_URL) throw bad(`Link ist zu lang (höchstens ${QR_MAX_URL} Zeichen)`);
  const full = v.startsWith('/') && !v.startsWith('//') ? `${baseUrl.replace(/\/$/, '')}${v}` : v;
  if (!/^https?:\/\/[^\s]+$/i.test(full)) throw bad('Nur Links mit http:// oder https:// werden zum QR-Code');
  return full;
}

/** A safe file name (letters, digits, dash, underscore) from any title. */
export function qrFileName(name: string | null | undefined): string {
  const base = String(name ?? '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe')
    .replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'qr-code';
}

export async function renderQr(text: string, o: QrOptions): Promise<Buffer | string> {
  const common = { margin: o.margin, errorCorrectionLevel: o.ec, color: { dark: o.fg, light: o.bg } };
  if (o.format === 'svg') return QRCode.toString(text, { ...common, type: 'svg', width: o.size });
  return QRCode.toBuffer(text, { ...common, type: 'png', width: o.size });
}

export const qrModule: Module = {
  name: 'qr',
  register(app) {
    app.router.get('/api/qr', 'user', async (ctx): Promise<RawResult> => {
      const text = qrTarget(ctx.query.get('url'), app.baseUrl());
      const o = qrOptions(ctx.query);
      let body: Buffer | string;
      try {
        body = await renderQr(text, o);
      } catch {
        // Far too much data for a QR code at this error correction level.
        throw bad('Der Link ist für einen QR-Code zu lang – bitte kürzen oder die Fehlerkorrektur senken');
      }
      const headers: Record<string, string> = {
        'content-type': o.format === 'svg' ? 'image/svg+xml; charset=utf-8' : 'image/png',
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      };
      if (ctx.query.get('download')) headers['content-disposition'] = `attachment; filename="${qrFileName(ctx.query.get('name'))}.${o.format}"`;
      return { __raw: true, status: 200, headers, body };
    });
  },
};
