import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { mollieLines, paymentState } from '../server/services/pay-mollie.js';
import { orderState } from '../server/services/pay-paypal.js';
import { amountValue, bookInvoicePayment } from '../server/services/pay-registry.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { zonedToUtc } from '../server/core/time.js';

/**
 * Payment provider registry (docs/payment-providers.md): PayPal (Orders v2, webhook verification, capture, refund) and Mollie
 * (Payments API, unsigned webhook read back from the API) against fakes, Stripe through the registry, invoices paid through the
 * existing invoice payment logic, buy links with another provider, bookings through the pay page. No network.
 */

const STRIPE_KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';
const PP = { client_id: 'AfakeClientIdForTests0000000000', client_secret: 'EfakeSecretForTests000000000000', webhook_id: 'WH-FAKE-12345' };
const MOLLIE_KEY = 'test_fakeMollieKeyForTests00000000';

// --- fake PayPal + Mollie (app.services.payFetch) ---------------------------------------------------------------------------------
const calls: { method: string; url: string; body: any; headers: Record<string, string> }[] = [];
const orders = new Map<string, any>();
const payments = new Map<string, any>();
let n = 0;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const payFake = async (url: string, init: any) => {
  const u = new URL(url);
  const body = init.body && init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : init.body;
  calls.push({ method: init.method, url, body, headers: init.headers });
  if (u.hostname === 'api-m.sandbox.paypal.com') {
    if (u.pathname === '/v1/oauth2/token') {
      return init.headers.authorization === `Basic ${Buffer.from(`${PP.client_id}:${PP.client_secret}`).toString('base64')}` ? json({ access_token: 'A21-fake-token', expires_in: 32400 }) : json({ error: 'invalid_client', error_description: 'Client Authentication failed' }, 401);
    }
    if (init.headers.authorization !== 'Bearer A21-fake-token') return json({ message: 'unauthorized' }, 401);
    if (u.pathname === '/v2/checkout/orders' && init.method === 'POST') {
      const id = `ORD${++n}`;
      const o = { id, status: 'PAYER_ACTION_REQUIRED', purchase_units: body.purchase_units, links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] };
      orders.set(id, o);
      return json(o, 201);
    }
    const om = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (om) {
      const o = orders.get(om[1]);
      if (!o) return json({ name: 'RESOURCE_NOT_FOUND' }, 404);
      if (om[2]) {
        if (o.status === 'COMPLETED') return json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, 422);
        if (o.status !== 'APPROVED') return json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
        o.status = 'COMPLETED';
        o.purchase_units[0].payments = { captures: [{ id: `CAP${++n}`, status: 'COMPLETED', amount: o.purchase_units[0].amount }] };
      }
      return json(o);
    }
    if (u.pathname === '/v1/notifications/verify-webhook-signature') return json({ verification_status: body.transmission_sig === 'good-signature' && body.webhook_id === PP.webhook_id ? 'SUCCESS' : 'FAILURE' });
    const rm = u.pathname.match(/^\/v2\/payments\/captures\/([^/]+)\/refund$/);
    if (rm) return json({ id: `REF${++n}`, status: 'COMPLETED', amount: body.amount }, 201);
  }
  if (u.hostname === 'api.mollie.com') {
    if (init.headers.authorization !== `Bearer ${MOLLIE_KEY}`) return json({ status: 401, title: 'Unauthorized Request', detail: 'Missing authentication, or failed to authenticate' }, 401);
    if (u.pathname === '/v2/methods') return json({ _embedded: { methods: [{ id: 'ideal' }, { id: 'creditcard' }, { id: 'klarna' }] } });
    if (u.pathname === '/v2/payments' && init.method === 'POST') {
      const id = `tr_fake${++n}`;
      const p = { id, status: 'open', amount: body.amount, description: body.description, metadata: body.metadata, method: body.method ?? null, lines: body.lines, _links: { checkout: { href: `https://www.mollie.com/checkout/select-method/${id}` } } };
      payments.set(id, p);
      return json(p, 201);
    }
    const pm = u.pathname.match(/^\/v2\/payments\/([^/]+)(\/refunds|\/captures)?$/);
    if (pm) {
      const p = payments.get(pm[1]);
      if (!p) return json({ status: 404, title: 'Not Found' }, 404);
      if (pm[2] === '/refunds') return json({ id: `re_fake${++n}`, amount: body.amount, status: 'pending' }, 201);
      if (pm[2] === '/captures') p.status = 'paid';
      return json(p);
    }
  }
  return json({ message: `unknown endpoint ${url}` }, 404);
};

// --- fake Stripe ---------------------------------------------------------------------------------------------------------------------
const stripeSessions = new Map<string, any>();
const stripeFake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  if (init.headers.authorization !== `Bearer ${STRIPE_KEY}`) return json({ error: { message: 'Invalid API Key provided' } }, 401);
  if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Laden' } }, country: 'DE', charges_enabled: true });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_reg${++n}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, metadata, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), currency: 'eur', payment_status: 'unpaid', status: 'open', payment_intent: `pi_reg${n}` };
    stripeSessions.set(id, s);
    return json(s);
  }
  const m = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
  if (m) return stripeSessions.has(m[1]) ? json(stripeSessions.get(m[1])) : json({ error: { message: 'No such session' } }, 404);
  if (u.pathname === '/v1/refunds') return json({ id: `re_${++n}` });
  return json({ error: { message: 'unknown' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let chef = '';
const events: { type: string; data: any }[] = [];
beforeAll(async () => {
  setStripeFetch(stripeFake);
  t = await startTestApp();
  t.app.services.payFetch = payFake;
  chef = (await t.setup()).user.id;
  loc = t.api.location;
  await t.api.put('/api/invoice-settings', { iban: 'DE89370400440532013000', bic: 'COBADEFFXXX', street: 'Hauptstr. 1', postal_code: '10115', city: 'Berlin', contact_name: 'Chef', contact_email: 'chef@example.com', contact_phone: '030 123456' });
  for (const type of ['invoice.paid', 'product.purchased', 'payment.refunded', 'appointment.booked']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  setStripeFetch();
  await t?.close();
});

const settle = async () => {
  await t.app.events.flush();
  await Promise.all([...(t.app.services.collabPending ?? [])]);
};
async function invoice(total = 11900) {
  const inv = (await t.api.post('/api/invoices', { title: 'Beratung', items: [{ name: 'Beratung', qty: 1, price_cents: Math.round(total / 1.19), tax_rate: 19 }] })).data;
  const fin = await t.api.post(`/api/invoices/${inv.id}/finalise`, {});
  expect(fin.status, JSON.stringify(fin.data)).toBe(200);
  return t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', inv.id)!;
}
const sessionOf = (id: string) => t.app.db.get<any>('SELECT * FROM pay_sessions WHERE id = ?', id)!;
const loc303 = (r: { status: number; headers: Headers }) => {
  expect(r.status).toBe(303);
  return r.headers.get('location')!;
};
async function paypalHook(type: string, resource: any, sig = 'good-signature') {
  const raw = JSON.stringify({ id: `WH-EVT-${++n}`, event_type: type, resource });
  const r = await t.api.raw(`/hooks/paypal/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'paypal-transmission-id': `tx-${n}`, 'paypal-transmission-sig': sig, 'paypal-transmission-time': new Date().toISOString(), 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1' }, body: raw });
  await settle();
  return { status: r.status, data: (await r.json()) as any };
}
async function mollieHook(id: string) {
  const r = await t.api.raw(`/hooks/mollie/${loc}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${id}` });
  await settle();
  return { status: r.status, data: (await r.json()) as any };
}

describe('pure parts', () => {
  it('amounts, PayPal orders and Mollie payments map onto the registry states', () => {
    expect(amountValue(11900)).toBe('119.00');
    expect(amountValue(5)).toBe('0.05');
    expect(orderState({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { value: '12.30', currency_code: 'EUR' } }] } }] })).toEqual({ status: 'paid', amount_cents: 1230, currency: 'EUR', capture_ref: 'C1' });
    expect(orderState({ status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'PENDING', amount: { value: '1.00', currency_code: 'EUR' } }] } }] }).status).toBe('pending');
    expect(orderState({ status: 'PAYER_ACTION_REQUIRED', purchase_units: [{ amount: { value: '1.00' } }] }).status).toBe('open');
    expect(paymentState({ id: 'tr_1', status: 'paid', amount: { value: '9.99', currency: 'EUR' } })).toEqual({ status: 'paid', amount_cents: 999, currency: 'EUR', capture_ref: 'tr_1' });
    expect(paymentState({ status: 'canceled' }).status).toBe('cancelled');
    expect(paymentState({ status: 'authorized' }).status).toBe('pending');
  });

  it('Mollie gets order lines (Klarna) only when they add up to the amount exactly', () => {
    const lines = mollieLines([{ name: 'Tasse', qty: 2, unit_cents: 1190, tax_rate: 19 }, { name: 'Versand', qty: 1, unit_cents: 490, tax_rate: 19 }], 2870, 'EUR')!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ description: 'Tasse', quantity: 2, unitPrice: { currency: 'EUR', value: '11.90' }, totalAmount: { currency: 'EUR', value: '23.80' }, vatRate: '19.00', vatAmount: { currency: 'EUR', value: '3.80' } });
    expect(mollieLines([{ name: 'Tasse', qty: 2, unit_cents: 1190, tax_rate: 19 }], 2000, 'EUR')).toBeUndefined();
    expect(mollieLines(undefined, 100, 'EUR')).toBeUndefined();
  });
});

describe('settings', () => {
  it('checks PayPal credentials on save, seals them and never sends them back', async () => {
    const bad = await t.api.put('/api/pay/providers/paypal', { ...PP, client_secret: 'EwrongSecretForTests00000000000' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/PayPal lehnt die Zugangsdaten ab/);
    const ok = await t.api.put('/api/pay/providers/paypal', { ...PP, mode: 'sandbox' });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const pp = ok.data.providers.find((p: any) => p.id === 'paypal');
    expect(pp).toMatchObject({ ready: true, webhook_set: true, options: { mode: 'sandbox', pay_later: true }, webhook_url: `http://localhost/hooks/paypal/${loc}` });
    expect(pp.methods).toEqual(['PayPal', 'Später bezahlen']);
    expect(JSON.stringify(ok.data)).not.toContain(PP.client_secret);
    expect(JSON.stringify(ok.data)).not.toContain(PP.client_id);
    const row = t.app.db.get<any>('SELECT secrets FROM pay_accounts WHERE location_id = ? AND provider = ?', loc, 'paypal')!;
    expect(row.secrets).toMatch(/^v\d:/);
    expect(row.secrets).not.toContain(PP.client_secret);
    // saving again without the secrets keeps them
    expect((await t.api.put('/api/pay/providers/paypal', { client_secret: '••••••', pay_later: true })).status).toBe(200);
    expect((await t.api.post('/api/pay/providers/paypal/test', {})).data).toEqual({ ok: true, mode: 'sandbox' });
  });

  it('checks the Mollie key and its methods', async () => {
    expect((await t.api.put('/api/pay/providers/mollie', { api_key: 'nope' })).data.error).toMatch(/live_ oder test_/);
    expect((await t.api.put('/api/pay/providers/mollie', { api_key: 'test_wrongMollieKeyForTests000000' })).status).toBe(400);
    const ok = await t.api.put('/api/pay/providers/mollie', { api_key: MOLLIE_KEY });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.providers.find((p: any) => p.id === 'mollie')).toMatchObject({ ready: true, methods: ['iDEAL', 'Kreditkarte', 'SEPA-Überweisung', 'Klarna'] });
    expect((await t.api.post('/api/pay/providers/mollie/test', {})).data).toMatchObject({ ok: true, mode: 'test', methods: ['ideal', 'creditcard', 'klarna'] });
    expect((await t.api.put('/api/pay/providers/stripe', {})).status).toBe(404);
  });
});

describe('invoices through the registry', () => {
  it('PayPal: the invoice page offers it, the pay page sends the buyer to PayPal, the webhook captures and books the payment', async () => {
    const inv = await invoice(11900);
    const page = (await t.api.get(`/i/${inv.public_token}`)).data as string;
    expect(page).toContain('Jetzt online bezahlen');
    expect(page).toContain('Später bezahlen');
    const pay = loc303(await t.api.post(`/i/${inv.public_token}/pay-options`, {}, { 'content-type': 'application/x-www-form-urlencoded' }));
    expect(pay).toMatch(/^\/pay\/ps_/);
    const sid = pay.split('/')[2];
    const pp = (await t.api.get(pay)).data as string;
    expect(pp).toContain('119,00');
    expect(pp).toContain('Weiter mit PayPal');
    expect(pp).toContain('Weiter mit Mollie');
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=paypal', redirect: 'manual' });
    expect(go.headers.get('location')).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=ORD/);
    const s = sessionOf(sid);
    const order = orders.get(s.provider_ref)!;
    expect(order.purchase_units[0]).toMatchObject({ custom_id: sid, amount: { currency_code: 'EUR', value: '119.00' } });
    const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(create.body.payment_source.paypal.experience_context).toMatchObject({ return_url: `http://localhost/pay/${sid}/return`, cancel_url: `http://localhost/pay/${sid}/cancel`, user_action: 'PAY_NOW' });
    // a forged webhook is refused
    expect((await paypalHook('CHECKOUT.ORDER.APPROVED', { id: order.id }, 'forged')).status).toBe(400);
    expect(sessionOf(sid).status).toBe('open');
    // the buyer approved on PayPal: the webhook captures
    order.status = 'APPROVED';
    const r = await paypalHook('CHECKOUT.ORDER.APPROVED', { id: order.id });
    expect(r).toMatchObject({ status: 200, data: { handled: 'captured' } });
    expect(sessionOf(sid)).toMatchObject({ status: 'paid', provider: 'paypal', received_cents: 11900, capture_ref: expect.stringMatching(/^CAP/) });
    const after = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', inv.id)!;
    expect(after).toMatchObject({ status: 'paid', paid_cents: 11900 });
    expect(t.app.db.get<any>('SELECT method, amount_cents, source FROM invoice_payments WHERE invoice_id = ?', inv.id)).toEqual({ method: 'PayPal', amount_cents: 11900, source: 'auto' });
    expect(events.some((e) => e.type === 'invoice.paid' && e.data.invoice.id === inv.id && e.data.via === 'PayPal')).toBe(true);
    // the capture event and the buyer's return change nothing any more
    const cap = order.purchase_units[0].payments.captures[0];
    expect((await paypalHook('PAYMENT.CAPTURE.COMPLETED', { id: cap.id, amount: cap.amount, supplementary_data: { related_ids: { order_id: order.id } } })).status).toBe(200);
    const back = await t.api.raw(`/pay/${sid}/return?token=${order.id}`, { redirect: 'manual' });
    expect(back.headers.get('location')).toBe(`http://localhost/i/${inv.public_token}`);
    expect(t.app.db.all('SELECT id FROM invoice_payments WHERE invoice_id = ?', inv.id)).toHaveLength(1);
    // refund through the registry goes to the capture
    const ref = await t.api.post(`/api/pay/sessions/${sid}/refund`, { amount_cents: 1900 });
    expect(ref.status, JSON.stringify(ref.data)).toBe(200);
    expect(ref.data).toMatchObject({ refunded_cents: 1900, status: 'paid', refund_id: expect.stringMatching(/^REF/) });
    expect(calls.at(-1)).toMatchObject({ url: `https://api-m.sandbox.paypal.com/v2/payments/captures/${cap.id}/refund`, body: { amount: { value: '19.00', currency_code: 'EUR' } } });
    expect((await t.api.post(`/api/pay/sessions/${sid}/refund`, { amount_cents: 20000 })).data.error).toMatch(/Höchstens 100,00/);
    expect((await t.api.post(`/api/pay/sessions/${sid}/refund`, {})).data.status).toBe('refunded');
    await settle();
    expect(events.filter((e) => e.type === 'payment.refunded')).toHaveLength(2);
  });

  it('Mollie: the return asks Mollie, the unsigned webhook only reads back from Mollie', async () => {
    const inv = await invoice(5950);
    const sid = loc303(await t.api.post(`/i/${inv.public_token}/pay-options`, {})).split('/')[2];
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=mollie', redirect: 'manual' });
    expect(go.headers.get('location')).toMatch(/^https:\/\/www\.mollie\.com\/checkout\/select-method\/tr_fake/);
    const s = sessionOf(sid);
    const p = payments.get(s.provider_ref)!;
    expect(p).toMatchObject({ amount: { currency: 'EUR', value: '59.50' }, metadata: { pay_session: sid } });
    expect(calls.find((c) => c.url === 'https://api.mollie.com/v2/payments' && c.body.metadata.pay_session === sid)!.body).toMatchObject({ webhookUrl: `http://localhost/hooks/mollie/${loc}`, redirectUrl: `http://localhost/pay/${sid}/return`, locale: 'de_DE' });
    // unknown ids and still-open payments do nothing
    expect((await mollieHook('tr_unknown1')).data).toMatchObject({ received: true, handled: 'ignored' });
    expect((await mollieHook(p.id)).data.handled).toBe('open');
    expect(t.app.db.get<any>('SELECT status FROM invoices WHERE id = ?', inv.id)!.status).toBe('sent');
    // the buyer paid with iDEAL and comes back before the webhook
    p.status = 'paid';
    const back = await t.api.raw(`/pay/${sid}/return`, { redirect: 'manual' });
    expect(back.headers.get('location')).toBe(`http://localhost/i/${inv.public_token}`);
    expect(t.app.db.get<any>('SELECT status, paid_cents FROM invoices WHERE id = ?', inv.id)).toEqual({ status: 'paid', paid_cents: 5950 });
    expect((await mollieHook(p.id)).data.handled).toBe('ignored');
    expect(t.app.db.all('SELECT id FROM invoice_payments WHERE invoice_id = ?', inv.id)).toHaveLength(1);
  });

  it('books what arrives, never more than is open, and flags differences (the Stripe rules)', async () => {
    const inv = await invoice(10000);
    expect(bookInvoicePayment(t.app, loc, inv.id, { amount: 4000, currency: 'EUR', via: 'Mollie' })).toBe('invoice_partially_paid');
    expect(bookInvoicePayment(t.app, loc, inv.id, { amount: 9000, currency: 'EUR', via: 'Mollie' })).toBe('invoice_paid');
    expect(t.app.db.get<any>('SELECT status, paid_cents FROM invoices WHERE id = ?', inv.id)).toEqual({ status: 'paid', paid_cents: 10000 });
    expect(bookInvoicePayment(t.app, loc, inv.id, { amount: 100, currency: 'EUR', via: 'Mollie' })).toBe('nothing_open');
    const trail = t.app.db.all<any>(`SELECT detail FROM invoice_audit WHERE invoice_id = ? AND action = 'payment.mismatch'`, inv.id).map((r) => r.detail);
    expect(trail).toEqual([expect.stringContaining('weniger als der offene Betrag'), expect.stringContaining('zu viel gezahlt'), expect.stringContaining('nichts mehr offen')]);
  });

  it('Stripe as a registry provider: Checkout Session with the pay session, settled by the Stripe webhook', async () => {
    expect((await t.api.put('/api/stripe', { secret_key: STRIPE_KEY, webhook_secret: WHSEC })).status).toBe(200);
    const inv = await invoice(2380);
    const page = (await t.api.get(`/i/${inv.public_token}`)).data as string;
    // Stripe's own button stays, the registry adds the others
    expect(page).toContain('Jetzt bezahlen (Karte, SEPA, Apple Pay');
    expect(page).toContain('Mit PayPal oder Mollie bezahlen');
    const sid = loc303(await t.api.post(`/i/${inv.public_token}/pay-options`, {})).split('/')[2];
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=stripe', redirect: 'manual' });
    expect(go.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_reg/);
    const cs = stripeSessions.get(sessionOf(sid).provider_ref)!;
    expect(cs.metadata).toEqual({ location_id: loc, pay_session: sid });
    Object.assign(cs, { payment_status: 'paid', status: 'complete' });
    const raw = JSON.stringify({ id: `evt_reg${++n}`, type: 'checkout.session.completed', data: { object: cs } });
    const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
    expect(await r.json()).toMatchObject({ handled: 'pay_session' });
    await settle();
    expect(sessionOf(sid)).toMatchObject({ status: 'paid', provider: 'stripe', capture_ref: cs.payment_intent });
    expect(t.app.db.get<any>('SELECT status FROM invoices WHERE id = ?', inv.id)!.status).toBe('paid');
  });
});

describe('buy links with another provider', () => {
  it('offers PayPal next to Stripe on /buy/<product> and completes the purchase like a Stripe one', async () => {
    const p = (await t.api.post('/api/products', { name: 'Online-Kurs', price_cents: 10000, tax_rate: 19 })).data;
    const page = (await t.api.get(`/buy/${p.id}`)).data as string;
    expect(page).toContain('name="provider" value="stripe" checked');
    expect(page).toContain('name="provider" value="paypal"');
    expect(page).toContain('name="provider" value="mollie"');
    const r = await t.api.raw(`/buy/${p.id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=paypal&email=kaeufer%40example.com', redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/sandbox\.paypal\.com\/checkoutnow/);
    const s = t.app.db.get<any>(`SELECT * FROM pay_sessions WHERE purpose = 'product' AND ref_id = ?`, p.id)!;
    expect(s.amount_cents).toBe(11900);
    orders.get(s.provider_ref).status = 'APPROVED';
    const back = await t.api.raw(`/pay/${s.id}/return`, { redirect: 'manual' });
    expect(back.headers.get('location')).toBe(`/pay/${s.id}`);
    await settle();
    const done = t.app.db.get<any>('SELECT * FROM stripe_checkouts WHERE id = ?', s.id)!;
    expect(done).toMatchObject({ kind: 'product', status: 'paid', product_id: p.id });
    const inv = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', done.invoice_id)!;
    expect(inv).toMatchObject({ status: 'paid', total_cents: 11900 });
    expect(inv.notes).toContain('über PayPal');
    expect(events.some((e) => e.type === 'product.purchased' && e.data.productId === p.id)).toBe(true);
    const contact = t.app.db.get<any>('SELECT tags FROM contacts WHERE email = ?', 'kaeufer@example.com')!;
    expect(JSON.parse(contact.tags)).toContain('kauf:online-kurs');
    expect((await t.api.get(`/pay/${s.id}`)).data).toContain('Danke!');
  });

  it('subscriptions stay with Stripe', async () => {
    const p = (await t.api.post('/api/products', { name: 'Abo', price_cents: 1000, recurring: 'month' })).data;
    expect((await t.api.get(`/buy/${p.id}`)).data).not.toContain('name="provider"');
    const r = await t.api.raw(`/buy/${p.id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=paypal' });
    expect(await r.text()).toContain('Abos lassen sich nur mit Karte oder SEPA (Stripe) abschließen');
  });
});

describe('bookings through the pay page', () => {
  it('with PayPal set up, a paid booking goes to the pay page; paid there, the hold becomes the appointment', async () => {
    const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
    const cal = (await t.api.post('/api/calendars', { name: 'Coaching', duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, timezone: 'Europe/Berlin', settings: { confirmation_email: false, notify_team: false, reminder_hours: 0 } })).data;
    const put = await t.api.put(`/api/team-calendars/${cal.id}`, { config: { kind: 'single', payment: { mode: 'full', amount_cents: 5000, currency: 'EUR', tax_rate: 19, title: 'Coaching' } }, members: [{ user_id: chef }] });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    const day = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const start = zonedToUtc(day, '10:00', 'Europe/Berlin').toISOString();
    const r = await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start, first_name: 'Paula', last_name: 'Pay', email: 'paula@example.com', consent: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.checkout_url).toMatch(/^http:\/\/localhost\/pay\/ps_/);
    const sid = r.data.checkout_url.split('/').pop();
    expect(sessionOf(sid)).toMatchObject({ purpose: 'teamcal_hold', amount_cents: 5000 });
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=mollie', redirect: 'manual' });
    expect(go.status).toBe(303);
    payments.get(sessionOf(sid).provider_ref).status = 'paid';
    expect((await mollieHook(sessionOf(sid).provider_ref)).data.handled).toBe('paid');
    await settle();
    const hold = t.app.db.get<any>('SELECT * FROM teamcal_holds WHERE session_id = ?', sid)!;
    expect(hold).toMatchObject({ status: 'paid', payment_intent: sid });
    expect(t.app.db.get<any>('SELECT status FROM appointments WHERE id = ?', hold.appointment_id)!.status).toBe('confirmed');
    expect(t.app.db.get<any>('SELECT status, total_cents FROM invoices WHERE id = ?', hold.invoice_id)).toEqual({ status: 'paid', total_cents: 5000 });
  });
});
