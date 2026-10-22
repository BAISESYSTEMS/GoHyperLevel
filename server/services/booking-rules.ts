import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc } from '../core/time.js';

/**
 * Booking polish for the calendars (Calendly parity): limits per day and week, date-specific hours (holidays, extra
 * hours), several reminders by e-mail and SMS, a follow-up after the appointment and a message for no-shows. Everything
 * lives in the calendar's `settings` JSON; this file validates it and answers the pure questions (which windows does a day
 * have, is a limit reached). The sending is in services/booking-messages.ts.
 */

export type Windows = [string, string][];
export type DateOverrides = Record<string, Windows>;

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_OVERRIDES = 366;
export const MAX_REMINDERS = 5;
export const MAX_LIMIT = 500;

const validDay = (s: string) => YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// --- date-specific hours -------------------------------------------------------------------------

function cleanWindows(input: unknown, day: string): Windows {
  if (!Array.isArray(input)) throw bad(`Zeiten für ${day}: Liste von Zeitfenstern erwartet`);
  const out: Windows = [];
  for (const w of input) {
    if (!Array.isArray(w) || !HM.test(String(w[0])) || !HM.test(String(w[1])) || String(w[0]) >= String(w[1])) throw bad(`Zeitfenster am ${day}: „von“ muss vor „bis“ liegen (HH:MM)`);
    out.push([String(w[0]), String(w[1])]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < out.length; i++) if (out[i][0] < out[i - 1][1]) throw bad(`Zeitfenster am ${day} überschneiden sich`);
  return out;
}

/** Day → windows. An empty list closes the day (holiday); windows replace the weekly hours of that day (extra hours). Past days are dropped. */
export function cleanOverrides(input: unknown, today: string): DateOverrides {
  if (input === null || input === undefined || input === '') return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw bad('Abweichende Tage: Objekt {Datum: Zeitfenster} erwartet');
  const out: DateOverrides = {};
  for (const [day, windows] of Object.entries(input as Record<string, unknown>)) {
    if (!validDay(day)) throw bad(`Abweichender Tag „${day}“: Datum als JJJJ-MM-TT angeben`);
    if (day < today) continue;
    out[day] = cleanWindows(windows, day);
  }
  if (Object.keys(out).length > MAX_OVERRIDES) throw bad(`Höchstens ${MAX_OVERRIDES} abweichende Tage`);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** The bookable windows of a day: its date-specific hours if there are any, otherwise the weekly hours. */
export function windowsFor(cal: { availability: Partial<Record<string, Windows>>; settings?: Record<string, any> }, ymd: string): Windows {
  const ov = cal.settings?.date_overrides?.[ymd];
  if (Array.isArray(ov)) return ov as Windows;
  return (cal.availability[weekdayKey(ymd)] ?? []) as Windows;
}

// --- limits ---------------------------------------------------------------------------------------

export function cleanLimit(v: unknown, what: string): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${what}: Zahl ab 0 angeben (0 = unbegrenzt)`);
  return Math.min(MAX_LIMIT, Math.round(n));
}

const COUNTED = `('confirmed', 'showed', 'noshow')`;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Bookings of the calendar starting in [fromYmd, toYmd) (local days), cancelled and blocked times not counted. */
export function bookedBetween(app: App, cal: { id: string; timezone: string }, fromYmd: string, toYmd: string, except?: string): number {
  const from = zonedToUtc(fromYmd, '00:00', cal.timezone).toISOString();
  const to = zonedToUtc(toYmd, '00:00', cal.timezone).toISOString();
  return app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM appointments WHERE calendar_id = ? AND status IN ${COUNTED} AND start_at >= ? AND start_at < ? AND id != ?`, cal.id, from, to, except ?? '')!.n;
}

/** Monday of the week (calendar's zone) a day belongs to. */
export const weekStartOf = (ymd: string) => addDaysYmd(ymd, -DAYS.indexOf(weekdayKey(ymd)));

/**
 * Busy blocks that take a whole day off the offer when the day's or the week's limit is reached. Fed into `busyFor`, so the
 * public page, the staff form, the phone agent and workflow bookings all see the same free times. `except` = an appointment
 * that is being moved (it does not count against its own day).
 */
export function limitBlocks(app: App, cal: { id: string; timezone: string; settings: Record<string, any> }, ymd: string, except?: string): { start_at: string; end_at: string }[] {
  const day = Number(cal.settings.limit_day) || 0;
  const week = Number(cal.settings.limit_week) || 0;
  if (!day && !week) return [];
  const full = day > 0 && bookedBetween(app, cal, ymd, addDaysYmd(ymd, 1), except) >= day;
  const wk = !full && week > 0 && bookedBetween(app, cal, weekStartOf(ymd), addDaysYmd(weekStartOf(ymd), 7), except) >= week;
  if (!full && !wk) return [];
  return [{ start_at: zonedToUtc(ymd, '00:00', cal.timezone).toISOString(), end_at: zonedToUtc(addDaysYmd(ymd, 1), '00:00', cal.timezone).toISOString() }];
}

// --- reminders, follow-up, no-show ----------------------------------------------------------------

export interface Reminder {
  id: string;
  /** Hours before the start (0.25 to 720). */
  hours: number;
  email: boolean;
  sms: boolean;
  subject: string;
  body: string;
  sms_body: string;
}

export interface AfterMessage {
  enabled: boolean;
  /** Follow-up: hours after the end of the appointment (0 to 720). Unused for no-shows (they go out when the status is set). */
  hours: number;
  email: boolean;
  sms: boolean;
  subject: string;
  body: string;
  sms_body: string;
  /** Set by the server when the message is switched on: older appointments never get it. */
  enabled_at: string | null;
}

export const DEFAULT_SMS_REMINDER = 'Erinnerung: {{calendar.name}} am {{appointment.start_text}}. Absagen/verschieben: {{appointment.manage_url}} – {{location.name}}';
export const DEFAULT_FOLLOWUP = {
  subject: 'Danke für den Termin: {{calendar.name}}',
  body: 'Hallo {{contact.first_name|du}},\n\nvielen Dank für unseren Termin „{{calendar.name}}“ am {{appointment.start_text}}. Wenn du Fragen hast, antworte einfach auf diese Nachricht.\n\n{{location.name}}',
  sms_body: 'Danke für den Termin „{{calendar.name}}“ am {{appointment.start_text}}. Bei Fragen melde dich gern. {{location.name}}',
};
export const DEFAULT_NOSHOW = {
  subject: 'Schade, wir haben dich vermisst',
  body: 'Hallo {{contact.first_name|du}},\n\nbei deinem Termin „{{calendar.name}}“ am {{appointment.start_text}} haben wir dich leider nicht erreicht. Hier kannst du einen neuen Termin buchen: {{appointment.booking_url}}\n\n{{location.name}}',
  sms_body: 'Wir haben dich beim Termin am {{appointment.start_text}} vermisst. Neuen Termin buchen: {{appointment.booking_url}} – {{location.name}}',
};

const bool = (v: unknown) => v === true || v === 'true' || v === 1;
const text = (v: unknown, what: string, max: number) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw bad(`${what} ist zu lang`);
  return s;
};
const hoursOf = (v: unknown, min: number, max: number, what: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${what}: zwischen ${min} und ${max} Stunden`);
  return Math.round(n * 100) / 100;
};

export function cleanReminders(input: unknown): Reminder[] {
  if (!Array.isArray(input)) throw bad('Erinnerungen: Liste erwartet');
  if (input.length > MAX_REMINDERS) throw bad(`Höchstens ${MAX_REMINDERS} Erinnerungen`);
  const out: Reminder[] = [];
  for (const r of input) {
    const hours = hoursOf(r?.hours, 0.25, 720, 'Erinnerung');
    const email = bool(r?.email);
    const sms = bool(r?.sms);
    if (!email && !sms) throw bad(`Erinnerung ${hours} Std. vorher braucht E-Mail oder SMS`);
    if (out.some((x) => x.hours === hours)) throw bad(`Zwei Erinnerungen ${hours} Std. vorher – bitte nur eine`);
    out.push({ id: `h${String(hours).replace('.', '_')}`, hours, email, sms, subject: text(r?.subject, 'Betreff', 300), body: text(r?.body, 'Text', 5000), sms_body: text(r?.sms_body, 'SMS-Text', 480) });
  }
  return out.sort((a, b) => b.hours - a.hours);
}

export function cleanAfter(input: unknown, prev: Partial<AfterMessage> | undefined, kind: 'followup' | 'noshow', at: string): AfterMessage {
  const b = (input ?? {}) as Record<string, unknown>;
  const label = kind === 'followup' ? 'Nachfassen' : 'Nicht erschienen';
  const enabled = bool(b.enabled);
  const email = b.email === undefined ? true : bool(b.email);
  const sms = bool(b.sms);
  if (enabled && !email && !sms) throw bad(`${label}: E-Mail oder SMS wählen`);
  return {
    enabled,
    hours: kind === 'followup' ? hoursOf(b.hours ?? 2, 0, 720, label) : 0,
    email,
    sms,
    subject: text(b.subject, 'Betreff', 300),
    body: text(b.body, 'Text', 5000),
    sms_body: text(b.sms_body, 'SMS-Text', 480),
    // Switching on starts the clock; switching off and on again restarts it.
    enabled_at: enabled ? (prev?.enabled && prev.enabled_at ? prev.enabled_at : at) : null,
  };
}

/**
 * Validates the booking keys of a calendar's settings (only those present) – the rest of the settings is left alone.
 * `prev` = the stored settings, `today` = the calendar's current day, `at` = now.
 */
export function normalizeBookingSettings(next: Record<string, any>, prev: Record<string, any>, today: string, at = new Date().toISOString()): Record<string, any> {
  const out = { ...next };
  if ('limit_day' in next) out.limit_day = cleanLimit(next.limit_day, 'Limit pro Tag');
  if ('limit_week' in next) out.limit_week = cleanLimit(next.limit_week, 'Limit pro Woche');
  if ('date_overrides' in next) out.date_overrides = cleanOverrides(next.date_overrides, today);
  if ('reminder_sms_body' in next) out.reminder_sms_body = text(next.reminder_sms_body, 'SMS-Text', 480);
  if ('reminders' in next) {
    if (next.reminders === null || next.reminders === undefined) delete out.reminders;
    else out.reminders = cleanReminders(next.reminders);
  }
  for (const kind of ['followup', 'noshow'] as const) {
    if (!(kind in next)) continue;
    if (next[kind] === null || next[kind] === undefined) delete out[kind];
    else out[kind] = cleanAfter(next[kind], prev?.[kind], kind, at);
  }
  return out;
}

/** The calendar's current day. */
export const todayOf = (cal: { timezone: string }, at = new Date()) => ymdInTz(at, cal.timezone);
