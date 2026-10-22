import { describe, expect, it } from 'vitest';
import { cleanQuoteDoc, defaultOption, isExpired, optionTotals, quoteContractText, quoteDocItems, quoteTotals, resolveSelection, selectedItems, validUntilFrom, type QuoteDoc } from '../server/services/quote-model.js';
import { LineError } from '../server/services/sales-lines.js';

let n = 0;
const mint = () => `qi${String(++n).padStart(4, '0')}`;
const clean = (input: Parameters<typeof cleanQuoteDoc>[0]) => cleanQuoteDoc(input, { defaultTax: 19, mint });
const item = (name: string, price_cents: number, extra: Record<string, unknown> = {}) => ({ name, qty: 1, price_cents, tax_rate: 19, ...extra });

const doc = (): QuoteDoc =>
  clean({
    items: [item('Einrichtung', 50000), item('Schulung', 20000, { optional: true, selected: false }), item('Support-Paket', 12000, { optional: true })],
    options: [
      { name: 'Basis', items: [item('Lizenz Basis', 100000)] },
      { name: 'Plus', recommended: true, description: 'Mit Extras', items: [item('Lizenz Plus', 180000), item('Premium-Support', 30000, { optional: true, selected: false })] },
    ],
  });

describe('building the offer', () => {
  it('keeps common positions, options and the optional flags; every id is unique across the quote', () => {
    const d = doc();
    expect(d.items.map((i) => [i.name, i.optional, i.selected])).toEqual([['Einrichtung', false, true], ['Schulung', true, false], ['Support-Paket', true, true]]);
    expect(d.options.map((o) => [o.name, o.recommended, o.items.length])).toEqual([['Basis', false, 1], ['Plus', true, 2]]);
    const ids = [...d.items, ...d.options.flatMap((o) => [o, ...o.items])].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only one option is recommended', () => {
    const d = clean({ options: [{ name: 'A', recommended: true, items: [item('a', 1)] }, { name: 'B', recommended: true, items: [item('b', 1)] }] });
    expect(d.options.map((o) => o.recommended)).toEqual([true, false]);
  });

  it('refuses what has no price to talk about', () => {
    expect(() => clean({})).toThrow(/mindestens eine Position/);
    expect(() => clean({ items: [item('nur optional', 100, { optional: true })] })).toThrow(/nicht optional/);
    expect(() => clean({ options: [{ name: '', items: [item('a', 1)] }] })).toThrow(/Name/);
    expect(() => clean({ options: [{ name: 'Leer', items: [] }] })).toThrow(/mindestens eine Position/);
    expect(() => clean({ items: 'x' })).toThrow(LineError);
    expect(() => clean({ items: [item('a', 1)], options: Array.from({ length: 7 }, (_, i) => ({ name: `O${i}`, items: [item('x', 1)] })) })).toThrow(/Höchstens 6/);
  });

  it('a duplicated position id from the editor is replaced, not shared', () => {
    const d = clean({ items: [item('a', 1, { id: 'same1234' })], options: [{ name: 'O', items: [item('b', 1, { id: 'same1234' })] }] });
    expect(d.items[0].id).toBe('same1234');
    expect(d.options[0].items[0].id).not.toBe('same1234');
  });
});

describe('what the customer chose', () => {
  it('without a choice: the recommended option and the pre-ticked positions', () => {
    const d = doc();
    const sel = resolveSelection(d);
    expect(sel.option_id).toBe(d.options[1].id);
    expect(defaultOption(d)?.name).toBe('Plus');
    expect(selectedItems(d, sel).map((i) => i.name)).toEqual(['Einrichtung', 'Support-Paket', 'Lizenz Plus']);
  });

  it('takes the option and the ticked optional positions of the choice, in page order', () => {
    const d = doc();
    const basis = d.options[0].id;
    const sel = resolveSelection(d, { option_id: basis, optional_ids: [d.items[1].id] });
    expect(selectedItems(d, sel).map((i) => i.name)).toEqual(['Einrichtung', 'Schulung', 'Lizenz Basis']);
    // an empty list unticks everything
    expect(selectedItems(d, resolveSelection(d, { option_id: basis, optional_ids: [] })).map((i) => i.name)).toEqual(['Einrichtung', 'Lizenz Basis']);
  });

  it('refuses a choice that is not in the offer', () => {
    const d = doc();
    expect(() => resolveSelection(d, { option_id: 'gibtsnicht' })).toThrow(/Variante/);
    expect(() => resolveSelection(d, { option_id: d.options[0].id, optional_ids: ['x'] })).toThrow(/optionale Position/);
    // an optional position of the other option cannot be ticked
    const premium = d.options[1].items[1].id;
    expect(() => resolveSelection(d, { option_id: d.options[0].id, optional_ids: [premium] })).toThrow(/optionale Position/);
    // a position that is not optional cannot be "ticked"
    expect(() => resolveSelection(d, { option_id: d.options[0].id, optional_ids: [d.items[0].id] })).toThrow(/optionale Position/);
  });

  it('accepting needs a choice when there are several options; a single option is simply part of the offer', () => {
    const d = doc();
    expect(() => resolveSelection(d, { optional_ids: [] }, true)).toThrow(/Variante wählen/);
    const one = clean({ items: [item('Basis', 100)], options: [{ name: 'Einzige', items: [item('Extra', 50)] }] });
    expect(resolveSelection(one, {}, true).option_id).toBe(one.options[0].id);
    expect(selectedItems(one, resolveSelection(one)).map((i) => i.name)).toEqual(['Basis', 'Extra']);
    const plain = clean({ items: [item('Nur das', 100)] });
    expect(resolveSelection(plain, null, true)).toEqual({ option_id: null, optional_ids: [] });
  });
});

describe('money', () => {
  it('totals follow the choice', () => {
    const d = doc();
    const basis = resolveSelection(d, { option_id: d.options[0].id, optional_ids: [] });
    expect(quoteTotals(d, basis)).toMatchObject({ subtotal_cents: 150000, tax_cents: 28500, total_cents: 178500 });
    const plus = resolveSelection(d, { option_id: d.options[1].id, optional_ids: [d.items[1].id, d.options[1].items[1].id] });
    expect(quoteTotals(d, plus).subtotal_cents).toBe(50000 + 20000 + 180000 + 30000);
  });

  it('price tags of the options use the default ticks', () => {
    expect(optionTotals(doc()).map((o) => o.totals.subtotal_cents)).toEqual([50000 + 12000 + 100000, 50000 + 12000 + 180000]);
  });

  it('the lines of the estimate are the chosen positions, discounts as their own lines', () => {
    const d = clean({ items: [item('Beratung', 100000, { discount_type: 'percent', discount_value: 10 })] });
    const items = quoteDocItems(d, resolveSelection(d));
    expect(items.map((i) => [i.name, i.price_cents])).toEqual([['Beratung', 100000], ['Rabatt 10 % auf Beratung', -10000]]);
  });
});

describe('validity', () => {
  it('counts days in the sub-account’s calendar and is open through the last day', () => {
    // 2026-11-01 23:30 UTC is already 02 November in Berlin
    expect(validUntilFrom(new Date('2026-11-01T23:30:00Z'), 30, 'Europe/Berlin')).toBe('2026-12-02');
    expect(validUntilFrom(new Date('2026-11-01T12:00:00Z'), 0, 'Europe/Berlin')).toBe('2026-11-01');
    expect(isExpired('2026-12-02', '2026-12-02')).toBe(false);
    expect(isExpired('2026-12-02', '2026-12-03')).toBe(true);
    expect(isExpired(null, '2030-01-01')).toBe(false);
  });
});

describe('the signed text', () => {
  it('names what was offered, what was chosen and what it costs', () => {
    const d = doc();
    const sel = resolveSelection(d, { option_id: d.options[1].id, optional_ids: [] });
    const totals = quoteTotals(d, sel);
    const text = quoteContractText({ number: 'AN-1001', title: 'Plattform', currency: 'EUR', valid_until: '2026-12-02', intro: 'Danke für das Gespräch.', terms: 'Zahlbar in 14 Tagen.', customer: 'Erika Muster', seller: 'Muster GmbH', doc: d, selection: sel, totals, deposit: { label: 'Anzahlung 30 %', total_cents: 100000 } });
    expect(text).toContain('# Angebot AN-1001');
    expect(text).toContain('Für: Erika Muster');
    expect(text).toContain('Gültig bis: 02.12.2026');
    expect(text).toContain('## Gewählte Variante: Plus');
    expect(text).toContain('- Lizenz Plus: 1 ×');
    expect(text).not.toContain('Lizenz Basis');
    expect(text).not.toContain('Premium-Support');
    expect(text).toMatch(/Gesamtbetrag: .*2\.?7\d\d,\d\d/);
    expect(text).toContain('Bei Annahme fällig: Anzahlung 30 %');
    expect(text).toContain('Zahlbar in 14 Tagen.');
  });
});
