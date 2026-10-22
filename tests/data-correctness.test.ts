import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { invoicePdf } from '../server/services/invoice-pdf.js';
import { lineNet } from '../server/services/invoice-model.js';
import { advanceDate, runRecurringInvoices } from '../server/modules/payments.js';
import { syncInvoices } from '../server/services/acc-autopost.js';
import { readCsvFile } from '../web/src/csv-file';
import { normalizePhone } from '../server/core/util.js';
import { doc } from './invoice-fixtures.js';
import { startTestApp } from './helpers.js';

/**
 * Data-correctness regressions: numbers, dates and records that used to come out silently wrong (money rounding, month ends,
 * time zones, thresholds). Each block names the rule it guards.
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

describe('line totals on the printed invoice equal the line amounts the totals are made of', () => {
  // 1,15 Std. × 29,90 € = 34,385 € → 34,39 € (half away from zero). In floating point 1.15 × 2990 is 3438.4999…, which used to print 34,38 €.
  const items = [{ name: 'Beratung', qty: 1.15, price_cents: 2990, tax_rate: 19 }];

  it('the PDF prints the line amount of the invoice maths', () => {
    expect(lineNet(items[0])).toBe(3439);
    const s = invoicePdf(doc({ items })).toString('latin1');
    expect(s).toContain('34,39');
    expect(s).not.toContain('34,38');
  });

  it('the online invoice prints the same line amount', async () => {
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, items })).data;
    expect(draft.subtotal_cents).toBe(3439);
    const inv = (await t.api.post(`/api/invoices/${draft.id}/finalise`)).data;
    const page = await (await t.api.raw(`/i/${inv.public_token}`)).text();
    expect(page).toContain('34,39');
    expect(page).not.toContain('34,38');
  });
});

describe('recurring invoices keep their day of the month', () => {
  it('an invoice on the 31st comes back on the 31st after a short month (no drift to the 28th)', () => {
    const feb = advanceDate('2026-01-31T07:00:00.000Z', 'month', 31);
    expect(feb).toBe('2026-02-28T07:00:00.000Z');
    expect(advanceDate(feb, 'month', 31)).toBe('2026-03-31T07:00:00.000Z');
    expect(advanceDate('2026-11-30T07:00:00.000Z', 'quarter', 30)).toBe('2027-02-28T07:00:00.000Z');
    expect(advanceDate('2027-02-28T07:00:00.000Z', 'quarter', 30)).toBe('2027-05-30T07:00:00.000Z');
    expect(advanceDate('2028-02-29T07:00:00.000Z', 'year', 29)).toBe('2029-02-28T07:00:00.000Z');
    expect(advanceDate('2031-02-28T07:00:00.000Z', 'year', 29)).toBe('2032-02-29T07:00:00.000Z');
  });

  it('the subscription remembers the day it started on and uses it after February', async () => {
    const inv = (await t.api.post('/api/invoices', { contact_id: contactId, title: 'Wartung', items: [{ name: 'Wartung', qty: 1, price_cents: 4900 }] })).data;
    const r = await t.api.patch(`/api/invoices/${inv.id}`, { recurring: { interval: 'month', next_at: '2026-01-31T07:00:00.000Z', auto_send: false } });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.recurring.day).toBe(31);
    // due in January → next one in February (28th), then March must be the 31st again
    await runRecurringInvoices(t.app, new Date('2026-02-01T12:00:00Z'));
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data.recurring.next_at).toBe('2026-02-28T07:00:00.000Z');
    await runRecurringInvoices(t.app, new Date('2026-03-01T12:00:00Z'));
    expect((await t.api.get(`/api/invoices/${inv.id}`)).data.recurring.next_at).toBe('2026-03-31T07:00:00.000Z');
    await t.api.patch(`/api/invoices/${inv.id}`, { recurring: null });
  });
});

describe('dunning: the minimum amount is about what is still open', () => {
  it('a short payment that leaves cents open gets no reminder (min_amount_cents compares the open amount, not the total)', async () => {
    await t.api.put('/api/dunning/settings', { inv: { mode: 'approval', min_amount_cents: 100 } });
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, title: 'Beratung', items: [{ name: 'Beratung', qty: 1, price_cents: 11900, tax_rate: 0 }], due_at: new Date(Date.now() - 10 * 864e5).toISOString() })).data;
    const inv = (await t.api.patch(`/api/invoices/${draft.id}`, { status: 'sent' })).data;
    const due = async () => ((await t.api.post('/api/dunning/run', { dry_run: true })).data.due as any[]).filter((d) => d.invoice_id === inv.id);
    expect(await due()).toHaveLength(1);
    // the customer paid 118,50 €: 0,50 € are open – below the minimum of 1 €
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 11850 })).status).toBe(200);
    expect(await due()).toHaveLength(0);
    await t.api.put('/api/dunning/settings', { inv: { mode: 'off' } });
  });
});

describe('accounting books invoices and payments on the day of the sub-account, not the UTC date', () => {
  it('an invoice finalised at 00:30 on 1 January in Berlin belongs to the new year; a payment at 00:15 on 1 February to February', async () => {
    expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    const loc = t.api.location;
    // 23:30 UTC on 31 December = 00:30 on 1 January in Berlin
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }], issued_at: '2026-12-31T23:30:00.000Z', due_at: '2027-01-14T23:30:00.000Z' })).data;
    const inv = (await t.api.post(`/api/invoices/${draft.id}/finalise`)).data;
    expect(inv.number).toBeTruthy();
    syncInvoices(t.app, loc);
    const issue = t.app.db.get<any>('SELECT * FROM acc_entries WHERE location_id = ? AND source_key = ?', loc, `invoice:${inv.id}:issue`)!;
    expect(issue.doc_date).toBe('2027-01-01');
    expect(issue.date).toBe('2027-01-01');
    expect(issue.due_date).toBe('2027-01-15');
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: inv.total_cents, paid_at: '2027-01-31T23:15:00.000Z' })).status).toBe(200);
    syncInvoices(t.app, loc);
    const pay = t.app.db.get<any>(`SELECT * FROM acc_entries WHERE location_id = ? AND source_key LIKE ?`, loc, `invoice:${inv.id}:pay:%`)!;
    expect(pay.doc_date).toBe('2027-02-01');
  });

  it('a plain payment date (bank import, API) stays that day', async () => {
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: 5000, tax_rate: 19 }] })).data;
    const inv = (await t.api.post(`/api/invoices/${draft.id}/finalise`)).data;
    const r = await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: inv.total_cents, paid_at: '2027-03-01' });
    expect(r.status).toBe(200);
    expect(r.data.paid_at.slice(0, 10)).toBe('2027-03-01');
    syncInvoices(t.app, t.api.location);
    expect(t.app.db.get<any>(`SELECT doc_date FROM acc_entries WHERE location_id = ? AND source_key LIKE ?`, t.api.location, `invoice:${inv.id}:pay:%`)!.doc_date).toBe('2027-03-01');
  });
});

describe('a final invoice names its partial invoices with the date printed on them', () => {
  it('a partial invoice of 00:30 on 1 March (Berlin) is "vom 01.03.2026" on the final invoice, its PDF and its XRechnung', async () => {
    // 23:30 UTC on 28 February = 00:30 on 1 March in Berlin
    const p0 = (await t.api.post('/api/invoices', { contact_id: contactId, inv_type: 'partial', items: [{ name: 'Abschlag', qty: 1, price_cents: 30000, tax_rate: 19 }], issued_at: '2026-02-28T23:30:00.000Z' })).data;
    const partial = (await t.api.post(`/api/invoices/${p0.id}/finalise`)).data;
    expect((await t.api.get(`/api/invoices/${partial.id}`)).data.issued_at).toBe('2026-02-28T23:30:00.000Z');
    const f0 = (await t.api.post('/api/invoices', { contact_id: contactId, inv_type: 'final', deduct_ids: [partial.id], items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] })).data;
    const fin = await t.api.post(`/api/invoices/${f0.id}/finalise`);
    expect(fin.status, JSON.stringify(fin.data)).toBe(200);
    const page = await (await t.api.raw(`/i/${fin.data.public_token}`)).text();
    expect(page).toContain(`${partial.number} vom 01.03.2026`);
    expect(page).not.toContain('vom 28.02.2026');
    const pdf = (await (await t.api.raw(`/i/${fin.data.public_token}/pdf`)).arrayBuffer());
    expect(Buffer.from(pdf).toString('latin1')).toContain(`${partial.number} vom 01.03.2026`);
    const xml = (await t.api.get(`/api/invoices/${f0.id}/xrechnung?format=json`)).data.xml as string;
    expect(xml).toContain('20260301');
    expect(xml).not.toContain('20260228');
  });
});

describe('buy links charge what the invoice of the purchase says', () => {
  it('a Kleinunternehmer (§ 19 UStG) is not charged VAT for a product that still carries 19 %', async () => {
    const p = (await t.api.post('/api/products', { name: 'Kurs', price_cents: 10000, tax_rate: 19 })).data;
    const grossOf = (prod: any) => t.app.services.stripeBuy.grossOf(prod) as { tax: number; gross: number };
    expect(grossOf(p)).toEqual({ tax: 19, gross: 11900 });
    await t.api.put('/api/invoice-settings', { small_business: true });
    try {
      // the invoice of the purchase is written without VAT (§ 19) – the checkout must ask for the same 100 €, not 119 €
      const inv = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Kurs', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
      expect(inv.total_cents).toBe(10000);
      expect(grossOf(p)).toEqual({ tax: 0, gross: 10000 });
    } finally {
      await t.api.put('/api/invoice-settings', { small_business: false });
    }
  });
});

describe('the public booking page moves whole weeks also across a change of daylight saving time', () => {
  it('"next week" from 24 March 2031 shows 31 March, "previous week" from 28 October 2030 shows 21 October (visitor in Berlin)', async () => {
    const cal = (await t.api.post('/api/calendars', { name: 'Erstgespräch' })).data;
    const page = (await t.api.get(`/book/${cal.slug}`)).data as string;
    const code = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("$('next').onclick"))!;
    expect(code).toBeTruthy();
    const els = new Map<string, any>();
    const fetched: string[] = [];
    const el = (id: string) => els.get(id) ?? (els.set(id, { id, textContent: '', innerHTML: '', hidden: false, appendChild() {}, setAttribute() {}, querySelector: () => ({}) }), els.get(id));
    const ctx = vm.createContext({
      document: { getElementById: el, createElement: () => el(`x${els.size}`) },
      fetch: async (url: string) => (fetched.push(url), { ok: true, json: async () => ({ days: [] }) }),
      location: { search: '', href: '' },
      window: {},
      URLSearchParams,
      Intl,
      FormData: class {},
    });
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      vm.runInContext(code, ctx);
      const go = async (start: string, button: 'next' | 'prev') => {
        vm.runInContext(`from = ${JSON.stringify(start)}`, ctx);
        el(button).onclick();
        await new Promise((r) => setTimeout(r, 0));
        return /from=(\d{4}-\d{2}-\d{2})/.exec(fetched[fetched.length - 1])![1];
      };
      expect(await go('2031-03-24', 'next')).toBe('2031-03-31');
      expect(await go('2030-10-28', 'prev')).toBe('2030-10-21');
      expect(await go('2030-06-10', 'next')).toBe('2030-06-17');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('won and lost deals count in the period they were closed, not when they were last edited', () => {
  it('a deal won two months ago and edited today is not "won in the last 30 days" on the dashboard', async () => {
    const pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot'] })).data;
    const deal = (await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: contactId, name: 'Altauftrag', value: 5000 })).data;
    expect((await t.api.patch(`/api/opportunities/${deal.id}`, { status: 'won' })).status).toBe(200);
    await t.app.events.flush();
    const twoMonthsAgo = new Date(Date.now() - 60 * 864e5).toISOString();
    t.app.db.run('UPDATE opportunities SET closed_at = ? WHERE id = ?', twoMonthsAgo, deal.id);
    // a later edit (note, field, owner) touches updated_at only
    expect((await t.api.patch(`/api/opportunities/${deal.id}`, { name: 'Altauftrag (Rahmenvertrag)' })).status).toBe(200);
    expect(t.app.db.get<any>('SELECT updated_at FROM opportunities WHERE id = ?', deal.id)!.updated_at > twoMonthsAgo).toBe(true);
    const dash = (await t.api.get('/api/dashboard?days=29')).data;
    expect(dash.opportunities.won).toBe(0);
    expect(dash.opportunities.wonValue).toBe(0);
    // within 90 days it is there
    const longer = (await t.api.get('/api/dashboard?days=91')).data;
    expect(longer.opportunities.won).toBe(1);
    expect(longer.opportunities.wonValue).toBe(5000);
  });
});

describe('paid revenue counts a final invoice without the partial invoices it deducts', () => {
  it('30 % partial invoice + final invoice over 100 % add up to 100 % of the order on the dashboard and in reports', async () => {
    const revenue = async (days: number) => (await t.api.get(`/api/dashboard?days=${days}`)).data.revenue.paid as number;
    const report = async () => Number((await t.api.post('/api/reports/run', { source: 'invoices', measures: ['calc:paid_amount'], date_field: 'paid_at', range: 'last_30_days' })).data.totals.v[0]);
    const before = await revenue(27);
    const reportBefore = await report();
    const p0 = (await t.api.post('/api/invoices', { contact_id: contactId, inv_type: 'partial', items: [{ name: 'Abschlag 30 %', qty: 1, price_cents: 30000, tax_rate: 19 }] })).data;
    const partial = (await t.api.post(`/api/invoices/${p0.id}/finalise`)).data;
    expect((await t.api.post(`/api/invoices/${partial.id}/payments`, {})).data.paid).toBe(true);
    const f0 = (await t.api.post('/api/invoices', { contact_id: contactId, inv_type: 'final', deduct_ids: [partial.id], items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] })).data;
    const fin = (await t.api.post(`/api/invoices/${f0.id}/finalise`)).data;
    expect(fin.open_cents).toBe(119000 - 35700);
    expect((await t.api.post(`/api/invoices/${fin.id}/payments`, {})).data.paid).toBe(true);
    // the customer paid 35 700 + 83 300 = 119 000 – not 35 700 + 119 000
    expect((await revenue(26)) - before).toBe(119000);
    expect((await report()) - reportBefore).toBeCloseTo(1190, 2);
  });
});

describe('an invoice settled by payments and a credit note is not overdue any more', () => {
  it('no "Rechnung überfällig" workflow, no overdue count once nothing is open', async () => {
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 0 }], due_at: new Date(Date.now() - 10 * 864e5).toISOString() })).data;
    const inv = (await t.api.post(`/api/invoices/${draft.id}/finalise`)).data;
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 6000 })).status).toBe(200);
    const cn = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'Nachlass Mängel', qty: 1, price_cents: 4000, tax_rate: 0 }], reason: 'Mängel' });
    expect(cn.status, JSON.stringify(cn.data)).toBe(200);
    expect((await t.api.post(`/api/invoices/${cn.data.id}/finalise`)).status).toBe(200);
    const after = (await t.api.get(`/api/invoices/${inv.id}`)).data;
    expect(after.open_cents).toBe(0);
    const wf = (await t.api.post('/api/workflows', { name: 'Überfällig', trigger: { type: 'invoice.overdue', config: { days_overdue: 3 } }, steps: [{ type: 'set_variable', rows: [{ name: 'nr', value: '{{event.invoice.number}}' }] }] })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    await t.app.services.wfxRunScans(new Date());
    const runs = t.app.db.all<any>('SELECT vars FROM workflow_runs WHERE workflow_id = ?', wf.id).map((r) => JSON.parse(r.vars).nr);
    expect(runs).not.toContain(inv.number);
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'paused' });
    // the report's "overdue" flag and "Anzahl offen" only count invoices with something open
    const run = async (q: Record<string, unknown>) => (await t.api.post('/api/reports/run', { source: 'invoices', range: 'all', ...q })).data;
    const sql = (where: string) => t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE location_id = ? AND kind = 'invoice' AND status = 'sent' AND ${where}`, t.api.location)!.n;
    const open = 'total_cents - paid_cents - credited_cents - deducted_cents > 0';
    expect(sql('NOT (' + open + ')')).toBeGreaterThan(0);
    expect((await run({ measures: ['calc:open_count'] })).totals.v[0]).toBe(sql(open));
    const overdue = await run({ measures: ['count'], filters: [{ field: 'overdue', op: 'is_true' }] });
    expect(overdue.totals.v[0]).toBe(sql(`${open} AND due_at < '${new Date().toISOString()}'`));
  });
});

describe('affiliate commission on partial and final invoices', () => {
  it('the final invoice earns commission only on what its partial invoices did not already earn', async () => {
    const program = (await t.api.post('/api/affiliates/programs', { name: 'Partner Abschlag', commission_type: 'percent', commission_value: 20 })).data;
    const aff = (await t.api.post('/api/affiliates', { program_id: program.id, name: 'Paul Partner', email: 'paul@partner.example' })).data;
    const buyer = (await t.api.post('/api/contacts', { email: 'bau@kunde.example', first_name: 'Bea', last_name: 'Bau', company: 'Bau GmbH', address: 'Weg 1', postal_code: '10115', city: 'Berlin' })).data.id;
    t.app.db.run('INSERT INTO affiliate_referrals (location_id, contact_id, affiliate_id, program_id, touch_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', t.api.location, buyer, aff.id, program.id, new Date().toISOString(), new Date().toISOString());
    const pay = async (id: string) => expect((await t.api.post(`/api/invoices/${id}/payments`, {})).data.paid).toBe(true);
    const p0 = (await t.api.post('/api/invoices', { contact_id: buyer, inv_type: 'partial', items: [{ name: 'Abschlag', qty: 1, price_cents: 30000, tax_rate: 19 }] })).data;
    const partial = (await t.api.post(`/api/invoices/${p0.id}/finalise`)).data;
    await pay(partial.id);
    const f0 = (await t.api.post('/api/invoices', { contact_id: buyer, inv_type: 'final', deduct_ids: [partial.id], items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] })).data;
    const fin = (await t.api.post(`/api/invoices/${f0.id}/finalise`)).data;
    await pay(fin.id);
    await t.app.events.flush();
    const rows = t.app.db.all<any>('SELECT invoice_id, base_cents, amount_cents FROM affiliate_commissions WHERE affiliate_id = ? ORDER BY created_at, rowid', aff.id);
    expect(rows.map((r) => [r.invoice_id, r.base_cents, r.amount_cents])).toEqual([
      [partial.id, 30000, 6000],
      [fin.id, 70000, 14000],
    ]);
  });
});

describe('time billing bills the minutes that were worked', () => {
  it('three entries of 20 minutes at 90 €/h are 90 € (not 3 × 0,33 h = 89,10 €), as the unbilled preview said', async () => {
    await t.api.put('/api/pm/settings', { round_up_minutes: 0 });
    const proj = (await t.api.post('/api/pm/projects', { name: 'Support Oktober', contact_id: contactId, hourly_rate_cents: 9000 })).data;
    for (let i = 0; i < 3; i++) expect((await t.api.post('/api/pm/time', { project_id: proj.id, minutes: 20, date: '2026-09-1' + i })).status).toBe(200);
    const preview = (await t.api.get(`/api/pm/billing/unbilled?project_id=${proj.id}`)).data;
    expect(preview.amount_cents).toBe(9000);
    const r = await t.api.post('/api/pm/billing/invoice', { project_id: proj.id, group_by: 'entry', tax_rate: 0 });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const inv = (await t.api.get(`/api/invoices/${r.data.invoice.id}`)).data;
    expect(inv.subtotal_cents).toBe(9000);
    expect(r.data.amount_cents).toBe(preview.amount_cents);
  });
});

describe('CSV files from German Excel keep their umlauts', () => {
  it('a Windows-1252 file (Excel "CSV (Trennzeichen-getrennt)") is read as such, UTF-8 (with BOM) stays UTF-8 (without the BOM)', async () => {
    const ansi = Buffer.from('Vorname;Nachname;Ort\r\nJörg;Müller;Straße 1, Köln\r\n', 'latin1');
    expect(await readCsvFile(new Blob([ansi]))).toBe('Vorname;Nachname;Ort\r\nJörg;Müller;Straße 1, Köln\r\n');
    // "€" is 0x80 in Windows-1252 (not in Latin-1)
    expect(await readCsvFile(new Blob([Buffer.from([0x50, 0x72, 0x65, 0x69, 0x73, 0x3b, 0x31, 0x30, 0x20, 0x80])]))).toBe('Preis;10 €');
    const utf8 = Buffer.from('\uFEFFVorname;Nachname\nJörg;Müller\n', 'utf8');
    expect(await readCsvFile(new Blob([utf8]))).toBe('Vorname;Nachname\nJörg;Müller\n');
    // and the import takes the names as they are
    const csv = await readCsvFile(new Blob([ansi]));
    const r = await t.api.post('/api/contacts/import', { csv: csv.replace('Ort', 'Adresse') });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const found = (await t.api.get('/api/contacts?q=J%C3%B6rg')).data.contacts;
    expect(found.map((c: any) => [c.first_name, c.last_name])).toEqual([['Jörg', 'Müller']]);
  });
});

describe('custom properties: date and time values as the sub-account means them', () => {
  it('"24.12.2026 18:00" is 18:00 in Berlin whatever zone the server runs in; 31.02. is no date', async () => {
    const type = (await t.api.post('/api/object-types', { singular: 'Einsatz', plural: 'Einsätze', primary_label: 'Titel' })).data;
    expect((await t.api.post('/api/properties', { object: type.key, label: 'Beginn', type: 'datetime' })).status).toBe(200);
    expect((await t.api.post('/api/properties', { object: type.key, label: 'Stichtag', type: 'date' })).status).toBe(200);
    const base = `/api/objects/${type.key}/records`;
    const tz = process.env.TZ;
    process.env.TZ = 'UTC'; // like the Docker image
    try {
      const winter = (await t.api.post(base, { properties: { name: 'Weihnachten', beginn: '24.12.2026 18:00' } })).data;
      expect(winter.properties.beginn).toBe('2026-12-24T17:00:00.000Z');
      const summer = (await t.api.post(base, { properties: { name: 'Sommerfest', beginn: '2026-07-01T18:00' } })).data;
      expect(summer.properties.beginn).toBe('2026-07-01T16:00:00.000Z');
      // an instant with its zone stays as it is
      const exact = (await t.api.post(base, { properties: { name: 'Exakt', beginn: '2026-07-01T18:00:00.000Z' } })).data;
      expect(exact.properties.beginn).toBe('2026-07-01T18:00:00.000Z');
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    expect((await t.api.post(base, { properties: { name: 'Falsch', stichtag: '31.02.2026' } })).status).toBe(400);
    expect((await t.api.post(base, { properties: { name: 'Auch falsch', stichtag: '2026-13-01' } })).status).toBe(400);
    expect((await t.api.post(base, { properties: { name: 'Richtig', stichtag: '28.02.2026' } })).data.properties.stichtag).toBe('2026-02-28');
  });
});

describe('stock valuation on a key date ends at midnight of the sub-account', () => {
  it('a receipt at 00:30 on 1 January (Berlin) is not in the valuation of 31 December, one at 23:30 on 31 December is', async () => {
    const late = (await t.api.post('/api/inventory/articles', { sku: 'STICH-1', name: 'Stichtag spät' })).data;
    const early = (await t.api.post('/api/inventory/articles', { sku: 'STICH-2', name: 'Stichtag früh' })).data;
    for (const a of [late, early]) expect((await t.api.post('/api/inventory/movements', { article_id: a.id, type: 'receipt', qty: 10, unit_cost_cents: 500 })).status).toBe(200);
    t.app.db.run('UPDATE inv_movements SET created_at = ? WHERE article_id = ?', '2026-12-31T23:30:00.000Z', late.id); // 00:30 on 1 January in Berlin
    t.app.db.run('UPDATE inv_movements SET created_at = ? WHERE article_id = ?', '2026-12-31T22:30:00.000Z', early.id); // 23:30 on 31 December in Berlin
    const skus = async (asof: string) => ((await t.api.get(`/api/inventory/valuation?asof=${asof}`)).data.rows as any[]).filter((r) => r.sku.startsWith('STICH')).map((r) => [r.sku, r.qty]);
    expect(await skus('2026-12-31')).toEqual([['STICH-2', 10]]);
    expect(await skus('2027-01-01')).toEqual([['STICH-1', 10], ['STICH-2', 10]]);
    // the movement log filtered by day agrees
    const log = async (q: string) => ((await t.api.get(`/api/inventory/movements?${q}`)).data as any[]).filter((m) => m.sku.startsWith('STICH')).map((m) => m.sku).sort();
    expect(await log('from=2026-12-31&to=2026-12-31')).toEqual(['STICH-2']);
    expect(await log('from=2027-01-01&to=2027-01-01')).toEqual(['STICH-1']);
  });
});

describe('phone numbers in the common "+49 (0)" notation', () => {
  it('drop the trunk 0 after the country code, so they reach somebody and find the same contact', async () => {
    expect(normalizePhone('+49 (0)30 1234567')).toBe('+49301234567');
    expect(normalizePhone('+49(0)170-1234567')).toBe('+491701234567');
    expect(normalizePhone('0049 (0) 89 123456')).toBe('+4989123456');
    expect(normalizePhone('+49 0170 1234567')).toBe('+491701234567');
    expect(normalizePhone('+43 (0)1 234567')).toBe('+431234567');
    expect(normalizePhone('+41 (0)44 1234567')).toBe('+41441234567');
    // unchanged: national numbers, other countries, Italy's 0 that belongs to the number
    expect(normalizePhone('(030) 1234567')).toBe('+49301234567');
    expect(normalizePhone('0176 123 456')).toBe('+49176123456');
    expect(normalizePhone('+39 06 1234567')).toBe('+39061234567');
    expect(normalizePhone('+1 (212) 555-0100')).toBe('+12125550100');
    const a = (await t.api.post('/api/contacts', { first_name: 'Rita', phone: '+49 30 7654321' })).data;
    const b = (await t.api.post('/api/contacts', { first_name: 'Rita', phone: '+49 (0)30 7654321' })).data;
    expect(b.id).toBe(a.id);
  });
});

describe('the Stornorechnung of a final invoice refunds what the final invoice asked for', () => {
  it('PDF and XRechnung say 833 € (1 190 € less the 357 € partial invoice that stays valid), like the online document', async () => {
    const p0 = (await t.api.post('/api/invoices', { contact_id: contactId, inv_type: 'partial', items: [{ name: 'Abschlag', qty: 1, price_cents: 30000, tax_rate: 19 }] })).data;
    const partial = (await t.api.post(`/api/invoices/${p0.id}/finalise`)).data;
    const f0 = (await t.api.post('/api/invoices', { contact_id: contactId, inv_type: 'final', deduct_ids: [partial.id], items: [{ name: 'Projekt', qty: 1, price_cents: 100000, tax_rate: 19 }] })).data;
    const fin = (await t.api.post(`/api/invoices/${f0.id}/finalise`)).data;
    expect(fin.open_cents).toBe(83300);
    const r = await t.api.post(`/api/invoices/${fin.id}/storno`, { reason: 'Auftrag storniert' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const storno = r.data.storno;
    expect(storno.total_cents).toBe(-119000);
    const page = await (await t.api.raw(`/i/${storno.public_token}`)).text();
    expect(page).toContain('-833,00');
    const pdf = Buffer.from(await (await t.api.raw(`/i/${storno.public_token}/pdf`)).arrayBuffer()).toString('latin1');
    expect(pdf).toContain('-833,00');
    expect(pdf).not.toContain('1.547,00');
    const x = (await t.api.get(`/api/invoices/${storno.id}/xrechnung?format=json`)).data;
    expect(x.xml).toContain('<ram:DuePayableAmount>833.00</ram:DuePayableAmount>');
    expect(x.xml).toContain('<ram:TotalPrepaidAmount>357.00</ram:TotalPrepaidAmount>');
    expect(x.validation.errors).toEqual([]);
  });
});

describe('an invoice paid through a bank statement is paid on the day of the bank booking', () => {
  it('confirming September statement lines in October dates the payment in September, not on the day of the click', async () => {
    if (!t.app.db.get<any>("SELECT 1 AS x FROM acc_accounts WHERE location_id = ? LIMIT 1", t.api.location)) expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Beratung', qty: 1, price_cents: 25000, tax_rate: 19 }] })).data;
    const inv = (await t.api.post(`/api/invoices/${draft.id}/finalise`)).data;
    const csv = `Buchungstag;Valuta;Auftraggeber/Empfänger;Verwendungszweck;Betrag\n15.09.2026;15.09.2026;Kunde GmbH;Rechnung ${inv.number};297,50\n`;
    const imp = await t.api.post('/api/accounting/bank/import', { name: 'september.csv', content: csv });
    expect(imp.status, JSON.stringify(imp.data)).toBe(200);
    const txn = ((await t.api.get('/api/accounting/bank/txns')).data.txns as any[]).find((x) => x.purpose.includes(inv.number));
    const r = await t.api.post(`/api/accounting/bank/txns/${txn.id}/confirm`, { kind: 'invoice', id: inv.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const after = (await t.api.get(`/api/invoices/${inv.id}`)).data;
    expect(after.status).toBe('paid');
    expect(after.paid_at.slice(0, 10)).toBe('2026-09-15');
    const pays = (await t.api.get(`/api/invoices/${inv.id}/payments`)).data as any[];
    expect(pays.map((p) => p.paid_at.slice(0, 10))).toEqual(['2026-09-15']);
  });
});

describe('a line with a negative quantity is a deduction, not nothing', () => {
  it('"Rabatt, Menge −1, 10 €" lowers the invoice by 10 € instead of silently becoming 0', async () => {
    const inv = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Leistung', qty: 1, price_cents: 10000, tax_rate: 19 }, { name: 'Rabatt', qty: -1, price_cents: 1000, tax_rate: 19 }] })).data;
    expect(inv.subtotal_cents).toBe(9000);
    expect(inv.total_cents).toBe(10710);
    const back = (await t.api.get(`/api/invoices/${inv.id}`)).data;
    expect(back.items[1]).toMatchObject({ name: 'Rabatt', qty: 1, price_cents: -1000 });
    // editing keeps it
    const p = (await t.api.patch(`/api/invoices/${inv.id}`, { items: [{ name: 'Leistung', qty: 2, price_cents: 10000, tax_rate: 19 }, { name: 'Rabatt', qty: -2, price_cents: 1000, tax_rate: 19 }] })).data;
    expect(p.subtotal_cents).toBe(18000);
  });
});
