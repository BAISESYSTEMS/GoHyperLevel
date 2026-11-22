import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { berlinDay, startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';
import { BASIC_CATALOG, clientMessage, parseSlot, slotOptions, slotPicker, type A2uiMessage } from '../server/services/a2ui.js';
import { toolPicker } from '../server/modules/a2ui.js';

/**
 * A2UI 1.0 pilot (docs/a2ui.md): the appointment picker as agent-described interface. The messages follow the A2UI 1.0 envelope
 * (createSurface / updateComponents / updateDataModel, action, callAgentFunction → agentFunctionResponse); in the website chat the
 * bot's answer after looking up free times carries the picker, the renderer asks whether a time is still free and books with a
 * click under the AI booking rules; in the assistant the result of ghl_booking_slots shows the picker and the choice goes back
 * to the agent as a message.
 */

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
let t: Awaited<ReturnType<typeof startTestApp>>;
let calId = '';
let respond: (prompt: string) => Record<string, unknown> = () => answer('Hallo!');
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
const none = { action: 'none', calendar_id: '', date: '', time: '' };
const fakeClaude = (async (_url: string, init: any = {}) => {
  const body = JSON.parse(init.body);
  const out = JSON.stringify(respond(body.messages?.[0]?.content ?? ''));
  return new Response(
    JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: out }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

const chat = (body: Record<string, unknown>) =>
  t.api.raw(`/api/public/chat/${t.api.location}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const chatLog = async (visitor: string) => (await (await t.api.raw(`/api/public/chat/${t.api.location}/messages?visitor=${visitor}`)).json()).messages as any[];
const a2 = async (visitor: string, message: unknown) => {
  const r = await t.api.raw(`/api/public/chat/${t.api.location}/a2ui`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitor, message }) });
  return { status: r.status, j: (await r.json()) as any };
};
const surfaceOf = (ui: A2uiMessage[]) => ui.find((m) => m.createSurface)!.createSurface;
const componentsOf = (ui: A2uiMessage[]) => ui.flatMap((m) => m.createSurface?.components ?? m.updateComponents?.components ?? []);
const action = (surfaceId: string, context: Record<string, unknown>) => ({
  version: '1.0',
  action: { name: 'book_slot', surfaceId, sourceComponentId: 'book', timestamp: new Date().toISOString(), context },
});

/** Every message is A2UI 1.0 with one envelope key, there is one root, and every child a component names exists. */
function expectValid(ui: A2uiMessage[]) {
  for (const m of ui) {
    expect(m.version).toBe('1.0');
    expect(Object.keys(m).filter((k) => k !== 'version')).toHaveLength(1);
  }
  const comps = componentsOf(ui);
  const ids = new Set(comps.map((c: any) => c.id));
  expect(comps.filter((c: any) => c.id === 'root')).toHaveLength(1);
  for (const c of comps as any[]) {
    expect(c.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    for (const k of [...(Array.isArray(c.children) ? c.children : []), ...(c.child ? [c.child] : [])]) expect(ids.has(k), `${c.id} → ${k}`).toBe(true);
  }
}

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fakeClaude;
  await t.setup();
  await t.api.patch('/api/location', { settings: { chat: { enabled: true, ask_email: false } } });
  await t.api.put('/api/ai/settings', { api_key: KEY, enabled: true, bot_mode: 'always', facts: 'Physiopraxis.' });
  const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['08:00', '20:00']]]));
  calId = (await t.api.post('/api/calendars', { name: 'Erstbefund', duration: 30, interval: 30, min_notice: 2, availability: every, settings: { notify_team: false } })).data.id;
  await t.api.put('/api/ai-booking/settings', { chat_bot: true, calendars: [calId] });
});
afterAll(async () => {
  await t.close();
});

describe('A2UI messages', () => {
  it('builds a valid A2UI 1.0 appointment picker with the basic catalog', () => {
    const ui = slotPicker({ surfaceId: 'booking_x', calendar: { id: 'c1', name: 'Erstbefund', duration: 30 }, days: [{ date: '2026-11-25', times: ['10:00', '10:30', '11:00'] }], mode: 'book', askName: true, askEmail: true });
    expectValid(ui);
    expect(surfaceOf(ui)).toMatchObject({ surfaceId: 'booking_x', catalogId: BASIC_CATALOG, dataModel: { slot: [] } });
    const picker: any = componentsOf(ui).find((c: any) => c.component === 'ChoicePicker');
    expect(picker.options[0]).toEqual({ label: 'Mi. 25.11. · 10:00', value: '2026-11-25T10:00' });
    expect(picker.value).toEqual({ '@path': '/slot' });
    expect(componentsOf(ui).map((c: any) => c.id)).toEqual(expect.arrayContaining(['name', 'email', 'book', 'status']));
    const btn: any = componentsOf(ui).find((c: any) => c.component === 'Button');
    expect(btn.action.event).toMatchObject({ name: 'book_slot', context: { slot: { '@path': '/slot' } } });
  });

  it('spreads the options over the days and reads slots and client messages strictly', () => {
    const opts = slotOptions([{ date: '2026-11-25', times: ['08:00', '08:30', '09:00', '09:30', '10:00'] }, { date: '2026-11-26', times: ['08:00', '09:00'] }], 6);
    expect(opts.filter((o) => o.value.startsWith('2026-11-26'))).toHaveLength(2);
    expect(parseSlot(['2026-11-25T10:00'])).toEqual({ date: '2026-11-25', time: '10:00' });
    expect(parseSlot('morgen')).toBeNull();
    expect(clientMessage({ version: '1.0', action: { name: 'x', surfaceId: 's' } })?.kind).toBe('action');
    expect(clientMessage({ version: '0.9', action: { name: 'x', surfaceId: 's' } })).toBeNull();
    expect(clientMessage({ version: '1.0', action: { name: 'x', surfaceId: 's' }, callAgentFunction: {} })).toBeNull();
    expect(clientMessage({ version: '1.0', callAgentFunction: { surfaceId: 's', functionCallId: 'c1' } })?.kind).toBe('call');
  });

  it('turns a result of ghl_booking_slots into a picker for the assistant that hands the choice back to the agent', () => {
    const ui = toolPicker('ghl_booking_slots', { calendar: { id: 'c1', name: 'Erstbefund', duration: 30 }, date: '2026-11-25', times: ['10:00'], next: [] })!;
    expectValid(ui);
    const btn: any = componentsOf(ui).find((c: any) => c.component === 'Button');
    expect(btn.action.event).toMatchObject({ name: 'choose_slot', context: { calendar: 'Erstbefund' } });
    expect(componentsOf(ui).some((c: any) => c.component === 'TextField')).toBe(false);
    expect(toolPicker('ghl_booking_slots', { calendars: [{ id: 'c1', name: 'X', days: [{ date: '2026-11-25', times: ['09:00'] }] }] })).toBeTruthy();
    expect(toolPicker('ghl_booking_slots', { calendars: [] })).toBeNull();
    expect(toolPicker('ghl_list_projects', { calendars: [] })).toBeNull();
  });

  it('the renderer script loads and registers HLA2UI', () => {
    const src = readFileSync(new URL('../web/public/a2ui-renderer.js', import.meta.url), 'utf8');
    const win: any = {};
    runInNewContext(src, { window: win, document: {}, Promise, JSON, Object, Array, String, Date });
    expect(win.HLA2UI?.version).toBe('1.0');
    expect(typeof win.HLA2UI.mount).toBe('function');
  });
});

describe('appointment picker in the website chat', () => {
  let visitor = '';
  let ui: A2uiMessage[] = [];
  let surfaceId = '';
  const day = berlinDay(2);

  it('puts the picker under the bot answer after it looked up free times', async () => {
    respond = (prompt) =>
      prompt.includes('<werkzeug_ergebnis>') ? answer('Diese Zeiten sind frei – tipp einfach eine an.', { booking: none }) : answer('Ich schaue nach.', { booking: { action: 'check_slots', calendar_id: calId, date: day, time: '' } });
    visitor = (await chat({ body: 'Habt ihr übermorgen Zeit?' })).visitor;
    await t.app.events.flush();
    const log = await chatLog(visitor);
    const bot = log.at(-1);
    expect(bot.body).toContain('tipp einfach eine an');
    expect(bot.id).toBeUndefined();
    ui = bot.ui;
    expectValid(ui);
    surfaceId = surfaceOf(ui).surfaceId;
    const picker: any = componentsOf(ui).find((c: any) => c.component === 'ChoicePicker');
    expect(picker.options[0].value).toBe(`${day}T08:00`);
    // the visitor has no name and e-mail yet: the picker asks for both
    expect(componentsOf(ui).map((c: any) => c.id)).toEqual(expect.arrayContaining(['name', 'email']));
  });

  it('answers callAgentFunction checkSlot: free or taken', async () => {
    const call = (slot: string) => ({ version: '1.0', callAgentFunction: { surfaceId, functionCallId: 'call_1', callFunction: { '@call': 'checkSlot', catalogId: 'hyperlevel:booking', args: { slot: [slot] } } } });
    const free = await a2(visitor, call(`${day}T08:00`));
    expect(free.j.message).toMatchObject({ version: '1.0', agentFunctionResponse: { functionCallId: 'call_1', value: { available: true } } });
    const night = await a2(visitor, call(`${day}T03:00`));
    expect(night.j.message.agentFunctionResponse.value.available).toBe(false);
    const unknown = await a2(visitor, { version: '1.0', callAgentFunction: { surfaceId, functionCallId: 'c2', callFunction: { '@call': 'deleteAll' } } });
    expect(unknown.j.message.agentFunctionResponse.error.code).toBe('INVALID_FUNCTION_CALL');
  });

  it('asks for what is missing, then books with one click and turns into the confirmation', async () => {
    const noSlot = await a2(visitor, action(surfaceId, { calendar_id: calId, slot: [], name: '', email: '' }));
    expect(noSlot.j.messages[0].updateDataModel).toMatchObject({ surfaceId, path: '/status', value: 'Bitte zuerst eine Zeit wählen.' });
    const noName = await a2(visitor, action(surfaceId, { calendar_id: calId, slot: [`${day}T08:00`], name: '', email: 'x@example.com' }));
    expect(noName.j.messages[0].updateDataModel.value).toMatch(/Namen/);
    const ok = await a2(visitor, action(surfaceId, { calendar_id: calId, slot: [`${day}T08:00`], name: 'Karla Klick', email: 'karla@example.com' }));
    expect(ok.status).toBe(200);
    expect(ok.j.messages[0].updateComponents.components.find((c: any) => c.id === 'done').text).toContain('Gebucht: Erstbefund');
    const appt = t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', ok.j.appointment_id);
    expect(appt).toMatchObject({ calendar_id: calId, source: 'KI-Assistent' });
    expect(t.app.db.get<any>('SELECT * FROM contacts WHERE id = ?', appt.contact_id)).toMatchObject({ first_name: 'Karla', last_name: 'Klick', email: 'karla@example.com' });
    const log = await chatLog(visitor);
    expect(log.some((m) => m.direction === 'in' && m.body.startsWith('Termin gewählt: Erstbefund'))).toBe(true);
    expect(log.at(-1).body).toContain(`Verschieben: http://localhost/book/move/${appt.manage_token}`);
    // a reload shows the booked state; a second click books nothing
    const again = (await chatLog(visitor)).find((m) => m.ui)!.ui as A2uiMessage[];
    expect(componentsOf(again).some((c: any) => c.id === 'done')).toBe(true);
    const twice = await a2(visitor, action(surfaceId, { calendar_id: calId, slot: [`${day}T08:30`], name: 'Karla Klick', email: 'karla@example.com' }));
    expect(twice.j.messages[0].updateDataModel.value).toMatch(/schon gebucht/);
    expect(t.app.db.get<any>(`SELECT COUNT(*) n FROM appointments WHERE contact_id = ?`, appt.contact_id).n).toBe(1);
  });

  it('keeps surfaces to their visitor and refuses broken messages', async () => {
    const other = (await chat({ body: 'Hallo', name: 'Fremd', email: 'fremd@example.com' })).visitor;
    await t.app.events.flush();
    expect((await a2(other, action(surfaceId, { slot: [`${day}T09:00`] }))).status).toBe(404);
    expect((await a2('nope', action(surfaceId, { slot: [`${day}T09:00`] }))).status).toBe(404);
    expect((await a2(visitor, { version: '1.0', render: {} })).status).toBe(400);
    expect((await a2(visitor, { action: { name: 'book_slot', surfaceId } })).status).toBe(400);
  });
});
