import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import { twilioSignature } from '../server/services/twilio.js';
import type { AppEvent } from '../server/core/events.js';
import { requiredPermission } from '../server/core/permissions.js';

/**
 * Telephone menu (IVR), ring groups and queues, number registry and purchase – through the signed Twilio webhooks and the API,
 * with a fake Twilio (no real call, no real number).
 */

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const SECOND = '+4915199999999';
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const recSid = (n: number) => `RE${String(n).padStart(32, '0')}`;
const pn = (c: string) => `PN${c.repeat(32)}`;

const requests: { url: string; method: string; body: URLSearchParams }[] = [];
let released = false;
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  requests.push({ url, method: init.method ?? 'GET', body: new URLSearchParams(init.body ?? '') });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  const body = new URLSearchParams(init.body ?? '');
  const path = url.replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, '').replace(/\?.*$/, '');
  if (url.startsWith('https://pricing.twilio.com/v1/PhoneNumbers/Countries/DE')) return json({ price_unit: 'USD', phone_number_prices: [{ number_type: 'local', base_price: '1.00', current_price: '1.15' }, { number_type: 'toll free', base_price: '25', current_price: '25' }] });
  if (url.startsWith('https://numbers.twilio.com/v2/RegulatoryCompliance/Bundles')) return json({ results: [{ sid: `BU${'a'.repeat(32)}`, friendly_name: 'Firma GmbH', status: 'twilio-approved', iso_country: 'DE', number_type: 'local' }, { sid: `BU${'b'.repeat(32)}`, friendly_name: 'Entwurf', status: 'draft', iso_country: 'DE', number_type: 'local' }] });
  if (path === '/Addresses.json') return json({ addresses: [{ sid: `AD${'c'.repeat(32)}`, friendly_name: 'Büro Berlin', customer_name: 'Firma GmbH', street: 'Musterstr. 1', city: 'Berlin', postal_code: '10115', iso_country: 'DE', validated: true, verified: true }] });
  if (path === '/AvailablePhoneNumbers/DE/Local.json')
    return json({ available_phone_numbers: [{ phone_number: '+4930555001', friendly_name: '030 555001', locality: 'Berlin', region: 'BE', postal_code: '', iso_country: 'DE', address_requirements: 'local', beta: false, capabilities: { voice: true, SMS: false, MMS: false } }, { phone_number: 'kaputt', friendly_name: 'x' }] });
  if (path === '/AvailablePhoneNumbers/XX/Local.json') return json({ code: 20404, message: 'The requested resource was not found' }, 404);
  if (path === '/IncomingPhoneNumbers.json' && init.method === 'POST') {
    const wanted = body.get('PhoneNumber')!;
    if (wanted.startsWith('+49') && !body.get('AddressSid')) return json({ code: 21631, message: 'Phone number requires an Address but the provided Address was not found or is not valid' }, 400);
    return json({ sid: pn(wanted.endsWith('1') ? 'd' : wanted.endsWith('2') ? 'e' : wanted.endsWith('3') ? 'f' : '1'), phone_number: wanted }, 201);
  }
  if (path.startsWith('/IncomingPhoneNumbers/PN') && init.method === 'DELETE') {
    released = true;
    return new Response(null, { status: 204 });
  }
  if (path.startsWith('/Calls/CA')) return json({ sid: path.slice(7, 41), to: MOBILE });
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let adminId = '';
const events: AppEvent[] = [];

/** Posts a form like Twilio does to a full URL (as found in the TwiML), signed with the auth token. */
async function post(url: string, params: Record<string, string>, opts: { sign?: boolean } = {}) {
  const u = new URL(url.replace(/&amp;/g, '&'));
  const path = u.pathname + u.search;
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.sign === false ? {} : { 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) }) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}
const hook = (name: string, params: Record<string, string>, query = '') => post(`http://localhost/hooks/twilio/${name}/${loc}${query}`, params);
const urlOf = (xml: string, attr = 'action') => new RegExp(`${attr}="([^"]+)"`).exec(xml)![1].replace(/&amp;/g, '&');
const callOf = (sid: string) => t.app.db.get('SELECT * FROM calls WHERE sid = ?', sid)!;

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  adminId = me.user.id;
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.events.on('*', (e) => void events.push(e));
  const r = await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
  expect(r.status).toBe(200);
});
afterAll(async () => {
  unpinClock();
  await t.close();
});

describe('number registry and purchase', () => {
  it('lists the configured numbers as registry rows and gives each a label and a route', async () => {
    const reg = (await t.api.get('/api/telephony/registry')).data;
    expect(reg.numbers).toHaveLength(1);
    expect(reg.numbers[0]).toMatchObject({ number: TWILIO_NUMBER, kind: 'main', route_kind: 'default', managed: false });
    const r = await t.api.patch(`/api/telephony/registry/${reg.numbers[0].id}`, { label: 'Hauptnummer' });
    expect(r.data.label).toBe('Hauptnummer');
    expect((await t.api.patch(`/api/telephony/registry/${reg.numbers[0].id}`, { route_kind: 'ivr', route_id: 'nope' })).status).toBe(400);
    expect((await t.api.patch(`/api/telephony/registry/${reg.numbers[0].id}`, { route_kind: 'forward', route_id: TWILIO_NUMBER })).data.error).toContain('eigene Nummer');
    expect((await t.api.patch(`/api/telephony/registry/${reg.numbers[0].id}`, { route_kind: 'zzz' })).status).toBe(400);
  });

  it('searches Twilio by country, type and area code (and explains the German rules)', async () => {
    requests.length = 0;
    const r = (await t.api.get('/api/telephony/numbers/search?country=DE&type=local&area_code=30&contains=555')).data;
    expect(r.numbers).toHaveLength(1);
    expect(r.numbers[0]).toMatchObject({ phone_number: '+4930555001', locality: 'Berlin', address_requirements: 'local', capabilities: { voice: true } });
    expect(r.rule.text).toContain('Regulatory Bundle');
    const q = new URL(requests[0].url).searchParams;
    expect(q.get('AreaCode')).toBe('30');
    expect(q.get('Contains')).toBe('555');
    expect(q.get('VoiceEnabled')).toBe('true');
    expect((await t.api.get('/api/telephony/numbers/search?country=XX')).data.error).toContain('keine Ortsnummern');
    expect((await t.api.get('/api/telephony/numbers/search?country=Deutschland')).status).toBe(400);
    expect((await t.api.get('/api/telephony/numbers/search?type=satellit')).status).toBe(400);
    expect((await t.api.get('/api/telephony/numbers/pricing?country=DE')).data.pricing).toEqual({ currency: 'USD', prices: { local: '1.15', toll_free: '25' } });
  });

  it('shows the addresses and bundles of the account – only an approved bundle counts', async () => {
    const r = (await t.api.get('/api/telephony/regulatory?country=DE&type=local')).data;
    expect(r.addresses).toHaveLength(1);
    expect(r.bundles.map((b: any) => [b.name, b.approved])).toEqual([['Firma GmbH', true], ['Entwurf', false]]);
    expect(r.ready).toBe(true);
    expect(r.console.bundles).toContain('twilio.com');
    expect(r.rule.address).toBe(true);
  });

  it('needs an explicit confirmation and explains a missing address instead of a bare Twilio error', async () => {
    expect((await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555001' })).data.error).toContain('bestätigen');
    expect((await t.api.post('/api/telephony/numbers/buy', { phone_number: '030555', confirm: true })).status).toBe(400);
    expect((await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555001', confirm: true, address_sid: 'ADxyz' })).data.error).toContain('Adress-SID');
    const r = await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555001', confirm: true });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('Regulatory Bundle');
    expect(r.data.error).toContain('Handelsregister');
    expect(r.data.regulatory).toBe(true);
    expect(t.app.db.get('SELECT COUNT(*) n FROM phone_numbers WHERE number = ?', '+4930555001')!.n).toBe(0);
  });

  it('buys a number with address and bundle, points its webhooks here and lists it', async () => {
    requests.length = 0;
    const r = await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555001', confirm: true, address_sid: `AD${'c'.repeat(32)}`, bundle_sid: `BU${'a'.repeat(32)}`, label: 'Vertrieb Berlin', type: 'local', country: 'DE' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ number: '+4930555001', label: 'Vertrieb Berlin', kind: 'main', managed: true, status: 'active', route_kind: 'default' });
    const req = requests.find((x) => x.url.endsWith('/IncomingPhoneNumbers.json'))!;
    expect(req.method).toBe('POST');
    expect(req.body.get('PhoneNumber')).toBe('+4930555001');
    expect(req.body.get('AddressSid')).toBe(`AD${'c'.repeat(32)}`);
    expect(req.body.get('BundleSid')).toBe(`BU${'a'.repeat(32)}`);
    expect(req.body.get('VoiceUrl')).toBe(`http://localhost/hooks/twilio/voice/${loc}`);
    expect(req.body.get('StatusCallback')).toBe(`http://localhost/hooks/twilio/voice-status/${loc}`);
    // A main number joins the sub-account's own numbers (caller ID, "own number" check).
    expect((await t.api.get('/api/telephony/settings')).data.numbers).toEqual([TWILIO_NUMBER, '+4930555001']);
    expect((await t.api.post('/api/telephony/numbers/buy', { phone_number: '+4930555001', confirm: true, address_sid: `AD${'c'.repeat(32)}` })).status).toBe(409);
    expect(events.some((e) => e.type === 'phone_number.bought' && e.data.number === '+4930555001')).toBe(true);
  });

  it('releases a number only on confirmation and takes it out of the settings', async () => {
    const row = t.app.db.get('SELECT * FROM phone_numbers WHERE number = ?', '+4930555001')!;
    expect((await t.api.post(`/api/telephony/numbers/${row.id}/release`, {})).data.error).toContain('bestätigen');
    expect(released).toBe(false);
    const r = await t.api.post(`/api/telephony/numbers/${row.id}/release`, { confirm: true });
    expect(r.data.ok).toBe(true);
    expect(released).toBe(true);
    expect(requests.at(-1)!.url).toContain(`/IncomingPhoneNumbers/${row.sid}.json`);
    expect(requests.at(-1)!.method).toBe('DELETE');
    expect(t.app.db.get('SELECT status FROM phone_numbers WHERE id = ?', row.id)!.status).toBe('released');
    expect((await t.api.get('/api/telephony/settings')).data.numbers).toEqual([TWILIO_NUMBER]);
    expect((await t.api.post(`/api/telephony/numbers/${row.id}/release`, { confirm: true })).status).toBe(404);
    // A number that was never bought here cannot be released from here.
    const main = t.app.db.get('SELECT id FROM phone_numbers WHERE number = ?', TWILIO_NUMBER)!;
    expect((await t.api.post(`/api/telephony/numbers/${main.id}/release`, { confirm: true })).data.error).toContain('Twilio-Konsole');
  });

  it('keeps the new routes behind the settings area', () => {
    for (const p of ['/api/telephony/registry', '/api/telephony/numbers/buy', '/api/telephony/ivr', '/api/telephony/groups', '/api/telephony/schedules', '/api/telephony/audio', '/api/telephony/dni/pools', '/api/telephony/tracking/report']) expect(requiredPermission('GET', p)).toBe('settings');
  });
});

describe('telephone menu on a phone number', () => {
  let flowId = '';
  let groupId = '';
  let scheduleId = '';
  let numberId = '';
  const flowBody = () => ({
    name: 'Hauptmenü',
    flow: {
      start: 'zeit',
      nodes: [
        { id: 'zeit', type: 'schedule', label: 'Öffnungszeiten', schedule_id: scheduleId, open: 'menu', closed: 'vm', holiday: 'feier' },
        { id: 'menu', type: 'menu', label: 'Hauptmenü', say: 'Willkommen bei Testfirma. Für den Vertrieb drücken Sie die 1, für den Support die 2.', options: { '1': 'sales', '2': 'support' }, option_labels: { '1': 'Vertrieb', '2': 'Support' }, on_timeout: 'vm', retries: 1, timeout: 5 },
        { id: 'sales', type: 'forward', label: 'Vertrieb', say: 'Wir verbinden Sie.', numbers: [MOBILE], users: [adminId], timeout: 15, on_fail: 'vm' },
        { id: 'support', type: 'group', label: 'Support-Queue', group_id: groupId },
        { id: 'vm', type: 'voicemail', label: 'Voicemail Vertrieb', box: 'Vertrieb', say: 'Wir sind gerade nicht da. Bitte sprechen Sie nach dem Ton.', assign_user: adminId },
        { id: 'feier', type: 'say', label: 'Feiertag', say: 'Heute ist Feiertag.', next: 'vm' },
      ],
    },
  });

  it('creates the schedule, the group and the menu and assigns it to the number', async () => {
    scheduleId = (await t.api.post('/api/telephony/schedules', { name: 'Büro', hours: { mon: [{ from: '09:00', to: '17:00' }], tue: [{ from: '09:00', to: '17:00' }], wed: [{ from: '09:00', to: '17:00' }], thu: [{ from: '09:00', to: '17:00' }], fri: [{ from: '09:00', to: '17:00' }], sat: [], sun: [] }, german_holidays: { enabled: true, state: 'BE' } })).data.id;
    const g = await t.api.post('/api/telephony/groups', { name: 'Support', kind: 'queue', strategy: 'round_robin', members: [{ type: 'number', id: MOBILE, name: 'Anna' }, { type: 'number', id: SECOND, name: 'Ben' }], ring_timeout: 12, max_wait: 60, overflow: { kind: 'voicemail', box: 'Support', say: 'Alle Leitungen sind belegt.' } });
    expect(g.status).toBe(200);
    groupId = g.data.id;
    const f = await t.api.post('/api/telephony/ivr', flowBody());
    expect(f.status).toBe(200);
    expect(f.data.issues).toEqual([]);
    flowId = f.data.id;
    numberId = (await t.api.get('/api/telephony/registry')).data.numbers.find((n: any) => n.number === TWILIO_NUMBER).id;
    const p = await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'ivr', route_id: flowId });
    expect(p.data).toMatchObject({ route_kind: 'ivr', route_label: 'Hauptmenü' });
    // What is still in use cannot be removed.
    expect((await t.api.del(`/api/telephony/ivr/${flowId}`)).data.error).toContain('zugeordnet');
    expect((await t.api.del(`/api/telephony/groups/${groupId}`)).data.error).toContain('Telefonmenü');
    expect((await t.api.del(`/api/telephony/schedules/${scheduleId}`)).data.error).toContain('benutzt');
  });

  it('refuses a broken flow with a clear message', async () => {
    const b = flowBody();
    (b.flow.nodes[1] as any).options['5'] = 'weg';
    const r = await t.api.put(`/api/telephony/ivr/${flowId}`, b);
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('„Hauptmenü“, Taste 5: Das Ziel „weg“ gibt es nicht');
    expect((await t.api.post('/api/telephony/ivr', { name: 'x', flow: { start: 'a', nodes: [{ id: 'a', type: 'forward', numbers: [], users: [] }] } })).data.error).toContain('mindestens eine Nummer');
  });

  it('plays the menu in business hours, runs the dry run and reports the path', async () => {
    pinClock('2026-10-05T08:00:00Z'); // Monday 10:00 in Berlin
    const r = await hook('voice', { CallSid: callSid(21), From: '+4917011111', To: TWILIO_NUMBER });
    expect(r.status).toBe(200);
    expect(r.text).toContain('<Gather input="dtmf" numDigits="1" timeout="5"');
    expect(r.text).toContain('Willkommen bei Testfirma');
    expect(r.text).not.toContain('<Dial');
    expect(callOf(callSid(21))).toMatchObject({ route_kind: 'ivr', route_id: flowId, route_node: 'menu' });
    expect(callOf(callSid(21)).route_path).toBe('Öffnungszeiten: geöffnet › Hauptmenü');
    const sim = (await t.api.post(`/api/telephony/ivr/${flowId}/simulate`, { keys: ['1'], at: '2026-10-05T08:00:00Z' })).data;
    expect(sim.end).toBe('forward');
    expect((await t.api.post(`/api/telephony/ivr/${flowId}/simulate`, { keys: [], at: '2026-10-05T20:00:00Z' })).data.end).toBe('voicemail');
  });

  it('forwards on a key press, to the number and the browser, and lets nobody-answered fall to the voicemail of the branch', async () => {
    const menu = await hook('voice', { CallSid: callSid(22), From: '+4917022222', To: TWILIO_NUMBER });
    const press = await post(urlOf(menu.text), { CallSid: callSid(22), Digits: '1' });
    expect(press.text).toContain('Wir verbinden Sie.');
    expect(press.text).toMatch(/<Dial timeout="15" action="http:\/\/localhost\/hooks\/twilio\/ivr-dial\/[^"]+" method="POST" answerOnBridge="true"><Number>\+4915112345678<\/Number><\/Dial>/);
    expect(callOf(callSid(22)).route_path).toContain('1 Vertrieb');
    // Nobody picks up → the "voicemail Vertrieb" step with its own greeting and box.
    const none = await post(urlOf(press.text), { CallSid: callSid(22), DialCallStatus: 'no-answer' });
    expect(none.text).toContain('Wir sind gerade nicht da. Bitte sprechen Sie nach dem Ton.');
    expect(none.text).toMatch(/<Record action="http:\/\/localhost\/hooks\/twilio\/voice-recording\/[^"?]+\?box=Vertrieb"/);
    const before = events.length;
    await post(urlOf(none.text), { CallSid: callSid(22), RecordingSid: recSid(22), RecordingStatus: 'completed', RecordingDuration: '12' });
    await t.app.events.flush();
    expect(callOf(callSid(22))).toMatchObject({ status: 'voicemail', voicemail_box: 'Vertrieb' });
    expect(events.slice(before).some((e) => e.type === 'call.voicemail')).toBe(true);
    // The message of a branch with an owner becomes a callback task for that person.
    const task = t.app.db.get('SELECT * FROM tasks WHERE contact_id = ? AND title LIKE ?', callOf(callSid(22)).contact_id, 'Rückruf (Voicemail Vertrieb)%')!;
    expect(task.assigned_to).toBe(adminId);
    expect(task.description).toContain('Weg: Öffnungszeiten');
  });

  it('answers wrong keys and silence by repeating, then by the fallback; and ends an answered call as completed', async () => {
    const menu = await hook('voice', { CallSid: callSid(23), From: '+4917033333', To: TWILIO_NUMBER });
    const wrong = await post(urlOf(menu.text), { CallSid: callSid(23), Digits: '9' });
    expect(wrong.text).toContain('Diese Eingabe kenne ich nicht.');
    expect(wrong.text).toContain('<Gather');
    const silent = await post(`${urlOf(wrong.text)}&t=1`, { CallSid: callSid(23) });
    // retries = 1: the second round without a key leads to the timeout target (the voicemail).
    expect(silent.text).toContain('<Record');
    // Another caller gets through.
    const m2 = await hook('voice', { CallSid: callSid(24), From: '+4917044444', To: TWILIO_NUMBER });
    const fwd = await post(urlOf(m2.text), { CallSid: callSid(24), Digits: '1' });
    expect((await post(urlOf(fwd.text), { CallSid: callSid(24), DialCallStatus: 'completed', DialCallDuration: '65' })).text).toContain('<Hangup/>');
    expect(callOf(callSid(24))).toMatchObject({ status: 'completed', answered: 1, duration: 65 });
  });

  it('sends callers outside the hours or on a holiday to the voicemail', async () => {
    pinClock('2026-10-05T18:30:00Z'); // Monday 20:30
    const late = await hook('voice', { CallSid: callSid(25), From: '+4917055555', To: TWILIO_NUMBER });
    expect(late.text).toContain('Wir sind gerade nicht da.');
    expect(late.text).toContain('<Record');
    expect(callOf(callSid(25)).route_path).toContain('außerhalb der Öffnungszeiten');
    pinClock('2026-12-25T09:00:00Z'); // 1. Weihnachtstag, a Friday
    const holiday = await hook('voice', { CallSid: callSid(26), From: '+4917066666', To: TWILIO_NUMBER });
    expect(holiday.text).toContain('Heute ist Feiertag.');
    expect(holiday.text.indexOf('Heute ist Feiertag.')).toBeLessThan(holiday.text.indexOf('<Record'));
    expect(callOf(callSid(26)).route_path).toContain('Feiertag: 1. Weihnachtstag');
    pinClock('2026-10-05T08:00:00Z');
  });

  it('refuses unsigned menu webhooks and ignores steps that do not exist', async () => {
    expect((await post(`http://localhost/hooks/twilio/ivr/${loc}?f=${flowId}&n=menu`, { CallSid: callSid(21), Digits: '1' }, { sign: false })).status).toBe(403);
    const r = await hook('ivr', { CallSid: callSid(21), Digits: '1' }, `?f=${flowId}&n=gibtsnicht&d=0`);
    // Back to the normal flow (ring the forwarding number) – never an error page for the caller.
    expect(r.status).toBe(200);
    const other = await hook('ivr', { CallSid: callSid(21), Digits: '1' }, '?f=fremd&n=menu');
    expect(other.status).toBe(200);
  });
});

describe('ring groups and queues', () => {
  let groupId = '';
  const group = () => t.app.db.get('SELECT * FROM call_groups WHERE id = ?', groupId)!;
  const q = (sid: string) => t.app.db.get('SELECT * FROM queue_calls WHERE call_id = ?', callOf(sid).id)!;

  it('rings the members round robin, one after the other', async () => {
    groupId = t.app.db.get('SELECT id FROM call_groups WHERE name = ?', 'Support')!.id;
    const numberId = t.app.db.get('SELECT id FROM phone_numbers WHERE number = ?', TWILIO_NUMBER)!.id;
    await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'group', route_id: groupId });
    const first = await hook('voice', { CallSid: callSid(31), From: '+4917031111', To: TWILIO_NUMBER });
    expect(first.text).toContain(`<Dial timeout="12" action="http://localhost/hooks/twilio/group-dial/${loc}?q=`);
    expect(first.text).toContain('<Number>+4915112345678</Number>');
    expect(first.text).not.toContain(SECOND);
    expect(callOf(callSid(31))).toMatchObject({ route_kind: 'group', route_id: groupId });
    // Nobody at the first number → the next member rings at once (no hold in between).
    const second = await post(urlOf(first.text), { CallSid: callSid(31), DialCallStatus: 'no-answer' });
    expect(second.text).toContain(`<Number>${SECOND}</Number>`);
    expect(second.text).not.toContain('<Play>');
  });

  it('holds the caller with music and the position, then tries again; the round robin pointer moves on at an answer', async () => {
    const second = t.app.db.get('SELECT * FROM queue_calls WHERE call_id = ?', callOf(callSid(31)).id)!;
    const dialUrl = `http://localhost/hooks/twilio/group-dial/${loc}?q=${second.id}`;
    // The second member does not answer either: the round is over, a queue holds the caller.
    const r = await post(dialUrl, { CallSid: callSid(31), DialCallStatus: 'busy' });
    expect(r.text).toContain('Sie sind der nächste Anrufer');
    expect(r.text).toContain(`<Play>http://localhost/hooks/twilio/audio/default-hold.wav</Play>`);
    expect(r.text).toContain(`<Redirect method="POST">http://localhost/hooks/twilio/group-wait/${loc}?q=${second.id}</Redirect>`);
    expect(q(callSid(31)).status).toBe('waiting');
    // The built-in hold melody is a real WAV file.
    const wav = await t.api.raw('/hooks/twilio/audio/default-hold.wav');
    const bytes = Buffer.from(await wav.arrayBuffer());
    expect(wav.headers.get('content-type')).toBe('audio/wav');
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.length).toBeGreaterThan(100_000);
    // After the hold segment a new round starts with the same member (nobody took a call yet).
    const again = await hook('group-wait', { CallSid: callSid(31) }, `?q=${second.id}`);
    expect(again.text).toContain('<Number>+4915112345678</Number>');
    // The second caller waits behind the first one: first come, first served.
    await hook('voice', { CallSid: callSid(32), From: '+4917032222', To: TWILIO_NUMBER });
    const behind = q(callSid(32));
    const waiting = await hook('group-wait', { CallSid: callSid(32) }, `?q=${behind.id}`);
    expect(waiting.text).toContain('Sie sind der 2. Anrufer');
    expect(waiting.text).not.toContain('<Dial');
    // The first caller is answered by Ben → pointer after Ben, wait time and outcome are kept.
    await post(`http://localhost/hooks/twilio/group-dial/${loc}?q=${second.id}`, { CallSid: callSid(31), DialCallStatus: 'busy' });
    await post(`http://localhost/hooks/twilio/group-wait/${loc}?q=${second.id}`, { CallSid: callSid(31) });
    const done = await post(`http://localhost/hooks/twilio/group-dial/${loc}?q=${second.id}`, { CallSid: callSid(31), DialCallStatus: 'completed', DialCallDuration: '48' });
    expect(done.text).toContain('<Hangup/>');
    expect(q(callSid(31))).toMatchObject({ status: 'done', outcome: 'answered', answered_by: `number:${MOBILE}` });
    expect(callOf(callSid(31))).toMatchObject({ status: 'completed', answered: 1, duration: 48 });
    expect(JSON.parse(group().data).rr_next).toBe(1);
    // …so the next call starts with Ben.
    const next = await hook('group-wait', { CallSid: callSid(32) }, `?q=${behind.id}`);
    expect(next.text).toContain(`<Number>${SECOND}</Number>`);
  });

  it('gives up after the maximum wait: the overflow plays its own greeting into the box of the group', async () => {
    await hook('voice', { CallSid: callSid(33), From: '+4917033333', To: TWILIO_NUMBER });
    const row = q(callSid(33));
    t.app.db.run('UPDATE queue_calls SET enqueued_at = ?, status = ? WHERE id = ?', new Date(Date.now() - 61_000).toISOString(), 'waiting', row.id);
    const r = await hook('group-wait', { CallSid: callSid(33) }, `?q=${row.id}`);
    expect(r.text).toContain('Alle Leitungen sind belegt.');
    expect(r.text).toMatch(/<Record action="[^"]+\?box=Support"/);
    expect(q(callSid(33))).toMatchObject({ status: 'done', outcome: 'voicemail' });
    expect(callOf(callSid(33)).wait_seconds).toBeGreaterThanOrEqual(61);
  });

  it('counts a caller who hangs up while waiting as abandoned and reports the numbers', async () => {
    await hook('voice', { CallSid: callSid(34), From: '+4917034444', To: TWILIO_NUMBER });
    await hook('voice-status', { CallSid: callSid(34), CallStatus: 'completed', CallDuration: '9' });
    await t.app.events.flush();
    expect(q(callSid(34))).toMatchObject({ status: 'done', outcome: 'abandoned' });
    const s = (await t.api.get(`/api/telephony/groups/${groupId}/stats?days=7`)).data;
    expect(s).toMatchObject({ answered: 1, abandoned: 1 });
    expect(s.offered).toBeGreaterThanOrEqual(3);
    expect(s.by_member).toEqual([{ key: `number:${MOBILE}`, name: 'Anna', answered: 1 }]);
    const list = (await t.api.get('/api/telephony/groups')).data;
    expect(list[0]).toMatchObject({ name: 'Support', waiting: 1 });
  });

  it('a plain ring group has no waiting: after its round the overflow takes over', async () => {
    const g = (await t.api.post('/api/telephony/groups', { name: 'Rezeption', kind: 'group', strategy: 'simultaneous', members: [{ type: 'number', id: MOBILE }, { type: 'number', id: SECOND }], overflow: { kind: 'hangup', say: 'Bitte rufen Sie später an.' } })).data;
    const numberId = t.app.db.get('SELECT id FROM phone_numbers WHERE number = ?', TWILIO_NUMBER)!.id;
    await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'group', route_id: g.id });
    const ring = await hook('voice', { CallSid: callSid(35), From: '+4917035555', To: TWILIO_NUMBER });
    expect(ring.text).toContain(`<Number>${MOBILE}</Number><Number>${SECOND}</Number>`);
    const over = await post(urlOf(ring.text), { CallSid: callSid(35), DialCallStatus: 'no-answer' });
    expect(over.text).toContain('Bitte rufen Sie später an.');
    expect(over.text).toContain('<Hangup/>');
    expect(q(callSid(35)).outcome).toBe('overflow');
  });

  it('keeps the default behaviour for a number without a route', async () => {
    const numberId = t.app.db.get('SELECT id FROM phone_numbers WHERE number = ?', TWILIO_NUMBER)!.id;
    await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'default' });
    const r = await hook('voice', { CallSid: callSid(36), From: '+4917036666', To: TWILIO_NUMBER });
    expect(r.text).toContain(`<Dial timeout="20" action="http://localhost/hooks/twilio/voice-dial/${loc}" method="POST" answerOnBridge="true"><Number>${MOBILE}</Number></Dial>`);
    expect(callOf(callSid(36)).route_kind).toBe('');
  });

  it('routes a number straight to the voicemail or to a fixed number', async () => {
    const numberId = t.app.db.get('SELECT id FROM phone_numbers WHERE number = ?', TWILIO_NUMBER)!.id;
    await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'voicemail', route_id: 'Service' });
    const vm = await hook('voice', { CallSid: callSid(37), From: '+4917037777', To: TWILIO_NUMBER });
    expect(vm.text).toMatch(/<Record action="[^"]+\?box=Service"/);
    await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'forward', route_id: '0151 99999999' });
    const fw = await hook('voice', { CallSid: callSid(38), From: '+4917038888', To: TWILIO_NUMBER });
    expect(fw.text).toContain(`<Number>${SECOND}</Number>`);
    await t.api.patch(`/api/telephony/registry/${numberId}`, { route_kind: 'default' });
  });
});
