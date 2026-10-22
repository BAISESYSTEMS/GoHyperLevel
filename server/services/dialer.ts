import { bad } from '../core/http.js';
import { hmInTz, weekdayKey, ymdInTz, addDaysYmd, zonedToUtc, type DayKey } from '../core/time.js';
import { germanHolidays, DAY_KEYS, STATES } from './ivr.js';

/**
 * Pure rules of the power dialer: the settings and the outcome codes, the calling window (hours, days, holidays), whether a
 * contact may be called right now (Nicht stören, consent, hours, number of attempts) and which entry of a call list comes
 * next. No database, no network – modules/dialer.ts feeds it.
 */

export type DispositionKind = 'retry' | 'callback' | 'final';
export interface Disposition {
  key: string;
  label: string;
  /** retry: try again later (counts as an attempt); callback: a time was agreed; final: the contact is done. */
  kind: DispositionKind;
  /** A conversation that went the way we wanted (reports). */
  positive: boolean;
  /** The person asked not to be called again: the phone consent is revoked. */
  dnd: boolean;
  /** Tag put on the contact. */
  tag: string;
}

export const DEFAULT_DISPOSITIONS: Disposition[] = [
  { key: 'interested', label: 'Interessiert', kind: 'final', positive: true, dnd: false, tag: '' },
  { key: 'booked', label: 'Termin vereinbart', kind: 'final', positive: true, dnd: false, tag: 'termin-vereinbart' },
  { key: 'callback', label: 'Rückruf vereinbart', kind: 'callback', positive: false, dnd: false, tag: '' },
  { key: 'no_answer', label: 'Nicht erreicht', kind: 'retry', positive: false, dnd: false, tag: '' },
  { key: 'busy', label: 'Besetzt', kind: 'retry', positive: false, dnd: false, tag: '' },
  { key: 'voicemail', label: 'Mailbox, nichts hinterlassen', kind: 'retry', positive: false, dnd: false, tag: '' },
  { key: 'voicemail_drop', label: 'Nachricht auf der Mailbox hinterlassen', kind: 'retry', positive: false, dnd: false, tag: '' },
  { key: 'wrong_number', label: 'Falsche Nummer', kind: 'final', positive: false, dnd: false, tag: 'falsche-nummer' },
  { key: 'not_interested', label: 'Kein Interesse', kind: 'final', positive: false, dnd: false, tag: '' },
  { key: 'do_not_call', label: 'Nicht mehr anrufen', kind: 'final', positive: false, dnd: true, tag: '' },
];

export interface DialerSettings {
  /** Days and hours calls may be placed (in the sub-account's timezone). */
  days: DayKey[];
  from: string;
  to: string;
  skip_holidays: boolean;
  holiday_state: string;
  /** ledger: the sub-account's consent rule decides; strict: only a confirmed phone consent allows a call. */
  consent_policy: 'ledger' | 'strict';
  max_attempts: number;
  /** Minutes before a contact that was not reached is tried again. */
  retry_minutes: number;
  /** Pause after a call before the next contact is offered (seconds). */
  wrap_seconds: number;
  dispositions: Disposition[];
}

export const DEFAULT_DIALER: DialerSettings = {
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  from: '09:00',
  to: '19:00',
  skip_holidays: true,
  holiday_state: '',
  consent_policy: 'ledger',
  max_attempts: 3,
  retry_minutes: 120,
  wrap_seconds: 10,
  dispositions: DEFAULT_DISPOSITIONS,
};

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY = /^[a-z][a-z0-9_]{1,29}$/;

export const withDialerDefaults = (stored: Partial<DialerSettings> | null | undefined): DialerSettings => ({
  ...DEFAULT_DIALER,
  ...(stored ?? {}),
  dispositions: Array.isArray(stored?.dispositions) && stored!.dispositions.length ? stored!.dispositions : DEFAULT_DISPOSITIONS,
});

/** Validates the settings from the browser onto the current ones. */
export function cleanDialerSettings(b: any, cur: DialerSettings): DialerSettings {
  const s: DialerSettings = { ...cur, dispositions: cur.dispositions.map((d) => ({ ...d })) };
  if (b.days !== undefined) {
    if (!Array.isArray(b.days)) throw bad('Wochentage als Liste');
    s.days = DAY_KEYS.filter((d) => b.days.includes(d));
    if (!s.days.length) throw bad('Bitte mindestens einen Wochentag wählen');
  }
  if (b.from !== undefined || b.to !== undefined) {
    const from = String(b.from ?? s.from);
    const to = String(b.to ?? s.to);
    if (!HM.test(from) || !HM.test(to)) throw bad('Uhrzeit bitte als HH:MM');
    if (to <= from) throw bad('Das Ende der Anrufzeit muss nach dem Beginn liegen');
    s.from = from;
    s.to = to;
  }
  if (b.skip_holidays !== undefined) s.skip_holidays = !!b.skip_holidays;
  if (b.holiday_state !== undefined) {
    const st = String(b.holiday_state).toUpperCase();
    if (st && !STATES.some(([c]) => c === st)) throw bad('Bundesland unbekannt');
    s.holiday_state = st;
  }
  if (b.consent_policy !== undefined) {
    if (b.consent_policy !== 'ledger' && b.consent_policy !== 'strict') throw bad('Einwilligungsregel: „Einwilligungs-Ledger“ oder „streng“');
    s.consent_policy = b.consent_policy;
  }
  const int = (v: unknown, min: number, max: number, d: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  if (b.max_attempts !== undefined) s.max_attempts = int(b.max_attempts, 1, 20, 3);
  if (b.retry_minutes !== undefined) s.retry_minutes = int(b.retry_minutes, 5, 10_080, 120);
  if (b.wrap_seconds !== undefined) s.wrap_seconds = int(b.wrap_seconds, 0, 300, 10);
  if (b.dispositions !== undefined) {
    if (!Array.isArray(b.dispositions) || !b.dispositions.length) throw bad('Bitte mindestens ein Ergebnis anlegen');
    if (b.dispositions.length > 20) throw bad('Höchstens 20 Ergebnisse');
    const seen = new Set<string>();
    s.dispositions = b.dispositions.map((d: any) => {
      const key = String(d?.key ?? '').trim();
      if (!KEY.test(key)) throw bad(`Ergebnis-Schlüssel „${key}“ ungültig (Kleinbuchstaben, Ziffern und _, ab 2 Zeichen)`);
      if (seen.has(key)) throw bad(`Ergebnis „${key}“ kommt doppelt vor`);
      seen.add(key);
      const kind = d?.kind;
      if (!['retry', 'callback', 'final'].includes(kind)) throw bad(`Ergebnis „${key}“: Art unbekannt`);
      const label = String(d?.label ?? '').trim().slice(0, 60);
      if (!label) throw bad(`Ergebnis „${key}“: Bezeichnung fehlt`);
      return { key, label, kind, positive: !!d?.positive, dnd: !!d?.dnd, tag: String(d?.tag ?? '').trim().slice(0, 40) } as Disposition;
    });
    // A person who says "nicht mehr anrufen" must always have a way to be recorded.
    if (!s.dispositions.some((d) => d.dnd)) throw bad('Mindestens ein Ergebnis muss „nicht mehr anrufen“ bedeuten');
  }
  return s;
}

// --- the calling window --------------------------------------------------------------------------------------------

export interface Window {
  open: boolean;
  /** German reason when closed. */
  reason: string;
  /** The start of the next window (ISO), when closed. */
  next: string | null;
}

const dayWindow = (s: Pick<DialerSettings, 'days' | 'skip_holidays' | 'holiday_state'>, ymd: string): { ok: boolean; reason: string } => {
  if (!s.days.includes(weekdayKey(ymd))) return { ok: false, reason: 'an diesem Wochentag wird nicht angerufen' };
  if (s.skip_holidays) {
    const h = germanHolidays(Number(ymd.slice(0, 4)), s.holiday_state).get(ymd);
    if (h) return { ok: false, reason: `Feiertag (${h})` };
  }
  return { ok: true, reason: '' };
};

/** Whether calls may be placed at `at` (days, hours, holidays) – and when the next window opens. */
export function callingWindow(s: Pick<DialerSettings, 'days' | 'from' | 'to' | 'skip_holidays' | 'holiday_state'>, tz: string, at = new Date()): Window {
  const day = ymdInTz(at, tz);
  const hm = hmInTz(at, tz);
  const today = dayWindow(s, day);
  if (today.ok && hm >= s.from && hm < s.to) return { open: true, reason: '', next: null };
  const reason = !today.ok ? `Heute ist nicht angerufen: ${today.reason}` : hm < s.from ? `Anrufzeit beginnt um ${s.from} Uhr` : `Anrufzeit endete um ${s.to} Uhr`;
  // Next opening: later today, or the next allowed day.
  if (today.ok && hm < s.from) return { open: false, reason, next: zonedToUtc(day, s.from, tz).toISOString() };
  for (let i = 1; i <= 14; i++) {
    const d = addDaysYmd(day, i);
    if (dayWindow(s, d).ok) return { open: false, reason, next: zonedToUtc(d, s.from, tz).toISOString() };
  }
  return { open: false, reason, next: null };
}

// --- may this contact be called? ---------------------------------------------------------------------------------------

export interface Verdict {
  ok: boolean;
  code: '' | 'no_phone' | 'dnd' | 'consent' | 'hours' | 'attempts' | 'recent';
  reason: string;
}

export interface VerdictInput {
  phone: string;
  dnd: boolean;
  /** Per-channel "Nicht stören" for the phone (workflow step): the reason or ''. */
  channelDnd: string;
  /** The consent ledger's verdict for the phone channel; null when the consent module is not there. */
  consent: { allow: boolean; reason: string; confirmed: boolean } | null;
  consentPolicy: DialerSettings['consent_policy'];
  attempts: number;
  maxAttempts: number;
  /** Not before this instant (retry pause); '' = any time. */
  notBefore: string;
  window: Window;
  at?: Date;
}

/**
 * The compliance gate, in the order a person would check it: a phone number, "Nicht stören", the consent, the calling
 * window, the number of attempts and the pause between attempts. The first reason that applies is returned in German.
 */
export function dialVerdict(i: VerdictInput): Verdict {
  const no = (code: Verdict['code'], reason: string): Verdict => ({ ok: false, code, reason });
  if (!/^\+[1-9]\d{6,14}$/.test(i.phone)) return no('no_phone', 'Der Kontakt hat keine gültige Telefonnummer');
  if (i.dnd) return no('dnd', 'Der Kontakt hat „Nicht stören“ – es wird nicht angerufen');
  if (i.channelDnd) return no('dnd', i.channelDnd);
  if (i.consent) {
    if (!i.consent.allow) return no('consent', i.consent.reason || 'Keine gültige Einwilligung für Anrufe');
    if (i.consentPolicy === 'strict' && !i.consent.confirmed) return no('consent', 'Keine bestätigte Einwilligung für Anrufe (Regel „streng“)');
  } else if (i.consentPolicy === 'strict') return no('consent', 'Das Einwilligungs-Modul fehlt – die strenge Regel erlaubt keine Anrufe');
  if (!i.window.open) return no('hours', `Außerhalb der Anrufzeiten: ${i.window.reason}`);
  if (i.attempts >= i.maxAttempts) return no('attempts', `Schon ${i.attempts} Versuche – mehr gibt es in dieser Liste nicht`);
  if (i.notBefore && Date.parse(i.notBefore) > (i.at ?? new Date()).getTime()) return no('recent', 'Der nächste Versuch ist erst später fällig');
  return { ok: true, code: '', reason: '' };
}

// --- the queue ---------------------------------------------------------------------------------------------------------

export interface QueueItem {
  id: string;
  status: 'pending' | 'callback' | 'done' | 'blocked';
  position: number;
  next_at: string | null;
  callback_user: string | null;
  locked_by: string | null;
  locked_until: string | null;
}

/**
 * The entry to offer next to `userId`: callbacks that are due (the person's own first), then retries whose pause is over,
 * then fresh entries in list order. Entries another person is working on, finished or blocked ones and callbacks of
 * somebody else are skipped.
 */
export function pickNext(items: QueueItem[], userId: string, at = new Date()): QueueItem | undefined {
  const t = at.toISOString();
  const free = items.filter((i) => (i.status === 'pending' || i.status === 'callback') && (!i.locked_until || i.locked_until <= t || i.locked_by === userId));
  const due = (i: QueueItem) => !i.next_at || i.next_at <= t;
  const callbacks = free.filter((i) => i.status === 'callback' && due(i) && (!i.callback_user || i.callback_user === userId));
  callbacks.sort((a, b) => Number(b.callback_user === userId) - Number(a.callback_user === userId) || (a.next_at ?? '').localeCompare(b.next_at ?? '') || a.position - b.position);
  if (callbacks.length) return callbacks[0];
  const retries = free.filter((i) => i.status === 'pending' && i.next_at && due(i));
  retries.sort((a, b) => (a.next_at ?? '').localeCompare(b.next_at ?? '') || a.position - b.position);
  if (retries.length) return retries[0];
  return free.filter((i) => i.status === 'pending' && !i.next_at).sort((a, b) => a.position - b.position)[0];
}

/** What a disposition does to a call list entry. */
export function applyDisposition(d: Disposition, o: { attempts: number; maxAttempts: number; retryMinutes: number; callbackAt?: string; at?: Date }): { status: 'done' | 'callback' | 'pending'; attempts: number; next_at: string | null; exhausted: boolean } {
  const attempts = o.attempts + 1;
  const at = o.at ?? new Date();
  if (d.kind === 'final') return { status: 'done', attempts, next_at: null, exhausted: false };
  if (d.kind === 'callback') return { status: 'callback', attempts, next_at: o.callbackAt ?? new Date(at.getTime() + 24 * 3600_000).toISOString(), exhausted: false };
  if (attempts >= o.maxAttempts) return { status: 'done', attempts, next_at: null, exhausted: true };
  return { status: 'pending', attempts, next_at: new Date(at.getTime() + o.retryMinutes * 60_000).toISOString(), exhausted: false };
}
