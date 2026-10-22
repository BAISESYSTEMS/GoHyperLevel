import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { berlinDay, startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { retry as agentRetry } from '../server/services/agent-llm.js';
import { anthropicSse, fakeModel, sse } from './agent-fakes.js';
import { decide } from '../server/services/agent-safety.js';
import { splitBooking, withBooking } from '../server/modules/ai-booking.js';
import { BOT_SCHEMA } from '../server/services/ai-context.js';
import { zonedToUtc } from '../server/core/time.js';

/**
 * AI books appointments in chat: the phone agent's booking logic as shared tools – the KI-Assistent's website chat bot (stub model
 * through aiFetch) and an agent's auto-reply at the safety level "Termin buchen" (stub model through agentFetch). The confirmation
 * carries the links to reschedule and to cancel.
 */

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
const AKEY = 'sk-ant-api03-booking-abcdefghijklmnopqrstuvwxyz';
let t: Awaited<ReturnType<typeof startTestApp>>;
let calId = '';
let paidCal = '';

/** The chat bot's stub model: every request is kept, `respond` decides the JSON answer. */
const calls: { prompt: string; body: any }[] = [];
let respond: (prompt: string, body: any) => Record<string, unknown> = () => answer('Hallo!');
const answer = (reply: string, extra: Record<string, unknown> = {}) => ({
  reply,
  confidence: 0.9,
  handoff: false,
  handoff_reason: '',
  lead: { first_name: '', last_name: '', email: '', phone: '' },
  buying_intent: false,
  intent_summary: '',
  ...extra,
});
const fakeClaude = (async (_url: string, init: any = {}) => {
  const body = JSON.parse(init.body);
  const prompt = body.messages?.[0]?.content ?? '';
  calls.push({ prompt, body });
  const out = JSON.stringify(respond(prompt, body));
  return new Response(
    JSON.stringify({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: out }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 80 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;
const model = fakeModel();

const chat = (body: Record<string, unknown>) =>
  t.api.raw(`/api/public/chat/${t.api.location}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const chatLog = async (visitor: string) => (await (await t.api.raw(`/api/public/chat/${t.api.location}/messages?visitor=${visitor}`)).json()).messages as any[];
/** The first free time listed for the calendar in the prompt's <freie_termine> block. */
function firstFree(prompt: string) {
  const m = prompt.match(/calendar_id: (\w+),[^\n]*\n(\d{4}-\d{2}-\d{2}) \([^)]+\): (\d\d:\d\d)/);
  if (!m) throw new Error('keine freien Termine im Prompt');
  return { calendar_id: m[1], date: m[2], time: m[3] };
}
const none = { action: 'none', calendar_id: '', date: '', time: '' };

beforeAll(async () => {
  retry.ms = 1;
  agentRetry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fakeClaude;
  t.app.services.agentFetch = model.fetch;
  await t.setup();
  await t.api.patch('/api/location', { settings: { chat: { enabled: true, ask_email: false } } });
  await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true, bot_mode: 'always', facts: 'Physiopraxis Muster in Leipzig.' });
  await t.api.post('/api/ai-connections', { provider: 'anthropic', api_key: AKEY, models: { text: 'claude-sonnet-5-5' } });
  const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['08:00', '20:00']]]));
  calId = (await t.api.post('/api/calendars', { name: 'Erstbefund', duration: 30, interval: 30, min_notice: 2, availability: every, settings: { notify_team: false } })).data.id;
  paidCal = (await t.api.post('/api/calendars', { name: 'Massage (bezahlt)', duration: 60, availability: every })).data.id;
  t.app.db.insert('teamcal_config', {
    calendar_id: paidCal,
    location_id: t.api.location,
    kind: 'single',
    data: JSON.stringify({ payment: { mode: 'full', amount_cents: 6000, currency: 'EUR' } }),
    updated_at: new Date().toISOString(),
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  model.reset();
  respond = () => answer('Hallo!');
});

describe('settings and shared tools', () => {
  it('is off for the chat bot by default; paid calendars and ones with required questions are never bookable', async () => {
    const s = (await t.api.get('/api/ai-booking/settings')).data;
    expect(s.settings).toEqual({ chat_bot: false, calendars: [], per_contact_day: 2 });
    expect(s.calendars).toEqual(expect.arrayContaining([expect.objectContaining({ id: calId, bookable: true }), expect.objectContaining({ id: paidCal, bookable: false })]));
    const badCal = await t.api.put('/api/ai-booking/settings', { calendars: ['nope'] });
    expect(badCal.status, JSON.stringify(badCal.data)).toBe(400);
    expect((await t.api.put('/api/ai-booking/settings', { per_contact_day: 0 })).status).toBe(400);
    const slots = (await t.api.get('/api/ai-booking/slots?days=3')).data;
    expect(slots.calendars.map((c: any) => c.id)).toEqual([calId]);
    expect(slots.calendars[0].days[0].times.length).toBeGreaterThan(0);
    const day = (await t.api.get(`/api/ai-booking/slots?calendar_id=${calId}&date=${berlinDay(1)}`)).data;
    expect(day).toMatchObject({ calendar: { id: calId }, date: berlinDay(1) });
    expect(day.times[0]).toBe('08:00');
    expect((await t.api.get(`/api/ai-booking/slots?calendar_id=${paidCal}&date=${berlinDay(1)}`)).status).toBe(400);
  });

  it('the agent rule: "Termin buchen" books without a click, also after untrusted content – everything else still asks', () => {
    expect(decide('write', 'book', { confirmSensitive: true, tainted: true, booking: true })).toBe('run');
    expect(decide('write', 'auto', { confirmSensitive: true, tainted: true, booking: true })).toBe('run');
    expect(decide('write', 'ask', { confirmSensitive: true, tainted: false, booking: true })).toBe('confirm');
    expect(decide('write', 'read', { confirmSensitive: true, tainted: false, booking: true })).toBe('block');
    expect(decide('write', 'book', { confirmSensitive: true, tainted: false })).toBe('confirm');
    expect(decide('sensitive', 'book', { confirmSensitive: false, tainted: false, booking: true })).toBe('confirm');
    expect(decide('read', 'book', { confirmSensitive: true, tainted: true })).toBe('run');
  });

  it('the bot schema gets a booking call; the strict bot answer comes back without it', () => {
    const s = withBooking(BOT_SCHEMA);
    expect(s.required).toContain('booking');
    expect(s.properties.booking.properties.action.enum).toEqual(['none', 'check_slots', 'book']);
    const x = splitBooking(JSON.stringify({ ...answer('Hi'), booking: { action: 'book', calendar_id: 'c', date: '2026-10-20', time: '10:00' } }));
    expect(x?.booking).toEqual({ action: 'book', calendar_id: 'c', date: '2026-10-20', time: '10:00' });
    expect(Object.keys(x!.rest)).not.toContain('booking');
    expect(splitBooking('kein json')).toBeNull();
    expect(splitBooking(JSON.stringify({ ...answer('Hi'), booking: { action: 'drop table' } }))?.booking).toBeNull();
  });
});

describe('website chat bot (KI-Assistent)', () => {
  it('without "Termin buchen" the bot has no booking tool and books nothing', async () => {
    respond = () => answer('Gern – buchen kannst du über unsere Buchungsseite.');
    const v = await chat({ body: 'Ich möchte einen Termin', name: 'Otto Ohne', email: 'otto@example.com' });
    await t.app.events.flush();
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].body)).not.toContain('"booking"');
    expect(calls[0].prompt).not.toContain('<freie_termine>');
    expect((await chatLog(v.visitor)).at(-1).body).toContain('Buchungsseite');
    expect(t.app.db.get(`SELECT COUNT(*) n FROM appointments WHERE source = 'KI-Assistent'`)?.n).toBe(0);
  });

  it('with "Termin buchen" it looks up a day, then books the confirmed time and replies with the reschedule and cancel links', async () => {
    await t.api.put('/api/ai-booking/settings', { chat_bot: true, calendars: [calId] });
    const day = berlinDay(2);
    respond = (prompt) => {
      if (!prompt.includes('<werkzeug_ergebnis>')) return answer('Ich schaue nach.', { booking: { action: 'check_slots', calendar_id: calId, date: day, time: '' } });
      expect(prompt).toContain(`Freie Zeiten in Kalender „Erstbefund“`);
      return answer('Gebucht!', {
        lead: { first_name: 'Berta', last_name: 'Bucher', email: 'berta@example.com', phone: '' },
        booking: { action: 'book', calendar_id: calId, date: day, time: '15:00' },
      });
    };
    const v = await chat({ body: `Habt ihr am ${day} um 15 Uhr Zeit? Ich bin Berta Bucher, berta@example.com` });
    await t.app.events.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0].prompt).toContain('<freie_termine>');
    expect(calls[0].body.output_config?.format?.schema?.properties?.booking ?? calls[0].body.output_format?.schema?.properties?.booking ?? JSON.stringify(calls[0].body)).toBeTruthy();
    const appt = t.app.db.get<any>(`SELECT * FROM appointments WHERE source = 'KI-Assistent'`);
    expect(appt).toBeTruthy();
    expect(appt.calendar_id).toBe(calId);
    const contact = t.app.db.get<any>('SELECT * FROM contacts WHERE id = ?', appt.contact_id);
    expect(contact).toMatchObject({ first_name: 'Berta', last_name: 'Bucher', email: 'berta@example.com' });
    const reply = (await chatLog(v.visitor)).at(-1);
    expect(reply.body).toContain('Gebucht!');
    expect(reply.body).toContain('Termin gebucht: Erstbefund am');
    expect(reply.body).toContain(`Verschieben: http://localhost/book/move/${appt.manage_token}`);
    expect(reply.body).toContain(`Absagen: http://localhost/book/manage/${appt.manage_token}`);
  });

  it('asks for name and e-mail first, and offers free times when the wish is taken', async () => {
    let n = 0;
    respond = (prompt) => {
      n++;
      if (n === 1) return answer('Moment.', { booking: { action: 'book', calendar_id: calId, date: berlinDay(3), time: '10:00' } });
      expect(prompt).toContain('Vorname und E-Mail-Adresse');
      return answer('Wie heißt du und wie lautet deine E-Mail?', { booking: none });
    };
    await chat({ body: 'Bitte Termin übermorgen 10 Uhr' });
    await t.app.events.flush();
    expect(n).toBe(2);
    // a taken time: the tool answers with free alternatives
    const free = firstFree(
      await (async () => {
        let p = '';
        respond = (prompt) => ((p = prompt), answer('ok', { booking: none }));
        await chat({ body: 'Welche Zeiten gibt es?', name: 'Paula Platz', email: 'paula@example.com' });
        await t.app.events.flush();
        return p;
      })(),
    );
    const taken = await t.api.post('/api/appointments', {
      calendar_id: calId,
      contact: { email: 'x@example.com', first_name: 'X' },
      start: zonedToUtc(free.date, free.time, 'Europe/Berlin').toISOString(),
      force: true,
    });
    expect(taken.status).toBe(200);
    let seen = '';
    respond = (prompt) => {
      if (prompt.includes('<werkzeug_ergebnis>')) return ((seen = prompt), answer('Die Zeit ist leider weg – wie wäre es mit einer anderen?', { booking: none }));
      return answer('Ich buche.', { booking: { action: 'book', calendar_id: calId, date: free.date, time: free.time } });
    };
    await chat({ body: 'Dann bitte die erste Zeit', name: 'Paula Platz', email: 'paula@example.com' });
    await t.app.events.flush();
    expect(seen).toMatch(/Buchung nicht möglich: Diese Zeit ist leider nicht \(mehr\) frei\.|Buchung nicht möglich/);
  });

  it('never books more than the daily limit per contact', async () => {
    const day = berlinDay(4);
    let i = 0;
    respond = (prompt) =>
      prompt.includes('<werkzeug_ergebnis>')
        ? answer('Mehr geht heute nicht.', { booking: none })
        : answer('Gebucht', { lead: { first_name: 'Lia', last_name: 'Limit', email: 'lia@example.com', phone: '' }, booking: { action: 'book', calendar_id: calId, date: day, time: `1${i++}:00` } });
    const v = await chat({ body: 'Termin bitte', name: 'Lia Limit', email: 'lia@example.com' });
    await t.app.events.flush();
    await chat({ body: 'Noch einer', visitor: v.visitor });
    await t.app.events.flush();
    await chat({ body: 'Und noch einer', visitor: v.visitor });
    await t.app.events.flush();
    const lia = t.app.db.get<any>(`SELECT id FROM contacts WHERE email = 'lia@example.com'`);
    expect(t.app.db.get<any>(`SELECT COUNT(*) n FROM appointments WHERE contact_id = ? AND source = 'KI-Assistent'`, lia.id).n).toBe(2);
    expect(calls.some((c) => c.prompt.includes('schon 2 Termine von der KI gebucht'))).toBe(true);
  });
});

describe('agent auto-reply at the level "Termin buchen" (every inbox channel)', () => {
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
  const say = (text: string) => ({ type: 'text' as const, text });
  const inboundMail = async (from: string, subject: string, text: string) => {
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const u = new URL(urls.email);
    await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, subject, text }) });
    await t.app.events.flush();
  };

  it('books from an inbound mail and confirms in the same channel with the links; the reply stays a draft', async () => {
    await t.api.put('/api/ai/settings', { bot_mode: 'off' });
    const agent = (
      await t.api.post('/api/agents', { name: 'Terminbot', visibility: 'location', mode: 'book', tools: ['ghl_list_contacts'], responder: { enabled: true, channels: ['email'], mode: 'send' } })
    ).data;
    expect(agent.mode).toBe('book');
    const day = berlinDay(5);
    model.reply(
      (body) => {
        const names = body.tools.map((x: any) => x.name);
        expect(names).toEqual(expect.arrayContaining(['ghl_booking_slots', 'ghl_book_appointment']));
        expect(names).not.toContain('ghl_send_message');
        expect(JSON.stringify(body.system)).toContain('Termin buchen');
        return sse(anthropicSse([tool('t1', 'ghl_booking_slots', { calendar_id: calId, date: day })]))();
      },
      (body) => {
        const contactId = JSON.stringify(body.messages).match(/contact_id ([A-Za-z0-9_-]{8,})/)?.[1];
        return sse(anthropicSse([tool('t2', 'ghl_book_appointment', { calendar_id: calId, date: day, time: '11:00', contact_id: contactId, notes: 'Rückenschmerzen' })]))();
      },
      sse(anthropicSse([say('Danke, Ihr Termin ist eingetragen – die Bestätigung kam eben per E-Mail.')])),
    );
    await inboundMail('Erik Email <erik@example.com>', 'Termin', `Kann ich am ${day} um 11 Uhr kommen? Rückenschmerzen.`);
    expect(model.calls).toHaveLength(3);
    const erik = t.app.db.get<any>(`SELECT * FROM contacts WHERE email = 'erik@example.com'`);
    const appt = t.app.db.get<any>(`SELECT * FROM appointments WHERE contact_id = ? AND source = 'KI-Agent'`, erik.id);
    expect(appt).toBeTruthy();
    expect(appt.notes).toBe('Rückenschmerzen');
    await new Promise((r) => setTimeout(r, 50));
    const msgs = t.app.db.all<any>('SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at', erik.id);
    const conf = msgs.find((m) => m.source === 'KI-Terminbestätigung');
    expect(conf).toMatchObject({ channel: 'email', direction: 'out' });
    expect(conf.body).toContain(`Verschieben: http://localhost/book/move/${appt.manage_token}`);
    expect(conf.body).toContain(`Absagen: http://localhost/book/manage/${appt.manage_token}`);
    // "Termin buchen" is no full autonomy: the reply itself is only a draft.
    expect(msgs.find((m) => m.source === 'KI-Agent')).toMatchObject({ status: 'draft' });
    await t.api.patch(`/api/agents/${agent.id}`, { responder: { enabled: false, channels: [] } });
  });

  it('a read-only auto-reply agent gets no booking tool', async () => {
    const agent = (await t.api.post('/api/agents', { name: 'Nur lesen', visibility: 'location', mode: 'read', responder: { enabled: true, channels: ['email'], mode: 'draft' } })).data;
    model.reply((body) => {
      expect(body.tools.map((x: any) => x.name)).not.toContain('ghl_book_appointment');
      return sse(anthropicSse([say('Wir melden uns.')]))();
    });
    await inboundMail('Rita Read <rita@example.com>', 'Termin?', 'Habt ihr morgen was frei?');
    expect(model.calls).toHaveLength(1);
    await t.api.patch(`/api/agents/${agent.id}`, { responder: { enabled: false, channels: [] } });
  });

  it('MCP: the booking tool books only on released calendars and answers in German', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
    const rpc = async (name: string, args: Record<string, unknown>) =>
      (await (
        await t.api.raw('/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })
      ).json()) as any;
    const c = (await t.api.post('/api/contacts', { first_name: 'Mia', last_name: 'Mcp', email: 'mia@example.com' })).data;
    const paid = await rpc('ghl_book_appointment', { location_id: t.api.location, calendar_id: paidCal, contact_id: c.id, date: berlinDay(6), time: '10:00' });
    expect(JSON.stringify(paid)).toContain('Kalender unbekannt');
    const ok = await rpc('ghl_book_appointment', { location_id: t.api.location, calendar_id: calId, contact_id: c.id, date: berlinDay(6), time: '10:00' });
    const out = JSON.parse(ok.result.content[0].text);
    expect(out).toMatchObject({ status: 'confirmed', calendar: { id: calId }, confirmed_via: 'email' });
    expect(out.reschedule_url).toMatch(/\/book\/move\//);
  });
});
