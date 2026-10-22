import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { churnRate, cleanPlan, disabledAreas, mapStripeStatus, monthKey, monthlyValue, overageCharge, prevMonth, transition } from '../server/services/saas.js';

const KEY = 'sk_test_51AgencyKeyForSaas00wxyz';
const WHSEC = 'whsec_agencySigningSecret000000';

/** A fake Stripe for the agency account: products, prices, checkout, subscriptions, portal, invoice items. */
const calls: { method: string; path: string; params: URLSearchParams; idem?: string }[] = [];
const store = { products: new Map<string, any>(), prices: new Map<string, any>(), sessions: new Map<string, any>(), subs: new Map<string, any>(), items: [] as any[] };
let seq = 0;
const meta = (params: URLSearchParams, prefix: string) => {
  const out: Record<string, string> = {};
  for (const [k, v] of params) if (k.startsWith(`${prefix}[`) && k.endsWith(']') && !k.slice(prefix.length + 1, -1).includes('[')) out[k.slice(prefix.length + 1, -1)] = v;
  return out;
};
const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  calls.push({ method: init.method, path: u.pathname, params, idem: init.headers['idempotency-key'] });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: 'Invalid API Key provided' } }, 401);
  const p = u.pathname;
  const m = init.method;
  if (p === '/v1/account') return json({ id: 'acct_agency', settings: { dashboard: { display_name: 'Agentur Paul' } }, country: 'DE' });
  if (p === '/v1/products' && m === 'POST') {
    const prod = { id: `prod_${++seq}`, name: params.get('name'), active: params.get('active') !== 'false' };
    store.products.set(prod.id, prod);
    return json(prod);
  }
  if (p.startsWith('/v1/products/') && m === 'POST') {
    const prod = store.products.get(p.split('/').pop()!);
    Object.assign(prod, { name: params.get('name') ?? prod.name, active: params.get('active') !== 'false' });
    return json(prod);
  }
  if (p === '/v1/prices' && m === 'POST') {
    const price = { id: `price_${++seq}`, product: params.get('product'), unit_amount: Number(params.get('unit_amount')), currency: params.get('currency'), recurring: { interval: params.get('recurring[interval]') }, active: true };
    store.prices.set(price.id, price);
    return json(price);
  }
  if (p.startsWith('/v1/prices/') && m === 'POST') {
    const price = store.prices.get(p.split('/').pop()!);
    price.active = params.get('active') !== 'false';
    return json(price);
  }
  if (p === '/v1/checkout/sessions' && m === 'POST') {
    const s = {
      id: `cs_test_${++seq}`,
      object: 'checkout.session',
      url: `https://checkout.stripe.com/c/pay/cs_test_${seq}`,
      mode: params.get('mode'),
      status: 'open',
      payment_status: 'unpaid',
      customer_email: params.get('customer_email'),
      metadata: meta(params, 'metadata'),
      sub_meta: meta(params, 'subscription_data[metadata]'),
      trial: Number(params.get('subscription_data[trial_period_days]') ?? 0),
      price: params.get('line_items[0][price]'),
      success_url: params.get('success_url'),
      subscription: null as any,
      customer: null as any,
    };
    store.sessions.set(s.id, s);
    return json(s);
  }
  if (p.startsWith('/v1/checkout/sessions/')) {
    const s = store.sessions.get(decodeURIComponent(p.split('/').pop()!));
    if (!s) return json({ error: { message: 'No such checkout.session' } }, 404);
    const expand = params.get('expand[0]') === 'subscription';
    return json({ ...s, subscription: expand && s.subscription ? store.subs.get(s.subscription) : s.subscription });
  }
  if (p.startsWith('/v1/subscriptions/')) {
    const sub = store.subs.get(p.split('/').pop()!);
    if (!sub) return json({ error: { message: 'No such subscription' } }, 404);
    if (m === 'DELETE') sub.status = 'canceled';
    if (m === 'POST') {
      if (params.has('cancel_at_period_end')) sub.cancel_at_period_end = params.get('cancel_at_period_end') === 'true';
      if (params.has('items[0][price]')) sub.items.data[0].price = { id: params.get('items[0][price]'), recurring: { interval: store.prices.get(params.get('items[0][price]')!)?.recurring.interval } };
    }
    return json(sub);
  }
  if (p === '/v1/billing_portal/sessions') return json({ id: 'bps_1', url: `https://billing.stripe.com/p/session/${params.get('customer')}` });
  if (p === '/v1/invoiceitems') {
    const item = { id: `ii_${++seq}`, amount: Number(params.get('amount')), customer: params.get('customer'), subscription: params.get('subscription'), description: params.get('description') };
    store.items.push(item);
    return json(item);
  }
  return json({ error: { message: `unknown endpoint ${m} ${p}` } }, 404);
}) as any;

/** What Stripe does when the customer finishes Checkout: subscription + completed session. */
function completeCheckout(sessionId: string, status = 'trialing') {
  const s = store.sessions.get(sessionId);
  const subId = `sub_${++seq}`;
  const price = store.prices.get(s.price);
  store.subs.set(subId, {
    id: subId,
    object: 'subscription',
    status: s.trial ? status : 'active',
    customer: `cus_${seq}`,
    metadata: s.sub_meta,
    cancel_at_period_end: false,
    trial_end: s.trial ? Math.floor(Date.now() / 1000) + s.trial * 86400 : null,
    items: { data: [{ id: `si_${seq}`, price: { id: price.id, recurring: { interval: price.recurring.interval } }, current_period_end: Math.floor(Date.now() / 1000) + 10 * 86400 }] },
  });
  Object.assign(s, { status: 'complete', payment_status: s.trial ? 'no_payment_required' : 'paid', subscription: subId, customer: `cus_${seq}` });
  return { session: s, sub: store.subs.get(subId) };
}

let t: Awaited<ReturnType<typeof startTestApp>>;
let home = '';
const mails: { to: string; subject: string; text: string; from: string }[] = [];

beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  home = t.api.location;
  t.app.services.saasMailer = async (loc: any, mail: any) => {
    mails.push({ ...mail, from: loc.id });
    return { status: 'logged' };
  };
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

async function hook(event: any, opts: { secret?: string } = {}) {
  const raw = JSON.stringify(event);
  const r = await t.api.raw('/hooks/stripe-agency', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, opts.secret ?? WHSEC) }, body: raw });
  return { status: r.status, data: await r.json() };
}
const evt = (type: string, object: any) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });

/** A request with a sub-account API key: what a customer's own integration (or login) is held to. */
async function asCustomer(key: string, method: string, path: string, body?: unknown) {
  const r = await t.api.raw(path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
async function newLocationWithKey(name: string) {
  const loc = (await t.api.post('/api/locations', { name })).data;
  t.api.setLocation(loc.id);
  const key = (await t.api.post('/api/api-keys', { name: 'Kunde' })).data.key;
  t.api.setLocation(home);
  return { loc, key };
}

describe('SaaS rules (pure)', () => {
  it('validates plans and keeps settings always on', () => {
    const p = cleanPlan({ name: 'Starter', price_month: '49', price_year: '490,50', trial_days: 14, features: ['contacts', 'nonsense'], limits: { contacts: '1000', users: '', sms: 0 } });
    expect(p).toMatchObject({ price_month_cents: 4900, price_year_cents: 49050, trial_days: 14, features: ['contacts', 'settings'], limits: { contacts: 1000, users: null, sms: 0 } });
    expect(() => cleanPlan({ name: '' })).toThrow('Name');
    expect(() => cleanPlan({ name: 'X', trial_days: 500 })).toThrow('Testphase');
    expect(() => cleanPlan({ name: 'X', limits: { contacts: -1 } })).toThrow('Kontakte');
    expect(disabledAreas({ features: p.features })).toContain('courses');
    expect(disabledAreas({ features: p.features })).not.toContain('settings');
  });

  it('walks the billing lifecycle: past_due once, paused stays paused, payment reactivates', () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    const fresh = { status: 'active' as const, past_due_since: null, grace_until: null, paused_at: null, canceled_at: null };
    const due = transition(fresh, 'past_due', t0, 7);
    expect(due).toMatchObject({ status: 'past_due', past_due_since: t0.toISOString(), grace_until: '2026-10-08T10:00:00.000Z' });
    // A second failed attempt does not extend the grace period.
    expect(transition(due, 'past_due', new Date('2026-10-04T10:00:00Z'), 7).grace_until).toBe(due.grace_until);
    const paused = transition(due, 'paused', new Date('2026-10-08T10:00:00Z'), 7);
    expect(paused).toMatchObject({ status: 'paused', paused_at: '2026-10-08T10:00:00.000Z' });
    expect(transition(paused, 'past_due', new Date(), 7).status).toBe('paused');
    expect(transition(paused, 'active', new Date(), 7)).toEqual({ status: 'active', past_due_since: null, grace_until: null, paused_at: null, canceled_at: null });
    expect(mapStripeStatus('unpaid')).toBe('paused');
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
  });

  it('prices overage with markup and computes MRR and churn', () => {
    expect(overageCharge(1500, 1000, 8, 25)).toEqual({ qty: 500, unit_cents: 10, amount_cents: 5000 });
    expect(overageCharge(800, 1000, 8, 25).amount_cents).toBe(0);
    expect(overageCharge(2500, 0, 0.1, 50)).toMatchObject({ qty: 2500, amount_cents: 375 });
    expect(overageCharge(99, null, 8, 0).qty).toBe(0);
    expect(monthlyValue({ price_month_cents: 4900, price_year_cents: 49000 }, 'year')).toBe(4083);
    expect(churnRate(1, 9)).toBe(10);
    expect(churnRate(0, 0)).toBe(0);
    expect(prevMonth('2026-01')).toBe('2025-12');
    expect(monthKey(new Date('2026-10-04T12:00:00Z'))).toBe('2026-10');
  });
});

describe('SaaS mode', () => {
  let starter: any;
  let pro: any;
  let snapshotId = '';

  it('connects the agency Stripe account without ever returning the secrets', async () => {
    expect((await t.api.get('/api/saas/settings')).data).toMatchObject({ connected: false, webhook_url: 'http://localhost/hooks/stripe-agency', signup_enabled: false });
    expect((await t.api.put('/api/saas/settings', { secret_key: 'pk_test_nope' })).status).toBe(400);
    expect((await t.api.put('/api/saas/settings', { secret_key: 'sk_test_51WrongAgencyKey000aaaa' })).data.error).toContain('401');
    const r = await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC, grace_days: 5, signup_enabled: true, signup_title: 'Starte mit Paul', unit_cost: { emails: 10 }, markup_percent: 50 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ connected: true, webhook_set: true, key_hint: 'sk_test_…wxyz', account: { name: 'Agentur Paul' }, grace_days: 5, unit_cost: { emails: 10, sms: 8 } });
    expect(JSON.stringify(r.data)).not.toContain(KEY);
    expect(JSON.stringify((await t.api.get('/api/saas/settings')).data)).not.toContain(WHSEC);
    // Members can't see agency settings.
    expect((await t.api.put('/api/saas/settings', { grace_days: 99 })).status).toBe(400);
  });

  it('creates plans and syncs them to Stripe products and prices', async () => {
    // A template sub-account becomes the snapshot new customers start from.
    const tpl = (await t.api.post('/api/locations', { name: 'Vorlage Handwerk' })).data;
    t.api.setLocation(tpl.id);
    await t.api.post('/api/forms', { name: 'Anfrage', fields: [{ key: 'email', label: 'E-Mail', type: 'email' }] });
    t.api.setLocation(home);
    snapshotId = (await t.api.post('/api/snapshots', { location_id: tpl.id, name: 'Handwerk' })).data.id;

    const r = await t.api.post('/api/saas/plans', {
      name: 'Starter',
      description: 'Für Einsteiger',
      price_month: 49,
      price_year: 490,
      trial_days: 14,
      features: ['dashboard', 'conversations', 'contacts', 'funnels', 'forms', 'calendars'],
      limits: { contacts: 2, users: 1, funnels: 1, emails: 2, sms: 100, ai: 50 },
      overage: { emails: 'block' },
      snapshot_id: snapshotId,
    });
    expect(r.status).toBe(200);
    starter = r.data;
    expect(starter).toMatchObject({ name: 'Starter', price_month_cents: 4900, price_year_cents: 49000, sync_error: '', intervals: ['month', 'year'] });
    expect(starter.stripe_product_id).toMatch(/^prod_/);
    expect(store.prices.get(starter.stripe_price_month)).toMatchObject({ unit_amount: 4900, currency: 'eur', recurring: { interval: 'month' } });
    expect(store.prices.get(starter.stripe_price_year)).toMatchObject({ unit_amount: 49000, recurring: { interval: 'year' } });

    pro = (await t.api.post('/api/saas/plans', { name: 'Pro', price_month: 99, features: ['dashboard', 'conversations', 'contacts', 'courses', 'funnels', 'payments'], limits: { emails: 2 }, overage: { emails: 'bill' }, markup_percent: null, sort: 2 })).data;
    expect(pro.stripe_price_year).toBe('');

    // A new amount means a new Stripe price; the old one is archived.
    const oldPrice = pro.stripe_price_month;
    pro = (await t.api.patch(`/api/saas/plans/${pro.id}`, { price_month: 119 })).data;
    expect(pro.stripe_price_month).not.toBe(oldPrice);
    expect(store.prices.get(oldPrice).active).toBe(false);
    expect(store.prices.get(pro.stripe_price_month).unit_amount).toBe(11900);
    // Renaming only updates the product, prices stay.
    const before = pro.stripe_price_month;
    pro = (await t.api.patch(`/api/saas/plans/${pro.id}`, { name: 'Profi' })).data;
    expect(pro.stripe_price_month).toBe(before);
    expect(store.products.get(pro.stripe_product_id).name).toBe('Profi');
    expect((await t.api.post('/api/saas/plans', { name: 'Kaputt', trial_days: -2 })).status).toBe(400);
  });

  it('signs a customer up: plan → Stripe Checkout → account from snapshot → invite → logged in', async () => {
    const page = await t.api.raw('/signup');
    const htmlText = await page.text();
    expect(page.status).toBe(200);
    expect(htmlText).toContain('Starte mit Paul');
    expect(htmlText).toContain('Starter');
    expect(htmlText).toContain('14 Tage kostenlos testen');
    expect(htmlText).toContain('2 Kontakte');

    const form = new URLSearchParams({ plan: starter.id, interval: 'month', company: 'Malerei Muster', name: 'Mia Muster', email: 'Mia@Muster.de', phone: '0170 1234567' });
    const post = await t.api.raw('/signup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const browser = post.headers.get('set-cookie')!.split(';')[0];
    expect(browser).toMatch(/^pghl_signup=/);
    const checkout = calls.filter((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST').pop()!;
    expect(checkout.params.get('mode')).toBe('subscription');
    expect(checkout.params.get('line_items[0][price]')).toBe(starter.stripe_price_month);
    expect(checkout.params.get('subscription_data[trial_period_days]')).toBe('14');
    expect(checkout.params.get('customer_email')).toBe('mia@muster.de');
    const sessionId = [...store.sessions.keys()].pop()!;

    // Already used e-mail → friendly error, no checkout.
    const dupe = await t.api.raw('/signup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ plan: starter.id, interval: 'month', company: 'X', email: 'chef@example.com' }).toString() });
    expect(dupe.status).toBe(400);
    expect(await dupe.text()).toContain('schon ein Konto');

    // Stripe confirms by webhook.
    const { session } = completeCheckout(sessionId);
    const r = await hook(evt('checkout.session.completed', { ...session }));
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ received: true, handled: 'account_created' });
    const locId = r.data.locationId;
    const loc = t.app.location(locId)!;
    expect(loc.name).toBe('Malerei Muster');
    // The snapshot's form is there.
    expect(t.app.db.get('SELECT name FROM forms WHERE location_id = ?', locId)?.name).toBe('Anfrage');
    const sub = t.app.db.get('SELECT * FROM saas_subscriptions WHERE location_id = ?', locId)!;
    expect(sub).toMatchObject({ plan_id: starter.id, status: 'trialing', billing: 'stripe', stripe_customer: session.customer, stripe_subscription: session.subscription, interval: 'month' });
    expect(sub.current_period_end).toBeTruthy();
    const user = t.app.db.get('SELECT * FROM users WHERE email = ?', 'mia@muster.de')!;
    expect(user.role).toBe('member');
    expect(JSON.parse(user.locations)).toEqual([locId]);
    const invite = mails.find((m) => m.to === 'mia@muster.de')!;
    expect(invite.subject).toContain('Passwort');
    expect(invite.text).toMatch(/http:\/\/localhost\/invite\/[A-Za-z0-9_-]+/);

    // A retried webhook does nothing twice.
    expect((await hook(evt('checkout.session.completed', { ...session }))).data.handled).toBe('duplicate');
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM locations WHERE name = ?', 'Malerei Muster')!.n).toBe(1);

    // Back from Stripe in the same browser → straight to "set your password".
    const done = await t.api.raw(`/signup/done?session_id=${sessionId}`, { headers: { cookie: browser }, redirect: 'manual' });
    expect(done.status).toBe(303);
    const invitePath = done.headers.get('location')!;
    expect(invitePath).toMatch(/^\/invite\//);
    // Another browser only gets the "check your e-mail" page.
    const other = await t.api.raw(`/signup/done?session_id=${sessionId}`, { redirect: 'manual' });
    expect(other.status).toBe(200);
    expect(await other.text()).toContain('mia@muster.de');

    expect((await t.api.raw(invitePath)).status).toBe(200);
    const short = await t.api.raw(invitePath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=kurz&password2=kurz' });
    expect(short.status).toBe(400);
    const set = await t.api.raw(invitePath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=meinpasswort&password2=meinpasswort', redirect: 'manual' });
    expect(set.status).toBe(303);
    expect(set.headers.get('location')).toBe('/app');
    const session2 = set.headers.get('set-cookie')!.split(';')[0];
    const me = await (await t.api.raw('/api/me', { headers: { cookie: session2 } })).json();
    expect(me.user.email).toBe('mia@muster.de');
    expect(me.locations.map((l: any) => l.id)).toEqual([locId]);
    // The link works once.
    expect((await t.api.raw(invitePath)).status).toBe(410);
    // Her account view: plan, trial, hidden areas.
    const acc = await (await t.api.raw('/api/saas/account', { headers: { cookie: session2, 'x-location-id': locId } })).json();
    expect(acc).toMatchObject({ status: 'trialing', plan: { name: 'Starter' }, portal: true });
    expect(acc.blocked).toContain('courses');
    expect(acc.blocked).not.toContain('contacts');
    const blockedCourse = await t.api.raw('/api/courses/x', { headers: { cookie: session2, 'x-location-id': locId } });
    expect(blockedCourse.status).toBe(403);
    expect((await blockedCourse.json()).error).toContain('nicht enthalten');
  });

  it('rejects webhooks without a valid signature', async () => {
    const body = evt('invoice.payment_failed', { subscription: 'sub_x' });
    expect((await hook(body, { secret: 'whsec_wrongwrongwrong0000' })).status).toBe(400);
    const raw = JSON.stringify(body);
    expect((await t.api.raw('/hooks/stripe-agency', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })).status).toBe(400);
    const stale = await t.api.raw('/hooks/stripe-agency', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC, Math.floor(Date.now() / 1000) - 3600) }, body: raw });
    expect(stale.status).toBe(400);
  });

  it('gates areas per plan for customers but never for the agency', async () => {
    const { loc, key } = await newLocationWithKey('Kunde Gating');
    expect((await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: starter.id })).data).toMatchObject({ plan: { name: 'Starter' }, subscription: { status: 'active', billing: 'manual' } });
    // Not in the plan: courses, payments, workflows…
    const c = await asCustomer(key, 'POST', '/api/courses', { title: 'Kurs' });
    expect(c.status).toBe(403);
    expect(c.data.error).toBe('„Kurse & Mitgliederbereich“ ist in deinem Tarif „Starter“ nicht enthalten. Für diesen Bereich bitte auf einen größeren Tarif wechseln (Einstellungen → Abo & Rechnung).');
    expect((await asCustomer(key, 'GET', '/api/invoices')).status).toBe(403);
    // In the plan.
    expect((await asCustomer(key, 'GET', '/api/contacts')).status).toBe(200);
    // The agency admin still gets in.
    t.api.setLocation(loc.id);
    expect((await t.api.post('/api/courses', { title: 'Von der Agentur' })).status).toBe(200);
    expect((await t.api.get('/api/saas/account')).data.blocked).toEqual([]);
    t.api.setLocation(home);
    // Upgrade → area opens.
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: pro.id });
    expect((await asCustomer(key, 'GET', '/api/invoices')).status).toBe(200);
    // Removing the plan lifts all rules.
    expect((await t.api.del(`/api/saas/locations/${loc.id}`)).status).toBe(200);
    expect((await asCustomer(key, 'POST', '/api/courses', { title: 'Jetzt geht es' })).status).toBe(200);
  });

  it('stops creating at the plan limits with a friendly German message', async () => {
    const { loc, key } = await newLocationWithKey('Kunde Limits');
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: starter.id });
    expect((await asCustomer(key, 'POST', '/api/contacts', { email: 'a@x.de' })).status).toBe(200);
    expect((await asCustomer(key, 'POST', '/api/contacts', { email: 'b@x.de' })).status).toBe(200);
    const third = await asCustomer(key, 'POST', '/api/contacts', { email: 'c@x.de' });
    expect(third.status).toBe(403);
    expect(third.data.error).toBe('Limit erreicht: Dein Tarif „Starter“ enthält 2 Kontakte. Für mehr bitte auf einen größeren Tarif wechseln (Einstellungen → Abo & Rechnung).');
    // Updating an existing contact is still fine.
    expect((await asCustomer(key, 'POST', '/api/contacts', { email: 'A@x.de', first_name: 'Anna' })).status).toBe(200);
    expect((await asCustomer(key, 'POST', '/api/contacts/import', { csv: 'email\nd@x.de' })).status).toBe(403);
    // Funnels: 1.
    expect((await asCustomer(key, 'POST', '/api/funnels', { name: 'Seite 1' })).status).toBe(200);
    expect((await asCustomer(key, 'POST', '/api/funnels', { name: 'Seite 2' })).data.error).toContain('1 Funnels/Websites');
    // Users: 1 member login.
    expect((await t.api.post('/api/users', { email: 'team1@x.de', password: 'geheim123', locations: [loc.id] })).status).toBe(200);
    const u2 = await t.api.post('/api/users', { email: 'team2@x.de', password: 'geheim123', locations: [loc.id] });
    expect(u2.status).toBe(403);
    expect(u2.data.error).toContain('1 Nutzer');
    // Admins don't count.
    expect((await t.api.post('/api/users', { email: 'admin2@x.de', password: 'geheim123', role: 'admin', locations: [loc.id] })).status).toBe(200);
    const acc = (await asCustomer(key, 'GET', '/api/saas/account')).data;
    expect(acc.counts).toMatchObject({ contacts: 2, users: 1, funnels: 1 });
  });

  it('counts e-mails per month and blocks above a "block" limit, bills above a "bill" limit', async () => {
    const { loc, key } = await newLocationWithKey('Kunde Mails');
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: starter.id });
    const contact = (await asCustomer(key, 'POST', '/api/contacts', { email: 'leser@x.de' })).data;
    const send = () => asCustomer(key, 'POST', '/api/messages', { contact_id: contact.id, channel: 'email', subject: 'Hallo', body: 'Test' });
    expect((await send()).data.status).toBe('logged');
    expect((await send()).data.status).toBe('logged');
    const third = (await send()).data;
    expect(third.status).toBe('failed');
    expect(third.error).toContain('2 E-Mails pro Monat');
    expect(t.app.db.get('SELECT count FROM saas_usage WHERE location_id = ? AND metric = ?', loc.id, 'emails')!.count).toBe(2);
    // Pro bills overage instead of blocking.
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: pro.id });
    expect((await send()).data.status).toBe('logged');
    expect((await asCustomer(key, 'GET', '/api/saas/account')).data.usage.emails).toBe(3);
  });

  let billed = '';
  it('runs the billing lifecycle: past due → grace → paused (read-only) → reactivated, cancel at period end', async () => {
    // An existing customer gets a Checkout link from the agency.
    const { loc, key } = await newLocationWithKey('Kunde Abo');
    billed = loc.id;
    const link = await t.api.post(`/api/saas/locations/${loc.id}/checkout`, { plan_id: pro.id, interval: 'month', email: 'kunde@abo.de' });
    expect(link.data.url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    const { session, sub } = completeCheckout(link.data.id);
    expect((await hook(evt('checkout.session.completed', session))).data).toMatchObject({ handled: 'subscribed', locationId: loc.id });
    expect((await t.api.get(`/api/saas/locations/${loc.id}`)).data.subscription).toMatchObject({ status: 'active', billing: 'stripe', stripe_subscription: sub.id });

    // Payment fails → past due with grace period and a banner.
    await t.api.put('/api/saas/settings', { grace_days: 0 });
    expect((await hook(evt('invoice.payment_failed', { id: 'in_1', subscription: sub.id }))).data).toMatchObject({ handled: 'payment_failed', status: 'past_due' });
    let acc = (await asCustomer(key, 'GET', '/api/saas/account')).data;
    expect(acc.status).toBe('past_due');
    expect(acc.banner).toMatchObject({ tone: 'warn', action: 'portal' });
    expect(acc.banner.text).toContain('Zahlung fehlgeschlagen');
    expect((await asCustomer(key, 'POST', '/api/contacts', { email: 'still@ok.de' })).status).toBe(200);

    // Grace period over → paused: read-only for the customer.
    await t.app.tick();
    acc = (await asCustomer(key, 'GET', '/api/saas/account')).data;
    expect(acc).toMatchObject({ status: 'paused', read_only: true, banner: { tone: 'error' } });
    const write = await asCustomer(key, 'POST', '/api/contacts', { email: 'nope@x.de' });
    expect(write.status).toBe(403);
    expect(write.data.error).toContain('pausiert');
    expect((await asCustomer(key, 'GET', '/api/contacts')).status).toBe(200);
    // Fixing the payment stays possible.
    expect((await asCustomer(key, 'POST', '/api/saas/account/portal')).data.url).toBe(`https://billing.stripe.com/p/session/${sub.customer}`);
    // Stripe still says past_due: stays paused.
    expect((await hook(evt('customer.subscription.updated', { ...sub, status: 'past_due' }))).data.status).toBe('paused');

    // Paid → back to active.
    expect((await hook(evt('invoice.paid', { id: 'in_1', parent: { subscription_details: { subscription: sub.id } } }))).data.handled).toBe('reactivated');
    expect((await asCustomer(key, 'POST', '/api/contacts', { email: 'wieder@da.de' })).status).toBe(200);

    // Cancel at period end (from "Abo & Rechnung"), then undo.
    const cancel = (await asCustomer(key, 'POST', '/api/saas/account/cancel')).data;
    expect(cancel).toMatchObject({ cancel_at_period_end: true, banner: { tone: 'info', action: 'undo_cancel' } });
    expect(store.subs.get(sub.id).cancel_at_period_end).toBe(true);
    expect((await asCustomer(key, 'POST', '/api/saas/account/cancel', { undo: true })).data.cancel_at_period_end).toBe(false);

    // The agency switches plans: Stripe gets the new price.
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: starter.id, interval: 'year' });
    const upd = calls.filter((c) => c.path === `/v1/subscriptions/${sub.id}` && c.method === 'POST').pop()!;
    expect(upd.params.get('items[0][price]')).toBe(starter.stripe_price_year);
    expect(upd.params.get('items[0][id]')).toBe(sub.items.data[0].id);
    expect((await t.api.get(`/api/saas/locations/${loc.id}`)).data.subscription).toMatchObject({ plan_id: starter.id, interval: 'year' });
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: pro.id, interval: 'month' });
    expect((await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: pro.id, status: 'paused' })).status).toBe(400);
    await t.api.put('/api/saas/settings', { grace_days: 7 });
  });

  it('rebills usage above the included amount as Stripe invoice items with markup, once', async () => {
    const last = prevMonth(monthKey());
    // Pro includes 2 e-mails and bills the rest; the agency pays 10 ct and adds 50 %.
    t.app.db.run('UPDATE saas_subscriptions SET created_at = ? WHERE location_id = ?', `${last}-01T00:00:00.000Z`, billed);
    t.app.db.run('INSERT INTO saas_usage (location_id, month, metric, count) VALUES (?, ?, ?, ?)', billed, last, 'emails', 12);
    t.app.db.run('INSERT INTO saas_usage (location_id, month, metric, count) VALUES (?, ?, ?, ?)', billed, last, 'sms', 500);
    const r = (await t.api.post('/api/saas/usage/report')).data.items;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ location_id: billed, month: last, metric: 'emails', quantity: 10, amount_cents: 150 });
    const item = store.items.pop();
    const sub = t.app.db.get('SELECT * FROM saas_subscriptions WHERE location_id = ?', billed)!;
    expect(item).toMatchObject({ amount: 150, customer: sub.stripe_customer, subscription: sub.stripe_subscription });
    expect(calls.filter((c) => c.path === '/v1/invoiceitems').pop()!.idem).toBe(`saas-usage-${billed}-${last}-emails`);
    // Second run: nothing new; the current month waits until it's over.
    t.app.db.run('INSERT INTO saas_usage (location_id, month, metric, count) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET count = 99', billed, monthKey(), 'emails', 99);
    expect((await t.api.post('/api/saas/usage/report')).data.items).toHaveLength(0);
    expect(store.items).toHaveLength(0);
  });

  it('shows MRR, statuses, churn, plans and renewals on the agency dashboard', async () => {
    // A customer leaves.
    const { loc } = await newLocationWithKey('Kunde Weg');
    await t.api.put(`/api/saas/locations/${loc.id}`, { plan_id: starter.id });
    await t.api.post(`/api/saas/locations/${loc.id}/cancel`, { now: true });
    const o = (await t.api.get('/api/saas/overview')).data;
    expect(o.counts).toMatchObject({ trialing: 1, canceled: 1 });
    expect(o.counts.active).toBeGreaterThanOrEqual(3);
    expect(o.churn.lost_30d).toBe(1);
    expect(o.churn.rate_percent).toBeGreaterThan(0);
    // Pro (119 €) on Stripe + manual Starter/Pro accounts; the trial doesn't count.
    const proRow = o.plans.find((p: any) => p.id === pro.id);
    expect(proRow.count).toBeGreaterThanOrEqual(2);
    expect(o.mrr_cents).toBe(o.plans.reduce((s: number, p: any) => s + p.mrr_cents, 0));
    expect(o.mrr_cents).toBeGreaterThanOrEqual(11900 + 4900);
    expect(o.renewals.some((r: any) => r.location_id === billed)).toBe(true);
    expect(o.events.some((e: any) => e.type === 'paused')).toBe(true);
  });

  it('offers MCP tools for the overview and for setting a plan', async () => {
    const key = (await t.api.post('/api/agency/api-keys', { name: 'Claude' })).data.key;
    const call = async (name: string, args: any) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const res = (await r.json()).result;
      return res.isError ? { error: res.content[0].text } : JSON.parse(res.content[0].text);
    };
    const { loc } = await newLocationWithKey('Kunde MCP');
    expect(await call('ghl_set_location_plan', { location_id: loc.id, plan: 'starter' })).toMatchObject({ plan: { name: 'Starter' } });
    expect((await call('ghl_set_location_plan', { location_id: loc.id, plan: 'Gibt es nicht' })).error).toContain('nicht gefunden');
    const o = await call('ghl_saas_overview', {});
    expect(o.accounts.some((a: any) => a.location_id === loc.id && a.plan === 'Starter')).toBe(true);
    expect(await call('ghl_set_location_plan', { location_id: loc.id })).toMatchObject({ ok: true });
  });

  it('lets free plans sign up without Stripe and refuses closed signups', async () => {
    const free = (await t.api.post('/api/saas/plans', { name: 'Gratis', features: ['dashboard', 'contacts'], limits: { contacts: 50 } })).data;
    expect(free.free).toBe(true);
    const r = await t.api.raw('/signup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ plan: free.id, company: 'Gratis GmbH', email: 'gratis@x.de' }).toString(), redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/^\/invite\//);
    const loc = t.app.db.get('SELECT id FROM locations WHERE name = ?', 'Gratis GmbH')!;
    expect(t.app.db.get('SELECT * FROM saas_subscriptions WHERE location_id = ?', loc.id)).toMatchObject({ billing: 'manual', status: 'active', plan_id: free.id });
    // Honeypot: looks fine, does nothing.
    await t.api.raw('/signup', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ plan: free.id, company: 'Bot', email: 'bot@x.de', website: 'spam' }).toString() });
    expect(t.app.db.get('SELECT id FROM locations WHERE name = ?', 'Bot')).toBeUndefined();
    await t.api.put('/api/saas/settings', { signup_enabled: false });
    expect((await t.api.raw('/signup')).status).toBe(404);
    // Plans in use can't be deleted.
    expect((await t.api.del(`/api/saas/plans/${starter.id}`)).status).toBe(400);
  });
});
