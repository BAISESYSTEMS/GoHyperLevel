import { signStripePayload } from '../server/services/stripe.js';
import type { startTestApp } from './helpers.js';

/**
 * Fakes shared by the Creator & Commerce tests: a small Stripe API (Checkout, subscriptions, coupons, invoices, Billing Portal,
 * setup sessions) that records every call, and helpers to deliver signed webhook events.
 */

export const KEY = 'sk_test_51FakeKeyForTests000abcd';
export const WHSEC = 'whsec_testSigningSecret0000000';

export type Call = { method: string; path: string; params: URLSearchParams; idem: string };

export function fakeStripe() {
  const calls: Call[] = [];
  const sessions = new Map<string, any>();
  const subs = new Map<string, any>();
  const invoices = new Map<string, any>();
  const state = { seq: 0, portal: 'ok' as 'ok' | 'missing', payResult: 'paid' as 'paid' | 'failed', start: Math.floor(Date.UTC(2026, 9, 5, 10) / 1000) };
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const handler = (async (url: string, init: any) => {
    const u = new URL(url);
    const params = new URLSearchParams(init.body ?? u.search.slice(1));
    calls.push({ method: init.method, path: u.pathname, params, idem: init.headers['idempotency-key'] ?? '' });
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Shop' } } });
    if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
      const id = `cs_test_c${++state.seq}`;
      const metadata: Record<string, string> = {};
      for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
      let total = 0;
      for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][quantity]`)) * Number(params.get(`line_items[${i}][price_data][unit_amount]`));
      const s = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: total, currency: 'eur', payment_status: 'unpaid', status: 'open', customer: params.get('customer') };
      sessions.set(id, s);
      return json(s);
    }
    if (parts[1] === 'checkout' && parts[2] === 'sessions' && parts[3]) {
      const s = sessions.get(parts[3]);
      if (!s) return json({ error: { message: 'No such checkout.session' } }, 404);
      // A finished setup session carries the new payment method (expanded setup_intent).
      if (s.mode === 'setup' && params.get('expand[]') === 'setup_intent') return json({ ...s, status: 'complete', setup_intent: { id: 'seti_1', payment_method: 'pm_new_card' } });
      return json(s);
    }
    if (u.pathname === '/v1/coupons' && init.method === 'POST') return json({ id: `co_${++state.seq}`, amount_off: Number(params.get('amount_off')), duration: params.get('duration') });
    if (parts[1] === 'subscriptions' && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      const sub = subs.get(id) ?? { id, object: 'subscription', status: 'active', customer: 'cus_1', start_date: state.start, created: state.start, metadata: {}, items: { data: [{ id: 'si_1', price: { id: 'price_1', unit_amount: 9900, recurring: { interval: 'month' } } }] } };
      subs.set(id, sub);
      if (init.method === 'GET') return json(sub);
      if (init.method === 'DELETE') {
        sub.status = 'canceled';
        return json(sub);
      }
      if (sub.status === 'canceled') return json({ error: { message: 'A canceled subscription can only update its cancellation_details.' } }, 400);
      for (const [k, v] of params) {
        if (k === 'cancel_at') sub.cancel_at = Number(v);
        else if (k === 'cancel_at_period_end') sub.cancel_at_period_end = v === 'true';
        else if (k.startsWith('pause_collection')) sub.pause_collection = v === '' ? null : { behavior: params.get('pause_collection[behavior]') };
        else if (k === 'default_payment_method') sub.default_payment_method = v;
      }
      if (params.get('pause_collection') === '') sub.pause_collection = null;
      return json(sub);
    }
    if (parts[1] === 'invoices' && parts[2] && parts[3] === 'pay') {
      const inv = invoices.get(parts[2]);
      if (state.payResult === 'failed') return json({ error: { message: 'Your card was declined.', code: 'card_declined' } }, 402);
      if (inv) inv.status = 'paid';
      return json(inv ?? { id: parts[2], status: 'paid' });
    }
    if (parts[1] === 'invoices' && parts[2]) return json(invoices.get(parts[2]) ?? { error: { message: 'No such invoice' } }, invoices.has(parts[2]) ? 200 : 404);
    if (u.pathname === '/v1/invoices' && init.method === 'GET') {
      const sub = params.get('subscription');
      const status = params.get('status');
      return json({ data: [...invoices.values()].filter((i) => (!sub || i.subscription === sub) && (!status || i.status === status)) });
    }
    if (u.pathname === '/v1/billing_portal/sessions' && init.method === 'POST') {
      if (state.portal === 'missing') return json({ error: { message: 'No configuration provided and your test mode default configuration has not been created.' } }, 400);
      return json({ id: `bps_${++state.seq}`, url: `https://billing.stripe.com/p/session/${state.seq}` });
    }
    if (parts[1] === 'customers' && parts[2] && init.method === 'POST') return json({ id: parts[2] });
    return json({ error: { message: `unknown endpoint ${init.method} ${u.pathname}` } }, 404);
  }) as any;
  return { handler, calls, sessions, subs, invoices, state, last: (path: string, method = 'POST') => [...calls].reverse().find((c) => c.path === path && c.method === method) };
}

type T = Awaited<ReturnType<typeof startTestApp>>;

/** Delivers a signed Stripe event to the sub-account's webhook and waits for the events it emits. */
export async function sendEvent(t: T, type: string, object: any, id = `evt_${Math.random().toString(36).slice(2)}`) {
  const raw = JSON.stringify({ id, type, data: { object } });
  const r = await t.api.raw(`/hooks/stripe/${t.api.location}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return { status: r.status, data: (await r.json()) as any };
}

export const formPost = (body: Record<string, string>) => ({ method: 'POST', redirect: 'manual' as const, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

/** The Stripe invoice object a subscription renewal sends (API version with `parent.subscription_details`). */
export const stripeInvoice = (o: { id: string; sub: string; amount: number; metadata?: Record<string, any>; reason?: string; customer?: string; email?: string; next?: number | null; attempt?: number; status?: string }) => ({
  id: o.id,
  object: 'invoice',
  customer: o.customer ?? 'cus_1',
  customer_email: o.email ?? 'kim@kunde.de',
  currency: 'eur',
  amount_paid: o.amount,
  amount_due: o.amount,
  billing_reason: o.reason ?? 'subscription_cycle',
  status: o.status ?? 'paid',
  attempt_count: o.attempt ?? 1,
  next_payment_attempt: o.next === undefined ? null : o.next,
  subscription: o.sub,
  parent: { subscription_details: { subscription: o.sub, metadata: o.metadata ?? {} } },
});
