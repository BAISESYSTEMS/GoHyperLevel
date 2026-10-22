import type { App, LocationRow, Module } from '../core/app.js';
import { HttpError, notFound } from '../core/http.js';
import { textToHtml } from '../core/template.js';
import { formatInTz } from '../core/time.js';
import { id, normalizeEmail, now } from '../core/util.js';
import { icsFeed } from '../services/ical.js';
import { deliverEmail } from '../services/messaging.js';

/**
 * Guests per booking (HighLevel parity, docs/team-calendars.md#guests): a calendar with `guests_max` lets the visitor add e-mail
 * addresses on the booking page; the team-calendar pipeline validates them and passes them in `meta.guests` to `appointment.booked`
 * (also after a paid hold). This module keeps them per appointment and, a few minutes later and only while the appointment still
 * stands, sends each guest an invitation in the business's name: a fixed text with calendar, time, place or video link and the
 * calendar file attached – nothing the person booking typed (no spam relay) and no link that carries their manage token. Guest
 * addresses per IP on the public booking routes and invitations per sub-account and hour are limited. Guests are not made contacts
 * (only the person who booked agreed to be stored); they are kept by address and exported/erased with the person of that address.
 */

/** Invitations wait this long, so a booking that is cancelled (or rolled back) right away never mails anybody. */
export const GUEST_INVITE_DELAY_MS = 10 * 60_000;
/** Invitations per sub-account and hour; more wait for the next hour (while their appointment is still ahead). */
export const GUEST_INVITES_PER_HOUR = 50;
/** Guest addresses one IP may add on the public booking routes per hour. */
export const GUESTS_PER_IP_HOUR = 10;
const PUBLIC_BOOKING = new Set(['/api/public/team-calendars/:slug/book', '/api/public/team-calendars/:slug/book-many']);

const byIp = new Map<string, { at: number; n: number }[]>();

/** How many invitations a public booking request would cause: distinct guest addresses × the times booked at once. */
function invitesAsked(body: any): number {
  const raw = body?.guests;
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : []).map((x: unknown) => normalizeEmail(x)).filter(Boolean);
  const guests = Math.min(new Set(list).size, 50);
  const times = Array.isArray(body?.starts) ? Math.min(Math.max(new Set(body.starts.map(String)).size, 1), 20) : 1;
  return guests * times;
}

type Due = { gid: string; location_id: string; email: string; id: string; status: string; start_at: string; end_at: string; meeting_url: string | null; calendar_name: string; timezone: string | null; cal_settings: string | null };

/** The invitation: a fixed text of the business with the appointment's facts and the calendar file. */
function invitation(loc: LocationRow, r: Due) {
  let place = r.meeting_url || '';
  try {
    place ||= JSON.parse(r.cal_settings || '{}').meeting_location || '';
  } catch {
    /* plain */
  }
  const when = `${formatInTz(r.start_at, r.timezone || loc.timezone)} Uhr`;
  const text = `Hallo,\n\ndu bist zu einem Termin bei ${loc.name} eingeladen:\n\n${r.calendar_name}\n${when}${place ? `\nOrt/Link: ${place}` : ''}\n\nDie Kalenderdatei zum Eintragen hängt an. Wenn du diesen Termin nicht erwartest, kannst du diese E-Mail einfach ignorieren.\n\nViele Grüße\n${loc.name}`;
  const ics = icsFeed(r.calendar_name, [{ id: r.id, start_at: r.start_at, end_at: r.end_at, title: `${r.calendar_name} (${loc.name})`, description: place ? `Ort/Link: ${place}` : undefined }]);
  return { to: r.email, subject: `Einladung: ${r.calendar_name} am ${when}`, text, html: textToHtml(text), attachments: [{ filename: 'termin.ics', content: ics, contentType: 'text/calendar; charset=utf-8' }] };
}

/** Sends the invitations whose delay has passed (background tick); returns how many went out. */
export async function inviteDueGuests(app: App, at = Date.now()): Promise<number> {
  const { db } = app;
  const cutoff = new Date(at - GUEST_INVITE_DELAY_MS).toISOString();
  const nowIso = new Date(at).toISOString();
  let sent = 0;
  for (const { location_id } of db.all<{ location_id: string }>(`SELECT DISTINCT location_id FROM appointment_guests WHERE state = '' AND created_at <= ? LIMIT 200`, cutoff)) {
    let left = GUEST_INVITES_PER_HOUR - (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM appointment_guests WHERE location_id = ? AND invited_at > ?', location_id, new Date(at - 3600_000).toISOString())?.n ?? 0);
    const loc = app.location(location_id);
    if (!loc) continue;
    const rows = db.all<Due>(
      `SELECT g.id AS gid, g.location_id, g.email, a.id, a.status, a.start_at, a.end_at, a.meeting_url, c.name AS calendar_name, c.timezone, c.settings AS cal_settings
       FROM appointment_guests g JOIN appointments a ON a.id = g.appointment_id JOIN calendars c ON c.id = a.calendar_id
       WHERE g.location_id = ? AND g.state = '' AND g.created_at <= ? ORDER BY g.created_at LIMIT 100`,
      location_id,
      cutoff,
    );
    for (const r of rows) {
      // Cancelled (also a rolled-back multi booking) or already over: no invitation.
      if (r.status !== 'confirmed' || r.end_at <= nowIso) {
        db.run(`UPDATE appointment_guests SET state = 'skipped' WHERE id = ?`, r.gid);
        continue;
      }
      if (left <= 0) continue;
      left--;
      try {
        await deliverEmail(loc, invitation(loc, r));
        db.run(`UPDATE appointment_guests SET state = 'sent', invited_at = ? WHERE id = ?`, now(), r.gid);
        sent++;
      } catch (err) {
        db.run(`UPDATE appointment_guests SET state = 'failed' WHERE id = ?`, r.gid);
        console.error('[booking-guests]', (err as Error).message);
      }
    }
  }
  return sent;
}

export const bookingGuestsModule: Module = {
  name: 'booking-guests',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE appointment_guests (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE, email TEXT NOT NULL,
        invited_at TEXT, created_at TEXT NOT NULL, UNIQUE(appointment_id, email)
      );
      CREATE INDEX appointment_guests_email ON appointment_guests(location_id, email);
      `,
    ],
    [
      // Invitations are queued ('' = waiting) and sent by the tick; rows from before were handled at booking already.
      '002-queue',
      `
      ALTER TABLE appointment_guests ADD COLUMN state TEXT NOT NULL DEFAULT '';
      UPDATE appointment_guests SET state = 'done';
      CREATE INDEX appointment_guests_queue ON appointment_guests(state, created_at);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;

    // Guest addresses per IP on the public booking routes (each one becomes a mail in the business's name).
    router.wrappers.push((route, next) => {
      if (route.method !== 'POST' || !PUBLIC_BOOKING.has(route.pattern)) return next;
      return async (ctx) => {
        const n = invitesAsked(ctx.body);
        if (!n) return next(ctx);
        const t = Date.now();
        const list = (byIp.get(ctx.ip) ?? []).filter((x) => t - x.at < 3600_000);
        if (list.reduce((s, x) => s + x.n, 0) + n > GUESTS_PER_IP_HOUR) throw new HttpError(429, 'Zu viele Gäste-Einladungen – bitte später noch einmal oder ohne Gäste buchen');
        const entry = { at: t, n };
        byIp.set(ctx.ip, [...list, entry]);
        if (byIp.size > 20_000) byIp.clear();
        try {
          return await next(ctx);
        } catch (e) {
          // A booking that did not happen costs nothing.
          byIp.set(ctx.ip, (byIp.get(ctx.ip) ?? []).filter((x) => x !== entry));
          throw e;
        }
      };
    });

    app.events.on('appointment.booked', (e) => {
      const list = String(e.data.meta?.guests ?? '')
        .split(',')
        .map((x) => normalizeEmail(x))
        .filter(Boolean)
        .slice(0, 10);
      const appt = e.data.appointment;
      if (!list.length || !appt?.id) return;
      if (!db.get('SELECT 1 FROM appointments WHERE id = ? AND location_id = ?', appt.id, e.locationId)) return;
      for (const email of list) db.run('INSERT OR IGNORE INTO appointment_guests (id, location_id, appointment_id, email, created_at) VALUES (?, ?, ?, ?, ?)', id(), e.locationId, appt.id, email, now());
    });
    app.onTick(() => inviteDueGuests(app).then(() => undefined));

    router.get('/api/appointments/:id/guests', 'location', (ctx) => {
      if (!db.get('SELECT 1 FROM appointments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId)) throw notFound('Termin nicht gefunden');
      return db.all('SELECT email, invited_at, created_at FROM appointment_guests WHERE appointment_id = ? ORDER BY created_at, email', ctx.params.id);
    });
    // Appointment lists (calendar page, app) get the guests – one query for the whole list.
    const prevRows = app.services.appointmentRows;
    app.services.appointmentRows = (rows: any[]) => {
      const out: any[] = prevRows ? prevRows(rows) : rows;
      const ids = out.map((r) => r?.id).filter(Boolean).slice(0, 2000);
      if (!ids.length) return out;
      const byAppt = new Map<string, string[]>();
      for (const g of db.all<{ appointment_id: string; email: string }>(`SELECT appointment_id, email FROM appointment_guests WHERE appointment_id IN (${ids.map(() => '?').join(',')}) ORDER BY email`, ...ids))
        byAppt.set(g.appointment_id, [...(byAppt.get(g.appointment_id) ?? []), g.email]);
      return byAppt.size ? out.map((r) => (byAppt.has(r.id) ? { ...r, guests: byAppt.get(r.id) } : r)) : out;
    };

    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (email) db.run('DELETE FROM appointment_guests WHERE location_id = ? AND email = ?', loc, email);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (!email) return {};
        const rows = db.all('SELECT g.email, g.invited_at, a.start_at, a.title FROM appointment_guests g JOIN appointments a ON a.id = g.appointment_id WHERE g.location_id = ? AND g.email = ?', loc, email);
        return rows.length ? { 'appointment_guests (E-Mail)': rows } : {};
      },
    ];
  },
};
