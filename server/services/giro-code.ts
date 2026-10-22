import QRCode from 'qrcode';
import { checkIban, normalizeIban } from './invoice-model.js';

/**
 * GiroCode: the QR code of the European Payments Council (EPC069-12, "Quick Response Code: Guidelines to Enable the
 * Data Capture for the Initiation of a SEPA Credit Transfer", version 002) that banking apps scan to fill in a transfer.
 * Only EUR, only SEPA credit transfers.
 */

export interface EpcInput {
  /** Beneficiary (max 70 characters). */
  name: string;
  iban: string;
  bic?: string;
  /** Amount in euro cents (0,01 … 999 999 999,99). */
  amount_cents: number;
  /** Unstructured remittance information (max 140 characters), e.g. "Rechnung RE-1001". */
  remittance: string;
}

const MAX_BYTES = 331;

/** The payload text of the QR code. Throws a German message when the data cannot form a valid code. */
export function epcPayload(i: EpcInput): string {
  const iban = normalizeIban(i.iban);
  if (!checkIban(iban)) throw new Error('Die IBAN ist ungültig – kein GiroCode möglich');
  const name = String(i.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
  if (!name) throw new Error('Empfängername fehlt – kein GiroCode möglich');
  if (!Number.isInteger(i.amount_cents) || i.amount_cents < 1 || i.amount_cents > 99_999_999_999) throw new Error('Der Betrag muss zwischen 0,01 und 999 999 999,99 Euro liegen');
  const bic = String(i.bic ?? '').replace(/\s+/g, '').toUpperCase();
  if (bic && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) throw new Error('Die BIC ist ungültig');
  const remittance = String(i.remittance ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 140);
  const amount = `EUR${Math.floor(i.amount_cents / 100)}.${String(i.amount_cents % 100).padStart(2, '0')}`;
  // service tag, version, character set (1 = UTF-8), identification, BIC, name, IBAN, amount, purpose, structured reference, unstructured reference
  const text = ['BCD', '002', '1', 'SCT', bic, name, iban, amount, '', '', remittance].join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Die Zahlungsdaten sind für einen GiroCode zu lang');
  return text;
}

/** Whether a GiroCode makes sense for this payment (never throws). */
export function girocodeFor(i: EpcInput & { currency?: string }): string | null {
  if ((i.currency ?? 'EUR') !== 'EUR') return null;
  try {
    return epcPayload(i);
  } catch {
    return null;
  }
}

export interface QrMatrix {
  size: number;
  dark(x: number, y: number): boolean;
}

/** The modules of a QR code (error correction level M, as the EPC guideline recommends). */
export function qrMatrix(text: string): QrMatrix {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = q.modules.size;
  return { size, dark: (x, y) => !!q.modules.get(y, x) };
}

/** Horizontal runs of dark modules, `[x, y, length]` – one rectangle per run keeps vector output small. */
export function qrRuns(m: QrMatrix): [number, number, number][] {
  const runs: [number, number, number][] = [];
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!m.dark(x, y)) {
        x++;
        continue;
      }
      let n = 1;
      while (x + n < m.size && m.dark(x + n, y)) n++;
      runs.push([x, y, n]);
      x += n;
    }
  }
  return runs;
}

/** An inline SVG of the QR code (quiet zone of four modules included) for the HTML page. */
export function qrSvg(text: string, px = 160): string {
  const m = qrMatrix(text);
  const q = 4;
  const d = qrRuns(m)
    .map(([x, y, n]) => `M${x + q} ${y + q}h${n}v1h-${n}z`)
    .join('');
  const total = m.size + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="GiroCode zum Bezahlen per Banking-App"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
