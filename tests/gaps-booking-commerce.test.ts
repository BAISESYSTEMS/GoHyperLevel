import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';

/** Commerce parity: single-use discount codes (modules/coupon-codes.ts). */

let t: Awaited<ReturnType<typeof startTestApp>>;
let productId = '';
let contactId = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  productId = (await t.api.post('/api/products', { name: 'Online-Kurs', price_cents: 10000, tax_rate: 19 })).data.id;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Greta', email: 'greta@example.com' })).data.id;
});
afterAll(async () => {
  await t.close();
});

describe('single-use discount codes', () => {
  it('issues codes in bulk and validates the input', async () => {
    const r = await t.api.post('/api/coupon-codes', { product_id: productId, kind: 'percent', value: 15, count: 3, prefix: 'herbst!', valid_days: 10 });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.codes).toHaveLength(3);
    expect(new Set(r.data.codes).size).toBe(3);
    for (const c of r.data.codes) expect(c).toMatch(/^HERBST-[A-HJ-NP-Z2-9]{8}$/);
    expect(Date.parse(r.data.expires_at) - Date.now()).toBeGreaterThan(9.9 * 86_400_000);
    const rows = t.app.db.all<any>('SELECT max_uses, uses, kind, value FROM buy_coupons WHERE product_id = ?', productId);
    expect(rows.every((x) => x.max_uses === 1 && x.kind === 'percent' && x.value === 15)).toBe(true);
    expect((await t.api.post('/api/coupon-codes', { product_id: productId, kind: 'percent', value: 120 })).status).toBe(400);
    expect((await t.api.post('/api/coupon-codes', { product_id: productId, kind: 'amount', value: 500, count: 501 })).status).toBe(400);
    expect((await t.api.post('/api/coupon-codes', { product_id: 'gibtsnicht', kind: 'amount', value: 500 })).status).toBe(404);
    const abo = (await t.api.post('/api/products', { name: 'Club', price_cents: 900, recurring: 'month' })).data.id;
    expect((await t.api.post('/api/coupon-codes', { product_id: abo, kind: 'percent', value: 10 })).status).toBe(400);
  });

  it('the workflow step makes a personal code for the run\'s contact and provides var.coupon_code', async () => {
    const run = t.app.services.workflowActions.coupon_create;
    const meta = t.app.services.workflowActionMeta.coupon_create;
    expect(meta).toMatchObject({ category: 'payments', provides: ['var.coupon_code', 'var.coupon_expires'] });
    const out = await run({ id: 'r1', workflow_id: 'w1', location_id: t.api.location, contact_id: contactId, event: {}, vars: {}, cursor: {}, log: [] }, { product_id: productId, kind: 'amount', value: '500', valid_days: '0', prefix: 'Danke' }, {}, {});
    expect(out.vars.coupon_code).toMatch(/^DANKE-/);
    expect(out.vars.coupon_expires).toBe('');
    const list = (await t.api.get(`/api/coupon-codes?product_id=${productId}`)).data;
    const mine = list.find((x: any) => x.code === out.vars.coupon_code);
    expect(mine).toMatchObject({ contact_id: contactId, source: 'workflow', workflow_id: 'w1', kind: 'amount', value: 500, used: false, expires_at: null });
    expect(t.app.db.get<any>(`SELECT summary FROM activities WHERE contact_id = ? AND type = 'coupon.issued'`, contactId).summary).toContain(out.vars.coupon_code);
    await expect(Promise.resolve().then(() => run({ id: 'r2', workflow_id: 'w1', location_id: t.api.location, contact_id: '', event: {}, vars: {}, cursor: {}, log: [] }, { product_id: productId, value: 10 }, {}, {}))).rejects.toThrow('Kein Kontakt');
  });

  it('a code works once on the buy page', async () => {
    const code = (await t.api.post('/api/coupon-codes', { product_id: productId, kind: 'percent', value: 20 })).data.codes[0];
    const check = await t.api.get(`/api/public/buy/${productId}/coupon?code=${code.toLowerCase()}`);
    if (check.status === 404) return; // buy pages need Stripe – the code table itself is checked above
    expect(check.data).toMatchObject({ ok: true, code });
    t.app.db.run('UPDATE buy_coupons SET uses = 1 WHERE code = ?', code);
    expect((await t.api.get(`/api/public/buy/${productId}/coupon?code=${code}`)).data).toMatchObject({ ok: false });
    expect((await t.api.get('/api/coupon-codes')).data.find((x: any) => x.code === code).used).toBe(true);
  });

  it('has an MCP tool', () => {
    const tool = (t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_coupon_create');
    expect(tool.inputSchema.required).toEqual(['location_id', 'product_id', 'kind', 'value']);
  });
});

describe('loyalty points', () => {
  const events: any[] = [];
  let buyer = '';
  const paid = async (invId: string, cents: number, who = buyer) => {
    t.app.events.emit(t.api.location, 'invoice.paid', { contactId: who, invoice: { id: invId, number: `RE-${invId}`, total_cents: cents, kind: 'invoice' } });
    await t.app.events.flush();
  };

  it('is off by default; settings validate', async () => {
    t.app.events.on('*', (e) => void (e.type.startsWith('loyalty.') && events.push(e)));
    buyer = (await t.api.post('/api/contacts', { first_name: 'Lotte', email: 'lotte@example.com' })).data.id;
    expect((await t.api.get('/api/loyalty/settings')).data).toMatchObject({ enabled: false, points_per_euro: 1 });
    await paid('inv0', 5000);
    expect((await t.api.get(`/api/loyalty/contacts/${buyer}`)).data).toMatchObject({ balance: 0, lifetime: 0 });
    expect((await t.api.put('/api/loyalty/settings', { points_per_euro: 0 })).status).toBe(400);
    expect((await t.api.put('/api/loyalty/settings', { rewards: [{ name: 'X', points: 10, kind: 'coupon', product_id: 'gibtsnicht', value: 10 }] })).status).toBe(400);
    const s = await t.api.put('/api/loyalty/settings', {
      enabled: true,
      points_per_euro: 2,
      tiers: [
        { name: 'Gold', min_points: 300 },
        { name: 'Bronze', min_points: 0 },
        { name: 'Silber', min_points: 100 },
      ],
      rewards: [
        { id: 'r10', name: '10 % Rabatt', points: 100, kind: 'coupon', product_id: productId, coupon_kind: 'percent', value: 10 },
        { id: 'g5', name: '5-€-Gutschein', points: 150, kind: 'gift_card', value: 500 },
      ],
    });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    expect(s.data.tiers.map((x: any) => x.name)).toEqual(['Bronze', 'Silber', 'Gold']);
  });

  it('earns points per euro once per paid invoice and fires tier and points triggers', async () => {
    events.length = 0;
    await paid('inv1', 7550); // 75,50 € × 2 = 151 points
    await paid('inv1', 7550); // same invoice again: nothing
    const c = (await t.api.get(`/api/loyalty/contacts/${buyer}`)).data;
    expect(c).toMatchObject({ balance: 151, lifetime: 151, tier: 'Silber', next_tier: { name: 'Gold', missing: 149 } });
    expect(c.rewards.map((r: any) => [r.id, r.available])).toEqual([
      ['r10', true],
      ['g5', true],
    ]);
    expect(events.map((e) => e.type)).toEqual(['loyalty.points_earned', 'loyalty.tier_reached']);
    expect(events[1].data).toMatchObject({ tier: 'Silber', previous: 'Bronze' });
    // Filter of the tier trigger.
    const f = t.app.services.workflowTriggerFilters['loyalty.tier_reached'];
    expect(f({ tier: 'gold' }, { tier: 'Gold' })).toBe(true);
    expect(f({ tier: 'Gold' }, { tier: 'Silber' })).toBe(false);
  });

  it('redeems rewards for a code or a gift card and never goes below zero', async () => {
    const r = await t.api.post(`/api/loyalty/contacts/${buyer}/redeem`, { reward_id: 'r10' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.redeemed).toMatchObject({ kind: 'coupon', reward: '10 % Rabatt' });
    expect(r.data.redeemed.code).toMatch(/^TREUE-/);
    expect(r.data.balance).toBe(51);
    expect(r.data.lifetime).toBe(151); // spending keeps the tier
    expect((await t.api.post(`/api/loyalty/contacts/${buyer}/redeem`, { reward_id: 'g5' })).status).toBe(409);
    expect((await t.api.post(`/api/loyalty/contacts/${buyer}/adjust`, { points: -60 })).status).toBe(400);
    const adj = await t.api.post(`/api/loyalty/contacts/${buyer}/adjust`, { points: 100, reason: 'Empfehlung' });
    expect(adj.data.balance).toBe(151);
    const g = await t.api.post(`/api/loyalty/contacts/${buyer}/redeem`, { reward_id: 'g5' });
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    expect(g.data.redeemed.kind).toBe('gift_card');
    const card = t.app.db.get<any>('SELECT * FROM gift_cards WHERE code = ?', g.data.redeemed.code);
    expect(card?.contact_id).toBe(buyer);
    expect(g.data.ledger[0]).toMatchObject({ points: -150, source: 'reward' });
    const members = (await t.api.get('/api/loyalty/members')).data;
    expect(members[0]).toMatchObject({ contact_id: buyer, balance: 1, lifetime: 251, tier: 'Silber' });
  });

  it('workflow step and MCP tools', async () => {
    const run = t.app.services.workflowActions.loyalty_points;
    const out = await run({ id: 'r', workflow_id: 'w', location_id: t.api.location, contact_id: buyer, event: {}, vars: {}, cursor: {}, log: [] }, { points: '49', reason: 'Bewertung' }, {}, {});
    expect(out.vars.loyalty_balance).toBe(50);
    const names = (t.app.services.mcpTools as any[]).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_loyalty_contact', 'ghl_loyalty_adjust']));
    expect((await t.api.get('/api/loyalty/contacts/gibtsnicht')).status).toBe(404);
  });
});

describe('store: packing slips and abandoned carts', () => {
  const at = () => new Date().toISOString();
  const order = (id: string, number: string, extra: Record<string, unknown> = {}) =>
    t.app.db.insert('store_orders', {
      id, location_id: t.api.location, number, token: `tok-${id}`, email: 'paula@example.com', name: 'Paula Paket', phone: '0170 1', address: JSON.stringify({ name: 'Paula Paket', street: 'Lindenweg 3', postal_code: '10115', city: 'Berlin', country: 'DE' }),
      items: JSON.stringify([{ product_id: productId, name: 'Tasse', variant: 'Blau', sku: 'TS-BL', qty: 2 }, { product_id: productId, name: 'Poster', variant: '', sku: '', qty: 1 }]),
      shipping: JSON.stringify({ id: 'pickup', name: 'Abholung im Laden' }), status: 'paid', fulfilment: 'unfulfilled', note: 'Bitte als Geschenk verpacken', created_at: at(), updated_at: at(), ...extra,
    });

  it('prints one packing slip and all open orders in one PDF', async () => {
    order('o1', 'B-1001');
    order('o2', 'B-1002');
    order('o3', 'B-1003', { fulfilment: 'shipped' });
    order('o4', 'B-1004', { status: 'pending' });
    const one = await t.api.raw('/api/store/orders/o1/packing-slip', { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    expect(one.status).toBe(200);
    expect(one.headers.get('content-disposition')).toContain('packzettel-B-1001.pdf');
    expect(Buffer.from(await one.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    const open = await t.api.raw('/api/store/packing-slips?open=1', { headers: { cookie: t.api.cookie, 'x-location-id': t.api.location } });
    expect(open.status).toBe(200);
    expect(open.headers.get('content-disposition')).toContain('packzettel-2.pdf');
    expect((await t.api.get('/api/store/packing-slips')).status).toBe(400);
    expect((await t.api.get('/api/store/orders/gibtsnicht/packing-slip')).status).toBe(404);
  });

  it('lists abandoned carts with value and recovery link, without carts that ended in a paid order', async () => {
    const cart = (id: string, email: string, extra: Record<string, unknown> = {}) =>
      t.app.db.insert('store_carts', { id, location_id: t.api.location, items: JSON.stringify([{ product_id: productId, qty: 2 }]), email, country: 'DE', status: 'open', created_at: new Date(Date.now() - 3600_000).toISOString(), updated_at: at(), ...extra });
    cart('c-open', 'offen@example.com');
    cart('c-paid', 'paula@example.com'); // Paula paid orders (o1, o2) after this cart was started
    cart('c-noemail', '');
    cart('c-old', 'alt@example.com', { updated_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    const r = (await t.api.get('/api/store/abandoned')).data;
    const ids = r.carts.map((c: any) => c.id);
    expect(ids).toContain('c-open');
    expect(ids).not.toContain('c-paid');
    expect(ids).not.toContain('c-noemail');
    expect(ids).not.toContain('c-old');
    const c = r.carts.find((x: any) => x.id === 'c-open');
    expect(c).toMatchObject({ email: 'offen@example.com', reminded: false, items: [{ name: 'Online-Kurs', qty: 2 }] });
    expect(c.value_cents).toBe(20000);
    expect(c.recovery_url).toMatch(/\/store\/.+\/checkout\?cart=c-open$/);
    expect((await t.api.get('/api/store/abandoned?days=90')).data.carts.map((x: any) => x.id)).toContain('c-old');
    expect((t.app.services.mcpTools as any[]).find((x) => x.name === 'ghl_store_abandoned').annotations.readOnlyHint).toBe(true);
  });
});
