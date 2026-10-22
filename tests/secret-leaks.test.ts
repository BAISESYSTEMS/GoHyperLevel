import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealWith } from '../server/core/secrets.js';
import type { Route } from '../server/core/http.js';
import { startTestApp } from './helpers.js';
import { client, seedLocation, tableColumns } from './security-fixtures.js';

/**
 * Stored credentials never go back to the browser: every credential the app keeps (sub-account SMTP/SMS,
 * AI, Google, Meta, Twilio, OAuth apps, Supabase, Video-Studio, IMAP, Stripe, HubSpot, ads) is set to a value
 * containing SECRET, then every GET route (agency, sub-account, user) is called as the agency admin with every
 * id in the database. No response may contain a secret – nor a sealed value (v1:/v2:…).
 */

const S = 'SECRETVAL';
let t: Awaited<ReturnType<typeof startTestApp>>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`offline in tests: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  t = await startTestApp();
  await t.setup();
  const L = t.api.location;
  const admin = client(t.base, { cookie: t.api.cookie, 'x-pghl': '1', 'x-location-id': L });
  await seedLocation(admin, L, 'Secrets');
  const set = async (m: string, path: string, body: any) => {
    const r = await admin(m, path, body);
    expect(r.status, `${m} ${path}: ${r.text}`).toBe(200);
  };
  await set('PATCH', '/api/location', { settings: { email: { provider: 'smtp', host: 'smtp.example.com', user: 'u', pass: `${S}-smtp` }, sms: { provider: 'twilio', accountSid: 'AC123', authToken: `${S}-sms`, apiKey: `${S}-smskey` } } });
  await set('PUT', '/api/ai/settings', { api_key: `sk-ant-${S}-anthropic-0123456789` });
  await set('PUT', '/api/forms/captcha', { site_key: '0x4AAAAAAAsitekey0123456', secret_key: `${S}-turnstile0123` });
  await set('PUT', '/api/google-reviews/settings', { api_key: `AIza${S}0123456789abcdef` });
  await set('PUT', '/api/settings/meta', { wa_token: `${S}metatoken0123456789`, app_secret: `${S}appsecret0123456` });
  await set('PUT', '/api/telephony/settings', { auth_token: `${S}twilio0123456789` });
  await set('PUT', '/api/agency/oauth', { google: { client_id: '1234567890-abc.apps.googleusercontent.com', client_secret: `${S}-oauth` } });
  await set('PATCH', '/api/agency/supabase', { url: 'https://x.supabase.co', service_key: `${S}-supabase`, enabled: false });
  await set('PATCH', '/api/agency/video-studio', { url: 'https://openshorts.invalid', api_key: `${S}-openshorts` });
  // Wissensgedächtnis: the agency's Cognee login and a login of its own for the sub-account (the server is offline in tests).
  t.app.services.cogneeFetch = async () => {
    throw new Error('offline in tests');
  };
  t.app.services.cogneeSleep = async () => undefined;
  await set('PUT', '/api/agency/cognee', { base_url: 'http://cognee:8000', email: 'gohigh@example.com', password: `${S}-cognee`, allow_private: true });
  await set('PUT', `/api/agency/cognee/locations/${L}/account`, { auth_mode: 'api_key', api_key: `${S}-cogneekey` });
  await set('POST', '/api/agency/mail-accounts', { name: 'IMAP', host: 'imap.example.com', username: 'imap@example.com', password: `${S}-imap` });
  // Integrations whose setup calls the provider: stored the way the module stores them.
  const now = new Date().toISOString();
  t.app.db.run(`INSERT INTO stripe_accounts (location_id, secret_key, webhook_secret, key_hint, updated_at) VALUES (?, ?, ?, '…1234', ?)`, L, sealWith(t.app.config, `${S}-stripe`), sealWith(t.app.config, `${S}-whsec`), now);
  t.app.db.run(`INSERT INTO hubspot_connections (location_id, token_sealed, token_hint, created_at, updated_at) VALUES (?, ?, '…abcd', ?, ?)`, L, sealWith(t.app.config, `${S}-hubspot`), now, now);
  t.app.db.run(`INSERT INTO umzug_connections (id, location_id, source, label, account, secret_sealed, hint, meta, created_at, updated_at) VALUES ('umconn00000000000000', ?, 'mailchimp', 'Muster', 'us12:muster', ?, '…8a13', '{}', ?, ?)`, L, sealWith(t.app.config, JSON.stringify({ api_key: `${S}-mailchimp-us12` })), now, now);
  t.app.db.run(`INSERT INTO ads_accounts (location_id, platform, config, secrets, updated_at) VALUES (?, 'meta', '{}', ?, ?)`, L, sealWith(t.app.config, JSON.stringify({ access_token: `${S}-ads` })), now);
  t.app.db.run(`INSERT INTO books_sync_settings (location_id, provider, enabled, secret_sealed, hint, options, updated_at) VALUES (?, 'lexware', 0, ?, '…1234', '{}', ?)`, L, sealWith(t.app.config, `${S}-lexware-key`), now);
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await t?.close();
});

describe('secrets never reach the browser', () => {
  it('no GET response contains a stored credential or a sealed value', { timeout: 300_000 }, async () => {
    const L = t.api.location;
    const admin = client(t.base, { cookie: t.api.cookie, 'x-location-id': L });
    // Every id/key of every table, one or two per table.
    const values: string[] = [];
    for (const [table, cols] of tableColumns(t.app)) {
      const c = cols.includes('id') ? 'id' : cols.includes('key') ? 'key' : '';
      if (!c) continue;
      for (const r of t.app.db.all(`SELECT "${c}" AS v FROM "${table}" LIMIT 2`)) if (typeof r.v === 'string') values.push(r.v);
    }
    values.push('meta', 'google', 'microsoft', 'whatsapp');
    // The database backup is a full copy by design (admin session only; secrets in it stay sealed).
    const routes = ((t.app.router as any).routes as Route[]).filter((r) => r.method === 'GET' && r.auth !== 'public' && !/^\/api\/admin\/backups?(\/|$)/.test(r.pattern));
    const leaks: string[] = [];
    let calls = 0;
    for (const r of routes) {
      const slots = r.parts.filter((p) => p.startsWith(':')).length;
      const n = slots ? values.length : 1;
      for (let v = 0; v < n; v++) {
        const path = '/' + r.parts.map((p, i) => (p.startsWith(':') ? encodeURIComponent(values[(v + i) % values.length]) : p)).join('/');
        const res = await admin('GET', path);
        calls++;
        if (res.text.includes(S) || /v[12]:[0-9a-f]{0,8}:?[A-Za-z0-9+/=]{16}:[A-Za-z0-9+/=]{24}:/.test(res.text)) leaks.push(`${r.pattern} (${path}) → ${res.status}: …${res.text.slice(Math.max(0, res.text.search(new RegExp(`${S}|v[12]:`)) - 60), res.text.search(new RegExp(`${S}|v[12]:`)) + 40)}`);
      }
    }
    expect(calls).toBeGreaterThan(1000);
    expect([...new Set(leaks)]).toEqual([]);
  });
});
