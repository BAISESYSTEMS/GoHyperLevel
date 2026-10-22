import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { cleanPicks, cleanType, maxPick, saleState } from '../server/services/ticket-events-model.js';
import { expireOrders } from '../server/services/ticket-events-core.js';

/**
 * Event ticket types (modules/ticket-events.ts, docs/booking.md#ticket-types): quotas and sold-out, no overselling under parallel
 * orders, sale windows and per-order limits, free vs. paid (payment registry with a fake Mollie), one QR ticket per seat, check-in
 * with the type (also through the appointment check-in), the report per type, the MCP read tool and sub-account isolation.
 */

const MOLLIE_KEY = 'test_fakeMollieKeyForTests00000000';
const payments = new Map<string, any>();
let n = 0;
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const payFake = async (url: string, init: any) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (init.headers.authorization !== `Bearer ${MOLLIE_KEY}`) return json({ status: 401, detail: 'Unauthorized' }, 401);
  if (u.pathname === '/v2/methods') return json({ _embedded: { methods: [{ id: 'ideal' }] } });
  if (u.pathname === '/v2/payments' && init.method === 'POST') {
    const id = `tr_tix${++n}`;
    const p = { id, status: 'open', amount: body.amount, metadata: body.metadata, _links: { checkout: { href: `https://www.mollie.com/checkout/${id}` } } };
    payments.set(id, p);
    return json(p, 201);
  }
  const m = u.pathname.match(/^\/v2\/payments\/([^/]+)(\/refunds)?$/);
  if (m && payments.has(m[1])) return m[2] ? json({ id: `re_${++n}`, amount: body.amount }, 201) : json(payments.get(m[1]));
  return json({ title: 'Not Found' }, 404);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const ordered: any[] = [];
const inDays = (d: number) => new Date(Date.now() + d * 864e5).toISOString();
const pub = (path: string, body?: unknown) =>
  t.api
    .raw(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: (r.headers.get('content-type') ?? '').includes('json') ? ((await r.json()) as any) : await r.text() }));
const buyer = { name: 'Klara Kundin', email: 'klara@example.com' };
const mkEvent = async (name: string, types: any[], extra: Record<string, unknown> = {}) => {
  const r = await t.api.post('/api/ticket-events', { name, starts_at: inDays(14), venue: 'Stadthalle', types, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.payFetch = payFake;
  await t.setup();
  loc = t.api.location;
  t.app.events.on('tickets.ordered', (e) => void ordered.push(e.data));
});
afterAll(async () => t?.close());

describe('rules (ticket-events-model)', () => {
  it('cleans types and knows the sale state', () => {
    expect(() => cleanType({ name: '' })).toThrow(/fehlt/);
    expect(() => cleanType({ name: 'A', price_cents: 20 })).toThrow(/mindestens/);
    expect(() => cleanType({ name: 'A', sale_start: '2026-11-02T10:00:00Z', sale_end: '2026-11-01T10:00:00Z' })).toThrow(/Verkaufsende/);
    expect(cleanType({ name: 'Frei' })).toMatchObject({ price_cents: 0, quota: null, max_per_order: null, active: 1 });
    const at = new Date('2026-11-01T12:00:00Z');
    const base = { active: 1, quota: 5, sale_start: null, sale_end: null };
    expect(saleState(base, 2, at)).toEqual({ state: 'on_sale', left: 3 });
    expect(saleState(base, 5, at).state).toBe('sold_out');
    expect(saleState({ ...base, sale_start: '2026-11-02T00:00:00Z' }, 0, at).state).toBe('not_yet');
    expect(saleState({ ...base, sale_end: '2026-11-01T00:00:00Z' }, 0, at).state).toBe('ended');
    expect(saleState(base, 0, at, '2026-11-01T11:00:00Z').state).toBe('ended');
    expect(saleState({ ...base, active: 0 }, 0, at).state).toBe('inactive');
    expect(maxPick({ max_per_order: 4 }, 2)).toBe(2);
    expect(maxPick({ max_per_order: null }, null)).toBe(10);
    expect(cleanPicks({ qty_a: '2', qty_b: '0', items: [{ type_id: 'a', qty: 1 }] })).toEqual([{ type_id: 'a', qty: 3 }]);
    expect(() => cleanPicks({ qty_a: '0' })).toThrow(/mindestens ein Ticket/);
  });
});

describe('free tickets: quota, QR per ticket, check-in, report', () => {
  it('sells a free type, one ticket each, and stops at the quota', async () => {
    const ev = await mkEvent('Sommerfest', [{ name: 'Stehplatz', quota: 3 }, { name: 'VIP', quota: 1, description: 'Mit Getränk' }]);
    const [steh, vip] = ev.types;
    expect(ev.url).toMatch(/\/book\/event\/sommerfest$/);
    const page = await pub('/book/event/sommerfest');
    expect(page.status).toBe(200);
    expect(page.data).toContain('Stehplatz');
    expect(page.data).toContain(`name="qty_${steh.id}"`);

    const r = await pub('/api/public/ticket-events/sommerfest/order', { ...buyer, items: [{ type_id: steh.id, qty: 2 }, { type_id: vip.id, qty: 1 }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'paid', total_cents: 0, pay_url: null });
    await t.app.events.flush();
    expect(ordered.some((d) => d.count === 3 && d.eventId === ev.id)).toBe(true);
    expect(r.data.tickets).toHaveLength(3);
    expect(new Set(r.data.tickets.map((x: any) => x.code)).size).toBe(3);
    // each ticket has its own page with QR code and type
    const one = await pub(new URL(r.data.tickets[2].url).pathname);
    expect(one.status).toBe(200);
    expect(one.data).toContain('<svg');
    expect(one.data).toContain('VIP');
    expect(one.data).toContain(r.data.tickets[2].code);
    const orderPage = await pub(new URL(r.data.order_url).pathname);
    expect((orderPage.data.match(/<svg/g) ?? []).length).toBe(3);

    // VIP is sold out now, Stehplatz has one left
    const over = await pub('/api/public/ticket-events/sommerfest/order', { ...buyer, items: [{ type_id: steh.id, qty: 2 }] });
    expect(over.status).toBe(409);
    expect(over.data.error).toMatch(/nur noch 1/);
    const vipAgain = await pub('/api/public/ticket-events/sommerfest/order', { ...buyer, items: [{ type_id: vip.id, qty: 1 }] });
    expect(vipAgain.status).toBe(409);
    expect(vipAgain.data.error).toMatch(/Ausverkauft/);
    expect((await pub('/book/event/sommerfest')).data).toContain('Ausverkauft');
    // the contact exists
    expect(t.app.db.get<any>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', loc, buyer.email)).toBeTruthy();

    // check-in shows the type; a second scan says "already"
    const code = r.data.tickets[2].code;
    const ci = await t.api.post('/api/ticket-events/checkin', { code: code.toLowerCase() });
    expect(ci.status, JSON.stringify(ci.data)).toBe(200);
    expect(ci.data).toMatchObject({ status: 'checked_in', type: 'VIP', name: 'Klara Kundin', event: 'Sommerfest' });
    expect((await t.api.post('/api/ticket-events/checkin', { code: r.data.tickets[2].url })).data.status).toBe('already');
    // the appointment check-in (and its MCP tool) takes event tickets too
    const viaAppt = await t.api.post('/api/appointment-checkin', { code: r.data.tickets[0].code });
    expect(viaAppt.status, JSON.stringify(viaAppt.data)).toBe(200);
    expect(viaAppt.data).toMatchObject({ kind: 'event_ticket', type: 'Stehplatz', status: 'checked_in' });
    expect((await t.api.post('/api/appointment-checkin', { code: 'XXXXXXXXXXXX' })).status).toBe(404);

    const rep = (await t.api.get(`/api/ticket-events/${ev.id}/report`)).data;
    expect(rep.types.map((x: any) => [x.name, x.sold, x.checked_in, x.left])).toEqual([
      ['Stehplatz', 2, 1, 1],
      ['VIP', 1, 1, 0],
    ]);
    expect(rep.totals).toMatchObject({ sold: 3, checked_in: 2, revenue_cents: 0 });
    // the agent's read tool
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_ticket_sales');
    expect(tool?.annotations.readOnlyHint).toBe(true);
    // a type with tickets cannot be removed, only deactivated
    expect((await t.api.patch(`/api/ticket-events/${ev.id}`, { types: [{ id: steh.id, name: 'Stehplatz', quota: 3 }] })).status).toBe(409);
    expect((await t.api.del(`/api/ticket-events/${ev.id}`)).status).toBe(409);
  });

  it('never oversells when many order at once', async () => {
    const ev = await mkEvent('Lesung', [{ name: 'Platz', quota: 5 }]);
    const tid = ev.types[0].id;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => pub('/api/public/ticket-events/lesung/order', { name: `Gast ${i}`, email: `gast${i}@example.com`, items: [{ type_id: tid, qty: 1 }] })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(15);
    expect(Number(t.app.db.get<any>(`SELECT COUNT(*) AS n FROM tix_tickets WHERE type_id = ? AND status = 'valid'`, tid).n)).toBe(5);
  });

  it('respects the sale window and the per-order maximum', async () => {
    const ev = await mkEvent('Workshop', [
      { name: 'Frühbucher', sale_start: inDays(-10), sale_end: inDays(-1) },
      { name: 'Normal', max_per_order: 2 },
      { name: 'Später', sale_start: inDays(3) },
    ]);
    const [early, normal, later] = ev.types;
    expect(ev.types.map((x: any) => x.state)).toEqual(['ended', 'on_sale', 'not_yet']);
    const order = (type_id: string, qty: number) => pub('/api/public/ticket-events/workshop/order', { ...buyer, items: [{ type_id, qty }] });
    expect((await order(early.id, 1)).data.error).toMatch(/Verkauf beendet/);
    expect((await order(later.id, 1)).data.error).toMatch(/noch nicht gestartet/);
    expect((await order(normal.id, 3)).data.error).toMatch(/höchstens 2/);
    expect((await order(normal.id, 2)).status).toBe(200);
    const html = (await pub('/book/event/workshop')).data as string;
    expect(html).toContain('Verkauf ab');
    expect(html).not.toContain(`name="qty_${early.id}"`);
    // the plain form: POST and redirect to the tickets
    const r = await t.api.raw('/book/event/workshop', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `name=Otto&email=otto%40example.com&qty_${normal.id}=1`, redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/\/book\/event-order\//);
    const bad = await t.api.raw('/book/event/workshop', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `name=Otto&email=otto%40example.com&qty_${early.id}=1` });
    expect(bad.status).toBe(409);
    expect(await bad.text()).toContain('Verkauf beendet');
  });
});

describe('paid tickets through the payment registry', () => {
  it('holds tickets while paying, makes them valid with a paid invoice, releases expired holds', async () => {
    const free = await mkEvent('Ohne Zahlung', [{ name: 'Karte', price_cents: 1500, quota: 2 }]);
    // no provider set up: refused, nothing reserved
    const none = await pub('/api/public/ticket-events/ohne-zahlung/order', { ...buyer, items: [{ type_id: free.types[0].id, qty: 1 }] });
    expect(none.status).toBe(409);
    expect(none.data.error).toMatch(/nicht eingerichtet/);
    expect(Number(t.app.db.get<any>('SELECT COUNT(*) AS n FROM tix_tickets WHERE event_id = ?', free.id).n)).toBe(0);

    expect((await t.api.put('/api/pay/providers/mollie', { api_key: MOLLIE_KEY })).status).toBe(200);
    const ev = await mkEvent('Konzert', [{ name: 'Parkett', price_cents: 2500, quota: 2 }, { name: 'Gratis', quota: 10 }], { tax_rate: 7 });
    const [parkett] = ev.types;
    const r = await pub('/api/public/ticket-events/konzert/order', { ...buyer, items: [{ type_id: parkett.id, qty: 2 }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'pending', total_cents: 5000 });
    expect(r.data.pay_url).toMatch(/\/pay\/ps_/);
    // held: counts against the quota, the ticket page is not reachable yet
    expect((await pub('/api/public/ticket-events/konzert/order', { ...buyer, items: [{ type_id: parkett.id, qty: 1 }] })).status).toBe(409);
    expect((await pub(new URL(r.data.tickets[0].url).pathname)).status).toBe(404);
    expect((await t.api.post('/api/ticket-events/checkin', { code: r.data.tickets[0].code })).status).toBe(409);
    expect((await t.api.get(`/api/ticket-events/${ev.id}/report`)).data.types[0]).toMatchObject({ sold: 0, held: 2, left: 0 });

    // pay with Mollie: pay page → provider → webhook
    const sid = new URL(r.data.pay_url).pathname.split('/').pop()!;
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'provider=mollie', redirect: 'manual' });
    expect(go.status).toBeGreaterThanOrEqual(300);
    const pid = [...payments.keys()].pop()!;
    expect(payments.get(pid).amount.value).toBe('50.00');
    payments.get(pid).status = 'paid';
    await t.api.raw(`/hooks/mollie/${loc}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `id=${pid}` });
    await t.app.events.flush();
    const o = t.app.db.get<any>('SELECT * FROM tix_orders WHERE token = ?', r.data.order_token);
    expect(o.status).toBe('paid');
    expect(o.invoice_id).toBeTruthy();
    const inv = t.app.db.get<any>('SELECT status, total_cents FROM invoices WHERE id = ?', o.invoice_id);
    expect(inv).toMatchObject({ status: 'paid', total_cents: 5000 });
    expect((await pub(new URL(r.data.tickets[0].url).pathname)).status).toBe(200);
    expect((await t.api.post('/api/ticket-events/checkin', { code: r.data.tickets[1].code })).data).toMatchObject({ status: 'checked_in', type: 'Parkett' });
    const rep = (await t.api.get(`/api/ticket-events/${ev.id}/report`)).data;
    expect(rep.types[0]).toMatchObject({ sold: 2, checked_in: 1, held: 0, revenue_cents: 5000, state: 'sold_out' });

    // a free type of the same event needs no payment
    expect((await pub('/api/public/ticket-events/konzert/order', { ...buyer, items: [{ type_id: ev.types[1].id, qty: 1 }] })).data.status).toBe('paid');

    // an unpaid hold that runs out frees the quota
    const ev2 = await mkEvent('Kino', [{ name: 'Sitz', price_cents: 900, quota: 1 }]);
    const held = await pub('/api/public/ticket-events/kino/order', { ...buyer, items: [{ type_id: ev2.types[0].id, qty: 1 }] });
    expect(held.data.status).toBe('pending');
    expect((await pub('/api/public/ticket-events/kino/order', { ...buyer, items: [{ type_id: ev2.types[0].id, qty: 1 }] })).status).toBe(409);
    t.app.db.run(`UPDATE tix_orders SET expires_at = ? WHERE token = ?`, new Date(Date.now() - 1000).toISOString(), held.data.order_token);
    expect(expireOrders(t.app)).toBe(1);
    expect(t.app.db.get<any>('SELECT status FROM tix_orders WHERE token = ?', held.data.order_token).status).toBe('expired');
    expect((await pub('/api/public/ticket-events/kino/order', { ...buyer, items: [{ type_id: ev2.types[0].id, qty: 1 }] })).data.status).toBe('pending');
  });
});

describe('sub-account isolation', () => {
  it('keeps events, reports and check-ins inside their sub-account', async () => {
    const ev = await mkEvent('Intern', [{ name: 'Gast', quota: 5 }]);
    const r = await pub('/api/public/ticket-events/intern/order', { ...buyer, items: [{ type_id: ev.types[0].id, qty: 1 }] });
    const code = r.data.tickets[0].code;
    const other = (await t.api.post('/api/locations', { name: 'Zweitfirma' })).data.id;
    t.api.setLocation(other);
    try {
      expect((await t.api.get('/api/ticket-events')).data).toEqual([]);
      expect((await t.api.get(`/api/ticket-events/${ev.id}/report`)).status).toBe(404);
      expect((await t.api.patch(`/api/ticket-events/${ev.id}`, { name: 'Gekapert' })).status).toBe(404);
      expect((await t.api.post('/api/ticket-events/checkin', { code })).status).toBe(404);
      expect((await t.api.post('/api/appointment-checkin', { code })).status).toBe(404);
      // a type id of another event cannot be ordered on this one
      const mine = await mkEvent('Eigenes', [{ name: 'X' }]);
      expect((await pub('/api/public/ticket-events/eigenes/order', { ...buyer, items: [{ type_id: ev.types[0].id, qty: 1 }] })).status).toBe(400);
      expect(mine.types).toHaveLength(1);
    } finally {
      t.api.setLocation(loc);
    }
    expect((await t.api.get(`/api/ticket-events/${ev.id}`)).data.name).toBe('Intern');
  });
});
