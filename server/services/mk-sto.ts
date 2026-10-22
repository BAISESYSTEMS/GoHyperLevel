import type { App } from '../core/app.js';
import { addDaysYmd, tzOffsetMinutes, ymdInTz, zonedToUtc } from '../core/time.js';
import { sha256 } from '../core/util.js';

/**
 * Send-time optimisation: every contact gets the campaign at the hour of the day they usually open or click (taken from the
 * people's events in `email_events`, machine hits are ignored), within the next 24 hours. Contacts without enough history get
 * the sub-account's best hour; without data at all a sensible default. Pure calculations here, the rows come from `loadBuckets`.
 */

/** How far back the history reaches. */
export const HISTORY_DAYS = 180;
/** A contact needs this many events (a click counts double) before their own hour is trusted. */
export const MIN_SCORE = 3;
/** The sub-account's own hour needs this many weighted events. */
export const MIN_ACCOUNT_SCORE = 20;
export const DEFAULT_HOUR = 10;

/** Events grouped by UTC hour and month: `w` is the weight (click 2, open 1). Keeps the query small on big accounts. */
export interface Bucket {
  /** 'YYYY-MM' */
  ym: string;
  /** UTC hour 0..23 */
  h: number;
  w: number;
}

/** The hour (0..23) of the sub-account's clock for a UTC hour in a given month (the offset at mid-month: DST differences stay inside one hour). */
export function localHour(utcHour: number, ym: string, tz: string): number {
  const mid = new Date(`${ym}-15T12:00:00Z`);
  const off = Number.isNaN(mid.getTime()) ? 0 : tzOffsetMinutes(mid, tz);
  return (((utcHour * 60 + off) / 60) % 24 + 24) % 24 | 0;
}

/** 24 weights by local hour. */
export function histogram(buckets: Bucket[], tz: string): number[] {
  const h = new Array<number>(24).fill(0);
  for (const b of buckets) h[localHour(b.h, b.ym, tz)] += b.w;
  return h;
}

/**
 * The best hour of a histogram: the one with the most events, where neighbouring hours help a little (people open around
 * a time, not exactly at it), so one stray event does not decide. Null when there is not enough to say.
 */
export function bestHour(hist: number[], minScore = MIN_SCORE): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total < minScore) return null;
  let best = -1;
  let score = -1;
  for (let h = 0; h < 24; h++) {
    const s = hist[h] + 0.5 * (hist[(h + 23) % 24] + hist[(h + 1) % 24]);
    // The earlier hour wins a tie – deterministic, and earlier is the safer guess.
    if (s > score + 1e-9) (best = h, (score = s));
  }
  return best;
}

export interface HourPlan {
  /** contact id → hour of their own history */
  own: Map<string, number>;
  /** the sub-account's best hour, or the default */
  fallback: number;
  /** where the fallback came from */
  fallback_from: 'account' | 'default';
}

/** Hours of contacts (from their buckets) and the fallback (from everybody's). */
export function planHours(perContact: Map<string, Bucket[]>, tz: string, defaultHour = DEFAULT_HOUR): HourPlan {
  const own = new Map<string, number>();
  const all = new Array<number>(24).fill(0);
  for (const [id, buckets] of perContact) {
    const hist = histogram(buckets, tz);
    for (let h = 0; h < 24; h++) all[h] += hist[h];
    const best = bestHour(hist);
    if (best !== null) own.set(id, best);
  }
  const account = bestHour(all, MIN_ACCOUNT_SCORE);
  return { own, fallback: account ?? defaultHour, fallback_from: account === null ? 'default' : 'account' };
}

/** 0..59: a fixed minute per contact, so everybody with the same hour is not served in the same minute. */
export const minuteOf = (contactId: string): number => parseInt(sha256(`sto:${contactId}`).slice(0, 4), 16) % 60;

/**
 * When to send: the next time the sub-account's clock shows `hour` (plus the contact's minute), within `windowHours` from `at`.
 * Inside the best hour itself the mail goes out at once.
 */
export function sendAt(at: Date, hour: number, tz: string, contactId: string, windowHours = 24): Date {
  const today = ymdInTz(at, tz);
  const hh = String(hour).padStart(2, '0');
  const start = zonedToUtc(today, `${hh}:00`, tz);
  const end = new Date(start.getTime() + 3600_000);
  if (at >= start && at < end) return at;
  const minute = String(minuteOf(contactId)).padStart(2, '0');
  let t = zonedToUtc(today, `${hh}:${minute}`, tz);
  if (t.getTime() < at.getTime()) t = zonedToUtc(addDaysYmd(today, 1), `${hh}:${minute}`, tz);
  const limit = at.getTime() + windowHours * 3600_000;
  return new Date(Math.min(t.getTime(), limit));
}

/** Reads the people's events of a sub-account in buckets (one query), optionally only for some contacts. */
export function loadBuckets(app: App, locationId: string, opts: { contactIds?: Set<string>; days?: number } = {}): Map<string, Bucket[]> {
  const since = new Date(Date.now() - (opts.days ?? HISTORY_DAYS) * 864e5).toISOString();
  const rows = app.db.all<{ contact_id: string; ym: string; h: number; w: number }>(
    `SELECT contact_id, strftime('%Y-%m', at) ym, CAST(strftime('%H', at) AS INTEGER) h, SUM(CASE kind WHEN 'click' THEN 2 ELSE 1 END) w
     FROM email_events WHERE location_id = ? AND classification = 'human' AND contact_id IS NOT NULL AND at >= ? GROUP BY contact_id, ym, h`,
    locationId,
    since,
  );
  const out = new Map<string, Bucket[]>();
  for (const r of rows) {
    if (opts.contactIds && !opts.contactIds.has(r.contact_id)) continue;
    const l = out.get(r.contact_id) ?? [];
    l.push({ ym: r.ym, h: Number(r.h), w: Number(r.w) });
    out.set(r.contact_id, l);
  }
  return out;
}

export interface StoPlan {
  at: Map<string, Date>;
  /** how many got their own hour / the sub-account's / the default */
  own: number;
  account: number;
  default: number;
  fallback: number;
}

/** The send time for each contact of a campaign. */
export function planCampaign(app: App, locationId: string, contactIds: string[], opts: { at?: Date; tz?: string; windowHours?: number; defaultHour?: number } = {}): StoPlan {
  const tz = opts.tz ?? app.location(locationId)?.timezone ?? 'Europe/Berlin';
  const at = opts.at ?? new Date();
  const buckets = loadBuckets(app, locationId);
  const hours = planHours(buckets, tz, opts.defaultHour);
  const out = new Map<string, Date>();
  let own = 0;
  for (const id of contactIds) {
    const mine = hours.own.get(id);
    if (mine !== undefined) own++;
    out.set(id, sendAt(at, mine ?? hours.fallback, tz, id, opts.windowHours));
  }
  const rest = contactIds.length - own;
  return { at: out, own, account: hours.fallback_from === 'account' ? rest : 0, default: hours.fallback_from === 'default' ? rest : 0, fallback: hours.fallback };
}

/** A contact's best hour with its source, for the contact view and the API. */
export function hourOfContact(app: App, locationId: string, contactId: string, opts: { defaultHour?: number } = {}): { hour: number; source: 'contact' | 'account' | 'default' } {
  const tz = app.location(locationId)?.timezone ?? 'Europe/Berlin';
  const hours = planHours(loadBuckets(app, locationId), tz, opts.defaultHour);
  const mine = hours.own.get(contactId);
  return mine !== undefined ? { hour: mine, source: 'contact' } : { hour: hours.fallback, source: hours.fallback_from };
}
