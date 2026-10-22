import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { maskCode, newCode, normCode } from '../server/services/giftcards.js';
import { zonedToUtc } from '../server/core/time.js';

/**
 * Gift cards (docs/store.md#gift-cards): codes, the append-only ledger, holds, the admin API, redeeming on invoices (by hand and on
 * the pay page) and in booking payments, expiry, DSGVO. The store checkout's part is in tests/store.test.ts.
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let chef = '';
beforeAll(async () => {
  t = await startTestApp();
  chef = (await t.setup()).user.id;
  loc = t.api.location;
});
afterAll(async () => t?.close());

const form = { 'content-type': 'application/x-www-form-urlencoded' };
async function invoice(net: number) {
  const inv = (await t.api.post('/api/invoices', { title: 'Leistung', items: [{ name: 'Leistung', qty: 1, price_cents: net, tax_rate: 19 }] })).data;
  expect((await t.api.post(`/api/invoices/${inv.id}/finalise`, {})).status).toBe(200);
  return t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', inv.id)!;
}

describe('codes', () => {
  it('are 16 characters without look-alikes, typed in any form', () => {
    const c = newCode();
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(normCode(c.toLowerCase().replace(/-/g, ' '))).toBe(c);
    expect(maskCode('ABCD-EFGH-JKLM-NPQR')).toBe('••••-NPQR');
  });
});

describe('admin', () => {
  it('issues, lists, checks, adjusts and switches off cards; the ledger cannot be changed', async () => {
    const contact = (await t.api.post('/api/contacts', { first_name: 'Greta', email: 'greta@example.com' })).data;
    expect((await t.api.post('/api/gift-cards', { amount_cents: 50 })).data.error).toMatch(/1 € bis/);
    expect((await t.api.post('/api/gift-cards', { amount_cents: 1000, expires_at: '2020-01-01' })).data.error).toMatch(/Zukunft/);
    const r = await t.api.post('/api/gift-cards', { amount_cents: 5000, contact_id: contact.id, recipient_name: 'Greta', recipient_email: 'greta@example.com', message: 'Viel Spaß!', send: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ initial_cents: 5000, balance_cents: 5000, available_cents: 5000, state: 'active', contact_name: 'Greta', sent: { status: 'logged', to: 'greta@example.com' } });
    const card = r.data;
    const list = (await t.api.get('/api/gift-cards')).data;
    expect(list).toMatchObject({ count: 1, outstanding_cents: 5000 });
    expect(list.cards[0]).toMatchObject({ id: card.id, contact_name: 'Greta', available_cents: 5000 });
    expect((await t.api.get(`/api/gift-cards?q=${card.code.slice(-4)}`)).data.cards).toHaveLength(1);
    expect((await t.api.post('/api/gift-cards/check', { code: card.code.toLowerCase() })).data.balance_cents).toBe(5000);
    expect((await t.api.post(`/api/gift-cards/${card.id}/adjust`, { amount_cents: -6000, note: 'zu viel' })).status).toBe(409);
    expect((await t.api.post(`/api/gift-cards/${card.id}/adjust`, { amount_cents: -1000 })).data.error).toMatch(/Grund/);
    expect((await t.api.post(`/api/gift-cards/${card.id}/adjust`, { amount_cents: 1000, note: 'Entschädigung' })).data.balance_cents).toBe(6000);
    const detail = (await t.api.get(`/api/gift-cards/${card.id}`)).data;
    expect(detail.ledger.map((l: any) => [l.kind_label, l.amount_cents])).toEqual([['Ausgegeben', 5000], ['Korrektur', 1000]]);
    expect(() => t.app.db.run('UPDATE gift_card_ledger SET amount_cents = 1 WHERE card_id = ?', card.id)).toThrow(/unveränderbar/);
    expect(() => t.app.db.run('DELETE FROM gift_card_ledger WHERE card_id = ?', card.id)).toThrow(/unveränderbar/);
    expect((await t.api.patch(`/api/gift-cards/${card.id}`, { status: 'disabled' })).data.state).toBe('disabled');
    expect((await t.api.post('/api/gift-cards/redeem', { code: card.code, amount_cents: 100 })).data.error).toMatch(/gesperrt/);
    expect((await t.api.patch(`/api/gift-cards/${card.id}`, { status: 'active', expires_at: new Date(Date.now() - 864e5).toISOString() })).data.state).toBe('expired');
    expect((await t.api.post('/api/gift-cards/redeem', { code: card.code, amount_cents: 100 })).data.error).toMatch(/abgelaufen/);
    expect((await t.api.patch(`/api/gift-cards/${card.id}`, { expires_at: '' })).data.state).toBe('active');
    const mail = t.app.db.get<any>(`SELECT subject, body FROM messages WHERE channel = 'email' ORDER BY created_at DESC LIMIT 1`);
    // the code went to the recipient's address directly (not through the inbox), so no message row names it
    expect(JSON.stringify(mail ?? {})).not.toContain(card.code);
  });

  it('redeems by hand: at the counter, and on an invoice as a payment "Gutschein"', async () => {
    const card = (await t.api.post('/api/gift-cards', { amount_cents: 3000 })).data;
    expect((await t.api.post('/api/gift-cards/redeem', { code: card.code, amount_cents: 1200, note: 'Laden' })).data).toMatchObject({ amount_cents: 1200, card: { balance_cents: 1800 } });
    const inv = await invoice(10000);
    const r = await t.api.post('/api/gift-cards/redeem', { code: card.code, invoice_id: inv.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ amount_cents: 1800, card: { balance_cents: 0, state: 'used' } });
    expect(t.app.db.get<any>('SELECT status, paid_cents FROM invoices WHERE id = ?', inv.id)).toEqual({ status: 'sent', paid_cents: 1800 });
    expect(t.app.db.get<any>('SELECT method, note FROM invoice_payments WHERE invoice_id = ?', inv.id)).toEqual({ method: 'Gutschein', note: maskCode(card.code) });
    expect((await t.api.post('/api/gift-cards/redeem', { code: card.code, amount_cents: 1 })).data.error).toMatch(/kein Guthaben/);
  });
});

describe('pay page', () => {
  it('an invoice paid entirely with a gift card on its pay page', async () => {
    const card = (await t.api.post('/api/gift-cards', { amount_cents: 20000 })).data;
    const inv = await invoice(5000);
    const page = (await t.api.get(`/i/${inv.public_token}`)).data as string;
    expect(page).toContain('Gutschein einlösen');
    const r = await t.api.raw(`/i/${inv.public_token}/pay-options`, { method: 'POST', headers: form, redirect: 'manual' });
    const sid = r.headers.get('location')!.split('/')[2];
    const bad = await t.api.raw(`/pay/${sid}/gift`, { method: 'POST', headers: form, body: 'code=AAAA-BBBB-CCCC-DDDD' });
    expect(await bad.text()).toContain('Diesen Gutscheincode gibt es nicht');
    const ok = await t.api.raw(`/pay/${sid}/gift`, { method: 'POST', headers: form, body: `code=${card.code}`, redirect: 'manual' });
    expect(ok.status).toBe(303);
    const pp = (await t.api.get(`/pay/${sid}`)).data as string;
    expect(pp).toContain('Mit Gutschein bezahlen');
    expect(t.app.db.get<any>('SELECT amount_cents, gift_cents FROM pay_sessions WHERE id = ?', sid)).toEqual({ amount_cents: 0, gift_cents: 5950 });
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: form, body: 'provider=giftcard', redirect: 'manual' });
    expect(go.headers.get('location')).toBe(`http://localhost/i/${inv.public_token}`);
    expect(t.app.db.get<any>('SELECT status FROM invoices WHERE id = ?', inv.id)!.status).toBe('paid');
    expect(t.app.db.get<any>('SELECT balance_cents FROM gift_cards WHERE id = ?', card.id)!.balance_cents).toBe(20000 - 5950);
    expect(t.app.db.get<any>('SELECT status, provider FROM pay_sessions WHERE id = ?', sid)).toEqual({ status: 'paid', provider: 'giftcard' });
  });

  it('a booking paid with a gift card: the pay page instead of Stripe, the hold becomes the appointment', async () => {
    const card = (await t.api.post('/api/gift-cards', { amount_cents: 10000 })).data;
    const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
    const cal = (await t.api.post('/api/calendars', { name: 'Massage', duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, timezone: 'Europe/Berlin', settings: { confirmation_email: false, notify_team: false, reminder_hours: 0 } })).data;
    // Stripe connected (the hold needs a way to pay); with a gift card around, the buyer gets the pay page to choose
    t.app.db.run(`INSERT INTO stripe_accounts (location_id, secret_key, updated_at) VALUES (?, ?, ?)`, loc, (await import('../server/core/secrets.js')).sealSecret(t.app, 'sk_test_51FakeKeyForTests000abcd'), new Date().toISOString());
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { kind: 'single', payment: { mode: 'full', amount_cents: 8000, currency: 'EUR', tax_rate: 19, title: 'Massage' } }, members: [{ user_id: chef }] })).status).toBe(200);
    const day = new Date(Date.now() + 4 * 864e5).toISOString().slice(0, 10);
    const r = await t.api.post(`/api/public/team-calendars/${cal.slug}/book`, { start: zonedToUtc(day, '11:00', 'Europe/Berlin').toISOString(), first_name: 'Ben', last_name: 'Bucher', email: 'ben@example.com', consent: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.checkout_url).toMatch(/\/pay\/ps_/);
    const sid = r.data.checkout_url.split('/').pop();
    const pp = (await t.api.get(`/pay/${sid}`)).data as string;
    expect(pp).toContain('Weiter mit Stripe');
    expect(pp).toContain('Gutscheincode');
    await t.api.raw(`/pay/${sid}/gift`, { method: 'POST', headers: form, body: `code=${card.code}`, redirect: 'manual' });
    const go = await t.api.raw(`/pay/${sid}/go`, { method: 'POST', headers: form, body: 'provider=giftcard', redirect: 'manual' });
    expect(go.headers.get('location')).toMatch(/\/book\/paid\//);
    await t.app.events.flush();
    await Promise.all([...(t.app.services.collabPending ?? [])]);
    await new Promise((res) => setTimeout(res, 50));
    const hold = t.app.db.get<any>('SELECT * FROM teamcal_holds WHERE session_id = ?', sid)!;
    expect(hold.status).toBe('paid');
    expect(t.app.db.get<any>('SELECT status FROM appointments WHERE id = ?', hold.appointment_id)!.status).toBe('confirmed');
    expect(t.app.db.get<any>('SELECT balance_cents FROM gift_cards WHERE id = ?', card.id)!.balance_cents).toBe(2000);
    // cancelled with a refund: the money goes back onto the card
    const refund = await t.app.services.payRegistry.refundAll(sid);
    expect(refund).toMatchObject({ amount_cents: 0, gift_cents: 8000 });
    expect(t.app.db.get<any>('SELECT balance_cents FROM gift_cards WHERE id = ?', card.id)!.balance_cents).toBe(10000);
  });
});

describe('DSGVO', () => {
  it('keeps the cards (money), drops the link to the erased person and their data as a recipient', async () => {
    const c = (await t.api.post('/api/contacts', { first_name: 'Rita', email: 'rita@example.com' })).data;
    const bought = (await t.api.post('/api/gift-cards', { amount_cents: 1000, contact_id: c.id, recipient_name: 'Paul', recipient_email: 'paul@example.com' })).data;
    const got = (await t.api.post('/api/gift-cards', { amount_cents: 1000, recipient_name: 'Rita R.', recipient_email: 'rita@example.com', message: 'Für Rita' })).data;
    const out = (await t.api.get(`/api/contacts/${c.id}/privacy-export`)).data;
    expect(out.data.gift_cards).toHaveLength(1);
    expect(out.data['gift_cards (Empfänger)']).toHaveLength(1);
    expect((await t.api.post(`/api/contacts/${c.id}/erase`, { confirm: c.id })).status).toBe(200);
    expect(t.app.db.get<any>('SELECT contact_id, recipient_email FROM gift_cards WHERE id = ?', bought.id)).toEqual({ contact_id: null, recipient_email: 'paul@example.com' });
    expect(t.app.db.get<any>('SELECT recipient_name, recipient_email, message, balance_cents FROM gift_cards WHERE id = ?', got.id)).toEqual({ recipient_name: '', recipient_email: '', message: '', balance_cents: 1000 });
  });
});
