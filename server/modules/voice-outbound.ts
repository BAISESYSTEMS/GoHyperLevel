import type { LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, clampLimit, notFound, num, str, text, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { formatInTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { id, normalizePhone, now } from '../core/util.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { E164, hangup, say, twiml } from '../services/twilio.js';
import { registerActions, registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';
import { finalizeCall, syncMessage, telephonyConfig, twilioRequest, verifyTwilio, type VoiceAgentInput } from './telephony.js';
import { VOICE_TRIGGER } from './voice-ai.js';

/**
 * Voice AI outbound calls: the workflow action `voice_ai_call` (and POST /api/voice-ai/outbound) has the KI-Telefonagent call a
 * contact with a goal (qualify, book, remind) and a script. Before anything is dialled the power dialer's compliance verdict
 * decides (Nicht stören, consent – an automated call needs a confirmed phone consent under § 7 Abs. 2 UWG, except a service
 * reminder –, calling hours and days, public holidays), plus a daily limit per sub-account. Twilio places the call with answering
 * machine detection; a person gets the agent (modules/voice-ai.ts – over <Connect><Stream> with the sub-account's own voice when
 * the voice layer is set up, else Twilio's voices), a machine gets the optional voicemail text. Results fire one of four triggers
 * (answered / booked / no answer / voicemail); transcript and summary land on the contact (note + timeline) as for inbound calls.
 * Docs: docs/voice.md#outbound-ai-calls.
 */

export const GOALS: Record<string, { label: string; task: string; greeting: string }> = {
  qualify: {
    label: 'Qualifizieren',
    task: 'Qualifiziere den Kontakt: Bedarf, Zeitrahmen, Budget und wer entscheidet. Halte das Ergebnis mit take_message fest (oder create_opportunity, wenn verfügbar). Biete bei echtem Interesse einen Termin an.',
    greeting: 'Hallo {{contact.first_name}}, hier spricht der KI-Assistent von {{location.name}}. Sie hatten sich bei uns gemeldet – haben Sie zwei Minuten?',
  },
  book: {
    label: 'Termin vereinbaren',
    task: 'Vereinbare einen Termin: frag nach passenden Tagen, prüfe freie Zeiten (check_slots) und buche (book_appointment). Kein Druck – wer keinen Termin will, bekommt keinen.',
    greeting: 'Hallo {{contact.first_name}}, hier spricht der KI-Assistent von {{location.name}}. Ich würde gern einen Termin mit Ihnen vereinbaren – passt es gerade kurz?',
  },
  remind: {
    label: 'Termin-Erinnerung',
    task: 'Erinnere an den Termin unten und frag, ob er noch passt. Passt er nicht, biete einen neuen an (check_slots, book_appointment) und nimm eine Absage mit take_message auf.',
    greeting: 'Hallo {{contact.first_name}}, hier spricht der KI-Assistent von {{location.name}}. Ich rufe wegen Ihres Termins an – haben Sie kurz Zeit?',
  },
};
export const RESULTS: Record<string, string> = { answered: 'Angenommen', booked: 'Termin gebucht', no_answer: 'Nicht erreicht', voicemail: 'Mailbox' };
const DEFAULTS = { daily_limit: 50, caller_id: '', voicemail_text: '' };
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

interface Settings {
  daily_limit: number;
  caller_id: string;
  voicemail_text: string;
}
interface Outbound {
  id: string;
  location_id: string;
  contact_id: string | null;
  call_id: string | null;
  call_sid: string | null;
  goal: string;
  script: string;
  greeting: string;
  voicemail_text: string;
  from_number: string;
  to_number: string;
  status: string;
  result: string;
  answered_by: string;
  session_id: string | null;
  summary: string;
  error: string;
  run_id: string | null;
  workflow_id: string | null;
  created_at: string;
  ended_at: string | null;
}
export interface StartInput {
  contactId: string;
  goal?: string;
  script?: string;
  greeting?: string;
  voicemailText?: string;
  from?: string;
  runId?: string | null;
  workflowId?: string | null;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_voice_ai_call',
    title: 'KI-Anruf starten',
    description:
      'Lässt den KI-Telefonagenten einen Kontakt anrufen (ruft ECHT an): goal qualify (qualifizieren), book (Termin vereinbaren) oder remind (Termin-Erinnerung), script = Leitfaden/Prompt. Vorher prüft der Server Nicht stören, Einwilligung (§ 7 UWG), Anrufzeiten, Feiertage und das Tageslimit – ist der Anruf nicht erlaubt, kommt status blocked mit Grund.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        contact_id: { type: 'string' },
        goal: { type: 'string', enum: Object.keys(GOALS) },
        script: { type: 'string', description: 'Leitfaden: was der Agent sagen, fragen, anbieten soll' },
      },
      required: ['location_id', 'contact_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', '/api/voice-ai/outbound', { location: a.location_id, body: { contact_id: a.contact_id, goal: a.goal, script: a.script } }),
  },
];

const TRIGGER_META: TriggerMeta[] = [
  { type: 'voice_ai_call.answered', label: 'KI-Anruf: angenommen', summary: 'Ein ausgehender KI-Anruf wurde von einer Person angenommen (ohne Terminbuchung).' },
  { type: 'voice_ai_call.booked', label: 'KI-Anruf: Termin gebucht', summary: 'Im ausgehenden KI-Anruf wurde ein Termin gebucht.' },
  { type: 'voice_ai_call.no_answer', label: 'KI-Anruf: nicht erreicht', summary: 'Der ausgehende KI-Anruf wurde nicht angenommen (keine Antwort, besetzt, abgelehnt, fehlgeschlagen).' },
  { type: 'voice_ai_call.voicemail', label: 'KI-Anruf: Mailbox', summary: 'Beim ausgehenden KI-Anruf ging die Mailbox ran (Anrufbeantworter erkannt).' },
].map((t) => ({
  ...t,
  category: 'messages',
  doc: '{{event.goal}} ist das Ziel (qualify, book, remind), {{event.summary}} die Zusammenfassung des Gesprächs, {{event.outcome}} das Ergebnis des Agenten, {{event.appointmentId}} der gebuchte Termin. Typisch: nicht erreicht → in zwei Tagen noch einmal anrufen oder SMS; Termin gebucht → Bestätigung.',
  fields: [],
  sample: { goal: 'book', result: t.type.split('.')[1], summary: 'Kontakt möchte ein Angebot, Termin am Dienstag gebucht.', outcome: 'booked', callId: 'c1' },
  keywords: 'ki anruf ausgehend voice ai telefon agent outbound',
}));

export const voiceOutboundModule: Module = {
  name: 'voice-outbound',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE voice_ai_outbound (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, call_id TEXT, call_sid TEXT,
        goal TEXT NOT NULL DEFAULT 'qualify', script TEXT NOT NULL DEFAULT '', greeting TEXT NOT NULL DEFAULT '', voicemail_text TEXT NOT NULL DEFAULT '',
        from_number TEXT NOT NULL DEFAULT '', to_number TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued', result TEXT NOT NULL DEFAULT '',
        answered_by TEXT NOT NULL DEFAULT '', session_id TEXT, summary TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
        run_id TEXT, workflow_id TEXT, created_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE INDEX voice_ai_outbound_loc ON voice_ai_outbound(location_id, created_at);
      CREATE INDEX voice_ai_outbound_call ON voice_ai_outbound(call_id);
      CREATE INDEX voice_ai_outbound_open ON voice_ai_outbound(ended_at, created_at);
      CREATE TABLE voice_ai_outbound_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, TRIGGER_META);
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;

    const settingsOf = (loc: string): Settings => ({ ...DEFAULTS, ...(parseJson(db.get('SELECT data FROM voice_ai_outbound_settings WHERE location_id = ?', loc), ['data'])?.data ?? {}) });
    const rowOf = (key: string | null | undefined) => (key ? db.get<Outbound>('SELECT * FROM voice_ai_outbound WHERE id = ?', key) : undefined);
    const callOf = (callId: string | null) => (callId ? db.get<any>('SELECT * FROM calls WHERE id = ?', callId) : undefined);
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
    /** Calls placed today (sub-account time zone) – what the daily limit counts. */
    const placedToday = (loc: string) => {
      const start = zonedToUtc(ymdInTz(new Date(), tzOf(loc)), '00:00', tzOf(loc)).toISOString();
      return db.get<{ n: number }>(`SELECT COUNT(*) n FROM voice_ai_outbound WHERE location_id = ? AND created_at >= ? AND status NOT IN ('blocked')`, loc, start)!.n;
    };
    const nextAppointment = (loc: string, contactId: string | null) => {
      if (!contactId) return undefined;
      try {
        return db.get<any>(`SELECT a.title, a.start_at, k.timezone FROM appointments a JOIN calendars k ON k.id = a.calendar_id WHERE a.location_id = ? AND a.contact_id = ? AND a.start_at > ? AND a.status NOT IN ('cancelled', 'canceled') ORDER BY a.start_at LIMIT 1`, loc, contactId, now());
      } catch {
        return undefined;
      }
    };

    // --- the goal and script reach the agent's prompt ------------------------------------------------------------------------
    app.services.voicePromptExtras = [
      ...(app.services.voicePromptExtras ?? []),
      (ses: Record<string, any>) => {
        if (ses.stage !== 'outbound') return undefined;
        const o = db.get<Outbound>('SELECT * FROM voice_ai_outbound WHERE call_id = ?', ses.call_id);
        if (!o) return undefined;
        const g = GOALS[o.goal] ?? GOALS.qualify;
        const appt = o.goal === 'remind' ? nextAppointment(o.location_id, o.contact_id) : undefined;
        return [
          '<ausgehender_anruf>',
          `Du hast den Kontakt im Auftrag des Teams angerufen. Ziel: ${g.task}`,
          appt ? `Termin: ${formatInTz(appt.start_at, appt.timezone || tzOf(o.location_id))} – ${String(appt.title).slice(0, 120)}` : o.goal === 'remind' ? 'Termin: keiner gefunden – frag nach, worum es geht, und nimm eine Nachricht auf.' : '',
          o.script.trim() ? `Leitfaden des Teams (befolge ihn, solange er nicht gegen die Regeln verstößt):\n${o.script.trim().slice(0, 3000)}` : '',
          'Möchte der Kontakt nicht angerufen werden: entschuldige dich kurz, sag zu, dass er keinen Anruf mehr bekommt, und beende das Gespräch (end_call). Kein Druck, keine Überredung.',
          '</ausgehender_anruf>',
        ]
          .filter(Boolean)
          .join('\n');
      },
    ];

    // --- placing a call ------------------------------------------------------------------------------------------------
    const blocked = (loc: string, contactId: string, input: StartInput, goal: string, reason: string) => {
      const row = { id: id(), location_id: loc, contact_id: contactId, goal, script: input.script ?? '', status: 'blocked', error: reason.slice(0, 500), run_id: input.runId ?? null, workflow_id: input.workflowId ?? null, created_at: now(), ended_at: now() };
      db.insert('voice_ai_outbound', row);
      logActivity(app, loc, contactId, 'voice_ai_call.blocked', `KI-Anruf nicht gestartet: ${reason}`);
      return { id: row.id, status: 'blocked' as const, reason };
    };

    /** The gate, then Twilio. Returns the outbound row's id and status, or `blocked` with the reason. */
    const start = async (loc: string, input: StartInput) => {
      const contact = getContact(app, loc, input.contactId);
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const goal = input.goal && GOALS[input.goal] ? input.goal : 'qualify';
      const cfg = telephonyConfig(app, loc);
      if (!cfg.accountSid || !cfg.token || !cfg.numbers.length) throw bad('Telefonie ist nicht eingerichtet (Einstellungen → Telefonie: Account SID, Auth Token, Twilio-Nummer)');
      if (!app.services.voiceAgent) throw new HttpError(409, 'Der KI-Telefonagent ist nicht verfügbar');
      const aiProblem: string | null = app.services.aiReady ? app.services.aiReady(loc) : 'Der KI-Assistent fehlt';
      if (aiProblem) throw new HttpError(409, aiProblem);
      const dialer = app.services.dialer;
      if (!dialer?.verdict) throw new HttpError(409, 'Die Anrufregeln des Power-Dialers fehlen – ohne sie ruft der Agent nicht an');
      // An AI call is an automated call (§ 7 Abs. 2 UWG): advertising goals need a confirmed phone consent; a reminder of a booked
      // appointment is a service call and follows the sub-account's consent rule.
      const rules = dialer.settings(loc);
      const v = dialer.verdict(loc, contact.id, { attempts: 0, next_at: null }, { ...rules, max_attempts: Math.max(1, rules.max_attempts), consent_policy: goal === 'remind' ? rules.consent_policy : 'strict' });
      if (!v.ok) return blocked(loc, contact.id, input, goal, v.reason);
      const s = settingsOf(loc);
      if (placedToday(loc) >= s.daily_limit) return blocked(loc, contact.id, input, goal, `Tageslimit erreicht (${s.daily_limit} KI-Anrufe)`);
      if (db.get(`SELECT 1 FROM voice_ai_outbound WHERE location_id = ? AND contact_id = ? AND ended_at IS NULL AND created_at > ?`, loc, contact.id, new Date(Date.now() - 3600_000).toISOString())) {
        return blocked(loc, contact.id, input, goal, 'Für diesen Kontakt läuft schon ein KI-Anruf');
      }
      const to = normalizePhone(contact.phone);
      if (!E164.test(to)) return blocked(loc, contact.id, input, goal, 'Der Kontakt hat keine gültige Telefonnummer');
      const want = input.from || s.caller_id;
      const from: string = app.services.callerIds?.pick(loc, want) ?? (want && cfg.numbers.includes(want) ? want : cfg.numbers[0]);
      const loc0 = app.location(loc)!;
      const vars = { contact: contactVars(contact), location: loc0 };
      const greeting = render(input.greeting?.trim() || GOALS[goal].greeting, vars).replace(/\s+([,.?!])/g, '$1').slice(0, 500);
      const t = now();
      const callId = id();
      db.insert('calls', { id: callId, location_id: loc, contact_id: contact.id, direction: 'out', from_number: from, to_number: to, status: 'initiated', route_kind: 'voice_ai', started_at: t, updated_at: t });
      syncMessage(app, callOf(callId));
      const row = {
        id: id(),
        location_id: loc,
        contact_id: contact.id,
        call_id: callId,
        goal,
        script: (input.script ?? '').slice(0, 5000),
        greeting,
        voicemail_text: render(input.voicemailText ?? s.voicemail_text ?? '', vars).slice(0, 1000),
        from_number: from,
        to_number: to,
        status: 'queued',
        run_id: input.runId ?? null,
        workflow_id: input.workflowId ?? null,
        created_at: t,
      };
      db.insert('voice_ai_outbound', row);
      try {
        const j = await twilioRequest(app, cfg, 'POST', '/Calls.json', [
          ['To', to],
          ['From', from],
          ['Url', `${hook('voice-ai-out', loc)}?o=${row.id}`],
          ['Method', 'POST'],
          ['StatusCallback', `${hook('voice-ai-out-status', loc)}?o=${row.id}`],
          ['StatusCallbackMethod', 'POST'],
          ...['initiated', 'ringing', 'answered', 'completed'].map((e): [string, string] => ['StatusCallbackEvent', e]),
          // Answering machine detection: DetectMessageEnd waits for the beep when there is a message to leave.
          ['MachineDetection', row.voicemail_text ? 'DetectMessageEnd' : 'Enable'],
          ['Timeout', '25'],
        ]);
        const sid = String(j.sid ?? '') || null;
        db.run('UPDATE calls SET sid = ?, updated_at = ? WHERE id = ?', sid, now(), callId);
        db.run(`UPDATE voice_ai_outbound SET call_sid = ?, status = 'ringing' WHERE id = ?`, sid, row.id);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        db.run(`UPDATE calls SET error = ? WHERE id = ?`, msg, callId);
        finalizeCall(app, callOf(callId), 'failed', { reason: 'api' });
        db.run(`UPDATE voice_ai_outbound SET status = 'failed', error = ? WHERE id = ?`, msg, row.id);
        finish(rowOf(row.id)!, 'no_answer');
        throw e;
      }
      logActivity(app, loc, contact.id, 'voice_ai_call.started', `KI-Anruf gestartet (${GOALS[goal].label}) von ${from}`);
      return { id: row.id, status: 'ringing' as const, call_id: callId };
    };
    app.services.voiceOutbound = { start };

    /** The result – exactly once per call: timeline line, row, trigger. */
    const finish = (o: Outbound, result: keyof typeof RESULTS, extra: { summary?: string; outcome?: string; appointmentId?: string | null; sessionId?: string | null } = {}) => {
      if (!db.run(`UPDATE voice_ai_outbound SET status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'done' END, result = ?, summary = COALESCE(NULLIF(?, ''), summary), session_id = COALESCE(?, session_id), ended_at = ? WHERE id = ? AND ended_at IS NULL`, result, extra.summary ?? '', extra.sessionId ?? null, now(), o.id).changes) return;
      const g = GOALS[o.goal] ?? GOALS.qualify;
      // Answered calls get the agent's note with transcript and summary (voice-ai); the other results a line of their own.
      if (o.contact_id && (result === 'no_answer' || result === 'voicemail')) logActivity(app, o.location_id, o.contact_id, `voice_ai_call.${result}`, `KI-Anruf (${g.label}): ${RESULTS[result]}${o.error ? ` – ${o.error}` : ''}`);
      app.events.emit(o.location_id, `voice_ai_call.${result}`, { contactId: o.contact_id ?? undefined, outboundId: o.id, callId: o.call_id, goal: o.goal, result, summary: extra.summary ?? '', outcome: extra.outcome ?? '', appointmentId: extra.appointmentId ?? null, workflowId: o.workflow_id, runId: o.run_id });
    };

    // The agent's end of the call (modules/voice-ai.ts): booked or answered, with the summary.
    app.events.on(VOICE_TRIGGER, (e) => {
      const o = e.data?.callId ? db.get<Outbound>('SELECT * FROM voice_ai_outbound WHERE call_id = ? AND ended_at IS NULL', e.data.callId) : undefined;
      if (!o) return;
      const booked = e.data.outcome === 'booked' || (Array.isArray(e.data.outcomes) && e.data.outcomes.includes('booked'));
      finish(o, booked ? 'booked' : 'answered', { summary: String(e.data.summary ?? ''), outcome: String(e.data.outcome ?? ''), appointmentId: e.data.appointmentId ?? null, sessionId: e.data.sessionId ?? null });
    });

    // --- Twilio webhooks (signed) ----------------------------------------------------------------------------------------
    const route = (name: string, fn: (loc: LocationRow, p: Record<string, string>, q: URLSearchParams) => string) =>
      router.post(`/hooks/twilio/${name}/:loc`, 'public', (ctx: Ctx) => {
        const loc = app.location(ctx.params.loc);
        if (!loc) throw notFound();
        verifyTwilio(app, ctx, telephonyConfig(app, loc.id).token);
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.body ?? {})) if (typeof v === 'string') p[k] = v;
        return text(fn(loc, p, ctx.query), 'text/xml; charset=utf-8');
      });
    const outboundFor = (loc: LocationRow, p: Record<string, string>, q: URLSearchParams) => {
      const o = rowOf(q.get('o'));
      if (!o || o.location_id !== loc.id || (o.call_sid && p.CallSid && o.call_sid !== p.CallSid)) return undefined;
      return o;
    };

    /** The contact's phone was answered: a person gets the agent, a machine the voicemail text. */
    route('voice-ai-out', (loc, p, q) => {
      const o = outboundFor(loc, p, q);
      const call = o ? callOf(o.call_id) : undefined;
      if (!o || !call || o.ended_at) return hangup();
      const by = String(p.AnsweredBy ?? '').slice(0, 40);
      if (!o.call_sid && p.CallSid) {
        db.run('UPDATE voice_ai_outbound SET call_sid = ? WHERE id = ?', p.CallSid, o.id);
        db.run('UPDATE calls SET sid = COALESCE(sid, ?) WHERE id = ?', p.CallSid, call.id);
      }
      db.run(`UPDATE voice_ai_outbound SET answered_by = ?, status = 'in-progress' WHERE id = ?`, by, o.id);
      if (/^(machine|fax)/.test(by)) {
        db.run(`UPDATE voice_ai_outbound SET result = 'voicemail' WHERE id = ?`, o.id);
        db.run(`UPDATE calls SET answered = 1, answered_at = ?, disposition = 'voicemail', reason = 'machine', updated_at = ? WHERE id = ?`, now(), now(), call.id);
        return o.voicemail_text ? twiml(`${say(o.voicemail_text)}<Hangup/>`) : hangup();
      }
      const agent: string | undefined = app.services.voiceAgent?.({ stage: 'outbound', loc, call: callOf(call.id), open: true, force: true, greeting: o.greeting, party: o.to_number } satisfies VoiceAgentInput);
      if (!agent) {
        db.run(`UPDATE voice_ai_outbound SET error = ? WHERE id = ?`, 'Der KI-Telefonagent konnte das Gespräch nicht übernehmen', o.id);
        return hangup('Entschuldigung, wir haben gerade eine technische Störung. Wir melden uns später noch einmal. Auf Wiederhören.');
      }
      const ses = db.get<{ id: string }>('SELECT id FROM voice_ai_sessions WHERE call_id = ?', call.id);
      if (ses) db.run('UPDATE voice_ai_outbound SET session_id = ? WHERE id = ?', ses.id, o.id);
      return agent;
    });

    /** Progress and the end: nobody answered → no_answer; a machine → voicemail; a person → wait for the agent's summary. */
    route('voice-ai-out-status', (loc, p, q) => {
      const o = outboundFor(loc, p, q);
      const call = o ? callOf(o.call_id) : undefined;
      if (!o || !call) return twiml('');
      const st = String(p.CallStatus ?? '');
      if (['queued', 'initiated', 'ringing', 'in-progress'].includes(st)) {
        if (!call.ended_at) {
          db.run('UPDATE calls SET status = ?, updated_at = ? WHERE id = ?', st === 'queued' ? 'initiated' : st, now(), call.id);
          syncMessage(app, callOf(call.id));
        }
        return twiml('');
      }
      const answered = !!callOf(call.id).answered;
      if (!call.ended_at) finalizeCall(app, callOf(call.id), answered ? 'completed' : ['busy', 'no-answer', 'failed', 'canceled'].includes(st) ? st : 'no-answer', { duration: num(p.CallDuration, 0), reason: answered ? undefined : 'contact' });
      const cur = rowOf(o.id)!;
      if (cur.result === 'voicemail') finish(cur, 'voicemail');
      else if (!answered) finish(cur, 'no_answer');
      else if (!db.get('SELECT 1 FROM voice_ai_sessions WHERE call_id = ?', call.id)) finish(cur, 'answered');
      // otherwise the agent's session ends on call.completed and reports booked/answered (VOICE_TRIGGER above)
      return twiml('');
    });

    // Calls whose final callback never came are settled after Twilio's 4-hour limit (and sessions that never reported).
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      for (const o of db.all<Outbound>('SELECT * FROM voice_ai_outbound WHERE ended_at IS NULL AND created_at < ? LIMIT 50', new Date(Date.now() - 4 * 3600_000 - 10 * 60_000).toISOString())) {
        const call = callOf(o.call_id);
        finish(o, o.result === 'voicemail' ? 'voicemail' : call?.answered ? 'answered' : 'no_answer');
      }
    });

    // --- workflow action ----------------------------------------------------------------------------------------------
    registerActions(app, [
      {
        meta: {
          type: 'voice_ai_call',
          label: 'KI-Anruf starten (Voice AI)',
          category: 'messaging',
          icon: 'phone',
          summary: 'Der KI-Telefonagent ruft den Kontakt an – qualifizieren, Termin vereinbaren oder an einen Termin erinnern.',
          doc: 'Ruft über Twilio an; nimmt eine Person ab, führt der KI-Telefonagent das Gespräch nach Ziel und Leitfaden (mit eigener Stimme über den Live-Stream, wenn unter Stimme eingerichtet). Vorher prüft der Server dieselben Regeln wie der Power-Dialer: Nicht stören, Einwilligung (ein automatisierter Anruf braucht nach § 7 Abs. 2 UWG eine bestätigte Telefon-Einwilligung – außer bei der Termin-Erinnerung), Anrufzeiten und Feiertage, dazu das Tageslimit. Nicht erlaubt → kein Anruf, der Schritt meldet den Grund. Das Ergebnis startet die Auslöser „KI-Anruf: angenommen / Termin gebucht / nicht erreicht / Mailbox“.',
          needs: 'Einstellungen → Telefonie (Twilio) und KI-Telefonagent',
          fields: [
            { key: 'goal', label: 'Ziel', type: 'select', options: Object.entries(GOALS).map(([k, g]): [string, string] => [k, g.label]), default: 'qualify' },
            { key: 'script', label: 'Leitfaden / Prompt', type: 'textarea', placeholder: 'z. B. Frag nach Größe der Wohnung und Wunschtermin; biete die Erstberatung kostenlos an.' },
            { key: 'greeting', label: 'Erster Satz (optional)', type: 'text', help: 'Leer = Standard je Ziel. Platzhalter wie {{contact.first_name}} gehen.' },
            { key: 'voicemail_text', label: 'Mailbox-Nachricht (optional)', type: 'textarea', help: 'Wird gesprochen, wenn ein Anrufbeantworter abnimmt. Leer = auflegen.' },
            { key: 'caller_id', label: 'Absendernummer (optional)', type: 'text', placeholder: '+49…', help: 'Eine Twilio-Nummer oder eine bestätigte eigene Nummer; leer = Standard.' },
          ],
          sample: { goal: 'book', script: 'Biete einen Beratungstermin vor Ort an.', voicemail_text: 'Hallo {{contact.first_name}}, wir melden uns wegen Ihrer Anfrage – rufen Sie gern zurück.' },
          keywords: 'anruf ki voice ai telefon outbound qualifizieren termin erinnerung',
        },
        run: async (run, step, vars) => {
          if (!run.contact_id) throw new Error('Kein Kontakt');
          const r = await start(run.location_id, {
            contactId: run.contact_id,
            goal: String(step.goal ?? 'qualify'),
            script: render(String(step.script ?? ''), vars),
            greeting: step.greeting ? String(step.greeting) : undefined,
            voicemailText: step.voicemail_text ? String(step.voicemail_text) : undefined,
            from: step.caller_id ? normalizePhone(String(step.caller_id)) : undefined,
            runId: run.id,
            workflowId: run.workflow_id,
          });
          return r.status === 'blocked' ? `Nicht angerufen: ${r.reason}` : `KI-Anruf gestartet (${GOALS[String(step.goal)]?.label ?? GOALS.qualify.label})`;
        },
      },
    ]);

    // --- API -----------------------------------------------------------------------------------------------------------
    const out = (o: Outbound & { first_name?: string; last_name?: string }) => ({
      id: o.id,
      contact_id: o.contact_id,
      contact_name: [o.first_name, o.last_name].filter(Boolean).join(' '),
      call_id: o.call_id,
      goal: o.goal,
      goal_label: GOALS[o.goal]?.label ?? o.goal,
      status: o.status,
      result: o.result,
      result_label: RESULTS[o.result] ?? '',
      answered_by: o.answered_by,
      from: o.from_number,
      to: o.to_number,
      summary: o.summary,
      error: o.error,
      created_at: o.created_at,
      ended_at: o.ended_at,
    });
    router.get('/api/voice-ai/outbound', 'location', (ctx) => {
      const rows = db.all<any>('SELECT o.*, k.first_name, k.last_name FROM voice_ai_outbound o LEFT JOIN contacts k ON k.id = o.contact_id WHERE o.location_id = ? ORDER BY o.created_at DESC LIMIT ?', ctx.locationId, clampLimit(ctx.query.get('limit'), 50, 200));
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const stats = db.all<{ k: string; n: number }>(`SELECT CASE WHEN status = 'blocked' THEN 'blocked' ELSE result END k, COUNT(*) n FROM voice_ai_outbound WHERE location_id = ? AND created_at >= ? GROUP BY k`, ctx.locationId, since);
      return { calls: rows.map(out), settings: settingsOf(ctx.locationId), goals: Object.fromEntries(Object.entries(GOALS).map(([k, g]) => [k, g.label])), results: RESULTS, today: placedToday(ctx.locationId), stats: Object.fromEntries(stats.map((r) => [r.k || 'running', r.n])) };
    });
    router.post('/api/voice-ai/outbound', 'location', async (ctx) => {
      const r = await start(ctx.locationId, {
        contactId: str(ctx.body?.contact_id, 'Kontakt', { required: true }),
        goal: str(ctx.body?.goal, 'Ziel', { max: 20 }) || 'qualify',
        script: str(ctx.body?.script, 'Leitfaden', { max: 5000 }),
        greeting: str(ctx.body?.greeting, 'Erster Satz', { max: 500 }) || undefined,
        voicemailText: ctx.body?.voicemail_text === undefined ? undefined : str(ctx.body.voicemail_text, 'Mailbox-Nachricht', { max: 1000 }),
        from: ctx.body?.from ? normalizePhone(String(ctx.body.from)) : undefined,
      });
      return r;
    });
    router.put('/api/voice-ai/outbound/settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const s = settingsOf(ctx.locationId);
      if (b.daily_limit !== undefined) s.daily_limit = Math.min(1000, Math.max(0, Math.round(num(b.daily_limit, 50))));
      if (b.voicemail_text !== undefined) s.voicemail_text = str(b.voicemail_text, 'Mailbox-Nachricht', { max: 1000 });
      if (b.caller_id !== undefined) {
        const n = b.caller_id ? normalizePhone(String(b.caller_id)) : '';
        if (n && !(app.services.callerIds?.allowed(ctx.locationId) ?? telephonyConfig(app, ctx.locationId).numbers).includes(n)) throw bad('Absendernummer: eine Twilio-Nummer oder eine bestätigte eigene Nummer');
        s.caller_id = n;
      }
      db.run('INSERT INTO voice_ai_outbound_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at', ctx.locationId, JSON.stringify(s), now());
      return s;
    });
  },
};
