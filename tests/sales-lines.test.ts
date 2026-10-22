import { describe, expect, it } from 'vitest';
import { calcTotals } from '../server/services/invoice-model.js';
import { LineError, NO_DEPOSIT, cleanDeposit, cleanLines, dealAmount, depositLines, docItems, lineAmounts, salesTotals, toNumber, type SalesLine } from '../server/services/sales-lines.js';

let n = 0;
const mint = () => `ln${String(++n).padStart(4, '0')}`;
const clean = (input: unknown, product?: Parameters<typeof cleanLines>[1]['product']) => cleanLines(input, { defaultTax: 19, mint, product });
const line = (extra: Partial<SalesLine> = {}): SalesLine => ({ id: mint(), product_id: null, name: 'Pos', description: '', qty: 1, unit: '', price_cents: 10000, discount_type: 'none', discount_value: 0, tax_rate: 19, ...extra });

describe('one position', () => {
  it('qty × price, rounded half away from zero in cents', () => {
    expect(lineAmounts(line({ qty: 3, price_cents: 1999 }))).toEqual({ list_cents: 5997, discount_cents: 0, net_cents: 5997 });
    expect(lineAmounts(line({ qty: 0.5, price_cents: 5 })).list_cents).toBe(3); // 2.5 → 3
    expect(lineAmounts(line({ qty: 1.2345, price_cents: 1000 })).list_cents).toBe(1235);
  });

  it('percent discount is taken off the line and rounded like tax', () => {
    expect(lineAmounts(line({ qty: 3, price_cents: 1999, discount_type: 'percent', discount_value: 10 }))).toEqual({ list_cents: 5997, discount_cents: 600, net_cents: 5397 });
    expect(lineAmounts(line({ price_cents: 1, discount_type: 'percent', discount_value: 50 })).discount_cents).toBe(1); // 0.5 → 1
    expect(lineAmounts(line({ price_cents: 10000, discount_type: 'percent', discount_value: 33.33 })).net_cents).toBe(6667);
    expect(lineAmounts(line({ discount_type: 'percent', discount_value: 100 })).net_cents).toBe(0);
  });

  it('a fixed discount never takes more than the line is worth; credit lines have none', () => {
    expect(lineAmounts(line({ price_cents: 10000, discount_type: 'amount', discount_value: 2500 })).net_cents).toBe(7500);
    expect(lineAmounts(line({ price_cents: 10000, discount_type: 'amount', discount_value: 99999 })).net_cents).toBe(0);
    expect(lineAmounts(line({ price_cents: -5000, discount_type: 'percent', discount_value: 10 })).net_cents).toBe(-5000);
  });
});

describe('totals', () => {
  it('tax per rate on the discounted net, the way the invoice does it', () => {
    const lines = [line({ qty: 2, price_cents: 5000, discount_type: 'percent', discount_value: 10, tax_rate: 19 }), line({ price_cents: 3333, tax_rate: 7 }), line({ price_cents: 1000, discount_type: 'amount', discount_value: 100, tax_rate: 19 })];
    const t = salesTotals(lines);
    // 19 %: 9000 + 900 = 9900 → tax 1881; 7 %: 3333 → tax 233
    expect(t).toMatchObject({ list_cents: 14333, discount_cents: 1100, subtotal_cents: 13233, tax_cents: 1881 + 233, total_cents: 13233 + 1881 + 233 });
    expect(t.groups.map((g) => [g.rate, g.net_cents, g.tax_cents])).toEqual([[19, 9900, 1881], [7, 3333, 233]]);
  });

  it('other tax treatments carry no tax', () => {
    const t = salesTotals([line({ price_cents: 10000 })], 'small_business');
    expect(t).toMatchObject({ subtotal_cents: 10000, tax_cents: 0, total_cents: 10000 });
  });

  it('the deal amount is the net sum in whole units, half away from zero', () => {
    expect(dealAmount(12345)).toBe(123);
    expect(dealAmount(12350)).toBe(124);
    expect(dealAmount(0)).toBe(0);
    expect(dealAmount(-12350)).toBe(-124);
  });

  it('the lines of a document add up to exactly the same totals (discount as its own negative line)', () => {
    // a deterministic pile of odd positions
    let seed = 7;
    const rnd = (max: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % max) + 0;
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + rnd(5) }, () =>
        line({ qty: (1 + rnd(2000)) / 100, price_cents: 1 + rnd(250000), tax_rate: [0, 7, 19, 5.5][rnd(4)], discount_type: (['none', 'percent', 'amount'] as const)[rnd(3)], discount_value: 0 }),
      ).map((l) => ({ ...l, discount_value: l.discount_type === 'percent' ? rnd(10000) / 100 : l.discount_type === 'amount' ? rnd(80000) : 0 }));
      const a = salesTotals(lines);
      const b = calcTotals(docItems(lines));
      expect([b.subtotal_cents, b.tax_cents, b.total_cents]).toEqual([a.subtotal_cents, a.tax_cents, a.total_cents]);
    }
  });

  it('a discount shows as its own line with the position’s tax rate', () => {
    const items = docItems([line({ name: 'Beratung', price_cents: 20000, discount_type: 'percent', discount_value: 12.5, tax_rate: 7 })]);
    expect(items).toEqual([
      { name: 'Beratung', qty: 1, price_cents: 20000, tax_rate: 7 },
      { name: 'Rabatt 12,5 % auf Beratung', qty: 1, price_cents: -2500, tax_rate: 7 },
    ]);
  });
});

describe('cleaning input', () => {
  const product = (id: string) => (id === 'p1' ? { id: 'p1', name: 'Wartungspaket', description: 'Jährlich', price_cents: 49900, tax_rate: 7 } : undefined);

  it('takes name, price and tax from the catalogue where the position does not say', () => {
    const [a, b] = clean([{ product_id: 'p1', qty: 2 }, { product_id: 'p1', qty: 1, price_cents: 40000, tax_rate: 19, name: 'Wartung Sonderpreis', description: '' }], product);
    expect(a).toMatchObject({ product_id: 'p1', name: 'Wartungspaket', description: 'Jährlich', price_cents: 49900, tax_rate: 7, qty: 2, discount_type: 'none' });
    expect(b).toMatchObject({ name: 'Wartung Sonderpreis', description: '', price_cents: 40000, tax_rate: 19 });
    expect(() => clean([{ product_id: 'weg' }], product)).toThrow(/Produkt/);
  });

  it('the default tax applies to a free-text position; German decimals are fine', () => {
    const [a] = clean([{ name: 'Reisekosten', qty: '1,5', price_cents: '1000', discount_type: 'percent', discount_value: '12,5' }]);
    expect(a).toMatchObject({ qty: 1.5, price_cents: 1000, tax_rate: 19, discount_type: 'percent', discount_value: 12.5, product_id: null });
    expect(toNumber('1,25', 0)).toBe(1.25);
    expect(toNumber('', 7)).toBe(7);
    expect(toNumber('abc', 7)).toBe(7);
  });

  it('refuses what cannot be calculated', () => {
    expect(() => clean('x')).toThrow(LineError);
    expect(() => clean([{ name: '' }])).toThrow(/Name/);
    expect(() => clean([{ name: 'a', qty: 0 }])).toThrow(/Menge/);
    expect(() => clean([{ name: 'a', qty: -1 }])).toThrow(/Menge/);
    expect(() => clean([{ name: 'a', tax_rate: 120 }])).toThrow(/Steuersatz/);
    expect(() => clean([{ name: 'a', discount_type: 'percent', discount_value: 101 }])).toThrow(/Rabatt/);
    expect(() => clean([{ name: 'a', discount_type: 'amount', discount_value: -5 }])).toThrow(/Rabatt/);
    expect(() => clean(Array.from({ length: 101 }, () => ({ name: 'x' })))).toThrow(/Höchstens/);
  });

  it('keeps valid ids once, mints the rest', () => {
    const out = clean([{ id: 'keep1234', name: 'a' }, { id: 'keep1234', name: 'b' }, { id: '!', name: 'c' }]);
    expect(out[0].id).toBe('keep1234');
    expect(new Set(out.map((l) => l.id)).size).toBe(3);
  });
});

describe('deposit', () => {
  const quote = salesTotals([line({ price_cents: 100000, tax_rate: 19 }), line({ price_cents: 50000, tax_rate: 7 })]);

  it('percent: every tax rate carries its share', () => {
    const d = depositLines(quote, { type: 'percent', value: 30 }, 'Anzahlung 30 %');
    expect(d.items).toEqual([
      { name: 'Anzahlung 30 % (19 % USt)', qty: 1, price_cents: 30000, tax_rate: 19 },
      { name: 'Anzahlung 30 % (7 % USt)', qty: 1, price_cents: 15000, tax_rate: 7 },
    ]);
    expect(d.totals).toMatchObject({ subtotal_cents: 45000, tax_cents: 5700 + 1050, total_cents: 45000 + 6750 });
  });

  it('a single rate keeps the plain label', () => {
    const one = salesTotals([line({ price_cents: 100000 })]);
    expect(depositLines(one, { type: 'percent', value: 25 }, 'Anzahlung').items).toEqual([{ name: 'Anzahlung', qty: 1, price_cents: 25000, tax_rate: 19 }]);
  });

  it('a fixed net amount is split in proportion and adds up to exactly the amount', () => {
    for (const amount of [1, 2, 99999, 100000, 123457, 150000]) {
      const d = depositLines(quote, { type: 'amount', value: amount }, 'Anzahlung');
      expect(d.totals.subtotal_cents).toBe(amount);
    }
    expect(() => depositLines(quote, { type: 'amount', value: 150001 }, 'x')).toThrow(/höher/);
    expect(() => depositLines(salesTotals([]), { type: 'percent', value: 30 }, 'x')).toThrow(/Betrag/);
  });

  it('is validated', () => {
    expect(cleanDeposit({ mode: 'deposit', type: 'percent', value: '30' })).toEqual({ mode: 'deposit', type: 'percent', value: 30 });
    expect(cleanDeposit({ mode: 'full' })).toMatchObject({ mode: 'full' });
    expect(cleanDeposit({}, NO_DEPOSIT)).toEqual(NO_DEPOSIT);
    expect(() => cleanDeposit({ mode: 'deposit', type: 'percent', value: 100 })).toThrow(/Anzahlung/);
    expect(() => cleanDeposit({ mode: 'deposit', type: 'percent', value: 0 })).toThrow(/Anzahlung/);
    expect(() => cleanDeposit({ mode: 'deposit', type: 'amount', value: -1 })).toThrow(/Betrag/);
    expect(() => cleanDeposit({ mode: 'deposit', value: 'x' })).toThrow(/Zahl/);
  });
});
