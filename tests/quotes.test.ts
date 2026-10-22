import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireQuotes, getQuote } from '../server/services/quote-engine.js';
import { updateOpportunity } from '../server/services/opportunities.js';
import { markInvoicePaid } from '../server/modules/payments.js';
import { setStripeFetch } from '../server/services/stripe.js';
import { startTestApp } from './helpers.js';

/**
 * Deal line items and the quote builder end to end: positions → deal amount; a quote from a deal with options and optional positions;
 * sending; the customer's page; accepting with a signature (signed record, estimate, deposit invoice, deal follows, Stripe pay button);
 * declining, expiry, new versions, the final invoice after a deposit, and who may see which quote.
 */

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const checkouts: { amount: number; url: string; invoice: string }[] = [];
const stripe = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: 'Invalid API Key provided' } }, 401);
  if (u.pathname === '/v1/account') return json({ id: 'acct_1', settings: { dashboard: { display_name: 'Muster' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    let total = 0;
    for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) total += Number(params.get(`line_items[${i}][quantity]`)) * Number(params.get(`line_items[${i}][price_data][unit_amount]`));
    const id = `cs_test_${checkouts.length + 1}`;
    const s = { id, url: `https://checkout.stripe.com/c/pay/${id}`, payment_status: 'unpaid', status: 'open' };
    checkouts.push({ amount: total, url: s.url, invoice: String(params.get('client_reference_id')) });
    return json(s);
  }
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let pipe: any;
let contactId = '';
let n = 0;
const mails: any[] = [];
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };

const item = (name: string, price_cents: number, extra: Record<string, unknown> = {}) => ({ name, qty: 1, price_cents, tax_rate: 19, ...extra });
async function deal(extra: Record<string, unknown> = {}) {
  const c = extra.contact_id ?? contactId;
  const r = await t.api.post('/api/opportunities', { pipeline_id: pipe.id, contact_id: c, name: `Projekt ${++n}`, value: 0, ...extra });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}
const valueOf = (id: string) => (t.app.db.get('SELECT value FROM opportunities WHERE id = ?', id) as any).value as number;

/** A quote with two options, an optional position and (by default) a 30 % deposit; ready to send. */
async function quote(dealId: string, extra: Record<string, unknown> = {}) {
  const r = await t.api.post('/api/quotes', {
    deal_id: dealId,
    title: 'Plattform',
    items: [item('Einrichtung', 50000), item('Handbuch', 10000, { tax_rate: 7 }), item('Schulung', 20000, { optional: true, selected: false })],
    options: [
      { name: 'Basis', items: [item('Lizenz Basis', 100000)] },
      { name: 'Plus', recommended: true, description: 'Mit allen Extras', items: [item('Lizenz Plus', 180000)] },
    ],
    payment: { mode: 'deposit', type: 'percent', value: 30 },
    intro: 'Danke für das **Gespräch**.',
    terms: '- Zahlbar innerhalb von 14 Tagen',
    ...extra,
  });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}
const send = async (q: any, extra: Record<string, unknown> = {}) => {
  const r = await t.api.post(`/api/quotes/${q.id}/send`, extra);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
const token = (id: string) => (t.app.db.get('SELECT public_token FROM deal_quotes WHERE id = ?', id) as any).public_token as string;
const page = async (id: string) => t.api.raw(`/q/${token(id)}`).then(async (r) => ({ status: r.status, html: await r.text() }));
const pub = (id: string, path: string, body: unknown) => t.api.raw(`/api/public/quotes/${token(id)}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: (await r.json()) as any }));
const accept = (q: any, o: Record<string, unknown> = {}) => pub(q.id, 'accept', { option_id: q.doc.options[1].id, optional_ids: [], name: 'Erika Kundin', agree: true, signature: SIG, ...o });
const opt = (q: any, i: number) => q.doc.options[i].id as string;

beforeAll(async () => {
  setStripeFetch(stripe);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  pipe = (await t.api.post('/api/pipelines', { name: 'Vertrieb', stages: ['Neu', 'Angebot', 'Gewonnen'] })).data;
  contactId = (await t.api.post('/api/contacts', { email: 'kundin@kunde.example', first_name: 'Erika', last_name: 'Kundin', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München' })).data.id;
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
  t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
  await t.api.patch('/api/location', { settings: { email: { provider: 'capture' } } });
  expect((await t.api.put('/api/stripe', { secret_key: KEY })).status).toBe(200);
}, 60_000);
afterAll(async () => {
  setStripeFetch();
  await t.close();
});

describe('deal line items', () => {
  it('the deal amount is the net sum of the positions (whole units), with discount and catalogue products', async () => {
    const product = (await t.api.post('/api/products', { name: 'Wartungspaket', price_cents: 49900, tax_rate: 7 })).data;
    const d = await deal({ value: 5 });
    const r = await t.api.put(`/api/opportunities/${d.id}/lines`, {
      lines: [{ product_id: product.id, qty: 2 }, { name: 'Beratung', qty: 3, price_cents: 1999, discount_type: 'percent', discount_value: 10 }, { name: 'Anfahrt', qty: 1, price_cents: 3000, discount_type: 'amount', discount_value: 500, tax_rate: 0 }],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // 2 × 499,00 = 998,00 · 59,97 − 6,00 = 53,97 · 30,00 − 5,00 = 25,00 → 1.076,97 net → 1077
    expect(r.data.totals).toMatchObject({ list_cents: 99800 + 5997 + 3000, discount_cents: 600 + 500, net_cents: 99800 + 5397 + 2500 });
    expect(r.data.totals.tax_cents).toBe(6986 + 1025);
    expect(r.data).toMatchObject({ amount: 1077, locked: true, currency: 'EUR' });
    expect(r.data.lines.map((l: any) => [l.name, l.net_cents, l.product_id ?? null])).toEqual([['Wartungspaket', 99800, product.id], ['Beratung', 5397, null], ['Anfahrt', 2500, null]]);
    expect(valueOf(d.id)).toBe(1077);
    expect((await t.api.get(`/api/opportunities/${d.id}/lines`)).data.lines).toHaveLength(3);
    // the amount shows in the pipeline list
    expect((await t.api.get(`/api/opportunities?pipeline_id=${pipe.id}`)).data.find((x: any) => x.id === d.id).value).toBe(1077);
  });

  it('a deal with positions refuses a hand-set amount; other fields stay editable; a workflow cannot overwrite it', async () => {
    const d = await deal();
    await t.api.put(`/api/opportunities/${d.id}/lines`, { lines: [{ name: 'Paket', qty: 1, price_cents: 250000 }] });
    expect(valueOf(d.id)).toBe(2500);
    const refused = await t.api.patch(`/api/opportunities/${d.id}`, { value: 9999 });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toMatch(/Positionen/);
    expect((await t.api.patch(`/api/opportunities/${d.id}`, { value: 2500, name: 'Umbenannt' })).status).toBe(200);
    updateOpportunity(t.app, loc, d.id, { value: 1 });
    expect(valueOf(d.id)).toBe(2500);
    // without positions the amount is free again, and stays where it was
    await t.api.put(`/api/opportunities/${d.id}/lines`, { lines: [] });
    expect((await t.api.patch(`/api/opportunities/${d.id}`, { value: 3100 })).status).toBe(200);
    expect(valueOf(d.id)).toBe(3100);
    expect((await t.api.get(`/api/opportunities/${d.id}/lines`)).data).toMatchObject({ locked: false, lines: [], amount: 3100 });
  });

  it('refuses positions that cannot be calculated and deals that are not there', async () => {
    const d = await deal();
    for (const lines of [[{ name: '' }], [{ name: 'a', qty: 0 }], [{ name: 'a', discount_type: 'percent', discount_value: 150 }], [{ product_id: 'gibtsnicht' }], 'x']) {
      expect((await t.api.put(`/api/opportunities/${d.id}/lines`, { lines })).status).toBe(400);
    }
    expect((await t.api.put('/api/opportunities/gibtsnicht/lines', { lines: [] })).status).toBe(404);
    expect((await t.api.get('/api/opportunities/gibtsnicht/lines')).status).toBe(404);
    expect(valueOf(d.id)).toBe(0);
  });
});

describe('building a quote', () => {
  it('starts from the deal’s positions (or its amount), as a draft with a 30-day validity', async () => {
    const d = await deal({ value: 1200 });
    const q = (await t.api.post('/api/quotes', { deal_id: d.id })).data;
    expect(q).toMatchObject({ status: 'draft', number: '', title: d.name, currency: 'EUR', revision: 1, deal: { id: d.id } });
    expect(q.doc.items).toHaveLength(1);
    expect(q.totals).toMatchObject({ net_cents: 120000, tax_cents: 22800, total_cents: 142800 });
    expect(q.valid_until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const withLines = await deal();
    await t.api.put(`/api/opportunities/${withLines.id}/lines`, { lines: [{ name: 'A', qty: 2, price_cents: 5000 }, { name: 'B', qty: 1, price_cents: 2500 }] });
    expect((await t.api.post('/api/quotes', { deal_id: withLines.id })).data.doc.items.map((i: any) => i.name)).toEqual(['A', 'B']);
    expect((await t.api.post('/api/quotes', { deal_id: 'gibtsnicht' })).status).toBe(404);
    expect((await t.api.post('/api/quotes', {})).status).toBe(400);
  });

  it('options and optional positions, a deposit and the preview of what the customer would pay', async () => {
    const d = await deal();
    const q = await quote(d.id);
    expect(q.doc.options.map((o: any) => [o.name, o.recommended])).toEqual([['Basis', false], ['Plus', true]]);
    expect(q.options.map((o: any) => o.totals.net_cents)).toEqual([50000 + 10000 + 100000, 50000 + 10000 + 180000]);
    expect(q.payment).toEqual({ mode: 'deposit', type: 'percent', value: 30 });
    const p = (await t.api.post(`/api/quotes/${q.id}/preview`, { option_id: opt(q, 1), optional_ids: [q.doc.items[2].id] })).data;
    expect(p.totals.net_cents).toBe(50000 + 10000 + 20000 + 180000);
    expect(p.html).toContain('Bei Annahme fällig: Anzahlung 30 %');
    expect((await t.api.post(`/api/quotes/${q.id}/preview`, { option_id: 'x' })).status).toBe(400);
    // a deposit has to be possible
    expect((await t.api.patch(`/api/quotes/${q.id}`, { payment: { mode: 'deposit', type: 'percent', value: 100 } })).status).toBe(400);
    expect((await t.api.patch(`/api/quotes/${q.id}`, { payment: { mode: 'deposit', type: 'amount', value: 9_000_000 } })).status).toBe(400);
    expect((await t.api.patch(`/api/quotes/${q.id}`, { valid_until: '31.12.2026' })).status).toBe(400);
  });
});

describe('sending and the customer’s page', () => {
  it('numbers the quote, mails the link, marks it viewed when the customer opens it – and freezes it', async () => {
    const d = await deal();
    const q = await quote(d.id);
    expect((await page(q.id)).status).toBe(404); // a draft has no public page
    const before = mails.length;
    const sent = await send(q);
    expect(sent).toMatchObject({ status: 'sent', message: { status: 'sent' } });
    expect(sent.number).toMatch(/^AN-/);
    const mail = mails[before];
    expect(mail.to).toBe('kundin@kunde.example');
    expect(mail.subject).toContain(sent.number);
    expect(JSON.stringify(mail)).toContain(`/q/${token(q.id)}`);

    const html = (await page(q.id)).html;
    expect(html).toContain('Plattform');
    expect(html).toContain('Wählen Sie Ihre Variante');
    expect(html).toContain('EMPFOHLEN');
    expect(html).toContain('Lizenz Plus');
    expect(html).toContain('Schulung');
    expect(html).toContain('Optional – nach Wunsch dazunehmen');
    expect(html).toContain('<strong>Gespräch</strong>');
    expect(html).toContain('Bei Annahme fällig: Anzahlung 30 %');
    expect(html).toContain('Verbindlich annehmen und unterschreiben');
    expect(getQuote(t.app, loc, q.id)!.status).toBe('viewed');
    const log = (await t.api.get(`/api/contacts/${contactId}`)).data;
    expect(JSON.stringify(log)).toBeTruthy();
    expect(t.app.db.get(`SELECT COUNT(*) AS n FROM activities WHERE contact_id = ? AND type = 'quote.viewed'`, contactId)!.n).toBeGreaterThanOrEqual(1);

    // sent quotes do not change; only the validity can be moved
    expect((await t.api.patch(`/api/quotes/${q.id}`, { title: 'Neu' })).status).toBe(409);
    expect((await t.api.patch(`/api/quotes/${q.id}`, { valid_until: '2099-01-01' })).data.valid_until).toBe('2099-01-01');
    expect((await t.api.del(`/api/quotes/${q.id}`)).status).toBe(409);
  });

  it('send without delivering hands out the link; a contact without e-mail needs that', async () => {
    const noMail = (await t.api.post('/api/contacts', { first_name: 'Ohne', last_name: 'Mail' })).data.id;
    const d = await deal({ contact_id: noMail });
    const q = await quote(d.id);
    const refused = await t.api.post(`/api/quotes/${q.id}/send`, {});
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/E-Mail/);
    const before = mails.length;
    const r = await send(q, { deliver: false });
    expect(r.status).toBe('sent');
    expect(r.url).toContain('/q/');
    expect(mails).toHaveLength(before);
  });

  it('a new version replaces the open one when it is sent', async () => {
    const d = await deal();
    const v1 = await send(await quote(d.id));
    const v2 = (await t.api.post(`/api/quotes/${v1.id}/duplicate`, {})).data;
    expect(v2).toMatchObject({ status: 'draft', revision: 2, parent_id: v1.id, number: '' });
    expect(v2.public_token).toBeUndefined();
    await send(v2);
    expect(getQuote(t.app, loc, v1.id)).toMatchObject({ status: 'void', note: 'Ersetzt durch Version 2' });
    expect((await page(v1.id)).html).toContain('Angebot zurückgezogen');
    expect((await accept(v1)).status).toBe(409);
    const numbers = new Set([v1.number, getQuote(t.app, loc, v2.id)!.number]);
    expect(numbers.size).toBe(2);
  });
});

describe('accepting', () => {
  it('checks the choice and the signature on the server', async () => {
    const d = await deal();
    const q = await send(await quote(d.id));
    expect((await accept(q, { name: '  ' })).status).toBe(400);
    expect((await accept(q, { agree: false })).status).toBe(400);
    expect((await accept(q, { signature: 'data:text/html;base64,AAAA' })).status).toBe(400);
    expect((await accept(q, { signature: '' })).status).toBe(400);
    const noOption = await accept(q, { option_id: undefined });
    expect(noOption.status).toBe(400);
    expect(noOption.data.error).toMatch(/Variante/);
    expect((await accept(q, { option_id: 'gibtsnicht' })).status).toBe(400);
    expect((await accept(q, { optional_ids: ['gibtsnicht'] })).status).toBe(400);
    expect(getQuote(t.app, loc, q.id)!.status).not.toBe('accepted');
  });

  it('signature, estimate, deposit invoice with a pay button, the deal follows the choice', async () => {
    const d = await deal({ value: 1 });
    const q = await send(await quote(d.id, { deal_on_accept: 'won' }));
    const events: string[] = [];
    for (const type of ['quote.accepted', 'estimate.accepted', 'contract.signed', 'invoice.created']) t.app.events.on(type, () => void events.push(type));
    const before = mails.length;
    const r = await accept(q, { optional_ids: [q.doc.items[2].id] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.invoice).toMatchObject({ kind: 'deposit' });
    await t.app.events.flush();
    expect(events).toEqual(expect.arrayContaining(['quote.accepted', 'estimate.accepted', 'contract.signed']));

    // what was bought: Einrichtung 500 + Handbuch 100 (7 %) + Schulung 200 + Lizenz Plus 1.800 = 2.600 net, 3.082 gross
    const out = (await t.api.get(`/api/quotes/${q.id}`)).data;
    expect(out).toMatchObject({ status: 'accepted', signer_name: 'Erika Kundin', accepted_total_cents: 308200, invoice_kind: 'partial' });
    expect(out.selection).toEqual({ option_id: opt(q, 1), optional_ids: [q.doc.items[2].id] });

    // the signed record: a contract with hash, signer, IP – readable on its own page
    const contract = t.app.db.get('SELECT * FROM contracts WHERE id = ?', out.contract_id) as any;
    expect(contract).toMatchObject({ status: 'signed', signer_name: 'Erika Kundin', contact_id: contactId, kind: 'contract' });
    expect(contract.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.content).toContain('Lizenz Plus');
    expect(contract.content).not.toContain('Lizenz Basis');
    expect(contract.content).toContain(`Angebot ${q.number}`);
    const signedPage = await t.api.raw(`/s/${contract.public_token}`);
    expect(await signedPage.text()).toContain('Unterschrift');

    // the estimate: numbered like the quote, accepted, with the chosen positions
    const est = (await t.api.get(`/api/invoices/${out.estimate_id}`)).data;
    expect(est).toMatchObject({ kind: 'estimate', number: q.number, status: 'accepted', subtotal_cents: 260000, tax_cents: 47500 + 700, total_cents: 308200 });
    expect(est.items.map((i: any) => i.name)).toEqual(['Einrichtung', 'Handbuch', 'Schulung', 'Lizenz Plus']);

    // the deposit: 30 % of each tax rate's net, a partial invoice, finalised and mailed with the pay button on its page
    const inv = (await t.api.get(`/api/invoices/${out.invoice_id}`)).data;
    expect(inv).toMatchObject({ kind: 'invoice', inv_type: 'partial', ref_id: out.estimate_id, subtotal_cents: 75000 + 3000, tax_cents: 14250 + 210, total_cents: 92460 });
    expect(inv.number).toMatch(/^RE-/);
    expect(inv.status).toBe('sent');
    const invoiceMail = mails.slice(before).find((m) => /Anzahlungsrechnung/.test(m.subject));
    expect(invoiceMail).toBeTruthy();

    // the page now says "angenommen" and offers to pay; the button starts a Stripe checkout for exactly the deposit
    const done = (await page(q.id)).html;
    expect(done).toContain('das Angebot ist angenommen');
    expect(done).toContain(`/i/${inv.public_token}/pay`);
    expect(done).toContain('Jetzt bezahlen');
    expect(done).toContain('924,60');
    const go = await t.api.raw(`/i/${inv.public_token}/pay`, { method: 'POST', redirect: 'manual' });
    expect(go.status).toBe(303);
    expect(go.headers.get('location')).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    expect(checkouts.at(-1)).toMatchObject({ amount: 92460, invoice: inv.id });

    // the deal took over the positions and the net amount, and is won
    expect(valueOf(d.id)).toBe(2600);
    expect((await t.api.get(`/api/opportunities/${d.id}/lines`)).data.lines.map((l: any) => l.name)).toEqual(['Einrichtung', 'Handbuch', 'Schulung', 'Lizenz Plus']);
    expect(t.app.db.get('SELECT status FROM opportunities WHERE id = ?', d.id)).toMatchObject({ status: 'won' });

    // answering twice does nothing more
    expect((await accept(q)).status).toBe(409);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM contracts WHERE title LIKE ?', `Angebot ${q.number}%`)).toEqual({ n: 1 });

    // paying the deposit marks the quote
    expect(markInvoicePaid(t.app, loc, inv.id, 'Stripe')).toBe(true);
    await t.app.events.flush();
    expect(getQuote(t.app, loc, q.id)!.paid_at).toBeTruthy();
    expect((await page(q.id)).html).toContain('Anzahlungsrechnung bezahlt');
  });

  it('after a deposit the final invoice deducts it', async () => {
    const d = await deal();
    const q = await send(await quote(d.id, { payment: { mode: 'deposit', type: 'amount', value: 100000 } }));
    expect((await accept(q, { option_id: opt(q, 0) })).status).toBe(200);
    const out = (await t.api.get(`/api/quotes/${q.id}`)).data;
    const dep = (await t.api.get(`/api/invoices/${out.invoice_id}`)).data;
    // a fixed net amount, split over the rates in proportion (160.000 net: 19 % 150.000, 7 % 10.000)
    expect(dep).toMatchObject({ inv_type: 'partial', subtotal_cents: 100000 });
    const fin = await t.api.post(`/api/quotes/${q.id}/invoice`, {});
    expect(fin.status, JSON.stringify(fin.data)).toBe(200);
    expect(fin.data.kind).toBe('final');
    expect((await t.api.post(`/api/quotes/${q.id}/invoice`, {})).status).toBe(409);
    const draft = (await t.api.get(`/api/invoices/${fin.data.invoice_id}`)).data;
    expect(draft).toMatchObject({ inv_type: 'final', ref_id: out.estimate_id, deduct_ids: [out.invoice_id] });
    const done = await t.api.post(`/api/invoices/${fin.data.invoice_id}/finalise`, {});
    expect(done.status, JSON.stringify(done.data)).toBe(200);
    expect(done.data.total_cents).toBe(189200);
    expect(done.data.deducted_cents).toBe(dep.total_cents);
  });

  it('full payment mode makes the whole invoice at once; no payment mode makes none, the invoice follows by hand', async () => {
    const full = await send(await quote((await deal()).id, { payment: { mode: 'full' } }));
    const r = await accept(full, { option_id: opt(full, 0) });
    expect(r.data.invoice).toMatchObject({ kind: 'full', total_cents: 189200 });
    const fo = (await t.api.get(`/api/quotes/${full.id}`)).data;
    expect(await t.api.get(`/api/invoices/${fo.invoice_id}`).then((x) => x.data)).toMatchObject({ inv_type: 'standard', ref_id: fo.estimate_id, total_cents: 189200, status: 'sent' });
    expect((await t.api.post(`/api/quotes/${full.id}/invoice`, {})).status).toBe(409);

    const none = await send(await quote((await deal()).id, { payment: { mode: 'none' } }));
    const r2 = await accept(none, { option_id: opt(none, 1) });
    expect(r2.data.invoice).toBeNull();
    expect((await t.api.get(`/api/quotes/${none.id}`)).data).toMatchObject({ status: 'accepted', invoice_id: null });
    expect((await page(none.id)).html).toContain('das Angebot ist angenommen');
    const inv = await t.api.post(`/api/quotes/${none.id}/invoice`, {});
    expect(inv.status).toBe(200);
    expect(inv.data.kind).toBe('standard');
    expect((await t.api.get(`/api/invoices/${inv.data.invoice_id}`)).data).toMatchObject({ status: 'draft', total_cents: 284400 });
  });
});

describe('declining, expiry, withdrawing', () => {
  it('a declined quote keeps the reason and says so on its page', async () => {
    const q = await send(await quote((await deal()).id));
    const r = await pub(q.id, 'decline', { reason: 'Zu teuer' });
    expect(r.status).toBe(200);
    expect(getQuote(t.app, loc, q.id)).toMatchObject({ status: 'declined', decline_reason: 'Zu teuer' });
    expect((await page(q.id)).html).toContain('Angebot abgelehnt');
    expect((await pub(q.id, 'decline', {})).status).toBe(409);
    expect((await accept(q)).status).toBe(409);
  });

  it('an expired quote cannot be accepted; the tick marks it; extending the validity opens it again', async () => {
    const q = await send(await quote((await deal()).id));
    t.app.db.run('UPDATE deal_quotes SET valid_until = ? WHERE id = ?', '2020-01-01', q.id);
    expect((await page(q.id)).html).toContain('Angebot abgelaufen');
    const r = await accept(q);
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/abgelaufen/);
    expect(getQuote(t.app, loc, q.id)!.status).toBe('expired');
    // the tick finds quotes nobody opened
    const other = await send(await quote((await deal()).id));
    t.app.db.run('UPDATE deal_quotes SET valid_until = ? WHERE id = ?', '2020-01-01', other.id);
    expect(expireQuotes(t.app)).toBe(1);
    expect(getQuote(t.app, loc, other.id)!.status).toBe('expired');
    expect(expireQuotes(t.app)).toBe(0);
    const reopened = (await t.api.patch(`/api/quotes/${other.id}`, { valid_until: '2099-01-01' })).data;
    expect(reopened).toMatchObject({ status: 'sent', valid_until: '2099-01-01', expired: false });
    expect((await accept(other)).status).toBe(200);
  });

  it('withdrawing a sent quote ends it; an accepted one stays', async () => {
    const q = await send(await quote((await deal()).id));
    expect((await t.api.post(`/api/quotes/${q.id}/void`, { reason: 'Angebot überholt' })).data).toMatchObject({ status: 'void', note: 'Angebot überholt' });
    expect((await accept(q)).status).toBe(409);
    const done = await send(await quote((await deal()).id, { payment: { mode: 'none' } }));
    await accept(done);
    expect((await t.api.post(`/api/quotes/${done.id}/void`, {})).status).toBe(409);
    expect((await t.api.del(`/api/quotes/${(await quote((await deal()).id)).id}`)).status).toBe(200);
  });
});

describe('lists, numbers and who may see what', () => {
  it('lists with filters and keeps numbers per status', async () => {
    const all = (await t.api.get('/api/quotes')).data;
    expect(all.length).toBeGreaterThan(8);
    expect(all[0]).toHaveProperty('total_cents');
    const accepted = (await t.api.get('/api/quotes?status=accepted')).data;
    expect(accepted.length).toBeGreaterThan(2);
    expect(accepted.every((x: any) => x.status === 'accepted')).toBe(true);
    const stats = (await t.api.get('/api/quotes/stats')).data;
    expect(stats.accepted).toBe(accepted.length);
    expect(stats.accepted_cents).toBeGreaterThan(0);
    expect(stats.win_rate).toBeGreaterThan(0);
    expect(stats.labels.accepted).toBe('Angenommen');
    const byDeal = (await t.api.get(`/api/quotes?deal_id=${accepted[0].deal.id}`)).data;
    expect(byDeal.every((x: any) => x.deal.id === accepted[0].deal.id)).toBe(true);
  });

  it('record-level rules apply to quotes: a person sees the quotes of the deals they may see', async () => {
    const mk = async (email: string) => {
      const r = await t.api.post('/api/users', { email, password: 'passwort-123', name: email.split('@')[0], locations: [loc], permissions: ['contacts', 'opportunities'] });
      expect(r.status).toBe(200);
      const login = await t.api.raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pghl': '1' }, body: JSON.stringify({ email, password: 'passwort-123' }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await t.api.raw(path, { method, headers: { 'content-type': 'application/json', 'x-pghl': '1', cookie, 'x-location-id': loc }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
      };
      return { id: r.data.id as string, call };
    };
    const anna = await mk('anna@example.com');
    const ben = await mk('ben@example.com');
    const dealA = await deal({ assigned_to: anna.id });
    const dealB = await deal({ assigned_to: ben.id });
    const qa = await quote(dealA.id);
    const qb = await quote(dealB.id);
    const rule = await t.api.put('/api/sales/access', { enabled: true, rules: { default: { levels: { contacts: 'all', companies: 'all', deals: 'own', tasks: 'all', conversations: 'all' } } } });
    expect(rule.status).toBe(200);
    try {
      expect((await anna.call('GET', '/api/quotes')).data.map((x: any) => x.id)).toEqual(expect.arrayContaining([qa.id]));
      expect((await anna.call('GET', '/api/quotes')).data.map((x: any) => x.id)).not.toContain(qb.id);
      expect((await anna.call('GET', `/api/quotes/${qa.id}`)).status).toBe(200);
      expect((await anna.call('GET', `/api/quotes/${qb.id}`)).status).toBe(404);
      expect((await anna.call('PATCH', `/api/quotes/${qb.id}`, { title: 'gekapert' })).status).toBe(404);
      expect((await anna.call('POST', `/api/quotes/${qb.id}/send`, {})).status).toBe(404);
      expect((await anna.call('POST', `/api/quotes/${qb.id}/duplicate`, {})).status).toBe(404);
      expect((await anna.call('POST', '/api/quotes', { deal_id: dealB.id })).status).toBe(404);
      expect((await anna.call('GET', `/api/quotes?deal_id=${dealB.id}`)).status).toBe(404);
      expect((await anna.call('GET', '/api/quotes/stats')).data.accepted).toBeLessThanOrEqual((await t.api.get('/api/quotes/stats')).data.accepted);
      expect((await anna.call('PUT', `/api/opportunities/${dealB.id}/lines`, { lines: [] })).status).toBe(404);
      expect((await anna.call('GET', `/api/opportunities/${dealB.id}/lines`)).status).toBe(404);
      // her own works as before
      expect((await anna.call('PUT', `/api/opportunities/${dealA.id}/lines`, { lines: [{ name: 'X', price_cents: 100 }] })).status).toBe(200);
    } finally {
      await t.api.put('/api/sales/access', { enabled: false });
    }
  });

  it('is offered to AI tools and workflows', async () => {
    const names = (t.app.services.mcpTools as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ghl_deal_lines', 'ghl_deal_set_lines', 'ghl_quote_list', 'ghl_quote_create', 'ghl_quote_send']));
    expect(t.app.services.workflowTriggers).toEqual(expect.arrayContaining(['quote.sent', 'quote.accepted', 'quote.expired']));
    expect(t.app.services.workflowTriggerMeta['quote.accepted']).toMatchObject({ category: 'sales', label: 'Angebot angenommen und unterschrieben' });
  });
});
