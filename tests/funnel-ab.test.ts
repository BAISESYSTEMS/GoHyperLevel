import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { isBot, normalCdf, pickVariant, probabilityToBeat, summarize, zTest } from '../server/services/ab-stats.js';
import { tagPage } from '../server/modules/funnel-ab.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';

describe('A/B statistics', () => {
  it('runs a two-proportion z-test like the textbook', () => {
    // 20 % vs 25 % on 1000 visitors each: pooled 22.5 %, z ≈ 2.677, p ≈ 0.0074.
    const r = zTest({ visitors: 1000, conversions: 200 }, { visitors: 1000, conversions: 250 })!;
    expect(r.z).toBeCloseTo(2.6774, 3);
    expect(r.p).toBeCloseTo(0.00742, 4);
    expect(zTest({ visitors: 1000, conversions: 250 }, { visitors: 1000, conversions: 200 })!.z).toBeCloseTo(-2.6774, 3);
    expect(zTest({ visitors: 0, conversions: 0 }, { visitors: 10, conversions: 1 })).toBeNull();
    expect(zTest({ visitors: 10, conversions: 0 }, { visitors: 10, conversions: 0 })).toBeNull();
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.644854)).toBeCloseTo(0.05, 5);
  });

  it('gives the Bayesian probability to beat the original', () => {
    expect(probabilityToBeat({ visitors: 0, conversions: 0 }, { visitors: 0, conversions: 0 })).toBeCloseTo(0.5, 6);
    expect(probabilityToBeat({ visitors: 500, conversions: 50 }, { visitors: 500, conversions: 50 })).toBeCloseTo(0.5, 2);
    const p = probabilityToBeat({ visitors: 1000, conversions: 200 }, { visitors: 1000, conversions: 250 });
    expect(p).toBeGreaterThan(0.99);
    expect(p).toBeLessThan(1);
    expect(probabilityToBeat({ visitors: 1000, conversions: 250 }, { visitors: 1000, conversions: 200 })).toBeCloseTo(1 - p, 4);
    // Small numbers: 1/10 vs 3/10 → about 0.84 (exact Beta sum).
    expect(probabilityToBeat({ visitors: 10, conversions: 1 }, { visitors: 10, conversions: 3 })).toBeCloseTo(0.84, 1);
    // Very large counts use the normal approximation.
    expect(probabilityToBeat({ visitors: 30000, conversions: 6000 }, { visitors: 30000, conversions: 6300 })).toBeGreaterThan(0.99);
  });

  it('flags small samples and says which variant wins', () => {
    const few = summarize([
      { id: 'a', key: 'A', is_control: true, visitors: 40, conversions: 4 },
      { id: 'b', key: 'B', is_control: false, visitors: 40, conversions: 9 },
    ]);
    expect(few.small_sample).toBe(true);
    expect(few.variants[1]).toMatchObject({ verdict: 'too_early', significant: false });
    expect(few.variants[1].uplift).toBeCloseTo(1.25, 6);
    expect(few.leader).toBeNull();
    const many = summarize([
      { id: 'a', key: 'A', is_control: true, visitors: 1000, conversions: 200 },
      { id: 'b', key: 'B', is_control: false, visitors: 1000, conversions: 250 },
      { id: 'c', key: 'C', is_control: false, visitors: 1000, conversions: 205 },
    ]);
    expect(many.small_sample).toBe(false);
    expect(many.variants.map((v) => v.verdict)).toEqual(['control', 'better', 'no_difference']);
    expect(many.variants[1].rate).toBeCloseTo(0.25, 6);
    expect(many.leader).toBe('B');
  });

  it('splits by weight and recognises bots', () => {
    const vs = [
      { id: 'A', weight: 70 },
      { id: 'B', weight: 30 },
    ];
    const n = { A: 0, B: 0 } as Record<string, number>;
    for (let i = 0; i < 1000; i++) n[pickVariant(vs, i / 1000).id]++;
    expect(n).toEqual({ A: 700, B: 300 });
    expect(
      pickVariant(
        [
          { id: 'A', weight: 0 },
          { id: 'B', weight: 100 },
        ],
        0,
      ).id,
    ).toBe('B');
    expect(isBot(UA)).toBe(false);
    expect(isBot('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36')).toBe(false);
    for (const b of [BOT, 'facebookexternalhit/1.1', 'curl/8.4.0', 'python-requests/2.31', '', 'node', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/126.0']) expect(isBot(b)).toBe(true);
    expect(isBot(UA, 'prefetch')).toBe(true);
  });

  it('adds the visitor id to forms, booking widgets and buy links', () => {
    const v = 'abcdefghij0123456789';
    const page = `<form id="pf_1" class="pghl-form" novalidate></form><iframe src="/book/erst?embed=1" style=""></iframe><a class="btn" href="https://app.x/buy/kurs">Kaufen</a><a href="/buy/kurs?email=a%40b.de#top">x</a><a href="/p/f/danke">weiter</a>`;
    const out = tagPage(page, v);
    expect(out).toContain(`<form id="pf_1" class="pghl-form" novalidate><input type="hidden" name="_ab" value="${v}">`);
    expect(out).toContain(`src="/book/erst?embed=1&amp;ab=${v}"`);
    expect(out).toContain(`href="https://app.x/buy/kurs?ab=${v}"`);
    expect(out).toContain(`href="/buy/kurs?email=a%40b.de&amp;ab=${v}#top"`);
    expect(out).toContain('href="/p/f/danke"');
    expect(tagPage(page, 'x"><script>')).toBe(page);
  });
});

describe('A/B tests on funnel pages', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  let funnel: any;
  let start: any;
  let danke: any;
  let form: any;
  let test: any;
  const sessions = new Map<string, any>();
  const stripeCalls: URLSearchParams[] = [];

  beforeAll(async () => {
    let seq = 0;
    setStripeFetch((async (url: string, init: any) => {
      const u = new URL(url);
      const params = new URLSearchParams(init.body ?? '');
      const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Test' } } });
      if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
        stripeCalls.push(params);
        const id = `cs_test_ab${++seq}`;
        const metadata: Record<string, string> = {};
        for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
        const s = {
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          mode: params.get('mode'),
          metadata,
          amount_total: Number(params.get('line_items[0][price_data][unit_amount]')),
          currency: 'eur',
          payment_status: 'unpaid',
          status: 'open',
        };
        sessions.set(id, s);
        return json(s);
      }
      return json({ error: { message: 'unknown' } }, 404);
    }) as any);
    t = await startTestApp();
    await t.setup();
    form = (await t.api.post('/api/forms', { name: 'Opt-in' })).data;
    funnel = (await t.api.post('/api/funnels', { name: 'Leitfaden', template: 'leadmagnet' })).data;
    [start, danke] = funnel.pages;
    await t.api.patch(`/api/funnel-pages/${start.id}`, {
      blocks: [
        { type: 'hero', heading: 'Original-Überschrift' },
        { type: 'form', form_id: form.id },
      ],
    });
  });
  afterAll(async () => {
    setStripeFetch();
    await t.close();
  });

  const visit = async (path: string, cookie = '', ua = UA, extra: Record<string, string> = {}) => {
    const r = await t.api.raw(path, { headers: { 'user-agent': ua, ...(cookie ? { cookie } : {}), ...extra } });
    const m = (r.headers.get('set-cookie') ?? '').match(/pghl_ab=([A-Za-z0-9]+)/);
    const html = await r.text();
    const c = m ? `pghl_ab=${m[1]}` : cookie;
    return { status: r.status, html, cookie: c, visitor: c.split('=')[1] ?? '', setCookie: r.headers.get('set-cookie') ?? '', cache: r.headers.get('cache-control') ?? '' };
  };
  const shownVariant = (html: string) => (html.includes('Variante-B-Überschrift') ? 'B' : html.includes('Original-Überschrift') ? 'A' : '?');
  const stats = async () => (await t.api.get(`/api/ab-tests/${test.id}`)).data;
  const byKey = (s: any, k: string) => s.variants.find((v: any) => v.key === k);

  it('creates a test with the page as A and a copy as B', async () => {
    const r = await t.api.post('/api/ab-tests', { page_id: start.id, goal: { type: 'form', form_id: form.id } });
    expect(r.status).toBe(200);
    test = r.data;
    expect(test).toMatchObject({ status: 'draft', goal: { type: 'form', form_id: form.id }, name: 'Test: Opt-in' });
    expect(test.variants.map((v: any) => [v.key, v.weight, v.is_control])).toEqual([
      ['A', 50, true],
      ['B', 50, false],
    ]);
    expect(byKey(test, 'B').blocks[0].heading).toBe('Original-Überschrift');
    // One open test per page; the goal must be a real thing of this sub-account.
    expect((await t.api.post('/api/ab-tests', { page_id: start.id })).status).toBe(400);
    expect((await t.api.patch(`/api/ab-tests/${test.id}`, { goal: { type: 'form', form_id: 'nope' } })).status).toBe(400);
    expect((await t.api.patch(`/api/ab-tests/${test.id}`, { goal: { type: 'page', page_id: start.id } })).status).toBe(400);
    // Variant B gets its own content; A stays the live page.
    const b = byKey(test, 'B');
    const saved = await t.api.patch(`/api/ab-variants/${b.id}`, {
      name: 'Neue Headline',
      blocks: [
        { type: 'hero', heading: 'Variante-B-Überschrift' },
        { type: 'form', form_id: form.id },
      ],
    });
    expect(saved.data).toMatchObject({ name: 'Neue Headline', key: 'B' });
    expect((await t.api.patch(`/api/ab-variants/${byKey(test, 'A').id}`, { blocks: [] })).status).toBe(400);
    const preview = await t.api.post(`/api/ab-variants/${b.id}/preview`, {});
    expect(preview.data).toContain('Variante-B-Überschrift');
    // Weights must add up to 100.
    expect((await t.api.patch(`/api/ab-tests/${test.id}`, { weights: { [b.id]: 70 } })).status).toBe(400);
    // Not started yet: everyone sees the original, no cookie.
    const v = await visit(`/p/${funnel.slug}`);
    expect(shownVariant(v.html)).toBe('A');
    expect(v.setCookie).toBe('');
  });

  it('assigns visitors by weight and keeps them on their variant (cookie)', async () => {
    expect((await t.api.post(`/api/ab-tests/${test.id}/start`)).data.status).toBe('running');
    const first = await visit(`/p/${funnel.slug}`);
    expect(first.setCookie).toMatch(/pghl_ab=[A-Za-z0-9]{20}; Path=\/; SameSite=Lax; HttpOnly; Max-Age=15552000/);
    expect(first.cache).toBe('private, no-store');
    const mine = shownVariant(first.html);
    expect(['A', 'B']).toContain(mine);
    for (let i = 0; i < 5; i++) expect(shownVariant((await visit(`/p/${funnel.slug}`, first.cookie)).html)).toBe(mine);
    let s = await stats();
    expect(byKey(s, mine)).toMatchObject({ visitors: 1, views: 6 });

    // 300 new visitors at 50/50.
    const count = { A: 0, B: 0 } as Record<string, number>;
    for (let i = 0; i < 300; i++) count[shownVariant((await visit(`/p/${funnel.slug}/start`)).html)]++;
    expect(count.A + count.B).toBe(300);
    expect(count.A).toBeGreaterThan(110);
    expect(count.B).toBeGreaterThan(110);
    s = await stats();
    expect(byKey(s, 'A').visitors + byKey(s, 'B').visitors).toBe(301);

    // 80/20 from now on.
    const before = { A: byKey(s, 'A').visitors, B: byKey(s, 'B').visitors };
    await t.api.patch(`/api/ab-tests/${test.id}`, { weights: { [byKey(s, 'A').id]: 80, [byKey(s, 'B').id]: 20 } });
    for (let i = 0; i < 300; i++) await visit(`/p/${funnel.slug}`);
    s = await stats();
    const newB = byKey(s, 'B').visitors - before.B;
    expect(byKey(s, 'A').visitors - before.A + newB).toBe(300);
    expect(newB).toBeGreaterThan(30);
    expect(newB).toBeLessThan(95);
    expect(s.small_sample).toBe(true); // no conversions yet
  });

  it('does not count bots or prefetches', async () => {
    const s0 = await stats();
    const bot = await visit(`/p/${funnel.slug}`, '', BOT);
    expect(bot.setCookie).toBe('');
    expect(shownVariant(bot.html)).toBe('A');
    const pre = await visit(`/p/${funnel.slug}`, '', UA, { 'sec-purpose': 'prefetch' });
    expect(pre.setCookie).toBe('');
    const s1 = await stats();
    expect(s1.visitors).toBe(s0.visitors);
    expect(byKey(s1, 'A').views + byKey(s1, 'B').views).toBe(byKey(s0, 'A').views + byKey(s0, 'B').views);
  });

  let buyer: { cookie: string; visitor: string; variant: string };
  it('counts a form submit once for the visitor’s variant and logs it on the contact', async () => {
    const v = await visit(`/p/${funnel.slug}`);
    buyer = { cookie: v.cookie, visitor: v.visitor, variant: shownVariant(v.html) };
    expect(v.html).toContain(`<input type="hidden" name="_ab" value="${v.visitor}">`);
    const before = byKey(await stats(), buyer.variant).conversions;
    const sub = await t.api.post(`/api/public/forms/${form.id}/submit`, { first_name: 'Vera', email: 'vera@x.de', consent: 'ja', _ab: v.visitor });
    expect(sub.status).toBe(200);
    await t.app.events.flush();
    let s = await stats();
    expect(byKey(s, buyer.variant).conversions).toBe(before + 1);
    expect(s.conversions).toBe(1);
    // Again (same visitor) or with an unknown id: no new conversion.
    await t.api.post(`/api/public/forms/${form.id}/submit`, { first_name: 'Vera', email: 'vera@x.de', consent: 'ja', _ab: v.visitor });
    await t.api.post(`/api/public/forms/${form.id}/submit`, { first_name: 'Max', email: 'max@x.de', consent: 'ja', _ab: 'zzzzzzzzzzzzzzzzzzzz' });
    await t.app.events.flush();
    s = await stats();
    expect(s.conversions).toBe(1);
    const contact = (await t.api.get(`/api/contacts/${sub.data.contactId}`)).data;
    const line = contact.activities.find((a: any) => a.type === 'ab.converted');
    expect(line.summary).toContain(`A/B-Test „Test: Opt-in“: Variante ${buyer.variant}`);
    expect(line.summary).toContain('Formular abgeschickt');
  });

  it('counts the visit of a goal page for visitors who saw the test page', async () => {
    await t.api.patch(`/api/ab-tests/${test.id}`, { goal: { type: 'page', page_id: danke.id } });
    const c0 = (await stats()).conversions;
    // Seen the test page first → counts, once.
    const v = await visit(`/p/${funnel.slug}`);
    await visit(`/p/${funnel.slug}/danke`, v.cookie);
    await visit(`/p/${funnel.slug}/danke`, v.cookie);
    expect((await stats()).conversions).toBe(c0 + 1);
    // Never saw the test page → nothing.
    await visit(`/p/${funnel.slug}/danke`);
    expect((await stats()).conversions).toBe(c0 + 1);
    // Goal by URL works too.
    await t.api.patch(`/api/ab-tests/${test.id}`, { goal: { type: 'page', url: `http://localhost/p/${funnel.slug}/danke/` } });
    const w = await visit(`/p/${funnel.slug}`);
    await visit(`/p/${funnel.slug}/danke`, w.cookie);
    expect((await stats()).conversions).toBe(c0 + 2);
  });

  it('attributes a booking through the calendar widget', async () => {
    const cal = (
      await t.api.post('/api/calendars', {
        name: 'Erstgespräch AB',
        duration: 30,
        min_notice: 0,
        availability: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]])),
      })
    ).data;
    const f2 = (await t.api.post('/api/funnels', { name: 'Termin-Funnel', template: 'booking' })).data;
    const p2 = f2.pages[0];
    await t.api.patch(`/api/funnel-pages/${p2.id}`, {
      blocks: [
        { type: 'hero', heading: 'Original-Überschrift' },
        { type: 'calendar', calendar_slug: cal.slug },
      ],
    });
    const t2 = (await t.api.post('/api/ab-tests', { page_id: p2.id, name: 'Termin', goal: { type: 'booking', calendar_id: cal.id } })).data;
    await t.api.post(`/api/ab-tests/${t2.id}/start`);
    const v = await visit(`/p/${f2.slug}`);
    expect(v.html).toContain(`/book/${cal.slug}?embed=1&amp;ab=${v.visitor}`);
    const widget = await (await t.api.raw(`/book/${cal.slug}?embed=1&ab=${v.visitor}`)).text();
    expect(widget).toContain("get('ab')");
    const slot = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?days=2`)).data.days.flatMap((d: any) => d.slots)[0];
    const booked = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start: slot, first_name: 'Bea', email: 'bea@x.de', _ab: v.visitor });
    expect(booked.status).toBe(200);
    await t.app.events.flush();
    const s = (await t.api.get(`/api/ab-tests/${t2.id}`)).data;
    expect(s.conversions).toBe(1);
    const appt = (await t.api.get('/api/appointments')).data[0];
    const acts = (await t.api.get(`/api/contacts/${appt.contact_id}`)).data.activities.map((a: any) => a.summary).join('\n');
    expect(acts).toContain('A/B-Test „Termin“');
    expect(acts).toContain('Termin gebucht');
  });

  it('attributes a Stripe purchase from a buy link on the page', async () => {
    await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
    const prod = (await t.api.post('/api/products', { name: 'Kurs', price_cents: 10000, tax_rate: 19 })).data;
    await t.api.put(`/api/stripe/products/${prod.id}`, { slug: 'kurs-ab' });
    const f3 = (await t.api.post('/api/funnels', { name: 'Sales', template: 'blank' })).data;
    const p3 = f3.pages[0];
    await t.api.patch(`/api/funnel-pages/${p3.id}`, { blocks: [{ type: 'hero', heading: 'Original-Überschrift', button_text: 'Jetzt kaufen', button_url: 'http://localhost/buy/kurs-ab' }] });
    const t3 = (await t.api.post('/api/ab-tests', { page_id: p3.id, name: 'Sales', goal: { type: 'purchase', product_id: prod.id } })).data;
    await t.api.post(`/api/ab-tests/${t3.id}/start`);
    const v = await visit(`/p/${f3.slug}`);
    // the attribution module may append its own visit token (&_a=…) to the same link
    expect(v.html).toMatch(new RegExp(`href="http://localhost/buy/kurs-ab\\?ab=${v.visitor}(&_a=[^"]+)?"`));
    const buy = await (await t.api.raw(`/buy/kurs-ab?ab=${v.visitor}`)).text();
    expect(buy).toContain(`<input type="hidden" name="ab" value="${v.visitor}">`);
    const go = await t.api.raw('/buy/kurs-ab', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `ab=${v.visitor}` });
    expect(go.status).toBe(303);
    expect(stripeCalls[stripeCalls.length - 1].get('metadata[ab]')).toBe(v.visitor);
    const sid = go.headers.get('location')!.split('/').pop()!;
    const raw = JSON.stringify({
      id: 'evt_ab_1',
      type: 'checkout.session.completed',
      data: { object: { ...sessions.get(sid), status: 'complete', payment_status: 'paid', payment_intent: 'pi_ab', customer_details: { email: 'kaeufer@x.de' } } },
    });
    const hook = await t.api.raw(`/hooks/stripe/${t.api.location}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
    expect((await hook.json()).handled).toBe('product_purchased');
    await t.app.events.flush();
    expect((await t.api.get(`/api/ab-tests/${t3.id}`)).data.conversions).toBe(1);
  });

  it('shows the original while paused and counts nothing', async () => {
    const s0 = await stats();
    await t.api.post(`/api/ab-tests/${test.id}/pause`);
    const known = await visit(`/p/${funnel.slug}`, buyer.cookie);
    expect(shownVariant(known.html)).toBe('A');
    const fresh = await visit(`/p/${funnel.slug}`);
    expect(fresh.setCookie).toBe('');
    expect(shownVariant(fresh.html)).toBe('A');
    const s1 = await stats();
    expect(s1.status).toBe('paused');
    expect(s1.visitors).toBe(s0.visitors);
    await t.api.post(`/api/ab-tests/${test.id}/start`);
  });

  it('makes the winner the live page and archives the rest', async () => {
    const s = await stats();
    const b = byKey(s, 'B');
    const r = await t.api.post(`/api/ab-tests/${test.id}/winner`, { variant_id: b.id });
    expect(r.data).toMatchObject({ status: 'ended', winner_id: b.id });
    expect(byKey(r.data, 'A')).toMatchObject({ archived: true });
    expect(byKey(r.data, 'B')).toMatchObject({ archived: false });
    expect(byKey(r.data, 'A').blocks[0].heading).toBe('Original-Überschrift'); // old content kept on A
    const page = (await t.api.get(`/api/funnels/${funnel.id}`)).data.pages.find((p: any) => p.id === start.id);
    expect(page.blocks[0].heading).toBe('Variante-B-Überschrift');
    const v = await visit(`/p/${funnel.slug}`, buyer.cookie);
    expect(shownVariant(v.html)).toBe('B');
    expect(v.html).not.toContain('name="_ab"');
    expect((await t.api.post(`/api/ab-tests/${test.id}/winner`, { variant_id: b.id })).status).toBe(400);
    expect((await t.api.patch(`/api/ab-variants/${b.id}`, { name: 'x' })).status).toBe(400);
    // A new test on the same page is possible again.
    const next = await t.api.post('/api/ab-tests', { page_id: start.id, goal: { type: 'form' } });
    expect(next.status).toBe(200);
    expect(byKey(next.data, 'B').blocks[0].heading).toBe('Variante-B-Überschrift');
    expect((await t.api.post(`/api/ab-tests/${next.data.id}/variants`, {})).data.variants.map((x: any) => [x.key, x.weight])).toEqual([
      ['A', 34],
      ['B', 33],
      ['C', 33],
    ]);
    expect((await t.api.del(`/api/ab-tests/${next.data.id}`)).status).toBe(200);
  });

  it('reports results through MCP and keeps routes in the funnels area', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
    const r = await t.api.raw('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ghl_ab_test_results', arguments: { location_id: t.api.location, test_id: test.id } } }),
    });
    const out = JSON.parse((await r.json()).result.content[0].text);
    expect(out).toMatchObject({ id: test.id, status: 'ended', goal_label: 'Zielseite besucht' });
    expect(out.variants[0]).toHaveProperty('prob_beat');
    expect(out.variants[0]).not.toHaveProperty('blocks');
    const list = await t.api.get(`/api/ab-tests?funnel_id=${funnel.id}`);
    expect(list.data.length).toBe(1);
    const { requiredPermission } = await import('../server/core/permissions.js');
    expect(requiredPermission('POST', '/api/ab-tests')).toBe('funnels');
    expect(requiredPermission('PATCH', '/api/ab-variants/x')).toBe('funnels');
    // Deleting the page removes its tests.
    await t.api.del(`/api/funnel-pages/${start.id}`);
    expect((await t.api.get(`/api/ab-tests/${test.id}`)).status).toBe(404);
  });
});
