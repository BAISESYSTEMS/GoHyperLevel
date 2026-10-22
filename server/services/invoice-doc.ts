/**
 * Composes the frozen form of an invoice document (the snapshot that is hashed when it is finalised) from plain
 * values – no database. The same function renders drafts (previews) and finalised documents (PDF, HTML, e-invoice).
 */

import type { BankInfo, BuyerParty, DocSnapshot, SellerParty } from './einvoice-model.js';
import { calcTotals, cleanYmd, sha256Hex, canonicalJson, ymd, type CreditType, type Deduction, type InvType, type LineItem, type Skonto, type TaxMode } from './invoice-model.js';

export interface ComposeInput {
  kind: 'invoice' | 'credit_note' | 'estimate';
  inv_type?: InvType;
  credit_type?: CreditType | '';
  number: string;
  issued_at: string;
  due_at?: string | null;
  /** Time zone for turning instants into the dates printed on the document. */
  tz?: string;
  currency?: string;
  title?: string;
  notes?: string;
  tax_mode?: TaxMode;
  tax_note?: string;
  calc?: 'group' | 'line';
  supply_from?: string;
  supply_to?: string;
  items: LineItem[];
  deductions?: Deduction[];
  skonto?: Skonto | null;
  ref?: { id: string; number: string; issued_at: string } | null;
  seller: SellerParty;
  buyer: BuyerParty;
  bank: BankInfo;
  vies?: DocSnapshot['vies'];
}

export function composeSnapshot(i: ComposeInput): DocSnapshot {
  const tz = i.tz ?? 'Europe/Berlin';
  const tax_mode = i.tax_mode ?? 'standard';
  const calc = i.calc ?? 'group';
  const issued_ymd = ymd(i.issued_at, tz);
  const supply_from = cleanYmd(i.supply_from, 'Leistungsdatum') || issued_ymd;
  const supply_to = cleanYmd(i.supply_to, 'Leistungszeitraum bis');
  const totals = calcTotals(i.items, tax_mode, calc);
  const deductions = i.deductions ?? [];
  return {
    v: 1,
    kind: i.kind,
    inv_type: i.inv_type ?? 'standard',
    credit_type: i.credit_type ?? '',
    number: i.number,
    issued_at: i.issued_at,
    issued_ymd,
    due_ymd: i.due_at ? ymd(i.due_at, tz) : '',
    currency: i.currency ?? 'EUR',
    title: i.title ?? '',
    notes: i.notes ?? '',
    tax_mode,
    tax_note: i.tax_note ?? '',
    calc,
    supply_from,
    supply_to: supply_to && supply_to > supply_from ? supply_to : '',
    supply_auto: !i.supply_from,
    items: i.items,
    totals,
    deducted_cents: deductions.reduce((n, d) => n + d.total_cents, 0),
    deductions,
    skonto: i.skonto ?? null,
    ref: i.ref ? { id: i.ref.id, number: i.ref.number, issued_ymd: ymd(i.ref.issued_at, tz) } : null,
    seller: i.seller,
    buyer: i.buyer,
    bank: i.bank,
    vies: i.vies ?? null,
  };
}

/**
 * What the SHA-256 of a finalised invoice covers: the snapshot without the two fields that stay editable afterwards
 * (notes and due date). Changing anything else – items, amounts, parties, tax treatment, dates, number – changes the hash.
 */
export function frozenPart(s: DocSnapshot): Omit<DocSnapshot, 'notes' | 'due_ymd'> {
  const { notes: _n, due_ymd: _d, ...rest } = s;
  return rest;
}

export const snapshotHash = (s: DocSnapshot): string => sha256Hex(canonicalJson(frozenPart(s)));
