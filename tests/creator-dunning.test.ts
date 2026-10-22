import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch } from '../server/services/stripe.js';
import { signToken } from '../server/services/creator-kit.js';
import { cleanInv, cleanLevels, daysOverdue, interestCents, nextLevel, noticeAmounts, DEFAULT_INV } from '../server/services/dunning-model.js';
import { KEY, WHSEC, fakeStripe, formPost, sendEvent, stripeInvoice } from './creator-fakes.js';

const stripe = fakeStripe();
let t: Awaited<ReturnType<typeof startTestApp>>;
const events: { type: string; data: any }[] = [];
const loc = () => t.api.location;
beforeAll(async () => {
  setStripeFetch(stripe.handler);
  t = await startTestApp();
  await t.setup();
  await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
  for (const type of ['dunning.started', 'dunning.final_failed', 'dunning.recovered', 'invoice.dunning_sent']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

const product = async (body: any) => (await t.api.post('/api/products', body)).data;
const tags = (email: string) => JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE email = ?', email)!.tags) as string[];
const mails = (email: string, source?: string) =>
  t.app.db.all<any>(`SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE c.email = ? AND m.direction = 'out' ${source ? 'AND m.source = ?' : ''} ORDER BY m.created_at, m.rowid`, email, ...(source ? [source] : []));
const lastEvents = (type: string) => events.filter((e) => e.type === type);

describe('maths', () => {
  it('computes default interest like § 288 BGB', () => {
    expect(interestCents(100000, 1.27, 5, 365)).toBe(6270);
    expect(interestCents(100000, 1.27, 9, 365)).toBe(10270);
    expect(interestCents(11900, 1.27, 5, 30)).toBe(Math.round((11900 * 0.0627 * 30) / 365));
    expect(interestCents(100000, 1.27, 5, 0)).toBe(0);
    expect(interestCents(0, 1.27, 5, 30)).toBe(0);
    // a negative base rate never turns the claim into a credit
    expect(interestCents(100000, -3, 1, 365)).toBe(0);
    expect(daysOverdue('2026-01-01T00:00:00.000Z', new Date('2026-01-31T12:00:00.000Z'))).toBe(30);
    expect(daysOverdue('2026-02-01T00:00:00.000Z', new Date('2026-01-31T12:00:00.000Z'))).toBe(0);
  });

  it('builds the claim per level: fee, interest from the chosen level, flat fee only between businesses', () => {
    const s = DEFAULT_INV;
    const due = '2026-01-01T00:00:00.000Z';
    const at = new Date('2026-02-05T00:00:00.000Z'); // 35 days
    const r1 = noticeAmounts(s, 0, { principal_cents: 11900, due_at: due, at });
    expect(r1).toMatchObject({ fee_cents: 0, interest_cents: 0, flat_fee_cents: 0, total_cents: 11900, business: false });
    const c2 = noticeAmounts(s, 2, { principal_cents: 11900, due_at: due, at });
    expect(c2).toMatchObject({ fee_cents: 1000, flat_fee_cents: 0, days: 35, rate: 6.27 });
    expect(c2.interest_cents).toBe(Math.round((11900 * 0.0627 * 35) / 365));
    expect(c2.total_cents).toBe(11900 + 1000 + c2.interest_cents);
    const b2 = noticeAmounts(s, 2, { principal_cents: 11900, due_at: due, at, company: 'Muster GmbH' });
    expect(b2).toMatchObject({ business: true, flat_fee_cents: 4000, rate: 10.27 });
    // interest can be switched off, the base rate edited
    const none = noticeAmounts({ ...s, interest: { ...s.interest, enabled: false } }, 2, { principal_cents: 11900, due_at: due, at });
    expect(none.interest_cents).toBe(0);
    const high = noticeAmounts({ ...s, interest: { ...s.interest, base_rate: 3.5 } }, 2, { principal_cents: 11900, due_at: due, at });
    expect(high.rate).toBe(8.5);
  });

  it('moves one level at a time, never earlier than its day and never within the minimum gap', () => {
    const s = DEFAULT_INV; // 7 / 21 / 35 days
    const due = '2026-01-01T00:00:00.000Z';
    const at = (d: number) => new Date(Date.parse(due) + d * 864e5);
    expect(nextLevel(s, { due_at: due, last_level: 0, at: at(6) })).toBeNull();
    expect(nextLevel(s, { due_at: due, last_level: 0, at: at(7) })).toBe(0);
    // far overdue, but still one step at a time
    expect(nextLevel(s, { due_at: due, last_level: 0, at: at(90) })).toBe(0);
    expect(nextLevel(s, { due_at: due, last_level: 1, last_sent_at: at(8).toISOString(), at: at(20) })).toBeNull();
    expect(nextLevel(s, { due_at: due, last_level: 1, last_sent_at: at(19).toISOString(), at: at(21) })).toBeNull(); // 2 days since the last one
    expect(nextLevel(s, { due_at: due, last_level: 1, last_sent_at: at(8).toISOString(), at: at(21) })).toBe(1);
    expect(nextLevel(s, { due_at: due, last_level: 3, at: at(400) })).toBeNull();
  });

  it('validates settings', () => {
    expect(() => cleanLevels([{ days: 10 }, { days: 10 }])).toThrow('wachsen');
    expect(() => cleanLevels([])).toThrow('Mahnstufen');
    expect(() => cleanInv({ interest: { base_rate: 50 } })).toThrow('Basiszinssatz');
    expect(() => cleanInv({ mode: 'sometimes' })).toThrow('Modus');
    expect(cleanInv({ interest: { base_rate: '2,5' } }).interest.base_rate).toBe(2.5);
    expect(cleanInv({ levels: [{ days: 5, fee_cents: 250 }] }).levels).toHaveLength(1);
  });
});

describe('failed subscription payments', () => {
  const sub = 'sub_club1';
  const email = 'abo@kunde.de';
  let p: any;
  let meta: Record<string, string>;
  const failed = (o: { id: string; next?: number | null; attempt?: number }) => stripeInvoice({ id: o.id, sub, amount: 2900, metadata: meta, email, status: 'open', next: o.next, attempt: o.attempt });

  it('starts a case, mails the card-update link and keeps the access while Stripe retries', async () => {
    p = await product({ name: 'Club', price_cents: 2437, tax_rate: 19, recurring: 'month' });
    const r = await t.api.raw(`/buy/${p.id}`, formPost({ email }));
    expect(r.status).toBe(303);
    const sid = new URL(r.headers.get('location')!).pathname.split('/').pop()!;
    const session = { ...stripe.sessions.get(sid), subscription: sub, customer: 'cus_club', customer_details: { email, name: 'Anna Abo' }, status: 'complete', payment_status: 'paid' };
    meta = session.metadata;
    expect((await sendEvent(t, 'checkout.session.completed', session)).data.handled).toBe('product_purchased');
    expect(tags(email)).toContain('kauf:club');

    const next = Math.floor(Date.now() / 1000) + 3 * 86400;
    await sendEvent(t, 'invoice.payment_failed', failed({ id: 'in_f1', next }));
    await new Promise((r) => setTimeout(r, 30));
    const cases = (await t.api.get('/api/dunning/cases')).data;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ status: 'open', attempts: 1, product_name: 'Club', amount_cents: 2900, contact: { email }, stripe_subscription: sub });
    expect(lastEvents('dunning.started')).toHaveLength(1);
    const m = mails(email, 'Mahnwesen');
    expect(m).toHaveLength(1);
    expect(m[0].subject).toContain('Club');
    expect(m[0].body).toMatch(new RegExp(`${t.app.baseUrl().replace(/\//g, '\\/')}/abo/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`));
    expect(m[0].body).toContain('29,00');
    expect(tags(email)).toContain('kauf:club');

    // a second attempt updates the same case, no second mail
    await sendEvent(t, 'invoice.payment_failed', failed({ id: 'in_f1', next, attempt: 2 }));
    const again = (await t.api.get('/api/dunning/cases')).data;
    expect(again).toHaveLength(1);
    expect(again[0].attempts).toBe(2);
    expect(mails(email, 'Mahnwesen')).toHaveLength(1);
    expect(lastEvents('dunning.started')).toHaveLength(1);
  });

  it('sends the reminder on its day', async () => {
    t.app.db.run(`UPDATE dunning_cases SET first_failed_at = ? WHERE stripe_subscription = ?`, new Date(Date.now() - 3.2 * 864e5).toISOString(), sub);
    await t.app.services.dunning.sweep(true);
    const m = mails(email, 'Mahnwesen');
    expect(m).toHaveLength(2);
    expect(m[1].subject).toContain('Erinnerung');
    await t.app.services.dunning.sweep(true);
    expect(mails(email, 'Mahnwesen')).toHaveLength(2); // not twice
    const c = (await t.api.get('/api/dunning/cases')).data[0];
    expect((await t.api.get(`/api/dunning/cases/${c.id}`)).data.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['started', 'failed_again', 'message_first', 'message_reminder']));
  });

  it('pauses the access when Stripe stops, and brings it back with the payment', async () => {
    await sendEvent(t, 'invoice.payment_failed', failed({ id: 'in_f1', next: null, attempt: 4 }));
    await new Promise((r) => setTimeout(r, 30));
    const c = (await t.api.get('/api/dunning/cases')).data[0];
    expect(c).toMatchObject({ status: 'failed', access_paused: true });
    expect(tags(email)).not.toContain('kauf:club');
    expect(lastEvents('dunning.final_failed')).toHaveLength(1);
    expect(lastEvents('dunning.final_failed')[0].data).toMatchObject({ access: 'paused', productId: p.id });
    expect(mails(email, 'Mahnwesen').at(-1)!.subject).toContain('pausiert');

    await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_f1', sub, amount: 2900, metadata: meta, email }));
    const after = (await t.api.get('/api/dunning/cases')).data[0];
    expect(after).toMatchObject({ status: 'recovered', access_paused: false });
    expect(tags(email)).toContain('kauf:club');
    expect(lastEvents('dunning.recovered')).toHaveLength(1);
    expect(lastEvents('dunning.recovered')[0].data.access_restored).toBe(true);
    const o = (await t.api.get('/api/dunning/overview')).data;
    expect(o.cases).toMatchObject({ open: 0, failed: 0, recovered_30d: 1, recovered_cents: 2900 });
  });

  it('keeps the access when the setting says so, and ignores purchases that are not ours', async () => {
    expect((await t.api.put('/api/dunning/settings', { sub: { access_on_final: 'keep', reminder_days: [0] } })).data.settings.sub.access_on_final).toBe('keep');
    await sendEvent(t, 'invoice.payment_failed', failed({ id: 'in_g1', next: null }));
    const c = (await t.api.get('/api/dunning/cases?status=failed')).data;
    expect(c).toHaveLength(1);
    expect(c[0].access_paused).toBe(false);
    expect(tags(email)).toContain('kauf:club');
    await sendEvent(t, 'invoice.payment_failed', stripeInvoice({ id: 'in_x', sub: 'sub_foreign', amount: 500, metadata: {}, email: 'fremd@kunde.de', status: 'open' }));
    expect((await t.api.get('/api/dunning/cases')).data.filter((x: any) => x.stripe_subscription === 'sub_foreign')).toHaveLength(0);
    await t.api.put('/api/dunning/settings', { sub: { access_on_final: 'pause', reminder_days: [0, 3, 7] } });
  });

  it('pays the open invoice on its own schedule when Stripe does not retry', async () => {
    const e2 = 'own@kunde.de';
    const sub2 = 'sub_own1';
    const session = { id: 'cs_own', mode: 'subscription', subscription: sub2, customer: 'cus_own', customer_details: { email: e2, name: 'Otto Own' }, status: 'complete', payment_status: 'paid', metadata: { ...meta }, currency: 'eur', amount_total: 2900 };
    stripe.sessions.set(session.id, session);
    t.app.db.insert('stripe_checkouts', { id: 'cs_own', location_id: loc(), kind: 'product', product_id: p.id, url: '', mode: 'subscription', amount_cents: 2900, currency: 'EUR', status: 'open', email: e2, meta: session.metadata, created_at: new Date().toISOString() });
    await sendEvent(t, 'checkout.session.completed', session);
    await t.api.put('/api/dunning/settings', { sub: { retry_mode: 'own', retry_days: [1], final_after_days: 0, reminder_days: [0] } });
    await sendEvent(t, 'invoice.payment_failed', stripeInvoice({ id: 'in_own1', sub: sub2, amount: 2900, metadata: session.metadata, email: e2, status: 'open', next: null }));
    const c = (await t.api.get('/api/dunning/cases')).data.find((x: any) => x.stripe_subscription === sub2);
    expect(c.status).toBe('open'); // with own retries the app is the one deciding
    expect(stripe.last('/v1/invoices/in_own1/pay')).toBeUndefined();
    t.app.db.run('UPDATE dunning_cases SET first_failed_at = ? WHERE id = ?', new Date(Date.now() - 1.5 * 864e5).toISOString(), c.id);
    await t.app.services.dunning.sweep(true);
    expect(stripe.last('/v1/invoices/in_own1/pay')).toBeDefined();
    await t.app.services.dunning.sweep(true);
    expect(stripe.calls.filter((x) => x.path === '/v1/invoices/in_own1/pay')).toHaveLength(1);
    // a retry that fails is logged, not thrown
    t.app.db.run('UPDATE dunning_cases SET own_retries = ? WHERE id = ?', '[]', c.id);
    stripe.state.payResult = 'failed';
    const r = await t.api.post(`/api/dunning/cases/${c.id}/retry`);
    expect(r.status).toBe(400);
    stripe.state.payResult = 'paid';
    // the grace period ends the case
    await t.api.put('/api/dunning/settings', { sub: { final_after_days: 14 } });
    t.app.db.run('UPDATE dunning_cases SET first_failed_at = ? WHERE id = ?', new Date(Date.now() - 15 * 864e5).toISOString(), c.id);
    await t.app.services.dunning.sweep(true);
    expect((await t.api.get(`/api/dunning/cases/${c.id}`)).data).toMatchObject({ status: 'failed' });
    await t.api.put('/api/dunning/settings', { sub: { retry_mode: 'stripe', reminder_days: [0, 3, 7] } });
  });

  it('lets the team remind, close and switch the access by hand', async () => {
    const e3 = 'hand2@kunde.de';
    const contact = (await t.api.post('/api/contacts', { email: e3, first_name: 'Hanna' })).data;
    t.app.db.insert('dunning_cases', { id: 'case_hand', location_id: loc(), contact_id: contact.id, product_id: p.id, product_name: 'Club', stripe_subscription: 'sub_hand', stripe_invoice: 'in_hand', status: 'open', amount_cents: 2900, currency: 'EUR', attempts: 1, first_failed_at: new Date().toISOString(), last_failed_at: new Date().toISOString(), reminders: [], own_retries: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    expect((await t.api.post('/api/dunning/cases/case_hand/remind')).data.channels).toEqual(['email']);
    expect(mails(e3, 'Mahnwesen')).toHaveLength(1);
    expect((await t.api.post('/api/dunning/cases/case_hand/access', { on: false })).data.access_paused).toBe(true);
    expect((await t.api.post('/api/dunning/cases/case_hand/close', { reason: 'Kunde hat gekündigt' })).data).toMatchObject({ status: 'closed', closed_reason: 'Kunde hat gekündigt' });
    expect((await t.api.post('/api/dunning/cases/case_hand/close')).status).toBe(400);
    expect((await t.api.post('/api/dunning/cases/nope/remind')).status).toBe(404);
  });
});

describe('the billing page', () => {
  const sub = 'sub_bill1';
  const email = 'bill@kunde.de';
  let contactId = '';
  let basic: any;
  let pro: any;
  let url = '';
  const page = async () => (await t.api.raw(url)).text();
  const post = (action: string, body: Record<string, string>, headers: Record<string, string> = {}) => t.api.raw(`${url}/${action}`, { ...formPost(body), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });

  it('shows subscriptions and invoices behind a signed link', async () => {
    basic = await product({ name: 'Basic', price_cents: 1000, tax_rate: 0, recurring: 'month' });
    pro = await product({ name: 'Pro', price_cents: 3000, tax_rate: 0, recurring: 'month' });
    const r = await t.api.raw(`/buy/${basic.id}`, formPost({ email }));
    const sid = new URL(r.headers.get('location')!).pathname.split('/').pop()!;
    const session = { ...stripe.sessions.get(sid), subscription: sub, customer: 'cus_bill', customer_details: { email, name: 'Berta Bill' }, status: 'complete', payment_status: 'paid' };
    await sendEvent(t, 'checkout.session.completed', session);
    contactId = t.app.db.get<any>('SELECT id FROM contacts WHERE email = ?', email)!.id;
    stripe.subs.set(sub, { id: sub, object: 'subscription', status: 'active', customer: 'cus_bill', currency: 'eur', current_period_end: Math.floor(Date.UTC(2026, 10, 5) / 1000), items: { data: [{ id: 'si_b', quantity: 1, price: { unit_amount: 1000, currency: 'eur' } }] }, metadata: {} });
    const link = (await t.api.post('/api/dunning/billing-link', { contact_id: contactId })).data;
    expect(link.url).toContain('/abo/');
    url = new URL(link.url).pathname;
    const html = await page();
    expect(html).toContain('Abo &amp; Rechnungen');
    expect(html).toContain('Basic');
    expect(html).toContain('10,00');
    expect(html).toContain('05.11.2026');
    expect(html).toContain('Zahlungsmethode ändern');
    expect(html).toContain('Zum Laufzeitende kündigen'); // cancelling is allowed by default (§ 312k BGB)
    expect(html).not.toContain('Abo pausieren'); // pausing is not
    expect(html).toMatch(/RE-\d+/); // the purchase invoice
    const res = await t.api.raw(url);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('rejects forged, expired and foreign links', async () => {
    const good = url.split('/abo/')[1];
    expect((await t.api.raw(`/abo/${good}x`)).status).toBe(410);
    expect((await t.api.raw('/abo/abc.def')).status).toBe(410);
    expect((await t.api.raw('/abo/' + 'a'.repeat(3000))).status).toBe(410);
    const expired = signToken(t.app, 'billing', { l: loc(), c: contactId }, -1000);
    expect((await t.api.raw(`/abo/${expired}`)).status).toBe(410);
    const otherKind = signToken(t.app, 'something', { l: loc(), c: contactId }, 100000);
    expect((await t.api.raw(`/abo/${otherKind}`)).status).toBe(410);
    const noContact = signToken(t.app, 'billing', { l: loc(), c: 'nobody' }, 100000);
    expect((await t.api.raw(`/abo/${noContact}`)).status).toBe(410);
    // the payload cannot be swapped for another contact's
    const [body, sig] = good.split('.');
    const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), c: 'someoneelse' })).toString('base64url');
    expect((await t.api.raw(`/abo/${swapped}.${sig}`)).status).toBe(410);
  });

  it('updates the card through a setup session and pays what is open', async () => {
    stripe.invoices.set('in_open1', { id: 'in_open1', subscription: sub, status: 'open' });
    const r = await post('card', { sub });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const setup = stripe.last('/v1/checkout/sessions')!.params;
    expect(setup.get('mode')).toBe('setup');
    expect(setup.get('customer')).toBe('cus_bill');
    expect(setup.get('metadata[purpose]')).toBe('card_update');
    expect(setup.get('metadata[subscription_id]')).toBe(sub);
    expect(setup.get('success_url')).toContain('/karte?session_id={CHECKOUT_SESSION_ID}');
    const sid = new URL(r.headers.get('location')!).pathname.split('/').pop()!;
    // back from Stripe
    const back = await t.api.raw(`${url}/karte?session_id=${sid}`, { redirect: 'manual' });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toContain('m=card_ok');
    expect(stripe.last(`/v1/customers/cus_bill`)!.params.get('invoice_settings[default_payment_method]')).toBe('pm_new_card');
    expect(stripe.last(`/v1/subscriptions/${sub}`)!.params.get('default_payment_method')).toBe('pm_new_card');
    expect(stripe.last('/v1/invoices/in_open1/pay')).toBeDefined();
    expect(await (await t.api.raw(back.headers.get('location')!)).text()).toContain('Danke! Deine neue Zahlungsmethode');
    // the same session twice changes nothing
    const n = stripe.calls.filter((c) => c.path === '/v1/customers/cus_bill').length;
    await t.api.raw(`${url}/karte?session_id=${sid}`, { redirect: 'manual' });
    expect(stripe.calls.filter((c) => c.path === '/v1/customers/cus_bill')).toHaveLength(n);
    // a session of someone else's is not applied
    stripe.sessions.set('cs_evil', { id: 'cs_evil', mode: 'setup', customer: 'cus_evil', metadata: { location_id: 'other', purpose: 'card_update', subscription_id: 'sub_evil' } });
    await t.api.raw(`${url}/karte?session_id=cs_evil`, { redirect: 'manual' });
    expect(stripe.calls.some((c) => c.path === '/v1/customers/cus_evil')).toBe(false);
  });

  it('uses the Billing Portal when chosen and falls back to the setup session without a portal configuration', async () => {
    await t.api.put('/api/dunning/settings', { sub: { billing_method: 'portal' } });
    const r = await post('card', { sub });
    expect(r.headers.get('location')).toMatch(/^https:\/\/billing\.stripe\.com\//);
    expect(stripe.last('/v1/billing_portal/sessions')!.params.get('customer')).toBe('cus_bill');
    stripe.state.portal = 'missing';
    const r2 = await post('card', { sub });
    expect(r2.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    stripe.state.portal = 'ok';
    await t.api.put('/api/dunning/settings', { sub: { billing_method: 'setup' } });
  });

  it('cancels at period end, takes it back, pauses and switches only where the product allows', async () => {
    const r = await post('cancel', { sub });
    expect(r.headers.get('location')).toContain('m=canceled');
    expect(stripe.last(`/v1/subscriptions/${sub}`)!.params.get('cancel_at_period_end')).toBe('true');
    stripe.subs.get(sub).cancel_at_period_end = true;
    const html = await page();
    expect(html).toContain('Gekündigt');
    expect(html).toContain('Kündigung zurücknehmen');
    expect((await post('uncancel', { sub })).headers.get('location')).toContain('m=uncanceled');
    expect(stripe.last(`/v1/subscriptions/${sub}`)!.params.get('cancel_at_period_end')).toBe('false');
    stripe.subs.get(sub).cancel_at_period_end = false;

    // pause is off by default
    expect((await post('pause', { sub })).headers.get('location')).toContain('m=denied');
    expect((await t.api.put(`/api/dunning/products/${basic.id}`, { allow_pause: true })).data).toMatchObject({ allow_pause: true, allow_cancel: true });
    expect((await post('pause', { sub })).headers.get('location')).toContain('m=paused');
    expect(stripe.last(`/v1/subscriptions/${sub}`)!.params.get('pause_collection[behavior]')).toBe('void');
    stripe.subs.get(sub).pause_collection = { behavior: 'void' };
    expect(await page()).toContain('Abo fortsetzen');
    expect((await post('resume', { sub })).headers.get('location')).toContain('m=resumed');
    stripe.subs.get(sub).pause_collection = null;

    // switch needs the target in the list, with the same currency and a recurring product
    expect((await post('switch', { sub, product: pro.id })).headers.get('location')).toContain('m=denied');
    expect((await t.api.put(`/api/dunning/products/${basic.id}`, { switch_to: [basic.id] })).status).toBe(400);
    const usd = await product({ name: 'USD', price_cents: 500, currency: 'USD', recurring: 'month' });
    expect((await t.api.put(`/api/dunning/products/${basic.id}`, { switch_to: [usd.id] })).status).toBe(400);
    const oneTime = await product({ name: 'Einmal', price_cents: 500 });
    expect((await t.api.put(`/api/dunning/products/${basic.id}`, { switch_to: [oneTime.id] })).status).toBe(400);
    await t.api.put(`/api/dunning/products/${basic.id}`, { switch_to: [pro.id] });
    expect(await page()).toContain('Tarif wechseln');
    expect(tags(email)).toContain('kauf:basic');
    expect((await post('switch', { sub, product: pro.id })).headers.get('location')).toContain('m=switched');
    const sw = stripe.last(`/v1/subscriptions/${sub}`)!.params;
    expect(sw.get('items[0][id]')).toBe('si_b');
    expect(sw.get('items[0][price_data][unit_amount]')).toBe('3000');
    expect(sw.get('items[0][price_data][recurring][interval]')).toBe('month');
    expect(sw.get('proration_behavior')).toBe('create_prorations');
    expect(sw.get('metadata[product_id]')).toBe(pro.id);
    expect(tags(email)).toContain('kauf:pro');
    expect(tags(email)).not.toContain('kauf:basic');

    // cancel immediately, when the product says so
    await t.api.put(`/api/dunning/products/${pro.id}`, { cancel_mode: 'now' });
    t.app.db.run(`UPDATE stripe_checkouts SET product_id = ? WHERE subscription = ?`, pro.id, sub);
    expect(await page()).toContain('Sofort kündigen');
    await post('cancel', { sub });
    expect(stripe.subs.get(sub).status).toBe('canceled');
    expect(lastEvents('dunning.final_failed').length).toBeGreaterThan(0);
  });

  it('refuses other people’s subscriptions, foreign origins and flooding', async () => {
    expect((await post('card', { sub: 'sub_foreign' })).headers.get('location')).toContain('m=denied');
    expect((await post('card', { sub: 'nonsense' })).headers.get('location')).toContain('m=denied');
    expect((await post('cancel', { sub: 'sub_club1' })).headers.get('location')).toContain('m=denied'); // another contact's
    const evil = await post('cancel', { sub }, { origin: 'https://evil.example' });
    expect(evil.headers.get('location')).toContain('m=failed');
    expect(stripe.calls.filter((c) => c.path === `/v1/subscriptions/${sub}` && c.params.get('cancel_at_period_end') === 'true')).toHaveLength(1);
    // a message code that is not ours is not echoed
    expect(await (await t.api.raw(`${url}?m=<script>alert(1)</script>`)).text()).not.toContain('<script>alert');
  });
});

describe('Mahnstufen for invoices', () => {
  let contactId = '';
  let b2bId = '';
  const mkInvoice = async (cid: string, dueDaysAgo: number, total = 11900) => {
    const inv = (await t.api.post('/api/invoices', { contact_id: cid, title: 'Beratung', items: [{ name: 'Beratung', qty: 1, price_cents: total, tax_rate: 0 }], due_at: new Date(Date.now() - dueDaysAgo * 864e5).toISOString() })).data;
    // finalising gives the number (a draft has none)
    return (await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' })).data;
  };
  const notices = async (q = '') => (await t.api.get(`/api/dunning/notices${q}`)).data as any[];

  beforeAll(async () => {
    contactId = (await t.api.post('/api/contacts', { email: 'privat@kunde.de', first_name: 'Paula', last_name: 'Privat' })).data.id;
    b2bId = (await t.api.post('/api/contacts', { email: 'firma@kunde.de', first_name: 'Fritz', last_name: 'Firma', company: 'Firma GmbH' })).data.id;
  });

  it('does nothing while it is off, and shows what would be due in a dry run', async () => {
    const inv = await mkInvoice(contactId, 10);
    expect((await t.api.post('/api/dunning/run', {})).data).toMatchObject({ mode: 'off', created: [] });
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval' } });
    const dry = (await t.api.post('/api/dunning/run', { dry_run: true })).data;
    expect(dry.due).toEqual([expect.objectContaining({ invoice_id: inv.id, level: 1, label: 'Zahlungserinnerung', days_overdue: 10, total_cents: 11900 })]);
    expect(await notices()).toHaveLength(0);
  });

  it('puts the reminder in the approval list, sends it on approval with a PDF link, and stops on payment', async () => {
    const run = (await t.api.post('/api/dunning/run', {})).data;
    expect(run.created).toHaveLength(1);
    expect(run.sent).toHaveLength(0);
    const list = await notices('?status=pending');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ level: 1, label: 'Zahlungserinnerung', status: 'pending', total_cents: 11900, fee_cents: 0, contact: { name: 'Paula Privat' } });
    expect(list[0].body).toContain('Rechnung RE-');
    // running again does not pile up
    expect((await t.api.post('/api/dunning/run', {})).data.created).toHaveLength(0);
    // edit, then send
    const edited = (await t.api.patch(`/api/dunning/notices/${list[0].id}`, { subject: 'Kurze Erinnerung', body: 'Hallo Paula, bitte zahlen.' })).data;
    expect(edited.edited).toBe(true);
    const sent = (await t.api.post(`/api/dunning/notices/${list[0].id}/send`)).data;
    expect(sent).toMatchObject({ status: 'sent', channels: ['email'] });
    const m = mails('privat@kunde.de', 'Zahlungserinnerung');
    expect(m).toHaveLength(1);
    expect(m[0].subject).toBe('Kurze Erinnerung');
    expect(m[0].body).toBe('Hallo Paula, bitte zahlen.');
    expect(lastEvents('invoice.dunning_sent')[0].data).toMatchObject({ level: 1, level_key: 'reminder', label: 'Zahlungserinnerung', total_cents: 11900 });
    expect((await t.api.post(`/api/dunning/notices/${list[0].id}/send`)).status).toBe(400); // already sent

    // PDF: with a login and by the unguessable link
    const pdf = await t.api.raw(`/api/dunning/notices/${list[0].id}/pdf`, { headers: { cookie: t.api.cookie, 'x-location-id': loc() } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1')).toContain('Zahlungserinnerung');
    expect(bytes.toString('latin1')).toContain('119,00');
    const row = t.app.db.get<any>('SELECT token FROM dunning_notices WHERE id = ?', list[0].id)!;
    expect((await t.api.raw(`/mahnung/${row.token}/pdf`)).status).toBe(200);
    expect((await t.api.raw('/mahnung/nonsense/pdf')).status).toBe(404);
    expect((await t.api.raw(`/mahnung/${'a'.repeat(24)}/pdf`)).status).toBe(404);
  });

  it('claims fee, interest and – between businesses – the flat fee on the 1. Mahnung', async () => {
    const inv = await mkInvoice(b2bId, 40, 100000);
    await t.api.put('/api/dunning/settings', { inv: { mode: 'auto', min_gap_days: 0, levels: [{ days: 7, fee_cents: 0 }, { days: 21, fee_cents: 500 }, { days: 35, fee_cents: 1000 }] } });
    // the invoice is 40 days overdue: the first step is still the reminder
    const first = (await t.api.post('/api/dunning/run', {})).data;
    expect(first.sent).toEqual([expect.objectContaining({ number: inv.number, label: 'Zahlungserinnerung', status: 'sent' })]);
    // and then, one run later, the next level – with interest from the 2nd level on
    const second = (await t.api.post('/api/dunning/run', {})).data;
    expect(second.sent).toHaveLength(1);
    const n = (await notices(`?invoice_id=${inv.id}`)).find((x) => x.level === 2)!;
    expect(n).toMatchObject({ label: '1. Mahnung', status: 'sent', fee_cents: 500, flat_fee_cents: 4000, days_overdue: 40, interest_rate: 10.27 });
    expect(n.interest_cents).toBe(Math.round((100000 * 0.1027 * 40) / 365));
    expect(n.total_cents).toBe(100000 + 500 + 4000 + n.interest_cents);
    expect(mails('firma@kunde.de', '1. Mahnung')).toHaveLength(1);
    const body = mails('firma@kunde.de', '1. Mahnung')[0].body as string;
    expect(body).toContain('/mahnung/');
    expect(body).toContain('Mahngebühr');
    // the third level waits for its day
    expect((await t.api.post('/api/dunning/run', {})).data.sent).toHaveLength(1);
    expect((await t.api.post('/api/dunning/run', {})).data.created).toHaveLength(0);
    expect((await notices(`?invoice_id=${inv.id}`)).map((x) => x.level).sort()).toEqual([1, 2, 3]);
  });

  it('holds, pays and voids stop the run', async () => {
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval' } });
    const held = await mkInvoice(contactId, 30);
    const paid = await mkInvoice(contactId, 30);
    const voided = await mkInvoice(contactId, 30);
    expect((await t.api.post(`/api/dunning/invoices/${held.id}/hold`, { reason: 'Zahlungsvereinbarung' })).data.held).toBe(true);
    const overview = (await t.api.get('/api/dunning/invoices')).data as any[];
    expect(overview.find((x) => x.id === held.id)).toMatchObject({ held: true, level: 0, next_label: 'Zahlungserinnerung' });
    await t.api.patch(`/api/invoices/${voided.id}`, { status: 'void' });
    const run = (await t.api.post('/api/dunning/run', {})).data;
    const ids = run.created.map((c: any) => c.invoice_id);
    expect(ids).toContain(paid.id);
    expect(ids).not.toContain(held.id);
    expect(ids).not.toContain(voided.id);
    // payment withdraws the pending notice at once…
    await t.api.patch(`/api/invoices/${paid.id}`, { status: 'paid' });
    await t.app.events.flush();
    const n = (await notices(`?invoice_id=${paid.id}`))[0];
    expect(n).toMatchObject({ status: 'canceled', error: 'Rechnung ist bezahlt' });
    // …and sending a notice for a paid invoice is refused even if the status was missed
    const later = await mkInvoice(contactId, 30);
    const made = (await t.api.post('/api/dunning/run', { invoice_id: later.id })).data.created[0];
    t.app.db.run(`UPDATE invoices SET status = 'paid' WHERE id = ?`, later.id);
    expect((await t.api.post(`/api/dunning/notices/${made.id}/send`)).status).toBe(400);
    expect((await notices(`?invoice_id=${later.id}`))[0].status).toBe('canceled');
    // lifting the hold lets it through
    await t.api.post(`/api/dunning/invoices/${held.id}/hold`, { on: false });
    expect((await t.api.post('/api/dunning/run', {})).data.created.map((c: any) => c.invoice_id)).toContain(held.id);
  });

  it('writes the next notice by hand, sends or dismisses drafts, and reports failures', async () => {
    const inv = await mkInvoice(contactId, 12);
    const r = (await t.api.post(`/api/dunning/invoices/${inv.id}/notice`, { send: false })).data;
    expect(r.created).toHaveLength(1);
    expect((await t.api.post(`/api/dunning/invoices/${inv.id}/notice`, { send: false })).status).toBe(400); // one is waiting
    const nid = r.created[0].id;
    expect((await t.api.post(`/api/dunning/notices/${nid}/dismiss`)).data.status).toBe('dismissed');
    expect((await t.api.post(`/api/dunning/notices/${nid}/dismiss`)).status).toBe(400);
    // a contact without e-mail and phone cannot be reached: the notice fails with a reason
    const ghost = (await t.api.post('/api/contacts', { first_name: 'Gerd', last_name: 'Ohne' })).data;
    const gi = await mkInvoice(ghost.id, 12);
    const out = (await t.api.post(`/api/dunning/invoices/${gi.id}/notice`, {})).status;
    expect(out).toBe(200);
    const failed = (await notices(`?invoice_id=${gi.id}`))[0];
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.error).toContain('Kanal');
    // preview of the amounts
    const pv = (await t.api.get(`/api/dunning/preview?invoice_id=${inv.id}&level=2`)).data;
    expect(pv).toMatchObject({ level: 2, label: '1. Mahnung' });
    expect(pv.amounts.fee_cents).toBe(500);
    expect((await t.api.get('/api/dunning/preview?invoice_id=nope')).status).toBe(404);
  });

  it('is available as a workflow action and trigger', async () => {
    const cat = (await t.api.get('/api/workflow-catalog')).data;
    expect(cat.actions.map((a: any) => a.type)).toEqual(expect.arrayContaining(['invoice_dunning_send', 'dunning_send_link']));
    expect(cat.triggers.map((x: any) => x.type)).toEqual(expect.arrayContaining(['invoice.dunning_sent', 'dunning.started', 'dunning.final_failed', 'dunning.recovered']));
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval' } });
    const inv = await mkInvoice(contactId, 20);
    const act = t.app.services.workflowActions.invoice_dunning_send;
    const run = { location_id: loc(), contact_id: contactId, workflow_id: 'w' } as any;
    const res = await act(run, { mode: 'draft', invoice_id: inv.id }, { event: {} });
    expect(res.result).toContain('zur Freigabe');
    expect((await act(run, { mode: 'draft', invoice_id: inv.id }, { event: {} }))).toContain('wartet schon');
    await expect(act(run, { mode: 'draft', invoice_id: 'unknown' }, { event: {} })).rejects.toThrow('nicht gefunden');
    const link = await t.app.services.workflowActions.dunning_send_link(run, { channel: 'email', subject: 'Link', body: 'Hier: {{dunning.url}}' }, { event: {}, contact: { first_name: 'Paula' } });
    expect(link.vars.billing_url).toContain('/abo/');
    expect(mails('privat@kunde.de').at(-1)!.body).toContain('/abo/');
  });
});

describe('settings, permissions and isolation', () => {
  it('stores the settings with defaults and validates them', async () => {
    const s = (await t.api.get('/api/dunning/settings')).data;
    expect(s.defaults.inv.levels).toHaveLength(3);
    expect(s.defaults.inv.interest.base_rate).toBe(1.27);
    expect((await t.api.put('/api/dunning/settings', { inv: { levels: [{ days: 3 }, { days: 2 }] } })).status).toBe(400);
    expect((await t.api.put('/api/dunning/settings', { inv: { interest: { base_rate: 2.62 } } })).data.settings.inv.interest.base_rate).toBe(2.62);
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('POST', '/api/dunning/run')).toBe('payments');
    expect(requiredPermission('PUT', '/api/dunning/settings')).toBe('payments');
  });

  it('keeps cases, notices and settings of other sub-accounts out of sight', async () => {
    const own = loc();
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    t.api.setLocation(other);
    expect((await t.api.get('/api/dunning/cases')).data).toEqual([]);
    expect((await t.api.get('/api/dunning/notices')).data).toEqual([]);
    expect((await t.api.get('/api/dunning/invoices')).data).toEqual([]);
    expect((await t.api.get('/api/dunning/settings')).data.settings.inv.interest.base_rate).toBe(1.27);
    const c = t.app.db.get<any>('SELECT id FROM dunning_cases LIMIT 1')!;
    const n = t.app.db.get<any>('SELECT id, invoice_id FROM dunning_notices LIMIT 1')!;
    for (const [m, path] of [['GET', `/api/dunning/cases/${c.id}`], ['POST', `/api/dunning/cases/${c.id}/remind`], ['POST', `/api/dunning/notices/${n.id}/send`], ['GET', `/api/dunning/notices/${n.id}/pdf`], ['POST', `/api/dunning/invoices/${n.invoice_id}/hold`], ['GET', `/api/dunning/preview?invoice_id=${n.invoice_id}`]] as const) {
      const r = m === 'GET' ? await t.api.get(path) : await t.api.post(path, {});
      expect(r.status, `${m} ${path}`).toBe(404);
    }
    expect((await t.api.post('/api/dunning/billing-link', { contact_id: t.app.db.get<any>('SELECT id FROM contacts LIMIT 1')!.id })).status).toBe(404);
    t.api.setLocation(own);
  });
});
