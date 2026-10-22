import { bad } from '../core/http.js';
import { calendarDaysBetween, daysOverdue } from './invoice-model.js';

export { daysOverdue };

/**
 * Dunning (Mahnwesen): settings and maths without any I/O. Two parts share one settings document per sub-account:
 * - `sub`: failed subscription / instalment payments (reminders with a link to the billing page, access pause, own retries);
 * - `inv`: invoices that are overdue – Zahlungserinnerung, 1. und 2. Mahnung with fees and default interest (§ 288 BGB).
 */

export type InvoiceDunningMode = 'off' | 'approval' | 'auto';

export interface SubSettings {
  enabled: boolean;
  /** `stripe`: Stripe's own retries (Smart Retries, set in the Stripe dashboard); `own`: this app pays the open invoice on `retry_days`. */
  retry_mode: 'stripe' | 'own';
  retry_days: number[];
  /** Days after the first failed payment on which the buyer is reminded (0 = at once). */
  reminder_days: number[];
  send_sms: boolean;
  /** Pause the access this many days after the first failure even if Stripe is still retrying (0 = only when it stops). */
  final_after_days: number;
  access_on_final: 'pause' | 'keep';
  cancel_on_final: boolean;
  billing_method: 'setup' | 'portal';
  link_days: number;
  email_subject: string;
  email_body: string;
  reminder_subject: string;
  reminder_body: string;
  final_subject: string;
  final_body: string;
  sms_body: string;
}

export interface Level {
  key: string;
  label: string;
  /** Days after the due date on which this level is due. */
  days: number;
  fee_cents: number;
  /** Days the customer gets to pay after the notice. */
  deadline_days: number;
  subject: string;
  body: string;
}

export interface InvSettings {
  mode: InvoiceDunningMode;
  levels: Level[];
  interest: { enabled: boolean; base_rate: number; b2c_margin: number; b2b_margin: number; from_level: number; customer_type: 'auto' | 'b2c' | 'b2b' };
  b2b_flat_fee_cents: number;
  flat_fee_from_level: number;
  /**
   * Later notices claim the fees of the earlier notices that were sent (*Mahngebühren früherer Schreiben*): the 2. Mahnung asks
   * for its own fee plus the 1. Mahnung's, which is still owed. Off when the fee of each level is meant as the total so far.
   */
  carry_fees: boolean;
  /** At least this many calendar days (the sub-account's zone) between two notices of one invoice. */
  min_gap_days: number;
  min_amount_cents: number;
  sms: boolean;
}

export interface DunningSettings {
  sub: SubSettings;
  inv: InvSettings;
}

const SIGN = '\n\nViele Grüße\n{{location.name}}';

export const DEFAULT_SUB: SubSettings = {
  enabled: true,
  retry_mode: 'stripe',
  retry_days: [1, 3, 5, 7],
  reminder_days: [0, 3, 7],
  send_sms: false,
  final_after_days: 14,
  access_on_final: 'pause',
  cancel_on_final: false,
  billing_method: 'setup',
  link_days: 30,
  email_subject: 'Deine Zahlung für „{{dunning.product}}“ hat nicht geklappt',
  email_body: `Hallo {{contact.first_name|}},\n\nwir konnten {{dunning.amount}} für „{{dunning.product}}“ leider nicht einziehen. Meist liegt es an einer abgelaufenen oder gesperrten Karte.\n\nDu kannst deine Zahlungsmethode in einer Minute hier aktualisieren:\n{{dunning.url}}\n\nSobald die Zahlung durch ist, läuft alles weiter wie gewohnt.${SIGN}`,
  reminder_subject: 'Erinnerung: Zahlungsmethode für „{{dunning.product}}“ aktualisieren',
  reminder_body: `Hallo {{contact.first_name|}},\n\nwir haben {{dunning.amount}} für „{{dunning.product}}“ noch nicht erhalten. Bitte aktualisiere deine Zahlungsmethode, damit dein Zugang nicht unterbrochen wird:\n{{dunning.url}}${SIGN}`,
  final_subject: 'Dein Zugang zu „{{dunning.product}}“ ist pausiert',
  final_body: `Hallo {{contact.first_name|}},\n\nleider konnten wir die Zahlung für „{{dunning.product}}“ auch nach mehreren Versuchen nicht einziehen. Dein Zugang ist deshalb pausiert.\n\nSobald du deine Zahlungsmethode aktualisiert hast, geht es sofort weiter:\n{{dunning.url}}${SIGN}`,
  sms_body: 'Zahlung für {{dunning.product}} fehlgeschlagen. Bitte Zahlungsmethode aktualisieren: {{dunning.url}}',
};

const INV_TAIL = '\n\nRechnung ansehen und bezahlen: {{invoice.url}}\nSchreiben als PDF: {{notice.pdf_url}}\n\nHat sich Ihre Zahlung mit diesem Schreiben überschnitten, betrachten Sie es bitte als gegenstandslos.\n\nViele Grüße\n{{location.name}}';

export const DEFAULT_LEVELS: Level[] = [
  {
    key: 'reminder',
    label: 'Zahlungserinnerung',
    days: 7,
    fee_cents: 0,
    deadline_days: 7,
    subject: 'Zahlungserinnerung zu Rechnung {{invoice.number}}',
    body: `Hallo {{contact.first_name|}},\n\nzu unserer Rechnung {{invoice.number}} vom {{invoice.date}} über {{invoice.total}} konnten wir noch keinen Zahlungseingang feststellen. Vielleicht ist sie Ihnen entgangen – bitte überweisen Sie den offenen Betrag bis zum {{notice.deadline}}.${INV_TAIL}`,
  },
  {
    key: 'dunning1',
    label: '1. Mahnung',
    days: 21,
    fee_cents: 500,
    deadline_days: 7,
    subject: '1. Mahnung zu Rechnung {{invoice.number}}',
    body: `Hallo {{contact.first_name|}},\n\nleider ist unsere Rechnung {{invoice.number}} über {{invoice.total}} (fällig am {{invoice.due}}) trotz Erinnerung noch offen. Wir bitten Sie, den Gesamtbetrag von {{notice.total}} (inkl. Mahngebühr {{notice.fee}}) bis zum {{notice.deadline}} zu überweisen.${INV_TAIL}`,
  },
  {
    key: 'dunning2',
    label: '2. Mahnung',
    days: 35,
    fee_cents: 1000,
    deadline_days: 5,
    subject: '2. Mahnung zu Rechnung {{invoice.number}} – letzte Zahlungsaufforderung',
    body: `Hallo {{contact.first_name|}},\n\nauch nach unserer ersten Mahnung haben wir keinen Zahlungseingang zu Rechnung {{invoice.number}} festgestellt. Wir fordern Sie letztmalig auf, {{notice.total}} (Rechnung, Mahngebühren und Verzugszinsen) bis zum {{notice.deadline}} zu begleichen. Danach behalten wir uns weitere Schritte vor.${INV_TAIL}`,
  },
];

export const DEFAULT_INV: InvSettings = {
  mode: 'off',
  levels: DEFAULT_LEVELS,
  // Basiszinssatz laut Bundesbank – ändert sich zum 1. Januar und 1. Juli, bitte aktuell halten.
  interest: { enabled: true, base_rate: 1.27, b2c_margin: 5, b2b_margin: 9, from_level: 2, customer_type: 'auto' },
  b2b_flat_fee_cents: 4000,
  flat_fee_from_level: 2,
  carry_fees: true,
  min_gap_days: 3,
  min_amount_cents: 100,
  sms: false,
};

const days = (v: unknown, fallback: number[], max = 90): number[] => {
  if (!Array.isArray(v)) return fallback;
  const out = [...new Set(v.map((x) => Math.round(Number(x))).filter((n) => Number.isFinite(n) && n >= 0 && n <= max))].sort((a, b) => a - b);
  return out.slice(0, 12);
};
const text = (v: unknown, fallback: string, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : fallback);
const intIn = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function cleanSub(v: any, cur: SubSettings = DEFAULT_SUB): SubSettings {
  const b = v && typeof v === 'object' ? v : {};
  const pick = <T extends string>(x: unknown, allowed: T[], fallback: T): T => (allowed.includes(x as T) ? (x as T) : fallback);
  return {
    enabled: b.enabled === undefined ? cur.enabled : !!b.enabled,
    retry_mode: pick(b.retry_mode ?? cur.retry_mode, ['stripe', 'own'], 'stripe'),
    retry_days: b.retry_days === undefined ? cur.retry_days : days(b.retry_days, cur.retry_days),
    reminder_days: b.reminder_days === undefined ? cur.reminder_days : days(b.reminder_days, cur.reminder_days),
    send_sms: b.send_sms === undefined ? cur.send_sms : !!b.send_sms,
    final_after_days: b.final_after_days === undefined ? cur.final_after_days : intIn(b.final_after_days, 0, 90, cur.final_after_days),
    access_on_final: pick(b.access_on_final ?? cur.access_on_final, ['pause', 'keep'], 'pause'),
    cancel_on_final: b.cancel_on_final === undefined ? cur.cancel_on_final : !!b.cancel_on_final,
    billing_method: pick(b.billing_method ?? cur.billing_method, ['setup', 'portal'], 'setup'),
    link_days: b.link_days === undefined ? cur.link_days : intIn(b.link_days, 1, 90, cur.link_days),
    email_subject: text(b.email_subject ?? cur.email_subject, DEFAULT_SUB.email_subject, 300),
    email_body: text(b.email_body ?? cur.email_body, DEFAULT_SUB.email_body, 10_000),
    reminder_subject: text(b.reminder_subject ?? cur.reminder_subject, DEFAULT_SUB.reminder_subject, 300),
    reminder_body: text(b.reminder_body ?? cur.reminder_body, DEFAULT_SUB.reminder_body, 10_000),
    final_subject: text(b.final_subject ?? cur.final_subject, DEFAULT_SUB.final_subject, 300),
    final_body: text(b.final_body ?? cur.final_body, DEFAULT_SUB.final_body, 10_000),
    sms_body: text(b.sms_body ?? cur.sms_body, DEFAULT_SUB.sms_body, 480),
  };
}

export function cleanLevels(v: unknown, cur: Level[] = DEFAULT_LEVELS): Level[] {
  if (!Array.isArray(v)) return cur;
  if (v.length < 1 || v.length > 4) throw bad('Mahnstufen: 1 bis 4');
  let last = -1;
  const keys = new Set<string>();
  return v.map((raw: any, i) => {
    const base = cur[i] ?? DEFAULT_LEVELS[Math.min(i, DEFAULT_LEVELS.length - 1)];
    const d = intIn(raw?.days, 0, 365, base.days);
    if (d <= last) throw bad('Mahnstufen: die Tage nach Fälligkeit müssen von Stufe zu Stufe wachsen');
    last = d;
    let key = String(raw?.key ?? base.key).replace(/[^a-z0-9_]/gi, '').toLowerCase().slice(0, 30) || `level${i + 1}`;
    while (keys.has(key)) key = `${key}${i}`;
    keys.add(key);
    return {
      key,
      label: String(raw?.label ?? base.label).trim().slice(0, 60) || base.label,
      days: d,
      fee_cents: intIn(raw?.fee_cents, 0, 100_000, base.fee_cents),
      deadline_days: intIn(raw?.deadline_days, 1, 60, base.deadline_days),
      subject: text(raw?.subject, base.subject, 300),
      body: text(raw?.body, base.body, 10_000),
    };
  });
}

export function cleanInv(v: any, cur: InvSettings = DEFAULT_INV): InvSettings {
  const b = v && typeof v === 'object' ? v : {};
  const levels = cleanLevels(b.levels, cur.levels);
  const it = b.interest && typeof b.interest === 'object' ? b.interest : {};
  const rate = it.base_rate === undefined ? cur.interest.base_rate : Number(String(it.base_rate).replace(',', '.'));
  if (!Number.isFinite(rate) || rate < -2 || rate > 20) throw bad('Basiszinssatz: zwischen −2 und 20 Prozent');
  const mode = b.mode ?? cur.mode;
  if (!['off', 'approval', 'auto'].includes(mode)) throw bad('Modus: off, approval oder auto');
  return {
    mode,
    levels,
    interest: {
      enabled: it.enabled === undefined ? cur.interest.enabled : !!it.enabled,
      base_rate: Math.round(rate * 1000) / 1000,
      b2c_margin: intIn(it.b2c_margin, 0, 20, cur.interest.b2c_margin),
      b2b_margin: intIn(it.b2b_margin, 0, 20, cur.interest.b2b_margin),
      from_level: intIn(it.from_level, 1, levels.length, Math.min(cur.interest.from_level, levels.length)),
      customer_type: ['auto', 'b2c', 'b2b'].includes(it.customer_type) ? it.customer_type : cur.interest.customer_type,
    },
    b2b_flat_fee_cents: b.b2b_flat_fee_cents === undefined ? cur.b2b_flat_fee_cents : intIn(b.b2b_flat_fee_cents, 0, 100_000, cur.b2b_flat_fee_cents),
    flat_fee_from_level: intIn(b.flat_fee_from_level, 1, levels.length, Math.min(cur.flat_fee_from_level, levels.length)),
    carry_fees: b.carry_fees === undefined ? cur.carry_fees !== false : !!b.carry_fees,
    min_gap_days: intIn(b.min_gap_days, 0, 60, cur.min_gap_days),
    min_amount_cents: intIn(b.min_amount_cents, 0, 1_000_000, cur.min_amount_cents),
    sms: b.sms === undefined ? cur.sms : !!b.sms,
  };
}

export function cleanSettings(v: any, cur: DunningSettings = defaults()): DunningSettings {
  return { sub: cleanSub(v?.sub, cur.sub), inv: cleanInv(v?.inv, cur.inv) };
}

export const defaults = (): DunningSettings => ({ sub: { ...DEFAULT_SUB }, inv: { ...DEFAULT_INV, levels: DEFAULT_LEVELS.map((l) => ({ ...l })), interest: { ...DEFAULT_INV.interest } } });

// --- maths -------------------------------------------------------------------------------------------------

const DAY = 864e5;


/**
 * Default interest (§ 288 BGB): base rate + 5 percentage points (consumers) or + 9 (business to business), for the days since
 * the due date, in cents. `principal` is the open gross amount; negative rates never reduce the claim below zero.
 */
export function interestCents(principal: number, basePct: number, marginPct: number, days: number): number {
  const rate = Math.max(0, basePct + marginPct);
  if (principal <= 0 || days <= 0 || rate <= 0) return 0;
  return Math.round((principal * (rate / 100) * days) / 365);
}

export const isBusiness = (contact: { company?: string | null } | undefined, type: InvSettings['interest']['customer_type']) => (type === 'auto' ? !!String(contact?.company ?? '').trim() : type === 'b2b');

export interface NoticeAmounts {
  principal_cents: number;
  /** Fees of the earlier notices of this invoice that were sent (still owed; 0 when `carry_fees` is off). */
  prior_fee_cents: number;
  fee_cents: number;
  interest_cents: number;
  flat_fee_cents: number;
  total_cents: number;
  rate: number;
  days: number;
  business: boolean;
}

/** What the notice of level `index` (0-based) claims for an invoice. */
export function noticeAmounts(s: InvSettings, index: number, o: { principal_cents: number; due_at: string; at?: Date; company?: string | null; tz?: string; prior_fee_cents?: number }): NoticeAmounts {
  const level = s.levels[index];
  const business = isBusiness({ company: o.company }, s.interest.customer_type);
  // calendar days in the sub-account's zone (interest runs per day from the day after the due date)
  const days = daysOverdue(o.due_at, o.at, o.tz);
  const withInterest = s.interest.enabled && index + 1 >= s.interest.from_level;
  const margin = business ? s.interest.b2b_margin : s.interest.b2c_margin;
  const interest = withInterest ? interestCents(o.principal_cents, s.interest.base_rate, margin, days) : 0;
  const flat = business && index + 1 >= s.flat_fee_from_level ? s.b2b_flat_fee_cents : 0;
  const fee = level?.fee_cents ?? 0;
  // interest runs on the invoice only, never on fees; the § 288 Abs. 5 flat fee is in each notice once (not carried)
  const prior = s.carry_fees !== false ? Math.max(0, Math.round(Number(o.prior_fee_cents) || 0)) : 0;
  return { principal_cents: o.principal_cents, prior_fee_cents: prior, fee_cents: fee, interest_cents: interest, flat_fee_cents: flat, total_cents: o.principal_cents + prior + fee + interest + flat, rate: Math.max(0, s.interest.base_rate + margin), days, business };
}

/**
 * Which level an overdue invoice needs next: the highest level whose day has come, but only one step beyond the last notice
 * (never skipping a level), and not before `min_gap_days` calendar days after the last one – days of the sub-account's zone like
 * the days overdue, so a notice sent at 23:00 on the 1st allows the next one from midnight on the 4th with a gap of 3 (24-hour
 * blocks held it back until 23:00). Returns the 0-based index or null.
 */
export function nextLevel(s: InvSettings, o: { due_at: string; last_level: number; last_sent_at?: string | null; at?: Date; tz?: string }): number | null {
  const at = o.at ?? new Date();
  const overdue = daysOverdue(o.due_at, at, o.tz);
  const next = o.last_level; // levels are 1-based in the notices: after level n comes index n
  const level = s.levels[next];
  if (!level || overdue < level.days) return null;
  if (o.last_sent_at && calendarDaysBetween(o.last_sent_at, at, o.tz) < s.min_gap_days) return null;
  return next;
}

/** The date by which the customer has to pay after a notice sent at `at`. */
export const deadlineOf = (level: Level, at: Date = new Date()) => new Date(at.getTime() + level.deadline_days * DAY);
