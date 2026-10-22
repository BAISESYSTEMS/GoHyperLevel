import { createVerify } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { hmac, readJson, safeEqual, sha256hex, type DeliveryEvent, type FetchLike } from './channel-kit.js';
import { htmlToText } from './email-render.js';

/**
 * Transactional email APIs (Resend, Postmark, Amazon SES, Brevo, Mailgun): sending, a connection
 * test, webhook signature checks and parsers that turn delivery reports and inbound mail into one
 * shape. Pure – the module (modules/email-providers.ts) stores credentials and applies the results.
 */

export type MailProvider = 'resend' | 'postmark' | 'ses' | 'brevo' | 'mailgun';
export interface FieldSpec {
  key: string;
  label: string;
  pattern?: RegExp;
  hint?: string;
  optional?: boolean;
  options?: [string, string][];
}
export interface MailProviderInfo {
  label: string;
  secrets: FieldSpec[];
  config: FieldSpec[];
  /** How webhooks are authenticated. */
  signed: string;
  inbound: boolean;
}

export const MAIL_PROVIDERS: Record<MailProvider, MailProviderInfo> = {
  resend: {
    label: 'Resend',
    secrets: [
      { key: 'api_key', label: 'API-Schlüssel', pattern: /^re_[\w]{8,100}$/, hint: 're_…' },
      { key: 'webhook_secret', label: 'Webhook-Signing-Secret', pattern: /^whsec_[A-Za-z0-9+/=]{16,200}$/, hint: 'whsec_… (Webhooks → Signing Secret)', optional: true },
    ],
    config: [],
    signed: 'Svix-Signatur (svix-id, svix-timestamp, svix-signature)',
    inbound: false,
  },
  postmark: {
    label: 'Postmark',
    secrets: [{ key: 'server_token', label: 'Server-API-Token', pattern: /^[\w-]{20,64}$/ }],
    config: [{ key: 'message_stream', label: 'Message Stream', pattern: /^[\w-]{1,50}$/, hint: 'outbound', optional: true }],
    signed: 'Geheimer Schlüssel in der Webhook-Adresse (Postmark signiert nicht)',
    inbound: true,
  },
  ses: {
    label: 'Amazon SES',
    secrets: [
      { key: 'access_key_id', label: 'Access Key ID', pattern: /^(AKIA|ASIA)[A-Z0-9]{12,20}$/ },
      { key: 'secret_access_key', label: 'Secret Access Key', pattern: /^[A-Za-z0-9/+=]{30,60}$/ },
    ],
    config: [
      { key: 'region', label: 'Region', pattern: /^[a-z]{2}(-[a-z]+)+-\d$/, hint: 'eu-central-1' },
      { key: 'configuration_set', label: 'Configuration Set (für Zustell-Meldungen)', pattern: /^[\w-]{1,64}$/, optional: true },
      { key: 'topic_arn', label: 'SNS-Topic-ARN (nur diese Meldungen annehmen)', pattern: /^arn:aws(-cn)?:sns:[a-z0-9-]+:\d{12}:[\w-]{1,256}$/, optional: true },
    ],
    signed: 'Signatur von Amazon SNS (Zertifikat von sns.<region>.amazonaws.com) + Schlüssel in der Adresse',
    inbound: true,
  },
  brevo: {
    label: 'Brevo',
    secrets: [{ key: 'api_key', label: 'API-Schlüssel', pattern: /^xkeysib-[\w-]{20,200}$/, hint: 'xkeysib-…' }],
    config: [],
    signed: 'Geheimer Schlüssel in der Webhook-Adresse',
    inbound: true,
  },
  mailgun: {
    label: 'Mailgun',
    secrets: [
      { key: 'api_key', label: 'API-Schlüssel', pattern: /^[\w-]{20,100}$/ },
      { key: 'webhook_signing_key', label: 'HTTP Webhook Signing Key', pattern: /^[\w-]{20,100}$/, optional: true },
    ],
    config: [
      { key: 'domain', label: 'Versand-Domain', pattern: /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, hint: 'mg.example.com' },
      { key: 'region', label: 'Region', options: [['eu', 'EU (api.eu.mailgun.net)'], ['us', 'USA (api.mailgun.net)']] },
    ],
    signed: 'HMAC-Signatur (timestamp + token) mit dem Webhook Signing Key',
    inbound: true,
  },
};
export const isMailProvider = (p: unknown): p is MailProvider => typeof p === 'string' && Object.hasOwn(MAIL_PROVIDERS, p);

export interface MailCreds {
  secrets: Record<string, string>;
  config: Record<string, any>;
}
export interface Outgoing {
  fromEmail: string;
  fromName?: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Extra headers such as List-Unsubscribe (RFC 8058). */
  headers?: Record<string, string>;
}

const T = () => AbortSignal.timeout(20_000);
const fromHeader = (name: string | undefined, email: string, encode = false) => {
  const n = String(name ?? '').replace(/["\r\n<>]/g, '').trim();
  if (!n) return email;
  // SES wants non-ASCII display names as MIME encoded-words.
  const shown = encode && /[^\x20-\x7e]/.test(n) ? `=?UTF-8?B?${Buffer.from(n).toString('base64')}?=` : `"${n}"`;
  return `${shown} <${email}>`;
};
const mailgunHost = (c: MailCreds) => (c.config.region === 'us' ? 'api.mailgun.net' : 'api.eu.mailgun.net');
const sesHost = (c: MailCreds) => `email.${c.config.region}.amazonaws.com`;
const stripId = (s: unknown) => String(s ?? '').trim().replace(/^<|>$/g, '');

// --- AWS Signature Version 4 ---------------------------------------------------------------

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signs a request with AWS SigV4; returns the headers to send (incl. host, x-amz-date, authorization). */
export function sigV4(o: { method: string; url: string; body: string; region: string; service: string; accessKeyId: string; secretAccessKey: string; headers?: Record<string, string>; amzDate?: string }): Record<string, string> {
  const u = new URL(o.url);
  const amzDate = o.amzDate ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = String(v);
  headers.host = u.host;
  headers['x-amz-date'] = amzDate;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = u.pathname.split('/').map((s) => rfc3986(decodeURIComponent(s))).join('/') || '/';
  const canonicalRequest = [o.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256hex(o.body)].join('\n');
  const scope = `${date}/${o.region}/${o.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), o.service), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

async function ses(fetcher: FetchLike, c: MailCreds, method: string, path: string, body = ''): Promise<any> {
  const url = `https://${sesHost(c)}${path}`;
  const headers = sigV4({ method, url, body, region: c.config.region, service: 'ses', accessKeyId: c.secrets.access_key_id, secretAccessKey: c.secrets.secret_access_key, headers: body ? { 'content-type': 'application/json' } : {} });
  delete headers.host; // fetch sets it itself (same value)
  const r = await fetcher(url, { method, headers, body: body || undefined, signal: T() });
  return readJson(r, 'Amazon SES', (j) => j?.message || j?.Message);
}

// --- sending --------------------------------------------------------------------------------

export async function sendMail(p: MailProvider, c: MailCreds, m: Outgoing, fetcher: FetchLike): Promise<{ providerId: string }> {
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  switch (p) {
    case 'resend': {
      const r = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: { ...json, authorization: `Bearer ${c.secrets.api_key}` },
        body: JSON.stringify({ from: fromHeader(m.fromName, m.fromEmail), to: [m.to], subject: m.subject, html: m.html, text: m.text, ...(m.replyTo ? { reply_to: m.replyTo } : {}), ...(m.headers ? { headers: m.headers } : {}) }),
        signal: T(),
      });
      const j = await readJson(r, 'Resend');
      return { providerId: String(j.id ?? '') };
    }
    case 'postmark': {
      const r = await fetcher('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { ...json, 'x-postmark-server-token': c.secrets.server_token },
        body: JSON.stringify({ From: fromHeader(m.fromName, m.fromEmail), To: m.to, Subject: m.subject, HtmlBody: m.html, TextBody: m.text, ReplyTo: m.replyTo || undefined, MessageStream: c.config.message_stream || 'outbound', ...(m.headers ? { Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) } : {}) }),
        signal: T(),
      });
      const j = await readJson(r, 'Postmark', (x) => x?.Message);
      if (Number(j.ErrorCode)) throw new Error(`Postmark: ${j.Message ?? j.ErrorCode}`);
      return { providerId: String(j.MessageID ?? '') };
    }
    case 'ses': {
      const body = JSON.stringify({
        FromEmailAddress: fromHeader(m.fromName, m.fromEmail, true),
        Destination: { ToAddresses: [m.to] },
        ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
        Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Html: { Data: m.html, Charset: 'UTF-8' }, Text: { Data: m.text, Charset: 'UTF-8' } }, ...(m.headers ? { Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })) } : {}) } },
        ...(c.config.configuration_set ? { ConfigurationSetName: c.config.configuration_set } : {}),
      });
      const j = await ses(fetcher, c, 'POST', '/v2/email/outbound-emails', body);
      return { providerId: String(j.MessageId ?? '') };
    }
    case 'brevo': {
      const r = await fetcher('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { ...json, 'api-key': c.secrets.api_key },
        body: JSON.stringify({ sender: { email: m.fromEmail, ...(m.fromName ? { name: m.fromName } : {}) }, to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text, ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}), ...(m.headers ? { headers: m.headers } : {}) }),
        signal: T(),
      });
      const j = await readJson(r, 'Brevo');
      return { providerId: stripId(j.messageId) };
    }
    case 'mailgun': {
      const form = new URLSearchParams({ from: fromHeader(m.fromName, m.fromEmail), to: m.to, subject: m.subject, text: m.text, html: m.html });
      if (m.replyTo) form.set('h:Reply-To', m.replyTo);
      for (const [k, v] of Object.entries(m.headers ?? {})) form.set(`h:${k}`, v);
      const r = await fetcher(`https://${mailgunHost(c)}/v3/${encodeURIComponent(c.config.domain)}/messages`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`api:${c.secrets.api_key}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        signal: T(),
      });
      const j = await readJson(r, 'Mailgun');
      return { providerId: stripId(j.id) };
    }
  }
}

/** A harmless read call that proves the credentials work; returns one line for the settings screen. */
export async function testMail(p: MailProvider, c: MailCreds, fetcher: FetchLike): Promise<string> {
  switch (p) {
    case 'resend': {
      const j = await readJson(await fetcher('https://api.resend.com/domains', { headers: { authorization: `Bearer ${c.secrets.api_key}` }, signal: T() }), 'Resend');
      const list: any[] = Array.isArray(j.data) ? j.data : [];
      return list.length ? `Domains: ${list.slice(0, 5).map((d) => `${d.name} (${d.status === 'verified' ? 'bestätigt' : d.status})`).join(', ')}` : 'Verbunden – noch keine Domain bestätigt';
    }
    case 'postmark': {
      const j = await readJson(await fetcher('https://api.postmarkapp.com/server', { headers: { accept: 'application/json', 'x-postmark-server-token': c.secrets.server_token }, signal: T() }), 'Postmark', (x) => x?.Message);
      return `Server „${j.Name ?? '?'}“`;
    }
    case 'ses': {
      const j = await ses(fetcher, c, 'GET', '/v2/email/account');
      const quota = j.SendQuota?.Max24HourSend ? ` · max. ${j.SendQuota.Max24HourSend} pro Tag` : '';
      return `SES ${c.config.region}: ${j.ProductionAccessEnabled ? 'Produktion' : 'Sandbox – nur an bestätigte Adressen'}${quota}`;
    }
    case 'brevo': {
      const j = await readJson(await fetcher('https://api.brevo.com/v3/account', { headers: { accept: 'application/json', 'api-key': c.secrets.api_key }, signal: T() }), 'Brevo');
      return `Konto ${j.email ?? ''}${j.companyName ? ` (${j.companyName})` : ''}`.trim();
    }
    case 'mailgun': {
      const j = await readJson(await fetcher(`https://${mailgunHost(c)}/v3/domains/${encodeURIComponent(c.config.domain)}`, { headers: { authorization: `Basic ${Buffer.from(`api:${c.secrets.api_key}`).toString('base64')}` }, signal: T() }), 'Mailgun');
      return `Domain ${j.domain?.name ?? c.config.domain} (${j.domain?.state === 'active' ? 'aktiv' : (j.domain?.state ?? '?')})`;
    }
  }
}

// --- webhooks: signatures ---------------------------------------------------------------------

/** Svix (Resend): base64 HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>" with the decoded whsec_ secret. */
export function signSvix(raw: string, msgId: string, timestamp: string, secret: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${hmac(key, `${msgId}.${timestamp}.${raw}`).toString('base64')}`;
}
export function verifySvix(raw: string, msgId: string, timestamp: string, signatures: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !msgId || !/^\d{1,12}$/.test(timestamp) || Math.abs(nowSec - Number(timestamp)) > 300) return false;
  const expected = signSvix(raw, msgId, timestamp, secret);
  return String(signatures ?? '').split(' ').some((s) => safeEqual(s.trim(), expected));
}

/** Mailgun: hex HMAC-SHA256 over timestamp + token with the webhook signing key (max. 15 minutes old). */
export function signMailgun(timestamp: string, tokenValue: string, key: string): string {
  return hmac(key, `${timestamp}${tokenValue}`).toString('hex');
}
export function verifyMailgun(sig: { timestamp?: unknown; token?: unknown; signature?: unknown } | undefined, key: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const ts = String(sig?.timestamp ?? '');
  const tok = String(sig?.token ?? '');
  if (!key || !/^\d{1,12}$/.test(ts) || !tok || Math.abs(nowSec - Number(ts)) > 900) return false;
  return safeEqual(String(sig?.signature ?? ''), signMailgun(ts, tok, key));
}

/** The string Amazon SNS signs (fields depend on the message type). */
export function snsStringToSign(m: Record<string, any>): string {
  const keys = m.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.filter((k) => m[k] !== undefined && m[k] !== null && !(k === 'Subject' && m[k] === '')).map((k) => `${k}\n${m[k]}\n`).join('');
}
export const isSnsHost = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
  } catch {
    return false;
  }
};

/** Checks an SNS message's RSA signature against Amazon's signing certificate (only fetched from sns.*.amazonaws.com). */
export async function verifySns(m: Record<string, any>, fetcher: FetchLike, cache: Map<string, string>): Promise<boolean> {
  if (!m || !['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(m.Type)) return false;
  const certUrl = String(m.SigningCertURL ?? m.SigningCertUrl ?? '');
  if (!isSnsHost(certUrl) || !new URL(certUrl).pathname.endsWith('.pem')) return false;
  const alg = m.SignatureVersion === '2' ? 'RSA-SHA256' : m.SignatureVersion === '1' ? 'RSA-SHA1' : '';
  if (!alg || !m.Signature) return false;
  let pem = cache.get(certUrl);
  if (!pem) {
    try {
      const r = await fetcher(certUrl, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return false;
      pem = await r.text();
    } catch {
      return false;
    }
    if (!pem.includes('-----BEGIN')) return false;
    if (cache.size > 50) cache.clear();
    cache.set(certUrl, pem);
  }
  try {
    return createVerify(alg).update(snsStringToSign(m), 'utf8').verify(pem, String(m.Signature), 'base64');
  } catch {
    return false;
  }
}

// --- webhooks: parsing ------------------------------------------------------------------------

export interface InboundMail {
  from: string;
  name?: string;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
}
export interface MailWebhook {
  events: DeliveryEvent[];
  inbound: InboundMail[];
}

const cleanEmail = (s: unknown) => {
  const raw = String(s ?? '');
  const e = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e) ? e.slice(0, 254) : '';
};
const nameOf = (s: unknown) => String(s ?? '').match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim().slice(0, 120);
const bodyText = (text: unknown, html: unknown) => String(text || (html ? htmlToText(String(html)) : '')).slice(0, 50_000);

export function parseResend(b: any): MailWebhook {
  const id = String(b?.data?.email_id ?? '');
  const type = String(b?.type ?? '');
  const map: Record<string, DeliveryEvent['status']> = { 'email.sent': 'sent', 'email.delivered': 'delivered', 'email.delivery_delayed': 'deferred', 'email.complained': 'complained', 'email.failed': 'failed', 'email.bounced': 'bounced' };
  let status = map[type];
  if (!id || !status) return { events: [], inbound: [] };
  const transient = type === 'email.bounced' && /transient|temporary|soft/i.test(String(b.data?.bounce?.type ?? ''));
  if (transient) status = 'deferred';
  const reason = String(b.data?.bounce?.message ?? b.data?.failed?.reason ?? '');
  return { events: [{ providerId: id, status, permanent: status === 'bounced', reason }], inbound: [] };
}

const POSTMARK_HARD = ['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated', 'Blocked', 'SpamNotification', 'Unsubscribe'];
export function parsePostmark(b: any): MailWebhook {
  const rt = String(b?.RecordType ?? '');
  if ((!rt || rt === 'Inbound') && (b?.FromFull || b?.From) && (b?.TextBody !== undefined || b?.HtmlBody !== undefined)) {
    const from = cleanEmail(b.FromFull?.Email ?? b.From);
    if (!from) return { events: [], inbound: [] };
    return {
      events: [],
      inbound: [{ from, name: String(b.FromFull?.Name || b.FromName || '').slice(0, 120) || undefined, to: String(b.OriginalRecipient || b.To || '').slice(0, 1000), subject: String(b.Subject ?? '').slice(0, 300), text: bodyText(b.StrippedTextReply || b.TextBody, b.HtmlBody), messageId: String(b.MessageID ?? '') || undefined }],
    };
  }
  const id = String(b?.MessageID ?? '');
  if (!id) return { events: [], inbound: [] };
  const eventId = `${rt}:${b.ID ?? id}`;
  if (rt === 'Delivery') return { events: [{ providerId: id, status: 'delivered', eventId }], inbound: [] };
  if (rt === 'Bounce') {
    const hard = b.Inactive === true || POSTMARK_HARD.includes(String(b.Type));
    return { events: [{ providerId: id, status: hard ? 'bounced' : 'deferred', permanent: hard, reason: String(b.Description || b.Details || b.Type || ''), eventId }], inbound: [] };
  }
  if (rt === 'SpamComplaint') return { events: [{ providerId: id, status: 'complained', eventId }], inbound: [] };
  if (rt === 'SubscriptionChange' && b.SuppressSending === true) return { events: [{ providerId: id, status: 'unsubscribed', eventId }], inbound: [] };
  return { events: [], inbound: [] };
}

export function parseBrevo(b: any): MailWebhook {
  if (Array.isArray(b?.items)) {
    const inbound: InboundMail[] = [];
    for (const it of b.items.slice(0, 20)) {
      const from = cleanEmail(it?.From?.Address ?? it?.Sender?.Address);
      if (!from) continue;
      inbound.push({ from, name: String(it.From?.Name ?? '').slice(0, 120) || undefined, to: (Array.isArray(it.To) ? it.To : []).map((x: any) => x?.Address).filter(Boolean).join(', ').slice(0, 1000), subject: String(it.Subject ?? '').slice(0, 300), text: bodyText(it.ExtractedMarkdownMessage || it.RawTextBody, it.RawHtmlBody), messageId: String(it.MessageId ?? it.Uuid ?? '') || undefined });
    }
    return { events: [], inbound };
  }
  const id = stripId(b?.['message-id'] ?? b?.messageId);
  const ev = String(b?.event ?? '');
  const map: Record<string, [DeliveryEvent['status'], boolean?]> = {
    request: ['sent'],
    sent: ['sent'],
    delivered: ['delivered'],
    soft_bounce: ['deferred'],
    deferred: ['deferred'],
    hard_bounce: ['bounced', true],
    invalid_email: ['bounced', true],
    blocked: ['failed'],
    error: ['failed'],
    spam: ['complained'],
    complaint: ['complained'],
    unsubscribed: ['unsubscribed'],
  };
  const hit = map[ev];
  if (!id || !hit) return { events: [], inbound: [] };
  return { events: [{ providerId: id, status: hit[0], permanent: !!hit[1], reason: String(b.reason ?? ''), eventId: `${ev}:${b.id ?? id}:${b.ts_event ?? b.ts ?? ''}` }], inbound: [] };
}

export function parseMailgun(b: any): MailWebhook {
  const d = b?.['event-data'];
  if (d && typeof d === 'object') {
    const id = stripId(d.message?.headers?.['message-id']);
    const ev = String(d.event ?? '');
    const reason = String(d['delivery-status']?.description || d['delivery-status']?.message || d.reason || '').slice(0, 300);
    let status: DeliveryEvent['status'] | undefined;
    let permanent = false;
    if (ev === 'accepted') status = 'sent';
    else if (ev === 'delivered') status = 'delivered';
    else if (ev === 'failed') {
      permanent = d.severity === 'permanent';
      status = permanent ? 'bounced' : 'deferred';
    } else if (ev === 'complained') status = 'complained';
    else if (ev === 'unsubscribed') status = 'unsubscribed';
    if (!id || !status) return { events: [], inbound: [] };
    return { events: [{ providerId: id, status, permanent, reason, eventId: String(d.id ?? '') || undefined }], inbound: [] };
  }
  // Inbound route (forward()): form fields.
  const from = cleanEmail(b?.sender || b?.from || b?.From);
  if (!from || (b?.['body-plain'] === undefined && b?.['stripped-text'] === undefined && b?.['body-html'] === undefined)) return { events: [], inbound: [] };
  return {
    events: [],
    inbound: [{ from, name: nameOf(b.from ?? b.From), to: String(b.recipient ?? b.To ?? '').slice(0, 1000), subject: String(b.subject ?? b.Subject ?? '').slice(0, 300), text: bodyText(b['stripped-text'] || b['body-plain'], b['body-html']), messageId: stripId(b['Message-Id'] ?? b['message-id']) || undefined }],
  };
}

/** The JSON inside an SES notification (SNS "Message"): delivery events or an inbound mail (receipt rule with SNS action). */
export async function parseSesMessage(message: string): Promise<MailWebhook> {
  let n: any;
  try {
    n = JSON.parse(message);
  } catch {
    return { events: [], inbound: [] };
  }
  const type = String(n?.eventType ?? n?.notificationType ?? '');
  const id = String(n?.mail?.messageId ?? '');
  if (type === 'Received') {
    if (typeof n.content !== 'string' || !n.content) return { events: [], inbound: [] };
    const raw = n.receipt?.action?.encoding === 'BASE64' ? Buffer.from(n.content, 'base64') : Buffer.from(n.content, 'utf8');
    const p = await simpleParser(raw);
    const fromAddr = (p.from?.value ?? [])[0];
    const from = cleanEmail(fromAddr?.address);
    if (!from) return { events: [], inbound: [] };
    const to = (Array.isArray(p.to) ? p.to : p.to ? [p.to] : []).map((x) => x.text).join(', ') || (n.receipt?.recipients ?? []).join(', ');
    return { events: [], inbound: [{ from, name: fromAddr?.name || undefined, to: String(to).slice(0, 1000), subject: String(p.subject ?? '').slice(0, 300), text: bodyText(p.text, p.html || ''), messageId: stripId(p.messageId) || id || undefined }] };
  }
  if (!id) return { events: [], inbound: [] };
  switch (type) {
    case 'Send':
      return { events: [{ providerId: id, status: 'sent' }], inbound: [] };
    case 'Delivery':
      return { events: [{ providerId: id, status: 'delivered' }], inbound: [] };
    case 'DeliveryDelay':
      return { events: [{ providerId: id, status: 'deferred', reason: String(n.deliveryDelay?.delayType ?? '') }], inbound: [] };
    case 'Bounce': {
      const hard = n.bounce?.bounceType === 'Permanent';
      const r = n.bounce?.bouncedRecipients?.[0];
      return { events: [{ providerId: id, status: hard ? 'bounced' : 'deferred', permanent: hard, reason: String(r?.diagnosticCode || n.bounce?.bounceSubType || '') }], inbound: [] };
    }
    case 'Complaint':
      return { events: [{ providerId: id, status: 'complained' }], inbound: [] };
    case 'Reject':
      return { events: [{ providerId: id, status: 'failed', reason: String(n.reject?.reason ?? 'Von SES abgelehnt') }], inbound: [] };
  }
  return { events: [], inbound: [] };
}

/** Text fields of a multipart/form-data body (files are skipped) – Mailgun posts inbound mail this way. */
export function parseMultipart(raw: string, contentType: string): Record<string, string> {
  const boundary = String(contentType ?? '').match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${b}`)) {
    const sep = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
    const at = part.indexOf(sep);
    if (at < 0) continue;
    const head = part.slice(0, at);
    const name = head.match(/name="([^"]*)"/i)?.[1];
    if (!name || /filename=/i.test(head) || Object.keys(out).length > 200) continue;
    out[name] = part.slice(at + sep.length).replace(/\r?\n$/, '');
  }
  return out;
}
