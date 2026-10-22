import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { centsToMoney, now, token } from '../core/util.js';
import { logActivity } from './contacts.js';
import { invAudit, loadInvoice, recordPayment, type Actor } from './invoice-flow.js';
import { openCents } from './invoice-model.js';

/**
 * Payment provider registry (docs/payment-providers.md). A provider (Stripe, PayPal, Mollie …) is a small object: make a hosted
 * checkout for a pay session, tell the state of one, refund one. A purpose (an invoice, a store order, a booking hold, a buy-link
 * product) says what happens when its money arrived. Everything in between – the session row, the gift-card part, settling once
 * however often a webhook or the buyer's return reports the payment, refunds – lives here, so a new provider is one file.
 */

export type PayStatus = 'open' | 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled' | 'refunded';
export interface PayLine {
  name: string;
  qty: number;
  /** Gross per unit (incl. VAT). */
  unit_cents: number;
  tax_rate?: number;
  sku?: string;
}
export interface PayAddress {
  name?: string;
  street?: string;
  postal_code?: string;
  city?: string;
  country?: string;
}

export interface PaySession {
  id: string;
  location_id: string;
  provider: string;
  purpose: string;
  ref_id: string;
  /** What the provider charges – the total minus the gift-card part. */
  amount_cents: number;
  gift_cents: number;
  gift_card_id: string | null;
  currency: string;
  description: string;
  status: PayStatus;
  provider_ref: string;
  capture_ref: string;
  url: string;
  method: string;
  refunded_cents: number;
  received_cents: number;
  meta: { return_url?: string; cancel_url?: string; email?: string; name?: string; address?: PayAddress; lines?: PayLine[]; [k: string]: unknown };
  created_at: string;
  paid_at: string | null;
  updated_at: string;
}

export interface ProviderState {
  status: 'paid' | 'pending' | 'open' | 'failed' | 'expired' | 'cancelled';
  amount_cents?: number;
  currency?: string;
  /** The provider's id of the money movement (Stripe PaymentIntent, PayPal capture, Mollie payment) – what a refund needs. */
  capture_ref?: string;
}

export interface PayProvider {
  id: string;
  label: string;
  /** What the buyer can pay with (short German labels for buttons and the settings page). */
  methods(app: App, locationId: string): string[];
  ready(app: App, locationId: string): boolean;
  create(app: App, s: PaySession): Promise<{ provider_ref: string; url: string }>;
  fetch(app: App, s: PaySession): Promise<ProviderState>;
  refund(app: App, s: PaySession, amountCents: number): Promise<{ id: string }>;
}

export interface PayPurpose {
  /** Money arrived: `received` is what the provider booked (plus the gift-card part, which is in `s.gift_cents`). Runs once per session. */
  settle(app: App, s: PaySession, received: number): unknown;
  /** The session will not be paid any more (failed, expired, cancelled). */
  lapse?(app: App, s: PaySession): void;
}

export interface StartInput {
  locationId: string;
  purpose: string;
  refId: string;
  /** Total (gross) before a gift card. */
  amountCents: number;
  currency: string;
  description: string;
  email?: string;
  name?: string;
  address?: PayAddress;
  lines?: PayLine[];
  returnUrl: string;
  cancelUrl?: string;
  giftCode?: string;
  meta?: Record<string, unknown>;
}

/** The smallest amount every provider takes (Stripe and PayPal: 0,50 €). */
export const MIN_CENTS = 50;
export const GIFT_PROVIDER = 'giftcard';

export class PayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- registry -----------------------------------------------------------------------------------------------------------

export const payProviders = (app: App): Map<string, PayProvider> => (app.services.payProviders ??= new Map<string, PayProvider>());
export function registerPayProvider(app: App, p: PayProvider) {
  payProviders(app).set(p.id, p);
}
/** Order-independent (like workflowTriggerFilters): a module may register its purpose before or after the registry module. */
export function registerPayPurpose(app: App, key: string, p: PayPurpose) {
  app.services.payPurposes = { ...(app.services.payPurposes ?? {}), [key]: p };
}
const purposeOf = (app: App, key: string): PayPurpose | undefined => app.services.payPurposes?.[key];
export const readyProviders = (app: App, locationId: string): PayProvider[] => [...payProviders(app).values()].filter((p) => p.ready(app, locationId));
export const providerLabel = (app: App, id: string) => (id === GIFT_PROVIDER ? 'Gutschein' : (payProviders(app).get(id)?.label ?? id));

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;
/** The network of PayPal and Mollie; tests put a fake into app.services.payFetch. Hosts are fixed per provider. */
export const payFetch = (app: App): FetchLike => app.services.payFetch ?? ((url, init) => fetch(url, init));

/** JSON over HTTPS with a German error on failure. */
export async function payJson(app: App, label: string, url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<any> {
  let r: Response;
  try {
    r = await payFetch(app)(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new PayError(0, `${label} nicht erreichbar: ${(e as Error).message}`);
  }
  const text = await r.text();
  let j: any = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    j = {};
  }
  if (!r.ok) {
    const msg = j?.message || j?.detail || j?.error_description || j?.details?.[0]?.description || j?.title || `${label}-Fehler ${r.status}`;
    throw new PayError(r.status, r.status === 401 ? `${label} lehnt die Zugangsdaten ab (401) – bitte prüfen` : String(msg).slice(0, 300));
  }
  return j;
}

/** "12.34" – the decimal string PayPal and Mollie want. */
export const amountValue = (cents: number) => (Math.round(cents) / 100).toFixed(2);
export const centsOf = (value: unknown) => Math.round(Number(value) * 100);
export const failHttp = (e: unknown) => (e instanceof PayError ? new HttpError(e.status === 401 || e.status === 400 || e.status === 422 ? 400 : 502, e.message) : e);

// --- credentials (one sealed JSON per sub-account and provider) -------------------------------------------------------------

export interface Account {
  secrets: Record<string, string>;
  options: Record<string, any>;
  hint: string;
  checked_at: string | null;
}

export function accountOf(app: App, locationId: string, provider: string): Account | undefined {
  const row = app.db.get<any>('SELECT * FROM pay_accounts WHERE location_id = ? AND provider = ?', locationId, provider);
  if (!row) return undefined;
  let secrets: Record<string, string> = {};
  try {
    secrets = row.secrets ? JSON.parse(openSecret(app, row.secrets)) : {};
  } catch {
    secrets = {};
  }
  return { secrets, options: parseJson(row, ['options']).options ?? {}, hint: row.hint ?? '', checked_at: row.checked_at ?? null };
}

export function saveAccount(app: App, locationId: string, provider: string, a: Account) {
  app.db.run(
    `INSERT INTO pay_accounts (location_id, provider, secrets, options, hint, checked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, provider) DO UPDATE SET secrets = excluded.secrets, options = excluded.options, hint = excluded.hint, checked_at = excluded.checked_at, updated_at = excluded.updated_at`,
    locationId, provider, sealSecret(app, JSON.stringify(a.secrets)), JSON.stringify(a.options), a.hint, a.checked_at, now(),
  );
}

/** What the browser may see of a secret: the first characters and the last four. */
export const secretHint = (v: string) => (v ? `${v.slice(0, Math.min(5, Math.floor(v.length / 4)))}…${v.slice(-4)}` : '');

// --- sessions ------------------------------------------------------------------------------------------------------------

const JSON_COLS = ['meta'];
export const getSession = (app: App, id: string): PaySession | undefined => (/^ps_[A-Za-z0-9_-]{10,40}$/.test(id) ? parseJson(app.db.get<PaySession>('SELECT * FROM pay_sessions WHERE id = ?', id), JSON_COLS) : undefined);
/** A provider reference (order, payment, Checkout Session) → its session, also for an earlier attempt with another provider. */
export function sessionByRef(app: App, locationId: string, provider: string, ref: string): PaySession | undefined {
  const r = app.db.get<{ session_id: string }>('SELECT session_id FROM pay_refs WHERE provider = ? AND ref = ? AND location_id = ?', provider, ref, locationId);
  return r ? getSession(app, r.session_id) : undefined;
}

/** A new pay session; a gift card (code) pays its part right away – the rest goes to a provider. */
export function startSession(app: App, input: StartInput): PaySession {
  const total = Math.round(input.amountCents);
  if (!Number.isInteger(total) || total < 0) throw bad('Ungültiger Betrag');
  if (!/^[A-Z]{3}$/.test(input.currency)) throw bad('Ungültige Währung');
  const id = `ps_${token(16)}`;
  const t = now();
  const s: PaySession = {
    id,
    location_id: input.locationId,
    provider: '',
    purpose: input.purpose,
    ref_id: input.refId,
    amount_cents: total,
    gift_cents: 0,
    gift_card_id: null,
    currency: input.currency,
    description: String(input.description).slice(0, 200),
    status: 'open',
    provider_ref: '',
    capture_ref: '',
    url: '',
    method: '',
    refunded_cents: 0,
    received_cents: 0,
    meta: { ...(input.meta ?? {}), return_url: input.returnUrl, cancel_url: input.cancelUrl ?? input.returnUrl, email: input.email ?? '', name: input.name ?? '', address: input.address, lines: input.lines },
    created_at: t,
    paid_at: null,
    updated_at: t,
  };
  app.db.tx(() => {
    app.db.insert('pay_sessions', s);
    if (input.giftCode) applyGift(app, s, input.giftCode);
  });
  return getSession(app, id)!;
}

/**
 * Lets a gift card pay part (or all) of an open session. The amount is held on the card until the session is paid (committed to
 * the card's ledger) or lapses (released). A rest below the providers' minimum is avoided by taking a little less from the card.
 */
export function applyGift(app: App, s: PaySession, code: string): PaySession {
  const gc = app.services.giftCards;
  if (!gc) throw bad('Gutscheine sind nicht verfügbar');
  if (s.status !== 'open' || s.provider_ref) throw new HttpError(409, 'Die Zahlung läuft schon – der Gutschein lässt sich jetzt nicht mehr einlösen');
  const total = s.amount_cents + s.gift_cents;
  gc.release(s.id);
  const held: { card_id: string; amount: number } = gc.hold(s.location_id, code, total, s.id, s.currency, MIN_CENTS);
  const rest = total - held.amount;
  app.db.run('UPDATE pay_sessions SET gift_cents = ?, gift_card_id = ?, amount_cents = ?, updated_at = ? WHERE id = ?', held.amount, held.card_id, rest, now(), s.id);
  return getSession(app, s.id)!;
}

/** Makes (or reuses) the provider's checkout page for the session and returns its address. A session paid fully by gift card settles here. */
export async function checkoutSession(app: App, s: PaySession, providerId: string): Promise<{ url: string; settled?: boolean }> {
  if (s.status === 'paid') return { url: String(s.meta.return_url ?? '/'), settled: true };
  if (s.status !== 'open' && s.status !== 'pending') throw new HttpError(409, 'Diese Zahlung ist abgeschlossen');
  if (s.amount_cents === 0) {
    const r = settleSession(app, s, { status: 'paid', amount_cents: 0, currency: s.currency }, GIFT_PROVIDER);
    await r.pending;
    return { url: String(s.meta.return_url ?? '/'), settled: true };
  }
  if (s.amount_cents < MIN_CENTS) throw bad(`Der Betrag (${centsToMoney(s.amount_cents, s.currency)}) ist zu klein für eine Online-Zahlung`);
  const p = payProviders(app).get(providerId);
  if (!p || !p.ready(app, s.location_id)) throw bad('Diese Zahlungsart ist nicht verfügbar');
  if (s.provider === providerId && s.url && s.status === 'open') return { url: s.url };
  const made = await p.create(app, s).catch((e) => {
    throw failHttp(e);
  });
  if (!made.url) throw new HttpError(502, `${p.label} hat keine Bezahlseite geliefert`);
  app.db.tx(() => {
    app.db.run('UPDATE pay_sessions SET provider = ?, provider_ref = ?, url = ?, updated_at = ? WHERE id = ?', providerId, made.provider_ref, made.url, now(), s.id);
    app.db.run('INSERT OR IGNORE INTO pay_refs (provider, ref, session_id, location_id, created_at) VALUES (?, ?, ?, ?, ?)', providerId, made.provider_ref, s.id, s.location_id, now());
  });
  return { url: made.url };
}

/**
 * The money arrived. Claims the session once (a retried webhook, the buyer's return and the provider's second event all end up
 * here), commits the gift-card part and runs the purpose. `pending` is the purpose's own async work (a booking), if any.
 */
export function settleSession(app: App, s: PaySession, state: ProviderState, providerId = s.provider): { handled: string; pending?: Promise<unknown> } {
  const received = state.amount_cents ?? s.amount_cents;
  if (state.currency && state.currency.toUpperCase() !== s.currency) {
    app.db.run(`UPDATE pay_sessions SET meta = json_set(meta, '$.mismatch', ?) WHERE id = ?`, `${centsToMoney(received, state.currency.toUpperCase())} statt ${centsToMoney(s.amount_cents, s.currency)}`, s.id);
  }
  const claimed = app.db.tx(() => {
    const n = app.db.run(
      `UPDATE pay_sessions SET status = 'paid', paid_at = ?, provider = ?, capture_ref = COALESCE(NULLIF(?, ''), capture_ref), received_cents = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'pending', 'failed', 'expired', 'cancelled')`,
      now(), providerId, state.capture_ref ?? '', received, now(), s.id,
    ).changes;
    if (n && s.gift_cents > 0) app.services.giftCards?.commit(s.id, s.purpose, s.ref_id);
    return n > 0;
  });
  if (!claimed) return { handled: 'duplicate' };
  const fresh = getSession(app, s.id)!;
  const purpose = purposeOf(app, s.purpose);
  if (!purpose) return { handled: 'no_purpose' };
  try {
    const r = purpose.settle(app, fresh, received);
    if (r && typeof (r as Promise<unknown>).then === 'function') return { handled: 'paid', pending: (r as Promise<unknown>).catch((e) => console.error('[pay] settle', s.purpose, (e as Error).message)) };
  } catch (e) {
    // Not settled: the provider's next try (or the buyer's return) gets another go; the gift card stays committed (it is paid).
    app.db.run(`UPDATE pay_sessions SET status = 'pending' WHERE id = ?`, s.id);
    throw e;
  }
  return { handled: 'paid' };
}

/** The session will not be paid: the held gift card is released, the purpose is told. */
export function lapseSession(app: App, s: PaySession, status: 'failed' | 'expired' | 'cancelled') {
  const n = app.db.run(`UPDATE pay_sessions SET status = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'pending')`, status, now(), s.id).changes;
  if (!n) return;
  app.services.giftCards?.release(s.id);
  purposeOf(app, s.purpose)?.lapse?.(app, { ...s, status });
}

/** Asks the provider for the state of the session (the buyer is back, or an unsigned webhook such as Mollie's said "look"). */
export async function refreshSession(app: App, s: PaySession): Promise<PaySession> {
  if (s.status === 'paid' || !s.provider || !s.provider_ref || s.provider === GIFT_PROVIDER) return s;
  const p = payProviders(app).get(s.provider);
  if (!p) return s;
  const state = await p.fetch(app, s);
  await applyState(app, s, state);
  return getSession(app, s.id)!;
}

/** What a provider reported, applied to the session (`providerId`: the provider of that report – an earlier attempt may be another one). */
export async function applyState(app: App, s: PaySession, state: ProviderState, providerId = s.provider) {
  if (state.status === 'paid') await settleSession(app, s, state, providerId).pending;
  else if (state.status === 'pending') app.db.run(`UPDATE pay_sessions SET status = 'pending', capture_ref = COALESCE(NULLIF(?, ''), capture_ref), updated_at = ? WHERE id = ? AND status = 'open'`, state.capture_ref ?? '', now(), s.id);
  else if (state.status === 'failed' || state.status === 'expired' || state.status === 'cancelled') lapseSession(app, s, state.status);
}

/** Money back through the provider (whole or part of what it charged). The gift-card part is the purpose's business. */
export async function refundSession(app: App, s: PaySession, amountCents?: number): Promise<{ id: string; amount_cents: number }> {
  if (s.status !== 'paid' && s.status !== 'refunded') throw new HttpError(409, 'Nur bezahlte Zahlungen lassen sich erstatten');
  const left = s.received_cents - s.refunded_cents;
  const amount = amountCents === undefined ? left : Math.round(amountCents);
  if (!Number.isInteger(amount) || amount <= 0) throw bad('Der Betrag muss größer als 0 sein');
  if (amount > left) throw bad(`Höchstens ${centsToMoney(left, s.currency)} lassen sich noch erstatten`);
  const p = payProviders(app).get(s.provider);
  if (!p) throw new HttpError(409, 'Diese Zahlung lief nicht über einen Zahlungsanbieter');
  const r = await p.refund(app, s, amount).catch((e) => {
    throw failHttp(e);
  });
  app.db.run(`UPDATE pay_sessions SET refunded_cents = refunded_cents + ?, status = CASE WHEN refunded_cents + ? >= received_cents THEN 'refunded' ELSE status END, updated_at = ? WHERE id = ?`, amount, amount, now(), s.id);
  return { id: r.id, amount_cents: amount };
}

/** A session as the API shows it (no capability URL of the provider). */
export const sessionOut = (app: App, s: PaySession) => ({
  id: s.id,
  provider: s.provider,
  provider_label: s.provider ? providerLabel(app, s.provider) : '',
  purpose: s.purpose,
  ref_id: s.ref_id,
  amount_cents: s.amount_cents,
  gift_cents: s.gift_cents,
  currency: s.currency,
  status: s.status,
  provider_ref: s.provider_ref,
  capture_ref: s.capture_ref,
  received_cents: s.received_cents,
  refunded_cents: s.refunded_cents,
  description: s.description,
  created_at: s.created_at,
  paid_at: s.paid_at,
});

// --- invoices: the existing payment logic ----------------------------------------------------------------------------------

/**
 * Books money that arrived for an invoice through the invoice flow (services/invoice-flow.ts recordPayment, finalising a draft on
 * the way) – the rules of the Stripe payments (docs/stripe.md): never more than is open, less is a part payment, every difference
 * goes to the invoice's trail and the contact's activity so a refund is not forgotten.
 */
export function bookInvoicePayment(app: App, locationId: string, invoiceId: string, o: { amount: number; currency: string; via: string; note?: string }): string {
  const inv = loadInvoice(app, locationId, invoiceId);
  if (!inv || inv.kind !== 'invoice') return 'unknown_invoice';
  const actor: Actor = { id: null, name: `Automatik (${o.via})` };
  const money = (c: number, cur = inv.currency) => centsToMoney(c, String(cur).toUpperCase());
  const flag = (text: string) => {
    invAudit(app, locationId, inv.id, 'payment.mismatch', text, actor);
    if (inv.contact_id) logActivity(app, locationId, inv.contact_id, 'invoice.payment_mismatch', text);
  };
  const open = inv.status !== 'paid' && inv.status !== 'void' ? openCents(inv) : 0;
  const got = `${o.via}-Zahlung über ${money(o.amount, o.currency)}`;
  if (o.currency.toUpperCase() !== String(inv.currency).toUpperCase() || !(o.amount > 0)) {
    flag(`${got} passt nicht zu Rechnung ${inv.number} (${money(open)} offen) – nicht gebucht, bitte prüfen`);
    return 'amount_mismatch';
  }
  if (open <= 0) {
    flag(`${got} für Rechnung ${inv.number}, auf der nichts mehr offen ist – nicht gebucht, bitte erstatten`);
    return 'nothing_open';
  }
  const amount = Math.min(o.amount, open);
  try {
    recordPayment(app, locationId, inv.id, { amount_cents: amount, method: o.via, note: o.note ?? '' }, actor, { source: 'auto', via: o.via });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return 'already_paid';
    throw e;
  }
  if (o.amount > open) flag(`${got} ist mehr als der offene Betrag ${money(open)} – ${money(o.amount - open)} zu viel gezahlt, bitte erstatten`);
  else if (o.amount < open) flag(`${got} ist weniger als der offene Betrag ${money(open)} – als Teilzahlung gebucht, ${money(open - o.amount)} bleiben offen`);
  return o.amount < open ? 'invoice_partially_paid' : 'invoice_paid';
}
