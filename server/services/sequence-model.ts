import { createHash } from 'node:crypto';
import { addDaysYmd, hmInTz, weekdayKey, ymdInTz, zonedToUtc, type DayKey } from '../core/time.js';

/**
 * The pure rules of sales sequences (no database, no HTTP): what a step is, how a list of steps is cleaned, the business-hours
 * window and when a step is due, which A/B variant a person gets, and why an enrolment ends. The engine (sequence-engine.ts)
 * and the module (modules/sequences.ts) build on it; tests/sequences-model.test.ts covers it without an app.
 */

export const STEP_TYPES = ['email', 'task', 'call', 'linkedin'] as const;
export type StepType = (typeof STEP_TYPES)[number];
export const STEP_LABEL: Record<StepType, string> = { email: 'E-Mail', task: 'Aufgabe', call: 'Anruf', linkedin: 'LinkedIn (manuell)' };

export interface Variant {
  id: string;
  label: string;
  subject: string;
  body: string;
}
export interface Step {
  id: string;
  type: StepType;
  /** Wait before the step, counted from the end of the one before (the first step: from the enrolment). */
  delay_days: number;
  delay_hours: number;
  // email
  subject: string;
  body: string;
  /** An answer in the thread of the last mail of this sequence (instead of a new mail). */
  reply_in_thread: boolean;
  variants: Variant[];
  // task, call, LinkedIn
  title: string;
  note: string;
  /** The sequence pauses until the task is done (or `max_wait_days` pass). */
  wait: boolean;
  max_wait_days: number;
}

export const MAX_STEPS = 20;
export const MAX_VARIANTS = 3;
export const MAX_DELAY_DAYS = 120;

export class SequenceError extends Error {}

const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n/g, '\n').slice(0, max);
const int = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const ID = /^[A-Za-z0-9_-]{4,24}$/;

/**
 * The steps from user input. Ids that were given and are valid stay (so statistics keep belonging to their step); the rest get
 * `mint()`. At least one step, at most 20; an e-mail step needs a subject and a text, a task step a title.
 */
export function cleanSteps(input: unknown, mint: () => string): Step[] {
  if (!Array.isArray(input) || !input.length) throw new SequenceError('Mindestens ein Schritt');
  if (input.length > MAX_STEPS) throw new SequenceError(`Höchstens ${MAX_STEPS} Schritte`);
  const seen = new Set<string>();
  const unique = (v: unknown) => {
    let id = typeof v === 'string' && ID.test(v) && !seen.has(v) ? v : mint();
    while (seen.has(id)) id = mint();
    seen.add(id);
    return id;
  };
  return input.map((raw: any, i): Step => {
    const type = STEP_TYPES.includes(raw?.type) ? (raw.type as StepType) : null;
    if (!type) throw new SequenceError(`Schritt ${i + 1}: Art ist E-Mail, Aufgabe, Anruf oder LinkedIn`);
    const step: Step = {
      id: unique(raw.id),
      type,
      delay_days: int(raw.delay_days, 0, MAX_DELAY_DAYS, i === 0 ? 0 : 2),
      delay_hours: int(raw.delay_hours, 0, 23, 0),
      subject: text(raw.subject, 300).replace(/\n/g, ' ').trim(),
      body: text(raw.body, 20_000),
      reply_in_thread: type === 'email' && i > 0 && !!raw.reply_in_thread,
      variants: [],
      title: text(raw.title, 200).replace(/\n/g, ' ').trim(),
      note: text(raw.note, 5000),
      wait: raw.wait === undefined ? type !== 'email' : !!raw.wait,
      max_wait_days: int(raw.max_wait_days, 1, 60, 7),
    };
    if (type === 'email') {
      // Empty variants are dropped before the limit counts, so a blank row never takes the place of a real one.
      const variants = (Array.isArray(raw.variants) ? raw.variants : []).filter((v: any) => String(v?.subject ?? '').trim() || String(v?.body ?? '').trim()).slice(0, MAX_VARIANTS);
      step.variants = variants.map((v: any, n: number): Variant => ({
        id: unique(v?.id),
        label: text(v?.label, 60).trim() || `Variante ${String.fromCharCode(66 + n)}`,
        // A variant without a text of its own takes the one of the main mail.
        subject: text(v?.subject, 300).replace(/\n/g, ' ').trim() || step.subject,
        body: text(v?.body, 20_000).trim() ? text(v?.body, 20_000) : step.body,
      }));
      if (!step.body.trim()) throw new SequenceError(`Schritt ${i + 1}: Der Text der E-Mail fehlt`);
      if (!step.subject && !step.reply_in_thread) throw new SequenceError(`Schritt ${i + 1}: Der Betreff fehlt`);
    } else if (!step.title) throw new SequenceError(`Schritt ${i + 1}: Der Titel der Aufgabe fehlt`);
    return step;
  });
}

// --- business hours -----------------------------------------------------------------------------------------------------

export interface Window {
  enabled: boolean;
  days: DayKey[];
  from: string;
  to: string;
  /** IANA zone; empty = the sub-account's zone. */
  tz: string;
}
export const DEFAULT_WINDOW: Window = { enabled: true, days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '17:00', tz: '' };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ALL_DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export function cleanWindow(v: unknown, isTz: (tz: string) => boolean = () => true): Window {
  const b = v && typeof v === 'object' ? (v as Record<string, any>) : {};
  const days = Array.isArray(b.days) ? ALL_DAYS.filter((d) => b.days.includes(d)) : DEFAULT_WINDOW.days;
  const from = typeof b.from === 'string' && HM.test(b.from) ? b.from : DEFAULT_WINDOW.from;
  const to = typeof b.to === 'string' && HM.test(b.to) ? b.to : DEFAULT_WINDOW.to;
  if (from >= to) throw new SequenceError('Sendezeitraum: „von“ muss vor „bis“ liegen');
  const tz = typeof b.tz === 'string' && b.tz && isTz(b.tz) ? b.tz : '';
  if (b.enabled !== false && !days.length) throw new SequenceError('Sendezeitraum: mindestens ein Wochentag');
  return { enabled: b.enabled !== false, days, from, to, tz };
}

export function inWindow(at: Date, w: Window, tz: string): boolean {
  if (!w.enabled) return true;
  if (!w.days.includes(weekdayKey(ymdInTz(at, tz)))) return false;
  const hm = hmInTz(at, tz);
  return hm >= w.from && hm < w.to;
}

/** A few minutes, the same for the same seed: mails of one batch do not all leave at the second the window opens. */
export function jitterMinutes(seed: string, max: number): number {
  if (max <= 0) return 0;
  return createHash('sha256').update(seed).digest().readUInt16BE(0) % (max + 1);
}

/** The first moment at or after `from` that lies inside the window (the window's opening, plus jitter, when `from` is outside). */
export function nextSlot(from: Date, w: Window, tz: string, seed = '', jitter = 15): Date {
  if (!w.enabled || inWindow(from, w, tz)) return from;
  let ymd = ymdInTz(from, tz);
  for (let i = 0; i < 15; i++) {
    if (w.days.includes(weekdayKey(ymd))) {
      const open = zonedToUtc(ymd, w.from, tz);
      if (open.getTime() >= from.getTime()) {
        const length = (zonedToUtc(ymd, w.to, tz).getTime() - open.getTime()) / 60_000;
        return new Date(open.getTime() + jitterMinutes(seed, Math.min(jitter, Math.floor(length / 4))) * 60_000);
      }
    }
    ymd = addDaysYmd(ymd, 1);
  }
  return from;
}

/** When the step is due: the end of the step before + its delay, moved into the window. */
export function dueAt(prev: Date, step: Pick<Step, 'delay_days' | 'delay_hours'>, w: Window, tz: string, seed: string): Date {
  const base = new Date(prev.getTime() + (step.delay_days * 24 + step.delay_hours) * 3_600_000);
  return nextSlot(base, w, tz, seed);
}

// --- settings of a sequence --------------------------------------------------------------------------------------------

export const STOP_REASONS = ['reply', 'meeting', 'stage_change', 'deal_closed', 'unsubscribed', 'consent', 'manual', 'send_failed', 'contact_removed', 'paused_user'] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const STOP_LABEL: Record<StopReason, string> = {
  reply: 'Antwort erhalten',
  meeting: 'Termin gebucht',
  stage_change: 'Deal-Phase geändert',
  deal_closed: 'Deal gewonnen oder verloren',
  unsubscribed: 'Abgemeldet oder „Nicht stören“',
  consent: 'Keine Einwilligung',
  manual: 'Von Hand beendet',
  send_failed: 'Versand fehlgeschlagen',
  contact_removed: 'Kontakt entfernt',
  paused_user: 'Person nicht mehr verfügbar',
};

export interface SequenceSettings {
  window: Window;
  /** Which events end an enrolment by themselves. "Abgemeldet" always does. */
  stop_on: { reply: boolean; meeting: boolean; stage_change: boolean; deal_closed: boolean };
  /** A line with the unsubscribe link under every mail. */
  footer: boolean;
  /** Without a mailbox of their own the sub-account's shared mailbox sends. */
  shared_mailbox: boolean;
}
export const DEFAULT_SETTINGS: SequenceSettings = { window: DEFAULT_WINDOW, stop_on: { reply: true, meeting: true, stage_change: false, deal_closed: true }, footer: true, shared_mailbox: false };

export function cleanSettings(v: unknown, isTz?: (tz: string) => boolean, current: SequenceSettings = DEFAULT_SETTINGS): SequenceSettings {
  const b = v && typeof v === 'object' ? (v as Record<string, any>) : {};
  const stop = b.stop_on && typeof b.stop_on === 'object' ? b.stop_on : {};
  return {
    window: b.window !== undefined ? cleanWindow(b.window, isTz) : current.window,
    stop_on: {
      reply: stop.reply === undefined ? current.stop_on.reply : !!stop.reply,
      meeting: stop.meeting === undefined ? current.stop_on.meeting : !!stop.meeting,
      stage_change: stop.stage_change === undefined ? current.stop_on.stage_change : !!stop.stage_change,
      deal_closed: stop.deal_closed === undefined ? current.stop_on.deal_closed : !!stop.deal_closed,
    },
    footer: b.footer === undefined ? current.footer : !!b.footer,
    shared_mailbox: b.shared_mailbox === undefined ? current.shared_mailbox : !!b.shared_mailbox,
  };
}

// --- variants --------------------------------------------------------------------------------------------------------------

/**
 * The text of an e-mail step for one enrolment: the main mail or one of its variants. The choice depends only on the enrolment and
 * the step, so a person always sees the same variant and the variants share the people evenly.
 */
export function pickVariant(step: Pick<Step, 'id' | 'subject' | 'body' | 'variants'>, seed: string): { id: string; label: string; subject: string; body: string } {
  const all = [{ id: '', label: 'Original', subject: step.subject, body: step.body }, ...step.variants];
  if (all.length === 1) return all[0];
  const n = createHash('sha256').update(`${seed}:${step.id}`).digest().readUInt32BE(0);
  return all[n % all.length];
}

/** The unsubscribe line: plain text, short, in German. */
export const footerText = (url: string) => `\n\n—\nKeine weiteren Nachrichten von mir? Hier abmelden: ${url}`;
