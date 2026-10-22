import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { client, type Call } from './security-fixtures.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../server/core/time.js';
import { setStripeFetch, signStripePayload } from '../server/services/stripe.js';
import {
  chooseHost,
  cleanConfig,
  defaultConfig,
  dueNow,
  gridStarts,
  itemsForGross,
  mayChange,
  netFromGross,
  needsTeamPage,
  teamSlots,
  validateAnswers,
  withDefaults,
  withinHours,
  type MemberLoad,
  type SlotRules,
} from '../server/services/teamcal-model.js';
import { TEAMCAL_TOOLS } from '../server/modules/teamcal-tools.js';
import { resetThrottle } from '../server/modules/teamcal-public.js';

/**
 * Team-Kalender: round robin (even / weighted, availability / equal distribution, members' own busy times incl. Google/Outlook and
 * absences), collective, group with waiting list, questions, pay at booking (Stripe, mocked) with holds, deposit and refunds,
 * automatic video links (Google Meet, Teams, Zoom, fixed place – all mocked), cancel / reschedule rules, routing forms,
 * the public pages, MCP tools, permissions, sub-account isolation and the audit log. No network.
 */

const KEY = 'sk_test_51FakeKeyForTests000abcd';
const WHSEC = 'whsec_testSigningSecret0000000';
const TZ = 'Europe/Berlin';

// --- a fake Stripe -------------------------------------------------------------------------------
const stripeCalls: { method: string; path: string; params: URLSearchParams }[] = [];
const sessions = new Map<string, any>();
let seq = 0;
const stripeFake = (async (url: string, init: any) => {
  const u = new URL(url);
  const params = new URLSearchParams(init.body ?? u.search.slice(1));
  stripeCalls.push({ method: init.method, path: u.pathname, params });
  const json = (d: any, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (init.headers.authorization !== `Bearer ${KEY}`) return json({ error: { message: 'Invalid API Key provided' } }, 401);
  if (u.pathname === '/v1/account') return json({ id: 'acct_123', settings: { dashboard: { display_name: 'Praxis Muster' } }, country: 'DE', default_currency: 'eur', charges_enabled: true });
  if (u.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
    const id = `cs_test_${++seq}`;
    const metadata: Record<string, string> = {};
    for (const [k, v] of params) if (k.startsWith('metadata[')) metadata[k.slice(9, -1)] = v;
    const total = Number(params.get('line_items[0][quantity]')) * Number(params.get('line_items[0][price_data][unit_amount]'));
    const s = { id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, mode: 'payment', metadata, amount_total: total, currency: params.get('line_items[0][price_data][currency]'), customer_email: params.get('customer_email'), payment_status: 'unpaid', status: 'open', payment_intent: `pi_${seq}`, expires_at: params.get('expires_at') };
    sessions.set(id, s);
    return json(s);
  }
  const m = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) return json({ error: { message: 'No such checkout.session' } }, 404);
    if (m[2]) {
      s.status = 'expired';
      return json(s);
    }
    return json(s);
  }
  if (u.pathname === '/v1/refunds' && init.method === 'POST') {
    if (refundFails) return json({ error: { message: 'Charge has already been refunded' } }, 400);
    return json({ id: `re_${++seq}`, payment_intent: params.get('payment_intent'), amount: 1 });
  }
  return json({ error: { message: 'unknown endpoint' } }, 404);
}) as any;
let refundFails = false;

// --- fake Google / Microsoft / Zoom ---------------------------------------------------------------------
const outCalls: { url: string; method: string; body: any }[] = [];
const outFake = (async (url: string, init: any = {}) => {
  const u = new URL(String(url));
  const body = init.body ? JSON.parse(init.body) : undefined;
  outCalls.push({ url: String(url), method: init.method ?? 'GET', body });
  const json = (d: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'www.googleapis.com' && /\/events$/.test(u.pathname) && (init.method ?? 'GET') === 'GET') return json({ items: [], nextSyncToken: 'sync-1' });
  if (u.host === 'www.googleapis.com' && /\/freeBusy$/.test(u.pathname)) return json({ calendars: {} });
  if (u.host === 'www.googleapis.com' && /\/events$/.test(u.pathname) && init.method === 'POST') {
    if (googleMeet === 'none') return json({ id: body.id, status: 'confirmed', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } });
    return json({ id: body.id, status: 'confirmed', hangoutLink: 'https://meet.google.com/abc-defg-hij', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] } });
  }
  if (u.host === 'www.googleapis.com' && /\/events\/[^/]+$/.test(u.pathname)) {
    if (init.method === 'DELETE' || init.method === 'PATCH') return json({}, init.method === 'DELETE' ? 204 : 200);
    if (googleMeet === 'none') return json({ id: 'x', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } });
    return json({ id: 'x', hangoutLink: 'https://meet.google.com/late-late-late' });
  }
  if (u.host === 'graph.microsoft.com' && init.method === 'POST') return json({ id: 'AAMk-event', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } });
  if (u.host === 'graph.microsoft.com') return json({}, init.method === 'DELETE' ? 204 : 200);
  return json({ error: { message: 'unknown' } }, 404);
}) as any;
let googleMeet: 'ok' | 'none' = 'ok';

let t: Awaited<ReturnType<typeof startTestApp>>;
let loc = '';
let other = '';
let anna: Call;
let ben: Call;
let cleo: Call;
const ids = { chef: '', anna: '', ben: '', cleo: '' };
let day = '';
let day2 = '';
const pushes: any[] = [];
const events: { type: string; data: any }[] = [];
let keyA = '';
let n = 0;

const at = (hm: string, d = day) => zonedToUtc(d, hm, TZ).toISOString();
const settle = async () => {
  await t.app.events.flush();
  await Promise.all([...(t.app.services.collabPending ?? [])]);
};
const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
const tickAll = async () => {
  await t.app.tick();
  await settle();
};

/** A calendar with team settings. */
async function makeCal(name: string, config: Record<string, any>, members: { user_id: string; weight?: number; hours?: any }[] = [], extra: Record<string, any> = {}) {
  const cal = (await t.api.post('/api/calendars', { name: `${name} ${++n}`, duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, timezone: TZ, settings: { confirmation_email: false, notify_team: false, reminder_hours: 0, ...(extra.settings ?? {}) }, ...extra })).data;
  const r = await t.api.put(`/api/team-calendars/${cal.id}`, { config, members });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return { ...cal, warnings: r.data.warnings as string[] };
}
const slotsOf = async (slug: string, d = day) => (await t.api.get(`/api/public/team-calendars/${slug}/slots?from=${d}&days=1`)).data.days[0] as { slots: string[]; full: string[]; left: Record<string, number> };
const form = (start: string, extra: Record<string, any> = {}) => ({ start, first_name: 'Erika', last_name: 'Muster', email: `kunde${++n}@example.com`, consent: true, ...extra });
const book = (slug: string, start: string, extra: Record<string, any> = {}) => t.api.post(`/api/public/team-calendars/${slug}/book`, form(start, extra));
const appt = (id: string) => t.app.db.get<any>('SELECT * FROM appointments WHERE id = ?', id)!;
const audit = (action: string) => t.app.db.all<any>('SELECT * FROM audit_log WHERE action LIKE ? ORDER BY at', action);
const addHold = async (slug: string, start: string, extra: Record<string, any> = {}) => {
  const r = await book(slug, start, extra);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
};
/** Stripe says the session was paid (the webhook). */
async function pay(sessionId: string) {
  const s = sessions.get(sessionId)!;
  Object.assign(s, { payment_status: 'paid', status: 'complete' });
  const raw = JSON.stringify({ id: `evt_${++seq}`, object: 'event', type: 'checkout.session.completed', data: { object: s } });
  const r = await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
  await settle();
  return r.status;
}
const holdOf = (token: string) => t.app.db.get<any>('SELECT * FROM teamcal_holds WHERE token = ?', token)!;
const memberIds = (a: any) => JSON.parse(a.host_ids ?? '[]') as string[];
const userConn = (userId: string, provider: 'google' | 'microsoft', settings: Record<string, any> = {}) => {
  const cid = `conn-${userId}-${provider}`;
  t.app.db.run(`INSERT OR REPLACE INTO oauth_connections (id, provider, purpose, user_id, location_id, account_email, account_name, scopes, status, settings, state, created_at, updated_at) VALUES (?, ?, 'calendar', ?, NULL, ?, '', '', 'ok', ?, '{}', ?, ?)`, cid, provider, userId, `${userId}@example.com`, JSON.stringify(settings), new Date().toISOString(), new Date().toISOString());
  return cid;
};

beforeAll(async () => {
  setStripeFetch(stripeFake);
  t = await startTestApp();
  const me = await t.setup();
  ids.chef = me.user.id;
  loc = t.api.location;
  other = (await t.api.post('/api/locations', { name: 'Zweite Firma' })).data.id;
  for (const [key, name, perms] of [['anna', 'Anna Schmidt', ['calendars']], ['ben', 'Ben Weber', ['calendars', 'settings']], ['cleo', 'Cleo Roth', ['contacts']]] as const) {
    const r = await t.api.post('/api/users', { email: `${key}@example.com`, password: `passwort-${key}1`, name, locations: [loc], permissions: perms });
    (ids as any)[key] = r.data.id;
  }
  const login = async (key: string) => {
    const c = client(t.base, { 'x-pghl': '1', 'x-location-id': loc });
    expect((await c('POST', '/api/auth/login', { email: `${key}@example.com`, password: `passwort-${key}1` })).status).toBe(200);
    return c;
  };
  anna = await login('anna');
  ben = await login('ben');
  cleo = await login('cleo');
  keyA = (await t.api.post('/api/api-keys', { name: 'Kalender' })).data.key;
  day = addDaysYmd(ymdInTz(new Date(), TZ), 3);
  day2 = addDaysYmd(day, 1);
  t.app.services.pushNotify = async (i: any) => {
    pushes.push(i);
    return { users: 0, sent: 0, failed: 0, removed: 0 };
  };
  t.app.services.teamcalSleep = async () => undefined;
  t.app.events.on('*', (e) => void events.push({ type: e.type, data: e.data }));
  // Stripe connected (mocked), Google / Microsoft / Zoom faked
  const st = await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC });
  expect(st.status, JSON.stringify(st.data)).toBe(200);
  t.app.services.oauthFetch = outFake;
  t.app.services.oauth.token = async () => 'tok';
}, 90_000);

afterAll(async () => {
  setStripeFetch();
  await settle();
  await t?.close();
});

beforeEach(() => {
  resetThrottle();
  // every test starts with free calendars: no bookings, holds, absences or busy times of the earlier ones
  for (const table of ['teamcal_waitlist', 'teamcal_holds', 'appointments', 'team_away', 'oauth_busy']) t?.app.db.run(`DELETE FROM ${table}`);
  googleMeet = 'ok';
  refundFails = false;
});

describe('model (pure)', () => {
  const rules: SlotRules = { duration: 60, interval: 60, before: 0, after: 0, minNoticeH: 0, maxDays: 90, tz: TZ, availability: { mon: [['09:00', '12:00']], tue: [['09:00', '12:00']], wed: [['09:00', '12:00']], thu: [['09:00', '12:00']], fri: [['09:00', '12:00']], sat: [['09:00', '12:00']], sun: [['09:00', '12:00']] } };
  const member = (id: string, busy: [string, string][] = [], load = 0, weight = 1, windows: any = null): MemberLoad => ({ id, weight, windows, load, busy: busy.map(([s, e]) => ({ s: Date.parse(s), e: Date.parse(e) })) });
  const long = new Date('2026-01-01T00:00:00Z');
  const ymd = '2026-02-03';
  const hm = (iso: string) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TZ });

  it('config: defaults, validation, questions, payment, stale values', () => {
    const d = defaultConfig();
    expect(needsTeamPage(d)).toBe(false);
    expect(needsTeamPage({ ...d, kind: 'round_robin' })).toBe(true);
    expect(needsTeamPage(cleanConfig({ questions: [{ label: 'Wie?', type: 'text' }] }, d))).toBe(true);
    expect(() => cleanConfig({ kind: 'zufall' }, d)).toThrow(/Kalendertyp/);
    expect(() => cleanConfig({ questions: [{ label: '', type: 'text' }] }, d)).toThrow(/Text/);
    expect(() => cleanConfig({ questions: [{ label: 'x', type: 'choice', options: ['nur eine'] }] }, d)).toThrow(/zwei/);
    expect(() => cleanConfig({ questions: Array.from({ length: 21 }, (_, i) => ({ label: `q${i}`, type: 'text' })) }, d)).toThrow(/20/);
    expect(() => cleanConfig({ payment: { mode: 'full', amount_cents: 10 } }, d)).toThrow(/0,50/);
    expect(() => cleanConfig({ payment: { mode: 'deposit', amount_cents: 5000, deposit_cents: 5000 } }, d)).toThrow(/kleiner/);
    expect(() => cleanConfig({ payment: { mode: 'bar' } }, d)).toThrow();
    expect(() => cleanConfig({ video: 'skype' }, d)).toThrow(/Video/);
    const ok = cleanConfig({ kind: 'group', capacity: 12, waitlist: true, payment: { mode: 'deposit', amount_cents: 9000, deposit_cents: 3000, currency: 'chf', hold_minutes: 5 }, video: 'meet', cancel_cutoff_hours: 24 }, d);
    expect(ok).toMatchObject({ kind: 'group', capacity: 12, waitlist: true, video: 'meet', cancel_cutoff_hours: 24 });
    expect(ok.payment).toMatchObject({ currency: 'CHF', hold_minutes: 30 });
    expect(dueNow(ok.payment)).toBe(3000);
    expect(withDefaults({ kind: 'nonsense' })).toEqual(d);
    expect(withDefaults(null)).toEqual(d);
  });

  it('answers: required, choices, multi, checkbox; nothing unasked is kept', () => {
    const qs = [
      { id: 'a', label: 'Anliegen', type: 'text' as const, required: true, options: [], help: '' },
      { id: 'b', label: 'Größe', type: 'choice' as const, required: false, options: ['S', 'M'], help: '' },
      { id: 'c', label: 'Extras', type: 'multi' as const, required: true, options: ['x', 'y', 'z'], help: '' },
      { id: 'd', label: 'AGB', type: 'checkbox' as const, required: true, options: [], help: '' },
    ];
    expect(validateAnswers(qs, { a: ' Hallo ', b: 'M', c: ['x', 'z'], d: true, evil: 'nein' })).toEqual([
      { id: 'a', label: 'Anliegen', value: 'Hallo' },
      { id: 'b', label: 'Größe', value: 'M' },
      { id: 'c', label: 'Extras', value: 'x, z' },
      { id: 'd', label: 'AGB', value: 'Ja' },
    ]);
    expect(() => validateAnswers(qs, { b: 'M', c: ['x'], d: true })).toThrow(/Anliegen/);
    expect(() => validateAnswers(qs, { a: 'x', b: 'XL', c: ['x'], d: true })).toThrow(/Ungültige Auswahl/);
    expect(() => validateAnswers(qs, { a: 'x', c: [], d: true })).toThrow(/Extras/);
    expect(() => validateAnswers(qs, { a: 'x', c: ['q'], d: true })).toThrow(/Ungültige Auswahl/);
    expect(() => validateAnswers(qs, { a: 'x', c: ['x'], d: false })).toThrow(/bestätigen/);
    expect(() => validateAnswers(qs, { a: 'x'.repeat(501), c: ['x'], d: true })).toThrow(/zu lang/);
    expect(validateAnswers(qs, {}, { lenient: true })).toEqual([]);
  });

  it('prices: the net price that gives exactly the gross price; cutoffs', () => {
    for (const gross of [5000, 9999, 12345, 100, 5001, 11900]) for (const rate of [0, 7, 19]) {
      const lines = itemsForGross({ name: 'x', description: '' }, gross, rate);
      const total = lines.reduce((sum, l) => sum + l.price_cents + Math.round((l.price_cents * l.tax_rate) / 100), 0);
      expect(total, `${gross} @ ${rate}%`).toBe(gross);
      expect(lines.length).toBeLessThanOrEqual(2);
    }
    expect(netFromGross(11900, 19)).toBe(10000);
    expect(itemsForGross({ name: 'x', description: '' }, 11900, 19)).toHaveLength(1);
    expect(itemsForGross({ name: 'x', description: '' }, 9999, 19)).toHaveLength(2); // 9999 cannot be reached with one line
    const start = new Date(Date.now() + 5 * 3600_000);
    expect(mayChange(0, start)).toBe(true);
    expect(mayChange(4, start)).toBe(true);
    expect(mayChange(6, start)).toBe(false);
    expect(mayChange(0, new Date(Date.now() - 1000))).toBe(false);
  });

  it('round robin: every free time of anybody, with the people who are free; busy and own hours cut', () => {
    const a = member('a', [[`${ymd}T09:00:00Z`, `${ymd}T10:00:00Z`]]); // 10–11 Berlin busy
    const b = member('b', [], 0, 1, { tue: [['11:00', '12:00']] });
    const slots = teamSlots('round_robin', 'availability', false, rules, ymd, long, [a, b]);
    expect(slots.map((s) => [hm(s.start), s.hosts])).toEqual([
      ['09:00', ['a']],
      ['11:00', ['a', 'b']],
    ]);
    expect(withinHours(b.windows, ymd, Date.parse(`${ymd}T10:00:00Z`), rules)).toBe(true);
    expect(withinHours(b.windows, ymd, Date.parse(`${ymd}T09:00:00Z`), rules)).toBe(false);
    expect(gridStarts({ ...rules, maxDays: 0 }, ymd, long)).toEqual([]); // beyond the bookable range
  });

  it('round robin equal distribution: whoever is ahead gets nothing new; weighted counts per weight', () => {
    const a = member('a', [], 5);
    const b = member('b', [], 1);
    const eq = teamSlots('round_robin', 'equal', false, rules, ymd, long, [a, b]);
    expect(new Set(eq.flatMap((s) => s.hosts))).toEqual(new Set(['b']));
    const av = teamSlots('round_robin', 'availability', false, rules, ymd, long, [a, b]);
    expect(new Set(av.flatMap((s) => s.hosts))).toEqual(new Set(['a', 'b']));
    expect(chooseHost([a, b], false)!.id).toBe('b');
    // weighted: a has weight 4 with 5 bookings (1.25 per weight) vs b weight 1 with 2 (2 per weight) → a is next
    const wa = member('a', [], 5, 4);
    const wb = member('b', [], 2, 1);
    expect(chooseHost([wa, wb], true)!.id).toBe('a');
    expect(chooseHost([wa, wb], false)!.id).toBe('b');
    expect(chooseHost([], true)).toBeUndefined();
    // a tie goes to the earlier one in the list
    expect(chooseHost([member('x'), member('y')], false)!.id).toBe('x');
  });

  it('collective: only when everybody is free; buffers reach around busy times', () => {
    const a = member('a', [[`${ymd}T09:00:00Z`, `${ymd}T10:00:00Z`]]);
    const b = member('b');
    expect(teamSlots('collective', 'availability', false, rules, ymd, long, [a, b]).map((s) => hm(s.start))).toEqual(['09:00', '11:00']);
    expect(teamSlots('collective', 'availability', false, { ...rules, before: 30 }, ymd, long, [a, b]).map((s) => hm(s.start))).toEqual(['09:00']);
    expect(teamSlots('collective', 'availability', false, { ...rules, before: 30, after: 30 }, ymd, long, [a, b])).toEqual([]);
    expect(teamSlots('collective', 'availability', false, rules, ymd, long, [])).toEqual([]);
  });
});

describe('configuration', () => {
  it('saves type, members and settings; reads them back with connection status', async () => {
    const cal = await makeCal('Konfig', { kind: 'round_robin', strategy: 'equal', distribution: 'weighted', policy_text: 'Absage bis 24 Std.' }, [{ user_id: ids.anna, weight: 3 }, { user_id: ids.ben }]);
    userConn(ids.anna, 'google');
    const r = (await t.api.get(`/api/team-calendars/${cal.id}`)).data;
    expect(r).toMatchObject({ kind: 'round_robin', kind_label: 'Round Robin', configured: true, needs_team_page: true });
    expect(r.config).toMatchObject({ strategy: 'equal', distribution: 'weighted', policy_text: 'Absage bis 24 Std.' });
    expect(r.members.map((m: any) => [m.name, m.weight, m.connected.google, m.connected.linked])).toEqual([['Anna Schmidt', 3, true, false], ['Ben Weber', 1, false, false]]);
    const types = (await t.api.get('/api/team-calendars/types')).data as any[];
    expect(types.find((c) => c.id === cal.id)).toMatchObject({ kind: 'round_robin', members: [{ name: 'Anna Schmidt', weight: 3 }, { name: 'Ben Weber', weight: 1 }] });
    const meta = (await t.api.get('/api/team-calendars/meta')).data;
    expect(meta).toMatchObject({ stripe: true, zoom: false });
    expect(meta.people.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Anna Schmidt', 'Ben Weber']));
    expect(meta.people.map((p: any) => p.name)).not.toContain('Cleo Roth'); // no calendars area
  });

  it('refuses nonsense with a German message', async () => {
    const cal = await makeCal('Fehler', { kind: 'single' });
    const put = (b: any) => t.api.put(`/api/team-calendars/${cal.id}`, b);
    expect((await put({ config: { kind: 'round_robin' } })).data.error).toMatch(/mindestens eine Person/);
    expect((await put({ members: [{ user_id: ids.cleo }] })).data.error).toMatch(/Zugriff auf die Kalender/);
    expect((await put({ members: [{ user_id: ids.anna }, { user_id: ids.anna }] })).data.error).toMatch(/doppelt/);
    expect((await put({ config: { kind: 'bogus' } })).status).toBe(400);
    expect((await put({ config: { payment: { mode: 'full', amount_cents: 5000 } } })).status).toBe(200); // Stripe is connected
    const noStripe = await makeCal('Ohne Stripe', {});
    t.app.db.run('DELETE FROM stripe_accounts WHERE location_id = ?', loc);
    expect((await t.api.put(`/api/team-calendars/${noStripe.id}`, { config: { payment: { mode: 'full', amount_cents: 5000 } } })).data.error).toMatch(/Stripe/);
    expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  });

  it('warns when a video service has nobody to create it', async () => {
    const meet = await makeCal('Meet', { kind: 'round_robin', video: 'meet' }, [{ user_id: ids.ben }]);
    expect(meet.warnings.join(' ')).toMatch(/Google Meet braucht/);
    const zoom = await makeCal('Zoom', { video: 'zoom' });
    expect(zoom.warnings.join(' ')).toMatch(/Zoom ist noch nicht eingerichtet/);
  });

  it('is for members with the calendars area only, and stays inside the sub-account', async () => {
    const cal = await makeCal('Rechte', { kind: 'single' });
    expect((await cleo('GET', `/api/team-calendars/${cal.id}`)).status).toBe(403);
    expect((await cleo('GET', '/api/team-calendars/types')).status).toBe(403);
    expect((await anna('GET', `/api/team-calendars/${cal.id}`)).status).toBe(200);
    t.api.setLocation(other);
    expect((await t.api.get(`/api/team-calendars/${cal.id}`)).status).toBe(404);
    expect((await t.api.put(`/api/team-calendars/${cal.id}`, { config: { kind: 'single' } })).status).toBe(404);
    expect((await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('10:00'), email: 'x@y.de' })).status).toBe(404);
    expect(((await t.api.get('/api/team-calendars/types')).data as any[]).map((c) => c.id)).not.toContain(cal.id);
    t.api.setLocation(loc);
  });
});

describe('round robin', () => {
  it('offers a time while one of the members is free; books the member with the lowest load; the next booking goes to the other', async () => {
    const cal = await makeCal('RR', { kind: 'round_robin' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const s = await slotsOf(cal.slug);
    expect(s.slots).toContain(at('10:00'));
    const first = (await book(cal.slug, at('10:00'))).data;
    expect(first).toMatchObject({ status: 'confirmed' });
    expect(first.hosts).toHaveLength(1);
    const a1 = appt(first.id);
    expect(a1.assignee_id).toBe(ids.anna); // tie → first in the list
    expect(memberIds(a1)).toEqual([ids.anna]);
    // 10:00 is still free through Ben; the second booking for the same time goes to him, a third finds no free time
    const second = (await book(cal.slug, at('10:00'))).data;
    expect(appt(second.id).assignee_id).toBe(ids.ben);
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('10:00'));
    const third = await book(cal.slug, at('10:00'));
    expect(third.status).toBe(409);
    expect(third.data.error).toMatch(/nicht mehr frei/);
    // and the load decides afterwards: Anna has one, Ben one → Anna again
    const fourth = (await book(cal.slug, at('11:00'))).data;
    expect(appt(fourth.id).assignee_id).toBe(ids.anna);
  });

  it('puts the assignee into the appointment payload, the confirmation variables and the list', async () => {
    const cal = await makeCal('RR Payload', { kind: 'round_robin' }, [{ user_id: ids.ben }], { settings: { confirmation_email: true, confirmation_body: 'Hallo, dein Gastgeber ist {{appointment.host_name}} ({{appointment.host_names}}).', confirmation_subject: 'Termin' } });
    events.length = 0;
    const r = (await book(cal.slug, at('12:00'))).data;
    await settle();
    const ev = events.find((e) => e.type === 'appointment.booked' && e.data.appointment.id === r.id)!;
    expect(ev.data.appointment).toMatchObject({ assignee_id: ids.ben, assignee_name: 'Ben Weber', hosts: [{ id: ids.ben, name: 'Ben Weber' }], meeting_url: '' });
    const mail = t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND source = 'Terminbestätigung'`, appt(r.id).contact_id)!;
    expect(mail.body).toContain('Ben Weber');
    const list = ((await t.api.get(`/api/appointments?calendar_id=${cal.id}`)).data as any[]).find((a) => a.id === r.id);
    expect(list).toMatchObject({ assignee_id: ids.ben, assignee_name: 'Ben Weber' });
    expect(pushes.some((p) => p.kind === 'booking' && p.userIds?.includes(ids.ben))).toBe(true);
  });

  it('respects the members\' own appointments, absences, pause and own working hours', async () => {
    const cal = await makeCal('RR Busy', { kind: 'round_robin' }, [{ user_id: ids.anna, hours: { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '17:00']], sat: [['09:00', '17:00']], sun: [['09:00', '17:00']] } }, { user_id: ids.ben }]);
    // Ben has an appointment 10–11 on another calendar of the sub-account, Anna is out of the office 11–13
    const other1 = (await t.api.post('/api/calendars', { name: 'Privat', duration: 60, availability: every, min_notice: 0 })).data;
    t.app.db.insert('appointments', { id: `bn${++n}`, location_id: loc, calendar_id: other1.id, contact_id: null, title: 'Zahnarzt', start_at: at('10:00'), end_at: at('11:00'), status: 'confirmed', notes: '', source: 'manuell', manage_token: `tok${n}`, created_at: new Date().toISOString(), assignee_id: ids.ben });
    const away = await anna('POST', '/api/team-people/me/away', { start_at: at('11:00'), end_at: at('13:00') });
    expect(away.status).toBe(200);
    const s = (await slotsOf(cal.slug)).slots;
    expect(s).toContain(at('10:00')); // Anna is free
    expect(s).toContain(at('11:00')); // Ben is free
    const r10 = (await book(cal.slug, at('10:00'))).data;
    expect(appt(r10.id).assignee_id).toBe(ids.anna);
    const r11 = (await book(cal.slug, at('11:00'))).data;
    expect(appt(r11.id).assignee_id).toBe(ids.ben);
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('11:00'));
    // Ben pauses: nobody is left at 14:00 once Anna's slot is taken
    await ben('PUT', '/api/team-people/me', { paused: true });
    const r14 = (await book(cal.slug, at('14:00'))).data;
    expect(appt(r14.id).assignee_id).toBe(ids.anna);
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('14:00'));
    await ben('PUT', '/api/team-people/me', { paused: false });
    expect((await slotsOf(cal.slug)).slots).toContain(at('14:00'));
    t.app.db.run('DELETE FROM team_away WHERE user_id = ?', ids.anna);
  });

  it('respects Google / Outlook busy times of the member\'s connected calendar', async () => {
    const cal = await makeCal('RR Google', { kind: 'round_robin' }, [{ user_id: ids.anna }]);
    expect((await slotsOf(cal.slug)).slots).toContain(at('15:00'));
    const cid = userConn(ids.anna, 'google', { check_calendars: ['primary'] });
    t.app.db.run('INSERT INTO oauth_busy (connection_id, start_at, end_at) VALUES (?, ?, ?)', cid, at('15:00'), at('16:00'));
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('15:00'));
    expect((await slotsOf(cal.slug)).slots).toContain(at('16:00'));
    expect((await book(cal.slug, at('15:00'))).status).toBe(409);
    t.app.db.run('DELETE FROM oauth_busy WHERE connection_id = ?', cid);
  });

  it('equal distribution gives a member far ahead nothing new; weighted favours heavier members', async () => {
    const eq = await makeCal('RR Equal', { kind: 'round_robin', strategy: 'equal' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const picks: string[] = [];
    for (const hm of ['09:00', '10:00', '11:00', '12:00']) picks.push(appt((await book(eq.slug, at(hm))).data.id).assignee_id);
    expect(picks.filter((p) => p === ids.anna)).toHaveLength(2);
    expect(picks.filter((p) => p === ids.ben)).toHaveLength(2);
    const w = await makeCal('RR Weighted', { kind: 'round_robin', distribution: 'weighted' }, [{ user_id: ids.anna, weight: 3 }, { user_id: ids.ben, weight: 1 }]);
    const wp: string[] = [];
    for (const hm of ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']) wp.push(appt((await book(w.slug, at(hm))).data.id).assignee_id);
    expect(wp.filter((p) => p === ids.anna)).toHaveLength(6);
    expect(wp.filter((p) => p === ids.ben)).toHaveLength(2);
  });

  it('a cancelled appointment no longer counts, a moved one frees its time', async () => {
    const cal = await makeCal('RR Cancel', { kind: 'round_robin' }, [{ user_id: ids.anna }]);
    const r = (await book(cal.slug, at('09:00'))).data;
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('09:00'));
    await t.api.patch(`/api/appointments/${r.id}`, { status: 'cancelled' });
    expect((await slotsOf(cal.slug)).slots).toContain(at('09:00'));
  });

  it('the plain booking API picks the host as well; the team can name one; a staff block closes the type', async () => {
    const cal = await makeCal('RR Old', { kind: 'round_robin' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const old = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start: at('10:00'), first_name: 'Alt', email: 'alt@example.com' });
    expect(old.status).toBe(200);
    expect(appt(t.app.db.get<any>('SELECT id FROM appointments WHERE manage_token = ?', old.data.manageUrl.split('/').pop())!.id).assignee_id).toBe(ids.anna);
    expect((await t.api.get(`/api/public/calendars/${cal.slug}/slots?from=${day}&days=1`)).data.days[0].slots).toContain(at('11:00'));
    const staff = await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('11:00'), email: 'staff@example.com', first_name: 'Staff', host_id: ids.ben });
    expect(staff.status, JSON.stringify(staff.data)).toBe(200);
    expect(appt(staff.data.appointment.id).assignee_id).toBe(ids.ben);
    expect((await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('11:00'), email: 'x@example.com', first_name: 'X', host_id: ids.ben })).status).toBe(409);
    expect((await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('13:00'), email: 'x@example.com', first_name: 'X', host_id: ids.cleo })).status).toBe(400);
    await t.api.post('/api/appointments', { calendar_id: cal.id, blocked: true, title: 'Betriebsfest', start: at('14:00'), end: at('16:00') });
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('14:00'));
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('15:00'));
  });
});

describe('collective', () => {
  it('needs everybody free; one appointment with all hosts; any member\'s busy time closes the slot', async () => {
    const cal = await makeCal('Kollektiv', { kind: 'collective' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const other1 = (await t.api.post('/api/calendars', { name: 'Privat', duration: 60, availability: every, min_notice: 0 })).data;
    t.app.db.insert('appointments', { id: `bn${++n}`, location_id: loc, calendar_id: other1.id, contact_id: null, title: 'Termin', start_at: at('10:00'), end_at: at('11:00'), status: 'confirmed', notes: '', source: 'manuell', manage_token: `tok${n}`, created_at: new Date().toISOString(), assignee_id: ids.ben });
    const s = (await slotsOf(cal.slug)).slots;
    expect(s).toContain(at('09:00'));
    expect(s).not.toContain(at('10:00'));
    events.length = 0;
    const r = (await book(cal.slug, at('09:00'))).data;
    expect(r.hosts.sort()).toEqual(['Anna Schmidt', 'Ben Weber']);
    expect(memberIds(appt(r.id)).sort()).toEqual([ids.anna, ids.ben].sort());
    await settle();
    const ev = events.find((e) => e.type === 'appointment.booked' && e.data.appointment.id === r.id)!;
    expect(ev.data.appointment.hosts.map((h: any) => h.name).sort()).toEqual(['Anna Schmidt', 'Ben Weber']);
    // both are busy now – at that time and in a second collective of the same people
    const again = await makeCal('Kollektiv 2', { kind: 'collective' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    expect((await slotsOf(again.slug)).slots).not.toContain(at('09:00'));
    expect((await book(cal.slug, at('10:00'))).status).toBe(409);
    expect(pushes.filter((p) => p.kind === 'booking' && p.tag === `booking-${r.id}`)[0].userIds.sort()).toEqual([ids.anna, ids.ben].sort());
  });
});

describe('questions', () => {
  const Q = [
    { id: 'anliegen', label: 'Worum geht es?', type: 'text', required: true },
    { id: 'terminart', label: 'Art', type: 'choice', options: ['Erstgespräch', 'Folgetermin'], required: true },
    { id: 'extras', label: 'Extras', type: 'multi', options: ['Parkplatz', 'Dolmetscher', 'Barrierefrei'] },
    { id: 'agbok', label: 'Ich akzeptiere die Teilnahmebedingungen', type: 'checkbox', required: true },
  ];

  it('are asked on the page, checked on the server and stored with the appointment and in its notes', async () => {
    const cal = await makeCal('Fragen', { kind: 'single', questions: Q });
    const page = (await t.api.get(`/book/${cal.slug}`)).data as string;
    expect(page).toContain('id="questions"');
    expect(page).toContain('Worum geht es?');
    expect(page).toContain('Termin buchen');
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('for="f-email"');
    expect((await book(cal.slug, at('10:00'), { answers: { terminart: 'Erstgespräch', agbok: true } })).data.error).toMatch(/Worum geht es/);
    expect((await book(cal.slug, at('10:00'), { answers: { anliegen: 'x', terminart: 'Etwas anderes', agbok: true } })).data.error).toMatch(/Ungültige Auswahl/);
    expect((await book(cal.slug, at('10:00'), { answers: { anliegen: 'x', terminart: 'Erstgespräch', agbok: false } })).data.error).toMatch(/bestätigen/);
    const ok = await book(cal.slug, at('10:00'), { notes: 'Bitte pünktlich', answers: { anliegen: 'Steuern', terminart: 'Erstgespräch', extras: ['Parkplatz', 'Dolmetscher'], agbok: true, fremd: 'ignoriert' } });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const row = appt(ok.data.id);
    expect(JSON.parse(row.answers)).toEqual([
      { id: 'anliegen', label: 'Worum geht es?', value: 'Steuern' },
      { id: 'terminart', label: 'Art', value: 'Erstgespräch' },
      { id: 'extras', label: 'Extras', value: 'Parkplatz, Dolmetscher' },
      { id: 'agbok', label: 'Ich akzeptiere die Teilnahmebedingungen', value: 'Ja' },
    ]);
    expect(row.notes).toContain('Bitte pünktlich');
    expect(row.notes).toContain('Worum geht es?: Steuern');
    expect(row.notes).not.toContain('ignoriert');
  });

  it('cannot be skipped through the old API; staff may book without the required answers', async () => {
    const cal = await makeCal('Pflicht', { kind: 'single', questions: Q });
    const old = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start: at('10:00'), first_name: 'Alt', email: 'alt2@example.com' });
    expect(old.status).toBe(400);
    expect(old.data.error).toMatch(/Buchungsseite/);
    const staff = await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('10:00'), first_name: 'Staff', email: 'staff2@example.com' });
    expect(staff.status, JSON.stringify(staff.data)).toBe(200);
    const manual = await t.api.post('/api/appointments', { calendar_id: cal.id, start: at('11:00'), contact: { email: 'm@example.com', first_name: 'M' } });
    expect(manual.status).toBe(200);
  });

  it('validates the settings in the editor', async () => {
    const cal = await makeCal('Editor', { kind: 'single' });
    const bad = await t.api.put(`/api/team-calendars/${cal.id}`, { config: { questions: [{ label: 'Wahl', type: 'choice', options: ['a'] }] } });
    expect(bad.status).toBe(400);
    const ok = await t.api.put(`/api/team-calendars/${cal.id}`, { config: { questions: [{ label: 'Wahl', type: 'choice', options: 'a\nb\n a ' }] } });
    expect(ok.data.config.questions[0]).toMatchObject({ label: 'Wahl', options: ['a', 'b'], required: false });
    expect(ok.data.config.questions[0].id).toMatch(/^[A-Za-z0-9_-]{4,40}$/);
  });

  it('escapes everything on the page', async () => {
    const cal = await makeCal('<b>XSS</b>', { kind: 'single', policy_text: '<script>alert(1)</script>', questions: [{ label: '"><img src=x onerror=alert(1)>', type: 'text' }] }, [], { description: '<script>alert(2)</script>' });
    const page = (await t.api.get(`/book/${cal.slug}`)).data as string;
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('<b>XSS</b>');
    expect(page).not.toMatch(/<img src=x/);
    expect(page).toContain('\\u003cimg');
  });
});

describe('routing forms', () => {
  it('lead the visitor to the calendar of their answer and keep the answer with the booking', async () => {
    const sales = await makeCal('Vertrieb', { kind: 'single', questions: [] });
    const support = await makeCal('Support', { kind: 'round_robin' }, [{ user_id: ids.ben }]);
    const r = await t.api.post('/api/team-routing', { name: 'Anliegen', question: 'Wobei können wir helfen?', options: [{ label: 'Ich möchte ein Angebot', calendar_id: sales.id }, { label: 'Ich brauche Hilfe', calendar_id: support.id }] });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.url).toContain('/book/r/anliegen');
    const page = (await t.api.get(`/book/r/${r.data.slug}`)).data as string;
    expect(page).toContain('Wobei können wir helfen?');
    expect(page).toContain('Ich brauche Hilfe');
    expect(page).toContain(`data-cal="${support.slug}"`);
    expect(page).toContain('<fieldset>');
    const via = `${r.data.slug}:${r.data.options[1].id}`;
    const booked = await book(support.slug, at('10:00'), { via });
    expect(booked.status, JSON.stringify(booked.data)).toBe(200);
    expect(appt(booked.data.id).notes).toContain('Wobei können wir helfen?: Ich brauche Hilfe');
    expect(JSON.parse(appt(booked.data.id).answers)).toEqual([{ id: 'route', label: 'Wobei können wir helfen?', value: 'Ich brauche Hilfe' }]);
    // a forged answer is ignored
    const forged = await book(support.slug, at('11:00'), { via: `${r.data.slug}:gibtsnicht` });
    expect(appt(forged.data.id).answers).toBe('[]');
    // management: validation, update, delete, isolation
    expect((await t.api.post('/api/team-routing', { name: 'x', options: [] })).status).toBe(400);
    expect((await t.api.post('/api/team-routing', { name: 'x', options: [{ label: 'a', calendar_id: 'fremd' }] })).data.error).toMatch(/Kalender nicht gefunden/);
    expect((await t.api.patch(`/api/team-routing/${r.data.id}`, { active: false })).data.active).toBe(false);
    expect((await t.api.raw(`/book/r/${r.data.slug}`)).status).toBe(404);
    t.api.setLocation(other);
    expect((await t.api.patch(`/api/team-routing/${r.data.id}`, { name: 'geklaut' })).status).toBe(404);
    expect(((await t.api.get('/api/team-routing')).data as any[]).length).toBe(0);
    t.api.setLocation(loc);
    expect((await t.api.del(`/api/team-routing/${r.data.id}`)).status).toBe(200);
  });
});

describe('video links', () => {
  it('Google Meet: made in the host\'s connected calendar, in the appointment, the e-mail, the ICS file and the app', async () => {
    googleMeet = 'ok';
    userConn(ids.anna, 'google', { target_calendar: 'work@example.com' });
    const cal = await makeCal('Meet', { kind: 'round_robin', video: 'meet' }, [{ user_id: ids.anna }], { settings: { confirmation_email: true, confirmation_subject: 'Termin', confirmation_body: '{{calendar.meeting_location}}' } });
    outCalls.length = 0;
    const r = (await book(cal.slug, at('10:00'))).data;
    expect(r.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    const post = outCalls.find((c) => c.method === 'POST' && /\/events\?/.test(c.url))!;
    expect(post.url).toContain('/calendars/work%40example.com/events');
    expect(post.url).toContain('conferenceDataVersion=1');
    expect(post.body.conferenceData.createRequest.conferenceSolutionKey.type).toBe('hangoutsMeet');
    expect(post.body.summary).toContain('Meet');
    expect(post.body.id).toMatch(/^pghl/);
    const row = appt(r.id);
    expect(row.meeting_url).toBe('https://meet.google.com/abc-defg-hij');
    expect(JSON.parse(row.video_ref)).toMatchObject({ provider: 'meet', event_id: post.body.id });
    await settle();
    expect(t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND source = 'Terminbestätigung'`, row.contact_id)!.body).toContain('https://meet.google.com/abc-defg-hij');
    const ics = (await t.api.get(`/book/ics/${row.manage_token}`)).data as string;
    expect(ics).toContain('LOCATION:https://meet.google.com/abc-defg-hij');
    const mobile = (await t.api.get(`/api/appointments?calendar_id=${cal.id}`)).data.find((a: any) => a.id === r.id);
    expect(mobile.meeting_url).toBe('https://meet.google.com/abc-defg-hij');
    // cancelling removes the event again
    outCalls.length = 0;
    expect((await t.api.post(`/api/public/team-calendars/manage/${row.manage_token}/cancel`, {})).status).toBe(200);
    await settle();
    expect(outCalls.some((c) => c.method === 'DELETE' && c.url.includes(post.body.id))).toBe(true);
  });

  it('Meet that is still being made is asked for again and sent to the customer when it exists', async () => {
    googleMeet = 'none';
    userConn(ids.anna, 'google', {});
    const cal = await makeCal('Meet spät', { kind: 'round_robin', video: 'meet' }, [{ user_id: ids.anna }]);
    const r = (await book(cal.slug, at('11:00'))).data;
    expect(r.meetingUrl).toBe('');
    expect(appt(r.id).meeting_state).toBe('pending');
    googleMeet = 'ok'; // Google has made the link by now
    await tickAll();
    expect(appt(r.id)).toMatchObject({ meeting_url: 'https://meet.google.com/late-late-late', meeting_state: '' });
    expect(t.app.db.get<any>(`SELECT body FROM messages WHERE contact_id = ? AND subject LIKE 'Dein Video-Link%'`, appt(r.id).contact_id)!.body).toContain('late-late-late');
    googleMeet = 'ok';
  });

  it('Microsoft Teams: an online meeting in the host\'s Outlook calendar', async () => {
    userConn(ids.ben, 'microsoft', { target_calendar: 'AQMkCAL1' });
    const cal = await makeCal('Teams', { kind: 'round_robin', video: 'teams' }, [{ user_id: ids.ben }]);
    outCalls.length = 0;
    const r = (await book(cal.slug, at('12:00'))).data;
    expect(r.meetingUrl).toBe('https://teams.microsoft.com/l/meetup-join/abc');
    const post = outCalls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://graph.microsoft.com/v1.0/me/calendars/AQMkCAL1/events');
    expect(post.body).toMatchObject({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' });
  });

  it('Zoom through the Zoom connector; without it the fixed place stands in and the team hears why', async () => {
    const cal = await makeCal('Zoom', { kind: 'single', video: 'zoom' }, [], { settings: { meeting_location: 'https://meet.jit.si/ersatz' } });
    const failed = (await book(cal.slug, at('13:00'))).data;
    expect(appt(failed.id)).toMatchObject({ meeting_url: 'https://meet.jit.si/ersatz', meeting_state: 'failed' });
    const calls: any[] = [];
    t.app.services.connectorConfig = (_l: string, key: string) => (key === 'zoom' ? { account_id: 'a', client_id: 'c', client_secret: 's' } : null);
    t.app.services.workflowActions = { ...t.app.services.workflowActions, zoom_create_meeting: async (run: any, step: any) => (calls.push({ run, step }), { result: 'ok', vars: { zoom_join_url: 'https://zoom.us/j/123456', zoom_meeting_id: '123456' } }) };
    const ok = (await book(cal.slug, at('14:00'))).data;
    expect(ok.meetingUrl).toBe('https://zoom.us/j/123456');
    expect(calls[0].step).toMatchObject({ topic: cal.name, when: 'at', date: at('14:00'), duration: 60 });
    delete t.app.services.connectorConfig;
  });

  it('a fixed place or link is simply the calendar\'s place', async () => {
    const cal = await makeCal('Fester Ort', { kind: 'single', video: 'static' }, [], { settings: { meeting_location: 'Praxis, Hauptstraße 1' } });
    const r = (await book(cal.slug, at('09:00'))).data;
    expect(r.meetingUrl).toBe('Praxis, Hauptstraße 1');
    expect(appt(r.id).meeting_state).toBe('');
  });
});

describe('pay when booking', () => {
  it('holds the slot, sends the visitor to Stripe, books only after the payment, and writes a paid invoice', async () => {
    const cal = await makeCal('Bezahlt', { kind: 'round_robin', payment: { mode: 'full', amount_cents: 11900, currency: 'EUR', tax_rate: 19, title: 'Beratung' }, policy_text: 'Kostenlos stornierbar bis 24 Stunden vorher.', cancel_cutoff_hours: 24 }, [{ user_id: ids.anna }]);
    const page = (await t.api.get(`/book/${cal.slug}`)).data as string;
    expect(page).toContain('Preis 119,00');
    expect(page).toContain('Kostenlos stornierbar bis 24 Stunden vorher.');
    expect(page).toContain('Weiter zur Zahlung');
    // the old API cannot get around the payment
    const old = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start: at('10:00'), first_name: 'Alt', email: 'alt3@example.com' });
    expect(old.status).toBe(400);
    expect(old.data.error).toMatch(/kostenpflichtig/);
    stripeCalls.length = 0;
    events.length = 0;
    const r = await addHold(cal.slug, at('10:00'));
    expect(r).toMatchObject({ status: 'payment_required', due_cents: 11900, currency: 'EUR' });
    expect(r.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    const call = stripeCalls.find((c) => c.path === '/v1/checkout/sessions' && c.method === 'POST')!;
    expect(call.params.get('line_items[0][price_data][unit_amount]')).toBe('11900');
    expect(call.params.get('line_items[0][price_data][currency]')).toBe('eur');
    expect(call.params.get('mode')).toBe('payment');
    expect(call.params.get('metadata[teamcal_hold]')).toBe(holdOf(r.hold_token).id);
    expect(call.params.get('metadata[location_id]')).toBe(loc);
    expect(call.params.get('success_url')).toContain(`/book/paid/${r.hold_token}?session_id={CHECKOUT_SESSION_ID}`);
    expect(Number(call.params.get('expires_at'))).toBeGreaterThan(Date.now() / 1000 + 30 * 60);
    // no appointment yet, but the time is taken
    expect(t.app.db.all('SELECT * FROM appointments WHERE calendar_id = ?', cal.id)).toEqual([]);
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('10:00'));
    expect((await book(cal.slug, at('10:00'))).status).toBe(409);
    // the visitor is back from Stripe before the webhook: the page asks Stripe and finds nothing paid yet
    const pending = (await t.api.get(`/api/public/team-calendars/hold/${r.hold_token}?session_id=${holdOf(r.hold_token).session_id}`)).data;
    expect(pending).toMatchObject({ status: 'pending', slug: cal.slug });
    expect(pending.checkoutUrl).toBe(r.checkout_url);
    // Stripe confirms
    expect(await pay(holdOf(r.hold_token).session_id)).toBe(200);
    const hold = holdOf(r.hold_token);
    expect(hold).toMatchObject({ status: 'paid' });
    const a = appt(hold.appointment_id);
    expect(a).toMatchObject({ status: 'confirmed', assignee_id: ids.anna });
    expect(JSON.parse(a.payment)).toMatchObject({ status: 'paid', mode: 'full', amount_cents: 11900, currency: 'EUR', invoice_id: hold.invoice_id });
    const inv = t.app.db.get<any>('SELECT * FROM invoices WHERE id = ?', hold.invoice_id)!;
    expect(inv).toMatchObject({ status: 'paid', total_cents: 11900, contact_id: a.contact_id });
    expect(JSON.parse(inv.items)[0]).toMatchObject({ name: 'Beratung', tax_rate: 19 });
    expect(events.some((e) => e.type === 'invoice.paid' && e.data.invoice.id === inv.id)).toBe(true);
    expect(events.some((e) => e.type === 'appointment.booked' && e.data.appointment.payment?.status === 'paid')).toBe(true);
    expect(t.app.db.get<any>('SELECT * FROM stripe_checkouts WHERE invoice_id = ?', inv.id)).toMatchObject({ status: 'paid', payment_intent: expect.stringMatching(/^pi_/) });
    // a second webhook for the same payment changes nothing
    const count = t.app.db.all('SELECT id FROM appointments WHERE calendar_id = ?', cal.id).length;
    await pay(holdOf(r.hold_token).session_id);
    expect(t.app.db.all('SELECT id FROM appointments WHERE calendar_id = ?', cal.id)).toHaveLength(count);
    // the return page now shows the confirmed appointment
    const done = (await t.api.get(`/api/public/team-calendars/hold/${r.hold_token}`)).data;
    expect(done).toMatchObject({ status: 'confirmed', manageUrl: expect.stringContaining('/book/manage/') });
    const paidPage = (await t.api.get(`/book/paid/${r.hold_token}?session_id=${hold.session_id}`)).data as string;
    expect(paidPage).toContain('Wir bestätigen deine Zahlung');
  });

  it('confirms when the customer comes back before the webhook (Stripe is asked)', async () => {
    const cal = await makeCal('Rückkehr', { kind: 'single', payment: { mode: 'full', amount_cents: 5000 } });
    const r = await addHold(cal.slug, at('11:00'));
    const sid = holdOf(r.hold_token).session_id;
    Object.assign(sessions.get(sid), { payment_status: 'paid', status: 'complete' });
    const status = (await t.api.get(`/api/public/team-calendars/hold/${r.hold_token}?session_id=${sid}`)).data;
    expect(status).toMatchObject({ status: 'confirmed' });
    expect(appt(holdOf(r.hold_token).appointment_id)).toMatchObject({ status: 'confirmed' });
    // somebody else's session id does not confirm anything
    const r2 = await addHold(cal.slug, at('12:00'));
    const foreign = await t.api.get(`/api/public/team-calendars/hold/${r2.hold_token}?session_id=${sid}`);
    expect(foreign.data.status).toBe('pending');
  });

  it('a deposit charges the deposit only and says what is left', async () => {
    const cal = await makeCal('Anzahlung', { kind: 'single', payment: { mode: 'deposit', amount_cents: 20000, deposit_cents: 5000, title: 'Workshop' } });
    expect(((await t.api.get(`/book/${cal.slug}`)).data as string)).toContain('Anzahlung 50,00');
    const r = await addHold(cal.slug, at('13:00'));
    expect(r.due_cents).toBe(5000);
    expect(stripeCalls.at(-1)!.params.get('line_items[0][price_data][product_data][name]')).toBe('Anzahlung: Workshop');
    await pay(holdOf(r.hold_token).session_id);
    const hold = holdOf(r.hold_token);
    expect(t.app.db.get<any>('SELECT total_cents FROM invoices WHERE id = ?', hold.invoice_id)!.total_cents).toBe(5000);
    const manage = (await t.api.get(`/book/manage/${appt(hold.appointment_id).manage_token}`)).data as string;
    expect(manage).toContain('Anzahlung');
    expect(manage).toContain('150,00');
  });

  it('releases the slot when nobody pays; a payment after that is honoured while the slot is free, refunded when it is taken', async () => {
    const cal = await makeCal('Ablauf', { kind: 'single', payment: { mode: 'full', amount_cents: 5000 } });
    const r = await addHold(cal.slug, at('14:00'));
    const sid = holdOf(r.hold_token).session_id;
    t.app.db.run(`UPDATE teamcal_holds SET expires_at = ? WHERE token = ?`, new Date(Date.now() - 1000).toISOString(), r.hold_token);
    stripeCalls.length = 0;
    await tickAll();
    expect(holdOf(r.hold_token).status).toBe('expired');
    expect(stripeCalls.some((c) => c.path === `/v1/checkout/sessions/${sid}/expire`)).toBe(true);
    expect((await slotsOf(cal.slug)).slots).toContain(at('14:00'));
    // late payment, the slot is still free → booked
    await pay(sid);
    expect(holdOf(r.hold_token).status).toBe('paid');
    expect(appt(holdOf(r.hold_token).appointment_id).status).toBe('confirmed');
    // second case: hold expires, somebody else books the slot, then the first payment arrives → refund
    const r2 = await addHold(cal.slug, at('15:00'));
    const sid2 = holdOf(r2.hold_token).session_id;
    t.app.db.run(`UPDATE teamcal_holds SET expires_at = ? WHERE token = ?`, new Date(Date.now() - 1000).toISOString(), r2.hold_token);
    await tickAll();
    const other1 = await addHold(cal.slug, at('15:00'));
    await pay(holdOf(other1.hold_token).session_id);
    stripeCalls.length = 0;
    await pay(sid2);
    const late = holdOf(r2.hold_token);
    expect(late.status).toBe('refunded');
    expect(late.appointment_id).toBeNull();
    const refund = stripeCalls.find((c) => c.path === '/v1/refunds')!;
    expect(refund.params.get('payment_intent')).toBe(sessions.get(sid2).payment_intent);
    expect(t.app.db.all('SELECT * FROM appointments WHERE calendar_id = ? AND start_at = ?', cal.id, at('15:00'))).toHaveLength(1);
  });

  it('a failed or expired Checkout releases the hold', async () => {
    const cal = await makeCal('Abbruch', { kind: 'single', payment: { mode: 'full', amount_cents: 5000 } });
    const r = await addHold(cal.slug, at('16:00'));
    const s = sessions.get(holdOf(r.hold_token).session_id)!;
    const raw = JSON.stringify({ id: `evt_${++seq}`, object: 'event', type: 'checkout.session.expired', data: { object: s } });
    await t.api.raw(`/hooks/stripe/${loc}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(raw, WHSEC) }, body: raw });
    await settle();
    expect(holdOf(r.hold_token).status).toBe('expired');
    expect((await slotsOf(cal.slug)).slots).toContain(at('16:00'));
  });

  it('refunds a cancellation in time automatically, only tells the team when the policy is manual or the time is up', async () => {
    const auto = await makeCal('Erstattung', { kind: 'single', payment: { mode: 'full', amount_cents: 8000, refund: 'auto' }, cancel_cutoff_hours: 24 });
    const r = await addHold(auto.slug, at('09:00', day2));
    await pay(holdOf(r.hold_token).session_id);
    const a = appt(holdOf(r.hold_token).appointment_id);
    stripeCalls.length = 0;
    const c = await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/cancel`, {});
    expect(c.status, JSON.stringify(c.data)).toBe(200);
    expect(c.data).toMatchObject({ status: 'cancelled', refund: 'refunded' });
    expect(stripeCalls.find((x) => x.path === '/v1/refunds')!.params.get('payment_intent')).toBe(JSON.parse(a.payment).payment_intent);
    expect(JSON.parse(appt(a.id).payment).status).toBe('refunded');
    expect(t.app.db.get<any>('SELECT status FROM invoices WHERE id = ?', JSON.parse(a.payment).invoice_id)!.status).toBe('void');
    // manual policy
    const manual = await makeCal('Manuell', { kind: 'single', payment: { mode: 'full', amount_cents: 8000, refund: 'manual' } });
    const r2 = await addHold(manual.slug, at('10:00', day2));
    await pay(holdOf(r2.hold_token).session_id);
    const a2 = appt(holdOf(r2.hold_token).appointment_id);
    stripeCalls.length = 0;
    const c2 = await t.api.post(`/api/public/team-calendars/manage/${a2.manage_token}/cancel`, {});
    expect(c2.data.refund).toBe('manual');
    expect(stripeCalls.some((x) => x.path === '/v1/refunds')).toBe(false);
    expect(JSON.parse(appt(a2.id).payment).status).toBe('refund_pending');
    // staff cancels with a refund
    const r3 = await addHold(manual.slug, at('11:00', day2));
    await pay(holdOf(r3.hold_token).session_id);
    const a3 = appt(holdOf(r3.hold_token).appointment_id);
    const c3 = await t.api.post(`/api/team-calendars/appointments/${a3.id}/cancel`, { refund: true, reason: 'Krankheit' });
    expect(c3.data.refund).toBe('refunded');
    expect(appt(a3.id).cancel_reason).toBe('Krankheit');
    // a failing refund tells the team, never the customer
    refundFails = true;
    const r4 = await addHold(auto.slug, at('12:00', day2));
    await pay(holdOf(r4.hold_token).session_id);
    const c4 = await t.api.post(`/api/public/team-calendars/manage/${appt(holdOf(r4.hold_token).appointment_id).manage_token}/cancel`, {});
    expect(c4.data.refund).toBe('manual');
    refundFails = false;
  });

  it('works only with Stripe connected', async () => {
    const cal = await makeCal('Ohne Stripe heute', { kind: 'single', payment: { mode: 'full', amount_cents: 5000 } });
    t.app.db.run('DELETE FROM stripe_accounts WHERE location_id = ?', loc);
    const r = await book(cal.slug, at('09:00'));
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/Online-Zahlung/);
    expect((await slotsOf(cal.slug)).slots).toContain(at('09:00'));
    expect((await t.api.put('/api/stripe', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
  });

  it('the team can waive the payment (and the audit log says who booked)', async () => {
    const cal = await makeCal('Erlassen', { kind: 'single', payment: { mode: 'full', amount_cents: 5000 } });
    const link = await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('09:00'), email: 'link@example.com', first_name: 'Link' });
    expect(link.data).toMatchObject({ status: 'payment_required' });
    const waived = await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('10:00'), email: 'frei@example.com', first_name: 'Frei', payment: 'waive' });
    expect(waived.data.status).toBe('confirmed');
    expect(JSON.parse(appt(waived.data.appointment.id).payment)).toMatchObject({ status: 'waived' });
    expect(audit('team-calendars.%').length).toBeGreaterThan(0);
  });
});

describe('cancel and reschedule', () => {
  it('shows the manage page with the rules; customers reschedule within the cutoff, keeping the host; the old time is free again', async () => {
    const cal = await makeCal('Verschieben', { kind: 'round_robin', policy_text: 'Bis 2 Stunden vorher.', reschedule_cutoff_hours: 2 }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const r = (await book(cal.slug, at('10:00', day2))).data;
    const a = appt(r.id);
    const page = (await t.api.get(`/book/manage/${a.manage_token}`)).data as string;
    expect(page).toContain('Termin verschieben');
    expect(page).toContain('Termin absagen');
    expect(page).toContain('Bis 2 Stunden vorher.');
    expect(page).toContain('role="alertdialog"');
    const slots = (await t.api.get(`/api/public/team-calendars/manage/${a.manage_token}/slots?from=${day2}&days=1`)).data.days[0].slots as string[];
    expect(slots).toContain(at('10:00', day2)); // its own time stays free for it
    events.length = 0;
    const mv = await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/reschedule`, { start: at('13:00', day2) });
    expect(mv.status, JSON.stringify(mv.data)).toBe(200);
    expect(appt(r.id)).toMatchObject({ start_at: at('13:00', day2), assignee_id: a.assignee_id, reminder_sent: 0 });
    await settle();
    expect(events.find((e) => e.type === 'appointment.rescheduled')!.data).toMatchObject({ previousStart: at('10:00', day2), by: 'customer' });
    expect((await slotsOf(cal.slug, day2)).slots).toContain(at('10:00', day2));
    expect((await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/reschedule`, { start: 'gestern' })).status).toBe(400);
    expect((await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/reschedule`, { start: at('03:00', day2) })).status).toBe(409);
    // the host moves to the other member when theirs is busy
    const other1 = (await t.api.post('/api/calendars', { name: 'Privat', duration: 60, availability: every, min_notice: 0 })).data;
    t.app.db.insert('appointments', { id: `bn${++n}`, location_id: loc, calendar_id: other1.id, contact_id: null, title: 'Termin', start_at: at('15:00', day2), end_at: at('16:00', day2), status: 'confirmed', notes: '', source: 'manuell', manage_token: `tok${n}`, created_at: new Date().toISOString(), assignee_id: a.assignee_id });
    const mv2 = await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/reschedule`, { start: at('15:00', day2) });
    expect(mv2.status).toBe(200);
    expect(appt(r.id).assignee_id).not.toBe(a.assignee_id);
  });

  it('enforces the cutoff and the switches for customers, not for the team', async () => {
    const cal = await makeCal('Frist', { kind: 'single', cancel_cutoff_hours: 24 * 400, reschedule_cutoff_hours: 24 * 400 });
    const r = (await book(cal.slug, at('10:00', day2))).data;
    const a = appt(r.id);
    const page = (await t.api.get(`/book/manage/${a.manage_token}`)).data as string;
    expect(page).not.toContain('id="cancel"');
    expect(page).not.toContain('id="move"');
    expect(page).toContain('Online absagen geht bis');
    const c = await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/cancel`, {});
    expect(c.status).toBe(403);
    expect(c.data.error).toMatch(/bis \d+ Stunden vor dem Termin/);
    expect((await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/reschedule`, { start: at('11:00', day2) })).status).toBe(403);
    expect((await t.api.post(`/api/public/appointments/${a.manage_token}/cancel`)).status).toBe(403); // the old cancel link follows the rules
    expect((await t.api.post(`/api/team-calendars/appointments/${a.id}/reschedule`, { start: at('11:00', day2) })).status).toBe(200);
    expect((await t.api.post(`/api/team-calendars/appointments/${a.id}/cancel`, { reason: 'Team sagt ab' })).data.status).toBe('cancelled');
    const off = await makeCal('Nicht online', { kind: 'single', allow_cancel: false, allow_reschedule: false });
    const r2 = appt((await book(off.slug, at('10:00', day2))).data.id);
    expect((await t.api.post(`/api/public/team-calendars/manage/${r2.manage_token}/cancel`, {})).status).toBe(403);
    expect(((await t.api.get(`/book/manage/${r2.manage_token}`)).data as string)).toContain('kann online nicht abgesagt werden');
  });

  it('a cancelled appointment frees the time, tells the customer and the team, and is cancelled only once', async () => {
    const cal = await makeCal('Absage', { kind: 'round_robin' }, [{ user_id: ids.anna }]);
    const r = (await book(cal.slug, at('09:00', day2))).data;
    const a = appt(r.id);
    pushes.length = 0;
    events.length = 0;
    const c = await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/cancel`, { reason: 'Keine Zeit' });
    expect(c.data).toMatchObject({ ok: true, status: 'cancelled', refund: 'none' });
    await settle();
    expect(appt(r.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'Keine Zeit' });
    expect(events.filter((e) => e.type === 'appointment.status_changed')).toHaveLength(1);
    expect(pushes.some((p) => p.kind === 'booking' && /abgesagt/.test(p.title) && p.userIds?.includes(ids.anna))).toBe(true);
    expect((await slotsOf(cal.slug, day2)).slots).toContain(at('09:00', day2));
    await t.api.post(`/api/public/team-calendars/manage/${a.manage_token}/cancel`, {});
    await settle();
    expect(events.filter((e) => e.type === 'appointment.status_changed')).toHaveLength(1);
    expect(((await t.api.get(`/book/manage/${a.manage_token}`)).data as string)).toContain('Neuen Termin buchen');
    expect((await t.api.post('/api/public/team-calendars/manage/unbekannt/cancel', {})).status).toBe(404);
  });
});

describe('group classes', () => {
  it('seats per start, a full class closes (waiting list on request), a cancelled seat goes to the first in line', async () => {
    const cal = await makeCal('Klasse', { kind: 'group', capacity: 2, waitlist: true }, [{ user_id: ids.anna }]);
    const s0 = await slotsOf(cal.slug);
    expect(s0.slots).toContain(at('10:00'));
    expect(s0.left[at('10:00')]).toBe(2);
    const a = (await book(cal.slug, at('10:00'))).data;
    expect((await slotsOf(cal.slug)).left[at('10:00')]).toBe(1);
    const b = (await book(cal.slug, at('10:00'))).data;
    expect(memberIds(appt(a.id))).toEqual([ids.anna]);
    expect(memberIds(appt(b.id))).toEqual([ids.anna]);
    const s2 = await slotsOf(cal.slug);
    expect(s2.slots).not.toContain(at('10:00'));
    expect(s2.full).toContain(at('10:00'));
    // another class that overlaps the 10:00 class is not offered, 11:00 is
    expect(s2.slots).toContain(at('11:00'));
    const full = await book(cal.slug, at('10:00'));
    expect(full.status).toBe(409);
    expect(full.data.error).toMatch(/ausgebucht/);
    // the waiting list
    const w = await book(cal.slug, at('10:00'), { waitlist: true, email: 'warte@example.com' });
    expect(w.data.status).toBe('waitlisted');
    expect((await book(cal.slug, at('10:00'), { waitlist: true, email: 'warte@example.com' })).status).toBe(400);
    expect((await book(cal.slug, at('11:00'), { waitlist: true })).data.error).toMatch(/noch Plätze frei/);
    expect(((await t.api.get(`/api/team-calendars/${cal.id}/waitlist`)).data as any[]).map((x) => x.contact.email)).toEqual(['warte@example.com']);
    // a seat is freed → offer by e-mail; the link books it
    await t.api.post(`/api/public/team-calendars/manage/${appt(a.id).manage_token}/cancel`, {});
    await settle();
    const offer = t.app.db.get<any>('SELECT * FROM teamcal_waitlist WHERE calendar_id = ?', cal.id)!;
    expect(offer.status).toBe('offered');
    const mail = t.app.db.get<any>(`SELECT body FROM messages WHERE source = 'Warteliste' ORDER BY created_at DESC`)!;
    expect(mail.body).toContain(`/book/waitlist/${offer.token}`);
    const page = (await t.api.get(`/book/waitlist/${offer.token}`)).data as string;
    expect(page).toContain('Platz jetzt buchen');
    const booked = await t.api.post(`/api/public/team-calendars/waitlist/${offer.token}/book`, {});
    expect(booked.status, JSON.stringify(booked.data)).toBe(200);
    expect(t.app.db.get<any>('SELECT status, appointment_id FROM teamcal_waitlist WHERE id = ?', offer.id)).toMatchObject({ status: 'booked' });
    expect((await t.api.post(`/api/public/team-calendars/waitlist/${offer.token}/book`, {})).status).toBe(200); // idempotent: it is booked
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('10:00'));
    expect((await t.api.get('/book/waitlist/gibtsnicht')).status).toBe(404);
  });

  it('a seat offered to the waiting list of a paid class is paid for first (no way around the payment)', async () => {
    const cal = await makeCal('Kurs Warteliste bezahlt', { kind: 'group', capacity: 1, waitlist: true, payment: { mode: 'full', amount_cents: 2500 } }, [{ user_id: ids.anna }]);
    const first = await t.api.post(`/api/team-calendars/${cal.id}/book`, { start: at('09:00'), email: 'erste@example.com', first_name: 'Erste', payment: 'waive' });
    expect(first.data.status, JSON.stringify(first.data)).toBe('confirmed');
    expect((await book(cal.slug, at('09:00'), { waitlist: true, email: 'wartet@example.com' })).data.status).toBe('waitlisted');
    await t.api.post(`/api/team-calendars/appointments/${first.data.appointment.id}/cancel`, {});
    await settle();
    const offer = t.app.db.get<any>(`SELECT * FROM teamcal_waitlist WHERE calendar_id = ? AND status = 'offered'`, cal.id)!;
    const r = await t.api.post(`/api/public/team-calendars/waitlist/${offer.token}/book`, {});
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.checkout_url).toMatch(/checkout\.stripe\.com/);
    // nothing booked yet, the seat is held for the payment
    expect(t.app.db.all(`SELECT id FROM appointments WHERE calendar_id = ? AND status = 'confirmed'`, cal.id)).toEqual([]);
    expect((await slotsOf(cal.slug)).full).toContain(at('09:00'));
    expect(t.app.db.get<any>('SELECT status FROM teamcal_waitlist WHERE id = ?', offer.id)!.status).toBe('offered');
    const hold = t.app.db.get<any>(`SELECT * FROM teamcal_holds WHERE calendar_id = ? AND status = 'pending'`, cal.id)!;
    await pay(hold.session_id);
    const booked = t.app.db.all<any>(`SELECT * FROM appointments WHERE calendar_id = ? AND status = 'confirmed'`, cal.id);
    expect(booked).toHaveLength(1);
    expect(JSON.parse(booked[0].payment)).toMatchObject({ status: 'paid' });
    expect(t.app.db.get<any>('SELECT status, appointment_id FROM teamcal_waitlist WHERE id = ?', offer.id)).toMatchObject({ status: 'booked', appointment_id: booked[0].id });
  });

  it('group classes can be paid for: held seats count', async () => {
    const cal = await makeCal('Kurs bezahlt', { kind: 'group', capacity: 1, payment: { mode: 'full', amount_cents: 3000 } }, [{ user_id: ids.anna }]);
    const h = await addHold(cal.slug, at('09:00'));
    expect((await slotsOf(cal.slug)).slots).not.toContain(at('09:00'));
    expect((await book(cal.slug, at('09:00'))).status).toBe(409);
    await pay(holdOf(h.hold_token).session_id);
    expect(t.app.db.all('SELECT * FROM appointments WHERE calendar_id = ?', cal.id)).toHaveLength(1);
  });
});

describe('public pages and the booking API', () => {
  it('plain calendars keep their page; team calendars get the server-rendered team page, phone friendly', async () => {
    const plain = (await t.api.post('/api/calendars', { name: 'Schlicht', duration: 30, availability: every, min_notice: 0 })).data;
    expect(((await t.api.get(`/book/${plain.slug}`)).data as string)).toContain("get('ab')");
    const team = await makeCal('Team Seite', { kind: 'round_robin' }, [{ user_id: ids.anna }]);
    const page = (await t.api.get(`/book/${team.slug}`)).data as string;
    expect(page).toContain('name="viewport"');
    expect(page).toContain('lang="de"');
    expect(page).toContain('/api/public/team-calendars/');
    expect(page).toContain('<main');
    expect(page).toContain("q.get('ab')");
    expect(page).toContain('prefers'.slice(0, 0) + 'min-height: 52px');
    // a team calendar with default settings (single, nothing special) still uses the plain page
    const quiet = await makeCal('Ruhig', { kind: 'single' });
    expect(((await t.api.get(`/book/${quiet.slug}`)).data as string)).toContain("get('ab')");
  });

  it('validates the visitor\'s input and keeps bots out', async () => {
    const cal = await makeCal('Eingabe', { kind: 'round_robin' }, [{ user_id: ids.anna }]);
    const post = (b: any) => t.api.post(`/api/public/team-calendars/${cal.slug}/book`, b);
    expect((await post({ start: at('10:00'), first_name: 'A', email: 'kaputt', consent: true })).data.error).toMatch(/E-Mail/);
    expect((await post({ start: at('10:00'), first_name: '', email: 'a@example.com', consent: true })).data.error).toMatch(/Vornamen/);
    expect((await post({ start: at('10:00'), first_name: 'A', email: 'a@example.com' })).data.error).toMatch(/zustimmen/);
    expect((await post({ start: 'morgen', first_name: 'A', email: 'a@example.com', consent: true })).data.error).toMatch(/Startzeit/);
    expect((await post({ start: at('10:00'), first_name: 'A', email: 'a@example.com', consent: true, website: 'http://spam' })).status).toBe(400);
    expect((await post({ start: at('03:00'), first_name: 'A', email: 'a@example.com', consent: true })).status).toBe(409);
    expect((await t.api.post('/api/public/team-calendars/unbekannt/book', form(at('10:00')))).status).toBe(404);
    expect((await t.api.get('/api/public/team-calendars/unbekannt/slots')).status).toBe(404);
    t.app.db.run('UPDATE calendars SET active = 0 WHERE id = ?', cal.id);
    expect((await post(form(at('10:00')))).status).toBe(404);
    expect((await t.api.raw(`/book/${cal.slug}`)).status).toBe(404);
    t.app.db.run('UPDATE calendars SET active = 1 WHERE id = ?', cal.id);
  });

  it('records the A/B visitor and attribution like the plain page', async () => {
    const cal = await makeCal('AB', { kind: 'round_robin' }, [{ user_id: ids.anna }]);
    events.length = 0;
    const r = await book(cal.slug, at('10:00'), { _ab: 'abcdefgh12345', _utm_source: 'newsletter' });
    expect(r.status).toBe(200);
    await settle();
    expect(events.find((e) => e.type === 'appointment.booked')!.data.meta).toMatchObject({ ab: 'abcdefgh12345' });
  });
});

describe('calendar sync', () => {
  it('writes an assigned appointment only into its host\'s calendar, not into every linked calendar of the booking calendar', async () => {
    const cal = await makeCal('Sync', { kind: 'round_robin' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const ca = userConn(ids.anna, 'google', { target_calendar: 'anna@example.com' });
    const cb = userConn(ids.ben, 'google', { target_calendar: 'ben@example.com' });
    for (const c of [ca, cb]) t.app.db.run('INSERT OR IGNORE INTO oauth_calendar_links (connection_id, calendar_id, created_at) VALUES (?, ?, ?)', c, cal.id, new Date().toISOString());
    const r = (await book(cal.slug, at('10:00'))).data;
    expect(appt(r.id).assignee_id).toBe(ids.anna);
    outCalls.length = 0;
    const sa = await anna('POST', `/api/me/calendar-connections/${ca}/sync`);
    expect(sa.status, JSON.stringify(sa.data)).toBe(200);
    const sb = await ben('POST', `/api/me/calendar-connections/${cb}/sync`);
    expect(sb.status, JSON.stringify(sb.data)).toBe(200);
    const writes = outCalls.filter((c) => c.method === 'POST' && /\/events\?/.test(c.url));
    expect(writes.map((w) => decodeURIComponent(w.url))).toEqual([expect.stringContaining('/calendars/anna@example.com/events')]);
    expect(t.app.db.get('SELECT COUNT(*) AS n FROM oauth_event_map WHERE connection_id = ? AND appointment_id = ?', cb, r.id)!.n).toBe(0);
    // a collective appointment goes into the calendars of all its hosts
    const col = await makeCal('Sync Kollektiv', { kind: 'collective' }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    for (const c of [ca, cb]) t.app.db.run('INSERT OR IGNORE INTO oauth_calendar_links (connection_id, calendar_id, created_at) VALUES (?, ?, ?)', c, col.id, new Date().toISOString());
    await book(col.slug, at('13:00'));
    outCalls.length = 0;
    await anna('POST', `/api/me/calendar-connections/${ca}/sync`);
    await ben('POST', `/api/me/calendar-connections/${cb}/sync`);
    const both = outCalls.filter((c) => c.method === 'POST' && /\/events\?/.test(c.url)).map((w) => decodeURIComponent(w.url));
    expect(both.some((u) => u.includes('anna@example.com'))).toBe(true);
    expect(both.some((u) => u.includes('ben@example.com'))).toBe(true);
  });
});

describe('scheduler, people and privacy', () => {
  it('lists availability and out-of-office entries; only the person (or admins and the settings area) change them', async () => {
    const mine = await anna('GET', '/api/team-people');
    expect(mine.status).toBe(200);
    expect(mine.data.find((p: any) => p.name === 'Anna Schmidt')).toMatchObject({ me: true, paused: false });
    expect((await anna('PUT', `/api/team-people/${ids.ben}`, { paused: true })).status).toBe(403);
    expect((await ben('PUT', `/api/team-people/${ids.anna}`, { paused: true })).status).toBe(200); // Ben has the settings area
    expect((await ben('PUT', `/api/team-people/${ids.anna}`, { paused: false })).status).toBe(200);
    expect((await anna('PUT', '/api/team-people/me', { hours: { mon: [['09:00', '17:00']], tue: [['x', 'y']] }, tz: 'Mars/Olympus' })).status).toBe(400);
    const set = await anna('PUT', '/api/team-people/me', { hours: { mon: [['09:00', '17:00']], tue: [['17:00', '09:00']] } });
    expect(set.data.hours).toEqual({ mon: [['09:00', '17:00']] });
    expect((await anna('POST', '/api/team-people/me/away', { start_at: at('09:00'), end_at: at('08:00') })).status).toBe(400);
    const away = (await anna('POST', '/api/team-people/me/away', { start_at: at('09:00'), end_at: at('10:00'), note: 'Arzt' })).data;
    expect((await ben('DELETE', `/api/team-people/away/${away.created.id}`)).status).toBe(200); // settings area
    expect((await t.api.get('/api/team-people/me')).status).toBe(200);
    expect((await cleo('GET', '/api/team-people')).status).toBe(200); // a lookup, readable for everybody in the sub-account
    t.api.setLocation(other);
    expect((await t.api.get(`/api/team-people/${ids.anna}`)).status).toBe(404);
    t.api.setLocation(loc);
    await anna('PUT', '/api/team-people/me', { hours: null });
  });

  it('exports and erases held bookings and waiting-list entries of a contact (GDPR)', async () => {
    const cal = await makeCal('DSGVO', { kind: 'single', payment: { mode: 'full', amount_cents: 5000 } });
    const email = `dsgvo${++n}@example.com`;
    await addHold(cal.slug, at('09:00'), { email });
    const contact = (await t.api.post('/api/contacts', { email, first_name: 'Dora' })).data;
    const exp = (await t.api.get(`/api/contacts/${contact.id}/privacy-export`)).data;
    expect(JSON.stringify(exp)).toContain(email);
    expect(JSON.stringify(exp)).toContain('teamcal_holds');
    const er = await t.api.post(`/api/contacts/${contact.id}/erase`, { confirm: email });
    expect(er.status, JSON.stringify(er.data)).toBe(200);
    expect(t.app.db.all(`SELECT id FROM teamcal_holds WHERE lower(json_extract(contact, '$.email')) = ?`, email)).toEqual([]);
  });
});

describe('MCP tools', () => {
  let rpc = 0;
  const mcp = async (name: string, args: any) => {
    const r = await t.api.raw('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keyA}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }) });
    const j: any = await r.json();
    const text = j.result?.content?.[0]?.text ?? '';
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: !!j.result?.isError, text, data };
  };

  it('has the two tools', () => {
    expect(TEAMCAL_TOOLS.map((x) => x.name)).toEqual(['ghl_calendar_types', 'ghl_book_slot']);
  });

  it('lists the calendar types, the free times with hosts, and books respecting round robin and payment', async () => {
    const rr = await makeCal('MCP RR', { kind: 'round_robin', questions: [{ id: 'grund', label: 'Grund', type: 'text', required: true }] }, [{ user_id: ids.anna }, { user_id: ids.ben }]);
    const paid = await makeCal('MCP Bezahlt', { kind: 'single', payment: { mode: 'full', amount_cents: 6000 } });
    const types = await mcp('ghl_calendar_types', { location_id: loc });
    expect(types.isError, types.text).toBe(false);
    expect(types.data, types.text).not.toBeNull();
    expect(types.data.calendars.find((c: any) => c.id === rr.id)).toMatchObject({ kind: 'round_robin', questions: 1, members: [{ name: 'Anna Schmidt' }, { name: 'Ben Weber' }] });
    expect(types.data.calendars.find((c: any) => c.id === paid.id).payment).toMatchObject({ mode: 'full', amount_cents: 6000 });
    const detail = await mcp('ghl_calendar_types', { location_id: loc, calendar_id: rr.id, from: day, days: 1 });
    expect(detail.data.calendar.questions[0]).toMatchObject({ id: 'grund', required: true });
    const slot = detail.data.days[0].slots[0];
    expect(slot.hosts.map((h: any) => h.name).sort()).toEqual(['Anna Schmidt', 'Ben Weber']);
    const noAnswer = await mcp('ghl_book_slot', { location_id: loc, calendar_id: rr.id, start: slot.start, email: 'mcp@example.com', first_name: 'Mia' });
    expect(noAnswer.isError).toBe(false); // the team books by hand: required answers may stay empty
    expect(noAnswer.data).toMatchObject({ status: 'confirmed', host: expect.stringMatching(/Anna|Ben/) });
    const second = await mcp('ghl_book_slot', { location_id: loc, calendar_id: rr.id, start: slot.start, email: 'mcp2@example.com', first_name: 'Max', answers: { grund: 'Test' }, host_id: ids.ben });
    expect(second.isError, second.text).toBe(false);
    expect(second.data.host).toBe(noAnswer.data.host === 'Anna Schmidt' ? 'Ben Weber' : 'Ben Weber');
    expect((await mcp('ghl_book_slot', { location_id: loc, calendar_id: rr.id, start: slot.start, email: 'mcp3@example.com', first_name: 'Mo' })).isError).toBe(true); // both taken
    const pay1 = await mcp('ghl_book_slot', { location_id: loc, calendar_id: paid.id, start: at('10:00'), email: 'mcp4@example.com', first_name: 'Pia' });
    expect(pay1.data).toMatchObject({ status: 'payment_required', due_cents: 6000 });
    expect(pay1.data.checkout_url).toMatch(/checkout\.stripe\.com/);
    const free = await mcp('ghl_book_slot', { location_id: loc, calendar_id: paid.id, start: at('11:00'), email: 'mcp5@example.com', first_name: 'Pit', payment: 'waive' });
    expect(free.data.status).toBe('confirmed');
    expect((await mcp('ghl_calendar_types', { location_id: other })).isError).toBe(true); // the key belongs to another sub-account
    expect((await mcp('ghl_book_slot', { location_id: other, calendar_id: rr.id, start: slot.start, email: 'x@example.com', first_name: 'X' })).isError).toBe(true);
    expect(t.app.db.all<any>(`SELECT * FROM audit_log WHERE route = 'POST /api/team-calendars/:id/book' AND via = 'mcp'`).length).toBeGreaterThan(0);
  });
});
