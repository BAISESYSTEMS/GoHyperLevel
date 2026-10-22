import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, browser, cloudKit, createStripe } from './cloud-fakes.js';

const stripe = createStripe();
let t: Awaited<ReturnType<typeof startTestApp>>;
const mails: { to: string; subject: string; text: string; html: string }[] = [];

beforeAll(async () => {
  stripe.install();
  t = await startTestApp({ cloudMode: true });
  await t.setup();
  t.app.services.cloudMailer = async (_loc: any, mail: any) => {
    mails.push(mail);
    return { status: 'logged' };
  };
  t.app.services.cloudFormMinMs = 0;
  const r = await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
});
afterAll(async () => {
  stripe.uninstall();
  await t.close();
});

const { hook, signUp, createCustomer, path, lastMail } = cloudKit(() => t, stripe, mails);
type Customer = Awaited<ReturnType<typeof createCustomer>>;
const cloud = () => t.app.services.cloud;
const sub = (c: Customer) => t.app.db.get('SELECT * FROM saas_subscriptions WHERE location_id = ?', c.loc);
const tenant = (c: Customer) => t.app.db.get('SELECT * FROM cloud_tenants WHERE id = ?', c.tenantId);

describe('cloud signup', () => {
  it('serves the public pages without cookies', async () => {
    const b = browser(t.base);
    for (const p of ['/cloud', '/start', '/cloud/legal/agb', '/cloud/legal/avv', '/cloud/legal/datenschutz', '/cloud/legal/impressum']) {
      const r = await b.get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('set-cookie'), p).toBeNull();
      expect(r.headers.get('content-security-policy'), p).toContain("default-src 'none'");
      expect(r.text).not.toMatch(/<script/i);
    }
    const pricing = (await b.get('/cloud')).text.replace(/\u00a0/g, ' ');
    for (const s of ['49,99 €', '99,99 €', '199 €', 'Cloud Team &amp; Company', 'Alle Funktionen in jedem Tarif', 'White-Label und Kunden-Accounts nur im Tarif Cloud Agentur', 'Keine Gebühr pro Nutzer', 'Selbst hosten: 0 €', 'zzgl. USt.', 'Stripe Tax'])
      expect(pricing, s).toContain(s);
    // yearly: 20 % off, rounded down to whole euros
    for (const s of ['479 € pro Jahr', '959 € pro Jahr', '1.910 € pro Jahr']) expect(pricing, s).toContain(s);
    // Cloud or self-hosted, fairly side by side – and no SaaS mode promised for the cloud.
    expect(pricing).toContain('Cloud oder selbst hosten?');
    expect(pricing).toContain('Inklusive SaaS-Modus');
    expect(pricing).toContain('in der Cloud nicht enthalten');
  });

  it('signs a customer up: form → verification → Checkout → webhook → tenant → login', async () => {
    const { b, link } = await signUp({ company: 'Muster GmbH', email: 'mia@muster.de', interval: 'year' });
    // The link is a button first (mail scanners open links), the click does the work.
    const confirm = await b.get(link);
    expect(confirm.status).toBe(200);
    expect(confirm.text).toContain('E-Mail bestätigen');
    const go = await b.form(link, {});
    expect(go.status).toBe(303);
    expect(go.location).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    const sid = go.location.split('/').pop()!;
    const s = stripe.store.sessions.get(sid);
    expect(s).toMatchObject({ mode: 'subscription', customer_email: 'mia@muster.de', trial: 14, automatic_tax: 'true', tax_id_collection: 'true', billing_address_collection: 'required' });
    expect(stripe.store.prices.get(s.price)).toMatchObject({ unit_amount: 95900, recurring: { interval: 'year' } });
    expect(s.metadata.cloud_signup_id).toBeTruthy();
    // Stripe: the customer paid; the webhook arrives before the customer is back.
    stripe.complete(sid);
    const wh = await hook(stripe.event('checkout.session.completed', { ...stripe.store.sessions.get(sid), subscription: stripe.store.subs.get(stripe.store.sessions.get(sid).subscription) }));
    expect(wh.data).toMatchObject({ received: true, handled: 'account_created' });
    // …and the same event twice changes nothing.
    expect((await hook(stripe.event('checkout.session.completed', stripe.store.sessions.get(sid)))).data.handled).toBe('duplicate');
    // Back from Stripe: the browser that verified is logged in and lands in the app.
    const back = await b.get(`/start/done?session_id=${sid}`);
    expect(back.status).toBe(303);
    expect(back.location).toBe('/app');
    const me = await b.api('GET', '/api/me');
    expect(me.data.user.email).toBe('mia@muster.de');
    expect(me.data.locations).toHaveLength(1);
    expect(me.data.locations[0].name).toBe('Muster GmbH');
    const cloud = await b.api('GET', '/api/cloud/me');
    expect(cloud.data).toMatchObject({ customer: true, role: 'owner', tenant: { name: 'Muster GmbH', plan: { key: 'team', interval: 'year' }, phase: 'trial', status: 'trialing', billing: 'stripe' } });
    expect(cloud.data.tenant.entitlements.users).toBeNull();
    // The versions of AGB, AVV and Datenschutz that were accepted are stored.
    const acc = t.app.db.all('SELECT doc, version FROM cloud_acceptances WHERE tenant_id = ?', cloud.data.tenant.id);
    expect(acc.map((a: any) => a.doc).sort()).toEqual(['agb', 'avv', 'datenschutz']);
    expect(lastMail('mia@muster.de', /Willkommen/)?.text).toContain('Muster GmbH');
    // The first sub-account has the pipeline and the starter templates.
    const h = { 'x-location-id': me.data.locations[0].id };
    expect((await b.api('GET', '/api/pipelines', undefined, h)).data.length).toBeGreaterThan(0);
    expect((await b.api('GET', '/api/templates', undefined, h)).data.length).toBe(3);
    // The password from the form is the login.
    const again = browser(t.base);
    expect((await again.api('POST', '/api/auth/login', { email: 'mia@muster.de', password: 'geheim1234' })).status).toBe(200);
  });
});

describe('abuse protection', () => {
  beforeEach(() => cloud().resetLimits());
  const form = async (over: Record<string, string> = {}, wait = false) => {
    const b = browser(t.base);
    const tok = /name="t" value="([^"]+)"/.exec((await b.get('/start')).text)![1];
    void wait;
    return b.form('/start', { plan: 'solo', interval: 'month', company: 'Spam GmbH', email: 'spam@firma.de', password: 'geheim1234', agb: '1', avv: '1', datenschutz: '1', business: '1', t: tok, via: 'email', ...over });
  };
  const before = () => mails.length;

  it('answers a filled honeypot like a success and does nothing', async () => {
    const n = before();
    const r = await form({ website: 'http://spam.example', email: 'bot@firma.de' });
    expect(r.status).toBe(200);
    expect(mails.length).toBe(n);
    expect(t.app.db.get(`SELECT 1 AS x FROM cloud_signups WHERE email = 'bot@firma.de'`)).toBeUndefined();
  });

  it('rejects a form that was sent too fast or with a forged time token', async () => {
    t.app.services.cloudFormMinMs = 60_000;
    expect((await form({ email: 'fast@firma.de' })).data).toContain('zu schnell');
    t.app.services.cloudFormMinMs = 0;
    const r = await form({ t: `${Date.now() - 10_000}.${'0'.repeat(32)}`, email: 'forged@firma.de' });
    expect(r.status).toBe(400);
    expect(t.app.db.get(`SELECT 1 AS x FROM cloud_signups WHERE email = 'forged@firma.de'`)).toBeUndefined();
    // The empty form sent at once names the missing fields first; the time check only meets submissions that would sign up.
    t.app.services.cloudFormMinMs = 60_000;
    try {
      const n = before();
      const empty = await form({ company: '', name: '', email: '', password: '', agb: '', avv: '', datenschutz: '' });
      expect(empty.status).toBe(400);
      expect(empty.data).toContain('Firmennamen');
      expect(empty.data).not.toContain('zu schnell');
      expect((await form({ email: 'halb@firma.de', password: '' })).data).toContain('Passwort');
      expect((await form({ email: 'eilig@firma.de' })).data).toContain('zu schnell');
      expect((await form({ email: 'eilig@firma.de', via: 'google' })).data).toContain('zu schnell');
      expect(mails.length).toBe(n);
      expect(t.app.db.get(`SELECT 1 AS x FROM cloud_signups WHERE email IN ('halb@firma.de', 'eilig@firma.de')`)).toBeUndefined();
    } finally {
      t.app.services.cloudFormMinMs = 0;
    }
  });

  it('blocks disposable addresses (built-in list plus the operator\'s own) and weak input', async () => {
    expect((await form({ email: 'x@mailinator.com' })).data).toContain('Wegwerf');
    expect((await form({ email: 'x@sub.yopmail.com' })).data).toContain('Wegwerf');
    expect((await t.api.put('/api/cloud/console/settings', { extra_blocked_domains: 'wegwerf-firma.de' })).status).toBe(200);
    expect((await form({ email: 'x@wegwerf-firma.de' })).data).toContain('Wegwerf');
    expect((await t.api.put('/api/cloud/console/settings', { block_disposable: false })).status).toBe(200);
    const open = await form({ email: 'okay@mailinator.com' });
    expect(open.status).toBe(200);
    await t.api.put('/api/cloud/console/settings', { block_disposable: true });
    expect((await form({ email: 'kurz@firma.de', password: 'kurz' })).data).toContain('Passwort');
    expect((await form({ email: 'nolaw@firma.de', agb: '' })).data).toContain('AGB');
    expect((await form({ email: 'noco@firma.de', company: '' })).data).toContain('Firmennamen');
  });

  it('does not tell whether an address has an account', async () => {
    const n = before();
    const known = await form({ email: 'mia@muster.de' });
    const fresh = await form({ email: 'neu@firma.de' });
    expect(known.status).toBe(fresh.status);
    expect(known.text.replace(/<[^>]*>/g, '').trim().length).toBeGreaterThan(50);
    expect(known.text).toBe(fresh.text);
    expect(mails.slice(n).map((m) => `${m.to}:${/schon ein Konto/.test(m.subject) ? 'exists' : 'verify'}`).sort()).toEqual(['mia@muster.de:exists', 'neu@firma.de:verify']);
  });

  it('limits signups per address and per mail', async () => {
    t.app.db.run(`UPDATE agency_settings SET value = json_set(value, '$.signups_per_ip_hour', 3) WHERE key = 'cloud'`);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await form({ email: `flood${i}@firma.de` })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
    // a mail address gets at most three verification mails an hour
    const n = before();
    t.app.db.run(`UPDATE agency_settings SET value = json_set(value, '$.signups_per_ip_hour', 100) WHERE key = 'cloud'`);
    for (let i = 0; i < 5; i++) await form({ email: 'mailbomb@firma.de' });
    expect(mails.slice(n).filter((m) => m.to === 'mailbomb@firma.de').length).toBe(3);
  });
});

const DAY = 864e5;
const setting = (patch: Record<string, unknown>) => t.api.put('/api/cloud/console/settings', patch);

describe('trial without a card', () => {
  it('starts at once, runs out into read-only, can be extended by the operator', async () => {
    expect((await setting({ card_required: false })).status).toBe(200);
    cloud().resetLimits();
    const { b, link } = await signUp({ plan: 'solo', company: 'Ohne Karte', email: 'ok@ohnekarte.de', name: 'Olli' });
    const calls = stripe.calls.length;
    const go = await b.form(link, {});
    // No Stripe at all: the account exists, the browser is on its way into the app.
    expect(go.status).toBe(303);
    expect(go.location).toMatch(/^\/start\/done\?s=/);
    expect(stripe.calls.length).toBe(calls);
    const back = await b.get(go.location);
    expect(back.location).toBe('/app');
    const me = (await b.api('GET', '/api/cloud/me')).data;
    expect(me.tenant).toMatchObject({ phase: 'trial', billing: 'manual', stripe: false, plan: { key: 'solo' } });
    expect(new Date(me.tenant.trial_end).getTime()).toBeGreaterThan(Date.now() + 13 * DAY);
    const c = { b, loc: me.tenant.location_id as string, tenantId: me.tenant.id as string, h: { 'x-location-id': me.tenant.location_id as string } } as Customer;
    // The banner for a trial without payment data does not promise an automatic renewal.
    t.app.db.run('UPDATE saas_subscriptions SET trial_end = ? WHERE location_id = ?', new Date(Date.now() + 2 * DAY).toISOString(), c.loc);
    const banner = (await b.api('GET', '/api/saas/account', undefined, c.h)).data.banner;
    expect(banner.text).toMatch(/schreibgeschützt/);
    expect(banner.text).not.toMatch(/automatisch weiter/);
    // Three days before the end the customer is reminded once.
    await cloud().reconcile();
    await cloud().reconcile();
    expect(mails.filter((m) => m.to === 'ok@ohnekarte.de' && /Testphase endet/.test(m.subject))).toHaveLength(1);
    expect((await b.api('POST', '/api/contacts', { email: 'a@b.de', first_name: 'A' }, c.h)).status).toBe(200);
    // The trial ends: read-only, nothing is overdue.
    await cloud().reconcile(new Date(Date.now() + 3 * DAY));
    expect(sub(c).status).toBe('paused');
    expect((await b.api('GET', '/api/contacts', undefined, c.h)).status).toBe(200);
    const blocked = await b.api('POST', '/api/contacts', { email: 'c@d.de', first_name: 'C' }, c.h);
    expect(blocked.status).toBe(403);
    expect(blocked.data.error).toMatch(/pausiert|schreibgeschützt/);
    expect((await b.api('GET', '/api/saas/account', undefined, c.h)).data.banner.text).toMatch(/Testphase ist abgelaufen/);
    expect(lastMail('ok@ohnekarte.de', /abgelaufen/)).toBeTruthy();
    expect(t.app.db.get(`SELECT 1 AS x FROM cloud_events WHERE tenant_id = ? AND type = 'trial_expired'`, c.tenantId)).toBeTruthy();
    // The operator extends the trial: writing works again, the clock restarts.
    const ext = await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/extend-trial`, { days: 7 });
    expect(ext.status, JSON.stringify(ext.data)).toBe(200);
    expect(ext.data).toMatchObject({ phase: 'trial', read_only: false });
    expect((await b.api('POST', '/api/contacts', { email: 'e@f.de', first_name: 'E' }, c.h)).status).toBe(200);
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/extend-trial`, { days: 500 })).status).toBe(400);
    await setting({ card_required: true });
  });

  it('pays after the trial: Checkout carries what is left of it, then the subscription takes over', async () => {
    await setting({ card_required: false });
    cloud().resetLimits();
    const { b, link } = await signUp({ plan: 'team', company: 'Spaeter Zahler', email: 'z@spaeter.de' });
    await b.get((await b.form(link, {})).location);
    const me = (await b.api('GET', '/api/cloud/me')).data;
    const h = { 'x-location-id': me.tenant.location_id };
    const r = await b.api('POST', '/api/cloud/subscribe', { plan: 'team', interval: 'month' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const s = stripe.store.sessions.get(r.data.id);
    expect(s.metadata).toMatchObject({ saas_location_id: me.tenant.location_id, cloud_tenant_id: me.tenant.id });
    expect(s.trial_end).toBeGreaterThan(Date.now() / 1000 + 12 * 86400);
    // Stripe confirms; the customer may arrive first or second – both end in the same state.
    const { sub: st } = stripe.complete(r.data.id, { status: 'trialing' });
    const conf = await b.api('POST', '/api/cloud/subscribe/confirm', { session_id: r.data.id });
    expect(conf.data).toMatchObject({ billing: 'stripe', stripe: true, status: 'trialing' });
    const wh = await hook(stripe.event('checkout.session.completed', { ...stripe.store.sessions.get(r.data.id), subscription: st }));
    expect(wh.data.handled).toBe('duplicate');
    expect((await b.api('GET', '/api/cloud/me')).data.tenant.billing).toBe('stripe');
    void h;
    await setting({ card_required: true });
  });
});

describe('payment failed → read-only → deletion', () => {
  it('runs the whole dunning clock and stops it when the customer pays', async () => {
    const c = await createCustomer({ plan: 'solo', company: 'Zahlt Nicht', email: 'z@zahltnicht.de' });
    // Trial over, first payment went through: converted.
    const active = { ...c.sub, status: 'active', trial_end: null };
    stripe.store.subs.set(c.sub.id, active);
    await hook(stripe.event('customer.subscription.updated', active));
    expect((await c.b.api('GET', '/api/cloud/me')).data.tenant).toMatchObject({ phase: 'active' });
    expect(t.app.db.get(`SELECT 1 AS x FROM cloud_events WHERE tenant_id = ? AND type = 'trial_converted'`, c.tenantId)).toBeTruthy();
    expect(lastMail('z@zahltnicht.de', /Danke/)).toBeTruthy();
    // The next payment fails: banner, mail, still working.
    await hook(stripe.event('invoice.payment_failed', stripe.invoice(c.sub.customer, { subscription: c.sub.id, status: 'open' })));
    let me = (await c.b.api('GET', '/api/cloud/me')).data.tenant;
    expect(me).toMatchObject({ phase: 'past_due', read_only: false });
    expect((await c.b.api('GET', '/api/saas/account', undefined, c.h)).data.banner.text).toMatch(/Zahlung fehlgeschlagen/);
    expect(lastMail('z@zahltnicht.de', /Zahlung fehlgeschlagen/)?.text).toMatch(/Zahlungsmethode/);
    expect((await c.b.api('POST', '/api/contacts', { email: 'x@y.de', first_name: 'X' }, c.h)).status).toBe(200);
    // Reminders: after three days, then the last one before the grace period ends – each once.
    const pastDue = new Date(sub(c).past_due_since).getTime();
    await cloud().reconcile(new Date(pastDue + 3.5 * DAY));
    await cloud().reconcile(new Date(pastDue + 3.6 * DAY));
    expect(mails.filter((m) => m.to === 'z@zahltnicht.de' && /Erinnerung: Zahlung offen/.test(m.subject))).toHaveLength(1);
    await cloud().reconcile(new Date(pastDue + 6.5 * DAY));
    expect(mails.filter((m) => m.to === 'z@zahltnicht.de' && /Letzte Erinnerung/.test(m.subject))).toHaveLength(1);
    // The grace period is over (the SaaS clock pauses the account) → read-only.
    t.app.db.run('UPDATE saas_subscriptions SET grace_until = ? WHERE location_id = ?', new Date(Date.now() - 1000).toISOString(), c.loc);
    await t.app.tick();
    await cloud().reconcile();
    me = (await c.b.api('GET', '/api/cloud/me')).data.tenant;
    expect(me).toMatchObject({ phase: 'read_only', read_only: true });
    expect(me.read_only_since).toBeTruthy();
    const w = await c.b.api('POST', '/api/contacts', { email: 'n@o.de', first_name: 'N' }, c.h);
    expect(w.status).toBe(403);
    expect((await c.b.api('GET', '/api/contacts', undefined, c.h)).status).toBe(200);
    expect(lastMail('z@zahltnicht.de', /schreibgeschützt/)).toBeTruthy();
    // Export stays possible in read-only mode.
    expect((await c.b.api('GET', '/api/cloud/export')).status).toBe(200);
    // Paying again clears everything.
    await hook(stripe.event('invoice.paid', stripe.invoice(c.sub.customer, { subscription: c.sub.id })));
    me = (await c.b.api('GET', '/api/cloud/me')).data.tenant;
    expect(me).toMatchObject({ phase: 'active', read_only: false });
    expect(tenant(c).read_only_since).toBeNull();
    expect((await c.b.api('POST', '/api/contacts', { email: 'p@q.de', first_name: 'P' }, c.h)).status).toBe(200);
  });

  it('offers the export and schedules the deletion after the retention time, then deletes', async () => {
    const c = await createCustomer({ plan: 'team', company: 'Loeschkandidat GmbH', email: 'l@loesch.de' });
    await c.b.api('POST', '/api/contacts', { email: 'kunde@loesch.de', first_name: 'Kunde', last_name: 'LEAKCHECK' }, c.h);
    const customerId = sub(c).stripe_customer;
    const readOnlyAt = new Date();
    await hook(stripe.event('invoice.payment_failed', stripe.invoice(customerId, { subscription: c.sub.id, status: 'open' })));
    t.app.db.run('UPDATE saas_subscriptions SET grace_until = ? WHERE location_id = ?', new Date(Date.now() - 1000).toISOString(), c.loc);
    await t.app.tick();
    await cloud().reconcile(readOnlyAt);
    expect(tenant(c).read_only_since).toBeTruthy();
    expect(tenant(c).deletion_at).toBeNull();
    // 29 days read-only: nothing scheduled yet; after 30 days the notice goes out with the export link.
    await cloud().reconcile(new Date(readOnlyAt.getTime() + 29 * DAY));
    expect(tenant(c).deletion_at).toBeNull();
    await cloud().reconcile(new Date(readOnlyAt.getTime() + 31 * DAY));
    expect(tenant(c).deletion_at).toBeTruthy();
    const mail = lastMail('l@loesch.de', /gelöscht/)!;
    expect(mail.text).toMatch(/exportieren/);
    expect((await c.b.api('GET', '/api/cloud/me')).data.tenant).toMatchObject({ phase: 'deletion_scheduled' });
    expect((await t.api.get('/api/cloud/console/overview')).data.counts.deletion_scheduled).toBeGreaterThanOrEqual(1);
    // The notice period passes: everything is gone, only a tombstone without personal data is left.
    await cloud().reconcile(new Date(readOnlyAt.getTime() + 31 * DAY + 15 * DAY));
    expect(t.app.db.get('SELECT 1 AS x FROM locations WHERE id = ?', c.loc)).toBeUndefined();
    expect(t.app.db.get(`SELECT 1 AS x FROM users WHERE email = 'l@loesch.de'`)).toBeUndefined();
    expect(t.app.db.get(`SELECT 1 AS x FROM contacts WHERE location_id = ?`, c.loc)).toBeUndefined();
    const tomb = t.app.db.get('SELECT * FROM cloud_tenants WHERE id = ?', c.tenantId);
    expect(tomb).toMatchObject({ name: '', email: '', owner_user_id: null });
    expect(tomb.deleted_at).toBeTruthy();
    expect(stripe.store.subs.get(c.sub.id).status).toBe('canceled');
    expect((await c.b.api('GET', '/api/me')).status).toBe(401);
    expect(JSON.stringify(t.app.db.all('SELECT * FROM cloud_events WHERE tenant_id = ?', c.tenantId))).not.toMatch(/loesch|Loeschkandidat/i);
  });
});

describe('plans, users and fair use', () => {
  it('upgrades and downgrades with proration and keeps the limits of each plan', async () => {
    const c = await createCustomer({ plan: 'solo', company: 'Wechsler Solo', email: 'w@wechsler.de' });
    // Solo is one person: no invitation, and the operator's own user route obeys the same limit.
    const noInvite = await c.b.api('POST', '/api/cloud/team', { email: 'kollege@wechsler.de', name: 'Kollege' });
    expect(noInvite.status).toBe(403);
    expect(noInvite.data.error).toMatch(/Cloud Team/);
    // Upgrade to Team (yearly): the Stripe subscription is switched with proration.
    const up = await c.b.api('POST', '/api/cloud/plan', { plan: 'team', interval: 'year' });
    expect(up.status, JSON.stringify(up.data)).toBe(200);
    expect(up.data).toMatchObject({ plan: { key: 'team', interval: 'year' }, entitlements: { users: null } });
    const change = stripe.called('POST', `/v1/subscriptions/${c.sub.id}`).find((x) => x.params.has('items[0][price]'))!;
    expect(change.params.get('proration_behavior')).toBe('create_prorations');
    expect(stripe.store.prices.get(change.params.get('items[0][price]')!)).toMatchObject({ unit_amount: 95900, recurring: { interval: 'year' } });
    expect(stripe.store.subs.get(c.sub.id).items.data[0].price.id).toBe(change.params.get('items[0][price]'));
    expect(sub(c).plan_id).toBe('cloud-team');
    // Team: unlimited users – invite two, they get an invitation mail with a link that sets the password.
    for (const [email, name] of [['kollege@wechsler.de', 'Kollege'], ['kollegin@wechsler.de', 'Kollegin']]) {
      const r = await c.b.api('POST', '/api/cloud/team', { email, name });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      expect(r.data).toMatchObject({ email, role: 'member', invited: true });
    }
    const invite = path(/(https?:\/\/\S+\/invite\/\S+)/.exec(lastMail('kollege@wechsler.de', /eingeladen/)!.text)![1]);
    const guest = browser(t.base);
    expect((await guest.form(invite, { password: 'neues-passwort1', password2: 'neues-passwort1' })).location).toBe('/app');
    expect((await guest.api('GET', '/api/me')).data.locations).toHaveLength(1);
    expect((await guest.api('GET', '/api/cloud/me')).data).toMatchObject({ customer: true, role: 'member' });
    // A member does not manage billing or people.
    expect((await guest.api('POST', '/api/cloud/plan', { plan: 'solo' })).status).toBe(403);
    expect((await guest.api('POST', '/api/cloud/team', { email: 'x@y.de' })).status).toBe(403);
    expect((await guest.api('POST', '/api/cloud/cancel', {})).status).toBe(403);
    expect((await guest.api('GET', '/api/cloud/export')).status).toBe(403);
    // Downgrade to Solo is refused while there are three people; after removing them it works.
    const refused = await c.b.api('POST', '/api/cloud/plan', { plan: 'solo' });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/1 Nutzer|für 1/);
    const team = (await c.b.api('GET', '/api/cloud/team')).data;
    expect(team.members).toHaveLength(3);
    for (const m of team.members.filter((x: any) => x.role !== 'owner')) expect((await c.b.api('DELETE', `/api/cloud/team/${m.id}`)).status).toBe(200);
    const down = await c.b.api('POST', '/api/cloud/plan', { plan: 'solo', interval: 'month' });
    expect(down.data).toMatchObject({ plan: { key: 'solo', interval: 'month' } });
    expect(sub(c).plan_id).toBe('cloud-solo');
    // The removed colleague is gone.
    expect((await guest.api('GET', '/api/me')).status).toBe(401);
    // Unknown plans and a read-only account are refused.
    expect((await c.b.api('POST', '/api/cloud/plan', { plan: 'enterprise' })).status).toBe(400);
  });

  it('meters the fair-use limits and shows them; storage and e-mails stop at the limit with a clear message', async () => {
    const c = await createCustomer({ plan: 'solo', company: 'Fair Use GmbH', email: 'f@fair.de' });
    const me = (await c.b.api('GET', '/api/cloud/me')).data.tenant;
    expect(me.meters).toMatchObject({ emails: { limit: 10000, overage: 'block' }, sms: { limit: 0, overage: 'bill' }, ai: { limit: 300 }, storage_mb: { limit: 5000 } });
    // The operator lowers the limits: e-mails and uploads stop, the contacts (no contact tiers) do not.
    await setting({ fair_use: { solo: { emails: 2, storage_mb: 0 } } });
    expect((await c.b.api('GET', '/api/cloud/me')).data.tenant.meters.emails.limit).toBe(2);
    const ct = (await c.b.api('POST', '/api/contacts', { email: 'k@kunde.de', first_name: 'K' }, c.h)).data;
    const gate = (kind: string) => t.app.services.usageGate(c.loc, kind);
    expect(gate('email')).toBeUndefined();
    expect(gate('email')).toBeUndefined();
    expect(gate('email')).toMatch(/Limit erreicht/);
    expect((await c.b.api('GET', '/api/cloud/me')).data.tenant.meters.emails.used).toBe(2);
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await c.b.api('POST', '/api/uploads', { name: 'a.png', data: png }, c.h);
    expect(up.status).toBe(403);
    expect(up.data.error).toMatch(/Speicher-Limit/);
    await setting({ fair_use: { solo: { emails: 10000, storage_mb: 5000 } } });
    expect((await c.b.api('POST', '/api/uploads', { name: 'a.png', data: png }, c.h)).status).toBe(200);
    // Unlimited contacts: the plans carry no contact limit at all.
    expect(ct.id).toBeTruthy();
    for (const k of ['cloud-solo', 'cloud-team', 'cloud-agency']) expect(JSON.parse(t.app.db.get('SELECT limits FROM saas_plans WHERE id = ?', k).limits).contacts).toBeUndefined();
    // Every plan includes every area: nothing is locked.
    for (const k of ['cloud-solo', 'cloud-team', 'cloud-agency']) expect(JSON.parse(t.app.db.get('SELECT features FROM saas_plans WHERE id = ?', k).features).length).toBeGreaterThanOrEqual(20);
    expect((await c.b.api('GET', '/api/campaigns', undefined, c.h)).status).toBe(200);
    expect((await c.b.api('GET', '/api/accounting/entries', undefined, c.h)).status).not.toBe(403);
  });

  it('cancels with a reason (taken back at will), sends the cancel at period end to Stripe', async () => {
    const c = await createCustomer({ plan: 'team', company: 'Kuendiger GmbH', email: 'k@kuendiger.de' });
    const r = await c.b.api('POST', '/api/cloud/cancel', { reason: 'price', comment: 'zu teuer für mich' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.cancel_at_period_end).toBe(true);
    const call = stripe.called('POST', `/v1/subscriptions/${c.sub.id}`).find((x) => x.params.get('cancel_at_period_end') === 'true')!;
    expect(call.params.get('cancellation_details[feedback]')).toBe('too_expensive');
    expect(tenant(c)).toMatchObject({ cancel_reason: 'price', cancel_comment: 'zu teuer für mich' });
    expect(lastMail('k@kuendiger.de', /Kündigung/)).toBeTruthy();
    expect((await c.b.api('GET', '/api/saas/account', undefined, c.h)).data.banner.text).toMatch(/endet am/);
    const undo = await c.b.api('POST', '/api/cloud/cancel', { undo: true });
    expect(undo.data.cancel_at_period_end).toBe(false);
    expect(tenant(c).cancel_reason).toBe('');
    // The invoice list comes from Stripe (and is kept), the portal link too.
    stripe.invoice(c.sub.customer, { number: 'RE-2026-0001', total: 7900 });
    const inv = (await c.b.api('GET', '/api/cloud/invoices')).data;
    expect(inv.items[0]).toMatchObject({ number: 'RE-2026-0001', amount_cents: 7900, currency: 'EUR' });
    expect(inv.items[0].pdf_url).toMatch(/^https:\/\/invoice\.stripe\.com/);
    expect((await c.b.api('POST', '/api/cloud/portal', {})).data.url).toMatch(/^https:\/\/billing\.stripe\.com/);
  });
});

describe('export, deletion and support access', () => {
  it('exports everything as a ZIP without credentials; deletion is confirmed, scheduled and can be undone', async () => {
    const c = await createCustomer({ plan: 'solo', company: 'Export GmbH', email: 'e@export.de', password: 'export-passwort1' });
    await c.b.api('POST', '/api/contacts', { email: 'kontakt@kunde.de', first_name: 'Erika', last_name: 'Exportiert', company: 'ACME' }, c.h);
    await c.b.api('POST', '/api/api-keys', { name: 'Schlüssel' }, c.h);
    await c.b.api('PATCH', '/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.example.com', user: 'u', pass: 'geheimes-smtp-passwort' } } }, c.h);
    const r = await t.api.raw('/api/cloud/export', { headers: { cookie: `pghl_session=${c.b.cookie('pghl_session')}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await r.arrayBuffer());
    const { readZip } = await import('../server/services/umzug-zip.js');
    const files = readZip(zip);
    const names = files.map((f: any) => f.name);
    expect(names).toEqual(expect.arrayContaining(['manifest.json', 'LIESMICH.txt', 'contacts.json', 'contacts.csv', 'team.json']));
    const text = files.map((f: any) => f.data.toString('utf8')).join('\n');
    expect(text).toContain('Exportiert');
    expect(text).not.toContain('geheimes-smtp-passwort');
    expect(text).not.toMatch(/pghl_[A-Za-z0-9]{20}/);
    expect(text).not.toMatch(/scrypt\$/);
    // Deleting needs the company name and the password.
    expect((await c.b.api('POST', '/api/cloud/delete', { confirm: 'falsch', password: 'export-passwort1' })).status).toBe(400);
    expect((await c.b.api('POST', '/api/cloud/delete', { confirm: 'Export GmbH', password: 'falsch-falsch' })).data.error).toMatch(/Passwort/);
    const del = await c.b.api('POST', '/api/cloud/delete', { confirm: 'Export GmbH', password: 'export-passwort1' });
    expect(del.status, JSON.stringify(del.data)).toBe(200);
    expect(del.data).toMatchObject({ phase: 'deletion_scheduled', read_only: true, deletion: { reason: 'self' } });
    expect(stripe.store.subs.get(c.sub.id).status).toBe('canceled');
    expect(new Date(del.data.deletion.at).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(lastMail('e@export.de', /gelöscht/)).toBeTruthy();
    // Still readable, no longer writable; the undo takes the schedule away.
    expect((await c.b.api('GET', '/api/contacts', undefined, c.h)).status).toBe(200);
    expect((await c.b.api('POST', '/api/contacts', { email: 'q@r.de', first_name: 'Q' }, c.h)).status).toBe(403);
    const undo = await c.b.api('POST', '/api/cloud/delete/undo', {});
    expect(undo.data.deletion).toBeNull();
    // Deleted for good the second time round, once the date has passed.
    await c.b.api('POST', '/api/cloud/delete', { confirm: 'Export GmbH', password: 'export-passwort1' });
    await cloud().reconcile(new Date(Date.now() + 8 * DAY));
    expect(t.app.db.get('SELECT 1 AS x FROM locations WHERE id = ?', c.loc)).toBeUndefined();
    expect(t.app.db.get(`SELECT 1 AS x FROM contacts WHERE email = 'kontakt@kunde.de'`)).toBeUndefined();
    expect(t.app.db.get(`SELECT 1 AS x FROM api_keys WHERE location_id = ?`, c.loc)).toBeUndefined();
    expect(lastMail('e@export.de', /wurde gelöscht/)).toBeTruthy();
  });

  it('lets the operator open a customer account only with consent, and logs every opening in the customer\'s log', async () => {
    const c = await createCustomer({ plan: 'team', company: 'Support Fall GmbH', email: 's@supportfall.de' });
    // Without consent the operator (admin, agency key, MCP) gets nothing from the account.
    const denied = await t.api.get('/api/contacts', { 'x-location-id': c.loc });
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/Support/);
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/open`, { reason: 'Hilfe' })).status).toBe(403);
    const lists = await t.api.get(`/api/agency/contacts?location_id=${c.loc}`);
    expect(lists.status).toBe(403);
    expect((await t.api.get('/api/agency/contacts')).status).toBe(403);
    // The operator's own lists do not carry the customer: no switcher entry, no project card, no row in the sub-account list.
    const ids = async () => ({
      me: (await t.api.get('/api/me')).data.locations.map((l: any) => l.id),
      locations: (await t.api.get('/api/locations')).data.map((l: any) => l.id),
      projects: (await t.api.get('/api/agency/projects')).data.map((l: any) => l.id),
      overview: (await t.api.get('/api/agency/overview')).data.map((l: any) => l.id),
    });
    for (const [k, list] of Object.entries(await ids())) {
      expect(list, k).not.toContain(c.loc);
      expect(list, k).toContain(t.api.location);
    }
    // The customer allows 24 hours.
    expect((await c.b.api('PUT', '/api/cloud/support', { hours: 99 })).status).toBe(400);
    const on = await c.b.api('PUT', '/api/cloud/support', { hours: 24 });
    expect(on.data.support.active).toBe(true);
    // Open for support, the account shows up for as long as the consent lasts.
    expect((await ids()).me).toContain(c.loc);
    const open = await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/open`, { reason: 'Rechnung prüfen' });
    expect(open.status, JSON.stringify(open.data)).toBe(200);
    expect(open.data.location_id).toBe(c.loc);
    expect((await t.api.get('/api/contacts', { 'x-location-id': c.loc })).status).toBe(200);
    // The customer sees it in the audit log of their own sub-account.
    const log = (await c.b.api('GET', '/api/audit', undefined, c.h)).data;
    const entries = Array.isArray(log) ? log : log.items;
    expect(entries.some((e: any) => e.action === 'cloud.support.open' && /Rechnung prüfen/.test(e.summary))).toBe(true);
    expect(entries.some((e: any) => e.action === 'cloud.support.allow')).toBe(true);
    // Revoked, the door is shut again.
    await c.b.api('PUT', '/api/cloud/support', { hours: 0 });
    expect((await t.api.get('/api/contacts', { 'x-location-id': c.loc })).status).toBe(403);
    expect((await ids()).me).not.toContain(c.loc);
    // The operator's own sub-accounts are not affected.
    expect((await t.api.get('/api/contacts', { 'x-location-id': t.api.location })).status).toBe(200);
  });
});

describe('Agentur: client sub-accounts and white-label', () => {
  it('creates isolated client accounts, applies the white-label, mirrors the billing state', async () => {
    await setting({ cloud_domain: 'cloud.example.com' });
    const c = await createCustomer({ plan: 'agency', company: 'Pixel Agentur', email: 'chef@pixel-agentur.de' });
    const home = (await c.b.api('GET', '/api/cloud/me')).data.tenant;
    expect(home.entitlements).toMatchObject({ client_accounts: true, white_label: true, custom_domain: true, users: null });
    expect(home.subdomain).toBe('pixel-agentur.cloud.example.com');
    // The subdomain is the tenant's login domain (white-label, served by the domain agent).
    expect(t.app.db.get('SELECT json_extract(settings, \'$.branding.app_domain\') AS d FROM locations WHERE id = ?', c.loc).d).toBe('pixel-agentur.cloud.example.com');
    // Two clients; the owner sees all three accounts in the switcher.
    const k1 = (await c.b.api('POST', '/api/cloud/clients', { name: 'Kunde Eins' })).data;
    const k2 = (await c.b.api('POST', '/api/cloud/clients', { name: 'Kunde Zwei' })).data;
    expect(k1).toMatchObject({ name: 'Kunde Eins', primary: false });
    const me = (await c.b.api('GET', '/api/me')).data;
    expect(me.locations.map((l: any) => l.name).sort()).toEqual(['Kunde Eins', 'Kunde Zwei', 'Pixel Agentur']);
    // Data of one client is invisible in the other.
    await c.b.api('POST', '/api/contacts', { email: 'privat@kunde-eins.de', first_name: 'GEHEIM' }, { 'x-location-id': k1.id });
    expect((await c.b.api('GET', '/api/contacts', undefined, { 'x-location-id': k2.id })).text).not.toContain('GEHEIM');
    expect((await c.b.api('GET', '/api/contacts', undefined, c.h)).text).not.toContain('GEHEIM');
    // A client login sees only its account – not the agency's other clients, not the team page.
    const inv = await c.b.api('POST', '/api/cloud/team', { email: 'kunde1@kunde-eins.de', name: 'Kundin Eins', locations: [k1.id] });
    expect(inv.status, JSON.stringify(inv.data)).toBe(200);
    const guest = browser(t.base);
    await guest.form(path(/(https?:\/\/\S+\/invite\/\S+)/.exec(lastMail('kunde1@kunde-eins.de', /eingeladen/)!.text)![1]), { password: 'kunden-passwort1', password2: 'kunden-passwort1' });
    expect((await guest.api('GET', '/api/me')).data.locations.map((l: any) => l.id)).toEqual([k1.id]);
    expect((await guest.api('GET', '/api/contacts', undefined, { 'x-location-id': k2.id })).status).toBe(403);
    expect((await guest.api('GET', '/api/contacts', undefined, { 'x-location-id': c.loc })).status).toBe(403);
    // White-label: one call brands every account of the agency; a bad address or colour is refused.
    expect((await c.b.api('PUT', '/api/cloud/branding', { name: 'Pixel CRM', color: 'rot' })).status).toBe(400);
    expect((await c.b.api('PUT', '/api/cloud/branding', { name: 'Pixel CRM', logo_url: 'javascript:alert(1)' })).status).toBe(400);
    const brand = await c.b.api('PUT', '/api/cloud/branding', { name: 'Pixel CRM', color: '#ff5500', login_title: 'Willkommen bei Pixel' });
    expect(brand.status).toBe(200);
    for (const loc of [c.loc, k1.id, k2.id]) expect((await c.b.api('GET', '/api/branding/me', undefined, { 'x-location-id': loc })).data).toMatchObject({ name: 'Pixel CRM', color: '#ff5500' });
    // The agency's own login domain for a client, validated and unique.
    expect((await c.b.api('PUT', '/api/cloud/domain', { location_id: k1.id, domain: 'crm.kunde-eins.de' })).data.domain).toBe('crm.kunde-eins.de');
    expect((await c.b.api('PUT', '/api/cloud/domain', { location_id: k2.id, domain: 'crm.kunde-eins.de' })).status).toBe(400);
    expect((await c.b.api('PUT', '/api/cloud/domain', { location_id: k2.id, domain: 'evil.cloud.example.com' })).status).toBe(400);
    // Client accounts inherit read-only from the agency's subscription.
    const customerId = sub(c).stripe_customer;
    await hook(stripe.event('invoice.payment_failed', stripe.invoice(customerId, { subscription: c.sub.id, status: 'open' })));
    t.app.db.run('UPDATE saas_subscriptions SET grace_until = ? WHERE location_id = ?', new Date(Date.now() - 1000).toISOString(), c.loc);
    await t.app.tick();
    await cloud().reconcile();
    for (const loc of [c.loc, k1.id, k2.id]) {
      expect((await c.b.api('POST', '/api/contacts', { email: 'w@x.de', first_name: 'W' }, { 'x-location-id': loc })).status, loc).toBe(403);
      expect((await c.b.api('GET', '/api/saas/account', undefined, { 'x-location-id': loc })).data.banner?.text, loc).toMatch(/pausiert/);
    }
    expect((await guest.api('POST', '/api/contacts', { email: 'w@x.de', first_name: 'W' }, { 'x-location-id': k1.id })).status).toBe(403);
    await hook(stripe.event('invoice.paid', stripe.invoice(customerId, { subscription: c.sub.id })));
    await cloud().reconcile();
    expect((await c.b.api('POST', '/api/contacts', { email: 'w@x.de', first_name: 'W' }, { 'x-location-id': k1.id })).status).toBe(200);
    // Per-client fair use: the metering counts each account on its own.
    expect(t.app.services.usageGate(k1.id, 'email')).toBeUndefined();
    const list = (await c.b.api('GET', '/api/cloud/clients')).data.items;
    expect(list.find((x: any) => x.id === k1.id).meters.emails.used).toBe(1);
    expect(list.find((x: any) => x.id === k2.id).meters.emails.used).toBe(0);
    // Downgrading from Agentur is refused while there are client accounts; deleting a client wipes it.
    expect((await c.b.api('POST', '/api/cloud/plan', { plan: 'team' })).status).toBe(409);
    expect((await c.b.api('DELETE', `/api/cloud/clients/${k2.id}`, { confirm: 'falsch' })).status).toBe(400);
    expect((await c.b.api('DELETE', `/api/cloud/clients/${k2.id}`, { confirm: 'Kunde Zwei' })).status).toBe(200);
    expect(t.app.db.get('SELECT 1 AS x FROM locations WHERE id = ?', k2.id)).toBeUndefined();
    expect((await c.b.api('GET', '/api/me')).data.locations).toHaveLength(2);
    expect((await c.b.api('DELETE', `/api/cloud/clients/${c.loc}`, { confirm: 'Pixel Agentur' })).status).toBe(400);
    // A Team customer has neither clients nor white-label.
    const team = await createCustomer({ plan: 'team', company: 'Kein Reseller', email: 'r@kein-reseller.de' });
    expect((await team.b.api('POST', '/api/cloud/clients', { name: 'X' })).status).toBe(403);
    expect((await team.b.api('PUT', '/api/cloud/branding', { name: 'X' })).status).toBe(403);
    expect((await team.b.api('PUT', '/api/cloud/domain', { domain: 'x.example.org' })).status).toBe(403);
    // Neither has a Solo customer: white-label is the Agentur plan's alone.
    const solo = await createCustomer({ plan: 'solo', company: 'Solo ohne Marke', email: 's@solo-ohne-marke.de' });
    const calls: [string, string, object | undefined][] = [['GET', '/api/cloud/branding', undefined], ['PUT', '/api/cloud/branding', { name: 'X' }], ['PUT', '/api/cloud/domain', { domain: 'y.example.org' }], ['GET', '/api/cloud/clients', undefined], ['POST', '/api/cloud/clients', { name: 'Y' }]];
    for (const [m, p, body] of calls) {
      const r = await solo.b.api(m, p, body);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.data.error, `${m} ${p}`).toMatch(/Tarif Cloud Agentur/);
    }
    expect((await solo.b.api('GET', '/api/cloud/me')).data.tenant.entitlements).toMatchObject({ white_label: false, client_accounts: false, custom_domain: false });
    await setting({ cloud_domain: '' });
  });
});

describe('Google signup', () => {
  it('verifies the address through Google, skips the mail and logs in', async () => {
    const { createIdp, fetchRouter } = await import('./auth-fakes.js');
    const G = { client_id: 'google-client.apps.example.com', client_secret: 'google-secret-for-tests' };
    expect((await t.api.put('/api/agency/oauth', { google: G })).status).toBe(200);
    const google = createIdp({ issuer: 'https://accounts.google.com', clientId: G.client_id, clientSecret: G.client_secret, endpoints: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' } });
    t.app.services.ssoFetch = fetchRouter([google]).fetch;
    cloud().resetLimits();
    const b = browser(t.base);
    const page = await b.get('/start?plan=solo');
    expect(page.text).toContain('Mit Google fortfahren');
    const tok = /name="t" value="([^"]+)"/.exec(page.text)![1];
    const go = await b.form('/start', { plan: 'solo', interval: 'month', company: 'Google Solo', agb: '1', avv: '1', datenschutz: '1', business: '1', t: tok, via: 'google' });
    expect(go.status).toBe(303);
    expect(go.location).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
    const auth = google.authorize(go.location, { sub: 'g-solo-1', email: 'solo@gmail-test.de', email_verified: true, name: 'Sonja Solo' });
    expect(auth.redirect).toBe(`${t.base.replace(/127\.0\.0\.1:\d+/, 'localhost')}/start/google/callback`.replace(/^http:\/\/localhost.*$/, `http://localhost/start/google/callback`));
    // Another browser (no cookie) cannot finish somebody else's flow.
    expect((await browser(t.base).get(`/start/google/callback?code=${auth.code}&state=${auth.state}`)).status).toBe(400);
    const back = await b.get(`/start/google/callback?code=${auth.code}&state=${auth.state}`);
    expect(back.status, back.text.match(/<p>(.*?)<\/p>/)?.[1]).toBe(303);
    expect(back.location).toMatch(/^https:\/\/checkout\.stripe\.com/);
    const sid = back.location.split('/').pop()!;
    expect(stripe.store.sessions.get(sid).customer_email).toBe('solo@gmail-test.de');
    stripe.complete(sid);
    const done = await b.get(`/start/done?session_id=${sid}`);
    expect(done.location).toBe('/app');
    expect((await b.api('GET', '/api/me')).data.user.email).toBe('solo@gmail-test.de');
    // The Google identity is linked (so "Mit Google anmelden" works later); there is no password.
    const u = t.app.db.get(`SELECT * FROM users WHERE email = 'solo@gmail-test.de'`);
    expect(u.password_set).toBe(0);
    expect(t.app.db.get('SELECT provider, subject FROM auth_identities WHERE user_id = ?', u.id)).toMatchObject({ provider: 'google', subject: 'g-solo-1' });
    // An unverified Google address is refused; so is an address that has an account.
    const b2 = browser(t.base);
    const tok2 = /name="t" value="([^"]+)"/.exec((await b2.get('/start')).text)![1];
    const go2 = await b2.form('/start', { plan: 'solo', interval: 'month', company: 'Unbestätigt', agb: '1', avv: '1', datenschutz: '1', business: '1', t: tok2, via: 'google' });
    const a2 = google.authorize(go2.location, { sub: 'g-x', email: 'x@gmail-test.de', email_verified: false });
    expect((await b2.get(`/start/google/callback?code=${a2.code}&state=${a2.state}`)).text).toContain('bestätigte E-Mail');
    t.app.services.ssoFetch = undefined;
  });
});

describe('operator console', () => {
  it('is for the operator only: customers, guests and keys of customers get nothing', async () => {
    const c = await createCustomer({ plan: 'team', company: 'Neugierig GmbH', email: 'n@neugierig.de' });
    const routes = (t.app.router as any).routes as { method: string; pattern: string; auth: string }[];
    const consoleRoutes = routes.filter((r) => r.pattern.startsWith('/api/cloud/console/'));
    expect(consoleRoutes.length).toBeGreaterThan(12);
    expect(consoleRoutes.every((r) => r.auth === 'admin')).toBe(true);
    const guest = browser(t.base);
    for (const r of consoleRoutes) {
      const p = r.pattern.replace(/:\w+/g, 'x');
      expect((await c.b.api(r.method, p, r.method === 'GET' ? undefined : {})).status, `customer ${r.method} ${r.pattern}`).toBe(403);
      expect((await guest.api(r.method, p, r.method === 'GET' ? undefined : {})).status, `guest ${r.method} ${r.pattern}`).toBe(401);
    }
    // A customer's API key does not reach it either.
    const key = (await c.b.api('POST', '/api/api-keys', { name: 'k' }, c.h)).data.key;
    const asKey = await t.api.raw('/api/cloud/console/overview', { headers: { authorization: `Bearer ${key}` } });
    expect(asKey.status).toBe(403);
    // …nor the settings, the legal editor or the customer's own routes with somebody else's id.
    expect((await c.b.api('PUT', '/api/cloud/console/settings', { trial_days: 90 })).status).toBe(403);
    expect((await c.b.api('PUT', '/api/cloud/console/legal/agb', { body: 'x'.repeat(50) })).status).toBe(403);
    expect((await guest.api('GET', '/api/cloud/me')).status).toBe(401);
    // The operator, who is no customer, has no tenant of their own.
    expect((await t.api.get('/api/cloud/me')).data).toEqual({ customer: false });
    expect((await t.api.post('/api/cloud/team', { email: 'x@y.de' })).status).toBe(403);
  });

  it('shows customers, MRR, churn and trial conversion; exports the list; comps and changes plans', async () => {
    const o = (await t.api.get('/api/cloud/console/overview')).data;
    expect(o.total).toBeGreaterThan(5);
    expect(o.mrr_cents).toBe(o.plans.reduce((n: number, p: any) => n + p.mrr_cents, 0));
    expect(o.arr_cents).toBe(o.mrr_cents * 12);
    expect(o.trial.conversion_percent).not.toBeNull();
    expect(o.health).toMatchObject({ stripe_connected: true, webhook_set: true, signup_open: true });
    expect(o.churn.lost_30d).toBeGreaterThanOrEqual(1);
    // A paying team customer counts with the plan price, a trialing one does not yet.
    const c = await createCustomer({ plan: 'team', company: 'MRR Test GmbH', email: 'm@mrr.de' });
    const before = (await t.api.get('/api/cloud/console/overview')).data.mrr_cents;
    const active = { ...c.sub, status: 'active', trial_end: null };
    stripe.store.subs.set(c.sub.id, active);
    await hook(stripe.event('customer.subscription.updated', active));
    expect((await t.api.get('/api/cloud/console/overview')).data.mrr_cents).toBe(before + 9999);
    // List with filters and the CSV export.
    const list = (await t.api.get('/api/cloud/console/tenants?q=mrr%20test')).data;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: 'MRR Test GmbH', plan: 'team', phase: 'active', mrr_cents: 9999, stripe: true });
    expect((await t.api.get('/api/cloud/console/tenants?phase=past_due')).data.items.every((x: any) => x.phase === 'past_due')).toBe(true);
    const csv = await t.api.raw('/api/cloud/console/tenants.csv', { headers: { cookie: t.api.cookie } });
    const text = await csv.text();
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(text).toContain('MRR Test GmbH');
    expect(text.split('\n')[0]).toContain('MRR (EUR)');
    // Detail with the event history.
    const d = (await t.api.get(`/api/cloud/console/tenants/${c.tenantId}`)).data;
    expect(d.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['provisioned', 'trial_started', 'trial_converted']));
    expect(d.acceptances).toHaveLength(3);
    // The operator moves the customer to Agentur (Stripe proration), then comps them.
    const up = await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/plan`, { plan: 'agency', interval: 'month' });
    expect(up.data.plan.key).toBe('agency');
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/comp`, { plan: 'team' })).status).toBe(400);
    stripe.store.subs.get(c.sub.id).status = 'canceled';
    await hook(stripe.event('customer.subscription.deleted', stripe.store.subs.get(c.sub.id)));
    expect(sub(c).status).toBe('canceled');
    const comp = await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/comp`, { plan: 'team', months: 1 });
    expect(comp.status, JSON.stringify(comp.data)).toBe(200);
    expect(comp.data).toMatchObject({ phase: 'comped', comped: true, read_only: false, billing: 'manual' });
    expect((await c.b.api('POST', '/api/contacts', { email: 'g@h.de', first_name: 'G' }, c.h)).status).toBe(200);
    // Comped plans bring no MRR; when they run out the account turns read-only.
    expect((await t.api.get('/api/cloud/console/tenants?q=mrr%20test')).data.items[0].mrr_cents).toBe(0);
    await cloud().reconcile(new Date(Date.now() + 40 * DAY));
    expect(sub(c).status).toBe('paused');
    expect((await c.b.api('POST', '/api/contacts', { email: 'i@j.de', first_name: 'I' }, c.h)).status).toBe(403);
    expect(lastMail('m@mrr.de', /schreibgeschützt/)).toBeTruthy();
  });

  it('validates the settings and keeps plan rows, prices and Stripe prices in step', async () => {
    const bad = async (patch: any, re: RegExp) => expect((await setting(patch)).data.error, JSON.stringify(patch)).toMatch(re);
    await bad({ trial_days: 200 }, /Testphase/);
    await bad({ yearly_discount_percent: 99 }, /Jahresrabatt/);
    await bad({ prices: { solo: 5 } }, /Preis/);
    await bad({ fair_use: { solo: { emails: -1 } } }, /E-Mails/);
    await bad({ cloud_domain: 'nicht gültig' }, /Cloud-Domain/);
    await bad({ status_url: 'http://x.de' }, /https/);
    await bad({ support_email: 'kaputt' }, /Support-E-Mail/);
    await bad({ default_snapshot_id: 'gibtsnicht' }, /Snapshot/);
    await bad({ mail_location_id: 'gibtsnicht' }, /Absender/);
    // A new price reaches the plan row and – through the SaaS sync – Stripe as a new price; the pages show it.
    const r = await setting({ prices: { solo: 5900 }, yearly_discount_percent: 10, trial_days: 7, grace_days: 5, status_url: 'https://status.example.com' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.derived.prices.solo).toEqual({ month: 5900, year: 63700 });
    expect(t.app.db.get(`SELECT price_month_cents, price_year_cents, trial_days FROM saas_plans WHERE id = 'cloud-solo'`)).toMatchObject({ price_month_cents: 5900, price_year_cents: 63700, trial_days: 7 });
    expect(saasGrace()).toBe(5);
    await new Promise((res) => setTimeout(res, 50));
    const pricing = (await browser(t.base).get('/cloud')).text.replace(/ /g, ' ');
    expect(pricing).toContain('59 €');
    expect(pricing).toContain('https://status.example.com');
    expect((await browser(t.base).get('/api/public/cloud/pricing')).data.plans[0]).toMatchObject({ key: 'solo', price_month_cents: 5900, price_year_cents: 63700 });
    await setting({ prices: { solo: 4999 }, yearly_discount_percent: 20, trial_days: 14, grace_days: 7, status_url: '' });
    // Signup can be switched off.
    await setting({ signup_open: false });
    const b = browser(t.base);
    expect((await b.get('/start')).text).toContain('pausiert');
    expect((await b.form('/start', { plan: 'solo', company: 'X GmbH', email: 'x@x.de' })).status).toBe(503);
    await setting({ signup_open: true });
  });

  it('versions the legal texts, stores which version each customer accepted, and offers the accepted AVV', async () => {
    const docs = (await t.api.get('/api/cloud/console/legal')).data.docs;
    expect(docs.map((d: any) => d.doc)).toEqual(['agb', 'avv', 'datenschutz', 'impressum']);
    expect(docs[0].open_placeholders).toEqual(expect.arrayContaining(['operator.name']));
    const c = await createCustomer({ plan: 'solo', company: 'Rechtlich GmbH', email: 'r@rechtlich.de' });
    expect((await c.b.api('GET', '/api/cloud/legal')).data.pending).toEqual([]);
    // The operator fills in their data and publishes a new AGB: a new version, the customer sees it as pending.
    await setting({ operator: { name: 'Beispiel Software UG', street: 'Musterweg 1', zip_city: '12345 Musterstadt', email: 'kontakt@beispiel.example', representative: 'Erika Beispiel' } });
    const put = await t.api.put('/api/cloud/console/legal/agb', { body: '## 1. Test\n\nNeue AGB von {{operator.name}}, Stand {{date}}.' });
    expect(put.data).toMatchObject({ doc: 'agb', version: 2 });
    expect((await t.api.put('/api/cloud/console/legal/agb', { body: '## 1. Test\n\nNeue AGB von {{operator.name}}, Stand {{date}}.' })).data.version).toBe(2);
    expect((await t.api.put('/api/cloud/console/legal/agb', { body: 'kurz' })).status).toBe(400);
    const page = (await browser(t.base).get('/cloud/legal/agb')).text;
    expect(page).toContain('Neue AGB von Beispiel Software UG');
    expect(page).toContain('Version 2');
    const me = (await c.b.api('GET', '/api/cloud/me')).data;
    expect(me.legal.pending).toEqual([{ doc: 'agb', version: 2 }]);
    expect((await c.b.api('POST', '/api/cloud/legal/accept', {})).data.pending).toEqual([]);
    expect(t.app.db.all(`SELECT version FROM cloud_acceptances WHERE tenant_id = ? AND doc = 'agb' ORDER BY version`, c.tenantId).map((r: any) => r.version)).toEqual([1, 2]);
    // The AVV the customer accepted, with their company filled in – as PDF or HTML.
    const avv = await t.api.raw('/api/cloud/avv', { headers: { cookie: `pghl_session=${c.b.cookie('pghl_session')}` } });
    expect(avv.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await avv.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    const html = await t.api.raw('/api/cloud/avv?format=html', { headers: { cookie: `pghl_session=${c.b.cookie('pghl_session')}` } });
    const h = await html.text();
    expect(h).toContain('Rechtlich GmbH');
    expect(h).toContain('Beispiel Software UG');
  });

  it('keeps a customer from paying for an account that could not be created, and lets the operator retry', async () => {
    cloud().resetLimits();
    const { b, link } = await signUp({ plan: 'solo', company: 'Doppelt GmbH', email: 'doppelt@doppelt.de' });
    const go = await b.form(link, {});
    const sid = go.location.split('/').pop()!;
    // Meanwhile somebody else registered the address (a race): provisioning fails, the subscription is ended again.
    t.app.db.insert('users', { id: 'racer00000000001', email: 'doppelt@doppelt.de', name: 'Racer', password_hash: '!x', role: 'member', locations: [], created_at: new Date().toISOString() });
    const { sub: st } = stripe.complete(sid);
    const back = await b.get(`/start/done?session_id=${sid}`);
    expect(back.text).toContain('nicht geklappt');
    expect(stripe.store.subs.get(st.id).status).toBe('canceled');
    expect(t.app.db.get(`SELECT status, error FROM cloud_signups WHERE session_id = ?`, sid)).toMatchObject({ status: 'failed', error: expect.stringContaining('schon ein Konto') });
    const failed = (await t.api.get('/api/cloud/console/overview')).data.failed_signups;
    expect(failed).toBeGreaterThanOrEqual(1);
    expect((await t.api.get('/api/cloud/console/signups')).data.some((s: any) => s.status === 'failed' && s.email === 'doppelt@doppelt.de')).toBe(true);
    t.app.db.run(`DELETE FROM users WHERE id = 'racer00000000001'`);
    stripe.store.subs.get(st.id).status = 'active';
    const id = t.app.db.get(`SELECT id FROM cloud_signups WHERE session_id = ?`, sid).id;
    expect((await t.api.post(`/api/cloud/console/signups/${id}/retry`, {})).data.handled).toBe('account_created');
    expect((await b.get(`/start/done?session_id=${sid}`)).location).toBe('/app');
  });

  it('survives Stripe trouble and a missing Stripe setup with a clear message', async () => {
    cloud().resetLimits();
    const { b, link } = await signUp({ plan: 'solo', company: 'Stripe Sorgen', email: 'ss@stripe-sorgen.de' });
    stripe.failWhen((p) => p === '/v1/checkout/sessions');
    const r = await b.form(link, {});
    expect(r.status).toBe(502);
    expect(r.text).toContain('Bezahlung gerade nicht möglich');
    stripe.failWhen();
    const again = await b.form(link, {});
    expect(again.status).toBe(303);
    // No keys at all: the cloud falls back to the waitlist mode (docs/cloud.md#waitlist-mode) – the link is refused, nothing is created.
    cloud().resetLimits();
    const x = await signUp({ plan: 'solo', company: 'Ohne Stripe', email: 'os@ohne-stripe.de' });
    const saved = t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'saas'`).value;
    t.app.db.run(`UPDATE agency_settings SET value = json_set(value, '$.secret_key', '') WHERE key = 'saas'`);
    expect((await x.b.form(x.link, {})).status).toBe(403);
    // Forced open without Stripe (PGHL_CLOUD_WAITLIST=0): the operator is told, the customer is not charged and nothing is created.
    process.env.PGHL_CLOUD_WAITLIST = '0';
    try {
      expect((await x.b.form(x.link, {})).status).toBe(503);
      expect(t.app.db.get(`SELECT 1 AS x FROM cloud_events WHERE type = 'signup_blocked'`)).toBeTruthy();
    } finally {
      delete process.env.PGHL_CLOUD_WAITLIST;
    }
    expect(t.app.db.get(`SELECT id FROM users WHERE email = 'os@ohne-stripe.de'`)).toBeUndefined();
    t.app.db.run(`UPDATE agency_settings SET value = ? WHERE key = 'saas'`, saved);
  });
});

const saasGrace = () => JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'saas'`).value).grace_days;
