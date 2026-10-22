import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBusiness } from '../server/services/cloud-b2b.js';
import { cleanReport, pauseReason } from '../server/services/cloud-abuse.js';
import { verifyToken } from '../server/services/cloud-sites.js';
import { startTestApp } from './helpers.js';
import { KEY, WHSEC, browser, cloudKit, createStripe } from './cloud-fakes.js';

/**
 * Cloud operations: B2B-only signup, the DSA notice form, the operator's measures (pause sending, sites offline, suspend), the
 * automatic pause on complaints and bounces, customer sites never on the login origin and custom domains only after verification.
 */

const stripe = createStripe();
let t: Awaited<ReturnType<typeof startTestApp>>;
const mails: { to: string; subject: string; text: string; html: string }[] = [];
const alerts: { title: string; body: string }[] = [];
const txt = new Map<string, string[][]>();

beforeAll(async () => {
  stripe.install();
  t = await startTestApp({ cloudMode: true });
  await t.setup();
  t.app.services.cloudMailer = async (_loc: unknown, mail: (typeof mails)[number]) => {
    mails.push(mail);
    return { status: 'logged' };
  };
  t.app.services.cloudFormMinMs = 0;
  t.app.services.alertMailer = async (_loc: unknown, m: { subject: string; text: string }) => {
    alerts.push({ title: m.subject, body: m.text });
    return { status: 'logged' };
  };
  t.app.services.siteDomainTxt = async (name: string) => txt.get(name) ?? [];
  const r = await t.api.put('/api/saas/settings', { secret_key: KEY, webhook_secret: WHSEC });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
}, 60_000);
afterAll(async () => {
  stripe.uninstall();
  delete process.env.PGHL_CLOUD_SITES_DOMAIN;
  await t?.close();
});

const { createCustomer, lastMail } = cloudKit(() => t, stripe, mails);
const hostGet = (host: string, path: string) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const u = new URL(t.base);
    request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: s }));
    })
      .on('error', reject)
      .end();
  });

describe('B2B-only signup', () => {
  it('checks VAT ID or the business confirmation (pure)', () => {
    expect(checkBusiness({}, true).error).toMatch(/nur an Unternehmen/);
    expect(checkBusiness({ vat_id: 'DE 123.456.789' }, true).data).toEqual({ vat_id: 'DE123456789', confirmed: false });
    expect(checkBusiness({ vat_id: '12345' }, true).error).toMatch(/USt-IdNr/);
    expect(checkBusiness({ business: '1' }, true).data).toEqual({ vat_id: '', confirmed: true });
    expect(checkBusiness({}, false)).toEqual({});
  });

  it('is on by default: the form asks, a consumer cannot sign up, the AGB say B2B only', async () => {
    const settings = (await t.api.get('/api/cloud/console/settings')).data;
    expect(settings.b2b_only).toBe(true);
    const b = browser(t.base);
    const page = await b.get('/start');
    expect(page.text).toContain('name="vat_id"');
    expect(page.text).toContain('Ich bestelle als Unternehmen');
    const tok = /name="t" value="([^"]+)"/.exec(page.text)![1];
    const base = { plan: 'solo', interval: 'month', company: 'Privat', email: 'privat@example.de', password: 'geheim1234', agb: '1', avv: '1', datenschutz: '1', t: tok, via: 'email' };
    const r = await b.form('/start', base);
    expect(r.status).toBe(400);
    expect(r.text).toContain('nur an Unternehmen');
    expect((await b.form('/start', { ...base, vat_id: 'XX1' })).text).toContain('USt-IdNr. sieht nicht gültig aus');
    expect((await b.get('/cloud/legal/agb')).text).toContain('nur B2B');
    // switched off: no question asked
    expect((await t.api.put('/api/cloud/console/settings', { b2b_only: false })).status).toBe(200);
    expect((await b.get('/start')).text).not.toContain('name="vat_id"');
    expect((await b.form('/start', base)).status).toBe(200);
    await t.api.put('/api/cloud/console/settings', { b2b_only: true });
  });

  it('keeps the VAT ID / confirmation in the customer history', async () => {
    const c = await createCustomer({ company: 'Firma Mit USt GmbH', email: 'ust@firma.de', plan: 'solo' });
    const ev = t.app.db.get<{ detail: string }>(`SELECT detail FROM cloud_events WHERE tenant_id = ? AND type = 'b2b_confirmed'`, c.tenantId)!;
    expect(ev.detail).toContain('Bestellung als Unternehmen bestätigt');
  });
});

describe('abuse handling', () => {
  let c: Awaited<ReturnType<typeof createCustomer>>;
  let slug = '';
  beforeAll(async () => {
    c = await createCustomer({ company: 'Phish AG', email: 'boss@phish.de', plan: 'agency' });
    const f = await c.b.api('POST', '/api/funnels', { name: 'Bank Login', slug: 'bank-login-phish' }, c.h);
    expect(f.status).toBe(200);
    slug = f.data.slug;
  });

  it('validates notices (pure): substantiated, with a URL, good faith; anonymous only for CSAM', () => {
    const ok = { category: 'phishing', urls: 'https://x.example/p/a', explanation: 'Das ist eine gefälschte Bank-Anmeldeseite.', name: 'Max', email: 'max@example.org', good_faith: '1' };
    expect(cleanReport(ok).error).toBeUndefined();
    expect(cleanReport({ ...ok, urls: '' }).error).toMatch(/URL/);
    expect(cleanReport({ ...ok, explanation: 'kurz' }).error).toMatch(/begründe/);
    expect(cleanReport({ ...ok, good_faith: '' }).error).toMatch(/gutem Glauben|bestem Wissen/);
    expect(cleanReport({ ...ok, name: '', email: '' }).error).toMatch(/Namen und E-Mail/);
    expect(cleanReport({ ...ok, category: 'csam', name: '', email: '' }).error).toBeUndefined();
  });

  it('takes a notice through /abuse, matches the customer, confirms receipt and alerts the operator', async () => {
    const b = browser(t.base);
    const page = await b.get('/abuse');
    expect(page.status).toBe(200);
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(page.text).not.toMatch(/<script/i);
    expect(page.text).toContain('Missbrauch melden');
    expect((await b.get('/cloud')).text).toContain('href="/abuse"');
    const tok = /name="t" value="([^"]+)"/.exec(page.text)![1];
    const bad = await b.form('/abuse', { category: 'phishing', urls: 'kein link', explanation: 'x', t: tok });
    expect(bad.status).toBe(400);
    const r = await b.form('/abuse', { category: 'phishing', urls: `${t.app.baseUrl()}/p/${slug}`, explanation: 'Gefälschte Bank-Anmeldeseite, fragt nach PIN und TAN.', name: 'Erika Muster', email: 'erika@example.org', good_faith: '1', t: tok });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.text).toContain('Aktenzeichen');
    const rep = t.app.db.get<{ id: string; tenant_id: string; status: string }>(`SELECT * FROM abuse_reports WHERE reporter_email = 'erika@example.org'`)!;
    expect(rep).toMatchObject({ tenant_id: c.tenantId, status: 'new' });
    expect(lastMail('erika@example.org', /Eingang deiner Meldung/)?.text).toContain(rep.id);
    expect(alerts.some((a) => a.title.includes('Missbrauchsmeldung'))).toBe(true);
    // the customer's history knows, the console lists it – customers do not reach the console
    expect(t.app.db.get(`SELECT 1 AS x FROM cloud_events WHERE tenant_id = ? AND type = 'abuse_reported'`, c.tenantId)).toBeTruthy();
    const list = (await t.api.get('/api/cloud/console/abuse')).data;
    expect(list.reports[0]).toMatchObject({ id: rep.id, tenant_name: 'Phish AG', category_label: expect.stringContaining('Phishing') });
    expect((await c.b.api('GET', '/api/cloud/console/abuse', undefined, c.h)).status).toBe(403);
  });

  it('closing a notice needs reasons and tells the reporter (Art. 16(5))', async () => {
    const rep = t.app.db.get<{ id: string }>(`SELECT id FROM abuse_reports WHERE reporter_email = 'erika@example.org'`)!;
    expect((await t.api.patch(`/api/cloud/console/abuse/${rep.id}`, { status: 'actioned' })).status).toBe(400);
    const r = await t.api.patch(`/api/cloud/console/abuse/${rep.id}`, { status: 'actioned', decision: 'Seite offline genommen, Kunde informiert.' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'actioned', decided_by: 'Chef' });
    expect(lastMail('erika@example.org', /Entscheidung zu deiner Meldung/)?.text).toContain('Seite offline genommen');
  });

  it('operator measures: pause sending, sites offline, suspend – each with reasons to the owner', async () => {
    const contact = (await c.b.api('POST', '/api/contacts', { first_name: 'Ziel', email: 'ziel@example.org' }, c.h)).data;
    const send = () => c.b.api('POST', '/api/messages', { contact_id: contact.id, channel: 'email', subject: 'Hallo', body: 'Test' }, c.h);
    expect((await send()).data.status).not.toBe('failed');
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action: 'pause_sending', reason: '' })).status).toBe(400);
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action: 'pause_sending', reason: 'Phishing-Mails an Bankkunden' })).status).toBe(200);
    const paused = (await send()).data;
    expect(paused).toMatchObject({ status: 'failed', error: expect.stringContaining('Versand pausiert: Phishing-Mails') });
    expect(lastMail('boss@phish.de', /Versand pausiert/)?.text).toContain('Phishing-Mails an Bankkunden');
    // sites offline: every public page of the customer answers 410
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action: 'unpublish_sites', reason: 'Gefälschte Bank-Anmeldeseite' })).status).toBe(200);
    process.env.PGHL_CLOUD_SITES_DOMAIN = 'kundenseiten.example';
    const off = await hostGet(`${slug}.kundenseiten.example`, '/');
    expect(off.status).toBe(410);
    expect(off.body).toContain('nicht verfügbar');
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action: 'publish_sites', reason: '' })).status).toBe(200);
    expect((await hostGet(`${slug}.kundenseiten.example`, '/')).status).toBe(200);
    // suspended: no customer route but the export and who-am-I
    expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action: 'suspend', reason: 'Wiederholter Missbrauch' })).status).toBe(200);
    const blocked = await c.b.api('GET', '/api/contacts', undefined, c.h);
    expect(blocked.status).toBe(403);
    expect(blocked.data.error).toContain('gesperrt: Wiederholter Missbrauch');
    expect((await c.b.api('GET', '/api/cloud/me')).status).toBe(200);
    expect((await c.b.api('GET', '/api/me')).status).toBe(200);
    expect((await hostGet(`${slug}.kundenseiten.example`, '/')).status).toBe(410);
    const flagged = (await t.api.get('/api/cloud/console/abuse')).data.flagged;
    expect(flagged.find((f: { tenant_id: string }) => f.tenant_id === c.tenantId)).toMatchObject({ suspend_reason: 'Wiederholter Missbrauch', sending_reason: 'Phishing-Mails an Bankkunden' });
    for (const action of ['unsuspend', 'resume_sending']) expect((await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action, reason: '' })).status).toBe(200);
    expect((await c.b.api('GET', '/api/contacts', undefined, c.h)).status).toBe(200);
    expect((await send()).data.status).not.toBe('failed');
    const types = t.app.db.all<{ type: string }>('SELECT type FROM cloud_events WHERE tenant_id = ? ORDER BY at', c.tenantId).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['abuse_sending_paused', 'abuse_sites_offline', 'abuse_suspended', 'abuse_unsuspended', 'abuse_sending_resumed']));
  });

  it('pauses sending by itself on complaints (> 0.1 %) or bounces (> 5 %) of the last 500 mails', async () => {
    expect(pauseReason(Array(99).fill('bounced'))).toBeUndefined();
    expect(pauseReason(Array(500).fill('delivered'))).toBeUndefined();
    // in a window of 500 one complaint is already 0.2 % – above the 0.1 % limit
    expect(pauseReason([...Array(499).fill('delivered'), 'complained'])).toMatch(/Beschwerderate 0,2 %/);
    expect(pauseReason([...Array(498).fill('delivered'), 'complained', 'complained'])).toMatch(/Beschwerderate 0,4 %/);
    expect(pauseReason([...Array(94).fill('delivered'), ...Array(6).fill('bounced')])).toMatch(/Bounce-Rate 6 %/);
    const contact = t.app.db.get<{ id: string; conversation: string }>(`SELECT id FROM contacts WHERE location_id = ? LIMIT 1`, c.loc)!;
    const conv = t.app.db.get<{ id: string }>('SELECT id FROM conversations WHERE location_id = ? LIMIT 1', c.loc)!;
    const at = (i: number) => new Date(Date.now() + 1000 + i).toISOString();
    for (let i = 0; i < 200; i++)
      t.app.db.insert('messages', { id: `abusemsg${i}`, location_id: c.loc, conversation_id: conv.id, contact_id: contact.id, channel: 'email', direction: 'out', subject: 'Newsletter', body: 'x', status: i < 2 ? 'complained' : 'delivered', error: '', source: 'kampagne', created_at: at(i) });
    const paused = await t.app.services.cloudAbuse.autoPause();
    expect(paused).toEqual([{ tenant: c.tenantId, reason: expect.stringContaining('Beschwerderate 1 %') }]);
    expect(t.app.db.get(`SELECT sending_auto FROM cloud_abuse_flags WHERE tenant_id = ?`, c.tenantId)).toEqual({ sending_auto: 1 });
    expect(lastMail('boss@phish.de', /Versand pausiert/)?.text).toContain('Beschwerderate');
    // resumed by the operator: only mails after that count – the old complaints do not pause it again
    await t.api.post(`/api/cloud/console/tenants/${c.tenantId}/abuse`, { action: 'resume_sending', reason: '' });
    t.app.db.run(`UPDATE cloud_abuse_flags SET window_from = ? WHERE tenant_id = ?`, at(500), c.tenantId);
    expect(await t.app.services.cloudAbuse.autoPause()).toEqual([]);
  });
});

describe('customer sites: own origin, verified domains', () => {
  let c: Awaited<ReturnType<typeof createCustomer>>;
  let f: { id: string; slug: string };
  beforeAll(async () => {
    delete process.env.PGHL_CLOUD_SITES_DOMAIN;
    c = await createCustomer({ company: 'Shop GmbH', email: 'shop@shop.de', plan: 'agency' });
    f = (await c.b.api('POST', '/api/funnels', { name: 'Shop', slug: 'shop-gmbh' }, c.h)).data;
  });

  it('never serves a customer site on the login origin; the operator’s own sites stay', async () => {
    const own = (await t.api.post('/api/funnels', { name: 'Betreiber-Seite', slug: 'betreiber' })).data;
    expect((await t.api.raw(`/p/${own.slug}`)).status).toBe(200);
    const r = await t.api.raw(`/p/${f.slug}`, { redirect: 'manual' });
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('nur über ihre eigene Adresse');
    process.env.PGHL_CLOUD_SITES_DOMAIN = 'kundenseiten.example';
    const moved = await t.api.raw(`/p/${f.slug}/danke?x=1`, { redirect: 'manual' });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('https://shop-gmbh.kundenseiten.example/danke?x=1');
    // also on the customer's own login host (<name>.<cloud domain> / a login domain)
    expect((await hostGet('crm.shop-gmbh.example', `/p/${f.slug}`)).status).toBe(301);
    // served on its sites host, also another customer's slug is sent to its own host
    const served = await hostGet('shop-gmbh.kundenseiten.example', '/');
    expect(served.status).toBe(200);
    expect(served.headers['content-security-policy']).toContain('sandbox');
    expect((await hostGet('shop-gmbh.kundenseiten.example', '/p/bank-login-phish')).headers.location).toBe('https://bank-login-phish.kundenseiten.example/');
    expect((await hostGet('gibt-es-nicht.kundenseiten.example', '/')).status).toBe(404);
    // certificates for the sites hosts
    expect((await t.api.raw('/api/tls/ask?domain=shop-gmbh.kundenseiten.example')).status).toBe(200);
  });

  it('starts a custom domain only after the TXT record proves it', async () => {
    expect((await c.b.api('PATCH', `/api/funnels/${f.id}`, { domain: 'www.shop-gmbh.example' }, c.h)).status).toBe(200);
    const pending = await hostGet('www.shop-gmbh.example', '/');
    expect(pending.status).toBe(503);
    expect(pending.body).toContain('Domain wird geprüft');
    expect((await t.api.raw('/api/tls/ask?domain=www.shop-gmbh.example')).status).toBe(404);
    const st = (await c.b.api('GET', `/api/funnels/${f.id}`, undefined, c.h)).data.domain_status;
    expect(st.status).toBe('unverified');
    expect(st.message).toContain('_pghl-verify.www.shop-gmbh.example');
    const info = (await c.b.api('GET', '/api/site-domain-check?domain=www.shop-gmbh.example', undefined, c.h)).data;
    expect(info).toMatchObject({ verified: false, record: { type: 'TXT', name: '_pghl-verify.www.shop-gmbh.example', value: verifyToken(t.app.config.secret, c.loc, 'www.shop-gmbh.example') } });
    expect((await c.b.api('POST', '/api/site-domain-check', { domain: 'www.shop-gmbh.example' }, c.h)).data.verified).toBe(false);
    // another sub-account cannot ask about it
    expect((await t.api.get('/api/site-domain-check?domain=www.shop-gmbh.example')).status).toBe(404);
    txt.set('_pghl-verify.www.shop-gmbh.example', [[info.record.value]]);
    expect((await c.b.api('POST', '/api/site-domain-check', { domain: 'www.shop-gmbh.example' }, c.h)).data.verified).toBe(true);
    const live = await hostGet('www.shop-gmbh.example', '/');
    expect(live.status).toBe(200);
    expect((await t.api.raw('/api/tls/ask?domain=www.shop-gmbh.example')).status).toBe(200);
    // the login origin now sends visitors to the sites host (configured) – never serves it
    expect((await t.api.raw(`/p/${f.slug}`, { redirect: 'manual' })).status).toBe(301);
  });
});
