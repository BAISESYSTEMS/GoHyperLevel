import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { twilioSignature } from '../server/services/twilio.js';
import { identityFor } from '../server/services/browser-phone.js';

/** Own numbers as caller ID (Twilio Verified Caller IDs): verification call, status callback, and the caller ID of every call path. */

const SID = `AC${'0'.repeat(31)}9`;
const TOKEN = 'd'.repeat(32);
const TWILIO_NUMBER = '+4930777000';
const OWN = '+4930111222333';
const MOBILE = '+4915100000002';
const PN = `PN${'a'.repeat(32)}`;
const twilio: { url: string; method: string; params: URLSearchParams }[] = [];
let listed: any[] = [];
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  twilio.push({ url, method, params: new URLSearchParams(String(init.body ?? '')) });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/OutgoingCallerIds.json') && method === 'POST') return json({ account_sid: SID, call_sid: `CA${'1'.repeat(32)}`, phone_number: OWN, friendly_name: 'Büro', validation_code: '482913' }, 201);
  if (url.includes('/OutgoingCallerIds.json?PhoneNumber=')) return json({ outgoing_caller_ids: listed });
  if (url.includes('/OutgoingCallerIds/') && method === 'DELETE') return new Response(null, { status: 204 });
  if (url.endsWith('/Calls.json')) return json({ sid: `CA${'2'.repeat(32)}` }, 201);
  return json({ message: 'unknown' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
async function hook(path: string, params: Record<string, string>) {
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
  contactId = (await t.api.post('/api/contacts', { first_name: 'Kim', phone: '+4915199999999' })).data.id;
});
afterAll(async () => t?.close());

describe('own number as caller ID', () => {
  let rowId = '';
  it('starts the verification call and shows the code', async () => {
    expect((await t.api.post('/api/caller-ids', { number: '12345' })).status).toBe(400);
    expect((await t.api.post('/api/caller-ids', { number: TWILIO_NUMBER })).status).toBe(400);
    const r = await t.api.post('/api/caller-ids', { number: '030 111 222 333', name: 'Büro' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ number: OWN, name: 'Büro', status: 'pending', validation_code: '482913' });
    rowId = r.data.id;
    const req = twilio.at(-1)!;
    expect(req.params.get('PhoneNumber')).toBe(OWN);
    expect(req.params.get('StatusCallback')).toBe(`http://localhost/hooks/twilio/caller-id-status/${loc}?id=${rowId}`);
    // not usable before it is verified
    expect((await t.api.put('/api/caller-ids/default', { number: OWN })).status).toBe(400);
  });

  it("verifies through Twilio's signed status callback (or the list as a fallback)", async () => {
    const path = `/hooks/twilio/caller-id-status/${loc}?id=${rowId}`;
    expect((await t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'VerificationStatus=success' })).status).toBe(403);
    expect((await hook(path, { VerificationStatus: 'success', OutgoingCallerIdSid: PN, PhoneNumber: OWN })).status).toBe(200);
    const list = (await t.api.get('/api/caller-ids')).data;
    expect(list.caller_ids[0]).toMatchObject({ number: OWN, status: 'verified', validation_code: '' });
    expect(list.twilio_numbers).toEqual([TWILIO_NUMBER]);
    expect(t.app.services.callerIds.allowed(loc)).toEqual([TWILIO_NUMBER, OWN]);
    // a second number checked through Twilio's list
    const second = (await t.api.post('/api/caller-ids', { number: '+4930999888777' })).data;
    listed = [{ sid: `PN${'b'.repeat(32)}`, phone_number: '+4930999888777' }];
    expect((await t.api.post(`/api/caller-ids/${second.id}/check`)).data.status).toBe('verified');
  });

  it('click-to-call, the browser phone and the dialer use the chosen or default caller ID', async () => {
    await t.api.post('/api/calls', { contact_id: contactId, from: OWN });
    let req = twilio.filter((x) => x.url.endsWith('/Calls.json')).at(-1)!;
    expect(req.params.get('From')).toBe(OWN);
    expect(req.params.get('Twiml')).toContain(`callerId="${OWN}"`);
    // an unknown number falls back to the default (first Twilio number)
    await t.api.post('/api/calls', { contact_id: contactId, from: '+4917012345678' });
    req = twilio.filter((x) => x.url.endsWith('/Calls.json')).at(-1)!;
    expect(req.params.get('From')).toBe(TWILIO_NUMBER);
    expect((await t.api.put('/api/caller-ids/default', { number: OWN })).data).toMatchObject({ default: OWN, default_set: OWN });
    await t.api.post('/api/calls', { contact_id: contactId });
    req = twilio.filter((x) => x.url.endsWith('/Calls.json')).at(-1)!;
    expect(req.params.get('From')).toBe(OWN);
    expect(t.app.services.callerIds.pick(loc, TWILIO_NUMBER)).toBe(TWILIO_NUMBER);
    expect(t.app.services.callerIds.pick(loc, '+4917012345678')).toBe(OWN);
  });

  it('the browser phone takes the caller ID the browser asks for (if allowed)', async () => {
    await t.api.put('/api/phone/settings', { api_key_sid: `SK${'a'.repeat(32)}`, api_secret: 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tAB', twiml_app_sid: `AP${'b'.repeat(32)}`, enabled: true });
    const userId = (await t.api.get('/api/me')).data.user.id;
    const from = `client:${identityFor(userId, loc)}`;
    const own = await hook(`/hooks/twilio/phone-out/${loc}`, { CallSid: `CA${'3'.repeat(32)}`, From: from, To: '+491701234567', AccountSid: SID, callerId: TWILIO_NUMBER });
    expect(own.text).toContain(`callerId="${TWILIO_NUMBER}"`);
    const fallback = await hook(`/hooks/twilio/phone-out/${loc}`, { CallSid: `CA${'4'.repeat(32)}`, From: from, To: '+491701234567', AccountSid: SID, callerId: '+4917099999999' });
    expect(fallback.text).toContain(`callerId="${OWN}"`);
  });

  it('removing a number deletes it at Twilio and drops it as default', async () => {
    expect((await t.api.del(`/api/caller-ids/${rowId}`)).status).toBe(200);
    const del = twilio.find((x) => x.method === 'DELETE')!;
    expect(del.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/OutgoingCallerIds/${PN}.json`);
    expect((await t.api.get('/api/caller-ids')).data).toMatchObject({ default: TWILIO_NUMBER, default_set: '' });
  });
});
