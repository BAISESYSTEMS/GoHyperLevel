import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Handler, type Route } from '../core/http.js';
import { id, now, slugify } from '../core/util.js';
import type { Tool } from './mcp.js';
import { MIN_CENTS, registerPayPurpose } from '../services/pay-registry.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import { PURPOSE, cancelOrder, checkIn, eventOf, expireOrders, report, settleOrder, typesOf, typesWithState } from '../services/ticket-events-core.js';
import { cleanEvent, cleanTypes, type TicketEventRow } from '../services/ticket-events-model.js';

/**
 * Event tickets with ticket types (HighLevel "Events/Tickets" parity, docs/booking.md#ticket-types): an event (name, time, place)
 * has up to 20 ticket types – name, gross price (0 = free), quota, optional sale window and per-order limit. The public page
 * `/book/event/<slug>` (modules/ticket-events-public.ts) lets buyers pick types and quantities; paid orders go through the payment
 * registry, every ticket gets its own QR code and is checked in at the door by code – also through the appointment check-in
 * (`POST /api/appointment-checkin`, MCP `ghl_appointment_checkin`), which falls back to event tickets. Routes /api/ticket-events
 * (area calendars).
 */

const SQL = `
CREATE TABLE tix_events (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL, ends_at TEXT, currency TEXT NOT NULL DEFAULT 'EUR',
  tax_rate REAL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tix_events_loc ON tix_events(location_id, starts_at);
CREATE TABLE tix_types (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES tix_events(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL DEFAULT 0, quota INTEGER, sale_start TEXT, sale_end TEXT,
  max_per_order INTEGER, position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tix_types_event ON tix_types(event_id, position);
CREATE TABLE tix_orders (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, event_id TEXT NOT NULL REFERENCES tix_events(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, total_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', pay_session_id TEXT, invoice_id TEXT,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX tix_orders_event ON tix_orders(event_id, status);
CREATE INDEX tix_orders_pending ON tix_orders(status, expires_at);
CREATE INDEX tix_orders_contact ON tix_orders(contact_id);
CREATE TABLE tix_tickets (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, event_id TEXT NOT NULL REFERENCES tix_events(id) ON DELETE CASCADE,
  type_id TEXT NOT NULL REFERENCES tix_types(id), order_id TEXT NOT NULL REFERENCES tix_orders(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, checked_in_at TEXT, checked_in_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX tix_tickets_type ON tix_tickets(event_id, type_id, status);
CREATE INDEX tix_tickets_order ON tix_tickets(order_id);
CREATE INDEX tix_tickets_code ON tix_tickets(location_id, code);
`;

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const TYPE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Vorhandene Ticketart ändern (sonst neu)' },
    name: { type: 'string' },
    description: { type: 'string' },
    price_cents: { type: 'integer', description: 'Bruttopreis in Cent, 0 = kostenlos' },
    quota: { type: ['integer', 'null'], description: 'Kontingent (leer = unbegrenzt)' },
    sale_start: { type: ['string', 'null'], description: 'Verkaufsstart (ISO)' },
    sale_end: { type: ['string', 'null'], description: 'Verkaufsende (ISO; leer = bis Beginn)' },
    max_per_order: { type: ['integer', 'null'], description: 'Höchstens je Bestellung (1–20)' },
    active: { type: 'boolean' },
  },
  required: ['name'],
  additionalProperties: false,
};

export const TICKET_TOOLS: Tool[] = [
  {
    name: 'ghl_ticket_sales',
    title: 'Ticketverkauf je Ticketart',
    description: 'Ticketverkäufe der Events: je Ticketart verkauft, reserviert (Zahlung läuft), eingecheckt, Restkontingent, Umsatz und Verkaufsstatus. Ohne event_id alle Events (kommende zuerst), mit event_id nur dieses.',
    inputSchema: obj({ ...LOC, event_id: { type: 'string' } }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.event_id) return call.api('GET', `/api/ticket-events/${encodeURIComponent(a.event_id)}/report`, { location: a.location_id });
      return call.api('GET', '/api/ticket-events?report=1', { location: a.location_id });
    },
  },
  {
    name: 'ghl_ticket_event_save',
    title: 'Event mit Ticketarten anlegen oder ändern',
    description:
      'Legt ein Ticket-Event an (ohne event_id) oder ändert es: Name, Beginn (ISO), Ort, Beschreibung, Währung, Ticketarten (Name, Bruttopreis in Cent, Kontingent, Verkaufsfenster, Höchstzahl je Bestellung). Mit types wird die ganze Liste gesetzt; Ticketarten mit verkauften Tickets lassen sich nur deaktivieren. Antwort enthält den öffentlichen Link.',
    inputSchema: obj(
      { ...LOC, event_id: { type: 'string' }, name: { type: 'string' }, starts_at: { type: 'string' }, ends_at: { type: ['string', 'null'] }, venue: { type: 'string' }, description: { type: 'string' }, currency: { type: 'string' }, active: { type: 'boolean' }, types: { type: 'array', items: TYPE_SCHEMA } },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const { location_id, event_id, ...body } = a;
      const r = event_id ? await call.api('PATCH', `/api/ticket-events/${encodeURIComponent(event_id)}`, { location: location_id, body }) : await call.api('POST', '/api/ticket-events', { location: location_id, body });
      return { ...r, link: '/app/calendars' };
    },
  },
  {
    name: 'ghl_event_ticket_checkin',
    title: 'Event-Ticket einchecken',
    description: 'Checkt ein Event-Ticket per Code (10 Zeichen vom Ticket oder der Ticket-Link) ein und nennt Ticketart und Inhaber. Ein zweiter Check-in meldet, wann schon eingecheckt wurde; unbezahlte oder stornierte Tickets werden abgewiesen.',
    inputSchema: obj({ ...LOC, code: { type: 'string' } }, ['location_id', 'code']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', '/api/ticket-events/checkin', { location: a.location_id, body: { code: a.code } }),
  },
];

const TRIGGERS: TriggerMeta[] = [
  {
    type: 'tickets.ordered',
    label: 'Event-Tickets bestellt',
    category: 'payments',
    summary: 'Eine Ticketbestellung für ein Event ist bestätigt (kostenlos sofort, bezahlt nach Zahlungseingang).',
    doc: 'Startet, wenn eine Ticketbestellung bestätigt ist. {{event.count}} ist die Zahl der Tickets, {{event.amount_cents}} der Betrag in Cent, {{event.eventId}} das Event. Typisch: Tag „Teilnehmer“ setzen, einen Tag vorher erinnern.',
    fields: [],
    sample: { eventId: 'ev1', orderId: 'o1', count: 2, amount_cents: 5000, currency: 'EUR' },
    keywords: 'event ticket tickets bestellung veranstaltung teilnehmer kauf',
  },
];

export const ticketEventsModule: Module = {
  name: 'ticket-events',
  migrations: [['001-init', SQL]],
  register(app: App) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TICKET_TOOLS];
    registerPayPurpose(app, PURPOSE, {
      settle: (_a, s, received) => settleOrder(app, s, received),
      lapse: (_a, s) => cancelOrder(app, s.ref_id, 'cancelled'),
    });
    registerTriggers(app, TRIGGERS);
    app.onTick(() => void expireOrders(app));

    const publicUrl = (ev: TicketEventRow) => `${app.baseUrl()}/book/event/${ev.slug}`;
    const out = (ev: TicketEventRow, withReport = false) => ({ ...ev, active: !!ev.active, url: publicUrl(ev), types: typesWithState(app, ev).map((t) => ({ ...t, active: !!t.active })), ...(withReport ? { report: report(app, ev) } : {}) });
    const mine = (locationId: string, eventId: string) => {
      const ev = eventOf(app, locationId, eventId);
      if (!ev) throw notFound('Event nicht gefunden');
      return ev;
    };
    const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
    const slugFor = (raw: unknown, name: string, except = '') => {
      if (raw) {
        const s = String(raw).trim().toLowerCase();
        if (!SLUG.test(s)) throw bad('Kurzname: nur a–z, 0–9 und Bindestrich (bis 60 Zeichen)');
        if (db.get('SELECT 1 FROM tix_events WHERE slug = ? AND id != ?', s, except)) throw new HttpError(409, 'Dieser Kurzname ist schon vergeben');
        return s;
      }
      const base = slugify(name).slice(0, 50);
      let s = base;
      for (let i = 2; db.get('SELECT 1 FROM tix_events WHERE slug = ? AND id != ?', s, except); i++) s = `${base}-${i}`;
      return s;
    };

    /** Sets the event's whole list of types: changes kept ones, adds new ones, removes the rest – unless they sold tickets. */
    const saveTypes = (ev: TicketEventRow, list: unknown) => {
      const types = cleanTypes(list, MIN_CENTS);
      const existing = new Map(typesOf(app, ev.id).map((t) => [t.id, t]));
      const keep = new Set(types.map((t) => t.id).filter(Boolean));
      for (const old of existing.values()) {
        if (keep.has(old.id)) continue;
        if (db.get('SELECT 1 FROM tix_tickets WHERE type_id = ? LIMIT 1', old.id)) throw new HttpError(409, `„${old.name}“ hat schon Tickets – statt löschen bitte deaktivieren`);
        db.run('DELETE FROM tix_types WHERE id = ?', old.id);
      }
      const t0 = now();
      types.forEach((t, position) => {
        const { id: tid, ...fields } = t;
        if (tid && !existing.has(tid)) throw bad('Unbekannte Ticketart');
        // Sold tickets keep the price they were sold for (tix_tickets.price_cents); a new price applies to new orders.
        if (tid) db.update('tix_types', tid, { ...fields, position, updated_at: t0 });
        else db.insert('tix_types', { id: id(), event_id: ev.id, location_id: ev.location_id, ...fields, position, created_at: t0, updated_at: t0 });
      });
    };

    router.get('/api/ticket-events', 'location', (ctx) => {
      const withReport = ctx.query.get('report') === '1';
      const rows = db.all<TicketEventRow>('SELECT * FROM tix_events WHERE location_id = ? ORDER BY CASE WHEN starts_at >= ? THEN 0 ELSE 1 END, starts_at LIMIT 200', ctx.locationId, now());
      return rows.map((ev) => out(ev, withReport));
    });
    router.get('/api/ticket-events/:id', 'location', (ctx) => out(mine(ctx.locationId, ctx.params.id), true));
    router.post('/api/ticket-events', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const fields = cleanEvent(b);
      const t0 = now();
      const ev = { id: id(), location_id: ctx.locationId, slug: slugFor(b.slug, fields.name!), currency: 'EUR', description: '', venue: '', ends_at: null, tax_rate: null, active: 1, ...fields, created_at: t0, updated_at: t0 } as TicketEventRow;
      db.tx(() => {
        db.insert('tix_events', ev);
        if (b.types !== undefined) saveTypes(ev, b.types);
      });
      return out(eventOf(app, ctx.locationId, ev.id)!, true);
    });
    router.patch('/api/ticket-events/:id', 'location', (ctx) => {
      const ev = mine(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      const fields = cleanEvent(b, true);
      if (fields.currency && fields.currency !== ev.currency && db.get('SELECT 1 FROM tix_orders WHERE event_id = ? LIMIT 1', ev.id)) throw new HttpError(409, 'Die Währung lässt sich nach den ersten Bestellungen nicht mehr ändern');
      const start = fields.starts_at ?? ev.starts_at;
      const end = fields.ends_at !== undefined ? fields.ends_at : ev.ends_at;
      if (end && Date.parse(end) < Date.parse(start)) throw bad('Das Ende liegt vor dem Beginn');
      db.tx(() => {
        db.update('tix_events', ev.id, { ...fields, ...(b.slug !== undefined ? { slug: slugFor(b.slug, fields.name ?? ev.name, ev.id) } : {}), updated_at: now() }, ctx.locationId);
        if (b.types !== undefined) saveTypes(ev, b.types);
      });
      return out(eventOf(app, ctx.locationId, ev.id)!, true);
    });
    router.delete('/api/ticket-events/:id', 'location', (ctx) => {
      const ev = mine(ctx.locationId, ctx.params.id);
      if (db.get(`SELECT 1 FROM tix_tickets WHERE event_id = ? AND status IN ('held', 'valid') LIMIT 1`, ev.id)) throw new HttpError(409, 'Für dieses Event gibt es schon Tickets – statt löschen bitte deaktivieren');
      db.run('DELETE FROM tix_events WHERE id = ? AND location_id = ?', ev.id, ctx.locationId);
      return { ok: true };
    });
    router.get('/api/ticket-events/:id/report', 'location', (ctx) => report(app, mine(ctx.locationId, ctx.params.id)));
    router.get('/api/ticket-events/:id/tickets', 'location', (ctx) => {
      const ev = mine(ctx.locationId, ctx.params.id);
      const rows = db.all<any>(
        `SELECT t.id, t.code, t.status, t.checked_in_at, t.price_cents, y.name AS type, o.name, o.email, o.created_at AS ordered_at
         FROM tix_tickets t JOIN tix_types y ON y.id = t.type_id JOIN tix_orders o ON o.id = t.order_id
         WHERE t.event_id = ? AND t.status = 'valid' ORDER BY o.name, y.position LIMIT 5000`,
        ev.id,
      );
      return { event_id: ev.id, tickets: rows };
    });
    router.post('/api/ticket-events/checkin', 'location', (ctx) => checkIn(app, ctx.locationId, str(ctx.body?.code, 'Code', { required: true, max: 300 }), ctx.user?.id ?? null));

    // The door scanner of appointment tickets also takes event tickets: an unknown appointment code is tried as an event ticket.
    router.wrappers.push((route: Route, next: Handler): Handler => {
      if (route.method !== 'POST' || route.pattern !== '/api/appointment-checkin') return next;
      return async (ctx) => {
        try {
          return await next(ctx);
        } catch (e) {
          if (!(e instanceof HttpError) || e.status !== 404) throw e;
          const code = String(ctx.body?.code ?? '');
          try {
            return checkIn(app, ctx.locationId, code, ctx.user?.id ?? null);
          } catch (e2) {
            if (e2 instanceof HttpError && e2.status === 404) throw e;
            throw e2;
          }
        }
      };
    });

    // DSGVO: orders are exported with the contact; erasing keeps the counts but removes name and e-mail.
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, c: { id: string }) => ({
        event_ticket_orders: db.all<any>('SELECT o.id, e.name AS event, o.status, o.total_cents, o.currency, o.created_at, o.paid_at FROM tix_orders o JOIN tix_events e ON e.id = o.event_id WHERE o.location_id = ? AND o.contact_id = ?', loc, c.id),
      }),
    ];
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, c: { id: string }) => void db.run(`UPDATE tix_orders SET name = 'Gelöscht', email = '', contact_id = NULL WHERE location_id = ? AND contact_id = ?`, loc, c.id),
    ];
  },
};
