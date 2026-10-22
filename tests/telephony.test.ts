import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { DEFAULT_HOURS, isOpen, twilioSignature, validTwilioSignature, voicemailTwiml } from '../server/services/twilio.js';
import type { AppEvent } from '../server/core/events.js';
import { requiredPermission } from '../server/core/permissions.js';

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const recSid = (n: number) => `RE${String(n).padStart(32, '0')}`;

/** A small fake of the Twilio REST API: records every request. */
const requests: { url: string; method: string; headers: Record<string, string>; body: URLSearchParams }[] = [];
let callCounter = 900;
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  requests.push({ url, method: init.method ?? 'GET', headers, body: new URLSearchParams(init.body ?? '') });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (headers.authorization !== `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`) return json({ message: 'Authenticate' }, 401);
  const path = url.replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, '');
  if (path === '/Calls.json') return json({ sid: callSid(++callCounter), status: 'queued' }, 201);
  if (/^\/Recordings\/RE\d{32}\.mp3$/.test(path)) return new Response(Buffer.from('ID3-fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  if (path.startsWith('/IncomingPhoneNumbers.json')) return json({ incoming_phone_numbers: [{ sid: `PN${'a'.repeat(32)}`, phone_number: '+4930999999', friendly_name: 'Berlin', voice_url: '' }] });
  if (path === `/IncomingPhoneNumbers/PN${'a'.repeat(32)}.json`) return json({ sid: `PN${'a'.repeat(32)}`, phone_number: '+4930999999' });
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: AppEvent[] = [];

/** Posts a form like Twilio does, signed with the auth token (unless told otherwise). */
async function hook(name: string, params: Record<string, string>, opts: { token?: string; sign?: boolean; query?: string } = {}) {
  const path = `/hooks/twilio/${name}/${loc}${opts.query ?? ''}`;
  const signature = twilioSignature(opts.token ?? TOKEN, `http://localhost${path}`, params);
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.sign === false ? {} : { 'x-twilio-signature': signature }) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}

const callBySid = (sid: string) => t.app.db.get('SELECT * FROM calls WHERE sid = ?', sid)!;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.events.on('*', (e) => void events.push(e));
});
afterAll(async () => {
  await t.close();
});

describe('Twilio signatures', () => {
  it('matches the documented test vector and one computed independently with openssl', () => {
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    expect(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
    // printf '%s' 'http://localhost/hooks/twilio/voice/LOCCallSidCA…01From+4915112345678To+4930123456' | openssl dgst -sha1 -hmac tok -binary | base64
    expect(twilioSignature('tok', 'http://localhost/hooks/twilio/voice/LOC', { To: '+4930123456', From: '+4915112345678', CallSid: callSid(1) })).toBe('+Lu9k6oPEdozqhHwwEscIVSRpe0=');
  });

  it('accepts only the exact URL, parameters and token', () => {
    const url = 'https://crm.example.com/hooks/twilio/voice/x';
    const p = { CallSid: callSid(2), From: MOBILE };
    const sig = twilioSignature(TOKEN, url, p);
    expect(validTwilioSignature(TOKEN, sig, [url], p)).toBe(true);
    expect(validTwilioSignature(TOKEN, sig, ['https://old.example.com/x', url], p)).toBe(true);
    expect(validTwilioSignature('e'.repeat(32), sig, [url], p)).toBe(false);
    expect(validTwilioSignature(TOKEN, sig, [url], { ...p, From: '+4917000000' })).toBe(false);
    expect(validTwilioSignature(TOKEN, sig, [`${url}?x=1`], p)).toBe(false);
    expect(validTwilioSignature(TOKEN, undefined, [url], p)).toBe(false);
    expect(validTwilioSignature(TOKEN, 'short', [url], p)).toBe(false);
    expect(validTwilioSignature('', sig, [url], p)).toBe(false);
    // Repeated keys: sorted by value too, so the order they arrive in doesn't matter.
    expect(twilioSignature(TOKEN, url, [['a', '2'], ['a', '1']])).toBe(twilioSignature(TOKEN, url, [['a', '1'], ['a', '2']]));
  });
});

describe('business hours', () => {
  it('forwards on weekdays 9–17 in the sub-account timezone', () => {
    const tz = 'Europe/Berlin';
    expect(isOpen('hours', DEFAULT_HOURS, tz, new Date('2026-10-05T08:00:00Z'))).toBe(true); // Mo 10:00
    expect(isOpen('hours', DEFAULT_HOURS, tz, new Date('2026-10-05T16:30:00Z'))).toBe(false); // Mo 18:30
    expect(isOpen('hours', DEFAULT_HOURS, tz, new Date('2026-10-05T06:59:00Z'))).toBe(false); // Mo 08:59
    expect(isOpen('hours', DEFAULT_HOURS, tz, new Date('2026-10-03T09:00:00Z'))).toBe(false); // Sa
    expect(isOpen('always', DEFAULT_HOURS, tz, new Date('2026-10-03T23:00:00Z'))).toBe(true);
    expect(isOpen('never', DEFAULT_HOURS, tz, new Date('2026-10-05T08:00:00Z'))).toBe(false);
    const night = { ...DEFAULT_HOURS, mon: { open: true, from: '22:00', to: '02:00' } };
    expect(isOpen('hours', night, tz, new Date('2026-10-05T21:30:00Z'))).toBe(true); // Mo 23:30
  });

  it('builds the voicemail TwiML with escaped greeting', () => {
    const x = voicemailTwiml({ greeting: 'Müller & Söhne <GmbH>', record: true, maxLength: 90, action: 'https://x/rec', transcribe: true });
    expect(x).toContain('<Say voice="Polly.Vicki" language="de-DE">Müller &amp; Söhne &lt;GmbH&gt;</Say>');
    expect(x).toMatch(/<Record action="https:\/\/x\/rec" method="POST" maxLength="90"[^>]*transcribe="true" transcribeCallback="https:\/\/x\/rec"\/>/);
    expect(voicemailTwiml({ greeting: 'Hallo', record: false, maxLength: 90, action: 'x' })).not.toContain('<Record');
  });
});

describe('telephony (Twilio Voice)', () => {
  it('stores settings with a sealed, masked auth token', async () => {
    expect((await t.api.get('/api/calls/status')).data.ready).toBe(false);
    expect((await t.api.put('/api/telephony/settings', { account_sid: 'XY123' })).status).toBe(400);
    expect((await t.api.put('/api/telephony/settings', { numbers: '+4930123456', forward_to: '+4930123456' })).data.error).toContain('Twilio-Nummer');
    const r = await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: '0151 12345678', hours_mode: 'always' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ready: true, auth_token_set: true, auth_token: '••••••', forward_to: [MOBILE], numbers: [TWILIO_NUMBER] });
    expect(r.data.webhooks.voice).toBe(`http://localhost/hooks/twilio/voice/${loc}`);
    expect(JSON.stringify((await t.api.get('/api/telephony/settings')).data)).not.toContain(TOKEN);
    expect(t.app.db.get('SELECT auth_token FROM telephony_settings WHERE location_id = ?', loc)!.auth_token).toMatch(/^v1:/);
    // Saving the masked value keeps the token.
    await t.api.put('/api/telephony/settings', { auth_token: '••••••', ring_timeout: 25 });
    expect((await t.api.get('/api/calls/status')).data.ready).toBe(true);
  });

  it('refuses unsigned or wrongly signed webhooks', async () => {
    expect((await hook('voice', { CallSid: callSid(10), From: '+4917011111', To: TWILIO_NUMBER }, { sign: false })).status).toBe(403);
    expect((await hook('voice', { CallSid: callSid(10), From: '+4917011111', To: TWILIO_NUMBER }, { token: 'e'.repeat(32) })).status).toBe(403);
    expect(t.app.db.get('SELECT COUNT(*) n FROM calls')!.n).toBe(0);
  });

  it('forwards inbound calls to the mobile during business hours', async () => {
    const r = await hook('voice', { CallSid: callSid(11), From: '+4917011111', To: TWILIO_NUMBER, CallStatus: 'ringing', Direction: 'inbound' });
    expect(r.status).toBe(200);
    expect(r.text).toContain(`<Dial timeout="25" action="http://localhost/hooks/twilio/voice-dial/${loc}" method="POST" answerOnBridge="true"><Number>${MOBILE}</Number></Dial>`);
    const call = callBySid(callSid(11));
    expect(call).toMatchObject({ direction: 'in', status: 'ringing', from_number: '+4917011111' });
    const contact = t.app.db.get('SELECT * FROM contacts WHERE id = ?', call.contact_id)!;
    expect(contact).toMatchObject({ phone: '+4917011111', source: 'Anruf' });
    const msg = t.app.db.get('SELECT * FROM messages WHERE id = ?', call.message_id)!;
    expect(msg).toMatchObject({ channel: 'call', direction: 'in', status: 'ringing' });

    // Answered on the mobile: the call ends as completed with the talk time.
    expect((await hook('voice-dial', { CallSid: callSid(11), DialCallStatus: 'completed', DialCallDuration: '73' })).text).toContain('<Hangup/>');
    expect(callBySid(callSid(11))).toMatchObject({ status: 'completed', answered: 1, duration: 73 });
    await t.app.events.flush();
    expect(events.filter((e) => e.type === 'call.completed' && e.data.callId === call.id)).toHaveLength(1);
    expect(events.some((e) => e.type === 'call.missed' && e.data.callId === call.id)).toBe(false);
  });

  it('plays the greeting and records a voicemail outside business hours', async () => {
    await t.api.put('/api/telephony/settings', { hours_mode: 'never', greeting: 'Hier ist {{location.name}}. Bitte sprechen Sie nach dem Ton.', transcribe: true });
    const r = await hook('voice', { CallSid: callSid(12), From: '+4917022222', To: TWILIO_NUMBER });
    expect(r.text).not.toContain('<Dial');
    expect(r.text).toContain('<Say voice="Polly.Vicki" language="de-DE">Hier ist Testfirma. Bitte sprechen Sie nach dem Ton.</Say>');
    expect(r.text).toContain(`<Record action="http://localhost/hooks/twilio/voice-recording/${loc}"`);
    expect(r.text).toContain('maxLength="120"');
    expect(callBySid(callSid(12)).reason).toBe('closed');

    const before = events.length;
    await hook('voice-recording', { CallSid: callSid(12), RecordingSid: recSid(12), RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${recSid(12)}`, RecordingDuration: '42' });
    // Twilio's later callbacks must not double anything.
    await hook('voice-recording', { CallSid: callSid(12), RecordingSid: recSid(12), RecordingStatus: 'completed', RecordingDuration: '42' });
    await hook('voice-status', { CallSid: callSid(12), CallStatus: 'completed', CallDuration: '61' });
    await hook('voice-recording', { CallSid: callSid(12), RecordingSid: recSid(12), TranscriptionStatus: 'completed', TranscriptionText: 'Bitte um Rückruf wegen Angebot' });
    await t.app.events.flush();
    const call = callBySid(callSid(12));
    expect(call).toMatchObject({ status: 'voicemail', recording_sid: recSid(12), recording_duration: 42, transcription: 'Bitte um Rückruf wegen Angebot', answered: 0 });
    const fresh = events.slice(before);
    expect(fresh.filter((e) => e.type === 'call.voicemail')).toHaveLength(1);
    expect(fresh.filter((e) => e.type === 'call.missed')).toHaveLength(1);
    expect(fresh.find((e) => e.type === 'call.voicemail')!.data.contactId).toBe(call.contact_id);
    const msg = t.app.db.get('SELECT * FROM messages WHERE id = ?', call.message_id)!;
    expect(msg).toMatchObject({ channel: 'call', status: 'voicemail', subject: 'Voicemail (0:42)', body: 'Bitte um Rückruf wegen Angebot' });
    expect(t.app.db.get('SELECT unread FROM conversations WHERE contact_id = ?', call.contact_id)!.unread).toBe(1);
    // The timeline of the contact shows it.
    const c = (await t.api.get(`/api/contacts/${call.contact_id}`)).data;
    expect(c.activities.map((a: any) => a.type)).toEqual(expect.arrayContaining(['call.missed', 'call.voicemail']));
  });

  it('proxies the recording through the server with the location auth', async () => {
    const call = callBySid(callSid(12));
    requests.length = 0;
    const r = await t.api.raw(`/api/calls/${call.id}/recording?locationId=${loc}`, { headers: { cookie: t.api.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe('ID3-fake-mp3');
    expect(requests[0].url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${recSid(12)}.mp3`);
    expect((await t.api.raw(`/api/calls/${call.id}/recording?locationId=${loc}`)).status).toBe(401);
    const list = (await t.api.get('/api/calls?status=missed,voicemail')).data;
    expect(list.calls).toHaveLength(1);
    expect(list.calls[0]).toMatchObject({ id: call.id, has_recording: true, recording: `/api/calls/${call.id}/recording`, missed: true });
    expect(JSON.stringify(list)).not.toContain('api.twilio.com');
    expect(list.stats).toMatchObject({ total: 2, voicemail: 1, answered: 1, talk_seconds: 73 });
  });

  it('marks unanswered calls as missed and starts the missed-call text-back workflow', async () => {
    const wf = (await t.api.post('/api/workflows', { recipe: 'missed_call' })).data;
    expect(wf.trigger.type).toBe('call.missed');
    expect(wf.settings.allow_reentry).toBe(true);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.api.put('/api/telephony/settings', { hours_mode: 'always' });

    await hook('voice', { CallSid: callSid(13), From: '+4917033333', To: TWILIO_NUMBER });
    // Nobody picks up the mobile → voicemail prompt; the caller hangs up without a message.
    expect((await hook('voice-dial', { CallSid: callSid(13), DialCallStatus: 'no-answer' })).text).toContain('<Record');
    const before = events.length;
    await hook('voice-status', { CallSid: callSid(13), CallStatus: 'completed', CallDuration: '30' });
    await hook('voice-status', { CallSid: callSid(13), CallStatus: 'completed', CallDuration: '30' });
    await t.app.events.flush();
    const call = callBySid(callSid(13));
    expect(call).toMatchObject({ status: 'missed', answered: 0, duration: 0, reason: 'no_answer' });
    const missed = events.slice(before).filter((e) => e.type === 'call.missed');
    expect(missed).toHaveLength(1);
    expect(missed[0].data).toMatchObject({ contactId: call.contact_id, direction: 'in', status: 'missed', from: '+4917033333' });
    const sms = t.app.db.get(`SELECT * FROM messages WHERE contact_id = ? AND channel = 'sms'`, call.contact_id);
    expect(sms?.body).toContain('Anruf gerade verpasst');
    expect(t.app.db.get('SELECT title FROM tasks WHERE contact_id = ?', call.contact_id)?.title).toBe('Rückruf: +4917033333 (+4917033333)');
    expect((await t.api.get('/api/workflows/meta')).data.triggers).toEqual(expect.arrayContaining(['call.missed', 'call.voicemail', 'call.completed']));
  });

  it('click-to-call rings your phone first and bridges to the contact', async () => {
    const contact = (await t.api.post('/api/contacts', { first_name: 'Erika', last_name: 'Muster', phone: '0170 4444444' })).data;
    const nophone = (await t.api.post('/api/contacts', { first_name: 'Ohne', email: 'ohne@example.com' })).data;
    expect((await t.api.post('/api/calls', { contact_id: nophone.id })).status).toBe(400);

    requests.length = 0;
    const r = await t.api.post('/api/calls', { contact_id: contact.id, record: true });
    expect(r.status).toBe(200);
    expect(requests).toHaveLength(1);
    const req = requests[0];
    expect(req.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    expect(req.method).toBe('POST');
    expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(req.body.get('To')).toBe(MOBILE);
    expect(req.body.get('From')).toBe(TWILIO_NUMBER);
    expect(req.body.get('StatusCallback')).toBe(`http://localhost/hooks/twilio/voice-status/${loc}`);
    expect(req.body.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
    const tw = req.body.get('Twiml')!;
    expect(tw).toContain('<Say voice="Polly.Vicki" language="de-DE">Verbinde mit Erika Muster.</Say>');
    expect(tw).toContain(`<Dial callerId="${TWILIO_NUMBER}" timeout="30" action="http://localhost/hooks/twilio/voice-dial/${loc}" method="POST" record="record-from-answer-dual"`);
    // A recorded call: the person called hears the recording notice before the bridge (Twilio fetches it from this URL).
    expect(tw).toContain(`<Number url="http://localhost/hooks/twilio/voice-announce/${loc}" method="POST">+491704444444</Number></Dial>`);
    expect(r.data).toMatchObject({ direction: 'out', status: 'initiated', to_number: '+491704444444', from_number: TWILIO_NUMBER, contact_name: 'Erika Muster', sid: callSid(callCounter) });

    // Your phone answers, the contact talks for 95 s, then hangs up.
    const sid = r.data.sid;
    await hook('voice-status', { CallSid: sid, CallStatus: 'in-progress' });
    expect(callBySid(sid).status).toBe('in-progress');
    await hook('voice-dial', { CallSid: sid, DialCallStatus: 'completed', DialCallDuration: '95' });
    await hook('voice-status', { CallSid: sid, CallStatus: 'completed', CallDuration: '110' });
    await t.app.events.flush();
    expect(callBySid(sid)).toMatchObject({ status: 'completed', answered: 1, duration: 95 });
    const done = events.filter((e) => e.type === 'call.completed' && e.data.callId === r.data.id);
    expect(done).toHaveLength(1);
    expect(done[0].data).toMatchObject({ contactId: contact.id, direction: 'out', duration: 95 });
    const msgs = (await t.api.get(`/api/contacts/${contact.id}/messages`)).data;
    expect(msgs.find((m: any) => m.channel === 'call')).toMatchObject({ direction: 'out', status: 'completed', subject: 'Ausgehender Anruf (1:35)' });
  });

  it('records a failed Twilio request as a failed call', async () => {
    const contact = (await t.api.post('/api/contacts', { first_name: 'Fehl', phone: '+4917055555' })).data;
    t.app.services.twilioFetch = (async () => new Response(JSON.stringify({ message: 'The number is unverified' }), { status: 400 })) as unknown as typeof fetch;
    const r = await t.api.post('/api/calls', { contact_id: contact.id });
    t.app.services.twilioFetch = fakeTwilio;
    expect(r.status).toBe(502);
    expect(r.data.error).toContain('unverified');
    expect(t.app.db.get('SELECT status, error FROM calls WHERE contact_id = ?', contact.id)).toMatchObject({ status: 'failed', error: 'Twilio: The number is unverified' });
  });

  it('lists the Twilio numbers and points their webhooks here', async () => {
    const list = (await t.api.get('/api/telephony/numbers')).data;
    expect(list[0]).toMatchObject({ phone_number: '+4930999999', connected: false });
    requests.length = 0;
    const r = await t.api.post(`/api/telephony/numbers/${list[0].sid}/connect`);
    expect(r.data.ok).toBe(true);
    expect(requests[0].body.get('VoiceUrl')).toBe(`http://localhost/hooks/twilio/voice/${loc}`);
    expect(requests[0].body.get('StatusCallback')).toBe(`http://localhost/hooks/twilio/voice-status/${loc}`);
    expect(r.data.settings.numbers).toEqual([TWILIO_NUMBER, '+4930999999']);
  });

  it('keeps a recorded conversation apart from voicemail', async () => {
    await t.api.put('/api/telephony/settings', { record_inbound: true });
    const r = await hook('voice', { CallSid: callSid(15), From: '+4917066666', To: TWILIO_NUMBER });
    expect(r.text).toContain(`record="record-from-answer-dual" recordingStatusCallback="http://localhost/hooks/twilio/voice-recording/${loc}?kind=dial"`);
    // The recording callback arrives before the Dial action – still not a voicemail.
    await hook('voice-recording', { CallSid: callSid(15), RecordingSid: recSid(15), RecordingStatus: 'completed', RecordingDuration: '80' }, { query: '?kind=dial' });
    expect(callBySid(callSid(15))).toMatchObject({ status: 'ringing', recording_sid: recSid(15), ended_at: null });
    await hook('voice-dial', { CallSid: callSid(15), DialCallStatus: 'completed', DialCallDuration: '79' });
    expect(callBySid(callSid(15))).toMatchObject({ status: 'completed', answered: 1, duration: 79 });
    await t.api.put('/api/telephony/settings', { record_inbound: false });
  });

  it('handles withheld numbers without creating a contact', async () => {
    const before = events.length;
    await hook('voice', { CallSid: callSid(14), From: 'anonymous', To: TWILIO_NUMBER });
    await hook('voice-dial', { CallSid: callSid(14), DialCallStatus: 'busy' });
    await hook('voice-status', { CallSid: callSid(14), CallStatus: 'completed' });
    await t.app.events.flush();
    expect(callBySid(callSid(14))).toMatchObject({ status: 'missed', contact_id: null, from_number: '', message_id: null });
    const missed = events.slice(before).filter((e) => e.type === 'call.missed');
    expect(missed).toHaveLength(1);
    expect(missed[0].data.contactId).toBeUndefined();
  });

  it('maps the new routes to the right permission areas', () => {
    expect(requiredPermission('POST', '/api/calls')).toBe('conversations');
    expect(requiredPermission('GET', '/api/calls/x/recording')).toBe('conversations');
    expect(requiredPermission('PUT', '/api/telephony/settings')).toBe('settings');
    expect(requiredPermission('GET', '/api/google-reviews')).toBe('reviews');
    expect(requiredPermission('PUT', '/api/google-reviews/settings')).toBe('settings');
  });

  it('offers the call log as MCP tool ghl_list_calls', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'mcp' })).data.key;
    const rpc = async (body: unknown) =>
      (await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const tools = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(tools.result.tools.map((x: any) => x.name)).toContain('ghl_list_calls');
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_list_calls', arguments: { location_id: loc, status: 'voicemail' } } });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.calls).toHaveLength(1);
    expect(res.result.structuredContent.calls[0]).toMatchObject({ status: 'voicemail', transcription: 'Bitte um Rückruf wegen Angebot', has_recording: true });
  });
});
