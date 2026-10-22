import type { Ctx } from '../core/http.js';
import { HttpError, bad, html, notFound, num } from '../core/http.js';
import type { Module } from '../core/app.js';
import { messagePage } from '../core/page.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { busyFor, computeSlots, getCalendarBySlug, type CalendarRow } from './calendars.js';
import { getConfig, hasConfig, hostNames, parseJsonSafe, slotsOfDay } from '../services/teamcal-engine.js';
import { durationChoices, needsTeamPage } from '../services/teamcal-model.js';
import { bookFromWaitlist, bookTeam, calendarById, cancelAppointment, completeHold, rescheduleAppointment, type BookResult } from '../services/teamcal-book.js';
import { bookingPage, managePage, paidPage, routingPage, waitlistPage } from '../services/teamcal-pages.js';
import { fetchSession, holdBy } from '../services/teamcal-pay.js';

/**
 * The public side of the Team-Kalender: the booking page of a team calendar (server-rendered, questions, price, policy), its slots and
 * booking API, the return page after paying, the page of a booked appointment (reschedule, cancel), routing forms and the offer of a
 * freed seat. Plain calendars keep their own page and API; a calendar uses these when it has team settings that need them.
 */

const stamp = new Map<string, number[]>();
/** At most `max` booking attempts per address and ten minutes (each one can start a payment). */
function throttled(ip: string, max = 15, windowMs = 10 * 60_000): boolean {
  const t = Date.now();
  const list = (stamp.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  stamp.set(ip, list);
  if (stamp.size > 20_000) stamp.clear();
  return list.length > max;
}
const verifyStamp = new Map<string, number>();
/** For tests: forget the booking attempts counted so far. */
export const resetThrottle = () => stamp.clear();

export const teamCalPublicModule: Module = {
  name: 'teamcal-public',
  register(app) {
    const { db, router } = app;
    const base = (s: string) => `${app.baseUrl()}${s}`;

    // --- the booking page -------------------------------------------------------------------------------------------
    app.services.teamcalPage = (cal: CalendarRow, embed: boolean) => {
      if (!hasConfig(app, cal.id)) return undefined;
      const cfg = getConfig(app, cal.id);
      return needsTeamPage(cfg) ? bookingPage(app, cal, cfg, { embed }) : undefined;
    };

    const activeCal = (slug: string): CalendarRow => {
      const cal = getCalendarBySlug(app, slug);
      if (!cal) throw notFound();
      return cal;
    };

    /** A calendar with several meeting lengths: the row with the length the visitor chose (one of the offered ones). */
    const withDuration = (cal: CalendarRow, raw: unknown): CalendarRow => {
      if (raw === undefined || raw === null || raw === '') return cal;
      const n = Math.round(Number(raw));
      if (n === cal.duration) return cal;
      if (!durationChoices(cal.duration, getConfig(app, cal.id)).includes(n)) throw bad('Diese Dauer gibt es bei diesem Termin nicht');
      return { ...cal, duration: n };
    };
    router.get('/api/public/team-calendars/:slug/slots', 'public', (ctx) => {
      const cal = withDuration(activeCal(ctx.params.slug), ctx.query.get('duration'));
      return slotsPayload(cal, ctx.query.get('from'), num(ctx.query.get('days'), 7));
    });

    function slotsPayload(cal: CalendarRow, fromParam: string | null, daysParam: number, except?: string) {
      const cfg = getConfig(app, cal.id);
      const today = ymdInTz(new Date(), cal.timezone);
      let from = /^\d{4}-\d\d-\d\d$/.test(fromParam ?? '') ? fromParam! : today;
      if (from < today) from = today;
      const days = Math.min(Math.max(daysParam, 1), 31);
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = addDaysYmd(from, i);
        const day = slotsOfDay(app, cal, cfg, d, new Date(), except);
        if (day) out.push({ date: d, slots: day.slots.map((s) => s.start), full: day.full, left: day.left });
        else {
          let busy = busyFor(app, cal, d);
          if (except) {
            const a = db.get<{ start_at: string; end_at: string }>('SELECT start_at, end_at FROM appointments WHERE id = ?', except);
            if (a) busy = busy.filter((b) => !(b.start_at === a.start_at && b.end_at === a.end_at));
          }
          out.push({ date: d, slots: computeSlots(cal, d, busy), full: [], left: {} });
        }
      }
      return { timezone: cal.timezone, duration: cal.duration, kind: cfg.kind, days: out };
    }

    // --- booking ----------------------------------------------------------------------------------------------------
    const publicResult = (r: BookResult) => {
      if (r.status === 'confirmed') return { status: 'confirmed', id: r.appointment.id, start_at: r.appointment.start_at, manageUrl: r.manage_url, icsUrl: r.ics_url, meetingUrl: r.meeting_url, hosts: r.hosts.map((h) => h.name) };
      if (r.status === 'payment_required') return { status: r.status, checkout_url: r.checkout_url, hold_token: r.hold_token, expires_at: r.expires_at, due_cents: r.due_cents, currency: r.currency };
      return r;
    };

    router.post('/api/public/team-calendars/:slug/book', 'public', async (ctx) => {
      const b = ctx.body ?? {};
      const cal = withDuration(activeCal(ctx.params.slug), b.duration);
      if (String(b.website ?? '').trim()) throw bad('Das hat nicht geklappt – bitte noch einmal versuchen');
      if (throttled(ctx.ip)) throw new HttpError(429, 'Zu viele Buchungsversuche – bitte in ein paar Minuten noch einmal');
      const meta: Record<string, string> = {};
      if (typeof b._ab === 'string' && /^[A-Za-z0-9]{8,40}$/.test(b._ab)) meta.ab = b._ab;
      for (const k of ['_attr', '_page', '_utm_source', '_utm_medium', '_utm_campaign', '_utm_term', '_utm_content', '_gclid', '_fbclid', '_ref']) if (typeof b[k] === 'string' && b[k]) meta[k] = b[k].slice(0, 400);
      const r = await bookTeam(app, cal, { start: String(b.start ?? ''), first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, notes: b.notes, answers: b.answers, consent: b.consent === true, meta, via: typeof b.via === 'string' ? b.via : undefined, waitlist: b.waitlist === true, guests: b.guests }, {});
      if (r.status === 'confirmed') app.services.attribution?.capture(ctx, cal.location_id, r.appointment.contact_id, 'booking', { attr: meta._attr, page: meta._page, params: meta });
      return publicResult(r);
    });

    // --- paying -----------------------------------------------------------------------------------------------------
    router.get('/book/paid/:token', 'public', (ctx) => {
      const hold = holdBy(app, 'token', ctx.params.token);
      if (!hold) return html(messagePage('Nicht gefunden', 'Diese Buchung gibt es nicht (mehr).'), 404);
      const cal = calendarById(app, hold.calendar_id);
      if (!cal) return html(messagePage('Nicht gefunden', 'Diesen Kalender gibt es nicht mehr.'), 404);
      const sid = String(ctx.query.get('session_id') ?? '');
      return html(paidPage(app, hold, cal, ctx.query.get('cancelled') === '1', /^cs_[A-Za-z0-9_]+$/.test(sid) ? sid : ''));
    });

    router.get('/api/public/team-calendars/hold/:token', 'public', async (ctx) => {
      let hold = holdBy(app, 'token', ctx.params.token);
      if (!hold) throw notFound();
      const cal = calendarById(app, hold.calendar_id);
      if (!cal) throw notFound();
      const sid = String(ctx.query.get('session_id') ?? '');
      // Back from Stripe before the webhook: ask Stripe once in a while whether the session was paid.
      if (hold.status === 'pending' && sid && sid === hold.session_id && Date.now() - (verifyStamp.get(hold.id) ?? 0) > 4000) {
        verifyStamp.set(hold.id, Date.now());
        if (verifyStamp.size > 5000) verifyStamp.clear();
        const s = await fetchSession(app, hold.location_id, sid);
        if (s && s.metadata?.teamcal_hold === hold.id && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')) {
          await completeHold(app, hold.id, s);
          hold = holdBy(app, 'id', hold.id)!;
        }
      }
      const appt = hold.appointment_id ? db.get<any>('SELECT manage_token, meeting_url FROM appointments WHERE id = ?', hold.appointment_id) : undefined;
      if (hold.status === 'paid' && appt) return { status: 'confirmed', slug: cal.slug, manageUrl: base(`/book/manage/${appt.manage_token}`), icsUrl: `/book/ics/${appt.manage_token}`, meetingUrl: appt.meeting_url || '' };
      return { status: hold.status === 'paid' ? 'pending' : hold.status, slug: cal.slug, checkoutUrl: hold.status === 'pending' && hold.session_url ? hold.session_url : '', expiresAt: hold.expires_at };
    });

    // --- the page of a booked appointment ------------------------------------------------------------------------------
    const apptOf = (tokenValue: string) => {
      const a = db.get<any>('SELECT * FROM appointments WHERE manage_token = ?', tokenValue);
      if (!a) throw notFound();
      const cal = calendarById(app, a.calendar_id);
      if (!cal) throw notFound();
      return { a, cal };
    };
    app.services.teamcalManagePage = (a: any, cal: CalendarRow) => {
      if (!hasConfig(app, cal.id)) return undefined;
      const hostIds = parseJsonSafe<string[]>(a.host_ids, []);
      const hosts = hostNames(app, hostIds.length ? hostIds : a.assignee_id ? [a.assignee_id] : []).map((h) => h.name);
      return managePage(app, a, cal, getConfig(app, cal.id), hosts);
    };

    router.get('/api/public/team-calendars/manage/:token/slots', 'public', (ctx) => {
      const { a, cal } = apptOf(ctx.params.token);
      // A booking with one of several lengths is moved with its own length.
      const own = Math.round((Date.parse(a.end_at) - Date.parse(a.start_at)) / 60_000);
      const sized = own !== cal.duration && durationChoices(cal.duration, getConfig(app, cal.id)).includes(own) ? { ...cal, duration: own } : cal;
      return slotsPayload(sized, ctx.query.get('from'), num(ctx.query.get('days'), 7), a.id);
    });
    router.post('/api/public/team-calendars/manage/:token/cancel', 'public', async (ctx) => {
      const { a } = apptOf(ctx.params.token);
      return cancelAppointment(app, a, { by: 'customer', reason: String(ctx.body?.reason ?? '') });
    });
    router.post('/api/public/team-calendars/manage/:token/reschedule', 'public', async (ctx) => {
      const { a } = apptOf(ctx.params.token);
      if (throttled(ctx.ip, 30)) throw new HttpError(429, 'Zu viele Versuche – bitte in ein paar Minuten noch einmal');
      const next = await rescheduleAppointment(app, a, String(ctx.body?.start ?? ''), { by: 'customer' });
      return { ok: true, start_at: next.start_at };
    });

    // --- routing forms ------------------------------------------------------------------------------------------------
    router.get('/book/r/:slug', 'public', (ctx) => {
      const r = db.get<any>('SELECT * FROM teamcal_routes WHERE slug = ? AND active = 1', ctx.params.slug);
      if (!r) return html(messagePage('Nicht gefunden', 'Dieses Formular gibt es nicht (mehr).'), 404);
      const options = parseJsonSafe<{ id: string; label: string; calendar_id: string }[]>(r.options, []);
      const slugs: Record<string, string> = {};
      for (const o of options) {
        const c = db.get<{ slug: string }>('SELECT slug FROM calendars WHERE id = ? AND location_id = ? AND active = 1', o.calendar_id, r.location_id);
        if (c) slugs[o.calendar_id] = c.slug;
      }
      return html(routingPage({ ...r, options: options.filter((o) => slugs[o.calendar_id]) }, slugs, ctx.query.get('embed') === '1'));
    });

    // --- waiting list ------------------------------------------------------------------------------------------------
    router.get('/book/waitlist/:token', 'public', (ctx) => {
      const w = db.get<any>('SELECT * FROM teamcal_waitlist WHERE token = ?', ctx.params.token);
      if (!w) return html(messagePage('Nicht gefunden', 'Dieses Angebot gibt es nicht.'), 404);
      const cal = calendarById(app, w.calendar_id);
      if (!cal) return html(messagePage('Nicht gefunden', 'Diesen Kalender gibt es nicht mehr.'), 404);
      const state = w.status === 'booked' ? 'booked' : w.status === 'offered' && (!w.offer_expires_at || w.offer_expires_at > new Date().toISOString()) ? 'offer' : 'expired';
      return html(waitlistPage(app, w, cal, state));
    });
    router.post('/api/public/team-calendars/waitlist/:token/book', 'public', async (ctx: Ctx) => {
      if (throttled(ctx.ip, 20)) throw new HttpError(429, 'Zu viele Versuche – bitte in ein paar Minuten noch einmal');
      const r = await bookFromWaitlist(app, ctx.params.token);
      if ('error' in r) throw new HttpError(409, r.error);
      if ('checkout_url' in r) return { ok: true, checkout_url: r.checkout_url };
      return { ok: true, manageUrl: base(`/book/manage/${r.appointment.manage_token}`) };
    });
  },
};
