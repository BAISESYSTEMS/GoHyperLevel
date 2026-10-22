import { bad, num } from '../core/http.js';

/**
 * Customer health score: weighted signals (tickets, satisfaction, activity, invoices, deals,
 * engagement) turned into 0–100 with a traffic light. Pure – the module gathers the inputs.
 */

export const HEALTH_SIGNALS = ['open_tickets', 'overdue_tickets', 'csat', 'nps', 'activity', 'overdue_invoices', 'deals', 'engagement'] as const;
export type HealthSignal = (typeof HEALTH_SIGNALS)[number];
export type Band = 'green' | 'yellow' | 'red';

export const SIGNAL_LABELS: Record<HealthSignal, string> = {
  open_tickets: 'Offene Tickets',
  overdue_tickets: 'Überfällige Tickets (SLA)',
  csat: 'Letzte Zufriedenheit (CSAT)',
  nps: 'Letzter NPS',
  activity: 'Tage seit letzter Aktivität',
  overdue_invoices: 'Überfällige Rechnungen',
  deals: 'Deal-Status',
  engagement: 'E-Mail-Engagement (Öffnungen/Klicks)',
};

export interface HealthConfig {
  enabled: boolean;
  weights: Record<HealthSignal, number>;
  /** Score from which the light is green / yellow (below = red). */
  green: number;
  yellow: number;
  /** A drop by this many points also counts as "gesunken" (besides a worse colour). */
  drop_points: number;
  /** After this many days without activity the activity signal is 0. */
  activity_days: number;
}

export function defaultHealthConfig(): HealthConfig {
  return {
    enabled: true,
    weights: { open_tickets: 15, overdue_tickets: 20, csat: 20, nps: 10, activity: 15, overdue_invoices: 10, deals: 5, engagement: 5 },
    green: 70,
    yellow: 40,
    drop_points: 15,
    activity_days: 90,
  };
}

export function cleanHealthConfig(b: any, cur: HealthConfig): HealthConfig {
  const out: HealthConfig = { ...cur, weights: { ...cur.weights } };
  if (!b || typeof b !== 'object') return out;
  if (b.enabled !== undefined) out.enabled = b.enabled === true || b.enabled === 'true';
  if (b.weights && typeof b.weights === 'object') {
    for (const k of HEALTH_SIGNALS) {
      if (b.weights[k] === undefined) continue;
      const v = Math.round(num(b.weights[k], NaN));
      if (!Number.isFinite(v) || v < 0 || v > 100) throw bad('Gewichte zwischen 0 und 100');
      out.weights[k] = v;
    }
  }
  const range = (k: 'green' | 'yellow' | 'drop_points' | 'activity_days', min: number, max: number, label: string) => {
    if (b[k] === undefined) return;
    const v = Math.round(num(b[k], NaN));
    if (!Number.isFinite(v) || v < min || v > max) throw bad(`${label}: ${min} bis ${max}`);
    out[k] = v;
  };
  range('green', 1, 100, 'Grün ab');
  range('yellow', 0, 99, 'Gelb ab');
  range('drop_points', 1, 100, 'Abfall in Punkten');
  range('activity_days', 8, 3650, 'Tage ohne Aktivität');
  if (out.yellow >= out.green) throw bad('„Gelb ab“ muss kleiner sein als „Grün ab“');
  if (!HEALTH_SIGNALS.some((k) => out.weights[k] > 0)) throw bad('Mindestens ein Signal braucht ein Gewicht');
  return out;
}

export interface HealthInput {
  openTickets: number;
  overdueTickets: number;
  /** 1–5, null = never asked. */
  lastCsat: number | null;
  /** 0–10, null = never answered. */
  lastNps: number | null;
  daysSinceActivity: number | null;
  overdueInvoices: number;
  dealStatus: 'won' | 'open' | 'lost' | null;
  emailsSent: number;
  emailsEngaged: number;
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** Each signal as 0–100 (null = no data, left out of the average). */
export function signalScores(i: HealthInput, cfg: HealthConfig): Record<HealthSignal, number | null> {
  const days = i.daysSinceActivity;
  return {
    open_tickets: clamp(100 - 25 * Math.max(0, i.openTickets)),
    overdue_tickets: clamp(100 - 50 * Math.max(0, i.overdueTickets)),
    csat: i.lastCsat === null ? null : clamp(((i.lastCsat - 1) / 4) * 100),
    nps: i.lastNps === null ? null : clamp(i.lastNps * 10),
    activity: days === null ? null : days <= 7 ? 100 : clamp(100 * (1 - (days - 7) / Math.max(1, cfg.activity_days - 7))),
    overdue_invoices: clamp(100 - 50 * Math.max(0, i.overdueInvoices)),
    deals: i.dealStatus === 'won' ? 100 : i.dealStatus === 'open' ? 70 : i.dealStatus === 'lost' ? 20 : null,
    // An open/click rate of 50 % or more counts as fully engaged.
    engagement: i.emailsSent > 0 ? clamp((i.emailsEngaged / i.emailsSent) * 200) : null,
  };
}

export function bandOf(score: number, cfg: Pick<HealthConfig, 'green' | 'yellow'>): Band {
  return score >= cfg.green ? 'green' : score >= cfg.yellow ? 'yellow' : 'red';
}

/** Weighted average of the signals that have data, 0–100, plus the traffic light. */
export function computeHealth(i: HealthInput, cfg: HealthConfig): { score: number; band: Band; signals: Record<HealthSignal, number | null> } {
  const signals = signalScores(i, cfg);
  let sum = 0;
  let weight = 0;
  for (const k of HEALTH_SIGNALS) {
    const s = signals[k];
    const w = cfg.weights[k] ?? 0;
    if (s === null || w <= 0) continue;
    sum += s * w;
    weight += w;
  }
  const score = weight ? Math.round(sum / weight) : 50;
  return { score, band: bandOf(score, cfg), signals };
}

const RANK: Record<Band, number> = { red: 0, yellow: 1, green: 2 };

/** "Health-Score gesunken": a worse colour, or a drop of at least `drop_points`. */
export function healthDropped(prev: { score: number; band: Band } | null | undefined, next: { score: number; band: Band }, cfg: Pick<HealthConfig, 'drop_points'>): boolean {
  if (!prev) return false;
  return RANK[next.band] < RANK[prev.band] || prev.score - next.score >= cfg.drop_points;
}
