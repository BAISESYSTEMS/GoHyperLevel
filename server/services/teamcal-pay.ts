import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { centsToMoney, id, now, token } from '../core/util.js';
import type { CalendarRow } from '../modules/calendars.js';
import type { Picked } from './teamcal-engine.js';
import { dueNow, type Answer, type TeamCalConfig } from './teamcal-model.js';
import { MIN_AMOUNT_CENTS, StripeError, lineItemParams, stripeRequest } from './stripe.js';

/**
 * Pay when booking (Stripe Checkout with the sub-account's own key). A booking that has to be paid first is a *hold*: the slot
 * is reserved for a while, the customer pays on Stripe's page, and only the confirmed payment turns the hold into an
 * appointment (and an invoice marked paid). Payment confirmation comes by webhook (the Stripe module hands sessions of
 * this module over: app.services.stripeSessions) or, if that is late, when the customer comes back to the confirmation page.
 */

export interface HoldRow {
  id: string;
  location_id: string;
  calendar_id: string;
  token: string;
  start_at: string;
  end_at: string;
  host_ids: string[];
  contact: { first_name: string; last_name: string; email: string; phone: string };
  notes: string;
  answers: Answer[];
  meta: Record<string, string>;
  session_id: string | null;
  session_url: string | null;
  payment_intent: string | null;
  amount_cents: number;
  due_cents: number;
  currency: string;
  mode: 'full' | 'deposit';
  status: 'pending' | 'paid' | 'expired' | 'cancelled' | 'refunded';
  expires_at: string;
  appointment_id: string | null;
  invoice_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export const holdBy = (app: App, col: 'id' | 'token' | 'session_id', v: string): HoldRow | undefined => parseJson(app.db.get<HoldRow>(`SELECT * FROM teamcal_holds WHERE ${col} = ?`, v), ['host_ids', 'contact', 'answers', 'meta']);

const stripeFail = (e: unknown) => (e instanceof StripeError ? new HttpError(e.status === 401 ? 400 : 502, `Stripe: ${e.message}`) : e);

/** Reserves the slot and makes the Stripe Checkout page. Throws German messages (no Stripe key, amount too small, Stripe down). */
export async function startHold(
  app: App,
  cal: CalendarRow,
  cfg: TeamCalConfig,
  o: { start: Date; picked: Picked; contact: HoldRow['contact']; notes: string; answers: Answer[]; meta: Record<string, string> },
): Promise<HoldRow> {
  const key: string = app.services.stripeKey?.(cal.location_id) ?? '';
  // The payment registry (modules/pay-registry.ts): with PayPal/Mollie or gift cards in play the buyer gets the pay page to choose.
  const registry = app.services.payRegistry;
  const viaRegistry = !!registry?.choiceNeeded(cal.location_id) && registry.ready(cal.location_id).length > 0;
  if (!key && !viaRegistry) throw new HttpError(409, 'Die Online-Zahlung ist für diesen Kalender noch nicht eingerichtet (Einstellungen → Stripe)');
  const due = dueNow(cfg.payment);
  if (due < MIN_AMOUNT_CENTS) throw new HttpError(409, 'Der Betrag für die Online-Zahlung ist zu klein');
  const holdId = id();
  const hold: HoldRow = {
    id: holdId,
    location_id: cal.location_id,
    calendar_id: cal.id,
    token: token(18),
    start_at: o.start.toISOString(),
    end_at: new Date(o.start.getTime() + cal.duration * 60_000).toISOString(),
    host_ids: o.picked.hosts,
    contact: o.contact,
    notes: o.notes,
    answers: o.answers,
    meta: o.meta,
    session_id: null,
    session_url: null,
    payment_intent: null,
    amount_cents: cfg.payment.amount_cents,
    due_cents: due,
    currency: cfg.payment.currency,
    mode: cfg.payment.mode === 'deposit' ? 'deposit' : 'full',
    status: 'pending',
    expires_at: new Date(Date.now() + cfg.payment.hold_minutes * 60_000).toISOString(),
    appointment_id: null,
    invoice_id: null,
    created_at: now(),
    paid_at: null,
  };
  app.db.insert('teamcal_holds', hold);
  const base = app.baseUrl();
  const title = cfg.payment.title || cal.name;
  const when = `${formatInTz(hold.start_at, cal.timezone)} (${cal.timezone})`;
  const label = hold.mode === 'deposit' ? `Anzahlung: ${title}` : title;
  const description = [when, hold.mode === 'deposit' ? `Restbetrag ${centsToMoney(hold.amount_cents - hold.due_cents, hold.currency)} wird vor Ort bezahlt.` : ''].filter(Boolean).join(' · ');
  if (viaRegistry) {
    try {
      const s = registry.start({
        locationId: cal.location_id,
        purpose: 'teamcal_hold',
        refId: hold.id,
        amountCents: due,
        currency: hold.currency,
        description: `${label} · ${when}`.slice(0, 200),
        email: hold.contact.email,
        name: [hold.contact.first_name, hold.contact.last_name].filter(Boolean).join(' '),
        lines: [{ name: label.slice(0, 250), qty: 1, unit_cents: due }],
        returnUrl: `${base}/book/paid/${hold.token}`,
        cancelUrl: `${base}/book/paid/${hold.token}?cancelled=1`,
      });
      const url: string = registry.pageUrl(s);
      app.db.run('UPDATE teamcal_holds SET session_id = ?, session_url = ? WHERE id = ?', s.id, url, hold.id);
      return { ...hold, session_id: s.id, session_url: url };
    } catch (e) {
      app.db.run(`UPDATE teamcal_holds SET status = 'cancelled' WHERE id = ?`, hold.id);
      throw e;
    }
  }
  try {
    const session = await stripeRequest(
      key,
      'POST',
      '/v1/checkout/sessions',
      {
        mode: 'payment',
        line_items: lineItemParams([{ name: label.slice(0, 250), description: description.slice(0, 500), unit_amount: due, quantity: 1 }], hold.currency),
        customer_email: hold.contact.email,
        client_reference_id: hold.id,
        success_url: `${base}/book/paid/${hold.token}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/book/paid/${hold.token}?cancelled=1`,
        // Stripe wants 30 minutes to 24 hours: the page outlives the hold by a minute.
        expires_at: Math.floor(Date.now() / 1000) + (cfg.payment.hold_minutes + 1) * 60,
        metadata: { location_id: cal.location_id, teamcal_hold: hold.id, calendar_id: cal.id },
        payment_intent_data: { metadata: { location_id: cal.location_id, teamcal_hold: hold.id }, description: `Termin: ${cal.name} · ${when}` },
      },
      { idempotencyKey: `teamcal-hold-${hold.id}` },
    );
    if (!session?.id || !session?.url) throw new HttpError(502, 'Stripe hat keine Bezahlseite geliefert');
    app.db.run('UPDATE teamcal_holds SET session_id = ?, session_url = ? WHERE id = ?', session.id, session.url, hold.id);
    return { ...hold, session_id: session.id, session_url: session.url };
  } catch (e) {
    app.db.run(`UPDATE teamcal_holds SET status = 'cancelled' WHERE id = ?`, hold.id);
    throw stripeFail(e);
  }
}

/** Asks Stripe whether a session was paid (the customer is back on the confirmation page and the webhook has not arrived). */
export async function fetchSession(app: App, locationId: string, sessionId: string): Promise<any | null> {
  const key: string = app.services.stripeKey?.(locationId) ?? '';
  if (!key || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  try {
    return await stripeRequest(key, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch {
    return null;
  }
}

/** Sends the money back (whole payment). Throws a German message; the idempotency key makes a retry safe. */
export async function refundPayment(app: App, locationId: string, paymentIntent: string, idem: string): Promise<{ id: string }> {
  // Paid through the payment registry (PayPal, Mollie, gift card …): everything back there, the gift-card part onto the card.
  if (paymentIntent.startsWith('ps_') && app.services.payRegistry) return app.services.payRegistry.refundAll(paymentIntent);
  const key: string = app.services.stripeKey?.(locationId) ?? '';
  if (!key) throw new HttpError(409, 'Stripe ist nicht eingerichtet – die Erstattung muss im Stripe-Dashboard erfolgen');
  try {
    const r = await stripeRequest(key, 'POST', '/v1/refunds', { payment_intent: paymentIntent, reason: 'requested_by_customer', metadata: { location_id: locationId } }, { idempotencyKey: idem });
    return { id: String(r?.id ?? '') };
  } catch (e) {
    throw stripeFail(e);
  }
}

/** Ends the Checkout page of a hold nobody paid (the money can no longer arrive for a slot that is released). */
export async function expireSession(app: App, locationId: string, sessionId: string): Promise<void> {
  if (sessionId.startsWith('ps_')) return void app.services.payRegistry?.lapse(sessionId, 'expired');
  const key: string = app.services.stripeKey?.(locationId) ?? '';
  if (!key || !sessionId) return;
  try {
    await stripeRequest(key, 'POST', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {});
  } catch {
    /* already expired or paid: the webhook says which */
  }
}
