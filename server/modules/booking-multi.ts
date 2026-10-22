import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { getCalendarBySlug, type CalendarRow } from './calendars.js';
import { getConfig } from '../services/teamcal-engine.js';
import { bookTeam, cancelAppointment } from '../services/teamcal-book.js';
import { durationChoices, multiAllowed } from '../services/teamcal-model.js';

/**
 * Several appointments in one booking (HighLevel parity, docs/team-calendars.md#several-appointments-at-once): a calendar with
 * `multi_max` lets the visitor pick up to that many times on the booking page and book them with one form. Each time is booked
 * through the normal team-calendar pipeline (questions, consent, hosts, video, confirmations, workflows); when one of them is no
 * longer free, the ones already booked in this request are cancelled again, so the visitor gets all or none. Unpaid calendars only.
 */

const stamp = new Map<string, number[]>();
function throttled(ip: string, max = 10, windowMs = 10 * 60_000): boolean {
  const t = Date.now();
  const list = (stamp.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  stamp.set(ip, list);
  if (stamp.size > 20_000) stamp.clear();
  return list.length > max;
}

export const bookingMultiModule: Module = {
  name: 'booking-multi',
  register(app: App) {
    app.router.post('/api/public/team-calendars/:slug/book-many', 'public', async (ctx) => {
      const b = ctx.body ?? {};
      if (String(b.website ?? '').trim()) throw bad('Das hat nicht geklappt – bitte noch einmal versuchen');
      if (throttled(ctx.ip)) throw new HttpError(429, 'Zu viele Buchungsversuche – bitte in ein paar Minuten noch einmal');
      const base = getCalendarBySlug(app, ctx.params.slug);
      if (!base) throw notFound();
      const cfg = getConfig(app, base.id);
      const max = multiAllowed(cfg);
      if (max < 2) throw bad('Bei diesem Termin geht nur eine Zeit pro Buchung');
      let cal: CalendarRow = base;
      if (b.duration !== undefined && b.duration !== null && b.duration !== '') {
        const n = Math.round(Number(b.duration));
        if (!durationChoices(base.duration, cfg).includes(n)) throw bad('Diese Dauer gibt es bei diesem Termin nicht');
        cal = { ...base, duration: n };
      }
      const starts = (Array.isArray(b.starts) ? b.starts : []).map((s: unknown) => new Date(String(s)));
      if (starts.some((d: Date) => Number.isNaN(d.getTime()))) throw bad('Ungültige Startzeit');
      const sorted = [...new Set<number>(starts.map((d: Date) => d.getTime()))].sort((x, y) => x - y);
      if (sorted.length < 2) throw bad('Bitte mindestens zwei verschiedene Zeiten wählen');
      if (sorted.length > max) throw bad(`Höchstens ${max} Termine auf einmal`);
      for (let i = 1; i < sorted.length; i++) if (sorted[i] < sorted[i - 1] + cal.duration * 60_000) throw bad('Die gewählten Zeiten überschneiden sich');
      const booked: any[] = [];
      try {
        for (const t of sorted) {
          const r = await bookTeam(app, cal, { start: new Date(t).toISOString(), first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, notes: b.notes, answers: b.answers, consent: b.consent === true, guests: b.guests, meta: { multi: String(sorted.length) } }, {});
          if (r.status !== 'confirmed') throw bad('Diese Zeiten lassen sich nicht zusammen buchen');
          booked.push(r);
        }
      } catch (e) {
        for (const r of booked) {
          try {
            await cancelAppointment(app, r.appointment, { by: 'system', reason: 'Mehrfachbuchung nicht vollständig – eine der Zeiten war nicht mehr frei' });
          } catch (err) {
            console.error('[booking-multi] rollback', (err as Error).message);
          }
        }
        if (e instanceof HttpError && e.status === 409) throw new HttpError(409, `${e.message} (${booked.length + 1}. Zeit) – bitte die Zeiten neu wählen`);
        throw e;
      }
      return {
        status: 'confirmed',
        appointments: booked.map((r) => ({ id: r.appointment.id, start_at: r.appointment.start_at, manageUrl: r.manage_url, icsUrl: r.ics_url, meetingUrl: r.meeting_url, hosts: r.hosts.map((h: any) => h.name) })),
      };
    });
  },
};
