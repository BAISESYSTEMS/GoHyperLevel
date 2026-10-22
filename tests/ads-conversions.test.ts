import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionName, cleanConfig, clickConversion, googleClick, googleDateTime, splitResults, userIdentifiers } from '../server/services/ads-gconv.js';
import { startTestApp } from './helpers.js';

/** Google Ads offline conversions (UploadClickConversions + enhanced conversions for leads) with Google mocked via app.services.adsFetch. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const GOOGLE = { customer_id: '123-456-7890', login_customer_id: '9998887776', developer_token: 'DEVTOKEN0123456789', client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-test-secret', refresh_token: '1//refresh-token' };

type Upload = { url: string; headers: Record<string, string>; body: any };
let uploads: Upload[] = [];
/** Answer of uploadClickConversions for the next requests (default: every row ok). */
let answer: (body: any) => { status: number; body: unknown } = (body) => ({ status: 200, body: { results: body.conversions.map((c: any) => ({ gclid: c.gclid, conversionAction: c.conversionAction })) } });

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fakeGoogle = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'ya29.test', expires_in: 3599 });
  if (/^https:\/\/googleads\.googleapis\.com\/v\d+\/customers\/\d{10}:uploadClickConversions$/.test(url)) {
    const body = JSON.parse(init.body);
    uploads.push({ url, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body });
    const r = answer(body);
    return json(r.body, r.status);
  }
  return json({ error: { message: `unexpected ${url}` } }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const queue = (orderId: string) => t.app.db.get('SELECT * FROM ads_gconv_queue WHERE order_id = ?', orderId);

let phones = 0;
async function contact(email: string, opts: { consent?: boolean; gclid?: string; clickId?: string; clickAgoDays?: number; phone?: string } = {}) {
  // every contact its own number: contacts are matched by e-mail or phone
  const c = (await t.api.post('/api/contacts', { email, first_name: 'Lea', last_name: 'Lead', phone: opts.phone ?? `0160 ${String(1_000_000 + ++phones)}` })).data;
  if (opts.consent) {
    const r = await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'granted', channel: 'tracking', purposes: ['marketing'], note: 'Cookie-Banner: Marketing erlaubt' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  }
  if (opts.gclid) {
    const at = new Date(Date.now() - (opts.clickAgoDays ?? 1) * 864e5).toISOString();
    t.app.db.insert('attribution_touches', { id: `t${Math.random().toString(36).slice(2, 12)}`, location_id: loc, contact_id: c.id, kind: 'form', channel: 'campaign', source: 'google', medium: 'cpc', gclid: opts.gclid, click_id: opts.clickId ?? '', created_at: at });
  }
  return c;
}
async function winDeal(contactId: string, value = 2500, currency = 'EUR') {
  const pipe = (await t.api.get('/api/pipelines')).data[0];
  const opp = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, name: 'Projekt', value, currency })).data;
  expect((await t.api.patch(`/api/opportunities/${opp.id}`, { status: 'won' })).status).toBe(200);
  await t.app.events.flush();
  return opp;
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.adsFetch = fakeGoogle;
  if (!(await t.api.get('/api/pipelines')).data.length) await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }, { name: 'Angebot' }] });
});
afterAll(async () => t.close());
beforeEach(() => {
  uploads = [];
  answer = (body) => ({ status: 200, body: { results: body.conversions.map((c: any) => ({ gclid: c.gclid, conversionAction: c.conversionAction })) } });
});

describe('normalisation, hashing and payload (pure)', () => {
  it('normalises and hashes e-mail and phone the way Google specifies', () => {
    expect(userIdentifiers({ email: '  Jane.Doe+news@GoogleMail.com ', phone: '+1 (650) 555-1212' })).toEqual([
      { hashedEmail: sha('janedoe+news@googlemail.com'), userIdentifierSource: 'FIRST_PARTY' },
      { hashedPhoneNumber: sha('+16505551212'), userIdentifierSource: 'FIRST_PARTY' },
    ]);
    // dots stay for other domains, national numbers get the default country code, hashes are lower-case hex
    const [e, p] = userIdentifiers({ email: 'Max.Muster@Example.DE', phone: '0151 234 5678' });
    expect(e.hashedEmail).toBe(sha('max.muster@example.de'));
    expect(p.hashedPhoneNumber).toBe(sha('+491512345678'));
    expect(e.hashedEmail).toMatch(/^[0-9a-f]{64}$/);
    expect(userIdentifiers({ email: 'kaputt', phone: '12' })).toEqual([]);
  });

  it('formats the conversion time with the account offset (summer and winter)', () => {
    expect(googleDateTime(new Date('2026-10-05T10:00:00Z'), 'Europe/Berlin')).toBe('2026-10-05 12:00:00+02:00');
    expect(googleDateTime(new Date('2026-12-01T23:30:05Z'), 'Europe/Berlin')).toBe('2026-12-02 00:30:05+01:00');
    expect(googleDateTime(new Date('2026-12-01T10:00:00Z'), 'UTC')).toBe('2026-12-01 10:00:00+00:00');
  });

  it('finds the newest Google click and tells gclid, gbraid and wbraid apart', () => {
    const now = new Date('2026-10-05T12:00:00Z');
    expect(googleClick([{ gclid: 'Cj0old', click_id: '', created_at: '2026-10-01T00:00:00Z' }, { gclid: 'GB123', click_id: 'gbraid:GB123', created_at: '2026-10-04T00:00:00Z' }], now)).toEqual({ kind: 'gbraid', value: 'GB123', at: '2026-10-04T00:00:00Z' });
    expect(googleClick([{ gclid: 'WB9', click_id: 'wbraid:WB9', created_at: '2026-10-04T00:00:00Z' }], now)?.kind).toBe('wbraid');
    expect(googleClick([{ gclid: 'Cj0KCQ', click_id: 'msclkid:x', created_at: '2026-10-04T00:00:00Z' }], now)?.kind).toBe('gclid');
    expect(googleClick([{ gclid: 'Cj0old', click_id: '', created_at: '2026-06-01T00:00:00Z' }], now)).toBeNull();
    expect(googleClick([{ gclid: '', click_id: '', created_at: '2026-10-04T00:00:00Z' }], now)).toBeNull();
  });

  it('builds ClickConversions: one click id, identifiers never next to gbraid/wbraid, consent granted', () => {
    const ids = userIdentifiers({ email: 'a@b.de' });
    const base = { action: 'customers/1234567890/conversionActions/42', orderId: 'deal_1', at: new Date('2026-10-05T10:00:00Z'), timeZone: 'Europe/Berlin', identifiers: ids };
    expect(clickConversion({ ...base, value: 2500, currency: 'eur', click: { kind: 'gclid', value: 'Cj0', at: '' } })).toEqual({
      conversionAction: 'customers/1234567890/conversionActions/42',
      conversionDateTime: '2026-10-05 12:00:00+02:00',
      gclid: 'Cj0',
      conversionValue: 2500,
      currencyCode: 'EUR',
      orderId: 'deal_1',
      userIdentifiers: ids,
      consent: { adUserData: 'GRANTED' },
    });
    const braid = clickConversion({ ...base, click: { kind: 'gbraid', value: 'GB', at: '' } });
    expect(braid.gbraid).toBe('GB');
    expect('userIdentifiers' in braid || 'gclid' in braid || 'conversionValue' in braid).toBe(false);
    // enhanced conversions for leads: no click id, only the hashes
    expect(clickConversion({ ...base, click: null })).toMatchObject({ userIdentifiers: ids, orderId: 'deal_1' });
  });

  it('reads conversion actions and splits a partial-failure answer per row', () => {
    expect(actionName('customers/123-456-7890/conversionActions/55', '')).toBe('customers/1234567890/conversionActions/55');
    expect(actionName('987654', '1234567890')).toBe('customers/1234567890/conversionActions/987654');
    expect(() => actionName('987654', '')).toThrow(/Conversion-Aktion/);
    expect(() => cleanConfig({ events: { deal_won: { enabled: true } } })).toThrow(/Conversion-Aktion fehlt/);
    const resp = {
      partialFailureError: {
        code: 3,
        message: 'Multiple errors',
        details: [
          {
            '@type': 'type.googleapis.com/google.ads.googleads.v21.errors.GoogleAdsFailure',
            errors: [
              { errorCode: { conversionUploadError: 'CLICK_NOT_FOUND' }, message: 'click not found', location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }, { fieldName: 'gclid' }] } },
              { errorCode: { conversionUploadError: 'CLICK_CONVERSION_ALREADY_EXISTS' }, message: 'dup', location: { fieldPathElements: [{ fieldName: 'conversions', index: 2 }] } },
              { errorCode: { conversionUploadError: 'EXPIRED_CLICK' }, message: 'expired', location: { fieldPathElements: [{ fieldName: 'conversions', index: 3 }] } },
            ],
          },
        ],
      },
      results: [{ gclid: 'a' }, {}, {}, {}],
    };
    const r = splitResults(resp, 4);
    expect(r.map((x) => [x.ok, x.code, x.retry, x.duplicate])).toEqual([
      [true, '', false, false],
      [false, 'CLICK_NOT_FOUND', true, false],
      [true, 'CLICK_CONVERSION_ALREADY_EXISTS', false, true],
      [false, 'EXPIRED_CLICK', false, false],
    ]);
    expect(r[3].message).toMatch(/Conversion-Fenster/);
  });
});

describe('Google Ads offline conversions', () => {
  it('needs the Google Ads connection and resolves the conversion action', async () => {
    expect((await t.api.post('/api/ads/conversions/validate')).status).toBe(409);
    expect((await t.api.put('/api/ads/accounts/google', GOOGLE)).status).toBe(200);
    expect((await t.api.put('/api/ads/conversions', { enabled: true, config: {} })).status).toBe(400);
    const r = await t.api.put('/api/ads/conversions', { enabled: true, config: { enhanced_leads: true, events: { deal_won: { enabled: true, action: '4711' }, form_submitted: { enabled: false, action: 'customers/1234567890/conversionActions/4712', value: '25,50' } } } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ enabled: true, google: { connected: true, customer_id: '1234567890' }, consent_module: true, config: { events: { deal_won: { enabled: true, action: 'customers/1234567890/conversionActions/4711' }, form_submitted: { value: 25.5 } } } });
    expect(JSON.stringify((await t.api.get('/api/ads/conversions')).data)).not.toContain(GOOGLE.refresh_token);
  });

  it('blocks every upload without marketing consent', async () => {
    const c = await contact('ohne@kunde.example', { gclid: 'Cj0noConsent' });
    const opp = await winDeal(c.id);
    expect(queue(`deal_${opp.id}`)).toMatchObject({ status: 'blocked', error: expect.stringMatching(/Keine Einwilligung/) });
    await t.app.tick();
    expect(uploads).toEqual([]);
    // a later retry checks again – still no consent, still nothing sent
    await t.api.post(`/api/ads/conversions/${queue(`deal_${opp.id}`).id}/retry`);
    await t.api.post('/api/ads/conversions/run');
    expect(uploads).toEqual([]);
    expect(queue(`deal_${opp.id}`).status).toBe('blocked');
  });

  it('uploads a won deal with gclid, value, hashed identifiers and the API headers – once', async () => {
    const c = await contact('Anna.Lead@Gmail.com', { consent: true, gclid: 'Cj0KCQjwgclid', phone: '0151 2345678' });
    const opp = await winDeal(c.id, 2500, 'EUR');
    expect(uploads).toHaveLength(1);
    const u = uploads[0];
    expect(u.url).toMatch(/\/customers\/1234567890:uploadClickConversions$/);
    expect(u.headers).toMatchObject({ authorization: 'Bearer ya29.test', 'developer-token': GOOGLE.developer_token, 'login-customer-id': GOOGLE.login_customer_id });
    expect(u.body).toMatchObject({ partialFailure: true, validateOnly: false });
    expect(u.body.conversions).toEqual([
      {
        conversionAction: 'customers/1234567890/conversionActions/4711',
        conversionDateTime: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d$/),
        gclid: 'Cj0KCQjwgclid',
        conversionValue: 2500,
        currencyCode: 'EUR',
        orderId: `deal_${opp.id}`,
        userIdentifiers: [
          { hashedEmail: sha('annalead@gmail.com'), userIdentifierSource: 'FIRST_PARTY' },
          { hashedPhoneNumber: sha('+491512345678'), userIdentifierSource: 'FIRST_PARTY' },
        ],
        consent: { adUserData: 'GRANTED' },
      },
    ]);
    expect(JSON.stringify(u.body)).not.toMatch(/gmail\.com|Anna/i);
    expect(queue(`deal_${opp.id}`)).toMatchObject({ status: 'sent', click_kind: 'gclid', attempts: 1 });
    // won → open → won again: same order id, nothing new
    await t.api.patch(`/api/opportunities/${opp.id}`, { status: 'open' });
    await t.api.patch(`/api/opportunities/${opp.id}`, { status: 'won' });
    await t.app.events.flush();
    await t.app.tick();
    expect(uploads).toHaveLength(1);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM ads_gconv_queue WHERE order_id = ?', `deal_${opp.id}`).n).toBe(1);
  });

  it('handles partial failures per row and retries whole-request failures with backoff', async () => {
    // Google down: the batch waits and counts an attempt
    answer = () => ({ status: 503, body: { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } } });
    const a = await contact('a@kunde.example', { consent: true, gclid: 'Cj0rowA' });
    const b = await contact('b@kunde.example', { consent: true, gclid: 'GBrowB', clickId: 'gbraid:GBrowB' });
    const oa = await winDeal(a.id);
    const ob = await winDeal(b.id);
    for (const o of [oa, ob]) expect(queue(`deal_${o.id}`)).toMatchObject({ status: 'retry', attempts: 1, error: expect.stringMatching(/unavailable/i) });
    expect(Date.parse(queue(`deal_${oa.id}`).next_at) - Date.now()).toBeGreaterThan(200_000);
    // back up: row 0 ok, row 1 "click not found yet" → retry later
    answer = () => ({ status: 200, body: { partialFailureError: { code: 3, message: 'x', details: [{ errors: [{ errorCode: { conversionUploadError: 'CLICK_NOT_FOUND' }, message: 'no click', location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] } }] }] }, results: [{ gclid: 'Cj0rowA' }, {}] } });
    t.app.db.run(`UPDATE ads_gconv_queue SET next_at = ? WHERE status = 'retry'`, new Date(Date.now() - 1000).toISOString());
    uploads = [];
    const r = await t.api.post('/api/ads/conversions/run');
    expect(r.data).toMatchObject({ sent: 1, retry: 1 });
    expect(uploads[0].body.conversions.map((c: any) => c.gclid ?? c.gbraid)).toEqual(['Cj0rowA', 'GBrowB']);
    expect('userIdentifiers' in uploads[0].body.conversions[1]).toBe(false);
    expect(queue(`deal_${oa.id}`)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(queue(`deal_${ob.id}`)).toMatchObject({ status: 'retry', attempts: 2, click_kind: 'gbraid', error: expect.stringMatching(/^CLICK_NOT_FOUND: Google kennt den Klick/) });
    const log = (await t.api.get('/api/ads/conversions/log')).data;
    expect(log.find((l: any) => l.order_id === `deal_${ob.id}`)).toMatchObject({ status: 'retry', contact_name: 'Lea Lead' });
  });

  it('re-checks consent right before the upload', async () => {
    const c = await contact('widerruf@kunde.example', { consent: true, gclid: 'Cj0revoke' });
    answer = () => ({ status: 503, body: { error: { message: 'busy' } } });
    const opp = await winDeal(c.id);
    expect(queue(`deal_${opp.id}`).status).toBe('retry');
    await t.api.post(`/api/contacts/${c.id}/consent`, { action: 'revoked', channel: 'tracking', purposes: ['marketing'], note: 'Widerruf per E-Mail' });
    answer = (body) => ({ status: 200, body: { results: body.conversions.map(() => ({ ok: 1 })) } });
    t.app.db.run(`UPDATE ads_gconv_queue SET next_at = ? WHERE order_id = ?`, new Date(Date.now() - 1000).toISOString(), `deal_${opp.id}`);
    uploads = [];
    await t.app.tick();
    expect(uploads.flatMap((u) => u.body.conversions).some((x: any) => x.orderId === `deal_${opp.id}`)).toBe(false);
    expect(queue(`deal_${opp.id}`)).toMatchObject({ status: 'blocked' });
  });

  it('dry run sends validate_only and changes nothing; without a queue it validates a sample', async () => {
    t.app.db.run(`UPDATE ads_gconv_queue SET status = 'sent' WHERE status IN ('pending', 'retry', 'failed')`);
    answer = () => ({ status: 200, body: { partialFailureError: { message: 'x', details: [{ errors: [{ errorCode: { conversionUploadError: 'CONVERSION_ACTION_NOT_ELIGIBLE_FOR_ENHANCED_CONVERSIONS' }, message: 'not eligible', location: { fieldPathElements: [{ fieldName: 'conversions', index: 0 }] } }] }] }, results: [{}] } });
    const r = await t.api.post('/api/ads/conversions/validate');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ ok: false, sample: true, results: [{ ok: false, code: 'CONVERSION_ACTION_NOT_ELIGIBLE_FOR_ENHANCED_CONVERSIONS', message: expect.stringMatching(/erweiterte Conversions/) }] });
    expect(uploads[0].body).toMatchObject({ validateOnly: true, partialFailure: true });
    expect(uploads[0].body.conversions[0].userIdentifiers[0].hashedEmail).toBe(sha('test@example.com'));
    // queued rows are validated as they are, and stay queued
    const c = await contact('pruef@kunde.example', { consent: true, gclid: 'Cj0dry' });
    answer = () => ({ status: 503, body: { error: { message: 'busy' } } });
    const opp = await winDeal(c.id);
    const before = queue(`deal_${opp.id}`);
    answer = (body) => ({ status: 200, body: { results: body.conversions.map(() => ({ x: 1 })) } });
    uploads = [];
    const v = await t.api.post('/api/ads/conversions/validate');
    expect(v.data).toMatchObject({ ok: true, sample: false, results: [{ order_id: `deal_${opp.id}`, ok: true }] });
    expect(uploads[0].body.validateOnly).toBe(true);
    expect(queue(`deal_${opp.id}`)).toEqual(before);
  });

  it('uploads leads without a click as enhanced conversions, and skips them when that is off', async () => {
    const put = await t.api.put('/api/ads/conversions', { config: { events: { form_submitted: { enabled: true } } } });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    const c = await contact('ohneklick@kunde.example', { consent: true });
    await t.app.services.adsGoogleConversions.enqueue(loc, 'form_submitted', { orderId: 'form_s1', contactId: c.id, value: 25.5 });
    const conv = uploads.flatMap((u) => u.body.conversions).find((x: any) => x.orderId === 'form_s1');
    expect(conv).toMatchObject({ conversionAction: 'customers/1234567890/conversionActions/4712', conversionValue: 25.5, userIdentifiers: [{ hashedEmail: sha('ohneklick@kunde.example') }, expect.anything()] });
    expect('gclid' in conv).toBe(false);
    await t.api.put('/api/ads/conversions', { config: { enhanced_leads: false } });
    await t.app.services.adsGoogleConversions.enqueue(loc, 'form_submitted', { orderId: 'form_s2', contactId: c.id });
    expect(queue('form_s2')).toMatchObject({ status: 'skipped', error: expect.stringMatching(/Keine Google-Klick-ID/) });
  });

  it('keeps sub-accounts apart', async () => {
    const mine = t.api.location;
    const other = (await t.api.post('/api/locations', { name: 'Fremd GmbH' })).data.id;
    const someRow = t.app.db.get('SELECT id FROM ads_gconv_queue WHERE location_id = ? LIMIT 1', mine);
    t.api.setLocation(other);
    try {
      expect((await t.api.get('/api/ads/conversions/log')).data).toEqual([]);
      expect((await t.api.get('/api/ads/conversions')).data).toMatchObject({ enabled: false, google: { connected: false }, counts: {} });
      expect((await t.api.post(`/api/ads/conversions/${someRow.id}/retry`)).status).toBe(404);
    } finally {
      t.api.setLocation(mine);
    }
  });
});
