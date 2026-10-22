import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, num, type Ctx } from '../core/http.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { now } from '../core/util.js';
import { busyFor, computeSlots, type CalendarRow } from './calendars.js';
import { PUSH_KINDS } from './push.js';
import { peopleOf } from '../services/team-people.js';
import { hasConfig, getConfig, hostNames, membersOf, parseJsonSafe, pickHosts, saveConfig, setMembers, slotsOfDay } from '../services/teamcal-engine.js';
import { KINDS, KIND_LABEL, QUESTION_TYPES, VIDEO_LABEL, cleanConfig, needsTeamPage, type TeamCalConfig } from '../services/teamcal-model.js';
import { bookTeam, calendarById, cancelAppointment, completeHold, expireHolds, offerNext, rescheduleAppointment, resolvePendingLinks } from '../services/teamcal-book.js';
import { expireSession, holdBy } from '../services/teamcal-pay.js';
import { registerPayPurpose } from '../services/pay-registry.js';
import { track } from '../services/collab-actor.js';

/**
 * Team-Kalender: the types of a booking calendar – single, round robin (even or weighted, optimised for availability or for equal
 * distribution), collective (everybody must be free) and group / class (seats, waiting list) –, questions on the booking page,
 * pay when booking (Stripe), automatic video links, cancel / reschedule rules, and routing forms. This file owns the tables, the team's
 * routes and the small hooks the plain calendars call (modules/calendars.ts); the public pages are in teamcal-public.ts.
 */

const parse = parseJsonSafe;

export const teamCalModule: Module = {
  name: 'teamcal',
  migrations: [
    [
      '001-init',
      `
      ALTER TABLE appointments ADD COLUMN assignee_id TEXT;
      ALTER TABLE appointments ADD COLUMN host_ids TEXT;
      ALTER TABLE appointments ADD COLUMN meeting_url TEXT;
      ALTER TABLE appointments ADD COLUMN meeting_state TEXT NOT NULL DEFAULT '';
      ALTER TABLE appointments ADD COLUMN video_ref TEXT;
      ALTER TABLE appointments ADD COLUMN answers TEXT;
      ALTER TABLE appointments ADD COLUMN payment TEXT;
      ALTER TABLE appointments ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
      CREATE INDEX appointments_host ON appointments(location_id, assignee_id, start_at);
      CREATE INDEX appointments_pending_video ON appointments(meeting_state) WHERE meeting_state = 'pending';

      CREATE TABLE teamcal_config (
        calendar_id TEXT PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'single', data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE teamcal_members (
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        weight INTEGER NOT NULL DEFAULT 1, hours TEXT, position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (calendar_id, user_id)
      );
      CREATE TABLE teamcal_holds (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE, start_at TEXT NOT NULL, end_at TEXT NOT NULL, host_ids TEXT NOT NULL DEFAULT '[]',
        contact TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', answers TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}',
        session_id TEXT, session_url TEXT, payment_intent TEXT, amount_cents INTEGER NOT NULL, due_cents INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'EUR', mode TEXT NOT NULL DEFAULT 'full', status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT NOT NULL, appointment_id TEXT, invoice_id TEXT, created_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE INDEX teamcal_holds_cal ON teamcal_holds(calendar_id, status, start_at);
      CREATE INDEX teamcal_holds_due ON teamcal_holds(expires_at) WHERE status = 'pending';
      CREATE UNIQUE INDEX teamcal_holds_session ON teamcal_holds(session_id) WHERE session_id IS NOT NULL;
      CREATE TABLE teamcal_waitlist (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL, contact TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', answers TEXT NOT NULL DEFAULT '[]',
        token TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'waiting', appointment_id TEXT,
        offered_at TEXT, offer_expires_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX teamcal_waitlist_cal ON teamcal_waitlist(calendar_id, start_at, status);
      CREATE TABLE teamcal_routes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, question TEXT NOT NULL, intro TEXT NOT NULL DEFAULT '',
        options TEXT NOT NULL DEFAULT '[]', color TEXT NOT NULL DEFAULT '#2563eb', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    Object.assign(PUSH_KINDS, { booking: { label: 'Neue und geänderte Termine, bei denen ich Gastgeber bin', perm: 'calendars' } });

    // --- hooks the plain calendars call (modules/calendars.ts) ------------------------------------------------------
    /** Rules and hosts of a booking: payment and required questions can't be skipped through the old API; teams pick the host. */
    app.services.teamcalPrepare = (cal: CalendarRow, input: any, start: Date) => {
      if (!hasConfig(app, cal.id)) return undefined;
      const cfg = getConfig(app, cal.id);
      const tc = input.teamcal as { checked?: boolean; paid?: boolean; hostId?: string; answers?: boolean } | undefined;
      if (!tc) {
        // The public API and the old booking page: nothing that needs a payment or answers may go through here.
        const publicCaller = !input.source || input.source === 'Buchungsseite';
        if (publicCaller && cfg.payment.mode !== 'none') throw bad(`Dieser Termin ist kostenpflichtig – bitte über die Buchungsseite buchen: ${app.baseUrl()}/book/${cal.slug}`);
        if (publicCaller && cfg.questions.some((q) => q.required)) throw bad(`Bitte über die Buchungsseite buchen – es gibt Pflichtfragen: ${app.baseUrl()}/book/${cal.slug}`);
      }
      if (cfg.kind === 'single') return { extra: {}, checked: false };
      if (tc?.checked) return { extra: {}, checked: true };
      const picked = pickHosts(app, cal, cfg, start, { skipCheck: input.skipCheck, hostId: tc?.hostId });
      return { checked: true, extra: { assignee_id: picked.assignee, host_ids: picked.hosts } };
    };
    app.services.teamcalSlots = (cal: CalendarRow, ymd: string) => {
      if (!hasConfig(app, cal.id)) return undefined;
      const cfg = getConfig(app, cal.id);
      const d = slotsOfDay(app, cal, cfg, ymd);
      return d ? d.slots.map((s) => s.start) : undefined;
    };
    /** Template variables and the event payload of an appointment with hosts / a video link / answers. */
    const hostsOf = (a: any): { id: string; name: string }[] => {
      const ids = parse<string[]>(a.host_ids, []);
      return hostNames(app, ids.length ? ids : a.assignee_id ? [a.assignee_id] : []);
    };
    app.services.teamcalVars = (a: any) => {
      const hosts = hostsOf(a);
      return { host_name: hosts[0]?.name ?? '', host_names: hosts.map((h) => h.name).join(', '), meeting_url: a.meeting_url || '', answers_text: (parse<any[]>(a.answers, []) ?? []).map((x) => `${x.label}: ${x.value}`).join('\n') };
    };
    app.services.teamcalPayload = (a: any) => {
      const hosts = hostsOf(a);
      return { assignee_id: a.assignee_id ?? null, assignee_name: hosts[0]?.name ?? '', hosts, host_ids: undefined, meeting_url: a.meeting_url || '', answers: parse<any[]>(a.answers, []), payment: parse<any>(a.payment, null), video_ref: undefined };
    };
    app.services.appointmentRows = (rows: any[]) => rows.map((r) => ({ ...r, ...app.services.teamcalPayload(r) }));

    // Held slots block a plain calendar, too (the hooks of the iCal and OAuth sync are chained).
    const prevBusy = app.services.externalBusy;
    app.services.externalBusy = (cal: { id: string }, from: string, to: string) => [
      ...(prevBusy?.(cal, from, to) ?? []),
      ...db.all<{ start_at: string; end_at: string }>(`SELECT start_at, end_at FROM teamcal_holds WHERE calendar_id = ? AND status = 'pending' AND expires_at > ? AND end_at > ? AND start_at < ?`, cal.id, now(), from, to),
    ];

    /** Sessions of held bookings: paid → appointment, expired or failed → slot released. */
    app.services.stripeSessions = [
      ...(app.services.stripeSessions ?? []),
      (locationId: string, session: any, type: string) => {
        const holdId = session?.metadata?.teamcal_hold;
        if (!holdId) return undefined;
        const hold = holdBy(app, 'id', String(holdId));
        if (!hold || hold.location_id !== locationId) return { handled: 'ignored' };
        const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
        if (paid) track(app, completeHold(app, hold.id, session).then(() => undefined));
        else if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') db.run(`UPDATE teamcal_holds SET status = 'expired' WHERE id = ? AND status = 'pending'`, hold.id);
        return { handled: 'teamcal_hold' };
      },
    ];

    /** Holds paid through the payment registry (pay page: PayPal, Mollie, gift card …) – the same as a paid Stripe session. */
    registerPayPurpose(app, 'teamcal_hold', {
      settle: (_a, s) => completeHold(app, s.ref_id, { id: s.id, payment_intent: s.id }),
      lapse: (_a, s) => void db.run(`UPDATE teamcal_holds SET status = 'expired' WHERE id = ? AND status = 'pending'`, s.ref_id),
    });

    /** The cancel link of an appointment on a team calendar: the calendar's rules and refund apply. */
    app.services.teamcalCancel = (appt: any, ctx: Ctx) => {
      if (!hasConfig(app, appt.calendar_id)) return undefined;
      return cancelAppointment(app, appt, { by: 'customer', reason: String(ctx.body?.reason ?? '') });
    };

    // --- scheduler: released holds, video links that were still being made ----------------------------------------------
    app.onTick(async () => {
      for (const h of expireHolds(app)) {
        if (h.session_id) void expireSession(app, h.location_id, h.session_id);
        // The slot is free again for everybody; a waiting list gets its turn.
        const cal = calendarById(app, h.calendar_id);
        if (cal) track(app, offerNext(app, cal, getConfig(app, cal.id), h.start_at).catch(() => undefined));
      }
      await resolvePendingLinks(app);
    });

    // --- GDPR: a contact's data in holds and the waiting list ---------------------------------------------------------
    const byEmail = (table: string) => (_app: App, locationId: string, contact: { email?: string }) => {
      const email = String(contact.email ?? '').toLowerCase();
      return email ? db.all(`SELECT * FROM ${table} WHERE location_id = ? AND lower(json_extract(contact, '$.email')) = ?`, locationId, email) : [];
    };
    app.services.privacyExport = [...(app.services.privacyExport ?? []), (a: App, l: string, c: any) => ({ 'teamcal_holds (E-Mail)': byEmail('teamcal_holds')(a, l, c), 'teamcal_waitlist (E-Mail)': byEmail('teamcal_waitlist')(a, l, c) })];
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, l: string, c: { email?: string }) => {
        const email = String(c.email ?? '').toLowerCase();
        if (!email) return;
        for (const t of ['teamcal_holds', 'teamcal_waitlist']) db.run(`DELETE FROM ${t} WHERE location_id = ? AND lower(json_extract(contact, '$.email')) = ?`, l, email);
      },
    ];

    // --- the team's routes ------------------------------------------------------------------------------------------
    const calOf = (ctx: Ctx, cid = ctx.params.id): CalendarRow => {
      const cal = calendarById(app, cid);
      if (!cal || cal.location_id !== ctx.locationId) throw notFound('Kalender nicht gefunden');
      return cal;
    };
    const connections = (userId: string, calId?: string) => {
      const rows = db.all<{ id: string; provider: string; status: string }>(`SELECT id, provider, status FROM oauth_connections WHERE purpose = 'calendar' AND user_id = ?`, userId);
      const linked = calId ? new Set(db.all<{ connection_id: string }>('SELECT connection_id FROM oauth_calendar_links WHERE calendar_id = ?', calId).map((l) => l.connection_id)) : new Set<string>();
      return {
        google: rows.some((r) => r.provider === 'google' && r.status === 'ok'),
        microsoft: rows.some((r) => r.provider === 'microsoft' && r.status === 'ok'),
        linked: rows.some((r) => linked.has(r.id)),
      };
    };
    const summary = (ctx: Ctx, cal: CalendarRow) => {
      const cfg = getConfig(app, cal.id);
      return {
        id: cal.id,
        name: cal.name,
        slug: cal.slug,
        active: !!cal.active,
        url: `${app.baseUrl()}/book/${cal.slug}`,
        duration: cal.duration,
        timezone: cal.timezone,
        kind: cfg.kind,
        kind_label: KIND_LABEL[cfg.kind],
        members: membersOf(app, cal.id).map((m) => ({ user_id: m.user_id, name: m.name, weight: m.weight })),
        questions: cfg.questions.length,
        payment: cfg.payment.mode === 'none' ? null : { mode: cfg.payment.mode, amount_cents: cfg.payment.amount_cents, deposit_cents: cfg.payment.deposit_cents, currency: cfg.payment.currency },
        video: cfg.video,
        capacity: cfg.kind === 'group' ? cfg.capacity : undefined,
        waitlist: cfg.kind === 'group' ? cfg.waitlist : undefined,
      };
    };

    router.get('/api/team-calendars/types', 'location', (ctx) => db.all<any>('SELECT * FROM calendars WHERE location_id = ? ORDER BY name', ctx.locationId).map((r) => summary(ctx, calendarById(app, r.id)!)));

    router.get('/api/team-calendars/meta', 'location', (ctx) => ({
      kinds: KINDS.map((k) => [k, KIND_LABEL[k]]),
      video: Object.entries(VIDEO_LABEL),
      question_types: Object.entries(QUESTION_TYPES),
      stripe: !!app.services.stripeKey?.(ctx.locationId),
      zoom: !!app.services.connectorConfig?.(ctx.locationId, 'zoom'),
      google: !!app.services.oauth?.configured('google'),
      microsoft: !!app.services.oauth?.configured('microsoft'),
      people: peopleOf(app, ctx.locationId, 'calendars').map((p) => ({ id: p.id, name: p.name, email: p.email, ...connections(p.id), me: p.id === ctx.user?.id })),
    }));

    router.get('/api/team-calendars/:id', 'location', (ctx) => {
      const cal = calOf(ctx);
      const cfg = getConfig(app, cal.id);
      const members = membersOf(app, cal.id).map((m) => ({ ...m, connected: connections(m.user_id, cal.id) }));
      const pending = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM teamcal_holds WHERE calendar_id = ? AND status = 'pending' AND expires_at > ?`, cal.id, now())!.n;
      return { ...summary(ctx, cal), config: cfg, members, configured: hasConfig(app, cal.id), needs_team_page: needsTeamPage(cfg), pending_payments: pending, waiting: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM teamcal_waitlist WHERE calendar_id = ? AND status IN ('waiting', 'offered')`, cal.id)!.n };
    });

    router.put('/api/team-calendars/:id', 'location', (ctx) => {
      const cal = calOf(ctx);
      const b = ctx.body ?? {};
      const cur = getConfig(app, cal.id);
      const next: TeamCalConfig = b.config !== undefined ? cleanConfig(b.config, cur) : cur;
      const warnings: string[] = [];
      if (next.payment.mode !== 'none' && !app.services.stripeKey?.(ctx.locationId)) throw bad('Für Zahlung bei Buchung muss Stripe eingerichtet sein (Einstellungen → Stripe)');
      if (b.members !== undefined) setMembers(app, ctx.locationId, cal.id, b.members);
      const members = membersOf(app, cal.id);
      if ((next.kind === 'round_robin' || next.kind === 'collective') && !members.length) throw bad('Round Robin und Kollektiv brauchen mindestens eine Person');
      if (next.kind === 'collective' && members.length < 2) warnings.push('Ein Kollektiv-Termin mit nur einer Person verhält sich wie ein Einzeltermin.');
      if (next.video === 'zoom' && !app.services.connectorConfig?.(ctx.locationId, 'zoom')) warnings.push('Zoom ist noch nicht eingerichtet (Apps → Direkt-Verbindungen) – bis dahin gibt es keinen Link.');
      if (next.video === 'meet' || next.video === 'teams') {
        const want = next.video === 'meet' ? 'google' : 'microsoft';
        if (!members.some((m) => connections(m.user_id)[want === 'google' ? 'google' : 'microsoft'])) warnings.push(`${next.video === 'meet' ? 'Google Meet' : 'Microsoft Teams'} braucht eine verbundene ${next.video === 'meet' ? 'Google' : 'Outlook'}-Verbindung bei mindestens einem Gastgeber (Einstellungen → Mein Konto).`);
      }
      saveConfig(app, ctx.locationId, cal.id, next);
      return { ...summary(ctx, cal), config: getConfig(app, cal.id), members: membersOf(app, cal.id), warnings };
    });

    /** Links the calling person's connected calendars (busy times and their own appointments) with this booking calendar. */
    router.post('/api/team-calendars/:id/link-me', 'location', (ctx) => {
      const cal = calOf(ctx);
      const me = ctx.user;
      if (!me || ctx.viaApiKey) throw new HttpError(403, 'Das geht nur mit persönlicher Anmeldung');
      const rows = db.all<{ id: string }>(`SELECT id FROM oauth_connections WHERE purpose = 'calendar' AND user_id = ?`, me.id);
      if (!rows.length) throw bad('Du hast noch keinen Google- oder Outlook-Kalender verbunden (Einstellungen → Mein Konto)');
      for (const r of rows) {
        if (ctx.body?.link === false) db.run('DELETE FROM oauth_calendar_links WHERE connection_id = ? AND calendar_id = ?', r.id, cal.id);
        else db.run('INSERT OR IGNORE INTO oauth_calendar_links (connection_id, calendar_id, created_at) VALUES (?, ?, ?)', r.id, cal.id, now());
      }
      return { ok: true, linked: ctx.body?.link !== false };
    });

    /** Free times for the team (with hosts), e.g. before booking by hand or through MCP. */
    router.get('/api/team-calendars/:id/slots', 'location', (ctx) => {
      const cal = calOf(ctx);
      const cfg = getConfig(app, cal.id);
      const today = ymdInTz(new Date(), cal.timezone);
      const q = ctx.query.get('from') ?? '';
      let from = /^\d{4}-\d\d-\d\d$/.test(q) ? q : today;
      if (from < today) from = today;
      const days = Math.min(Math.max(num(ctx.query.get('days'), 7), 1), 31);
      const names = new Map(membersOf(app, cal.id).map((m) => [m.user_id, m.name]));
      const out = [];
      for (let i = 0; i < days; i++) {
        const d = addDaysYmd(from, i);
        const day = slotsOfDay(app, cal, cfg, d);
        out.push({ date: d, slots: day ? day.slots.map((s) => ({ start: s.start, hosts: s.hosts.map((h) => ({ id: h, name: names.get(h) ?? '' })), left: day.left[s.start] })) : plainSlots(cal, d), full: day?.full ?? [] });
      }
      return { calendar_id: cal.id, kind: cfg.kind, timezone: cal.timezone, duration: cal.duration, days: out };
    });
    const plainSlots = (cal: CalendarRow, ymd: string) => computeSlots(cal, ymd, busyFor(app, cal, ymd)).map((s) => ({ start: s, hosts: [], left: undefined }));

    /** Booking by the team: no consent box; paid calendars get a payment link unless the payment is waived. */
    router.post('/api/team-calendars/:id/book', 'location', async (ctx) => {
      const cal = calOf(ctx);
      const b = ctx.body ?? {};
      const r = await bookTeam(app, cal, { start: String(b.start ?? ''), first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, notes: b.notes, answers: b.answers, via: b.via, waitlist: b.waitlist === true }, { staff: true, payment: b.payment === 'waive' ? 'waive' : 'require', hostId: b.host_id ? String(b.host_id) : undefined, source: 'manuell' });
      return r;
    });

    router.post('/api/team-calendars/appointments/:id/cancel', 'location', async (ctx) => {
      const a = db.get<any>('SELECT * FROM appointments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!a) throw notFound();
      return cancelAppointment(app, a, { by: 'staff', reason: String(ctx.body?.reason ?? ''), refund: ctx.body?.refund === undefined ? undefined : ctx.body.refund === true });
    });
    router.post('/api/team-calendars/appointments/:id/reschedule', 'location', async (ctx) => {
      const a = db.get<any>('SELECT * FROM appointments WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!a) throw notFound();
      const next = await rescheduleAppointment(app, a, String(ctx.body?.start ?? ''), { by: 'staff' });
      return { ...next, ...app.services.teamcalPayload(next) };
    });

    router.get('/api/team-calendars/:id/waitlist', 'location', (ctx) => {
      const cal = calOf(ctx);
      return db.all<any>(`SELECT id, start_at, contact, status, offered_at, created_at FROM teamcal_waitlist WHERE calendar_id = ? AND status IN ('waiting', 'offered') ORDER BY start_at, created_at`, cal.id).map((w) => ({ ...w, contact: parse(w.contact, {}) }));
    });
    router.delete('/api/team-calendars/waitlist/:wid', 'location', (ctx) => {
      db.run(`UPDATE teamcal_waitlist SET status = 'cancelled' WHERE id = ? AND location_id = ?`, ctx.params.wid, ctx.locationId);
      return { ok: true };
    });

    // --- routing forms ("Wobei können wir helfen?") ---------------------------------------------------------------------
    const routeOut = (r: any) => ({ ...r, options: parse<any[]>(r.options, []), active: !!r.active, url: `${app.baseUrl()}/book/r/${r.slug}` });
    const cleanOptions = (v: unknown, locationId: string) => {
      if (!Array.isArray(v) || !v.length) throw bad('Mindestens eine Antwortmöglichkeit');
      if (v.length > 12) throw bad('Höchstens 12 Antwortmöglichkeiten');
      return v.map((o: any, i: number) => {
        const label = String(o?.label ?? '').trim().slice(0, 120);
        if (!label) throw bad('Jede Antwortmöglichkeit braucht einen Text');
        const calendar_id = String(o?.calendar_id ?? '');
        if (!db.get('SELECT 1 FROM calendars WHERE id = ? AND location_id = ?', calendar_id, locationId)) throw bad(`„${label}“: Kalender nicht gefunden`);
        return { id: /^[A-Za-z0-9_-]{2,30}$/.test(String(o?.id ?? '')) ? String(o.id) : `o${i + 1}${Math.random().toString(36).slice(2, 6)}`, label, calendar_id };
      });
    };
    const uniqueRouteSlug = (base: string, except?: string) => {
      const slug0 = base.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'anliegen';
      let slug = slug0;
      for (let i = 2; db.get('SELECT 1 FROM teamcal_routes WHERE slug = ? AND id != ?', slug, except ?? ''); i++) slug = `${slug0}-${i}`;
      return slug;
    };
    router.get('/api/team-routing', 'location', (ctx) => db.all('SELECT * FROM teamcal_routes WHERE location_id = ? ORDER BY name', ctx.locationId).map(routeOut));
    router.post('/api/team-routing', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const name = String(b.name ?? '').trim().slice(0, 120);
      if (!name) throw bad('Name fehlt');
      const row = {
        id: Math.random().toString(36).slice(2, 14) + Date.now().toString(36),
        location_id: ctx.locationId,
        name,
        slug: uniqueRouteSlug(String(b.slug || name)),
        question: String(b.question ?? 'Wobei können wir helfen?').trim().slice(0, 200) || 'Wobei können wir helfen?',
        intro: String(b.intro ?? '').trim().slice(0, 1000),
        options: cleanOptions(b.options, ctx.locationId),
        color: /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color : '#2563eb',
        active: 1,
        created_at: now(),
      };
      db.insert('teamcal_routes', row);
      return routeOut({ ...row, options: JSON.stringify(row.options) });
    });
    router.patch('/api/team-routing/:rid', 'location', (ctx) => {
      const cur = db.get<any>('SELECT * FROM teamcal_routes WHERE id = ? AND location_id = ?', ctx.params.rid, ctx.locationId);
      if (!cur) throw notFound();
      const b = ctx.body ?? {};
      const patch: Record<string, any> = {};
      if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 120) || cur.name;
      if (b.slug !== undefined) patch.slug = uniqueRouteSlug(String(b.slug), cur.id);
      if (b.question !== undefined) patch.question = String(b.question).trim().slice(0, 200) || cur.question;
      if (b.intro !== undefined) patch.intro = String(b.intro).trim().slice(0, 1000);
      if (b.options !== undefined) patch.options = cleanOptions(b.options, ctx.locationId);
      if (b.color !== undefined && /^#[0-9a-f]{6}$/i.test(b.color)) patch.color = b.color;
      if (b.active !== undefined) patch.active = b.active ? 1 : 0;
      db.update('teamcal_routes', cur.id, patch, ctx.locationId);
      return routeOut(db.get('SELECT * FROM teamcal_routes WHERE id = ?', cur.id));
    });
    router.delete('/api/team-routing/:rid', 'location', (ctx) => {
      db.run('DELETE FROM teamcal_routes WHERE id = ? AND location_id = ?', ctx.params.rid, ctx.locationId);
      return { ok: true };
    });

  },
};
