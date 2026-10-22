import { describe, expect, it } from 'vitest';
import { fmtNum, getAt, leafOf, parseNum, setAt } from '../web/src/pages/CalcKit';
import { axisLabel, niceTicks } from '../web/src/pages/CalcCharts';
import { CalcInputError, defaultInput, normalizeInput, run } from '../server/services/calc-engine';
import { PRESETS, presetInput } from '../server/services/calc-presets';
import { EST_YEARS, SOLI_FREIGRENZE } from '../server/services/calc-tax';

/** Pure helpers behind the Gewinnrechner page: number fields, path editing, chart scales, and that every edit keeps the input valid. */

describe('number fields take German input', () => {
  it('parses decimal commas, thousands dots, units and rejects the rest', () => {
    expect(parseNum('12,5')).toBe(12.5);
    expect(parseNum('1.234,5')).toBe(1234.5);
    expect(parseNum('1.234.567')).toBe(1234567);
    expect(parseNum('12.5')).toBe(12.5);
    expect(parseNum(' 49 € ')).toBe(49);
    expect(parseNum('16,7 %')).toBe(16.7);
    expect(parseNum('-3')).toBe(-3);
    for (const bad of ['', '-', ',', 'abc', '1,2,3', '12x']) expect(parseNum(bad), bad).toBeNull();
  });

  it('shows numbers with a comma and without float noise', () => {
    expect(fmtNum(16.7)).toBe('16,7');
    expect(fmtNum(0.1 + 0.2)).toBe('0,3');
    expect(fmtNum(49)).toBe('49');
    expect(fmtNum(undefined)).toBe('');
    expect(fmtNum(NaN)).toBe('');
  });
});

describe('editing the input by path', () => {
  it('sets a field without touching the original and reads it back', () => {
    const a = defaultInput();
    const b = setAt(a, 'pricing.plans.0.base_price', 59);
    expect(a.pricing.plans[0].base_price).toBe(49);
    expect(b.pricing.plans[0].base_price).toBe(59);
    expect(getAt(b, 'pricing.plans.0.base_price')).toBe(59);
    expect(getAt(b, 'costs.fixed.nope.deeper')).toBeUndefined();
    expect(setAt(b, 'matrix.customers.1', 30).matrix.customers[1]).toBe(30);
  });

  it('finds the limits and the unit of every path the panel edits', () => {
    expect(leafOf('customers.churn')).toMatchObject({ unit: '% pro Monat', min: 0, max: 100 });
    expect(leafOf('pricing.plans.3.cap')).toMatchObject({ kind: 'number', unit: '€/Monat' });
    expect(leafOf('costs.variable.payment.methods.1.pct')?.desc).toMatch(/Prozent vom Bruttobetrag/);
    expect(leafOf('matrix.customers.4')).toMatchObject({ kind: 'number', max: 100_000_000 });
    expect(leafOf('tax.est.grundfreibetrag')?.desc).toMatch(/Grundfreibetrag/);
    expect(leafOf('customers.growth.months')).toMatchObject({ kind: 'integer', min: 1, max: 120 });
    expect(leafOf('nope.nothing')).toBeUndefined();
    expect(leafOf('pricing.plans')).toBeUndefined();
  });

  it('every field the panel offers stays valid at its limits (the engine never throws on what the page can produce)', () => {
    let input = defaultInput();
    const paths = ['pricing.plans.0.mix', 'pricing.plans.0.base_price', 'pricing.plans.0.cap', 'customers.count', 'customers.churn', 'customers.growth.months', 'vat.rate', 'costs.cac', 'costs.fixed.salaries', 'tax.vorsorge_monat', 'tax.gewerbesteuer.hebesatz', 'matrix.sensitivity_pct'];
    for (const p of paths) {
      const leaf = leafOf(p)!;
      for (const v of [leaf.min ?? 0, leaf.max ?? 1]) {
        input = setAt(input, p, v);
        const n = normalizeInput(input);
        const r = run(n, { sensitivity: true });
        expect(JSON.stringify(r), `${p} = ${v}`).not.toMatch(/NaN|Infinity/);
      }
      input = defaultInput();
    }
  });

  it('a combination the fields cannot rule out (tariff zones out of order) is a readable error the page shows, not a crash', () => {
    const input = setAt(defaultInput(), 'tax.est.grundfreibetrag', 10_000_000);
    expect(() => normalizeInput(input)).toThrow(CalcInputError);
    expect(() => normalizeInput(input)).toThrow(/die Zonen müssen aufsteigend sein/);
  });

  it('picking a tax year loads its tariff and Soli Freigrenze exactly as the select does', () => {
    for (const y of [2024, 2025, 2026]) {
      const input = setAt(setAt(defaultInput(), 'tax.est', { ...EST_YEARS[y] }), 'tax.soli.freigrenze', SOLI_FREIGRENZE[y]);
      expect(normalizeInput(input).tax.est.year).toBe(y);
    }
  });

  it('adding and removing list rows keeps the matrix pointing at an existing plan', () => {
    const input = presetInput('gohigh-staffel')!;
    input.matrix.plan_index = 5;
    input.pricing.plans.splice(5, 1);
    input.matrix.plan_index = Math.min(input.matrix.plan_index, input.pricing.plans.length - 1);
    expect(() => normalizeInput(input)).not.toThrow();
    const last = presetInput('handwerk')!;
    expect(() => run(normalizeInput(last))).not.toThrow();
    expect(PRESETS).toHaveLength(6);
  });
});

describe('chart scales', () => {
  it('ticks cover negative and positive values with round steps', () => {
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
    const t = niceTicks(-120, 450);
    expect(t[0]).toBeLessThanOrEqual(-120);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(450);
    expect(t).toContain(0);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(5, 5).includes(0)).toBe(true);
  });

  it('axis labels are short and use a real minus sign', () => {
    expect(axisLabel(1200)).toBe('1.200');
    expect(axisLabel(25000)).toBe('25 Tsd.');
    expect(axisLabel(-250000)).toBe('−250 Tsd.');
    expect(axisLabel(1_500_000)).toBe('1,5 Mio.');
    expect(axisLabel(0.5)).toBe('0,5');
  });
});
