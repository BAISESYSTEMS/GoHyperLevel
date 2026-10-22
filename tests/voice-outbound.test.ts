import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { twilioSignature } from '../server/services/twilio.js';
import type { AppEvent } from '../server/core/events.js';

/** Outbound Voice AI calls: the gate (dialer verdict + daily limit), Twilio with AMD, the agent, the four results. */

const SID = `AC${'0'.repeat(31)}7`;
const TOKEN = 'e'.repeat(32);
const TWILIO_NUMBER = '+4930555000';
const MOBILE = '+4915100000001';
const twilio: { url: string; params: URLSearchParams; method: string }[] = [];
let callN = 0;
const fakeTwilio = (async (input: any, init: any = {}) => {
  const params = new URLSearchParams(String(init.body ?? ''));
  twilio.push({ url: String(input), params, method: init.method ?? 'GET' });
  return new Response(JSON.stringify({ sid: `CA${String(++callN).padStart(32, '0')}` }), { status: 201, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: AppEvent[] = [];
const contacts: Record<string, string> = {};

async function hook(name: string, params: Record<string, string>, query: string) {
  const path = `/hooks/twilio/${name}/${loc}${query}`;
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, params) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}
const outbound = (id: string) => t.app.db.get('SELECT * FROM voice_ai_outbound WHERE id = ?', id);
const settle = async () => {
  for (let i = 0; i < 5; i++) await t.app.events.flush();
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.services.aiReady = () => null;
  t.app.services.aiRun = async () => ({ text: JSON.stringify({ summary: 'Anna möchte ein Angebot; Termin am Dienstag gebucht.', next_step: 'Angebot vorbereiten.' }), model: 'fake' });
  t.app.events.on('*', (e) => void events.push(e));
  await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
  await t.api.put('/api/dialer/settings', { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '00:00', to: '23:59', skip_holidays: false });
  for (const [k, phone, dnd] of [['anna', '+4915111111111', false], ['bert', '+4915122222222', false], ['carl', '+4915133333333', false], ['dora', '+4915144444444', true]] as const) {
    contacts[k] = (await t.api.post('/api/contacts', { first_name: k[0].toUpperCase() + k.slice(1), phone, dnd })).data.id;
  }
  for (const k of ['anna', 'bert']) await t.api.post(`/api/contacts/${contacts[k]}/consent`, { action: 'granted', channel: 'phone', purposes: ['marketing'], note: 'Rückruf gewünscht' });
});
afterAll(async () => t?.close());

describe('outbound AI calls', () => {
  it('refuses what the dialer rules forbid: no confirmed consent for an automated sales call, Nicht stören', async () => {
    const carl = (await t.api.post('/api/voice-ai/outbound', { contact_id: contacts.carl, goal: 'qualify' })).data;
    expect(carl).toMatchObject({ status: 'blocked' });
    expect(carl.reason).toMatch(/Einwilligung/);
    const dora = (await t.api.post('/api/voice-ai/outbound', { contact_id: contacts.dora, goal: 'remind' })).data;
    expect(dora).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Nicht stören') });
    expect(twilio).toHaveLength(0);
  });

  let first = '';
  it('places the call with answering-machine detection; a mailbox gets the voicemail text', async () => {
    const r = await t.api.post('/api/voice-ai/outbound', { contact_id: contacts.anna, goal: 'book', script: 'Biete eine Beratung vor Ort an.', voicemail_text: 'Hallo {{contact.first_name}}, bitte rufen Sie uns zurück.' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.status).toBe('ringing');
    first = r.data.id;
    const req = twilio.at(-1)!;
    expect(req.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    expect(req.params.get('To')).toBe('+4915111111111');
    expect(req.params.get('From')).toBe(TWILIO_NUMBER);
    expect(req.params.get('MachineDetection')).toBe('DetectMessageEnd');
    expect(req.params.get('Url')).toBe(`http://localhost/hooks/twilio/voice-ai-out/${loc}?o=${first}`);
    const o = outbound(first);
    expect(o).toMatchObject({ status: 'ringing', goal: 'book', to_number: '+4915111111111' });
    // unsigned webhooks are refused
    expect((await t.api.raw(`/hooks/twilio/voice-ai-out/${loc}?o=${first}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'AnsweredBy=human' })).status).toBe(403);
    const vm = await hook('voice-ai-out', { CallSid: o.call_sid, AnsweredBy: 'machine_end_beep' }, `?o=${first}`);
    expect(vm.text).toContain('Hallo Anna, bitte rufen Sie uns zurück.</Say><Hangup/>');
    await hook('voice-ai-out-status', { CallSid: o.call_sid, CallStatus: 'completed', CallDuration: '14' }, `?o=${first}`);
    await settle();
    expect(outbound(first)).toMatchObject({ status: 'done', result: 'voicemail', answered_by: 'machine_end_beep' });
    expect(events.filter((e) => e.type === 'voice_ai_call.voicemail').map((e) => e.data.goal)).toEqual(['book']);
  });

  it('nobody picks up → no answer', async () => {
    const r = (await t.api.post('/api/voice-ai/outbound', { contact_id: contacts.bert, goal: 'qualify' })).data;
    expect(twilio.at(-1)!.params.get('MachineDetection')).toBe('Enable');
    const o = outbound(r.id);
    await hook('voice-ai-out-status', { CallSid: o.call_sid, CallStatus: 'ringing' }, `?o=${r.id}`);
    await hook('voice-ai-out-status', { CallSid: o.call_sid, CallStatus: 'no-answer' }, `?o=${r.id}`);
    await settle();
    expect(outbound(r.id).result).toBe('no_answer');
    expect(t.app.db.get('SELECT status FROM calls WHERE id = ?', o.call_id)).toEqual({ status: 'no-answer' });
    expect(events.some((e) => e.type === 'voice_ai_call.no_answer' && e.data.contactId === contacts.bert)).toBe(true);
  });

  it('a person gets the agent with the goal and script; a booking reports booked with the summary on the timeline', async () => {
    const r = (await t.api.post('/api/voice-ai/outbound', { contact_id: contacts.anna, goal: 'book', script: 'Biete eine Beratung vor Ort an.' })).data;
    const o = outbound(r.id);
    const tw = await hook('voice-ai-out', { CallSid: o.call_sid, AnsweredBy: 'human' }, `?o=${r.id}`);
    expect(tw.text).toContain('<Gather');
    expect(tw.text).toContain('Hallo Anna, hier spricht der KI-Assistent von');
    const ses = t.app.db.get('SELECT * FROM voice_ai_sessions WHERE call_id = ?', o.call_id);
    expect(ses).toMatchObject({ stage: 'outbound', from_number: '+4915111111111', contact_id: contacts.anna });
    const block = t.app.services.voicePromptExtras.map((fn: any) => fn(ses)).join('\n');
    expect(block).toContain('Vereinbare einen Termin');
    expect(block).toContain('Biete eine Beratung vor Ort an.');
    // the agent booked during the call
    t.app.db.run(`UPDATE voice_ai_sessions SET turns = 1, outcomes = '["booked"]', transcript = ? WHERE id = ?`, JSON.stringify([{ role: 'agent', text: 'Hallo Anna', at: new Date().toISOString() }, { role: 'caller', text: 'Dienstag passt', at: new Date().toISOString() }]), ses.id);
    await hook('voice-ai-out-status', { CallSid: o.call_sid, CallStatus: 'completed', CallDuration: '95' }, `?o=${r.id}`);
    await settle();
    expect(outbound(r.id)).toMatchObject({ result: 'booked', summary: 'Anna möchte ein Angebot; Termin am Dienstag gebucht.', session_id: ses.id });
    const booked = events.find((e) => e.type === 'voice_ai_call.booked')!;
    expect(booked.data).toMatchObject({ contactId: contacts.anna, goal: 'book', outcome: 'booked' });
    const note = t.app.db.get(`SELECT body FROM notes WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1`, contacts.anna);
    expect(note.body).toContain('Dienstag passt');
    expect(note.body).toContain('Termin am Dienstag gebucht');
  });

  it('stops at the daily limit and works as a workflow step', async () => {
    await t.api.put('/api/voice-ai/outbound/settings', { daily_limit: 3 });
    const r = (await t.api.post('/api/voice-ai/outbound', { contact_id: contacts.bert, goal: 'qualify' })).data;
    expect(r).toMatchObject({ status: 'blocked', reason: 'Tageslimit erreicht (3 KI-Anrufe)' });
    await t.api.put('/api/voice-ai/outbound/settings', { daily_limit: 10 });
    expect((await t.api.put('/api/voice-ai/outbound/settings', { caller_id: '+4917000000000' })).status).toBe(400);
    const created = await t.api.post('/api/workflows', { name: 'Rückruf', trigger: { type: 'manual', config: {} }, steps: [{ id: 's1', type: 'voice_ai_call', goal: 'qualify', script: 'Frag nach dem Projekt von {{contact.first_name}}.' }] });
    expect(created.status, JSON.stringify(created.data)).toBe(200);
    const wf = created.data;
    const act = await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    expect(act.status, JSON.stringify(act.data)).toBe(200);
    const en = await t.api.post(`/api/workflows/${wf.id}/enroll`, { contact_ids: [contacts.bert, contacts.carl] });
    expect(en.data.enrolled, JSON.stringify(en.data)).toBe(2);
    const rows = t.app.db.all('SELECT contact_id, status, script, workflow_id FROM voice_ai_outbound WHERE workflow_id = ? ORDER BY created_at', wf.id);
    expect(rows).toEqual([
      { contact_id: contacts.bert, status: 'ringing', script: 'Frag nach dem Projekt von Bert.', workflow_id: wf.id },
      expect.objectContaining({ contact_id: contacts.carl, status: 'blocked' }),
    ]);
    const list = (await t.api.get('/api/voice-ai/outbound')).data;
    expect(list.calls.length).toBeGreaterThanOrEqual(6);
    expect(list.stats).toMatchObject({ booked: 1, voicemail: 1, no_answer: 1 });
  });
});
