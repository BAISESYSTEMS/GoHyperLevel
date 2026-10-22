import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { berlinDay, startTestApp } from './helpers.js';
import { receiveMessage } from '../server/services/messaging.js';
import { normalizeFingerprint } from '../server/modules/mobile-app.js';

const CERT = '12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0';
import { retry } from '../server/services/anthropic.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc1 = '';
let loc2 = '';
let adminToken = '';
let memberToken = '';
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const flush = () => t.app.events.flush();

/** A request with only the device token (no cookie, no CSRF header). */
async function app(method: string, path: string, tok: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await t.api.raw(path, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, data: (type.includes('json') ? await r.json() : await r.text()) as any, headers: r.headers };
}
const get = (path: string, tok = adminToken) => app('GET', path, tok);
const post = (path: string, body: unknown = {}, tok = adminToken) => app('POST', path, tok, body);

async function loginAs(email: string, password: string) {
  t.api.clearCookie();
  const r = await t.api.post('/api/auth/login', { email, password });
  expect(r.status).toBe(200);
}

// Fake Claude API for the capture tests.
let aiReply: any = null;
const fakeAi = (async () =>
  new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(aiReply) }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;

beforeAll(async () => {
  retry.ms = 1;
  t = await startTestApp();
  t.app.services.aiFetch = fakeAi;
  await t.setup();
  loc1 = t.api.location;
  loc2 = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
});
afterAll(async () => {
  await t.close();
});

describe('pairing & device tokens', () => {
  it('pairs only with a signed-in session and stores the token hashed', async () => {
    expect((await t.api.raw('/api/mobile/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    // Cookie without the CSRF header is refused like every other write.
    expect((await t.api.raw('/api/mobile/pair', { method: 'POST', headers: { cookie: t.api.cookie, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const r = await t.api.post('/api/mobile/pair', { device_name: 'Pixel 9', platform: 'android', app_version: '1.0.0 (1)' });
    expect(r.status).toBe(200);
    expect(r.data.token).toMatch(/^ghm_[A-Za-z0-9_-]{40,}$/);
    expect(r.data.user).toMatchObject({ email: 'chef@example.com', role: 'admin', name: 'Chef' });
    adminToken = r.data.token;
    const row = t.app.db.get('SELECT * FROM mobile_devices WHERE id = ?', r.data.device_id)!;
    expect(row).toMatchObject({ name: 'Pixel 9', platform: 'android', app_version: '1.0.0 (1)', token_hash: sha(adminToken) });
    expect(JSON.stringify(row)).not.toContain(adminToken);
    // A device token can't mint more tokens.
    expect((await post('/api/mobile/pair', { device_name: 'x' })).status).toBe(403);
  });

  it('authenticates with the bearer token on /api/mobile only', async () => {
    const me = await get('/api/mobile/me');
    expect(me.status).toBe(200);
    expect(me.data).toMatchObject({ user: { email: 'chef@example.com', role: 'admin' }, agency: true, app: null });
    expect(me.data.locations.map((l: any) => l.name).sort()).toEqual(['Testfirma', 'Zweitfirma']);
    expect(me.data.locations[0].areas).toContain('conversations');
    expect(Date.parse(me.data.server_time)).toBeGreaterThan(0);
    expect((await get('/api/contacts')).status).toBe(403);
    expect((await get('/api/mobile/me', 'ghm_unknown')).status).toBe(401);
    expect((await get('/api/mobile/me', 'ghm_unknown')).data.error).toContain('neu anmelden');
  });

  it('lists devices (session and bearer) and revokes them', async () => {
    const extra = (await t.api.post('/api/mobile/pair', { device_name: 'Altes Handy' })).data;
    const viaApp = await get('/api/mobile/devices');
    expect(viaApp.data.map((d: any) => d.name)).toEqual(expect.arrayContaining(['Pixel 9', 'Altes Handy']));
    expect(viaApp.data.find((d: any) => d.name === 'Pixel 9').current).toBe(true);
    expect(JSON.stringify(viaApp.data)).not.toContain('token_hash');
    const viaWeb = await t.api.get('/api/mobile/devices');
    expect(viaWeb.data).toHaveLength(2);
    expect(viaWeb.data.every((d: any) => !d.current)).toBe(true);

    expect((await get('/api/mobile/me', extra.token)).status).toBe(200);
    expect((await t.api.del(`/api/mobile/devices/${extra.device_id}`)).status).toBe(200);
    expect((await get('/api/mobile/me', extra.token)).status).toBe(401);
    expect((await t.api.del(`/api/mobile/devices/${extra.device_id}`)).status).toBe(404);

    const third = (await t.api.post('/api/mobile/pair', { device_name: 'Tablet' })).data;
    expect((await t.api.post('/api/mobile/logout')).status).toBe(400);
    expect((await post('/api/mobile/logout', {}, third.token)).status).toBe(200);
    expect((await get('/api/mobile/me', third.token)).status).toBe(401);
    // "Alle anderen abmelden" and a new password sign the app out too.
    const fourth = (await t.api.post('/api/mobile/pair', { device_name: 'Zweithandy' })).data;
    expect((await t.api.post('/api/me/sessions/revoke-others')).status).toBe(200);
    expect((await get('/api/mobile/me', fourth.token)).status).toBe(401);
    expect((await get('/api/mobile/me')).status).toBe(401);
    adminToken = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel 9' })).data.token;
    expect((await get('/api/mobile/me')).status).toBe(200);
    const audit = t.app.db.all(`SELECT action, via FROM audit_log WHERE action LIKE 'mobile.%'`);
    expect(audit).toEqual(expect.arrayContaining([{ action: 'mobile.pair.create', via: 'session' }, { action: 'mobile.devices.delete', via: 'session' }, { action: 'mobile.logout.create', via: 'app' }]));
  });
});

describe('read endpoints', () => {
  let contactId = '';
  let convId = '';
  let oppId = '';
  let stageIds: string[] = [];

  beforeAll(async () => {
    t.api.setLocation(loc1);
    contactId = (await t.api.post('/api/contacts', { first_name: 'Anna', last_name: 'Alt', email: 'anna@example.com', phone: '+491701112233', company: 'Alt GmbH' })).data.id;
    // A date-only due date is a calendar day of the sub-account (Berlin), not of UTC: after 22:00 UTC the UTC date is still yesterday.
    const today = berlinDay();
    await t.api.post('/api/tasks', { title: 'Heute anrufen', due_at: `${today}T00:00:00.000Z`, contact_id: contactId });
    await t.api.post('/api/tasks', { title: 'Längst fällig', due_at: new Date(Date.now() - 3 * 864e5).toISOString() });
    await t.api.post('/api/tasks', { title: 'Irgendwann' });
    const pipe = (await t.api.get('/api/pipelines')).data[0];
    stageIds = pipe.stages.map((s: any) => s.id);
    oppId = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, value: 1500, name: 'Website Alt' })).data.id;
    const cal = (await t.api.post('/api/calendars', { name: 'Beratung', settings: { meeting_location: 'https://meet.example.com/abc' } })).data;
    const start = new Date(Date.now() + 2 * 3600_000);
    start.setUTCMinutes(0, 0, 0);
    await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: contactId, start: start.toISOString(), force: true });
    const inv = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Website', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    t.app.db.insert('review_requests', { id: 'rv1', location_id: loc1, contact_id: contactId, token: 'tok-rv1', channel: 'email', rating: 5, comment: 'Super!', public: 1, created_at: new Date().toISOString(), responded_at: new Date().toISOString() });
    await t.api.put('/api/project', { status: 'live', website: 'https://alt.example.com', claude_sessions: [{ label: 'Claude', url: 'session_abc123' }] });
    t.app.db.insert('project_checks', { location_id: loc1, at: new Date().toISOString(), ok: 1, status: 200, ms: 123 });
    const nowIso = new Date().toISOString();
    t.app.db.insert('calls', { id: 'call1', location_id: loc1, contact_id: contactId, direction: 'in', from_number: '+491701112233', to_number: '+4930123', status: 'voicemail', answered: 0, duration: 0, recording_sid: 'RE1', transcription: 'Bitte zurückrufen', started_at: nowIso, ended_at: nowIso, updated_at: nowIso });
    t.app.db.insert('social_posts', { id: 'sp1', location_id: loc1, postiz_ids: '[]', integration_ids: '["int1"]', content: 'Neuer Blogartikel!', type: 'schedule', publish_at: new Date(Date.now() + 864e5).toISOString(), created_at: nowIso });
    // The appointment confirmation went out by e-mail; the customer's SMS comes last.
    const msg = receiveMessage(t.app, loc1, { channel: 'sms', from: '+491701112233', body: 'Hallo, habt ihr morgen Zeit?' });
    expect(msg.contact_id).toBe(contactId);
    convId = msg.conversation_id;
    // Second sub-account: a task only the member below may see.
    t.api.setLocation(loc2);
    await t.api.post('/api/tasks', { title: 'Aufgabe Zweitfirma' });
    t.api.setLocation(loc1);
  });

  it('summary counts across sub-accounts', async () => {
    const s = (await get('/api/mobile/summary')).data;
    expect(s).toMatchObject({ leads_today: 1, leads_7d: 1, open_deals_count: 1, open_deals_value_cents: 150000, revenue_today_cents: 11900, revenue_month_cents: 11900, open_invoices_cents: 0, unread_conversations: 1, tasks_due_today: 1, tasks_overdue: 1, appointments_today: expect.any(Number), missed_calls_today: 1, rating: { avg: 5, count: 1 }, websites: { up: 1, down: 0 }, currency: 'EUR' });
    expect(s.spark_revenue_30d).toHaveLength(30);
    expect(s.spark_revenue_30d[29]).toBe(11900);
    expect(s.spark_leads_14d).toHaveLength(14);
    expect(s.spark_leads_14d[13]).toBe(1);
    expect((await get(`/api/mobile/summary?location=${loc2}`)).data).toMatchObject({ leads_today: 0, open_deals_count: 0, rating: null });
  });

  it('inbox, conversation detail and contacts', async () => {
    const inbox = (await get('/api/mobile/inbox?unread=1&limit=5')).data;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual({ conversation_id: convId, location_id: loc1, location_name: 'Testfirma', contact_id: contactId, contact_name: 'Anna Alt', channel: 'sms', last_message: 'Hallo, habt ihr morgen Zeit?', last_direction: 'in', last_at: expect.any(String), unread: 1, starred: false });
    const c = (await get(`/api/mobile/conversations/${convId}?limit=20`)).data;
    expect(c).toMatchObject({ conversation_id: convId, contact: { id: contactId, name: 'Anna Alt', phone: '+491701112233', email: 'anna@example.com' }, channels: ['email', 'sms'] });
    expect(c.messages.at(-1)).toMatchObject({ id: expect.any(String), direction: 'in', channel: 'sms', body: 'Hallo, habt ihr morgen Zeit?', at: expect.any(String), status: 'received' });
    // Reading the thread does not mark it read (the app does that explicitly).
    expect(t.app.db.get('SELECT unread FROM conversations WHERE id = ?', convId)!.unread).toBe(1);
    expect((await get('/api/mobile/conversations/nope')).status).toBe(404);
    const found = (await get('/api/mobile/contacts?q=anna')).data;
    expect(found).toEqual([expect.objectContaining({ id: contactId, name: 'Anna Alt', email: 'anna@example.com', phone: '+491701112233', company: 'Alt GmbH', location_id: loc1, location_name: 'Testfirma' })]);
  });

  it('tasks with filters', async () => {
    const open = (await get('/api/mobile/tasks')).data;
    expect(open.map((x: any) => x.title)).toEqual(expect.arrayContaining(['Heute anrufen', 'Längst fällig', 'Irgendwann', 'Aufgabe Zweitfirma']));
    const today = (await get('/api/mobile/tasks?filter=today')).data;
    expect(today).toEqual([{ id: expect.any(String), title: 'Heute anrufen', description: '', due_at: expect.stringMatching(/T00:00:00\.000Z$/), done: false, location_id: loc1, location_name: 'Testfirma', contact_id: contactId, contact_name: 'Anna Alt', assigned_to: expect.any(String) }]);
    expect((await get('/api/mobile/tasks?filter=overdue')).data.map((x: any) => x.title)).toEqual(['Längst fällig']);
    expect((await get('/api/mobile/tasks?filter=week')).data.map((x: any) => x.title).sort()).toEqual(['Heute anrufen', 'Längst fällig']);
    expect((await get(`/api/mobile/tasks?location=${loc2}`)).data.map((x: any) => x.title)).toEqual(['Aufgabe Zweitfirma']);
  });

  it('appointments, deals, calls', async () => {
    const appts = (await get('/api/mobile/appointments?days=2')).data;
    expect(appts[0]).toMatchObject({ id: expect.any(String), title: expect.any(String), start: expect.any(String), end: expect.any(String), status: 'confirmed', contact_id: contactId, contact_name: 'Anna Alt', phone: '+491701112233', meeting_url: 'https://meet.example.com/abc', address: null, calendar_name: 'Beratung', location_id: loc1, location_name: 'Testfirma' });
    const d = (await get('/api/mobile/deals')).data;
    const p = d.pipelines.find((x: any) => x.location_id === loc1);
    expect(p).toMatchObject({ name: 'Vertrieb', location_name: 'Testfirma' });
    expect(p.stages[0]).toEqual({ id: stageIds[0], name: 'Neuer Lead', count: 1, value_cents: 150000 });
    expect(d.top).toEqual([expect.objectContaining({ id: oppId, name: 'Website Alt', value_cents: 150000, stage_id: stageIds[0], stage_name: 'Neuer Lead', pipeline_id: p.id, contact_name: 'Anna Alt', location_id: loc1, location_name: 'Testfirma', updated_at: expect.any(String) })]);
    const calls = (await get('/api/mobile/calls?missed=1')).data;
    expect(calls).toEqual([expect.objectContaining({ id: 'call1', direction: 'in', status: 'voicemail', from: '+491701112233', to: '+4930123', contact_id: contactId, contact_name: 'Anna Alt', at: expect.any(String), duration_s: 0, has_voicemail: true, summary: 'Bitte zurückrufen' })]);
  });

  it('projects, reviews, payments, social', async () => {
    const projects = (await get('/api/mobile/projects')).data;
    expect(projects.find((p: any) => p.location_id === loc1)).toMatchObject({ name: 'Testfirma', status: 'live', website: 'https://alt.example.com', uptime: { up: true, checked_at: expect.any(String), response_ms: 123 }, open_tasks: 3, unread: 1, claude_url: 'https://claude.ai/code/session_abc123' });
    expect(projects.find((p: any) => p.location_id === loc2)).toMatchObject({ uptime: { up: null, checked_at: null, response_ms: null }, open_tasks: 1 });
    const r = (await get('/api/mobile/reviews?limit=5')).data;
    expect(r).toMatchObject({ avg: 5, count: 1, delta_30d: null });
    expect(r.latest[0]).toEqual(expect.objectContaining({ id: 'rv1', author: 'Anna Alt', rating: 5, text: 'Super!', at: expect.any(String), source: 'intern', replied: false }));
    const pay = (await get('/api/mobile/payments')).data;
    expect(pay).toMatchObject({ today_cents: 11900, month_cents: 11900, open_invoices_cents: 0, overdue_count: 0, currency: 'EUR' });
    expect(pay.latest[0]).toMatchObject({ id: expect.any(String), kind: 'invoice', title: expect.any(String), contact_name: 'Alt GmbH', total_cents: 11900, status: 'paid', paid_at: expect.any(String), location_name: 'Testfirma' });
    const social = (await get('/api/mobile/social')).data;
    expect(social).toEqual([{ id: 'sp1', text: 'Neuer Blogartikel!', scheduled_at: expect.any(String), status: 'scheduled', channels: [], location_id: loc1, location_name: 'Testfirma' }]);
  });

  it('validates the location parameter', async () => {
    expect((await get('/api/mobile/tasks?location=gibtsnicht')).status).toBe(404);
  });

  describe('write endpoints', () => {
    it('replies through the regular send path and marks read', async () => {
      const r = await post(`/api/mobile/conversations/${convId}/reply`, { body: 'Ja, morgen um 10?' });
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ direction: 'out', channel: 'sms', body: 'Ja, morgen um 10?', status: 'logged', conversation_id: convId });
      const email = await post(`/api/mobile/conversations/${convId}/reply`, { body: 'Details per Mail', channel: 'email' });
      expect(email.data).toMatchObject({ channel: 'email', subject: 'Nachricht von Testfirma', status: 'logged' });
      expect((await post(`/api/mobile/conversations/${convId}/reply`, { body: 'x', channel: 'fax' })).status).toBe(400);
      expect((await post(`/api/mobile/conversations/${convId}/reply`, {})).status).toBe(400);
      const audit = t.app.db.get(`SELECT * FROM audit_log WHERE action = 'messages.create' ORDER BY at DESC LIMIT 1`)!;
      expect(audit).toMatchObject({ via: 'app', actor: 'Chef', location_id: loc1, route: 'POST /api/messages' });
      expect(t.app.db.get(`SELECT id FROM audit_log WHERE action LIKE 'mobile.conversations%'`)).toBeUndefined();
      expect((await post(`/api/mobile/conversations/${convId}/read`)).data).toEqual({ ok: true, conversation_id: convId });
      expect(t.app.db.get('SELECT unread FROM conversations WHERE id = ?', convId)!.unread).toBe(0);
    });

    it('creates, completes and reopens tasks', async () => {
      const r = await post('/api/mobile/tasks', { location_id: loc2, title: 'Angebot schicken', due_at: '2030-01-15', contact_id: null });
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ title: 'Angebot schicken', due_at: '2030-01-15T00:00:00.000Z', done: false, location_id: loc2, location_name: 'Zweitfirma' });
      expect((await post('/api/mobile/tasks', { title: 'ohne Ort' })).status).toBe(400);
      expect((await post('/api/mobile/tasks', { location_id: loc2 })).status).toBe(400);
      expect((await post('/api/mobile/tasks', { location_id: loc2, title: 'x', due_at: 'morgen' })).status).toBe(400);
      expect((await post(`/api/mobile/tasks/${r.data.id}/complete`)).data).toMatchObject({ id: r.data.id, done: true });
      expect(t.app.db.get('SELECT completed_at FROM tasks WHERE id = ?', r.data.id)!.completed_at).toBeTruthy();
      expect((await post(`/api/mobile/tasks/${r.data.id}/reopen`)).data).toMatchObject({ done: false });
      expect((await post('/api/mobile/tasks/nope/complete')).status).toBe(404);
      expect(t.app.db.get(`SELECT via FROM audit_log WHERE action = 'tasks.update' ORDER BY at DESC LIMIT 1`)!.via).toBe('app');
    });

    it('moves deals and sets their status', async () => {
      const moved = await post(`/api/mobile/deals/${oppId}/stage`, { stage_id: stageIds[2] });
      expect(moved.data).toMatchObject({ id: oppId, stage_id: stageIds[2], stage_name: 'Termin gebucht', status: 'open' });
      expect((await post(`/api/mobile/deals/${oppId}/stage`, { stage_id: 'falsch' })).status).toBe(400);
      expect((await post(`/api/mobile/deals/${oppId}/status`, { status: 'gewonnen' })).status).toBe(400);
      expect((await post(`/api/mobile/deals/${oppId}/status`, { status: 'won' })).data).toMatchObject({ status: 'won' });
      expect((await get('/api/mobile/summary')).data.won_month_cents).toBe(150000);
      await post(`/api/mobile/deals/${oppId}/status`, { status: 'open' });
    });

    it('creates contacts (with note) and notes', async () => {
      const r = await post('/api/mobile/contacts', { location_id: loc1, first_name: 'Bernd', last_name: 'Bau', email: 'bernd@bau.de', phone: '0171 999', company: 'Bau AG', note: 'Will ein Angebot', tags: ['messe'] });
      expect(r.status).toBe(200);
      expect(r.data).toMatchObject({ name: 'Bernd Bau', email: 'bernd@bau.de', phone: '+49171999', company: 'Bau AG', location_id: loc1, created: true, note: { body: 'Will ein Angebot' } });
      const c = t.app.db.get('SELECT * FROM contacts WHERE id = ?', r.data.id)!;
      expect(c.source).toBe('App');
      expect(JSON.parse(c.tags)).toEqual(['messe']);
      expect((await post('/api/mobile/contacts', { location_id: loc1, email: 'x@y.de' })).status).toBe(400);
      const n = await post('/api/mobile/notes', { contact_id: r.data.id, body: 'Rückruf am Montag' });
      expect(n.data).toMatchObject({ contact_id: r.data.id, body: 'Rückruf am Montag', location_id: loc1 });
      expect((await post('/api/mobile/notes', { contact_id: 'nope', body: 'x' })).status).toBe(404);
    });

    it('click-to-call explains missing telephony', async () => {
      const r = await post('/api/mobile/calls', { contact_id: contactId });
      expect(r.status).toBe(400);
      expect(r.data.error).toContain('Telefonie ist noch nicht eingerichtet');
    });

    it('sets an appointment status', async () => {
      const a = (await get('/api/mobile/appointments')).data[0];
      expect((await post(`/api/mobile/appointments/${a.id}/status`, { status: 'abgesagt' })).status).toBe(400);
      expect((await post(`/api/mobile/appointments/${a.id}/status`, { status: 'showed' })).data).toMatchObject({ id: a.id, status: 'showed' });
    });

    it('captures text as a plain task without AI', async () => {
      const r = await post('/api/mobile/capture', { location_id: loc1, text: 'Flyer für die Messe bestellen' });
      expect(r.data).toMatchObject({ kind: 'task', ai: false, item: { title: 'Flyer für die Messe bestellen', location_id: loc1, done: false } });
      expect((await post('/api/mobile/capture', { location_id: loc1 })).status).toBe(400);
    });

    it('captures with the AI assistant: task with due date, or a note on a named contact', async () => {
      expect((await t.api.put('/api/ai/settings', { api_key: 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123', enabled: true })).status).toBe(200);
      aiReply = { kind: 'task', title: 'Anna zurückrufen', description: 'Wegen Termin', due_date: '2030-03-01', due_time: '10:00', contact_name: 'Anna Alt', note: '' };
      const task = await post('/api/mobile/capture', { location_id: loc1, text: 'morgen 10 Uhr Anna zurückrufen wegen Termin' });
      expect(task.data).toMatchObject({ kind: 'task', ai: true, item: { title: 'Anna zurückrufen', due_at: '2030-03-01T09:00:00.000Z', contact_id: contactId, contact_name: 'Anna Alt' } });
      expect(task.data.item.description).toContain('Diktat: morgen 10 Uhr');
      aiReply = { kind: 'note', title: 'Notiz', description: '', due_date: '', due_time: '', contact_name: 'Bernd Bau', note: 'Bernd will das Angebot erst im März.' };
      const note = await post('/api/mobile/capture', { location_id: loc1, text: 'Bernd Bau will das Angebot erst im März' });
      expect(note.data).toMatchObject({ kind: 'note', ai: true, item: { body: 'Bernd will das Angebot erst im März.', contact_name: 'Bernd Bau' } });
      expect(t.app.db.get(`SELECT purpose, status FROM ai_calls WHERE purpose = 'mobile_capture' ORDER BY created_at DESC LIMIT 1`)).toEqual({ purpose: 'mobile_capture', status: 'ok' });
      // A note for an unknown contact becomes a task instead.
      aiReply = { kind: 'note', title: 'Info zu Unbekannt', description: '', due_date: '', due_time: '', contact_name: 'Niemand Sonst', note: 'x' };
      expect((await post('/api/mobile/capture', { location_id: loc1, text: 'Niemand Sonst sagt x' })).data).toMatchObject({ kind: 'task', item: { title: 'Info zu Unbekannt' } });
      await t.api.put('/api/ai/settings', { enabled: false });
    });
  });
});

describe('client users only see their sub-accounts', () => {
  beforeAll(async () => {
    await t.api.post('/api/users', { email: 'kunde@zweit.de', name: 'Kunde', password: 'kunde12345', role: 'member', locations: [loc2], permissions: ['contacts', 'conversations', 'dashboard'] });
    await loginAs('kunde@zweit.de', 'kunde12345');
    memberToken = (await t.api.post('/api/mobile/pair', { device_name: 'Kunden-Handy' })).data.token;
    await loginAs('chef@example.com', 'geheim123');
  });

  it('scopes lists, details and writes to the member’s sub-account and areas', async () => {
    const me = (await get('/api/mobile/me', memberToken)).data;
    expect(me).toMatchObject({ agency: false, user: { role: 'member' } });
    expect(me.locations.map((l: any) => l.id)).toEqual([loc2]);
    expect(me.locations[0].areas).toEqual(expect.arrayContaining(['conversations', 'contacts', 'tasks', 'project']));
    expect(me.locations[0].areas).not.toContain('opportunities');
    expect((await get('/api/mobile/tasks', memberToken)).data.map((x: any) => x.location_id)).toEqual(expect.arrayContaining([loc2]));
    expect((await get('/api/mobile/tasks', memberToken)).data.every((x: any) => x.location_id === loc2)).toBe(true);
    expect((await get(`/api/mobile/tasks?location=${loc1}`, memberToken)).status).toBe(403);
    expect((await get('/api/mobile/inbox', memberToken)).data).toEqual([]);
    expect((await get('/api/mobile/contacts?q=anna', memberToken)).data).toEqual([]);
    const deals = await get('/api/mobile/deals', memberToken);
    expect(deals.status).toBe(403);
    expect(deals.data.error).toContain('Opportunities');
    expect((await get('/api/mobile/summary', memberToken)).data).toMatchObject({ leads_today: 0, open_deals_count: 0, revenue_month_cents: 0, unread_conversations: 0 });
    const convId = t.app.db.get('SELECT id FROM conversations WHERE location_id = ?', loc1)!.id;
    expect((await get(`/api/mobile/conversations/${convId}`, memberToken)).status).toBe(404);
    expect((await post(`/api/mobile/conversations/${convId}/reply`, { body: 'hack' }, memberToken)).status).toBe(404);
    const foreignTask = t.app.db.get('SELECT id FROM tasks WHERE location_id = ?', loc1)!.id;
    expect((await post(`/api/mobile/tasks/${foreignTask}/complete`, {}, memberToken)).status).toBe(404);
    expect((await post('/api/mobile/tasks', { location_id: loc1, title: 'x' }, memberToken)).status).toBe(403);
    expect((await post('/api/mobile/tasks', { location_id: loc2, title: 'Vom Kunden' }, memberToken)).status).toBe(200);
    expect((await app('PUT', '/api/mobile/app', memberToken)).status).toBe(403);
  });

  it('respects the SaaS plan: areas outside the plan and paused accounts', async () => {
    const plan = (await t.api.post('/api/saas/plans', { name: 'Mini', price_month: 9, features: ['dashboard', 'contacts'] })).data;
    expect((await t.api.put(`/api/saas/locations/${loc2}`, { plan_id: plan.id })).status).toBe(200);
    const inbox = await get('/api/mobile/inbox', memberToken);
    expect(inbox.status).toBe(403);
    expect(inbox.data.error).toContain('Tarif');
    expect((await get('/api/mobile/tasks', memberToken)).status).toBe(200);
    await t.api.put(`/api/saas/locations/${loc2}`, { plan_id: plan.id, status: 'paused' });
    const w = await post('/api/mobile/tasks', { location_id: loc2, title: 'Gesperrt' }, memberToken);
    expect(w.status).toBe(403);
    expect(w.data.error).toContain('pausiert');
    // The agency is never held back by the plan.
    expect((await post('/api/mobile/tasks', { location_id: loc2, title: 'Agentur darf' })).status).toBe(200);
    expect((await get(`/api/mobile/inbox?location=${loc2}`)).status).toBe(200);
    await t.api.del(`/api/saas/locations/${loc2}`);
  });
});

describe('feed', () => {
  it('starts with a cursor only and then delivers new events once', async () => {
    const first = (await get('/api/mobile/feed')).data;
    expect(first.events).toEqual([]);
    expect(first.cursor).toMatch(/^\d+$/);
    const memberCursor = (await get('/api/mobile/feed', memberToken)).data.cursor;

    receiveMessage(t.app, loc1, { channel: 'email', from: 'neu@kunde.de', subject: 'Anfrage', body: 'Ich hätte gern ein Angebot', name: 'Nina Neu' });
    const inv = (await t.api.post('/api/invoices', { items: [{ name: 'Pflege', qty: 1, price_cents: 5000, tax_rate: 0 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    t.app.events.emit(loc1, 'website.down', { website: 'https://alt.example.com', status: 503, ms: 50 });
    t.app.events.emit(loc1, 'call.missed', { callId: 'call1', from: '+491701112233', contactId: null });
    t.app.events.emit(loc1, 'google_review.received', { reviewId: 'g1', rating: 4, author: 'Gerd', text: 'Gut' });
    t.app.events.emit(loc2, 'contact.created', { contactId: 'x', contact: { id: 'x', first_name: 'Zora', source: 'Formular' } });
    await flush();

    const r = (await get(`/api/mobile/feed?since=${first.cursor}`)).data;
    const types = r.events.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(['lead', 'message', 'payment', 'website_down', 'call_missed', 'review']));
    const msg = r.events.find((e: any) => e.type === 'message');
    expect(msg).toEqual({ id: expect.stringMatching(/^\d+$/), type: 'message', title: 'Neue E-Mail von Nina Neu', body: 'Anfrage – Ich hätte gern ein Angebot', location_id: loc1, location_name: 'Testfirma', deep_link: expect.stringMatching(new RegExp(`^/app/conversations\\?c=\\w+&loc=${loc1}$`)), at: expect.any(String) });
    expect(r.events.find((e: any) => e.type === 'payment').title).toMatch(/^Zahlung erhalten: 50,00\s€$/);
    expect(r.events.find((e: any) => e.type === 'website_down').deep_link).toBe(`/app/project?loc=${loc1}`);
    expect(Number(r.cursor)).toBeGreaterThan(Number(first.cursor));
    expect((await get(`/api/mobile/feed?since=${r.cursor}`)).data.events).toEqual([]);
    // The client user only gets events of their own sub-account.
    const m = (await get(`/api/mobile/feed?since=${memberCursor}`, memberToken)).data;
    expect(m.events.map((e: any) => [e.type, e.location_id])).toEqual([['lead', loc2]]);
    // A cursor from the future (e.g. after a restore) resets without backlog.
    expect((await get('/api/mobile/feed?since=999999999')).data).toEqual({ cursor: r.cursor, events: [] });
  });

  it('reports due tasks once (assigned person only)', async () => {
    // Tasks from earlier tests may be due already (date-only tasks count from 08:00 local time) – report them first.
    t.app.services.mobileScanDue();
    const cursor = (await get('/api/mobile/feed')).data.cursor;
    await t.api.post('/api/tasks', { title: 'Gleich fällig', due_at: new Date(Date.now() - 60_000).toISOString() });
    expect(t.app.services.mobileScanDue()).toBe(1);
    expect(t.app.services.mobileScanDue()).toBe(0);
    const ev = (await get(`/api/mobile/feed?since=${cursor}`)).data.events;
    expect(ev).toEqual([expect.objectContaining({ type: 'task_due', title: 'Fällig: Gleich fällig', deep_link: `/app/tasks?loc=${loc1}` })]);
  });
});

describe('APK distribution & App Links', () => {
  const apk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(11 * 1024 * 1024)]);
  const put = (body: Buffer, headers: Record<string, string>, withSession = true) =>
    t.api.raw('/api/mobile/app', { method: 'PUT', headers: { ...(withSession ? { cookie: t.api.cookie, 'x-pghl': '1' } : {}), 'content-type': 'application/vnd.android.package-archive', ...headers }, body });

  it('has nothing to offer before the first upload', async () => {
    expect((await t.api.raw('/api/mobile/app')).status).toBe(404);
    expect((await t.api.raw('/downloads/gohigh.apk')).status).toBe(404);
    const page = await (await t.api.raw('/android')).text();
    expect(page).toContain('noch nicht verfügbar');
  });

  it('takes an admin upload (raw body, > 10 MB) and serves it with its SHA-256', async () => {
    // Without an admin login the big body is not even read (refused on the headers alone).
    expect((await put(apk, { 'x-version-code': '3', 'x-version-name': '1.0.0' }, false)).status).toBe(401);
    expect((await put(apk.subarray(0, 4096), { 'x-version-code': '3', 'x-version-name': '1.0.0' }, false)).status).toBe(401);
    expect((await put(Buffer.from('kein zip'.repeat(200)), { 'x-version-code': '3', 'x-version-name': '1.0.0' })).status).toBe(400);
    expect((await put(apk, { 'x-version-name': '1.0.0' })).status).toBe(400);
    const r = await put(apk, { 'x-version-code': '3', 'x-version-name': '1.0.0', 'x-changelog': encodeURIComponent('Erste Version – mit Widgets') });
    const data = await r.json();
    expect(r.status).toBe(200);
    expect(data).toMatchObject({ version_code: 3, version_name: '1.0.0', sha256: sha(apk), size: apk.length, changelog: 'Erste Version – mit Widgets', apk_url: 'http://localhost/downloads/gohigh.apk', min_supported_code: 0 });
    expect((await put(apk, { 'x-version-code': '2', 'x-version-name': '0.9' })).status).toBe(400);

    const meta = await (await t.api.raw('/api/mobile/app')).json();
    expect(meta).toEqual({ version_code: 3, version_name: '1.0.0', apk_url: 'http://localhost/downloads/gohigh.apk', sha256: sha(apk), size: apk.length, changelog: 'Erste Version – mit Widgets', min_supported_code: 0, uploaded_at: expect.any(String), page_url: 'http://localhost/android' });
    const dl = await t.api.raw('/downloads/gohigh.apk');
    expect(dl.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(dl.headers.get('content-disposition')).toContain('gohigh.apk');
    expect(sha(Buffer.from(await dl.arrayBuffer()))).toBe(sha(apk));
    expect((await get('/api/mobile/me')).data.app).toMatchObject({ version_code: 3, sha256: sha(apk) });
    // A device token may not upload.
    expect((await app('PUT', '/api/mobile/app', adminToken)).status).toBe(403);
  });

  it('shows a branded German download page with an inline QR code', async () => {
    await t.api.patch('/api/agency/branding', { name: 'HyperLevel', color: '#0f766e' });
    const r = await t.api.raw('/android');
    const page = await r.text();
    expect(r.headers.get('content-type')).toContain('text/html');
    expect(page).toContain('HyperLevel fürs Handy');
    expect(page).toContain('Version 1.0.0 (3)');
    expect(page).toContain('<svg');
    expect(page).toContain('href="/downloads/gohigh.apk"');
    expect(page).toContain('Apps aus dieser Quelle zulassen');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('publishes assetlinks.json for App Links', async () => {
    // Nothing is trusted until the self-hoster names their signing certificate.
    expect(await (await t.api.raw('/.well-known/assetlinks.json')).json()).toEqual([]);
    expect(normalizeFingerprint(CERT.replace(/:/g, '').toLowerCase())).toBe(CERT);
    expect((await t.api.put('/api/agency/mobile-app', { cert_sha256: CERT })).data.effective_package_name).toBe('org.gohigh.android');
    expect(await (await t.api.raw('/.well-known/assetlinks.json')).json()).toEqual([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'org.gohigh.android', sha256_cert_fingerprints: [CERT] } }]);
    expect((await t.api.put('/api/agency/mobile-app', { cert_sha256: 'AB:CD' })).status).toBe(400);
    const other = 'AA:'.repeat(31) + 'AA';
    const saved = await t.api.put('/api/agency/mobile-app', { cert_sha256: `${other}, ${CERT}` });
    expect(saved.data.effective_cert_sha256).toEqual([other, CERT]);
    expect((await (await t.api.raw('/.well-known/assetlinks.json')).json())[0].target.sha256_cert_fingerprints).toEqual([other, CERT]);
    await t.api.put('/api/agency/mobile-app', { cert_sha256: '' });
  });
});
