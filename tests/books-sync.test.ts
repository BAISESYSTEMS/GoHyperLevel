import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKOFF_MS, MAX_ATTEMPTS, RateLimiter, backoffMs, bookedGroups, cleanOptions, isoCountry, lexContact, lexPaid, lexVoucher, sevInvoice, sevPaid } from '../server/services/books-sync-model.js';
import { BooksClient, multipart } from '../server/services/books-sync-http.js';
import { BUYER, doc } from './invoice-fixtures.js';
import { startTestApp } from './helpers.js';

/** Lexware Office / sevDesk live sync with every call to the tools mocked (app.services.booksSyncFetch). */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

type Call = { method: string; url: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any; raw: string | Buffer | undefined };
type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

const LEX_KEY = 'lexTestKey_0123456789abcdefXYZ';
const SEV_KEY = '0123456789abcdef0123456789abcdef';
const SELLER = { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', tax_number: '37/123/45678', contact_name: 'Erika Muster', contact_phone: '+49 30 1234567', contact_email: 'rechnung@muster.example', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bank: 'DKB' };

let t: Awaited<ReturnType<typeof startTestApp>>;
let calls: Call[] = [];
let sleeps: number[] = [];
/** Test-specific answers win; everything else goes to the fake tools below. */
let override: ((c: Call) => Reply | undefined) | undefined;

const lex = { vouchers: new Map<string, any>(), contacts: [] as any[], payments: new Map<string, any>(), files: [] as string[], n: 0 };
const sev = { invoices: new Map<string, any>(), contacts: [] as any[], ways: [] as any[], sent: [] as string[], n: 9000 };

function fakeLexware(c: Call): Reply {
  const p = c.path.replace(/^\/v1/, '');
  if (c.method === 'GET' && p === '/profile') return { status: 200, body: { companyName: 'Muster Beratung GmbH', organizationId: 'org-1' } };
  if (c.method === 'GET' && p === '/contacts') {
    const email = c.query.get('email');
    const number = c.query.get('number');
    const hit = lex.contacts.filter((x) => (email && x.email === email) || (number && x.number === number));
    return { status: 200, body: { content: hit.map((x) => ({ id: x.id })), last: true } };
  }
  if (c.method === 'POST' && p === '/contacts') {
    const idv = `lc-${lex.contacts.length + 1}`;
    lex.contacts.push({ id: idv, email: c.body?.emailAddresses?.business?.[0], body: c.body });
    return { status: 200, body: { id: idv, version: 0 } };
  }
  if (c.method === 'GET' && p === '/vouchers') {
    const n = c.query.get('voucherNumber');
    return { status: 200, body: { content: [...lex.vouchers.values()].filter((v) => v.voucherNumber === n) } };
  }
  if (c.method === 'POST' && p === '/vouchers') {
    const idv = `v-${++lex.n}`;
    lex.vouchers.set(idv, { id: idv, ...c.body });
    return { status: 200, body: { id: idv, version: 1 } };
  }
  const file = /^\/vouchers\/([^/]+)\/files$/.exec(p);
  if (c.method === 'POST' && file) {
    lex.files.push(file[1]);
    return { status: 202, body: { id: `f-${lex.files.length}` } };
  }
  const pay = /^\/payments\/([^/]+)$/.exec(p);
  if (c.method === 'GET' && pay) return { status: 200, body: lex.payments.get(pay[1]) ?? { openAmount: lex.vouchers.get(pay[1])?.totalGrossAmount ?? 0, paymentStatus: 'openRevenue', voucherStatus: 'open', paymentItems: [] } };
  return { status: 404, body: { message: `fake lexware: ${c.method} ${p}` } };
}

function fakeSevdesk(c: Call): Reply {
  const p = c.path.replace(/^\/api\/v1/, '');
  if (c.method === 'GET' && p === '/SevUser') return { status: 200, body: { objects: [{ id: '501', username: 'erika', firstName: 'Erika', lastName: 'Muster' }] } };
  if (c.method === 'GET' && p === '/Invoice') return { status: 200, body: { objects: [...sev.invoices.values()].filter((i) => i.invoiceNumber === c.query.get('invoiceNumber')) } };
  if (c.method === 'GET' && p === '/CreditNote') return { status: 200, body: { objects: [] } };
  if (c.method === 'GET' && p === '/Contact') return { status: 200, body: { objects: sev.contacts.filter((x) => x.customerNumber && x.customerNumber === c.query.get('customerNumber')) } };
  // The API might ignore the value filter: the fake returns every e-mail way – the client must compare itself.
  if (c.method === 'GET' && p === '/CommunicationWay') return { status: 200, body: { objects: sev.ways } };
  if (c.method === 'POST' && p === '/Contact') {
    const idv = String(70 + sev.contacts.length + 1);
    sev.contacts.push({ id: idv, ...c.body });
    return { status: 201, body: { objects: { id: idv, objectName: 'Contact' } } };
  }
  if (c.method === 'POST' && p === '/CommunicationWay') {
    sev.ways.push({ id: `w${sev.ways.length}`, ...c.body });
    return { status: 201, body: { objects: { id: 'w' } } };
  }
  if (c.method === 'POST' && p === '/Invoice/Factory/saveInvoice') {
    const idv = String(++sev.n);
    sev.invoices.set(idv, { id: idv, ...c.body.invoice, status: '100', positions: c.body.invoicePosSave });
    return { status: 201, body: { objects: { invoice: { id: idv, objectName: 'Invoice' }, invoicePos: [] } } };
  }
  const sent = /^\/Invoice\/(\d+)\/sendBy$/.exec(p);
  if (c.method === 'PUT' && sent) {
    sev.sent.push(sent[1]);
    sev.invoices.get(sent[1]).status = '200';
    return { status: 200, body: { objects: { id: sent[1] } } };
  }
  const one = /^\/Invoice\/(\d+)$/.exec(p);
  if (c.method === 'GET' && one) return { status: 200, body: { objects: [sev.invoices.get(one[1])] } };
  return { status: 404, body: { error: { message: `fake sevdesk: ${c.method} ${p}` } } };
}

async function fakeFetch(url: string, init: any = {}) {
  const u = new URL(url);
  const raw = init.body as string | Buffer | undefined;
  let body: any = raw;
  if (typeof raw === 'string' && raw.startsWith('{')) body = JSON.parse(raw);
  const c: Call = { method: init.method ?? 'GET', url, path: u.pathname, query: u.searchParams, headers: init.headers ?? {}, body, raw };
  calls.push(c);
  const r = override?.(c) ?? (u.host === 'api.lexware.io' ? fakeLexware(c) : u.host === 'my.sevdesk.de' ? fakeSevdesk(c) : { status: 599, body: 'unexpected host' });
  const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: r.headers ?? {}, text: async () => text };
}

const item = (price = 10000, over: Record<string, unknown> = {}) => ({ name: 'Beratung', qty: 1, price_cents: price, tax_rate: 19, ...over });
let contactId = '';
async function issued(items: any[] = [item()], who = contactId) {
  const d = (await t.api.post('/api/invoices', { contact_id: who, items })).data;
  const r = await t.api.post(`/api/invoices/${d.id}/finalise`, {});
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  await t.app.events.flush();
  return r.data;
}
const job = (invoiceId: string) => t.app.db.get('SELECT * FROM books_sync_jobs WHERE invoice_id = ?', invoiceId);
const link = (invoiceId: string) => t.app.db.get('SELECT * FROM invoice_links WHERE invoice_id = ?', invoiceId);
const posts = (path: RegExp) => calls.filter((c) => c.method === 'POST' && path.test(c.path));
/** Waits until a job left the queue (routes start the run without waiting for it). */
async function settled(invoiceId: string) {
  for (let i = 0; i < 200 && ['pending', 'running', undefined].includes(job(invoiceId)?.status); i++) await new Promise((r) => setTimeout(r, 10));
  return job(invoiceId);
}

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.booksSyncFetch = fakeFetch;
  t.app.services.booksSyncSleep = async (ms: number) => void sleeps.push(ms);
  contactId = (await t.api.post('/api/contacts', { email: 'einkauf@kunde.example', first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', address: 'Hauptstraße 7', postal_code: '80331', city: 'München', country: 'DE' })).data.id;
  expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
});
afterAll(async () => t.close());
beforeEach(() => {
  calls = [];
  sleeps = [];
  override = undefined;
});

describe('mapping (pure)', () => {
  it('builds a Lexware sales voucher with one item per tax rate and the HyperLevel number', () => {
    const v = lexVoucher(doc(), { contactId: 'lc-9', categoryId: '8f8664a8-fd86-11e1-a21f-0800200c9a66' });
    expect(v).toMatchObject({ type: 'salesinvoice', voucherNumber: 'RE-2026-0001', voucherDate: '2026-10-05', dueDate: '2026-10-19', taxType: 'net', contactId: 'lc-9', useCollectiveContact: false });
    // 2 × 100,00 at 19 % and 34,90 at 7 %
    expect(v.voucherItems).toEqual([
      { amount: 200, taxAmount: 38, taxRatePercent: 19, categoryId: '8f8664a8-fd86-11e1-a21f-0800200c9a66' },
      { amount: 34.9, taxAmount: 2.44, taxRatePercent: 7, categoryId: '8f8664a8-fd86-11e1-a21f-0800200c9a66' },
    ]);
    expect(v.totalGrossAmount).toBe(275.34);
    expect(v.totalTaxAmount).toBe(40.44);
    // without a contact: Lexware's collective customer
    expect(lexVoucher(doc(), { categoryId: 'x' })).toMatchObject({ useCollectiveContact: true });
    expect('contactId' in lexVoucher(doc(), { categoryId: 'x' })).toBe(false);
  });

  it('turns credit notes positive and leaves deducted partial invoices out of a final invoice', () => {
    const cn = doc({ kind: 'credit_note', credit_type: 'storno', items: [{ name: 'Beratung', qty: -1, price_cents: 10000, tax_rate: 19 }] });
    expect(lexVoucher(cn, { categoryId: 'c' })).toMatchObject({ type: 'salescreditnote', totalGrossAmount: 119, totalTaxAmount: 19, voucherItems: [{ amount: 100, taxAmount: 19, taxRatePercent: 19 }] });
    expect('dueDate' in lexVoucher(cn, { categoryId: 'c' })).toBe(false);
    const final = { totals: { subtotal_cents: 30000, tax_cents: 5700, total_cents: 35700, groups: [{ category: 'S' as const, rate: 19, net_cents: 30000, tax_cents: 5700 }] }, deductions: [{ id: 'p', number: 'AR-1', issued_at: '', net_cents: 10000, tax_cents: 1900, total_cents: 11900, groups: [{ category: 'S' as const, rate: 19, net_cents: 10000, tax_cents: 1900 }] }] };
    expect(bookedGroups(final)).toEqual([{ category: 'S', rate: 19, net_cents: 20000, tax_cents: 3800 }]);
  });

  it('maps contacts, countries, tax rules and the sevDesk invoice', () => {
    expect(lexContact({ first_name: 'Max', last_name: 'Kunde', company: 'Kunde GmbH', email: 'a@b.de' }, BUYER)).toMatchObject({ roles: { customer: {} }, company: { name: 'Kunde GmbH', contactPersons: [{ firstName: 'Max', lastName: 'Kunde', emailAddress: 'a@b.de', primary: true }] }, emailAddresses: { business: ['a@b.de'] }, addresses: { billing: [{ zip: '80331', city: 'München', countryCode: 'DE' }] } });
    expect(lexContact({ first_name: 'Eva', last_name: 'Solo' }, { ...BUYER, company: '' })).toMatchObject({ person: { firstName: 'Eva', lastName: 'Solo' } });
    expect([isoCountry('de'), isoCountry('Deutschland'), isoCountry('Österreich'), isoCountry('Atlantis')]).toEqual(['DE', 'DE', 'AT', '']);
    const s = sevInvoice(doc({ tax_mode: 'reverse_charge', items: [{ name: 'Beratung', qty: 2, price_cents: 5000, tax_rate: 0 }] }), { contactId: '77', sevUserId: '501', unityId: '1' });
    expect(s.invoice).toMatchObject({ invoiceNumber: 'RE-2026-0001', invoiceDate: '05.10.2026', contact: { id: 77, objectName: 'Contact' }, contactPerson: { id: 501, objectName: 'SevUser' }, status: 100, invoiceType: 'RE', taxRule: { id: '5', objectName: 'TaxRule' }, taxType: 'eu', timeToPay: 14 });
    expect(s.invoicePosSave).toEqual([expect.objectContaining({ objectName: 'InvoicePos', quantity: 2, price: 50, taxRate: 0, name: 'Beratung' })]);
  });

  it('reads the payment status of both tools', () => {
    expect(lexPaid({ openAmount: 0, paymentStatus: 'balanced', paidDate: '2026-10-10T00:00:00.000+02:00' }, 11900)).toEqual({ paidCents: 11900, paidAt: '2026-10-10T00:00:00.000+02:00', settled: true });
    expect(lexPaid({ openAmount: 69, paymentStatus: 'openRevenue', paymentItems: [{ postingDate: '2026-10-08' }] }, 11900)).toEqual({ paidCents: 5000, paidAt: '2026-10-08', settled: false });
    expect(lexPaid({}, 11900)).toMatchObject({ paidCents: 0, settled: false });
    expect(sevPaid({ status: '1000', paidAmount: 119, payDate: '2026-10-09T00:00:00+02:00' }, 11900)).toMatchObject({ paidCents: 11900, settled: true });
    expect(sevPaid({ status: '750', paidAmount: 50 }, 11900)).toMatchObject({ paidCents: 5000, settled: false });
  });

  it('validates the mapping options and spaces the retries', () => {
    expect(cleanOptions({ contact_match: 'collective', attach_pdf: false })).toMatchObject({ contact_match: 'collective', attach_pdf: false, pull_payments: true });
    expect(() => cleanOptions({ contact_match: 'random' })).toThrow(/Kontakt-Abgleich/);
    expect(() => cleanOptions({ category_id: 'nope' })).toThrow(/Buchungskategorie/);
    expect(() => cleanOptions({ sev_user_id: 'abc' })).toThrow(/nur Ziffern/);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(900_000);
    expect(backoffMs(MAX_ATTEMPTS)).toBeNull();
    expect(BACKOFF_MS.every((v, i) => i === 0 || v > BACKOFF_MS[i - 1])).toBe(true);
  });
});

describe('rate limiter and HTTP client', () => {
  it('gives every caller of one key its own slot (Lexware: two calls a second)', async () => {
    let clock = 1_000_000;
    const waits: number[] = [];
    const rl = new RateLimiter({ now: () => clock, sleep: async (ms) => void waits.push(ms) });
    expect(await Promise.all([rl.wait('lex:a', 500), rl.wait('lex:a', 500), rl.wait('lex:a', 500), rl.wait('lex:b', 500)])).toEqual([0, 500, 1000, 0]);
    expect(waits).toEqual([500, 1000]);
    clock += 5000;
    expect(await rl.wait('lex:a', 500)).toBe(0);
  });

  it('retries 429 after Retry-After and 5xx with backoff, then gives up with a German error', async () => {
    const sl: number[] = [];
    let n = 0;
    const replies: Reply[] = [{ status: 429, headers: { 'retry-after': '2' } }, { status: 503 }, { status: 200, body: { companyName: 'X' } }];
    const deps = { fetch: async () => { const r = replies[n++]; return { status: r.status, ok: r.status < 300, headers: r.headers ?? {}, text: async () => JSON.stringify(r.body ?? {}) }; }, sleep: async (ms: number) => void sl.push(ms), limiter: new RateLimiter({ sleep: async () => undefined }) };
    const c = new BooksClient(deps, 'lexware', LEX_KEY);
    expect(await c.call('GET', '/profile')).toEqual({ companyName: 'X' });
    expect(sl).toEqual([2000, 2000]);
    n = 0;
    replies.splice(0, 3, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    await expect(c.call('GET', '/profile')).rejects.toThrow(/Lexware Office antwortet mit Fehler 500/);
    expect(n).toBe(4);
    const unauthorized = new BooksClient({ ...deps, fetch: async () => ({ status: 401, ok: false, headers: {}, text: async () => '{}' }) }, 'sevdesk', SEV_KEY);
    await expect(unauthorized.call('GET', '/SevUser')).rejects.toMatchObject({ status: 401, fatal: true, message: expect.stringMatching(/sevDesk: API-Schlüssel ungültig/) });
  });

  it('builds a multipart body with the PDF bytes intact', () => {
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe]);
    const m = multipart({ type: 'voucher' }, { name: 'Rechnung-RE-1.pdf', type: 'application/pdf', data: pdf });
    expect(m.contentType).toMatch(/^multipart\/form-data; boundary=----gohigh[0-9a-f]{24}$/);
    expect(m.body.includes(pdf)).toBe(true);
    expect(m.body.toString('latin1')).toContain('name="type"\r\n\r\nvoucher');
  });
});

describe('Lexware Office live sync', () => {
  it('stores the key sealed, never returns it and tests the connection', async () => {
    expect((await t.api.put('/api/books-sync', { provider: 'lexware' })).status).toBe(400);
    expect((await t.api.put('/api/books-sync', { provider: 'lexware', api_key: 'kurz' })).status).toBe(400);
    const r = await t.api.put('/api/books-sync', { provider: 'lexware', api_key: LEX_KEY });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ provider: 'lexware', connected: true, enabled: true, hint: '…fXYZ' });
    const row = t.app.db.get('SELECT secret_sealed FROM books_sync_settings WHERE location_id = ?', t.api.location);
    expect(row.secret_sealed).toMatch(/^v\d:/);
    expect(JSON.stringify((await t.api.get('/api/books-sync')).data)).not.toContain(LEX_KEY);
    const test = await t.api.post('/api/books-sync/test');
    expect(test.data).toEqual({ ok: true, detail: 'Verbunden mit Muster Beratung GmbH' });
    expect(calls[0].headers.authorization).toBe(`Bearer ${LEX_KEY}`);
  });

  it('pushes a finalised invoice: contact upsert, voucher with tax rates, PDF, remote id in invoice_links', async () => {
    const inv = await issued([item(10000), item(5000, { name: 'Buch', tax_rate: 7 })]);
    expect(job(inv.id)).toMatchObject({ status: 'done', provider: 'lexware', remote_id: 'v-1', stage: 'attached' });
    expect(link(inv.id)).toMatchObject({ provider: 'lexware', external_id: 'v-1', number: inv.number, status: 'sent' });
    const contactPost = posts(/\/v1\/contacts$/)[0];
    expect(contactPost.body).toMatchObject({ roles: { customer: {} }, company: { name: 'Kunde GmbH' }, emailAddresses: { business: ['einkauf@kunde.example'] } });
    const v = lex.vouchers.get('v-1');
    expect(v).toMatchObject({ type: 'salesinvoice', voucherNumber: inv.number, contactId: 'lc-1', totalGrossAmount: 172.5, totalTaxAmount: 22.5 });
    expect(v.voucherItems.map((i: any) => [i.amount, i.taxRatePercent])).toEqual([[100, 19], [50, 7]]);
    const file = posts(/\/files$/)[0];
    expect(file.headers['content-type']).toMatch(/^multipart\/form-data/);
    expect(Buffer.isBuffer(file.raw) && (file.raw as Buffer).includes(Buffer.from('%PDF'))).toBe(true);
    // the contact is cached: the next invoice of the same contact does not look it up again
    calls = [];
    await issued();
    expect(calls.filter((c) => c.path === '/v1/contacts')).toEqual([]);
  });

  it('never creates a document twice (repeated event, manual push, existing voucher with the same number)', async () => {
    const inv = await issued();
    const before = lex.vouchers.size;
    t.app.events.emit(t.api.location, 'invoice.finalised', { invoice: { id: inv.id, kind: 'invoice' } });
    await t.app.events.flush();
    expect((await t.api.post(`/api/books-sync/invoices/${inv.id}/push`)).status).toBe(200);
    await t.app.events.flush();
    await t.app.tick();
    expect(lex.vouchers.size).toBe(before);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM books_sync_jobs WHERE invoice_id = ?', inv.id).n).toBe(1);
    // a voucher that already exists in Lexware (made by hand, or by a run that died before saving the id) is adopted
    const draft = (await t.api.post('/api/invoices', { contact_id: contactId, items: [item()] })).data;
    const next = (await t.api.get(`/api/invoices/${draft.id}/precheck`)).data?.next_number;
    expect(next).toBeTruthy();
    lex.vouchers.set('v-manual', { id: 'v-manual', voucherNumber: next, totalGrossAmount: 119 });
    calls = [];
    await t.api.post(`/api/invoices/${draft.id}/finalise`, {});
    await t.app.events.flush();
    expect(posts(/\/v1\/vouchers$/)).toEqual([]);
    expect(posts(/\/files$/)).toEqual([]);
    expect(job(draft.id)).toMatchObject({ status: 'done', remote_id: 'v-manual', stage: 'adopted' });
    const logs = (await t.api.get('/api/books-sync/log')).data;
    expect(logs.some((l: any) => l.action === 'adopt' && l.message.includes(next))).toBe(true);
  });

  it('retries with backoff, continues after a half-finished run and logs the errors', async () => {
    // Lexware is down: four tries in the client, then the job waits
    override = (c) => (c.method === 'POST' && c.path === '/v1/vouchers' ? { status: 502 } : undefined);
    const inv = await issued();
    expect(posts(/\/v1\/vouchers$/)).toHaveLength(4);
    const j = job(inv.id);
    expect(j).toMatchObject({ status: 'retry', attempts: 1, remote_id: '' });
    expect(Date.parse(j.next_at) - Date.now()).toBeGreaterThan(50_000);
    const log = (await t.api.get('/api/books-sync/log')).data;
    expect(log[0]).toMatchObject({ level: 'error', invoice_id: inv.id });
    expect(log[0].message).toMatch(/Lexware Office antwortet mit Fehler 502 – neuer Versuch in 1 Min/);
    // the voucher goes through, the file upload fails: the remote id is kept, the next run only uploads the file
    override = (c) => (c.method === 'POST' && /\/files$/.test(c.path) ? { status: 500 } : undefined);
    t.app.db.run('UPDATE books_sync_jobs SET next_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), j.id);
    calls = [];
    await t.app.tick();
    expect(posts(/\/v1\/vouchers$/)).toHaveLength(1);
    expect(job(inv.id)).toMatchObject({ status: 'retry', attempts: 2, stage: 'created' });
    expect(link(inv.id).external_id).toBe(job(inv.id).remote_id);
    override = undefined;
    calls = [];
    expect((await t.api.post(`/api/books-sync/jobs/${j.id}/retry`)).status).toBe(200);
    await settled(inv.id);
    await t.app.tick();
    expect(posts(/\/v1\/vouchers$/)).toHaveLength(0);
    expect(posts(/\/files$/)).toHaveLength(1);
    expect(job(inv.id)).toMatchObject({ status: 'done', stage: 'attached' });
  });

  it('stops at once when the key is refused or the voucher is rejected', async () => {
    override = (c) => (c.method === 'POST' && c.path === '/v1/vouchers' ? { status: 406, body: { IssueList: [{ i18nKey: 'invalid_field', source: 'voucherItems' }] } } : undefined);
    const inv = await issued();
    expect(posts(/\/v1\/vouchers$/)).toHaveLength(1);
    expect(job(inv.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(job(inv.id).last_error).toMatch(/invalid_field voucherItems/);
    const jobs = (await t.api.get('/api/books-sync/jobs?status=failed')).data;
    expect(jobs.some((x: any) => x.invoice_id === inv.id && x.number === inv.number)).toBe(true);
    const cat = (await t.api.get('/api/integrations/catalog')).data.items.find((x: any) => x.key === 'books_lexware');
    expect(cat).toMatchObject({ status: 'partial' });
    override = undefined;
    await t.api.post(`/api/books-sync/jobs/${job(inv.id).id}/retry`);
    expect((await settled(inv.id)).status).toBe('done');
  });

  it('pushes credit notes as salescreditnote', async () => {
    const inv = await issued([item(20000)]);
    const cn = (await t.api.post(`/api/invoices/${inv.id}/credit-note`, { items: [item(5000)], reason: 'Kulanz' })).data;
    expect((await t.api.post(`/api/invoices/${cn.id}/finalise`, {})).status).toBe(200);
    await t.app.events.flush();
    const v = lex.vouchers.get(job(cn.id).remote_id);
    expect(v).toMatchObject({ type: 'salescreditnote', totalGrossAmount: 59.5, totalTaxAmount: 9.5, voucherItems: [{ amount: 50, taxAmount: 9.5, taxRatePercent: 19 }] });
  });

  it('pulls payments: paid in Lexware → paid here, part payments only once', async () => {
    const full = await issued([item(10000)]);
    const part = await issued([item(20000)]);
    lex.payments.set(job(full.id).remote_id, { openAmount: 0, paymentStatus: 'balanced', voucherStatus: 'paid', paidDate: '2026-10-01T00:00:00.000+02:00' });
    lex.payments.set(job(part.id).remote_id, { openAmount: 138, paymentStatus: 'openRevenue', voucherStatus: 'open', paymentItems: [{ postingDate: '2026-10-02T00:00:00.000+02:00', amount: 100 }] });
    const r = await t.api.post('/api/books-sync/pull');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.updated).toBe(2);
    const a = (await t.api.get(`/api/invoices/${full.id}`)).data;
    expect(a.status).toBe('paid');
    const pay = t.app.db.get('SELECT * FROM invoice_payments WHERE invoice_id = ?', full.id);
    expect(pay).toMatchObject({ amount_cents: 11900, source: 'lexware', method: 'Lexware Office' });
    expect(pay.paid_at.slice(0, 10)).toBe('2026-09-30');
    expect(link(full.id).status).toBe('paid');
    const b = (await t.api.get(`/api/invoices/${part.id}`)).data;
    expect([b.status, b.paid_cents]).toEqual(['sent', 10000]);
    // nothing new in Lexware: nothing new here
    await t.api.post('/api/books-sync/pull');
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM invoice_payments WHERE invoice_id = ?', part.id).n).toBe(1);
  });

  it('backfills older invoices once and keeps sub-accounts apart', async () => {
    t.app.db.run(`UPDATE books_sync_settings SET enabled = 0 WHERE location_id = ?`, t.api.location);
    const old = await issued();
    expect(job(old.id)).toBeUndefined();
    t.app.db.run(`UPDATE books_sync_settings SET enabled = 1 WHERE location_id = ?`, t.api.location);
    const r = await t.api.post('/api/books-sync/backfill', { since: '2020-01-01' });
    expect(r.data.queued).toBe(1);
    expect((await settled(old.id))?.status).toBe('done');
    expect((await t.api.post('/api/books-sync/backfill', { since: '2020-01-01' })).data.queued).toBe(0);
    // another sub-account sees none of it and cannot touch it
    const mine = t.api.location;
    const other = (await t.api.post('/api/locations', { name: 'Andere Firma' })).data.id;
    t.api.setLocation(other);
    try {
      expect((await t.api.get('/api/books-sync/jobs')).data).toEqual([]);
      expect((await t.api.get('/api/books-sync/log')).data).toEqual([]);
      expect((await t.api.post(`/api/books-sync/jobs/${job(old.id).id}/retry`)).status).toBe(404);
      expect((await t.api.post(`/api/books-sync/invoices/${old.id}/push`)).status).toBe(409);
      expect((await t.api.get('/api/books-sync')).data).toMatchObject({ provider: '', connected: false });
    } finally {
      t.api.setLocation(mine);
    }
  });
});

describe('sevDesk live sync', () => {
  let loc = '';
  let who = '';
  beforeAll(async () => {
    loc = (await t.api.post('/api/locations', { name: 'sevDesk GmbH' })).data.id;
  });

  it('connects, pushes an invoice (contact, positions, tax rule, marked sent) and pulls the payment', async () => {
    const mine = t.api.location;
    t.api.setLocation(loc);
    try {
      expect((await t.api.put('/api/invoice-settings', SELLER)).status).toBe(200);
      who = (await t.api.post('/api/contacts', { email: 'Anna@Firma.example', first_name: 'Anna', last_name: 'Firma' })).data.id;
      sev.ways.push({ id: 'w-other', type: 'EMAIL', value: 'someone@else.example', contact: { id: '1', objectName: 'Contact' } });
      expect((await t.api.put('/api/books-sync', { provider: 'sevdesk', api_key: SEV_KEY })).status).toBe(200);
      const test = await t.api.post('/api/books-sync/test');
      expect(test.data.detail).toMatch(/Erika Muster/);
      expect((await t.api.get('/api/books-sync')).data.options.sev_user_id).toBe('501');
      expect(calls[0].headers.authorization).toBe(SEV_KEY);
      const inv = await issued([item(10000), item(2000, { name: 'Material', qty: 3 })], who);
      expect(job(inv.id)).toMatchObject({ status: 'done', provider: 'sevdesk', stage: 'sent' });
      const remote = sev.invoices.get(job(inv.id).remote_id);
      expect(remote).toMatchObject({ invoiceNumber: inv.number, contact: { id: 71 }, contactPerson: { id: 501 }, taxRule: { id: '1' }, status: '200' });
      expect(remote.positions.map((p: any) => [p.name, p.quantity, p.price, p.taxRate])).toEqual([['Beratung', 1, 100, 19], ['Material', 3, 20, 19]]);
      // the other contact's e-mail never matched: a new sevDesk contact with the e-mail as communication way
      expect(sev.contacts[0]).toMatchObject({ surename: 'Anna', familyname: 'Firma', category: { id: 3 } });
      expect(sev.ways.at(-1)).toMatchObject({ type: 'EMAIL', value: 'anna@firma.example', contact: { id: 71 } });
      expect(link(inv.id)).toMatchObject({ provider: 'sevdesk', external_id: job(inv.id).remote_id });
      remote.status = '1000';
      remote.paidAmount = 178.5;
      remote.payDate = '2026-10-03T00:00:00+02:00';
      const r = await t.api.post('/api/books-sync/pull');
      expect(r.data).toEqual({ checked: 1, updated: 1 });
      expect((await t.api.get(`/api/invoices/${inv.id}`)).data.status).toBe('paid');
      expect(t.app.db.get('SELECT source FROM invoice_payments WHERE invoice_id = ?', inv.id).source).toBe('sevdesk');
    } finally {
      t.api.setLocation(mine);
    }
  });

  it('switching the tool stops the old queue and needs the new key', async () => {
    const mine = t.api.location;
    t.api.setLocation(loc);
    try {
      expect((await t.api.put('/api/books-sync', { provider: 'lexware' })).status).toBe(400);
      const d = await t.api.del('/api/books-sync');
      expect(d.data).toMatchObject({ connected: false, enabled: false });
      const inv = await issued([item()], who);
      expect(job(inv.id)).toBeUndefined();
    } finally {
      t.api.setLocation(mine);
    }
  });
});
