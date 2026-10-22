import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, num, str, type Ctx } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { isValidTz } from '../core/time.js';
import { centsToMoney, id, now, slugify } from '../core/util.js';
import { normalizeBookingSettings, todayOf } from '../services/booking-rules.js';
import { logActivity } from '../services/contacts.js';
import { notifyTeam } from '../services/messaging.js';
import { registerPayPurpose } from '../services/pay-registry.js';
import { availability, bookingOfAppointment, bookingOut, bookRental, calOfRental, expireHolds, quote, rentalOfCalendar, settleRental, type BookingRow, type RentalRow } from '../services/rentals-book.js';
import { HM, MAX_QUANTITY, MAX_UNITS, UNITS, rangeText, validYmd, type Unit } from '../services/rentals-model.js';
import { rentalBookingPage, rentalManagePage, rentalPaidPage } from '../services/rentals-page.js';
import { DEFAULT_SETTINGS, type CalendarRow } from './calendars.js';
import type { Tool } from './mcp.js';

/**
 * Vermietung (HighLevel "Rentals", docs/booking.md#rentals): bookable items with a quantity (3 e-bikes, 2 holiday flats) booked by
 * date range – per day or per night (check-in / check-out, same-day turnover), with minimum and maximum length, a price per
 * day/night and an optional deposit (Kaution) paid through the payment registry. Each item is a booking calendar of its own
 * (`settings.rental`), so a booking is an appointment from check-in to check-out: the calendar view shows it across the days, and
 * the confirmation e-mail, reminders, workflows and the contact's timeline are the calendar's. Rules in services/rentals-*.ts.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const q = (params: Record<string, unknown>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  return s.toString() ? `?${s}` : '';
};
const NOTE =
  'Daten sind JJJJ-MM-TT. unit=night (Übernachtung): from = Anreise, to = Abreise – Abreise und nächste Anreise am selben Tag gehen. unit=day (Tagesmiete): from = erster Tag, to = letzter Tag (einschließlich). Statt to geht days (Anzahl Tage/Nächte). Beträge in Cent.';

export const RENTAL_TOOLS: Tool[] = [
  {
    name: 'ghl_rental_availability',
    title: 'Vermietung: Angebote und freie Zeiträume',
    description: `Die Mietangebote eines Sub-Accounts (z. B. E-Bikes, Ferienwohnungen) mit Anzahl, Preis pro Tag/Nacht, Kaution, Mindest-/Höchstdauer und Buchungslink. Mit rental_id und from: die freien Stück je Tag (days, Standard 14) und – mit to oder days – das Angebot für genau diesen Zeitraum (ok, free, Preis, problem). ${NOTE}`,
    inputSchema: obj(
      {
        ...LOC,
        rental_id: { type: 'string', description: 'Nur dieses Angebot – mit freien Tagen' },
        from: { type: 'string', description: 'Erster Tag / Anreise, JJJJ-MM-TT' },
        to: { type: 'string', description: 'Abreise (Nacht) bzw. letzter Tag (Tag) – für ein Preisangebot' },
        days: { type: 'integer', minimum: 1, maximum: 62, description: 'Anzahl Tage/Nächte des Zeitraums (statt to)' },
        qty: { type: 'integer', minimum: 1, description: 'Wie viele Stück (Standard 1)' },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (!a.rental_id) return { rentals: await call.api('GET', '/api/rentals', { location: a.location_id }), link: '/app/calendars' };
      const base = `/api/rentals/${encodeURIComponent(a.rental_id)}`;
      const [rental, days] = await Promise.all([call.api('GET', base, { location: a.location_id }), call.api('GET', `${base}/availability${q({ from: a.from, days: 14 })}`, { location: a.location_id })]);
      const offer = a.from && (a.to || a.days) ? await call.api('GET', `${base}/quote${q({ from: a.from, to: a.to, days: a.to ? undefined : a.days, qty: a.qty })}`, { location: a.location_id }) : undefined;
      return { rental, availability: days, ...(offer ? { quote: offer } : {}), link: '/app/calendars' };
    },
  },
  {
    name: 'ghl_rental_book',
    title: 'Vermietung buchen',
    description: `Bucht ein Mietangebot für einen Zeitraum für einen Kontakt (contact_id, oder E-Mail und Vorname – der Kontakt wird angelegt oder zusammengeführt). Prüfe vorher mit ghl_rental_availability, ob genug frei ist. Der Kontakt bekommt die Bestätigung per E-Mail – frage vorher, ob das gewollt ist. Kostenpflichtige Angebote: Es entsteht eine Zahlungsseite (status payment_required, checkout_url an den Kontakt geben); die Buchung gilt erst nach der Zahlung, bis dahin ist der Zeitraum reserviert. payment=waive bucht ohne Online-Zahlung – nur auf ausdrücklichen Wunsch. ${NOTE}`,
    inputSchema: obj(
      {
        ...LOC,
        rental_id: { type: 'string', description: 'Mietangebot (aus ghl_rental_availability)' },
        from: { type: 'string' },
        to: { type: 'string' },
        days: { type: 'integer', minimum: 1 },
        qty: { type: 'integer', minimum: 1 },
        contact_id: { type: 'string', description: 'Vorhandener Kontakt (statt E-Mail/Name)' },
        email: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        phone: { type: 'string' },
        notes: { type: 'string' },
        payment: { type: 'string', enum: ['require', 'waive'], description: 'require (Standard): Zahlungsseite bei Preis > 0; waive: ohne Zahlung buchen' },
      },
      ['location_id', 'rental_id', 'from'],
    ),
    // Like ghl_book_slot: the contact gets an e-mail (and maybe a pay link) – the agent asks first.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (call, a) => {
      const { location_id, rental_id, ...body } = a;
      const r = await call.api('POST', `/api/rentals/${encodeURIComponent(rental_id)}/book`, { location: location_id, body });
      if (r.status === 'payment_required') return { ...r, hint: 'Den Link an den Kontakt geben – die Buchung gilt nach der Zahlung. Bis dahin ist der Zeitraum reserviert.', link: '/app/calendars' };
      return { status: r.status, booking: r.booking, appointment_id: r.appointment?.id, manage_url: r.manage_url, link: '/app/calendars' };
    },
  },
  {
    name: 'ghl_rental_save',
    title: 'Mietangebot anlegen oder ändern',
    description: `Legt ein Mietangebot an (ohne rental_id) oder ändert es: Name, Beschreibung, Anzahl (quantity), unit (day = pro Tag, night = pro Nacht), price_cents pro Tag/Nacht, deposit_cents (Kaution je Stück, optional), min_units/max_units (Mindest-/Höchstdauer), checkin_time/checkout_time (HH:MM), active. Jedes Angebot hat einen eigenen Buchungslink.`,
    inputSchema: obj(
      {
        ...LOC,
        rental_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        quantity: { type: 'integer', minimum: 1, maximum: MAX_QUANTITY },
        unit: { type: 'string', enum: UNITS },
        price_cents: { type: 'integer', minimum: 0 },
        deposit_cents: { type: 'integer', minimum: 0 },
        min_units: { type: 'integer', minimum: 1 },
        max_units: { type: 'integer', minimum: 0 },
        checkin_time: { type: 'string' },
        checkout_time: { type: 'string' },
        active: { type: 'boolean' },
      },
      ['location_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const { location_id, rental_id, ...body } = a;
      const r = rental_id ? await call.api('PATCH', `/api/rentals/${encodeURIComponent(rental_id)}`, { location: location_id, body }) : await call.api('POST', '/api/rentals', { location: location_id, body });
      return { ...r, link: '/app/calendars' };
    },
  },
];

const stamp = new Map<string, number[]>();
function throttled(ip: string, max = 15, windowMs = 10 * 60_000): boolean {
  const t = Date.now();
  const list = (stamp.get(ip) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  stamp.set(ip, list);
  if (stamp.size > 20_000) stamp.clear();
  return list.length > max;
}

/** Confirmation and reminder texts of a new item (editable in the calendar's settings). */
const RENTAL_SETTINGS = {
  confirmation_subject: 'Buchung bestätigt: {{calendar.name}}',
  confirmation_body:
    'Hallo {{contact.first_name|du}},\n\ndeine Buchung „{{calendar.name}}“ ist bestätigt:\n{{appointment.rental_text}}\nAbholung / Anreise: {{appointment.start_text}}\n{{appointment.rental_price}}\n{{calendar.meeting_location}}\n\nBuchung ansehen oder absagen: {{appointment.manage_url}}\n\nBis bald!\n{{location.name}}',
  reminder_subject: 'Erinnerung: {{calendar.name}} ab {{appointment.start_text}}',
  reminder_body: 'Hallo {{contact.first_name|du}},\n\nkurze Erinnerung an deine Buchung „{{calendar.name}}“:\n{{appointment.rental_text}}\nAbholung / Anreise: {{appointment.start_text}}\n{{calendar.meeting_location}}\n\nBuchung ansehen oder absagen: {{appointment.manage_url}}',
};

export const rentalsModule: Module = {
  name: 'rentals',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE rentals (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL UNIQUE REFERENCES calendars(id) ON DELETE CASCADE,
        quantity INTEGER NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT 'day', price_cents INTEGER NOT NULL DEFAULT 0,
        deposit_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', min_units INTEGER NOT NULL DEFAULT 1,
        max_units INTEGER NOT NULL DEFAULT 0, checkin_time TEXT NOT NULL DEFAULT '', checkout_time TEXT NOT NULL DEFAULT '',
        hold_minutes INTEGER NOT NULL DEFAULT 30, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX rentals_loc ON rentals(location_id);
      CREATE TABLE rental_bookings (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        rental_id TEXT NOT NULL REFERENCES rentals(id) ON DELETE CASCADE,
        appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        token TEXT NOT NULL UNIQUE, from_date TEXT NOT NULL, to_date TEXT NOT NULL, units INTEGER NOT NULL, qty INTEGER NOT NULL,
        rent_cents INTEGER NOT NULL DEFAULT 0, deposit_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'EUR', status TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '', pay_session_id TEXT, invoice_id TEXT, expires_at TEXT, created_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE INDEX rental_bookings_range ON rental_bookings(rental_id, from_date, to_date);
      CREATE INDEX rental_bookings_appt ON rental_bookings(appointment_id);
      CREATE INDEX rental_bookings_contact ON rental_bookings(contact_id);
      CREATE INDEX rental_bookings_due ON rental_bookings(expires_at) WHERE status = 'pending';
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...RENTAL_TOOLS];

    const load = (locationId: string, rid: string) => db.get<RentalRow>('SELECT * FROM rentals WHERE id = ? AND location_id = ?', rid, locationId);
    const loaded = (ctx: Ctx) => {
      const r = load(ctx.locationId, ctx.params.id);
      const cal = r && calOfRental(app, r);
      if (!r || !cal) throw notFound('Mietangebot nicht gefunden');
      return { r, cal };
    };
    const out = (r: RentalRow, cal: CalendarRow) => {
      const upcoming = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM rental_bookings b JOIN appointments a ON a.id = b.appointment_id WHERE b.rental_id = ? AND b.status = 'confirmed' AND a.status != 'cancelled' AND a.end_at > ?`,
        r.id, now(),
      )!.n;
      return {
        id: r.id,
        calendar_id: cal.id,
        name: cal.name,
        description: cal.description,
        slug: cal.slug,
        active: !!cal.active,
        color: cal.color,
        timezone: cal.timezone,
        max_days: cal.max_days,
        quantity: r.quantity,
        unit: r.unit,
        price_cents: r.price_cents,
        deposit_cents: r.deposit_cents,
        currency: r.currency,
        min_units: r.min_units,
        max_units: r.max_units,
        checkin_time: r.checkin_time,
        checkout_time: r.checkout_time,
        hold_minutes: r.hold_minutes,
        upcoming,
        url: `${app.baseUrl()}/book/rent/${cal.slug}`,
      };
    };
    const uniqueSlug = (base: string, except = '') => {
      const root = slugify(base) || 'mieten';
      let slug = root;
      for (let i = 2; db.get('SELECT id FROM calendars WHERE slug = ? AND id != ?', slug, except); i++) slug = `${root}-${i}`;
      return slug;
    };

    /** The item fields of a body, checked (`prev` = the stored item on a change). */
    function cleanRental(b: any, prev?: RentalRow): Partial<RentalRow> {
      const p: Partial<RentalRow> = {};
      const int = (v: unknown, label: string, lo: number, hi: number) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${label}: ganze Zahl von ${lo} bis ${hi}`);
        return n;
      };
      if (b.quantity !== undefined) p.quantity = int(b.quantity, 'Anzahl', 1, MAX_QUANTITY);
      if (b.unit !== undefined) {
        if (!UNITS.includes(b.unit)) throw bad('Abrechnung: day (pro Tag) oder night (pro Nacht)');
        p.unit = b.unit as Unit;
      }
      if (b.price_cents !== undefined) p.price_cents = int(b.price_cents, 'Preis', 0, 100_000_000);
      if (b.deposit_cents !== undefined) p.deposit_cents = int(b.deposit_cents ?? 0, 'Kaution', 0, 100_000_000);
      if (b.min_units !== undefined) p.min_units = int(b.min_units, 'Mindestdauer', 1, MAX_UNITS);
      if (b.max_units !== undefined) p.max_units = int(b.max_units ?? 0, 'Höchstdauer', 0, MAX_UNITS);
      if (b.hold_minutes !== undefined) p.hold_minutes = int(b.hold_minutes, 'Reservierung bis zur Zahlung (Minuten)', 10, 1440);
      for (const k of ['checkin_time', 'checkout_time'] as const) {
        if (b[k] === undefined) continue;
        const v = String(b[k] ?? '').trim();
        if (v && !HM.test(v)) throw bad(`${k === 'checkin_time' ? 'Abholung/Anreise' : 'Rückgabe/Abreise'}: Uhrzeit als HH:MM`);
        p[k] = v;
      }
      if (b.currency !== undefined) {
        const c = String(b.currency).toUpperCase();
        if (!/^[A-Z]{3}$/.test(c)) throw bad('Ungültige Währung');
        p.currency = c;
      }
      const min = p.min_units ?? prev?.min_units ?? 1;
      const max = p.max_units ?? prev?.max_units ?? 0;
      if (max && max < min) throw bad('Die Höchstdauer ist kürzer als die Mindestdauer');
      return p;
    }

    // --- the team's routes (area calendars) -----------------------------------------------------------------------------------
    router.get('/api/rentals', 'location', (ctx) =>
      db
        .all<RentalRow>('SELECT r.* FROM rentals r JOIN calendars c ON c.id = r.calendar_id WHERE r.location_id = ? ORDER BY c.name', ctx.locationId)
        .map((r) => out(r, calOfRental(app, r)!)),
    );
    router.get('/api/rentals/:id', 'location', (ctx) => {
      const { r, cal } = loaded(ctx);
      return out(r, cal);
    });
    router.post('/api/rentals', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const name = str(b.name, 'Name', { required: true, max: 120 });
      const tz = b.timezone || app.location(ctx.locationId)!.timezone;
      if (!isValidTz(tz)) throw bad('Unbekannte Zeitzone');
      const fields = cleanRental({ unit: 'day', quantity: 1, price_cents: 0, ...b });
      const t = now();
      const cal = {
        id: id(),
        location_id: ctx.locationId,
        name,
        slug: uniqueSlug(b.slug || name),
        description: str(b.description, 'Beschreibung', { max: 5000 }),
        duration: 1440,
        interval: 1440,
        buffer: 0,
        min_notice: 0,
        max_days: Math.min(Math.max(1, num(b.max_days, 365)), 730),
        // No weekly hours: the item is never offered as a time slot – only by date range (this module).
        availability: {},
        timezone: tz,
        color: /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color : '#0d9488',
        active: b.active === false ? 0 : 1,
        settings: normalizeBookingSettings({ ...DEFAULT_SETTINGS, ...RENTAL_SETTINGS, rental: true }, {}, todayOf({ timezone: tz })),
        created_at: t,
      };
      const row = { id: id(), location_id: ctx.locationId, calendar_id: cal.id, quantity: 1, unit: 'day' as Unit, price_cents: 0, deposit_cents: 0, currency: 'EUR', min_units: 1, max_units: 0, checkin_time: '', checkout_time: '', hold_minutes: 30, ...fields, created_at: t, updated_at: t };
      db.tx(() => {
        db.insert('calendars', cal);
        db.insert('rentals', row);
      });
      return out(row as RentalRow, calOfRental(app, row)!);
    });
    router.patch('/api/rentals/:id', 'location', (ctx) => {
      const { r, cal } = loaded(ctx);
      const b = ctx.body ?? {};
      const fields = cleanRental(b, r);
      const calPatch: Record<string, unknown> = {};
      if (b.name !== undefined) calPatch.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.description !== undefined) calPatch.description = str(b.description, 'Beschreibung', { max: 5000 });
      if (b.slug !== undefined && b.slug !== cal.slug) calPatch.slug = uniqueSlug(String(b.slug), cal.id);
      if (b.active !== undefined) calPatch.active = b.active ? 1 : 0;
      if (b.max_days !== undefined) calPatch.max_days = Math.min(Math.max(1, num(b.max_days, 365)), 730);
      if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) calPatch.color = b.color;
      db.tx(() => {
        if (Object.keys(fields).length) db.update('rentals', r.id, { ...fields, updated_at: now() });
        if (Object.keys(calPatch).length) db.update('calendars', cal.id, calPatch);
      });
      const next = load(ctx.locationId, r.id)!;
      return out(next, calOfRental(app, next)!);
    });
    router.delete('/api/rentals/:id', 'location', (ctx) => {
      const { r, cal } = loaded(ctx);
      const upcoming = out(r, cal).upcoming;
      // Deleting the item deletes its calendar and appointments: not while bookings are ahead, unless asked for explicitly.
      if (upcoming && ctx.query.get('force') !== '1') throw new HttpError(409, `Es gibt noch ${upcoming} anstehende Buchung(en) – erst absagen oder „Trotzdem löschen“`);
      db.run('DELETE FROM calendars WHERE id = ? AND location_id = ?', cal.id, ctx.locationId);
      return { ok: true };
    });
    router.get('/api/rentals/:id/availability', 'location', (ctx) => {
      const { r, cal } = loaded(ctx);
      const from = ctx.query.get('from') ?? '';
      return availability(app, r, cal, validYmd(from) ? from : todayOf(cal), Math.min(Math.max(num(ctx.query.get('days'), 14), 1), 62));
    });
    router.get('/api/rentals/:id/quote', 'location', (ctx) => {
      const { r, cal } = loaded(ctx);
      return quote(app, r, cal, { from: ctx.query.get('from'), to: ctx.query.get('to') ?? undefined, days: ctx.query.get('days') ?? undefined, qty: ctx.query.get('qty') ?? undefined });
    });
    router.get('/api/rentals/:id/bookings', 'location', (ctx) => {
      const { r } = loaded(ctx);
      const all = ctx.query.get('all') === '1';
      const rows = db.all<BookingRow & { appt_status: string | null; first_name: string | null; last_name: string | null; email: string | null }>(
        `SELECT b.*, a.status AS appt_status, c.first_name, c.last_name, c.email FROM rental_bookings b
         LEFT JOIN appointments a ON a.id = b.appointment_id LEFT JOIN contacts c ON c.id = b.contact_id
         WHERE b.rental_id = ? ${all ? '' : `AND b.to_date >= ? AND b.status IN ('pending', 'confirmed')`} ORDER BY b.from_date LIMIT 500`,
        r.id, ...(all ? [] : [todayOf(calOfRental(app, r)!)]),
      );
      return rows.map((b) => {
        const pending = b.status === 'pending' && !!b.expires_at && b.expires_at <= now();
        const c = b.contact_id ? { first_name: b.first_name, last_name: b.last_name, email: b.email } : JSON.parse(b.contact || '{}');
        return { ...bookingOut(b, r), status: pending ? 'expired' : b.status === 'confirmed' && b.appt_status === 'cancelled' ? 'cancelled' : b.status, contact: { first_name: c.first_name ?? '', last_name: c.last_name ?? '', email: c.email ?? '' } };
      });
    });
    router.post('/api/rentals/:id/book', 'location', (ctx) => {
      const { r, cal } = loaded(ctx);
      const b = ctx.body ?? {};
      const res = bookRental(app, r, cal, b, { staff: true, payment: b.payment === 'waive' ? 'waive' : 'require', source: ctx.via === 'mcp' ? 'KI-Agent' : 'manuell' });
      return res;
    });

    // --- public ---------------------------------------------------------------------------------------------------------------
    const publicOf = (slug: string) => {
      const row = db.get<any>('SELECT c.id FROM calendars c JOIN rentals r ON r.calendar_id = c.id WHERE c.slug = ? AND c.active = 1', slug);
      const r = row && rentalOfCalendar(app, row.id);
      const cal = r && calOfRental(app, r);
      if (!r || !cal) throw notFound('Dieses Angebot gibt es nicht (mehr)');
      return { r, cal };
    };
    router.get('/api/public/rentals/:slug', 'public', (ctx) => {
      const { r, cal } = publicOf(ctx.params.slug);
      const o = out(r, cal);
      const { upcoming: _u, hold_minutes: _h, calendar_id: _c, ...rest } = o;
      return { ...rest, company: app.location(cal.location_id)!.name, today: todayOf(cal) };
    });
    router.get('/api/public/rentals/:slug/availability', 'public', (ctx) => {
      const { r, cal } = publicOf(ctx.params.slug);
      const from = ctx.query.get('from') ?? '';
      return availability(app, r, cal, validYmd(from) ? from : todayOf(cal), Math.min(Math.max(num(ctx.query.get('days'), 14), 1), 62));
    });
    router.get('/api/public/rentals/:slug/quote', 'public', (ctx) => {
      const { r, cal } = publicOf(ctx.params.slug);
      return quote(app, r, cal, { from: ctx.query.get('from'), to: ctx.query.get('to') ?? undefined, days: ctx.query.get('days') ?? undefined, qty: ctx.query.get('qty') ?? undefined });
    });
    router.post('/api/public/rentals/:slug/book', 'public', (ctx) => {
      const { r, cal } = publicOf(ctx.params.slug);
      const b = ctx.body ?? {};
      if (String(b.website ?? '').trim()) throw bad('Das hat nicht geklappt – bitte noch einmal versuchen');
      if (throttled(ctx.ip)) throw new HttpError(429, 'Zu viele Buchungsversuche – bitte in ein paar Minuten noch einmal');
      const res = bookRental(app, r, cal, { from: b.from, to: b.to, days: b.days, qty: b.qty, first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, notes: b.notes, consent: b.consent === true });
      if (res.status === 'confirmed') app.services.attribution?.capture(ctx, cal.location_id, res.appointment.contact_id, 'booking', { attr: b._attr, page: b._page, params: b });
      return res.status === 'confirmed' ? { status: res.status, booking: res.booking, manage_url: res.manage_url, ics_url: res.ics_url } : { status: res.status, booking: res.booking, checkout_url: res.checkout_url, expires_at: res.expires_at, due_cents: res.due_cents, currency: res.currency };
    });
    router.get('/book/rent/:slug', 'public', (ctx) => {
      try {
        const { r, cal } = publicOf(ctx.params.slug);
        return html(rentalBookingPage(app, cal, r, ctx.query.get('embed') === '1'));
      } catch {
        return html(messagePage('Nicht gefunden', 'Dieses Angebot gibt es nicht (mehr).'), 404);
      }
    });
    router.get('/book/rent/paid/:token', 'public', (ctx) => {
      const b = db.get<BookingRow>('SELECT * FROM rental_bookings WHERE token = ?', ctx.params.token);
      const r = b && db.get<RentalRow>('SELECT * FROM rentals WHERE id = ?', b.rental_id);
      const cal = r && calOfRental(app, r);
      if (!b || !r || !cal) return html(messagePage('Nicht gefunden', 'Diese Buchung gibt es nicht.'), 404);
      const res = html(rentalPaidPage(app, cal, r, b, ctx.query.get('cancelled') === '1'));
      res.headers['cache-control'] = 'no-store';
      return res;
    });

    // --- the calendar's own pages and texts for items ----------------------------------------------------------------------------
    const prevPage = app.services.teamcalPage;
    app.services.teamcalPage = (cal: CalendarRow, embed: boolean, ctx: Ctx) => {
      const r = rentalOfCalendar(app, cal.id);
      return r ? rentalBookingPage(app, cal, r, embed) : prevPage?.(cal, embed, ctx);
    };
    const prevManage = app.services.teamcalManagePage;
    app.services.teamcalManagePage = (a: any, cal: CalendarRow, ctx: Ctx) => {
      const r = rentalOfCalendar(app, cal.id);
      return r ? rentalManagePage(app, a, cal, r, bookingOfAppointment(app, a.id)) : prevManage?.(a, cal, ctx);
    };
    /** The customer cancels through the booking's link: until the start; a paid booking is refunded by the team (it hears about it). */
    const prevCancel = app.services.teamcalCancel;
    app.services.teamcalCancel = (a: any, ctx: Ctx) => {
      const r = rentalOfCalendar(app, a.calendar_id);
      if (!r) return prevCancel?.(a, ctx);
      if (a.status === 'cancelled') return { ok: true };
      if (Date.parse(a.start_at) <= Date.now()) throw new HttpError(409, 'Die Mietzeit hat schon begonnen – bitte direkt melden');
      db.run(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`, a.id);
      const b = bookingOfAppointment(app, a.id);
      if (a.contact_id) logActivity(app, a.location_id, a.contact_id, 'appointment.status_changed', 'Buchung vom Kontakt abgesagt');
      app.events.emit(a.location_id, 'appointment.status_changed', { contactId: a.contact_id, appointment: { ...a, status: 'cancelled' }, status: 'cancelled', calendarId: a.calendar_id });
      const paid = b?.paid_at ? `\nBezahlt: ${centsToMoney(b.total_cents, b.currency)} – bitte die Erstattung veranlassen.` : '';
      void notifyTeam(app, a.location_id, `Buchung abgesagt: ${a.title}`, `${a.title} wurde vom Kontakt abgesagt.${b ? `\n${rangeText(r.unit, { from: b.from_date, to: b.to_date, units: b.units })}` : ''}${paid}`);
      return { ok: true };
    };
    /** {{appointment.rental_text}}, {{appointment.rental_qty}}, {{appointment.rental_price}} in the calendar's texts. */
    const prevVars = app.services.teamcalVars;
    app.services.teamcalVars = (a: any) => {
      const base = prevVars?.(a) ?? {};
      const b = a?.id ? bookingOfAppointment(app, a.id) : undefined;
      const r = b && db.get<RentalRow>('SELECT unit FROM rentals WHERE id = ?', b.rental_id);
      if (!b || !r) return base;
      const range = rangeText(r.unit, { from: b.from_date, to: b.to_date, units: b.units });
      const price = b.total_cents ? `Betrag: ${centsToMoney(b.total_cents, b.currency)}${b.deposit_cents ? ` (davon Kaution ${centsToMoney(b.deposit_cents, b.currency)})` : ''}${b.paid_at ? ' – bezahlt' : ''}` : '';
      return { ...base, rental_text: `${range}${b.qty > 1 ? ` · ${b.qty} Stück` : ''}`, rental_qty: b.qty, rental_price: price, rental_from: b.from_date, rental_to: b.to_date };
    };

    // --- payment, holds, privacy ------------------------------------------------------------------------------------------------
    registerPayPurpose(app, 'rental', {
      settle: (_a, s) => settleRental(app, s.ref_id),
      lapse: (_a, s) => void db.run(`UPDATE rental_bookings SET status = 'expired' WHERE id = ? AND status = 'pending'`, s.ref_id),
    });
    app.onTick(() => {
      expireHolds(app);
    });
    const byContact = (l: string, c: { id?: string; email?: string }) => {
      const email = String(c.email ?? '').toLowerCase();
      return db.all('SELECT * FROM rental_bookings WHERE location_id = ? AND (contact_id = ? OR (? != \'\' AND lower(json_extract(contact, \'$.email\')) = ?))', l, c.id ?? '', email, email);
    };
    app.services.privacyExport = [...(app.services.privacyExport ?? []), (_a: App, l: string, c: any) => ({ rental_bookings: byContact(l, c) })];
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, l: string, c: { id?: string; email?: string }) => {
        const email = String(c.email ?? '').toLowerCase();
        // The booking stays for the item's capacity and the books, the person's details go.
        db.run(`UPDATE rental_bookings SET contact = '{}', notes = '', contact_id = NULL WHERE location_id = ? AND (contact_id = ? OR (? != '' AND lower(json_extract(contact, '$.email')) = ?))`, l, c.id ?? '', email, email);
      },
    ];
  },
};
