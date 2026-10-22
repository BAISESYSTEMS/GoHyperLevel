import { checkIban } from './invoice-model.js';
import { allAt, at, kids, parseXml, textAt, type XNode } from './xml-lite.js';

/**
 * An own validator for the EN 16931 business rules (BR-…, BR-CO-…, the VAT category rules BR-S/Z/E/AE/IC/G) and the
 * XRechnung 3.0 additions (BR-DE-…, PEPPOL endpoint rules) that matter for the invoices this app writes. It reads
 * the XML (CII or UBL) back into the semantic model and checks that – so it tests what is on the wire.
 *
 * It is NOT the official validator: no XML Schema, no code-list completeness, no Schematron. Before the first
 * productive e-invoice send it (and a few real invoices) should go through the KoSIT validator once.
 */

export interface Finding {
  rule: string;
  level: 'error' | 'warning';
  message: string;
}

interface Amount {
  /** Cents (rounded), null when the element is missing or not a number. */
  c: number | null;
  /** Decimals in the text. */
  dec: number;
  text: string;
}

interface SemParty {
  name: string;
  street: string;
  city: string;
  postal_code: string;
  country: string;
  vat_id: string;
  tax_reg: string;
  contact_name: string;
  phone: string;
  email: string;
  endpoint: string;
  endpoint_scheme: string;
  has_contact: boolean;
}

interface SemLine {
  id: string;
  name: string;
  qty: number | null;
  unit: string;
  price: Amount;
  net: Amount;
  category: string;
  rate: number | null;
}

interface SemGroup {
  category: string;
  rate: number | null;
  basis: Amount;
  tax: Amount;
  reason: string;
  reason_code: string;
}

export interface Sem {
  syntax: 'cii' | 'ubl';
  customization: string;
  profile: string;
  number: string;
  type_code: string;
  issue_date: string;
  due_date: string;
  currency: string;
  buyer_reference: string;
  payment_terms: string;
  delivery_date: string;
  period_start: string;
  period_end: string;
  seller: SemParty;
  buyer: SemParty;
  means: string;
  iban: string;
  lines: SemLine[];
  groups: SemGroup[];
  totals: { line: Amount; allowance: Amount; charge: Amount; basis: Amount; tax: Amount; grand: Amount; prepaid: Amount; rounding: Amount; due: Amount };
  preceding: { number: string; date: string }[];
}

export interface ValidationResult {
  valid: boolean;
  syntax: 'cii' | 'ubl' | 'unknown';
  type_code: string;
  errors: Finding[];
  warnings: Finding[];
  sem?: Sem;
}

const amount = (text: string): Amount => {
  const t = String(text ?? '').trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { c: null, dec: 0, text: t };
  return { c: Math.round(Number(t) * 100), dec: (t.split('.')[1] ?? '').length, text: t };
};
const numOf = (text: string): number | null => (/^-?\d+(\.\d+)?$/.test(String(text ?? '').trim()) ? Number(String(text).trim()) : null);

/** `20261005` (CII format 102) or `2026-10-05` (UBL) → `2026-10-05`; anything else is returned as is. */
const normDate = (s: string): string => {
  const t = String(s ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : t;
};
const validYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function ciiParty(p: XNode | undefined): SemParty {
  const regs = allAt(p, 'SpecifiedTaxRegistration/ID');
  const contact = at(p, 'DefinedTradeContact');
  return {
    name: textAt(p, 'Name'),
    street: textAt(p, 'PostalTradeAddress/LineOne'),
    city: textAt(p, 'PostalTradeAddress/CityName'),
    postal_code: textAt(p, 'PostalTradeAddress/PostcodeCode'),
    country: textAt(p, 'PostalTradeAddress/CountryID'),
    vat_id: regs.find((n) => n.attrs.schemeID === 'VA')?.text.trim() ?? '',
    tax_reg: regs.find((n) => n.attrs.schemeID === 'FC')?.text.trim() ?? '',
    contact_name: textAt(contact, 'PersonName'),
    phone: textAt(contact, 'TelephoneUniversalCommunication/CompleteNumber'),
    email: textAt(contact, 'EmailURIUniversalCommunication/URIID'),
    endpoint: textAt(p, 'URIUniversalCommunication/URIID'),
    endpoint_scheme: at(p, 'URIUniversalCommunication/URIID')?.attrs.schemeID ?? '',
    has_contact: !!contact,
  };
}

function ublParty(p: XNode | undefined): SemParty {
  const schemes = allAt(p, 'PartyTaxScheme');
  const contact = at(p, 'Contact');
  const scheme = (n: XNode) => textAt(n, 'TaxScheme/ID');
  return {
    name: textAt(p, 'PartyLegalEntity/RegistrationName') || textAt(p, 'PartyName/Name'),
    street: textAt(p, 'PostalAddress/StreetName'),
    city: textAt(p, 'PostalAddress/CityName'),
    postal_code: textAt(p, 'PostalAddress/PostalZone'),
    country: textAt(p, 'PostalAddress/Country/IdentificationCode'),
    vat_id: textAt(schemes.find((n) => scheme(n) === 'VAT'), 'CompanyID'),
    tax_reg: textAt(schemes.find((n) => scheme(n) !== 'VAT'), 'CompanyID'),
    contact_name: textAt(contact, 'Name'),
    phone: textAt(contact, 'Telephone'),
    email: textAt(contact, 'ElectronicMail'),
    endpoint: textAt(p, 'EndpointID'),
    endpoint_scheme: at(p, 'EndpointID')?.attrs.schemeID ?? '',
    has_contact: !!contact,
  };
}

function extractCii(root: XNode): Sem {
  const trade = at(root, 'SupplyChainTradeTransaction');
  const agree = at(trade, 'ApplicableHeaderTradeAgreement');
  const settle = at(trade, 'ApplicableHeaderTradeSettlement');
  const sum = at(settle, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const terms = at(settle, 'SpecifiedTradePaymentTerms');
  return {
    syntax: 'cii',
    customization: textAt(root, 'ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID'),
    profile: textAt(root, 'ExchangedDocumentContext/BusinessProcessSpecifiedDocumentContextParameter/ID'),
    number: textAt(root, 'ExchangedDocument/ID'),
    type_code: textAt(root, 'ExchangedDocument/TypeCode'),
    issue_date: normDate(textAt(root, 'ExchangedDocument/IssueDateTime/DateTimeString')),
    due_date: normDate(textAt(terms, 'DueDateDateTime/DateTimeString')),
    currency: textAt(settle, 'InvoiceCurrencyCode'),
    buyer_reference: textAt(agree, 'BuyerReference'),
    payment_terms: textAt(terms, 'Description'),
    delivery_date: normDate(textAt(trade, 'ApplicableHeaderTradeDelivery/ActualDeliverySupplyChainEvent/OccurrenceDateTime/DateTimeString')),
    period_start: normDate(textAt(settle, 'BillingSpecifiedPeriod/StartDateTime/DateTimeString')),
    period_end: normDate(textAt(settle, 'BillingSpecifiedPeriod/EndDateTime/DateTimeString')),
    seller: ciiParty(at(agree, 'SellerTradeParty')),
    buyer: ciiParty(at(agree, 'BuyerTradeParty')),
    means: textAt(settle, 'SpecifiedTradeSettlementPaymentMeans/TypeCode'),
    iban: textAt(settle, 'SpecifiedTradeSettlementPaymentMeans/PayeePartyCreditorFinancialAccount/IBANID'),
    lines: kids(trade, 'IncludedSupplyChainTradeLineItem').map((l) => ({
      id: textAt(l, 'AssociatedDocumentLineDocument/LineID'),
      name: textAt(l, 'SpecifiedTradeProduct/Name'),
      qty: numOf(textAt(l, 'SpecifiedLineTradeDelivery/BilledQuantity')),
      unit: at(l, 'SpecifiedLineTradeDelivery/BilledQuantity')?.attrs.unitCode ?? '',
      price: amount(textAt(l, 'SpecifiedLineTradeAgreement/NetPriceProductTradePrice/ChargeAmount')),
      net: amount(textAt(l, 'SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount')),
      category: textAt(l, 'SpecifiedLineTradeSettlement/ApplicableTradeTax/CategoryCode'),
      rate: numOf(textAt(l, 'SpecifiedLineTradeSettlement/ApplicableTradeTax/RateApplicablePercent')),
    })),
    groups: allAt(settle, 'ApplicableTradeTax').map((g) => ({
      category: textAt(g, 'CategoryCode'),
      rate: numOf(textAt(g, 'RateApplicablePercent')),
      basis: amount(textAt(g, 'BasisAmount')),
      tax: amount(textAt(g, 'CalculatedAmount')),
      reason: textAt(g, 'ExemptionReason'),
      reason_code: textAt(g, 'ExemptionReasonCode'),
    })),
    totals: {
      line: amount(textAt(sum, 'LineTotalAmount')),
      allowance: amount(textAt(sum, 'AllowanceTotalAmount')),
      charge: amount(textAt(sum, 'ChargeTotalAmount')),
      basis: amount(textAt(sum, 'TaxBasisTotalAmount')),
      tax: amount(textAt(sum, 'TaxTotalAmount')),
      grand: amount(textAt(sum, 'GrandTotalAmount')),
      prepaid: amount(textAt(sum, 'TotalPrepaidAmount')),
      rounding: amount(textAt(sum, 'RoundingAmount')),
      due: amount(textAt(sum, 'DuePayableAmount')),
    },
    preceding: allAt(settle, 'InvoiceReferencedDocument').map((r) => ({ number: textAt(r, 'IssuerAssignedID'), date: normDate(textAt(r, 'FormattedIssueDateTime/DateTimeString')) })),
  };
}

function extractUbl(root: XNode): Sem {
  const credit = root.name === 'CreditNote';
  const lineName = credit ? 'CreditNoteLine' : 'InvoiceLine';
  const lm = at(root, 'LegalMonetaryTotal');
  return {
    syntax: 'ubl',
    customization: textAt(root, 'CustomizationID'),
    profile: textAt(root, 'ProfileID'),
    number: textAt(root, 'ID'),
    type_code: textAt(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'),
    issue_date: textAt(root, 'IssueDate'),
    due_date: textAt(root, 'DueDate') || textAt(root, 'PaymentMeans/PaymentDueDate'),
    currency: textAt(root, 'DocumentCurrencyCode'),
    buyer_reference: textAt(root, 'BuyerReference'),
    payment_terms: textAt(root, 'PaymentTerms/Note'),
    delivery_date: textAt(root, 'Delivery/ActualDeliveryDate'),
    period_start: textAt(root, 'InvoicePeriod/StartDate'),
    period_end: textAt(root, 'InvoicePeriod/EndDate'),
    seller: ublParty(at(root, 'AccountingSupplierParty/Party')),
    buyer: ublParty(at(root, 'AccountingCustomerParty/Party')),
    means: textAt(root, 'PaymentMeans/PaymentMeansCode'),
    iban: textAt(root, 'PaymentMeans/PayeeFinancialAccount/ID'),
    lines: kids(root, lineName).map((l) => ({
      id: textAt(l, 'ID'),
      name: textAt(l, 'Item/Name'),
      qty: numOf(textAt(l, credit ? 'CreditedQuantity' : 'InvoicedQuantity')),
      unit: at(l, credit ? 'CreditedQuantity' : 'InvoicedQuantity')?.attrs.unitCode ?? '',
      price: amount(textAt(l, 'Price/PriceAmount')),
      net: amount(textAt(l, 'LineExtensionAmount')),
      category: textAt(l, 'Item/ClassifiedTaxCategory/ID'),
      rate: numOf(textAt(l, 'Item/ClassifiedTaxCategory/Percent')),
    })),
    groups: allAt(root, 'TaxTotal/TaxSubtotal').map((g) => ({
      category: textAt(g, 'TaxCategory/ID'),
      rate: numOf(textAt(g, 'TaxCategory/Percent')),
      basis: amount(textAt(g, 'TaxableAmount')),
      tax: amount(textAt(g, 'TaxAmount')),
      reason: textAt(g, 'TaxCategory/TaxExemptionReason'),
      reason_code: textAt(g, 'TaxCategory/TaxExemptionReasonCode'),
    })),
    totals: {
      line: amount(textAt(lm, 'LineExtensionAmount')),
      allowance: amount(textAt(lm, 'AllowanceTotalAmount')),
      charge: amount(textAt(lm, 'ChargeTotalAmount')),
      basis: amount(textAt(lm, 'TaxExclusiveAmount')),
      tax: amount(textAt(root, 'TaxTotal/TaxAmount')),
      grand: amount(textAt(lm, 'TaxInclusiveAmount')),
      prepaid: amount(textAt(lm, 'PrepaidAmount')),
      rounding: amount(textAt(lm, 'PayableRoundingAmount')),
      due: amount(textAt(lm, 'PayableAmount')),
    },
    preceding: allAt(root, 'BillingReference/InvoiceDocumentReference').map((r) => ({ number: textAt(r, 'ID'), date: textAt(r, 'IssueDate') })),
  };
}

const TYPE_CODES = new Set(['326', '380', '381', '384', '389', '875', '876', '877']);
const CATEGORIES = new Set(['S', 'Z', 'E', 'AE', 'K', 'G', 'L', 'M', 'O']);
const XRECHNUNG_ID = /^urn:cen\.eu:en16931:2017#(compliant#urn:xeinkauf\.de:kosit:xrechnung_3\.\d+|conformant#urn:xeinkauf\.de:kosit:extension:xrechnung_3\.\d+)$/;
const NS_CII = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';
const NS_UBL: Record<string, string> = { Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2', CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' };

/** Tax on a taxable amount, rounded half away from zero – the same maths the generator uses. */
const vat = (basis: number, rate: number): number => Math.sign(basis) * Math.floor((Math.abs(basis) * Math.round(rate * 100) + 5000) / 10000);

export function validateEInvoice(xml: string, opts: { profile?: 'xrechnung' | 'en16931' } = {}): ValidationResult {
  const profile = opts.profile ?? 'xrechnung';
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const err = (rule: string, message: string) => errors.push({ rule, level: 'error', message });
  const warn = (rule: string, message: string) => warnings.push({ rule, level: 'warning', message });
  const fail = (message: string): ValidationResult => ({ valid: false, syntax: 'unknown', type_code: '', errors: [{ rule: 'XML', level: 'error', message }], warnings });

  let root: XNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    return fail(`Kein lesbares XML: ${(e as Error).message}`);
  }
  let sem: Sem;
  if (root.name === 'CrossIndustryInvoice') {
    if (!new RegExp(`<[\\w:]*CrossIndustryInvoice[^>]*xmlns(:\\w+)?="${NS_CII}"`).test(xml.slice(0, 4000))) err('XML-NS', 'Der Namensraum der CrossIndustryInvoice (…CrossIndustryInvoice:100) fehlt');
    sem = extractCii(root);
  } else if (root.name === 'Invoice' || root.name === 'CreditNote') {
    if (!xml.slice(0, 4000).includes(`xmlns="${NS_UBL[root.name]}"`)) err('XML-NS', `Der Namensraum von ${root.name} (${NS_UBL[root.name]}) fehlt`);
    sem = extractUbl(root);
  } else return fail('Weder CII (CrossIndustryInvoice) noch UBL (Invoice / CreditNote)');

  // --- document level ------------------------------------------------------------------------------------------------------------
  if (!sem.customization) err('BR-01', 'Spezifikationskennung (BT-24) fehlt');
  else if (profile === 'xrechnung' && !XRECHNUNG_ID.test(sem.customization)) err('BR-DE-21', `Spezifikationskennung muss die von XRechnung 3.x sein, ist aber „${sem.customization}“`);
  if (profile === 'xrechnung' && !sem.profile) err('PEPPOL-EN16931-R001', 'Prozesskennung (BT-23) fehlt');
  if (!sem.number) err('BR-02', 'Rechnungsnummer (BT-1) fehlt');
  if (!sem.issue_date) err('BR-03', 'Rechnungsdatum (BT-2) fehlt');
  else if (!validYmd(sem.issue_date)) err('BR-03', `Rechnungsdatum (BT-2) „${sem.issue_date}“ ist kein gültiges Datum`);
  if (sem.due_date && !validYmd(sem.due_date)) err('BR-03', `Fälligkeitsdatum (BT-9) „${sem.due_date}“ ist kein gültiges Datum`);
  if (!sem.type_code) err('BR-04', 'Rechnungstyp (BT-3) fehlt');
  else if (profile === 'xrechnung' && !TYPE_CODES.has(sem.type_code)) err('BR-DE-17', `Rechnungstyp ${sem.type_code} ist bei XRechnung nicht erlaubt (326, 380, 381, 384, 389, 875, 876, 877)`);
  if (!/^[A-Z]{3}$/.test(sem.currency)) err('BR-05', 'Währung (BT-5) fehlt oder ist kein 3-Buchstaben-Code');
  if (profile === 'xrechnung' && !sem.buyer_reference) err('BR-DE-15', 'Käuferreferenz (BT-10: Leitweg-ID oder Kundenreferenz) fehlt');

  // --- parties ---------------------------------------------------------------------------------------------------------------------
  const party = (p: SemParty, who: 'Verkäufer' | 'Käufer', nums: { name: string; addr: string; ctry: string }) => {
    if (!p.name) err(nums.name, `${who}: Name fehlt`);
    if (!p.country) err(nums.ctry, `${who}: Ländercode der Anschrift fehlt`);
    else if (!/^[A-Z]{2}$/.test(p.country)) err(nums.ctry, `${who}: Ländercode „${p.country}“ ist kein ISO-3166-Code`);
    if (profile === 'xrechnung') {
      if (!p.city) err(who === 'Verkäufer' ? 'BR-DE-3' : 'BR-DE-8', `${who}: Ort fehlt`);
      if (!p.postal_code) err(who === 'Verkäufer' ? 'BR-DE-4' : 'BR-DE-9', `${who}: Postleitzahl fehlt`);
    }
    if (!p.endpoint) err(who === 'Verkäufer' ? 'PEPPOL-EN16931-R020' : 'PEPPOL-EN16931-R010', `${who}: elektronische Adresse (${who === 'Verkäufer' ? 'BT-34' : 'BT-49'}) fehlt`);
    if (p.vat_id && !/^[A-Z]{2}/.test(p.vat_id)) err('BR-CO-09', `${who}: die USt-IdNr. muss mit dem Ländercode beginnen`);
  };
  party(sem.seller, 'Verkäufer', { name: 'BR-06', addr: 'BR-08', ctry: 'BR-09' });
  party(sem.buyer, 'Käufer', { name: 'BR-07', addr: 'BR-10', ctry: 'BR-11' });
  if (profile === 'xrechnung') {
    if (!sem.seller.has_contact) err('BR-DE-2', 'Verkäufer: Kontaktangaben (BG-6) fehlen');
    else {
      if (!sem.seller.contact_name) err('BR-DE-5', 'Verkäufer: Name des Ansprechpartners (BT-41) fehlt');
      if (!sem.seller.phone) err('BR-DE-6', 'Verkäufer: Telefonnummer (BT-42) fehlt');
      else if ((sem.seller.phone.match(/\d/g) ?? []).length < 3) err('BR-DE-27', 'Verkäufer: die Telefonnummer muss mindestens drei Ziffern haben');
      if (!sem.seller.email) err('BR-DE-7', 'Verkäufer: E-Mail-Adresse (BT-43) fehlt');
      else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sem.seller.email)) err('BR-DE-28', 'Verkäufer: die E-Mail-Adresse braucht ein @ und einen Punkt dahinter');
    }
  }
  if (!sem.seller.vat_id && !sem.seller.tax_reg) {
    if (profile === 'xrechnung') err('BR-DE-16', 'Verkäufer: USt-IdNr. (BT-31) oder Steuernummer (BT-32) fehlt');
    else err('BR-CO-26', 'Verkäufer: Kennung (BT-29/BT-30/BT-31) fehlt');
  }

  // --- payment ---------------------------------------------------------------------------------------------------------------------
  if (profile === 'xrechnung' && !sem.means) err('BR-DE-1', 'Zahlungsanweisung (BG-16) fehlt');
  if (['30', '58'].includes(sem.means)) {
    if (!sem.iban) err('BR-DE-23', 'Bei Überweisung (30/58) fehlt die IBAN (BT-84)');
    else if (sem.means === '58' && !checkIban(sem.iban)) err('BR-DE-19', `Die IBAN „${sem.iban}“ ist ungültig (BT-84)`);
  }
  for (const line of sem.payment_terms.split('\n').filter((l) => l.startsWith('#SKONTO#') || l.startsWith('#VERZUG#'))) {
    if (!/^#(SKONTO|VERZUG)#TAGE=\d+#PROZENT=\d+\.\d{2}#(BASISBETRAG=\d+\.\d{2}#)?$/.test(line)) err('BR-DE-18', `Skonto-Angabe in den Zahlungsbedingungen (BT-20) hat nicht das vorgeschriebene Format: ${line.slice(0, 80)}`);
  }

  // --- lines ------------------------------------------------------------------------------------------------------------------------
  if (!sem.lines.length) err('BR-16', 'Mindestens eine Rechnungsposition (BG-25) nötig');
  const money = (a: Amount, where: string) => {
    if (a.c !== null && a.dec > 2) err('BR-DEC', `${where}: höchstens zwei Nachkommastellen (hier „${a.text}“)`);
  };
  let lineSum = 0;
  for (const l of sem.lines) {
    const w = `Position ${l.id || '?'}`;
    if (!l.id) err('BR-21', `${w}: Positionskennung (BT-126) fehlt`);
    if (l.qty === null) err('BR-22', `${w}: Menge (BT-129) fehlt`);
    if (!l.unit) err('BR-23', `${w}: Mengeneinheit (BT-130) fehlt`);
    if (l.net.c === null) err('BR-24', `${w}: Positionsbetrag (BT-131) fehlt`);
    if (!l.name) err('BR-25', `${w}: Artikelname (BT-153) fehlt`);
    if (l.price.c === null) err('BR-26', `${w}: Nettopreis (BT-146) fehlt`);
    else if (l.price.c < 0) err('BR-27', `${w}: der Nettopreis (BT-146) darf nicht negativ sein`);
    if (!l.category) err('BR-CO-04', `${w}: Umsatzsteuerkategorie (BT-151) fehlt`);
    else if (!CATEGORIES.has(l.category)) err('BR-CO-04', `${w}: Umsatzsteuerkategorie „${l.category}“ ist unbekannt`);
    money(l.net, `${w}: Positionsbetrag`);
    money(l.price, `${w}: Nettopreis`);
    if (l.net.c !== null) lineSum += l.net.c;
    // BR-CO-10-related: the line amount is quantity × price (± one cent of rounding).
    if (l.qty !== null && l.price.c !== null && l.net.c !== null) {
      const expect = Math.round(l.qty * l.price.c);
      if (Math.abs(expect - l.net.c) > 1) err('BR-CO-10', `${w}: Menge × Preis (${(expect / 100).toFixed(2)}) ergibt nicht den Positionsbetrag (${l.net.text})`);
    }
    if (l.category === 'S' && !(l.rate !== null && l.rate > 0)) err('BR-S-05', `${w}: bei Kategorie S muss der Steuersatz größer als 0 sein`);
    if (['Z', 'E', 'AE', 'K', 'G'].includes(l.category) && l.rate !== 0) err(`BR-${ruleKey(l.category)}-05`, `${w}: bei Kategorie ${l.category} muss der Steuersatz 0 sein`);
  }

  // --- totals ------------------------------------------------------------------------------------------------------------------------
  const t = sem.totals;
  for (const [k, label] of [['line', 'Summe Positionen (BT-106)'], ['basis', 'Gesamtbetrag ohne USt (BT-109)'], ['tax', 'USt-Gesamtbetrag (BT-110)'], ['grand', 'Gesamtbetrag mit USt (BT-112)'], ['due', 'Fälliger Betrag (BT-115)']] as const) {
    if (t[k].c === null) err(k === 'line' ? 'BR-12' : k === 'basis' ? 'BR-13' : k === 'grand' ? 'BR-14' : k === 'due' ? 'BR-15' : 'BR-CO-14', `${label} fehlt`);
    money(t[k], label);
  }
  const c = (a: Amount) => a.c ?? 0;
  if (t.line.c !== null && t.line.c !== lineSum) err('BR-CO-10', `Summe der Positionen (BT-106 = ${t.line.text}) ≠ Summe der Positionsbeträge (${(lineSum / 100).toFixed(2)})`);
  if (t.basis.c !== null && t.line.c !== null && t.basis.c !== c(t.line) - c(t.allowance) + c(t.charge)) err('BR-CO-13', `Gesamtbetrag ohne USt (BT-109 = ${t.basis.text}) ≠ Positionen − Nachlässe + Zuschläge`);
  const taxSum = sem.groups.reduce((n, g) => n + c(g.tax), 0);
  if (t.tax.c !== null && t.tax.c !== taxSum) err('BR-CO-14', `USt-Gesamtbetrag (BT-110 = ${t.tax.text}) ≠ Summe der Steuerbeträge je Kategorie (${(taxSum / 100).toFixed(2)})`);
  if (t.grand.c !== null && t.basis.c !== null && t.tax.c !== null && t.grand.c !== t.basis.c + t.tax.c) err('BR-CO-15', `Gesamtbetrag mit USt (BT-112 = ${t.grand.text}) ≠ ohne USt + USt (${((t.basis.c + t.tax.c) / 100).toFixed(2)})`);
  if (t.due.c !== null && t.grand.c !== null && t.due.c !== t.grand.c - c(t.prepaid) + c(t.rounding)) err('BR-CO-16', `Fälliger Betrag (BT-115 = ${t.due.text}) ≠ Gesamtbetrag − Anzahlungen + Rundung (${((t.grand.c - c(t.prepaid) + c(t.rounding)) / 100).toFixed(2)})`);
  if (sem.type_code === '381' && [t.line, t.grand, t.due].some((a) => (a.c ?? 0) < 0)) warn('EN-381', 'Bei einer Gutschrift (Typ 381) stehen die Beträge positiv – hier sind sie negativ');

  // --- VAT breakdown ---------------------------------------------------------------------------------------------------------------
  if (!sem.groups.length) err('BR-CO-18', 'Mindestens eine Umsatzsteueraufschlüsselung (BG-23) nötig');
  const sellerId = !!(sem.seller.vat_id || sem.seller.tax_reg);
  const buyerId = !!sem.buyer.vat_id;
  const cats = new Set<string>();
  for (const g of sem.groups) {
    const k = ruleKey(g.category);
    const w = `Aufschlüsselung ${g.category} ${g.rate ?? '?'} %`;
    cats.add(g.category);
    if (!g.category) err('BR-CO-04', `${w}: Kategorie (BT-118) fehlt`);
    if (g.basis.c === null) err(`BR-${k}-08`, `${w}: steuerpflichtiger Betrag (BT-116) fehlt`);
    if (g.tax.c === null) err(`BR-${k}-09`, `${w}: Steuerbetrag (BT-117) fehlt`);
    if (g.rate === null) err('BR-48', `${w}: Steuersatz (BT-119) fehlt`);
    money(g.basis, `${w}: steuerpflichtiger Betrag`);
    money(g.tax, `${w}: Steuerbetrag`);
    // Taxable amount = lines of the same category and rate (BR-S-08 and its siblings).
    const lines = sem.lines.filter((l) => l.category === g.category && (l.rate ?? 0) === (g.rate ?? 0));
    const sumLines = lines.reduce((n, l) => n + c(l.net), 0);
    if (g.basis.c !== null && g.basis.c !== sumLines) err(`BR-${k}-08`, `${w}: steuerpflichtiger Betrag (${g.basis.text}) ≠ Summe der Positionen dieser Kategorie (${(sumLines / 100).toFixed(2)})`);
    // Tax = taxable amount × rate (BR-CO-17); categories without tax must show 0.
    if (g.basis.c !== null && g.tax.c !== null && g.rate !== null) {
      const want = g.category === 'S' ? vat(g.basis.c, g.rate) : 0;
      if (g.tax.c !== want) err(g.category === 'S' ? 'BR-CO-17' : `BR-${k}-09`, `${w}: Steuerbetrag ${g.tax.text} – erwartet ${(want / 100).toFixed(2)} (steuerpflichtiger Betrag × Satz, kaufmännisch gerundet)`);
    }
    if (['E', 'AE', 'K', 'G'].includes(g.category) && !g.reason && !g.reason_code) err(`BR-${k}-10`, `${w}: Befreiungsgrund (BT-120 Text oder BT-121 Code) fehlt`);
    if (['S', 'Z'].includes(g.category) && (g.reason || g.reason_code)) err(`BR-${k}-10`, `${w}: bei Kategorie ${g.category} darf kein Befreiungsgrund stehen`);
    if (g.category === 'AE' && !(sellerId && buyerId)) err('BR-AE-02', `${w}: Reverse Charge braucht die USt-IdNr. des Verkäufers (BT-31/32) und des Käufers (BT-48)`);
    if (g.category === 'K') {
      if (!(sem.seller.vat_id && buyerId)) err('BR-IC-02', `${w}: innergemeinschaftliche Lieferung braucht die USt-IdNr. von Verkäufer (BT-31) und Käufer (BT-48)`);
      if (!sem.delivery_date && !sem.period_start) err('BR-IC-11', `${w}: Lieferdatum (BT-72) oder Leistungszeitraum (BG-14) fehlt`);
    }
    if (g.category === 'G' && !sem.seller.vat_id) err('BR-G-02', `${w}: Ausfuhrlieferung braucht die USt-IdNr. des Verkäufers (BT-31)`);
    if (g.category === 'E' && !sellerId) err('BR-E-02', `${w}: steuerbefreite Leistung braucht die USt-IdNr. oder Steuernummer des Verkäufers`);
  }
  // Every category used by a line has a breakdown (BR-S-01 …).
  for (const l of sem.lines) if (l.category && !sem.groups.some((g) => g.category === l.category && (g.rate ?? 0) === (l.rate ?? 0))) err(`BR-${ruleKey(l.category)}-01`, `Position ${l.id}: Kategorie ${l.category} (${l.rate ?? 0} %) fehlt in der Aufschlüsselung`);
  if (cats.has('AE') && cats.size > 1 && [...cats].some((x) => x !== 'AE')) warn('BR-AE', 'Reverse Charge zusammen mit anderen Steuerkategorien auf einer Rechnung – bitte prüfen');

  // --- dates and periods --------------------------------------------------------------------------------------------------------------
  if (sem.period_start || sem.period_end) {
    if (sem.period_start && !validYmd(sem.period_start)) err('BR-CO-19', 'Beginn des Rechnungszeitraums (BT-73) ist kein gültiges Datum');
    if (sem.period_end && !validYmd(sem.period_end)) err('BR-CO-19', 'Ende des Rechnungszeitraums (BT-74) ist kein gültiges Datum');
    if (sem.period_start && sem.period_end && sem.period_end < sem.period_start) err('BR-29', 'Das Ende des Rechnungszeitraums liegt vor dem Beginn');
    if (!sem.period_start || !sem.period_end) err('BR-CO-19', 'Rechnungszeitraum: Beginn und Ende (BT-73, BT-74) gehören zusammen');
  }
  if (sem.delivery_date && !validYmd(sem.delivery_date)) err('BR-03', 'Lieferdatum (BT-72) ist kein gültiges Datum');
  if ((t.due.c ?? 0) > 0 && !sem.due_date && !sem.payment_terms) err('BR-CO-25', 'Bei einem offenen Betrag müssen Fälligkeitsdatum (BT-9) oder Zahlungsbedingungen (BT-20) stehen');
  for (const p of sem.preceding) if (!p.number) err('BR-55', 'Verweis auf eine vorangegangene Rechnung ohne Rechnungsnummer (BT-25)');

  const valid = errors.length === 0;
  return { valid, syntax: sem.syntax, type_code: sem.type_code, errors, warnings, sem };
}

/** The key the rule ids use for a VAT category: BR-S-…, BR-Z-…, BR-E-…, BR-AE-…, BR-IC-… (K), BR-G-… */
function ruleKey(category: string): string {
  return category === 'K' ? 'IC' : category || 'S';
}

