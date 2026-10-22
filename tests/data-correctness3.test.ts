import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INV, nextLevel } from '../server/services/dunning-model.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/**
 * Money that came out wrong (third pass, after tests/data-correctness.test.ts and tests/data-correctness2.test.ts): online
 * payments charged the invoice total instead of what is still open; a Storno after a partial credit note credited the full
 * amount again; the minimum gap between two dunning notices counted 24-hour blocks.
 */

vi.setConfig({ hookTimeout: 60_000 });

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';
const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB', paypal: 'musterpay' };

/** A fake Stripe: Checkout Sessions with the amount of their lines, nothing else. */
const calls: { method: string; path: string; params: URLSearchParams }[] = [];
const sessions = new Map<string, any>();
let seq = 0;
const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  calls.push({ method: init.method, path: u.pathname, params });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/account') return json({ id: 'acct_dc3', settings: { dashboard: { display_name: 'Muster GmbH' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_dc3_${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    let total = 0;
    for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][quantity]`)) * Number(params.get(`line_items[${i}][price_data][unit_amount]`));
    const s = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: total, currency: params.get('line_items[0][price_data][currency]'), payment_status: 'unpaid', status: 'open' };
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
let contactId = '';

beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
  expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

const finalised = async (body: Record<string, unknown>) => {
  const draft = (await t.api.post('/api/invoices', { contact_id: contactId, ...body })).data;
  const r = await t.api.post(`/api/invoices/${draft.id}/finalise`);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const get = async (id: string) => (await t.api.get(`/api/invoices/${id}`)).data;
const pay = async (invoiceId: string, amount_cents?: number) => {
  const r = await t.api.post(`/api/invoices/${invoiceId}/payments`, amount_cents === undefined ? {} : { amount_cents });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const credit = async (invoiceId: string, items: Record<string, unknown>[]) => {
  const cn = await t.api.post(`/api/invoices/${invoiceId}/credit-note`, { items, reason: 'Kulanz' });
  expect(cn.status, JSON.stringify(cn.data)).toBe(200);
  const fin = await t.api.post(`/api/invoices/${cn.data.id}/finalise`);
  expect(fin.status, JSON.stringify(fin.data)).toBe(200);
  await t.app.events.flush();
  return fin.data;
};
/** "Jetzt bezahlen" on the customer's invoice page: the redirect and what was sent to Stripe. */
const checkout = async (inv: any) => {
  const before = calls.length;
  const r = await t.api.raw(`/i/${inv.public_token}/pay`, { method: 'POST', redirect: 'manual' });
  const call = calls.slice(before).find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST');
  const lines: { name: string; description: string; unit_amount: number; quantity: number }[] = [];
  for (let i = 0; call?.params.has(`line_items[${i}][quantity]`); i++)
    lines.push({
      name: call.params.get(`line_items[${i}][price_data][product_data][name]`)!,
      description: call.params.get(`line_items[${i}][price_data][product_data][description]`) ?? '',
      unit_amount: Number(call.params.get(`line_items[${i}][price_data][unit_amount]`)),
      quantity: Number(call.params.get(`line_items[${i}][quantity]`)),
    });
  const sid = r.status === 303 ? r.headers.get('location')!.split('/').pop()! : '';
  return { status: r.status, text: r.status === 303 ? '' : await r.text(), sid, session: sessions.get(sid), lines, params: call?.params, charged: lines.reduce((n, l) => n + l.unit_amount * l.quantity, 0) };
};
async function hook(event: any) {
  const raw = JSON.stringify(event);
  const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return { status: r.status, data: await r.json() };
}
let evt = 0;
const completed = (session: any, extra: Record<string, unknown> = {}) => ({ id: `evt_dc3_${++evt}`, object: 'event', type: 'checkout.session.completed', data: { object: { ...session, payment_status: 'paid', status: 'complete', ...extra } } });
const page = async (inv: any) => (await (await t.api.raw(`/i/${inv.public_token}`)).text()).replace(/ /g, ' ');
const ITEMS = [{ name: 'Beratung', qty: 2, price_cents: 50000, tax_rate: 19 }];

describe('online payment charges what is open, never the whole invoice again', () => {
  it('a partly paid invoice: Checkout asks for the rest, as one line "Restbetrag Rechnung …"', async () => {
    const inv = await finalised({ items: ITEMS });
    expect(inv.total_cents).toBe(119000);
    await pay(inv.id, 50000);
    expect((await get(inv.id)).open_cents).toBe(69000);
    const c = await checkout(inv);
    expect(c.status).toBe(303);
    expect(c.charged).toBe(69000);
    expect(c.session.amount_total).toBe(69000);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatchObject({ name: `Restbetrag Rechnung ${inv.number}`, unit_amount: 69000, quantity: 1 });
    // what makes up the difference, and the VAT like on the other lines
    const desc = c.lines[0].description.replace(/ /g, ' ');
    expect(desc).toContain('1.190,00 €');
    expect(desc).toContain('bereits bezahlt 500,00 €');
    expect(desc).toContain('inkl. 19 % USt.');
    expect(c.params!.get('payment_intent_data[description]')).toBe(`Restbetrag Rechnung ${inv.number}`);
    expect(t.app.db.get<any>('SELECT amount_cents FROM stripe_checkouts WHERE id = ?', c.sid)!.amount_cents).toBe(69000);
    // the page says what is open, and PayPal.me asks for the same amount
    const html = await page(inv);
    expect(html).toContain('Offener Betrag: 690,00 €');
    expect(html).toContain('https://www.paypal.me/musterpay/690.00EUR');
    // a second click within the half hour reuses the page with the same amount
    const again = await checkout(inv);
    expect(again.sid).toBe(c.sid);
  });

  it('an invoice reduced by a credit note (Gutschrift): Checkout asks for the total minus the credit', async () => {
    const inv = await finalised({ items: ITEMS });
    await credit(inv.id, [{ name: 'Beratung', qty: 1, price_cents: 20000, tax_rate: 19 }]);
    expect((await get(inv.id)).open_cents).toBe(119000 - 23800);
    const c = await checkout(inv);
    expect(c.charged).toBe(95200);
    expect(c.lines).toEqual([expect.objectContaining({ name: `Restbetrag Rechnung ${inv.number}`, unit_amount: 95200, quantity: 1 })]);
    expect(c.lines[0].description.replace(/ /g, ' ')).toContain('Gutschriften 238,00 €');
    expect(await page(inv)).toContain('Offener Betrag: 952,00 €');
  });

  it('a final invoice (Schlussrechnung): the partial invoices it deducts are not charged again', async () => {
    const partial = await finalised({ inv_type: 'partial', items: [{ name: 'Abschlag', qty: 1, price_cents: 40000, tax_rate: 19 }] });
    await pay(partial.id);
    const fin = await finalised({ inv_type: 'final', deduct_ids: [partial.id], items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] });
    expect(fin).toMatchObject({ total_cents: 119000, deducted_cents: 47600, open_cents: 71400 });
    const c = await checkout(fin);
    expect(c.charged).toBe(71400);
    expect(c.lines).toEqual([expect.objectContaining({ name: `Restbetrag Rechnung ${fin.number}`, unit_amount: 71400 })]);
    expect(c.lines[0].description.replace(/ /g, ' ')).toContain('Abschlagsrechnungen 476,00 €');
  });

  it('nothing open (paid in part, credited for the rest): no button, and starting a payment is refused', async () => {
    const inv = await finalised({ items: ITEMS });
    await pay(inv.id, 59500);
    await credit(inv.id, [{ name: 'Beratung', qty: 1, price_cents: 50000, tax_rate: 19 }]);
    expect(await get(inv.id)).toMatchObject({ status: 'sent', open_cents: 0 });
    expect(await page(inv)).not.toContain('Jetzt bezahlen');
    const c = await checkout(inv);
    expect(c.status).toBe(400);
    expect(c.text).toContain('nichts mehr offen');
    expect(c.lines).toEqual([]);
  });

  it('an untouched invoice keeps its itemised lines', async () => {
    const inv = await finalised({ items: [...ITEMS, { name: 'Handbuch', qty: 1, price_cents: 1000, tax_rate: 7 }] });
    const c = await checkout(inv);
    expect(c.charged).toBe(inv.total_cents);
    expect(c.lines.map((l) => [l.name, l.unit_amount, l.quantity])).toEqual([
      ['Beratung', 59500, 2],
      ['Handbuch', 1070, 1],
    ]);
  });

  it('the webhook books what arrived: the open amount pays the invoice, less is a part payment, more never books more than is open', async () => {
    // the rest of a partly paid invoice → paid
    const a = await finalised({ items: ITEMS });
    await pay(a.id, 50000);
    const ca = await checkout(a);
    expect((await hook(completed(ca.session, { payment_intent: 'pi_dc3_a' }))).data).toMatchObject({ handled: 'invoice_paid' });
    expect(await get(a.id)).toMatchObject({ status: 'paid', paid_cents: 119000, open_cents: 0 });
    const paymentsA = (await t.api.get(`/api/invoices/${a.id}/payments`)).data as any[];
    expect(paymentsA.map((p) => p.amount_cents)).toEqual(expect.arrayContaining([50000, 69000]));

    // less than open (a session from before the invoice changed, or a tampered amount) → a part payment of what arrived
    const b = await finalised({ items: ITEMS });
    const cb = await checkout(b);
    const short = completed({ ...cb.session, amount_total: 40000 }, { payment_intent: 'pi_dc3_b' });
    expect((await hook(short)).data).toMatchObject({ handled: 'invoice_partially_paid' });
    expect(await get(b.id)).toMatchObject({ status: 'sent', state: 'partially_paid', paid_cents: 40000, open_cents: 79000 });
    // the same payment again (retry, its PaymentIntent event, the return from Checkout) books nothing more
    expect((await hook({ ...short, id: `evt_dc3_${++evt}` })).data).toMatchObject({ handled: 'already_paid' });
    expect((await hook({ id: `evt_dc3_${++evt}`, type: 'payment_intent.succeeded', data: { object: { id: 'pi_dc3_b', object: 'payment_intent', amount_received: 40000, currency: 'eur', metadata: { invoice_id: b.id, location_id: loc } } } })).data).toMatchObject({ handled: 'already_paid' });
    expect((await get(b.id)).paid_cents).toBe(40000);
    const activity = (await t.api.get(`/api/contacts/${contactId}`)).data.activities.map((x: any) => x.summary.replace(/ /g, ' ')).join('\n');
    expect(activity).toContain('400,00 €');
    expect(activity).toContain('weniger als der offene Betrag 1.190,00 €');

    // more than open: a Checkout page from before a bank transfer arrived – the invoice is paid with what was open, the rest is flagged
    const c = await finalised({ items: ITEMS });
    const cc = await checkout(c);
    await pay(c.id, 19000);
    expect((await hook(completed(cc.session, { payment_intent: 'pi_dc3_c' }))).data).toMatchObject({ handled: 'invoice_paid' });
    expect(await get(c.id)).toMatchObject({ status: 'paid', paid_cents: 119000, open_cents: 0 });
    const trail = ((await t.api.get(`/api/invoices/${c.id}/audit`)).data as any[]).map((x) => `${x.action} ${x.detail}`.replace(/ /g, ' ')).join('\n');
    expect(trail).toContain('190,00 €');
    expect(trail).toContain('payment.mismatch');

    // money for an invoice that has nothing open any more is not booked either
    const d = await finalised({ items: ITEMS });
    const cd = await checkout(d);
    await pay(d.id);
    expect((await hook(completed(cd.session, { payment_intent: 'pi_dc3_d' }))).data).toMatchObject({ handled: 'already_paid' });
    expect(await get(d.id)).toMatchObject({ status: 'paid', paid_cents: 119000 });
    expect(((await t.api.get(`/api/invoices/${d.id}/audit`)).data as any[]).some((x) => x.action === 'payment.mismatch')).toBe(true);
  });

  it('SEPA collection and the billing page use the open amount, too', async () => {
    const inv = await finalised({ items: ITEMS });
    await pay(inv.id, 50000);
    await credit(inv.id, [{ name: 'Beratung', qty: 0.5, price_cents: 20000, tax_rate: 19 }]);
    const open = (await get(inv.id)).open_cents;
    expect(open).toBe(119000 - 50000 - 11900);
    // SEPA direct debit with an own mandate: the candidate is the open amount
    expect((await t.api.put('/api/sepa/settings', { creditor_id: 'DE98ZZZ09999999999' })).status).toBe(200);
    expect((await t.api.post('/api/sepa/mandates', { contact_id: contactId, holder: 'Max Kunde', iban: 'DE89370400440532013000', signed_at: '2026-01-15' })).status).toBe(200);
    const cand = ((await t.api.get('/api/sepa/candidates')).data.items as any[]).find((x) => x.invoice_id === inv.id);
    expect(cand.open_cents).toBe(open);
    // the customer's billing page (/abo/…) says what is open, not only the total
    const link = (await t.api.post('/api/dunning/billing-link', { contact_id: contactId })).data;
    const html = (await (await t.api.raw(new URL(link.url).pathname)).text()).replace(/ /g, ' ');
    const row = html.slice(html.indexOf(inv.number), html.indexOf('</tr>', html.indexOf(inv.number)));
    expect(row).toContain('1.190,00 €');
    expect(row).toContain('offen 571,00 €');
  });
});

describe('a Storno after a partial credit note credited more than the invoice was for', () => {
  const creditNotesOf = (invoiceId: string) => t.app.db.all<any>(`SELECT credit_type, total_cents, finalised_at FROM invoices WHERE ref_id = ? AND kind = 'credit_note'`, invoiceId);

  it('is refused and points to crediting the rest; "Restbetrag gutschreiben" credits exactly what is left and closes the invoice', async () => {
    const inv = await finalised({ items: ITEMS });
    await credit(inv.id, [{ name: 'Beratung', qty: 1, price_cents: 20000, tax_rate: 19 }]);
    const r = await t.api.post(`/api/invoices/${inv.id}/storno`, { reason: 'Auftrag storniert' });
    expect(r.status).toBe(409);
    const msg = String(r.data.error).replace(/ /g, ' ');
    expect(msg).toContain('Gutschriften über 238,00 €');
    expect(msg).toContain('Restbetrag gutschreiben');
    expect(msg).toContain('952,00 €');
    // the status change (and with it the MCP tool) is refused the same way; nothing was written
    expect((await t.api.patch(`/api/invoices/${inv.id}`, { status: 'void' })).status).toBe(409);
    expect(await get(inv.id)).toMatchObject({ status: 'sent', storno_id: null, credited_cents: 23800, open_cents: 95200 });
    expect(creditNotesOf(inv.id).map((c) => c.credit_type)).toEqual(['credit']);

    // the rest as a credit note: what is left of the invoice's lines, exactly
    const rest = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { remainder: true, reason: 'Auftrag storniert' });
    expect(rest.status, JSON.stringify(rest.data)).toBe(200);
    expect(rest.data).toMatchObject({ kind: 'credit_note', credit_type: 'credit', ref_id: inv.id, total_cents: -95200 });
    expect(rest.data.items).toEqual([expect.objectContaining({ name: `Restbetrag zu ${inv.number}`, qty: -1, price_cents: 80000, tax_rate: 19 })]);
    expect(rest.data.warnings ?? []).toEqual([]);
    expect((await t.api.post(`/api/invoices/${rest.data.id}/finalise`)).status).toBe(200);
    await t.app.events.flush();
    expect(await get(inv.id)).toMatchObject({ status: 'void', state: 'credited', credited_cents: 119000, open_cents: 0 });
    expect(creditNotesOf(inv.id).reduce((n, c) => n + c.total_cents, 0)).toBe(-119000);
    expect((await t.api.post(`/api/invoices/${inv.id}/credit-note`, { remainder: true })).status).toBe(409);
  });

  it('paid in part, several tax rates, a final invoice: the rest per rate, never above what is left', async () => {
    // 19 %: 3 × 33,33 = 99,99 net; 7 %: 10,01 net → 118,99 + 10,71 = 129,70
    const inv = await finalised({ items: [{ name: 'Beratung', qty: 3, price_cents: 3333, tax_rate: 19 }, { name: 'Buch', qty: 1, price_cents: 1001, tax_rate: 7 }] });
    expect(inv.total_cents).toBe(12970);
    await pay(inv.id, 5000);
    await credit(inv.id, [{ name: 'Beratung', qty: 1, price_cents: 3333, tax_rate: 19 }]);
    expect((await t.api.post(`/api/invoices/${inv.id}/storno`, {})).status).toBe(409);
    const rest = (await t.api.post(`/api/invoices/${inv.id}/credit-note`, { remainder: true })).data;
    expect(rest.items.map((i: any) => [i.tax_rate, i.price_cents])).toEqual([
      [19, 6666],
      [7, 1001],
    ]);
    expect(rest.total_cents).toBe(-(12970 - 3966));
    expect((await t.api.post(`/api/invoices/${rest.id}/finalise`)).status).toBe(200);
    // paid in part and credited in full: nothing open, the 50,00 € paid are the customer's to get back
    expect(await get(inv.id)).toMatchObject({ credited_cents: 12970, paid_cents: 5000, open_cents: 0 });

    // VAT rounding: crediting the plain rest of the net (8,51) would come to 10,13 – one cent above what is left (10,12)
    const a = await finalised({ items: [{ name: 'Teil', qty: 1, price_cents: 1001, tax_rate: 19 }] });
    await credit(a.id, [{ name: 'Teil', qty: 1, price_cents: 150, tax_rate: 19 }]);
    const ra = (await t.api.post(`/api/invoices/${a.id}/credit-note`, { remainder: true })).data;
    expect(ra.total_cents).toBe(-(1191 - 179));
    expect((await t.api.post(`/api/invoices/${ra.id}/finalise`)).status).toBe(200);
    expect(await get(a.id)).toMatchObject({ state: 'credited', open_cents: 0 });
    // …and where no net gives the exact rest, the credit note stops a cent short (and says so) instead of crediting a cent too much
    const b = await finalised({ items: [{ name: 'Teil', qty: 1, price_cents: 1000, tax_rate: 19 }] });
    await credit(b.id, [{ name: 'Teil', qty: 1, price_cents: 150, tax_rate: 19 }]);
    const rb = (await t.api.post(`/api/invoices/${b.id}/credit-note`, { remainder: true })).data;
    expect(rb.total_cents).toBe(-(1190 - 179 - 1));
    expect(String(rb.warnings?.[0] ?? '').replace(/ /g, ' ')).toContain('0,01 €');

    // a final invoice: like its Storno, the rest leaves the deducted partial invoices standing
    const partial = await finalised({ inv_type: 'partial', items: [{ name: 'Abschlag', qty: 1, price_cents: 40000, tax_rate: 19 }] });
    const fin = await finalised({ inv_type: 'final', deduct_ids: [partial.id], items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] });
    await credit(fin.id, [{ name: 'Projekt', qty: 1, price_cents: 10000, tax_rate: 19 }]);
    expect((await t.api.post(`/api/invoices/${fin.id}/storno`, {})).status).toBe(409);
    const rf = (await t.api.post(`/api/invoices/${fin.id}/credit-note`, { remainder: true })).data;
    expect(rf.items.map((i: any) => i.price_cents)).toEqual([100000 - 40000 - 10000]);
    expect(rf.total_cents).toBe(-(119000 - 47600 - 11900));
    expect((await t.api.post(`/api/invoices/${rf.id}/finalise`)).status).toBe(200);
    expect(await get(fin.id)).toMatchObject({ state: 'credited', open_cents: 0 });
    expect((await get(partial.id)).status).not.toBe('void');
  });

  it('without credit notes the Storno works as before', async () => {
    const inv = await finalised({ items: ITEMS });
    const r = await t.api.post(`/api/invoices/${inv.id}/storno`, { reason: 'Falscher Empfänger' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.storno.total_cents).toBe(-119000);
    expect(r.data.original).toMatchObject({ status: 'void', state: 'cancelled' });
  });
});

describe('the minimum gap between two dunning notices is calendar days of the sub-account, not 24-hour blocks', () => {
  // a notice sent at 23:00 on 1 October (Berlin); "at least 3 days" means from 4 October, whatever the hour
  const SENT = '2026-10-01T21:00:00.000Z';
  const levels = [{ ...DEFAULT_INV.levels[0], days: 1 }, { ...DEFAULT_INV.levels[1], days: 2 }, { ...DEFAULT_INV.levels[2], days: 3 }];
  const s = { ...DEFAULT_INV, levels, min_gap_days: 3 };
  const due = '2026-09-01T10:00:00.000Z';

  it('a notice of 23:00 allows the next one at 08:00 three calendar days later (only 57 hours), not at 23:30 two days later', () => {
    const at = (iso: string) => nextLevel(s, { due_at: due, last_level: 1, last_sent_at: SENT, at: new Date(iso), tz: 'Europe/Berlin' });
    expect(at('2026-10-04T06:00:00.000Z')).toBe(1); // 08:00 on the 4th
    expect(at('2026-10-03T21:30:00.000Z')).toBeNull(); // 23:30 on the 3rd
    expect(at('2026-10-03T22:30:00.000Z')).toBe(1); // 00:30 on the 4th
    // the zone is the sub-account's: 21:00 UTC on 1 October is still the 1st in New York, so the 4th starts there later
    expect(nextLevel(s, { due_at: due, last_level: 1, last_sent_at: SENT, at: new Date('2026-10-04T03:00:00.000Z'), tz: 'America/New_York' })).toBeNull();
    expect(nextLevel(s, { due_at: due, last_level: 1, last_sent_at: SENT, at: new Date('2026-10-04T05:00:00.000Z'), tz: 'America/New_York' })).toBe(1);
    // no gap configured: the next level as soon as it is due
    expect(nextLevel({ ...s, min_gap_days: 0 }, { due_at: due, last_level: 1, last_sent_at: SENT, at: new Date(SENT), tz: 'Europe/Berlin' })).toBe(1);
  });

  it('the dunning run follows it', async () => {
    const buyer = (await t.api.post('/api/contacts', { email: 'abstand@kunde.example', first_name: 'Abe', last_name: 'Abstand', address: 'Weg 9', postal_code: '10115', city: 'Berlin' })).data.id;
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval', min_amount_cents: 0, min_gap_days: 3, levels: [{ days: 1 }, { days: 2 }, { days: 3 }] } });
    try {
      pinClock(SENT);
      const inv = await finalised({ contact_id: buyer, items: [{ name: 'Wartung', qty: 1, price_cents: 10000, tax_rate: 0 }], due_at: due });
      const first = await t.api.post(`/api/dunning/invoices/${inv.id}/notice`, { send: true });
      expect(first.status, JSON.stringify(first.data)).toBe(200);
      const dueNow = async () => ((await t.api.post('/api/dunning/run', { dry_run: true })).data.due as any[]).filter((d) => d.invoice_id === inv.id).map((d) => d.level);
      pinClock('2026-10-03T21:30:00.000Z');
      expect(await dueNow()).toEqual([]);
      pinClock('2026-10-04T06:00:00.000Z');
      expect(await dueNow()).toEqual([2]);
    } finally {
      unpinClock();
      await t.api.put('/api/dunning/settings', { inv: { mode: 'off' } });
    }
  });
});
