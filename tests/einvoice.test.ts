import { describe, expect, it } from 'vitest';
import { parseEInvoice } from '../server/services/acc-receipts.js';
import { ciiXml } from '../server/services/einvoice-cii.js';
import { buildEInvoice, type DocSnapshot } from '../server/services/einvoice-model.js';
import { ublXml } from '../server/services/einvoice-ubl.js';
import { validateEInvoice } from '../server/services/einvoice-validate.js';
import { TAX_MODES, negateItems } from '../server/services/invoice-model.js';
import { BANK, BUYER, ITEMS, SELLER, doc } from './invoice-fixtures.js';

/** Both syntaxes of a document, each checked against the rules. */
function both(d: DocSnapshot) {
  const { einvoice, problems } = buildEInvoice(d);
  const cii = ciiXml(einvoice);
  const ubl = ublXml(einvoice);
  return { einvoice, problems, cii, ubl, vc: validateEInvoice(cii), vu: validateEInvoice(ubl) };
}
const rules = (r: ReturnType<typeof validateEInvoice>) => r.errors.map((e) => e.rule);

describe('XRechnung: standard invoice', () => {
  const r = both(doc());
  it('has everything XRechnung needs and passes the rules in both syntaxes', () => {
    expect(r.problems).toEqual([]);
    expect(r.vc.errors).toEqual([]);
    expect(r.vu.errors).toEqual([]);
    expect(r.vc).toMatchObject({ valid: true, syntax: 'cii', type_code: '380' });
    expect(r.vu).toMatchObject({ valid: true, syntax: 'ubl', type_code: '380' });
  });

  it('writes the sums and the VAT breakdown per rate', () => {
    // 2 × 100,00 at 19 % + 34,90 at 7 %: tax 38,00 + 2,44 (rounded once per rate)
    expect(r.einvoice.totals).toEqual({ line_cents: 23490, basis_cents: 23490, tax_cents: 4044, grand_cents: 27534, prepaid_cents: 0, due_cents: 27534 });
    for (const xml of [r.cii, r.ubl]) {
      expect(xml).toContain('275.34');
      expect(xml).toContain('40.44');
      expect(xml).toContain('urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0');
    }
    expect(r.cii).toContain('<ram:TypeCode>380</ram:TypeCode>');
    expect(r.cii).toContain('<ram:BilledQuantity unitCode="HUR">2</ram:BilledQuantity>');
    expect(r.cii).toContain('<udt:DateTimeString format="102">20261005</udt:DateTimeString>');
    expect(r.cii).toContain('<ram:ID schemeID="VA">DE811569869</ram:ID>');
    expect(r.cii).toContain('<ram:ID schemeID="FC">37/123/45678</ram:ID>');
    expect(r.ubl).toContain('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(r.ubl).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>');
    expect(r.ubl).toContain('<cbc:DueDate>2026-10-19</cbc:DueDate>');
  });

  it('reads back into the same numbers through the receipt parser (round trip)', () => {
    for (const xml of [r.cii, r.ubl]) {
      const p = parseEInvoice(xml)!;
      expect(p.method).toBe('xrechnung');
      expect(p.fields).toMatchObject({ invoice_no: 'RE-2026-0001', net_cents: 23490, vat_cents: 4044, gross_cents: 27534, credit_note: false, supplier: 'Muster Beratung GmbH', iban: 'DE02120300000000202051', currency: 'EUR' });
    }
  });

  it('rounds the tax once per rate – many small lines still satisfy BR-CO-17', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ name: `Teil ${i + 1}`, qty: 1, price_cents: 33, tax_rate: 19 }));
    const x = both(doc({ items }));
    // 7 × 0,33 = 2,31 net; 19 % of 2,31 = 0,4389 → 0,44 (line-by-line rounding would give 7 × 0,06 = 0,42)
    expect(x.einvoice.totals.tax_cents).toBe(44);
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
  });

  it('escapes what is typed into names and notes', () => {
    const x = both(doc({ items: [{ name: 'A & B <test> "q"', qty: 1, price_cents: 1000, tax_rate: 19 }], notes: 'Zeile 1\nZeile 2 & Dank' }));
    expect(x.cii).toContain('A &amp; B &lt;test&gt; &quot;q&quot;');
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
    expect(parseEInvoice(x.ubl)).not.toBeNull();
  });
});

describe('XRechnung: tax treatments', () => {
  it('reverse charge: category AE, reason code, both VAT IDs', () => {
    const d = doc({ tax_mode: 'reverse_charge', tax_note: TAX_MODES.reverse_charge.note, items: [{ name: 'Softwareentwicklung', qty: 10, price_cents: 9000, tax_rate: 0 }], buyer: { ...BUYER, country: 'FR', vat_id: 'FR12345678901', street: 'Rue 1', city: 'Paris', postal_code: '75001' } });
    const x = both(d);
    expect(x.problems).toEqual([]);
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
    for (const xml of [x.cii, x.ubl]) {
      expect(xml).toContain('>AE<');
      expect(xml).toContain('VATEX-EU-AE');
      expect(xml).toContain('FR12345678901');
    }
    expect(x.einvoice.totals).toMatchObject({ tax_cents: 0, grand_cents: 90000, due_cents: 90000 });
    // without the buyer's VAT ID the rule BR-AE-02 fires
    const ids = both(doc({ ...{ tax_mode: 'reverse_charge' as const, tax_note: TAX_MODES.reverse_charge.note }, buyer: { ...BUYER, vat_id: '' }, items: [{ name: 'X', qty: 1, price_cents: 1000, tax_rate: 0 }] }));
    expect(rules(ids.vc)).toContain('BR-AE-02');
    expect(rules(ids.vu)).toContain('BR-AE-02');
  });

  it('small business (§ 19 UStG): category E with the reason text, no tax', () => {
    const d = doc({ tax_mode: 'small_business', tax_note: TAX_MODES.small_business.note, seller: { ...SELLER, vat_id: '' }, items: [{ name: 'Gestaltung', qty: 1, price_cents: 45000, tax_rate: 0 }] });
    const x = both(d);
    expect(x.problems).toEqual([]);
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
    expect(x.cii).toContain('<ram:CategoryCode>E</ram:CategoryCode>');
    expect(x.cii).toContain('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.');
    expect(x.cii).not.toContain('schemeID="VA"');
    expect(x.einvoice.totals).toMatchObject({ tax_cents: 0, grand_cents: 45000 });
    // no tax number at all → BR-DE-16
    const none = both(doc({ tax_mode: 'small_business', tax_note: TAX_MODES.small_business.note, seller: { ...SELLER, vat_id: '', tax_number: '' }, items: [{ name: 'X', qty: 1, price_cents: 1000, tax_rate: 0 }] }));
    expect(rules(none.vc)).toContain('BR-DE-16');
    expect(none.problems.map((p) => p.message).join(' ')).toContain('Steuernummer');
  });

  it('intra-community supply: category K needs both IDs and a supply date (which defaults to the invoice date)', () => {
    const d = doc({ tax_mode: 'ig_supply', tax_note: TAX_MODES.ig_supply.note, items: [{ name: 'Ware', qty: 5, price_cents: 2000, tax_rate: 0 }], buyer: { ...BUYER, country: 'AT', vat_id: 'ATU12345678', street: 'Ring 1', city: 'Wien', postal_code: '1010' } });
    const x = both(d);
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
    expect(x.cii).toContain('VATEX-EU-IC');
    expect(x.cii).toContain('<ram:ActualDeliverySupplyChainEvent>');
    expect(x.ubl).toContain('<cbc:ActualDeliveryDate>2026-10-05</cbc:ActualDeliveryDate>');
  });

  it('a supply period becomes the invoicing period (BG-14)', () => {
    const x = both(doc({ supply_from: '2026-09-01', supply_to: '2026-09-30' }));
    expect(x.vc.errors).toEqual([]);
    expect(x.cii).toContain('<ram:BillingSpecifiedPeriod>');
    expect(x.cii).toContain('20260930');
    expect(x.ubl).toContain('<cbc:StartDate>2026-09-01</cbc:StartDate>');
    expect(x.ubl).toContain('<cbc:EndDate>2026-09-30</cbc:EndDate>');
    expect(x.vu.errors).toEqual([]);
  });
});

describe('XRechnung: credit note (type 381)', () => {
  const orig = { id: 'orig', number: 'RE-2026-0001', issued_at: '2026-10-05T10:00:00Z' };
  const d = doc({ kind: 'credit_note', credit_type: 'storno', number: 'ST-2026-0001', items: negateItems(ITEMS), ref: orig });
  const x = both(d);

  it('keeps the document negative but writes absolute amounts with type 381 and the reference', () => {
    expect(d.totals.total_cents).toBe(-27534);
    expect(x.problems).toEqual([]);
    expect(x.vc).toMatchObject({ valid: true, type_code: '381' });
    expect(x.vu).toMatchObject({ valid: true, type_code: '381', syntax: 'ubl' });
    expect(x.einvoice.totals).toMatchObject({ line_cents: 23490, tax_cents: 4044, grand_cents: 27534, due_cents: 27534 });
    expect(x.cii).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(x.cii).toContain('<ram:InvoiceReferencedDocument>');
    expect(x.cii).toContain('<ram:IssuerAssignedID>RE-2026-0001</ram:IssuerAssignedID>');
    expect(x.ubl).toContain('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"');
    expect(x.ubl).toContain('<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>');
    expect(x.ubl).toContain('<cbc:CreditedQuantity unitCode="HUR">2</cbc:CreditedQuantity>');
    expect(x.ubl).toContain('<cac:BillingReference>');
    expect(x.ubl).not.toContain('<cbc:DueDate>');
    expect(x.ubl).toContain('<cbc:PaymentDueDate>2026-10-19</cbc:PaymentDueDate>');
  });

  it('is read back as a credit note by the receipt parser', () => {
    for (const xml of [x.cii, x.ubl]) expect(parseEInvoice(xml)!.fields).toMatchObject({ credit_note: true, gross_cents: 27534, invoice_no: 'ST-2026-0001' });
  });

  it('a partial credit note (Gutschrift) works the same', () => {
    const part = both(doc({ kind: 'credit_note', credit_type: 'credit', number: 'GS-2026-0001', items: negateItems([{ name: 'Nachlass auf Beratung', qty: 1, price_cents: 5000, tax_rate: 19 }]), ref: orig }));
    expect(part.vc.errors).toEqual([]);
    expect(part.vu.errors).toEqual([]);
    expect(part.einvoice.totals).toMatchObject({ line_cents: 5000, tax_cents: 950, grand_cents: 5950 });
  });
});

describe('XRechnung: partial invoices and the final invoice', () => {
  const prior = { id: 'p1', number: 'RE-2026-0002', issued_at: '2026-09-01T10:00:00Z', net_cents: 10000, tax_cents: 1900, total_cents: 11900, groups: [{ category: 'S' as const, rate: 19, net_cents: 10000, tax_cents: 1900 }] };

  it('a partial invoice (Abschlag) is type 326', () => {
    const x = both(doc({ inv_type: 'partial', items: [{ name: 'Abschlag 1', qty: 1, price_cents: 10000, tax_rate: 19 }] }));
    expect(x.einvoice.type_code).toBe('326');
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
  });

  it('the final invoice shows the full amounts, the prepaid amount (BT-113) and what is still due (BT-115)', () => {
    const d = doc({ inv_type: 'final', items: [{ name: 'Projekt komplett', qty: 1, price_cents: 50000, tax_rate: 19 }], deductions: [prior] });
    const x = both(d);
    expect(d.deducted_cents).toBe(11900);
    expect(x.einvoice.totals).toMatchObject({ grand_cents: 59500, prepaid_cents: 11900, due_cents: 47600 });
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
    expect(x.cii).toContain('<ram:TotalPrepaidAmount>119.00</ram:TotalPrepaidAmount>');
    expect(x.cii).toContain('<ram:DuePayableAmount>476.00</ram:DuePayableAmount>');
    expect(x.ubl).toContain('<cbc:PrepaidAmount currencyID="EUR">119.00</cbc:PrepaidAmount>');
    expect(x.ubl).toContain('<cbc:PayableAmount currencyID="EUR">476.00</cbc:PayableAmount>');
    expect(x.ubl).toContain('<cbc:ID>RE-2026-0002</cbc:ID>');
    expect(x.einvoice.preceding).toEqual([{ number: 'RE-2026-0002', date: '2026-09-01' }]);
  });
});

describe('XRechnung: payment terms', () => {
  it('writes Skonto in the structured form of BT-20, and the validator checks that form', () => {
    const x = both(doc({ skonto: { percent: 2, days: 10 } }));
    expect(x.cii).toContain('#SKONTO#TAGE=10#PROZENT=2.00#BASISBETRAG=275.34#');
    expect(x.vc.errors).toEqual([]);
    expect(x.vu.errors).toEqual([]);
    const broken = x.cii.replace('#SKONTO#TAGE=10#PROZENT=2.00#BASISBETRAG=275.34#', '#SKONTO#TAGE=zehn#PROZENT=2#');
    expect(rules(validateEInvoice(broken))).toContain('BR-DE-18');
  });

  it('refuses to write a file that would be rejected: what is missing is listed in German', () => {
    const x = both(doc({ seller: { ...SELLER, phone: '', email: '', street: '' }, buyer: { ...BUYER, email: '' }, bank: { iban: '', bic: '', bank: '' } }));
    const msgs = x.problems.map((p) => p.message).join('\n');
    expect(msgs).toContain('Telefonnummer');
    expect(msgs).toContain('E-Mail');
    expect(msgs).toContain('Straße');
    expect(msgs).toContain('IBAN');
    expect(msgs).toContain('elektronische Adresse');
  });

  it('a Leitweg-ID is the buyer reference and, without an e-mail address, the buyer endpoint', () => {
    const x = both(doc({ buyer: { ...BUYER, email: '', leitweg_id: '04011000-1234512345-35' } }));
    expect(x.problems).toEqual([]);
    expect(x.cii).toContain('<ram:BuyerReference>04011000-1234512345-35</ram:BuyerReference>');
    expect(x.cii).toContain('<ram:URIID schemeID="0204">04011000-1234512345-35</ram:URIID>');
    expect(x.vc.errors).toEqual([]);
  });
});

describe('the rule set catches broken documents', () => {
  const good = both(doc());
  const mutate = (xml: string, from: string, to: string) => {
    expect(xml).toContain(from);
    return xml.replace(from, to);
  };

  it('sums: BR-CO-10, -13, -14, -15, -16 and the breakdown BR-CO-17', () => {
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:GrandTotalAmount>275.34', '<ram:GrandTotalAmount>275.35')))).toContain('BR-CO-15');
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:DuePayableAmount>275.34', '<ram:DuePayableAmount>270.00')))).toContain('BR-CO-16');
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:LineTotalAmount>234.90</ram:LineTotalAmount>\n        <ram:TaxBasisTotalAmount>', '<ram:LineTotalAmount>200.00</ram:LineTotalAmount>\n        <ram:TaxBasisTotalAmount>')))).toContain('BR-CO-10');
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:CalculatedAmount>38.00', '<ram:CalculatedAmount>37.00')))).toContain('BR-CO-17');
    expect(rules(validateEInvoice(mutate(good.ubl, '<cbc:TaxAmount currencyID="EUR">40.44</cbc:TaxAmount>\n    <cac:TaxSubtotal>', '<cbc:TaxAmount currencyID="EUR">41.00</cbc:TaxAmount>\n    <cac:TaxSubtotal>')))).toContain('BR-CO-14');
  });

  it('mandatory fields: BR-DE-6, BR-DE-7, BR-DE-15, BR-DE-19, BR-DE-21, PEPPOL endpoints', () => {
    expect(rules(validateEInvoice(mutate(good.cii, '+49 30 1234567', '')))).toContain('BR-DE-6');
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:URIID>rechnung@muster-beratung.example</ram:URIID>', '<ram:URIID>keine-adresse</ram:URIID>')))).toContain('BR-DE-28');
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:BuyerReference>RE-2026-0001</ram:BuyerReference>', '<ram:BuyerReference></ram:BuyerReference>')))).toContain('BR-DE-15');
    expect(rules(validateEInvoice(mutate(good.cii, 'DE02120300000000202051', 'DE02120300000000202052')))).toContain('BR-DE-19');
    expect(rules(validateEInvoice(mutate(good.cii, 'xrechnung_3.0', 'xrechnung_2.3')))).toContain('BR-DE-21');
    expect(rules(validateEInvoice(mutate(good.ubl, '<cbc:EndpointID schemeID="EM">einkauf@kunde.example</cbc:EndpointID>', '<cbc:EndpointID schemeID="EM"></cbc:EndpointID>')))).toContain('PEPPOL-EN16931-R010');
  });

  it('codes: type code, currency, VAT category without breakdown, wrong rate for the category', () => {
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:TypeCode>380</ram:TypeCode>', '<ram:TypeCode>999</ram:TypeCode>')))).toContain('BR-DE-17');
    expect(rules(validateEInvoice(mutate(good.cii, '<ram:InvoiceCurrencyCode>EUR', '<ram:InvoiceCurrencyCode>EURO')))).toContain('BR-05');
    const zeroS = good.ubl.replace(/<cbc:Percent>19\.00<\/cbc:Percent>/g, '<cbc:Percent>0.00</cbc:Percent>');
    expect(rules(validateEInvoice(zeroS))).toContain('BR-S-05');
  });

  it('structure: not XML, neither CII nor UBL, wrong namespace', () => {
    expect(validateEInvoice('das ist kein XML').valid).toBe(false);
    expect(validateEInvoice('<html><body/></html>')).toMatchObject({ valid: false, syntax: 'unknown' });
    const noNs = good.ubl.replace('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"', '');
    expect(rules(validateEInvoice(noNs))).toContain('XML-NS');
  });

  it('the EN 16931 profile skips the German additions', () => {
    const noPhone = mutateAll(good.cii, '+49 30 1234567', '');
    expect(validateEInvoice(noPhone, { profile: 'xrechnung' }).valid).toBe(false);
    expect(validateEInvoice(noPhone, { profile: 'en16931' }).errors.map((e) => e.rule)).not.toContain('BR-DE-6');
  });
});

function mutateAll(xml: string, from: string, to: string) {
  return xml.split(from).join(to);
}
