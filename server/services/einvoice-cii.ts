import { amt, compactYmd, qtyText, rate2, xmlEsc as x, type EInvoice, type EParty } from './einvoice-model.js';

/**
 * UN/CEFACT Cross Industry Invoice (CII, D16B) in the XRechnung 3.0 / EN 16931 profile – the syntax ZUGFeRD and
 * Factur-X embed as well. Element order follows the schema sequence.
 */

const date = (ymd: string, tag: string, ind = '', ns = 'udt') => `${ind}<${tag}><${ns}:DateTimeString format="102">${compactYmd(ymd)}</${ns}:DateTimeString></${tag}>`;

function party(p: EParty, tag: string, seller: boolean): string {
  const contact = seller || p.contact_name
    ? `\n          <ram:DefinedTradeContact>${p.contact_name ? `\n            <ram:PersonName>${x(p.contact_name)}</ram:PersonName>` : ''}${
        p.phone ? `\n            <ram:TelephoneUniversalCommunication>\n              <ram:CompleteNumber>${x(p.phone)}</ram:CompleteNumber>\n            </ram:TelephoneUniversalCommunication>` : ''
      }${p.email && seller ? `\n            <ram:EmailURIUniversalCommunication>\n              <ram:URIID>${x(p.email)}</ram:URIID>\n            </ram:EmailURIUniversalCommunication>` : ''}
          </ram:DefinedTradeContact>`
    : '';
  const regs = [
    p.vat_id ? `\n          <ram:SpecifiedTaxRegistration>\n            <ram:ID schemeID="VA">${x(p.vat_id)}</ram:ID>\n          </ram:SpecifiedTaxRegistration>` : '',
    p.tax_number ? `\n          <ram:SpecifiedTaxRegistration>\n            <ram:ID schemeID="FC">${x(p.tax_number)}</ram:ID>\n          </ram:SpecifiedTaxRegistration>` : '',
  ].join('');
  return `<ram:${tag}>
          <ram:Name>${x(p.name)}</ram:Name>${contact}
          <ram:PostalTradeAddress>
            <ram:PostcodeCode>${x(p.postal_code)}</ram:PostcodeCode>
            <ram:LineOne>${x(p.street)}</ram:LineOne>
            <ram:CityName>${x(p.city)}</ram:CityName>
            <ram:CountryID>${x(p.country)}</ram:CountryID>
          </ram:PostalTradeAddress>
          <ram:URIUniversalCommunication>
            <ram:URIID schemeID="${x(p.endpoint_scheme)}">${x(p.endpoint)}</ram:URIID>
          </ram:URIUniversalCommunication>${regs}
        </ram:${tag}>`;
}

export function ciiXml(e: EInvoice): string {
  const cur = x(e.currency);
  const lines = e.lines
    .map(
      (l) => `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${x(l.id)}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${x(l.name)}</ram:Name>${l.description ? `\n        <ram:Description>${x(l.description)}</ram:Description>` : ''}
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${amt(l.price_cents)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${x(l.unit)}">${qtyText(l.qty)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${l.category}</ram:CategoryCode>
          <ram:RateApplicablePercent>${rate2(l.rate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${amt(l.net_cents)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`,
    )
    .join('\n');
  const taxes = e.groups
    .map(
      (g) => `      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${amt(g.tax_cents)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>${g.reason ? `\n        <ram:ExemptionReason>${x(g.reason)}</ram:ExemptionReason>` : ''}
        <ram:BasisAmount>${amt(g.basis_cents)}</ram:BasisAmount>
        <ram:CategoryCode>${g.category}</ram:CategoryCode>${g.reason_code ? `\n        <ram:ExemptionReasonCode>${x(g.reason_code)}</ram:ExemptionReasonCode>` : ''}
        <ram:RateApplicablePercent>${rate2(g.rate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`,
    )
    .join('\n');
  const notes = e.notes.map((n) => `    <ram:IncludedNote>\n      <ram:Content>${x(n)}</ram:Content>\n    </ram:IncludedNote>`).join('\n');
  const period = e.period_start
    ? `\n      <ram:BillingSpecifiedPeriod>\n${date(e.period_start, 'ram:StartDateTime', '        ')}\n${date(e.period_end, 'ram:EndDateTime', '        ')}\n      </ram:BillingSpecifiedPeriod>`
    : '';
  const terms =
    e.payment_terms || e.due_date
      ? `\n      <ram:SpecifiedTradePaymentTerms>${e.payment_terms ? `\n        <ram:Description>${x(e.payment_terms)}</ram:Description>` : ''}${e.due_date ? `\n${date(e.due_date, 'ram:DueDateDateTime', '        ')}` : ''}\n      </ram:SpecifiedTradePaymentTerms>`
      : '';
  const refs = e.preceding
    .map((p) => `\n      <ram:InvoiceReferencedDocument>\n        <ram:IssuerAssignedID>${x(p.number)}</ram:IssuerAssignedID>\n${date(p.date, 'ram:FormattedIssueDateTime', '        ', 'qdt')}\n      </ram:InvoiceReferencedDocument>`)
    .join('');
  const t = e.totals;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>${x(e.profile)}</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${x(e.customization)}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${x(e.number)}</ram:ID>
    <ram:TypeCode>${e.type_code}</ram:TypeCode>
${date(e.issue_date, 'ram:IssueDateTime', '    ')}${notes ? `\n${notes}` : ''}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${lines}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${x(e.buyer_reference)}</ram:BuyerReference>
      ${party(e.seller, 'SellerTradeParty', true)}
      ${party(e.buyer, 'BuyerTradeParty', false)}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>${e.supply_date ? `\n      <ram:ActualDeliverySupplyChainEvent>\n${date(e.supply_date, 'ram:OccurrenceDateTime', '        ')}\n      </ram:ActualDeliverySupplyChainEvent>\n    ` : ''}</ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:PaymentReference>${x(e.payment.remittance)}</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>${e.payment.means_code}</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>${x(e.payment.iban)}</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>${e.payment.bic ? `\n        <ram:PayeeSpecifiedCreditorFinancialInstitution>\n          <ram:BICID>${x(e.payment.bic)}</ram:BICID>\n        </ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}
      </ram:SpecifiedTradeSettlementPaymentMeans>
${taxes}${period}${terms}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amt(t.line_cents)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amt(t.basis_cents)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${cur}">${amt(t.tax_cents)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amt(t.grand_cents)}</ram:GrandTotalAmount>${t.prepaid_cents ? `\n        <ram:TotalPrepaidAmount>${amt(t.prepaid_cents)}</ram:TotalPrepaidAmount>` : ''}
        <ram:DuePayableAmount>${amt(t.due_cents)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>${refs}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}
