import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { DEFAULT_BUTTON, buttonOk, cleanLaw, waiverText } from '../server/modules/checkout-law.js';

/**
 * Checkout rules for Germany on the buy page: button text (§ 312j BGB), AGB box, Widerrufsrecht link, the waiver box for
 * digital content / services (§ 356 BGB), what is stored with the order, the confirmation mail – with a fake Stripe.
 */

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';
const calls: { path: string; params: URLSearchParams }[] = [];
const sessions = new Map<string, any>();
let seq = 0;
const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  calls.push({ path: u.pathname, params });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Testfirma' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    let total = 0;
    for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][quantity]`)) * Number(params.get(`line_items[${i}][price_data][unit_amount]`));
    const s = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: total, currency: 'eur', customer_email: params.get('customer_email'), payment_status: 'unpaid', status: 'open' };
    sessions.set(id, s);
    return json(s);
  }
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

const buy = (id: string, body = '', headers: Record<string, string> = {}) => t.api.raw(`/buy/${id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'TestBrowser/1', ...headers }, body });
const page = async (id: string) => (await (await t.api.raw(`/buy/${id}`)).text()).replace(/\s+/g, ' ');
const laws = () => t.app.db.all<any>('SELECT * FROM checkout_acceptances ORDER BY created_at');
async function paid(sessionId: string, email: string) {
  const session = { ...sessions.get(sessionId), status: 'complete', payment_status: 'paid', payment_intent: `pi_${sessionId}`, customer_details: { email, name: 'Karla Käuferin' } };
  const raw = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type: 'checkout.session.completed', data: { object: session } });
  const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return r.json();
}

describe('checkout rules (§ 312j, § 356 BGB)', () => {
  let prod: any;
  it('the order button names the payment obligation – nothing else changes before the owner sets anything up', async () => {
    prod = (await t.api.post('/api/products', { name: 'Online-Kurs', description: 'Alle Lektionen', price_cents: 4900, tax_rate: 19 })).data;
    const h = await page(prod.id);
    expect(h).toContain('zahlungspflichtig bestellen');
    expect(h).not.toContain('Jetzt kaufen');
    expect(h).toContain('Alle Preise inklusive der gesetzlichen Umsatzsteuer.');
    expect(h).not.toContain('law_terms');
    expect(h).not.toContain('law_waiver');
    const sub = (await t.api.post('/api/products', { name: 'Mitgliedschaft', price_cents: 2900, recurring: 'month' })).data;
    expect(await page(sub.id)).toContain('zahlungspflichtig bestellen');
    // An order without any box still works (nothing is asked for yet).
    expect((await buy(prod.id, 'email=a%40example.com')).status).toBe(303);
  });

  it('the button text must say it plainly; a custom text is checked', async () => {
    expect(buttonOk('zahlungspflichtig bestellen')).toBe(true);
    expect(buttonOk('Kostenpflichtig abonnieren')).toBe(true);
    expect(buttonOk('Jetzt kaufen')).toBe(false);
    expect(buttonOk('Weiter')).toBe(false);
    expect((await t.api.put('/api/checkout-law/settings', { button_text: 'Jetzt kaufen' })).status).toBe(400);
    expect((await t.api.put('/api/checkout-law/settings', { button_text: 'Kostenpflichtig bestellen' })).data.settings.button_text).toBe('Kostenpflichtig bestellen');
    expect(await page(prod.id)).toContain('Kostenpflichtig bestellen</button>');
    expect((await t.api.put('/api/checkout-law/settings', { button_text: '' })).data.settings.button_text).toBe(DEFAULT_BUTTON);
    // A text that slipped into the stored settings anyway falls back to the safe one.
    expect(cleanLaw({ button_text: 'Kaufen' }).button_text).toBe(DEFAULT_BUTTON);
  });

  it('links Widerrufsrecht, Datenschutz and Impressum once the company data exists', async () => {
    expect(await page(prod.id)).not.toContain('Widerrufsrecht');
    await t.api.patch('/api/location', { address: 'Hauptstraße 1\n10115 Berlin', email: 'info@testfirma.example' });
    const h = await page(prod.id);
    expect(h).toContain(`href="http://localhost/legal/${loc}/widerruf"`);
    expect(h).toContain(`href="http://localhost/legal/${loc}/datenschutz"`);
    expect(h).toContain(`href="http://localhost/legal/${loc}/impressum"`);
    expect(h).toContain('Informationen zum <a');
    // The linked page exists and carries the model text.
    expect(await (await t.api.raw(`/legal/${loc}/widerruf`)).text()).toContain('Muster-Widerrufsformular');
    // Own address wins.
    await t.api.put('/api/checkout-law/settings', { withdrawal_url: 'https://shop.example/widerruf' });
    expect(await page(prod.id)).toContain('href="https://shop.example/widerruf"');
    await t.api.put('/api/checkout-law/settings', { withdrawal_url: '' });
  });

  it('with an AGB address the box is required – the server refuses an order without it', async () => {
    expect((await t.api.put('/api/checkout-law/settings', { terms_url: 'javascript:alert(1)' })).status).toBe(400);
    await t.api.put('/api/checkout-law/settings', { terms_url: 'https://shop.example/agb' });
    const h = await page(prod.id);
    expect(h).toMatch(/<input type="checkbox" name="law_terms" value="1" required>/);
    expect(h).toContain('<a href="https://shop.example/agb" target="_blank" rel="noopener">Allgemeinen Geschäftsbedingungen</a> gelesen und akzeptiere sie.');
    const before = calls.length;
    const no = await buy(prod.id, 'email=b%40example.com');
    expect(no.status).toBe(400);
    expect(await no.text()).toContain('AGB');
    expect(calls.length).toBe(before);
    expect(laws()).toHaveLength(0);
    const yes = await buy(prod.id, 'email=b%40example.com&law_terms=1', { 'x-forwarded-for': '203.0.113.5' });
    expect(yes.status).toBe(303);
    const row = laws()[0];
    expect(row).toMatchObject({ product_id: prod.id, terms_url: 'https://shop.example/agb', terms_version: 1, waiver_kind: '', email: 'b@example.com', button_text: DEFAULT_BUTTON });
    expect(row.ip_net).toBe('127.0.0.0/24');
    expect(row.ua_digest).toMatch(/^[0-9a-f]{16}$/);
    const p = calls[calls.length - 1].params;
    expect(p.get('metadata[law_id]')).toBe(row.id);
    expect(p.get('metadata[law_terms]')).toBe('v1');
    expect(p.get('metadata[law_waiver]')).toBe('');
    // The text that was shown is kept (versioned).
    expect(t.app.db.get<any>('SELECT text, version FROM consent_texts WHERE id = ?', row.terms_text_id)).toMatchObject({ version: 1, text: 'Ich habe die Allgemeinen Geschäftsbedingungen gelesen und akzeptiere sie.' });
  });

  it('digital content: the waiver box with its exact words is required and kept with the order', async () => {
    await t.api.put('/api/checkout-law/settings', { content_type: 'digital' });
    const h = await page(prod.id);
    expect(h).toMatch(/<input type="checkbox" name="law_waiver" value="1" required>/);
    const text = waiverText('digital', 'Testfirma');
    expect(h).toContain(text.replace(/&/g, '&amp;'));
    expect(text).toContain('vor Ablauf der Widerrufsfrist');
    expect(text).toContain('Widerrufsrecht verliere');
    const before = calls.length;
    const half = await buy(prod.id, 'email=c%40example.com&law_terms=1');
    expect(half.status).toBe(400);
    expect(await half.text()).toContain('Widerrufsrechts');
    expect(calls.length).toBe(before);
    const ok = await buy(prod.id, 'email=c%40example.com&law_terms=1&law_waiver=1');
    expect(ok.status).toBe(303);
    const row = laws().pop();
    expect(row).toMatchObject({ waiver_kind: 'digital', waiver_version: 1, terms_version: 1 });
    const p = calls[calls.length - 1].params;
    expect(p.get('metadata[law_waiver]')).toBe('digital:v1');
    expect(t.app.db.get<any>('SELECT text FROM consent_texts WHERE id = ?', row.waiver_text_id)!.text).toBe(text);
    // Changed wording = new version, the old one stays.
    await t.api.patch('/api/location', { name: 'Testfirma Neu GmbH' });
    expect((await buy(prod.id, 'email=c%40example.com&law_terms=1&law_waiver=1')).status).toBe(303);
    expect(laws().pop()).toMatchObject({ waiver_version: 2 });
    expect(t.app.db.all('SELECT version FROM consent_texts WHERE key = ? ORDER BY version', 'checkout:waiver:digital').map((r: any) => r.version)).toEqual([1, 2]);
  });

  it('services have their own wording; a product can differ from the sub-account', async () => {
    const svc = (await t.api.post('/api/products', { name: 'Beratung', price_cents: 9900 })).data;
    const goods = (await t.api.post('/api/products', { name: 'Tasse', price_cents: 1500 })).data;
    await t.api.put('/api/checkout-law/settings', { products: { [svc.id]: 'service', [goods.id]: 'physical' } });
    const s = await page(svc.id);
    expect(s).toContain('Ich verlange ausdrücklich, dass');
    expect(s).toContain('Wertersatz');
    expect(s).toContain('Keine Versandkosten.');
    const g = await page(goods.id);
    expect(g).not.toContain('law_waiver');
    expect(g).toContain('Zuzüglich etwaiger Versandkosten.');
    expect(await page(prod.id)).toContain('Mir ist bekannt, dass ich mit Beginn der Ausführung');
    const view = (await t.api.get('/api/checkout-law/settings')).data;
    expect(view.settings.products[svc.id]).toBe('service');
    expect(view.products.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Beratung', 'Tasse']));
    expect(view.waiver.digital).toContain('Testfirma Neu GmbH');
  });

  it('the small-business note replaces the VAT line', async () => {
    await t.api.patch('/api/location', { settings: { invoices: { small_business: true } } });
    const h = await page(prod.id);
    expect(h).toContain('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.');
    expect(h).not.toContain('Alle Preise inklusive der gesetzlichen Umsatzsteuer.');
    await t.api.patch('/api/location', { settings: { invoices: { small_business: false } } });
  });

  it('after the payment the proof is tied to the order and the contact, the timeline says so, and a confirmation mail with the Widerrufsbelehrung follows', async () => {
    const go = await buy(prod.id, 'email=karla%40example.com&law_terms=1&law_waiver=1');
    const sid = go.headers.get('location')!.split('/').pop()!;
    const acceptance = laws().pop()!;
    expect(acceptance.session_id).toBeNull();
    const r = await paid(sid, 'karla@example.com');
    expect(r.handled).toBe('product_purchased');
    const row = t.app.db.get<any>('SELECT * FROM checkout_acceptances WHERE id = ?', acceptance.id)!;
    expect(row).toMatchObject({ session_id: sid, contact_id: r.contactId, invoice_id: r.invoiceId });
    const detail = (await t.api.get(`/api/contacts/${r.contactId}`)).data;
    const act = detail.activities.find((a: any) => a.type === 'checkout.accepted');
    expect(act.summary).toContain('AGB (Version 1)');
    expect(act.summary).toContain('Verzicht auf das Widerrufsrecht');
    const mail = t.app.db.get<any>(`SELECT * FROM messages WHERE contact_id = ? AND source = 'Bestellbestätigung'`, r.contactId)!;
    expect(mail.subject).toContain('Bestätigung deiner Bestellung');
    expect(mail.body).toContain('https://shop.example/agb');
    expect(mail.body).toContain(`/legal/${loc}/widerruf`);
    expect(mail.body).toContain('Ich stimme ausdrücklich zu, dass Testfirma Neu GmbH');
    expect(mail.body).toContain('Bitte bewahre diese E-Mail auf.');
    expect(mail.purpose).toBe('transactional');
    // The proof is part of the contact's privacy export.
    const exp = JSON.parse(await (await t.api.raw(`/api/contacts/${r.contactId}/privacy-export`, { headers: { cookie: t.api.cookie, 'x-location-id': loc } })).text());
    expect(Object.keys(exp.data)).toContain('checkout_acceptances');
    // The mail can be switched off.
    await t.api.put('/api/checkout-law/settings', { confirmation_mail: false });
    const go2 = await buy(prod.id, 'email=lars%40example.com&law_terms=1&law_waiver=1');
    const r2 = await paid(go2.headers.get('location')!.split('/').pop()!, 'lars@example.com');
    expect(t.app.db.get('SELECT id FROM messages WHERE contact_id = ? AND source = ?', r2.contactId, 'Bestellbestätigung')).toBeUndefined();
    expect(t.app.db.get<any>(`SELECT contact_id FROM checkout_acceptances WHERE session_id = ?`, go2.headers.get('location')!.split('/').pop()!)!.contact_id).toBe(r2.contactId);
    await t.api.put('/api/checkout-law/settings', { confirmation_mail: true });

    // Erasure: the proof stays with the order, the person's own traces go.
    const erase = await t.api.post(`/api/contacts/${r.contactId}/erase`, { confirm: 'karla@example.com' });
    expect(erase.status).toBe(200);
    expect(erase.data.retained).toContain('checkout_acceptances');
    expect(t.app.db.get<any>('SELECT * FROM checkout_acceptances WHERE id = ?', acceptance.id)).toMatchObject({ contact_id: null, email: '', ip_net: '', ua_digest: '', waiver_kind: 'digital', waiver_version: expect.any(Number), session_id: sid });
  });

  it('the list of accepted orders; settings are for the sub-account and can be turned off', async () => {
    const list = (await t.api.get('/api/checkout-law/acceptances')).data;
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list[0]).toMatchObject({ product_name: 'Online-Kurs' });
    const other = (await t.api.post('/api/locations', { name: 'Anders' })).data;
    expect((await t.api.get('/api/checkout-law/acceptances', { 'x-location-id': other.id })).data).toEqual([]);
    expect((await t.api.get('/api/checkout-law/settings', { 'x-location-id': other.id })).data.settings).toMatchObject({ terms_url: '', content_type: 'none' });
    await t.api.put('/api/checkout-law/settings', { enabled: false });
    const h = await page(prod.id);
    expect(h).toContain('Jetzt kaufen');
    expect(h).not.toContain('law_terms');
    expect((await buy(prod.id, 'email=frei%40example.com')).status).toBe(303);
    await t.api.put('/api/checkout-law/settings', { enabled: true });
  });
});
