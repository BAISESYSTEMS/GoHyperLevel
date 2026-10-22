import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { exportSnapshot, applySnapshot } from '../server/services/snapshots.js';
import { buildQuote, cleanSettings, shippingLines, shippingOptions, taxModeFor, trackingUrl, DEFAULT_SETTINGS, type QuoteProduct } from '../server/services/store-model.js';
import { calcTotals } from '../server/services/invoice-model.js';

/**
 * Online store (docs/store.md): settings, products with inventory variants and stock, collections, the cart and quote (shipping
 * flat / by weight, tax modes DE/EU/export), checkout through the payment registry (fake Mollie), the paid GoBD invoice, the goods
 * issue, triggers, fulfilment with tracking mail, refunds, gift cards in the checkout, abandoned carts, site blocks, snapshots and
 * DSGVO. No network.
 */

const MOLLIE_KEY = 'test_fakeMollieKeyForTests00000000';
const payments = new Map<string, any>();
const calls: { url: string; body: any }[] = [];
let n = 0;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const payFake = async (url: string, init: any) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, body });
  if (init.headers.authorization !== `Bearer ${MOLLIE_KEY}`) return json({ status: 401, detail: 'Unauthorized' }, 401);
  if (u.pathname === '/v2/methods') return json({ _embedded: { methods: [{ id: 'ideal' }] } });
  if (u.pathname === '/v2/payments' && init.method === 'POST') {
    const id = `tr_store${++n}`;
    const p = { id, status: 'open', amount: body.amount, metadata: body.metadata, lines: body.lines, billingAddress: body.billingAddress, _links: { checkout: { href: `https://www.mollie.com/checkout/${id}` } } };
    payments.set(id, p);
    return json(p, 201);
  }
  const m = u.pathname.match(/^\/v2\/payments\/([^/]+)(\/refunds)?$/);
  if (m && payments.has(m[1])) return m[2] ? json({ id: `re_${++n}`, amount: body.amount }, 201) : json(payments.get(m[1]));
  return json({ title: 'Not Found' }, 404);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const ids: Record<string, string> = {};
const events: { type: string; data: any }[] = [];
const settle = async () => {
  await t.app.events.flush();
  await new Promise((r) => setTimeout(r, 20));
};
const pub = (path: string, body: unknown) => t.api.raw(`/api/public/store/laden${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
const stockOf = (articleId: string) => Number(t.app.db.get<{ n: number }>('SELECT COALESCE(SUM(qty), 0) AS n FROM inv_stock WHERE article_id = ?', articleId)!.n);
const order = (number: string) => {
  const o = t.app.db.get<any>('SELECT * FROM store_orders WHERE number = ?', number)!;
  return { ...o, items: JSON.parse(o.items), meta: JSON.parse(o.meta), address: JSON.parse(o.address) };
};
async function mollieHook(id: string) {
  const r = await t.api.raw(`/hooks/mollie/${loc}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${id}` });
  await settle();
  return (await r.json()) as any;
}
const buyer = (extra: Record<string, unknown> = {}) => ({ email: 'kundin@example.com', first_name: 'Klara', last_name: 'Kundin', street: 'Gartenweg 5', postal_code: '50667', city: 'Köln', country: 'DE', accept_terms: true, provider: 'mollie', ...extra });

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.payFetch = payFake;
  await t.setup();
  loc = t.api.location;
  for (const type of ['store.order_placed', 'store.order_paid', 'store.order_shipped', 'checkout.abandoned', 'invoice.paid', 'payment.refunded']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
  expect((await t.api.put('/api/pay/providers/mollie', { api_key: MOLLIE_KEY })).status).toBe(200);
  // products: a mug with two colours in stock, an e-book (7 %), a gift card
  ids.mug = (await t.api.post('/api/products', { name: 'Tasse', description: 'Steingut, **spülmaschinenfest**', price_cents: 1000, tax_rate: 19 })).data.id;
  ids.book = (await t.api.post('/api/products', { name: 'E-Book', price_cents: 934, tax_rate: 7 })).data.id;
  ids.gift = (await t.api.post('/api/products', { name: 'Geschenkgutschein 25 €', price_cents: 2500, tax_rate: 19 })).data.id;
  const main = (await t.api.post('/api/inventory/articles', { sku: 'TASSE', name: 'Tasse', product_id: ids.mug })).data;
  ids.red = (await t.api.post('/api/inventory/articles', { sku: 'TASSE-ROT', name: 'Tasse rot', variant: 'Rot', parent_id: main.id, initial_qty: 5 })).data.id;
  ids.blue = (await t.api.post('/api/inventory/articles', { sku: 'TASSE-BLAU', name: 'Tasse blau', variant: 'Blau', parent_id: main.id, initial_qty: 0 })).data.id;
});
afterAll(async () => t?.close());

describe('the arithmetic (store-model)', () => {
  const mug: QuoteProduct = { product_id: 'p1', article_id: 'a1', name: 'Tasse', variant: 'Rot', sku: 'T-R', net_cents: 1000, tax_rate: 19, weight_g: 400, kind: 'physical', stock: 10, image: '' };
  const book: QuoteProduct = { ...mug, product_id: 'p2', article_id: null, name: 'Buch', variant: '', sku: '', net_cents: 1869, tax_rate: 7, weight_g: 600 };
  const settings = cleanSettings({
    countries: ['DE', 'AT', 'CH'],
    shipping: [
      { id: 'de', name: 'DHL Paket', type: 'flat', price_cents: 490, countries: ['DE'], free_over_cents: 5000 },
      { id: 'eu', name: 'EU-Paket', type: 'weight', tiers: [{ up_to_g: 1000, price_cents: 990 }, { up_to_g: 5000, price_cents: 1490 }], countries: ['AT', 'CH'] },
    ],
  });

  it('cleans settings and keeps them bounded', () => {
    expect(cleanSettings({ slug: 'Mein Laden!', countries: ['de', 'xx1', 'AT'], abandon_minutes: 1, order_prefix: 'B-<x>' })).toMatchObject({ slug: '', countries: ['DE', 'AT'], abandon_minutes: 15, order_prefix: 'B-x' });
    expect(cleanSettings({ slug: 'mein-laden' }).slug).toBe('mein-laden');
    expect(DEFAULT_SETTINGS.enabled).toBe(false);
  });

  it('shipping: by country, by weight, free above an amount', () => {
    expect(shippingOptions(settings.shipping, { country: 'DE', weight_g: 400, goods_gross_cents: 1190 })).toEqual([{ id: 'de', name: 'DHL Paket', price_cents: 490, delivery: '' }]);
    expect(shippingOptions(settings.shipping, { country: 'DE', weight_g: 400, goods_gross_cents: 5000 })[0].price_cents).toBe(0);
    expect(shippingOptions(settings.shipping, { country: 'AT', weight_g: 1200, goods_gross_cents: 1190 })).toEqual([{ id: 'eu', name: 'EU-Paket', price_cents: 1490, delivery: '' }]);
    expect(shippingOptions(settings.shipping, { country: 'AT', weight_g: 6000, goods_gross_cents: 1190 })).toEqual([]);
    expect(shippingOptions(settings.shipping, { country: 'FR', weight_g: 100, goods_gross_cents: 1190 })).toEqual([]);
  });

  it('the tax treatment comes from the invoice tax modes', () => {
    const base = { smallBusiness: false, country: 'DE', sellerCountry: 'DE', physical: true, buyerVat: false, sellerVat: true };
    expect(taxModeFor(base)).toBe('standard');
    expect(taxModeFor({ ...base, country: 'CH' })).toBe('export');
    expect(taxModeFor({ ...base, country: 'CH', physical: false })).toBe('standard');
    expect(taxModeFor({ ...base, country: 'AT', buyerVat: true })).toBe('ig_supply');
    expect(taxModeFor({ ...base, country: 'AT', buyerVat: true, sellerVat: false })).toBe('standard');
    expect(taxModeFor({ ...base, smallBusiness: true, country: 'CH' })).toBe('small_business');
  });

  it('shipping shares the VAT of the goods (split by net value with mixed rates)', () => {
    expect(shippingLines('Versand', 490, [{ rate: 19, net: 2000 }], 'standard')).toEqual([{ name: 'Versand', description: '', qty: 1, price_cents: 412, tax_rate: 19 }]);
    const mixed = shippingLines('Versand', 600, [{ rate: 19, net: 1000 }, { rate: 7, net: 1000 }], 'standard');
    expect(mixed.map((l) => l.tax_rate)).toEqual([19, 7]);
    expect(calcTotals(mixed).total_cents).toBe(600);
    expect(shippingLines('Versand', 490, [{ rate: 19, net: 1 }], 'export')).toEqual([{ name: 'Versand', description: '', qty: 1, price_cents: 490, tax_rate: 0 }]);
  });

  it('the quote is what the invoice will compute, cent for cent', () => {
    const q = buildQuote({ items: [{ p: mug, qty: 2 }, { p: book, qty: 1 }], settings, mode: 'standard', country: 'DE' });
    expect(q.lines.map((l) => [l.qty, l.unit_cents, l.total_cents])).toEqual([[2, 1190, 2380], [1, 2000, 2000]]);
    expect(q.shipping).toMatchObject({ id: 'de', price_cents: 490 });
    expect(q.total_cents).toBe(calcTotals(q.items).total_cents);
    // a shipping line's net is nudged so the total is exactly what the buyer was shown
    expect(q.total_cents).toBe(2380 + 2000 + 490);
    expect(q.items[0].description).toBe('Variante: Rot · [T-R]');
    expect(buildQuote({ items: [{ p: mug, qty: 2 }], settings, mode: 'export', country: 'CH' })).toMatchObject({ tax_cents: 0, total_cents: 2000 + 990 });
    expect(buildQuote({ items: [{ p: { ...mug, stock: 1 }, qty: 2 }], settings, mode: 'standard', country: 'DE' }).problems).toEqual(['Von „Tasse (Rot)“ sind nur noch 1 da']);
    expect(buildQuote({ items: [{ p: mug, qty: 1 }], settings, mode: 'standard', country: 'FR' }).problems[0]).toMatch(/liefern wir leider nicht/);
    const gift = buildQuote({ items: [{ p: { ...mug, kind: 'gift_card', net_cents: 2500, tax_rate: 19 }, qty: 1 }], settings, mode: 'standard', country: 'DE' });
    expect(gift).toMatchObject({ needs_shipping: false, shipping: null, tax_cents: 0, total_cents: 2500 });
    expect(gift.items[0].description).toContain('§ 3 Abs. 15 UStG');
  });

  it('tracking links for the common carriers', () => {
    expect(trackingUrl('dhl', '0034 0434')).toBe('https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=0034%200434');
    expect(trackingUrl('other', '1')).toBe('');
  });
});

describe('admin: settings, products, collections', () => {
  it('sets up the store', async () => {
    expect((await t.api.put('/api/store/settings', { slug: 'x' })).data.error).toMatch(/Kurzname/);
    const r = await t.api.put('/api/store/settings', {
      enabled: true,
      slug: 'laden',
      name: 'Kaffeeladen',
      countries: ['DE', 'AT', 'CH'],
      shipping: [
        { id: 'de', name: 'DHL Paket', type: 'flat', price_cents: 490, countries: ['DE'], free_over_cents: 5000, delivery: '1–2 Werktage' },
        { id: 'eu', name: 'EU-Paket', type: 'weight', tiers: [{ up_to_g: 2000, price_cents: 990 }], countries: ['AT', 'CH'] },
      ],
      gift_valid_months: 36,
      abandon_minutes: 30,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ enabled: true, key: 'laden', checkout_url: 'http://localhost/store/laden/checkout', providers: ['mollie'] });
  });

  it('publishes products with the inventory variants and their stock', async () => {
    const col = (await t.api.post('/api/store/collections', { name: 'Geschirr' })).data;
    ids.col = col.id;
    expect(col.slug).toBe('geschirr');
    expect((await t.api.post('/api/store/collections', { name: 'Geschirr' })).status).toBe(400);
    const mug = (await t.api.put(`/api/store/products/${ids.mug}`, { published: true, kind: 'physical', weight_g: 400, images: ['https://example.com/tasse.jpg', 'javascript:alert(1)'], collection_ids: [col.id], variant_prices: { [ids.red]: 1100 } })).data;
    expect(mug).toMatchObject({ published: true, slug: 'tasse', images: ['https://example.com/tasse.jpg'], collection_ids: [col.id], article_id: null });
    expect(mug.variants).toEqual([
      { article_id: ids.blue, label: 'Blau', sku: 'TASSE-BLAU', stock: 0, net_cents: 1000 },
      { article_id: ids.red, label: 'Rot', sku: 'TASSE-ROT', stock: 5, net_cents: 1100 },
    ]);
    expect((await t.api.put(`/api/store/products/${ids.book}`, { published: true, kind: 'digital' })).status).toBe(200);
    expect((await t.api.put(`/api/store/products/${ids.gift}`, { published: true, kind: 'gift_card' })).status).toBe(200);
    expect((await t.api.put(`/api/store/products/${ids.mug}`, { collection_ids: ['nope'] })).status).toBe(400);
    const sub = (await t.api.post('/api/products', { name: 'Abo', price_cents: 100, recurring: 'month' })).data;
    expect((await t.api.put(`/api/store/products/${sub.id}`, { published: true })).data.error).toMatch(/Abo-Produkte/);
  });
});

describe('cart, quote and checkout', () => {
  it('keeps a server cart per token with only known, published products and variants', async () => {
    const empty = await pub('/cart', { items: [] });
    expect(empty.data).toMatchObject({ token: '', items: [] });
    const r = await pub('/cart', { items: [{ product_id: ids.mug, article_id: ids.red, qty: 1 }, { product_id: ids.mug, article_id: ids.red, qty: 2 }, { product_id: ids.mug, qty: 1 }, { product_id: 'nope', qty: 1 }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.items).toEqual([{ product_id: ids.mug, article_id: ids.red, qty: 3 }]);
    expect(r.data.removed).toBe(2);
    expect(r.data.lines[0]).toMatchObject({ name: 'Tasse', variant: 'Rot', unit_cents: 1309, total_cents: 3927, stock: 5 });
    ids.cart = r.data.token;
    expect(ids.cart).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // a recovery link brings the server cart back
    expect((await pub('/cart', { token: ids.cart })).data.items).toHaveLength(1);
    expect((await t.api.raw('/api/public/store/nope/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('quotes shipping, tax, a sold-out variant and the payment options', async () => {
    const de = await pub('/quote', { items: [{ product_id: ids.mug, article_id: ids.red, qty: 2 }], country: 'DE' });
    expect(de.data).toMatchObject({ mode: 'standard', goods_cents: 2618, shipping: { id: 'de', price_cents: 490 }, total_cents: 3108, due_cents: 3108, providers: [{ id: 'mollie', label: 'Mollie' }] });
    expect(de.data.tax_groups).toEqual([{ rate: 19, tax_cents: 496 }]);
    const ch = await pub('/quote', { items: [{ product_id: ids.mug, article_id: ids.red, qty: 2 }], country: 'CH' });
    expect(ch.data).toMatchObject({ mode: 'export', tax_cents: 0, goods_cents: 2200, shipping: { id: 'eu', price_cents: 990 }, total_cents: 3190 });
    const out = await pub('/quote', { items: [{ product_id: ids.mug, article_id: ids.blue, qty: 1 }], country: 'DE' });
    expect(out.data.problems).toEqual(['„Tasse (Blau)“ ist ausverkauft']);
    const book = await pub('/quote', { items: [{ product_id: ids.book, qty: 1 }], country: 'DE' });
    expect(book.data).toMatchObject({ needs_shipping: false, shipping: null, total_cents: 999, tax_groups: [{ rate: 7, tax_cents: 65 }] });
  });

  it('places the order, pays it through Mollie, writes the paid invoice, takes the goods out of stock and fires the triggers', async () => {
    const terms = await pub('/checkout', buyer({ items: [{ product_id: ids.mug, article_id: ids.red, qty: 2 }], provider: 'paypal' }));
    expect(terms.data.error).toMatch(/Zahlungsart/);
    const r = await pub('/checkout', buyer({ token: ids.cart, items: [{ product_id: ids.mug, article_id: ids.red, qty: 2 }, { product_id: ids.book, qty: 1 }], phone: '0221 123456' }));
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.redirect).toMatch(/^https:\/\/www\.mollie\.com\/checkout\/tr_store/);
    const o = order(r.data.order.number);
    expect(o).toMatchObject({ number: 'B-1001', status: 'pending', fulfilment: 'unfulfilled', email: 'kundin@example.com', name: 'Klara Kundin', total_cents: 4107, shipping_cents: 490, tax_mode: 'standard', cart_id: ids.cart });
    expect(o.address).toMatchObject({ street: 'Gartenweg 5', postal_code: '50667', city: 'Köln', country: 'DE' });
    await settle();
    expect(events.find((e) => e.type === 'store.order_placed')?.data).toMatchObject({ orderId: o.id, productIds: [ids.mug, ids.book], order: { number: 'B-1001', total_cents: 4107 } });
    // Mollie got the order lines (Klarna) and the billing address
    const p = payments.get(t.app.db.get<any>('SELECT provider_ref FROM pay_sessions WHERE id = ?', o.pay_session_id)!.provider_ref)!;
    expect(p.amount).toEqual({ currency: 'EUR', value: '41.07' });
    expect(p.lines.map((l: any) => l.totalAmount.value)).toEqual(['26.18', '9.99', '4.90']);
    expect(p.billingAddress).toMatchObject({ givenName: 'Klara', familyName: 'Kundin', country: 'DE' });
    // the order page waits for the payment and offers to pay
    const waiting = (await t.api.get(`/store/laden/order/${o.token}`)).data as string;
    expect(waiting).toContain('Die Zahlung steht noch aus');
    expect(waiting).toContain('Jetzt bezahlen');
    p.status = 'paid';
    expect((await mollieHook(p.id)).handled).toBe('paid');
    const paid = order('B-1001');
    expect(paid).toMatchObject({ status: 'paid', provider: 'mollie' });
    const inv = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', paid.invoice_id)!;
    expect(inv).toMatchObject({ status: 'paid', total_cents: 4107, paid_cents: 4107, contact_id: paid.contact_id });
    expect(inv.number).toMatch(/^RE-\d+/);
    expect(inv.finalised_at).toBeTruthy();
    expect(JSON.parse(inv.items).map((i: any) => i.name)).toEqual(['Tasse', 'E-Book', 'Versand: DHL Paket']);
    expect(t.app.db.get<any>('SELECT method FROM invoice_payments WHERE invoice_id = ?', inv.id)!.method).toBe('Mollie');
    expect(stockOf(ids.red)).toBe(3);
    expect(t.app.db.get<any>(`SELECT ref_type, qty FROM inv_movements WHERE article_id = ? AND type = 'issue'`, ids.red)).toEqual({ ref_type: 'invoice', qty: -2 });
    expect(events.find((e) => e.type === 'store.order_paid')?.data).toMatchObject({ orderId: o.id, invoiceId: inv.id, provider: 'mollie' });
    expect(t.app.db.get<any>('SELECT status, order_id FROM store_carts WHERE id = ?', ids.cart)).toEqual({ status: 'ordered', order_id: o.id });
    // the confirmation with the invoice went out
    const mail = t.app.db.get<any>(`SELECT subject, body FROM messages WHERE contact_id = ? AND channel = 'email' ORDER BY created_at DESC LIMIT 1`, paid.contact_id)!;
    expect(mail.subject).toBe('Deine Bestellung B-1001 – vielen Dank!');
    expect(mail.body).toContain('2 × Tasse (Rot)');
    expect(mail.body).toContain('/store/laden/order/');
    const page = (await t.api.get(`/store/laden/order/${o.token}`)).data as string;
    expect(page).toContain('Die Zahlung ist eingegangen');
    expect(page).toContain(`Rechnung ${inv.number} ansehen`);
    // a second webhook changes nothing
    await mollieHook(p.id);
    expect(t.app.db.all('SELECT id FROM invoices WHERE title = ?', 'Bestellung B-1001')).toHaveLength(1);
  });

  it('ships with a tracking number (mail + trigger) and refunds', async () => {
    const o = order('B-1001');
    const r = await t.api.patch(`/api/store/orders/${o.id}`, { fulfilment: 'shipped', carrier: 'dhl', tracking_number: '00340434161234567890' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ fulfilment: 'shipped', fulfilment_label: 'Versendet', carrier_label: 'DHL', tracking_url: expect.stringContaining('piececode=00340434161234567890'), mail: { status: 'logged' } });
    await settle();
    expect(events.find((e) => e.type === 'store.order_shipped')?.data.order).toMatchObject({ number: 'B-1001', tracking_number: '00340434161234567890' });
    const mail = t.app.db.get<any>(`SELECT subject, body FROM messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1`, o.contact_id)!;
    expect(mail.subject).toBe('Deine Bestellung B-1001 ist unterwegs');
    expect(mail.body).toContain('Sendungsnummer: 00340434161234567890');
    const list = (await t.api.get('/api/store/orders?fulfilment=shipped')).data;
    expect(list.map((x: any) => x.number)).toEqual(['B-1001']);
    expect((await t.api.get('/api/store/orders?fulfilment=open')).data).toEqual([]);
    const ref = await t.api.post(`/api/store/orders/${o.id}/refund`, {});
    expect(ref.status, JSON.stringify(ref.data)).toBe(200);
    expect(ref.data).toMatchObject({ status: 'refunded', refunded_cents: 4107, fulfilment: 'shipped' });
    expect(calls.at(-1)!.url).toMatch(/\/v2\/payments\/tr_store\d+\/refunds$/);
    expect(calls.at(-1)!.body).toEqual({ amount: { currency: 'EUR', value: '41.07' } });
    expect((await t.api.post(`/api/store/orders/${o.id}/refund`, {})).status).toBe(409);
  });

  it('pays with a gift card: the whole order (no provider) or a part of it (held, then committed)', async () => {
    const card = (await t.api.post('/api/gift-cards', { amount_cents: 1500, recipient_name: 'Klara', note: 'Kulanz' })).data;
    expect(card.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const q = await pub('/quote', { items: [{ product_id: ids.book, qty: 1 }], country: 'DE', gift_code: card.code.toLowerCase().replace(/-/g, '') });
    expect(q.data).toMatchObject({ total_cents: 999, gift_cents: 999, due_cents: 0 });
    const r = await pub('/checkout', buyer({ items: [{ product_id: ids.book, qty: 1 }], gift_code: card.code, provider: '' }));
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.redirect).toBe(`/store/laden/order/${r.data.order.token}`);
    const o = order(r.data.order.number);
    expect(o).toMatchObject({ status: 'paid', provider: 'giftcard', gift_cents: 999 });
    expect(t.app.db.get<any>('SELECT balance_cents FROM gift_cards WHERE id = ?', card.id)!.balance_cents).toBe(501);
    expect(t.app.db.get<any>('SELECT method, amount_cents FROM invoice_payments WHERE invoice_id = ?', o.invoice_id)).toMatchObject({ method: 'Gutschein', amount_cents: 999 });
    expect(t.app.db.get<any>('SELECT status FROM invoices WHERE id = ?', o.invoice_id)!.status).toBe('paid');
    // a part: 5,01 € left on the card, the rest through Mollie; held until paid, released when the payment lapses
    const part = await pub('/checkout', buyer({ items: [{ product_id: ids.mug, article_id: ids.red, qty: 1 }], gift_code: card.code }));
    const o2 = order(part.data.order.number);
    const s2 = t.app.db.get<any>('SELECT * FROM pay_sessions WHERE id = ?', o2.pay_session_id)!;
    expect(s2).toMatchObject({ gift_cents: 501, amount_cents: o2.total_cents - 501 });
    expect((await t.api.get(`/api/gift-cards/${card.id}`)).data).toMatchObject({ balance_cents: 501, available_cents: 0, holds: [{ amount_cents: 501 }] });
    expect((await pub('/quote', { items: [{ product_id: ids.book, qty: 1 }], country: 'DE', gift_code: card.code })).data.gift_error).toMatch(/ungültig, abgelaufen oder aufgebraucht/);
    const p2 = payments.get(s2.provider_ref)!;
    p2.status = 'expired';
    await mollieHook(p2.id);
    expect(order(o2.number).status).toBe('cancelled');
    expect((await t.api.get(`/api/gift-cards/${card.id}`)).data).toMatchObject({ balance_cents: 501, available_cents: 501, holds: [] });
    // again, and paid this time: the hold becomes a redemption
    const again = await pub('/checkout', buyer({ items: [{ product_id: ids.mug, article_id: ids.red, qty: 1 }], gift_code: card.code }));
    const o3 = order(again.data.order.number);
    const s3 = t.app.db.get<any>('SELECT * FROM pay_sessions WHERE id = ?', o3.pay_session_id)!;
    payments.get(s3.provider_ref).status = 'paid';
    await mollieHook(s3.provider_ref);
    expect(order(o3.number).status).toBe('paid');
    const detail = (await t.api.get(`/api/gift-cards/${card.id}`)).data;
    expect(detail).toMatchObject({ balance_cents: 0, state: 'used' });
    expect(detail.ledger.map((l: any) => [l.kind, l.amount_cents])).toEqual([['issue', 1500], ['redeem', -999], ['redeem', -501]]);
    const pays = t.app.db.all<any>('SELECT method, amount_cents FROM invoice_payments WHERE invoice_id = ? ORDER BY created_at', order(o3.number).invoice_id);
    expect(pays).toEqual([{ method: 'Gutschein', amount_cents: 501 }, { method: 'Mollie', amount_cents: o3.total_cents - 501 }]);
  });

  it('sells gift cards: one card per unit, mailed to the recipient, untaxed until redeemed', async () => {
    const r = await pub('/checkout', buyer({ items: [{ product_id: ids.gift, qty: 2 }], gift_recipient_name: 'Gerd', gift_recipient_email: 'gerd@example.com', gift_message: 'Alles Gute!' }));
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const o = order(r.data.order.number);
    expect(o).toMatchObject({ total_cents: 5000, tax_cents: 0, shipping_cents: 0 });
    const s = t.app.db.get<any>('SELECT * FROM pay_sessions WHERE id = ?', o.pay_session_id)!;
    payments.get(s.provider_ref).status = 'paid';
    await mollieHook(s.provider_ref);
    const cards = t.app.db.all<any>('SELECT * FROM gift_cards WHERE order_id = ?', o.id);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ initial_cents: 2500, balance_cents: 2500, recipient_email: 'gerd@example.com', message: 'Alles Gute!', source: 'store' });
    expect(Date.parse(cards[0].expires_at)).toBeGreaterThan(Date.now() + 2.9 * 365 * 864e5);
    const inv = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', order(o.number).invoice_id)!;
    expect(JSON.parse(inv.items)[0]).toMatchObject({ tax_rate: 0, description: expect.stringContaining('§ 3 Abs. 15 UStG') });
  });

  it('a cart with an e-mail and no order fires checkout.abandoned once, with a link back to the cart', async () => {
    // a known contact without an order since (Klara bought just now – she is not reminded)
    await t.api.post('/api/contacts', { email: 'lena@example.com', first_name: 'Lena' });
    const c = await pub('/cart', { items: [{ product_id: ids.mug, article_id: ids.red, qty: 1 }], email: 'lena@example.com' });
    t.app.db.run('UPDATE store_carts SET updated_at = ?, created_at = ? WHERE id = ?', new Date(Date.now() - 31 * 60_000).toISOString(), new Date(Date.now() - 31 * 60_000).toISOString(), c.data.token);
    events.length = 0;
    await t.app.tick();
    await settle();
    const ev = events.filter((e) => e.type === 'checkout.abandoned');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ productId: ids.mug, product_name: 'Tasse', checkoutId: c.data.token, recovery_url: `http://localhost/store/laden/checkout?cart=${c.data.token}`, source: 'store' });
    const contact = t.app.db.get<any>('SELECT tags FROM contacts WHERE email = ?', 'lena@example.com')!;
    expect(JSON.parse(contact.tags)).toContain('warenkorbabbruch');
    // Klara's cart from the same time: she ordered and paid since, so nothing fires for her
    const k = await pub('/cart', { items: [{ product_id: ids.book, qty: 1 }], email: 'kundin@example.com' });
    t.app.db.run('UPDATE store_carts SET updated_at = ?, created_at = ? WHERE id = ?', new Date(Date.now() - 31 * 60_000).toISOString(), new Date(Date.now() - 31 * 60_000).toISOString(), k.data.token);
    t.app.db.run(`UPDATE store_orders SET created_at = ? WHERE status = 'paid'`, new Date().toISOString());
    await t.app.tick();
    expect(events.filter((e) => e.type === 'checkout.abandoned')).toHaveLength(1);
  });
});

describe('pages and blocks', () => {
  it('the checkout page is an on-page order form with a nonce CSP', async () => {
    const r = await t.api.raw('/store/laden/checkout');
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'nonce-[\w-]+'/);
    const body = await r.text();
    expect(body).toContain('Kaffeeladen · Kasse');
    expect(body).toContain('id="store-data"');
    expect(body).toContain('Zahlungspflichtig bestellen');
    expect((await t.api.raw('/store/nope/checkout')).status).toBe(404);
  });

  it('renders the product list and the product detail blocks with add-to-cart forms to the checkout', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Shop-Seite', kind: 'website' })).data;
    const pages = (await t.api.get(`/api/funnels/${f.id}`)).data.pages;
    const pageId = pages?.[0]?.id ?? (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Start' })).data.id;
    const save = await t.api.patch(`/api/funnel-pages/${pageId}`, { blocks: [{ id: 'b1', type: 'store_products', heading: 'Unsere Produkte', collection: 'geschirr', detail_url: '/p/x/produkt' }, { id: 'b2', type: 'store_product', product_id: ids.mug }] });
    expect(save.status, JSON.stringify(save.data)).toBe(200);
    const html = (await t.api.get(`/p/${f.slug}`)).data as string;
    expect(html).toContain('Unsere Produkte');
    expect(html).toContain('action="http://localhost/store/laden/checkout"');
    expect(html).toContain(`name="add_product" value="${ids.mug}"`);
    expect(html).toContain(`value="${ids.red}"`);
    expect(html).toContain('Blau – ausverkauft');
    expect(html).toMatch(/ab 11,90\s€/u);
    expect(html.match(/\.sgrid\{display:grid/g)).toHaveLength(1);
    expect(html).toContain('inkl. 19 % USt., zzgl. Versand');
    expect(html).toContain('/p/x/produkt?product=tasse');
    expect(html).not.toContain('E-Book'); // not in the collection
    expect(html).toContain('<strong>spülmaschinenfest</strong>');
  });
});

describe('snapshots and DSGVO', () => {
  it('copies store settings (switched off), collections and the products’ store fields', async () => {
    const data = exportSnapshot(t.app, loc);
    const part = data.store as any[];
    expect(part.find((x) => x.type === 'settings').data).toMatchObject({ enabled: false, slug: '', name: 'Kaffeeladen' });
    expect(part.filter((x) => x.type === 'product').length).toBeGreaterThanOrEqual(3);
    const other = (await t.api.post('/api/locations', { name: 'Filiale' })).data.id;
    applySnapshot(t.app, other, data);
    const products = t.app.db.all<any>('SELECT p.name, s.published, s.collection_ids FROM store_products s JOIN products p ON p.id = s.product_id WHERE s.location_id = ? ORDER BY p.name', other);
    expect(products.map((p) => p.name)).toEqual(expect.arrayContaining(['Tasse', 'E-Book', 'Geschenkgutschein 25 €']));
    const col = t.app.db.get<any>('SELECT id FROM store_collections WHERE location_id = ?', other)!;
    expect(JSON.parse(products.find((p) => p.name === 'Tasse').collection_ids)).toEqual([col.id]);
    expect(JSON.parse(t.app.db.get<any>('SELECT data FROM store_settings WHERE location_id = ?', other)!.data)).toMatchObject({ enabled: false, name: 'Kaffeeladen' });
  });

  it('exports the orders of a contact and erases the person from them (the business record stays)', async () => {
    const c = t.app.db.get<any>('SELECT id FROM contacts WHERE email = ?', 'kundin@example.com')!;
    const out = (await t.api.get(`/api/contacts/${c.id}/privacy-export`)).data;
    expect(out.data.store_orders.length).toBeGreaterThanOrEqual(3);
    expect(out.data.store_orders[0]).toHaveProperty('number');
    const r = await t.api.post(`/api/contacts/${c.id}/erase`, { confirm: c.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const left = t.app.db.all<any>('SELECT * FROM store_orders WHERE location_id = ?', loc);
    expect(left.length).toBeGreaterThanOrEqual(3);
    for (const o of left) {
      expect(o).toMatchObject({ contact_id: null, email: '', name: '', phone: '' });
      expect(JSON.parse(o.address)).toEqual({ country: 'DE' });
      expect(JSON.stringify(o)).not.toMatch(/Kundin|Gartenweg|kundin@/);
    }
    expect(t.app.db.all('SELECT id FROM store_carts WHERE location_id = ? AND email = ?', loc, 'kundin@example.com')).toEqual([]);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM gift_cards WHERE location_id = ? AND recipient_email = 'gerd@example.com'`, loc)!.n).toBe(2);
  });
});
