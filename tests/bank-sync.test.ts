import { createVerify, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { addDays, checkPrivateKey, ebJwt, isoDay, mapTransaction, pickBalance, syncKeys } from '../server/services/bank-sync.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const APP_ID = '1a2b3c4d-1111-2222-3333-444455556666';
const today = isoDay(new Date());

describe('Enable Banking client pieces', () => {
  it('signs a short-lived RS256 token with the application id as kid', () => {
    const jwt = ebJwt({ appId: APP_ID, privateKey }, 1_800_000_000);
    const [h, b, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'RS256', kid: APP_ID });
    expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toEqual({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: 1_800_000_000, exp: 1_800_003_600 });
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(checkPrivateKey(privateKey)).toBeNull();
    expect(checkPrivateKey('nope')).toMatch(/kein gültiger privater Schlüssel/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(checkPrivateKey(ec.privateKey)).toMatch(/RSA/);
  });

  it('maps booked transactions (sign, party, purpose), skips pending ones and keys them stably', () => {
    const iban = 'DE02120300000000202051';
    const inn = mapTransaction({ status: 'BOOK', entry_reference: 'r1', credit_debit_indicator: 'CRDT', transaction_amount: { amount: '119.00', currency: 'EUR' }, booking_date: '2026-11-02', value_date: '2026-11-03', debtor: { name: 'Muster GmbH' }, debtor_account: { iban: 'DE89 3704 0044 0532 0130 00' }, creditor: { name: 'Ich' }, remittance_information: ['Rechnung', 'RE-1'] }, iban)!;
    expect(inn).toMatchObject({ amount_cents: 11900, counterparty: 'Muster GmbH', counterparty_iban: 'DE89370400440532013000', purpose: 'Rechnung RE-1', booking_date: '2026-11-02', value_date: '2026-11-03', bank_ref: 'r1', account_iban: iban });
    const out = mapTransaction({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '25.5' }, booking_date: '2026-11-04', creditor: { name: 'Telekom' }, debtor: { name: 'Ich' }, remittance_information: 'Mobilfunk' }, iban)!;
    expect(out).toMatchObject({ amount_cents: -2550, counterparty: 'Telekom', purpose: 'Mobilfunk', currency: 'EUR', ref: '' });
    expect(mapTransaction({ status: 'PDNG', credit_debit_indicator: 'CRDT', transaction_amount: { amount: '5' }, booking_date: '2026-11-04' }, iban)).toBeNull();
    expect(mapTransaction({ status: 'BOOK', transaction_amount: { amount: 'x' }, booking_date: '2026-11-04' }, iban)).toBeNull();
    // With the bank's reference: keyed by account + reference; without: like a file line, identical ones numbered.
    const [k1, k2, k3] = syncKeys([inn, out, out], iban);
    expect(k1).toBe(syncKeys([{ ...inn, purpose: 'anders' }], iban)[0]);
    expect(new Set([k1, k2, k3]).size).toBe(3);
    expect(syncKeys([out, out], iban)).toEqual([k2, k3]);
    expect(pickBalance([{ balance_type: 'ITAV', balance_amount: { amount: '1.00' } }, { balance_type: 'CLBD', balance_amount: { amount: '-12.34', currency: 'eur' }, reference_date: '2026-11-12' }])).toEqual({ cents: -1234, currency: 'EUR', at: '2026-11-12' });
    expect(pickBalance([])).toBeNull();
  });
});

// --- the whole flow against a fake Enable Banking ------------------------------------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
let invoiceNo = '';
let invoiceId = '';
let mode: 'ok' | 'expired' = 'ok';
let lastAuth: any;
const calls: { method: string; path: string; headers: Record<string, string> }[] = [];

const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fakeEb = (async (url: string, init: any = {}) => {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const headers = (init.headers ?? {}) as Record<string, string>;
  calls.push({ method, path: u.pathname + u.search, headers });
  const [h, b, s] = String(headers.authorization ?? '').replace(/^Bearer /, '').split('.');
  if (!s || !createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url'))) return json({ message: 'bad token' }, 401);
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (method === 'GET' && u.pathname === '/aspsps')
    return json({ aspsps: [{ name: 'Sparkasse Siegen', country: 'DE', psu_types: ['business', 'personal'], maximum_consent_validity: 180 * 86400 }, { name: 'Nur Privat Bank', country: 'DE', psu_types: ['personal'] }] });
  if (method === 'POST' && u.pathname === '/auth') {
    lastAuth = body;
    return json({ url: 'https://bank.example/login?session=abc', authorization_id: 'auth-1' });
  }
  if (method === 'POST' && u.pathname === '/sessions') {
    if (body.code !== 'good-code') return json({ message: 'Wrong code' }, 400);
    return json({ session_id: 'sess-123', aspsp: { name: 'Sparkasse Siegen', country: 'DE' }, psu_type: 'business', access: { valid_until: new Date(Date.now() + 180 * 86400_000).toISOString() }, accounts: [{ uid: 'acc-uid-1', account_id: { iban: 'DE02 1203 0000 0000 2020 51' }, name: 'Geschäftskonto', currency: 'EUR' }] });
  }
  if (u.pathname === '/accounts/acc-uid-1/transactions') {
    if (mode === 'expired') return json({ error: 'EXPIRED_SESSION', message: 'Session expired' }, 422);
    if (!u.searchParams.get('continuation_key'))
      return json({
        continuation_key: 'p2',
        transactions: [
          { status: 'BOOK', entry_reference: 'r-in', credit_debit_indicator: 'CRDT', transaction_amount: { amount: '119.00', currency: 'EUR' }, booking_date: addDays(today, -3), debtor: { name: 'Muster GmbH' }, remittance_information: ['Rechnung', invoiceNo] },
          { status: 'BOOK', entry_reference: 'r-tel', credit_debit_indicator: 'DBIT', transaction_amount: { amount: '25.00', currency: 'EUR' }, booking_date: addDays(today, -2), creditor: { name: 'Telekom' }, remittance_information: ['Mobilfunk'] },
          { status: 'PDNG', credit_debit_indicator: 'CRDT', transaction_amount: { amount: '50.00', currency: 'EUR' }, booking_date: today, debtor: { name: 'Später' } },
          { status: 'BOOK', entry_reference: 'r-old', credit_debit_indicator: 'DBIT', transaction_amount: { amount: '9.99', currency: 'EUR' }, booking_date: addDays(today, -200), creditor: { name: 'Uralt' } },
        ],
      });
    return json({ continuation_key: null, transactions: [{ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '10.00', currency: 'EUR' }, booking_date: addDays(today, -1), creditor: { name: 'Bäcker' }, remittance_information: ['Brötchen'] }] });
  }
  if (u.pathname === '/accounts/acc-uid-1/balances') return json({ balances: [{ balance_type: 'CLBD', balance_amount: { amount: '1234.56', currency: 'EUR' }, reference_date: today }] });
  if (method === 'DELETE' && u.pathname === '/sessions/sess-123') return json({ message: 'OK' });
  return json({ message: 'unknown' }, 404);
}) as any;

const sync = async () => (await t.api.get('/api/accounting/bank/sync')).data;
const waitFor = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timeout');
};

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.bankSyncFetch = fakeEb;
  expect((await t.api.post('/api/accounting/setup', { standard: 'skr03' })).status).toBe(200);
  const inv = (await t.api.post('/api/invoices', { items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
  const sent = (await t.api.patch(`/api/invoices/${inv.id}`, { status: 'sent' })).data;
  invoiceNo = sent.number;
  invoiceId = sent.id;
});
afterAll(async () => {
  await t.close();
});

describe('bank sync through Enable Banking', () => {
  it('needs the agency application first and checks what is entered', async () => {
    expect(await sync()).toMatchObject({ ready: false, can_manage: true, connections: [] });
    expect((await t.api.post('/api/accounting/bank/sync/start', { bank: 'Sparkasse Siegen' })).status).toBe(409);
    const put = (b: any) => t.api.put('/api/accounting/bank/sync/agency', b);
    expect((await put({ app_id: 'nope' })).data.error).toMatch(/UUID/);
    expect((await put({ app_id: APP_ID, private_key: 'kein Schlüssel' })).data.error).toMatch(/kein gültiger privater Schlüssel/);
    const ok = await put({ app_id: APP_ID, private_key: privateKey });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ app_id: APP_ID, private_key: '••••••••', key_set: true, ready: true });
    expect(ok.data.redirect_uris[0]).toMatch(/\/oauth\/bank\/enablebanking\/callback$/);
    // Stored sealed, never shown again; the mask sent back changes nothing.
    const stored = t.app.db.get<any>(`SELECT value FROM agency_settings WHERE key = 'bank_sync'`).value;
    expect(stored).not.toContain('PRIVATE KEY');
    expect((await put({ private_key: '••••••••' })).data.ready).toBe(true);
    expect((await sync()).ready).toBe(true);
  });

  it('lists the banks and refuses one that does not serve business accounts', async () => {
    const banks = (await t.api.get('/api/accounting/bank/sync/banks?country=DE')).data;
    expect(banks.map((b: any) => b.name)).toEqual(['Sparkasse Siegen', 'Nur Privat Bank']);
    expect(banks[0]).toMatchObject({ max_days: 180, psu_types: ['business', 'personal'] });
    expect((await t.api.get('/api/accounting/bank/sync/banks?country=Deutschland')).status).toBe(400);
    expect((await t.api.post('/api/accounting/bank/sync/start', { bank: 'Nur Privat Bank' })).data.error).toMatch(/nur für Privatkonten/);
    expect((await t.api.post('/api/accounting/bank/sync/start', { bank: 'Gibt es nicht' })).data.error).toMatch(/kennt Enable Banking nicht/);
  });

  it('connects through the bank login, stores the session sealed and fetches the first transactions right away', async () => {
    const start = await t.api.post('/api/accounting/bank/sync/start', { bank: 'Sparkasse Siegen', psu_type: 'business' });
    expect(start.status, JSON.stringify(start.data)).toBe(200);
    expect(start.data.url).toBe('https://bank.example/login?session=abc');
    expect(lastAuth).toMatchObject({ aspsp: { name: 'Sparkasse Siegen', country: 'DE' }, psu_type: 'business' });
    expect(lastAuth.redirect_url).toMatch(/\/oauth\/bank\/enablebanking\/callback$/);
    expect(Date.parse(lastAuth.access.valid_until) - Date.now()).toBeGreaterThan(179 * 86400_000);
    // A forged state is refused; a wrong code comes back as an error on the bank page.
    expect((await t.api.get('/oauth/bank/enablebanking/callback?state=forged&code=good-code')).status).toBe(400);
    const back = await t.api.get(`/oauth/bank/enablebanking/callback?state=${encodeURIComponent(lastAuth.state)}&code=good-code`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/app/accounting/bank?bank=ok');
    // The state works once.
    expect((await t.api.get(`/oauth/bank/enablebanking/callback?state=${encodeURIComponent(lastAuth.state)}&code=good-code`)).headers.get('location')).toMatch(/bank=error/);
    const row = t.app.db.get<any>('SELECT * FROM bank_connections');
    expect(row.session).not.toContain('sess-123');
    await waitFor(async () => !!(await sync()).connections[0]?.last_sync_at);
    const c = (await sync()).connections[0];
    expect(c).toMatchObject({ bank: 'Sparkasse Siegen', status: 'active', renew_soon: false, last_error: null });
    expect(c.accounts).toEqual([expect.objectContaining({ iban: 'DE02120300000000202051', name: 'Geschäftskonto', enabled: true, balance_cents: 123456, synced_from: addDays(today, -89) })]);
    // Right after the bank login the person counts as present.
    expect(calls.find((x) => x.path.startsWith('/accounts/acc-uid-1/transactions'))!.headers['Psu-Ip-Address']).toBeTruthy();
    const txns = (await t.api.get('/api/accounting/bank/txns')).data.txns;
    // Booked lines of both pages; neither the pending one nor the one before the start of the sync.
    expect(txns.map((x: any) => x.counterparty).sort()).toEqual(['Bäcker', 'Muster GmbH', 'Telekom']);
    const paid = txns.find((x: any) => x.counterparty === 'Muster GmbH');
    expect(paid).toMatchObject({ status: 'matched', amount_cents: 11900, account_iban: 'DE02120300000000202051' });
    expect(paid.match).toMatchObject({ kind: 'invoice', id: invoiceId, ref: invoiceNo });
    const imports = (await t.api.get('/api/accounting/bank/imports')).data;
    expect(imports[0]).toMatchObject({ format: 'sync', new_txns: 3 });
    expect(imports[0].name).toMatch(/Sparkasse Siegen ···2051 \(Bank-Sync\)/);
  });

  it('adds nothing twice, also from the background job, and confirms the match into the books', async () => {
    const c = (await sync()).connections[0];
    const again = await t.api.post(`/api/accounting/bank/sync/${c.id}/run`);
    expect(again.status, JSON.stringify(again.data)).toBe(200);
    expect(again.data).toMatchObject({ added: 0, accounts: 1 });
    // The overlap: ten days before the last booking.
    expect(calls.filter((x) => x.path.includes('/transactions')).at(-2)!.path).toContain(`date_from=${addDays(addDays(today, -1), -10)}`);
    t.app.db.run(`UPDATE bank_connections SET next_sync_at = '2000-01-01T00:00:00.000Z'`);
    const before = calls.length;
    await t.app.tick();
    expect(calls.length).toBeGreaterThan(before);
    // Without the person present the job sends no PSU headers (the bank counts it as one of four a day).
    expect(calls.filter((x) => x.path.includes('/transactions')).at(-1)!.headers['Psu-Ip-Address']).toBeUndefined();
    expect((await sync()).connections[0].next_sync_at > new Date(Date.now() + 7 * 3600_000).toISOString()).toBe(true);
    expect((await t.api.get('/api/accounting/bank/txns')).data.total).toBe(3);
    const paid = (await t.api.get('/api/accounting/bank/txns?status=matched')).data.txns[0];
    expect((await t.api.post(`/api/accounting/bank/txns/${paid.id}/confirm`, {})).status).toBe(200);
    expect((await t.api.get(`/api/invoices/${invoiceId}`)).data.status).toBe('paid');
  });

  it('switches accounts off, marks an ended consent and disconnects (the lines stay)', async () => {
    const c = (await sync()).connections[0];
    const off = await t.api.patch(`/api/accounting/bank/sync/${c.id}/accounts/${c.accounts[0].id}`, { enabled: false });
    expect(off.data.accounts[0].enabled).toBe(false);
    await t.api.patch(`/api/accounting/bank/sync/${c.id}/accounts/${c.accounts[0].id}`, { enabled: true });
    mode = 'expired';
    const run = await t.api.post(`/api/accounting/bank/sync/${c.id}/run`);
    expect(run.status).toBe(409);
    expect(run.data.error).toMatch(/neu verbinden/);
    expect((await sync()).connections[0]).toMatchObject({ status: 'expired', last_error: expect.stringMatching(/abgelaufen/) });
    // An expired connection is left alone by the background job.
    const before = calls.length;
    t.app.db.run(`UPDATE bank_connections SET next_sync_at = '2000-01-01T00:00:00.000Z'`);
    await t.app.tick();
    expect(calls.length).toBe(before);
    const del = await t.api.del(`/api/accounting/bank/sync/${c.id}`);
    expect(del.data).toEqual({ ok: true, ended: true });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/sessions/sess-123' });
    expect((await sync()).connections).toEqual([]);
    expect(t.app.db.get<any>('SELECT COUNT(*) AS n FROM bank_connection_accounts').n).toBe(0);
    expect((await t.api.get('/api/accounting/bank/txns')).data.total).toBe(3);
  });
});
