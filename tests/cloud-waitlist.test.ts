import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, browser, cloudKit, createStripe } from './cloud-fakes.js';
import { checkDocument, checkFragment } from '../server/services/site-a11y.js';
import { COPY } from '../server/services/landing-copy.js';
import { WHY_SWITCH } from '../server/services/landing-switch.js';
import { WHY_WAITLIST, waitlistKeys, waitlistNote, whyWaitlist, withWaitlist } from '../server/services/landing-waitlist-copy.js';
import { backUrl, isBot, parseWaitlist, safeBack, waitlistMode, waitlistReason } from '../server/services/cloud-waitlist.js';

/**
 * Cloud waitlist mode (docs/cloud.md#waitlist-mode): on with PGHL_CLOUD_WAITLIST=1 or automatically in cloud mode without Stripe; then
 * no signup, account or Checkout can be created (even by direct calls), the landing page and the cloud pages offer self-hosting and the
 * waitlist instead of buying, and sign-ups land in the HQ form (PGHL_LANDING_LOCATION) or in the built-in list.
 */

const env = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

describe('waitlist mode: when it is on', () => {
  it('follows the switch, else the missing billing of the cloud mode', () => {
    expect(waitlistReason({ env: '1', cloud: false, billing: false })).toBe('env');
    expect(waitlistReason({ env: '1', cloud: true, billing: true })).toBe('env');
    expect(waitlistReason({ env: undefined, cloud: true, billing: false })).toBe('no_billing');
    expect(waitlistReason({ env: '', cloud: true, billing: true })).toBeNull();
    expect(waitlistReason({ env: undefined, cloud: false, billing: false })).toBeNull();
    expect(waitlistReason({ env: '0', cloud: true, billing: false })).toBeNull();
    expect(waitlistMode({ env: ' 1 ', cloud: false, billing: true })).toBe(true);
  });

  it('checks a submission: address, consent, optional name and plan', () => {
    expect(parseWaitlist({ email: ' Mia@Example.COM ', consent: '1', plan: 'team', lang: 'en', name: 'Mia <b>' })).toEqual({ ok: true, entry: { email: 'mia@example.com', name: 'Mia b', plan: 'team', lang: 'en' } });
    expect(parseWaitlist({ email: 'kein-mail', consent: '1' })).toEqual({ ok: false, error: 'email' });
    expect(parseWaitlist({ email: 'a@b.de' })).toEqual({ ok: false, error: 'consent' });
    expect(parseWaitlist({ email: 'a@b.de', consent: 'on', plan: 'gold' })).toMatchObject({ ok: true, entry: { plan: '', lang: 'de' } });
    expect(parseWaitlist({ email: 'a@b.de', consent: true }, { needName: true })).toEqual({ ok: false, error: 'name' });
    expect(isBot({ website: 'http://spam' })).toBe(true);
    expect(isBot({ website: '' })).toBe(false);
    // only our own pages as the way back (no open redirect)
    expect(safeBack('https://evil.example')).toBe('/');
    expect(safeBack('//evil.example')).toBe('/');
    expect(backUrl('/de', 'ok', 'de')).toBe('/de?wl=ok#warteliste');
    expect(backUrl('/start', 'consent', 'en')).toBe('/start?wl=consent&lang=en#warteliste');
  });

  it('replaces only texts that still exist in the landing copy', () => {
    for (const lang of ['de', 'en'] as const) {
      const c = COPY[lang];
      const k = waitlistKeys(lang);
      for (const t of k.dach) expect(c.dach.items.map(([x]) => x), t).toContain(t);
      for (const u of k.vsHl) expect(c.vsHl.rows.map((r) => r[2]), u).toContain(u);
      for (const q of k.faq) expect(c.faq.items.map(([x]) => x), q).toContain(q);
      for (const [vendor, langs] of Object.entries(WHY_WAITLIST)) for (const [from] of langs[lang]) expect(WHY_SWITCH[vendor][lang], `${vendor}/${lang}`).toContain(from);
      const w = withWaitlist(c, lang);
      expect(w.faq.items.length).toBe(c.faq.items.length + 1);
      expect(JSON.stringify(w)).not.toMatch(/Cloud starten|Start in the cloud|Gehostet in Frankfurt|Hosted in Frankfurt|Stripe Tax/);
      expect(whyWaitlist('highlevel', lang, WHY_SWITCH.highlevel[lang])).not.toMatch(/[Hh]osting in Frankfurt/);
    }
    expect(waitlistNote('Cloud in Frankfurt (DE); self-hosted an jedem Standort', 'de')).toContain('(Cloud: geplant, noch nicht verfügbar)');
    expect(waitlistNote('Im Agentur-Plan (199 €/Monat) enthalten', 'en')).toContain('(cloud: planned, not available yet)');
    expect(waitlistNote('WhatsApp Cloud API: Vorlagen, Kampagnen', 'de')).toBe('WhatsApp Cloud API: Vorlagen, Kampagnen');
  });
});

// --- a cloud instance without Stripe: the waitlist mode is on by itself (gohyperlevel.com today) ---------------------------------

describe('cloud mode without Stripe (waitlist on by itself)', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const prev = { landing: process.env.PGHL_LANDING, wl: process.env.PGHL_CLOUD_WAITLIST, card: process.env.PGHL_CLOUD_CARD_REQUIRED };
  const mails: any[] = [];
  beforeAll(async () => {
    env('PGHL_LANDING', '1');
    env('PGHL_CLOUD_WAITLIST', undefined);
    env('PGHL_CLOUD_CARD_REQUIRED', '1');
    t = await startTestApp({ cloudMode: true });
    await t.setup();
    t.app.services.cloudMailer = async (_l: any, m: any) => (mails.push(m), { status: 'logged' });
    t.app.services.cloudFormMinMs = 0;
    t.app.services.cloudWaitlistMinMs = 0;
  });
  afterEach(() => t.app.services.cloudWaitlist.resetLimits());
  afterAll(async () => {
    await t.close();
    env('PGHL_LANDING', prev.landing);
    env('PGHL_CLOUD_WAITLIST', prev.wl);
    env('PGHL_CLOUD_CARD_REQUIRED', prev.card);
  });
  const page = async (p: string, headers: Record<string, string> = {}) => {
    const r = await t.api.raw(p, { redirect: 'manual', headers });
    return { status: r.status, body: await r.text(), headers: r.headers };
  };
  const token = (body: string) => /name="wt" value="([^"]+)"/.exec(body)![1];
  const count = (sql: string, ...a: unknown[]) => Number(t.app.db.get<{ n: number }>(sql, ...a)!.n);

  it('says so in /api/version and the pricing JSON', async () => {
    expect((await t.api.get('/api/version')).data.cloud).toEqual({ enabled: true, waitlist: true, signup_url: '/start', pricing_url: '/cloud' });
    expect((await t.api.get('/api/public/cloud/pricing')).data.waitlist).toBe(true);
    const info = (await t.api.get('/api/public/cloud-waitlist?lang=en')).data;
    expect(info).toMatchObject({ enabled: true, via: 'builtin', privacy_url: '/cloud/legal/datenschutz', need_name: false, doi: false });
    expect(info.token).toMatch(/^\d+\.[0-9a-f]{32}$/);
  });

  it('landing page (de + en): self-hosting first, the waitlist instead of buying – no trial, card or buy wording', async () => {
    for (const [p, lang] of [['/', 'en'], ['/de', 'de']] as const) {
      const { status, body } = await page(p);
      expect(status, p).toBe(200);
      expect(body, p).toContain('id="warteliste"');
      expect(body, p).toContain('action="/api/public/cloud-waitlist"');
      expect(body, p).toContain(lang === 'de' ? 'Kostenlos selbst hosten' : 'Self-host for free');
      expect(body, p).toContain(lang === 'de' ? 'Cloud: auf die Warteliste' : 'Cloud: join the waitlist');
      expect(body, p).toContain(lang === 'de' ? 'Bald verfügbar' : 'Coming soon');
      expect(body, p).toContain(lang === 'de' ? '>Auf die Warteliste</a>' : '>Join the waitlist</a>');
      expect(body, p).toContain(`href="${p === '/' ? '/' : '/de'}?plan=team#warteliste"`);
      // the hero's main button is self-hosting
      expect(/<div class="ctas"><a class="btn primary" href="([^"]+)"/.exec(body)![1], p).toBe('#installieren');
      expect(body, p).not.toMatch(/Cloud starten|Start in the cloud|kostenlos testen|Tage testen|free trial|\btrial\b|Testphase|Kreditkarte|credit card|Zahlungsmittel|Jetzt starten|Start now|Jetzt kaufen|Buy now|sign up now|Stripe Tax|Gehostet in Frankfurt|Hosted in Frankfurt|in unserer Cloud ab|in our cloud from/i);
      expect(body, p).not.toContain('href="/cloud"');
      expect(body, p).not.toContain('/start?plan=');
      // the privacy policy next to the consent
      expect(body, p).toContain('href="/cloud/legal/datenschutz" target="_blank"');
    }
    const de = (await page('/de')).body;
    expect(de).not.toContain('Danke! Wir melden uns');
    expect(de).toContain('Kann ich die Cloud schon nutzen?');
    expect(de).toContain('<meta name="description" content="CRM, Postfach, Funnels, Automationen und KI in einer App – kostenlos selbst gehostet');
    expect(de).toContain('0 € · Cloud geplant');
    expect(de).toContain('<meta property="og:image" content="http://localhost/landing/og-waitlist-de.png">');
    // a plan button preselects the plan
    expect((await page('/de?plan=agency')).body).toContain('<option value="agency" selected>');
  });

  it('comparison pages: no cloud sold as available', async () => {
    for (const p of ['/vergleich', '/de/vergleich', '/vergleich/highlevel', '/de/vergleich/highlevel']) {
      const { status, body } = await page(p);
      expect(status, p).toBe(200);
      expect(body, p).not.toMatch(/Hosting in Frankfurt|hosting in Frankfurt|White-Label kostet in der Cloud|White-label costs €199 in the cloud|White-Label in der Cloud ab 199|white-label in the cloud from €199|Cloud Solo 49,99 €<\/td>/);
    }
  });

  it('passes the accessibility check with the form on it', async () => {
    for (const p of ['/', '/de', '/de?wl=consent', '/cloud', '/start', '/start?lang=en']) {
      const body = (await page(p)).body;
      const issues = [...checkDocument(body), ...checkFragment({ html: body })].filter((i) => i.level !== 'info');
      expect(issues, p).toEqual([]);
    }
  });

  it('/cloud shows planned plans with the waitlist; /start shows the waitlist instead of the signup', async () => {
    const cloud = (await page('/cloud')).body;
    expect(cloud).toContain('Bald verfügbar');
    expect(cloud).toContain('voraussichtlich');
    expect(cloud).toContain('href="/cloud?plan=solo#warteliste"');
    expect(cloud).toContain('id="warteliste"');
    expect(cloud).not.toMatch(/kostenlos testen|Jetzt starten|Zahlungsmittel|Kreditkarte|Wie läuft die Testphase|Wie bezahle ich|Stripe Tax|\/start\?plan=|Beliebt/);
    const start = await page('/start?plan=agency');
    expect(start.status).toBe(200);
    expect(start.body).toContain('Die Cloud startet bald');
    expect(start.body).toContain('<option value="agency" selected>');
    expect(start.body).not.toMatch(/name="password"|name="agb"|Weiter zur Zahlung|Konto anlegen<\/h1>|Gutscheincode/);
    const en = await page('/start', { 'accept-language': 'en-GB,en;q=0.9,de;q=0.5' });
    expect(en.body).toContain('<html lang="en">');
    expect(en.body).toContain('Join the waitlist');
    expect((await page('/start?lang=de', { 'accept-language': 'en' })).body).toContain('<html lang="de">');
  });

  it('refuses every signup route – no signup row, no account, no mail, no Checkout', async () => {
    const b = browser(t.base);
    const form = { plan: 'team', interval: 'month', company: 'Muster GmbH', name: 'Mia', email: 'mia@example.com', password: 'geheim1234', agb: '1', avv: '1', datenschutz: '1', business: '1', t: token((await page('/de')).body), via: 'email' };
    const r = await b.form('/start', form);
    expect(r.status).toBe(403);
    expect(r.text).toContain('Die Cloud ist noch nicht verfügbar');
    expect(r.text).toContain('action="/api/public/cloud-waitlist"');
    expect((await b.form('/start', { ...form, via: 'google' })).status).toBe(403);
    const json = await t.api.raw('/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
    expect(json.status).toBe(403);
    expect(((await json.json()) as any).waitlist).toBe(true);
    expect((await b.get('/start/verify/abcdefghijklmnopqrstuvwxyz')).status).toBe(403);
    expect((await b.form('/start/verify/abcdefghijklmnopqrstuvwxyz', { password: 'geheim1234', password2: 'geheim1234' })).status).toBe(403);
    expect((await b.get('/start/google/callback?state=x&code=y')).status).toBe(403);
    // the SaaS self-signup would create a sub-account as well
    t.app.db.run(`INSERT INTO agency_settings (key, value) VALUES ('saas', '{"signup_enabled":true}') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    expect((await b.form('/signup', { plan: 'cloud-client', interval: 'month', company: 'X GmbH', email: 'x@example.com' })).status).toBe(403);
    expect((await b.get('/signup')).location).toBe('/start');
    t.app.db.run(`DELETE FROM agency_settings WHERE key = 'saas'`);
    expect(count('SELECT COUNT(*) AS n FROM cloud_signups')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM saas_signups')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM cloud_tenants')).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM users WHERE email IN ('mia@example.com', 'x@example.com')`)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM locations')).toBe(1);
    expect(mails).toEqual([]);
  });

  it('stores a sign-up in the built-in list (form post), says thanks and tells the admins – without the address', async () => {
    const b = browser(t.base);
    const r = await b.form('/api/public/cloud-waitlist', { name: 'Lea Licht', email: 'Lea@Example.com', plan: 'team', consent: '1', lang: 'de', back: '/de', wt: token((await page('/de')).body), website: '' });
    expect(r.status).toBe(303);
    expect(r.location).toBe('/de?wl=ok#warteliste');
    const row = t.app.db.get<any>(`SELECT * FROM cloud_waitlist WHERE email = 'lea@example.com'`)!;
    expect(row).toMatchObject({ name: 'Lea Licht', plan: 'team', lang: 'de', source: 'Cloud-Warteliste' });
    expect(row.consent_text).toContain('sobald die Cloud startet');
    expect(row.consent_text).toContain('/cloud/legal/datenschutz');
    expect(row.consent_at).toBeTruthy();
    expect(row.ip_hash).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(row)).not.toContain('127.0.0.1');
    const thanks = await page('/de?wl=ok');
    expect(thanks.body).toContain('Danke! Wir melden uns, sobald die Cloud startet.');
    expect(thanks.headers.get('cache-control')).toBe('no-store');
    expect((await page('/?wl=ok')).body).toContain('Thanks! We&#39;ll be in touch as soon as the cloud launches.');
    await new Promise((res) => setTimeout(res, 20));
    const push = t.app.db.get<any>(`SELECT * FROM push_log WHERE kind = 'cloud_waitlist' ORDER BY created_at DESC LIMIT 1`)!;
    expect(push.title).toBe('Neu auf der Cloud-Warteliste');
    expect(push.body).toContain('Cloud Team & Company');
    expect(JSON.stringify(push)).not.toContain('lea@example.com');
    // the same address again: one row, the newer plan, nobody learns it was there
    const again = await t.api.raw('/api/public/cloud-waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lea@example.com', plan: 'agency', consent: true, lang: 'en', wt: token((await page('/')).body) }) });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, state: 'ok', message: "Thanks! We'll be in touch as soon as the cloud launches." });
    expect(count(`SELECT COUNT(*) AS n FROM cloud_waitlist WHERE email = 'lea@example.com'`)).toBe(1);
    expect(t.app.db.get<any>(`SELECT plan, name, lang FROM cloud_waitlist WHERE email = 'lea@example.com'`)).toEqual({ plan: 'agency', name: 'Lea Licht', lang: 'en' });
    expect(count(`SELECT COUNT(*) AS n FROM push_log WHERE kind = 'cloud_waitlist'`)).toBe(1);
  });

  it('needs the consent, a valid address and a fresh form; ignores bots; limits the rate', async () => {
    const post = async (body: Record<string, unknown>) => {
      const r = await t.api.raw('/api/public/cloud-waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, data: (await r.json()) as any };
    };
    const tok = token((await page('/de')).body);
    const before = count('SELECT COUNT(*) AS n FROM cloud_waitlist');
    const noConsent = await post({ email: 'ohne@example.com', wt: tok });
    expect(noConsent.status).toBe(400);
    expect(noConsent.data).toMatchObject({ state: 'consent', error: expect.stringContaining('Einwilligung') });
    expect((await post({ email: 'nope', consent: true, wt: tok })).data.state).toBe('email');
    expect((await post({ email: 'alt@example.com', consent: true, wt: '123.abc' })).data.state).toBe('stale');
    expect((await post({ email: 'alt@example.com', consent: true })).data.state).toBe('stale');
    // a form post without consent goes back to the page with the message
    const b = browser(t.base);
    const back = await b.form('/api/public/cloud-waitlist', { email: 'ohne@example.com', lang: 'en', back: '/', wt: tok });
    expect(back.location).toBe('/?wl=consent#warteliste');
    expect((await page('/?wl=consent')).body).toContain('Please tick the consent box');
    expect((await b.form('/api/public/cloud-waitlist', { email: 'x@example.com', consent: '1', back: 'https://evil.example/', wt: tok })).location).toBe('/?wl=ok#warteliste');
    t.app.services.cloudWaitlist.resetLimits();
    // honeypot: looks like a success, nothing kept
    const bot = await post({ email: 'bot@example.com', consent: true, website: 'http://spam.example', wt: tok });
    expect(bot.status).toBe(200);
    expect(count(`SELECT COUNT(*) AS n FROM cloud_waitlist WHERE email = 'bot@example.com'`)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM cloud_waitlist')).toBe(before + 1);
    // six an hour per address of the visitor, then 429
    for (let i = 0; i < 6; i++) expect((await post({ email: `r${i}@example.com`, consent: true, wt: tok })).status).toBe(200);
    const limited = await post({ email: 'r9@example.com', consent: true, wt: tok });
    expect(limited.status).toBe(429);
    expect(limited.data.state).toBe('rate');
    expect(count(`SELECT COUNT(*) AS n FROM cloud_waitlist WHERE email = 'r9@example.com'`)).toBe(0);
  });

  it('the list is for admins: view, CSV export and delete (GDPR)', async () => {
    const list = await t.api.get('/api/cloud/waitlist');
    expect(list.status).toBe(200);
    expect(list.data).toMatchObject({ enabled: true, reason: 'no_billing', cloud: true, via: 'builtin', forms: null });
    expect(list.data.total).toBeGreaterThan(1);
    const lea = list.data.items.find((x: any) => x.email === 'lea@example.com');
    expect(lea).toMatchObject({ plan: 'agency', source: 'Cloud-Warteliste' });
    expect(lea.ip_hash).toBeUndefined();
    expect((await t.api.get('/api/cloud/waitlist?q=lea')).data.items.map((x: any) => x.email)).toEqual(['lea@example.com']);
    const csv = await t.api.get('/api/cloud/waitlist.csv');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="cloud-warteliste-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(csv.data).toContain('E-Mail,Name,Tarif,Sprache');
    expect(csv.data).toContain('lea@example.com,Lea Licht,Cloud Agentur,en,Cloud-Warteliste');
    // a member of the team and an anonymous visitor get nothing
    const member = await t.api.post('/api/users', { email: 'team@example.com', name: 'Team', password: 'geheim123', role: 'member', locations: [t.api.location] });
    expect(member.status).toBe(200);
    const m = browser(t.base);
    expect((await m.api('POST', '/api/auth/login', { email: 'team@example.com', password: 'geheim123' })).status).toBe(200);
    for (const [method, p] of [['GET', '/api/cloud/waitlist'], ['GET', '/api/cloud/waitlist.csv'], ['DELETE', `/api/cloud/waitlist/${lea.id}`]]) {
      expect((await m.api(method, p)).status, `${method} ${p}`).toBe(403);
      expect((await t.api.raw(p, { method, headers: { 'x-pghl': '1' } })).status, `anonymous ${method} ${p}`).toBe(401);
    }
    expect((await t.api.del(`/api/cloud/waitlist/${lea.id}`)).status).toBe(200);
    expect(count(`SELECT COUNT(*) AS n FROM cloud_waitlist WHERE email = 'lea@example.com'`)).toBe(0);
    expect((await t.api.del(`/api/cloud/waitlist/${lea.id}`)).status).toBe(404);
  });

  it('sends sign-ups into the HQ form when PGHL_LANDING_LOCATION is set (Double-Opt-in), not into the list', async () => {
    const hq = t.api.location;
    expect((await t.api.post('/api/snapshot-templates/saas-hq/apply', { location_id: hq })).status).toBe(200);
    env('PGHL_LANDING_LOCATION', hq);
    try {
      const info = (await t.api.get('/api/public/cloud-waitlist')).data;
      expect(info).toMatchObject({ enabled: true, via: 'forms', need_name: true, doi: true });
      expect(info.consent).toContain('Newsletter');
      // the page shows the receiving form's own consent text and asks for the first name
      const de = (await page('/de')).body;
      expect(de).toContain('Ja, ich möchte auf die Warteliste und den Newsletter');
      expect(de).toMatch(/<input class="wlf-in" id="wl-name" name="name" type="text" maxlength="120" autocomplete="given-name" required>/);
      expect(de).not.toContain('Kein Newsletter, keine Werbung');
      const before = count('SELECT COUNT(*) AS n FROM cloud_waitlist');
      const tok = token(de);
      expect((await t.api.raw('/api/public/cloud-waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ben@example.com', consent: true, wt: tok }) }).then((r) => r.json())) as any).toMatchObject({ state: 'name' });
      const b = browser(t.base);
      const r = await b.form('/api/public/cloud-waitlist', { name: 'Ben', email: 'ben@example.com', plan: 'team', consent: '1', lang: 'de', back: '/de', wt: tok });
      expect(r.location).toBe('/de?wl=doi#warteliste');
      const c = t.app.db.get<any>(`SELECT * FROM contacts WHERE location_id = ? AND email = 'ben@example.com'`, hq)!;
      expect(c.source).toBe('Cloud-Warteliste');
      expect(c.first_name).toBe('Ben');
      expect(JSON.parse(c.custom).plan).toBe('Team & Company');
      expect(count('SELECT COUNT(*) AS n FROM consent_doi WHERE contact_id = ?', c.id)).toBe(1);
      expect(count('SELECT COUNT(*) AS n FROM cloud_waitlist')).toBe(before);
      expect((await page('/de?wl=doi')).body).toContain('Bitte bestätige noch deine E-Mail-Adresse');
      expect((await t.api.get('/api/cloud/waitlist')).data.forms).toMatchObject({ location_id: hq, doi: true });
    } finally {
      env('PGHL_LANDING_LOCATION', undefined);
    }
  });
});

// --- with Stripe: signup open; the switch closes it; existing customers keep working ---------------------------------------------

describe('cloud mode with Stripe', () => {
  const stripe = createStripe();
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const mails: { to: string; subject: string; text: string; html: string }[] = [];
  const prev = process.env.PGHL_CLOUD_WAITLIST;
  beforeAll(async () => {
    env('PGHL_CLOUD_WAITLIST', undefined);
    stripe.install();
    t = await startTestApp({ cloudMode: true });
    await t.setup();
    t.app.services.cloudMailer = async (_l: any, m: any) => (mails.push(m), { status: 'logged' });
    t.app.services.cloudFormMinMs = 0;
    t.app.services.cloudWaitlistMinMs = 0;
    const r = await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC });
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  });
  afterAll(async () => {
    stripe.uninstall();
    await t.close();
    env('PGHL_CLOUD_WAITLIST', prev);
  });
  const { signUp, createCustomer } = cloudKit(() => t, stripe, mails);

  it('keeps the signup and Checkout working while the waitlist is off', async () => {
    expect((await t.api.get('/api/version')).data.cloud.waitlist).toBe(false);
    const start = await (await t.api.raw('/start')).text();
    expect(start).toContain('Konto anlegen');
    expect(start).toContain('name="password"');
    expect(await (await t.api.raw('/cloud')).text()).toContain('/start?plan=team');
    const c = await createCustomer({ company: 'Offen GmbH', email: 'offen@example.com' });
    expect(c.tenantId).toBeTruthy();
    // the waitlist endpoint is closed while the cloud is open
    const r = await t.api.raw('/api/public/cloud-waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'z@example.com', consent: true }) });
    expect(r.status).toBe(404);
    expect((await t.api.get('/api/public/cloud-waitlist')).data).toEqual({ enabled: false });
  });

  it('PGHL_CLOUD_WAITLIST=1 closes signup and Checkout even with Stripe – existing customers keep their account', async () => {
    const c = await createCustomer({ company: 'Bestand GmbH', email: 'bestand@example.com' });
    // a sign-up that was verified-to-be before the switch: its link no longer leads to Stripe
    const pending = await signUp({ company: 'Spät GmbH', email: 'spaet@example.com' });
    env('PGHL_CLOUD_WAITLIST', '1');
    try {
      expect((await t.api.get('/api/version')).data.cloud.waitlist).toBe(true);
      const checkouts = stripe.calls.filter((x) => x.path === '/v1/checkout/sessions').length;
      expect((await pending.b.form(pending.link, {})).status).toBe(403);
      const b = browser(t.base);
      const page = await (await t.api.raw('/start')).text();
      expect(page).not.toContain('name="password"');
      const r = await b.form('/start', { plan: 'solo', interval: 'month', company: 'Neu GmbH', email: 'neu@example.com', password: 'geheim1234', agb: '1', avv: '1', datenschutz: '1', business: '1', t: 'x', via: 'email' });
      expect(r.status).toBe(403);
      expect(stripe.calls.filter((x) => x.path === '/v1/checkout/sessions').length).toBe(checkouts);
      expect(t.app.db.get(`SELECT id FROM cloud_signups WHERE email = 'neu@example.com'`)).toBeUndefined();
      expect(t.app.db.get(`SELECT id FROM users WHERE email IN ('neu@example.com', 'spaet@example.com')`)).toBeUndefined();
      // the existing customer works on: account, billing portal, writing in the CRM
      const me = await c.b.api('GET', '/api/cloud/me');
      expect(me.data).toMatchObject({ customer: true, tenant: { name: 'Bestand GmbH' } });
      expect((await c.b.api('POST', '/api/cloud/portal', {})).data.url).toMatch(/^https:\/\/billing\.stripe\.com/);
      expect((await c.b.api('POST', '/api/contacts', { first_name: 'Kunde', email: 'kunde@example.com' }, c.h)).status).toBe(200);
      expect((await t.api.get('/api/cloud/waitlist')).data).toMatchObject({ enabled: true, reason: 'env' });
    } finally {
      env('PGHL_CLOUD_WAITLIST', undefined);
    }
    expect((await t.api.get('/api/version')).data.cloud.waitlist).toBe(false);
  });

  it('the SaaS sign-up never offers or sells a cloud plan – reseller plans still work', async () => {
    expect((await t.api.put('/api/saas/settings', { signup_enabled: true })).status).toBe(200);
    const reseller = (await t.api.post('/api/saas/plans', { name: 'Handwerk Basis', price_month: 29, features: ['dashboard', 'contacts'] })).data;
    expect(reseller.id).toBeTruthy();
    try {
      const page = await (await t.api.raw('/signup')).text();
      expect(page).toContain('Handwerk Basis');
      expect(page).not.toMatch(/value="cloud-|Cloud Solo|Cloud Team|Cloud Agentur/);
      // a link to a cloud plan goes to the cloud's pricing page instead
      for (const id of ['cloud-solo', 'cloud-team', 'cloud-agency', 'cloud-agency-client']) {
        const r = await t.api.raw(`/signup?plan=${id}`, { redirect: 'manual' });
        expect(r.status, id).toBe(302);
        expect(r.headers.get('location')).toBe('/cloud');
      }
      const checkouts = () => stripe.calls.filter((x) => x.path === '/v1/checkout/sessions').length;
      const before = checkouts();
      const b = browser(t.base);
      for (const id of ['cloud-solo', 'cloud-agency-client']) {
        const r = await b.form('/signup', { plan: id, interval: 'month', company: `${id} GmbH`, name: 'Ida', email: `${id}@example.com` });
        expect(r.status, id).toBe(400);
        expect(r.text).toContain('Bitte einen Tarif wählen.');
        expect(r.text).not.toContain(`value="${id}"`);
      }
      expect(checkouts()).toBe(before);
      expect(Number(t.app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM saas_signups`)!.n)).toBe(0);
      expect(t.app.db.get(`SELECT 1 AS x FROM saas_subscriptions s JOIN locations l ON l.id = s.location_id WHERE l.name IN ('cloud-solo GmbH', 'cloud-agency-client GmbH')`)).toBeUndefined();
      // the agency's own plan: on to Stripe Checkout as before
      const ok = await b.form('/signup', { plan: reseller.id, interval: 'month', company: 'Maler Muster', name: 'Ida', email: 'ida@maler.example' });
      expect(ok.status).toBe(303);
      expect(ok.location).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      expect(checkouts()).toBe(before + 1);
    } finally {
      await t.api.put('/api/saas/settings', { signup_enabled: false });
    }
  });

  it('in waitlist mode the SaaS tools put no cloud plan on a sub-account that is not a customer', async () => {
    const own = t.api.location;
    const tenant = t.app.db.get<{ location_id: string }>('SELECT location_id FROM cloud_tenants WHERE deleted_at IS NULL LIMIT 1')!.location_id;
    env('PGHL_CLOUD_WAITLIST', '1');
    try {
      const put = await t.api.put(`/api/saas/locations/${own}`, { plan_id: 'cloud-team' });
      expect(put.status).toBe(409);
      expect(put.data).toMatchObject({ waitlist: true, error: expect.stringContaining('Wartelisten-Modus') });
      expect((await t.api.post(`/api/saas/locations/${own}/checkout`, { plan_id: 'cloud-solo' })).status).toBe(409);
      expect(t.app.db.get(`SELECT plan_id FROM saas_subscriptions WHERE location_id = ? AND plan_id LIKE 'cloud-%'`, own)).toBeUndefined();
      // an existing customer's account passes the gate (here: it already pays through Stripe)
      expect((await t.api.post(`/api/saas/locations/${tenant}/checkout`, { plan_id: 'cloud-solo' })).data.error).toContain('schon ein Stripe-Abo');
    } finally {
      env('PGHL_CLOUD_WAITLIST', undefined);
    }
  });

  it('PGHL_CLOUD_WAITLIST=0 opens a cloud without Stripe on purpose (trial without card)', async () => {
    const before = (await t.api.get('/api/saas/settings')).data;
    expect(before.key_hint).toBeTruthy();
    expect((await t.api.del('/api/saas/settings/stripe')).status).toBe(200);
    expect((await t.api.get('/api/version')).data.cloud.waitlist).toBe(true);
    env('PGHL_CLOUD_WAITLIST', '0');
    try {
      expect((await t.api.get('/api/version')).data.cloud.waitlist).toBe(false);
      expect(await (await t.api.raw('/start')).text()).toContain('name="password"');
    } finally {
      env('PGHL_CLOUD_WAITLIST', undefined);
    }
  });
});

describe('without cloud mode', () => {
  it('stays off unless switched on; with the switch the landing page offers the waitlist', async () => {
    const prev = { landing: process.env.PGHL_LANDING, wl: process.env.PGHL_CLOUD_WAITLIST };
    env('PGHL_LANDING', '1');
    env('PGHL_CLOUD_WAITLIST', undefined);
    const t = await startTestApp();
    try {
      expect((await t.api.get('/api/public/cloud-waitlist')).data).toEqual({ enabled: false });
      const off = await (await t.api.raw('/')).text();
      expect(off).not.toContain('id="warteliste"');
      expect(off).toContain('Start in the cloud');
      env('PGHL_CLOUD_WAITLIST', '1');
      const on = await (await t.api.raw('/de')).text();
      expect(on).toContain('id="warteliste"');
      expect(on).not.toContain('Cloud starten');
      // no cloud mode: no privacy link unless PGHL_LANDING_PRIVACY_URL names one
      expect(on).not.toContain('Datenschutzerklärung</a>');
      env('PGHL_LANDING_PRIVACY_URL', 'https://example.com/datenschutz');
      expect(await (await t.api.raw('/de')).text()).toContain('href="https://example.com/datenschutz" target="_blank"');
    } finally {
      env('PGHL_LANDING_PRIVACY_URL', undefined);
      await t.close();
      env('PGHL_LANDING', prev.landing);
      env('PGHL_CLOUD_WAITLIST', prev.wl);
    }
  });
});
