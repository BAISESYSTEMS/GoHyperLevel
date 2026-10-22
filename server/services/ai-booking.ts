import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad } from '../core/http.js';
import { addDaysYmd, formatInTz, hmInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { bookAppointment, busyFor, computeSlots, type CalendarRow } from '../modules/calendars.js';
import { getContact, type Contact } from './contacts.js';
import { slotLines } from './voice-ai.js';

/**
 * Booking by AI (docs/booking.md#ai-books-appointments): the phone agent's booking logic – free times per day from the calendar's
 * own rules, and booking a slot through the normal pipeline (slot check, contact, confirmation) – shared by the KI-Telefonagent,
 * the website chat bot of the KI-Assistent and the agents' auto-replies in every inbox channel. The AI only ever books free slots
 * of calendars the sub-account released for it, never paid calendars or ones with required questions (those go through the
 * booking page), and at most a few times per contact and day. The confirmation carries links to reschedule and cancel.
 */

export interface AiBookingSettings {
  /** The website chat bot of the KI-Assistent may check free times and book ("Termin buchen"). */
  chat_bot: boolean;
  /** Calendars the AI may book (empty = every active calendar that needs no payment and has no required questions). */
  calendars: string[];
  /** Bookings by AI per contact within 24 hours. */
  per_contact_day: number;
}

export const DEFAULT_AI_BOOKING: AiBookingSettings = { chat_bot: false, calendars: [], per_contact_day: 2 };
/** Bookings by AI per sub-account and hour (all channels together). */
export const PER_LOCATION_HOUR = 30;
export const AI_SOURCES = ['KI-Telefonagent', 'KI-Assistent', 'KI-Agent', 'KI-Buchung'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

const validDay = (s: string) => YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export function loadSettings(app: App, locationId: string): AiBookingSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM ai_booking_settings WHERE location_id = ?', locationId);
  let data: Partial<AiBookingSettings> = {};
  try {
    data = row ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  return { ...DEFAULT_AI_BOOKING, ...data, calendars: Array.isArray(data.calendars) ? data.calendars.filter((x) => typeof x === 'string') : [] };
}

export function cleanSettings(app: App, locationId: string, b: Record<string, unknown>, cur: AiBookingSettings): AiBookingSettings {
  const out = { ...cur };
  if (b.chat_bot !== undefined) out.chat_bot = b.chat_bot === true;
  if (b.calendars !== undefined) {
    if (!Array.isArray(b.calendars)) throw bad('Kalender: Liste von IDs erwartet');
    const own = new Set(app.db.all<{ id: string }>('SELECT id FROM calendars WHERE location_id = ?', locationId).map((r) => r.id));
    const ids = [...new Set(b.calendars.map(String))];
    const unknown = ids.find((x) => !own.has(x));
    if (unknown) throw bad('Kalender nicht gefunden');
    out.calendars = ids.slice(0, 50);
  }
  if (b.per_contact_day !== undefined) {
    const n = Math.round(Number(b.per_contact_day));
    if (!Number.isFinite(n) || n < 1 || n > 10) throw bad('Buchungen je Kontakt und Tag: 1 bis 10');
    out.per_contact_day = n;
  }
  return out;
}

/** Does a calendar need the booking page (payment first, required questions)? Team-Kalender config only. */
function needsBookingPage(app: App, calId: string): boolean {
  try {
    const row = app.db.get<{ data: string }>('SELECT data FROM teamcal_config WHERE calendar_id = ?', calId);
    if (!row) return false;
    const cfg = JSON.parse(row.data);
    return (cfg.payment?.mode && cfg.payment.mode !== 'none') || (Array.isArray(cfg.questions) && cfg.questions.some((q: any) => q?.required));
  } catch {
    return false;
  }
}

/** The calendars the AI may book in this sub-account. */
export function bookableCalendars(app: App, locationId: string, s: AiBookingSettings = loadSettings(app, locationId)): CalendarRow[] {
  const all = app.db.all<CalendarRow>('SELECT * FROM calendars WHERE location_id = ? AND active = 1 ORDER BY name', locationId).map((c) => parseJson(c, ['availability', 'settings']));
  return all.filter((c) => (!s.calendars.length || s.calendars.includes(c.id)) && !needsBookingPage(app, c.id));
}

const spread = <T>(xs: T[], n: number): T[] => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]));

/** Free start times of a day: Team-Kalender rules (round robin, collective, seats) when it is a team calendar, else the calendar's own. */
export function slotsOfDay(app: App, cal: CalendarRow, ymd: string): string[] {
  return (app.services.teamcalSlots?.(cal, ymd) as string[] | undefined) ?? computeSlots(cal, ymd, busyFor(app, cal, ymd));
}

/** Days with free times from `from` on: at most `maxDays` days with up to `perDay` times each (spread over the day). */
export function freeDays(app: App, cal: CalendarRow, from: string, days: number, perDay: number, maxDays: number): { date: string; times: string[] }[] {
  const out: { date: string; times: string[] }[] = [];
  for (let i = 0; i < days && out.length < maxDays; i++) {
    const ymd = addDaysYmd(from, i);
    const slots = slotsOfDay(app, cal, ymd);
    if (slots.length) out.push({ date: ymd, times: spread(slots, perDay).map((iso) => hmInTz(new Date(iso), cal.timezone)) });
  }
  return out;
}

export const calLabel = (c: CalendarRow) => `Kalender „${c.name}“ (calendar_id: ${c.id}, ${c.duration} Minuten, Zeitzone ${c.timezone})`;

/** The free times of the next two weeks per calendar, for a prompt. */
export function slotsBlock(app: App, cals: CalendarRow[]): string {
  const parts = cals.map((c) => {
    const lines = slotLines(freeDays(app, c, ymdInTz(new Date(), c.timezone), 14, 4, 5));
    return `${calLabel(c)}:\n${lines || 'in den nächsten 14 Tagen nichts frei'}`;
  });
  return `<freie_termine>\n${parts.join('\n\n')}\nWeitere Zeiten eines Tages liefert check_slots.\n</freie_termine>`;
}

/** The calendar the model named – only one of the released ones; without a name the only released calendar. */
export function pickCalendar(cals: CalendarRow[], calendarId: unknown): CalendarRow | undefined {
  const idv = String(calendarId ?? '').trim();
  if (!idv) return cals.length === 1 ? cals[0] : undefined;
  return cals.find((c) => c.id === idv);
}

/** Free times of one day – or, when nothing is free, the next days that have some (text for the model plus the data). */
export function checkSlots(app: App, cal: CalendarRow, date: string) {
  if (!validDay(date)) throw bad('Datum als JJJJ-MM-TT angeben');
  const day = freeDays(app, cal, date, 1, 16, 1)[0];
  const next = day ? [] : freeDays(app, cal, addDaysYmd(date, 1), 14, 4, 3);
  const text = day
    ? `Freie Zeiten in ${calLabel(cal)}:\n${slotLines([day])}`
    : `Am ${date} ist in ${calLabel(cal)} nichts frei.${next.length ? ` Nächste freie Tage:\n${slotLines(next)}` : ' In den 14 Tagen danach auch nicht.'}`;
  return { calendar_id: cal.id, date, times: day?.times ?? [], next, text };
}

/** Links of a booked appointment: manage (cancel) and reschedule. */
export function links(app: App, appt: { manage_token: string }) {
  const base = app.baseUrl();
  return { manage_url: `${base}/book/manage/${appt.manage_token}`, reschedule_url: `${base}/book/move/${appt.manage_token}`, cancel_url: `${base}/book/manage/${appt.manage_token}` };
}

/** The confirmation the contact gets in the channel they wrote in – always with the links to reschedule and to cancel. */
export function confirmationText(app: App, appt: { start_at: string; manage_token: string }, cal: CalendarRow): string {
  const l = links(app, appt);
  const when = formatInTz(appt.start_at, cal.timezone, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Termin gebucht: ${cal.name} am ${when} Uhr (${cal.timezone}).\nVerschieben: ${l.reschedule_url}\nAbsagen: ${l.cancel_url}`;
}

export interface BookRequest {
  calendarId: unknown;
  date: unknown;
  time: unknown;
  /** A known contact, or what the person said (name, e-mail, phone) – typed input never changes a stored e-mail or phone. */
  contact: { id: string } | Record<string, unknown>;
  notes?: string;
  source: string;
}

export type BookOutcome =
  | { ok: true; appointment: any; calendar: CalendarRow; confirmation: string; manage_url: string; reschedule_url: string; cancel_url: string }
  | { ok: false; error: string; text: string };

/** How often AI booked for this contact in the last 24 hours, and in this sub-account in the last hour. */
function usage(app: App, locationId: string, contactId: string | null) {
  const marks = AI_SOURCES.map(() => '?').join(', ');
  const day = new Date(Date.now() - 864e5).toISOString();
  const hour = new Date(Date.now() - 3600_000).toISOString();
  const perContact = contactId
    ? app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM appointments WHERE location_id = ? AND contact_id = ? AND source IN (${marks}) AND created_at > ?`, locationId, contactId, ...AI_SOURCES, day)!
        .n
    : 0;
  const perLocation = app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM appointments WHERE location_id = ? AND source IN (${marks}) AND created_at > ?`, locationId, ...AI_SOURCES, hour)!.n;
  return { perContact, perLocation };
}

/**
 * Books a free slot for the AI (chat bot, agent, MCP). Failures come back as text for the model – with free alternatives – rather
 * than as an exception, so the conversation can go on.
 */
export function bookSlot(app: App, locationId: string, r: BookRequest, s: AiBookingSettings = loadSettings(app, locationId)): BookOutcome {
  const cals = bookableCalendars(app, locationId, s);
  const fail = (error: string, extra = ''): BookOutcome => ({ ok: false, error, text: `Buchung nicht möglich: ${error}${extra}` });
  if (!cals.length) return fail('Für die KI ist kein Kalender freigegeben.');
  const cal = pickCalendar(cals, r.calendarId);
  if (!cal) return fail(`Kalender unbekannt. Erlaubt: ${cals.map((c) => `${c.name} (${c.id})`).join(', ')}`);
  const date = String(r.date ?? '');
  const time = String(r.time ?? '');
  if (!validDay(date)) return fail('Datum als JJJJ-MM-TT angeben.');
  if (!HM.test(time)) return fail('Uhrzeit als HH:MM angeben.');
  const known = 'id' in r.contact && typeof r.contact.id === 'string' ? getContact(app, locationId, r.contact.id) : undefined;
  if ('id' in r.contact && r.contact.id && !known) return fail('Kontakt nicht gefunden.');
  const u = usage(app, locationId, known?.id ?? null);
  if (u.perContact >= s.per_contact_day) return fail(`Für diesen Kontakt wurden heute schon ${u.perContact} Termine von der KI gebucht – weitere Wünsche bitte an das Team übergeben.`);
  if (u.perLocation >= PER_LOCATION_HOUR) return fail('Zu viele Buchungen durch die KI in dieser Stunde – bitte an das Team übergeben.');
  const start = zonedToUtc(date, time, cal.timezone);
  try {
    const appt = bookAppointment(app, cal, {
      start: start.toISOString(),
      contact: known ? { id: known.id } : r.contact,
      notes: String(r.notes ?? '').slice(0, 3000),
      source: r.source,
      publicInput: true,
    });
    return { ok: true, appointment: appt, calendar: cal, confirmation: confirmationText(app, appt, cal), ...links(app, appt) };
  } catch (e) {
    const msg = e instanceof HttpError && e.status === 409 ? 'Diese Zeit ist leider nicht (mehr) frei.' : (e as Error).message;
    const alt = freeDays(app, cal, date, 7, 6, 2);
    return fail(msg, alt.length ? ` Freie Zeiten in ${calLabel(cal)}:\n${slotLines(alt)}` : '');
  }
}

/** The channel to confirm in: the one the contact last wrote on (falls back to e-mail, then SMS). */
export function replyChannel(app: App, locationId: string, contact: Contact, wanted?: unknown): string | null {
  const ok = (c: string) => c === 'chat' || (c === 'email' ? !!contact.email : c === 'sms' ? !!contact.phone : !!(app.services.messageChannels ?? {})[c]);
  if (typeof wanted === 'string' && wanted && ok(wanted)) return wanted;
  const last = app.db.get<{ channel: string }>(`SELECT channel FROM messages WHERE location_id = ? AND contact_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1`, locationId, contact.id);
  if (last && ok(last.channel)) return last.channel;
  if (contact.email) return 'email';
  if (contact.phone) return 'sms';
  return null;
}
