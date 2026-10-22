import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { berlinDay, startTestApp } from './helpers.js';
import { DEV_TOKEN, G_APP, LONG_TOKEN, META_APP, PAGE_TOKEN, PNG, createAdsFake, sha } from './ads-fakes.js';

/**
 * Ads manager end to end against fake Meta / Google APIs: connections (OAuth), draft → review → publish (always
 * PAUSED), status and budget changes with their confirmation rules, audiences (hashed), Lead Ads webhook and
 * polling, rules, MCP tools and tenant isolation. No real network, no real keys.
 */

const fake = createAdsFake();
let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let upload = '';
let funnelId = '';

const rpcKey = { key: '' };
const mcp = async (name: string, args: any, key = rpcKey.key) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!j.result?.isError, text, data, error: j.error };
};
/** A request as an API key (no session cookie). */
const asKey = (method: string, path: string, body?: unknown, key = apiKey.key, location = loc) =>
  t.api.raw(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-location-id': location }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));
const apiKey = { key: '' };

const metaSpec = (over: any = {}) => ({
  platform: 'meta',
  name: 'Yoga Probestunde',
  goal: 'traffic',
  kind: 'website',
  budget: { type: 'daily', amount_cents: 2000 },
  audience: { countries: ['DE'], age_min: 25, age_max: 55 },
  creative: { primary_text: 'Starte jetzt mit Yoga.', headline: 'Probestunde gratis', description: 'Jetzt anmelden', cta: 'LEARN_MORE', link: { funnel_id: funnelId }, media: [{ upload_id: upload }] },
  ...over,
});
const googleSpec = (over: any = {}) => ({
  platform: 'google',
  name: 'Suche Yoga Köln',
  goal: 'leads',
  kind: 'search',
  budget: { type: 'daily', amount_cents: 1500 },
  audience: { locations: [{ type: 'geo', key: '2276', name: 'Deutschland' }], languages: ['de'], keywords: [{ text: 'yoga köln', match: 'PHRASE' }] },
  creative: { headlines: ['Yoga in Köln', 'Probestunde gratis', 'Jetzt anmelden'], descriptions: ['Kleine Gruppen, erfahrene Lehrer.', 'Starte noch diese Woche.'], link: { url: 'https://example.org/yoga' } },
  ...over,
});

const publishDraft = async (spec: any) => {
  const draft = (await t.api.post('/api/ads/campaigns', { spec })).data;
  const rv = (await t.api.get(`/api/ads/campaigns/${draft.id}/review`)).data;
  expect(rv.errors).toEqual([]);
  const r = await t.api.post(`/api/ads/campaigns/${draft.id}/publish`, { review_hash: rv.hash });
  expect(r.status).toBe(200);
  return r.data;
};

/** Meta's lead webhook body for one lead. */
const leadHook = (leadId: string, page = '555000111', form = '444') => JSON.stringify({ object: 'page', entry: [{ id: page, time: 1700000000, changes: [{ field: 'leadgen', value: { leadgen_id: leadId, page_id: page, form_id: form, adgroup_id: '777', ad_id: '777', created_time: 1700000000 } }] }] });
const sign = (raw: string, secret = META_APP.app_secret) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const post = (path: string, raw: string, headers: Record<string, string> = {}) => t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  t.app.services.adsFetch = fake.fetch;
  t.app.services.oauthFetch = fake.fetch;
  t.app.services.adsSleep = () => Promise.resolve();
  upload = (await t.api.post('/api/uploads', { name: 'yoga.png', data: PNG })).data.id;
  funnelId = (await t.api.post('/api/funnels', { name: 'Yoga Landing' })).data.id;
  apiKey.key = (await t.api.post('/api/api-keys', { name: 'Ads-Test' })).data.key;
  rpcKey.key = apiKey.key;
});
afterAll(async () => {
  await t.close();
});

describe('connections: Meta and Google via OAuth', () => {
  it('needs the agency\'s apps first, and keeps their secrets sealed', async () => {
    const early = await t.api.post('/api/ads/connect/meta/start', {});
    expect(early.status).toBe(409);
    expect(early.data.error).toMatch(/Meta-App/);
    expect((await t.api.post('/api/ads/connect/google/start', {})).status).toBe(409);
    expect((await t.api.put('/api/ads/agency', { meta: { app_id: 'abc' } })).status).toBe(400);
    const r = await t.api.put('/api/ads/agency', { meta: META_APP, google: { developer_token: DEV_TOKEN, login_customer_id: '' } });
    expect(r.status).toBe(200);
    expect(r.data.meta).toMatchObject({ app_id: META_APP.app_id, app_secret: '••••••', secret_set: true, webhook_url: 'http://localhost/hooks/ads/meta', redirect_uris: ['http://localhost/oauth/ads/meta/callback'] });
    expect(r.data.meta.verify_token).toMatch(/^[\w-]{20,}$/);
    expect(r.data.google).toMatchObject({ developer_token: '••••••', developer_token_set: true });
    expect(JSON.stringify(r.data)).not.toContain(META_APP.app_secret);
    expect(JSON.stringify(r.data)).not.toContain(DEV_TOKEN);
    const stored = JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'ads_agency'`)!.value);
    expect(stored.meta.app_secret).toMatch(/^v1:/);
    expect(stored.google.developer_token).toMatch(/^v1:/);
    // Saving the mask keeps the secret.
    await t.api.put('/api/ads/agency', { meta: { app_secret: '••••••' } });
    expect(JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'ads_agency'`)!.value).meta.app_secret).toBe(stored.meta.app_secret);
    await t.api.put('/api/agency/oauth', { google: G_APP });
  });

  it('only people may change agency credentials and limits – not API keys', async () => {
    expect((await asKey('PUT', '/api/ads/agency', { meta: { app_id: '99999' } })).status).toBe(403);
    expect((await asKey('PUT', '/api/ads/settings', { max_daily_budget_cents: 999999 })).status).toBe(403);
    expect((await asKey('POST', '/api/ads/connect/meta/start', {})).status).toBe(403);
  });

  it('connects Meta: ads_management, ads_read, business_management (+ lead scopes on request), long-lived token, auto-selected account', async () => {
    const start = await t.api.post('/api/ads/connect/meta/start', { lead_ads: true });
    expect(start.status).toBe(200);
    const u = new URL(start.data.url);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe(META_APP.app_id);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/oauth/ads/meta/callback');
    expect(u.searchParams.get('scope')!.split(',')).toEqual(expect.arrayContaining(['ads_management', 'ads_read', 'business_management', 'leads_retrieval', 'pages_manage_ads']));
    expect(start.data.url).not.toContain(META_APP.app_secret);
    const flow = fake.authorize(start.data.url);
    // A tampered state, or another browser, is refused.
    expect((await t.api.get(`/oauth/ads/meta/callback?code=${flow.code}&state=${flow.state.slice(0, -2)}xx`)).status).toBe(400);
    expect((await t.api.raw(`/oauth/ads/meta/callback?code=${flow.code}&state=${flow.state}`)).status).toBe(401);
    const r = await t.api.get(`/oauth/ads/meta/callback?code=${flow.code}&state=${encodeURIComponent(flow.state)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/app/ads/connections?oauth=ok&platform=meta');
    // code → short token → long-lived token, both with the app secret
    const exch = fake.calls(/oauth\/access_token/).map((c) => Object.fromEntries(new URL(c.url).searchParams));
    expect(exch[0]).toMatchObject({ client_id: META_APP.app_id, code: flow.code, redirect_uri: 'http://localhost/oauth/ads/meta/callback' });
    expect(exch[1]).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: `SHORT-${flow.code}` });
    // single use
    expect((await t.api.get(`/oauth/ads/meta/callback?code=${flow.code}&state=${encodeURIComponent(flow.state)}`)).headers.get('location')).toContain('oauth=error');
    const c = (await t.api.get('/api/ads/connections')).data;
    expect(c.meta).toMatchObject({ connected: true, via: 'oauth', can_manage: true, lead_ads: true, account: { id: '111222333', name: 'Testkonto GmbH', currency: 'EUR' }, page: { id: '555000111', name: 'Yogastudio Köln' } });
    expect(c.meta.token_expires_at).toMatch(/^\d{4}-/);
    expect(JSON.stringify(c)).not.toMatch(/EAAG|v1:/);
    const row = t.app.db.get(`SELECT secrets FROM ads_accounts WHERE location_id = ? AND platform = 'meta'`, loc)!;
    expect(row.secrets).toMatch(/^v1:/);
    expect(row.secrets).not.toContain(LONG_TOKEN);
  });

  it('the reporting uses the same connection (token + ad account)', async () => {
    const list = (await t.api.get('/api/ads/accounts')).data;
    expect(list.find((a: any) => a.platform === 'meta')).toMatchObject({ connected: true, config: { ad_account_id: '111222333' } });
  });

  it('lists what the login can reach and validates the selection (pixel belongs to the account)', async () => {
    const o = (await t.api.get('/api/ads/connections/meta/options')).data;
    expect(o.ad_accounts[0]).toMatchObject({ id: '111222333', currency: 'EUR' });
    expect(o.pages[0]).toEqual({ id: '555000111', name: 'Yogastudio Köln' });
    expect(JSON.stringify(o)).not.toContain(PAGE_TOKEN);
    expect(o.pixels).toEqual([{ id: '998877665544', name: 'Pixel' }]);
    expect((await t.api.put('/api/ads/connections/meta/selection', { ad_account_id: '5555555' })).status).toBe(400);
    expect((await t.api.put('/api/ads/connections/meta/selection', { pixel_id: '12345678' })).status).toBe(400);
    const r = await t.api.put('/api/ads/connections/meta/selection', { pixel_id: '998877665544' });
    expect(r.data.pixel_id).toBe('998877665544');
  });

  it('connects Google Ads with the agency\'s Google app + developer token, then picks the customer account', async () => {
    const start = await t.api.post('/api/ads/connect/google/start', {});
    expect(start.status).toBe(200);
    const u = new URL(start.data.url);
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/adwords');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/oauth/ads/google/callback');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const flow = fake.authorize(start.data.url, 'owner@example.com');
    const r = await t.api.get(`/oauth/ads/google/callback?code=${flow.code}&state=${encodeURIComponent(flow.state)}`);
    expect(r.headers.get('location')).toBe('/app/ads/connections?oauth=ok&platform=google');
    let c = (await t.api.get('/api/ads/connections')).data.google;
    expect(c).toMatchObject({ has_token: true, connected: false, needs_selection: true, via: 'oauth', account_email: 'owner@example.com' });
    const o = (await t.api.get('/api/ads/connections/google/options')).data;
    expect(o.customers.map((x: any) => x.id).sort()).toEqual(['1234567890', '9999999999']);
    expect(o.customers.find((x: any) => x.id === '1234567890')).toMatchObject({ name: 'Yoga Google Konto', currency: 'EUR', test: true });
    expect((await t.api.put('/api/ads/connections/google/selection', { customer_id: '1111111111' })).status).toBe(400);
    const sel = await t.api.put('/api/ads/connections/google/selection', { customer_id: '123-456-7890' });
    expect(sel.data).toMatchObject({ connected: true, can_manage: true, account: { id: '1234567890', name: 'Yoga Google Konto', currency: 'EUR' }, test_account: true });
    c = (await t.api.get('/api/ads/connections')).data.google;
    expect(JSON.stringify(c)).not.toMatch(/g-refresh|v1:|DEVTOKEN/);
    const row = t.app.db.get(`SELECT secrets FROM ads_accounts WHERE location_id = ? AND platform = 'google'`, loc)!;
    expect(row.secrets).toMatch(/^v1:/);
    // The reporting sees the OAuth connection too (agency app + developer token).
    expect((await t.api.get('/api/ads/accounts')).data.find((a: any) => a.platform === 'google').connected).toBe(true);
  });

  it('a read-only grant is detected (no ads_management → no changes)', async () => {
    const saved = fake.f.granted;
    fake.f.granted = ['ads_read'];
    const start = await t.api.post('/api/ads/connect/meta/start', {});
    const flow = fake.authorize(start.data.url);
    await t.api.get(`/oauth/ads/meta/callback?code=${flow.code}&state=${encodeURIComponent(flow.state)}`);
    const c = (await t.api.get('/api/ads/connections')).data.meta;
    expect(c).toMatchObject({ connected: true, can_manage: false });
    const draft = (await t.api.post('/api/ads/campaigns', { spec: metaSpec() })).data;
    const rv = (await t.api.get(`/api/ads/campaigns/${draft.id}/review`)).data;
    expect(rv.ready).toBe(false);
    expect(rv.errors.join()).toMatch(/nur lesen/);
    // back to the full grant
    fake.f.granted = saved;
    const s2 = await t.api.post('/api/ads/connect/meta/start', { lead_ads: true });
    const f2 = fake.authorize(s2.data.url);
    await t.api.get(`/oauth/ads/meta/callback?code=${f2.code}&state=${encodeURIComponent(f2.state)}`);
    expect((await t.api.get('/api/ads/connections')).data.meta.can_manage).toBe(true);
    await t.api.put('/api/ads/connections/meta/selection', { pixel_id: '998877665544' });
    await t.api.del(`/api/ads/campaigns/${draft.id}`);
  });
});

describe('campaign builder: review, publish – paused by default', () => {
  let c: any;

  it('saves a draft and shows the review: plain rows, UTM example, paused after publishing', async () => {
    const draft = await t.api.post('/api/ads/campaigns', { spec: metaSpec() });
    expect(draft.status).toBe(200);
    expect(draft.data).toMatchObject({ platform: 'meta', status: 'draft', name: 'Yoga Probestunde' });
    c = draft.data;
    const rv = (await t.api.get(`/api/ads/campaigns/${c.id}/review`)).data;
    expect(rv).toMatchObject({ ready: true, status_after: 'paused', platform: 'meta', account: 'Testkonto GmbH' });
    expect(rv.errors).toEqual([]);
    const row = (label: string) => rv.rows.find((x: any) => x.label === label)?.value;
    expect(row('Budget')).toMatch(/20,00\s€ pro Tag/);
    expect(row('Link')).toBe(`http://localhost/p/yoga-landing`);
    expect(row('Tracking')).toContain('utm_source=facebook&utm_medium=paid_social&utm_campaign=Yoga Probestunde');
    expect(rv.note).toMatch(/pausiert angelegt/);
    // the same review without saving (wizard)
    const live = (await t.api.post('/api/ads/review', { spec: metaSpec() })).data;
    expect(live.hash).toBe(rv.hash);
    expect(fake.calls(/campaigns|adsets|adcreatives|\/ads$/, 'POST')).toHaveLength(0);
  });

  it('refuses to publish without the review hash, or after the spec changed', async () => {
    expect((await t.api.post(`/api/ads/campaigns/${c.id}/publish`, {})).status).toBe(400);
    const rv = (await t.api.get(`/api/ads/campaigns/${c.id}/review`)).data;
    expect((await t.api.post(`/api/ads/campaigns/${c.id}/publish`, { review_hash: 'x'.repeat(32) })).status).toBe(409);
    await t.api.patch(`/api/ads/campaigns/${c.id}`, { spec: { creative: { headline: 'Neue Überschrift' } } });
    const stale = await t.api.post(`/api/ads/campaigns/${c.id}/publish`, { review_hash: rv.hash });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toMatch(/geändert/);
    expect(fake.calls(/act_111222333\/campaigns/, 'POST')).toHaveLength(0);
  });

  it('blocks a publish with errors and a budget above the sub-account limit', async () => {
    const bad = (await t.api.post('/api/ads/campaigns', { spec: metaSpec({ budget: { type: 'daily', amount_cents: 60_000 }, creative: { primary_text: '', headline: '', link: {}, media: [] } }) })).data;
    const rv = (await t.api.get(`/api/ads/campaigns/${bad.id}/review`)).data;
    expect(rv.ready).toBe(false);
    expect(rv.errors.join(' | ')).toMatch(/Tageslimit/);
    expect(rv.errors.join(' | ')).toMatch(/Haupttext fehlt/);
    const r = await t.api.post(`/api/ads/campaigns/${bad.id}/publish`, { review_hash: rv.hash });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Noch nicht bereit/);
    await t.api.del(`/api/ads/campaigns/${bad.id}`);
  });

  it('publishes Meta: image upload, campaign, ad set, creative, ad – every level PAUSED, budget in cents, UTM tags', async () => {
    fake.reset();
    const done = await publishDraft(metaSpec());
    expect(done).toMatchObject({ status: 'paused', platform: 'meta', last_error: null });
    expect(done.remote_id).toMatch(/^\d+$/);
    const order = fake.reqs.filter((r) => r.method === 'POST').map((r) => r.path.replace(/^\/v25\.0\//, '').replace(/\d{6,}/, 'N'));
    expect(order).toEqual(['act_N/adimages', 'act_N/campaigns', 'act_N/adsets', 'act_N/adcreatives', 'act_N/ads']);
    const body = (p: string) => fake.reqs.find((r) => r.method === 'POST' && r.path.endsWith(p))!.body;
    expect(body('/adimages').bytes).toMatch(/^iVBOR/);
    expect(body('/campaigns')).toMatchObject({ name: 'Yoga Probestunde', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false });
    expect(body('/adsets')).toMatchObject({ status: 'PAUSED', daily_budget: 2000, optimization_goal: 'LINK_CLICKS', campaign_id: done.remote_id, targeting: { geo_locations: { countries: ['DE'] }, age_min: 25, age_max: 55 } });
    expect(body('/adsets').dsa_beneficiary).toBe('Yogastudio Köln');
    expect(body('/adcreatives')).toMatchObject({ object_story_spec: { page_id: '555000111', link_data: { link: 'http://localhost/p/yoga-landing', image_hash: 'imghash1', name: 'Probestunde gratis', message: 'Starte jetzt mit Yoga.' } } });
    expect(body('/adcreatives').url_tags).toContain('utm_campaign={{campaign.name}}');
    expect(body('/ads')).toMatchObject({ status: 'PAUSED', creative: { creative_id: expect.any(String) } });
    // paused by default: no request anywhere sets ACTIVE
    expect(fake.reqs.some((r) => JSON.stringify(r.body ?? '').includes('"ACTIVE"'))).toBe(false);
    const audit = t.app.db.all(`SELECT action, summary, via FROM audit_log WHERE action = 'ads.campaign.publish'`);
    expect(audit.at(-1)!.summary).toMatch(/pausiert angelegt/);
    // not twice
    expect((await t.api.post(`/api/ads/campaigns/${done.id}/publish`, { review_hash: 'x' })).status).toBe(409);
  });

  it('rolls back what it created when a later step fails (nothing is left in the ad account)', async () => {
    fake.reset();
    fake.f.failStep = 'adcreatives';
    const draft = (await t.api.post('/api/ads/campaigns', { spec: metaSpec({ name: 'Wird zurückgerollt' }) })).data;
    const rv = (await t.api.get(`/api/ads/campaigns/${draft.id}/review`)).data;
    const r = await t.api.post(`/api/ads/campaigns/${draft.id}/publish`, { review_hash: rv.hash });
    fake.f.failStep = '';
    expect(r.status).toBe(502);
    expect(r.data.error).toContain('Feld in adcreatives fehlt');
    const created = fake.calls(/act_\d+\/campaigns/, 'POST');
    expect(created).toHaveLength(1);
    expect(fake.calls(/\/\d+$/, 'DELETE')).toHaveLength(1);
    expect(fake.f.remoteCampaigns.find((x) => x.name === 'Wird zurückgerollt')).toBeUndefined();
    const row = (await t.api.get(`/api/ads/campaigns/${draft.id}`)).data;
    expect(row).toMatchObject({ status: 'error' });
    expect(row.last_error).toContain('Feld in adcreatives fehlt');
    // after fixing the cause it can be published again
    const again = await t.api.post(`/api/ads/campaigns/${draft.id}/publish`, { review_hash: rv.hash });
    expect(again.status).toBe(200);
    expect(again.data.status).toBe('paused');
  });

  it('publishes a Meta lead campaign with an instant form (created by HyperLevel) and a custom audience', async () => {
    const form = await t.api.post('/api/ads/leadforms', { name: 'Probestunde', headline: 'Gratis testen', questions: ['FULL_NAME', 'EMAIL', 'PHONE', { type: 'CUSTOM', key: 'erfahrung', label: 'Deine Erfahrung?' }], privacy_url: 'https://example.org/datenschutz', thank_you: { title: 'Danke!', body: 'Wir melden uns.', url: 'https://example.org/danke' } });
    expect(form.status).toBe(200);
    const created = fake.reqs.filter((r) => r.path.endsWith('/leadgen_forms') && r.method === 'POST').at(-1)!;
    expect(created.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    expect(created.body).toMatchObject({ name: 'Probestunde', questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }, { type: 'PHONE' }, { type: 'CUSTOM', key: 'erfahrung', label: 'Deine Erfahrung?' }], privacy_policy: { url: 'https://example.org/datenschutz' } });
    expect((await t.api.post('/api/ads/leadforms', { name: 'x', questions: ['EMAIL'], privacy_url: 'http://nope' })).status).toBe(400);
    fake.reset();
    const done = await publishDraft(metaSpec({ name: 'Lead Yoga', goal: 'leads', kind: 'lead_form', lead_form_id: form.data.id }));
    expect(done.status).toBe('paused');
    expect(fake.reqs.find((r) => r.path.endsWith('/adsets'))!.body).toMatchObject({ optimization_goal: 'LEAD_GENERATION', destination_type: 'ON_AD', promoted_object: { page_id: '555000111' }, status: 'PAUSED' });
    expect(fake.reqs.find((r) => r.path.endsWith('/adcreatives'))!.body.object_story_spec.link_data.call_to_action).toEqual({ type: 'LEARN_MORE', value: { lead_gen_form_id: form.data.form_id, link: 'http://localhost/p/yoga-landing' } });
    // the form cannot be deleted while a campaign uses it
    expect((await t.api.del(`/api/ads/leadforms/${form.data.id}`)).status).toBe(409);
  });

  it('publishes a Google search campaign in one atomic mutate – campaign, ad group and ad paused', async () => {
    fake.reset();
    const done = await publishDraft(googleSpec());
    expect(done).toMatchObject({ status: 'paused', platform: 'google' });
    const mut = fake.calls(/googleAds:mutate/)[0];
    expect(mut.headers['developer-token']).toBe(DEV_TOKEN);
    expect(mut.headers.authorization).toBe('Bearer ya29.access');
    const ops = mut.body.mutateOperations;
    expect(ops.find((o: any) => o.campaignOperation).campaignOperation.create).toMatchObject({ status: 'PAUSED', advertisingChannelType: 'SEARCH', containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', trackingUrlTemplate: '{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}' });
    expect(ops.find((o: any) => o.adGroupOperation).adGroupOperation.create.status).toBe('PAUSED');
    expect(ops.find((o: any) => o.adGroupAdOperation).adGroupAdOperation.create.status).toBe('PAUSED');
    expect(JSON.stringify(ops)).not.toMatch(/"(ENABLED)"[^}]*campaign/);
    expect(done.remote_id).toMatch(/^\d+$/);
    // failed mutate → nothing created, error kept on the draft
    fake.f.failStep = 'campaigns';
    const draft = (await t.api.post('/api/ads/campaigns', { spec: googleSpec({ name: 'Doppelt' }) })).data;
    const rv = (await t.api.get(`/api/ads/campaigns/${draft.id}/review`)).data;
    const bad = await t.api.post(`/api/ads/campaigns/${draft.id}/publish`, { review_hash: rv.hash });
    fake.f.failStep = '';
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain('Google Ads');
    expect((await t.api.get(`/api/ads/campaigns/${draft.id}`)).data.status).toBe('error');
  });

  it('duplicates a campaign as a fresh draft', async () => {
    const list = (await t.api.get('/api/ads/campaigns')).data.campaigns;
    const src = list.find((x: any) => x.name === 'Yoga Probestunde' && x.status === 'paused');
    const copy = (await t.api.post(`/api/ads/campaigns/${src.id}/duplicate`, {})).data;
    expect(copy).toMatchObject({ name: 'Yoga Probestunde (Kopie)', status: 'draft', remote_id: null });
    expect(copy.id).not.toBe(src.id);
    await t.api.del(`/api/ads/campaigns/${copy.id}`);
    // a published campaign cannot be removed from here
    expect((await t.api.del(`/api/ads/campaigns/${src.id}`)).status).toBe(409);
  });
});

describe('status and budget: spending needs a person', () => {
  let camp: any;
  let gcamp: any;
  beforeAll(async () => {
    const list = (await t.api.get('/api/ads/campaigns')).data.campaigns;
    camp = list.find((x: any) => x.name === 'Yoga Probestunde' && x.platform === 'meta' && x.status === 'paused');
    gcamp = list.find((x: any) => x.platform === 'google' && x.status === 'paused');
    fake.f.budgets.set(camp.remote_id, {});
  });

  it('pausing is free: no confirmation, for anyone', async () => {
    fake.reset();
    const r = await t.api.post(`/api/ads/campaigns/${camp.id}/status`, { status: 'paused' });
    expect(r.data.status).toBe('done');
    expect(fake.reqs.find((x) => x.method === 'POST' && x.path.endsWith(`/${camp.remote_id}`))!.body).toEqual({ status: 'PAUSED' });
    const viaKey = await asKey('POST', `/api/ads/campaigns/${camp.id}/status`, { status: 'paused' });
    expect(viaKey.data.status).toBe('done');
  });

  it('activating in the app needs the confirmation; nothing happens before', async () => {
    fake.reset();
    const r = await t.api.post(`/api/ads/campaigns/${camp.id}/status`, { status: 'active' });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/Bitte bestätigen: „Yoga Probestunde“ bei Meta \(Facebook & Instagram\) aktivieren/);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    // confirm: true alone is not enough from a key (see below), but a person may
    const ok = await t.api.post(`/api/ads/campaigns/${camp.id}/status`, { status: 'active', confirm: true });
    expect(ok.data.status).toBe('done');
    const posts = fake.reqs.filter((x) => x.method === 'POST').map((x) => x.body);
    // campaign, ad set and ad are all switched on (they were created paused)
    expect(posts).toEqual([{ status: 'ACTIVE' }, { status: 'ACTIVE' }, { status: 'ACTIVE' }]);
    expect((await t.api.get('/api/ads/campaigns')).data.campaigns.find((x: any) => x.id === camp.id).status).toBe('active');
    const log = t.app.db.all(`SELECT action, summary, via, actor FROM audit_log WHERE action = 'ads.campaign.activate'`);
    expect(log.at(-1)).toMatchObject({ via: 'session', actor: 'Chef' });
    expect(log.at(-1)!.summary).toMatch(/aktiviert/);
  });

  it('an API key never activates: even with confirm:true it only leaves an approval', async () => {
    await t.api.post(`/api/ads/campaigns/${camp.id}/status`, { status: 'paused' });
    fake.reset();
    const r = await asKey('POST', `/api/ads/campaigns/${camp.id}/status`, { status: 'active', confirm: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'approval_required' });
    expect(r.data.message).toMatch(/Freigabe/);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    // the same request again reuses the pending approval
    const again = await asKey('POST', `/api/ads/campaigns/${camp.id}/status`, { status: 'active' });
    expect(again.data.approval_id).toBe(r.data.approval_id);
    const pending = (await t.api.get('/api/ads/approvals')).data;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: r.data.approval_id, action: 'activate', status: 'pending', requested_via: 'api_key' });
    expect(pending[0].summary).toMatch(/aktivieren/);
    // a key (or MCP, or the agent) cannot approve its own request
    expect((await asKey('POST', `/api/ads/approvals/${r.data.approval_id}/approve`, {})).status).toBe(403);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    // a person approves: now it runs, audit-logged with who approved and how it was requested
    const ok = await t.api.post(`/api/ads/approvals/${r.data.approval_id}/approve`, {});
    expect(ok.data.status).toBe('approved');
    expect(fake.reqs.filter((x) => x.method === 'POST').map((x) => x.body)).toEqual([{ status: 'ACTIVE' }, { status: 'ACTIVE' }, { status: 'ACTIVE' }]);
    expect((await t.api.post(`/api/ads/approvals/${r.data.approval_id}/approve`, {})).status).toBe(409);
    expect((await t.api.get('/api/ads/approvals')).data).toHaveLength(0);
    const log = t.app.db.all(`SELECT action, summary, via FROM audit_log WHERE action LIKE 'ads.approval.%'`);
    expect(log.map((l) => l.action)).toEqual(['ads.approval.request', 'ads.approval.approve']);
    expect(log[0].via).toBe('api_key');
    expect(log[1]).toMatchObject({ via: 'session' });
    expect(log[1].summary).toContain('angefragt über api_key');
  });

  it('a rejected approval changes nothing; an expired one cannot be approved', async () => {
    await t.api.post(`/api/ads/campaigns/${camp.id}/status`, { status: 'paused' });
    fake.reset();
    const a = (await asKey('POST', `/api/ads/campaigns/${camp.id}/status`, { status: 'active' })).data;
    expect((await t.api.post(`/api/ads/approvals/${a.approval_id}/reject`, {})).data.status).toBe('rejected');
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    const b = (await asKey('POST', `/api/ads/campaigns/${camp.id}/status`, { status: 'active' })).data;
    t.app.db.run(`UPDATE ads_approvals SET expires_at = ? WHERE id = ?`, new Date(Date.now() - 1000).toISOString(), b.approval_id);
    const r = await t.api.post(`/api/ads/approvals/${b.approval_id}/approve`, {});
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/abgelaufen/);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
  });

  it('budget changes: confirmation for people, approval for keys; Meta ad-set budget in cents, limit enforced', async () => {
    // the campaign's budget lives on its ad set
    const adset = fake.f.adsetsOf.get(camp.remote_id)![0];
    fake.reset();
    const need = await t.api.post(`/api/ads/campaigns/${camp.id}/budget`, { amount_cents: 3500 });
    expect(need.status).toBe(409);
    expect(need.data.error).toMatch(/Bitte bestätigen: Budget von „Yoga Probestunde“ bei Meta \(Facebook & Instagram\): 20,00\s€ → 35,00\s€ pro Tag/);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    expect((await t.api.post(`/api/ads/campaigns/${camp.id}/budget`, { amount_cents: 60_000, confirm: true })).status).toBe(400);
    expect((await t.api.post(`/api/ads/campaigns/${camp.id}/budget`, { amount_cents: 3500, type: 'lifetime', confirm: true })).status).toBe(400);
    const ok = await t.api.post(`/api/ads/campaigns/${camp.id}/budget`, { amount_cents: 3500, confirm: true });
    expect(ok.data).toMatchObject({ status: 'done', from_cents: 2000, to_cents: 3500 });
    const set = fake.reqs.filter((x) => x.method === 'POST').at(-1)!;
    expect(set.path.endsWith(`/${adset.id}`)).toBe(true);
    expect(set.body).toEqual({ daily_budget: 3500 });
    expect((await t.api.get('/api/ads/campaigns')).data.campaigns.find((x: any) => x.id === camp.id)).toMatchObject({ budget_cents: 3500 });
    expect(t.app.db.all(`SELECT summary FROM audit_log WHERE action = 'ads.campaign.budget'`).at(-1)!.summary).toMatch(/20,00\s€ → 35,00\s€/);
    // a key only asks
    fake.reset();
    const viaKey = await asKey('POST', `/api/ads/campaigns/${camp.id}/budget`, { amount_cents: 5000, confirm: true });
    expect(viaKey.data.status).toBe('approval_required');
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    const approvals = (await t.api.get('/api/ads/approvals')).data;
    expect(approvals[0]).toMatchObject({ action: 'budget', payload: { amountCents: 5000 } });
    expect((await t.api.post(`/api/ads/approvals/${viaKey.data.approval_id}/approve`, {})).data.status).toBe('approved');
    expect(fake.reqs.filter((x) => x.method === 'POST').at(-1)!.body).toEqual({ daily_budget: 5000 });
  });

  it('Google: pause/activate/budget go through the same rules (budget in micros)', async () => {
    fake.f.gBudgetMicros.set(gcamp.remote_id, '15000000');
    fake.reset();
    expect((await t.api.post(`/api/ads/campaigns/${gcamp.id}/status`, { status: 'active' })).status).toBe(409);
    const on = await t.api.post(`/api/ads/campaigns/${gcamp.id}/status`, { status: 'active', confirm: true });
    expect(on.data.status).toBe('done');
    const m = fake.calls(/googleAds:mutate/).at(-1)!.body.mutateOperations.map((o: any) => Object.keys(o)[0]);
    expect(m).toEqual(['campaignOperation', 'adGroupOperation', 'adGroupAdOperation']);
    const b = await t.api.post(`/api/ads/campaigns/${gcamp.id}/budget`, { amount_cents: 2500, confirm: true });
    expect(b.data).toMatchObject({ status: 'done', from_cents: 1500, to_cents: 2500 });
    expect(fake.calls(/campaignBudgets:mutate/).at(-1)!.body.operations[0]).toEqual({ update: { resourceName: 'customers/1234567890/campaignBudgets/77', amountMicros: '25000000' }, updateMask: 'amount_micros' });
    const off = await t.api.post(`/api/ads/campaigns/${gcamp.id}/status`, { status: 'paused' });
    expect(off.data.status).toBe('done');
    expect(fake.calls(/googleAds:mutate/).at(-1)!.body.mutateOperations).toHaveLength(1);
  });

  it('campaigns that only exist at the platform can be paused, and activating them also asks', async () => {
    fake.f.remoteCampaigns.push({ id: '700001', name: 'Alte Kampagne', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC', daily_budget: '1000' });
    fake.f.budgets.set('700001', { daily_budget: '1000' });
    const refreshed = await t.api.post('/api/ads/campaigns/refresh', { platform: 'meta' });
    expect(refreshed.data.meta).toBeGreaterThan(1);
    const row = (await t.api.get('/api/ads/campaigns')).data.campaigns.find((x: any) => x.remote_id === '700001');
    expect(row).toMatchObject({ managed: false, status: 'active', name: 'Alte Kampagne', budget_cents: 1000, id: null });
    expect((await t.api.post('/api/ads/campaigns/meta:700001/status', { status: 'paused' })).data.status).toBe('done');
    expect(fake.f.remoteCampaigns.find((x) => x.id === '700001')!.status).toBe('PAUSED');
    expect((await t.api.post('/api/ads/campaigns/meta:700001/status', { status: 'active' })).status).toBe(409);
    expect((await t.api.post('/api/ads/campaigns/meta:700001/budget', { amount_cents: 1500, confirm: true })).data).toMatchObject({ status: 'done', from_cents: 1000, to_cents: 1500 });
    expect((await t.api.post('/api/ads/campaigns/meta:12', { status: 'paused' })).status).toBe(404);
    expect((await t.api.post('/api/ads/campaigns/meta:999999999/status', { status: 'paused' })).status).toBe(404);
  });
});

describe('campaign list with metrics (reuses the ad reporting)', () => {
  it('joins the synced numbers and the CRM leads per campaign', async () => {
    const list0 = (await t.api.get('/api/ads/campaigns')).data;
    const camp = list0.campaigns.find((x: any) => x.name === 'Yoga Probestunde' && x.platform === 'meta' && x.managed && x.remote_id);
    const today = berlinDay(); // the ad account's day = the sub-account's day (Berlin), not the UTC date
    t.app.db.run(`INSERT INTO ads_daily (location_id, platform, campaign_id, campaign_name, date, spend_cents, impressions, clicks, leads, currency, updated_at) VALUES (?, 'meta', ?, 'Yoga Probestunde', ?, 5000, 2000, 80, 4, 'EUR', ?)`, loc, camp.remote_id, today, new Date().toISOString());
    const form = (await t.api.post('/api/forms', { name: 'Lead' })).data;
    await t.api.raw(`/api/public/forms/${form.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, body: JSON.stringify({ first_name: 'X', email: 'x@kunde.de', consent: 'ja', _page: 'https://lp.de/?utm_source=facebook&utm_medium=paid_social&utm_campaign=Yoga%20Probestunde' }) });
    const list = (await t.api.get('/api/ads/campaigns')).data;
    const row = list.campaigns.find((x: any) => x.id === camp.id);
    expect(row.metrics).toMatchObject({ spend_cents: 5000, clicks: 80, platform_leads: 4, crm_leads: 1, cpl_cents: 5000 });
    expect(list.totals).toMatchObject({ spend_cents: 5000 });
    expect(list.connected).toEqual({ meta: true, google: true });
    const ins = (await t.api.get('/api/ads/insights')).data;
    expect(ins.campaigns.find((x: any) => x.id === camp.id)).toMatchObject({ campaign_ref: camp.id, remote_id: camp.remote_id, spend_cents: 5000, cpl_cents: 5000 });
  });
});

describe('Lead Ads: webhook signature, lead → contact → workflow, polling fallback', () => {
  const lead = (id: string, o: any = {}) => ({
    id,
    created_time: '2026-10-04T10:00:00+0000',
    ad_id: '777',
    ad_name: 'Yoga Anzeige',
    adset_id: '778',
    adset_name: 'Yoga Gruppe',
    campaign_id: '779',
    campaign_name: 'Lead Yoga',
    form_id: '444',
    platform: 'fb',
    is_organic: false,
    field_data: [
      { name: 'full_name', values: ['Anna Lead'] },
      { name: 'email', values: ['Anna.Lead@Example.com'] },
      { name: 'phone_number', values: ['+4915112345678'] },
      { name: 'wie_viel_erfahrung_hast_du?', values: ['Anfänger'] },
    ],
    ...o,
  });
  let verify = '';

  it('answers the verification handshake with the agency\'s verify token only', async () => {
    verify = (await t.api.get('/api/ads/agency')).data.meta.verify_token;
    const ok = await t.api.raw(`/hooks/ads/meta?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('12345');
    expect((await t.api.raw(`/hooks/ads/meta?hub.mode=subscribe&hub.verify_token=falsch&hub.challenge=12345`)).status).toBe(403);
  });

  it('is off until the sub-account turns lead import on; turning it on subscribes the Page to leadgen (keeping its other fields)', async () => {
    expect((await t.api.get('/api/ads/leads/status')).data).toMatchObject({ enabled: false, tags: ['meta-lead'], page: { id: '555000111' }, page_token: true });
    fake.f.leads.set('900001', lead('900001'));
    const raw = leadHook('900001');
    const early = await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw) });
    expect(early.data).toMatchObject({ ok: true, imported: 0, ignored: 1 });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'anna.lead@example.com'`)!.n).toBe(0);
    const on = await t.api.post('/api/ads/leads/enable', { tags: ['meta-lead', 'yoga'] });
    expect(on.status).toBe(200);
    expect(on.data).toMatchObject({ enabled: true, tags: ['meta-lead', 'yoga'] });
    expect(fake.f.subscribedFields).toEqual(['messages', 'messaging_postbacks', 'leadgen']);
    expect(fake.reqs.filter((r) => r.path.endsWith('/subscribed_apps') && r.method === 'POST').at(-1)!.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
  });

  it('rejects an unsigned, wrongly signed or re-signed webhook (X-Hub-Signature-256)', async () => {
    const raw = leadHook('900001');
    expect((await post('/hooks/ads/meta', raw)).status).toBe(401);
    expect((await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) })).status).toBe(401);
    expect((await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw, 'another-apps-secret-0123456789ab') })).status).toBe(401);
    expect((await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw).replace('sha256=', 'sha1=') })).status).toBe(401);
    // a signature of other bytes does not cover this body
    expect((await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(leadHook('900002')) })).status).toBe(401);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'anna.lead@example.com'`)!.n).toBe(0);
  });

  it('a signed lead becomes a tagged contact with its answers, attribution and a workflow run', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Neuer Lead aus Anzeige', trigger: { type: 'ads.lead', config: { campaign_id: '779' } }, steps: [{ type: 'add_tag', tags: ['willkommen-lead'] }] })).data;
    expect(wf.id).toBeTruthy();
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const raw = leadHook('900001');
    const r = await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw) });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, imported: 1, failed: 0 });
    await t.app.events.flush();
    // the lead was read from the Graph API with the Page token – the webhook only named it
    const fetched = fake.reqs.filter((x) => x.path.endsWith('/900001') && x.method === 'GET').at(-1)!;
    expect(fetched.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`);
    const c = t.app.db.get(`SELECT * FROM contacts WHERE location_id = ? AND email = 'anna.lead@example.com'`, loc)!;
    expect(c).toMatchObject({ first_name: 'Anna', last_name: 'Lead', phone: '+4915112345678', source: 'Meta Lead Ad' });
    const tags = JSON.parse(c.tags);
    expect(tags).toEqual(expect.arrayContaining(['meta-lead', 'yoga']));
    // the workflow (trigger "Neuer Lead aus Anzeige") ran for this contact
    for (let i = 0; i < 30 && !JSON.parse(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', c.id)!.tags).includes('willkommen-lead'); i++) await new Promise((res) => setTimeout(res, 20));
    expect(JSON.parse(t.app.db.get('SELECT tags FROM contacts WHERE id = ?', c.id)!.tags)).toContain('willkommen-lead');
    expect(JSON.parse(c.custom)).toMatchObject({ wie_viel_erfahrung_hast_du: 'Anfänger' });
    const note = t.app.db.get(`SELECT body FROM notes WHERE contact_id = ?`, c.id)!.body;
    expect(note).toContain('Kampagne „Lead Yoga“');
    expect(note).toContain('Anfänger');
    expect(t.app.db.get(`SELECT status, campaign_name FROM ads_leads WHERE location_id = ? AND leadgen_id = '900001'`, loc)).toEqual({ status: 'imported', campaign_name: 'Lead Yoga' });
    // attributed to its campaign (the ad report and the attribution report join on utm_campaign)
    const touch = t.app.db.get(`SELECT source, medium, campaign, kind FROM attribution_touches WHERE contact_id = ?`, c.id)!;
    expect(touch).toMatchObject({ source: 'facebook', medium: 'paid_social', campaign: 'Lead Yoga', kind: 'lead_ad' });
    // delivered twice: no second contact, no second run
    const again = await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw) });
    expect(again.data).toMatchObject({ imported: 0, duplicates: 1 });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'anna.lead@example.com'`)!.n).toBe(1);
  });

  it('a workflow filter for another campaign does not fire', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Anderer Lead', trigger: { type: 'ads.lead', config: { campaign_id: '000' } }, steps: [{ type: 'add_tag', tags: ['falscher-lead'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    fake.f.leads.set('900003', lead('900003', { field_data: [{ name: 'email', values: ['zweiter@example.com'] }, { name: 'full_name', values: ['Zweiter Lead'] }] }));
    const raw = leadHook('900003');
    await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw) });
    await t.app.events.flush();
    const c = t.app.db.get(`SELECT tags FROM contacts WHERE email = 'zweiter@example.com'`)!;
    expect(JSON.parse(c.tags)).not.toContain('falscher-lead');
  });

  it('only the sub-account that owns the Page gets the lead – a Page nobody connected is ignored', async () => {
    fake.f.leads.set('900004', lead('900004', { field_data: [{ name: 'email', values: ['fremd@example.com'] }] }));
    const raw = leadHook('900004', '999999999');
    const r = await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw) });
    expect(r.data).toMatchObject({ imported: 0, ignored: 1 });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'fremd@example.com'`)!.n).toBe(0);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM ads_leads WHERE leadgen_id = '900004'`)!.n).toBe(0);
  });

  it('shares the callback of the Messenger/WhatsApp webhook (/hooks/meta/:loc) – same app, same signature', async () => {
    t.app.db.run(`INSERT INTO meta_accounts (location_id, verify_token, app_secret, created_at, updated_at) VALUES (?, 'verifytoken1', ?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET app_secret = excluded.app_secret`, loc, (await import('../server/core/secrets.js')).sealSecret(t.app as any, META_APP.app_secret), new Date().toISOString(), new Date().toISOString());
    fake.f.leads.set('900005', lead('900005', { field_data: [{ name: 'email', values: ['ueber-kanal@example.com'] }, { name: 'full_name', values: ['Kanal Lead'] }] }));
    const raw = leadHook('900005');
    const r = await post(`/hooks/meta/${loc}`, raw, { 'x-hub-signature-256': sign(raw) });
    expect(r.status).toBe(200);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'ueber-kanal@example.com'`)!.n).toBe(1);
    expect((await post(`/hooks/meta/${loc}`, raw, { 'x-hub-signature-256': sign(raw, 'wrong-secret-0123456789abcdef01') })).status).toBe(401);
  });

  it('the polling fallback imports leads the webhook missed (once)', async () => {
    const formId = fake.f.pageForms[0].id;
    fake.f.formLeads = [lead('900010', { form_id: formId, field_data: [{ name: 'email', values: ['poll@example.com'] }, { name: 'full_name', values: ['Poll Lead'] }] }), lead('900001', { form_id: formId })];
    const r = await t.api.post('/api/ads/leads/poll', {});
    expect(r.data).toMatchObject({ imported: 1, failed: 0 });
    expect(t.app.db.get(`SELECT source FROM ads_leads WHERE leadgen_id = '900010'`)).toEqual({ source: 'poll' });
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'poll@example.com'`)!.n).toBe(1);
    const filter = fake.reqs.filter((x) => x.path.endsWith(`/${formId}/leads`)).at(-1)!;
    expect(decodeURIComponent(new URL(filter.url).searchParams.get('filtering')!)).toContain('time_created');
    expect((await t.api.post('/api/ads/leads/poll', {})).data.imported).toBe(0);
    // the scheduler polls as well, every ten minutes
    fake.f.formLeads.push(lead('900011', { form_id: formId, field_data: [{ name: 'email', values: ['tick@example.com'] }] }));
    const conn = JSON.parse(t.app.db.get(`SELECT config FROM ads_accounts WHERE location_id = ? AND platform = 'meta'`, loc)!.config);
    conn.leads.polled_at = new Date(Date.now() - 11 * 60_000).toISOString();
    t.app.db.run(`UPDATE ads_accounts SET config = ? WHERE location_id = ? AND platform = 'meta'`, JSON.stringify(conn), loc);
    await t.app.tick();
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'tick@example.com'`)!.n).toBe(1);
  });

  it('a lead without any contact data is skipped and logged, a failed fetch is retried by the poll', async () => {
    fake.f.leads.set('900020', lead('900020', { field_data: [{ name: 'wie_viel_erfahrung_hast_du?', values: ['nix'] }] }));
    const raw = leadHook('900020');
    await post('/hooks/ads/meta', raw, { 'x-hub-signature-256': sign(raw) });
    expect(t.app.db.get(`SELECT status, error FROM ads_leads WHERE leadgen_id = '900020'`)).toEqual({ status: 'skipped', error: 'Der Lead enthält keine Kontaktdaten' });
    const raw2 = leadHook('900021');
    const r = await post('/hooks/ads/meta', raw2, { 'x-hub-signature-256': sign(raw2) });
    expect(r.data).toMatchObject({ failed: 1 });
    expect(t.app.db.get(`SELECT status FROM ads_leads WHERE leadgen_id = '900021'`)).toEqual({ status: 'failed' });
  });

  it('the leads list belongs to the sub-account', async () => {
    const mine = (await t.api.get('/api/ads/leads')).data;
    expect(mine.some((l: any) => l.leadgen_id === '900001' && l.email === 'anna.lead@example.com')).toBe(true);
    t.api.setLocation(other);
    expect((await t.api.get('/api/ads/leads')).data).toEqual([]);
    expect((await t.api.get('/api/ads/leads/status')).data).toMatchObject({ enabled: false, page: null });
    t.api.setLocation(loc);
  });
});

describe('audiences from smart lists: hashed, opt-outs excluded, consent confirmed', () => {
  let listId = '';
  let metaAud: any;
  beforeAll(async () => {
    await t.api.post('/api/contacts', { email: ' Max.Muster@Example.com ', phone: '0151 11111111', first_name: 'Max', last_name: 'Muster', tags: ['kunde'] });
    await t.api.post('/api/contacts', { email: 'nur.telefon@example.com', first_name: 'Tel', tags: ['kunde'] });
    await t.api.post('/api/contacts', { first_name: 'Keine', last_name: 'Daten', tags: ['kunde'] });
    const out = (await t.api.post('/api/contacts', { email: 'abgemeldet@example.com', tags: ['kunde'] })).data;
    t.app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', out.id);
    listId = (await t.api.post('/api/smart-lists', { name: 'Kunden', filter: { tags: ['kunde'] } })).data.id;
  });

  it('previews what would be sent', async () => {
    const p = (await t.api.get(`/api/ads/audiences/preview?platform=meta&smart_list_id=${listId}`)).data;
    expect(p).toEqual({ total: 4, usable: 2, skipped: { no_identifier: 1, opted_out: 1 } });
  });

  it('needs the consent confirmation and a person – keys and MCP cannot upload contact data', async () => {
    expect((await t.api.post('/api/ads/audiences', { platform: 'meta', name: 'Kunden', smart_list_id: listId })).status).toBe(400);
    expect((await asKey('POST', '/api/ads/audiences', { platform: 'meta', name: 'Kunden', smart_list_id: listId, consent: true })).status).toBe(403);
    expect(fake.calls(/customaudiences/)).toHaveLength(0);
  });

  it('uploads SHA-256 hashes in Meta\'s schema – never an address or number in clear text', async () => {
    fake.reset();
    const r = await t.api.post('/api/ads/audiences', { platform: 'meta', name: 'Kunden', smart_list_id: listId, consent: true });
    expect(r.status).toBe(200);
    metaAud = r.data;
    expect(metaAud).toMatchObject({ platform: 'meta', kind: 'customer_list', status: 'ready', sent: 2, skipped: 2, smart_list_id: listId });
    const create = fake.reqs.find((x) => x.path.endsWith('/customaudiences'))!;
    expect(create.body).toMatchObject({ subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', name: 'Kunden' });
    const up = fake.reqs.find((x) => x.path.endsWith('/users'))!;
    expect(up.body.payload.schema).toEqual(['EMAIL', 'PHONE', 'FN', 'LN', 'CT', 'ZIP', 'COUNTRY']);
    const rows: string[][] = up.body.payload.data;
    expect(rows).toHaveLength(2);
    const max = rows.find((x) => x[0] === sha('max.muster@example.com'))!;
    expect(max[1]).toBe(sha('49151' + '11111111'));
    expect(max[2]).toBe(sha('max'));
    expect(rows.some((x) => x[0] === sha('nur.telefon@example.com'))).toBe(true);
    expect(up.body.session).toMatchObject({ batch_seq: 1, last_batch_flag: true, estimated_num_total: 2 });
    const wire = JSON.stringify(fake.reqs.map((x) => x.body));
    for (const secret of ['max.muster', 'Muster', 'nur.telefon', '11111111', 'abgemeldet']) expect(wire.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(t.app.db.all(`SELECT summary FROM audit_log WHERE action = 'ads.audience.upload'`).at(-1)!.summary).toMatch(/2 Kontakte \(nur als SHA-256-Hash/);
  });

  it('creates a lookalike from the customer list (country, ratio 1–20 %)', async () => {
    fake.reset();
    expect((await t.api.post(`/api/ads/audiences/${metaAud.id}/lookalike`, { country: 'Deutschland' })).status).toBe(400);
    expect((await t.api.post(`/api/ads/audiences/${metaAud.id}/lookalike`, { country: 'DE', ratio: 0.5 })).status).toBe(400);
    const r = await t.api.post(`/api/ads/audiences/${metaAud.id}/lookalike`, { country: 'de', ratio: 0.02 });
    expect(r.data).toMatchObject({ kind: 'lookalike', status: 'ready', source_id: metaAud.id, country: 'DE', ratio: 0.02 });
    const call = fake.reqs.find((x) => x.path.endsWith('/customaudiences'))!;
    expect(call.body).toMatchObject({ subtype: 'LOOKALIKE', origin_audience_id: expect.any(String), lookalike_spec: { type: 'custom_ratio', ratio: 0.02, country: 'DE' } });
    // the source cannot be deleted while a lookalike depends on it
    expect((await t.api.del(`/api/ads/audiences/${metaAud.id}`)).status).toBe(409);
  });

  it('uploads Customer Match to Google (hashed e-mail and E.164 phone, consent stated)', async () => {
    fake.reset();
    const r = await t.api.post('/api/ads/audiences', { platform: 'google', name: 'Kunden Google', smart_list_id: listId, consent: true });
    expect(r.data).toMatchObject({ platform: 'google', status: 'ready', sent: 2 });
    expect(r.data.platform_id).toMatch(/^customers\/1234567890\/userLists\/\d+$/);
    const ul = fake.calls(/userLists:mutate/)[0].body.operations[0].create;
    expect(ul).toMatchObject({ crmBasedUserList: { uploadKeyType: 'CONTACT_INFO', dataSourceType: 'FIRST_PARTY' } });
    const job = fake.calls(/offlineUserDataJobs:create/)[0].body.job;
    expect(job).toMatchObject({ type: 'CUSTOMER_MATCH_USER_LIST', customerMatchUserListMetadata: { consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' } } });
    const add = fake.calls(/addOperations/)[0].body;
    expect(add.enablePartialFailure).toBe(true);
    const ids = add.operations.flatMap((o: any) => o.create.userIdentifiers);
    expect(ids).toContainEqual({ hashedEmail: sha('max.muster@example.com') });
    expect(ids).toContainEqual({ hashedPhoneNumber: sha('+4915111111111'.replace('+49151', '+49151')) });
    expect(JSON.stringify(add)).not.toContain('Muster');
    expect(fake.calls(/:run$/)).toHaveLength(1);
  });

  it('a campaign can target the customer list (Meta custom_audiences, Google user list)', async () => {
    fake.reset();
    await publishDraft(metaSpec({ name: 'Mit Zielgruppe', audience: { countries: ['DE'], audience_ids: [metaAud.id] } }));
    expect(fake.reqs.find((x) => x.path.endsWith('/adsets'))!.body.targeting.custom_audiences).toEqual([{ id: metaAud.platform_id }]);
    // the audience of another sub-account (or platform) is not available
    const bad = (await t.api.post('/api/ads/campaigns', { spec: metaSpec({ audience: { countries: ['DE'], audience_ids: ['gibtsnicht'] } }) })).data;
    expect((await t.api.get(`/api/ads/campaigns/${bad.id}/review`)).data.errors.join()).toMatch(/Zielgruppe/);
  });

  it('searches interests and places for the wizard', async () => {
    expect((await t.api.get('/api/ads/targeting/interests?q=yo')).data[0]).toMatchObject({ id: '6003107902433', name: 'Yoga', path: 'Interessen › Sport' });
    expect((await t.api.get('/api/ads/targeting/locations?platform=meta&q=Köln')).data[0]).toMatchObject({ type: 'city', key: '2511182', country: 'DE' });
    expect((await t.api.get('/api/ads/targeting/locations?platform=google&q=Köln&country=DE')).data[0]).toMatchObject({ type: 'geo', key: '1004528', country: 'DE' });
    expect((await t.api.get('/api/ads/targeting/interests?q=y')).data).toEqual([]);
  });
});

describe('rules: pause when CPL > X (never switches anything on)', () => {
  let active: any;
  beforeAll(async () => {
    const list = (await t.api.get('/api/ads/campaigns')).data.campaigns;
    active = list.find((x: any) => x.name === 'Yoga Probestunde' && x.platform === 'meta' && x.managed && x.remote_id);
    // a campaign that is running, with 60 € spent and 2 platform leads (1 lead in the CRM from the list test: the CRM count wins)
    t.app.db.run(`UPDATE ads_remote SET status = 'active' WHERE location_id = ? AND platform = 'meta' AND campaign_id = ?`, loc, active.remote_id);
    t.app.db.run(`DELETE FROM ads_daily WHERE location_id = ?`, loc);
    t.app.db.run(`INSERT INTO ads_daily (location_id, platform, campaign_id, campaign_name, date, spend_cents, impressions, clicks, leads, currency, updated_at) VALUES (?, 'meta', ?, 'Yoga Probestunde', ?, 6000, 4000, 80, 2, 'EUR', ?)`, loc, active.remote_id, new Date().toISOString().slice(0, 10), new Date().toISOString());
  });

  it('validates rules', async () => {
    expect((await t.api.post('/api/ads/rules', { metric: 'cpl', op: '=', value: 1 })).status).toBe(400);
    expect((await t.api.post('/api/ads/rules', { metric: 'nix', op: '>', value: 1 })).status).toBe(400);
    expect((await t.api.post('/api/ads/rules', { metric: 'cpl', op: '>', value: 1, window_days: 99 })).status).toBe(400);
  });

  it('dry run says what would happen without doing it', async () => {
    const rule = (await t.api.post('/api/ads/rules', { name: 'CPL über 25 €', metric: 'cpl', op: '>', value: 2500, window_days: 3, min_spend_cents: 3000, action: 'pause' })).data;
    expect(rule.text).toMatch(/Kosten pro Lead über 25,00\s€/);
    fake.reset();
    const r = (await t.api.post('/api/ads/rules/run', { dry_run: true })).data;
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ rule: 'CPL über 25 €', campaign_id: active.remote_id, value: 6000, action: 'pause', result: 'würde ausgelöst' });
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
  });

  it('pauses the campaign, logs it (rule log, history, audit) and then leaves it alone for a day', async () => {
    fake.reset();
    const r = (await t.api.post('/api/ads/rules/run', { fresh: false })).data;
    expect(r.hits[0]).toMatchObject({ action: 'pause', result: 'pausiert' });
    expect(fake.reqs.filter((x) => x.method === 'POST').map((x) => x.body)).toEqual([{ status: 'PAUSED' }]);
    expect((await t.api.get('/api/ads/campaigns')).data.campaigns.find((x: any) => x.remote_id === active.remote_id).status).toBe('paused');
    const audit = t.app.db.get(`SELECT actor, via, summary FROM audit_log WHERE action = 'ads.rule.trigger' ORDER BY at DESC LIMIT 1`)!;
    expect(audit).toMatchObject({ via: 'system' });
    expect(audit.summary).toMatch(/CPL über 25 €.*pausiert/);
    expect(t.app.db.get(`SELECT result FROM ads_rule_log WHERE location_id = ?`, loc)).toEqual({ result: 'pausiert' });
    expect((await t.api.get(`/api/ads/campaigns/${active.id}`)).data.activity.some((a: any) => a.kind === 'rule')).toBe(true);
    // a person switches it on again: the rule does not fight back within 24 h
    await t.api.post(`/api/ads/campaigns/${active.id}/status`, { status: 'active', confirm: true });
    fake.reset();
    expect((await t.api.post('/api/ads/rules/run', { fresh: false })).data.hits).toEqual([]);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
  });

  it('rules cannot be made to start or fund anything', async () => {
    const r = (await t.api.post('/api/ads/rules', { metric: 'leads', op: '<', value: 100, action: 'activate' })).data;
    expect(r.action).toBe('pause');
    for (const x of (await t.api.get('/api/ads/rules')).data.rules) await t.api.del(`/api/ads/rules/${x.id}`);
  });
});

describe('MCP tools: five tools, paused drafts, spending only by approval', () => {
  it('lists the tools with the right hints (reads are read-only, spend tools are outbound)', async () => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools = ((await r.json()) as any).result.tools;
    const by = (n: string) => tools.find((x: any) => x.name === n);
    for (const n of ['ghl_ads_accounts', 'ghl_ads_create_campaign', 'ghl_ads_update_status', 'ghl_ads_update_budget', 'ghl_ads_insights']) expect(by(n), n).toBeTruthy();
    expect(by('ghl_ads_accounts').annotations.readOnlyHint).toBe(true);
    expect(by('ghl_ads_insights').annotations.readOnlyHint).toBe(true);
    expect(by('ghl_ads_update_status').annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(by('ghl_ads_update_budget').annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(by('ghl_ads_create_campaign').annotations.readOnlyHint).toBe(false);
  });

  it('ghl_ads_accounts shows the accounts, limits and ids – no secrets', async () => {
    const r = await mcp('ghl_ads_accounts', { location_id: loc });
    expect(r.isError).toBe(false);
    expect(r.data.meta).toMatchObject({ connected: true, can_manage: true, account: { id: '111222333' }, page: { id: '555000111' }, pixel_id: '998877665544' });
    expect(r.data.google).toMatchObject({ connected: true, account: { id: '1234567890' } });
    expect(r.data.max_daily_budget_cents).toBe(50000);
    expect(r.data.audiences.length).toBeGreaterThan(0);
    expect(r.text).not.toMatch(/EAAG|ya29|DEVTOKEN|v1:/);
  });

  it('ghl_ads_create_campaign creates a paused draft with the review – nothing reaches the platform', async () => {
    fake.reset();
    const r = await mcp('ghl_ads_create_campaign', { location_id: loc, platform: 'meta', name: 'Agent-Kampagne', goal: 'traffic', kind: 'website', daily_budget: 12.5, countries: ['DE'], primary_text: 'Text', headline: 'Titel', funnel_id: funnelId, media_upload_ids: [upload], cta: 'LEARN_MORE' });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: 'draft', ready: true, errors: [] });
    expect(r.data.review.find((x: any) => x.label === 'Budget').value).toMatch(/12,50\s€ pro Tag/);
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    const row = t.app.db.get(`SELECT created_via, spec FROM ads_campaigns WHERE id = ?`, r.data.campaign_id)!;
    expect(row.created_via).toBe('mcp');
    expect(JSON.parse(row.spec).budget).toEqual({ type: 'daily', amount_cents: 1250 });
    // with publish_paused the reviewed campaign is created at the platform – paused
    const p = await mcp('ghl_ads_create_campaign', { location_id: loc, platform: 'meta', name: 'Agent paused', goal: 'traffic', kind: 'website', daily_budget: 10, countries: ['DE'], primary_text: 'Text', headline: 'Titel', funnel_id: funnelId, media_upload_ids: [upload], publish_paused: true });
    expect(p.data).toMatchObject({ published: true, status: 'paused' });
    expect(fake.reqs.find((x) => x.path.endsWith('/campaigns') && x.method === 'POST')!.body.status).toBe('PAUSED');
    expect(fake.reqs.some((x) => JSON.stringify(x.body ?? '').includes('"ACTIVE"'))).toBe(false);
    // errors stop the publish, the draft stays
    const bad = await mcp('ghl_ads_create_campaign', { location_id: loc, platform: 'meta', name: 'Zu teuer', goal: 'traffic', kind: 'website', daily_budget: 900, countries: ['DE'], primary_text: 'T', headline: 'H', funnel_id: funnelId, media_upload_ids: [upload], publish_paused: true });
    expect(bad.data).toMatchObject({ ready: false, published: false });
    expect(bad.data.errors.join()).toMatch(/Tageslimit/);
    expect((await mcp('ghl_ads_create_campaign', { location_id: loc, platform: 'meta', name: 'x', goal: 'traffic' })).text).toMatch(/daily_budget oder lifetime_budget/);
  });

  it('ghl_ads_update_status / ghl_ads_update_budget: pausing works, anything that spends only leaves an approval', async () => {
    const ins = await mcp('ghl_ads_insights', { location_id: loc });
    const camp = ins.data.campaigns.find((x: any) => x.name === 'Agent paused');
    expect(camp).toMatchObject({ platform: 'meta', managed: true, status: 'paused' });
    fake.reset();
    const act = await mcp('ghl_ads_update_status', { location_id: loc, campaign_id: camp.campaign_ref, status: 'active' });
    expect(act.data).toMatchObject({ status: 'approval_required' });
    const bud = await mcp('ghl_ads_update_budget', { location_id: loc, campaign_id: camp.campaign_ref, daily_budget: 40 });
    expect(bud.data).toMatchObject({ status: 'approval_required' });
    expect(fake.reqs.filter((x) => x.method === 'POST')).toHaveLength(0);
    const pause = await mcp('ghl_ads_update_status', { location_id: loc, campaign_id: camp.campaign_ref, status: 'paused' });
    expect(pause.data.status).toBe('done');
    const audits = t.app.db.all(`SELECT action, via FROM audit_log WHERE action IN ('ads.approval.request', 'ads.campaign.pause') ORDER BY at DESC LIMIT 3`);
    expect(audits.every((a) => a.via === 'mcp')).toBe(true);
    // an external campaign works through "meta:<id>" refs
    expect((await mcp('ghl_ads_update_status', { location_id: loc, campaign_id: 'nonsense', status: 'paused' })).isError).toBe(true);
    for (const a of (await t.api.get('/api/ads/approvals')).data) await t.api.post(`/api/ads/approvals/${a.id}/reject`, {});
  });
});

describe('the HyperLevel Agent and the native app', () => {
  it('the agent\'s tool call also ends in an approval (it is not a person)', async () => {
    const list = (await t.api.get('/api/ads/campaigns')).data.campaigns;
    const camp = list.find((x: any) => x.name === 'Agent paused');
    const { isHuman } = await import('../server/services/ads-store.js');
    expect(isHuman({ via: 'agent' } as any)).toBe(false);
    expect(isHuman({ via: 'mcp' } as any)).toBe(false);
    expect(isHuman({ via: 'api_key' } as any)).toBe(false);
    expect(isHuman({ via: 'agency_key' } as any)).toBe(false);
    expect(isHuman({ via: 'session' } as any)).toBe(true);
    expect(isHuman({ via: 'app' } as any)).toBe(true);
    // the agent's safety layer classifies the tools as outbound and keeps credentials out of its reach
    const { classify, agentForbidden } = await import('../server/services/agent-safety.js');
    expect(classify({ name: 'ghl_ads_update_status', annotations: { readOnlyHint: false, openWorldHint: true } })).toBe('sensitive');
    expect(classify({ name: 'ghl_ads_create_campaign', annotations: { readOnlyHint: false, openWorldHint: true } })).toBe('sensitive');
    expect(classify({ name: 'ghl_ads_insights', annotations: { readOnlyHint: true } })).toBe('read');
    expect(agentForbidden('/api/ads/agency')).toBe(true);
    expect(agentForbidden('/api/ads/connect/meta/start')).toBe(true);
    expect(agentForbidden('/api/ads/campaigns')).toBe(false);
    expect(camp).toBeTruthy();
  });

  it('the app lists campaigns and approvals and confirms spending like the web app does', async () => {
    const paired = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel', platform: 'android', app_version: '1.0' })).data;
    const app = (method: string, path: string, body?: unknown) => t.api.raw(path, { method, headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));
    const list = await app('GET', `/api/mobile/ads?location=${loc}`);
    expect(list.status).toBe(200);
    const camp = list.data.campaigns.find((c: any) => c.name === 'Agent paused');
    expect(camp).toMatchObject({ platform: 'meta', status: 'paused' });
    // activating from the app also needs the confirmation
    expect((await app('POST', `/api/mobile/ads/${camp.ref}/status`, { location_id: loc, status: 'active' })).status).toBe(409);
    const ok = await app('POST', `/api/mobile/ads/${camp.ref}/status`, { location_id: loc, status: 'active', confirm: true });
    expect(ok.data.status).toBe('done');
    expect((await app('POST', `/api/mobile/ads/${camp.ref}/status`, { location_id: loc, status: 'paused' })).data.status).toBe('done');
    // another sub-account is not reachable
    expect((await app('GET', `/api/mobile/ads?location=${'x'.repeat(10)}`)).status).toBe(404);
    // the audit log says "app"
    expect(t.app.db.get(`SELECT via FROM audit_log WHERE action = 'ads.campaign.activate' ORDER BY at DESC LIMIT 1`)).toEqual({ via: 'app' });
  });
});

describe('isolation and permissions', () => {
  it('another sub-account sees none of it – not by list, not by id', async () => {
    const mine = (await t.api.get('/api/ads/campaigns')).data.campaigns.find((x: any) => x.managed && x.status !== 'draft');
    const aud = (await t.api.get('/api/ads/audiences')).data[0];
    const form = (await t.api.get('/api/ads/leadforms')).data[0];
    const approval = (await asKey('POST', `/api/ads/campaigns/${mine.id}/status`, { status: 'active' })).data;
    t.api.setLocation(other);
    expect((await t.api.get('/api/ads/campaigns')).data.campaigns).toEqual([]);
    expect((await t.api.get('/api/ads/audiences')).data).toEqual([]);
    expect((await t.api.get('/api/ads/leadforms')).data).toEqual([]);
    expect((await t.api.get('/api/ads/approvals')).data).toEqual([]);
    expect((await t.api.get('/api/ads/activity')).data).toEqual([]);
    expect((await t.api.get('/api/ads/rules')).data.rules).toEqual([]);
    expect((await t.api.get(`/api/ads/campaigns/${mine.id}`)).status).toBe(404);
    expect((await t.api.get(`/api/ads/campaigns/${mine.id}/review`)).status).toBe(404);
    expect((await t.api.post(`/api/ads/campaigns/${mine.id}/status`, { status: 'paused' })).status).toBe(404);
    expect((await t.api.post(`/api/ads/campaigns/${mine.id}/budget`, { amount_cents: 100, confirm: true })).status).toBe(404);
    expect((await t.api.post(`/api/ads/campaigns/${mine.id}/duplicate`, {})).status).toBe(404);
    expect((await t.api.post(`/api/ads/campaigns/meta:${mine.remote_id}/status`, { status: 'paused' })).status).toBe(404);
    expect((await t.api.post(`/api/ads/approvals/${approval.approval_id}/approve`, {})).status).toBe(404);
    expect((await t.api.post(`/api/ads/audiences/${aud.id}/lookalike`, { country: 'DE' })).status).toBe(404);
    expect((await t.api.del(`/api/ads/audiences/${aud.id}`)).status).toBe(404);
    expect((await t.api.del(`/api/ads/leadforms/${form.id}`)).status).toBe(404);
    // not connected there: nothing is created and no request goes out with the other account's token
    fake.reset();
    const d = (await t.api.post('/api/ads/campaigns', { spec: metaSpec() })).data;
    const rv = (await t.api.get(`/api/ads/campaigns/${d.id}/review`)).data;
    expect(rv.ready).toBe(false);
    expect(rv.errors.join()).toMatch(/nicht verbunden/);
    expect((await t.api.post(`/api/ads/campaigns/${d.id}/publish`, { review_hash: rv.hash })).status).toBe(400);
    expect((await t.api.get('/api/ads/connections')).data.meta).toMatchObject({ connected: false, account: null });
    expect(fake.reqs).toHaveLength(0);
    // a spec cannot name the first sub-account's audience, form or upload
    const sneaky = (await t.api.post('/api/ads/campaigns', { spec: metaSpec({ audience: { countries: ['DE'], audience_ids: [aud.id] }, lead_form_id: form.id, creative: { ...metaSpec().creative, media: [{ upload_id: upload }] } }) })).data;
    const sr = (await t.api.get(`/api/ads/campaigns/${sneaky.id}/review`)).data;
    expect(sr.errors.join(' | ')).toMatch(/Zielgruppe/);
    expect(sr.errors.join(' | ')).toMatch(/Mediathek/);
    t.api.setLocation(loc);
  });

  it('a client login without the "Kampagnen" area cannot use campaigns, but the dashboard area reads the numbers', async () => {
    await t.api.post('/api/users', { email: 'nurkontakte@example.com', password: 'passwort-1', name: 'Nur Kontakte', locations: [loc], permissions: ['contacts'] });
    await t.api.post('/api/users', { email: 'kampagnen@example.com', password: 'passwort-2', name: 'Kampagnen', locations: [loc], permissions: ['campaigns'] });
    const login = async (email: string, password: string) => {
      const r = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email, password }) });
      const cookie = r.headers.get('set-cookie')!.split(';')[0];
      return (method: string, path: string, body?: unknown) => t.api.raw(path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, 'x-location-id': loc }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (x) => ({ status: x.status, data: (await x.json().catch(() => null)) as any }));
    };
    const contacts = await login('nurkontakte@example.com', 'passwort-1');
    for (const [m, p] of [['GET', '/api/ads/campaigns'], ['GET', '/api/ads/audiences'], ['GET', '/api/ads/rules'], ['GET', '/api/ads/approvals'], ['GET', '/api/ads/insights'], ['POST', '/api/ads/review'], ['GET', '/api/ads/connections']] as const) expect((await contacts(m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(403);
    const camp = await login('kampagnen@example.com', 'passwort-2');
    expect((await camp('GET', '/api/ads/campaigns')).status).toBe(200);
    // connections and credentials are settings, which this login lacks
    expect((await camp('GET', '/api/ads/connections')).status).toBe(403);
    expect((await camp('PUT', '/api/ads/agency', { meta: { app_id: '99999' } })).status).toBe(403);
    // a person with the campaign area may confirm spending in the app
    const mine = (await camp('GET', '/api/ads/campaigns')).data.campaigns.find((x: any) => x.name === 'Agent paused');
    const act = await camp('POST', `/api/ads/campaigns/${mine.id}/status`, { status: 'active', confirm: true });
    expect(act.data.status).toBe('done');
    await camp('POST', `/api/ads/campaigns/${mine.id}/status`, { status: 'paused' });
  });
});

describe('disconnecting and token upkeep', () => {
  it('extends Meta\'s long-lived token before it runs out', async () => {
    const conn = JSON.parse(t.app.db.get(`SELECT config FROM ads_accounts WHERE location_id = ? AND platform = 'meta'`, loc)!.config);
    conn.token_expires_at = new Date(Date.now() + 5 * 86400_000).toISOString();
    t.app.db.run(`UPDATE ads_accounts SET config = ? WHERE location_id = ? AND platform = 'meta'`, JSON.stringify(conn), loc);
    fake.reset();
    // The agency job runs every few hours: simulate by clearing its throttle through a fresh tick after a long wait.
    const real = Date.now;
    Date.now = () => real() + 7 * 3600_000;
    try {
      await t.app.tick();
    } finally {
      Date.now = real;
    }
    expect(fake.calls(/oauth\/access_token/).some((c) => new URL(c.url).searchParams.get('grant_type') === 'fb_exchange_token')).toBe(true);
    const after = JSON.parse(t.app.db.get(`SELECT config FROM ads_accounts WHERE location_id = ? AND platform = 'meta'`, loc)!.config);
    expect(Date.parse(after.token_expires_at)).toBeGreaterThan(Date.now() + 30 * 86400_000);
  });

  it('disconnects Google (revokes the grant) and Meta; reporting data of that platform goes with it', async () => {
    fake.reset();
    expect((await asKey('DELETE', '/api/ads/connections/google')).status).toBe(403);
    const g = await t.api.del('/api/ads/connections/google');
    expect(g.data).toEqual({ ok: true, revoked: true });
    expect(fake.f.revoked).toEqual(['1//g-refresh']);
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM ads_accounts WHERE location_id = ? AND platform = 'google'`, loc)!.n).toBe(0);
    const m = await t.api.del('/api/ads/connections/meta');
    expect(m.data.ok).toBe(true);
    expect((await t.api.get('/api/ads/connections')).data.meta).toMatchObject({ connected: false, has_token: false });
    expect(LONG_TOKEN).toBeTruthy();
  });
});
