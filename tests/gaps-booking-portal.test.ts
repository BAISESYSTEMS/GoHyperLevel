import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256, token } from '../server/core/util.js';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/** "Meine Termine" in the customer portal (modules/portal-appointments.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let calId = '';
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['08:00', '18:00']]]));
const cookieFor = (contactId: string) => {
  const raw = token(32);
  t.app.db.run('INSERT INTO member_sessions (token_hash, location_id, contact_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(raw), loc, contactId, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return `pm_${loc}=${raw}`;
};
const get = async (path: string, cookie = '') => {
  const r = await t.api.raw(path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  return { status: r.status, html: await r.text() };
};

beforeAll(async () => {
  pinClock('2026-11-02T08:00:00Z');
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  calId = (await t.api.post('/api/calendars', { name: 'Beratung', duration: 30, min_notice: 0, availability: every, settings: { meeting_location: 'Praxis, Hauptstr. 1', confirmation_email: false } })).data.id;
});
afterAll(async () => {
  await t.close();
  unpinClock();
});

describe('appointments in the customer portal', () => {
  it('lists upcoming and past appointments with the manage link, and offers booking', async () => {
    const mia = (await t.api.post('/api/contacts', { first_name: 'Mia', email: 'mia@example.com' })).data.id;
    const ole = (await t.api.post('/api/contacts', { first_name: 'Ole', email: 'ole@example.com' })).data.id;
    const mk = (contact: string, start: string, title = 'Beratung <b>Mia</b>') => t.api.post('/api/appointments', { calendar_id: calId, contact_id: contact, start_at: start, end_at: new Date(Date.parse(start) + 30 * 60_000).toISOString(), title });
    expect((await mk(mia, '2026-11-05T09:00:00Z')).status).toBe(200);
    const old = await mk(mia, '2026-11-09T09:00:00Z', 'Erstgespräch');
    t.app.db.run(`UPDATE appointments SET start_at = '2026-10-20T09:00:00.000Z', end_at = '2026-10-20T09:30:00.000Z', status = 'showed' WHERE id = ?`, old.data.id);
    await mk(ole, '2026-11-06T09:00:00Z', 'Ole');
    await t.api.post('/api/service-menus', { name: 'Alle Leistungen', categories: [{ name: 'Beratung', calendar_ids: [calId] }] });

    const cookie = cookieFor(mia);
    const page = await get(`/portal/${loc}/appointments`, cookie);
    expect(page.status).toBe(200);
    expect(page.html).toContain('Meine Termine');
    expect(page.html).toContain('Praxis, Hauptstr. 1');
    expect(page.html).toContain('/book/manage/');
    expect(page.html).toContain('Vergangene Termine');
    expect(page.html).toContain('Wahrgenommen');
    expect(page.html).toContain('/book/s/alle-leistungen');
    expect(page.html).not.toContain('<b>Mia</b>');
    expect(page.html).not.toContain('Ole');
    const manage = t.app.db.get<any>(`SELECT manage_token FROM appointments WHERE contact_id = ? AND start_at = '2026-11-05T09:00:00.000Z'`, mia);
    expect(page.html).toContain(manage.manage_token);
    // The start page shows the next appointment and the header link.
    const start = await get(`/portal/${loc}`, cookie);
    expect(start.html).toContain('Nächster Termin');
    expect(start.html).toContain(`/portal/${loc}/appointments`);
    // Without a session: the login page.
    expect((await get(`/portal/${loc}/appointments`)).status).toBe(401);
  });
});

describe('tickets and check-in', () => {
  it('shows a ticket with QR code and checks in once by code', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Tom', last_name: 'Ticket', email: 'tom@example.com' })).data.id;
    const a = (await t.api.post('/api/appointments', { calendar_id: calId, contact_id: c, start_at: '2026-11-07T10:00:00Z', end_at: '2026-11-07T10:30:00Z' })).data;
    const tok = t.app.db.get<any>('SELECT manage_token FROM appointments WHERE id = ?', a.id).manage_token;
    const page = await get(`/book/ticket/${tok}`);
    expect(page.status).toBe(200);
    expect(page.html).toContain('<svg');
    expect(page.html).toContain(tok.slice(0, 10).toUpperCase());
    expect(page.html).toContain('Tom Ticket');
    expect((await get('/book/ticket/gibtsnicht')).status).toBe(404);
    expect((await t.api.post('/api/appointment-checkin', { code: 'zu-kurz' })).status).toBe(400);
    expect((await t.api.post('/api/appointment-checkin', { code: 'XXXXXXXXXXXX' })).status).toBe(404);
    const first = await t.api.post('/api/appointment-checkin', { code: tok.slice(0, 10).toLowerCase() });
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    expect(first.data).toMatchObject({ status: 'checked_in', name: 'Tom Ticket' });
    expect(t.app.db.get<any>('SELECT status FROM appointments WHERE id = ?', a.id).status).toBe('showed');
    const again = await t.api.post('/api/appointment-checkin', { code: `${t.app.baseUrl()}/book/ticket/${tok}` });
    expect(again.data.status).toBe('already');
    expect((await get(`/book/ticket/${tok}`)).html).toContain('Eingecheckt am');
    const sum = (await t.api.get(`/api/appointment-checkin/summary?date=2026-11-07&calendar_id=${calId}`)).data;
    expect(sum).toMatchObject({ total: 1, checked_in: 1 });
    // Another sub-account cannot check in this ticket.
    const other = (await t.api.post('/api/locations', { name: 'Fremd' })).data.id;
    t.api.setLocation(other);
    expect((await t.api.post('/api/appointment-checkin', { code: tok })).status).toBe(404);
    t.api.setLocation(loc);
    expect((t.app.services.mcpTools as any[]).some((x) => x.name === 'ghl_appointment_checkin')).toBe(true);
  });
});
