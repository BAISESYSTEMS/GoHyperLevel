import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { attrs, twiml, xml } from './twilio.js';

/**
 * Pure helpers of the voice layer's phone transports: TwiML for a Media Stream and for recorded turns,
 * the signed token that ties a stream to one call, and a small in-memory store for the short-lived audio
 * files Twilio plays in "Aufnahme-Runden". No database, no network.
 */

// --- TwiML --------------------------------------------------------------------------------------------------

/**
 * `<Connect><Stream>`: Twilio opens a WebSocket to `url` (our endpoint) and carries the call's audio both ways.
 * `action` is asked when the stream ends: it answers with what the call does next (hang-up, transfer, Twilio's voice).
 */
export function streamTwiml(o: { url: string; action: string; params: Record<string, string> }): string {
  const params = Object.entries(o.params)
    .map(([name, value]) => `<Parameter${attrs({ name, value })}/>`)
    .join('');
  return twiml(`<Connect${attrs({ action: o.action, method: 'POST' })}><Stream${attrs({ url: o.url })}>${params}</Stream></Connect>`);
}

export const playNoun = (url: string) => `<Play>${xml(url)}</Play>`;

/** Records the caller's next turn (stops after 2 s of silence, no beep) and posts it to `action`. */
export const recordTurnNoun = (o: { action: string; maxLength?: number }) =>
  `<Record${attrs({ action: o.action, method: 'POST', maxLength: o.maxLength ?? 30, timeout: 2, playBeep: 'false', trim: 'trim-silence' })}/>`;

/** `<Response>` + the nouns, in this order. */
export const turnTwiml = (...nouns: string[]) => twiml(nouns.join(''));

/** Puts nouns in front of the content of an existing `<Response>` (e.g. a Play before a transfer). */
export const prependTo = (response: string, nouns: string) => (nouns ? response.replace('<Response>', `<Response>${nouns}`) : response);

// --- stream token -------------------------------------------------------------------------------------------

const sig = (secret: string, locationId: string, callSid: string, exp: number) => createHmac('sha256', secret).update(`voice-stream|${locationId}|${callSid}|${exp}`).digest('base64url');

/** Binds a Media Stream to one call of one sub-account (the TwiML carries it, `start` returns it). */
export function streamToken(secret: string, locationId: string, callSid: string, now = Date.now(), ttlMs = 10 * 60_000): string {
  const exp = now + ttlMs;
  return `${exp}.${sig(secret, locationId, callSid, exp)}`;
}

export function verifyStreamToken(secret: string, token: string | undefined, locationId: string, callSid: string, now = Date.now()): boolean {
  const m = /^(\d{10,15})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m || Number(m[1]) < now) return false;
  const want = Buffer.from(sig(secret, locationId, callSid, Number(m[1])));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** `https://host` → `wss://host`; `http://…` → `ws://…`. */
export const wsUrl = (base: string, path: string) => `${base.replace(/\/+$/, '').replace(/^http/i, 'ws')}${path}`;

// --- short-lived audio for <Play> ---------------------------------------------------------------------------

export interface StoredAudio {
  locationId: string;
  data: Buffer;
  mime: string;
  expires: number;
}

/** Audio files Twilio fetches once or twice (a turn's answer) – kept in memory for a few minutes, never listed. */
export class AudioStore {
  private items = new Map<string, StoredAudio>();
  private bytes = 0;
  constructor(
    private readonly maxBytes = 24 * 1024 * 1024,
    private readonly maxItems = 64,
  ) {}

  put(locationId: string, data: Buffer, mime: string, ttlMs = 10 * 60_000): string {
    this.sweep();
    while ((this.items.size >= this.maxItems || this.bytes + data.length > this.maxBytes) && this.items.size) this.drop(this.items.keys().next().value as string);
    const token = randomBytes(24).toString('base64url');
    this.items.set(token, { locationId, data, mime, expires: Date.now() + ttlMs });
    this.bytes += data.length;
    return token;
  }

  get(token: string): StoredAudio | undefined {
    const a = this.items.get(token);
    if (!a) return undefined;
    if (a.expires < Date.now()) {
      this.drop(token);
      return undefined;
    }
    return a;
  }

  sweep() {
    const t = Date.now();
    for (const [k, v] of this.items) if (v.expires < t) this.drop(k);
  }

  get size() {
    return this.items.size;
  }

  private drop(token: string) {
    const a = this.items.get(token);
    if (a) this.bytes -= a.data.length;
    this.items.delete(token);
  }
}

/** A tiny TTL cache for audio of static phrases (greeting, "Einen Moment bitte"), keyed by provider, voice and text. */
export class PhraseCache<T> {
  private items = new Map<string, { at: number; value: T }>();
  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly max = 40,
  ) {}
  get(key: string): T | undefined {
    const e = this.items.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.items.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T) {
    if (this.items.size >= this.max) this.items.delete(this.items.keys().next().value as string);
    this.items.set(key, { at: Date.now(), value });
  }
}
