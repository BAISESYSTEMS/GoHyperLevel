import { createHash } from 'node:crypto';
import { hmac, readJson, safeEqual, sha256hex, type DeliveryEvent, type FetchLike } from './channel-kit.js';
import type { FieldSpec } from './email-providers.js';

/**
 * SMS APIs for Europe and worldwide besides Twilio: seven.io, Bird (formerly MessageBird), Vonage
 * (Messages API), Plivo. Sending, a connection test, webhook signatures and parsers for delivery
 * reports and inbound SMS. Pure – modules/sms-providers.ts stores credentials and applies results.
 */

export type SmsProvider = 'seven' | 'bird' | 'vonage' | 'plivo';
export interface SmsProviderInfo {
  label: string;
  secrets: FieldSpec[];
  config: FieldSpec[];
  signed: string;
}

const SENDER: FieldSpec = { key: 'from', label: 'Absender (Nummer oder Name, max. 11 Zeichen)', pattern: /^(\+?\d{3,15}|[A-Za-z0-9 ]{1,11})$/, hint: '+4930… oder Firma' };

export const SMS_PROVIDERS: Record<SmsProvider, SmsProviderInfo> = {
  seven: {
    label: 'seven.io',
    secrets: [
      { key: 'api_key', label: 'API-Schlüssel', pattern: /^[A-Za-z0-9]{20,100}$/ },
      { key: 'signing_secret', label: 'Signatur-Geheimnis (Webhooks)', pattern: /^[\w-]{8,200}$/, optional: true },
    ],
    config: [{ ...SENDER, optional: true }],
    signed: 'HMAC-Signatur (X-Signature, X-Timestamp, X-Nonce), wenn ein Signatur-Geheimnis eingetragen ist; sonst Schlüssel in der Adresse',
  },
  bird: {
    label: 'Bird (MessageBird)',
    secrets: [
      { key: 'access_key', label: 'Access Key', pattern: /^[\w-]{20,200}$/ },
      { key: 'signing_key', label: 'Webhook Signing Key', pattern: /^[\w-]{8,200}$/, optional: true },
    ],
    config: [
      { key: 'workspace_id', label: 'Workspace-ID', pattern: /^[0-9a-f-]{36}$/i },
      { key: 'channel_id', label: 'SMS-Kanal-ID', pattern: /^[0-9a-f-]{36}$/i },
    ],
    signed: 'HMAC-Signatur (messagebird-signature, messagebird-request-timestamp), wenn ein Signing Key eingetragen ist',
  },
  vonage: {
    label: 'Vonage',
    secrets: [
      { key: 'api_key', label: 'API Key', pattern: /^[A-Za-z0-9]{6,20}$/ },
      { key: 'api_secret', label: 'API Secret', pattern: /^[A-Za-z0-9]{8,64}$/ },
      { key: 'signature_secret', label: 'Signature Secret (signierte Webhooks)', pattern: /^[A-Za-z0-9]{16,128}$/, optional: true },
    ],
    config: [SENDER],
    signed: 'Signiertes JWT (HS256 mit dem Signature Secret, payload_hash), wenn eingetragen',
  },
  plivo: {
    label: 'Plivo',
    secrets: [
      { key: 'auth_id', label: 'Auth ID', pattern: /^[MS]A[A-Z0-9]{16,24}$/ },
      { key: 'auth_token', label: 'Auth Token', pattern: /^[A-Za-z0-9]{20,64}$/ },
    ],
    config: [SENDER],
    signed: 'X-Plivo-Signature-V2 (HMAC mit dem Auth Token) – immer geprüft',
  },
};
export const isSmsProvider = (p: unknown): p is SmsProvider => typeof p === 'string' && Object.hasOwn(SMS_PROVIDERS, p);

export interface SmsCreds {
  secrets: Record<string, string>;
  config: Record<string, any>;
}

const T = () => AbortSignal.timeout(15_000);
const digits = (phone: string) => String(phone ?? '').replace(/\D/g, '');
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

// --- sending --------------------------------------------------------------------------------

export async function sendSms(p: SmsProvider, c: SmsCreds, to: string, text: string, fetcher: FetchLike, statusUrl?: string): Promise<{ providerId: string }> {
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  if (digits(to).length < 6) throw new Error('Telefonnummer ungültig');
  switch (p) {
    case 'seven': {
      const r = await fetcher('https://gateway.seven.io/api/sms', {
        method: 'POST',
        headers: { ...json, 'x-api-key': c.secrets.api_key },
        body: JSON.stringify({ to: `+${digits(to)}`, text, ...(c.config.from ? { from: c.config.from } : {}) }),
        signal: T(),
      });
      const j = await readJson(r, 'seven.io');
      const code = String(j.success ?? j);
      const m = Array.isArray(j.messages) ? j.messages[0] : null;
      if (code !== '100' || (m && m.success === false)) throw new Error(`seven.io: ${m?.error_text || m?.error || `Fehlercode ${code}`}`);
      return { providerId: String(m?.id ?? '') };
    }
    case 'bird': {
      const r = await fetcher(`https://api.bird.com/workspaces/${encodeURIComponent(c.config.workspace_id)}/channels/${encodeURIComponent(c.config.channel_id)}/messages`, {
        method: 'POST',
        headers: { ...json, authorization: `AccessKey ${c.secrets.access_key}` },
        body: JSON.stringify({ receiver: { contacts: [{ identifierKey: 'phonenumber', identifierValue: `+${digits(to)}` }] }, body: { type: 'text', text: { text } } }),
        signal: T(),
      });
      const j = await readJson(r, 'Bird');
      return { providerId: String(j.id ?? '') };
    }
    case 'vonage': {
      const r = await fetcher('https://api.nexmo.com/v1/messages', {
        method: 'POST',
        headers: { ...json, authorization: basic(c.secrets.api_key, c.secrets.api_secret) },
        body: JSON.stringify({ message_type: 'text', channel: 'sms', to: digits(to), from: String(c.config.from ?? '').replace(/^\+/, ''), text }),
        signal: T(),
      });
      const j = await readJson(r, 'Vonage', (x) => x?.detail || x?.title);
      return { providerId: String(j.message_uuid ?? '') };
    }
    case 'plivo': {
      const r = await fetcher(`https://api.plivo.com/v1/Account/${encodeURIComponent(c.secrets.auth_id)}/Message/`, {
        method: 'POST',
        headers: { ...json, authorization: basic(c.secrets.auth_id, c.secrets.auth_token) },
        body: JSON.stringify({ src: String(c.config.from ?? '').replace(/^\+/, ''), dst: digits(to), text, ...(statusUrl ? { url: statusUrl, method: 'POST' } : {}) }),
        signal: T(),
      });
      const j = await readJson(r, 'Plivo', (x) => x?.error);
      return { providerId: String((Array.isArray(j.message_uuid) ? j.message_uuid[0] : j.message_uuid) ?? '') };
    }
  }
}

export async function testSms(p: SmsProvider, c: SmsCreds, fetcher: FetchLike): Promise<string> {
  switch (p) {
    case 'seven': {
      const j = await readJson(await fetcher('https://gateway.seven.io/api/balance', { headers: { 'x-api-key': c.secrets.api_key, accept: 'application/json' }, signal: T() }), 'seven.io');
      const amount = typeof j === 'number' ? j : Number(j.amount ?? j.balance);
      return Number.isFinite(amount) ? `Guthaben ${amount.toFixed(2)} ${j.currency ?? 'EUR'}` : 'Verbunden';
    }
    case 'bird': {
      const j = await readJson(await fetcher(`https://api.bird.com/workspaces/${encodeURIComponent(c.config.workspace_id)}/channels/${encodeURIComponent(c.config.channel_id)}`, { headers: { authorization: `AccessKey ${c.secrets.access_key}` }, signal: T() }), 'Bird');
      return `Kanal „${j.name ?? j.id ?? '?'}“${j.status ? ` (${j.status})` : ''}`;
    }
    case 'vonage': {
      const j = await readJson(await fetcher('https://rest.nexmo.com/account/get-balance', { headers: { authorization: basic(c.secrets.api_key, c.secrets.api_secret) }, signal: T() }), 'Vonage', (x) => x?.['error-code-label']);
      return j.value !== undefined ? `Guthaben ${Number(j.value).toFixed(2)} EUR` : 'Verbunden';
    }
    case 'plivo': {
      const j = await readJson(await fetcher(`https://api.plivo.com/v1/Account/${encodeURIComponent(c.secrets.auth_id)}/`, { headers: { authorization: basic(c.secrets.auth_id, c.secrets.auth_token) }, signal: T() }), 'Plivo', (x) => x?.error);
      return `Konto ${j.name || j.auth_id || ''}${j.cash_credits ? ` · Guthaben ${j.cash_credits}` : ''}`.trim();
    }
  }
}

// --- webhook signatures ---------------------------------------------------------------------

/** seven.io: hex HMAC-SHA256 over "timestamp\nnonce\nMETHOD\nurl\nmd5(body)". */
export function signSeven(o: { timestamp: string; nonce: string; method: string; url: string; body: string }, secret: string): string {
  const md5 = createHash('md5').update(o.body).digest('hex');
  return hmac(secret, [o.timestamp, o.nonce, o.method.toUpperCase(), o.url, md5].join('\n')).toString('hex');
}
export function verifySeven(o: { timestamp: string; nonce: string; method: string; url: string; body: string; signature: string }, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !/^\d{1,12}$/.test(o.timestamp) || !o.nonce || Math.abs(nowSec - Number(o.timestamp)) > 300) return false;
  return safeEqual(o.signature.toLowerCase(), signSeven(o, secret));
}

/** Bird: base64 HMAC-SHA256 over "timestamp\nurl\n" + SHA-256(body) (raw bytes). */
export function signBird(timestamp: string, url: string, body: string, key: string): string {
  const digest = createHash('sha256').update(body).digest();
  return hmac(key, Buffer.concat([Buffer.from(`${timestamp}\n${url}\n`), digest])).toString('base64');
}
export function verifyBird(timestamp: string, url: string, body: string, signature: string, key: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!key || !/^\d{1,13}$/.test(timestamp)) return false;
  const ts = Number(timestamp) > 1e11 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (Math.abs(nowSec - ts) > 300) return false;
  return safeEqual(signature, signBird(timestamp, url, body, key));
}

const b64uJson = (s: string) => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};
/** Vonage signed webhooks: Authorization: Bearer <JWT HS256 with the signature secret>, payload_hash = SHA-256 of the body. */
export function signVonageJwt(rawBody: string, secret: string, iat = Math.floor(Date.now() / 1000)): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ iat, jti: String(iat), iss: 'Vonage', payload_hash: sha256hex(rawBody) })).toString('base64url');
  return `${h}.${p}.${hmac(secret, `${h}.${p}`).toString('base64url')}`;
}
export function verifyVonageJwt(authorization: string, secret: string, rawBody: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const tok = String(authorization ?? '').match(/^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i)?.[1];
  if (!tok || !secret) return false;
  const [h, p, s] = tok.split('.');
  if (b64uJson(h)?.alg !== 'HS256') return false;
  if (!safeEqual(s, hmac(secret, `${h}.${p}`).toString('base64url'))) return false;
  const claims = b64uJson(p);
  if (!claims || claims.payload_hash !== sha256hex(rawBody)) return false;
  return !claims.iat || Math.abs(nowSec - Number(claims.iat)) <= 600;
}

/** Plivo V2: base64 HMAC-SHA256 over URL (without query) + nonce with the auth token. */
export function signPlivo(url: string, nonce: string, authToken: string): string {
  const u = new URL(url);
  return hmac(authToken, `${u.protocol}//${u.host}${u.pathname}${nonce}`).toString('base64');
}
export function verifyPlivo(url: string, nonce: string, signature: string, authToken: string): boolean {
  if (!authToken || !nonce || !signature) return false;
  return safeEqual(signature, signPlivo(url, nonce, authToken));
}

// --- webhook parsing ------------------------------------------------------------------------

export interface InboundSms {
  from: string;
  to: string;
  text: string;
  id: string;
}
export interface SmsWebhook {
  events: DeliveryEvent[];
  inbound: InboundSms[];
}
const none = (): SmsWebhook => ({ events: [], inbound: [] });
const phone = (s: unknown) => {
  const d = digits(String(s ?? ''));
  return d.length >= 6 && d.length <= 15 ? `+${d}` : '';
};

export function parseSeven(b: any): SmsWebhook {
  const d = b?.data ?? {};
  if (b?.webhook_event === 'sms_mo') {
    const from = phone(d.sender);
    return from && d.text !== undefined ? { events: [], inbound: [{ from, to: String(d.system ?? ''), text: String(d.text).slice(0, 5000), id: String(d.id ?? d.msg_id ?? '') }] } : none();
  }
  if (b?.webhook_event === 'dlr') {
    const s = String(d.status ?? '').toUpperCase();
    const status: DeliveryEvent['status'] | undefined = s === 'DELIVERED' ? 'delivered' : ['NOTDELIVERED', 'REJECTED', 'EXPIRED', 'FAILED'].includes(s) ? 'failed' : ['TRANSMITTED', 'BUFFERED', 'ACCEPTED'].includes(s) ? 'sent' : undefined;
    const id = String(d.msg_id ?? '');
    return id && status ? { events: [{ providerId: id, status, reason: status === 'failed' ? `Status ${s}` : undefined, eventId: `${id}:${s}` }], inbound: [] } : none();
  }
  return none();
}

export function parseBird(b: any): SmsWebhook {
  const ev = String(b?.event ?? '');
  const p = b?.payload ?? {};
  if (ev === 'sms.inbound' || (p.direction === 'incoming' && p.body)) {
    const from = phone(p.sender?.contact?.identifierValue ?? p.sender?.identifierValue);
    const text = String(p.body?.text?.text ?? '');
    return from && text ? { events: [], inbound: [{ from, to: String(p.receiver?.connector?.identifierValue ?? ''), text: text.slice(0, 5000), id: String(p.id ?? '') }] } : none();
  }
  if (ev === 'sms.outbound' || p.direction === 'outgoing') {
    const s = String(p.status ?? '').toLowerCase();
    const status: DeliveryEvent['status'] | undefined = s === 'delivered' ? 'delivered' : s.includes('fail') || s === 'rejected' ? 'failed' : s === 'sent' ? 'sent' : undefined;
    const id = String(p.id ?? '');
    return id && status ? { events: [{ providerId: id, status, reason: p.reason ? String(p.reason) : undefined, eventId: `${id}:${s}` }], inbound: [] } : none();
  }
  return none();
}

export function parseVonage(b: any): SmsWebhook {
  const id = String(b?.message_uuid ?? '');
  if (!id) return none();
  if (b.status) {
    const s = String(b.status).toLowerCase();
    const status: DeliveryEvent['status'] | undefined = s === 'delivered' || s === 'read' ? 'delivered' : ['rejected', 'undeliverable', 'failed'].includes(s) ? 'failed' : s === 'submitted' ? 'sent' : undefined;
    return status ? { events: [{ providerId: id, status, reason: b.error?.title || b.error?.detail || undefined, eventId: `${id}:${s}` }], inbound: [] } : none();
  }
  const from = phone(b.from);
  return from && b.text !== undefined ? { events: [], inbound: [{ from, to: String(b.to ?? ''), text: String(b.text).slice(0, 5000), id }] } : none();
}

export function parsePlivo(b: any): SmsWebhook {
  const id = String(b?.MessageUUID ?? '');
  if (!id) return none();
  if (b.Status) {
    const s = String(b.Status).toLowerCase();
    const status: DeliveryEvent['status'] | undefined = s === 'delivered' ? 'delivered' : ['failed', 'undelivered', 'rejected'].includes(s) ? 'failed' : s === 'sent' ? 'sent' : undefined;
    return status ? { events: [{ providerId: id, status, reason: b.ErrorCode && b.ErrorCode !== '0' ? `Fehlercode ${b.ErrorCode}` : undefined, eventId: `${id}:${s}` }], inbound: [] } : none();
  }
  const from = phone(b.From);
  return from && b.Text !== undefined ? { events: [], inbound: [{ from, to: String(b.To ?? ''), text: String(b.Text).slice(0, 5000), id }] } : none();
}
