import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sumByCurrency } from '../web/src/format';
import { daysOverdue } from '../server/services/dunning-model.js';
import { invoicingModule } from '../server/modules/invoicing.js';
import { pinClock, startTestApp, unpinClock } from './helpers.js';

/**
 * Data-correctness follow-ups: what the first pass (tests/data-correctness.test.ts) left open – totals across currencies,
 * overdue days as calendar days of the sub-account, credit notes and commission, fully credited invoices, dunning fees.
 */

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let contactId = '';
const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
});
afterAll(async () => t.close());

const finalised = async (body: Record<string, unknown>) => {
  const draft = (await t.api.post('/api/invoices', { contact_id: contactId, ...body })).data;
  const r = await t.api.post(`/api/invoices/${draft.id}/finalise`);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};

describe('amounts in different currencies are never added up', () => {
  it('the dashboard shows paid and open amounts per currency (100 EUR + 100 USD is not "200 €")', async () => {
    const before = (await t.api.get('/api/dashboard?days=30')).data.revenue;
    expect(before.by_currency).toEqual([]);
    for (const currency of ['EUR', 'USD']) {
      const paid = await finalised({ currency, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 0 }] });
      expect((await t.api.post(`/api/invoices/${paid.id}/payments`, {})).data.paid).toBe(true);
      await finalised({ currency, items: [{ name: 'Wartung', qty: 1, price_cents: currency === 'EUR' ? 5000 : 7000, tax_rate: 0 }] });
    }
    const r = (await t.api.get('/api/dashboard?days=30')).data.revenue;
    expect(r.by_currency).toEqual([
      { currency: 'EUR', paid: 10000, outstanding: 5000 },
      { currency: 'USD', paid: 10000, outstanding: 7000 },
    ]);
    // the single numbers stay for older clients – in one currency, named next to them
    expect(r.currency).toBe('EUR');
    expect(r.paid).toBe(10000);
    expect(r.outstanding).toBe(5000);
  });

  it('the invoice list sums per currency', () => {
    const rows = [
      { currency: 'EUR', open_cents: 5000 },
      { currency: 'USD', open_cents: 7000 },
      { currency: 'EUR', open_cents: 2500 },
      { currency: '', open_cents: 100 },
      { currency: 'CHF', open_cents: 0 },
    ];
    expect(sumByCurrency(rows, (r) => r.open_cents)).toEqual([
      ['EUR', 7600],
      ['USD', 7000],
    ]);
    expect(sumByCurrency([], () => 1)).toEqual([]);
  });
});

describe('days overdue are calendar days of the sub-account, not 24-hour blocks', () => {
  // 08:00 on 6 October in Berlin; A was due yesterday at 23:00, B today at 07:00
  const NOW = '2026-10-06T06:00:00.000Z';
  const DUE_A = '2026-10-05T21:00:00.000Z';
  const DUE_B = '2026-10-06T05:00:00.000Z';

  it('an invoice due yesterday 23:00 is 1 day overdue at 08:00 today; one due today is not overdue yet', () => {
    expect(daysOverdue(DUE_A, new Date(NOW), 'Europe/Berlin')).toBe(1);
    expect(daysOverdue(DUE_B, new Date(NOW), 'Europe/Berlin')).toBe(0);
    // the sub-account's zone decides the day: in New York 21:00 UTC is 17:00 on the 5th, and 03:00 UTC on the 6th is still the 5th
    expect(daysOverdue(DUE_A, new Date(NOW), 'America/New_York')).toBe(1);
    expect(daysOverdue('2026-10-05T03:00:00.000Z', new Date('2026-10-06T03:00:00.000Z'), 'America/New_York')).toBe(1);
    expect(daysOverdue('2026-10-05T21:00:00.000Z', new Date('2026-10-06T03:00:00.000Z'), 'America/New_York')).toBe(0);
  });

  it('dunning levels, the invoice list, reports, the mobile app and the "Rechnung überfällig" trigger agree', async () => {
    const buyer = (await t.api.post('/api/contacts', { email: 'spaet@kunde.example', first_name: 'Sina', last_name: 'Spät', company: 'Spät GmbH', address: 'Weg 2', postal_code: '10115', city: 'Berlin' })).data.id;
    const report = async () => (await t.api.post('/api/reports/run', { source: 'invoices', range: 'all', measures: ['count', 'calc:overdue_amount'], filters: [{ field: 'overdue', op: 'is_true' }] })).data.totals.v as number[];
    const mobile = async () => (await t.api.get('/api/mobile/payments')).data.overdue_count as number;
    pinClock(NOW);
    try {
      const [count0, amount0] = await report();
      const mobile0 = await mobile();
      const a = await finalised({ contact_id: buyer, items: [{ name: 'Gestern fällig', qty: 1, price_cents: 10000, tax_rate: 0 }], due_at: DUE_A });
      const b = await finalised({ contact_id: buyer, items: [{ name: 'Heute fällig', qty: 1, price_cents: 20000, tax_rate: 0 }], due_at: DUE_B });
      // the invoice list says how many days
      const list = (await t.api.get('/api/invoices')).data as any[];
      expect(list.find((i) => i.id === a.id).days_overdue).toBe(1);
      expect(list.find((i) => i.id === b.id).days_overdue).toBe(0);
      expect((await t.api.get(`/api/invoices/${a.id}`)).data.days_overdue).toBe(1);

      // a dunning level due one day after the due date is due this morning for A, not for B
      await t.api.put('/api/dunning/settings', { inv: { mode: 'approval', min_amount_cents: 0, levels: [{ days: 1 }, { days: 14 }, { days: 28 }] } });
      const due = ((await t.api.post('/api/dunning/run', { dry_run: true })).data.due as any[]).filter((d) => [a.id, b.id].includes(d.invoice_id));
      expect(due.map((d) => [d.invoice_id, d.days_overdue])).toEqual([[a.id, 1]]);
      const overdue = ((await t.api.get('/api/dunning/invoices')).data as any[]).filter((d) => [a.id, b.id].includes(d.id));
      expect(overdue.map((d) => [d.id, d.days_overdue])).toEqual([[a.id, 1]]);
      await t.api.put('/api/dunning/settings', { inv: { mode: 'off' } });

      // reports and the mobile app count A as overdue, B not yet
      const [count1, amount1] = await report();
      expect(count1 - count0).toBe(1);
      expect(amount1 - amount0).toBeCloseTo(100, 2);
      expect((await mobile()) - mobile0).toBe(1);

      // "Rechnung überfällig" with 1 day starts for A this morning, with daysOverdue 1
      const wf = (await t.api.post('/api/workflows', { name: 'Einen Tag überfällig', trigger: { type: 'invoice.overdue', config: { days_overdue: 1 } }, steps: [{ type: 'set_variable', rows: [{ name: 'nr', value: '{{event.invoice.number}}' }, { name: 'tage', value: '{{event.daysOverdue}}' }] }] })).data;
      await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
      await t.app.services.wfxRunScans(new Date());
      const runs = t.app.db.all<any>('SELECT vars FROM workflow_runs WHERE workflow_id = ?', wf.id).map((r) => JSON.parse(r.vars));
      expect(runs.map((v) => [v.nr, Number(v.tage)])).toEqual([[a.number, 1]]);
      await t.api.patch(`/api/workflows/${wf.id}`, { status: 'paused' });
    } finally {
      unpinClock();
    }
  });
});

describe('later dunning notices claim the fees of the earlier ones', () => {
  it('the 2. Mahnung shows the fee of the 1. Mahnung as "Mahngebühren früherer Schreiben" and in the total; only notices that went out count', async () => {
    const buyer = (await t.api.post('/api/contacts', { email: 'mahn@kunde.example', first_name: 'Mia', last_name: 'Mahn', address: 'Weg 3', postal_code: '10115', city: 'Berlin' })).data.id;
    await t.api.put('/api/dunning/settings', {
      inv: { mode: 'approval', min_amount_cents: 0, min_gap_days: 0, interest: { enabled: false }, levels: [{ days: 1, fee_cents: 0 }, { days: 2, fee_cents: 500 }, { days: 3, fee_cents: 1000 }] },
    });
    const inv = await finalised({ contact_id: buyer, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 0 }], due_at: new Date(Date.now() - 10 * 864e5).toISOString() });
    const next = async () => {
      const r = await t.api.post(`/api/dunning/invoices/${inv.id}/notice`, { send: true });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      expect(r.data.sent[0].status).toBe('sent');
      return t.app.db.get<any>('SELECT * FROM dunning_notices WHERE id = ?', r.data.sent[0].id)!;
    };
    const reminder = await next();
    expect(reminder).toMatchObject({ level: 1, fee_cents: 0, prior_fee_cents: 0, total_cents: 10000 });
    const first = await next();
    expect(first).toMatchObject({ level: 2, fee_cents: 500, prior_fee_cents: 0, total_cents: 10500 });
    // the preview of the last level already counts the 5 € of the 1. Mahnung
    const preview = (await t.api.get(`/api/dunning/preview?invoice_id=${inv.id}&level=3`)).data;
    expect(preview.amounts).toMatchObject({ fee_cents: 1000, prior_fee_cents: 500, total_cents: 11500 });
    const second = await next();
    expect(second).toMatchObject({ level: 3, fee_cents: 1000, prior_fee_cents: 500, total_cents: 11500 });
    expect(second.body).toContain('115,00');
    const pdf = Buffer.from(await (await t.api.raw(`/mahnung/${second.token}/pdf`)).arrayBuffer()).toString('latin1');
    expect(pdf).toContain('Mahngeb');
    expect(pdf).toContain('5,00');
    expect(pdf).toContain('115,00');
    expect((await t.api.get(`/api/dunning/notices?invoice_id=${inv.id}`)).data.find((n: any) => n.id === second.id)).toMatchObject({ prior_fee_cents: 500 });

    // only fees of notices that went out count: a 1. Mahnung still waiting for approval adds nothing yet
    const inv2 = await finalised({ contact_id: buyer, items: [{ name: 'Wartung', qty: 1, price_cents: 20000, tax_rate: 0 }], due_at: new Date(Date.now() - 10 * 864e5).toISOString() });
    const draft = async () => {
      const r = await t.api.post(`/api/dunning/invoices/${inv2.id}/notice`, { send: false });
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      return t.app.db.get<any>('SELECT * FROM dunning_notices WHERE id = ?', r.data.created[0].id)!;
    };
    const last = async () => (await t.api.get(`/api/dunning/preview?invoice_id=${inv2.id}&level=3`)).data.amounts;
    expect((await t.api.post(`/api/dunning/notices/${(await draft()).id}/send`)).status).toBe(200);
    const waiting = await draft();
    expect(waiting).toMatchObject({ level: 2, fee_cents: 500, prior_fee_cents: 0, status: 'pending' });
    expect(await last()).toMatchObject({ prior_fee_cents: 0, total_cents: 21000 });
    expect((await t.api.post(`/api/dunning/notices/${waiting.id}/send`)).status).toBe(200);
    expect(await last()).toMatchObject({ prior_fee_cents: 500, total_cents: 21500 });
    // the open-invoices list names the next claim with the earlier fees
    expect(((await t.api.get('/api/dunning/invoices')).data as any[]).find((r) => r.id === inv2.id)).toMatchObject({ next_total_cents: 21500 });

    // switched off (each level's fee meant as the total so far): nothing is carried
    await t.api.put('/api/dunning/settings', { inv: { carry_fees: false } });
    expect(await last()).toMatchObject({ prior_fee_cents: 0, total_cents: 21000 });
    expect((await t.api.get('/api/dunning/settings')).data.settings.inv.carry_fees).toBe(false);
    await t.api.put('/api/dunning/settings', { inv: { mode: 'off', carry_fees: true } });
  });
});

describe('affiliate commission follows credit notes (Gutschriften)', () => {
  let program: any;
  let aff: any;
  let buyer = '';
  const commissions = () => t.app.db.all<any>('SELECT * FROM affiliate_commissions WHERE affiliate_id = ? ORDER BY created_at, rowid', aff.id);
  const ofInvoice = (invoiceId: string) => commissions().find((c) => c.invoice_id === invoiceId && c.kind !== 'clawback');
  const clawbacksOf = (c: any) => commissions().filter((x) => x.kind === 'clawback' && (x.reversal_of === c.id || x.invoice_id === c.invoice_id));
  const paidInvoice = async (net: number) => {
    const inv = await finalised({ contact_id: buyer, items: [{ name: 'Projekt', qty: 1, price_cents: net, tax_rate: 19 }] });
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, {})).data.paid).toBe(true);
    await t.app.events.flush();
    return inv;
  };
  const credit = async (invoiceId: string, net: number) => {
    const cn = await t.api.post(`/api/invoices/${invoiceId}/credit-note`, { items: [{ name: 'Nachlass', qty: 1, price_cents: net, tax_rate: 19 }], reason: 'Mängel' });
    expect(cn.status, JSON.stringify(cn.data)).toBe(200);
    const fin = await t.api.post(`/api/invoices/${cn.data.id}/finalise`);
    expect(fin.status, JSON.stringify(fin.data)).toBe(200);
    await t.app.events.flush();
    return fin.data;
  };

  beforeAll(async () => {
    program = (await t.api.post('/api/affiliates/programs', { name: 'Partner Gutschrift', commission_type: 'percent', commission_value: 20, payout_threshold_cents: 0 })).data;
    aff = (await t.api.post('/api/affiliates', { program_id: program.id, name: 'Gina Gutschrift', email: 'gina@partner.example' })).data;
    buyer = (await t.api.post('/api/contacts', { email: 'geworben@kunde.example', first_name: 'Gero', last_name: 'Geworben', company: 'Geworben GmbH', address: 'Weg 4', postal_code: '10115', city: 'Berlin' })).data.id;
    t.app.db.run('INSERT INTO affiliate_referrals (location_id, contact_id, affiliate_id, program_id, touch_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', t.api.location, buyer, aff.id, program.id, new Date().toISOString(), new Date().toISOString());
  });

  it('before payout: a credit note reduces the commission in proportion, a full credit reverses it', async () => {
    const inv = await paidInvoice(100000);
    expect(ofInvoice(inv.id)).toMatchObject({ base_cents: 100000, amount_cents: 20000, status: 'pending' });
    const cn = await credit(inv.id, 25000);
    const c = ofInvoice(inv.id);
    expect(c).toMatchObject({ amount_cents: 15000, original_cents: 20000, status: 'pending' });
    expect(c.note).toContain(cn.number);
    // a repeated event changes nothing
    t.app.events.emit(t.api.location, 'invoice.finalised', { invoice: cn });
    await t.app.events.flush();
    expect(ofInvoice(inv.id).amount_cents).toBe(15000);
    await credit(inv.id, 75000);
    expect(ofInvoice(inv.id)).toMatchObject({ status: 'reversed' });
    expect(clawbacksOf(c)).toEqual([]);
  });

  it('a credit note before the payment: the commission is earned on what is left', async () => {
    const inv = await finalised({ contact_id: buyer, items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] });
    await credit(inv.id, 40000);
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, {})).data.paid).toBe(true);
    await t.app.events.flush();
    expect(ofInvoice(inv.id)).toMatchObject({ base_cents: 60000, amount_cents: 12000 });
  });

  it('after payout (or while in an open payout) the history stays: a negative clawback is booked for the next payout', async () => {
    const inv = await paidInvoice(50000);
    const c = ofInvoice(inv.id);
    expect(c.amount_cents).toBe(10000);
    expect((await t.api.post('/api/affiliates/commissions/approve', { ids: [c.id] })).status).toBe(200);
    const payout = (await t.api.post('/api/affiliates/payouts', { program_id: program.id })).data.created.find((o: any) => o.affiliate_id === aff.id);
    expect(payout.amount_cents).toBeGreaterThanOrEqual(10000);
    // still in the open payout (the file may be at the bank already): not edited, a clawback instead
    await credit(inv.id, 10000);
    expect(ofInvoice(inv.id)).toMatchObject({ amount_cents: 10000, status: 'approved', payout_id: payout.id });
    expect(clawbacksOf(c).map((x) => [x.amount_cents, x.status, x.payout_id])).toEqual([[-2000, 'approved', null]]);
    expect((await t.api.post(`/api/affiliates/payouts/${payout.id}/paid`, {})).status).toBe(200);
    expect(ofInvoice(inv.id)).toMatchObject({ amount_cents: 10000, status: 'paid' });
    // a second credit note: the open clawback grows to the cumulative 50 %
    await credit(inv.id, 15000);
    expect(clawbacksOf(c).map((x) => x.amount_cents)).toEqual([-5000]);
    // the clawback goes out with a payout; a third credit note books the rest as a new clawback, never more than was paid
    const owed = (await t.api.post('/api/affiliates/commissions', { affiliate_id: aff.id, amount_cents: 20000, note: 'Bonus' })).data;
    expect(owed.amount_cents).toBe(20000);
    const p2 = (await t.api.post('/api/affiliates/payouts', { program_id: program.id })).data.created.find((o: any) => o.affiliate_id === aff.id);
    expect((await t.api.post(`/api/affiliates/payouts/${p2.id}/paid`, {})).status).toBe(200);
    await credit(inv.id, 25000);
    expect(clawbacksOf(c).map((x) => x.amount_cents).sort((a, b) => a - b)).toEqual([-5000, -5000]);
    expect(clawbacksOf(c).reduce((n, x) => n + x.amount_cents, 0)).toBe(-10000);
    expect(ofInvoice(inv.id)).toMatchObject({ amount_cents: 10000, status: 'paid' });
  });

  it('once clawed back, corrections stay clawbacks (also after the payout was deleted), and crediting the rest takes back the rest', async () => {
    const inv = await paidInvoice(30000);
    const c = ofInvoice(inv.id);
    expect(c.amount_cents).toBe(6000);
    expect((await t.api.post('/api/affiliates/commissions/approve', { ids: [c.id] })).status).toBe(200);
    const payout = (await t.api.post('/api/affiliates/payouts', { program_id: program.id })).data.created.find((o: any) => o.affiliate_id === aff.id);
    await credit(inv.id, 10000);
    expect(clawbacksOf(c).map((x) => x.amount_cents)).toEqual([-2000]);
    // the payout is deleted: the commission is free again, but the clawback already stands for the credit
    expect((await t.api.del(`/api/affiliates/payouts/${payout.id}`)).status).toBe(200);
    expect(ofInvoice(inv.id)).toMatchObject({ amount_cents: 6000, status: 'approved', payout_id: null });
    await credit(inv.id, 5000);
    expect(ofInvoice(inv.id)).toMatchObject({ amount_cents: 6000, status: 'approved' });
    expect(clawbacksOf(c).map((x) => x.amount_cents)).toEqual([-3000]);
    // with credit notes a Storno is refused (it would credit more than the invoice was for); the rest is credited instead:
    // everything comes back, in the clawback – commission and clawback add up to 0
    expect((await t.api.post(`/api/invoices/${inv.id}/storno`, { reason: 'Auftrag storniert' })).status).toBe(409);
    const rest = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { remainder: true, reason: 'Auftrag storniert' });
    expect(rest.status, JSON.stringify(rest.data)).toBe(200);
    expect((await t.api.post(`/api/invoices/${rest.data.id}/finalise`)).status).toBe(200);
    await t.app.events.flush();
    await t.app.tick();
    expect(clawbacksOf(c).map((x) => x.amount_cents)).toEqual([-6000]);
    expect(ofInvoice(inv.id).amount_cents + clawbacksOf(c).reduce((n, x) => n + x.amount_cents, 0)).toBe(0);
  });
});

describe('an invoice credited in full with nothing paid is closed', () => {
  it('the update closes invoices that were credited in full before (they stayed "sent")', async () => {
    const inv = await finalised({ items: [{ name: 'Altfall', qty: 1, price_cents: 10000, tax_rate: 0 }] });
    // the state such an invoice was left in: everything credited, nothing paid, still "sent"
    t.app.db.run('UPDATE invoices SET credited_cents = total_cents WHERE id = ?', inv.id);
    const partly = await finalised({ items: [{ name: 'Teilweise', qty: 1, price_cents: 10000, tax_rate: 0 }] });
    t.app.db.run('UPDATE invoices SET credited_cents = 5000 WHERE id = ?', partly.id);
    const sql = invoicingModule.migrations!.find(([name]) => name === '002-credited-closed')![1] as string;
    t.app.db.raw.exec(sql);
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data).toMatchObject({ status: 'void', state: 'credited' });
    expect((await t.api.get(`/api/invoices/${partly.id}`)).data).toMatchObject({ status: 'sent', state: 'open' });
    expect(((await t.api.get(`/api/invoices/${inv.id}/audit`)).data as any[]).map((a) => [a.action, a.actor])).toContainEqual(['invoice.credited', 'Update']);
  });

  it('becomes "gutgeschrieben" (stored void, like a Storno): out of open lists, filters, dunning, payment and reports – the books stay right', async () => {
    expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    const buyer = (await t.api.post('/api/contacts', { email: 'gutschrift@kunde.example', first_name: 'Gus', last_name: 'Gutschrift', company: 'GS GmbH', address: 'Weg 5', postal_code: '10115', city: 'Berlin' })).data.id;
    const inv = await finalised({ contact_id: buyer, items: [{ name: 'Beratung', qty: 2, price_cents: 50000, tax_rate: 19 }], due_at: new Date(Date.now() - 20 * 864e5).toISOString() });
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval', min_amount_cents: 0, min_gap_days: 0 } });
    const notice = (await t.api.post(`/api/dunning/invoices/${inv.id}/notice`, { send: false })).data.created[0];
    expect(notice).toBeTruthy();
    const credit = async (qty: number) => {
      const cn = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'Beratung', qty, price_cents: 50000, tax_rate: 19 }], reason: 'Leistung nicht erbracht' });
      expect(cn.status, JSON.stringify(cn.data)).toBe(200);
      const fin = await t.api.post(`/api/invoices/${cn.data.id}/finalise`);
      expect(fin.status, JSON.stringify(fin.data)).toBe(200);
      await t.app.events.flush();
      return fin.data;
    };
    // a partial credit note leaves it open
    await credit(1);
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data).toMatchObject({ status: 'sent', state: 'open', open_cents: 59500 });
    // the rest: nothing is open, nothing was paid – closed
    const last = await credit(1);
    const after = (await t.api.get(`/api/invoices/${inv.id}`)).data;
    expect(after).toMatchObject({ status: 'void', state: 'credited', state_label: 'Gutgeschrieben', open_cents: 0, days_overdue: 0, storno_id: null });
    expect(after.cancelled_at).toBeTruthy();
    expect(((await t.api.get(`/api/invoices/${inv.id}/audit`)).data as any[]).map((a) => a.action)).toContain('invoice.credited');
    // the waiting dunning notice is withdrawn, the run does not pick it up
    expect(t.app.db.get<any>('SELECT status FROM dunning_notices WHERE id = ?', notice.id).status).toBe('canceled');
    expect(((await t.api.post('/api/dunning/run', { dry_run: true })).data.due as any[]).some((d) => d.invoice_id === inv.id)).toBe(false);
    await t.api.put('/api/dunning/settings', { inv: { mode: 'off' } });
    // no payment, no further credit note, no Storno on top
    const pay = await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 100 });
    expect(pay.status).toBe(409);
    expect(pay.data.error).toMatch(/vollständig gutgeschrieben/);
    expect((await t.api.post(`/api/invoices/${inv.id}/storno`, {})).status).toBe(409);
    expect((await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'Mehr', qty: 1, price_cents: 100, tax_rate: 19 }] })).status).toBe(409);
    // the public page offers no payment and says what happened
    const page = await (await t.api.raw(`/i/${inv.public_token}`)).text();
    expect(page).toContain('Gutgeschrieben');
    expect(page).not.toContain('Jetzt bezahlen');
    // reports: its own status, not "offen"; not counted as open
    const byStatus = (await t.api.post('/api/reports/run', { source: 'invoices', range: 'all', measures: ['count'], groupBy: [{ field: 'status' }], filters: [{ field: 'status', op: 'eq', value: 'credited' }, { field: 'contact', op: 'eq', value: buyer }] })).data;
    expect(byStatus.rows.map((r: any) => [r.k[0], r.l[0], r.v[0]])).toEqual([['credited', 'Gutgeschrieben', 1]]);
    const open = (await t.api.post('/api/reports/run', { source: 'invoices', range: 'all', measures: ['count'], filters: [{ field: 'kind', op: 'eq', value: 'invoice' }, { field: 'status', op: 'eq', value: 'sent' }, { field: 'contact', op: 'eq', value: buyer }] })).data;
    expect(open.totals?.v?.[0] ?? 0).toBe(0);
    // the books: the invoice once, both credit notes reversed once – nothing left on the receivable, no Storno of the invoice on top
    const { syncInvoices } = await import('../server/services/acc-autopost.js');
    syncInvoices(t.app, t.api.location);
    syncInvoices(t.app, t.api.location);
    const entries = t.app.db.all<any>(`SELECT e.source_key, e.reversed_by FROM acc_entries e WHERE e.location_id = ? AND (e.source_key LIKE ? OR e.doc_ref = ?)`, t.api.location, `invoice:${inv.id}:%`, inv.number);
    expect(entries.find((e) => e.source_key === `invoice:${inv.id}:issue`)).toMatchObject({ reversed_by: null });
    const receivable = t.app.db.get<any>(
      `SELECT COALESCE(SUM(CASE l.side WHEN 'S' THEN l.cents ELSE -l.cents END), 0) AS bal FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id JOIN acc_accounts a ON a.location_id = l.location_id AND a.number = l.account
       WHERE e.location_id = ? AND e.doc_ref = ? AND a.kind = 'receivable'`,
      t.api.location,
      inv.number,
    ).bal;
    expect(receivable).toBe(0);
    expect(last.number).toBeTruthy();
  });

});
