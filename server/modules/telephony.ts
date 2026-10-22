import type { App, LocationRow, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str, text, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { id, normalizePhone, now, uniq } from '../core/util.js';
import { contactName, getContact, logActivity, upsertContact } from '../services/contacts.js';
import { getOrCreateConversation, notifyTeam } from '../services/messaging.js';
import {
  ACCOUNT_SID,
  DAYS,
  DEFAULT_HOURS,
  E164,
  NUMBER_SID,
  RECORDING_SID,
  bridgeTwiml,
  dialTwiml,
  hangup,
  isOpen,
  mmss,
  say,
  twiml,
  usableNumber,
  validTwilioSignature,
  voicemailTwiml,
  type Hours,
  type HoursMode,
} from '../services/twilio.js';
import { openSecret, sealSecret } from './mail-sync.js';
import type { Tool } from './mcp.js';

/**
 * Telephony over Twilio Voice: click-to-call (your phone rings first, then the contact is bridged),
 * inbound calls forwarded to your mobile during business hours, voicemail otherwise, and a call log
 * that shows up in Konversationen and the contact timeline. Missed calls, voicemails and finished
 * calls fire workflow triggers (e.g. "missed call text-back" with the existing SMS action).
 */

export const DEFAULT_GREETING =
  'Hallo, Sie haben {{location.name}} erreicht. Gerade ist leider niemand erreichbar. Bitte hinterlassen Sie nach dem Signalton Ihren Namen und Ihre Nummer – wir rufen zurück.';

export interface TelephonySettings {
  account_sid: string;
  numbers: string[];
  forward_to: string[];
  ring_timeout: number;
  hours_mode: HoursMode;
  hours: Hours;
  greeting: string;
  voicemail: boolean;
  max_length: number;
  transcribe: boolean;
  record_inbound: boolean;
  record_outbound: boolean;
  notify_missed: boolean;
  notify_voicemail: boolean;
  /** Tell every party that the call is recorded (German law: all parties must know) – played before the connection. */
  record_announce: boolean;
  record_announce_text: string;
  /** Delete recordings (at Twilio too) after this many days; 0 = keep. */
  retention_recordings_days: number;
  retention_voicemail_days: number;
}

const DEFAULTS: TelephonySettings = {
  account_sid: '',
  numbers: [],
  forward_to: [],
  ring_timeout: 20,
  hours_mode: 'hours',
  hours: DEFAULT_HOURS,
  greeting: '',
  voicemail: true,
  max_length: 120,
  transcribe: false,
  record_inbound: false,
  record_outbound: false,
  notify_missed: false,
  notify_voicemail: true,
  record_announce: true,
  record_announce_text: '',
  retention_recordings_days: 0,
  retention_voicemail_days: 0,
};

export const DEFAULT_RECORD_NOTICE = 'Dieses Gespräch wird zur Qualitätssicherung aufgezeichnet. Wenn Sie damit nicht einverstanden sind, beenden Sie bitte jetzt das Gespräch.';
/** What is said before a recorded call is connected. */
export const recordNotice = (s: Pick<TelephonySettings, 'record_announce_text'>) => s.record_announce_text.trim() || DEFAULT_RECORD_NOTICE;

const MASK = '••••••';
const FINAL = ['completed', 'missed', 'voicemail', 'busy', 'no-answer', 'failed', 'canceled'];

export const CALL_TRIGGERS = ['call.missed', 'call.voicemail', 'call.completed'];

export interface Config {
  s: TelephonySettings;
  accountSid: string;
  token: string;
  numbers: string[];
  forward: string[];
  ownToken: boolean;
  smsFallback: boolean;
  ready: boolean;
  missing: string[];
}

/** Settings plus credentials; account SID, token and number fall back to the Twilio SMS settings. */
export function telephonyConfig(app: App, locationId: string): Config {
  const row = parseJson(app.db.get('SELECT * FROM telephony_settings WHERE location_id = ?', locationId), ['data']);
  const s: TelephonySettings = { ...DEFAULTS, ...(row?.data ?? {}) };
  s.hours = { ...DEFAULT_HOURS, ...(s.hours ?? {}) };
  const sms = app.location(locationId)?.settings.sms ?? {};
  const smsTwilio = sms.provider === 'twilio' && !!sms.accountSid;
  let token = '';
  if (row?.auth_token) {
    try {
      token = openSecret(app, row.auth_token);
    } catch {
      token = '';
    }
  }
  const accountSid = s.account_sid || (smsTwilio ? String(sms.accountSid) : '');
  let smsFallback = !s.account_sid && smsTwilio;
  if (!token && smsTwilio && accountSid === String(sms.accountSid) && sms.authToken) {
    token = String(sms.authToken);
    smsFallback = true;
  }
  const numbers = s.numbers.length ? s.numbers : smsTwilio && E164.test(String(sms.from ?? '')) ? [String(sms.from)] : [];
  const forward = s.forward_to;
  const missing = [
    !accountSid && 'Account SID',
    !token && 'Auth Token',
    !numbers.length && 'Twilio-Nummer',
    !forward.length && 'Weiterleitungsnummer (dein Handy)',
  ].filter(Boolean) as string[];
  return { s, accountSid, token, numbers, forward, ownToken: !!row?.auth_token, smsFallback, ready: !missing.length, missing };
}

const phoneList = (v: unknown, field: string): string[] => {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/);
  const list = uniq(raw.map((x) => normalizePhone(String(x))).filter(Boolean));
  for (const n of list) if (!E164.test(n)) throw bad(`${field}: ${n} ist keine gültige Nummer (Format +49…)`);
  return list.slice(0, 10);
};
const hm = (v: unknown, fallback: string) => {
  const s = String(v ?? '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : fallback;
};
const clamp = (v: unknown, min: number, max: number, fallback: number) => Math.min(max, Math.max(min, Math.round(num(v, fallback))));

function cleanSettings(b: any, cur: TelephonySettings): TelephonySettings {
  const s: TelephonySettings = { ...cur };
  if (b.account_sid !== undefined) {
    const v = str(b.account_sid, 'Account SID', { max: 64 });
    if (v && !ACCOUNT_SID.test(v)) throw bad('Account SID: beginnt mit AC und hat 34 Zeichen');
    s.account_sid = v;
  }
  if (b.numbers !== undefined) s.numbers = phoneList(b.numbers, 'Twilio-Nummer');
  if (b.forward_to !== undefined) s.forward_to = phoneList(b.forward_to, 'Weiterleitung');
  if (b.ring_timeout !== undefined) s.ring_timeout = clamp(b.ring_timeout, 5, 60, 20);
  if (b.hours_mode !== undefined) {
    if (!['always', 'hours', 'never'].includes(b.hours_mode)) throw bad('Erreichbarkeit unbekannt');
    s.hours_mode = b.hours_mode;
  }
  if (b.hours !== undefined) {
    if (!b.hours || typeof b.hours !== 'object') throw bad('Geschäftszeiten ungültig');
    s.hours = Object.fromEntries(
      DAYS.map(([k]) => {
        const d = b.hours[k] ?? cur.hours[k] ?? DEFAULT_HOURS[k];
        return [k, { open: !!d.open, from: hm(d.from, '09:00'), to: hm(d.to, '17:00') }];
      }),
    ) as Hours;
  }
  if (b.greeting !== undefined) s.greeting = str(b.greeting, 'Ansage', { max: 1000 });
  if (b.max_length !== undefined) s.max_length = clamp(b.max_length, 10, 600, 120);
  for (const k of ['voicemail', 'transcribe', 'record_inbound', 'record_outbound', 'notify_missed', 'notify_voicemail', 'record_announce'] as const) if (b[k] !== undefined) s[k] = !!b[k];
  if (b.record_announce_text !== undefined) s.record_announce_text = str(b.record_announce_text, 'Aufzeichnungs-Hinweis', { max: 500 });
  if (b.retention_recordings_days !== undefined) s.retention_recordings_days = clamp(b.retention_recordings_days, 0, 3650, 0);
  if (b.retention_voicemail_days !== undefined) s.retention_voicemail_days = clamp(b.retention_voicemail_days, 0, 3650, 0);
  return s;
}

// --- calls ---------------------------------------------------------------------------

type CallRow = Record<string, any>;

function describe(c: CallRow, who: string): { subject: string; body: string } {
  const inbound = c.direction === 'in';
  const party = inbound ? `von ${c.from_number || 'unbekannter Nummer'}` : `an ${who || c.to_number}`;
  switch (c.status) {
    case 'missed':
      return { subject: 'Verpasster Anruf', body: `Verpasster Anruf ${party}${c.reason === 'closed' ? ' (außerhalb der Geschäftszeiten)' : ''}` };
    case 'voicemail':
      return { subject: `Voicemail (${mmss(c.recording_duration)})`, body: c.transcription || `Voicemail ${party}` };
    case 'completed':
      return { subject: `${inbound ? 'Eingehender' : 'Ausgehender'} Anruf (${mmss(c.duration)})`, body: c.transcription || `Anruf ${party}${c.recording_sid ? ' · aufgezeichnet' : ''}` };
    case 'in-progress':
      return { subject: 'Anruf läuft', body: inbound ? `Anruf ${party}` : `Verbinde ${party}` };
    case 'busy':
      return { subject: 'Besetzt', body: `Anruf ${party}: besetzt` };
    case 'no-answer':
      return { subject: 'Nicht erreicht', body: c.reason === 'agent' ? `Anruf ${party}: du hast nicht abgenommen` : `Anruf ${party}: keine Antwort` };
    case 'failed':
      return { subject: 'Anruf fehlgeschlagen', body: c.error || `Anruf ${party} fehlgeschlagen` };
    case 'canceled':
      return { subject: 'Anruf abgebrochen', body: `Anruf ${party} abgebrochen` };
    default:
      return inbound ? { subject: 'Eingehender Anruf', body: `Anruf ${party}` } : { subject: 'Ausgehender Anruf', body: `Anruf ${party} – dein Telefon klingelt zuerst` };
  }
}

const getCall = (app: App, callId: string) => app.db.get<CallRow>('SELECT * FROM calls WHERE id = ?', callId)!;

/** Keeps the call's entry (channel "call") in Konversationen in step with the call. */
export function syncMessage(app: App, c: CallRow, opts: { unread?: boolean } = {}) {
  if (!c.contact_id) return;
  const contact = getContact(app, c.location_id, c.contact_id);
  if (!contact) return;
  const { subject, body } = describe(c, contactName(contact));
  const conv = getOrCreateConversation(app, c.location_id, c.contact_id);
  if (!c.message_id) {
    const mid = id();
    app.db.insert('messages', {
      id: mid,
      location_id: c.location_id,
      conversation_id: conv,
      contact_id: c.contact_id,
      channel: 'call',
      direction: c.direction,
      subject,
      body,
      status: c.status,
      error: c.error ?? '',
      source: 'Telefon',
      provider_id: c.sid ?? c.id,
      user_id: c.user_id ?? null,
      created_at: c.started_at,
    });
    app.db.run('UPDATE calls SET message_id = ? WHERE id = ?', mid, c.id);
    c.message_id = mid;
    app.db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', c.started_at, subject, conv);
  } else {
    app.db.run('UPDATE messages SET subject = ?, body = ?, status = ?, error = ?, provider_id = ? WHERE id = ?', subject, body, c.status, c.error ?? '', c.sid ?? c.id, c.message_id);
    app.db.run('UPDATE conversations SET last_message = ? WHERE id = ? AND last_message_at = ?', subject, conv, c.started_at);
  }
  if (opts.unread) app.db.run('UPDATE conversations SET unread = unread + 1, last_message_at = ?, last_message = ? WHERE id = ?', now(), subject, conv);
}

function eventData(c: CallRow) {
  return {
    contactId: c.contact_id ?? undefined,
    callId: c.id,
    direction: c.direction,
    status: c.status,
    from: c.from_number,
    to: c.to_number,
    duration: c.duration,
    voicemail_duration: c.recording_duration ?? 0,
    transcription: c.transcription ?? '',
  };
}

/** Ends a call once (later callbacks are no-ops), records it on the contact and fires the triggers. */
export function finalizeCall(app: App, call: CallRow, status: string, patch: { duration?: number; reason?: string } = {}): boolean {
  const at = now();
  const changed = app.db.run(
    'UPDATE calls SET status = ?, ended_at = ?, updated_at = ?, duration = ?, reason = ? WHERE id = ? AND ended_at IS NULL',
    status,
    at,
    at,
    Math.max(0, Math.round(patch.duration ?? call.duration ?? 0)),
    patch.reason ?? call.reason ?? '',
    call.id,
  ).changes;
  if (!changed) return false;
  const c = getCall(app, call.id);
  const missed = c.direction === 'in' && !c.answered;
  syncMessage(app, c, { unread: missed });
  const contact = c.contact_id ? getContact(app, c.location_id, c.contact_id) : undefined;
  const who = contact ? contactName(contact) : c.from_number || 'Unbekannt';
  if (missed) {
    if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'call.missed', `Verpasster Anruf${c.reason === 'closed' ? ' (außerhalb der Geschäftszeiten)' : ''}`);
    app.events.emit(c.location_id, 'call.missed', eventData(c));
    const cfg = telephonyConfig(app, c.location_id);
    if (cfg.s.notify_missed && c.status === 'missed') void notifyTeam(app, c.location_id, `Verpasster Anruf: ${who}`, `${who} (${c.from_number || 'Nummer unterdrückt'}) hat angerufen.\n\n${app.baseUrl()}/app/calls`);
  } else if (c.answered) {
    if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'call.completed', `${c.direction === 'in' ? 'Eingehender' : 'Ausgehender'} Anruf (${mmss(c.duration)})`);
    app.events.emit(c.location_id, 'call.completed', eventData(c));
  } else if (c.contact_id) {
    logActivity(app, c.location_id, c.contact_id, 'call.failed', describe(c, who).body);
  }
  return true;
}

/** Stores a recording once. For an unanswered inbound call that is a voicemail. */
function storeRecording(app: App, cfg: Config, call: CallRow, p: Record<string, string>, fromDial = false) {
  const rsid = p.RecordingSid ?? '';
  if (!RECORDING_SID.test(rsid) || !ACCOUNT_SID.test(cfg.accountSid)) return;
  if (p.RecordingStatus && p.RecordingStatus !== 'completed') return;
  const duration = Math.round(num(p.RecordingDuration, 0));
  if (p.RecordingDuration !== undefined && duration < 1) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Recordings/${rsid}`;
  const stored = app.db.run(
    'UPDATE calls SET recording_sid = ?, recording_url = ?, recording_duration = ?, recording_channels = ?, updated_at = ? WHERE id = ? AND recording_sid IS NULL',
    rsid,
    url,
    duration,
    num(p.RecordingChannels, 1) >= 2 ? 2 : 1,
    now(),
    call.id,
  ).changes;
  if (!stored) {
    if (duration) app.db.run('UPDATE calls SET recording_duration = ? WHERE id = ? AND COALESCE(recording_duration, 0) = 0', duration, call.id);
    return;
  }
  const c = getCall(app, call.id);
  // A recorded conversation (<Dial record>) is never a voicemail, even if its callback beats the Dial action.
  if (fromDial || p.RecordingSource === 'DialVerb' || c.direction !== 'in' || c.answered) {
    syncMessage(app, c);
    // Call intelligence (transcript, summary, scorecard) picks the finished recording up.
    app.events.emit(c.location_id, 'call.recorded', { contactId: c.contact_id ?? undefined, callId: c.id, voicemail: false, direction: c.direction, duration, channels: c.recording_channels });
    return;
  }
  // Voicemail: ends the call as "voicemail" (or upgrades an already missed one).
  if (!finalizeCall(app, c, 'voicemail')) {
    app.db.run(`UPDATE calls SET status = 'voicemail' WHERE id = ?`, c.id);
    syncMessage(app, getCall(app, c.id));
  }
  const v = getCall(app, c.id);
  const contact = v.contact_id ? getContact(app, v.location_id, v.contact_id) : undefined;
  const who = contact ? contactName(contact) : v.from_number || 'Unbekannt';
  if (v.contact_id) logActivity(app, v.location_id, v.contact_id, 'call.voicemail', `Voicemail erhalten (${mmss(v.recording_duration)})`);
  app.events.emit(v.location_id, 'call.voicemail', eventData(v));
  app.events.emit(v.location_id, 'call.recorded', { contactId: v.contact_id ?? undefined, callId: v.id, voicemail: true, direction: v.direction, duration: v.recording_duration ?? 0, channels: 1 });
  if (cfg.s.notify_voicemail) void notifyTeam(app, v.location_id, `Neue Voicemail${v.voicemail_box ? ` (${v.voicemail_box})` : ''}: ${who}`, `${who} (${v.from_number || 'Nummer unterdrückt'}) hat eine Voicemail hinterlassen (${mmss(v.recording_duration)}).\n\nAnhören: ${app.baseUrl()}/app/calls`);
}

function callOut(c: CallRow) {
  const { recording_url: _u, ...rest } = c;
  return {
    ...rest,
    contact_name: c.contact_id ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.contact_phone || '' : '',
    has_recording: !!c.recording_sid,
    recording: c.recording_sid ? `/api/calls/${c.id}/recording` : null,
    missed: c.direction === 'in' && !c.answered && FINAL.includes(c.status),
  };
}

// --- shared Twilio helpers (also used by the KI-Telefonagent and the browser phone) ------------

/** One Twilio REST call with the sub-account's credentials (tests swap the fetch via app.services.twilioFetch). */
export async function twilioRequest(app: App, cfg: Pick<Config, 'accountSid' | 'token'>, method: string, path: string, params?: [string, string][]) {
  if (!ACCOUNT_SID.test(cfg.accountSid) || !cfg.token) throw bad('Twilio-Zugangsdaten fehlen (Einstellungen → Telefonie)');
  const fetcher: typeof fetch = app.services.twilioFetch ?? fetch;
  const r = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.token}`).toString('base64')}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = r.status === 204 ? {} : await r.json().catch(() => ({}));
  // Twilio's own error code travels along (21631 = address needed …), so callers can explain it.
  if (!r.ok) throw new HttpError(502, `Twilio: ${j.message || `Fehler ${r.status}`}`, { twilio_code: j.code ?? null });
  return j;
}

/** Changes the list of the sub-account's own numbers in the telephony settings (a number bought or released here). */
export function updateConfiguredNumbers(app: App, locationId: string, fn: (numbers: string[]) => string[]): void {
  const row = parseJson(app.db.get('SELECT * FROM telephony_settings WHERE location_id = ?', locationId), ['data']);
  const data = { ...(row?.data ?? {}) } as Partial<TelephonySettings>;
  const next = uniq(fn(Array.isArray(data.numbers) ? data.numbers : []));
  data.numbers = next;
  if (!row) app.db.insert('telephony_settings', { location_id: locationId, data, updated_at: now() });
  else app.db.run('UPDATE telephony_settings SET data = ?, updated_at = ? WHERE location_id = ?', JSON.stringify(data), now(), locationId);
}

/** Whether `n` is one of the sub-account's own numbers: the configured ones, the forwarding targets and every number bought or tracked here. */
export function isOwnNumber(app: App, locationId: string, n: string): boolean {
  const cfg = telephonyConfig(app, locationId);
  if (cfg.numbers.includes(n) || cfg.forward.includes(n)) return true;
  try {
    return !!app.db.get(`SELECT 1 FROM phone_numbers WHERE location_id = ? AND number = ? AND status = 'active'`, locationId, n);
  } catch {
    return false; // the numbers module (and its table) is not loaded
  }
}

/** Refuses a webhook whose X-Twilio-Signature doesn't match the full URL and the POST parameters. */
export function verifyTwilio(app: App, ctx: Ctx, token: string) {
  const path = ctx.url.pathname + ctx.url.search;
  const urls = [app.config.baseUrl.replace(/\/$/, '') + path, app.baseUrl() + path];
  const form = String(ctx.req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
  // Twilio posts forms. A body of any other kind would not be covered by the signature (it signs the URL and the form fields only), yet the
  // handlers read it: so one signed request without fields could be paired with a body of somebody's choosing.
  if (!form && ctx.rawBody) throw new HttpError(403, 'Ungültige Twilio-Anfrage');
  const params = form ? [...new URLSearchParams(ctx.rawBody)] : [];
  if (!validTwilioSignature(token, ctx.req.headers['x-twilio-signature'] as string | undefined, urls, params)) throw new HttpError(403, 'Ungültige Twilio-Signatur');
}

/**
 * Hooks other modules fill in (app.services): `voiceAgent` may take an inbound call over (KI-Telefonagent),
 * `voiceDialTargets` adds browser clients to the ring group (Browser-Telefon), `voiceDialHeld` tells
 * whether a call is parked on hold right now (its Dial ending is then no hang-up).
 */
export interface VoiceAgentInput {
  /** `outbound`: the agent places the call itself (workflow action voice_ai_call, modules/voice-outbound.ts). */
  stage: 'inbound' | 'unanswered' | 'outbound';
  loc: LocationRow;
  call: Record<string, any>;
  open: boolean;
  /** A phone number or menu entry sends the call to the agent on purpose: answer whatever the agent's mode says. */
  force?: boolean;
  /** Outbound: the first sentence (instead of the inbound greeting) and the number of the person on the line. */
  greeting?: string;
  party?: string;
}
export interface DialTargets {
  numbers: string[];
  clients: { identity: string; params?: Record<string, string> }[];
}
/**
 * An inbound call as the routing hooks see it. `app.services.callInbound` (list of `(input) => void`) runs once when the call
 * row was created (campaign attribution); `app.services.callRouters` (list of `(input) => TwiML | undefined`) may take the call
 * over – the first answer wins, otherwise the default behaviour (ring forward numbers + browsers, voicemail, KI-Telefonagent) runs.
 */
export interface CallRouteInput {
  loc: LocationRow;
  call: Record<string, any>;
  cfg: Config;
  open: boolean;
  params: Record<string, string>;
}

// --- MCP ------------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_calls',
    title: 'Anrufe',
    description:
      'Anrufliste eines Projekts (Twilio-Telefonie): eingehend/ausgehend, Status (completed = angenommen, missed = verpasst, voicemail mit Transkription), Dauer in Sekunden, Kontakt. Filter: contact_id, status (z. B. "missed,voicemail"), direction (in|out), limit.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
        contact_id: { type: 'string' },
        status: { type: 'string', description: 'completed, missed, voicemail, no-answer, busy, failed – mehrere mit Komma' },
        direction: { type: 'string', enum: ['in', 'out'] },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const q = new URLSearchParams();
      for (const k of ['contact_id', 'status', 'direction']) if (a[k]) q.set(k, String(a[k]));
      q.set('limit', String(a.limit ?? 50));
      const r = await call.api('GET', `/api/calls?${q}`, { location: a.location_id });
      return {
        stats: r.stats,
        calls: r.calls.map((c: any) => ({
          id: c.id,
          direction: c.direction,
          status: c.status,
          from: c.from_number,
          to: c.to_number,
          contact: c.contact_id ? { id: c.contact_id, name: c.contact_name } : null,
          duration: c.duration,
          voicemail_duration: c.recording_duration ?? 0,
          transcription: c.transcription || undefined,
          has_recording: c.has_recording,
          started_at: c.started_at,
        })),
      };
    },
  },
];

// --- module ---------------------------------------------------------------------------

export const telephonyModule: Module = {
  name: 'telephony',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE telephony_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', auth_token TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE calls (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, message_id TEXT, sid TEXT,
        direction TEXT NOT NULL, from_number TEXT NOT NULL DEFAULT '', to_number TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', answered INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0,
        recording_sid TEXT, recording_url TEXT, recording_duration INTEGER, transcription TEXT NOT NULL DEFAULT '',
        user_id TEXT, error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, answered_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX calls_sid ON calls(location_id, sid);
      CREATE INDEX calls_started ON calls(location_id, started_at);
      CREATE INDEX calls_contact ON calls(contact_id, started_at);
      CREATE INDEX calls_open ON calls(ended_at, started_at);
      `,
    ],
    [
      // Where a call went (IVR / ring group / AI), which number and campaign it came in on, the dialer's outcome and the recording notice.
      '002-call-meta',
      `
      ALTER TABLE calls ADD COLUMN route_kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN route_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN route_node TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN route_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN voicemail_box TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN tracking_number_id TEXT;
      ALTER TABLE calls ADD COLUMN attr_source TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN attr_medium TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN attr_campaign TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN disposition TEXT NOT NULL DEFAULT '';
      ALTER TABLE calls ADD COLUMN dialer_item_id TEXT;
      ALTER TABLE calls ADD COLUMN consent_announced INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE calls ADD COLUMN recording_channels INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE calls ADD COLUMN wait_seconds INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX calls_attr ON calls(location_id, attr_source, started_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = (): typeof fetch => app.services.twilioFetch ?? fetch;
    const hook = (name: string, loc: string) => `${app.baseUrl()}/hooks/twilio/${name}/${loc}`;

    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...CALL_TRIGGERS];
    app.services.workflowRecipes = {
      ...(app.services.workflowRecipes ?? {}),
      missed_call: {
        name: 'Verpasster Anruf: SMS zurück + Rückruf-Aufgabe',
        trigger: { type: 'call.missed', config: {} },
        settings: { allow_reentry: true },
        steps: [
          { type: 'send_sms', body: 'Hallo {{contact.first_name|}}, sorry, wir haben deinen Anruf gerade verpasst. Wir rufen so schnell wie möglich zurück – oder antworte einfach hier per SMS. {{location.name}}' },
          { type: 'create_task', title: 'Rückruf: {{contact.name}} ({{contact.phone}})', due_in_days: 0 },
        ],
      },
    };

    const twilioApi = (cfg: Config, method: string, path: string, params?: [string, string][]) => twilioRequest(app, cfg, method, path, params);

    // --- settings -----------------------------------------------------------------
    const settingsOut = (locationId: string) => {
      const cfg = telephonyConfig(app, locationId);
      return {
        ...cfg.s,
        auth_token: cfg.ownToken ? MASK : '',
        auth_token_set: cfg.ownToken,
        uses_sms_credentials: cfg.smsFallback,
        effective_numbers: cfg.numbers,
        ready: cfg.ready,
        missing: cfg.missing,
        default_greeting: DEFAULT_GREETING,
        default_record_notice: DEFAULT_RECORD_NOTICE,
        webhooks: { voice: hook('voice', locationId), status: hook('voice-status', locationId) },
      };
    };
    const saveSettings = (locationId: string, s: TelephonySettings, token?: string | null) => {
      const cur = db.get('SELECT location_id FROM telephony_settings WHERE location_id = ?', locationId);
      if (!cur) db.insert('telephony_settings', { location_id: locationId, data: s, updated_at: now() });
      else db.run('UPDATE telephony_settings SET data = ?, updated_at = ? WHERE location_id = ?', JSON.stringify(s), now(), locationId);
      if (token !== undefined) db.run('UPDATE telephony_settings SET auth_token = ? WHERE location_id = ?', token ? sealSecret(app, token) : null, locationId);
    };

    router.get('/api/telephony/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/telephony/settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const cur = telephonyConfig(app, ctx.locationId);
      const s = cleanSettings(b, cur.s);
      const numbers = s.numbers.length ? s.numbers : cur.numbers;
      if (s.forward_to.some((n) => numbers.includes(n))) throw bad('Die Weiterleitung darf nicht auf die Twilio-Nummer selbst zeigen');
      let token: string | null | undefined;
      if (b.auth_token === null) token = null;
      else if (typeof b.auth_token === 'string' && b.auth_token && b.auth_token !== MASK) {
        const t = b.auth_token.trim();
        if (!/^\S{16,128}$/.test(t)) throw bad('Auth Token ungültig');
        token = t;
      }
      saveSettings(ctx.locationId, s, token);
      return settingsOut(ctx.locationId);
    });
    /** Twilio numbers of the account, to pick one and point its webhooks here. */
    router.get('/api/telephony/numbers', 'location', async (ctx) => {
      const cfg = telephonyConfig(app, ctx.locationId);
      const j = await twilioApi(cfg, 'GET', '/IncomingPhoneNumbers.json?PageSize=100');
      return (j.incoming_phone_numbers ?? []).map((n: any) => ({
        sid: n.sid,
        phone_number: n.phone_number,
        friendly_name: n.friendly_name,
        voice_url: n.voice_url ?? '',
        connected: n.voice_url === hook('voice', ctx.locationId) && n.status_callback === hook('voice-status', ctx.locationId),
        in_use: cfg.numbers.includes(n.phone_number),
      }));
    });
    router.post('/api/telephony/numbers/:sid/connect', 'location', async (ctx) => {
      if (!NUMBER_SID.test(ctx.params.sid)) throw bad('Nummer unbekannt');
      const cfg = telephonyConfig(app, ctx.locationId);
      const j = await twilioApi(cfg, 'POST', `/IncomingPhoneNumbers/${ctx.params.sid}.json`, [
        ['VoiceUrl', hook('voice', ctx.locationId)],
        ['VoiceMethod', 'POST'],
        ['StatusCallback', hook('voice-status', ctx.locationId)],
        ['StatusCallbackMethod', 'POST'],
      ]);
      if (E164.test(j.phone_number ?? '') && !cfg.s.numbers.includes(j.phone_number)) {
        if (cfg.s.forward_to.includes(j.phone_number)) throw bad('Diese Nummer ist als Weiterleitung eingetragen');
        saveSettings(ctx.locationId, { ...cfg.s, numbers: [...cfg.s.numbers, j.phone_number] });
      }
      return { ok: true, phone_number: j.phone_number, settings: settingsOut(ctx.locationId) };
    });
    router.post('/api/telephony/test-call', 'location', async (ctx) => {
      const cfg = telephonyConfig(app, ctx.locationId);
      if (!cfg.ready) throw bad(`Es fehlt noch: ${cfg.missing.join(', ')}`);
      const loc = app.location(ctx.locationId)!;
      const j = await twilioApi(cfg, 'POST', '/Calls.json', [
        ['To', cfg.forward[0]],
        ['From', cfg.numbers[0]],
        ['Twiml', hangup(`Hallo! Die Telefonie von ${loc.name} ist eingerichtet. Anrufe auf ${cfg.numbers[0].split('').join(' ')} kommen bei dir an.`)],
      ]);
      return { ok: true, sid: j.sid };
    });

    // --- calls (click-to-call, log, recordings) --------------------------------------
    const SELECT = `SELECT c.*, k.first_name, k.last_name, k.phone AS contact_phone FROM calls c LEFT JOIN contacts k ON k.id = c.contact_id`;
    const findCall = (locationId: string, key: string) => db.get<CallRow>(`${SELECT} WHERE c.location_id = ? AND (c.id = ? OR c.sid = ?)`, locationId, key, key);

    router.get('/api/calls/status', 'location', (ctx) => {
      const cfg = telephonyConfig(app, ctx.locationId);
      return { ready: cfg.ready, missing: cfg.missing, numbers: cfg.numbers, record_outbound: cfg.s.record_outbound };
    });
    router.get('/api/calls', 'location', (ctx) => {
      const where = ['c.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const contact = ctx.query.get('contact_id');
      if (contact) (where.push('c.contact_id = ?'), params.push(contact));
      const direction = ctx.query.get('direction');
      if (direction === 'in' || direction === 'out') (where.push('c.direction = ?'), params.push(direction));
      const statuses = (ctx.query.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
      if (statuses.length) (where.push(`c.status IN (${statuses.map(() => '?').join(',')})`), params.push(...statuses));
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push(`(c.from_number || ' ' || c.to_number || ' ' || COALESCE(k.first_name, '') || ' ' || COALESCE(k.last_name, '') || ' ' || c.transcription) LIKE ?`), params.push(`%${q}%`));
      const limit = Math.min(Math.max(1, num(ctx.query.get('limit'), 100)), 500);
      const calls: Record<string, any>[] = db.all<CallRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY c.started_at DESC LIMIT ?`, ...params, limit).map(callOut);
      // Notes written during the call and the analysis (call intelligence) belong to other modules' tables – best effort.
      if (calls.length) {
        const marks = calls.map(() => '?').join(',');
        const ids = calls.map((c) => c.id);
        try {
          const notes = new Map(db.all<{ call_id: string; n: number }>(`SELECT call_id, COUNT(*) n FROM call_notes WHERE call_id IN (${marks}) GROUP BY call_id`, ...ids).map((r) => [r.call_id, r.n]));
          const intel = new Map(db.all<{ call_id: string; id: string; status: string }>(`SELECT call_id, id, status FROM call_intel WHERE call_id IN (${marks})`, ...ids).map((r) => [r.call_id, r]));
          for (const c of calls) Object.assign(c, { notes_count: notes.get(c.id) ?? 0, intel_id: intel.get(c.id)?.id ?? null, intel_status: intel.get(c.id)?.status ?? null });
        } catch {
          /* the modules that own these tables are not loaded */
        }
      }
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const s = db.get<any>(
        `SELECT COUNT(*) total, SUM(direction = 'in') inbound, SUM(direction = 'out') outbound, SUM(status = 'missed') missed, SUM(status = 'voicemail') voicemail,
           SUM(answered) answered, COALESCE(SUM(CASE WHEN answered = 1 THEN duration END), 0) talk_seconds FROM calls WHERE location_id = ? AND started_at >= ?`,
        ctx.locationId,
        since,
      )!;
      const stats = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v ?? 0)]));
      return { calls, stats: { ...stats, days: 30 } };
    });
    router.get('/api/calls/:id', 'location', (ctx) => {
      const c = findCall(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      return callOut(c);
    });

    /** Click-to-call: Twilio rings your own phone first, announces the contact, then bridges the call. */
    router.post('/api/calls', 'location', async (ctx) => {
      const cfg = telephonyConfig(app, ctx.locationId);
      if (!cfg.ready) throw bad(`Telefonie ist noch nicht eingerichtet – es fehlt: ${cfg.missing.join(', ')} (Einstellungen → Telefonie)`);
      const contact = getContact(app, ctx.locationId, str(ctx.body.contact_id, 'Kontakt', { required: true }));
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const to = normalizePhone(contact.phone);
      if (!E164.test(to)) throw bad('Kontakt hat keine gültige Telefonnummer');
      if (isOwnNumber(app, ctx.locationId, to)) throw bad('Das ist eine eigene Nummer');
      const record = ctx.body.record !== undefined ? !!ctx.body.record : cfg.s.record_outbound;
      // A call the power dialer places: its rules (Nicht stören, consent, calling hours) are checked again here, on the server.
      let dialerItem: string | null = null;
      let listFrom = '';
      if (ctx.body.dialer_item_id) {
        const verdict: { ok: boolean; reason?: string; itemId?: string; from?: string } | undefined = app.services.dialer?.authorize(ctx.locationId, String(ctx.body.dialer_item_id), ctx.user?.id ?? null);
        if (!verdict) throw bad('Power-Dialer nicht verfügbar');
        if (!verdict.ok) throw bad(verdict.reason || 'Dieser Kontakt darf gerade nicht angerufen werden');
        dialerItem = verdict.itemId ?? String(ctx.body.dialer_item_id);
        listFrom = verdict.from ?? '';
      }
      // Caller ID: a Twilio number or a verified own number (modules/caller-ids.ts) – asked for, of the dialer list, or the default.
      const want = ctx.body.from ? String(ctx.body.from) : listFrom;
      const from: string = app.services.callerIds?.pick(ctx.locationId, want) ?? (want && cfg.numbers.includes(want) ? want : cfg.numbers[0]);
      const t = now();
      const row: CallRow = {
        id: id(),
        location_id: ctx.locationId,
        contact_id: contact.id,
        direction: 'out',
        from_number: from,
        to_number: to,
        status: 'initiated',
        user_id: ctx.user?.id ?? null,
        dialer_item_id: dialerItem,
        consent_announced: record && cfg.s.record_announce ? 1 : 0,
        started_at: t,
        updated_at: t,
      };
      db.insert('calls', row);
      syncMessage(app, getCall(app, row.id));
      const params: [string, string][] = [
        ['To', cfg.forward[0]],
        ['From', from],
        ['Twiml', bridgeTwiml({ announce: `Verbinde mit ${contactName(contact)}.`, callerId: from, number: to, action: hook('voice-dial', ctx.locationId), record, recordingCallback: `${hook('voice-recording', ctx.locationId)}?kind=dial`, announceUrl: cfg.s.record_announce ? hook('voice-announce', ctx.locationId) : undefined })],
        ['StatusCallback', hook('voice-status', ctx.locationId)],
        ['StatusCallbackMethod', 'POST'],
        ...['initiated', 'ringing', 'answered', 'completed'].map((e): [string, string] => ['StatusCallbackEvent', e]),
        ['Timeout', '25'],
      ];
      try {
        const j = await twilioApi(cfg, 'POST', '/Calls.json', params);
        db.run('UPDATE calls SET sid = ?, updated_at = ? WHERE id = ?', String(j.sid ?? '') || null, now(), row.id);
        syncMessage(app, getCall(app, row.id));
      } catch (e) {
        db.run('UPDATE calls SET error = ? WHERE id = ?', (e as Error).message.slice(0, 500), row.id);
        finalizeCall(app, getCall(app, row.id), 'failed', { reason: 'api' });
        throw e;
      }
      logActivity(app, ctx.locationId, contact.id, 'call.started', `Anruf gestartet${ctx.user ? ` von ${ctx.user.name}` : ''}${record ? ' (mit Aufzeichnung)' : ''}`);
      return callOut(findCall(ctx.locationId, row.id)!);
    });

    /** Twilio recording URLs need the account's credentials, so audio is streamed through here. */
    router.get('/api/calls/:id/recording', 'location', async (ctx) => {
      const c = findCall(ctx.locationId, ctx.params.id);
      if (!c?.recording_sid) throw notFound('Keine Aufnahme');
      const cfg = telephonyConfig(app, ctx.locationId);
      if (!RECORDING_SID.test(c.recording_sid) || !ACCOUNT_SID.test(cfg.accountSid) || !cfg.token) throw notFound('Keine Aufnahme');
      const range = String(ctx.req.headers.range ?? '');
      const r = await fetcher()(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Recordings/${c.recording_sid}.mp3`, {
        headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.token}`).toString('base64')}`, ...(/^bytes=\d*-\d*$/.test(range) ? { range } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, 'Aufnahme bei Twilio nicht verfügbar');
      const body = Buffer.from(await r.arrayBuffer());
      const headers: Record<string, string> = {
        'content-type': 'audio/mpeg',
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=3600',
        'content-disposition': `inline; filename="anruf-${c.started_at.slice(0, 10)}.mp3"`,
      };
      const cr = r.headers.get('content-range');
      if (cr) headers['content-range'] = cr;
      return { __raw: true, status: r.status === 206 ? 206 : 200, headers, body };
    });
    /** Deletes the recording at Twilio as well (privacy). */
    router.delete('/api/calls/:id/recording', 'location', async (ctx) => {
      const c = findCall(ctx.locationId, ctx.params.id);
      if (!c?.recording_sid) throw notFound('Keine Aufnahme');
      const cfg = telephonyConfig(app, ctx.locationId);
      try {
        await twilioApi(cfg, 'DELETE', `/Recordings/${c.recording_sid}.json`);
      } catch (e) {
        if (!String((e as Error).message).includes('404')) throw e;
      }
      db.run(`UPDATE calls SET recording_sid = NULL, recording_url = NULL, transcription = '', updated_at = ? WHERE id = ?`, now(), c.id);
      syncMessage(app, getCall(app, c.id));
      return { ok: true };
    });

    // --- Twilio webhooks (signed) ------------------------------------------------------
    const hookRoute = (name: string, fn: (loc: LocationRow, p: Record<string, string>, cfg: Config, query: URLSearchParams) => string) =>
      router.post(`/hooks/twilio/${name}/:loc`, 'public', (ctx) => {
        const loc = app.location(ctx.params.loc);
        if (!loc) throw notFound();
        const cfg = telephonyConfig(app, loc.id);
        verifyTwilio(app, ctx, cfg.token);
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.body ?? {})) if (typeof v === 'string') p[k] = v;
        return text(fn(loc, p, cfg, ctx.query), 'text/xml; charset=utf-8');
      });
    const callBySid = (loc: string, sid: string | undefined) => (sid ? db.get<CallRow>('SELECT * FROM calls WHERE location_id = ? AND sid = ?', loc, sid) : undefined);
    /** Greeting + voicemail recording. An IVR branch brings its own greeting, mailbox name and `record` (a branch always records). */
    const voicemail = (loc: LocationRow, cfg: Config, call: CallRow, o: { greeting?: string; box?: string; record?: boolean } = {}) => {
      const greeting = render(o.greeting || cfg.s.greeting || DEFAULT_GREETING, { location: loc });
      const record = o.record ?? cfg.s.voicemail;
      // Without voicemail the caller only hears the greeting – the call counts as missed right away.
      if (!record) finalizeCall(app, call, 'missed');
      const action = `${hook('voice-recording', loc.id)}${o.box ? `?box=${encodeURIComponent(o.box.slice(0, 80))}` : ''}`;
      return voicemailTwiml({ greeting, record, maxLength: cfg.s.max_length, action, transcribe: cfg.s.transcribe });
    };
    const isOpenNow = (loc: LocationRow, cfg: Config) => isOpen(cfg.s.hours_mode, cfg.s.hours, loc.timezone);
    /** Nobody took the call: the KI-Telefonagent (if it wants it), otherwise greeting + voicemail. */
    const unanswered = (loc: LocationRow, cfg: Config, call: CallRow): string =>
      (app.services.voiceAgent?.({ stage: 'unanswered', loc, call, open: isOpenNow(loc, cfg) } satisfies VoiceAgentInput) as string | undefined) ?? voicemail(loc, cfg, call);

    /** After a <Dial> to the team: somebody picked up → the call is over and counts as answered (with the talk time). */
    const settleDial = (call: CallRow, p: Record<string, string>): boolean => {
      const st = String(p.DialCallStatus ?? '');
      if (st !== 'completed' && st !== 'answered') return false;
      db.run('UPDATE calls SET answered = 1, answered_at = COALESCE(answered_at, ?), duration = ?, updated_at = ? WHERE id = ?', now(), Math.round(num(p.DialCallDuration, 0)), now(), call.id);
      finalizeCall(app, getCall(app, call.id), 'completed');
      return true;
    };
    // What the other telephony modules (IVR, ring groups, number routing, dialer) share – see docs/telephony.md#for-developers.
    app.services.telephonyKit = { hookRoute, hook, callBySid, voicemail, unanswered, isOpenNow, settleDial };

    /** TwiML for the called party's leg before a recorded outbound call is bridged: the recording notice. */
    hookRoute('voice-announce', (_loc, _p, cfg) => twiml(say(recordNotice(cfg.s))));

    /** Inbound call: forward to your mobile during business hours, otherwise greeting + voicemail. */
    hookRoute('voice', (loc, p, cfg) => {
      const sid = p.CallSid;
      if (!sid) throw bad('CallSid fehlt');
      let call = callBySid(loc.id, sid);
      if (!call) {
        const from = usableNumber(p.From);
        let contactId: string | null = null;
        if (from) {
          const phone = normalizePhone(from);
          contactId = db.get('SELECT id FROM contacts WHERE location_id = ? AND phone = ?', loc.id, phone)?.id ?? upsertContact(app, loc.id, { phone }, { source: 'Anruf' }).contact.id;
        }
        const t = now();
        const row: CallRow = { id: id(), location_id: loc.id, contact_id: contactId, sid, direction: 'in', from_number: from, to_number: String(p.To ?? ''), status: 'ringing', started_at: t, updated_at: t };
        db.insert('calls', row);
        call = getCall(app, row.id);
        syncMessage(app, call);
        // Campaign attribution (tracking numbers, dynamic number insertion) – a failure never stops the call.
        for (const fn of app.services.callInbound ?? []) {
          try {
            fn({ loc, call, cfg, open: false, params: p } satisfies CallRouteInput);
          } catch (e) {
            console.error('[telephony] callInbound:', (e as Error).message);
          }
        }
        call = getCall(app, row.id);
      }
      const open = isOpenNow(loc, cfg);
      // Routing by dialled number (IVR, ring group, queue …): the first hook with an answer takes the call.
      for (const route of app.services.callRouters ?? []) {
        const out: string | undefined = route({ loc, call, cfg, open, params: p } satisfies CallRouteInput);
        if (out) return out;
      }
      const agent: string | undefined = app.services.voiceAgent?.({ stage: 'inbound', loc, call, open } satisfies VoiceAgentInput);
      if (agent) return agent;
      const targets: DialTargets = app.services.voiceDialTargets?.({ locationId: loc.id, call, forward: cfg.forward }) ?? { numbers: cfg.forward, clients: [] };
      if (open && (targets.numbers.length || targets.clients.length)) {
        const announce = cfg.s.record_inbound && cfg.s.record_announce;
        if (announce) db.run('UPDATE calls SET consent_announced = 1 WHERE id = ?', call.id);
        return dialTwiml({ ...targets, timeout: cfg.s.ring_timeout, action: hook('voice-dial', loc.id), record: cfg.s.record_inbound, recordingCallback: `${hook('voice-recording', loc.id)}?kind=dial`, announce: announce ? recordNotice(cfg.s) : undefined });
      }
      db.run('UPDATE calls SET reason = ? WHERE id = ?', open ? 'no_forward' : 'closed', call.id);
      return unanswered(loc, cfg, getCall(app, call.id));
    });

    /** After the <Dial>: answered → done; nobody picked up → voicemail (inbound) or end (click-to-call). */
    hookRoute('voice-dial', (loc, p, cfg) => {
      const call = callBySid(loc.id, p.CallSid);
      if (!call) return hangup();
      // Parked on hold from the browser phone: the ring group ended on purpose, the call goes on.
      if (app.services.voiceDialHeld?.(call)) return twiml('');
      const st = String(p.DialCallStatus ?? '');
      if (settleDial(call, p)) return hangup();
      if (call.direction === 'out') {
        finalizeCall(app, call, ['busy', 'no-answer', 'failed', 'canceled'].includes(st) ? st : 'no-answer', { reason: 'contact' });
        return hangup();
      }
      db.run(`UPDATE calls SET reason = 'no_answer' WHERE id = ?`, call.id);
      return unanswered(loc, cfg, getCall(app, call.id));
    });

    /** <Record> action, recording status and transcription callbacks. */
    hookRoute('voice-recording', (loc, p, cfg, query) => {
      const call = callBySid(loc.id, p.CallSid);
      if (!call) return hangup();
      // Voicemail of an IVR branch: which box the caller chose.
      const box = (query.get('box') ?? '').slice(0, 80);
      if (box) db.run('UPDATE calls SET voicemail_box = ? WHERE id = ?', box, call.id);
      storeRecording(app, cfg, getCall(app, call.id), p, query.get('kind') === 'dial');
      if (p.TranscriptionText !== undefined && (p.TranscriptionStatus ?? 'completed') === 'completed') {
        db.run('UPDATE calls SET transcription = ?, updated_at = ? WHERE id = ?', String(p.TranscriptionText).slice(0, 5000), now(), call.id);
        syncMessage(app, getCall(app, call.id));
      }
      return hangup('Vielen Dank für Ihre Nachricht. Auf Wiederhören.');
    });

    /** Call progress; the final status settles anything the other callbacks didn't. */
    hookRoute('voice-status', (loc, p) => {
      const call = callBySid(loc.id, p.CallSid);
      if (!call) return twiml('');
      const st = String(p.CallStatus ?? '');
      if (['queued', 'initiated', 'ringing', 'in-progress'].includes(st)) {
        if (!call.ended_at) {
          db.run('UPDATE calls SET status = ?, updated_at = ? WHERE id = ?', st === 'queued' ? 'initiated' : st, now(), call.id);
          syncMessage(app, getCall(app, call.id));
        }
        return twiml('');
      }
      if (call.ended_at) return twiml('');
      if (call.direction === 'in') {
        finalizeCall(app, call, call.answered ? 'completed' : call.recording_sid ? 'voicemail' : 'missed', { duration: call.answered ? call.duration || num(p.CallDuration, 0) : 0 });
      } else if (call.answered) {
        finalizeCall(app, call, 'completed');
      } else {
        // The Dial never ran: you didn't pick up your own phone (or hung up during the announcement).
        finalizeCall(app, call, st === 'completed' ? 'canceled' : ['busy', 'no-answer', 'failed', 'canceled'].includes(st) ? st : 'failed', { reason: 'agent' });
      }
      return twiml('');
    });

    // Calls whose final callback never came (e.g. no status URL on the number) are settled after Twilio's 4-hour limit.
    let lastSweep = 0;
    app.onTick(() => {
      if (Date.now() - lastSweep < 60_000) return;
      lastSweep = Date.now();
      const stale = db.all<CallRow>('SELECT * FROM calls WHERE ended_at IS NULL AND started_at < ? LIMIT 100', new Date(Date.now() - 4 * 3600_000 - 5 * 60_000).toISOString());
      for (const c of stale) finalizeCall(app, c, c.answered ? 'completed' : c.recording_sid ? 'voicemail' : c.direction === 'in' ? 'missed' : 'failed');
    });
  },
};
