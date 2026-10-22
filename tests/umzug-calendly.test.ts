import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointmentOf, calendarOf, contactOf, locationText, rulesToHours, uuidOf } from '../server/services/umzug-calendly.js';
import { CALENDLY_TOKEN, FakeCalendly } from './umzug3-fakes.js';
import { umzugHarness, type Harness } from './umzug2-harness.js';

let h: Harness;
const fake = new FakeCalendly();
let imported: any;
const ALL = ['calendars', 'appointments', 'contacts'];
const creds = { token: CALENDLY_TOKEN };
const cal = (name: string) => h.one('SELECT * FROM calendars WHERE location_id = ? AND name = ?', name);
const appts = () => h.q('SELECT a.*, c.name AS cal FROM appointments a JOIN calendars c ON c.id = a.calendar_id WHERE a.location_id = ? ORDER BY a.start_at, a.title');

beforeAll(async () => {
  h = await umzugHarness();
  h.t.app.services.umzugFetch = fake.fetch;
  await h.fresh('Calendly');
});
afterAll(() => h.t.close());

describe('Calendly: pure parts', () => {
  it('reads uuids and locations', () => {
    expect(uuidOf('https://api.calendly.com/event_types/ABC-1')).toBe('ABC-1');
    expect(locationText({ type: 'zoom_conference' })).toBe('Zoom');
    expect(locationText({ type: 'physical', location: 'Musterstr. 1' })).toBe('Vor Ort: Musterstr. 1');
    expect(locationText(undefined)).toBe('');
  });
  it('turns rules into weekly hours and date-specific hours', () => {
    const h2 = rulesToHours(fake.availability.ET1.rules);
    expect(h2.availability).toEqual({ mon: [['09:00', '12:00'], ['13:00', '17:00']], fri: [['09:00', '12:00']] });
    expect(h2.date_overrides['2099-12-24']).toEqual([]);
    expect(h2.date_overrides['2099-12-27']).toEqual([['10:00', '23:59']]);
  });
  it('builds a calendar from an event type', () => {
    const c = calendarOf(fake.eventTypes[1], undefined, 'Europe/Berlin');
    expect(c).toMatchObject({ ext: 'et:ET2', name: 'Beratung vor Ort', duration: 60, timezone: 'Europe/Berlin', location: 'Vor Ort: Musterstr. 1, 10115 Berlin' });
    expect(c.description).toContain('Round Robin');
    expect(c.description).toContain('bei Calendly deaktiviert');
  });
  it('builds an appointment per invitee with answers, location and cancellation in the notes', () => {
    const a = appointmentOf(fake.events[0], fake.invitees.E1[0], 'et:ET1');
    expect(a).toMatchObject({ ext: 'E1:I1', calendar: 'et:ET1', title: 'Erstgespräch – Anna Alt', status: 'confirmed', contact: 'i:anna@example.com' });
    expect(a.notes).toContain('Ort: Zoom: https://zoom.us/j/123');
    expect(a.notes).toContain('Worum geht es?: Preise');
    expect(a.notes).toContain('Notizen: Preise besprochen');
    expect(a.notes).toContain('Gastgeber: Chef');
    const c = appointmentOf(fake.events[1], fake.invitees.E2[0], 'et:ET1');
    expect(c.status).toBe('cancelled');
    expect(c.notes).toContain('Abgesagt von Anna Alt: Krank');
    expect(appointmentOf(fake.events[3], undefined, 'et:ET9')).toMatchObject({ ext: 'E4', title: 'Altes Format', contact: undefined });
  });
  it('builds a contact that has given no advertising consent', () => {
    const c = contactOf(fake.invitees.E1[0])!;
    expect(c).toMatchObject({ ext: 'i:anna@example.com', values: { email: 'Anna@Example.com', first_name: 'Anna', last_name: 'Alt', phone: '+49 30 1234567' } });
    expect(c.proof).toMatchObject([{ basis: 'none' }]);
    expect(contactOf({ name: 'Ohne Mail' })).toBeUndefined();
  });
});

describe('Calendly: connect and preview', () => {
  it('refuses a wrong token, connects with the right one without returning it', async () => {
    expect((await h.t.api.put('/api/umzug/connections/calendly', { token: 'falsch' })).status).toBe(400);
    const r = await h.t.api.put('/api/umzug/connections/calendly', creds);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ account: 'cal-ORG1' });
    expect(JSON.stringify(r.data)).not.toContain(CALENDLY_TOKEN);
    expect(fake.requests.every((q) => q.url.hostname === 'api.calendly.com')).toBe(true);
  });
  it('counts event types and events', async () => {
    const r = await h.t.api.post('/api/umzug/preview', { source: 'calendly', parts: ALL });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const total = (k: string) => r.data.counts.find((c: any) => c.key === k)?.total;
    expect(total('event_types')).toBe(3);
    expect(total('events')).toBe(4);
    expect(r.data.fields.map((f: any) => f.ref)).toEqual(['email', 'first_name', 'last_name', 'phone']);
  });
});

describe('Calendly: import', () => {
  it('a dry run writes nothing', async () => {
    const job = await h.run({ source: 'calendly', parts: ALL }, 'dry-run');
    expect(job.status, job.error).toBe('done');
    expect(h.count('calendars')).toBe(0);
    expect(h.count('appointments')).toBe(0);
    expect(h.lines(job).calendars.created).toBe(3);
  });

  it('imports event types as inactive calendars without any message, with their hours', async () => {
    imported = await h.run({ source: 'calendly', parts: ALL });
    expect(imported.status, imported.error).toBe('done');
    const c = cal('Erstgespräch')!;
    expect(c).toMatchObject({ duration: 30, active: 0, color: '#0069ff', timezone: 'Europe/Berlin', slug: 'erstgesprach' });
    expect(JSON.parse(c.availability)).toEqual({ mon: [['09:00', '12:00'], ['13:00', '17:00']], fri: [['09:00', '12:00']] });
    const s = JSON.parse(c.settings);
    expect(s).toMatchObject({ confirmation_email: false, notify_team: false, reminder_hours: 0, meeting_location: 'Zoom' });
    expect(s.date_overrides).toEqual({ '2099-12-24': [], '2099-12-27': [['10:00', '23:59']] });
    expect(c.description).toContain('Wir lernen uns kennen');
    expect(c.description).toContain('https://calendly.com/muster/erst');
    // the second event type follows the host's default schedule; its colour was no colour
    const b = cal('Beratung vor Ort')!;
    expect(JSON.parse(b.availability)).toEqual({ tue: [['10:00', '16:00']], thu: [['10:00', '16:00']] });
    expect(b.timezone).toBe('Europe/Vienna');
    expect(b.color).toBe('#2563eb');
    expect(cal('Gelöscht')).toBeUndefined();
    // an event type that is gone still has events: a stand-in calendar
    expect(cal('Termine „Altes Format“')).toBeTruthy();
  });

  it('imports one appointment per invitee, cancelled ones marked, without reminders', () => {
    const list = appts();
    expect(list.map((a: any) => [a.title, a.status, a.cal])).toEqual([
      ['Altes Format', 'confirmed', 'Termine „Altes Format“'],
      ['Erstgespräch – Anna Alt', 'confirmed', 'Erstgespräch'],
      ['Erstgespräch – Anna Alt', 'cancelled', 'Erstgespräch'],
      ['Beratung vor Ort – Ben Bau', 'confirmed', 'Beratung vor Ort'],
      ['Beratung vor Ort – Cleo Neu', 'confirmed', 'Beratung vor Ort'],
    ]);
    const a = list[1];
    expect(a).toMatchObject({ start_at: '2024-05-02T09:00:00.000Z', end_at: '2024-05-02T09:30:00.000Z', reminder_sent: 1, source: 'Import: Calendly', created_at: '2024-04-20T10:05:00.000Z' });
    expect(a.manage_token.length).toBeGreaterThan(10);
    expect(a.notes).toContain('Worum geht es?: Preise');
    expect(list[2].notes).toContain('Abgesagt von Anna Alt: Krank');
    expect(list[0].contact_id).toBeNull();
    expect(h.lines(imported).appointments.created).toBe(5);
  });

  it('links appointments to the invitees as contacts (no advertising consent) and mails nobody', () => {
    const anna = h.email('anna@example.com');
    expect(anna).toMatchObject({ first_name: 'Anna', last_name: 'Alt', phone: '+49301234567' });
    expect(appts().filter((a: any) => a.contact_id === anna.id)).toHaveLength(2);
    expect(h.ledger('ben@example.com')).toMatchObject([{ action: 'declined', source_label: 'Umzug aus Calendly' }]);
    expect(h.count('messages')).toBe(0);
    expect(h.lines(imported).contacts.created).toBe(3);
  });

  it('a second run changes nothing and creates nothing twice', async () => {
    const again = await h.run({ source: 'calendly', parts: ALL });
    const l = h.lines(again);
    expect(l.calendars).toMatchObject({ created: 0 });
    expect(l.appointments).toMatchObject({ created: 0, updated: 5 });
    expect(l.contacts.created).toBe(0);
    expect(h.count('appointments')).toBe(5);
    expect(h.count('calendars')).toBe(3);
  });

  it('an appointment or calendar somebody has changed since stays as they left it', async () => {
    const a = appts()[1];
    h.t.app.db.update('appointments', a.id, { status: 'showed' });
    const c = cal('Erstgespräch')!;
    h.t.app.db.update('calendars', c.id, { active: 1 });
    const again = await h.run({ source: 'calendly', parts: ALL });
    expect(h.lines(again).appointments.skipped).toBe(1);
    expect(h.lines(again).calendars.skipped).toBe(1);
    expect(h.raw('SELECT status FROM appointments WHERE id = ?', a.id).status).toBe('showed');
    h.t.app.db.update('appointments', a.id, { status: 'confirmed' });
    h.t.app.db.update('calendars', c.id, { active: 0 });
  });

  it('appointments alone make the calendars they need', async () => {
    const job = await h.run({ source: 'calendly', parts: ['appointments'] });
    expect(job.status, job.error).toBe('done');
    expect(h.count('calendars')).toBe(3);
  });

  it('never wrote the token anywhere', () => {
    expect(JSON.stringify(h.t.app.db.all('SELECT log, warnings, progress, result FROM umzug_jobs'))).not.toContain(CALENDLY_TOKEN);
  });
});

describe('Calendly: undo', () => {
  it('removes appointments, calendars and contacts, but keeps a calendar with foreign appointments', async () => {
    const c = cal('Beratung vor Ort')!;
    h.t.app.db.insert('appointments', { id: 'eigener-termin', location_id: h.loc(), calendar_id: c.id, contact_id: null, title: 'Eigener Termin', start_at: '2099-07-01T08:00:00.000Z', end_at: '2099-07-01T09:00:00.000Z', status: 'confirmed', notes: '', source: 'manuell', manage_token: 'tok-eigen-1234567890', reminder_sent: 0, reminders_sent: '{}', external_id: null, created_at: new Date().toISOString() });
    const job = await h.undo(imported.id);
    expect(job.undo.deleted).toMatchObject({ appointments: 5, calendars: 2, contacts: 3 });
    expect(job.undo.kept).toMatchObject({ calendars: 1 });
    expect(job.undo.notes.join(' ')).toContain('Ein Kalender bleibt');
    expect(cal('Beratung vor Ort')).toBeTruthy();
    expect(h.count('appointments')).toBe(1);
    expect(h.email('ben@example.com')).toBeUndefined();
  });
});
