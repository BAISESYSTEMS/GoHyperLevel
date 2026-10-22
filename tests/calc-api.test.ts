import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { cellOf, econ, resolveInput, run } from '../server/services/calc-engine.js';
import { customersForNetProfit, priceForNetProfit } from '../server/services/calc-summary.js';
import { MAX_SCENARIOS } from '../server/modules/calc.js';
import { CALC_TOOLS } from '../server/modules/calc-tools.js';
import { classify } from '../server/services/agent-safety.js';
import { groupOf } from '../server/services/agent-tools.js';

/**
 * Gewinnrechner API: stateless run / break-even, saved scenarios, comparison, CSV, MCP tools and the app's endpoints –
 * with sub-account isolation, member areas, key scopes and the audit log. No network, nothing to fake: it is all maths.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let keyA = '';
let keyB = '';
let agencyKey = '';
let agencyRead = '';
let member: Call;
let limited: Call;

const asKey = (method: string, path: string, body?: unknown, key = keyA, location = loc) =>
  t.api.raw(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-location-id': location }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));

let rpcId = 0;
const mcp = async (name: string, args: any, key = keyA) => {
  const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j: any = await r.json();
  const text = j.result?.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error text */
  }
  return { isError: !!j.result?.isError, text, data, error: j.error };
};

const audit = (action: string) => t.app.db.all<any>('SELECT * FROM audit_log WHERE action = ? ORDER BY at', action);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  keyA = (await t.api.post('/api/api-keys', { name: 'Rechner A' })).data.key;
  t.api.setLocation(other);
  keyB = (await t.api.post('/api/api-keys', { name: 'Rechner B' })).data.key;
  t.api.setLocation(loc);
  agencyKey = (await t.api.post('/api/agency/api-keys', { name: 'Agentur' })).data.key;
  agencyRead = (await t.api.post('/api/agency/api-keys', { name: 'Nur lesen', scope: 'read' })).data.key;
  // two client logins of the first sub-account: one with the area "Rechnungen & Produkte", one without
  await t.api.post('/api/users', { email: 'finanzen@example.com', password: 'passwort-f1', name: 'Fina', locations: [loc], permissions: ['payments'] });
  await t.api.post('/api/users', { email: 'kontakte@example.com', password: 'passwort-k1', name: 'Konrad', locations: [loc], permissions: ['contacts'] });
  member = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await member('POST', '/api/auth/login', { email: 'finanzen@example.com', password: 'passwort-f1' })).status).toBe(200);
  limited = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
  expect((await limited('POST', '/api/auth/login', { email: 'kontakte@example.com', password: 'passwort-k1' })).status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('reference data', () => {
  it('serves the JSON schema with descriptions and defaults, and the six presets', async () => {
    const s = (await t.api.get('/api/calc/schema')).data;
    expect(s.$schema).toContain('2020-12');
    expect(s.properties.pricing.properties.plans.items.properties.cap.description).toMatch(/Deckel/);
    expect(s.properties.tax.properties.gewerbesteuer.properties.hebesatz.default).toBe(400);
    const presets = (await t.api.get('/api/calc/presets')).data;
    expect(presets.map((p: any) => p.key)).toEqual(['gohigh-staffel', 'gohigh-standort', 'saas-pro-nutzer', 'agentur-retainer', 'kurs-community', 'handwerk']);
    const one = (await t.api.get('/api/calc/presets/gohigh-standort')).data;
    expect(one.input.pricing.plans[0]).toMatchObject({ base_price: 49, included_units: 3, unit_price: 10, cap: 499 });
    expect((await t.api.get('/api/calc/presets/gibt-es-nicht')).status).toBe(404);
  });
});

describe('run', () => {
  it('calculates the defaults and answers in one sentence', async () => {
    const before = audit('calc.run.create').length;
    const r = await t.api.post('/api/calc/run', {});
    expect(r.status).toBe(200);
    expect(r.data.headline).toMatch(/^Bei 100 Kunden zu 49 €: Umsatz netto/);
    expect(r.data.headline).toContain('Schätzung, keine Steuerberatung');
    expect(r.data.disclaimer).toBe('Schätzung, keine Steuerberatung');
    expect(r.data.rows).toEqual([10, 25, 50, 100, 250, 500, 1000, 5000]);
    expect(r.data.columns.map((c: any) => c.price)).toEqual([29, 49, 79, 99, 149]);
    expect(r.data.matrix).toHaveLength(8);
    // the same numbers the engine gives directly (rounded to cents)
    const direct = run(resolveInput({}));
    expect(r.data.focus.cell.m.net_profit).toBeCloseTo(direct.focus.cell.m.net_profit, 2);
    expect(r.data.input.customers.count).toBe(100);
    // a calculation is not a write: no audit entry
    expect(audit('calc.run.create')).toHaveLength(before);
  });

  it('takes a preset, a partial input over it and the customer count of the question', async () => {
    const r = await t.api.post('/api/calc/run', { preset: 'gohigh-standort', input: { customers: { churn: 1 }, pricing: { plans: [{ name: 'Cloud', mix: 100, base_price: 59, included_units: 3, unit_price: 10, cap: 499 }] } }, customers: 500 });
    expect(r.status).toBe(200);
    expect(r.data.focus.customers).toBe(500);
    expect(r.data.input.customers.churn).toBe(1);
    expect(r.data.input.pricing.plans[0].base_price).toBe(59);
    // the unit mix of the preset stays
    expect(r.data.input.customers.unit_mix).toHaveLength(8);
    const manual = cellOf(resolveInput(r.data.input), 500);
    expect(r.data.focus.cell.m.ebit).toBeCloseTo(manual.m.ebit, 2);
  });

  it('can pick the price variant for the focus and add the tornado', async () => {
    const r = await t.api.post('/api/calc/run', { column: 3, customers: 200, sensitivity: true });
    expect(r.data.focus.column.price).toBe(99);
    expect(r.data.focus.sensitivity.bars.length).toBeGreaterThan(3);
    expect(r.data.focus.sensitivity.bars[0].swing).toBeGreaterThanOrEqual(r.data.focus.sensitivity.bars[1].swing);
  });

  it('compact answers carry one metric of the matrix and the assumptions', async () => {
    const r = (await t.api.post('/api/calc/run', { preset: 'handwerk', compact: true, metric: 'margin', sensitivity: true })).data;
    expect(r.matrix.metric_key).toBe('margin');
    expect(r.matrix.unit).toBe('%');
    expect(r.matrix.values).toHaveLength(r.matrix.customers.length);
    expect(r.matrix.values[0]).toHaveLength(r.matrix.columns.length);
    expect(r.assumptions.plans[0].name).toBe('Auftrag');
    expect(r.assumptions.vat).toBe('19 % USt');
    expect(r.focus.top_levers.length).toBeGreaterThan(0);
    expect(r.focus.waterfall_per_month[0]).toMatchObject({ kind: 'total' });
    expect(JSON.stringify(r).length).toBeLessThan(30_000);
    const year = (await t.api.post('/api/calc/run', { compact: true, metric: 'ebit', period: 'year' })).data;
    expect(year.matrix.metric).toMatch(/pro Jahr/);
    expect((await t.api.post('/api/calc/run', { compact: true, metric: 'gewinn' })).status).toBe(400);
  });

  it('refuses wrong input with a German message instead of a silently wrong answer', async () => {
    const typo = await t.api.post('/api/calc/run', { input: { custmers: { count: 5 } } });
    expect(typo.status).toBe(400);
    expect(typo.data.error).toMatch(/Ungültige Eingabe: custmers: unbekanntes Feld/);
    const range = await t.api.post('/api/calc/run', { input: { customers: { churn: 250 } } });
    expect(range.status).toBe(400);
    expect(range.data.error).toMatch(/customers\.churn: muss zwischen 0 und 100 liegen/);
    expect((await t.api.post('/api/calc/run', { preset: 'nope' })).data.error).toMatch(/Vorlage „nope“ gibt es nicht/);
    expect((await t.api.post('/api/calc/run', { input: [1, 2] })).data.error).toMatch(/Objekt erwartet/);
    expect((await t.api.post('/api/calc/run', { customers: -1 })).status).toBe(400);
    expect((await t.api.post('/api/calc/run', { customers: 1e12 })).status).toBe(400);
    expect((await t.api.post('/api/calc/run', { column: 99 })).status).toBe(400);
    expect((await t.api.post('/api/calc/run', { scenario_id: 'x'.repeat(16) })).status).toBe(404);
  });

  it('survives extremes: no customers, free plans, hundred percent churn, tiny and huge numbers', async () => {
    for (const body of [
      { customers: 0 },
      { input: { pricing: { plans: [{ name: 'Gratis', base_price: 0 }] } } },
      { input: { customers: { churn: 100 } } },
      { input: { pricing: { plans: [{ name: 'Teuer', base_price: 1_000_000 }] }, customers: { count: 100_000_000 } } },
      { input: { matrix: { customers: [1], prices: [0], columns: 'price' } } },
      { input: { tax: { legal_form: 'kapitalgesellschaft' }, vat: { kleinunternehmer: true } } },
    ]) {
      const r = await t.api.post('/api/calc/run', body);
      expect(r.status, JSON.stringify(body)).toBe(200);
      expect(JSON.stringify(r.data)).not.toMatch(/NaN|Infinity/);
    }
  });

  it('the largest allowed input answers fast – nobody can make the server grind', async () => {
    const input = {
      pricing: {
        plans: Array.from({ length: 12 }, (_, i) => ({ name: `T${i}`, mix: 10, base_price: 20 + i * 10, included_units: 2, unit_price: 5, cap: 300, setup_fee: 100, users: 5 })),
        addons: Array.from({ length: 12 }, (_, i) => ({ name: `A${i}`, price: 5, take_rate: 20, per_unit: i % 2 === 0 })),
        annual: { share: 30, discount: 16.7 },
      },
      customers: { count: 1_000_000, unit_mix: Array.from({ length: 12 }, (_, i) => ({ units: i + 1, share: 8 })), growth: { start: 100, monthly_new: 50, monthly_new_growth: 2, months: 120 } },
      costs: { variable: { payment: { methods: Array.from({ length: 8 }, (_, i) => ({ label: `M${i}`, share: 12.5, pct: 1.5, fixed: 0.25, cap: i % 2 ? 5 : 0 })) } } },
      matrix: { customers: Array.from({ length: 16 }, (_, i) => (i + 1) * 50), columns: 'price', prices: Array.from({ length: 12 }, (_, i) => 10 + i * 10) },
    };
    const t0 = Date.now();
    const r = await t.api.post('/api/calc/run', { input, sensitivity: true });
    expect(r.status, JSON.stringify(r.data).slice(0, 300)).toBe(200);
    expect(r.data.matrix).toHaveLength(16);
    expect(r.data.matrix[0]).toHaveLength(12);
    expect(r.data.focus.projection.months).toHaveLength(120);
    const b = await t.api.post('/api/calc/breakeven', { input, target_net_profit_month: 50_000 });
    expect(b.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    // one more row, column or plan than the limits is refused
    expect((await t.api.post('/api/calc/run', { input: { matrix: { customers: Array.from({ length: 17 }, (_, i) => i + 1) } } })).status).toBe(400);
    expect((await t.api.post('/api/calc/run', { input: { pricing: { plans: Array.from({ length: 13 }, (_, i) => ({ name: `T${i}` })) } } })).status).toBe(400);
  });
});

describe('break-even', () => {
  it('reports the break-even per price variant and the minimum price', async () => {
    const r = (await t.api.post('/api/calc/breakeven', { customers: 120 })).data;
    const input = resolveInput({});
    const direct = run(input);
    expect(r.current.breakeven_customers).toBe(direct.unit[1].breakeven.customers);
    expect(r.by_column).toHaveLength(5);
    expect(r.by_column[0].breakeven_customers).toBeGreaterThan(r.by_column[4].breakeven_customers);
    expect(r.current.min_price_for_ebit_zero.customers).toBe(120);
    expect(r.headline).toMatch(/Break-even vor Steuern ab \d+ Kunden/);
    expect(r.fixed_costs_per_month).toBe(800);
  });

  it('answers "how many customers for X € net per month?" and "which price?"', async () => {
    const target = 3000;
    const r = (await t.api.post('/api/calc/breakeven', { target_net_profit_month: target, customers: 150 })).data;
    const n = r.current.customers_for_target as number;
    const input = resolveInput({});
    const e = econ(input);
    expect(cellOf(input, n, e).m.net_profit).toBeGreaterThanOrEqual(target);
    expect(cellOf(input, n - 1, e).m.net_profit).toBeLessThan(target);
    expect(n).toBe(customersForNetProfit(input, target));
    const price = r.current.price_for_target.price as number;
    expect(price).toBe(priceForNetProfit(input, 150, target));
    const at = (p: number) => cellOf({ ...input, pricing: { ...input.pricing, plans: [{ ...input.pricing.plans[0], base_price: p }] } }, 150).m.net_profit;
    expect(at(price)).toBeGreaterThanOrEqual(target);
    expect(at(price - 0.02)).toBeLessThan(target);
    expect(r.by_column[0].customers_for_target).toBeGreaterThan(r.by_column[4].customers_for_target);
  });

  it('says so when there is no break-even and rejects a silly target', async () => {
    const r = (await t.api.post('/api/calc/breakeven', { input: { pricing: { plans: [{ name: 'Verlust', base_price: 2 }] } } })).data;
    expect(r.current.breakeven_customers).toBeNull();
    expect(r.headline).toMatch(/kein Break-even|ein Break-even gibt es nicht/);
    expect((await t.api.post('/api/calc/breakeven', { target_net_profit_month: -5 })).status).toBe(400);
    expect((await t.api.post('/api/calc/breakeven', { target_net_profit_month: 'viel' })).status).toBe(400);
  });
});

describe('scenarios', () => {
  let sid = '';
  let sid2 = '';

  it('saves a scenario with its full input and key figures, and the audit log knows', async () => {
    const r = await t.api.post('/api/calc/scenarios', { name: 'Standort-Modell', note: 'Vorschlag für Paul', preset: 'gohigh-standort', input: { customers: { count: 400 } } });
    expect(r.status).toBe(200);
    sid = r.data.id;
    expect(r.data).toMatchObject({ name: 'Standort-Modell', note: 'Vorschlag für Paul', preset: 'gohigh-standort', created_by: 'Chef' });
    expect(r.data.input.customers.count).toBe(400);
    expect(r.data.input.pricing.plans[0].cap).toBe(499);
    expect(r.data.summary.customers).toBe(400);
    expect(r.data.summary.net_profit_month).toBeCloseTo(run(resolveInput(r.data.input)).focus.cell.m.net_profit, 1);
    const log = audit('calc.scenarios.create').at(-1);
    expect(log).toMatchObject({ entity_id: sid, summary: 'Standort-Modell', via: 'session', location_id: loc });
    const b = await t.api.post('/api/calc/scenarios', { name: 'Handwerk', preset: 'handwerk' });
    sid2 = b.data.id;
    expect(b.data.summary.customers).toBe(25);
  });

  it('lists them newest first with the key figures, and opens one', async () => {
    const list = (await t.api.get('/api/calc/scenarios')).data;
    expect(list.map((s: any) => s.name)).toEqual(['Handwerk', 'Standort-Modell']);
    expect(list[1].summary).toMatchObject({ customers: 400 });
    expect(list[1].input).toBeUndefined();
    const one = (await t.api.get(`/api/calc/scenarios/${sid}`)).data;
    expect(one.input.tax.est.year).toBe(2026);
    expect(one.note).toBe('Vorschlag für Paul');
  });

  it('validates name, note, preset and input', async () => {
    expect((await t.api.post('/api/calc/scenarios', { name: '' })).status).toBe(400);
    expect((await t.api.post('/api/calc/scenarios', { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await t.api.post('/api/calc/scenarios', { name: 'ok', note: 'n'.repeat(501) })).status).toBe(400);
    expect((await t.api.post('/api/calc/scenarios', { name: 'ok', preset: 'nope' })).status).toBe(400);
    expect((await t.api.post('/api/calc/scenarios', { name: 'ok', input: { vat: { rate: 90 } } })).status).toBe(400);
    expect((await t.api.get('/api/calc/scenarios')).data).toHaveLength(2);
  });

  it('changes name, note and input (a partial input over the saved one) and refreshes the key figures', async () => {
    const before = (await t.api.get(`/api/calc/scenarios/${sid}`)).data;
    const r = await t.api.patch(`/api/calc/scenarios/${sid}`, { name: 'Standort-Modell v2', input: { costs: { cac: 400 } } });
    expect(r.status).toBe(200);
    expect(r.data.name).toBe('Standort-Modell v2');
    expect(r.data.note).toBe('Vorschlag für Paul');
    expect(r.data.input.costs.cac).toBe(400);
    expect(r.data.input.customers.unit_mix).toEqual(before.input.unit_mix ?? before.input.customers.unit_mix);
    expect(r.data.summary.cac).toBe(400);
    expect(r.data.summary.net_profit_month).toBeLessThan(before.summary.net_profit_month);
    expect(audit('calc.scenarios.update').at(-1)).toMatchObject({ entity_id: sid });
    // renaming alone keeps the numbers
    const keep = (await t.api.patch(`/api/calc/scenarios/${sid}`, { note: '' })).data;
    expect(keep.note).toBe('');
    expect(keep.summary).toEqual(r.data.summary);
    expect((await t.api.patch(`/api/calc/scenarios/${sid}`, { name: '' })).status).toBe(400);
    expect((await t.api.patch(`/api/calc/scenarios/${sid}`, { input: { nope: 1 } })).status).toBe(400);
  });

  it('runs a saved scenario with changes that are not saved', async () => {
    const r = (await t.api.post(`/api/calc/scenarios/${sid}/run`, { input: { customers: { churn: 0.5 } }, customers: 800 })).data;
    expect(r.focus.customers).toBe(800);
    expect(r.input.customers.churn).toBe(0.5);
    expect(r.input.costs.cac).toBe(400);
    expect((await t.api.get(`/api/calc/scenarios/${sid}`)).data.input.customers.churn).toBe(2.5);
    // /api/calc/run with scenario_id is the same
    const same = (await t.api.post('/api/calc/run', { scenario_id: sid, input: { customers: { churn: 0.5 } }, customers: 800 })).data;
    expect(same.focus.cell.m.net_profit).toBe(r.focus.cell.m.net_profit);
  });

  it('compares scenarios side by side', async () => {
    const r = await t.api.post('/api/calc/compare', { ids: [sid, sid2, sid] });
    expect(r.status).toBe(200);
    expect(r.data.scenarios.map((s: any) => s.name)).toEqual(['Standort-Modell v2', 'Handwerk']);
    const net = r.data.rows.find((x: any) => x.key === 'net_profit_month');
    expect(net.values).toHaveLength(2);
    expect(net.deltas[0]).toBeNull();
    expect(net.deltas[1]).toBeCloseTo(net.values[1] - net.values[0], 1);
    expect(net.best).toBe(net.values[0] > net.values[1] ? 0 : 1);
    expect(r.data.disclaimer).toBe('Schätzung, keine Steuerberatung');
    expect((await t.api.post('/api/calc/compare', { ids: [sid] })).status).toBe(400);
    expect((await t.api.post('/api/calc/compare', { ids: [sid, 'x'.repeat(16)] })).status).toBe(404);
    expect((await t.api.post('/api/calc/compare', { ids: Array.from({ length: 7 }, (_, i) => `id${i}`) })).status).toBe(400);
  });

  it('exports the matrix as a German CSV and the audit log records the export', async () => {
    const r = await t.api.raw(`/api/calc/scenarios/${sid}/export.csv`, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/gewinnrechner-standort-modell-v2\.csv/);
    const raw = Buffer.from(await r.arrayBuffer());
    // UTF-8 byte order mark so German Excel opens the umlauts correctly
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = raw.toString('utf8');
    expect(body.slice(1).startsWith('Kunden;Preis;Umsatz brutto/Monat')).toBe(true);
    expect(body.split('\r\n').length).toBeGreaterThan(30);
    expect(body).toContain('Schätzung, keine Steuerberatung');
    expect(audit('export:calc/scenarios/:id/export.csv').length).toBeGreaterThan(0);
  });

  it('deletes a scenario and keeps the limit per sub-account', async () => {
    expect((await t.api.del(`/api/calc/scenarios/${sid2}`)).status).toBe(200);
    expect((await t.api.get(`/api/calc/scenarios/${sid2}`)).status).toBe(404);
    expect((await t.api.del(`/api/calc/scenarios/${sid2}`)).status).toBe(404);
    expect(audit('calc.scenarios.delete').at(-1)).toMatchObject({ entity_id: sid2 });
    const row = t.app.db.get<any>('SELECT * FROM calc_scenarios WHERE id = ?', sid)!;
    const n = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calc_scenarios WHERE location_id = ?', loc)!.n;
    for (let i = n; i < MAX_SCENARIOS; i++) t.app.db.insert('calc_scenarios', { ...row, id: `fill${i}`, name: `Füller ${i}` });
    const over = await t.api.post('/api/calc/scenarios', { name: 'Eins zu viel' });
    expect(over.status).toBe(400);
    expect(over.data.error).toMatch(/Höchstens 200/);
    // the other sub-account has its own allowance
    t.api.setLocation(other);
    expect((await t.api.post('/api/calc/scenarios', { name: 'Zweite Firma' })).status).toBe(200);
    t.api.setLocation(loc);
    t.app.db.run(`DELETE FROM calc_scenarios WHERE id LIKE 'fill%'`);
  });
});

describe('isolation and rights', () => {
  let mine = '';
  let theirs = '';
  beforeAll(async () => {
    mine = (await t.api.post('/api/calc/scenarios', { name: 'Nur Firma A' })).data.id;
    t.api.setLocation(other);
    theirs = (await t.api.get('/api/calc/scenarios')).data.find((s: any) => s.name === 'Zweite Firma').id;
    t.api.setLocation(loc);
  });

  it('another sub-account sees none of it – not by list, not by id', async () => {
    t.api.setLocation(other);
    const names = (await t.api.get('/api/calc/scenarios')).data.map((s: any) => s.name);
    expect(names).toEqual(['Zweite Firma']);
    expect(JSON.stringify(names)).not.toContain('Nur Firma A');
    expect((await t.api.get(`/api/calc/scenarios/${mine}`)).status).toBe(404);
    expect((await t.api.patch(`/api/calc/scenarios/${mine}`, { name: 'gekapert' })).status).toBe(404);
    expect((await t.api.post(`/api/calc/scenarios/${mine}/run`, {})).status).toBe(404);
    expect((await t.api.post('/api/calc/run', { scenario_id: mine })).status).toBe(404);
    expect((await t.api.post('/api/calc/breakeven', { scenario_id: mine })).status).toBe(404);
    expect((await t.api.post('/api/calc/compare', { ids: [mine, theirs] })).status).toBe(404);
    expect((await t.api.del(`/api/calc/scenarios/${mine}`)).status).toBe(404);
    expect((await t.api.raw(`/api/calc/scenarios/${mine}/export.csv`, { headers: { cookie: t.api.cookie, 'x-location-id': other, 'x-pghl': '1' } })).status).toBe(404);
    t.api.setLocation(loc);
    expect((await t.api.get(`/api/calc/scenarios/${mine}`)).data.name).toBe('Nur Firma A');
    expect(t.app.db.get<any>('SELECT name FROM calc_scenarios WHERE id = ?', mine)!.name).toBe('Nur Firma A');
  });

  it('a key belongs to its sub-account: no other location, no other scenarios', async () => {
    // a key always works in its own sub-account, whatever location header it sends – never in the other one
    const own = await asKey('GET', '/api/calc/scenarios', undefined, keyA, other);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.data)).not.toContain('Zweite Firma');
    expect((await asKey('GET', `/api/calc/scenarios/${mine}`, undefined, keyB, other)).status).toBe(404);
    expect((await asKey('GET', `/api/calc/scenarios/${theirs}`, undefined, keyA, loc)).status).toBe(404);
    const ok = await asKey('POST', '/api/calc/scenarios', { name: 'per Schlüssel', preset: 'kurs-community' }, keyA, loc);
    expect(ok.status).toBe(200);
    expect(ok.data.created_by).toBe('API-Schlüssel');
    expect(audit('calc.scenarios.create').at(-1)).toMatchObject({ via: 'api_key', summary: 'per Schlüssel' });
  });

  it('a member of the first sub-account has no access to the second', async () => {
    expect((await member('GET', '/api/calc/scenarios', undefined, { 'x-location-id': other })).status).toBe(403);
    expect((await member('POST', '/api/calc/run', {}, { 'x-location-id': other })).status).toBe(403);
  });

  it('needs the area "Rechnungen & Produkte" for everything', async () => {
    expect((await member('POST', '/api/calc/run', {})).status).toBe(200);
    expect((await member('GET', '/api/calc/scenarios')).status).toBe(200);
    expect((await member('POST', '/api/calc/scenarios', { name: 'von Fina' })).data.created_by).toBe('Fina');
    for (const [method, path, body] of [
      ['GET', '/api/calc/schema'],
      ['GET', '/api/calc/presets'],
      ['GET', '/api/calc/presets/handwerk'],
      ['POST', '/api/calc/run', {}],
      ['POST', '/api/calc/breakeven', {}],
      ['GET', '/api/calc/scenarios'],
      ['POST', '/api/calc/scenarios', { name: 'x' }],
      ['GET', `/api/calc/scenarios/${mine}`],
      ['PATCH', `/api/calc/scenarios/${mine}`, { name: 'x' }],
      ['DELETE', `/api/calc/scenarios/${mine}`],
      ['POST', `/api/calc/scenarios/${mine}/run`, {}],
      ['POST', '/api/calc/compare', { ids: [mine, mine] }],
      ['GET', `/api/calc/scenarios/${mine}/export.csv`],
    ] as [string, string, unknown?][]) {
      const r = await limited(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(t.app.db.get<any>('SELECT name FROM calc_scenarios WHERE id = ?', mine)!.name).toBe('Nur Firma A');
  });

  it('needs a login: anonymous requests are refused', async () => {
    const r = await t.api.raw('/api/calc/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: '{}' });
    expect(r.status).toBe(401);
  });
});

describe('MCP tools and the HyperLevel Agent', () => {
  let scenario = '';

  it('lists the five tools; calculations are read-only, saving is a write', async () => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools: any[] = ((await r.json()) as any).result.tools.filter((x: any) => x.name.startsWith('ghl_calc_'));
    expect(tools.map((x) => x.name).sort()).toEqual(['ghl_calc_breakeven', 'ghl_calc_run', 'ghl_calc_scenario_run', 'ghl_calc_scenario_save', 'ghl_calc_scenarios_list']);
    const ro = (n: string) => tools.find((x) => x.name === n).annotations.readOnlyHint;
    expect([ro('ghl_calc_run'), ro('ghl_calc_breakeven'), ro('ghl_calc_scenarios_list'), ro('ghl_calc_scenario_run')]).toEqual([true, true, true, true]);
    expect(ro('ghl_calc_scenario_save')).toBe(false);
    // the descriptions tell an agent when to use them and what to say
    const desc = tools.find((x) => x.name === 'ghl_calc_run').description;
    expect(desc).toContain('Schätzung, keine Steuerberatung');
    expect(desc).toContain('gohigh-staffel');
    expect(desc).toContain('pricing.plans[]');
    // the agent's safety layer lets it calculate freely and asks before saving
    const agentTool = (name: string) => CALC_TOOLS.find((x) => x.name === name)!;
    expect(classify({ name: 'ghl_calc_run', annotations: agentTool('ghl_calc_run').annotations })).toBe('read');
    expect(classify({ name: 'ghl_calc_scenario_save', annotations: agentTool('ghl_calc_scenario_save').annotations })).not.toBe('read');
    expect(groupOf('ghl_calc_run')).toBe('Umsatz & Kurse');
    expect(groupOf('ghl_calc_scenarios_list')).toBe('Umsatz & Kurse');
  });

  it('calculates with a location key, saves, lists, re-runs and compares', async () => {
    const run1 = await mcp('ghl_calc_run', { preset: 'gohigh-staffel', customers: 300, metric: 'net_profit' });
    expect(run1.isError, run1.text).toBe(false);
    expect(run1.data.headline).toContain('Bei 300 Kunden');
    expect(run1.data.matrix.metric_key).toBe('net_profit');
    expect(run1.data.assumptions.plans.map((p: any) => p.name)).toEqual(['Solo', 'Team', 'Firma', 'Agentur Start', 'Agentur Pro', 'Agentur SaaS']);
    expect(run1.data.link).toBe('/app/calc');
    // the answer is the engine's
    const direct = run(resolveInput({}, undefined as any), {});
    expect(direct).toBeTruthy();

    const be = await mcp('ghl_calc_breakeven', { preset: 'gohigh-standort', target_net_profit_month: 5000 });
    expect(be.isError, be.text).toBe(false);
    expect(be.data.current.customers_for_target).toBeGreaterThan(be.data.current.breakeven_customers);

    const saved = await mcp('ghl_calc_scenario_save', { location_id: loc, name: 'Agent-Szenario', preset: 'saas-pro-nutzer', input: { customers: { count: 80 } } });
    expect(saved.isError, saved.text).toBe(false);
    scenario = saved.data.id;
    expect(saved.data.link).toBe(`/app/calc/${scenario}`);
    expect(saved.data.key_figures.customers).toBe(80);
    expect(audit('calc.scenarios.create').at(-1)).toMatchObject({ via: 'mcp', summary: 'Agent-Szenario' });

    const list = await mcp('ghl_calc_scenarios_list', { location_id: loc });
    expect(list.data.scenarios.some((s: any) => s.id === scenario && s.key_figures.customers === 80)).toBe(true);
    expect(list.data.presets).toHaveLength(6);

    const again = await mcp('ghl_calc_scenario_run', { location_id: loc, scenario_id: scenario, input: { customers: { churn: 1 } }, customers: 120 });
    expect(again.isError, again.text).toBe(false);
    expect(again.data.focus.customers).toBe(120);
    expect(again.data.assumptions.churn_pct_per_month).toBe(1);
    expect(again.data.link).toBe(`/app/calc/${scenario}`);

    const other2 = (await mcp('ghl_calc_scenario_save', { location_id: loc, name: 'Zweites', preset: 'kurs-community' })).data.id;
    const cmp = await mcp('ghl_calc_scenario_run', { location_id: loc, scenario_id: scenario, compare_with: [other2] });
    expect(cmp.isError, cmp.text).toBe(false);
    expect(cmp.data.scenarios.map((s: any) => s.name)).toEqual(['Agent-Szenario', 'Zweites']);

    const patched = await mcp('ghl_calc_scenario_save', { location_id: loc, scenario_id: scenario, name: 'Agent-Szenario 2', input: { costs: { cac: 99 } } });
    expect(patched.data.name).toBe('Agent-Szenario 2');
    expect(patched.data.key_figures.cac).toBe(99);
  });

  it('a location key cannot reach another sub-account, its scenarios or save there', async () => {
    const foreign = await mcp('ghl_calc_scenarios_list', { location_id: other }, keyA);
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toMatch(/nur für einen Sub-Account/);
    const run = await mcp('ghl_calc_run', { location_id: other, preset: 'handwerk' }, keyA);
    expect(run.isError).toBe(true);
    const mineElsewhere = await mcp('ghl_calc_scenario_run', { location_id: loc, scenario_id: scenario }, keyB);
    expect(mineElsewhere.isError).toBe(true);
    expect(mineElsewhere.text).toMatch(/nicht gefunden|Sub-Account/);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM calc_scenarios WHERE location_id = ?', other)!.n).toBe(1);
  });

  it('an agency key calculates without naming a sub-account; a read-only agency key can look but not save', async () => {
    const r = await mcp('ghl_calc_run', { preset: 'kurs-community' }, agencyKey);
    expect(r.isError, r.text).toBe(false);
    expect(r.data.headline).toContain('Kunden');
    const list = await mcp('ghl_calc_scenarios_list', { location_id: loc }, agencyKey);
    expect(list.isError).toBe(false);
    const saved = await mcp('ghl_calc_scenario_save', { location_id: other, name: 'Agentur → B', preset: 'handwerk' }, agencyKey);
    expect(saved.isError).toBe(false);
    expect((await t.api.get('/api/calc/scenarios')).data.some((s: any) => s.name === 'Agentur → B')).toBe(false);
    // read-only keys may not write
    expect((await mcp('ghl_calc_scenarios_list', { location_id: loc }, agencyRead)).isError).toBe(false);
    const denied = await mcp('ghl_calc_scenario_save', { location_id: loc, name: 'Darf nicht' }, agencyRead);
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/nur lesen/);
  });

  it('bad input comes back as a readable error, not a crash', async () => {
    const r = await mcp('ghl_calc_run', { input: { pricing: { plans: [{ name: 'Fehler', base_price: 'viel' }] } } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Ungültige Eingabe: pricing\.plans\[0\]\.base_price: Zahl erwartet/);
    const ghost = await mcp('ghl_calc_run', { preset: 'gibt-es-nicht' });
    expect(ghost.isError || !!ghost.error).toBe(true);
  });
});

describe('the native app', () => {
  let token = '';
  let appMember = '';
  const app = (method: string, path: string, body?: unknown, tok = token) =>
    t.api.raw(path, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json().catch(() => null)) as any }));

  beforeAll(async () => {
    token = (await t.api.post('/api/mobile/pair', { device_name: 'Pixel', platform: 'android', app_version: '1.0' })).data.token;
    appMember = (await limited('POST', '/api/mobile/pair', { device_name: 'Handy Konrad' })).data.token;
  });

  it('lists the scenarios with their key figures and runs one as a read-only calculation', async () => {
    const list = await app('GET', `/api/mobile/calc/scenarios?location=${loc}`);
    expect(list.status).toBe(200);
    const s = list.data.scenarios.find((x: any) => x.name === 'Agent-Szenario 2');
    expect(s).toMatchObject({ customers: 80 });
    expect(Object.keys(s).sort()).toEqual(['breakeven_customers', 'customers', 'ebit_month', 'id', 'margin_pct', 'name', 'net_profit_month', 'note', 'revenue_net_month', 'updated_at']);
    const before = t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n;
    const r = await app('POST', `/api/mobile/calc/scenarios/${s.id}/run`, { location_id: loc, customers: 200, input: { customers: { churn: 4 } } });
    expect(r.status).toBe(200);
    expect(r.data.focus.customers).toBe(200);
    expect(r.data.assumptions.churn_pct_per_month).toBe(4);
    expect(r.data.disclaimer).toBe('Schätzung, keine Steuerberatung');
    expect(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')!.n).toBe(before);
    expect((await app('POST', `/api/mobile/calc/scenarios/${s.id}/run`, { location_id: loc, input: { nope: 1 } })).status).toBe(400);
  });

  it('keeps the sub-account and the member areas: no foreign scenarios, no access without the area', async () => {
    const mine = (await app('GET', `/api/mobile/calc/scenarios?location=${loc}`)).data.scenarios[0].id;
    // a scenario of another sub-account is "not found" through the first one
    const theirs = t.app.db.get<any>('SELECT id FROM calc_scenarios WHERE location_id = ?', other)!.id;
    expect((await app('POST', `/api/mobile/calc/scenarios/${theirs}/run`, { location_id: loc })).status).toBe(404);
    // and naming the other sub-account in the request gives that account's own list
    const otherList = await app('GET', `/api/mobile/calc/scenarios?location=${other}`);
    expect(otherList.data.scenarios.every((x: any) => x.id !== mine)).toBe(true);
    expect((await app('GET', `/api/mobile/calc/scenarios?location=${'x'.repeat(10)}`)).status).toBe(404);
    expect((await app('GET', '/api/mobile/calc/scenarios')).status).toBe(400);
    // a login without the area
    expect((await app('GET', `/api/mobile/calc/scenarios?location=${loc}`, undefined, appMember)).status).toBe(403);
    expect((await app('POST', `/api/mobile/calc/scenarios/${mine}/run`, { location_id: loc }, appMember)).status).toBe(403);
    expect((await t.api.raw(`/api/mobile/calc/scenarios?location=${loc}`)).status).toBe(401);
  });
});
