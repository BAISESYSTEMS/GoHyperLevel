import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { connectStripe, fakeStripe, pay } from './site-fixtures.js';
import { beatToken, buildSteps, deviceOf, rangeOf, readBeat, sourceWord, totalsOf, visitorKey } from '../server/services/site-analytics.js';
import { addDaysYmd } from '../server/core/time.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const stripe = fakeStripe();
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  await connectStripe(t);
});
afterAll(() => t.close());

const ua = (n: string) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Safari/605.1.15 Besucher-${n}`;
const visit = async (path: string, who: string, extra: Record<string, string> = {}) => {
  const r = await t.api.raw(path, { headers: { 'user-agent': ua(who), ...extra } });
  return { status: r.status, html: await r.text() };
};
const report = async (fid: string, q = '') => (await t.api.get(`/api/funnels/${fid}/analytics${q}`)).data;

describe('analytics helpers', () => {
  it('visitors are anonymous: same within a day, never the same across days, addresses or sites', () => {
    const a = visitorKey('s', '2026-10-05', 'f1', '1.2.3.4', 'UA');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(visitorKey('s', '2026-10-05', 'f1', '1.2.3.4', 'UA')).toBe(a);
    expect(visitorKey('s', '2026-10-06', 'f1', '1.2.3.4', 'UA')).not.toBe(a);
    expect(visitorKey('s', '2026-10-05', 'f1', '1.2.3.5', 'UA')).not.toBe(a);
    expect(visitorKey('s', '2026-10-05', 'f2', '1.2.3.4', 'UA')).not.toBe(a);
    expect(a).not.toContain('1.2.3.4');
  });

  it('knows devices, signs beacons and reads ranges', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148')).toBe('phone');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe('phone');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X900) Safari/537.36')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126')).toBe('desktop');
    const tok = beatToken('s', 'page1', 'vis', '2026-10-05');
    expect(readBeat('s', tok)).toEqual({ pageId: 'page1', visitor: 'vis', day: '2026-10-05' });
    expect(readBeat('x', tok)).toBeUndefined();
    expect(readBeat('s', tok.replace('page1', 'page2'))).toBeUndefined();
    expect(readBeat('s', 'kaputt')).toBeUndefined();
    expect(rangeOf(null, null, '2026-10-05', addDaysYmd)).toEqual({ from: '2026-09-06', to: '2026-10-05' });
    expect(rangeOf('2026-01-01', '2026-01-31', '2026-10-05', addDaysYmd)).toEqual({ from: '2026-01-01', to: '2026-01-31' });
    expect(rangeOf('2020-01-01', '2026-10-05', '2026-10-05', addDaysYmd).from).toBe('2025-10-05');
    expect(rangeOf('2026-12-01', '2026-10-05', '2026-10-05', addDaysYmd)).toEqual({ from: '2026-10-05', to: '2026-10-05' });
    expect(sourceWord('direct', '(none)')).toBe('direkt');
    expect(sourceWord('google', 'organic')).toBe('google (Suche)');
    expect(sourceWord('newsletter', 'email')).toBe('newsletter');
  });

  it('turns counts into rates; the last step cannot drop off', () => {
    const rows = [
      { page_id: 'a', name: 'Opt-in', slug: 'a', position: 0, views: 120, visitors: 100, entries: 100, continued: 40, seconds: 3000, seconds_n: 50, scroll: 3500, scroll_n: 50 },
      { page_id: 'b', name: 'Danke', slug: 'b', position: 1, views: 45, visitors: 40, entries: 0, continued: 0, seconds: 0, seconds_n: 0, scroll: 0, scroll_n: 0 },
    ];
    const steps = buildSteps(rows, [{ page_id: 'a', kind: 'form', n: 38, cents: 0 }, { page_id: 'b', kind: 'purchase', n: 4, cents: 40000 }]);
    expect(steps[0]).toMatchObject({ visitors: 100, continued: 40, continue_rate: 0.4, drop_off: 0.6, avg_seconds: 60, avg_scroll: 70 });
    expect(steps[0].conversions).toEqual({ form: 38, booking: 0, purchase: 0, total: 38 });
    expect(steps[0].conv_rate).toBeCloseTo(0.38);
    expect(steps[1]).toMatchObject({ drop_off: 0, continued: 0, revenue_cents: 40000, avg_seconds: 0 });
    const tot = totalsOf(steps, 100);
    expect(tot).toMatchObject({ visitors: 100, views: 165, conversions: 42, revenue_cents: 40000 });
    expect(tot.reach_last).toBeCloseTo(0.4);
    expect(tot.conv_rate).toBeCloseTo(0.42);
    expect(totalsOf([], 0)).toMatchObject({ visitors: 0, reach_last: 0, conv_rate: 0 });
  });
});

describe('counting visits per step', () => {
  it('counts visitors, views, continuation and drop-off; bots, Do Not Track and previews do not count', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Zähl-Funnel', template: 'leadmagnet' })).data;
    const [start, danke] = f.pages;
    // three visitors: A goes to both pages (and reloads the first), B only to the first, C only to the first
    await visit(`/p/${f.slug}/${start.slug}`, 'A');
    await visit(`/p/${f.slug}/${start.slug}`, 'A');
    await visit(`/p/${f.slug}/${danke.slug}`, 'A');
    await visit(`/p/${f.slug}/${start.slug}`, 'B');
    await visit(`/p/${f.slug}/${start.slug}`, 'C', { referer: 'https://www.google.com/search?q=x' });
    // not counted
    await visit(`/p/${f.slug}/${start.slug}`, 'bot', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    await visit(`/p/${f.slug}/${start.slug}`, 'D', { dnt: '1' });
    await visit(`/p/${f.slug}/${start.slug}`, 'E', { 'sec-gpc': '1' });
    await visit(`/p/${f.slug}/${start.slug}`, 'F', { 'sec-purpose': 'prefetch' });
    await t.api.post(`/api/funnel-pages/${start.id}/preview`, { blocks: [] });
    await visit(`/p/${f.slug}/gibt-es-nicht`, 'G');

    const r = await report(f.id);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]).toMatchObject({ name: 'Opt-in', visitors: 3, views: 4, entries: 3, continued: 1 });
    expect(r.steps[0].continue_rate).toBeCloseTo(1 / 3);
    expect(r.steps[0].drop_off).toBeCloseTo(2 / 3);
    expect(r.steps[1]).toMatchObject({ name: 'Danke', visitors: 1, views: 1, entries: 0, drop_off: 0 });
    expect(r.totals).toMatchObject({ visitors: 3, views: 5 });
    expect(r.totals.reach_last).toBeCloseTo(1 / 3);
    expect(r.sources).toEqual(expect.arrayContaining([{ source: 'google (Suche)', visitors: 1 }, { source: 'direkt', visitors: 2 }]));
    expect(r.devices).toMatchObject({ desktop: 3, phone: 0 });
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0].visitors).toBe(3);

    // nothing about a person is stored
    const rows = t.app.db.all('SELECT * FROM site_hits WHERE funnel_id = ?', f.id);
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1');
    expect(JSON.stringify(rows)).not.toContain('Besucher-A');
    expect(rows.every((x: any) => /^[0-9a-f]{16}$/.test(x.visitor))).toBe(true);

    // a range with no visits is empty, not an error
    const none = await report(f.id, '?from=2020-01-01&to=2020-01-31');
    expect(none.totals).toMatchObject({ visitors: 0, views: 0 });
    expect(none.steps.map((s: any) => s.visitors)).toEqual([0, 0]);
    // CSV
    const csv = await t.api.raw(`/api/funnels/${f.id}/analytics.csv`, { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location, 'x-pghl': '1' } });
    const text = await csv.text();
    expect(csv.headers.get('content-disposition')).toContain('funnel-zahl-funnel');
    expect(text).toContain('Schritt,Seite,Aufrufe,Besucher');
    expect(text).toContain('Opt-in');
  });

  it('can be switched off per site, and answers to the setting for Do Not Track', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Ohne Zählung', template: 'blank' })).data;
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { analytics: { enabled: false } } });
    const off = await visit(`/p/${f.slug}`, 'H');
    expect(off.html).not.toContain('sendBeacon');
    expect((await report(f.id)).totals.views).toBe(0);
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { analytics: { enabled: true, respect_dnt: false } } });
    await visit(`/p/${f.slug}`, 'I', { dnt: '1' });
    expect((await report(f.id)).totals.views).toBe(1);
  });

  it('adds time on page and scroll depth from the signed beacon – and refuses forged ones', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Zeit-Funnel', template: 'blank' })).data;
    const v = await visit(`/p/${f.slug}`, 'J');
    const token = /sendBeacon.*?k=("[^"]+")|k=("[^"]+")/s.exec(v.html)?.[0] && /k=("([^"]+)")/.exec(v.html)![2];
    expect(token).toBeTruthy();
    expect((await t.api.post('/api/public/site/beat', { k: token, s: 42, m: 80 })).data).toEqual({ ok: true });
    expect((await t.api.post('/api/public/site/beat', { k: token, s: 10, m: 20 })).data).toEqual({ ok: true });
    let r = await report(f.id);
    expect(r.steps[0]).toMatchObject({ avg_seconds: 42, avg_scroll: 80 });
    await t.api.post('/api/public/site/beat', { k: token, s: 99999, m: 500 });
    r = await report(f.id);
    expect(r.steps[0].avg_seconds).toBe(1800);
    expect(r.steps[0].avg_scroll).toBe(100);
    expect((await t.api.post('/api/public/site/beat', { k: `${token}x`, s: 50, m: 50 })).data).toEqual({ ok: false });
    expect((await t.api.post('/api/public/site/beat', { k: String(token).replace(/\.[0-9a-f]{16}$/, '.0000000000000000'), s: 50 })).data).toEqual({ ok: false });
    expect((await t.api.post('/api/public/site/beat', {})).data).toEqual({ ok: false });
  });
});

describe('counting conversions per step', () => {
  it('counts a form on the page, a booking through its calendar and a purchase through the product block – with revenue', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Umsatz-Funnel', template: 'blank' })).data;
    const p1 = f.pages[0];
    const p2 = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Kasse', slug: 'kasse' })).data;
    const p3 = (await t.api.post(`/api/funnels/${f.id}/pages`, { name: 'Termin', slug: 'termin' })).data;
    const form = (await t.api.post('/api/forms', { name: 'Funnel-Formular' })).data;
    const prod = (await t.api.post('/api/products', { name: 'Kurs', price_cents: 10000, tax_rate: 19 })).data;
    await t.api.put(`/api/stripe/products/${prod.id}`, { slug: 'kurs-funnel' });
    const cal = (await t.api.post('/api/calendars', { name: 'Funnel-Termin', duration: 30, min_notice: 0, availability: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]])) })).data;
    await t.api.patch(`/api/funnel-pages/${p1.id}`, { blocks: [{ type: 'form', form_id: form.id, heading: 'Eintragen' }] });
    await t.api.patch(`/api/funnel-pages/${p2.id}`, { blocks: [{ type: 'product', product_id: prod.id }] });
    await t.api.patch(`/api/funnel-pages/${p3.id}`, { blocks: [{ type: 'calendar', calendar_slug: cal.slug }] });

    // form: the submission carries the page address
    await visit(`/p/${f.slug}`, 'K');
    const sub = await t.api.post(`/api/public/forms/${form.id}/submit`, { email: 'lead@example.com', first_name: 'Lea', consent: 'ja', _page: `http://localhost/p/${f.slug}` });
    expect(sub.status).toBe(200);
    // the same form on another page's address does not count for this funnel
    await t.api.post(`/api/public/forms/${form.id}/submit`, { email: 'lead2@example.com', first_name: 'Leo', consent: 'ja', _page: 'http://localhost/p/gibt-es-nicht' });
    await t.api.post(`/api/public/forms/${form.id}/submit`, { email: 'lead3@example.com', first_name: 'Lia', consent: 'ja', _page: 'https://fremd.example/p/x' });

    // purchase: product block → buy page → checkout → paid
    const page = await visit(`/p/${f.slug}/kasse`, 'K');
    const href = /href="(http:\/\/localhost\/buy\/[^"]+)"/.exec(page.html)![1].replace(/&amp;/g, '&');
    expect(href).toContain(`fp=${p2.id}`);
    expect(page.html).toContain('Zur Bestellung');
    const buy = await (await t.api.raw(href.replace('http://localhost', ''))).text();
    expect(buy).toContain(`<input type="hidden" name="fp" value="${p2.id}">`);
    const go = await t.api.raw(`/buy/${prod.id}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `fp=${p2.id}` });
    expect(go.status).toBe(303);
    const sid = go.headers.get('location')!.split('/').pop()!;
    expect(stripe.sessions.get(sid).metadata.fp).toBe(p2.id);
    expect((await pay(t, stripe.sessions.get(sid), 'kaeufer@example.com')).handled).toBe('product_purchased');
    // the same payment arriving again is not counted twice
    await pay(t, stripe.sessions.get(sid), 'kaeufer@example.com');

    // booking: counted for the page that embeds the calendar
    await visit(`/p/${f.slug}/termin`, 'K');
    const slot = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?days=2`)).data.days.flatMap((d: any) => d.slots)[0];
    expect((await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start: slot, first_name: 'Bea', email: 'bea@example.com' })).status).toBe(200);
    await t.app.events.flush();

    const r = await report(f.id);
    const [s1, s2, s3] = r.steps;
    expect(s1.conversions).toMatchObject({ form: 1, total: 1 });
    expect(s2.conversions).toMatchObject({ purchase: 1, total: 1 });
    expect(s2.revenue_cents).toBe(11900);
    expect(s3.conversions).toMatchObject({ booking: 1, total: 1 });
    expect(r.totals).toMatchObject({ conversions: 3, revenue_cents: 11900 });
    expect(s1.conv_rate).toBeCloseTo(1);
    expect(r.attribution).toMatchObject({ first: { revenue_cents: expect.any(Number) }, last: { leads: expect.any(Number) } });
  });

  it('shows the A/B test of a step next to its numbers', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'AB-Funnel', template: 'leadmagnet' })).data;
    const form = (await t.api.post('/api/forms', { name: 'AB-Formular' })).data;
    await t.api.patch(`/api/funnel-pages/${f.pages[0].id}`, { blocks: [{ type: 'hero', heading: 'Original' }, { type: 'form', form_id: form.id }] });
    const test = (await t.api.post('/api/ab-tests', { page_id: f.pages[0].id, name: 'Überschrift', goal: { type: 'form', form_id: form.id } })).data;
    await t.api.post(`/api/ab-tests/${test.id}/start`);
    const r = await report(f.id);
    expect(r.steps[0].ab).toMatchObject({ name: 'Überschrift', status: 'running' });
    expect(r.steps[0].ab.variants.map((v: any) => v.key)).toEqual(['A', 'B']);
    expect(r.steps[1].ab).toBeNull();
  });
});

describe('overview, widget, tool and retention', () => {
  it('compares all funnels, offers a board widget and an MCP tool', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Übersicht-Funnel', template: 'leadmagnet' })).data;
    await visit(`/p/${f.slug}/${f.pages[0].slug}`, 'L');
    await visit(`/p/${f.slug}/${f.pages[0].slug}`, 'M');
    await visit(`/p/${f.slug}/${f.pages[1].slug}`, 'M');
    const o = (await t.api.get('/api/funnel-analytics?days=7')).data;
    const row = o.funnels.find((x: any) => x.id === f.id);
    expect(row).toMatchObject({ name: 'Übersicht-Funnel', pages: 2, visitors: 2, views: 3 });
    expect(row.reach_last).toBeCloseTo(0.5);
    const widget = (await t.api.get('/api/boards/widgets')).data.widgets.find((w: any) => w.type === 'funnel_overview');
    expect(widget).toMatchObject({ source: 'site-analytics', access: '/api/funnels', category: 'zahlen' });
    // the widget on a board shows the table
    const board = (await t.api.post('/api/boards', { name: 'Funnels' })).data;
    const patched = await t.api.post(`/api/boards/${board.id}/patch`, { ops: [{ op: 'add', type: 'funnel_overview', config: { range: '7' } }] });
    expect(patched.status).toBe(200);
    const wid = (await t.api.get(`/api/boards/${board.id}`)).data.spec.widgets[0].id;
    const data = (await t.api.get(`/api/boards/${board.id}/data`)).data.data[wid];
    expect(data.view).toMatchObject({ kind: 'table', title: 'Funnel-Auswertung' });
    expect(data.view.rows.find((r: any) => r.name === 'Übersicht-Funnel')).toMatchObject({ visitors: 2 });
    expect(t.app.services.mcpTools.some((x: any) => x.name === 'ghl_funnel_analytics')).toBe(true);
  });

  it('deletes counts older than the retention', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Aufbewahrung', template: 'blank' })).data;
    await t.api.patch(`/api/funnels/${f.id}`, { settings: { analytics: { retention_days: 30 } } });
    const insert = (day: string) => t.app.db.run(`INSERT INTO site_hits (funnel_id, location_id, page_id, visitor, day, views, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, 'x', 'x')`, f.id, t.api.location, f.pages[0].id, `v${day}`, day);
    const day = (ago: number) => new Date(Date.now() - ago * 864e5).toISOString().slice(0, 10);
    insert(day(5));
    insert(day(40));
    insert(day(400));
    await t.app.tick();
    const left = t.app.db.all('SELECT day FROM site_hits WHERE funnel_id = ?', f.id).map((r: any) => r.day);
    expect(left).toEqual([day(5)]);
  });

  it('keeps one site\'s numbers away from another sub-account', async () => {
    const f = (await t.api.post('/api/funnels', { name: 'Geheim-Funnel', template: 'blank' })).data;
    await visit(`/p/${f.slug}`, 'N');
    const other = (await t.api.post('/api/locations', { name: 'Konkurrenz' })).data.id;
    expect((await t.api.get(`/api/funnels/${f.id}/analytics`, { 'x-location-id': other })).status).toBe(404);
    expect((await t.api.get('/api/funnel-analytics', { 'x-location-id': other })).data.funnels).toEqual([]);
  });
});
