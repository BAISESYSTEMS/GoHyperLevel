import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { id, now, token } from '../core/util.js';
import { bookSlot, bookableCalendars, calLabel, checkSlots, freeDays, pickCalendar } from '../services/ai-booking.js';
import { getContact, logActivity, type Contact } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';
import { ymdInTz } from '../core/time.js';
import { agentFunctionResponse, bookedView, clientMessage, parseSlot, slotLabel, slotPicker, updateDataModel, type A2uiMessage } from '../services/a2ui.js';
import { fillLead, placeholder } from './ai-booking.js';

/**
 * A2UI in HyperLevel (docs/a2ui.md): interfaces an agent describes as A2UI 1.0 messages, drawn by our own renderer
 * (web/public/a2ui-renderer.js). The pilot is the appointment picker:
 * - website chat: when the bot looked up free times, its answer carries a picker (free times as chips, name and e-mail if missing,
 *   "Termin buchen"); a click books directly through the AI booking rules (modules/ai-booking.ts), the renderer asks before
 *   whether the chosen time is still free (callAgentFunction checkSlot);
 * - assistant: the result of ghl_booking_slots shows the same picker; the choice goes back to the agent as a message.
 * Surfaces are stored per chat message, so a reload shows the current state (booked or not).
 */

const recent = new Map<string, number[]>();
function limited(key: string, max = 20) {
  const t = Date.now();
  const list = (recent.get(key) ?? []).filter((x) => t - x < 60_000);
  list.push(t);
  recent.set(key, list);
  return list.length > max;
}

interface SurfaceRow {
  id: string;
  location_id: string;
  conversation_id: string;
  message_id: string;
  contact_id: string;
  kind: string;
  spec: string;
  data: string;
  status: string;
}

const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,79}$/u;
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i;

/** The picker for the chat bot's answer: the looked-up day, or the next free days of the calendar. */
export function chatPicker(app: App, locationId: string, contact: Contact, pick: { calendar_id: string; date?: string }): { messages: A2uiMessage[]; data: Record<string, unknown> } | null {
  const cal = pickCalendar(bookableCalendars(app, locationId), pick.calendar_id);
  if (!cal) return null;
  let days: { date: string; times: string[] }[] = [];
  if (pick.date) {
    try {
      const r = checkSlots(app, cal, pick.date);
      days = r.times.length ? [{ date: r.date, times: r.times }] : r.next;
    } catch {
      days = [];
    }
  }
  if (!days.length) days = freeDays(app, cal, ymdInTz(new Date(), cal.timezone), 7, 4, 3);
  if (!days.length) return null;
  const surfaceId = `booking_${token(8)}`;
  const messages = slotPicker({
    surfaceId,
    calendar: { id: cal.id, name: cal.name, duration: cal.duration },
    days,
    mode: 'book',
    askName: placeholder(contact),
    askEmail: !contact.email && !contact.phone,
  });
  return { messages, data: { calendar_id: cal.id } };
}

/** The picker under a result of ghl_booking_slots in the assistant (the choice goes back to the agent as a message). */
export function toolPicker(tool: string, out: any): A2uiMessage[] | null {
  if (tool !== 'ghl_booking_slots' || !out || typeof out !== 'object') return null;
  const surfaceId = `slots_${token(6)}`;
  if (out.calendar && Array.isArray(out.times)) {
    const days = out.times.length ? [{ date: String(out.date), times: out.times as string[] }] : ((out.next ?? []) as { date: string; times: string[] }[]);
    if (!days.length) return null;
    return slotPicker({ surfaceId, calendar: out.calendar, days, mode: 'choose' });
  }
  const cal = Array.isArray(out.calendars) ? out.calendars.find((c: any) => Array.isArray(c.days) && c.days.length) : null;
  return cal ? slotPicker({ surfaceId, calendar: cal, days: cal.days, mode: 'choose' }) : null;
}

export const a2uiModule: Module = {
  name: 'a2ui',
  migrations: [
    [
      '001-init',
      `CREATE TABLE a2ui_surfaces (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, spec TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX a2ui_surfaces_message ON a2ui_surfaces(message_id);`,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const attach = (locationId: string, o: { conversationId: string; messageId: string; contactId: string; kind: string; messages: A2uiMessage[]; data?: Record<string, unknown> }) => {
      const surfaceId = o.messages.find((m) => m.createSurface)?.createSurface.surfaceId;
      if (!surfaceId) return;
      db.insert('a2ui_surfaces', {
        id: surfaceId,
        location_id: locationId,
        conversation_id: o.conversationId,
        message_id: o.messageId,
        contact_id: o.contactId,
        kind: o.kind,
        spec: JSON.stringify(o.messages),
        data: JSON.stringify(o.data ?? {}),
        status: 'open',
        created_at: now(),
        updated_at: now(),
      });
    };
    /** The A2UI messages of chat messages (for the widget's message list). */
    const forMessages = (ids: string[]): Map<string, A2uiMessage[]> => {
      const out = new Map<string, A2uiMessage[]>();
      if (!ids.length) return out;
      const rows = db.all<SurfaceRow>(`SELECT * FROM a2ui_surfaces WHERE message_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at`, ...ids);
      for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), ...(JSON.parse(r.spec) as A2uiMessage[])]);
      return out;
    };
    /** The chat bot's answer was just sent: put the picker under it (modules/ai-assistant.ts → botTurn). */
    const attachChatPicker = (locationId: string, o: { conversationId: string; messageId: string; contact: Contact; pick: { calendar_id: string; date?: string } }) => {
      const p = chatPicker(app, locationId, o.contact, o.pick);
      if (p) attach(locationId, { conversationId: o.conversationId, messageId: o.messageId, contactId: o.contact.id, kind: 'booking', messages: p.messages, data: p.data });
    };
    app.services.a2ui = { attach, forMessages, attachChatPicker, toolPicker };

    // --- the website chat: clicks and questions from the renderer --------------------------------------------------------------
    router.post('/api/public/chat/:loc/a2ui', 'public', async (ctx) => {
      if (limited(ctx.ip)) throw new HttpError(429, 'Zu viele Anfragen – kurz warten');
      const visitor = db.get<{ contact_id: string; location_id: string }>('SELECT * FROM chat_visitors WHERE token = ? AND location_id = ?', String(ctx.body?.visitor ?? ''), ctx.params.loc);
      if (!visitor) throw notFound();
      const m = clientMessage(ctx.body?.message);
      if (!m) throw bad('Keine gültige A2UI-1.0-Nachricht (action oder callAgentFunction)');
      const surfaceId = m.kind === 'action' ? String(m.action.surfaceId) : String(m.call.surfaceId);
      const s = db.get<SurfaceRow>('SELECT * FROM a2ui_surfaces WHERE id = ? AND location_id = ? AND contact_id = ?', surfaceId, ctx.params.loc, visitor.contact_id);
      if (!s) throw notFound();
      const data = JSON.parse(s.data || '{}') as { calendar_id?: string };
      const cal = pickCalendar(bookableCalendars(app, s.location_id), data.calendar_id);
      const loc = s.location_id;

      if (m.kind === 'call') {
        const fn = m.call.callFunction ?? {};
        if (fn['@call'] !== 'checkSlot') return { message: agentFunctionResponse(m.call.functionCallId, { error: { code: 'INVALID_FUNCTION_CALL', message: 'Unbekannte Funktion' } }) };
        const slot = parseSlot(fn.args?.slot);
        if (!cal || !slot) return { message: agentFunctionResponse(m.call.functionCallId, { value: { available: false, message: '' } }) };
        let free = false;
        try {
          free = checkSlots(app, cal, slot.date).times.includes(slot.time);
        } catch {
          free = false;
        }
        return {
          message: agentFunctionResponse(m.call.functionCallId, {
            value: { available: free, message: free ? `${slotLabel(slot.date, slot.time)} ist frei.` : 'Diese Zeit ist gerade nicht mehr frei – bitte eine andere wählen.' },
          }),
        };
      }

      const say = (text: string) => ({ messages: [updateDataModel(s.id, '/status', text)] });
      if (m.action.name !== 'book_slot') return say('Diese Aktion gibt es nicht.');
      if (s.status === 'done') return say('Dieser Termin ist schon gebucht.');
      if (!cal) return say('Termine lassen sich hier gerade nicht buchen.');
      const c = m.action.context ?? {};
      const slot = parseSlot(c.slot);
      if (!slot) return say('Bitte zuerst eine Zeit wählen.');
      let contact = getContact(app, loc, visitor.contact_id);
      if (!contact) throw notFound();
      // Name and e-mail are taken over only when everything needed is there (a half-filled form changes nothing).
      const full = String(c.name ?? '').trim().replace(/\s+/g, ' ');
      const [first, ...rest] = full.split(' ');
      const email = String(c.email ?? '').trim();
      if (placeholder(contact) && !NAME.test(first ?? '')) return say('Bitte deinen Namen angeben.');
      if (!contact.email && !contact.phone && !EMAIL.test(email)) return say('Bitte eine gültige E-Mail-Adresse angeben.');
      contact = fillLead(app, loc, contact, { first_name: first ?? '', last_name: rest.join(' '), email });
      if (placeholder(contact) || (!contact.email && !contact.phone)) return say('Diese E-Mail-Adresse gehört schon zu einem anderen Kontakt – bitte schreib uns kurz im Chat.');
      const out = bookSlot(app, loc, { calendarId: cal.id, date: slot.date, time: slot.time, contact: { id: contact.id }, notes: 'Im Website-Chat über die Termin-Auswahl gebucht.', source: 'KI-Assistent' });
      if (!out.ok) return say(out.error);
      logActivity(app, loc, contact.id, 'ai.booked', `Termin über die Termin-Auswahl im Website-Chat gebucht: ${calLabel(cal)}`);
      // The choice and the confirmation land in the conversation, so the team sees what happened (no new bot turn).
      db.insert('messages', {
        id: id(),
        location_id: loc,
        conversation_id: s.conversation_id,
        contact_id: contact.id,
        channel: 'chat',
        direction: 'in',
        subject: '',
        body: `Termin gewählt: ${cal.name}, ${slotLabel(slot.date, slot.time)}`,
        status: 'received',
        error: '',
        source: 'Live-Chat',
        created_at: now(),
      });
      await sendToContact(app, loc, { contactId: contact.id, channel: 'chat', body: `🤖 ${out.confirmation}`, source: 'KI-Assistent' }).catch(() => undefined);
      const done = bookedView(s.id, `Gebucht: ${cal.name}, ${slotLabel(slot.date, slot.time)}. Die Bestätigung mit den Links zum Verschieben und Absagen steht im Chat.`);
      db.run(`UPDATE a2ui_surfaces SET status = 'done', spec = ?, updated_at = ? WHERE id = ?`, JSON.stringify([...(JSON.parse(s.spec) as A2uiMessage[]), ...done]), now(), s.id);
      return { messages: done, appointment_id: out.appointment.id };
    });
  },
};
