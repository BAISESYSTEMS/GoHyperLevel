import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from '../server/core/template.js';
import { DEFAULT_SETTINGS } from '../server/modules/calendars.js';
import { ROBOTS_DISALLOW, robotsTxt } from '../server/modules/root-files.js';
import { composeEmail } from '../server/services/messaging.js';
import { previewToken } from '../server/services/webinar-model.js';
import { berlinDay, startTestApp } from './helpers.js';

/**
 * Leftovers of the third bug sweep: no tracking and no "Abmelden" in the double opt-in mail and none of the latter in other
 * service mails (open tracking of business mails as a setting), robots.txt and favicon.ico on the app's domain, the cache
 * header of the number-swap script, the blank line of the booking confirmation, the date in the SEPA mandate mail and the
 * notice for visitors without JavaScript. Each test fails on the code before the fix.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 30_000 });

const PIXEL = /\/t\/o\/[\w-]+\.gif/;

describe('merge fields on a line of their own (pure)', () => {
  it('an empty one takes its line with it; a filled one, or one inside a sentence, does not', () => {
    expect(render('A\n{{x}}\n\nB', {})).toBe('A\n\nB');
    expect(render('A\r\n{{x}}\r\nB', {})).toBe('A\r\nB');
    expect(render('{{x}}\nB', {})).toBe('B');
    expect(render('A\n  {{x}}\n{{y}}\nB', {})).toBe('A\nB');
    expect(render('A\n{{x}}\n\nB', { x: 'Ort/Link: Büro' })).toBe('A\nOrt/Link: Büro\n\nB');
    expect(render('A\n{{x|vor Ort}}\nB', {})).toBe('A\nvor Ort\nB');
    expect(render('A {{x}}\nB', {})).toBe('A\nB');
    expect(render('A\n{{x}}', {})).toBe('A\n');
  });

  it('the plain-text booking confirmation and reminder have one blank line, not two, when no place is set', () => {
    const vars = (place: string) => ({ contact: { first_name: 'Anna' }, calendar: { name: 'Beratung', meeting_location: place }, appointment: { start_text: 'Mo., 5.10.2026, 10:00 (Europe/Berlin)', manage_url: 'https://crm.example/book/manage/x' }, location: { name: 'Testfirma' } });
    const none = render(DEFAULT_SETTINGS.confirmation_body, vars(''));
    expect(none).not.toContain('\n\n\n');
    expect(none).toContain('ist bestätigt.\n\nTermin verwalten oder absagen:');
    const place = render(DEFAULT_SETTINGS.confirmation_body, vars('Ort/Link: Hauptstraße 1'));
    expect(place).toContain('ist bestätigt.\nOrt/Link: Hauptstraße 1\n\nTermin verwalten');
    expect(render(DEFAULT_SETTINGS.reminder_body, vars(''))).toContain('(Europe/Berlin).\n\nAbsagen oder verschieben:');
  });
});

describe('footer of service mails (pure)', () => {
  it('unsubscribe: false keeps company and address but drops "Abmelden" – in the wrapper, in a full document and in the text', () => {
    const plain = composeEmail({ body: 'Hallo', unsubUrl: 'https://crm.de/u/1', company: 'Firma', address: 'Weg 1', unsubscribe: false });
    expect(plain.html).toContain('Firma · Weg 1</p></body></html>');
    expect(plain.html).not.toContain('Abmelden');
    expect(plain.html).not.toContain('/u/1');
    expect(plain.text).toBe('Hallo\n\n--\nFirma');
    const doc = composeEmail({ body: '<!doctype html><html><body><p>Hi</p></body></html>', isHtml: true, unsubUrl: 'https://crm.de/u/2', company: 'Firma', unsubscribe: false });
    expect(doc.html).toMatch(/Firma<\/p><\/body>/);
    expect(doc.html).not.toContain('Abmelden');
    expect(doc.text).toBe('Hi\n\n--\nFirma');
    // default unchanged: the link is there
    expect(composeEmail({ body: 'Hallo', unsubUrl: 'https://crm.de/u/1', company: 'Firma' }).text).toBe('Hallo\n\n--\nFirma\nAbmelden: https://crm.de/u/1');
  });
});

describe('robots.txt (pure)', () => {
  it('keeps crawlers out of the app, the API and personal links and lets them see the rest', () => {
    const txt = robotsTxt();
    expect(txt).toMatch(/^# .*\nUser-agent: \*\n/);
    for (const p of ['/app', '/api/', '/i/', '/q/', '/u/', '/t/', '/l/', '/consent/', '/portal/', '/book/manage/']) expect(txt).toContain(`\nDisallow: ${p}\n`);
    expect(txt.trimEnd().endsWith('Allow: /')).toBe(true);
    // public pages stay open
    for (const p of ['/p/', '/f/', '/book/', '/w/', '/help/', '/c/']) expect(ROBOTS_DISALLOW.some((d) => p.startsWith(d))).toBe(false);
  });
});

describe('through the app', () => {
  let t: Awaited<ReturnType<typeof startTestApp>>;
  const mails: any[] = [];
  const mailTo = (to: string) => mails.filter((m) => m.to === to);
  async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  const setEmail = (email: Record<string, unknown>) => t.api.patch('/api/location', { settings: { email } });
  const contact = async (email: string, extra: Record<string, unknown> = {}) => (await t.api.post('/api/contacts', { email, ...extra })).data;
  const invoiceMail = async (email: string) => {
    const c = await contact(email);
    const d = (await t.api.post('/api/invoices', { contact_id: c.id, items: [{ name: 'Beratung', qty: 1, price_cents: 10000, tax_rate: 19 }] })).data;
    expect((await t.api.post(`/api/invoices/${d.id}/finalise`, {})).status).toBe(200);
    expect((await t.api.post(`/api/invoices/${d.id}/send`, {})).status).toBe(200);
    return { contact: c, mail: mailTo(email).at(-1) };
  };
  const hostGet = (path: string, host: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
      const u = new URL(t.base);
      request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: s }));
      })
        .on('error', reject)
        .end();
    });

  beforeAll(async () => {
    t = await startTestApp({ baseUrl: 'https://crm.example.com' });
    await t.setup();
    t.app.services.emailTransports = { capture: async (_l: any, mail: any) => (mails.push(mail), { status: 'sent', providerId: `m${mails.length}` }) };
    await setEmail({ provider: 'capture' });
  });
  afterAll(async () => t?.close());

  it('the double opt-in mail carries no pixel, no tracked link and no "Abmelden" (no consent yet)', async () => {
    const put = await t.api.put('/api/consent/settings', { doi: { body: 'Hallo,\n\nbitte bestätige: {{confirm_url}}\n\nMehr über uns: https://example.com/ueber-uns' } });
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    const c = await contact('doi@kunde.example', { consent: { doi: true, purposes: ['newsletter'], text: 'Ich möchte Neuigkeiten.' } });
    const mail = await until(() => mailTo('doi@kunde.example')[0]);
    expect(mail.html).not.toMatch(PIXEL);
    expect(mail.html).not.toContain('/t/c/');
    expect(mail.html).toContain('href="https://example.com/ueber-uns"');
    expect(mail.html).toMatch(/href="https:\/\/crm\.example\.com\/consent\/confirm\//);
    expect(mail.html).not.toContain('Abmelden');
    expect(mail.text).not.toContain('Abmelden');
    expect(mail.text).not.toContain('/u/');
    expect(mail.text).toMatch(/\n--\nTestfirma$/);
    expect(mail.headers?.['List-Unsubscribe']).toBeUndefined();
    const msg = t.app.db.get<any>(`SELECT id, purpose FROM messages WHERE contact_id = ? AND source = 'Double-Opt-in'`, c.id)!;
    expect(msg.purpose).toBe('transactional');
    expect(t.app.db.all('SELECT id FROM tracked_links WHERE message_id = ?', msg.id)).toHaveLength(0);
  });

  it('service mails have no "Abmelden"; their opens are measured unless "Öffnungen bei Geschäftsmails messen" is off', async () => {
    const { mail } = await invoiceMail('rechnung@kunde.example');
    expect(mail.text).not.toContain('Abmelden');
    expect(mail.html).not.toContain('Abmelden');
    expect(mail.html).toContain('Testfirma');
    // today's behaviour stays the default: pixel and tracked links
    expect(mail.html).toMatch(PIXEL);
    expect(mail.html).toContain('/t/c/');

    await setEmail({ track_business_opens: false });
    const off = (await invoiceMail('rechnung2@kunde.example')).mail;
    expect(off.html).not.toMatch(PIXEL);
    expect(off.html).toContain('/t/c/');
    // a conversation mail keeps its pixel and its unsubscribe link
    const c = await contact('gespraech@kunde.example');
    expect((await t.api.post('/api/messages', { contact_id: c.id, channel: 'email', subject: 'Hallo', body: 'Wie geht es? https://example.com/x' })).status).toBe(200);
    const conv = mailTo('gespraech@kunde.example')[0];
    expect(conv.html).toMatch(PIXEL);
    expect(conv.text).toContain('Abmelden: https://crm.example.com/u/');
    await setEmail({ track_business_opens: true });
  });

  it('the booking confirmation as plain text has no double blank line when the calendar has no place', async () => {
    const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]));
    const cal = (await t.api.post('/api/calendars', { name: 'Erstgespräch', duration: 60, interval: 60, min_notice: 0, max_days: 30, availability: every, settings: { notify_team: false, reminder_hours: 0 } })).data;
    const days = (await t.api.get(`/api/public/calendars/${cal.slug}/slots?from=${berlinDay(1)}&days=3`)).data.days as { slots: string[] }[];
    const start = days.flatMap((d) => d.slots)[0];
    const r = await t.api.post(`/api/public/calendars/${cal.slug}/book`, { start, first_name: 'Bea', email: 'termin@kunde.example' });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const mail = await until(() => mailTo('termin@kunde.example')[0]);
    expect(mail.text).not.toContain('\n\n\n');
    expect(mail.text).toMatch(/ist bestätigt\.\n\nTermin verwalten oder absagen:/);
    expect(mail.text).not.toContain('Abmelden');
  });

  it('the SEPA mandate request mail writes the date like the other mails (04.11.2026, not 4.11.2026)', async () => {
    await t.api.put('/api/invoice-settings', { street: 'Musterstraße 1', postal_code: '10115', city: 'Berlin', vat_id: 'DE811569869', contact_name: 'Erika Muster', contact_phone: '+49301234567', contact_email: 're@example.com', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' });
    // a validity that ends on a day 1–9 of a month, so the zero is visible
    const day = (n: number) => Number(new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'Europe/Berlin' }).format(new Date(Date.now() + n * 864e5)));
    let days = 1;
    while (!(day(days) >= 2 && day(days) <= 8)) days++;
    const s = await t.api.put('/api/sepa/settings', { creditor_id: 'DE98ZZZ09999999999', capture_days: days });
    expect(s.status, JSON.stringify(s.data)).toBe(200);
    const c = await contact('sepa@kunde.example', { first_name: 'Sepp', last_name: 'Kunde' });
    const r = await t.api.post('/api/sepa/mandates/request', { contact_id: c.id, send: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const mail = mailTo('sepa@kunde.example').at(-1);
    const until_ = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' }).format(new Date(r.data.capture_expires_at));
    expect(until_).toMatch(/^0\d\.\d\d\.\d{4}$/);
    expect(mail.text).toContain(`Der Link gilt bis ${until_}.`);
    expect(mail.text).not.toContain('Abmelden');
  });

  it('/robots.txt and /favicon.ico of the app domain are no longer the web app; a website domain keeps its own robots.txt', async () => {
    const robots = await t.api.raw('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toContain('text/plain');
    const txt = await robots.text();
    expect(txt).toContain('Disallow: /app\n');
    expect(txt).not.toContain('<');
    expect((await t.api.raw('/robots.txt', { method: 'HEAD' })).status).toBe(200);

    // no build in the test: nothing (204) instead of the HTML page; with the icon of the build: the icon
    const none = await t.api.raw('/favicon.ico');
    expect(none.status).toBe(204);
    mkdirSync(t.app.config.webDir, { recursive: true });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    writeFileSync(join(t.app.config.webDir, 'apple-touch-icon.png'), png);
    const icon = await t.api.raw('/favicon.ico');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect(icon.headers.get('cache-control')).toContain('max-age=');
    expect(Buffer.from(await icon.arrayBuffer()).equals(png)).toBe(true);

    // a website on its own domain answers with its own robots.txt (sitemap of the site)
    const f = (await t.api.post('/api/funnels', { name: 'Kundenseite', template: 'leadmagnet' })).data;
    expect((await t.api.patch(`/api/funnels/${f.id}`, { domain: 'www.kunden-seite.de' })).status).toBe(200);
    const site = await hostGet('/robots.txt', 'www.kunden-seite.de');
    expect(site.status).toBe(200);
    expect(site.body).toContain('Sitemap: https://www.kunden-seite.de/sitemap.xml');
    expect(site.body).not.toContain('Disallow: /app');
  });

  it('the number-swap script and the attribution snippet are cached briefly – also when switched off', async () => {
    const loc = t.api.location;
    for (const path of [`/a/${loc}/dni.js`, `/a/${loc}/dni.js?pool=gibtsnicht`, '/a/gibtsnicht/dni.js', `/a/${loc}/t.js`]) {
      const r = await t.api.raw(path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('cache-control'), path).toBe('public, max-age=300');
      expect(r.headers.get('content-type'), path).toContain('javascript');
    }
  });

  it('booking, webinar and review pages tell visitors without JavaScript what to do', async () => {
    const noscript = /<noscript><p class="error">Bitte JavaScript einschalten, um [^<]+\.<\/p><\/noscript>/;
    const cal = (await t.api.post('/api/calendars', { name: 'Ohne JS' })).data;
    expect(await (await t.api.raw(`/book/${cal.slug}`)).text()).toMatch(noscript);
    // the team booking page (here: with a cancellation policy) has its own markup
    const team = (await t.api.post('/api/calendars', { name: 'Team ohne JS' })).data;
    const cfg = await t.api.put(`/api/team-calendars/${team.id}`, { config: { policy_text: 'Absagen bis 24 Stunden vorher.' } });
    expect(cfg.status, JSON.stringify(cfg.data)).toBe(200);
    const teamPage = await (await t.api.raw(`/book/${team.slug}`)).text();
    expect(teamPage).toContain('Absagen bis 24 Stunden vorher.');
    expect(teamPage).toMatch(noscript);

    const w = (await t.api.post('/api/webinars', { title: 'Ohne JS', video: { type: 'url', url: 'https://cdn.example.com/a.mp4' }, duration_s: 1200, schedule: { ondemand: { enabled: true } } })).data;
    expect((await t.api.patch(`/api/webinars/${w.id}`, { status: 'published' })).status).toBe(200);
    expect(await (await t.api.raw(`/w/${w.slug}`)).text()).toMatch(noscript);
    const room = await (await t.api.raw(`/w/${w.slug}/watch?p=${encodeURIComponent(previewToken(t.app.config.secret, w.id, Math.floor(Date.now() / 1000) + 3600, 0))}`)).text();
    expect(room).toContain('<noscript><div class="view center"><h2>Bitte JavaScript einschalten</h2>');

    const c = await contact('bewertung@kunde.example');
    const req = (await t.api.post('/api/reviews/request', { contact_id: c.id })).data;
    expect(await (await t.api.raw(`/r/${req.token}`)).text()).toMatch(noscript);
  });
});
