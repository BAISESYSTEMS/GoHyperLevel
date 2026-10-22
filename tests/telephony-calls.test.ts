import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';
import { twilioSignature } from '../server/services/twilio.js';
import { identityFor } from '../server/services/browser-phone.js';
import { requiredPermission } from '../server/core/permissions.js';
import type { AppEvent } from '../server/core/events.js';

/**
 * What happens during and after a call: notes, hand-over (cold and with announcement), the recording notice and the retention
 * period of recordings and voicemails – through the signed Twilio webhooks and the API, with a fake Twilio.
 */

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const TARGET = '+4915199999999';
const KEY_SID = `SK${'a'.repeat(32)}`;
const KEY_SECRET = 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3tAB';
const APP_SID = `AP${'b'.repeat(32)}`;
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const recSid = (n: number) => `RE${String(n).padStart(32, '0')}`;

const requests: { url: string; method: string; body: URLSearchParams; path: string }[] = [];
const fakeTwilio = (async (input: any, init: any = {}) => {
  const url = String(input);
  const path = url.replace(`https://api.twilio.com/2010-04-01/Accounts/${SID}`, '');
  const body = new URLSearchParams(init.body ?? '');
  requests.push({ url, method: init.method ?? 'GET', body, path });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/Keys.json') return json({ sid: KEY_SID, secret: KEY_SECRET }, 201);
  if (path.startsWith('/Calls.json?ParentCallSid=')) return json({ calls: [] });
  if (path === '/Calls.json' && init.method === 'POST') return json({ sid: callSid(900) }, 201);
  if (path === `/Calls/${callSid(99)}.json`) return json({ code: 21220, message: 'Call is not in-progress' }, 400);
  if (/^\/Calls\/CA\d{32}\.json$/.test(path)) return json({ sid: path.slice(7, 41) });
  if (path === `/Recordings/${recSid(3)}.json`) return json({ code: 20500, message: 'Server Error' }, 500);
  if (path === `/Recordings/${recSid(4)}.json`) return json({ code: 20404, message: 'The requested resource was not found' }, 404);
  if (path.startsWith('/Recordings/RE') && init.method === 'DELETE') return new Response(null, { status: 204 });
  return json({ message: 'not found' }, 404);
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let adminId = '';
let beaId = '';
let bea: ReturnType<typeof client>;
let cem: ReturnType<typeof client>;
let cemId = '';
let contactId = '';
const events: AppEvent[] = [];
let seq = 100;

async function hook(name: string, params: Record<string, string>, query = '', sign = true) {
  const path = `/hooks/twilio/${name}/${loc}${query}`;
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sign ? { 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) } : {}) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}
/** The query string of a hook URL found in TwiML, e.g. `?t=…&step=accept`. */
const queryOf = (xml: string, step?: string) => {
  const all = [...xml.matchAll(/(?:action|url)="[^"]*\/hooks\/twilio\/phone-transfer\/[^"?]+(\?[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  return step ? all.find((q) => q.includes(`step=${step}`))! : all[0];
};
const db = () => t.app.db;

/** A call that is going on, taken in the browser by `userId` (rows as the browser phone writes them). */
function liveCall(o: { direction?: 'in' | 'out'; user?: string; hold?: boolean; answeredAgo?: number; contact?: string | null } = {}) {
  const n = ++seq;
  const direction = o.direction ?? 'in';
  const id = `call-${n}`;
  const at = new Date(Date.now() - (o.answeredAgo ?? 60) * 1000).toISOString();
  const remote = callSid(n);
  db().insert('calls', {
    id,
    location_id: loc,
    contact_id: o.contact === undefined ? contactId : o.contact,
    sid: remote,
    direction,
    from_number: direction === 'in' ? '+4917012345678' : TWILIO_NUMBER,
    to_number: direction === 'in' ? TWILIO_NUMBER : '+4917012345678',
    status: 'in-progress',
    answered: 1,
    answered_at: at,
    user_id: o.user ?? adminId,
    started_at: at,
    updated_at: at,
  });
  db().insert('phone_calls', { call_id: id, location_id: loc, user_id: o.user ?? adminId, direction, agent_sid: callSid(n + 5000), remote_sid: remote, hold: o.hold ? 1 : 0, created_at: at, updated_at: at });
  return { id, remote };
}

beforeAll(async () => {
  t = await startTestApp();
  const me = await t.setup();
  adminId = me.user.id;
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.events.on('*', (e) => void events.push(e));
  expect((await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' })).status).toBe(200);
  expect((await t.api.put('/api/phone/settings', { api_key_sid: KEY_SID, api_secret: KEY_SECRET, twiml_app_sid: APP_SID, enabled: true, incoming: 'parallel' })).status).toBe(200);
  contactId = (await t.api.post('/api/contacts', { first_name: 'Nora', last_name: 'Neu', phone: '+4917012345678' })).data.id;
  // Two colleagues: Bea has her browser phone open, Cem has not.
  beaId = (await t.api.post('/api/users', { email: 'bea@example.com', password: 'passwort-b1', name: 'Bea', locations: [loc] })).data.id;
  cemId = (await t.api.post('/api/users', { email: 'cem@example.com', password: 'passwort-c1', name: 'Cem', locations: [loc] })).data.id;
  bea = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  cem = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await bea('POST', '/api/auth/login', { email: 'bea@example.com', password: 'passwort-b1' })).status).toBe(200);
  expect((await cem('POST', '/api/auth/login', { email: 'cem@example.com', password: 'passwort-c1' })).status).toBe(200);
  expect((await bea('POST', '/api/phone/presence', { available: true })).status).toBe(200);
}, 60_000);
afterAll(async () => {
  await t.close();
});

describe('recording notice (German law: inform everybody)', () => {
  it('announces the recording before an inbound call is connected and marks the call', async () => {
    await t.api.put('/api/telephony/settings', { record_inbound: true });
    const r = await hook('voice', { CallSid: callSid(10), From: '+4917012345678', To: TWILIO_NUMBER });
    expect(r.text).toMatch(/<Say[^>]*>Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet[^<]*<\/Say><Dial/);
    expect(r.text).toContain('record="record-from-answer-dual"');
    expect(db().get('SELECT consent_announced FROM calls WHERE sid = ?', callSid(10))!.consent_announced).toBe(1);
  });

  it('uses your own wording, and says nothing when the notice is switched off', async () => {
    await t.api.put('/api/telephony/settings', { record_announce_text: 'Dieses Gespräch wird aufgezeichnet. Bitte legen Sie auf, wenn Sie das nicht wollen.' });
    const custom = await hook('voice', { CallSid: callSid(11), From: '+4917012345678', To: TWILIO_NUMBER });
    expect(custom.text).toContain('Bitte legen Sie auf, wenn Sie das nicht wollen.');
    expect((await hook('voice-announce', {})).text).toContain('Bitte legen Sie auf');
    await t.api.put('/api/telephony/settings', { record_announce: false });
    const silent = await hook('voice', { CallSid: callSid(12), From: '+4917012345678', To: TWILIO_NUMBER });
    expect(silent.text).not.toContain('<Say');
    expect(db().get('SELECT consent_announced FROM calls WHERE sid = ?', callSid(12))!.consent_announced).toBe(0);
    await t.api.put('/api/telephony/settings', { record_announce: true, record_announce_text: '', record_inbound: false });
    expect((await hook('voice-announce', {})).text).toContain('zur Qualitätssicherung aufgezeichnet');
  });

  it('does not announce a call that is not recorded, and the announcement hook is signed', async () => {
    const r = await hook('voice', { CallSid: callSid(13), From: '+4917012345678', To: TWILIO_NUMBER });
    expect(r.text).not.toContain('aufgezeichnet');
    expect(db().get('SELECT consent_announced FROM calls WHERE sid = ?', callSid(13))!.consent_announced).toBe(0);
    expect((await hook('voice-announce', {}, '', false)).status).toBe(403);
  });
});

describe('notes during a call', () => {
  let callId = '';
  let noteId = '';
  it('keeps a note with the call and in the contact notes, with the second it was written at', async () => {
    const live = liveCall({ answeredAgo: 95 });
    callId = live.id;
    const r = await t.api.post(`/api/calls/${callId}/notes`, { body: 'Will ein Angebot für 3 Plätze' });
    expect(r.status).toBe(200);
    noteId = r.data.id;
    expect(r.data.user_name).toBe('Chef');
    expect(r.data.at_second).toBeGreaterThanOrEqual(95);
    expect(r.data.at_second).toBeLessThan(110);
    const notes = db().all('SELECT body FROM notes WHERE contact_id = ?', contactId);
    expect(notes.map((n: any) => n.body)).toEqual([expect.stringMatching(/^Anrufnotiz \(nach 1:\d\d\): Will ein Angebot für 3 Plätze$/)]);
    expect(db().get(`SELECT COUNT(*) n FROM activities WHERE contact_id = ? AND type = 'call.note'`, contactId)!.n).toBe(1);
    expect((await t.api.get(`/api/calls/${callId}/notes`)).data).toHaveLength(1);
  });

  it('shows how many notes a call has in the call list', async () => {
    const list = (await t.api.get('/api/calls')).data.calls as any[];
    expect(list.find((c) => c.id === callId)).toMatchObject({ notes_count: 1, intel_id: null });
    expect(list.find((c) => c.id !== callId)?.notes_count).toBe(0);
  });

  it('needs a text, and only its author (or an administrator) removes a note', async () => {
    expect((await t.api.post(`/api/calls/${callId}/notes`, { body: '  ' })).status).toBe(400);
    expect((await t.api.post(`/api/calls/gibtsnicht/notes`, { body: 'x' })).status).toBe(404);
    expect((await bea('DELETE', `/api/calls/${callId}/notes/${noteId}`)).status).toBe(403);
    const mine = await bea('POST', `/api/calls/${callId}/notes`, { body: 'Rückruf Mittwoch' });
    expect(mine.status).toBe(200);
    expect((await t.api.del(`/api/calls/${callId}/notes/${mine.data.id}`)).status).toBe(200); // administrator
    expect((await t.api.del(`/api/calls/${callId}/notes/${noteId}`)).data).toEqual({ ok: true });
    expect(db().get('SELECT COUNT(*) n FROM notes WHERE contact_id = ?', contactId)!.n).toBe(0);
    expect((await t.api.get(`/api/calls/${callId}/notes`)).data).toEqual([]);
  });

  it('works for a call without a contact (the note stays with the call)', async () => {
    const live = liveCall({ contact: null });
    expect((await t.api.post(`/api/calls/${live.id}/notes`, { body: 'Unbekannter Anrufer, Firma Müller' })).status).toBe(200);
    expect(db().get('SELECT COUNT(*) n FROM notes')!.n).toBe(0);
    expect((await t.api.get(`/api/calls/${live.id}/notes`)).data).toHaveLength(1);
  });

  it('is part of the Konversationen area', () => {
    expect(requiredPermission('POST', '/api/calls/x/notes')).toBe('conversations');
    expect(requiredPermission('POST', '/api/phone/calls/x/transfer')).toBe('conversations');
  });
});

describe('handing a call over: cold', () => {
  it('redirects the other party to the number and keeps the call open until that conversation ends', async () => {
    const live = liveCall({ direction: 'in' });
    requests.length = 0;
    const r = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: '12345' }, mode: 'cold' });
    expect(r.status).toBe(400); // not a valid number
    expect(r.data.error).toContain('Keine gültige Nummer');
    const ok = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'cold', note: 'Buchhaltung' });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ mode: 'cold', target_type: 'number', target_label: TARGET, status: 'ringing' });
    const req = requests.find((x) => x.path === `/Calls/${live.remote}.json`)!;
    expect(req.method).toBe('POST');
    const twiml = req.body.get('Twiml')!;
    expect(twiml).toContain(`<Number>${TARGET}</Number>`);
    expect(twiml).toContain('step=result');
    // The browser's own hang-up hook must not end the call now.
    expect(db().get('SELECT hold FROM phone_calls WHERE call_id = ?', live.id)!.hold).toBe(1);
    expect(db().get(`SELECT COUNT(*) n FROM activities WHERE contact_id = ? AND type = 'call.transfer'`, contactId)!.n).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'call.transferred' && (e.data as any).callId === live.id && (e.data as any).mode === 'cold')).toBe(true);

    // The colleague talks and hangs up: the call is over, counted with the whole talk time.
    const done = await hook('phone-transfer', { CallSid: live.remote, DialCallStatus: 'completed', DialCallDuration: '40' }, queryOf(twiml, 'result'));
    expect(done.text).toContain('<Hangup/>');
    const row = db().get('SELECT status, ended_at, duration FROM calls WHERE id = ?', live.id)!;
    expect(row.status).toBe('completed');
    expect(row.ended_at).not.toBeNull();
    expect(row.duration).toBeGreaterThanOrEqual(60);
    expect(db().get('SELECT hold FROM phone_calls WHERE call_id = ?', live.id)!.hold).toBe(0);
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('done');
  });

  it('gives an inbound caller the voicemail when nobody answers the hand-over', async () => {
    const live = liveCall({ direction: 'in' });
    const ok = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'cold' });
    expect(ok.status).toBe(200);
    const twiml = requests.filter((x) => x.path === `/Calls/${live.remote}.json`).at(-1)!.body.get('Twiml')!;
    const r = await hook('phone-transfer', { CallSid: live.remote, DialCallStatus: 'no-answer' }, queryOf(twiml, 'result'));
    expect(r.text).toContain('<Record');
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data).toMatchObject({ status: 'failed', error: 'Niemand hat abgenommen' });
    expect(db().get('SELECT hold FROM phone_calls WHERE call_id = ?', live.id)!.hold).toBe(0);
  });

  it('only says that nobody is there to somebody we called ourselves, and ends the call', async () => {
    const live = liveCall({ direction: 'out' });
    await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'cold' });
    const twiml = requests.filter((x) => x.path === `/Calls/${live.remote}.json`).at(-1)!.body.get('Twiml')!;
    expect(twiml).toContain(`callerId="${TWILIO_NUMBER}"`); // our number stays the caller ID
    const r = await hook('phone-transfer', { CallSid: live.remote, DialCallStatus: 'busy' }, queryOf(twiml, 'result'));
    expect(r.text).toContain('Leider ist gerade niemand erreichbar');
    expect(r.text).not.toContain('<Record');
    expect(db().get('SELECT status, ended_at FROM calls WHERE id = ?', live.id)!.ended_at).not.toBeNull();
  });

  it('rings a colleague’s browser, and only one that is open', async () => {
    const live = liveCall({ direction: 'in' });
    const away = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: cemId }, mode: 'cold' });
    expect(away.status).toBe(400);
    expect(away.data.error).toContain('Cem ist nicht erreichbar');
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: adminId }, mode: 'cold' })).data.error).toContain('selbst');
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: 'niemand' }, mode: 'cold' })).data.error).toContain('nicht gefunden');
    const ok = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: beaId }, mode: 'cold' });
    expect(ok.status).toBe(200);
    const twiml = requests.filter((x) => x.path === `/Calls/${live.remote}.json`).at(-1)!.body.get('Twiml')!;
    expect(twiml).toContain(`<Identity>${identityFor(beaId, loc)}</Identity>`);
    expect(twiml).toContain('<Parameter name="transfer"');
    // Bea's browser takes it: from then on the call is hers.
    const taken = await bea('POST', '/api/phone/transfers/accepted', { call_id: live.id, agent_sid: callSid(777) });
    expect(taken.status).toBe(200);
    expect(db().get('SELECT user_id, agent_sid, hold FROM phone_calls WHERE call_id = ?', live.id)).toMatchObject({ user_id: beaId, agent_sid: callSid(777), hold: 0 });
    expect(db().get('SELECT user_id FROM calls WHERE id = ?', live.id)!.user_id).toBe(beaId);
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('accepted');
    // Somebody it was not handed to cannot take it.
    expect((await cem('POST', '/api/phone/transfers/accepted', { call_id: live.id, agent_sid: callSid(778) })).data.error).toContain('nicht übergeben');
  });

  it('does not touch the call when Twilio refuses, and tells the person', async () => {
    const live = liveCall({ direction: 'in' });
    db().run('UPDATE calls SET sid = ? WHERE id = ?', callSid(99), live.id);
    db().run('UPDATE phone_calls SET remote_sid = ? WHERE call_id = ?', callSid(99), live.id);
    const r = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'cold' });
    expect(r.status).toBe(502);
    expect(r.data.error).toContain('not in-progress');
    expect(db().get('SELECT hold FROM phone_calls WHERE call_id = ?', live.id)!.hold).toBe(0);
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('failed');
  });

  it('refuses own numbers, strangers’ calls and calls that are over', async () => {
    const live = liveCall({ direction: 'in' });
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TWILIO_NUMBER } })).data.error).toContain('eigene Nummer');
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: MOBILE } })).data.error).toContain('eigene Nummer'); // forwarding target
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'gruppe', id: 'x' } })).data.error).toContain('Person oder Nummer');
    expect((await bea('POST', `/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET } })).status).toBe(403); // Chef's call
    expect((await t.api.post(`/api/phone/calls/gibtsnicht/transfer`, { to: { type: 'number', id: TARGET } })).status).toBe(404);
    db().run(`UPDATE calls SET ended_at = ?, status = 'completed' WHERE id = ?`, new Date().toISOString(), live.id);
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET } })).data.error).toContain('beendet');
  });

  it('lists the colleagues with their availability', async () => {
    const people = (await t.api.get('/api/phone/colleagues')).data as any[];
    expect(people.find((p) => p.id === beaId)).toMatchObject({ name: 'Bea', online: true });
    expect(people.find((p) => p.id === cemId)).toMatchObject({ name: 'Cem', online: false });
    expect(people.some((p) => p.id === adminId)).toBe(false);
  });
});

describe('handing a call over: with announcement', () => {
  it('needs the call on hold first (the caller then waits with music)', async () => {
    const live = liveCall({ direction: 'in' });
    const r = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: beaId }, mode: 'warm' });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('erst das Gespräch halten');
  });

  it('rings the colleague, tells them who it is and joins them with the waiting caller when they press 1', async () => {
    const live = liveCall({ direction: 'in', hold: true });
    requests.length = 0;
    const r = await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: beaId }, mode: 'warm', note: 'Frage zur Rechnung 2026-17' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ mode: 'warm', status: 'ringing', target_label: 'Bea' });
    const create = requests.find((x) => x.path === '/Calls.json' && x.method === 'POST')!;
    expect(create.body.get('To')).toBe(`client:${identityFor(beaId, loc)}`);
    expect(create.body.get('From')).toBe(TWILIO_NUMBER);
    const screening = create.body.get('Twiml')!;
    expect(screening).toContain('Nora Neu');
    expect(screening).toContain('Frage zur Rechnung 2026-17');
    expect(screening).toContain('Drücken Sie die 1');
    expect(screening).toContain('numDigits="1"');
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: beaId }, mode: 'warm' })).data.error).toContain('läuft bereits');
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('ringing');

    // Not pressing 1 (or another key) declines.
    const wrong = await hook('phone-transfer', { CallSid: callSid(900), Digits: '2' }, queryOf(screening, 'accept'));
    expect(wrong.text).toContain('<Hangup/>');
    expect(wrong.text).not.toContain('Conference');
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('declined');
    expect(db().get('SELECT hold FROM phone_calls WHERE call_id = ?', live.id)!.hold).toBe(1);

    // A second try: now Bea accepts. Bea joins the room the caller waits in; the call is Bea's from now on.
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'user', id: beaId }, mode: 'warm' })).status).toBe(200);
    const second = requests.filter((x) => x.path === '/Calls.json' && x.method === 'POST').at(-1)!.body.get('Twiml')!;
    expect((await hook('phone-transfer', { CallSid: callSid(901), Digits: '1' }, queryOf(second, 'accept'), false)).status).toBe(403);
    const yes = await hook('phone-transfer', { CallSid: callSid(901), Digits: '1' }, queryOf(second, 'accept'));
    expect(yes.text).toContain(`<Conference`);
    expect(yes.text).toContain(`hold-${live.id}`);
    expect(yes.text).toContain('startConferenceOnEnter="true"');
    expect(yes.text).toContain(`/hooks/twilio/phone-held/${loc}?call=${live.id}`);
    expect(db().get('SELECT user_id, agent_sid, hold FROM phone_calls WHERE call_id = ?', live.id)).toMatchObject({ user_id: beaId, agent_sid: callSid(901), hold: 0 });
    expect(db().get('SELECT user_id FROM calls WHERE id = ?', live.id)!.user_id).toBe(beaId);
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('accepted');
    // Pressing 1 twice does nothing more; Twilio's "completed" ends the hand-over record.
    expect((await hook('phone-transfer', { CallSid: callSid(901), Digits: '1' }, queryOf(second, 'accept'))).text).not.toContain('Conference');
    await hook('phone-transfer', { CallSid: callSid(901), CallStatus: 'completed' }, queryOf(second, 'accept').replace('step=accept', 'step=status'));
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('done');
    // Bea may now hold and end the call (it is hers); the caller's hold-room hook finishes the call once the room ends.
    const end = await hook('phone-held', { CallSid: live.remote }, `?call=${live.id}`);
    expect(end.text).toContain('<Hangup/>');
    expect(db().get('SELECT ended_at FROM calls WHERE id = ?', live.id)!.ended_at).not.toBeNull();
  });

  it('does not let the colleague join a caller who is no longer on hold', async () => {
    const live = liveCall({ direction: 'in', hold: true });
    await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'warm' });
    const screening = requests.filter((x) => x.path === '/Calls.json' && x.method === 'POST').at(-1)!.body.get('Twiml')!;
    expect(requests.filter((x) => x.path === '/Calls.json').at(-1)!.body.get('To')).toBe(TARGET);
    db().run('UPDATE phone_calls SET hold = 0 WHERE call_id = ?', live.id); // the person took the caller back
    const r = await hook('phone-transfer', { CallSid: callSid(902), Digits: '1' }, queryOf(screening, 'accept'));
    expect(r.text).toContain('nicht mehr gehalten');
    expect(r.text).not.toContain('Conference');
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data).toMatchObject({ status: 'failed', error: expect.stringContaining('nicht mehr gehalten') });
  });

  it('marks a hand-over as failed when the colleague’s phone does not answer', async () => {
    const live = liveCall({ direction: 'in', hold: true });
    await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'warm' });
    const screening = requests.filter((x) => x.path === '/Calls.json' && x.method === 'POST').at(-1)!.body.get('Twiml')!;
    await hook('phone-transfer', { CallSid: callSid(903), CallStatus: 'no-answer' }, queryOf(screening, 'accept').replace('step=accept', 'step=status'));
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data).toMatchObject({ status: 'failed', error: 'Niemand hat abgenommen' });
    // …and the person can try again.
    expect((await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'warm' })).status).toBe(200);
  });

  it('treats a ring that is a minute old as unanswered', async () => {
    const live = liveCall({ direction: 'in', hold: true });
    await t.api.post(`/api/phone/calls/${live.id}/transfer`, { to: { type: 'number', id: TARGET }, mode: 'warm' });
    db().run(`UPDATE call_transfers SET created_at = ? WHERE call_id = ?`, new Date(Date.now() - 70_000).toISOString(), live.id);
    expect((await t.api.get(`/api/phone/calls/${live.id}/transfer`)).data.status).toBe('failed');
  });

  it('ignores hooks for transfers of other sub-accounts and unknown ids', async () => {
    expect((await hook('phone-transfer', { CallSid: callSid(1), Digits: '1' }, '?t=gibtsnicht&step=accept')).text).toContain('<Hangup/>');
  });
});

describe('retention of recordings and voicemails', () => {
  const old = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
  function recorded(o: { n: number; days: number; status?: string; rec?: string }) {
    const id = `rec-${o.n}`;
    db().insert('calls', {
      id,
      location_id: loc,
      contact_id: contactId,
      sid: callSid(2000 + o.n),
      direction: 'in',
      from_number: '+4917012345678',
      to_number: TWILIO_NUMBER,
      status: o.status ?? 'completed',
      answered: 1,
      ended_at: old(o.days),
      started_at: old(o.days),
      updated_at: old(o.days),
      recording_sid: o.rec ?? recSid(o.n),
      recording_url: 'https://api.twilio.com/x',
      recording_duration: 30,
      transcription: 'Hallo, hier ist Nora.',
    });
    return id;
  }
  const state = (id: string) => db().get('SELECT recording_sid, recording_url, transcription FROM calls WHERE id = ?', id)!;

  it('does nothing while no period is set', async () => {
    const id = recorded({ n: 1, days: 400 });
    expect(await t.app.services.telephonyRetention.sweep(loc)).toBe(0);
    expect(state(id).recording_sid).toBe(recSid(1));
  });

  it('deletes old recordings at Twilio and in the call log, but keeps newer ones and keeps the call itself', async () => {
    expect((await t.api.put('/api/telephony/settings', { retention_recordings_days: 90 })).data.retention_recordings_days).toBe(90);
    const recent = recorded({ n: 2, days: 10 });
    requests.length = 0;
    expect(await t.app.services.telephonyRetention.sweep(loc)).toBe(1);
    expect(requests.filter((x) => x.method === 'DELETE').map((x) => x.path)).toEqual([`/Recordings/${recSid(1)}.json`]);
    expect(state('rec-1')).toEqual({ recording_sid: null, recording_url: null, transcription: '' });
    expect(db().get('SELECT status FROM calls WHERE id = ?', 'rec-1')!.status).toBe('completed');
    expect(state(recent).recording_sid).toBe(recSid(2));
  });

  it('keeps a recording when Twilio is down (tries again later) and forgets one Twilio no longer has', async () => {
    const down = recorded({ n: 3, days: 200 });
    const gone = recorded({ n: 4, days: 200 });
    expect(await t.app.services.telephonyRetention.sweep(loc)).toBe(1);
    expect(state(down).recording_sid).toBe(recSid(3));
    expect(state(gone).recording_sid).toBeNull();
  });

  it('has its own, shorter period for voicemails', async () => {
    const vm = recorded({ n: 5, days: 20, status: 'voicemail' });
    const talk = recorded({ n: 6, days: 20 });
    expect(await t.app.services.telephonyRetention.sweep(loc)).toBe(0);
    await t.api.put('/api/telephony/settings', { retention_voicemail_days: 14 });
    expect(await t.app.services.telephonyRetention.sweep(loc)).toBe(1);
    expect(state(vm).recording_sid).toBeNull();
    expect(state(talk).recording_sid).toBe(recSid(6)); // a conversation follows the longer period
  });

  it('is limited to the sub-account it runs for', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data;
    const otherLoc = other.id as string;
    db().insert('calls', { id: 'rec-other', location_id: otherLoc, sid: callSid(3000), direction: 'in', from_number: '+4917000000000', to_number: '+4930999', status: 'completed', started_at: old(500), updated_at: old(500), recording_sid: recSid(7), recording_url: 'x' });
    await t.app.services.telephonyRetention.sweep(loc);
    expect(db().get('SELECT recording_sid FROM calls WHERE id = ?', 'rec-other')!.recording_sid).toBe(recSid(7));
  });

  it('validates the settings', async () => {
    expect((await t.api.put('/api/telephony/settings', { retention_recordings_days: 99999 })).data.retention_recordings_days).toBe(3650);
    expect((await t.api.put('/api/telephony/settings', { retention_recordings_days: 0 })).data.retention_recordings_days).toBe(0);
  });
});

describe('DSGVO erasure of a caller', () => {
  const call = (id: string, contact: string, rec: string, status = 'completed') =>
    db().insert('calls', { id, location_id: loc, contact_id: contact, sid: callSid(4000 + Number(id.replace(/\D/g, ''))), direction: 'in', from_number: '+4917055555555', to_number: TWILIO_NUMBER, status, answered: 1, started_at: now(), updated_at: now(), recording_sid: rec, recording_url: 'https://api.twilio.com/x', recording_duration: 12, transcription: 'Hier ist Olga.' });
  const now = () => new Date().toISOString();
  const deleted = () => requests.filter((x) => x.method === 'DELETE').map((x) => x.path);

  it('deletes the recordings and voicemails of the person at Twilio – and keeps trying when Twilio fails', async () => {
    const olga = (await t.api.post('/api/contacts', { email: 'olga@example.com', first_name: 'Olga' })).data.id;
    const other = (await t.api.post('/api/contacts', { email: 'paul@example.com', first_name: 'Paul' })).data.id;
    call('erase-1', olga, recSid(41));
    call('erase-2', olga, recSid(3), 'voicemail'); // Twilio answers 500 for this one
    call('erase-3', other, recSid(43));
    requests.length = 0;
    expect((await t.api.post(`/api/contacts/${olga}/erase`, { confirm: 'olga@example.com' })).status).toBe(200);
    expect(db().get('SELECT COUNT(*) AS n FROM calls WHERE contact_id = ?', olga)!.n).toBe(0);
    // Right after the erase, without waiting for the hourly job.
    await vi.waitFor(() => expect(deleted()).toEqual(expect.arrayContaining([`/Recordings/${recSid(41)}.json`, `/Recordings/${recSid(3)}.json`])));
    expect(deleted()).not.toContain(`/Recordings/${recSid(43)}.json`);
    // The failed one stays queued (the call row with its id is gone) and goes on the next run.
    expect(db().all('SELECT recording_sid, attempts FROM call_recording_purges WHERE location_id = ?', loc)).toEqual([{ recording_sid: recSid(3), attempts: 1 }]);
    requests.length = 0;
    expect(await t.app.services.telephonyRetention.purge(loc)).toBe(0);
    expect(deleted()).toEqual([`/Recordings/${recSid(3)}.json`]);
    expect(db().get('SELECT recording_sid FROM calls WHERE id = ?', 'erase-3')!.recording_sid).toBe(recSid(43));
  });
});
