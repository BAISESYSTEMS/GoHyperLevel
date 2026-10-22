import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { formEncode, invoiceLineItems, keyHint, setStripeFetch, signStripePayload, verifyStripeSignature } from '../server/services/stripe.js';

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';

/** A tiny fake Stripe API: records calls, answers like the real endpoints we use. */
const calls: { method: string; path: string; params: URLSearchParams; auth: string }[] = [];
const sessions = new Map<string, any>();
let seq = 0;
const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  calls.push({ method: init.method, path: u.pathname, params, auth: init.headers.authorization });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: 'Invalid API Key provided', type: 'invalid_request_error' } }, 401);
  if (u.pathname === '/v1/account') return json({ id: 'acct_123', settings: { dashboard: { display_name: 'Malerei Muster' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    let total = 0;
    for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][quantity]`)) * Number(params.get(`line_items[${i}][price_data][unit_amount]`));
    const s = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: total, currency: params.get('line_items[0][price_data][currency]'), customer_email: params.get('customer_email'), payment_status: 'unpaid', status: 'open' };
    sessions.set(id, s);
    return json(s);
  }
  if (u.pathname.startsWith('/v1/checkout/sessions/')) {
    const s = sessions.get(decodeURIComponent(u.pathname.split('/').pop()!));
    return s ? json(s) : json({ error: { message: 'No such checkout.session' } }, 404);
  }
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: { type: string; data: any }[] = [];
beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  for (const type of ['invoice.paid', 'product.purchased', 'contact.tag_added']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

async function hook(event: any, opts: { secret?: string; ts?: number; location?: string } = {}) {
  const raw = JSON.stringify(event);
  const r = await t.api.raw(`/hooks/stripe/${opts.location ?? loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, opts.secret ?? WHSEC, opts.ts) }, body: raw });
  await t.app.events.flush();
  return { status: r.status, data: await r.json() };
}
const completed = (session: any, id = `evt_${Math.random().toString(36).slice(2)}`, type = 'checkout.session.completed') => ({ id, object: 'event', type, data: { object: session } });

describe('Stripe signature and line items', () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = 1_790_000_000;

  it('accepts a correct Stripe-Signature and rejects everything else', () => {
    const header = signStripePayload(body, WHSEC, now);
    expect(header).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(verifyStripeSignature(body, header, WHSEC, 300, now)).toEqual({ ok: true, t: now });
    expect(verifyStripeSignature(body, header, 'whsec_other', 300, now).ok).toBe(false);
    expect(verifyStripeSignature(body + ' ', header, WHSEC, 300, now).ok).toBe(false);
    expect(verifyStripeSignature(body, header, WHSEC, 300, now + 301)).toEqual({ ok: false, reason: 'Zeitstempel zu alt' });
    expect(verifyStripeSignature(body, header, WHSEC, 300, now + 299).ok).toBe(true);
    expect(verifyStripeSignature(body, undefined, WHSEC, 300, now).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${now}`, WHSEC, 300, now).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${now},v1=zz`, WHSEC, 300, now).ok).toBe(false);
    // During a secret rotation Stripe sends several v1 signatures; one valid is enough.
    const v1 = header.split('v1=')[1];
    expect(verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)},v1=${v1},v0=abc`, WHSEC, 300, now).ok).toBe(true);
  });

  it('turns invoice lines into gross Checkout items that add up to the total', () => {
    const items = [
      { name: 'Website', qty: 2, price_cents: 10000, tax_rate: 19 },
      { name: 'Stunden', qty: 1.5, price_cents: 8000, tax_rate: 19 },
      { name: 'Gratis', qty: 1, price_cents: 0, tax_rate: 19 },
    ];
    const lines = invoiceLineItems({ number: 'RE-1', currency: 'EUR', total_cents: 23800 + 14280, items });
    expect(lines).toEqual([
      { name: 'Website', description: 'inkl. 19 % USt.', unit_amount: 11900, quantity: 2 },
      { name: '1,5 × Stunden', description: 'inkl. 19 % USt.', unit_amount: 14280, quantity: 1 },
    ]);
    // A discount line (negative) can't be a Checkout item: one line for the whole invoice.
    const discounted = invoiceLineItems({ number: 'RE-2', title: 'Paket', currency: 'EUR', total_cents: 9000, items: [{ name: 'A', qty: 1, price_cents: 10000, tax_rate: 0 }, { name: 'Rabatt', qty: 1, price_cents: -1000, tax_rate: 0 }] });
    expect(discounted).toEqual([{ name: 'Rechnung RE-2', description: 'Paket', unit_amount: 9000, quantity: 1 }]);
    // Something already settled part of it: one line for what is open, never the total again; nothing open: no line.
    const mixed = [
      { name: 'Website', qty: 1, price_cents: 10000, tax_rate: 19 },
      { name: 'Handbuch', qty: 1, price_cents: 1000, tax_rate: 7 },
    ];
    const rest = invoiceLineItems({ number: 'RE-3', currency: 'EUR', total_cents: 13000, paid_cents: 3000, credited_cents: 1070, deducted_cents: 0, items: mixed });
    expect(rest).toEqual([{ name: 'Restbetrag Rechnung RE-3', description: expect.stringContaining('inkl. 19 % / 7 % USt.'), unit_amount: 8930, quantity: 1 }]);
    expect(rest[0].description!.replace(/ /g, ' ')).toBe('Rechnungsbetrag 130,00 € abzgl. bereits bezahlt 30,00 €, Gutschriften 10,70 € · inkl. 19 % / 7 % USt.');
    expect(invoiceLineItems({ number: 'RE-4', currency: 'EUR', total_cents: 13000, paid_cents: 13000, items: mixed })).toEqual([]);
  });

  it('encodes nested params in Stripe bracket notation and hides keys', () => {
    const p = formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { unit_amount: 500 } }], metadata: { invoice_id: 'x' }, skip: undefined });
    expect(p.toString()).toBe('mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500&metadata%5Binvoice_id%5D=x');
    expect(keyHint(KEY)).toBe('sk_test_…abcd');
  });
});

describe('Stripe payments', () => {
  it('connects only with a working key and never shows it again', async () => {
    expect((await t.api.get('/api/stripe')).data).toMatchObject({ connected: false, webhook_url: `http://localhost/hooks/stripe/${loc}` });
    expect((await t.api.put('/api/stripe', { secret_key: 'pk_test_123' })).status).toBe(400);
    const wrong = await t.api.put('/api/stripe', { secret_key: 'sk_test_51WrongKey00000000wxyz' });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toContain('401');
    const r = await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ connected: true, key_hint: 'sk_test_…abcd', live: false, webhook_set: true, account: { id: 'acct_123', name: 'Malerei Muster' } });
    const all = JSON.stringify([(await t.api.get('/api/stripe')).data, (await t.api.get('/api/location')).data]);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(WHSEC);
    expect((await t.api.post('/api/stripe/test')).data).toMatchObject({ ok: true, live: false, account: { name: 'Malerei Muster' } });
    // Saving other options keeps the stored secrets.
    expect((await t.api.put('/api/stripe', { secret_key: '••••••', options: { auto_send_receipt: false } })).data).toMatchObject({ key_set: true, webhook_set: true, options: { auto_send_receipt: false } });
    await t.api.put('/api/stripe', { options: { auto_send_receipt: true } });
  });

  let inv: any;
  it('offers "Jetzt bezahlen" on open invoices and creates a Checkout Session', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'kunde@x.de', first_name: 'Kunde' })).data;
    inv = (await t.api.post('/api/invoices', { contact_id: c.id, title: 'Relaunch', items: [{ name: 'Website', qty: 2, price_cents: 10000, tax_rate: 19 }, { name: 'Stunden', qty: 1.5, price_cents: 8000, tax_rate: 19 }] })).data;
    const token = inv.public_token;
    expect(await (await t.api.raw(`/i/${token}`)).text()).toContain('Nicht gefunden'); // draft
    inv = (await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' })).data; // finalising gives the number
    const page = await (await t.api.raw(`/i/${token}`)).text();
    expect(page).toContain('Jetzt bezahlen (Karte, SEPA, Apple Pay …)');
    expect(page).toContain(`action="/i/${token}/pay"`);

    const before = calls.length;
    const r = await t.api.raw(`/i/${token}/pay`, { method: 'POST', redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    const call = calls[before];
    expect(call).toMatchObject({ method: 'POST', path: '/v1/checkout/sessions', auth: `Bearer ${KEY}` });
    const p = call.params;
    expect(p.get('mode')).toBe('payment');
    expect(p.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('11900');
    expect(p.get('line_items[0][quantity]')).toBe('2');
    expect(p.get('line_items[0][price_data][product_data][name]')).toBe('Website');
    expect(p.get('line_items[1][price_data][unit_amount]')).toBe('14280');
    expect(p.get('line_items[1][price_data][product_data][name]')).toBe('1,5 × Stunden');
    expect(p.get('customer_email')).toBe('kunde@x.de');
    expect(p.get('success_url')).toBe(`http://localhost/i/${token}/stripe?session_id={CHECKOUT_SESSION_ID}`);
    expect(p.get('cancel_url')).toBe(`http://localhost/i/${token}`);
    expect(p.get('metadata[invoice_id]')).toBe(inv.id);
    expect(p.get('metadata[location_id]')).toBe(loc);
    expect(p.get('payment_intent_data[metadata][invoice_id]')).toBe(inv.id);
    expect(sessions.get('cs_test_1').amount_total).toBe(inv.total_cents);

    // A second click reuses the open session instead of creating another one.
    const again = await t.api.raw(`/i/${token}/pay`, { method: 'POST', redirect: 'manual' });
    expect(again.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(calls.length).toBe(before + 1);
  });

  it('marks the invoice paid from a signed webhook, exactly once', async () => {
    const session = { ...sessions.get('cs_test_1'), payment_status: 'paid', status: 'complete', payment_intent: 'pi_123', customer_details: { email: 'kunde@x.de' } };
    // Wrong secret, stale timestamp, unknown account: refused.
    expect((await hook(completed(session), { secret: 'whsec_wrong0000000000' })).status).toBe(400);
    expect((await hook(completed(session), { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(400);
    expect((await hook(completed(session), { location: 'nope' })).status).toBe(404);
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data.status).toBe('sent');

    const event = completed(session, 'evt_paid_1');
    const r = await hook(event);
    expect(r).toEqual({ status: 200, data: { received: true, handled: 'invoice_paid', invoiceId: inv.id } });
    const paid = (await t.api.get(`/api/invoices/${inv.id}`)).data;
    expect(paid.status).toBe('paid');
    expect(paid.paid_at).toBeTruthy();
    expect(events.filter((e) => e.type === 'invoice.paid' && e.data.invoice.id === inv.id)).toHaveLength(1);
    expect(events.find((e) => e.type === 'invoice.paid')!.data).toMatchObject({ contactId: inv.contact_id, via: 'Stripe' });

    // Stripe retries the same event, then sends the PaymentIntent event: nothing happens twice.
    expect((await hook(event)).data).toEqual({ received: true, duplicate: true });
    const pi = await hook({ id: 'evt_pi_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_123', object: 'payment_intent', amount_received: inv.total_cents, currency: 'eur', metadata: { invoice_id: inv.id, location_id: loc } } } });
    expect(pi.data.handled).toBe('already_paid');
    expect(events.filter((e) => e.type === 'invoice.paid' && e.data.invoice.id === inv.id)).toHaveLength(1);

    const payments = (await t.api.get('/api/stripe/payments')).data;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ id: 'cs_test_1', invoice_id: inv.id, status: 'paid', payment_intent: 'pi_123', dashboard_url: 'https://dashboard.stripe.com/test/payments/pi_123' });
    const activity = (await t.api.get(`/api/contacts/${inv.contact_id}`)).data.activities.map((a: any) => a.summary).join('\n');
    expect(activity).toContain(`Rechnung ${inv.number} bezahlt`);
    // Paid: no button any more, and starting a payment is refused.
    expect(await (await t.api.raw(`/i/${inv.public_token}`)).text()).not.toContain('Jetzt bezahlen');
    expect((await t.api.raw(`/i/${inv.public_token}/pay`, { method: 'POST', redirect: 'manual' })).status).toBe(400);
  });

  it('confirms on return from Stripe and waits for SEPA until the money is there', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'sepa@x.de' })).data;
    const i2 = (await t.api.post('/api/invoices', { contact_id: c.id, items: [{ name: 'Wartung', qty: 1, price_cents: 5000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${i2.id}`, { status: 'sent' });
    const go = await t.api.raw(`/i/${i2.public_token}/pay`, { method: 'POST', redirect: 'manual' });
    const sid = go.headers.get('location')!.split('/').pop()!;
    // SEPA: the session completes unpaid; the return page says "wird bearbeitet".
    sessions.set(sid, { ...sessions.get(sid), status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_sepa' });
    const back = await t.api.raw(`/i/${i2.public_token}/stripe?session_id=${sid}`, { redirect: 'manual' });
    expect(back.status).toBe(200);
    expect(await back.text()).toContain('wird bearbeitet');
    expect((await hook(completed(sessions.get(sid)))).data.handled).toBe('pending');
    expect((await t.api.get(`/api/invoices/${i2.id}`)).data.status).toBe('sent');
    // Money arrived.
    const ok = await hook(completed({ ...sessions.get(sid), payment_status: 'paid' }, 'evt_async_1', 'checkout.session.async_payment_succeeded'));
    expect(ok.data.handled).toBe('invoice_paid');
    expect((await t.api.get(`/api/invoices/${i2.id}`)).data.status).toBe('paid');

    // Card payment confirmed straight away on return, before any webhook.
    const i3 = (await t.api.post('/api/invoices', { contact_id: c.id, items: [{ name: 'Logo', qty: 1, price_cents: 20000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${i3.id}`, { status: 'sent' });
    const sid3 = (await t.api.raw(`/i/${i3.public_token}/pay`, { method: 'POST', redirect: 'manual' })).headers.get('location')!.split('/').pop()!;
    sessions.set(sid3, { ...sessions.get(sid3), status: 'complete', payment_status: 'paid', payment_intent: 'pi_card' });
    const ret = await t.api.raw(`/i/${i3.public_token}/stripe?session_id=${sid3}`, { redirect: 'manual' });
    expect(ret.status).toBe(302);
    expect(ret.headers.get('location')).toBe(`/i/${i3.public_token}`);
    await t.app.events.flush();
    expect((await t.api.get(`/api/invoices/${i3.id}`)).data.status).toBe('paid');
    // Unknown session ids are not looked up at Stripe.
    const n = calls.length;
    await t.api.raw(`/i/${i3.public_token}/stripe?session_id=cs_test_999`, { redirect: 'manual' });
    expect(calls.length).toBe(n);
  });

  it('sells products through /buy: contact, paid invoice, tag and product.purchased', async () => {
    const prod = (await t.api.post('/api/products', { name: 'Online-Kurs Pro', description: 'Alle Lektionen', price_cents: 4900, tax_rate: 19 })).data;
    const page = await t.api.raw(`/buy/${prod.id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Online-Kurs Pro');
    expect(html).toContain('58,31');
    // Button-Lösung (§ 312j BGB): the order button names the payment obligation.
    expect(html).toContain('zahlungspflichtig bestellen');

    const go = await t.api.raw(`/buy/${prod.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=Neu%40Kunde.de' });
    expect(go.status).toBe(303);
    const sid = go.headers.get('location')!.split('/').pop()!;
    const p = calls[calls.length - 1].params;
    expect(p.get('mode')).toBe('payment');
    expect(p.get('line_items[0][price_data][unit_amount]')).toBe('5831');
    expect(p.get('customer_email')).toBe('neu@kunde.de');
    expect(p.get('metadata[product_id]')).toBe(prod.id);
    expect(p.get('metadata[tag]')).toBe('kauf:online-kurs-pro');
    expect(p.get('success_url')).toBe(`http://localhost/buy/${prod.id}/danke?session_id={CHECKOUT_SESSION_ID}`);

    const session = { ...sessions.get(sid), status: 'complete', payment_status: 'paid', payment_intent: 'pi_kurs', customer_details: { email: 'Neu@Kunde.de', name: 'Nina Neu' } };
    const event = completed(session, 'evt_buy_1');
    const r = await hook(event);
    expect(r.data.handled).toBe('product_purchased');
    const contact = (await t.api.get(`/api/contacts/${r.data.contactId}`)).data;
    expect(contact).toMatchObject({ email: 'neu@kunde.de', first_name: 'Nina', last_name: 'Neu', source: 'Stripe' });
    expect(contact.tags).toContain('kauf:online-kurs-pro');
    const invoice = (await t.api.get(`/api/invoices/${r.data.invoiceId}`)).data;
    expect(invoice).toMatchObject({ status: 'paid', contact_id: contact.id, total_cents: 5831, title: 'Online-Kurs Pro' });
    const bought = events.filter((e) => e.type === 'product.purchased');
    expect(bought).toHaveLength(1);
    expect(bought[0].data).toMatchObject({ contactId: contact.id, productId: prod.id, invoiceId: invoice.id, amount_cents: 5831 });
    // The receipt went to the buyer (log provider records it in the conversation).
    const msgs = (await t.api.get(`/api/contacts/${contact.id}/messages`)).data;
    expect(msgs.some((m: any) => m.subject.includes(invoice.number))).toBe(true);

    // Retried webhook / return page: no second invoice, no second event.
    expect((await hook(completed(session, 'evt_buy_2'))).data.handled).toBe('duplicate');
    const thanks = await t.api.raw(`/buy/${prod.id}/danke?session_id=${sid}`);
    expect(await thanks.text()).toContain('Die Zahlung ist eingegangen');
    expect(events.filter((e) => e.type === 'product.purchased')).toHaveLength(1);
    expect((await t.api.get('/api/invoices')).data.filter((i: any) => i.title === 'Online-Kurs Pro')).toHaveLength(1);
  });

  it('gives products a short link, own tag and a redirect after purchase', async () => {
    const prod = (await t.api.post('/api/products', { name: 'Coaching', price_cents: 10000 })).data;
    expect((await t.api.put(`/api/stripe/products/${prod.id}`, { redirect_url: 'http://x.de' })).status).toBe(400);
    const link = (await t.api.put(`/api/stripe/products/${prod.id}`, { slug: 'Coaching 1:1', tag: 'coaching', redirect_url: 'https://kurs.example.com/start' })).data;
    expect(link).toMatchObject({ slug: 'coaching-1-1', tag: 'coaching', url: 'http://localhost/buy/coaching-1-1' });
    const other = (await t.api.post('/api/products', { name: 'X', price_cents: 100 })).data;
    expect((await t.api.put(`/api/stripe/products/${other.id}`, { slug: 'coaching-1-1' })).status).toBe(400);
    expect((await t.api.raw('/buy/coaching-1-1')).status).toBe(200);

    const sid = (await t.api.raw('/buy/coaching-1-1', { method: 'POST', redirect: 'manual' })).headers.get('location')!.split('/').pop()!;
    // Default tax of the sub-account (19 %) applies when the product has none.
    expect(sessions.get(sid).amount_total).toBe(11900);
    sessions.set(sid, { ...sessions.get(sid), status: 'complete', payment_status: 'paid', customer_details: { email: 'kunde@x.de' } });
    const done = await t.api.raw(`/buy/coaching-1-1/danke?session_id=${sid}`, { redirect: 'manual' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('https://kurs.example.com/start');
    await t.app.events.flush();
    const c = (await t.api.get('/api/contacts?q=kunde@x.de')).data.contacts[0];
    expect(c.tags).toContain('coaching'); // existing contact matched by email

    // Disabled links and inactive products are not for sale.
    await t.api.put(`/api/stripe/products/${prod.id}`, { slug: 'coaching-1-1', enabled: false });
    expect((await t.api.raw('/buy/coaching-1-1')).status).toBe(404);
  });

  it('lets workflows start on "Produkt gekauft" for one product', async () => {
    const prod = (await t.api.get('/api/products')).data.find((p: any) => p.name === 'Online-Kurs Pro');
    const wf = await t.api.post('/api/workflows', { name: 'Kurs freischalten', trigger: { type: 'product.purchased', config: { product_id: prod.id } } });
    expect(wf.status).toBe(200);
    expect((await t.api.get('/api/workflows/meta')).data.triggers).toContain('product.purchased');
  });

  it('handles subscription renewals and removes the tag when the subscription ends', async () => {
    const prod = (await t.api.post('/api/products', { name: 'Mitgliedschaft', price_cents: 1000, tax_rate: 0, recurring: 'month' })).data;
    const sid = (await t.api.raw(`/buy/${prod.id}`, { method: 'POST', redirect: 'manual' })).headers.get('location')!.split('/').pop()!;
    const p = calls[calls.length - 1].params;
    expect(p.get('mode')).toBe('subscription');
    expect(p.get('line_items[0][price_data][recurring][interval]')).toBe('month');
    expect(p.get('subscription_data[metadata][product_id]')).toBe(prod.id);
    const first = await hook(completed({ ...sessions.get(sid), status: 'complete', payment_status: 'paid', subscription: 'sub_1', customer_details: { email: 'abo@x.de' } }));
    expect(first.data.handled).toBe('product_purchased');
    const meta = { location_id: loc, product_id: prod.id, price_cents: '1000', tax_rate: '0', tag: 'kauf:mitgliedschaft' };
    // The first Stripe invoice belongs to the checkout; the renewal makes a new paid invoice.
    expect((await hook({ id: 'evt_inv_1', type: 'invoice.paid', data: { object: { id: 'in_1', billing_reason: 'subscription_create', amount_paid: 1000, currency: 'eur', parent: { subscription_details: { subscription: 'sub_1', metadata: meta } } } } })).data.handled).toBe('first_period');
    const renewal = await hook({ id: 'evt_inv_2', type: 'invoice.paid', data: { object: { id: 'in_2', billing_reason: 'subscription_cycle', amount_paid: 1000, currency: 'eur', customer_email: 'abo@x.de', parent: { subscription_details: { subscription: 'sub_1', metadata: meta } } } } });
    expect(renewal.data.handled).toBe('renewal');
    const rinv = (await t.api.get(`/api/invoices/${renewal.data.invoiceId}`)).data;
    expect(rinv).toMatchObject({ status: 'paid', contact_id: first.data.contactId, total_cents: 1000 });
    expect((await hook({ id: 'evt_inv_3', type: 'invoice.paid', data: { object: { id: 'in_2', billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: 'sub_1', metadata: meta } } } } })).data.handled).toBe('duplicate');

    expect((await t.api.get(`/api/contacts/${first.data.contactId}`)).data.tags).toContain('kauf:mitgliedschaft');
    const ended = await hook({ id: 'evt_sub_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', object: 'subscription', metadata: meta } } });
    expect(ended.data.handled).toBe('subscription_ended');
    expect((await t.api.get(`/api/contacts/${first.data.contactId}`)).data.tags).not.toContain('kauf:mitgliedschaft');
  });

  it('keeps Stripe settings to the settings area and payments to the payments area', async () => {
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('GET', '/api/stripe')).toBeUndefined();
    expect(requiredPermission('PUT', '/api/stripe')).toBe('settings');
    expect(requiredPermission('GET', '/api/stripe/payments')).toBe('payments');
    expect(requiredPermission('PUT', '/api/stripe/products/x')).toBe('payments');
    const inv = (await t.api.post('/api/invoices', { items: [{ name: 'Rest', qty: 1, price_cents: 9900 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' });
    expect(await (await t.api.raw(`/i/${inv.public_token}`)).text()).toContain('Jetzt bezahlen');
    expect((await t.api.del('/api/stripe')).data.connected).toBe(false);
    expect(await (await t.api.raw(`/i/${inv.public_token}`)).text()).not.toContain('Jetzt bezahlen');
    expect((await t.api.raw(`/buy/${(await t.api.get('/api/products')).data[0].id}`)).status).toBe(404);
  });
});
