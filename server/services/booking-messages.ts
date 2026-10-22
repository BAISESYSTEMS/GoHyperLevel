import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { sliceTimer } from '../core/perf.js';
import { render } from '../core/template.js';
import { contactVars, getContact } from './contacts.js';
import { sendToContact } from './messaging.js';
import { DEFAULT_FOLLOWUP, DEFAULT_NOSHOW, DEFAULT_SMS_REMINDER, type AfterMessage, type Reminder } from './booking-rules.js';
import { DEFAULT_SETTINGS, apptVars, type CalendarRow } from '../modules/calendars.js';

/**
 * Sends what the calendars promise around an appointment: several reminders (e-mail and/or SMS), the follow-up after it
 * and the message for no-shows. Which message went out for which start time is remembered in `appointments.reminders_sent`
 * ({reminderId: start_at}); moving an appointment changes its start, so its reminders run again without anybody resetting a flag.
 */

const HOUR = 3600_000;
type Sent = Record<string, string>;

/** Is an SMS provider set up for the sub-account (not just "log")? */
export function smsReady(app: App, locationId: string): boolean {
  const p = app.location(locationId)?.settings?.sms?.provider;
  return typeof p === 'string' && !!p && p !== 'log';
}

const sentOf = (a: { reminders_sent?: string }): Sent => {
  try {
    const v = JSON.parse(a.reminders_sent || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
/** Notes one message for the appointment's start time – on top of what is stored now (another job may have noted one meanwhile). */
const mark = (app: App, a: { id: string; start_at: string }, key: string) => {
  const sent = sentOf(app.db.get<{ reminders_sent: string }>('SELECT reminders_sent FROM appointments WHERE id = ?', a.id) ?? {});
  sent[key] = a.start_at;
  app.db.run('UPDATE appointments SET reminders_sent = ? WHERE id = ?', JSON.stringify(sent), a.id);
};
/**
 * The appointment as it is now: the runs below read their list first and then send one message after the other, and meanwhile an
 * appointment may have been cancelled, moved or marked – an old copy would remind of a cancelled appointment or its old time.
 */
const current = (app: App, id: string) => app.db.get<any>('SELECT * FROM appointments WHERE id = ?', id);
const calOf = (app: App, id: string) => parseJson(app.db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ?', id), ['availability', 'settings']);

interface Template {
  email: boolean;
  sms: boolean;
  subject: string;
  body: string;
  sms_body: string;
}

async function deliver(app: App, a: any, cal: CalendarRow, t: Template, defaults: { subject: string; body: string; sms_body: string }, o: { source: string; ignoreDnd: boolean }) {
  const contact = getContact(app, a.location_id, a.contact_id);
  if (!contact) return;
  const vars: any = { contact: contactVars(contact), ...apptVars(app, a, cal) };
  vars.appointment.booking_url = `${app.baseUrl()}/book/${cal.slug}`;
  if (t.email && contact.email) {
    await sendToContact(app, a.location_id, { contactId: contact.id, channel: 'email', subject: render(t.subject || defaults.subject, vars), body: render(t.body || defaults.body, vars), source: o.source, ignoreDnd: o.ignoreDnd });
  }
  // SMS only when a provider is set up and the contact has a number; it follows "Nicht stören" (E-Mail-Bestätigungen sind Pflichtmails, SMS nicht).
  if (t.sms && contact.phone && smsReady(app, a.location_id)) {
    await sendToContact(app, a.location_id, { contactId: contact.id, channel: 'sms', body: render(t.sms_body || defaults.sms_body, vars).slice(0, 480), source: o.source, ignoreDnd: false });
  }
}

/** Reminders of confirmed appointments in the next 30 days whose calendar has the new reminder list. */
export async function sendReminders(app: App, at = new Date()): Promise<number> {
  const nowMs = at.getTime();
  const rows = app.db.all<any>(
    `SELECT a.* FROM appointments a JOIN calendars k ON k.id = a.calendar_id
     WHERE a.status = 'confirmed' AND a.contact_id IS NOT NULL AND a.start_at > ? AND a.start_at <= ?
     AND json_extract(k.settings, '$.reminders') IS NOT NULL ORDER BY a.start_at LIMIT 1000`,
    at.toISOString(),
    new Date(nowMs + 30 * 24 * HOUR).toISOString(),
  );
  const pause = sliceTimer(40);
  let sent = 0;
  for (const row of rows) {
    await pause();
    const a = current(app, row.id);
    if (!a || a.status !== 'confirmed' || !a.contact_id || a.start_at <= at.toISOString()) continue;
    const cal = calOf(app, a.calendar_id);
    const list: Reminder[] = Array.isArray(cal?.settings.reminders) ? cal!.settings.reminders : [];
    if (!cal || !list.length) continue;
    const done = sentOf(a);
    const start = Date.parse(a.start_at);
    const created = Date.parse(a.created_at);
    // Reminders whose moment has come and that were not sent for this start time.
    const due = list.filter((r) => done[r.id] !== a.start_at && nowMs >= start - r.hours * HOUR);
    if (!due.length) continue;
    // A reminder whose moment was before the booking is skipped (the confirmation just went out); of several due at once only the closest is sent.
    const fresh = due.filter((x) => created <= start - x.hours * HOUR + 5 * 60_000).sort((x, y) => x.hours - y.hours);
    for (const x of due) mark(app, a, x.id);
    const rem = fresh[0];
    if (!rem) continue;
    await deliver(app, a, cal, rem, { subject: cal.settings.reminder_subject || DEFAULT_SETTINGS.reminder_subject, body: cal.settings.reminder_body || DEFAULT_SETTINGS.reminder_body, sms_body: cal.settings.reminder_sms_body || DEFAULT_SMS_REMINDER }, { source: 'Terminerinnerung', ignoreDnd: true });
    sent++;
  }
  return sent;
}

/** "Danke"-message `hours` after the end of an appointment (confirmed or showed), only for appointments from after it was switched on. */
export async function sendFollowups(app: App, at = new Date()): Promise<number> {
  const nowMs = at.getTime();
  const rows = app.db.all<any>(
    `SELECT a.* FROM appointments a JOIN calendars k ON k.id = a.calendar_id
     WHERE a.status IN ('confirmed', 'showed') AND a.contact_id IS NOT NULL AND a.end_at <= ? AND a.end_at >= ?
     AND json_extract(k.settings, '$.followup.enabled') = 1 ORDER BY a.end_at LIMIT 500`,
    at.toISOString(),
    new Date(nowMs - 30 * 24 * HOUR).toISOString(),
  );
  const pause = sliceTimer(40);
  let sent = 0;
  for (const row of rows) {
    await pause();
    const a = current(app, row.id);
    if (!a || !['confirmed', 'showed'].includes(a.status) || !a.contact_id || a.end_at > at.toISOString()) continue;
    const cal = calOf(app, a.calendar_id);
    const f: AfterMessage | undefined = cal?.settings.followup;
    if (!cal || !f?.enabled) continue;
    const done = sentOf(a);
    if (done.followup === a.start_at) continue;
    const dueAt = Date.parse(a.end_at) + f.hours * HOUR;
    if (nowMs < dueAt) continue;
    // Older than two days or from before the message was switched on: never sent (switching it on must not write to the past).
    if (nowMs - dueAt > 48 * HOUR || (f.enabled_at && Date.parse(a.end_at) < Date.parse(f.enabled_at))) {
      mark(app, a, 'followup');
      continue;
    }
    mark(app, a, 'followup');
    await deliver(app, a, cal, f, DEFAULT_FOLLOWUP, { source: 'Terminnachfassen', ignoreDnd: false });
    sent++;
  }
  return sent;
}

/** The "we missed you" message when an appointment is set to "nicht erschienen" (once per start time). */
export async function sendNoShow(app: App, appointment: { id: string }, at = new Date()): Promise<boolean> {
  const a = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', appointment.id);
  if (!a || a.status !== 'noshow' || !a.contact_id || Date.parse(a.start_at) > at.getTime()) return false;
  const cal = calOf(app, a.calendar_id);
  const n: AfterMessage | undefined = cal?.settings.noshow;
  if (!cal || !n?.enabled) return false;
  const done = sentOf(a);
  if (done.noshow === a.start_at) return false;
  mark(app, a, 'noshow');
  await deliver(app, a, cal, n, DEFAULT_NOSHOW, { source: 'Terminnachfassen', ignoreDnd: false });
  return true;
}
