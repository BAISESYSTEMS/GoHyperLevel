import type { PdfImage } from './canvas-pdf.js';
import { layoutText } from './canvas-text.js';
import { A4, Page, fitLine, latin, pdfImageOf, pdfOf, sizeToFit, textW } from './creator-pdf.js';
import type { DocSnapshot } from './einvoice-model.js';
import { girocodeFor, qrMatrix, qrRuns } from './giro-code.js';
import { INV_TYPES, UNITS, deAmount, deYmd, deductionYmd, docTitle, lineNet, paymentTermsText } from './invoice-model.js';

/**
 * The invoice as a PDF (A4, server side, no library): letterhead, recipient in the window of DIN 5008 form B,
 * information block, positions over several pages, VAT breakdown, tax notes, payment terms, bank details and the
 * GiroCode (EPC069-12) for a SEPA transfer. Base fonts only (WinAnsi); the output is deterministic – the same document
 * gives the same bytes, so a mailed PDF can be archived and compared later.
 */

export interface PdfOptions {
  logo?: Buffer | null;
  /** Draft: no number yet, a watermark says so. */
  draft?: boolean;
  /** Live status stamped next to the title (not part of the frozen document), e.g. "Bezahlt am 20.10.2026". */
  status?: { text: string; color: string } | null;
  /** The customer link, printed under the payment details. */
  url?: string;
  /** Amount still open (for the GiroCode); defaults to the payable amount of the document. */
  open_cents?: number;
}

const mm = (v: number) => v * 3.7795;
const W = A4.w;
const H = A4.h;
const L = mm(25);
const R = W - mm(20);
const CW = R - L;
const BOTTOM = H - 118;
const INK = '#0f172a';
const MUTED = '#64748b';
const ACCENT = '#1e3a8a';

const t = (s: unknown) => latin(String(s ?? '')).replace(/−/g, '-').replace(/[  ]/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export function invoicePdf(d: DocSnapshot, o: PdfOptions = {}): Buffer {
  const { pages, images, title } = invoicePages(d, o);
  return pdfOf(pages, { images, title });
}

/** The laid-out pages (what `invoicePdf` writes) – tests check them for text off the page or on top of other text. */
export function invoicePages(d: DocSnapshot, o: PdfOptions = {}): { pages: Page[]; images: Map<string, PdfImage>; title: string } {
  const pages: Page[] = [];
  const images = new Map<string, PdfImage>();
  const cur = d.currency === 'EUR' ? '€' : d.currency;
  const money = (c: number) => t(`${deAmount(c)} ${cur}`);
  const credit = d.kind === 'credit_note';
  const quote = d.kind === 'estimate';
  const title = docTitle({ kind: d.kind, inv_type: d.inv_type, credit_type: d.credit_type });
  const s = d.seller;
  const b = d.buyer;
  const draft = !!o.draft || !d.number;
  const label = draft ? `${title} (Entwurf)` : `${title} ${d.number}`;

  let p = new Page();
  pages.push(p);

  // --- letterhead -------------------------------------------------------------------------------------------------------
  // Long names never run into each other or off the page: the name on the left takes at most a little over half the width
  // (two lines, smaller), the sender block on the right the rest.
  const logo = o.logo ? pdfImageOf(o.logo) : null;
  let leftW = 200;
  if (logo) {
    images.set('logo', logo);
    p.image(L, 38, 200, 72, 'logo', 'contain');
  } else {
    const max = CW * 0.55;
    let size = 20;
    while (size > 14 && layoutText(t(s.name), size, { maxWidth: max, bold: true, lineHeight: 1.25 }).lines.length > 1) size -= 1;
    const lay = layoutText(t(s.name), size, { maxWidth: max, bold: true, lineHeight: 1.25, maxLines: 2 });
    lay.lines.forEach((line, i) => p.text(L, 44 + i * lay.lineHeight, line, size, { bold: true, color: ACCENT }));
    leftW = lay.width;
  }
  const head = [s.name, s.street, [s.postal_code, s.city].filter(Boolean).join(' '), s.phone ? `Tel. ${s.phone}` : '', s.email].filter(Boolean);
  head.forEach((line, i) => {
    const f = fitLine(t(line), i === 0 ? 12 : 11, CW - leftW - 24, { bold: i === 0, min: 8 });
    p.text(R, 40 + i * 15, f.text, f.size, { anchor: 'end', color: i === 0 ? INK : MUTED, bold: i === 0 });
  });

  // --- address window (DIN 5008 form B: 20 mm from the left, 45 mm from the top, 85 × 45 mm) ----------------------------
  const WIN = mm(85) - 4;
  const ret = fitLine(t([s.name, s.street, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(' · ')), 8.5, WIN, { min: 7 });
  p.text(mm(20), mm(46), ret.text, ret.size, { color: MUTED });
  p.line(mm(20), mm(50), mm(20) + Math.min(mm(85), textW(ret.text, ret.size) + 4), mm(50), { stroke: '#cbd5e1', sw: 0.6 });
  const addr = [b.company, b.name && b.name !== b.company ? b.name : '', b.street, [b.postal_code, b.city].filter(Boolean).join(' '), b.country && b.country.toUpperCase() !== 'DE' && b.country.toLowerCase() !== 'deutschland' ? b.country : ''].filter((x) => x && String(x).trim());
  // Each line stays inside the window: smaller first, then wrapped (a name is never cut short on an invoice).
  let ay = mm(51.5);
  const asize = Math.min(14.5, ...addr.map((line, i) => sizeToFit(t(line), 14.5, WIN, { bold: i === 0 && !!b.company, min: 11 }) || 11));
  addr.forEach((line, i) => {
    const bold = i === 0 && !!b.company;
    if (sizeToFit(t(line), asize, WIN, { bold, min: asize })) {
      p.text(mm(20), ay, t(line), asize, { bold });
      ay += asize === 14.5 ? 18 : Math.round(asize * 1.4);
    } else ay += p.para(mm(20), ay, t(line), WIN, asize, { bold, maxLines: 3 }) + 2;
  });

  // --- information block --------------------------------------------------------------------------------------------------
  const ix = mm(125);
  const rows: [string, string][] = [];
  rows.push([`${credit ? 'Beleg' : quote ? 'Angebot' : 'Rechnung'}-Nr.`, draft ? 'Entwurf' : d.number]);
  rows.push(['Datum', deYmd(d.issued_ymd)]);
  if (!quote) rows.push(['Leistungsdatum', d.supply_to ? `${deYmd(d.supply_from)} – ${deYmd(d.supply_to)}` : d.supply_auto ? 'wie Rechnungsdatum' : deYmd(d.supply_from)]);
  if (d.ref) rows.push(['Bezug', `${d.ref.number} vom ${deYmd(d.ref.issued_ymd)}`]);
  if (d.due_ymd && !credit) rows.push([quote ? 'Gültig bis' : 'Fällig am', deYmd(d.due_ymd)]);
  if (b.vat_id) rows.push(['USt-IdNr. Kunde', b.vat_id]);
  if (b.leitweg_id) rows.push(['Leitweg-ID', b.leitweg_id]);
  if (b.buyer_ref) rows.push(['Ihre Referenz', b.buyer_ref]);
  if (s.contact_name) rows.push(['Ansprechpartner', s.contact_name]);
  // A value too long for its row (a reference, a contact name) gets smaller, or moves to its own line under the label.
  let iy = mm(51.5);
  rows.forEach(([k, v], i) => {
    p.text(ix, iy, t(k), 11.5, { color: MUTED });
    const size = sizeToFit(t(v), 12.5, R - ix - textW(t(k), 11.5) - 12, { bold: i === 0, min: 10 });
    if (size) p.text(R, iy, t(v), size, { anchor: 'end', bold: i === 0 });
    else iy += p.para(ix, iy + 16, t(v), R - ix, 11, { anchor: 'end', bold: i === 0, maxLines: 2 }) - 2;
    iy += 18;
  });
  if (o.status) p.text(R, iy + 4, t(o.status.text), 12.5, { anchor: 'end', bold: true, color: o.status.color });
  const infoBottom = iy + (o.status ? 18 : 0);

  // fold and punch marks
  p.line(0, mm(105), mm(5), mm(105), { stroke: '#94a3b8', sw: 0.75 });
  p.line(0, mm(148.5), mm(8), mm(148.5), { stroke: '#94a3b8', sw: 0.75 });
  p.line(0, mm(210), mm(5), mm(210), { stroke: '#94a3b8', sw: 0.75 });

  // --- subject --------------------------------------------------------------------------------------------------------------
  let y = Math.max(Math.max(ay, infoBottom) + 24, mm(98));
  p.text(L, y, t(label), 20, { bold: true });
  y += 30;
  if (d.ref && credit) {
    const what = d.credit_type === 'storno' ? `Storno der Rechnung ${d.ref.number} vom ${deYmd(d.ref.issued_ymd)}` : `Korrektur zur Rechnung ${d.ref.number} vom ${deYmd(d.ref.issued_ymd)}`;
    p.text(L, y, t(what), 13, { color: '#475569' });
    y += 22;
  }
  if (d.title) y += p.para(L, y, t(d.title), CW, 14.5, { bold: true, gap: 6 });
  if (d.inv_type !== 'standard' && !credit && !quote) {
    y += p.para(L, y, t(d.inv_type === 'partial' ? 'Wir stellen Ihnen folgende Abschlagszahlung in Rechnung.' : 'Schlussrechnung – bereits gestellte Abschlagsrechnungen sind unten abgezogen.'), CW, 13, { color: '#475569', gap: 6 });
  }
  y += 8;

  // --- table ------------------------------------------------------------------------------------------------------------------
  const X = { pos: L + 6, desc: L + 34, qty: L + 382, price: L + 470, vat: L + 522, total: R - 4 };
  const DESC_W = 270;
  const tableHead = () => {
    p.rect(L, y, CW, 25, { fill: '#f1f5f9' });
    p.text(X.pos, y + 6, 'Pos.', 11.5, { bold: true, color: '#334155' });
    p.text(X.desc, y + 6, 'Bezeichnung', 11.5, { bold: true, color: '#334155' });
    p.text(X.qty, y + 6, 'Menge', 11.5, { bold: true, color: '#334155', anchor: 'end' });
    p.text(X.price, y + 6, 'Einzelpreis', 11.5, { bold: true, color: '#334155', anchor: 'end' });
    p.text(X.vat, y + 6, 'USt.', 11.5, { bold: true, color: '#334155', anchor: 'end' });
    p.text(X.total, y + 6, 'Gesamt', 11.5, { bold: true, color: '#334155', anchor: 'end' });
    y += 31;
  };
  const nextPage = () => {
    p = new Page();
    pages.push(p);
    p.text(L, 46, t(s.name), 12, { bold: true, color: ACCENT });
    p.text(R, 46, t(label), 12, { anchor: 'end', bold: true });
    y = 86;
  };
  tableHead();
  d.items.forEach((it, i) => {
    const unit = UNITS[it.unit ?? 'C62'] ?? '';
    const nameH = measure(t(it.name), 13.5, DESC_W, true);
    const descH = it.description ? measure(t(it.description), 11.5, DESC_W) : 0;
    const h = nameH + (descH ? descH + 2 : 0) + 12;
    if (y + h > BOTTOM) {
      nextPage();
      tableHead();
    }
    const y0 = y;
    p.text(X.pos, y0 + 2, String(i + 1), 12.5, { color: MUTED });
    const nh = p.para(X.desc, y0 + 2, t(it.name), DESC_W, 13.5, { bold: true });
    if (it.description) p.para(X.desc, y0 + 2 + nh + 2, t(it.description), DESC_W, 11.5, { color: MUTED });
    // the line amount of the invoice maths (integer, half away from zero) – floating point printed 1,15 × 29,90 as 34,38
    const net = lineNet(it);
    p.text(X.qty, y0 + 2, t(`${String(Math.round(it.qty * 10000) / 10000).replace('.', ',')}${unit ? ` ${unit}` : ''}`), 12.5, { anchor: 'end' });
    p.text(X.price, y0 + 2, money(it.price_cents), 12.5, { anchor: 'end' });
    p.text(X.vat, y0 + 2, d.tax_mode === 'standard' ? t(`${String(it.tax_rate).replace('.', ',')} %`) : '–', 12.5, { anchor: 'end', color: MUTED });
    p.text(X.total, y0 + 2, money(net), 12.5, { anchor: 'end', bold: true });
    y = y0 + h;
    p.line(L, y - 5, R, y - 5, { stroke: '#e2e8f0', sw: 0.8 });
  });
  y += 8;

  // --- totals -------------------------------------------------------------------------------------------------------------------
  const tot = d.totals;
  const taxRows = d.tax_mode === 'standard' ? tot.groups.filter((g) => g.rate > 0 || g.tax_cents !== 0) : [];
  const needed = 26 + taxRows.length * 20 + 34 + d.deductions.length * 20 + (d.deductions.length ? 34 : 0) + 10;
  if (y + needed > BOTTOM) {
    nextPage();
  }
  const tx = R - 300;
  const row = (lab: string, val: string, o2: { bold?: boolean; rule?: boolean; color?: string } = {}) => {
    if (o2.rule) p.line(tx, y - 3, R, y - 3, { stroke: '#334155', sw: 1 });
    p.text(tx, y, t(lab), o2.bold ? 14 : 12.5, { bold: o2.bold, color: o2.color ?? (o2.bold ? INK : '#334155') });
    p.text(R, y, t(val), o2.bold ? 14 : 12.5, { anchor: 'end', bold: o2.bold, color: o2.color });
    y += o2.bold ? 24 : 20;
  };
  row(d.tax_mode === 'standard' ? 'Summe netto' : 'Summe (ohne Umsatzsteuer)', money(tot.subtotal_cents));
  for (const g of taxRows) row(`zzgl. ${String(g.rate).replace('.', ',')} % USt. auf ${deAmount(g.net_cents)}`, money(g.tax_cents));
  row(credit ? 'Gesamtbetrag der Gutschrift' : 'Gesamtbetrag', money(tot.total_cents), { bold: true, rule: true });
  if (d.deductions.length) {
    // A Storno of a final invoice has negative totals: the partial invoices it deducted stay valid, so they reduce the refund
    // (−1 190 + 357 = −833 – it printed −1 190 − 357 = −1 547), the same as the online document.
    const sign = credit ? 1 : -1;
    for (const x of d.deductions) row(`abzgl. ${INV_TYPES.partial} ${x.number} vom ${deYmd(deductionYmd(x))}`, money(sign * x.total_cents), { color: '#334155' });
    row(credit ? 'Erstattungsbetrag' : 'Noch zu zahlen', money(tot.total_cents + sign * d.deducted_cents), { bold: true, rule: true });
  }
  y += 10;

  // --- notes, payment terms, bank, GiroCode --------------------------------------------------------------------------------
  const block = (text: string, size: number, o2: { bold?: boolean; color?: string } = {}) => {
    if (y + measure(t(text), size, CW, o2.bold) > BOTTOM) nextPage();
    y += p.para(L, y, t(text), CW, size, { bold: o2.bold, color: o2.color, gap: 8 });
  };
  if (d.tax_mode !== 'standard' && d.tax_note) block(d.tax_note, 12.5, { bold: true });
  if (d.notes) block(d.notes, 12.5);
  const open = o.open_cents ?? tot.total_cents - d.deducted_cents;
  if (!credit && !quote) {
    const terms = paymentTermsText({ due_ymd: d.due_ymd, skonto: d.skonto, issued_ymd: d.issued_ymd, total_cents: open, currency: d.currency });
    if (terms) block(terms, 12.5);
    if (d.bank.iban && open > 0) {
      const code = girocodeFor({ name: s.name, iban: d.bank.iban, bic: d.bank.bic, amount_cents: open, remittance: draft ? 'Rechnung' : `${title === 'Rechnung' ? 'Rechnung' : title} ${d.number}`, currency: d.currency });
      const h = 162;
      if (y + h > BOTTOM) nextPage();
      p.rect(L, y, CW, h, { fill: '#f8fafc', stroke: '#e2e8f0', sw: 1 });
      p.text(L + 14, y + 12, 'Zahlungsinformationen', 13, { bold: true, color: ACCENT });
      const lines: [string, string][] = [['Empfänger', s.name], ['IBAN', formatIban(d.bank.iban)], ...(d.bank.bic ? ([['BIC', d.bank.bic]] as [string, string][]) : []), ...(d.bank.bank ? ([['Bank', d.bank.bank]] as [string, string][]) : []), ['Verwendungszweck', draft ? '' : d.number], ['Betrag', money(open)]];
      // The values end before the GiroCode.
      const valueW = (code ? R - 112 - 16 - 10 : R - 14) - (L + 130);
      lines.forEach(([k, v], i) => {
        p.text(L + 14, y + 36 + i * 19, t(k), 11.5, { color: MUTED });
        const f = fitLine(t(v), 12.5, valueW, { bold: k === 'IBAN' || k === 'Betrag', min: 9 });
        p.text(L + 130, y + 36 + i * 19, f.text, f.size, { bold: k === 'IBAN' || k === 'Betrag' });
      });
      if (code) {
        const m = qrMatrix(code);
        const box = 112;
        const cell = box / (m.size + 8);
        const qx = R - box - 16;
        const qy = y + 14;
        p.rect(qx, qy, box, box, { fill: '#ffffff' });
        const d2: any[] = [];
        for (const [x, yy, n] of qrRuns(m)) {
          const X0 = qx + (x + 4) * cell;
          const Y0 = qy + (yy + 4) * cell;
          d2.push(['M', X0, Y0], ['L', X0 + n * cell, Y0], ['L', X0 + n * cell, Y0 + cell], ['L', X0, Y0 + cell], ['Z']);
        }
        p.prims.push({ t: 'path', d: d2, fill: '#000000' });
        p.text(qx + box / 2, qy + box + 1, 'GiroCode', 9, { anchor: 'middle', bold: true, color: MUTED });
        p.text(qx + box / 2, qy + box + 13, 'mit Banking-App scannen', 8.5, { anchor: 'middle', color: MUTED });
      }
      y += h + 12;
    }
    if (o.url) block(`Rechnung online ansehen${d.bank.iban ? '' : ' und bezahlen'}: ${o.url}`, 11, { color: '#1d4ed8' });
  } else if (credit) {
    block(d.credit_type === 'storno' ? 'Diese Stornorechnung hebt die genannte Rechnung vollständig auf. Bereits gezahlte Beträge erstatten wir bzw. verrechnen wir mit offenen Forderungen.' : 'Der Gutschriftsbetrag wird erstattet bzw. mit offenen Forderungen verrechnet.', 12.5);
  }

  // --- footer and page numbers on every page --------------------------------------------------------------------------------
  pages.forEach((pg, i) => {
    const fy = H - 104;
    pg.line(L, fy, R, fy, { stroke: '#cbd5e1', sw: 0.8 });
    // Three columns that never run into each other; the free text starts under the longest one (four lines with tax number,
    // VAT ID, IBAN and BIC) and leaves room for the page number.
    let rowsUsed = 0;
    const col = (x: number, w: number, lines: string[]) => {
      const list = lines.filter(Boolean);
      rowsUsed = Math.max(rowsUsed, list.length);
      list.forEach((l, k) => {
        const f = fitLine(t(l), 9.5, w, { min: 7.5 });
        pg.text(x, fy + 8 + k * 12.5, f.text, f.size, { color: MUTED });
      });
    };
    col(L, 180, [s.name, s.street, [s.postal_code, s.city].filter(Boolean).join(' ')]);
    col(L + 190, 210, [s.phone ? `Tel. ${s.phone}` : '', s.email]);
    col(L + 410, R - L - 410, [s.tax_number ? `Steuernr. ${s.tax_number}` : '', s.vat_id ? `USt-IdNr. ${s.vat_id}` : '', d.bank.iban ? `IBAN ${formatIban(d.bank.iban)}` : '', d.bank.bic ? `BIC ${d.bank.bic}` : '']);
    if (s.footer) pg.para(L, fy + 10 + rowsUsed * 12.5, t(s.footer), CW - 80, 9, { color: MUTED, maxLines: 2 });
    pg.text(R, H - 24, `Seite ${i + 1} von ${pages.length}`, 9, { anchor: 'end', color: MUTED });
    if (draft && i >= 0) {
      pg.prims.push({ t: 'group', m: [0.825, -0.565, 0.565, 0.825, W / 2, H / 2], children: [{ t: 'text', x: 0, y: -60, lines: ['ENTWURF'], size: 130, font: 'sans', bold: true, anchor: 'middle', color: '#e8edf3', lh: 162 }] });
    }
  });
  return { pages, images, title: t(label) };
}

/** Height of a wrapped paragraph, the way Page.para lays it out. */
const measure = (text: string, size: number, width: number, bold = false) => layoutText(text, size, { maxWidth: width, bold, font: 'sans', lineHeight: 1.4 }).height;

const formatIban = (i: string) => String(i ?? '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
