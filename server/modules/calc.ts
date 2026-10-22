import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now, slugify } from '../core/util.js';
import { CalcInputError, csvDe, detailOf, exportRows, headline, inputSchema, resolveInput, rounded, run, type CalcInput, type RunOptions } from '../services/calc-engine.js';
import { PRESETS, presetByKey, presetInput } from '../services/calc-presets.js';
import { METRIC_KEYS, breakevenReport, compactRun, compare, kpisOf, type Kpis } from '../services/calc-summary.js';

/**
 * Gewinnrechner: "What do I earn at which price and how many customers, after all costs, fees and taxes?"
 *
 * The maths is a pure engine (services/calc-engine.ts) that also runs in the browser; this module is the
 * API around it – a stateless run/break-even endpoint and the sub-account's saved scenarios. Everything is
 * a plain JSON input (GET /api/calc/schema), so agents and scripts calculate exactly what people see.
 * Rights: the area "Rechnungen & Produkte" (permissions.ts, `/api/calc`); scenarios belong to one sub-account.
 * A calculation changes nothing, so it is not a write (no audit entry); saving, changing and deleting a scenario is.
 */

export const MAX_SCENARIOS = 200;
export const MAX_COMPARE = 6;
const MAX_CUSTOMERS = 100_000_000;

interface ScenarioRow {
  id: string;
  location_id: string;
  name: string;
  note: string;
  preset: string | null;
  input: string;
  summary: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Engine input errors are the caller's mistake: 400 with the German list of problems. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CalcInputError) throw bad(`Ungültige Eingabe: ${e.message}`);
    throw e;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The stored input of a scenario, completed with the defaults of fields added since it was saved. */
function storedInput(row: ScenarioRow): CalcInput {
  try {
    return resolveInput(JSON.parse(row.input));
  } catch {
    throw new HttpError(409, 'Dieses Szenario passt nicht mehr zum Rechner – bitte neu anlegen');
  }
}

function runOptions(body: any): RunOptions {
  const o: RunOptions = {};
  if (body.customers !== undefined && body.customers !== null && body.customers !== '') {
    const n = Number(body.customers);
    if (!Number.isFinite(n) || n < 0 || n > MAX_CUSTOMERS) throw bad('customers: Zahl zwischen 0 und 100.000.000 erwartet');
    o.customers = n;
  }
  if (body.column !== undefined && body.column !== null && body.column !== '') {
    const c = Number(body.column);
    if (!Number.isInteger(c) || c < -1 || c > 11) throw bad('column: ganze Zahl von -1 (aktuelle Preise) bis 11 erwartet');
    o.column = c;
  }
  o.sensitivity = body.sensitivity === true;
  return o;
}

const metricOf = (v: unknown) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!(METRIC_KEYS as string[]).includes(String(v))) throw bad(`metric: einer von ${METRIC_KEYS.join(', ')} erwartet`);
  return String(v) as (typeof METRIC_KEYS)[number];
};

export const actorOf = (ctx: Ctx) => ctx.user?.name || (ctx.via === 'mcp' ? 'MCP' : ctx.viaApiKey ? 'API-Schlüssel' : '');

const summaryOf = (r: ScenarioRow): Kpis | null => {
  try {
    return JSON.parse(r.summary) as Kpis;
  } catch {
    return null;
  }
};

const out = (r: ScenarioRow, withInput: boolean) => ({
  id: r.id,
  name: r.name,
  note: r.note,
  preset: r.preset,
  created_by: r.created_by,
  created_at: r.created_at,
  updated_at: r.updated_at,
  summary: summaryOf(r),
  ...(withInput ? { input: storedInput(r) } : {}),
});

export const calcModule: Module = {
  name: 'calc',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE calc_scenarios (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', preset TEXT,
        input TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX calc_scenarios_location ON calc_scenarios(location_id, updated_at);
      `,
    ],
  ],
  register(app: App) {
    const { db, router } = app;

    const scenario = (loc: string, sid: string): ScenarioRow => {
      const r = db.get<ScenarioRow>('SELECT * FROM calc_scenarios WHERE id = ? AND location_id = ?', sid, loc);
      if (!r) throw notFound('Szenario nicht gefunden');
      return r;
    };

    /** The input a request calculates with: defaults, a preset or a saved scenario, then the partial `input` on top. */
    const inputOf = (loc: string, body: any, scenarioId?: string): { input: CalcInput; row?: ScenarioRow } => {
      const b = isObj(body) ? body : {};
      let base: CalcInput | undefined;
      let row: ScenarioRow | undefined;
      const sid = scenarioId ?? (b.scenario_id ? String(b.scenario_id) : undefined);
      if (sid) {
        row = scenario(loc, sid);
        base = storedInput(row);
      } else if (b.preset) {
        base = presetInput(String(b.preset)) ?? undefined;
        if (!base) throw bad(`Vorlage „${String(b.preset).slice(0, 40)}“ gibt es nicht (gültig: ${PRESETS.map((p) => p.key).join(', ')})`);
      }
      const patch = b.input ?? b.overrides;
      if (patch !== undefined && patch !== null && !isObj(patch)) throw bad('input: Objekt erwartet');
      return { input: guarded(() => resolveInput(patch ?? {}, base)), row };
    };

    const answer = (input: CalcInput, body: any) => {
      const b = isObj(body) ? body : {};
      const r = run(input, runOptions(b));
      if (b.compact === true) return compactRun(input, r, { metric: metricOf(b.metric), period: b.period === 'year' ? 'year' : 'month' });
      return { ...rounded(r), headline: headline(input, r.focus), input };
    };

    /** For the native app (calc-tools.ts): the same answers without a request of their own – no write, no audit entry. */
    app.services.calc = {
      scenarios: (loc: string) => db.all<ScenarioRow>('SELECT * FROM calc_scenarios WHERE location_id = ? ORDER BY updated_at DESC', loc).map((r) => out(r, false)),
      run: (loc: string, scenarioId: string, body: unknown) => answer(inputOf(loc, body, scenarioId).input, { ...(isObj(body) ? body : {}), compact: true }),
    };

    // --- reference data ---------------------------------------------------------------------------------------------
    router.get('/api/calc/schema', 'location', () => inputSchema());
    router.get('/api/calc/presets', 'location', () => PRESETS.map((p) => ({ key: p.key, name: p.name, description: p.description })));
    router.get('/api/calc/presets/:key', 'location', (ctx) => {
      const p = presetByKey(ctx.params.key);
      if (!p) throw notFound('Vorlage nicht gefunden');
      return { key: p.key, name: p.name, description: p.description, input: guarded(() => presetInput(p.key)) };
    });

    // --- calculate (no state, no audit entry) -----------------------------------------------------------------------
    router.post('/api/calc/run', 'location', (ctx) => {
      ctx.skipAfterWrite = true;
      const { input } = inputOf(ctx.locationId, ctx.body);
      return answer(input, ctx.body);
    });
    router.post('/api/calc/breakeven', 'location', (ctx) => {
      ctx.skipAfterWrite = true;
      const b = isObj(ctx.body) ? ctx.body : {};
      const { input } = inputOf(ctx.locationId, b);
      const o = runOptions(b);
      let target: number | undefined;
      if (b.target_net_profit_month !== undefined && b.target_net_profit_month !== null && b.target_net_profit_month !== '') {
        target = Number(b.target_net_profit_month);
        if (!Number.isFinite(target) || target < 0 || target > 1e9) throw bad('target_net_profit_month: Betrag in € pro Monat (0 bis 1 Mrd.) erwartet');
      }
      return breakevenReport(input, o.customers ?? input.customers.count, target);
    });

    // --- scenarios (per sub-account) ----------------------------------------------------------------------------------
    router.get('/api/calc/scenarios', 'location', (ctx) => db.all<ScenarioRow>('SELECT * FROM calc_scenarios WHERE location_id = ? ORDER BY updated_at DESC', ctx.locationId).map((r) => out(r, false)));

    router.post('/api/calc/scenarios', 'location', (ctx) => {
      const b = isObj(ctx.body) ? ctx.body : {};
      const name = str(b.name, 'Name', { required: true, max: 80 });
      const note = str(b.note, 'Notiz', { max: 500 });
      if ((db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calc_scenarios WHERE location_id = ?', ctx.locationId)?.n ?? 0) >= MAX_SCENARIOS) throw bad(`Höchstens ${MAX_SCENARIOS} Szenarien pro Sub-Account – bitte alte löschen`);
      const { input } = inputOf(ctx.locationId, { preset: b.preset, input: b.input });
      const preset = b.preset && presetByKey(String(b.preset)) ? String(b.preset) : null;
      const row: ScenarioRow = {
        id: id(),
        location_id: ctx.locationId,
        name,
        note,
        preset,
        input: JSON.stringify(input),
        summary: JSON.stringify(rounded(kpisOf(detailOf(input, input.customers.count)))),
        created_by: actorOf(ctx),
        created_at: now(),
        updated_at: now(),
      };
      db.insert('calc_scenarios', row as unknown as Record<string, any>);
      return out(row, true);
    });

    router.get('/api/calc/scenarios/:id', 'location', (ctx) => out(scenario(ctx.locationId, ctx.params.id), true));

    router.patch('/api/calc/scenarios/:id', 'location', (ctx) => {
      const cur = scenario(ctx.locationId, ctx.params.id);
      const b = isObj(ctx.body) ? ctx.body : {};
      const name = b.name !== undefined ? str(b.name, 'Name', { required: true, max: 80 }) : cur.name;
      const note = b.note !== undefined ? str(b.note, 'Notiz', { max: 500 }) : cur.note;
      let input = cur.input;
      let summary = cur.summary;
      if (b.input !== undefined) {
        const next = inputOf(ctx.locationId, { input: b.input }, cur.id).input;
        input = JSON.stringify(next);
        summary = JSON.stringify(rounded(kpisOf(detailOf(next, next.customers.count))));
      }
      db.run('UPDATE calc_scenarios SET name = ?, note = ?, input = ?, summary = ?, updated_at = ? WHERE id = ? AND location_id = ?', name, note, input, summary, now(), cur.id, ctx.locationId);
      return out(scenario(ctx.locationId, cur.id), true);
    });

    router.delete('/api/calc/scenarios/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM calc_scenarios WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Szenario nicht gefunden');
      return { ok: true };
    });

    router.post('/api/calc/scenarios/:id/run', 'location', (ctx) => {
      ctx.skipAfterWrite = true;
      const { input } = inputOf(ctx.locationId, ctx.body, ctx.params.id);
      return answer(input, ctx.body);
    });

    router.post('/api/calc/compare', 'location', (ctx) => {
      ctx.skipAfterWrite = true;
      const ids = Array.isArray(ctx.body?.ids) ? [...new Set<string>(ctx.body.ids.map(String))] : [];
      if (ids.length < 2 || ids.length > MAX_COMPARE) throw bad(`ids: zwei bis ${MAX_COMPARE} Szenarien zum Vergleichen angeben`);
      // Recalculated, not read from the stored key figures: the comparison always matches the current engine.
      const items = ids.map((sid) => {
        const row = scenario(ctx.locationId, sid);
        const input = storedInput(row);
        return { id: row.id, name: row.name, kpis: rounded(kpisOf(detailOf(input, input.customers.count))) };
      });
      return compare(items);
    });

    router.get('/api/calc/scenarios/:id/export.csv', 'location', (ctx) => {
      const row = scenario(ctx.locationId, ctx.params.id);
      const csv = csvDe(exportRows(run(storedInput(row))));
      return { __raw: true, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="gewinnrechner-${slugify(row.name) || 'szenario'}.csv"` }, body: csv };
    });
  },
};
