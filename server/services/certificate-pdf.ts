import type { PdfImage } from './canvas-pdf.js';
import { Page, latin, pdfImageOf, pdfOf, textW } from './creator-pdf.js';

/**
 * The certificate as a PDF (A4 landscape or portrait, no library): frame in the template's colours, logo, title, the
 * recipient, the course, date and number, a signature image with the signer, and the address where anyone can verify it.
 */

export interface CertConfig {
  title: string;
  subtitle: string;
  /** Text under the course name; {{course}}, {{name}}, {{date}} and {{score}} are filled in. */
  body: string;
  color: string;
  accent: string;
  bg: string;
  logo_upload_id: string;
  signature_upload_id: string;
  signer_name: string;
  signer_title: string;
  issuer: string;
  footer: string;
  orientation: 'landscape' | 'portrait';
  show_score: boolean;
  number_prefix: string;
  send_email: boolean;
}

export const DEFAULT_CERT: CertConfig = {
  title: 'Zertifikat',
  subtitle: 'Hiermit wird bestätigt, dass',
  body: 'den Kurs erfolgreich abgeschlossen hat.',
  color: '#1e3a8a',
  accent: '#b45309',
  bg: '#ffffff',
  logo_upload_id: '',
  signature_upload_id: '',
  signer_name: '',
  signer_title: '',
  issuer: '',
  footer: '',
  orientation: 'landscape',
  show_score: false,
  number_prefix: 'ZERT',
  send_email: true,
};

const HEX = /^#[0-9a-f]{6}$/i;
const text = (v: unknown, fallback: string, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);

export function cleanCertConfig(v: any, cur: CertConfig = DEFAULT_CERT): CertConfig {
  const b = v && typeof v === 'object' ? v : {};
  const color = (x: unknown, fallback: string) => (typeof x === 'string' && HEX.test(x) ? x : fallback);
  return {
    title: text(b.title ?? cur.title, cur.title, 60) || cur.title,
    subtitle: text(b.subtitle ?? cur.subtitle, cur.subtitle, 120),
    body: text(b.body ?? cur.body, cur.body, 300),
    color: color(b.color, cur.color),
    accent: color(b.accent, cur.accent),
    bg: color(b.bg, cur.bg),
    logo_upload_id: text(b.logo_upload_id ?? cur.logo_upload_id, '', 40),
    signature_upload_id: text(b.signature_upload_id ?? cur.signature_upload_id, '', 40),
    signer_name: text(b.signer_name ?? cur.signer_name, '', 80),
    signer_title: text(b.signer_title ?? cur.signer_title, '', 80),
    issuer: text(b.issuer ?? cur.issuer, '', 120),
    footer: text(b.footer ?? cur.footer, '', 200),
    orientation: (b.orientation ?? cur.orientation) === 'portrait' ? 'portrait' : 'landscape',
    show_score: b.show_score === undefined ? cur.show_score : !!b.show_score,
    number_prefix: text(b.number_prefix ?? cur.number_prefix, 'ZERT', 12).replace(/[^A-Za-z0-9-]/g, '') || 'ZERT',
    send_email: b.send_email === undefined ? cur.send_email : !!b.send_email,
  };
}

export interface CertInput {
  cfg: CertConfig;
  name: string;
  course: string;
  /** Already formatted, e.g. 04.10.2026. */
  date: string;
  number: string;
  verifyUrl: string;
  score?: number | null;
  logo?: Buffer | null;
  signature?: Buffer | null;
}

/** The text of the body line with its placeholders filled in. */
export const fillBody = (body: string, o: { course: string; name: string; date: string; score?: number | null }) =>
  body.replace(/\{\{\s*(course|name|date|score)\s*\}\}/g, (_m, k: string) => (k === 'course' ? o.course : k === 'name' ? o.name : k === 'date' ? o.date : o.score === null || o.score === undefined ? '' : `${o.score} %`));

/** Shrinks the font until the line fits `max` pixels. */
const fit = (s: string, size: number, max: number, bold = false, font: 'sans' | 'serif' = 'serif') => {
  let n = size;
  while (n > 12 && textW(s, n, bold, font) > max) n -= 1;
  return n;
};

export function certificatePdf(i: CertInput): Buffer {
  const c = i.cfg;
  const land = c.orientation !== 'portrait';
  const W = land ? 1123 : 794;
  const H = land ? 794 : 1123;
  const p = new Page(W, H);
  const images = new Map<string, PdfImage>();
  const place = (key: string, buf: Buffer | null | undefined, x: number, y: number, w: number, h: number) => {
    const img = buf ? pdfImageOf(buf) : null;
    if (!img) return false;
    images.set(key, img);
    p.image(x, y, w, h, key, 'contain');
    return true;
  };

  p.rect(0, 0, W, H, { fill: c.bg });
  p.rect(26, 26, W - 52, H - 52, { stroke: c.color, sw: 5 });
  p.rect(40, 40, W - 80, H - 80, { stroke: c.accent, sw: 1.5 });
  const cx = W / 2;
  let y = land ? 74 : 96;
  if (place('logo', i.logo, cx - 130, y, 260, land ? 76 : 90)) y += land ? 92 : 108;
  else y += 10;

  p.text(cx, y, latin(c.title.toUpperCase()), land ? 50 : 46, { anchor: 'middle', bold: true, color: c.color, font: 'serif' });
  y += land ? 76 : 80;
  if (c.subtitle) {
    p.text(cx, y, latin(c.subtitle), 19, { anchor: 'middle', color: '#475569', font: 'serif', italic: true });
    y += land ? 48 : 54;
  }
  const name = latin(i.name);
  const ns = fit(name, land ? 46 : 42, W - 220, true);
  p.text(cx, y, name, ns, { anchor: 'middle', bold: true, font: 'serif', color: '#0f172a' });
  y += ns * 1.25 + 8;
  const lw = Math.min(W - 260, Math.max(240, textW(name, ns, true, 'serif') + 40));
  p.line(cx - lw / 2, y, cx + lw / 2, y, { stroke: c.accent, sw: 1.5 });
  y += land ? 30 : 38;

  const tail = latin(fillBody(c.body, { course: i.course, name: i.name, date: i.date, score: i.score }));
  const course = latin(i.course);
  // the line above the course, the course itself, the rest
  const cs = fit(course, land ? 30 : 28, W - 200, true);
  if (c.body && !/\{\{\s*course\s*\}\}/.test(c.body)) {
    p.text(cx, y, course, cs, { anchor: 'middle', bold: true, color: c.color, font: 'serif' });
    y += cs * 1.4 + 10;
  }
  if (tail) y += p.para(cx - (W - 240) / 2, y, tail, W - 240, 18, { anchor: 'middle', font: 'serif', color: '#334155', gap: 10 });
  if (c.show_score && i.score !== null && i.score !== undefined && !/\{\{\s*score\s*\}\}/.test(c.body)) {
    p.text(cx, y, latin(`Ergebnis: ${i.score} %`), 15, { anchor: 'middle', color: '#475569', font: 'serif' });
  }

  // bottom row: signature left, date and number right
  const base = H - (land ? 132 : 168);
  const sx = land ? 110 : 90;
  place('signature', i.signature, sx, base - 76, 220, 66);
  p.line(sx, base, sx + 240, base, { stroke: '#64748b', sw: 1 });
  if (c.signer_name) p.text(sx, base + 6, latin(c.signer_name), 14, { bold: true, font: 'serif' });
  if (c.signer_title || c.issuer) p.text(sx, base + 26, latin([c.signer_title, c.issuer].filter(Boolean).join(' · ').slice(0, 60)), 11.5, { color: '#475569', font: 'serif' });
  const rx = W - (land ? 110 : 90);
  p.text(rx, base - 18, latin(`Ausgestellt am ${i.date}`), 14, { anchor: 'end', font: 'serif' });
  p.text(rx, base + 6, latin(`Zertifikat-Nr. ${i.number}`), 12, { anchor: 'end', color: '#475569' });
  p.text(rx, base + 24, latin(`Echtheit prüfen: ${i.verifyUrl}`.slice(0, 90)), 9.5, { anchor: 'end', color: '#64748b' });
  if (c.footer) p.text(cx, H - 78, latin(c.footer), 10, { anchor: 'middle', color: '#94a3b8' });
  return pdfOf([p], { images, title: latin(`${c.title} ${i.name}`) });
}
