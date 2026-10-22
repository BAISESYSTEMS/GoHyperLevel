import type { Module } from '../core/app.js';
import { clampLimit } from '../core/http.js';
import { resolve, scopeClause } from '../services/record-access.js';
import { defaultStageProbability } from '../services/report-sources.js';
import type { Tool } from './mcp.js';

/**
 * Forecast tab of Opportunities (docs/sales.md#forecast): open deals by expected close month with the weighted value (value × the
 * stage's win probability – set on the stage, else by position like the reports), plus the cards that make a forecast unreliable:
 * deals without close date, past their close date, without activity for 14 days and without owner. Record access applies.
 */

interface Deal {
  id: string;
  name: string;
  value: number;
  currency: string;
  pipeline_id: string;
  stage_id: string;
  expected_close_date: string | null;
  assigned_to: string | null;
  updated_at: string | null;
  created_at: string;
  last_activity_at: string | null;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_deal_forecast',
    title: 'Umsatzprognose der Deals',
    description: 'Offene Deals je erwartetem Abschlussmonat mit gewichtetem Wert (Wert × Wahrscheinlichkeit der Stufe) und Risiko-Karten: ohne Abschlussdatum, überfällig, ohne Aktivität seit 14 Tagen, ohne Zuständigen – je mit Anzahl, Summe und den größten Deals.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, pipeline_id: { type: 'string' }, months: { type: 'number' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => {
      const s = new URLSearchParams();
      if (a.pipeline_id) s.set('pipeline_id', String(a.pipeline_id));
      if (a.months) s.set('months', String(a.months));
      return call.api('GET', `/api/deal-forecast${s.size ? `?${s}` : ''}`, { location: a.location_id });
    },
  },
];

/** "2026-10" plus n months. */
export const addMonths = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const dealForecastModule: Module = {
  name: 'deal-forecast',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    router.get('/api/deal-forecast', 'location', (ctx) => {
      const pid = ctx.query.get('pipeline_id');
      const months = clampLimit(ctx.query.get('months'), 6, 24);
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
      const staleBefore = new Date(Date.now() - 14 * 864e5).toISOString();
      const access = resolve(app, ctx);
      const scope = scopeClause(access, 'deals', 'o');
      // A hidden deal amount (record access) counts as 0 everywhere – counts and dates stay, sums and the order by size go.
      const valueHidden = !!access?.hidden.deals.has('value');
      const deals = db.all<Deal>(
        `SELECT o.id, o.name, o.value, o.currency, o.pipeline_id, o.stage_id, o.expected_close_date, o.assigned_to, o.updated_at, o.created_at, c.last_activity_at
         FROM opportunities o LEFT JOIN contacts c ON c.id = o.contact_id
         WHERE o.location_id = ? AND o.status = 'open'${pid ? ' AND o.pipeline_id = ?' : ''}${scope ? ` AND ${scope.sql}` : ''} LIMIT 20000`,
        ctx.locationId,
        ...(pid ? [pid] : []),
        ...((scope?.params ?? []) as string[]),
      );
      const pipes = new Map(
        db.all<{ id: string; stages: string }>('SELECT id, stages FROM pipelines WHERE location_id = ?', ctx.locationId).map((p) => {
          const stages = JSON.parse(p.stages || '[]') as { id: string; probability?: number }[];
          return [p.id, new Map(stages.map((s, i) => [s.id, s.probability ?? defaultStageProbability(i, stages.length)]))];
        }),
      );
      const prob = (d: Deal) => pipes.get(d.pipeline_id)?.get(d.stage_id) ?? 0;
      const first = today.slice(0, 7);
      const buckets = Array.from({ length: months }, (_, i) => ({ month: addMonths(first, i), count: 0, value: 0, weighted: 0 }));
      const later = { count: 0, value: 0, weighted: 0 };
      const card = () => ({ count: 0, value: 0, deals: [] as { id: string; name: string; value: number; expected_close_date: string | null }[] });
      const risks = { no_close_date: card(), overdue: card(), stale: card(), no_owner: card() };
      const amount = (d: Deal) => (valueHidden ? 0 : Number(d.value) || 0);
      const add = (c: ReturnType<typeof card>, d: Deal) => {
        c.count++;
        c.value += amount(d);
        c.deals.push({ id: d.id, name: d.name, value: amount(d), expected_close_date: d.expected_close_date });
      };
      let total = 0;
      let weightedTotal = 0;
      for (const d of deals) {
        const v = amount(d);
        const w = (v * prob(d)) / 100;
        total += v;
        weightedTotal += w;
        const close = d.expected_close_date ? String(d.expected_close_date).slice(0, 10) : '';
        if (!close) add(risks.no_close_date, d);
        else if (close < today) add(risks.overdue, d);
        if (!d.assigned_to) add(risks.no_owner, d);
        const last = [d.updated_at ?? d.created_at, d.last_activity_at ?? ''].sort().at(-1)!;
        if (last < staleBefore) add(risks.stale, d);
        if (!close) continue;
        // Overdue deals count in the current month: they are still expected, just late.
        const ym = close < today ? first : close.slice(0, 7);
        const b = buckets.find((x) => x.month === ym);
        const target = b ?? (ym > buckets[buckets.length - 1].month ? later : null);
        if (target) (target.count++, (target.value += v), (target.weighted += w));
      }
      const round = (n: number) => Math.round(n * 100) / 100;
      for (const c of Object.values(risks)) (c.deals.sort((a, b) => b.value - a.value), (c.deals = c.deals.slice(0, 10)), (c.value = round(c.value)));
      return {
        today,
        open: { count: deals.length, value: round(total), weighted: round(weightedTotal) },
        months: buckets.map((b) => ({ ...b, value: round(b.value), weighted: round(b.weighted) })),
        later: { ...later, value: round(later.value), weighted: round(later.weighted) },
        risks,
        ...(valueHidden ? { hidden_fields: ['value'] } : {}),
      };
    });
  },
};
