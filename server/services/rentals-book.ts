import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { centsToMoney, id, normalizeEmail, now, token } from '../core/util.js';
import { beginBooking, type CalendarRow } from '../modules/calendars.js';
import { createInvoice, markInvoicePaid } from '../modules/payments.js';
import { getContact } from './contacts.js';
import { notifyTeam } from './messaging.js';
import { track } from './collab-actor.js';
import { freeOver, freePerDay, priceOf, rangeOf, rangeText, stayTimes, unitsProblem, type Price, type Range, type RentalRules, type Taken, type Unit } from './rentals-model.js';
import { itemsForGross } from './teamcal-model.js';

/**
 * Vermietung – booking with the database (docs/booking.md#rentals): availability = quantity minus the overlapping bookings (confirmed
 * ones whose appointment is not cancelled, unpaid ones still held, and blocked times of the item's calendar), checked and written in
 * one transaction so two bookings can never take the same last unit. Free bookings become an appointment at once (confirmation e-mail,
 * reminders, workflows of the calendar); paid ones are held while the customer pays on the pay page of the payment registry
 * (Stripe, PayPal, Mollie, gift card), and the payment turns them into the appointment plus an invoice marked paid.
 */

export interface RentalRow extends RentalRules {
  id: string;
  location_id: string;
  calendar_id: string;
  currency: string;
  hold_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface BookingRow {
  id: string;
  location_id: string;
  rental_id: string;
  appointment_id: string | null;
  contact_id: string | null;
  token: string;
  from_date: string;
  to_date: string;
  units: number;
  qty: number;
  rent_cents: number;
  deposit_cents: number;
  total_cents: number;
  currency: string;
  status: 'pending' | 'confirmed' | 'expired' | 'refunded' | 'cancelled';
  contact: string;
  notes: string;
  source: string;
  pay_session_id: string | null;
  invoice_id: string | null;
  expires_at: string | null;
  created_at: string;
  paid_at: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const calOfRental = (app: App, r: Pick<RentalRow, 'calendar_id'>): CalendarRow | undefined => {
  const row = app.db.get<any>('SELECT * FROM calendars WHERE id = ?', r.calendar_id);
  return row ? { ...row, availability: JSON.parse(row.availability || '{}'), settings: JSON.parse(row.settings || '{}') } : undefined;
};
export const rentalOfCalendar = (app: App, calendarId: string) => app.db.get<RentalRow>('SELECT * FROM rentals WHERE calendar_id = ?', calendarId);
export const bookingOfAppointment = (app: App, appointmentId: string) => app.db.get<BookingRow>('SELECT * FROM rental_bookings WHERE appointment_id = ?', appointmentId);

/** What takes units between `from` and `to` (exclusive): bookings that still count, and blocked times of the calendar (all units). */
export function takenIn(app: App, r: RentalRow, cal: CalendarRow, from: string, to: string, except = ''): Taken[] {
  const rows = app.db.all<Taken>(
    `SELECT b.from_date, b.to_date, b.qty FROM rental_bookings b LEFT JOIN appointments a ON a.id = b.appointment_id
     WHERE b.rental_id = ? AND b.from_date < ? AND b.to_date > ? AND b.id != ?
       AND ((b.status = 'pending' AND b.expires_at > ?) OR (b.status = 'confirmed' AND a.id IS NOT NULL AND a.status != 'cancelled'))`,
    r.id, to, from, except, now(),
  );
  // Blocked times (maintenance, own use) drawn in the calendar view: every day they touch is closed.
  const start = new Date(Date.parse(`${from}T00:00:00Z`) - 2 * 864e5).toISOString();
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 864e5).toISOString();
  for (const b of app.db.all<{ start_at: string; end_at: string }>(`SELECT start_at, end_at FROM appointments WHERE calendar_id = ? AND status = 'blocked' AND end_at > ? AND start_at < ?`, cal.id, start, end)) {
    const last = ymdInTz(new Date(Date.parse(b.end_at) - 1), cal.timezone);
    rows.push({ from_date: ymdInTz(new Date(b.start_at), cal.timezone), to_date: addDaysYmd(last, 1), qty: r.quantity });
  }
  return rows;
}

/** The first and last day that may be booked (today in the calendar's zone … the booking horizon). */
export function bookableWindow(cal: CalendarRow, at = new Date()) {
  const today = ymdInTz(at, cal.timezone);
  return { today, last: addDaysYmd(today, Math.max(1, cal.max_days || 365)) };
}

export function availability(app: App, r: RentalRow, cal: CalendarRow, from: string, days: number) {
  const w = bookableWindow(cal);
  const start = from < w.today ? w.today : from;
  const list = freePerDay(r.quantity, takenIn(app, r, cal, start, addDaysYmd(start, days)), start, days).map((d) => (d.date > w.last ? { ...d, free: 0 } : d));
  return { timezone: cal.timezone, unit: r.unit, quantity: r.quantity, today: w.today, last_day: w.last, days: list };
}

export interface Quote extends Price {
  ok: boolean;
  from: string;
  to: string;
  /** Last day of a day rental / check-out day of a stay. */
  until: string;
  free: number;
  text: string;
  currency: string;
  start_at: string;
  end_at: string;
  problem?: string;
}

/** Range, length rules, horizon, free units and price of a request – without writing anything. */
export function quote(app: App, r: RentalRow, cal: CalendarRow, input: { from?: unknown; to?: unknown; days?: unknown; qty?: unknown }, except = ''): Quote {
  let range: Range;
  try {
    range = rangeOf(r.unit, input);
  } catch (e) {
    throw bad((e as Error).message);
  }
  const qty = input.qty === undefined || input.qty === '' ? 1 : Number(input.qty);
  if (!Number.isInteger(qty) || qty < 1) throw bad('Ungültige Anzahl');
  const w = bookableWindow(cal);
  const free = freeOver(r.quantity, takenIn(app, r, cal, range.from, range.to, except), range.from, range.to);
  let problem = unitsProblem(r, range.units);
  if (!problem && range.from < w.today) problem = 'Dieser Zeitraum liegt in der Vergangenheit';
  if (!problem && range.from > w.last) problem = 'So weit im Voraus kann man noch nicht buchen';
  if (!problem && qty > r.quantity) problem = `Es gibt nur ${r.quantity} Stück`;
  if (!problem && free < qty) problem = free ? `In diesem Zeitraum ${free === 1 ? 'ist nur noch 1 frei' : `sind nur noch ${free} frei`}` : 'In diesem Zeitraum ist nichts mehr frei';
  const times = stayTimes(r, range, cal.timezone);
  return { ok: !problem, ...(problem ? { problem } : {}), from: range.from, to: range.to, until: r.unit === 'night' ? range.to : addDaysYmd(range.to, -1), free, text: rangeText(r.unit, range), currency: r.currency, ...times, ...priceOf(r, range.units, qty) };
}

export interface RentalForm {
  from?: unknown;
  to?: unknown;
  days?: unknown;
  qty?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  email?: unknown;
  phone?: unknown;
  notes?: unknown;
  consent?: unknown;
  /** Staff: an existing contact. */
  contact_id?: unknown;
}

export interface RentalOpts {
  /** The team books (app, MCP): no consent box, first name optional, an existing contact may be named. */
  staff?: boolean;
  /** Paid items: "require" (default) – the customer pays on the pay page first; "waive" – booked without online payment. */
  payment?: 'require' | 'waive';
  source?: string;
}

export type RentalResult =
  | { status: 'confirmed'; booking: BookingOut; appointment: any; manage_url: string; ics_url: string }
  | { status: 'payment_required'; booking: BookingOut; checkout_url: string; expires_at: string; due_cents: number; currency: string };

export type BookingOut = ReturnType<typeof bookingOut>;
export const bookingOut = (b: BookingRow, r: Pick<RentalRow, 'unit'>) => ({
  id: b.id,
  rental_id: b.rental_id,
  appointment_id: b.appointment_id,
  contact_id: b.contact_id,
  status: b.status,
  from: b.from_date,
  until: r.unit === 'night' ? b.to_date : addDaysYmd(b.to_date, -1),
  to_date: b.to_date,
  units: b.units,
  qty: b.qty,
  text: rangeText(r.unit as Unit, { from: b.from_date, to: b.to_date, units: b.units }),
  rent_cents: b.rent_cents,
  deposit_cents: b.deposit_cents,
  total_cents: b.total_cents,
  currency: b.currency,
  source: b.source,
  invoice_id: b.invoice_id,
  expires_at: b.expires_at,
  created_at: b.created_at,
  paid_at: b.paid_at,
});

function cleanContact(app: App, locationId: string, f: RentalForm, o: RentalOpts) {
  if (o.staff && f.contact_id) {
    const c = getContact(app, locationId, String(f.contact_id));
    if (!c) throw bad('Kontakt nicht gefunden');
    if (!c.email) throw bad('Der Kontakt hat keine E-Mail-Adresse');
    return { id: c.id, first_name: c.first_name ?? '', last_name: c.last_name ?? '', email: c.email, phone: c.phone ?? '' };
  }
  const email = normalizeEmail(f.email);
  if (!email || !EMAIL.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
  const first = String(f.first_name ?? '').trim().slice(0, 100);
  if (!first && !o.staff) throw bad('Bitte den Vornamen angeben');
  if (!o.staff && f.consent !== true) throw bad('Bitte der Speicherung deiner Angaben zustimmen');
  return { first_name: first, last_name: String(f.last_name ?? '').trim().slice(0, 100), email, phone: String(f.phone ?? '').trim().slice(0, 40) };
}

const getBooking = (app: App, bid: string) => app.db.get<BookingRow>('SELECT * FROM rental_bookings WHERE id = ?', bid);

/** Writes the appointment of a booking (inside the caller's transaction); `finish()` sends the confirmation and fires appointment.booked. */
function writeAppointment(app: App, r: RentalRow, cal: CalendarRow, b: Pick<BookingRow, 'id' | 'from_date' | 'to_date' | 'units' | 'qty' | 'notes' | 'source'>, contact: Record<string, any>, publicInput: boolean) {
  const times = stayTimes(r, { from: b.from_date, to: b.to_date }, cal.timezone);
  const who = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || '';
  const begun = beginBooking(app, cal, {
    start: times.start_at,
    contact,
    notes: b.notes,
    source: b.source,
    publicInput,
    skipCheck: true,
    meta: { rental: r.id, rental_booking: b.id },
    extra: { end_at: times.end_at, title: `${cal.name}${b.qty > 1 ? ` ×${b.qty}` : ''} – ${who}`.slice(0, 300) },
  });
  return begun;
}

/** The one entry for booking an item: checks, holds for payment when needed, otherwise confirms right away. */
export function bookRental(app: App, r: RentalRow, cal: CalendarRow, f: RentalForm, o: RentalOpts = {}): RentalResult {
  if (!cal.active) throw new HttpError(409, 'Dieses Angebot ist gerade nicht buchbar');
  const contact = cleanContact(app, r.location_id, f, o);
  const notes = String(f.notes ?? '').trim().slice(0, 3000);
  const source = o.source ?? (o.staff ? 'manuell' : 'Buchungsseite');
  const registry = app.services.payRegistry;
  // Checked and written in one transaction: two requests for the last unit cannot both pass.
  const out = app.db.tx(() => {
    const q = quote(app, r, cal, f);
    if (!q.ok) throw new HttpError(409, q.problem!);
    const needsPay = q.total_cents > 0 && o.payment !== 'waive';
    if (needsPay) {
      if (!registry || !registry.ready(r.location_id).length) throw new HttpError(409, 'Die Online-Zahlung ist noch nicht eingerichtet (Einstellungen → Stripe & Zahlungen)');
      if (q.total_cents < 50) throw new HttpError(409, 'Der Betrag ist zu klein für eine Online-Zahlung');
    }
    const row: BookingRow = {
      id: id(),
      location_id: r.location_id,
      rental_id: r.id,
      appointment_id: null,
      contact_id: (contact as any).id ?? null,
      token: token(18),
      from_date: q.from,
      to_date: q.to,
      units: q.units,
      qty: q.qty,
      rent_cents: q.rent_cents,
      deposit_cents: q.deposit_cents,
      total_cents: q.total_cents,
      currency: r.currency,
      status: needsPay ? 'pending' : 'confirmed',
      contact: JSON.stringify(contact),
      notes,
      source,
      pay_session_id: null,
      invoice_id: null,
      expires_at: needsPay ? new Date(Date.now() + r.hold_minutes * 60_000).toISOString() : null,
      created_at: now(),
      paid_at: null,
    };
    app.db.insert('rental_bookings', row);
    if (needsPay) return { row, begun: undefined };
    const begun = writeAppointment(app, r, cal, row, contact, !o.staff);
    app.db.run(`UPDATE rental_bookings SET appointment_id = ?, contact_id = ?, contact = '{}' WHERE id = ?`, begun.appt.id, begun.appt.contact_id, row.id);
    return { row, begun };
  });
  if (out.begun) {
    const appt = out.begun.finish();
    return { status: 'confirmed', booking: bookingOut(getBooking(app, out.row.id)!, r), appointment: appt, manage_url: `${app.baseUrl()}/book/manage/${appt.manage_token}`, ics_url: `/book/ics/${appt.manage_token}` };
  }
  // Paid first: the pay page of the registry (Stripe, PayPal, Mollie, gift card – whatever the sub-account has set up).
  const b = out.row;
  const label = `${cal.name}${b.qty > 1 ? ` ×${b.qty}` : ''}`;
  const lines = [{ name: label.slice(0, 250), qty: 1, unit_cents: b.rent_cents }, ...(b.deposit_cents ? [{ name: 'Kaution', qty: 1, unit_cents: b.deposit_cents }] : [])].filter((l) => l.unit_cents > 0);
  try {
    const s = registry.start({
      locationId: r.location_id,
      purpose: 'rental',
      refId: b.id,
      amountCents: b.total_cents,
      currency: b.currency,
      description: `${label} · ${rangeText(r.unit, { from: b.from_date, to: b.to_date, units: b.units })}`.slice(0, 200),
      email: contact.email,
      name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
      lines,
      returnUrl: `${app.baseUrl()}/book/r/paid/${b.token}`,
      cancelUrl: `${app.baseUrl()}/book/r/paid/${b.token}?cancelled=1`,
    });
    app.db.run('UPDATE rental_bookings SET pay_session_id = ? WHERE id = ?', s.id, b.id);
    return { status: 'payment_required', booking: bookingOut(getBooking(app, b.id)!, r), checkout_url: registry.pageUrl(s), expires_at: b.expires_at!, due_cents: b.total_cents, currency: b.currency };
  } catch (e) {
    app.db.run(`UPDATE rental_bookings SET status = 'cancelled' WHERE id = ?`, b.id);
    throw e;
  }
}

/**
 * The money of a held booking arrived (pay registry purpose "rental"). A payment after the hold ran out is honoured when the units
 * are still free, otherwise it goes back and the team hears about it.
 */
export async function settleRental(app: App, bookingId: string): Promise<BookingRow | undefined> {
  const b0 = getBooking(app, bookingId);
  if (!b0 || b0.status === 'confirmed' || b0.status === 'refunded') return b0;
  const r = app.db.get<RentalRow>('SELECT * FROM rentals WHERE id = ?', b0.rental_id);
  const cal = r && calOfRental(app, r);
  if (!r || !cal) return b0;
  const res = app.db.tx(() => {
    const b = getBooking(app, bookingId)!;
    if (b.status === 'confirmed' || b.status === 'refunded') return { b };
    const free = freeOver(r.quantity, takenIn(app, r, cal, b.from_date, b.to_date, b.id), b.from_date, b.to_date);
    if (free < b.qty) {
      app.db.run(`UPDATE rental_bookings SET status = 'refunded' WHERE id = ?`, b.id);
      return { b, refund: true };
    }
    const contact = JSON.parse(b.contact || '{}');
    const begun = writeAppointment(app, r, cal, b, contact, b.source !== 'manuell');
    const invoice = paidInvoice(app, r, cal, b, begun.appt.contact_id);
    app.db.run(`UPDATE rental_bookings SET status = 'confirmed', appointment_id = ?, contact_id = ?, invoice_id = ?, paid_at = ?, contact = '{}' WHERE id = ?`, begun.appt.id, begun.appt.contact_id, invoice?.id ?? null, now(), b.id);
    return { b, begun };
  });
  if (res.refund) {
    if (b0.pay_session_id) await app.services.payRegistry?.refundAll(b0.pay_session_id).catch((e: Error) => console.error('[rentals] refund', e.message));
    const c = JSON.parse(b0.contact || '{}');
    track(app, notifyTeam(app, r.location_id, `Zahlung ohne freien Zeitraum erstattet: ${cal.name}`, `${c.email ?? ''} hat nach Ablauf der Reservierung bezahlt, ${rangeText(r.unit, { from: b0.from_date, to: b0.to_date, units: b0.units })} war inzwischen vergeben. Die Zahlung wurde erstattet – bitte bei der Zahlungsart prüfen.`).then(() => undefined));
  }
  res.begun?.finish();
  return getBooking(app, bookingId);
}

/** The invoice of a paid booking: the rent (with the item's tax rate) and the deposit (no tax – it is paid back). */
function paidInvoice(app: App, r: RentalRow, cal: CalendarRow, b: BookingRow, contactId: string) {
  try {
    const s = app.location(r.location_id)?.settings.invoices ?? {};
    const rate = s.small_business ? 0 : Number(s.tax_rate ?? 19);
    const when = rangeText(r.unit, { from: b.from_date, to: b.to_date, units: b.units });
    const items = [
      ...(b.rent_cents > 0 ? itemsForGross({ name: `${cal.name}${b.qty > 1 ? ` ×${b.qty}` : ''}`, description: when }, b.rent_cents, rate) : []),
      ...(b.deposit_cents > 0 ? [{ name: 'Kaution', description: 'Wird nach der Rückgabe erstattet', qty: 1, price_cents: b.deposit_cents, tax_rate: 0 }] : []),
    ];
    const inv = createInvoice(app, r.location_id, { kind: 'invoice', contact_id: contactId, title: `Vermietung: ${cal.name}`, items, currency: b.currency, notes: `Online bezahlt.${b.deposit_cents ? ` Darin enthalten: Kaution ${centsToMoney(b.deposit_cents, b.currency)}.` : ''}` });
    markInvoicePaid(app, r.location_id, inv.id, 'Online (Vermietung)');
    return inv;
  } catch (e) {
    // The booking stands even if the books refuse the invoice (e.g. a missing invoice setting); the team sees the payment in the pay session.
    console.error('[rentals] invoice', (e as Error).message);
    return undefined;
  }
}

/** Holds whose time ran out: released, their pay session closed (a late payment is still handled by settleRental). */
export function expireHolds(app: App) {
  const due = app.db.all<BookingRow>(`SELECT * FROM rental_bookings WHERE status = 'pending' AND expires_at <= ? LIMIT 100`, now());
  for (const b of due) {
    if (!app.db.run(`UPDATE rental_bookings SET status = 'expired' WHERE id = ? AND status = 'pending'`, b.id).changes) continue;
    if (b.pay_session_id) app.services.payRegistry?.lapse(b.pay_session_id, 'expired');
  }
  return due.length;
}
