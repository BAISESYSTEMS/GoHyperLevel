import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { parseBird, parsePlivo, parseSeven, parseVonage, signBird, signPlivo, signSeven, signVonageJwt, verifyBird, verifyPlivo, verifySeven, verifyVonageJwt } from '../server/services/sms-providers.js';

const calls: { url: string; method: string; body: any; headers: Record<string, string> }[] = [];
let n = 0;
const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
const fake = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url, method: init.method ?? 'GET', body, headers });
  if (url === 'https://gateway.seven.io/api/sms') {
    if (headers['x-api-key'] !== 'SEVENKEY0123456789abcdefABCDEF') return json({ success: '900' });
    if (body.to === '+4915000000000') return json({ success: '100', messages: [{ id: null, success: false, error_text: 'Invalid recipient' }] });
    return json({ success: '100', total_price: 0.075, messages: [{ id: `77${++n}`, success: true }] });
  }
  if (url === 'https://gateway.seven.io/api/balance') return json({ amount: 12.5, currency: 'EUR' });
  if (url.startsWith('https://api.bird.com/workspaces/')) {
    if (url.endsWith('/messages')) return json({ id: `bird-${++n}`, status: 'accepted' });
    return json({ id: 'ch', name: 'SMS DE', status: 'active' });
  }
  if (url === 'https://api.nexmo.com/v1/messages') return json({ message_uuid: `aaaaaaaa-bbbb-cccc-dddd-${String(++n).padStart(12, '0')}` }, 202);
  if (url === 'https://rest.nexmo.com/account/get-balance') return json({ value: 3.21 });
  if (url.startsWith('https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/Message/')) return json({ api_id: 'x', message: 'message(s) queued', message_uuid: [`plivo-${++n}`] }, 202);
  if (url === 'https://api.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/') return json({ name: 'Malerei', cash_credits: '9.99' });
  return json({ error: `unexpected ${url}` }, 500);
};

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let contactId = '';
const providers = async () => (await t.api.get('/api/settings/channels/sms')).data;
const send = async (body = 'Ihr Termin morgen um 10 Uhr') => (await t.api.post('/api/messages', { contact_id: contactId, channel: 'sms', body })).data;
const providerId = (id: string) => t.app.db.get('SELECT provider_id FROM messages WHERE id = ?', id).provider_id;
const status = (id: string) => t.app.db.get('SELECT status FROM messages WHERE id = ?', id).status;

beforeAll(async () => {
  t = await startTestApp();
  t.app.services.channelFetch = fake;
  await t.setup();
  loc = t.api.location;
  contactId = (await t.api.post('/api/contacts', { first_name: 'Sam', phone: '+491701234567' })).data.id;
});
afterAll(() => t.close());

describe('SMS providers: signatures and parsing', () => {
  const now = Math.floor(Date.now() / 1000);
  it('seven.io, Bird, Vonage and Plivo signatures', () => {
    const o = { timestamp: String(now), nonce: 'n1', method: 'POST', url: 'https://crm.example.com/hooks/sms/seven/x/y', body: '{"a":1}' };
    expect(verifySeven({ ...o, signature: signSeven(o, 'sek') }, 'sek')).toBe(true);
    expect(verifySeven({ ...o, body: '{"a":2}', signature: signSeven(o, 'sek') }, 'sek')).toBe(false);
    expect(verifyBird(String(now), 'https://a/b', 'body', signBird(String(now), 'https://a/b', 'body', 'k'), 'k')).toBe(true);
    expect(verifyBird(String(now), 'https://a/c', 'body', signBird(String(now), 'https://a/b', 'body', 'k'), 'k')).toBe(false);
    const jwt = signVonageJwt('{"x":1}', 'vonagesignaturesecret01');
    expect(verifyVonageJwt(`Bearer ${jwt}`, 'vonagesignaturesecret01', '{"x":1}')).toBe(true);
    expect(verifyVonageJwt(`Bearer ${jwt}`, 'vonagesignaturesecret01', '{"x":2}')).toBe(false);
    expect(verifyVonageJwt(`Bearer ${jwt}`, 'othersecret000000000000', '{"x":1}')).toBe(false);
    expect(verifyPlivo('https://a.de/hook?x=1', 'nonce', signPlivo('https://a.de/hook', 'nonce', 'tok'), 'tok')).toBe(true);
    expect(verifyPlivo('https://a.de/other', 'nonce', signPlivo('https://a.de/hook', 'nonce', 'tok'), 'tok')).toBe(false);
  });

  it('turns reports and inbound SMS into one shape', () => {
    expect(parseSeven({ webhook_event: 'dlr', data: { msg_id: '77', status: 'NOTDELIVERED' } }).events[0]).toMatchObject({ providerId: '77', status: 'failed' });
    expect(parseSeven({ webhook_event: 'sms_mo', data: { id: '1', sender: '491701234567', system: '4930', text: 'Ja' } }).inbound[0]).toMatchObject({ from: '+491701234567', text: 'Ja' });
    expect(parseBird({ event: 'sms.outbound', payload: { id: 'b1', status: 'delivered' } }).events[0].status).toBe('delivered');
    expect(parseBird({ event: 'sms.inbound', payload: { id: 'b2', sender: { contact: { identifierValue: '+491701234567' } }, body: { type: 'text', text: { text: 'Hallo' } } } }).inbound[0].text).toBe('Hallo');
    expect(parseVonage({ message_uuid: 'v1', status: 'rejected', error: { title: 'Invalid' } }).events[0]).toMatchObject({ status: 'failed', reason: 'Invalid' });
    expect(parseVonage({ message_uuid: 'v2', from: '491701234567', text: 'STOP', channel: 'sms' }).inbound[0].from).toBe('+491701234567');
    expect(parsePlivo({ MessageUUID: 'p1', Status: 'delivered' }).events[0].status).toBe('delivered');
    expect(parsePlivo({ MessageUUID: 'p2', From: '491701234567', Text: 'ok', To: '4930' }).inbound[0].text).toBe('ok');
  });
});

describe('SMS providers: per sub-account sending and webhooks', () => {
  it('seven.io: send, signed delivery report, inbound SMS with STOP', async () => {
    let r = await t.api.put('/api/settings/channels/sms/seven', { api_key: 'short' });
    expect(r.status).toBe(400);
    r = await t.api.put('/api/settings/channels/sms/seven', { api_key: 'SEVENKEY0123456789abcdefABCDEF', signing_secret: 'seven-signing-secret', from: 'Malerei', activate: true });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toContain('SEVENKEY');
    expect((await providers()).active).toBe('seven');
    expect((await t.api.post('/api/settings/channels/sms/seven/test')).data.info).toBe('Guthaben 12.50 EUR');
    const m = await send();
    expect(m.status).toBe('sent');
    expect(calls.at(-1)!.body).toEqual({ to: '+491701234567', text: 'Ihr Termin morgen um 10 Uhr', from: 'Malerei' });
    const url = (await providers()).providers.seven.webhook_url as string;
    const path = new URL(url).pathname;
    const signed = (payload: unknown, secret = 'seven-signing-secret') => {
      const raw = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      return t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-nonce': 'abc', 'x-signature': signSeven({ timestamp: ts, nonce: 'abc', method: 'POST', url, body: raw }, secret) }, body: raw });
    };
    expect((await signed({ webhook_event: 'dlr', data: { msg_id: providerId(m.id), status: 'DELIVERED' } }, 'wrong')).status).toBe(401);
    expect((await signed({ webhook_event: 'dlr', data: { msg_id: providerId(m.id), status: 'DELIVERED' } })).status).toBe(200);
    expect(status(m.id)).toBe('delivered');
    const inbound = await signed({ webhook_event: 'sms_mo', data: { id: 'mo1', sender: '491701234567', system: '4930123', text: 'STOP' } });
    expect(await inbound.json()).toMatchObject({ inbound: 1 });
    expect(t.app.db.get('SELECT dnd FROM contacts WHERE id = ?', contactId).dnd).toBe(1);
    t.app.db.run('UPDATE contacts SET dnd = 0 WHERE id = ?', contactId);
    // provider errors are reported on the message
    const other = (await t.api.post('/api/contacts', { first_name: 'Falsch', phone: '+4915000000000' })).data.id;
    const bad = (await t.api.post('/api/messages', { contact_id: other, channel: 'sms', body: 'x' })).data;
    expect(bad).toMatchObject({ status: 'failed', error: 'seven.io: Invalid recipient' });
  });

  it('Bird: send with workspace/channel, signed status report', async () => {
    await t.api.put('/api/settings/channels/sms/bird', { access_key: 'bird-access-key-0123456789', signing_key: 'bird-signing', workspace_id: '11111111-2222-3333-4444-555555555555', channel_id: '66666666-7777-8888-9999-000000000000', activate: true });
    const m = await send();
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.bird.com/workspaces/11111111-2222-3333-4444-555555555555/channels/66666666-7777-8888-9999-000000000000/messages', headers: { authorization: 'AccessKey bird-access-key-0123456789' }, body: { receiver: { contacts: [{ identifierValue: '+491701234567' }] } } });
    const url = (await providers()).providers.bird.webhook_url as string;
    const raw = JSON.stringify({ service: 'channels', event: 'sms.outbound', payload: { id: providerId(m.id), status: 'delivered' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await t.api.raw(new URL(url).pathname, { method: 'POST', headers: { 'content-type': 'application/json', 'messagebird-request-timestamp': ts, 'messagebird-signature': signBird(ts, url, raw, 'bird-signing') }, body: raw });
    expect(r.status).toBe(200);
    expect(status(m.id)).toBe('delivered');
  });

  it('Vonage: Messages API send, JWT-signed status and inbound', async () => {
    await t.api.put('/api/settings/channels/sms/vonage', { api_key: 'abcd1234', api_secret: 'Secret0123456789', signature_secret: 'vonagesignaturesecret01', from: '+4930123456', activate: true });
    const m = await send();
    expect(calls.at(-1)).toMatchObject({ url: 'https://api.nexmo.com/v1/messages', headers: { authorization: `Basic ${Buffer.from('abcd1234:Secret0123456789').toString('base64')}` }, body: { message_type: 'text', channel: 'sms', to: '491701234567', from: '4930123456' } });
    const path = new URL((await providers()).providers.vonage.webhook_url).pathname;
    const post = (payload: unknown, secret = 'vonagesignaturesecret01') => {
      const raw = JSON.stringify(payload);
      return t.api.raw(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signVonageJwt(raw, secret)}` }, body: raw });
    };
    expect((await post({ message_uuid: providerId(m.id), status: 'delivered' }, 'wrongwrongwrongwrong')).status).toBe(401);
    await post({ message_uuid: providerId(m.id), status: 'delivered', channel: 'sms' });
    expect(status(m.id)).toBe('delivered');
    await post({ message_uuid: 'in-1', from: '491709998887', to: '4930123456', text: 'Neue Anfrage', channel: 'sms', message_type: 'text' });
    expect(t.app.db.get(`SELECT * FROM contacts WHERE phone = '+491709998887'`)).toBeTruthy();
  });

  it('Plivo: send with status URL, always-signed callbacks (XML answer for inbound)', async () => {
    await t.api.put('/api/settings/channels/sms/plivo', { auth_id: 'MAXXXXXXXXXXXXXXXXXX', auth_token: 'plivoAuthToken0123456789', from: '+4930123456', activate: true });
    const m = await send();
    const url = (await providers()).providers.plivo.webhook_url as string;
    expect(calls.at(-1)!.body).toMatchObject({ src: '4930123456', dst: '491701234567', url, method: 'POST' });
    const form = (fields: Record<string, string>, token = 'plivoAuthToken0123456789') =>
      t.api.raw(new URL(url).pathname, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-plivo-signature-v2-nonce': 'n42', 'x-plivo-signature-v2': signPlivo(url, 'n42', token) }, body: new URLSearchParams(fields).toString() });
    expect((await form({ MessageUUID: providerId(m.id), Status: 'delivered' }, 'wrongtoken000000000000')).status).toBe(401);
    await form({ MessageUUID: providerId(m.id), Status: 'failed', ErrorCode: '200' });
    expect(t.app.db.get('SELECT status, error FROM messages WHERE id = ?', m.id)).toEqual({ status: 'failed', error: 'Fehlercode 200' });
    const r = await form({ MessageUUID: 'in-plivo-1', From: '491707776665', To: '4930123456', Text: 'Rückruf bitte', Type: 'sms' });
    expect(r.headers.get('content-type')).toContain('xml');
    expect(t.app.db.get(`SELECT * FROM contacts WHERE phone = '+491707776665'`)).toBeTruthy();
    const cat = await t.api.get('/api/integrations/catalog');
    expect(cat.data.items.find((x: any) => x.key === 'sms_providers')).toMatchObject({ status: 'ok', detail: 'Plivo' });
  });
});
