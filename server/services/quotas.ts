import type { App } from '../core/app.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import { defaultStageProbability } from './report-sources.js';

/**
 * Sales quotas: a target per person or team for a month or a quarter, measured in won deal value or won deals, with how far along the
 * period is, the pipeline that could still close in it and a ranking. The period is counted in the sub-account's calendar; a deal
 * counts for its owner at the moment it was won (`closed_at`), in the quota's currency.
 */

export const PERIODS = ['month', 'quarter'] as const;
export type PeriodKind = (typeof PERIODS)[number];
export const METRICS = ['won_value', 'won_count'] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_LABEL: Record<Metric, string> = { won_value: 'Gewonnener Umsatz', won_count: 'Gewonnene Deals' };

export interface PeriodRange {
  kind: PeriodKind;
  /** First day (YYYY-MM-DD). */
  start: string;
  /** First day of the next period. */
  end: string;
  label: string;
  startUtc: string;
  endUtc: string;
}

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** The first day of the month or quarter that contains `ymd`. */
export function periodStart(kind: PeriodKind, ymd: string): string {
  const [y, m] = ymd.split('-').map(Number);
  const month = kind === 'quarter' ? Math.floor((m - 1) / 3) * 3 + 1 : m;
  return `${y}-${String(month).padStart(2, '0')}-01`;
}

/** The first day of the period after (or `back` periods before) the one starting at `start`. */
export function shiftPeriod(kind: PeriodKind, start: string, by: number): string {
  const [y, m] = start.split('-').map(Number);
  const idx = y * 12 + (m - 1) + by * (kind === 'quarter' ? 3 : 1);
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

export function periodRange(kind: PeriodKind, start: string, tz: string): PeriodRange {
  const end = shiftPeriod(kind, start, 1);
  const [y, m] = start.split('-').map(Number);
  const label = kind === 'quarter' ? `Q${Math.floor((m - 1) / 3) + 1} ${y}` : `${MONTHS[m - 1]} ${y}`;
  return { kind, start, end, label, startUtc: zonedToUtc(start, '00:00', tz).toISOString(), endUtc: zonedToUtc(end, '00:00', tz).toISOString() };
}

/** The period that contains `at`, in the sub-account's calendar. */
export const currentPeriod = (kind: PeriodKind, at: Date, tz: string): PeriodRange => periodRange(kind, periodStart(kind, ymdInTz(at, tz)), tz);

/** How much of the period has passed (0–100) and how many days are left. */
export function progress(range: PeriodRange, at: Date): { elapsed_pct: number; days_left: number; days_total: number } {
  const a = Date.parse(range.startUtc);
  const b = Date.parse(range.endUtc);
  const t = Math.min(b, Math.max(a, at.getTime()));
  return { elapsed_pct: Math.round(((t - a) / (b - a)) * 1000) / 10, days_left: Math.max(0, Math.ceil((b - at.getTime()) / 864e5)), days_total: Math.round((b - a) / 864e5) };
}

export type Pace = 'reached' | 'ahead' | 'on_track' | 'behind' | 'closed' | 'none';
export const PACE_LABEL: Record<Pace, string> = { reached: 'Quote erreicht', ahead: 'Vorn', on_track: 'Im Plan', behind: 'Im Rückstand', closed: 'Nicht erreicht', none: 'Keine Quote' };

/** Where a person stands: a pace of 100 % means exactly the share of the target that the elapsed time asks for. */
export function paceOf(attainmentPct: number | null, elapsedPct: number): Pace {
  if (attainmentPct === null) return 'none';
  if (attainmentPct >= 100) return 'reached';
  if (elapsedPct >= 100) return 'closed';
  const pace = elapsedPct > 0 ? attainmentPct / elapsedPct : attainmentPct > 0 ? 2 : 1;
  return pace >= 1.1 ? 'ahead' : pace >= 0.85 ? 'on_track' : 'behind';
}

export const pct = (n: number, of: number): number => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);

// --- reading the deals ---------------------------------------------------------------------------------------------------------------

export interface Won {
  value: number;
  count: number;
}

/** Won deals of the period per owner (`''` = no owner), in one currency. */
export function wonByOwner(app: App, loc: string, range: Pick<PeriodRange, 'startUtc' | 'endUtc'>, currency: string): Map<string, Won> {
  const rows = app.db.all<{ owner: string | null; value: number; n: number }>(
    `SELECT assigned_to AS owner, COALESCE(SUM(value), 0) AS value, COUNT(*) AS n FROM opportunities
     WHERE location_id = ? AND status = 'won' AND currency = ? AND COALESCE(closed_at, updated_at) >= ? AND COALESCE(closed_at, updated_at) < ? GROUP BY assigned_to`,
    loc,
    currency,
    range.startUtc,
    range.endUtc,
  );
  return new Map(rows.map((r) => [r.owner ?? '', { value: Number(r.value), count: Number(r.n) }]));
}

/** Open deals that are expected to close in the period: their value and their value weighted by the stage's probability. */
export function pipelineByOwner(app: App, loc: string, range: Pick<PeriodRange, 'start' | 'end'>, currency: string): Map<string, { value: number; weighted: number }> {
  const pipelines = new Map<string, { id: string; probability?: number }[]>();
  for (const p of app.db.all<{ id: string; stages: string }>('SELECT id, stages FROM pipelines WHERE location_id = ?', loc)) pipelines.set(p.id, JSON.parse(p.stages || '[]'));
  const out = new Map<string, { value: number; weighted: number }>();
  const lastDay = addDaysYmd(range.end, -1);
  for (const d of app.db.all<{ owner: string | null; value: number; pipeline_id: string; stage_id: string }>(
    `SELECT assigned_to AS owner, value, pipeline_id, stage_id FROM opportunities WHERE location_id = ? AND status = 'open' AND currency = ? AND expected_close_date >= ? AND expected_close_date <= ?`,
    loc,
    currency,
    range.start,
    lastDay,
  )) {
    const stages = pipelines.get(d.pipeline_id) ?? [];
    const i = stages.findIndex((s) => s.id === d.stage_id);
    const p = i < 0 ? 0 : (stages[i].probability ?? defaultStageProbability(i, stages.length));
    const cur = out.get(d.owner ?? '') ?? { value: 0, weighted: 0 };
    cur.value += Number(d.value);
    cur.weighted += (Number(d.value) * p) / 100;
    out.set(d.owner ?? '', cur);
  }
  return out;
}

export interface QuotaRow {
  id: string;
  location_id: string;
  scope: 'user' | 'team';
  subject_id: string;
  period: PeriodKind;
  period_start: string;
  metric: Metric;
  target: number;
  currency: string;
}

export const quotasOf = (app: App, loc: string, kind: PeriodKind, start: string, metric?: Metric): QuotaRow[] =>
  app.db.all<QuotaRow>(`SELECT * FROM sales_quotas WHERE location_id = ? AND period = ? AND period_start = ?${metric ? ' AND metric = ?' : ''}`, loc, kind, start, ...(metric ? [metric] : []));

export interface Standing {
  scope: 'user' | 'team';
  subject_id: string;
  name: string;
  members?: string[];
  quota_id: string | null;
  metric: Metric;
  target: number | null;
  won_value: number;
  won_count: number;
  /** The metric's value (value or count). */
  achieved: number;
  attainment_pct: number | null;
  pace: Pace;
  pace_label: string;
  gap: number | null;
  open_value: number;
  weighted_pipeline: number;
  /** Open pipeline (weighted) against what is still missing – above 100 % the target is within reach. */
  coverage_pct: number | null;
}

/**
 * Everybody's standing in a period: one row per person and team that has a quota or won something, with the figures that tell how
 * it is going. Teams add up their members' deals (a person in two teams counts for both).
 */
export function standings(
  app: App,
  loc: string,
  o: { kind: PeriodKind; start: string; metric: Metric; currency: string; tz: string; at?: Date; people: { id: string; name: string }[]; teams: { id: string; name: string; members: string[] }[] },
): { range: PeriodRange; elapsed_pct: number; days_left: number; rows: Standing[] } {
  const at = o.at ?? new Date();
  const range = periodRange(o.kind, o.start, o.tz);
  const prog = progress(range, at);
  const won = wonByOwner(app, loc, range, o.currency);
  const pipe = pipelineByOwner(app, loc, range, o.currency);
  const quotas = quotasOf(app, loc, o.kind, o.start, o.metric).filter((q) => q.currency === o.currency);
  const quotaOf = (scope: 'user' | 'team', id: string) => quotas.find((q) => q.scope === scope && q.subject_id === id);
  const sum = (ids: string[]) => {
    const w = { value: 0, count: 0 };
    const p = { value: 0, weighted: 0 };
    for (const id of new Set(ids)) {
      const a = won.get(id);
      const b = pipe.get(id);
      if (a) (w.value += a.value), (w.count += a.count);
      if (b) (p.value += b.value), (p.weighted += b.weighted);
    }
    return { w, p };
  };
  const make = (scope: 'user' | 'team', id: string, name: string, ids: string[], members?: string[]): Standing => {
    const { w, p } = sum(ids);
    const q = quotaOf(scope, id);
    const achieved = o.metric === 'won_value' ? w.value : w.count;
    const attainment = q && q.target > 0 ? pct(achieved, q.target) : null;
    const gap = q ? Math.max(0, q.target - achieved) : null;
    const pace = paceOf(attainment, prog.elapsed_pct);
    return {
      scope,
      subject_id: id,
      name,
      ...(members ? { members } : {}),
      quota_id: q?.id ?? null,
      metric: o.metric,
      target: q?.target ?? null,
      won_value: w.value,
      won_count: w.count,
      achieved,
      attainment_pct: attainment,
      pace,
      pace_label: PACE_LABEL[pace],
      gap,
      open_value: p.value,
      weighted_pipeline: Math.round(p.weighted),
      coverage_pct: gap && o.metric === 'won_value' ? pct(p.weighted, gap) : null,
    };
  };
  const rows: Standing[] = [];
  const known = new Set(o.people.map((x) => x.id));
  for (const person of o.people) {
    const has = quotaOf('user', person.id) || won.has(person.id) || pipe.has(person.id);
    if (has) rows.push(make('user', person.id, person.name, [person.id]));
  }
  // Somebody who left but won deals: still part of the picture (and of the team sums).
  for (const id of won.keys()) if (id && !known.has(id)) rows.push(make('user', id, 'Ehemalige Person', [id]));
  for (const team of o.teams) if (quotaOf('team', team.id) || team.members.some((m) => won.has(m))) rows.push(make('team', team.id, team.name, team.members, team.members));
  return { range, elapsed_pct: prog.elapsed_pct, days_left: prog.days_left, rows };
}

/** Competition ranking (1, 2, 2, 4): the same figure shares a place. Sorted by the metric, then by attainment. */
export function rank<T extends { achieved: number; attainment_pct: number | null }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.achieved - a.achieved || (b.attainment_pct ?? -1) - (a.attainment_pct ?? -1));
  let last: number | null = null;
  let place = 0;
  return sorted.map((r, i) => {
    if (last === null || r.achieved !== last) place = i + 1;
    last = r.achieved;
    return { ...r, rank: place };
  });
}
