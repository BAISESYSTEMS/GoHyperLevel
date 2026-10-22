import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateEInvoice } from '../server/services/einvoice-validate.js';
import { startTestApp } from './helpers.js';

vi.setConfig({ hookTimeout: 60_000 });

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
let agency = '';
let locKey = '';

const rpc = async (key: string, name: string, args: Record<string, unknown>) => {
  const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await r.json()).result;
};
const ok = async (name: string, args: Record<string, unknown>, key = agency) => {
  const r = await rpc(key, name, args);
  expect(r.isError, `${name}: ${r.content?.[0]?.text}`).toBe(false);
  return r.structuredContent ?? JSON.parse(r.content[0].text);
};
const item = (price = 10000, over: Record<string, unknown> = {}) => ({ name: 'Beratung', qty: 1, price_cents: price, tax_rate: 19, ...over });
const draft = async (items: any[] = [item()]) => (await t.api.post('/api/invoices', { contact_id: contactId, items })).data;

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { email: 'kunde@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  expect((await t.api.put('/api/invoice-settings', { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', contact_name: 'Erika', contact_phone: '+4930123456', contact_email: 'r@muster.example', iban: 'DE02120300000000202051' })).status).toBe(200);
  agency = (await t.api.post('/api/agency/api-keys', { name: 'Rechnungen' })).data.key;
  locKey = (await t.api.post('/api/api-keys', { name: 'Sub-Account' })).data.key;
});
afterAll(async () => t.close());

describe('invoice MCP tools', () => {
  it('are listed with their safety hints', async () => {
    const r = await fetch(`${t.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agency}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const tools: any[] = (await r.json()).result.tools;
    const by = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const n of ['ghl_invoice_finalise', 'ghl_invoice_cancel', 'ghl_invoice_credit_note', 'ghl_invoice_record_payment', 'ghl_invoice_xrechnung', 'ghl_quote_to_invoice', 'ghl_list_invoices', 'ghl_link_invoice']) expect(by[n], n).toBeTruthy();
    expect(by.ghl_invoice_cancel.annotations.destructiveHint).toBe(true);
    expect(by.ghl_invoice_xrechnung.annotations.readOnlyHint).toBe(false);
  });

  it('finalise → payment → xrechnung → cancel, with the same rules as the app', async () => {
    const d = await draft();
    const fin = await ok('ghl_invoice_finalise', { location_id: loc, invoice_id: d.id });
    expect(fin).toMatchObject({ number: 'RE-1001', locked: true, status: 'sent' });
    // already final: the tool relays the 409
    const again = await rpc(agency, 'ghl_invoice_finalise', { location_id: loc, invoice_id: d.id });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toMatch(/schon festgeschrieben/);
    // frozen: an edit through the API is refused
    expect((await t.api.patch(`/api/invoices/${d.id}`, { items: [item(1)] })).status).toBe(409);
    const part = await ok('ghl_invoice_record_payment', { location_id: loc, invoice_id: d.id, amount_cents: 5000, method: 'Überweisung' });
    expect(part).toMatchObject({ paid: false, state: 'partially_paid', open_cents: 6900 });
    const x = await ok('ghl_invoice_xrechnung', { location_id: loc, invoice_id: d.id, syntax: 'ubl' });
    expect(x).toMatchObject({ syntax: 'ubl', filename: 'Rechnung-RE-1001-xrechnung-ubl.xml' });
    expect(x.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(x.validation).toMatchObject({ valid: true, errors: [] });
    expect(validateEInvoice(x.xml).valid).toBe(true);
    const cancel = await ok('ghl_invoice_cancel', { location_id: loc, invoice_id: d.id, reason: 'Auftrag zurückgezogen' });
    expect(cancel.storno).toMatchObject({ number: 'ST-1001', credit_type: 'storno', total_cents: -11900, ref_id: d.id });
    expect(cancel.original).toMatchObject({ status: 'void', state: 'cancelled' });
    const refused = await rpc(agency, 'ghl_invoice_cancel', { location_id: loc, invoice_id: d.id });
    expect(refused.isError).toBe(true);
  });

  it('credit note as draft or finalised, quote to invoice', async () => {
    const d = await draft([item(20000)]);
    await ok('ghl_invoice_finalise', { location_id: loc, invoice_id: d.id });
    const cn = await ok('ghl_invoice_credit_note', { location_id: loc, invoice_id: d.id, items: [{ name: 'Nachlass', qty: 1, price_cents: 5000, tax_rate: 19 }], reason: 'Kulanz' });
    expect(cn).toMatchObject({ kind: 'credit_note', status: 'draft', total_cents: -5950, number: '' });
    const done = await ok('ghl_invoice_credit_note', { location_id: loc, invoice_id: d.id, items: [{ name: 'Nachlass 2', qty: 1, price_cents: 1000, tax_rate: 19 }], finalise: true });
    expect(done).toMatchObject({ kind: 'credit_note', status: 'sent', locked: true, total_cents: -1190 });
    expect(done.number).toMatch(/^GS-/);
    // with a credit note there is no Storno any more; the rest is credited (the draft above does not count)
    const refused = await rpc(agency, 'ghl_invoice_cancel', { location_id: loc, invoice_id: d.id });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Restbetrag gutschreiben/);
    const rest = await ok('ghl_invoice_credit_note', { location_id: loc, invoice_id: d.id, remainder: true, finalise: true });
    expect(rest).toMatchObject({ kind: 'credit_note', status: 'sent', total_cents: -(23800 - 1190) });
    expect((await t.api.get(`/api/invoices/${d.id}`)).data).toMatchObject({ state: 'credited', open_cents: 0 });
    const est =(await t.api.post('/api/invoices', { kind: 'estimate', contact_id: contactId, items: [item(30000)] })).data;
    await t.api.patch(`/api/invoices/${est.id}`, { status: 'sent' });
    const conv = await ok('ghl_quote_to_invoice', { location_id: loc, quote_id: est.id, inv_type: 'partial' });
    expect(conv).toMatchObject({ kind: 'invoice', status: 'draft', inv_type: 'partial', ref_id: est.id, number: '' });
  });

  it('a key of one sub-account cannot touch another one, and tools show up in the invoice list', async () => {
    const other = (await t.api.post('/api/locations', { name: 'Fremde Firma' })).data.id;
    const d = await draft();
    const r = await rpc(locKey, 'ghl_invoice_finalise', { location_id: other, invoice_id: d.id });
    expect(r.isError).toBe(true);
    const own = await rpc(locKey, 'ghl_invoice_finalise', { location_id: loc, invoice_id: d.id });
    expect(own.isError).toBe(false);
    const list = await ok('ghl_list_invoices', {}, locKey);
    expect(list.find((i: any) => i.id === d.id)).toMatchObject({ locked: true, state: 'open' });
    const agencyList = await ok('ghl_list_invoices', {});
    expect(agencyList.find((i: any) => i.id === d.id)).toMatchObject({ finalised_at: expect.any(String), paid_cents: 0 });
  });
});
