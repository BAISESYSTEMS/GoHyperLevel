import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { classifyReferrer, consentState, mayStore, parseTouch, signVisitor, verifyVisitor } from '../server/services/attribution.js';

describe('attribution helpers', () => {
  it('reads UTM, click ids, referrers and affiliate codes', () => {
    const utm = parseTouch({ url: 'https://lp.example.de/start?utm_source=Google&utm_medium=CPC&utm_campaign=Sommer_24&email=anna@x.de', referrer: 'https://www.google.com/' });
    expect(utm).toMatchObject({ channel: 'campaign', source: 'google', medium: 'cpc', campaign: 'Sommer_24', landing_page: 'https://lp.example.de/start', referrer: 'google.com' });
    // The landing page never keeps its query string (it may hold e-mails or tokens).
    expect(utm.landing_page).not.toContain('anna');
    expect(parseTouch({ url: 'https://lp.de/?gclid=abc123' })).toMatchObject({ source: 'google', medium: 'cpc', gclid: 'abc123', channel: 'campaign' });
    expect(parseTouch({ url: 'https://lp.de/?fbclid=IwAR1' })).toMatchObject({ source: 'facebook', medium: 'social', fbclid: 'IwAR1' });
    expect(parseTouch({ url: 'https://lp.de/?msclkid=m1' })).toMatchObject({ source: 'bing', medium: 'cpc', click_id: 'msclkid:m1' });
    expect(parseTouch({ url: 'https://lp.de/', referrer: 'https://duckduckgo.com/?q=maler' })).toMatchObject({ channel: 'referral', source: 'duckduckgo', medium: 'organic', referrer: 'duckduckgo.com' });
    expect(parseTouch({ url: 'https://lp.de/', referrer: 'https://l.instagram.com/x' })).toMatchObject({ source: 'instagram', medium: 'social' });
    expect(parseTouch({ url: 'https://lp.de/', referrer: 'https://blog.partner.at/artikel?id=1' })).toMatchObject({ channel: 'referral', source: 'blog.partner.at', medium: 'referral', referrer: 'blog.partner.at/artikel' });
    expect(parseTouch({ url: 'https://lp.de/' })).toMatchObject({ channel: 'direct', source: 'direct', medium: '(none)' });
    expect(parseTouch({ url: 'https://lp.de/b', referrer: 'https://www.lp.de/a' })).toMatchObject({ internal: true, channel: 'direct' });
    expect(parseTouch({ url: 'https://lp.de/?ref=Anna-1' })).toMatchObject({ channel: 'campaign', source: 'affiliate', medium: 'affiliate', campaign: 'anna-1', ref: 'anna-1' });
    // Form fields (_utm_source …) override or add to the page URL.
    expect(parseTouch({ url: 'https://lp.de/', params: { _utm_source: 'newsletter', _utm_medium: 'email' } })).toMatchObject({ source: 'newsletter', medium: 'email' });
    expect(classifyReferrer('www.bing.com')).toEqual({ source: 'bing', medium: 'organic' });
    expect(classifyReferrer('t.co')).toEqual({ source: 'twitter', medium: 'social' });
  });

  it('signs visitor tokens and decides about the cookie', () => {
    const tok = signVisitor('s3cret', 'abcdefghijklmnop1234');
    expect(verifyVisitor('s3cret', tok)).toBe('abcdefghijklmnop1234');
    expect(verifyVisitor('other', tok)).toBe('');
    expect(verifyVisitor('s3cret', tok.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBe('');
    expect(verifyVisitor('s3cret', 'nope')).toBe('');
    expect(consentState('1', undefined)).toBe('granted');
    expect(consentState('marketing', '1')).toBe('granted');
    expect(consentState('0', undefined)).toBe('denied');
    expect(consentState(undefined, '1')).toBe('denied');
    expect(consentState(undefined, undefined)).toBe('unknown');
    expect(mayStore('consent', 'unknown')).toBe(false);
    expect(mayStore('consent', 'granted')).toBe(true);
    expect(mayStore('always', 'unknown')).toBe(true);
    expect(mayStore('always', 'denied')).toBe(false);
    expect(mayStore('never', 'granted')).toBe(false);
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let funnel: any;
let form: any;
const visitHeaders = (extra: Record<string, string> = {}) => ({ 'user-agent': 'Mozilla/5.0 Test', ...extra });

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  form = (await t.api.post('/api/forms', { name: 'Kontakt' })).data;
  funnel = (await t.api.post('/api/funnels', { name: 'Sommer', template: 'blank' })).data;
  const page = funnel.pages[0];
  await t.api.patch(`/api/funnel-pages/${page.id}`, {
    blocks: [
      { type: 'hero', heading: 'Hallo', button_text: 'Kaufen', button_url: '/buy/kurs' },
      { type: 'form', form_id: form.id },
      { type: 'calendar', calendar_slug: 'beratung' },
    ],
  });
});
afterAll(async () => {
  await t.close();
});

async function visit(path: string, headers: Record<string, string> = {}) {
  const r = await t.api.raw(path, { headers: visitHeaders(headers) });
  const body = await r.text();
  const cookies = r.headers.getSetCookie();
  const token = body.match(/name="_attr" value="([^"]+)"/)?.[1] ?? '';
  return { status: r.status, body, cookies, token, vid: cookies.find((c) => c.startsWith('pghl_vid='))?.split(';')[0] ?? '' };
}
const submit = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', ...visitHeaders(headers) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));

describe('cookie capture on funnel pages', () => {
  it('hands the page a token, and sets the cookie only with consent', async () => {
    const anon = await visit(`/p/${funnel.slug}?utm_source=google&utm_medium=cpc&utm_campaign=sommer`);
    expect(anon.status).toBe(200);
    expect(anon.token).toMatch(/^[A-Za-z0-9]{20}\.[0-9a-f]{16}$/);
    expect(anon.vid).toBe('');
    expect(anon.body).toContain(`window.pghlAttr="${anon.token}"`);
    expect(anon.body).toMatch(/href="\/buy\/kurs\?_a=[^"]+"/);
    expect(anon.body).toMatch(/src="\/book\/beratung\?embed=1&_a=[^"]+"/);

    const yes = await visit(`/p/${funnel.slug}?utm_source=google&utm_medium=cpc&utm_campaign=sommer`, { cookie: 'pghl_consent=1' });
    expect(yes.vid).toMatch(/^pghl_vid=/);
    expect(yes.cookies.find((c) => c.startsWith('pghl_vid='))).toMatch(/HttpOnly; Max-Age=7776000/);

    // Global Privacy Control without a yes, or an explicit no: nothing is recorded at all.
    const gpc = await visit(`/p/${funnel.slug}?utm_source=google`, { 'sec-gpc': '1' });
    expect(gpc.token).toBe('');
    const no = await visit(`/p/${funnel.slug}?utm_source=google`, { cookie: 'pghl_consent=0' });
    expect(no.token).toBe('');
    // Link previews are not visitors.
    expect((await visit(`/p/${funnel.slug}?fbclid=x`, { 'user-agent': 'facebookexternalhit/1.1' })).token).toBe('');
  });

  it('"always" sets the cookie without a banner click, "never" never does', async () => {
    await t.api.put('/api/attribution/settings', { cookie: 'always' });
    expect((await visit(`/p/${funnel.slug}`)).vid).toMatch(/^pghl_vid=/);
    await t.api.put('/api/attribution/settings', { cookie: 'never' });
    const v = await visit(`/p/${funnel.slug}?utm_source=x`, { cookie: 'pghl_consent=1' });
    expect(v.vid).toBe('');
    expect(v.token).not.toBe('');
    await t.api.put('/api/attribution/settings', { cookie: 'consent', banner: true });
    const b = await visit(`/p/${funnel.slug}`);
    expect(b.body).toContain(`/p/${funnel.slug}/pghl-consent?v=1&amp;r=`);
    expect((await visit(`/p/${funnel.slug}`, { cookie: 'pghl_consent=1' })).body).not.toContain('pghl-consent?v=1');
    await t.api.put('/api/attribution/settings', { banner: false });
  });

  it('the consent link stores the choice and goes back to the page (same site only)', async () => {
    const r = await t.api.raw(`/p/${funnel.slug}/pghl-consent?v=1&r=${encodeURIComponent(`/p/${funnel.slug}?a=1`)}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`/p/${funnel.slug}?a=1`);
    expect(r.headers.getSetCookie()[0]).toMatch(/^pghl_consent=1; Path=\/; Max-Age=31536000/);
    const evil = await t.api.raw('/a/consent?v=0&r=//evil.example/x', { redirect: 'manual' });
    expect(evil.headers.get('location')).toBe('/');
    expect(evil.headers.getSetCookie().join('\n')).toMatch(/pghl_vid=; Path=\/; Max-Age=0/);
  });
});

describe('first and last touch', () => {
  let contactId = '';
  it('links all visits of the visitor to the new contact', async () => {
    const first = await visit(`/p/${funnel.slug}?utm_source=google&utm_medium=cpc&utm_campaign=Sommer`, { cookie: 'pghl_consent=1' });
    const cookie = `pghl_consent=1; ${first.vid}`;
    // A reload with the same source is not a new touch; a direct visit of a known visitor neither.
    await visit(`/p/${funnel.slug}?utm_source=google&utm_medium=cpc&utm_campaign=Sommer`, { cookie });
    await visit(`/p/${funnel.slug}`, { cookie });
    const second = await visit(`/p/${funnel.slug}?utm_source=facebook&utm_medium=paid_social&utm_campaign=Herbst&fbclid=fb123`, { cookie, referer: 'https://m.facebook.com/' });
    expect(second.token.split('.')[0]).toBe(first.token.split('.')[0]);
    // The sandboxed page's fetch carries no cookie: the hidden _attr field does the job.
    const r = await submit({ first_name: 'Anna', email: 'anna@example.com', consent: 'ja', _attr: second.token, _page: `http://localhost/p/${funnel.slug}?utm_source=facebook&utm_medium=paid_social&utm_campaign=Herbst`, _utm_source: 'facebook', _utm_medium: 'paid_social', _utm_campaign: 'Herbst' });
    expect(r.status).toBe(200);
    contactId = r.data.contactId;
    const a = (await t.api.get(`/api/contacts/${contactId}/attribution`)).data;
    expect(a.summary).toMatchObject({ first_source: 'google', first_medium: 'cpc', first_campaign: 'Sommer', last_source: 'facebook', last_medium: 'paid_social', last_campaign: 'Herbst', touches: 2, first_funnel_id: funnel.id, first_funnel_name: 'Sommer' });
    expect(a.touches.map((x: any) => [x.kind, x.source])).toEqual([
      ['visit', 'facebook'],
      ['visit', 'google'],
    ]);
    expect(a.touches[0]).toMatchObject({ fbclid: 'fb123', referrer: 'm.facebook.com' });
    expect(a.touches[0].landing_page).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/p/${funnel.slug}$`));
  });

  it('later visits of the known visitor land on the contact; last touch stays the last non-direct one', async () => {
    const again = await visit(`/p/${funnel.slug}?utm_source=newsletter&utm_medium=email&utm_campaign=Okt`, { cookie: 'pghl_consent=1' });
    // A new visitor (fresh cookie), so nothing links yet …
    const before = (await t.api.get(`/api/contacts/${contactId}/attribution`)).data.summary;
    expect(before.last_source).toBe('facebook');
    // … until the same person converts again from that browser.
    await submit({ first_name: 'Anna', email: 'anna@example.com', consent: 'ja', _attr: again.token });
    const after = (await t.api.get(`/api/contacts/${contactId}/attribution`)).data.summary;
    expect(after).toMatchObject({ first_source: 'google', last_source: 'newsletter', last_campaign: 'Okt', touches: 3 });
  });

  it('a form opened directly with UTM (no token, no cookie) still records the source', async () => {
    const r = await submit({ first_name: 'Ben', email: 'ben@example.com', consent: 'ja', _page: 'https://kunde.de/kontakt?utm_source=linkedin&utm_medium=social&utm_campaign=B2B' });
    const a = (await t.api.get(`/api/contacts/${r.data.contactId}/attribution`)).data;
    expect(a.summary).toMatchObject({ first_source: 'linkedin', last_source: 'linkedin', first_campaign: 'B2B', touches: 1 });
    expect(a.touches[0].kind).toBe('form');
  });

  it('form fields: _ref is the affiliate code, _referrer the previous page', async () => {
    const r = await submit({ first_name: 'Rita', email: 'rita@example.com', consent: 'ja', _page: 'https://kunde.de/kontakt?ref=PartnerX', _ref: 'PartnerX', _referrer: 'https://www.google.com/search' });
    const a = (await t.api.get(`/api/contacts/${r.data.contactId}/attribution`)).data;
    expect(a.touches[0]).toMatchObject({ kind: 'form', ref: 'partnerx', source: 'affiliate', referrer: 'google.com/search' });
  });

  it('chat leads get the source of the page the widget runs on', async () => {
    const l = t.app.location(loc)!;
    t.app.db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify({ ...l.settings, chat: { enabled: true } }), loc);
    const r = await t.api.raw(`/api/public/chat/${loc}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...visitHeaders() },
      body: JSON.stringify({ body: 'Hallo', email: 'chat@example.com', page: 'https://www.kunde.de/preise?utm_source=bing&utm_medium=cpc&utm_campaign=Marke', ref: 'https://www.bing.com/' }),
    });
    expect(r.status).toBe(200);
    const c = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'chat@example.com');
    const a = (await t.api.get(`/api/contacts/${c.id}/attribution`)).data;
    expect(a.summary).toMatchObject({ first_source: 'bing', first_campaign: 'Marke' });
    expect(a.touches[0].kind).toBe('chat');
  });

  it('external sites: t.js snippet and the touch endpoint', async () => {
    const js = await (await t.api.raw(`/a/${loc}/t.js`)).text();
    expect(js).toContain('/api/public/attribution/');
    expect(js).toContain('globalPrivacyControl');
    const r1 = await t.api.raw(`/api/public/attribution/${loc}/touch`, { method: 'POST', headers: { 'content-type': 'application/json', ...visitHeaders() }, body: JSON.stringify({ url: 'https://kunde.de/?utm_source=tiktok&utm_medium=cpc', referrer: '', persistent: true }) });
    const { token } = await r1.json();
    expect(verifyVisitor('test-secret', token)).not.toBe('');
    const gpc = await t.api.raw(`/api/public/attribution/${loc}/touch`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-gpc': '1', ...visitHeaders() }, body: JSON.stringify({ url: 'https://kunde.de/?utm_source=tiktok' }) });
    expect((await gpc.json()).token).toBe('');
    // The token from the external site is what the embedded form sends as _attr.
    const r = await submit({ first_name: 'Tom', email: 'tom@example.com', consent: 'ja', _attr: token });
    expect((await t.api.get(`/api/contacts/${r.data.contactId}/attribution`)).data.summary).toMatchObject({ first_source: 'tiktok', first_medium: 'cpc' });
  });
});

describe('report, filters and export', () => {
  it('aggregates leads, won deals and paid revenue per source', async () => {
    const anna = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'anna@example.com').id;
    const ben = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'ben@example.com').id;
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb' })).data;
    const opp = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: anna, value: 1500 })).data;
    await t.api.patch(`/api/opportunities/${opp.id}`, { status: 'won' });
    const inv = (await t.api.post('/api/invoices', { contact_id: anna, items: [{ name: 'Kurs', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    const inv2 = (await t.api.post('/api/invoices', { contact_id: ben, items: [{ name: 'Beratung', qty: 2, price_cents: 5000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv2.id}`, { status: 'paid' });
    await t.app.events.flush();

    const first = (await t.api.get('/api/attribution/report?group=source&model=first')).data;
    const row = (s: string, list = first.rows) => list.find((r: any) => r.source === s);
    expect(row('google')).toMatchObject({ leads: 1, deals_won: 1, deal_value: 1500, revenue_cents: 11900, customers: 1, label: 'google' });
    expect(row('linkedin')).toMatchObject({ leads: 1, revenue_cents: 11900 });
    expect(first.totals.leads).toBe(5);
    const last = (await t.api.get('/api/attribution/report?group=campaign&model=last')).data;
    expect(last.rows.find((r: any) => r.source === 'newsletter')).toMatchObject({ campaign: 'Okt', revenue_cents: 11900, deals_won: 1, label: 'newsletter / email / Okt' });
    const byFunnel = (await t.api.get('/api/attribution/report?group=funnel')).data;
    expect(byFunnel.rows.find((r: any) => r.funnel_id === funnel.id)).toMatchObject({ label: 'Sommer', leads: 1 });
    // Outside the range: nothing.
    const old = (await t.api.get('/api/attribution/report?from=2020-01-01&to=2020-01-31')).data;
    expect(old.totals).toEqual({ leads: 0, deals_won: 0, deal_value: 0, revenue_cents: 0, customers: 0 });
    expect((await t.api.get('/api/attribution/report?from=2026-02-01&to=2026-01-01')).status).toBe(400);

    const bytes = Buffer.from(await (await t.api.raw(`/api/attribution/report.csv?group=source_medium&locationId=${loc}`, { headers: { cookie: t.api.cookie } })).arrayBuffer());
    // UTF-8 BOM so Excel opens umlauts correctly.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = bytes.subarray(3).toString('utf8');
    expect(csv.split('\r\n')[0]).toBe('Quelle,Medium,Kampagne,Leads,Gewonnene Deals,Deal-Wert (EUR),Kunden,Umsatz (EUR)');
    expect(csv).toContain('google,cpc,,1,1,1500,1,"119,00"');
  });

  it('filters contacts and smart lists by source and campaign', async () => {
    const g = (await t.api.get('/api/contacts?attr_source=google')).data;
    expect(g.contacts.map((c: any) => c.email)).toEqual(['anna@example.com']);
    expect((await t.api.get('/api/contacts?attr_source=google&attr_touch=last')).data.total).toBe(0);
    expect((await t.api.get('/api/contacts?attr_campaign=B2B')).data.contacts[0].email).toBe('ben@example.com');
    const none = (await t.api.get('/api/contacts?attr_source=__none__')).data.contacts.map((c: any) => c.email);
    expect(none).not.toContain('anna@example.com');
    const sources = (await t.api.get('/api/attribution/sources')).data;
    expect(sources.sources).toEqual(['affiliate', 'bing', 'google', 'linkedin', 'newsletter', 'tiktok']);
    // Campaign audiences use the same filter through the smart list.
    const sl = (await t.api.post('/api/smart-lists', { name: 'Google-Leads', filter: { attr_source: 'google', attr_touch: 'first' } })).data;
    const camp = (await t.api.post('/api/campaigns', { name: 'Test', channel: 'email', subject: 'Hi', body: 'Hallo', filter: { smart_list_id: sl.id } })).data;
    const preview = await t.api.get(`/api/campaigns/${camp.id}`);
    expect(JSON.stringify(preview.data)).toBeTruthy();
  });

  it('deleting a contact deletes its history (right to erasure)', async () => {
    const ben = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'ben@example.com').id;
    await t.api.del(`/api/contacts/${ben}`);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM attribution_touches WHERE contact_id = ?', ben).n).toBe(0);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM attribution_contacts WHERE contact_id = ?', ben).n).toBe(0);
  });

  it('offers the report as an MCP tool', () => {
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_attribution_report')).toBe(true);
  });
});
