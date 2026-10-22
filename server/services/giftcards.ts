import { randomInt } from 'node:crypto';
import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { centsToMoney, id, now } from '../core/util.js';

/**
 * Gift cards (docs/store.md#gift-cards): a code and a balance kept in an append-only ledger (issue, redeem, refund, adjust). A
 * payment holds the amount on the card first (gift_card_holds) – so two checkouts cannot spend the same balance – and commits it
 * when the payment is complete, or releases it when the payment lapses. Treated as multi-purpose vouchers (Mehrzweck-Gutscheine):
 * selling one is not yet a taxable supply, VAT is due on what is bought with it (§ 3 Abs. 15 UStG).
 */

export interface GiftCard {
  id: string;
  location_id: string;
  code: string;
  initial_cents: number;
  balance_cents: number;
  currency: string;
  status: 'active' | 'disabled';
  expires_at: string | null;
  contact_id: string | null;
  recipient_name: string;
  recipient_email: string;
  message: string;
  source: string;
  order_id: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** XXXX-XXXX-XXXX-XXXX from an alphabet without 0/O and 1/I (read aloud, typed from a printed card). */
export function newCode(): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s.match(/.{4}/g)!.join('-');
}
export const normCode = (v: unknown): string => {
  const raw = String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
  return raw.length === 16 ? raw.match(/.{4}/g)!.join('-') : raw;
};
export const maskCode = (code: string) => `••••-${code.slice(-4)}`;

/** A hold outlives every payment it waits for (a bank transfer through Mollie takes days); lapsed sessions release it earlier. */
const HOLD_MINUTES = 30 * 24 * 60;

export const cardById = (app: App, locationId: string, cardId: string) => app.db.get<GiftCard>('SELECT * FROM gift_cards WHERE id = ? AND location_id = ?', cardId, locationId);
export const cardByCode = (app: App, locationId: string, code: string) => app.db.get<GiftCard>('SELECT * FROM gift_cards WHERE location_id = ? AND code = ?', locationId, normCode(code));
const held = (app: App, cardId: string, except = '') => Number(app.db.get<{ n: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM gift_card_holds WHERE card_id = ? AND expires_at > ? AND ref != ?', cardId, now(), except)?.n ?? 0);
const expired = (c: Pick<GiftCard, 'expires_at'>) => !!c.expires_at && c.expires_at < now();
/** What can still be spent: the balance minus what running checkouts hold. */
export const available = (app: App, c: GiftCard, exceptRef = '') => Math.max(0, c.balance_cents - held(app, c.id, exceptRef));

/** Writes a ledger line and keeps the card's balance in step (one transaction). */
export function ledger(app: App, c: Pick<GiftCard, 'id' | 'location_id'>, kind: 'issue' | 'redeem' | 'refund' | 'adjust', amount: number, ref: { type?: string; id?: string; note?: string; by?: string | null } = {}) {
  app.db.tx(() => {
    app.db.insert('gift_card_ledger', { id: id(), location_id: c.location_id, card_id: c.id, kind, amount_cents: Math.round(amount), ref_type: ref.type ?? '', ref_id: ref.id ?? '', note: String(ref.note ?? '').slice(0, 300), created_by: ref.by ?? null, created_at: now() });
    const sum = Number(app.db.get<{ n: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM gift_card_ledger WHERE card_id = ?', c.id)?.n ?? 0);
    if (sum < 0) throw new HttpError(409, 'Das Guthaben des Gutscheins reicht nicht');
    app.db.run('UPDATE gift_cards SET balance_cents = ?, updated_at = ? WHERE id = ?', sum, now(), c.id);
  });
}

/** Why a code cannot pay (German), or the card. */
export function usable(app: App, locationId: string, code: string, currency?: string): GiftCard {
  const c = code ? cardByCode(app, locationId, code) : undefined;
  if (!c) throw bad('Diesen Gutscheincode gibt es nicht');
  if (c.status !== 'active') throw bad('Dieser Gutschein ist gesperrt');
  if (expired(c)) throw bad('Dieser Gutschein ist abgelaufen');
  if (currency && c.currency !== currency) throw bad(`Dieser Gutschein gilt nur in ${c.currency}`);
  if (available(app, c) <= 0) throw bad('Auf diesem Gutschein ist kein Guthaben mehr');
  return c;
}

/**
 * Holds up to `max` on the card for the payment `ref`. `minRest`: what is left to pay must be 0 or at least this (the providers'
 * minimum), so the hold is lowered a little when the rest would be smaller.
 */
export function hold(app: App, locationId: string, code: string, max: number, ref: string, currency?: string, minRest = 0): { card_id: string; amount: number } {
  return app.db.tx(() => {
    const c = usable(app, locationId, code, currency);
    let amount = Math.min(available(app, c, ref), Math.max(0, Math.round(max)));
    const rest = max - amount;
    if (rest > 0 && rest < minRest) amount = Math.max(0, max - minRest);
    if (amount <= 0) throw bad('Der Gutschein lässt sich für diesen kleinen Betrag nicht einlösen');
    app.db.run('DELETE FROM gift_card_holds WHERE ref = ?', ref);
    app.db.insert('gift_card_holds', { ref, location_id: locationId, card_id: c.id, amount_cents: amount, expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(), created_at: now() });
    return { card_id: c.id, amount };
  });
}

/** The payment `ref` is complete: what it held becomes a redemption in the ledger (idempotent – a second call finds no hold). */
export function commit(app: App, ref: string, refType: string, refId: string): number {
  return app.db.tx(() => {
    const h = app.db.get<{ card_id: string; location_id: string; amount_cents: number }>('SELECT * FROM gift_card_holds WHERE ref = ?', ref);
    if (!h) return 0;
    app.db.run('DELETE FROM gift_card_holds WHERE ref = ?', ref);
    // A hold that ran out still pays: the money was promised to this checkout (a balance spent meanwhile makes ledger() refuse).
    ledger(app, { id: h.card_id, location_id: h.location_id }, 'redeem', -h.amount_cents, { type: refType, id: refId, note: `Zahlung ${ref}` });
    return h.amount_cents;
  });
}

export const release = (app: App, ref: string) => void app.db.run('DELETE FROM gift_card_holds WHERE ref = ?', ref);

/** Redeems right away (an invoice that exists already): hold + commit. Returns the amount taken. */
export function redeem(app: App, locationId: string, code: string, max: number, refType: string, refId: string, currency?: string): { card: GiftCard; amount: number } {
  return app.db.tx(() => {
    const ref = `direct-${id(12)}`;
    const h = hold(app, locationId, code, max, ref, currency);
    commit(app, ref, refType, refId);
    return { card: cardById(app, locationId, h.card_id)!, amount: h.amount };
  });
}

export interface IssueInput {
  amount_cents: number;
  currency?: string;
  expires_at?: string | null;
  contact_id?: string | null;
  recipient_name?: string;
  recipient_email?: string;
  message?: string;
  source?: string;
  order_id?: string | null;
  note?: string;
  code?: string;
  by?: string | null;
}

/** A new card with its first ledger line. */
export function issue(app: App, locationId: string, o: IssueInput): GiftCard {
  const amount = Math.round(o.amount_cents);
  if (!Number.isInteger(amount) || amount < 100 || amount > 1_000_000_00) throw bad('Betrag: 1 € bis 1.000.000 €');
  const currency = /^[A-Z]{3}$/.test(o.currency ?? '') ? o.currency! : 'EUR';
  let code = o.code ? normCode(o.code) : '';
  if (code && !/^[A-Z0-9-]{6,32}$/.test(code)) throw bad('Code: 6 bis 32 Buchstaben und Ziffern');
  if (code && cardByCode(app, locationId, code)) throw bad('Diesen Code gibt es schon');
  for (let i = 0; !code || cardByCode(app, locationId, code); i++) code = newCode();
  const t = now();
  const card: GiftCard = {
    id: id(),
    location_id: locationId,
    code,
    initial_cents: amount,
    balance_cents: 0,
    currency,
    status: 'active',
    expires_at: o.expires_at ? new Date(o.expires_at).toISOString() : null,
    contact_id: o.contact_id ?? null,
    recipient_name: String(o.recipient_name ?? '').slice(0, 120),
    recipient_email: String(o.recipient_email ?? '').slice(0, 200),
    message: String(o.message ?? '').slice(0, 500),
    source: String(o.source ?? 'manual').slice(0, 40),
    order_id: o.order_id ?? null,
    note: String(o.note ?? '').slice(0, 300),
    created_at: t,
    updated_at: t,
  };
  app.db.tx(() => {
    app.db.insert('gift_cards', card);
    ledger(app, card, 'issue', amount, { type: o.order_id ? 'store_order' : 'manual', id: o.order_id ?? '', note: o.note ?? '', by: o.by ?? null });
  });
  return cardById(app, locationId, card.id)!;
}

/** The text of the mail with the code (buyer or recipient). */
export function giftMailText(c: GiftCard, shop: string, from = ''): { subject: string; body: string } {
  const value = centsToMoney(c.initial_cents, c.currency);
  const until = c.expires_at ? `\nGültig bis: ${new Date(c.expires_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}` : '';
  return {
    subject: `Dein Gutschein über ${value} von ${shop}`,
    body: `Hallo${c.recipient_name ? ` ${c.recipient_name}` : ''},\n\n${from ? `${from} schenkt dir einen Gutschein` : 'hier ist dein Gutschein'} über ${value} für ${shop}.${c.message ? `\n\n„${c.message}“` : ''}\n\nGutscheincode: ${c.code}${until}\n\nDu kannst ihn im Online-Shop, auf Rechnungen und bei Terminbuchungen einlösen.\n\nViele Grüße\n${shop}`,
  };
}
