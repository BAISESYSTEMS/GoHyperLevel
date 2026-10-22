import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { id, now } from '../core/util.js';
import { archiveDocument, docPath } from '../modules/accounting-receipts.js';
import { ciiXml } from './einvoice-cii.js';
import { buildEInvoice, type DocSnapshot } from './einvoice-model.js';
import { ublXml } from './einvoice-ubl.js';
import { validateEInvoice, type ValidationResult } from './einvoice-validate.js';
import { docOf, type Actor, type Inv } from './invoice-flow.js';
import { invoicePdf } from './invoice-pdf.js';
import { creditClosed, deYmd, docTitle, isDraftNumber, openCents } from './invoice-model.js';

/**
 * Turns an invoice into files: the PDF, the XRechnung (CII or UBL) and their archive copies. The content always comes from
 * the frozen snapshot (docOf), so a file made today equals the one made on the day of the invoice – except for the two fields
 * that stay editable (note, due date).
 */

/** The logo of the sub-account when it is one of its own uploads (no remote fetch from a PDF job). */
export function logoOf(app: App, loc: string): Buffer | null {
  const url = String(app.location(loc)?.logo_url ?? '');
  const m = /\/uploads\/([A-Za-z0-9._-]+)$/.exec(url.split('?')[0]);
  if (!m) return null;
  const row = app.db.get<{ file: string }>('SELECT file FROM uploads WHERE file = ? AND location_id = ?', m[1], loc);
  const path = row && join(app.config.dataDir, 'uploads', row.file);
  try {
    return path && existsSync(path) ? readFileSync(path) : null;
  } catch {
    return null;
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function pdfFilename(doc: Pick<DocSnapshot, 'kind' | 'inv_type' | 'credit_type' | 'number'>): string {
  return `${safe(docTitle(doc).replace('/', ''))}-${safe(doc.number || 'Entwurf')}.pdf`;
}

export const einvoiceFilename = (doc: Pick<DocSnapshot, 'number' | 'kind'>, syntax: 'cii' | 'ubl') => `${doc.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'}-${safe(doc.number)}-xrechnung-${syntax}.xml`;

/** What the live status adds to the printed page (not part of the frozen document). */
export function statusStamp(app: App, inv: Inv): { text: string; color: string } | null {
  if (inv.status === 'paid' && inv.kind === 'invoice') return { text: `Bezahlt${inv.paid_at ? ` am ${deYmd(String(inv.paid_at).slice(0, 10))}` : ''}`, color: '#15803d' };
  if (creditClosed(inv)) return { text: 'Gutgeschrieben', color: '#475569' };
  if (inv.status === 'void' && inv.finalised_at) return { text: 'Storniert', color: '#b91c1c' };
  void app;
  return null;
}

export interface PdfOut {
  pdf: Buffer;
  filename: string;
  doc: DocSnapshot;
}

export function invoicePdfOf(app: App, inv: Inv): PdfOut {
  const doc = docOf(app, inv);
  const draft = !inv.finalised_at && inv.kind !== 'estimate' && isDraftNumber(inv.number);
  const pdf = invoicePdf(doc, {
    logo: logoOf(app, inv.location_id),
    draft,
    status: statusStamp(app, inv),
    url: inv.kind === 'estimate' || inv.status === 'draft' ? undefined : `${app.baseUrl()}/i/${inv.public_token}`,
    open_cents: inv.kind === 'invoice' ? openCents(inv) : undefined,
  });
  return { pdf, filename: pdfFilename(doc), doc };
}

export interface EInvoiceOut {
  xml: string;
  syntax: 'cii' | 'ubl';
  filename: string;
  validation: ValidationResult;
  doc: DocSnapshot;
}

/** The e-invoice of a finalised invoice or credit note. Refuses (409/422) when it is no final document or when XRechnung would reject it. */
export function einvoiceOf(app: App, inv: Inv, syntax: 'cii' | 'ubl' = 'cii'): EInvoiceOut {
  if (inv.kind === 'estimate') throw new HttpError(409, 'Für Angebote gibt es keine E-Rechnung');
  if (!inv.finalised_at) throw new HttpError(409, 'Die E-Rechnung gibt es erst, wenn die Rechnung festgeschrieben ist – vorher kann sich noch etwas ändern');
  const doc = docOf(app, inv);
  const { einvoice, problems } = buildEInvoice(doc);
  if (problems.length) throw new HttpError(422, `Für die XRechnung fehlt noch etwas: ${problems.map((p) => p.message).join(' · ')}`, { problems: problems.map((p) => p.message) });
  const xml = syntax === 'ubl' ? ublXml(einvoice) : ciiXml(einvoice);
  const validation = validateEInvoice(xml);
  if (!validation.valid) throw new HttpError(422, `Die XRechnung besteht die Prüfung nicht: ${validation.errors.map((e) => `${e.rule}: ${e.message}`).join(' · ')}`, { errors: validation.errors });
  return { xml, syntax, filename: einvoiceFilename(doc, syntax), validation, doc };
}

export interface EInvoiceReport {
  /** The invoice is final – the check below is about the file that would be written. A draft is checked as a preview. */
  final: boolean;
  syntax: 'cii' | 'ubl';
  /** Nothing missing and every rule passed: the download works. */
  ready: boolean;
  /** Missing information (German), e.g. the seller's phone number. */
  problems: string[];
  errors: { rule: string; message: string }[];
  warnings: { rule: string; message: string }[];
}

/** What XRechnung would say about this invoice right now – without writing a file or refusing. */
export function einvoiceReport(app: App, inv: Inv, syntax: 'cii' | 'ubl' = 'cii'): EInvoiceReport {
  if (inv.kind === 'estimate') return { final: false, syntax, ready: false, problems: ['Für Angebote gibt es keine E-Rechnung'], errors: [], warnings: [] };
  const doc = docOf(app, inv);
  const { einvoice, problems } = buildEInvoice(doc);
  const xml = syntax === 'ubl' ? ublXml(einvoice) : ciiXml(einvoice);
  const v = validateEInvoice(xml);
  // a draft has no number yet – that is not a finding of the preview
  const errors = v.errors.filter((e) => inv.finalised_at || e.rule !== 'BR-02').map(({ rule, message }) => ({ rule, message }));
  return { final: !!inv.finalised_at, syntax, ready: !!inv.finalised_at && !problems.length && v.valid, problems: problems.map((p) => p.message), errors, warnings: v.warnings.map(({ rule, message }) => ({ rule, message })) };
}

// --- archive ------------------------------------------------------------------------------------------------------------------

/** Retention of tax-relevant documents: eight years from the end of the calendar year (§ 147 AO, since 2025 for booking vouchers). */
export const RETENTION_YEARS = 8;
export const retentionUntil = (issuedYmd: string): string => `${Number(issuedYmd.slice(0, 4)) + RETENTION_YEARS}-12-31`;

export interface ArchivedDoc {
  id: string;
  kind: string;
  document_id: string;
  sha256: string;
  size: number;
  retention_until: string;
  created_at: string;
  duplicate: boolean;
}

/**
 * Stores generated bytes in the document archive of the accounting (the same one the receipts use: written once, SHA-256,
 * never changed or deleted) and links them to the invoice. Identical bytes are stored once.
 */
export function archiveFile(app: App, inv: Inv, kind: 'xrechnung-cii' | 'xrechnung-ubl' | 'pdf' | 'zugferd', f: { name: string; mime: string; data: Buffer }, actor: Actor): ArchivedDoc {
  const { document, duplicate } = archiveDocument(app, inv.location_id, f, { id: actor.id ?? null }, kind === 'pdf' ? 'invoice-pdf' : 'einvoice-out');
  const link = app.db.get<any>('SELECT * FROM invoice_documents WHERE invoice_id = ? AND document_id = ?', inv.id, document.id);
  if (link) return { ...link, duplicate: true };
  const row = {
    id: id(),
    location_id: inv.location_id,
    invoice_id: inv.id,
    kind,
    document_id: document.id,
    sha256: document.sha256,
    size: document.size,
    retention_until: retentionUntil((inv.snapshot?.issued_ymd ?? String(inv.issued_at).slice(0, 10)) || now().slice(0, 10)),
    created_by: actor.id ?? null,
    created_at: now(),
  };
  app.db.insert('invoice_documents', row);
  return { ...row, duplicate };
}

export const archiveEinvoice = (app: App, inv: Inv, out: EInvoiceOut, actor: Actor): ArchivedDoc => archiveFile(app, inv, out.syntax === 'ubl' ? 'xrechnung-ubl' : 'xrechnung-cii', { name: out.filename, mime: 'application/xml', data: Buffer.from(out.xml, 'utf8') }, actor);

/** The file of an archived document (written by the accounting archive). */
export const archivedFile = (app: App, d: { id: string; mime: string }) => docPath(app, d);
