import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/** Calendar view: grid data with overlays, conflict check, booking from a slot, drag & drop (move/resize), drawer, invoice. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let calId = '';
let otherCal = '';
let contactId = '';
let userId = '';
const weekdays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, [['09:00', '17:00']]]));
const mails = (subject: string) => t.app.db.all<any>(`SELECT * FROM messages WHERE channel = 'email' AND subject LIKE ?`, `${subject}%`);
const settle = () => new Promise((r) => setTimeout(r, 60));

beforeAll(async () => {
  pinClock('2026-10-12T05:00:00Z'); // Monday 07:00 in Berlin
  t = await startTestApp();
  const me = await t.setup();
  userId = me.user.id;
  calId = (
    await t.api.post('/api/calendars', {
      name: 'Beratung',
      duration: 60,
      interval: 60,
      buffer: 15,
      min_notice: 0,
      max_days: 120,
      availability: weekdays,
      color: '#0ea5e9',
      settings: { notify_team: false },
    })
  ).data.id;
  otherCal = (await t.api.post('/api/calendars', { name: 'Telefonat', duration: 30, min_notice: 0, availability: weekdays, settings: { notify_team: false, confirmation_email: false } })).data.id;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Klara', last_name: 'Kalender', email: 'klara@example.com', phone: '+4915112345678' })).data.id;
});
afterAll(async () => {
  await t.close();
  unpinClock();
});

describe('calendar view data', () => {
  it('returns appointments, buffers, bookable hours, busy times and absences of the week in the sub-account zone', async () => {
    const a = (await t.api.post('/api/appointments', { calendar_id: calId, contact_id: contactId, start: '2026-10-13T08:00:00Z', notes: 'Erstgespräch', force: true })).data;
    await t.api.post('/api/appointments', { calendar_id: otherCal, blocked: true, title: 'Mittag', start: '2026-10-14T10:00:00Z', end: '2026-10-14T11:00:00Z' });
    // A busy time of the calendar's iCal import and an absence of the team member.
    t.app.db.insert('external_busy', {
      calendar_id: calId,
      start_at: '2026-10-15T12:00:00.000Z',
      end_at: '2026-10-15T13:00:00.000Z',
      summary: 'privat',
      source: 'https://example.com/x.ics',
      fetched_at: new Date().toISOString(),
    });
    expect((await t.api.post('/api/team-people/me/away', { start_at: '2026-10-16T00:00:00Z', end_at: '2026-10-17T00:00:00Z', note: 'Fortbildung' })).status).toBe(200);
    const r = await t.api.get('/api/calendar-view?from=2026-10-11T22:00:00Z&to=2026-10-18T22:00:00Z');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const v = r.data;
    expect(v.timezone).toBe('Europe/Berlin');
    expect(v.days).toEqual({ first: '2026-10-12', last: '2026-10-18' });
    expect(v.calendars.map((c: any) => c.name)).toEqual(['Beratung', 'Telefonat']);
    expect(v.appointments.find((x: any) => x.id === a.id)).toMatchObject({ contact_name: 'Klara Kalender', email: 'klara@example.com', status: 'confirmed', notes: 'Erstgespräch', series_id: null });
    expect(v.appointments.find((x: any) => x.status === 'blocked')).toMatchObject({ title: 'Mittag', calendar_id: otherCal });
    expect(v.buffers.filter((b: any) => b.appointment_id === a.id)).toEqual([
      { appointment_id: a.id, calendar_id: calId, side: 'before', start_at: '2026-10-13T07:45:00.000Z', end_at: '2026-10-13T08:00:00.000Z' },
      { appointment_id: a.id, calendar_id: calId, side: 'after', start_at: a.end_at, end_at: '2026-10-13T09:15:00.000Z' },
    ]);
    expect(v.hours[calId]).toHaveLength(5);
    expect(v.hours[calId][0]).toEqual({ start_at: '2026-10-12T07:00:00.000Z', end_at: '2026-10-12T15:00:00.000Z' });
    expect(v.busy).toContainEqual({ calendar_id: calId, start_at: '2026-10-15T12:00:00.000Z', end_at: '2026-10-15T13:00:00.000Z' });
    expect(v.absences).toContainEqual(expect.objectContaining({ user_id: userId, note: 'Fortbildung', source: 'manual' }));
    expect(v.users.map((u: any) => u.id)).toContain(userId);
  });

  it('filters by calendar, status and layers; caps the range', async () => {
    const only = (await t.api.get(`/api/calendar-view?from=2026-10-11T22:00:00Z&to=2026-10-18T22:00:00Z&calendars=${otherCal}&layers=`)).data;
    expect(only.appointments.every((a: any) => a.calendar_id === otherCal)).toBe(true);
    expect(only.busy).toEqual([]);
    expect(only.absences).toEqual([]);
    expect(Object.keys(only.hours)).toEqual([otherCal]);
    const blocked = (await t.api.get('/api/calendar-view?from=2026-10-11T22:00:00Z&to=2026-10-18T22:00:00Z&status=blocked')).data;
    expect(blocked.appointments.map((a: any) => a.status)).toEqual(['blocked']);
    const long = (await t.api.get('/api/calendar-view?from=2026-01-01T00:00:00Z&to=2027-12-31T00:00:00Z')).data;
    expect(long.days.last).toBe('2026-03-04');
    expect((await t.api.get('/api/calendar-view?from=2026-10-18T00:00:00Z&to=2026-10-11T00:00:00Z')).status).toBe(400);
  });
});

describe('conflict check and booking from an empty slot', () => {
  it('names what is in the way: another appointment, its buffer, the hours, a busy time, the day limit', async () => {
    const check = (start: string, end?: string, extra: Record<string, unknown> = {}) => t.api.post('/api/calendar-view/check', { calendar_id: calId, start, end, ...extra }).then((r) => r.data);
    expect(await check('2026-10-13T08:30:00Z')).toMatchObject({ ok: false, issues: [expect.objectContaining({ kind: 'appointment', label: 'Beratung – Klara Kalender' })] });
    expect((await check('2026-10-13T09:00:00Z')).issues.map((i: any) => i.kind)).toEqual(['buffer']);
    expect((await check('2026-10-13T16:30:00Z')).issues.map((i: any) => i.kind)).toEqual(['hours']);
    expect((await check('2026-10-15T12:00:00Z')).issues.map((i: any) => i.kind)).toEqual(['busy']);
    expect(await check('2026-10-13T11:00:00Z')).toEqual({ ok: true, issues: [], message: '' });
    await t.api.patch(`/api/calendars/${calId}`, { settings: { limit_day: 1 } });
    expect((await check('2026-10-13T12:00:00Z')).issues.map((i: any) => i.kind)).toEqual(['limit']);
    await t.api.patch(`/api/calendars/${calId}`, { settings: { limit_day: 0 } });
  });

  it('books from a slot (409 with reasons, then force), with its own length, and blocks time', async () => {
    const r = await t.api.post('/api/calendar-view/book', { calendar_id: calId, start: '2026-10-13T08:30:00Z', contact_id: contactId });
    expect(r.status).toBe(409);
    expect(r.data.issues.map((i: any) => i.kind)).toEqual(['appointment']);
    expect(r.data.error).toContain('überschneidet sich');
    const ok = await t.api.post('/api/calendar-view/book', {
      calendar_id: calId,
      start: '2026-10-14T11:00:00Z',
      end: '2026-10-14T12:30:00Z',
      contact: { first_name: 'Neu', email: 'neu@example.com' },
      notes: 'Vom Raster',
    });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data).toMatchObject({ start_at: '2026-10-14T11:00:00.000Z', end_at: '2026-10-14T12:30:00.000Z', status: 'confirmed', notes: 'Vom Raster' });
    const forced = await t.api.post('/api/calendar-view/book', { calendar_id: calId, start: '2026-10-13T16:00:00Z', contact_id: contactId, force: true });
    expect(forced.status).toBe(200);
    const block = await t.api.post('/api/calendar-view/book', { calendar_id: calId, start: '2026-10-16T05:00:00Z', end: '2026-10-16T06:00:00Z', blocked: true, title: 'Frühsport' });
    expect(block.status, JSON.stringify(block.data)).toBe(200);
    expect(block.data).toMatchObject({ status: 'blocked', title: 'Frühsport' });
    expect((await t.api.post('/api/calendar-view/book', { calendar_id: calId, start: '2026-10-14T13:00:00Z' })).data.error).toBe('Kontakt fehlt');
  });
});

describe('drag & drop', () => {
  let appt: any;
  beforeAll(async () => {
    appt = (await t.api.post('/api/appointments', { calendar_id: calId, contact_id: contactId, start: '2026-10-19T08:00:00Z', force: true })).data;
  });

  it('a plain move goes through the reschedule logic: the contact gets the "verschoben" e-mail', async () => {
    const before = mails('Termin verschoben').length;
    const r = await t.api.post(`/api/calendar-view/appointments/${appt.id}/move`, { start: '2026-10-19T10:00:00Z' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ via: 'reschedule', notified: true, appointment: { start_at: '2026-10-19T10:00:00.000Z', end_at: '2026-10-19T11:00:00.000Z' } });
    await settle();
    expect(mails('Termin verschoben').length).toBe(before + 1);
  });

  it('refuses a conflicting drop with the reasons and takes it with force', async () => {
    const other = (await t.api.post('/api/appointments', { calendar_id: calId, contact_id: contactId, start: '2026-10-20T08:00:00Z', force: true })).data;
    const r = await t.api.post(`/api/calendar-view/appointments/${appt.id}/move`, { start: '2026-10-20T08:30:00Z' });
    expect(r.status).toBe(409);
    expect(r.data.issues).toContainEqual(expect.objectContaining({ kind: 'appointment', id: other.id }));
    const f = await t.api.post(`/api/calendar-view/appointments/${appt.id}/move`, { start: '2026-10-20T08:30:00Z', force: true, notify: false });
    expect(f.status).toBe(200);
    expect(f.data).toMatchObject({ via: 'override', notified: false });
  });

  it('resizes (end only) and moves off the slot grid without the reschedule logic', async () => {
    const r = await t.api.post(`/api/calendar-view/appointments/${appt.id}/move`, { start: '2026-10-21T09:15:00Z', end: '2026-10-21T10:45:00Z' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ via: 'update', appointment: { start_at: '2026-10-21T09:15:00.000Z', end_at: '2026-10-21T10:45:00.000Z' } });
    const rs = await t.api.post(`/api/calendar-view/appointments/${appt.id}/move`, { end: '2026-10-21T11:15:00Z' });
    expect(rs.data.appointment.end_at).toBe('2026-10-21T11:15:00.000Z');
    expect((await t.api.post(`/api/calendar-view/appointments/${appt.id}/move`, { start: '2026-10-21T12:00:00Z', end: '2026-10-21T11:00:00Z' })).status).toBe(400);
  });

  it('a moved series appointment becomes an exception; cancelled ones do not move', async () => {
    const s = (
      await t.api.post('/api/appointment-series', {
        calendar_id: otherCal,
        contact_id: contactId,
        start: '2026-10-22T07:00:00Z',
        recurrence: { freq: 'weekly', end: { type: 'count', count: 3 } },
        notify: false,
        force: true,
      })
    ).data;
    const occ = s.appointments[1];
    const r = await t.api.post(`/api/calendar-view/appointments/${occ.id}/move`, { start: '2026-10-29T12:00:00Z', notify: false });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(t.app.db.get<any>('SELECT series_exception FROM appointments WHERE id = ?', occ.id).series_exception).toBe(1);
    await t.api.patch(`/api/appointments/${s.appointments[2].id}`, { status: 'cancelled' });
    expect((await t.api.post(`/api/calendar-view/appointments/${s.appointments[2].id}/move`, { start: '2026-11-05T12:00:00Z' })).status).toBe(409);
  });
});

describe('drawer and invoice', () => {
  it('shows contact, people, payment, series and the links; creates and links an invoice draft once', async () => {
    const a = (await t.api.post('/api/appointments', { calendar_id: calId, contact_id: contactId, start: '2026-10-23T08:00:00Z', force: true })).data;
    const d = (await t.api.get(`/api/calendar-view/appointments/${a.id}`)).data;
    expect(d).toMatchObject({ calendar: { id: calId, name: 'Beratung' }, contact: { id: contactId, email: 'klara@example.com' }, payment: null, invoice: null, can_invoice: true, series: null });
    expect(d.links.reschedule_url).toBe(`http://localhost/book/move/${a.manage_token}`);
    expect(d.links.cancel_url).toBe(`http://localhost/book/manage/${a.manage_token}`);
    const inv = await t.api.post(`/api/calendar-view/appointments/${a.id}/invoice`);
    expect(inv.status, JSON.stringify(inv.data)).toBe(200);
    expect(inv.data).toMatchObject({ status: 'draft', link: `/app/invoices/${inv.data.invoice_id}` });
    expect((await t.api.get(`/api/calendar-view/appointments/${a.id}`)).data.invoice).toMatchObject({ id: inv.data.invoice_id, status: 'draft' });
    expect((await t.api.post(`/api/calendar-view/appointments/${a.id}/invoice`)).status).toBe(409);
  });

  it('members need the calendar area; the invoice part needs the payments area', async () => {
    const a = (await t.api.get('/api/calendar-view?from=2026-10-22T22:00:00Z&to=2026-10-23T22:00:00Z')).data.appointments.find((x: any) => x.calendar_id === calId);
    await t.api.post('/api/users', { email: 'kal@example.com', name: 'Kal', password: 'geheim123', role: 'member', locations: [t.api.location], permissions: ['calendars'] });
    await t.api.post('/api/users', { email: 'none@example.com', name: 'Nix', password: 'geheim123', role: 'member', locations: [t.api.location], permissions: ['contacts'] });
    const loc = t.api.location;
    const login = async (email: string) => {
      t.api.clearCookie();
      expect((await t.api.post('/api/auth/login', { email, password: 'geheim123' })).status).toBe(200);
      t.api.setLocation(loc);
    };
    await login('kal@example.com');
    const d = (await t.api.get(`/api/calendar-view/appointments/${a.id}`)).data;
    expect(d.invoice).toBeNull();
    expect(d.can_invoice).toBe(false);
    expect((await t.api.post(`/api/calendar-view/appointments/${a.id}/invoice`)).status).toBe(403);
    await login('none@example.com');
    expect((await t.api.get('/api/calendar-view')).status).toBe(403);
    await login('chef@example.com');
  });
});

describe('the links in a confirmation', () => {
  it('the reschedule page opens the picker of free times; unknown tokens are a 404', async () => {
    const a = (await t.api.post('/api/appointments', { calendar_id: calId, contact_id: contactId, start: '2026-10-26T09:00:00Z', force: true })).data;
    const page = await t.api.raw(`/book/move/${a.manage_token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Termin verschieben');
    expect(html).toContain("document.getElementById('move')");
    expect((await t.api.raw('/book/move/doesnotexist')).status).toBe(404);
    const slots = (await t.api.get(`/api/public/team-calendars/manage/${a.manage_token}/slots?from=2026-10-27`)).data;
    expect(slots.days.length).toBeGreaterThan(0);
  });
});
