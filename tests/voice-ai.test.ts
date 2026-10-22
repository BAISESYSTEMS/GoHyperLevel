import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { twilioSignature } from '../server/services/twilio.js';
import type { AppEvent } from '../server/core/events.js';
import { requiredPermission } from '../server/core/permissions.js';
import {
  VOICE_SCHEMA,
  cleanVoiceSettings,
  defaultVoiceSettings,
  gatherTwiml,
  parseVoiceOutput,
  resolveOutcome,
  shouldAnswer,
  speakable,
  spokenWhen,
  transferTwiml,
  voiceTask,
} from '../server/services/voice-ai.js';
import { voiceTiming } from '../server/modules/voice-ai.js';

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
const TWILIO_NUMBER = '+4930123456';
const MOBILE = '+4915112345678';
const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const callSid = (n: number) => `CA${String(n).padStart(32, '0')}`;
const EMPTY_ARGS = { calendar_id: '', date: '', time: '', first_name: '', last_name: '', email: '', message: '', title: '', reason: '' };

/** Fake Claude: every request is recorded; `respond` decides the model's JSON for the voice turns. */
type Reply = { status: number; json: any };
const claude: { body: any }[] = [];
let respond: (prompt: string, body: any) => unknown = () => ({ say: 'Wie kann ich helfen?', action: 'none', args: EMPTY_ARGS });
let delayMs = 0;
const reply = (text: string): Reply => ({ status: 200, json: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 800, output_tokens: 60 } } });
const fakeClaude = (async (_url: string, init: any = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  claude.push({ body });
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const prompt: string = body?.messages?.[0]?.content ?? '';
  let r: Reply;
  if (prompt.includes('Aufgabe: Fasse dieses Telefonat')) r = reply(JSON.stringify({ summary: 'Max Muster hat angerufen und einen Termin gebucht.', next_step: 'Termin vorbereiten.' }));
  else {
    const out = respond(prompt, body);
    r = out && typeof out === 'object' && 'status' in (out as any) ? (out as Reply) : reply(typeof out === 'string' ? out : JSON.stringify(out));
  }
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;
const fakeTwilio = (async () => new Response(JSON.stringify({ sid: 'X' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: AppEvent[] = [];
const flush = () => t.app.events.flush();

async function hook(name: string, params: Record<string, string>, opts: { query?: string; token?: string; sign?: boolean } = {}) {
  const path = `/hooks/twilio/${name}/${loc}${opts.query ?? ''}`;
  const signature = twilioSignature(opts.token ?? TOKEN, `http://localhost${path}`, params);
  const r = await t.api.raw(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opts.sign === false ? {} : { 'x-twilio-signature': signature }) },
    body: new URLSearchParams(params).toString(),
  });
  return { status: r.status, text: await r.text() };
}
const speak = (sid: string, turn: number, speech: string) => hook('voice-ai', { CallSid: sid, SpeechResult: speech, Confidence: '0.9' }, { query: `?t=${turn}` });
const callBySid = (sid: string) => t.app.db.get('SELECT * FROM calls WHERE sid = ?', sid)!;
const sessionBySid = (sid: string) => {
  const s = t.app.db.get('SELECT * FROM voice_ai_sessions WHERE call_sid = ?', sid)!;
  return { ...s, transcript: JSON.parse(s.transcript), actions: JSON.parse(s.actions), outcomes: JSON.parse(s.outcomes) };
};
/** The latest calendar slot of the first free day listed in the prompt. */
function lastSlotOfFirstDay(prompt: string) {
  const m = prompt.match(/calendar_id: (\w+),[^\n]*\n(\d{4}-\d{2}-\d{2}) \([^)]+\): ([\d:, ]+)/);
  if (!m) throw new Error('keine freien Termine im Prompt');
  const times = m[3].split(',').map((s) => s.trim());
  return { calendar_id: m[1], date: m[2], time: times[times.length - 1] };
}

let calendarId = '';
beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.aiFetch = fakeClaude;
  t.app.services.twilioFetch = fakeTwilio;
  t.app.events.on('*', (e) => void events.push(e));
  await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: TWILIO_NUMBER, forward_to: MOBILE, hours_mode: 'always' });
  await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true, facts: 'Zahnarztpraxis Dr. Sonne in Leipzig. Notfälle bitte sofort weiterverbinden.' });
  const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['08:00', '20:00']]]));
  calendarId = (await t.api.post('/api/calendars', { name: 'Erstgespräch', duration: 30, interval: 30, min_notice: 1, availability: every, settings: { confirmation_email: false, notify_team: false } })).data.id;
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  claude.length = 0;
  delayMs = 0;
  respond = () => ({ say: 'Wie kann ich helfen?', action: 'none', args: EMPTY_ARGS });
});

describe('voice agent building blocks', () => {
  it('validates the tool call strictly', () => {
    const ok = (o: unknown, allowed?: any) => parseVoiceOutput(JSON.stringify(o), allowed);
    expect(ok({ say: 'Gern.', action: 'none', args: EMPTY_ARGS })).toMatchObject({ ok: true });
    expect(ok({ say: '', action: 'book_appointment', args: { ...EMPTY_ARGS, date: '2026-10-06', time: '10:30', first_name: 'Max' } })).toMatchObject({ ok: true, value: { action: 'book_appointment' } });
    expect(parseVoiceOutput('kein json')).toMatchObject({ ok: false, error: 'Kein gültiges JSON' });
    expect(ok({ say: 'x', action: 'hack', args: EMPTY_ARGS })).toMatchObject({ ok: false, error: 'action unbekannt' });
    expect(ok({ say: 'x', action: 'transfer', args: EMPTY_ARGS }, ['none', 'end_call'])).toMatchObject({ ok: false, error: 'Werkzeug transfer ist hier nicht erlaubt' });
    expect(ok({ say: 'x', action: 'none', args: EMPTY_ARGS, extra: 1 })).toMatchObject({ ok: false });
    expect(ok({ say: 'x', action: 'none', args: { ...EMPTY_ARGS, sql: 'drop' } })).toMatchObject({ ok: false, error: 'args: unbekanntes Feld sql' });
    expect(ok({ say: '', action: 'book_appointment', args: { ...EMPTY_ARGS, date: '2026-02-30', time: '10:00' } })).toMatchObject({ ok: false, error: 'args.date ungültig' });
    expect(ok({ say: '', action: 'book_appointment', args: { ...EMPTY_ARGS, date: '2026-10-06', time: '25:00' } })).toMatchObject({ ok: false, error: 'args.time ungültig' });
    expect(ok({ say: '', action: 'book_appointment', args: { ...EMPTY_ARGS, date: '2026-10-06' } })).toMatchObject({ ok: false, error: 'book_appointment: args.time fehlt' });
    expect(ok({ say: 'Notiert.', action: 'take_message', args: EMPTY_ARGS })).toMatchObject({ ok: false, error: 'take_message: args.message fehlt' });
    expect(ok({ say: 'ok', action: 'none', args: { ...EMPTY_ARGS, email: 'kaputt@' } })).toMatchObject({ ok: false, error: 'args.email ungültig' });
    expect(ok({ say: 'ok', action: 'none', args: { ...EMPTY_ARGS, first_name: '<script>' } })).toMatchObject({ ok: false, error: 'args.first_name ungültig' });
    expect(ok({ say: '', action: 'none', args: EMPTY_ARGS })).toMatchObject({ ok: false, error: 'say leer' });
    expect(ok({ say: 'x'.repeat(801), action: 'none', args: EMPTY_ARGS })).toMatchObject({ ok: false, error: 'say ungültig' });
    expect(VOICE_SCHEMA.properties.action.enum).toContain('book_appointment');
    expect(VOICE_SCHEMA.properties.args.required).toHaveLength(9);
  });

  it('builds the speech loop TwiML with barge-in and escapes text', () => {
    const x = gatherTwiml({ say: 'Müller & Söhne <GmbH>', voice: 'Polly.Daniel-Neural', action: 'https://x/hooks/twilio/voice-ai/L?t=2' });
    expect(x).toContain('<Gather input="speech" language="de-DE" speechTimeout="auto" timeout="6" action="https://x/hooks/twilio/voice-ai/L?t=2" method="POST" actionOnEmptyResult="true" bargeIn="true">');
    expect(x).toContain('<Say voice="Polly.Daniel-Neural" language="de-DE">Müller &amp; Söhne &lt;GmbH&gt;</Say></Gather>');
    const d = transferTwiml({ say: 'Ich verbinde.', voice: 'Polly.Vicki-Neural', numbers: [MOBILE], clients: [{ identity: 'u_a_b', params: { callId: 'c1' } }], action: 'https://x/t', timeout: 20 });
    expect(d).toContain(`<Dial timeout="20" action="https://x/t" method="POST" answerOnBridge="true"><Number>${MOBILE}</Number><Client><Identity>u_a_b</Identity><Parameter name="callId" value="c1"/></Client></Dial>`);
  });

  it('keeps answers speakable and says dates the German way', () => {
    expect(speakable('**Gern!** Hier: https://example.com/buchen 😀 # Termin')).toBe('Gern! Hier: Termin');
    const long = `${'Das ist ein Satz. '.repeat(60)}`;
    expect(speakable(long, 100).length).toBeLessThanOrEqual(100);
    expect(speakable(long, 100).endsWith('.')).toBe(true);
    expect(spokenWhen('2026-10-06T08:30:00Z', 'Europe/Berlin')).toBe('Dienstag, 6. Oktober, um 10 Uhr 30');
    expect(spokenWhen('2026-10-06T08:00:00Z', 'Europe/Berlin')).toBe('Dienstag, 6. Oktober, um 10 Uhr');
  });

  it('decides when to answer, which outcome counts and checks the settings', () => {
    expect(shouldAnswer('always', 'inbound', true)).toBe(true);
    expect(shouldAnswer('after_hours', 'inbound', true)).toBe(false);
    expect(shouldAnswer('after_hours', 'inbound', false)).toBe(true);
    expect(shouldAnswer('no_answer', 'inbound', false)).toBe(false);
    expect(shouldAnswer('no_answer', 'unanswered', true)).toBe(true);
    expect(shouldAnswer('off', 'unanswered', false)).toBe(false);
    expect(resolveOutcome({ outcomes: ['message', 'booked'], turns: 3, end: 'agent' })).toBe('booked');
    expect(resolveOutcome({ outcomes: [], turns: 3, end: 'caller' })).toBe('answered');
    expect(resolveOutcome({ outcomes: [], turns: 0, end: 'caller' })).toBe('hangup');
    expect(resolveOutcome({ outcomes: [], turns: 2, end: 'voicemail' })).toBe('voicemail');
    expect(resolveOutcome({ outcomes: [], turns: 9, end: 'limit' })).toBe('limit');
    const d = defaultVoiceSettings();
    expect(() => cleanVoiceSettings({ voice: 'Alice' }, d)).toThrow('Unbekannte Stimme');
    expect(() => cleanVoiceSettings({ max_turns: 100 }, d)).toThrow('2 bis 40');
    expect(() => cleanVoiceSettings({ language: 'en-US' }, d)).toThrow('de-DE');
    expect(() => cleanVoiceSettings({ transfer_number: '12' }, d)).toThrow('+49');
    expect(cleanVoiceSettings({ transfer_number: '0151 2223334', mode: 'no_answer' }, d)).toMatchObject({ transfer_number: '+491512223334', mode: 'no_answer' });
    const task = voiceTask({ persona: 'Wir duzen.', instructions: 'Notfälle sofort weiterverbinden.' }, 'Praxis', ['none', 'take_message', 'end_call']);
    expect(task).toContain('"take_message"');
    expect(task).not.toContain('"transfer"');
    expect(task).toContain('Wir duzen.');
  });

  it('maps the routes to areas', () => {
    expect(requiredPermission('PUT', '/api/voice-ai/settings')).toBe('settings');
    expect(requiredPermission('GET', '/api/voice-ai/calls/x')).toBe('conversations');
  });
});

describe('KI-Telefonagent', () => {
  it('stores settings and refuses unknown calendars and voices', async () => {
    const s = (await t.api.get('/api/voice-ai/settings')).data;
    expect(s.settings).toMatchObject({ mode: 'off', voice: 'Polly.Vicki-Neural', language: 'de-DE', max_turns: 16 });
    expect(s.ai_ready).toBe(true);
    expect(s.calendars.map((c: any) => c.id)).toContain(calendarId);
    expect((await t.api.put('/api/voice-ai/settings', { calendar_ids: ['nope'] })).status).toBe(400);
    expect((await t.api.put('/api/voice-ai/settings', { voice: 'Alice' })).status).toBe(400);
    expect((await t.api.put('/api/voice-ai/settings', { transfer_number: TWILIO_NUMBER })).data.error).toContain('Twilio-Nummer');
    const r = await t.api.put('/api/voice-ai/settings', { mode: 'always', persona: 'Ruhig und freundlich.', instructions: 'Termine für Erstgespräche vergeben.', calendar_ids: [calendarId], voice: 'Google.de-DE-Neural2-F' });
    expect(r.status).toBe(200);
    expect(r.data.settings).toMatchObject({ mode: 'always', calendar_ids: [calendarId], voice: 'Google.de-DE-Neural2-F' });
    expect(r.data.active_now).toBe(true);
  });

  it('refuses unsigned or wrongly signed webhooks', async () => {
    expect((await hook('voice-ai', { CallSid: callSid(1), SpeechResult: 'Hallo' }, { query: '?t=0', sign: false })).status).toBe(403);
    expect((await hook('voice-ai', { CallSid: callSid(1), SpeechResult: 'Hallo' }, { query: '?t=0', token: 'e'.repeat(32) })).status).toBe(403);
    expect((await hook('voice-ai-transfer', { CallSid: callSid(1), DialCallStatus: 'completed' }, { sign: false })).status).toBe(403);
  });

  it('answers, books an appointment from the free slots and wraps the call up', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'KI-Termin', trigger: { type: 'voice_ai.completed', config: { outcome: 'booked' } }, steps: [{ type: 'add_tag', tags: ['ki-termin'] }] })).data;
    expect(wf.trigger.type).toBe('voice_ai.completed');
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });

    const sid = callSid(10);
    const greet = await hook('voice', { CallSid: sid, From: '+4917011111', To: TWILIO_NUMBER, CallStatus: 'ringing' });
    expect(greet.status).toBe(200);
    expect(greet.text).toContain(`<Gather input="speech" language="de-DE" speechTimeout="auto" timeout="6" action="http://localhost/hooks/twilio/voice-ai/${loc}?t=0" method="POST" actionOnEmptyResult="true" bargeIn="true">`);
    expect(greet.text).toContain('<Say voice="Google.de-DE-Neural2-F" language="de-DE">Guten Tag, Sie sprechen mit dem digitalen Assistenten von Testfirma. Wie kann ich Ihnen helfen?</Say>');
    expect(greet.text).not.toContain('<Dial');
    expect(callBySid(sid)).toMatchObject({ answered: 1, reason: 'ai', status: 'in-progress' });

    respond = () => ({ say: 'Gern. Morgen hätte ich noch etwas frei. Wie ist Ihr Name?', action: 'none', args: EMPTY_ARGS });
    const r1 = await speak(sid, 0, 'Ich hätte gern einen Termin für ein Erstgespräch.');
    expect(r1.text).toContain('Gern. Morgen hätte ich noch etwas frei. Wie ist Ihr Name?');
    expect(r1.text).toContain(`action="http://localhost/hooks/twilio/voice-ai/${loc}?t=1"`);
    const req = claude[0].body;
    expect(req.output_config.format.schema).toEqual(VOICE_SCHEMA);
    expect(JSON.stringify(req.system)).toContain('Zahnarztpraxis Dr. Sonne');
    const prompt: string = req.messages[0].content;
    expect(prompt).toContain('<freie_termine>');
    expect(prompt).toContain(`calendar_id: ${calendarId}`);
    expect(prompt).toContain('Anrufer: Ich hätte gern einen Termin für ein Erstgespräch.');
    expect(prompt).toContain('Anrufer-Nummer: +4917011111');
    expect(prompt).toContain('Termine für Erstgespräche vergeben.');
    expect(prompt).toContain('"book_appointment"');
    expect(prompt).toContain('"transfer"');

    let slot = { calendar_id: '', date: '', time: '' };
    respond = (p) => ((slot = lastSlotOfFirstDay(p)), { say: '', action: 'book_appointment', args: { ...EMPTY_ARGS, ...slot, first_name: 'Max', last_name: 'Muster', message: 'Erstgespräch' } });
    const r2 = await speak(sid, 1, 'Max Muster. Ja, der letzte Termin passt mir.');
    const appt = t.app.db.get('SELECT * FROM appointments WHERE source = ?', 'KI-Telefonagent')!;
    expect(appt).toBeTruthy();
    expect(appt.calendar_id).toBe(calendarId);
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(appt.start_at))).toBe(slot.date);
    expect(r2.text).toContain('Ich habe Ihren Termin eingetragen: ');
    expect(r2.text).toContain(spokenWhen(appt.start_at, 'Europe/Berlin'));
    const contact = t.app.db.get('SELECT * FROM contacts WHERE id = ?', appt.contact_id)!;
    expect(contact).toMatchObject({ first_name: 'Max', last_name: 'Muster', phone: '+4917011111' });
    expect(callBySid(sid).contact_id).toBe(contact.id);

    respond = () => ({ say: 'Sehr gern. Auf Wiederhören!', action: 'end_call', args: EMPTY_ARGS });
    const r3 = await speak(sid, 2, 'Nein danke, das war alles. Tschüss!');
    expect(r3.text).toContain('Sehr gern. Auf Wiederhören!</Say><Hangup/>');
    await flush();

    const ses = sessionBySid(sid);
    expect(ses).toMatchObject({ status: 'ended', outcome: 'booked', end_reason: 'agent', turns: 3, appointment_id: appt.id, summary: 'Max Muster hat angerufen und einen Termin gebucht.', next_step: 'Termin vorbereiten.' });
    expect(ses.transcript.map((x: any) => x.role)).toEqual(['agent', 'caller', 'agent', 'caller', 'agent', 'caller', 'agent']);
    const call = callBySid(sid);
    expect(call).toMatchObject({ status: 'completed', answered: 1 });
    expect(call.transcription).toContain('Termin gebucht: Max Muster hat angerufen');
    const msg = t.app.db.get('SELECT * FROM messages WHERE id = ?', call.message_id)!;
    expect(msg).toMatchObject({ channel: 'call', status: 'completed' });
    expect(msg.body).toContain('Max Muster hat angerufen');
    const note = t.app.db.get('SELECT * FROM notes WHERE contact_id = ? ORDER BY created_at DESC', contact.id)!;
    expect(note.body).toContain('Ergebnis: Termin gebucht');
    expect(note.body).toContain('Anrufer: Max Muster. Ja, der letzte Termin passt mir.');
    const done = events.find((e) => e.type === 'voice_ai.completed' && e.data.callId === call.id)!;
    expect(done.data).toMatchObject({ outcome: 'booked', outcomes: ['booked'], contactId: contact.id, appointmentId: appt.id, transferred: false, turns: 3 });
    expect(events.some((e) => e.type === 'call.completed' && e.data.callId === call.id)).toBe(true);
    expect(events.some((e) => e.type === 'call.missed' && e.data.callId === call.id)).toBe(false);
    // Turns + summary count towards the KI-Assistent's monthly budget.
    expect(t.app.db.get(`SELECT COUNT(*) n FROM ai_calls WHERE purpose = 'voice_agent' AND status = 'ok'`)!.n).toBe(4);
    expect((await t.api.get(`/api/contacts/${contact.id}`)).data.tags).toContain('ki-termin');
    // The details API shows transcript and actions.
    const detail = (await t.api.get(`/api/voice-ai/calls/${call.id}`)).data;
    expect(detail.transcript).toHaveLength(7);
    expect(detail.actions.find((a: any) => a.type === 'book_appointment').ok).toBe(true);
    expect(detail.outcome_label).toBe('Termin gebucht');
  });

  it('looks up other days and recovers from a taken slot with a second model call', async () => {
    const sid = callSid(21);
    await hook('voice', { CallSid: sid, From: '+4917012345', To: TWILIO_NUMBER });
    let day = '';
    respond = (p) => {
      if (!p.includes('<werkzeug_ergebnis>')) {
        day = lastSlotOfFirstDay(p).date;
        return { say: 'Einen Moment, ich schaue nach.', action: 'check_slots', args: { ...EMPTY_ARGS, date: day, calendar_id: calendarId } };
      }
      expect(p).toContain(`Freie Zeiten in Kalender „Erstgespräch“`);
      expect(p).not.toContain('"check_slots":');
      return { say: 'An dem Tag ist ab 8 Uhr frei. Welche Uhrzeit passt Ihnen?', action: 'none', args: EMPTY_ARGS };
    };
    const r = await speak(sid, 0, 'Was haben Sie an dem Tag frei?');
    expect(claude).toHaveLength(2);
    expect(r.text).toContain('An dem Tag ist ab 8 Uhr frei.');
    expect(r.text).not.toContain('ich schaue nach');

    claude.length = 0;
    respond = (p) =>
      p.includes('<werkzeug_ergebnis>')
        ? (expect(p).toContain('Buchung fehlgeschlagen: Dieser Termin ist leider nicht (mehr) frei.'), { say: 'Um 3 Uhr nachts ist leider zu. Wie wäre 9 Uhr?', action: 'none', args: EMPTY_ARGS })
        : { say: '', action: 'book_appointment', args: { ...EMPTY_ARGS, calendar_id: calendarId, date: day, time: '03:00', first_name: 'Nora', last_name: 'Nacht' } };
    const r2 = await speak(sid, 1, 'Dann um 3 Uhr nachts.');
    expect(claude).toHaveLength(2);
    expect(r2.text).toContain('Wie wäre 9 Uhr?');
    expect(t.app.db.get(`SELECT COUNT(*) n FROM appointments a JOIN contacts c ON c.id = a.contact_id WHERE c.last_name = 'Nacht'`)!.n).toBe(0);
    expect(sessionBySid(sid).actions.find((a: any) => a.type === 'book_appointment').ok).toBe(false);
  });

  it('handles silence, a failed transfer and takes a message instead', async () => {
    const sid = callSid(11);
    await hook('voice', { CallSid: sid, From: '+4917022222', To: TWILIO_NUMBER });
    const quiet = await speak(sid, 0, '');
    expect(quiet.text).toContain('Sind Sie noch da?');
    expect(quiet.text).toContain('?t=0"');
    expect(claude).toHaveLength(0);

    respond = () => ({ say: 'Ich verbinde Sie, einen Moment bitte.', action: 'transfer', args: { ...EMPTY_ARGS, reason: 'Möchte Dr. Sonne sprechen' } });
    const tr = await speak(sid, 0, 'Bitte verbinden Sie mich mit Dr. Sonne.');
    expect(tr.text).toContain(`<Dial timeout="20" action="http://localhost/hooks/twilio/voice-ai-transfer/${loc}?t=1" method="POST" answerOnBridge="true"><Number>${MOBILE}</Number></Dial>`);
    expect(sessionBySid(sid).status).toBe('transferring');

    const back = await hook('voice-ai-transfer', { CallSid: sid, DialCallStatus: 'no-answer' }, { query: '?t=1' });
    expect(back.text).toContain('Leider ist gerade niemand erreichbar.');
    expect(back.text).toContain('<Gather');

    respond = (p) => {
      expect(p).not.toContain('"transfer":');
      expect(p).toContain('Weiterverbinden: nicht möglich');
      return { say: 'Ich habe es notiert, Dr. Sonne ruft Sie zurück. Kann ich sonst noch helfen?', action: 'take_message', args: { ...EMPTY_ARGS, message: 'Rückruf wegen Kostenvoranschlag, heute bis 18 Uhr erreichbar', first_name: 'Erika', last_name: 'Gabler' } };
    };
    const m = await speak(sid, 1, 'Dann soll er mich zurückrufen wegen dem Kostenvoranschlag. Erika Gabler hier.');
    expect(m.text).toContain('Ich habe es notiert');
    const task = t.app.db.get(`SELECT * FROM tasks WHERE title LIKE 'Rückruf:%' ORDER BY created_at DESC`)!;
    expect(task.title).toBe('Rückruf: Erika Gabler (+4917022222)');
    expect(task.description).toContain('Kostenvoranschlag');

    // The caller hangs up: Twilio's status callback ends the call and the session.
    await hook('voice-status', { CallSid: sid, CallStatus: 'completed', CallDuration: '75' });
    await flush();
    const ses = sessionBySid(sid);
    expect(ses).toMatchObject({ status: 'ended', outcome: 'message', end_reason: 'caller', transfer_status: 'failed', task_id: task.id });
    expect(ses.message).toContain('Kostenvoranschlag');
    expect(callBySid(sid)).toMatchObject({ status: 'completed', duration: 75 });
    expect(events.find((e) => e.type === 'voice_ai.completed' && e.data.sessionId === ses.id)!.data).toMatchObject({ outcome: 'message', transferred: false });
  });

  it('ends after two silences and when the turn cap is reached', async () => {
    const sid = callSid(12);
    await hook('voice', { CallSid: sid, From: '+4917033333', To: TWILIO_NUMBER });
    await speak(sid, 0, '');
    const bye = await speak(sid, 0, '');
    expect(bye.text).toContain('Ich höre Sie leider nicht.');
    expect(bye.text).toContain('<Hangup/>');
    await flush();
    expect(sessionBySid(sid)).toMatchObject({ status: 'ended', outcome: 'hangup', end_reason: 'silence' });

    await t.api.put('/api/voice-ai/settings', { max_turns: 2 });
    const sid2 = callSid(13);
    await hook('voice', { CallSid: sid2, From: '+4917044444', To: TWILIO_NUMBER });
    await speak(sid2, 0, 'Frage eins');
    await speak(sid2, 1, 'Frage zwei');
    const capped = await speak(sid2, 2, 'Frage drei');
    expect(capped.text).toContain('Unser Team meldet sich bei Ihnen.');
    expect(capped.text).toContain('<Hangup/>');
    expect(claude.filter((c) => !c.body.messages[0].content.includes('Fasse dieses Telefonat'))).toHaveLength(2);
    await flush();
    expect(sessionBySid(sid2)).toMatchObject({ outcome: 'limit', end_reason: 'limit', turns: 3 });
    await t.api.put('/api/voice-ai/settings', { max_turns: 16 });
  });

  it('falls back to voicemail when Claude answers nonsense twice or is down', async () => {
    const sid = callSid(14);
    await hook('voice', { CallSid: sid, From: '+4917055555', To: TWILIO_NUMBER });
    respond = () => 'das ist kein JSON';
    const once = await speak(sid, 0, 'Hallo?');
    expect(once.text).toContain('Entschuldigung, das habe ich nicht ganz verstanden.');
    respond = () => ({ say: 'Ich buche.', action: 'book_appointment', args: { ...EMPTY_ARGS, date: '2026-13-01', time: '10:00' } });
    const vm = await speak(sid, 1, 'Ich möchte einen Termin.');
    expect(vm.text).toContain('technische Störung');
    expect(vm.text).toContain(`<Record action="http://localhost/hooks/twilio/voice-recording/${loc}"`);
    expect(callBySid(sid)).toMatchObject({ answered: 0, reason: 'ai_error' });
    expect(sessionBySid(sid).actions.filter((a: any) => a.type === 'invalid')).toHaveLength(2);
    // The voicemail arrives through telephony's recording hook.
    await hook('voice-recording', { CallSid: sid, RecordingSid: `RE${'1'.repeat(32)}`, RecordingDuration: '12', RecordingStatus: 'completed' });
    await flush();
    expect(callBySid(sid).status).toBe('voicemail');
    expect(sessionBySid(sid)).toMatchObject({ status: 'ended', outcome: 'voicemail' });

    const sid2 = callSid(15);
    await hook('voice', { CallSid: sid2, From: '+4917066666', To: TWILIO_NUMBER });
    respond = () => ({ status: 500, json: { error: { message: 'boom' } } });
    const down = await speak(sid2, 0, 'Hallo, ist da jemand?');
    expect(down.text).toContain('technische Störung');
    expect(down.text).toContain('<Record');
    expect(sessionBySid(sid2)).toMatchObject({ end_reason: 'error', status: 'fallback' });
  });

  it('plays a filler while Claude is slow and answers on the next request', async () => {
    voiceTiming.replyMs = 30;
    const sid = callSid(16);
    await hook('voice', { CallSid: sid, From: '+4917077777', To: TWILIO_NUMBER });
    delayMs = 250;
    respond = () => ({ say: 'Unsere Praxis hat montags bis freitags geöffnet. Kann ich sonst helfen?', action: 'none', args: EMPTY_ARGS });
    const filler = await speak(sid, 0, 'Wann haben Sie geöffnet?');
    expect(filler.text).toContain('Einen Moment bitte.');
    expect(filler.text).toContain(`<Redirect method="POST">http://localhost/hooks/twilio/voice-ai-wait/${loc}?t=1&amp;n=1</Redirect>`);
    const answer = await hook('voice-ai-wait', { CallSid: sid }, { query: '?t=1&n=1' });
    expect(answer.text).toContain('Unsere Praxis hat montags bis freitags geöffnet.');
    expect(answer.text).toContain('?t=1"');
    voiceTiming.replyMs = 9000;
  });

  it('only takes calls in its mode and while the KI-Assistent can pay for them', async () => {
    await t.api.put('/api/voice-ai/settings', { mode: 'no_answer' });
    const sid = callSid(17);
    const ring = await hook('voice', { CallSid: sid, From: '+4917088888', To: TWILIO_NUMBER });
    expect(ring.text).toContain(`<Number>${MOBILE}</Number>`);
    const ai = await hook('voice-dial', { CallSid: sid, DialCallStatus: 'no-answer' });
    expect(ai.text).toContain('<Gather input="speech"');
    expect(sessionBySid(sid).stage).toBe('unanswered');

    await t.api.put('/api/voice-ai/settings', { mode: 'after_hours' });
    const open = await hook('voice', { CallSid: callSid(18), From: '+4917099999', To: TWILIO_NUMBER });
    expect(open.text).toContain('<Dial');
    expect(open.text).not.toContain('<Gather');

    // Monthly budget used up: the agent stays quiet and the normal voicemail answers.
    await t.api.put('/api/voice-ai/settings', { mode: 'always' });
    t.app.db.insert('ai_calls', { id: 'budget', location_id: loc, purpose: 'chat_bot', model: 'claude-sonnet-5-5', status: 'ok', cost_micros: 999_000_000, created_at: new Date().toISOString() });
    const broke = await hook('voice', { CallSid: callSid(19), From: '+4917012121', To: TWILIO_NUMBER });
    expect(broke.text).not.toContain('<Gather');
    expect(broke.text).toContain('<Dial');
    t.app.db.run(`DELETE FROM ai_calls WHERE id = 'budget'`);
    await t.api.put('/api/voice-ai/settings', { mode: 'off' });
    const off = await hook('voice', { CallSid: callSid(20), From: '+4917013131', To: TWILIO_NUMBER });
    expect(off.text).not.toContain('<Gather');
  });

  it('lists AI calls for the call log', async () => {
    const list = (await t.api.get('/api/voice-ai/calls?limit=5')).data;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0]).toHaveProperty('outcome_label');
    expect(list[0]).not.toHaveProperty('transcript');
  });
});
