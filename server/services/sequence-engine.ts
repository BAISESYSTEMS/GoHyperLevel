import type { App } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { parseJson } from '../core/db.js';
import { render } from '../core/template.js';
import { isValidTz, ymdInTz, zonedToUtc } from '../core/time.js';
import { id } from '../core/util.js';
import { contactVars, getContact, logActivity, type Contact } from './contacts.js';
import { MailError, canSend } from './mailbox-kit.js';
import { sendMail, type MailInput, type SendResult } from './mailbox-send.js';
import { getMailbox, ownerMayUse, type MailboxRow } from './mailbox-sync.js';
import { unsubscribeToken } from './messaging.js';
import { DEFAULT_SETTINGS, STOP_LABEL, cleanSettings, dueAt, footerText, inWindow, nextSlot, pickVariant, type SequenceSettings, type Step, type StopReason } from './sequence-model.js';

/**
 * Sequences at work: enrolling people, sending the mails from the sender's own mailbox inside the business hours, creating the tasks
 * of call and LinkedIn steps, ending an enrolment when the person answers, books a meeting, a deal moves or they unsubscribe –
 * and the numbers (docs/sales.md). The tick calls `runDue`; the module's event listeners call `stopContact`.
 *
 * Every mail passes the same gates as any other message: "Nicht stören", the channel DND, and – for a sequence in the "marketing"
 * mode – the consent gate. "Einzelkorrespondenz" (individual) marks the sequence as personal 1:1 correspondence, which the gate
 * treats like a conversation; the person who sets it confirms their responsibility (legal note in docs/sales.md).
 */

export interface SeqRow {
  id: string;
  location_id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'paused';
  mode: 'marketing' | 'individual';
  legal_ack_by: string | null;
  legal_ack_at: string | null;
  owner_user_id: string | null;
  steps: Step[];
  settings: SequenceSettings;
  created_at: string;
  updated_at: string;
}
export interface EnrollRow {
  id: string;
  location_id: string;
  sequence_id: string;
  contact_id: string;
  user_id: string | null;
  deal_id: string | null;
  status: 'active' | 'waiting' | 'finished' | 'stopped';
  stop_reason: string;
  step_index: number;
  next_at: string | null;
  task_id: string | null;
  variants: Record<string, string>;
  source: string;
  note: string;
  last_message_id: string | null;
  failures: number;
  enrolled_at: string;
  updated_at: string;
  finished_at: string | null;
}

export const DEFAULT_DAILY_LIMIT = 100;
export const MAX_DAILY_LIMIT = 500;
export const BATCH = 25;

export const getSequence = (app: App, loc: string, sid: string): SeqRow | undefined => {
  const row = parseJson(app.db.get('SELECT * FROM sequences WHERE id = ? AND location_id = ?', sid, loc), ['steps', 'settings']) as SeqRow | undefined;
  if (row) row.settings = cleanSettings(row.settings, isValidTz, DEFAULT_SETTINGS);
  return row;
};
const enrollment = (r: any): EnrollRow => parseJson(r, ['variants']) as EnrollRow;

const tzOf = (app: App, loc: string, s: SequenceSettings) => s.window.tz || app.location(loc)?.timezone || 'Europe/Berlin';

// --- limits -----------------------------------------------------------------------------------------------------------------

export function dailyLimit(app: App, loc: string, userId: string | null): number {
  const row = app.db.get<{ daily_limit: number; user_limits: string }>('SELECT daily_limit, user_limits FROM sequence_settings WHERE location_id = ?', loc);
  const per = row ? (JSON.parse(row.user_limits || '{}') as Record<string, number>) : {};
  const n = userId && per[userId] !== undefined ? per[userId] : (row?.daily_limit ?? DEFAULT_DAILY_LIMIT);
  return Math.min(MAX_DAILY_LIMIT, Math.max(0, Math.round(Number(n))));
}

/** E-mails a person's sequences sent today (the sub-account's day). */
export function sentToday(app: App, loc: string, userId: string | null, at: Date): number {
  const tz = app.location(loc)?.timezone || 'Europe/Berlin';
  const start = zonedToUtc(ymdInTz(at, tz), '00:00', tz).toISOString();
  return Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sequence_events WHERE location_id = ? AND user_id IS ? AND kind = 'sent' AND at >= ? AND at <= ?`, loc, userId, start, at.toISOString())?.n ?? 0);
}

// --- who sends --------------------------------------------------------------------------------------------------------------

/** The mailbox a person's sequence mail leaves from: their own, or (when the sequence allows it) the sub-account's. */
export function senderMailbox(app: App, loc: string, userId: string | null, shared: boolean): MailboxRow | undefined {
  const usable = (mb: MailboxRow | undefined) => !!mb && !!mb.enabled && canSend(mb.access) && mb.status !== 'error';
  if (userId) {
    for (const r of app.db.all<{ id: string }>(`SELECT id FROM mailboxes WHERE scope = 'user' AND owner_user_id = ? ORDER BY created_at`, userId)) {
      const mb = getMailbox(app, r.id);
      if (usable(mb)) return mb;
    }
  }
  if (shared) {
    for (const r of app.db.all<{ id: string }>(`SELECT id FROM mailboxes WHERE scope = 'location' AND location_id = ? ORDER BY created_at`, loc)) {
      const mb = getMailbox(app, r.id);
      if (usable(mb)) return mb;
    }
  }
  return undefined;
}

const hasEmailStep = (s: SeqRow) => s.steps.some((x) => x.type === 'email');

// --- events and ending -----------------------------------------------------------------------------------------------

export type EventKind = 'enrolled' | 'sent' | 'task' | 'reply' | 'meeting' | 'stopped' | 'blocked' | 'failed' | 'skipped' | 'limit' | 'finished';

function event(app: App, e: EnrollRow, kind: EventKind, o: { step?: Step; variant?: string; message?: string | null; detail?: string; at?: Date } = {}) {
  app.db.insert('sequence_events', {
    id: id(),
    location_id: e.location_id,
    sequence_id: e.sequence_id,
    enrollment_id: e.id,
    contact_id: e.contact_id,
    user_id: e.user_id,
    step_id: o.step?.id ?? null,
    variant_id: o.variant ?? null,
    kind,
    message_id: o.message ?? null,
    detail: (o.detail ?? '').slice(0, 300),
    at: (o.at ?? new Date()).toISOString(),
  });
}

/** Ends an enrolment (once): the reason is kept, the sequence goes on for nobody else. */
export function stopEnrollment(app: App, e: EnrollRow, reason: StopReason, detail = '', at = new Date()): boolean {
  const r = app.db.run(`UPDATE sequence_enrollments SET status = 'stopped', stop_reason = ?, note = ?, next_at = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'waiting')`, reason, (detail || STOP_LABEL[reason]).slice(0, 300), at.toISOString(), at.toISOString(), e.id);
  if (!r.changes) return false;
  event(app, e, 'stopped', { detail: `${STOP_LABEL[reason]}${detail ? `: ${detail}` : ''}`, at });
  app.events.emit(e.location_id, 'sequence.stopped', { contactId: e.contact_id, sequenceId: e.sequence_id, enrollmentId: e.id, reason });
  return true;
}

/**
 * Something happened to a contact: every running enrolment whose sequence stops on it ends. `always` reasons (unsubscribe,
 * no consent) end all of them; the others only where the sequence's settings ask for it. Returns the sequences that stopped.
 */
export function stopContact(app: App, loc: string, contactId: string, reason: StopReason, o: { detail?: string; message?: string | null; dealId?: string; at?: Date; sinceOnly?: string } = {}): number {
  if (reason === 'reply') return replyReceived(app, loc, contactId, o);
  const always = reason === 'unsubscribed' || reason === 'consent' || reason === 'manual' || reason === 'contact_removed';
  const rows = app.db.all(
    `SELECT e.*, s.settings AS seq_settings FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE e.location_id = ? AND e.contact_id = ? AND e.status IN ('active', 'waiting')`,
    loc,
    contactId,
  );
  let n = 0;
  for (const raw of rows) {
    const { seq_settings, ...rest } = raw as any;
    const e = enrollment(rest);
    if (o.dealId && e.deal_id && e.deal_id !== o.dealId) continue;
    const settings = cleanSettings(JSON.parse(seq_settings || '{}'), isValidTz, DEFAULT_SETTINGS);
    const key = reason as keyof SequenceSettings['stop_on'];
    if (!always && !settings.stop_on[key]) continue;
    if (stopEnrollment(app, e, reason, o.detail, o.at)) n++;
  }
  return n;
}

/** How long after the last step a reply still counts as an answer to the sequence. */
export const REPLY_WINDOW_DAYS = 14;

/**
 * The contact answered. Every enrolment that was already running when the message arrived records the reply (once) – also one
 * that has just run through its last step – and ends when its sequence stops on replies. Messages from before the enrolment (the
 * first import of a mailbox) say nothing about the sequence.
 */
export function replyReceived(app: App, loc: string, contactId: string, o: { detail?: string; message?: string | null; at?: Date; sinceOnly?: string; enrollmentId?: string } = {}): number {
  const at = o.at ?? new Date();
  const rows = app.db.all(
    `SELECT e.*, s.settings AS seq_settings FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
     WHERE e.location_id = ? AND e.contact_id = ? AND (e.status IN ('active', 'waiting') OR (e.status = 'finished' AND e.finished_at >= ?))${o.enrollmentId ? ' AND e.id = ?' : ''}`,
    loc,
    contactId,
    new Date(at.getTime() - REPLY_WINDOW_DAYS * 864e5).toISOString(),
    ...(o.enrollmentId ? [o.enrollmentId] : []),
  );
  let n = 0;
  for (const raw of rows) {
    const { seq_settings, ...rest } = raw as any;
    const e = enrollment(rest);
    if (o.sinceOnly && o.sinceOnly <= e.enrolled_at) continue;
    if (!app.db.get(`SELECT 1 AS x FROM sequence_events WHERE enrollment_id = ? AND kind = 'reply'`, e.id)) {
      event(app, e, 'reply', { message: o.message, detail: o.detail, ...lastSent(app, e), at });
      app.events.emit(loc, 'sequence.replied', { contactId, sequenceId: e.sequence_id, enrollmentId: e.id });
    }
    if ((e.status === 'active' || e.status === 'waiting') && cleanSettings(JSON.parse(seq_settings || '{}'), isValidTz, DEFAULT_SETTINGS).stop_on.reply && stopEnrollment(app, e, 'reply', o.detail, at)) n++;
  }
  return n;
}

/**
 * Answers that came in without an event: a connected mailbox files its mail without announcing it (only when the mailbox is set to
 * start workflows), and an answer can come on any channel. The tick looks at the messages itself, so a sequence never writes to
 * somebody who has answered.
 */
export function sweepReplies(app: App, at = new Date(), limit = 200): number {
  const rows = app.db.all<{ eid: string; loc: string; cid: string; mid: string; created_at: string; subject: string | null }>(
    `SELECT e.id AS eid, e.location_id AS loc, e.contact_id AS cid, m.id AS mid, MIN(m.created_at) AS created_at, m.subject
     FROM sequence_enrollments e JOIN messages m ON m.contact_id = e.contact_id AND m.direction = 'in' AND m.created_at > e.enrolled_at
     WHERE (e.status IN ('active', 'waiting') OR (e.status = 'finished' AND e.finished_at >= ?)) AND m.channel != 'call'
       AND NOT EXISTS (SELECT 1 FROM sequence_events v WHERE v.enrollment_id = e.id AND v.kind = 'reply')
     GROUP BY e.id ORDER BY created_at LIMIT ?`,
    new Date(at.getTime() - REPLY_WINDOW_DAYS * 864e5).toISOString(),
    limit,
  );
  let n = 0;
  for (const r of rows) n += replyReceived(app, r.loc, r.cid, { enrollmentId: r.eid, message: r.mid, detail: String(r.subject ?? '').slice(0, 120), at: new Date(r.created_at) });
  return n;
}

/** A booked meeting counts for the sequence's numbers even when it does not stop it. */
export function meetingBooked(app: App, loc: string, contactId: string, at = new Date()): void {
  const rows = app.db.all(
    `SELECT e.*, s.settings AS seq_settings FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
     WHERE e.location_id = ? AND e.contact_id = ? AND (e.status IN ('active', 'waiting') OR e.finished_at >= ?)`,
    loc,
    contactId,
    new Date(at.getTime() - 14 * 864e5).toISOString(),
  );
  for (const raw of rows) {
    const { seq_settings, ...rest } = raw as any;
    const e = enrollment(rest);
    if (!app.db.get(`SELECT 1 AS x FROM sequence_events WHERE enrollment_id = ? AND kind = 'meeting'`, e.id)) event(app, e, 'meeting', { detail: 'Termin gebucht', ...lastSent(app, e), at });
    if (cleanSettings(JSON.parse(seq_settings || '{}'), isValidTz, DEFAULT_SETTINGS).stop_on.meeting) stopEnrollment(app, e, 'meeting', '', at);
  }
}

/** The step and variant of the last mail of an enrolment (a reply belongs to it). */
function lastSent(app: App, e: EnrollRow): { step?: Step; variant?: string } {
  const r = app.db.get<{ step_id: string; variant_id: string | null }>(`SELECT step_id, variant_id FROM sequence_events WHERE enrollment_id = ? AND kind = 'sent' ORDER BY at DESC, rowid DESC LIMIT 1`, e.id);
  return r ? { step: { id: r.step_id } as Step, variant: r.variant_id ?? '' } : {};
}

// --- enrolling --------------------------------------------------------------------------------------------------------------

export interface EnrollResult {
  enrolled: string[];
  skipped: { contact_id: string; reason: string }[];
}

/** A person is "gate-checked" for a sequence: the reason they must not get its mails, or '' when they may. */
export function whyNot(app: App, seq: SeqRow, contact: Contact): string {
  if (contact.dnd) return 'Nicht stören ist aktiv';
  if (hasEmailStep(seq) && !contact.email) return 'Keine E-Mail-Adresse';
  const dnd = app.services.channelDnd?.(seq.location_id, contact.id, 'email') as string | undefined;
  if (dnd) return dnd;
  if (hasEmailStep(seq) && seq.mode === 'marketing') {
    const v = app.services.consent?.judge?.({ locationId: seq.location_id, contact, channel: 'email', purpose: 'marketing', bulk: true }) as { allow: boolean; reason: string } | undefined;
    if (v && !v.allow) return v.reason || 'Keine Einwilligung';
  }
  return '';
}

export function enroll(app: App, seq: SeqRow, contactIds: string[], o: { userId: string | null; source?: string; dealId?: string | null; at?: Date }): EnrollResult {
  if (seq.status !== 'active') throw new HttpError(409, 'Die Sequenz ist nicht aktiv – erst aktivieren');
  const at = o.at ?? new Date();
  if (hasEmailStep(seq) && !senderMailbox(app, seq.location_id, o.userId, seq.settings.shared_mailbox)) {
    const who = o.userId ? (app.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', o.userId)?.name ?? 'Die Person') : 'Ohne Person';
    throw new HttpError(409, `${who} hat kein Postfach zum Senden verbunden (Einstellungen → E-Mail & SMS → Postfach verbinden) – die Sequenz sendet E-Mails aus dem eigenen Postfach`);
  }
  const tz = tzOf(app, seq.location_id, seq.settings);
  const out: EnrollResult = { enrolled: [], skipped: [] };
  for (const cid of [...new Set(contactIds)].slice(0, 1000)) {
    const c = getContact(app, seq.location_id, cid);
    if (!c) {
      out.skipped.push({ contact_id: cid, reason: 'Kontakt nicht gefunden' });
      continue;
    }
    if (app.db.get(`SELECT 1 AS x FROM sequence_enrollments WHERE sequence_id = ? AND contact_id = ? AND status IN ('active', 'waiting')`, seq.id, cid)) {
      out.skipped.push({ contact_id: cid, reason: 'Ist schon in dieser Sequenz' });
      continue;
    }
    const why = whyNot(app, seq, c);
    if (why) {
      out.skipped.push({ contact_id: cid, reason: why });
      continue;
    }
    const eid = id();
    const first = seq.steps[0];
    const row = {
      id: eid,
      location_id: seq.location_id,
      sequence_id: seq.id,
      contact_id: cid,
      user_id: o.userId,
      deal_id: o.dealId ?? null,
      status: 'active',
      stop_reason: '',
      step_index: 0,
      next_at: dueAt(at, first, seq.settings.window, tz, eid).toISOString(),
      variants: {},
      source: o.source ?? 'manuell',
      note: '',
      failures: 0,
      enrolled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    app.db.insert('sequence_enrollments', row);
    event(app, enrollment({ ...row, variants: '{}' }), 'enrolled', { detail: row.source, at });
    logActivity(app, seq.location_id, cid, 'sequence.enrolled', `In Sequenz „${seq.name}“ aufgenommen`, { sequence_id: seq.id });
    app.events.emit(seq.location_id, 'sequence.enrolled', { contactId: cid, sequenceId: seq.id, enrollmentId: eid, userId: o.userId });
    out.enrolled.push(cid);
  }
  return out;
}

// --- running ----------------------------------------------------------------------------------------------------------------

let running = false;
const delay = (at: Date, ms: number) => new Date(at.getTime() + ms);

/** Sends and creates what is due. One run at a time; a batch is small so the tick stays short. */
export async function runDue(app: App, at = new Date(), limit = BATCH): Promise<{ sent: number; tasks: number; deferred: number; stopped: number; resumed: number }> {
  const out = { sent: 0, tasks: 0, deferred: 0, stopped: 0, resumed: 0 };
  if (running) return out;
  running = true;
  try {
    const iso = at.toISOString();
    out.stopped += sweepReplies(app, at);
    // Waiting for a task that nobody ticked off: the sequence goes on after `max_wait_days`.
    for (const raw of app.db.all(`SELECT * FROM sequence_enrollments WHERE status = 'waiting' AND next_at <= ? ORDER BY next_at LIMIT ?`, iso, limit)) {
      const e = enrollment(raw);
      const seq = getSequence(app, e.location_id, e.sequence_id);
      if (!seq || seq.status !== 'active') continue;
      event(app, e, 'skipped', { detail: 'Aufgabe nicht erledigt – die Sequenz geht weiter', at });
      resume(app, e, seq, at);
      out.resumed++;
    }
    const due = app.db.all(
      `SELECT e.* FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE e.status = 'active' AND s.status = 'active' AND e.next_at <= ? ORDER BY e.next_at LIMIT ?`,
      iso,
      limit,
    );
    for (const raw of due) {
      const e = enrollment(raw);
      const seq = getSequence(app, e.location_id, e.sequence_id);
      if (!seq) continue;
      // Claim it: a second run (or process) must not send it again while this one is on the way.
      if (!app.db.run(`UPDATE sequence_enrollments SET next_at = ? WHERE id = ? AND status = 'active' AND next_at = ?`, delay(at, 10 * 60_000).toISOString(), e.id, e.next_at).changes) continue;
      try {
        const r = await processOne(app, e, seq, at);
        out[r === 'sent' ? 'sent' : r === 'task' ? 'tasks' : r === 'deferred' ? 'deferred' : r === 'stopped' ? 'stopped' : 'resumed']++;
      } catch (err) {
        console.error('[sequences]', e.id, (err as Error).message);
        app.db.run(`UPDATE sequence_enrollments SET next_at = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'active'`, delay(at, 30 * 60_000).toISOString(), `Fehler: ${(err as Error).message}`.slice(0, 300), iso, e.id);
      }
    }
  } finally {
    running = false;
  }
  return out;
}

type Outcome = 'sent' | 'task' | 'deferred' | 'stopped' | 'resumed';

async function processOne(app: App, e: EnrollRow, seq: SeqRow, at: Date): Promise<Outcome> {
  const loc = e.location_id;
  const iso = at.toISOString();
  const step = seq.steps[e.step_index];
  if (!step) {
    finish(app, e, at);
    return 'resumed';
  }
  const s = seq.settings;
  const tz = tzOf(app, loc, s);
  const defer = (to: Date, note: string, kind?: EventKind) => {
    app.db.run(`UPDATE sequence_enrollments SET next_at = ?, note = ?, updated_at = ? WHERE id = ?`, to.toISOString(), note, iso, e.id);
    if (kind) event(app, e, kind, { step, detail: note, at });
    return 'deferred' as const;
  };
  // The person who sends must still work in this sub-account.
  if (e.user_id && !ownerMayUse(app, e.user_id, loc)) {
    stopEnrollment(app, e, 'paused_user', '', at);
    return 'stopped';
  }
  const contact = getContact(app, loc, e.contact_id);
  if (!contact) {
    stopEnrollment(app, e, 'contact_removed', '', at);
    return 'stopped';
  }
  // Business hours: outside them nothing leaves – the step waits for the window to open.
  if (!inWindow(at, s.window, tz)) return defer(nextSlot(at, s.window, tz, e.id), 'Außerhalb der Sendezeiten – geht im nächsten Zeitfenster raus');
  const dnd = contact.dnd ? 'Nicht stören ist aktiv' : ((app.services.channelDnd?.(loc, contact.id, 'email') as string | undefined) ?? '');
  if (step.type === 'email' && dnd) {
    event(app, e, 'blocked', { step, detail: dnd, at });
    stopEnrollment(app, e, 'unsubscribed', dnd, at);
    return 'stopped';
  }

  const vars = varsFor(app, seq, e, contact);
  if (step.type !== 'email') return task(app, e, seq, step, contact, vars, at);

  if (!contact.email) {
    event(app, e, 'skipped', { step, detail: 'Keine E-Mail-Adresse', at });
    advance(app, e, seq, at);
    return 'resumed';
  }
  // What the series may rely on: the proof is marked with it (confirmed, or legacy contacts the policy lets through).
  let basis = '';
  if (seq.mode === 'marketing') {
    const v = app.services.consent?.judge?.({ locationId: loc, contact, channel: 'email', purpose: 'marketing', bulk: true }) as { allow: boolean; reason: string; basis?: string } | undefined;
    basis = v?.basis ?? '';
    if (v && !v.allow) {
      event(app, e, 'blocked', { step, detail: v.reason, at });
      stopEnrollment(app, e, 'consent', v.reason, at);
      return 'stopped';
    }
  }
  // The daily limit of the person: what is over waits for the window of the next day.
  const limit = dailyLimit(app, loc, e.user_id);
  if (sentToday(app, loc, e.user_id, at) >= limit) {
    const tomorrow = nextSlot(new Date(zonedToUtc(ymdInTz(at, app.location(loc)?.timezone || 'Europe/Berlin'), '23:59', app.location(loc)?.timezone || 'Europe/Berlin').getTime() + 2 * 60_000), s.window, tz, e.id);
    return defer(tomorrow, `Tageslimit von ${limit} E-Mails erreicht – morgen geht es weiter`, 'limit');
  }
  const mb = senderMailbox(app, loc, e.user_id, s.shared_mailbox);
  if (!mb) return defer(delay(at, 6 * 3_600_000), 'Kein Postfach zum Senden verbunden', 'blocked');

  const variant = pickVariant(step, e.id);
  const subject = render(variant.subject || step.subject, vars).replace(/[\r\n]+/g, ' ').trim();
  let body = render(variant.body || step.body, vars);
  // A series (marketing mode) always carries the unsubscribe link; only personal correspondence may leave it out.
  if (s.footer || seq.mode === 'marketing') body += footerText(`${app.baseUrl()}/u/${contact.id}/${unsubscribeToken(app, contact.id)}`);
  const input: MailInput = { to: contact.email, subject, body, contact_id: contact.id };
  if (step.reply_in_thread && e.last_message_id) input.reply_to_message_id = e.last_message_id;
  let sent: SendResult;
  try {
    sent = await mailer(app)(app, mb, { locationId: loc, userId: null }, input);
  } catch (err) {
    // A thread that cannot be found (the first mail was removed) is no reason to stop: send a new mail instead.
    if (input.reply_to_message_id && err instanceof HttpError && err.status === 404) {
      delete input.reply_to_message_id;
      try {
        sent = await mailer(app)(app, mb, { locationId: loc, userId: null }, input);
      } catch (err2) {
        return failed(err2);
      }
    } else return failed(err);
  }
  function failed(err: unknown): Outcome {
    const msg = (err as Error).message;
    const failures = e.failures + 1;
    event(app, e, 'failed', { step, detail: msg, at });
    // Provider errors that will not go away (no right to send, address refused) end the enrolment after a few tries.
    const hard = err instanceof HttpError ? err.status < 500 : err instanceof MailError ? err.status >= 400 && err.status < 500 && err.status !== 429 : false;
    if (failures >= 3 || hard) {
      app.db.run('UPDATE sequence_enrollments SET failures = ? WHERE id = ?', failures, e.id);
      stopEnrollment(app, e, 'send_failed', msg, at);
      return 'stopped';
    }
    app.db.run(`UPDATE sequence_enrollments SET failures = ?, next_at = ?, note = ?, updated_at = ? WHERE id = ?`, failures, delay(at, 30 * 60_000).toISOString(), `Versand fehlgeschlagen: ${msg}`.slice(0, 300), iso, e.id);
    return 'deferred';
  }
  const messageId = sent!.message_id ?? null;
  if (messageId) app.db.run(`UPDATE messages SET purpose = ?, consent_basis = ?, source = ? WHERE id = ?`, seq.mode === 'individual' ? 'conversation' : 'marketing', seq.mode === 'individual' ? '' : basis, 'Sequenz', messageId);
  event(app, e, 'sent', { step, variant: variant.id, message: messageId, detail: subject, at });
  logActivity(app, loc, contact.id, 'sequence.email', `Sequenz „${seq.name}“: ${subject}`.slice(0, 200), { sequence_id: seq.id, step_id: step.id });
  app.db.run(`UPDATE sequence_enrollments SET last_message_id = COALESCE(?, last_message_id), failures = 0, note = '' WHERE id = ?`, messageId, e.id);
  advance(app, { ...e, last_message_id: messageId ?? e.last_message_id }, seq, at);
  return 'sent';
}

/** The sending function (a test hook can replace it: app.services.sequenceSend). */
const mailer = (app: App): ((app: App, mb: MailboxRow, actor: { locationId: string; userId: string | null }, input: MailInput) => Promise<SendResult>) => app.services.sequenceSend ?? sendMail;

function varsFor(app: App, seq: SeqRow, e: EnrollRow, contact: Contact) {
  const user = e.user_id ? app.db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', e.user_id) : undefined;
  const deal = e.deal_id ? app.db.get<{ name: string; value: number; currency: string }>('SELECT name, value, currency FROM opportunities WHERE id = ? AND location_id = ?', e.deal_id, seq.location_id) : undefined;
  return {
    contact: contactVars(contact),
    user: { name: user?.name ?? '', first_name: (user?.name ?? '').split(/\s+/)[0] ?? '', email: user?.email ?? '' },
    sender: { name: user?.name ?? '', email: user?.email ?? '' },
    location: app.location(seq.location_id),
    deal: { name: deal?.name ?? '', value: deal?.value ?? '', currency: deal?.currency ?? '' },
  };
}

function task(app: App, e: EnrollRow, seq: SeqRow, step: Step, contact: Contact, vars: Record<string, unknown>, at: Date): Outcome {
  const title = render(step.title, vars).slice(0, 300);
  const prefix = step.type === 'call' ? 'Anrufen: ' : step.type === 'linkedin' ? 'LinkedIn: ' : '';
  const t = { id: id(), location_id: e.location_id, contact_id: contact.id, title: `${prefix}${title}`.slice(0, 300), description: render(step.note, vars).slice(0, 5000), due_at: at.toISOString(), assigned_to: e.user_id, done: 0, created_at: at.toISOString() };
  app.db.insert('tasks', t);
  event(app, e, 'task', { step, detail: t.title, at });
  logActivity(app, e.location_id, contact.id, 'sequence.task', `Sequenz „${seq.name}“: Aufgabe „${t.title}“`.slice(0, 200), { sequence_id: seq.id, task_id: t.id });
  if (step.wait) {
    // The sequence rests until the task is done; the next step is planned from that moment.
    app.db.run(`UPDATE sequence_enrollments SET status = 'waiting', task_id = ?, step_index = ?, next_at = ?, note = ?, updated_at = ? WHERE id = ?`, t.id, e.step_index + 1, delay(at, step.max_wait_days * 864e5).toISOString(), 'Wartet auf die Aufgabe', at.toISOString(), e.id);
    return 'task';
  }
  advance(app, e, seq, at);
  return 'task';
}

/** The step is done: plan the next one or finish. */
function advance(app: App, e: EnrollRow, seq: SeqRow, at: Date) {
  const next = e.step_index + 1;
  if (next >= seq.steps.length) return finish(app, e, at, next);
  const tz = tzOf(app, e.location_id, seq.settings);
  app.db.run(`UPDATE sequence_enrollments SET step_index = ?, next_at = ?, updated_at = ? WHERE id = ?`, next, dueAt(at, seq.steps[next], seq.settings.window, tz, e.id).toISOString(), at.toISOString(), e.id);
}

/** After a task step the index already points at the next step: plan it (or finish). */
function resume(app: App, e: EnrollRow, seq: SeqRow, at: Date) {
  const step = seq.steps[e.step_index];
  if (!step) return finish(app, e, at);
  const tz = tzOf(app, e.location_id, seq.settings);
  app.db.run(`UPDATE sequence_enrollments SET status = 'active', task_id = NULL, next_at = ?, note = '', updated_at = ? WHERE id = ?`, dueAt(at, step, seq.settings.window, tz, e.id).toISOString(), at.toISOString(), e.id);
}

function finish(app: App, e: EnrollRow, at: Date, index = e.step_index) {
  const r = app.db.run(`UPDATE sequence_enrollments SET status = 'finished', step_index = ?, next_at = NULL, task_id = NULL, note = '', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'waiting')`, index, at.toISOString(), at.toISOString(), e.id);
  if (!r.changes) return;
  event(app, e, 'finished', { at });
  app.events.emit(e.location_id, 'sequence.finished', { contactId: e.contact_id, sequenceId: e.sequence_id, enrollmentId: e.id });
}

/** A task was ticked off: the sequence that waited for it goes on. */
export function taskDone(app: App, loc: string, taskId: string, at = new Date()): number {
  let n = 0;
  for (const raw of app.db.all(`SELECT * FROM sequence_enrollments WHERE location_id = ? AND task_id = ? AND status = 'waiting'`, loc, taskId)) {
    const e = enrollment(raw);
    const seq = getSequence(app, loc, e.sequence_id);
    if (!seq) continue;
    resume(app, e, seq, at);
    n++;
  }
  return n;
}

// --- numbers ----------------------------------------------------------------------------------------------------------------

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);

/**
 * Opens count people only: the open pixel's hits are classified (mail provider proxies and security scanners do not count,
 * services/email-events.ts), so an open here is `messages.opened_at` – the same number a campaign report uses.
 */
export function sequenceStats(app: App, loc: string, seq: SeqRow) {
  const { db } = app;
  const num = (sql: string, ...p: any[]) => Number(Object.values(db.get(sql, ...p) ?? { n: 0 })[0] ?? 0);
  const by = db.all<{ status: string; stop_reason: string; n: number }>('SELECT status, stop_reason, COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ? GROUP BY status, stop_reason', seq.id);
  const enrolled = by.reduce((n, r) => n + r.n, 0);
  const count = (status: string) => by.filter((r) => r.status === status).reduce((n, r) => n + r.n, 0);
  const stoppedBy: Record<string, number> = {};
  for (const r of by) if (r.status === 'stopped') stoppedBy[r.stop_reason || 'manual'] = (stoppedBy[r.stop_reason || 'manual'] ?? 0) + r.n;
  const sent = num(`SELECT COUNT(*) FROM sequence_events WHERE sequence_id = ? AND kind = 'sent'`, seq.id);
  const opened = num(`SELECT COUNT(DISTINCT ev.message_id) FROM sequence_events ev JOIN messages m ON m.id = ev.message_id WHERE ev.sequence_id = ? AND ev.kind = 'sent' AND m.opened_at IS NOT NULL`, seq.id);
  const clicked = num(`SELECT COUNT(DISTINCT ev.message_id) FROM sequence_events ev JOIN messages m ON m.id = ev.message_id WHERE ev.sequence_id = ? AND ev.kind = 'sent' AND m.clicked_at IS NOT NULL`, seq.id);
  const contacted = num(`SELECT COUNT(DISTINCT enrollment_id) FROM sequence_events WHERE sequence_id = ? AND kind = 'sent'`, seq.id);
  const replied = num(`SELECT COUNT(DISTINCT enrollment_id) FROM sequence_events WHERE sequence_id = ? AND kind = 'reply'`, seq.id);
  const meetings = num(`SELECT COUNT(DISTINCT enrollment_id) FROM sequence_events WHERE sequence_id = ? AND kind = 'meeting'`, seq.id);
  const tasks = num(`SELECT COUNT(*) FROM sequence_events WHERE sequence_id = ? AND kind = 'task'`, seq.id);
  const perStep = seq.steps.map((st) => {
    const rows = db.all<{ variant_id: string; sent: number; opened: number; clicked: number }>(
      `SELECT COALESCE(ev.variant_id, '') AS variant_id, COUNT(*) AS sent, SUM(CASE WHEN m.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened, SUM(CASE WHEN m.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
       FROM sequence_events ev LEFT JOIN messages m ON m.id = ev.message_id WHERE ev.sequence_id = ? AND ev.step_id = ? AND ev.kind = 'sent' GROUP BY COALESCE(ev.variant_id, '')`,
      seq.id,
      st.id,
    );
    const repliesBy = new Map(db.all<{ variant_id: string; n: number }>(`SELECT COALESCE(variant_id, '') AS variant_id, COUNT(DISTINCT enrollment_id) AS n FROM sequence_events WHERE sequence_id = ? AND step_id = ? AND kind = 'reply' GROUP BY COALESCE(variant_id, '')`, seq.id, st.id).map((r) => [r.variant_id, r.n]));
    const variants = [{ id: '', label: 'Original' }, ...st.variants].map((v) => {
      const r = rows.find((x) => x.variant_id === v.id);
      const s = Number(r?.sent ?? 0);
      return { id: v.id, label: v.label, sent: s, opened: Number(r?.opened ?? 0), clicked: Number(r?.clicked ?? 0), replied: repliesBy.get(v.id) ?? 0, open_rate: pct(Number(r?.opened ?? 0), s), reply_rate: pct(repliesBy.get(v.id) ?? 0, s) };
    });
    const sentStep = variants.reduce((n, v) => n + v.sent, 0);
    const tasksStep = num(`SELECT COUNT(*) FROM sequence_events WHERE sequence_id = ? AND step_id = ? AND kind = 'task'`, seq.id, st.id);
    return { id: st.id, type: st.type, sent: sentStep, tasks: tasksStep, opened: variants.reduce((n, v) => n + v.opened, 0), replied: variants.reduce((n, v) => n + v.replied, 0), variants: st.type === 'email' ? variants : [] };
  });
  // Who sends and whether their mailbox tracks opens: without it the open rate stays at zero.
  const senders = db.all<{ user_id: string }>(`SELECT DISTINCT user_id FROM sequence_enrollments WHERE sequence_id = ? AND user_id IS NOT NULL`, seq.id).map((r) => r.user_id);
  let tracking = 0;
  for (const u of senders) {
    const mb = senderMailbox(app, loc, u, seq.settings.shared_mailbox);
    if (mb?.track_engagement) tracking++;
  }
  return {
    enrolled,
    active: count('active'),
    waiting: count('waiting'),
    finished: count('finished'),
    stopped: count('stopped'),
    stopped_by: stoppedBy,
    sent,
    contacted,
    opened,
    clicked,
    replied,
    meetings,
    tasks,
    open_rate: pct(opened, sent),
    click_rate: pct(clicked, sent),
    reply_rate: pct(replied, contacted),
    meeting_rate: pct(meetings, enrolled),
    open_tracking: { senders: senders.length, on: tracking },
    steps: perStep,
  };
}

/** What a step would send to one person (the sender's name, the person's data filled in) – for the preview in the editor. */
export function previewStep(app: App, seq: SeqRow, stepId: string, contactId: string, userId: string | null, dealId?: string | null) {
  const step = seq.steps.find((x) => x.id === stepId) ?? seq.steps[0];
  const contact = getContact(app, seq.location_id, contactId);
  if (!step || !contact) return undefined;
  const fake = { id: 'preview', user_id: userId, deal_id: dealId ?? null } as EnrollRow;
  const vars = varsFor(app, seq, fake, contact);
  const variants = step.type === 'email' ? [{ id: '', label: 'Original', subject: step.subject, body: step.body }, ...step.variants] : [];
  return {
    step_id: step.id,
    type: step.type,
    title: render(step.title, vars),
    note: render(step.note, vars),
    variants: variants.map((v) => ({ id: v.id, label: v.label, subject: render(v.subject || step.subject, vars), body: render(v.body || step.body, vars) + (seq.settings.footer || seq.mode === 'marketing' ? footerText('https://…/u/…') : '') })),
  };
}
