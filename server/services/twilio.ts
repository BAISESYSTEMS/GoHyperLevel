import { createHmac, timingSafeEqual } from 'node:crypto';
import { hmInTz, weekdayKey, ymdInTz, type DayKey } from '../core/time.js';

/**
 * Twilio Voice helpers without the Twilio SDK: webhook signatures, TwiML and business hours.
 * Kept pure (no app, no database) so they are easy to test.
 */

/** Form parameters as Twilio posted them (keys may repeat). */
export type TwilioParams = [string, string][] | Record<string, string | string[]>;

function entries(params: TwilioParams): [string, string][] {
  if (Array.isArray(params)) return params;
  return Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)] as [string, string]) : [[k, String(v)] as [string, string]]));
}

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, fullUrl + every POST key+value sorted by key)).
 * Repeated keys are sorted by value as well (like Twilio's own libraries).
 */
export function twilioSignature(authToken: string, url: string, params: TwilioParams = []): string {
  const data = entries(params)
    .slice()
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .reduce((s, [k, v]) => s + k + v, url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Checks the header against every URL Twilio may have used (e.g. old and new public address), in constant time. */
export function validTwilioSignature(authToken: string, signature: string | undefined, urls: string[], params: TwilioParams = []): boolean {
  if (!authToken || !signature) return false;
  const given = Buffer.from(signature);
  let ok = false;
  for (const url of new Set(urls)) {
    const expected = Buffer.from(twilioSignature(authToken, url, params));
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}

// --- business hours ------------------------------------------------------------------

export interface DayHours {
  open: boolean;
  from: string;
  to: string;
}
export type Hours = Record<DayKey, DayHours>;
export type HoursMode = 'always' | 'hours' | 'never';

export const DAYS: [DayKey, string][] = [
  ['mon', 'Montag'],
  ['tue', 'Dienstag'],
  ['wed', 'Mittwoch'],
  ['thu', 'Donnerstag'],
  ['fri', 'Freitag'],
  ['sat', 'Samstag'],
  ['sun', 'Sonntag'],
];

export const DEFAULT_HOURS: Hours = Object.fromEntries(DAYS.map(([k]) => [k, { open: !['sat', 'sun'].includes(k), from: '09:00', to: '17:00' }])) as Hours;

/** Whether calls are forwarded right now (in the sub-account's timezone). Overnight ranges (22:00–02:00) work too. */
export function isOpen(mode: HoursMode, hours: Hours, tz: string, at = new Date()): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const day = hours[weekdayKey(ymdInTz(at, tz))];
  if (!day?.open) return false;
  const hm = hmInTz(at, tz);
  if (day.to > day.from) return hm >= day.from && hm < day.to;
  return hm >= day.from || hm < day.to;
}

// --- TwiML ---------------------------------------------------------------------------

export const xml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export const attrs = (a: Record<string, string | number | boolean | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== false && v !== '')
    .map(([k, v]) => ` ${k}="${xml(v)}"`)
    .join('');

export const VOICE = { voice: 'Polly.Vicki', language: 'de-DE' };
export const say = (text: string) => (text.trim() ? `<Say${attrs(VOICE)}>${xml(text.trim())}</Say>` : '');
export const twiml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
export const hangup = (text = '') => twiml(`${say(text)}<Hangup/>`);

/** A browser phone (Twilio Voice SDK) to ring, with custom parameters the client can read. */
export interface DialClient {
  identity: string;
  params?: Record<string, string>;
}
export const clientNoun = (c: DialClient) =>
  `<Client><Identity>${xml(c.identity)}</Identity>${Object.entries(c.params ?? {})
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `<Parameter${attrs({ name: k, value: v })}/>`)
    .join('')}</Client>`;

/** Rings the forward number(s) and browser clients at once; the action URL learns whether someone picked up. */
export function dialTwiml(o: { numbers: string[]; clients?: DialClient[]; timeout: number; action: string; record?: boolean; recordingCallback?: string; callerId?: string; announce?: string }): string {
  const rec = o.record ? { record: 'record-from-answer-dual', recordingStatusCallback: o.recordingCallback, recordingStatusCallbackMethod: 'POST' } : {};
  return twiml(
    `${say(o.announce ?? '')}<Dial${attrs({ timeout: o.timeout, action: o.action, method: 'POST', answerOnBridge: true, callerId: o.callerId, ...rec })}>${o.numbers.map((n) => `<Number>${xml(n)}</Number>`).join('')}${(o.clients ?? []).map(clientNoun).join('')}</Dial>`,
  );
}

/** Greeting, then a voicemail recording (or just the greeting when voicemail is off). */
export function voicemailTwiml(o: { greeting: string; record: boolean; maxLength: number; action: string; transcribe?: boolean }): string {
  if (!o.record) return hangup(o.greeting);
  return twiml(
    `${say(o.greeting)}<Record${attrs({
      action: o.action,
      method: 'POST',
      maxLength: o.maxLength,
      timeout: 5,
      playBeep: true,
      finishOnKey: '#',
      recordingStatusCallback: o.action,
      recordingStatusCallbackMethod: 'POST',
      transcribe: o.transcribe ? true : undefined,
      transcribeCallback: o.transcribe ? o.action : undefined,
    })}/>${say('Wir haben keine Nachricht erhalten. Auf Wiederhören.')}<Hangup/>`,
  );
}

/**
 * The dialled party's leg gets its own TwiML before the bridge (`<Number url>`): used to tell the person called that
 * the conversation is recorded – the agent's own leg cannot do that.
 */
export const numberNoun = (number: string, announceUrl?: string) =>
  `<Number${attrs({ url: announceUrl, method: announceUrl ? 'POST' : undefined })}>${xml(number)}</Number>`;

/** Click-to-call: once your own phone answers, Twilio announces the contact and bridges the call. */
export function bridgeTwiml(o: { announce: string; callerId: string; number: string; action: string; record?: boolean; recordingCallback?: string; announceUrl?: string }): string {
  const rec = o.record ? { record: 'record-from-answer-dual', recordingStatusCallback: o.recordingCallback, recordingStatusCallbackMethod: 'POST' } : {};
  return twiml(`${say(o.announce)}<Dial${attrs({ callerId: o.callerId, timeout: 30, action: o.action, method: 'POST', ...rec })}>${numberNoun(o.number, o.record ? o.announceUrl : undefined)}</Dial>`);
}

// --- small formatting helpers ------------------------------------------------------------

export const E164 = /^\+[1-9]\d{6,14}$/;
export const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
export const RECORDING_SID = /^RE[0-9a-fA-F]{32}$/;
export const NUMBER_SID = /^PN[0-9a-fA-F]{32}$/;

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A caller ID Twilio can't show (anonymous, restricted…) has no usable number. */
export function usableNumber(n: string | undefined): string {
  const s = String(n ?? '').trim();
  if (!/^\+?\d{5,15}$/.test(s.replace(/[\s()-]/g, ''))) return '';
  // Twilio's placeholder numbers for withheld caller IDs.
  if (['+266696687', '+7378742833', '+2562533', '+8656696'].includes(s)) return '';
  return s;
}
