import { composeSnapshot, type ComposeInput } from '../server/services/invoice-doc.js';
import type { BankInfo, BuyerParty, DocSnapshot, SellerParty } from '../server/services/einvoice-model.js';
import type { LineItem } from '../server/services/invoice-model.js';

/** Shared documents for the invoicing tests (not a test file). */

export const SELLER: SellerParty = {
  name: 'Muster Beratung GmbH',
  street: 'Musterstraße 1',
  postal_code: '10115',
  city: 'Berlin',
  country: 'DE',
  email: 'rechnung@muster-beratung.example',
  phone: '+49 30 1234567',
  contact_name: 'Erika Muster',
  vat_id: 'DE811569869',
  tax_number: '37/123/45678',
};
export const BUYER: BuyerParty = {
  name: 'Max Kunde',
  company: 'Kunde & Söhne GmbH',
  street: 'Hauptstraße 7',
  postal_code: '80331',
  city: 'München',
  country: 'DE',
  email: 'einkauf@kunde.example',
  phone: '',
  vat_id: '',
  leitweg_id: '',
  buyer_ref: '',
};
export const BANK: BankInfo = { iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };

export const ITEMS: LineItem[] = [
  { name: 'Beratung', description: 'Workshop vor Ort', qty: 2, price_cents: 10000, tax_rate: 19, unit: 'HUR' },
  { name: 'Fachbuch', qty: 1, price_cents: 3490, tax_rate: 7 },
];

/** A document as it would be frozen: the number and dates are fixed so the output is stable. */
export function doc(over: Partial<ComposeInput> = {}): DocSnapshot {
  return composeSnapshot({ kind: 'invoice', number: 'RE-2026-0001', issued_at: '2026-10-05T10:00:00Z', due_at: '2026-10-19T10:00:00Z', items: ITEMS, seller: SELLER, buyer: BUYER, bank: BANK, ...over });
}

