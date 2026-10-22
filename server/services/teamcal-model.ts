import { bad } from '../core/http.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc } from '../core/time.js';
import { id as newId } from '../core/util.js';
import type { Windows } from './team-people.js';

/**
 * Team-Kalender: the types of a booking calendar (single, round robin, collective, group), the booking page's questions,
 * payment and video settings with their validation, and the pure slot math for several people. No database, no clock of
 * its own – the engine (teamcal-engine.ts) feeds it busy times and loads, so the rules can be tested without an app.
 */

export const KINDS = ['single', 'round_robin', 'collective', 'group'] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = { single: 'Einzeln', round_robin: 'Round Robin', collective: 'Kollektiv', group: 'Gruppe / Klasse' };
export const VIDEO = ['none', 'meet', 'zoom', 'teams', 'static'] as const;
export type Video = (typeof VIDEO)[number];
export const VIDEO_LABEL: Record<Video, string> = { none: 'Kein Video-Link', meet: 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams', static: 'Fester Ort oder Link' };

export interface Question {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'choice' | 'multi' | 'checkbox';
  required: boolean;
  options: string[];
  help: string;
  /** Conditional logic: only asked when an earlier choice/multi/checkbox question was answered with one of `values` (checkbox: "Ja"). */
  show_if?: { id: string; values: string[] };
}
export const QUESTION_TYPES: Record<Question['type'], string> = { text: 'Kurze Antwort', textarea: 'Langer Text', choice: 'Auswahl (eine)', multi: 'Auswahl (mehrere)', checkbox: 'Kontrollkästchen' };

export interface PaymentCfg {
  mode: 'none' | 'full' | 'deposit';
  /** Price incl. tax (what the customer pays for the whole appointment). */
  amount_cents: number;
  /** For "deposit": what is paid when booking (incl. tax). */
  deposit_cents: number;
  currency: string;
  /** Null = the sub-account's invoice tax rate. */
  tax_rate: number | null;
  /** The line on the invoice (empty = the calendar's name). */
  title: string;
  /** Minutes the slot is held for the payment. */
  hold_minutes: number;
  /** Cancelled in time: refund automatically through Stripe, or only tell the team. */
  refund: 'none' | 'auto' | 'manual';
}

export interface TeamCalConfig {
  kind: Kind;
  /** Round robin: "availability" offers every time someone is free; "equal" only while the free person is not far ahead of the others. */
  strategy: 'availability' | 'equal';
  distribution: 'even' | 'weighted';
  capacity: number;
  waitlist: boolean;
  buffer_before: number | null;
  buffer_after: number | null;
  questions: Question[];
  payment: PaymentCfg;
  video: Video;
  /** Cancellation and refund terms shown on the booking and the manage page. */
  policy_text: string;
  allow_cancel: boolean;
  allow_reschedule: boolean;
  /** Customers can cancel / reschedule until this many hours before the start (0 = until the start). */
  cancel_cutoff_hours: number;
  reschedule_cutoff_hours: number;
  consent_text: string;
  show_hosts: boolean;
  /** Guests per booking: the visitor may add up to this many e-mail addresses (0 = off; not for group classes). */
  guests_max: number;
  /** Further meeting lengths (minutes) the visitor may choose besides the calendar's own duration; empty = only that one. */
  durations: number[];
  /** Several appointments in one booking: up to this many times at once (0/1 = one; not for paid calendars or classes). */
  multi_max: number;
}

export const defaultConfig = (): TeamCalConfig => ({
  kind: 'single',
  strategy: 'availability',
  distribution: 'even',
  capacity: 1,
  waitlist: false,
  buffer_before: null,
  buffer_after: null,
  questions: [],
  payment: { mode: 'none', amount_cents: 0, deposit_cents: 0, currency: 'EUR', tax_rate: null, title: '', hold_minutes: 30, refund: 'manual' },
  video: 'none',
  policy_text: '',
  allow_cancel: true,
  allow_reschedule: true,
  cancel_cutoff_hours: 0,
  reschedule_cutoff_hours: 0,
  consent_text: 'Ich bin einverstanden, dass meine Angaben zur Terminvereinbarung gespeichert werden.',
  show_hosts: true,
  guests_max: 0,
  durations: [],
  multi_max: 0,
});

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const int = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const bool = (v: unknown, def: boolean) => (v === undefined ? def : v === true || v === 'true' || v === 1);

export function cleanQuestion(v: unknown): Question {
  const q = obj(v);
  const type = (Object.keys(QUESTION_TYPES) as Question['type'][]).includes(q.type) ? (q.type as Question['type']) : 'text';
  const label = String(q.label ?? '').trim().slice(0, 200);
  if (!label) throw bad('Jede Frage braucht einen Text');
  const options = type === 'choice' || type === 'multi' ? [...new Set((Array.isArray(q.options) ? q.options : String(q.options ?? '').split('\n')).map((o: unknown) => String(o ?? '').trim().slice(0, 120)).filter(Boolean))].slice(0, 20) : [];
  if ((type === 'choice' || type === 'multi') && options.length < 2) throw bad(`Frage „${label}“: mindestens zwei Antwortmöglichkeiten`);
  const cond = obj(q.show_if);
  const values = (Array.isArray(cond.values) ? cond.values : cond.value !== undefined ? [cond.value] : []).map((x: unknown) => String(x ?? '').trim().slice(0, 120)).filter(Boolean).slice(0, 20);
  const show_if = /^[A-Za-z0-9_-]{4,40}$/.test(String(cond.id ?? '')) && values.length ? { id: String(cond.id), values } : undefined;
  return { id: /^[A-Za-z0-9_-]{4,40}$/.test(String(q.id ?? '')) ? String(q.id) : newId(8), label, type, required: q.required === true, options, help: String(q.help ?? '').trim().slice(0, 300), ...(show_if ? { show_if } : {}) };
}

/** A condition may only point at an earlier choice, multi or checkbox question (no loops, the page can evaluate it top-down). */
export function checkConditions(questions: Question[]): Question[] {
  questions.forEach((q, i) => {
    if (!q.show_if) return;
    const ref = questions.slice(0, i).find((x) => x.id === q.show_if!.id);
    if (!ref || !['choice', 'multi', 'checkbox'].includes(ref.type)) throw bad(`Frage „${q.label}“: Die Bedingung muss auf eine frühere Auswahl- oder Ja/Nein-Frage zeigen`);
    const allowed = ref.type === 'checkbox' ? ['Ja', 'Nein'] : ref.options;
    if (q.show_if.values.some((v) => !allowed.includes(v))) throw bad(`Frage „${q.label}“: Die Bedingung nennt eine Antwort, die es bei „${ref.label}“ nicht gibt`);
  });
  return questions;
}

/** Is a question asked, given the answers so far (`given` as the page sends them)? */
export function questionShown(q: Question, questions: Question[], given: Record<string, unknown>, shown: Set<string>): boolean {
  if (!q.show_if) return true;
  const ref = questions.find((x) => x.id === q.show_if!.id);
  if (!ref || !shown.has(ref.id)) return false;
  const raw = given[ref.id];
  const vals = ref.type === 'checkbox' ? [raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === 'Ja' ? 'Ja' : 'Nein'] : (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x));
  return vals.some((v) => q.show_if!.values.includes(v));
}

export function cleanPayment(v: unknown, cur: PaymentCfg): PaymentCfg {
  const p = obj(v);
  const out = { ...cur };
  if (p.mode !== undefined) {
    if (!['none', 'full', 'deposit'].includes(p.mode)) throw bad('Zahlung: none, full oder deposit');
    out.mode = p.mode;
  }
  if (p.amount_cents !== undefined) out.amount_cents = int(p.amount_cents, 0, 0, 10_000_000);
  if (p.deposit_cents !== undefined) out.deposit_cents = int(p.deposit_cents, 0, 0, 10_000_000);
  if (p.currency !== undefined) {
    const c = String(p.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw bad('Währung als dreistelliger Code (EUR)');
    out.currency = c;
  }
  if (p.tax_rate !== undefined) out.tax_rate = p.tax_rate === null || p.tax_rate === '' ? null : Math.min(100, Math.max(0, Number(p.tax_rate) || 0));
  if (p.title !== undefined) out.title = String(p.title ?? '').trim().slice(0, 200);
  if (p.hold_minutes !== undefined) out.hold_minutes = int(p.hold_minutes, 30, 30, 24 * 60);
  if (p.refund !== undefined) {
    if (!['none', 'auto', 'manual'].includes(p.refund)) throw bad('Rückerstattung: none, auto oder manual');
    out.refund = p.refund;
  }
  if (out.mode !== 'none') {
    if (out.amount_cents < 50) throw bad('Der Preis muss mindestens 0,50 betragen (Stripe-Mindestbetrag)');
    if (out.mode === 'deposit' && (out.deposit_cents < 50 || out.deposit_cents >= out.amount_cents)) throw bad('Die Anzahlung muss mindestens 0,50 und kleiner als der Preis sein');
  }
  return out;
}

/** Validates an update of a calendar's team settings against the current ones. */
export function cleanConfig(body: unknown, cur: TeamCalConfig): TeamCalConfig {
  const b = obj(body);
  const out: TeamCalConfig = JSON.parse(JSON.stringify(cur));
  if (b.kind !== undefined) {
    if (!(KINDS as readonly string[]).includes(b.kind)) throw bad(`Unbekannter Kalendertyp – möglich: ${KINDS.join(', ')}`);
    out.kind = b.kind;
  }
  if (b.strategy !== undefined) {
    if (!['availability', 'equal'].includes(b.strategy)) throw bad('Strategie: availability oder equal');
    out.strategy = b.strategy;
  }
  if (b.distribution !== undefined) {
    if (!['even', 'weighted'].includes(b.distribution)) throw bad('Verteilung: even oder weighted');
    out.distribution = b.distribution;
  }
  if (b.capacity !== undefined) out.capacity = int(b.capacity, 1, 1, 500);
  if (b.waitlist !== undefined) out.waitlist = bool(b.waitlist, false);
  for (const k of ['buffer_before', 'buffer_after'] as const) if (b[k] !== undefined) out[k] = b[k] === null || b[k] === '' ? null : int(b[k], 0, 0, 24 * 60);
  if (b.questions !== undefined) {
    if (!Array.isArray(b.questions)) throw bad('Fragen als Liste');
    if (b.questions.length > 20) throw bad('Höchstens 20 Fragen');
    out.questions = checkConditions(b.questions.map(cleanQuestion));
  }
  if (b.payment !== undefined) out.payment = cleanPayment(b.payment, out.payment);
  if (b.video !== undefined) {
    if (!(VIDEO as readonly string[]).includes(b.video)) throw bad(`Video: ${VIDEO.join(', ')}`);
    out.video = b.video;
  }
  if (b.policy_text !== undefined) out.policy_text = String(b.policy_text ?? '').trim().slice(0, 2000);
  if (b.consent_text !== undefined) out.consent_text = String(b.consent_text ?? '').trim().slice(0, 500) || defaultConfig().consent_text;
  for (const k of ['allow_cancel', 'allow_reschedule', 'show_hosts'] as const) if (b[k] !== undefined) out[k] = bool(b[k], out[k]);
  for (const k of ['cancel_cutoff_hours', 'reschedule_cutoff_hours'] as const) if (b[k] !== undefined) out[k] = int(b[k], 0, 0, 24 * 60);
  if (b.guests_max !== undefined) out.guests_max = int(b.guests_max, 0, 0, 10);
  if (b.durations !== undefined) {
    const list = (Array.isArray(b.durations) ? b.durations : String(b.durations ?? '').split(/[\s,;]+/)).filter((x: unknown) => x !== '' && x !== null).map((x: unknown) => int(x, 0, 5, 720)).filter((n: number) => n >= 5);
    out.durations = [...new Set<number>(list)].sort((x, y) => x - y).slice(0, 6);
  }
  if (b.multi_max !== undefined) out.multi_max = int(b.multi_max, 0, 0, 5);
  if (out.multi_max > 1 && out.payment.mode !== 'none') throw bad('Mehrere Termine auf einmal gehen nur bei Kalendern ohne Zahlung');
  if (out.durations.length && out.payment.mode !== 'none') throw bad('Mehrere Termindauern gehen nur bei Kalendern ohne Zahlung');
  if (out.durations.length && out.kind === 'group') throw bad('Gruppen und Klassen haben eine feste Dauer');
  return out;
}

/** Stored config (maybe older or hand-edited) with every missing value filled in. */
export function withDefaults(stored: unknown): TeamCalConfig {
  const d = defaultConfig();
  try {
    return cleanConfig(stored, d);
  } catch {
    return d;
  }
}

/** Does this calendar need the team booking page (and API) instead of the plain one? */
export function needsTeamPage(c: TeamCalConfig): boolean {
  return c.kind !== 'single' || c.questions.length > 0 || c.payment.mode !== 'none' || c.video !== 'none' || !!c.policy_text || !c.allow_cancel || !c.allow_reschedule || c.cancel_cutoff_hours > 0 || guestsAllowed(c) > 0 || c.durations.length > 0 || multiAllowed(c) > 1;
}

/** How many times a visitor may book in one go (1 = the usual single booking). */
export const multiAllowed = (c: TeamCalConfig): number => (c.kind === 'group' || c.payment.mode !== 'none' ? 1 : Math.max(1, c.multi_max || 0));

/** The lengths a visitor can choose (the calendar's own first); a calendar row with the chosen one, or an error for any other. */
export function durationChoices(calDuration: number, c: TeamCalConfig): number[] {
  return [...new Set([calDuration, ...(c.durations ?? [])])];
}

/** How many guests a visitor may add to a booking (classes count seats per person, so they take none). */
export const guestsAllowed = (c: TeamCalConfig): number => (c.kind === 'group' ? 0 : c.guests_max || 0);

// --- answers ----------------------------------------------------------------------------------

export interface Answer {
  id: string;
  label: string;
  value: string;
}

/** Checks what the visitor answered against the questions; returns the answers to store (never anything unasked). */
export function validateAnswers(questions: Question[], given: unknown, o: { lenient?: boolean } = {}): Answer[] {
  const src = obj(given);
  const out: Answer[] = [];
  const shown = new Set<string>();
  for (const q of questions) {
    // A question whose condition is not met was not asked: nothing required, nothing stored.
    if (!questionShown(q, questions, src, shown)) continue;
    shown.add(q.id);
    const raw = src[q.id];
    let value = '';
    if (q.type === 'checkbox') {
      const on = raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === 'Ja';
      if (q.required && !on && !o.lenient) throw bad(`Bitte bestätigen: ${q.label}`);
      value = on ? 'Ja' : o.lenient ? '' : 'Nein';
    } else if (q.type === 'multi') {
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x: unknown) => String(x));
      if (list.some((x: string) => !q.options.includes(x))) throw bad(`Ungültige Auswahl bei „${q.label}“`);
      if (q.required && !list.length && !o.lenient) throw bad(`Bitte beantworten: ${q.label}`);
      value = [...new Set(list)].join(', ');
    } else {
      const s = String(raw ?? '').trim();
      if (s.length > (q.type === 'textarea' ? 5000 : 500)) throw bad(`Die Antwort bei „${q.label}“ ist zu lang`);
      if (q.type === 'choice' && s && !q.options.includes(s)) throw bad(`Ungültige Auswahl bei „${q.label}“`);
      if (q.required && !s && !o.lenient) throw bad(`Bitte beantworten: ${q.label}`);
      value = s;
    }
    if (value !== '') out.push({ id: q.id, label: q.label, value });
  }
  return out;
}

/** Answers as readable lines for notes, e-mails and the calendar entry. */
export const answerLines = (a: Answer[]) => a.map((x) => `${x.label}: ${x.value}`).join('\n');

// --- prices -----------------------------------------------------------------------------------

/** The net price (cents) that gives exactly `gross` after tax is added the way invoices do (net + round(net × rate)). */
export function netFromGross(gross: number, taxRate: number): number {
  if (!taxRate) return gross;
  const guess = Math.round(gross / (1 + taxRate / 100));
  for (const d of [0, -1, 1, -2, 2]) {
    const net = guess + d;
    if (net + Math.round((net * taxRate) / 100) === gross) return net;
  }
  return guess;
}

/** Invoice lines that add up to exactly `gross` cents (a rounding line when no net price gives that total at this tax rate). */
export function itemsForGross(item: { name: string; description: string }, gross: number, rate: number) {
  const net = netFromGross(gross, rate);
  const total = net + Math.round((net * rate) / 100);
  const main = { ...item, qty: 1, price_cents: net, tax_rate: rate };
  return total === gross ? [main] : [main, { name: 'Rundungsausgleich', description: '', qty: 1, price_cents: gross - total, tax_rate: 0 }];
}

/** What is charged when booking: the whole price or the deposit. */
export const dueNow = (p: PaymentCfg) => (p.mode === 'full' ? p.amount_cents : p.mode === 'deposit' ? p.deposit_cents : 0);

// --- policy -----------------------------------------------------------------------------------

/** Can a customer still cancel / reschedule an appointment starting at `start`? */
export function mayChange(cutoffHours: number, start: string | Date, at = new Date()): boolean {
  const t = typeof start === 'string' ? Date.parse(start) : start.getTime();
  return t - cutoffHours * 3600_000 > at.getTime();
}

// --- slots (pure) -----------------------------------------------------------------------------

export interface Iv {
  s: number;
  e: number;
}

export interface SlotRules {
  duration: number;
  interval: number;
  before: number;
  after: number;
  minNoticeH: number;
  maxDays: number;
  tz: string;
  /** The calendar's bookable windows per weekday. */
  availability: Windows;
}

export interface MemberLoad {
  id: string;
  weight: number;
  /** Own working hours on this calendar; null = the calendar's windows. */
  windows: Windows | null;
  busy: Iv[];
  /** Bookings counted for the fair distribution. */
  load: number;
}

const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Start times (ms) of a day on the calendar's grid, after minimum notice and the bookable range. */
export function gridStarts(r: SlotRules, ymd: string, at: Date): number[] {
  const today = ymdInTz(at, r.tz);
  if (ymd < today || ymd > addDaysYmd(today, r.maxDays)) return [];
  const windows = r.availability[weekdayKey(ymd) as keyof Windows] ?? [];
  const earliest = at.getTime() + r.minNoticeH * 3600_000;
  const dur = r.duration * 60_000;
  const step = (r.interval || r.duration) * 60_000;
  const out: number[] = [];
  for (const [from, to] of windows) {
    const end = zonedToUtc(ymd, to, r.tz).getTime();
    for (let t = zonedToUtc(ymd, from, r.tz).getTime(); t + dur <= end; t += step) if (t >= earliest) out.push(t);
  }
  return out;
}

/** Is a person's own working time covering [start, start+duration] on that weekday? (null = no own hours, always fine.) */
export function withinHours(w: Windows | null, ymd: string, startMs: number, r: SlotRules): boolean {
  if (!w) return true;
  const list = w[weekdayKey(ymd) as keyof Windows] ?? [];
  const startWall = Math.round((startMs - zonedToUtc(ymd, '00:00', r.tz).getTime()) / 60_000);
  const endWall = startWall + r.duration;
  return list.some(([from, to]) => minutesOf(from) <= startWall && endWall <= minutesOf(to));
}

export const isBusy = (busy: Iv[], startMs: number, r: SlotRules) => busy.some((b) => startMs - r.before * 60_000 < b.e && startMs + (r.duration + r.after) * 60_000 > b.s);

export const isFree = (m: MemberLoad, ymd: string, startMs: number, r: SlotRules) => withinHours(m.windows, ymd, startMs, r) && !isBusy(m.busy, startMs, r);

/** The member who gets a booking: the one with the lowest load per weight; ties go to the earlier one in the list. */
export function chooseHost(free: MemberLoad[], weighted: boolean): MemberLoad | undefined {
  let best: MemberLoad | undefined;
  let bestScore = Infinity;
  for (const m of free) {
    const score = m.load / (weighted ? Math.max(1, m.weight) : 1);
    if (score < bestScore - 1e-9) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

export interface TeamSlot {
  start: string;
  /** Who would host: the members that are free (round robin), everybody (collective). */
  hosts: string[];
}

/**
 * Free start times of a day for several people.
 * - round robin / availability: any time at least one member is free;
 * - round robin / equal: only while a free member is within one booking (per weight) of the least busy member – whoever is
 *   far ahead gets nothing new until the others catch up;
 * - collective: only when all members are free at the same time.
 */
export function teamSlots(kind: 'round_robin' | 'collective', strategy: TeamCalConfig['strategy'], weighted: boolean, r: SlotRules, ymd: string, at: Date, members: MemberLoad[]): TeamSlot[] {
  if (!members.length) return [];
  const out: TeamSlot[] = [];
  const score = (m: MemberLoad) => m.load / (weighted ? Math.max(1, m.weight) : 1);
  const lowest = Math.min(...members.map(score));
  for (const t of gridStarts(r, ymd, at)) {
    const free = members.filter((m) => isFree(m, ymd, t, r));
    if (kind === 'collective') {
      if (free.length === members.length) out.push({ start: new Date(t).toISOString(), hosts: members.map((m) => m.id) });
      continue;
    }
    const eligible = strategy === 'equal' ? free.filter((m) => score(m) <= lowest + 1 / (weighted ? Math.max(1, m.weight) : 1) + 1e-9) : free;
    if (eligible.length) out.push({ start: new Date(t).toISOString(), hosts: eligible.map((m) => m.id) });
  }
  return out;
}

