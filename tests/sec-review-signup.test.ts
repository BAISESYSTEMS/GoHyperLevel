import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, browser, cloudKit, createStripe } from './cloud-fakes.js';

/**
 * Follow-up of the October 2026 security review, hosted cloud (docs/security-review-2026-10.md):
 * O-1 – nobody can choose the password of an account for an address they do not own (account pre-hijack), and the files anonymous
 * visitors upload through forms count against the plan's media storage.
 */

const stripe = createStripe();
const mails: { to: string; subject: string; text: string; html: string }[] = [];
let t: Awaited<ReturnType<typeof startTestApp>>;
const kit = cloudKit(() => t, stripe, mails);

beforeAll(async () => {
  stripe.install();
  t = await startTestApp({ cloudMode: true });
  await t.setup();
  t.app.services.cloudMailer = async (_l: any, m: any) => (mails.push(m), { status: 'logged' });
  t.app.services.cloudFormMinMs = 0;
  expect((await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC })).status).toBe(200);
}, 120_000);
afterAll(async () => {
  stripe.uninstall();
  await t?.close();
});
beforeEach(() => t.app.services.cloud.resetLimits());

const login = async (email: string, password: string) => (await browser(t.base).api('POST', '/api/auth/login', { email, password })).status;
/** Stripe: the customer finished Checkout and came back – the account exists. */
const pay = async (b: ReturnType<typeof browser>, go: { status: number; location: string }) => {
  expect(go.status).toBe(303);
  const sid = go.location.split('/').pop()!;
  stripe.complete(sid);
  return b.get(`/start/done?session_id=${sid}`);
};

describe('O-1: sign-up pre-hijack', () => {
  it('a password typed into the form by somebody else never becomes the login', async () => {
    // The attacker signs up with the victim's address and a password of their own.
    const { b: attacker, link } = await kit.signUp({ company: 'Opfer GmbH', email: 'opfer@firma.de', password: 'angreifer123' });
    // The victim opens the (unsolicited) link in their own browser: the page asks for a password – the form's one does not count.
    const victim = browser(t.base);
    const page = await victim.get(link);
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="password"');
    expect(page.text).toContain('name="password2"');
    expect(page.text).toMatch(/Ein Passwort, das vorher im Anmeldeformular eingegeben wurde, gilt nicht/);
    // without a password of their own nothing happens
    const bare = await victim.form(link, {});
    expect(bare.status).toBe(400);
    expect(t.app.db.get<any>(`SELECT verified_at FROM cloud_signups WHERE email = 'opfer@firma.de'`).verified_at).toBeNull();
    expect((await victim.form(link, { password: 'opfer-geheim1', password2: 'anders-geheim' })).status).toBe(400);
    const go = await victim.form(link, { password: 'opfer-geheim1', password2: 'opfer-geheim1' });
    expect(go.location).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    // The link was claimed: the attacker's browser (it sent the form) can no longer use it …
    const reuse = await attacker.form(link, {});
    expect(reuse.status).toBe(410);
    expect(reuse.text).toContain('schon benutzt');
    expect((await attacker.get(link)).status).toBe(410);
    // … and is not the browser that gets logged in after the payment.
    const done = await pay(victim, go);
    expect(done.location).toBe('/app');
    const sid = go.location.split('/').pop()!;
    expect((await attacker.get(`/start/done?session_id=${sid}`)).status).toBe(200);
    expect((await attacker.api('GET', '/api/me')).status).toBe(401);
    // The login is the victim's password, never the attacker's.
    expect(await login('opfer@firma.de', 'angreifer123')).toBe(401);
    expect(await login('opfer@firma.de', 'opfer-geheim1')).toBe(200);
  });

  it('a later verification of the same address ends the earlier sign-ups: links, passwords and browser bindings', async () => {
    const { b: attacker, link: early } = await kit.signUp({ company: 'Frueh GmbH', email: 'zwei@firma.de', password: 'angreifer123' });
    const earlyRow = t.app.db.get<any>(`SELECT id FROM cloud_signups WHERE email = 'zwei@firma.de' ORDER BY created_at DESC LIMIT 1`);
    // The real owner signs up in their own browser and verifies there (the form's password counts in the same browser).
    const { b: owner, link } = await kit.signUp({ company: 'Echt GmbH', email: 'zwei@firma.de', password: 'besitzer-123' });
    const done = await pay(owner, await owner.form(link, {}));
    expect(done.location).toBe('/app');
    const old = t.app.db.get<any>('SELECT status, password_hash, verify_hash, browser_hash FROM cloud_signups WHERE id = ?', earlyRow.id);
    expect(old).toMatchObject({ status: 'superseded', password_hash: '', verify_hash: '', browser_hash: '' });
    expect((await attacker.get(early)).status).toBe(410);
    expect((await attacker.form(early, {})).status).toBe(410);
    expect(await login('zwei@firma.de', 'angreifer123')).toBe(401);
    expect(await login('zwei@firma.de', 'besitzer-123')).toBe(200);
  });

  it('answers a known address and a new one alike (the browser binding is no oracle)', async () => {
    await kit.signUp({ company: 'Bekannt GmbH', email: 'bekannt@firma.de' }).then(async ({ b, link }) => pay(b, await b.form(link, {})));
    const ask = async (email: string) => {
      const b = browser(t.base);
      const tok = /name="t" value="([^"]+)"/.exec((await b.get('/start')).text)![1];
      const r = await b.form('/start', { plan: 'team', interval: 'month', company: 'Probe GmbH', email, password: 'geheim1234', agb: '1', avv: '1', datenschutz: '1', business: '1', t: tok, via: 'email' });
      return { status: r.status, cookie: !!r.headers.get('set-cookie'), text: r.text.replace(/name="t" value="[^"]+"/, '') };
    };
    const known = await ask('bekannt@firma.de');
    const fresh = await ask('neu-probe@firma.de');
    expect(known).toEqual(fresh);
    expect(known.cookie).toBe(true);
  });

  it('never provisions a sign-up whose address was not verified, even with a completed payment', async () => {
    await kit.signUp({ company: 'Unbestaetigt GmbH', email: 'unbestaetigt@firma.de' });
    const row = t.app.db.get<any>(`SELECT id FROM cloud_signups WHERE email = 'unbestaetigt@firma.de'`);
    await expect(t.app.services.cloudCompleteSignup({ id: 'cs_forged_1', status: 'complete', metadata: { cloud_signup_id: row.id } })).rejects.toThrow(/nicht bestätigt/);
    expect(t.app.db.get(`SELECT 1 AS x FROM users WHERE email = 'unbestaetigt@firma.de'`)).toBeUndefined();
  });

  it('Google proves the address too: a Google sign-up ends the open e-mail sign-ups somebody else started for it', async () => {
    const { createIdp, fetchRouter } = await import('./auth-fakes.js');
    const G = { client_id: 'google-client.apps.example.com', client_secret: 'google-secret-for-tests' };
    expect((await t.api.put('/api/agency/oauth', { google: G })).status).toBe(200);
    const google = createIdp({ issuer: 'https://accounts.google.com', clientId: G.client_id, clientSecret: G.client_secret, endpoints: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' } });
    t.app.services.ssoFetch = fetchRouter([google]).fetch;
    try {
      const { b: attacker, link } = await kit.signUp({ company: 'Vorher GmbH', email: 'g-owner@gmail-test.de', password: 'angreifer123' });
      const b = browser(t.base);
      const tok = /name="t" value="([^"]+)"/.exec((await b.get('/start')).text)![1];
      const go = await b.form('/start', { plan: 'solo', interval: 'month', company: 'Google GmbH', agb: '1', avv: '1', datenschutz: '1', business: '1', t: tok, via: 'google' });
      const auth = google.authorize(go.location, { sub: 'g-owner-1', email: 'g-owner@gmail-test.de', email_verified: true, name: 'Gina' });
      const back = await b.get(`/start/google/callback?code=${auth.code}&state=${auth.state}`);
      expect(back.location).toMatch(/^https:\/\/checkout\.stripe\.com/);
      expect((await attacker.form(link, {})).status).toBe(410);
      expect(t.app.db.get<any>(`SELECT status, password_hash FROM cloud_signups WHERE email = 'g-owner@gmail-test.de' AND company = 'Vorher GmbH'`)).toMatchObject({ status: 'superseded', password_hash: '' });
      expect((await pay(b, back)).location).toBe('/app');
      expect(t.app.db.get<any>(`SELECT password_set FROM users WHERE email = 'g-owner@gmail-test.de'`).password_set).toBe(0);
      expect(await login('g-owner@gmail-test.de', 'angreifer123')).toBe(401);
    } finally {
      t.app.services.ssoFetch = undefined;
    }
  });
});

describe('public form uploads and the plan’s media storage', () => {
  it('count in the meter, and a form upload that would pass the plan is refused with 413 and the owner is told', async () => {
    const MB = 1024 * 1024;
    const c = await kit.createCustomer({ plan: 'solo', company: 'Speicher Solo', email: 'speicher@solo.de' });
    const f = await c.b.api('POST', '/api/forms', { name: 'Upload', fields: [{ id: 'a', type: 'email', label: 'E-Mail', name: 'email' }, { id: 'b', type: 'file', label: 'Datei', name: 'datei' }] }, c.h);
    expect(f.status, f.text).toBe(200);
    const png = `data:image/png;base64,${Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(200 * 1024)]).toString('base64')}`;
    const send = (email: string) => t.api.raw(`/api/public/forms/${f.data.id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, datei: { name: 'x.png', data: png } }) });
    expect((await send('eins@besucher.de')).status).toBe(200);
    const meter = async () => (await c.b.api('GET', '/api/cloud/me', undefined, c.h)).data.tenant.meters.storage_mb;
    expect((await meter()).used).toBe(0.2);
    // Solo: 5 000 MB – past 90 % with a course video: the upload still fits, the owner is told
    t.app.db.insert('course_videos', { id: 'vid-quota-1', location_id: c.loc, name: 'Kurs.mp4', file: 'vid-quota-1.mp4', size: 4600 * MB, received: 4600 * MB, status: 'complete', created_at: new Date().toISOString() });
    expect((await send('zwei@besucher.de')).status).toBe(200);
    const told = () => t.app.db.all<any>(`SELECT title FROM push_log WHERE kind = 'storage' AND location_id = ? AND user_id = ?`, c.loc, c.userId).map((x) => x.title as string);
    expect(told()).toEqual([expect.stringMatching(/Medien-Speicher deines Tarifs ist zu 90 % belegt/)]);
    // almost full: the next upload would pass the plan
    t.app.db.run('UPDATE course_videos SET size = ? WHERE id = ?', 5000 * MB - 500 * 1024, 'vid-quota-1');
    const refused = await send('drei@besucher.de');
    expect(refused.status).toBe(413);
    expect(t.app.db.get(`SELECT 1 AS x FROM contacts WHERE email = 'drei@besucher.de'`)).toBeUndefined();
    expect(told()).toEqual([expect.stringMatching(/zu 90 % belegt/), expect.stringMatching(/Medien-Speicher deines Tarifs ist voll/)]);
  });
});
