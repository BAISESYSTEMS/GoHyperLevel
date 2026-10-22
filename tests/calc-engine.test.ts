import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  breakeven,
  cellOf,
  columnsOf,
  csvDe,
  defaultInput,
  detailOf,
  econ,
  exportRows,
  headline,
  inputSchema,
  mergeInput,
  minPrice,
  normalizeInput,
  planPrice,
  projection,
  resolveInput,
  rounded,
  run,
  sensitivity,
  specMarkdown,
  taxOf,
  unitEcon,
  waterfall,
  CalcInputError,
  type CalcInput,
} from '../server/services/calc-engine.js';
import { PRESETS, presetInput } from '../server/services/calc-presets.js';
import { EST_YEARS, estGrundtarif, estSplitting, gewerbesteuer, soliOnEst, taxCorp, taxEinzel } from '../server/services/calc-tax.js';

/** Input with everything switched off that is not under test: no VAT, no fees, no costs, no churn. */
const bare = (patch: Record<string, any> = {}): CalcInput =>
  resolveInput(
    mergeInput(
      {
        vat: { rate: 0 },
        customers: { churn: 0 },
        costs: {
          variable: { payment: { methods: [] }, hosting: { per_customer: 0 }, ai: { per_customer: 0 }, messaging: { per_customer: 0 }, support: { minutes_per_customer: 0 }, referral: { commission_pct: 0, share: 0 } },
          fixed: { servers_tools: 0, salaries: 0, insurance: 0, marketing: 0, other: 0 },
          cac: 0,
        },
        tax: { legal_form: 'keine' },
      },
      patch,
    ),
  );
const plan = (p: Record<string, any>) => ({ name: 'P', mix: 100, base_price: 0, included_units: 0, unit_price: 0, cap: 0, setup_fee: 0, users: 1, avg_units: 0, extra_cost: 0, note: '', ...p });

describe('price model: flat, included units, step price, cap', () => {
  const gohigh = plan({ base_price: 49, included_units: 3, unit_price: 10, cap: 499 });

  it('49 € incl. 3 locations, +10 € each, capped at 499 €', () => {
    expect(planPrice(gohigh, 1)).toBe(49);
    expect(planPrice(gohigh, 3)).toBe(49);
    expect(planPrice(gohigh, 4)).toBe(59);
    expect(planPrice(gohigh, 8)).toBe(99);
    expect(planPrice(gohigh, 48)).toBe(499); // 49 + 45 × 10 = 499 exactly
    expect(planPrice(gohigh, 49)).toBe(499); // 509 → capped
    expect(planPrice(gohigh, 500)).toBe(499);
  });

  it('per seat without base price, and no cap when cap is 0', () => {
    const seat = plan({ unit_price: 12 });
    expect(planPrice(seat, 8)).toBe(96);
    expect(planPrice(plan({ base_price: 10, unit_price: 5 }), 1000)).toBe(10 + 5 * 1000);
  });

  it('a distribution of units per customer: the cap acts per customer, not on the average', () => {
    const input = bare({ pricing: { plans: [gohigh] }, customers: { unit_mix: [{ units: 1, share: 50 }, { units: 100, share: 50 }] } });
    // 50 % pay 49 €, 50 % pay the cap 499 € = 274 €. The average of 50.5 units would only give 49 + 47.5 × 10 = 524 → 499… not 274.
    expect(econ(input).revenue_net).toBeCloseTo(274, 6);
    const average = bare({ pricing: { plans: [gohigh] }, customers: { avg_units: 50.5 } });
    expect(econ(average).revenue_net).toBe(499);
  });

  it('size bands and agency tiers: the customer mix gives the blended ARPU (shares are scaled to 100 %)', () => {
    const plans = [plan({ name: 'Solo', mix: 50, base_price: 49 }), plan({ name: 'Team', mix: 35, base_price: 99 }), plan({ name: 'Firma', mix: 15, base_price: 199 })];
    expect(econ(bare({ pricing: { plans } })).revenue_net).toBeCloseTo(0.5 * 49 + 0.35 * 99 + 0.15 * 199, 6);
    const scaled = plans.map((p) => ({ ...p, mix: p.mix / 10 }));
    expect(econ(bare({ pricing: { plans: scaled } })).revenue_net).toBeCloseTo(89, 6);
    // all zero → equal shares
    const equal = plans.map((p) => ({ ...p, mix: 0 }));
    expect(econ(bare({ pricing: { plans: equal } })).revenue_net).toBeCloseTo((49 + 99 + 199) / 3, 6);
  });

  it('per-plan units, extra cost and users', () => {
    const input = bare({
      pricing: { plans: [plan({ name: 'Agentur', base_price: 249, included_units: 5, unit_price: 0, avg_units: 15, users: 6, extra_cost: 25 })] },
      costs: { variable: { hosting: { per_customer: 1, per_user: 0.5, per_unit: 0.2 } } },
    });
    const e = econ(input);
    expect(e.revenue_net).toBe(249);
    expect(e.hosting).toBeCloseTo(1 + 0.5 * 6 + 0.2 * 15, 9);
    expect(e.other).toBeCloseTo(25, 9);
    expect(e.units).toBe(15);
    expect(e.users).toBe(6);
  });

  it('annual discount applies to the share of annual payers; add-ons per customer and per unit', () => {
    const input = bare({ pricing: { plans: [plan({ base_price: 100 })], annual: { share: 50, discount: 20 }, addons: [{ name: 'A', price: 10, take_rate: 50, per_unit: false }, { name: 'B', price: 2, take_rate: 100, per_unit: true }] }, customers: { avg_units: 4 } });
    // (100 + 10 × 0.5 + 2 × 4) × (1 − 0.5 × 0.2) = 113 × 0.9
    expect(econ(input).revenue_net).toBeCloseTo(113 * 0.9, 9);
  });

  it('setup fees come in per new customer (the ones replacing the churn)', () => {
    const input = bare({ pricing: { plans: [plan({ base_price: 50, setup_fee: 200 })] }, customers: { churn: 5 } });
    const c = cellOf(input, 100);
    expect(c.new_customers).toBe(5);
    expect(c.m.revenue_net).toBeCloseTo(100 * 50 + 5 * 200, 9);
  });
});

describe('Umsatzsteuer: net/gross, Kleinunternehmer, reverse charge, OSS', () => {
  it('net prices get 19 % on top; gross is what customers pay', () => {
    const e = econ(resolveInput({ vat: { rate: 19 }, costs: { variable: { payment: { methods: [] } } } }));
    expect(e.revenue_net).toBe(49);
    expect(e.vat).toBeCloseTo(9.31, 9);
    expect(e.revenue_gross).toBeCloseTo(58.31, 9);
  });

  it('gross prices are converted: 119 € incl. 19 % USt is 100 € net', () => {
    const e = econ(bare({ vat: { rate: 19 }, pricing: { price_basis: 'gross', plans: [plan({ base_price: 119 })] } }));
    expect(e.revenue_net).toBeCloseTo(100, 9);
    expect(e.revenue_gross).toBeCloseTo(119, 9);
  });

  it('7 % and 0 %', () => {
    expect(econ(bare({ vat: { rate: 7 }, pricing: { plans: [plan({ base_price: 100 })] } })).vat).toBeCloseTo(7, 9);
    expect(econ(bare({ vat: { rate: 0 }, pricing: { plans: [plan({ base_price: 100 })] } })).vat).toBe(0);
  });

  it('EU B2B pays no German USt (reverse charge), EU B2C the VAT of its country (21 %)', () => {
    const base = { vat: { rate: 19, eu_b2c_rate: 21 }, pricing: { plans: [plan({ base_price: 100 })] } };
    const b2b = econ(bare({ ...base, customers: { eu_share: 100, b2b_share: 100 } }));
    expect(b2b.vat).toBe(0);
    expect(b2b.revenue_gross).toBe(100);
    const b2c = econ(bare({ ...base, customers: { eu_share: 100, b2b_share: 0 } }));
    expect(b2c.vat).toBeCloseTo(21, 9);
    // 50 % Inland (19), 50 % EU B2B (0)
    const mixed = econ(bare({ ...base, customers: { eu_share: 50, b2b_share: 100 } }));
    expect(mixed.vat).toBeCloseTo(9.5, 9);
  });

  it('Kleinunternehmer: no USt on revenue, gross = net, input VAT is a cost; limit warnings', () => {
    const input = resolveInput({ vat: { kleinunternehmer: true, rate: 19, input_rate: 19 }, costs: { variable: { payment: { methods: [] }, hosting: { per_customer: 10, per_unit: 0 }, ai: { per_customer: 0 }, messaging: { per_customer: 0 }, support: { minutes_per_customer: 0 } }, fixed: { servers_tools: 100, salaries: 100, insurance: 100, marketing: 0, other: 0 } } });
    const e = econ(input);
    expect(e.vat).toBe(0);
    expect(e.revenue_gross).toBe(49);
    expect(e.hosting).toBeCloseTo(11.9, 9);
    // grossed up: servers/tools carry Vorsteuer, salaries and insurance do not
    expect(cellOf(input, 0).m.fixed).toBeCloseTo(119 + 100 + 100, 9);
    // gross prices stay as entered without USt
    expect(econ(resolveInput({ vat: { kleinunternehmer: true }, pricing: { price_basis: 'gross' } })).revenue_net).toBe(49);
    const big = run(resolveInput({ vat: { kleinunternehmer: true }, customers: { count: 1000 } }));
    expect(big.warnings.join(' ')).toContain('100.000');
    const mid = run(resolveInput({ vat: { kleinunternehmer: true }, customers: { count: 100 } }));
    expect(mid.warnings.join(' ')).toContain('25.000');
  });
});

describe('payment fees (Stripe: 1.5 % + 0.25 € on the gross charge)', () => {
  const fee = (patch: Record<string, any>) => econ(resolveInput(mergeInput({ vat: { rate: 19 }, costs: { variable: { payment: { methods: [{ label: 'Karte', share: 100, pct: 1.5, fixed: 0.25, cap: 0 }] } } } }, patch))).fees;

  it('49 € net → 58.31 € gross → 1.5 % + 0.25 €', () => {
    expect(fee({})).toBeCloseTo(0.015 * 58.31 + 0.25, 9);
  });

  it('annual payers are charged once a year: only one fixed fee for twelve months', () => {
    const yearly = fee({ pricing: { annual: { share: 100, discount: 0 } } });
    expect(yearly).toBeCloseTo((0.015 * 12 * 58.31 + 0.25) / 12, 9);
    expect(yearly).toBeLessThan(fee({}));
  });

  it('methods are blended by share and the cap applies per charge', () => {
    const both = fee({ costs: { variable: { payment: { methods: [{ label: 'Karte', share: 50, pct: 1.5, fixed: 0.25, cap: 0 }, { label: 'SEPA', share: 50, pct: 0.8, fixed: 0, cap: 5 }] } } } });
    expect(both).toBeCloseTo(0.5 * (0.015 * 58.31 + 0.25) + 0.5 * 0.008 * 58.31, 9);
    const capped = fee({ pricing: { plans: [plan({ base_price: 1000 })] }, costs: { variable: { payment: { methods: [{ label: 'SEPA', share: 100, pct: 0.8, fixed: 0, cap: 5 }] } } } });
    expect(capped).toBe(5);
  });

  it('fees of the setup fee are charged on its own gross amount; app-store customers pay no payment fees but the store fee', () => {
    const e = econ(resolveInput({ vat: { rate: 19 }, pricing: { plans: [plan({ base_price: 49, setup_fee: 100 })] } }));
    expect(e.setup_fees).toBeCloseTo(0.015 * 119 + 0.25, 9);
    const store = econ(resolveInput({ vat: { rate: 0 }, costs: { variable: { app_store: { fee_pct: 30, share: 100 } } } }));
    expect(store.fees).toBe(0);
    expect(store.app_store).toBeCloseTo(0.3 * 49, 9);
  });

  it('partner commission is a share of the net revenue of the referred customers', () => {
    const e = econ(bare({ costs: { variable: { referral: { commission_pct: 20, share: 25 } } } }));
    expect(e.referral).toBeCloseTo(49 * 0.2 * 0.25, 9);
  });
});

describe('ESt § 32a EStG (reference values from the formula, rounded down to full euros)', () => {
  const ref: Record<number, Record<number, number>> = {
    2024: { 11604: 0, 12000: 56, 15000: 581, 20000: 1759, 30000: 4446, 50000: 10906, 60000: 14680, 100000: 31397, 277825: 106084, 300000: 116063 },
    2025: { 12096: 0, 13000: 134, 15000: 485, 20000: 1639, 30000: 4303, 50000: 10691, 60000: 14415, 100000: 31088, 277825: 105774, 300000: 115753 },
    2026: { 12348: 0, 13000: 95, 15000: 435, 20000: 1570, 30000: 4217, 50000: 10548, 60000: 14233, 100000: 30864, 277825: 105550, 300000: 115529 },
  };
  for (const [year, table] of Object.entries(ref))
    it(`Grundtarif ${year}`, () => {
      for (const [zve, tax] of Object.entries(table)) expect(estGrundtarif(Number(zve), EST_YEARS[Number(year)]), `${year}: zvE ${zve}`).toBe(tax);
    });

  it('zone borders are continuous and the marginal rates are 42 % / 45 %', () => {
    for (const y of [2024, 2025, 2026]) {
      const p = EST_YEARS[y];
      expect(Math.abs(estGrundtarif(p.zone2_end, p) - estGrundtarif(p.zone2_end + 1, p))).toBeLessThanOrEqual(1);
      // above the zones the next 1000 € cost 420 € / 450 €
      expect(estGrundtarif(100000 + 1000, p) - estGrundtarif(100000, p)).toBeCloseTo(420, -1);
      expect(estGrundtarif(300000 + 1000, p) - estGrundtarif(300000, p)).toBeCloseTo(450, -1);
      expect(estGrundtarif(p.zone3_end, p)).toBeCloseTo(0.42 * p.zone3_end - p.sub4, -1);
    }
  });

  it('income is rounded down to full euros; negative and fractional income', () => {
    const p = EST_YEARS[2026];
    expect(estGrundtarif(30000.99, p)).toBe(estGrundtarif(30000, p));
    expect(estGrundtarif(-5, p)).toBe(0);
  });

  it('Splittingtarif: twice the tax on half', () => {
    const p = EST_YEARS[2026];
    expect(estSplitting(60000, p)).toBe(2 * estGrundtarif(30000, p));
    expect(estSplitting(60000, p)).toBeLessThan(estGrundtarif(60000, p));
  });

  it('the year alone loads that year\'s tariff and Soli Freigrenze', () => {
    const i = resolveInput({ tax: { est: { year: 2024 } } });
    expect(i.tax.est.grundfreibetrag).toBe(11604);
    expect(i.tax.soli.freigrenze).toBe(18130);
    // single fields stay editable
    const edited = resolveInput({ tax: { est: { year: 2026, grundfreibetrag: 13000 } } });
    expect(edited.tax.est.grundfreibetrag).toBe(13000);
    expect(edited.tax.est.zone2_end).toBe(17799);
  });
});

describe('Soli, Gewerbesteuer, § 35 EStG, KSt', () => {
  const soli = { rate: 5.5, freigrenze: 20350, milderung: 11.9 };

  it('Soli: nothing below the Freigrenze, a mitigation zone, then 5.5 %', () => {
    expect(soliOnEst(20350, soli, false)).toBe(0);
    expect(soliOnEst(20000, soli, false)).toBe(0);
    expect(soliOnEst(21000, soli, false)).toBeCloseTo(0.119 * 650, 9);
    expect(soliOnEst(40000, soli, false)).toBeCloseTo(0.055 * 40000, 9);
    // joint assessment: Freigrenze doubled
    expect(soliOnEst(40000, soli, true)).toBe(0);
    expect(soliOnEst(41000, soli, true)).toBeCloseTo(0.119 * 300, 9);
  });

  const gew = { enabled: true, hebesatz: 400, messzahl: 3.5, freibetrag: 24500, hinzurechnung: 0, s35_factor: 4 };

  it('Gewerbesteuer: Freibetrag 24 500 €, Gewerbeertrag rounded down to 100 €, Messzahl 3.5 %, Hebesatz', () => {
    expect(gewerbesteuer(24500, gew, 24500).gewst).toBe(0);
    expect(gewerbesteuer(-1000, gew, 24500).gewst).toBe(0);
    const g = gewerbesteuer(100099, gew, 24500);
    expect(g.ertrag).toBe(100000);
    expect(g.messbetrag).toBeCloseTo(75500 * 0.035, 9);
    expect(g.gewst).toBeCloseTo(75500 * 0.035 * 4, 9);
    expect(gewerbesteuer(100000, { ...gew, hebesatz: 480 }, 24500).gewst).toBeCloseTo(75500 * 0.035 * 4.8, 9);
    expect(gewerbesteuer(100000, { ...gew, enabled: false }, 24500).gewst).toBe(0);
    // corporations: no Freibetrag
    expect(gewerbesteuer(100000, gew, 0).gewst).toBeCloseTo(100000 * 0.035 * 4, 9);
  });

  const personal = (over: Record<string, any> = {}) => ({ est: EST_YEARS[2026], soli, church_enabled: false, church_rate: 9, joint: false, other_income: 0, deductions: 0, gewst: gew, vorsorge: 0, ...over });

  it('§ 35: at Hebesatz 400 the Gewerbesteuer is credited against the ESt completely', () => {
    const t = taxEinzel(30000, personal());
    expect(t.gewst).toBeCloseTo(770, 9); // (30 000 − 24 500) × 3.5 % × 400 %
    expect(t.s35).toBeCloseTo(770, 9);
    expect(t.est).toBeCloseTo(4217 - 770, 9);
    expect(t.total).toBeCloseTo(4217, 9); // = the ESt without Gewerbesteuer
  });

  it('§ 35: above Hebesatz 400 a rest stays; the credit never exceeds Gewerbesteuer or the ESt', () => {
    const t = taxEinzel(30000, personal({ gewst: { ...gew, hebesatz: 500 } }));
    expect(t.gewst).toBeCloseTo(962.5, 9);
    expect(t.s35).toBeCloseTo(770, 9);
    expect(t.total).toBeCloseTo(4217 + 192.5, 9);
    // credit limited by the ESt: tiny income, no Freibetrag
    const small = taxEinzel(13000, personal({ gewst: { ...gew, freibetrag: 0 } }));
    expect(small.gewst).toBeCloseTo(1820, 9);
    expect(small.s35).toBe(95);
    expect(small.est).toBe(0);
    expect(small.total).toBeCloseTo(1820, 9);
  });

  it('Soli and Kirchensteuer are computed on the ESt after the § 35 credit', () => {
    const t = taxEinzel(250000, personal({ church_enabled: true, church_rate: 9 }));
    expect(t.s35).toBeCloseTo(4 * (250000 - 24500) * 0.035, 6);
    const estBefore = estGrundtarif(250000, EST_YEARS[2026]);
    expect(t.est).toBeCloseTo(estBefore - t.s35, 6);
    expect(t.soli).toBeCloseTo(0.055 * t.est, 6);
    expect(t.church).toBeCloseTo(0.09 * t.est, 6);
    // inside the Milderungszone the surcharge is the smaller 11.9 % of the amount above the Freigrenze
    const mild = taxEinzel(150000, personal());
    expect(mild.soli).toBeCloseTo(0.119 * (mild.est - 20350), 6);
    expect(mild.soli).toBeLessThan(0.055 * mild.est);
  });

  it('Vorsorge, other income and joint assessment', () => {
    const base = taxEinzel(60000, personal());
    expect(taxEinzel(60000, personal({ vorsorge: 12000 })).est).toBeLessThan(base.est);
    // other income: only the extra tax caused by the profit is charged, at the higher marginal rate
    const withOther = taxEinzel(30000, personal({ other_income: 60000, gewst: { ...gew, enabled: false } }));
    expect(withOther.est).toBeCloseTo(estGrundtarif(90000, EST_YEARS[2026]) - estGrundtarif(60000, EST_YEARS[2026]), 6);
    expect(taxEinzel(60000, personal({ joint: true })).est).toBeLessThan(base.est);
    expect(taxEinzel(-10, personal()).total).toBe(0);
  });

  it('GmbH/UG: KSt 15 % + 5.5 % Soli on the KSt + Gewerbesteuer without Freibetrag', () => {
    const corp = { kst_rate: 15, soli_rate: 5.5, gewst: gew, distribution_pct: 0, dividend_rate: 25 };
    const t = taxCorp(100000, corp);
    expect(t.kst).toBe(15000);
    expect(t.soli).toBeCloseTo(825, 9);
    expect(t.gewst).toBeCloseTo(14000, 9);
    expect(t.est).toBe(0);
    expect(t.total).toBeCloseTo(29825, 9);
    expect(t.rate_pct).toBeCloseTo(29.825, 9);
    expect(taxCorp(-5, corp).total).toBe(0);
    // payout: Abgeltungsteuer 25 % + Soli on the distributed part of the profit after company taxes
    const paid = taxCorp(100000, { ...corp, distribution_pct: 50 });
    expect(paid.dividend_tax).toBeCloseTo(0.5 * (100000 - 29825) * 0.25 * 1.055, 6);
  });

  it('taxOf follows the legal form; losses pay nothing', () => {
    const e = resolveInput({ tax: { legal_form: 'einzelunternehmen' } });
    expect(taxOf(e, 100000).est).toBeGreaterThan(0);
    expect(taxOf(e, 100000).kst).toBe(0);
    expect(taxOf({ ...e, tax: { ...e.tax, legal_form: 'kapitalgesellschaft' } }, 100000).kst).toBe(15000);
    expect(taxOf({ ...e, tax: { ...e.tax, legal_form: 'keine' } }, 100000).total).toBe(0);
    expect(taxOf(e, -5000).total).toBe(0);
  });
});

describe('cells: from revenue to net profit', () => {
  it('the waterfall adds up from the gross payments to the net profit', () => {
    const input = resolveInput({ vat: { rate: 19 }, customers: { eu_share: 10, b2b_share: 50 }, pricing: { annual: { share: 30, discount: 16.7 }, plans: [plan({ base_price: 49, setup_fee: 99 })] }, tax: { vorsorge_monat: 600 } });
    const cell = cellOf(input, 250);
    for (const period of ['month', 'year'] as const) {
      const steps = waterfall(cell, period);
      const deltas = steps.filter((s) => s.kind === 'delta').reduce((s, x) => s + x.value, 0);
      const l = period === 'year' ? cell.y : cell.m;
      expect(steps[0].value + deltas).toBeCloseTo(l.net_profit, 6);
      const sub = (k: string) => steps.find((s) => s.key === k)!.value;
      expect(sub('revenue_net')).toBeCloseTo(l.revenue_gross - l.vat, 6);
      expect(sub('contribution')).toBeCloseTo(l.revenue_net - l.variable, 6);
      expect(sub('ebit')).toBeCloseTo(l.contribution - l.fixed - l.cac, 6);
    }
    // the order of the story
    const keys = waterfall(cell).map((s) => s.key);
    expect(keys.indexOf('vat')).toBeLessThan(keys.indexOf('fees'));
    expect(keys.indexOf('fees')).toBeLessThan(keys.indexOf('fixed_marketing'));
    expect(keys.indexOf('fixed_marketing')).toBeLessThan(keys.indexOf('tax_est'));
    expect(keys[keys.length - 1]).toBe('net_profit');
  });

  it('taxes are computed on the yearly profit and shown per month', () => {
    const input = resolveInput({ customers: { churn: 0 } });
    const c = cellOf(input, 500);
    expect(c.tax.total).toBeGreaterThan(0);
    expect(c.m.tax).toBeCloseTo(c.tax.total / 12, 9);
    expect(c.y.net_profit).toBeCloseTo(c.y.ebit - c.tax.total - c.y.vorsorge, 6);
    // a loss: no tax and no refund
    const loss = cellOf(input, 1);
    expect(loss.m.ebit).toBeLessThan(0);
    expect(loss.tax.total).toBe(0);
    expect(loss.m.net_profit).toBe(loss.m.ebit - loss.m.vorsorge);
  });

  it('Vorsorge only counts for Einzelunternehmen', () => {
    const e = resolveInput({ tax: { vorsorge_monat: 700 } });
    expect(cellOf(e, 100).m.vorsorge).toBe(700);
    expect(cellOf({ ...e, tax: { ...e.tax, legal_form: 'kapitalgesellschaft' } }, 100).m.vorsorge).toBe(0);
  });

  it('CAC is paid for the customers that replace the churn; no churn, no CAC', () => {
    const input = bare({ customers: { churn: 4 }, costs: { cac: 250 } });
    const c = cellOf(input, 200);
    expect(c.new_customers).toBe(8);
    expect(c.m.cac).toBe(2000);
    expect(cellOf(bare({ costs: { cac: 250 } }), 200).m.cac).toBe(0);
  });

  it('margins', () => {
    const c = cellOf(bare({ pricing: { plans: [plan({ base_price: 100 })] }, costs: { fixed: { other: 1000 } } }), 20);
    expect(c.m.revenue_net).toBe(2000);
    expect(c.m.ebit).toBe(1000);
    expect(c.ebit_margin).toBe(50);
    expect(c.margin).toBe(50);
    expect(cellOf(bare(), 0).margin).toBeNull();
  });
});

describe('break-even, LTV/CAC, payback, minimum price', () => {
  // 100 € per customer, nothing else variable, 5 % churn, CAC 200 €, fixed 1 000 € per month
  const input = bare({ pricing: { plans: [plan({ base_price: 100 })] }, customers: { churn: 5 }, costs: { cac: 200, fixed: { other: 1000 } } });

  it('break-even customers: first N with EBIT ≥ 0 (EBIT = 100·N − 10·N − 1000)', () => {
    const b = breakeven(input);
    expect(b.customers).toBe(12);
    expect(cellOf(input, 12).m.ebit).toBeGreaterThanOrEqual(0);
    expect(cellOf(input, 11).m.ebit).toBeLessThan(0);
    expect(b.revenue_net).toBe(1200);
    expect(b.customers_net).toBe(12); // no taxes, no Vorsorge
  });

  it('break-even after taxes and Vorsorge comes later', () => {
    const taxed = { ...input, tax: { ...input.tax, legal_form: 'einzelunternehmen' as const, vorsorge_monat: 500 } };
    const b = breakeven(taxed);
    expect(b.customers_net!).toBeGreaterThan(b.customers!);
    expect(cellOf(taxed, b.customers_net!).m.net_profit).toBeGreaterThanOrEqual(0);
    expect(cellOf(taxed, b.customers_net! - 1).m.net_profit).toBeLessThan(0);
  });

  it('never when a customer does not even cover its own costs', () => {
    const bad = bare({ pricing: { plans: [plan({ base_price: 5 })] }, costs: { variable: { hosting: { per_customer: 20 } }, fixed: { other: 100 } } });
    expect(breakeven(bad).customers).toBeNull();
    expect(breakeven(bad).customers_net).toBeNull();
    expect(breakeven(bare()).customers).toBe(0);
  });

  it('LTV = contribution × lifetime; LTV/CAC; payback months', () => {
    const u = unitEcon(input);
    expect(u.lifetime_months).toBeCloseTo(20, 9);
    expect(u.ltv).toBeCloseTo(2000, 9);
    expect(u.ltv_cac).toBeCloseTo(10, 9);
    expect(u.payback_months).toBeCloseTo(2, 9);
    expect(u.arpu_net).toBe(100);
  });

  it('without churn the lifetime is capped; without CAC the ratio is open and payback instant; setup fees shorten the payback', () => {
    const noChurn = unitEcon(bare({ pricing: { plans: [plan({ base_price: 100 })] }, customers: { churn: 0, max_lifetime_months: 24 }, costs: { cac: 100 } }));
    expect(noChurn.lifetime_months).toBe(24);
    expect(noChurn.ltv).toBe(2400);
    const free = unitEcon(bare({ pricing: { plans: [plan({ base_price: 100 })] } }));
    expect(free.ltv_cac).toBeNull();
    expect(free.payback_months).toBe(0);
    const setup = unitEcon(bare({ pricing: { plans: [plan({ base_price: 100, setup_fee: 100 })] }, costs: { cac: 200 } }));
    expect(setup.payback_months).toBeCloseTo(1, 9);
    const never = unitEcon(bare({ pricing: { plans: [plan({ base_price: 1 })] }, costs: { cac: 200, variable: { hosting: { per_customer: 5 } } } }));
    expect(never.payback_months).toBeNull();
  });

  it('minimum price for N customers (EBIT = 0)', () => {
    // N = 20: 20 · (p − 10) − 1000 ≥ 0 → p ≥ 60
    expect(minPrice(input, 20)).toBeCloseTo(60, 1);
    expect(minPrice(bare({ pricing: { plans: [plan({ base_price: 50 })] } }), 10)).toBe(0);
  });
});

describe('churn-adjusted projection', () => {
  const input = bare({ pricing: { plans: [plan({ base_price: 100 })] }, customers: { churn: 10, growth: { start: 0, monthly_new: 10, monthly_new_growth: 0, months: 36 } } });

  it('customers(t) = customers(t−1)·(1 − churn) + new', () => {
    const p = projection(input);
    expect(p.months[0].customers).toBe(10);
    expect(p.months[1].customers).toBeCloseTo(19, 9);
    expect(p.months[2].customers).toBeCloseTo(27.1, 9);
    expect(p.months[11].customers).toBeCloseTo(100 * (1 - 0.9 ** 12), 9);
    // approaches new / churn = 100
    expect(p.months[35].customers).toBeCloseTo(100 * (1 - 0.9 ** 36), 9);
    expect(p.months[35].customers).toBeLessThan(100);
  });

  it('MRR, ARR and the 12/24/36 month horizons', () => {
    const p = projection(input);
    expect(p.horizons.map((h) => h.months)).toEqual([12, 24, 36]);
    const h12 = p.horizons[0];
    expect(h12.mrr).toBeCloseTo(100 * 100 * (1 - 0.9 ** 12), 6);
    expect(h12.arr).toBeCloseTo(h12.mrr * 12, 6);
    expect(h12.revenue_net).toBeCloseTo(p.months.slice(0, 12).reduce((s, m) => s + m.revenue_net, 0), 6);
    expect(p.horizons[2].net_profit).toBeCloseTo(p.months.reduce((s, m) => s + m.net_profit, 0), 6);
    expect(p.horizons[2].customers).toBeGreaterThan(p.horizons[0].customers);
  });

  it('start customers, growing new customers, shorter horizons', () => {
    const grown = projection(bare({ pricing: { plans: [plan({ base_price: 100 })] }, customers: { churn: 0, growth: { start: 50, monthly_new: 10, monthly_new_growth: 10, months: 18 } } }));
    expect(grown.months).toHaveLength(18);
    expect(grown.horizons.map((h) => h.months)).toEqual([12]);
    expect(grown.months[0].customers).toBe(60);
    expect(grown.months[1].new_customers).toBeCloseTo(11, 9);
  });

  it('break-even month: cumulative net profit after the one-time investment stays ≥ 0', () => {
    const inv = bare({ pricing: { plans: [plan({ base_price: 100 })] }, customers: { churn: 0, growth: { start: 0, monthly_new: 10, monthly_new_growth: 0, months: 24 } }, costs: { fixed: { other: 500, one_time: 3000 } } });
    const p = projection(inv);
    const t = p.breakeven_month!;
    expect(t).not.toBeNull();
    expect(p.months[t - 1].cum_net).toBeGreaterThanOrEqual(0);
    expect(p.months[t - 2].cum_net).toBeLessThan(0);
    expect(p.ebit_positive_month).toBe(2); // month 1: 10 × 100 − 500 − 3000 < 0, month 2: 20 × 100 − 500 > 0
  });

  it('taxes are per fiscal year; a never-profitable business has no break-even month', () => {
    const losing = projection(bare({ pricing: { plans: [plan({ base_price: 10 })] }, costs: { fixed: { other: 5000 } }, customers: { growth: { start: 0, monthly_new: 1, monthly_new_growth: 0, months: 12 } } }));
    expect(losing.breakeven_month).toBeNull();
    expect(losing.ebit_positive_month).toBeNull();
    const taxed = projection(resolveInput({ customers: { churn: 1, growth: { start: 800, monthly_new: 20, monthly_new_growth: 0, months: 24 } } }));
    expect(taxed.months[0].tax).toBeGreaterThan(0);
    expect(taxed.months[0].tax).toBeCloseTo(taxed.months[11].tax, 9);
  });
});

describe('matrix, columns and run()', () => {
  it('rows × columns with monotone profit in customers', () => {
    const r = run(resolveInput({}));
    expect(r.rows).toEqual([10, 25, 50, 100, 250, 500, 1000, 5000]);
    expect(r.columns.map((c) => c.label)).toEqual(['29 €', '49 €', '79 €', '99 €', '149 €']);
    expect(r.matrix).toHaveLength(8);
    expect(r.matrix[0]).toHaveLength(5);
    for (let c = 0; c < 5; c++) for (let i = 1; i < 8; i++) expect(r.matrix[i][c].m.net_profit).toBeGreaterThan(r.matrix[i - 1][c].m.net_profit);
    for (let i = 0; i < 8; i++) for (let c = 1; c < 5; c++) expect(r.matrix[i][c].m.revenue_net).toBeGreaterThan(r.matrix[i][c - 1].m.revenue_net);
    expect(r.unit).toHaveLength(5);
    expect(r.disclaimer).toBe('Schätzung, keine Steuerberatung');
  });

  it('price columns replace the base price of the chosen plan only', () => {
    const input = resolveInput({ pricing: { plans: [plan({ name: 'A', mix: 50, base_price: 10 }), plan({ name: 'B', mix: 50, base_price: 100 })] }, matrix: { columns: 'price', prices: [20, 40], plan_index: 1 } });
    const { inputs } = columnsOf(input);
    expect(inputs[0].pricing.plans.map((p) => p.base_price)).toEqual([10, 20]);
    expect(inputs[1].pricing.plans.map((p) => p.base_price)).toEqual([10, 40]);
  });

  it('factor columns scale every price (base, step, cap, setup, add-ons)', () => {
    const input = resolveInput({ pricing: { plans: [plan({ base_price: 100, unit_price: 10, cap: 500, setup_fee: 50 })], addons: [{ name: 'A', price: 20, take_rate: 10, per_unit: false }] }, matrix: { columns: 'factor', factors: [0.5, 2] } });
    const { inputs, columns } = columnsOf(input);
    expect(inputs[0].pricing.plans[0]).toMatchObject({ base_price: 50, unit_price: 5, cap: 250, setup_fee: 25 });
    expect(inputs[1].pricing.addons[0].price).toBe(40);
    expect(columns[0].label).toContain('50 %');
    expect(columns[0].label).toContain('50 €');
  });

  it('plan columns show each plan on its own', () => {
    const input = resolveInput({ pricing: { plans: [plan({ name: 'Solo', mix: 50, base_price: 49 }), plan({ name: 'Team', mix: 50, base_price: 99 })] }, matrix: { columns: 'plan' } });
    const r = run(input);
    expect(r.columns.map((c) => c.label)).toEqual(['Solo', 'Team']);
    expect(r.unit.map((u) => u.arpu_net)).toEqual([49, 99]);
  });

  it('focus: the configured prices at customers.count, or a chosen column and customer count', () => {
    const input = resolveInput({ customers: { count: 300 }, pricing: { plans: [plan({ base_price: 49 })] } });
    const r = run(input);
    expect(r.focus.customers).toBe(300);
    expect(r.focus.cell.m.revenue_net).toBeCloseTo(300 * 49, 6);
    expect(r.focus.column.label).toBe('49 €');
    const other = run(input, { customers: 50, column: 2 });
    expect(other.focus.customers).toBe(50);
    expect(other.focus.column.label).toBe('79 €');
    expect(other.focus.cell.m.revenue_net).toBeCloseTo(50 * 79, 6);
    expect(other.focus.sensitivity).toBeUndefined();
    expect(run(input, { sensitivity: true }).focus.sensitivity!.bars.length).toBeGreaterThan(3);
    expect(headline(input, r.focus)).toContain('Bei 300 Kunden zu 49 €');
    expect(headline(input, r.focus)).toContain('Schätzung, keine Steuerberatung');
  });

  it('warns when the mix, the units or the payment methods do not add up to 100 %', () => {
    const w = run(resolveInput({ pricing: { plans: [plan({ mix: 30 }), plan({ mix: 30 })] }, customers: { unit_mix: [{ units: 1, share: 10 }] }, costs: { variable: { payment: { methods: [{ label: 'K', share: 50, pct: 1, fixed: 0, cap: 0 }] } } } })).warnings.join('\n');
    expect(w).toContain('Kunden-Mix');
    expect(w).toContain('Einheiten');
    expect(w).toContain('Zahlungsarten');
  });

  it('exports a table and a German CSV (semicolons, decimal comma, formula-safe)', () => {
    const r = run(resolveInput({ pricing: { plans: [plan({ name: '=HYPERLINK("x")', base_price: 49 })] }, matrix: { columns: 'plan', customers: [10] } }));
    const rows = exportRows(r);
    expect(rows[0][0]).toBe('Kunden');
    expect(rows).toHaveLength(1 + 1 + 2);
    const csv = csvDe(rows);
    expect(csv.startsWith('﻿Kunden;Preis;')).toBe(true);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('Schätzung, keine Steuerberatung');
    expect(csvDe([['a;b', 'c"d', 1.5, 'x\ny']])).toBe('﻿"a;b";"c""d";1,5;"x\ny"');
  });

  it('rounded() limits the output to cents and turns non-finite numbers into null', () => {
    expect(rounded({ a: 1.23456, b: [2.005, Infinity], c: 'x' })).toEqual({ a: 1.23, b: [2.01, null], c: 'x' });
  });
});

describe('sensitivity (tornado)', () => {
  it('ranks the levers by their swing and moves in the right direction', () => {
    const input = resolveInput({});
    const t = sensitivity(input, 250, 20);
    expect(t.pct).toBe(20);
    expect(t.bars.length).toBeGreaterThan(5);
    for (let i = 1; i < t.bars.length; i++) expect(t.bars[i - 1].swing).toBeGreaterThanOrEqual(t.bars[i].swing);
    const bar = (k: string) => t.bars.find((b) => b.key === k)!;
    expect(bar('price').high).toBeGreaterThan(bar('price').low);
    expect(bar('customers').high).toBeGreaterThan(bar('customers').low);
    expect(bar('churn').high).toBeLessThan(bar('churn').low); // more churn, less profit
    expect(bar('fixed').high).toBeLessThan(bar('fixed').low);
    expect(bar('price').swing).toBeGreaterThan(bar('support').swing);
    expect(t.base).toBeCloseTo(cellOf(input, 250).y.net_profit, 6);
    // levers without effect are left out (no add-ons, no referral share)
    expect(t.bars.find((b) => b.key === 'addons')).toBeUndefined();
    expect(t.bars.find((b) => b.key === 'referral')).toBeUndefined();
  });

  it('does not change the input', () => {
    const input = resolveInput({});
    const copy = JSON.stringify(input);
    sensitivity(input, 100);
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe('input: defaults, JSON schema, validation', () => {
  it('every field in the schema has a description and a default; all defaults pass validation', () => {
    const missing: string[] = [];
    const walk = (node: any, path: string) => {
      if (node.type === 'object') for (const [k, v] of Object.entries<any>(node.properties)) walk(v, `${path}.${k}`);
      else {
        if (!node.description) missing.push(`${path}: description`);
        if (!('default' in node)) missing.push(`${path}: default`);
        if (node.type === 'array' && node.items.type === 'object') for (const [k, v] of Object.entries<any>(node.items.properties)) walk(v, `${path}[].${k}`);
      }
    };
    const schema = inputSchema() as any;
    walk(schema, '');
    expect(missing).toEqual([]);
    expect(schema.$schema).toContain('json-schema.org');
    expect(() => normalizeInput(defaultInput())).not.toThrow();
    expect(normalizeInput({})).toEqual(defaultInput());
  });

  it('documents the German defaults', () => {
    const d = defaultInput();
    expect(d.vat.rate).toBe(19);
    expect(d.tax.gewerbesteuer).toMatchObject({ hebesatz: 400, freibetrag: 24500, messzahl: 3.5, s35_factor: 4 });
    expect(d.tax.kst).toMatchObject({ rate: 15, soli_rate: 5.5 });
    expect(d.tax.soli.rate).toBe(5.5);
    expect(d.tax.est.year).toBe(2026);
    expect(d.costs.variable.payment.methods[0]).toMatchObject({ pct: 1.5, fixed: 0.25 });
    expect(d.matrix.customers).toEqual([10, 25, 50, 100, 250, 500, 1000, 5000]);
  });

  it('unknown fields, wrong types and out-of-range values are errors with German messages', () => {
    const msg = (v: unknown) => {
      try {
        normalizeInput(v);
      } catch (e) {
        expect(e).toBeInstanceOf(CalcInputError);
        return (e as Error).message;
      }
      return '';
    };
    expect(msg({ custmers: { count: 5 } })).toContain('custmers: unbekanntes Feld');
    expect(msg({ customers: { count: 'viele' } })).toContain('customers.count: Zahl erwartet');
    expect(msg({ customers: { churn: 140 } })).toContain('zwischen 0 und 100');
    expect(msg({ customers: { count: 1.5 } })).toContain('ganze Zahl');
    expect(msg({ tax: { legal_form: 'ag' } })).toContain('einzelunternehmen, kapitalgesellschaft, keine');
    expect(msg({ pricing: { plans: [] } })).toContain('mindestens 1');
    expect(msg({ pricing: { plans: [{ name: 'x', preis: 3 }] } })).toContain('pricing.plans[0].preis');
    expect(msg({ vat: { kleinunternehmer: 'vielleicht' } })).toContain('ja/nein');
    expect(msg({ matrix: { plan_index: 3 } })).toContain('plan_index');
    expect(msg({ tax: { est: { grundfreibetrag: 99999 } } })).toContain('Zonen');
    expect(msg('text')).toContain('Objekt erwartet');
    // numbers as strings with a decimal comma are accepted
    expect(normalizeInput({ pricing: { plans: [{ base_price: '49,5' }] } }).pricing.plans[0].base_price).toBe(49.5);
  });

  it('a partial input merges over the defaults or a base; lists are replaced as a whole', () => {
    const r = resolveInput({ customers: { count: 300 }, matrix: { prices: [10, 20] } });
    expect(r.customers.count).toBe(300);
    expect(r.customers.churn).toBe(3);
    expect(r.matrix.prices).toEqual([10, 20]);
    const preset = presetInput('gohigh-standort')!;
    const over = resolveInput({ customers: { count: 10 } }, preset);
    expect(over.customers.count).toBe(10);
    expect(over.customers.unit_mix).toHaveLength(8);
    expect(over.pricing.plans[0].cap).toBe(499);
    expect(resolveInput({ pricing: { plans: [{ base_price: 20 }] } }).pricing.plans).toEqual([{ ...defaultInput().pricing.plans[0], base_price: 20 }]);
  });

  it('the defaults table in docs/gewinnrechner.md is the generated one', () => {
    const doc = readFileSync(new URL('../docs/gewinnrechner.md', import.meta.url), 'utf8');
    const m = doc.match(/<!-- defaults:start -->\n([\s\S]*?)\n<!-- defaults:end -->/);
    expect(m, 'markers <!-- defaults:start --> … <!-- defaults:end -->').toBeTruthy();
    expect(m![1]).toBe(specMarkdown());
    // the sources of the tax parameters are named
    for (const word of ['§ 32a EStG', 'Steuerfortentwicklungsgesetz', 'Freigrenze', '§ 35 EStG', 'Schätzung, keine Steuerberatung']) expect(doc).toContain(word);
  });
});

describe('presets', () => {
  it('all presets are valid and compute', () => {
    expect(PRESETS.map((p) => p.key)).toEqual(['gohigh-staffel', 'gohigh-standort', 'saas-pro-nutzer', 'agentur-retainer', 'kurs-community', 'handwerk']);
    for (const p of PRESETS) {
      const input = presetInput(p.key)!;
      expect(input, p.key).toBeTruthy();
      const r = run(input);
      expect(r.warnings, p.key).toEqual([]);
      expect(r.matrix.length, p.key).toBeGreaterThan(3);
      expect(r.matrix.flat().every((c) => Number.isFinite(c.m.net_profit)), p.key).toBe(true);
      // more customers never earn less once past the break-even
      expect(r.unit.every((u) => u.arpu_net >= 0 && Number.isFinite(u.contribution)), p.key).toBe(true);
      expect(p.description.length).toBeGreaterThan(30);
    }
    expect(presetInput('nope')).toBeNull();
  });

  it('HyperLevel Staffel: Solo 49 €, Team 99 €, Firma 199 €, Agentur-Stufen 99/249/449 €, mix 50/35/10/5 %', () => {
    const input = presetInput('gohigh-staffel')!;
    expect(input.pricing.plans.map((p) => [p.name, p.base_price])).toEqual([['Solo', 49], ['Team', 99], ['Firma', 199], ['Agentur Start', 99], ['Agentur Pro', 249], ['Agentur SaaS', 449]]);
    const mix = input.pricing.plans.map((p) => p.mix);
    expect(mix.slice(0, 3)).toEqual([50, 35, 10]);
    expect(mix.slice(3).reduce((s, x) => s + x, 0)).toBe(5);
    expect(mix.reduce((s, x) => s + x, 0)).toBe(100);
    // every band has included locations, a step price and an optional cap
    expect(input.pricing.plans.slice(0, 3).every((p) => p.included_units > 0 && p.unit_price > 0 && p.cap > p.base_price)).toBe(true);
    const e = econ(input);
    expect(e.revenue_net).toBeGreaterThan(60);
    expect(e.revenue_net).toBeLessThan(120);
    expect(detailOf(input, 300).cell.customers).toBe(300);
  });

  it('HyperLevel Standort-Modell: 49 € incl. 3 locations, +10 €, cap 499 €', () => {
    const input = presetInput('gohigh-standort')!;
    expect(input.pricing.plans).toHaveLength(1);
    expect(input.pricing.plans[0]).toMatchObject({ base_price: 49, included_units: 3, unit_price: 10, cap: 499 });
    expect(planPrice(input.pricing.plans[0], 60)).toBe(499);
    const expected = [
      [1, 35],
      [2, 20],
      [3, 15],
      [5, 12],
      [8, 8],
      [15, 6],
      [30, 3],
      [60, 1],
    ].reduce((s, [u, share]) => s + (planPrice(input.pricing.plans[0], u) * share) / 100, 0);
    // the Soli/VAT-free net ARPU of the unit distribution (annual discount applies on top)
    const a = input.pricing.annual;
    expect(econ(input).revenue_net).toBeCloseTo(expected * (1 - (a.share / 100) * (a.discount / 100)), 6);
  });

  it('Handwerk: jobs per month as customers, the job value as setup fee', () => {
    const input = presetInput('handwerk')!;
    const c = cellOf(input, 25);
    expect(c.new_customers).toBe(25);
    expect(c.m.revenue_net).toBeCloseTo((25 * 780) / 1.19, 4);
  });
});
