import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { CHARTS, DEFAULT_MAPPING, MAPPING_KEYS, type Standard } from '../server/services/acc-chart.js';
import { TAX_CODES, codeForRate, splitAmount, splitGross, vatFromNet, type TaxCode } from '../server/services/acc-vat.js';
import { balance, expandPosting, normalizePosting, postEntry, stornoEntry, verifyChain, type AccountRow } from '../server/services/acc-ledger.js';
import { euer, ustva, susa, bwa, openItems, recognize } from '../server/services/acc-reports.js';
import { EXTF_FIELDS, EXTF_HEADER_FIELDS, EXTF_HEADINGS, buildExtf, decodeCp1252, encodeCp1252, parseExtf, readZip } from '../server/services/acc-datev.js';
import { createInvoice } from '../server/modules/payments.js';
import { finaliseInvoice } from '../server/services/invoice-flow.js';
import { postInvoicePayment, syncInvoices, invoicePostings } from '../server/services/acc-autopost.js';

// Setting up a test app and logging in a few users takes long when the machine is busy.
vi.setConfig({ hookTimeout: 60_000 });

const chartOf = (standard: Standard): Map<string, AccountRow> =>
  new Map(CHARTS[standard].map((a) => [a.n, { id: a.n, location_id: 'x', number: a.n, name: a.name, type: a.type, kind: a.kind ?? '', auto_tax: a.auto ?? '', grp: a.grp ?? '', active: 1, custom: 0 }]));

describe('VAT maths (19 %, 7 %, 0 %, reverse charge)', () => {
  it('computes tax from net and splits gross, rounding to whole cents', () => {
    expect(vatFromNet(10000, 19)).toBe(1900);
    expect(vatFromNet(10000, 7)).toBe(700);
    expect(vatFromNet(10000, 0)).toBe(0);
    expect(vatFromNet(995, 19)).toBe(189); // 189.05 → 189
    expect(vatFromNet(996, 19)).toBe(189); // 189.24
    expect(vatFromNet(997, 19)).toBe(189); // 189.43
    expect(vatFromNet(998, 19)).toBe(190); // 189.62
    expect(splitGross(11900, 19)).toEqual({ net: 10000, tax: 1900 });
    expect(splitGross(10700, 7)).toEqual({ net: 10000, tax: 700 });
    expect(splitGross(5000, 0)).toEqual({ net: 5000, tax: 0 });
    expect(splitGross(1, 19)).toEqual({ net: 1, tax: 0 });
    for (const gross of [1, 99, 100, 119, 1190, 9999, 123457]) for (const rate of [7, 19]) {
      const s = splitGross(gross, rate);
      expect(s.net + s.tax).toBe(gross);
      expect(Math.abs(s.tax - (gross * rate) / (100 + rate))).toBeLessThanOrEqual(0.5);
    }
  });

  it('takes known net and tax as printed on an invoice; reverse charge self-assesses the tax and pays only the net', () => {
    expect(splitAmount('ust19', 11900)).toEqual({ net: 10000, tax: 1900, gross: 11900 });
    expect(splitAmount('ust19', 11901, { net: 10001, tax: 1900 })).toEqual({ net: 10001, tax: 1900, gross: 11901 });
    expect(splitAmount('vst7', 535)).toEqual({ net: 500, tax: 35, gross: 535 });
    expect(splitAmount('ust0', 5000)).toEqual({ net: 5000, tax: 0, gross: 5000 });
    expect(splitAmount('kl', 5000)).toEqual({ net: 5000, tax: 0, gross: 5000 });
    // Reverse charge: the invoice shows no tax, the recipient owes 19 % of the net.
    expect(splitAmount('rc19', 10000)).toEqual({ net: 10000, tax: 1900, gross: 10000 });
    expect(codeForRate(19, 'output')).toBe('ust19');
    expect(codeForRate(7, 'input')).toBe('vst7');
    expect(codeForRate(0, 'output')).toBe('ust0');
    expect(TAX_CODES.rc19.kz_base).toBe('46');
    expect(TAX_CODES.vst19.datev).toBe('9');
    expect(TAX_CODES.ust19.datev).toBe('3');
  });
});

describe('chart of accounts', () => {
  for (const std of ['skr03', 'skr04'] as const) {
    it(`${std}: unique 4-digit numbers, defaults exist, automatic accounts carry their tax code`, () => {
      const chart = chartOf(std);
      expect(chart.size).toBe(CHARTS[std].length);
      for (const n of chart.keys()) expect(n).toMatch(/^\d{4}$/);
      for (const k of MAPPING_KEYS) expect(chart.has(DEFAULT_MAPPING[std][k]), `${std} ${k} → ${DEFAULT_MAPPING[std][k]}`).toBe(true);
      const m = DEFAULT_MAPPING[std];
      expect(chart.get(m.revenue19)!.auto_tax).toBe('ust19');
      expect(chart.get(m.revenue7)!.auto_tax).toBe('ust7');
      expect(chart.get(m.bank)!.kind).toBe('bank');
      expect(chart.get(m.receivable)!.kind).toBe('receivable');
      expect(chart.get(m.payable)!.kind).toBe('payable');
      expect(chart.get(m.vat_out19)!.kind).toBe('vat_out');
      expect(chart.get(m.vat_in19)!.kind).toBe('vat_in');
      expect(chart.get(m.default_expense)!.type).toBe('expense');
    });
  }
  it('uses the DATEV numbers of the standard charts for the accounts that matter', () => {
    expect(DEFAULT_MAPPING.skr03).toMatchObject({ bank: '1200', receivable: '1400', payable: '1600', revenue19: '8400', vat_out19: '1776', vat_in19: '1576', vat_rc_in: '1577', vat_rc_out: '1787' });
    expect(DEFAULT_MAPPING.skr04).toMatchObject({ bank: '1800', receivable: '1200', payable: '3300', revenue19: '4400', vat_out19: '3806', vat_in19: '1406', vat_rc_in: '1407', vat_rc_out: '3837' });
  });
});

describe('double-entry: every posting expands to balanced lines', () => {
  const sums = (std: Standard) => {
    const chart = chartOf(std);
    const m = DEFAULT_MAPPING[std];
    return { chart, m };
  };

  for (const std of ['skr03', 'skr04'] as const) {
    it(`${std}: revenue, expense, reverse charge, credit notes and refunds all balance`, () => {
      const { chart, m } = sums(std);
      const expense = std === 'skr03' ? '4930' : '6815';
      const cases: { debit: string; credit: string; amount_cents: number; tax_code: TaxCode; net_cents?: number; tax_cents?: number }[] = [
        { debit: m.receivable, credit: m.revenue19, amount_cents: 11900, tax_code: 'ust19' },
        { debit: m.receivable, credit: m.revenue7, amount_cents: 10700, tax_code: 'ust7' },
        { debit: m.receivable, credit: m.revenue0, amount_cents: 5000, tax_code: 'ust0' },
        { debit: m.receivable, credit: m.revenue19, amount_cents: 11901, net_cents: 10001, tax_cents: 1900, tax_code: 'ust19' },
        { debit: m.bank, credit: m.revenue_small, amount_cents: 7777, tax_code: 'kl' },
        { debit: m.receivable, credit: m.revenue_rc, amount_cents: 9000, tax_code: 'ust_rc' },
        { debit: expense, credit: m.payable, amount_cents: 11900, tax_code: 'vst19' },
        { debit: expense, credit: m.bank, amount_cents: 10700, tax_code: 'vst7' },
        { debit: expense, credit: m.cash, amount_cents: 333, tax_code: 'vst0' },
        { debit: expense, credit: m.payable, amount_cents: 10000, tax_code: 'rc19' },
        // A credit note / refund: the same accounts the other way round.
        { debit: m.payable, credit: expense, amount_cents: 11900, tax_code: 'vst19' },
        { debit: m.revenue19, credit: m.receivable, amount_cents: 11900, tax_code: 'ust19' },
        { debit: m.bank, credit: m.receivable, amount_cents: 4200, tax_code: 'none' },
      ];
      for (const c of cases) {
        const p = normalizePosting(c, chart, m);
        const lines = expandPosting(p, m);
        const b = balance(lines);
        expect(b.balanced, JSON.stringify(c)).toBe(true);
        expect(b.debit).toBe(b.credit);
        // Net + tax = gross (reverse charge: the payment is the net).
        if (c.tax_code !== 'rc19') expect(p.net_cents + p.tax_cents).toBe(p.amount_cents);
      }
    });
  }

  it('reverse charge books expense, input tax and output tax of § 13b so that the payable is the net amount', () => {
    const { chart, m } = sums('skr03');
    const p = normalizePosting({ debit: '4964', credit: m.payable, amount_cents: 10000, tax_code: 'rc19', text: 'Cloud EU' }, chart, m);
    const lines = expandPosting(p, m);
    expect(lines.find((l) => l.account === '4964')).toMatchObject({ side: 'S', cents: 10000 });
    expect(lines.find((l) => l.account === '1577')).toMatchObject({ side: 'S', cents: 1900, is_tax: 2 });
    expect(lines.find((l) => l.account === '1787')).toMatchObject({ side: 'H', cents: 1900, is_tax: 1 });
    expect(lines.find((l) => l.account === m.payable)).toMatchObject({ side: 'H', cents: 10000 });
  });

  it('refuses what DATEV would book differently or what makes no sense', () => {
    const { chart, m } = sums('skr03');
    // 8400 is an Automatikkonto for 19 %: 7 % or "no tax" there would double or lose the tax in DATEV.
    expect(() => normalizePosting({ debit: m.receivable, credit: '8400', amount_cents: 1000, tax_code: 'ust7' }, chart, m)).toThrow(/automatisch/);
    expect(() => normalizePosting({ debit: m.receivable, credit: '8400', amount_cents: 1000, tax_code: 'none' }, chart, m)).toThrow(/automatisch/);
    expect(() => normalizePosting({ debit: '4930', credit: m.bank, amount_cents: 1000, tax_code: 'ust19' }, chart, m)).toThrow(/Erlöskonto/);
    expect(() => normalizePosting({ debit: m.bank, credit: m.cash, amount_cents: 1000, tax_code: 'vst19' }, chart, m)).toThrow(/Aufwands- oder Anlagekonto/);
    expect(() => normalizePosting({ debit: m.bank, credit: '8200', amount_cents: 1000, tax_code: 'vst19' }, chart, m)).toThrow(/Vorsteuer gehört auf ein Aufwands/);
    expect(() => normalizePosting({ debit: '9999', credit: m.bank, amount_cents: 1000 }, chart, m)).toThrow(/gibt es nicht/);
    expect(() => normalizePosting({ debit: m.bank, credit: m.bank, amount_cents: 1000 }, chart, m)).toThrow(/verschieden/);
    expect(() => normalizePosting({ debit: '4930', credit: m.bank, amount_cents: 0 }, chart, m)).toThrow(/größer als 0/);
    expect(() => normalizePosting({ debit: '4930', credit: m.bank, amount_cents: 10.5 }, chart, m)).toThrow(/ganze Zahl/);
    expect(() => normalizePosting({ debit: '4930', credit: m.bank, amount_cents: 1000, tax_code: 'bogus' }, chart, m)).toThrow(/Unbekannter Steuerschlüssel/);
  });
});

// --- a fixture year through the real app -------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
const api = () => t.api;

async function enable(standard: Standard = 'skr03') {
  const r = await api().post('/api/accounting/setup', { standard });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
}

const ids: Record<string, string> = {};
const post = (date: string, text: string, postings: any[], extra: Record<string, unknown> = {}) => {
  const out = postEntry(t.app, loc, { date, text, postings, ...extra });
  return out.entry;
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  await enable('skr03');
});
afterAll(() => t.close());

describe('the journal', () => {
  it('posts a balanced entry, numbers it and chains it to the previous one', async () => {
    const e1 = post('2025-01-02', 'Einlage', [{ debit: '1200', credit: '1890', amount_cents: 100000, tax_code: 'none' }]);
    const e2 = post('2025-01-03', 'Bürobedarf', [{ debit: '4930', credit: '1200', amount_cents: 11900, tax_code: 'vst19' }], { doc_ref: 'RE-77', party_name: 'Papier AG' });
    expect(e1.number).toBe('B-000001');
    expect(e2.number).toBe('B-000002');
    expect(e2.prev_hash).toBe(e1.hash);
    expect(e2.lines.map((l) => [l.account, l.side, l.cents])).toEqual([['4930', 'S', 10000], ['1576', 'S', 1900], ['1200', 'H', 11900]]);
    expect(balance(e2.lines).balanced).toBe(true);
    expect(verifyChain(t.app, loc)).toMatchObject({ ok: true, checked: 2 });
  });

  it('is idempotent per source key and refuses unbalanced or incomplete input over the API', async () => {
    const input = { date: '2025-01-04', text: 'Einmalig', source_key: 'test:once', postings: [{ debit: '1200', credit: '8200', amount_cents: 500, tax_code: 'ust0' }] };
    const a = postEntry(t.app, loc, input);
    const b = postEntry(t.app, loc, input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    const bad = await api().post('/api/accounting/entries', { date: '2025-01-05', text: 'x', postings: [{ debit: '1200', credit: '1200', amount_cents: 100 }] });
    expect(bad.status).toBe(400);
    expect((await api().post('/api/accounting/entries', { date: '2025-13-45', text: 'x', postings: [{ debit: '1200', credit: '8200', amount_cents: 100 }] })).data.error).toMatch(/JJJJ-MM-TT/);
    expect((await api().post('/api/accounting/entries', { date: '2025-01-05', text: '', postings: [{ debit: '1200', credit: '8200', amount_cents: 100 }] })).status).toBe(400);
    const ok = await api().post('/api/accounting/entries', { date: '2025-01-05', text: 'Per API', postings: [{ debit: '1200', credit: '8400', amount_cents: 11900, tax_code: 'ust19' }] });
    expect(ok.status).toBe(200);
    expect(ok.data.lines).toHaveLength(3);
  });

  it('never changes or deletes a posted entry: the database refuses, a Storno cancels', async () => {
    const e = post('2025-02-01', 'Falsch gebucht', [{ debit: '4930', credit: '1200', amount_cents: 2380, tax_code: 'vst19' }], { doc_ref: 'X-1' });
    const db = t.app.db;
    expect(() => db.run('UPDATE acc_entries SET text = ? WHERE id = ?', 'manipuliert', e.id)).toThrow(/unveränderbar/);
    expect(() => db.run('UPDATE acc_entries SET date = ? WHERE id = ?', '2025-03-01', e.id)).toThrow(/unveränderbar/);
    expect(() => db.run('UPDATE acc_lines SET cents = 1 WHERE entry_id = ?', e.id)).toThrow(/unveränderbar/);
    expect(() => db.run('DELETE FROM acc_lines WHERE entry_id = ?', e.id)).toThrow(/nicht löschen/);
    expect(() => db.run('DELETE FROM acc_entries WHERE id = ?', e.id)).toThrow(/nicht löschen/);
    expect(() => db.run('UPDATE acc_audit SET detail = ? WHERE location_id = ?', 'x', loc)).toThrow(/unveränderbar/);
    expect(() => db.run('DELETE FROM acc_audit WHERE location_id = ?', loc)).toThrow(/unveränderbar/);

    const r = await api().post(`/api/accounting/entries/${e.id}/storno`, { reason: 'Doppelt erfasst', date: '2025-02-02' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.reverses_id).toBe(e.id);
    expect(r.data.text).toContain('Storno');
    // Exactly the opposite lines: the accounts net out to zero.
    const net = new Map<string, number>();
    for (const l of [...e.lines, ...r.data.lines]) net.set(l.account, (net.get(l.account) ?? 0) + (l.side === 'S' ? l.cents : -l.cents));
    expect([...net.values()].every((v) => v === 0)).toBe(true);
    const detail = (await api().get(`/api/accounting/entries/${e.id}`)).data;
    expect(detail.reversal.id).toBe(r.data.id);
    expect(db.get<any>('SELECT reversed_by FROM acc_entries WHERE id = ?', e.id)!.reversed_by).toBe(r.data.id);
    // Once cancelled, neither again nor the storno itself.
    expect((await api().post(`/api/accounting/entries/${e.id}/storno`, {})).data.error).toMatch(/schon storniert/);
    expect((await api().post(`/api/accounting/entries/${r.data.id}/storno`, {})).data.error).toMatch(/Storno-Buchung/);
    expect(() => db.run('UPDATE acc_entries SET reversed_by = ? WHERE id = ?', 'other', e.id)).toThrow(/schon storniert/);
    expect(verifyChain(t.app, loc).ok).toBe(true);
  });

  it('locks months for good (Festschreibung): no booking into them, no unlocking, storno only in an open month', async () => {
    const jan = post('2025-04-02', 'April-Buchung', [{ debit: '4930', credit: '1200', amount_cents: 1190, tax_code: 'vst19' }]);
    const lock = await api().post('/api/accounting/periods/lock', { through: '2025-04' });
    expect(lock.status).toBe(200);
    expect(lock.data.locked).toContain('2025-04');
    expect(lock.data.locked).toContain('2025-01');
    const periods = (await api().get('/api/accounting/periods?year=2025')).data.periods;
    expect(periods.filter((p: any) => p.locked).map((p: any) => p.period)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04']);
    const refused = await api().post('/api/accounting/entries', { date: '2025-04-20', text: 'zu spät', postings: [{ debit: '4930', credit: '1200', amount_cents: 100, tax_code: 'vst19' }] });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/festgeschrieben/);
    // The database itself keeps a locked month locked.
    expect(() => t.app.db.run('UPDATE acc_periods SET locked_at = NULL WHERE location_id = ?', loc)).toThrow(/nicht wieder öffnen/);
    expect(() => t.app.db.run('DELETE FROM acc_periods WHERE location_id = ?', loc)).toThrow(/nicht wieder öffnen/);
    // Storno of an entry in a locked month: not on that date, but on an open one.
    const onLocked = await api().post(`/api/accounting/entries/${jan.id}/storno`, { date: '2025-04-30' });
    expect(onLocked.status).toBe(409);
    const open = await api().post(`/api/accounting/entries/${jan.id}/storno`, { date: '2025-05-02', reason: 'Fehler' });
    expect(open.status).toBe(200);
    expect(open.data.date).toBe('2025-05-02');
    // bookingDate moves a backdated document into the first open month instead of failing.
    const trail = (await api().get('/api/accounting/audit?limit=50')).data;
    expect(trail.some((a: any) => a.action === 'period.lock')).toBe(true);
  });

  it('detects tampering behind the application (hash chain) and keeps the audit trail', async () => {
    expect(verifyChain(t.app, loc).ok).toBe(true);
    const db = t.app.db;
    const e = db.get<any>(`SELECT id, number FROM acc_entries WHERE location_id = ? AND number = 'B-000002'`, loc)!;
    // Someone with database access drops the guard and edits an amount.
    db.raw.exec('DROP TRIGGER acc_lines_no_update');
    db.run(`UPDATE acc_lines SET cents = cents + 1 WHERE entry_id = ? AND side = 'S' AND is_tax = 0`, e.id);
    const broken = verifyChain(t.app, loc);
    expect(broken.ok).toBe(false);
    expect(broken.reason).toContain('B-000002');
    const verify = (await api().get('/api/accounting/verify')).data;
    expect(verify.ok).toBe(false);
    db.run(`UPDATE acc_lines SET cents = cents - 1 WHERE entry_id = ? AND side = 'S' AND is_tax = 0`, e.id);
    db.raw.exec(`CREATE TRIGGER acc_lines_no_update BEFORE UPDATE ON acc_lines BEGIN SELECT RAISE(ABORT, 'Gebuchte Buchungen sind unveränderbar (GoBD) – bitte stornieren'); END;`);
    expect(verifyChain(t.app, loc).ok).toBe(true);
    const audit = (await api().get('/api/accounting/audit?limit=200')).data as any[];
    expect(audit.length).toBeGreaterThan(5);
    expect(audit.some((a) => a.action === 'entry.storno')).toBe(true);
  });
});

describe('invoice auto-posting', () => {
  it('books issue and payment of HyperLevel invoices, once, with the invoice numbers as document numbers', async () => {
    const mk = (items: any[], extra: any = {}) => createInvoice(t.app, loc, { items, ...extra });
    const a0 = mk([{ name: 'Beratung', qty: 1, price_cents: 100000, tax_rate: 19 }], { issued_at: '2025-06-10T09:00:00Z', title: 'Juni' });
    const b0 = mk([{ name: 'Buch', qty: 2, price_cents: 5000, tax_rate: 7 }, { name: 'Beratung', qty: 1, price_cents: 20000, tax_rate: 19 }], { issued_at: '2025-06-12T09:00:00Z' });
    ids.a = a0.id;
    ids.b = b0.id;
    // A draft is not booked.
    expect(syncInvoices(t.app, loc)).toMatchObject({ posted: 0 });
    // Finalising gives the number (drafts have none) and makes the invoice bookable.
    const a = finaliseInvoice(t.app, loc, a0.id).invoice;
    const b = finaliseInvoice(t.app, loc, b0.id).invoice;
    expect(a.number).toMatch(/^RE-\d+$/);
    expect(syncInvoices(t.app, loc)).toMatchObject({ posted: 2, payments: 0, errors: [] });
    expect(syncInvoices(t.app, loc)).toMatchObject({ posted: 0, payments: 0 });
    const ea = t.app.db.get<any>(`SELECT * FROM acc_entries WHERE location_id = ? AND source_key = ?`, loc, `invoice:${a.id}:issue`)!;
    expect(ea.doc_ref).toBe(a.number);
    expect(ea.date).toBe('2025-06-10');
    const lines = t.app.db.all<any>('SELECT account, side, cents FROM acc_lines WHERE entry_id = ? ORDER BY line_no', ea.id);
    expect(lines).toEqual([{ account: '8400', side: 'H', cents: 100000 }, { account: '1776', side: 'H', cents: 19000 }, { account: '1400', side: 'S', cents: 119000 }]);
    // Two rates → two postings, ledger total = invoice total.
    const eb = t.app.db.all<any>(`SELECT l.account, l.side, l.cents FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE e.source_key = ? AND l.account = '1400'`, `invoice:${b.id}:issue`);
    expect(eb.reduce((n, l) => n + l.cents, 0)).toBe(b.total_cents);
    expect(JSON.parse(t.app.db.get<any>('SELECT postings FROM acc_entries WHERE source_key = ?', `invoice:${b.id}:issue`)!.postings)).toHaveLength(2);
    // Payment.
    t.app.db.run(`UPDATE invoices SET status = 'paid', paid_at = '2025-06-20T10:00:00Z' WHERE id = ?`, a.id);
    expect(syncInvoices(t.app, loc)).toMatchObject({ posted: 0, payments: 1 });
    expect(syncInvoices(t.app, loc)).toMatchObject({ payments: 0 });
    const pay = t.app.db.get<any>(`SELECT * FROM acc_entries WHERE source_key = ?`, `invoice:${a.id}:payment`)!;
    expect(pay.date).toBe('2025-06-20');
    expect(t.app.db.all<any>('SELECT account, side, cents FROM acc_lines WHERE entry_id = ? ORDER BY line_no', pay.id)).toEqual([{ account: '1200', side: 'S', cents: 119000 }, { account: '1400', side: 'H', cents: 119000 }]);
    // Open items: b is open, a is settled.
    const op = openItems(t.app, loc, 'receivable', '2025-12-31');
    expect(op.items.map((i) => i.doc_ref)).toEqual([b.number]);
    expect(op.total_cents).toBe(b.total_cents);
  });

  it('cancels the entry of a voided invoice with a Storno and keeps the books balanced', async () => {
    const c = finaliseInvoice(t.app, loc, createInvoice(t.app, loc, { items: [{ name: 'Falsch', qty: 1, price_cents: 5000, tax_rate: 19 }], issued_at: '2025-07-01T09:00:00Z' }).id).invoice;
    syncInvoices(t.app, loc);
    t.app.db.run(`UPDATE invoices SET status = 'void' WHERE id = ?`, c.id);
    expect(syncInvoices(t.app, loc)).toMatchObject({ cancelled: 1 });
    expect(syncInvoices(t.app, loc)).toMatchObject({ cancelled: 0 });
    // The Storno is dated today: look at the balance as of the end of the year after.
    const op = openItems(t.app, loc, 'receivable', '2099-12-31');
    expect(op.items.find((i) => i.doc_ref === c.number)).toBeUndefined();
    expect(verifyChain(t.app, loc).ok).toBe(true);
  });

  it('builds the postings per rate, for Kleinunternehmer and for reverse-charge invoices', () => {
    const m = DEFAULT_MAPPING.skr03;
    const items = [{ name: 'A', qty: 1, price_cents: 10000, tax_rate: 19 }];
    expect(invoicePostings({ number: 'R1', items, total_cents: 11900 }, { mapping: m, vat_mode: 'regular' }).postings).toEqual([{ debit: '1400', credit: '8400', amount_cents: 11900, net_cents: 10000, tax_cents: 1900, tax_code: 'ust19', text: 'R1' }]);
    const small = invoicePostings({ number: 'R2', items: [{ name: 'A', qty: 1, price_cents: 10000, tax_rate: 0 }], total_cents: 10000 }, { mapping: m, vat_mode: 'small' }).postings;
    expect(small).toEqual([{ debit: '1400', credit: '8195', amount_cents: 10000, tax_code: 'kl', text: 'R2' }]);
    const rc = invoicePostings({ number: 'R3', title: 'Beratung (Reverse Charge, § 13b UStG)', items: [{ name: 'A', qty: 1, price_cents: 10000, tax_rate: 0 }], total_cents: 10000 }, { mapping: m, vat_mode: 'regular' }).postings;
    expect(rc[0]).toMatchObject({ credit: '8336', tax_code: 'ust_rc', amount_cents: 10000 });
    expect(() => invoicePostings({ number: 'R4', items: [{ name: 'A', qty: 1, price_cents: 10000, tax_rate: 16 }], total_cents: 11600 }, { mapping: m, vat_mode: 'regular' })).toThrow(/16 %/);
  });
});

// --- EÜR on a fixture year ---------------------------------------------------------------------------------------

describe('EÜR, USt-Voranmeldung, SuSa and BWA on a fixture year', () => {
  let t2: Awaited<ReturnType<typeof startTestApp>>;
  let l2 = '';
  const p2 = (date: string, text: string, postings: any[], extra: Record<string, unknown> = {}) => postEntry(t2.app, l2, { date, text, postings, ...extra }).entry;

  beforeAll(async () => {
    t2 = await startTestApp();
    await t2.setup();
    l2 = t2.api.location;
    expect((await t2.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    const mk = (items: any[], issued: string) => finaliseInvoice(t2.app, l2, createInvoice(t2.app, l2, { items, issued_at: `${issued}T09:00:00Z` }).id).invoice;
    // Sales: A 1190 (19 %), paid in February; B 535 (7 %), issued in March, paid in April; C 2380 issued in December, paid in January 2026.
    const A = mk([{ name: 'A', qty: 1, price_cents: 100000, tax_rate: 19 }], '2025-01-10');
    const B = mk([{ name: 'B', qty: 1, price_cents: 50000, tax_rate: 7 }], '2025-03-01');
    const C = mk([{ name: 'C', qty: 1, price_cents: 200000, tax_rate: 19 }], '2025-12-20');
    syncInvoices(t2.app, l2);
    for (const [inv, date] of [[A, '2025-02-05'], [B, '2025-04-02'], [C, '2026-01-15']] as const) {
      t2.app.db.run(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`, `${date}T08:00:00Z`, inv.id);
      postInvoicePayment(t2.app, l2, { ...inv, paid_at: `${date}T08:00:00Z` });
    }
    // Expenses: office supplies paid at once (gross 119), software on credit paid in January 2026, rent on credit paid in December.
    p2('2025-03-03', 'Bürobedarf', [{ debit: '4930', credit: '1200', amount_cents: 11900, tax_code: 'vst19' }]);
    p2('2025-11-10', 'Software-Abo', [{ debit: '4964', credit: '1600', amount_cents: 23800, tax_code: 'vst19' }], { doc_ref: 'SW-1' });
    p2('2025-12-01', 'Miete Dezember', [{ debit: '4210', credit: '1600', amount_cents: 60000, tax_code: 'vst0' }], { doc_ref: 'MIETE-12' });
    p2('2025-12-15', 'Zahlung Miete', [{ debit: '1600', credit: '1200', amount_cents: 60000, tax_code: 'none' }], { doc_ref: 'MIETE-12' });
    p2('2026-01-05', 'Zahlung Software', [{ debit: '1600', credit: '1200', amount_cents: 23800, tax_code: 'none' }], { doc_ref: 'SW-1' });
    // Tax office, private withdrawal, an asset.
    p2('2025-04-10', 'Umsatzsteuer-Vorauszahlung', [{ debit: '1780', credit: '1200', amount_cents: 40000, tax_code: 'none' }]);
    p2('2025-05-01', 'Entnahme', [{ debit: '1800', credit: '1200', amount_cents: 30000, tax_code: 'none' }]);
    p2('2025-06-01', 'Laptop', [{ debit: '0420', credit: '1200', amount_cents: 119000, tax_code: 'vst19' }]);
    // A reverse-charge purchase (cloud service from the EU): nets to zero tax.
    p2('2025-07-01', 'Hosting EU', [{ debit: '4964', credit: '1200', amount_cents: 10000, tax_code: 'rc19' }]);
  });
  afterAll(() => t2.close());

  it('EÜR 2025 counts money when it moved (Zufluss/Abfluss)', () => {
    const r = euer(t2.app, l2, '2025-01-01', '2025-12-31');
    // Income: A 1000 + B 500 (C only in 2026); VAT collected 190 + 35.
    expect(r.income.net_cents).toBe(150000);
    expect(r.income.vat_collected_cents).toBe(22500);
    expect(r.income.total_cents).toBe(172500);
    expect(r.income.groups.map((g) => [g.group, g.net_cents])).toEqual([['revenue', 150000]]);
    // Expenses: office 100 + rent 600 + hosting 100 (paid at once); software only in 2026. Input tax: office 19 (+ laptop is an asset).
    expect(r.expenses.net_cents).toBe(10000 + 60000 + 10000);
    expect(r.expenses.vat_paid_cents).toBe(1900 + 19000); // office 19 + laptop 190 (the tax of an asset is input tax too)
    expect(r.expenses.vat_to_tax_office_cents).toBe(40000);
    expect(r.expenses.total_cents).toBe(80000 + 20900 + 40000);
    expect(r.profit_cents).toBe(172500 - 140900);
    expect(r.profit_net_cents).toBe(150000 - 80000);
    expect(r.private_withdrawals_cents).toBe(30000);
    expect(r.investments_cents).toBe(100000);
    expect(r.expenses.groups.flatMap((g) => g.accounts.map((a) => [a.account, a.net_cents])).sort()).toEqual([['4210', 60000], ['4930', 10000], ['4964', 10000]]);
    // January 2026: C's income, the software expense – nothing of 2025 leaks in.
    const next = euer(t2.app, l2, '2026-01-01', '2026-12-31');
    expect(next.income.net_cents).toBe(200000);
    expect(next.income.vat_collected_cents).toBe(38000);
    expect(next.expenses.net_cents).toBe(20000);
    expect(next.expenses.vat_paid_cents).toBe(3800);
  });

  it('a partial payment counts in proportion', () => {
    const rec = recognize(t2.app, l2, '2026-12-31', 'cash');
    // 1000 + 500 + 2000 income net in total over both years.
    expect(rec.recs.filter((x) => x.type === 'income').reduce((n, x) => n + x.net, 0)).toBe(350000);
  });

  it('USt-Voranmeldung: Kennzahlen 81, 86, 66, 46/47, 67 and the balance (Soll- and Ist-Versteuerung)', async () => {
    const q1 = ustva(t2.app, l2, '2025-Q1');
    const kz = (r: ReturnType<typeof ustva>, k: string) => r.lines.find((l) => l.kz === k)!;
    expect(kz(q1, '81')).toMatchObject({ base_cents: 100000, tax_cents: 19000 });
    expect(kz(q1, '86')).toMatchObject({ base_cents: 50000, tax_cents: 3500 });
    expect(kz(q1, '66').tax_cents).toBe(1900);
    expect(q1.output_tax_cents).toBe(22500);
    expect(q1.input_tax_cents).toBe(1900);
    expect(q1.kz83_cents).toBe(20600);
    expect(q1.method).toContain('Soll');
    // Q3 holds the reverse-charge purchase (July) and the laptop (June is Q2).
    const q3 = ustva(t2.app, l2, '2025-Q3');
    expect(kz(q3, '46/47')).toMatchObject({ base_cents: 10000, tax_cents: 1900 });
    expect(kz(q3, '67').tax_cents).toBe(1900);
    expect(q3.kz83_cents).toBe(0);
    const q2 = ustva(t2.app, l2, '2025-Q2');
    expect(kz(q2, '66').tax_cents).toBe(19000); // the laptop (an asset): 190 input tax
    expect(q2.kz83_cents).toBe(-19000);
    // Monthly and yearly periods.
    expect(ustva(t2.app, l2, '2025-03').from).toBe('2025-03-01');
    expect(ustva(t2.app, l2, '2025-02').to).toBe('2025-02-28');
    expect(ustva(t2.app, l2, '2025').lines.find((l) => l.kz === '81')!.base_cents).toBe(300000); // A and C are both issued in 2025
    expect(() => ustva(t2.app, l2, '2025-13')).toThrow(/Zeitraum/);
    // Ist-Versteuerung: the output tax of B (issued March, paid April) moves from Q1 to Q2.
    expect((await t2.api.put('/api/accounting/settings', { vat_method: 'ist' })).status).toBe(200);
    const ist1 = ustva(t2.app, l2, '2025-Q1');
    expect(kz(ist1, '86').tax_cents).toBe(0);
    expect(kz(ist1, '81').tax_cents).toBe(19000);
    expect(kz(ustva(t2.app, l2, '2025-Q2'), '86').tax_cents).toBe(3500);
    expect(ist1.method).toContain('Ist');
    await t2.api.put('/api/accounting/settings', { vat_method: 'soll' });
  });

  it('SuSa and BWA come from the lines and add up', () => {
    const s = susa(t2.app, l2, '2025-01-01', '2025-12-31');
    expect(s.totals.debit_cents).toBe(s.totals.credit_cents);
    const row = (n: string) => s.rows.find((r) => r.account === n)!;
    expect(row('8400')).toMatchObject({ credit_cents: 300000, debit_cents: 0 });
    expect(row('1400')).toMatchObject({ debit_cents: 119000 + 53500 + 238000, credit_cents: 119000 + 53500 });
    // Balance sheet accounts carry their balance into the next year; revenue accounts start at zero.
    const next = susa(t2.app, l2, '2026-01-01', '2026-12-31');
    expect(next.rows.find((r) => r.account === '1400')!.opening_cents).toBe(238000); // invoice C, paid in January 2026
    expect(next.rows.find((r) => r.account === '8400')?.opening_cents ?? 0).toBe(0);
    const b = bwa(t2.app, l2, '2025-01-01', '2025-12-31', { months: true });
    expect(b.groups.find((g) => g.group === 'revenue')!.cents).toBe(100000 + 50000 + 200000);
    const costs = b.groups.filter((g) => g.type === 'expense').reduce((n, g) => n + g.cents, 0);
    expect(costs).toBe(10000 + 20000 + 60000 + 10000);
    expect(b.totals.result_cents).toBe(350000 - costs);
    expect(b.by_month).toHaveLength(12);
    expect(b.by_month!.reduce((n, m) => n + m.result_cents, 0)).toBe(b.totals.result_cents);
  });
});

// --- DATEV --------------------------------------------------------------------------------------------------------------------

describe('DATEV export (EXTF 700, Buchungsstapel)', () => {
  it('has the 125 columns of format version 13 and a 31-field header row', () => {
    expect(EXTF_HEADINGS).toHaveLength(EXTF_FIELDS);
    expect(EXTF_FIELDS).toBe(125);
    expect(EXTF_HEADINGS[0]).toBe('Umsatz (ohne Soll/Haben-Kz)');
    expect(EXTF_HEADINGS[6]).toBe('Konto');
    expect(EXTF_HEADINGS[8]).toBe('BU-Schlüssel');
    expect(EXTF_HEADINGS[113]).toBe('Festschreibung');
    expect(EXTF_HEADINGS[124]).toBe('Abw. Skontokonto');
  });

  it('writes header, headings and one 125-field row per posting, Windows-1252, CR LF', async () => {
    const set = await api().put('/api/accounting/settings', { datev: { berater: '1001', mandant: '456', account_length: 4, name: 'Testlauf Januar' } });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    const res = await t.api.raw(`/api/accounting/datev/export?from=2025-01-01&to=2025-01-31`, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=windows-1252');
    expect(res.headers.get('content-disposition')).toContain('EXTF_Buchungsstapel_2025-01-01_2025-01-31.csv');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 3).toString('hex')).not.toBe('efbbbf'); // no byte-order mark
    const text = decodeCp1252(buf);
    expect(text.endsWith('\r\n')).toBe(true);
    const rows = parseExtf(text);
    expect(rows[0]).toHaveLength(EXTF_HEADER_FIELDS);
    expect(rows[0].slice(0, 5)).toEqual(['EXTF', '700', '21', 'Buchungsstapel', '13']);
    expect(rows[0][5]).toMatch(/^\d{17}$/);
    expect(rows[0][10]).toBe('1001');
    expect(rows[0][11]).toBe('456');
    expect(rows[0][12]).toBe('20250101');
    expect(rows[0][13]).toBe('4');
    expect(rows[0][14]).toBe('20250101');
    expect(rows[0][15]).toBe('20250131');
    expect(rows[0][16]).toBe('Testlauf Januar');
    expect(rows[0][21]).toBe('EUR');
    expect(rows[0][26]).toBe('03');
    expect(rows[1]).toEqual(EXTF_HEADINGS);
    const data = rows.slice(2);
    expect(data).toHaveLength(4); // Einlage, Bürobedarf, Einmalig, Per API
    for (const r of data) {
      expect(r).toHaveLength(EXTF_FIELDS);
      // Every amount: decimal comma, no thousands separator, positive.
      expect(r[0]).toMatch(/^\d+,\d{2}$/);
      expect(r[2]).toBe('EUR');
    }
    // Office supplies (3 Jan): Konto 1200 credited (H), Gegenkonto 4930 carries BU 9 (Vorsteuer 19 %, no automatic), gross amount, Belegfeld 1.
    const office = data.find((r) => r[7] === '4930')!;
    expect(office.slice(0, 11)).toEqual(['119,00', 'H', 'EUR', '', '', '', '1200', '4930', '9', '0301', 'RE-77']);
    // Revenue on the Automatikkonto 8400: no BU key (the account books the 19 % itself).
    const api8400 = data.find((r) => r[7] === '8400')!;
    expect(api8400.slice(0, 10)).toEqual(['119,00', 'S', 'EUR', '', '', '', '1200', '8400', '', '0501']);
    // 8200 is no Automatikkonto, tax-free: no key either; plain transfers have none.
    expect(data.find((r) => r[7] === '8200')![8]).toBe('');
    expect(data.find((r) => r[7] === '1890' || r[6] === '1890')![8]).toBe('');
    // The columns the export does not fill stay empty (Festschreibung 0).
    expect(office[113]).toBe('0');
    expect(office[3]).toBe('');
  });

  it('exports sales with the invoice number as Belegfeld 1 and payments without tax', async () => {
    const res = await t.api.raw(`/api/accounting/datev/export?from=2025-06-01&to=2025-06-30`, { headers: { cookie: t.api.cookie, 'x-location-id': loc, 'x-pghl': '1' } });
    const data = parseExtf(decodeCp1252(Buffer.from(await res.arrayBuffer()))).slice(2);
    const sale = data.find((r) => r[7] === '8400')!;
    expect(sale.slice(0, 2)).toEqual(['1190,00', 'S']);
    expect(sale[6]).toBe('1400');
    expect(sale[8]).toBe('');
    expect(sale[10]).toMatch(/^RE-\d+$/);
    expect(sale[9]).toBe('1006');
    expect(sale[13]).toContain('RE-');
    const pay = data.find((r) => r[6] === '1200' && r[7] === '1400')!;
    expect(pay[1]).toBe('S');
    expect(pay[8]).toBe('');
    expect(pay[9]).toBe('2006');
  });

  it('asks for adviser and client number, and for a period with entries', async () => {
    const t3 = await startTestApp();
    await t3.setup();
    await t3.api.post('/api/accounting/setup', { standard: 'skr04' });
    const raw = (path: string) => t3.api.raw(path, { headers: { cookie: t3.api.cookie, 'x-location-id': t3.api.location, 'x-pghl': '1' } });
    expect((await raw('/api/accounting/datev/export?from=2025-01-01&to=2025-12-31')).status).toBe(400);
    await t3.api.put('/api/accounting/settings', { datev: { berater: '1001', mandant: '1' } });
    const empty = await raw('/api/accounting/datev/export?from=2025-01-01&to=2025-12-31');
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as any).error).toMatch(/keine Buchungen/);
    expect((await t3.api.put('/api/accounting/settings', { datev: { berater: 'abc' } })).status).toBe(400);
    await t3.close();
  });

  it('encodes Windows-1252 (ä ö ü ß € – „“) and replaces what the code page lacks', () => {
    const s = 'Müller & Söhne – Café „Größe“ 12 €';
    const buf = encodeCp1252(s);
    expect(decodeCp1252(buf)).toBe(s);
    expect([...encodeCp1252('äöüß€–')]).toEqual([0xe4, 0xf6, 0xfc, 0xdf, 0x80, 0x96]);
    expect(decodeCp1252(encodeCp1252('Emoji 🙂 und 日本'))).toBe('Emoji ? und ??');
  });

  it('builds the text of a small stack by hand: quoted text, doubled quotes, Belegfeld cleaned, 60 characters of text', () => {
    const chart = chartOf('skr03');
    const m = DEFAULT_MAPPING.skr03;
    const p = normalizePosting({ debit: '4930', credit: m.payable, amount_cents: 11900, tax_code: 'vst19', text: 'Papier "A4" ' + 'x'.repeat(80) }, chart, m);
    const entry: any = { id: 'e', number: 'B-000001', date: '2025-03-04', doc_date: '2025-03-04', due_date: '2025-04-03', text: 'Test', doc_ref: 'ER 2025/1_ä', postings: [p] };
    const { text, rows } = buildExtf({ entries: [entry], chart, standard: 'skr03', berater: '1001', mandant: '1', accountLength: 4, fyStart: '2025-01-01', from: '2025-03-01', to: '2025-03-31', name: '', now: new Date('2025-03-31T12:00:00.123Z') });
    expect(rows).toBe(1);
    const parsed = parseExtf(text);
    expect(parsed[0][5]).toBe('20250331120000123');
    expect(parsed[0][16]).toBe('Export 20250301-20250331');
    const row = parsed[2];
    expect(row[10]).toBe('ER-2025/1');
    expect(row[13]).toHaveLength(60);
    expect(row[13].startsWith('Papier "A4"')).toBe(true);
    expect(row[116]).toBe('03042025');
    expect(text).toContain('"Papier ""A4"" x');
    // Sachkontenlänge 6 pads the account numbers.
    const six = buildExtf({ entries: [entry], chart, standard: 'skr03', berater: '1001', mandant: '1', accountLength: 6, fyStart: '2025-01-01', from: '2025-03-01', to: '2025-03-31', name: '' });
    expect(parseExtf(six.text)[2].slice(6, 8)).toEqual(['160000', '493000']);
  });

  it('writes a ZIP of documents readable by any unzip tool (stored entries, CRC-32)', async () => {
    const { buildZip } = await import('../server/services/acc-datev.js');
    const zip = buildZip([{ name: 'index.csv', data: Buffer.from('a;b\r\n') }, { name: 'Ü-Beleg.pdf', data: Buffer.from('%PDF-1.4 test') }]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['index.csv', 'Ü-Beleg.pdf']);
    expect(files.get('Ü-Beleg.pdf')!.toString()).toBe('%PDF-1.4 test');
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });
});
