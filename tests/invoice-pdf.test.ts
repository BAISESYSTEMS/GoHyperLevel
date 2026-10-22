import { describe, expect, it } from 'vitest';
import { epcPayload, girocodeFor, qrMatrix, qrRuns, qrSvg } from '../server/services/giro-code.js';
import { invoicePdf } from '../server/services/invoice-pdf.js';
import { negateItems, TAX_MODES } from '../server/services/invoice-model.js';
import { BANK, BUYER, ITEMS, SELLER, doc } from './invoice-fixtures.js';

const text = (pdf: Buffer) => pdf.toString('latin1');
const pageCount = (pdf: Buffer) => Number(/\/Count (\d+)/.exec(text(pdf))?.[1]);

describe('GiroCode (EPC069-12)', () => {
  const base = { name: 'Muster Beratung GmbH', iban: 'DE02 1203 0000 0000 2020 51', bic: 'byladem1001', amount_cents: 27534, remittance: 'Rechnung RE-2026-0001' };

  it('writes the 12 lines of version 002 in the order of the guideline', () => {
    const lines = epcPayload(base).split('\n');
    expect(lines).toEqual(['BCD', '002', '1', 'SCT', 'BYLADEM1001', 'Muster Beratung GmbH', 'DE02120300000000202051', 'EUR275.34', '', '', 'Rechnung RE-2026-0001']);
    expect(lines[0]).toBe('BCD'); // service tag
    expect(lines[2]).toBe('1'); // UTF-8
    expect(lines[7]).toMatch(/^EUR\d{1,9}\.\d{2}$/); // dot as decimal separator, no thousands separator
  });

  it('formats amounts without rounding artefacts', () => {
    expect(epcPayload({ ...base, amount_cents: 5 }).split('\n')[7]).toBe('EUR0.05');
    expect(epcPayload({ ...base, amount_cents: 100000 }).split('\n')[7]).toBe('EUR1000.00');
    expect(epcPayload({ ...base, amount_cents: 99_999_999_999 }).split('\n')[7]).toBe('EUR999999999.99');
  });

  it('refuses what the standard does not allow', () => {
    expect(() => epcPayload({ ...base, iban: 'DE02120300000000202052' })).toThrow(/IBAN/);
    expect(() => epcPayload({ ...base, amount_cents: 0 })).toThrow(/Betrag/);
    expect(() => epcPayload({ ...base, amount_cents: -100 })).toThrow(/Betrag/);
    expect(() => epcPayload({ ...base, amount_cents: 100_000_000_000 })).toThrow(/Betrag/);
    expect(() => epcPayload({ ...base, name: '  ' })).toThrow(/name/i);
    expect(() => epcPayload({ ...base, bic: 'XX' })).toThrow(/BIC/);
    expect(girocodeFor({ ...base, currency: 'USD' })).toBeNull();
    expect(girocodeFor({ ...base, iban: 'kaputt' })).toBeNull();
  });

  it('cuts the name at 70 and the remittance at 140 characters and stays below 331 bytes', () => {
    const p = epcPayload({ ...base, name: 'N'.repeat(100), remittance: 'R'.repeat(300) });
    const lines = p.split('\n');
    expect(lines[5]).toHaveLength(70);
    expect(lines[10]).toHaveLength(140);
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(331);
  });

  it('turns into a QR code with the finder patterns in place', () => {
    const m = qrMatrix(epcPayload(base));
    expect(m.size).toBeGreaterThanOrEqual(25);
    // top-left finder: a dark 7×7 ring with a light ring and a dark centre
    expect(m.dark(0, 0) && m.dark(6, 0) && m.dark(0, 6) && m.dark(6, 6)).toBe(true);
    expect(m.dark(1, 1)).toBe(false);
    expect(m.dark(3, 3)).toBe(true);
    expect(qrRuns(m).length).toBeGreaterThan(50);
    const svg = qrSvg(epcPayload(base), 120);
    expect(svg).toContain('<svg');
    expect(svg).toContain('GiroCode');
  });
});

describe('invoice PDF', () => {
  it('produces a valid, deterministic A4 PDF with the content of the invoice', () => {
    const pdf = invoicePdf(doc());
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('/MediaBox [0 0 595.5 842.25]');
    expect(pageCount(pdf)).toBe(1);
    for (const needle of ['Rechnung RE-2026-0001', 'Muster Beratung GmbH', 'Musterstra\\337e 1', 'Beratung', 'Workshop vor Ort', '275,34', '19 % USt. auf 200,00', '7 % USt. auf 34,90', 'DE02 1203 0000 0000 2020 51', 'DE811569869', 'Seite 1 von 1', '05.10.2026', '19.10.2026']) {
      expect(s, needle).toContain(needle);
    }
    // the same document gives the same bytes
    expect(invoicePdf(doc()).equals(pdf)).toBe(true);
    // a QR code was drawn (many filled rectangles in one path)
    expect(s).toContain('GiroCode');
  });

  it('flows long invoices over several pages and numbers them', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ name: `Position Nummer ${i + 1}`, description: 'Eine Beschreibung, die ein wenig länger ist als nur ein Wort.', qty: 1 + (i % 3), price_cents: 1000 + i * 7, tax_rate: 19 }));
    const pdf = invoicePdf(doc({ items }));
    const n = pageCount(pdf);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(text(pdf)).toContain(`Seite ${n} von ${n}`);
    expect(text(pdf)).toContain('Position Nummer 60');
    expect(text(pdf)).toContain('Gesamtbetrag');
  });

  it('marks a draft, prints credit notes with their reference and negative amounts', () => {
    expect(text(invoicePdf(doc({ number: '' }), { draft: true }))).toContain('ENTWURF');
    const credit = invoicePdf(doc({ kind: 'credit_note', credit_type: 'storno', number: 'ST-2026-0001', items: negateItems(ITEMS), ref: { id: 'o', number: 'RE-2026-0001', issued_at: '2026-10-05T10:00:00Z' } }));
    const s = text(credit);
    expect(s).toContain('Stornorechnung ST-2026-0001');
    expect(s).toContain('Storno der Rechnung RE-2026-0001 vom 05.10.2026');
    expect(s).toContain('-275,34');
    expect(s).not.toContain('GiroCode');
  });

  it('prints the tax note, the supply period, Skonto, the deductions of a final invoice and the customer link', () => {
    const pdf = invoicePdf(
      doc({
        tax_mode: 'reverse_charge',
        tax_note: TAX_MODES.reverse_charge.note,
        supply_from: '2026-09-01',
        supply_to: '2026-09-30',
        skonto: { percent: 2, days: 10 },
        inv_type: 'final',
        items: [{ name: 'Projekt', qty: 1, price_cents: 50000, tax_rate: 0 }],
        buyer: { ...BUYER, vat_id: 'FR12345678901', country: 'FR' },
        deductions: [{ id: 'p', number: 'RE-2026-0002', issued_at: '2026-09-01T10:00:00Z', net_cents: 10000, tax_cents: 0, total_cents: 10000, groups: [] }],
      }),
      { url: 'https://example.test/i/abc' },
    );
    const s = text(pdf);
    expect(s).toContain('Steuerschuldnerschaft des Leistungsempf');
    expect(s).toContain('01.09.2026 \\226 30.09.2026');
    expect(s).toContain('2 % Skonto');
    expect(s).toContain('abzgl. Abschlagsrechnung RE-2026-0002');
    expect(s).toContain('Noch zu zahlen');
    expect(s).toContain('FR12345678901');
    expect(s).toContain('https://example.test/i/abc');
  });

  it('survives characters the base fonts do not have and a seller without bank data', () => {
    const pdf = invoicePdf(doc({ items: [{ name: 'Beratung ✓ → 日本語 emoji 😀', qty: 1, price_cents: 1000, tax_rate: 19 }], bank: { iban: '', bic: '', bank: '' }, seller: { ...SELLER, phone: '', footer: 'Geschäftsführer: A. Muster · Amtsgericht Berlin HRB 1' } }));
    expect(pdf.length).toBeGreaterThan(1500);
    expect(text(pdf)).not.toContain('Zahlungsinformationen');
    expect(text(pdf)).toContain('Amtsgericht Berlin');
  });

  it('keeps the bank block off paid-up documents and draws no QR for non-EUR invoices', () => {
    const usd = text(invoicePdf(doc({ currency: 'USD' })));
    expect(usd).toContain('Zahlungsinformationen');
    expect(usd).not.toContain('GiroCode');
    const paid = text(invoicePdf(doc(), { open_cents: 0, status: { text: 'Bezahlt am 20.10.2026', color: '#15803d' } }));
    expect(paid).not.toContain('Zahlungsinformationen');
    expect(paid).toContain('Bezahlt am 20.10.2026');
    void BANK;
  });
});
