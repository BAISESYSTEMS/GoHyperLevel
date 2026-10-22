/**
 * Lead scoring like HubSpot's: points for properties (fit: contact fields, custom fields, tags,
 * source/attribution, properties of associated companies) and for engagement (opens, clicks,
 * forms, visits, bookings, inbound messages, deals), optional caps per rule, decay after
 * inactivity and thresholds with a label (e.g. MQL ≥ 50, SQL ≥ 80). Pure functions; the module
 * gathers the data.
 */

export const SCORE_EVENTS = {
  'email.opened': 'E-Mail geöffnet',
  'email.clicked': 'Link in E-Mail geklickt',
  'form.submitted': 'Formular ausgefüllt',
  'page.visited': 'Seitenbesuch (Attribution)',
  'appointment.booked': 'Termin gebucht',
  'message.inbound': 'Nachricht erhalten (jeder Kanal)',
  'chat.inbound': 'Live-Chat-Nachricht',
  'whatsapp.inbound': 'WhatsApp-Nachricht',
  'sms.inbound': 'SMS erhalten',
  'email.inbound': 'E-Mail-Antwort erhalten',
  'call.completed': 'Telefonat geführt',
  'opportunity.created': 'Deal angelegt',
} as const;
export type ScoreEvent = keyof typeof SCORE_EVENTS;

export const SCORE_OPS = ['has', 'not_has', 'equals', 'not_equals', 'contains', 'empty', 'not_empty', 'gt', 'lt'] as const;
export type ScoreOp = (typeof SCORE_OPS)[number];

export interface ScoreRule {
  id: string;
  kind: 'property' | 'event';
  label: string;
  points: number;
  field?: string;
  op?: ScoreOp;
  value?: string;
  event?: ScoreEvent;
  within_days?: number;
  max_points?: number;
}
export interface Threshold {
  label: string;
  min: number;
}
export interface Decay {
  percent: number;
  days: number;
}
export interface ScoreModel {
  rules: ScoreRule[];
  thresholds: Threshold[];
  decay: Decay;
  max_score: number | null;
}
export interface BreakdownItem {
  rule: string;
  label: string;
  points: number;
  count?: number;
}

const FIELD_RE = /^(tag|[a-z_]+|custom\.[a-z0-9_]+|company\.([a-z_]+|custom\.[a-z0-9_]+)|attribution\.(first|last)_(source|medium|campaign)|attribution\.touches)$/;

export class ScoreError extends Error {}
const fail = (m: string) => new ScoreError(m);
const int = (v: unknown, lo: number, hi: number, what: string) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) throw fail(`${what}: Zahl von ${lo} bis ${hi}`);
  return n;
};

/** Checks a model's settings from the API; ids of rules are kept or made up. */
export function cleanModel(input: any, makeId: () => string): ScoreModel {
  const rulesIn = Array.isArray(input?.rules) ? input.rules : [];
  if (rulesIn.length > 100) throw fail('Höchstens 100 Kriterien');
  const rules: ScoreRule[] = rulesIn.map((r: any, i: number) => {
    const kind: ScoreRule['kind'] | null = r?.kind === 'event' ? 'event' : r?.kind === 'property' ? 'property' : null;
    if (!kind) throw fail(`Kriterium ${i + 1}: Art fehlt (Eigenschaft oder Aktivität)`);
    const points = int(r.points, -1000, 1000, `Kriterium ${i + 1}: Punkte`);
    if (!points) throw fail(`Kriterium ${i + 1}: Punkte dürfen nicht 0 sein`);
    const base = { id: typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) ? r.id : makeId(), kind, points, label: String(r.label ?? '').trim().slice(0, 120) };
    if (kind === 'property') {
      const field = String(r.field ?? '').trim();
      if (!FIELD_RE.test(field)) throw fail(`Kriterium ${i + 1}: unbekanntes Feld „${field.slice(0, 60)}“`);
      const op = SCORE_OPS.includes(r.op) ? (r.op as ScoreOp) : field === 'tag' ? 'has' : 'equals';
      const value = String(r.value ?? '').trim().slice(0, 200);
      if (!['empty', 'not_empty'].includes(op) && !value) throw fail(`Kriterium ${i + 1}: Wert fehlt`);
      return { ...base, field, op, value };
    }
    const event = String(r.event ?? '') as ScoreEvent;
    if (!(event in SCORE_EVENTS)) throw fail(`Kriterium ${i + 1}: unbekannte Aktivität`);
    const out: ScoreRule = { ...base, event };
    if (r.within_days !== undefined && r.within_days !== null && r.within_days !== '' && Number(r.within_days) > 0) out.within_days = int(r.within_days, 1, 3650, `Kriterium ${i + 1}: Zeitraum`);
    if (r.max_points !== undefined && r.max_points !== null && r.max_points !== '' && Number(r.max_points) > 0) out.max_points = int(r.max_points, 1, 100000, `Kriterium ${i + 1}: Höchstpunkte`);
    return out;
  });
  const thIn = Array.isArray(input?.thresholds) ? input.thresholds : [];
  if (thIn.length > 10) throw fail('Höchstens 10 Schwellen');
  const thresholds = thIn
    .map((t: any) => {
      const label = String(t?.label ?? '').trim().slice(0, 40);
      if (!label) throw fail('Schwelle: Name fehlt');
      return { label, min: int(t.min, 0, 100000, `Schwelle „${label}“`) };
    })
    .sort((a: Threshold, b: Threshold) => a.min - b.min);
  if (new Set(thresholds.map((t: Threshold) => t.label.toLowerCase())).size !== thresholds.length) throw fail('Schwellen brauchen verschiedene Namen');
  const d = input?.decay ?? {};
  const decay = { percent: d.percent ? int(d.percent, 0, 100, 'Zerfall in %') : 0, days: d.days ? int(d.days, 1, 365, 'Zerfall: Tage') : 30 };
  const max = input?.max_score === null || input?.max_score === undefined || input?.max_score === '' || Number(input.max_score) === 0 ? null : int(input.max_score, 1, 100000, 'Höchstwert');
  return { rules, thresholds, decay, max_score: max };
}

/** Points of an engagement rule for `count` events (capped by max_points, sign kept). */
export function eventPoints(rule: Pick<ScoreRule, 'points' | 'max_points'>, count: number): number {
  const raw = rule.points * count;
  if (!rule.max_points) return raw;
  return Math.sign(raw) * Math.min(Math.abs(raw), rule.max_points);
}

/** −percent per full period of `days` without engagement (positive scores only). */
export function applyDecay(score: number, decay: Decay, lastEngagement: string | null | undefined, now = Date.now()): number {
  if (!decay.percent || score <= 0 || !lastEngagement) return score;
  const t = Date.parse(lastEngagement);
  if (Number.isNaN(t)) return score;
  const periods = Math.floor((now - t) / (decay.days * 864e5));
  if (periods <= 0) return score;
  return score * Math.pow(1 - decay.percent / 100, periods);
}

/** The highest threshold the score reaches ('' below all). */
export function labelFor(score: number, thresholds: Threshold[]): string {
  let out = '';
  for (const t of [...thresholds].sort((a, b) => a.min - b.min)) if (score >= t.min) out = t.label;
  return out;
}

/** Rank of a label in the thresholds (−1 = none) – to tell "reached" from "fell below". */
export const labelRank = (label: string, thresholds: Threshold[]) => [...thresholds].sort((a, b) => a.min - b.min).findIndex((t) => t.label === label);

const FIELD_LABELS: Record<string, string> = {
  source: 'Quelle', email: 'E-Mail', phone: 'Telefon', company: 'Firma', website: 'Webseite', city: 'Ort', postal_code: 'PLZ', country: 'Land',
  first_name: 'Vorname', last_name: 'Nachname', 'company.industry': 'Firma: Branche', 'company.size': 'Firma: Größe', 'company.lifecycle_stage': 'Firma: Phase',
  'company.city': 'Firma: Ort', 'company.country': 'Firma: Land', 'company.domain': 'Firma: Domain', 'attribution.first_source': 'Erste Quelle',
  'attribution.last_source': 'Letzte Quelle', 'attribution.first_medium': 'Erstes Medium', 'attribution.last_medium': 'Letztes Medium',
  'attribution.first_campaign': 'Erste Kampagne', 'attribution.last_campaign': 'Letzte Kampagne', 'attribution.touches': 'Besuche',
};
const OP_LABELS: Record<string, string> = { equals: 'ist', not_equals: 'ist nicht', contains: 'enthält', has: 'enthält', not_has: 'enthält nicht', empty: 'ist leer', not_empty: 'ist nicht leer', gt: 'größer als', lt: 'kleiner als' };

/** Readable name of a rule when it has no own label ("Quelle ist Website", "Tag „vip“"). */
export function describeRule(r: ScoreRule, fieldLabels: Record<string, string> = {}): string {
  if (r.label) return r.label;
  if (r.kind === 'event') return SCORE_EVENTS[r.event!] ?? String(r.event);
  if (r.field === 'tag') return r.op === 'not_has' ? `ohne Tag „${r.value}“` : `Tag „${r.value}“`;
  const f = fieldLabels[r.field!] ?? FIELD_LABELS[r.field!] ?? r.field!.replace(/^(company\.)?custom\./, (m) => (m.startsWith('company') ? 'Firma: ' : ''));
  return `${f} ${OP_LABELS[r.op!] ?? r.op}${['empty', 'not_empty'].includes(r.op!) ? '' : ` ${r.value ?? ''}`}`.trim();
}

/**
 * Final score from rule results: sum, decay, clamp to 0…max. `matches` says per property rule
 * whether it applies, `counts` per event rule how many events count.
 */
export function scoreFrom(model: ScoreModel, matches: Record<string, boolean>, counts: Record<string, number>, lastEngagement: string | null, now = Date.now(), fieldLabels: Record<string, string> = {}) {
  const breakdown: BreakdownItem[] = [];
  let raw = 0;
  for (const r of model.rules) {
    const label = describeRule(r, fieldLabels);
    if (r.kind === 'property') {
      if (!matches[r.id]) continue;
      raw += r.points;
      breakdown.push({ rule: r.id, label, points: r.points });
    } else {
      const n = counts[r.id] ?? 0;
      if (!n) continue;
      const p = eventPoints(r, n);
      raw += p;
      breakdown.push({ rule: r.id, label, points: p, count: n });
    }
  }
  const decayed = applyDecay(raw, model.decay, lastEngagement, now);
  if (Math.round(decayed) !== Math.round(raw)) breakdown.push({ rule: 'decay', label: `Inaktivität (−${model.decay.percent} % je ${model.decay.days} Tage)`, points: Math.round(decayed) - Math.round(raw) });
  let score = Math.max(0, Math.round(decayed));
  if (model.max_score !== null && score > model.max_score) {
    breakdown.push({ rule: 'cap', label: `Höchstwert ${model.max_score}`, points: model.max_score - score });
    score = model.max_score;
  }
  return { score, label: labelFor(score, model.thresholds), breakdown };
}
