import { amt, qtyText, rate2, xmlEsc as x, type EInvoice, type EParty } from './einvoice-model.js';

/**
 * OASIS UBL 2.1 in the XRechnung 3.0 / EN 16931 (Peppol BIS Billing 3.0) form: `Invoice` for 380 and 326,
 * `CreditNote` for 381. Element order follows the UBL schema sequence.
 */

function party(p: EParty, seller: boolean): string {
  const regs = [
    p.vat_id ? `\n        <cac:PartyTaxScheme>\n          <cbc:CompanyID>${x(p.vat_id)}</cbc:CompanyID>\n          <cac:TaxScheme>\n            <cbc:ID>VAT</cbc:ID>\n          </cac:TaxScheme>\n        </cac:PartyTaxScheme>` : '',
    p.tax_number ? `\n        <cac:PartyTaxScheme>\n          <cbc:CompanyID>${x(p.tax_number)}</cbc:CompanyID>\n          <cac:TaxScheme>\n            <cbc:ID>TAX</cbc:ID>\n          </cac:TaxScheme>\n        </cac:PartyTaxScheme>` : '',
  ].join('');
  const contact =
    seller || p.contact_name
      ? `\n        <cac:Contact>${p.contact_name ? `\n          <cbc:Name>${x(p.contact_name)}</cbc:Name>` : ''}${p.phone ? `\n          <cbc:Telephone>${x(p.phone)}</cbc:Telephone>` : ''}${p.email && seller ? `\n          <cbc:ElectronicMail>${x(p.email)}</cbc:ElectronicMail>` : ''}\n        </cac:Contact>`
      : '';
  return `<cac:Party>
        <cbc:EndpointID schemeID="${x(p.endpoint_scheme)}">${x(p.endpoint)}</cbc:EndpointID>
        <cac:PartyName>
          <cbc:Name>${x(p.name)}</cbc:Name>
        </cac:PartyName>
        <cac:PostalAddress>
          <cbc:StreetName>${x(p.street)}</cbc:StreetName>
          <cbc:CityName>${x(p.city)}</cbc:CityName>
          <cbc:PostalZone>${x(p.postal_code)}</cbc:PostalZone>
          <cac:Country>
            <cbc:IdentificationCode>${x(p.country)}</cbc:IdentificationCode>
          </cac:Country>
        </cac:PostalAddress>${regs}
        <cac:PartyLegalEntity>
          <cbc:RegistrationName>${x(p.name)}</cbc:RegistrationName>
        </cac:PartyLegalEntity>${contact}
      </cac:Party>`;
}

export function ublXml(e: EInvoice): string {
  const credit = e.type_code === '381';
  const root = credit ? 'CreditNote' : 'Invoice';
  const ns = credit ? 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2' : 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
  const cur = x(e.currency);
  const money = (tag: string, cents: number, ind = '') => `${ind}<cbc:${tag} currencyID="${cur}">${amt(cents)}</cbc:${tag}>`;
  const notes = e.notes.map((n) => `\n  <cbc:Note>${x(n)}</cbc:Note>`).join('');
  const period = e.period_start ? `\n  <cac:InvoicePeriod>\n    <cbc:StartDate>${e.period_start}</cbc:StartDate>\n    <cbc:EndDate>${e.period_end}</cbc:EndDate>\n  </cac:InvoicePeriod>` : '';
  const refs = e.preceding.map((p) => `\n  <cac:BillingReference>\n    <cac:InvoiceDocumentReference>\n      <cbc:ID>${x(p.number)}</cbc:ID>\n      <cbc:IssueDate>${p.date}</cbc:IssueDate>\n    </cac:InvoiceDocumentReference>\n  </cac:BillingReference>`).join('');
  const delivery = e.supply_date ? `\n  <cac:Delivery>\n    <cbc:ActualDeliveryDate>${e.supply_date}</cbc:ActualDeliveryDate>\n  </cac:Delivery>` : '';
  // A credit note has no DueDate element: the date goes into the payment means.
  const means = `
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>${e.payment.means_code}</cbc:PaymentMeansCode>${credit && e.due_date ? `\n    <cbc:PaymentDueDate>${e.due_date}</cbc:PaymentDueDate>` : ''}
    <cbc:PaymentID>${x(e.payment.remittance)}</cbc:PaymentID>
    <cac:PayeeFinancialAccount>
      <cbc:ID>${x(e.payment.iban)}</cbc:ID>${e.payment.bic ? `\n      <cac:FinancialInstitutionBranch>\n        <cbc:ID>${x(e.payment.bic)}</cbc:ID>\n      </cac:FinancialInstitutionBranch>` : ''}
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>`;
  const terms = e.payment_terms ? `\n  <cac:PaymentTerms>\n    <cbc:Note>${x(e.payment_terms)}</cbc:Note>\n  </cac:PaymentTerms>` : '';
  const sub = e.groups
    .map(
      (g) => `
    <cac:TaxSubtotal>
${money('TaxableAmount', g.basis_cents, '      ')}
${money('TaxAmount', g.tax_cents, '      ')}
      <cac:TaxCategory>
        <cbc:ID>${g.category}</cbc:ID>
        <cbc:Percent>${rate2(g.rate)}</cbc:Percent>${g.reason_code ? `\n        <cbc:TaxExemptionReasonCode>${x(g.reason_code)}</cbc:TaxExemptionReasonCode>` : ''}${g.reason ? `\n        <cbc:TaxExemptionReason>${x(g.reason)}</cbc:TaxExemptionReason>` : ''}
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join('');
  const t = e.totals;
  const lines = e.lines
    .map(
      (l) => `
  <cac:${credit ? 'CreditNoteLine' : 'InvoiceLine'}>
    <cbc:ID>${x(l.id)}</cbc:ID>
    <cbc:${credit ? 'CreditedQuantity' : 'InvoicedQuantity'} unitCode="${x(l.unit)}">${qtyText(l.qty)}</cbc:${credit ? 'CreditedQuantity' : 'InvoicedQuantity'}>
${money('LineExtensionAmount', l.net_cents, '    ')}
    <cac:Item>${l.description ? `\n      <cbc:Description>${x(l.description)}</cbc:Description>` : ''}
      <cbc:Name>${x(l.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${l.category}</cbc:ID>
        <cbc:Percent>${rate2(l.rate)}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
${money('PriceAmount', l.price_cents, '      ')}
    </cac:Price>
  </cac:${credit ? 'CreditNoteLine' : 'InvoiceLine'}>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="${ns}" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${x(e.customization)}</cbc:CustomizationID>
  <cbc:ProfileID>${x(e.profile)}</cbc:ProfileID>
  <cbc:ID>${x(e.number)}</cbc:ID>
  <cbc:IssueDate>${e.issue_date}</cbc:IssueDate>${!credit && e.due_date ? `\n  <cbc:DueDate>${e.due_date}</cbc:DueDate>` : ''}
  <cbc:${credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${e.type_code}</cbc:${credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${notes}
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>${x(e.buyer_reference)}</cbc:BuyerReference>${period}${refs}
  <cac:AccountingSupplierParty>
      ${party(e.seller, true)}
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
      ${party(e.buyer, false)}
  </cac:AccountingCustomerParty>${delivery}${means}${terms}
  <cac:TaxTotal>
${money('TaxAmount', t.tax_cents, '    ')}${sub}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
${money('LineExtensionAmount', t.line_cents, '    ')}
${money('TaxExclusiveAmount', t.basis_cents, '    ')}
${money('TaxInclusiveAmount', t.grand_cents, '    ')}${t.prepaid_cents ? `\n${money('PrepaidAmount', t.prepaid_cents, '    ')}` : ''}
${money('PayableAmount', t.due_cents, '    ')}
  </cac:LegalMonetaryTotal>${lines}
</${root}>
`;
}
