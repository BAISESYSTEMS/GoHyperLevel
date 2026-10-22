import type { FetchLike } from './channel-kit.js';

/**
 * Telegram Bot API: calls, update parsing and deep links. Pure functions – the module
 * (modules/telegram.ts) keeps tokens, contacts and conversations.
 */

export const TG_API = 'https://api.telegram.org';
export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
export const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
/** What t.me/<bot>?start=<payload> may carry (Telegram allows 1–64 of these characters). */
export const START_PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;

export class TelegramError extends Error {
  constructor(
    public code: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

/** Telegram's English error descriptions → short German text for the inbox. */
export function tgErrorText(code: number, description: string, retryAfter?: number): string {
  const d = description.toLowerCase();
  if (code === 401 || d.includes('unauthorized')) return 'Bot-Token ungültig';
  if (d.includes('bot was blocked')) return 'Kontakt hat den Bot blockiert';
  if (d.includes('user is deactivated')) return 'Telegram-Konto des Kontakts gelöscht';
  if (d.includes('chat not found')) return 'Chat nicht gefunden – der Kontakt muss den Bot zuerst starten';
  if (d.includes('wrong file identifier') || d.includes('failed to get http url content') || d.includes('wrong type of the web page content')) return 'Datei-Link konnte von Telegram nicht geladen werden';
  if (code === 429) return `Zu viele Nachrichten – Telegram bittet um ${retryAfter ?? 'einige'} Sekunden Pause`;
  if (d.includes('bad webhook') || d.includes('https url must be provided')) return 'Telegram akzeptiert die Webhook-Adresse nicht (braucht öffentliches https mit gültigem Zertifikat)';
  return `Telegram: ${description.slice(0, 200) || `Fehler ${code}`}`;
}

export async function tgCall<T = any>(fetcher: FetchLike, botToken: string, method: string, body?: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  if (!BOT_TOKEN.test(botToken)) throw new TelegramError(401, 'Bot-Token ungültig');
  let r: Response;
  try {
    r = await fetcher(`${TG_API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new TelegramError(0, `Telegram nicht erreichbar: ${(e as Error).message}`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) {
    const code = Number(j?.error_code ?? r.status) || r.status;
    const retry = Number(j?.parameters?.retry_after) || undefined;
    throw new TelegramError(code, tgErrorText(code, String(j?.description ?? ''), retry), retry);
  }
  return j.result as T;
}

export interface TgMedia {
  kind: 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location';
  file_id?: string;
  mime?: string;
  filename?: string;
  size?: number;
  voice?: boolean;
  lat?: number;
  lng?: number;
}

export interface TgMessage {
  updateId: number;
  chatId: string;
  chatType: string;
  fromId: string;
  isBot: boolean;
  name: string;
  username?: string;
  messageId: number;
  at: string;
  body: string;
  media: TgMedia | null;
  /** /start command: the deep-link payload ('' for a plain /start), null for other messages. */
  start: string | null;
  /** A phone number the user shared from their own profile. */
  phone?: string;
}

const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
const fileName = (s: unknown) => clip(s, 120).replace(/[\r\n"]/g, ' ');

/** One Telegram update → the message we store, or null for anything else (edits, joins, callbacks). */
export function parseUpdate(u: any): TgMessage | null {
  const m = u?.message;
  if (!m || typeof m !== 'object' || !m.chat || !m.from) return null;
  const fromId = String(m.from.id ?? '');
  const chatId = String(m.chat.id ?? '');
  if (!/^-?\d{1,20}$/.test(fromId) || !/^-?\d{1,20}$/.test(chatId)) return null;
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').trim().slice(0, 120);
  const username = m.from.username ? String(m.from.username).replace(/[^\w]/g, '').slice(0, 64) : undefined;
  const caption = clip(m.caption, CAPTION_LIMIT);
  let body = clip(m.text, TEXT_LIMIT);
  let media: TgMedia | null = null;
  let phone: string | undefined;
  if (Array.isArray(m.photo) && m.photo.length) {
    const big = m.photo[m.photo.length - 1];
    media = { kind: 'image', file_id: clip(big.file_id, 300), size: Number(big.file_size) || undefined, mime: 'image/jpeg' };
    body = caption || '📷 Foto';
  } else if (m.voice) {
    media = { kind: 'audio', file_id: clip(m.voice.file_id, 300), mime: clip(m.voice.mime_type || 'audio/ogg', 80), voice: true, size: Number(m.voice.file_size) || undefined };
    body = caption || '🎤 Sprachnachricht';
  } else if (m.audio) {
    media = { kind: 'audio', file_id: clip(m.audio.file_id, 300), mime: clip(m.audio.mime_type || 'audio/mpeg', 80), filename: fileName(m.audio.file_name || m.audio.title || 'audio'), size: Number(m.audio.file_size) || undefined };
    body = caption || `🎵 ${media.filename}`;
  } else if (m.video || m.video_note || m.animation) {
    const v = m.video ?? m.video_note ?? m.animation;
    media = { kind: 'video', file_id: clip(v.file_id, 300), mime: clip(v.mime_type || 'video/mp4', 80), size: Number(v.file_size) || undefined };
    body = caption || (m.video_note ? '🎬 Videonachricht' : '🎬 Video');
  } else if (m.document) {
    media = { kind: 'document', file_id: clip(m.document.file_id, 300), mime: clip(m.document.mime_type || 'application/octet-stream', 80), filename: fileName(m.document.file_name || 'datei'), size: Number(m.document.file_size) || undefined };
    body = caption || `📄 ${media.filename}`;
  } else if (m.sticker) {
    // Animated (.tgs) and video stickers cannot be shown as an image; the emoji says enough.
    const still = !m.sticker.is_animated && !m.sticker.is_video;
    media = still ? { kind: 'sticker', file_id: clip(m.sticker.file_id, 300), mime: 'image/webp' } : null;
    body = `Sticker ${clip(m.sticker.emoji, 16)}`.trim();
  } else if (m.location && Number.isFinite(Number(m.location.latitude))) {
    media = { kind: 'location', lat: Number(m.location.latitude), lng: Number(m.location.longitude) };
    body = '📍 Standort';
  } else if (m.contact) {
    const own = String(m.contact.user_id ?? '') === fromId;
    const num = clip(m.contact.phone_number, 30).replace(/[^\d+]/g, '');
    if (own && num) phone = num.startsWith('+') ? num : `+${num}`;
    body = `📇 Kontakt geteilt: ${[m.contact.first_name, m.contact.last_name].filter(Boolean).join(' ')} ${num}`.trim();
  }
  let start: string | null = null;
  const cmd = String(m.text ?? '').match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/);
  if (cmd) start = cmd[1] && START_PAYLOAD.test(cmd[1]) ? cmd[1] : '';
  if (!body && !media) return null;
  return {
    updateId: Number(u.update_id) || 0,
    chatId,
    chatType: String(m.chat.type ?? ''),
    fromId,
    isBot: !!m.from.is_bot,
    name,
    username,
    messageId: Number(m.message_id) || 0,
    at: new Date((Number(m.date) || Date.now() / 1000) * 1000).toISOString(),
    body,
    media,
    start,
    phone,
  };
}

/** Which send method fits a file link (by its extension). */
export function sendMethodFor(url: string): { method: string; field: string; kind: TgMedia['kind'] } {
  const ext = (url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return { method: 'sendPhoto', field: 'photo', kind: 'image' };
  if (ext === 'ogg' || ext === 'oga') return { method: 'sendVoice', field: 'voice', kind: 'audio' };
  if (['mp3', 'm4a', 'wav', 'flac'].includes(ext)) return { method: 'sendAudio', field: 'audio', kind: 'audio' };
  if (['mp4', 'mov', 'webm'].includes(ext)) return { method: 'sendVideo', field: 'video', kind: 'video' };
  return { method: 'sendDocument', field: 'document', kind: 'document' };
}

/** t.me link that opens the bot and sends /start <campaign> – the campaign becomes the lead's source. */
export function deepLink(username: string, campaign?: string): string {
  const u = String(username ?? '').replace(/[^\w]/g, '');
  if (!u) return '';
  const c = String(campaign ?? '').trim();
  return `https://t.me/${u}${c && START_PAYLOAD.test(c) ? `?start=${c}` : ''}`;
}
