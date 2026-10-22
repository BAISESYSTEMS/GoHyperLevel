import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';

const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: 'Invalid API Key provided' } }, 401);
  if (u.pathname === '/v1/account') return json({ id: 'acct_123', settings: { dashboard: { display_name: 'Malerei Muster' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let product = '';
const mails: { to: string; subject: string; html: string; text: string }[] = [];
const events: { type: string; data: any }[] = [];
let n = 0;

beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push({ to: mail.to, subject: mail.subject, html: mail.html, text: mail.text }), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture', fromEmail: 'info@absender.example' } } });
  product = (await t.api.post('/api/products', { name: 'Online-Kurs', price_cents: 19700 })).data.id;
  for (const type of ['checkout.abandoned', 'product.purchased']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

async function hook(event: any, location = loc) {
  const raw = JSON.stringify(event);
  const r = await t.api.raw(`/hooks/stripe/${location}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return { status: r.status, data: await r.json() };
}
/** A Checkout Session of a product that ran out without payment. */
const expired = (over: Record<string, any> = {}, eventId = `evt_exp_${++n}`) => ({
  id: eventId,
  type: 'checkout.session.expired',
  data: { object: { id: `cs_test_${n}`, object: 'checkout.session', mode: 'payment', payment_status: 'unpaid', status: 'expired', amount_total: 19700, currency: 'eur', metadata: { location_id: loc, product_id: product }, ...over } },
});
const contact = async (email: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { email, first_name: email.split('@')[0], ...extra })).data;
const tagsOf = async (id: string) => (await t.api.get(`/api/contacts/${id}`)).data.tags as string[];

describe('abandoned checkout', () => {
  it('fires checkout.abandoned for the contact when an unpaid session expires – and Stripe still processes it as before', async () => {
    const c = await contact('anna@kunde.example');
    events.length = 0;
    const r = await hook(expired({ customer_details: { email: 'anna@kunde.example' } }));
    expect(r).toEqual({ status: 200, data: { received: true, handled: 'failed' } }); // the Stripe module's own result is untouched
    expect(events.filter((e) => e.type === 'checkout.abandoned')).toHaveLength(1);
    expect(events[0].data).toMatchObject({ contactId: c.id, productId: product, product_name: 'Online-Kurs', amount_cents: 19700, currency: 'EUR', recovery_url: `http://localhost/buy/${product}` });
    expect(events[0].data.checkoutId).toBe(`cs_test_${n}`);
    expect(await tagsOf(c.id)).toContain('warenkorbabbruch');
    const activity = (await t.api.get(`/api/contacts/${c.id}`)).data.activities.map((a: any) => a.summary).join('\n');
    expect(activity).toContain('Checkout abgebrochen: Online-Kurs');
  });

  it('uses the short link of the product page in the recovery link', async () => {
    t.app.db.run(`INSERT INTO stripe_product_links (product_id, location_id, slug, enabled, redirect_url, tag, updated_at) VALUES (?, ?, 'online-kurs', 1, '', '', ?)`, product, loc, new Date().toISOString());
    await contact('ben@kunde.example');
    events.length = 0;
    await hook(expired({ customer_email: 'ben@kunde.example' }));
    expect(events[0].data.recovery_url).toBe('http://localhost/buy/online-kurs');
  });

  it('recognises the contact by the checkout it belongs to as well', async () => {
    const c = await contact('carla@kunde.example');
    const sid = `cs_known_${++n}`;
    t.app.db.insert('stripe_checkouts', { id: sid, location_id: loc, kind: 'product', product_id: product, contact_id: c.id, url: '', mode: 'payment', amount_cents: 19700, currency: 'EUR', status: 'open', email: '', meta: {}, created_at: new Date().toISOString() });
    events.length = 0;
    await hook(expired({ id: sid }));
    expect(events.map((e) => e.data.contactId)).toEqual([c.id]);
    expect(t.app.db.get<any>('SELECT status FROM stripe_checkouts WHERE id = ?', sid).status).toBe('expired');
  });

  it('does nothing for a stranger, unless the sub-account allows creating contacts', async () => {
    events.length = 0;
    await hook(expired({ customer_details: { email: 'fremder@x.example' } }));
    expect(events).toHaveLength(0);
    expect(t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'fremder@x.example')).toBeUndefined();
    await hook(expired({}));
    expect(events).toHaveLength(0);
    await t.api.put('/api/deliverability/settings', { abandoned: { create_contacts: true } });
    await hook(expired({ customer_details: { email: 'neu@x.example', name: 'Nora Neu' } }));
    expect(events).toHaveLength(1);
    const made = t.app.db.get<any>('SELECT * FROM contacts WHERE email = ?', 'neu@x.example');
    expect(made).toMatchObject({ first_name: 'Nora', last_name: 'Neu' });
    expect(made.source).toContain('abgebrochen');
    await t.api.put('/api/deliverability/settings', { abandoned: { create_contacts: false } });
  });

  it('ignores sessions that are paid, belong to an invoice, to another sub-account, or whose product was bought meanwhile', async () => {
    const c = await contact('dora@kunde.example');
    events.length = 0;
    await hook(expired({ payment_status: 'paid', customer_details: { email: 'dora@kunde.example' } }));
    await hook(expired({ metadata: { location_id: loc, invoice_id: 'inv1' }, customer_details: { email: 'dora@kunde.example' } }));
    await hook(expired({ metadata: { location_id: 'andere', product_id: product }, customer_details: { email: 'dora@kunde.example' } }));
    expect(events.filter((e) => e.type === 'checkout.abandoned')).toHaveLength(0);
    // bought in the meantime: the contact has a paid checkout for the product made after the session started
    const sid = `cs_open_${++n}`;
    const t0 = new Date(Date.now() - 3600_000).toISOString();
    t.app.db.insert('stripe_checkouts', { id: sid, location_id: loc, kind: 'product', product_id: product, contact_id: c.id, url: '', mode: 'payment', amount_cents: 19700, currency: 'EUR', status: 'open', email: '', meta: {}, created_at: t0 });
    t.app.db.insert('stripe_checkouts', { id: `cs_paid_${++n}`, location_id: loc, kind: 'product', product_id: product, contact_id: c.id, url: '', mode: 'payment', amount_cents: 19700, currency: 'EUR', status: 'paid', email: '', meta: {}, created_at: t0, paid_at: new Date().toISOString() });
    await hook(expired({ id: sid }));
    expect(events.filter((e) => e.type === 'checkout.abandoned')).toHaveLength(0);
    expect(await tagsOf(c.id)).not.toContain('warenkorbabbruch');
  });

  it('counts a Stripe event once, even when Stripe sends it again', async () => {
    await contact('emil@kunde.example');
    events.length = 0;
    const e = expired({ customer_details: { email: 'emil@kunde.example' } }, 'evt_same_one');
    await hook(e);
    expect((await hook(e)).data).toEqual({ received: true, duplicate: true });
    expect(events).toHaveLength(1);
  });

  it('needs a valid signature like every Stripe event', async () => {
    events.length = 0;
    const raw = JSON.stringify(expired({ customer_details: { email: 'anna@kunde.example' } }));
    const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, 'whsec_wrong0000000000') }, body: raw });
    expect(r.status).toBe(400);
    await t.app.events.flush();
    expect(events).toHaveLength(0);
  });
});

describe('Warenkorbabbruch-Serie (recipe)', () => {
  it('sends three mails with the recovery link and stops when the product is bought', async () => {
    const wf = (await t.api.post('/api/workflows', { recipe: 'abandoned_checkout' })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = await contact('serie@kunde.example');
    mails.length = 0;
    await hook(expired({ customer_details: { email: 'serie@kunde.example' } }));
    const runs = () => t.app.db.all<any>('SELECT * FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', wf.id, c.id);
    expect(runs()).toHaveLength(1);
    // mail 1 right away, with the link back to the product
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('serie@kunde.example');
    expect(mails[0].subject).toBe('Du hast etwas vergessen, serie');
    // the button goes through click tracking; its target is the buy page
    expect(t.app.db.all<{ url: string }>('SELECT url FROM tracked_links WHERE contact_id = ?', c.id).map((l) => l.url)).toContain('http://localhost/buy/online-kurs');
    expect(mails[0].html).toContain('Online-Kurs');
    expect(mails[0].html).not.toContain('{{');
    expect(mails[0].text).toContain('http://localhost/buy/');
    expect(runs()[0].status).toBe('waiting');

    // two days later: the contact is still not a buyer → mail 2
    const due = () => t.app.db.run(`UPDATE workflow_runs SET next_run_at = ? WHERE workflow_id = ? AND status = 'waiting'`, new Date(Date.now() - 1000).toISOString(), wf.id);
    due();
    await t.app.tick();
    expect(mails).toHaveLength(2);
    expect(mails[1].subject).toBe('Noch Fragen zu „Online-Kurs“?');

    // the contact buys: the tag goes, the goal ends the series, no third mail
    t.app.events.emit(loc, 'product.purchased', { contactId: c.id, productId: product });
    await t.app.events.flush();
    expect(await tagsOf(c.id)).not.toContain('warenkorbabbruch');
    due();
    await t.app.tick();
    expect(mails).toHaveLength(2);
    expect(runs()[0].status).toBe('completed');
    const log = JSON.parse(runs()[0].log);
    expect(log.some((l: any) => l.type === 'goal' && l.result === 'erreicht')).toBe(true);
  });

  it('runs to the end – three mails and the tag removed – when the contact does not buy', async () => {
    const wf = t.app.db.get<any>(`SELECT id FROM workflows WHERE location_id = ? AND name = 'Warenkorbabbruch-Serie'`, loc);
    const c = await contact('ganz@kunde.example');
    mails.length = 0;
    await hook(expired({ customer_details: { email: 'ganz@kunde.example' } }));
    for (let i = 0; i < 2; i++) {
      t.app.db.run(`UPDATE workflow_runs SET next_run_at = ? WHERE workflow_id = ? AND contact_id = ? AND status = 'waiting'`, new Date(Date.now() - 1000).toISOString(), wf.id, c.id);
      await t.app.tick();
    }
    expect(mails.map((m) => m.subject)).toEqual(['Du hast etwas vergessen, ganz', 'Noch Fragen zu „Online-Kurs“?', 'Letzte Erinnerung: „Online-Kurs“']);
    expect(await tagsOf(c.id)).not.toContain('warenkorbabbruch');
    expect(t.app.db.get<any>('SELECT status FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', wf.id, c.id).status).toBe('completed');
  });

  it('can start again after the next abandoned checkout', async () => {
    const wf = t.app.db.get<any>(`SELECT id FROM workflows WHERE location_id = ? AND name = 'Warenkorbabbruch-Serie'`, loc);
    const c = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'ganz@kunde.example'`);
    mails.length = 0;
    await hook(expired({ customer_details: { email: 'ganz@kunde.example' } }));
    expect(t.app.db.all('SELECT id FROM workflow_runs WHERE workflow_id = ? AND contact_id = ?', wf.id, c.id)).toHaveLength(2);
    expect(mails).toHaveLength(1);
  });

  it('respects the consent: without a valid consent the marketing mail is not sent', async () => {
    await t.api.put('/api/consent/settings', { policy: 'confirmed' });
    const c = await contact('ohne@kunde.example');
    mails.length = 0;
    await hook(expired({ customer_details: { email: 'ohne@kunde.example' } }));
    expect(mails).toHaveLength(0);
    const m = t.app.db.get<any>(`SELECT status, error FROM messages WHERE contact_id = ? AND channel = 'email'`, c.id);
    expect(m.status).toBe('failed');
    expect(m.error).toContain('Einwilligung');
    // with a consent it goes
    const ok = await contact('mit@kunde.example', { consent: true });
    await hook(expired({ customer_details: { email: 'mit@kunde.example' } }));
    expect(mails.map((x) => x.to)).toEqual(['mit@kunde.example']);
    await t.api.put('/api/consent/settings', { policy: 'legacy' });
    expect(ok.id).toBeTruthy();
  });

  it('a trigger can be limited to one product', async () => {
    const other = (await t.api.post('/api/products', { name: 'Anderes Produkt', price_cents: 500 })).data.id;
    const wf = (await t.api.post('/api/workflows', { name: 'Nur anderes', trigger: { type: 'checkout.abandoned', config: { product_id: other } }, steps: [{ type: 'add_tag', tags: ['anderes-abgebrochen'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = await contact('filter@kunde.example', { consent: true });
    await hook(expired({ customer_details: { email: 'filter@kunde.example' } }));
    expect(await tagsOf(c.id)).not.toContain('anderes-abgebrochen');
    await hook(expired({ metadata: { location_id: loc, product_id: other }, customer_details: { email: 'filter@kunde.example' } }));
    expect(await tagsOf(c.id)).toContain('anderes-abgebrochen');
  });

  it('shows up in the workflow catalogue with its description', async () => {
    const cat = (await t.api.get('/api/workflow-catalog?kind=triggers&q=warenkorb')).data;
    const trig = cat.triggers.find((x: any) => x.type === 'checkout.abandoned');
    expect(trig).toMatchObject({ label: 'Checkout abgebrochen (Warenkorbabbruch)', category: 'payments' });
    expect(trig.doc).toContain('checkout.session.expired');
    expect(trig.fields.map((f: any) => f.key)).toEqual(['product_id']);
  });
});
