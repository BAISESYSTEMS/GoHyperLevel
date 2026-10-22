/**
 * Rules for running campaigns: "pause when the cost per lead is above X". A rule can only stop spending (pause) or
 * tell someone (notify) – never start a campaign or raise a budget. Pure evaluation here; the module runs it.
 */

export const RULE_METRICS = ['cpl', 'cpc', 'ctr', 'spend', 'leads'] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];
export const RULE_LABEL: Record<RuleMetric, string> = { cpl: 'Kosten pro Lead', cpc: 'Kosten pro Klick', ctr: 'Klickrate (CTR)', spend: 'Ausgaben', leads: 'Leads' };
export const RULE_ACTIONS = ['pause', 'notify'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface Rule {
  id: string;
  name: string;
  platform: 'all' | 'meta' | 'google';
  campaign_ref: string;
  metric: RuleMetric;
  op: '>' | '<';
  /** Cents for cpl, cpc and spend; percent for ctr; a count for leads. */
  value: number;
  window_days: number;
  min_spend_cents: number;
  action: RuleAction;
  enabled: number;
}

export interface Numbers {
  spend_cents: number;
  impressions: number;
  clicks: number;
  platform_leads: number;
  crm_leads: number;
}

/** The leads that count: the CRM's (attribution) when it has any, else what the platform reports. */
export const leadsOf = (n: Numbers) => (n.crm_leads > 0 ? n.crm_leads : n.platform_leads);

/**
 * The metric's value for the window, or null when it cannot be told yet (no clicks, too few impressions).
 * Cost per lead with no lead yet is the spend so far: "paused when CPL > 30 €" also catches 30 € without a lead.
 */
export function metricValue(metric: RuleMetric, n: Numbers): number | null {
  switch (metric) {
    case 'cpl': {
      const l = leadsOf(n);
      return n.spend_cents > 0 ? n.spend_cents / Math.max(l, 1) : null;
    }
    case 'cpc':
      return n.clicks > 0 ? n.spend_cents / n.clicks : null;
    case 'ctr':
      return n.impressions >= 500 ? (n.clicks / n.impressions) * 100 : null;
    case 'spend':
      return n.spend_cents;
    case 'leads':
      return leadsOf(n);
  }
}

export function evaluate(rule: Pick<Rule, 'metric' | 'op' | 'value' | 'min_spend_cents'>, n: Numbers): { hit: boolean; value: number | null } {
  const value = metricValue(rule.metric, n);
  if (value === null) return { hit: false, value };
  // Not enough money spent to judge a campaign.
  if (n.spend_cents < rule.min_spend_cents) return { hit: false, value };
  // "Fewer than 1 lead" is judged by the count, "CPL below X" only makes sense with leads.
  if (rule.metric === 'cpl' && rule.op === '<' && leadsOf(n) === 0) return { hit: false, value };
  return { hit: rule.op === '>' ? value > rule.value : value < rule.value, value };
}

export function describeRule(r: Pick<Rule, 'metric' | 'op' | 'value' | 'window_days' | 'min_spend_cents' | 'action'>, currency = 'EUR'): string {
  const money = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency });
  const v = r.metric === 'ctr' ? `${r.value.toLocaleString('de-DE')} %` : r.metric === 'leads' ? String(r.value) : money(r.value);
  const act = r.action === 'pause' ? 'pausieren' : 'benachrichtigen';
  return `${RULE_LABEL[r.metric]} ${r.op === '>' ? 'über' : 'unter'} ${v} (letzte ${r.window_days} Tage${r.min_spend_cents ? `, ab ${money(r.min_spend_cents)} Ausgaben` : ''}) → ${act}`;
}

/** Cleans a rule from a request; throws a plain German message. */
export function cleanRule(b: any, fail: (msg: string) => Error): Omit<Rule, 'id' | 'enabled'> {
  const metric = String(b?.metric ?? '') as RuleMetric;
  if (!RULE_METRICS.includes(metric)) throw fail('Kennzahl: cpl, cpc, ctr, spend oder leads');
  const op = b?.op === '<' ? '<' : b?.op === '>' ? '>' : '';
  if (!op) throw fail('Bedingung: > oder <');
  const value = Number(b?.value);
  if (!Number.isFinite(value) || value < 0 || value > 1e9) throw fail('Schwellenwert fehlt');
  const action = (RULE_ACTIONS as readonly string[]).includes(b?.action) ? (b.action as RuleAction) : 'pause';
  const window = Math.round(Number(b?.window_days ?? 3));
  if (!(window >= 1 && window <= 30)) throw fail('Zeitraum: 1 bis 30 Tage');
  const platform = b?.platform === 'meta' || b?.platform === 'google' ? b.platform : 'all';
  const ref = String(b?.campaign_ref ?? '').trim();
  if (ref && !/^([\w-]{8,40}|(meta|google):\d{3,25})$/.test(ref)) throw fail('Kampagne ungültig');
  return {
    name: String(b?.name ?? '').trim().slice(0, 100) || `${RULE_LABEL[metric]} ${op} ${value}`,
    platform,
    campaign_ref: ref,
    metric,
    op,
    value,
    window_days: window,
    min_spend_cents: Math.max(0, Math.round(Number(b?.min_spend_cents ?? 0)) || 0),
    action,
  };
}
