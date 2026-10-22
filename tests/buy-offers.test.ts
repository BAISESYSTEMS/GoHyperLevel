import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { couponNet, grossOfNet, netForGross } from '../server/modules/buy-offers.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';

/** Fake Stripe: Checkout Sessions and PaymentIntents, switchable answers for the off-session charge. */
type Call = { method: string; path: string; params: URLSearchParams; idem: string };
const calls: Call[] = [];
const sessions = new Map<string, any>();
const intents = new Map<string, any>();
let piMode: 'succeeded' | 'auth_required' | 'requires_action' | 'processing' = 'succeeded';
let seq = 0;
const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  calls.push({ method: init.method, path: u.pathname, params, idem: init.headers['idempotency-key'] ?? '' });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Shop' } } });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_bo${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    let total = 0;
    for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][quantity]`)) * Number(params.get(`line_items[${i}][price_data][unit_amount]`));
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: total, currency: 'eur', payment_status: 'unpaid', status: 'open', customer: params.get('customer') };
    sessions.set(id, s);
    return json(s);
  }
  if (u.pathname.startsWith('/v1/checkout/sessions/')) return json(sessions.get(u.pathname.split('/').pop()!));
  if (u.pathname === '/v1/payment_intents' && init.method === 'POST') {
    const id = `pi_up_${++seq}`;
    const base = { id, object: 'payment_intent', amount: Number(params.get('amount')), currency: params.get('currency'), customer: params.get('customer'), payment_method: params.get('payment_method') };
    if (piMode === 'auth_required')
      return json(
        { error: { type: 'card_error', code: 'authentication_required', message: 'Your card was declined. This transaction requires authentication.', payment_intent: { ...base, status: 'requires_payment_method' } } },
        402,
      );
    const pi = { ...base, status: piMode, amount_received: piMode === 'succeeded' ? Number(params.get('amount')) : 0 };
    intents.set(id, pi);
    return json(pi);
  }
  if (/^\/v1\/payment_intents\/[^/]+\/cancel$/.test(u.pathname)) return json({ id: u.pathname.split('/')[3], status: 'canceled' });
  if (u.pathname.startsWith('/v1/payment_intents/')) {
    const id = u.pathname.split('/').pop()!;
    return json(intents.get(id) ?? { id, object: 'payment_intent', status: 'succeeded', customer: 'cus_buyer', payment_method: 'pm_card_saved' });
  }
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
const events: { type: string; data: any }[] = [];
beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
  t.app.events.on('product.purchased', (e) => void events.push({ type: e.type, data: e.data }));
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

const form = (body: Record<string, string>) => ({ method: 'POST', redirect: 'manual' as const, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const lastCheckout = () => [...calls].reverse().find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST')!.params;
async function hook(session: any) {
  const raw = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, type: 'checkout.session.completed', data: { object: session } });
  const r = await t.api.raw(`/hooks/stripe/${t.api.location}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return r.json();
}
const paid = (sid: string, extra: Record<string, any> = {}) => ({ ...sessions.get(sid), status: 'complete', payment_status: 'paid', customer_details: { email: 'kim@kunde.de', name: 'Kim Kunde' }, ...extra });
const product = async (body: any) => (await t.api.post('/api/products', body)).data;

describe('Discount math', () => {
  it('rounds like the invoice so Checkout and invoice totals match', () => {
    expect(grossOfNet(10000, 19)).toBe(11900);
    expect(grossOfNet(-2000, 19)).toBe(-2380);
    expect(couponNet(10000, 19, { kind: 'percent', value: 20 })).toBe(-2000);
    expect(couponNet(10000, 19, { kind: 'amount', value: 1000 })).toBe(-840);
    expect(grossOfNet(-840, 19)).toBe(-1000);
    expect(couponNet(1000, 19, { kind: 'amount', value: 5000 })).toBe(-1000); // never below zero
    for (const g of [-1190, -1000, -1, -12345]) expect(grossOfNet(netForGross(g, 19), 19)).toBe(g);
    // Not every gross amount exists at 19 % (−998 / −1000): the closest one is taken.
    expect(Math.abs(grossOfNet(netForGross(-999, 19), 19) + 999)).toBe(1);
    expect(netForGross(-500, 7)).toBe(-467);
  });
});

describe('Order bump', () => {
  let main: any;
  let bump: any;
  it('only offers one-time products of the same sub-account and currency', async () => {
    main = await product({ name: 'Online-Kurs', description: 'Alle Lektionen', price_cents: 10000, tax_rate: 19 });
    bump = await product({ name: 'Workbook', description: 'PDF zum Ausdrucken', price_cents: 1500, tax_rate: 7 });
    const abo = await product({ name: 'Club', price_cents: 900, recurring: 'month' });
    const usd = await product({ name: 'USD', price_cents: 900, currency: 'USD' });
    expect((await t.api.put(`/api/buy-offers/${main.id}`, { bump_product_id: abo.id })).status).toBe(400);
    expect((await t.api.put(`/api/buy-offers/${main.id}`, { bump_product_id: main.id })).status).toBe(400);
    expect((await t.api.put(`/api/buy-offers/${main.id}`, { bump_product_id: usd.id })).data.error).toContain('Währung');
    expect((await t.api.put(`/api/buy-offers/${abo.id}`, { upsell_product_id: bump.id })).data.error).toContain('Abos');
    const r = await t.api.put(`/api/buy-offers/${main.id}`, { bump_product_id: bump.id, bump_title: 'Ja, das Workbook dazu!', bump_text: 'Nur hier zum Sonderpreis.' });
    expect(r.data).toMatchObject({ bump_product_id: bump.id, bump_title: 'Ja, das Workbook dazu!', upsell_product_id: '', coupons: [] });
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('PUT', `/api/buy-offers/${main.id}`)).toBe('payments');
  });

  it('shows the checkbox and puts both lines into Checkout and the invoice', async () => {
    const page = await (await t.api.raw(`/buy/${main.id}`)).text();
    expect(page).toContain('Ja, das Workbook dazu!');
    expect(page).toContain('name="bump" value="1" data-bump="1605"');
    expect(page).toContain('Gesamt:');

    // Without the tick: one line.
    await t.api.raw(`/buy/${main.id}`, form({ email: 'kim@kunde.de' }));
    expect(lastCheckout().has('line_items[1][quantity]')).toBe(false);

    const go = await t.api.raw(`/buy/${main.id}`, form({ email: 'kim@kunde.de', bump: '1' }));
    expect(go.status).toBe(303);
    const p = lastCheckout();
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('11900');
    expect(p.get('line_items[1][price_data][unit_amount]')).toBe('1605');
    expect(p.get('line_items[1][price_data][product_data][name]')).toBe('Workbook');
    expect(p.get('metadata[bump_product_id]')).toBe(bump.id);
    expect(p.get('metadata[bump_tax_rate]')).toBe('7');
    const sid = go.headers.get('location')!.split('/').pop()!;
    expect(t.app.db.get('SELECT amount_cents FROM stripe_checkouts WHERE id = ?', sid)!.amount_cents).toBe(13505);

    const r = await hook(paid(sid, { payment_intent: 'pi_bump' }));
    expect(r.handled).toBe('product_purchased');
    const inv = (await t.api.get(`/api/invoices/${r.invoiceId}`)).data;
    expect(inv.items.map((i: any) => [i.name, i.price_cents, i.tax_rate])).toEqual([
      ['Online-Kurs', 10000, 19],
      ['Workbook', 1500, 7],
    ]);
    expect(inv).toMatchObject({ status: 'paid', total_cents: 13505 });
    const mine = events.filter((e) => e.data.invoiceId === r.invoiceId);
    expect(mine.map((e) => [e.data.productId, e.data.amount_cents, e.data.via ?? ''])).toEqual([
      [main.id, 13505, ''],
      [bump.id, 1605, 'order_bump'],
    ]);
    const c = (await t.api.get(`/api/contacts/${r.contactId}`)).data;
    expect(c.tags).toEqual(expect.arrayContaining(['kauf:online-kurs', 'kauf:workbook']));
    expect(c.activities.map((a: any) => a.summary).join('\n')).toContain('Gekauft (Order-Bump): Workbook');
  });
});

describe('Discount codes', () => {
  let p: any;
  it('manages codes per product', async () => {
    p = await product({ name: 'Masterclass', price_cents: 10000, tax_rate: 19 });
    expect((await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'x', value: 10 })).status).toBe(400);
    expect((await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'ZU-VIEL', value: 120 })).status).toBe(400);
    await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'sommer 20', kind: 'percent', value: 20 });
    expect((await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'SOMMER20', value: 5 })).status).toBe(400);
    await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'ZEHN', kind: 'amount', value: 1000, max_uses: 1 });
    const r = await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'ALT', value: 50, expires_at: '2020-01-01' });
    expect(r.data.coupons.map((c: any) => [c.code, c.kind, c.value, c.max_uses])).toEqual([
      ['SOMMER20', 'percent', 20, null],
      ['ZEHN', 'amount', 1000, 1],
      ['ALT', 'percent', 50, null],
    ]);
    const abo = await product({ name: 'Abo', price_cents: 900, recurring: 'month' });
    expect((await t.api.post(`/api/buy-offers/${abo.id}/coupons`, { code: 'ABO10', value: 10 })).status).toBe(400);
    expect(await (await t.api.raw(`/buy/${p.id}`)).text()).toContain('Rabattcode eingeben');
  });

  it('checks a code on the buy page', async () => {
    expect((await t.api.get(`/api/public/buy/${p.id}/coupon?code=sommer20`)).data).toEqual({ ok: true, code: 'SOMMER20', label: '−20 %', discount_cents: 2380, total_cents: 9520 });
    expect((await t.api.get(`/api/public/buy/${p.id}/coupon?code=nix`)).data).toEqual({ ok: false, error: 'Diesen Rabattcode gibt es nicht' });
    expect((await t.api.get(`/api/public/buy/${p.id}/coupon?code=ALT`)).data.error).toContain('abgelaufen');
  });

  it('charges the discounted price and shows the discount on the invoice', async () => {
    const go = await t.api.raw(`/buy/${p.id}`, form({ coupon: 'Sommer20' }));
    expect(go.status).toBe(303);
    const q = lastCheckout();
    expect(q.get('line_items[0][price_data][unit_amount]')).toBe('9520');
    expect(q.get('line_items[0][price_data][product_data][description]')).toContain('Rabattcode SOMMER20: −20 %');
    expect(q.get('metadata[coupon_code]')).toBe('SOMMER20');
    expect(q.has('allow_promotion_codes')).toBe(false);
    const r = await hook(paid(go.headers.get('location')!.split('/').pop()!, { payment_intent: 'pi_c1' }));
    const inv = (await t.api.get(`/api/invoices/${r.invoiceId}`)).data;
    expect(inv.items.map((i: any) => [i.name, i.price_cents])).toEqual([
      ['Masterclass', 10000],
      ['Rabatt (SOMMER20)', -2000],
    ]);
    expect(inv.total_cents).toBe(9520);

    // Amount code, single use.
    const z = await t.api.raw(`/buy/${p.id}`, form({ coupon: 'ZEHN' }));
    expect(lastCheckout().get('line_items[0][price_data][unit_amount]')).toBe('10900');
    const r2 = await hook(paid(z.headers.get('location')!.split('/').pop()!, { payment_intent: 'pi_c2' }));
    expect((await t.api.get(`/api/invoices/${r2.invoiceId}`)).data.total_cents).toBe(10900);
    const offers = (await t.api.get(`/api/buy-offers/${p.id}`)).data;
    expect(offers.coupons.map((c: any) => [c.code, c.uses])).toEqual([
      ['SOMMER20', 1],
      ['ZEHN', 1],
      ['ALT', 0],
    ]);
    const again = await t.api.raw(`/buy/${p.id}`, form({ coupon: 'ZEHN' }));
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('schon aufgebraucht');
    // Switched off: unknown.
    await t.api.patch(`/api/buy-coupons/${offers.coupons[0].id}`, { active: false });
    expect((await t.api.raw(`/buy/${p.id}`, form({ coupon: 'SOMMER20' }))).status).toBe(400);
    expect((await t.api.del(`/api/buy-coupons/${offers.coupons[0].id}`)).data.coupons).toHaveLength(2);
  });

  it('lets Stripe promotion codes in and books their discount on the invoice', async () => {
    const promo = await product({ name: 'Webinar', price_cents: 10000, tax_rate: 19 });
    await t.api.put(`/api/buy-offers/${promo.id}`, { stripe_promo: true });
    expect(await (await t.api.raw(`/buy/${promo.id}`)).text()).toContain('Gutscheincode?');
    const go = await t.api.raw(`/buy/${promo.id}`, form({}));
    expect(lastCheckout().get('allow_promotion_codes')).toBe('true');
    const sid = go.headers.get('location')!.split('/').pop()!;
    const r = await hook(paid(sid, { amount_total: 10710, total_details: { amount_discount: 1190 }, payment_intent: 'pi_promo' }));
    const inv = (await t.api.get(`/api/invoices/${r.invoiceId}`)).data;
    expect(inv.items.map((i: any) => [i.name, i.price_cents])).toEqual([
      ['Webinar', 10000],
      ['Gutschein (Stripe)', -1000],
    ]);
    expect(inv.total_cents).toBe(10710);
  });
});

describe('One-click upsell', () => {
  let main: any;
  let up: any;
  const buy = async () => {
    const go = await t.api.raw(`/buy/${main.id}`, form({ email: 'kim@kunde.de' }));
    const sid = go.headers.get('location')!.split('/').pop()!;
    sessions.set(sid, paid(sid, { payment_intent: `pi_main_${sid}`, customer: 'cus_buyer' }));
    const back = await t.api.raw(`/buy/${main.id}/danke?session_id=${sid}`, { redirect: 'manual' });
    await t.app.events.flush();
    return { sid, back };
  };

  it('saves the card in Checkout and offers the upsell after paying', async () => {
    main = await product({ name: 'Starter-Paket', price_cents: 5000, tax_rate: 19 });
    up = await product({ name: 'VIP-Call', description: '60 Minuten 1:1', price_cents: 9900, tax_rate: 19 });
    await t.api.put(`/api/stripe/products/${main.id}`, { redirect_url: 'https://kurs.example.com/start' });
    await t.api.put(`/api/buy-offers/${main.id}`, { upsell_product_id: up.id, upsell_title: 'Willst du noch einen VIP-Call?' });
    const { back } = await buy();
    const p = lastCheckout();
    expect(p.get('payment_intent_data[setup_future_usage]')).toBe('off_session');
    expect(p.get('customer_creation')).toBe('always');
    expect(p.get('metadata[upsell]')).toBe('1');
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toMatch(/^\/upsell\/[A-Za-z0-9]{24}$/);
    const offer = await (await t.api.raw(back.headers.get('location')!)).text();
    expect(offer).toContain('Willst du noch einen VIP-Call?');
    expect(offer).toContain('Ja, hinzufügen – 117,81');
    expect(offer).toContain('Nein danke');
  });

  it('charges the saved card off-session on "Ja, hinzufügen"', async () => {
    piMode = 'succeeded';
    const { sid, back } = await buy();
    const token = back.headers.get('location')!;
    const n = calls.length;
    const yes = await t.api.raw(`${token}/accept`, { method: 'POST', redirect: 'manual' });
    expect(yes.status).toBe(303);
    expect(yes.headers.get('location')).toBe(`/buy/${main.id}/danke?session_id=${sid}`);
    const [getPi, createPi] = calls.slice(n);
    expect(getPi).toMatchObject({ method: 'GET', path: `/v1/payment_intents/pi_main_${sid}` });
    expect(createPi.path).toBe('/v1/payment_intents');
    expect(Object.fromEntries(['amount', 'currency', 'customer', 'payment_method', 'off_session', 'confirm', 'metadata[upsell_of]', 'metadata[product_id]'].map((k) => [k, createPi.params.get(k)]))).toEqual({
      amount: '11781',
      currency: 'eur',
      customer: 'cus_buyer',
      payment_method: 'pm_card_saved',
      off_session: 'true',
      confirm: 'true',
      'metadata[upsell_of]': sid,
      'metadata[product_id]': up.id,
    });
    expect(createPi.idem).toMatch(/^upsell-/);
    await t.app.events.flush();
    const bought = events.filter((e) => e.data.productId === up.id);
    expect(bought).toHaveLength(1);
    const inv = (await t.api.get(`/api/invoices/${bought[0].data.invoiceId}`)).data;
    expect(inv).toMatchObject({ status: 'paid', total_cents: 11781, title: 'VIP-Call' });
    expect((await t.api.get(`/api/contacts/${inv.contact_id}`)).data.tags).toContain('kauf:vip-call');
    // A second click charges nothing; the thank-you goes on to the product's redirect.
    const m = calls.length;
    expect((await t.api.raw(`${token}/accept`, { method: 'POST', redirect: 'manual' })).status).toBe(303);
    expect(calls.length).toBe(m);
    const next = await t.api.raw(yes.headers.get('location')!, { redirect: 'manual' });
    expect(next.headers.get('location')).toBe('https://kurs.example.com/start');
    expect((await t.api.get(`/api/buy-offers/${main.id}`)).data.upsells).toMatchObject({ offered: 2, accepted: 1 });
  });

  it('goes on without charging on "Nein danke"', async () => {
    const { sid, back } = await buy();
    const n = calls.length;
    const no = await t.api.raw(`${back.headers.get('location')}/decline`, { method: 'POST', redirect: 'manual' });
    expect(no.headers.get('location')).toBe(`/buy/${main.id}/danke?session_id=${sid}`);
    expect(calls.length).toBe(n);
    expect((await t.api.raw(back.headers.get('location')!, { redirect: 'manual' })).status).toBe(303); // offer gone → back to the flow
  });

  it('falls back to a normal Checkout when the bank wants 3-D Secure', async () => {
    piMode = 'auth_required';
    const { back } = await buy();
    const before = events.filter((e) => e.data.productId === up.id).length;
    const yes = await t.api.raw(`${back.headers.get('location')}/accept`, { method: 'POST', redirect: 'manual' });
    expect(yes.status).toBe(303);
    expect(yes.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_bo\d+$/);
    const p = lastCheckout();
    expect(p.get('customer')).toBe('cus_buyer');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('11781');
    expect(p.get('metadata[upsell_of]')).toBeTruthy();
    expect(p.get('success_url')).toBe(`http://localhost/buy/${up.id}/danke?session_id={CHECKOUT_SESSION_ID}`);
    const fsid = yes.headers.get('location')!.split('/').pop()!;
    const row = t.app.db.get('SELECT status, fallback_session FROM buy_upsells WHERE fallback_session = ?', fsid)!;
    expect(row.status).toBe('fallback');
    // Paid in Checkout: a normal purchase of the upsell product, no upsell of the upsell.
    sessions.set(fsid, paid(fsid, { payment_intent: 'pi_fallback' }));
    const done = await t.api.raw(`/buy/${up.id}/danke?session_id=${fsid}`, { redirect: 'manual' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Die Zahlung ist eingegangen');
    await t.app.events.flush();
    expect(events.filter((e) => e.data.productId === up.id).length).toBe(before + 1);
  });

  it('cancels an intent that needs action and also falls back', async () => {
    piMode = 'requires_action';
    const { back } = await buy();
    const yes = await t.api.raw(`${back.headers.get('location')}/accept`, { method: 'POST', redirect: 'manual' });
    expect(yes.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(calls.some((c) => /\/v1\/payment_intents\/pi_up_\d+\/cancel$/.test(c.path))).toBe(true);
    piMode = 'succeeded';
  });

  it('finishes SEPA-style payments later and lets offers expire', async () => {
    piMode = 'processing';
    const { back } = await buy();
    const res = await t.api.raw(`${back.headers.get('location')}/accept`, { method: 'POST', redirect: 'manual' });
    expect(await res.text()).toContain('wird bearbeitet');
    const row = t.app.db.get(`SELECT * FROM buy_upsells WHERE status = 'pending'`)!;
    intents.set(row.upsell_payment_intent, {
      ...intents.get(row.upsell_payment_intent),
      status: 'succeeded',
      amount_received: 11781,
      metadata: { location_id: t.api.location, product_id: up.id, product_name: 'VIP-Call', price_cents: '9900', tax_rate: '19', qty: '1', tag: 'kauf:vip-call' },
    });
    await t.app.tick();
    await t.app.events.flush();
    expect(t.app.db.get('SELECT status, invoice_id FROM buy_upsells WHERE id = ?', row.id)).toMatchObject({ status: 'accepted' });
    piMode = 'succeeded';

    const { back: b2 } = await buy();
    const tok = b2.headers.get('location')!.split('/').pop()!;
    t.app.db.run('UPDATE buy_upsells SET created_at = ? WHERE id = ?', new Date(Date.now() - 2 * 3600_000).toISOString(), tok);
    const n = calls.length;
    const late = await t.api.raw(`/upsell/${tok}/accept`, { method: 'POST', redirect: 'manual' });
    expect(late.headers.get('location')).toMatch(/\/danke\?session_id=/);
    expect(calls.length).toBe(n);
    expect((await t.api.raw('/upsell/nope')).status).toBe(404);
  });
});
