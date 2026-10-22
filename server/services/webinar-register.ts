import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { sliceTimer } from '../core/perf.js';
import { isValidTz } from '../core/time.js';
import { render } from '../core/template.js';
import { id as newId, normalizeEmail } from '../core/util.js';
import { addTags, getContact, logActivity, upsertContact, type Contact } from './contacts.js';
import { notifyTeam, sendToContact } from './messaging.js';
import { offersSession, sessionEnd, sessionKey, upcomingSessions, type SessionKind } from './webinar-schedule.js';
import { clock, getRegistration, getWebinar, linksOf, locationTz, timeText, webinarTz, whenText, type Registration, type Webinar } from './webinar-store.js';

/**
 * Registering a contact for a session, the confirmation (with .ics) and the reminders. Used by the public page, forms,
 * the workflow action, the team's manual registration and the MCP tool – they all end up in `registerContact`.
 */

export interface RegisterInput {
  contact_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  phone?: string;
  /** ISO start of the session, 'ondemand', or empty = the next session. */
  session?: string;
  tz?: string;
  source: string;
  consent?: boolean;
  sms_consent?: boolean;
  /** Skip the confirmation e-mail (imports). */
  silent?: boolean;
  extra?: Record<string, unknown>;
}

export interface Registered {
  registration: Registration;
  contact: Contact;
  created: boolean;
  session: { start: string; kind: SessionKind };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The clock of the webinar module (tests move it with `app.services.webinarNow`). */
export const nowOf = (app: App): Date => (app.services.webinarNow ? new Date(Number(app.services.webinarNow())) : new Date());
const iso = (app: App) => nowOf(app).toISOString();

const countFor = (app: App, webinarId: string, start: string) => Number(app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM webinar_registrations WHERE webinar_id = ? AND session_start = ? AND status = 'registered'`, webinarId, start)?.n ?? 0);

/** The sessions somebody can register for right now, with how many seats are left. */
export function bookable(app: App, w: Webinar, at = nowOf(app)) {
  const max = w.schedule.max_per_session;
  return upcomingList(app, w, at).map((s) => {
    const taken = s.kind === 'ondemand' ? 0 : countFor(app, w.id, s.start);
    return { ...s, taken, full: max > 0 && taken >= max };
  });
}
const upcomingList = (app: App, w: Webinar, at: Date) => upcomingSessions(w.schedule, locationTz(app, w.location_id), at);

/** Registers a contact; the same contact for the same session gives back the existing registration. */
export function registerContact(app: App, w: Webinar, input: RegisterInput): Registered {
  const at = nowOf(app);
  const tz = isValidTz(String(input.tz ?? '')) ? String(input.tz) : webinarTz(app, w);
  if (w.status !== 'published') throw new HttpError(409, 'Dieses Webinar ist noch nicht veröffentlicht');

  // 1) the person (an error about the input comes before the search for a seat)
  let contact: Contact | undefined;
  if (input.contact_id) {
    contact = getContact(app, w.location_id, input.contact_id);
    if (!contact) throw bad('Kontakt nicht gefunden');
    if (!contact.email) throw bad('Der Kontakt hat keine E-Mail-Adresse – ohne sie kann es keine Bestätigung geben');
  } else {
    const email = normalizeEmail(input.email);
    if (!EMAIL.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
    if (!String(input.first_name ?? input.name ?? '').trim()) throw bad('Bitte den Vornamen angeben');
  }

  // 2) the session
  let start = String(input.session ?? '').trim();
  let kind: SessionKind;
  if (start === 'ondemand' || (!start && w.schedule.ondemand.enabled && !w.schedule.fixed.enabled && !w.schedule.dates.length && !w.schedule.jit.enabled)) {
    if (!w.schedule.ondemand.enabled) throw bad('„Sofort starten“ ist für dieses Webinar nicht eingerichtet');
    start = sessionKey(at.getTime());
    kind = 'ondemand';
  } else {
    if (!start) {
      const next = upcomingList(app, w, at).find((s) => s.kind !== 'ondemand' && !(w.schedule.max_per_session > 0 && countFor(app, w.id, s.start) >= w.schedule.max_per_session));
      if (!next) throw new HttpError(409, 'Zurzeit ist kein Termin buchbar');
      start = next.start;
    }
    const k = offersSession(w.schedule, locationTz(app, w.location_id), start, at);
    if (!k) throw bad('Diesen Termin gibt es nicht (mehr) – bitte einen anderen wählen');
    kind = k;
  }

  // 3) the seat
  const existing = (c: Contact) => {
    if (kind === 'ondemand') {
      // Somebody who clicks twice, or comes back, keeps the session that is still running.
      return app.db.get<Registration>(`SELECT * FROM webinar_registrations WHERE webinar_id = ? AND contact_id = ? AND session_kind = 'ondemand' AND status = 'registered' AND session_start > ? ORDER BY session_start DESC LIMIT 1`, w.id, c.id, new Date(at.getTime() - Math.max(w.duration_s, 600) * 1000).toISOString());
    }
    return app.db.get<Registration>('SELECT * FROM webinar_registrations WHERE webinar_id = ? AND contact_id = ? AND session_start = ?', w.id, c.id, start);
  };
  if (contact) {
    const have = existing(contact);
    if (have) return reuse(app, w, have, contact, tz);
  }
  const max = w.schedule.max_per_session;
  if (kind !== 'ondemand' && max > 0 && countFor(app, w.id, start) >= max) throw new HttpError(409, 'Dieser Termin ist leider ausgebucht – bitte einen anderen wählen');

  if (!contact) {
    const r = upsertContact(
      app,
      w.location_id,
      { email: input.email, first_name: input.first_name, last_name: input.last_name, name: input.name, phone: input.phone, ...(input.extra ?? {}) },
      // The registration page is public: it never changes a stored e-mail address or phone number (services/contacts.ts).
      { source: `Webinar: ${w.title}`.slice(0, 120), tags: w.settings.registration.tags, publicInput: input.source === 'page' },
    );
    contact = r.contact;
    const have = existing(contact);
    if (have) return reuse(app, w, have, contact, tz);
  } else if (w.settings.registration.tags.length) addTags(app, w.location_id, contact.id, w.settings.registration.tags);
  if (input.phone && contact && !contact.phone) app.db.run('UPDATE contacts SET phone = ? WHERE id = ? AND phone = ?', String(input.phone).slice(0, 40), contact.id, '');

  const row: Record<string, unknown> = {
    id: newId(),
    location_id: w.location_id,
    webinar_id: w.id,
    contact_id: contact.id,
    session_start: start,
    session_kind: kind,
    tz,
    source: input.source.slice(0, 30),
    status: 'registered',
    consent_at: input.consent ? iso(app) : null,
    sms_consent: input.sms_consent ? 1 : 0,
    created_at: iso(app),
  };
  app.db.insert('webinar_registrations', row);
  const reg = getRegistration(app, row.id as string)!;
  const links = linksOf(app, w, reg.id);
  logActivity(app, w.location_id, contact.id, 'webinar.registered', `Für Webinar „${w.title}“ angemeldet (${whenText(start, tz)})`, { webinar_id: w.id, session: start });
  app.events.emit(w.location_id, 'webinar.registered', eventData(app, w, reg, contact, { join_url: links.join_url, replay_url: links.replay_url }));
  if (!input.silent) void sendConfirmation(app, w, reg).catch((e) => console.error('[webinar] confirmation:', e));
  if (w.settings.registration.notify_team) void notifyTeam(app, w.location_id, `Neue Webinar-Anmeldung: ${w.title}`, `${contact.first_name} ${contact.last_name} <${contact.email}>\nTermin: ${whenText(start, webinarTz(app, w))}`).catch(() => undefined);
  return { registration: reg, contact, created: true, session: { start, kind } };
}

function reuse(app: App, w: Webinar, reg: Registration, contact: Contact, tz: string): Registered {
  // A cancelled seat comes back when the person registers again.
  if (reg.status === 'cancelled') app.db.run(`UPDATE webinar_registrations SET status = 'registered', tz = ? WHERE id = ?`, tz, reg.id);
  return { registration: getRegistration(app, reg.id)!, contact, created: false, session: { start: reg.session_start, kind: reg.session_kind as SessionKind } };
}

/** The data every webinar event carries (workflows read it as {{event.…}}). */
export function eventData(app: App, w: Webinar, reg: Registration, contact: Contact | undefined, extra: Record<string, unknown> = {}) {
  return {
    contactId: reg.contact_id,
    ...(contact ? { contact } : {}),
    webinarId: w.id,
    webinar: { id: w.id, title: w.title, slug: w.slug },
    registrationId: reg.id,
    session: { start: reg.session_start, end: sessionEnd(reg.session_start, w.duration_s), kind: reg.session_kind },
    ...linksOnly(app, w, reg),
    ...extra,
  };
}
const linksOnly = (app: App, w: Webinar, reg: Registration) => {
  const l = linksOf(app, w, reg.id);
  return { join_url: l.join_url, replay_url: l.replay_url };
};

export function cancelRegistration(app: App, w: Webinar, reg: Registration, by: string) {
  if (reg.status === 'cancelled') return;
  app.db.run(`UPDATE webinar_registrations SET status = 'cancelled' WHERE id = ?`, reg.id);
  logActivity(app, w.location_id, reg.contact_id, 'webinar.cancelled', `Webinar-Anmeldung „${w.title}“ abgesagt (${by})`, { webinar_id: w.id, session: reg.session_start });
}

// --- e-mail and SMS --------------------------------------------------------------------------------

function mergeData(app: App, w: Webinar, reg: Registration, contact: Contact) {
  const tz = isValidTz(reg.tz) ? reg.tz : webinarTz(app, w);
  const links = linksOf(app, w, reg.id);
  const loc = app.location(w.location_id);
  return {
    contact,
    location: { name: loc?.name ?? '' },
    webinar: { title: w.title, presenter: w.presenter_name, description: w.description, duration: clock(w.duration_s) },
    session: { start: reg.session_start, start_text: whenText(reg.session_start, tz), start_time: timeText(reg.session_start, tz), tz },
    ...links,
  };
}

/** The .ics of a registration: one event with the personal link, a reminder 15 minutes before. */
export function icsOf(app: App, w: Webinar, reg: Registration): string {
  const fmt = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\r?\n/g, '\\n');
  const links = linksOf(app, w, reg.id);
  const end = sessionEnd(reg.session_start, Math.max(w.duration_s, 900));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HyperLevel//Webinar//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${reg.id}@gohigh-webinar`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(reg.session_start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(w.title)}`,
    `DESCRIPTION:${esc(`${w.presenter_name ? `${w.presenter_name}\n` : ''}Automatisiertes Webinar – hier geht es zum Raum: ${links.join_url}`)}`,
    `URL:${links.join_url}`,
    `STATUS:${reg.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(w.title)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // Lines are folded at 75 octets (RFC 5545).
  return lines.flatMap((l) => fold(l)).join('\r\n') + '\r\n';
}
function fold(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l));
}

/** Confirmation with the .ics attached (where the sender supports attachments) and linked. */
export async function sendConfirmation(app: App, w: Webinar, reg: Registration) {
  const contact = getContact(app, w.location_id, reg.contact_id);
  if (!contact?.email) return;
  const data = mergeData(app, w, reg, contact);
  const s = w.settings.reminders;
  await sendToContact(app, w.location_id, {
    contactId: contact.id,
    channel: 'email',
    subject: render(s.confirmation_subject, data),
    body: render(s.confirmation_body, data),
    source: 'Webinar-Bestätigung',
    ignoreDnd: true,
    attachments: [{ filename: 'webinar.ics', content: icsOf(app, w, reg), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }],
  });
  app.db.run(`INSERT OR REPLACE INTO webinar_reminders (registration_id, key, channel, status, error, sent_at) VALUES (?, 'confirmation', 'email', 'sent', '', ?)`, reg.id, iso(app));
}

/** Asked to send the confirmation again (e.g. somebody registers twice): at most once in ten minutes. */
export async function resendConfirmation(app: App, w: Webinar, reg: Registration): Promise<boolean> {
  const last = app.db.get<{ sent_at: string }>(`SELECT sent_at FROM webinar_reminders WHERE registration_id = ? AND key = 'confirmation' AND channel = 'email'`, reg.id);
  if (last && nowOf(app).getTime() - Date.parse(last.sent_at) < 10 * 60_000) return false;
  await sendConfirmation(app, w, reg);
  return true;
}

// --- reminders -------------------------------------------------------------------------------------

/** A reminder is still worth sending this long after its moment (server was off, tick delayed). */
const REMINDER_GRACE_MS = 20 * 60_000;

/**
 * Sends the reminders that are due: for every registration of a coming session, each configured reminder once per channel.
 * Reminders whose moment lay before the person registered (or too long ago) are skipped – nobody gets "24 hours before"
 * a minute after signing up. E-mail and SMS go through the sub-account's senders and respect "Nicht stören".
 */
export async function sendDueReminders(app: App, at = nowOf(app)): Promise<number> {
  const nowMs = at.getTime();
  // Sessions that start within the longest reminder offset (14 days) and have not ended.
  const rows = app.db.all<Registration & { w_status: string }>(
    `SELECT r.*, w.status AS w_status FROM webinar_registrations r JOIN webinars w ON w.id = r.webinar_id
     WHERE r.status = 'registered' AND r.attended_at IS NULL AND r.session_start > ? AND r.session_start <= ? AND w.status = 'published'
     ORDER BY r.session_start LIMIT 500`,
    new Date(nowMs - 60 * 60_000).toISOString(),
    new Date(nowMs + 15 * 86_400_000).toISOString(),
  );
  let sent = 0;
  const pause = sliceTimer(40);
  const cache = new Map<string, Webinar | undefined>();
  for (const reg of rows) {
    await pause();
    if (!cache.has(reg.webinar_id)) cache.set(reg.webinar_id, getWebinar(app, { id: reg.webinar_id }));
    const w = cache.get(reg.webinar_id);
    if (!w || w.location_id !== reg.location_id) continue;
    const startMs = Date.parse(reg.session_start);
    const createdMs = Date.parse(reg.created_at);
    for (const item of w.settings.reminders.items) {
      const dueMs = startMs - item.offset_min * 60_000;
      if (dueMs > nowMs || nowMs - dueMs > REMINDER_GRACE_MS) continue;
      // The moment lay before the registration – except "at the start", which always applies.
      if (item.offset_min > 0 && dueMs < createdMs) continue;
      const contact = getContact(app, w.location_id, reg.contact_id);
      if (!contact) continue;
      const data = mergeData(app, w, reg, contact);
      for (const channel of ['email', 'sms'] as const) {
        if (!item[channel]) continue;
        if (channel === 'sms' && (!reg.sms_consent || !contact.phone)) continue;
        // The row is the claim: whoever inserts it sends; a second tick finds it taken.
        const claimed = app.db.run(`INSERT OR IGNORE INTO webinar_reminders (registration_id, key, channel, status, error, sent_at) VALUES (?, ?, ?, 'sending', '', ?)`, reg.id, item.key, channel, iso(app)).changes > 0;
        if (!claimed) continue;
        try {
          const out = await sendToContact(app, w.location_id, channel === 'email' ? { contactId: contact.id, channel, subject: render(item.subject, data), body: render(item.body, data), source: 'Webinar-Erinnerung' } : { contactId: contact.id, channel, body: render(item.sms_text, data), source: 'Webinar-Erinnerung' });
          const failed = (out as { status?: string }).status === 'failed';
          app.db.run('UPDATE webinar_reminders SET status = ?, error = ? WHERE registration_id = ? AND key = ? AND channel = ?', failed ? 'failed' : 'sent', failed ? String((out as { error?: string }).error ?? '').slice(0, 200) : '', reg.id, item.key, channel);
          if (!failed) sent++;
        } catch (e) {
          app.db.run(`UPDATE webinar_reminders SET status = 'failed', error = ? WHERE registration_id = ? AND key = ? AND channel = ?`, (e as Error).message.slice(0, 200), reg.id, item.key, channel);
        }
      }
    }
  }
  return sent;
}
