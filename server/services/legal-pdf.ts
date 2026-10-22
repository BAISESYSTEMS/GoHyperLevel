import { A4, Page, latin, pdfOf } from './creator-pdf.js';
import type { LegalDoc } from './legal-texts.js';

/** A legal draft as an A4 PDF (headings, paragraphs, list items), as many pages as needed. Same fonts as the other PDFs (Western European text). */
export function docPdf(doc: LegalDoc, o: { notice?: boolean } = {}): Buffer {
  const L = 60;
  const R = A4.w - 60;
  const W = R - L;
  const pages: Page[] = [];
  let page = new Page();
  let y = 0;
  const fresh = () => {
    page = new Page();
    pages.push(page);
    page.rect(0, 0, A4.w, 8, { fill: '#1e3a8a' });
    y = 52;
  };
  const height = (t: string, w: number, size: number) => {
    const perLine = Math.max(12, Math.floor(w / (size * 0.52)));
    let n = 0;
    for (const part of t.split('\n')) n += Math.max(1, Math.ceil(part.length / perLine));
    return n * size * 1.4;
  };
  const para = (raw: string, size: number, opt: { bold?: boolean; color?: string; indent?: number; gap?: number } = {}) => {
    const t = latin(raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1'));
    const x = L + (opt.indent ?? 0);
    const w = W - (opt.indent ?? 0);
    const h = height(t, w, size);
    if (y + h > A4.h - 60) fresh();
    y += page.para(x, y, t, w, size, { bold: opt.bold, color: opt.color });
    y += opt.gap ?? 0;
  };
  fresh();
  if (o.notice !== false) {
    const h = height(latin(doc.notice), W - 24, 9.5) + 18;
    page.rect(L, y, W, h, { fill: '#fef3c7' });
    page.para(L + 12, y + 9, latin(doc.notice), W - 24, 9.5, { bold: true, color: '#92400e' });
    y += h + 16;
  }
  page.text(L, y, latin(doc.title), 19, { bold: true, color: '#1e3a8a' });
  y += 30;
  if (doc.subtitle) para(doc.subtitle, 10.5, { color: '#64748b', gap: 12 });
  for (const s of doc.sections) {
    if (y + 60 > A4.h - 60) fresh();
    y += 6;
    para(s.heading, 13, { bold: true, gap: 4 });
    for (const block of s.body.split(/\n{2,}/)) {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*- /.test(l))) for (const l of lines) para(`•  ${l.replace(/^\s*- /, '')}`, 10.5, { indent: 12, gap: 2 });
      else para(block, 10.5, { gap: 6 });
    }
  }
  return pdfOf(pages, { title: doc.title });
}
