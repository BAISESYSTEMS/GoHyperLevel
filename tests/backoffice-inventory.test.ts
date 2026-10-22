import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { client } from './security-fixtures.js';
import { validEan } from '../server/modules/inventory.js';
import { matchItem } from '../server/services/inv-stock.js';

// Setting up a test app and logging in a few users takes long when the machine is busy.
vi.setConfig({ hookTimeout: 60_000 });

describe('EAN and invoice-line matching', () => {
  it('checks the EAN check digit (EAN-13, EAN-8, UPC-A, GTIN-14)', () => {
    expect(validEan('4006381333931')).toBe(true);
    expect(validEan('73513537')).toBe(true);
    expect(validEan('036000291452')).toBe(true);
    expect(validEan('04006381333931')).toBe(true);
    expect(validEan('4006381333932')).toBe(false);
    expect(validEan('12345')).toBe(false);
    expect(validEan('40063813339A1')).toBe(false);
  });

  it('finds the article of an invoice line by SKU in the text, product name or article name – and refuses ambiguity', () => {
    const arts = [
      { id: 'a1', sku: 'KAFFEE-500', name: 'Kaffee 500 g', ean: '', product_name: 'Bio-Kaffee' },
      { id: 'a2', sku: 'TASSE', name: 'Tasse weiß', ean: '' },
      { id: 'a3', sku: 'TASSE-2', name: 'Tasse weiß', ean: '' },
      { id: 'a4', sku: 'T-SHIRT-L', name: 'T-Shirt', ean: '', product_name: null },
    ];
    expect(matchItem({ name: 'Irgendwas [KAFFEE-500]', qty: 1 }, arts)?.id).toBe('a1');
    expect(matchItem({ name: 'Lieferung', description: 'SKU: t-shirt-l, Größe L', qty: 1 }, arts)?.id).toBe('a4');
    expect(matchItem({ name: 'tasse', qty: 1 }, arts)?.id).toBe('a2'); // the whole name is an SKU (case-insensitive)
    expect(matchItem({ name: ' Bio-Kaffee ', qty: 1 }, arts)?.id).toBe('a1'); // name of the linked product
    expect(matchItem({ name: 'Kaffee 500 g', qty: 1 }, arts)?.id).toBe('a1'); // the article's own name
    expect(matchItem({ name: 'Tasse weiß', qty: 1 }, arts)).toBeNull(); // two articles with that name: no guess
    expect(matchItem({ name: 'Beratung', qty: 1 }, arts)).toBeNull();
    expect(matchItem({ name: 'Teil [UNBEKANNT]', qty: 1 }, arts)).toBeNull();
  });
});

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const events: { type: string; data: any }[] = [];
const flush = () => t.app.events.flush();
const art = async (b: any) => {
  const r = await t.api.post('/api/inventory/articles', b);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const move = (b: any) => t.api.post('/api/inventory/movements', b);
const stockOf = async (id: string) => (await t.api.get(`/api/inventory/articles/${id}`)).data;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  for (const type of ['stock.low', 'purchase_order.received']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(() => t.close());

describe('articles and places', () => {
  it('creates articles with variants, SKU and EAN, rejects duplicates and bad EANs, and books the opening stock', async () => {
    const places = (await t.api.get('/api/inventory/places')).data;
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ name: 'Hauptlager', is_default: 1 });
    const shirt = await art({ sku: 'SHIRT', name: 'T-Shirt', unit: 'Stk' });
    const l = await art({ sku: 'SHIRT-L', name: 'T-Shirt', variant: 'Größe L', parent_id: shirt.id, ean: '4006381333931', min_stock: 3, initial_qty: 12, initial_cost_cents: 800 });
    expect(l).toMatchObject({ qty: 12, avg_cost_cents: 800, value_cents: 9600, variant: 'Größe L', parent_id: shirt.id, ean: '4006381333931' });
    expect((await stockOf(shirt.id)).variants.map((v: any) => v.sku)).toEqual(['SHIRT-L']);
    expect((await t.api.post('/api/inventory/articles', { sku: 'shirt-l', name: 'Doppelt' })).data.error).toMatch(/gibt es schon/);
    expect((await t.api.post('/api/inventory/articles', { sku: 'X1', name: 'Falsche EAN', ean: '4006381333932' })).data.error).toMatch(/EAN/);
    expect((await t.api.post('/api/inventory/articles', { sku: 'X2', name: '' })).status).toBe(400);
    expect((await t.api.post('/api/inventory/articles', { sku: 'X3', name: 'Minus', min_stock: -1 })).status).toBe(400);
    expect((await t.api.post('/api/inventory/articles', { sku: 'bad sku!', name: 'Zeichen' })).status).toBe(400);
    const auto = await art({ name: 'Ohne Nummer' });
    expect(auto.sku).toMatch(/^A-\d{4}$/);
    expect((await t.api.patch(`/api/inventory/articles/${auto.id}`, { parent_id: auto.id })).status).toBe(400);
    expect((await t.api.patch(`/api/inventory/articles/${auto.id}`, { name: 'Umbenannt', min_stock: 2.5 })).data).toMatchObject({ name: 'Umbenannt', min_stock: 2.5 });
    // Articles with history can only be deactivated; empty ones can go.
    expect((await t.api.del(`/api/inventory/articles/${l.id}`)).status).toBe(400);
    expect((await t.api.del(`/api/inventory/articles/${auto.id}`)).status).toBe(200);
  });

  it('links an article to a product and manages places (default, rename, no deactivation with stock)', async () => {
    const p = (await t.api.post('/api/products', { name: 'Bio-Kaffee', price_cents: 1290 })).data;
    const a = (await t.api.post('/api/inventory/articles/from-product', { product_id: p.id })).data;
    expect(a).toMatchObject({ name: 'Bio-Kaffee', product_id: p.id });
    expect((await t.api.post('/api/inventory/articles/from-product', { product_id: p.id })).data.id).toBe(a.id);
    expect((await t.api.post('/api/inventory/articles/from-product', { product_id: 'gibtsnicht' })).status).toBe(404);
    expect((await t.api.post('/api/inventory/articles', { sku: 'P2', name: 'x', product_id: 'gibtsnicht' })).status).toBe(400);
    const regal = (await t.api.post('/api/inventory/places', { name: 'Regal B', code: 'RB' })).data;
    expect((await t.api.post('/api/inventory/places', { name: 'Regal B' })).data.error).toMatch(/gibt es schon/);
    expect((await t.api.patch(`/api/inventory/places/${regal.id}`, { name: 'Regal B2' })).data.name).toBe('Regal B2');
    await move({ article_id: a.id, type: 'receipt', qty: 4, place_id: regal.id });
    expect((await t.api.patch(`/api/inventory/places/${regal.id}`, { active: false })).data.error).toMatch(/noch Ware/);
    expect((await t.api.del(`/api/inventory/places/${regal.id}`)).data.error).toMatch(/Bewegungen/);
    const main = (await t.api.get('/api/inventory/places')).data.find((x: any) => x.is_default);
    expect((await t.api.patch(`/api/inventory/places/${regal.id}`, { is_default: true })).data.is_default).toBe(1);
    expect(((await t.api.get('/api/inventory/places')).data.find((x: any) => x.id === main.id)).is_default).toBe(0);
  });
});

describe('stock movements, moving-average cost and valuation', () => {
  it('books receipts, issues, corrections and transfers with a log, per-place stock and a moving average', async () => {
    const a = await art({ sku: 'WIDGET', name: 'Widget' });
    const places = (await t.api.get('/api/inventory/places')).data;
    const main = places.find((p: any) => p.is_default);
    const lager2 = (await t.api.post('/api/inventory/places', { name: 'Außenlager' })).data;
    // 10 @ 10,00 € then 10 @ 20,00 € → 20 pieces at 15,00 €.
    expect((await move({ article_id: a.id, type: 'receipt', qty: 10, unit_cost_cents: 1000, place_id: main.id })).data.balance).toBe(10);
    const r2 = await move({ article_id: a.id, type: 'receipt', qty: 10, unit_cost_cents: 2000, place_id: main.id });
    expect(r2.data.balance).toBe(20);
    let d = await stockOf(a.id);
    expect(d).toMatchObject({ qty: 20, avg_cost_cents: 1500, last_cost_cents: 2000, value_cents: 30000 });
    // An issue goes out at the average; the average stays.
    await move({ article_id: a.id, type: 'issue', qty: 5, note: 'Verkauf' });
    d = await stockOf(a.id);
    expect(d).toMatchObject({ qty: 15, avg_cost_cents: 1500, value_cents: 22500 });
    expect(d.movements[0]).toMatchObject({ type: 'issue', qty: -5, unit_cost_cents: 1500, value_cents: -7500, balance: 15, note: 'Verkauf' });
    // Transfer between places.
    const tr = await t.api.post('/api/inventory/transfers', { article_id: a.id, from_place_id: main.id, to_place_id: lager2.id, qty: 6, note: 'Umzug' });
    expect(tr.status, JSON.stringify(tr.data)).toBe(200);
    d = await stockOf(a.id);
    expect(d.qty).toBe(15);
    expect(d.places.map((p: any) => [p.place, p.qty]).sort()).toEqual([['Außenlager', 6], [main.name, 9]].sort());
    const moves = (await t.api.get(`/api/inventory/movements?article_id=${a.id}`)).data;
    const pair = moves.filter((m: any) => m.transfer_id);
    expect(pair).toHaveLength(2);
    expect(pair[0].transfer_id).toBe(pair[1].transfer_id);
    expect(pair.map((m: any) => m.type).sort()).toEqual(['transfer_in', 'transfer_out']);
    expect(moves.every((m: any) => typeof m.type_label === 'string')).toBe(true);
    expect((await t.api.post('/api/inventory/transfers', { article_id: a.id, from_place_id: main.id, to_place_id: main.id, qty: 1 })).status).toBe(400);
    expect((await t.api.post('/api/inventory/transfers', { article_id: a.id, from_place_id: lager2.id, to_place_id: main.id, qty: 7 })).data.error).toMatch(/nicht ausreichend/);
    // Corrections may be negative.
    expect((await move({ article_id: a.id, type: 'correction', qty: -2, note: 'Bruch' })).data.balance).toBe(13);
    expect((await move({ article_id: a.id, type: 'correction', qty: 0 })).status).toBe(400);
    expect((await move({ article_id: a.id, type: 'issue', qty: -1 })).status).toBe(400);
    expect((await move({ article_id: a.id, type: 'bogus', qty: 1 })).status).toBe(400);
    expect((await move({ article_id: 'gibtsnicht', type: 'receipt', qty: 1 })).status).toBe(404);
    expect((await move({ article_id: a.id, type: 'receipt', qty: 1, unit_cost_cents: -5 })).status).toBe(400);
    // The goods issue below zero is refused unless the setting allows it.
    expect((await move({ article_id: a.id, type: 'issue', qty: 100 })).data.error).toMatch(/Bestand nicht ausreichend/);
    expect((await t.api.put('/api/inventory/settings', { allow_negative: true })).data.allow_negative).toBe(true);
    expect((await move({ article_id: a.id, type: 'issue', qty: 20, place_id: lager2.id })).status).toBe(200);
    await t.api.put('/api/inventory/settings', { allow_negative: false });
  });

  it('values the stock at moving-average cost, now and as of a day in the past', async () => {
    const a = await art({ sku: 'VAL-1', name: 'Bewertung' });
    await move({ article_id: a.id, type: 'receipt', qty: 10, unit_cost_cents: 1000 });
    await move({ article_id: a.id, type: 'receipt', qty: 10, unit_cost_cents: 2000 });
    await move({ article_id: a.id, type: 'issue', qty: 5 });
    const ms = t.app.db.all<any>('SELECT id FROM inv_movements WHERE article_id = ? ORDER BY rowid', a.id).map((m) => m.id);
    for (const [id, day] of [[ms[0], '2025-01-10'], [ms[1], '2025-02-10'], [ms[2], '2025-03-10']]) t.app.db.run('UPDATE inv_movements SET created_at = ? WHERE id = ?', `${day}T10:00:00.000Z`, id);
    const row = (v: any) => v.rows.find((r: any) => r.sku === 'VAL-1');
    const now = (await t.api.get('/api/inventory/valuation')).data;
    expect(row(now)).toMatchObject({ qty: 15, avg_cost_cents: 1500, value_cents: 22500 });
    expect(now.method).toMatch(/Durchschnitt/);
    expect(now.total_cents).toBe(now.rows.reduce((n: number, r: any) => n + r.value_cents, 0));
    expect(row((await t.api.get('/api/inventory/valuation?asof=2025-01-31')).data)).toMatchObject({ qty: 10, avg_cost_cents: 1000, value_cents: 10000 });
    expect(row((await t.api.get('/api/inventory/valuation?asof=2025-02-28')).data)).toMatchObject({ qty: 20, avg_cost_cents: 1500, value_cents: 30000 });
    expect(row((await t.api.get('/api/inventory/valuation?asof=2025-03-31')).data)).toMatchObject({ qty: 15, avg_cost_cents: 1500, value_cents: 22500 });
    expect(row((await t.api.get('/api/inventory/valuation?asof=2024-12-31')).data)).toBeUndefined();
    expect((await t.api.get('/api/inventory/valuation?asof=morgen')).status).toBe(400);
    const csv = await t.api.raw('/api/inventory/valuation?format=csv', { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
    const text = await csv.text();
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(text).toContain('"VAL-1";"Bewertung";"Stk";"15";"15,00";"225,00"');
    // Negative stock is not valued.
    const neg = await art({ sku: 'NEG-1', name: 'Minus' });
    await move({ article_id: neg.id, type: 'receipt', qty: 1, unit_cost_cents: 500 });
    t.app.db.run('UPDATE inv_stock SET qty = -3 WHERE article_id = ?', neg.id);
    expect((await t.api.get('/api/inventory/valuation')).data.rows.find((r: any) => r.sku === 'NEG-1')).toMatchObject({ qty: -3, value_cents: 0 });
  });
});

describe('minimum stock', () => {
  it('alerts once per drop: event for workflows, notification, re-armed when the stock recovers', async () => {
    const supplier = (await t.api.post('/api/contacts', { email: 'lieferant@example.com', first_name: 'Lena', last_name: 'Lieferant', company: 'Zulieferer GmbH' })).data;
    const sid = supplier.id ?? supplier.contact?.id;
    const a = await art({ sku: 'LOW-1', name: 'Mindestbestand', min_stock: 5, reorder_qty: 20, supplier_contact_id: sid, supplier_name: 'Zulieferer GmbH', initial_qty: 8 });
    events.length = 0;
    await move({ article_id: a.id, type: 'issue', qty: 2 }); // 6 > 5
    await flush();
    expect(events).toHaveLength(0);
    expect((await t.api.get('/api/inventory/low-stock')).data.find((x: any) => x.sku === 'LOW-1')).toBeUndefined();
    const hit = await move({ article_id: a.id, type: 'issue', qty: 1 }); // 5 ≤ 5
    expect(hit.data.low).toBe(true);
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ sku: 'LOW-1', qty: 5, min_stock: 5, reorder_qty: 20, contactId: sid, supplier: 'Zulieferer GmbH' });
    // No second alert while it stays low.
    await move({ article_id: a.id, type: 'issue', qty: 1 });
    await flush();
    expect(events).toHaveLength(1);
    const low = (await t.api.get('/api/inventory/low-stock')).data.find((x: any) => x.sku === 'LOW-1');
    expect(low).toMatchObject({ qty: 4, min_stock: 5, missing: 1, reorder_qty: 20, supplier: 'Zulieferer GmbH' });
    expect((await t.api.get('/api/inventory/stock?low=1')).data.some((x: any) => x.sku === 'LOW-1' && x.low)).toBe(true);
    // The admin is notified (push log), the push kind is not one of the user-configurable ones.
    expect(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM push_log WHERE kind = 'stock' AND title LIKE '%Mindestbestand%'`)!.n).toBeGreaterThan(0);
    // Back above the minimum, then below again: a new alert.
    await move({ article_id: a.id, type: 'receipt', qty: 20 });
    await move({ article_id: a.id, type: 'issue', qty: 20 });
    await flush();
    expect(events).toHaveLength(2);
    // Raising the minimum re-arms it as well.
    await t.api.patch(`/api/inventory/articles/${a.id}`, { min_stock: 10 });
    await move({ article_id: a.id, type: 'issue', qty: 1 });
    await flush();
    expect(events).toHaveLength(3);
    // Tracked off: no alert at all.
    const off = await art({ sku: 'LOW-OFF', name: 'Aus', min_stock: 5, initial_qty: 6, track: false });
    expect(off.low).toBe(false);
  });

  it('starts a workflow for the supplier when stock.low fires (reorder reminder)', async () => {
    const meta = (await t.api.get('/api/workflows/meta')).data;
    expect(meta.triggers).toEqual(expect.arrayContaining(['stock.low', 'purchase_order.received', 'receipt.booked', 'absence.approved']));
    const supplier = (await t.api.post('/api/contacts', { email: 'wf@example.com', first_name: 'Wanda', last_name: 'Workflow' })).data;
    const sid = supplier.id ?? supplier.contact?.id;
    const wf = (await t.api.post('/api/workflows', { name: 'Nachbestellen', trigger: { type: 'stock.low', config: {} }, steps: [{ type: 'add_tag', tags: ['nachbestellen'] }] })).data;
    expect((await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' })).status).toBe(200);
    const a = await art({ sku: 'LOW-WF', name: 'Workflow-Artikel', min_stock: 2, supplier_contact_id: sid, initial_qty: 3 });
    await move({ article_id: a.id, type: 'issue', qty: 2 });
    await flush();
    await flush();
    const c = (await t.api.get(`/api/contacts/${sid}`)).data;
    expect((c.tags ?? c.contact?.tags) as string[]).toContain('nachbestellen');
  });
});

describe('inventory count', () => {
  it('snapshots the expected stock, takes counted values and books the differences when closed', async () => {
    const a = await art({ sku: 'CNT-1', name: 'Zählartikel', initial_qty: 10, initial_cost_cents: 500 });
    const b = await art({ sku: 'CNT-2', name: 'Zählartikel 2', initial_qty: 4, initial_cost_cents: 1000 });
    const c = await art({ sku: 'CNT-3', name: 'Nicht gezählt', initial_qty: 7, initial_cost_cents: 100 });
    const main = (await t.api.get('/api/inventory/places')).data.find((p: any) => p.is_default);
    const start = await t.api.post('/api/inventory/counts', { name: 'Jahresinventur', place_id: main.id });
    expect(start.status, JSON.stringify(start.data)).toBe(200);
    const id = start.data.id;
    expect((await t.api.post('/api/inventory/counts', { name: 'Noch eine' })).data.error).toMatch(/läuft schon/);
    const line = (sku: string) => start.data.lines.find((l: any) => l.sku === sku);
    expect(line('CNT-1')).toMatchObject({ expected: 10, counted: null });
    // Something moves while counting: the difference is taken against the stock at closing time.
    await move({ article_id: a.id, type: 'issue', qty: 1 });
    const put = await t.api.put(`/api/inventory/counts/${id}/lines`, { lines: [{ id: line('CNT-1').id, counted: 7 }, { id: line('CNT-2').id, counted: 5 }] });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    expect(put.data.summary).toMatchObject({ counted: 2, differences: 2 });
    expect(put.data.lines.find((l: any) => l.sku === 'CNT-1')).toMatchObject({ diff: -3, diff_value_cents: -1500 });
    expect(put.data.lines.find((l: any) => l.sku === 'CNT-2')).toMatchObject({ diff: 1, diff_value_cents: 1000 });
    expect(put.data.summary).toMatchObject({ surplus_value_cents: 1000, shortage_value_cents: -1500 });
    expect((await t.api.put(`/api/inventory/counts/${id}/lines`, { lines: [{ id: line('CNT-1').id, counted: -1 }] })).status).toBe(400);
    const closed = await t.api.post(`/api/inventory/counts/${id}/close`, {});
    expect(closed.status, JSON.stringify(closed.data)).toBe(200);
    expect(closed.data.booked).toBe(2);
    expect((await stockOf(a.id)).qty).toBe(7);
    expect((await stockOf(b.id)).qty).toBe(5);
    expect((await stockOf(c.id)).qty).toBe(7); // not counted → untouched
    const m = (await t.api.get(`/api/inventory/movements?article_id=${a.id}&type=count`)).data;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ qty: -2, ref_type: 'count', ref_id: id });
    expect((await t.api.post(`/api/inventory/counts/${id}/close`, {})).data.error).toMatch(/schon abgeschlossen/);
    expect((await t.api.put(`/api/inventory/counts/${id}/lines`, { lines: [] })).data.error).toMatch(/abgeschlossen/);
    const cancel = await t.api.post('/api/inventory/counts', { name: 'Abbruch' });
    expect((await t.api.post(`/api/inventory/counts/${cancel.data.id}/cancel`, {})).status).toBe(200);
    expect(((await t.api.get('/api/inventory/counts')).data as any[]).map((x) => x.status)).toEqual(expect.arrayContaining(['closed', 'cancelled']));
  });
});

describe('purchase orders', () => {
  it('orders from a supplier contact, books partial and full goods receipts at the order price, and moves the average', async () => {
    const supplier = (await t.api.post('/api/contacts', { email: 'bestellung@example.com', first_name: 'Bernd', last_name: 'Besteller', company: 'Großhandel Nord' })).data;
    const sid = supplier.id ?? supplier.contact?.id;
    const a = await art({ sku: 'PO-1', name: 'Bestellartikel', initial_qty: 10, initial_cost_cents: 1000 });
    const b = await art({ sku: 'PO-2', name: 'Bestellartikel 2' });
    expect((await t.api.post('/api/inventory/orders', { lines: [{ article_id: a.id, qty: 5 }] })).data.error).toMatch(/Lieferanten/);
    expect((await t.api.post('/api/inventory/orders', { supplier_name: 'X', lines: [] })).status).toBe(400);
    expect((await t.api.post('/api/inventory/orders', { supplier_name: 'X', lines: [{ article_id: a.id, qty: 0 }] })).status).toBe(400);
    expect((await t.api.post('/api/inventory/orders', { contact_id: 'nope', lines: [{ article_id: a.id, qty: 1 }] })).status).toBe(400);
    const o = (await t.api.post('/api/inventory/orders', { contact_id: sid, expected_at: '2025-11-30', notes: 'Bitte anliefern', lines: [{ article_id: a.id, qty: 10, unit_cost_cents: 2000 }, { article_id: b.id, qty: 4, unit_cost_cents: 500 }] })).data;
    expect(o).toMatchObject({ status: 'draft', number: expect.stringMatching(/^BE-\d+$/), contact_name: 'Großhandel Nord', total_cents: 22000 });
    expect((await t.api.post(`/api/inventory/orders/${o.id}/receive`, { lines: [{ line_id: o.lines[0].id, qty: 1 }] })).status).toBe(200); // booking goods for a draft is allowed (delivery came first)
    const o2 = (await t.api.post('/api/inventory/orders', { supplier_name: 'Bar', lines: [{ article_id: b.id, qty: 1 }] })).data;
    expect(o2.number).not.toBe(o.number);
    // Edit lines of a draft, place it.
    const draft = (await t.api.post('/api/inventory/orders', { contact_id: sid, lines: [{ article_id: a.id, qty: 10, unit_cost_cents: 2000 }, { article_id: b.id, qty: 4, unit_cost_cents: 500 }] })).data;
    const edited = (await t.api.patch(`/api/inventory/orders/${draft.id}`, { lines: [{ article_id: a.id, qty: 10, unit_cost_cents: 2000 }, { article_id: b.id, qty: 4, unit_cost_cents: 500 }], notes: 'geändert' })).data;
    expect(edited.notes).toBe('geändert');
    expect((await t.api.post(`/api/inventory/orders/${draft.id}/place`, {})).data.status).toBe('ordered');
    expect((await t.api.patch(`/api/inventory/orders/${draft.id}`, { notes: 'zu spät' })).data.error).toMatch(/Entwürfe/);
    const lineA = edited.lines.find((l: any) => l.sku === 'PO-1');
    const lineB = edited.lines.find((l: any) => l.sku === 'PO-2');
    // Partial receipt: 4 of 10 at the order price → average of 10 @ 10,00 and 4 @ 20,00.
    const part = (await t.api.post(`/api/inventory/orders/${draft.id}/receive`, { lines: [{ line_id: lineA.id, qty: 4 }] })).data;
    expect(part.status).toBe('partial');
    expect(part.lines.find((l: any) => l.sku === 'PO-1').received).toBe(4);
    // (11 pieces were in stock from the first booking above: 10 + 1 @ 20,00 = avg 1091)
    expect((await stockOf(a.id)).qty).toBe(15);
    expect(events.filter((e) => e.type === 'purchase_order.received')).toHaveLength(0);
    // Receive the rest into another place, at a deviating price for one line.
    const place = (await t.api.post('/api/inventory/places', { name: 'Wareneingang' })).data;
    const full = (await t.api.post(`/api/inventory/orders/${draft.id}/receive`, { note: 'Lieferschein 77', lines: [{ line_id: lineA.id, qty: 6, place_id: place.id }, { line_id: lineB.id, qty: 4, unit_cost_cents: 550 }] })).data;
    expect(full.status).toBe('received');
    await flush();
    const ev = events.find((e) => e.type === 'purchase_order.received')!;
    expect(ev.data).toMatchObject({ orderId: draft.id, contactId: sid });
    expect((await stockOf(a.id)).qty).toBe(21);
    expect((await stockOf(b.id)).avg_cost_cents).toBe(550);
    const mv = (await t.api.get(`/api/inventory/movements?article_id=${a.id}`)).data.find((m: any) => m.ref_id === draft.id && m.place === 'Wareneingang');
    expect(mv).toMatchObject({ qty: 6, ref_type: 'po', unit_cost_cents: 2000 });
    expect(mv.note).toContain('Lieferschein 77');
    expect((await t.api.post(`/api/inventory/orders/${draft.id}/receive`, { lines: [{ line_id: lineA.id, qty: 1 }] })).data.error).toMatch(/kein Wareneingang/);
    expect((await t.api.post(`/api/inventory/orders/${draft.id}/cancel`, {})).data.error).toMatch(/schon abgeschlossen/);
    const fresh = (await t.api.post('/api/inventory/orders', { supplier_name: 'Y', lines: [{ article_id: b.id, qty: 2 }] })).data;
    expect((await t.api.post(`/api/inventory/orders/${fresh.id}/cancel`, {})).data.status).toBe('cancelled');
    expect((await t.api.post(`/api/inventory/orders/${o.id}/cancel`, {})).data.error).toMatch(/Ware gebucht/);
    expect(((await t.api.get('/api/inventory/orders?status=open')).data as any[]).every((x) => ['draft', 'ordered', 'partial'].includes(x.status))).toBe(true);
    expect((await t.api.del(`/api/inventory/articles/${b.id}`)).status).toBe(400);
  });

  it('sends the order to the supplier by e-mail', async () => {
    const supplier = (await t.api.post('/api/contacts', { email: 'mail@example.com', first_name: 'Mia', last_name: 'Mail', company: 'Mail-Handel' })).data;
    const sid = supplier.id ?? supplier.contact?.id;
    const a = await art({ sku: 'PO-MAIL', name: 'Mailartikel' });
    const o = (await t.api.post('/api/inventory/orders', { contact_id: sid, lines: [{ article_id: a.id, qty: 3, unit_cost_cents: 1250 }] })).data;
    const res = await t.api.post(`/api/inventory/orders/${o.id}/send`, {});
    // Without an e-mail provider the message is only logged – still handed over, the order counts as placed.
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.status).toBe('ordered');
    const msg = t.app.db.get<any>(`SELECT subject, body, status FROM messages WHERE location_id = ? AND source = 'Bestellung' ORDER BY created_at DESC`, loc)!;
    expect(msg.subject).toContain(o.number);
    expect(msg.body).toContain('PO-MAIL – Mailartikel: 3 Stk');
    expect(msg.body).toContain('12,50');
    const noContact = (await t.api.post('/api/inventory/orders', { supplier_name: 'Ohne Kontakt', lines: [{ article_id: a.id, qty: 1 }] })).data;
    expect((await t.api.post(`/api/inventory/orders/${noContact.id}/send`, {})).data.error).toMatch(/Kontakten/);
    const noMail = (await t.api.post('/api/contacts', { first_name: 'Ohne', last_name: 'Mail' })).data;
    const nm = (await t.api.post('/api/inventory/orders', { contact_id: noMail.id ?? noMail.contact?.id, lines: [{ article_id: a.id, qty: 1 }] })).data;
    expect((await t.api.post(`/api/inventory/orders/${nm.id}/send`, {})).data.error).toMatch(/E-Mail-Adresse/);
  });
});

describe('automatic goods issue from invoices', () => {
  it('takes matching articles out of stock when the invoice is paid (setting), once, and reports what it could not match', async () => {
    const a = await art({ sku: 'AUTO-1', name: 'Auto-Artikel', initial_qty: 10, initial_cost_cents: 300 });
    const p = (await t.api.post('/api/products', { name: 'Online-Produkt', price_cents: 1000 })).data;
    const b = await art({ sku: 'AUTO-2', name: 'Lager-Name', product_id: p.id, initial_qty: 5 });
    const inv = (await t.api.post('/api/invoices', { items: [{ name: 'Rechnungsposten [AUTO-1]', qty: 3, price_cents: 1000, tax_rate: 19 }, { name: 'Online-Produkt', qty: 2, price_cents: 1000, tax_rate: 19 }, { name: 'Beratung', qty: 1, price_cents: 9000, tax_rate: 19 }] })).data;
    // Default: when paid. Sending alone does nothing.
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' });
    expect((await stockOf(a.id)).qty).toBe(10);
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    await flush();
    expect((await stockOf(a.id)).qty).toBe(7);
    expect((await stockOf(b.id)).qty).toBe(3);
    const mv = (await t.api.get(`/api/inventory/movements?article_id=${a.id}&type=issue`)).data;
    expect(mv[0]).toMatchObject({ qty: -3, ref_type: 'invoice', ref_id: inv.id, unit_cost_cents: 300 });
    expect(mv[0].note).toContain(inv.number);
    // Replays and a manual run book nothing twice and name the line without an article.
    const again = await t.api.post(`/api/inventory/issue-from-invoice/${inv.id}`, {});
    expect(again.data).toMatchObject({ issued: [], unmatched: ['Beratung'] });
    await t.api.patch(`/api/invoices/${inv.id}`, { notes: 'noch ein Schreibvorgang' });
    expect((await stockOf(a.id)).qty).toBe(7);
    // "when sent": the issue happens with the invoice being issued.
    expect((await t.api.put('/api/inventory/settings', { auto_issue_on: 'sent' })).data.auto_issue_on).toBe('sent');
    const inv2 = (await t.api.post('/api/invoices', { items: [{ name: 'Auto-Artikel', qty: 1, price_cents: 1000, tax_rate: 19 }, { name: '[AUTO-1]', qty: 1, price_cents: 1000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv2.id}`, { status: 'sent' });
    expect((await stockOf(a.id)).qty).toBe(5); // "Auto-Artikel" is the article's name and "[AUTO-1]" its SKU: both lines are the same article, 1 + 1 pieces
  });

  it('can be switched off, skips drafts, estimates and articles that opt out, and never blocks on empty stock', async () => {
    await t.api.put('/api/inventory/settings', { auto_issue_on: 'off' });
    const a = await art({ sku: 'OFF-1', name: 'Aus-Artikel', initial_qty: 2 });
    const inv = (await t.api.post('/api/invoices', { items: [{ name: '[OFF-1]', qty: 1, price_cents: 1000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    await flush();
    expect((await stockOf(a.id)).qty).toBe(2);
    await t.api.put('/api/inventory/settings', { auto_issue_on: 'paid' });
    expect((await t.api.put('/api/inventory/settings', { auto_issue_on: 'jederzeit' })).status).toBe(400);
    const est = (await t.api.post('/api/invoices', { kind: 'estimate', items: [{ name: '[OFF-1]', qty: 1, price_cents: 1000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${est.id}`, { status: 'paid' });
    await flush();
    expect((await stockOf(a.id)).qty).toBe(2);
    expect((await t.api.post(`/api/inventory/issue-from-invoice/${est.id}`, {})).status).toBe(400);
    const draft = (await t.api.post('/api/invoices', { items: [{ name: '[OFF-1]', qty: 1, price_cents: 1000, tax_rate: 19 }] })).data;
    expect((await t.api.post(`/api/inventory/issue-from-invoice/${draft.id}`, {})).status).toBe(400);
    // The article opts out of the automatic issue.
    await t.api.patch(`/api/inventory/articles/${a.id}`, { auto_issue: false });
    const inv3 = (await t.api.post('/api/invoices', { items: [{ name: '[OFF-1]', qty: 1, price_cents: 1000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv3.id}`, { status: 'paid' });
    await flush();
    expect((await stockOf(a.id)).qty).toBe(2);
    // Empty stock: the invoice is still paid, the stock goes negative and the alert fires.
    await t.api.patch(`/api/inventory/articles/${a.id}`, { auto_issue: true, min_stock: 1 });
    const inv4 = (await t.api.post('/api/invoices', { items: [{ name: '[OFF-1]', qty: 5, price_cents: 1000, tax_rate: 19 }] })).data;
    await t.api.patch(`/api/invoices/${inv4.id}`, { status: 'paid' });
    await flush();
    expect((await t.api.get(`/api/invoices/${inv4.id}`)).data.status).toBe('paid');
    expect((await stockOf(a.id)).qty).toBe(-3);
    expect((await t.api.get('/api/inventory/low-stock')).data.find((x: any) => x.sku === 'OFF-1')).toMatchObject({ qty: -3 });
  });
});

describe('permissions, isolation and the MCP tools', () => {
  it('is its own area and keeps sub-accounts apart', async () => {
    const mk = async (email: string, permissions: string[]) => {
      expect((await t.api.post('/api/users', { email, name: email.split('@')[0], password: 'geheim-12345', role: 'member', locations: [loc], permissions })).status).toBe(200);
      const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
      expect((await c('POST', '/api/auth/login', { email, password: 'geheim-12345' })).status).toBe(200);
      return c;
    };
    const stock = await mk('lager@example.com', ['inventory']);
    const sales = await mk('vertrieb2@example.com', ['contacts']);
    for (const path of ['/api/inventory/status', '/api/inventory/articles', '/api/inventory/stock', '/api/inventory/low-stock', '/api/inventory/valuation', '/api/inventory/orders', '/api/inventory/counts', '/api/inventory/movements']) {
      expect((await stock('GET', path)).status, path).toBe(200);
      expect((await sales('GET', path)).status, path).toBe(403);
    }
    expect((await sales('POST', '/api/inventory/movements', { article_id: 'x', type: 'receipt', qty: 1 })).status).toBe(403);
    // Another sub-account sees nothing and cannot touch the rows by id.
    const other = (await t.api.post('/api/locations', { name: 'Lager-Zweitfirma' })).data.id;
    const h = { 'x-location-id': other };
    const mine = (await t.api.get('/api/inventory/articles')).data[0];
    expect((await t.api.get('/api/inventory/articles', h)).data).toEqual([]);
    expect((await t.api.get(`/api/inventory/articles/${mine.id}`, h)).status).toBe(404);
    expect((await t.api.post('/api/inventory/movements', { article_id: mine.id, type: 'receipt', qty: 1 }, h)).status).toBe(404);
    expect((await t.api.patch(`/api/inventory/articles/${mine.id}`, { name: 'Gekapert' })).status).toBe(200); // own sub-account: fine
    expect((await t.api.post('/api/inventory/transfers', { article_id: mine.id, from_place_id: 'x', to_place_id: 'y', qty: 1 }, h)).status).toBe(404);
    const place = (await t.api.get('/api/inventory/places')).data[0];
    expect((await t.api.get('/api/inventory/places', h)).data.every((p: any) => p.id !== place.id)).toBe(true);
    const order = ((await t.api.get('/api/inventory/orders')).data as any[])[0];
    expect((await t.api.get(`/api/inventory/orders/${order.id}`, h)).status).toBe(404);
    expect((await t.api.post(`/api/inventory/orders/${order.id}/cancel`, {}, h)).status).toBe(404);
    const cnt = ((await t.api.get('/api/inventory/counts')).data as any[])[0];
    expect((await t.api.get(`/api/inventory/counts/${cnt.id}`, h)).status).toBe(404);
    // A supplier contact of another sub-account cannot be linked.
    const foreign = (await t.api.post('/api/contacts', { email: 'fremd@example.com', first_name: 'Fremd' }, h)).data;
    expect((await t.api.post('/api/inventory/articles', { sku: 'FREMD', name: 'x', supplier_contact_id: foreign.id ?? foreign.contact?.id })).status).toBe(400);
    t.app.db.run('DELETE FROM locations WHERE id = ?', other);
  });

  it('keeps the supplier link out of erased contacts only', async () => {
    const c = (await t.api.post('/api/contacts', { email: 'weg@example.com', first_name: 'Weg' })).data;
    const cid = c.id ?? c.contact?.id;
    const a = await art({ sku: 'SUP-1', name: 'Mit Lieferant', supplier_contact_id: cid });
    expect((await t.api.post(`/api/contacts/${cid}/erase`, { confirm: 'weg@example.com' })).status).toBe(200);
    expect((await stockOf(a.id)).supplier_contact_id).toBeNull();
  });

  it('serves stock levels and low stock to the MCP tools', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'Claude' })).data.key;
    const rpc = async (name: string, args: any = {}) => {
      const r = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const j: any = await r.json();
      const text = j.result?.content?.[0]?.text;
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      return { error: j.error, result: j.result, data, text, isError: j.result?.isError };
    };
    const list = await t.api.raw('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const names = ((await list.json()) as any).result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_stock_levels', 'ghl_low_stock', 'ghl_stock_movement']));
    const levels = await rpc('ghl_stock_levels', { query: 'WIDGET' });
    expect(levels.data[0]).toMatchObject({ sku: 'WIDGET', unit: 'Stk' });
    expect((await rpc('ghl_stock_levels', { low_only: true })).data.every((x: any) => x.low)).toBe(true);
    expect((await rpc('ghl_low_stock')).data.length).toBeGreaterThan(0);
    const before = (await rpc('ghl_stock_levels', { query: 'WIDGET' })).data[0].qty;
    const mv = await rpc('ghl_stock_movement', { sku: 'widget', type: 'receipt', qty: 2, unit_cost_cents: 1500, note: 'per Agent' });
    expect(mv.isError).toBeFalsy();
    expect((await rpc('ghl_stock_levels', { query: 'WIDGET' })).data[0].qty).toBe(before + 2);
    expect((await rpc('ghl_stock_movement', { sku: 'gibtsnicht', type: 'receipt', qty: 1 })).isError).toBe(true);
  });
});
