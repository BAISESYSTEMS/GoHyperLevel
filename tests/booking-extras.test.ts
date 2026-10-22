import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { berlinDay, startTestApp } from './helpers.js';
import { computeSlots } from '../server/modules/calendars.js';
import { cleanAfter, cleanLimit, cleanOverrides, cleanReminders, normalizeBookingSettings, weekStartOf, windowsFor } from '../server/services/booking-rules.js';
import { sendFollowups, sendNoShow, sendReminders, smsReady } from '../server/services/booking-messages.js';

/** Booking polish: limits per day and week, date-specific hours, several reminders (e-mail and SMS), follow-up and no-show messages. */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const HOUR = 3600_000;

describe('rules (pure)', () => {
  it('checks date-specific hours: holidays, extra hours, overlaps, past days', () => {
    expect(cleanOverrides({ '2099-12-24': [], '2099-12-27': [['10:00', '12:00'], ['09:00', '09:30']] }, '2099-01-01')).toEqual({ '2099-12-24': [], '2099-12-27': [['09:00', '09:30'], ['10:00', '12:00']] });
    expect(cleanOverrides({ '2020-01-01': [] }, '2099-01-01')).toEqual({});
    expect(cleanOverrides(null, '2099-01-01')).toEqual({});
    expect(() => cleanOverrides({ '24.12.2099': [] }, '2099-01-01')).toThrow(/Datum/);
    expect(() => cleanOverrides({ '2099-02-30': [] }, '2099-01-01')).toThrow(/Datum/);
    expect(() => cleanOverrides({ '2099-12-24': [['12:00', '10:00']] }, '2099-01-01')).toThrow(/vor/);
    expect(() => cleanOverrides({ '2099-12-24': [['09:00', '11:00'], ['10:00', '12:00']] }, '2099-01-01')).toThrow(/überschneiden/);
    expect(() => cleanOverrides({ '2099-12-24': 'zu' }, '2099-01-01')).toThrow(/Liste/);
    expect(() => cleanOverrides([], '2099-01-01')).toThrow(/Objekt/);
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [new Date(Date.UTC(2100, 0, 1 + i)).toISOString().slice(0, 10), []]));
    expect(() => cleanOverrides(many, '2099-01-01')).toThrow(/Höchstens/);
  });

  it('picks the windows of a day: the date-specific ones, else the weekly ones', () => {
    const cal = { availability: { mon: [['09:00', '17:00']] } as any, settings: { date_overrides: { '2099-06-01': [] as [string, string][], '2099-06-06': [['10:00', '12:00']] as [string, string][] } } };
    expect(windowsFor(cal, '2099-05-25')).toEqual([['09:00', '17:00']]); // a Monday
    expect(windowsFor(cal, '2099-06-01')).toEqual([]); // Monday, closed by override
    expect(windowsFor(cal, '2099-06-06')).toEqual([['10:00', '12:00']]); // Saturday with extra hours
    expect(windowsFor(cal, '2099-06-02')).toEqual([]); // Tuesday: no weekly hours
    expect(windowsFor({ availability: {} as any }, '2099-06-02')).toEqual([]);
  });

  it('computes slots with overrides', () => {
    const base = { duration: 60, interval: 60, buffer: 0, min_notice: 0, max_days: 100000, timezone: 'Europe/Berlin', availability: { mon: [['09:00', '11:00']] } as any };
    const at = new Date('2099-05-01T00:00:00Z');
    expect(computeSlots(base, '2099-06-01', [], at)).toHaveLength(2);
    expect(computeSlots({ ...base, settings: { date_overrides: { '2099-06-01': [] } } }, '2099-06-01', [], at)).toEqual([]);
    expect(computeSlots({ ...base, settings: { date_overrides: { '2099-06-06': [['10:00', '13:00']] } } }, '2099-06-06', [], at)).toEqual(['2099-06-06T08:00:00.000Z', '2099-06-06T09:00:00.000Z', '2099-06-06T10:00:00.000Z']);
  });

  it('checks limits, reminders and the follow-up messages', () => {
    expect(cleanLimit('', 'x')).toBe(0);
    expect(cleanLimit(undefined, 'x')).toBe(0);
    expect(cleanLimit('3', 'x')).toBe(3);
    expect(cleanLimit(9999, 'x')).toBe(500);
    expect(() => cleanLimit(-1, 'x')).toThrow(/0 = unbegrenzt/);
    expect(() => cleanLimit('viele', 'x')).toThrow(/Zahl/);

    const list = cleanReminders([{ hours: 1, email: true }, { hours: 24, email: true, sms: true, subject: ' Morgen ', sms_body: 'Hi' }]);
    expect(list.map((r) => [r.id, r.hours, r.email, r.sms])).toEqual([['h24', 24, true, true], ['h1', 1, true, false]]);
    expect(list[0]).toMatchObject({ subject: 'Morgen', sms_body: 'Hi' });
    expect(cleanReminders([{ hours: 0.5, sms: true }])[0].id).toBe('h0_5');
    expect(() => cleanReminders([{ hours: 24 }])).toThrow(/E-Mail oder SMS/);
    expect(() => cleanReminders([{ hours: 24, email: true }, { hours: 24, sms: true }])).toThrow(/Zwei Erinnerungen/);
    expect(() => cleanReminders([{ hours: 0, email: true }])).toThrow(/zwischen/);
    expect(() => cleanReminders([{ hours: 721, email: true }])).toThrow(/zwischen/);
    expect(() => cleanReminders(Array.from({ length: 6 }, (_, i) => ({ hours: i + 1, email: true })))).toThrow(/Höchstens 5/);
    expect(() => cleanReminders('x')).toThrow(/Liste/);

    const on = cleanAfter({ enabled: true, hours: 2, sms: true }, undefined, 'followup', '2026-10-05T10:00:00.000Z');
    expect(on).toMatchObject({ enabled: true, hours: 2, email: true, sms: true, enabled_at: '2026-10-05T10:00:00.000Z' });
    // staying on keeps the start of the clock, switching off and on restarts it
    expect(cleanAfter({ enabled: true, hours: 2 }, on, 'followup', '2026-10-09T10:00:00.000Z').enabled_at).toBe('2026-10-05T10:00:00.000Z');
    const off = cleanAfter({ enabled: false }, on, 'followup', '2026-10-09T10:00:00.000Z');
    expect(off.enabled_at).toBeNull();
    expect(cleanAfter({ enabled: true }, off, 'followup', '2026-10-10T10:00:00.000Z').enabled_at).toBe('2026-10-10T10:00:00.000Z');
    expect(cleanAfter({ enabled: true, hours: 5 }, undefined, 'noshow', 'x').hours).toBe(0);
    expect(() => cleanAfter({ enabled: true, email: false, sms: false }, undefined, 'noshow', 'x')).toThrow(/E-Mail oder SMS/);
    expect(() => cleanAfter({ enabled: true, hours: 999 }, undefined, 'followup', 'x')).toThrow(/zwischen/);
  });

  it('only touches the booking keys of the settings', () => {
    const prev = { followup: { enabled: true, enabled_at: '2026-01-01T00:00:00.000Z', hours: 1, email: true, sms: false, subject: '', body: '', sms_body: '' } };
    const out = normalizeBookingSettings({ ...prev, meeting_location: 'Büro', limit_day: '2', reminders: null, noshow: null, followup: { ...prev.followup, hours: 3 } }, prev, '2026-10-05', '2026-10-05T00:00:00.000Z');
    expect(out).toMatchObject({ meeting_location: 'Büro', limit_day: 2, followup: { hours: 3, enabled_at: '2026-01-01T00:00:00.000Z' } });
    expect('reminders' in out).toBe(false);
    expect('noshow' in out).toBe(false);
    expect('limit_week' in out).toBe(false);
    expect(weekStartOf('2026-10-07')).toBe('2026-10-05'); // Wednesday → Monday
    expect(weekStartOf('2026-10-11')).toBe('2026-10-05'); // Sunday → Monday before
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const sms: { to: string; body: string }[] = [];
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
let n = 0;
const flush = () => t.app.events.flush();

const makeCal = async (settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const r = await t.api.post('/api/calendars', { name: `Beratung ${++n}`, duration: 60, interval: 60, min_notice: 0, max_days: 90, availability: every, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0, ...settings }, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const slotsOf = async (cal: any, day: string, days = 1) => (await t.api.get(`/api/public/calendars/${cal.slug}/slots?from=${day}&days=${days}`)).data.days as { date: string; slots: string[] }[];
const bookPublic = (cal: any, start: string, who = `gast${++n}`) => t.api.post(`/api/public/calendars/${cal.slug}/book`, { start, first_name: who, email: `${who}@example.com` });
// every contact has its own e-mail and number (the same number would be the same contact)
const contact = async (extra: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { first_name: 'Karla', email: `karla${++n}@example.com`, phone: `+49170${String(1000000 + n)}`, ...extra })).data;
const manual = async (cal: any, contactId: string, startIso: string) => {
  const r = await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: contactId, start: startIso, force: true });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const msgs = (contactId: string, channel?: string) => t.app.db.all<any>(`SELECT * FROM messages WHERE contact_id = ? ${channel ? 'AND channel = ?' : ''} ORDER BY created_at, rowid`, contactId, ...(channel ? [channel] : []));

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  t.app.services.smsTransports = { capture: async (_l: any, to: string, body: string) => (sms.push({ to, body }), { status: 'sent' }) };
});
afterAll(() => t.close());

describe('limits per day and week', () => {
  it('closes a day once its limit is reached and opens it again when a booking is cancelled', async () => {
    const cal = await makeCal({ limit_day: 2 });
    expect(cal.settings.limit_day).toBe(2);
    const day = berlinDay(10);
    const before = (await slotsOf(cal, day))[0].slots;
    expect(before.length).toBeGreaterThan(2);
    const a = await bookPublic(cal, before[0]);
    expect(a.status).toBe(200);
    expect((await slotsOf(cal, day))[0].slots.length).toBe(before.length - 1);
    const b = await bookPublic(cal, before[3]);
    expect(b.status).toBe(200);
    // two bookings: nothing left that day, a third one is refused, the next day is untouched
    expect((await slotsOf(cal, day))[0].slots).toEqual([]);
    const third = await bookPublic(cal, before[5]);
    expect(third.status).toBe(409);
    expect((await slotsOf(cal, berlinDay(11)))[0].slots.length).toBeGreaterThan(2);
    // staff can still book by hand (force), the public page cannot
    const c = await contact();
    expect((await t.api.post('/api/appointments', { calendar_id: cal.id, contact_id: c.id, start: before[5], force: true })).status).toBe(200);
    // cancelled bookings do not count: cancel all three, the day is open again
    for (const appt of (await t.api.get(`/api/appointments?calendar_id=${cal.id}&from=${day}T00:00:00Z&to=${berlinDay(11)}T23:59:59Z`)).data) await t.api.patch(`/api/appointments/${appt.id}`, { status: 'cancelled' });
    expect((await slotsOf(cal, day))[0].slots.length).toBe(before.length);
  });

  it('closes the whole week once its limit is reached', async () => {
    const cal = await makeCal({ limit_week: 2 });
    // a Monday at least two weeks ahead
    let first = 14;
    while (weekStartOf(berlinDay(first)) !== berlinDay(first)) first++;
    const monday = berlinDay(first);
    const wed = berlinDay(first + 2);
    const sun = berlinDay(first + 6);
    const nextMonday = berlinDay(first + 7);
    const slots = await slotsOf(cal, monday, 8);
    expect(slots.every((d) => d.slots.length > 0)).toBe(true);
    expect((await bookPublic(cal, slots[0].slots[0])).status).toBe(200);
    expect((await slotsOf(cal, wed))[0].slots.length).toBeGreaterThan(0);
    expect((await bookPublic(cal, slots[2].slots[1])).status).toBe(200);
    // two bookings that week: Monday to Sunday are closed, the Monday after is open
    const after = await slotsOf(cal, monday, 8);
    expect(after.slice(0, 7).map((d) => d.slots.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(after[7].date).toBe(nextMonday);
    expect(after[7].slots.length).toBeGreaterThan(0);
    expect((await bookPublic(cal, slots[6].slots[0])).status).toBe(409);
    expect((await slotsOf(cal, sun))[0].slots).toEqual([]);
  });

  it('counts per calendar and rejects nonsense', async () => {
    const one = await makeCal({ limit_day: 1 });
    const other = await makeCal({});
    const day = berlinDay(12);
    const s = (await slotsOf(one, day))[0].slots;
    await bookPublic(one, s[0]);
    expect((await slotsOf(one, day))[0].slots).toEqual([]);
    expect((await slotsOf(other, day))[0].slots.length).toBeGreaterThan(0);
    expect((await t.api.patch(`/api/calendars/${one.id}`, { settings: { limit_day: -3 } })).status).toBe(400);
    expect((await t.api.patch(`/api/calendars/${one.id}`, { settings: { limit_week: 'viele' } })).status).toBe(400);
    expect((await t.api.patch(`/api/calendars/${one.id}`, { settings: { limit_day: 0 } })).data.settings.limit_day).toBe(0);
    expect((await slotsOf(one, day))[0].slots.length).toBeGreaterThan(0);
  });
});

describe('date-specific hours', () => {
  it('takes a holiday off the offer and opens extra hours on a closed day', async () => {
    const cal = await makeCal({}, { availability: { mon: [['09:00', '11:00']], tue: [['09:00', '11:00']], wed: [['09:00', '11:00']], thu: [['09:00', '11:00']], fri: [['09:00', '11:00']] } });
    // the next Saturday and the next Wednesday, at least a week ahead
    const days = Array.from({ length: 21 }, (_, i) => berlinDay(8 + i));
    const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
    const sat = days.find((d) => dow(d) === 6)!;
    const wed = days.find((d) => dow(d) === 3)!;
    expect((await slotsOf(cal, sat))[0].slots).toEqual([]);
    expect((await slotsOf(cal, wed))[0].slots).toHaveLength(2);
    const set = await t.api.patch(`/api/calendars/${cal.id}`, { settings: { date_overrides: { [wed]: [], [sat]: [['10:00', '13:00']], '2001-01-01': [] } } });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    // the past day is dropped, the others kept
    expect(Object.keys(set.data.settings.date_overrides)).toEqual([wed, sat].sort());
    expect((await slotsOf(cal, wed))[0].slots).toEqual([]);
    const satSlots = (await slotsOf(cal, sat))[0].slots;
    expect(satSlots).toHaveLength(3);
    expect(await bookPublic(cal, satSlots[0]).then((r) => r.status)).toBe(200);
    // booking in a closed day is refused too
    const wedSlot = computeSlots({ ...cal, availability: cal.availability, settings: {} }, wed, [])[0];
    expect((await bookPublic(cal, wedSlot)).status).toBe(409);
    // removing the override brings the weekly hours back
    expect((await t.api.patch(`/api/calendars/${cal.id}`, { settings: { date_overrides: {} } })).status).toBe(200);
    expect((await slotsOf(cal, wed))[0].slots).toHaveLength(2);
    expect((await slotsOf(cal, sat))[0].slots).toEqual([]);
  });

  it('refuses malformed overrides', async () => {
    const cal = await makeCal();
    for (const bad of [{ '24.12.2099': [] }, { '2099-12-24': [['18:00', '09:00']] }, { '2099-12-24': 'ganztags' }]) {
      expect((await t.api.patch(`/api/calendars/${cal.id}`, { settings: { date_overrides: bad } })).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe('several reminders by e-mail and SMS', () => {
  beforeEach(() => void t.app.db.run('DELETE FROM appointments'));
  const config = { reminders: [{ hours: 24, email: true, sms: true }, { hours: 1, email: true, sms: false }], reminder_subject: 'Erinnerung: {{calendar.name}}' };
  const setSms = (provider: string) => t.api.patch('/api/location', { settings: { sms: { provider } } });

  it('sends each reminder once, by the channels chosen, and skips SMS without a provider', async () => {
    const cal = await makeCal(config);
    expect(cal.settings.reminders.map((r: any) => r.id)).toEqual(['h24', 'h1']);
    const c = await contact();
    const start = new Date(Date.now() + 30 * HOUR);
    const appt = await manual(cal, c.id, start.toISOString());
    await flush();
    const baseline = msgs(c.id, 'email').length;
    // nothing is due yet
    expect(await sendReminders(t.app, new Date(Date.now() + HOUR))).toBe(0);
    expect(msgs(c.id, 'email')).toHaveLength(baseline);

    // SMS not set up: the 24 h reminder goes out by e-mail only
    expect(smsReady(t.app, loc)).toBe(false);
    expect(await sendReminders(t.app, new Date(Date.now() + 7 * HOUR))).toBe(1);
    expect(msgs(c.id, 'sms')).toHaveLength(0);
    const mail = msgs(c.id, 'email').at(-1);
    expect(mail.subject).toBe(`Erinnerung: ${cal.name}`);
    expect(mail.source).toBe('Terminerinnerung');
    expect(JSON.parse(t.app.db.get<any>('SELECT reminders_sent FROM appointments WHERE id = ?', appt.id)!.reminders_sent)).toEqual({ h24: appt.start_at });
    // not again
    expect(await sendReminders(t.app, new Date(Date.now() + 8 * HOUR))).toBe(0);

    // the 1 h reminder: e-mail only by its own setting
    expect(await sendReminders(t.app, new Date(Date.now() + 29.5 * HOUR))).toBe(1);
    expect(msgs(c.id, 'email')).toHaveLength(baseline + 2);
    expect(sms).toHaveLength(0);
    expect(await sendReminders(t.app, new Date(Date.now() + 29.7 * HOUR))).toBe(0);
  });

  it('adds the SMS when a provider is set up and the contact has a number – and not for a contact who opted out', async () => {
    await setSms('capture');
    expect(smsReady(t.app, loc)).toBe(true);
    const cal = await makeCal(config);
    const c = await contact({ phone: '+491709998877' });
    const noPhone = await contact({ phone: '' });
    const dnd = await contact({ dnd: true, phone: '+491701112233' });
    for (const x of [c, noPhone, dnd]) await manual(cal, x.id, new Date(Date.now() + 30 * HOUR).toISOString());
    sms.length = 0;
    expect(await sendReminders(t.app, new Date(Date.now() + 7 * HOUR))).toBe(3);
    await flush();
    expect(sms).toHaveLength(1);
    expect(sms[0].to).toBe('+491709998877');
    expect(sms[0].body).toContain(cal.name);
    expect(sms[0].body).toMatch(/\/book\/manage\//);
    expect(msgs(noPhone.id, 'sms')).toHaveLength(0);
    // "Nicht stören" stops the SMS (the e-mail reminder is a service mail like the confirmation)
    expect(msgs(dnd.id, 'sms').map((m) => m.status)).toEqual(['failed']);
    expect(msgs(dnd.id, 'email').at(-1).status).not.toBe('failed');
  });

  it('sends only the closest of several that are due at once, and none whose moment was before the booking', async () => {
    const cal = await makeCal(config);
    const c = await contact();
    const appt = await manual(cal, c.id, new Date(Date.now() + 30 * HOUR).toISOString());
    sms.length = 0;
    const before = msgs(c.id, 'email').length;
    // both are due (the server was down): one e-mail, the 24 h one is not sent afterwards
    expect(await sendReminders(t.app, new Date(Date.now() + 29.5 * HOUR))).toBe(1);
    expect(msgs(c.id, 'email')).toHaveLength(before + 1);
    expect(sms).toHaveLength(0);
    expect(Object.keys(JSON.parse(t.app.db.get<any>('SELECT reminders_sent FROM appointments WHERE id = ?', appt.id)!.reminders_sent)).sort()).toEqual(['h1', 'h24']);

    // booked 2 hours before the start: the 24 h reminder would be older than the booking → skipped, the 1 h one comes
    const late = await contact();
    await manual(cal, late.id, new Date(Date.now() + 2 * HOUR).toISOString());
    const lateBefore = msgs(late.id, 'email').length;
    expect(await sendReminders(t.app, new Date(Date.now() + 0.5 * HOUR))).toBe(0);
    expect(msgs(late.id, 'email')).toHaveLength(lateBefore);
    expect(await sendReminders(t.app, new Date(Date.now() + 1.2 * HOUR))).toBe(1);
    expect(msgs(late.id, 'email')).toHaveLength(lateBefore + 1);
  });

  it('runs again after the appointment was moved, and ignores cancelled ones', async () => {
    const cal = await makeCal(config);
    const c = await contact();
    const appt = await manual(cal, c.id, new Date(Date.now() + 30 * HOUR).toISOString());
    expect(await sendReminders(t.app, new Date(Date.now() + 7 * HOUR))).toBe(1);
    expect(await sendReminders(t.app, new Date(Date.now() + 7 * HOUR))).toBe(0);
    const moved = new Date(Date.now() + 55 * HOUR);
    await t.api.patch(`/api/appointments/${appt.id}`, { start: moved.toISOString() });
    expect(await sendReminders(t.app, new Date(Date.now() + 32 * HOUR))).toBe(1);
    await t.api.patch(`/api/appointments/${appt.id}`, { status: 'cancelled' });
    expect(await sendReminders(t.app, new Date(Date.now() + 54.5 * HOUR))).toBe(0);
  });

  it('keeps the single reminder of older calendars working, and does not double-send when the list is used', async () => {
    const legacy = await makeCal({ reminder_hours: 24 });
    expect('reminders' in legacy.settings).toBe(false);
    const c = await contact();
    const appt = await manual(legacy, c.id, new Date(Date.now() + 20 * HOUR).toISOString());
    t.app.db.run('UPDATE appointments SET created_at = ? WHERE id = ?', new Date(Date.now() - HOUR).toISOString(), appt.id);
    const before = msgs(c.id, 'email').length;
    await t.app.tick();
    expect(msgs(c.id, 'email')).toHaveLength(before + 1);
    expect(t.app.db.get<any>('SELECT reminder_sent FROM appointments WHERE id = ?', appt.id)!.reminder_sent).toBe(1);

    const both = await makeCal({ reminder_hours: 24, reminders: [{ hours: 24, email: true }] });
    const c2 = await contact();
    const a2 = await manual(both, c2.id, new Date(Date.now() + 20 * HOUR).toISOString());
    t.app.db.run('UPDATE appointments SET created_at = ? WHERE id = ?', new Date(Date.now() - 2 * 24 * HOUR).toISOString(), a2.id);
    const b2 = msgs(c2.id, 'email').length;
    await t.app.tick();
    expect(msgs(c2.id, 'email')).toHaveLength(b2 + 1);
    expect(t.app.db.get<any>('SELECT reminder_sent FROM appointments WHERE id = ?', a2.id)!.reminder_sent).toBe(0);
    // going back to the single reminder: remove the list
    const reset = await t.api.patch(`/api/calendars/${both.id}`, { settings: { reminders: null } });
    expect('reminders' in reset.data.settings).toBe(false);
  });
});

describe('follow-up and no-show messages', () => {
  beforeEach(() => void t.app.db.run('DELETE FROM appointments'));
  it('sends the follow-up once after the appointment, never for older ones, cancelled or no-shows', async () => {
    const cal = await makeCal({ followup: { enabled: true, hours: 2, email: true, subject: 'Danke {{contact.first_name}}' } });
    expect(cal.settings.followup).toMatchObject({ enabled: true, hours: 2, email: true, sms: false });
    expect(cal.settings.followup.enabled_at).toBeTruthy();
    const c = await contact();
    const cancelled = await contact();
    const noshow = await contact();
    const appt = await manual(cal, c.id, new Date(Date.now() + HOUR).toISOString());
    const gone = await manual(cal, cancelled.id, new Date(Date.now() + HOUR).toISOString());
    await t.api.patch(`/api/appointments/${gone.id}`, { status: 'cancelled' });
    const ns = await manual(cal, noshow.id, new Date(Date.now() + HOUR).toISOString());
    t.app.db.run(`UPDATE appointments SET status = 'noshow' WHERE id = ?`, ns.id);
    // an appointment that ended before the follow-up was switched on
    const old = await contact();
    const oldAppt = await manual(cal, old.id, new Date(Date.now() - 6 * HOUR).toISOString());
    await flush();
    const mails = (id: string) => msgs(id, 'email').filter((m) => m.source === 'Terminnachfassen');

    expect(await sendFollowups(t.app, new Date(Date.now() + 2 * HOUR))).toBe(0); // ended 1 h ago + 2 h wait: not yet
    expect(await sendFollowups(t.app, new Date(Date.now() + 4 * HOUR))).toBe(1);
    expect(mails(c.id)).toHaveLength(1);
    expect(mails(c.id)[0].subject).toBe('Danke Karla');
    expect(mails(cancelled.id)).toHaveLength(0);
    expect(mails(noshow.id)).toHaveLength(0);
    expect(mails(old.id)).toHaveLength(0);
    expect(JSON.parse(t.app.db.get<any>('SELECT reminders_sent FROM appointments WHERE id = ?', oldAppt.id)!.reminders_sent).followup).toBe(oldAppt.start_at);
    // once only
    expect(await sendFollowups(t.app, new Date(Date.now() + 5 * HOUR))).toBe(0);
    expect(mails(c.id)).toHaveLength(1);
    expect(JSON.parse(t.app.db.get<any>('SELECT reminders_sent FROM appointments WHERE id = ?', appt.id)!.reminders_sent).followup).toBe(appt.start_at);
    // a follow-up that is more than two days late is dropped instead of sent
    const stale = await contact();
    await manual(cal, stale.id, new Date(Date.now() + HOUR).toISOString());
    expect(await sendFollowups(t.app, new Date(Date.now() + 80 * HOUR))).toBe(0);
    expect(mails(stale.id)).toHaveLength(0);
  });

  it('sends the follow-up by SMS too, when asked and possible, and follows "Nicht stören"', async () => {
    await t.api.patch('/api/location', { settings: { sms: { provider: 'capture' } } });
    const cal = await makeCal({ followup: { enabled: true, hours: 0, email: false, sms: true, sms_body: 'Danke für {{calendar.name}}!' } });
    const c = await contact({ phone: '+491705550001' });
    const d = await contact({ phone: '+491705550002', dnd: true });
    await manual(cal, c.id, new Date(Date.now() + HOUR).toISOString());
    await manual(cal, d.id, new Date(Date.now() + HOUR).toISOString());
    sms.length = 0;
    await sendFollowups(t.app, new Date(Date.now() + 3 * HOUR));
    expect(sms).toEqual([{ to: '+491705550001', body: `Danke für ${cal.name}!` }]);
    expect(msgs(c.id, 'email').filter((m) => m.source === 'Terminnachfassen')).toHaveLength(0);
    expect(msgs(d.id, 'sms').map((m) => m.status)).toEqual(['failed']);
  });

  it('writes to no-shows when the status is set, once, with a link to book again', async () => {
    const cal = await makeCal({ noshow: { enabled: true, email: true } });
    const off = await makeCal({});
    const c = await contact();
    const other = await contact();
    const appt = await manual(cal, c.id, new Date(Date.now() - 3 * HOUR).toISOString());
    const appt2 = await manual(off, other.id, new Date(Date.now() - 3 * HOUR).toISOString());
    const future = await manual(cal, (await contact()).id, new Date(Date.now() + 5 * HOUR).toISOString());
    await flush();
    const mails = (id: string) => msgs(id, 'email').filter((m) => m.source === 'Terminnachfassen');
    await t.api.patch(`/api/appointments/${appt.id}`, { status: 'noshow' });
    await t.api.patch(`/api/appointments/${appt2.id}`, { status: 'noshow' });
    await flush();
    expect(mails(c.id)).toHaveLength(1);
    expect(mails(c.id)[0].subject).toBe('Schade, wir haben dich vermisst');
    expect(mails(c.id)[0].body).toContain(`/book/${cal.slug}`);
    expect(mails(other.id)).toHaveLength(0);
    // set again later: no second message for the same appointment
    await t.api.patch(`/api/appointments/${appt.id}`, { status: 'confirmed' });
    await t.api.patch(`/api/appointments/${appt.id}`, { status: 'noshow' });
    await flush();
    expect(mails(c.id)).toHaveLength(1);
    // an appointment that has not started yet cannot be a no-show
    expect(await sendNoShow(t.app, future)).toBe(false);
  });

  it('keeps defaults when the texts are empty and turns off cleanly', async () => {
    const cal = await makeCal({ noshow: { enabled: true, email: true, subject: '', body: '' } });
    expect(cal.settings.noshow).toMatchObject({ enabled: true, subject: '', body: '' });
    const off = await t.api.patch(`/api/calendars/${cal.id}`, { settings: { noshow: { enabled: false } } });
    expect(off.data.settings.noshow).toMatchObject({ enabled: false, enabled_at: null });
    expect((await t.api.patch(`/api/calendars/${cal.id}`, { settings: { noshow: { enabled: true, email: false, sms: false } } })).status).toBe(400);
  });
});

describe('the editor', () => {
  it('has the controls for limits, date-specific hours, reminders, follow-up and no-show', () => {
    const ui = read('web/src/pages/BookingExtras.tsx');
    for (const needle of ['limit_day', 'limit_week', 'date_overrides', 'reminders', 'followup', 'noshow', 'Abweichende Tage', 'Nicht erschienen']) expect(ui, needle).toContain(needle);
    const cal = read('web/src/pages/Calendars.tsx');
    expect(cal).toContain('<LimitsEditor');
    expect(cal).toContain('<OverridesEditor');
    expect(cal).toContain('<RemindersEditor');
    expect(cal).toContain('<AfterEditor');
    expect(ui).not.toContain('modal-bg');
  });
});
