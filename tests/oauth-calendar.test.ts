import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { G_CLIENT, MS_CLIENT, createFake } from './oauth-fakes.js';
import type { AppEvent } from '../server/core/events.js';
import { addDaysYmd, weekdayKey, ymdInTz, zonedToUtc } from '../server/core/time.js';
import { authorizeUrl, idTokenClaims, missingScopes, pkceChallenge, pkcePair, scopesFor, signState, verifyState } from '../server/services/oauth.js';
import { fromGoogleEvent, fromGraphEvent, googleEventId, graphTransactionId, parseGraphDate, toGoogleEvent, toGraphEvent } from '../server/services/calendar-providers.js';
import { appointmentHash, backoffMs } from '../server/modules/calendar-connect.js';
import { openSecret } from '../server/modules/mail-sync.js';

describe('OAuth helpers', () => {
  it('computes the PKCE S256 challenge (RFC 7636 example)', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const p = pkcePair();
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkceChallenge(p.verifier)).toBe(p.challenge);
  });

  it('signs the state, binds it to the session and lets it expire', () => {
    const payload = { n: 'nonce1', p: 'google' as const, k: 'calendar' as const, u: 'user1', s: 'sessionhash', e: Date.now() + 60_000 };
    const st = signState('secret', payload);
    expect(verifyState('secret', st, { sessionHash: 'sessionhash' })).toMatchObject({ n: 'nonce1', u: 'user1' });
    expect(() => verifyState('other-secret', st, { sessionHash: 'sessionhash' })).toThrow(/state passt nicht/);
    const [data, mac] = st.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, u: 'admin' })).toString('base64url');
    expect(() => verifyState('secret', `${forged}.${mac}`, { sessionHash: 'sessionhash' })).toThrow(/state passt nicht/);
    expect(() => verifyState('secret', `${data}.${mac}`, { sessionHash: 'another-session' })).toThrow(/anderen Sitzung/);
    expect(() => verifyState('secret', st, { sessionHash: 'sessionhash', now: Date.now() + 120_000 })).toThrow(/zu lange/);
    expect(() => verifyState('secret', '', { sessionHash: 'x' })).toThrow(/state fehlt/);
  });

  it('builds authorize URLs with minimal scopes and checks granted scopes', () => {
    const g = new URL(authorizeUrl('google', G_CLIENT, { redirectUri: 'https://crm.example.com/oauth/google/callback', scopes: scopesFor('google', 'calendar'), state: 's', challenge: 'c' }));
    expect(g.origin + g.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(g.searchParams)).toMatchObject({ client_id: G_CLIENT.client_id, response_type: 'code', code_challenge: 'c', code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state: 's' });
    expect(g.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly');
    expect(scopesFor('google', 'business')).toContain('https://www.googleapis.com/auth/business.manage');
    const m = new URL(authorizeUrl('microsoft', { ...MS_CLIENT, tenant: 'contoso.onmicrosoft.com' }, { redirectUri: 'https://x/oauth/microsoft/callback', scopes: scopesFor('microsoft', 'calendar'), state: 's', challenge: 'c' }));
    expect(m.href).toContain('https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize');
    expect(m.searchParams.get('scope')).toBe('openid email offline_access Calendars.ReadWrite');
    expect(() => scopesFor('microsoft', 'business')).toThrow();
    expect(missingScopes('google', 'calendar', 'openid https://www.googleapis.com/auth/calendar.readonly')).toEqual(['https://www.googleapis.com/auth/calendar.events']);
    expect(missingScopes('microsoft', 'calendar', 'https://graph.microsoft.com/Calendars.ReadWrite openid')).toEqual([]);
    expect(idTokenClaims('x.' + Buffer.from(JSON.stringify({ preferred_username: 'a@b.de', name: 'A' })).toString('base64url') + '.y')).toMatchObject({ email: 'a@b.de', name: 'A' });
    expect(idTokenClaims('garbage').email).toBe('');
  });

  it('maps appointments to Google and Graph events and back', () => {
    const input = { title: 'Erstgespräch – Max', description: 'E-Mail: max@x.de', location: 'https://meet.jit.si/x', start: '2026-10-07T12:00:00.000Z', end: '2026-10-07T12:30:00.000Z', appointmentId: 'appt1', key: 'conn1:appt1' };
    const id = googleEventId(input.key);
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(googleEventId(input.key)).toBe(id);
    expect(googleEventId('conn2:appt1')).not.toBe(id);
    expect(toGoogleEvent(input)).toMatchObject({ id, summary: input.title, start: { dateTime: input.start }, end: { dateTime: input.end }, extendedProperties: { private: { pghl_appt: 'appt1' } } });
    expect(toGoogleEvent(input, false).id).toBeUndefined();
    expect(fromGoogleEvent({ id, status: 'confirmed', start: { dateTime: '2026-10-07T14:00:00+02:00' }, end: { dateTime: '2026-10-07T14:30:00+02:00' }, updated: '2026-10-04T08:00:00.000Z', etag: '"1"', extendedProperties: { private: { pghl_appt: 'appt1' } } })).toEqual({
      id,
      cancelled: false,
      start: '2026-10-07T12:00:00.000Z',
      end: '2026-10-07T12:30:00.000Z',
      updated: '2026-10-04T08:00:00.000Z',
      etag: '"1"',
      appointmentId: 'appt1',
    });
    expect(fromGoogleEvent({ id: 'x', status: 'cancelled' }).cancelled).toBe(true);
    const graph = toGraphEvent(input);
    expect(graph).toMatchObject({ subject: input.title, start: { dateTime: '2026-10-07T12:00:00', timeZone: 'UTC' }, showAs: 'busy', transactionId: graphTransactionId(input.key) });
    expect(graph.transactionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(toGraphEvent(input, false).transactionId).toBeUndefined();
    expect(parseGraphDate({ dateTime: '2026-10-07T12:00:00.0000000', timeZone: 'UTC' })).toBe('2026-10-07T12:00:00.000Z');
    expect(parseGraphDate({ dateTime: '2026-10-07T14:00:00.0000000', timeZone: 'Europe/Berlin' })).toBe('2026-10-07T12:00:00.000Z');
    expect(fromGraphEvent({ id: 'e1', '@removed': { reason: 'deleted' } })).toMatchObject({ id: 'e1', cancelled: true });
    expect(fromGraphEvent({ id: 'e2', start: { dateTime: '2026-10-07T12:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-07T12:30:00.0000000', timeZone: 'UTC' }, '@odata.etag': 'W/"5"', lastModifiedDateTime: '2026-10-04T08:00:00Z' })).toMatchObject({ start: '2026-10-07T12:00:00.000Z', etag: 'W/"5"', cancelled: false });
  });

  it('retries with growing backoff and hashes only what is synced', () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(30)).toBe(6 * 3600_000);
    const a = { title: 'T', start_at: 's', end_at: 'e', status: 'confirmed', notes: '' };
    expect(appointmentHash({ ...a, status: 'showed' })).toBe(appointmentHash(a));
    expect(appointmentHash({ ...a, status: 'cancelled' })).not.toBe(appointmentHash(a));
    expect(appointmentHash({ ...a, start_at: 's2' })).not.toBe(appointmentHash(a));
  });
});

// --- end to end with fake Google and Microsoft -----------------------------------------------

let t: Awaited<ReturnType<typeof startTestApp>>;
const fake = createFake();
const events: AppEvent[] = [];
let cal: any;
let day = '';
const at = (hm: string, d = day) => zonedToUtc(d, hm, 'Europe/Berlin').toISOString();

beforeAll(async () => {
  t = await startTestApp();
  await t.setup();
  t.app.services.oauthFetch = fake.fetch;
  t.app.events.on('*', (e) => void events.push(e));
  cal = (await t.api.post('/api/calendars', { name: 'Erstgespräch', duration: 30, interval: 30, min_notice: 1 })).data;
  // A Tuesday at least four days ahead (the default availability is Mon–Fri 9–17).
  day = addDaysYmd(ymdInTz(new Date(), 'Europe/Berlin'), 4);
  while (weekdayKey(day) !== 'tue') day = addDaysYmd(day, 1);
});
afterAll(async () => {
  await t.close();
});

const slots = async () => (await t.api.get(`/api/public/calendars/${cal.slug}/slots?from=${day}&days=1`)).data.days[0].slots as string[];
const book = (hm: string, email: string) => t.api.post(`/api/public/calendars/${cal.slug}/book`, { start: at(hm), email, first_name: email.split('@')[0] });
const conn = async (provider = 'google') => (await t.api.get('/api/me/calendar-connections')).data.connections.find((c: any) => c.provider === provider);
const sync = async (id: string) => (await t.api.post(`/api/me/calendar-connections/${id}/sync`)).data;
const mapOf = (apptId: string) => t.app.db.get('SELECT * FROM oauth_event_map WHERE appointment_id = ?', apptId);
const calls = (re: RegExp, method?: string) => fake.reqs.filter((r) => re.test(r.url) && (!method || r.method === method));

describe('agency OAuth apps', () => {
  it('stores client secrets sealed and never returns them', async () => {
    const before = (await t.api.get('/api/agency/oauth')).data;
    expect(before.google).toMatchObject({ configured: false, secret_set: false, redirect_uris: ['http://localhost/oauth/google/callback'] });
    expect((await t.api.put('/api/agency/oauth', { microsoft: { client_id: 'not-a-guid' } })).status).toBe(400);
    const r = await t.api.put('/api/agency/oauth', { google: G_CLIENT, microsoft: MS_CLIENT });
    expect(r.status).toBe(200);
    expect(r.data.google).toMatchObject({ client_id: G_CLIENT.client_id, client_secret: '••••••', secret_set: true, configured: true });
    expect(r.data.microsoft).toMatchObject({ client_id: MS_CLIENT.client_id, configured: true, tenant: 'common', redirect_uris: ['http://localhost/oauth/microsoft/callback'] });
    expect(JSON.stringify(r.data)).not.toContain(G_CLIENT.client_secret);
    const stored = JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'oauth_clients'`)!.value);
    expect(stored.google.client_secret).toMatch(/^v1:/);
    // Saving again with the mask keeps the secret.
    await t.api.put('/api/agency/oauth', { google: { client_id: G_CLIENT.client_id, client_secret: '••••••' } });
    expect(JSON.parse(t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'oauth_clients'`)!.value).google.client_secret).toBe(stored.google.client_secret);
    expect((await t.api.get('/api/oauth/providers')).data).toEqual({ google: true, microsoft: true });
  });

  it('falls back to environment variables', async () => {
    const saved = t.app.db.get(`SELECT value FROM agency_settings WHERE key = 'oauth_clients'`)!.value;
    t.app.db.run(`DELETE FROM agency_settings WHERE key = 'oauth_clients'`);
    process.env.PGHL_MS_CLIENT_ID = MS_CLIENT.client_id;
    process.env.PGHL_MS_CLIENT_SECRET = 'from-env';
    try {
      const r = (await t.api.get('/api/agency/oauth')).data;
      expect(r.microsoft).toMatchObject({ configured: true, from_env: true, client_secret: '••••••' });
      expect(r.google.configured).toBe(false);
    } finally {
      delete process.env.PGHL_MS_CLIENT_ID;
      delete process.env.PGHL_MS_CLIENT_SECRET;
      t.app.db.run(`INSERT INTO agency_settings (key, value) VALUES ('oauth_clients', ?)`, saved);
    }
  });
});

describe('connecting Google Calendar (PKCE + state)', () => {
  let flow: { code: string; state: string; redirect: string };

  it('starts the authorization with PKCE and a signed state', async () => {
    const key = (await t.api.post('/api/api-keys', { name: 'x' })).data.key;
    expect((await t.api.post('/api/oauth/start', { provider: 'google' }, { authorization: `Bearer ${key}`, cookie: '' })).status).toBe(403);
    const r = await t.api.post('/api/oauth/start', { provider: 'google', purpose: 'calendar' });
    expect(r.status).toBe(200);
    const u = new URL(r.data.url);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/oauth/google/callback');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    flow = fake.authorize(r.data.url);
    // The verifier stays on the server.
    expect(r.data.url).not.toContain(t.app.db.get('SELECT verifier FROM oauth_pending')!.verifier);
  });

  it('refuses a tampered or foreign state', async () => {
    const bad = await t.api.get(`/oauth/google/callback?code=${flow.code}&state=${flow.state.slice(0, -2)}xx`);
    expect(bad.status).toBe(400);
    expect(bad.data).toContain('state passt nicht');
    // Same state from another browser session (not signed in there).
    const r = await t.api.raw(`/oauth/google/callback?code=${flow.code}&state=${flow.state}`);
    expect(r.status).toBe(401);
    // Wrong provider in the path.
    expect((await t.api.get(`/oauth/microsoft/callback?code=${flow.code}&state=${flow.state}`)).status).toBe(400);
  });

  it('exchanges the code with the verifier and stores sealed tokens', async () => {
    const r = await t.api.get(`/oauth/google/callback?code=${flow.code}&state=${encodeURIComponent(flow.state)}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/app\/settings\/account\?oauth=ok&provider=google/);
    const tokenCall = calls(/oauth2\.googleapis\.com\/token/)[0];
    expect(tokenCall.body).toMatchObject({ grant_type: 'authorization_code', code: flow.code, redirect_uri: 'http://localhost/oauth/google/callback' });
    expect(tokenCall.body.code_verifier).toBeTruthy();
    const row = t.app.db.get(`SELECT * FROM oauth_connections WHERE provider = 'google' AND purpose = 'calendar'`)!;
    expect(row.access_token).toMatch(/^v1:/);
    expect(row.refresh_token).toMatch(/^v1:/);
    expect(row.account_email).toBe('owner@example.com');
    // The state is single-use.
    const again = await t.api.get(`/oauth/google/callback?code=${flow.code}&state=${encodeURIComponent(flow.state)}`);
    expect(again.headers.get('location')).toContain('oauth=error');
    const list = (await t.api.get('/api/me/calendar-connections')).data;
    expect(list.providers).toEqual({ google: true, microsoft: true });
    expect(list.connections[0]).toMatchObject({ provider: 'google', account_email: 'owner@example.com', status: 'ok' });
    expect(JSON.stringify(list)).not.toMatch(/g-access|g-refresh|v1:/);
  });

  it('reports a denied consent back to the settings page', async () => {
    const r = await t.api.post('/api/oauth/start', { provider: 'google' });
    const f = fake.authorize(r.data.url);
    const back = await t.api.get(`/oauth/google/callback?error=access_denied&state=${encodeURIComponent(f.state)}`);
    expect(back.headers.get('location')).toBe('/app/settings/account?oauth=error&msg=Zugriff+wurde+nicht+erlaubt');
  });
});

describe('two-way sync with Google Calendar', () => {
  let c: any;

  it('lists the Google calendars and saves the choice', async () => {
    c = await conn();
    const list = (await t.api.get(`/api/me/calendar-connections/${c.id}/calendars`)).data;
    expect(list).toEqual([
      { id: 'owner@example.com', name: 'Paul', primary: true, can_write: true, color: '#4285f4' },
      { id: 'team@group.calendar.google.com', name: 'Team', primary: false, can_write: false, color: '' },
    ]);
    const booking = (await t.api.get('/api/me/calendar-connections/booking-calendars')).data;
    expect(booking.map((b: any) => b.id)).toContain(cal.id);
    expect((await t.api.put(`/api/me/calendar-connections/${c.id}`, { booking_calendars: ['nope'] })).status).toBe(400);
    const r = await t.api.put(`/api/me/calendar-connections/${c.id}`, { check_calendars: ['owner@example.com', 'team@group.calendar.google.com'], target_calendar: 'owner@example.com', booking_calendars: [cal.id] });
    expect(r.data).toMatchObject({ settings: { target_calendar: 'owner@example.com' }, booking_calendars: [cal.id] });
    expect((await t.api.get(`/api/calendars/${cal.id}/connections`)).data[0]).toMatchObject({ provider: 'google', account_email: 'owner@example.com', writes: true });
  });

  it('blocks booking slots with Google busy times, merged with iCal busy times', async () => {
    expect(await slots()).toContain(at('10:00'));
    fake.g.busy = [{ start: at('10:00'), end: at('11:00') }];
    const r = await sync(c.id);
    expect(r.result.busy).toBe(1);
    const fb = calls(/\/freeBusy$/, 'POST').pop()!;
    expect(fb.body.items).toEqual([{ id: 'owner@example.com' }, { id: 'team@group.calendar.google.com' }]);
    t.app.db.insert('external_busy', { calendar_id: cal.id, start_at: at('12:00'), end_at: at('12:30'), summary: 'iCal', source: 'https://x', fetched_at: new Date().toISOString() });
    const s = await slots();
    expect(s).toContain(at('09:30'));
    expect(s).not.toContain(at('10:00'));
    expect(s).not.toContain(at('10:30'));
    expect(s).toContain(at('11:00'));
    expect(s).not.toContain(at('12:00'));
    expect((await book('10:30', 'zu@spaet.de')).status).toBe(409);
  });

  let appt: any;
  it('writes a new booking to Google once (idempotent)', async () => {
    appt = (await book('14:00', 'max@kunde.de')).data;
    const r = await sync(c.id);
    expect(r.result).toMatchObject({ created: 1, errors: [] });
    const post = calls(/\/calendars\/owner%40example\.com\/events\?sendUpdates=none$/, 'POST').pop()!;
    expect(post.body).toMatchObject({ summary: 'Erstgespräch – max', start: { dateTime: at('14:00') }, end: { dateTime: at('14:30') }, extendedProperties: { private: { pghl_appt: appt.id } } });
    expect(post.body.description).toContain('E-Mail: max@kunde.de');
    expect(post.body.id).toBe(googleEventId(`${c.id}:${appt.id}`));
    expect(mapOf(appt.id)).toMatchObject({ external_event_id: post.body.id, external_calendar_id: 'owner@example.com', deleted: 0 });
    const n = fake.reqs.length;
    await sync(c.id);
    expect(fake.reqs.slice(n).filter((x) => /\/events/.test(x.url) && x.method !== 'GET')).toHaveLength(0);
  });

  it('patches a rescheduled appointment with If-Match and deletes a cancelled one', async () => {
    await t.api.patch(`/api/appointments/${appt.id}`, { start: at('15:00') });
    const m = mapOf(appt.id);
    await sync(c.id);
    const patch = calls(/\/events\/pghl/, 'PATCH').pop()!;
    expect(patch.headers['if-match']).toBe(m.etag);
    expect(patch.body.start).toEqual({ dateTime: at('15:00') });
    expect(fake.g.events.get(m.external_event_id).start.dateTime).toBe(at('15:00'));
    await t.api.patch(`/api/appointments/${appt.id}`, { status: 'cancelled' });
    const r = await sync(c.id);
    expect(r.result.deleted).toBe(1);
    expect(calls(/\/events\/pghl/, 'DELETE')).toHaveLength(1);
    expect(fake.g.events.get(m.external_event_id).status).toBe('cancelled');
    expect(mapOf(appt.id).deleted).toBe(1);
  });

  it('removes the event of a deleted appointment', async () => {
    const a = (await book('09:00', 'weg@kunde.de')).data;
    await sync(c.id);
    const ext = mapOf(a.id).external_event_id;
    await t.api.del(`/api/appointments/${a.id}`);
    await sync(c.id);
    expect(fake.g.events.get(ext).status).toBe('cancelled');
    expect(mapOf(a.id)).toBeUndefined();
  });

  let moved: any;
  it('pulls a move made in Google back (syncToken)', async () => {
    moved = (await book('16:00', 'anna@kunde.de')).data;
    await sync(c.id);
    const ext = mapOf(moved.id).external_event_id;
    fake.googleMove(ext, at('16:30'), at('17:00'));
    const r = await sync(c.id);
    expect(r.result.pulled).toBe(1);
    const lists = calls(/\/calendars\/owner%40example\.com\/events\?/, 'GET');
    expect(new URL(lists[lists.length - 1].url).searchParams.get('syncToken')).toMatch(/^sync-/);
    const a = t.app.db.get('SELECT * FROM appointments WHERE id = ?', moved.id)!;
    expect([a.start_at, a.end_at, a.reminder_sent]).toEqual([at('16:30'), at('17:00'), 0]);
    // Nothing is pushed back for our own pulled change.
    const n = fake.reqs.length;
    await sync(c.id);
    expect(fake.reqs.slice(n).filter((x) => /\/events/.test(x.url) && (x.method === 'PATCH' || x.method === 'POST')).map((x) => `${x.method} ${x.url}`)).toEqual([]);
    moved.contact_id = a.contact_id;
    const contact = (await t.api.get(`/api/contacts/${moved.contact_id}`)).data;
    expect(contact.activities.some((x: any) => x.type === 'appointment.rescheduled')).toBe(true);
  });

  it('cancels the appointment when the event is deleted in Google', async () => {
    fake.googleDelete(mapOf(moved.id).external_event_id);
    events.length = 0;
    await sync(c.id);
    expect(t.app.db.get('SELECT status FROM appointments WHERE id = ?', moved.id)!.status).toBe('cancelled');
    await t.app.events.flush();
    expect(events.find((e) => e.type === 'appointment.status_changed')?.data).toMatchObject({ status: 'cancelled', source: 'google', contactId: moved.contact_id });
    expect(mapOf(moved.id).deleted).toBe(1);
  });

  it('resolves conflicts: the later change wins and is logged', async () => {
    const a = (await book('11:00', 'konflikt@kunde.de')).data;
    await sync(c.id);
    const ext = mapOf(a.id).external_event_id;
    // Google changed a minute ago, here just now → ours wins.
    fake.googleMove(ext, at('11:30'), at('12:00'), -60_000);
    await t.api.patch(`/api/appointments/${a.id}`, { start: at('13:00') });
    let r = await sync(c.id);
    expect(r.result.conflicts).toBeGreaterThanOrEqual(1);
    expect(fake.g.events.get(ext).start.dateTime).toBe(at('13:00'));
    expect(t.app.db.get('SELECT start_at FROM appointments WHERE id = ?', a.id)!.start_at).toBe(at('13:00'));
    expect(r.connection.log.some((l: any) => /Konflikt.*hier zuletzt geändert/.test(l.message))).toBe(true);
    // Google changed "later" than the change here → Google wins.
    fake.googleMove(ext, at('15:30'), at('16:00'), 60_000);
    await t.api.patch(`/api/appointments/${a.id}`, { start: at('09:30') });
    r = await sync(c.id);
    expect(t.app.db.get('SELECT start_at FROM appointments WHERE id = ?', a.id)!.start_at).toBe(at('15:30'));
    expect(fake.g.events.get(ext).start.dateTime).toBe(at('15:30'));
    expect(r.connection.log.some((l: any) => /Konflikt.*in Google zuletzt geändert/.test(l.message))).toBe(true);
  });

  it('starts over when the sync token expired', async () => {
    t.app.db.run(`UPDATE oauth_connections SET state = json_set(state, '$.cursor', 'expired') WHERE id = ?`, c.id);
    const n = fake.reqs.length;
    const r = await sync(c.id);
    expect(r.result.errors).toEqual([]);
    const lists = fake.reqs.slice(n).filter((x) => /\/events\?/.test(x.url) && x.method === 'GET');
    expect(lists.map((x) => new URL(x.url).searchParams.get('syncToken'))).toEqual(['expired', null]);
  });

  it('refreshes the access token when it expired or was rejected', async () => {
    t.app.db.run('UPDATE oauth_connections SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), c.id);
    const before = fake.g.refreshCount;
    await sync(c.id);
    expect(fake.g.refreshCount).toBe(before + 1);
    expect(calls(/oauth2\.googleapis\.com\/token/).pop()!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'g-refresh-1', client_secret: G_CLIENT.client_secret });
    // Google revokes the access token early: 401 → refresh once → retry.
    fake.g.access = 'revoked-early';
    const r = await t.api.get(`/api/me/calendar-connections/${c.id}/calendars`);
    expect(r.status).toBe(200);
    expect(fake.g.refreshCount).toBe(before + 2);
  });

  it('retries failed writes with backoff', async () => {
    const a = (await book('16:00', 'retry@kunde.de')).data;
    const real = fake.fetch;
    t.app.services.oauthFetch = (async (u: any, init: any) => (/\/events\?sendUpdates=none$/.test(String(u)) && init?.method === 'POST' ? new Response(JSON.stringify({ error: { message: 'Backend Error' } }), { status: 503 }) : real(u, init))) as typeof fetch;
    const r = await sync(c.id);
    t.app.services.oauthFetch = real;
    expect(r.result.errors[0]).toContain('Backend Error');
    const m = mapOf(a.id);
    expect(m).toMatchObject({ attempts: 1, external_event_id: '' });
    expect(Date.parse(m.next_attempt_at) - Date.now()).toBeGreaterThan(50_000);
    await sync(c.id); // still waiting
    expect(mapOf(a.id).attempts).toBe(1);
    t.app.db.run('UPDATE oauth_event_map SET next_attempt_at = ? WHERE appointment_id = ?', new Date(Date.now() - 1000).toISOString(), a.id);
    await t.app.tick();
    expect(mapOf(a.id)).toMatchObject({ attempts: 0, last_error: null });
    expect(mapOf(a.id).external_event_id).toMatch(/^pghl/);
  });

  it('asks to reconnect when Google revoked the grant', async () => {
    fake.g.failRefresh = true;
    t.app.db.run('UPDATE oauth_connections SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), c.id);
    await sync(c.id);
    const cur = await conn();
    expect(cur).toMatchObject({ status: 'error', needs_reconnect: true });
    expect(cur.last_error).toContain('neu verbinden');
    fake.g.failRefresh = false;
  });
});

describe('two-way sync with Outlook (Microsoft Graph)', () => {
  let c: any;
  let cal2: any;

  it('connects with PKCE and stores the account', async () => {
    const r = await t.api.post('/api/oauth/start', { provider: 'microsoft' });
    expect(r.data.url).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    const f = fake.authorize(r.data.url);
    const back = await t.api.get(`/oauth/microsoft/callback?code=${f.code}&state=${encodeURIComponent(f.state)}`);
    expect(back.headers.get('location')).toContain('oauth=ok');
    expect(calls(/login\.microsoftonline\.com.*\/token/).pop()!.body).toMatchObject({ grant_type: 'authorization_code', scope: 'openid email offline_access Calendars.ReadWrite' });
    c = await conn('microsoft');
    expect(c).toMatchObject({ account_email: 'inhaber@firma.de', status: 'ok' });
  });

  it('checks busy times, writes appointments and pulls changes via delta links', async () => {
    cal2 = (await t.api.post('/api/calendars', { name: 'Beratung', duration: 30, min_notice: 1 })).data;
    expect((await t.api.get(`/api/me/calendar-connections/${c.id}/calendars`)).data[0]).toMatchObject({ id: 'AQMkCAL1', primary: true, can_write: true });
    await t.api.put(`/api/me/calendar-connections/${c.id}`, { check_calendars: ['AQMkCAL1'], target_calendar: 'AQMkCAL1', booking_calendars: [cal2.id] });
    fake.ms.view = [
      { id: 'v1', start: { dateTime: at('10:00').slice(0, 19), timeZone: 'UTC' }, end: { dateTime: at('11:00').slice(0, 19), timeZone: 'UTC' }, showAs: 'busy' },
      { id: 'v2', start: { dateTime: at('13:00').slice(0, 19), timeZone: 'UTC' }, end: { dateTime: at('14:00').slice(0, 19), timeZone: 'UTC' }, showAs: 'free' },
    ];
    const a = (await t.api.post(`/api/public/calendars/${cal2.slug}/book`, { start: at('15:00'), email: 'lea@kunde.de', first_name: 'Lea' })).data;
    const r = await sync(c.id);
    expect(r.result).toMatchObject({ created: 1, busy: 1, errors: [] });
    const view = calls(/\/calendarView\?/).pop()!;
    expect(view.headers.prefer).toContain('outlook.timezone="UTC"');
    const s = (await t.api.get(`/api/public/calendars/${cal2.slug}/slots?from=${day}&days=1`)).data.days[0].slots;
    expect(s).not.toContain(at('10:00'));
    expect(s).toContain(at('13:00'));
    const post = calls(/\/me\/calendars\/AQMkCAL1\/events$/, 'POST').pop()!;
    expect(post.body).toMatchObject({ subject: 'Beratung – Lea', start: { dateTime: at('15:00').slice(0, 19), timeZone: 'UTC' }, transactionId: graphTransactionId(`${c.id}:${a.id}`) });
    const ext = mapOf(a.id).external_event_id;
    expect(ext).toMatch(/^AAMkEV/);
    // Delta: the first round only stores the link, the next one brings the move.
    expect(calls(/calendarView\/delta/).length).toBeGreaterThan(0);
    fake.graphMove(ext, at('16:00'), at('16:30'));
    await sync(c.id);
    expect(calls(/calendarView\/delta/).pop()!.url).toContain('$deltatoken=');
    expect(t.app.db.get('SELECT start_at FROM appointments WHERE id = ?', a.id)!.start_at).toBe(at('16:00'));
    // Moved here: PATCH with If-Match.
    await t.api.patch(`/api/appointments/${a.id}`, { start: at('09:00') });
    await sync(c.id);
    const patch = calls(/\/me\/events\//, 'PATCH').pop()!;
    expect(patch.headers['if-match']).toMatch(/^W\//);
    expect(patch.body.start).toEqual({ dateTime: at('09:00').slice(0, 19), timeZone: 'UTC' });
    // Deleted in Outlook (@removed): cancelled here.
    fake.graphDelete(ext);
    await sync(c.id);
    expect(t.app.db.get('SELECT status FROM appointments WHERE id = ?', a.id)!.status).toBe('cancelled');
  });

  it('stores the rotated refresh token', async () => {
    const stored = () => openSecret(t.app, t.app.db.get('SELECT refresh_token FROM oauth_connections WHERE id = ?', c.id)!.refresh_token);
    expect(stored()).toBe('ms-refresh-1');
    for (let i = 0; i < 2; i++) {
      t.app.db.run('UPDATE oauth_connections SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), c.id);
      expect((await t.api.get(`/api/me/calendar-connections/${c.id}/calendars`)).status).toBe(200);
      expect(stored()).toBe(fake.ms.refresh);
    }
    expect(fake.ms.refresh).not.toBe('ms-refresh-1');
  });

  it('disconnects (Google revokes, Microsoft forgets) and drops the synced state', async () => {
    const g = await conn('google');
    const r = await t.api.del(`/api/oauth/connections/${g.id}`);
    expect(r.data).toEqual({ ok: true, revoked: true });
    expect(fake.g.revoked).toContain('g-refresh-1');
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM oauth_event_map WHERE connection_id = ?', g.id)!.n).toBe(0);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM oauth_busy WHERE connection_id = ?', g.id)!.n).toBe(0);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM oauth_calendar_links WHERE connection_id = ?', g.id)!.n).toBe(0);
    expect(await slots()).toContain(at('10:30'));
    expect((await t.api.del(`/api/oauth/connections/${c.id}`)).data).toEqual({ ok: true, revoked: false });
    expect((await t.api.get('/api/me/calendar-connections')).data.connections).toEqual([]);
  });

  it('only lets a login link calendars of its own sub-accounts', async () => {
    await t.api.post('/api/users', { email: 'mitarbeiter@x.de', password: 'geheim12345', name: 'Mia', locations: [] });
    await t.api.post('/api/auth/login', { email: 'mitarbeiter@x.de', password: 'geheim12345' });
    expect((await t.api.get('/api/me/calendar-connections/booking-calendars')).data).toEqual([]);
    expect((await t.api.post('/api/oauth/start', { provider: 'google', purpose: 'business', location_id: t.api.location })).status).toBe(403);
    await t.api.post('/api/auth/login', { email: 'chef@example.com', password: 'geheim123' });
  });
});
