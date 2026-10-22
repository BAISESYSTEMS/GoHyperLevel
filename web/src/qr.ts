/** Helpers for the QR-code button (pure, so they can be tested without a browser). */

/** German labels (message ids of the core catalog), shown through t(). */
export const QR_SIZES: [string, string][] = [
  ['256', 'Klein (256 px)'],
  ['512', 'Mittel (512 px)'],
  ['1024', 'Groß (1024 px)'],
  ['2048', 'Poster (2048 px)'],
];

export interface QrParams {
  format?: 'png' | 'svg';
  size?: number;
  fg?: string;
  ec?: 'L' | 'M' | 'Q' | 'H';
  /** File name (without extension) – turns the answer into a download. */
  download?: string;
}

/** Address of the server-drawn code for a link (`GET /api/qr`). */
export function qrUrl(link: string, p: QrParams = {}): string {
  const q = new URLSearchParams({ url: link, format: p.format ?? 'png', size: String(p.size ?? 512) });
  if (p.fg) q.set('fg', p.fg);
  if (p.ec && p.ec !== 'M') q.set('ec', p.ec);
  if (p.download !== undefined) {
    q.set('download', '1');
    q.set('name', p.download);
  }
  return `/api/qr?${q.toString()}`;
}

/** File name for downloads: "Beratung Erstgespräch" → "qr-Beratung-Erstgespraech". */
export function qrDownloadName(title: string): string {
  const slug = title
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
    .slice(0, 50);
  return slug ? `qr-${slug}` : 'qr-code';
}

/** Contrast ratio of a #rrggbb colour against white (WCAG). Scanners need dark modules on a light ground. */
export function contrastOnWhite(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const c = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (lum + 0.05);
}

/** Dark enough to be scanned reliably (at least 4:1 against the white background). */
export const qrColorOk = (hex: string) => contrastOnWhite(hex) >= 4;

/** Links can be complete (https://…) or a path on this server (/book/…). */
export const qrLinkOk = (link: string) => /^https?:\/\/\S+$/i.test(link.trim()) || (/^\/[^/\s]/.test(link.trim()) && !/\s/.test(link.trim()));
