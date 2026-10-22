import { addDaysYmd, hmInTz, isValidTz, tzOffsetMinutes, weekdayKey, ymdInTz, zonedToUtc, type DayKey } from '../core/time.js';

/**
 * Schedules of an automated webinar (pure functions, no database): which sessions can be booked right now and what the
 * room does at a given moment. A session is nothing but its start time – nothing is stored until somebody registers.
 *
 *  - fixed     – chosen weekdays at given times (wall clock in the webinar's time zone, daylight-saving safe)
 *  - dates     – single dates ("2026-11-05T18:00")
 *  - jit       – "just in time": the next start on an N-minute grid inside a daily window
 *  - ondemand  – starts right away, once per registrant
 *  - blackout  – days (or ranges) without sessions
 */

export type SessionKind = 'fixed' | 'date' | 'jit' | 'ondemand';

export interface Schedule {
  /** IANA zone of the wall-clock times below; '' = the sub-account's zone. */
  tz: string;
  fixed: { enabled: boolean; weekdays: DayKey[]; times: string[] };
  /** Local wall time `YYYY-MM-DDTHH:MM`. */
  dates: string[];
  jit: { enabled: boolean; every_min: number; from: string; to: string; weekdays: DayKey[] };
  ondemand: { enabled: boolean };
  /** `YYYY-MM-DD` or `YYYY-MM-DD..YYYY-MM-DD`. */
  blackout: string[];
  /** How many days ahead fixed times are offered. */
  horizon_days: number;
  /** Registrations per session; 0 = unlimited. */
  max_per_session: number;
  /** How long after the start somebody can still enter the room (minutes); LATE_ANYTIME = until the end. */
  late_join_min: number;
}

export interface Session {
  /** The start as ISO string (UTC, whole seconds) – also the key under which registrations are stored. */
  start: string;
  kind: SessionKind;
}

export const LATE_ANYTIME = 9999;
export const DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const DAY_LABELS: Record<DayKey, string> = { mon: 'Montag', tue: 'Dienstag', wed: 'Mittwoch', thu: 'Donnerstag', fri: 'Freitag', sat: 'Samstag', sun: 'Sonntag' };

export const DEFAULT_SCHEDULE: Schedule = {
  tz: '',
  fixed: { enabled: false, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], times: ['19:00'] },
  dates: [],
  jit: { enabled: false, every_min: 15, from: '09:00', to: '21:00', weekdays: [...DAYS] },
  ondemand: { enabled: false },
  blackout: [],
  horizon_days: 14,
  max_per_session: 0,
  late_join_min: 30,
};

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ]([01]?\d|2[0-3]):([0-5]\d)$/;

const pad = (n: number | string) => String(n).padStart(2, '0');
export const normHm = (v: unknown): string | undefined => {
  const m = HM.exec(String(v ?? '').trim());
  return m ? `${pad(m[1])}:${m[2]}` : undefined;
};
const validYmd = (v: string) => YMD.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export class ScheduleError extends Error {}

const days = (v: unknown, fallback: DayKey[]): DayKey[] => {
  if (!Array.isArray(v)) return fallback;
  const out = DAYS.filter((d) => v.includes(d));
  if (!out.length && v.length) throw new ScheduleError('Wochentage: mon, tue, wed, thu, fri, sat oder sun');
  return out;
};
const bool = (v: unknown, fallback: boolean) => (v === undefined || v === null ? fallback : v === true || v === 1 || v === 'true');
const int = (v: unknown, fallback: number, min: number, max: number, what: string) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw new ScheduleError(`${what}: Zahl von ${min} bis ${max} erwartet`);
  return n;
};

/** Validates a schedule from the editor/API on top of `base` (what was stored before). Throws ScheduleError with a German message. */
export function cleanSchedule(input: unknown, base: Schedule = DEFAULT_SCHEDULE): Schedule {
  if (input === undefined || input === null) return base;
  if (typeof input !== 'object' || Array.isArray(input)) throw new ScheduleError('Termine: Objekt erwartet');
  const i = input as Record<string, any>;
  const out: Schedule = JSON.parse(JSON.stringify(base));
  if (i.tz !== undefined) {
    const tz = String(i.tz ?? '').trim();
    if (tz && !isValidTz(tz)) throw new ScheduleError(`Zeitzone „${tz.slice(0, 40)}“ gibt es nicht (z. B. Europe/Berlin)`);
    out.tz = tz;
  }
  if (i.fixed !== undefined) {
    const f = i.fixed ?? {};
    out.fixed.enabled = bool(f.enabled, out.fixed.enabled);
    if (f.weekdays !== undefined) out.fixed.weekdays = days(f.weekdays, out.fixed.weekdays);
    if (f.times !== undefined) {
      if (!Array.isArray(f.times)) throw new ScheduleError('Uhrzeiten: Liste erwartet');
      const times = f.times.map((t: unknown) => normHm(t));
      if (times.some((t: string | undefined) => !t)) throw new ScheduleError('Uhrzeiten: bitte als HH:MM angeben (z. B. 19:00)');
      out.fixed.times = [...new Set(times as string[])].sort().slice(0, 12);
    }
    if (out.fixed.enabled && (!out.fixed.weekdays.length || !out.fixed.times.length)) throw new ScheduleError('Feste Termine: mindestens ein Wochentag und eine Uhrzeit nötig');
  }
  if (i.dates !== undefined) {
    if (!Array.isArray(i.dates)) throw new ScheduleError('Einzeltermine: Liste erwartet');
    const list = i.dates.map((d: unknown) => {
      const m = LOCAL.exec(String(d ?? '').trim());
      if (!m || !validYmd(m[1])) throw new ScheduleError(`Einzeltermin „${String(d).slice(0, 30)}“: bitte als JJJJ-MM-TTTHH:MM angeben`);
      return `${m[1]}T${pad(m[2])}:${m[3]}`;
    });
    out.dates = [...new Set(list as string[])].sort().slice(0, 200);
  }
  if (i.jit !== undefined) {
    const j = i.jit ?? {};
    out.jit.enabled = bool(j.enabled, out.jit.enabled);
    out.jit.every_min = int(j.every_min, out.jit.every_min, 5, 720, 'Abstand der Starts (Minuten)');
    if (j.from !== undefined) {
      const hm = normHm(j.from);
      if (!hm) throw new ScheduleError('Zeitfenster „von“: bitte als HH:MM angeben');
      out.jit.from = hm;
    }
    if (j.to !== undefined) {
      const hm = String(j.to).trim() === '24:00' ? '24:00' : normHm(j.to);
      if (!hm) throw new ScheduleError('Zeitfenster „bis“: bitte als HH:MM angeben');
      out.jit.to = hm;
    }
    if (j.weekdays !== undefined) out.jit.weekdays = days(j.weekdays, out.jit.weekdays);
    if (out.jit.enabled && out.jit.from >= out.jit.to) throw new ScheduleError('Zeitfenster: „von“ muss vor „bis“ liegen');
    if (out.jit.enabled && !out.jit.weekdays.length) throw new ScheduleError('Zeitfenster: mindestens ein Wochentag nötig');
  }
  if (i.ondemand !== undefined) out.ondemand.enabled = bool(i.ondemand?.enabled, out.ondemand.enabled);
  if (i.blackout !== undefined) {
    if (!Array.isArray(i.blackout)) throw new ScheduleError('Sperrtage: Liste erwartet');
    out.blackout = [
      ...new Set(
        i.blackout.map((b: unknown) => {
          const s = String(b ?? '').trim();
          const [a, z] = s.split('..');
          if (!validYmd(a) || (z !== undefined && (!validYmd(z) || z < a))) throw new ScheduleError(`Sperrtag „${s.slice(0, 30)}“: JJJJ-MM-TT oder JJJJ-MM-TT..JJJJ-MM-TT erwartet`);
          return s;
        }) as string[],
      ),
    ]
      .sort()
      .slice(0, 200);
  }
  if (i.horizon_days !== undefined) out.horizon_days = int(i.horizon_days, out.horizon_days, 1, 90, 'Vorschau (Tage)');
  if (i.max_per_session !== undefined) out.max_per_session = int(i.max_per_session, out.max_per_session, 0, 1_000_000, 'Plätze pro Termin');
  if (i.late_join_min !== undefined) out.late_join_min = int(i.late_join_min, out.late_join_min, 0, LATE_ANYTIME, 'Einlass nach Beginn (Minuten)');
  return out;
}

/** Is this local day (YYYY-MM-DD) a blackout day? */
export function isBlackout(s: Schedule, ymd: string): boolean {
  return s.blackout.some((b) => {
    const [a, z] = b.split('..');
    return z ? ymd >= a && ymd <= z : ymd === a;
  });
}

export const zoneOf = (s: Schedule, fallback: string) => (s.tz && isValidTz(s.tz) ? s.tz : isValidTz(fallback) ? fallback : 'Europe/Berlin');

const isoSec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
export const sessionKey = (ms: number) => isoSec(ms);

/** The next starts on the "just in time" grid: whole N-minute steps of the local clock, inside the daily window. */
function jitStarts(s: Schedule, tz: string, nowMs: number, count: number): number[] {
  const step = s.jit.every_min * 60_000;
  const out: number[] = [];
  const off = tzOffsetMinutes(new Date(nowMs), tz) * 60_000;
  let t = Math.floor((nowMs + off) / step) * step + step - off;
  for (let n = 0; n < 2000 && out.length < count; n++, t += step) {
    // The offset may change (daylight saving): re-check the wall clock of each candidate.
    const at = new Date(t);
    const ymd = ymdInTz(at, tz);
    if (isBlackout(s, ymd) || !s.jit.weekdays.includes(weekdayKey(ymd))) continue;
    const hm = hmInTz(at, tz);
    if (hm >= s.jit.from && (hm < s.jit.to || s.jit.to === '24:00')) out.push(t);
  }
  return out;
}

export interface UpcomingOptions {
  /** Maximum number of fixed/date sessions (default 12); "just in time" adds its own next three. */
  limit?: number;
}

/**
 * The sessions somebody can register for at `now`, soonest first. `ondemand` is a placeholder starting now – the moment of
 * registration fixes the real start. Past sessions are never listed.
 */
export function upcomingSessions(s: Schedule, fallbackTz: string, now: Date, o: UpcomingOptions = {}): Session[] {
  const tz = zoneOf(s, fallbackTz);
  const nowMs = now.getTime();
  const list = new Map<string, Session>();
  const add = (ms: number, kind: SessionKind) => {
    if (ms <= nowMs) return;
    const start = isoSec(ms);
    if (!list.has(start)) list.set(start, { start, kind });
  };
  if (s.fixed.enabled) {
    const today = ymdInTz(now, tz);
    for (let d = 0; d <= s.horizon_days; d++) {
      const ymd = addDaysYmd(today, d);
      if (isBlackout(s, ymd) || !s.fixed.weekdays.includes(weekdayKey(ymd))) continue;
      for (const hm of s.fixed.times) add(zonedToUtc(ymd, hm, tz).getTime(), 'fixed');
    }
  }
  for (const d of s.dates) {
    const m = LOCAL.exec(d);
    if (!m || isBlackout(s, m[1])) continue;
    add(zonedToUtc(m[1], `${pad(m[2])}:${m[3]}`, tz).getTime(), 'date');
  }
  const scheduled = [...list.values()].sort((a, b) => a.start.localeCompare(b.start)).slice(0, o.limit ?? 12);
  const jit: Session[] = s.jit.enabled ? jitStarts(s, tz, nowMs, 3).map((ms) => ({ start: isoSec(ms), kind: 'jit' as const })) : [];
  const merged = new Map<string, Session>();
  for (const x of [...scheduled, ...jit]) if (!merged.has(x.start)) merged.set(x.start, x);
  const sorted = [...merged.values()].sort((a, b) => a.start.localeCompare(b.start));
  return s.ondemand.enabled ? [{ start: isoSec(nowMs), kind: 'ondemand' }, ...sorted] : sorted;
}

/** Does the schedule offer a session starting at `startIso` (kind 'ondemand' is never checked here)? Allows the late-join window after the start. */
export function offersSession(s: Schedule, fallbackTz: string, startIso: string, now: Date): SessionKind | undefined {
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return undefined;
  const key = isoSec(startMs);
  if (key !== startIso) return undefined;
  const grace = Math.min(s.late_join_min, 24 * 60) * 60_000;
  // Look a little into the past so a visitor who loaded the page just before the start can still book it.
  const probe = new Date(Math.min(now.getTime(), startMs - 1000));
  const sessions = upcomingSessions({ ...s, ondemand: { enabled: false } }, fallbackTz, probe, { limit: 5000 });
  if (startMs + grace < now.getTime()) return undefined;
  return sessions.find((x) => x.start === key)?.kind;
}

// --- the room -------------------------------------------------------------------------------------

export type RoomState = 'waiting' | 'running' | 'late' | 'ended';
export interface RoomClock {
  state: RoomState;
  /** Seconds until the start (waiting). */
  starts_in_s: number;
  /** Seconds into the video (running), else 0. */
  offset_s: number;
  /** Seconds until the end (running/waiting). */
  ends_in_s: number;
}

/** Tolerance so a viewer who sits in the waiting room when the countdown ends is not turned away as "late". */
const START_GRACE_S = 30;

/** What the room shows at `nowMs` for a session starting at `startMs`. `late` = running, but too late to come in (late_join_min). */
export function roomClock(startMs: number, durationS: number, nowMs: number, lateJoinMin: number): RoomClock {
  const off = (nowMs - startMs) / 1000;
  if (off < 0) return { state: 'waiting', starts_in_s: Math.ceil(-off), offset_s: 0, ends_in_s: Math.ceil(-off + durationS) };
  if (durationS > 0 && off >= durationS) return { state: 'ended', starts_in_s: 0, offset_s: 0, ends_in_s: 0 };
  const late = lateJoinMin < LATE_ANYTIME && off > lateJoinMin * 60 + START_GRACE_S;
  return { state: late ? 'late' : 'running', starts_in_s: 0, offset_s: Math.max(0, off), ends_in_s: Math.max(0, Math.ceil(durationS - off)) };
}

/** The ISO end of a session. */
export const sessionEnd = (startIso: string, durationS: number) => new Date(Date.parse(startIso) + durationS * 1000).toISOString();

/** Seconds of `watched` as a share of the video (0–100). */
export const percentOf = (watchedS: number, durationS: number) => (durationS > 0 ? Math.max(0, Math.min(100, Math.round((watchedS / durationS) * 100))) : 0);
