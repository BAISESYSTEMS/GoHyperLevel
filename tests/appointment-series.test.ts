import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinClock, startTestApp, unpinClock } from './helpers.js';
import type { AppEvent } from '../server/core/events.js';
import { generateDue } from '../server/services/appt-series.js';
import { sendReminders } from '../server/services/booking-messages.js';

/** Recurring appointments: create, rolling generation, DST, only this / this and following / all, reminders per appointment. */

let t: Awaited<ReturnType<typeof startTestApp>>;
let calId = '';
let contactId = '';
const events: AppEvent[] = [];
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['07:00', '21:00']]]));
const rows = (seriesId: string) => t.app.db.all<any>('SELECT * FROM appointments WHERE series_id = ? ORDER BY start_at', seriesId);
const mails = (subject: string) => t.app.db.all<any>(`SELECT * FROM messages WHERE channel = 'email' AND subject LIKE ?`, `${subject}%`);

beforeAll(async () => {
  pinClock('2026-10-12T06:00:00Z'); // Monday, 08:00 in Berlin
  t = await startTestApp();
  await t.setup();
  t.app.events.on('*', (e) => void events.push(e));
  calId = (await t.api.post('/api/calendars', { name: 'Coaching', duration: 60, interval: 30, min_notice: 0, max_days: 365, availability: every, settings: { notify_team: false } })).data.id;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Serena', last_name: 'Serie', email: 'serena@example.com' })).data.id;
});
afterAll(async () => {
  await t.close();
  unpinClock();
});

describe('appointment series', () => {
  it('previews the dates and refuses a rule outside the subset', async () => {
    const p = await t.api.post('/api/appointment-series/preview', {
      calendar_id: calId,
      start: '2026-10-13T08:00:00Z',
      recurrence: { freq: 'weekly', weekdays: [2, 4], end: { type: 'count', count: 4 } },
    });
    expect(p.status, JSON.stringify(p.data)).toBe(200);
    expect(p.data).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4', description: 'Wöchentlich (Di, Do), 4×', first_date: '2026-10-13' });
    expect(p.data.occurrences.map((o: any) => o.date)).toEqual(['2026-10-13', '2026-10-15', '2026-10-20', '2026-10-22']);
    expect((await t.api.post('/api/appointment-series/preview', { calendar_id: calId, start: '2026-10-13T08:00:00Z', recurrence: 'FREQ=YEARLY' })).status).toBe(400);
    expect((await t.api.post('/api/appointment-series/preview', { calendar_id: calId, start: '2026-10-13T08:00:00Z' })).data.error).toBe('Wiederholung fehlt');
  });

  it('creates a weekly series: the first booking through the pipeline, one confirmation, one event, the rest written ahead', async () => {
    events.length = 0;
    const r = await t.api.post('/api/appointment-series', {
      calendar_id: calId,
      contact_id: contactId,
      start: '2026-10-13T08:00:00Z',
      recurrence: 'FREQ=WEEKLY;COUNT=6',
      notes: 'Wöchentliches Coaching',
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const s = r.data.series;
    expect(s).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=6', start_date: '2026-10-13', start_time: '10:00', duration: 60, contact_id: contactId, status: 'ended' });
    const list = rows(s.id);
    expect(list).toHaveLength(6);
    expect(list.every((a) => a.recurrence === s.rrule && a.contact_id === contactId && a.status === 'confirmed')).toBe(true);
    expect(list[0].source).toBe('Serie');
    // DST ends on 25 October: 10:00 stays 10:00 on the wall clock (08:00Z before, 09:00Z after).
    expect(list.map((a) => a.start_at.slice(0, 16))).toEqual(['2026-10-13T08:00', '2026-10-20T08:00', '2026-10-27T09:00', '2026-11-03T09:00', '2026-11-10T09:00', '2026-11-17T09:00']);
    expect(list.map((a) => a.occurrence_date)).toEqual(['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
    await t.app.events.flush();
    expect(events.filter((e) => e.type === 'appointment.booked')).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 50));
    expect(mails('Terminserie bestätigt')).toHaveLength(1);
    expect(mails('Termin bestätigt')).toHaveLength(0);
    // the appointments show up in the normal list with their series fields
    const listed = (await t.api.get(`/api/appointments?from=2026-10-01T00:00:00Z&to=2026-12-31T00:00:00Z`)).data.filter((a: any) => a.series_id === s.id);
    expect(listed).toHaveLength(6);
  });

  it('writes an endless series ahead on a rolling basis – a tick later in time adds the next weeks, a second tick nothing', async () => {
    const s = (await t.api.post('/api/appointment-series', { calendar_id: calId, contact_id: contactId, start: '2026-10-14T13:00:00Z', recurrence: { freq: 'weekly', interval: 1 }, notify: false }))
      .data.series;
    const first = rows(s.id);
    expect(first.length).toBe(13); // Wednesdays within 90 days
    expect(first.at(-1).occurrence_date <= '2027-01-10').toBe(true);
    pinClock('2026-11-12T06:00:00Z');
    expect(generateDue(t.app)).toBeGreaterThan(0);
    const later = rows(s.id);
    expect(later.length).toBe(first.length + 5);
    expect(new Set(later.map((a) => a.occurrence_date)).size).toBe(later.length);
    expect(generateDue(t.app)).toBe(0);
    pinClock('2026-10-12T06:00:00Z');
    await t.api.post(`/api/appointment-series/${s.id}/cancel`, { scope: 'all', notify: false });
  });

  it('refuses overlapping dates with the reasons, books them with force', async () => {
    const blockStart = '2026-10-21T13:00:00Z';
    await t.api.post('/api/appointments', { calendar_id: calId, blocked: true, title: 'Messe', start: blockStart, end: '2026-10-21T15:00:00Z' });
    const body = { calendar_id: calId, contact_id: contactId, start: '2026-10-14T13:30:00Z', recurrence: { freq: 'weekly', end: { type: 'count', count: 3 } }, notify: false };
    const r = await t.api.post('/api/appointment-series', body);
    expect(r.status, JSON.stringify(r.data)).toBe(409);
    expect(r.data.conflicts).toHaveLength(1);
    expect(r.data.conflicts[0]).toMatchObject({ date: '2026-10-21', issues: [expect.objectContaining({ kind: 'blocked', label: 'Messe' })] });
    const forced = await t.api.post('/api/appointment-series', { ...body, force: true });
    expect(forced.status).toBe(200);
    expect(forced.data.appointments).toHaveLength(3);
    await t.api.post(`/api/appointment-series/${forced.data.series.id}/cancel`, { scope: 'all', notify: false });
  });

  describe('edits and cancellations', () => {
    let s: any;
    beforeAll(async () => {
      s = (
        await t.api.post('/api/appointment-series', {
          calendar_id: calId,
          contact_id: contactId,
          start: '2026-10-16T07:00:00Z',
          recurrence: { freq: 'weekly', end: { type: 'count', count: 8 } },
          notify: false,
        })
      ).data.series;
    });

    it('"only this": one appointment moves on its own and becomes an exception', async () => {
      const list = rows(s.id);
      const r = await t.api.patch(`/api/appointment-series/${s.id}`, { scope: 'single', appointment_id: list[1].id, start_time: '14:00' });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      const moved = t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', list[1].id);
      expect(moved).toMatchObject({ series_exception: 1, start_at: '2026-10-23T12:00:00.000Z' });
    });

    it('"all": the time of every future appointment changes, the exception keeps its own time', async () => {
      const r = await t.api.patch(`/api/appointment-series/${s.id}`, { scope: 'all', start_time: '11:30', duration: 45 });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      expect(r.data.series).toMatchObject({ start_time: '11:30', duration: 45 });
      const list = rows(s.id);
      expect(list).toHaveLength(8);
      expect(list[0].start_at).toBe('2026-10-16T09:30:00.000Z');
      expect(list[0].end_at).toBe('2026-10-16T10:15:00.000Z');
      expect(list[1].start_at).toBe('2026-10-23T12:00:00.000Z'); // exception
      expect(list[2].start_at).toBe('2026-10-30T10:30:00.000Z'); // after the DST change
    });

    it('"this and following": splits the series, the new part follows the new rule, the count stays', async () => {
      const list = rows(s.id);
      const r = await t.api.patch(`/api/appointment-series/${s.id}`, { scope: 'following', appointment_id: list[4].id, recurrence: { freq: 'weekly', weekdays: [1] }, start_time: '09:00' });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      const split = r.data.series;
      expect(split.parent_id).toBe(s.id);
      expect(split.start_date).toBe(list[4].occurrence_date);
      const old = rows(s.id);
      expect(old).toHaveLength(4);
      expect((await t.api.get(`/api/appointment-series/${s.id}`)).data.series).toMatchObject({ status: 'ended', rrule: expect.stringContaining('UNTIL=') });
      const next = rows(split.id);
      // Mondays from the split day on (the Friday of the split was removed); the whole series had 8.
      expect(next.length).toBeGreaterThan(0);
      expect(next.every((a) => new Date(a.start_at).getUTCDay() === 1 && a.start_at.endsWith('T08:00:00.000Z'))).toBe(true);
    });

    it('cancels one appointment: it stays cancelled and is not written again', async () => {
      const list = rows(s.id);
      const r = await t.api.post(`/api/appointment-series/${s.id}/cancel`, { scope: 'single', appointment_id: list[0].id, notify: false });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      expect(t.app.db.get<any>('SELECT status, series_exception FROM appointments WHERE id = ?', list[0].id)).toEqual({ status: 'cancelled', series_exception: 1 });
      generateDue(t.app);
      expect(rows(s.id).filter((a) => a.occurrence_date === list[0].occurrence_date)).toHaveLength(1);
    });

    it('cancels this and the following ones with one e-mail and one event', async () => {
      events.length = 0;
      const before = mails('Terminserie abgesagt').length;
      const split = t.app.db.get<any>('SELECT id FROM appointment_series WHERE parent_id = ?', s.id);
      const list = rows(split.id);
      const r = await t.api.post(`/api/appointment-series/${split.id}/cancel`, { scope: 'following', appointment_id: list[1].id, reason: 'Umzug' });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      expect(r.data.cancelled).toBe(list.length - 1);
      expect(rows(split.id).map((a) => a.status)).toEqual(['confirmed', ...Array(list.length - 1).fill('cancelled')]);
      await t.app.events.flush();
      expect(events.filter((e) => e.type === 'appointment.status_changed')).toHaveLength(1);
      await new Promise((res) => setTimeout(res, 50));
      expect(mails('Terminserie abgesagt').length).toBe(before + 1);
    });

    it('another sub-account sees nothing of it', async () => {
      const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
      const mine = t.api.location;
      t.api.setLocation(other);
      expect((await t.api.get(`/api/appointment-series/${s.id}`)).status).toBe(404);
      expect((await t.api.post(`/api/appointment-series/${s.id}/cancel`, { scope: 'all' })).status).toBe(404);
      expect((await t.api.get('/api/appointment-series')).data).toEqual([]);
      t.api.setLocation(mine);
    });
  });

  it('every appointment of a series gets its own reminder', async () => {
    const cal = (
      await t.api.post('/api/calendars', {
        name: 'Sprechstunde',
        duration: 30,
        min_notice: 0,
        max_days: 365,
        availability: every,
        settings: { notify_team: false, confirmation_email: false, reminders: [{ hours: 24, email: true, sms: false }] },
      })
    ).data;
    const s = (
      await t.api.post('/api/appointment-series', {
        calendar_id: cal.id,
        contact_id: contactId,
        start: '2026-10-20T07:00:00Z',
        recurrence: { freq: 'daily', end: { type: 'count', count: 3 } },
        notify: false,
      })
    ).data.series;
    const list = rows(s.id);
    expect(list).toHaveLength(3);
    const reminded = () => t.app.db.all<any>(`SELECT * FROM messages WHERE source = 'Terminerinnerung' AND contact_id = ?`, contactId).length;
    const before = reminded();
    expect(await sendReminders(t.app, new Date('2026-10-19T08:00:00Z'))).toBe(1); // 23 h before the first
    expect(await sendReminders(t.app, new Date('2026-10-20T08:00:00Z'))).toBe(1); // 23 h before the second
    expect(await sendReminders(t.app, new Date('2026-10-20T08:05:00Z'))).toBe(0);
    expect(reminded()).toBe(before + 2);
  });
});
