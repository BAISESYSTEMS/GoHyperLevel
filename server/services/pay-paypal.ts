import type { App } from '../core/app.js';
import { PayError, accountOf, amountValue, centsOf, payJson, type Account, type PayProvider, type PaySession, type ProviderState } from './pay-registry.js';

/**
 * PayPal through the Orders API v2 (docs/payment-providers.md#paypal): a pay session becomes an order with intent CAPTURE, the buyer
 * approves it on PayPal's page (PayPal balance, card, SEPA, and **Pay Later** – "Später bezahlen" / "Ratenzahlung" – for buyers PayPal
 * finds eligible), the order is captured when they come back or when the webhook CHECKOUT.ORDER.APPROVED arrives, and
 * PAYMENT.CAPTURE.COMPLETED settles the session. Webhooks are verified with PayPal's verify-webhook-signature call. Refunds go to
 * the capture. Credentials per sub-account: client id, secret, webhook id, sandbox or live.
 */

export const PAYPAL_EVENTS = ['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.REFUNDED'];

const apiOf = (acc: Account) => (acc.options.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(app: App, acc: Account): Promise<string> {
  const cacheKey = `${apiOf(acc)}|${acc.secrets.client_id}|${acc.secrets.client_secret?.slice(-6)}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.token;
  const j = await payJson(app, 'PayPal', `${apiOf(acc)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${acc.secrets.client_id}:${acc.secrets.client_secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: 'grant_type=client_credentials',
  });
  if (!j.access_token) throw new PayError(502, 'PayPal hat kein Zugriffstoken geliefert');
  tokens.set(cacheKey, { token: String(j.access_token), until: Date.now() + Math.max(60, Number(j.expires_in ?? 3000) - 120) * 1000 });
  if (tokens.size > 2000) tokens.clear();
  return String(j.access_token);
}

/** One call to the PayPal REST API with the sub-account's credentials. */
export async function paypalApi(app: App, acc: Account, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const tok = await accessToken(app, acc);
  return payJson(app, 'PayPal', `${apiOf(acc)}${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json', prefer: 'return=representation', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const accOf = (app: App, locationId: string): Account => {
  const a = accountOf(app, locationId, 'paypal');
  if (!a?.secrets.client_id || !a.secrets.client_secret) throw new PayError(409, 'PayPal ist für diesen Sub-Account nicht eingerichtet');
  return a;
};

/** Proves the credentials (an access token) – for the settings page. */
export async function testPaypal(app: App, acc: Account): Promise<{ ok: true; mode: string }> {
  tokens.clear();
  await accessToken(app, acc);
  return { ok: true, mode: acc.options.mode === 'live' ? 'live' : 'sandbox' };
}

/** An order (GET or the capture answer) → the registry's state. */
export function orderState(o: any): ProviderState {
  const cap = o?.purchase_units?.[0]?.payments?.captures?.[0];
  const amount = cap?.amount ?? o?.purchase_units?.[0]?.amount;
  const base = { amount_cents: amount?.value !== undefined ? centsOf(amount.value) : undefined, currency: amount?.currency_code, capture_ref: cap?.id ?? '' };
  if (o?.status === 'COMPLETED') {
    if (!cap || cap.status === 'COMPLETED') return { status: 'paid', ...base };
    if (cap.status === 'PENDING') return { status: 'pending', ...base };
    return { status: 'failed', ...base };
  }
  if (o?.status === 'VOIDED') return { status: 'cancelled', ...base };
  return { status: 'open', ...base };
}

/** Captures an approved order; an order captured by someone else meanwhile (webhook vs. return) is read instead. */
export async function captureOrder(app: App, acc: Account, orderId: string): Promise<ProviderState> {
  try {
    return orderState(await paypalApi(app, acc, 'POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { 'paypal-request-id': `cap-${orderId}` }));
  } catch (e) {
    if (e instanceof PayError && e.status === 422) return orderState(await paypalApi(app, acc, 'GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`));
    throw e;
  }
}

/** PayPal's own check of a webhook delivery (the headers and the event as sent). */
export async function verifyPaypalWebhook(app: App, acc: Account, headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
  const h = (k: string) => String(headers[k] ?? '');
  if (!acc.secrets.webhook_id || !h('paypal-transmission-id') || !h('paypal-transmission-sig')) return false;
  const r = await paypalApi(app, acc, 'POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: acc.secrets.webhook_id,
    webhook_event: event,
  });
  return r?.verification_status === 'SUCCESS';
}

export const paypalProvider: PayProvider = {
  id: 'paypal',
  label: 'PayPal',
  methods: (app, locationId) => ['PayPal', ...(accountOf(app, locationId, 'paypal')?.options.pay_later === false ? [] : ['Später bezahlen'])],
  ready: (app, locationId) => {
    const a = accountOf(app, locationId, 'paypal');
    return !!(a?.secrets.client_id && a.secrets.client_secret);
  },
  async create(app: App, s: PaySession) {
    const acc = accOf(app, s.location_id);
    const base = app.baseUrl();
    const loc = app.location(s.location_id);
    const order = await paypalApi(
      app,
      acc,
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: s.id.slice(0, 256), custom_id: s.id.slice(0, 127), description: s.description.slice(0, 127), amount: { currency_code: s.currency, value: amountValue(s.amount_cents) } }],
        payment_source: {
          paypal: {
            ...(s.meta.email ? { email_address: s.meta.email } : {}),
            experience_context: {
              brand_name: String(loc?.name ?? '').slice(0, 127) || undefined,
              locale: 'de-DE',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${base}/pay/${s.id}/return`,
              cancel_url: `${base}/pay/${s.id}/cancel`,
            },
          },
        },
      },
      { 'paypal-request-id': `ord-${s.id}-${s.amount_cents}` },
    );
    const link = (order?.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve');
    return { provider_ref: String(order?.id ?? ''), url: String(link?.href ?? '') };
  },
  async fetch(app: App, s: PaySession) {
    const acc = accOf(app, s.location_id);
    const o = await paypalApi(app, acc, 'GET', `/v2/checkout/orders/${encodeURIComponent(s.provider_ref)}`);
    // Approved on PayPal's page but not yet captured: the buyer is back, so the money is taken now.
    if (o?.status === 'APPROVED') return captureOrder(app, acc, s.provider_ref);
    return orderState(o);
  },
  async refund(app: App, s: PaySession, amountCents: number) {
    const acc = accOf(app, s.location_id);
    if (!s.capture_ref) throw new PayError(409, 'Zu dieser PayPal-Zahlung fehlt die Capture-ID – bitte bei PayPal erstatten');
    const r = await paypalApi(app, acc, 'POST', `/v2/payments/captures/${encodeURIComponent(s.capture_ref)}/refund`, { amount: { value: amountValue(amountCents), currency_code: s.currency } }, { 'paypal-request-id': `ref-${s.id}-${s.refunded_cents}-${amountCents}` });
    return { id: String(r?.id ?? '') };
  },
};
