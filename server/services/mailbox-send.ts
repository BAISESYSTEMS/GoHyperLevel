import type { App } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getContact, logActivity, upsertContact } from './contacts.js';
import { getOrCreateConversation } from './messaging.js';
import { EMAIL, MailError, appendReference, canSend, composeBody, newMessageId, oneLine, parseAddresses, replySubject, sameAddress, withSignature, type MailAddress, type OutgoingMail, type SentRef } from './mailbox-kit.js';
import { apiFor, externalId, getMap, getMailbox, refreshPreview, saveMap, type MailboxRow, type MapRow } from './mailbox-sync.js';

/**
 * Sending through a connected mailbox: new mail, replies that stay in their thread (Gmail threadId + In-Reply-To /
 * References, Graph createReply), signature, attachments, scheduled send, and drafts that live in the mailbox
 * (create, change, send, delete). What is sent is recorded as a message in the contact's conversation; the copy that
 * later arrives in the mailbox's sent folder is recognised (same Message-ID / provider id) and not imported twice.
 */

export interface Actor {
  locationId: string;
  userId: string | null;
}

export interface MailInput {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body?: unknown;
  html?: unknown;
  attachments?: unknown;
  reply_to_message_id?: unknown;
  reply_all?: unknown;
  contact_id?: unknown;
  signature?: unknown;
  send_at?: unknown;
  /** false = no open/click tracking for this mail even though the mailbox has it on (never switches it on: the mailbox decides). */
  track?: unknown;
}

const MAX_RECIPIENTS = 50;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_SCHEDULE_MS = 90 * 864e5;

const sourceLabel = (mb: Pick<MailboxRow, 'name'>) => `Postfach ${mb.name}`.slice(0, 60);
const own = (mb: Pick<MailboxRow, 'address' | 'shared_address'>) => (mb.shared_address || mb.address).toLowerCase();

/** "a@b.de, Name <c@d.de>" or a list of those. Invalid addresses are an error (never silently dropped). */
function addresses(v: unknown, label: string): MailAddress[] {
  const parts = Array.isArray(v) ? v.map(String) : typeof v === 'string' && v.trim() ? [v] : [];
  const out: MailAddress[] = [];
  for (const p of parts) {
    const list = parseAddresses(p);
    if (!list.length && p.trim()) throw bad(`${label}: „${p.slice(0, 60)}“ ist keine E-Mail-Adresse`);
    for (const a of list) {
      if (!EMAIL.test(a.email)) throw bad(`${label}: „${a.email.slice(0, 60)}“ ist keine E-Mail-Adresse`);
      if (!out.some((x) => x.email === a.email)) out.push(a);
    }
  }
  return out;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

function attachmentsOf(v: unknown): Attachment[] {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) throw bad('Anhänge als Liste angeben');
  if (v.length > MAX_ATTACHMENTS) throw bad(`Höchstens ${MAX_ATTACHMENTS} Anhänge`);
  let total = 0;
  return v.map((a: any) => {
    const name = String(a?.filename ?? a?.name ?? '').replace(/[\r\n\\/"]+/g, '_').trim().slice(0, 200);
    const b64 = String(a?.content_base64 ?? a?.content ?? '');
    if (!name || !b64) throw bad('Anhang: filename und content_base64 nötig');
    if (!/^[A-Za-z0-9+/=_\-\s]+$/.test(b64)) throw bad(`Anhang „${name}“: kein gültiges Base64`);
    const content = Buffer.from(b64.replace(/\s+/g, ''), b64.includes('-') || b64.includes('_') ? 'base64url' : 'base64');
    total += content.length;
    if (total > MAX_ATTACHMENT_BYTES) throw bad(`Anhänge zusammen höchstens ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    return { filename: name, contentType: String(a?.content_type ?? a?.type ?? 'application/octet-stream').slice(0, 100).replace(/[\r\n]/g, ''), content };
  });
}

export interface Prepared {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string;
  html: string;
  attachments: Attachment[];
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  replyToRemoteId?: string;
  /** The message answered (this sub-account), for the contact. */
  replyTo?: { messageId: string; contactId: string };
  contactId?: string;
}

/** Validates what a person or tool sent and works out the thread headers for a reply. */
export function prepareMail(app: App, mb: MailboxRow, actor: Actor, input: MailInput): Prepared {
  let to = addresses(input.to, 'An');
  const cc = addresses(input.cc, 'Cc');
  const bcc = addresses(input.bcc, 'Bcc');
  // One line, whatever the provider: a subject can never carry a header of its own.
  let subject = oneLine(str(input.subject, 'Betreff', { max: 300 }));
  const body = str(input.body, 'Nachricht', { required: true, max: 100_000 });
  const prepared: Prepared = { to, cc, bcc, subject, text: '', html: '', attachments: attachmentsOf(input.attachments) };

  const replyId = typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id : '';
  if (replyId) {
    const orig = app.db.get<{ id: string; subject: string; direction: string; contact_id: string }>('SELECT id, subject, direction, contact_id FROM messages WHERE id = ? AND location_id = ? AND channel = ?', replyId, actor.locationId, 'email');
    if (!orig) throw notFound('Die Nachricht, auf die geantwortet wird, gibt es nicht');
    const maps = app.db.all<any>('SELECT * FROM mailbox_messages WHERE message_id = ? AND location_id = ? ORDER BY synced_at DESC', replyId, actor.locationId).map((m) => getMap(app, m.mailbox_id, m.remote_id)!);
    const same = maps.find((m) => m.mailbox_id === mb.id);
    const ref = same ?? maps[0];
    if (ref?.internet_id) {
      prepared.inReplyTo = ref.internet_id;
      prepared.references = appendReference(ref.refs, ref.internet_id);
    }
    if (same) {
      prepared.threadId = same.thread_id || undefined;
      prepared.replyToRemoteId = same.remote_id;
    }
    if (!subject) subject = replySubject(orig.subject);
    if (!to.length) {
      // Answer the other side; "reply all" also takes everybody else on the mail (without ourselves).
      const a = ref?.addrs;
      const people = orig.direction === 'in' ? [a?.from, ...(input.reply_all ? [...(a?.to ?? []), ...(a?.cc ?? [])] : [])] : (a?.to ?? []);
      to = people.filter((p): p is MailAddress => !!p?.email && !sameAddress(p.email, own(mb))).filter((p, i, l) => l.findIndex((q) => q.email === p.email) === i);
      if (!to.length) {
        const c = getContact(app, actor.locationId, orig.contact_id);
        if (c?.email) to = [{ email: c.email, name: '' }];
      }
    }
    prepared.replyTo = { messageId: orig.id, contactId: orig.contact_id };
    prepared.to = to;
  }
  if (!prepared.to.length) throw bad('Empfänger fehlt');
  if (prepared.to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw bad(`Höchstens ${MAX_RECIPIENTS} Empfänger`);
  prepared.subject = subject || '(kein Betreff)';
  const composed = composeBody(body, !!input.html);
  const signed = input.signature === false ? composed : withSignature(composed, mb.signature);
  prepared.text = signed.text;
  prepared.html = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${signed.html}</body></html>`;
  if (typeof input.contact_id === 'string' && input.contact_id) {
    if (!getContact(app, actor.locationId, input.contact_id)) throw notFound('Kontakt nicht gefunden');
    prepared.contactId = input.contact_id;
  }
  return prepared;
}

function outgoing(app: App, mb: MailboxRow, p: Prepared): OutgoingMail {
  return {
    from: { email: own(mb), name: '' },
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    subject: p.subject,
    text: p.text,
    html: p.html,
    attachments: p.attachments,
    messageId: mb.provider === 'google' ? newMessageId(own(mb)) : undefined,
    inReplyTo: p.inReplyTo,
    references: p.references,
    threadId: p.threadId,
    replyToRemoteId: p.replyToRemoteId,
  };
}

/** The contact this mail belongs to: given, the one answered, or the first recipient (created if new). */
function contactFor(app: App, mb: MailboxRow, actor: Actor, p: Prepared): string {
  if (p.contactId) return p.contactId;
  if (p.replyTo) {
    const c = getContact(app, actor.locationId, p.replyTo.contactId);
    if (c && (!c.email || p.to.some((a) => sameAddress(a.email, c.email)))) return c.id;
  }
  const first = p.to[0];
  return upsertContact(app, actor.locationId, { email: first.email, name: first.name || undefined }, { source: sourceLabel(mb) }).contact.id;
}

const attachmentInfo = (files: Attachment[]) => files.map((f) => ({ id: '', name: f.filename, type: f.contentType, size: f.content.length, inline: false }));

/** The message row and mapping for a mail we sent or saved as a draft. */
function record(app: App, mb: MailboxRow, actor: Actor, p: Prepared, ref: SentRef, kind: 'sent' | 'draft', messageId = id()) {
  const { db } = app;
  const contactId = contactFor(app, mb, actor, p);
  const conversationId = getOrCreateConversation(app, actor.locationId, contactId);
  const at = now();
  db.insert('messages', {
    id: messageId,
    location_id: actor.locationId,
    conversation_id: conversationId,
    contact_id: contactId,
    channel: 'email',
    direction: 'out',
    subject: p.subject.slice(0, 300),
    body: p.text.slice(0, 100_000),
    status: kind === 'draft' ? 'draft' : 'sent',
    error: '',
    source: sourceLabel(mb),
    provider_id: ref.internetId ? `<${ref.internetId}>` : null,
    user_id: actor.userId,
    external_id: externalId(mb.id, ref.id),
    created_at: at,
  });
  refreshPreview(app, conversationId);
  saveMap(app, {
    mailbox_id: mb.id,
    remote_id: ref.id,
    location_id: actor.locationId,
    message_id: messageId,
    conversation_id: conversationId,
    thread_id: ref.threadId,
    internet_id: ref.internetId,
    refs: p.references ?? '',
    folder: kind === 'draft' ? 'drafts' : 'sent',
    draft_id: ref.draftId,
    attachments: attachmentInfo(p.attachments),
    addrs: { from: { email: own(mb), name: '' }, to: p.to, cc: p.cc },
  });
  if (kind === 'sent') logActivity(app, actor.locationId, contactId, 'email.sent', `E-Mail über Postfach gesendet: ${p.subject}`.slice(0, 200));
  return { messageId, conversationId, contactId };
}

const needSend = (mb: MailboxRow) => {
  if (!mb.enabled) throw new HttpError(409, 'Dieses Postfach ist ausgeschaltet');
  if (!canSend(mb.access)) throw new HttpError(403, 'Dieses Postfach darf nicht senden (nur Lesezugriff)');
};

export interface SendResult {
  message_id?: string;
  conversation_id?: string;
  contact_id?: string;
  status: 'sent' | 'scheduled';
  scheduled_id?: string;
  send_at?: string;
  thread_id?: string;
}

/** Sends now, or stores the mail for `send_at` (the background job sends it). */
export async function sendMail(app: App, mb: MailboxRow, actor: Actor, input: MailInput): Promise<SendResult> {
  needSend(mb);
  const prepared = prepareMail(app, mb, actor, input);
  if (input.send_at !== undefined && input.send_at !== null && input.send_at !== '') {
    const at = Date.parse(String(input.send_at));
    if (Number.isNaN(at)) throw bad('Sendezeit ungültig');
    if (at < Date.now() + 30_000) throw bad('Die Sendezeit muss mindestens 30 Sekunden in der Zukunft liegen');
    if (at > Date.now() + MAX_SCHEDULE_MS) throw bad('Geplantes Senden geht höchstens 90 Tage im Voraus');
    const sid = id();
    app.db.insert('mailbox_scheduled', { id: sid, mailbox_id: mb.id, location_id: actor.locationId, user_id: actor.userId, send_at: new Date(at).toISOString(), input: { ...input, send_at: undefined }, status: 'pending', attempts: 0, created_at: now() });
    return { status: 'scheduled', scheduled_id: sid, send_at: new Date(at).toISOString() };
  }
  // Opt-in per mailbox (and the sub-account's own switch): the same pixel and tracked links as campaign mail, through the
  // tracking module's hook. The message id is chosen up front because the pixel and the links carry it.
  const messageId = id();
  const mail = outgoing(app, mb, prepared);
  if (mb.track_engagement && input.track !== false && app.services.instrumentEmail) {
    mail.html = app.services.instrumentEmail({ locationId: actor.locationId, messageId, contactId: prepared.contactId ?? '', html: mail.html });
  }
  const ref = await apiFor(app, mb).send(mail);
  const rec = record(app, mb, actor, prepared, ref, 'sent', messageId);
  return { status: 'sent', message_id: rec.messageId, conversation_id: rec.conversationId, contact_id: rec.contactId, thread_id: ref.threadId };
}

/** Plain send for workflows and the sub-account's own composer (provider "Verbundenes Postfach"): no conversation record here – the caller keeps it. */
export async function sendRaw(app: App, mb: MailboxRow, mail: { to: string; subject: string; html: string; text: string; replyTo?: string }): Promise<{ providerId: string }> {
  needSend(mb);
  const to = addresses(mail.to, 'An');
  if (!to.length) throw bad('Empfänger fehlt');
  const ref = await apiFor(app, mb).send({
    from: { email: own(mb), name: '' },
    to,
    cc: [],
    bcc: [],
    replyTo: mail.replyTo || undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments: [],
    messageId: mb.provider === 'google' ? newMessageId(own(mb)) : undefined,
  });
  return { providerId: ref.internetId ? `<${ref.internetId}>` : ref.id };
}

// --- scheduled send ------------------------------------------------------------------------------------

const RETRY_MS = 5 * 60_000;
const MAX_TRIES = 3;
/** A planned mail stays 'sending' only while its send is on the way (a request times out after 30 s); one older was left by a crash. */
const SENDING_STALE_MS = 30 * 60_000;
const MAYBE_SENT = 'die Mail ist vielleicht trotzdem gesendet worden. Bitte im Ordner „Gesendet“ nachsehen und bei Bedarf neu planen.';
/** Planned mails this process is sending right now (never taken for left behind, however long Gmail or Outlook takes). */
const inFlight = new Set<string>();

/** Sends what is due. Failures are tried again a few times, then marked failed (the person sees the error). */
export async function runScheduled(app: App, limit = 5): Promise<number> {
  const { db } = app;
  // A send the process did not live to write down (crash, restart while Gmail/Outlook had it): the mail may be out – it is never sent
  // again automatically, but marked failed with the note to look in "Gesendet" (like a send whose answer got lost, see below).
  // `sent_at` holds the claim time while a row is 'sending'; rows claimed before that was written fall back to their send time.
  const stale = db.all<{ id: string }>(`SELECT id FROM mailbox_scheduled WHERE status = 'sending' AND COALESCE(sent_at, send_at) < ?`, new Date(Date.now() - SENDING_STALE_MS).toISOString());
  for (const r of stale) {
    if (!inFlight.has(r.id)) db.run(`UPDATE mailbox_scheduled SET status = 'failed', error = ?, sent_at = NULL WHERE id = ? AND status = 'sending'`, `Versand unterbrochen (Neustart) – ${MAYBE_SENT}`, r.id);
  }
  const due = db.all<any>(`SELECT * FROM mailbox_scheduled WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT ?`, now(), limit);
  let sent = 0;
  for (const row of due) {
    // Claim it: another run (or a second process) must not send it twice.
    if (!db.run(`UPDATE mailbox_scheduled SET status = 'sending', sent_at = ? WHERE id = ? AND status = 'pending'`, now(), row.id).changes) continue;
    inFlight.add(row.id);
    try {
      const mb = getMailbox(app, row.mailbox_id);
      if (!mb) throw new Error('Das Postfach wurde getrennt');
      // The same rule as when it was scheduled: the sub-account's mailbox, or the person's own.
      const allowed = mb.scope === 'location' ? mb.location_id === row.location_id : !!row.user_id && mb.owner_user_id === row.user_id;
      if (!allowed) throw new Error('Kein Zugriff mehr auf dieses Postfach');
      if (row.user_id && !db.get('SELECT id FROM users WHERE id = ?', row.user_id)) throw new Error('Der Absender existiert nicht mehr');
      const input = JSON.parse(row.input);
      const res = await sendMail(app, mb, { locationId: row.location_id, userId: row.user_id }, input);
      db.run(`UPDATE mailbox_scheduled SET status = 'sent', sent_at = ?, message_id = ?, error = NULL WHERE id = ?`, now(), res.message_id ?? null, row.id);
      app.services.audit?.({ action: 'mail.send.scheduled', summary: `${mb.name}: ${String(input.subject ?? '').slice(0, 120)}`, locationId: row.location_id, entityId: row.id, userId: row.user_id });
      sent++;
    } catch (e) {
      const attempts = Number(row.attempts) + 1;
      // No answer to the send itself (timeout, connection lost while waiting): the provider may have sent it – never twice.
      const unsure = e instanceof MailError && e.unknownOutcome;
      const final = unsure || attempts >= MAX_TRIES || (e instanceof HttpError && e.status < 500) || (e instanceof MailError && !e.transient);
      const error = unsure ? `${(e as Error).message.slice(0, 160)} – ${MAYBE_SENT}` : (e as Error).message.slice(0, 300);
      db.run('UPDATE mailbox_scheduled SET status = ?, attempts = ?, error = ?, send_at = ?, sent_at = NULL WHERE id = ?', final ? 'failed' : 'pending', attempts, error, final ? row.send_at : new Date(Date.now() + RETRY_MS).toISOString(), row.id);
    } finally {
      inFlight.delete(row.id);
    }
  }
  return sent;
}

// --- drafts ------------------------------------------------------------------------------------------------

function draftMap(app: App, mb: MailboxRow, actor: Actor, messageId: string): MapRow {
  const row = app.db.get<{ remote_id: string }>(`SELECT remote_id FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ? AND location_id = ? AND folder = 'drafts'`, mb.id, messageId, actor.locationId);
  const map = row ? getMap(app, mb.id, row.remote_id) : undefined;
  if (!map) throw notFound('Entwurf nicht gefunden');
  return map;
}

export async function createDraft(app: App, mb: MailboxRow, actor: Actor, input: MailInput) {
  needSend(mb);
  const prepared = prepareMail(app, mb, actor, input);
  const ref = await apiFor(app, mb).createDraft(outgoing(app, mb, prepared));
  const rec = record(app, mb, actor, prepared, ref, 'draft');
  return { message_id: rec.messageId, conversation_id: rec.conversationId, contact_id: rec.contactId, thread_id: ref.threadId };
}

/** Gmail gives an edited draft a new message id: the mapping and the message follow it. */
function rekey(app: App, mb: MailboxRow, map: MapRow, ref: SentRef) {
  if (ref.id === map.remote_id) return;
  app.db.run('DELETE FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', mb.id, map.remote_id);
  app.db.run('UPDATE messages SET external_id = ? WHERE id = ?', externalId(mb.id, ref.id), map.message_id);
}

export async function updateDraft(app: App, mb: MailboxRow, actor: Actor, messageId: string, input: MailInput) {
  needSend(mb);
  const map = draftMap(app, mb, actor, messageId);
  const prepared = prepareMail(app, mb, actor, input);
  const out = outgoing(app, mb, prepared);
  // The thread of the draft stays what it was (a draft does not move to another conversation).
  out.threadId = out.threadId ?? (map.thread_id || undefined);
  const ref = await apiFor(app, mb).updateDraft({ id: map.remote_id, draftId: map.draft_id }, out);
  app.db.tx(() => {
    rekey(app, mb, map, ref);
    app.db.run('UPDATE messages SET subject = ?, body = ?, provider_id = ? WHERE id = ?', prepared.subject.slice(0, 300), prepared.text.slice(0, 100_000), ref.internetId ? `<${ref.internetId}>` : null, map.message_id);
    saveMap(app, { ...map, remote_id: ref.id, thread_id: ref.threadId || map.thread_id, internet_id: ref.internetId || map.internet_id, draft_id: ref.draftId || map.draft_id, attachments: prepared.attachments.length ? attachmentInfo(prepared.attachments) : map.attachments, addrs: { from: map.addrs.from, to: prepared.to, cc: prepared.cc }, synced_at: now() });
    refreshPreview(app, map.conversation_id);
  });
  return { message_id: map.message_id, conversation_id: map.conversation_id };
}

export async function sendDraft(app: App, mb: MailboxRow, actor: Actor, messageId: string) {
  needSend(mb);
  const map = draftMap(app, mb, actor, messageId);
  const sent = await apiFor(app, mb).sendDraft({ id: map.remote_id, draftId: map.draft_id });
  app.db.tx(() => {
    // The mail now has the time it was sent, not the time the draft was started.
    app.db.run(`UPDATE messages SET status = 'sent', created_at = ?, external_id = ? WHERE id = ?`, now(), externalId(mb.id, sent.id || map.remote_id), map.message_id);
    if (sent.id && sent.id !== map.remote_id) app.db.run('DELETE FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', mb.id, map.remote_id);
    saveMap(app, { ...map, remote_id: sent.id || map.remote_id, thread_id: sent.threadId || map.thread_id, folder: 'sent', draft_id: '', synced_at: now() });
    refreshPreview(app, map.conversation_id);
  });
  const subject = app.db.get<{ subject: string; contact_id: string }>('SELECT subject, contact_id FROM messages WHERE id = ?', map.message_id);
  if (subject) logActivity(app, actor.locationId, subject.contact_id, 'email.sent', `E-Mail über Postfach gesendet: ${subject.subject}`.slice(0, 200));
  return { message_id: map.message_id, conversation_id: map.conversation_id, status: 'sent' as const };
}

export async function deleteDraft(app: App, mb: MailboxRow, actor: Actor, messageId: string) {
  if (!mb.enabled) throw new HttpError(409, 'Dieses Postfach ist ausgeschaltet');
  const map = draftMap(app, mb, actor, messageId);
  await apiFor(app, mb).deleteDraft({ id: map.remote_id, draftId: map.draft_id });
  app.db.tx(() => {
    app.db.run('DELETE FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', mb.id, map.remote_id);
    if (!app.db.get('SELECT 1 AS x FROM mailbox_messages WHERE message_id = ?', map.message_id)) app.db.run(`DELETE FROM messages WHERE id = ? AND status = 'draft'`, map.message_id);
    refreshPreview(app, map.conversation_id);
  });
  return { ok: true };
}
