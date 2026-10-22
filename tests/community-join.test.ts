import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { sha256, token } from '../server/core/util.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { membershipGrants } from '../server/services/community.js';
import { cleanPage, signMembership, verifyMembership } from '../server/services/community-tiers.js';
import { cleanCoupon, couponLabel } from '../server/services/community-join.js';

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';

/** A tiny fake Stripe: checkout sessions (with the params we sent), coupons, account. */
const sessions = new Map<string, any>();
const stripeCalls: { path: string; params: URLSearchParams }[] = [];
let seq = 0;
const fake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  stripeCalls.push({ path: u.pathname, params });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Muster' } }, charges_enabled: true });
  if (u.pathname === '/v1/coupons' && init.method === 'POST') return json({ id: `co_${++seq}`, object: 'coupon' });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, mode: params.get('mode'), metadata, params: Object.fromEntries(params), payment_status: 'unpaid', status: 'open', currency: 'eur', amount_total: 0, customer_email: params.get('customer_email') };
    sessions.set(id, s);
    return json(s);
  }
  if (u.pathname.startsWith('/v1/checkout/sessions/')) {
    const s = sessions.get(decodeURIComponent(u.pathname.split('/').pop()!));
    return s ? json(s) : json({ error: { message: 'No such session' } }, 404);
  }
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const mails: { to: string; subject: string; text: string }[] = [];
const events: { type: string; data: any }[] = [];
const EV = ['community.member_joined', 'community.member_left', 'community.trial_started', 'community.trial_converted', 'community.join_requested', 'product.purchased'];

beforeAll(async () => {
  setStripeFetch(fake);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const capture = async (_l: any, mail: any) => {
    mails.push(mail);
    return { status: 'sent' };
  };
  t.app.services.memberMailer = capture;
  t.app.services.communityMailer = capture;
  t.app.services.communityLimits = { join: 10_000 };
  for (const type of EV) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
  expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
});
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

const settle = () => t.app.events.flush();
const raw = (path: string, init: RequestInit = {}) => t.api.raw(path, { redirect: 'manual', ...init });
const getPage = async (path: string, cookie = '') => {
  const r = await raw(path, { headers: cookie ? { cookie } : {} });
  return { status: r.status, html: await r.text(), headers: r.headers };
};
const formPost = (path: string, data: Record<string, string>, headers: Record<string, string> = {}) => raw(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(data).toString() });
const tokenOf = (html: string) => html.match(/name="_t" value="([^"]+)"/)![1];
function memberCookie(contactId: string, location = loc) {
  const rawTok = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(rawTok), location, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${location}=${rawTok}`;
}
/** Submits the public join form like a browser: reads the form token first. */
async function join(slug: string, fields: Record<string, string>, query = '') {
  const page = await getPage(`/c/${slug}/join${query}`);
  const r = await formPost(`/c/${slug}/join`, { _t: tokenOf(page.html), ...fields });
  return { status: r.status, location: r.headers.get('location') ?? '', html: await r.text() };
}
async function stripeHook(event: any) {
  const body = JSON.stringify(event);
  const r = await raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(body, WHSEC) }, body });
  await settle();
  return { status: r.status, data: await r.json() };
}
const evt = (type: string, object: any) => ({ id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });
const completedSession = (s: any, over: Record<string, any> = {}) => ({ id: s.id, mode: s.mode, metadata: s.metadata, payment_status: 'paid', amount_total: 0, currency: 'eur', customer_details: { email: s.customer_email }, payment_intent: null, subscription: null, ...over });
const q = (db: any, sql: string, ...p: any[]) => t.app.db.all(sql, ...p);

describe('community join rules', () => {
  it('signs membership ids and refuses tampered ones', () => {
    const sig = signMembership(t.app, 'abc123');
    expect(verifyMembership(t.app, sig)).toBe('abc123');
    expect(verifyMembership(t.app, `${sig}0`)).toBeUndefined();
    expect(verifyMembership(t.app, `other.${sig.split('.')[1]}`)).toBeUndefined();
    expect(verifyMembership(t.app, '')).toBeUndefined();
  });

  it('grants access for active and trial memberships, past due only within grace days', () => {
    const now = Date.now();
    const m = (status: string, extra: any = {}) => ({ status, past_due_at: null, tier_id: null, cancel_at: null, ...extra });
    expect(membershipGrants(t.app, m('active'))).toBe(true);
    expect(membershipGrants(t.app, m('trialing'))).toBe(true);
    expect(membershipGrants(t.app, m('pending'))).toBe(false);
    expect(membershipGrants(t.app, m('awaiting_payment'))).toBe(false);
    expect(membershipGrants(t.app, m('canceled'))).toBe(false);
    expect(membershipGrants(t.app, m('past_due', { past_due_at: new Date(now).toISOString() }))).toBe(false);
    expect(membershipGrants(t.app, m('active', { cancel_at: new Date(now - 1000).toISOString() }))).toBe(false);
    expect(membershipGrants(t.app, m('active', { cancel_at: new Date(now + 86_400_000).toISOString() }))).toBe(true);
    expect(membershipGrants(t.app, undefined)).toBe(false);
  });

  it('validates the page: address, video, links, three questions at most', () => {
    const g = { id: 'g1', location_id: loc, slug: 'x', name: 'X' };
    expect(() => cleanPage(t.app, g, { slug: 'a' })).toThrow(/Adresse/);
    expect(() => cleanPage(t.app, g, { slug: 'api' })).toThrow(/reserviert/);
    expect(() => cleanPage(t.app, g, { slug: 'gute-seite', video_url: 'https://example.com/page' })).toThrow(/Video/);
    expect(() => cleanPage(t.app, g, { slug: 'gute-seite', terms_url: 'http://insecure.example' })).toThrow(/https/);
    expect(() => cleanPage(t.app, g, { slug: 'gute-seite', questions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] })).toThrow(/Höchstens 3/);
    const ok = cleanPage(t.app, g, { slug: 'Gute Seite', video_url: 'https://youtu.be/dQw4w9WgXcQ', questions: [{ label: 'Wer bist du?', required: true }] });
    expect(ok).toMatchObject({ slug: 'gute-seite', enabled: 0, indexable: 1, questions: [{ label: 'Wer bist du?', required: true, id: 'q1' }] });
  });

  it('validates discount codes', () => {
    const g = { id: 'g1', location_id: loc, slug: 'x', name: 'X' };
    expect(() => cleanCoupon(t.app, g, { code: 'x' })).toThrow(/Code/);
    expect(() => cleanCoupon(t.app, g, { code: 'FRUEH', percent_off: 150 })).toThrow(/100/);
    expect(cleanCoupon(t.app, g, { code: 'frueh 20', percent_off: 20, duration: 'repeating', months: 3 })).toMatchObject({ code: 'FRUEH20', percent_off: 20, duration: 'repeating', months: 3 });
    expect(couponLabel({ percent_off: 20, amount_off_cents: null, duration: 'repeating', months: 3 } as any)).toBe('−20 % für 3 Monate');
    expect(couponLabel({ percent_off: null, amount_off_cents: 500, duration: 'once' } as any)).toContain('auf die erste Zahlung');
  });
});

describe('community join', () => {
  let group: any;
  let free: any, paid: any, lifetime: any;
  let monthly: any, yearly: any, once: any;
  const SLUG = 'wachstum-club';

  it('sets up a community with a public page, tiers and questions', async () => {
    monthly = (await t.api.post('/api/products', { name: 'Club monatlich', price_cents: 1900, tax_rate: 0, recurring: 'month' })).data;
    yearly = (await t.api.post('/api/products', { name: 'Club jährlich', price_cents: 19000, tax_rate: 0, recurring: 'year' })).data;
    once = (await t.api.post('/api/products', { name: 'Club lebenslang', price_cents: 29900, tax_rate: 0 })).data;
    group = (await t.api.post('/api/community/groups', { name: 'Wachstum Club', description: 'Alles zum Wachsen', access: { mode: 'join' } })).data;
    expect(group.access.mode).toBe('join');

    // The page: nothing public until it is switched on.
    expect((await getPage(`/c/${SLUG}`)).status).toBe(404);
    const saved = await t.api.put(`/api/community/groups/${group.id}/join/page`, {
      slug: SLUG,
      enabled: true,
      discoverable: true,
      tagline: 'Gemeinsam schneller wachsen',
      about: '## Das bekommst du\n\n- Austausch\n- **Live-Calls**',
      video_url: 'https://youtu.be/dQw4w9WgXcQ',
      seo_title: 'Wachstum Club – Community',
      questions: [{ label: 'Woran arbeitest du gerade?', required: true }, { label: 'Dein Ziel', required: false }],
      privacy_url: 'https://example.com/datenschutz',
      consent_text: 'Ich möchte Neuigkeiten per E-Mail bekommen.',
    });
    expect(saved.status).toBe(200);
    expect(saved.data.page).toMatchObject({ slug: SLUG, enabled: 1, approval: 0 });
    expect(saved.data.page.questions.map((x: any) => x.field_key)).toEqual(['frage_woran_arbeitest_du_gerade', 'frage_dein_ziel']);
    expect(saved.data.url).toBe(`http://localhost/c/${SLUG}`);
    // A default free tier is created with the page.
    expect(saved.data.tiers).toHaveLength(1);
    free = saved.data.tiers[0];
    expect(free).toMatchObject({ name: 'Mitglied', billings: ['free'] });

    // Another group can't take the address.
    const other = (await t.api.post('/api/community/groups', { name: 'Anderer Club' })).data;
    expect((await t.api.put(`/api/community/groups/${other.id}/join/page`, { slug: SLUG })).status).toBe(400);

    // Paid tier: monthly with a yearly alternative and a 7-day trial; lifetime tier.
    expect((await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'Pro', product_id: yearly.id, annual_product_id: monthly.id })).status).toBe(400);
    expect((await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'Pro', product_id: monthly.id, annual_product_id: monthly.id })).status).toBe(400);
    expect((await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'Pro', product_id: once.id, trial_days: 7 })).status).toBe(400);
    paid = (await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'Pro', description: 'Alles inklusive', product_id: monthly.id, annual_product_id: yearly.id, trial_days: 7, features: ['Live-Calls', 'Alle Kanäle'], highlight: true })).data;
    expect(paid).toMatchObject({ billings: ['month', 'year'], trial_days: 7, prices: { month: { gross_cents: 1900 }, year: { gross_cents: 19000 } } });
    lifetime = (await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'Lifetime', product_id: once.id })).data;
    expect(lifetime.billings).toEqual(['once']);
    // A product from nowhere is refused, and a product needs a price.
    expect((await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'X', product_id: 'gibtsnicht' })).status).toBe(400);
    const gratis = (await t.api.post('/api/products', { name: 'Gratis', price_cents: 0 })).data;
    expect((await t.api.post(`/api/community/groups/${group.id}/tiers`, { name: 'X', product_id: gratis.id })).status).toBe(400);
  });

  it('shows the public page with SEO tags, prices, no private data – and nothing for a page that is off', async () => {
    const r = await getPage(`/c/${SLUG}`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('<title>Wachstum Club – Community</title>');
    expect(r.html).toContain('rel="canonical" href="http://localhost/c/wachstum-club"');
    expect(r.html).toContain('property="og:title"');
    expect(r.html).toContain('application/ld+json');
    expect(r.html).toContain('Gemeinsam schneller wachsen');
    expect(r.html).toContain('<strong>Live-Calls</strong>');
    expect(r.html).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(r.html).toContain('Kostenlos'); // the free tier
    expect(r.html).toContain('19,00');
    expect(r.html).toContain('7 Tage kostenlos testen');
    expect(r.html).toContain('index, follow');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(r.html).not.toContain('chef@example.com');
    // Off → 404; invite codes unknown to the page change nothing.
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { enabled: false });
    expect((await getPage(`/c/${SLUG}`)).status).toBe(404);
    expect((await getPage(`/c/${SLUG}/join`)).status).toBe(404);
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { enabled: true, indexable: false });
    expect((await getPage(`/c/${SLUG}`)).html).toContain('noindex, nofollow');
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { indexable: true });
  });

  it('lists only communities that opted in on /communities', async () => {
    const second = (await t.api.post('/api/community/groups', { name: 'Versteckter Club', access: { mode: 'join' } })).data;
    await t.api.put(`/api/community/groups/${second.id}/join/page`, { slug: 'versteckter-club', enabled: true, discoverable: false });
    const r = await getPage('/communities');
    expect(r.status).toBe(200);
    expect(r.html).toContain('Wachstum Club');
    expect(r.html).not.toContain('Versteckter Club');
    expect((await getPage('/communities?q=nichts-passendes')).html).toContain('Keine Community gefunden');
    expect((await getPage('/communities?q=wachstum')).html).toContain('Wachstum Club');
  });

  it('lets somebody join for free: contact, answers on the contact, tags, login link, access', async () => {
    const r = await join(SLUG, { name: 'Anna Beispiel', email: 'Anna@Example.DE', tier: free.id, q_q1: 'Ein Online-Kurs', q_q2: 'Mehr Kunden', consent: '1', terms: '1' });
    expect(r.status).toBe(200);
    expect(r.html).toContain('schau in dein Postfach');
    await settle();
    const contact = t.app.db.get<any>(`SELECT * FROM contacts WHERE location_id = ? AND email = 'anna@example.de'`, loc)!;
    expect(contact.first_name).toBe('Anna');
    const tags = JSON.parse(contact.tags);
    expect(tags).toEqual(expect.arrayContaining(['community', `community:${SLUG}`, 'stufe:mitglied']));
    expect(JSON.parse(contact.custom)).toMatchObject({ frage_woran_arbeitest_du_gerade: 'Ein Online-Kurs', frage_dein_ziel: 'Mehr Kunden' });
    expect(mails.find((m) => m.to === 'anna@example.de' && /Login-Link/.test(m.subject))).toBeTruthy();
    expect(events.find((e) => e.type === 'community.member_joined' && e.data.contactId === contact.id)).toBeTruthy();
    const m = t.app.db.get<any>('SELECT * FROM community_memberships WHERE contact_id = ?', contact.id)!;
    expect(m).toMatchObject({ status: 'active', billing: 'free', consent: 1 });
    // Member area: the group is open for her now, closed for everybody else.
    const cookie = memberCookie(contact.id);
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, cookie)).status).toBe(200);
    const stranger = (await t.api.post('/api/contacts', { email: 'fremd@example.de', first_name: 'Fremd' })).data;
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(stranger.id))).status).toBe(404);
    // Joining again changes nothing (and sends another link, never an instant session).
    const again = await join(SLUG, { name: 'Anna Beispiel', email: 'anna@example.de', tier: free.id, q_q1: 'x', terms: '1' });
    expect(again.html).toContain('schau in dein Postfach');
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM community_memberships WHERE contact_id = ?', contact.id)!.n).toBe(1);
  });

  it('refuses incomplete, forged and robotic submissions', async () => {
    // A required question left empty, a missing consent to the privacy notice, a missing token.
    expect((await join(SLUG, { name: 'Ben', email: 'ben@example.de', tier: free.id, terms: '1' })).status).toBe(400);
    expect((await join(SLUG, { name: 'Ben', email: 'ben@example.de', tier: free.id, q_q1: 'x' })).html).toContain('Datenschutz');
    expect((await join(SLUG, { name: 'Ben', email: 'kaputt', tier: free.id, q_q1: 'x', terms: '1' })).html).toContain('E-Mail');
    expect((await formPost(`/c/${SLUG}/join`, { name: 'Ben', email: 'ben@example.de', tier: free.id, q_q1: 'x', terms: '1' })).status).toBe(400);
    expect((await formPost(`/c/${SLUG}/join`, { _t: '1.abc', name: 'Ben', email: 'ben@example.de', tier: free.id, q_q1: 'x', terms: '1' })).status).toBe(400);
    // A form from another site.
    const page = await getPage(`/c/${SLUG}/join`);
    expect((await formPost(`/c/${SLUG}/join`, { _t: tokenOf(page.html), name: 'Ben', email: 'ben@example.de', tier: free.id, q_q1: 'x', terms: '1' }, { origin: 'https://evil.example' })).status).toBe(403);
    // The hidden field: friendly answer, nothing stored.
    const bot = await formPost(`/c/${SLUG}/join`, { _t: tokenOf(page.html), name: 'Bot', email: 'bot@example.de', tier: free.id, q_q1: 'x', terms: '1', website: 'http://spam' });
    expect(bot.status).toBe(200);
    expect(t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'bot@example.de')).toBeUndefined();
    expect(t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'ben@example.de')).toBeUndefined();
    // HTML in the name is refused, not stored.
    expect((await join(SLUG, { name: '<b>x</b>', email: 'x@example.de', tier: free.id, q_q1: 'x', terms: '1' })).status).toBe(400);
    // Too many attempts from one address.
    t.app.services.communityLimits = { join: 2 };
    const limits: number[] = [];
    for (let i = 0; i < 4; i++) limits.push((await join(SLUG, { name: 'Zed', email: `zed${i}@example.de`, tier: free.id, q_q1: 'x', terms: '1' })).status);
    expect(limits).toContain(429);
    t.app.services.communityLimits = { join: 10_000 };
    // (the counter of this address keeps its hits for an hour, so the following tests raise the limit instead)
  });

  it('puts requests in a queue when approval is on, and lets the team decide', async () => {
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { approval: true });
    const r = await join(SLUG, { name: 'Cora Wartet', email: 'cora@example.de', tier: free.id, q_q1: 'Podcast', terms: '1' });
    expect(r.html).toContain('Anfrage eingegangen');
    await settle();
    const cora = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'cora@example.de'`)!;
    expect(events.find((e) => e.type === 'community.join_requested' && e.data.contactId === cora.id)?.data.answers).toEqual({ 'Woran arbeitest du gerade?': 'Podcast' });
    // Not in yet: no group, no login link.
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(cora.id))).status).toBe(404);
    expect(mails.some((m) => m.to === 'cora@example.de')).toBe(false);
    const queue = (await t.api.get('/api/community/requests')).data;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ email: 'cora@example.de', status: 'pending', tier_name: 'Mitglied', group_name: 'Wachstum Club', answers: [{ question: 'Woran arbeitest du gerade?', answer: 'Podcast' }] });
    const done = await t.api.patch(`/api/community/memberships/${queue[0].id}`, { action: 'approve' });
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('active');
    expect(mails.some((m) => m.to === 'cora@example.de' && /Login-Link/.test(m.subject))).toBe(true);
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(cora.id))).status).toBe(200);
    // Decided requests can't be decided again; a rejection mails the person and keeps them out.
    expect((await t.api.patch(`/api/community/memberships/${queue[0].id}`, { action: 'reject' })).status).toBe(400);
    await join(SLUG, { name: 'Dirk Nein', email: 'dirk@example.de', tier: free.id, q_q1: 'Spam', terms: '1' });
    const dirk = (await t.api.get('/api/community/requests')).data[0];
    expect((await t.api.patch(`/api/community/memberships/${dirk.id}`, { action: 'reject', note: 'Passt leider nicht' })).data.status).toBe('rejected');
    expect(mails.find((m) => m.to === 'dirk@example.de')?.text).toContain('Passt leider nicht');
    expect((await t.api.get('/api/community/requests')).data).toHaveLength(0);
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { approval: false });
  });

  it('sends paying members to the checkout of the product: trial, discount code, and access when Stripe confirms', async () => {
    await t.api.post(`/api/community/groups/${group.id}/coupons`, { code: 'start20', percent_off: 20, duration: 'repeating', months: 3 });
    const bad = await join(SLUG, { name: 'Eva Zahlt', email: 'eva@example.de', tier: paid.id, billing: 'month', q_q1: 'Shop', terms: '1', coupon: 'GIBTSNICHT' });
    expect(bad.status).toBe(400);
    expect(bad.html).toContain('Rabattcode');
    const r = await join(SLUG, { name: 'Eva Zahlt', email: 'eva@example.de', tier: paid.id, billing: 'month', q_q1: 'Shop', terms: '1', coupon: 'start20' });
    expect(r.status).toBe(303);
    expect(r.location).toMatch(new RegExp(`^http://localhost/buy/${monthly.id}\\?cm=`));
    const eva = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'eva@example.de'`)!;
    const m0 = t.app.db.get<any>('SELECT * FROM community_memberships WHERE contact_id = ?', eva.id)!;
    expect(m0).toMatchObject({ status: 'awaiting_payment', billing: 'month', product_id: monthly.id, coupon_code: 'START20' });
    // Not in before paying.
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(eva.id))).status).toBe(404);

    // The buy page carries the membership along (and says what it is for).
    const buyPath = new URL(r.location).pathname + new URL(r.location).search;
    const buy = await getPage(buyPath);
    expect(buy.status).toBe(200);
    expect(buy.html).toContain('name="_cm"');
    expect(buy.html).toContain('Beitritt zu <strong>Wachstum Club</strong>');
    expect(buy.html).toContain('7 Tage kostenlos testen');
    const cm = buy.html.match(/name="_cm" value="([^"]+)"/)![1];

    // A forged or foreign token is refused at checkout.
    expect((await formPost(`/buy/${monthly.id}`, { _cm: `${m0.id}.0000000000000000000000` })).status).toBe(400);
    expect((await formPost(`/buy/${yearly.id}`, { _cm: cm })).status).toBe(303); // yearly belongs to the same tier: fine
    const lifeTierProduct = (await formPost(`/buy/${once.id}`, { _cm: cm })).headers.get('location');
    expect(lifeTierProduct).toBeNull(); // not a product of this tier: error page, no Stripe session

    const go = await formPost(`/buy/${monthly.id}`, { _cm: cm, email: 'eva@example.de' });
    expect(go.status).toBe(303);
    const created = [...stripeCalls].reverse().find((c) => c.path === '/v1/checkout/sessions')!;
    expect(created.params.get('subscription_data[trial_period_days]')).toBe('7');
    expect(created.params.get('metadata[community_membership]')).toBe(m0.id);
    expect(created.params.get('metadata[community_trial]')).toBe('7');
    expect(created.params.get('metadata[community_coupon]')).toBe('START20');
    expect(created.params.get('discounts[0][coupon]')).toMatch(/^co_/);
    // The Stripe coupon is created once (at the first checkout with the code) and reused afterwards.
    expect(stripeCalls.filter((c) => c.path === '/v1/coupons')).toHaveLength(1);
    const couponCall = stripeCalls.find((c) => c.path === '/v1/coupons')!;
    expect(couponCall.params.get('percent_off')).toBe('20');
    expect(couponCall.params.get('duration')).toBe('repeating');
    expect(couponCall.params.get('duration_in_months')).toBe('3');
    const sessionId = [...sessions.keys()].pop()!;
    const session = sessions.get(sessionId);

    // Stripe: the trial starts (nothing is charged).
    const sub = 'sub_eva_1';
    const hook1 = await stripeHook(evt('checkout.session.completed', completedSession(session, { payment_status: 'no_payment_required', subscription: sub })));
    expect(hook1.data).toMatchObject({ received: true, handled: 'product_purchased' });
    let m = t.app.db.get<any>('SELECT * FROM community_memberships WHERE id = ?', m0.id)!;
    expect(m).toMatchObject({ status: 'trialing', subscription: sub });
    expect(m.trial_ends_at > new Date(Date.now() + 6 * 864e5).toISOString()).toBe(true);
    expect(events.find((e) => e.type === 'community.trial_started' && e.data.contactId === eva.id)).toBeTruthy();
    expect(t.app.db.get<any>('SELECT uses FROM community_coupons WHERE code = ?', 'START20')!.uses).toBe(1);
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(eva.id))).status).toBe(200);
    // The first invoice of a trial is a free one, labelled so.
    const inv = t.app.db.get<any>(`SELECT * FROM invoices WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1`, eva.id)!;
    expect(inv.total_cents).toBe(0);
    expect(inv.items).toContain('Testphase');
    // Back from Stripe: the welcome page takes the person on (login link by mail).
    const welcome = await getPage(`/c/${SLUG}/willkommen?cm=${encodeURIComponent(cm)}`);
    expect(welcome.html).toContain('Deine Testphase läuft');

    // The first real payment after the trial → converted.
    const props = (a: any) => ({ location_id: loc, product_id: monthly.id, price_cents: '1900', ...a });
    const paidInvoice = { id: 'in_eva_2', billing_reason: 'subscription_cycle', amount_paid: 1520, currency: 'eur', customer_email: 'eva@example.de', parent: { subscription_details: { subscription: sub, metadata: props({}) } } };
    expect((await stripeHook(evt('invoice.paid', paidInvoice))).data.handled).toBe('renewal');
    m = t.app.db.get<any>('SELECT * FROM community_memberships WHERE id = ?', m0.id)!;
    expect(m.status).toBe('active');
    expect(m.converted_at).toBeTruthy();
    expect(events.find((e) => e.type === 'community.trial_converted' && e.data.contactId === eva.id)).toBeTruthy();

    // A failed payment takes the access away (no grace days)…
    const failed = { id: 'in_eva_3', billing_reason: 'subscription_cycle', amount_due: 1900, currency: 'eur', attempt_count: 1, parent: { subscription_details: { subscription: sub, metadata: props({}) } } };
    expect((await stripeHook(evt('invoice.payment_failed', failed))).data.handled).toBe('payment_failed');
    m = t.app.db.get<any>('SELECT * FROM community_memberships WHERE id = ?', m0.id)!;
    expect(m.status).toBe('canceled');
    expect(m.left_reason).toBe('payment_failed');
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(eva.id))).status).toBe(404);
    expect(events.find((e) => e.type === 'community.member_left' && e.data.contactId === eva.id)?.data.reason).toBe('payment_failed');
    expect(mails.some((x) => x.to === 'eva@example.de' && /fehlgeschlagen/.test(x.subject))).toBe(true);
    // …and paying again (the renewal comes through) brings her back as a new membership.
    const again = await join(SLUG, { name: 'Eva Zahlt', email: 'eva@example.de', tier: paid.id, billing: 'month', q_q1: 'Shop', terms: '1' });
    expect(again.status).toBe(303);
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', m0.id)!.status).toBe('awaiting_payment');
  });

  it('keeps access during the grace days of a tier, ends it afterwards and when Stripe ends the subscription', async () => {
    await t.api.patch(`/api/community/tiers/${paid.id}`, { grace_days: 3 });
    const r = await join(SLUG, { name: 'Finn Abo', email: 'finn@example.de', tier: paid.id, billing: 'year', q_q1: 'App', terms: '1' });
    expect(r.location).toContain(`/buy/${yearly.id}?cm=`);
    const finn = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'finn@example.de'`)!;
    const mrow = t.app.db.get<any>('SELECT * FROM community_memberships WHERE contact_id = ?', finn.id)!;
    stripeCalls.length = 0;
    expect((await formPost(`/buy/${yearly.id}`, { _cm: signMembership(t.app, mrow.id), email: 'finn@example.de' })).status).toBe(303);
    const session = sessions.get([...sessions.keys()].pop()!);
    const sub = 'sub_finn';
    // A yearly product without trial days in the tier would be paid at once; here the tier has 7 → trial.
    await stripeHook(evt('checkout.session.completed', completedSession(session, { payment_status: 'no_payment_required', subscription: sub })));
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', mrow.id)!.status).toBe('trialing');
    const props = { location_id: loc, product_id: yearly.id, price_cents: '19000' };
    await stripeHook(evt('invoice.paid', { id: 'in_finn_2', billing_reason: 'subscription_cycle', amount_paid: 19000, currency: 'eur', customer_email: 'finn@example.de', parent: { subscription_details: { subscription: sub, metadata: props } } }));
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', mrow.id)!.status).toBe('active');

    // Payment fails: past due, but the three grace days keep him in.
    await stripeHook(evt('invoice.payment_failed', { id: 'in_finn_3', amount_due: 19000, currency: 'eur', attempt_count: 1, parent: { subscription_details: { subscription: sub, metadata: props } } }));
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', mrow.id)!.status).toBe('past_due');
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(finn.id))).status).toBe(200);
    // The grace days are over: the background job ends it.
    t.app.db.run('UPDATE community_memberships SET past_due_at = ? WHERE id = ?', new Date(Date.now() - 4 * 864e5).toISOString(), mrow.id);
    await t.app.tick();
    await settle();
    expect(t.app.db.get<any>('SELECT status, left_reason FROM community_memberships WHERE id = ?', mrow.id)).toMatchObject({ status: 'canceled', left_reason: 'payment_failed' });
    expect((await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(finn.id))).status).toBe(404);
  });

  it('ends the membership when the Stripe subscription is deleted', async () => {
    const r = await join(SLUG, { name: 'Gina Kuendigt', email: 'gina@example.de', tier: paid.id, billing: 'month', q_q1: 'x', terms: '1' });
    const gina = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'gina@example.de'`)!;
    const mrow = t.app.db.get<any>('SELECT * FROM community_memberships WHERE contact_id = ?', gina.id)!;
    await formPost(`/buy/${monthly.id}`, { _cm: signMembership(t.app, mrow.id), email: 'gina@example.de' });
    expect(r.status).toBe(303);
    const session = sessions.get([...sessions.keys()].pop()!);
    // Second trial isn't offered to somebody who had one (a membership with a trial start in this community).
    await stripeHook(evt('checkout.session.completed', completedSession(session, { payment_status: 'no_payment_required', subscription: 'sub_gina' })));
    expect(t.app.db.get<any>('SELECT status FROM community_memberships WHERE id = ?', mrow.id)!.status).toBe('trialing');
    const ended = await stripeHook(evt('customer.subscription.deleted', { id: 'sub_gina', metadata: { location_id: loc, product_id: monthly.id, tag: 'kauf:club-monatlich' } }));
    expect(ended.data.handled).toBe('subscription_ended');
    expect(t.app.db.get<any>('SELECT status, left_reason FROM community_memberships WHERE id = ?', mrow.id)).toMatchObject({ status: 'canceled', left_reason: 'subscription_ended' });
    expect(events.find((e) => e.type === 'community.member_left' && e.data.contactId === gina.id)?.data.reason).toBe('subscription_ended');
    expect(JSON.parse(t.app.db.get<any>('SELECT tags FROM contacts WHERE id = ?', gina.id)!.tags)).not.toContain(`community:${SLUG}`);
  });

  it('takes lifetime buyers in at once and out again on a full refund', async () => {
    const r = await join(SLUG, { name: 'Hans Lebenslang', email: 'hans@example.de', tier: lifetime.id, q_q1: 'x', terms: '1' });
    expect(r.location).toContain(`/buy/${once.id}?cm=`);
    const hans = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'hans@example.de'`)!;
    const mrow = t.app.db.get<any>('SELECT * FROM community_memberships WHERE contact_id = ?', hans.id)!;
    expect(mrow.billing).toBe('once');
    expect((await formPost(`/buy/${once.id}`, { _cm: signMembership(t.app, mrow.id), email: 'hans@example.de' })).status).toBe(303);
    const session = sessions.get([...sessions.keys()].pop()!);
    expect(session.params['discounts[0][coupon]']).toBeUndefined();
    await stripeHook(evt('checkout.session.completed', completedSession(session, { amount_total: 29900, payment_intent: 'pi_hans' })));
    expect(t.app.db.get<any>('SELECT status, billing FROM community_memberships WHERE id = ?', mrow.id)).toMatchObject({ status: 'active', billing: 'once' });
    // A back-from-Stripe visit lands on the community's welcome page, not the generic thank-you.
    const sid = session.id;
    const back = await raw(`/buy/${once.id}/danke?session_id=${sid}`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toContain(`/c/${SLUG}/willkommen?cm=`);
    // Refund of the full amount ends a lifetime membership.
    const charge = { id: 'ch_hans', payment_intent: 'pi_hans', amount_refunded: 29900, currency: 'eur', refunded: true };
    await stripeHook(evt('charge.refunded', charge));
    expect(t.app.db.get<any>('SELECT status, left_reason FROM community_memberships WHERE id = ?', mrow.id)).toMatchObject({ status: 'canceled', left_reason: 'refunded' });
  });

  it('counts invite uses when somebody is really in, lets invites skip approval and pick the tier', async () => {
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { approval: true });
    const made = (await t.api.post(`/api/community/groups/${group.id}/invites`, { label: 'Newsletter Oktober', skip_approval: true, max_uses: 2 })).data;
    expect(made.url).toMatch(new RegExp(`^http://localhost/c/${SLUG}/i/[a-z0-9]{3,}$`));
    expect((await raw(new URL(made.url).pathname)).headers.get('location')).toBe(`/c/${SLUG}/join?i=${made.code}`);
    const r = await join(SLUG, { name: 'Ida Eingeladen', email: 'ida@example.de', tier: free.id, q_q1: 'x', terms: '1', invite: made.code }, `?i=${made.code}`);
    expect(r.status).toBe(200);
    expect(r.html).toContain('schau in dein Postfach');
    const list = (await t.api.get(`/api/community/groups/${group.id}/invites`)).data;
    expect(list[0]).toMatchObject({ uses: 1, members: 1, pending: 0, label: 'Newsletter Oktober' });
    const ida = t.app.db.get<any>(`SELECT * FROM community_memberships WHERE invite_id = ?`, made.id)!;
    expect(ida).toMatchObject({ status: 'active', source: 'invite' });
    // An unknown code is refused; an off code too.
    expect((await join(SLUG, { name: 'Jan', email: 'jan@example.de', tier: free.id, q_q1: 'x', terms: '1', invite: 'nope' })).status).toBe(400);
    await t.api.patch(`/api/community/invites/${made.id}`, { active: false });
    expect((await join(SLUG, { name: 'Jan', email: 'jan@example.de', tier: free.id, q_q1: 'x', terms: '1', invite: made.code })).status).toBe(400);
    await t.api.put(`/api/community/groups/${group.id}/join/page`, { approval: false });
  });

  it('keeps banned people out and lets the team add or remove members by hand', async () => {
    const ida = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'ida@example.de'`)!;
    // Ida visits the group once (a members row), then gets banned: joining again through the page is refused.
    await getPage(`/portal/${loc}/community/g/wachstum-club`, memberCookie(ida.id));
    expect((await t.api.post(`/api/community/groups/${group.id}/members/${ida.id}/ban`, { reason: 'Spam' })).status).toBe(200);
    expect((await join(SLUG, { name: 'Ida', email: 'ida@example.de', tier: free.id, q_q1: 'x', terms: '1' })).status).toBe(403);
    // By hand: add a member, remove them again.
    const added = await t.api.post(`/api/community/groups/${group.id}/memberships`, { email: 'karl@example.de', name: 'Karl Manuell', tier_id: paid.id });
    expect(added.status).toBe(200);
    expect(added.data).toMatchObject({ status: 'active', tier_name: 'Pro', source: 'admin' });
    const ended = await t.api.patch(`/api/community/memberships/${added.data.id}`, { action: 'end' });
    expect(ended.status).toBe(200);
    expect(t.app.db.get<any>('SELECT status, left_reason FROM community_memberships WHERE id = ?', added.data.id)).toMatchObject({ status: 'canceled', left_reason: 'removed' });
    expect((await t.api.patch(`/api/community/memberships/${added.data.id}`, { action: 'end' })).status).toBe(400);
    expect((await t.api.patch(`/api/community/memberships/${added.data.id}`, { action: 'reactivate' })).data.status).toBe('active');
    // A tier with members can only be turned off.
    expect((await t.api.del(`/api/community/tiers/${paid.id}`)).status).toBe(400);
    expect((await t.api.patch(`/api/community/tiers/${paid.id}`, { active: false })).data.active).toBe(0);
    await t.api.patch(`/api/community/tiers/${paid.id}`, { active: true });
  });

  it('turns an old group into a join group without locking anybody out', async () => {
    const old = (await t.api.post('/api/community/groups', { name: 'Alte Gruppe', access: { mode: 'tags', tags: ['alt'] } })).data;
    const oldMember = (await t.api.post('/api/contacts', { email: 'alt@example.de', first_name: 'Alt', tags: ['alt'] })).data;
    const cookie = memberCookie(oldMember.id);
    expect((await getPage(`/portal/${loc}/community/g/alte-gruppe`, cookie)).status).toBe(200);
    const r = await t.api.put(`/api/community/groups/${old.id}/join/page`, { slug: 'alte-gruppe', enabled: true, set_access_join: true });
    expect(r.data.access_mode).toBe('join');
    // The tag no longer matters, the migrated membership does.
    await t.api.patch(`/api/contacts/${oldMember.id}`, { tags: [] });
    expect((await getPage(`/portal/${loc}/community/g/alte-gruppe`, cookie)).status).toBe(200);
    expect(t.app.db.get<any>('SELECT source, status FROM community_memberships WHERE contact_id = ?', oldMember.id)).toMatchObject({ source: 'migrated', status: 'active' });
  });
});
