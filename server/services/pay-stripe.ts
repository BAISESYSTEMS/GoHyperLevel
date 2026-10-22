import type { App } from '../core/app.js';
import { PayError, type PayProvider, type PaySession, type ProviderState } from './pay-registry.js';
import { StripeError, lineItemParams, stripeRequest } from './stripe.js';

/**
 * Stripe as one provider of the registry (services/pay-registry.ts). The key and webhook stay where they are (Einstellungen →
 * Stripe, modules/stripe.ts); a pay session becomes a Checkout Session with `metadata.pay_session`, which the Stripe webhook hands
 * back through `app.services.stripeSessions` (modules/pay-registry.ts). Invoices' "Jetzt bezahlen", buy links and subscriptions keep
 * their own Stripe code – this adapter is for everything that asks the registry (store, pay page, bookings with a choice).
 */

const keyOf = (app: App, locationId: string): string => app.services.stripeKey?.(locationId) ?? '';
const wrap = (e: unknown) => (e instanceof StripeError ? new PayError(e.status, `Stripe: ${e.message}`) : e);

export const stripeProvider: PayProvider = {
  id: 'stripe',
  label: 'Stripe',
  methods: () => ['Karte', 'SEPA-Lastschrift', 'Apple Pay', 'Google Pay'],
  ready: (app, locationId) => !!keyOf(app, locationId),
  async create(app: App, s: PaySession) {
    const base = app.baseUrl();
    const meta = { location_id: s.location_id, pay_session: s.id };
    try {
      const session = await stripeRequest(
        keyOf(app, s.location_id),
        'POST',
        '/v1/checkout/sessions',
        {
          mode: 'payment',
          line_items: lineItemParams([{ name: s.description.slice(0, 250) || 'Zahlung', unit_amount: s.amount_cents, quantity: 1 }], s.currency),
          ...(s.meta.email ? { customer_email: s.meta.email } : {}),
          client_reference_id: s.id,
          success_url: `${base}/pay/${s.id}/return?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/pay/${s.id}/cancel`,
          metadata: meta,
          payment_intent_data: { metadata: meta, description: s.description.slice(0, 200) },
        },
        { idempotencyKey: `pay-${s.id}-${s.amount_cents}` },
      );
      return { provider_ref: String(session?.id ?? ''), url: String(session?.url ?? '') };
    } catch (e) {
      throw wrap(e);
    }
  },
  async fetch(app: App, s: PaySession): Promise<ProviderState> {
    try {
      const cs = await stripeRequest(keyOf(app, s.location_id), 'GET', `/v1/checkout/sessions/${encodeURIComponent(s.provider_ref)}`);
      return sessionState(cs);
    } catch (e) {
      throw wrap(e);
    }
  },
  async refund(app: App, s: PaySession, amountCents: number) {
    if (!s.capture_ref) throw new PayError(409, 'Zu dieser Stripe-Zahlung fehlt die Zahlungsreferenz – bitte im Stripe-Dashboard erstatten');
    try {
      const r = await stripeRequest(keyOf(app, s.location_id), 'POST', '/v1/refunds', { payment_intent: s.capture_ref, amount: amountCents, metadata: { location_id: s.location_id, pay_session: s.id } }, { idempotencyKey: `pay-refund-${s.id}-${s.refunded_cents}-${amountCents}` });
      return { id: String(r?.id ?? '') };
    } catch (e) {
      throw wrap(e);
    }
  },
};

/** A Checkout Session (webhook object or GET) → the registry's state. */
export function sessionState(cs: any): ProviderState {
  const capture = typeof cs?.payment_intent === 'string' ? cs.payment_intent : (cs?.payment_intent?.id ?? '');
  const base = { amount_cents: Number(cs?.amount_total ?? 0), currency: String(cs?.currency ?? '').toUpperCase() || undefined, capture_ref: capture };
  if (cs?.payment_status === 'paid' || cs?.payment_status === 'no_payment_required') return { status: 'paid', ...base };
  if (cs?.status === 'expired') return { status: 'expired', ...base };
  // Delayed methods (SEPA Direct Debit): complete now, money confirmed later.
  if (cs?.status === 'complete') return { status: 'pending', ...base };
  return { status: 'open', ...base };
}
