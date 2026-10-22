import type { App } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { centsToMoney, id, normalizeEmail, now, token } from '../core/util.js';
import { createInvoice } from '../modules/payments.js';
import { logActivity, upsertContact } from './contacts.js';
import { notifyTeam, sendToContact } from './messaging.js';
import { MIN_CENTS, bookInvoicePayment, type PaySession } from './pay-registry.js';
import { itemsForGross } from './teamcal-model.js';
import { HOLD_MINUTES, cleanPicks, maxPick, saleState, ticketCode, SALE_LABEL, type TicketEventRow, type TicketTypeRow } from './ticket-events-model.js';

/**
 * Selling and checking in event tickets (docs/booking.md#ticket-types). The quota check and the reservation happen in one
 * synchronous SQLite transaction, so two buyers can never take the last ticket twice. A paid order holds its tickets for
 * HOLD_MINUTES while the buyer pays through the payment registry (Stripe, PayPal, Mollie, gift cards); only then are they valid.
 */

export const PURPOSE = 'ticket_order';

export const eventOf = (app: App, locationId: string, eventId: string) => app.db.get<TicketEventRow>('SELECT * FROM tix_events WHERE id = ? AND location_id = ?', eventId, locationId);
export const typesOf = (app: App, eventId: string) => app.db.all<TicketTypeRow>('SELECT * FROM tix_types WHERE event_id = ? ORDER BY position, created_at', eventId);

/** Tickets that count against the quota: valid ones and held ones whose order is still within its payment time. */
export function takenByType(app: App, eventId: string, at = now()): Map<string, number> {
  const rows = app.db.all<{ type_id: string; n: number }>(
    `SELECT t.type_id, COUNT(*) AS n FROM tix_tickets t JOIN tix_orders o ON o.id = t.order_id
     WHERE t.event_id = ? AND (t.status = 'valid' OR (t.status = 'held' AND o.status = 'pending' AND o.expires_at > ?)) GROUP BY t.type_id`,
    eventId,
    at,
  );
  return new Map(rows.map((r) => [r.type_id, Number(r.n)]));
}

/** The types with what is left and whether they are on sale – for the public page, the admin and the report. */
export function typesWithState(app: App, ev: TicketEventRow, at = new Date()) {
  const taken = takenByType(app, ev.id, at.toISOString());
  return typesOf(app, ev.id).map((t) => {
    const n = taken.get(t.id) ?? 0;
    const s = saleState(t, n, at, ev.starts_at);
    return { ...t, taken: n, left: s.left, state: s.state, state_label: SALE_LABEL[s.state], max_pick: s.state === 'on_sale' ? maxPick(t, s.left) : 0 };
  });
}

/** Sold / held / checked in / revenue per type (paid orders only count as revenue). */
export function report(app: App, ev: TicketEventRow) {
  const at = now();
  const rows = app.db.all<any>(
    `SELECT t.type_id,
       SUM(CASE WHEN t.status = 'valid' THEN 1 ELSE 0 END) AS sold,
       SUM(CASE WHEN t.status = 'valid' AND t.checked_in_at IS NOT NULL THEN 1 ELSE 0 END) AS checked_in,
       SUM(CASE WHEN t.status = 'held' AND o.status = 'pending' AND o.expires_at > ? THEN 1 ELSE 0 END) AS held,
       SUM(CASE WHEN t.status = 'valid' THEN t.price_cents ELSE 0 END) AS revenue_cents
     FROM tix_tickets t JOIN tix_orders o ON o.id = t.order_id WHERE t.event_id = ? GROUP BY t.type_id`,
    at,
    ev.id,
  );
  const by = new Map(rows.map((r) => [r.type_id, r]));
  const types = typesWithState(app, ev).map((t) => {
    const r = by.get(t.id) ?? {};
    return { type_id: t.id, name: t.name, price_cents: t.price_cents, quota: t.quota, sold: Number(r.sold ?? 0), checked_in: Number(r.checked_in ?? 0), held: Number(r.held ?? 0), left: t.left, revenue_cents: Number(r.revenue_cents ?? 0), state: t.state };
  });
  const sum = (k: 'sold' | 'checked_in' | 'held' | 'revenue_cents') => types.reduce((n, t) => n + t[k], 0);
  return { event_id: ev.id, name: ev.name, starts_at: ev.starts_at, currency: ev.currency, types, totals: { sold: sum('sold'), checked_in: sum('checked_in'), held: sum('held'), revenue_cents: sum('revenue_cents') } };
}

export interface Buyer {
  name: string;
  email: string;
}

export function cleanBuyer(b: Record<string, any>): Buyer {
  const name = String(b.name ?? '').trim().slice(0, 200);
  const email = normalizeEmail(b.email);
  if (!name) throw bad('Bitte deinen Namen angeben');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
  return { name, email };
}

export interface OrderRow {
  id: string;
  location_id: string;
  event_id: string;
  token: string;
  contact_id: string | null;
  name: string;
  email: string;
  status: 'pending' | 'paid' | 'cancelled' | 'expired' | 'refunded';
  total_cents: number;
  currency: string;
  pay_session_id: string | null;
  invoice_id: string | null;
  expires_at: string;
  created_at: string;
  paid_at: string | null;
}

export const orderByToken = (app: App, tok: string) => app.db.get<OrderRow>('SELECT * FROM tix_orders WHERE token = ?', tok);
export const ticketsOfOrder = (app: App, orderId: string) =>
  app.db.all<any>('SELECT t.*, y.name AS type_name FROM tix_tickets t JOIN tix_types y ON y.id = t.type_id WHERE t.order_id = ? ORDER BY y.position, t.created_at', orderId);

export const orderUrl = (app: App, o: Pick<OrderRow, 'token'>) => `${app.baseUrl()}/book/event-order/${encodeURIComponent(o.token)}`;
export const ticketUrl = (app: App, tok: string) => `${app.baseUrl()}/book/event-ticket/${encodeURIComponent(tok)}`;

/**
 * Reserves the picked tickets – all or none – and writes the order. Throws 409 with a German reason when a type is not on sale,
 * sold out or over its per-order limit. Free orders are valid at once; paid ones are held until the payment arrives.
 */
export function placeOrder(app: App, ev: TicketEventRow, body: Record<string, any>, buyer: Buyer): OrderRow {
  if (!ev.active) throw new HttpError(409, 'Für dieses Event gibt es keine Tickets mehr');
  const picks = cleanPicks(body);
  return app.db.tx(() => {
    const at = new Date();
    const types = new Map(typesWithState(app, ev, at).map((t) => [t.id, t]));
    let total = 0;
    for (const p of picks) {
      const t = types.get(p.type_id);
      if (!t) throw bad('Unbekannte Ticketart');
      if (t.state !== 'on_sale') throw new HttpError(409, `„${t.name}“: ${t.state_label}`);
      if (t.left !== null && p.qty > t.left) throw new HttpError(409, `„${t.name}“: nur noch ${t.left} verfügbar`);
      if (p.qty > t.max_pick) throw new HttpError(409, `„${t.name}“: höchstens ${t.max_pick} je Bestellung`);
      total += p.qty * t.price_cents;
    }
    if (total > 0 && total < MIN_CENTS) throw bad('Der Betrag ist zu klein für eine Online-Zahlung');
    if (total > 0 && !(app.services.payRegistry?.ready(ev.location_id)?.length > 0)) throw new HttpError(409, 'Die Online-Zahlung ist für dieses Event noch nicht eingerichtet (Einstellungen → Stripe & Zahlungen)');
    const [first, ...rest] = buyer.name.split(/\s+/);
    const contact = upsertContact(app, ev.location_id, { first_name: first, last_name: rest.join(' '), email: buyer.email }, { source: `Event-Tickets: ${ev.name}`, publicInput: true }).contact;
    const t0 = now();
    const free = total === 0;
    const order: OrderRow = {
      id: id(),
      location_id: ev.location_id,
      event_id: ev.id,
      token: token(18),
      contact_id: contact.id,
      name: buyer.name,
      email: buyer.email,
      status: free ? 'paid' : 'pending',
      total_cents: total,
      currency: ev.currency,
      pay_session_id: null,
      invoice_id: null,
      expires_at: new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString(),
      created_at: t0,
      paid_at: free ? t0 : null,
    };
    app.db.insert('tix_orders', { ...order, updated_at: t0 });
    for (const p of picks) {
      const t = types.get(p.type_id)!;
      for (let i = 0; i < p.qty; i++) {
        const tok = token(18);
        app.db.insert('tix_tickets', { id: id(), location_id: ev.location_id, event_id: ev.id, type_id: t.id, order_id: order.id, token: tok, code: ticketCode(tok), price_cents: t.price_cents, status: free ? 'valid' : 'held', created_at: t0 });
      }
    }
    return order;
  });
}

/** Lines for the pay page and the invoice: one per type. */
function linesOf(app: App, order: OrderRow) {
  const by = new Map<string, { name: string; qty: number; unit: number }>();
  for (const t of ticketsOfOrder(app, order.id)) {
    const x = by.get(t.type_id) ?? { name: t.type_name, qty: 0, unit: t.price_cents };
    x.qty++;
    by.set(t.type_id, x);
  }
  return [...by.values()];
}

/** Starts the payment of a pending order and returns where the buyer goes next (the pay page or the provider's checkout). */
export async function startPayment(app: App, ev: TicketEventRow, order: OrderRow): Promise<string> {
  const reg = app.services.payRegistry;
  try {
    const s = reg.start({
      locationId: ev.location_id,
      purpose: PURPOSE,
      refId: order.id,
      amountCents: order.total_cents,
      currency: order.currency,
      description: `Tickets: ${ev.name}`,
      email: order.email,
      name: order.name,
      lines: linesOf(app, order).map((l) => ({ name: `Ticket ${l.name}`, qty: l.qty, unit_cents: l.unit })),
      returnUrl: orderUrl(app, order),
      cancelUrl: orderUrl(app, order),
    });
    app.db.run('UPDATE tix_orders SET pay_session_id = ?, updated_at = ? WHERE id = ?', s.id, now(), order.id);
    const ready: string[] = reg.ready(ev.location_id);
    if (reg.choiceNeeded(ev.location_id) || ready.length !== 1) return reg.pageUrl(s);
    return (await reg.checkout(s.id, ready[0])).url;
  } catch (e) {
    cancelOrder(app, order.id, 'cancelled');
    throw e;
  }
}

export function cancelOrder(app: App, orderId: string, status: 'cancelled' | 'expired') {
  app.db.tx(() => {
    if (!app.db.run(`UPDATE tix_orders SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, status, now(), orderId).changes) return;
    app.db.run(`UPDATE tix_tickets SET status = 'cancelled' WHERE order_id = ? AND status = 'held'`, orderId);
  });
}

/** Pending orders past their payment time: released (a payment that still arrives is handled by settleOrder). */
export function expireOrders(app: App) {
  const due = app.db.all<{ id: string; pay_session_id: string | null }>(`SELECT id, pay_session_id FROM tix_orders WHERE status = 'pending' AND expires_at <= ? LIMIT 200`, now());
  for (const d of due) {
    cancelOrder(app, d.id, 'expired');
    if (d.pay_session_id) app.services.payRegistry?.lapse(d.pay_session_id, 'expired');
  }
  return due.length;
}

/**
 * The money for an order arrived (the registry calls this once per session). Within its payment time the held tickets become
 * valid; after it, only if the quota still has room – otherwise everything goes back and the team is told.
 */
export async function settleOrder(app: App, s: PaySession, received: number) {
  const o = app.db.get<OrderRow>('SELECT * FROM tix_orders WHERE id = ? AND location_id = ?', s.ref_id, s.location_id);
  if (!o || o.status === 'paid' || o.status === 'refunded') return;
  const ev = eventOf(app, o.location_id, o.event_id);
  if (!ev) return;
  const money = (c: number) => centsToMoney(c, o.currency);
  if (received + s.gift_cents < o.total_cents) {
    void notifyTeam(app, o.location_id, `Tickets „${ev.name}“: Betrag passt nicht`, `Für die Bestellung von ${o.name} <${o.email}> kamen ${money(received + s.gift_cents)} statt ${money(o.total_cents)} an. Bitte prüfen.`).catch(() => undefined);
    return;
  }
  const ok = app.db.tx(() => {
    if (o.status === 'pending' && Date.parse(o.expires_at) > Date.now()) {
      app.db.run(`UPDATE tix_tickets SET status = 'valid' WHERE order_id = ? AND status = 'held'`, o.id);
    } else {
      // Late: the hold lapsed. Revive the tickets only while the quota still has room for every one of them.
      const want = new Map<string, number>();
      for (const t of app.db.all<{ type_id: string }>('SELECT type_id FROM tix_tickets WHERE order_id = ?', o.id)) want.set(t.type_id, (want.get(t.type_id) ?? 0) + 1);
      const taken = takenByType(app, ev.id);
      for (const t of typesOf(app, ev.id)) if (want.has(t.id) && t.quota !== null && (taken.get(t.id) ?? 0) + want.get(t.id)! > t.quota) return false;
      app.db.run(`UPDATE tix_tickets SET status = 'valid' WHERE order_id = ?`, o.id);
    }
    app.db.run(`UPDATE tix_orders SET status = 'paid', paid_at = ?, pay_session_id = ?, updated_at = ? WHERE id = ?`, now(), s.id, now(), o.id);
    return true;
  });
  if (!ok) {
    app.db.run(`UPDATE tix_orders SET status = 'refunded', pay_session_id = ?, updated_at = ? WHERE id = ?`, s.id, now(), o.id);
    let how = 'automatisch erstattet';
    await Promise.resolve(app.services.payRegistry?.refundAll(s.id)).catch((e: Error) => {
      how = `NICHT automatisch erstattet (${e.message}) – bitte von Hand erstatten`;
    });
    void notifyTeam(app, o.location_id, `Tickets „${ev.name}“: Zahlung nach Ablauf`, `${o.name} <${o.email}> hat nach Ablauf der Reservierung bezahlt (${money(o.total_cents)}), die Tickets waren inzwischen vergeben. Der Betrag wurde ${how}.`).catch(() => undefined);
    return;
  }
  const via = app.services.payRegistry?.label(s.provider) ?? s.provider;
  try {
    const inv = paidInvoice(app, ev, o, via);
    if (s.gift_cents > 0 && s.gift_card_id) app.services.giftCards?.payInvoice(o.location_id, inv, s.gift_card_id, s.gift_cents, s.id);
    if (received > 0) bookInvoicePayment(app, o.location_id, inv, { amount: received, currency: s.currency, via, note: s.capture_ref || s.provider_ref });
    app.db.run('UPDATE tix_orders SET invoice_id = ? WHERE id = ?', inv, o.id);
  } catch (e) {
    console.error('[tickets] invoice', (e as Error).message);
    void notifyTeam(app, o.location_id, `Tickets „${ev.name}“: Rechnung nicht erstellt`, `Die Bestellung von ${o.name} ist bezahlt, die Rechnung konnte nicht erstellt werden: ${(e as Error).message}`).catch(() => undefined);
  }
  afterConfirmed(app, ev, { ...o, status: 'paid' });
}

function paidInvoice(app: App, ev: TicketEventRow, o: OrderRow, via: string): string {
  const s = app.location(o.location_id)?.settings.invoices ?? {};
  const rate = ev.tax_rate ?? (s.small_business ? 0 : Number(s.tax_rate ?? 19));
  const tz = app.location(o.location_id)?.timezone || 'Europe/Berlin';
  const when = formatInTz(ev.starts_at, tz);
  const items = linesOf(app, o).flatMap((l) => itemsForGross({ name: `Ticket ${l.name} – ${ev.name}`, description: `${l.qty} × ${centsToMoney(l.unit, o.currency)} · Event am ${when}` }, l.qty * l.unit, rate));
  return createInvoice(app, o.location_id, { kind: 'invoice', contact_id: o.contact_id, title: `Tickets: ${ev.name}`, items, currency: o.currency, notes: `Online bezahlt über ${via}. Deine Tickets: ${orderUrl(app, o)}` }).id;
}

/** Confirmation: activity on the contact and an e-mail with the link to the tickets (each with its own QR code). */
export function afterConfirmed(app: App, ev: TicketEventRow, o: OrderRow) {
  const tickets = ticketsOfOrder(app, o.id);
  const tz = app.location(o.location_id)?.timezone || 'Europe/Berlin';
  if (o.contact_id) logActivity(app, o.location_id, o.contact_id, 'tickets.ordered', `${tickets.length} Ticket(s) für „${ev.name}“${o.total_cents ? ` (${centsToMoney(o.total_cents, o.currency)})` : ''}`);
  app.events.emit(o.location_id, 'tickets.ordered', { contactId: o.contact_id ?? undefined, eventId: ev.id, orderId: o.id, count: tickets.length, amount_cents: o.total_cents, currency: o.currency });
  if (!o.contact_id) return;
  const list = tickets.map((t) => `- ${t.type_name}: ${ticketUrl(app, t.token)} (Code ${t.code})`).join('\n');
  const body = `Hallo ${o.name.split(/\s+/)[0]},\n\ndeine Tickets für „${ev.name}“ am ${formatInTz(ev.starts_at, tz)} Uhr${ev.venue ? ` (${ev.venue})` : ''}:\n\n${list}\n\nAlle Tickets mit QR-Code: ${orderUrl(app, o)}\nZeig beim Einlass den QR-Code oder den Code.\n\nViele Grüße\n${app.location(o.location_id)?.name ?? ''}`;
  void sendToContact(app, o.location_id, { contactId: o.contact_id, channel: 'email', subject: `Deine Tickets: ${ev.name}`, body, source: 'Event-Tickets', purpose: 'transactional', ignoreDnd: true }).catch((e) => console.error('[tickets] mail', (e as Error).message));
}

/** Code (10 characters), full token or ticket link → the ticket of this sub-account. */
export function findTicket(app: App, locationId: string, raw: string) {
  let s = raw.trim();
  const m = s.match(/(?:code=|\/event-ticket\/)([A-Za-z0-9_-]+)/);
  if (m) s = m[1];
  const code = s.replace(/[^A-Za-z0-9_-]/g, '');
  if (code.length < 10) return undefined;
  const rows = app.db.all<any>('SELECT id, token FROM tix_tickets WHERE location_id = ? AND code = ? LIMIT 2', locationId, code.slice(0, 10).toUpperCase());
  const hit = rows.length === 1 ? rows[0] : rows.find((r) => r.token === code);
  return hit ? ticketById(app, hit.id) : undefined;
}

export const ticketById = (app: App, ticketId: string) =>
  app.db.get<any>(
    `SELECT t.*, y.name AS type_name, e.name AS event_name, e.starts_at, e.venue, o.name AS holder, o.email, o.status AS order_status
     FROM tix_tickets t JOIN tix_types y ON y.id = t.type_id JOIN tix_events e ON e.id = t.event_id JOIN tix_orders o ON o.id = t.order_id WHERE t.id = ?`,
    ticketId,
  );

/** Checks a ticket in once (a second scan answers "already" with the time). Unpaid or cancelled tickets are refused. */
export function checkIn(app: App, locationId: string, code: string, userId: string | null) {
  const t = findTicket(app, locationId, code);
  if (!t) throw notFound('Kein Ticket mit diesem Code');
  const out = { kind: 'event_ticket', ticket_id: t.id, code: t.code, name: t.holder, email: t.email, event: t.event_name, event_id: t.event_id, type: t.type_name, type_id: t.type_id, start_at: t.starts_at };
  if (t.status === 'held') throw new HttpError(409, `Nicht bezahlt: ${t.holder} – ${t.type_name}`);
  if (t.status !== 'valid') throw new HttpError(409, `Storniert: ${t.holder} – ${t.type_name}`);
  if (t.checked_in_at) return { ...out, status: 'already', checked_in_at: t.checked_in_at };
  const at = now();
  if (!app.db.run('UPDATE tix_tickets SET checked_in_at = ?, checked_in_by = ? WHERE id = ? AND checked_in_at IS NULL', at, userId, t.id).changes) {
    return { ...out, status: 'already', checked_in_at: ticketById(app, t.id).checked_in_at };
  }
  return { ...out, status: 'checked_in', checked_in_at: at };
}
