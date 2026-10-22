import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { installOutboundGuard, uninstallOutboundGuard } from '../server/services/outbound-guard.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import { signBody } from '../server/services/meta.js';
import { twilioSignature } from '../server/services/twilio.js';

/**
 * Second bug sweep, inbound webhooks: a delivery the sender repeats (timeouts, retries, a replayed request) is taken once, a wrong
 * signature or key is refused without touching data, a malformed body is a 400 – for Stripe, Twilio (voice and SMS), Meta, the SMS
 * and e-mail inbound URLs, the support mailbox and both workflow webhooks.
 */

type T = Awaited<ReturnType<typeof startTestApp>>;
let t: T;
let loc = '';
const WHSEC = 'whsec_testSigningSecret0000000';
const APP_SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // oss-check: allow (fake test secret)
const TW_SID = `AC${'0'.repeat(31)}1`;
const TW_TOKEN = 'f'.repeat(32);

beforeAll(async () => {
  installOutboundGuard();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  setStripeFetch((async () => json({ id: 'acct_1', settings: { dashboard: { display_name: 'Test' } } })) as any);
  t.app.services.metaFetch = (async () => json({})) as any;
  t.app.services.twilioFetch = (async () => json({ incoming_phone_numbers: [] })) as any;
  expect((await t.api.put('/api/stripe', { secret_key: 'sk_test_51FakeKeyForTests000abcd', webhook_secret: WHSEC })).status).toBe(200);
  expect((await t.api.put('/api/settings/meta', { wa_phone_number_id: '1111', wa_business_account_id: '2222', wa_token: `EAAG${'x'.repeat(40)}`, app_secret: APP_SECRET })).status).toBe(200);
  expect((await t.api.put('/api/telephony/settings', { account_sid: TW_SID, auth_token: TW_TOKEN, numbers: '+4930123456', forward_to: '0151 12345678', hours_mode: 'always' })).status).toBe(200);
});
afterAll(async () => {
  setStripeFetch();
  vi.restoreAllMocks();
  await t.close();
  uninstallOutboundGuard();
});

const n = (sql: string, ...p: unknown[]) => Number(t.app.db.get(`SELECT COUNT(*) n FROM ${sql}`, ...(p as any[]))!.n);
const post = async (path: string, body: string, headers: Record<string, string>) => {
  const r = await t.api.raw(path, { method: 'POST', headers, body });
  const text = await r.text();
  await t.app.events.flush();
  return { status: r.status, text };
};
const asJson = (path: string, b: unknown, h: Record<string, string> = {}) => post(path, typeof b === 'string' ? b : JSON.stringify(b), { 'content-type': 'application/json', ...h });
const asForm = (path: string, b: Record<string, string>, h: Record<string, string> = {}) => post(path, new URLSearchParams(b).toString(), { 'content-type': 'application/x-www-form-urlencoded', ...h });
const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;
/** Only these tables may change when a request is refused: the hit counter of a generic webhook. */
const tablesTouched = async (fn: () => Promise<unknown>) => {
  const before = Object.fromEntries(['contacts', 'messages', 'conversations', 'workflow_runs', 'tickets', 'stripe_events', 'calls'].map((x) => [x, n(x)]));
  await fn();
  return Object.keys(before).filter((x) => n(x) !== before[x]);
};

describe('SMS and e-mail inbound URLs', () => {
  it('take a repeated Twilio or gateway SMS once and refuse bodies without sender and text', async () => {
    const sms = pathOf((await t.api.get('/api/settings/inbound')).data.sms);
    const tw = { MessageSid: `SM${'a'.repeat(32)}`, From: '+4915112345678', To: '+4930123456', Body: 'Hallo' };
    expect((await asForm(sms, tw)).status).toBe(200);
    expect((await asForm(sms, tw)).text).toBe('<Response></Response>');
    expect(n(`messages WHERE body = 'Hallo' AND direction = 'in'`)).toBe(1);
    const gw = { event: 'sms:received', id: 'evt-1', payload: { messageId: 'm-77', message: 'Hallo Gateway', phoneNumber: '+4915199999999' } };
    await asJson(sms, gw);
    await asJson(sms, gw);
    expect(n(`messages WHERE body = 'Hallo Gateway'`)).toBe(1);
    // without a message id every post counts (nothing to recognise a resend by)
    await asJson(sms, { from: '+4915100000001', body: 'ohne id' });
    await asJson(sms, { from: '+4915100000001', body: 'ohne id' });
    expect(n(`messages WHERE body = 'ohne id'`)).toBe(2);
    expect(await tablesTouched(async () => expect((await asJson(sms, { from: { a: 1 }, body: ['x'] })).status).toBe(400))).toEqual([]);
    expect(await tablesTouched(async () => expect((await asForm(sms.replace(/key=[^&]+/, 'key=falsch'), tw)).status).toBe(401))).toEqual([]);
    expect((await asJson(sms, '{"from": ')).status).toBe(400);
  });

  it('take a repeated forwarded mail (same Message-Id) once – inbox and support mailbox', async () => {
    const email = pathOf((await t.api.get('/api/settings/inbound')).data.email);
    const mail = { from: 'Erika <erika@example.com>', subject: 'Frage', text: 'Hallo per Mail', 'Message-Id': '<abc@example.com>' };
    await asJson(email, mail);
    expect((await asJson(email, mail)).text).toContain('"duplicate":true');
    expect(n(`messages WHERE body = 'Hallo per Mail'`)).toBe(1);
    const support = pathOf((await t.api.get('/api/helpdesk/settings')).data.support_hook);
    const smail = { from: 'Kunde <kunde@example.com>', subject: 'Hilfe', text: 'Bitte helfen', headers: { 'Message-ID': '<sup1@example.com>' } };
    expect((await asJson(support, smail)).status).toBe(200);
    const events = n('ticket_events');
    expect((await asJson(support, smail)).text).toContain('"duplicate":true');
    expect(n(`messages WHERE body = 'Bitte helfen'`)).toBe(1);
    expect(n('tickets')).toBe(1);
    expect(n('ticket_events')).toBe(events);
    expect((await asJson(support, { from: { a: 1 }, text: ['x'] })).status).toBe(400);
  });
});

describe('workflow webhooks', () => {
  it('generic inbound URL: a repeated delivery id starts the workflow once, a wrong signature changes nothing', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Eingang', trigger: { type: 'webhook.received', config: {} }, steps: [{ type: 'add_tag', tags: ['in'] }], settings: { allow_reentry: true } })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const path = new URL((await t.api.get(`/api/inbound-webhooks/${wf.id}`)).data.url).pathname;
    const body = { email: 'webhook@example.com', first_name: 'Web' };
    expect((await asJson(path, body, { 'webhook-id': 'msg_1' })).status).toBe(200);
    expect((await asJson(path, body, { 'webhook-id': 'msg_1' })).text).toContain('"duplicate":true');
    expect(n('workflow_runs WHERE workflow_id = ?', wf.id)).toBe(1);
    await asJson(path, body, { 'webhook-id': 'msg_2' });
    expect(n('workflow_runs WHERE workflow_id = ?', wf.id)).toBe(2);
    expect((await asJson(path, '{"x":')).status).toBe(400);
    const secret = (await t.api.post(`/api/inbound-webhooks/${wf.id}/secret`, {})).data.secret;
    const raw = JSON.stringify({ email: 'signiert@example.com' });
    expect(await tablesTouched(async () => expect((await asJson(path, raw, { 'x-pghl-hmac': `sha256=${'0'.repeat(64)}` })).status).toBe(401))).toEqual([]);
    const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    expect((await asJson(path, raw, { 'x-pghl-hmac': sig, 'idempotency-key': 'k-9' })).status).toBe(200);
    expect((await asJson(path, raw, { 'x-pghl-hmac': sig, 'idempotency-key': 'k-9' })).text).toContain('"duplicate":true');
  });

  it('classic webhook trigger: no empty contacts from lists or texts, a repeated delivery id runs once', async () => {
    const wf = (await t.api.post('/api/workflows', { name: 'Hook', trigger: { type: 'webhook', config: {} }, steps: [{ type: 'add_tag', tags: ['hook'] }], settings: { allow_reentry: true } })).data;
    await t.api.patch(`/api/workflows/${wf.id}`, { status: 'active' });
    const path = pathOf((await t.api.get(`/api/workflows/${wf.id}`)).data.webhook_url);
    for (const bad of [[{ email: 'liste@example.com' }], { contact: 'text' }, {}, { tags: ['nur'] }]) {
      expect(await tablesTouched(async () => expect((await asJson(path, bad)).status, JSON.stringify(bad)).toBe(400))).toEqual([]);
    }
    expect((await asJson(path, { email: 'hook@example.com' }, { 'x-github-delivery': 'd-1' })).status).toBe(200);
    expect((await asJson(path, { email: 'hook@example.com' }, { 'x-github-delivery': 'd-1' })).text).toContain('"duplicate":true');
    expect(n('workflow_runs WHERE workflow_id = ?', wf.id)).toBe(1);
    expect((await asJson(path, { contact: { first_name: 'Nur Name' } })).status).toBe(200);
  });
});

describe('provider webhooks (already idempotent – kept that way)', () => {
  it('Stripe: a replayed event is a duplicate, a wrong signature or broken JSON changes nothing', async () => {
    const ev = JSON.stringify({ id: 'evt_dup1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_1', object: 'checkout.session', metadata: {}, amount_total: 1000, currency: 'eur', payment_status: 'paid' } } });
    const path = `/hooks/stripe/${loc}`;
    expect((await asJson(path, ev, { 'stripe-signature': signStripePayload(ev, WHSEC) })).status).toBe(200);
    expect((await asJson(path, ev, { 'stripe-signature': signStripePayload(ev, WHSEC) })).text).toContain('"duplicate":true');
    expect(n('stripe_events')).toBe(1);
    expect(await tablesTouched(async () => expect((await asJson(path, ev.replace('dup1', 'dup2'), { 'stripe-signature': signStripePayload(ev, 'whsec_other') })).status).toBe(400))).toEqual([]);
    expect((await asJson(path, '{"id":', { 'stripe-signature': signStripePayload('{"id":', WHSEC) })).status).toBe(400);
    expect((await asJson(path, '[1]', { 'stripe-signature': signStripePayload('[1]', WHSEC) })).status).toBe(400);
  });

  it('Meta: a replayed message is stored once, a wrong signature is a 401', async () => {
    const wa = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2222', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1111' }, contacts: [{ profile: { name: 'Anna' }, wa_id: '4917011111111' }], messages: [{ from: '4917011111111', id: 'wamid.1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hi Meta' } }] } }] }] });
    const path = `/hooks/meta/${loc}`;
    await asJson(path, wa, { 'x-hub-signature-256': signBody(wa, APP_SECRET) });
    await asJson(path, wa, { 'x-hub-signature-256': signBody(wa, APP_SECRET) });
    expect(n(`messages WHERE body = 'Hi Meta'`)).toBe(1);
    expect(await tablesTouched(async () => expect((await asJson(path, wa.replace('wamid.1', 'wamid.2'), { 'x-hub-signature-256': signBody(wa, 'nope') })).status).toBe(401))).toEqual([]);
    expect((await asJson(path, '{"o', { 'x-hub-signature-256': signBody('{"o', APP_SECRET) })).status).toBe(400);
  });

  it('Twilio voice: a repeated call or status callback counts once, unsigned or JSON requests are refused', async () => {
    const hook = (name: string, params: Record<string, string>, sign = true) => {
      const path = `/hooks/twilio/${name}/${loc}`;
      return asForm(path, params, sign ? { 'x-twilio-signature': twilioSignature(TW_TOKEN, `http://localhost${path}`, params) } : {});
    };
    const call = { CallSid: `CA${'1'.repeat(32)}`, From: '+4915112345678', To: '+4930123456' };
    await hook('voice', call);
    await hook('voice', call);
    expect(n('calls WHERE sid = ?', call.CallSid)).toBe(1);
    const events: string[] = [];
    t.app.events.on('call.completed', () => void events.push('completed'));
    t.app.events.on('call.missed', () => void events.push('missed'));
    await hook('voice-status', { ...call, CallStatus: 'completed', CallDuration: '30' });
    await hook('voice-status', { ...call, CallStatus: 'completed', CallDuration: '30' });
    expect(events).toHaveLength(1);
    expect(await tablesTouched(async () => expect((await hook('voice', { ...call, CallSid: `CA${'2'.repeat(32)}` }, false)).status).toBe(403))).toEqual([]);
    expect((await asJson(`/hooks/twilio/voice/${loc}`, { CallSid: 'x' }, { 'x-twilio-signature': 'abc' })).status).toBe(403);
  });
});
