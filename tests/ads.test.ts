import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { startTestApp } from './helpers.js';
import { capiEvent, mapGoogleRow, mapMetaRow, metaLeads, normPhone } from '../server/services/ads.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('ads mapping and CAPI hashing', () => {
  it('maps Meta insights rows (spend in cents, leads from actions)', () => {
    expect(mapMetaRow({ campaign_id: '120', campaign_name: 'Sommer', date_start: '2026-10-01', spend: '12.34', impressions: '1000', clicks: '25', account_currency: 'eur', actions: [{ action_type: 'link_click', value: '25' }, { action_type: 'lead', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' }] })).toEqual({
      campaign_id: '120',
      campaign_name: 'Sommer',
      date: '2026-10-01',
      spend_cents: 1234,
      impressions: 1000,
      clicks: 25,
      leads: 3,
      currency: 'EUR',
    });
    expect(metaLeads([{ action_type: 'onsite_conversion.lead_grouped', value: '4' }, { action_type: 'offsite_conversion.fb_pixel_lead', value: '1' }])).toBe(5);
    expect(metaLeads(undefined)).toBe(0);
  });

  it('maps Google Ads rows (cost micros, conversions)', () => {
    expect(mapGoogleRow({ campaign: { id: '987', name: 'Marke' }, segments: { date: '2026-10-02' }, metrics: { costMicros: '45670000', impressions: '800', clicks: '40', conversions: 2.6 }, customer: { currencyCode: 'EUR' } })).toEqual({
      campaign_id: '987',
      campaign_name: 'Marke',
      date: '2026-10-02',
      spend_cents: 4567,
      impressions: 800,
      clicks: 40,
      leads: 3,
      currency: 'EUR',
    });
  });

  it('hashes e-mail, phone and names the way Meta expects', () => {
    const e = capiEvent({ eventName: 'Purchase', eventId: 'purchase_1', eventTime: new Date('2026-10-04T10:00:00Z'), email: '  Anna@Example.COM ', phone: '+49 151 2345-678', firstName: 'Anna-Lena', lastName: 'Müller', externalId: 'c1', fbclid: 'IwAR1', fbclidAt: new Date('2026-10-01T08:00:00Z'), value: 119, currency: 'eur', sourceUrl: 'https://lp.de/start' });
    expect(e).toEqual({
      event_name: 'Purchase',
      event_time: 1791108000,
      event_id: 'purchase_1',
      action_source: 'system_generated',
      event_source_url: 'https://lp.de/start',
      user_data: {
        em: [sha('anna@example.com')],
        ph: [sha('491512345678')],
        fn: [sha('annalena')],
        ln: [sha('müller')],
        external_id: [sha('c1')],
        fbc: `fb.1.${Date.parse('2026-10-01T08:00:00Z')}.IwAR1`,
      },
      custom_data: { value: 119, currency: 'EUR' },
    });
    expect(normPhone('0049 30 123')).toBe('4930123');
    const lead = capiEvent({ eventName: 'Lead', eventId: 'lead_1', eventTime: new Date(), email: '' });
    expect(lead.user_data).toEqual({});
    expect('custom_data' in lead).toBe(false);
  });
});

/** Fake Meta Graph + Google Ads + Google OAuth. */
const requests: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
const META_TOKEN = 'EAAG-long-lived-token';
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fakeAds = (async (input: any, init: any = {}) => {
  const url = String(input);
  const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
  requests.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body });
  const u = new URL(url);
  if (u.host === 'graph.facebook.com' && u.pathname.endsWith('/insights')) {
    if (u.searchParams.get('access_token') !== META_TOKEN) return json({ error: { message: 'Invalid OAuth access token.', code: 190 } }, 400);
    if (u.searchParams.get('after') === 'p2') return json({ data: [{ campaign_id: '200', campaign_name: 'Herbst Retargeting', date_start: '2026-10-02', spend: '5.00', impressions: '300', clicks: '9' }] });
    return json({
      data: [
        { campaign_id: '100', campaign_name: 'Sommer', date_start: '2026-10-01', spend: '20.00', impressions: '2000', clicks: '50', actions: [{ action_type: 'lead', value: '4' }] },
        { campaign_id: '100', campaign_name: 'Sommer', date_start: '2026-10-02', spend: '30.00', impressions: '2500', clicks: '70', actions: [{ action_type: 'lead', value: '6' }] },
      ],
      paging: { next: `${url}&after=p2` },
    });
  }
  if (u.host === 'graph.facebook.com' && u.pathname.endsWith('/events')) return json({ events_received: 1, fbtrace_id: 'x' });
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(init.body);
    return p.get('refresh_token') === '1//refresh' ? json({ access_token: 'ya29.access', expires_in: 3599 }) : json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400);
  }
  if (u.host === 'googleads.googleapis.com') {
    if (init.headers['developer-token'] !== 'devtok' || init.headers.authorization !== 'Bearer ya29.access') return json([{ error: { code: 401, message: 'Request is missing required authentication credential.' } }], 401);
    return json([{ results: [{ campaign: { id: '555', name: 'Suchkampagne' }, segments: { date: '2026-10-01' }, metrics: { costMicros: '12500000', impressions: '400', clicks: '31', conversions: 1 }, customer: { currencyCode: 'EUR' } }] }]);
  }
  return json({ error: { message: 'unknown' } }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.adsFetch = fakeAds;
});
afterAll(async () => {
  await t.close();
});

describe('ads accounts and sync', () => {
  it('stores secrets sealed and never returns them', async () => {
    expect((await t.api.put('/api/ads/accounts/meta', { ad_account_id: 'act_12x' })).status).toBe(400);
    expect((await t.api.put('/api/ads/accounts/meta', { ad_account_id: 'act_1234567', capi_enabled: true })).status).toBe(400);
    const r = await t.api.put('/api/ads/accounts/meta', { token: META_TOKEN, ad_account_id: 'act_1234567', pixel_id: '998877665544', capi_enabled: true });
    expect(r.data).toMatchObject({ platform: 'meta', connected: true, config: { ad_account_id: '1234567', pixel_id: '998877665544', capi_enabled: true }, secrets: { token: '••••••', capi_token: '' } });
    expect(JSON.stringify((await t.api.get('/api/ads/accounts')).data)).not.toContain(META_TOKEN);
    const row = t.app.db.get('SELECT secrets FROM ads_accounts WHERE location_id = ? AND platform = ?', loc, 'meta');
    expect(row.secrets).toMatch(/^v1:/);
    expect(row.secrets).not.toContain(META_TOKEN);
    // Saving the masked value again keeps the stored token.
    await t.api.put('/api/ads/accounts/meta', { token: '••••••', test_event_code: 'TEST123' });
    expect((await t.api.post('/api/ads/accounts/meta/test', {})).data).toMatchObject({ ok: true, campaigns: 2 });
  });

  it('syncs Meta insights (all pages) into daily campaign rows', async () => {
    requests.length = 0;
    const r = await t.api.post('/api/ads/sync', { platform: 'meta', days: 7 });
    expect(r.data.meta).toEqual({ rows: 3, campaigns: 2 });
    const first = new URL(requests[0].url);
    expect(first.pathname).toBe('/v23.0/act_1234567/insights');
    expect(first.searchParams.get('level')).toBe('campaign');
    expect(first.searchParams.get('time_increment')).toBe('1');
    expect(JSON.parse(first.searchParams.get('time_range')!)).toHaveProperty('since');
    const rows = t.app.db.all('SELECT campaign_id, date, spend_cents, clicks, leads FROM ads_daily WHERE location_id = ? ORDER BY campaign_id, date', loc);
    expect(rows).toEqual([
      { campaign_id: '100', date: '2026-10-01', spend_cents: 2000, clicks: 50, leads: 4 },
      { campaign_id: '100', date: '2026-10-02', spend_cents: 3000, clicks: 70, leads: 6 },
      { campaign_id: '200', date: '2026-10-02', spend_cents: 500, clicks: 9, leads: 0 },
    ]);
    // Re-sync updates instead of duplicating.
    await t.api.post('/api/ads/sync', { platform: 'meta' });
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM ads_daily WHERE location_id = ?', loc).n).toBe(3);
  });

  it('reports a clear error for a bad token', async () => {
    t.app.db.run('UPDATE ads_accounts SET last_error = NULL WHERE location_id = ?', loc);
    await t.api.put('/api/ads/accounts/meta', { token: 'wrong' });
    const r = await t.api.post('/api/ads/sync', { platform: 'meta' });
    expect(r.status).toBe(502);
    expect(r.data.error).toBe('Meta: Invalid OAuth access token.');
    expect((await t.api.get('/api/ads/accounts')).data[0].last_error).toBe('Meta: Invalid OAuth access token.');
    await t.api.put('/api/ads/accounts/meta', { token: META_TOKEN });
  });

  it('syncs Google Ads via refresh token and searchStream', async () => {
    expect((await t.api.put('/api/ads/accounts/google', { customer_id: '123-45' })).status).toBe(400);
    const r = await t.api.put('/api/ads/accounts/google', { developer_token: 'devtok', client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret', refresh_token: '1//refresh', customer_id: '123-456-7890', login_customer_id: '111-222-3333' });
    expect(r.data).toMatchObject({ connected: true, config: { customer_id: '1234567890', login_customer_id: '1112223333' }, secrets: { developer_token: '••••••', refresh_token: '••••••' } });
    requests.length = 0;
    expect((await t.api.post('/api/ads/sync', { platform: 'google' })).data.google).toEqual({ rows: 1, campaigns: 1 });
    const call = requests.find((x) => x.url.includes('googleads'))!;
    expect(call.url).toBe('https://googleads.googleapis.com/v21/customers/1234567890/googleAds:searchStream');
    expect(call.headers['login-customer-id']).toBe('1112223333');
    expect(call.body.query).toMatch(/FROM campaign WHERE segments\.date BETWEEN '\d{4}-\d\d-\d\d' AND '\d{4}-\d\d-\d\d'/);
    expect(t.app.db.get("SELECT spend_cents, leads FROM ads_daily WHERE platform = 'google'")).toEqual({ spend_cents: 1250, leads: 1 });
  });

  it('the scheduler syncs once a day', async () => {
    t.app.db.run('UPDATE ads_accounts SET last_sync_at = ? WHERE location_id = ?', new Date(Date.now() - 25 * 3600_000).toISOString(), loc);
    requests.length = 0;
    await t.app.tick();
    expect(requests.some((r) => r.url.includes('/insights'))).toBe(true);
    expect(requests.some((r) => r.url.includes('googleads'))).toBe(true);
    requests.length = 0;
    await t.app.tick();
    expect(requests.filter((r) => r.url.includes('/insights') || r.url.includes('googleads'))).toHaveLength(0);
  });
});

describe('report: CPL and ROAS from attribution', () => {
  it('joins utm_campaign with the campaign name and sends conversions to Meta', async () => {
    const form = (await t.api.post('/api/forms', { name: 'Lead' })).data;
    // The visitors allowed "Marketing" in the cookie banner: the choice goes into their consent ledger, which CAPI asks.
    const cmp = (await t.api.put('/api/cmp/settings', { enabled: true })).data.settings;
    const cookie = `pghl_cmp=v${cmp.version}.111.cmpvisitor0001`;
    const send = (email: string, page: string, headers: Record<string, string> = { cookie }) =>
      t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', ...headers }, body: JSON.stringify({ first_name: 'X', email, consent: 'ja', _page: page }) }).then((r) => r.json());
    requests.length = 0;
    const a = await send('a@kunde.de', 'https://lp.de/?utm_source=facebook&utm_medium=paid&utm_campaign=Sommer&fbclid=IwAR9');
    await send('b@kunde.de', 'https://lp.de/?utm_source=facebook&utm_medium=paid&utm_campaign=sommer');
    await send('c@kunde.de', 'https://lp.de/?utm_source=google&utm_medium=cpc&utm_campaign=555');
    await send('d@kunde.de', 'https://lp.de/?utm_source=newsletter');
    const inv = (await t.api.post('/api/invoices', { contact_id: a.contactId, items: [{ name: 'Kurs', qty: 1, price_cents: 10000, tax_rate: 0 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    await t.app.events.flush();

    const r = (await t.api.get('/api/ads/report?from=2026-09-01&to=2026-12-31')).data;
    expect(r.attribution).toBe(true);
    const sommer = r.rows.find((x: any) => x.campaign_id === '100');
    expect(sommer).toMatchObject({ platform: 'meta', campaign_name: 'Sommer', spend_cents: 5000, platform_leads: 10, crm_leads: 2, revenue_cents: 10000, cpl_cents: 2500, roas: 2 });
    expect(r.rows.find((x: any) => x.campaign_id === '555')).toMatchObject({ platform: 'google', crm_leads: 1, cpl_cents: 1250, roas: 0 });
    expect(r.rows.find((x: any) => x.campaign_id === '200')).toMatchObject({ crm_leads: 0, cpl_cents: null });
    expect(r.totals).toMatchObject({ spend_cents: 6750, crm_leads: 3, revenue_cents: 10000 });

    // CAPI: Lead for the Meta lead (fbclid / utm_source facebook), Purchase for the paid invoice; not for Google/newsletter leads.
    for (let i = 0; i < 20 && t.app.db.get("SELECT COUNT(*) AS n FROM ads_capi_log WHERE status = 'sent'").n < 3; i++) await new Promise((res) => setTimeout(res, 20));
    const log = t.app.db.all('SELECT event_name, event_id, status FROM ads_capi_log WHERE location_id = ?', loc);
    expect(log).toHaveLength(3);
    expect(log).toEqual(
      expect.arrayContaining([
        { event_name: 'Lead', event_id: `lead_${a.contactId}`, status: 'sent' },
        { event_name: 'Purchase', event_id: `purchase_${inv.id}`, status: 'sent' },
      ]),
    );
    const googleLead = t.app.db.get('SELECT id FROM contacts WHERE email = ?', 'c@kunde.de').id;
    expect(log.some((l: any) => l.event_id === `lead_${googleLead}`)).toBe(false);
    const purchase = requests.find((x) => x.url.endsWith('/v23.0/998877665544/events') && x.body.data[0].event_name === 'Purchase')!;
    expect(purchase.body).toMatchObject({ access_token: META_TOKEN, test_event_code: 'TEST123' });
    expect(purchase.body.data[0]).toMatchObject({ event_id: `purchase_${inv.id}`, custom_data: { value: 100, currency: 'EUR' }, user_data: { em: [sha('a@kunde.de')] } });
    expect(purchase.body.data[0].user_data.fbc).toMatch(/^fb\.1\.\d+\.IwAR9$/);
    // Nothing personal travels in clear text.
    expect(JSON.stringify(purchase.body)).not.toContain('a@kunde.de');
    // The same conversion is never sent twice.
    t.app.events.emit(loc, 'invoice.paid', { contactId: a.contactId, invoice: { ...inv, status: 'paid' } });
    await t.app.events.flush();
    expect(requests.filter((x) => x.url.endsWith('/events') && x.body.data[0].event_name === 'Purchase')).toHaveLength(1);

    // A Meta lead that did not allow marketing (no banner choice, or "Nur notwendige") is not sent – the log says why.
    requests.length = 0;
    const none = await send('e@kunde.de', 'https://lp.de/?utm_source=facebook&utm_medium=paid&utm_campaign=ohne-einwilligung&fbclid=IwARnone', {});
    const rejected = await send('f@kunde.de', 'https://lp.de/?utm_source=facebook&utm_medium=paid&utm_campaign=ohne-einwilligung', { cookie: `pghl_cmp=v${cmp.version}.000.cmpvisitor0002` });
    await t.app.events.flush();
    for (const c of [none, rejected]) expect(t.app.db.get('SELECT status, error FROM ads_capi_log WHERE event_id = ?', `lead_${c.contactId}`)).toEqual({ status: 'blocked', error: 'Keine Einwilligung (Marketing) – nicht gesendet' });
    expect(requests.filter((x) => x.url.endsWith('/events'))).toEqual([]);
    await t.api.put('/api/cmp/settings', { enabled: false });
  });
});

describe('report: same campaign name on both platforms', () => {
  it('matches CRM leads by platform (utm_source) before falling back to the name', async () => {
    t.app.db.run(
      `INSERT INTO ads_daily (location_id, platform, campaign_id, campaign_name, date, spend_cents, impressions, clicks, leads, currency, updated_at) VALUES (?, 'google', '777', 'Sommer', '2026-10-01', 1000, 100, 10, 1, 'EUR', ?)`,
      loc,
      new Date().toISOString(),
    );
    const form = (await t.api.post('/api/forms', { name: 'Lead 2' })).data;
    await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ first_name: 'G', email: 'g@kunde.de', consent: 'ja', _page: 'https://lp.de/?utm_source=google&utm_medium=cpc&utm_campaign=Sommer' }) });
    await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ first_name: 'P', email: 'p@kunde.de', consent: 'ja', _page: 'https://lp.de/?utm_source=partner&utm_campaign=Herbst%20Retargeting' }) });
    const r = (await t.api.get('/api/ads/report?from=2026-09-01&to=2026-12-31')).data;
    expect(r.rows.find((x: any) => x.campaign_id === '100').crm_leads).toBe(2);
    expect(r.rows.find((x: any) => x.campaign_id === '777').crm_leads).toBe(1);
    // A source that belongs to no platform still matches by campaign name.
    expect(r.rows.find((x: any) => x.campaign_id === '200').crm_leads).toBe(1);
  });
});
