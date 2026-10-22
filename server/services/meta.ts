import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta messaging (WhatsApp Cloud API, Messenger, Instagram Direct): the pure parts – webhook
 * signatures, turning webhook payloads into a flat list of events, WhatsApp templates and a small
 * Graph API client. The module (server/modules/meta-channels.ts) does storage and routes.
 */

export const GRAPH_BASE = 'https://graph.facebook.com';
export const DEFAULT_GRAPH_VERSION = 'v21.0';
export type MetaChannel = 'whatsapp' | 'messenger' | 'instagram';
export const META_CHANNELS: MetaChannel[] = ['whatsapp', 'messenger', 'instagram'];
export const CHANNEL_LABEL: Record<MetaChannel, string> = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram' };
/** Longest text each platform accepts in one message. */
export const TEXT_LIMITS: Record<MetaChannel, number> = { whatsapp: 4096, messenger: 2000, instagram: 1000 };
/** Customer service window: free text only within 24 h of the contact's last message. */
export const WINDOW_MS = 24 * 3600_000;
const PREFIX: Record<MetaChannel, string> = { whatsapp: 'wa:', messenger: 'fb:', instagram: 'ig:' };
export const externalId = (channel: MetaChannel, providerId: string) => PREFIX[channel] + providerId;

// --- signatures -----------------------------------------------------------------

/** X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256 of the raw request body, keyed with the app secret. */
export function signBody(raw: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw).digest('hex')}`;
}

/** Constant-time check of Meta's webhook signature. */
export function verifySignature(raw: string | Buffer, header: string | string[] | undefined, appSecret: string): boolean {
  const h = Array.isArray(header) ? header[0] : header;
  if (!appSecret || !h) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(h.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw).digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Constant-time string comparison (verify token). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

// --- webhook payloads -------------------------------------------------------------

export interface Attachment {
  kind: string;
  /** WhatsApp media id – the file itself is fetched lazily through the Graph API. */
  media_id?: string;
  /** Messenger/Instagram: CDN address Meta hands out with the message. */
  url?: string;
  mime?: string;
  filename?: string;
  voice?: boolean;
  lat?: number;
  lng?: number;
}

export interface InboundMessage {
  kind: 'message';
  channel: MetaChannel;
  /** phone_number_id (WhatsApp), page id or Instagram account id – which account received it. */
  account: string;
  /** wa_id / PSID / IGSID of the sender. */
  from: string;
  /** WhatsApp profile name, when Meta sends one. */
  name?: string;
  externalId: string;
  at: string;
  body: string;
  attachment?: Attachment;
}

export interface StatusUpdate {
  kind: 'status';
  channel: MetaChannel;
  account: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** One message… */
  externalId?: string;
  /** …or everything sent to `party` up to `watermark` (Messenger reads/deliveries). */
  party?: string;
  watermark?: string;
  error?: string;
  at: string;
}

export type MetaEvent = InboundMessage | StatusUpdate;

function isoFrom(ts: unknown, unit: 's' | 'ms'): string {
  const n = Number(ts);
  const ms = unit === 's' ? n * 1000 : n;
  // Meta's clock, unless it is missing or clearly off (then: now).
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 5 * 60_000) return new Date().toISOString();
  return new Date(ms).toISOString();
}

const clip = (s: unknown, max = 4096) => String(s ?? '').slice(0, max);
const withCaption = (label: string, caption: unknown) => (caption ? `${label}\n${clip(caption, 2000)}` : label);

/** WhatsApp message → readable text (+ attachment) for the inbox. */
export function whatsappBody(m: any): { body: string; attachment?: Attachment } {
  const media = (kind: string, o: any = {}): Attachment => ({ kind, media_id: o.id ? String(o.id) : undefined, mime: o.mime_type ? String(o.mime_type) : undefined, filename: o.filename ? clip(o.filename, 200) : undefined, voice: o.voice ? true : undefined });
  switch (m?.type) {
    case 'text':
      return { body: clip(m.text?.body) };
    case 'image':
      return { body: withCaption('📷 Bild', m.image?.caption), attachment: media('image', m.image) };
    case 'video':
      return { body: withCaption('🎬 Video', m.video?.caption), attachment: media('video', m.video) };
    case 'audio':
      return { body: m.audio?.voice ? '🎤 Sprachnachricht' : '🎵 Audio', attachment: media('audio', m.audio) };
    case 'document':
      return { body: withCaption(`📄 ${clip(m.document?.filename || 'Dokument', 200)}`, m.document?.caption), attachment: media('document', m.document) };
    case 'sticker':
      return { body: 'Sticker', attachment: media('sticker', m.sticker) };
    case 'location': {
      const l = m.location ?? {};
      const lat = Number(l.latitude);
      const lng = Number(l.longitude);
      const place = [l.name, l.address].filter(Boolean).map((x) => clip(x, 300)).join(', ');
      return { body: `📍 Standort${place ? `: ${place}` : ''}`, attachment: Number.isFinite(lat) && Number.isFinite(lng) ? { kind: 'location', lat, lng } : undefined };
    }
    case 'contacts': {
      const list = (Array.isArray(m.contacts) ? m.contacts : []).map((c: any) => [c.name?.formatted_name, c.phones?.[0]?.phone].filter(Boolean).join(' '));
      return { body: `👤 Kontakt geteilt: ${clip(list.join('; '), 1000) || '–'}` };
    }
    case 'button':
      return { body: clip(m.button?.text || m.button?.payload) };
    case 'interactive': {
      const i = m.interactive ?? {};
      const r = i.button_reply ?? i.list_reply;
      if (r) return { body: clip(r.title || r.id) + (r.description ? `\n${clip(r.description, 300)}` : '') };
      return { body: 'Antwort auf ein Formular' };
    }
    case 'reaction':
      return { body: m.reaction?.emoji ? `Reagiert mit ${clip(m.reaction.emoji, 20)}` : '' };
    case 'order':
      return { body: `🛒 Bestellung (${(m.order?.product_items ?? []).length} Artikel)` };
    default:
      return { body: '(Nachrichtentyp wird hier nicht angezeigt – bitte in WhatsApp ansehen)' };
  }
}

/** Messenger/Instagram message → text (+ first attachment). */
function messengerBody(msg: any): { body: string; attachment?: Attachment } {
  const text = clip(msg?.text, 4096);
  const a = Array.isArray(msg?.attachments) ? msg.attachments[0] : undefined;
  if (!a) return { body: text };
  const url = typeof a.payload?.url === 'string' && /^https:\/\//.test(a.payload.url) ? a.payload.url : undefined;
  const LABEL: Record<string, string> = { image: '📷 Bild', video: '🎬 Video', audio: '🎤 Audio', file: '📄 Datei', share: '🔗 Geteilter Beitrag', story_mention: '📣 Hat dich in einer Story erwähnt', reel: '🎬 Reel', ig_reel: '🎬 Reel', sticker: 'Sticker', location: '📍 Standort' };
  if (a.type === 'location' && a.payload?.coordinates) {
    const lat = Number(a.payload.coordinates.lat);
    const lng = Number(a.payload.coordinates.long);
    return { body: text || LABEL.location, attachment: Number.isFinite(lat) && Number.isFinite(lng) ? { kind: 'location', lat, lng } : undefined };
  }
  const kind = a.type === 'file' ? 'document' : a.type === 'ig_reel' || a.type === 'reel' ? 'video' : String(a.type || 'file');
  const label = LABEL[a.type] ?? '📎 Anhang';
  return { body: text ? `${text}` : label, attachment: url ? { kind, url } : undefined };
}

const WA_STATUS = ['sent', 'delivered', 'read', 'failed'];

/** Flattens a webhook body (any of the three objects) into messages and status updates. */
export function parseWebhook(payload: any): MetaEvent[] {
  const out: MetaEvent[] = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  if (payload?.object === 'whatsapp_business_account') {
    for (const entry of entries) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (change?.field !== 'messages') continue;
        const v = change.value ?? {};
        const account = String(v.metadata?.phone_number_id ?? '');
        const names = new Map<string, string>((Array.isArray(v.contacts) ? v.contacts : []).map((c: any) => [String(c.wa_id ?? ''), clip(c.profile?.name, 120)]));
        for (const m of Array.isArray(v.messages) ? v.messages : []) {
          if (!m?.id || !m.from) continue;
          const { body, attachment } = whatsappBody(m);
          if (!body) continue;
          out.push({ kind: 'message', channel: 'whatsapp', account, from: String(m.from), name: names.get(String(m.from)) || undefined, externalId: externalId('whatsapp', String(m.id)), at: isoFrom(m.timestamp, 's'), body, attachment });
        }
        for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
          if (!s?.id || !WA_STATUS.includes(s.status)) continue;
          const e = Array.isArray(s.errors) ? s.errors[0] : undefined;
          const error = e ? (knownError(Number(e.code)) ?? clip([e.title || e.message, e.error_data?.details].filter(Boolean).join(' – ') + (e.code ? ` (${e.code})` : ''), 500)) : undefined;
          out.push({ kind: 'status', channel: 'whatsapp', account, status: s.status, externalId: externalId('whatsapp', String(s.id)), error, at: isoFrom(s.timestamp, 's') });
        }
      }
    }
    return out;
  }
  if (payload?.object === 'page' || payload?.object === 'instagram') {
    const channel: MetaChannel = payload.object === 'instagram' ? 'instagram' : 'messenger';
    for (const entry of entries) {
      const account = String(entry?.id ?? '');
      for (const ev of Array.isArray(entry?.messaging) ? entry.messaging : []) {
        const from = String(ev?.sender?.id ?? '');
        const at = isoFrom(ev?.timestamp, 'ms');
        if (!from) continue;
        if (ev.message) {
          const msg = ev.message;
          // Our own replies come back as echoes; deleted (unsent) messages are dropped.
          if (msg.is_echo || msg.is_deleted || msg.is_unsupported || !msg.mid) continue;
          const { body, attachment } = messengerBody(msg);
          if (!body) continue;
          out.push({ kind: 'message', channel, account, from, externalId: externalId(channel, String(msg.mid)), at, body, attachment });
        } else if (ev.postback) {
          const id = ev.postback.mid ? String(ev.postback.mid) : `pb:${from}:${ev.timestamp}`;
          out.push({ kind: 'message', channel, account, from, externalId: externalId(channel, id), at, body: clip(ev.postback.title || ev.postback.payload || 'Button') });
        } else if (ev.reaction && ev.reaction.action !== 'unreact' && ev.reaction.mid) {
          const emoji = clip(ev.reaction.emoji || ev.reaction.reaction, 20);
          out.push({ kind: 'message', channel, account, from, externalId: externalId(channel, `r:${ev.reaction.mid}:${from}:${ev.timestamp}`), at, body: `Reagiert mit ${emoji || '❤️'}` });
        } else if (ev.delivery) {
          for (const mid of Array.isArray(ev.delivery.mids) ? ev.delivery.mids : []) out.push({ kind: 'status', channel, account, status: 'delivered', externalId: externalId(channel, String(mid)), at });
          if (ev.delivery.watermark) out.push({ kind: 'status', channel, account, status: 'delivered', party: from, watermark: isoFrom(ev.delivery.watermark, 'ms'), at });
        } else if (ev.read) {
          if (ev.read.mid) out.push({ kind: 'status', channel, account, status: 'read', party: from, externalId: externalId(channel, String(ev.read.mid)), at });
          else if (ev.read.watermark) out.push({ kind: 'status', channel, account, status: 'read', party: from, watermark: isoFrom(ev.read.watermark, 'ms'), at });
        }
      }
    }
  }
  return out;
}

/** Status only moves forward (webhooks may arrive out of order); a failure wins unless already read. */
const RANK: Record<string, number> = { queued: 0, logged: 0, sent: 1, delivered: 2, read: 3 };
export function nextStatus(current: string, incoming: string): string | null {
  if (incoming === 'failed') return current === 'read' || current === 'failed' ? null : 'failed';
  if (current === 'failed') return null;
  return (RANK[incoming] ?? 0) > (RANK[current] ?? 0) ? incoming : null;
}

// --- WhatsApp templates -----------------------------------------------------------

export interface TemplateSlot {
  /** header.1, body.1, body.first_name, button.0.1 or header.media */
  key: string;
  label: string;
  kind: 'text' | 'image' | 'video' | 'document';
  example?: string;
}

export interface TemplateInfo {
  name: string;
  language: string;
  category: string;
  status: string;
  header: string;
  header_format: string;
  body: string;
  footer: string;
  buttons: string[];
  slots: TemplateSlot[];
  supported: boolean;
  reason?: string;
}

const PH = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
/** Placeholders in order: positional ones by number, named ones as they appear. */
export function placeholders(text: string): string[] {
  const found = [...new Set([...String(text ?? '').matchAll(PH)].map((m) => m[1]))];
  return found.every((p) => /^\d+$/.test(p)) ? found.sort((a, b) => Number(a) - Number(b)) : found;
}
const fill = (text: string, values: Record<string, string>, prefix: string) => String(text ?? '').replace(PH, (_m, p) => values[`${prefix}.${p}`] ?? `{{${p}}}`);

/** What the composer and the workflow step need to know about one template. */
export function templateInfo(t: any): TemplateInfo {
  const comps: any[] = Array.isArray(t?.components) ? t.components : [];
  const header = comps.find((c) => String(c.type).toUpperCase() === 'HEADER');
  const body = comps.find((c) => String(c.type).toUpperCase() === 'BODY');
  const footer = comps.find((c) => String(c.type).toUpperCase() === 'FOOTER');
  const buttons: any[] = comps.find((c) => String(c.type).toUpperCase() === 'BUTTONS')?.buttons ?? [];
  const slots: TemplateSlot[] = [];
  let reason = '';
  const format = String(header?.format ?? (header ? 'TEXT' : '')).toUpperCase();
  if (format === 'TEXT') {
    const ex = header?.example?.header_text ?? [];
    placeholders(header.text).forEach((p, i) => slots.push({ key: `header.${p}`, label: `Kopfzeile {{${p}}}`, kind: 'text', example: ex[i] }));
  } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(format)) {
    const kind = format.toLowerCase() as 'image' | 'video' | 'document';
    slots.push({ key: 'header.media', label: `${kind === 'image' ? 'Bild' : kind === 'video' ? 'Video' : 'Dokument'} für die Kopfzeile (https-Link)`, kind });
  } else if (format) reason = `Kopfzeile vom Typ ${format} wird hier nicht unterstützt`;
  const bodyEx = body?.example?.body_text?.[0] ?? (body?.example?.body_text_named_params ?? []).map((x: any) => x.example);
  placeholders(body?.text).forEach((p, i) => slots.push({ key: `body.${p}`, label: `Text {{${p}}}`, kind: 'text', example: bodyEx?.[i] }));
  buttons.forEach((b, i) => {
    const type = String(b.type).toUpperCase();
    if (type === 'URL') placeholders(b.url).forEach((p) => slots.push({ key: `button.${i}.${p}`, label: `Button „${clip(b.text, 40)}“ (Link-Ende)`, kind: 'text', example: b.example?.[0] }));
    else if (!['QUICK_REPLY', 'PHONE_NUMBER'].includes(type)) reason ||= `Button vom Typ ${type} wird hier nicht unterstützt`;
  });
  return {
    name: String(t?.name ?? ''),
    language: String(t?.language ?? ''),
    category: String(t?.category ?? ''),
    status: String(t?.status ?? ''),
    header: format === 'TEXT' ? String(header?.text ?? '') : '',
    header_format: format,
    body: String(body?.text ?? ''),
    footer: String(footer?.text ?? ''),
    buttons: buttons.map((b) => clip(b.text, 60)),
    slots,
    supported: !reason,
    reason: reason || undefined,
  };
}

/** Graph "components" for a template send, plus the text to keep in the conversation. */
export function buildTemplate(t: TemplateInfo, values: Record<string, string>): { components: any[]; text: string } {
  const v: Record<string, string> = {};
  for (const s of t.slots) {
    const val = String(values?.[s.key] ?? '').trim();
    if (!val) throw new Error(`Bitte „${s.label}“ ausfüllen`);
    if (s.kind !== 'text' && !/^https:\/\/\S+$/.test(val)) throw new Error(`„${s.label}“ muss ein https-Link sein`);
    v[s.key] = val.slice(0, s.kind === 'text' ? 1024 : 2000);
  }
  const param = (key: string, p: string) => (/^\d+$/.test(p) ? { type: 'text', text: v[key] } : { type: 'text', parameter_name: p, text: v[key] });
  const components: any[] = [];
  const headerSlots = t.slots.filter((s) => s.key.startsWith('header.'));
  if (headerSlots.length) {
    const media = headerSlots.find((s) => s.key === 'header.media');
    components.push({
      type: 'header',
      parameters: media ? [{ type: media.kind, [media.kind]: { link: v[media.key] } }] : headerSlots.map((s) => param(s.key, s.key.slice(7))),
    });
  }
  const bodySlots = t.slots.filter((s) => s.key.startsWith('body.'));
  if (bodySlots.length) components.push({ type: 'body', parameters: bodySlots.map((s) => param(s.key, s.key.slice(5))) });
  const byButton = new Map<string, TemplateSlot[]>();
  for (const s of t.slots.filter((x) => x.key.startsWith('button.'))) {
    const idx = s.key.split('.')[1];
    byButton.set(idx, [...(byButton.get(idx) ?? []), s]);
  }
  for (const [idx, list] of byButton) components.push({ type: 'button', sub_type: 'url', index: idx, parameters: list.map((s) => ({ type: 'text', text: v[s.key] })) });
  const text = [fill(t.header, v, 'header'), fill(t.body, v, 'body'), t.footer].filter(Boolean).join('\n\n');
  return { components, text };
}

// --- Graph API ----------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class MetaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}

/** The Meta error codes people actually run into, in plain German. */
export function knownError(code: number, sub?: number): string | undefined {
  if (code === 190) return 'Zugriffstoken ungültig oder abgelaufen – bitte einen neuen (dauerhaften) Token eintragen';
  if (code === 131047 || sub === 2018278) return 'Außerhalb des 24-Stunden-Fensters – bitte eine Vorlage senden';
  if (code === 131026) return 'Nachricht nicht zustellbar (hat die Nummer WhatsApp?)';
  if (code === 131030) return 'Empfänger ist nicht als Testnummer freigegeben (Meta-App im Testmodus)';
  if (code === 131049) return 'Meta hat die Marketing-Nachricht nicht zugestellt (Limit pro Person)';
  if (code === 131050) return 'Kontakt hat Marketing-Nachrichten abbestellt';
  if ([131056, 130429, 4, 80007, 613].includes(code)) return 'Meta drosselt gerade – bitte kurz warten';
  if (code === 132000) return 'Anzahl der Vorlagen-Variablen passt nicht';
  if (code === 132001) return 'Vorlage nicht gefunden (Name oder Sprache prüfen)';
  if (code === 132015 || code === 132016) return 'Vorlage ist pausiert oder deaktiviert';
  if (code === 133010) return 'Telefonnummer ist noch nicht bei WhatsApp registriert';
  if (code === 551) return 'Person ist gerade nicht erreichbar';
  return undefined;
}

/** Meta's error object → one German sentence (unknown codes keep Meta's own text). */
export function metaErrorText(status: number, e: any): string {
  const code = Number(e?.code);
  const detail = String(e?.error_data?.details || e?.error_user_msg || e?.message || '').slice(0, 300);
  const known = knownError(code, Number(e?.error_subcode));
  if (known) return known;
  if (code === 200 || code === 10 || code === 3) return `Fehlende Berechtigung bei Meta${detail ? `: ${detail}` : ''}`;
  if (code === 100) return `Ungültige Angabe: ${detail || 'bitte IDs prüfen'}`;
  return `Meta (${status}${code ? `/${code}` : ''}): ${detail || 'Fehler'}`;
}

export async function graphCall<T = any>(f: FetchLike, version: string, token: string, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  let r: Response;
  try {
    r = await f(`${GRAPH_BASE}/${version}/${path.replace(/^\//, '')}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new MetaApiError(`Meta nicht erreichbar: ${(e as Error).message}`, 502);
  }
  const raw = await r.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }
  if (!r.ok || data?.error) throw new MetaApiError(metaErrorText(r.status, data?.error), r.status || 502, data?.error?.code);
  return data as T;
}

/** Hosts Meta serves media from; the access token is only ever sent there. */
export function isMetaMediaHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return ['fbsbx.com', 'facebook.com', 'fbcdn.net', 'whatsapp.net', 'cdninstagram.com', 'instagram.com'].some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** Media types the browser may show inline; anything else is offered as a download. */
export function inlineMime(mime: string): boolean {
  return /^(image\/(png|jpeg|gif|webp)|audio\/[a-z0-9.+-]+|video\/(mp4|3gpp|webm|quicktime)|application\/pdf)$/i.test(mime);
}

/** WhatsApp recipient: digits of an E.164 number (the API takes them without "+"). */
export function waRecipient(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}
