import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { twilioSignature } from '../server/services/twilio.js';
import { holdTwiml, identityFor, outgoingTwiml, parseIdentity, voiceAccessToken } from '../server/services/browser-phone.js';
import { contentSecurityPolicy } from '../server/core/app.js';
import { requiredPermission } from '../server/core/permissions.js';
import type { AppEvent } from '../server/core/events.js';

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const KEY_SID = `SK${'a'.repeat(32)}`;
const KEY_SECRET = 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tAB';
const APP_SID = `AP${'b'.repeat(32)}`;
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;

/** Fake Twilio REST API: records requests, creates keys/apps, updates calls. */
const requests: { method: string; path: string; body: URLSearchParams }[] = [];
let childCalls: { sid: string }[] = [];
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  const path = url.replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, '');
  requests.push({ method: init.method ?? 'GET', path, body: new URLSearchParams(init.body ?? '') });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers?.authorization !== `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`) return json({ message: 'Authenticate' }, 401);
  if (path === '/Keys.json') return json({ sid: KEY_SID, secret: KEY_SECRET }, 201);
  if (path === '/Applications.json') return json({ sid: APP_SID }, 201);
  if (path.startsWith('/Applications/')) return json({ sid: APP_SID });
  if (path.startsWith('/Calls.json?ParentCallSid=')) return json({ calls: childCalls });
  if (/^\/Calls\/CA\d{32}\.json$/.test(path)) return json({ sid: path.slice(7, 41) });
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let userId = '';
const events: AppEvent[] = [];

async function hook(name: string, params: Record<string, string>, opts: { query?: string; sign?: boolean } = {}) {
  const path = `/hooks/twilio/${name}/${loc}${opts.query ?? ''}`;
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.sign === false ? {} : { 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) }) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  userId = me.user.id;
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.events.on('*', (e) => void events.push(e));
  await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
});
afterAll(async () => {
  await t.close();
});

describe('browser phone building blocks', () => {
  it('signs a Twilio access token with a VoiceGrant', () => {
    const jwt = voiceAccessToken({ accountSid: SID, apiKeySid: KEY_SID, apiSecret: KEY_SECRET, identity: 'u_a_b', appSid: APP_SID, incoming: true, ttl: 600, now: 1_800_000_000_000 });
    const [h, p, sig] = jwt.split('.');
    expect(decode(h)).toEqual({ alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' });
    expect(decode(p)).toEqual({
      jti: `${KEY_SID}-1800000000`,
      iss: KEY_SID,
      sub: SID,
      iat: 1_800_000_000,
      nbf: 1_800_000_000,
      exp: 1_800_000_600,
      grants: { identity: 'u_a_b', voice: { outgoing: { application_sid: APP_SID }, incoming: { allow: true } } },
    });
    expect(sig).toBe(createHmac('sha256', KEY_SECRET).update(`${h}.${p}`).digest('base64url'));
    const outOnly = decode(voiceAccessToken({ accountSid: SID, apiKeySid: KEY_SID, apiSecret: KEY_SECRET, identity: 'u_a_b', appSid: APP_SID, incoming: false }).split('.')[1]);
    expect(outOnly.grants.voice.incoming).toBeUndefined();
    expect(outOnly.exp - outOnly.iat).toBe(3600);
  });

  it('parses identities and builds the call TwiML', () => {
    expect(parseIdentity(`client:${identityFor('User1', 'Loc2')}`)).toEqual({ userId: 'User1', locationId: 'Loc2' });
    expect(parseIdentity('client:admin')).toBeNull();
    expect(parseIdentity('u_a_b_c')).toBeNull();
    expect(outgoingTwiml({ callerId: TWILIO_NUMBER, number: '+491701234567', action: 'https://x/d', legCallback: 'https://x/l' })).toContain(
      '<Dial callerId="+4930123456" timeout="30" answerOnBridge="true" action="https://x/d" method="POST"><Number statusCallback="https://x/l" statusCallbackEvent="answered completed" statusCallbackMethod="POST">+491701234567</Number></Dial>',
    );
    expect(holdTwiml('hold-1', 'https://x/h')).toContain('<Conference startConferenceOnEnter="false" endConferenceOnExit="true" beep="false">hold-1</Conference>');
  });

  it('adds only plain https/wss origins to the CSP', () => {
    const fake = { services: { cspExtra: { connect: ['wss://voice-js.roaming.twilio.com', "https://evil.example; script-src 'unsafe-inline'", 'javascript:alert(1)', 'https://sdk.twilio.com'] } } } as any;
    const csp = contentSecurityPolicy(fake);
    expect(csp).toContain("connect-src 'self' wss://voice-js.roaming.twilio.com https://sdk.twilio.com;");
    expect(csp).not.toContain('evil');
    expect(csp).toContain("script-src 'self';");
    expect(requiredPermission('PUT', '/api/phone/settings')).toBe('settings');
    expect(requiredPermission('GET', '/api/phone/token')).toBe('conversations');
  });
});

describe('Browser-Telefon', () => {
  it('stores the API key secret sealed and never shows it', async () => {
    expect((await t.api.get('/api/phone/status')).data).toMatchObject({ enabled: false, ready: false });
    expect((await t.api.put('/api/phone/settings', { api_key_sid: 'XY' })).data.error).toContain('SK');
    expect((await t.api.put('/api/phone/settings', { twiml_app_sid: 'AP1' })).data.error).toContain('AP');
    expect((await t.api.put('/api/phone/settings', { api_secret: 'kurz' })).data.error).toContain('Secret');
    expect((await t.api.put('/api/phone/settings', { incoming: 'immer' })).status).toBe(400);
    const r = await t.api.put('/api/phone/settings', { api_key_sid: KEY_SID, api_secret: KEY_SECRET, incoming: 'parallel' });
    expect(r.data).toMatchObject({ api_secret: '••••••', api_secret_set: true, ready: false, missing: ['TwiML App SID'] });
    expect(JSON.stringify(r.data)).not.toContain(KEY_SECRET);
    expect(t.app.db.get('SELECT api_secret FROM phone_settings WHERE location_id = ?', loc)!.api_secret).toMatch(/^v1:/);
    // Saving the mask keeps the secret.
    await t.api.put('/api/phone/settings', { api_secret: '••••••' });
    expect((await t.api.get('/api/phone/settings')).data.api_secret_set).toBe(true);
  });

  it('creates the missing TwiML app at Twilio pointing at the outgoing webhook', async () => {
    requests.length = 0;
    const r = await t.api.post('/api/phone/setup');
    expect(r.status).toBe(200);
    expect(r.data.twiml_app_sid).toBe(APP_SID);
    expect(requests.map((x) => x.path)).toEqual(['/Applications.json']);
    expect(requests[0].body.get('VoiceUrl')).toBe(`http://localhost/hooks/twilio/phone-out/${loc}`);
    expect(requests[0].body.get('StatusCallback')).toBe(`http://localhost/hooks/twilio/voice-status/${loc}`);
    expect(r.data.webhooks.voice).toBe(`http://localhost/hooks/twilio/phone-out/${loc}`);
  });

  it('hands out tokens only when enabled and only to signed-in users', async () => {
    expect((await t.api.get('/api/phone/token')).data.error).toContain('aus');
    await t.api.put('/api/phone/settings', { enabled: true });
    const r = await t.api.get('/api/phone/token');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ identity: `u_${userId}_${loc}`, edge: 'roaming', number: TWILIO_NUMBER, incoming: true });
    const payload = decode(r.data.token.split('.')[1]);
    expect(payload).toMatchObject({ iss: KEY_SID, sub: SID, grants: { identity: `u_${userId}_${loc}`, voice: { outgoing: { application_sid: APP_SID }, incoming: { allow: true } } } });
    const [h, p, sig] = r.data.token.split('.');
    expect(sig).toBe(createHmac('sha256', KEY_SECRET).update(`${h}.${p}`).digest('base64url'));
    const key = (await t.api.post('/api/api-keys', { name: 'Zapier' })).data.key;
    expect((await t.api.raw('/api/phone/token', { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
  });

  it('allows the Twilio hosts in the app CSP', async () => {
    mkdirSync(t.app.config.webDir, { recursive: true });
    writeFileSync(join(t.app.config.webDir, 'index.html'), '<!doctype html><title>x</title>');
    const r = await t.api.raw('/app');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self' wss://voice-js.roaming.twilio.com wss://voice-js.frankfurt.twilio.com");
    expect(csp).toContain('https://sdk.twilio.com');
    expect(csp).toContain("default-src 'self'; script-src 'self';");
  });

  it('places outgoing browser calls with the Twilio number as caller ID', async () => {
    const from = `client:${identityFor(userId, loc)}`;
    expect((await hook('phone-out', { CallSid: callSid(1), From: from, To: '+491701234567', AccountSid: SID }, { sign: false })).status).toBe(403);
    expect((await hook('phone-out', { CallSid: callSid(1), From: from, To: '+491701234567', AccountSid: `AC${'9'.repeat(32)}` })).text).toContain('Falsches Twilio-Konto');
    expect((await hook('phone-out', { CallSid: callSid(1), From: `client:${identityFor(userId, 'Fremd')}`, To: '+491701234567', AccountSid: SID })).text).toContain('darf hier nicht telefonieren');
    expect((await hook('phone-out', { CallSid: callSid(1), From: from, To: TWILIO_NUMBER, AccountSid: SID })).text).toContain('eigene Nummer');
    expect((await hook('phone-out', { CallSid: callSid(1), From: from, To: 'abc', AccountSid: SID })).text).toContain('ungültig');

    const r = await hook('phone-out', { CallSid: callSid(2), From: from, To: '0170 1234567', AccountSid: SID, ApplicationSid: APP_SID });
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(2))!;
    expect(call).toMatchObject({ direction: 'out', from_number: TWILIO_NUMBER, to_number: '+491701234567', user_id: userId, status: 'initiated' });
    expect(r.text).toContain(`<Dial callerId="${TWILIO_NUMBER}" timeout="30" answerOnBridge="true" action="http://localhost/hooks/twilio/phone-dial/${loc}?call=${call.id}" method="POST">`);
    expect(r.text).toContain(`<Number statusCallback="http://localhost/hooks/twilio/phone-leg/${loc}?call=${call.id}" statusCallbackEvent="answered completed" statusCallbackMethod="POST">+491701234567</Number>`);
    expect(t.app.db.get('SELECT phone FROM contacts WHERE id = ?', call.contact_id)!.phone).toBe('+491701234567');

    // Nobody answers: the call ends as "nicht erreicht".
    expect((await hook('phone-dial', { CallSid: callSid(2), DialCallStatus: 'no-answer' }, { query: `?call=${call.id}` })).text).toContain('<Hangup/>');
    expect(t.app.db.get('SELECT * FROM calls WHERE id = ?', call.id)).toMatchObject({ status: 'no-answer', answered: 0 });
  });

  it('holds and resumes an outgoing call through a conference room', async () => {
    const from = `client:${identityFor(userId, loc)}`;
    await hook('phone-out', { CallSid: callSid(3), From: from, To: '+491709999999', AccountSid: SID });
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(3))!;
    expect((await t.api.post(`/api/phone/calls/${call.id}/hold`)).data.error).toContain('nicht verbunden');
    await hook('phone-leg', { CallSid: callSid(4), ParentCallSid: callSid(3), CallStatus: 'in-progress' }, { query: `?call=${call.id}` });
    expect(t.app.db.get('SELECT * FROM calls WHERE id = ?', call.id)).toMatchObject({ answered: 1, status: 'in-progress' });

    requests.length = 0;
    const held = await t.api.post(`/api/phone/calls/${call.id}/hold`);
    expect(held.data).toMatchObject({ hold: true, ended: false, number: '+491709999999' });
    expect(requests[0].path).toBe(`/Calls/${callSid(4)}.json`);
    expect(requests[0].body.get('Twiml')).toContain(`<Conference startConferenceOnEnter="false" endConferenceOnExit="true" beep="false">hold-${call.id}</Conference>`);
    expect(requests[0].body.get('Twiml')).toContain(`action="http://localhost/hooks/twilio/phone-held/${loc}?call=${call.id}"`);
    // The browser leg's Dial ends because the other party left it: that is no hang-up.
    expect((await hook('phone-dial', { CallSid: callSid(3), DialCallStatus: 'completed' }, { query: `?call=${call.id}` })).text).toContain('<Hangup/>');
    await hook('voice-status', { CallSid: callSid(3), CallStatus: 'completed', CallDuration: '20' });
    expect(t.app.db.get('SELECT * FROM calls WHERE id = ?', call.id)).toMatchObject({ ended_at: null, sid: callSid(4) });
    expect((await t.api.get(`/api/phone/calls/${call.id}`)).data).toMatchObject({ hold: true, ended: false });

    // Another user can't resume it; the owner joins the room again.
    expect((await hook('phone-out', { CallSid: callSid(5), From: `client:${identityFor('Fremder', loc)}`, resume: call.id, AccountSid: SID })).text).toContain('darf hier nicht');
    const resumed = await hook('phone-out', { CallSid: callSid(6), From: from, resume: call.id, AccountSid: SID });
    expect(resumed.text).toContain(`<Dial action="http://localhost/hooks/twilio/phone-dial/${loc}?call=${call.id}" method="POST"><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">hold-${call.id}</Conference></Dial>`);
    expect((await t.api.get(`/api/phone/calls/${call.id}`)).data.hold).toBe(false);
    expect((await hook('phone-out', { CallSid: callSid(7), From: from, resume: call.id, AccountSid: SID })).text).toContain('nicht mehr gehalten');

    await hook('phone-dial', { CallSid: callSid(6), DialCallStatus: 'completed' }, { query: `?call=${call.id}` });
    await t.app.events.flush();
    expect(t.app.db.get('SELECT * FROM calls WHERE id = ?', call.id)).toMatchObject({ status: 'completed', answered: 1 });
    expect(events.some((e) => e.type === 'call.completed' && e.data.callId === call.id && e.data.direction === 'out')).toBe(true);
  });

  it('finds the other leg at Twilio when its status callback has not arrived yet', async () => {
    await hook('phone-out', { CallSid: callSid(40), From: `client:${identityFor(userId, loc)}`, To: '+491708888888', AccountSid: SID });
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(40))!;
    childCalls = [{ sid: callSid(41) }];
    requests.length = 0;
    expect((await t.api.post(`/api/phone/calls/${call.id}/hold`)).data.hold).toBe(true);
    expect(requests.map((r) => r.path)).toEqual([`/Calls.json?ParentCallSid=${callSid(40)}&Status=in-progress&PageSize=5`, `/Calls/${callSid(41)}.json`]);
    childCalls = [];
    await t.api.post(`/api/phone/calls/${call.id}/hangup`);
    expect(t.app.db.get('SELECT status FROM calls WHERE id = ?', call.id)!.status).toBe('completed');
  });

  it('rings available browsers on inbound calls, next to or instead of the mobile', async () => {
    const id = identityFor(userId, loc);
    const none = await hook('voice', { CallSid: callSid(20), From: '+4917011111', To: TWILIO_NUMBER });
    expect(none.text).not.toContain('<Client>');
    expect((await t.api.post('/api/phone/presence', { available: true })).data.available).toBe(true);
    const both = await hook('voice', { CallSid: callSid(21), From: '+4917011112', To: TWILIO_NUMBER });
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(21))!;
    expect(both.text).toContain(`<Number>${MOBILE}</Number><Client><Identity>${id}</Identity><Parameter name="callId" value="${call.id}"/><Parameter name="from" value="+4917011112"/></Client></Dial>`);

    await t.api.put('/api/phone/settings', { incoming: 'browser_only' });
    const only = await hook('voice', { CallSid: callSid(22), From: '+4917011113', To: TWILIO_NUMBER });
    expect(only.text).not.toContain('<Number>');
    expect(only.text).toContain(`<Identity>${id}</Identity>`);

    // Not available (or the browser went away): the mobile rings again.
    await t.api.post('/api/phone/presence', { available: false });
    expect((await hook('voice', { CallSid: callSid(23), From: '+4917011114', To: TWILIO_NUMBER })).text).toContain(`<Number>${MOBILE}</Number>`);
    await t.api.post('/api/phone/presence', { available: true });
    t.app.db.run('UPDATE phone_presence SET seen_at = ?', new Date(Date.now() - 10 * 60_000).toISOString());
    const stale = await hook('voice', { CallSid: callSid(24), From: '+4917011115', To: TWILIO_NUMBER });
    expect(stale.text).toContain(`<Number>${MOBILE}</Number>`);
    expect(stale.text).not.toContain('<Client>');
    await t.api.post('/api/phone/presence', { available: true });
    await t.api.put('/api/phone/settings', { incoming: 'parallel' });
  });

  it('remembers who took an inbound call and can hold it', async () => {
    await hook('voice', { CallSid: callSid(30), From: '+4917011120', To: TWILIO_NUMBER });
    const call = t.app.db.get('SELECT * FROM calls WHERE sid = ?', callSid(30))!;
    const acc = await t.api.post('/api/phone/accepted', { call_id: call.id, agent_sid: callSid(31) });
    expect(acc.data).toMatchObject({ direction: 'in', number: '+4917011120', hold: false });
    expect(t.app.db.get('SELECT * FROM calls WHERE id = ?', call.id)).toMatchObject({ user_id: userId, answered: 1 });

    requests.length = 0;
    expect((await t.api.post(`/api/phone/calls/${call.id}/hold`)).data.hold).toBe(true);
    expect(requests[0].path).toBe(`/Calls/${callSid(30)}.json`);
    // If Twilio reports the interrupted ring group, telephony must not end the call.
    await hook('voice-dial', { CallSid: callSid(30), DialCallStatus: 'completed', DialCallDuration: '12' });
    expect(t.app.db.get('SELECT ended_at FROM calls WHERE id = ?', call.id)!.ended_at).toBeNull();

    // Hanging up a held call ends it at Twilio too.
    requests.length = 0;
    const hung = await t.api.post(`/api/phone/calls/${call.id}/hangup`);
    expect(hung.data).toMatchObject({ ended: true, status: 'completed' });
    expect(requests[0]).toMatchObject({ method: 'POST', path: `/Calls/${callSid(30)}.json` });
    expect(requests[0].body.get('Status')).toBe('completed');
  });
});
