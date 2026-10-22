import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../server/core/db.js';
import { actionFor, StateError, docState, openCents, formatNumber, rangeCfg, cleanRange, checkCompliance, TAX_MODES } from '../server/services/invoice-model.js';
import { finaliseInvoice } from '../server/services/invoice-flow.js';
import { createInvoice } from '../server/modules/payments.js';
import { verifyChain } from '../server/services/acc-ledger.js';
import { openItems } from '../server/services/acc-reports.js';
import { startTestApp } from './helpers.js';

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
const events: { type: string; data: any }[] = [];

const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };
const item = (price = 10000, over: Record<string, unknown> = {}) => ({ name: 'Beratung', qty: 1, price_cents: price, tax_rate: 19, ...over });
const draft = async (items: any[] = [item()], extra: Record<string, unknown> = {}) => (await t.api.post('/api/invoices', { contact_id: contactId, items, ...extra })).data;
const finalise = async (id: string, body: Record<string, unknown> = {}) => t.api.post(`/api/invoices/${id}/finalise`, body);
const issued = async (items: any[] = [item()], extra: Record<string, unknown> = {}) => {
  const d = await draft(items, extra);
  const r = await finalise(d.id);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const get = async (id: string) => (await t.api.get(`/api/invoices/${id}`)).data;
const sql = <T = any>(q: string, ...p: any[]) => t.app.db.get<T>(q, ...p);

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  const r = await t.api.put('/api/invoice-settings', SELLER);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  for (const type of ['invoice.paid', 'invoice.finalised', 'invoice.cancelled', 'invoice.partially_paid']) t.app.events.on(type, (e) => void events.push({ type, data: e.data }));
});
afterAll(async () => t.close());

describe('the state machine (pure)', () => {
  const inv = (over: Record<string, unknown> = {}) => ({ kind: 'invoice', status: 'draft', finalised_at: null, total_cents: 11900, paid_cents: 0, ...over });

  it('draft → finalised → partly paid → paid; cancelled only through Storno; nothing goes back to draft', () => {
    expect(actionFor(inv(), 'sent')).toBe('finalise');
    expect(actionFor(inv(), 'paid')).toBe('finalise_and_pay');
    expect(actionFor(inv(), 'void')).toBe('discard');
    expect(actionFor(inv({ status: 'sent', finalised_at: 'x' }), 'paid')).toBe('pay');
    expect(actionFor(inv({ status: 'sent', finalised_at: 'x' }), 'void')).toBe('storno');
    expect(actionFor(inv({ status: 'paid', finalised_at: 'x' }), 'void')).toBe('storno');
    expect(actionFor(inv({ status: 'sent', finalised_at: 'x' }), 'sent')).toBe('none');
    for (const from of ['sent', 'paid']) expect(() => actionFor(inv({ status: from, finalised_at: 'x' }), 'draft')).toThrow(StateError);
    expect(() => actionFor(inv({ status: 'paid', finalised_at: 'x' }), 'sent')).toThrow(/bezahlte/);
    expect(() => actionFor(inv({ status: 'void', finalised_at: 'x' }), 'sent')).toThrow(/storniert/);
    expect(() => actionFor(inv({ status: 'void', finalised_at: 'x' }), 'paid')).toThrow(StateError);
    expect(() => actionFor(inv({ status: 'sent', finalised_at: 'x' }), 'accepted')).toThrow(/Angebote/);
    expect(() => actionFor(inv(), 'banane')).toThrow(/Unbekannt/);
    // quotes: no tax document
    expect(actionFor(inv({ kind: 'estimate' }), 'sent')).toBe('send');
    expect(actionFor(inv({ kind: 'estimate', status: 'sent' }), 'accepted')).toBe('accept');
    expect(() => actionFor(inv({ kind: 'estimate', status: 'sent' }), 'draft')).toThrow(StateError);
    expect(new StateError('x').status).toBe(409);
  });

  it('shows partly paid and the open amount', () => {
    expect(docState(inv({ status: 'sent', finalised_at: 'x' }) as any)).toBe('open');
    expect(docState(inv({ status: 'sent', finalised_at: 'x', paid_cents: 5000 }) as any)).toBe('partially_paid');
    expect(docState(inv({ status: 'paid', finalised_at: 'x', paid_cents: 11900 }) as any)).toBe('paid');
    expect(docState(inv({ status: 'void', finalised_at: 'x' }) as any)).toBe('cancelled');
    expect(docState(inv({ status: 'void' }) as any)).toBe('discarded');
    expect(openCents({ total_cents: 11900, paid_cents: 2000, credited_cents: 1900, deducted_cents: 1000 })).toBe(7000);
    expect(openCents({ total_cents: 11900, paid_cents: 20000 })).toBe(0);
    expect(openCents({ total_cents: -11900, kind: 'credit_note' })).toBe(0);
  });

  it('formats numbers by range: prefix, year, padding', () => {
    expect(formatNumber(rangeCfg({}, 'invoice'), 1001, '2026')).toBe('RE-1001');
    expect(formatNumber(rangeCfg({ prefix: 'R', next: 5 }, 'invoice'), 5, '2026')).toBe('R5');
    const c = cleanRange({ prefix: 'RE-', with_year: true, year_reset: true, digits: 4, start: 1 }, rangeCfg({}, 'invoice'));
    expect(formatNumber(c, 7, '2026')).toBe('RE-2026-0007');
    expect(() => cleanRange({ year_reset: true }, rangeCfg({}, 'invoice'))).toThrow(/Jahreszahl/);
    expect(() => cleanRange({ prefix: 'a b' }, rangeCfg({}, 'invoice'))).toThrow(/Präfix/);
    expect(() => cleanRange({ digits: 99 }, rangeCfg({}, 'invoice'))).toThrow(/Stellen/);
    expect(rangeCfg({}, 'storno').prefix).toBe('ST-');
    expect(rangeCfg({ next_estimate: 77 }, 'estimate')).toMatchObject({ prefix: 'AN-', start: 77 });
  });

  it('checks the legal content before finalising', () => {
    const base = { kind: 'invoice', tax_mode: 'standard' as const, tax_note: '', items: [{ name: 'A', qty: 1, price_cents: 100000, tax_rate: 19 }], total_cents: 119000, seller: { name: 'S', address: 'Str 1', postal_code: '1', city: 'B', vat_id: 'DE811569869' }, buyer: { name: 'K', address: 'Weg 2', postal_code: '2', city: 'M' } };
    expect(checkCompliance(base)).toEqual({ errors: [], warnings: [] });
    const rc = checkCompliance({ ...base, tax_mode: 'reverse_charge', items: [{ name: 'A', qty: 1, price_cents: 1000, tax_rate: 19 }] });
    expect(rc.errors.join(' ')).toMatch(/0 %/);
    expect(rc.errors.join(' ')).toMatch(/Hinweistext/);
    expect(rc.errors.join(' ')).toMatch(/USt-IdNr\. des Kunden/);
    expect(checkCompliance({ ...base, seller: { ...base.seller, vat_id: '', tax_number: '' } }).warnings.join(' ')).toMatch(/Steuernummer oder USt-IdNr/);
    expect(checkCompliance({ ...base, buyer: { name: '', address: '', postal_code: '', city: '' } }).warnings.join(' ')).toMatch(/Empfänger/);
    // a small invoice needs no recipient address (§ 33 UStDV)
    expect(checkCompliance({ ...base, total_cents: 20000, buyer: { name: '', address: '', postal_code: '', city: '' } }).warnings).toEqual([]);
    expect(checkCompliance({ ...base, tax_mode: 'tax_free', tax_note: TAX_MODES.tax_free.note, items: [{ name: 'A', qty: 1, price_cents: 1000, tax_rate: 0 }] }).errors.join(' ')).toMatch(/Platzhalter/);
    expect(checkCompliance({ ...base, supply_from: '2026-02-01', supply_to: '2026-01-01' }).errors.join(' ')).toMatch(/Leistungszeitraum/);
  });
});

describe('finalising: number, freeze, snapshot', () => {
  it('a draft has no number and may be deleted; finalising gives the first number of the range', async () => {
    const d = await draft();
    expect(d).toMatchObject({ number: '', status: 'draft', locked: false, state: 'draft', is_draft: true });
    const gone = await draft();
    expect((await t.api.del(`/api/invoices/${gone.id}`)).status).toBe(200);
    const r = await finalise(d.id);
    expect(r.data).toMatchObject({ number: 'RE-1001', status: 'sent', locked: true, state: 'open', state_label: 'Festgeschrieben, offen' });
    expect(r.data.doc_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.data.finalised_at).toBeTruthy();
    expect(r.data.snapshot).toBeUndefined();
    // the public page now shows it, the audit trail knows it
    expect(await (await t.api.raw(`/i/${d.public_token}`)).text()).toContain('RE-1001');
    const trail = (await t.api.get(`/api/invoices/${d.id}/audit`)).data.map((a: any) => a.action);
    expect(trail).toEqual(['invoice.created', 'invoice.finalised']);
    expect(events.find((e) => e.type === 'invoice.finalised' && e.data.invoice.id === d.id)).toBeTruthy();
    // finalising twice is refused
    expect((await finalise(d.id)).status).toBe(409);
  });

  it('numbers stay gap-free: deleted drafts, failed attempts and parallel requests leave no hole', async () => {
    const ds = [];
    for (let i = 0; i < 4; i++) ds.push(await draft([item(1000 + i)]));
    await t.api.del(`/api/invoices/${ds[1].id}`); // deleting a draft frees nothing and costs nothing
    // an attempt that fails (reverse charge without VAT IDs) must not use a number
    const bad = await draft([item(5000, { tax_rate: 0 })], { tax_mode: 'reverse_charge' });
    const refused = await finalise(bad.id);
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/USt-IdNr/);
    // finalise the rest in parallel
    const rs = await Promise.all([ds[0], ds[2], ds[3]].map((d) => finalise(d.id)));
    const nums = rs.map((r) => Number(String(r.data.number).replace('RE-', ''))).sort();
    expect(nums).toEqual([1002, 1003, 1004]);
    // …and a document made out of the failed attempt after fixing it gets the next number, not a later one
    await t.api.patch(`/api/invoices/${bad.id}`, { buyer_vat_id: 'FR12345678901' });
    expect((await finalise(bad.id)).data.number).toBe('RE-1005');
    const all = t.app.db.all<{ number: string }>(`SELECT number FROM invoices WHERE location_id = ? AND kind = 'invoice' AND finalised_at IS NOT NULL`, loc).map((r) => Number(r.number.replace('RE-', ''))).sort();
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => 1001 + i));
  });

  it('the counter is one atomic statement – two connections never get the same number', () => {
    const other = new Db(t.app.config.dbFile);
    try {
      const q = `INSERT INTO invoice_counters (location_id, range, period, last) VALUES (?, ?, ?, ?) ON CONFLICT(location_id, range, period) DO UPDATE SET last = last + 1 RETURNING last`;
      const seen = new Set<number>();
      for (let i = 0; i < 60; i++) {
        const db = i % 2 ? other : t.app.db;
        seen.add(db.get<{ last: number }>(q, loc, 'storno-test', '', 1)!.last);
      }
      expect(seen.size).toBe(60);
      expect(Math.min(...seen)).toBe(1);
      expect(Math.max(...seen)).toBe(60);
    } finally {
      other.close();
    }
  });

  it('freezes items, amounts and customer (409) – note, due date and payment link stay editable', async () => {
    const inv = await issued([item(20000)], { title: 'Projekt' });
    const base = await get(inv.id);
    for (const body of [{ items: [item(30000)] }, { title: 'Anderer Titel' }, { tax_mode: 'small_business' }, { contact_id: null }, { buyer_vat_id: 'FR12345678901' }, { supply_from: '2020-01-01' }, { skonto: { percent: 2, days: 10 } }, { issued_at: '2020-01-01T00:00:00Z' }]) {
      const r = await t.api.patch(`/api/invoices/${inv.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.data).toMatchObject({ locked: true });
      expect(r.data.error).toMatch(/Storniere|festgeschrieben/i);
    }
    // saving the same content again is no change
    expect((await t.api.patch(`/api/invoices/${inv.id}`, { items: base.items, title: 'Projekt', contact_id: contactId })).status).toBe(200);
    const ok = await t.api.patch(`/api/invoices/${inv.id}`, { notes: 'Danke!', due_at: '2030-01-15T00:00:00Z', payment_link: 'https://pay.example/x' });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ notes: 'Danke!', payment_link: 'https://pay.example/x' });
    const after = await get(inv.id);
    expect(after.total_cents).toBe(base.total_cents);
    expect(after.doc_hash).toBe(base.doc_hash);
    // the changes are in the trail
    const trail = (await t.api.get(`/api/invoices/${inv.id}/audit`)).data;
    expect(trail.filter((a: any) => a.action === 'invoice.amended').map((a: any) => a.detail).join(' ')).toMatch(/Hinweistext.*Fälligkeit|Fälligkeit.*Hinweistext/s);
    // nothing back to draft, no delete, no void by status
    expect((await t.api.patch(`/api/invoices/${inv.id}`, { status: 'draft' })).status).toBe(409);
    expect((await t.api.del(`/api/invoices/${inv.id}`)).status).toBe(409);
  });

  it('the database enforces it, even for code that bypasses the routes', async () => {
    const inv = await issued([item(7000)]);
    const raw = (q: string, ...p: any[]) => () => t.app.db.run(q, ...p);
    expect(raw('UPDATE invoices SET items = ? WHERE id = ?', '[]', inv.id)).toThrow(/Festgeschrieben/);
    expect(raw('UPDATE invoices SET total_cents = 1 WHERE id = ?', inv.id)).toThrow(/Festgeschrieben/);
    expect(raw('UPDATE invoices SET number = ? WHERE id = ?', 'RE-9999', inv.id)).toThrow(/Festgeschrieben/);
    expect(raw('UPDATE invoices SET doc_hash = ? WHERE id = ?', 'x', inv.id)).toThrow(/Prüfsumme/);
    expect(raw(`UPDATE invoices SET status = 'draft' WHERE id = ?`, inv.id)).toThrow(/Entwurf/);
    expect(raw('DELETE FROM invoices WHERE id = ?', inv.id)).toThrow(/gelöscht/);
    expect(raw('UPDATE invoice_audit SET detail = ? WHERE invoice_id = ?', 'x', inv.id)).toThrow(/unveränderlich/);
    expect(raw('DELETE FROM invoice_audit WHERE invoice_id = ?', inv.id)).toThrow(/unveränderlich/);
    // what stays open is open
    expect(raw('UPDATE invoices SET notes = ?, due_at = ? WHERE id = ?', 'ok', '2030-01-01T00:00:00Z', inv.id)).not.toThrow();
    // an erased contact only loses the link
    t.app.db.run('UPDATE invoices SET contact_id = NULL WHERE id = ?', inv.id);
    expect((await get(inv.id)).locked).toBe(true);
    expect(raw('UPDATE invoices SET contact_id = ? WHERE id = ?', contactId, inv.id)).toThrow(/Kunde/); // a link is never added afterwards
  });

  it('verifies the SHA-256 and notices tampering', async () => {
    const inv = await issued([item(12345)]);
    const ok = (await t.api.get(`/api/invoices/${inv.id}/verify`)).data;
    expect(ok).toMatchObject({ ok: true, final: true, hash: inv.doc_hash });
    expect(ok.checks.every((c: any) => c.ok)).toBe(true);
    // someone with database access drops the trigger and edits an amount
    t.app.db.raw.exec('DROP TRIGGER invoices_frozen');
    t.app.db.run('UPDATE invoices SET total_cents = total_cents + 1, subtotal_cents = subtotal_cents + 1 WHERE id = ?', inv.id);
    const bad = (await t.api.get(`/api/invoices/${inv.id}/verify`)).data;
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c: any) => c.name === 'Beträge').ok).toBe(false);
    t.app.db.run('UPDATE invoices SET total_cents = total_cents - 1, subtotal_cents = subtotal_cents - 1 WHERE id = ?', inv.id);
    expect((await t.api.get(`/api/invoices/${inv.id}/verify`)).data.ok).toBe(true);
    // put the trigger back for the other tests
    const frozen = (await import('../server/services/invoice-model.js')).FROZEN_COLUMNS.filter((c) => c !== 'snapshot' && c !== 'doc_hash');
    t.app.db.raw.exec(`CREATE TRIGGER invoices_frozen BEFORE UPDATE OF ${frozen.join(', ')} ON invoices WHEN OLD.finalised_at IS NOT NULL AND (${frozen.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}) BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnung: der Inhalt kann nicht mehr geändert werden'); END;`);
  });

  it('keeps the invoice date of a draft chosen on purpose, and moves an automatic one to the day of finalising', async () => {
    const chosen = await draft([item()], { issued_at: '2025-03-04T10:00:00Z' });
    expect((await finalise(chosen.id)).data.issued_at).toBe('2025-03-04T10:00:00.000Z');
    const auto = await draft();
    t.app.db.run(`UPDATE invoices SET issued_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, auto.id);
    const r = await finalise(auto.id);
    expect(r.data.issued_at.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });

  it('defaults the supply date to the invoice date and keeps a period', async () => {
    const a = await issued();
    // the invoice date as a calendar day of the sub-account (Berlin) – at 23:30 UTC that is already the next day
    expect((await get(a.id)).supply_from).toBe(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(a.issued_at)));
    const b = await issued([item()], { supply_from: '2026-01-01', supply_to: '2026-01-31' });
    expect(await (await t.api.raw(`/i/${b.public_token}`)).text()).toContain('01.01.2026 – 31.01.2026');
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], supply_from: '2026-02-01', supply_to: 'xx' })).status).toBe(400);
  });
});

describe('Storno and credit notes', () => {
  it('cancels by a Stornorechnung with negative amounts and a reference – the original becomes cancelled', async () => {
    const inv = await issued([item(10000), item(5000, { tax_rate: 7, name: 'Buch' })], { title: 'Falsch' });
    const r = await t.api.post(`/api/invoices/${inv.id}/storno`, { reason: 'Falscher Kunde' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const { storno, original } = r.data;
    expect(storno).toMatchObject({ kind: 'credit_note', credit_type: 'storno', number: 'ST-1001', ref_id: inv.id, status: 'sent', locked: true, doc_title: 'Stornorechnung' });
    expect(storno.total_cents).toBe(-inv.total_cents);
    expect(storno.tax_cents).toBe(-inv.tax_cents);
    expect(storno.subtotal_cents).toBe(-inv.subtotal_cents);
    expect(storno.items.map((i: any) => i.qty)).toEqual([-1, -1]);
    expect(storno.notes).toContain('Falscher Kunde');
    expect(original).toMatchObject({ status: 'void', state: 'cancelled', storno_id: storno.id });
    // the original stays as it was; the Storno knows its original; audit on both
    const detail = await get(inv.id);
    expect(detail.total_cents).toBe(inv.total_cents);
    expect(detail.credit_notes.map((c: any) => c.number)).toEqual(['ST-1001']);
    expect((await get(storno.id)).ref).toMatchObject({ id: inv.id, number: inv.number });
    expect((await t.api.get(`/api/invoices/${inv.id}/audit`)).data.map((a: any) => a.action)).toContain('invoice.cancelled');
    expect(events.find((e) => e.type === 'invoice.cancelled' && e.data.invoice.id === inv.id)).toBeTruthy();
    // no second Storno, no Storno of a Storno, no Storno of a draft, no change of the cancelled invoice
    expect((await t.api.post(`/api/invoices/${inv.id}/storno`, {})).status).toBe(409);
    expect((await t.api.post(`/api/invoices/${storno.id}/storno`, {})).status).toBe(409);
    expect((await t.api.post(`/api/invoices/${(await draft()).id}/storno`, {})).status).toBe(409);
    expect((await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' })).status).toBe(409);
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 100 })).status).toBe(409);
    // the Storno itself cannot change either
    expect((await t.api.patch(`/api/invoices/${storno.id}`, { items: [item()] })).status).toBe(409);
  });

  it('PATCH status void on a finalised invoice is a Storno (never a plain flip)', async () => {
    const inv = await issued([item(3000)]);
    const r = await t.api.patch(`/api/invoices/${inv.id}`, { status: 'void' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'void', state: 'cancelled' });
    expect(r.data.storno).toMatchObject({ kind: 'credit_note', credit_type: 'storno' });
    // a draft can still be discarded: no number was ever given out
    const d = await draft();
    expect((await t.api.patch(`/api/invoices/${d.id}`, { status: 'void' })).data).toMatchObject({ status: 'void', state: 'discarded', number: '' });
  });

  it('a partial credit note: draft with positive input, negative document, cap at the invoice amount', async () => {
    const inv = await issued([item(10000)], { title: 'Workshop' }); // 119,00
    const cn = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [item(2000, { name: 'Nachlass' })], reason: 'Kulanz' });
    expect(cn.status, JSON.stringify(cn.data)).toBe(200);
    expect(cn.data).toMatchObject({ kind: 'credit_note', credit_type: 'credit', status: 'draft', number: '', total_cents: -2380, ref_id: inv.id });
    expect(cn.data.items[0].qty).toBe(-1);
    const f = await finalise(cn.data.id);
    expect(f.data).toMatchObject({ number: 'GS-1001', total_cents: -2380, tax_cents: -380, subtotal_cents: -2000, status: 'sent', locked: true });
    const orig = await get(inv.id);
    expect(orig).toMatchObject({ credited_cents: 2380, open_cents: 11900 - 2380, status: 'sent' });
    // up to the rest (95,20 gross = 80,00 net) works, one more cent does not
    const rest = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [item(8001, { name: 'Rest' })] });
    expect(rest.status).toBe(409);
    expect(rest.data.error).toMatch(/übersteigen/);
    expect((await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'x', qty: 0, price_cents: 100, tax_rate: 19 }] })).status).toBe(400);
    expect((await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [{ name: 'x', qty: 1, price_cents: -100, tax_rate: 19 }] })).status).toBe(400);
    expect((await t.api.post(`/api/invoices/${(await draft()).id}/credit-note`, { items: [item()] })).status).toBe(409);
    // a credit note can be edited as a draft but not afterwards
    const cn2 = await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [item(1000)] });
    expect((await t.api.patch(`/api/invoices/${cn2.data.id}`, { items: [{ ...item(1500), qty: 1 }] })).status).toBe(200);
    expect((await t.api.patch(`/api/invoices/${cn2.data.id}`, { items: [{ ...item(1500), qty: -1 }] })).data.total_cents).toBe(-1785); // the stored (negative) form is accepted too
    expect((await finalise(cn2.data.id)).data.total_cents).toBe(-1785);
    expect((await t.api.patch(`/api/invoices/${cn2.data.id}`, { items: [item(1)] })).status).toBe(409);
  });

  it('ledger: the Storno cancels the booking, a credit note books the opposite direction on the invoice', async () => {
    expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
    const a = await issued([item(100000)], { issued_at: '2025-05-02T09:00:00Z' }); // 1.190,00
    const b = await issued([item(50000)], { issued_at: '2025-05-03T09:00:00Z' }); // 595,00
    await t.api.post('/api/accounting/autopost/run', {});
    const issue = (id: string) => sql(`SELECT * FROM acc_entries WHERE location_id = ? AND source_key = ?`, loc, `invoice:${id}:issue`);
    expect(issue(a.id)).toBeTruthy();
    const lines = (entryId: string) => t.app.db.all<any>('SELECT account, side, cents FROM acc_lines WHERE entry_id = ? ORDER BY line_no', entryId).map((l) => [l.account, l.side, l.cents]);
    // Storno of A: the issue entry is reversed (with the number of the Stornorechnung in the text)
    const s = (await t.api.post(`/api/invoices/${a.id}/storno`, { reason: 'Irrtum' })).data.storno;
    await t.api.post('/api/accounting/autopost/run', {});
    const orig = issue(a.id);
    expect(orig.reversed_by).toBeTruthy();
    const rev = sql<any>('SELECT * FROM acc_entries WHERE id = ?', orig.reversed_by);
    expect(rev.text).toContain(`Stornorechnung ${s.number}`);
    expect(rev.doc_ref).toBe(a.number);
    expect(lines(rev.id)).toEqual([['8400', 'S', 100000], ['1776', 'S', 19000], ['1400', 'H', 119000]]);
    // the Storno document itself is not booked a second time
    expect(sql(`SELECT 1 AS x FROM acc_entries WHERE source_key = ?`, `invoice:${s.id}:issue`)).toBeUndefined();
    // a credit note of B (100,00 net + 19 % = 119,00): the receivable of B shrinks, revenue and VAT are reduced
    const cn = (await t.api.post(`/api/invoices/${b.id}/credit-note`, { items: [item(10000)] })).data;
    const gs = (await finalise(cn.id)).data;
    await t.api.post('/api/accounting/autopost/run', {});
    const ce = issue(gs.id);
    expect(ce).toBeTruthy();
    expect(ce.doc_ref).toBe(b.number);
    expect(ce.text).toContain(`Gutschrift ${gs.number} zu Rechnung ${b.number}`);
    expect(lines(ce.id)).toEqual([['8400', 'S', 10000], ['1776', 'S', 1900], ['1400', 'H', 11900]]);
    const open = openItems(t.app, loc, 'receivable', '2099-12-31').items;
    expect(open.find((i) => i.doc_ref === a.number)).toBeUndefined();
    expect(open.find((i) => i.doc_ref === b.number)!.open_cents).toBe(59500 - 11900);
    expect(verifyChain(t.app, loc).ok).toBe(true);
  });
});

describe('quote → invoice', () => {
  it('converts a quote into a draft invoice that keeps the reference', async () => {
    const est = (await t.api.post('/api/invoices', { kind: 'estimate', contact_id: contactId, title: 'Angebot Relaunch', items: [item(40000)] })).data;
    expect(est.number).toBe('AN-1001');
    expect((await t.api.post(`/api/invoices/${est.id}/convert`, {})).status).toBe(409); // still a draft
    await t.api.patch(`/api/invoices/${est.id}`, { status: 'sent' });
    const c = await t.api.post(`/api/invoices/${est.id}/convert`, {});
    expect(c.status, JSON.stringify(c.data)).toBe(200);
    expect(c.data).toMatchObject({ kind: 'invoice', status: 'draft', number: '', ref_id: est.id, title: 'Angebot Relaunch', total_cents: 47600, contact_id: contactId });
    const q = await get(est.id);
    expect(q.converted.map((x: any) => x.id)).toEqual([c.data.id]);
    expect((await get(c.data.id)).ref).toMatchObject({ id: est.id, number: 'AN-1001', kind: 'estimate' });
    // the quote's content is fixed once an invoice came out of it
    expect((await t.api.patch(`/api/invoices/${est.id}`, { items: [item(1)] })).status).toBe(409);
    expect((await t.api.patch(`/api/invoices/${est.id}`, { notes: 'ok' })).status).toBe(200);
    // an invoice cannot be converted
    expect((await t.api.post(`/api/invoices/${c.data.id}/convert`, {})).status).toBe(409);
    const fin = await finalise(c.data.id);
    expect(fin.data.number).toMatch(/^RE-\d+$/);
  });
});

describe('payments', () => {
  it('records part payments, shows the state, and completes at zero – invoice.paid fires once', async () => {
    const inv = await issued([item(100000)]); // 1.190,00
    const before = events.filter((e) => e.type === 'invoice.paid').length;
    const p1 = await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 40000, method: 'Überweisung', paid_at: '2026-10-01T10:00:00Z' });
    expect(p1.status, JSON.stringify(p1.data)).toBe(200);
    expect(p1.data).toMatchObject({ paid: false, status: 'sent', state: 'partially_paid', paid_cents: 40000, open_cents: 79000 });
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 80000 })).status).toBe(400); // more than open
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 0 })).status).toBe(400);
    const p2 = await t.api.post(`/api/invoices/${inv.id}/payments`, {});
    expect(p2.data).toMatchObject({ paid: true, status: 'paid', state: 'paid', paid_cents: 119000, open_cents: 0 });
    expect(events.filter((e) => e.type === 'invoice.paid').length).toBe(before + 1);
    expect(events.some((e) => e.type === 'invoice.partially_paid' && e.data.invoice.id === inv.id)).toBe(true);
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 100 })).status).toBe(409);
    const rows = (await get(inv.id)).payments;
    expect(rows.map((r: any) => [r.kind, r.amount_cents])).toEqual([['payment', 40000], ['payment', 79000]]);
    // payments are immutable rows
    expect(() => t.app.db.run('UPDATE invoice_payments SET amount_cents = 1 WHERE invoice_id = ?', inv.id)).toThrow(/unveränderlich/);
    expect(() => t.app.db.run('DELETE FROM invoice_payments WHERE invoice_id = ?', inv.id)).toThrow(/unveränderlich/);
  });

  it('takes a payment back with a reversal row: the invoice is open again', async () => {
    const inv = await issued([item(20000)]);
    const p = (await t.api.post(`/api/invoices/${inv.id}/payments`, {})).data;
    expect(p.status).toBe('paid');
    const back = await t.api.post(`/api/invoices/${inv.id}/payments/${p.payment_id}/revert`, { reason: 'Rücklastschrift' });
    expect(back.status, JSON.stringify(back.data)).toBe(200);
    expect(back.data).toMatchObject({ status: 'sent', state: 'open', paid_cents: 0, open_cents: 23800 });
    expect((await t.api.post(`/api/invoices/${inv.id}/payments/${p.payment_id}/revert`, {})).status).toBe(409);
    const rows = (await get(inv.id)).payments;
    expect(rows.map((r: any) => [r.kind, r.amount_cents])).toEqual([['payment', 23800], ['reversal', -23800]]);
  });

  it('PATCH status paid and the old integrations (markInvoicePaid) go through the same path', async () => {
    const inv = await issued([item(5000)]);
    const r = await t.api.patch(`/api/invoices/${inv.id}`, { status: 'paid' });
    expect(r.data).toMatchObject({ status: 'paid', paid_cents: 5950 });
    expect(r.data.paid_at).toBeTruthy();
    // a draft paid directly is finalised first
    const d = await draft([item(1000)]);
    const p = await t.api.patch(`/api/invoices/${d.id}`, { status: 'paid' });
    expect(p.data).toMatchObject({ status: 'paid', locked: true });
    expect(p.data.number).toMatch(/^RE-/);
    // an invoice another module flipped to "sent" with raw SQL is numbered and frozen on first contact
    const raw = createInvoice(t.app, loc, { contact_id: contactId, items: [item(2000)] });
    t.app.db.run(`UPDATE invoices SET status = 'sent' WHERE id = ?`, raw.id);
    const seen = await get(raw.id);
    expect(seen).toMatchObject({ locked: true, status: 'sent' });
    expect(seen.number).toMatch(/^RE-\d+$/);
  });

  it('Skonto: a payment inside the period with the deduction settles the invoice', async () => {
    const inv = await issued([item(100000)], { skonto: { percent: 2, days: 14 } }); // 1.190,00, 2 % = 23,80
    expect(inv).toMatchObject({ skonto_percent: 2, skonto_days: 14 });
    expect((await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 110000, skonto: true })).status).toBe(400); // more than 2 % taken off
    const r = await t.api.post(`/api/invoices/${inv.id}/payments`, { amount_cents: 119000 - 2380, skonto: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: 'paid', paid: true, open_cents: 0 });
    const rows = (await get(inv.id)).payments;
    expect(rows.map((x: any) => [x.kind, x.amount_cents])).toEqual([['payment', 116620], ['skonto', 2380]]);
    const late = await issued([item(100000)], { skonto: { percent: 2, days: 14 }, issued_at: '2020-01-01T10:00:00Z' });
    expect((await t.api.post(`/api/invoices/${late.id}/payments`, { amount_cents: 116620, skonto: true })).data.error).toMatch(/abgelaufen/);
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], skonto: { percent: 99, days: 5 } })).status).toBe(400);
  });
});

describe('partial and final invoices', () => {
  it('the final invoice deducts the partial invoices: totals, deduction, what is still due', async () => {
    const a1 = await issued([item(30000, { name: 'Abschlag 1' })], { inv_type: 'partial' }); // 357,00
    const a2 = await issued([item(20000, { name: 'Abschlag 2' })], { inv_type: 'partial' }); // 238,00
    expect(a1.inv_type).toBe('partial');
    const f = await draft([item(100000, { name: 'Projekt komplett' })], { inv_type: 'final', deduct_ids: [a1.id, a2.id] });
    const preview = await get(f.id);
    expect(preview.deduction_candidates.map((c: any) => c.id).sort()).toEqual([a1.id, a2.id].sort());
    const r = await finalise(f.id);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ total_cents: 119000, deducted_cents: 59500, open_cents: 59500, inv_type: 'final' });
    const d = await get(f.id);
    expect(d.deductions.map((x: any) => [x.number, x.total_cents])).toEqual([[a1.number, 35700], [a2.number, 23800]]);
    // the same partial invoice cannot be deducted twice
    const g = await draft([item(1000)], { inv_type: 'final', deduct_ids: [a1.id] });
    const refused = await finalise(g.id);
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/schon in der Schlussrechnung/);
    // only partial invoices; the ledger books the remainder only
    const wrong = await draft([item(1000)], { inv_type: 'final', deduct_ids: [(await issued()).id] });
    expect((await finalise(wrong.id)).status).toBe(400);
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], deduct_ids: [a1.id] })).status).toBe(400);
  });
});

describe('tax treatment and fields', () => {
  it('reverse charge needs the note and both VAT IDs; the standard text is filled in; items go to 0 %', async () => {
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(10000)], tax_mode: 'reverse_charge', buyer_vat_id: 'FR 123 456 789 01' })).data;
    expect(d).toMatchObject({ tax_mode: 'reverse_charge', buyer_vat_id: 'FR12345678901', tax_cents: 0, total_cents: 10000 });
    expect(d.items[0].tax_rate).toBe(0);
    expect(d.tax_note).toBe(TAX_MODES.reverse_charge.note);
    const empty = await t.api.patch(`/api/invoices/${d.id}`, { tax_note: '' });
    expect(empty.status).toBe(200);
    const r = await finalise(d.id);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Hinweistext/);
    await t.api.patch(`/api/invoices/${d.id}`, { tax_note: TAX_MODES.reverse_charge.note });
    expect((await finalise(d.id)).status).toBe(200);
    // the page and the document carry the text
    expect(await (await t.api.raw(`/i/${d.public_token}`)).text()).toContain('Steuerschuldnerschaft des Leistungsempfängers');
  });

  it('small business: from the old setting; the page says § 19 and shows no tax', async () => {
    await t.api.put('/api/invoice-settings', { small_business: true });
    const d = (await t.api.post('/api/invoices', { contact_id: contactId, items: [{ name: 'Logo', qty: 1, price_cents: 30000 }] })).data;
    expect(d).toMatchObject({ tax_mode: 'small_business', tax_cents: 0, total_cents: 30000 });
    const r = await finalise(d.id);
    expect(r.status).toBe(200);
    const page = await (await t.api.raw(`/i/${d.public_token}`)).text();
    expect(page).toContain('§ 19 UStG');
    expect(page).not.toContain('>USt.<');
    await t.api.put('/api/invoice-settings', { small_business: false });
  });

  it('validates VAT ID, Leitweg-ID and the bank data of the settings', async () => {
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], buyer_vat_id: 'DE811569860' })).data.error).toMatch(/Prüfziffer/);
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], buyer_vat_id: 'XX123' })).status).toBe(400);
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], leitweg_id: '04011000-1234512345-35' })).status).toBe(200);
    expect((await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], leitweg_id: 'kein Leitweg' })).status).toBe(400);
    expect((await t.api.put('/api/invoice-settings', { iban: 'DE00 1234' })).status).toBe(400);
    expect((await t.api.put('/api/invoice-settings', { vat_id: 'DE123' })).status).toBe(400);
    expect((await t.api.put('/api/invoice-settings', { bic: '??' })).status).toBe(400);
    expect((await t.api.put('/api/invoice-settings', { contact_email: 'kein-mail' })).status).toBe(400);
    expect((await t.api.put('/api/invoice-settings', { default_tax_mode: 'quatsch' })).status).toBe(400);
    const s = (await t.api.get('/api/invoice-settings')).data;
    expect(s.settings).toMatchObject({ iban: 'DE02120300000000202051', vat_id: 'DE811569869' });
    expect(s.tax_modes.map((m: any) => m.key)).toContain('ig_supply');
  });

  it('VAT-ID check: format only without the setting, VIES with it (mocked); an unknown ID blocks reverse charge, an unreachable service only warns', async () => {
    const plain = (await t.api.post('/api/invoices/vat-check', { vat_id: 'de 811 569 869' })).data;
    expect(plain).toMatchObject({ format_ok: true, vat_id: 'DE811569869', country: 'DE', vies: null, vies_enabled: false });
    expect((await t.api.post('/api/invoices/vat-check', { vat_id: 'DE811569860' })).data).toMatchObject({ format_ok: false });
    await t.api.put('/api/invoice-settings', { vies_check: true });
    const calls: string[] = [];
    let answer: any = { isValid: true, name: 'FRANZÖSISCHE FIRMA SAS', address: '1 RUE DE PARIS' };
    let status = 200;
    t.app.services.viesFetch = async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
    };
    const ok = (await t.api.post('/api/invoices/vat-check', { vat_id: 'FR12345678901' })).data;
    expect(ok.vies).toMatchObject({ checked: true, valid: true, name: 'FRANZÖSISCHE FIRMA SAS' });
    expect(calls[0]).toBe('https://ec.europa.eu/taxation_customs/vies/rest-api/ms/FR/vat/12345678901');
    const mk = async () => (await t.api.post('/api/invoices', { contact_id: contactId, items: [item(10000)], tax_mode: 'reverse_charge', buyer_vat_id: 'FR12345678901' })).data;
    const good = await mk();
    const fin = await finalise(good.id);
    expect(fin.status, JSON.stringify(fin.data)).toBe(200);
    expect(sql<any>('SELECT snapshot FROM invoices WHERE id = ?', good.id).snapshot).toContain('FRANZÖSISCHE FIRMA SAS'); // the result is part of the frozen document
    answer = { isValid: false };
    const refused = await finalise((await mk()).id);
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/VIES/);
    // not reachable: a warning, the invoice is not blocked
    answer = { userError: 'MS_UNAVAILABLE' };
    status = 500;
    const warn = await finalise((await mk()).id);
    expect(warn.status).toBe(200);
    expect(warn.data.warnings.join(' ')).toMatch(/nicht über VIES geprüft/);
    // a standard invoice with an invalid ID only warns
    answer = { isValid: false };
    status = 200;
    const std = await finalise((await draft([item()], { buyer_vat_id: 'FR12345678901' })).id);
    expect(std.status).toBe(200);
    expect(std.data.warnings.join(' ')).toMatch(/VIES kennt/);
    delete t.app.services.viesFetch;
    await t.api.put('/api/invoice-settings', { vies_check: false });
  });
});

describe('number range settings', () => {
  it('shows the ranges, moves the next number forward only, and supports year and padding', async () => {
    const s = (await t.api.get('/api/invoice-settings')).data;
    expect(s.ranges.invoice).toMatchObject({ prefix: 'RE-', with_year: false });
    expect(s.ranges.invoice.last).toBeGreaterThan(1000);
    const last = s.ranges.invoice.last;
    // backwards is refused: numbers are never reused
    const back = await t.api.put('/api/invoice-settings', { ranges: { invoice: { next: last } } });
    expect(back.status).toBe(409);
    expect(back.data.error).toMatch(/schon vergeben/);
    // forward: the next invoice jumps
    expect((await t.api.put('/api/invoice-settings', { ranges: { invoice: { next: last + 10 } } })).status).toBe(200);
    expect((await issued()).number).toBe(`RE-${last + 10}`);
    // a new format with the year, restarting every year
    const set = await t.api.put('/api/invoice-settings', { ranges: { storno: { prefix: 'STORNO-', with_year: true, year_reset: true, digits: 4, start: 1 }, credit: { prefix: 'GU-' } } });
    expect(set.status, JSON.stringify(set.data)).toBe(200);
    const year = new Date().getFullYear();
    expect(set.data.ranges.storno).toMatchObject({ prefix: 'STORNO-', example: `STORNO-${year}-0001` });
    const inv = await issued();
    expect((await t.api.post(`/api/invoices/${inv.id}/storno`, {})).data.storno.number).toBe(`STORNO-${year}-0001`);
    const inv2 = await issued();
    expect((await t.api.post(`/api/invoices/${inv2.id}/storno`, {})).data.storno.number).toBe(`STORNO-${year}-0002`);
    expect((await t.api.put('/api/invoice-settings', { ranges: { invoice: { year_reset: true } } })).data.error).toMatch(/Jahreszahl/);
    expect((await t.api.put('/api/invoice-settings', { ranges: { invoice: { prefix: 'bad prefix!' } } })).status).toBe(400);
    // the settings page can be used with a restricted login only in the settings area
    const m = await t.api.post('/api/users', { email: 'buch@example.com', name: 'Buch', password: 'geheim-12345', role: 'member', locations: [loc], permissions: ['payments'] });
    expect(m.status).toBe(200);
  });

  it('drafts of a manually numbered invoice are refused – numbers come from the range', async () => {
    const r = await t.api.post('/api/invoices', { contact_id: contactId, items: [item()], number: 'MEINE-1' });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/fortlaufend/);
    // quotes may carry a typed number
    const est = await t.api.post('/api/invoices', { kind: 'estimate', items: [item()], number: 'ANGEBOT-X' });
    expect(est.data.number).toBe('ANGEBOT-X');
    expect((await t.api.post('/api/invoices', { kind: 'estimate', items: [item()], number: 'ANGEBOT-X' })).status).toBe(400);
  });
});

describe('finalising through the function (other modules)', () => {
  it('createInvoice + finaliseInvoice give a numbered, frozen invoice with the same rules', () => {
    const d = createInvoice(t.app, loc, { contact_id: contactId, items: [item(1000)] });
    expect(d.number).toBe('');
    const { invoice } = finaliseInvoice(t.app, loc, d.id);
    expect(invoice.number).toMatch(/^RE-\d+$/);
    expect(invoice.finalised_at).toBeTruthy();
    expect(() => finaliseInvoice(t.app, loc, d.id)).toThrow(/schon festgeschrieben/);
  });
});

describe('undo and the journal', () => {
  it('an undo entry of a draft edit cannot reopen the invoice after it was finalised', async () => {
    const d = await draft([item(5000)], { title: 'Vorher' });
    const edit = await t.api.patch(`/api/invoices/${d.id}`, { title: 'Nachher', items: [item(7000)] });
    const undoId = edit.headers.get('x-undo-id');
    expect(undoId, 'a draft edit is journaled').toBeTruthy();
    const fin = await finalise(d.id);
    expect(fin.status).toBe(200);
    const before = sql<any>('SELECT title, total_cents, doc_hash, number FROM invoices WHERE id = ?', d.id);
    const u = await t.api.post(`/api/undo/${undoId}`, { force: true });
    expect(u.status).toBeGreaterThanOrEqual(400);
    // nothing of the frozen invoice changed – no matter how the journal answered
    expect(sql<any>('SELECT title, total_cents, doc_hash, number FROM invoices WHERE id = ?', d.id)).toEqual(before);
    expect(before.title).toBe('Nachher');
  });
});

describe('the editor sends the whole document back', () => {
  it('a credit note draft accepts the neutral invoice-only fields but refuses a partial invoice type', async () => {
    const inv = await issued([item(20000)]);
    const cn = (await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [item(5000)], reason: 'Kulanz' })).data;
    expect(cn.kind).toBe('credit_note');
    const full = { items: [item(6000)], title: cn.title, notes: 'x', inv_type: 'standard', deduct_ids: [], skonto_percent: null, skonto_days: null, tax_mode: 'standard', supply_from: '', supply_to: '', buyer_vat_id: '', leitweg_id: '', buyer_ref: '' };
    const ok = await t.api.patch(`/api/invoices/${cn.id}`, full);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.total_cents).toBe(-7140);
    expect((await t.api.patch(`/api/invoices/${cn.id}`, { inv_type: 'partial' })).status).toBe(400);
  });
});
