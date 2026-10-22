import type { App } from '../core/app.js';
import { bad } from '../core/http.js';
import { sha256 } from '../core/util.js';
import { MIN_VISITORS, summarize, type VariantResult } from './ab-stats.js';
import { paidRevenueSql } from './invoice-model.js';
import { designFields } from './email-design.js';

/**
 * A/B tests for campaigns. Variants differ in subject (always), and optionally in content and sender name. A share of the audience
 * (the test share, 5–50 %) is split evenly across the variants; the rest waits. After the waiting time the variant that did best on
 * the chosen measure – human opens, human clicks or revenue; machine opens never count – goes to everybody who waited.
 * Pure logic first (config, split, winner), then the numbers from the database. The sending loop is in services/campaign-run.ts.
 */

export const AB_KEYS = ['A', 'B', 'C', 'D'] as const;
export const METRICS = ['opens', 'clicks', 'revenue'] as const;
export type AbMetric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<AbMetric, string> = { opens: 'Öffnungen', clicks: 'Klicks', revenue: 'Umsatz' };

export const MIN_TEST_PERCENT = 5;
export const MAX_TEST_PERCENT = 50;
export const DEFAULT_TEST_PERCENT = 20;
export const MAX_WAIT_HOURS = 336;
export const DEFAULT_WAIT_HOURS = 24;
/** A purchase counts for a mail when it is paid within this many days after it. */
export const REVENUE_DAYS = 14;

export interface AbVariant {
  key: string;
  /** Empty = the campaign's own subject (variant A always). */
  subject?: string;
  sender_name?: string;
  /** Own content (design rendered on save, like campaigns do); empty = the campaign's content. */
  design?: unknown;
  body?: string;
  body_text?: string;
  is_html?: number;
}

export interface AbConfig {
  enabled: boolean;
  variants: AbVariant[];
  test_percent: number;
  metric: AbMetric;
  wait_hours: number;
  /** testing → waiting (test mails are out, the clock runs) → winner (the rest is sending) */
  phase?: 'test' | 'waiting' | 'winner';
  decide_at?: string | null;
  winner?: string | null;
  decided_at?: string | null;
  decided_by?: 'auto' | 'manual' | 'fallback' | null;
  decided_reason?: string | null;
  /** Numbers at the moment of the decision. */
  snapshot?: VariantStats[] | null;
  /** Why no test was run (too few recipients). */
  skipped?: string | null;
}

export interface VariantStats {
  key: string;
  sent: number;
  opened: number;
  clicked: number;
  buyers: number;
  revenue_cents: number;
}

const text = (v: unknown, max: number) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, max);
const clampInt = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Sender names go into the From header: no quotes, brackets or line breaks. */
export const cleanSender = (v: unknown) => String(v ?? '').replace(/["\\<>\r\n\u2028\u2029]/g, '').trim().slice(0, 100);

/**
 * The test setup from the browser or API, checked and normalised (German errors). `null` / `enabled: false` turns it off.
 * Variants B–D must differ from A in something: subject, sender name or content.
 */
export function cleanAbConfig(input: unknown, campaign: { channel: string; subject?: string }): AbConfig | null {
  if (input === null || input === undefined || input === false) return null;
  if (typeof input !== 'object') throw bad('A/B-Test: ungültige Angaben');
  const o = input as Record<string, any>;
  if (o.enabled === false) return null;
  if (campaign.channel !== 'email') throw bad('A/B-Tests gibt es nur für E-Mail-Kampagnen');
  const list = Array.isArray(o.variants) ? o.variants.slice(0, AB_KEYS.length) : [];
  if (list.length < 2) throw bad('A/B-Test: mindestens zwei Varianten (A und B)');
  const metric: AbMetric = METRICS.includes(o.metric) ? o.metric : 'opens';
  const variants: AbVariant[] = list.map((raw: any, i: number) => {
    const key = AB_KEYS[i];
    const v: AbVariant = { key };
    if (i === 0) return v;
    const subject = text(raw?.subject, 300);
    const sender = cleanSender(raw?.sender_name);
    if (subject) v.subject = subject;
    if (sender) v.sender_name = sender;
    if (raw?.design && (typeof raw.design === 'object' || (typeof raw.design === 'string' && raw.design.trim()))) {
      const f = designFields(raw.design);
      Object.assign(v, { design: f.design, body: f.body, body_text: f.body_text, is_html: 1 });
    } else if (typeof raw?.body === 'string' && raw.body.trim()) {
      v.body = raw.body.slice(0, 200_000);
      v.body_text = text(raw.body_text, 200_000);
      v.is_html = raw.is_html ? 1 : 0;
    }
    return v;
  });
  for (const v of variants.slice(1)) {
    const same = (!v.subject || v.subject === (campaign.subject ?? '')) && !v.sender_name && !v.body;
    if (same) throw bad(`A/B-Test: Variante ${v.key} unterscheidet sich nicht von A – Betreff, Absendername oder Inhalt ändern`);
  }
  return {
    enabled: true,
    variants,
    test_percent: clampInt(o.test_percent, MIN_TEST_PERCENT, MAX_TEST_PERCENT, DEFAULT_TEST_PERCENT),
    metric,
    wait_hours: clampInt(o.wait_hours, 1, MAX_WAIT_HOURS, DEFAULT_WAIT_HOURS),
  };
}

// --- the split -------------------------------------------------------------------------------------------

export interface Split {
  /** contact id → variant key (the test share) */
  test: Map<string, string>;
  /** the rest, waiting for the winner */
  held: string[];
  /** Set when no test is possible (then everybody gets the normal mail). */
  skipped?: string;
}

/**
 * Splits an audience: the test share evenly over the variants (round robin over a deterministic shuffle, so the groups are
 * random but a restart gives the same result), the rest is held back. Needs at least two contacts per variant.
 */
export function planSplit(ids: string[], keys: string[], percent: number, seed: string): Split {
  const k = keys.length;
  const n = ids.length;
  if (k < 2) return { test: new Map(), held: [], skipped: 'Weniger als zwei Varianten' };
  if (n < k * 2) return { test: new Map(), held: [], skipped: `Zu wenige Empfänger für einen Test (mindestens ${k * 2})` };
  const shuffled = ids.map((id) => [sha256(`${seed}:${id}`), id] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]);
  const testCount = Math.min(n - 1, Math.max(k, Math.round((n * percent) / 100)));
  const test = new Map<string, string>();
  shuffled.slice(0, testCount).forEach((id, i) => test.set(id, keys[i % k]));
  return { test, held: shuffled.slice(testCount) };
}

// --- the winner ------------------------------------------------------------------------------------------

/** The measure of one variant: events (or euros) per recipient. */
export function metricValue(v: VariantStats, metric: AbMetric): number {
  if (v.sent <= 0) return 0;
  return (metric === 'opens' ? v.opened : metric === 'clicks' ? v.clicked : v.revenue_cents) / v.sent;
}

export interface Pick {
  winner: string;
  reason: 'best' | 'tie' | 'no_data';
  values: Record<string, number>;
}

/**
 * The winner: the highest value of the chosen measure per recipient. A tie goes to the variant that is better on the next
 * measure (opens → clicks, clicks → opens, revenue → clicks → opens), then to the lower key (A, the original). Without a single
 * event the original wins ("no_data") – there is nothing to learn from.
 */
export function pickWinner(stats: VariantStats[], metric: AbMetric): Pick {
  const live = stats.filter((s) => s.sent > 0);
  const pool = live.length ? live : stats;
  const values = Object.fromEntries(stats.map((s) => [s.key, metricValue(s, metric)]));
  const top = Math.max(...pool.map((s) => values[s.key]));
  if (!(top > 0)) return { winner: [...pool].sort((a, b) => a.key.localeCompare(b.key))[0]?.key ?? 'A', reason: 'no_data', values };
  const second: AbMetric[] = metric === 'opens' ? ['clicks'] : metric === 'clicks' ? ['opens'] : ['clicks', 'opens'];
  let tied = pool.filter((s) => Math.abs(values[s.key] - top) < 1e-12);
  const reason: Pick['reason'] = tied.length > 1 ? 'tie' : 'best';
  for (const m of second) {
    if (tied.length < 2) break;
    const best = Math.max(...tied.map((s) => metricValue(s, m)));
    tied = tied.filter((s) => Math.abs(metricValue(s, m) - best) < 1e-12);
  }
  return { winner: [...tied].sort((a, b) => a.key.localeCompare(b.key))[0].key, reason, values };
}

// --- the numbers -----------------------------------------------------------------------------------------

/** Per variant: mails sent, opened and clicked by people, buyers and revenue within the window after the mail. */
export function abStats(app: App, campaignId: string, locationId: string): VariantStats[] {
  const { db } = app;
  const out = new Map<string, VariantStats>();
  const at = (key: string) => {
    if (!out.has(key)) out.set(key, { key, sent: 0, opened: 0, clicked: 0, buyers: 0, revenue_cents: 0 });
    return out.get(key)!;
  };
  for (const r of db.all(
    `SELECT r.variant AS k, COUNT(*) AS sent, SUM(CASE WHEN m.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened, SUM(CASE WHEN m.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
     FROM campaign_recipients r JOIN messages m ON m.id = r.message_id JOIN campaigns k ON k.id = r.campaign_id
     WHERE r.campaign_id = ? AND k.location_id = ? AND r.variant != '' AND r.status = 'sent' GROUP BY r.variant`,
    campaignId,
    locationId,
  )) Object.assign(at(String(r.k)), { sent: Number(r.sent), opened: Number(r.opened), clicked: Number(r.clicked) });
  for (const r of db.all(
    `SELECT r.variant AS k, COUNT(DISTINCT r.contact_id) AS buyers, SUM(${paidRevenueSql('i.')}) AS revenue
     FROM campaign_recipients r JOIN campaigns k ON k.id = r.campaign_id
     JOIN invoices i ON i.contact_id = r.contact_id AND i.location_id = k.location_id AND i.kind = 'invoice' AND i.status = 'paid' AND i.paid_at >= r.sent_at AND i.paid_at <= strftime('%Y-%m-%dT%H:%M:%fZ', r.sent_at, '+${REVENUE_DAYS} days')
     WHERE r.campaign_id = ? AND k.location_id = ? AND r.variant != '' AND r.status = 'sent' GROUP BY r.variant`,
    campaignId,
    locationId,
  )) Object.assign(at(String(r.k)), { buyers: Number(r.buyers), revenue_cents: Number(r.revenue) || 0 });
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface AbResultVariant extends VariantStats {
  subject: string;
  sender_name: string;
  own_content: boolean;
  open_rate: number;
  click_rate: number;
  revenue_per_recipient_cents: number;
  is_winner: boolean;
  verdict: VariantResult['verdict'];
  prob_beat: number | null;
  significant: boolean;
}

export interface AbResults {
  enabled: boolean;
  phase: AbConfig['phase'] | null;
  metric: AbMetric;
  metric_label: string;
  wait_hours: number;
  test_percent: number;
  decide_at: string | null;
  winner: string | null;
  decided_by: AbConfig['decided_by'];
  decided_reason: string | null;
  skipped: string | null;
  held: number;
  variants: AbResultVariant[];
  /** Variant with a statistically safe lead (95 %), if any. */
  leader: string | null;
  small_sample: boolean;
  /** The measure's current best variant, safe or not. */
  best_now: string | null;
  note: string;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** The results view: numbers, rates, significance against variant A, and where the test stands. */
export function abResults(app: App, campaign: { id: string; location_id: string; subject: string; ab?: AbConfig | null }): AbResults | null {
  const cfg = campaign.ab;
  if (!cfg?.enabled) return null;
  const live = abStats(app, campaign.id, campaign.location_id);
  const stats: VariantStats[] = cfg.variants.map((v) => live.find((s) => s.key === v.key) ?? { key: v.key, sent: 0, opened: 0, clicked: 0, buyers: 0, revenue_cents: 0 });
  const counts = stats.map((s) => ({ id: s.key, key: s.key, is_control: s.key === 'A', visitors: s.sent, conversions: cfg.metric === 'opens' ? s.opened : cfg.metric === 'clicks' ? s.clicked : s.buyers }));
  const sum = summarize(counts);
  const held = Number(app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? AND status = 'held'`, campaign.id)?.n ?? 0);
  const bestNow = stats.some((s) => s.sent > 0) ? pickWinner(stats, cfg.metric) : null;
  const variants: AbResultVariant[] = cfg.variants.map((v, i) => {
    const s = stats[i];
    const r = sum.variants[i];
    return {
      ...s,
      subject: v.subject || campaign.subject,
      sender_name: v.sender_name ?? '',
      own_content: !!v.body,
      open_rate: pct(s.opened, s.sent),
      click_rate: pct(s.clicked, s.sent),
      revenue_per_recipient_cents: s.sent ? Math.round(s.revenue_cents / s.sent) : 0,
      is_winner: cfg.winner === v.key,
      verdict: r.verdict,
      prob_beat: r.prob_beat,
      significant: r.significant,
    };
  });
  const note =
    cfg.phase === 'winner'
      ? `Gewinner: Variante ${cfg.winner}${cfg.decided_by === 'manual' ? ' (von dir gewählt)' : cfg.decided_by === 'fallback' ? ' (keine Daten – die Originalversion geht raus)' : ''}.`
      : cfg.phase === 'waiting'
        ? `Testversand abgeschlossen – die Entscheidung fällt ${cfg.decide_at ? `am ${new Date(cfg.decide_at).toLocaleString('de-DE', { timeZone: app.location(campaign.location_id)?.timezone ?? 'Europe/Berlin' })}` : 'nach der Wartezeit'}.`
        : cfg.skipped
          ? cfg.skipped
          : 'Der Test startet mit dem Versand.';
  return {
    enabled: true,
    phase: cfg.phase ?? null,
    metric: cfg.metric,
    metric_label: METRIC_LABEL[cfg.metric],
    wait_hours: cfg.wait_hours,
    test_percent: cfg.test_percent,
    decide_at: cfg.decide_at ?? null,
    winner: cfg.winner ?? null,
    decided_by: cfg.decided_by ?? null,
    decided_reason: cfg.decided_reason ?? null,
    skipped: cfg.skipped ?? null,
    held,
    variants,
    leader: sum.leader,
    small_sample: sum.small_sample || stats.some((s) => s.sent < MIN_VISITORS),
    best_now: bestNow?.winner ?? null,
    note,
  };
}

/** What a mail of this variant is made of: the variant's own parts where it has them, the campaign's otherwise. */
export function variantContent<T extends { subject: string; body: string; body_text?: string; is_html?: number; sender_name?: string | null; ab?: AbConfig | null }>(
  campaign: T,
  key: string,
): { subject: string; body: string; body_text: string; is_html: number; sender_name: string } {
  const v = campaign.ab?.enabled ? campaign.ab.variants.find((x) => x.key === key) : undefined;
  return {
    subject: v?.subject || campaign.subject,
    body: v?.body ?? campaign.body,
    body_text: v?.body !== undefined ? (v.body_text ?? '') : (campaign.body_text ?? ''),
    is_html: v?.body !== undefined ? (v.is_html ? 1 : 0) : campaign.is_html ? 1 : 0,
    sender_name: v?.sender_name ?? campaign.sender_name ?? '',
  };
}
