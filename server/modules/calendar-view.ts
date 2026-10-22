import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { now } from '../core/util.js';
import { type CalendarRow } from './calendars.js';
import { links } from '../services/ai-booking.js';
import { getSeries, seriesOut } from '../services/appt-series.js';
import { calendarsOf, checkTime, membersByCalendar, peopleOfAppt, viewData, type Issue } from '../services/calview.js';
import { getContact } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';
import { callRoute } from '../services/route-call.js';
import { cancelAppointment, rescheduleAppointment } from '../services/teamcal-book.js';
import { moveVideo } from '../services/teamcal-video.js';
import { peopleOf } from '../services/team-people.js';

/**
 * Calendar view (docs/booking.md#calendar-view): the data behind the day, week, month, team and agenda grids of the Kalender page,
 * the conflict check for drag & drop and for booking from an empty slot, moving and resizing (through the calendar's reschedule
 * logic), the appointment drawer (contact, notes, status, payment, series) and an invoice draft for an appointment.
 */

const ISSUE_TEXT: Record<Issue['kind'], string> = {
  appointment: 'überschneidet sich mit einem anderen Termin',
  blocked: 'liegt in einer blockierten Zeit',
  buffer: 'verletzt den Puffer zu einem anderen Termin',
  person: 'die Person hat zu der Zeit einen anderen Termin',
  busy: 'ist im verbundenen Kalender (Google/Outlook/iCal) belegt',
  hours: 'liegt außerhalb der Buchungszeiten',
  limit: 'das Tages- oder Wochenlimit ist erreicht',
  absence: 'die Person ist abwesend',
};
export const issueMessage = (issues: Issue[]) => `Die Zeit ${[...new Set(issues.map((i) => ISSUE_TEXT[i.kind]))].join(', ')}`;

/** May this request see another area's data (invoices, tasks)? Admins, unrestricted members and API keys may. */
const mayArea = (ctx: Ctx, area: string) => (ctx.user ? ctx.user.role === 'admin' || ctx.user.permissions === null || ctx.user.permissions.includes(area) : !!ctx.viaApiKey);

const isoOf = (v: unknown, what: string): Date => {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) throw bad(`${what}: ungültige Zeit`);
  return d;
};
const parseList = <T>(v: unknown, fallback: T): T => {
  try {
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const list = (v: string | null, max = 100) =>
  v
    ? v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, max)
    : undefined;

function calOf(app: App, locationId: string, calendarId: unknown): CalendarRow {
  const cal = parseJson(app.db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ? AND location_id = ?', String(calendarId ?? ''), locationId), ['availability', 'settings']);
  if (!cal) throw bad('Kalender fehlt');
  return cal;
}

/** The contact's e-mail when staff moved an appointment by hand (the reschedule logic sends the same one itself). */
async function tellMoved(app: App, a: any, cal: CalendarRow) {
  if (!a.contact_id) return false;
  const r = await sendToContact(app, a.location_id, {
    contactId: a.contact_id,
    channel: 'email',
    subject: `Termin verschoben: ${cal.name}`,
    body: `Hallo,\n\ndein Termin findet jetzt am ${formatInTz(a.start_at, cal.timezone)} (${cal.timezone}) statt.${a.meeting_url ? `\nLink: ${a.meeting_url}` : ''}\n\nTermin verwalten: ${app.baseUrl()}/book/manage/${a.manage_token}`,
    source: 'Terminbestätigung',
    ignoreDnd: true,
  }).catch(() => null);
  return !!r && r.status !== 'failed';
}

export const calendarViewModule: Module = {
  name: 'calendar-view',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE appointment_invoices (
        appointment_id TEXT PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX appointment_invoices_loc ON appointment_invoices(location_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const team = () => !!app.services.teamcalPrepare;
    // The calendar page's own cancel (refund rules, notices, waiting list) for other modules, e.g. a cancelled series appointment.
    app.services.appointmentCancel = (a: any, o: { by: 'staff' | 'customer' | 'system'; reason?: string }) => (team() ? cancelAppointment(app, a, o) : undefined);

    const apptOf = (ctx: Ctx) => {
      const a = db.get<any>('SELECT * FROM appointments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!a) throw notFound('Termin nicht gefunden');
      return a;
    };

    router.get('/api/calendar-view', 'location', (ctx) => {
      const q = ctx.query;
      const from = isoOf(q.get('from') || new Date(Date.now() - 7 * 864e5).toISOString(), 'Von');
      const to = isoOf(q.get('to') || new Date(Date.now() + 7 * 864e5).toISOString(), 'Bis');
      if (to <= from) throw bad('„Bis“ muss nach „Von“ liegen');
      const statuses = list(q.get('status'), 10)?.filter((s) => ['confirmed', 'showed', 'noshow', 'cancelled', 'blocked'].includes(s));
      // Overlays: busy times of connected calendars and absences by default; `layers=` (empty) switches both off.
      const layers = new Set(q.has('layers') ? (list(q.get('layers'), 10) ?? []) : ['busy', 'absences']);
      return viewData(app, ctx.locationId, { from: from.toISOString(), to: to.toISOString(), calendarIds: list(q.get('calendars')), userIds: list(q.get('users')), statuses, layers });
    });

    /** What speaks against a time (drag preview, booking from an empty slot). */
    router.post('/api/calendar-view/check', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const cal = calOf(app, ctx.locationId, b.calendar_id);
      const start = isoOf(b.start, 'Beginn');
      const end = b.end ? isoOf(b.end, 'Ende') : new Date(start.getTime() + cal.duration * 60_000);
      if (end <= start) throw bad('Das Ende muss nach dem Beginn liegen');
      let people: string[] = [];
      let except: string | undefined;
      if (b.appointment_id) {
        const a = db.get<any>('SELECT * FROM appointments WHERE id = ? AND location_id = ?', String(b.appointment_id), ctx.locationId);
        if (!a) throw notFound('Termin nicht gefunden');
        except = a.id;
        people = peopleOfAppt(a, membersByCalendar(app, ctx.locationId));
      } else people = peopleOfAppt({ calendar_id: cal.id }, membersByCalendar(app, ctx.locationId));
      const issues = checkTime(app, cal, start.toISOString(), end.toISOString(), { except, people }).filter((i) => !b.blocked || ['appointment', 'blocked', 'person'].includes(i.kind));
      return { ok: !issues.length, issues, message: issues.length ? issueMessage(issues) : '' };
    });

    /** Booking from an empty slot of the grid: the conflict check first (409 unless `force`), then the calendar's own booking. */
    router.post('/api/calendar-view/book', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const cal = calOf(app, ctx.locationId, b.calendar_id);
      const start = isoOf(b.start, 'Beginn');
      const end = b.end ? isoOf(b.end, 'Ende') : new Date(start.getTime() + cal.duration * 60_000);
      if (end <= start) throw bad('Das Ende muss nach dem Beginn liegen');
      if (end.getTime() - start.getTime() > 24 * 3600_000) throw bad('Höchstens 24 Stunden am Stück');
      const blocked = b.blocked === true;
      const people = peopleOfAppt({ calendar_id: cal.id }, membersByCalendar(app, ctx.locationId));
      const issues = checkTime(app, cal, start.toISOString(), end.toISOString(), { people }).filter((i) => !blocked || ['appointment', 'blocked', 'person'].includes(i.kind));
      if (issues.length && b.force !== true) throw new HttpError(409, issueMessage(issues), { issues });
      // The regular routes do the writing (guards, audit log, undo, events) – this route only adds the check.
      ctx.skipAfterWrite = true;
      if (blocked)
        return callRoute(app, ctx, 'POST', '/api/appointments', { calendar_id: cal.id, blocked: true, title: str(b.title, 'Titel', { max: 300 }), start: start.toISOString(), end: end.toISOString() });
      if (!b.contact_id && !(b.contact && typeof b.contact === 'object')) throw bad('Kontakt fehlt');
      const appt = await callRoute(app, ctx, 'POST', '/api/appointments', {
        calendar_id: cal.id,
        start: start.toISOString(),
        contact_id: b.contact_id || undefined,
        contact: b.contact_id ? undefined : b.contact,
        notes: b.notes,
        force: true,
      });
      if (end.toISOString() !== appt.end_at) return callRoute(app, ctx, 'PATCH', `/api/appointments/${appt.id}`, { end: end.toISOString() });
      return appt;
    });

    /**
     * Drag & drop: move (new start, same length) or resize (new end). A plain move of a confirmed appointment goes through the
     * calendar's reschedule logic (slot rules, hosts, video link, e-mail to the contact); anything else – a resize, a blocked time,
     * a time outside the slot grid – is checked here and written through the regular appointment route. Conflicts answer 409 with
     * the reasons unless `force` (staff decide).
     */
    router.post('/api/calendar-view/appointments/:id/move', 'location', async (ctx) => {
      const a = apptOf(ctx);
      const b = ctx.body ?? {};
      if (a.status === 'cancelled') throw new HttpError(409, 'Abgesagte Termine lassen sich nicht verschieben');
      const cal = calOf(app, ctx.locationId, a.calendar_id);
      const start = b.start ? isoOf(b.start, 'Beginn') : new Date(a.start_at);
      const length = Date.parse(a.end_at) - Date.parse(a.start_at);
      const end = b.end ? isoOf(b.end, 'Ende') : new Date(start.getTime() + length);
      if (end <= start) throw bad('Das Ende muss nach dem Beginn liegen');
      if (end.getTime() - start.getTime() > 24 * 3600_000) throw bad('Höchstens 24 Stunden am Stück');
      if (start.toISOString() === a.start_at && end.toISOString() === a.end_at) return { appointment: a, via: 'unchanged', notified: false, issues: [] };
      const notify = b.notify !== false;
      const force = b.force === true;
      const markException = () => a.series_id && db.run('UPDATE appointments SET series_exception = 1 WHERE id = ?', a.id);
      if (team() && !force && notify && a.status === 'confirmed' && a.contact_id && end.getTime() - start.getTime() === length && length === cal.duration * 60_000) {
        try {
          const next = await rescheduleAppointment(app, a, start.toISOString(), { by: 'staff' });
          markException();
          return { appointment: db.get('SELECT * FROM appointments WHERE id = ?', next.id), via: 'reschedule', notified: true, issues: [] };
        } catch (e) {
          // Not a free slot by the calendar's rules: the detailed check below says why (or finds nothing that is in the way).
          if (!(e instanceof HttpError) || e.status !== 409) throw e;
        }
      }
      const people = peopleOfAppt(a, membersByCalendar(app, ctx.locationId));
      const issues = checkTime(app, cal, start.toISOString(), end.toISOString(), { except: a.id, people }).filter(
        (i) => a.status !== 'blocked' || ['appointment', 'blocked', 'person'].includes(i.kind),
      );
      if (issues.length && !force) throw new HttpError(409, issueMessage(issues), { issues });
      ctx.skipAfterWrite = true;
      const next = await callRoute(app, ctx, 'PATCH', `/api/appointments/${a.id}`, { start: start.toISOString(), end: end.toISOString() });
      markException();
      if (a.video_ref && next.start_at !== a.start_at) void moveVideo(app, next).catch((e) => console.error('[calendar-view] video', (e as Error).message));
      const notified = notify && a.status === 'confirmed' && next.start_at !== a.start_at ? await tellMoved(app, next, cal) : false;
      return { appointment: db.get('SELECT * FROM appointments WHERE id = ?', a.id), via: force && issues.length ? 'override' : 'update', notified, issues };
    });

    /** The drawer: appointment, contact, people, payment, invoice and series. */
    router.get('/api/calendar-view/appointments/:id', 'location', (ctx) => {
      const a = apptOf(ctx);
      const cal = calOf(app, ctx.locationId, a.calendar_id);
      const c = a.contact_id ? getContact(app, ctx.locationId, a.contact_id) : undefined;
      const conv = c ? db.get<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', ctx.locationId, c.id) : undefined;
      const names = new Map(peopleOf(app, ctx.locationId, '').map((u) => [u.id, u.name]));
      const people = peopleOfAppt(a, membersByCalendar(app, ctx.locationId)).map((uid) => ({ id: uid, name: names.get(uid) ?? '' }));
      const payment = parseList<any>(a.payment, null);
      const link = db.get<{ invoice_id: string }>('SELECT invoice_id FROM appointment_invoices WHERE appointment_id = ?', a.id);
      const invoiceId = link?.invoice_id ?? payment?.invoice_id ?? null;
      const invoice =
        invoiceId && mayArea(ctx, 'payments')
          ? (db.get('SELECT id, number, status, total_cents, currency, paid_at FROM invoices WHERE id = ? AND location_id = ?', invoiceId, ctx.locationId) ?? null)
          : null;
      let series = null;
      if (a.series_id) {
        try {
          series = seriesOut(getSeries(app, ctx.locationId, a.series_id));
        } catch {
          series = null;
        }
      }
      return {
        appointment: { ...a, payment, host_ids: undefined, answers: parseList<unknown[]>(a.answers, []) },
        calendar: { id: cal.id, name: cal.name, color: cal.color, timezone: cal.timezone, duration: cal.duration, slug: cal.slug },
        contact: c ? { id: c.id, first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone, tags: c.tags ?? [], dnd: !!c.dnd } : null,
        conversation_id: conv?.id ?? null,
        people,
        payment,
        invoice,
        can_invoice: mayArea(ctx, 'payments') && !!c,
        series,
        links: links(app, a),
      };
    });

    /** "Rechnung anlegen": an invoice draft for the appointment's contact, linked to it (price from a paid team calendar, else 0 to fill in). */
    router.post('/api/calendar-view/appointments/:id/invoice', 'location', async (ctx) => {
      if (!mayArea(ctx, 'payments')) throw new HttpError(403, 'Kein Zugriff auf Rechnungen');
      const a = apptOf(ctx);
      if (!a.contact_id) throw bad('Termin ohne Kontakt – keine Rechnung möglich');
      const have = db.get<{ invoice_id: string }>('SELECT invoice_id FROM appointment_invoices WHERE appointment_id = ?', a.id);
      if (have && db.get('SELECT id FROM invoices WHERE id = ?', have.invoice_id)) throw new HttpError(409, 'Für diesen Termin gibt es schon eine Rechnung', { invoice_id: have.invoice_id });
      const cal = calOf(app, ctx.locationId, a.calendar_id);
      let price = 0;
      try {
        const cfg = db.get<{ data: string }>('SELECT data FROM teamcal_config WHERE calendar_id = ?', cal.id);
        price = Math.max(0, Number(cfg ? JSON.parse(cfg.data)?.payment?.amount_cents : 0) || 0);
      } catch {
        price = 0;
      }
      ctx.skipAfterWrite = true;
      const inv = await callRoute(app, ctx, 'POST', '/api/invoices', {
        contact_id: a.contact_id,
        title: cal.name,
        items: [{ name: cal.name, description: `Termin am ${formatInTz(a.start_at, cal.timezone)}`, qty: 1, price_cents: price }],
      });
      db.run('INSERT OR REPLACE INTO appointment_invoices (appointment_id, location_id, invoice_id, created_at) VALUES (?, ?, ?, ?)', a.id, ctx.locationId, inv.id, now());
      return { invoice_id: inv.id, number: inv.number, status: inv.status, link: `/app/invoices/${inv.id}` };
    });

    // Tenant-scoped lookups other parts may want (the agenda of the mobile web view uses the same data as the grid).
    app.services.calendarView = {
      viewData: (locationId: string, q: Parameters<typeof viewData>[2]) => viewData(app, locationId, q),
      checkTime: (cal: CalendarRow, s: string, e: string, o?: { except?: string; people?: string[] }) => checkTime(app, cal, s, e, o),
      calendars: (locationId: string) => calendarsOf(app, locationId),
    };
  },
};
