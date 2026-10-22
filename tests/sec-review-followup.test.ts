import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import { upsertContact } from '../server/services/contacts.js';
import { sampleFor } from '../server/services/werkstatt/ops.js';

/**
 * Follow-ups of the October 2026 security review (docs/security-review-2026-10.md): public input never changes a contact's e-mail
 * address or phone number (O-2), a disk quota for files anonymous visitors upload through forms, and "today" in the sub-account's
 * time zone for the remaining places (the plugin workshop's sample data, the accounting's default year). The cloud sign-up (O-1) is in
 * tests/sec-review-signup.test.ts.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const PNG_HEAD = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/** A PNG of about `kb` kilobytes (a real header, padding after the end chunk). */
const png = (kb: number) => `data:image/png;base64,${Buffer.concat([PNG_HEAD, Buffer.alloc(Math.max(0, kb * 1024 - PNG_HEAD.length))]).toString('base64')}`;
const submit = (id: string, body: unknown) => t.api.raw(`/api/public/forms/${id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const contact = (where: string, ...p: unknown[]) => t.app.db.get<any>(`SELECT * FROM contacts WHERE location_id = ? AND ${where}`, loc, ...p);

beforeAll(async () => {
  process.env.PGHL_FORMS_PER_MINUTE = '10000';
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
}, 60_000);
afterAll(async () => {
  delete process.env.PGHL_FORMS_PER_MINUTE;
  delete process.env.PGHL_PUBLIC_UPLOADS_MB;
  unpinClock();
  await t.close();
});

describe('O-2: public input never changes who a contact is', () => {
  let formId = '';
  beforeAll(async () => {
    const f = await t.api.post('/api/forms', {
      name: 'Rückruf',
      fields: [
        { id: 'a', type: 'email', label: 'E-Mail', name: 'email' },
        { id: 'b', type: 'phone', label: 'Telefon', name: 'phone' },
        { id: 'c', type: 'text', label: 'Vorname', name: 'first_name' },
      ],
    });
    expect(f.status, f.text).toBe(200);
    formId = f.data.id;
    expect((await t.api.post('/api/contacts', { first_name: 'Anna', email: 'anna@kundin.de', phone: '0151 1111111' })).status).toBe(200);
  });

  it('a form with a known number and another address creates a new contact instead of replacing the e-mail', async () => {
    const r = await submit(formId, { email: 'mallory@angreifer.de', phone: '+49 151 1111111', first_name: 'Mallory' });
    expect(r.status).toBe(200);
    const anna = contact('first_name = ?', 'Anna');
    expect(anna.email).toBe('anna@kundin.de');
    const mallory = contact('email = ?', 'mallory@angreifer.de');
    expect(mallory).toBeTruthy();
    expect(mallory.id).not.toBe(anna.id);
    expect(mallory.phone).toBe(anna.phone);
    // the team sees why there are two (and the duplicate check pairs them)
    expect(t.app.db.get(`SELECT 1 AS x FROM activities WHERE contact_id = ? AND type = 'contact.possible_duplicate'`, mallory.id)).toBeTruthy();
    const dups = await t.api.get(`/api/contact-duplicates/for?contact_id=${mallory.id}`);
    expect(dups.status, dups.text).toBe(200);
    expect(JSON.stringify(dups.data)).toContain(anna.id);
  });

  it('a form with a known address and another number keeps the number and notes the new one as unverified', async () => {
    const r = await submit(formId, { email: 'anna@kundin.de', phone: '0170 9999999', first_name: 'Anna' });
    expect(r.status).toBe(200);
    const anna = contact('first_name = ? AND email = ?', 'Anna', 'anna@kundin.de');
    expect(anna.phone).toBe('+491511111111');
    const note = t.app.db.get<any>(`SELECT * FROM activities WHERE contact_id = ? AND type = 'contact.unverified_alternative'`, anna.id);
    expect(note?.summary).toMatch(/Telefonnummer.*nicht übernommen.*\+491709999999/);
    // the same number in another notation is no alternative
    const before = t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'contact.unverified_alternative'`, anna.id)!.n;
    expect((await submit(formId, { email: 'anna@kundin.de', phone: '+49 (151) 111 1111' })).status).toBe(200);
    expect(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'contact.unverified_alternative'`, anna.id)!.n).toBe(before);
  });

  it('fills an empty number, and a number alone still finds its contact', async () => {
    expect((await t.api.post('/api/contacts', { first_name: 'Ben', email: 'ben@kunde.de' })).status).toBe(200);
    expect((await submit(formId, { email: 'ben@kunde.de', phone: '0160 2222222' })).status).toBe(200);
    const ben = contact('email = ?', 'ben@kunde.de');
    expect(ben.phone).toBe('+491602222222');
    const n = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE location_id = ?', loc)!.n;
    expect((await submit(formId, { phone: '0160 2222222', first_name: 'Ben' })).status).toBe(200);
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE location_id = ?', loc)!.n).toBe(n);
    expect(contact('id = ?', ben.id).email).toBe('ben@kunde.de');
  });

  it('the public booking page cannot take over a contact by its number either', async () => {
    const cal = (
      await t.api.post('/api/calendars', {
        name: 'Beratung O2',
        duration: 30,
        min_notice: 0,
        availability: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]])),
        settings: { reminder_hours: 0 },
      })
    ).data;
    const slots = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?days=3`)).data;
    const start = slots.days.flatMap((d: any) => d.slots)[0];
    const carla = (await t.api.post('/api/contacts', { first_name: 'Carla', email: 'carla@kundin.de', phone: '0152 5555555' })).data;
    const r = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start, first_name: 'Eve', email: 'eve@angreifer.de', phone: '0152 5555555' });
    expect(r.status, r.text).toBe(200);
    expect(contact('id = ?', carla.id)).toMatchObject({ first_name: 'Carla', email: 'carla@kundin.de' });
    const appt = t.app.db.get<any>('SELECT contact_id FROM appointments WHERE id = ?', r.data.id);
    expect(contact('id = ?', appt.contact_id).email).toBe('eve@angreifer.de');
  });

  it('a chat visitor who types a known address does not read that contact’s earlier chats', async () => {
    await t.api.patch('/api/location', { settings: { chat: { enabled: true } } });
    const first = await t.api.post(`/api/public/chat/${loc}/messages`, { body: 'Meine Rechnung 4711 stimmt nicht', email: 'anna@kundin.de', name: 'Anna' });
    expect(first.status, first.text).toBe(200);
    const anna = contact('first_name = ? AND email = ?', 'Anna', 'anna@kundin.de');
    const conv = t.app.db.get<any>('SELECT id FROM conversations WHERE contact_id = ?', anna.id);
    t.app.db.insert('messages', { id: 'reply-anna-1', location_id: loc, conversation_id: conv.id, contact_id: anna.id, channel: 'chat', direction: 'out', subject: '', body: 'Ihre neue IBAN ist notiert', status: 'sent', error: '', source: 'Team', created_at: new Date().toISOString() });
    // the real visitor still sees the whole conversation
    const own = await t.api.get(`/api/public/chat/${loc}/messages?visitor=${first.data.visitor}`);
    expect(own.data.messages.map((m: any) => m.body)).toEqual(['Meine Rechnung 4711 stimmt nicht', 'Ihre neue IBAN ist notiert']);
    await new Promise((r) => setTimeout(r, 5));
    const other = await t.api.post(`/api/public/chat/${loc}/messages`, { body: 'Hallo', email: 'anna@kundin.de', name: 'Mallory' });
    const seen = await t.api.get(`/api/public/chat/${loc}/messages?visitor=${other.data.visitor}`);
    expect(seen.data.messages.map((m: any) => m.body)).toEqual(['Hallo']);
  });

  it('nor does the chat bot tell such a visitor what it knows about the contact (other channels, stored numbers)', async () => {
    const prompts: string[] = [];
    t.app.services.aiFetch = (async (_url: string, init: any) => {
      prompts.push(JSON.stringify(JSON.parse(init.body).messages));
      const reply = { reply: 'Gern!', confidence: 0.9, handoff: false, handoff_reason: '', lead: { first_name: '', last_name: '', email: '', phone: '' }, buying_intent: false, intent_summary: '' };
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect((await t.api.put('/api/ai/settings', { api_key: 'sk-ant-api03-testkey-abcdefghijklmnopqrstuvwxyz0123', enabled: true, bot_mode: 'always' })).status).toBe(200);
    const dora = (await t.api.post('/api/contacts', { first_name: 'Dora', email: 'dora@kundin.de', phone: '0176 4444444' })).data;
    const conv = t.app.db.get<any>('SELECT id FROM conversations WHERE contact_id = ?', dora.id) ?? { id: 'conv-dora' };
    if (conv.id === 'conv-dora') t.app.db.insert('conversations', { id: conv.id, location_id: loc, contact_id: dora.id, unread: 0, last_message: '', last_message_at: new Date().toISOString(), created_at: new Date().toISOString() });
    t.app.db.insert('messages', { id: 'sms-dora-1', location_id: loc, conversation_id: conv.id, contact_id: dora.id, channel: 'sms', direction: 'in', subject: '', body: 'Mein Türcode ist 4711', status: 'received', error: '', source: 'SMS', created_at: new Date(Date.now() - 60_000).toISOString() });
    await new Promise((r) => setTimeout(r, 5));
    const v = await t.api.post(`/api/public/chat/${loc}/messages`, { body: 'Wie war nochmal mein Türcode?', email: 'dora@kundin.de', name: 'Dora' });
    expect(v.status, v.text).toBe(200);
    await t.app.events.flush();
    expect(prompts.length).toBeGreaterThan(0);
    const prompt = prompts.join('\n');
    expect(prompt).toContain('Wie war nochmal mein Türcode?');
    expect(prompt).not.toContain('4711');
    expect(prompt).not.toContain('4444444');
    expect(prompt).not.toContain('dora@kundin.de');
    await t.api.put('/api/ai/settings', { enabled: false, bot_mode: 'off' });
  });

  it('the rule is an option: the team’s own changes (API, import) still update the fields', async () => {
    const r = await t.api.post('/api/contacts', { email: 'anna@kundin.de', phone: '0170 3333333' });
    expect(r.status).toBe(200);
    expect(contact('email = ?', 'anna@kundin.de').phone).toBe('+491703333333');
    // and the service itself: an unproven e-mail on a contact found by id is never written over a stored one
    const c = contact('email = ?', 'anna@kundin.de');
    const out = upsertContact(t.app, loc, { id: c.id, email: 'neu@angreifer.de', first_name: 'Anna' }, { source: 'Live-Chat', publicInput: true });
    expect(out.contact.email).toBe('anna@kundin.de');
  });
});

describe('disk quota for public form uploads', () => {
  it('refuses with 413 above the cap and tells the team at 90 % and 100 %', async () => {
    const f = await t.api.post('/api/forms', { name: 'Bewerbung', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email' }, { id: 'b', type: 'file', label: 'Lebenslauf', name: 'cv' }] });
    expect(f.status).toBe(200);
    const notices = () => t.app.db.all<any>(`SELECT title FROM push_log WHERE kind = 'storage' AND location_id = ? ORDER BY created_at`, loc).map((r) => r.title as string);
    process.env.PGHL_PUBLIC_UPLOADS_MB = String(100 / 1024); // 100 KB per sub-account
    try {
      expect((await submit(f.data.id, { email: 'a1@bewerber.de', cv: { name: 'cv.png', data: png(60) } })).status).toBe(200);
      expect(notices()).toEqual([]);
      expect((await submit(f.data.id, { email: 'a2@bewerber.de', cv: { name: 'cv.png', data: png(32) } })).status).toBe(200);
      expect(notices()).toEqual([expect.stringMatching(/zu 90 % belegt/)]);
      const full = await submit(f.data.id, { email: 'a3@bewerber.de', cv: { name: 'cv.png', data: png(20) } });
      expect(full.status).toBe(413);
      expect((await full.json()).error).toMatch(/Speicherplatz für Uploads ist voll/);
      // nothing of the refused submission was written
      expect(t.app.db.get(`SELECT 1 AS x FROM contacts WHERE email = 'a3@bewerber.de'`)).toBeUndefined();
      expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM form_files WHERE location_id = ?', loc)!.n).toBe(2);
      // told once per level, not on every refused upload
      expect((await submit(f.data.id, { email: 'a4@bewerber.de', cv: { name: 'cv.png', data: png(20) } })).status).toBe(413);
      expect(notices()).toEqual([expect.stringMatching(/zu 90 % belegt/), expect.stringMatching(/ist voll/)]);
      // a submission without a file still goes through
      expect((await submit(f.data.id, { email: 'a5@bewerber.de' })).status).toBe(200);
      // files deleted: below 90 % the levels are armed again
      t.app.db.run('DELETE FROM form_files WHERE location_id = ?', loc);
      expect((await submit(f.data.id, { email: 'a6@bewerber.de', cv: { name: 'cv.png', data: png(10) } })).status).toBe(200);
      expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM public_upload_alerts WHERE location_id = ?', loc)!.n).toBe(0);
    } finally {
      delete process.env.PGHL_PUBLIC_UPLOADS_MB;
    }
  });
});

describe('today in the sub-account’s time zone (00:30 on 1 January in Berlin)', () => {
  afterEach(() => unpinClock());

  it('the plugin workshop’s sample data counts days in the sub-account’s zone', () => {
    pinClock('2026-12-31T23:30:00Z');
    const list = sampleFor('contacts.list', 'Europe/Berlin') as { contacts: { date_of_birth: string | null; created_at: string }[] };
    // demo-c1 has its birthday "today" – the plugin's context says today = 2027-01-01 there
    expect(list.contacts[0].date_of_birth).toBe('1988-01-01');
    expect(list.contacts[0].created_at.slice(0, 10)).toBe('2026-12-02');
  });

  it('the accounting’s default year is the local one', async () => {
    expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    // the test login must outlive the jump to New Year's Eve
    t.app.db.run(`UPDATE sessions SET expires_at = '2099-01-01T00:00:00.000Z'`);
    pinClock('2026-12-31T23:30:00Z');
    expect((await t.api.get('/api/accounting/periods')).data.year).toBe(2027);
    const sum = await t.api.get('/api/accounting/summary');
    expect(sum.status, sum.text).toBe(200);
    expect(sum.data).toMatchObject({ from: '2027-01-01', to: '2027-12-31' });
    const susa = await t.api.get('/api/accounting/datev/preview');
    expect(susa.data).toMatchObject({ from: '2027-01-01', to: '2027-12-31' });
  });
});
