import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { commissionFor, payoutCsv, refundAdjustment, sepaText, sepaXml, validIban } from '../server/services/affiliates.js';
import type { AppEvent } from '../server/core/events.js';

describe('commission maths', () => {
  it('percent or fixed, recurring only when the program allows it', () => {
    const pct = { commission_type: 'percent' as const, commission_value: 20, recurring: 0 };
    expect(commissionFor(pct, { base_cents: 10000, recurring: false })).toBe(2000);
    expect(commissionFor(pct, { base_cents: 10000, recurring: true })).toBeNull();
    expect(commissionFor({ ...pct, recurring: 1 }, { base_cents: 4999, recurring: true })).toBe(1000);
    expect(commissionFor({ commission_type: 'fixed', commission_value: 2500, recurring: 0 }, { base_cents: 100, recurring: false })).toBe(2500);
    expect(commissionFor(pct, { base_cents: 0, recurring: false })).toBeNull();
  });

  it('refunds reverse, reduce or claw back', () => {
    expect(refundAdjustment({ amount_cents: 2000, status: 'pending' }, 11900, 11900)).toEqual({ action: 'reverse', amount: 0 });
    expect(refundAdjustment({ amount_cents: 2000, status: 'approved' }, 5950, 11900)).toEqual({ action: 'reduce', amount: 1000 });
    expect(refundAdjustment({ amount_cents: 2000, status: 'paid' }, 11900, 11900)).toEqual({ action: 'clawback', amount: -2000 });
    expect(refundAdjustment({ amount_cents: 2000, status: 'reversed' }, 11900, 11900).action).toBe('none');
    // after payout only what was paid beyond the new amount comes back (reduced to 1000 before, paid out, now 75 % refunded)
    expect(refundAdjustment({ amount_cents: 1000, original_cents: 2000, status: 'paid' }, 8925, 11900)).toEqual({ action: 'clawback', amount: -500 });
    // in an open payout: not edited, clawed back like a paid one
    expect(refundAdjustment({ amount_cents: 2000, status: 'approved', payout_id: 'p1' }, 5950, 11900)).toEqual({ action: 'clawback', amount: -1000 });
    // a smaller refund after a bigger credit never gives commission back
    expect(refundAdjustment({ amount_cents: 1000, original_cents: 2000, status: 'pending' }, 2975, 11900)).toEqual({ action: 'none', amount: 0 });
  });

  it('checks IBANs and writes SEPA-safe text', () => {
    expect(validIban('DE89 3704 0044 0532 0130 00')).toBe(true);
    expect(validIban('DE89 3704 0044 0532 0130 01')).toBe(false);
    expect(validIban('AT611904300234573201')).toBe(true);
    expect(sepaText('Jürgen Größe & Söhne <GmbH>', 70)).toBe('Juergen Groesse Soehne GmbH');
  });
});

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';
const sessions = new Map<string, any>();
let seq = 0;
const fakeStripe = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Test' } } });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, amount_total: Number(params.get('line_items[0][price_data][unit_amount]')), currency: 'eur', payment_status: 'unpaid', status: 'open' };
    sessions.set(id, s);
    return json(s);
  }
  return json({ error: { message: 'unknown' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let program: any;
let anna: any;
let funnel: any;
let form: any;
const events: AppEvent[] = [];
const mails: { to: string; text: string }[] = [];
const ua = { 'user-agent': 'Mozilla/5.0 Test' };

async function stripeHook(event: any) {
  const raw = JSON.stringify(event);
  const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await t.app.events.flush();
  return r.json();
}
const visit = async (path: string, headers: Record<string, string> = {}) => {
  const r = await t.api.raw(path, { headers: { ...ua, ...headers } });
  const body = await r.text();
  return { body, token: body.match(/name="_(?:attr|a)" value="([^"]+)"/)?.[1] ?? '' };
};
const submit = async (body: Record<string, unknown>) => {
  const r = await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', ...ua }, body: JSON.stringify(body) });
  await t.app.events.flush();
  return r.json();
};
const paidInvoice = async (contactId: string, net: number) => {
  const inv = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Kurs', qty: 1, price_cents: net, tax_rate: 19 }] })).data;
  await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
  await t.app.events.flush();
  return inv;
};
const commissions = async (q = '') => (await t.api.get(`/api/affiliates/commissions${q}`)).data as any[];

beforeAll(async () => {
  setStripeFetch(fakeStripe);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.affiliateMailer = async (_loc: any, mail: any) => (mails.push({ to: mail.to, text: mail.text }), { status: 'sent' });
  t.app.events.on('*', (e) => void events.push(e));
  form = (await t.api.post('/api/forms', { name: 'Lead' })).data;
  funnel = (await t.api.post('/api/funnels', { name: 'Angebot', template: 'blank' })).data;
  await t.api.patch(`/api/funnel-pages/${funnel.pages[0].id}`, { blocks: [{ type: 'form', form_id: form.id }] });
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

describe('programs and affiliates', () => {
  it('creates a program and adds an affiliate by hand', async () => {
    expect((await t.api.post('/api/affiliates/programs', { name: 'Partner', commission_value: 150 })).status).toBe(400);
    program = (await t.api.post('/api/affiliates/programs', { name: 'Partner 2026', commission_type: 'percent', commission_value: 20, attribution: 'last', cookie_days: 30, payout_threshold_cents: 3000 })).data;
    expect(program).toMatchObject({ slug: 'partner-2026', commission_value: 20, recurring: 0, portal_url: 'http://localhost/affiliate/partner-2026', signup_url: 'http://localhost/affiliate/partner-2026/join' });
    const r = await t.api.post('/api/affiliates', { program_id: program.id, name: 'Anna Partner', email: 'Anna@Partner.de', iban: 'DE89 3704 0044 0532 0130 00' });
    anna = r.data;
    expect(anna).toMatchObject({ code: 'annapartner', status: 'active', email: 'anna@partner.de', iban: 'DE89370400440532013000', clicks: 0, leads: 0 });
    expect(anna.link).toBe(`http://localhost/p/${funnel.slug}?ref=annapartner`);
    await t.app.events.flush();
    const created = events.find((e) => e.type === 'affiliate.created');
    expect(created?.data).toMatchObject({ affiliateId: anna.id, contactId: anna.contact_id, affiliate: { code: 'annapartner' } });
    expect((await t.api.get(`/api/contacts/${anna.contact_id}`)).data.tags).toContain('affiliate');
    expect((await t.api.post('/api/affiliates', { program_id: program.id, email: 'anna@partner.de' })).status).toBe(400);
    expect((await t.api.post('/api/affiliates', { program_id: program.id, email: 'x@y.de', code: 'annapartner' })).status).toBe(400);
    expect((await t.api.post('/api/affiliates', { program_id: program.id, email: 'x@y.de', iban: 'DE00123' })).status).toBe(400);
    expect((await t.api.get('/api/workflows/meta')).data.triggers).toEqual(expect.arrayContaining(['affiliate.created', 'affiliate.commission_created']));
  });

  it('counts clicks once per visitor and day', async () => {
    const v1 = await visit(`/p/${funnel.slug}?ref=annapartner`);
    expect(v1.token).not.toBe('');
    await visit(`/p/${funnel.slug}?ref=annapartner`, { 'user-agent': 'Other Browser' });
    const clicks = t.app.db.all('SELECT counted, reason FROM affiliate_clicks WHERE affiliate_id = ? ORDER BY created_at, rowid', anna.id);
    expect(clicks.map((c) => [c.counted, c.reason])).toEqual([
      [1, ''],
      [0, 'duplicate'],
    ]);
    // Unknown or blocked codes are no clicks.
    await visit(`/p/${funnel.slug}?ref=nobody`);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM affiliate_clicks').n).toBe(2);
  });

  it('a lead from the affiliate link becomes a referral; sales earn commission', async () => {
    const v = await visit(`/p/${funnel.slug}?ref=annapartner`);
    const lead = await submit({ first_name: 'Kim', email: 'kim@kunde.de', consent: 'ja', _attr: v.token });
    expect(t.app.db.get('SELECT affiliate_id FROM affiliate_referrals WHERE contact_id = ?', lead.contactId)?.affiliate_id).toBe(anna.id);
    const inv = await paidInvoice(lead.contactId, 10000);
    const list = await commissions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ invoice_id: inv.id, kind: 'sale', base_cents: 10000, amount_cents: 2000, status: 'pending', affiliate_name: 'Anna Partner' });
    const ev = events.find((e) => e.type === 'affiliate.commission_created');
    expect(ev?.data).toMatchObject({ contactId: anna.contact_id, amount_cents: 2000, customerId: lead.contactId, invoiceId: inv.id });
    // The same invoice never pays twice (invoice.paid and product.purchased both arrive for shop sales).
    t.app.events.emit(loc, 'invoice.paid', { contactId: lead.contactId, invoice: inv });
    await t.app.events.flush();
    expect(await commissions()).toHaveLength(1);
    const a = (await t.api.get('/api/affiliates')).data.find((x: any) => x.id === anna.id);
    expect(a).toMatchObject({ clicks: 1, leads: 1, sales: 1, revenue_cents: 10000, pending_cents: 2000 });
  });

  it('blocks self-referrals', async () => {
    const v = await visit(`/p/${funnel.slug}?ref=annapartner`, { 'user-agent': 'Self' });
    const r = await submit({ first_name: 'Anna', email: 'anna@partner.de', consent: 'ja', _attr: v.token });
    expect(r.contactId).toBe(anna.contact_id);
    expect(t.app.db.get('SELECT 1 AS x FROM affiliate_referrals WHERE contact_id = ?', anna.contact_id)).toBeUndefined();
    await paidInvoice(anna.contact_id, 50000);
    expect(await commissions()).toHaveLength(1);
    const acts = t.app.db.all("SELECT type FROM activities WHERE contact_id = ? AND type = 'affiliate.self_referral'", anna.contact_id);
    expect(acts.length).toBeGreaterThan(0);
  });

  it('recurring commission only when the program says so', async () => {
    const kim = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'kim@kunde.de').id;
    const renew = async () => {
      const inv = (await t.api.post('/api/invoices', { contact_id: kim, items: [{ name: 'Abo', qty: 1, price_cents: 5000, tax_rate: 19 }] })).data;
      t.app.db.run(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`, new Date().toISOString(), inv.id);
      t.app.events.emit(loc, 'invoice.paid', { contactId: kim, invoice: { ...inv, status: 'paid' }, via: 'Stripe-Abo' });
      await t.app.events.flush();
      return inv;
    };
    await renew();
    expect(await commissions()).toHaveLength(1);
    await t.api.patch(`/api/affiliates/programs/${program.id}`, { recurring: true });
    const inv = await renew();
    const c = (await commissions()).find((x) => x.invoice_id === inv.id);
    expect(c).toMatchObject({ kind: 'recurring', amount_cents: 1000 });
  });

  it('buy links: ?ref= on the buy page carries through Stripe to the commission', async () => {
    await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
    const prod = (await t.api.post('/api/products', { name: 'Masterclass', price_cents: 20000, tax_rate: 19 })).data;
    const page = await visit(`/buy/${prod.id}?ref=annapartner&utm_source=partner`, { 'user-agent': 'Buyer' });
    expect(page.token).not.toBe('');
    const go = await t.api.raw(`/buy/${prod.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...ua }, body: `_a=${encodeURIComponent(page.token)}` });
    expect(go.status).toBe(303);
    const sid = go.headers.get('location')!.split('/').pop()!;
    const session = { ...sessions.get(sid), status: 'complete', payment_status: 'paid', payment_intent: 'pi_master', customer_details: { email: 'lea@kunde.de', name: 'Lea Kauf' } };
    const r = await stripeHook({ id: 'evt_m1', type: 'checkout.session.completed', data: { object: session } });
    expect(r.handled).toBe('product_purchased');
    const c = (await commissions()).find((x) => x.contact_id === r.contactId);
    expect(c).toMatchObject({ kind: 'sale', base_cents: 20000, amount_cents: 4000, status: 'pending' });
    const attr = (await t.api.get(`/api/contacts/${r.contactId}/attribution`)).data.summary;
    expect(attr).toMatchObject({ first_source: 'partner' });

    // Full refund through Stripe: the commission is reversed.
    const ref = await stripeHook({ id: 'evt_r1', type: 'charge.refunded', data: { object: { id: 'ch_1', payment_intent: 'pi_master', amount_refunded: 23800, refunded: true, currency: 'eur' } } });
    expect(ref.handled).toBe('refunded');
    expect((await commissions()).find((x) => x.id === c.id)).toMatchObject({ status: 'reversed' });
  });

  it('partial refunds shrink, voided invoices reverse', async () => {
    const kim = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'kim@kunde.de').id;
    const inv = await paidInvoice(kim, 20000);
    const c = (await commissions()).find((x) => x.invoice_id === inv.id);
    expect(c.amount_cents).toBe(4000);
    t.app.events.emit(loc, 'payment.refunded', { contactId: kim, invoiceId: inv.id, amount_cents: 11900, full: false });
    await t.app.events.flush();
    expect((await commissions()).find((x) => x.id === c.id).amount_cents).toBe(2000);
    // Cumulative: a second partial refund of 75 % in total leaves a quarter.
    t.app.events.emit(loc, 'payment.refunded', { contactId: kim, invoiceId: inv.id, amount_cents: 17850, full: false });
    await t.app.events.flush();
    expect((await commissions()).find((x) => x.id === c.id).amount_cents).toBe(1000);
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'void' });
    await t.app.tick();
    expect((await commissions()).find((x) => x.id === c.id).status).toBe('reversed');
  });
});

describe('approval and payouts', () => {
  it('approve → payout (threshold) → paid, with CSV and SEPA export', async () => {
    const pending = await commissions('?status=pending');
    expect(pending.length).toBeGreaterThan(0);
    const before = pending.reduce((n, c) => n + c.amount_cents, 0);
    expect((await t.api.post('/api/affiliates/commissions/approve', { ids: pending.map((c) => c.id) })).data.approved).toBe(pending.length);
    // A second affiliate below the threshold is skipped.
    const ben = (await t.api.post('/api/affiliates', { program_id: program.id, name: 'Ben', email: 'ben@partner.de', payout_method: 'paypal', paypal_email: 'ben@pp.de' })).data;
    await t.api.post('/api/affiliates/commissions', { affiliate_id: ben.id, amount_cents: 500, note: 'Bonus' });
    const r = (await t.api.post('/api/affiliates/payouts', {})).data;
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({ affiliate_id: anna.id, amount_cents: before, method: 'sepa', status: 'open' });
    expect(r.skipped).toEqual([{ affiliate: 'Ben', balance_cents: 500, threshold_cents: 3000 }]);
    // Commissions in an open payout cannot be reversed one by one.
    const inPayout = (await commissions('?status=approved')).find((c) => c.payout_id);
    expect((await t.api.post(`/api/affiliates/commissions/${inPayout.id}/reverse`, {})).status).toBe(400);

    const csv = await (await t.api.raw(`/api/affiliates/payouts/export.csv?locationId=${loc}`, { headers: { cookie: t.api.cookie } })).text();
    expect(csv).toContain('Anna Partner,anna@partner.de,SEPA,DE89370400440532013000');
    expect((await t.api.get('/api/affiliates/payouts/sepa.xml')).status).toBe(400);
    const l = t.app.location(loc)!;
    t.app.db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify({ ...l.settings, invoices: { ...(l.settings.invoices ?? {}), iban: 'AT611904300234573201', bic: 'BKAUATWW' } }), loc);
    const xml = await (await t.api.raw(`/api/affiliates/payouts/sepa.xml?locationId=${loc}`, { headers: { cookie: t.api.cookie } })).text();
    expect(xml).toContain('urn:iso:std:iso:20022:tech:xsd:pain.001.001.03');
    expect(xml).toContain('<NbOfTxs>1</NbOfTxs>');
    expect(xml).toContain(`<InstdAmt Ccy="EUR">${(before / 100).toFixed(2)}</InstdAmt>`);
    expect(xml).toContain('<IBAN>DE89370400440532013000</IBAN>');
    expect(xml).toContain('<IBAN>AT611904300234573201</IBAN>');

    const paid = (await t.api.post(`/api/affiliates/payouts/${r.created[0].id}/paid`, {})).data;
    expect(paid.status).toBe('paid');
    expect((await commissions('?status=paid')).length).toBe(pending.length);
    const a = (await t.api.get('/api/affiliates')).data.find((x: any) => x.id === anna.id);
    expect(a.paid_cents).toBe(before);
    expect((await t.api.get('/api/affiliates/overview')).data).toMatchObject({ paid_cents: before, affiliates: 2 });
  });

  it('a refund after payout books a negative clawback for the next payout', async () => {
    const paid = (await commissions('?status=paid')).find((c) => c.kind === 'sale');
    t.app.events.emit(loc, 'payment.refunded', { invoiceId: paid.invoice_id, full: true });
    await t.app.events.flush();
    const cb = (await commissions()).find((c) => c.reversal_of === paid.id);
    expect(cb).toMatchObject({ kind: 'clawback', amount_cents: -paid.amount_cents, status: 'approved' });
  });

  it('pure export helpers', () => {
    const line = { id: 'p1', name: 'Jörg', email: 'j@x.de', iban: 'DE89370400440532013000', bic: '', paypal: '', method: 'sepa', amount_cents: 1234, currency: 'EUR', reference: 'Provision 2026-10' };
    expect(payoutCsv([line])).toBe('Name,E-Mail,Methode,IBAN,BIC,PayPal,Betrag,Währung,Verwendungszweck\r\nJörg,j@x.de,SEPA,DE89370400440532013000,,,"12,34",EUR,Provision 2026-10');
    const xml = sepaXml({ name: 'Firma Müller', iban: 'AT611904300234573201' }, [line, { ...line, id: 'p2', iban: 'DE00' }], { msgId: 'M1', executionDate: '2026-10-05', at: new Date('2026-10-04T10:00:00Z') });
    expect(xml).toContain('<CtrlSum>12.34</CtrlSum>');
    expect(xml).toContain('<Nm>Firma Mueller</Nm>');
    expect(xml).toContain('<Cdtr><Nm>Joerg</Nm></Cdtr>');
    expect(xml.match(/<CdtTrfTxInf>/g)).toHaveLength(1);
  });
});

describe('affiliate portal', () => {
  const portal = (p: string, init: RequestInit = {}) => t.api.raw(`/affiliate/${program.slug}${p}`, { redirect: 'manual', ...init });
  const form = (body: Record<string, string>, cookie = '') => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(body).toString() });

  it('public sign-up creates a pending affiliate', async () => {
    const page = await (await portal('/join')).text();
    expect(page).toContain('Partner werden');
    expect(page).toContain('20 % Provision vom Nettoumsatz');
    expect((await portal('/join', form({ name: 'Nora', email: 'nora@web.de' }))).status).toBe(400);
    const r = await portal('/join', form({ name: 'Nora Neu', email: 'nora@web.de', accept: '1' }));
    expect(await r.text()).toContain('Wir prüfen sie');
    const nora = t.app.db.get('SELECT * FROM affiliates WHERE email = ?', 'nora@web.de');
    expect(nora).toMatchObject({ status: 'pending', source: 'signup', code: 'noraneu' });
    // Honeypot: bots get a friendly page, nothing is stored.
    await portal('/join', form({ name: 'Bot', email: 'bot@spam.de', accept: '1', website: 'http://spam' }));
    expect(t.app.db.get('SELECT 1 AS x FROM affiliates WHERE email = ?', 'bot@spam.de')).toBeUndefined();
    // Foreign origins cannot post the form.
    expect((await portal('/join', { ...form({ name: 'X', email: 'x@x.de', accept: '1' }), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } })).status).toBe(403);
  });

  it('magic-link login shows the dashboard with own cookie', async () => {
    const login = await portal('/login', form({ email: 'anna@partner.de' }));
    expect(await login.text()).toContain('kommt gleich ein Login-Link');
    const mail = mails.find((m) => m.to === 'anna@partner.de')!;
    const link = mail.text.match(/http:\/\/localhost(\/affiliate\/\S+)/)![1];
    const tokenValue = new URL(`http://x${link}`).searchParams.get('token')!;
    expect(await (await t.api.raw(link)).text()).toContain('Jetzt anmelden');
    const auth = await portal('/auth', form({ token: tokenValue }));
    expect(auth.status).toBe(303);
    const cookie = auth.headers.getSetCookie()[0].split(';')[0];
    expect(cookie).toMatch(new RegExp(`^pa_${program.id}=`));
    // Single use.
    expect((await portal('/auth', form({ token: tokenValue }))).status).toBe(400);
    const dash = await (await portal('', { headers: { cookie } })).text();
    expect(dash).toContain('Dein Link');
    expect(dash).toContain(`?ref=annapartner`);
    expect(dash).toContain('Ausgezahlt');
    expect(dash).not.toContain('kim@kunde.de');
    // Payout details: invalid IBAN refused, valid saved.
    expect(await (await portal('/settings', form({ payout_method: 'sepa', iban: 'DE00 1234' }, cookie))).text()).toContain('IBAN ist ungültig');
    await portal('/settings', form({ payout_method: 'paypal', iban: '', paypal_email: 'Anna@PP.de' }, cookie));
    expect(t.app.db.get('SELECT payout_method, paypal_email FROM affiliates WHERE id = ?', anna.id)).toEqual({ payout_method: 'paypal', paypal_email: 'anna@pp.de' });
    // The admin cookie is no partner session and vice versa.
    expect(await (await portal('', { headers: { cookie: t.api.cookie } })).text()).toContain('Login-Link senden');
    expect((await t.api.raw('/api/affiliates', { headers: { cookie } })).status).toBe(401);
    // Clicks from the partner's own connection do not count.
    const before = t.app.db.get('SELECT COUNT(*) AS n FROM affiliate_clicks WHERE affiliate_id = ? AND counted = 1', anna.id).n;
    await visit(`/p/${funnel.slug}?ref=annapartner`, { 'user-agent': 'Brand new' });
    const last = t.app.db.get('SELECT counted, reason FROM affiliate_clicks WHERE affiliate_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', anna.id);
    expect(last).toEqual({ counted: 0, reason: 'self' });
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM affiliate_clicks WHERE affiliate_id = ? AND counted = 1', anna.id).n).toBe(before);
    await portal('/logout', form({}, cookie));
    expect(await (await portal('', { headers: { cookie } })).text()).toContain('Login-Link senden');
  });

  it('lists affiliates through MCP without bank details', async () => {
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_list_affiliates');
    const list = await tool.run({ api: (_m: string, path: string) => t.api.get(path).then((r) => r.data), agency: false }, { location_id: loc });
    expect(list.find((x: any) => x.code === 'annapartner')).toMatchObject({ name: 'Anna Partner' });
    expect(list[0].iban).toBeUndefined();
  });
});
