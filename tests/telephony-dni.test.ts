import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { twilioSignature } from '../server/services/twilio.js';
import { dniScript, formatDisplay, matchesSources, pickNumber } from '../server/services/dni.js';

/** Tracking numbers and dynamic number insertion: assignment from a pool, attribution of the call, the page snippet. */

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const MAIN = '+4930123456';
const MOBILE = '+4915112345678';
const POOL = ['+4930555001', '+4930555002', '+4930555003'];
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;

let counter = 0;
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/IncomingPhoneNumbers.json') && init.method === 'POST') {
    const wanted = new URLSearchParams(init.body).get('PhoneNumber')!;
    return json({ sid: `PN${String(++counter).padStart(32, '0')}`, phone_number: wanted }, 201);
  }
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let poolId = '';

const hook = async (name: string, params: Record<string, string>) => {
  const path = `/hooks/twilio/${name}/${loc}`;
  const r = await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) }, body: new URLSearchParams(params).toString() });
  return { status: r.status, text: await r.text() };
};
const visit = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
  const r = await t.api.raw(`/api/public/dni/${loc}/session`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ pool: poolId, consent: 'unknown', ...body }) });
  return (await r.json()) as any;
};
const ADS = 'https://shop.example/preise?utm_source=google&utm_medium=cpc&utm_campaign=herbst-aktion&gclid=abc';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: MAIN, forward_to: MOBILE, hours_mode: 'always' });
  poolId = (await t.api.post('/api/telephony/dni/pools', { name: 'Website', default_number: '030 123456', fallback_number: MAIN, session_minutes: 30, attribution_minutes: 60 })).data.id;
  for (const n of POOL) {
    const r = await t.api.post('/api/telephony/numbers/buy', { phone_number: n, confirm: true, kind: 'pool', pool_id: poolId, label: `Pool ${n.slice(-3)}`, address_sid: `AD${'c'.repeat(32)}` });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  }
});
afterAll(async () => {
  await t.close();
});

describe('pool assignment (pure)', () => {
  const numbers = [{ id: 'a', number: '+491' }, { id: 'b', number: '+492' }, { id: 'c', number: '+493' }];
  const s = (id: string, number_id: string, visitor_id = '', last = 1000) => ({ id, number_id, visitor_id, last_seen_ms: last });

  it('gives a new visitor a free number – the one that was quiet the longest', () => {
    const lastUsed = new Map([['a', 500], ['b', 100]]);
    expect(pickNumber({ numbers, active: [], lastUsed, exhausted: 'fallback' }).number?.id).toBe('c'); // never used
    expect(pickNumber({ numbers, active: [s('x', 'c')], lastUsed, exhausted: 'fallback' }).number?.id).toBe('b');
  });

  it('keeps the number of a running visit (same tab or same visitor)', () => {
    const active = [s('x', 'b', 'vis1'), s('y', 'a', 'vis2')];
    expect(pickNumber({ numbers, active, lastUsed: new Map(), sid: 'x', exhausted: 'fallback' })).toMatchObject({ number: { id: 'b' }, reuse: { id: 'x' } });
    expect(pickNumber({ numbers, active, lastUsed: new Map(), visitorId: 'vis2', exhausted: 'fallback' }).number?.id).toBe('a');
  });

  it('a used-up pool shows the fallback number or shares the quietest session', () => {
    const active = [s('x', 'a', '', 300), s('y', 'b', '', 100), s('z', 'c', '', 200)];
    expect(pickNumber({ numbers, active, lastUsed: new Map(), exhausted: 'fallback' }).number).toBeNull();
    expect(pickNumber({ numbers, active, lastUsed: new Map(), exhausted: 'oldest' })).toMatchObject({ number: { id: 'b' }, shared: true });
  });

  it('matches sources by source/medium, source, wildcards and channel', () => {
    const paid = { source: 'google', medium: 'cpc', channel: 'campaign' };
    expect(matchesSources([], paid)).toBe(true);
    expect(matchesSources(['google/cpc'], paid)).toBe(true);
    expect(matchesSources(['google'], paid)).toBe(true);
    expect(matchesSources(['*/cpc'], paid)).toBe(true);
    expect(matchesSources(['facebook', 'google/organic'], paid)).toBe(false);
    expect(matchesSources(['campaign'], paid)).toBe(true);
    expect(matchesSources(['direct'], { source: 'direct', medium: '(none)', channel: 'direct' })).toBe(true);
    expect(matchesSources(['direct'], paid)).toBe(false);
  });

  it('shows numbers the way people read them', () => {
    expect(formatDisplay('+4930555001')).toBe('030 555001');
    expect(formatDisplay('+4915112345678')).toBe('0151 12345678');
    expect(formatDisplay('+43123456789')).toBe('+43 123 456789');
    expect(formatDisplay('+442071234567')).toBe('+44 207 1234567');
    expect(formatDisplay('+15551234567')).toBe('+1 555 1234567');
  });
});

describe('the page snippet', () => {
  it('swaps every way of writing the number printed on the site, and only that one', () => {
    const src = dniScript({ locationId: loc || 'L', poolId: 'P', consentCookie: 'pghl_consent', visitorCookie: 'pghl_vid' });
    const sandbox: any = {
      window: {},
      document: { currentScript: { src: 'https://crm.example/a/L/dni.js?pool=P' }, cookie: '', readyState: 'complete', querySelectorAll: () => [], addEventListener() {} },
      navigator: {},
      sessionStorage: { getItem: () => '', setItem() {} },
      location: { href: 'https://shop.example/' },
      fetch: () => new Promise(() => undefined),
      URL,
      RegExp,
      encodeURIComponent,
      decodeURIComponent,
      JSON,
    };
    runInNewContext(src, sandbox);
    const { regexFor, swapText, national } = sandbox.window.__pghlDniSwap;
    expect(national('+49 30 123456')).toBe('30123456');
    expect(national('030 123456')).toBe('30123456');
    expect(national('0049 30 123456')).toBe('30123456');
    const re = regexFor('030 123456');
    const swap = (t: string) => swapText(t, re, '030 555001', '+49 30 555001');
    expect(swap('Rufen Sie an: 030 123456 oder 030/123456 oder (030) 12 34 56.')).toBe('Rufen Sie an: 030 555001 oder 030 555001 oder 030 555001.');
    expect(swap('International: +49 30 123456, +49 (0)30 123456 und 0049 30 123456')).toBe('International: +49 30 555001, +49 30 555001 und +49 30 555001');
    expect(swap('Fax 030 654321 bleibt, Bestellnummer 12345 auch')).toBe('Fax 030 654321 bleibt, Bestellnummer 12345 auch');
    expect(swap('030-123-456')).toBe('030 555001');
    expect(regexFor('12')).toBeNull();
  });

  it('is served per pool and stays quiet when the pool is off', async () => {
    const js = await (await t.api.raw(`/a/${loc}/dni.js?pool=${poolId}`)).text();
    expect(js).toContain(`/api/public/dni/'+encodeURIComponent(loc)+'/session`);
    expect(js).toContain('pghl_consent');
    expect(js).toContain('[data-pghl-phone]');
    expect(await (await t.api.raw(`/a/${loc}/dni.js?pool=gibtsnicht`)).text()).toContain('number swap off');
    const pools = (await t.api.get('/api/telephony/dni/pools')).data;
    expect(pools[0].snippet).toBe(`<script src="http://localhost/a/${loc}/dni.js?pool=${poolId}" async></script>`);
    expect(pools[0].numbers).toHaveLength(3);
  });
});

describe('visits get a number from the pool', () => {
  const sids: string[] = [];

  it('assigns one number per visit and keeps it while the visit runs', async () => {
    const a = await visit({ url: ADS, referrer: '' });
    expect(POOL).toContain(a.number);
    expect(a).toMatchObject({ display: formatDisplay(a.number), default_number: '030 123456', display_intl: expect.stringMatching(/^\+49 30 /) });
    expect(a.sid).toMatch(/^[A-Za-z0-9]{16}$/);
    const again = await visit({ url: 'https://shop.example/kontakt', sid: a.sid });
    expect(again).toMatchObject({ number: a.number, sid: a.sid });
    const b = await visit({ url: 'https://shop.example/?utm_source=newsletter&utm_medium=email' });
    expect(b.number).not.toBe(a.number);
    sids.push(a.sid, b.sid);
    const row = t.app.db.get('SELECT * FROM dni_sessions WHERE id = ?', a.sid)!;
    expect(row).toMatchObject({ source: 'google', medium: 'cpc', campaign: 'herbst-aktion', channel: 'campaign', gclid: 'abc', landing_page: 'https://shop.example/preise' });
  });

  it('shows the fallback number when the pool is used up and nothing is stored for refusing visitors', async () => {
    const c = await visit({ url: ADS });
    expect(POOL).toContain(c.number);
    const d = await visit({ url: ADS });
    expect(d).toMatchObject({ number: MAIN, pool_empty: true });
    // "Nein" at the cookie banner, Global Privacy Control and bots: no session at all (the page keeps its number).
    const before = t.app.db.get('SELECT COUNT(*) n FROM dni_sessions')!.n;
    expect((await visit({ url: ADS, consent: 'denied' })).number).toBe(MAIN);
    expect((await visit({ url: ADS }, { 'sec-gpc': '1' })).number).toBe(MAIN);
    expect((await visit({ url: ADS }, { 'user-agent': 'Googlebot/2.1' })).number).toBe('');
    expect(t.app.db.get('SELECT COUNT(*) n FROM dni_sessions')!.n).toBe(before);
    sids.push(c.sid);
  });

  it('can be limited to paid traffic, and "oldest" shares instead of falling back', async () => {
    await t.api.put(`/api/telephony/dni/pools/${poolId}`, { sources: ['google/cpc', 'facebook'], exhausted: 'oldest' });
    expect((await visit({ url: 'https://shop.example/?utm_source=newsletter&utm_medium=email' }))).toMatchObject({ number: '', qualified: false });
    const shared = await visit({ url: ADS });
    expect(POOL).toContain(shared.number);
    expect(shared.shared).toBe(true);
    await t.api.put(`/api/telephony/dni/pools/${poolId}`, { sources: [], exhausted: 'fallback' });
  });

  it('validates the pool settings', async () => {
    expect((await t.api.put(`/api/telephony/dni/pools/${poolId}`, { default_number: 'Rufen Sie an' })).status).toBe(400);
    expect((await t.api.put(`/api/telephony/dni/pools/${poolId}`, { selector: '<script>' })).status).toBe(400);
    expect((await t.api.put(`/api/telephony/dni/pools/${poolId}`, { exhausted: 'egal' })).status).toBe(400);
    expect((await t.api.put(`/api/telephony/dni/pools/${poolId}`, { session_minutes: 1 })).data.session_minutes).toBe(5);
    await t.api.put(`/api/telephony/dni/pools/${poolId}`, { session_minutes: 30 });
  });
});

describe('inbound calls on tracking numbers', () => {
  it('attributes a call on a pool number to the visit – on the call and on the contact', async () => {
    const visitor = await visit({ url: ADS });
    // (the pool is used up by the earlier visits: free a number first)
    t.app.db.run('UPDATE dni_sessions SET expires_at = ? WHERE number = ?', new Date(Date.now() - 3 * 3600_000).toISOString(), POOL[0]);
    const mine = visitor.number === MAIN ? await visit({ url: ADS }) : visitor;
    expect(POOL).toContain(mine.number);
    const r = await hook('voice', { CallSid: callSid(41), From: '+4917051111', To: mine.number });
    expect(r.status).toBe(200);
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(41))!;
    expect(call).toMatchObject({ attr_source: 'google', attr_medium: 'cpc', attr_campaign: 'herbst-aktion' });
    expect(call.tracking_number_id).toBeTruthy();
    expect(t.app.db.get('SELECT calls FROM dni_sessions WHERE id = ?', mine.sid)!.calls).toBe(1);
    // The contact has the call as a touch with the campaign: reports by source include it.
    const attr = (await t.api.get(`/api/contacts/${call.contact_id}/attribution`)).data;
    expect(attr.summary).toMatchObject({ first_source: 'google', first_medium: 'cpc', first_campaign: 'herbst-aktion' });
    expect(attr.touches[0]).toMatchObject({ kind: 'call', source: 'google', medium: 'cpc', campaign: 'herbst-aktion' });
  });

  it('a call long after the visit (past the attribution window) is not attributed', async () => {
    const visitor = await visit({ url: 'https://shop.example/?utm_source=facebook&utm_medium=social&utm_campaign=x' });
    t.app.db.run('UPDATE dni_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?', new Date(Date.now() - 4 * 3600_000).toISOString(), new Date(Date.now() - 5 * 3600_000).toISOString(), visitor.sid);
    await hook('voice', { CallSid: callSid(42), From: '+4917052222', To: visitor.number });
    expect(t.app.db.get('SELECT attr_source, tracking_number_id FROM calls WHERE sid = ?', callSid(42))).toMatchObject({ attr_source: '' });
  });

  it('a static tracking number belongs to one campaign', async () => {
    const r = await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555009', confirm: true, kind: 'tracking', label: 'Flyer Herbst', source: 'Flyer', medium: 'Print', campaign: 'Herbstmesse', address_sid: `AD${'c'.repeat(32)}` });
    expect(r.data).toMatchObject({ kind: 'tracking', source: 'flyer', medium: 'print', campaign: 'herbstmesse' });
    await hook('voice', { CallSid: callSid(43), From: '+4917053333', To: '+4930555009' });
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(43))!;
    expect(call).toMatchObject({ attr_source: 'flyer', attr_medium: 'print', attr_campaign: 'herbstmesse', tracking_number_id: r.data.id });
    const attr = (await t.api.get(`/api/contacts/${call.contact_id}/attribution`)).data;
    expect(attr.summary).toMatchObject({ first_source: 'flyer', first_medium: 'print', first_campaign: 'herbstmesse' });
    // The call still rings the team like any call on the sub-account.
  });

  it('reports calls by source, campaign and number, as CSV too', async () => {
    const bySource = (await t.api.get('/api/telephony/tracking/report?group=source')).data;
    expect(bySource.rows.map((x: any) => [x.label, x.calls])).toEqual(expect.arrayContaining([['google', 1], ['flyer', 1]]));
    expect(bySource.totals.calls).toBe(2);
    expect(bySource.totals.visits).toBeGreaterThanOrEqual(4);
    const byCampaign = (await t.api.get('/api/telephony/tracking/report?group=campaign')).data;
    expect(byCampaign.rows.find((x: any) => x.key === 'flyer|print|herbstmesse')).toMatchObject({ calls: 1, callers: 1 });
    const byNumber = (await t.api.get('/api/telephony/tracking/report?group=number')).data;
    expect(byNumber.rows.map((x: any) => x.label)).toContain('+4930555009 (Flyer Herbst)');
    const csv = await (await t.api.raw(`/api/telephony/tracking/report.csv?locationId=${loc}`, { headers: { cookie: t.api.cookie } })).text();
    expect(csv).toContain('Quelle,Anrufe');
    expect((await t.api.get('/api/telephony/tracking/report?from=2026-10-09&to=2026-10-01')).status).toBe(400);
  });

  it('deleting a pool keeps its numbers as plain tracking numbers', async () => {
    expect((await t.api.del(`/api/telephony/dni/pools/${poolId}`)).data.ok).toBe(true);
    const rows = t.app.db.all('SELECT kind, pool_id FROM phone_numbers WHERE number IN (?, ?, ?)', ...POOL);
    expect(rows.every((r: any) => r.kind === 'tracking' && r.pool_id === null)).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) n FROM dni_sessions WHERE pool_id = ?', poolId)!.n).toBe(0);
  });
});

describe('funnel pages', () => {
  it('get the snippet without copying it', async () => {
    const pool = (await t.api.post('/api/telephony/dni/pools', { name: 'Funnel-Pool', default_number: '030 123456', on_funnels: true })).data;
    await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555010', confirm: true, kind: 'pool', pool_id: pool.id, address_sid: `AD${'c'.repeat(32)}` });
    const funnel = (await t.api.post('/api/funnels', { name: 'Angebot', template: 'leadmagnet' })).data;
    const slug = funnel.slug;
    const html = await (await t.api.raw(`/p/${slug}`)).text();
    expect(html).toContain(`<script src="http://localhost/a/${loc}/dni.js?pool=${pool.id}" async></script>`);
    await t.api.put(`/api/telephony/dni/pools/${pool.id}`, { on_funnels: false });
    expect(await (await t.api.raw(`/p/${slug}`)).text()).not.toContain('dni.js');
  });
});
