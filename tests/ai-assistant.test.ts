import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { retry } from '../server/services/anthropic.js';

/** A fake Claude API: records every request, answers with whatever `respond` returns. */
type Reply = { status: number; json: any };
const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
let respond: (body: any, url: string) => Reply | Promise<Reply> = () => text('Hallo!');
function text(t: string, usage: Record<string, number> = { input_tokens: 1000, output_tokens: 200 }, model = 'claude-sonnet-5-5'): Reply {
  return { status: 200, json: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: t }], stop_reason: 'end_turn', usage } };
}
const botJson = (o: Record<string, unknown> = {}) =>
  text(JSON.stringify({ reply: 'Eine Website kostet ab 990 €.', confidence: 0.9, handoff: false, handoff_reason: '', lead: { first_name: '', last_name: '', email: '', phone: '' }, buying_intent: false, intent_summary: '', ...o }));
const fake = (async (url: string, init: any = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), headers: init.headers ?? {}, body });
  const r = await respond(body, String(url));
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

const KEY = 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123';
let t: Awaited<ReturnType<typeof startTestApp>>;
const flush = () => t.app.events.flush();
const chat = (body: Record<string, unknown>) =>
  t.api.raw(`/api/public/chat/${t.api.location}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const chatLog = async (visitor: string) => (await (await t.api.raw(`/api/public/chat/${t.api.location}/messages?visitor=${visitor}`)).json()).messages as any[];
const threadOf = async (email: string) => {
  const conv = (await t.api.get(`/api/conversations?q=${encodeURIComponent(email)}`)).data[0];
  return { conv, data: (await t.api.get(`/api/conversations/${conv.id}/messages`)).data };
};
const allClosed = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: false, from: '09:00', to: '17:00' }]));
const allOpen = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, from: '00:00', to: '00:00' }]));

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fake;
  await t.setup();
  await t.api.patch('/api/location', { settings: { chat: { enabled: true, ask_email: false } } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(() => {
  calls.length = 0;
  respond = () => text('Hallo!');
});

describe('KI-Assistent settings', () => {
  it('starts off, needs a valid key and never shows it again', async () => {
    const s = (await t.api.get('/api/ai/settings')).data;
    expect(s).toMatchObject({ key_set: false, settings: { enabled: false, model: 'claude-sonnet-5-5', bot_mode: 'off', monthly_limit_usd: 20 } });
    expect(s.models.map((m: any) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5']);
    expect((await t.api.put('/api/ai/settings', { enabled: true })).data.error).toContain('API-Schlüssel');
    expect((await t.api.put('/api/ai/settings', { api_key: 'abc' })).data.error).toContain('sk-ant-');
    expect((await t.api.post('/api/ai/suggest', { contact_id: 'x' })).status).toBe(404);

    const saved = await t.api.put('/api/ai/settings', {
      api_key: KEY,
      enabled: true,
      persona: 'Locker und per du.',
      facts: 'Webdesign-Agentur in Leipzig.',
      knowledge: [{ q: 'Was kostet eine Website?', a: 'Ab 990 €.' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ key_set: true, key_hint: '…0123', key_source: 'account' });
    expect(JSON.stringify(saved.data)).not.toContain(KEY);
    expect(JSON.stringify((await t.api.get('/api/ai/settings')).data)).not.toContain(KEY);
    expect(JSON.stringify((await t.api.get('/api/location')).data)).not.toContain('sk-ant');
    const row = t.app.db.get('SELECT * FROM ai_settings WHERE location_id = ?', t.api.location)!;
    expect(row.api_key).toMatch(/^v1:/);
    expect(row.api_key).not.toContain(KEY);
    expect((await t.api.get('/api/ai/status')).data).toEqual({ enabled: true, bot_mode: 'off', assistant_name: 'KI-Assistent' });
  });

  it('tests the connection without spending tokens', async () => {
    respond = (_b, url) => (url.endsWith('/v1/models/claude-sonnet-5-5') ? { status: 200, json: { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' } } : { status: 404, json: {} });
    const ok = await t.api.post('/api/ai/test', {});
    expect(ok.data).toEqual({ ok: true, model: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' });
    expect(calls[0].headers['x-api-key']).toBe(KEY);
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    respond = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const bad = await t.api.post('/api/ai/test', { api_key: 'sk-ant-api03-wrong-wrong-wrong-wrong-wrong' });
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain('API-Schlüssel ist ungültig');
  });

  it('validates pipeline choices', async () => {
    expect((await t.api.put('/api/ai/settings', { create_opportunity: true })).data.error).toContain('Pipeline');
    expect((await t.api.put('/api/ai/settings', { pipeline_id: 'gibtsnicht' })).data.error).toContain('Pipeline nicht gefunden');
  });
});

describe('reply suggestions and summaries', () => {
  let convId = '';
  let contactId = '';

  it('builds the context: contact, last 20 messages, knowledge, profile, website FAQ – without secrets', async () => {
    await t.api.put('/api/project', { tagline: 'Websites für Handwerker', description: 'Wir bauen schnelle Websites.' });
    const funnel = (await t.api.post('/api/funnels', { name: 'Start' })).data;
    const page = (await t.api.get(`/api/funnels/${funnel.id}`)).data.pages[0];
    expect(page).toBeTruthy();
    await t.api.patch(`/api/funnel-pages/${page.id}`, { blocks: [{ id: 'f1', type: 'faq', heading: 'FAQ', items: [{ q: 'Wie lange dauert ein Projekt?', a: 'Etwa zwei Wochen.' }] }] });

    const c = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Beispiel', email: 'anna@kunde.de', tags: ['lead'], custom: { budget: '5000', passwort: 'streng-geheim' } })).data;
    contactId = c.id;
    const urls = (await t.api.get('/api/settings/inbound')).data;
    const u = new URL(urls.email);
    for (let i = 1; i <= 24; i++) {
      const body = i === 24 ? 'Hier mein Zugang, Passwort: hunter2 – und Key sk-ant-api03-leakedleakedleaked. Habt ihr nächste Woche Zeit?' : `Frage Nummer ${i}`;
      await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Anna <anna@kunde.de>', subject: 'Website', text: body }) });
    }
    await flush();
    convId = (await threadOf('anna@kunde.de')).conv.id;

    respond = () => text('Hallo Anna,\n\ngerne nächste Woche!\n\nViele Grüße\nTestfirma', { input_tokens: 2000, output_tokens: 300, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0 });
    const r = await t.api.post('/api/ai/suggest', { conversation_id: convId, instruction: 'Termin am Dienstag anbieten' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ channel: 'email', subject: 'Re: Website', text: expect.stringContaining('gerne nächste Woche') });

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe(KEY);
    expect(req.body.model).toBe('claude-sonnet-5-5');
    expect(req.body.output_config).toEqual({ effort: 'high' });
    const system = req.body.system.map((b: any) => b.text).join('\n');
    expect(req.body.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    for (const part of ['Locker und per du.', 'Webdesign-Agentur in Leipzig.', 'Was kostet eine Website?', 'Websites für Handwerker']) expect(system).toContain(part);
    expect(system).toContain('Wie lange dauert ein Projekt?');
    expect((await t.api.get('/api/ai/settings')).data.sources).toEqual({ profile: true, faq_count: 1 });
    // The volatile part (time, conversation) stays out of the cached system prompt.
    expect(system).not.toContain('Frage Nummer');
    expect(system).not.toMatch(/Jetzt: /);
    const user = req.body.messages[0].content as string;
    expect(user).toContain('Vorname: Anna');
    expect(user).toContain('Tags: lead');
    expect(user).toContain('Feld budget: 5000');
    expect(user).not.toContain('streng-geheim');
    expect(user).not.toContain('Frage Nummer 4\n');
    expect(user).toContain('Frage Nummer 5');
    expect(user).toContain('Habt ihr nächste Woche Zeit?');
    expect(user).not.toContain('hunter2');
    expect(user).not.toContain('sk-ant-api03-leaked');
    expect(user).toContain('Termin am Dienstag anbieten');
    expect(user).toContain('Kanal E-Mail');
  });

  it('logs every call with tokens and cost', async () => {
    const u = (await t.api.get('/api/ai/usage')).data;
    const sug = u.recent.find((x: any) => x.purpose === 'suggest');
    expect(sug).toMatchObject({ model: 'claude-sonnet-5-5', status: 'ok', input_tokens: 2000, output_tokens: 300, cache_write_tokens: 1500, contact_id: contactId, conversation_id: convId });
    // 2000 × $2 + 300 × $10 + 1500 × $2.50 per MTok = 0.01075 $
    expect(sug.cost_usd).toBeCloseTo(0.01075, 6);
    expect(u.by_purpose.find((p: any) => p.purpose === 'suggest').calls).toBe(1);
    expect(u.month.cost_usd).toBeCloseTo(0.01075, 6);
    expect(u.recent.some((x: any) => x.purpose === 'test')).toBe(true);
  });

  it('summarises into the side panel', async () => {
    respond = (b) => {
      expect(b.output_config.format.type).toBe('json_schema');
      return text(JSON.stringify({ summary: 'Anna möchte eine neue Website und fragt nach einem Termin.', next_step: 'Termin für Dienstag vorschlagen.' }));
    };
    const r = await t.api.post('/api/ai/summarize', { conversation_id: convId });
    expect(r.data).toMatchObject({ summary: expect.stringContaining('Anna'), next_step: 'Termin für Dienstag vorschlagen.' });
    const panel = (await t.api.get(`/api/ai/conversations/${convId}`)).data;
    expect(panel).toMatchObject({ enabled: true, summary: expect.stringContaining('Website'), next_step: 'Termin für Dienstag vorschlagen.' });
    respond = () => text('kein json');
    const bad = await t.api.post('/api/ai/summarize', { conversation_id: convId });
    expect(bad.status).toBe(502);
    expect(bad.data.error).toContain('unbrauchbar');
  });

  it('handles API errors in German and retries without the fallback beta when it is unknown', async () => {
    respond = () => ({ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } });
    const limited = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(limited.status).toBe(429);
    expect(limited.data.error).toContain('Zu viele Anfragen');
    respond = () => ({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    const busy = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(busy.data.error).toContain('überlastet');
    expect(calls).toHaveLength(3); // one retry on overload
    calls.length = 0;
    respond = (b) => (b.fallbacks ? { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.' } } } : text('Klappt.'));
    const ok = await t.api.post('/api/ai/suggest', { conversation_id: convId, channel: 'sms' });
    expect(ok.data.text).toBe('Klappt.');
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['anthropic-beta']).toBeUndefined();
    expect(calls[1].body.fallbacks).toBeUndefined();
    respond = () => ({ status: 200, json: { model: 'claude-sonnet-5-5', content: [], stop_reason: 'refusal', usage: { input_tokens: 50, output_tokens: 0 } } });
    const refused = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(refused.data.error).toContain('abgelehnt');
    const errors = (await t.api.get('/api/ai/usage')).data.recent.filter((x: any) => x.status === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors[0]).toMatchObject({ input_tokens: 50, error: expect.stringContaining('abgelehnt') });
  });

  it('respects the monthly cost limit', async () => {
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 0.05 });
    respond = () => text('Teuer.', { input_tokens: 1000, output_tokens: 5000 }); // 0.052 $
    expect((await t.api.post('/api/ai/suggest', { conversation_id: convId })).status).toBe(200);
    calls.length = 0;
    const blocked = await t.api.post('/api/ai/suggest', { conversation_id: convId });
    expect(blocked.status).toBe(409);
    expect(blocked.data.error).toContain('Monatslimit');
    expect(calls).toHaveLength(0);
    expect((await t.api.get('/api/ai/usage')).data.recent[0]).toMatchObject({ status: 'blocked', cost_usd: 0 });
    await t.api.put('/api/ai/settings', { monthly_limit_usd: 50 });
  });

  it('drafts replies to inbound mail but never sends them', async () => {
    await t.api.put('/api/ai/settings', { email_drafts: true });
    respond = () => text('Hallo Bernd,\n\ndanke für deine Nachricht!\n\nViele Grüße\nTestfirma');
    const u = new URL((await t.api.get('/api/settings/inbound')).data.email);
    await t.api.raw(u.pathname + u.search, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'Bernd <bernd@kunde.de>', subject: 'Angebot', text: 'Was kostet ein Logo?' }) });
    await flush();
    const { data } = await threadOf('bernd@kunde.de');
    const out = data.messages.filter((m: any) => m.direction === 'out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'draft', source: 'KI-Entwurf', subject: 'Re: Angebot', channel: 'email' });
    expect((await t.api.get('/api/ai/usage')).data.recent[0].purpose).toBe('email_draft');
    await t.api.put('/api/ai/settings', { email_drafts: false });
  });
});

describe('live-chat bot', () => {
  it('stays silent when off and during business hours in "after_hours" mode', async () => {
    await t.api.put('/api/ai/settings', { bot_mode: 'off' });
    const v = await chat({ body: 'Hallo, was kostet eine Website?', name: 'Off Test', email: 'off@test.de' });
    await flush();
    expect(calls).toHaveLength(0);
    await t.api.put('/api/ai/settings', { bot_mode: 'after_hours', business_hours: allOpen });
    expect((await t.api.get('/api/ai/settings')).data.bot_active_now).toBe(false);
    await chat({ body: 'Noch da?', visitor: v.visitor });
    await flush();
    expect(calls).toHaveLength(0);
    expect((await chatLog(v.visitor)).every((m) => m.direction === 'in')).toBe(true);
  });

  it('answers outside business hours, marked as bot', async () => {
    await t.api.put('/api/ai/settings', { bot_mode: 'after_hours', business_hours: allClosed });
    respond = () => botJson();
    const v = await chat({ body: 'Was kostet eine Website?', name: 'Clara Chat', email: 'clara@test.de' });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.output_config.format.schema.required).toContain('buying_intent');
    expect(calls[0].body.messages[0].content).toContain('Was kostet eine Website?');
    const log = await chatLog(v.visitor);
    expect(log.at(-1)).toMatchObject({ direction: 'out', body: '🤖 Eine Website kostet ab 990 €.' });
    const { conv, data } = await threadOf('clara@test.de');
    expect(data.messages.at(-1)).toMatchObject({ source: 'KI-Assistent', channel: 'chat', status: 'sent', user_id: null });
    expect((await t.api.get(`/api/ai/conversations/${conv.id}`)).data).toMatchObject({ bot_status: 'active', bot_replies: 1 });
    expect((await t.api.get('/api/ai/usage')).data.recent[0]).toMatchObject({ purpose: 'chat_bot', status: 'ok' });
  });

  it('hands over to the team when a person is asked for – and stays quiet afterwards', async () => {
    await t.api.put('/api/ai/settings', { bot_mode: 'always' });
    const wf = (await t.api.post('/api/workflows', { name: 'Übergabe', trigger: { type: 'ai.handoff', config: {} }, steps: [{ type: 'add_tag', tags: ['braucht-mensch'] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const v = await chat({ body: 'Kann ich bitte mit einem Mitarbeiter sprechen?', name: 'Dora Druck', email: 'dora@test.de' });
    await flush();
    expect(calls).toHaveLength(0); // decided without the model
    expect((await chatLog(v.visitor)).at(-1).body).toContain('Ich gebe dich an unser Team weiter');
    const { conv, data } = await threadOf('dora@test.de');
    const st = (await t.api.get(`/api/ai/conversations/${conv.id}`)).data;
    expect(st).toMatchObject({ bot_status: 'handoff', handoff_reason: 'Besucher möchte mit einem Menschen sprechen' });
    expect((await t.api.get(`/api/contacts/${data.contact.id}`)).data.tags).toContain('braucht-mensch');

    respond = () => botJson();
    await chat({ body: 'Hallo?', visitor: v.visitor });
    await flush();
    expect(calls).toHaveLength(0);
    // The team gives the conversation back to the bot.
    await t.api.patch(`/api/ai/conversations/${conv.id}`, { bot_status: 'active' });
    await chat({ body: 'Was kostet eine Website?', visitor: v.visitor });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('hands over on low confidence, broken JSON, keywords and API errors', async () => {
    const cases: [string, () => Reply, string][] = [
      ['Habt ihr Rabatte für Vereine?', () => botJson({ confidence: 0.3 }), 'unsicher'],
      ['Macht ihr auch Apps?', () => text('{"reply": "Ja"}'), 'unbrauchbar'],
      ['Ich habe eine Beschwerde', () => botJson(), 'Stichwort „beschwerde“'],
      ['Geht das schnell?', () => ({ status: 401, json: { error: { message: 'bad key' } } }), 'KI nicht verfügbar'],
    ];
    for (const [i, [msg, reply, reason]] of cases.entries()) {
      respond = reply;
      await chat({ body: msg, name: `Fall ${i}`, email: `fall${i}@test.de` });
      await flush();
      const { conv } = await threadOf(`fall${i}@test.de`);
      const st = (await t.api.get(`/api/ai/conversations/${conv.id}`)).data;
      expect(st.bot_status, msg).toBe('handoff');
      expect(st.handoff_reason).toContain(reason);
    }
  });

  it('answers a message that arrives while the model is still writing', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    respond = async () => {
      const n = calls.length;
      if (n === 1) await gate;
      return botJson({ reply: `Antwort ${n}` });
    };
    const v = await chat({ body: 'Frage eins', name: 'Rita Rasch', email: 'rita@test.de' });
    for (let i = 0; i < 100 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await chat({ body: 'Frage zwei', visitor: v.visitor });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].body.messages[0].content).toContain('Frage zwei');
    expect((await chatLog(v.visitor)).filter((m) => m.direction === 'out').map((m) => m.body)).toEqual(['🤖 Antwort 1', '🤖 Antwort 2']);
  });

  it('does not answer while a person from the team is in the conversation', async () => {
    respond = () => botJson();
    const v = await chat({ body: 'Hallo!', name: 'Emil Team', email: 'emil@test.de' });
    await flush();
    const { data } = await threadOf('emil@test.de');
    await t.api.post('/api/messages', { contact_id: data.contact.id, channel: 'chat', body: 'Hi Emil, ich bin Paul.' });
    calls.length = 0;
    await chat({ body: 'Super, danke!', visitor: v.visitor });
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('captures the lead and creates an opportunity and a task on buying intent', async () => {
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    await t.api.put('/api/ai/settings', { lead_capture: true, create_opportunity: true, pipeline_id: pipe.id, stage_id: pipe.stages[3].id, create_task: true });
    respond = () => botJson({ reply: 'Wie heißt du, und wie erreichen wir dich?' });
    const v = await chat({ body: 'Ich hätte gern ein Angebot für eine Website.' });
    await flush();
    expect(calls[0].body.messages[0].content).toContain('Fehlende Kontaktdaten: Name, E-Mail');
    respond = () => botJson({ reply: 'Danke Mia! Wir schicken dir das Angebot.', lead: { first_name: 'Mia', last_name: 'Muster', email: 'Mia@Example.com', phone: '' }, buying_intent: true, intent_summary: 'Angebot Website' });
    await chat({ body: 'Mia Muster, mia@example.com', visitor: v.visitor });
    await flush();
    const contacts = (await t.api.get('/api/contacts?q=mia@example.com')).data;
    const c = (contacts.contacts ?? contacts)[0];
    expect(c).toMatchObject({ first_name: 'Mia', last_name: 'Muster', email: 'mia@example.com' });
    const opps = (await t.api.get(`/api/opportunities?contact_id=${c.id}&status=all`)).data;
    expect(opps).toHaveLength(1);
    expect(opps[0]).toMatchObject({ pipeline_id: pipe.id, stage_id: pipe.stages[3].id, source: 'KI-Assistent' });
    const tasks = (await t.api.get('/api/tasks')).data;
    expect((tasks.tasks ?? tasks).some((x: any) => x.contact_id === c.id && x.title.includes('Angebot Website'))).toBe(true);
    // A second buying signal in the same chat doesn't create duplicates; invalid lead JSON hands over.
    respond = () => botJson({ buying_intent: true, intent_summary: 'Nochmal' });
    await chat({ body: 'Wann kommt das Angebot?', visitor: v.visitor });
    await flush();
    expect((await t.api.get(`/api/opportunities?contact_id=${c.id}&status=all`)).data).toHaveLength(1);
    respond = () => botJson({ lead: { first_name: 'Mia', last_name: '', email: 'nicht-gültig', phone: '' } });
    await chat({ body: 'Meine andere Mail ist nicht-gültig', visitor: v.visitor });
    await flush();
    const { conv } = await threadOf('mia@example.com');
    expect((await t.api.get(`/api/ai/conversations/${conv.id}`)).data.handoff_reason).toContain('lead.email');
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.email).toBe('mia@example.com');
  });
});

describe('workflow action and MCP tool', () => {
  it('"KI-Text erzeugen" fills a custom field and creates a mail draft', async () => {
    respond = () => text('Liebe Frau Klein');
    const wf = (
      await t.api.post('/api/workflows', {
        name: 'KI-Anrede',
        trigger: { type: 'contact.tag_added', config: { tag: 'ki-test' } },
        steps: [
          { type: 'ai_text', prompt: 'Schreibe eine förmliche Anrede für {{contact.first_name}} {{contact.last_name}}.', target: 'field', field: 'custom.anrede' },
          { type: 'ai_text', prompt: 'Schreibe eine kurze Willkommensmail an {{contact.first_name}}.', target: 'email_draft', subject: 'Willkommen, {{contact.first_name}}!' },
        ],
      })
    ).data;
    expect(wf.id).toBeTruthy();
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const c = (await t.api.post('/api/contacts', { first_name: 'Karla', last_name: 'Klein', email: 'karla@test.de', tags: ['ki-test'] })).data;
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[0].body.messages[0].content).toContain('förmliche Anrede für Karla Klein');
    expect((await t.api.get(`/api/contacts/${c.id}`)).data.custom.anrede).toBe('Liebe Frau Klein');
    const msgs = (await t.api.get(`/api/contacts/${c.id}/messages`)).data;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: 'draft', subject: 'Willkommen, Karla!', source: 'KI-Entwurf' });
    const usage = (await t.api.get('/api/ai/usage')).data;
    expect(usage.recent.filter((x: any) => x.purpose === 'workflow')).toHaveLength(2);
  });

  it('offers ghl_ai_suggest_reply over MCP', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
    const rpc = async (body: any) => (await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })).json();
    const tools = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools;
    expect(tools.map((x: any) => x.name)).toContain('ghl_ai_suggest_reply');
    respond = () => text('Gern, ich schicke dir Termine.');
    const contact = (await t.api.get('/api/contacts?q=anna@kunde.de')).data;
    const anna = (contact.contacts ?? contact)[0];
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ghl_ai_suggest_reply', arguments: { contact_id: anna.id, channel: 'email', instruction: 'Termine anbieten' } } });
    expect(r.result.isError).toBe(false);
    expect(JSON.parse(r.result.content[0].text)).toMatchObject({ text: 'Gern, ich schicke dir Termine.', channel: 'email' });
    expect((await t.api.get('/api/ai/usage')).data.recent[0].purpose).toBe('mcp');
  });
});
