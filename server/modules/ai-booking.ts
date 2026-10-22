import type { App, Module } from '../core/app.js';
import { HttpError, bad, html, notFound, num, type Ctx } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { now } from '../core/util.js';
import { parseJson } from '../core/db.js';
import type { CalendarRow } from './calendars.js';
import type { Tool } from './mcp.js';
import { bookSlot, bookableCalendars, calLabel, checkSlots, cleanSettings, freeDays, loadSettings, pickCalendar, replyChannel, slotsBlock, type AiBookingSettings } from '../services/ai-booking.js';
import { getContact, logActivity, upsertContact, type Contact } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';
import { getConfig, hostNames } from '../services/teamcal-engine.js';
import { managePage } from '../services/teamcal-pages.js';

/**
 * AI books appointments directly in chat (docs/booking.md#ai-books-appointments). The phone agent's booking logic
 * (services/ai-booking.ts) as shared tools: `ghl_booking_slots` (free times) and `ghl_book_appointment` (book a free slot and confirm
 * it in the contact's channel with links to reschedule and cancel) for the HyperLevel Agent – they run without confirmation at the
 * agent's safety level "Termin buchen", also in auto-replies of every inbox channel – plus the website chat bot of the KI-Assistent
 * (hook `chatBotTurn`, switched on per sub-account). The page behind the reschedule link is `/book/move/<token>`.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const CHANNELS = ['email', 'sms', 'chat', 'whatsapp', 'messenger', 'instagram'];

export const BOOKING_TOOLS: Tool[] = [
  {
    name: 'ghl_booking_slots',
    title: 'Freie Termine nachsehen',
    description:
      'Freie Termine der Kalender, die für die KI freigegeben sind (dieselben Regeln wie Buchungsseite und KI-Telefonagent: Verfügbarkeit, Puffer, Vorlauf, Limits, belegte Zeiten aus Google/Outlook). Ohne calendar_id/date: die nächsten freien Zeiten je Kalender. Mit calendar_id und date (JJJJ-MM-TT): alle freien Zeiten des Tages – oder die nächsten Tage mit freien Zeiten. Uhrzeiten in der Zeitzone des Kalenders.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, calendar_id: { type: 'string' }, date: { type: 'string', description: 'JJJJ-MM-TT' }, days: { type: 'integer', minimum: 1, maximum: 14 } },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    booking: true,
    run: (call, a) => {
      const q = new URLSearchParams();
      for (const k of ['calendar_id', 'date', 'days'] as const) if (a[k] !== undefined && a[k] !== null && a[k] !== '') q.set(k, String(a[k]));
      return call.api('GET', `/api/ai-booking/slots${q.toString() ? `?${q}` : ''}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_book_appointment',
    title: 'Termin buchen',
    description:
      'Bucht einen freien Termin (aus ghl_booking_slots) für einen Kontakt – nur auf Kalendern, die für die KI freigegeben sind, nie kostenpflichtige oder mit Pflichtfragen. date = JJJJ-MM-TT, time = HH:MM in der Zeitzone des Kalenders. Erst buchen, wenn der Kontakt genau diese Zeit bestätigt hat. Der Kontakt bekommt die Bestätigung im Kanal, in dem er zuletzt geschrieben hat (oder channel), mit Links zum Verschieben und Absagen. Höchstens wenige Buchungen je Kontakt und Tag.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        calendar_id: { type: 'string' },
        contact_id: { type: 'string' },
        date: { type: 'string', description: 'JJJJ-MM-TT' },
        time: { type: 'string', description: 'HH:MM' },
        notes: { type: 'string', description: 'Anliegen in einem Satz' },
        channel: { type: 'string', enum: CHANNELS, description: 'Kanal der Bestätigung (Standard: der letzte Kanal des Kontakts)' },
      },
      required: ['location_id', 'calendar_id', 'contact_id', 'date', 'time'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    booking: true,
    run: (call, a) =>
      call.api('POST', '/api/ai-booking/book', {
        location: a.location_id,
        body: { calendar_id: a.calendar_id, contact_id: a.contact_id, date: a.date, time: a.time, notes: a.notes, channel: a.channel },
      }),
  },
];

const strProp = { type: 'string' };
/** The chat bot's answer schema plus the booking tool call. */
export function withBooking(schema: Record<string, any>) {
  return {
    ...schema,
    required: [...(schema.required ?? []), 'booking'],
    properties: {
      ...(schema.properties ?? {}),
      booking: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'calendar_id', 'date', 'time'],
        properties: { action: { type: 'string', enum: ['none', 'check_slots', 'book'] }, calendar_id: strProp, date: strProp, time: strProp },
      },
    },
  };
}

export const BOOKING_TASK = `Termine: Du darfst freie Termine nachsehen und buchen – über das Feld "booking":
- "action": "none" – kein Werkzeug (calendar_id, date, time leer lassen)
- "action": "check_slots" – freie Zeiten eines Tages nachsehen (calendar_id, date als JJJJ-MM-TT); du bekommst das Ergebnis und antwortest danach
- "action": "book" – einen Termin buchen (calendar_id, date, time als HH:MM). Nur eine Zeit aus den freien Terminen, erst wenn der Besucher genau diese Zeit bestätigt hat und Vor- und Nachname sowie E-Mail (oder Telefon) genannt hat – sonst zuerst danach fragen.
Nenne nie Zeiten, die nicht frei sind. Die Bestätigung mit den Links zum Verschieben und Absagen hängt das System an deine Antwort an – schreib in "reply" nur einen kurzen Satz dazu.`;

interface BookingCall {
  action: 'none' | 'check_slots' | 'book';
  calendar_id: string;
  date: string;
  time: string;
}

/** The model's JSON without the booking part (what the strict bot parser expects) and the booking call itself. */
export function splitBooking(raw: string): { rest: Record<string, any>; booking: BookingCall | null } | null {
  let v: any;
  try {
    v = JSON.parse(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { booking, ...rest } = v;
  const ok = booking && typeof booking === 'object' && ['none', 'check_slots', 'book'].includes(booking.action);
  return { rest, booking: ok ? { action: booking.action, calendar_id: String(booking.calendar_id ?? ''), date: String(booking.date ?? '').trim(), time: String(booking.time ?? '').trim() } : null };
}

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i;
const PHONE = /^\+?[\d][\d\s()/-]{4,24}$/;
const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,79}$/u;
const placeholder = (c: Contact) => !c.first_name || c.first_name === 'Website-Besucher';

/** Fills empty contact fields from what the visitor said (like the KI-Assistent's lead capture: never an e-mail another contact has). */
function fillLead(app: App, locationId: string, c: Contact, lead: Record<string, unknown>): Contact {
  const s = (k: string) => String(lead?.[k] ?? '').trim();
  const patch: Record<string, string> = {};
  if (s('first_name') && NAME.test(s('first_name')) && placeholder(c)) patch.first_name = s('first_name');
  if (s('last_name') && NAME.test(s('last_name')) && !c.last_name) patch.last_name = s('last_name');
  if (s('email') && EMAIL.test(s('email')) && !c.email) {
    const email = s('email').toLowerCase();
    if (!app.db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ? AND id <> ?', locationId, email, c.id)) patch.email = email;
  }
  if (s('phone') && PHONE.test(s('phone')) && !c.phone) patch.phone = s('phone');
  if (!Object.keys(patch).length) return c;
  return upsertContact(app, locationId, { id: c.id, ...patch }, { source: 'Live-Chat', publicInput: true }).contact;
}

type Ask = (user: string, schema: Record<string, unknown>) => Promise<{ text: string; [k: string]: unknown }>;

/** One turn of the website chat bot with the booking tool (up to three model calls: look up, then answer or book). */
export async function chatTurn(app: App, o: { locationId: string; contact: Contact; conversationId: string; prompt: string; schema: Record<string, any>; ask: Ask }) {
  const s = loadSettings(app, o.locationId);
  const cals = s.chat_bot ? bookableCalendars(app, o.locationId, s) : [];
  if (!cals.length) return o.ask(o.prompt, o.schema);
  const schema = withBooking(o.schema);
  let prompt = `${o.prompt}\n\n${slotsBlock(app, cals)}\n\n${BOOKING_TASK}`;
  let last: { text: string; [k: string]: unknown } | null = null;
  const tool = (text: string) =>
    (prompt += `\n\n<werkzeug_ergebnis>\n${text}\n</werkzeug_ergebnis>\nAntworte jetzt dem Besucher (booking.action "none" – oder "book", wenn er eine dieser Zeiten bestätigt hat).`);
  for (let round = 0; round < 3; round++) {
    const r = await o.ask(prompt, schema);
    const split = splitBooking(r.text);
    if (!split) return r;
    last = { ...r, text: JSON.stringify(split.rest) };
    const b = split.booking;
    if (!b || b.action === 'none') return last;
    const cal = pickCalendar(cals, b.calendar_id);
    if (!cal) {
      tool(`Kalender unbekannt. Erlaubt: ${cals.map((c) => `${c.name} (${c.id})`).join(', ')}`);
      continue;
    }
    if (b.action === 'check_slots') {
      try {
        tool(checkSlots(app, cal, b.date).text);
      } catch (e) {
        tool((e as Error).message);
      }
      continue;
    }
    // book: the visitor's name and e-mail (or phone) – said in this conversation – must be known.
    let contact = getContact(app, o.locationId, o.contact.id) ?? o.contact;
    contact = fillLead(app, o.locationId, contact, split.rest.lead ?? {});
    if (placeholder(contact) || (!contact.email && !contact.phone)) {
      tool('Buchung nicht möglich: Vorname und E-Mail-Adresse (oder Telefonnummer) des Besuchers fehlen – bitte zuerst danach fragen.');
      continue;
    }
    const out = bookSlot(
      app,
      o.locationId,
      { calendarId: cal.id, date: b.date, time: b.time, contact: { id: contact.id }, notes: 'Gebucht im Website-Chat vom KI-Assistenten.', source: 'KI-Assistent' },
      s,
    );
    if (!out.ok) {
      tool(out.text);
      continue;
    }
    logActivity(app, o.locationId, contact.id, 'ai.booked', `KI-Assistent hat im Website-Chat einen Termin gebucht: ${calLabel(cal)}`);
    const reply = [String(split.rest.reply ?? '').trim(), out.confirmation].filter(Boolean).join('\n\n').slice(0, 1500);
    const conf = typeof split.rest.confidence === 'number' ? split.rest.confidence : 1;
    return { ...r, text: JSON.stringify({ ...split.rest, reply, handoff: false, handoff_reason: '', confidence: Math.max(conf, 0.95) }), booked: out.appointment.id };
  }
  return last ?? o.ask(o.prompt, o.schema);
}

/** The page behind the reschedule link: the appointment page with the picker of free times open (works for every calendar). */
function movePage(app: App, a: any, cal: CalendarRow): string | null {
  if (!app.services.teamcalManagePage) return null;
  const hostIds: string[] = (() => {
    try {
      return a.host_ids ? JSON.parse(a.host_ids) : [];
    } catch {
      return [];
    }
  })();
  const hosts = hostNames(app, hostIds.length ? hostIds : a.assignee_id ? [a.assignee_id] : []).map((h) => h.name);
  const page = managePage(app, a, cal, getConfig(app, cal.id), hosts);
  const open = `<script>(function(){var b=document.getElementById('move');if(b)b.click();})();</script>`;
  return page.includes('</body>') ? page.replace('</body>', `${open}</body>`) : page + open;
}

export const aiBookingModule: Module = {
  name: 'ai-booking',
  migrations: [['001-init', `CREATE TABLE ai_booking_settings (location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);`]],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...BOOKING_TOOLS];
    app.services.aiBooking = {
      settings: (loc: string) => loadSettings(app, loc),
      calendars: (loc: string) => bookableCalendars(app, loc),
      book: (loc: string, r: Parameters<typeof bookSlot>[2]) => bookSlot(app, loc, r),
    };
    // The KI-Assistent's website chat bot asks here for every turn (modules/ai-assistant.ts → botTurn).
    app.services.chatBotTurn = (o: Parameters<typeof chatTurn>[1]) => chatTurn(app, o);
    // The HyperLevel Agent learns how to use the two tools when the sub-account released calendars for the AI.
    app.services.agentPromptExtras = [
      ...(app.services.agentPromptExtras ?? []),
      (i: { locationId: string }) =>
        bookableCalendars(app, i.locationId).length
          ? 'Termine buchen: Wenn jemand einen Termin möchte, sieh mit ghl_booking_slots freie Zeiten nach, biete zwei, drei davon an und buche erst nach einer klaren Zusage mit ghl_book_appointment (contact_id des Kontakts). Die Bestätigung mit Links zum Verschieben und Absagen schickt das System selbst.'
          : '',
    ];

    const settingsOut = (loc: string, s: AiBookingSettings) => {
      const bookable = new Set(bookableCalendars(app, loc, { ...s, calendars: [] }).map((c) => c.id));
      return {
        settings: s,
        calendars: db
          .all<{ id: string; name: string; active: number }>('SELECT id, name, active FROM calendars WHERE location_id = ? ORDER BY name', loc)
          .map((c) => ({ id: c.id, name: c.name, active: !!c.active, bookable: !!c.active && bookable.has(c.id) })),
      };
    };
    router.get('/api/ai-booking/settings', 'location', (ctx) => settingsOut(ctx.locationId, loadSettings(app, ctx.locationId)));
    router.put('/api/ai-booking/settings', 'location', (ctx) => {
      const next = cleanSettings(app, ctx.locationId, ctx.body ?? {}, loadSettings(app, ctx.locationId));
      db.run(
        `INSERT INTO ai_booking_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
        ctx.locationId,
        JSON.stringify(next),
        now(),
      );
      return settingsOut(ctx.locationId, next);
    });

    router.get('/api/ai-booking/slots', 'location', (ctx) => {
      const cals = bookableCalendars(app, ctx.locationId);
      if (!cals.length) return { calendars: [], hint: 'Für die KI ist kein Kalender freigegeben (KI-Assistent → Termine buchen).' };
      const calId = ctx.query.get('calendar_id');
      const date = ctx.query.get('date');
      if (calId || date) {
        const cal = pickCalendar(cals, calId);
        if (!cal) throw bad(`Kalender nicht freigegeben. Erlaubt: ${cals.map((c) => `${c.name} (${c.id})`).join(', ')}`);
        if (date) {
          const r = checkSlots(app, cal, date);
          return { calendar: { id: cal.id, name: cal.name, duration: cal.duration, timezone: cal.timezone }, date: r.date, times: r.times, next: r.next };
        }
      }
      const days = Math.min(Math.max(Math.round(num(ctx.query.get('days'), 7)), 1), 14);
      const list = calId ? cals.filter((c) => c.id === calId) : cals;
      return {
        calendars: list.map((c) => {
          const from = ymdInTz(new Date(), c.timezone);
          return { id: c.id, name: c.name, duration: c.duration, timezone: c.timezone, days: freeDays(app, c, from, days, 6, days), until: addDaysYmd(from, days - 1) };
        }),
      };
    });

    router.post('/api/ai-booking/book', 'location', async (ctx: Ctx) => {
      const b = ctx.body ?? {};
      const contact = getContact(app, ctx.locationId, String(b.contact_id ?? ''));
      if (!contact) throw bad('Kontakt nicht gefunden');
      const source = (ctx.via as string) === 'agent' ? 'KI-Agent' : 'KI-Buchung';
      const out = bookSlot(app, ctx.locationId, { calendarId: b.calendar_id, date: b.date, time: b.time, contact: { id: contact.id }, notes: typeof b.notes === 'string' ? b.notes : '', source });
      if (!out.ok) throw new HttpError(409, out.text);
      logActivity(app, ctx.locationId, contact.id, 'ai.booked', `${source === 'KI-Agent' ? 'KI-Agent' : 'KI'} hat einen Termin gebucht: ${calLabel(out.calendar)}`);
      let sent: string | null = null;
      const channel = b.confirm === false ? null : replyChannel(app, ctx.locationId, contact, b.channel);
      if (channel) {
        const send = app.services.channelSend as
          | undefined
          | ((loc: string, i: { contactId: string; channel: string; body: string; subject?: string; source?: string; ignoreDnd?: boolean }) => Promise<any>);
        const input = {
          contactId: contact.id,
          channel,
          body: out.confirmation,
          subject: channel === 'email' ? `Termin gebucht: ${out.calendar.name}` : undefined,
          source: 'KI-Terminbestätigung',
          ignoreDnd: true,
        };
        const m = await (send ? send(ctx.locationId, input) : sendToContact(app, ctx.locationId, { ...input, channel: channel as 'email' | 'sms' | 'chat' })).catch((e: Error) => ({
          status: 'failed',
          error: e.message,
        }));
        if (m && m.status !== 'failed') sent = channel;
      }
      const a = out.appointment;
      return {
        status: 'confirmed',
        appointment_id: a.id,
        calendar: { id: out.calendar.id, name: out.calendar.name },
        start_at: a.start_at,
        end_at: a.end_at,
        manage_url: out.manage_url,
        reschedule_url: out.reschedule_url,
        cancel_url: out.cancel_url,
        confirmation: out.confirmation,
        confirmed_via: sent,
        link: '/app/calendars',
      };
    });

    // --- the reschedule link -------------------------------------------------------------------------------------
    router.get('/book/move/:token', 'public', (ctx) => {
      const a = db.get<any>('SELECT * FROM appointments WHERE manage_token = ?', ctx.params.token);
      if (!a) return html(messagePage('Nicht gefunden', 'Diesen Termin gibt es nicht.'), 404);
      const cal = parseJson(db.get<CalendarRow>('SELECT * FROM calendars WHERE id = ?', a.calendar_id), ['availability', 'settings']);
      if (!cal) throw notFound();
      const page = movePage(app, a, cal);
      if (!page) return { __raw: true, status: 302, headers: { location: `/book/manage/${a.manage_token}` }, body: '' };
      return html(page);
    });
  },
};
