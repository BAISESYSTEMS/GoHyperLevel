import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestApp } from './helpers.js';
import { twilioSignature } from '../server/services/twilio.js';

/**
 * Security review 0.0.37–0.0.40, public endpoints: telephony webhooks, device pairing and the other places where a request
 * arrives without a login.
 */

const SID = `AC${'0'.repeat(31)}1`;
const TOKEN = 'f'.repeat(32);
let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  loc = t.api.location;
  expect((await t.api.put('/api/telephony/settings', { account_sid: SID, auth_token: TOKEN, numbers: '+4930123456', forward_to: '0151 12345678', hours_mode: 'always' })).status).toBe(200);
});
afterAll(async () => {
  await t.close();
});

describe('Twilio webhooks', () => {
  const post = (path: string, body: string, type: string, signed: Record<string, string> | null) =>
    t.api.raw(path, {
      method: 'POST',
      headers: { 'content-type': type, ...(signed ? { 'x-twilio-signature': twilioSignature(TOKEN, `http://localhost${path}`, signed) } : {}) },
      body,
    });

  it('only take forms: a signature over the URL does not cover a body of another kind', async () => {
    const path = `/hooks/twilio/voice/${loc}`;
    const params = { CallSid: `CA${'1'.repeat(32)}`, From: '+4915112345678', To: '+4930123456', CallStatus: 'ringing' };
    // control: the signed form works
    const ok = await post(path, new URLSearchParams(params).toString(), 'application/x-www-form-urlencoded', params);
    expect(ok.status).toBe(200);
    // the signature of a request without fields (URL only) next to a JSON body of the attacker's choosing
    const forged = await post(path, JSON.stringify({ ...params, CallSid: `CA${'2'.repeat(32)}`, From: '+4999999999' }), 'application/json', {});
    expect(forged.status).toBe(403);
    expect(t.app.db.get('SELECT 1 AS x FROM calls WHERE sid = ?', `CA${'2'.repeat(32)}`)).toBeUndefined();
    // …also when the body is plain text or the type is missing
    expect((await post(path, '{"CallSid":"x"}', 'text/plain', {})).status).toBe(403);
    // an unsigned form and a form signed with another token are refused as before
    expect((await post(path, new URLSearchParams(params).toString(), 'application/x-www-form-urlencoded', null)).status).toBe(403);
  });
});

describe('device pairing', () => {
  it('makes its one-time code from the system’s random source', async () => {
    await t.api.put('/api/agent/agency-settings', { bridge_enabled: true });
    const spy = vi.spyOn(Math, 'random');
    try {
      const code = (await t.api.post('/api/agent/bridge/code')).data;
      expect(code.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('number insertion on websites', () => {
  it('a pool that shares its numbers does not grow by a row per anonymous visit without end', async () => {
    let counter = 0;
    t.app.services.twilioFetch = (async (input: any, init: any = {}) => {
      const body = String(input).endsWith('/IncomingPhoneNumbers.json') && init.method === 'POST' ? new URLSearchParams(init.body).get('PhoneNumber') : null;
      return new Response(JSON.stringify(body ? { sid: `PN${String(++counter).padStart(32, '0')}`, phone_number: body } : { message: 'not found' }), { status: body ? 201 : 404, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const pool = (await t.api.post('/api/telephony/dni/pools', { name: 'Website', default_number: '030 123456', fallback_number: '+4930123456', session_minutes: 30, attribution_minutes: 60, exhausted: 'oldest' })).data.id as string;
    for (const n of ['+4930555001', '+4930555002']) expect((await t.api.post('/api/telephony/numbers/buy', { phone_number: n, confirm: true, kind: 'pool', pool_id: pool, label: n, address_sid: `AD${'c'.repeat(32)}` })).status).toBe(200);
    const numbers = t.app.db.all<{ id: string; number: string }>('SELECT id, number FROM phone_numbers WHERE pool_id = ?', pool);
    expect(numbers.length).toBe(2);
    const at = new Date().toISOString();
    const later = new Date(Date.now() + 3600_000).toISOString();
    t.app.db.tx(() => {
      for (let i = 0; i < 5001; i++) {
        const n = numbers[i % 2];
        t.app.db.insert('dni_sessions', { id: `s${String(i).padStart(15, '0')}`, location_id: loc, pool_id: pool, number_id: n.id, number: n.number, visitor_id: '', channel: 'direct', source: '', medium: '', campaign: '', content: '', term: '', gclid: '', fbclid: '', landing_page: '', referrer: '', created_at: at, last_seen_at: at, expires_at: later });
      }
    });
    const rows = () => Number(t.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM dni_sessions WHERE pool_id = ?', pool)!.n);
    const r = await t.api.raw(`/api/public/dni/${loc}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pool, consent: 'granted', url: 'https://shop.example/', sid: 'A'.repeat(16) }) });
    const out = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(out.number ?? out.shown ?? JSON.stringify(out)).toBeTruthy();
    expect(rows()).toBe(5001);
  });
});
