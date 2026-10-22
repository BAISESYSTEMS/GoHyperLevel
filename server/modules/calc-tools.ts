import type { Module } from '../core/app.js';
import { HttpError } from '../core/http.js';
import { bodyLocation, checkArea } from '../services/mobile.js';
import { PRESETS } from '../services/calc-presets.js';
import { METRIC_KEYS } from '../services/calc-summary.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools of the Gewinnrechner (HyperLevel Agent, Claude, ChatGPT, Codex) and the native app's endpoints. Tools are thin
 * relays onto the REST routes (modules/calc.ts), so the key's sub-account, member rights and the audit log apply.
 * Calculating changes nothing (read-only tools, no audit entry); saving a scenario is a write.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
/** For pure calculations the sub-account does not matter: agency callers may leave it out. */
const LOC_OPT = { location_id: { type: 'string', description: 'Sub-Account-ID – bei reinen Rechnungen optional (die Agentur nimmt dann das erste Projekt)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const INPUT_DOC = `input = Teil-Eingabe über den Standardwerten bzw. der Vorlage – nur ändern, was bekannt ist; Objekte werden feldweise zusammengeführt, Listen komplett ersetzt, unbekannte Felder sind ein Fehler. Felder (Beträge in €, Prozent 0–100):
pricing.plans[] {name, mix (Kunden-Anteil %), base_price (€/Monat), included_units (enthaltene Standorte/Plätze/Accounts), unit_price (je weitere Einheit), cap (Deckel, 0 = keiner), setup_fee, users, avg_units, extra_cost}; pricing.price_basis net|gross; pricing.annual {share, discount}; pricing.addons[] {name, price, take_rate, per_unit}
customers {count, avg_units, unit_mix[{units, share}], b2b_share, eu_share, churn (%/Monat), growth {start, monthly_new, monthly_new_growth, months}}
vat {rate 19|7|0, kleinunternehmer}
costs.variable {payment.methods[{label, share, pct, fixed, cap}] (Standard Stripe 1,5 % + 0,25 €), hosting|ai|messaging {per_customer, per_user, per_unit}, support {minutes_per_customer, hourly_rate}, other, referral {commission_pct, share}, app_store {fee_pct, share}}; costs.fixed {servers_tools, salaries, insurance, marketing, other, one_time}; costs.cac
tax {legal_form: einzelunternehmen|kapitalgesellschaft|keine, est {year: 2024–2026}, joint, church, other_income, vorsorge_monat, gewerbesteuer {enabled, hebesatz (400)}, kst {…}}
matrix {customers[], columns: price|factor|plan, prices[], factors[], plan_index}
Das vollständige Schema mit allen Standardwerten liefert die REST-Route GET /api/calc/schema.`;

const HINT =
  'Nutze das, wenn jemand nach Preisen, Gewinn, Marge, Break-even, Kundenwert, Kosten, Steuern oder „was bleibt übrig?“ fragt. Nenne in der Antwort die Kernzahlen (Umsatz, Nettogewinn, Break-even) UND die Annahmen (assumptions), auf denen sie beruhen, und weise darauf hin: „Schätzung, keine Steuerberatung“. Frage nach, wenn Preis oder Kundenzahl fehlen, statt zu raten.';

const PRESET_KEYS = PRESETS.map((p) => p.key);
const PRESET_DOC = `Vorlage (preset): ${PRESETS.map((p) => `${p.key} = ${p.name}`).join('; ')}.`;

const common = {
  preset: { type: 'string', enum: PRESET_KEYS, description: 'Ausgangspunkt statt der Standardwerte' },
  input: { type: 'object', description: 'Teil-Eingabe (siehe Beschreibung des Werkzeugs)' },
  customers: { type: 'number', description: 'Kundenzahl für die Einzelrechnung (Standard: customers.count der Eingabe)' },
};

const link = (path: string) => `/app/${path}`;

type Caller = Parameters<Tool['run']>[0];
/** Agency callers need a sub-account for the route; calculations do not depend on it, so the first project will do. */
async function anyLocation(call: Caller, loc?: string) {
  if (!call.agency) {
    if (loc && loc !== call.locationId) throw new HttpError(403, 'Dieser Schlüssel gilt nur für einen Sub-Account');
    return undefined;
  }
  if (loc) return loc;
  const list: any[] = await call.api('GET', '/api/agency/projects');
  if (!list.length) throw new HttpError(400, 'Kein Sub-Account vorhanden');
  return list[0].id as string;
}

export const CALC_TOOLS: Tool[] = [
  {
    name: 'ghl_calc_run',
    title: 'Gewinnrechner: Was bleibt übrig?',
    description: `Gewinnrechner: rechnet, was bei einem Preismodell und einer Kundenzahl nach Umsatzsteuer, Zahlungsgebühren, variablen Kosten, Fixkosten, CAC und Steuern (Einzelunternehmen: ESt § 32a, Soli, Gewerbesteuer; GmbH: KSt) übrig bleibt. Antwort: Kernaussage (headline), Warnungen, Fokus (Zahlen pro Monat/Jahr, Wasserfall, Kundenwert LTV/CAC, Amortisation, Break-even, Prognose 12/24/36 Monate, wichtigste Hebel) und eine Matrix Kunden × Preisvarianten für EINE Kennzahl (metric). ${HINT} ${PRESET_DOC} ${INPUT_DOC}`,
    inputSchema: obj(
      {
        ...LOC_OPT,
        ...common,
        scenario_id: { type: 'string', description: 'Gespeichertes Szenario als Ausgangspunkt (aus ghl_calc_scenarios_list)' },
        column: { type: 'integer', minimum: -1, maximum: 11, description: 'Preisvariante der Matrix für den Fokus (−1 = Preise wie eingegeben)' },
        sensitivity: { type: 'boolean', description: 'wichtigste Hebel (Tornado) mitrechnen, Standard true' },
        metric: { type: 'string', enum: METRIC_KEYS, description: 'Kennzahl der Matrix: revenue_gross, revenue_net, contribution (nach variablen Kosten), ebit, net_profit (Standard), margin' },
        period: { type: 'string', enum: ['month', 'year'] },
      },
      [],
    ),
    annotations: RO,
    run: async (call, a) => {
      const location = await anyLocation(call, a.location_id);
      const r = await call.api('POST', '/api/calc/run', { location, body: { preset: a.preset, scenario_id: a.scenario_id, input: a.input, customers: a.customers, column: a.column, sensitivity: a.sensitivity !== false, metric: a.metric, period: a.period, compact: true } });
      return { ...r, link: link(a.scenario_id ? `calc/${a.scenario_id}` : 'calc') };
    },
  },
  {
    name: 'ghl_calc_breakeven',
    title: 'Gewinnrechner: Break-even',
    description: `Break-even des Gewinnrechners: ab wie vielen Kunden das Geschäft vor und nach Steuern im Plus ist (je Preisvariante), welcher Mindestpreis bei N Kunden nötig ist und – mit target_net_profit_month – wie viele Kunden bzw. welcher Preis für einen gewünschten Nettogewinn pro Monat nötig sind. ${HINT} ${PRESET_DOC} ${INPUT_DOC}`,
    inputSchema: obj({ ...LOC_OPT, ...common, scenario_id: { type: 'string' }, target_net_profit_month: { type: 'number', description: 'Gewünschter Nettogewinn pro Monat in € (nach Steuern)' } }, []),
    annotations: RO,
    run: async (call, a) => {
      const location = await anyLocation(call, a.location_id);
      const r = await call.api('POST', '/api/calc/breakeven', { location, body: { preset: a.preset, scenario_id: a.scenario_id, input: a.input, customers: a.customers, target_net_profit_month: a.target_net_profit_month } });
      return { ...r, link: link(a.scenario_id ? `calc/${a.scenario_id}` : 'calc') };
    },
  },
  {
    name: 'ghl_calc_scenarios_list',
    title: 'Gewinnrechner: Szenarien',
    description: 'Gespeicherte Szenarien des Gewinnrechners (Name, Notiz, Kernzahlen wie Nettogewinn pro Monat, Break-even, LTV/CAC) und die Vorlagen (preset), mit denen ghl_calc_run startet.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const [list, presets] = await Promise.all([call.api('GET', '/api/calc/scenarios', { location: a.location_id }), call.api('GET', '/api/calc/presets', { location: a.location_id })]);
      return {
        scenarios: (list as any[]).map((s) => ({ id: s.id, name: s.name, note: s.note, preset: s.preset, updated_at: s.updated_at, created_by: s.created_by, key_figures: s.summary, link: link(`calc/${s.id}`) })),
        presets,
        link: link('calc'),
      };
    },
  },
  {
    name: 'ghl_calc_scenario_run',
    title: 'Gewinnrechner: Szenario berechnen',
    description: `Rechnet ein gespeichertes Szenario neu, optional mit Änderungen (input = Teil-Eingabe, z. B. anderer Preis oder Kundenzahl) – ohne es zu speichern. Mit compare_with (weitere Szenario-IDs) kommt stattdessen ein Vergleich nebeneinander: Kernzahlen je Szenario, Unterschied zum ersten und das beste. ${HINT} ${INPUT_DOC}`,
    inputSchema: obj(
      {
        ...LOC,
        scenario_id: { type: 'string', description: 'Szenario-ID (aus ghl_calc_scenarios_list)' },
        input: common.input,
        customers: common.customers,
        column: { type: 'integer', minimum: -1, maximum: 11 },
        sensitivity: { type: 'boolean' },
        metric: { type: 'string', enum: METRIC_KEYS },
        period: { type: 'string', enum: ['month', 'year'] },
        compare_with: { type: 'array', items: { type: 'string' }, description: 'IDs weiterer Szenarien (höchstens 5) für den Vergleich – dann werden input/customers ignoriert' },
      },
      ['location_id', 'scenario_id'],
    ),
    annotations: RO,
    run: async (call, a) => {
      if (Array.isArray(a.compare_with) && a.compare_with.length) {
        const r = await call.api('POST', '/api/calc/compare', { location: a.location_id, body: { ids: [a.scenario_id, ...a.compare_with] } });
        return { ...r, link: link('calc') };
      }
      const r = await call.api('POST', `/api/calc/scenarios/${encodeURIComponent(a.scenario_id)}/run`, { location: a.location_id, body: { input: a.input, customers: a.customers, column: a.column, sensitivity: a.sensitivity !== false, metric: a.metric, period: a.period, compact: true } });
      return { ...r, link: link(`calc/${a.scenario_id}`) };
    },
  },
  {
    name: 'ghl_calc_scenario_save',
    title: 'Gewinnrechner: Szenario speichern',
    description: `Speichert ein Szenario im Gewinnrechner des Sub-Accounts (neu) oder ändert ein vorhandenes (scenario_id: Name, Notiz und/oder input = Teil-Eingabe über dem gespeicherten Stand). Ohne preset/input starten neue Szenarien mit den Standardwerten. ${PRESET_DOC} ${INPUT_DOC}`,
    inputSchema: obj({ ...LOC, scenario_id: { type: 'string', description: 'Vorhandenes Szenario ändern statt neu anlegen' }, name: { type: 'string', description: 'Name (höchstens 80 Zeichen)' }, note: { type: 'string' }, preset: common.preset, input: common.input }, ['location_id']),
    annotations: W,
    run: async (call, a) => {
      const body = { name: a.name, note: a.note, preset: a.preset, input: a.input };
      const s = a.scenario_id
        ? await call.api('PATCH', `/api/calc/scenarios/${encodeURIComponent(a.scenario_id)}`, { location: a.location_id, body: { name: a.name, note: a.note, input: a.input } })
        : await call.api('POST', '/api/calc/scenarios', { location: a.location_id, body });
      return { id: s.id, name: s.name, note: s.note, key_figures: s.summary, link: link(`calc/${s.id}`) };
    },
  },
];

export const calcToolsModule: Module = {
  name: 'calc-tools',
  register(app) {
    const { router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...CALC_TOOLS];

    // --- native app (bearer ghm_…): the same answers, read-only ------------------------------------------------------
    const loc = (ctx: any) => bodyLocation(app, ctx, ctx.query.get('location') ?? ctx.body?.location_id);

    router.get('/api/mobile/calc/scenarios', 'user', (ctx) => {
      const l = loc(ctx);
      // Same rights as the web app: the area "Rechnungen & Produkte" and the SaaS plan.
      checkArea(app, ctx, l.id, 'payments');
      return {
        location_id: l.id,
        scenarios: (app.services.calc.scenarios(l.id) as any[]).map((s) => ({
          id: s.id,
          name: s.name,
          note: s.note,
          updated_at: s.updated_at,
          customers: s.summary?.customers ?? null,
          revenue_net_month: s.summary?.revenue_net_month ?? null,
          ebit_month: s.summary?.ebit_month ?? null,
          net_profit_month: s.summary?.net_profit_month ?? null,
          margin_pct: s.summary?.margin_pct ?? null,
          breakeven_customers: s.summary?.breakeven_customers ?? null,
        })),
      };
    });
    router.post('/api/mobile/calc/scenarios/:id/run', 'user', (ctx) => {
      // A calculation changes nothing: no audit entry.
      ctx.skipAfterWrite = true;
      const l = loc(ctx);
      checkArea(app, ctx, l.id, 'payments');
      return app.services.calc.run(l.id, ctx.params.id, { customers: ctx.body?.customers, input: ctx.body?.input, sensitivity: ctx.body?.sensitivity !== false });
    });
  },
};
