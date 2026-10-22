import { toCsv } from '../core/csv.js';
import { checkIban, normalizeIban } from './invoice-model.js';
import { creditTransferXml, sepaText } from './sepa-xml.js';

/** Affiliate manager: commission maths, IBAN check and payout exports (CSV, SEPA pain.001). */

export interface ProgramTerms {
  commission_type: 'percent' | 'fixed';
  /** Percent (20 = 20 %) or cents for a fixed amount. */
  commission_value: number;
  /** Renewals (subscription periods, recurring invoices) earn commission too. */
  recurring: number | boolean;
}

/** Commission in cents for a sale with net amount `base_cents`; null = no commission. */
export function commissionFor(p: ProgramTerms, sale: { base_cents: number; recurring: boolean }): number | null {
  if (sale.recurring && !p.recurring) return null;
  if (sale.base_cents <= 0) return null;
  const value = Number(p.commission_value) || 0;
  const amount = p.commission_type === 'fixed' ? Math.round(value) : Math.round((sale.base_cents * value) / 100);
  return amount > 0 ? amount : null;
}

/**
 * What a refund or a credit note does to a commission. `refunded` of `total` is cumulative (all refunds / credit notes so far),
 * so every adjustment starts from the original commission and repeating it changes nothing. Before payout the commission is
 * reversed (all of it) or reduced (part); once it was paid out – or sits in an open payout, whose file may be at the bank
 * already – it is never edited: a negative clawback of what was paid beyond the new amount is booked against the next payout.
 * `clawback`'s amount is the cumulative total the clawbacks of this commission should reach (≤ 0).
 */
export function refundAdjustment(
  c: { amount_cents: number; original_cents?: number | null; status: string; payout_id?: string | null },
  refunded: number,
  total: number,
): { action: 'reverse' | 'reduce' | 'clawback' | 'none'; amount: number } {
  const original = c.original_cents ?? c.amount_cents;
  if (c.status === 'reversed' || original <= 0 || refunded <= 0) return { action: 'none', amount: 0 };
  const ratio = total > 0 ? Math.min(1, refunded / total) : 1;
  const full = ratio >= 0.999;
  const target = full ? 0 : Math.round(original * (1 - ratio));
  if (c.status === 'paid' || c.payout_id) {
    const claw = Math.min(0, target - c.amount_cents);
    return claw < 0 ? { action: 'clawback', amount: claw } : { action: 'none', amount: 0 };
  }
  if (full) return { action: 'reverse', amount: 0 };
  // never back up: a refund and a credit note for the same money must not give back what the other one took
  return target < c.amount_cents ? { action: 'reduce', amount: target } : { action: 'none', amount: 0 };
}

/** IBAN check and the SEPA character set come from the shared helpers (invoice-model.ts, sepa-xml.ts). */
export const validIban = (raw: unknown): boolean => checkIban(raw);
export const cleanIban = (raw: unknown) => normalizeIban(raw);
export { sepaText };
const eur = (cents: number) => (cents / 100).toFixed(2);

export interface PayoutLine {
  id: string;
  name: string;
  email: string;
  iban: string;
  bic: string;
  paypal: string;
  method: string;
  amount_cents: number;
  currency: string;
  reference: string;
}

export function payoutCsv(lines: PayoutLine[]): string {
  return toCsv([
    ['Name', 'E-Mail', 'Methode', 'IBAN', 'BIC', 'PayPal', 'Betrag', 'Währung', 'Verwendungszweck'],
    ...lines.map((l) => [l.name, l.email, l.method === 'paypal' ? 'PayPal' : 'SEPA', l.iban, l.bic, l.paypal, eur(l.amount_cents).replace('.', ','), l.currency, l.reference]),
  ]);
}

/**
 * SEPA credit transfer file (pain.001.001.03) for online banking upload: one batch from the
 * sub-account's own account (IBAN from the invoice settings) to every affiliate with an IBAN.
 * Written by the shared builder in services/sepa-xml.ts (the SEPA module writes pain.001.001.09 with it).
 */
export function sepaXml(debtor: { name: string; iban: string; bic?: string }, lines: PayoutLine[], opts: { msgId: string; executionDate: string; at?: Date }): string {
  const tx = lines.filter((l) => l.iban && validIban(l.iban) && l.amount_cents > 0);
  return creditTransferXml({
    version: '001.001.03',
    debtor,
    msgId: opts.msgId,
    executionDate: opts.executionDate,
    at: opts.at,
    lines: tx.map((l) => ({ endToEndId: l.id, name: l.name, iban: l.iban, bic: l.bic, amount_cents: l.amount_cents, remittance: l.reference })),
  });
}
