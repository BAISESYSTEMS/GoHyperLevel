import { bad } from '../core/http.js';

/**
 * Sending speed of campaigns. Until now every campaign sent 30 messages per background tick (15 s) – the location default
 * `settings.campaigns.batch_size`. Now a campaign can carry its own speed in messages per hour, which is what people think in
 * (and what a new sender has to keep low while it "warms up"). Pure calculations here; the sending loop is in modules/campaigns.ts.
 */

export const MIN_SPEED = 10;
export const MAX_SPEED = 50_000;
/** Hard limits of one batch (messages per tick), also for the location default. */
export const MIN_BATCH = 1;
export const MAX_BATCH = 500;
export const DEFAULT_BATCH = 30;
export const DEFAULT_TICK_MS = 15_000;
/** What a sender that has not sent much yet should stay under (per hour) until its reputation has grown. */
export const WARMUP_PER_HOUR = 60;
/** Below this many delivered e-mails a sender counts as "new". */
export const WARMUP_BELOW = 1000;
const HOUR = 3600_000;

/** `speed_per_hour` from the browser: empty / 0 / null = the standard speed, otherwise a whole number within the bounds. */
export function cleanSpeed(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw bad('Versandgeschwindigkeit: ganze Zahl (Nachrichten pro Stunde)');
  if (n < MIN_SPEED || n > MAX_SPEED) throw bad(`Versandgeschwindigkeit: zwischen ${MIN_SPEED} und ${MAX_SPEED.toLocaleString('de-DE')} pro Stunde (leer = Standard)`);
  return n;
}

/** The location's default batch per tick, kept inside the bounds. */
export const batchSize = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_BATCH, Math.max(MIN_BATCH, n)) : DEFAULT_BATCH;
};

/** The tick length the app really runs with (0 = ticks are driven by hand, e.g. in tests). */
export const tickLength = (tickMs: number) => (tickMs > 0 ? tickMs : DEFAULT_TICK_MS);

/**
 * How many messages may go out in this tick. With a speed: the hours since the speed was set (`anchorAt`) times the speed, plus one
 * so the first message leaves at once, minus what was sent since – and never more than twice the nominal batch of one tick, so a
 * pause (server down, campaign resumed) does not end in a burst. Without a speed: the default batch.
 */
export function allowedNow(o: { speed: number | null; defaultBatch: number; tickMs: number; anchorAt: number; sentSinceAnchor: number; at: number }): number {
  if (!o.speed) return o.defaultBatch;
  const earned = Math.floor((o.speed * Math.max(0, o.at - o.anchorAt)) / HOUR) + 1 - o.sentSinceAnchor;
  const cap = Math.min(MAX_BATCH, Math.max(1, Math.ceil(((o.speed * o.tickMs) / HOUR) * 2)));
  return Math.max(0, Math.min(cap, earned));
}

export interface Throttle {
  /** What was chosen for the campaign (null = standard). */
  speed_per_hour: number | null;
  /** What actually applies per hour: the choice, or the default batch times the ticks per hour. */
  per_hour: number;
  default_per_hour: number;
  batch_per_tick: number;
  tick_seconds: number;
  remaining: number;
  /** When the remaining messages are through at that speed (null when nothing is left). */
  eta_at: string | null;
  eta_minutes: number | null;
  min_speed: number;
  max_speed: number;
}

export function throttleInfo(o: { speed: number | null; defaultBatch: number; tickMs: number; remaining: number; at?: number }): Throttle {
  const defaultPerHour = Math.round((o.defaultBatch * HOUR) / o.tickMs);
  const perHour = o.speed ?? defaultPerHour;
  const at = o.at ?? Date.now();
  // A message needs at least the time of one tick when sent in batches; with a speed it is remaining / speed.
  const minutes = o.remaining > 0 ? Math.max(0, Math.ceil((o.remaining / perHour) * 60)) : null;
  return {
    speed_per_hour: o.speed,
    per_hour: perHour,
    default_per_hour: defaultPerHour,
    batch_per_tick: o.speed ? Math.max(1, Math.min(MAX_BATCH, Math.ceil((o.speed * o.tickMs) / HOUR))) : o.defaultBatch,
    tick_seconds: Math.round(o.tickMs / 1000),
    remaining: o.remaining,
    eta_at: minutes === null ? null : new Date(at + minutes * 60_000).toISOString(),
    eta_minutes: minutes,
    min_speed: MIN_SPEED,
    max_speed: MAX_SPEED,
  };
}

export interface Warmup {
  sent_total: number;
  recommended_per_hour: number;
  /** Null when there is nothing to warn about. */
  advice: string | null;
  level: 'info' | 'warn' | null;
}

/** A hint for new senders: many e-mails at a high speed from an address that has sent little so far end up in spam. */
export function warmupAdvice(o: { channel: string; sentTotal: number; remaining: number; perHour: number }): Warmup {
  const base = { sent_total: o.sentTotal, recommended_per_hour: WARMUP_PER_HOUR };
  if (o.channel !== 'email' || o.sentTotal >= WARMUP_BELOW || o.remaining < 200) return { ...base, advice: null, level: null };
  const fast = o.perHour > WARMUP_PER_HOUR;
  return {
    ...base,
    level: fast ? 'warn' : 'info',
    advice: `Über diesen Absender sind bisher erst ${o.sentTotal.toLocaleString('de-DE')} E-Mails verschickt worden. Neue Absender und Domains müssen „aufwärmen“: in den ersten 2–4 Wochen mit wenigen Mails pro Tag beginnen und täglich steigern, sonst landen sie schneller im Spam. ${fast ? `Empfehlung für diese Kampagne: höchstens ${WARMUP_PER_HOUR} pro Stunde – oder erst an einen Teil der Liste (z. B. die zuletzt aktiven Kontakte) senden.` : 'Mit dieser Geschwindigkeit geht es behutsam los.'}`,
  };
}
