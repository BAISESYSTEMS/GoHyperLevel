import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { anthropicSse, events, fakeModel, sse } from './agent-fakes.js';
import { retry } from '../server/services/agent-llm.js';
import { COMPANION_TOOLS } from '../server/modules/companion.js';
import { classify, routeProblem } from '../server/services/agent-safety.js';
import { briefingSig, nextSteps, rankHotspots, rulesSay, type Hotspot } from '../server/services/briefing.js';
import { checkinDue, cleanPrefs, defaultCheckin, defaultPrefs, inQuiet, nextCheckin, wakePhraseFor, withPrefDefaults, type CheckinPrefs } from '../server/services/companion-prefs.js';
import { findWake } from '../web/src/companion/wake.js';

/**
 * Fokus-Modus mit Companion: settings, the wake word matcher, the briefing ("Was brennt?") read with the viewer's rights, the
 * proactive check-ins' scheduler (intervals, fixed times in a time zone, quiet hours, weekdays, "only when something changed"),
 * the MCP tool and that none of it writes CRM data. The model and push are faked.
 */

const ci = (p: Partial<CheckinPrefs>): CheckinPrefs => ({ ...defaultCheckin(), ...p });
const at = (iso: string) => new Date(iso);

describe('check-in schedule (pure)', () => {
  it('interval: the first one comes at once, the next after the interval – never in the quiet hours', () => {
    const c = ci({ mode: 'interval', minutes: 30 });
    // 10:00 Berlin (summer: UTC+2)
    expect(checkinDue(c, { now: at('2026-07-14T08:00:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(true);
    expect(checkinDue(c, { now: at('2026-07-14T08:20:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-14T08:00:00Z' }).due).toBe(false);
    expect(checkinDue(c, { now: at('2026-07-14T08:30:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-14T08:00:00Z' }).due).toBe(true);
    // 22:30 Berlin and 06:00 Berlin are inside 20:00–08:00
    expect(checkinDue(c, { now: at('2026-07-14T20:30:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(false);
    expect(checkinDue(c, { now: at('2026-07-15T04:00:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(false);
    expect(checkinDue(c, { now: at('2026-07-15T06:05:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(true);
    // the same instant is quiet in Berlin but not in New York (16:30 there)
    expect(checkinDue(c, { now: at('2026-07-14T20:30:00Z'), tz: 'America/New_York', lastAt: null }).due).toBe(true);
    expect(inQuiet('21:00', '20:00', '08:00')).toBe(true);
    expect(inQuiet('12:00', '12:00', '12:00')).toBe(false);
    expect(inQuiet('13:30', '13:00', '14:00')).toBe(true);
  });

  it('daily: each fixed time once, in the person’s time zone, within the grace window; weekdays only skips the weekend', () => {
    const c = ci({ mode: 'daily', times: ['08:30', '17:00'] });
    // 08:29 Berlin – not yet; 08:31 – due; after it ran – not again; 17:05 – the second slot
    expect(checkinDue(c, { now: at('2026-07-14T06:29:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(false);
    const first = checkinDue(c, { now: at('2026-07-14T06:31:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-13T15:00:00Z' });
    expect(first).toEqual({ due: true, slot: 'd:2026-07-14T08:30' });
    expect(checkinDue(c, { now: at('2026-07-14T07:10:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-14T06:31:00Z' }).due).toBe(false);
    expect(checkinDue(c, { now: at('2026-07-14T15:05:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-14T06:31:00Z' })).toEqual({ due: true, slot: 'd:2026-07-14T17:00' });
    // three hours late (server down): skipped instead of arriving at lunch
    expect(checkinDue(c, { now: at('2026-07-14T09:40:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-13T15:00:00Z' }).due).toBe(false);
    // 08:30 in New York is 12:30 UTC
    expect(checkinDue(ci({ mode: 'daily', times: ['08:30'] }), { now: at('2026-07-14T12:31:00Z'), tz: 'America/New_York', lastAt: null }).due).toBe(true);
    expect(checkinDue(ci({ mode: 'daily', times: ['08:30'] }), { now: at('2026-07-14T06:31:00Z'), tz: 'America/New_York', lastAt: null }).due).toBe(false);
    // fixed times ignore the quiet hours (they are deliberate)
    expect(checkinDue(ci({ mode: 'daily', times: ['21:00'] }), { now: at('2026-07-14T19:01:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(true);
    // 2026-07-18 is a Saturday
    const weekdays = ci({ mode: 'daily', times: ['08:30'], weekdays_only: true });
    expect(checkinDue(weekdays, { now: at('2026-07-18T06:31:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(false);
    expect(checkinDue(weekdays, { now: at('2026-07-17T06:31:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(true);
    expect(checkinDue(ci({ mode: 'off' }), { now: at('2026-07-17T06:31:00Z'), tz: 'Europe/Berlin', lastAt: null }).due).toBe(false);
  });

  it('names the next check-in for the settings', () => {
    const next = nextCheckin(ci({ mode: 'daily', times: ['08:30'], weekdays_only: true }), { now: at('2026-07-17T07:00:00Z'), tz: 'Europe/Berlin', lastAt: null });
    // Friday 09:00 Berlin → Monday 08:30
    expect(next?.toISOString()).toBe('2026-07-20T06:30:00.000Z');
    const inQuietHours = nextCheckin(ci({ mode: 'interval', minutes: 60 }), { now: at('2026-07-14T20:30:00Z'), tz: 'Europe/Berlin', lastAt: '2026-07-14T17:00:00Z' });
    expect(inQuietHours?.toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(nextCheckin(ci({ mode: 'off' }), { now: new Date(), tz: 'Europe/Berlin', lastAt: null })).toBeNull();
  });
});

describe('settings (pure)', () => {
  it('validates a patch and keeps stored data in bounds', () => {
    const cur = defaultPrefs();
    expect(cleanPrefs({ checkin: { mode: 'interval', minutes: 45 } }, cur).checkin).toMatchObject({ mode: 'interval', minutes: 45 });
    expect(() => cleanPrefs({ checkin: { minutes: 2 } }, cur)).toThrow(/5 bis 1440/);
    expect(() => cleanPrefs({ checkin: { times: ['25:00'] } }, cur)).toThrow(/HH:MM/);
    expect(() => cleanPrefs({ checkin: { times: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00'] } }, cur)).toThrow(/Höchstens 6/);
    expect(cleanPrefs({ checkin: { times: ['17:00', '08:30', '08:30'] } }, cur).checkin.times).toEqual(['08:30', '17:00']);
    expect(() => cleanPrefs({ tz: 'Mars/Olympus' }, cur)).toThrow(/Zeitzone/);
    expect(() => cleanPrefs({ wake_phrase: 'He' }, cur)).toThrow(/zu kurz/);
    expect(() => cleanPrefs({ agent_id: '../x' }, cur)).toThrow();
    expect(cleanPrefs({ name: '  <b>Max</b>\n ', read_aloud: true }, cur)).toMatchObject({ name: 'b Max /b', read_aloud: true });
    expect(withPrefDefaults({ checkin: { mode: 'hourly', minutes: 99999, quiet_from: 'x' }, shortcut: 'yes', tz: 'Nope/Nope' })).toMatchObject({ shortcut: true, tz: '', checkin: { mode: 'off', minutes: 60, quiet_from: '20:00' } });
    expect(wakePhraseFor('Jarvis')).toBe('Hey Jarvis');
  });
});

describe('wake word matcher', () => {
  it('finds the phrase with the usual greetings and small misrecognitions, and returns the command after it', () => {
    expect(findWake('Hey Jarvis, was brennt gerade?', 'Hey Jarvis')).toEqual({ rest: 'was brennt gerade?' });
    expect(findWake('ok jarvis schick Anna eine Erinnerung', 'Hey Jarvis')?.rest).toBe('schick Anna eine Erinnerung');
    expect(findWake('hallo javis', 'Hey Jarvis')).toEqual({ rest: '' });
    expect(findWake('und dann sagte er hey Charvis', 'Hey Jarvis')).toEqual({ rest: '' });
    expect(findWake('Jarvis ist ein Film', 'Hey Jarvis')).toBeNull();
    expect(findWake('hey Jürgen', 'Hey Jarvis')).toBeNull();
    // short names must match exactly
    expect(findWake('hey Mia, Termine heute', 'Hey Mia')?.rest).toBe('Termine heute');
    expect(findWake('hey Mira', 'Hey Mia')).toBeNull();
    expect(findWake('Computer, Lagebericht', 'Computer')?.rest).toBe('Lagebericht');
  });
});

const hs = (key: string, score: number, step?: string): Hotspot => ({ key, title: key, detail: '', count: 1, score, url: key, sig: key, ...(step ? { step: { key: step, label: `Schritt ${step}`, prompt: 'x' } } : {}) });

describe('briefing ranking (pure)', () => {
  it('keeps the five most urgent, steps from the top ones without repeats, and says it in one breath', () => {
    const ranked = rankHotspots([hs('a', 30), hs('b', 80, 's1'), hs('c', 50, 's2'), hs('d', 50, 's1'), hs('e', 10), hs('f', 60, 's3'), { ...hs('zero', 99), count: 0 }]);
    expect(ranked.map((h) => h.key)).toEqual(['b', 'f', 'c', 'd', 'a']);
    expect(nextSteps(ranked).map((s) => s.key)).toEqual(['s1', 's3', 's2']);
    expect(briefingSig(ranked)).toBe('b=b|f=f|c=c|d=d|a=a');
    expect(rulesSay(ranked.slice(0, 2), nextSteps(ranked), { lang: 'de', hm: '08:10', name: 'Clara' })).toBe('Guten Morgen, Clara. 2 Sachen brauchen dich: b und f. Mein Vorschlag: Schritt s1.');
    expect(rulesSay([], [], { lang: 'en', hm: '19:00' })).toMatch(/^Good evening\. Nothing is burning/);
  });
});

// --- the app -------------------------------------------------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let A = '';
let B = '';
let me = '';
let member: Call;
let noMoney: Call;
let pushes: any[] = [];
let answers: (object | string)[] = [];
let aiCalls: any[] = [];
let aiOn = false;

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString();
const crmCount = () => t.app.db.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM opportunities) + (SELECT COUNT(*) FROM contacts) + (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM audit_log) AS n')!.n;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  A = t.api.location;
  me = t.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'chef@example.com'")!.id;
  B = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  t.app.services.pushNotify = async (p: any) => {
    pushes.push(p);
    return { users: 1, sent: 1, failed: 0, removed: 0 };
  };
  const realReady = t.app.services.aiReady;
  t.app.services.aiReady = (loc: string) => (aiOn ? null : realReady(loc));
  t.app.services.aiRun = async (input: any) => {
    aiCalls.push(input);
    t.app.db.insert('ai_calls', { id: `c${Math.random()}`, location_id: input.locationId, purpose: input.purpose, model: 'm', status: 'ok', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 0, ms: 1, user_id: input.userId, error: '', created_at: new Date().toISOString() });
    const next = answers.shift();
    if (next === undefined) throw new Error('keine Antwort vorbereitet');
    return { text: typeof next === 'string' ? next : JSON.stringify(next), model: 'fake', stopReason: 'end', usage: {}, ms: 1, costMicros: 0 };
  };
  // A: an overdue task of mine, an overdue invoice, an unread conversation, a deal untouched for a month
  const contact = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Müller', email: 'anna@example.com' })).data;
  const task = await t.api.post('/api/tasks', { title: 'Angebot nachfassen', due_at: day(-3), contact_id: contact.id });
  expect(task.status, JSON.stringify(task.data)).toBe(200);
  const inv = (await t.api.post('/api/invoices', { contact_id: contact.id, items: [{ name: 'Beratung', qty: 1, price_cents: 120000, tax_rate: 0 }] })).data;
  t.app.db.run("UPDATE invoices SET status = 'sent', number = 'RE-1001', due_at = ? WHERE id = ?", day(-12).slice(0, 10), inv.id);
  t.app.db.insert('conversations', { id: 'conv-a', location_id: A, contact_id: contact.id, unread: 2, last_message: 'Wann kommt das Angebot?', last_message_at: day(-1.5), created_at: day(-2) });
  const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: [{ name: 'Neu' }] })).data;
  const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, name: 'Website-Relaunch', value: 8000, contact_id: contact.id })).data;
  t.app.db.run('UPDATE opportunities SET updated_at = ?, stage_changed_at = ? WHERE id = ?', day(-30), day(-30), deal.id);
  // B: only a deal
  const pipeB = (await t.api.post('/api/pipelines', { name: 'B', stages: [{ name: 'Neu' }] }, { 'x-location-id': B })).data;
  const dealB = (await t.api.post('/api/opportunities', { pipeline_id: pipeB.id, name: 'Beta-Geheim-Deal', value: 5000, contact: { email: 'b@example.com', first_name: 'Bert' } }, { 'x-location-id': B })).data;
  t.app.db.run('UPDATE opportunities SET updated_at = ?, stage_changed_at = ? WHERE id = ?', day(-30), day(-30), dealB.id);
  await t.api.post('/api/users', { email: 'nur-a@example.com', name: 'Mia Member', password: 'passwort-12345', role: 'member', locations: [A], permissions: null });
  member = client(t.base, { 'x-pghl': '1' });
  await member('POST', '/api/auth/login', { email: 'nur-a@example.com', password: 'passwort-12345' });
  await t.api.post('/api/users', { email: 'ohne-geld@example.com', name: 'Otto Kontakte', password: 'passwort-12345', role: 'member', locations: [A], permissions: ['contacts', 'conversations', 'dashboard'] });
  noMoney = client(t.base, { 'x-pghl': '1' });
  await noMoney('POST', '/api/auth/login', { email: 'ohne-geld@example.com', password: 'passwort-12345' });
}, 60_000);
afterAll(() => t.close());
beforeEach(() => {
  pushes = [];
  answers = [];
  aiCalls = [];
  aiOn = false;
});

describe('settings per person and sub-account', () => {
  it('starts as Jarvis with the HyperLevel Agent, saves choices and refuses foreign agents', async () => {
    const r = await t.api.get('/api/companion/prefs');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ name: 'Jarvis', wake_phrase: 'Hey Jarvis', agent: { id: null, name: 'HyperLevel Agent' }, prefs: { checkin: { mode: 'off', quiet_from: '20:00', quiet_to: '08:00', only_changed: true } } });
    expect((await t.api.put('/api/companion/prefs', { name: 'Friday', wake_phrase: '' })).data).toMatchObject({ name: 'Friday', wake_phrase: 'Hey Friday' });
    expect((await t.api.put('/api/companion/prefs', { checkin: { minutes: 1 } })).status).toBe(400);
    expect((await t.api.put('/api/companion/prefs', { agent_id: 'gibt-es-nicht' })).status).toBe(404);
    // somebody's private agent is not mine to pick
    const priv = (await member('POST', '/api/agents', { name: 'Mias Privat', instructions: 'x' }, { 'x-location-id': A })).data;
    expect((await t.api.put('/api/companion/prefs', { agent_id: priv.id })).status).toBe(404);
    // my own agent answers – and names the companion unless I name it myself
    const mine = (await t.api.post('/api/agents', { name: 'Vertriebs-Ass', emoji: '🦊' })).data;
    const set = await t.api.put('/api/companion/prefs', { agent_id: mine.id, name: '' });
    expect(set.data).toMatchObject({ name: 'Vertriebs-Ass', agent: { id: mine.id, emoji: '🦊' }, wake_phrase: 'Hey Vertriebs-Ass' });
    // settings are per sub-account
    expect((await t.api.get('/api/companion/prefs', { 'x-location-id': B })).data.name).toBe('Jarvis');
    await t.api.put('/api/companion/prefs', { agent_id: null, name: '' });
    // a sub-account API key has no person
    const key = (await t.api.post('/api/api-keys', { name: 'K' })).data.key;
    const viaKey = await t.api.raw('/api/companion/prefs', { headers: { authorization: `Bearer ${key}` } });
    expect(viaKey.status).toBe(403);
  });

  it('teaches the agent its companion role only in focus-mode runs', () => {
    const extras = (t.app.services.agentPromptExtras as ((i: any) => string)[]).map((f) => f({ user: { id: me, name: 'Chef', role: 'admin', locations: [] }, locationId: A, automatic: false, source: 'focus' })).join('\n');
    expect(extras).toContain('Fokus-Modus mit Companion');
    expect(extras).toContain('„Jarvis“');
    expect(extras).toContain('keine Bestätigung');
    const chat = (t.app.services.agentPromptExtras as ((i: any) => string)[]).map((f) => f({ user: { id: me, name: 'Chef', role: 'admin', locations: [] }, locationId: A, automatic: false, source: 'chat' })).join('\n');
    expect(chat).not.toContain('Fokus-Modus mit Companion');
  });
});

describe('GET /api/companion/briefing ("Was brennt?")', () => {
  it('ranks what burns from the viewer’s own data, with steps for the agent and live tiles – without AI', async () => {
    const before = crmCount();
    const r = await t.api.get('/api/companion/briefing');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.source).toBe('rules');
    const keys = r.data.hotspots.map((h: any) => h.key);
    expect(keys).toEqual(expect.arrayContaining(['overdue_tasks', 'overdue_invoices', 'inbox', 'deals']));
    expect(r.data.hotspots.length).toBeLessThanOrEqual(5);
    const inv = r.data.hotspots.find((h: any) => h.key === 'overdue_invoices');
    expect(inv.title).toContain('1.200');
    expect(inv.detail).toContain('RE-1001');
    expect(r.data.hotspots.find((h: any) => h.key === 'deals').detail).toContain('Website-Relaunch');
    expect(r.data.hotspots.find((h: any) => h.key === 'inbox').detail).toContain('Anna Müller');
    expect(r.data.next.length).toBeGreaterThan(0);
    expect(r.data.next.length).toBeLessThanOrEqual(3);
    // the step names Anna for people; the agent gets the record as its selected entity – third-party text never enters the prompt
    const reply = r.data.next.find((s: any) => s.entity?.type === 'conversation');
    expect(reply).toMatchObject({ label: 'Anna Müller antworten', entity: { id: 'conv-a', label: 'Anna Müller' } });
    for (const s of r.data.next) expect(s.prompt ?? '', s.key).not.toMatch(/Anna|Müller|Angebot nachfassen|Website-Relaunch/);
    expect(r.data.say).toMatch(/Sachen brauchen dich/);
    expect(r.data.tiles.length).toBeGreaterThan(0);
    for (const x of r.data.tiles) expect(x.data.view.kind, x.type).toBeTruthy();
    expect(JSON.stringify(r.data)).not.toContain('Beta-Geheim-Deal');
    expect(crmCount()).toBe(before);
    expect(aiCalls).toHaveLength(0);
  });

  it('only shows what the person may open, and never another sub-account', async () => {
    const r = await noMoney('GET', '/api/companion/briefing', undefined, { 'x-location-id': A });
    expect(r.status).toBe(200);
    const keys = r.data.hotspots.map((h: any) => h.key);
    expect(keys).not.toContain('overdue_invoices');
    expect(keys).not.toContain('deals');
    expect(keys).toContain('inbox');
    expect(r.text).not.toContain('RE-1001');
    expect(r.text).not.toContain('Website-Relaunch');
    expect((await member('GET', '/api/companion/briefing', undefined, { 'x-location-id': B })).status).toBe(403);
    const inB = await t.api.get('/api/companion/briefing', { 'x-location-id': B });
    expect(inB.data.hotspots.map((h: any) => h.key)).toEqual(['deals']);
    expect(JSON.stringify(inB.data)).not.toContain('Website-Relaunch');
  });

  it('lets the model phrase the mentor sentence – never with a number it made up – and caps it per day', async () => {
    aiOn = true;
    answers.push({ say: 'Du hast 99 Probleme, fang mit Anna an.', tip: '' });
    const invented = await t.api.get('/api/companion/briefing');
    expect(invented.data.source).toBe('rules');
    expect(invented.data.say).not.toContain('99');
    answers.push({ say: 'Anna Müller wartet seit gestern – antworte ihr zuerst, dann die Rechnung RE-1001.', tip: 'Ein fester Nachfass-Tag pro Woche hält die Pipeline warm.' });
    const ok = await t.api.get('/api/companion/briefing');
    expect(ok.data).toMatchObject({ source: 'ai', tip: 'Ein fester Nachfass-Tag pro Woche hält die Pipeline warm.' });
    expect(aiCalls.at(-1)).toMatchObject({ purpose: 'companion', userId: me });
    expect(aiCalls.at(-1).system[0].text).toContain('NIEMALS Zahlen');
    // rules only on request, and over the daily cap
    await t.api.get('/api/companion/briefing?rules=1');
    expect(aiCalls).toHaveLength(2);
    for (let i = 0; i < 24; i++) t.app.db.insert('ai_calls', { id: `cap${i}`, location_id: A, purpose: 'companion', model: 'm', status: 'ok', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 0, ms: 1, user_id: me, error: '', created_at: new Date().toISOString() });
    expect((await t.api.get('/api/companion/briefing')).data.source).toBe('rules');
    expect(aiCalls).toHaveLength(2);
    t.app.db.run("DELETE FROM ai_calls WHERE purpose = 'companion'");
  });
});

describe('proactive check-ins', () => {
  const runDue = (iso: string) => t.app.services.companion.runDue(new Date(iso)) as Promise<number>;
  const checkins = () => t.app.db.all<any>('SELECT * FROM companion_checkins WHERE user_id = ? ORDER BY created_at', me);

  it('sends one when due, waits out the interval, skips an unchanged one and respects the quiet hours', async () => {
    t.app.db.run('DELETE FROM companion_checkins');
    await t.api.put('/api/companion/prefs', { tz: 'Europe/Berlin', checkin: { mode: 'interval', minutes: 60, only_changed: true } });
    const before = crmCount();
    // 10:00 Berlin
    expect(await runDue('2026-07-14T08:00:00Z')).toBe(1);
    expect(checkins()).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ kind: 'checkin', userIds: [me], locationId: A });
    expect(pushes[0].url).toMatch(/^\/app\/focus\?checkin=/);
    expect(pushes[0].title).toMatch(/^Jarvis: \d Sachen brauchen dich$/);
    // 20 minutes later: not yet
    expect(await runDue('2026-07-14T08:20:00Z')).toBe(0);
    // an hour later, nothing changed: no check-in (and no push)
    expect(await runDue('2026-07-14T09:01:00Z')).toBe(0);
    expect(pushes).toHaveLength(1);
    // something new burns → the next interval brings it
    await t.api.post('/api/tasks', { title: 'Steuerberater anrufen', due_at: day(-1) });
    expect(await runDue('2026-07-14T10:02:00Z')).toBe(1);
    // 23:00 Berlin: quiet hours
    const contact = (await t.api.post('/api/contacts', { first_name: 'Nacht', email: 'nacht@example.com' })).data;
    t.app.db.insert('conversations', { id: 'conv-night', location_id: A, contact_id: contact.id, unread: 1, last_message: 'Hallo?', last_message_at: day(-3), created_at: day(-3) });
    expect(await runDue('2026-07-14T21:00:00Z')).toBe(0);
    expect(checkins()).toHaveLength(2);
    // no CRM data was written by any of it: only the test's own task and contact (each with its audit entry)
    expect(crmCount()).toBe(before + 4);
    t.app.db.run("DELETE FROM conversations WHERE id = 'conv-night'");
  });

  it('fixed times: once per slot in the person’s time zone; weekdays only', async () => {
    t.app.db.run('DELETE FROM companion_checkins');
    t.app.db.run('UPDATE companion_prefs SET last_eval_at = NULL, last_sig = ? WHERE user_id = ?', '', me);
    await t.api.put('/api/companion/prefs', { tz: 'America/New_York', checkin: { mode: 'daily', times: ['08:30'], weekdays_only: true, only_changed: false } });
    // 08:30 Berlin is 02:30 in New York: nothing
    expect(await runDue('2026-07-14T06:31:00Z')).toBe(0);
    // 08:31 New York
    expect(await runDue('2026-07-14T12:31:00Z')).toBe(1);
    expect(await runDue('2026-07-14T12:45:00Z')).toBe(0);
    // Saturday 08:31 New York
    expect(await runDue('2026-07-18T12:31:00Z')).toBe(0);
    expect(checkins()).toHaveLength(1);
  });

  it('lists, opens (tiles read again) and marks check-ins; "Jetzt ausprobieren" stores one at once; others cannot see them', async () => {
    const list = await t.api.get('/api/companion/checkins?unseen=1');
    expect(list.data.length).toBeGreaterThan(0);
    const one = await t.api.get(`/api/companion/checkins/${list.data[0].id}`);
    expect(one.data.hotspots.length).toBeGreaterThan(0);
    expect(one.data.tiles.length).toBeGreaterThan(0);
    expect((await member('GET', `/api/companion/checkins/${list.data[0].id}`, undefined, { 'x-location-id': A })).status).toBe(404);
    await t.api.post(`/api/companion/checkins/${list.data[0].id}/seen`);
    expect((await t.api.get('/api/companion/checkins?unseen=1')).data.some((x: any) => x.id === list.data[0].id)).toBe(false);
    const tried = await t.api.post('/api/companion/checkins/run', {});
    expect(tried.status, JSON.stringify(tried.data)).toBe(200);
    expect(tried.data).toMatchObject({ kind: 'manual' });
    expect(pushes.some((p) => p.url === `/app/focus?checkin=${tried.data.id}`)).toBe(true);
    expect((await t.api.get('/api/companion/prefs')).data.unseen).toBeGreaterThan(0);
    await t.api.put('/api/companion/prefs', { checkin: { mode: 'off' } });
  });
});

describe('MCP tool ghl_briefing', () => {
  let keyA = '';
  let id = 0;
  const mcp = async (name: string, args: any, key: string) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data };
  };
  beforeAll(async () => {
    keyA = (await t.api.post('/api/api-keys', { name: 'Briefing A' })).data.key;
  });

  it('is read-only and reads through GET', () => {
    const tool = COMPANION_TOOLS[0];
    expect(tool.name).toBe('ghl_briefing');
    expect(classify(tool)).toBe('read');
    expect(routeProblem('GET', '/api/companion/briefing?rules=1', 'read')).toBeNull();
  });

  it('returns the hotspots and next steps of the key’s sub-account – and nothing of another', async () => {
    const before = crmCount();
    const r = await mcp('ghl_briefing', { location_id: A }, keyA);
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ source: 'rules', link: '/app/focus' });
    expect(r.data.hotspots.map((h: any) => h.key)).toEqual(expect.arrayContaining(['overdue_invoices', 'inbox', 'deals']));
    expect(r.data.hotspots[0].link).toMatch(/^\/app\//);
    const other = await mcp('ghl_briefing', { location_id: B }, keyA);
    expect(other.isError).toBe(true);
    expect(crmCount()).toBe(before);
  });
});

describe('the agent in focus mode', () => {
  const model = fakeModel();
  it('runs as source "focus" with the companion prompt; a send waits for the card – a following "ja" is never a confirmation', async () => {
    retry.ms = 1;
    t.app.services.agentFetch = model.fetch;
    expect((await t.api.post('/api/ai-connections', { provider: 'anthropic', api_key: 'sk-ant-api03-companiontest-abcdefghijklmnopqrstuvwxyz', models: { text: 'claude-sonnet-5-5' } })).status).toBe(200);
    const anna = t.app.db.get<{ id: string }>("SELECT id FROM contacts WHERE email = 'anna@example.com'")!.id;
    const sent = () => t.app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'out'", anna)!.n;
    model.reply(sse(anthropicSse([{ type: 'text', text: 'Ich schreibe Anna.' }, { type: 'tool_use', id: 'tu_s', name: 'ghl_send_message', input: { contact_id: anna, channel: 'email', subject: 'Angebot', body: 'Kommt morgen.' } }])));
    const r = await t.api.post('/api/agent/chat', { message: 'Schreib Anna, dass das Angebot morgen kommt', source: 'focus' });
    const ev = events(r.data);
    const card = ev.find((e) => e.type === 'confirm');
    expect(card).toMatchObject({ tool: 'ghl_send_message', klass: 'sensitive' });
    expect(ev.find((e) => e.type === 'done')).toMatchObject({ status: 'awaiting' });
    expect(sent()).toBe(0);
    const conv = t.app.db.get<any>('SELECT * FROM agent_conversations WHERE id = ?', card.conversation_id ?? ev.find((e) => e.type === 'start').conversation_id);
    expect(conv.source).toBe('focus');
    expect(JSON.stringify(model.calls[0].body.system)).toContain('Fokus-Modus mit Companion');
    // whatever the person says next is a new message – it rejects the waiting action, it never runs it
    model.reply(sse(anthropicSse([{ type: 'text', text: 'Okay, ich schicke nichts.' }])));
    await t.api.post('/api/agent/chat', { conversation_id: conv.id, message: 'ja', source: 'focus' });
    expect(sent()).toBe(0);
    expect(t.app.db.get<any>('SELECT status FROM agent_pending WHERE id = ?', card.pending_id).status).toBe('expired');
    // an unknown source is an ordinary chat
    model.reply(sse(anthropicSse([{ type: 'text', text: 'Hallo.' }])));
    const other = events((await t.api.post('/api/agent/chat', { message: 'Hallo', source: 'hacker' })).data);
    expect(t.app.db.get<any>('SELECT source FROM agent_conversations WHERE id = ?', other.find((e) => e.type === 'start').conversation_id).source).toBe('chat');
    expect(JSON.stringify(model.calls.at(-1)!.body.system)).not.toContain('Fokus-Modus mit Companion');
  });
});
