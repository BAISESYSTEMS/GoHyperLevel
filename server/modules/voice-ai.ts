import type { LocationRow, Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, num, text, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { addDaysYmd, formatInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { id, normalizeEmail, normalizePhone, now } from '../core/util.js';
import { SUMMARY_SCHEMA, contactBlock, nowLine, parseSummary, redactSecrets } from '../services/ai-context.js';
import { contactName, contactVars, getContact, logActivity, upsertContact, type Contact } from '../services/contacts.js';
import { notifyTeam, sendToContact } from '../services/messaging.js';
import { createOpportunity, getPipeline } from '../services/opportunities.js';
import { isOpen, twiml, usableNumber, voicemailTwiml } from '../services/twilio.js';
import {
  OUTCOMES,
  SUMMARY_TASK_VOICE,
  VOICES,
  VOICE_SCHEMA,
  cleanVoiceSettings,
  dialogue,
  fillerTwiml,
  gatherTwiml,
  parseVoiceOutput,
  resolveOutcome,
  sayHangup,
  sayWith,
  shouldAnswer,
  slotLines,
  speakable,
  spokenWhen,
  transferTwiml,
  voiceTask,
  withVoiceDefaults,
  type Turn,
  type VoiceAction,
  type VoiceAiSettings,
  type VoiceArgs,
  type VoiceOutput,
} from '../services/voice-ai.js';
import type { PhoneReply, VoiceBrain } from '../services/voice-types.js';
import { bookAppointment, type CalendarRow } from './calendars.js';
import { freeDays as sharedFreeDays } from '../services/ai-booking.js';
import { finalizeCall, syncMessage, telephonyConfig, verifyTwilio, type DialTargets, type VoiceAgentInput } from './telephony.js';

/**
 * KI-Telefonagent: Claude answers inbound calls (always, outside business hours or when nobody picks
 * up). Twilio <Gather input="speech"> turns the caller's words into text, the module asks Claude (via
 * app.services.aiRun – monthly limit and log of the KI-Assistent, its knowledge base as system prompt)
 * for a short spoken answer plus at most one tool call (book an appointment, take a message, task,
 * opportunity, SMS with the booking link, transfer to a person, end the call), executes the tool
 * after strict validation and speaks the answer with the next <Gather>. The state of every call lives
 * in voice_ai_sessions. Afterwards: summary on the call, note + timeline on the contact, workflow
 * trigger "KI-Anruf beendet" with the outcome, e-mail/push to the team.
 */

export const VOICE_TRIGGER = 'voice_ai.completed';
const SOURCE = 'KI-Telefonagent';
/** Safety net against call floods: AI-answered calls per sub-account and hour. */
const HOURLY_CALL_CAP = 30;
/** Model calls per caller turn (answer + one follow-up after a tool result). */
const MAX_HOPS = 2;
/** How long a webhook waits for Claude before playing a filler (Twilio gives up after 15 s). Tests lower it. */
export const voiceTiming = { replyMs: 9000, waitMs: 10000 };

type Session = Record<string, any> & { transcript: Turn[]; actions: { type: string; ok: boolean; detail: string; at: string }[]; outcomes: string[] };

const TIMEOUT = Symbol('timeout');
function race<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(TIMEOUT)),
    );
  });
}


export const voiceAiModule: Module = {
  name: 'voice-ai',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE voice_ai_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE voice_ai_sessions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE, call_sid TEXT NOT NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, from_number TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
        turns INTEGER NOT NULL DEFAULT 0, silences INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, ai_calls INTEGER NOT NULL DEFAULT 0,
        transcript TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', outcomes TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT '', end_reason TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '', appointment_id TEXT, task_id TEXT, opportunity_id TEXT,
        transfer_status TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL, last_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE UNIQUE INDEX voice_ai_sessions_sid ON voice_ai_sessions(location_id, call_sid);
      CREATE INDEX voice_ai_sessions_started ON voice_ai_sessions(location_id, started_at);
      CREATE INDEX voice_ai_sessions_open ON voice_ai_sessions(ended_at, last_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), VOICE_TRIGGER];

    // --- settings -----------------------------------------------------------------
    const load = (locId: string): VoiceAiSettings => withVoiceDefaults(parseJson(db.get('SELECT data FROM voice_ai_settings WHERE location_id = ?', locId), ['data'])?.data);
    const allowedCalendars = (locId: string, s: VoiceAiSettings): CalendarRow[] =>
      parseRows(db.all<CalendarRow>('SELECT * FROM calendars WHERE location_id = ? AND active = 1 ORDER BY name', locId), ['availability', 'settings'])
        .filter((c) => !s.calendar_ids.length || s.calendar_ids.includes(c.id))
        .slice(0, 3);

    // --- sessions -------------------------------------------------------------------
    const readSession = (row: any): Session | undefined => (row ? (parseJson(row, ['transcript', 'actions', 'outcomes']) as Session) : undefined);
    const sessionBySid = (locId: string, sid: string | undefined) => (sid ? readSession(db.get('SELECT * FROM voice_ai_sessions WHERE location_id = ? AND call_sid = ?', locId, sid)) : undefined);
    const sessionById = (sesId: string) => readSession(db.get('SELECT * FROM voice_ai_sessions WHERE id = ?', sesId));
    const save = (ses: Session, patch: Record<string, unknown>) => {
      Object.assign(ses, patch);
      db.update('voice_ai_sessions', ses.id, { ...patch, last_at: now() });
    };
    const say = (ses: Session, role: Turn['role'], line: string) => {
      if (!line.trim()) return;
      save(ses, { transcript: [...ses.transcript, { role, text: redactSecrets(line.trim()).slice(0, 2000), at: now() }] });
    };
    const record = (ses: Session, type: string, ok: boolean, detail: string, outcome?: string) =>
      save(ses, {
        actions: [...ses.actions, { type, ok, detail: detail.slice(0, 500), at: now() }],
        ...(ok && outcome && !ses.outcomes.includes(outcome) ? { outcomes: [...ses.outcomes, outcome] } : {}),
      });
    const getCall = (callId: string) => db.get('SELECT * FROM calls WHERE id = ?', callId);
    const callerPhone = (ses: Session) => normalizePhone(usableNumber(ses.from_number));

    /** Who can take a transfer: the fixed number, or the ring group of the telephony (mobiles + browser phones). */
    const transferTargets = (loc: LocationRow, s: VoiceAiSettings, call: any): DialTargets => {
      if (s.transfer_number) return { numbers: [s.transfer_number], clients: [] };
      const cfg = telephonyConfig(app, loc.id);
      return app.services.voiceDialTargets?.({ locationId: loc.id, call, forward: cfg.forward }) ?? { numbers: cfg.forward, clients: [] };
    };

    // --- the agent takes the call (hook from telephony) ---------------------------------
    app.services.voiceAgent = (input: VoiceAgentInput): string | undefined => {
      const { loc, call, stage, open } = input;
      const s = load(loc.id);
      if (!input.force && (stage === 'outbound' || !shouldAnswer(s.mode, stage, open))) return undefined;
      if (db.get('SELECT id FROM voice_ai_sessions WHERE location_id = ? AND call_sid = ?', loc.id, call.sid)) return undefined;
      const problem: string | null = app.services.aiReady ? app.services.aiReady(loc.id) : 'KI-Assistent fehlt';
      if (problem) {
        console.warn(`[voice-ai] ${loc.id}: nimmt nicht ab – ${problem}`);
        return undefined;
      }
      const lastHour = db.get<{ n: number }>('SELECT COUNT(*) n FROM voice_ai_sessions WHERE location_id = ? AND started_at > ?', loc.id, new Date(Date.now() - 3600_000).toISOString())!.n;
      if (lastHour >= HOURLY_CALL_CAP) return undefined;
      const t = now();
      const contact = call.contact_id ? getContact(app, loc.id, call.contact_id) : undefined;
      // Outbound calls (modules/voice-outbound.ts) bring their own opening line.
      const greeting = speakable(render(input.greeting || s.greeting, { location: loc, contact: contactVars(contact) }), 500);
      const ses: Session = {
        id: id(),
        location_id: loc.id,
        call_id: call.id,
        call_sid: call.sid,
        contact_id: call.contact_id ?? null,
        from_number: input.party ?? call.from_number ?? '',
        stage,
        status: 'active',
        transcript: [{ role: 'agent', text: greeting, at: t }],
        actions: [],
        outcomes: [],
        started_at: t,
        last_at: t,
      };
      db.insert('voice_ai_sessions', ses);
      db.run(`UPDATE calls SET answered = 1, answered_at = ?, status = 'in-progress', reason = 'ai', updated_at = ? WHERE id = ?`, t, t, call.id);
      syncMessage(app, getCall(call.id)!);
      if (call.contact_id) logActivity(app, loc.id, call.contact_id, 'call.ai_started', stage === 'outbound' ? 'KI-Telefonagent ruft an – Kontakt hat abgenommen' : 'KI-Telefonagent hat den Anruf angenommen');
      // The voice layer (modules/voice-phone.ts) may carry the call with the sub-account's own voice and speech recognition.
      const own: string | undefined = app.services.voiceTransport?.({ loc, call, sessionId: ses.id, greeting });
      return own ?? gatherTwiml({ say: greeting, voice: s.voice, action: `${hook('voice-ai', loc.id)}?t=0` });
    };

    const gather = (loc: string, s: VoiceAiSettings, ses: Session, line: string) => gatherTwiml({ say: line, voice: s.voice, action: `${hook('voice-ai', loc)}?t=${ses.turns}` });
    /** Replies with every delivery the transports need (see PhoneReply). */
    const listen = (loc: string, s: VoiceAiSettings, ses: Session, line: string): PhoneReply => ({ say: line, then: 'listen', twiml: gather(loc, s, ses, line), next: '' });
    const hangUp = (s: VoiceAiSettings, line: string): PhoneReply => ({ say: line, then: 'hangup', twiml: sayHangup(line, s.voice), next: sayHangup('', s.voice) });

    /** Ends the call from our side; finalizeCall fires call.completed, which finishes the session. */
    const endCall = (ses: Session, reason: string) => {
      save(ses, { end_reason: reason, status: 'closing' });
      const call = getCall(ses.call_id);
      if (!call) return;
      const secs = call.answered_at ? (Date.now() - Date.parse(call.answered_at)) / 1000 : 0;
      finalizeCall(app, call, 'completed', { duration: secs });
    };

    /** Something broke (Claude down, budget used up, nonsense twice): the caller gets the voicemail. */
    const fallback = (loc: LocationRow, s: VoiceAiSettings, ses: Session, error: string): PhoneReply => {
      console.warn(`[voice-ai] ${loc.id}: Voicemail statt KI – ${error}`);
      save(ses, { end_reason: 'error', error: error.slice(0, 500), status: 'fallback' });
      record(ses, 'fallback', true, error);
      const call = getCall(ses.call_id);
      const cfg = telephonyConfig(app, loc.id);
      db.run(`UPDATE calls SET answered = 0, answered_at = NULL, status = 'ringing', reason = 'ai_error', updated_at = ? WHERE id = ?`, now(), ses.call_id);
      const line = `Entschuldigung, ich habe gerade eine technische Störung. ${cfg.s.voicemail ? 'Bitte hinterlassen Sie nach dem Signalton Ihren Namen, Ihre Nummer und Ihr Anliegen – wir rufen zurück.' : 'Bitte rufen Sie später noch einmal an.'}`;
      say(ses, 'agent', line);
      if (!cfg.s.voicemail) {
        if (call) finalizeCall(app, getCall(ses.call_id)!, 'missed', { reason: 'ai_error' });
        return hangUp(s, line);
      }
      // Telephony's recording hook stores it as the call's voicemail (call.voicemail → session ends).
      const vm = voicemailTwiml({ greeting: '', record: true, maxLength: cfg.s.max_length, action: hook('voice-recording', loc.id), transcribe: cfg.s.transcribe });
      return { say: line, then: 'voicemail', twiml: vm.replace('<Response>', `<Response>${sayWith(line, s.voice)}`), next: vm };
    };

    // --- prompt context --------------------------------------------------------------
    // The free times are the shared booking logic (services/ai-booking.ts) – the chat bot and the agents' auto-replies ask the same.
    const freeDays = (cal: CalendarRow, from: string, days: number, perDay: number, maxDays: number) => sharedFreeDays(app, cal, from, days, perDay, maxDays);
    const calLabel = (c: CalendarRow) => `Kalender „${c.name}“ (calendar_id: ${c.id}, ${c.duration} Minuten, Zeitzone ${c.timezone})`;
    const slotsBlock = (cals: CalendarRow[]) => {
      const parts = cals.map((c) => {
        const lines = slotLines(freeDays(c, ymdInTz(new Date(), c.timezone), 14, 4, 5));
        return `${calLabel(c)}:\n${lines || 'in den nächsten 14 Tagen nichts frei'}`;
      });
      return `<freie_termine>\n${parts.join('\n\n')}\nWeitere Zeiten eines Tages liefert "check_slots".\n</freie_termine>`;
    };
    const STAGE_TEXT: Record<string, string> = { inbound: 'der Agent nimmt Anrufe direkt an', unanswered: 'niemand aus dem Team konnte abnehmen', outbound: 'DU rufst an (ausgehender Anruf) – der Kontakt hat abgenommen' };
    const DONE_TYPES = ['book_appointment', 'take_message', 'create_task', 'create_opportunity', 'send_booking_link', 'transfer_done'];
    const callBlock = (ses: Session, s: VoiceAiSettings, tools: VoiceAction[]) => {
      const done = ses.actions.filter((a) => a.ok && DONE_TYPES.includes(a.type)).map((a) => a.detail);
      const lines = [
        `Anrufer-Nummer: ${callerPhone(ses) || 'unterdrückt'}`,
        `Angenommen, weil: ${STAGE_TEXT[ses.stage] ?? STAGE_TEXT.unanswered}`,
        `Gesprächsrunde ${ses.turns} von höchstens ${s.max_turns}`,
        done.length ? `Schon erledigt: ${done.join('; ')}` : '',
        !tools.includes('transfer') ? 'Weiterverbinden: nicht möglich – gerade ist niemand erreichbar. Biete stattdessen an, eine Nachricht aufzunehmen.' : '',
      ].filter(Boolean);
      return `<anruf>\n${lines.join('\n')}\n</anruf>`;
    };
    const pipelineFor = (locId: string, s: VoiceAiSettings) => (s.pipeline_id ? getPipeline(app, locId, s.pipeline_id) : undefined);
    const toolsFor = (loc: LocationRow, s: VoiceAiSettings, ses: Session, cals: CalendarRow[]): VoiceAction[] => {
      const t: VoiceAction[] = ['none'];
      if (s.booking && cals.length) t.push('check_slots', 'book_appointment');
      t.push('take_message');
      if (s.tasks) t.push('create_task');
      if (pipelineFor(loc.id, s)) t.push('create_opportunity');
      if (s.sms_link && cals.length && callerPhone(ses)) t.push('send_booking_link');
      if (s.transfer && ses.transfer_status !== 'failed') {
        const tg = transferTargets(loc, s, getCall(ses.call_id));
        if (tg.numbers.length || tg.clients.length) t.push('transfer');
      }
      t.push('end_call');
      return t;
    };
    const promptFor = (loc: LocationRow, s: VoiceAiSettings, ses: Session, tools: VoiceAction[], cals: CalendarRow[], toolResult?: string) => {
      const contact = ses.contact_id ? getContact(app, loc.id, ses.contact_id) : undefined;
      const cfg = telephonyConfig(app, loc.id);
      // Extra context other modules add per call, e.g. the goal and script of an outbound call (app.services.voicePromptExtras).
      const extras = ((app.services.voicePromptExtras ?? []) as ((ses: Record<string, any>) => string | undefined)[]).map((fn) => fn(ses) ?? '');
      return [
        callBlock(ses, s, tools),
        ...extras,
        contactBlock(contact),
        tools.includes('book_appointment') ? slotsBlock(cals) : '',
        toolResult ? `<werkzeug_ergebnis>\n${toolResult}\n</werkzeug_ergebnis>` : '',
        dialogue(ses.transcript),
        nowLine(loc.timezone, isOpen(cfg.s.hours_mode, cfg.s.hours, loc.timezone)),
        voiceTask(s, loc.name, tools),
      ]
        .filter(Boolean)
        .join('\n\n');
    };
    const conversationOf = (locId: string, contactId: string | null) => (contactId ? (db.get('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', locId, contactId)?.id ?? null) : null);
    const askClaude = async (loc: LocationRow, s: VoiceAiSettings, ses: Session, tools: VoiceAction[], cals: CalendarRow[], toolResult?: string) => {
      const r = await app.services.aiRun({
        locationId: loc.id,
        purpose: 'voice_agent',
        user: promptFor(loc, s, ses, tools, cals, toolResult),
        schema: VOICE_SCHEMA,
        maxTokens: 1500,
        contactId: ses.contact_id,
        conversationId: conversationOf(loc.id, ses.contact_id),
      });
      save(ses, { ai_calls: (ses.ai_calls ?? 0) + 1 });
      return parseVoiceOutput(r.text, tools);
    };

    // --- tools ---------------------------------------------------------------------------
    /** Names/e-mail the caller gave: fills empty contact fields (never overwrites), creates a contact if there is none. */
    const applyLead = (loc: LocationRow, ses: Session, a: VoiceArgs): Contact | undefined => {
      let contact = ses.contact_id ? getContact(app, loc.id, ses.contact_id) : undefined;
      const patch: Record<string, string> = {};
      if (a.first_name && !contact?.first_name) patch.first_name = a.first_name;
      if (a.last_name && !contact?.last_name) patch.last_name = a.last_name;
      if (a.email && !contact?.email) {
        const email = normalizeEmail(a.email);
        if (!db.get('SELECT id FROM contacts WHERE location_id = ? AND email = ? AND id <> ?', loc.id, email, contact?.id ?? '')) patch.email = email;
      }
      if (!Object.keys(patch).length) return contact;
      if (!contact && !patch.first_name && !patch.last_name) return contact;
      contact = upsertContact(app, loc.id, contact ? { id: contact.id, ...patch } : { ...patch, phone: callerPhone(ses) }, { source: SOURCE }).contact;
      if (!ses.contact_id) attachContact(ses, contact.id);
      return contact;
    };
    const attachContact = (ses: Session, contactId: string) => {
      save(ses, { contact_id: contactId });
      db.run('UPDATE calls SET contact_id = ? WHERE id = ? AND contact_id IS NULL', contactId, ses.call_id);
      syncMessage(app, getCall(ses.call_id)!);
    };
    const newTask = (locId: string, contactId: string | null, title: string, description: string) => {
      const taskId = id();
      db.insert('tasks', { id: taskId, location_id: locId, contact_id: contactId, title: title.slice(0, 200), description: description.slice(0, 4000), due_at: now(), assigned_to: null, done: 0, created_at: now() });
      return taskId;
    };
    const pickCalendar = (cals: CalendarRow[], calendarId: string) => cals.find((c) => c.id === calendarId) ?? (cals.length === 1 || !calendarId ? cals[0] : undefined);

    interface Step {
      /** Final reply (transfer, hang-up) – skips the normal "say + listen". */
      reply?: PhoneReply;
      /** What to say before the next <Gather>. */
      line?: string;
      /** Tool result the model has to see before it can answer. */
      followUp?: string;
    }

    const runTool = async (loc: LocationRow, s: VoiceAiSettings, ses: Session, out: VoiceOutput, cals: CalendarRow[]): Promise<Step> => {
      const a = out.args;
      const contact = applyLead(loc, ses, a);
      const who = contact ? contactName(contact) : callerPhone(ses) || 'Anrufer';
      switch (out.action) {
        case 'none':
          return { line: out.say };
        case 'check_slots': {
          const cal = pickCalendar(cals, a.calendar_id);
          if (!cal) return { followUp: `Kalender unbekannt. Erlaubt: ${cals.map((c) => `${c.name} (${c.id})`).join(', ')}` };
          const day = freeDays(cal, a.date, 1, 16, 1)[0];
          const next = day ? [] : freeDays(cal, addDaysYmd(a.date, 1), 14, 4, 3);
          record(ses, 'check_slots', true, `Freie Zeiten am ${a.date} nachgesehen`);
          return {
            followUp: day
              ? `Freie Zeiten in ${calLabel(cal)}:\n${slotLines([day])}`
              : `Am ${a.date} ist in ${calLabel(cal)} nichts frei.${next.length ? ` Nächste freie Tage:\n${slotLines(next)}` : ' In den 14 Tagen danach auch nicht.'}`,
          };
        }
        case 'book_appointment': {
          const cal = pickCalendar(cals, a.calendar_id);
          if (!cal) return { followUp: `Buchung nicht möglich: Kalender unbekannt. Erlaubt: ${cals.map((c) => `${c.name} (${c.id})`).join(', ')}` };
          if (!contact?.first_name && !contact?.last_name && !a.first_name && !a.last_name) return { followUp: 'Buchung nicht möglich: Der Name des Anrufers fehlt – bitte erst nach Vor- und Nachnamen fragen.' };
          if (ses.outcomes.includes('booked') && ses.actions.filter((x) => x.type === 'book_appointment' && x.ok).length >= 2) return { followUp: 'Buchung nicht möglich: In diesem Anruf wurden schon zwei Termine gebucht. Weitere Wünsche bitte als Nachricht aufnehmen.' };
          const start = zonedToUtc(a.date, a.time, cal.timezone);
          try {
            const appt = bookAppointment(app, cal, {
              start: start.toISOString(),
              contact: contact ? { id: contact.id } : { first_name: a.first_name, last_name: a.last_name, email: a.email, phone: callerPhone(ses) },
              notes: [a.message && `Anliegen: ${a.message}`, `Gebucht am Telefon vom ${SOURCE}.`].filter(Boolean).join('\n'),
              source: SOURCE,
              // What a caller says is not proven: a known e-mail address must not get this caller's number.
              publicInput: true,
            });
            if (!ses.contact_id && appt.contact_id) attachContact(ses, appt.contact_id);
            const when = spokenWhen(appt.start_at, cal.timezone);
            save(ses, { appointment_id: appt.id });
            record(ses, 'book_appointment', true, `Termin gebucht: ${cal.name}, ${formatInTz(appt.start_at, cal.timezone)}`, 'booked');
            const booked = getContact(app, loc.id, appt.contact_id);
            let sms = false;
            // Only to the number that is calling (never to a contact matched by a claimed e-mail).
            if (s.booking_sms && booked?.phone && booked.phone === callerPhone(ses)) {
              sms = true;
              void sendToContact(app, loc.id, {
                contactId: booked.id,
                channel: 'sms',
                body: `Ihr Termin bei ${loc.name}: ${formatInTz(appt.start_at, cal.timezone, { weekday: 'long' })} Uhr (${cal.name}). Verwalten oder absagen: ${app.baseUrl()}/book/manage/${appt.manage_token}`,
                source: SOURCE,
                ignoreDnd: true,
              }).catch(() => undefined);
            }
            return { line: `Ich habe Ihren Termin eingetragen: ${when}.${sms ? ' Sie bekommen gleich eine SMS mit den Details.' : ''} Kann ich sonst noch etwas für Sie tun?` };
          } catch (e) {
            const msg = e instanceof HttpError && e.status === 409 ? 'Dieser Termin ist leider nicht (mehr) frei.' : (e as Error).message;
            record(ses, 'book_appointment', false, `Buchung ${a.date} ${a.time} fehlgeschlagen: ${msg}`);
            const day = freeDays(cal, a.date, 7, 6, 2);
            return { followUp: `Buchung fehlgeschlagen: ${msg}${day.length ? ` Freie Zeiten in ${calLabel(cal)}:\n${slotLines(day)}` : ''}` };
          }
        }
        case 'take_message': {
          const message = `${ses.message ? `${ses.message}\n` : ''}${a.message}`.slice(0, 3000);
          let taskId = ses.task_id;
          if (s.tasks && !taskId) taskId = newTask(loc.id, contact?.id ?? null, `Rückruf: ${who}${callerPhone(ses) ? ` (${callerPhone(ses)})` : ''}`, `Nachricht an den ${SOURCE}:\n${a.message}`);
          else if (taskId) db.run('UPDATE tasks SET description = ? WHERE id = ?', `Nachricht an den ${SOURCE}:\n${message}`, taskId);
          save(ses, { message, task_id: taskId ?? null });
          record(ses, 'take_message', true, `Nachricht notiert: ${a.message.slice(0, 160)}`, 'message');
          return { line: out.say };
        }
        case 'create_task': {
          const taskId = newTask(loc.id, contact?.id ?? null, a.title, [a.message, `Angelegt vom ${SOURCE} (Anrufer: ${who}).`].filter(Boolean).join('\n\n'));
          save(ses, { task_id: ses.task_id ?? taskId });
          record(ses, 'create_task', true, `Aufgabe angelegt: ${a.title}`, 'task');
          return { line: out.say };
        }
        case 'create_opportunity': {
          const p = pipelineFor(loc.id, s);
          let target = contact;
          if (!target && callerPhone(ses)) {
            target = upsertContact(app, loc.id, { phone: callerPhone(ses) }, { source: SOURCE }).contact;
            attachContact(ses, target.id);
          }
          if (!p || !target) return { followUp: 'Opportunity nicht möglich (kein Kontakt oder keine Pipeline). Nimm das Anliegen stattdessen als Nachricht auf.' };
          try {
            const opp = createOpportunity(app, loc.id, { pipeline_id: p.id, stage_id: s.stage_id || undefined, contact_id: target.id, name: `${contactName(target)} – ${a.title}`.slice(0, 120), source: SOURCE });
            if (a.message) db.insert('notes', { id: id(), location_id: loc.id, contact_id: target.id, body: `${SOURCE} – Kaufinteresse: ${a.title}\n${a.message}`, user_id: null, created_at: now() });
            save(ses, { opportunity_id: opp.id });
            record(ses, 'create_opportunity', true, `Opportunity angelegt: ${a.title}`, 'opportunity');
            return { line: out.say };
          } catch (e) {
            record(ses, 'create_opportunity', false, (e as Error).message);
            return { followUp: 'Opportunity konnte nicht angelegt werden. Nimm das Anliegen als Nachricht auf.' };
          }
        }
        case 'send_booking_link': {
          const cal = pickCalendar(cals, a.calendar_id) ?? cals[0];
          let target = contact;
          if (!target && callerPhone(ses)) {
            target = upsertContact(app, loc.id, { phone: callerPhone(ses) }, { source: SOURCE }).contact;
            attachContact(ses, target.id);
          }
          if (!cal || !target?.phone) return { line: 'Leider kann ich Ihnen gerade keine SMS schicken. Möchten Sie den Termin direkt mit mir ausmachen?' };
          const m = await sendToContact(app, loc.id, { contactId: target.id, channel: 'sms', body: `Hier können Sie Ihren Termin bei ${loc.name} buchen: ${app.baseUrl()}/book/${cal.slug}`, source: SOURCE, ignoreDnd: true });
          const ok = m.status !== 'failed';
          record(ses, 'send_booking_link', ok, ok ? `Buchungslink per SMS geschickt (${cal.name})` : `SMS fehlgeschlagen: ${m.error}`, 'sms_link');
          return { line: ok ? out.say : 'Die SMS ließ sich leider gerade nicht senden. Möchten Sie den Termin direkt mit mir ausmachen?' };
        }
        case 'transfer': {
          const call = getCall(ses.call_id);
          const tg = s.transfer && ses.transfer_status !== 'failed' ? transferTargets(loc, s, call) : { numbers: [], clients: [] };
          if (!tg.numbers.length && !tg.clients.length) return { line: 'Leider kann ich gerade niemanden erreichen. Ich nehme Ihr Anliegen aber gern als Nachricht auf – worum geht es?' };
          save(ses, { transfer_status: 'ringing', status: 'transferring' });
          record(ses, 'transfer', true, `Weiterverbinden${a.reason ? `: ${a.reason}` : ''}`);
          const line = speakable(out.say) || 'Ich verbinde Sie, einen Moment bitte.';
          say(ses, 'agent', line);
          const cfg = telephonyConfig(app, loc.id);
          const dial = { voice: s.voice, numbers: tg.numbers, clients: tg.clients, action: `${hook('voice-ai-transfer', loc.id)}?t=${ses.turns}`, timeout: cfg.s.ring_timeout };
          return { reply: { say: line, then: 'transfer', twiml: transferTwiml({ say: line, ...dial }), next: transferTwiml({ say: '', ...dial }) } };
        }
        case 'end_call': {
          const line = speakable(out.say) || s.goodbye;
          say(ses, 'agent', line);
          endCall(ses, 'agent');
          return { reply: hangUp(s, line) };
        }
      }
    };

    /** One caller turn: Claude (at most twice), the tool, and the TwiML to answer with. Never throws. */
    const runTurn = async (locId: string, sesId: string): Promise<PhoneReply> => {
      const loc = app.location(locId)!;
      const s = load(locId);
      let ses = sessionById(sesId)!;
      try {
        const cals = s.booking ? allowedCalendars(locId, s) : [];
        let toolResult: string | undefined;
        for (let hop = 0; hop < MAX_HOPS; hop++) {
          const tools = toolsFor(loc, s, ses, cals).filter((t) => !(hop > 0 && t === 'check_slots'));
          const parsed = await askClaude(loc, s, ses, tools, cals, toolResult);
          ses = sessionById(sesId)!;
          // The caller hung up meanwhile (or the fallback took over): nothing more to do.
          if (ses.status !== 'active' || ses.ended_at) return hangUp(s, '');
          if (!parsed.ok) {
            const errors = (ses.errors ?? 0) + 1;
            save(ses, { errors });
            record(ses, 'invalid', false, `Ungültige KI-Antwort: ${parsed.error}`);
            if (errors >= 2) return fallback(loc, s, ses, `KI-Antwort zweimal unbrauchbar (${parsed.error})`);
            const line = 'Entschuldigung, das habe ich nicht ganz verstanden. Können Sie es bitte noch einmal anders sagen?';
            say(ses, 'agent', line);
            return listen(locId, s, ses, line);
          }
          save(ses, { errors: 0 });
          const step = await runTool(loc, s, ses, parsed.value, cals);
          if (step.reply) return step.reply;
          if (step.followUp) {
            // The model sees the tool result and answers again (its interim line is never spoken).
            say(ses, 'system', step.followUp.split('\n')[0]);
            toolResult = step.followUp;
            continue;
          }
          const line = speakable(step.line ?? (parsed.value.say || 'Wie kann ich Ihnen sonst helfen?'));
          say(ses, 'agent', line);
          return listen(locId, s, ses, line);
        }
        const line = 'Das hat leider nicht geklappt. Soll ich es anders versuchen, oder nehme ich Ihr Anliegen als Nachricht für das Team auf?';
        say(ses, 'agent', line);
        return listen(locId, s, ses, line);
      } catch (e) {
        return fallback(loc, s, sessionById(sesId)!, (e as Error).message || 'Fehler');
      }
    };

    // --- Twilio webhooks (signed with the account's auth token) ----------------------------
    interface Job {
      turn: number;
      promise: Promise<PhoneReply>;
      settled: boolean;
    }
    const pending = new Map<string, Job>();
    const route = (name: string, fn: (loc: LocationRow, p: Record<string, string>, q: URLSearchParams) => string | Promise<string>) =>
      router.post(`/hooks/twilio/${name}/:loc`, 'public', async (ctx: Ctx) => {
        const loc = app.location(ctx.params.loc);
        if (!loc) throw notFound();
        verifyTwilio(app, ctx, telephonyConfig(app, loc.id).token);
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.body ?? {})) if (typeof v === 'string') p[k] = v;
        return text(await fn(loc, p, ctx.query), 'text/xml; charset=utf-8');
      });
    const waitUrl = (loc: string, turn: number, n: number) => `${hook('voice-ai-wait', loc)}?t=${turn}&n=${n}`;
    const answerOrFiller = async (loc: LocationRow, s: VoiceAiSettings, ses: Session, job: Job, ms: number, n: number) => {
      const r = await race(job.promise, ms);
      if (r !== TIMEOUT) return r.twiml;
      if (n > 2) {
        pending.delete(ses.id);
        return fallback(loc, s, sessionById(ses.id)!, 'Die KI hat zu lange gebraucht').twiml;
      }
      return fillerTwiml(n === 1 ? 'Einen Moment bitte.' : 'Ich bin gleich so weit.', s.voice, waitUrl(loc.id, job.turn, n));
    };

    /**
     * What the caller said (or silence) → an immediate reply (silence, limits) or the running job of this turn.
     * Shared by the <Gather> webhook and the voice layer's transports (Media Stream, recorded turns).
     */
    const startTurn = (loc: LocationRow, s: VoiceAiSettings, ses: Session, said: string): { reply?: PhoneReply; job?: Job } => {
      const speech = said.replace(/\s+/g, ' ').trim().slice(0, 1000);
      if (!speech) {
        const silences = (ses.silences ?? 0) + 1;
        save(ses, { silences });
        if (silences >= 2) {
          const line = 'Ich höre Sie leider nicht. Rufen Sie gern noch einmal an. Auf Wiederhören!';
          say(ses, 'agent', line);
          endCall(ses, 'silence');
          return { reply: hangUp(s, line) };
        }
        const line = 'Sind Sie noch da? Wie kann ich Ihnen helfen?';
        say(ses, 'agent', line);
        return { reply: listen(loc.id, s, ses, line) };
      }
      say(ses, 'caller', speech);
      save(ses, { silences: 0, turns: ses.turns + 1 });
      const elapsed = (Date.now() - Date.parse(ses.started_at)) / 1000;
      if (ses.turns > s.max_turns || elapsed > s.max_minutes * 60) {
        const line = 'Vielen Dank, ich habe alles notiert. Unser Team meldet sich bei Ihnen. Auf Wiederhören!';
        say(ses, 'agent', line);
        record(ses, 'limit', true, ses.turns > s.max_turns ? `Höchstzahl von ${s.max_turns} Gesprächsrunden erreicht` : `Höchstdauer von ${s.max_minutes} Minuten erreicht`);
        endCall(ses, 'limit');
        return { reply: hangUp(s, line) };
      }
      const job: Job = { turn: ses.turns, promise: runTurn(loc.id, ses.id), settled: false };
      pending.set(ses.id, job);
      void job.promise.finally(() => {
        job.settled = true;
        // Kept a minute for a late "wait" request, then dropped.
        setTimeout(() => pending.get(ses.id) === job && pending.delete(ses.id), 60_000).unref?.();
      });
      return { job };
    };

    /** <Gather> result: what the caller said (or silence) → next turn. */
    route('voice-ai', async (loc, p, q) => {
      const ses = sessionBySid(loc.id, p.CallSid);
      const s = load(loc.id);
      if (!ses || ses.status !== 'active') return sayHangup('', s.voice);
      // The same <Gather> result twice while Claude still works on it: wait for that answer.
      const running = pending.get(ses.id);
      if (running && !running.settled) return answerOrFiller(loc, s, ses, running, voiceTiming.replyMs, 1);
      if (Number(q.get('t') ?? -1) !== ses.turns) return gather(loc.id, s, ses, 'Entschuldigung, wie bitte?');
      const started = startTurn(loc, s, ses, String(p.SpeechResult ?? ''));
      if (started.reply) return started.reply.twiml;
      return answerOrFiller(loc, s, ses, started.job!, voiceTiming.replyMs, 1);
    });

    /** Claude was slow: Twilio comes back here after the filler line. */
    route('voice-ai-wait', async (loc, p, q) => {
      const ses = sessionBySid(loc.id, p.CallSid);
      const s = load(loc.id);
      if (!ses || ses.status === 'ended') return sayHangup('', s.voice);
      const job = pending.get(ses.id);
      const turn = Number(q.get('t') ?? -1);
      if (!job || job.turn !== turn) {
        if (ses.status !== 'active') return sayHangup('', s.voice);
        return gather(loc.id, s, ses, 'Entschuldigung, da ist etwas schiefgegangen. Können Sie das bitte noch einmal sagen?');
      }
      return answerOrFiller(loc, s, ses, job, voiceTiming.waitMs, Math.max(1, Math.round(num(q.get('n'), 1))) + 1);
    });

    // --- the brain for the voice layer's transports (own voice over a Media Stream / recorded turns) ------------------
    const brain: VoiceBrain = {
      open: (locId, callSid) => {
        const ses = sessionBySid(locId, callSid);
        if (!ses || ses.status !== 'active' || ses.ended_at) return null;
        const s = load(locId);
        return { greeting: ses.transcript.find((t) => t.role === 'agent')?.text ?? '', maxMs: s.max_minutes * 60_000, voice: s.voice };
      },
      turn: (locId, callSid, speech) => {
        const loc = app.location(locId);
        const ses = sessionBySid(locId, callSid);
        const s = load(locId);
        if (!loc || !ses || ses.status !== 'active' || ses.ended_at) return { reply: hangUp(s, '') };
        const running = pending.get(ses.id);
        if (running && !running.settled) return { job: running.promise };
        const started = startTurn(loc, s, ses, speech);
        return { reply: started.reply, job: started.job?.promise };
      },
      silence: (locId, callSid) => {
        const loc = app.location(locId);
        const ses = sessionBySid(locId, callSid);
        if (!loc || !ses || ses.status !== 'active' || ses.ended_at) return null;
        return startTurn(loc, load(locId), ses, '').reply ?? null;
      },
      degrade: (locId, callSid, line, reason) => {
        const loc = app.location(locId);
        const ses = sessionBySid(locId, callSid);
        if (!loc || !ses || ses.status !== 'active' || ses.ended_at) return null;
        record(ses, 'voice_fallback', true, `Eigene Stimme ausgefallen (${reason.slice(0, 200)}) – weiter mit der Twilio-Stimme`);
        const text = line.trim() || 'Entschuldigung, ich habe Sie gerade nicht verstanden. Können Sie das bitte noch einmal sagen?';
        if (!line.trim()) say(ses, 'agent', text);
        return listen(locId, load(locId), ses, text);
      },
      note: (locId, callSid, type, ok, detail) => {
        const ses = sessionBySid(locId, callSid);
        if (ses) record(ses, type, ok, detail);
      },
    };
    app.services.voiceBrain = brain;

    /** After a transfer <Dial>: someone took it → done; nobody → back to the agent (message instead). */
    route('voice-ai-transfer', (loc, p) => {
      const ses = sessionBySid(loc.id, p.CallSid);
      const s = load(loc.id);
      if (!ses || ses.ended_at) return sayHangup('', s.voice);
      const call = getCall(ses.call_id);
      if (call && app.services.voiceDialHeld?.(call)) return twiml('');
      const st = String(p.DialCallStatus ?? '');
      if (st === 'completed' || st === 'answered') {
        save(ses, { transfer_status: 'answered' });
        record(ses, 'transfer_done', true, 'An das Team weiterverbunden', 'transferred');
        endCall(ses, 'transfer');
        return sayHangup('', s.voice);
      }
      save(ses, { transfer_status: 'failed', status: 'active' });
      record(ses, 'transfer_failed', false, `Weiterverbinden ohne Erfolg (${st || 'keine Antwort'})`);
      say(ses, 'system', 'Weiterverbinden hat nicht geklappt – niemand hat abgenommen.');
      const line = 'Leider ist gerade niemand erreichbar. Ich nehme Ihr Anliegen aber gern als Nachricht für das Team auf. Worum geht es?';
      say(ses, 'agent', line);
      return gather(loc.id, s, ses, line);
    });

    // --- after the call --------------------------------------------------------------------
    const fallbackSummary = (ses: Session, outcome: string) => {
      if (!ses.turns) return 'Der Anrufer hat nichts gesagt.';
      const firstCaller = ses.transcript.find((t) => t.role === 'caller')?.text ?? '';
      return `${OUTCOMES[outcome] ?? outcome}. ${ses.message ? `Nachricht: ${ses.message}` : firstCaller ? `Anliegen: ${firstCaller.slice(0, 300)}` : ''}`.trim();
    };
    const transcriptText = (ses: Session) => ses.transcript.map((t) => `${t.role === 'caller' ? 'Anrufer' : t.role === 'agent' ? 'Assistent' : '·'}: ${t.text}`).join('\n');

    /** Summary, note, timeline, trigger and notifications – exactly once per call. */
    const finishSession = async (sesId: string) => {
      const job = pending.get(sesId);
      if (job) await race(job.promise, 20_000);
      pending.delete(sesId);
      if (!db.run(`UPDATE voice_ai_sessions SET status = 'ended', ended_at = ? WHERE id = ? AND ended_at IS NULL`, now(), sesId).changes) return;
      const ses = sessionById(sesId)!;
      const loc = app.location(ses.location_id);
      if (!loc) return;
      const s = load(loc.id);
      const call = getCall(ses.call_id);
      const end = call?.status === 'voicemail' ? 'voicemail' : ses.end_reason || 'caller';
      // A browser phone took the transfer and put it on hold – the transfer action never came back.
      if (ses.transfer_status === 'ringing' && end !== 'voicemail' && call?.user_id && !ses.outcomes.includes('transferred')) ses.outcomes = [...ses.outcomes, 'transferred'];
      const outcome = resolveOutcome({ outcomes: ses.outcomes, turns: ses.turns, end });
      const contact = ses.contact_id ? getContact(app, loc.id, ses.contact_id) : undefined;
      let summary = '';
      let next = '';
      if (ses.turns > 0 && app.services.aiRun) {
        try {
          const r = await app.services.aiRun({
            locationId: loc.id,
            purpose: 'voice_agent',
            user: [contactBlock(contact), `<anruf>\nErgebnis: ${OUTCOMES[outcome]}\n${ses.actions.filter((a) => a.ok).map((a) => a.detail).join('\n')}\n</anruf>`, dialogue(ses.transcript, 80), SUMMARY_TASK_VOICE].join('\n\n'),
            schema: SUMMARY_SCHEMA,
            maxTokens: 1200,
            contactId: ses.contact_id,
            conversationId: conversationOf(loc.id, ses.contact_id),
          });
          const parsed = parseSummary(r.text);
          if (parsed.ok) ({ summary, next_step: next } = parsed.value);
        } catch {
          /* logged in ai_calls; the fallback summary below is enough */
        }
      }
      if (!summary) summary = fallbackSummary(ses, outcome);
      const duration = call?.duration || Math.round((Date.now() - Date.parse(ses.started_at)) / 1000);
      db.update('voice_ai_sessions', ses.id, { outcome, outcomes: ses.outcomes, summary, next_step: next, end_reason: end });
      if (call) {
        // A voicemail keeps its own transcription; otherwise the call entry shows the summary.
        if (call.status !== 'voicemail' || !call.transcription) db.run('UPDATE calls SET transcription = ?, updated_at = ? WHERE id = ?', `${SOURCE} · ${OUTCOMES[outcome]}: ${summary}`.slice(0, 5000), now(), call.id);
        syncMessage(app, getCall(call.id)!);
      }
      const appt = ses.appointment_id ? db.get('SELECT a.*, k.timezone FROM appointments a JOIN calendars k ON k.id = a.calendar_id WHERE a.id = ?', ses.appointment_id) : undefined;
      if (contact) {
        db.insert('notes', {
          id: id(),
          location_id: loc.id,
          contact_id: contact.id,
          body: `${SOURCE} – Anruf vom ${formatInTz(ses.started_at, loc.timezone)}\nErgebnis: ${OUTCOMES[outcome]}\n\n${summary}${next ? `\nNächster Schritt: ${next}` : ''}\n\nVerlauf:\n${transcriptText(ses)}`.slice(0, 20_000),
          user_id: null,
          created_at: now(),
        });
        logActivity(app, loc.id, contact.id, 'call.ai', `KI-Anruf: ${OUTCOMES[outcome]} – ${summary.slice(0, 160)}`, { callId: ses.call_id, outcome });
      }
      const who = contact ? contactName(contact) : callerPhone(ses) || 'Unbekannt';
      app.events.emit(loc.id, VOICE_TRIGGER, {
        contactId: ses.contact_id ?? undefined,
        callId: ses.call_id,
        sessionId: ses.id,
        outcome,
        outcomes: ses.outcomes,
        summary,
        next_step: next,
        appointmentId: ses.appointment_id ?? null,
        taskId: ses.task_id ?? null,
        opportunityId: ses.opportunity_id ?? null,
        message: ses.message,
        transferred: ses.outcomes.includes('transferred'),
        turns: ses.turns,
        duration,
        from: callerPhone(ses),
      });
      const subject = `KI-Anruf: ${who} – ${OUTCOMES[outcome]}`;
      const body = [
        summary,
        next && `Nächster Schritt: ${next}`,
        appt && `Termin: ${formatInTz(appt.start_at, appt.timezone)} (${appt.title})`,
        ses.message && `Nachricht: ${ses.message}`,
        `Anrufer: ${callerPhone(ses) || 'Nummer unterdrückt'}`,
        `Verlauf: ${app.baseUrl()}/app/calls`,
      ]
        .filter(Boolean)
        .join('\n\n');
      if (s.notify_email) await notifyTeam(app, loc.id, subject, body).catch(() => undefined);
      if (s.notify_push && app.services.pushNotify) await Promise.resolve(app.services.pushNotify({ locationId: loc.id, kind: 'messages', title: subject, body: summary, url: '/app/calls', tag: `ai-call-${ses.id}` })).catch(() => undefined);
    };

    for (const type of ['call.completed', 'call.missed', 'call.voicemail']) {
      app.events.on(type, async (e) => {
        const row = e.data.callId ? db.get('SELECT id FROM voice_ai_sessions WHERE call_id = ? AND ended_at IS NULL', e.data.callId) : undefined;
        if (row) await finishSession(row.id);
      });
    }

    // Sessions whose call vanished without a final callback are closed after a while.
    let lastSweep = 0;
    app.onTick(async () => {
      if (Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      const stale = db.all(
        `SELECT * FROM voice_ai_sessions WHERE ended_at IS NULL AND ((status <> 'transferring' AND last_at < ?) OR last_at < ?) LIMIT 50`,
        new Date(Date.now() - 40 * 60_000).toISOString(),
        new Date(Date.now() - 4 * 3600_000 - 5 * 60_000).toISOString(),
      );
      for (const row of stale) {
        const call = getCall(row.call_id);
        if (call && !call.ended_at) finalizeCall(app, call, call.answered ? 'completed' : 'missed');
        else await finishSession(row.id);
      }
    });

    // --- API -----------------------------------------------------------------------------------
    const settingsOut = (locId: string) => {
      const s = load(locId);
      const cfg = telephonyConfig(app, locId);
      const problem: string | null = app.services.aiReady ? app.services.aiReady(locId) : 'Das Modul KI-Assistent fehlt.';
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const stats = db.all<{ outcome: string; n: number }>(`SELECT outcome, COUNT(*) n FROM voice_ai_sessions WHERE location_id = ? AND started_at >= ? AND ended_at IS NOT NULL GROUP BY outcome`, locId, since);
      return {
        settings: s,
        voices: VOICES,
        outcomes: OUTCOMES,
        calendars: db.all('SELECT id, name, active, slug FROM calendars WHERE location_id = ? ORDER BY name', locId),
        pipelines: parseRows(db.all('SELECT id, name, stages FROM pipelines WHERE location_id = ? ORDER BY name', locId), ['stages']),
        ai_ready: !problem,
        ai_problem: problem,
        telephony_ready: !!(cfg.accountSid && cfg.token && cfg.numbers.length),
        forward: cfg.forward,
        active_now: s.mode !== 'off' && !problem,
        stats: Object.fromEntries(stats.map((r) => [r.outcome, r.n])),
      };
    };
    router.get('/api/voice-ai/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/voice-ai/settings', 'location', (ctx) => {
      const next = cleanVoiceSettings(ctx.body ?? {}, load(ctx.locationId));
      for (const cid of next.calendar_ids) if (!db.get('SELECT id FROM calendars WHERE id = ? AND location_id = ?', cid, ctx.locationId)) throw bad('Kalender nicht gefunden');
      if (next.pipeline_id) {
        const p = getPipeline(app, ctx.locationId, next.pipeline_id);
        if (!p) throw bad('Pipeline nicht gefunden');
        if (next.stage_id && !p.stages.some((st: any) => st.id === next.stage_id)) throw bad('Stufe nicht gefunden');
      } else next.stage_id = '';
      const cfg = telephonyConfig(app, ctx.locationId);
      if (next.transfer_number && cfg.numbers.includes(next.transfer_number)) throw bad('Die Weiterleitung darf nicht auf die Twilio-Nummer selbst zeigen');
      db.run(
        'INSERT INTO voice_ai_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
        ctx.locationId,
        JSON.stringify(next),
        now(),
      );
      return settingsOut(ctx.locationId);
    });

    const sessionOut = (r: any, full = false) => {
      const ses = readSession(r)!;
      const base = {
        id: ses.id,
        call_id: ses.call_id,
        contact_id: ses.contact_id,
        contact_name: ses.contact_id ? [r.first_name, r.last_name].filter(Boolean).join(' ') || r.contact_phone || '' : '',
        from_number: ses.from_number,
        stage: ses.stage,
        status: ses.status,
        outcome: ses.outcome,
        outcome_label: OUTCOMES[ses.outcome] ?? '',
        outcomes: ses.outcomes,
        summary: ses.summary,
        next_step: ses.next_step,
        turns: ses.turns,
        started_at: ses.started_at,
        ended_at: ses.ended_at,
      };
      if (!full) return base;
      return { ...base, transcript: ses.transcript, actions: ses.actions, message: ses.message, appointment_id: ses.appointment_id, task_id: ses.task_id, opportunity_id: ses.opportunity_id, transfer_status: ses.transfer_status, error: ses.error, ai_calls: ses.ai_calls };
    };
    const SELECT = 'SELECT v.*, k.first_name, k.last_name, k.phone AS contact_phone FROM voice_ai_sessions v LEFT JOIN contacts k ON k.id = v.contact_id';
    router.get('/api/voice-ai/calls', 'location', (ctx) => {
      const limit = Math.min(Math.max(1, num(ctx.query.get('limit'), 50)), 200);
      return db.all(`${SELECT} WHERE v.location_id = ? ORDER BY v.started_at DESC LIMIT ?`, ctx.locationId, limit).map((r) => sessionOut(r));
    });
    router.get('/api/voice-ai/calls/:id', 'location', (ctx) => {
      const r = db.get(`${SELECT} WHERE v.location_id = ? AND (v.call_id = ? OR v.id = ?)`, ctx.locationId, ctx.params.id, ctx.params.id);
      if (!r) throw notFound('Kein KI-Anruf');
      return sessionOut(r, true);
    });
  },
};
