import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, type RawResult } from '../core/http.js';
import { id, now, token } from '../core/util.js';
import { inlineMime } from './meta.js';
import { openSecret, sealSecret } from '../modules/mail-sync.js';
import { getContact, logActivity, upsertContact, type Contact } from './contacts.js';
import { getOrCreateConversation } from './messaging.js';
import { inboundGate } from './inbound-gate.js';

/**
 * Shared plumbing for the extra channels (Telegram, Discord, Slack, email/SMS providers, push to
 * contacts): one settings row per sub-account and channel with sealed secrets, the link between an
 * external user and a contact, inbound chat messages, outbound records and delivery statuses.
 * Tables live in modules/channels.ts. Tests swap the network via app.services.channelFetch.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const channelFetch = (app: App): FetchLike => app.services.channelFetch ?? ((u: string, i?: RequestInit) => fetch(u, i));

export const MASK = '••••••';
export const CHANNEL_LABEL: Record<string, string> = { telegram: 'Telegram', discord: 'Discord', slack: 'Slack', push: 'Push' };
export const preview = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);

/** Constant-time string comparison (different lengths are simply unequal). */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const hmac = (key: string | Buffer, data: string | Buffer, alg = 'sha256') => createHmac(alg, key).update(data).digest();
export const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const header = (h: Record<string, unknown>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? '' : String(v);
};

/** Reads a JSON reply, turning provider errors into one readable line. */
export async function readJson(r: Response, label: string, pick?: (j: any) => string | undefined): Promise<any> {
  const textBody = await r.text().catch(() => '');
  let j: any = {};
  try {
    j = textBody ? JSON.parse(textBody) : {};
  } catch {
    j = { raw: textBody.slice(0, 200) };
  }
  if (!r.ok) {
    const msg = pick?.(j) || j?.message || j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.raw || '';
    throw new Error(`${label} ${r.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`);
  }
  return j;
}

// --- accounts -------------------------------------------------------------------------------

export interface ChannelAccount {
  location_id: string;
  channel: string;
  config: Record<string, any>;
  secrets: Record<string, string>;
  hook_key: string;
  enabled: boolean;
  info: Record<string, any>;
  last_webhook_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function openAll(app: App, sealed: string): Record<string, string> {
  if (!sealed) return {};
  try {
    const v = JSON.parse(openSecret(app, sealed));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {}; // the server secret changed: secrets have to be entered again
  }
}

function rowToAccount(app: App, row: any): ChannelAccount | undefined {
  if (!row) return undefined;
  const r = parseJson(row, ['config', 'info']);
  return { ...r, enabled: !!r.enabled, secrets: openAll(app, row.secrets) };
}

export function getAccount(app: App, locationId: string, channel: string): ChannelAccount | undefined {
  return rowToAccount(app, app.db.get('SELECT * FROM channel_accounts WHERE location_id = ? AND channel = ?', locationId, channel));
}

export function accountsOf(app: App, channel: string): ChannelAccount[] {
  return app.db.all('SELECT * FROM channel_accounts WHERE channel = ?', channel).map((r) => rowToAccount(app, r)!);
}

export interface AccountPatch {
  config?: Record<string, any>;
  /** A value replaces the stored secret; null removes it; '' or the mask keeps it. */
  secrets?: Record<string, string | null | undefined>;
  info?: Record<string, any>;
  enabled?: boolean;
  regenerateKey?: boolean;
}

export function saveAccount(app: App, locationId: string, channel: string, patch: AccountPatch): ChannelAccount {
  const cur = getAccount(app, locationId, channel);
  const secrets = { ...(cur?.secrets ?? {}) };
  for (const [k, v] of Object.entries(patch.secrets ?? {})) {
    if (v === null) delete secrets[k];
    else if (v !== undefined && v !== '' && v !== MASK) secrets[k] = v;
  }
  const row = {
    config: JSON.stringify({ ...(cur?.config ?? {}), ...(patch.config ?? {}) }),
    secrets: Object.keys(secrets).length ? sealSecret(app, JSON.stringify(secrets)) : '',
    info: JSON.stringify(patch.info ?? cur?.info ?? {}),
    enabled: patch.enabled === undefined ? (cur ? (cur.enabled ? 1 : 0) : 1) : patch.enabled ? 1 : 0,
    hook_key: !cur || patch.regenerateKey ? token(18) : cur.hook_key,
    updated_at: now(),
  };
  if (cur) {
    app.db.run(
      'UPDATE channel_accounts SET config = ?, secrets = ?, info = ?, enabled = ?, hook_key = ?, updated_at = ?, last_error = NULL WHERE location_id = ? AND channel = ?',
      row.config, row.secrets, row.info, row.enabled, row.hook_key, row.updated_at, locationId, channel,
    );
  } else {
    app.db.run(
      'INSERT INTO channel_accounts (location_id, channel, config, secrets, info, enabled, hook_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      locationId, channel, row.config, row.secrets, row.info, row.enabled, row.hook_key, now(), row.updated_at,
    );
  }
  return getAccount(app, locationId, channel)!;
}

export function deleteAccount(app: App, locationId: string, channel: string) {
  app.db.run('DELETE FROM channel_accounts WHERE location_id = ? AND channel = ?', locationId, channel);
}

export function noteWebhook(app: App, locationId: string, channel: string) {
  app.db.run('UPDATE channel_accounts SET last_webhook_at = ? WHERE location_id = ? AND channel = ?', now(), locationId, channel);
}
export function noteError(app: App, locationId: string, channel: string, msg: string | null) {
  app.db.run('UPDATE channel_accounts SET last_error = ? WHERE location_id = ? AND channel = ?', msg ? msg.slice(0, 500) : null, locationId, channel);
}
export function setInfo(app: App, locationId: string, channel: string, info: Record<string, any>) {
  app.db.run('UPDATE channel_accounts SET info = ? WHERE location_id = ? AND channel = ?', JSON.stringify(info), locationId, channel);
}

/** Which secrets are stored (never their values). */
export const secretsSet = (a: ChannelAccount | undefined, keys: string[]) => Object.fromEntries(keys.map((k) => [k, !!a?.secrets[k]]));

/** A webhook event we already handled (providers retry): true the first time, false for repeats. */
export function firstSeen(app: App, locationId: string, channel: string, eventId: string): boolean {
  if (!eventId) return true;
  const r = app.db.run('INSERT OR IGNORE INTO channel_seen (location_id, channel, event_id, at) VALUES (?, ?, ?, ?)', locationId, channel, eventId.slice(0, 200), now());
  return r.changes > 0;
}

/** Takes back a firstSeen mark: processing the event failed, so the provider's retry must get another go (like Stripe's webhook). */
export function forgetSeen(app: App, locationId: string, channel: string, eventId: string): void {
  if (eventId) app.db.run('DELETE FROM channel_seen WHERE location_id = ? AND channel = ? AND event_id = ?', locationId, channel, eventId.slice(0, 200));
}

const idText = (v: unknown) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim().slice(0, 200) : '');

/**
 * The sender's own id of an inbound SMS or mail posted to a webhook (Twilio MessageSid, SMS Gateway for Android, Mailgun's
 * Message-Id, a Message-Id header passed on by a mail worker …) – a resend of the same message is then taken once. '' when none.
 */
export function inboundMessageId(b: any): string {
  if (!b || typeof b !== 'object') return '';
  const h = b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers) ? b.headers : {};
  for (const v of [b.MessageSid, b.SmsMessageSid, b.payload?.messageId, b.messageId, b.message_id, b['Message-Id'], b['message-id'], b['Message-ID'], h['message-id'], h['Message-Id'], h['Message-ID'], b.id]) {
    const s = idText(v);
    if (s) return s;
  }
  return '';
}

/** Delivery id a webhook sender puts on a request and keeps on its retries (Standard Webhooks, Svix, GitHub, Shopify, idempotency keys). */
const DELIVERY_HEADERS = ['webhook-id', 'svix-id', 'idempotency-key', 'x-idempotency-key', 'x-webhook-id', 'x-delivery-id', 'x-github-delivery', 'x-shopify-webhook-id'];
export function deliveryIdOf(headers: Record<string, unknown>): string {
  for (const name of DELIVERY_HEADERS) {
    const s = idText(headers[name]);
    if (s) return s;
  }
  return '';
}

// --- identities (Telegram user, Discord user → contact) ---------------------------------------

export interface Identity {
  location_id: string;
  channel: string;
  external_id: string;
  contact_id: string;
  name: string;
  handle: string;
  chat_id: string;
  data: Record<string, any>;
}

const identityRow = (r: any): Identity | undefined => (r ? parseJson(r, ['data']) : undefined);
export const identityOf = (app: App, locationId: string, channel: string, externalId: string) =>
  identityRow(app.db.get('SELECT * FROM channel_identities WHERE location_id = ? AND channel = ? AND external_id = ?', locationId, channel, externalId));
export const identityOfContact = (app: App, locationId: string, contactId: string, channel: string) =>
  identityRow(app.db.get('SELECT * FROM channel_identities WHERE location_id = ? AND contact_id = ? AND channel = ? ORDER BY updated_at DESC LIMIT 1', locationId, contactId, channel));

export function linkIdentity(app: App, locationId: string, channel: string, externalId: string, contactId: string, info: { name?: string; handle?: string; chatId?: string; data?: Record<string, any> } = {}) {
  const cur = identityOf(app, locationId, channel, externalId);
  const data = JSON.stringify({ ...(cur?.data ?? {}), ...(info.data ?? {}) });
  app.db.run(
    `INSERT INTO channel_identities (location_id, channel, external_id, contact_id, name, handle, chat_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, channel, external_id) DO UPDATE SET name = excluded.name, handle = excluded.handle,
       chat_id = CASE WHEN excluded.chat_id != '' THEN excluded.chat_id ELSE channel_identities.chat_id END, data = excluded.data, updated_at = excluded.updated_at`,
    locationId, channel, externalId, contactId, (info.name ?? cur?.name ?? '').slice(0, 120), (info.handle ?? cur?.handle ?? '').slice(0, 120), info.chatId ?? '', data, now(), now(),
  );
}

// --- inbound chat messages --------------------------------------------------------------------

export interface InboundChat {
  channel: string;
  /** Stable user id on the platform (Telegram user id, Discord user id). */
  externalUser: string;
  name?: string;
  handle?: string;
  chatId?: string;
  body: string;
  /** Unique per message, e.g. tg:<chat>:<message_id> – duplicates are dropped. */
  externalId: string;
  media?: Record<string, any> | null;
  at?: string;
  tags?: string[];
  identityData?: Record<string, any>;
  /** Contact fields for a new contact (e.g. a shared phone number). */
  fields?: Record<string, any>;
  /** false: no message.inbound (e.g. Telegram /start emits its own event). */
  emit?: boolean;
}

/** Contact of an external user: the linked one, else a new contact named after the profile. */
export function contactForUser(app: App, locationId: string, e: Pick<InboundChat, 'channel' | 'externalUser' | 'name' | 'handle' | 'chatId' | 'tags' | 'identityData' | 'fields'>): { contact: Contact; created: boolean } {
  const label = CHANNEL_LABEL[e.channel] ?? e.channel;
  const known = identityOf(app, locationId, e.channel, e.externalUser);
  const linked = known ? getContact(app, locationId, known.contact_id) : undefined;
  if (linked) {
    linkIdentity(app, locationId, e.channel, e.externalUser, linked.id, { name: e.name, handle: e.handle, chatId: e.chatId, data: e.identityData });
    return { contact: linked, created: false };
  }
  const name = e.name || (e.handle ? `@${e.handle}` : `${label}-Kontakt`);
  const custom = e.handle ? { [e.channel]: `@${e.handle}` } : {};
  const { contact, created } = upsertContact(app, locationId, { name, ...(e.fields ?? {}), custom }, { source: label, tags: [e.channel, ...(e.tags ?? [])] });
  linkIdentity(app, locationId, e.channel, e.externalUser, contact.id, { name, handle: e.handle, chatId: e.chatId, data: e.identityData });
  return { contact, created };
}

/** Stores an inbound message (contact, conversation, unread, STOP → DND) and fires message.inbound. Null for duplicates. */
export function receiveChat(app: App, locationId: string, e: InboundChat): { message: any; contact: Contact; created: boolean } | null {
  if (app.db.get('SELECT id FROM messages WHERE location_id = ? AND external_id = ?', locationId, e.externalId)) return null;
  const { contact, created } = contactForUser(app, locationId, e);
  const label = CHANNEL_LABEL[e.channel] ?? e.channel;
  const conversationId = getOrCreateConversation(app, locationId, contact.id);
  // Platform timestamps have whole seconds: live messages keep our clock, late deliveries theirs.
  const at = e.at && Date.now() - new Date(e.at).getTime() > 120_000 ? e.at : now();
  const message = {
    id: id(),
    location_id: locationId,
    conversation_id: conversationId,
    contact_id: contact.id,
    channel: e.channel,
    direction: 'in',
    subject: '',
    body: e.body.slice(0, 20_000),
    status: 'received',
    error: '',
    source: label,
    external_id: e.externalId,
    channel_media: e.media ? JSON.stringify(e.media) : null,
    created_at: at,
  };
  try {
    app.db.insert('messages', message);
  } catch (err) {
    if (/UNIQUE/i.test((err as Error).message)) return null;
    throw err;
  }
  const newer = app.db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND created_at > ? AND id != ? LIMIT 1', conversationId, at, message.id);
  if (newer) app.db.run('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
  else app.db.run('UPDATE conversations SET unread = unread + 1, last_message = ?, last_message_at = ? WHERE id = ?', preview(message.body), at, conversationId);
  if (/^\s*(stop|stopp|abmelden)\s*$/i.test(e.body)) app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', contact.id);
  // Receive hook (services/inbound-gate.ts): a blocked sender is archived silently and treated like a duplicate (no welcome, no event).
  const claim = inboundGate(app, { locationId, contactId: contact.id, channel: e.channel });
  if (claim) return (claim.archive(conversationId, message.id), null);
  logActivity(app, locationId, contact.id, `${e.channel}.received`, `${label}-Nachricht empfangen`);
  if (e.emit !== false) app.events.emit(locationId, 'message.inbound', { contactId: contact.id, contact: getContact(app, locationId, contact.id), message });
  return { message, contact, created };
}

// --- outbound -------------------------------------------------------------------------------

export interface OutRecord {
  id: string;
  location_id: string;
  conversation_id: string;
  contact_id: string;
  channel: string;
  direction: 'out';
  subject: string;
  body: string;
  status: string;
  error: string;
  source: string;
  user_id: string | null;
  created_at: string;
  provider_id?: string | null;
}

/** Records an outgoing message as queued; finish it with finishOutbound. */
export function recordOutbound(app: App, locationId: string, contact: Contact, channel: string, body: string, opts: { subject?: string; userId?: string | null; source?: string; media?: Record<string, any> | null } = {}): OutRecord {
  const conversationId = getOrCreateConversation(app, locationId, contact.id);
  const msg: OutRecord = {
    id: id(),
    location_id: locationId,
    conversation_id: conversationId,
    contact_id: contact.id,
    channel,
    direction: 'out',
    subject: opts.subject ?? '',
    body,
    status: 'queued',
    error: '',
    source: opts.source ?? 'manuell',
    user_id: opts.userId ?? null,
    created_at: now(),
  };
  app.db.insert('messages', { ...msg, channel_media: opts.media ? JSON.stringify(opts.media) : null });
  app.db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', msg.created_at, preview(body || opts.subject || ''), conversationId);
  return msg;
}

export function finishOutbound(app: App, msg: OutRecord, r: { ok: true; providerId?: string | null; activity?: string } | { ok: false; error: string }): OutRecord {
  if (!r.ok) {
    app.db.run(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`, r.error.slice(0, 500), msg.id);
    return { ...msg, status: 'failed', error: r.error };
  }
  app.db.run(`UPDATE messages SET status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END, provider_id = ? WHERE id = ?`, r.providerId ?? null, msg.id);
  const label = CHANNEL_LABEL[msg.channel] ?? msg.channel;
  logActivity(app, msg.location_id, msg.contact_id, `${msg.channel}.sent`, r.activity ?? `${label}-Nachricht gesendet`);
  return { ...msg, status: 'sent', provider_id: r.providerId ?? null };
}

// --- delivery statuses (email/SMS providers) ---------------------------------------------------

export type DeliveryStatus = 'sent' | 'delivered' | 'deferred' | 'failed' | 'bounced' | 'complained' | 'unsubscribed';
export interface DeliveryEvent {
  providerId: string;
  status: DeliveryStatus;
  /** Hard bounce (permanent) – only these switch a contact to „Nicht stören“. */
  permanent?: boolean;
  reason?: string;
  eventId?: string;
}

const RANK: Record<string, number> = { queued: 0, logged: 0, sent: 1, delivered: 2, read: 3 };

/**
 * Applies a provider's delivery report to the outgoing message with that provider id. Delivered
 * only moves forward; bounces and complaints win; a hard bounce, a complaint or an unsubscribe
 * switches the contact to „Nicht stören“ and fires email.bounced / email.complained.
 */
export function applyDelivery(app: App, locationId: string, channel: 'email' | 'sms', e: DeliveryEvent): number {
  const providerId = String(e.providerId ?? '').replace(/^<|>$/g, '').trim();
  if (!providerId) return 0;
  const m = app.db.get(`SELECT id, status, contact_id FROM messages WHERE location_id = ? AND provider_id IN (?, ?) AND direction = 'out' AND channel = ? LIMIT 1`, locationId, providerId, `<${providerId}>`, channel);
  if (!m) return 0;
  const label = channel === 'email' ? 'E-Mail' : 'SMS';
  const reason = (e.reason ?? '').slice(0, 300);
  switch (e.status) {
    case 'sent':
    case 'delivered': {
      if ((RANK[m.status] ?? 9) >= RANK[e.status]) return 0;
      return app.db.run('UPDATE messages SET status = ? WHERE id = ?', e.status, m.id).changes;
    }
    case 'deferred':
      if (m.status === 'queued' || m.status === 'sent') app.db.run('UPDATE messages SET error = ? WHERE id = ?', reason ? `Verzögert: ${reason}` : 'Zustellung verzögert – der Anbieter versucht es weiter', m.id);
      return 0;
    case 'failed':
    case 'bounced': {
      const hard = e.status === 'bounced' && e.permanent !== false;
      const status = hard ? 'bounced' : 'failed';
      if (m.status === status) return 0;
      app.db.run('UPDATE messages SET status = ?, error = ? WHERE id = ?', status, reason || (hard ? 'Unzustellbar (Hard Bounce)' : 'Nicht zugestellt'), m.id);
      logActivity(app, locationId, m.contact_id, `${channel}.${status}`, `${label} nicht zugestellt${reason ? `: ${reason}` : ''}`);
      if (hard && channel === 'email') {
        app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', m.contact_id);
        logActivity(app, locationId, m.contact_id, 'contact.dnd', '„Nicht stören“ nach Hard Bounce');
        app.events.emit(locationId, 'email.bounced', { contactId: m.contact_id, messageId: m.id, reason });
      }
      return 1;
    }
    case 'complained': {
      app.db.run(`UPDATE messages SET status = 'complained', error = ? WHERE id = ?`, reason || 'Als Spam gemeldet', m.id);
      app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', m.contact_id);
      logActivity(app, locationId, m.contact_id, `${channel}.complained`, `${label} als Spam gemeldet – „Nicht stören“ an`);
      app.events.emit(locationId, 'email.complained', { contactId: m.contact_id, messageId: m.id });
      return 1;
    }
    case 'unsubscribed':
      app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', m.contact_id);
      logActivity(app, locationId, m.contact_id, 'contact.dnd', `Beim ${label}-Anbieter abgemeldet – „Nicht stören“ an`);
      return 1;
  }
  return 0;
}

/** Public URL of a webhook as the provider called it (signatures over the URL need the exact address). */
export const publicUrl = (app: App, path: string, search = '') => `${app.baseUrl()}${path}${search}`;

// --- media of inbound messages -----------------------------------------------------------------

const MEDIA_MAX = 20 * 1024 * 1024;

/**
 * Fetches a file from the platform (only hosts `allowHost` accepts, no redirects elsewhere) and
 * hands it to the browser – inline for images, audio, video and PDF, otherwise as download.
 */
export async function serveMedia(fetcher: FetchLike, url: string, opts: { allowHost: (host: string) => boolean; headers?: Record<string, string>; mime?: string; filename?: string }): Promise<RawResult> {
  let target = url;
  let r: Response | undefined;
  for (let hop = 0; hop < 3; hop++) {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new HttpError(400, 'Ungültige Medien-Adresse');
    }
    if (u.protocol !== 'https:' || !opts.allowHost(u.hostname.toLowerCase())) throw new HttpError(400, 'Unerwartete Medien-Adresse');
    try {
      r = await fetcher(target, { headers: hop === 0 ? (opts.headers ?? {}) : {}, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new HttpError(502, `Datei nicht abrufbar: ${(e as Error).message}`);
    }
    const next = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!next) break;
    target = new URL(next, target).toString();
    r = undefined;
  }
  if (!r) throw new HttpError(502, 'Datei nicht abrufbar (zu viele Weiterleitungen)');
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'Datei nicht mehr verfügbar' : `Datei nicht abrufbar (${r.status})`);
  if (Number(r.headers.get('content-length') || 0) > MEDIA_MAX) throw new HttpError(413, 'Datei zu groß für die Vorschau');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MEDIA_MAX) throw new HttpError(413, 'Datei zu groß für die Vorschau');
  const type = (opts.mime || r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const inline = inlineMime(type);
  const filename = String(opts.filename || 'datei').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
  return {
    __raw: true,
    status: 200,
    headers: { 'content-type': inline ? type : 'application/octet-stream', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' },
    body: buf,
  };
}
