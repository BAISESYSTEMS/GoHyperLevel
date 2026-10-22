import type { App } from '../core/app.js';
import { HttpError, bad } from '../core/http.js';
import { formatInTz, ymdInTz } from '../core/time.js';
import { centsToMoney, id, normalizeEmail, now, token } from '../core/util.js';
import { beginBooking, busyFor, computeSlots, type BookInput, type CalendarRow } from '../modules/calendars.js';
import { createInvoice, markInvoicePaid } from '../modules/payments.js';
import { stornoInvoice } from './invoice-flow.js';
import { getContact, logActivity, upsertContact } from './contacts.js';
import { notifyTeam, sendToContact } from './messaging.js';
import { track } from './collab-actor.js';
import { getConfig, hostNames, parseJsonSafe, pickHosts, slotsOfDay, type Picked } from './teamcal-engine.js';
import { answerLines, durationChoices, guestsAllowed, itemsForGross, mayChange, validateAnswers, type Answer, type TeamCalConfig } from './teamcal-model.js';
import { holdBy, refundPayment, startHold, type HoldRow } from './teamcal-pay.js';
import { createVideo, moveVideo, removeVideo, resolvePending } from './teamcal-video.js';

/**
 * Booking on team calendars, in one place for the public page, the team's own booking, MCP and the app: validating the
 * form, choosing the host, paying first when the calendar asks for it, the video link, notices to the hosts, cancelling with
 * the refund rules, rescheduling and the waiting list of a full class.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface BookForm {
  start: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  notes?: string;
  answers?: unknown;
  consent?: boolean;
  meta?: Record<string, string>;
  /** "<routing form slug>:<option id>" – the visitor came through a routing form. */
  via?: string;
  /** Join the waiting list of a full class instead of booking. */
  waitlist?: boolean;
  /** Guests' e-mail addresses (calendars with `guests_max`); they travel in `meta.guests` to appointment.booked (modules/booking-guests.ts). */
  guests?: unknown;
}

export interface BookOpts {
  /** The team books for somebody (MCP, app, calendar page): no consent box, required questions may stay empty. */
  staff?: boolean;
  /** Paid calendars: "require" (default) makes a payment page; "waive" books without payment (the team's decision). */
  payment?: 'require' | 'waive';
  hostId?: string;
  source?: string;
}

export type BookResult =
  | { status: 'confirmed'; appointment: any; manage_url: string; ics_url: string; meeting_url: string; hosts: { id: string; name: string }[] }
  | { status: 'payment_required'; hold_token: string; checkout_url: string; expires_at: string; due_cents: number; currency: string }
  | { status: 'waitlisted'; token: string };

const cleanForm = (cfg: TeamCalConfig, f: BookForm, o: BookOpts) => {
  const email = normalizeEmail(f.email);
  if (!email || !EMAIL.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
  const first = String(f.first_name ?? '').trim().slice(0, 100);
  if (!first && !o.staff) throw bad('Bitte den Vornamen angeben');
  if (!o.staff && f.consent !== true) throw bad('Bitte der Speicherung deiner Angaben zustimmen');
  return {
    contact: { first_name: first, last_name: String(f.last_name ?? '').trim().slice(0, 100), email, phone: String(f.phone ?? '').trim().slice(0, 40) },
    notes: String(f.notes ?? '').trim().slice(0, 3000),
    answers: validateAnswers(cfg.questions, f.answers, { lenient: !!o.staff }),
    guests: cleanGuests(cfg, f.guests, email),
  };
};

/** The guests a visitor added: valid, distinct addresses other than their own, at most the calendar's limit. */
function cleanGuests(cfg: TeamCalConfig, raw: unknown, own: string): string[] {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,;]+/) : []).map((x) => normalizeEmail(x)).filter(Boolean);
  const unique = [...new Set(list)].filter((x) => x !== own);
  if (!unique.length) return [];
  const max = guestsAllowed(cfg);
  if (!max) throw bad('Bei diesem Termin sind keine Gäste vorgesehen');
  if (unique.length > max) throw bad(`Höchstens ${max} ${max === 1 ? 'Gast' : 'Gäste'}`);
  const badOne = unique.find((x) => !EMAIL.test(x));
  if (badOne) throw bad(`Ungültige E-Mail-Adresse bei den Gästen: ${badOne}`);
  return unique;
}

/** The routing answer of a visitor who came through a routing form, as one more answer (the label the form asked, the option chosen). */
function routeAnswer(app: App, locationId: string, via: string | undefined): Answer | undefined {
  const [slug, optId] = String(via ?? '').split(':');
  if (!slug || !optId) return undefined;
  const r = app.db.get<{ question: string; options: string }>('SELECT question, options FROM teamcal_routes WHERE location_id = ? AND slug = ?', locationId, slug);
  const opt = (parseJsonSafe<any[]>(r?.options, []) ?? []).find((o) => o.id === optId);
  return r && opt ? { id: 'route', label: r.question, value: String(opt.label) } : undefined;
}

/** Is `start` bookable on this calendar (any type)? Throws 409 otherwise. */
export function assertFree(app: App, cal: CalendarRow, cfg: TeamCalConfig, start: Date, except?: string) {
  const ymd = ymdInTz(start, cal.timezone);
  if (cfg.kind !== 'single') {
    pickHosts(app, cal, cfg, start, { except });
    return;
  }
  const busy = busyFor(app, cal, ymd, except).filter((b) => !except || !app.db.get('SELECT 1 FROM appointments WHERE id = ? AND start_at = ? AND end_at = ?', except, b.start_at, b.end_at));
  if (!computeSlots(cal, ymd, busy).includes(start.toISOString())) throw new HttpError(409, 'Dieser Termin ist leider nicht mehr frei');
}

const notesOf = (notes: string, answers: Answer[]) => [notes, answerLines(answers)].filter(Boolean).join('\n\n').slice(0, 5000);

/** Books an appointment on a calendar of this module (free, or after the team waived the payment); returns the confirmed appointment. */
async function bookNow(app: App, cal: CalendarRow, cfg: TeamCalConfig, o: { start: string; contact: any; notes: string; answers: Answer[]; meta?: Record<string, string>; source?: string; hostId?: string; extra?: Record<string, any>; paid?: boolean; skipCheck?: boolean; checked?: boolean }) {
  const input: BookInput = {
    start: o.start,
    contact: o.contact,
    notes: notesOf(o.notes, o.answers),
    source: o.source ?? 'Buchungsseite',
    // Typed on the booking page (or the waiting list): never changes a stored e-mail or phone. The team's own bookings are 'manuell'.
    publicInput: (o.source ?? 'Buchungsseite') !== 'manuell',
    meta: o.meta,
    skipCheck: o.skipCheck,
    extra: { answers: o.answers, ...(o.extra ?? {}) },
    teamcal: { checked: o.checked, paid: o.paid, hostId: o.hostId, answers: true },
  };
  const b = beginBooking(app, cal, input);
  try {
    await attachVideo(app, cal, cfg, b.appt.id);
  } finally {
    const row = b.finish();
    notifyHosts(app, cal, row);
  }
  return app.db.get<any>('SELECT * FROM appointments WHERE id = ?', b.appt.id)!;
}

const outcome = (app: App, appt: any): Extract<BookResult, { status: 'confirmed' }> => ({
  status: 'confirmed',
  appointment: app.services.teamcalPayload ? { ...appt, ...app.services.teamcalPayload(appt) } : appt,
  manage_url: `${app.baseUrl()}/book/manage/${appt.manage_token}`,
  ics_url: `/book/ics/${appt.manage_token}`,
  meeting_url: appt.meeting_url || '',
  hosts: hostNames(app, parseJsonSafe<string[]>(appt.host_ids, []).length ? parseJsonSafe<string[]>(appt.host_ids, []) : appt.assignee_id ? [appt.assignee_id] : []),
});

/** The one entry for booking: validates, waits for payment when needed, otherwise confirms right away. */
export async function bookTeam(app: App, cal: CalendarRow, f: BookForm, opts: BookOpts = {}): Promise<BookResult> {
  const cfg = getConfig(app, cal.id);
  const start = new Date(f.start);
  if (Number.isNaN(start.getTime())) throw bad('Ungültige Startzeit');
  const form = cleanForm(cfg, f, opts);
  const route = routeAnswer(app, cal.location_id, f.via);
  const answers = route ? [...form.answers, route] : form.answers;
  const meta = { ...(f.meta ?? {}), ...(f.via ? { via: f.via.slice(0, 80) } : {}), ...(form.guests.length ? { guests: form.guests.join(',') } : {}) };
  const source = opts.source ?? (opts.staff ? 'manuell' : 'Buchungsseite');
  if (f.waitlist) return joinWaitlist(app, cal, cfg, start, form, answers);
  const needsPay = cfg.payment.mode !== 'none' && opts.payment !== 'waive';
  if (!needsPay) return outcome(app, await bookNow(app, cal, cfg, { start: start.toISOString(), contact: form.contact, notes: form.notes, answers, meta, source, hostId: opts.hostId, extra: cfg.payment.mode !== 'none' ? { payment: { status: 'waived', mode: cfg.payment.mode, amount_cents: cfg.payment.amount_cents, currency: cfg.payment.currency } } : undefined }));
  // Paid first: reserve the slot (and its host) and send the visitor to Stripe.
  const picked: Picked = cfg.kind === 'single' ? (assertFree(app, cal, cfg, start), { hosts: [], assignee: null }) : pickHosts(app, cal, cfg, start, { hostId: opts.hostId });
  const hold = await startHold(app, cal, cfg, { start, picked, contact: form.contact, notes: form.notes, answers, meta: { ...meta, source } });
  return { status: 'payment_required', hold_token: hold.token, checkout_url: hold.session_url!, expires_at: hold.expires_at, due_cents: hold.due_cents, currency: hold.currency };
}

// --- video + notices ------------------------------------------------------------------------------

async function attachVideo(app: App, cal: CalendarRow, cfg: TeamCalConfig, apptId: string) {
  if (cfg.video === 'none') return;
  const appt = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', apptId);
  if (!appt) return;
  const hosts = parseJsonSafe<string[]>(appt.host_ids, []);
  const contact = appt.contact_id ? getContact(app, appt.location_id, appt.contact_id) : undefined;
  const description = [contact ? `${[contact.first_name, contact.last_name].filter(Boolean).join(' ')} <${contact.email}>` : '', contact?.phone, appt.notes, appt.contact_id ? `Im CRM: ${app.baseUrl()}/app/contacts/${appt.contact_id}` : ''].filter(Boolean).join('\n');
  const r = await createVideo(app, cfg.video, appt, cal, hosts.length ? hosts : appt.assignee_id ? [appt.assignee_id] : [], description);
  if ('url' in r) {
    app.db.run('UPDATE appointments SET meeting_url = ?, meeting_state = ?, video_ref = ? WHERE id = ?', r.url, '', r.ref ? JSON.stringify(r.ref) : null, apptId);
    return;
  }
  if ('pending' in r) {
    app.db.run(`UPDATE appointments SET meeting_state = 'pending', video_ref = ? WHERE id = ?`, JSON.stringify(r.ref), apptId);
    return;
  }
  // No room: the fixed place stands in, and the team hears why.
  const fallback = String(cal.settings.meeting_location || '');
  if (fallback) app.db.run('UPDATE appointments SET meeting_url = ? WHERE id = ?', fallback, apptId);
  if (r.error) {
    app.db.run(`UPDATE appointments SET meeting_state = 'failed' WHERE id = ?`, apptId);
    track(app, notifyTeam(app, cal.location_id, `Video-Link fehlt: ${appt.title}`, `Für den Termin ${appt.title} (${formatInTz(appt.start_at, cal.timezone)}) konnte kein Video-Link erstellt werden.\n${r.error}${fallback ? `\nStattdessen steht der feste Ort / Link im Termin.` : ''}`).catch(() => undefined));
  }
}

/** Meet rooms that were still being made at booking: asked again; the customer gets the link as soon as it exists. */
export async function resolvePendingLinks(app: App) {
  for (const a of app.db.all<any>(`SELECT * FROM appointments WHERE meeting_state = 'pending' AND status = 'confirmed' AND created_at > ? LIMIT 25`, new Date(Date.now() - 3600_000).toISOString())) {
    let url = '';
    try {
      url = await resolvePending(app, a);
    } catch {
      /* later */
    }
    if (!url) continue;
    app.db.run(`UPDATE appointments SET meeting_url = ?, meeting_state = '' WHERE id = ?`, url, a.id);
    if (a.contact_id) {
      const cal = app.db.get<any>('SELECT timezone, name FROM calendars WHERE id = ?', a.calendar_id);
      track(app, sendToContact(app, a.location_id, { contactId: a.contact_id, channel: 'email', subject: `Dein Video-Link: ${cal?.name ?? 'Termin'}`, body: `Hallo,\n\nhier ist der Link zu deinem Termin am ${formatInTz(a.start_at, cal?.timezone ?? 'Europe/Berlin')}:\n${url}\n\nTermin verwalten: ${app.baseUrl()}/book/manage/${a.manage_token}`, source: 'Terminbestätigung', ignoreDnd: true }).then(() => undefined));
    }
  }
}

/** Tells the hosts (push + e-mail) about a new appointment of theirs. */
export function notifyHosts(app: App, cal: CalendarRow, row: any, kind: 'new' | 'moved' = 'new') {
  const hosts = parseJsonSafe<string[]>(row.host_ids, []).length ? parseJsonSafe<string[]>(row.host_ids, []) : row.assignee_id ? [row.assignee_id] : [];
  if (!hosts.length) return;
  const contact = row.contact_id ? getContact(app, row.location_id, row.contact_id) : undefined;
  const who = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email : 'Neuer Kontakt';
  const when = formatInTz(row.start_at, cal.timezone);
  track(app, Promise.resolve(app.services.pushNotify?.({ locationId: row.location_id, userIds: hosts, kind: 'booking', title: `${kind === 'moved' ? 'Termin verschoben' : 'Neuer Termin'}: ${cal.name}`, body: `${who} · ${when}`, url: '/app/calendars', tag: `booking-${row.id}` })));
  if (cal.settings.notify_team !== false) {
    for (const h of hostNames(app, hosts)) {
      const email = app.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', h.id)?.email;
      if (email) track(app, notifyTeam(app, row.location_id, `${kind === 'moved' ? 'Termin verschoben' : 'Neuer Termin für dich'}: ${cal.name}`, `${who} ${kind === 'moved' ? 'hat den Termin verschoben' : `hat ${cal.name} gebucht`}.\n${when} (${cal.timezone})\n${row.meeting_url ? `Link: ${row.meeting_url}\n` : ''}\n${app.baseUrl()}/app/calendars`, email).catch(() => undefined));
    }
  }
}

// --- paid holds -----------------------------------------------------------------------------------

/**
 * A hold was paid (webhook, or the customer's return): creates the invoice (marked paid) and the appointment. A payment that arrives
 * after the hold ran out is honoured when the slot is still free, otherwise the money goes back.
 */
export async function completeHold(app: App, holdId: string, session: { id?: string; payment_intent?: string | null }): Promise<{ hold: HoldRow; appointment?: any; refunded?: boolean } | undefined> {
  const before = holdBy(app, 'id', holdId);
  if (!before) return undefined;
  if (before.status === 'paid' || before.status === 'refunded') return { hold: before, appointment: before.appointment_id ? app.db.get('SELECT * FROM appointments WHERE id = ?', before.appointment_id) : undefined };
  const claimed = app.db.run(`UPDATE teamcal_holds SET status = 'paid', paid_at = ?, payment_intent = COALESCE(?, payment_intent), session_id = COALESCE(session_id, ?) WHERE id = ? AND status IN ('pending', 'expired', 'cancelled')`, now(), session.payment_intent ?? null, session.id ?? null, holdId).changes;
  if (!claimed) return { hold: holdBy(app, 'id', holdId)! };
  const hold = holdBy(app, 'id', holdId)!;
  const cal = parseCal(app, hold.calendar_id);
  if (!cal) return { hold };
  const cfg = getConfig(app, cal.id);
  // After the hold ran out somebody else may have taken the slot.
  if (before.status !== 'pending' || Date.parse(before.expires_at) < Date.now()) {
    try {
      assertFree(app, cal, cfg, new Date(hold.start_at), hold.id);
    } catch {
      if (hold.payment_intent) {
        await refundPayment(app, hold.location_id, hold.payment_intent, `teamcal-late-${hold.id}`).catch((e) => console.error('[teamcal] refund', (e as Error).message));
      }
      app.db.run(`UPDATE teamcal_holds SET status = 'refunded' WHERE id = ?`, hold.id);
      track(app, notifyTeam(app, hold.location_id, `Zahlung ohne freien Termin erstattet: ${cal.name}`, `${hold.contact.email} hat nach Ablauf der Reservierung bezahlt, der Termin ${formatInTz(hold.start_at, cal.timezone)} war inzwischen vergeben. Die Zahlung wurde erstattet${hold.payment_intent ? '' : ' – bitte im Stripe-Dashboard prüfen'}.`).catch(() => undefined));
      return { hold: holdBy(app, 'id', hold.id)!, refunded: true };
    }
  }
  const { contact } = upsertContact(app, hold.location_id, hold.contact, { source: `Kalender: ${cal.name}`, publicInput: (hold.meta.source || 'Buchungsseite') !== 'manuell' });
  const invoice = createPaidInvoice(app, cal, cfg, hold, contact.id);
  const payment = { status: 'paid', mode: hold.mode, amount_cents: hold.amount_cents, due_cents: hold.due_cents, currency: hold.currency, invoice_id: invoice.id, payment_intent: hold.payment_intent, paid_at: hold.paid_at };
  const appt = await bookNow(app, cal, cfg, { start: hold.start_at, contact: { ...hold.contact }, notes: hold.notes, answers: hold.answers, meta: hold.meta, source: hold.meta.source || 'Buchungsseite', extra: { assignee_id: hold.host_ids[0] ?? null, host_ids: hold.host_ids, payment }, paid: true, skipCheck: true, checked: true });
  app.db.run('UPDATE teamcal_holds SET appointment_id = ?, invoice_id = ? WHERE id = ?', appt.id, invoice.id, hold.id);
  if (hold.meta.waitlist_id) app.db.run(`UPDATE teamcal_waitlist SET status = 'booked', appointment_id = ? WHERE id = ?`, appt.id, hold.meta.waitlist_id);
  return { hold: holdBy(app, 'id', hold.id)!, appointment: appt };
}

const parseCal = (app: App, calendarId: string): CalendarRow | undefined => {
  const row = app.db.get<any>('SELECT * FROM calendars WHERE id = ?', calendarId);
  return row ? { ...row, availability: JSON.parse(row.availability || '{}'), settings: JSON.parse(row.settings || '{}') } : undefined;
};
export const calendarById = parseCal;

/** The invoice of a paid booking (for the books and the customer), created after the money arrived. */
function createPaidInvoice(app: App, cal: CalendarRow, cfg: TeamCalConfig, hold: HoldRow, contactId: string) {
  const s = app.location(hold.location_id)?.settings.invoices ?? {};
  const rate = cfg.payment.tax_rate ?? (s.small_business ? 0 : Number(s.tax_rate ?? 19));
  const title = cfg.payment.title || cal.name;
  const when = `${formatInTz(hold.start_at, cal.timezone)} (${cal.timezone})`;
  const inv = createInvoice(app, hold.location_id, {
    kind: 'invoice',
    contact_id: contactId,
    title: hold.mode === 'deposit' ? `Anzahlung: ${title}` : title,
    items: itemsForGross({ name: hold.mode === 'deposit' ? `Anzahlung: ${title}` : title, description: `Termin am ${when}` }, hold.due_cents, rate),
    currency: hold.currency,
    notes: `Online bezahlt über Stripe.${hold.mode === 'deposit' ? ` Restbetrag ${centsToMoney(hold.amount_cents - hold.due_cents, hold.currency)} vor Ort.` : ''}`,
  });
  if (hold.session_id) {
    app.db.run(
      `INSERT OR IGNORE INTO stripe_checkouts (id, location_id, kind, invoice_id, contact_id, amount_cents, currency, status, email, payment_intent, created_at, paid_at) VALUES (?, ?, 'invoice', ?, ?, ?, ?, 'paid', ?, ?, ?, ?)`,
      hold.session_id, hold.location_id, inv.id, contactId, hold.due_cents, hold.currency, hold.contact.email, hold.payment_intent, now(), now(),
    );
  }
  markInvoicePaid(app, hold.location_id, inv.id, 'Stripe (Terminbuchung)');
  return inv;
}

/** Holds whose time ran out: released (the Checkout page is closed, a late payment is still handled by completeHold). */
export function expireHolds(app: App): HoldRow[] {
  const due = app.db.all<{ id: string }>(`SELECT id FROM teamcal_holds WHERE status = 'pending' AND expires_at <= ? LIMIT 100`, now());
  const out: HoldRow[] = [];
  for (const d of due) {
    if (!app.db.run(`UPDATE teamcal_holds SET status = 'expired' WHERE id = ? AND status = 'pending'`, d.id).changes) continue;
    out.push(holdBy(app, 'id', d.id)!);
  }
  return out;
}

// --- cancel and reschedule ----------------------------------------------------------------------------

export interface CancelOpts {
  by: 'customer' | 'staff' | 'system';
  reason?: string;
  /** Staff: send the money back (default: by the calendar's refund setting and the cutoff). */
  refund?: boolean;
}

export interface CancelResult {
  ok: true;
  status: 'cancelled';
  refund: 'refunded' | 'none' | 'manual';
}

/** Cancels an appointment with the calendar's rules: cutoff for customers, refund by setting, notices, the seat goes to the waiting list. */
export async function cancelAppointment(app: App, appt: any, o: CancelOpts): Promise<CancelResult> {
  const cal = parseCal(app, appt.calendar_id)!;
  const cfg = getConfig(app, cal.id);
  if (appt.status === 'cancelled') return { ok: true, status: 'cancelled', refund: 'none' };
  const inTime = mayChange(cfg.cancel_cutoff_hours, appt.start_at);
  if (o.by === 'customer') {
    if (!cfg.allow_cancel) throw new HttpError(403, 'Dieser Termin kann online nicht abgesagt werden – bitte melde dich direkt');
    if (!inTime) throw new HttpError(403, cfg.cancel_cutoff_hours ? `Online absagen geht bis ${cfg.cancel_cutoff_hours} Stunden vor dem Termin – bitte melde dich direkt` : 'Der Termin hat schon begonnen');
  }
  app.db.run(`UPDATE appointments SET status = 'cancelled', cancel_reason = ? WHERE id = ?`, String(o.reason ?? '').slice(0, 300), appt.id);
  const next = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', appt.id)!;
  if (appt.contact_id) logActivity(app, appt.location_id, appt.contact_id, 'appointment.status_changed', o.by === 'customer' ? 'Termin vom Kontakt abgesagt' : `Termin abgesagt${o.reason ? `: ${o.reason}` : ''}`);
  app.events.emit(appt.location_id, 'appointment.status_changed', { contactId: appt.contact_id, appointment: { ...next, ...(app.services.teamcalPayload?.(next) ?? {}) }, status: 'cancelled', calendarId: appt.calendar_id, by: o.by });
  void removeVideo(app, next).catch((e) => console.error('[teamcal] video', (e as Error).message));
  // Money: a customer's cancellation in time is refunded when the calendar says so; staff decide by hand.
  const pay = parseJsonSafe<any>(appt.payment, null);
  let refund: CancelResult['refund'] = 'none';
  if (pay?.status === 'paid' && pay.payment_intent) {
    const want = o.refund ?? (o.by === 'system' ? false : cfg.payment.refund === 'auto' && inTime);
    if (want) {
      try {
        await refundPayment(app, appt.location_id, pay.payment_intent, `teamcal-refund-${appt.id}`);
        app.db.run('UPDATE appointments SET payment = ? WHERE id = ?', JSON.stringify({ ...pay, status: 'refunded', refunded_at: now() }), appt.id);
        if (pay.invoice_id) {
          // the invoice is cancelled by a Stornorechnung (a finalised invoice is never just flipped to void)
          try {
            stornoInvoice(app, appt.location_id, pay.invoice_id, { reason: 'Erstattet: Termin abgesagt' });
          } catch (e) {
            console.error('[teamcal] Storno', (e as Error).message);
          }
        }
        refund = 'refunded';
      } catch (e) {
        refund = 'manual';
        track(app, notifyTeam(app, appt.location_id, `Erstattung fehlgeschlagen: ${appt.title}`, `Die automatische Erstattung für ${appt.title} ist fehlgeschlagen (${(e as Error).message}). Bitte im Stripe-Dashboard erstatten.`).catch(() => undefined));
      }
    } else if (cfg.payment.refund !== 'none') {
      refund = 'manual';
      app.db.run('UPDATE appointments SET payment = ? WHERE id = ?', JSON.stringify({ ...pay, status: 'refund_pending' }), appt.id);
    }
  }
  const who = o.by === 'customer' ? 'vom Kontakt' : o.by === 'staff' ? 'vom Team' : 'automatisch';
  track(app, notifyTeam(app, appt.location_id, `Termin abgesagt: ${appt.title}`, `${appt.title} (${formatInTz(appt.start_at, cal.timezone)}) wurde ${who} abgesagt.${refund === 'manual' ? '\nDie Zahlung muss noch erstattet werden (Zahlungen im Stripe-Dashboard).' : refund === 'refunded' ? '\nDie Zahlung wurde erstattet.' : ''}`).catch(() => undefined));
  notifyHostsCancel(app, cal, next);
  if (appt.contact_id && o.by !== 'customer') {
    track(app, sendToContact(app, appt.location_id, { contactId: appt.contact_id, channel: 'email', subject: `Termin abgesagt: ${cal.name}`, body: `Hallo,\n\nleider müssen wir deinen Termin am ${formatInTz(appt.start_at, cal.timezone)} (${cal.timezone}) absagen.${o.reason ? `\n${o.reason}` : ''}${refund === 'refunded' ? '\nDeine Zahlung wird erstattet.' : ''}\n\nEinen neuen Termin findest du hier: ${app.baseUrl()}/book/${cal.slug}`, source: 'Terminabsage', ignoreDnd: true }).then(() => undefined));
  } else if (appt.contact_id) {
    track(app, sendToContact(app, appt.location_id, { contactId: appt.contact_id, channel: 'email', subject: `Termin abgesagt: ${cal.name}`, body: `Hallo,\n\ndein Termin am ${formatInTz(appt.start_at, cal.timezone)} (${cal.timezone}) ist abgesagt.${refund === 'refunded' ? '\nDeine Zahlung wird erstattet (das dauert bei der Bank ein paar Tage).' : ''}${refund === 'manual' ? '\nÜber eine mögliche Erstattung melden wir uns.' : ''}\n\nNeuen Termin buchen: ${app.baseUrl()}/book/${cal.slug}`, source: 'Terminabsage', ignoreDnd: true }).then(() => undefined));
  }
  if (cfg.kind === 'group') void offerNext(app, cal, cfg, appt.start_at).catch(() => undefined);
  return { ok: true, status: 'cancelled', refund };
}

function notifyHostsCancel(app: App, cal: CalendarRow, row: any) {
  const hosts = parseJsonSafe<string[]>(row.host_ids, []).length ? parseJsonSafe<string[]>(row.host_ids, []) : row.assignee_id ? [row.assignee_id] : [];
  if (hosts.length) track(app, Promise.resolve(app.services.pushNotify?.({ locationId: row.location_id, userIds: hosts, kind: 'booking', title: `Termin abgesagt: ${cal.name}`, body: formatInTz(row.start_at, cal.timezone), url: '/app/calendars', tag: `booking-${row.id}` })));
}

/** Moves an appointment; customers within the cutoff only. Keeps the host when they are free, otherwise takes another. */
export async function rescheduleAppointment(app: App, appt: any, startIso: string, o: { by: 'customer' | 'staff' }) {
  const base = parseCal(app, appt.calendar_id)!;
  const cfg = getConfig(app, base.id);
  // Calendars with several lengths: the appointment keeps the one it was booked with.
  const own = Math.round((Date.parse(appt.end_at) - Date.parse(appt.start_at)) / 60_000);
  const cal = own !== base.duration && durationChoices(base.duration, cfg).includes(own) ? { ...base, duration: own } : base;
  if (appt.status !== 'confirmed') throw bad('Dieser Termin kann nicht mehr verschoben werden');
  if (o.by === 'customer') {
    if (!cfg.allow_reschedule) throw new HttpError(403, 'Dieser Termin kann online nicht verschoben werden – bitte melde dich direkt');
    if (!mayChange(cfg.reschedule_cutoff_hours, appt.start_at)) throw new HttpError(403, cfg.reschedule_cutoff_hours ? `Online verschieben geht bis ${cfg.reschedule_cutoff_hours} Stunden vor dem Termin – bitte melde dich direkt` : 'Der Termin hat schon begonnen');
  }
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw bad('Ungültige Startzeit');
  const extra: Record<string, any> = {};
  if (cfg.kind === 'single') assertFree(app, cal, cfg, start, appt.id);
  else {
    const hostId = appt.assignee_id as string | null;
    let picked: Picked;
    try {
      picked = pickHosts(app, cal, cfg, start, { except: appt.id, hostId: cfg.kind === 'round_robin' ? (hostId ?? undefined) : undefined });
    } catch (e) {
      if (!(e instanceof HttpError) || cfg.kind !== 'round_robin') throw e;
      picked = pickHosts(app, cal, cfg, start, { except: appt.id });
    }
    extra.assignee_id = picked.assignee;
    extra.host_ids = JSON.stringify(picked.hosts);
  }
  const end = new Date(start.getTime() + cal.duration * 60_000);
  app.db.run(`UPDATE appointments SET start_at = ?, end_at = ?, reminder_sent = 0 ${Object.keys(extra).map((k) => `, ${k} = ?`).join('')} WHERE id = ?`, start.toISOString(), end.toISOString(), ...Object.values(extra), appt.id);
  const next = app.db.get<any>('SELECT * FROM appointments WHERE id = ?', appt.id)!;
  if (appt.contact_id) logActivity(app, appt.location_id, appt.contact_id, 'appointment.rescheduled', `Termin verschoben: ${formatInTz(next.start_at, cal.timezone)}`);
  app.events.emit(appt.location_id, 'appointment.rescheduled', { contactId: appt.contact_id, appointment: { ...next, ...(app.services.teamcalPayload?.(next) ?? {}) }, previousStart: appt.start_at, calendarId: appt.calendar_id, by: o.by });
  void moveVideo(app, next).catch((e) => console.error('[teamcal] video', (e as Error).message));
  notifyHosts(app, cal, next, 'moved');
  if (appt.contact_id) track(app, sendToContact(app, appt.location_id, { contactId: appt.contact_id, channel: 'email', subject: `Termin verschoben: ${cal.name}`, body: `Hallo,\n\ndein Termin findet jetzt am ${formatInTz(next.start_at, cal.timezone)} (${cal.timezone}) statt.${next.meeting_url ? `\nLink: ${next.meeting_url}` : ''}\n\nTermin verwalten: ${app.baseUrl()}/book/manage/${next.manage_token}`, source: 'Terminbestätigung', ignoreDnd: true }).then(() => undefined));
  if (cfg.kind === 'group') void offerNext(app, cal, cfg, appt.start_at).catch(() => undefined);
  return next;
}

// --- waiting list (group classes) -----------------------------------------------------------------------

function joinWaitlist(app: App, cal: CalendarRow, cfg: TeamCalConfig, start: Date, form: ReturnType<typeof cleanForm>, answers: Answer[]): BookResult {
  if (cfg.kind !== 'group' || !cfg.waitlist) throw bad('Für diesen Termin gibt es keine Warteliste');
  const iso = start.toISOString();
  const day = slotsOfDay(app, cal, cfg, ymdInTz(start, cal.timezone));
  if (!day?.full.includes(iso)) throw bad('Für diesen Termin sind noch Plätze frei – bitte direkt buchen');
  const dup = app.db.get(`SELECT 1 FROM teamcal_waitlist WHERE calendar_id = ? AND start_at = ? AND status IN ('waiting', 'offered') AND lower(json_extract(contact, '$.email')) = ?`, cal.id, iso, form.contact.email);
  if (dup) throw bad('Du stehst für diesen Termin schon auf der Warteliste');
  const row = { id: id(), location_id: cal.location_id, calendar_id: cal.id, start_at: iso, contact: form.contact, notes: form.notes, answers, token: token(18), status: 'waiting', created_at: now() };
  app.db.insert('teamcal_waitlist', row);
  if (form.contact.email) track(app, notifyTeam(app, cal.location_id, `Warteliste: ${cal.name}`, `${form.contact.email} steht für ${formatInTz(iso, cal.timezone)} auf der Warteliste.`).catch(() => undefined));
  return { status: 'waitlisted', token: row.token };
}

/** A seat is free again: the first person on the waiting list gets an e-mail with a link that books it (valid for a day). */
export async function offerNext(app: App, cal: CalendarRow, cfg: TeamCalConfig, startIso: string) {
  if (!cfg.waitlist) return;
  const day = slotsOfDay(app, cal, cfg, ymdInTz(new Date(startIso), cal.timezone));
  if (!day?.slots.some((s) => s.start === startIso)) return;
  const w = app.db.get<any>(`SELECT * FROM teamcal_waitlist WHERE calendar_id = ? AND start_at = ? AND status = 'waiting' ORDER BY created_at LIMIT 1`, cal.id, startIso);
  if (!w) return;
  const contact = JSON.parse(w.contact);
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  app.db.run(`UPDATE teamcal_waitlist SET status = 'offered', offered_at = ?, offer_expires_at = ? WHERE id = ?`, now(), expires, w.id);
  const { contact: c } = upsertContact(app, cal.location_id, contact, { source: `Kalender: ${cal.name}`, publicInput: true });
  await sendToContact(app, cal.location_id, { contactId: c.id, channel: 'email', subject: `Platz frei: ${cal.name}`, body: `Hallo ${contact.first_name || ''},\n\nbei ${cal.name} am ${formatInTz(startIso, cal.timezone)} (${cal.timezone}) ist ein Platz frei geworden. Du kannst ihn 24 Stunden lang buchen:\n${app.baseUrl()}/book/waitlist/${w.token}\n\nWer zuerst bucht, bekommt den Platz.`, source: 'Warteliste', ignoreDnd: true });
}

/** The offer link: books the seat for the person on the waiting list, if it is still theirs and still free. */
export async function bookFromWaitlist(app: App, tokenValue: string): Promise<{ appointment: any } | { checkout_url: string; hold_token: string } | { error: string }> {
  const w = app.db.get<any>('SELECT * FROM teamcal_waitlist WHERE token = ?', tokenValue);
  if (!w) return { error: 'Dieses Angebot gibt es nicht.' };
  if (w.status === 'booked') return { appointment: app.db.get('SELECT * FROM appointments WHERE id = ?', w.appointment_id) };
  if (w.status !== 'offered' || (w.offer_expires_at && w.offer_expires_at < now())) return { error: 'Das Angebot ist abgelaufen.' };
  const cal = parseCal(app, w.calendar_id);
  if (!cal) return { error: 'Diesen Kalender gibt es nicht mehr.' };
  const cfg = getConfig(app, cal.id);
  // A paid class stays paid: the seat is held and the person goes to Stripe; the entry is "booked" once the money arrives (completeHold).
  if (cfg.payment.mode !== 'none') {
    try {
      const start = new Date(w.start_at);
      const picked: Picked = cfg.kind === 'single' ? (assertFree(app, cal, cfg, start), { hosts: [], assignee: null }) : pickHosts(app, cal, cfg, start, {});
      const hold = await startHold(app, cal, cfg, { start, picked, contact: JSON.parse(w.contact), notes: w.notes ?? '', answers: JSON.parse(w.answers || '[]'), meta: { source: 'Warteliste', waitlist_id: w.id } });
      return { checkout_url: hold.session_url!, hold_token: hold.token };
    } catch (e) {
      return { error: e instanceof HttpError ? e.message : 'Der Platz ist leider nicht mehr frei.' };
    }
  }
  try {
    const claimed = app.db.run(`UPDATE teamcal_waitlist SET status = 'booked' WHERE id = ? AND status = 'offered'`, w.id).changes;
    if (!claimed) return { error: 'Das Angebot wurde schon benutzt.' };
    const appt = await bookNow(app, cal, cfg, { start: w.start_at, contact: JSON.parse(w.contact), notes: w.notes, answers: JSON.parse(w.answers || '[]'), source: 'Warteliste' });
    app.db.run('UPDATE teamcal_waitlist SET appointment_id = ? WHERE id = ?', appt.id, w.id);
    return { appointment: appt };
  } catch (e) {
    app.db.run(`UPDATE teamcal_waitlist SET status = 'offered' WHERE id = ? AND status = 'booked' AND appointment_id IS NULL`, w.id);
    return { error: e instanceof HttpError ? e.message : 'Der Platz ist leider nicht mehr frei.' };
  }
}

