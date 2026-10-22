import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch } from '../server/services/stripe.js';
import { cancelAtFor, cleanPlan, lumpLabel, planLabel, scheduleOf, totalCents } from '../server/services/creator-plans.js';
import { KEY, WHSEC, fakeStripe, formPost, sendEvent, stripeInvoice } from './creator-fakes.js';

const stripe = fakeStripe();
let t: Awaited<ReturnType<typeof startTestApp>>;
const events: { type: string; data: any }[] = [];
beforeAll(async () => {
  setStripeFetch(stripe.handler);
  t = await startTestApp();
  await t.setup();
  await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
  for (const type of ['payment_plan.completed', 'payment_plan.defaulted']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

const product = async (body: any) => (await t.api.post('/api/products', body)).data;
const lastSession = () => [...stripe.calls].reverse().find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST')!;
const planSub = (sub: string) => t.app.db.get<any>('SELECT * FROM plan_subscriptions WHERE stripe_subscription = ?', sub)!;
const contactTags = (email: string) => JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE email = ?', email)!.tags) as string[];

/** Buys a plan through the public buy page and lets Stripe confirm the Checkout. */
async function buy(productId: string, planId: string, email: string, sub: string, paid = true) {
  const r = await t.api.raw(`/buy/${productId}`, formPost({ email, plan: planId }));
  expect(r.status).toBe(303);
  const call = lastSession();
  const sid = new URL(r.headers.get('location')!).pathname.split('/').pop()!;
  const session = { ...stripe.sessions.get(sid), subscription: sub, customer: 'cus_' + sub, customer_details: { email, name: 'Kim Kunde' }, status: 'complete', payment_status: paid ? 'paid' : 'unpaid' };
  stripe.sessions.set(sid, session);
  return { call, session, sid };
}

describe('plan maths', () => {
  const plan = { installments: 3, interval: 'month' as const, interval_count: 1, amount_cents: 9900, first_amount_cents: null };

  it('labels, totals and schedule', () => {
    expect(planLabel(plan)).toMatch(/^3 × 99,00\s€ monatlich$/);
    expect(lumpLabel(29700)).toMatch(/^297,00\s€ einmalig$/);
    expect(planLabel({ ...plan, interval_count: 2 })).toContain('alle 2 Monate');
    expect(planLabel({ ...plan, interval: 'week' })).toContain('wöchentlich');
    expect(planLabel({ ...plan, first_amount_cents: 15000 })).toMatch(/^150,00\s€ \+ 2 × 99,00\s€ monatlich$/);
    expect(planLabel({ ...plan, installments: 2, first_amount_cents: 15000 })).toMatch(/^150,00\s€ \+ 99,00\s€ monatlich$/);
    expect(totalCents(plan)).toBe(29700);
    expect(totalCents({ ...plan, first_amount_cents: 15000 })).toBe(15000 + 2 * 9900);
    const s = scheduleOf(plan, new Date('2026-01-31T10:00:00Z'));
    expect(s.map((x) => x.at.toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(s.map((x) => x.amount_cents)).toEqual([9900, 9900, 9900]);
    expect(scheduleOf({ ...plan, first_amount_cents: 5000 }, new Date('2026-01-01T00:00:00Z'))[0].amount_cents).toBe(5000);
  });

  it('ends the subscription after the last payment is due and before the next one', () => {
    const start = Date.UTC(2026, 9, 5, 10) / 1000;
    const at = cancelAtFor(plan, start);
    const day = (n: number) => start + n * 86400;
    expect(at).toBeGreaterThan(day(61 - 1)); // after the third payment (about day 61)
    expect(at).toBeLessThan(day(90)); // long before a fourth
    const weekly = cancelAtFor({ ...plan, interval: 'week', installments: 4 }, start);
    expect(weekly).toBeGreaterThan(day(21));
    expect(weekly).toBeLessThan(day(28));
  });

  it('validates input', () => {
    const ok = { installments: 3, amount_cents: 9900 };
    expect(cleanPlan(ok)).toMatchObject({ installments: 3, interval: 'month', interval_count: 1, on_default: 'pause', first_amount_cents: null });
    expect(() => cleanPlan({ ...ok, installments: 1 })).toThrow('Raten');
    expect(() => cleanPlan({ ...ok, installments: 61 })).toThrow('Raten');
    expect(() => cleanPlan({ ...ok, amount_cents: 10 })).toThrow('Rate');
    expect(() => cleanPlan({ ...ok, interval_count: 13 })).toThrow('Abstand');
    expect(() => cleanPlan({ ...ok, on_default: 'burn' })).toThrow('Zahlungsausfall');
    expect(cleanPlan({ ...ok, first_amount_cents: 9900 }).first_amount_cents).toBeNull();
  });
});

describe('plans API', () => {
  it('manages plans of one-time products only, with labels and permissions', async () => {
    const p = await product({ name: 'Kurs Plan', price_cents: 24958, tax_rate: 19 });
    const abo = await product({ name: 'Club', price_cents: 900, recurring: 'month' });
    expect((await t.api.post('/api/payment-plans', { product_id: abo.id, installments: 3, amount_cents: 1000 })).status).toBe(400);
    expect((await t.api.post('/api/payment-plans', { product_id: 'nope', installments: 3, amount_cents: 1000 })).status).toBe(404);
    const r = await t.api.post('/api/payment-plans', { product_id: p.id, installments: 3, amount_cents: 9900 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ installments: 3, amount_cents: 9900, interval: 'month', on_default: 'pause', active: true, total_cents: 29700, purchases: 0 });
    expect(r.data.label).toMatch(/3 × 99,00\s€ monatlich/);
    const up = await t.api.patch(`/api/payment-plans/${r.data.id}`, { installments: 6, amount_cents: 5000, on_default: 'revoke' });
    expect(up.data).toMatchObject({ installments: 6, amount_cents: 5000, on_default: 'revoke', total_cents: 30000 });
    expect((await t.api.patch(`/api/payment-plans/${r.data.id}`, { installments: 1 })).status).toBe(400);
    expect((await t.api.get(`/api/payment-plans?product_id=${p.id}`)).data).toHaveLength(1);
    expect((await t.api.del(`/api/payment-plans/${r.data.id}`)).status).toBe(200);
    expect((await t.api.get('/api/payment-plans')).data).toHaveLength(0);
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('POST', '/api/payment-plans')).toBe('payments');
    expect(requiredPermission('GET', '/api/payment-plans/subscriptions')).toBe('payments');
  });
});

describe('buy page and Checkout', () => {
  let p: any;
  let plan: any;
  it('offers lump sum and plan and keeps the lump sum a normal purchase', async () => {
    p = await product({ name: 'Online-Kurs', description: 'Alle Lektionen', price_cents: 24958, tax_rate: 19 }); // gross 297,00
    plan = (await t.api.post('/api/payment-plans', { product_id: p.id, installments: 3, amount_cents: 9900, name: 'In 3 Raten' })).data;
    const page = await (await t.api.raw(`/buy/${p.id}`)).text();
    expect(page).toContain('Zahlungsweise');
    expect(page).toMatch(/297,00\s€ einmalig/);
    expect(page).toMatch(/In 3 Raten/);
    expect(page).toMatch(/3 × 99,00\s€ monatlich/);
    expect(page).toContain('name="plan" value=""');
    expect(page).toContain(`name="plan" value="${plan.id}"`);
    // ?plan= preselects (funnel links)
    expect(await (await t.api.raw(`/buy/${p.id}?plan=${plan.id}`)).text()).toMatch(new RegExp(`value="${plan.id}" checked`));

    await t.api.raw(`/buy/${p.id}`, formPost({ email: 'lump@kunde.de' }));
    const lump = lastSession().params;
    expect(lump.get('mode')).toBe('payment');
    expect(lump.get('line_items[0][price_data][unit_amount]')).toBe('29700');
    expect(lump.has('metadata[plan_id]')).toBe(false);
  });

  it('turns a plan into a subscription with the instalment as recurring price', async () => {
    await t.api.raw(`/buy/${p.id}`, formPost({ email: 'kim@kunde.de', plan: plan.id }));
    const c = lastSession().params;
    expect(c.get('mode')).toBe('subscription');
    expect(c.get('line_items[0][price_data][unit_amount]')).toBe('9900');
    expect(c.get('line_items[0][price_data][recurring][interval]')).toBe('month');
    expect(c.get('line_items[0][price_data][recurring][interval_count]')).toBe('1');
    expect(c.get('line_items[0][price_data][product_data][description]')).toContain('Ratenzahlung');
    expect(c.has('line_items[1][quantity]')).toBe(false);
    expect(c.has('payment_intent_data[description]')).toBe(false);
    expect(c.has('customer_creation')).toBe(false);
    for (const [k, v] of [['plan_id', plan.id], ['plan_n', '3'], ['plan_amount', '9900'], ['plan_interval', 'month'], ['price_cents', '8319'], ['tax_rate', '19']]) {
      expect(c.get(`metadata[${k}]`), k).toBe(v);
      expect(c.get(`subscription_data[metadata][${k}]`), `sub ${k}`).toBe(v);
    }
  });

  it('rejects unknown or foreign plans, discount codes with a plan, plans on subscriptions', async () => {
    const r = await t.api.raw(`/buy/${p.id}`, formPost({ email: 'x@kunde.de', plan: 'doesnotexist' }));
    expect(r.status).toBe(400); // error page
    expect(await r.text()).toContain('Zahlungsplan');
    await t.api.put(`/api/buy-offers/${p.id}`, {});
    expect((await t.api.post(`/api/buy-offers/${p.id}/coupons`, { code: 'SPAR10', kind: 'percent', value: 10 })).status).toBe(200);
    const withCode = await t.api.raw(`/buy/${p.id}`, formPost({ email: 'x@kunde.de', plan: plan.id, coupon: 'SPAR10' }));
    expect(await withCode.text()).toContain('Rabattcodes gelten nicht bei Ratenzahlung');
    // the same code still works for the lump sum
    const lump = await t.api.raw(`/buy/${p.id}`, formPost({ email: 'x@kunde.de', coupon: 'SPAR10' }));
    expect(lump.status).toBe(303);
  });

  it('a higher first payment becomes a one-time surcharge line, a lower one a first-invoice discount', async () => {
    const high = (await t.api.post('/api/payment-plans', { product_id: p.id, installments: 3, amount_cents: 9900, first_amount_cents: 15000 })).data;
    await t.api.raw(`/buy/${p.id}`, formPost({ email: 'h@kunde.de', plan: high.id }));
    let c = lastSession().params;
    expect(c.get('line_items[0][price_data][unit_amount]')).toBe('9900');
    expect(c.get('line_items[1][price_data][unit_amount]')).toBe('5100');
    expect(c.has('line_items[1][price_data][recurring][interval]')).toBe(false);
    expect(c.get('metadata[plan_first]')).toBe('15000');
    expect(c.has('discounts[0][coupon]')).toBe(false);

    const low = (await t.api.post('/api/payment-plans', { product_id: p.id, installments: 3, amount_cents: 9900, first_amount_cents: 4900 })).data;
    await t.api.raw(`/buy/${p.id}`, formPost({ email: 'l@kunde.de', plan: low.id }));
    c = lastSession().params;
    expect(c.get('line_items[0][price_data][unit_amount]')).toBe('9900');
    expect(c.has('line_items[1][quantity]')).toBe(false);
    const coupon = stripe.last('/v1/coupons')!;
    expect(coupon.params.get('amount_off')).toBe('5000');
    expect(coupon.params.get('duration')).toBe('once');
    expect(coupon.params.get('currency')).toBe('eur');
    expect(c.get('discounts[0][coupon]')).toMatch(/^co_/);
  });
});

describe('a plan from first payment to the last', () => {
  let p: any;
  let plan: any;
  let sub = 'sub_plan1';
  it('grants access with the first payment, sets the end date and counts every instalment', async () => {
    p = await product({ name: 'Kurs 3 Raten', price_cents: 24958, tax_rate: 19 });
    plan = (await t.api.post('/api/payment-plans', { product_id: p.id, installments: 3, amount_cents: 9900 })).data;
    const { call, session } = await buy(p.id, plan.id, 'kim@kunde.de', sub);
    const meta = { ...session.metadata };
    // Stripe sends the invoice of the first period before or after the Checkout – both orders work.
    const first = await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_1', sub, amount: 9900, reason: 'subscription_create', metadata: meta }));
    expect(first.data).toMatchObject({ handled: 'plan_payment', paid: 1, of: 3 });
    const done = await sendEvent(t, 'checkout.session.completed', session);
    expect(done.data.handled).toBe('product_purchased');
    expect(contactTags('kim@kunde.de')).toContain('kauf:kurs-3-raten');
    // the first invoice shows instalment 1
    const inv1 = t.app.db.get<any>('SELECT * FROM invoices WHERE title = ?', 'Kurs 3 Raten');
    expect(inv1.status).toBe('paid');
    expect(JSON.parse(inv1.items)[0].name).toBe('Kurs 3 Raten – Rate 1/3');
    expect(inv1.total_cents).toBe(9900);

    let ps = planSub(sub);
    expect(ps).toMatchObject({ status: 'active', access: 'active', paid_count: 1, paid_cents: 9900, installments: 3, plan_id: plan.id });
    expect(ps.contact_id).toBeTruthy();
    expect(ps.checkout_id).toBe(session.id);

    // the end date is set by a job (retried, never blocks the webhook)
    await t.app.services.creatorPlans.runJobs();
    const upd = stripe.last('/v1/subscriptions/sub_plan1')!;
    expect(upd.params.get('cancel_at')).toBe(String(cancelAtFor(plan, stripe.state.start)));
    expect(upd.params.get('proration_behavior')).toBe('none');
    expect(planSub(sub).cancel_at).toBeTruthy();

    // the same invoice again changes nothing
    expect((await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_1', sub, amount: 9900, reason: 'subscription_create', metadata: meta }), 'evt_again')).data.handled).toBe('duplicate');
    expect(planSub(sub).paid_count).toBe(1);

    // second instalment: our own invoice "Rate 2/3"
    const second = await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_2', sub, amount: 9900, metadata: meta }));
    expect(second.data).toMatchObject({ handled: 'plan_payment', paid: 2 });
    await t.app.services.creatorPlans.reconcile(planSub(sub).id);
    const inv2 = t.app.db.get<any>(`SELECT * FROM invoices WHERE title LIKE '%Rate 2/3'`);
    expect(inv2).toMatchObject({ status: 'paid', total_cents: 9900 });
    expect(JSON.parse(inv2.items)[0]).toMatchObject({ name: 'Rate 2 von 3', price_cents: 8319, tax_rate: 19 });
    expect(planSub(sub).status).toBe('active');
    expect(events.filter((e) => e.type === 'payment_plan.completed')).toHaveLength(0);

    // third: the plan is complete, Stripe is told to end the subscription right after this period
    await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_3', sub, amount: 9900, metadata: meta }));
    ps = planSub(sub);
    expect(ps).toMatchObject({ status: 'completed', paid_count: 3, paid_cents: 29700, access: 'active' });
    const done3 = events.filter((e) => e.type === 'payment_plan.completed');
    expect(done3).toHaveLength(1);
    expect(done3[0].data).toMatchObject({ planSubscriptionId: ps.id, productId: p.id, paid_count: 3, installments: 3, paid_cents: 29700, open_cents: 0, product: { name: 'Kurs 3 Raten' } });
    await t.app.services.creatorPlans.runJobs();
    expect(stripe.last('/v1/subscriptions/sub_plan1')!.params.get('cancel_at_period_end')).toBe('true');

    // when Stripe then ends it, the buyer keeps the access they paid for
    const ended = await sendEvent(t, 'customer.subscription.deleted', { id: sub, metadata: meta, status: 'canceled', cancellation_details: { reason: 'cancellation_requested' } });
    expect(ended.data.handled).toBe('plan_subscription_ended');
    expect(contactTags('kim@kunde.de')).toContain('kauf:kurs-3-raten');
    expect(events.filter((e) => e.type === 'payment_plan.defaulted')).toHaveLength(0);
  });

  it('lists the purchase with its contact and state', async () => {
    const list = (await t.api.get('/api/payment-plans/subscriptions?status=completed')).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ product_name: 'Kurs 3 Raten', paid_count: 3, total_cents: 29700, open_cents: 0, contact: { email: 'kim@kunde.de' } });
    expect(list[0].label).toMatch(/3 × 99,00\s€ monatlich/);
    const detail = (await t.api.get(`/api/payment-plans/subscriptions/${list[0].id}`)).data;
    expect(detail.payments.map((x: any) => x.number)).toEqual([1, 2, 3]);
    expect((await t.api.get('/api/payment-plans/subscriptions/nope')).status).toBe(404);
  });

  it('an instalment is capped by what the plan still asks for: one beyond the last is no "Rate 4 von 3", it is flagged and the subscription ends', async () => {
    const ps = planSub(sub);
    const invoices = () => t.app.db.get<any>(`SELECT COUNT(*) AS n FROM invoices WHERE title LIKE 'Kurs 3 Raten%'`)!.n as number;
    const before = invoices();
    const jobs = () => t.app.db.get<any>(`SELECT COUNT(*) AS n FROM plan_jobs WHERE plan_subscription_id = ? AND kind = 'end_after_period'`, ps.id)!.n as number;
    const jobsBefore = jobs();
    const extra = await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_4', sub, amount: 9900 }));
    expect(extra.data).toMatchObject({ handled: 'plan_overpaid', surplus_cents: 9900 });
    expect(planSub(sub)).toMatchObject({ status: 'completed', paid_count: 3, paid_cents: 29700 });
    await t.app.services.creatorPlans.reconcile(ps.id);
    expect(invoices()).toBe(before);
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM invoices WHERE title LIKE '%Rate 4/3'`)!.n).toBe(0);
    expect(jobs()).toBe(jobsBefore + 1);
    const activity = t.app.db.all<any>('SELECT summary FROM activities WHERE contact_id = ? AND type = ?', ps.contact_id, 'payment_plan.overpaid').map((a) => a.summary.replace(/ /g, ' '));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toContain('99,00 € nicht als Rate gebucht');
    // reported again: nothing more
    expect((await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_4', sub, amount: 9900 }), 'evt_in4_again')).data.handled).toBe('duplicate');
  });
});

describe('a plan that is not paid to the end', () => {
  const sub = 'sub_plan2';
  let p: any;
  let meta: Record<string, string>;
  async function start(email: string, sid: string, onDefault: 'pause' | 'revoke' | 'keep') {
    p = await product({ name: `Kurs ${onDefault}`, price_cents: 24958, tax_rate: 19 });
    const plan = (await t.api.post('/api/payment-plans', { product_id: p.id, installments: 3, amount_cents: 9900, on_default: onDefault })).data;
    const { session } = await buy(p.id, plan.id, email, sid);
    meta = { ...session.metadata };
    await sendEvent(t, 'invoice.paid', stripeInvoice({ id: `in_${sid}_1`, sub: sid, amount: 9900, reason: 'subscription_create', metadata: meta, email }));
    await sendEvent(t, 'checkout.session.completed', session);
  }

  it('pauses the access when Stripe gives up, and brings it back with the next payment', async () => {
    await start('pause@kunde.de', sub, 'pause');
    expect(contactTags('pause@kunde.de')).toContain('kauf:kurs-pause');
    await sendEvent(t, 'invoice.payment_failed', stripeInvoice({ id: 'in_f1', sub, amount: 9900, metadata: meta, email: 'pause@kunde.de', status: 'open', next: Math.floor(Date.now() / 1000) + 86400 }));
    expect(planSub(sub)).toMatchObject({ status: 'active', failed_count: 1 });
    // Stripe stops: the subscription becomes unpaid
    const r = await sendEvent(t, 'customer.subscription.updated', { id: sub, status: 'unpaid', metadata: meta });
    expect(r.status).toBe(200);
    const ps = planSub(sub);
    expect(ps).toMatchObject({ status: 'defaulted', access: 'paused', default_reason: 'unpaid' });
    expect(contactTags('pause@kunde.de')).not.toContain('kauf:kurs-pause');
    const ev = events.filter((e) => e.type === 'payment_plan.defaulted').at(-1)!;
    expect(ev.data).toMatchObject({ planSubscriptionId: ps.id, reason: 'unpaid', access: 'paused', paid_count: 1, open_cents: 19800 });
    // the buyer pays after all
    await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_f2', sub, amount: 9900, metadata: meta, email: 'pause@kunde.de' }));
    expect(planSub(sub)).toMatchObject({ status: 'active', access: 'active', paid_count: 2 });
    expect(contactTags('pause@kunde.de')).toContain('kauf:kurs-pause');
  });

  it('revokes the access for good when the plan says so, and keeps it when it says so', async () => {
    await start('revoke@kunde.de', 'sub_plan3', 'revoke');
    await sendEvent(t, 'customer.subscription.deleted', { id: 'sub_plan3', metadata: meta, status: 'canceled', cancellation_details: { reason: 'payment_failed' } });
    expect(planSub('sub_plan3')).toMatchObject({ status: 'defaulted', access: 'revoked', default_reason: 'payment_failed' });
    expect(contactTags('revoke@kunde.de')).not.toContain('kauf:kurs-revoke');
    // a late payment does not revive a revoked plan
    await sendEvent(t, 'invoice.paid', stripeInvoice({ id: 'in_r2', sub: 'sub_plan3', amount: 9900, metadata: meta, email: 'revoke@kunde.de' }));
    expect(planSub('sub_plan3')).toMatchObject({ status: 'defaulted', access: 'revoked' });

    await start('keep@kunde.de', 'sub_plan4', 'keep');
    await sendEvent(t, 'customer.subscription.deleted', { id: 'sub_plan4', metadata: meta, status: 'canceled', cancellation_details: { reason: 'payment_failed' } });
    expect(planSub('sub_plan4')).toMatchObject({ status: 'defaulted', access: 'active' });
    expect(contactTags('keep@kunde.de')).toContain('kauf:kurs-keep');
  });

  it('lets the team cancel a plan and pause or resume the access by hand', async () => {
    await start('hand@kunde.de', 'sub_plan5', 'pause');
    const id = planSub('sub_plan5').id;
    expect((await t.api.post(`/api/payment-plans/subscriptions/${id}/access`, { on: false })).data.access).toBe('paused');
    expect(contactTags('hand@kunde.de')).not.toContain('kauf:kurs-pause');
    expect((await t.api.post(`/api/payment-plans/subscriptions/${id}/access`, { on: true })).data.access).toBe('active');
    expect(contactTags('hand@kunde.de')).toContain('kauf:kurs-pause');
    const c = await t.api.post(`/api/payment-plans/subscriptions/${id}/cancel`);
    expect(c.data).toMatchObject({ status: 'canceled', default_reason: 'by_admin' });
    expect(stripe.subs.get('sub_plan5').status).toBe('canceled');
    expect((await t.api.post(`/api/payment-plans/subscriptions/${id}/cancel`)).status).toBe(400);
    // Stripe's own "deleted" event for it is not treated as a default
    const before = events.filter((e) => e.type === 'payment_plan.defaulted').length;
    await sendEvent(t, 'customer.subscription.deleted', { id: 'sub_plan5', metadata: meta, status: 'canceled' });
    expect(events.filter((e) => e.type === 'payment_plan.defaulted')).toHaveLength(before);
  });

  it('retries Stripe jobs with backoff and gives up with a log line', async () => {
    await start('retry@kunde.de', 'sub_plan6', 'pause');
    const s = planSub('sub_plan6');
    const orig = stripe.handler;
    setStripeFetch((async () => new Response(JSON.stringify({ error: { message: 'Stripe is down' } }), { status: 503, headers: { 'content-type': 'application/json' } })) as any);
    t.app.db.run(`UPDATE plan_jobs SET next_at = ?, status = 'open' WHERE plan_subscription_id = ?`, new Date(0).toISOString(), s.id);
    await t.app.services.creatorPlans.runJobs();
    const job = t.app.db.get<any>('SELECT * FROM plan_jobs WHERE plan_subscription_id = ?', s.id)!;
    expect(job).toMatchObject({ status: 'open', attempts: 1 });
    expect(job.error).toContain('Stripe');
    expect(new Date(job.next_at).getTime()).toBeGreaterThan(Date.now());
    setStripeFetch(orig);
  });
});

describe('isolation', () => {
  it('never shows plans or purchases of another sub-account', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    const own = t.api.location;
    t.api.setLocation(other);
    expect((await t.api.get('/api/payment-plans')).data).toEqual([]);
    expect((await t.api.get('/api/payment-plans/subscriptions')).data).toEqual([]);
    const ps = t.app.db.get<any>('SELECT id FROM plan_subscriptions LIMIT 1')!;
    expect((await t.api.get(`/api/payment-plans/subscriptions/${ps.id}`)).status).toBe(404);
    expect((await t.api.post(`/api/payment-plans/subscriptions/${ps.id}/cancel`)).status).toBe(404);
    const planRow = t.app.db.get<any>('SELECT id, product_id FROM payment_plans LIMIT 1')!;
    expect((await t.api.patch(`/api/payment-plans/${planRow.id}`, { amount_cents: 100 })).status).toBe(404);
    expect((await t.api.post('/api/payment-plans', { product_id: planRow.product_id, installments: 3, amount_cents: 9900 })).status).toBe(404);
    t.api.setLocation(own);
  });
});
