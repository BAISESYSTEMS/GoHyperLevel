import nodemailer from 'nodemailer';
import type { App, LocationRow } from '../core/app.js';
import { escapeHtml, textToHtml } from '../core/template.js';
import { id, now, sha256 } from '../core/util.js';
import { safeFetch } from './net.js';
import { getContact, logActivity, upsertContact, type Contact } from './contacts.js';
import { PREFERENCES_TOKEN, UNSUBSCRIBE_TOKEN, htmlToText, isFullHtmlDocument } from './email-render.js';
import { inboundGate } from './inbound-gate.js';

/** %%preferences_url%% in a hand-built footer becomes the link to the preference centre (the unsubscribe link when there is none). */
export { PREFERENCES_TOKEN };

export type Channel = 'email' | 'sms' | 'chat';

export interface OutMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Files to attach (calendar invites). SMTP sends them; senders of other providers may ignore them – the message links the file as well. */
  attachments?: { filename: string; content: string; contentType: string; /** 'base64' when `content` is base64 text of a binary file (a PDF), otherwise it is sent as text. */ encoding?: 'base64' }[];
  /** Extra mail headers (List-Unsubscribe …). Providers that send through an API pass them on as far as they allow. */
  headers?: Record<string, string>;
  /** Sender name for this mail only (A/B tests of campaigns); otherwise the one of the sub-account's e-mail settings. */
  fromName?: string;
}

export type DeliverResult = { status: 'sent' | 'logged'; providerId?: string };
/** Senders other modules add for a provider name (settings.email.provider / settings.sms.provider), e.g. Resend or seven.io. */
export type EmailTransport = (loc: LocationRow, mail: OutMail) => Promise<DeliverResult>;
export type SmsTransport = (loc: LocationRow, to: string, body: string) => Promise<DeliverResult>;

const BUILTIN_EMAIL = ['smtp', 'log'];
const BUILTIN_SMS = ['twilio', 'http', 'log'];

/** The module transport for a provider that is not built in; undefined for built-in or empty providers. */
function extraTransport<T>(loc: LocationRow, kind: 'emailTransports' | 'smsTransports', provider: unknown): T | undefined {
  if (typeof provider !== 'string' || !provider || (kind === 'emailTransports' ? BUILTIN_EMAIL : BUILTIN_SMS).includes(provider)) return undefined;
  const list: Record<string, T> = loc.app?.services[kind] ?? {};
  if (!Object.hasOwn(list, provider)) throw new Error(`${kind === 'emailTransports' ? 'E-Mail' : 'SMS'}-Anbieter „${provider}“ ist nicht verfügbar`);
  return list[provider];
}

/** Header values never carry line breaks (no header injection through names, subjects or addresses). */
export const oneLine = (v: unknown) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

/** Sends through the sub-account's configured provider. 'log' only records the message (free, for testing). */
export async function deliverEmail(loc: LocationRow, mail: OutMail): Promise<DeliverResult> {
  const cfg = loc.settings.email ?? { provider: 'log' };
  const extra = extraTransport<EmailTransport>(loc, 'emailTransports', cfg.provider);
  if (extra) return extra(loc, mail);
  if (cfg.provider !== 'smtp') return { status: 'logged' };
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: cfg.secure === true || cfg.secure === 'true' || Number(cfg.port) === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  const fromEmail = oneLine(cfg.fromEmail || cfg.user);
  const fromName = mail.fromName || cfg.fromName;
  const info = await transport.sendMail({
    from: fromName ? `"${oneLine(fromName).replace(/["\\<>]/g, '')}" <${fromEmail}>` : fromEmail,
    to: oneLine(mail.to),
    subject: oneLine(mail.subject),
    html: mail.html,
    text: mail.text,
    replyTo: oneLine(mail.replyTo || cfg.replyTo) || undefined,
    attachments: mail.attachments?.map((a) => ({ filename: oneLine(a.filename), content: a.content, contentType: oneLine(a.contentType), ...(a.encoding === 'base64' ? { encoding: 'base64' as const } : {}) })),
    ...(mail.headers ? { headers: Object.fromEntries(Object.entries(mail.headers).map(([k, v]) => [oneLine(k), oneLine(v)])) } : {}),
  });
  return { status: 'sent', providerId: info.messageId };
}

export async function deliverSms(loc: LocationRow, to: string, body: string): Promise<DeliverResult> {
  const cfg = loc.settings.sms ?? { provider: 'log' };
  const extra = extraTransport<SmsTransport>(loc, 'smsTransports', cfg.provider);
  if (extra) return extra(loc, to, body);
  if (cfg.provider === 'twilio') {
    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: cfg.from, Body: body }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `Twilio ${r.status}`);
    return { status: 'sent', providerId: j.sid };
  }
  if (cfg.provider === 'http') {
    // Any HTTP SMS gateway, e.g. the free "SMS Gateway for Android" app on your own phone.
    const tpl = cfg.bodyTemplate || '{"phoneNumbers":["{{to}}"],"message":"{{body}}"}';
    const payload = tpl.replace(/\{\{to\}\}/g, jsonEsc(to)).replace(/\{\{body\}\}/g, jsonEsc(body));
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.user) headers.authorization = `Basic ${Buffer.from(`${cfg.user}:${cfg.pass ?? ''}`).toString('base64')}`;
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
    // The gateway URL is set by the sub-account: SSRF guard, so it can't reach the server's own network.
    const r = await safeFetch(String(cfg.url ?? ''), { method: 'POST', headers, body: payload, timeoutMs: 15_000, maxBytes: 64_000 });
    if (!r.ok) throw new Error(`SMS-Gateway ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { status: 'sent' };
  }
  return { status: 'logged' };
}

const jsonEsc = (s: string) => JSON.stringify(s).slice(1, -1);

export function unsubscribeToken(app: App, contactId: string) {
  return sha256(`${app.config.secret}:unsub:${contactId}`).slice(0, 24);
}

export function getOrCreateConversation(app: App, locationId: string, contactId: string): string {
  const row = app.db.get('SELECT id FROM conversations WHERE location_id = ? AND contact_id = ?', locationId, contactId);
  if (row) return row.id;
  const cid = id();
  app.db.insert('conversations', { id: cid, location_id: locationId, contact_id: contactId, unread: 0, last_message_at: now(), created_at: now() });
  return cid;
}

export interface SendInput {
  contactId: string;
  channel: Channel;
  subject?: string;
  body: string;
  /** Treat body as HTML (from the email editor) instead of plain text. */
  isHtml?: boolean;
  /** text/plain part (the email builder renders one from the design); otherwise derived from the body. */
  text?: string;
  userId?: string;
  source?: string;
  /** Campaigns and workflows respect DND; a person writing by hand can override it. */
  ignoreDnd?: boolean;
  /** E-mail only: files to attach (see OutMail.attachments). */
  attachments?: OutMail['attachments'];
  /** Marketing/bulk mail (campaigns, workflows, surveys): carries the RFC 8058 one-click unsubscribe headers. Default: by source. */
  bulk?: boolean;
  /**
   * What the message is, for the consent gate (modules/consent.ts): "marketing" needs a valid consent of the contact, "transactional"
   * (invoice, appointment, the confirmation mail itself) never does and is marked as such. Default: bulk sources are marketing,
   * "ignoreDnd" ones transactional, everything else is a conversation.
   */
  purpose?: 'marketing' | 'transactional';
  /** E-mail only: sender name for this mail (A/B tests of campaigns); default is the one of the e-mail settings. */
  fromName?: string;
  /**
   * E-mail only: false sends it without open pixel and tracked links. The double opt-in mail does so – nothing is measured
   * before the person has consented (§ 25 TDDDG). Otherwise the sub-account's tracking settings decide (modules/tracking.ts).
   */
  track?: boolean;
}

/** Mails of these sources are bulk mail: Gmail and Yahoo expect List-Unsubscribe (one-click) on them. */
const BULK_SOURCE = /^(Kampagne|Workflow|NPS)/;

/** What a message is – the same rule as the consent gate (services/consent.ts `judge`): said by the sender, else bulk = marketing, "ignoreDnd" = service mail. */
export function messagePurpose(input: Pick<SendInput, 'purpose' | 'ignoreDnd'>, bulk: boolean): 'marketing' | 'transactional' | 'conversation' {
  if (input.purpose === 'transactional' || input.purpose === 'marketing') return input.purpose;
  return bulk ? 'marketing' : input.ignoreDnd ? 'transactional' : 'conversation';
}

/** RFC 8058: the mail client unsubscribes with one POST to this link – no page, no login. */
export function unsubscribeHeaders(unsubUrl: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** Sends an email or SMS to a contact and records it in their conversation. */
export async function sendToContact(app: App, locationId: string, input: SendInput) {
  const loc = app.location(locationId)!;
  const contact = getContact(app, locationId, input.contactId);
  if (!contact) throw new Error('Kontakt nicht gefunden');
  const conversationId = getOrCreateConversation(app, locationId, contact.id);
  const msg = {
    id: id(),
    location_id: locationId,
    conversation_id: conversationId,
    contact_id: contact.id,
    channel: input.channel,
    direction: 'out',
    subject: input.subject ?? '',
    body: input.body,
    status: 'queued',
    error: '',
    source: input.source ?? 'manuell',
    user_id: input.userId ?? null,
    created_at: now(),
  };
  app.db.insert('messages', msg);
  app.db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', msg.created_at, preview(msg.body), conversationId);

  const fail = (error: string) => {
    app.db.run(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`, error, msg.id);
    return { ...msg, status: 'failed', error };
  };

  if (contact.dnd && !input.ignoreDnd && input.channel !== 'chat') return fail('Kontakt hat „Nicht stören“ aktiv');
  // Do-not-disturb for single channels (workflow step "DND je Kanal", app.services.channelDnd → reason or undefined).
  const blocked: string | undefined = !input.ignoreDnd && input.channel !== 'chat' ? app.services.channelDnd?.(locationId, contact.id, input.channel) : undefined;
  if (blocked) return fail(blocked);
  const bulk = input.bulk ?? BULK_SOURCE.test(input.source ?? '');
  // Consent gate (modules/consent.ts): advertising only to contacts with a valid consent; service mails pass and are marked.
  const consent: { blocked?: string } | undefined = input.channel !== 'chat' ? app.services.consentGate?.({ locationId, contact, channel: input.channel, purpose: input.purpose, bulk, ignoreDnd: !!input.ignoreDnd, messageId: msg.id, source: input.source }) : undefined;
  if (consent?.blocked) return fail(consent.blocked);
  // Optional hooks from the tracking module: personal trigger links, open/click tracking.
  const body: string = app.services.personalizeLinks ? app.services.personalizeLinks(locationId, contact.id, input.body) : input.body;
  try {
    let res: { status: string; providerId?: string };
    if (input.channel === 'email') {
      if (!contact.email) return fail('Kontakt hat keine E-Mail-Adresse');
      const unsub = `${app.baseUrl()}/u/${contact.id}/${unsubscribeToken(app, contact.id)}`;
      const prefs: string = bulk ? (app.services.consent?.footerPrefsUrl?.(locationId, contact.id) ?? '') : '';
      // Service mails (invoice, appointment, SEPA, the double opt-in mail …) are no advertising: no "Abmelden" in the footer.
      const purpose = messagePurpose(input, bulk);
      const composed = composeEmail({ body, isHtml: input.isHtml, text: input.text, unsubUrl: unsub, prefsUrl: prefs || undefined, company: loc.name, address: loc.address, unsubscribe: purpose !== 'transactional' });
      let html = composed.html;
      const text = composed.text;
      if (app.services.instrumentEmail && input.track !== false) html = app.services.instrumentEmail({ locationId, messageId: msg.id, contactId: contact.id, html, purpose });
      // Optional plan limit (SaaS mode): counts the send or says why not.
      const gated: string | undefined = app.services.usageGate?.(locationId, 'email');
      if (gated) return fail(gated);
      res = await deliverEmail(loc, { to: contact.email, subject: input.subject || '(kein Betreff)', html, text, ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(bulk ? { headers: unsubscribeHeaders(unsub) } : {}), ...(input.fromName ? { fromName: input.fromName } : {}) });
    } else if (input.channel === 'chat') {
      // Live chat: the visitor's widget picks the reply up from the conversation.
      res = { status: 'sent' };
    } else {
      if (!contact.phone) return fail('Kontakt hat keine Telefonnummer');
      const gated: string | undefined = app.services.usageGate?.(locationId, 'sms');
      if (gated) return fail(gated);
      res = await deliverSms(loc, contact.phone, body);
    }
    app.db.run('UPDATE messages SET status = ?, provider_id = ? WHERE id = ?', res.status, res.providerId ?? null, msg.id);
    logActivity(app, locationId, contact.id, `${input.channel}.sent`, `${input.channel === 'email' ? 'E-Mail' : input.channel === 'chat' ? 'Chat-Antwort' : 'SMS'} gesendet${input.subject ? `: ${input.subject}` : ''}`);
    return { ...msg, status: res.status };
  } catch (e) {
    return fail((e as Error).message);
  }
}

/** Puts a link to the preference centre in front of the first unsubscribe link of a designer footer (same look as that link). */
function withPrefsLink(html: string, prefsUrl: string): string {
  const m = /<a\b[^>]*\bhref="%%unsubscribe_url%%"[^>]*>/i.exec(html);
  if (!m) return html;
  const style = /\bstyle="([^"]*)"/i.exec(m[0])?.[1];
  return `${html.slice(0, m.index)}<a href="${PREFERENCES_TOKEN}" target="_blank"${style ? ` style="${style}"` : ''}>Einstellungen</a> · ${html.slice(m.index)}`;
}

/**
 * The final HTML and text of an outgoing email. Plain or snippet HTML gets our simple wrapper with
 * company line and unsubscribe link; a complete document from the email builder brings its own
 * footer, whose %%unsubscribe_url%% becomes this recipient's link (a footer is added if missing).
 * `unsubscribe: false` (service mails: invoice, appointment, double opt-in …): the added footer names the company only – no
 * "Abmelden" link, since there is nothing to unsubscribe from; a link the sender wrote in on purpose still works.
 */
export function composeEmail(o: { body: string; isHtml?: boolean; text?: string; unsubUrl: string; /** Preference centre (modules/consent-pages.ts): a second link in the footer and for %%preferences_url%%. */ prefsUrl?: string; company: string; address?: string; unsubscribe?: boolean }): { html: string; text: string } {
  const withUnsub = o.unsubscribe !== false;
  const legal = `${escapeHtml(o.company)}${o.address ? ' · ' + escapeHtml(o.address) : ''}`;
  const legalText = `\n\n--\n${o.company}${withUnsub ? `\n${o.prefsUrl ? `Einstellungen: ${o.prefsUrl}\n` : ''}Abmelden: ${o.unsubUrl}` : ''}`;
  const prefsLink = o.prefsUrl ? `<a href="${o.prefsUrl}" style="color:#9ca3af">Einstellungen</a> · ` : '';
  const unsubLink = `${prefsLink}<a href="${o.unsubUrl}" style="color:#9ca3af">Abmelden</a>`;
  const swap = (s: string) => s.split(UNSUBSCRIBE_TOKEN).join(o.unsubUrl).split(PREFERENCES_TOKEN).join(o.prefsUrl ?? o.unsubUrl);
  if (o.isHtml && isFullHtmlDocument(o.body)) {
    let html = o.body;
    if (html.includes(UNSUBSCRIBE_TOKEN)) {
      // A designer footer without its own %%preferences_url%% gets the link to the preference centre next to "Abmelden".
      if (o.prefsUrl && !html.includes(PREFERENCES_TOKEN)) html = withPrefsLink(html, o.prefsUrl);
      html = swap(html);
    } else {
      const foot = `<p style="margin:24px 0;font-family:Arial,sans-serif;font-size:12px;color:#9ca3af;text-align:center">${legal}${withUnsub ? `<br>${unsubLink}` : ''}</p>`;
      const at = html.toLowerCase().lastIndexOf('</body>');
      html = at >= 0 ? html.slice(0, at) + foot + html.slice(at) : html + foot;
    }
    let text = o.text?.trim() ? o.text : htmlToText(o.body);
    if (text.includes(UNSUBSCRIBE_TOKEN) && o.prefsUrl && !text.includes(PREFERENCES_TOKEN)) {
      const at = text.lastIndexOf('\n', text.indexOf(UNSUBSCRIBE_TOKEN)) + 1;
      text = `${text.slice(0, at)}Einstellungen: ${PREFERENCES_TOKEN}\n${text.slice(at)}`;
    }
    return { html, text: text.includes(UNSUBSCRIBE_TOKEN) ? swap(text) : text + legalText };
  }
  const bodyHtml = o.isHtml ? swap(o.body) : textToHtml(swap(o.body));
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${bodyHtml}
<p style="margin-top:32px;font-size:12px;color:#9ca3af">${legal}${withUnsub ? `<br>\n${unsubLink}` : ''}</p></body></html>`;
  const text = swap(o.text?.trim() ? o.text : o.isHtml ? o.body.replace(/<[^>]+>/g, '') : o.body) + legalText;
  return { html, text };
}

/** Records an inbound message (from a webhook or IMAP bridge) and fires message.inbound. */
export function receiveMessage(app: App, locationId: string, input: { channel: Channel; from: string; subject?: string; body: string; name?: string; to?: string }) {
  const isEmail = input.channel === 'email';
  const { contact } = upsertContact(app, locationId, { [isEmail ? 'email' : 'phone']: input.from, name: input.name }, { source: isEmail ? 'E-Mail' : 'SMS' });
  const conversationId = getOrCreateConversation(app, locationId, contact.id);
  const msg = {
    id: id(),
    location_id: locationId,
    conversation_id: conversationId,
    contact_id: contact.id,
    channel: input.channel,
    direction: 'in',
    subject: input.subject ?? '',
    body: input.body,
    status: 'received',
    error: '',
    source: 'eingehend',
    created_at: now(),
  };
  app.db.insert('messages', msg);
  app.db.run('UPDATE conversations SET last_message_at = ?, last_message = ?, unread = unread + 1 WHERE id = ?', msg.created_at, preview(msg.body), conversationId);
  if (!isEmail && /^\s*(stop|stopp|abmelden)\s*$/i.test(input.body)) app.db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', contact.id);
  // Receive hook (services/inbound-gate.ts): a blocked sender's message is archived silently – no event, no workflow.
  const claim = inboundGate(app, { locationId, contactId: contact.id, channel: input.channel });
  if (claim) return (claim.archive(conversationId, msg.id), msg);
  logActivity(app, locationId, contact.id, `${input.channel}.received`, `${isEmail ? 'E-Mail' : 'SMS'} empfangen`);
  // `to`: the address the mail was sent to (helpdesk: support address → ticket).
  app.events.emit(locationId, 'message.inbound', { contactId: contact.id, contact, message: msg, ...(input.to ? { to: input.to } : {}) });
  return msg;
}

/** Sends a notification to the team (staff), e.g. "new lead" — not recorded on a contact. */
export async function notifyTeam(app: App, locationId: string, subject: string, body: string, to?: string) {
  const loc = app.location(locationId)!;
  const target = to || loc.email;
  if (!target) return { status: 'skipped' };
  return deliverEmail(loc, { to: target, subject, text: body, html: textToHtml(body) });
}

function preview(s: string) {
  return (isFullHtmlDocument(s) ? htmlToText(s.split(UNSUBSCRIBE_TOKEN).join('#')) : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

export type { Contact };
